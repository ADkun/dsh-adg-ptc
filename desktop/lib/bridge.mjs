// 子进程通道层。它只做一件事：把 `scripts/bridge.ps1` 跑起来，并把 JSON 结果拿回来。
//
// 为什么不能用 `spawn(..., { stdio: 'pipe' })`（design.md 的 I11）：
// 受限令牌（DSH 沙箱的 Low 完整性会话）下，libuv 建立的那对命名管道对本进程的限制 SID
// 没有写权限，子进程一启动就 EPERM。这不是 PowerShell 的问题，任何子进程都一样。
// 所以本层把子进程的 stdout/stderr **重定向到 %TEMP% 下的临时文件**，读完即删 ——
// 这条路在受限会话与完全权限会话下都成立。
//
// 另一条路是让 bridge.ps1 自己写一个 `-Out` JSON 文件（本层读的就是它）。
// 两层都走文件，管道一个都不用：这样"在沙箱里能不能跑"不取决于会话权限。

import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { envGet } from './env.mjs'

/** 本模块根目录（lib/ 的上一层），用来定位 scripts/bridge.ps1。 */
export const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const BRIDGE_SCRIPT = path.join(MODULE_ROOT, 'scripts', 'bridge.ps1')

/** 默认超时（毫秒）。UIA 全树枚举在慢机器上可能要几秒，给足。 */
export const DEFAULT_TIMEOUT_MS = 60000

export class BridgeError extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'BridgeError'
    this.detail = detail
  }
}

/**
 * Windows 退出码里"进程异常死亡"的那一类。真机实测（design.md I7e）：UIA 读到坏状态时 .NET 抛
 * `AccessViolationException`，PowerShell 的 `try/catch` **抓不住**，整个 powershell.exe 直接退出、
 * 连 `-Out` 文件都来不及写。Node 把这个退出码报成无符号 DWORD，所以 0xC0000005 显示为 3221225477。
 * 没有这张表的话，调用方只能看到一个光秃秃的数字，会把"子进程崩了"当成"bridge 报了错"。
 */
const CRASH_EXIT_CODES = new Map([
  [0xc0000005, 'STATUS_ACCESS_VIOLATION'],
  [0xc00000fd, 'STATUS_STACK_OVERFLOW'],
  [0xc0000374, 'STATUS_HEAP_CORRUPTION'],
  [0xc0000409, 'STATUS_STACK_BUFFER_OVERRUN'],
])

/** `3221225477` → `STATUS_ACCESS_VIOLATION (0xC0000005)`；不是崩溃退出码就给 `null`。 */
export function crashExitName(exitCode) {
  if (typeof exitCode !== 'number' || !Number.isFinite(exitCode)) return null
  const unsigned = exitCode >>> 0
  const known = CRASH_EXIT_CODES.get(unsigned)
  if (known !== undefined) return `${known} (0x${unsigned.toString(16).toUpperCase()})`
  if (unsigned >= 0x80000000) return `进程异常退出 (0x${unsigned.toString(16).toUpperCase()})`
  return null
}

/** stderr 压成一行并截断：错误消息要能一行读完，但别把 .NET 栈整个丢掉（排障全靠它）。 */
function summarizeStderr(stderr, max = 300) {
  const text = String(stderr ?? '').trim()
  if (text === '') return 'stderr 为空'
  const flat = text.replace(/\s*\r?\n\s*/g, ' | ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 找 Windows PowerShell 5.1。UIAutomationClient / System.Drawing 在 5.1 里是随框架带的；
 * `pwsh`（7+）要先装模块才能用同一套 UIA，所以 5.1 是首选，`pwsh` 只是兜底。
 * 可用 `ADG_DESKTOP_POWERSHELL` 覆盖（测试与排障用）。
 */
export function resolvePowerShell(env = process.env) {
  const explicit = envGet(env, 'ADG_DESKTOP_POWERSHELL')
  if (explicit) return explicit
  const systemRoot = envGet(env, 'SystemRoot') ?? envGet(env, 'windir') ?? 'C:\\Windows'
  const powershell51 = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(powershell51)) return powershell51
  return 'pwsh'
}

function quote(value) {
  return String(value)
}

/**
 * 跑一次 bridge.ps1，返回 `{json, exitCode, stdout, stderr, files}`。
 *
 * 参数 `params` 直接翻成 `-Name value`（`true` 翻成裸开关 `-Name`）。`undefined` / `false` 跳过。
 * 临时目录在 %TEMP% 下，无论成败都删（`keepFiles: true` 可以留着排障；正常命令一律不传它）。
 */
export function runBridge(params = {}, opts = {}) {
  const env = opts.env ?? process.env
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const command = params.Command ?? opts.command
  if (!command) throw new BridgeError('runBridge 需要 Command')

  const script = opts.script ?? BRIDGE_SCRIPT
  if (!existsSync(script)) {
    throw new BridgeError(`找不到 native bridge 脚本：${script}（desktop/ 是不是被拆开拷走了？）`)
  }

  const workDir = mkdtempSync(path.join(tmpdir(), 'adg-desktop-'))
  const outJson = path.join(workDir, 'out.json')
  const stdoutPath = path.join(workDir, 'stdout.log')
  const stderrPath = path.join(workDir, 'stderr.log')
  const files = { dir: workDir, out: outJson, stdout: stdoutPath, stderr: stderrPath }

  const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === false) continue
    if (value === true) {
      argv.push(`-${key}`)
      continue
    }
    argv.push(`-${key}`, quote(value))
  }
  argv.push('-Out', outJson)

  const keep = opts.keepFiles === true
  let stdoutFd
  let stderrFd
  let result
  try {
    stdoutFd = openSync(stdoutPath, 'w')
    stderrFd = openSync(stderrPath, 'w')
    result = spawnSync(resolvePowerShell(env), argv, {
      stdio: ['ignore', stdoutFd, stderrFd],
      timeout,
      windowsHide: true,
      windowsVerbatimArguments: false,
    })
    closeSync(stdoutFd)
    closeSync(stderrFd)
    stdoutFd = undefined
    stderrFd = undefined
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd)
    if (stderrFd !== undefined) closeSync(stderrFd)
  }

  const stdout = readIfExists(stdoutPath)
  const stderr = readIfExists(stderrPath)
  const payload = readIfExists(outJson)

  // 成功路径也要删临时目录：以前只有 cli.mjs 的 BridgeError 分支调 cleanup，
  // 于是每一次成功的命令都在 %TEMP% 里漏一个 adg-desktop-* 目录（实测积了 496 个）。
  // 这里包一层：先把需要的字节都读进内存，再统一删；失败路径同样删（排障要留就 keepFiles）。
  const finish = (value) => {
    if (!keep) cleanup(files)
    return value
  }

  try {
    let json
    if (payload.trim() !== '') {
      try {
        json = JSON.parse(payload)
      } catch (error) {
        throw new BridgeError(`bridge 写出的 JSON 解析失败：${error.message}`, {
          command,
          raw: payload.slice(0, 400),
          stderr,
          files,
        })
      }
    }

    if (result.error) {
      const timedOut = result.error.code === 'ETIMEDOUT'
      throw new BridgeError(
        timedOut ? `bridge 超时（${timeout}ms）：${command}` : `bridge 起不来：${result.error.message}`,
        { command, stderr, files },
      )
    }
    if (json === undefined) {
      const crash = crashExitName(result.status)
      throw new BridgeError(
        `bridge 没写出结果文件（exit=${result.status}${crash === null ? '' : `, ${crash}`}）：${summarizeStderr(stderr)}`,
        { command, exitCode: result.status, crashed: crash !== null, crash, stdout, stderr, files },
      )
    }
    if (json.ok !== true) {
      throw new BridgeError(`bridge 报错：${json.error ?? '(没有 error 字段)'}`, { command, json, stderr, files })
    }

    return finish({ json, exitCode: result.status, stdout, stderr, files })
  } catch (error) {
    finish(undefined)
    throw error
  }
}

/** 只要 JSON；出错抛 BridgeError（调用方决定是 `ERROR=` 还是 WARN）。用完即删临时目录。 */
export function bridgeJson(params = {}, opts = {}) {
  const result = runBridge(params, opts)
  if (opts.keepFiles !== true) cleanup(result.files)
  return result.json
}

/**
 * 「绝不允许抛」的通道，专给"崩了就崩了"的读数用（内容快照就是这种，见 design.md I7e）。
 *
 * 子进程崩溃 / 超时 / 没写出文件 / bridge 自己报错，一律映射成 `{ok:false, exitCode, crash, reason}`。
 * 调用方拿到 `ok:false` 时**只能把这项读数记成 unknown**，绝不能因为读不到就报
 * `CHANGED=false` —— 那正是"看不见就谎报没变"的老毛病。
 */
export function probeBridge(params = {}, opts = {}) {
  try {
    const result = runBridge(params, opts)
    return { ok: true, json: result.json, exitCode: result.exitCode, crashed: false }
  } catch (error) {
    const exitCode = typeof error?.detail?.exitCode === 'number' ? error.detail.exitCode : null
    return {
      ok: false,
      exitCode,
      crashed: exitCode === null ? false : crashExitName(exitCode) !== null,
      crash: crashExitName(exitCode),
      reason: error?.message ?? String(error),
      stderr: typeof error?.detail?.stderr === 'string' ? error.detail.stderr : '',
    }
  }
}

function readIfExists(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 临时目录清理。cli.mjs 在 finally 里调它；测试里也直接调。 */
export function cleanup(files) {
  if (!files?.dir) return
  try {
    rmSync(files.dir, { recursive: true, force: true })
  } catch {
    // 删不掉不影响结果：%TEMP% 会被系统清理，而且绝不能因为清理失败把命令判为失败。
  }
}
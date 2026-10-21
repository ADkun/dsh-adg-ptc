// 测试共用的小工具。
//
// 沙箱注意：这里用 spawnSync + **文件重定向**而不是 pipe。受限令牌下 libuv 的命名管道
// 对本进程的限制 SID 没有写权限，`stdio: 'pipe'` 会 EPERM（见 desktop/design.md 的 I11）。

import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs')

export const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 测试用的桥存根目录（不会被打包进任何交付路径，只在单测里被指向）。 */
export const FIXTURES_DIR = path.join(MODULE_ROOT, 'test', 'fixtures')

/**
 * 一个"当场死掉"的桥存根：它复刻真机测到的崩溃（UIA 读数抛 AccessViolationException，
 * PowerShell 抓不住，进程以 exit=3221225477 消失，`-Out` 文件根本来不及写）。
 * 只给"子进程崩了会怎样"这类用例用。
 */
export const DYING_BRIDGE = path.join(FIXTURES_DIR, 'dying-bridge.ps1')

/** 读 `scripts/bridge.ps1` 的源码（静态守卫用例用）。 */
export function readBridgeSource() {
  return readFileSync(path.join(MODULE_ROOT, 'scripts', 'bridge.ps1'), 'utf8')
}

/**
 * 某位置所在行的边界与原文（静态守卫需要"行"这个概念时用）。
 *
 * 为什么必须按行看：`indexOf` / 正则看到的是**没剥注释的原文** —— 只要那段文本还在，断言就
 * 满足，哪怕它被套进恒假 `if ($false) { … }`、被 `<# … #>` 包住、或者行首加个 `#` 注掉。
 * 对抗性验收实测（M6）正是这样绕过了"拒绝块在动作之前"的那几条断言。行号按原文的行，
 * 不做任何注释剥离（剥注释的守卫另有其人：`test/content-safety.test.mjs`）。
 */
export function lineBoundsAt(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1
  const newline = text.indexOf('\n', index)
  const end = newline === -1 ? text.length : newline
  return { start, end, text: text.slice(start, end) }
}

/** 某位置所在行的 trim 后文本。 */
export function lineTextAt(text, index) {
  return lineBoundsAt(text, index).text.trim()
}

/** 某位置**之前**最近一条非空行的 trim 后文本（前面没有非空行时返回空串）。 */
export function previousNonEmptyLineText(text, index) {
  const lines = text.slice(0, lineBoundsAt(text, index).start).split('\n')
  for (let i = lines.length - 2; i >= 0; i -= 1) {
    const trimmed = lines[i].trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/**
 * 子进程环境的唯一来源：默认**剔除** `ADG_DESKTOP_BRIDGE` 的继承，比名字时**大小写不敏感**。
 *
 * 为什么：那个变量会把 CLI 指向另一个桥。shell 里若有人全局导出过它（手工试桥、或上一次
 * 实验忘了清），整套测试就会**静默**跑在别的桥上 —— 真桥的判定改坏了也照样全绿。要换桥的
 * 用例必须经 `opts.env` 显式注入（`test/element-identity.test.mjs` 的 `runFixtureInvoke` 就是
 * 这么做的：它把 `process.env` 铺开后自己写上 fixture 的路径）。其余变量照旧继承，免得丢掉
 * `SystemRoot` 之类。
 *
 * 为什么按 `toLowerCase()` 比而不是 `delete base.ADG_DESKTOP_BRIDGE`：Windows 的环境变量名本来
 * 就大小写不敏感，`lib/env.mjs` 的 `envGet` 也是这么比的 —— 只删精确大小写时，
 * `process.env.adg_desktop_bridge='…'` 会整条漏进子进程并被 CLI 认下来，这道卫生等于没做
 * （验收方探针实测：变体大小写导出后 `survivors=['adg_desktop_bridge']`）。
 */
export function childEnv(opts = {}) {
  const base = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === 'adg_desktop_bridge') continue
    base[key] = value
  }
  return { ...base, ...(opts.env ?? {}) }
}

/** 跑一次 CLI，输出经临时文件回收（不用管道）。 */
export function runCli(argv, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'adg-desktop-test-'))
  const outPath = path.join(dir, 'out.log')
  const errPath = path.join(dir, 'err.log')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  let result
  try {
    result = spawnSync(process.execPath, [CLI, ...argv], {
      stdio: ['ignore', outFd, errFd],
      timeout: opts.timeoutMs ?? 30000,
      cwd: path.dirname(CLI),
      windowsHide: true,
      // 环境一律经 childEnv：要换掉桥（ADG_DESKTOP_BRIDGE）或解释器（ADG_DESKTOP_POWERSHELL）的
      // 用例传 opts.env —— 必须自己把 process.env 铺开，否则 SystemRoot 之类一起丢。见 childEnv。
      env: childEnv(opts),
    })
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  const stdout = readFileSync(outPath, 'utf8')
  const stderr = readFileSync(errPath, 'utf8')
  rmSync(dir, { recursive: true, force: true })
  return { code: result.status, stdout, stderr }
}

/** 把 `KEY=VALUE` 输出行收成对象；同一个 KEY 出现多次时留最后一个。 */
export function parseKeyValues(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}
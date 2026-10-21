// 归属、provenance 与 IntegrityLevel 的纯函数层。
//
// 这一层不认识 Windows：所有环境读数都由调用方注入（env / home / exists / arch / …），
// 所以单元测试不依赖真实桌面、不产生副作用（与 browser/lib/target.mjs 同一套路）。

import os from 'node:os'
import path from 'node:path'

/** 本模块要求的最低 Node 主版本；与 package.json 的 engines.node 同值（改一处就要改另一处）。 */
export const MIN_NODE_MAJOR = 22

/** 用户根下的目录名。落点 `${DSH_HOME:-~/.dsh}/desktop/`。 */
export const INSTALL_DIRNAME = 'desktop'

/** 可执行入口的仓库内相对路径（install.* 拷的就是整个 desktop/ 目录）。 */
export const ENTRY_BASENAME = 'cli.mjs'

/**
 * Windows 的环境变量名大小写不敏感，而 POSIX 敏感。取值时两边都按小写比对，
 * 免得在小写环境（bash、Git Bash、CI）里 `DSH_HOME` 读不到。
 */
export function envGet(env, name) {
  if (!env) return undefined
  const want = name.toLowerCase()
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === want) {
      const value = env[key]
      return value === undefined || value === '' ? undefined : value
    }
  }
  return undefined
}

/** `DSH_HOME` 优先，否则 `<home>/.dsh`。 */
export function dshHome(env = process.env, home = os.homedir()) {
  const explicit = envGet(env, 'DSH_HOME')
  return explicit ?? path.join(home, '.dsh')
}

/** 本模块装到本机之后的入口绝对路径（`profile` / `help` 里打印它，人就照抄这一条）。 */
export function installedEntry(env = process.env, home = os.homedir()) {
  return path.join(dshHome(env, home), INSTALL_DIRNAME, ENTRY_BASENAME)
}

/**
 * 本仓库内的工作副本入口路径。用来在"还没装机"时给出可跑的命令 ——
 * 不做"文件是否存在"的判断（那是调用方的事，本函数只管拼路径）。
 */
export function repoEntry(repoRoot) {
  return path.join(repoRoot, INSTALL_DIRNAME, ENTRY_BASENAME)
}

/** 主版本号；拿不到数字就返回 undefined（调用方自己决定怎么报）。 */
export function nodeMajor(version = process.versions.node) {
  const major = Number.parseInt(String(version).split('.')[0], 10)
  return Number.isFinite(major) ? major : undefined
}

/**
 * 运行时闸门：Node 版本不够就明确报错，不降级。
 * 返回 null = 可用；返回字符串 = 为什么不可用（由调用方包成 KEY=VALUE 输出）。
 */
export function runtimeVerdict(version = process.versions.node) {
  const major = nodeMajor(version)
  if (major === undefined) return `读不出 Node 版本：${version}`
  if (major < MIN_NODE_MAJOR) return `需要 Node >= ${MIN_NODE_MAJOR}，当前 v${version}`
  return null
}

/** 本模块是 Windows 专用（PowerShell 桥 + Win32 P/Invoke）。非 Windows 一律明确报错，不降级。 */
export const WINDOWS_ONLY = true

/** 非 Windows 时返回原因字符串，Windows 上返回 null。 */
export function platformVerdict(platform = process.platform) {
  if (platform === 'win32') return null
  return `本模块是 Windows 专用（PowerShell 桥 + Win32 API），当前 PLATFORM=${platform}`
}

// ---------------------------------------------------------------------------
// 完整性级别（Windows 强制完整性机制）
// ---------------------------------------------------------------------------

/**
 * 令牌完整性级别的 RID → 名字。Windows 的六档（微软文档的 MANDATORY_LEVEL）。
 * 数值本身有意义（越大越可信），所以等级比较用 **rank** 而不是字符串比较。
 */
export const INTEGRITY_LEVELS = Object.freeze([
  Object.freeze({ rid: 0, name: 'untrusted', rank: 0 }),
  Object.freeze({ rid: 4096, name: 'low', rank: 1 }),
  Object.freeze({ rid: 8192, name: 'medium', rank: 2 }),
  Object.freeze({ rid: 12288, name: 'high', rank: 3 }),
  Object.freeze({ rid: 16384, name: 'system', rank: 4 }),
  Object.freeze({ rid: 20480, name: 'protected', rank: 5 }),
])

/** 拿不到（权限不足、进程已退出）时的占位名。绝不把未知当成某一档。 */
export const UNKNOWN_INTEGRITY = 'unknown'

/** 只要环境变量/宿主给的字符串形态；`low (4096)`、`Medium`、`unknown` 都收。 */
export function normalizeIntegrity(value) {
  if (value === undefined || value === null) return UNKNOWN_INTEGRITY
  const text = String(value).trim()
  if (text === '') return UNKNOWN_INTEGRITY
  const lower = text.toLowerCase()
  if (lower.startsWith(UNKNOWN_INTEGRITY)) return UNKNOWN_INTEGRITY
  for (const level of INTEGRITY_LEVELS) {
    if (lower === level.name) return level.name
  }
  // 宿主可能只给 RID（`4096`）或 `low(4096)`
  const digits = /^-?\d+$/.exec(text)
  if (digits) {
    const rid = Number.parseInt(text, 10)
    const hit = INTEGRITY_LEVELS.find((level) => level.rid === rid)
    return hit ? hit.name : UNKNOWN_INTEGRITY
  }
  const embedded = /(?:^|\D)(\d{3,5})(?:\D|$)/.exec(text)
  if (embedded) {
    const rid = Number.parseInt(embedded[1], 10)
    const hit = INTEGRITY_LEVELS.find((level) => level.rid === rid)
    if (hit) return hit.name
  }
  return UNKNOWN_INTEGRITY
}

/** 名 → rank；未知返回 undefined（**不是 0** —— 未知不许被当成最低档）。 */
export function integrityRank(name) {
  const normalized = normalizeIntegrity(name)
  const hit = INTEGRITY_LEVELS.find((level) => level.name === normalized)
  return hit ? hit.rank : undefined
}

export const CAN_INJECT = 'can-inject'
export const BLOCK_HIGHER = 'block-uipi-higher'
export const BLOCK_UNKNOWN = 'block-integrity-unknown'
export const SKIP_DRY_RUN = 'skip-dry-run'

/**
 * 注入前的闸门。返回 `{action, code, reason}`：
 *   action = 'inject' | 'dry-run' | 'block'
 *
 * 判据（与 design.md I9 同源）：
 *   - `--dry-run` 不发事件，所以永远只走 dry-run（但仍把两侧级别报出来）；
 *   - 目标级别**读不到**时阻断 —— "读不到"不等于"够得着"，不许拿未知当前提；
 *   - 目标级别高于自身时阻断并给出 `UIPI blocked: target integrity level higher than ours`
 *     （UIPI 在事件入队那一刻拦，且 SendInput 照样报"已插入 N 个事件"、GetLastError=0，
 *     所以**绝不能**靠调用返回判断，必须事先拦 + 事后复核）；
 *   - `force` 只用于"你已经知道自己在做什么"的场景，仍然会原样打印两侧级别。
 */
export function decideInjection(opts = {}) {
  const { dryRun = false, force = false } = opts
  const ours = normalizeIntegrity(opts.ours)
  const target = normalizeIntegrity(opts.target)
  const detail = `ours=${ours} target=${target}`
  if (dryRun) {
    return { action: 'dry-run', code: SKIP_DRY_RUN, ours, target, reason: `--dry-run：只算坐标不发事件（${detail}）` }
  }
  const targetRank = integrityRank(target)
  if (targetRank === undefined) {
    if (force) return { action: 'inject', code: 'forced', ours, target, reason: `--force：目标完整性级别不可读（${detail}）` }
    return {
      action: 'block',
      code: BLOCK_UNKNOWN,
      ours,
      target,
      reason: `读不到目标窗口的完整性级别，无法判定 UIPI 是否会拦（${detail}）`,
    }
  }
  const ourRank = integrityRank(ours)
  if (ourRank === undefined) {
    if (force) return { action: 'inject', code: 'forced', ours, target, reason: `--force：自身完整性级别不可读（${detail}）` }
    return {
      action: 'block',
      code: BLOCK_UNKNOWN,
      ours,
      target,
      reason: `读不到自身的完整性级别，无法判定 UIPI（${detail}）`,
    }
  }
  if (targetRank > ourRank) {
    if (force) return { action: 'inject', code: 'forced', ours, target, reason: `--force：目标完整性级别更高（${detail}）` }
    return {
      action: 'block',
      code: BLOCK_HIGHER,
      ours,
      target,
      reason: `UIPI blocked: target integrity level higher than ours（${detail}）`,
    }
  }
  return { action: 'inject', code: CAN_INJECT, ours, target, reason: detail }
}
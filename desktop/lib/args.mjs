// 命令行解析的纯函数层。形状照 browser/cli.mjs 的 parseArgs 抄：
//   `--k=v`、`--k v`、裸 `--k`（= true）、非 `--` 开头的位置参数进 `_`。
//
// 与 browser 的差别只有一处：本模块的位置参数含义是"命令名 + 值"（`--x 100` 也要收），
// 所以这里**不**对位置参数做语义判断 —— 语义留给 cli.mjs，这一层只管切词。

/** 解析失败一律抛这个；cli.mjs 收到就打印 USAGE 并以退出码 2 结束。 */
export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

/**
 * 需要"缺值就报错"的开关名。不在这里的开关，裸写 = true。
 * 这些开关的值是必填的：`--x` 后面没跟数字却静默变成 true，会在坐标层才炸，
 * 报错点离用户输入太远。
 */
export const REQUIRES_VALUE = Object.freeze([
  'x',
  'y',
  'out',
  'text',
  'keys',
  'id',
  'name',
  'button',
  'set-value',
  'depth',
  'dy',
  'region',
  'hwnd',
  'target-hwnd',
  'settle',
  'expect',
  'clicks',
  'limit',
  'timeout',
])

export const BOOLEAN_FLAGS = Object.freeze([
  'json',
  'double',
  'dry-run',
  'force',
  'fallback-point',
  'raise',
  'no-pixel',
  'hash',
  'help',
])

export function parseArgs(argv = []) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (typeof token !== 'string') throw new UsageError(`参数不是字符串：${String(token)}`)
    if (!token.startsWith('--')) {
      out._.push(token)
      continue
    }
    const eq = token.indexOf('=')
    if (eq > 2) {
      out[token.slice(2, eq)] = token.slice(eq + 1)
      continue
    }
    const key = token.slice(2)
    if (key === '') throw new UsageError('空开关 `--`')
    const next = argv[i + 1]
    // 布尔开关绝不吞下一个 token：`--json windows` 里的 `windows` 是命令名，不是 --json 的值。
    const wantsValue = !BOOLEAN_FLAGS.includes(key)
    const hasValue = wantsValue && next !== undefined && typeof next === 'string' && !next.startsWith('--')
    if (hasValue) {
      out[key] = next
      i += 1
    } else if (REQUIRES_VALUE.includes(key)) {
      // 必填值的开关写成裸 `--x`（后面跟的是另一个开关或到头了）是用法错误，不许静默变 true ——
      // 那样错误会在坐标层才炸，报错点离用户输入太远。单一真相源就是 REQUIRES_VALUE。
      throw new UsageError(`--${key} 后面缺少值`)
    } else {
      out[key] = true
    }
  }
  return out
}

/** 开关是不是"显式要求了值"（`true` / `false` 这种布尔写法不算）。 */
export function hasValue(args, key) {
  const value = args[key]
  return value !== undefined && value !== true && value !== false && value !== ''
}

export function flagOn(args, key) {
  return args[key] === true || args[key] === 'true' || args[key] === '1' || args[key] === 'yes'
}

/**
 * 取一个必填的整数开关。缺值、非数字、越界各给一条能直接照抄的报错。
 * `range` = `[min, max]`（闭区间；`undefined` 表示该侧不设限）。
 */
export function requireInt(args, key, range = [undefined, undefined]) {
  if (!hasValue(args, key)) throw new UsageError(`缺少 --${key} <整数>（或值不是数字）`)
  const raw = String(args[key]).trim()
  if (!/^[+-]?\d+$/.test(raw)) throw new UsageError(`--${key} 需要整数，得到「${raw}」`)
  const value = Number.parseInt(raw, 10)
  const [min, max] = range
  if (min !== undefined && value < min) throw new UsageError(`--${key} 不能小于 ${min}（得到 ${value}）`)
  if (max !== undefined && value > max) throw new UsageError(`--${key} 不能大于 ${max}（得到 ${value}）`)
  return value
}

/** 坐标：物理像素，允许负值（虚拟屏带负原点）。相对坐标一律拒绝。 */
export function requirePoint(args) {
  return {
    x: requireInt(args, 'x', [-100000, 100000]),
    y: requireInt(args, 'y', [-100000, 100000]),
  }
}

/** 取一个必填的字符串开关（空串也算缺）。 */
export function requireText(args, key) {
  if (!hasValue(args, key)) throw new UsageError(`缺少 --${key} <字符串>`)
  return String(args[key])
}

/** 取一个可选的字符串开关。 */
export function optionalText(args, key) {
  return hasValue(args, key) ? String(args[key]) : undefined
}

export const MOUSE_BUTTONS = Object.freeze(['left', 'right', 'middle'])

export function requireButton(args) {
  const raw = optionalText(args, 'button') ?? 'left'
  const value = raw.toLowerCase()
  if (!MOUSE_BUTTONS.includes(value)) {
    throw new UsageError(`--button 只能是 ${MOUSE_BUTTONS.join(' / ')}（得到「${raw}」）`)
  }
  return value
}

/** 命令名：`_` 的第一项；空数组时返回 undefined（调用方按"打 USAGE"处理）。 */
export function commandOf(args) {
  return args._[0]
}

/** `_` 里除命令名之外的残余位置参数 —— 有残余就是用法错误，不许静默忽略。 */
export function extraPositionals(args) {
  return args._.slice(1)
}

export function assertNoExtra(args, cmd) {
  const extra = extraPositionals(args)
  if (extra.length > 0) {
    throw new UsageError(`${cmd} 不认识多余的位置参数：${extra.join(' ')}`)
  }
}

/**
 * 每条命令**认识**哪些开关。放这里而不是散在 cli.mjs 里，是因为它同时是文档与测试的锚点：
 * `help` 的选项表、`design.md` 的契约表、以及 `checkFlagScope` 的报错都引用这一份。
 *
 * 为什么要有这张表：CLI 曾经对"这条命令用不上的开关"一律静默忽略 —— `move --button right`
 * 拿到的是普通移动、`type --x 5 --y 6` 会悄悄丢掉坐标、`--dryrun`（拼错）什么都不报。
 * 于是"我传了参数"与"参数真的生效了"变成两件事，而这正是本轮两个 P1（`--hwnd` 没传下去、
 * 探针作用域退化）能藏住的原因。宁可报用法错，也不许静默忽略。
 *
 * 键名一律是**不带 `--` 的长开关名**（与 `parseArgs` 出参的键一致）。
 */
export const COMMON_FLAGS = Object.freeze(['json', 'help', 'timeout', 'settle', 'no-pixel', 'no-content', 'dry-run'])

export const COMMAND_FLAGS = Object.freeze({
  help: [],
  profile: [],
  windows: [],
  screen: ['out', 'region', 'hash'],
  uia: ['hwnd', 'depth', 'name', 'id', 'limit'],
  point: ['x', 'y'],
  click: ['x', 'y', 'button', 'double', 'clicks', 'force', 'raise', 'target-hwnd'],
  move: ['x', 'y', 'force', 'raise', 'target-hwnd'],
  scroll: ['x', 'y', 'dy', 'force', 'raise', 'target-hwnd'],
  // type/key 的 --x/--y 不是收键窗口（那由 --hwnd 决定），只是把"观测作用域"指到那个点。
  type: ['text', 'hwnd', 'x', 'y', 'force', 'raise'],
  key: ['keys', 'hwnd', 'x', 'y', 'force', 'raise'],
  invoke: ['id', 'hwnd', 'name', 'depth', 'limit', 'set-value', 'fallback-point', 'force'],
  verify: ['x', 'y', 'expect'],
  snapshot: ['hwnd', 'x', 'y'],
  probe: [],
})

/** 这条命令认识的开关（含通用项）；未知命令返回 `null`（调用方按"不认识命令"处理）。 */
export function allowedFlags(cmd, table = COMMAND_FLAGS) {
  const own = table[cmd]
  if (own === undefined) return null
  return [...COMMON_FLAGS, ...own]
}

/**
 * 不许静默忽略开关：这条命令不认识的开关一律报用法错（退出码 2）。
 * 返回被拒绝的开关名（正常情况是抛错，返回值只给测试用）。
 */
export function checkFlagScope(args, cmd, table = COMMAND_FLAGS) {
  const allowed = allowedFlags(cmd, table)
  if (allowed === null) return []
  const known = new Set(allowed)
  const unknown = Object.keys(args).filter((key) => key !== '_' && !known.has(key))
  if (unknown.length > 0) {
    throw new UsageError(
      `${cmd} 不认识开关：${unknown.map((key) => `--${key}`).join(' ')}` +
        `（这条命令认识：${[...allowed].sort().map((key) => `--${key}`).join(' ')}）`,
    )
  }
  return unknown
}
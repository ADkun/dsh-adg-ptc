// 「这次动作到底有没有生效」的纯函数层。
//
// 存在的理由（design.md 的 I5）是本模块最反直觉的一条 Windows 事实：
// UIPI 拦下合成输入时，`SendInput` 照样返回"已插入 N 个事件"、`GetLastError() = 0`，
// 事件随后被静默丢弃。所以**任何调用返回都不能当成功证据** ——
// 判据只能是"动作前后有没有可观测差异"。本层算的就是这个差异。

import { fnv1a32 } from './elements.mjs'

/**
 * 比较两侧状态，输出 `{changed, reasons, digestBefore, digestAfter}`。
 *
 * `opts.ignore` 里的键**不参与差异判定**。存在的理由是一个真出现过的假成功：
 * `point` / `pointRect` 是"这个坐标下现在是哪个窗口"，它对**任何**坐标类注入都必然变
 * —— 光标一动它就变，与目标窗口有没有收到事件毫无关系。把它算进差异集合，就等于
 * "注入失败也报 CHANGED=true"。所以注入类命令把它排除在差异之外，改成独立断言
 * `landingInTarget`（见 `landingNote`），判据是"落点窗口的 ROOT_HWND 是不是目标窗口"。
 *
 * 同一类陷阱在内容类判据上也踩过一次（由 `test/content-safety.test.mjs` 钉住）：内容快照的
 * 子进程崩掉时后一次读数是"缺测"（hash 变成空串），与"界面真的变了"长得一模一样 ——
 * 于是崩一次就报 `CHANGED=true`。所以任一端的 `contentProbeFailed` 为真时，内容这一类
 * **整个退出差异集合**，交给 `changeVerdict` 报 unknown。
 */
export function compareStates(before, after, opts = {}) {
  const ignore = new Set(Array.isArray(opts.ignore) ? opts.ignore : [])
  const left = normalizeState(before)
  const right = normalizeState(after)
  const reasons = []
  if (left.foreground !== right.foreground) {
    reasons.push(`前台窗口：${left.foreground} -> ${right.foreground}`)
  }
  if (left.foregroundTitle !== right.foregroundTitle) {
    reasons.push(`前台标题：「${left.foregroundTitle}」->「${right.foregroundTitle}」`)
  }
  if (left.windowCount !== right.windowCount) {
    reasons.push(`可见窗口数：${left.windowCount} -> ${right.windowCount}`)
  }
  if (left.titlesDigest !== right.titlesDigest) {
    reasons.push(`窗口标题集合变了（${left.titlesDigest} -> ${right.titlesDigest}）`)
  }
  if (!ignore.has('point')) {
    if (left.point !== right.point) {
      reasons.push(`该坐标下的窗口：${left.point} -> ${right.point}（左上角 ${left.pointRect} -> ${right.pointRect}）`)
    } else if (left.pointTitle !== right.pointTitle) {
      reasons.push(`该坐标下的窗口标题：「${left.pointTitle}」->「${right.pointTitle}」`)
    }
  }
  if (!ignore.has('pixels') && left.pixelHash !== right.pixelHash) {
    reasons.push(`像素哈希：${left.pixelHash || '-'} -> ${right.pixelHash || '-'}`)
  }
  if (!ignore.has('content') && !left.contentProbeFailed && !right.contentProbeFailed &&
      left.contentHash !== right.contentHash) {
    reasons.push(`UI 内容：${left.contentHash || '-'} -> ${right.contentHash || '-'}`)
  }
  return {
    changed: reasons.length > 0,
    reasons,
    digestBefore: digestOf(left),
    digestAfter: digestOf(right),
    before: left,
    after: right,
  }
}

/**
 * 三类判据的**覆盖面**：`true` / `false` / `unknown`。
 *
 * 存在的理由（真机实测）：`type` / `key` / `scroll` 都报了 `CHANGED=false`，而靶窗口自己的
 * `TextChanged` 日志、独立的 UIA `ValuePattern` 读回、滚动条的 UIA 读数三者一致证明动作已生效。
 * 旧的判据集合（像素哈希 + 落点元素名 + 窗口标题集合）**根本看不见"文本框里的字变了"**
 * 和"列表滚了"，于是真成功长得跟失败一模一样 —— 这会把人直接引向错误结论。
 *
 * 所以口径是：**"我看不见这类动作的效果"绝不许报成 `false`。**
 * 没有差异 + 这次动作的效果落在已捕获判据的覆盖范围之外 ⇒ 报 `unknown`，
 * 让调用方去 `--expect` 或自己读回，而不是误以为动作没发生。
 */
/**
 * 每条注入类命令**必须有**的内容类判据。缺了它，`CHANGED=false` 就没有资格被读成"没变"。
 *
 * 为什么需要这张表（真机实测，design.md I7f）：`scroll --dy -5` 报 `CHANGED=false`，而外部
 * 独立读数 `GetScrollInfo(SB_VERT)` 明明白白显示 `nPos 0→15→30` —— 滚动根本**不改文本**，
 * 所以在"只比文本属性"的旧判据下，`scroll` 的成功结构上不可能被看见，它永远报 false。
 * 这不是"没变"，是"看不见"。读不到这类读数时只能报 `unknown`。
 *
 * `value` 类读得到/读不到、`scroll` 类读得到/读不到的控件类型见 testing-guide.md 的
 * 「内容判据矩阵」——那张表是按真机读数画的，不是按理论。
 */
export const INJECTION_CRITERIA = Object.freeze({
  scroll: ['scroll'],
  type: ['value'],
  key: ['value', 'selected', 'toggle', 'scroll', 'rangeValue'],
})

/** 某条注入命令需要的内容类判据（未知命令 ⇒ 空数组，退回像素/窗口那几条通用判据）。 */
export function neededKinds(kind) {
  const list = INJECTION_CRITERIA[String(kind ?? '')]
  return Array.isArray(list) ? [...list] : []
}

/** 某条状态里这一类内容读数有几条（`normalizeState` 之后的形状）。 */
export function contentKindCount(state, kind) {
  const source = normalizeState(state)
  const kinds = source.contentKinds
  const value = kinds[kind]
  if (kind === 'scroll') {
    // 祖先链上的滚动读数**已经被桥计进 `scroll`**（`ancestorScroll` 只是"其中来自祖先的有几条"
    // 这个子集标记，见 bridge.ps1 的 kinds 累加）。所以正常情况就用 `scroll`。
    // 只有当 `scroll` 为 0 时才回退到子集标记 —— 取"或"而不是"和"，绝不重复计数。
    return Number.isFinite(value) && value > 0 ? value : kinds.ancestorScroll
  }
  return Number.isFinite(value) ? value : 0
}

export function changeVerdict(cmp, opts = {}) {
  if (cmp.changed) return { changed: 'true', reason: '' }
  const before = normalizeState(cmp.before)
  const after = normalizeState(cmp.after)
  // 内容快照的子进程崩掉过（真机：UIA 读到坏状态，AccessViolationException 连 try/catch 都抓不住，
  // 整个 powershell.exe 退出、exit=3221225477）。这时"内容类效果"这一类判据是**缺测**，不是"没变"。
  // 像素哈希固然还在，但它本来就看不见"文本框里的字变了" —— 所以一律降级成 unknown，绝不报 false。
  if (before.contentProbeFailed || after.contentProbeFailed) {
    const note = after.contentNote || before.contentNote
    return {
      changed: 'unknown',
      reason:
        '内容快照这次没读到（内容探针子进程异常退出）—— 这类效果的判据缺测，所以 CHANGED=unknown（不是 false）。' +
        `原始原因：${note || '未记录'}`,
    }
  }
  // 这条命令**专属**的判据要有读数，否则它的效果属于"看不见"，而没有差异并不等于没生效。
  // 例：`scroll` 只看文本属性时永远报 false（真机：GetScrollInfo 证明 nPos 0→15→30）。
  const needs = Array.isArray(opts.needsKinds) ? opts.needsKinds : []
  const missing = needs.filter(
    (kind) => contentKindCount(before, kind) === 0 && contentKindCount(after, kind) === 0,
  )
  if (missing.length > 0) {
    return {
      changed: 'unknown',
      reason:
        `这条命令的效果要靠「${missing.join(' / ')}」这类读数才能看见，而这次一条都没读到` +
        '（控件不暴露对应 pattern，或跨完整性级别读被拒）—— 判据缺测，所以 CHANGED=unknown（不是 false）。' +
        '没看到差异 ≠ 动作没生效：请用 --expect、或自己读回（例如 GetScrollInfo / uia --hwnd <目标> 看 Value）。',
    }
  }
  // 能看见"内容类效果"的判据只有两种：目标区域的像素，或可读的 UIA 内容属性。
  const pixelCaptured = !opts.noPixel && (before.pixelHash !== '' || after.pixelHash !== '')
  const contentVisible = before.contentBearingCount > 0 || after.contentBearingCount > 0
  if (pixelCaptured || contentVisible) return { changed: 'false', reason: '' }
  return {
    changed: 'unknown',
    reason:
      '这个动作的效果不在自动判据的覆盖范围内：没有捕获像素区域，也读不到任何 UIA 内容属性' +
      '（Value / scroll / rangeValue / toggle / selected）。所以 CHANGED=unknown（不是 false）' +
      '—— 没看到差异 ≠ 动作没生效。请用 --expect，或自己读回（例如 uia --hwnd <目标> 看 Value）。',
  }
}

/**
 * 落点归属：动作后光标所在像素上的窗口，是不是**目标窗口**（比 ROOT_HWND / hwnd，
 * 不比叶子窗口 —— 目标内部换个子控件不该算"跑掉了"）。
 *
 * 这是与 CHANGED 并列的第二类判据，不参与它：CHANGED 答"界面变没变"，它答
 * "指针到底落在谁身上"。`target` 为空（键类命令没有落点）时给 `inTarget=null`。
 *
 * `opts.explicitTarget === false`（调用方没给 `--target-hwnd`）时，`inTarget` 一律为
 * `null`、只留 `sameWindow` —— 真机教训（design.md I7g）：带坐标的命令曾把"落点上的窗口"
 * 直接当成 target，于是 `在目标内=true` 只证明"落点像素上还是同一个窗口"，与"点进了我想要
 * 的那个窗口"毫无关系。故意点隔壁自建窗的按钮时它照样报 true（靶 B 计数 +1、靶 A 无新行）。
 * 所以没有显式目标时**不许**给出一个会被读成"点对了"的布尔值。
 */
export function landingNote(state, target, req, opts = {}) {
  const landed = state?.pointLanded === true
  const hwnd = text(state?.point)
  const root = text(state?.pointRootHwnd)
  const want = text(target?.hwnd)
  const wantRoot = text(target?.rootHwnd) || want
  const explicit = opts.explicitTarget !== false
  let sameWindow = null
  if (want !== '' || wantRoot !== '') {
    sameWindow = (hwnd !== '' && (hwnd === want || hwnd === wantRoot)) ||
      (root !== '' && (root === want || root === wantRoot))
  }
  const inTarget = explicit ? sameWindow : null
  const parts = [`落点=${hwnd || '-'}`, `目标=${want || '-'}`]
  if (root !== '') parts.push(`落点根=${root}`)
  if (req && Number.isFinite(req.x) && Number.isFinite(req.y)) parts.push(`要求=${req.x},${req.y}`)
  parts.push(`同窗口=${sameWindow === null ? '-' : String(sameWindow)}`)
  parts.push(`在目标内=${inTarget === null ? '-' : String(inTarget)}`)
  parts.push(`落点匹配=${landed}`)
  if (!explicit) parts.push('（没有给 --target-hwnd：这里没有可比的目标，只说明"落点像素上还是同一个窗口"）')
  return { landed, inTarget, sameWindow, explicit, note: parts.join(' ') }
}

/**
 * 注入**前**的落点归属闸门（design.md I7g / AGENTS.md 红线 15）。
 *
 * 为什么需要它：事后的 `LANDING_IN_TARGET=`（`landingNote`）是**发完事件**才评估的 —— 它能把
 * "点错了"如实记下来，却拦不住事件已经送进别人的窗口。真机上发生过：调用方给了
 * `--target-hwnd`，落点像素其实被别的窗口占着，CLI 打了 `LANDING_IN_TARGET=false`，却照样
 * `INSERTED_EVENTS=5` 把点击发了出去（更早还有约 40 次单击落到用户终端上的记录）。所以显式
 * 目标必须在**注入前**先与"这个坐标现在压在谁身上"（`point` 探针的 `WindowFromPoint` +
 * `GetAncestor(GA_ROOT)` 读数）对上。
 *
 * 三态口径与几何闸门（红线 14）**完全同款**，不另立一套语义：
 *   - `true`  ⇒ 放行；
 *   - `false` ⇒ 默认拒发（显式 `--force` 才硬发，并把这段文字保留成 `WARN=`）；
 *   - `unknown` ⇒ 只 `WARN=`（拿不到落点窗口时按"不知道"处理，**不** fail-closed）。
 *
 * 它与事后那行是"两道门、两次判定"，不是同一次：探针与注入之间仍有竞态（第 8 轮实测过几何
 * 读数在竞态下变样），所以 preflight 过了也不代表事件一定落在那里 —— 事后
 * `LANDING_IN_TARGET=` 仍然要读。
 */
export function landingPreflight(reading, target, opts = {}) {
  const explicit = opts.explicitTarget !== false
  const hwnd = text(reading?.hwnd)
  const root = text(reading?.rootHwnd)
  const want = text(target?.hwnd)
  const wantRoot = text(target?.rootHwnd) || want
  const actual = hwnd === '' && root === '' ? '-' : `${hwnd || '-'}/${root || '-'}`
  if (!explicit) {
    return {
      verdict: 'unknown',
      actual,
      reason: '没有显式目标（未给 --target-hwnd），这一路不做落点闸门',
    }
  }
  if (want === '' && wantRoot === '') {
    return { verdict: 'unknown', actual, reason: '没有可比的目标窗口句柄' }
  }
  if (hwnd === '' && root === '') {
    return {
      verdict: 'unknown',
      actual,
      reason:
        '这次读不到落点像素上的窗口（WindowFromPoint / GetAncestor 被拒，或点在屏外、窗口已最小化）',
    }
  }
  const hit =
    (hwnd !== '' && (hwnd === want || hwnd === wantRoot)) ||
    (root !== '' && (root === want || root === wantRoot))
  return {
    verdict: hit ? 'true' : 'false',
    actual,
    want: want || wantRoot,
    wantRoot: wantRoot || want,
    reason: hit
      ? `落点窗口与目标同根（落点=${actual}，目标=${want || wantRoot}）`
      : `落点=${actual} 与目标（期望 ${want || wantRoot}、根 ${wantRoot || want}）不是同一个窗口`,
  }
}

/** 把 bridge 回来的原始读数规整成可比较的形状。缺字段一律补成空串，不补成"猜的值"。 */
export function normalizeState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const titles = Array.isArray(source.windowTitles) ? source.windowTitles.map((item) => String(item)) : []
  return {
    foreground: text(source.foreground),
    foregroundTitle: text(source.foregroundTitle),
    windowCount: Number.isFinite(source.windowCount) ? source.windowCount : titles.length,
    windowTitles: titles,
    titlesDigest: hashText(titles.join('\u0001')),
    point: text(source.point),
    pointTitle: text(source.pointTitle),
    pointProcess: text(source.pointProcess),
    pointIntegrity: text(source.pointIntegrity),
    pointRect: text(source.pointRect),
    pixelHash: text(source.pixelHash),
    // 内容类判据（见 changeVerdict）：contentBearingCount 是"真读到了内容属性"的条数，
    // contentCount 是含 identity 行的总条数。两者都要留着，别用后者冒充前者。
    contentHash: text(source.contentHash),
    contentRoot: text(source.contentRoot),
    contentCount: Number.isFinite(source.contentCount) ? source.contentCount : 0,
    contentBearingCount: Number.isFinite(source.contentBearingCount) ? source.contentBearingCount : 0,
    // 内容读数按类别计数（value / scroll / rangeValue / toggle / selected / ancestorScroll）。
    // 光有"一共读到几条"不够：`scroll` 要的是 scroll 那一类，靠总条数冒充会得出错误的结论。
    contentKinds: normalizeKinds(source.contentKinds),
    // 内容探针这次用的**作用域**（foreground / hwnd / point / point+hwnd，见 design.md I7h）。
    // 它是"作用域被悄悄换掉"这类缺陷的可见判据：before 与 after 必须同值；带 --x/--y 的注入类
    // 命令必须出现 point（只有根、没有点 = 少了滚动位置那类读数，`scroll` 就永远报不出 true）。
    contentSource: text(source.contentSource),
    contentNote: text(source.contentNote),
    uiaAvailable: source.uiaAvailable !== false,
    // 内容探针（独立子进程）异常退出过。必须与"读到了 0 条"区分开：前者是缺测，后者是"读了但没内容"。
    contentProbeFailed: source.contentProbeFailed === true,
  }
}

/**
 * 把"独立子进程读到的内容快照"并进状态。**这个函数绝不抛**（见 design.md I7e）。
 *
 * 为什么要独立子进程：UIA 的内容读取能抛 corrupted-state 的 `AccessViolationException`，
 * PowerShell 的 `try/catch` 抓不住 —— 整个进程当场消失（真机 `exit=3221225477`）。
 * 它曾经住在 `verify` 里，于是**每条注入类命令的 before 快照都被它带崩**，`click`/`type`/`key`
 * 连 SendInput 都没走到。现在它单独一次调用：崩了只损失一条读数，其余判据与注入本身照跑，
 * 而这一条记 unknown —— **读不到 != 没变化**。
 */
export function applyContentSnapshot(state, probe) {
  const target = state && typeof state === 'object' ? state : {}
  const snapshot = probe?.ok === true ? probe.json?.snapshot : undefined
  if (snapshot === undefined || snapshot === null) {
    const reason = text(probe?.reason) || '原因未记录'
    target.contentHash = ''
    target.contentCount = 0
    target.contentBearingCount = 0
    target.contentKinds = normalizeKinds(undefined)
    target.contentSource = ''
    target.uiaAvailable = false
    target.contentProbeFailed = true
    target.contentNote = `内容快照子进程没有返回读数（${reason}）；这一项记 unknown，绝不当作"界面没变"`
    return target
  }
  target.contentHash = text(snapshot.hash)
  target.contentCount = Number.isFinite(snapshot.count) ? snapshot.count : 0
  target.contentBearingCount = Number.isFinite(snapshot.contentCount) ? snapshot.contentCount : 0
  target.contentKinds = normalizeKinds(snapshot.kinds)
  target.contentRoot = text(snapshot.root) || text(target.contentRoot)
  target.contentSource = text(snapshot.source)
  target.uiaAvailable = snapshot.uia !== false
  target.contentProbeFailed = false
  target.contentNote = text(snapshot.note)
  return target
}

/** 状态 → 一行摘要（`BEFORE=` / `AFTER=` 打的就是它）。 */
export function digestOf(state) {
  const source = normalizeState(state)
  const parts = [
    `fg=${source.foreground || '-'}`,
    `fgTitle=${source.foregroundTitle || '-'}`,
    `windows=${source.windowCount}`,
    `titles=${source.titlesDigest.slice(0, 8) || '-'}`,
    `point=${source.point || '-'}`,
    `pointTitle=${source.pointTitle || '-'}`,
    `pixels=${source.pixelHash || '-'}`,
    `content=${source.contentHash || '-'}(${source.contentBearingCount})`,
  ]
  return parts.join(' ')
}

/**
 * `--expect k=v;k=v` 的判据。支持的键就是摘要里的那些（外加 `changed`）。
 * 给不认识的键**直接报错**，不要静默当通过 —— 静默通过比报错危险得多。
 */
export const EXPECT_KEYS = Object.freeze([
  'foreground',
  'foreground_title',
  'window_count',
  'titles_digest',
  'point',
  'point_title',
  'pixels',
  'changed',
])

export function parseExpect(text) {
  if (text === undefined || text === null || String(text).trim() === '') return []
  return String(text)
    .split(';')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '')
    .map((chunk) => {
      const eq = chunk.indexOf('=')
      if (eq <= 0) throw new Error(`--expect 的每一段都要写成 k=v，得到「${chunk}」`)
      const key = chunk.slice(0, eq).trim()
      const value = chunk.slice(eq + 1).trim()
      if (!EXPECT_KEYS.includes(key)) {
        throw new Error(`--expect 不认识的键「${key}」；可用：${EXPECT_KEYS.join(' / ')}`)
      }
      return { key, value }
    })
}

/** 逐条判 `--expect`；返回 `{ok, rows}`，rows 里每条带判据与实际值。 */
export function checkExpectations(specs, result) {
  const rows = specs.map((spec) => {
    const actual = actualFor(spec.key, result)
    return { key: spec.key, expect: spec.value, actual, ok: actual === spec.value }
  })
  return { ok: rows.every((row) => row.ok), rows }
}

function actualFor(key, result) {
  const { before, after, changed } = result
  switch (key) {
    case 'foreground':
      return text(after.foreground)
    case 'foreground_title':
      return text(after.foregroundTitle)
    case 'window_count':
      return String(after.windowCount)
    case 'titles_digest':
      return text(after.titlesDigest)
    case 'point':
      return text(after.point)
    case 'point_title':
      return text(after.pointTitle)
    case 'pixels':
      return text(after.pixelHash)
    case 'changed':
      return changed ? 'true' : 'false'
    default:
      throw new Error(`不认识的 --expect 键：${key}`)
  }
}

/**
 * 动作后的说明性 WARN。**只描述现象，不下"成功/失败"的结论** ——
 * 结论由 CHANGED 给，这里补的是"为什么可能是这个结果"。
 *
 * 结尾那句"更可能是坐标落空"必须**按命令分开写**：对 `scroll` 说"坐标落空"是误导
 * （真机：`scroll` 的 false 来自"滚动不改文本"，而滚动确实发生了）。对 `move` 也误导
 * （指针位置由 `CURSOR_LANDED` 判定，CHANGED 根本不管它）。
 */
export function injectionWarn(result, opts = {}) {
  if (result.changed) return undefined
  const notes = []
  if (opts.targetIntegrity && opts.oursIntegrity) {
    notes.push(`目标窗口完整性级别 ${opts.targetIntegrity} / 自身 ${opts.oursIntegrity}`)
  }
  if (opts.inserted !== undefined && opts.inserted >= 0) {
    notes.push(`SendInput 报"已插入 ${opts.inserted} 个事件"、lastError=${opts.lastError ?? 0}`)
  }
  if (opts.hint) notes.push(opts.hint)
  const generic =
    '没有观测到任何变化（CHANGED=false）。UIPI 拦截是静默的：SendInput 会照常报"已插入 N 个事件"' +
    '且 GetLastError=0，事件随后被丢弃 —— 所以这个返回值不能当成功证据。'
  return generic + (notes.length > 0 ? ` 现场读数：${notes.join('；')}。` : '') + kindTail(opts.kind)
}

/** 按子命令写"那接下来该怀疑什么"。写错方向比不写更坏（会把人带去查错地方）。 */
function kindTail(kind) {
  switch (String(kind ?? '')) {
    case 'scroll':
      return (
        '滚轮事件不改文本：若这次读到了滚动位置且没变，才轮到"目标不接受该事件、或指针没落在可滚动区域"；' +
        '读不到滚动位置时本模块报 CHANGED=unknown，不会拿 false 冒充结论。'
      )
    case 'type':
    case 'key':
      return (
        '键盘事件发给的是**前台窗口**：先看 FOCUS_OK 是不是 true、FOCUS_TARGET 是不是你要的窗口' +
        '（焦点不在目标上，字符会落到别的窗口里，而本模块不会去猜一个窗口）。'
      )
    case 'move':
      return (
        '指针位置不看 CHANGED —— 它由 CURSOR_LANDED 判定（拿 GetCursorPos 与请求像素真比对）。' +
        '纯移动指针本来就不会让界面发生变化，这里的 false 不能读成"移动失败"。'
      )
    default:
      return (
        '若两侧完整性级别相同而得 false，则更可能是坐标落空、目标不接受该事件或窗口未重绘' +
        '（坐标类命令还会先做几何自洽检查，见 GEO_MISMATCH）。'
      )
  }
}

/** 内容读数分类计数：不认得的键丢掉，缺的补 0 —— 绝不拿"总条数"冒充某一类。 */
export function normalizeKinds(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const keys = ['value', 'scroll', 'rangeValue', 'toggle', 'selected', 'ancestorScroll']
  const out = {}
  for (const key of keys) {
    out[key] = Number.isFinite(source[key]) ? source[key] : 0
  }
  return out
}

/** 桥侧 `raise-ignored-no-target` 标记的前缀（脚本必须 ASCII-only，中文解释在 Node 侧给）。 */
export const RAISE_IGNORED_MARKER = 'raise-ignored-no-target'

/**
 * `--raise` 那条 `WARN=` 的文本组装（纯函数，好单测）。
 *
 * 桥回的是**带原因的英文标记**，比中文常量具体，所以：桥给了文本就原样用它（已知标记再补一句
 * 中文解释），桥没给文本才回退到中文常量。**不许反过来把桥的文本整个丢掉** —— 那样"为什么没
 * 抬起"就从输出里消失了，而这条 WARN 的存在意义正是说清原因。
 */
export function raiseNoteText(bridgeNote, fallback) {
  const note = text(bridgeNote).trim()
  const tail = text(fallback).trim()
  if (note === '') return tail
  if (!note.startsWith(RAISE_IGNORED_MARKER)) return note
  return tail === '' ? note : `${note}　${tail}`
}

function text(value) {
  return value === undefined || value === null ? '' : String(value)
}

/**
 * 短哈希（8 位十六进制）。用 lib/elements.mjs 的 FNV-1a：同一个算法已经在本模块里
 * 跨 Node/PowerShell 两侧对齐过，不再引第二种哈希。
 * 它只用来判断"标题集合变没变"，不是安全用途。
 */
function hashText(value) {
  return fnv1a32(String(value)).toString(16).padStart(8, '0')
}
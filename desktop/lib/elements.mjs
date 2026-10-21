// UIA 元素 id 与「取哪个元素」的纯函数层。
//
// 稳定 id 的来历（design.md 的 I6）：UIA 的 RuntimeId 是一串整数，同一次登录会话内
// 对同一个元素恒定（跨进程重启也稳定，只要桌面会话不变）。本模块把它拼成
// `"<a>.<b>.<c>"` 再取 FNV-1a 32 位哈希，输出 `el_<8 位十六进制>`。
// PowerShell 侧 `Get-Fnv1a` 是**同算法同输入**的实现 —— 两侧必须给出同一个 id，
// 否则 `uia` 报出的 id 拿去 `invoke` 会找不到元素。

/** FNV-1a 32 位（offset basis 2166136261 / prime 16777619），按 UTF-8 字节跑。 */
export function fnv1a32(text) {
  const bytes = Buffer.from(String(text), 'utf8')
  let hash = 2166136261
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

/** RuntimeId 数组 → `"1.2.3"`（与 bridge.ps1 的 `-join '.'` 同形）。 */
export function runtimeKey(runtimeId) {
  if (!Array.isArray(runtimeId)) return undefined
  if (runtimeId.length === 0) return undefined
  return runtimeId.map((part) => String(part)).join('.')
}

/** RuntimeId 数组 → 稳定元素 id。拿不到 RuntimeId 时返回 `el_unknown`（绝不编一个假的）。 */
export function elementId(runtimeId) {
  const key = runtimeKey(runtimeId)
  if (key === undefined) return 'el_unknown'
  return `el_${fnv1a32(key).toString(16).padStart(8, '0')}`
}

/** id 形状校验：`el_` + 8 位十六进制，或宿主明确报的占位 `el_unknown`。 */
export function isElementId(value) {
  return typeof value === 'string' && (/^el_[0-9a-f]{8}$/.test(value) || value === 'el_unknown')
}

/**
 * 占位 id：`GetRuntimeId()` 读不到时桥侧给的就是这一个字符串（`bridge.ps1` 的 `New-Node`
 * catch 分支），所以它**不是"某个元素的名字"，是一整类元素的折叠**：
 *
 *   1. 它**不唯一** —— 同一份快照里出现两个就无从选择（`pickElement` 会拒），而"恰好一个"
 *      只是"这次遍历里恰好一个"，跨作用域、跨两遍遍历都没有任何保证；
 *   2. 它**没有 runtimId**（节点的 `runtimeId` 是空串）⇒ 桥的第二遍遍历无从复核身份，
 *      只能按 id 匹配并取**第一个**命中。
 *
 * 形状闸门仍然放行它（快照输出与 `uia --id` 都要能看见它，见 design.md I6e），但"能不能拿它
 * 去动手"是另一件事：未限定窗口时必须有可复核的身份，占位 id 给不出来 ⇒ `cmdInvoke` 报用法错。
 */
export const PLACEHOLDER_ELEMENT_ID = 'el_unknown'

/** 是不是那个"runtimeId 读不到"的占位 id。 */
export function isPlaceholderElementId(value) {
  return value === PLACEHOLDER_ELEMENT_ID
}

/**
 * 「这次能不能复核身份」：从**定位快照**的元素上取出要随 invoke 下发给桥的 runtimeId。
 *
 * 返回 `{runtimeId, state}`：
 *   - `state === 'checked'`：下发的 runtimeId 必须与桥第二遍遍历命中的那个元素的 runtimeId
 *     **逐字符相同**，否则桥不执行任何动作（design.md I6f）；
 *   - `state === 'absent'`：快照里没有 runtimeId（占位 id 那一类）⇒ **不下发**、也**不许凭空造
 *     一个**；这次没有身份复核，缺口由调用方显式打出来（`ID_IDENTITY=absent` + 一条 `WARN=`）。
 *     空白串与空串同义（桥侧的 runtimeId 是把数字用 `.` 连起来的，永远不会是空白）。
 */
export function elementIdentity(element) {
  const runtimeId = element?.runtimeId
  if (typeof runtimeId !== 'string' || runtimeId.trim() === '') {
    return { runtimeId: undefined, state: 'absent' }
  }
  return { runtimeId, state: 'checked' }
}

/**
 * 把「计划下发的身份」与「桥回传的复核结论」合成一行 `ID_IDENTITY=` 的取值：
 * `checked`（一致）/ `absent`（这次没有身份复核）/ `mismatch`（不一致）。
 *
 * `mismatch` 的语义是**拒绝动手**，不是"动作没生效"：桥侧一个 pattern 调用都没发生，
 * 所以调用方必须按退出码 2（用法与拒动手）处理，而不是 1（运行期失败）—— 这两句话的补救
 * 动作完全不同：前者是"重新取 id"，后者是"动作没落地，去查闸门/靶侧"。
 */
export function identityState(planned, report) {
  if (report?.identityMismatch === true) return 'mismatch'
  return planned?.state === 'checked' ? 'checked' : 'absent'
}

/**
 * 「取哪个元素」的护栏 —— 与 browser/lib/cdp.mjs 的 pickPage 同一形状：
 * **不许猜**。命中 0 个、命中多个、id 形状不合法、没有给出任何选择条件，
 * 一律返回 `reason` 而不是随便挑一个。
 */
export function pickElement(elements, opts = {}) {
  const list = Array.isArray(elements) ? elements : []
  const wantId = opts.id
  const wantName = opts.name
  if (wantId !== undefined && !isElementId(wantId)) {
    return { element: null, reason: `--id 的形状不对：${wantId}（应是 el_ 加 8 位十六进制，取自 uia 的输出）` }
  }
  if (wantId !== undefined) {
    const hits = list.filter((item) => item?.id === wantId)
    if (hits.length === 0) {
      // 这句话本身不许下结论：快照里没有 ≠ 元素不存在。原因可能是元素消失、作用域换了，
      // 或者（真机踩过 11/11 的那个）遍历在预算处被截断 —— 最后那种由调用方补足说明。
      return { element: null, reason: `这次快照里没有 ${wantId}（可能已消失、可能换了作用域、也可能快照被截断）` }
    }
    if (hits.length > 1) {
      return { element: null, reason: `${wantId} 在快照里出现 ${hits.length} 次，无法确定是哪一个` }
    }
    return { element: hits[0], reason: 'by-id' }
  }
  if (wantName !== undefined) {
    const needle = String(wantName).toLowerCase()
    const hits = list.filter((item) => {
      const name = String(item?.name ?? '').toLowerCase()
      const automationId = String(item?.automationId ?? '').toLowerCase()
      return name.includes(needle) || automationId.includes(needle)
    })
    if (hits.length === 0) return { element: null, reason: `没有任何元素的 Name/AutomationId 含「${wantName}」` }
    if (hits.length > 1) {
      return { element: null, reason: `有 ${hits.length} 个元素含「${wantName}」，请改用 --id 精确指定` }
    }
    return { element: hits[0], reason: 'by-name' }
  }
  return { element: null, reason: '没给选择条件：--id <el_id> 或 --name <子串>' }
}

/**
 * pattern 列表归一化。
 *
 * 宿主（bridge.ps1 的 `Get-PatternNames`）有两次让这个函数变成"挡箭牌"的历史：
 *   1. 元素恰好只支持一种 pattern 时数组被拆包成裸字符串 ⇒ `{"patterns":"InvokePattern"}`；
 *   2. 后来桥侧同时用了 `return ,@($names)` 和 `[object[]]@(...)`，两层包装叠成
 *      `{"patterns":[["InvokePattern"]]}` —— 只支持一种 pattern 的按钮/窗口从此全被判空。
 * 源头现在只留一处包装（桥侧 `[object[]](Get-PatternNames …)`，已由
 * `test/patterns-shape.test.mjs` 与 `test/injection.test.mjs` 钉死），这里再收一次只是
 * **防回退**：标量当单元素列表。但内层还是数组时不再静默吞掉 —— 那是形状坏了，交给
 * `patternShapeProblem()` 报出来，免得下一轮又靠"兜底"把真缺陷掩盖过去。
 */
export function patternList(patterns) {
  if (Array.isArray(patterns)) return patterns.filter((name) => typeof name === 'string' && name !== '')
  if (typeof patterns === 'string' && patterns !== '') return [patterns]
  return []
}

/**
 * 形状自检：返回一句人话说明 patterns 的形状坏在哪，正常时返回 `null`。
 *
 * 存在的理由：`patternList()` 的防回退分支会把坏形状**变成空列表**，而"空列表"在下游与
 * "这个元素真的不支持任何 pattern"完全同形 —— 于是源头的缺陷会伪装成正常结果。调用方把
 * 这里返回的话打一行 `WARN=`，缺陷就会自己冒出来而不是被吞掉。
 */
export function patternShapeProblem(patterns) {
  if (patterns === undefined || patterns === null) return null
  if (typeof patterns === 'string') {
    return `patterns 是裸字符串「${patterns}」而不是数组（桥侧又发生了一次单元素拆包）`
  }
  if (!Array.isArray(patterns)) return `patterns 既不是数组也不是字符串：${typeof patterns}`
  const nested = patterns.filter((item) => Array.isArray(item))
  if (nested.length > 0) {
    return `patterns 里还嵌着 ${nested.length} 个数组（桥侧有两层包装叠在一起）；实际形状=${JSON.stringify(patterns)}`
  }
  const bad = patterns.filter((item) => typeof item !== 'string')
  if (bad.length > 0) return `patterns 里有 ${bad.length} 个非字符串项：${JSON.stringify(patterns)}`
  return null
}

/** 把可用 pattern 列表压成一行（输出用）。空列表给 `-`，不写空串。 */
export function patternsText(patterns) {
  const list = patternList(patterns)
  if (list.length === 0) return '-'
  return list.join(',')
}

/** 矩形 → `left,top,w,h`；没有矩形写 `-`（有些虚拟元素不给 BoundingRectangle）。 */
export function rectText(rect) {
  if (!rect || typeof rect !== 'object') return '-'
  const { left, top, width, height } = rect
  if (![left, top, width, height].every((value) => Number.isFinite(value))) return '-'
  return `${left},${top},${width},${height}`
}

/** 缩进成 UIA 树的形状（`uia` 的可读输出；`--json` 另有结构）。 */
export function treePrefix(level) {
  const depth = Number.isFinite(level) && level > 0 ? Math.trunc(level) : 0
  return '  '.repeat(depth)
}

/**
 * 快照作用域的一行文本（`SNAPSHOT_SCOPE=`）。
 *
 * 为什么必须打出来：元素 id 是 UIA runtime id 的哈希，**只在取它的那次遍历里稳定**。
 * 真机缺陷就是在桌面根上取了 id、紧接着 `invoke` 时根遍历在 3000 个元素处截断而找不到它
 * （11/11 全失败）。看不到作用域，就没法判断"找不到"是元素没了、还是作用域换了、还是被截断。
 */
export function snapshotScopeText(scope = {}) {
  const hwnd = scope.hwnd
  const parts = [`hwnd=${hwnd === undefined || hwnd === null || hwnd === '' ? 'desktop-root' : hwnd}`]
  if (scope.name !== undefined && scope.name !== null && scope.name !== '') parts.push(`name=${scope.name}`)
  if (Number.isFinite(scope.depth)) parts.push(`depth=${scope.depth}`)
  if (Number.isFinite(scope.limit)) parts.push(`limit=${scope.limit}`)
  if (scope.truncated === true) parts.push('truncated=true')
  return parts.join(' ')
}

/**
 * 该用哪个 pattern 做语义操作。返回 `{pattern, args, why}` 或 `{error}`。
 * **不支持的 pattern 一律报错**，绝不退化成坐标点击（除非调用方另走 --fallback-point）。
 */
export function chooseAction(element, opts = {}) {
  const patterns = patternList(element?.patterns)
  const has = (name) => patterns.includes(name)
  const setName = opts.setValue !== undefined
  if (setName) {
    if (!has('ValuePattern')) {
      return {
        error:
          `该元素不支持 ValuePattern（可用：${patternsText(patterns)}）；--set-value 只能对可写元素用，` +
          '本模块不会退化成"点进去再输入"',
      }
    }
    return { pattern: 'ValuePattern', args: { value: String(opts.setValue) }, why: '元素自带 ValuePattern.SetValue' }
  }
  if (has('InvokePattern')) return { pattern: 'InvokePattern', args: {}, why: '元素自带 InvokePattern' }
  if (has('TogglePattern')) return { pattern: 'TogglePattern', args: {}, why: '元素自带 TogglePattern（无 Invoke）' }
  if (has('SelectionItemPattern')) {
    return { pattern: 'SelectionItemPattern', args: {}, why: '元素自带 SelectionItemPattern（无 Invoke/Toggle）' }
  }
  if (has('ExpandCollapsePattern')) {
    return { pattern: 'ExpandCollapsePattern', args: {}, why: '元素自带 ExpandCollapsePattern（无 Invoke/Toggle/SelectionItem）' }
  }
  return {
    error:
      `该元素没有任何可用的语义 pattern（可用：${patternsText(patterns)}）；` +
      '它可能只是个容器。要改用坐标点击请显式加 --fallback-point',
  }
}
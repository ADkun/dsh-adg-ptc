// 坐标换算的纯函数层 —— 本模块最容易出错、也最值得单测的一块。
//
// 契约（design.md 的 I1–I4）：
//   * 对外所有坐标 = **真实物理像素**。为做到这点，原生层进程启动就声明
//     PerMonitorV2（`scripts/bridge.ps1` 的 Initialize-Dpi）；不声明的话系统会把坐标
//     虚拟化（本机实测 1707x1067 vs 真实 2560x1600，系数 1.5）。
//   * SendInput 的鼠标绝对模式不吃物理像素，它吃**归一化到 0..65535 的虚拟屏坐标**，
//     且虚拟屏原点可能为负（副屏在主屏左边/上边时 virtualLeft/Top 是负数）。
//   * 归一化分母是 `虚拟屏尺寸 - 1`（微软文档的口径：65535 映射到虚拟屏最右下那个像素）。
//     这一处若写成 `虚拟屏尺寸`，在 2560 宽的屏上会偏 1 像素，且越靠右下偏得越多。

/** 归一化坐标的取值范围；由 SendInput 的绝对模式约定死，不是可调参数。 */
export const NORMALIZED_MAX = 65535

function toInt(value, name) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10)
  if (!Number.isFinite(number)) throw new Error(`${name} 不是整数：${value}`)
  return Math.trunc(number)
}

/**
 * 一个虚拟屏描述。`originX/originY` 可为负（副屏在主屏左上时）。
 * 尺寸必须 ≥ 1，否则说明宿主还没声明 DPI 感知、拿到的是一组不可用的读数。
 */
export function screenBox(input = {}) {
  const box = {
    originX: toInt(input.originX ?? input.virtualLeft ?? 0, 'originX'),
    originY: toInt(input.originY ?? input.virtualTop ?? 0, 'originY'),
    width: toInt(input.width ?? input.virtualWidth, 'width'),
    height: toInt(input.height ?? input.virtualHeight, 'height'),
  }
  if (box.width < 1 || box.height < 1) {
    throw new Error(`虚拟屏尺寸非法：${box.width}x${box.height}（宿主可能没声明 DPI 感知）`)
  }
  return box
}

/** 物理坐标 → 归一化绝对坐标。返回 `{dx, dy, clamped, inside}`。越界会被夹到 0..65535 并标记 clamped。 */
export function toAbsolute(point, box) {
  const screen = screenBox(box)
  const x = toInt(point?.x, 'x')
  const y = toInt(point?.y, 'y')
  const rawX = ((x - screen.originX) * NORMALIZED_MAX) / (screen.width - 1)
  const rawY = ((y - screen.originY) * NORMALIZED_MAX) / (screen.height - 1)
  const dx = Math.round(rawX)
  const dy = Math.round(rawY)
  const clampedX = Math.min(NORMALIZED_MAX, Math.max(0, dx))
  const clampedY = Math.min(NORMALIZED_MAX, Math.max(0, dy))
  return {
    dx: clampedX,
    dy: clampedY,
    clamped: clampedX !== dx || clampedY !== dy,
    inside: insideScreen({ x, y }, screen),
  }
}

/** 归一化绝对坐标 → 物理坐标（往返用；`point` 与 `verify` 的坐标核对靠它）。 */
export function fromAbsolute(normalized, box) {
  const screen = screenBox(box)
  const dx = toInt(normalized?.dx, 'dx')
  const dy = toInt(normalized?.dy, 'dy')
  if (dx < 0 || dx > NORMALIZED_MAX) throw new Error(`dx 越界：${dx}`)
  if (dy < 0 || dy > NORMALIZED_MAX) throw new Error(`dy 越界：${dy}`)
  return {
    x: screen.originX + Math.round((dx * (screen.width - 1)) / NORMALIZED_MAX),
    y: screen.originY + Math.round((dy * (screen.height - 1)) / NORMALIZED_MAX),
  }
}

/** 点是否落在虚拟屏内（含负原点）。闭区间：右下边界那个像素算在内。 */
export function insideScreen(point, box) {
  const screen = screenBox(box)
  const x = toInt(point?.x, 'x')
  const y = toInt(point?.y, 'y')
  return (
    x >= screen.originX &&
    x <= screen.originX + screen.width - 1 &&
    y >= screen.originY &&
    y <= screen.originY + screen.height - 1
  )
}

/**
 * 请求的截图区域 → 实际可截的区域。虚拟屏外的部分被夹掉，并标记 `clamped`
 * （`screen --region` 用它；越界不报错但必须如实说被夹过）。
 */
export function clampRegion(region, box) {
  const screen = screenBox(box)
  const left = toInt(region?.left, 'left')
  const top = toInt(region?.top, 'top')
  const width = toInt(region?.width, 'width')
  const height = toInt(region?.height, 'height')
  if (width < 1 || height < 1) throw new Error(`区域尺寸非法：${width}x${height}`)
  const minLeft = screen.originX
  const minTop = screen.originY
  const maxRight = screen.originX + screen.width
  const maxBottom = screen.originY + screen.height
  const newLeft = Math.max(left, minLeft)
  const newTop = Math.max(top, minTop)
  const newRight = Math.min(left + width, maxRight)
  const newBottom = Math.min(top + height, maxBottom)
  return {
    left: newLeft,
    top: newTop,
    width: Math.max(newRight - newLeft, 1),
    height: Math.max(newBottom - newTop, 1),
    clamped: newLeft !== left || newTop !== top || newRight !== left + width || newBottom !== top + height,
  }
}

/**
 * `l,t,w,h` → `{left, top, width, height}`；空串/`-`/`null` 一律给 `null`（**不猜**）。
 * 供几何自洽检查用：桥回来的矩形是字符串，比较得先成形。
 */
export function parseRect(text) {
  if (text === undefined || text === null) return null
  const raw = String(text).trim()
  if (raw === '' || raw === '-') return null
  const parts = raw.split(',').map((chunk) => Number.parseInt(chunk.trim(), 10))
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null
  return { left: parts[0], top: parts[1], width: parts[2], height: parts[3] }
}

/** 两个矩形是否一致（逐边差值都在 `tolerance` 内）。任一侧是 `null` 时返回 `null`（未知，不是"不一致"）。 */
export function rectsAgree(left, right, tolerance = 2) {
  const a = typeof left === 'string' ? parseRect(left) : left
  const b = typeof right === 'string' ? parseRect(right) : right
  if (a === null || b === null) return null
  const slack = Math.abs(Math.trunc(tolerance))
  const edges = ['left', 'top', 'width', 'height']
  return edges.every((edge) => Math.abs(a[edge] - b[edge]) <= slack)
}

/** 点是否落在矩形内（可放宽 `tolerance` 像素）。矩形为 `null` 时返回 `null`。 */
export function rectContains(rect, point, tolerance = 0) {
  const box = typeof rect === 'string' ? parseRect(rect) : rect
  if (box === null) return null
  const x = toInt(point?.x, 'x')
  const y = toInt(point?.y, 'y')
  const slack = Math.abs(Math.trunc(tolerance))
  return (
    x >= box.left - slack &&
    x <= box.left + box.width + slack &&
    y >= box.top - slack &&
    y <= box.top + box.height + slack
  )
}

/**
 * 几何自洽检查的判定（`bridge` 的 `Get-GeoCheck` 给读数，判定在这一层，好单测）。
 *
 * 为什么需要它（真机实测，design.md I2b）：目标窗口**最大化**时，`windows` 报的是
 * `-11,-11,2582,1550`，而同一时刻 `uia` 给出的子元素矩形是另一套坐标系里的值；按 `uia`
 * 那组算出来的坐标点下去，落到了别的控件上（`ELEMENT_TYPE=Edit`），动作白做还报 false。
 * 两套"这个窗口/这个元素在哪"的读数**必须互相印证**，才允许按坐标注入。
 *
 * 返回 `{mismatch: 'true'|'false'|'unknown', reasons: [...]}`：
 *   * `true`  —— 至少一条读数明确矛盾（两个条件任一为 false）；
 *   * `false` —— **两条读数都取到了、而且都印证**；
 *   * `unknown` —— **任一条读数缺失**（UIA 不可用 / provider 不给矩形 / 这次没有查询点），
 *     **不许当成"一致"**。
 *
 * 三条的边界是"缺测绝不能被读成一致"：写成 `rootAgrees === true || pointInside === true` 会让
 * **只拿到一条读数**也返回 `false` —— 那等于把"没量到"冒充成"量过且对得上"，与本模块的三态判据
 * （I7b / design.md I2b）同一条口径。所以 `false` 只在两个条件都严格为 `true` 时给。
 *
 * `opts.requirePoint === false` 是唯一的例外，只给"这一路本来就没有查询点"的调用方用
 * （`uia --hwnd`：它只看树、不点任何地方 ⇒ 落点那条读数**不适用**，不是"缺测"），
 * 此时只看根矩形那一半，`reasons` 里会写明这次没查落点。默认是 `true`。
 */
export function geoVerdict(geo, opts = {}) {
  const requirePoint = opts.requirePoint !== false
  const source = geo && typeof geo === 'object' ? geo : {}
  const reasons = []
  const rootAgrees = source.rootRectMatches
  const pointInside = source.pointInElementRect
  if (rootAgrees === false) {
    reasons.push(
      `窗口矩形与 UIA 根元素矩形不一致（Win32=${source.winRect || '-'}，UIA=${source.uiaRootRect || '-'}）`,
    )
  }
  if (requirePoint && pointInside === false) {
    reasons.push(
      `请求点上的 UIA 元素自身矩形并不包含该点（元素矩形=${source.pointRect || '-'}）` +
        '——说明 uia 的矩形与物理坐标不在同一坐标系，按 uia 矩形换算出来的坐标可能打空',
    )
  }
  if (reasons.length > 0) return { mismatch: 'true', reasons }
  if (rootAgrees === true && (!requirePoint || pointInside === true)) {
    return {
      mismatch: 'false',
      reasons: requirePoint ? reasons : ['这一路没有查询点，所以只验了窗口矩形与 UIA 根元素矩形一致'],
    }
  }
  const missing = []
  if (rootAgrees !== true) missing.push('窗口矩形与 UIA 根元素矩形这次没有互相印证')
  if (requirePoint && pointInside !== true) {
    missing.push('请求点上的 UIA 元素矩形这次拿不到（没有查询点，或 provider 不给矩形）')
  }
  const note = typeof source.note === 'string' ? source.note.trim() : ''
  return {
    mismatch: 'unknown',
    reasons: [
      `几何读数不全，所以只能说"不知道"（${missing.join('；')}）` + (note === '' ? '' : `；note=${note}`),
    ],
  }
}

/** 150% 缩放的显示：拿到的虚拟化读数 × 缩放系数 = 物理像素。只在报告里当对照用，**不参与换算**。 */
export function dpiScale(physicalWidth, virtualWidth) {
  const physical = toInt(physicalWidth, 'physicalWidth')
  const virt = toInt(virtualWidth, 'virtualWidth')
  if (virt < 1) throw new Error(`虚拟化宽度非法：${virt}`)
  return Math.round((physical / virt) * 1000) / 1000
}
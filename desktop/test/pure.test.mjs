// 纯函数层单测：坐标换算、命令解析、元素定位、状态对比、完整性级别判定。
// 全部用假数据 —— 不碰真实桌面、不起子进程、不写文件。

import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'

import {
  BLOCK_HIGHER,
  BLOCK_UNKNOWN,
  CAN_INJECT,
  MIN_NODE_MAJOR,
  SKIP_DRY_RUN,
  dshHome,
  decideInjection,
  envGet,
  installedEntry,
  integrityRank,
  nodeMajor,
  normalizeIntegrity,
  platformVerdict,
  runtimeVerdict,
} from '../lib/env.mjs'
import {
  clampRegion,
  dpiScale,
  fromAbsolute,
  geoVerdict,
  insideScreen,
  parseRect,
  rectContains,
  rectsAgree,
  screenBox,
  toAbsolute,
} from '../lib/coords.mjs'
import {
  allowedFlags,
  assertNoExtra,
  checkFlagScope,
  COMMAND_FLAGS,
  commandOf,
  extraPositionals,
  flagOn,
  hasValue,
  parseArgs,
  requireButton,
  requireInt,
  requirePoint,
  requireText,
  UsageError,
} from '../lib/args.mjs'
import {
  chooseAction,
  elementId,
  fnv1a32,
  isElementId,
  isPlaceholderElementId,
  elementIdentity,
  identityState,
  PLACEHOLDER_ELEMENT_ID,
  patternList,
  patternShapeProblem,
  pickElement,
  patternsText,
  rectText,
  snapshotScopeText,
} from '../lib/elements.mjs'
import {
  INJECTION_CRITERIA,
  changeVerdict,
  checkExpectations,
  compareStates,
  contentKindCount,
  digestOf,
  injectionWarn,
  landingNote,
  landingPreflight,
  neededKinds,
  normalizeKinds,
  parseExpect,
  raiseNoteText,
} from '../lib/verify.mjs'

// 本机实测的三种屏形：主屏 2560x1600 @150%、左上副屏（负原点）、非 DPI 感知拿到的虚拟化读数。
const SCREEN_MAIN = { originX: 0, originY: 0, width: 2560, height: 1600 }
const SCREEN_NEGATIVE = { originX: -1920, originY: -200, width: 4480, height: 1800 }

/** 只留坐标换算里值得单独钉住的四个字段（其余是给报告用的）。 */
function pick(value) {
  return { dx: value.dx, dy: value.dy, clamped: value.clamped, inside: value.inside }
}

test('envGet：Windows 大小写不敏感', () => {
  assert.equal(envGet({ DSH_HOME: 'C:\\x' }, 'DSH_HOME'), 'C:\\x')
  assert.equal(envGet({ dsh_home: 'C:\\x' }, 'DSH_HOME'), 'C:\\x')
  assert.equal(envGet({ DSH_HOME: '' }, 'DSH_HOME'), undefined)
  assert.equal(envGet({}, 'DSH_HOME'), undefined)
  assert.equal(envGet(undefined, 'DSH_HOME'), undefined)
})

test('dshHome / installedEntry：DSH_HOME 优先，否则 ~/.dsh', () => {
  assert.equal(dshHome({ DSH_HOME: 'D:\\home' }, '/x'), 'D:\\home')
  assert.equal(dshHome({}, '/x'), path.join('/x', '.dsh'))
  assert.equal(installedEntry({ DSH_HOME: 'C:\\Users\\a\\.dsh' }, '/x').endsWith('desktop\\cli.mjs'), true)
})

test('nodeMajor / runtimeVerdict：版本不够就明确报错', () => {
  assert.equal(nodeMajor('22.1.0'), 22)
  assert.equal(nodeMajor('26.10.0'), 26)
  assert.equal(nodeMajor('nonsense'), undefined)
  assert.equal(runtimeVerdict(`${MIN_NODE_MAJOR}.0.0`), null)
  assert.match(runtimeVerdict('20.11.0'), /需要 Node >= 22/)
})

test('normalizeIntegrity：只认六档，其余一律 unknown', () => {
  assert.equal(normalizeIntegrity('low'), 'low')
  assert.equal(normalizeIntegrity('Medium'), 'medium')
  assert.equal(normalizeIntegrity('4096'), 'low')
  assert.equal(normalizeIntegrity('low (4096)'), 'low')
  assert.equal(normalizeIntegrity('high(12288)'), 'high')
  assert.equal(normalizeIntegrity('unknown'), 'unknown')
  assert.equal(normalizeIntegrity(''), 'unknown')
  assert.equal(normalizeIntegrity(undefined), 'unknown')
  assert.equal(normalizeIntegrity('weird'), 'unknown')
})

test('integrityRank：未知不是最低档（返回 undefined，不许当 0）', () => {
  assert.equal(integrityRank('untrusted'), 0)
  assert.equal(integrityRank('low'), 1)
  assert.equal(integrityRank('medium'), 2)
  assert.equal(integrityRank('high'), 3)
  assert.equal(integrityRank('unknown'), undefined)
  assert.equal(integrityRank('medium') > integrityRank('low'), true)
})

test('decideInjection：干跑、同级、更高、不可读四种情形', () => {
  const dry = decideInjection({ dryRun: true, ours: 'low', target: 'high' })
  assert.equal(dry.action, 'dry-run')
  assert.equal(dry.code, SKIP_DRY_RUN)

  const same = decideInjection({ ours: 'low', target: 'low' })
  assert.equal(same.action, 'inject')
  assert.equal(same.code, CAN_INJECT)

  const lower = decideInjection({ ours: 'medium', target: 'low' })
  assert.equal(lower.action, 'inject')

  const higher = decideInjection({ ours: 'low', target: 'medium' })
  assert.equal(higher.action, 'block')
  assert.equal(higher.code, BLOCK_HIGHER)
  assert.match(higher.reason, /UIPI blocked: target integrity level higher than ours/)

  const unknownTarget = decideInjection({ ours: 'low', target: 'unknown' })
  assert.equal(unknownTarget.action, 'block')
  assert.equal(unknownTarget.code, BLOCK_UNKNOWN)

  const unknownOurs = decideInjection({ ours: undefined, target: 'low' })
  assert.equal(unknownOurs.action, 'block')

  const forced = decideInjection({ ours: 'low', target: 'high', force: true })
  assert.equal(forced.action, 'inject')
  assert.equal(forced.code, 'forced')
})

test('screenBox：拒绝不可用的读数（没声明 DPI 感知时就是这个形状）', () => {
  assert.deepEqual(screenBox({ width: 2560, height: 1600 }), {
    originX: 0,
    originY: 0,
    width: 2560,
    height: 1600,
  })
  assert.throws(() => screenBox({ width: 0, height: 1600 }), /虚拟屏尺寸非法/)
  assert.throws(() => screenBox({ width: 2560, height: -1 }), /虚拟屏尺寸非法/)
  assert.throws(() => screenBox({ width: 'abc', height: 1600 }), /不是整数/)
})

test('toAbsolute：四角与负原点都按「尺寸-1」换算', () => {
  assert.deepEqual(pick(toAbsolute({ x: 0, y: 0 }, SCREEN_MAIN)), { dx: 0, dy: 0, clamped: false, inside: true })
  assert.deepEqual(pick(toAbsolute({ x: 2559, y: 1599 }, SCREEN_MAIN)), {
    dx: 65535,
    dy: 65535,
    clamped: false,
    inside: true,
  })
  // 中点 1280,800：65535*1280/2559 = 32780.0；800 那一维 65535*800/1599 = 32788.0
  assert.deepEqual(pick(toAbsolute({ x: 1280, y: 800 }, SCREEN_MAIN)), {
    dx: 32780,
    dy: 32788,
    clamped: false,
    inside: true,
  })
})

test('toAbsolute：负原点的虚拟屏（副屏在左上）', () => {
  const leftTop = toAbsolute({ x: -1920, y: -200 }, SCREEN_NEGATIVE)
  assert.deepEqual(pick(leftTop), { dx: 0, dy: 0, clamped: false, inside: true })
  const rightBottom = toAbsolute({ x: 2559, y: 1599 }, SCREEN_NEGATIVE)
  assert.deepEqual(pick(rightBottom), { dx: 65535, dy: 65535, clamped: false, inside: true })
})

test('toAbsolute：越界被夹住并标记 clamped/inside=false', () => {
  const out = toAbsolute({ x: -5000, y: 9000 }, SCREEN_MAIN)
  assert.equal(out.clamped, true)
  assert.equal(out.inside, false)
  assert.equal(out.dx, 0)
  assert.equal(out.dy, 65535)
})

test('fromAbsolute：与 toAbsolute 往返（整数像素上恒等）', () => {
  for (const point of [
    { x: 0, y: 0 },
    { x: 1280, y: 800 },
    { x: 2559, y: 1599 },
    { x: 640, y: 480 },
  ]) {
    const normalized = toAbsolute(point, SCREEN_MAIN)
    const back = fromAbsolute(normalized, SCREEN_MAIN)
    assert.equal(back.x, point.x, `x 往返失败：${point.x}`)
    assert.equal(back.y, point.y, `y 往返失败：${point.y}`)
  }
})

test('fromAbsolute：拒绝越界的归一化值', () => {
  assert.throws(() => fromAbsolute({ dx: 65536, dy: 0 }, SCREEN_MAIN), /dx 越界/)
  assert.throws(() => fromAbsolute({ dx: 0, dy: -1 }, SCREEN_MAIN), /dy 越界/)
})

test('insideScreen：闭区间，含负原点', () => {
  assert.equal(insideScreen({ x: 0, y: 0 }, SCREEN_NEGATIVE), true)   // 负原点屏里 (0,0) 是内部点
  assert.equal(insideScreen({ x: -1920, y: -200 }, SCREEN_NEGATIVE), true)
  assert.equal(insideScreen({ x: 2559, y: 1599 }, SCREEN_NEGATIVE), true)
  assert.equal(insideScreen({ x: 2560, y: 1599 }, SCREEN_NEGATIVE), false)
  assert.equal(insideScreen({ x: -1921, y: 0 }, SCREEN_NEGATIVE), false)
  assert.equal(insideScreen({ x: 0, y: 0 }, SCREEN_MAIN), true)
})

test('clampRegion：越界被夹到虚拟屏内并标记 clamped', () => {
  const inside = clampRegion({ left: 100, top: 100, width: 200, height: 200 }, SCREEN_MAIN)
  assert.deepEqual(inside, { left: 100, top: 100, width: 200, height: 200, clamped: false })
  const cross = clampRegion({ left: 2500, top: 1550, width: 200, height: 200 }, SCREEN_MAIN)
  assert.equal(cross.clamped, true)
  assert.deepEqual(
    { left: cross.left, top: cross.top, width: cross.width, height: cross.height },
    { left: 2500, top: 1550, width: 60, height: 50 },
  )
})

test('dpiScale：150% 缩放只作对照，不参与换算', () => {
  assert.equal(dpiScale(2560, 1707), 1.5)
  assert.throws(() => dpiScale(2560, 0), /虚拟化宽度非法/)
})

test('parseArgs：--k=v、--k v、裸 --k、位置参数', () => {
  assert.deepEqual(parseArgs(['windows']), { _: ['windows'] })
  assert.deepEqual(parseArgs(['--x=100']), { _: [], x: '100' })
  assert.deepEqual(parseArgs(['--x', '100']), { _: [], x: '100' })
  assert.deepEqual(parseArgs(['click', '--x', '100', '--y', '-200']), { _: ['click'], x: '100', y: '-200' })
  assert.deepEqual(parseArgs(['--json']), { _: [], json: true })
  assert.deepEqual(parseArgs(['--json', 'windows']), { _: ['windows'], json: true })
  assert.deepEqual(parseArgs(['--text=a b']), { _: [], text: 'a b' })
  assert.deepEqual(parseArgs(['--text', '-abc']), { _: [], text: '-abc' })
  assert.throws(() => parseArgs(['--']), UsageError)
})

test('commandOf / extraPositionals / assertNoExtra', () => {
  const args = parseArgs(['point', '--x', '1', '--y', '2'])
  assert.equal(commandOf(args), 'point')
  assert.deepEqual(extraPositionals(args), [])
  assert.doesNotThrow(() => assertNoExtra(args, 'point'))
  const noisy = parseArgs(['point', 'junk'])
  assert.deepEqual(extraPositionals(noisy), ['junk'])
  assert.throws(() => assertNoExtra(noisy, 'point'), /多余的位置参数/)
})

test('hasValue / flagOn：`--json` 这种布尔写法不算"有值"', () => {
  const args = parseArgs(['--json', '--x', '10', '--text='])
  assert.equal(hasValue(args, 'json'), false)
  assert.equal(flagOn(args, 'json'), true)
  assert.equal(hasValue(args, 'x'), true)
  assert.equal(hasValue(args, 'text'), false)
  assert.equal(flagOn(args, 'nope'), false)
})

test('requireInt：缺值、非数字、越界都抛 UsageError（退出码 2 的来源）', () => {
  assert.equal(requireInt(parseArgs(['--x', '42']), 'x'), 42)
  assert.equal(requireInt(parseArgs(['--x=-7']), 'x'), -7)
  assert.throws(() => requireInt(parseArgs([]), 'x'), /缺少 --x/)
  assert.throws(() => requireInt(parseArgs(['--x', 'abc']), 'x'), /需要整数/)
  assert.throws(() => requireInt(parseArgs(['--x', '1.5']), 'x'), /需要整数/)
  assert.throws(() => requireInt(parseArgs(['--depth', '999']), 'depth', [0, 64]), /不能大于 64/)
  assert.throws(() => requireInt(parseArgs(['--dy', '0']), 'dy', [1, 10]), /不能小于 1/)
  assert.ok(new UsageError('x') instanceof Error)
})

test('requirePoint：允许负坐标，缺一个就报错', () => {
  assert.deepEqual(requirePoint(parseArgs(['--x', '-100', '--y', '50'])), { x: -100, y: 50 })
  assert.throws(() => requirePoint(parseArgs(['--x', '10'])), /缺少 --y/)
})

test('requireText / requireButton', () => {
  assert.equal(requireText(parseArgs(['--keys', 'ctrl+s']), 'keys'), 'ctrl+s')
  assert.throws(() => requireText(parseArgs(['--text=']), 'text'), /缺少 --text/)
  assert.equal(requireButton(parseArgs([])), 'left')
  assert.equal(requireButton(parseArgs(['--button', 'RIGHT'])), 'right')
  assert.throws(() => requireButton(parseArgs(['--button', 'thumb'])), /只能是 left \/ right \/ middle/)
})

test('fnv1a32 / elementId：与 bridge.ps1 的 Get-Fnv1a 同算法同输出', () => {
  // 这几个值同时钉住 Node 侧实现；PowerShell 侧用同一组输入复核（见 testing-guide.md 的 A9）。
  assert.equal(fnv1a32(''), 2166136261)
  assert.equal(fnv1a32('a'), 3826002220)
  assert.equal(fnv1a32('42.1000.7'), 1347465197)
  assert.equal(elementId([42, 1000, 7]), 'el_5050afed')
  assert.equal(elementId([]), 'el_unknown')
  assert.equal(elementId('nope'), 'el_unknown')
  assert.equal(elementId([1]), `el_${fnv1a32('1').toString(16).padStart(8, '0')}`)
})

test('isElementId：只认 el_ + 8 位十六进制（或占位）', () => {
  assert.equal(isElementId('el_ec344354'), true)
  assert.equal(isElementId('el_unknown'), true)
  assert.equal(isElementId('el_EC344354'), false)
  assert.equal(isElementId('el_123'), false)
  assert.equal(isElementId('42'), false)
  assert.equal(isElementId(undefined), false)
})

test('占位 id el_unknown：形状照旧放行，但要能点出"它没有身份"', () => {
  // design.md I6e：el_unknown 不是"某个元素的名字"，而是 GetRuntimeId() 读不到的**整类元素**
  // 折叠出来的同一个字符串。形状闸门必须继续放行它（uia 输出里要看得见、读路径不许把它变成
  // "形状不对"），禁止只发生在"未限定窗口就拿它动手"那一步。
  assert.equal(PLACEHOLDER_ELEMENT_ID, 'el_unknown')
  assert.equal(isPlaceholderElementId('el_unknown'), true)
  assert.equal(isPlaceholderElementId('el_00000001'), false)
  assert.equal(isPlaceholderElementId(undefined), false)
  assert.equal(isElementId(PLACEHOLDER_ELEMENT_ID), true)
})

test('elementIdentity：定位快照给了 runtimeId 才下发；没有就是 absent，绝不凭空造一个', () => {
  assert.deepEqual(elementIdentity({ id: 'el_00000001', runtimeId: '42.1000.7' }), {
    runtimeId: '42.1000.7',
    state: 'checked',
  })
  const withoutIdentity = [
    { id: 'el_unknown', runtimeId: '' },
    { id: 'el_unknown' },
    {},
    undefined,
    { runtimeId: 42 },
    { runtimeId: '   ' },
  ]
  for (const element of withoutIdentity) {
    const identity = elementIdentity(element)
    assert.equal(identity.state, 'absent', `${JSON.stringify(element)} 应当没有身份可下发`)
    assert.equal(identity.runtimeId, undefined, `${JSON.stringify(element)} 不许被造出一个 runtimeId`)
  }
})

test('identityState：桥报不一致 ⇒ mismatch；缺身份时"没报不一致"不许读成 checked', () => {
  const planned = elementIdentity({ runtimeId: '42.1000.7' })
  assert.equal(identityState(planned, { invoked: true }), 'checked')
  assert.equal(identityState(planned, { identityMismatch: true, invoked: false }), 'mismatch')
  assert.equal(identityState(elementIdentity({ runtimeId: '' }), { invoked: true }), 'absent')
  assert.equal(identityState(elementIdentity({}), { identityMismatch: true }), 'mismatch')
  assert.equal(identityState(undefined, { invoked: true }), 'absent')
})

test('pickElement：不许猜 —— 0 个、多个、形状不对、没给条件一律给 reason', () => {
  const elements = [
    { id: 'el_00000001', name: '保存', automationId: 'save' },
    { id: 'el_00000002', name: '保存并关闭', automationId: 'save-close' },
    { id: 'el_00000003', name: '取消', automationId: 'cancel' },
  ]
  assert.equal(pickElement(elements, {}).reason.includes('没给选择条件'), true)
  assert.equal(pickElement(elements, { id: 'el_00000001' }).element.name, '保存')
  const missing = pickElement(elements, { id: 'el_ffffffff' })
  assert.equal(missing.reason.includes('快照里没有'), true)
  // "快照里没有" 不许被写成 "元素不存在"：可能是元素没了、可能是换了作用域、也可能是遍历被截断。
  assert.equal(missing.reason.includes('元素可能已消失'), false)
  assert.match(missing.reason, /可能换了作用域/)
  assert.match(missing.reason, /也可能快照被截断/)
  assert.equal(pickElement(elements, { id: 'save' }).reason.includes('形状不对'), true)
  assert.equal(pickElement(elements, { name: '取消' }).element.id, 'el_00000003')
  assert.equal(pickElement(elements, { name: '保存' }).reason.includes('请改用 --id'), true)
  assert.equal(pickElement(elements, { name: '不存在' }).reason.includes('没有任何元素'), true)
  assert.equal(pickElement([], { id: 'el_00000001' }).reason.includes('快照里没有'), true)
})

test('chooseAction：优先语义 pattern，不支持就报错不退化成坐标点击', () => {
  const invoke = chooseAction({ patterns: ['InvokePattern', 'ValuePattern'] })
  assert.equal(invoke.pattern, 'InvokePattern')
  const value = chooseAction({ patterns: ['ValuePattern'] }, { setValue: 'hi' })
  assert.equal(value.pattern, 'ValuePattern')
  assert.equal(value.args.value, 'hi')
  const noValue = chooseAction({ patterns: ['InvokePattern'] }, { setValue: 'hi' })
  assert.match(noValue.error, /不支持 ValuePattern/)
  const container = chooseAction({ patterns: [] })
  assert.match(container.error, /没有任何可用的语义 pattern/)
  assert.match(container.error, /--fallback-point/)
})

test('patternsText / rectText：空值写 `-` 不写空串', () => {
  assert.equal(patternsText(['InvokePattern']), 'InvokePattern')
  assert.equal(patternsText([]), '-')
  assert.equal(patternsText(undefined), '-')
  assert.equal(rectText({ left: 1, top: 2, width: 3, height: 4 }), '1,2,3,4')
  assert.equal(rectText(null), '-')
  assert.equal(rectText({ left: 1 }), '-')
})

test('compareStates：五类判据各自能触发 CHANGED', () => {
  const base = {
    foreground: '0x1',
    foregroundTitle: 'a',
    windowTitles: ['a', 'b'],
    windowCount: 2,
    point: '0x1',
    pointTitle: 'a',
    pixelHash: 'deadbeef',
  }
  const same = compareStates(base, { ...base })
  assert.equal(same.changed, false)
  assert.deepEqual(same.reasons, [])

  assert.equal(compareStates(base, { ...base, foreground: '0x2' }).changed, true)
  assert.equal(compareStates(base, { ...base, foregroundTitle: 'c' }).changed, true)
  assert.equal(compareStates(base, { ...base, windowTitles: ['a', 'b', 'c'], windowCount: 3 }).changed, true)
  assert.equal(compareStates(base, { ...base, point: '0x9' }).changed, true)
  assert.equal(compareStates(base, { ...base, pixelHash: 'cafebabe' }).changed, true)
  assert.equal(compareStates(base, { ...base, pixelHash: 'cafebabe' }).reasons[0].includes('像素哈希'), true)
})

test('compareStates：标题集合顺序变了也算变了（digest 参与比较）', () => {
  const a = { windowTitles: ['x', 'y'], windowCount: 2 }
  const b = { windowTitles: ['y', 'x'], windowCount: 2 }
  assert.equal(compareStates(a, b).changed, true)
})

test('compareStates：UIA 内容快照也算一类判据（文本框内容/滚动位置）', () => {
  const base = { contentHash: 'aaaa', contentBearingCount: 3 }
  const same = compareStates(base, { ...base })
  assert.equal(same.changed, false)
  const moved = compareStates(base, { ...base, contentHash: 'bbbb' })
  assert.equal(moved.changed, true)
  assert.equal(moved.reasons[0].includes('UI 内容'), true)
  // --no-pixel 那一路会显式忽略 content（它读的就是 UIA，不是在看你有没有屏幕）
  assert.equal(compareStates(base, { ...base, contentHash: 'bbbb' }, { ignore: ['content'] }).changed, false)
})

test('changeVerdict 三态：看得见没变 ⇒ false；看不见 ⇒ unknown，绝不把"我看不见"报成 false', () => {
  // ① 有差异永远 true，跟可不可见无关。
  assert.equal(changeVerdict({ changed: true, reasons: ['x'] }).changed, 'true')
  assert.equal(changeVerdict({ changed: true }).reason, '')
  // ② 捕获到了像素区域：确实"看见了这一类动作的效果范围"，没变就是没变。
  assert.equal(
    changeVerdict({ changed: false, before: { pixelHash: 'deadbeef' }, after: { pixelHash: 'deadbeef' } }).changed,
    'false',
  )
  // ③ 没有像素、但读到了 UIA 内容属性（Value / selection / scroll …）：也属于"看得见"。
  assert.equal(
    changeVerdict({ changed: false, before: { contentBearingCount: 2 }, after: { contentBearingCount: 2 } }).changed,
    'false',
  )
  // ④ 两者都没有 —— 这次动作的效果本来就落在判据覆盖之外。报 false 会把成功说成失败
  //    （真机实测：type/key/scroll 都报过 false，而靶侧日志与独立 UIA 读回都证明生效；
  //    反过来 --double 报过 true 而靶侧只数到一次点击）。
  for (const opts of [{}, { noPixel: true }]) {
    const blind = changeVerdict({ changed: false, before: {}, after: {} }, opts)
    assert.equal(blind.changed, 'unknown')
    assert.match(blind.reason, /没看到差异 ≠ 动作没生效/)
    assert.match(blind.reason, /--expect/)
  }
  // ⑤ --no-pixel 只是"这次没抓像素"，不是"可以忽略内容读数"。
  assert.equal(
    changeVerdict({ changed: false, before: { contentBearingCount: 1 }, after: { contentBearingCount: 1 } }, { noPixel: true })
      .changed,
    'false',
  )
})

test('snapshotScopeText：作用域必须看得见，不给 --hwnd 时如实写 desktop-root', () => {
  assert.equal(snapshotScopeText({ depth: 16, limit: 3000 }), 'hwnd=desktop-root depth=16 limit=3000')
  assert.equal(snapshotScopeText({ hwnd: '0xc20844', depth: 6, limit: 500 }), 'hwnd=0xc20844 depth=6 limit=500')
  assert.equal(snapshotScopeText({ hwnd: '', name: 'DSH', depth: 16, limit: 3000 }), 'hwnd=desktop-root name=DSH depth=16 limit=3000')
  // 截断状态是作用域的一部分：它决定"找不到"能不能解释成"不存在"。
  assert.equal(snapshotScopeText({ depth: 16, limit: 3, truncated: true }), 'hwnd=desktop-root depth=16 limit=3 truncated=true')
})

test('normalizeState / digestOf：缺字段补空串，不补猜的值', () => {
  const digest = digestOf({})
  assert.equal(digest.includes('fg=-'), true)
  assert.equal(digest.includes('windows=0'), true)
  assert.equal(digestOf({ windowTitles: ['a'] }).includes('windows=1'), true)
})

test('parseExpect：形状与键名都校验', () => {
  assert.deepEqual(parseExpect('changed=true;window_count=3'), [
    { key: 'changed', value: 'true' },
    { key: 'window_count', value: '3' },
  ])
  assert.deepEqual(parseExpect(''), [])
  assert.throws(() => parseExpect('changed'), /k=v/)
  assert.throws(() => parseExpect('nope=1'), /不认识的键/)
})

test('checkExpectations：逐条判定，全中才 ok', () => {
  const result = compareStates({}, { foreground: '0x1', windowCount: 2, pixelHash: 'aa' })
  const hit = checkExpectations(parseExpect('changed=true;window_count=2'), result)
  assert.equal(hit.ok, true)
  assert.equal(hit.rows.length, 2)
  const miss = checkExpectations(parseExpect('window_count=3'), result)
  assert.equal(miss.ok, false)
  assert.equal(miss.rows[0].actual, '2')
})

test('injectionWarn：说明现象、附现场读数，且明确"返回不能当证据"', () => {
  const warn = injectionWarn({ changed: false }, { targetIntegrity: 'medium', oursIntegrity: 'low', inserted: 6, lastError: 0 })
  assert.match(warn, /CHANGED=false/)
  assert.match(warn, /静默/)
  assert.match(warn, /已插入 6 个事件/)
  assert.match(warn, /medium/)
  assert.equal(injectionWarn({ changed: true }), undefined)
})

test('platformVerdict：Windows 上放行，非 Windows 明确报错（不降级）', () => {
  assert.equal(platformVerdict('win32'), null)
  for (const other of ['linux', 'darwin', 'freebsd']) {
    const reason = platformVerdict(other)
    assert.equal(typeof reason, 'string')
    assert.match(reason, /Windows 专用/)
    assert.match(reason, new RegExp(other))
  }
})

test('--raise / --no-pixel / --hash 是布尔开关，不吞下一个 token', () => {
  assert.deepEqual(parseArgs(['click', '--raise', '--x', '10', '--y', '20']), {
    _: ['click'],
    raise: true,
    x: '10',
    y: '20',
  })
  assert.equal(flagOn(parseArgs(['--raise']), 'raise'), true)
  assert.equal(flagOn(parseArgs(['--no-pixel']), 'no-pixel'), true)
  assert.equal(flagOn(parseArgs(['screen', '--hash']), 'hash'), true)
  assert.equal(hasValue(parseArgs(['--raise']), 'raise'), false)
  assert.equal(hasValue(parseArgs(['screen', '--hash']), 'hash'), false)
})

test('必有值的开关缺值时报用法错，不静默变 true', () => {
  // 裸 `--limit` 后面跟着另一个开关（或到头）：以前会静默变成 `true`，错误要到坐标层才炸，
  // 报错点离用户的输入太远。现在由 REQUIRES_VALUE 这一份清单当场判定。
  for (const key of ['clicks', 'limit', 'timeout', 'depth', 'settle', 'dy', 'x', 'y', 'id', 'out', 'text', 'keys']) {
    assert.throws(() => parseArgs(['uia', `--${key}`, '--json']), UsageError, `--${key} 缺值应当抛 UsageError`)
    assert.throws(() => parseArgs(['uia', `--${key}`]), UsageError, `--${key} 在末尾缺值应当抛 UsageError`)
  }
  // 有值时照常收下，且不吞掉后面那个开关
  const parsed = parseArgs(['uia', '--limit', '5', '--json'])
  assert.equal(parsed.limit, '5')
  assert.equal(flagOn(parsed, 'json'), true)
})

test('patternList：标量当单元素列表（单 pattern 塌成标量的回归）', () => {
  assert.deepEqual(patternList('InvokePattern'), ['InvokePattern'])
  assert.deepEqual(patternList(['ValuePattern', 'TextPattern']), ['ValuePattern', 'TextPattern'])
  assert.deepEqual(patternList([]), [])
  assert.deepEqual(patternList(undefined), [])
  assert.deepEqual(patternList(null), [])
  assert.deepEqual(patternList(42), [])
  assert.deepEqual(patternList(['', 'InvokePattern']), ['InvokePattern'])
})

test('patternsText：单 pattern 的标量输入也要显示出来（不能给 "-"）', () => {
  assert.equal(patternsText('InvokePattern'), 'InvokePattern')
  assert.equal(patternsText(['InvokePattern']), 'InvokePattern')
  assert.equal(patternsText(['ValuePattern', 'TextPattern']), 'ValuePattern,TextPattern')
  assert.equal(patternsText([]), '-')
  assert.equal(patternsText(undefined), '-')
})

test('patternShapeProblem：坏形状必须报出来，不许被 patternList 静默吞掉', () => {
  // 正常形状（含"真的一个 pattern 都没有"）⇒ 不报
  assert.equal(patternShapeProblem([]), null)
  assert.equal(patternShapeProblem(['InvokePattern']), null)
  assert.equal(patternShapeProblem(['ValuePattern', 'TextPattern']), null)
  assert.equal(patternShapeProblem(undefined), null)
  assert.equal(patternShapeProblem(null), null)

  // 缺陷一：单元素被拆包成裸字符串（`{"patterns":"InvokePattern"}`）
  assert.match(patternShapeProblem('InvokePattern'), /裸字符串/)

  // 缺陷二：两层包装叠在一起（`{"patterns":[["InvokePattern"]]}`）—— P0-B 的真实形态。
  // 这一条是关键：patternList() 对它会返回 []（与"没有 pattern"同形），所以只有独立
  // 的形状检查才能把它暴露成一行 WARN 而不是一个看似正常的结果。
  assert.match(patternShapeProblem([['InvokePattern']]), /嵌着 1 个数组/)
  assert.match(patternShapeProblem([[], []]), /嵌着 2 个数组/)

  // 缺陷三：非字符串项 / 根本不是数组
  assert.match(patternShapeProblem([42]), /非字符串项/)
  assert.match(patternShapeProblem(42), /既不是数组也不是字符串/)

  // 交叉验证：坏形状确实会被 patternList 吞成空列表 —— 这正是需要独立检查的理由
  assert.deepEqual(patternList([['InvokePattern']]), [])
  assert.deepEqual(patternList([]), [])
})

test('chooseAction：宿主把单 pattern 回成标量时，语义操作仍然可选', () => {
  // 桥侧曾回 `{"patterns":"InvokePattern"}`，导致这两个判空函数双双判空、
  // `invoke --id` 对只支持一种 pattern 的按钮一律 exit 2。
  const scalar = chooseAction({ patterns: 'InvokePattern' })
  assert.equal(scalar.pattern, 'InvokePattern')
  assert.equal(scalar.error, undefined)

  const one = chooseAction({ patterns: ['InvokePattern'] })
  assert.equal(one.pattern, 'InvokePattern')

  const none = chooseAction({ patterns: 'Pane' })
  assert.equal(none.pattern, undefined)
  assert.match(none.error, /没有任何可用的语义 pattern/)
  assert.match(none.error, /可用：Pane/)
})

test('landingNote：比顶层窗口，指针落在目标内部的小控件上也算命中', () => {
  const target = { hwnd: '0x2150ad4', rootHwnd: '0x2150ad4' }
  const inside = landingNote(
    { point: '0x3106ea', pointRootHwnd: '0x2150ad4', pointLanded: true },
    target,
    { x: 600, y: 400 },
  )
  assert.equal(inside.inTarget, true)
  assert.equal(inside.landed, true)
  assert.match(inside.note, /在目标内=true/)

  const outside = landingNote({ point: '0xdead', pointRootHwnd: '0xbeef', pointLanded: true }, target, { x: 1, y: 1 })
  assert.equal(outside.inTarget, false)
  assert.match(outside.note, /在目标内=false/)

  // 没有目标窗口时给 `null`（输出层渲染成 `-`），不假装判定过
  const unknown = landingNote({ point: '0x1', pointRootHwnd: '0x1' }, null, { x: 0, y: 0 })
  assert.equal(unknown.inTarget, null)
})

// ── 第五轮：几何自洽（I2b）、按命令的判据（I7f）、落点归属要有显式目标（I7g） ──────────────

test('parseRect：只认 `l,t,w,h`，读不到一律 null（不许猜成 0,0,0,0）', () => {
  assert.deepEqual(parseRect('240,120,560,620'), { left: 240, top: 120, width: 560, height: 620 })
  assert.deepEqual(parseRect('-11,-11,2582,1550'), { left: -11, top: -11, width: 2582, height: 1550 })
  for (const bad of ['', '-', null, undefined, '240,120,560', 'a,b,c,d']) {
    assert.equal(parseRect(bad), null, `parseRect(${JSON.stringify(bad)}) 应该是 null`)
  }
})

test('rectsAgree：容差内算一致，差一点就算矛盾，缺读数给 null（不知道 ≠ 一致）', () => {
  const win = { left: -11, top: -11, width: 2582, height: 1550 }
  assert.equal(rectsAgree(win, { left: -10, top: -11, width: 2583, height: 1550 }), true)
  assert.equal(rectsAgree(win, { left: 240, top: 120, width: 560, height: 620 }), false)
  assert.equal(rectsAgree(win, null), null)
  assert.equal(rectsAgree(null, win), null)
})

test('rectContains：闭区间；矩形拿不到给 null', () => {
  const r = { left: 240, top: 120, width: 560, height: 620 }
  assert.equal(rectContains(r, { x: 240, y: 120 }), true)
  assert.equal(rectContains(r, { x: 800, y: 740 }), true)
  assert.equal(rectContains(r, { x: 801, y: 740 }), false)
  assert.equal(rectContains(r, { x: 239, y: 400 }), false)
  assert.equal(rectContains(null, { x: 1, y: 1 }), null)
})

test('geoVerdict 三态：矛盾 ⇒ true；都对上 ⇒ false；读数不够 ⇒ unknown（不是一致）', () => {
  const agree = geoVerdict({ rootRectMatches: true, pointInElementRect: true })
  assert.equal(agree.mismatch, 'false')
  assert.deepEqual(agree.reasons, [])

  // 真机踩过的坑：最大化窗口下 `windows` 与 `uia` 两套矩形互不相容 ⇒ 按 uia 那组点会打空
  const clash = geoVerdict({ rootRectMatches: false, pointInElementRect: true, winRect: '-11,-11,2582,1550', uiaRootRect: '30,49,160,50' })
  assert.equal(clash.mismatch, 'true')
  assert.match(clash.reasons.join(' '), /窗口矩形与 UIA 根元素矩形不一致/)
  assert.match(clash.reasons.join(' '), /-11,-11,2582,1550/)
  assert.match(clash.reasons.join(' '), /30,49,160,50/)

  const missPoint = geoVerdict({ rootRectMatches: true, pointInElementRect: false, pointRect: '30,49,160,50' })
  assert.equal(missPoint.mismatch, 'true')
  assert.match(missPoint.reasons.join(' '), /并不包含该点/)

  // 两套读数都拿不到（受限会话 FromPoint 被拒就是这一支）⇒ unknown，不许当成"几何一致"
  const noRead = geoVerdict({ rootRectMatches: null, pointInElementRect: null })
  assert.equal(noRead.mismatch, 'unknown')
  assert.match(noRead.reasons.join(' '), /几何读数不全/)

  // **只拿到一条读数也算缺测**：落点那条拿不到（受限会话里 FromPoint 被拒）⇒ unknown。
  // 这一支曾经写成 `rootAgrees === true || pointInside === true` 而返回 false —— 那正是
  // 把"没量到"冒充成"量过且对得上"，与本模块的三态口径相反。
  const onlyRoot = geoVerdict({ rootRectMatches: true, pointInElementRect: null })
  assert.equal(onlyRoot.mismatch, 'unknown')
  assert.match(onlyRoot.reasons.join(' '), /请求点上的 UIA 元素矩形这次拿不到/)

  // 唯一例外：`uia --hwnd` 这一路本来就没有查询点，落点那条**不适用**（不是缺测）⇒ 只看根矩形，
  // 且 reasons 里必须写明这次没查落点，别让读者以为两条都验过。
  const uiaRoute = geoVerdict({ rootRectMatches: true, pointInElementRect: null }, { requirePoint: false })
  assert.equal(uiaRoute.mismatch, 'false')
  assert.match(uiaRoute.reasons.join(' '), /这一路没有查询点/)

  // requirePoint:false 也不能把"根矩形本身没对上/没读到"洗成 false
  assert.equal(geoVerdict({ rootRectMatches: null, pointInElementRect: null }, { requirePoint: false }).mismatch, 'unknown')
  assert.equal(geoVerdict({ rootRectMatches: false, pointInElementRect: null }, { requirePoint: false }).mismatch, 'true')
})

test('raiseNoteText：桥的文本优先，未知标记原样透出，空文本才回退中文常量', () => {
  const zh = '中文解释'
  // ① 已知标记 + 中文：两个都要在，且桥的原文（带原因）不许被丢掉
  const marked = raiseNoteText('raise-ignored-no-target: --raise needs --x/--y', zh)
  assert.match(marked, /raise-ignored-no-target/)
  assert.match(marked, /--raise needs --x\/--y/)
  assert.match(marked, /中文解释/)
  // ② 桥没给文本 ⇒ 回退中文常量（早先的恒打行为只保留在这一支）
  assert.equal(raiseNoteText('', zh), zh)
  assert.equal(raiseNoteText(undefined, zh), zh)
  assert.equal(raiseNoteText('   ', zh), zh)
  // ③ 桥给了别的文本 ⇒ 原样透出，不硬塞中文
  assert.equal(raiseNoteText('some-other-reason: x', zh), 'some-other-reason: x')
  // ④ 两边都空 ⇒ 空串（调用方按空串决定要不要打这条 WARN）
  assert.equal(raiseNoteText('', ''), '')
})

test('neededKinds / INJECTION_CRITERIA：scroll 只认滚动位置，type 认 Value，key 认五类', () => {
  assert.deepEqual(neededKinds('scroll'), ['scroll'])
  assert.deepEqual(neededKinds('type'), ['value'])
  assert.deepEqual(neededKinds('key'), ['value', 'selected', 'toggle', 'scroll', 'rangeValue'])
  assert.deepEqual(neededKinds('click'), [])
  assert.deepEqual(neededKinds('move'), [])
  assert.deepEqual(neededKinds(undefined), [])
  // 返回的是副本：调用方改了不许污染常量表
  const copy = neededKinds('scroll')
  copy.push('value')
  assert.deepEqual(INJECTION_CRITERIA.scroll, ['scroll'])
})

test('normalizeKinds / contentKindCount：六个键恒在，ancestorScroll 不重复计数', () => {
  const kinds = normalizeKinds({ value: 2, scroll: 1, bogus: 9 })
  assert.deepEqual(kinds, { value: 2, scroll: 1, rangeValue: 0, toggle: 0, selected: 0, ancestorScroll: 0 })
  // 桥侧已经把祖先链上的滚动读数计进 `scroll`，ancestorScroll 是子集标记 ⇒ 正常情况不叠加
  assert.equal(contentKindCount({ contentKinds: { scroll: 2, ancestorScroll: 1 } }, 'scroll'), 2)
  // 只有子集标记有值时（万一桥只报了子集）回退到它，判"这一类有没有读数"不会漏
  assert.equal(contentKindCount({ contentKinds: { ancestorScroll: 3 } }, 'scroll'), 3)
  assert.equal(contentKindCount({}, 'scroll'), 0)
  assert.equal(contentKindCount({}, 'value'), 0)
})

test('changeVerdict：需要的那一类读数两端都为 0 ⇒ unknown（哪怕像素在），读到且没变才 false', () => {
  const base = {
    foreground: '0x1',
    titles: 'x',
    pixelHash: 'abc',
    contentBearingCount: 0,
    contentProbeFailed: false,
    contentKinds: {},
  }
  // 像素在、但 scroll 那一类读不到 ⇒ 不许报 false（这正是 scroll 假阴性的结构）
  const blind = changeVerdict(
    { changed: false, before: base, after: { ...base, pixelHash: 'abc' } },
    { needsKinds: neededKinds('scroll') },
  )
  assert.equal(blind.changed, 'unknown')
  assert.match(blind.reason, /「scroll」这类读数/)
  assert.match(blind.reason, /CHANGED=unknown（不是 false）/)

  // 读到了滚动位置、而且确实没变 ⇒ 这才是有资格的 false
  const seen = changeVerdict(
    {
      changed: false,
      before: { ...base, contentKinds: { scroll: 1, ancestorScroll: 1 } },
      after: { ...base, contentKinds: { scroll: 1, ancestorScroll: 1 } },
    },
    { needsKinds: neededKinds('scroll') },
  )
  assert.equal(seen.changed, 'false')

  // 只有一端读到也算"这一类可见"（避免把"前态读到了、后态读不到"误报成缺测）
  const oneSide = changeVerdict(
    { changed: false, before: { ...base, contentKinds: { scroll: 2 } }, after: base },
    { needsKinds: neededKinds('scroll') },
  )
  assert.equal(oneSide.changed, 'false')

  // 不给 needsKinds 时行为不变（click/move 这些不靠内容类判据的命令）
  assert.equal(changeVerdict({ changed: false, before: base, after: base }, {}).changed, 'false')
})

test('landingNote：没有显式目标时不许给"在目标内"的布尔值', () => {
  const target = { hwnd: '0x1c050e', rootHwnd: '0x1c050e' }
  const state = { point: '0x960302', pointRootHwnd: '0x1c050e', pointLanded: true }

  // 真机场景：前台是 A、故意点隔壁 B —— 落点窗口与"这次认定的目标"是同一个，
  // 所以 sameWindow=true，但它跟"点进了我想要的窗口"无关 ⇒ inTarget 必须是 null
  const loose = landingNote(state, target, { x: 100, y: 200 }, { explicitTarget: false })
  assert.equal(loose.sameWindow, true)
  assert.equal(loose.inTarget, null)
  assert.equal(loose.explicit, false)
  assert.match(loose.note, /同窗口=true/)
  assert.match(loose.note, /没有给 --target-hwnd/)

  const strict = landingNote(state, target, { x: 100, y: 200 }, { explicitTarget: true })
  assert.equal(strict.explicit, true)
  assert.equal(strict.inTarget, true)
  assert.match(strict.note, /在目标内=true/)

  // 默认（不传 opts）保持旧行为：显式
  assert.equal(landingNote(state, target, { x: 100, y: 200 }).inTarget, true)
})

test('landingPreflight：注入前的落点闸门，三态与几何闸门同款', () => {
  const target = { hwnd: '0x50086', rootHwnd: '0x50086' }

  // 落点就是目标自己
  const same = landingPreflight({ hwnd: '0x50086', rootHwnd: '0x50086' }, target)
  assert.equal(same.verdict, 'true')
  assert.equal(same.want, '0x50086')
  assert.equal(same.actual, '0x50086/0x50086')

  // 落点是目标顶层窗口的**子控件**（真机里 WindowFromPoint 对 WinForms 直接返回 BUTTON/EDIT）
  // ⇒ 句柄不同但根相同，必须算命中，否则正常点击会被自己拦下来
  const child = landingPreflight({ hwnd: '0x20812', rootHwnd: '0x50086' }, target)
  assert.equal(child.verdict, 'true')

  // 目标那侧给的是子控件句柄、落点读到的是它的顶层窗口 ⇒ 也算命中
  const viaTargetRoot = landingPreflight({ hwnd: '0x50086', rootHwnd: '0x50086' }, { hwnd: '0x20812', rootHwnd: '0x50086' })
  assert.equal(viaTargetRoot.verdict, 'true')

  // 明确不是同一个窗口 ⇒ false（这就是必须默认拒发的那一态）
  const other = landingPreflight({ hwnd: '0xdead', rootHwnd: '0xdead' }, target)
  assert.equal(other.verdict, 'false')
  assert.equal(other.actual, '0xdead/0xdead')
  assert.equal(other.want, '0x50086')
  assert.match(other.reason, /0xdead/)
  assert.match(other.reason, /0x50086/)

  // 落点读数拿不到（FromPoint 被拒 / 点在屏外 / 窗口最小化）⇒ unknown，不是 false
  // 取舍：拿不到读数时不拦（与几何闸门对 unknown 的口径一致），但必须留 WARN
  const blind = landingPreflight({ hwnd: '', rootHwnd: '' }, target)
  assert.equal(blind.verdict, 'unknown')
  assert.equal(blind.actual, '-')
  assert.match(blind.reason, /读不到/)

  const noTarget = landingPreflight({ hwnd: '0xdead', rootHwnd: '0xdead' }, { hwnd: '', rootHwnd: '' })
  assert.equal(noTarget.verdict, 'unknown')
  assert.match(noTarget.reason, /目标/)

  // 没有显式给 --target-hwnd ⇒ 这一路根本不设闸门（行为与修前一致）
  const notExplicit = landingPreflight({ hwnd: '0xdead', rootHwnd: '0xdead' }, target, { explicitTarget: false })
  assert.equal(notExplicit.verdict, 'unknown')
  assert.match(notExplicit.reason, /没有显式目标/)

  // target 整个缺失也不许抛
  assert.equal(landingPreflight({ hwnd: '0x1', rootHwnd: '0x1' }, null).verdict, 'unknown')
})

test('injectionWarn：引导句按命令分开写，不许用 scroll 的错话去猜', () => {
  // result.changed 是**布尔**（compareStates 给的）：只有当真有"看得见的没变"时才轮到这条 WARN，
  // unknown 那一路由 changeVerdict 的 reason 占位，不会走到这里。
  const result = { changed: false }
  const scroll = injectionWarn(result, { kind: 'scroll' })
  assert.doesNotMatch(scroll, /坐标落空/)
  assert.match(scroll, /滚动位置/)
  assert.match(scroll, /unknown/)

  const move = injectionWarn(result, { kind: 'move' })
  assert.doesNotMatch(move, /坐标落空/)
  assert.match(move, /CURSOR_LANDED/)

  const typed = injectionWarn(result, { kind: 'type' })
  assert.doesNotMatch(typed, /坐标落空/)
  assert.match(typed, /FOCUS_OK/)

  // 坐标类仍然是原来的那句（还有几何自洽检查这条前置线索）
  const click = injectionWarn(result, { kind: 'click' })
  assert.match(click, /坐标落空/)
  assert.match(click, /GEO_MISMATCH/)

  // 没有差异时的公共部分不变：现场读数 + "返回不能当证据"
  assert.match(click, /已插入/)
  assert.match(click, /静默/)
})
test('开关作用域：用不上的开关一律报用法错（不静默忽略）', () => {
  // 真机踩过：`move --button right` 拿到普通移动、`type --x 5 --y 6` 悄悄丢掉坐标、
  // 拼错开关名什么都不报。这一整类"传了但没生效"就是两个 P1 能藏住的原因。
  const rejected = () => checkFlagScope(parseArgs(['move', '--x', '1', '--y', '2', '--button', 'right']), 'move')
  assert.throws(
    rejected,
    (err) => err instanceof UsageError && /不认识开关：--button/.test(err.message) && /这条命令认识/.test(err.message),
  )
  assert.throws(
    () => checkFlagScope(parseArgs(['point', '--x', '1', '--y', '2', '--bogus']), 'point'),
    (err) => err instanceof UsageError && /不认识开关：--bogus/.test(err.message) && /这条命令认识/.test(err.message),
  )
  // 公共开关人人可用（漏了 dry-run 会让所有注入命令报"不认识 --dry-run"）。
  assert.deepEqual(checkFlagScope(parseArgs(['windows', '--json', '--no-pixel', '--timeout', '5000']), 'windows'), [])
  assert.deepEqual(checkFlagScope(parseArgs(['click', '--x', '1', '--y', '2', '--dry-run', '--force', '--target-hwnd', '0x1']), 'click'), [])
})

test('开关清单本身：键盘命令不收坐标类的 --target-hwnd，坐标类不收 --text/--keys', () => {
  assert.equal(allowedFlags('type').includes('hwnd'), true, 'type 必须有 --hwnd（收键窗口）')
  assert.equal(allowedFlags('type').includes('target-hwnd'), false, '--target-hwnd 是坐标类的落点断言')
  assert.equal(allowedFlags('key').includes('target-hwnd'), false)
  for (const cmd of ['click', 'move', 'scroll']) {
    assert.equal(allowedFlags(cmd).includes('target-hwnd'), true, `${cmd} 要有 --target-hwnd`)
    assert.equal(allowedFlags(cmd).includes('text'), false)
  }
  assert.equal(allowedFlags('snapshot').includes('hwnd'), true)
  assert.equal(allowedFlags('nosuchcmd'), null, '未知命令不猜清单')
  // 每条命令的清单都得是数组，且不含 `--` 前缀（键名口径统一）。
  for (const [cmd, list] of Object.entries(COMMAND_FLAGS)) {
    assert.equal(Array.isArray(list), true, `${cmd} 的清单必须是数组`)
    for (const flag of list) assert.equal(flag.startsWith('-'), false, `${cmd} 的 ${flag} 不许带 -- 前缀`)
  }
})

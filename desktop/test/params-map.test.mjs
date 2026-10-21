// CLI → 桥 的参数映射契约（design.md I10c）。
//
// 为什么要有这张静态守卫：`lib/bridge.mjs` 的 `runBridge` 把 params 直接翻成 `-Name value`，
// 而桥是 `-File` 方式启动的 —— 参数名**写错**会当场报绑定错误（不是静默的），但"**压根没写**"
// 是完全静默的：桥侧实现得再完整也永远到不了。真机缺陷正是后者：`type`/`key` 分支没把 `Hwnd`
// 放进 params，于是"键盘前台闸门 + --raise"这条被文档承诺的路根本不存在，而 CLI 一声不响。
//
// 所以这里双向钉住：
//   ① 桥的顶层 param 块 = 一份**冻结清单**（改名/删参数立刻红）；
//   ② cli.mjs 每个命令的函数体里必须出现它该下发的键名，且每个键名都必须在①里存在。
// 不改真实桌面、不发事件：纯读源码。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { lineTextAt, previousNonEmptyLineText } from './helpers.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BRIDGE = fs.readFileSync(path.join(ROOT, 'scripts', 'bridge.ps1'), 'utf8')
const CLI = fs.readFileSync(path.join(ROOT, 'cli.mjs'), 'utf8')

/** 桥顶层 param 块里的参数名（按声明顺序）。注释行不算。 */
function bridgeParamNames(source) {
  const block = /(?:^|\n)param\(([\s\S]*?)\n\)/.exec(source)
  assert.ok(block !== null, 'bridge.ps1 里找不到顶层 param( 块')
  const names = []
  for (const raw of block[1].split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    // 一行形如 `[Parameter(Mandatory = $true)][string]$Command,` —— 取**最后一个** `$名字`
    // （前面还可能有 `$true`）。
    const hits = [...line.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1])
    if (hits.length > 0) names.push(hits[hits.length - 1])
  }
  return names
}

/** cli.mjs 里某个顶层函数的函数体（从 `function x(` 到下一个行首 `}`）。 */
function cliFunctionBody(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `cli.mjs 里找不到 function ${name}(`)
  const rest = source.slice(start)
  const end = rest.indexOf('\n}')
  return rest.slice(0, end === -1 ? rest.length : end)
}

/** 函数体里作为桥参数名出现的键：对象字面量的 `X:` 与属性赋值 `params.X =`（两种写法都认）。 */
function keysSentIn(body) {
  const keys = new Set()
  for (const m of body.matchAll(/(?:^|[\s{,])([A-Z][A-Za-z0-9]*):/g)) keys.add(m[1])
  for (const m of body.matchAll(/\.([A-Z][A-Za-z0-9]*)\s*=/g)) keys.add(m[1])
  return keys
}

// 桥的参数清单：改桥的参数名就必须同时改这里 + cli.mjs + 三件套文档。
const EXPECTED_BRIDGE_PARAMS = [
  'Command', 'Out', 'Hwnd', 'X', 'Y', 'Region', 'Shot', 'Hash', 'Depth', 'Name', 'ElId', 'ElRuntimeId',
  'SetValue', 'Button', 'Double', 'Text', 'Keys', 'Clicks', 'WheelDelta', 'Limit', 'NoMove', 'MoveOnly',
  'PlanOnly', 'Raise', 'Invoke',
]

test('桥的参数清单是冻结的（改名/删参数必须同步 CLI 与文档）', () => {
  assert.deepEqual(bridgeParamNames(BRIDGE), EXPECTED_BRIDGE_PARAMS)
})

/** 每个命令函数必须下发的键（少一个就红 —— 这就是 P1-b 那一类）。 */
const REQUIRED_KEYS = {
  cmdInject: ['Text', 'Keys', 'Hwnd', 'X', 'Y', 'Button', 'Double', 'Clicks', 'MoveOnly', 'WheelDelta', 'PlanOnly', 'Raise'],
  cmdScreen: ['Shot', 'Region', 'Hash'],
  cmdUia: ['Hwnd', 'Depth', 'Name', 'Limit', 'ElId'],
  cmdInvoke: ['Hwnd', 'Name', 'ElId', 'ElRuntimeId', 'SetValue', 'Depth', 'Limit', 'Invoke'],
  cmdPoint: ['X', 'Y'],
  cmdSnapshot: ['Hwnd', 'X', 'Y'],
  cmdProbe: [],
}

test('每个命令函数都把它该下发的键真的放进 params（漏传/改名立刻红）', () => {
  const bridgeParams = new Set(EXPECTED_BRIDGE_PARAMS)
  for (const [fn, required] of Object.entries(REQUIRED_KEYS)) {
    const sent = keysSentIn(cliFunctionBody(CLI, fn))
    for (const key of required) {
      assert.equal(sent.has(key), true, `${fn} 没有下发 ${key}:（参数映射漏传，桥侧收不到）`)
      assert.equal(bridgeParams.has(key), true, `${fn} 下发的 ${key} 不是桥声明的参数名`)
    }
  }
})

test('内容探针的作用域是加法的：captureState 必须同时下发 Hwnd 与 X/Y（I7h）', () => {
  const body = cliFunctionBody(CLI, 'captureState')
  // 曾经这里是 if/else —— 只要根拿得到就不下发坐标，after 探针静默退化成 hwnd 作用域，
  // `scroll` 需要的那一类读数结构性消失（真机：standalone 读到 scroll=1，after 探针全 0）。
  assert.match(body, /snapshotParams\.Hwnd = storedRoot/)
  assert.match(body, /snapshotParams\.X = args\.x/)
  assert.match(body, /snapshotParams\.Y = args\.y/)
  assert.equal(/else if \(args\.x !== undefined/.test(body), false, 'captureState 里的 if/else 互斥作用域又回来了')
})

test('类型命令的收键窗口走 --hwnd：桥的键盘分支与 CLI 用同一个键名', () => {
  const body = cliFunctionBody(CLI, 'cmdInject')
  assert.match(body, /requireKeyboardHwnd\(args\)/)
  assert.match(body, /params = \{ Command: 'input', Text: text, Hwnd: keyboardHwnd \}/)
  assert.match(body, /params = \{ Command: 'input', Keys: keys, Hwnd: keyboardHwnd \}/)
  // 桥侧必须真的用它当 focusTarget（否则 CLI 传了也没用），而且"发给谁"只能有一个来源
  // （plan 与真跑同源，I10b）：$keyboardFocusSource 决定，真跑那边只是读它。
  for (const needle of [/\$keyboardFocusSource = 'hwnd'/, /\$focusSource = \$keyboardFocusSource/, /\$plan\['focusSource'\] = \$keyboardFocusSource/]) {
    assert.match(BRIDGE, needle)
  }
})

test('dry-run 的键盘计划回显收键窗口：PLAN_FOCUS_SOURCE / PLAN_HWND', () => {
  const body = cliFunctionBody(CLI, 'cmdInject')
  assert.match(body, /PLAN_FOCUS_SOURCE=/)
  assert.match(body, /PLAN_HWND=/)
})

test('invoke 的身份闸门在桥侧、是同源模块、且在动手路径的任何动作原语之前（I6f）', () => {
  // `ElRuntimeId` 是**可选**参数（缺省空串 ⇒ 老调用方式行为不变），但只要给了就必须真的拦人：
  // 闸门必须在 `Do-InvokeChosen` 里、在**动手路径上的任何动作原语之前** —— 不然就成了"摸完
  // element 才拒绝"，而这条路的全部意义是"不吻合就别碰它"。
  //
  // 注意这里的口径**不是**"文件里第一个 TryGetCurrentPattern 之前"：构建节点记录时
  // `Get-PatternNames` 就已经只读枚举过 pattern 了（那是清点，不是动作）。判定本身写在
  // `scripts/identity.ps1`，真桥与 `test/fixtures/invoke-identity-bridge.ps1` 都 dot-source 它，
  // 所以"把判定改坏"变红的是**会执行**的那条用例，而不是这几行文本断言。
  assert.match(BRIDGE, /\[string\]\$ElRuntimeId = '',/)
  assert.match(BRIDGE, /Do-InvokeChosen -Nodes \$nodes -MatchId \$matchId -ElRuntimeId \$ElRuntimeId/)
  assert.match(BRIDGE, /\. \(Join-Path \$PSScriptRoot 'identity\.ps1'\)/, 'bridge.ps1 必须 dot-source 同源的判定模块')
  const gateCall = "$identityGate = Get-ElementIdentityGate -Expected $ElRuntimeId -Actual ([string]$node['runtimeId']) -ElementId $MatchId"
  const gate = BRIDGE.indexOf(gateCall)
  assert.ok(gate > 0, '在 Do-InvokeChosen 里定位不到闸门调用语句（可能缺失、被折行或被改写）')
  const invokeBody = BRIDGE.indexOf('function Do-InvokeChosen')
  assert.ok(invokeBody > 0 && gate > invokeBody, '身份闸门必须在 Do-InvokeChosen 里')
  const reject = BRIDGE.indexOf('if ($null -ne $identityGate) {', gate)
  assert.ok(reject > gate, '闸门判定后必须立刻拒绝')
  const rejectReport = BRIDGE.indexOf('Write-Report $identityGate', reject)
  assert.ok(rejectReport > reject, '拒绝时要把 identity.ps1 的报告原样发出')
  const rejectReturn = BRIDGE.indexOf('return', rejectReport)
  assert.ok(rejectReturn > rejectReport, '拒绝之后必须立刻返回，否则还会继续往下走到动作')
  let firstAction = Number.POSITIVE_INFINITY
  for (const primitive of ['.SetValue(', '.Invoke()', '.Toggle()', '.Select()', '.Expand()', '.Collapse()']) {
    const at = BRIDGE.indexOf(primitive, gate)
    assert.ok(at > gate, `身份闸门必须在 ${primitive} 之前`)
    firstAction = Math.min(firstAction, at)
  }
  // 只钉"闸门**调用点**在动作之前"是不够的：对抗性验收实测（G1 / M4）—— 调用点留在原处、
  // 只把**拒绝块**挪到 `Do-InvokeChosen` 末尾，判定就退化成"只检出、不拦住"，而上面那些
  // `indexOf(...) > gate` 全都还是真的、6 条用例照样全绿。所以拒绝块的三段字节位置必须都
  // 早于**第一个**动作原语。`at > 0` 那半句不能省：needle 缺失时 `indexOf` 返 `-1`，
  // 只比 `< firstAction` 会**恒真**（正是要防的假绿形状）。
  for (const [label, at] of [
    ['拒绝分支 `if ($null -ne $identityGate) {`', reject],
    ['拒绝时的 `Write-Report $identityGate`', rejectReport],
    ['拒绝分支的 `return`', rejectReturn],
  ]) {
    assert.ok(at > 0 && at < firstAction, `${label} 必须在第一个动作原语之前 —— 只在动作之后拒绝就等于照样动手`)
  }
  // "三段各自在动作之前"还挡不住两种改法：`return` 那一针取的是"拒绝块之后的下一个 return"，
  // 而 ValuePattern 失败分支里也有一个 `return`（它本来就在第一个动作原语之前）—— 于是把拒绝块
  // **自己的** `return` 删掉、或者只把 `Write-Report $identityGate` 搬到函数末尾，三针都还是真的。
  // 所以再钉一次："这一块是**连续的一段**，而且整段在第一个动作原语之前"（`\s*` 容许缩进与换行）。
  const rejectBlock = /if \(\$null -ne \$identityGate\) \{\s*Write-Report \$identityGate\s*return\s*\}/.exec(BRIDGE)
  assert.ok(
    rejectBlock && rejectBlock.index > 0,
    '拒绝块必须连续成段：`if ($null -ne $identityGate) {` + `Write-Report $identityGate` + `return` 三行之间不许插进别的语句',
  )
  assert.ok(rejectBlock.index < firstAction, '整个拒绝块必须在第一个动作原语之前 —— 只在动作之后拒绝就等于照样动手')
  // 但"三行字面量都在 + 连续 + 位置对"仍然只证明**文本在**，不证明**这段代码会执行**：对抗性验收
  // 的第四种改法（M6）把整块套进恒假 `if ($false) { … }` —— 三行一字未动，上面每一条断言都还是
  // 真的。所以再钉"可执行"的**最低文本条件**（这里不声称证明了会执行；挡得住 / 挡不住的形态写在
  // `testing-guide.md` 的 D106 / D108）：
  //   ① 拒绝块**紧邻的上一条非空源码行**必须就是闸门调用语句本身 —— 中间夹不进任何一行；
  //   ② 闸门调用语句与拒绝块之间不许出现控制流开启记号（`if (` / `while (` / `foreach (` /
  //      `switch (`）或注释开启记号（`<#`、行首 `#`）；
  //   ③ 三行的行文本（trim 后）必须**精确等于**那三行字面量 —— 行首加 `#`、行尾加注解、被包进
  //      别的 `if`，都会在这里露出来。
  assert.equal(
    previousNonEmptyLineText(BRIDGE, reject),
    gateCall,
    '拒绝块的紧邻上一条非空源码行必须就是闸门调用语句 —— 中间夹一层恒假 if 或夹一句注释，这块就不会执行了',
  )
  const betweenGateAndReject = BRIDGE.slice(gate + gateCall.length, reject)
  for (const marker of ['if (', 'while (', 'foreach (', 'switch (', '<#']) {
    assert.equal(
      betweenGateAndReject.includes(marker),
      false,
      `闸门调用与拒绝块之间不许出现 ${marker} 这种控制流/注释开启记号 —— 套一层或注掉之后，文本还在但代码不会执行`,
    )
  }
  assert.equal(
    /(^|\n)[ \t]*#/.test(betweenGateAndReject),
    false,
    '闸门调用与拒绝块之间不许出现行首 # 开头的注释行',
  )
  for (const [label, at, expected] of [
    ['拒绝分支', reject, 'if ($null -ne $identityGate) {'],
    ['拒绝时的报告', rejectReport, 'Write-Report $identityGate'],
    ['拒绝分支的返回', rejectReturn, 'return'],
  ]) {
    assert.equal(
      lineTextAt(BRIDGE, at),
      expected,
      `${label}必须独立成行、行文本精确等于 ${expected} —— 行首 #、行尾注解、被包进别的 if 都会在这里红`,
    )
  }
  const identity = fs.readFileSync(path.join(ROOT, 'scripts', 'identity.ps1'), 'utf8')
  assert.match(identity, /function Get-ElementIdentityGate/)
  assert.match(identity, /patternError = 'element identity mismatch: id matched but runtimeId differs'/)
  assert.match(identity, /identityMismatch = \$true/)
})
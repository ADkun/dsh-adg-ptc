// design.md I6f：invoke 的"数命中数"发生在定位快照上，"动手"发生在桥的第二遍遍历里，而两者
// 之间只有 `ElId` 这一个字符串（runtimeId 的哈希）在传 —— id 命中**不证明**是同一个元素。
// 所以身份要随 invoke 一起下发，不一致就一步都不动、以退出码 2 拒绝动手。
//
// 这里的真机面是刻意不碰的：CLI 换成 test/fixtures/invoke-identity-bridge.ps1（经
// ADG_DESKTOP_BRIDGE），它只回四份罐装 JSON（uia 定位 / profile / verify / uia -Invoke），
// **不枚举窗口、不合成输入、不写除 -Out 之外的任何文件**。它把两次遍历的 runtimeId 做成两个
// 环境旋钮，于是"两次遍历报不同元素"这件事不用真机、也不用竞态就能构造出来。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import {
  FIXTURES_DIR,
  MODULE_ROOT,
  childEnv,
  lineTextAt,
  parseKeyValues,
  previousNonEmptyLineText,
  readBridgeSource,
  runCli,
} from './helpers.mjs'

const FIXTURE_BRIDGE = path.join(FIXTURES_DIR, 'invoke-identity-bridge.ps1')
const REAL_BRIDGE = path.join(MODULE_ROOT, 'scripts', 'bridge.ps1')
const SNAPSHOT_RUNTIME_ID = '42.1000.7'
const SECOND_PASS_RUNTIME_ID = '42.9999.9'

/** 经假桥跑一次 invoke：不给 --x/--y（不查 point）、不给像素（rect=null）、--no-content（不跑探针）。 */
function runFixtureInvoke(argv, env = {}, opts = {}) {
  return runCli(['invoke', ...argv, '--no-pixel', '--no-content'], {
    env: { ...process.env, ADG_DESKTOP_BRIDGE: FIXTURE_BRIDGE, ...env },
    timeoutMs: opts.timeoutMs ?? 60000,
  })
}

test('假桥与真桥是两个文件（防止这条用例悄悄跑成真机）', () => {
  assert.notEqual(FIXTURE_BRIDGE, REAL_BRIDGE)
  assert.match(readFileSync(FIXTURE_BRIDGE, 'utf8'), /fixture bridge does not implement/)
})

test('身份不一致：桥一步都不动（OK=false），CLI 以退出码 2 拒绝动手', () => {
  // 定位快照说这个 id 的元素是 42.1000.7，第二遍遍历里同一个 id 报的是 42.9999.9。
  const result = runFixtureInvoke(['--id', 'el_00000001', '--hwnd', '0x1234'])
  const lines = parseKeyValues(result.stdout)
  assert.equal(result.code, 2, `应当拒绝动手（2），实际 ${result.code}；stderr=${result.stderr}`)
  assert.equal(lines.ELEMENT_RUNTIME_ID, SNAPSHOT_RUNTIME_ID, '定位快照的身份必须原样下发')
  assert.equal(lines.ID_IDENTITY, 'mismatch')
  assert.equal(lines.OK, 'false', '桥必须报 invoked=false —— 拒绝动手不是"试了但没生效"')
  // 没抓像素也没读内容 ⇒ 判据覆盖不到，按红线 1 的三态给 unknown（"我看不见"绝不许报成 false）。
  assert.equal(lines.CHANGED, 'unknown')
  assert.match(result.stdout, /WARN=元素身份不一致/)
  assert.match(result.stdout, /42\.9999\.9/, 'WARN 要说清这次命中的实际 runtimeId')
  assert.match(result.stderr, /^ERROR=invoke 拒绝动手：元素身份复核不一致/)
  // 与"动作没生效"（退出码 1）分开：那条路的 WARN 是"语义操作没有真正生效"。
  assert.doesNotMatch(result.stdout, /语义操作没有真正生效/)
})

test('身份一致：照常动手（ID_IDENTITY=checked，退出码 0）', () => {
  const result = runFixtureInvoke(['--id', 'el_00000001', '--hwnd', '0x1234'], {
    ADG_FIXTURE_SECOND_PASS_RUNTIME_ID: SNAPSHOT_RUNTIME_ID,
  })
  const lines = parseKeyValues(result.stdout)
  assert.equal(result.code, 0, `stderr=${result.stderr}`)
  assert.equal(lines.ELEMENT_RUNTIME_ID, SNAPSHOT_RUNTIME_ID)
  assert.equal(lines.ID_IDENTITY, 'checked')
  assert.equal(lines.OK, 'true')
  assert.equal(lines.PATTERN_USED, 'InvokePattern')
  assert.doesNotMatch(result.stdout, /WARN=元素身份不一致/)
})

test('定位快照给不出 runtimeId：不下发身份、标 absent，行为与今天一致（照旧动手）', () => {
  // 这是老调用方式的回归面：`ADG_FIXTURE_SNAPSHOT_RUNTIME_ID='-'` ⇒ 快照里 runtimeId 为空
  // （GetRuntimeId() 读不到时的形状）。此时**即使两次遍历报的元素不同**也不许拒绝：没有身份
  // 就没有"不一致"可判，只能照旧按 id 动手、并把"这次没有身份复核"打在明面上。
  const result = runFixtureInvoke(['--id', 'el_00000001', '--hwnd', '0x1234'], {
    ADG_FIXTURE_SNAPSHOT_RUNTIME_ID: '-',
  })
  const lines = parseKeyValues(result.stdout)
  assert.equal(result.code, 0, `没有身份可下发时行为不变；stderr=${result.stderr}`)
  assert.equal(lines.ELEMENT_RUNTIME_ID, '', '缺失就是缺失，不许凭空造一个 runtimeId')
  assert.equal(lines.ID_IDENTITY, 'absent')
  assert.equal(lines.OK, 'true', '缺身份不许变成拒动手')
  assert.match(result.stdout, /WARN=这次没有身份复核/)
})

test('el_unknown 限定窗口后仍可动手，但一定标出"没有身份复核"', () => {
  // A（design.md I6e）只禁"未限定窗口就拿占位 id 动手"：`el_unknown` 没有 runtimeId，
  // 所以它永远走 absent 那一路 —— 缺口必须在输出里看得见，不许静默当成复核过。
  const result = runFixtureInvoke(['--id', 'el_unknown', '--hwnd', '0x1234'], {
    ADG_FIXTURE_SNAPSHOT_RUNTIME_ID: '-',
  })
  const lines = parseKeyValues(result.stdout)
  assert.equal(result.code, 0, `stderr=${result.stderr}`)
  assert.equal(lines.ID_IDENTITY, 'absent')
  assert.equal(lines.ELEMENT_RUNTIME_ID, '')
  assert.equal(lines.OK, 'true')
  assert.match(result.stdout, /WARN=这次没有身份复核/)
})

test('静态守卫：身份闸门是同源模块、在动手路径的任何动作原语之前，且 CLI 一定把身份并排下发', () => {
  const source = readBridgeSource()
  // 判定是**一段可执行的代码**（`scripts/identity.ps1`），真桥与下面的假桥 dot-source 的是同一个
  // 文件 —— 所以"把判定改成永假/永真"会红的是**会执行**的那两条用例，而不是这里的文本断言。
  // 这里只钉住"接线"与"位置"，函数体归 identity.ps1 自己管。
  assert.match(source, /\. \(Join-Path \$PSScriptRoot 'identity\.ps1'\)/, 'bridge.ps1 必须 dot-source 同源的判定模块')
  const gateCall = "$identityGate = Get-ElementIdentityGate -Expected $ElRuntimeId -Actual ([string]$node['runtimeId']) -ElementId $MatchId"
  const gate = source.indexOf(gateCall)
  assert.ok(gate > 0, '在 Do-InvokeChosen 里定位不到闸门调用语句（可能缺失、被折行或被改写）')
  const invokeBody = source.indexOf('function Do-InvokeChosen')
  assert.ok(invokeBody > 0 && gate > invokeBody, '身份闸门必须在 Do-InvokeChosen 里')
  const reject = source.indexOf('if ($null -ne $identityGate) {', gate)
  assert.ok(reject > gate, '闸门判定后必须立刻拒绝')
  const rejectReport = source.indexOf('Write-Report $identityGate', reject)
  assert.ok(rejectReport > reject, '拒绝时要把 identity.ps1 的报告原样发出')
  const rejectReturn = source.indexOf('return', rejectReport)
  assert.ok(rejectReturn > rejectReport, '拒绝之后必须立刻返回，否则还会继续往下走到动作')
  // 位置口径（I6f）：**动手路径上的任何动作原语之前**。口径**不是**"文件里第一个
  // TryGetCurrentPattern 之前" —— 构建节点记录时 `Get-PatternNames` 就只读枚举过 pattern，
  // 那是清点、不是动作；这条断言如果按那种写法会恒真。
  let firstAction = Number.POSITIVE_INFINITY
  for (const primitive of ['.SetValue(', '.Invoke()', '.Toggle()', '.Select()', '.Expand()', '.Collapse()']) {
    const at = source.indexOf(primitive, gate)
    assert.ok(at > gate, `身份闸门必须在 ${primitive} 之前 —— 不然就是"已经动了手才说身份不对"`)
    firstAction = Math.min(firstAction, at)
  }
  // 只钉"闸门**调用点**在动作之前"是不够的：对抗性验收实测（G1 / M4）—— 调用点留在原处、
  // 只把**拒绝块**挪到 `Do-InvokeChosen` 末尾，判定就退化成"只检出、不拦住"（不一致被检出了，
  // 然后照样动手），而上面那些 `indexOf(...) > gate` 全都还是真的、8 条用例照样全绿。
  // 所以拒绝块的三段字节位置必须都早于**第一个**动作原语。`at > 0` 那半句不能省：
  // needle 缺失时 `indexOf` 返 `-1`，只比 `< firstAction` 会**恒真**（正是要防的假绿形状）。
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
  const rejectBlock = /if \(\$null -ne \$identityGate\) \{\s*Write-Report \$identityGate\s*return\s*\}/.exec(source)
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
    previousNonEmptyLineText(source, reject),
    gateCall,
    '拒绝块的紧邻上一条非空源码行必须就是闸门调用语句 —— 中间夹一层恒假 if 或夹一句注释，这块就不会执行了',
  )
  const betweenGateAndReject = source.slice(gate + gateCall.length, reject)
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
      lineTextAt(source, at),
      expected,
      `${label}必须独立成行、行文本精确等于 ${expected} —— 行首 #、行尾注解、被包进别的 if 都会在这里红`,
    )
  }
  const cli = readFileSync(path.join(MODULE_ROOT, 'cli.mjs'), 'utf8')
  assert.match(cli, /ElRuntimeId: identity\.runtimeId/, 'CLI 必须把定位快照的身份随落地调用下发')
})

test('同源模块 identity.ps1：判定只此一份，且是 ASCII-only / 无 BOM / LF 的 WinPS 5.1 可加载文件', () => {
  const bytes = readFileSync(path.join(MODULE_ROOT, 'scripts', 'identity.ps1'))
  assert.notEqual(bytes[0], 0xef, 'identity.ps1 不许有 UTF-8 BOM（WinPS 5.1 会按 ANSI 读）')
  assert.equal(bytes.includes(13), false, 'identity.ps1 不许有 CR —— 与 bridge.ps1 同口径，LF-only')
  assert.equal(bytes.some((b) => b > 127), false, 'identity.ps1 必须 ASCII-only')
  const module = bytes.toString('utf8')
  assert.match(module, /function Get-ElementIdentityGate/)
  assert.match(module, /patternError = 'element identity mismatch: id matched but runtimeId differs'/)
  assert.match(module, /identityMismatch = \$true/)
  // 只许有两条"跳过复核"的出口：没给身份（老调用方式）、身份一致。多一条就意味着有人往判定里
  // 加了别的放行条件。
  assert.equal((module.match(/return \$null/g) ?? []).length, 2, 'identity.ps1 只许有两条"不拦人"的出口')
  const fixture = readFileSync(FIXTURE_BRIDGE, 'utf8')
  assert.ok(
    fixture.includes("(Join-Path $PSScriptRoot '..\\..\\scripts\\identity.ps1')"),
    '假桥必须 dot-source 真桥的同一份判定，而不是自己再抄一遍',
  )
  assert.equal(
    fixture.includes("$ElRuntimeId -ne ''"),
    false,
    '假桥里不许留下任何平行重写的判定（这正是 F1 缺陷的形态）',
  )
})

// F5（对抗性验收提出）：`runCli` 以前传 `env: opts.env ?? process.env`，于是 shell 里只要导出过
// `ADG_DESKTOP_BRIDGE`，**整套**测试就会静默跑在另一个桥上 —— 验收时真发生过一次（一条只读 `uia`
// 落到真桥：`SNAPSHOT_COUNT=45 FOUND=false`、退出码 2）。这里选"默认剔除继承、只在显式注入时带上"，
// 而不是"跑测试前断言环境干净"：后者要求每个调用方（以及 CI、以及人手跑一条用例时）都记得清环境，
// 而前者把这条缝隙收在唯一的入口函数里，显式注入（身份用例顶替假桥走的就是它）照旧生效。
test('测试环境卫生：runCli 默认不继承外部的 ADG_DESKTOP_BRIDGE，只有显式注入才生效', () => {
  const previous = process.env.ADG_DESKTOP_BRIDGE
  process.env.ADG_DESKTOP_BRIDGE = 'D:\\poisoned\\bridge.ps1'
  try {
    const inherited = childEnv()
    assert.equal(
      inherited.ADG_DESKTOP_BRIDGE,
      undefined,
      'runCli 的默认环境不许继承外部导出的 ADG_DESKTOP_BRIDGE —— 否则整套测试会静默跑在另一个桥上',
    )
    assert.equal(
      childEnv({ env: { ADG_DESKTOP_BRIDGE: FIXTURE_BRIDGE } }).ADG_DESKTOP_BRIDGE,
      FIXTURE_BRIDGE,
      '显式注入必须照旧生效（身份用例就是靠它把 CLI 顶到假桥上的）',
    )
    assert.equal(inherited.SystemRoot, process.env.SystemRoot, '剔除的只是那一把钥匙，其余环境照旧继承')
    // 别拿 `PATH` 比：Windows 上真实键名是 `Path`，`process.env` 的大小写不敏感只对它自己（Proxy）成立，
    // 铺开成普通对象后就按真实键名存 —— 比键数才是口径正确的"只少了一把钥匙"。
    assert.equal(
      Object.keys(inherited).length,
      Object.keys(process.env).length - 1,
      '除了 ADG_DESKTOP_BRIDGE，其余环境变量必须一个不少地继承下去',
    )
  } finally {
    if (previous === undefined) delete process.env.ADG_DESKTOP_BRIDGE
    else process.env.ADG_DESKTOP_BRIDGE = previous
  }
})

// G3（第 2 轮对抗性验收提出）：剔除必须**大小写不敏感**。Windows 的环境变量名本来就大小写不敏感，
// `lib/env.mjs` 的 `envGet` 也是这么比的 —— 只 `delete` 精确大小写时，用变体大小写导出的那个名字会
// 整条漏进子进程并被 CLI 认下来（验收方探针实测 `survivors=['adg_desktop_bridge']`），这道卫生等于没做。
test('测试环境卫生：变体大小写的 ADG_DESKTOP_BRIDGE 也一并剔除，且不误删别的继承键', () => {
  const VARIANT = 'adg_desktop_bridge' // 故意用变体大小写：真正的环境变量名在 Windows 上不分大小写
  const savedVariant = process.env[VARIANT]
  const savedExact = process.env.ADG_DESKTOP_BRIDGE
  // 先把大小写完全匹配的那一项移开，让下面这次设置**真的**造出一个变体大小写的键
  // （环境变量名不区分大小写 ⇒ 同名设置会改写已有那一项并保留原键名，那样就测不到东西了）。
  delete process.env.ADG_DESKTOP_BRIDGE
  process.env[VARIANT] = 'POISON'
  try {
    assert.ok(
      Object.keys(process.env).includes(VARIANT),
      '前提：这次设置真的落成了一个变体大小写的键（否则这条用例测的是别的形状）',
    )
    const keyCountWithPoison = Object.keys(process.env).length
    const inherited = childEnv()
    const survivors = Object.keys(inherited).filter((k) => k.toLowerCase() === 'adg_desktop_bridge')
    assert.deepEqual(survivors, [], `任何大小写变体都不许漏进子进程（实际漏了 ${JSON.stringify(survivors)}）`)
    assert.equal(
      Object.keys(inherited).length,
      keyCountWithPoison - 1,
      '只许少这一把钥匙（别拿 PATH 比键名 —— Windows 上真实键名是 Path）',
    )
    assert.equal(inherited.SystemRoot, process.env.SystemRoot, '其余继承键照旧（不许把 SystemRoot / Path 一起误删）')
    assert.equal(
      childEnv({ env: { ADG_DESKTOP_BRIDGE: FIXTURE_BRIDGE } }).ADG_DESKTOP_BRIDGE,
      FIXTURE_BRIDGE,
      '显式注入照旧生效',
    )
  } finally {
    if (savedVariant === undefined) delete process.env[VARIANT]
    else process.env[VARIANT] = savedVariant
    if (savedExact === undefined) delete process.env.ADG_DESKTOP_BRIDGE
    else process.env.ADG_DESKTOP_BRIDGE = savedExact
  }
})
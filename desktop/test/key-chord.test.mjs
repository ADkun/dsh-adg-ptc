// 组合键里的单字符必须走 virtual key 路径（第四轮收口的阻断缺陷）。
//
// 真机实测（完全权限会话，靶是 WinForms/WPF 文本框）：
//   `key --keys ctrl+a --hwnd <靶>` 报 `INSERTED_EVENTS=4 EVENTS_MATCH_PLAN=true FOCUS_SOURCE=hwnd`，
//   看上去完美；而靶侧 `TEXTCHANGED len=2639 -> 2640`（只多一个字符），紧接着 `type --text V`
//   是**追加**（`len=2641`）—— 全选从未发生。根因：单字符被当成 Unicode 直送
//   （`wVk=0, wScan=<字符>, dwFlags=KEYEVENTF_UNICODE`），Unicode 注入直接合成一个 WM_CHAR，
//   **绕过键盘状态**，按住不放的 Ctrl 被彻底无视。
//
// 两条不变量（这里有可机检的判据，真机面由完全权限会话另验）：
//   I7j  组合键（这一组里有修饰键）里的单字符必须以 virtual key 发送：`ctrl+a` ⇒ VK_A=0x41、
//        不带 KEYEVENTF_UNICODE。这个"有没有修饰键"只能算一次（单一真相源），不许各分支各判。
//   I7k  `--dry-run` 的 plan 必须逐键给出 `PATH`/`VK`/`SCAN`/`FLAGS` —— 只回显 `KEYS=ctrl+a`
//        时，一条"把和弦降级成单个字符"的缺陷在计划里完全没有痕迹（这正是它藏了两轮的原因）。
//   I7l  发射**顺序**：修饰键全部按下 → 载荷键 down/up → 修饰键反向抬起（`PHASE=` 列）。
//        只修描述符不够：真机复验证明"逐键各发一对 down+up"（`ctrl↓ ctrl↑ a↓ a↑`）事件数同样是 4、
//        `EVENTS_MATCH_PLAN` 同样为真，而靶侧收到的是一个裸 `a`（`ctrl+c` 打出 `c`、`shift+a` 出小写）。
//
// 这里只跑 `--dry-run` 与静态源码检查，**不发任何真实事件**。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runCli } from './helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.join(HERE, '..', 'scripts', 'bridge.ps1')
const HWND = '0x123456'
/** KEYEVENTF_UNICODE：走 Unicode 直送的字面标记。组合键里出现它就是缺陷。 */
const KEYEVENTF_UNICODE = 4

/** 跑一条 key 命令，解析出逐键的 plan 行。 */
function keyPlan(keys, extraArgv = []) {
  const argv = ['key', '--keys', keys, '--hwnd', HWND, '--dry-run', ...extraArgv]
  const result = runCli(argv)
  assert.equal(result.code, 0, `key --keys ${keys} 应退出 0；stderr=${result.stderr}`)
  const plan = []
  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith('PLAN_KEY ')) continue
    const m = /^PLAN_KEY (\d+) \| (.*?) \| PHASE=(\S*) \| PATH=(\S*) \| VK=(\d*) \| SCAN=(\d*) \| FLAGS=(\d*)$/.exec(line)
    assert.ok(m, `plan 行形状不符（键名/顺序变了就更新这条断言）：${line}`)
    plan.push({
      index: Number(m[1]),
      name: m[2],
      phase: m[3],
      path: m[4],
      vk: Number(m[5]),
      scan: Number(m[6]),
      flags: Number(m[7]),
      line,
    })
  }
  const expected = /^EXPECTED_EVENTS=(\d+)$/m.exec(result.stdout)
  assert.ok(expected, 'dry-run 必须给 EXPECTED_EVENTS')
  return { plan, expectedEvents: Number(expected[1]), stdout: result.stdout }
}

/** 组合键的期望：修饰键在前（virtual、无 Unicode 标志），载荷键必须是 virtual key。 */
const CHORD_CASES = [
  { keys: 'ctrl+a', payload: { name: 'a', vk: 0x41 }, modifiers: [0x11] },
  { keys: 'ctrl+s', payload: { name: 's', vk: 0x53 }, modifiers: [0x11] },
  { keys: 'ctrl+c', payload: { name: 'c', vk: 0x43 }, modifiers: [0x11] },
  { keys: 'ctrl+v', payload: { name: 'v', vk: 0x56 }, modifiers: [0x11] },
  { keys: 'ctrl+z', payload: { name: 'z', vk: 0x5a }, modifiers: [0x11] },
  { keys: 'alt+f', payload: { name: 'f', vk: 0x46 }, modifiers: [0x12] },
  { keys: 'ctrl+shift+a', payload: { name: 'a', vk: 0x41 }, modifiers: [0x11, 0x10] },
]

for (const item of CHORD_CASES) {
  test(`组合键 ${item.keys}：单字符走 virtual key，plan 里不许出现 KEYEVENTF_UNICODE`, () => {
    const { plan, expectedEvents } = keyPlan(item.keys)
    // 1) 这一组里一个 Unicode 直送都不许有。
    for (const keyEvent of plan) {
      assert.notEqual(keyEvent.flags, KEYEVENTF_UNICODE, `${item.keys} 的 ${keyEvent.name} 走了 Unicode 直送 —— 修饰键会被绕过：${keyEvent.line}`)
    }
    assert.equal(plan.some((k) => k.line.includes('KEYEVENTF_UNICODE')), false, '组合键的 plan 不许提到 KEYEVENTF_UNICODE')
    // 2) 发射顺序：修饰键**全部按下** → 载荷键 down/up → 修饰键**反向**抬起。
    //    这是本轮的阻断项：旧实现是逐键各发一对 down/up，于是 `ctrl+a` 实际成了
    //    `ctrl↓ ctrl↑ a↓ a↑` —— 修饰键被"点一下"就松开，靶侧只看到一个裸 `a`。
    const expectedPhases = [
      ...item.modifiers.map(() => 'modifier-down'),
      'key-down',
      'key-up',
      ...item.modifiers.map(() => 'modifier-up'),
    ]
    assert.deepEqual(plan.map((k) => k.phase), expectedPhases, `${item.keys} 的发射顺序（PHASE 列）`)
    // 3) 修饰键：按下按书写顺序，抬起是它的逆序；都是 virtual、scan=0、无 Unicode 标志。
    const modifierEvents = plan.filter((k) => k.path === 'modifier')
    assert.deepEqual(modifierEvents.slice(0, item.modifiers.length).map((k) => k.vk), item.modifiers, `${item.keys} 修饰键按下顺序`)
    assert.deepEqual(modifierEvents.slice(item.modifiers.length).map((k) => k.vk), [...item.modifiers].reverse(), `${item.keys} 修饰键抬起顺序应为逆序`)
    for (const mod of modifierEvents) {
      assert.equal(mod.scan, 0)
      assert.equal(mod.flags, 0)
    }
    // 4) 载荷键：必须是 VK_*（字母用大写码），不是字符直送；且被修饰键夹在中间。
    const payload = plan[item.modifiers.length]
    assert.equal(payload.phase, 'key-down')
    assert.equal(payload.name, item.payload.name)
    assert.equal(payload.vk, item.payload.vk, `${item.keys} 的载荷键应为 VK_${item.payload.name.toUpperCase()}`)
    assert.equal(payload.scan, 0, 'virtual key 路径的 scan 必须是 0（字符才放 scan）')
    assert.equal(payload.path, 'char-as-vk', '单字符在组合键里必须标记成 char-as-vk')
    const payloadUp = plan[item.modifiers.length + 1]
    assert.equal(payloadUp.phase, 'key-up')
    assert.equal(payloadUp.vk, item.payload.vk, '抬起的是同一个 virtual key')
    // 5) 计划的事件数 == 实际构造的事件数（每个描述符正好一个事件：按下或抬起）。
    assert.equal(expectedEvents, plan.length, `${item.keys} 的 EXPECTED_EVENTS 应与逐键 plan 一致`)
  })
}

test('无修饰键的单字符保留 Unicode 直送（语义正确，不许被"修"成 VK）', () => {
  const { plan, expectedEvents } = keyPlan('a')
  assert.equal(plan.length, 2, '没有修饰键时退化为逐键 down/up：一个描述符两个事件')
  assert.deepEqual(plan.map((k) => k.phase), ['key-down', 'key-up'])
  assert.equal(plan[0].path, 'unicode')
  assert.equal(plan[0].vk, 0, 'Unicode 路径的 wVk 必须是 0')
  assert.equal(plan[0].scan, 97, "wScan 是字符本身（'a'=97），与键盘布局无关")
  assert.equal(plan[0].flags, KEYEVENTF_UNICODE)
  assert.equal(expectedEvents, 2)
})

test('`key --keys A` 打出的是大写 A：Unicode 路径不许把 token 小写化', () => {
  // 修前：$lower 被当成要发送的字符 ⇒ `key A` 实际打出 `a`（"大写打不出来"的另一条路）。
  const upper = keyPlan('A')
  assert.equal(upper.plan[0].path, 'unicode')
  assert.equal(upper.plan[0].scan, 65, "大写 A（65）必须原样保留")
  const lower = keyPlan('a')
  assert.equal(lower.plan[0].scan, 97)
})

test('`key --keys shift+a` 产生大写 A：靠按住 shift，而不是靠把 a 换成 A', () => {
  const { plan } = keyPlan('shift+a')
  assert.deepEqual(plan.map((k) => k.phase), ['modifier-down', 'key-down', 'key-up', 'modifier-up'])
  assert.deepEqual(plan.map((k) => k.vk), [0x10, 0x41, 0x41, 0x10])
  assert.deepEqual(plan.map((k) => k.path), ['modifier', 'char-as-vk', 'char-as-vk', 'modifier'])
  // 载荷键仍然是小写 a 的 virtual key（VK_A=0x41），大写由按住的 shift 决定；
  // 若哪天有人改成"发送大写字符"，Ctrl+Shift+A / Shift+A 的语义就会分叉。
  assert.equal(plan[1].name, 'a')
  assert.equal(plan[1].flags, 0)
  // shift 必须**一直按到载荷键抬起之后**才松开 —— 真机上 shift+a 出小写正是它被提前松开的后果。
  assert.ok(plan.findIndex((k) => k.phase === 'modifier-up') > plan.findIndex((k) => k.phase === 'key-up'))
})

test('命名键与标点：命名键走 virtual，标点经 VkKeyScan 随当前键盘布局', () => {
  const named = keyPlan('ctrl+enter')
  assert.deepEqual(named.plan.map((k) => [k.phase, k.path, k.vk]), [
    ['modifier-down', 'modifier', 0x11],
    ['key-down', 'named', 13],
    ['key-up', 'named', 13],
    ['modifier-up', 'modifier', 0x11],
  ])
  const f5 = keyPlan('f5')
  assert.deepEqual(f5.plan.map((k) => [k.phase, k.path, k.vk]), [
    ['key-down', 'named', 116],
    ['key-up', 'named', 116],
  ])
  assert.equal(f5.plan[0].flags, 0)
  // 标点必须自己算：本机（US 布局）+ Ctrl+/ 是 VK_OEM_2 = 0xBF。硬编码 ASCII 码会打空。
  const slash = keyPlan('ctrl+/')
  assert.equal(slash.plan[1].path, 'char-as-vk')
  assert.ok(slash.plan[1].vk > 0, '标点必须能映射成 virtual key')
  assert.notEqual(slash.plan[1].vk, 0x2f, '不许把字符码当 virtual key 用')
  assert.deepEqual(slash.plan.map((k) => k.phase), ['modifier-down', 'key-down', 'key-up', 'modifier-up'])
})

test('未知键名 fail-closed：不许变成"发个 NUL 字符还报成功"', () => {
  // 修前：`key --keys nosuchkey` 计划 2 个事件、退出 0，真跑发一个 wScan=0 的 Unicode 事件
  // —— 靶侧什么都不会收到，而 CLI 报的是成功。
  const result = runCli(['key', '--keys', 'nosuchkey', '--hwnd', HWND, '--dry-run'])
  assert.equal(result.code, 1, `应退出 1；stdout=${result.stdout}`)
  assert.match(result.stderr, /unknown key name: 'nosuchkey'/)
  assert.match(result.stderr, /ctrl\+a/, '报错要给可用写法')
  assert.equal(result.stdout.includes('PLAN_KEY'), false)
})

// ── 静态守卫：单一真相源与"plan 与实际同源"在源码层钉住 ────────────────────────────
const bridgeSource = fs.readFileSync(BRIDGE, 'utf8')

function bridgeKeysBranch() {
  const start = bridgeSource.indexOf("} elseif ($Keys -ne '') {")
  assert.ok(start > 0, '找不到 key 注入分支')
  const end = bridgeSource.indexOf('\n  } else {', start)
  assert.ok(end > start, '找不到 key 注入分支的结尾')
  return bridgeSource.slice(start, end)
}

test('静态守卫：「这一组有没有修饰键」只算一次（单一真相源）', () => {
  assert.match(bridgeSource, /\$hasModifier = \$modKeys\.Count -gt 0/, '修饰键存在性必须有唯一的计算点')
  assert.match(bridgeSource, /if \(-not \$hasModifier\) \{/, '字符走 Unicode 还是 virtual 必须由这一个开关决定')
  // 老形状（按 token 长度直接产出 char spec、与修饰键无关）不许回来。
  assert.equal(
    /elseif \(\$lower\.Length -eq 1\) \{\s*\r?\n\s*\[void\]\$specs\.Add\(\[ordered\]@\{ name = \$token; kind = 'char'; char = \$lower/.test(bridgeSource),
    false,
    '单字符的分类不许再与修饰键无关',
  )
  assert.equal(bridgeSource.includes("kind = 'char'; char = $lower"), false, 'Unicode 路径不许再把字符小写化')
})

test('静态守卫：plan 与真跑共用同一批键事件描述符（I10b/I7k）', () => {
  assert.match(bridgeSource, /function ConvertTo-KeyEvent \{/, '必须有唯一的 spec → (vk, scan, flags) 转换点')
  const branch = bridgeKeysBranch()
  assert.match(branch, /\$keyEvents = @\(ConvertTo-KeySequence -Specs \$specs\)/, 'key 分支必须一次构造有序事件序列')
  assert.match(branch, /\$plan\['keys'\] = \$keyEvents/, 'plan 必须直接引用同一批描述符')
  assert.match(branch, /New-KeyInput -VirtualKey \$event\.vk -Scan \$event\.scan -Flags \$event\.flags/, '注入必须从描述符读三个字段')
  // key 分支里不许再出现写死的 Unicode 标志：那正是"计划看着对、实际不是那回事"的来源。
  assert.equal(branch.includes('-Flags 4'), false, 'key 分支不许再写死 -Flags 4')
  assert.equal(branch.includes('$spec.char'), false, 'key 分支不许自己从 spec 拆字符')
})

test('静态守卫：标点用 VkKeyScan（随布局），不是硬编码字符码', () => {
  assert.match(bridgeSource, /public static extern short VkKeyScan\(char ch\)/, 'VkKeyScan 必须声明')
  assert.match(bridgeSource, /\[DesktopBridge\.Native\]::VkKeyScan\(\[char\]\$Char\)/, 'Get-CharVirtualKey 必须真的调用它')
})

test('静态守卫：发射顺序由 ConvertTo-KeySequence 一次算好，且抬起由 PHASE 决定', () => {
  assert.match(bridgeSource, /function ConvertTo-KeySequence \{/, '必须有唯一的"描述符 → 有序事件序列"转换点')
  assert.match(bridgeSource, /\['phase'\] = 'modifier-down'/)
  assert.match(bridgeSource, /\['phase'\] = 'key-down'/)
  assert.match(bridgeSource, /\['phase'\] = 'key-up'/)
  assert.match(bridgeSource, /\['phase'\] = 'modifier-up'/)
  // 修饰键抬起必须是逆序（从最后一个修饰键往回）。
  assert.match(bridgeSource, /for \(\$i = \$mods\.Count - 1; \$i -ge 0; \$i--\)/, '修饰键抬起必须是逆序')
  const branch = bridgeKeysBranch()
  // 注入循环只许从描述符取字段，且"这是按下还是抬起"必须读 phase —— 老形状（每个描述符连发
  // down+up 一对）正是 `ctrl↓ ctrl↑ a↓ a↑` 的来源，不许回来。
  assert.match(branch, /New-KeyInput -VirtualKey \$event\.vk -Scan \$event\.scan -Flags \$event\.flags -Up \$isUp/, '注入必须按 phase 决定按下/抬起')
  assert.match(branch, /\$isUp = \(\$event\.phase -eq 'key-up' -or \$event\.phase -eq 'modifier-up'\)/)
  assert.equal(
    /New-KeyInput -VirtualKey \$event\.vk -Scan \$event\.scan -Flags \$event\.flags -Up \$false\)\)\s*\r?\n\s*\[void\]\$inputs\.Add\(\(New-KeyInput[^\n]*-Up \$true\)\)/.test(branch),
    false,
    '不许回到"每个描述符各发一对 down+up"的老形状',
  )
})

test('无法映射成 virtual key 的字符 fail-closed，不许发一个 wScan=0 的事件还报成功', () => {
  // bridge.ps1 的 `$vk -eq 0` 分支：Fail + return @()。本机（US 布局）`VkKeyScan('☃')` 返回 -1。
  const result = runCli(['key', '--keys', 'ctrl+☃', '--hwnd', HWND, '--dry-run'])
  if (result.code === 0) {
    // 若某个布局真能一键打出 ☃，这条路也必须给出真实 vk（绝不能 vk=0 还报成功）。
    const { plan } = keyPlan('ctrl+☃')
    assert.ok(plan[1].vk > 0 && plan[1].flags === 0, '要么 fail-closed，要么给真实 virtual key')
  } else {
    assert.equal(result.code, 1, `应退出 1；stdout=${result.stdout}`)
    assert.match(result.stderr, /cannot be sent as part of a chord on the active keyboard layout/)
    assert.match(result.stderr, /--text/, '报错要给替代做法')
    assert.equal(result.stdout.includes('PLAN_KEY'), false, 'fail-closed 时不许打出 plan')
  }
})

test('静态守卫：不可映射字符必须是 Fail + 空返回（fail-closed），不是静默发 wScan=0', () => {
  assert.match(bridgeSource, /if \(\$vk -eq 0\) \{/, '必须有 vk=0 的判定')
  assert.match(bridgeSource, /this character cannot be sent as part of a chord on the active keyboard layout/, '必须有明确报错')
  assert.match(bridgeSource, /Fail \("this character cannot be sent as part of a chord[\s\S]{0,400}?\n\s*return @\(\)/, '报错后必须空返回（不许继续造事件）')
})

test('报错文本里列举的键名与 $named 表同步（新增命名键忘了改文案就红）', () => {
  // 从源码取 $named 表与那句 Fail 的可用键名清单，逐条核对：字面列出、或是同义别名（同 VK）、
  // 或被 f1-f12 这样的区间覆盖。加一个新命名键而不改文案，这条会立刻红。
  const tableStart = bridgeSource.indexOf('$named = @{')
  assert.ok(tableStart > 0, '找不到 $named 表')
  const tableEnd = bridgeSource.indexOf('\n  }', tableStart)
  assert.ok(tableEnd > tableStart, '找不到 $named 表结尾')
  const named = new Map()
  for (const m of bridgeSource.slice(tableStart, tableEnd).matchAll(/'([a-z0-9]+)'\s*=\s*(\d+)/g)) named.set(m[1], Number(m[2]))
  assert.ok(named.size >= 20, `$named 表应有 20 个以上命名键，实际 ${named.size}`)
  const messageMatch = /one of: ([a-z0-9 \-]+)"/.exec(bridgeSource)
  assert.ok(messageMatch !== null, '找不到 "one of: …" 的可用键名清单')
  const listed = new Set(messageMatch[1].trim().split(/\s+/))
  const problems = []
  for (const [name, vk] of named) {
    if (listed.has(name)) continue
    const alias = [...listed].some((token) => named.get(token) === vk)
    if (alias) continue
    const range = /f(\d+)-f(\d+)/.exec(messageMatch[1])
    const fn = /^f(\d+)$/.exec(name)
    if (range !== null && fn !== null && Number(fn[1]) >= Number(range[1]) && Number(fn[1]) <= Number(range[2])) continue
    problems.push(`${name}(${vk})`)
  }
  assert.deepEqual(problems, [], `这些命名键在报错文案里没有出路（字面、别名或 f 区间）：${problems.join(' ')}`)
})
// 内容快照的**安全路径**：静态守卫 + 崩溃通道 + 缺测不得谎报。
//
// 背景（真机实测，design.md 的 I7e）：`Read-ElementContent` 里曾经有一条
// `TextPattern.GetSelection()[0].GetText(-1)`。它抛的是 corrupted-state 级的
// AccessViolationException —— PowerShell 的 `try/catch` **抓不住**，整个 powershell.exe 当场
// 退出（exit=3221225477），`-Out` 文件根本没写出来。而当时这条读数住在 `verify` 里，于是
// **每一条注入类命令的 before 快照都被它带崩**：click/move/type/key/scroll/invoke 六条命令
// 统一报 `ERROR=bridge 没写出结果文件（exit=3221225477）`，连 SendInput 都没走到。
//
// 这个文件钉四件事：
//   1. 那条调用**不许回来**（源码级守卫，静态审查看不出来的东西只能靠机检）；
//   2. 内容探针**不许再住进 verify**（隔离必须是真的：它是独立子进程，崩了只丢一条读数）；
//   3. 子进程崩了时通道层给 `{ok:false, exitCode}` 而不是抛，判据层给 `unknown` 而不是 `false`；
//   4. 第十二轮删掉的"旧语义"（`RealChildWindowFromPoint` / `leafHwnd`）不许回来，且
//      `bridge.ps1` 的 ASCII-only / 无 BOM / LF-only（红线 6）不许破 —— 这两条以前只有
//      一条手工 `node -e` 命令与"人记得别加回来"做载体，一次回归保护都没有。

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { DYING_BRIDGE, MODULE_ROOT, readBridgeSource, runCli, parseKeyValues } from './helpers.mjs'
import { BridgeError, crashExitName, probeBridge, runBridge } from '../lib/bridge.mjs'
import { applyContentSnapshot, changeVerdict, compareStates } from '../lib/verify.mjs'

/** 取出 `function <name> {` 到下一个顶层 `function ` 之间的源码。 */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name} {`)
  assert.notEqual(start, -1, `bridge.ps1 里找不到 function ${name}`)
  const rest = source.slice(start)
  const end = rest.indexOf('\nfunction ', 1)
  return end === -1 ? rest : rest.slice(0, end)
}

test('静态守卫：bridge.ps1 里不许再出现 UIA 的 range 文本方法（那次 AV 的源头）', () => {
  const source = readBridgeSource()
  // 注释里当然会提到它们（那段 POLICY 就是给后来者看的），只查会被执行的代码行。
  const codeOnly = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
  for (const banned of ['GetText(', 'GetSelection(', 'GetBoundingRectangles(', 'DocumentRange']) {
    assert.equal(
      codeOnly.includes(banned),
      false,
      `bridge.ps1 的代码里出现了 ${banned} —— 这类 UIA 方法能抛 try/catch 抓不住的 ` +
        'AccessViolationException（真机 exit=3221225477）。要读文本请换属性读法，或把调用隔离进独立子进程。',
    )
  }
  // POLICY 注释必须在，否则下一个人会再把 GetText 加回来。
  assert.ok(
    source.includes('POLICY -- paid for with a real crash'),
    'Read-ElementContent 的 POLICY 注释不见了：它是"只许读属性、不许调 range 方法"的唯一载体',
  )
  assert.ok(source.includes('exit=3221225477'), 'POLICY 注释里要留真机的退出码，缺了就没有说服力')
})

test('静态守卫：内容探针必须是独立命令，不许再住进 verify', () => {
  const source = readBridgeSource()
  const verifyBody = functionBody(source, 'Invoke-VerifyCommand')
  assert.equal(
    verifyBody.includes('Get-ContentSnapshot'),
    false,
    'Invoke-VerifyCommand 里又调 Get-ContentSnapshot 了：内容读数一旦住回 verify，' +
      '它崩掉就会把 before 快照（以及后面的注入）一起带走 —— 真机六条命令全堵死就是这么来的',
  )
  const snapshotBody = functionBody(source, 'Invoke-SnapshotCommand')
  assert.ok(
    snapshotBody.includes('Get-ContentSnapshot'),
    'Invoke-SnapshotCommand 里没有读内容快照，那这个命令就没意义了',
  )
  // 零副作用：这条命令不许碰注入与前台
  for (const forbidden of ['Send-Inputs', 'SetForegroundWindow', 'Raise-Window', 'AttachThreadInput']) {
    assert.equal(
      snapshotBody.includes(forbidden),
      false,
      `snapshot 命令不许有副作用，但它调了 ${forbidden}`,
    )
  }
})

// ── 第十二轮删掉的"旧语义"与 bridge.ps1 的字节形态：机器守卫 ──────────────────────────
//
// 背景：第十二轮从 bridge.ps1 删掉了 `RealChildWindowFromPoint` 的调用与 P/Invoke 声明、
// 以及它留下的 `leafHwnd` 字段（96353 → 96321 字节，`bridge.ps1:1003` 刻意留了一条说明性注释）。
// 但那次删除**不在任何机器守卫覆盖范围内**：当时 136 项全量测试对这一个字节的信息量都没有，
// 谁把这段代码改回来都不会变红。下面把那次删除、以及红线 6 的字节形态钉成判据。

/** 会走进"旧语义"的标识符：一个是被删掉的 P/Invoke，一个是它留下的字段名。 */
const LEGACY_LEAF_IDENTIFIERS = ['RealChildWindowFromPoint', 'leafHwnd']

/** 守卫自己的实现文件 —— 必须在扫描范围之外，否则守卫把自己抓成红的。 */
const LEGACY_LEAF_GUARD_FILE = path.join('test', 'content-safety.test.mjs')

/**
 * 剥掉**整行**注释：`#`（PowerShell）与 `//`（JS），行号保持不变。
 *
 * 只剥整行注释是刻意的：`bridge.ps1:1003` 那条 NOTE 就是整行注释，而尾随注释
 * （`$x = 1  # …`）一律按代码算 —— 那样最多产生一次"把注释搬到独立行"的假阳性，不会漏报真代码。
 */
function stripFullLineComments(text) {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart()
      return trimmed.startsWith('#') || trimmed.startsWith('//') ? '' : line
    })
    .join('\n')
}

/**
 * 断言一段源码里没有旧语义标识符。
 *
 * @param {string} text 源码原文
 * @param {string} label 报错时的定位标签（相对路径）
 * @param {{ stripComments?: boolean }} [opts] 默认剥掉整行注释再查；给 `false` ⇒ 连注释一起查
 *   （Node 侧那几份文件连注释里都不该提这些名字）。
 */
export function assertNoLegacyLeafSource(text, label, { stripComments = true } = {}) {
  const scanned = stripComments ? stripFullLineComments(text) : text
  for (const name of LEGACY_LEAF_IDENTIFIERS) {
    assert.equal(
      scanned.includes(name),
      false,
      `${label} 里出现了 ${name} —— 这段"旧语义"已在第十二轮删除：` +
        '`RealChildWindowFromPoint` 的 `pt` 要的是**接收窗口的客户区坐标**，' +
        '而这里传的是屏幕坐标，只有"巧合正确"的返回值（design.md I7g）；' +
        '`leafHwnd` 字段经全仓核实无消费方。要把它加回来，请连本守卫一起改，' +
        '并在 design.md / testing-guide.md 里说明这次它为什么有消费方。',
    )
  }
}

/** 守卫的扫描范围：显式列白名单，天然不含 `test/`，守卫自己也不在范围内。 */
function legacyLeafScanTargets() {
  const rel = [
    'cli.mjs',
    path.join('scripts', 'bridge.ps1'),
    ...readdirSync(path.join(MODULE_ROOT, 'lib'))
      .filter((name) => name.endsWith('.mjs'))
      .sort()
      .map((name) => path.join('lib', name)),
  ]
  for (const one of rel) {
    assert.notEqual(one, LEGACY_LEAF_GUARD_FILE, `守卫的扫描范围里不许有它自己：${one}`)
    assert.equal(
      one === 'test' || one.startsWith(`test${path.sep}`),
      false,
      `守卫的扫描范围里不许有 test/ 下的文件：${one}`,
    )
  }
  return rel
}

test('静态守卫：剥掉注释后，旧语义（RealChildWindowFromPoint / leafHwnd）不许回来', () => {
  const targets = legacyLeafScanTargets()
  assert.ok(targets.length >= 3, `扫描范围不该是空的：${targets.join(', ')}`)
  for (const rel of targets) {
    const abs = path.join(MODULE_ROOT, rel)
    assert.ok(existsSync(abs), `扫描目标不存在：${rel}`)
    const text = readFileSync(abs, 'utf8')
    // bridge.ps1 允许**注释里**提到它们（`bridge.ps1:1003` 那条 NOTE 是刻意留的）；
    // cli.mjs 与 lib/*.mjs 连注释里都不许有。
    assertNoLegacyLeafSource(text, rel, { stripComments: rel.endsWith('.ps1') })
  }
  // 反向自证：那条刻意保留的 NOTE 必须在（否则"剥注释后没有"就成了空话，
  // 而且下一个人不知道这个 API 的坐标系语义）。
  assert.ok(
    readBridgeSource().includes('RealChildWindowFromPoint'),
    'bridge.ps1:1003 那条说明性注释不见了：它是"这个 API 要客户区坐标"的唯一就地载体',
  )
})

test('反证：注入旧语义的文本必须让守卫抛错（否则守卫永远绿）', () => {
  // 一段带注释的假源码：注释里出现这两个名字**不算数**（真实 bridge.ps1:1003 就是这种），
  // 只有落在代码行上才该红。
  const fakeSource = (codeLine) =>
    [
      '# NOTE: RealChildWindowFromPoint() and leafHwnd are mentioned in this comment on purpose.',
      '// Node 侧的注释里提一下同样不算数。',
      'function Invoke-FakeCommand {',
      '  $point = New-Object DesktopBridge.POINT',
      `  ${codeLine}`,
      '}',
    ].join('\n')

  for (const [name, line] of [
    ['RealChildWindowFromPoint', '$leaf = RealChildWindowFromPoint($hwnd, $point)'],
    ['leafHwnd', "$report.leafHwnd = ('0x{0:x}' -f $hwnd.ToInt64())"],
  ]) {
    let error = null
    try {
      assertNoLegacyLeafSource(fakeSource(line), `fake-injected:${name}`)
    } catch (caught) {
      error = caught
    }
    assert.ok(error !== null, `注入的 ${name} 没有被守卫抓住 —— 这个守卫是永远绿的`)
    assert.match(error.message, new RegExp(name))
    assert.match(error.message, /第十二轮/)
    console.log(`[反证 红] 注入 ${name} ⇒ 守卫抛错：${error.message.split('\n')[0]}`)
    // 对照：同一条文本把它放回注释行 → 必须不抛（证明上面的红来自代码行，不是来自注释）。
    assert.doesNotThrow(() =>
      assertNoLegacyLeafSource(fakeSource(`# ${line}`), `fake-commented:${name}`),
    )
  }
})

test('反证：当前真实的 bridge.ps1 必须让守卫通过（同一条函数的绿的那一侧）', () => {
  const source = readBridgeSource()
  assert.doesNotThrow(() => assertNoLegacyLeafSource(source, 'scripts/bridge.ps1'))
  // 而它的注释里确实还有这两个名字（剥注释这一步是这条守卫成立的前提）。
  assert.ok(source.includes('RealChildWindowFromPoint'), '注释放进假源码之前，先确认真源码里注释确实存在')
  assert.ok(source.includes('leaf"'), 'bridge.ps1:1003 的 NOTE 里那个 "leaf" handle 不见了')
  console.log(
    `[反证 绿] 真实 scripts/bridge.ps1(${Buffer.byteLength(source)} 字节) ⇒ 守卫通过（不抛）`,
  )
})

test('静态守卫（红线 6）：bridge.ps1 必须 ASCII-only、无 BOM、LF-only', () => {
  const bytes = readFileSync(path.join(MODULE_ROOT, 'scripts', 'bridge.ps1'))
  assert.equal(
    bytes[0],
    0x23,
    `首个字节应当是无 BOM 的 '#'(0x23)，得到 0x${bytes[0].toString(16)} —— 带 BOM 会让 Windows ` +
      'PowerShell 5.1 之外的读取方多出三个字节',
  )
  const nonAscii = []
  let crCount = 0
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] > 127) nonAscii.push(i)
    if (bytes[i] === 0x0d) crCount += 1
  }
  assert.deepEqual(
    nonAscii.slice(0, 8),
    [],
    `bridge.ps1 里有 ${nonAscii.length} 个非 ASCII 字节（首个偏移 ${nonAscii[0]}）：` +
      'Windows PowerShell 5.1 按系统 ANSI 代码页解无 BOM 脚本，非 ASCII 会让引号配对失配，' +
      '报出的错与真实原因无关。非 ASCII 只许经 -Text / JSON 字段传入',
  )
  assert.equal(
    crCount,
    0,
    `bridge.ps1 里有 ${crCount} 个 CR(0x0d) —— 这份脚本必须是 LF-only`,
  )
  console.log(
    `[红线 6] bytes=${bytes.length} first=0x${bytes[0].toString(16)} ` +
      `nonAscii=0 cr=${crCount} ⇒ ASCII-only / 无 BOM / LF-only`,
  )
})

test('crashExitName：真机那个退出码要认得出，普通失败码不许冒充崩溃', () => {
  assert.equal(crashExitName(3221225477), 'STATUS_ACCESS_VIOLATION (0xC0000005)')
  assert.equal(crashExitName(-1073741819), 'STATUS_ACCESS_VIOLATION (0xC0000005)')
  assert.equal(crashExitName(0xc00000fd), 'STATUS_STACK_OVERFLOW (0xC00000FD)')
  assert.equal(crashExitName(0xc0000374), 'STATUS_HEAP_CORRUPTION (0xC0000374)')
  assert.equal(crashExitName(1), null)
  assert.equal(crashExitName(0), null)
  assert.equal(crashExitName(undefined), null)
  assert.equal(crashExitName(null), null)
})

test('通道层：子进程崩了给 {ok:false, exitCode}，不抛异常', () => {
  const probe = probeBridge({ Command: 'snapshot' }, { script: DYING_BRIDGE })
  assert.equal(probe.ok, false)
  assert.equal(probe.exitCode, 3221225477)
  assert.equal(probe.crashed, true)
  assert.equal(probe.crash, 'STATUS_ACCESS_VIOLATION (0xC0000005)')
  assert.match(probe.reason, /没写出结果文件/)
  assert.match(probe.reason, /3221225477/)
})

test('通道层：非容错的那条路照旧抛 BridgeError，但错误里要带 exitCode 与崩溃名', () => {
  let caught = null
  try {
    runBridge({ Command: 'snapshot' }, { script: DYING_BRIDGE })
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof BridgeError, 'runBridge 在子进程崩掉时应当抛 BridgeError')
  assert.match(caught.message, /exit=3221225477/)
  assert.match(caught.message, /STATUS_ACCESS_VIOLATION/)
  assert.equal(caught.detail.exitCode, 3221225477)
  assert.equal(caught.detail.crashed, true)
  // 崩溃路径也要删临时目录：以前只有成功路径删，%TEMP% 里漏了 496 个 adg-desktop-*
  assert.ok(caught.detail.files?.dir, 'BridgeError 的 detail 里要留 files，崩溃路径才能清理')
  assert.equal(
    existsSync(caught.detail.files.dir),
    false,
    `崩溃路径没有清理临时目录：${caught.detail.files.dir}`,
  )
})

test('applyContentSnapshot：读到了就并入，读不到记 failed 而不是 0 条', () => {
  const state = { contentRoot: '0x1234' }
  applyContentSnapshot(state, {
    ok: true,
    json: { snapshot: { root: '0xbeef', hash: 'abcd1234', count: 5, contentCount: 2, uia: true, note: '' } },
  })
  assert.equal(state.contentHash, 'abcd1234')
  assert.equal(state.contentCount, 5)
  assert.equal(state.contentBearingCount, 2)
  assert.equal(state.contentRoot, '0xbeef')
  assert.equal(state.contentProbeFailed, false)
  assert.equal(state.contentNote, '')

  const failed = { contentRoot: '0x1234' }
  applyContentSnapshot(failed, {
    ok: false,
    exitCode: 3221225477,
    crash: 'STATUS_ACCESS_VIOLATION (0xC0000005)',
    reason: 'bridge 没写出结果文件（exit=3221225477, STATUS_ACCESS_VIOLATION (0xC0000005)）：stderr 为空',
  })
  assert.equal(failed.contentProbeFailed, true)
  assert.equal(failed.contentBearingCount, 0)
  assert.equal(failed.contentHash, '')
  assert.equal(failed.uiaAvailable, false)
  assert.match(failed.contentNote, /没有返回读数/)
  assert.match(failed.contentNote, /3221225477/)
  assert.match(failed.contentNote, /unknown/)

  // 通道说 ok，但里面没有 snapshot 字段 —— 同样算缺测，不许当成"读到 0 条内容"。
  const odd = {}
  applyContentSnapshot(odd, { ok: true, json: { ok: true } })
  assert.equal(odd.contentProbeFailed, true)
})

test('判据层：内容探针崩了必须降级成 unknown，就算像素哈希还在也不许报 false', () => {
  const before = { foreground: '0x1', pixelHash: 'aaaa', contentRoot: '0x1' }
  const after = { foreground: '0x1', pixelHash: 'aaaa', contentRoot: '0x1' }
  applyContentSnapshot(before, { ok: true, json: { snapshot: { hash: 'h1', count: 2, contentCount: 1, uia: true } } })
  applyContentSnapshot(after, { ok: false, exitCode: 3221225477, reason: 'bridge 没写出结果文件（exit=3221225477…）' })

  const cmp = compareStates(before, after, { ignore: ['point'] })
  assert.equal(cmp.changed, false, '前后两次的内容 hash 只差在"后一次没读到"，不该算成界面变化')
  const verdict = changeVerdict(cmp, {})
  assert.equal(verdict.changed, 'unknown', '内容判据缺测时绝不许报 false')
  assert.match(verdict.reason, /缺测/)
  assert.match(verdict.reason, /3221225477/)

  // 对照：探针正常、内容也读到了 → 这时才允许报 false（"判据看见了，而它没变"）。
  const okBefore = { foreground: '0x1', pixelHash: 'aaaa' }
  const okAfter = { foreground: '0x1', pixelHash: 'aaaa' }
  applyContentSnapshot(okBefore, { ok: true, json: { snapshot: { hash: 'same', count: 2, contentCount: 1, uia: true } } })
  applyContentSnapshot(okAfter, { ok: true, json: { snapshot: { hash: 'same', count: 2, contentCount: 1, uia: true } } })
  assert.equal(changeVerdict(compareStates(okBefore, okAfter, { ignore: ['point'] }), {}).changed, 'false')
})

test('真机路径：snapshot 命令自己不许崩（崩了就是这条 AV 还没清干净）', () => {
  const result = runCli(['snapshot', '--timeout', '30000'], { timeoutMs: 60000 })
  const kv = parseKeyValues(result.stdout)
  // 这条判据的关键不是"读到了内容"，而是"子进程活着回来了并给了结论"：
  // SNAPSHOT_OK=false（例如受限令牌下 UIA 读被拒）是**可接受**的诚实结果，
  // 而 exit=3221225477 / 没有 SNAPSHOT_OK 行就意味着又崩了。
  assert.notEqual(result.code, 3221225477, `snapshot 子进程崩了：stderr=${result.stderr}`)
  assert.ok(
    kv.SNAPSHOT_OK === 'true' || kv.SNAPSHOT_OK === 'false',
    `snapshot 没有给出 SNAPSHOT_OK 结论（exit=${result.code}）：stdout=${result.stdout} stderr=${result.stderr}`,
  )
  assert.ok(result.code === 0 || result.code === 1, `snapshot 的退出码应当是 0 或 1，得到 ${result.code}`)
  if (kv.SNAPSHOT_OK === 'true') assert.equal(kv.CONTENT_PROBE ?? 'ok', 'ok')
})

test('真机路径：verify 与注入类命令的复核里要打得出来 CONTENT_PROBE=', () => {
  const result = runCli(['verify', '--no-pixel'], { timeoutMs: 60000 })
  assert.equal(result.code, 0, `verify 应当成功：stderr=${result.stderr}`)
  assert.match(result.stdout, /CONTENT_PROBE=(ok|failed)/)
  assert.match(result.stdout, /CONTENT_BEARING_COUNT=\d+/)
})

test('真机路径：--no-content 时探针没跑，必须写 skipped 并说明覆盖面变小', () => {
  const result = runCli(['verify', '--no-pixel', '--no-content'], { timeoutMs: 60000 })
  assert.equal(result.code, 0, `verify --no-content 应当成功：stderr=${result.stderr}`)
  // 打 ok 会让人以为"内容类判据这次是有效的"——那正是这条三态存在的理由。
  assert.match(result.stdout, /CONTENT_PROBE=skipped/)
  assert.doesNotMatch(result.stdout, /CONTENT_PROBE=ok/)
  assert.match(result.stdout, /CONTENT_HASH=-/)
  assert.match(result.stdout, /WARN=内容类判据这次被 --no-content 关掉了/)
})
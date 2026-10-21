// 判据可信度的契约测试（第五轮：几何自洽 / 按命令的内容判据 / 落点归属要有显式目标）。
//
// 这一组钉的是"输出里有没有那几行、以及那几行的取值有没有第二重含义"：
//   · `GEO_*` 四行 —— 两套几何读数不互相印证时，坐标类命令**注入前**就要停下（design.md I2b）。
//   · `TARGET_SOURCE=` —— `point`（这个点上的窗口）/ `foreground` / `--target-hwnd` 三者的"目标"
//     含义完全不同，不写清就会被读混。
//   · `LANDING_IN_TARGET=` —— 没有显式目标时**不许**给布尔（真机：前台是 A、点隔壁 B 也报"在目标内=true"）。
//   · `CONTENT_KINDS=` —— `scroll` 这类命令要的是特定的一类读数，总数会误导。
//
// 只跑只读命令与 `--dry-run`：**不发任何真实事件**。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseKeyValues, runCli } from './helpers.mjs'

const TIMEOUT = 120000

/** 跑一条命令并要求退出码 0。 */
function ok(argv, opts = {}) {
  const result = runCli(argv, { timeoutMs: opts.timeoutMs ?? TIMEOUT })
  assert.equal(result.code, 0, `${argv.join(' ')} 应当退出码 0；stderr=${result.stderr}`)
  return { ...result, kv: parseKeyValues(result.stdout), json: jsonOf(result.stdout) }
}

/** 取 `--json` 那一行。 */
function jsonOf(stdout) {
  const line = stdout.split('\n').find((text) => text.startsWith('JSON='))
  return line ? JSON.parse(line.slice('JSON='.length)) : null
}

const MISMATCH_VALUES = ['true', 'false', 'unknown']

/** 取窗口列表的第一行：`WIN <i> | <hwnd> | <pid> | <process> | <class> | <title> | <rect> | <il>`。 */
function firstWindow(stdout) {
  const line = String(stdout ?? '')
    .split('\n')
    .find((text) => text.startsWith('WIN '))
  if (!line) return null
  const parts = line.split('|').map((part) => part.trim())
  if (!/^0x[0-9a-f]+$/.test(parts[1] ?? '')) return null
  return { hwnd: parts[1], rect: parts[6] ?? '' }
}

/** 拿一个真实存在的顶层窗口（读只读的 `windows`）。没有窗口时跳过整条用例。 */
function firstHwnd(t) {
  const listed = runCli(['windows'], { timeoutMs: TIMEOUT })
  if (listed.code !== 0) {
    t.skip(`windows 跑不起来（exit=${listed.code}）：${listed.stderr.trim()}`)
    return null
  }
  const window = firstWindow(listed.stdout)
  if (window === null) {
    t.skip('这次没有可见窗口可比对')
    return null
  }
  return window.hwnd
}

test('point：四个 GEO_* 行都在，取值只能是 true|false|unknown，JSON 里带 geo', (t) => {
  const listed = runCli(['windows'], { timeoutMs: TIMEOUT })
  const window = listed.code === 0 ? firstWindow(listed.stdout) : null
  if (window === null) {
    t.skip('这次没有可见窗口可比对')
    return
  }
  // 用窗口列表里的第一个窗口中心当探针点：即使这个点被别的窗口盖住也无所谓 ——
  // 本组看的是"这两套读数有没有互相印证"，不是"点在谁身上"。
  const [left, top, width, height] = window.rect.split(',').map((n) => Number(n.trim()))
  const { kv, json } = ok([
    'point',
    '--x',
    String(left + Math.floor(width / 2)),
    '--y',
    String(top + Math.floor(height / 2)),
    '--json',
  ])

  for (const key of ['GEO_WINDOW_RECT', 'GEO_UIA_ROOT_RECT', 'GEO_POINT_RECT']) {
    assert.ok(key in kv, `point 少了 ${key} 行：\n${JSON.stringify(kv)}`)
  }
  assert.ok(MISMATCH_VALUES.includes(kv.GEO_MISMATCH), `GEO_MISMATCH 取值非法：${kv.GEO_MISMATCH}`)
  // 读数拿不到时写 `-`（空串）—— 这**不是**"一致"，所以 unknown 那一支必须带 WARN
  if (kv.GEO_MISMATCH === 'unknown') {
    assert.match(kv.WARN ?? '', /不能当成"几何一致"/)
  }
  assert.ok(json, 'point --json 没有 JSON= 行')
  assert.ok(json.geo && typeof json.geo === 'object', 'point --json 里少了 geo')
  assert.equal(typeof json.geo.rootRectMatches === 'boolean' || json.geo.rootRectMatches === null, true)
})

test('uia --hwnd：几何读数与窗口矩形并排打出来（没有查询点时不给 GEO_POINT_RECT）', (t) => {
  const hwnd = firstHwnd(t)
  if (hwnd === null) return
  const { kv, json } = ok(['uia', '--hwnd', hwnd, '--depth', '1', '--json'])
  assert.equal(kv.GEO_WINDOW_RECT !== undefined, true, 'uia --hwnd 没打 GEO_WINDOW_RECT')
  assert.equal(kv.GEO_UIA_ROOT_RECT !== undefined, true, 'uia --hwnd 没打 GEO_UIA_ROOT_RECT')
  assert.ok(MISMATCH_VALUES.includes(kv.GEO_MISMATCH), `GEO_MISMATCH 取值非法：${kv.GEO_MISMATCH}`)
  // 这条路径没有查询点，所以不打 GEO_POINT_RECT（打了就是"顺手编了一个判定"）
  assert.equal(kv.GEO_POINT_RECT, undefined)
  assert.ok(json.geo && typeof json.geo === 'object', 'uia --hwnd --json 里少了 geo')
  assert.equal(json.geo.hwnd, hwnd)
})

test('click --dry-run：--target-hwnd 解析得出来，落点归属给 not-evaluated 而不是布尔', (t) => {
  const hwnd = firstHwnd(t)
  if (hwnd === null) return
  // --force 是为了让这条用例**不受几何读数影响**（GEO_MISMATCH=true 时默认会在注入前停下，
  // 那条 fail-closed 分支本身由 geoVerdict 的纯函数用例与 design.md I2b 覆盖）。
  const { kv } = ok(['click', '--x', '100', '--y', '100', '--dry-run', '--no-pixel', '--force', '--target-hwnd', hwnd])
  assert.equal(kv.TARGET_SOURCE, '--target-hwnd')
  assert.equal(kv.TARGET_HWND, hwnd)
  assert.match(kv.TARGET_ROOT_HWND, /^0x[0-9a-f]+$/)
  assert.equal(kv.TARGET_IN_WINDOW_LIST, 'true')
  assert.equal(kv.LANDING_TARGET_HWND, hwnd)
  // 关键：dry-run 没发事件 ⇒ 落点归属无从评估，不许给 true/false（那会被读成"点对了"）
  assert.equal(kv.LANDING_IN_TARGET, 'not-evaluated')
  assert.equal(kv.PLAN_ONLY, 'true')
  // 干跑不许出现"真跑才有"的读数（I10b / 红线 10）
  assert.equal(kv.INSERTED_EVENTS, undefined)
  assert.equal(kv.EVENTS_MATCH_PLAN, undefined)
  assert.equal(kv.CONTENT_PROBE, undefined)
  // 唯一允许的 CHANGED 值与原因
  assert.equal(kv.CHANGED, 'false')
  assert.match(kv.WARN, /没有发送任何事件/)
})

test('click --dry-run：不给 --target-hwnd 时 TARGET_SOURCE 说实话且没有 TARGET_HWND', () => {
  const { kv } = ok(['click', '--x', '100', '--y', '100', '--dry-run', '--no-pixel', '--force'])
  assert.ok(['point', 'foreground'].includes(kv.TARGET_SOURCE), `TARGET_SOURCE 取值非法：${kv.TARGET_SOURCE}`)
  assert.equal(kv.TARGET_HWND, undefined)
  assert.equal(kv.LANDING_TARGET_HWND, undefined)
  assert.equal(kv.LANDING_IN_TARGET, 'not-evaluated')
})

test('verify：CONTENT_KINDS 逐类报数，六个键一个不少（缺的写 0，不省行）', () => {
  const { kv } = ok(['verify', '--no-pixel'])
  assert.match(kv.CONTENT_PROBE ?? '', /^(ok|failed|skipped)$/)
  const kinds = parseKinds(kv.CONTENT_KINDS)
  for (const key of ['value', 'scroll', 'rangeValue', 'toggle', 'selected', 'ancestorScroll']) {
    assert.equal(Number.isFinite(kinds[key]), true, `CONTENT_KINDS 少了 ${key} 类：${kv.CONTENT_KINDS}`)
  }
  // 受限会话里读不到任何内容类读数，那一类就是 0；此时"看得见没变"必须靠像素撑着
  if (kinds.scroll === 0 && kinds.value === 0) {
    assert.equal(kv.CONTENT_PROBE === 'ok' || kv.CONTENT_PROBE === 'failed', true)
  }
})

test('snapshot：内容读数也逐类报数（scroll 判据的来源）', () => {
  const { kv } = ok(['snapshot'])
  assert.equal(kv.SNAPSHOT_OK === 'true' || kv.SNAPSHOT_OK === 'false', true)
  const kinds = parseKinds(kv.CONTENT_KINDS)
  assert.equal(Number.isFinite(kinds.scroll), true, `snapshot 的 CONTENT_KINDS 少了 scroll：${kv.CONTENT_KINDS}`)
})

/** 解析 `value=1,scroll=2` 这种形状。 */
function parseKinds(text) {
  const out = {}
  for (const part of String(text ?? '').split(',')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    out[part.slice(0, eq).trim()] = Number(part.slice(eq + 1))
  }
  return out
}
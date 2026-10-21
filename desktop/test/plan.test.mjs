// 第三轮返工的两条口径：**plan 与实际必须同源**、**截断不许说成"不存在"**。
//
// 背景（真机实测，不是推理）：
//   1. `click --double --force` 报 `INSERTED_EVENTS=3 CLICKS=1`，而 `--dry-run` 自报
//      `CLICKS=2 EXPECTED_EVENTS=5` —— plan 与实际各算各的，于是"计划"成了假证据。
//      现在 dry-run 走桥的同一条构造路径（`-PlanOnly`，不调 SendInput），期望值只有一个来源。
//   2. `invoke --id el_…` 在真实拥挤桌面上 11/11 全失败：id 取自桌面根快照，而那次遍历被预算
//      截断，目标窗口根本没进快照。报出来的却是"元素可能已消失" —— 把"没走到"说成了"不存在"。
//
// 这里只跑 `--dry-run` / 只读命令，**不发任何真实事件**。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseKeyValues, runCli } from './helpers.mjs'

/** 每条注入类命令：argv → 期望的事件数（与桥在同一路径上算出来的那个数比）。 */
const PLAN_CASES = [
  { name: 'click 单击', argv: ['click', '--x', '431', '--y', '280', '--dry-run'], kind: 'mouse', events: 3, extra: { BUTTON: 'left', DOUBLE: 'false', CLICKS: '1' } },
  { name: 'click 双击', argv: ['click', '--x', '431', '--y', '280', '--double', '--dry-run'], kind: 'mouse', events: 5, extra: { DOUBLE: 'true', CLICKS: '2' } },
  { name: 'click --clicks 3', argv: ['click', '--x', '431', '--y', '280', '--clicks', '3', '--dry-run'], kind: 'mouse', events: 7, extra: { CLICKS: '3' } },
  {
    name: 'move（只移指针，绝不点击）',
    argv: ['move', '--x', '431', '--y', '280', '--dry-run'],
    kind: 'mouse',
    events: 1,
    // 曾经的真缺陷：move 也会 append down/up（$Button 默认 left），而 JS 侧手写的 plan 说 1。
    // 把 plan 改成"由桥的同一条构造路径算"之后，这条读数才把缺陷暴露出来。
    extra: { BUTTON: '', CLICKS: '0', DOUBLE: 'false' },
  },
  // type/key 的 --hwnd 是必填的（design.md I7i）：键只发给前台窗口，不指名就可能打进别的窗口。
  // PLAN_FOCUS_SOURCE / PLAN_HWND 由桥从同一个 $Hwnd 算出 —— 这两行就是"CLI 到底有没有把
  // --hwnd 传下去"的判据（真出过：CLI 没把 Hwnd 放进 params，整条前台闸门永远到不了）。
  {
    name: 'type',
    argv: ['type', '--text', 'ABC', '--hwnd', '0x123456', '--dry-run'],
    kind: 'text',
    events: 6,
    extra: { CHARACTERS: '3', PLAN_FOCUS_SOURCE: 'hwnd', PLAN_HWND: '0x123456' },
  },
  {
    name: 'key',
    argv: ['key', '--keys', 'ctrl+s', '--hwnd', '0x123456', '--dry-run'],
    kind: 'key',
    events: 4,
    extra: { KEYS: 'ctrl+s', PLAN_FOCUS_SOURCE: 'hwnd', PLAN_HWND: '0x123456' },
  },
  { name: 'scroll', argv: ['scroll', '--x', '100', '--y', '100', '--dy', '-3', '--dry-run'], kind: 'mouse', events: 2, extra: { WHEEL_CLICKS: '-3', WHEEL_DW_DATA: '-360' } },
]

for (const item of PLAN_CASES) {
  test(`dry-run 的 plan 是唯一来源：${item.name} ⇒ EXPECTED_EVENTS=${item.events}`, () => {
    const result = runCli(item.argv)
    assert.equal(result.code, 0, `${item.name} 应退出 0；stderr=${result.stderr}`)
    const kv = parseKeyValues(result.stdout)
    assert.equal(kv.PLAN_ONLY, 'true', `${item.name} 必须走桥的 -PlanOnly 路径算期望值`)
    assert.equal(kv.PLAN_KIND, item.kind)
    assert.equal(kv.EXPECTED_EVENTS, String(item.events))
    for (const [key, value] of Object.entries(item.extra ?? {})) {
      assert.equal(kv[key], value, `${item.name} 的 ${key}`)
    }
    // dry-run 一个事件都不许发：不许出现"已插入"这类读数，
    // 更不许出现"实际 == 计划"的结论（没有实际可谈）。
    assert.equal(kv.INSERTED_EVENTS, undefined, `${item.name} 的 dry-run 不该报 INSERTED_EVENTS`)
    assert.equal(kv.EVENTS_MATCH_PLAN, undefined, `${item.name} 的 dry-run 不该下"实际==计划"的结论`)
    assert.match(result.stdout, /--dry-run：没有发送任何事件/)
  })
}

test('key 的组合键回显用用户输入的名字，不漏 `mod17` 这种内部标识', () => {
  const result = runCli(['key', '--keys', 'alt+shift+tab', '--hwnd', '0x123456', '--dry-run'])
  assert.equal(result.code, 0)
  const kv = parseKeyValues(result.stdout)
  assert.equal(kv.KEYS, 'alt+shift+tab')
  assert.equal(kv.EXPECTED_EVENTS, '6')
  assert.equal(kv.PLAN_FOCUS_SOURCE, 'hwnd')
})

test('uia --limit：截断必须明说 COUNT 是"走到的元素数"', () => {
  const result = runCli(['uia', '--limit', '3'])
  assert.equal(result.code, 0, result.stderr)
  const kv = parseKeyValues(result.stdout)
  assert.equal(kv.TRUNCATED, 'true')
  assert.equal(kv.COUNT, '3')
  assert.match(result.stdout, /不是桌面上的元素总数/)
})

test('invoke 在截断的快照里找不到 id：报"截断"，不报"元素不存在"（退出码 2）', () => {
  // el_00000000 的形状合法（el_ + 8 位十六进制），几乎必然不在快照里；
  // 关键是这一步的 **--limit 3** 会让快照处于 truncated 状态。
  const result = runCli(['invoke', '--id', 'el_00000000', '--limit', '3'])
  assert.equal(result.code, 2, `应退出 2；stdout=${result.stdout}`)
  const kv = parseKeyValues(result.stdout)
  assert.equal(kv.SNAPSHOT_TRUNCATED, 'true')
  assert.equal(kv.SNAPSHOT_SCOPE, 'hwnd=desktop-root depth=16 limit=3')
  assert.equal(kv.FOUND, 'false')
  assert.match(result.stderr, /快照被截断/)
  assert.match(result.stderr, /≠「这个元素不存在」/)
  // 反过来：这句错误里不许出现"元素可能已消失"这种越权结论。
  assert.equal(result.stderr.includes('元素可能已消失'), false)
})

test('快照作用域必须打出来：不给 --hwnd 时如实写 desktop-root', () => {
  const result = runCli(['invoke', '--id', 'el_00000000', '--hwnd', '0xdead', '--limit', '1'])
  assert.equal(result.code, 2)
  const kv = parseKeyValues(result.stdout)
  assert.equal(kv.SNAPSHOT_SCOPE, 'hwnd=0xdead depth=16 limit=1')
})
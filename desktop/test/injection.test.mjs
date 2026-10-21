// 注入路径的回归测试（**不发任何真实事件**）。
//
// 这一组钉住的是两个静态审查看不出来的缺陷，形态都是"赋值语句看起来完全正确、字节却是错的"：
//
//   1. PowerShell 对**嵌套值类型成员**给的是副本，所以 `$item.u.mi.dx = 42` 写进了一个被丢弃
//      的临时对象，结构体全零送出，而 SendInput 照样回"已插入 N 个事件"、GetLastError 照样 0。
//   2. 平铺布局下鼠标与键盘的 dwFlags 落在**不同**偏移：winuser.h 里 INPUT 的 union 从 8 开始，
//      MOUSEINPUT 是 `LONG dx; LONG dy; DWORD mouseData; DWORD dwFlags; ...` ⇒ dwFlags 在 20；
//      KEYBDINPUT 是 `WORD wVk; WORD wScan; DWORD dwFlags; ...` ⇒ dwFlags 在 **12**。
//      共用一个字段名就会把键盘那侧的 KEYEVENTF_UNICODE 静默清零 —— `type` / `key` 从此永不生效，
//      而 SendInput 一直报成功。
//
// 两种缺陷的判据都只能是**内存里的原始字节**，所以 `probe` 构造鼠标/键盘事件（含一个 keyup），
// 用与 Send-Inputs 完全相同的 StructureToPtr 编码，并且**同时**编一份 winuser.h 原样的嵌套 union
// 参照结构体，逐字节比对。偏移只要写错，`*_MATCHES_CANONICAL` 立刻是 false。
//
// 沙箱注意：输出走文件重定向（见 test/helpers.mjs）。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseKeyValues, runCli } from './helpers.mjs'

/** 十六进制串 → 字节数组。 */
function bytesOf(hex) {
  const out = []
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16))
  return out
}

/** 小端读一个 uint32（`offset` 是字节偏移）。 */
function u32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

function probe() {
  const result = runCli(['probe'], { timeoutMs: 60000 })
  assert.equal(result.code, 0, `probe 应当退出码 0；stderr=${result.stderr}`)
  return parseKeyValues(result.stdout)
}

test('INPUT 结构体尺寸是 40 字节（KEYBDINPUT 单独放会被 CLR 对齐成 32 ⇒ rc=0 err=87）', () => {
  const out = probe()
  assert.equal(out.INPUT_STRUCT_SIZE, '40')
  // 参照结构体（嵌套 union，winuser.h 原样）必须也是 40 —— 两个尺寸不同就说明平铺那侧对齐错了
  assert.equal(out.CANONICAL_STRUCT_SIZE, '40')
  // KEYBDINPUT 24 字节（成员最大 4 字节对齐）；MOUSEINPUT 裸算 24 字节，但含 IntPtr 成员
  // ⇒ CLR 按 8 字节对齐补到 32。两者都只是布局事实，钉住它们是为了任何一次"顺手整理
  // 结构体声明"都能当场红掉 —— 结构体一旦不是 40 字节，SendInput 就整条失效。
  assert.equal(out.MOUSE_INPUT_SIZE, '32')
  assert.equal(out.KEY_INPUT_SIZE, '24')
})

test('偏移常量与 winuser.h 一致：union 从 8 起，鼠标 dwFlags@20 而键盘 dwFlags@12', () => {
  const out = probe()
  // 这一条是"把偏移钉死在测试里"：任何人改动 struct 声明，这 12 个数字里只要动一个就红。
  // 依据 = Windows SDK 头文件 INPUT / MOUSEINPUT / KEYBDINPUT 的字段顺序（union 含 ULONG_PTR
  // ⇒ 8 字节对齐 ⇒ 起点 8）+ probe 与嵌套 union 参照结构体的逐字节比对。
  assert.equal(out.OFFSET_TYPE, '0')
  assert.equal(out.OFFSET_MOUSEDX, '8')
  assert.equal(out.OFFSET_MOUSEDY, '12')
  assert.equal(out.OFFSET_MOUSEDATA, '16')
  assert.equal(out.OFFSET_MOUSEFLAGS, '20')
  assert.equal(out.OFFSET_MOUSETIME, '24')
  assert.equal(out.OFFSET_MOUSEEXTRAINFO, '32')
  assert.equal(out.OFFSET_KEYVK, '8')
  assert.equal(out.OFFSET_KEYSCAN, '10')
  assert.equal(out.OFFSET_KEYFLAGS, '12')
  assert.equal(out.OFFSET_KEYTIME, '16')
  // 键盘的 dwExtraInfo 在 24，不是鼠标的 32：KEYBDINPUT 比 MOUSEINPUT 短 8 字节
  assert.equal(out.OFFSET_KEYEXTRAINFO, '24')
})

test('平铺 INPUT 与 winuser.h 原样的嵌套 union 逐字节相同（偏移正确性的直接判据）', () => {
  const out = probe()
  // 这是本组最强的判据：参照结构体由 CLR 自己按字段顺序算偏移，我们手写的 FieldOffset 必须
  // 编出完全一样的字节。整数偏移写错但"看起来合理"时，只有这一条会红。
  assert.equal(out.MOUSE_MATCHES_CANONICAL, 'true', `鼠标字节与参照布局不同；flat=${out.MOUSE_BYTES_HEX}`)
  assert.equal(out.KEY_MATCHES_CANONICAL, 'true', `键盘字节与参照布局不同；flat=${out.KEY_BYTES_HEX}`)
  assert.equal(out.KEY_UP_MATCHES_CANONICAL, 'true', `键盘 keyup 字节与参照布局不同；flat=${out.KEY_UP_BYTES_HEX}`)
  assert.equal(out.CANONICAL_MOUSE_BYTES_HEX, out.MOUSE_BYTES_HEX)
})

test('鼠标事件的字节里真的有 dx / dy / dwFlags（结构全零的回归）', () => {
  const out = probe()
  const bytes = bytesOf(out.MOUSE_BYTES_HEX)
  assert.equal(bytes.length, 40)

  // type 必须是 0（INPUT_MOUSE）
  assert.equal(u32(bytes, 0), 0)
  // dx / dy 在偏移 8 / 12，规范化后不可能是 0（探针用 100,100 在 2560x1600 的虚拟屏上）
  const dx = u32(bytes, 8)
  const dy = u32(bytes, 12)
  assert.notEqual(dx, 0, `偏移 8 的 dx 不能是 0（结构全零缺陷回归）；hex=${out.MOUSE_HEX}`)
  assert.notEqual(dy, 0, `偏移 12 的 dy 不能是 0（结构全零缺陷回归）；hex=${out.MOUSE_HEX}`)
  // dwFlags 在偏移 20，必须含 ABSOLUTE(0x8000) | VIRTUALDESK(0x4000) | MOVE(0x0001) = 0xC001
  const flags = u32(bytes, 20)
  assert.equal(flags & 0x8000, 0x8000, `缺 MOUSEEVENTF_ABSOLUTE；flags=0x${flags.toString(16)}`)
  assert.equal(flags & 0x4000, 0x4000, `缺 MOUSEEVENTF_VIRTUALDESK；flags=0x${flags.toString(16)}`)
  assert.equal(flags & 0x0001, 0x0001, `缺 MOUSEEVENTF_MOVE（只给 0x8000|0x4000 时 rc=1 err=0 而光标不动）；flags=0x${flags.toString(16)}`)
  assert.equal(flags, 0xc001)

  // 鼠标的 flags 恰好落在偏移 20；同一个双字在键盘视图里是 time，必须是 0（不许被鼠标语义写过）
  const keyViewOf20 = u32(bytes, 16)
  assert.equal(keyViewOf20, 0, `偏移 16 在鼠标视图是 mouseData、在键盘视图是 time，探针没给 mouseData ⇒ 必须是 0；got=${keyViewOf20}`)
})

test('键盘事件的字节里 wVk / wScan / dwFlags 都在正确偏移，且 KEYEVENTF_UNICODE 不为 0', () => {
  const out = probe()
  const bytes = bytesOf(out.KEY_BYTES_HEX)
  assert.equal(bytes.length, 40)

  // type 必须是 1（INPUT_KEYBOARD）
  assert.equal(u32(bytes, 0), 1)
  // 探针用 wVk=0 / wScan=65 / flags=KEYEVENTF_UNICODE(4) —— 这是 `type` 走的路径
  assert.equal(bytes[8], 0, `偏移 8 的 wVk 应当是 0（unicode 注入不用虚拟键）；hex=${out.KEY_HEX}`)
  assert.equal(bytes[9], 0)
  assert.equal(bytes[10], 65, `偏移 10 的 wScan 应当是 65；hex=${out.KEY_HEX}`)
  assert.equal(bytes[11], 0)
  // 修复点：键盘 dwFlags 在偏移 12（= union 起始 8 + KEYBDINPUT 内偏移 4），不是 20。
  // 这一位丢了，SendInput 照样回"已插入 N 个事件"，而字符一个都不会出现 —— 真机实证：
  // INSERTED_EVENTS=20 CHARACTERS=10 CHANGED=false 且靶侧 len 一个字符都没进。
  const kflags = u32(bytes, 12)
  assert.equal(kflags, 4, `偏移 12 应当是 KEYEVENTF_UNICODE=4；got=${kflags}；hex=${out.KEY_HEX}`)
  // 偏移 20 在键盘视图里落在 union padding 里，必须是 0（它是鼠标 dwFlags 的位置，不是键盘的）
  assert.equal(u32(bytes, 20), 0, `偏移 20 是鼠标 dwFlags 的位置，键盘事件那里必须是 0；hex=${out.KEY_HEX}`)
  // time 在偏移 16
  assert.equal(u32(bytes, 16), 0)
  // dwExtraInfo 两个视图都在 24（键盘）—— 全零即可
  assert.equal(u32(bytes, 24), 0)
  assert.equal(u32(bytes, 28), 0)
})

test('键盘 keyup 事件在同一偏移上带 KEYEVENTF_KEYUP(2)，即 flags=6', () => {
  const out = probe()
  const bytes = bytesOf(out.KEY_UP_BYTES_HEX)
  assert.equal(bytes.length, 40)
  assert.equal(u32(bytes, 0), 1)
  assert.equal(bytes[10], 65, `keyup 的 wScan 也应当是 65；hex=${out.KEY_UP_BYTES_HEX}`)
  const kflags = u32(bytes, 12)
  assert.equal(kflags, 6, `偏移 12 应当是 UNICODE|KEYUP = 6；got=${kflags}；hex=${out.KEY_UP_BYTES_HEX}`)
  assert.equal(kflags & 0x0002, 0x0002, '缺 KEYEVENTF_KEYUP ⇒ 按键永远按下不弹起')
  assert.equal(kflags & 0x0004, 0x0004, '缺 KEYEVENTF_UNICODE ⇒ 字符不会出现')
})

test('滚轮事件的 mouseData 是 -360 的 uint32 形式，且与参照布局逐字节相同', () => {
  const out = probe()
  const bytes = bytesOf(out.WHEEL_BYTES_HEX)
  assert.equal(bytes.length, 40)
  // type 是 INPUT_MOUSE
  assert.equal(u32(bytes, 0), 0)
  // dwFlags 在偏移 20：MOUSEEVENTF_WHEEL = 0x0800（滚轮不带 MOVE/ABSOLUTE，靠事先的 move 定位）
  assert.equal(u32(bytes, 20), 0x0800, `偏移 20 应当是 MOUSEEVENTF_WHEEL=0x0800；hex=${out.WHEEL_BYTES_HEX}`)
  // mouseData 在偏移 16：-3 格 × WHEEL_DELTA(120) = -360，以 int32 小端写进去就是 0xFFFFFE98
  // （2^32 - 360 = 4294966936）。旧代码把 -360 直塞 [uint32] 参数 ⇒ "Cannot convert value
  // "-360" to type "System.UInt32"" ⇒ 向下滚轮永远 exit 1，一个事件都没发出去。
  assert.equal(u32(bytes, 16), 0xfffffe98, `偏移 16 应当是 0xFFFFFE98（-360 的 uint32 形式）；hex=${out.WHEEL_BYTES_HEX}`)
  // 以有符号读回来必须是 -360，而不是一个巨大的正数
  assert.equal(u32(bytes, 16) | 0, -360, '同一批字节按 int32 读回来必须是 -360')
  assert.equal(out.WHEEL_DW_DATA, '-360')
  assert.equal(out.WHEEL_CLICKS, '-3')
  // 与 winuser.h 原样的嵌套 union 参照实现逐字节一致
  assert.equal(out.WHEEL_MATCHES_CANONICAL, 'true', `滚轮字节与参照布局不同；flat=${out.WHEEL_BYTES_HEX} canonical=${out.CANONICAL_WHEEL_BYTES_HEX}`)
  assert.equal(out.CANONICAL_WHEEL_BYTES_HEX, out.WHEEL_BYTES_HEX)
  // 字段读出也要对（PowerShell 读嵌套值类型成员曾经拿到 0）
  const fields = JSON.parse(out.WHEEL_FIELDS)
  assert.equal(fields.type, 0)
  assert.equal(fields.flags, 0x0800)
  assert.equal(fields.mouseData, 0xfffffe98)
})

test('probe 从不发送事件（它只做内存编码）', () => {
  const out = probe()
  // 报告里不许出现任何"已插入事件"的字样 —— probe 路径根本不调 SendInput
  assert.equal(out.INSERTED_EVENTS, undefined)
  assert.equal(out.OK, 'true')
  // 编码出来的字节不是全零（P0-A 的缺陷形态是"整块全零 + 照样报已插入 N 个事件"）
  assert.notEqual(out.MOUSE_BYTES_HEX, '00'.repeat(40))
  assert.notEqual(out.KEY_BYTES_HEX, '00'.repeat(40))
})
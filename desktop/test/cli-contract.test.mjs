// 命令行契约测试：跑真实入口 `cli.mjs`，只看退出码、stdout/stderr 的形状，
// **不看任何真实桌面数据**（不调 bridge、不点鼠标、不截屏）。
//
// 沙箱注意：runCli 用 spawnSync + **文件重定向**而不是 pipe（见 test/helpers.mjs 的注释与
// desktop/design.md 的 I11）。

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { runCli } from './helpers.mjs'

test('help：退出码 0，USAGE 里有全部命令名', () => {
  const help = runCli(['help'])
  assert.equal(help.code, 0)
  for (const cmd of ['profile', 'windows', 'screen', 'uia', 'point', 'click', 'move', 'type', 'key', 'scroll', 'invoke', 'verify']) {
    assert.equal(help.stdout.includes(cmd), true, `USAGE 少了命令：${cmd}`)
  }
  assert.equal(help.stdout.includes('用法：node cli.mjs'), true)
  assert.equal(help.stderr, '')
})

test('无参数：等于 help，退出码 0', () => {
  const bare = runCli([])
  assert.equal(bare.code, 0)
  assert.equal(bare.stdout.startsWith('用法：'), true)
})

test('--help 开关：退出码 0', () => {
  const flagged = runCli(['--help'])
  assert.equal(flagged.code, 0)
  assert.equal(flagged.stdout.startsWith('用法：'), true)
})

test('不认识的命令：退出码 2、ERROR= 只在 stderr、只给一行提示（USAGE 留给 help）', () => {
  const bad = runCli(['frobnicate'])
  assert.equal(bad.code, 2)
  assert.equal(bad.stdout, '')
  assert.match(bad.stderr, /^ERROR=不认识命令：frobnicate/)
  // 用法错不再吐整屏 USAGE（那会把真正的报错顶出视野），只指路 `help`。
  assert.equal(bad.stderr.includes('node cli.mjs help'), true)
  assert.equal(bad.stderr.includes('用法：node cli.mjs <命令>'), false)
  assert.equal(bad.stderr.split('\n').filter((line) => line !== '').length, 2)
})

test('screen --out 的父目录不存在：退出码 2（用法错），且报错说清是谁的错', () => {
  // 真机实测过它走成 exit 1 + `ERROR=bridge 报错：Exception calling "WriteAllBytes" …` ——
  // 调用方看不出这是"我自己没建目录"。参数形状不对属于用法错（design.md 的退出码口径）。
  const missing = path.join(os.tmpdir(), 'adg-desktop-no-such-dir-xyz', 'shot.png')
  const result = runCli(['screen', '--out', missing])
  assert.equal(result.code, 2, `应当退出码 2，实际 ${result.code}；stderr=${result.stderr}`)
  assert.match(result.stderr, /--out 的父目录不存在/)
  assert.doesNotMatch(result.stderr, /WriteAllBytes/)
  assert.equal(result.stdout, '')
})

test('用法错误都是退出码 2（缺值 / 非数字 / 多余位置参数 / 形状不对）', () => {
  const cases = [
    ['point', '--x', '1'],
    ['point', '--x', 'abc', '--y', '2'],
    ['click', '--x', '1', '--y', '2', '--button', 'thumb'],
    ['uia', '--depth', '999'],
    ['uia', '--id', 'nope'],
    ['invoke', '--id', '42'],
    ['scroll', '--x', '1', '--y', '2', '--dy', '0'],
    ['windows', 'extra-arg'],
  ]
  for (const argv of cases) {
    const result = runCli(argv)
    assert.equal(result.code, 2, `${argv.join(' ')} 应当退出码 2，实际 ${result.code}；stderr=${result.stderr}`)
    assert.match(result.stderr, /^ERROR=/, `${argv.join(' ')} 的 stderr 应以 ERROR= 开头`)
  }
})

test('缺 --keys / --text：退出码 2 且报错点直接指向缺的那个开关', () => {
  const noKeys = runCli(['key'])
  assert.equal(noKeys.code, 2)
  assert.match(noKeys.stderr, /缺少 --keys/)
  const noText = runCli(['type'])
  assert.equal(noText.code, 2)
  assert.match(noText.stderr, /缺少 --text/)
})

test('verify --expect 的坏键：退出码 1（运行期错误，不是用法错误）且不留假通过', () => {
  const bad = runCli(['verify', '--expect', 'nope=1'])
  assert.equal(bad.code, 1)
  assert.match(bad.stderr, /^ERROR=/)
  assert.equal(bad.stdout.includes('EXPECT_OK=true'), false)
})

test('type/key 缺 --hwnd：退出码 2，且报错说清"键会发给前台窗口"这个后果', () => {
  // design.md I7i：不给收键窗口时桥会把字符发给"当时的前台窗口"（真机踩过：10 个字符进了别的
  // 窗口、靶侧日志零变化、CLI 只报 CHANGED=unknown）。所以这是硬前置，不是可选增强。
  for (const argv of [['type', '--text', 'ABC', '--dry-run'], ['key', '--keys', 'ctrl+s', '--dry-run']]) {
    const result = runCli(argv)
    assert.equal(result.code, 2, `${argv.join(' ')} 应退出 2；stderr=${result.stderr}`)
    assert.match(result.stderr, /必须显式指名收键窗口/)
    assert.match(result.stderr, /--hwnd/)
    assert.equal(result.stdout, '')
  }
})

test('invoke --id el_unknown 不给 --hwnd：退出码 2，且说清"占位 id 不唯一、必须限定窗口"', () => {
  // design.md I6e：el_unknown 是 GetRuntimeId() 读不到时**整类元素折叠出来的同一个字符串**
  // （bridge.ps1 的 New-Node catch 分支）。一份快照里恰好一个就能过"命中数"闸门，而桥的第二遍
  // 遍历取的是**第一个** el_unknown —— 不需要任何竞态，也不需要是同一个元素；不给 --hwnd 时
  // 甚至可以不在同一个窗口。所以这条用法错必须在遍历之前就拒掉。
  const result = runCli(['invoke', '--id', 'el_unknown'])
  assert.equal(result.code, 2, `应退出 2；stderr=${result.stderr}`)
  assert.match(result.stderr, /^ERROR=/)
  assert.match(result.stderr, /el_unknown/)
  assert.match(result.stderr, /不唯一/)
  assert.match(result.stderr, /--hwnd/)
  assert.match(result.stderr, /限定窗口/)
  assert.equal(result.stdout, '', '这条用法错在遍历之前就拒掉，不产生任何快照读数')
})

test('用不上的开关一律报用法错：不静默忽略（退出码 2）', () => {
  // 这条是"传了参数"与"参数真的生效"被分开的根源（本轮两个 P1 就是靠静默忽略藏住的）。
  const cases = [
    ['move', '--x', '10', '--y', '20', '--button', 'right'], // move 只移指针，--button 无意义
    ['type', '--text', 'x', '--hwnd', '0x123456', '--target-hwnd', '0x123456'], // 键盘用 --hwnd
    ['click', '--x', '1', '--y', '2', '--dy', '3'], // --dy 是 scroll 的
    ['windows', '--depth', '2'], // --depth 是 uia/invoke 的
    ['point', '--x', '1', '--y', '2', '--bogus'], // 拼错的开关名
  ]
  for (const argv of cases) {
    const result = runCli(argv)
    assert.equal(result.code, 2, `${argv.join(' ')} 应退出 2；stderr=${result.stderr}`)
    assert.match(result.stderr, /不认识开关/)
    assert.match(result.stderr, /这条命令认识/)
  }
})

test('显式 --target-hwnd 而落点不是它：注入前默认拒发（LANDING_PREFLIGHT=false）', () => {
  // 真机来源：调用方给了 --target-hwnd、落点像素被别的窗口占住，CLI 只打了 LANDING_IN_TARGET=false
  // 就照样把事件发了出去（更早还有约 40 次单击落到用户终端上）。这条闸门必须在"发事件之前"。
  const wrong = runCli(['click', '--x', '1280', '--y', '800', '--dry-run', '--no-pixel', '--target-hwnd', '0xdead'])
  const preflight = /^LANDING_PREFLIGHT=(\w+)$/m.exec(wrong.stdout)?.[1]

  // 本机实测：落点探针可用、FromPoint 被拒 ⇒ 这一支命中 false。落点读数拿不到时是 unknown（只 WARN、不拦），
  // 所以用例对 unknown 退化为"不许发事件、不许报 false"，避免把环境差异说成回归。
  assert.ok(preflight === 'false' || preflight === 'unknown', `LANDING_PREFLIGHT 应是 false/unknown，实际 ${preflight}`)
  assert.equal(wrong.stdout.includes('INSERTED_EVENTS='), false, 'dry-run 与闸门都不该出现 INSERTED_EVENTS=')

  if (preflight === 'false') {
    assert.equal(wrong.code, 2, `stderr=${wrong.stderr}`)
    assert.equal(wrong.stdout.includes('TARGET_SOURCE='), false, '拒发时不该继续往下打目标/落点读数')
    assert.match(wrong.stderr, /落点像素上的窗口不是目标窗口/)
    assert.match(wrong.stderr, /加 --force/)
    assert.match(wrong.stderr, /point --x <px> --y <py>/)

    // --force ⇒ 放行、那段文字留着当 WARN、dry-run 的 not-evaluated 口径不许被破坏
    const forced = runCli(['click', '--x', '1280', '--y', '800', '--dry-run', '--no-pixel', '--force', '--target-hwnd', '0xdead'])
    assert.equal(forced.code, 0, `stderr=${forced.stderr}`)
    assert.match(forced.stdout, /^LANDING_PREFLIGHT=false$/m)
    assert.match(forced.stdout, /^WARN=落点像素上的窗口不是目标窗口/m)
    assert.match(forced.stdout, /^LANDING_IN_TARGET=not-evaluated$/m)
  } else {
    assert.equal(wrong.code, 0, `stderr=${wrong.stderr}`)
    assert.match(wrong.stdout, /^WARN=落点归属这次判不了/)
  }

  // 没给 --target-hwnd ⇒ 这一路不设闸门（行为与修前一致）
  const noTarget = runCli(['click', '--x', '1280', '--y', '800', '--dry-run', '--no-pixel'])
  assert.equal(noTarget.code, 0, `stderr=${noTarget.stderr}`)
  assert.equal(noTarget.stdout.includes('LANDING_PREFLIGHT='), false)
  assert.match(noTarget.stdout, /^TARGET_SOURCE=(point|foreground)$/m)
})
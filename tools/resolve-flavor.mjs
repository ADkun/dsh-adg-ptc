#!/usr/bin/env node
// tools/resolve-flavor.mjs —— 把"这个 profile 挂了哪些注入组"翻成"用哪份生成物、生成时传什么旗标"。
//
// 为什么单独一个文件：味道键（`bili` / `save-token` / `bili+save-token` / `plain`）和稳定目录名
// （`dsh-adg-ptc-bili` / `-save-token` / `-bili-save-token` / `dsh-adg-ptc`）必须**逐字一致**
// 地出现在 install.ps1、install.sh、生成物自检和文档里。让两个安装脚本各自拼字符串，迟早有一处
// 漏了空格或大小写，而那种漂的后果是"profile 链到一份不存在的目录"或"拿到别的味道的生成物，
// 每次委派都抛 names unknown global tool"（AGENTS.md 红线 7）。所以拼法只写在 tools/flavors.mjs，
// 两个脚本都调这里拿结果。
//
// 用法：node tools/resolve-flavor.mjs [--billion-context] [--save-token]
//   `--<组>` 表示**这个 profile 挂着该组**（由 tools/has-bundle.mjs 探测得到；auto/on/off 的判定
//   留调用方 —— 探测与"用户强制"是两件事，这里只回答"给定这组存在，该拿哪份生成物"）。
// 输出：一行三列，制表符分隔 ——
//   <味道键>	<稳定目录名>	<该味道的 gen 旗标（空格分隔；plain 为空）>
// 例：`--billion-context --save-token` → `bili+save-token\tdsh-adg-ptc-bili-save-token\t--with-billion-context --with-save-token`
// 退出码：0 成功 / 2 未知旗标。
import process from 'node:process'
import { GROUP_ORDER, INJECTION_GROUPS, dirNameFor, flavorKeyOf, flavorKeys } from './flavors.mjs'

const argv = process.argv.slice(2)
const groups = []
for (const arg of argv) {
  if (!arg.startsWith('--')) {
    process.stderr.write(`不认识的位置参数 ${arg}；用法：node tools/resolve-flavor.mjs [${GROUP_ORDER.map((group) => `--${group}`).join('] [')}]\n`)
    process.exit(2)
  }
  const group = arg.slice(2)
  if (!GROUP_ORDER.includes(group)) {
    process.stderr.write(`不认识的旗标 ${arg}（可用：${GROUP_ORDER.map((candidate) => `--${candidate}`).join(' ')}；味道键共 ${flavorKeys().join(' / ')}）\n`)
    process.exit(2)
  }
  if (!groups.includes(group)) groups.push(group)
}

const key = flavorKeyOf(groups)
const flags = GROUP_ORDER.filter((group) => groups.includes(group))
  .map((group) => INJECTION_GROUPS[group].flag)
  .join(' ')
process.stdout.write(`${key}\t${dirNameFor(key)}\t${flags}\n`)
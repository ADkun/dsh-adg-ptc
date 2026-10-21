#!/usr/bin/env node
// tools/has-bundle.mjs —— 一个 profile 到底算不算"挂着某个 bundle 插件"，两处安装脚本共用一份判据。
//
// 为什么单独一个文件：这条判据决定安装侧的**味道选择** ——
//   1. preset 生成物要不要在调度 persona 上追加该插件的上下文工具说明（见 gen-preset-bundle.mjs）；
//   2. 这个 profile 该拿哪一份生成物（味道与目录名见 tools/flavors.mjs）。
// 它只决定**味道**（这个 profile 该拿哪一份生成物），与任何插件启不启用无关。
// 判据写成两份（install.ps1 一份、install.sh 一份）迟早会漂，漂了的后果不是"少个能力"就是"子代理一委派
// 就抛 names unknown global tool"，所以两边都调这里。
//
// 用法：node tools/has-bundle.mjs <profilesDir> <profile> [<profile> ...] [--package=<包名>]
//   `--package` 缺省是 `billion-context`（历史默认值，老脚本按位置传参也仍然成立）。
// 输出：每个 profile 一行 `<name>\t<0|1>`（1 = 挂着）。退出码恒 0（读不到清单就是 0，不报错）：
// 装不装得下去由调用方决定，这里只回答事实。
//
// 判据两条都要成立（实现在 tools/flavors.mjs 的 probeBundle，别在调用方重写）：
//   - 包名在 `dsh.profile.bundles` 里（只有 node_modules 里的包而没被选中 = dsh 根本不读它的 patch 层；
//     只有列表没有包 = dsh 启动时报"未安装的 bundle"）；
//   - 装上的那份包里真的有它的 patch 文件（挂载行由那一层提供，缺了它这个包只是普通依赖，
//     里面也就没有任何工具被注册）。补丁文件名**从该包自己的 `package.json` 的 `dsh.bundle.patch` 读**
//     —— billion-context 叫 `dsh.bundle.patch.yml`、dsh-plugin-save-token 叫 `cordis.patch.yml`（按当前安装核对）。
import process from 'node:process'
import { GROUP_ORDER, INJECTION_GROUPS, probeBundle } from './flavors.mjs'

const argv = process.argv.slice(2)
const packageFlag = argv.find((arg) => arg.startsWith('--package='))
const packageName = packageFlag === undefined ? 'billion-context' : packageFlag.slice('--package='.length)
if (packageName.trim() === '') {
  process.stderr.write('用法：node tools/has-bundle.mjs <profilesDir> <profile> [...] [--package=<包名>]\n')
  process.exit(2)
}
const [profilesDir, ...profiles] = argv.filter((arg) => !arg.startsWith('--'))
if (!profilesDir || profiles.length === 0) {
  const known = GROUP_ORDER.map((group) => INJECTION_GROUPS[group].package).join(' / ')
  process.stderr.write(`用法：node tools/has-bundle.mjs <profilesDir> <profile> [...] [--package=<包名>]（本仓库已知：${known}）\n`)
  process.exit(2)
}

for (const name of profiles) {
  process.stdout.write(`${name}\t${probeBundle(profilesDir, name, packageName) ? 1 : 0}\n`)
}
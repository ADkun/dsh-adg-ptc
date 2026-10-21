// tools/flavors.mjs —— 「构建期注入组」的单一事实来源。
//
// 为什么需要这个文件：Adg 的 preset 生成物有**多种味道**，差别只在于调度 persona 里多不多那段
// 「委派时要一并写进 `tools`」的上下文工具说明，以及要不要关掉 preset realm 里的自动压缩。味道由
// 目标 profile 挂了哪些 bundle 插件决定，而"挂了没挂"要读 profile 的 package.json —— 这类判据一旦
// 抄成三份（gen 脚本一份、生成物自检一份、两个安装脚本各一份）迟早会漂，漂了的后果不是"少个能力"
// 就是"子代理收得到'去调它'的提示，手上却没有那个工具"（AGENTS.md 红线 10）。
//
// 所以：组表、味道键、目录名、探测判据**只写在下面**，其余脚本一律 import 本文件。
//
// 安装期的口径（对每个注入组一视同仁，不是只有 billion-context）：
//   先探测该 profile 所在环境**有没有装对应插件**；装了才在生成物的调度 persona 里写一段说明，
//   要它每次委派都把那几个全局层工具名一并写进 `tools`，没装就不写。生成物按"味道"分目录落地，
//   安装脚本逐 profile 探测后挑选对应目录，绝不把一份产物将就所有 profile。
//
// 味道（flavor）：一个 profile 需要的"注入组集合"。键按 GROUP_ORDER 固定顺序拼：
//   []                              → `plain`        目录 `dsh-adg-ptc`
//   ['billion-context']             → `bili`         目录 `dsh-adg-ptc-bili`
//   ['save-token']                  → `save-token`   目录 `dsh-adg-ptc-save-token`
//   ['billion-context','save-token']→ `bili+save-token` 目录 `dsh-adg-ptc-bili-save-token`
//
// 为什么不能"一份生成物兼容所有 profile"：`delegate` 的 `tools` 是真白名单 —— 调度者按那段说明
// 写进委派的每个名字在那次会话里都得已注册；`delegate` 会把没注册的名字剔掉并逐条写进 `tools_note`
// （不会让委派失败，但子代理就只收到提示、手上没有工具 —— 这正是本机制最初要修的缺陷）。
// 因此：**多一个组 = 多一个稳定目录**，安装期按 profile 探测结果挑选，而不是让一份产物将就所有人。
//
// 零依赖、纯数据与纯函数：没有文件系统副作用（`probeBundle` 只读）。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 构建期注入组。每个组的字段含义：
 *   flag             gen 脚本的旗标；也是安装脚本 `--<组>=on` 时给 gen 传的东西
 *   package          profile 的 `dsh.profile.bundles` 里要出现的包名（探测用）
 *   tools            gen 要写进调度 persona 那段说明的**全局层已注册**工具名（顺序即说明里的次序）
 *   notInjected      同属该插件、但**故意不注入**的名字：出现在源文件里同样算红线 10 违规，
 *                    出现在生成物里则是"注入清单没同步"的信号，要报出来
 *   autoCompactionOff 该组是否要求关掉 preset realm 里 compaction-basic 的自动压缩
 *   flavorToken      味道键里的记号（拼目录名用 `-`，拼味道键用 `+`）
 *   sourceReason     这些名字为什么必须由构建期注入（写进调度 persona 那段说明与生成物自检的报错里）
 *   missingHint      安装/生成时的提示：这个组没注入意味着什么
 *   artifactNotes    写进生成物注释头的补充说明行
 */
export const INJECTION_GROUPS = Object.freeze({
  'billion-context': Object.freeze({
    flag: '--with-billion-context',
    package: 'billion-context',
    // 只取这 4 个：`acp_cache` 是纯缓存经济性诊断（调度者可以用 conversation_id 代读），
    // 给每次委派多挂一个名字只是白付一份 schema 的 prefix。
    tools: Object.freeze(['compress', 'decompress', 'search_context', 'acp_status']),
    notInjected: Object.freeze(['acp_cache']),
    autoCompactionOff: true,
    flavorToken: 'bili',
    sourceReason: 'billion-context 的上下文工具，只在挂了该 bundle 的 profile 里存在',
    missingHint:
      '挂了该 bundle 的 profile 要用 --with-billion-context 重新生成，否则调度者不知道要把 compress / acp_status 等名字一并写进委派，而 dsh 自带的自动压缩也会和 bili 抢着折叠同一段历史。',
    artifactNotes: Object.freeze([]),
  }),
  'save-token': Object.freeze({
    flag: '--with-save-token',
    package: 'dsh-plugin-save-token',
    tools: Object.freeze(['save_token_expand']),
    notInjected: Object.freeze([]),
    autoCompactionOff: false,
    flavorToken: 'save-token',
    sourceReason: 'save-token 的取回工具，只在挂了该 bundle 的 profile 里存在',
    missingHint:
      '装了该 bundle 的 profile 要用 --with-save-token 重新生成，否则调度者不知道要把 save_token_expand 一并写进委派，子代理收到 "[save-token #id] … Call the save_token_expand tool" 的通知却没有这个工具（只剩 read 那个 locator 一条退路）。',
    artifactNotes: Object.freeze([
      '# 为什么连它也要写进那段说明：save-token 在工具结果**进入历史的那一刻**把大输出换成',
      '# `[save-token #id] …` 通知，通知正文直接点名 "Call the save_token_expand tool with id …"',
      '# —— 子代理手上没有这个工具就会去调一个不存在的名字。',
      '# 注意它与内置 `tool-result-pruner` 动的是**同一格**（工具结果进历史的那一刻）：两个都开，',
      '# 结果是 pruner 在 save-token 已经缩过的文本上再裁一道（作者的口径是二选一）。',
      '# 本 preset 不去关那一行 —— 那三个体积旋钮归插件出厂默认值管（AGENTS.md 红线 3），',
      '# 要不要把 pruner 行 disabled 是**宿主 profile 自己**的决定。',
    ]),
  }),
})

/** 味道键里的固定顺序：决定说明里名字的次序，必须可复现（不要依赖 Object.keys 的顺序）。 */
export const GROUP_ORDER = Object.freeze(['billion-context', 'save-token'])

/** 没挂任何注入组时的味道键。 */
export const PLAIN_FLAVOR = 'plain'

/** 稳定目录名（`$DSH_HOME/bundles/<这个名字>`；两份 package.json 逐字节相同、包名都叫 dsh-adg-ptc）。 */
const DIR_PREFIX = 'dsh-adg-ptc'

const assertKnownGroup = (group) => {
  if (!GROUP_ORDER.includes(group)) throw new Error(`未知的注入组：${group}`)
}

/** 组集合 → 味道键。传进来的顺序无关，输出恒按 GROUP_ORDER 顺序。 */
export function flavorKeyOf(groups) {
  for (const group of groups) assertKnownGroup(group)
  const picked = GROUP_ORDER.filter((group) => groups.includes(group))
  return picked.length === 0 ? PLAIN_FLAVOR : picked.map((group) => INJECTION_GROUPS[group].flavorToken).join('+')
}

/** 味道键 → 组数组（组顺序恒为 GROUP_ORDER）。不认识的键直接抛错，不要静默退化成 plain。 */
export function parseFlavorKey(key) {
  if (key === PLAIN_FLAVOR) return []
  const tokens = key
    .split('+')
    .map((token) => token.trim())
    .filter((token) => token !== '')
  const picked = []
  for (const token of tokens) {
    const group = GROUP_ORDER.find((candidate) => INJECTION_GROUPS[candidate].flavorToken === token)
    if (group === undefined) throw new Error(`未知的味道键：${key}（可用：${flavorKeys().join(' / ')}）`)
    if (!picked.includes(group)) picked.push(group)
  }
  return GROUP_ORDER.filter((group) => picked.includes(group))
}

/** 所有味道键，按"注入组个数、然后固定的组顺序"稳定排列 —— 供安装脚本枚举与用法提示用。 */
export function flavorKeys() {
  const keys = []
  for (let mask = 0; mask < 1 << GROUP_ORDER.length; mask += 1) {
    keys.push(flavorKeyOf(GROUP_ORDER.filter((_, bit) => mask & (1 << bit))))
  }
  return keys.sort((a, b) => {
    if (a === PLAIN_FLAVOR) return -1
    if (b === PLAIN_FLAVOR) return 1
    return a.split('+').length - b.split('+').length || a.localeCompare(b)
  })
}

/** 组的工具名并集（gen 注入、自检断言都用它）。 */
export function toolsFor(groups) {
  for (const group of groups) assertKnownGroup(group)
  return GROUP_ORDER.filter((group) => groups.includes(group)).flatMap((group) => [...INJECTION_GROUPS[group].tools])
}

/** 组集合里**故意不注入**的名字并集（出现在生成物里要报错）。 */
export function notInjectedFor(groups) {
  for (const group of groups) assertKnownGroup(group)
  return GROUP_ORDER.filter((group) => groups.includes(group)).flatMap((group) => [
    ...INJECTION_GROUPS[group].notInjected,
  ])
}

/** 这个味味道要不要关掉 preset realm 里的自动压缩（任一组要求就是关）。 */
export function autoCompactionOffFor(groups) {
  for (const group of groups) assertKnownGroup(group)
  return GROUP_ORDER.some((group) => groups.includes(group) && INJECTION_GROUPS[group].autoCompactionOff)
}

/** 味道键 → 稳定目录名。plain 保持历史名字 `dsh-adg-ptc`（它一直是"没挂 bili"那份）。 */
export function dirNameFor(key) {
  const groups = parseFlavorKey(key)
  if (groups.length === 0) return DIR_PREFIX
  return `${DIR_PREFIX}-${groups.map((group) => INJECTION_GROUPS[group].flavorToken).join('-')}`
}

/**
 * 一个 profile 里某个 bundle 插件算不算"挂上了"。两条判据都要成立：
 *   - 包名在 `dsh.profile.bundles` 里（只有 node_modules 里的包而没被选中 = dsh 根本不读它的 patch 层；
 *     只有列表没有包 = dsh 启动时报"未安装的 bundle"）；
 *   - 装上的那份包里真的有它的 patch 文件（挂载行由那一层提供，缺了它这个包只是普通依赖，
 *     里面也就没有任何工具被注册）。
 * patch 文件名**从被测包自己的 `package.json` 的 `dsh.bundle.patch` 读**，不要写死 —— 生态里
 * billion-context 叫 `dsh.bundle.patch.yml`、dsh-plugin-save-token 叫 `cordis.patch.yml`（按当前安装核对）。
 * 读不到清单时退回那个历史文件名，保证对老包仍然成立。
 */
export function probeBundle(profilesDir, profile, packageName) {
  let selected = false
  try {
    const json = JSON.parse(readFileSync(join(profilesDir, profile, 'package.json'), 'utf8'))
    const bundles = (json.dsh && json.dsh.profile && json.dsh.profile.bundles) || []
    selected = Array.isArray(bundles) && bundles.includes(packageName)
  } catch {
    selected = false
  }
  if (!selected) return false
  const pkgDir = join(profilesDir, profile, 'node_modules', packageName)
  let patch = 'dsh.bundle.patch.yml'
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    const declared = manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch
    if (typeof declared === 'string' && declared.trim() !== '') patch = declared.trim()
  } catch {
    // 读不到清单：用历史文件名兜底（billion-context 一直是这个名字）
  }
  return existsSync(join(pkgDir, patch))
}

/** 一个 profile 的探测结果：`{ '<组>': true|false }`，键顺序恒为 GROUP_ORDER。 */
export function probeGroups(profilesDir, profile) {
  const out = {}
  for (const group of GROUP_ORDER) out[group] = probeBundle(profilesDir, profile, INJECTION_GROUPS[group].package)
  return out
}
#!/usr/bin/env node
// 把本仓库的 preset 源文件（`preset/preset.yml` + `preset/agent.cordis.yml`）打包成
// dsh 当前唯一认识的形状：一个由 bundle patch 声明的 agent preset 行。
//
// 为什么需要它：
//   dsh **不再通过目录发现 preset**：`$DSH_HOME/.agent-presets/<id>/`（`preset.yml` + `agent.cordis.yml`）
//   这套机制已经不存在了 —— `@deepseek-ai/dsh-agent-presets`（复数）不再是 preset 的入口，
//   取而代之的是 `@deepseek-ai/dsh-agent-preset`（单数，声明行插件）+
//   `@deepseek-ai/dsh-agent-preset-registry`（花名册）。目录还在、文件还在，但**没有任何东西读它**，
//   所以只把那两个文件拷进去等于什么都装不上：preset 必须按 bundle 的稳定落点生成并安装
//   （dsh 与各插件包的版本以根 `AGENTS.md` 的「外部依赖与 ref 解析」一节的解析结果为准）。
//   现在一个 preset 只能是一行 Loader 声明：`name: '@deepseek-ai/dsh-agent-preset'`，
//   `config.id` 是 preset 身份，`config.plugins` 是它的子插件条目列表（与旧的 agent.cordis.yml 同方言）。
//
// 用法：
//   node tools/gen-preset-bundle.mjs                 # 生成到 bundle/adg-ptc（.gitignore 已忽略 bundle/）
//   node tools/gen-preset-bundle.mjs <outDir>        # 生成到指定目录
//   node tools/gen-preset-bundle.mjs --with-billion-context   # 让调度者每次委派都带上 bili 的上下文工具 + 关 preset realm 自动压缩
//   node tools/gen-preset-bundle.mjs --with-save-token        # 同上，带上 save-token 的取回工具（见下）
//   （两个旗标可叠加；味道键/目录名/清单的单一事实来源是 tools/flavors.mjs）
//
// `--with-billion-context`（构建期条件化）：
//   挂了 billion-context 的 profile 里，子代理会收到"去调 compress / acp_status"的提示（bili 的注入段
//   与 nudge **只看 config、不看这个请求有没有那些工具**），而那些名字是注册在**全局层**的。
//   子代理的能力面现在由**每一次委派**的 `tools` 现定（`delegate` 插件），preset 里没有任何静态
//   `toolFilter.allow` 可以注入 —— 所以本旗标做的事是：在生成物里的**调度 persona** 上加一段说明，
//   要求调度者每次委派都把这几个名字一并写进 `tools`。
//   名单只能出现在**生成物**里：`preset/agent.cordis.yml` 必须对没装 bili 的人也成立（AGENTS.md 红线 10）。
//   默认**不追加**（忘了加旗标 = 少个能力，不会装坏）。install.ps1 / install.sh 会探测目标 profile
//   有没有挂 billion-context，挂了才带这个旗标。
//   补充：子代理拿不到那几个名字不再"当场抛错"（`delegate` 会把没注册的名字逐条写进 `tools_note`、
//   并把它们从 `tools` 里剔掉），但那样它只收到提示、手上没有工具 —— 正是本机制要修的缺陷。
//   所以"每个 profile 配对自己的味道"这条不变量仍然成立。
//   实现细节（哪个导出、哪个配置键、哪一段产物在哪一层）会随插件版本变：换版本时对着**当前安装**的
//   包重新核对，不要凭这里的描述下断言。
//
//   同一个旗标还负责**关掉 preset realm 里的自动压缩**：给 `compaction` 组那行
//   `compaction-basic` 注入 `config: {auto: false}` —— 与 billion-context 自己的
//   `dsh.bundle.patch.yml`（`- id: compaction-basic` / `config: {auto: false}`）**同键同值**。
//   为什么要在生成物里再写一遍：那份官方补丁打在 **profile 层**，而本 preset 的 compaction 三行活在
//   `isolate: {compaction: true}` 的 realm 里、是**另一份实例**，跨 lane 的 id 命中与否从未被观测
//   —— 直接写进 preset 自己的组里就不依赖这个解析；两边都生效也无行为差异（幂等）。
//   `auto: false` 只关"自动压缩 + 溢出恢复"，手动 `/compact` 仍可用（`@deepseek-ai/dsh-compaction-basic`
//   README `auto` 行："set `false` for manual-only operation"；插件按 `config.auto` 决定要不要
//   注册那两个自动 listener）。
//   源文件（preset/agent.cordis.yml）同样保持中立：没挂 bili 的 profile 里，dsh 自带的自动压缩
//   是**唯一**的压缩手段，关掉等于让上下文无限增长。
//
// `--with-save-token`（构建期条件化）：
//   与上面同一类问题、同一个修法。装了 `dsh-plugin-save-token` 的 profile 里，工具结果在**进入历史的
//   那一刻**就被换成 `[save-token #id] …` 通知（插件的 `tools/post-execute` 前置钩子），而通知正文
//   直接点名 "Call the save_token_expand tool with id …"（通知文本由插件自己写）。
//   子代理的 `tools` 是硬边界，调度者没写进那一次委派，它就调不到这个名字；剩下的退路只有通知里那个
//   locator 让模型自己 `read`。所以挂了该 bundle 的 profile 要用本旗标重新生成，让调度 persona 知道
//   每次委派都要带上它。
//   本组**不改** compaction：插件自带的自动压缩由它自己的 `compactAssistEnabled: false` 关着。
//   两个旗标可以叠加（"味道"与目录名由 tools/flavors.mjs 统一定义），默认两个都不追加。
//
// 输入（相对仓库根）：
//   preset/preset.yml           name / description /（可选）order —— 只按 `key: value` 取顶层标量
//   preset/agent.cordis.yml     子插件条目列表，**原样**缩进进 config.plugins（单一事实来源）
//   preset/bundle.package.json  package.json 模板，原样拷贝
// 输出：
//   <outDir>/package.json       `dsh.bundle.patch` 指向同目录的 cordis.patch.yml
//   <outDir>/cordis.patch.yml   一行 `insert:`，插入 preset-adg-ptc
//
// 零依赖、只读源文件、不做网络：刻意不引入 YAML 库 —— `preset.yml` 的形状由本仓库自己固定
// （顶层 `key: value`），`agent.cordis.yml` 只需按行加缩进，两者都不需要真解析器。
// 「缩进嵌入」之所以成立：条目列表本来就是合法 YAML，整体右移一格缩进后仍是合法 YAML。
//
// 退出码：0 成功；1 输入缺失或形状不符（错误写到 stderr）。
//
// 能力边界：它只保证**生成物形状**正确（能被 YAML 解析成一行 insert），
// 证明不了 dsh 会挂载它 —— 那要装进 profile 后看 plugin_manager 里的 fiberPhase，
// 以及在新会话里真实组合一次（见根 README.md 的「真实挂载验证」一节）。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { GROUP_ORDER, INJECTION_GROUPS, autoCompactionOffFor } from './flavors.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')

/** 已知旗标：拼错就报错退出，不要静默生成一份"其实没生效"的产物。 */
const KNOWN_FLAGS = new Set(GROUP_ORDER.map((group) => INJECTION_GROUPS[group].flag))
const argv = process.argv.slice(2)
const flags = new Set(argv.filter((arg) => arg.startsWith('--')))
const positional = argv.filter((arg) => !arg.startsWith('--'))
for (const flag of flags) {
  if (!KNOWN_FLAGS.has(flag)) fail(`不认识的旗标 ${flag}；可用：${[...KNOWN_FLAGS].join(' ')}`)
}
/** 本次要注入的组，恒按 GROUP_ORDER 顺序 —— 它决定说明里名字的次序，必须可复现。 */
const ACTIVE_GROUPS = GROUP_ORDER.filter((group) => flags.has(INJECTION_GROUPS[group].flag))
const outDir = resolve(positional[0] ?? join(repo, 'bundle', 'adg-ptc'))

/** Loader 行 id 与 preset 身份。改 id 会同时改掉插件 `presets: ['adg']` 的筛选口径。 */
const PRESET_ID = 'adg-ptc'
const LOADER_ROW_ID = `preset-${PRESET_ID}`
/** 名册排序缺省值：排在出厂 preset（standard=1 … cordis）之后。 */
const DEFAULT_ORDER = 20
/** `config.plugins:` 在生成的 YAML 里所在的列数；条目必须更深一格。 */
const PLUGINS_INDENT = 8
const ITEM_INDENT = PLUGINS_INDENT + 2
/** 单行标量一律用双引号（JSON 转义是合法 YAML 双引号转义），避免中文/冒号/引号踩坑。 */
const scalar = (text) => JSON.stringify(text)

const indentOf = (line) => line.length - line.trimStart().length

function fail(message) {
  process.stderr.write(`gen-preset-bundle: ${message}\n`)
  process.exit(1)
}

/**
 * 注入清单**不写在这里**：组表、工具名、味道键、目录名都在 `tools/flavors.mjs`（单一事实来源），
 * 本脚本只按旗标挑组、按组注入。想知道某个名字为什么必须由构建期注入，看那个文件里的 `sourceReason`。
 */

/** 注入段在生成物里的识别标记；生成与自检（check-bundle-flavor.mjs）共用这一串。 */
const NOTE_MARKER = '**本会话的上下文工具'

/**
 * 给**调度 persona** 加一段说明：这个 profile 装了某个注入组，委派时要把它的工具名一并写进 `tools`。
 *
 * 为什么注入点是 persona：子代理的能力面由 `delegate` 在**每一次委派**时按调度者给的 `tools` 现定，
 * preset 里没有静态 `toolFilter.allow` 可注入（委派行刻意不写它）。被注入的名字必须在、且只在生成物里
 * （AGENTS.md 红线 10），所以它只能是生成物里的一段调度指令 —— 而 persona 是调度者每次都读到的固定前缀。
 *
 * 只认本仓库自己固定的形状：`- id: persona`（第 0 列）→ `    prefix: |-`（4 空格）→ 正文第 6 列，
 * 正文里有一行 `      ## 约束`；说明插在它**前面**（与「你手上的子代理」段相邻，正对着委派口径）。
 * 锚点找不到就**直接失败**：静默不注入等于那个 profile 的子代理收得到提示却没有工具。
 *
 * **一次调用只插一段**：主编排按 `GROUP_ORDER` 收齐本次要注入的所有组，**合并成一段**再交进来 ——
 * 每个组各插一段会让同一个 profile 里出现多段同义说明（自检 `check-bundle-flavor.mjs` 也按
 * "只允许一段"断言），而且"再来一个组时前一段已经在了"会被下面那条防手写的守卫当成手写。
 */
function addContextToolsNote(source, specs) {
  if (specs.length === 0) return source
  const lines = source.replace(/\n+$/, '').split('\n')
  if (source.includes(NOTE_MARKER)) {
    fail(`preset/agent.cordis.yml 里已经出现 "${NOTE_MARKER}" —— 这一段只允许由本脚本在 ${specs.map((spec) => spec.flag).join(' ')} 时注入，不要手写进源文件（没装该插件的 profile 会因此收到不存在的工具名）`)
  }
  const flags = specs.map((spec) => spec.flag).join(' ')
  const packages = specs.map((spec) => spec.package).join(' 与 ')
  const names = specs.flatMap((spec) => spec.tools)
  const reasons = specs.map((spec) => spec.sourceReason).join('；')
  const pronoun = specs.length > 1 ? '它们' : '它'
  const pluginWord = specs.length > 1 ? '这些插件' : '这个插件'
  const personaAt = lines.findIndex((line) => /^- id: persona\s*$/.test(line))
  if (personaAt < 0) {
    fail(`找不到 \`- id: persona\` 行：${flags} 要往调度 persona 里加一段委派说明，检查 preset/agent.cordis.yml 的 identity 段是否被改动`)
  }
  let prefixAt = -1
  for (let i = personaAt + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== '' && indentOf(lines[i]) === 0) break // 走出了这一行
    if (/^ {4}prefix: \|-\s*$/.test(lines[i])) {
      prefixAt = i
      break
    }
  }
  if (prefixAt < 0) fail('`- id: persona` 行里找不到 `    prefix: |-`（缩进应比 `- id` 深两级）')
  let anchorAt = -1
  for (let i = prefixAt + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (indentOf(line) <= 4) break // 走出了 block scalar
    if (/^ {6}## 约束\s*$/.test(line)) {
      anchorAt = i
      break
    }
  }
  if (anchorAt < 0) {
    fail(`调度 persona 的 prefix 里找不到 \`      ## 约束\` 行：${flags} 的注入锚点必须是它（检查那段是否被改写）`)
  }
  const note = `      ${NOTE_MARKER}（${flags} 生成）**：这次会话装了 ${packages}，${pronoun}注册在全局层的 ${names.join(' / ')} 已经在你的工具目录里（PTC 下你在 \`run_code\` 里用 ${names.map((name) => `\`tools.${name}({...})\``).join(' / ')} 调它们）—— **每一次委派都要把这几个名字一并写进 \`tools\`**：子代理的 \`tools\` 是硬边界，没写进那一次委派它就看不见（它自己也在 PTC 里，写程序调得到但目录里没有这个名字就调不到），而它会从工具结果里收到要求它调用这几个工具的提示（${reasons}）。没装${pluginWord}的会话里那几个名字根本不存在，但你不需要判断：\`delegate\` 会把没生效的名字逐条写进 \`tools_note\`，不会让委派失败。`
  lines.splice(anchorAt, 0, note, '')
  return `${lines.join('\n')}\n`
}

/**
 * 关掉 **preset realm 这份** `compaction-basic` 的自动压缩：给 `compaction` 组里那行补上
 *   `      config:` / `        auto: false`（缩进比 `- id:` 深一级）。
 * 与 billion-context 自己的 profile 层补丁**同键同值** —— 见文件头的说明。
 * 源文件刻意不写这个 config：它必须对没挂 billion-context 的人也成立（那种 profile 里 dsh 自带的
 * 自动压缩是唯一的压缩手段）。因此若源文件里已经有 `config:`，这里**直接失败**而不是叠加：
 * 两份 config 会让"到底谁生效"不可判定，而 AGENTS.md 红线 10 要求这个键只能出现在生成物里。
 */
function disableAutoCompaction(source) {
  const lines = source.replace(/\n+$/, '').split('\n')
  const at = lines.findIndex((line) => /^ {4}- id: compaction-basic\s*$/.test(line))
  if (at < 0) {
    fail('找不到 `    - id: compaction-basic` 行（compaction 组那一行）：--with-billion-context 要给它注入 config.auto=false，检查 preset/agent.cordis.yml 的 compaction 组是否被改动')
  }
  let nameAt = -1
  for (let i = at + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue
    if (indentOf(lines[i]) <= 4) break // 走到了这一行块之外
    if (lines[i].trimStart().startsWith('#')) continue
    if (/^ {6}name:/.test(lines[i])) {
      nameAt = i
      break
    }
  }
  if (nameAt < 0) fail('`compaction-basic` 行里找不到 `      name:`（缩进应比 `- id:` 深一级）')
  for (let i = nameAt + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue
    if (indentOf(lines[i]) <= 4) break
    if (lines[i].trimStart().startsWith('#')) continue
    if (/^ {6}config:/.test(lines[i])) {
      fail('preset/agent.cordis.yml 的 compaction-basic 行已经有 `config:` —— `auto: false` 只允许由本脚本在 --with-billion-context 时注入，不要手写进源文件（没挂 bili 的 profile 会因此失去唯一的自动压缩）')
    }
  }
  lines.splice(nameAt + 1, 0, '      config:', '        auto: false')
  return `${lines.join('\n')}\n`
}

function readSource(relative) {
  const path = join(repo, relative)
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    fail(`读不到 ${relative}：${error.message}`)
  }
}

/** 顶层 `key: value` 标量（本仓库 preset.yml 的固定形状），忽略注释与空行。 */
function parseTopLevelScalars(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf(': ')
    if (at < 0) continue
    const key = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + 2).trim()
    if (key && value) out[key] = value
  }
  return out
}

const presetYml = readSource(join('preset', 'preset.yml'))
const agentList = readSource(join('preset', 'agent.cordis.yml'))
const packageTemplate = readSource(join('preset', 'bundle.package.json'))

const meta = parseTopLevelScalars(presetYml)
if (!meta.name) fail('preset/preset.yml 里没有可用的 `name: <显示名>`')
if (meta.description === undefined) process.stderr.write('gen-preset-bundle: 警告：preset/preset.yml 没有 description:，花名册里不会有说明文字\n')

let order = DEFAULT_ORDER
if (meta.order !== undefined) {
  order = Number(meta.order)
  if (!Number.isFinite(order)) fail(`preset/preset.yml 的 order 不是数字：${meta.order}`)
}

// 形状自检：条目列表的第一条有效行必须是数组项，否则说明喂错了文件。
const firstEntry = agentList.split('\n').find((line) => line.trim() && !line.trim().startsWith('#'))
if (!firstEntry || !firstEntry.startsWith('- ')) {
  fail('preset/agent.cordis.yml 的第一条有效行不是 `- ` 开头的数组项（顶层必须是一个条目列表）')
}
if (agentList.includes('\t')) fail('preset/agent.cordis.yml 里出现了制表符：YAML 缩进不允许 tab，请换空格')
if (agentList.includes('\r')) fail('preset/agent.cordis.yml 含 CR 行尾：本仓库要求 LF（见 .gitattributes），否则生成的缩进块会带 \\r')

// 构建期条件化：每个 `--with-<组>` 旗标做两件事
//   （1）在生成物里的调度 persona 上加一段说明，要求它每次委派都带上该组注册在全局层的工具名；
//   （2）若该组要求，则给 compaction 组的 compaction-basic 注入 config.auto=false。
// 源文件（preset/agent.cordis.yml）这些事一件都不写、保持中立 —— 它必须对没装那些插件的 profile 也成立：
// 那些工具名在未挂载时**不存在**，而 dsh 自带的自动压缩是没挂 bili 的 profile 里唯一的压缩手段。
let entrySource = agentList
/** 已注入的组：`{ group, spec }`，顺序与 GROUP_ORDER 一致（也与说明里名字的次序一致）。 */
const injected = ACTIVE_GROUPS.map((group) => ({ group, spec: INJECTION_GROUPS[group] }))
// 只插**一段**：多个组合并进同一段说明（各插一段会被自检按"只允许一段"判错）。
entrySource = addContextToolsNote(entrySource, injected.map((entry) => entry.spec))
/** 关掉 preset realm 的自动压缩：任一组要求就关（目前只有 billion-context 组要求）。 */
const autoCompactionOff = autoCompactionOffFor(ACTIVE_GROUPS)
if (autoCompactionOff) entrySource = disableAutoCompaction(entrySource)

const patch = [
  '# 由 tools/gen-preset-bundle.mjs 从 preset/preset.yml + preset/agent.cordis.yml 生成。',
  '# 不要手改这个文件：改 preset/ 下的源文件后重新生成（install.ps1 / install.sh 每次安装都会重生成）。',
  '#',
  '# 它为什么长这样：dsh 不再发现 $DSH_HOME/.agent-presets/<id>/，一个 agent preset 只能由某个',
  '# patch 层里的这一行声明 —— 所以要按 bundle 的稳定落点生成并安装，只把那两个源文件拷进去',
  '# 等于什么都装不上。config.plugins 就是 preset/agent.cordis.yml 原样缩进。',
  ...injected.flatMap(({ spec }) => [
    '#',
    `# 本次生成带了 ${spec.flag}：调度 persona 里多了一段"每次委派都要带上 ${spec.tools.join(' / ')}"的说明。`,
    `# （${spec.package} 把这几个名字注册在全局层；子代理的 tools 是硬边界，调度者不写进那一次委派，`,
    `#  它就只收到提示、手上没有工具。没挂 ${spec.package} 的 profile 要用**不带**这个旗标的生成物：`,
    `#  那几个名字在那里根本不存在，写了只会让 tools_note 多几条"未生效"。）`,
    ...spec.artifactNotes,
  ]),
  ...(autoCompactionOff
    ? [
        '#',
        '# 本次生成还给 compaction 组那行 compaction-basic 注入了 config.auto=false —— 与',
        '# billion-context 自己的 dsh.bundle.patch.yml 同键同值：挂 bili 时关掉 dsh 自带的自动压缩',
        '# （免得两套压缩各自折叠同一段历史）；手动 /compact 仍然可用。',
      ]
    : []),
  '',
  '- insert:',
  `    - id: ${LOADER_ROW_ID}`,
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  `        id: ${PRESET_ID}`,
  `        name: ${scalar(meta.name)}`,
  ...(meta.description === undefined ? [] : [`        description: ${scalar(meta.description)}`]),
  `        order: ${order}`,
  '        plugins:',
  ...entrySource
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => (line.length === 0 ? '' : ' '.repeat(ITEM_INDENT) + line)),
  '',
].join('\n')

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'cordis.patch.yml'), patch, 'utf8')
writeFileSync(join(outDir, 'package.json'), packageTemplate.endsWith('\n') ? packageTemplate : packageTemplate + '\n', 'utf8')

const rows = patch.split('\n').filter((line) => /^\s{10}- id: /.test(line)).length
process.stdout.write(`gen-preset-bundle: ${outDir}\n`)
process.stdout.write(`  cordis.patch.yml  ${Buffer.byteLength(patch, 'utf8')} 字节 / ${rows} 个顶层子插件条目（preset id=${PRESET_ID}, order=${order}）\n`)
for (const group of GROUP_ORDER) {
  const spec = INJECTION_GROUPS[group]
  const hit = injected.find((entry) => entry.group === group)
  if (hit !== undefined) {
    const tail = spec.autoCompactionOff ? '，并把 compaction-basic 的 auto 设为 false' : ''
    process.stdout.write(`  ${group.padEnd(19)}已注入：调度 persona 1 段说明 + ${spec.tools.length} 个工具名（${spec.tools.join(' / ')}）${tail}\n`)
  } else {
    process.stdout.write(`  ${group.padEnd(19)}未注入（缺省）。${spec.missingHint}\n`)
  }
}
process.stdout.write('  package.json      来自 preset/bundle.package.json\n')
process.stdout.write('下一步：把该目录装进 profile（plugin_manager install_bundle，或 dsh plugin --profile <p> add file:<tgz> + 选入 dsh.profile.bundles）。\n')
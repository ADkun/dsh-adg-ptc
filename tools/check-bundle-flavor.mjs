#!/usr/bin/env node
// 生成物自检：钉住 tools/gen-preset-bundle.mjs 的**产物**里，每个注入组的工具名有没有进那段
// 「本会话的上下文工具」说明，以及 preset realm 那份 compaction-basic 的 `config.auto` 该不该在。
//
// 为什么单独一个脚本：根 AGENTS.md 红线 10（与 preset/AGENTS.md 红线 11 同源）要求那些名字**只能出现在生成物里**，而
// `tools/check-preset.mjs` 读的是**源文件**（它只会因为"源文件里出现了注入名"报错）—— 于是
// "生成物没注入 / 注错 / 注成别的味道"这件事在质量门里是**盲区**。本脚本补的就是这一格：
// 它只认生成物，且**自己探测形状**，这样 gen 脚本以后改缩进（ITEM_INDENT）也不会假绿。
//
// 注入点是什么：调度 persona 的 prefix 里那一段说明（要求调度者每次委派都把这些名字写进 `tools`）。
// 子代理的能力面由 `delegate` 在委派时现定，preset 里没有静态 `toolFilter.allow` 可注入 —— 所以
// 判据是"那段说明在不在、名字全不全"，与任何按行枚举的名单无关（旧形态的逐行 allow 已不存在）。
//
// 味道（flavor）= 生成时带了哪些注入组，四种：`plain` / `bili` / `save-token` / `bili+save-token`。
// 组表、工具名、目录名都在 tools/flavors.mjs（单一事实来源）—— 本脚本不另抄一份清单，抄了就会漂，
// 而漂的后果正是本机制最初要修的缺陷："子代理收到'去调它'的提示却没有工具"。
//
// 用法：
//   node tools/check-bundle-flavor.mjs <cordis.patch.yml> plain              # 断言：一个注入名都没有，且 compaction-basic 没有 config.auto
//   node tools/check-bundle-flavor.mjs <cordis.patch.yml> bili               # 断言：bili 四个名字全有，且 compaction-basic 是 config.auto: false
//   node tools/check-bundle-flavor.mjs <cordis.patch.yml> save-token         # 断言：save_token_expand 全有，且没有 config.auto
//   node tools/check-bundle-flavor.mjs <cordis.patch.yml> bili+save-token    # 两组的并集
// 退出码：0 通过 / 1 不通过 / 2 用法或文件错误。零依赖（按行扫，不解析 YAML）。
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import {
  GROUP_ORDER,
  INJECTION_GROUPS,
  autoCompactionOffFor,
  flavorKeys,
  notInjectedFor,
  parseFlavorKey,
} from './flavors.mjs'

const indentOf = (line) => line.length - line.replace(/^\s+/, '').length

const [file, flavor] = process.argv.slice(2)
if (!file || !flavor) {
  process.stderr.write(`用法：node tools/check-bundle-flavor.mjs <cordis.patch.yml> <${flavorKeys().join('|')}>\n`)
  process.exit(2)
}
let groups
try {
  groups = parseFlavorKey(flavor)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exit(2)
}
if (!existsSync(file)) {
  process.stderr.write(`文件不存在：${file}\n`)
  process.exit(2)
}

const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')
const errors = []
const report = []
/** 所有组里**故意不注入**的名字并集：出现在生成物里就该被看到（而不是被当成"注入清单没同步"）。 */
const NEVER_INJECTED = notInjectedFor(GROUP_ORDER)

// ── 注入段：调度 persona 里那段「本会话的上下文工具」说明 ──────────────────────
// 形状由 gen 脚本固定（记号与它共用同一串字面量），这里只按**记号**找，不写死缩进 —— 源文件与
// 生成物里这一段的列数不同，写死就是假绿。名字按**分词**比对而不是子串：`compress` 是
// `decompress` 的子串，用 `includes` 会把"只注了半个组"误判成全有。
const NOTE_MARKER = '**本会话的上下文工具'
const noteLines = lines.filter((line) => line.includes(NOTE_MARKER))
if (noteLines.length > 1) {
  errors.push(`生成物里有 ${noteLines.length} 段 ${NOTE_MARKER} 说明：注入段必须只有一段（gen 脚本按组各插一段，或有人手改了产物）`)
}
const note = noteLines[0] ?? ''
const noteTokens = new Set(note.split(/[^A-Za-z0-9_]+/).filter((token) => token !== ''))

if (groups.length > 0) {
  if (noteLines.length === 0) {
    errors.push(`味道 ${flavor} 要求调度 persona 里有 ${NOTE_MARKER} 说明（要求调度者每次委派带上 ${groups.map((g) => INJECTION_GROUPS[g].tools.join(' / ')).join('、')}），实际一段都没有`)
  }
  const marks = []
  for (const group of GROUP_ORDER) {
    const spec = INJECTION_GROUPS[group]
    const have = spec.tools.filter((tool) => noteTokens.has(tool))
    const state = have.length === spec.tools.length ? 'ALL' : have.length === 0 ? 'NONE' : 'PARTIAL'
    if (groups.includes(group)) {
      marks.push(`${group}:${state}`)
      // 该在的组必须**全有**：少一个 = 子代理收到"去调它"的提示却没有工具（本机制要修的缺陷）。
      if (state !== 'ALL') {
        errors.push(`味道 ${flavor} 要求 ${group} 组的 ${spec.tools.join(' / ')} 全在那段说明里，实际 ${have.length ? have.join(' / ') : '一个都没有'}`)
      }
    } else if (have.length > 0) {
      // 不该在的组必须**一个都没有**：那个 profile 里这些名字根本不存在，写了只是让 `tools_note` 多几条"未生效"。
      marks.push(`${group}:LEAK`)
      errors.push(`味道 ${flavor} 不含 ${group} 组，那段说明里不该出现 ${have.join(' / ')}`)
    }
  }
  report.push(`context-tools[${noteTokens.size} token]=${marks.length > 0 ? marks.join(' ') : 'NONE'}`)
  const leaked = NEVER_INJECTED.filter((tool) => noteTokens.has(tool))
  if (leaked.length > 0) errors.push(`那段说明里出现 ${leaked.join(' / ')}：它们不在任何注入清单里（gen 脚本与 tools/flavors.mjs 的清单需对齐）`)
} else if (noteLines.length > 0) {
  report.push('context-tools[LEAK]')
  errors.push(`味道 ${flavor} 不该有 ${NOTE_MARKER} 说明：它的 profile 里那些名字根本不存在，写了只会让 tools_note 多几条"未生效"`)
}

// ── compaction：挂 bili 时 preset realm 里的自动压缩必须被关掉 ──────────────────
// 判据用的是 bili 自己的键 `config.auto`（billion-context 的 dsh.bundle.patch.yml 就是这么写的，
// 它打的是 profile 层；本 preset 的 compaction 三行活在 isolate 出来的 realm 里，是**另一份实例**，
// 所以生成物里要再写一遍）。值必须恰好是 `false`：
//   - 要求关的组在（bili）：`auto: false` 在 ⇒ 关掉自动压缩与溢出恢复（手动 /compact 仍可用）；
//                缺这个键 ⇒ 子代理一边被 bili 的 nudge 催着压缩，一边 dsh 还在自己折叠同一段历史。
//   - 不含该组（plain / save-token）：绝对不能有 ⇒ 那两种 profile 里，dsh 自带的自动压缩是**唯一**
//                的压缩手段，关掉等于让上下文无限增长（这正是"多种味道"必须分开断言的原因）。
// 缩进同样自探测：源文件/生成物里这一行的列数不同，写死就是假绿。
const compRe = /^(\s*)- id: compaction-basic\s*$/
let compIndex = -1
let compIndent = 0
for (let i = 0; i < lines.length; i += 1) {
  const m = compRe.exec(lines[i])
  if (m) {
    compIndex = i
    compIndent = m[1].length
    break
  }
}
const autoExpected = autoCompactionOffFor(groups)
if (compIndex < 0) {
  errors.push('找不到 `- id: compaction-basic` 行：compaction 组被改动或那一行被删了')
} else {
  let auto = null
  for (let i = compIndex + 1; i < lines.length; i += 1) {
    const l = lines[i]
    if (l.trim() === '') continue
    if (indentOf(l) <= compIndent) break
    if (l.trimStart().startsWith('#')) continue
    const m = /^\s*auto:\s*(\S+)\s*$/.exec(l)
    if (m) auto = m[1].replace(/^["']|["']$/g, '')
  }
  report.push(`compaction-basic[auto=${auto ?? '未写'}]`)
  if (autoExpected && auto !== 'false') {
    errors.push(`compaction-basic：味道 ${flavor} 要求 config.auto: false（挂 bili 时关掉 dsh 自带自动压缩），实际 ${auto === null ? '没有这个键' : `auto: ${auto}`}`)
  }
  if (!autoExpected && auto !== null) {
    errors.push(`compaction-basic：味道 ${flavor} 不该有 config.auto（没挂 bili 时它是唯一的压缩手段），实际 auto: ${auto}`)
  }
}

// 顺带钉住那条与味道无关的不变量：委派行必须恰好一条，且它不带静态 toolFilter/persona
// （能力面与 persona 归 `delegate` 每次现给；写回静态名单就是把能力固定在挂载期）。
const delegation = lines.filter((line) => /^\s*- id: agent\s*$/.test(line))
if (delegation.length !== 1) {
  errors.push(`委派行应当恰好一条 \`- id: agent\`，实际 ${delegation.length} 条`)
}

for (const line of report) process.stdout.write(`  ${line}\n`)
if (errors.length > 0) {
  for (const e of errors) process.stdout.write(`ERROR ${e}\n`)
  process.stdout.write(`不通过：${errors.length} 个错误（${flavor} 味道 / ${report.length} 行报告）\n`)
  process.exit(1)
}
process.stdout.write(`通过：${report.length} 行报告，${flavor} 味道断言成立（注入组：${groups.length > 0 ? groups.join(' + ') : '无'}）\n`)
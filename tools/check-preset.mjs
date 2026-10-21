#!/usr/bin/env node
// 校验 Adg preset 的 `agent.cordis.yml`（以及安装到本机的那一份）。
//
// 检查项来自调度 persona 的【约束】/【验收标准】两段、各模块 `AGENTS.md` 的硬约束，以及实测事实：
//   1. LF 行尾 + 文件末尾有换行（仓库 .gitattributes 保证跨平台逐字节一致）；
//   2. `delegation` 组里恰好一条委派行（`- id: agent`）：provider / toolName /
//      backgroundMode 齐全；persona 与 toolFilter **刻意不写**（能力面与 persona 由
//      `delegate` 逐次给，见下），若写了则按旧口径校验齐全；
//   3. toolName 全局唯一（本 preset 只有一个，所以这条只在有人加回第二行时才起作用）；
//   4. `delegate` 的 `tools` 名单由调度者在委派时给，静态扫描器看不到 —— 这里只守
//      「子代理不得拿到这些名字」：`agent` / `delegate` 必须出现在第一方插件
//      `adg-delegate` 的内置 deny 名单里（`delegate/lib/delegate.mjs` 的 `BUILTIN_DENY`
//      数组字面量），`workflow` / `ralph` / `set_child_permission` / `ask_user_question`
//      应该有 —— 少了不会让哪次委派抛错，只会把调度者专属的工具面漏给子代理，所以判 WARN；
//   5. 不存在通用 `subagent` / `subagent_fork` 委派行；
//   5b. 技能面口径：委派行不再写 allow，所以这条只在 allow 存在时提示 —— 技能面只归
//      调度智能体；要用技能就照常委派，但不内联、不复述技能正文，只把技能的**绝对路径**
//      写进委派 prompt 并要它先 read（只有当时那条委派没给 read 的子代理才内联）——
//      完整口径与三种例外见调度 persona 的【技能】段；理由见 preset/design.md；
//   6. 文件顶部调度 persona 的「你手上的子代理」段里提到的委派工具名与委派行一一对应（双向，不能只加行
//      不改名册）；子代理的 `tools` 名单是运行期动态值，静态扫描器看不见，不在这里校验；
//   6b. 顶部调度 persona **不设** `suffix` 字段行 —— 0.2.1-rc.2 起 `{{cwd}}` 不再是注册的
//      prompt 变量（只有 `provider` / `model`），persona suffix section 没设 `interpolate:false`，
//      走插值路径会抛 `unknown prompt variable "{{cwd}}"`；工作目录改由 `working-directory:current`
//      运行时上下文提供（`interpolate:false`，渲染成 `Current working directory: ...`）；
//   7. 三组体积旋钮（共 8 个键）**刻意不被覆盖**，且承载它们的三行结构完好：
//      `compaction-basic` 的 thresholdRatio / retainRatio、`tool-result-pruner` 的
//      thresholdChars / headChars / tailChars、`tool-web` 的 fetchMaxOutputChars /
//      searchMaxResults / searchMaxQueries —— 本 preset 一律用插件出厂默认值
//      （0.8+0.16 / 8192+4096+1024 / 200000+8+4），不再靠截断工具结果与提前压缩省 token
//      因此这里**不再钉死取值**，只保留两类检查：
//      （a）三行必须存在、`name:` 正确、没被 `disabled` 关掉、同一个 id 不重复 ——
//          这几条坏了是整块能力消失或跑的根本不是那个插件；
//      （b）万一有人重新写回某个键（或在 `config:` 之外写），它必须落在插件会接受的
//          范围里：两个 ratio 在 (0,1] 且 retainRatio < thresholdRatio；pruner 正整数且
//          head + marker + tail ≤ threshold；tool-web 正整数且 fetchMaxOutputChars ≤ 200000
//          （> 60000 只提示）。不合法的那一行会在挂载时直接抛错。
//      除外：`compaction-basic` 的 `auto` 是**构建期注入**的键（红线 10）—— 源文件里出现就报错，
//      指向 `node tools/gen-preset-bundle.mjs --with-billion-context`（它按 bili 自己的
//      `dsh.bundle.patch.yml` 往生成物里写 `auto: false`，见 README「与 billion-context 协同」）。
//      同理，别的 bundle 注册到全局层的工具名（billion-context 的四个上下文工具、save-token 的
//      `save_token_expand`）也只能出现在生成物里：清单来自 tools/flavors.mjs，本脚本**不另抄一份**。
//
// 用法：
//   node tools/check-preset.mjs                                  # 校验仓库里的 preset/
//   node tools/check-preset.mjs <path-to-agent.cordis.yml>       # 校验任意一份文本
//   （dsh 不扫 $DSH_HOME/.agent-presets/<id>/：仓库里的 preset/agent.cordis.yml 是唯一文本真相源，
//     安装侧的真相是 profile 里注册的声明行 —— 由 bundle/adg-ptc/cordis.patch.yml 那个生成物提供。）
//
// 零依赖：本文件按行做结构化解析，不引入 YAML 库（文件形状由本仓库自己固定）。
// 注意它终究只是个**文本扫描器**，不是 YAML 解析器：它能证明"这些行写对了"，
// 不能证明整份文件能解析、也不能证明插件真的挂载成功 —— 后者要按根 README.md 的
// 「真实挂载验证」一节做一次真实挂载：`agentPresets.resolve('adg-ptc')` 的 `.broken` 为空
// （别从插件内部去读 preset 注册表的私有键，那些键名会随 dsh 版本变）。

import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { GROUP_ORDER, INJECTION_GROUPS } from './flavors.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const target = resolve(process.argv[2] ?? join(here, '..', 'preset', 'agent.cordis.yml'))

/**
 * 本 preset 组合里注册过的工具名（委派行 `allow` 与 `delegate` 的 `tools` 的合法取值）。
 * 依据：本文件的 `role/preset` 行 + composition 自己注册的那些行。改 composition 的 tool 行时同步这里。
 * 刻意不含 `subagent` / `subagent_fork`（硬约束：子代理不该有再开子代理的入口）与 `workflow` /
 * `ralph` / `create_goal` / `get_goal` / `update_goal`：后五个对应的行**已从 composition 摘掉**
 * （减少调度智能体每次请求的固定工具目录），名字不再注册 —— 写进 `allow` 会让那一次委派抛
 * `names unknown global tool ...`，所以它们落到本清单之外的 `fail()` 分支是**对的**。
 */
const KNOWN_TOOLS = new Set([
  // shell（tool-bash / tool-pwsh，按平台二选一）
  'bash',
  'pwsh',
  // filesystem（tool-fs / tool-fs-search）
  'read',
  'write',
  'edit',
  'read_image',
  'glob',
  'grep',
  // background jobs（tool-jobs）
  'job_list',
  'job_output',
  'job_kill',
  // skills（goals 的 `create_goal` / `get_goal` / `update_goal` 已随 preset 的两行一起摘掉，
  // 不再是合法取值 —— 写进去会让那一次委派抛 `names unknown global tool`）
  'skill',
  // delegation control（tool-subagent-control）
  'list_agents',
  'send_message',
  'interrupt_agent',
  // 委派入口：`agent` 是 delegation 组里那一行 dsh-tool-subagent 注册的工具名；
  // `delegate` 由第一方插件 adg-delegate 注册（两者都必须出现在它的 `BUILTIN_DENY` 里，见 5c）。
  // 两者都对**子代理**关闭（一跳可达），只有调度智能体拿得到。
  'agent',
  'delegate',
  // remaining model-facing rows
  'ask_user_question',
  // adg-delegate 的 `ask_user`：**子代理**的提问通道。平台自带的 `ask_user_question` 只认
  // live runtime root（子代理调它拿 `DELEGATED_CALLER`），所以那一格由本仓库补 —— 问题以
  // 派它的那个调度者为 owner 进用户提问服务，卡片落在用户的会话里（delegate/design.md 的 I11）。
  'ask_user',
  'todo_write',
  'web_search',
  'web_fetch',
  'present',
  // adg-notify（本仓库的第一方插件包，profile 级安装）
  'notify_user',
  // adg-permission（同为 profile 级安装的第一方插件包；只给调度智能体用 ——
  // 它改的是"自己派出去的子代理"的权限，而子代理本来就不该有子代理）
  'set_child_permission',
])

/**
 * 条件性注册的名字：通常都在，但缺条件时根本没注册，写进 allow 会让那一次委派直接抛
 * `names unknown global tool`。静态检查求值不了 `!!js`，也判断不了服务是否挂载，所以只提示。
 */
const CONDITIONAL_TOOLS = new Map([
  ['bash', 'Windows 上 tool-bash 被 disabled 行关掉（只在非 win32 注册）'],
  ['read_image', '依赖 attachments 服务（base 组合里恒有），服务缺失时不注册'],
  ['subagent_codex', '对应的 disabled 行没启用时不注册'],
  ['subagent_claude_code', '对应的 disabled 行没启用时不注册'],
])

/**
 * 只对调度智能体开放的名字 → 为什么子代理不该有它。
 * 这条只在有人把 allow 写回源文件（委派行）时才触发 —— 现在子代理的工具面由 `delegate` 逐次现给。
 * 注意这是策略问题而不是"必然抛错"——这些名字在本组合（或装了对应第一方插件的 profile）里
 * 确实注册了，restrict() 会接受它们。
 */
const SCHEDULER_ONLY = new Map([
  // `workflow` / `ralph` 已随 preset 摘掉注册行：它们不再是"策略越界"（曾在此列），
  // 而是**未知名** —— 落到下面的 KNOWN_TOOLS 之外、判 ERROR（`restrict()` 确实会抛）。
  [
    'set_child_permission',
    '权限面只归调度智能体 —— 它改的是"自己派出去的子代理"的权限，而子代理本来就不该有子代理',
  ],
  ['agent', '子代理拿到就能绕开一跳可达再开子代理（平台深度闸门会拒绝，但只有在它真去开的时候才报错）'],
  ['delegate', '同上一条：它是同一个委派入口的动态版，子代理拿到就能自己配能力面开下一层'],
])

/**
 * 由**构建期**注入、不该出现在源文件里的名字：别的 bundle 注册到全局层的工具。
 * 本文件（preset/agent.cordis.yml）是单一事实来源，必须对"没装那个 bundle"的机器也成立 ——
 * 那些名字在未挂载时**不存在**，写进 allow 会让每一次委派当场抛 `names unknown global tool`。
 * 要它们生效请走生成那一步：`node tools/gen-preset-bundle.mjs <该组的旗标>`
 * （install.ps1 / install.sh 会探测目标 profile 挂了哪些组，自动带上对应旗标）。
 * 清单**从 tools/flavors.mjs 推导**，不在这里另抄一份 —— 抄了就会漂，漂了就是"委派全失败"或"漏注入"。
 * 值里的 `notInjected` 是那组里**故意不注入**的名字（例如 bili 的 acp_cache）：同样算红线 10 违规，
 * 提示语不同（它的修法是改清单，不是加旗标）。
 */
const BUILD_TIME_INJECTED_TOOLS = new Map()
for (const group of GROUP_ORDER) {
  const spec = INJECTION_GROUPS[group]
  for (const tool of spec.tools) {
    BUILD_TIME_INJECTED_TOOLS.set(tool, { flag: spec.flag, reason: spec.sourceReason, notInjected: false })
  }
  for (const tool of spec.notInjected) {
    BUILD_TIME_INJECTED_TOOLS.set(tool, {
      flag: spec.flag,
      reason: `${spec.sourceReason}（注意：gen 的注入清单里**没有**这个，需要它请改 tools/flavors.mjs 里 ${group} 组的 tools）`,
      notInjected: true,
    })
  }
}

const errors = []
const warnings = []
const fail = (message) => errors.push(message)
const warn = (message) => warnings.push(message)
const indentOf = (line) => line.length - line.trimStart().length

function readTarget() {
  try {
    // 目录也能被 readFileSync 打开（Linux 上 EISDIR、Windows 上读到垃圾字节），
    // 所以先判类型：路径不存在 / 打不开 → exit 2，存在但不是普通文件 → 也 exit 2。
    if (!statSync(target).isFile()) return null
    return readFileSync(target)
  } catch (error) {
    console.error(`无法读取 ${target}：${error.message}`)
    process.exit(2)
  }
}

const raw = readTarget()
if (raw === null) {
  console.error(`无法读取 ${target}：不是普通文件`)
  process.exit(2)
}
const text = raw.toString('utf8')
// 解析用归一化后的行：CRLF 文件要先把 `\r` 去掉，否则 `.` 不匹配 `\r`，
// 所有 `key: value` 正则都会静默失效（实测踩过）。行尾问题由下面的检查单独报。
const lines = text.replace(/\r\n/g, '\n').split('\n')

// ── 1. 行尾与末尾换行 ──────────────────────────────────────────────────────
if (text.includes('\r')) fail('出现 CR（\\r）：文件必须只用 LF 行尾')
if (!text.endsWith('\n')) fail('文件末尾缺少换行（LF）')
if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) fail('文件带 UTF-8 BOM：composition 不应带 BOM')

// ── 2/3/4. 委派行 ──────────────────────────────────────────────────────────
/** @type {{id:string,line:number,toolName?:string,allow:string[],hasAllow:boolean,hasPersona:boolean,personaChars:number,provider?:string,backgroundMode?:string,disabled?:boolean}[]} */
const rows = []
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index]
  const start = /^ {4}- id: (agent[a-z0-9-]*)\s*$/.exec(line)
  if (start === null) continue
  const row = {
    id: start[1],
    line: index + 1,
    allow: [],
    hasAllow: false,
    hasPersona: false,
    personaChars: 0,
  }
  const rowIndent = indentOf(line)
  let allowIndent = -1
  let personaIndent = -1
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const inner = lines[cursor]
    if (inner.trim() === '') continue
    const innerIndent = indentOf(inner)
    if (innerIndent <= rowIndent && inner.trimStart().startsWith('- id:')) break
    if (innerIndent <= rowIndent && !inner.startsWith(' ')) break
    if (innerIndent === rowIndent && /^disabled:/.test(inner.trim())) row.disabled = true
    if (personaIndent >= 0 && innerIndent > personaIndent) {
      row.personaChars += inner.trim().length
      continue
    }
    personaIndent = -1
    if (allowIndent >= 0 && /^\s+- \S/.test(inner) && innerIndent > allowIndent) {
      row.allow.push(inner.trim().replace(/^- /, ''))
      continue
    }
    allowIndent = -1
    const key = /^(\s+)([A-Za-z][A-Za-z0-9]*):(.*)$/.exec(inner)
    if (key === null) continue
    const [, spaces, name, rest] = key
    const base = innerIndent
    if (name === 'toolName') row.toolName = rest.trim()
    else if (name === 'provider') row.provider = rest.trim()
    else if (name === 'backgroundMode') row.backgroundMode = rest.trim()
    else if (name === 'persona') {
      row.hasPersona = rest.trim() === '|-' || rest.trim() === '|'
      personaIndent = base
    } else if (name === 'allow') {
      allowIndent = base
      row.hasAllow = true
      void spaces
    }
  }
  rows.push(row)
}

if (rows.length === 0) fail('没有解析到任何委派行（期望形如 `    - id: agent`）')

// disabled 的行（`tool-subagent-codex` / `tool-subagent-claude-code`）是关着的 provider：
// 它们不参与"委派入口"的校验（那一行有它自己的 provider，也不是本 preset 的委派入口）。
const activeRows = rows.filter((row) => row.disabled !== true)
const active = activeRows.map((row) => row.toolName ?? row.id)

const seen = new Map()
for (const row of activeRows) {
  if (row.toolName === undefined) fail(`第 ${row.line} 行 ${row.id}：缺少 toolName`)
  else if (row.toolName.trim() === '') fail(`第 ${row.line} 行 ${row.id}：toolName 为空`)
  if (row.toolName !== undefined) {
    if (seen.has(row.toolName)) fail(`toolName "${row.toolName}" 重复（第 ${seen.get(row.toolName)} 行与第 ${row.line} 行）：每个委派工具名必须全局唯一`)
    else seen.set(row.toolName, row.line)
  }
  if (row.provider !== 'spawn') fail(`第 ${row.line} 行 ${row.id}：provider 应为 spawn，实际 ${String(row.provider)}`)
  if (row.backgroundMode !== 'continuable') warn(`第 ${row.line} 行 ${row.id}：backgroundMode 不是 continuable（委派默认后台接续）`)
  // persona 与 toolFilter 都是**刻意可选**：能力面与 persona 改由 `delegate` 在每次委派时给
  // （见文件顶部 2/4 条红线）。写了就按旧口径校验齐全，不写不判错。
  if (row.hasPersona && row.personaChars < 60) warn(`第 ${row.line} 行 ${row.id}：persona 只有 ${row.personaChars} 字，可能没写清边界与越界处理`)
  if (!row.hasAllow) warn(`第 ${row.line} 行 ${row.id}：没有 toolFilter —— 这是现在刻意的形态（能力面由 delegate 的 tools 逐次给）；写着它只会把 capability 固定在挂载期`)
  else if (row.allow.length === 0) fail(`第 ${row.line} 行 ${row.id}：toolFilter.allow 为空——restrict() 只看 allow/deny，空 allow 等于什么都不给；要么删掉这个键，要么填名字`)
  for (const tool of row.allow) {
    if (BUILD_TIME_INJECTED_TOOLS.has(tool)) {
      const injected = BUILD_TIME_INJECTED_TOOLS.get(tool)
      fail(`第 ${row.line} 行 ${row.id}：allow 里的 "${tool}" 是构建期注入的名字（${injected.reason}）——不要手写进源文件，用 node tools/gen-preset-bundle.mjs ${injected.flag} 生成`)
      continue
    }
    if (SCHEDULER_ONLY.has(tool)) {
      warn(`第 ${row.line} 行 ${row.id}：allow 里的 "${tool}" 是策略越界——它只留给调度智能体（restrict() 会接受它、不会让委派失败，但${SCHEDULER_ONLY.get(tool)}）`)
      continue
    }
    if (KNOWN_TOOLS.has(tool)) {
      const reason = CONDITIONAL_TOOLS.get(tool)
      if (reason !== undefined) {
        warn(`第 ${row.line} 行 ${row.id}：allow 里的 "${tool}" 是条件性注册的名字（${reason}）——条件不满足时这一次委派会抛 names unknown global tool`)
      }
      continue
    }
    // 允许把别的委派工具名写进 allow：这是"让某个子代理能直接转交"的官方开关。
    if (seen.has(tool)) continue
    fail(`第 ${row.line} 行 ${row.id}：allow 里的 "${tool}" 不是本组合注册过的工具名——restrict() 会抛 "names unknown global tool"`)
  }
  // 委派行不写 allow，所以这条只在有人给委派行写回 allow 时提示（技能面口径随之失效）。
  if (row.allow.includes('skill')) {
    warn(`第 ${row.line} 行 ${row.id}：allow 里的 "skill" 不该出现在委派行（技能面口径，见 preset/design.md）——技能面只归调度智能体；要用技能就把技能**绝对路径**写进委派 prompt 并要它先 read（完整口径见调度 persona 的【技能】段）`)
  }
}

// 委派入口唯一：`agent` 这一行是调度智能体唯一的委派入口。多一行就等于多一个固定能力面
// 的实例 —— 那正是这次改造要去掉的东西（要新能力面就在委派时用 delegate 给）。
{
  const delegations = activeRows.filter((row) => row.toolName === 'agent')
  if (delegations.length === 0) fail('没有委派入口：期望 delegation 组里有一行 toolName: agent')
  else if (delegations.length > 1) {
    fail(`有 ${delegations.length} 个 toolName: agent 的委派入口（第 ${delegations.map((row) => row.line).join(' / ')} 行）：委派入口必须唯一，能力面由 delegate 在委派时给`)
  } else {
    const row = delegations[0]
    if (row.provider !== 'spawn') fail(`第 ${row.line} 行 ${row.id}：委派入口的 provider 应为 spawn，实际 ${String(row.provider)}`)
    if (row.backgroundMode !== 'continuable') fail(`第 ${row.line} 行 ${row.id}：委派入口的 backgroundMode 应为 continuable，实际 ${String(row.backgroundMode)}`)
    if (row.hasPersona) warn(`第 ${row.line} 行 ${row.id}：委派入口写了 persona —— 它会给**所有**子代理套同一段 persona，只有确实要"每个子代理都先看这段"时才这样写`)
  }
}
 /**
 * 必须有：缺了它们，子代理手上就留着"再开一个子代理"的入口（一跳可达失效）。
 * 由第一方插件 `adg-delegate` 的 `BUILTIN_DENY` 承担（`delegate/lib/delegate.mjs`）。
 */
const DENIED_FOR_CHILDREN = new Set(['agent', 'delegate'])

/**
 * 应该有：缺了不会让哪次委派抛错，但会把只留给调度智能体的工具面漏给子代理 ——
 * 策略越界，按 `tools/AGENTS.md` 的红线 1 只判 WARN。
 *
 * `workflow` / `ralph` 的引擎行已从 preset 摘掉（名字不再注册），这里**仍然要求它们出现在
 * `BUILTIN_DENY` 的字面量里**：名字不存在时 deny 是空的但无害；哪天引擎行被加回来，
 * 那道闸门已经就位（理由见 `preset/agent.cordis.yml` 的 `delegation` 组注释）。
 */
const EXPECTED_DENIED_FOR_CHILDREN = new Set([
  'workflow',
  'ralph',
  'set_child_permission',
  'ask_user_question',
])

/**
 * 不该出现在内置名单里的：`notify_user` 是单向、不阻塞的提醒，`notify/design.md` 的
 * 「对外接口」与 `preset/design.md` 的 R20 明确允许"让拿到它的子代理自己发一条" —— 禁掉会让那条承诺变成假话。判 WARN。
 */
const SHOULD_STAY_AVAILABLE = new Set(['notify_user'])

/**
 * **必须**留给子代理的：`ask_user` 是子代理唯一的提问通道（登录墙 / 验证码 / 要人拍板时用）。
 * 它出现在 `BUILTIN_DENY` 里 = 子代理又只能"单向喊一声 + 轮询"，那正是这次改造要去掉的东西 —— 判 ERROR。
 */
const MUST_BE_AVAILABLE_TO_CHILDREN = new Set(['ask_user'])

// ── 5. 通用委派行 ──────────────────────────────────────────────────────────
for (const [index, line] of lines.entries()) {
  const generic = /^\s+toolName:\s*(subagent|subagent_fork)\s*$/.exec(line)
  if (generic !== null) fail(`第 ${index + 1} 行出现通用委派工具 "${generic[1]}"：子代理会绕过自己的范围再开不受限子代理`)
}

// ── 5c. 一跳可达：子代理的内置 deny 名单里必须有这些入口 ────────────────────
// 事实来源：`delegate/lib/delegate.mjs` 的 `BUILTIN_DENY`（内置 deny，即使被点名也不给）。
// 判据是"名字出现在那个数组**字面量**里"，不是"文件里出现过这个字符串" —— 后者连注释、
// 标识符与工具描述都算，是假证据。
// 它是"子代理开不了子代理"的第一道闸门；第二道是平台深度默认 1（`subagent depth 2 exceeds maxDepth 1`）。
{
  const delegatePath = join(dirname(target), '..', 'delegate', 'lib', 'delegate.mjs')
  let source
  try {
    source = readFileSync(delegatePath, 'utf8')
  } catch {
    warn(`没读到 delegate 插件（${delegatePath}）：跳过"子代理永禁名单"一致性校验`)
  }
  if (source !== undefined) {
    const literal = /export const BUILTIN_DENY\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(source)
    if (literal === null) {
      warn(`delegate/lib/delegate.mjs 里读不到 export const BUILTIN_DENY = Object.freeze([...])：跳过"子代理永禁名单"一致性校验（导出形状改了，本文件跟不上）`)
    } else {
      const denied = new Set([...literal[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]))
      for (const tool of DENIED_FOR_CHILDREN) {
        if (!denied.has(tool)) {
          fail(`delegate/lib/delegate.mjs 的 BUILTIN_DENY 里没有 "${tool}"：子代理的工具目录里会留着这个委派入口（一跳可达失效；平台深度闸门只在它真去开的时候才拒绝）`)
        }
      }
      for (const tool of EXPECTED_DENIED_FOR_CHILDREN) {
        if (!denied.has(tool)) {
          warn(`delegate/lib/delegate.mjs 的 BUILTIN_DENY 里没有 "${tool}"：它只留给调度智能体，缺了就会把这份工具面漏给子代理（restrict() 会接受它，所以不会让委派失败）`)
        }
      }
      for (const tool of SHOULD_STAY_AVAILABLE) {
        if (denied.has(tool)) {
          warn(`delegate/lib/delegate.mjs 的 BUILTIN_DENY 里有 "${tool}"：它是单向、不阻塞的提醒，\`notify/design.md\` 的「对外接口」与 \`preset/design.md\` 的 R20 允许子代理用它 —— 禁掉会让那条承诺变成假话`)
        }
      }
      for (const tool of MUST_BE_AVAILABLE_TO_CHILDREN) {
        if (denied.has(tool)) {
          fail(`delegate/lib/delegate.mjs 的 BUILTIN_DENY 里有 "${tool}"：它是子代理**唯一**的提问通道（登录墙 / 验证码 / 要人拍板时用），禁掉就等于把子代理打回"单向喊一声 + 轮询"（见 preset/design.md 的 I17 与 delegate/design.md 的 I11）`)
        }
      }
    }
  }
}

// ── 6. 调度名册 ↔ 委派行 ──────────────────────────────────────────────────
const declared = active
const prefixStart = lines.findIndex((line) => /^\s+prefix: \|-/.test(line))
if (prefixStart < 0) fail('没找到顶部 persona 的 prefix: |- block（调度名册应当写在这里）')
else {
  const block = []
  for (let cursor = prefixStart + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]
    if (line.trim() !== '' && indentOf(line) <= indentOf(lines[prefixStart])) break
    block.push(line)
  }
  const roster = block.join('\n')
  for (const toolName of declared) {
    if (!roster.includes(toolName)) fail(`调度名册里没有 ${toolName}：委派行加了但 persona 名册没同步（调度智能体不会知道它存在）`)
  }
  // 名册里以 `agent_<name>` 形式提到的委派工具名必须都有对应的行。单实例叫 `agent`
  // （不带下划线），所以它不会被这条正则逮住，靠上面那条"每个 declared 都要出现在名册里"兜住。
  //
  // `agent_id` 不是委派工具名，是 `delegate` / `send_message` / `set_child_permission` 共用的
  // **参数名**：PTC 版 persona 会写成 `await tools.send_message({ agent_id, message })`，
  // 若不过滤，这条启发式会把一个参数名判成"名册提到不存在的委派行"。
  const ROSTER_NOT_A_TOOL = new Set(['agent_id'])
  for (const mention of new Set(roster.match(/agent_[a-z0-9_]+/g) ?? [])) {
    if (ROSTER_NOT_A_TOOL.has(mention)) continue
    if (!declared.includes(mention)) fail(`调度名册提到 ${mention}，但没有对应的委派行（名册与实现不一致）`)
  }
}

// ── 6b. 调度 persona 不设 suffix（0.2.1-rc.2 起 {{cwd}} 不再是注册 prompt 变量）──
// 纯文本扫描：把 `- id: persona` 那段切出来，检查段内没有非空 `suffix:` 字段行。
// 0.2.1-rc.2 里 `{{cwd}}` 不是注册的 prompt 变量（只有 `provider` / `model`），
// persona suffix section 没设 `interpolate:false`，走插值路径会抛
// `unknown prompt variable "{{cwd}}"`。工作目录改由 `working-directory:current`
// 运行时上下文提供（`interpolate:false`，渲染成 `Current working directory: ...`）。
const personaStart = lines.findIndex((line) => /^\s*- id: persona\s*$/.test(line))
if (personaStart < 0) {
  fail('没找到顶层 persona 的 `- id: persona` 行：调度 persona 失去落点（应当只有一份，带 `prefix: |-` 字段）')
} else {
  const personaBlock = []
  for (let cursor = personaStart + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]
    if (line.trim() !== '' && indentOf(line) <= indentOf(lines[personaStart])) break
    personaBlock.push(line)
  }
  const suffixLines = personaBlock.filter((line) => /^\s*suffix:\s*\S/.test(line))
  if (suffixLines.length > 0) {
    fail(`persona 段有非空 \`suffix:\` 字段行：0.2.1-rc.2 起 \`{{cwd}}\` 不再是注册 prompt 变量，persona suffix section 走插值路径会抛 \`unknown prompt variable\`。删掉 \`suffix:\` 字段行；工作目录由 \`working-directory:current\` 运行时上下文提供（见 preset/design.md 的 SchedulerPersona 一节）`)
  }
}

// ── 7. 体积旋钮（刻意不覆盖，只守结构与合法性）─────────────────────────────
// 纯文本扫描，不解析 YAML：按 `- id:` 定位目标行，再把行内 `key: value` 按缩进栈收成
// 「路径 → 值」。路径能分辨"直挂 config 下"与"嵌得更深/提到同级"，这是下面结构守卫的前提。

/**
 * 三个插件各自的**出厂默认值**（写入这些值的是插件包自己；换插件版本时必须对着当前安装
 * 重新取值，别沿用本文件里的旧数）：
 *   - `@deepseek-ai/dsh-compaction-basic`：thresholdRatio 0.8、retainRatio 0.16；
 *   - `@deepseek-ai/dsh-compaction-tool-result-pruner`：thresholdChars 8192、headChars 4096、
 *     tailChars 1024；
 *   - `@deepseek-ai/dsh-tool-web`：fetchMaxOutputChars 200000、searchMaxResults 8、
 *     searchMaxQueries 4。
 * 取值怎么核（可复跑）：在目标 profile 里读插件包自己的源码，找它导出默认配置的那一处
 * （`node -p "require.resolve('<包名>')"` 给出该包的入口文件，打开它搜上面的键名即可）；
 * 本文件里的做法与范围判据不依赖这件事——它们只要求"落在插件会接受的范围内"。
 * 本 preset **不覆盖**这些键，所以这张表只在报告里当对照，不参与判错。
 * 这里刻意**不钉死 preset 里的取值**：截断会把工具**已经取到**的事实切掉（模型只能重取、
 * 换查询或拿残缺证据下结论，三者都比不裁更贵）；提前压缩不可逆（过了压缩点一切只能基于
 * 摘要）。所以现在只守两类事实：
 *   （a）行结构完好：行在、包名对、没 disabled、id 不重复；
 *   （b）**万一有人重新写回某个键**，取值必须在插件会接受的范围内，否则那一行挂载即抛错。
 * 为什么不设 token 预算的理由见根 `README.md` 的「怎么用」一节（「为什么不设 token 预算」那一段）。
 */
const FACTORY_DEFAULTS = {
  compaction: { thresholdRatio: 0.8, retainRatio: 0.16 },
  pruner: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
  web: { fetchMaxOutputChars: 200000, searchMaxResults: 8, searchMaxQueries: 4 },
}

/**
 * `@deepseek-ai/dsh-compaction-tool-result-pruner` 的 `PRUNE_MARKER` 是
 * `"\n\n[... tool result middle pruned ...]\n\n"`，按码点数正好 **39**；插件自己用它算实际吐出长度：
 *   headChars + codePointLength(PRUNE_MARKER) + tailChars > thresholdChars → 抛错
 * 这里必须照抄这个算式：只看 `head + tail` 会把越界判成合法（2048+2010=4058 < 4096，
 * 而真实吐出是 4058+39=4097 > 4096）。
 * 另注：运行期允许 headChars / tailChars 为 0（assertNonNegativeInteger）；本 preset 不覆盖
 * 这些键，所以下面只在"有人写回某个键"时才要求正整数 —— 留 0 头或 0 尾等于把中间段整段丢掉，
 * 那种覆盖不该通过自检。
 */
const PRUNER_MARKER_CHARS = 39

/**
 * 体积旋钮所在行的结构守卫。每一条都对应一种"看起来配了、其实没生效"（或反过来
 * "看起来没配、其实整块能力没了"）的绕法：
 *   1. `name:` 必须是期望的包名 —— 只认 `id:` 的话，`id: tool-web` 换个 `name:` 照样通过，
 *      但真正跑的是别的插件（运行期不报错，只用别的默认值）；
 *   2. 行内出现 `disabled: true` → ERROR —— 被禁用的行不挂载，该插件的能力整块消失；
 *   3. 同一个期望 id 命中多行 → ERROR —— 诱饵/重复行让"到底哪一行生效"不可判定
 *      （id 按树唯一，重复 id 本身就是坏配置）；
 *   4. 万一某个旋钮键被写回，它必须**直挂**在同级 `config:` 下、缩进恰好比 `config:` 深一级 ——
 *      嵌得更深运行期要么拒绝这条配置、要么忽略它，提到与 `name:` 同级则根本进不了插件的
 *      config（两种都会静默用默认值，而写的人以为它生效了）；
 *   5. `config:` 块里出现不认识的键 → ERROR 并点名 —— 三个插件都校验自己的键集
 *      （compaction-basic 与 pruner 的 validateKeys/键集检查对未知名直接抛错），
 *      拼错的键会让整行挂载失败，而不是被忽略。
 * 期望包名写在各 spec 上；取值只用来对照报告里的出厂默认值（FACTORY_DEFAULTS），不参与判错。
 */
const EXPECTED_ROWS = [
  {
    label: '`compaction` 组 compaction-basic',
    idPrefix: 'compaction-basic',
    name: '@deepseek-ai/dsh-compaction-basic',
    budgetKeys: Object.keys(FACTORY_DEFAULTS.compaction),
    // 该插件 BASIC_COMPACT_CONFIG_KEYS 导出的全部键；换插件版本时必须对着当前安装核对。
    allowedKeys: [
      'thresholdRatio',
      'retainRatio',
      'retainTokens',
      'summarizationProvider',
      'summarizationModel',
      'maxTokens',
      'compactionRetries',
      'maxOverflowRetries',
      'modelPolicies',
      'auto',
    ],
    missingRow: '`compaction` 组里找不到 `compaction-basic` 行：它决定这个 preset 的 agent 会不会压缩上下文',
  },
  {
    label: '`compaction` 组 tool-result-pruner',
    idPrefix: 'tool-result-pruner',
    name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
    budgetKeys: Object.keys(FACTORY_DEFAULTS.pruner),
    // 该插件 CONFIG_KEYS 导出的三个旋钮键；换插件版本时必须对着当前安装核对。
    allowedKeys: ['thresholdChars', 'headChars', 'tailChars'],
    missingRow: '`compaction` 组里找不到 `tool-result-pruner` 行：单条工具结果不会被裁剪，上下文体积会失控',
  },
  {
    label: '顶层 tool-presentation',
    idPrefix: 'tool-presentation',
    name: '@deepseek-ai/dsh-agent-tool-presentation',
    // 本行**没有**体积旋钮；它只有一个 `mode`，取值另有一条专用守卫（见下面的 EXPECTED_PRESENTATION_MODE）。
    budgetKeys: [],
    // 该插件 Config 只导出一个键（`mode`，必填，无默认值）；换插件版本时必须对着当前安装核对。
    allowedKeys: ['mode'],
    missingRow: '找不到 `tool-presentation` 行：本 preset 会退回部署默认的 `native` 呈现 —— 工具目录照旧按原生 schema 摊开，PTC 的省法整个失效',
  },
  {
    label: '顶层 tool-web',
    idPrefix: 'tool-web',
    name: '@deepseek-ai/dsh-tool-web',
    budgetKeys: Object.keys(FACTORY_DEFAULTS.web),
    // 该插件 Config 导出的全部键；换插件版本时必须对着当前安装核对。
    allowedKeys: [
      'search',
      'fetch',
      'searchMaxResults',
      'searchMaxQueries',
      'fetchTimeoutMs',
      'searchTimeoutMs',
      'fetchMaxOutputChars',
    ],
    missingRow: '找不到 `tool-web` 行：联网工具的抓取能力整块消失',
  },
]

/**
 * 在预算行里"合法开一个嵌套块"的键名：`config:` 本身，以及允许出现在 config 下的
 * 嵌套对象键（tool-web 的 `search` 是布尔、不会嵌套；compaction-basic 的
 * `modelPolicies` 是对象数组）。列在这里的键**不会**遮蔽它下面的标量值，
 * 其它"只有键名、没有值"的行按嵌套对象处理，其下面的键不算"直挂 config"。
 */
const NESTED_BLOCK_KEYS = new Set(['config', 'modelPolicies'])

/**
 * 读一条 `- id: ...` 行块：块内所有非空行都必须缩进更深、且不能是序列项。
 * 返回行内每个 `key:` 的完整路径（按缩进栈拼）与它的标量值（嵌套块的父键为 null）。
 * @returns {{line:number, id:string, indent:number, paths:Map<string,string|null>, pathLines:Map<string,number>, rootScalars:Map<string,string>, innerLines:Set<number>}}
 */
function readRowBlock(startIndex) {
  const start = /^(\s*)- id: (\S+)\s*$/.exec(lines[startIndex])
  const rowIndent = indentOf(lines[startIndex])
  const paths = new Map()
  const pathLines = new Map()
  const rootScalars = new Map()
  const innerLines = new Set()
  // 缩进栈：只留"当前还开着的"祖先键（按缩进从浅到深）。
  const stack = []
  for (let cursor = startIndex + 1; cursor < lines.length; cursor += 1) {
    const inner = lines[cursor]
    if (inner.trim() === '') break
    const innerIndent = indentOf(inner)
    if (innerIndent <= rowIndent) break
    if (/^\s*- /.test(inner)) break
    innerLines.add(cursor)
    const entry = /^(\s+)([A-Za-z][A-Za-z0-9]*):(.*)$/.exec(inner)
    if (entry === null) continue
    const [, spaces, key, rest] = entry
    while (stack.length > 0 && spaces.length <= stack[stack.length - 1].indent) stack.pop()
    const path = [...stack.map((frame) => frame.key), key].join(' > ')
    // YAML 标量两侧的引号是语法，不是值的一部分（包名一律写成 '@deepseek-ai/...'）。
    const value = (rest.trim().match(/^(['"])([\s\S]*)\1$/) ?? [null, null, rest.trim()])[2]
    // `key:` 后面没东西 = 开了一个嵌套块。`config:` / `search:` 这类块本身不是值，
    // 但它下面的标量仍是自己的值，所以只把"非块的嵌套对象祖先"算作遮蔽。
    const hasValue = value !== ''
    const opensBlock = !hasValue && NESTED_BLOCK_KEYS.has(key)
    const hidden = stack.some((frame) => !frame.hasValue && !frame.opensBlock)
    paths.set(path, hasValue && !hidden ? value : null)
    pathLines.set(path, cursor + 1)
    if (spaces.length === rowIndent + 2) rootScalars.set(key, hasValue ? value : '')
    stack.push({ key, indent: spaces.length, hasValue, opensBlock })
  }
  return { line: startIndex + 1, id: start[2], indent: rowIndent, paths, pathLines, rootScalars, innerLines }
}

/** 命中该 id 的所有行（可能多于一条：重复/诱饵行要报错而不是取第一条了事）。 */
function rowsOf(idPrefix) {
  const pattern = new RegExp(`^\\s*- id: ${idPrefix}\\s*$`)
  return lines.flatMap((line, index) => (pattern.test(line) ? [readRowBlock(index)] : []))
}

/** 值**直接**挂在 `config:` 下才算数（不是"任何深度都算"）。 */
const directPath = (row, key) => (row.paths.has(`config > ${key}`) ? `config > ${key}` : undefined)

/** 读一个直接挂在 config 下的十进制正整数：`4096` 算，`4_096` / `4.0` / `1e3` 不算。 */
function positiveIntegerOf(row, key) {
  const path = directPath(row, key)
  const value = path === undefined ? undefined : row.paths.get(path)
  if (value === undefined || value === null) return undefined
  return /^\+?\d+$/.test(value) ? Number(value) : undefined
}

/** 读一个直接挂在 config 下的小数：`0.6` / `.6` 都算，其它形状返回 undefined。 */
function ratioOf(row, key) {
  const path = directPath(row, key)
  const value = path === undefined ? undefined : row.paths.get(path)
  if (value === undefined || value === null) return undefined
  return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) ? Number(value) : undefined
}

for (const spec of EXPECTED_ROWS) {
  const matched = rowsOf(spec.idPrefix)
  if (matched.length === 0) {
    fail(spec.missingRow)
    continue
  }
  const row = matched[0]
  // 命中多行时，"哪一行才是生效的那一行"本身就不可判定，所以只报结构性的 name/disabled，
  // 不再对第一条做取值比较（否则只会叠一串次生错误，掩盖真正的原因）。
  const duplicated = matched.length > 1
  if (duplicated) {
    fail(`${spec.label}：id 以 ${spec.idPrefix} 开头的行命中 ${matched.length} 条（第 ${matched.map((item) => item.line).join(' / ')} 行）——同一个期望行只允许一条，重复/诱饵行会让"哪一行生效"不可判定`)
  }

  // 守卫 2：被 disabled 关掉的行不挂载，该插件的能力整块消失。
  if (row.rootScalars.get('disabled') === 'true') {
    fail(`第 ${row.line} 行 ${row.id}：这一行被 disabled: true 关掉了——该插件不会挂载，它承载的能力整块消失`)
  }
  // 守卫 1：id 对了但包名被换掉 = 跑的是别的插件。
  const rowName = row.rootScalars.get('name')
  if (rowName !== spec.name) {
    fail(`第 ${row.line} 行 ${row.id}：name 应为 ${spec.name}，实际 ${rowName ?? '（缺失）'}——id 对了但包名不对，跑起来的是别的插件`)
  }
  if (duplicated) {
    for (const item of matched.slice(1)) {
      if (item.rootScalars.get('name') === spec.name) continue
      fail(`第 ${item.line} 行 ${item.id}：重复的 ${spec.idPrefix} 行的 name 是 ${item.rootScalars.get('name') ?? '（缺失）'}，与期望的 ${spec.name} 不一致`)
    }
    continue
  }

  // 守卫 5 的输入：直接挂在 config: 下的键集合。
  const configKeys = new Set()
  for (const path of row.pathLines.keys()) {
    if (!path.startsWith('config > ')) continue
    const rest = path.slice('config > '.length)
    if (!rest.includes(' > ')) configKeys.add(rest)
  }

  // 守卫 4：旋钮键存在但没直挂 config 下 → 指出它到底写在哪了。
  for (const key of spec.budgetKeys) {
    if (directPath(row, key) !== undefined) continue
    const found = [...row.paths.keys()].find((path) => path === key || path.endsWith(` > ${key}`))
    if (found === undefined) continue
    fail(
      found.includes(' > ')
        ? `第 ${row.line} 行 ${row.id}：${key} 写在了 ${found}，不是直接挂在 config: 下——嵌得更深运行期会拒绝这条配置或直接忽略它，等于用默认值`
        : `第 ${row.line} 行 ${row.id}：${key} 被提到与 name: 同级（写成了 ${found}），没有出现在 config: 下——它不会进插件的 config，运行期静默用默认值`,
    )
  }

  // 取值检查：**只在有人写回某个键时**进行，而且只查"插件会不会接受"，
  // 不再与任何期望值比较 —— 本 preset 的口径就是"不覆盖，用出厂默认值"。
  for (const key of spec.budgetKeys) {
    const isRatio = key === 'thresholdRatio' || key === 'retainRatio'
    const actual = isRatio ? ratioOf(row, key) : positiveIntegerOf(row, key)
    if (actual === undefined) {
      const written = directPath(row, key) === undefined ? undefined : row.paths.get(`config > ${key}`)
      if (written !== undefined && written !== null) {
        fail(`第 ${row.line} 行 ${row.id}：${key} = ${written} 不是${isRatio ? '小数' : '十进制正整数'}——插件加载时会拒绝这个值，整行挂载失败`)
      }
      continue
    }
    if (key === 'fetchMaxOutputChars' && actual > 200000) {
      fail(`第 ${row.line} 行 ${row.id}：fetchMaxOutputChars ${actual} 超过 200000（tool-web 的出厂上限）——插件加载时会拒绝，整行挂载失败`)
      continue
    }
    if (key === 'fetchMaxOutputChars' && actual > 60000) {
      warn(`第 ${row.line} 行 ${row.id}：显式覆盖了 fetchMaxOutputChars=${actual}（> 60000）——本 preset 的口径是不覆盖（出厂 200000）；压小单次抓取会把工具已经取到的事实切掉`)
    }
  }

  // 守卫 5：config 块里不认识的键会让整行挂载失败，点名报出来。
  for (const key of configKeys) {
    if (spec.allowedKeys.includes(key)) continue
    const lineNo = row.pathLines.get(`config > ${key}`) ?? row.line
    fail(`第 ${lineNo} 行 ${row.id}：config 里的 "${key}" 不是 ${spec.name} 认识的键——插件校验键集时会直接抛 unknown key，整行挂载失败`)
  }
}

// ── 7b. 呈现模式必须是 ptc ─────────────────────────────────────────────────
// `tool-presentation` 行的唯一键 `mode` 决定了这份 preset 到底走不走 PTC：
//   - 省略整行 ⇒ 沿用部署默认（`native`），工具目录照旧按原生 schema 摊开；
//   - 写成 `native` ⇒ 行在、包名对，但**这条 preset 就不是 PTC 版了**，而结构守卫一条都不响；
//   - 写成 `both` ⇒ 原生与 run_code 并存，省不省另说，但**通告面与可调用面不再一致**
//     （纯 ptc 下直呼别的工具会解析成 UNKNOWN_TOOL，both 下不会），子代理行为与本仓库的
//     文档口径直接对不上。
// 所以取值必须单独守：这是本 preset 的**身份**，不是可调旋钮。
const PRESENTATION_MODE = 'ptc'
const presentationRow = rowsOf('tool-presentation')[0]
if (presentationRow !== undefined) {
  const modePath = directPath(presentationRow, 'mode')
  if (modePath === undefined) {
    fail(`第 ${presentationRow.line} 行 ${presentationRow.id}：没有直接挂在 config: 下的 mode —— 该插件的 mode 是必填项（无默认值），缺了它整行挂载即抛错`)
  } else {
    const mode = presentationRow.paths.get(modePath)
    if (mode !== PRESENTATION_MODE) {
      fail(`第 ${presentationRow.line} 行 ${presentationRow.id}：mode 应为 ${PRESENTATION_MODE}，实际 ${mode ?? '（空）'}——本 preset 的身份就是 PTC 呈现，写成 native / both 都不是这个仓库要交付的东西`)
    }
  }
}

// 两个 ratio 的取值区间与先后次序（插件加载时就会抛，不只是"取错值"）。
const compactionRow = rowsOf('compaction-basic')[0]
if (compactionRow !== undefined) {
  const thresholdRatio = ratioOf(compactionRow, 'thresholdRatio')
  const retainRatio = ratioOf(compactionRow, 'retainRatio')
  if (thresholdRatio !== undefined && !(thresholdRatio > 0 && thresholdRatio <= 1)) {
    fail(`第 ${compactionRow.line} 行 ${compactionRow.id}：thresholdRatio ${thresholdRatio} 超出 (0,1]——插件加载时会抛 must be a number in (0, 1]`)
  }
  if (retainRatio !== undefined && !(retainRatio > 0 && retainRatio <= 1)) {
    fail(`第 ${compactionRow.line} 行 ${compactionRow.id}：retainRatio ${retainRatio} 超出 (0,1]——插件加载时会抛 must be a number in (0, 1]`)
  }
  if (thresholdRatio !== undefined && retainRatio !== undefined && retainRatio >= thresholdRatio) {
    fail(`第 ${compactionRow.line} 行 ${compactionRow.id}：retainRatio ${retainRatio} 必须小于 thresholdRatio ${thresholdRatio}（否则插件加载时抛 retainRatio must be less than the resolved thresholdRatio）`)
  }
  // `config.auto` 是**构建期注入**的键（AGENTS.md 红线 10）：挂了 billion-context 的 profile 由
  // `tools/gen-preset-bundle.mjs --with-billion-context` 往生成物里写 `auto: false`（与 bili 自己的
  // dsh.bundle.patch.yml 同键同值）。源文件必须保持中立 —— 没挂 bili 的 profile 里，dsh 自带的
  // 自动压缩是**唯一**的压缩手段，手写 false 等于让那些 profile 的上下文无限增长。
  // 它已在 spec.allowedKeys 里（是插件认识的键），所以"未知键"那条守卫拦不住它，这里单独拦。
  const autoWritten = directPath(compactionRow, 'auto')
  if (autoWritten !== undefined) {
    fail(`第 ${compactionRow.line} 行 ${compactionRow.id}：config.auto = ${compactionRow.paths.get('config > auto')} 是构建期注入的键——不要写进源文件（没挂 bili 的 profile 会因此失去唯一的自动压缩），用 node tools/gen-preset-bundle.mjs --with-billion-context 生成`)
  }
}

// pruner 的算式必须带上标记长度（只看 head + tail 会漏掉那 39 个字符）。
const prunerRow = rowsOf('tool-result-pruner')[0]
if (prunerRow !== undefined) {
  const thresholdChars = positiveIntegerOf(prunerRow, 'thresholdChars')
  const headChars = positiveIntegerOf(prunerRow, 'headChars')
  const tailChars = positiveIntegerOf(prunerRow, 'tailChars')
  if (thresholdChars !== undefined && headChars !== undefined && tailChars !== undefined) {
    const emitted = headChars + PRUNER_MARKER_CHARS + tailChars
    if (emitted > thresholdChars) {
      fail(`第 ${prunerRow.line} 行 ${prunerRow.id}：headChars + 标记(${PRUNER_MARKER_CHARS}) + tailChars = ${emitted} 超过 thresholdChars ${thresholdChars}——插件加载时会抛 headChars + marker + tailChars (...) must be at most thresholdChars`)
    }
  }
}

// ── 报告 ───────────────────────────────────────────────────────────────────
const webRow = rowsOf('tool-web')[0]
const shown = (row, key) => {
  const path = row === undefined ? undefined : directPath(row, key)
  const value = path === undefined ? undefined : row.paths.get(path)
  return value === undefined || value === null ? undefined : value
}
/** 出厂默认值按键名铺平，用于"没覆盖时报告生效值"。 */
const FACTORY_BY_KEY = Object.assign({}, ...Object.values(FACTORY_DEFAULTS))
/** 生效值 = 写了就用写的（标注"已覆盖"），没写就是插件出厂默认值（标注"默认"）。 */
const effective = (row, key) => {
  const overridden = shown(row, key)
  return overridden === undefined ? `${FACTORY_BY_KEY[key]}（默认）` : `${overridden}（已覆盖）`
}
console.log(`校验对象：${target}`)
console.log(`委派行 ${rows.length} 个：${rows.map((row) => `${row.toolName ?? row.id}[${row.hasAllow ? `allow=${row.allow.length}` : '无 toolFilter'}${row.hasPersona ? ' persona' : ''}]`).join('  ')}`)
console.log(`体积旋钮（生效值）：compaction ${effective(compactionRow, 'thresholdRatio')}/${effective(compactionRow, 'retainRatio')} | pruner ${effective(prunerRow, 'thresholdChars')}/${effective(prunerRow, 'headChars')}/${effective(prunerRow, 'tailChars')} | tool-web ${effective(webRow, 'fetchMaxOutputChars')}/${effective(webRow, 'searchMaxResults')}/${effective(webRow, 'searchMaxQueries')}`)
const effectivePruner = {
  head: Number(shown(prunerRow, 'headChars') ?? FACTORY_DEFAULTS.pruner.headChars),
  tail: Number(shown(prunerRow, 'tailChars') ?? FACTORY_DEFAULTS.pruner.tailChars),
  threshold: Number(shown(prunerRow, 'thresholdChars') ?? FACTORY_DEFAULTS.pruner.thresholdChars),
}
console.log(`裁剪后实际吐出（按生效配置算）：head ${effectivePruner.head} + 标记 ${PRUNER_MARKER_CHARS} + tail ${effectivePruner.tail} = ${effectivePruner.head + PRUNER_MARKER_CHARS + effectivePruner.tail}，threshold ${effectivePruner.threshold}`)
console.log('本 preset 不覆盖任何体积旋钮；上面标「已覆盖」的键都是后来加回去的，请确认是有意为之。')
for (const message of warnings) console.log(`WARN  ${message}`)
for (const message of errors) console.log(`ERROR ${message}`)
if (errors.length > 0) {
  console.log(`\n不通过：${errors.length} 个错误，${warnings.length} 个警告`)
  process.exit(1)
}
console.log(`\n通过：0 个错误，${warnings.length} 个警告`)

---
title: harness-identity 模块设计
owner: Adg preset 维护者
status: current
last_reviewed: 2026-11-15
---

# design.md — harness-identity（`adg-harness-identity` 去除系统提示词固定开场白插件）

设计与不变量。路由见 [AGENTS.md](AGENTS.md)，验证见 [testing-guide.md](testing-guide.md)。

## 1. 这个插件到底做什么（先说清边界，别夸大）

**做什么**：对每个 **`adg-ptc` preset 的 agent**（调度者与子代理都算），在**它自己的 scope** 上注册一个 **name 与平台固定开场白相同（`harness:identity`）、正文为空字符串**的系统提示词 section，从而把平台固定添加在最开头的那一行 `You are an AI agent, powered by DeepSeek Harness.` **从渲染结果里去掉**。

**不做什么**（三条边界，写下来是为了不让下一个读者误读）：

- **不是"替换开场白"。** 正文是空串，不是另一句话。渲染时这一整段被丢弃 —— 既不出现旧话，也不出现新话，也不留空行（见 3.3）。要给 Adg 会话加自定义开场白，请另开一个自有 section 名的模块。
- **不改任何工具、不加任何能力。** 本插件不注册工具、不改写工具入参/结果，它只影响系统提示词里的一段。
- **不碰非 `adg-ptc` 的会话。** 按 preset 身份逐 agent 判定（拿不到就覆盖，见 3.1）；别的 preset / 别的 profile 的 agent 一个字都不动。

## 2. 挂载点

`inject: ['systemPrompt']` + 全局层 `ctx.on('agent/created', handler)`，覆盖 section 注册挂到 `agent.ctx` 上。

- **为什么是 `agent/created`**：这是"这个 agent 刚存在、它的 scope 已定下来"的那一刻 —— preset 身份已可判定、section 还来得及在第一次组装之前注册。
- **为什么逐 agent 判定**：同一进程里不同 preset 的 agent 并存是常态，且系统提示词是**每个 agent 各自组装**的。所以"要不要覆盖"只能逐 agent 回答。
- **为什么挂在 agent 自己的 scope 上（而不是全局层）**：全局层已经有一条 `harness:identity`（平台 `SystemPrompt` 构造时注册的），同层重名会直接抛错；而且只有 scoped 层才能"按 agent 覆盖"。注册在 `agent.ctx` 上，agent 注销时随 scope 自动拆除，本插件只负责拆 `agent/created` 监听器。
- **为什么落全局层（无 scope）的插件行 + 逐 agent 的 section**：插件行挂全局层才能收到所有 agent 的 `agent/created`；而真正生效的覆盖 section 逐 agent 注册到各自 scope。反过来把覆盖写进 `preset/agent.cordis.yml` 不行 —— preset 侧不挂 `system-prompt` 服务（host 拥有），且 preset composition 的 scoped section 会经 composeFrom 一并落到子代理，给不出"按 scope 逐个判定"。

## 3. 核心数据模型

### 3.1 判定（`shouldInjectFor(header, composedPresetId)`，在 [lib/section.mjs](lib/section.mjs)）

```
const presetId = composedPresetId ?? header?.agentPreset;
return presetId === 'adg-ptc';
```

- **composedPresetId 优先**：来自 `ctx.get('agentPresets')?.composedPreset?.(agent.ctx)`（组合后的实际 preset 身份）；取不到时退回 `agent.session.header.agentPreset`。
- **fail-closed**：两者都拿不到（`undefined`）⇒ 返回 `false`，不覆盖。
- 与 `skill-inject/lib/section.mjs` 的 `shouldInjectFor` 同口径（同一 preset 身份判据，模块各自持一份，不互相 import）。

### 3.2 覆盖 section 的注入（`index.mjs` + `lib/section.mjs`）

| 字段 | 取值 | 说明 |
|---|---|---|
| `name` | `'harness:identity'` | **必须逐字等于平台全局那一段的名字**才能覆盖；每个 agent 的 scope 内唯一 |
| `order` | `-1000` | 与平台 `SECTION_ORDERS.HARNESS_IDENTITY === -1e3` 对齐；段最终被丢弃，order 只要求有限数 |
| `text` | `''`（空串常量） | 渲染时被 `filter(text => text.length > 0)` 丢弃 ⇒ 无输出、无空行 |
| 挂载层 | 每个 `adg-ptc` agent 自己的 `agent.ctx` | 由 `apply()` 在 `agent/created` 里逐 agent 注册 |

常量集中在 `lib/section.mjs`：`SECTION_NAME='harness:identity'` / `SECTION_ORDER=-1000` / `TARGET_PRESET='adg-ptc'` / `SHADOW_TEXT=''`。`shadowSection()` 每次返回一份新的 `{name, order, text}`。

### 3.3 为什么"注册一个同名空文本 section"等于"删除那一行"（平台机制，升级 dsh 后重核第 5 节）

三步，缺一不可：

1. **平台把固定开场白放进 global 层。** `SystemPrompt` 构造时（默认 `includeHarnessIdentity` 为 true）调用 `this.section({ name:'harness:identity', order: HARNESS_IDENTITY(-1000), text:'You are an AI agent, powered by DeepSeek Harness.' })` —— 此时 `this.ctx` 是 host 的全局 ctx，落进 global 层。
2. **scoped 同名项覆盖 global 同名项。** 我们在某 agent 的 ctx 上调用 `agentCtx.systemPrompt.section({name:'harness:identity', text:''})` —— 由于 cordis 服务代理把 `this.ctx` 绑定到访问者（agent）的 scope，注册落进**该 agent 的 scoped 层**；组装时 `sectionByName = layers.merge(scope, …sections)` 先装 global、再按 scope 链覆盖，**同名以最近 scope 为准**，于是全局那条被这条空文本顶掉。
3. **空文本段在渲染时被丢弃，不留空行。** `renderPrompt`：`sections.map(取文本).filter(text => text.length > 0).join('\n\n')` —— 空串被 filter 滤掉，既不产出文本也不产出分隔空行。

**这正好是平台自己推荐的做法**：平台在全局层重名时抛出的报错文案就写着 —— `prompt section "harness:identity" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`。本模块走的就是它点名的"per-agent override via agent.ctx"这条官方路径（见第 5 节）。

**两个边界情形（都不出错）**：

- 若目标 profile 本就把 `includeHarnessIdentity` 设为 `false`（如 `dsh-sdk-minimal`），global 层没有 `harness:identity`；我们这条 scoped 空文本就成了一条"孤立空段"，同样被 `renderPrompt` 丢弃 —— 无副作用。
- 若平台将来不再注册 `harness:identity`：同理，空段被丢弃，无副作用（但也就不再"删除"任何东西，因为本就没了）。

## 4. 不变量

| # | 不变量 | 载体 |
|---|---|---|
| I1 | 覆盖 section 的 `name` 逐字为 `harness:identity`（等于平台全局那段的名字） | S2 / C5 |
| I2 | 覆盖 section 的 `text` 是空串；本插件不往这个 section 写任何非空文本 | S1 / S4 |
| I3 | `name` / `order` / `TARGET_PRESET` 三个常量只在 `lib/section.mjs` 一处 | C5 + [评] 读 `index.mjs` |
| I4 | 判定只对 `adg-ptc`，且 fail-closed（拿不到身份不覆盖） | G1–G5 |
| I5 | 覆盖 section 注册在 **agent 自己的 scope**（`agent.ctx`），绝不在全局层注册同名 | W1 / W3 + [评] 读 `index.mjs` |
| I6 | 非 `adg-ptc` 的 agent 一个 section 都不注册 | G2 / W2 / W4 |
| I7 | 监听器体整个 try/catch 包住：判据或注册失败不外抛，单个 agent 的失败不拖垮其它 agent | W5 / W6 / W7 |
| I8 | 本插件不注册任何工具，只有一个 `agent/created` 监听器 | C2 + [评] 读 `inject` / `apply` |
| I9 | 零第三方依赖；Node `>= 22`；不 import 任何 `@deepseek-ai/*` | C4；`package.json` 无 `dependencies` |
| I10 | 运行中的旧 agent 不补挂 —— section 只在 agent 创建那一刻注册一次 | [AGENTS.md](AGENTS.md) 的「生效方式」 |
| I11 | 插件名 / 行 id / 包名三者一致（`adg-harness-identity`） | C1 / C3 |

## 5. 平台契约速查（升级 dsh 后重核这几条）

来自 `@deepseek-ai/dsh-system-prompt` 与 `@deepseek-ai/dsh-scope`（本机解析见根 `AGENTS.md` 的「外部依赖与 ref 解析」）：

- **固定开场白的注册**：`SystemPrompt` 构造函数 当 `config.includeHarnessIdentity ?? true` 为真时 `this.section({ name:'harness:identity', order:getSectionOrder('HARNESS_IDENTITY')(=-1000), text:'You are an AI agent, powered by DeepSeek Harness.' })`。
- **section() 落进调用方 scope**：`section(section)` 只校验 `Number.isFinite(section.order)`，然后 `this.layers.effect(this.ctx, …)`。cordis 服务代理使 `this.ctx` 绑定到访问者 ctx（即 `agent.ctx`）的 scope ⇒ 落进该 agent 的 scoped 层。
- **scoped 覆盖 global**：`section()` 的文档 "A scoped section shadows a global section with the same name; duplicates within one layer … throw"。
- **重名报错文案点名了正确做法**：`PromptLayer` 的 `NamedEntries` 重复错误 写着 —— `prompt section "<name>" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`。
- **merge 顺序（最近 scope 赢）**：`@deepseek-ai/dsh-scope` 的 `ScopedLayers.merge(scope, pick)` `new Map(global.entries())` 后按 `chainLayers(scope)`（`scopeChainOf(scope).reverse()`：最远祖先先、exact scope 最后）逐层 `merged.set`，故同名以最近 scope 为准。
- **effect 按 ctx 的 scope 落层**：`ScopedLayers.effect(ctx, …)` `const scope = scopeOf(ctx)`：无 scope → global 层；有 scope → 该 scope 的 scoped 层（无则建、注销时空则回收）。
- **空文本被丢弃**：`renderPrompt` `sections.map(s=>s.interpolate===false?s.text:interpolate(s.text)).filter(text=>text.length>0).join('\n\n')`。
- **assemble 用 merge 取 section**：`assemble(context)` `const sectionByName = this.layers.merge(scope, layer=>layer.sections)`，再 `sort(comparePromptSections)` 渲染。
- `ctx.systemPrompt.section({name, order, text})` —— `text` 是 `string | ((context) => string)`；本模块用空串常量。

## 6. 未观测项

- **未观测**：`agent/created` 触发时该 agent 的 scope 是否已经能挂 section 并在首次组装前生效（契约上 setup 完成先于 `agent/created`，与 `ptc-parallel` 同形但未在本仓库实测）；量法：装好重启后在新 Adg 会话里读系统提示词，确认开头没有 `You are an AI agent, powered by DeepSeek Harness.` 一行。
- **未观测**：子代理的系统提示词里那一行是否同样消失（子代理由 `delegate` 现建 scope，覆盖按 preset 身份逐 agent 判定）；量法：新 Adg 会话里派一个子代理，看它自己的系统提示词开头。
- **未观测**：平台是否会在同一 agent 上重复触发 `agent/created`（若重复触发，第二次 `section()` 会因同 scope 重名抛错，但被 try/catch 吞掉、第一次注册仍生效）；量法：查 dsh 日志里同一 agent 的 `agent/created` 次数，并确认开头那行仍然消失。
- **未观测**：dsh 升级后 `harness:identity` 段的名字 / 是否仍由 global 层注册 / 是否仍按 `text.length>0` 过滤空段；量法：升级后跑本模块单测（C5 钉住名字与 order），并在真会话里确认开头那行仍消失。
---
title: sandbox-notice 模块设计
owner: Adg preset 维护者
status: current
last_reviewed: 2026-11-16
---

# design.md — sandbox-notice（`adg-sandbox-notice` 去除 run_code 沙箱提示噪声插件）

设计与不变量。路由见 [AGENTS.md](AGENTS.md)，验证见 [testing-guide.md](testing-guide.md)。

## 1. 这个插件到底做什么（先说清边界，别夸大）

**做什么**：在 **`tools/post-execute`** 这个工具结果后处理瀑布上，对 **`run_code`** 工具的 **accept** 结果，从它的 `text` 内容块里剥掉**末尾那一行** `File sandbox enforcement is partial on this host.` —— 那句话是 PTC 工具渲染层在 `sandbox.enforcement === 'partial'` 时**无条件追加**的状态声明，不是本次执行的结果本身。

**不做什么**（三条边界）：

- **不是“改工具结果的内容”。** 只删这一行噪声；程序的真实输出、日志、图片、错误一个字节都不动。若结果里还有 `The … file sandbox denied an operation.` 的**拒绝**说明，那是对用户有用的信息，**原样保留**。
- **不碰 `run_code` 以外的工具。** 其它工具的结果一个字段都不碰。
- **不是在“说谎”或掩盖沙箱。** 它只去掉这句每次都会重复、对执行无信息量的状态尾巴；沙箱**是否真的拒绝了某个操作**由另一句 denied 文案表达，本插件不动它（见第一条）。

## 2. 挂载点

`inject: ['tools']` + 全局层（无 scope）`ctx.on('tools/post-execute', handler, { prepend: true })`。

- **为什么是 `tools/post-execute`**：这是工具已产出 `ToolExecutionResult`、即将交给模型之前的最后一个可改写点；`dsh-tools` 暴露的 waterfall 事件，监听器能拿到下游最终决定、也能替换模型可见内容。
- **为什么 `prepend: true`**：瀑布里前置监听器先执行、但它 `await next()` 拿到的是**下游全部处理完**的决定（含 PTC 已渲染出的文本），改在最后，别的后处理器不会再把那句拼回来。
- **为什么不改 `node_modules`**：那句由 `@deepseek-ai/dsh-tool-executor-ptc` 的 `render()` 硬拼、没有开关；本机 Windows 走 windows-acl 档、其 enforcement 静态为 `partial`（见根 `AGENTS.md` 的「外部依赖与 ref 解析」与 `dsh-sandbox-local` 契约）。在后处理层剥是唯一不动上游、可随仓库维护的办法。
- **为什么落全局层**：`run_code` 在任何会话都可能被调用，这层噪声与 preset 无关；不需要逐 agent 判定。

## 3. 核心数据模型

### 3.1 两个纯函数（在 [lib/strip.mjs](lib/strip.mjs)）

- `stripNoticeLine(text)`：把**末尾**那一行 `NOTICE` 连同其前一个换行去掉，返回新串；不满足“末尾整行”就原样返回。边界：整段只有 `NOTICE` ⇒ 返回空串；`NOTICE` 出现在中间、或被其它字符跟在后面 ⇒ 不动；`NOTICE` 前不是行首 / 换行（内联出现）⇒ 不动。
- `stripSandboxNotice(content)`：对 `ContentBlock[]` 逐块处理 —— 只对 `type === 'text'` 的块调 `stripNoticeLine`；**有任何一块变化**才返回新数组，否则**原样返回入参数组**（供上层用 `===` 判断是否需要替换）。剥完丢掉变空的 `text` 块；若最后**一个非空内容都不剩**，回退成 `[{ type:'text', text: EMPTY_OUTPUT }]`（`(run_code completed with no output)`，与 PTC 渲染层的空输出占位一致）。

### 3.2 处理流程（`index.mjs` 的 handler）

1. `const decision = await next();` 取下游最终决定。
2. 放行判定：`decision` 为空 → 原样返回；`kind !== 'accept'` 或带 `value`（值型 accept，不经文本渲染）→ 原样返回；`exec.name !== 'run_code'` → 原样返回。
3. `content = decision.content ?? result?.content`；`stripped = stripSandboxNotice(content)`。
4. `stripped === content`（没有变化）→ 返回原 `decision`；否则返回 `{ ...decision, content: stripped }`。
5. 整段 `try/catch`：任何异常都返回原 `decision`。

## 4. 不变量

| # | 不变量 | 载体 |
|---|---|---|
| I1 | 只处理 `exec.name === 'run_code'` 的 `accept` 结果；其它工具与其它决策类型零改动 | W2 / W3 / W4 |
| I2 | 只剥末尾整行 `NOTICE`；中间出现、内联出现、以及 denied 拒绝句都不动 | N3 / N4 / N7 |
| I3 | 剥完无任何非空内容 ⇒ 回退为单块 `EMPTY_OUTPUT` 文本 | A2 / W6 |
| I4 | 图片块与其它非文本块原样保留；含图片时不误删、不误回退 | A3 |
| I5 | 无变化时返回**原对象**（`===`），不制造无意义的替换 | A4 / W2 / W5 |
| I6 | handler 整体 try/catch，异常不外抛、退回原 `decision`（fail-open 到原结果） | W7 |
| I7 | 以 `{ prepend: true }` 注册，先 `await next()` 再改写 | W0 |
| I8 | 不注册任何工具，只挂一个 `tools/post-execute` 监听器 | W0 + [评] 读 `inject` / `apply` |
| I9 | `NOTICE` 与 `EMPTY_OUTPUT` 两个常量只在 [lib/strip.mjs](lib/strip.mjs) 一处 | C5 |
| I10 | 零第三方依赖；Node `>= 22`；不 import 任何 `@deepseek-ai/*` | C4；`package.json` 无 `dependencies` |
| I11 | 插件名 / 行 id / 包名三者一致（`adg-sandbox-notice`） | C1 / C3 |
| I12 | 幂等：对已剥除的结果再跑，内容不变 | A1 / A4（同输入重复调用稳定） |

## 5. 平台契约速查（升级 dsh 后重核这几条）

来自 `@deepseek-ai/dsh-tool-executor-ptc`、`@deepseek-ai/dsh-tools`（本机解析见根 `AGENTS.md` 的「外部依赖与 ref 解析」；引用只写契约符号，不写实现行）：

- **噪声的来源**：`dsh-tool-executor-ptc` 的 `render(_args, value)` 先由 `value.logs` 与渲染后的 `value.result` 拼出 `parts`，再在 `value.sandbox?.enforcement === 'partial'` 时 `parts.push('File sandbox enforcement is partial on this host.')`，最后 `parts.join` 成唯一 `text` 块返回；空结果用占位 `(run_code completed with no output)`。⇒ 那句总在文本块末尾。
- **enforcement 为何恒为 partial**：`dsh-sandbox-local` 把 `windows-acl` 档的静态 enforcement 记为 `partial`（其它平台档位不同）。本插件不关心档位，只按文本末尾那行判定。
- **后处理瀑布签名**：`tools/post-execute(this: Scoped<ToolsService>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>`。
- **PostToolDecision**：`{ kind:'accept'; content?: ContentBlock[] }` | `{ kind:'accept'; value: JsonValue }` | `{ kind:'block'; feedback: ContentBlock[] }`。本插件只改 accept-带 content 的那支。
- **exec 字段**：有 `.name` / `.callId` / `.agent` / `.parent`；本插件只用 `.name`。
- **内容块形态**：`{ type:'text', text }` 与 `{ type:'image', … }` 等；`text` 是唯一可剥的目标。

## 6. 未观测项

- **未观测**：真实会话里 `run_code` 成功结果确实只有单个 `text` 块、且那句恒在末尾（契约如此，但本仓库未逐例实测）；量法：装好重启后跑一次正常 `run_code`，看输出末尾不再有那句、正文其它字符数量不变。
- **未观测**：`denied` 情形（结果里既有拒绝句、又可能带那句状态声明）剥后是否只少该删的那句、拒绝句仍在；量法：造一次被沙箱拒绝的写操作，读结果。
- **未观测**：其它后处理器（如 `dsh-spill-policy`）与本插件在同一 `tools/post-execute` 上的相对顺序是否改变可见结果；量法：同时装两者，跑一次长输出 `run_code`，确认既截断又无该噪声行。
- **未观测**：dsh 升级后 `render()` 是否仍拼这句、`enforcement` 是否仍可能为 `partial`；量法：升级后跑本模块单测（C5 钉 `NOTICE` 字面量）+ 一次真 `run_code`。

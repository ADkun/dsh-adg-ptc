# design.md — source-guard（`adg-source-guard` 源码守卫插件）

设计与不变量。路由见 [AGENTS.md](AGENTS.md)，验证见 [testing-guide.md](testing-guide.md)。

## 1. 这个插件到底改什么（先说清边界，别夸大）

PTC 模式下模型经 `run_code` 干活，源码全文进上下文有**两条**路，平台契约如下：

| 入口 | 写入点 | 平台有没有改写点 | 本插件管不管 |
|---|---|---|---|
| `tool/call` 事件的 `arguments`（assistant 消息里的 tool_use 入参，含 `code` 全文） | `dsh-agent-loop` 的 `appendToolCall`：`session.append("tool/call", {turn, step, callId, name, arguments: block.arguments})` | **没有**。`session/event` 是 post-commit 的 fire-and-forget emit；`sessions.registerMessageProjection` 只对已声明投影的事件类型生效（现役仅 `image/offload`）；`agent/request` 的描述明写 "Model-visible content must use logged channels; this waterfall cannot mutate messages." | **管不了** |
| `tool/result` 的 `message.content` | `appendToolResult` → `createToolResultMessage({callId, content: result.content, isError})` | **有**：`tools/post-execute`（waterfall）返回的 accept 决策可带 `content`，`dsh-tools` 的 `postExecute` 用 `{...result, content: decision.content}` 落定 | **这就是本插件的管辖面** |

平台默认行为再补两层事实，它们决定了本插件的实际收益边界：

1. **run_code 成功路径的 `content` 本来就不含源码** —— `render` 只拼 `logs.join("\n")` + `renderValue(result)` + sandbox 文案（`dsh-tools/lib/index.js` 的 run_code `render`）。源码全文走的是 `tool/call` 的 `arguments` 与 `presentCall.rawInput`（UI 卡片）。
2. **run_code 失败路径的 `content` 也不含源码** —— 失败是 `throw new CodeRunFailedError(...)`，正文是 `code run failed (${kind}): ${message}` + `Captured output:` + 日志，被执行管线归一成 `isError: true` 的结果。

所以本插件做的是：**在结果侧再确认一次"成功时不把源码从结果里带回来"**，并把平台不会渲染的当次执行意图补在最前面；失败路径**原样保留**，一个字都不加、一个字节都不删。

**前缀句默认关闭**（`SUCCESS_PREFIX = ''`）：源码未随结果重复本来就是平台默认行为，每次成功都解释一遍只是噪音。默认只补「已执行代码：<description>」一行 —— 这才是平台不渲染、模型回读时真正需要的信息。想改回显式宣告就把 `lib/policy.mjs` 的 `SUCCESS_PREFIX` 设成非空串（失败路径不受影响，D18 钉住默认值为空串）。

**不许对外说成「源码完全不进上下文」**：`tool/call` 的 `arguments` 那份源码，平台目前没有挂载点能改（见 I7 的未观测项）。

## 2. 挂载点

`inject: ['tools']` + 全局层 `ctx.on('tools/post-execute', handler, { prepend: true })`。

- **为什么是 post-execute**：它是唯一能替换**模型可见**结果正文的 waterfall（`tools/result` 是 emit 冻结结果；`tools/pre-execute` 只做准入；`session/event` 改不了已提交事件）。
- **为什么 prepend**：与 `dsh-spill-policy` 同一范式 —— prepend 的监听器先 `await next()` 拿到下游（含平台自身与其它策略）已归一化的决策，再决定改不改。后置改写会与 spill 策略的"存全文 + 预览"互相覆盖。
- **为什么全局层（无 scope）**：本插件管辖的是"每一次 run_code 执行"，不区分是调度者还是子代理。全局层注册 + `governs()` 按 `exec.name` / `exec.parent` 判据，与 spill-policy 的全局层注册同形状。

## 3. 核心数据模型

两个纯函数，都在 [lib/policy.mjs](lib/policy.mjs)：

### 3.1 `governs(exec)` —— 管辖判据

```
exec.name === 'run_code' && (exec.parent === undefined || exec.parent === null)
```

- `exec.name` 来自平台 `ToolExecution`（`dsh-tool-cordis` 的 api-catalog 里 `ToolExecutionInput.name: string`）。
- `exec.parent` 非空 = 这是 run_code 程序**内部**发起的子分发（平台子分发绑定 `parent: exec.token`）。run_code 本身在程序里不可达（`functions` 由 `registry.schemas()` 构建并 `if (schema.name === 'run_code') continue`），所以这道判定今天是防御性的；将来平台若放开，本插件也不去改程序内部的结果。

### 3.2 `applyPolicy({exec, result, decision})` —— 决策改写

按顺序四条硬规则，命中任一条即**原样返回 decision**：

| # | 条件 | 理由 |
|---|---|---|
| 1 | `decision` 不是对象 | 不是本插件能理解的决策形态 |
| 2 | `!governs(exec)` | 别的工具 / 程序内子分发不碰 |
| 3 | `decision.kind !== 'accept'` | `block`（feedback）与其它决策形态不属本插件管辖 |
| 4 | `Object.hasOwn(decision, 'value')` | 平台 `postExecute` 对"同一次 accept 既给 value 又给 content"直接抛 `tools/post-execute accept decision cannot replace both value and content` |
| 5 | `result.isError === true` | **失败路径原样保留**（本插件存在的另一半理由） |

其余（顶层 run_code 成功）返回：

```
{ ...decision, kind: 'accept', content: [ 意图块?, ...base ] }
```

- `base` = `decision.content`（数组时）否则 `result.content`（数组时）否则 `[]`。默认 `next()` 不产 content，所以要保留的输出在 `result.content`。
- 意图块 = `{type:'text', text: SUCCESS_PREFIX (+ '\n已执行代码：' + intent)}`，`intent` 取自 `exec.arguments.description`（平台必填项，trim 后可为空）。`SUCCESS_PREFIX` 默认为空串 ⇒ 默认只出「已执行代码：」一行；意图也缺失时不出块，结果正文与平台默认逐字相同。
- 意图块的文本**在有正文时以 `\n` 结尾** —— 换行进字符串，不靠块边界（下游会把多个 text 块用空串拼起来，块边界到不了模型；见第 5 节的三条出处）。
- `...decision` 保证 `additionalContexts` / `meta` 等字段透传，不被抹掉。

## 4. 不变量

| # | 不变量 | 载体 |
|---|---|---|
| I1 | 失败路径**零改动**：`result.isError === true` 时返回的决策与入参逐字段相同（含 `content` 数组逐块相等） | `test/policy.test.mjs` 的 D10 / D11 |
| I2 | 只碰顶层 run_code：其它工具与 `parent` 非空的子分发一律原样返回 | D2 / D3 / D14 + `test/plugin.test.mjs` 的 W5 |
| I3 | 不替换 value：带 `value` 的 accept 原样返回（绕开平台抛错） | D13 |
| I4 | 不覆盖上游正文：说明块只**前置**，原有 block 逐块保持引用与顺序 | D6 / D17 |
| I5 | 不写盘、不起进程、不解析 jobs、不注册工具 | [评] 读 `index.mjs` / `lib/policy.mjs` 的 import 行（只有 `./lib/policy.mjs`） |
| I6 | 单次改写失败不外抛：catch 后落一条 `ctx.logger?.warn` 并返回 `next()` 的决策 —— 失败路径的"原样"本来就是本插件的默认立场，异常路径收敛到同一立场 | `test/plugin.test.mjs` 的 W7 |
| I7 | 只依赖 `tools/post-execute` 一个事件，且 `prepend: true` | W2 |
| I8 | 零第三方依赖；Node `>= 22`；只用语言内建能力 | `package.json` 无 `dependencies`；[评] 读 import 行 |
| I9 | 意图块自带换行：下游把多个 text 块用空串拼接时，意图与正文之间仍有换行可分辨 | D21 / D22 / W3d |

## 5. 平台契约速查（升级 dsh 后重核这几条）

全部来自 `@deepseek-ai/dsh@0.2.1-rc.2`（本机解析见根 `AGENTS.md` 的「外部依赖与 ref 解析」）：

- `tools/post-execute`（waterfall）：`(this: Scoped<ToolRuntime>, exec, result, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>`。
- `PostToolDecision`：`{kind:'accept', content?: ContentBlock[], value?: never, additionalContexts?}` | `{kind:'accept', value: JsonValue, content?: never}` | `{kind:'block', feedback: ContentBlock[]}`。
- `ToolExecutionResult`：成功 `{isError:false, value, content}` / 失败 `{isError:true, error:{message, info?}, content}`。
- `ToolExecutionInput.arguments: unknown` —— 本插件的意图来源；`parent?: ToolExecutionToken` —— 子分发判据。
- run_code 失败：`throw new CodeRunFailedError('code run failed (${kind}): ${message}' + logs + sandbox + escalation)`，归一后 `isError: true`。
- `tools.restrict()` 两侧都拒绝 `run_code` 这个名字（保留名）⇒ 本插件**不注册任何工具**，与 delegate 的 R4 不冲突。

**下游怎么读结果正文**（决定了意图块必须自带换行 —— 升级 dsh 后重核这三处）：

- `dsh-plugin-save-token` 的 `src/index.js` 的 `flattenPlainText(content)` —— 逐块 `text += b.text`，**空串拼接、块边界被吃掉**。
- `dsh-llm-pi-ai` 的 `lib/index.js` 的 `flattenText(message)`（工具结果经 `toolResultOf(message, toolNames, flattenText(message))` 落到模型可见正文）—— `filter(text).map(text).join("")`，**空串拼接、块边界被吃掉**。
- `dsh-llm-deepseek` 的 `lib/index.js` 的 `assistant(message, model, onReplayDegrade)`（text 分支）与 tool 角色分支 —— **保留块边界**。

⇒ 走 pi-ai 路径时模型看到的是一整段拼好的字符串，块边界根本到不了模型 —— 所以「意图」要跟正文分开，靠的不能是 text 块边界，必须是**自己的换行符**。

## 6. 未观测项

- **已观测（2026-10-24，重启 dsh 后的 Adg PTC 会话，顶层 run_code）**：`exec.arguments.description` 取到的是**当次调用的 description 原值** —— 成功调用（description「探测运行期成功前缀文案」）的结果正文第一行是「已执行代码：探测运行期成功前缀文案」，与传参逐字一致。**仍未观测**：`exec.arguments` 是否就是模型原始 arguments 那个**对象本身**（值形态已证，引用同一性未测）；量法：临时在插件里比对 `exec.arguments` 与上游 payload 的引用（或看它是否被冻结），跑一次 run_code 打印结果。
- **已观测（2026-10-24，本机 Adg PTC 会话派出的子代理 2b52f1f2 在它自己会话里自测）**：全局层监听**确实覆盖子代理会话**的 run_code —— 子代理的成功调用（description「子代理侧成功探针」）结果正文第一行是「已执行代码：子代理侧成功探针」、第二行 `child-ok`；失败调用（`throw new Error("child-probe-failure")`）正文首行直接是 `Error: code run failed (exception): Error: child-probe-failure`、末行 `File sandbox: danger-full-access.`，**没有任何前缀**。⇒ 成功补标签、失败零改动，在子代理侧与顶层同形。
- **未观测**：平台后续版本是否会给 assistant tool_use 的 `arguments` 提供改写点（那才是"源码完全不进上下文"的真正入口）；量法：升级 dsh 后重读 `dsh-tool-cordis` 的事件目录与 `dsh-agent-loop` 的 `appendToolCall`，看有没有新增投影或事件。
- **未观测**：与 `dsh-spill-policy` 同时安装时的最终正文顺序（谁前置在谁后面）；量法：两插件都装，跑一次输出超过 spill 预算的 run_code，看说明块落在 spill 预览之前还是之后。

---
title: permission 模块设计
owner: Adg preset 维护者
status: current
last_reviewed: 2026-10-05
---

## 职责与边界

负责：把「父代理事后纠正一个**已经派出去**的子代理的文件权限」收敛成一个**已注册的工具 `set_child_permission`**、两条**代码级守卫**（血缘、单调）、两条**写入路径**（子代理在跑 / 已停下），以及"把这个包部署进每个 profile 并选中它"的三件套（稳定副本、`file:` 依赖、`dsh.profile.bundles` 条目）。

不负责（逐条防越权）：

- 不拥有"什么时候该改权限"这个判断：是否值得改、改到哪一级、还是干脆停掉重派，**由调度者按现场决定**（触发面写在 `set_child_permission` 的 description 与调度 persona 的【浏览器：权限】段）；本模块只负责"改得动、且改不越界"。
- 不拥有权限语义本身：三档模式的含义、会话模式怎么折叠、每次受限调用怎么解析，都是 `@deepseek-ai/dsh-sandbox-policy` 的；本模块只往子代理自己的会话日志里追加一条 `sandbox/mode`。
- 不拥有 approval：**一律不碰**（I8）。子代理的 approval 由委派那一层钉成 `never`，而它没有人类答主。
- 不拥有"把权限抬到父代理之上"：这是本模块**明确拒绝**的能力（I2）—— 它是修正路径，不是提权通道。
- 不拥有血缘登记：谁是自己的后代由 `ctx.subagents.listDescendants(caller.id)` 说，本模块不自己维护关系表（I3）。
- 不拥有 preset 与工具目录：`set_child_permission` 只归调度智能体（`delegate` 的 `BUILTIN_DENY` 钉住它、`tools/check-preset.mjs` 把它收在 `SCHEDULER_ONLY`），不进任何一次委派的工具面；本模块只保证"这个名字在全局层被注册"。
- 不拥有 dsh 的插件装载：给的是 `dsh.bundle.patch` + patch 行 + 一个能被解析的包；"profile 有没有选中它""loader 有没有 import 它"是 dsh 的事 —— 本模块只能在安装脚本里**读回来断言**到"装了且被选中"这一层（I11 / I12）。
- 不复活已停下的子代理：写它的日志**不等于**唤回它（I9）。本模块不投递消息、不起一轮对话。
- 不拥有跨平台差异：日志与事件契约是 dsh 的，本模块不含平台分支。

## 依赖关系

- 依赖：Node 内建（无第三方包）。
- 依赖（可选 peer）：`@deepseek-ai/dsh-tools`（`peerDependenciesMeta.optional`），只用来取 `defineTool`。运行期由 dsh 自己的解析拦截层供给（与 `notify/design.md` 的 I12 同一条事实）；仓库根的 `node_modules/@deepseek-ai` Junction 只为让本模块自测能在开发机上跑起来。
- 依赖（运行期服务，经 `ctx.get()` 取，见 I14）：`sessions`（`@deepseek-ai/dsh-session`，**必需**，用于 live 路径）、`subagents`（`@deepseek-ai/dsh-subagent`，**必需**，用于血缘）、`sandboxPolicy`（`@deepseek-ai/dsh-sandbox-policy`，单调守卫要读调用方模式）、`sessionPersistence`（`@deepseek-ai/dsh-session-persistence`，persisted 路径需要）。缺哪个就抛一条点名它的可读错误，不做静默降级。
- 被依赖：
  - `install.ps1` / `install.sh` 的第 2b 步（拷到 `${DSH_HOME:-~/.dsh}/plugins/adg-permission/`）与第 4c / 4c-1 步（逐 profile `dsh plugin add file:<稳定副本>` + 读回断言三格）。
  - `preset/agent.cordis.yml` 调度 persona 的【浏览器：权限】段（**唯一消费方**，见「消费方契约测试」）。
  - `tools/check-preset.mjs`：名字收进 `KNOWN_TOOLS`，并进 `SCHEDULER_ONLY`（只给调度智能体）。
- 跨模块改动路由：改工具名 / 参数 → 先读 `preset/agent.cordis.yml` 的【浏览器：权限】段与 `tools/check-preset.mjs` 的 `KNOWN_TOOLS` / `SCHEDULER_ONLY`；改写入路径 → 先读 I5 / I6 / I7 与 dsh 侧持久化契约；改装载形状 → 先读 `install.*` 的第 2b / 4c 步与 I11 / I12。

## 核心数据模型

两个对象是**不可变值对象**（创建后内容冻结，修改＝新对象，无状态机）：PermissionChange（返回值）、SandboxMode（三档偏序）。另有两条作者侧契约（工具定义）与一组装配契约（装载与可见性），同样以不变量表达、没有状态机。

### SandboxMode（不可变值对象 + 偏序）

三档字面量 `read-only` / `workspace-write` / `danger-full-access`，按**从窄到宽**排序（`SANDBOX_MODES` 的数组序即等级，`modeRank()` 返回下标）。

- **I1** 模式字面量是**封闭集合**：不在这三档里的值一律抛错，**不许**当成"最窄"或"未知即放行"。`modeRank()` 对未知值返回 `undefined`（而不是 -1 / 0），好让"读不出来"和"最窄"在代码里不可能混淆。理由：单调守卫的判据是"目标 ≤ 调用方"，判据缺失时任何默认值都等于悄悄改变语义。载体：D2 用例（`未知模式不当"最窄"，真值和幻影值一律 undefined`）。
- **I2** **单调守卫 fail-closed**：`assertNotWidening(callerMode, targetMode)` 在三个条件下拒绝 —— 读不出调用方模式（`undefined` / 非字面量）、目标模式未知、`targetRank > callerRank`；只有 `targetRank <= callerRank` 才返回目标等级。理由：这是"修改后权限不得大于调用方"这条要求的唯一强制点；提示级约束在本仓库已被证过不可靠。载体：D2 用例。
- **I3** **血缘守卫**：目标 id 必须出现在 `ctx.subagents.listDescendants(caller.id, signal)` 的结果里，且该行不是 `kind === 'diagnostic'`。找不到就让错误消息带上"id 从 `list_agents` 取"。理由：没有血缘判据，任何拿到工具的会话都能去改别人派出去的代理 —— 那是跨会话提权。载体：D6 用例（两条：非自己的后代一律拒；**只认调用方自己的子树**，即查询必须用调用方 id）。

### PermissionChange（返回值，不可变值对象）

`{ agent_id, mode, applied, note }`，其中 `applied` 只有两个字面量：`live`（子代理在跑，下一步受限调用即按新模式解析）与 `persisted`（子代理已停下，模式写进它的日志，**下次唤回它时**才生效）。

- **I4** 事件信封恒为 `{ type:'sandbox/mode', seq, time, data:{ mode } }`：`data` **只有 `mode`，禁止 `source`**。理由：v0→v1 迁移对 `source` 只接受字面量 `delegation`，写别的会让旧格式日志过不了迁移；省略即与 `dsh-sandbox-policy` 的 `setSandboxMode()` 同形。载体：D3 用例（两条：信封形状 + 故意不带 source；只接受已知模式与合法 seq）。
- **I5** **live 路径**：`ctx.sessions.get(targetId)` 拿到会话对象 ⇒ `session.append('sandbox/mode', { mode })` 后 `await ctx.sessions.flush(session)`，返回 `applied: 'live'`。理由：会话模式是每次受限调用按该会话日志重新解析的（`sandboxPolicy.resolve({session})` → `overrideOf(session)`），所以**不需要重派、不需要重启**。载体：D4 用例（追加并 flush、返回 live；不动 approval；live 路径同样过单调守卫）。
- **I6** **persisted 路径**：`ctx.sessions.get(targetId)` 是 `undefined` ⇒ `sessionPersistence.open(id, 'write', options)` → `handle.read(0, void 0, options)` → `handle.append([sandboxModeEvent(mode, stored.events.length, Date.now())])` → `handle.flush(options)`，返回 `applied: 'persisted'`。**seq 必须等于现有事件条数**（持久化层按 `cursor + index` 逐条断言连续）。理由：已停下的会话不在内存 store 里，`session.append` / `sessions.flush` 对它无效（会抛 `is not live`）。载体：D5 用例（`seq 接在现有事件之后，返回 persisted`）。
- **I7** 写句柄**一定**在 `finally` 里关闭，且 `close()` 自身的失败**只吞掉、不掩主错**。理由：`open(..., 'write')` 会 `claimWrite` 一个跨进程写租约；泄漏租约会让这个子代理以后谁都写不动，而"关句柄失败"不该把"写日志失败"的原因盖掉。载体：D5 用例（写失败也关句柄；close 自己失败不掩盖主错误）。
- **I8** **只改 `sandbox/mode`**：不写 `approval/policy`，不调 `permissionPresets.set()` / `apply()`。理由：子代理 approval 恒为 `never`，且没有人类答主；改成 `ask` 会让每次受限操作挂起或被自动拒。附带效应要如实知道：`danger-full-access` + `never` 恰好派生成 `danger-full-access` preset，而降级成 `workspace-write` 而 approval 仍 `never` 时 `permissionPresets.current()` 会派生成 `custom` —— 这是**诚实的观感**，不是缺陷。载体：D4 用例。
- **I9** **写日志 ≠ 复活**：persisted 路径不投递任何内容、不调用 `agents.resume` / `SubagentRuntime.coldResume`、不产生模型回合。理由：冷恢复的正规入口会真的投递一条消息（`submitAdmitted`），拿它改权限会意外烧掉一个回合。载体：D5 用例（假件里没有 resume 面，能跑通本身即证据）+ [评] 读控制流。
- **I10** 已停下且 `mode !== 'continuable'` 的子代理**拒改**。理由：一次性子代理不会再被唤回，写进它日志的模式永远不会被读到 —— 那就是一次静默的谎报。载体：D6 用例（`已停下且不可续的子代理拒改`）。
- **I11** **装载与可见性**：patch 行落在**全局层**，`set_child_permission` 对所有走 Adg preset 的会话可见；因此 **"名字可不可见"只是"给不给调度者"的开关，不是能力边界** —— 它本来就在 `delegate` 的 `BUILTIN_DENY` 里、不会进任何一次委派的工具面；真正的边界是 I2 / I3 的代码守卫 + `tools/check-preset.mjs` 的 `SCHEDULER_ONLY` 只把名字给调度者。反过来，同层重名注册会直接失败（拖垮整个 profile 的插件加载），所以 preset 里禁止再注册这个名字。载体：D7 用例（入口三件套 + 插件名等于 patch 行 id）；`node tools/check-preset.mjs`。
- **I12** **"装了包"与"被选中"是两件事**：bundle 装载只遍历该 profile 的 `dsh.profile.bundles`；只写列表而包装不上会让这个 profile 启动报错。所以 `install.*` 第 4c 步装、第 4c-1 步**读回来断言三格**。与 `notify/design.md` 的 I8 / I9 / I11 是同一条口径（含硬链接与"改仓库源必须重跑安装"），本模块不另立一套。载体：`install.*` 第 4c-1 步输出。

### 工具定义（作者侧契约，不可变值对象）

- **I13** **作者侧的 schema 方言是"隐式属性映射"，不是对象根 JSON Schema**：`parameters` 写成 `{ agent_id: { type:'string', required:true, description }, mode: { type:'string', required:true, enum:[…], description } }`；`output` 必须是 `{ schema, render }`，其 `schema` **反过来**要对象根形状（`type:'object'` + 显式 `additionalProperties: false` + 属性上的 `required: true`）。理由：形状写错发生在 `apply()` 注册那一刻＝**插件一挂载就崩**，而"只跑 stub"的自测不会暴露它。载体：D1 用例，其中一条是**反向对照**（把对象根形状喂给真 `defineTool` 并断言抛 `/parameters\.type must be a value schema object/`），纪律是造定义必须用**真的** `defineTool`（`createSetChildPermissionTool()` 因此支持注入 `defineTool`）。与 `notify/design.md` 的 I13 / I14 同形。
- **I14** **服务注入面**：`apply(ctx)` 通过 `deps.services()` 惰性取 `sessions` / `subagents` / `sandboxPolicy` / `sessionPersistence` 四个服务；守卫与路径**各自**只要求自己需要的那几个，缺哪个就抛一条点名它的可读错误（缺 `sessions` / `subagents` 抛"需要 subagents 与 sessions 两个服务"；缺 `sandboxPolicy` 由单调守卫拒；缺 `sessionPersistence` 只在已停下时抛）。理由：`ctx.get()` 在服务没加载时返回 `undefined`，静默降级会让"改不动"伪装成"改好了"。载体：D6 用例（三条分别缺服务）。

## 对外接口

- 工具：`set_child_permission` —— 参数 `agent_id`（string，**必填**，从 `list_agents` 取）/ `mode`（string，**必填**，enum 三档）；`isConcurrencySafe: () => false`（同一批调用串行，免得两条 `sandbox/mode` 的先后被重排）；`timeoutMs: 30000`；`output` 形状见 I13。description 写的是**触发面**：本会话刚被切到完全权限、而某个子代理是切换**之前**派出去的；两条硬约束（只能改自己派出去的、且不得超过自己当前权限）；运行中的下一步生效、已停下的下次唤回生效；approval 一律不动。
- 库接口：`permission/index.mjs` 导出 `name`（= `adg-permission`）/ `inject`（= `['tools']`）/ `TOOL_NAME`（= `set_child_permission`）/ `createSetChildPermissionTool()` / `setChildPermission()` / `apply()`；`permission/lib/permission.mjs` 导出 `SANDBOX_MODES` / `isSandboxMode()` / `modeRank()` / `assertNotWidening()` / `sandboxModeEvent()`。`setChildPermission(args, exec, deps)` 的依赖可注入（`deps.services`），这是自测能在不起 cordis 的前提下覆盖守卫与两条路径的原因。
- 装配接口（指针化，取值以文件本身为准，本文不复制）：`permission/cordis.patch.yml` 声明 patch 行（`id` 与 `name` 都必须是 `adg-permission`，落全局层）；`permission/package.json` 声明 `main` / `exports` / `files` / `scripts.test` / `dsh.bundle.patch` / 可选 peer 依赖。

## 非功能红线

只列技能要求的四类。操作型红线集中在 `permission/AGENTS.md` 的「红线」一节（R1..R13），**那里是唯一清单**，本文件不再抄一份。

- **性能预算**：一次调用只有一次读 + 一次写 + 一次 flush，上界＝工具 `timeoutMs`（30 秒）。**禁止在链路里做重试循环**：写失败要如实抛错，让调度者决定是重试还是改走"停掉重派"。载体：[评] 读 `setChildPermission` 的控制流。
- **一致性纪律**：`applied` 必须如实反映路径（I5 / I6 / R6）；守卫的拒绝消息必须写出**具体是哪一个**（缺哪个服务、哪个模式、目标 id 不是你的后代）—— 不可读的错误会让调度者改不动却不知道为什么。载体：[机检] D2 / D5 / D6 用例。
- **并发与幂等**：同一目标连续两次写同一模式会产生两条相同事件（**幂等语义、非幂等写**）—— 读到的模式仍然是同一个，无非多一条日志。`isConcurrencySafe: () => false` 让同一调用方串行。**未观测**：两个不同的父代理几乎同时把权限写给同一个子代理时，写租约的竞争形态（`SessionAlreadyOwnedError` 会不会被看到）；量法：在真实会话里让两个已派出的子代理各自的父代理对同一目标连续调两次，读错误文本。
- **数据安全**：这个工具**放宽的是文件写入面**，所以单调守卫与血缘守卫是**安全边界而非提示**（I2 / I3）；**禁止**把它接成"自动升权"的钩子（例如收到某类错误就自行调到 `danger-full-access`）—— 每次改动都必须是一次显式的、由调度者判断过的调用。来源：本模块存在的理由（提示级闸门不可靠）。载体：[机检] D2 / D6 用例。

## For Agents

动手前先读：`permission/AGENTS.md` → 本文件 → 改工具契约再读 `preset/agent.cordis.yml` 里调度 persona 的【浏览器：权限】段与 `tools/check-preset.mjs` 的 `KNOWN_TOOLS` / `SCHEDULER_ONLY`。

绝不能做：`permission/AGENTS.md` 的「红线」R1..R13；本文件的 I2（判据缺失时放行）、I3（自己维护血缘表或跳过血缘）、I4（给事件加 `source`）、I7（不关写句柄）、I8（碰 approval）、I9（顺手复活子代理）、I10（给不可续的子代理写日志了事）、I13（把 schema 写成对象根形状）。

停止并升级人类：要给不是自己派出去的会话改权限；要让权限能超过调用方；要加"遇到某类错误就自动升权"的自动化；要碰 approval；要把已停下的子代理"改权限顺便唤醒"；要改工具名。

## 测试与验证

见 [testing-guide.md](testing-guide.md)：用例总表按本文件的不变量编号（I1..I14）互指，另含消费方契约测试、验证 ≠ 装载、未观测项与交付前的最小闭环。
# AGENTS.md — delegate（`delegate` 插件）

本模块是仓库内部的第一方子插件（与 `notify/`、`permission/` 同形制）：包名 `adg-delegate`，在**全局层**注册工具 `delegate`，
让调度智能体在**每一次委派**时现给子代理指定工具集合与 persona —— 平台 `@deepseek-ai/dsh-tool-subagent`
做不到这一点（它已在 0.2.x 删掉 per-child 的 persona / toolFilter：委派缝隙里没有入口，官方口径是"配进 Agent Preset"）。
本插件保住这个能力的载体是**能力面窗口**：预留 `childId` 后，在子代理的**建立窗口**（`agent/created`，即 `startActivation` 返回之前）把 `tools.restrict` 与 persona 段贴上去 —— 等返回再贴就晚了，子代理首轮会带着从 preset 继承来的调度者 persona（设计见 [design.md](design.md) 的 I7b / I16）。装载形状与 `notify/`、`permission/`
同一种（稳定副本 + profile 的 `file:` 依赖 + `dsh.profile.bundles`），验证判据在 [testing-guide.md](testing-guide.md)。

## 命令

零依赖；只要 Node（`delegate/package.json` 声明 `>= 22`）。

```sh
cd delegate && node --test test                        # 单元测试；零副作用（不起进程、不碰真会话、不写磁盘）
cd delegate && node --test --test-isolation=none test  # DSH 沙箱（workspace-write）里必须加这个 flag
```

`node --test` 默认按测试文件起子进程跑用例，而受限沙箱里跨进程的管道 stdio 会被拦（EPERM）；
`--test-isolation=none` 让用例在同一个进程里跑，绕开那一层（`browser/`、`permission/`、`desktop/`
加这个 flag 是同一条口径）。

**自测前提**：可选 peer `@deepseek-ai/dsh-tools` 要能被 Node 解析到。本机实测的解析桥在
**`dsh-adg-ptc/node_modules/@deepseek-ai`**（一个指向本机 dsh 安装处 `node_modules` 的 junction；
仓库根 `D:\dsh` 没有 `node_modules/`，Node 从 `delegate/` 向上走两层就命中它）。
判据（`delegate/` 目录跑）：`node -p "require.resolve('@deepseek-ai/dsh-tools/package.json')"`
能打印出 dsh 安装处的路径。它不入库、是本机产物，缺了 `node --test test` 直接 import 失败。

## 红线

每条只写结论、理由与载体（**违反即返工**）。根 `AGENTS.md` 的「关键红线」同样适用于本模块。

| # | 红线 | 理由 | 载体 |
|---|---|---|---|
| R1 | 禁止删掉、放宽或绕过内置 deny 名单（`agent` / `delegate` / `workflow` / `ralph` / `set_child_permission` / `ask_user_question`）：调用方在 `tools` 里点名也不许进子代理的工具面。 | 这是本插件唯一的安全边界。前四个都能**再开子代理**（`agent` 是 preset 那条静态委派行的 toolName，子代理从祖先层继承得到它；`delegate` 是本插件的动态版；`workflow` / `ralph` 是编排引擎），一放就破坏"一跳可达"，孙代理对调度者不可见、不可 steer；后两个只认 live runtime root。`notify_user` **刻意不在名单里** —— 它是单向提醒，`notify/design.md` 与 `preset/design.md` 的 R20 明确允许给子代理用。`ask_user` **也不在名单里**：它是本插件注册的第二个工具、子代理唯一的**提问通道**（owner 是派它的那个调度者），禁掉它子代理就又只能"单向喊一声 + 停手"，见 R13。 | `delegate/test/delegate.test.mjs` 的 D5（名单六个名字）与 D19（`ask_user` 不在名单里）；`delegate/lib/delegate.mjs` 的 `BUILTIN_DENY` |
| R2 | 内置 deny 名单**必须与本次可用工具名求交**后再下发，禁止整体照发。 | 名单里可能含本 profile 未注册的名字（没装 `adg-permission` 就没有 `set_child_permission`），而平台 `tools.restrict()` 对 allow / deny 里的未知名一律抛错 —— 整次委派当场失败（根 `AGENTS.md` 红线 7 / 10 同源）。 | D2 的瘦 profile 断言 |
| R3 | 禁止把未知名静默丢掉：剔除之后必须逐条写进 `tools_note`。 | 那是模型唯一能看见"我点名的名字没生效"的地方；静默丢弃会让它以为工具已经给下去了。 | D4 |
| R4 | `run_code` 出现在 `tools` 里必须**当场抛错**（本仓库选定的口径，理由见 design.md 的 I5），不许剔除后继续。 | 平台对 allow 与 deny 两侧都为它抛错；放行会让调用方以为子代理能跑 PTC 程序。 | D6 |
| R5 | 读不出本次可用工具名（`exec.agent.ctx.tools.view(...)` 形状不符）时必须**抛错**，不许"跳过校验继续派"。 | fail-closed：没有对照表，既保证不了内置 deny 边界（名单里可能含未注册名），也替模型挡不下未知名。唯一可接受的方向是拒绝。 | D11 |
| R6 | 禁止给子代理传 `maxDepth`。 | 一跳可达由「平台默认 1」+「deny `delegate`」共同保证；写 `0` 会让每次委派以 `subagent depth 1 exceeds maxDepth 0` 失败（preset 侧红线 6 同源）。 | D8 / D9 的 request 断言 |
| R7 | `export const name` 必须等于 `cordis.patch.yml` 的 insert 行 `id`；禁止在 preset 里再注册一个同名 `delegate`。 | 不一致时 loader 找不到插件入口；**global 层同名重复注册会让整个 profile 的插件加载失败**。 | D12；`node tools/check-preset.mjs` |
| R8 | `inject` 只能是 `['tools']`；`subagents` / `agents` / `userQuestions`（以及将来要用的任何服务）在**调用那一刻**才 `ctx.get`。 | 注册顺序、以及某些服务是否挂载，不该由 apply 时机决定；缺哪个报哪个，而不是让整个 profile 起不来。 | D7；`delegate/index.mjs` 的 `apply` |
| R9 | 禁止写死任何本机绝对路径或用户根。 | 本模块其实不需要路径；真要就按 `import.meta.url` 推（测试就是这么做的）。 | D12 的正则扫描 |
| R10 | 派发只走 `subagents.startActivation({provider:'spawn', label, childId, request, signal, delivery:'parent'})` 这一条可续路径（`childId` 是本插件预留的，见 R14）；`background:false` 必须**当场报错**，不许静默建成可续；`childId` 取不到、或回来的 id 与预留的不一致，都不许当成功回报。 | 本机平台（0.2.1-rc.2）的 `SubagentRuntime` 没有 `start` / `startContinuable`，`startActivation` 是唯一入口，spawn provider 一律产出可续子代理。静默改道会把「前台」伪装成成功；`childId` 缺失时子代理可能已建立但没有可接续的 id，假报成功会骗过调度者；id 不一致意味着能力面贴到了一个没有先验登记的对象上，边界不可信。 | D9 / D10 / D31；design.md 的 I4 / I7b / I18 |
| R11 | 禁止解析 `jobs` 服务、禁止实现一次性路径；`kind` 的 enum 只有 `continuable`，不许在描述或文档里承诺别的路。 | 本插件固定按 continuable 语义工作；没有 `jobs` 就没有一次性后台，硬拿回来只会把一条不存在的路径写进契约。 | design.md 的 I4；`delegate/lib/delegate.mjs` 的 `requireSubagents` |
| R12 | 禁止在工具描述或文档里把 persona 说成"在子代理原有 persona 上追加"；也禁止把"调用方没给 persona"实现成**不注册**。 | 它经能力面窗口注册成该子代理上的 scoped `deployment:persona-prefix` 段，是**遮蔽**该子代理的部署 persona（子代理经 `composeFrom` 继承整份 preset，**包括调度者的 persona 段**）。没给时注册一段**空串**才是"没有 persona 段"：不注册等于不遮蔽，子代理会带着调度者的 persona 开工。 | design.md 的 I7（含**未观测**的量法）；D22 / D32 |
| R13 | `ask_user` 的 owner 必须是**派它的那个调度者**（按配对表取回 id、用 `agents.get(id)` 换成活着的那个 Agent 实例）；取不到就**抛错**，禁止退回"以子代理自己的名义问"。 | 用户提问服务在带 agent 时只认 live runtime root：子代理自己问拿 `DELEGATED_CALLER` —— 那不是"问不到人"，而是"看起来问过了却没人能答"。同一性要求（`agents.get(id) === agent`）决定了不能用 id 或快照顶替，dsh 重启后配对表的旧条目也不作数。 | `delegate/test/delegate.test.mjs` 的 D15 / D17 / D20；`delegate/lib/delegate.mjs` 的 `resolveAskOwner` / `createOwnerIndex` |
| R14 | 能力面（persona / toolFilter）**只经能力面窗口**下发且 fail-closed：预留 `childId`（`newChildId()`）→ 派发前登记 `createChildFaces()` → `agent/created` 里**同步**贴 `tools.restrict` / persona 段 → `take()` 收口三态（`applied` / `failed` / `pending`）；`failed` 或兜底形状不符 ⇒ **先 `dispose()` 回收再抛错**；返回 id 与预留 id 不一致 ⇒ 抛错；禁止把 persona / toolFilter 塞进平台 request。 | 平台 0.2.x 的 `SubagentStartRequest` 没有这两个字段（塞进去会被静默丢弃），委派缝隙里没有别的入口。**时点**同样是硬要求：`startLocal` 里"装配子代理 → 投递首条 prompt → 返回"是一次性的，等返回再贴就迟了 —— 子代理首轮会带着从 preset 继承来的调度者 persona 定型。下发失败还把子代理留着当成功，等于交出一个"没受限、没 persona"的假成果。 | design.md 的 I7b / I9 / I16；D8 / D22 / D23 / D28–D31 |
| R15 | `send_message` 是平台续接通道、不是任务能力：只要它在本次可用名里就必须无条件留在 `allow` 里（不随调用方是否点名它而变，`tools: []` 也照留）；**同时**在建立窗口里往子代理**自己的 scope 层**注册一份不带平台标记的同名克隆（影子注册，`shadowSendMessage`），让平台那句续接提示不再被追加 —— 两者缺一不可，**不许**用剥掉工具的方式来消提示。 | 平台在 `startActivation` 时就按子代理继承到的工具目录追加「用 send_message 回传结果」的续接提示（`@deepseek-ai/dsh-subagent` `lib/index.js:1460`），判据只是那份定义上一个**非枚举** Symbol 标记，平台没有开关。创建后窗口的 `restrict({allow})` 把它剥掉会让提示与工具面自相矛盾（工具没了，提示还在）。影子注册只管摘标记、`execute` 直接复用原定义，工具面语义一字未改。条件化：只在 `knownNames` 里存在时并入（否则 `restrict()` 抛 unknown global tool）；读不到 `send_message` 就跳过影子注册，`ctx.tools` 形状不符则 fail-closed 抛错；同一 scope 重复注册（平台抛 `is already registered in this scope`）按幂等吞掉仍算 `'shadowed'`，**别的注册错误照抛**。**行号口径**：`lib/index.js:1460` 这类行号对应当前本机安装的那一版，dsh 升级后会漂 —— 按 `withContinuableReturnGuidance` / `isAdjacentAgentSendMessageTool` 两个符号名重新定位，别照旧行号硬读。它**不是**内置 deny 的一员，也不得替 `run_code` 开后门。 | D24–D27、D35–D41；`delegate/lib/delegate.mjs` 的 `CONTINUATION_TOOL` / `planToolFilter` / `shadowSendMessage`；design.md 的 I17 / I17b |

## 跨模块路由

| 你要做什么 | 先读 | 再读 |
|---|---|---|
| 改工具计划（allow / deny / 忽略口径） | [design.md](design.md) 的「核心数据模型」I1–I6 | [testing-guide.md](testing-guide.md) 的「用例总表」D2–D6 |
| 改派发路径 | `design.md` 的 I4 / I9 / I10 | 平台契约：`@deepseek-ai/dsh-subagent` 的 `SubagentRuntime.startActivation` 与 `SubagentActivationSpec`；`@deepseek-ai/dsh-tool-subagent` 的同名执行路径（参考实现） |
| 改能力面窗口（能力面载体：预留 id / `agent/created` 监听 / 三态收口） | `design.md` 的 I7 / I7b / I16 | 平台对照：`@deepseek-ai/dsh-subagent` 的 `applyChildOverrides` / `applyChildComposition`、`startLocal` 的时序，`@deepseek-ai/dsh-agent` 的 `agent/created` announce；`testing-guide.md` 的人工 review 项（`agent/created` 的时点） |
| 改工具名或参数 | `preset/agent.cordis.yml` 的调度 persona（**唯一消费方**；`delegate` 是全局层工具名，**不需要写进 preset 的委派行**） | `tools/check-preset.mjs` 的 `KNOWN_TOOLS`（工具名要能过 preset 的静态自检） |
| 改装载形状（目录名 / 包名 / 装法） | `install.ps1` / `install.sh`（接线在安装脚本里） | `permission/AGENTS.md` 的「跨模块路由」与 `notify/design.md` 的装载不变量（同一种装法，本模块不另立一套） |
| 改「读不出可用工具名」的降级口径 | `design.md` 的 I6 | `testing-guide.md` 的人工 review 项；根 `AGENTS.md` 的「诚实原则」 |

## 版本区

本模块在版本区里的文档就是 `delegate/AGENTS.md`（本文件，路由）→ [design.md](design.md)（设计、不变量）→
[testing-guide.md](testing-guide.md)（用例全表与未观测项）三份，加**不在版本区**的临时目录 `docs-work/`。
完整清单与根入口见根 `AGENTS.md` 的「版本区」一节，此处不另抄。

## 生效方式

| 改了什么 | 怎么生效 | 怎么复核 |
|---|---|---|
| `delegate/` 任何文件 | 重装子插件（`install.*`：稳定副本 + `dsh plugin --profile <p> add`）+ **重启 dsh** + 新会话（监听器在插件装载那一刻注册，运行中的旧会话不补挂） | `cd delegate && node --test test`；再在新会话里让调度者用一次 `delegate`（给一个 `tools` 清单；再派一次**不给** persona），按 [testing-guide.md](testing-guide.md) 的「验证 ≠ 装载」核对 `tools_note`、子代理首轮的工具面、首轮有没有调度者 persona 残留，以及子代理**首条 prompt 末尾有没有那段续接提示**（影子注册生效后应当没有） |
| 本模块任何 `.md` 文档 | 立即生效（只是文件） | 按 `adg-doc-criterion` 技能的质量红线清单自检 |

**未观测**：装好子插件并重启 dsh 之后，`delegate` 是否真出现在调度者的工具面里、子代理是否真按这一次的 `tools` 与 `persona` 建立（含 `agent/created` 是否恒在首轮装配之前，见 I7b）；量法：在新会话里让调度者用一次 `delegate`（给一个 `tools` 清单、一次**不给** persona），按 [testing-guide.md](testing-guide.md) 的「验证 ≠ 装载」核对 `tools_note` 与子代理**首轮**自报的工具面 / persona 段 —— 首轮不该出现调度者 persona。

**接线两半已成立**：`delegate` 在 `tools/check-preset.mjs` 的 `KNOWN_TOOLS` 里（与 `agent` 相邻的两条），判据＝`node tools/check-preset.mjs` exit 0；调度 persona 也显式提到它（`preset/agent.cordis.yml` 的「你手上的子代理」段写明"委派用 `delegate`"）。

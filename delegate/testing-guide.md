---
title: delegate 测试与验证
owner: Adg preset 维护者
status: current
last_reviewed: 2026-10-19
---

# testing-guide.md — delegate

两层验证，别把它们混成一层：

- **机制层**（自动化、可离线）：工具计划、请求装配、唯一派发路径的分支、创建后窗口的能力面下发、错误口径、入口与 bundle 的形状 —— 全在 `delegate/test/delegate.test.mjs` 里，用假服务与假调用方跑。
- **装载层**（只能重启后观测）：`cordis.patch.yml` 能不能被 loader 装载、`delegate` 真出现在调度者的工具面里、子代理真的按这次的 `toolFilter` 与 `persona` 建立（含创建后窗口的竞态）—— 单元测试与静态自检都看不到这些。

## 命令

```sh
cd delegate && node --test test                        # 机制层：单元测试（零副作用：不起进程、不碰真会话、不写磁盘）
cd delegate && node --test --test-isolation=none test  # DSH 沙箱（workspace-write）里跑这一条
```

`node --test` 默认按测试文件起子进程跑用例，受限沙箱会拦跨进程的管道 stdio（EPERM）；`--test-isolation=none` 让用例在同一进程里跑。前提是 `@deepseek-ai/dsh-tools` 能被解析到（本机实测解析桥在 `dsh-adg-ptc/node_modules/@deepseek-ai` 的 junction，见 [AGENTS.md](AGENTS.md) 的「命令」）。

## 用例总表

| 用例 | 对象 | 断言内容 | 对应不变量 | 载体 |
|---|---|---|---|---|
| D1 | `createDelegateTool()` 用**真的** `defineTool` | 参数是隐式属性映射（必填收成顶层 `required: ['description','prompt']`）、`tools` 是 string 数组；output 是对象根 + `additionalProperties:false` + 六个字段；两个反向对照（对象根写进 `parameters` ⇒ `parameters.type must be a value schema object`；缺 `output` ⇒ 读 `output.render` 的 TypeError）；`isConcurrencySafe(合法实参) === true`、`({}) === false` | I11 | `delegate/test/delegate.test.mjs` D1 |
| D2 | `planToolFilter` / `delegate` + 假子代理 | `tools` 省略 ⇒ 假子代理的 `restrict` 收到只有 `deny` 的滤镜（没有 `allow` 键）；瘦 profile（`['Read','delegate']`）⇒ deny 只有 `delegate`；`tools` 回显 `[]`；note 以「未过滤」开头 | I1 / I2 | D2 |
| D3 | 同上 | 给清单 ⇒ `allow` 与 `deny` 同时下发，`allow` 只留清单里的可用名 | I1 | D3 |
| D4 | 同上 | 未知名剔除、同名去重、`ignored` 保持点名顺序、逐条进 `tools_note`；空字符串这种坏值抛错 | I3 | D4 |
| D5 | 同上 | 六个内置名被点名也不进 `allow`（且仍在 `deny` 里）；`notify_user` **不在**名单里、可以进 `allow`；`tools: []` ⇒ `allow: []` + 「空清单」 | I1 | D5 |
| D6 | 同上 | `run_code` ⇒ 抛错（消息含 `run_code` 与「PTC 传输保留名」），且发生在调用任何服务之前（`startActivation` 零调用、`restrict` 零调用） | I5 | D6 |
| D7 | `assertCallerAgent` / `delegate` | 没有 `exec.agent` ⇒ 抛错；缺 `subagents` 服务 ⇒ 报清楚是哪个服务 | — | D7 |
| D8 | `buildRequest` | request 键恰为 `['prompt','parent']`；`label` / `signal` 不进 request（它们在 `SubagentActivationSpec` 上）；persona / toolFilter / maxDepth 都**不进** request | I7 / I8 / I16 | D8 |
| D9 | `delegate` + 假 `subagents` / 假子代理 | 缺省与显式 `background: true` 都走 `startActivation`，spec 键恰为 `provider,label,request,signal,delivery`、`provider === 'spawn'`、`delivery === 'parent'`、`signal` 同源、`request.parent` 就是调用方；能力面贴到假子代理的 `restrict`（deny 恰为内置名单）；没给 persona ⇒ `systemPrompt` 零调用；`childId` 取不到 ⇒ 抛错；`view` 的实参就是那个 Agent 对象 | I4 / I8 / I10 / I16 | D9 |
| D10 | `delegate` + 假 `subagents` | `background: false` ⇒ 抛错（消息说明"当前 dsh 版本不可用"），且 `startActivation` 零调用、`restrict` 零调用 | I4 | D10 |
| D11 | `readRestrictableNames` | `view` 不是函数 / 返回 `{}` / 返回空 `Set` ⇒ 三种都抛错且零服务调用；形状对了返回 `Set` | I6 | D11 |
| D12 | 三个源文件 + `package.json` | 入口三件套在位；`name` = patch 的 `id` = 包名；`type` / `main` / `dsh.bundle.patch` 正确；**没有** `dependencies`；纯逻辑层零 `import`；两个源文件里没有盘符绝对路径与用户根 | I11 | D12 |
| D13 | 真 `defineTool` 编出的定义 | 在假服务上跑通一次完整调用，假子代理的 `restrict` 收到 `allow + deny`；`output.render` 出一行含 id 与人话的文本 | — | D13 |
| D14 | `createAskUserTool()` 用**真的** `defineTool` | `questions` 收成顶层 `required`、每项在属性上必填 `id` / `question`；`asked_as` 是 `self` / `scheduler` 两值枚举；**定义里没有 `timeoutMs`** | I12 / I15 | D14 |
| D15 | `askUser` + 假 `agents` / `userQuestions` | 子代理调用 ⇒ 交给 `userQuestions.ask` 的 `agent` 是**配对表里那个调度者**、`asked_as: 'scheduler'`；返回值是脱拷贝的新数组/新对象（改它不影响服务那边的引用） | I13 / I14 | D15 |
| D16 | 同上 | 调度者自己调用（配对表里没有它）⇒ `agent` 就是它自己、`asked_as: 'self'`；`multi_select` 映射成 `multiSelect`，没给时请求里**没有**这个键 | I13 / I14 | D16 |
| D17 | 同上 | `agents.get(ownerId)` 回 `undefined`、或根本没有 `agents` 服务 ⇒ **抛错**，且 `userQuestions.ask` **零调用**（绝不降级成以子代理自己的名义问） | I13 | D17 |
| D18 | `questionRequest` / `answerResult` | 空数组、空 `id`、重复 `id`、缺 `question` 正文、服务没回 `answers` 数组 ⇒ 五种都抛错且消息说明"拿到了什么" | I14 | D18 |
| D19 | `createOwnerIndex` / `BUILTIN_DENY` | 配对表只记「非空 childId + 有 id 的 parent」；`ask_user` 的名字**不在** `BUILTIN_DENY` 里（子代理必须有提问通道） | I12 | D19 |
| D20 | `delegate` + 假 `subagents` | 可续路径把 `(childId → 调用方)` 交给配对表，且用的是取回来的那个 id | I13 | D20 |
| D21 | 真 `defineTool` 编出的 `ask_user` | 在假服务上跑通一次完整调用，`output.render` 出一行人话（含问了几个问题、以谁的名义） | — | D21 |
| D22 | `applyChildFace` | persona 注册成 `{name:'deployment:persona-prefix', order:getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text}` 段、toolFilter 走 `tools.restrict`；空 face ⇒ 零贴；取不到活实例 / `restrict` 不是函数 / `section` 不可用 ⇒ 三种都抛错（fail-closed） | I7 / I16 | D22 |
| D23 | `delegate` 的失败回收 | 能力面下发失败（`agents` 服务缺失 / `get` 回 `undefined`）⇒ `startActivation` 返回值的 `dispose` 被调**一次** + 抛错（绝不留未受限子代理当成功）；正常路径零回收 | I9 / I16 | D23 |

**测试纪律**：造工具定义一律用**真的** `defineTool`（作者侧 schema 方言与 `output` 硬要求只有真实现判得了）；假件只替换服务、调用方与子代理运行时，**不**替换 schema 编译器。假 `subagents` 只实现 `startActivation`（平台唯一入口）并记录 `dispose`；假子代理用 ledger 记下 `restrict` / `section` 的每次调用 —— persona / toolFilter 走创建后窗口，测试就在这个窗口的**接收端**断言。用例之间不共享可变状态，所以可以任意顺序、并发跑。

## 迁移矩阵

**无。** 本插件不持有持久状态、不产出需要版本迁移的制品：每次调用只读一次工具视图、建立一次子代理会话，会话本身由平台的迁移链负责。

## 消费方契约测试

消费方有三处：preset 的调度 persona（调 `delegate`；本插件不要求 preset 写任何东西 —— `delegate` 是全局层工具名，不需要写进 preset 的委派行，也进不了任何一次委派的 `tools`：它在内置 deny 名单里）、**拿到 `ask_user` 的子代理**（它是这条提问通道的唯一调用者），以及**作答的人机界面**（卡片由客户端 `dsh-client-ui-user-questions` 渲染与回收，机制层看不到那一段）。对平台的每一条契约面都被一条用例钉住形状，改名或改形状会当场红：

| 契约面 | 用例 |
|---|---|
| `SubagentRuntime.startActivation(spec)` 的 spec 键（`provider` / `label` / `request` / `signal` / `delivery:'parent'`）与 `SubagentActivation.childId` | D9 |
| 创建后窗口：`AgentRegistry.get(childId)` 活实例上的 `tools.restrict(filter)` / `systemPrompt.section('deployment:persona-prefix')` | D22 / D23 |
| `ToolRestriction{allow?, deny?}` 的两侧下发与"只减不增"的用法 | D2 / D3 / D5 |
| `SubagentStartRequest` 的键集（只有 `prompt` / `parent`；**永不出现** `maxDepth`，也没有 persona / toolFilter 的位置） | D8 / D9 |
| `tools.view(agent).restrictableNames`（含读不出时的 fail-closed 分支） | D11 |
| `UserQuestionService.ask({questions, agent, signal})` 的请求形状与 `{answers}` 结果 | D15 / D16 / D18 |
| `AgentRegistry.get(id)` 的活实例同一性（取不到 ⇒ 抛错，且不问） | D17 |
| `defineTool` 的作者侧 parameters 方言与 output 对象根方言（两条工具各编一遍） | D1 / D13 / D14 / D21 |

## 验证 ≠ 装载

- **能证明的**：工具计划、请求装配、唯一派发路径的分支、创建后窗口的调用形状、错误口径、入口与 bundle 的形状、零依赖。
- **证明不了的**：`delegate/cordis.patch.yml` 能被 loader 装载；`delegate` 与 `ask_user` 真出现在调度者 / 子代理的工具面里；子代理真的按这次的 `toolFilter` 与 `persona` 建立；`ask_user` 的卡片真落在调度者会话里、用户作答后答复真回到子代理（后两个假件与客户端渲染那一段）。
- **一条很容易踩的假证据**：用例里的 `subagents` 是假件 —— "D9 通过"只说明本插件**交给平台的 spec 形状**对，不说明平台接受了它。`startActivation` 的前置校验（parent 同一性、capabilities）、provider 是否放行那批名字，只有真实挂载（或一次真委派）能观测。
- **第二条同样的假证据**：用例里的假子代理是本插件自造的 —— "D22 通过"只说明**调用形状**对；`tools.restrict` 与 `systemPrompt.section` 在真子代理身上是不是活生效、以及第一轮请求的装配是否晚于能力面下发（竞态，见 I16），只有真会话能观测。
- **第三条**：用例里的 `agents` / `userQuestions` 也是假件 —— "D15 通过"只说明**请求形状**对；用户提问服务的 `assertLiveRoot` 同一性判定、卡片的渲染与回收、答复走的耐久路径，只有真会话能观测。

## 人工 review 项

**未观测**：创建后窗口与子代理 loop 的竞态（I16）—— `startActivation` 返回后、能力面贴上之前，子代理是否可能已经 claim inbox 并装配第一轮请求（若发生，首条 prompt 的系统提示词与工具目录不受这次 tools / persona 约束）；量法：真实会话里委派一次带 `tools` 清单与 persona 的子代理，让它**首轮就**报告自己的工具面与 persona 段，与 `tools_note` 比对。
**未观测**：`view` 的非公开性（类型面是 `private`，本机解析到的实现里是原型方法）在 dsh 升级后是否还成立；量法：升级后跑 `cd delegate && node --test test`，再做一次真实委派，看是否抛 I6 的自诊断错。
**未观测**：scope key 约定（`exec.agent` 就是 scope key）在别的 dsh 版本里是否也成立 —— 不成立会**静默**退化成"只有全局层"的对照表；量法：真实会话里用 `tools: ["Read"]` 委派一次，断言 `tools_note` 没有把 `Read` 列为忽略。
**未观测**：内置 deny 六个名字与真实 profile 的交集；量法：装齐 `adg-permission` / `adg-notify` 后委派一次，断言不抛 unknown-name 错，并在 `list_agents` 上确认该子代理的工具面里没有这六个名字（`notify_user` 例外：它不在名单里，给了就该出现）。
**未观测**：persona 的遮蔽净效果；量法：真派一次带 persona 的子代理，读它会话日志里的 `deployment:persona-prefix` 段，确认部署 persona 没有残留。
**未观测**：并发多条委派时对照表读数的稳定性；量法：并发派两条，断言两条的 `tools` / `tools_note` 一致。
**未观测**：`ask_user` 的登录墙端到端链路（子代理开有头窗口 → 直接问用户 → 用户在卡片上作答 → 答复回到子代理 → 它自己复核登录态并继续）；量法：在真站点登录墙前派一次带 `ask_user` 的浏览器委派，读转写：它这一轮调的是 `ask_user` 还是 `notify_user`、卡片落在哪个会话、拿到答复后有没有先复核登录态再继续。
**未观测**：配对表跨越 dsh 重启 / 子代理被 `send_message` 续起之后还能不能取到活着的调度者（预期：重启后旧条目查不到活实例 ⇒ 抛错；续起同一进程内的子代理 ⇒ 仍能问）；量法：派一个带 `ask_user` 的子代理，让它先只报一句、用 `send_message` 续起后再问一次，观察是 `asked_as: 'scheduler'` 还是那条"委派你的调度者此刻不是活着的会话"。

## 交付前的最小闭环

```sh
cd delegate && node --test test
cd delegate && node --test --test-isolation=none test
```

两条全绿即机制层通过。`node tools/check-preset.mjs` 与四条 `tools/check-bundle-flavor.mjs` 断言验的是 preset 源文件与产物，**不在本模块的闭环里**；但改了 `delegate/lib/delegate.mjs` 的 `BUILTIN_DENY`（或改了 `adg-delegate` 注册的工具名）就该跑一次 `node tools/check-preset.mjs` —— 它的 5c 块会从本模块抠那个数组的**字面量**判名字在不在（缺 `agent` / `delegate` ⇒ ERROR；`ask_user` 出现在字面量里 ⇒ ERROR，见 `MUST_BE_AVAILABLE_TO_CHILDREN`）。装载层的复核按 [AGENTS.md](AGENTS.md) 的「生效方式」一节做。

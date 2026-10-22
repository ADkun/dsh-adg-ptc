# design.md — ptc-parallel（`adg-ptc-parallel` 并行执行提示插件）

设计与不变量。路由见 [AGENTS.md](AGENTS.md)，验证见 [testing-guide.md](testing-guide.md)。

## 1. 这个插件到底做什么（先说清边界，别夸大）

**做什么**：给每个**确认为 PTC 呈现**的 agent，在它自己的 scope 上注册一段系统提示词 section，正文是「PTC 并行执行（一次 run_code 里多做）」，末尾附带一份**当次现算**的工具清单。

**不做什么**（三条边界，写下来是为了不让下一个读者误读）：

- **不改任何工具的行为**。本插件不注册工具、不改写工具入参、不改写工具结果。它只往系统提示词里加一段话。
- **不保证模型一定照做**。它是提示词，不是机制闸门 —— 与"把框架正文放进系统提示词"是同一类手段（机制保证的是"模型看得到"，不是"模型一定听"）。
- **不替模型决定并行什么**。正文只讲清"怎么判断能不能并行"（无依赖的并行、有依赖的串行），判据仍然是模型自己的任务依赖分析。

## 2. 挂载点

`inject: ['systemPrompt']` + 全局层 `ctx.on('agent/created', handler)`，注册挂到 `agent.ctx` 上。

- **为什么是 `agent/created`**：这是"这个 agent 刚存在、它的 scope 已经定下来"的那一刻 —— 呈现模式已经能判定、section 还来得及注册。
- **为什么逐 agent 判定**：PTC 呈现是**按 scope** 解析的（同一个进程里，native agent 与 PTC agent 并存是常态），提示词也是**每个 agent 各自组装**的。所以"要不要给这一段"只能逐 agent 回答。
- **为什么挂在 agent 自己的 scope 上**：注册在 `agent.ctx` 上，agent 注销时随 scope 自动拆除；插件自己的清理只负责拆 `agent/created` 监听器，不追着 agent 收尸。
- **为什么落全局层（无 scope）**：插件行挂在全局层，但**section 注册是逐 agent 做的**（在 agent 自己的 scope 上）。反过来，preset composition 里的 scoped section 会经 composeFrom 一并落到子代理（agent-preset-registry 的 join 把子代理 scope 直接绑到 generation scope），那种形状给不出"按 scope 逐个判定"。

## 3. 核心数据模型

### 3.1 判定（`isPtcAgent(ctx, agent)`，在 [lib/guide.mjs](lib/guide.mjs)）

```
ctx.get('tools').get('run_code', agent) !== undefined
```

**为什么这条判据等价于「这个 scope 是 PTC 呈现」**（平台契约，升级 dsh 后重核第 5 节）：

- `run_code` 是平台**保留名**的呈现传输层 —— 注册时就拒绝这个名字，所以它不是一个普通的全局工具。
- dsh-tools 解析某个 scope 的**可见工具集合**时，先解析能力层（全局层 + scope 链上的祖先层 + scope 自己的层），**最后**才按 scope 的呈现模式补上它：呈现模式不是 `native` 的 scope 才有 `run_code`，native scope 的调度表里没有它 —— 哪怕同一进程里别的 agent 正在呈现它。
- 呈现模式本身沿 scope 链解析（最近的 scope 优先，preset 的声明覆盖其下所有 agent），所以"离得最近的声明"说了算。
- ⇒ `tools.get('run_code', agent)` 不为 `undefined` ⟺ 这个 scope 的呈现模式不是 native ⟺ **这个 scope 是 PTC 呈现**。

**scope 传什么**：传 **agent 对象本身** —— agent 的 scope key 就是这个实例（`tools.get(name, scope)` 的 `scope` 形参类型是 `ScopeKey`）。

**异常口径**（fail-closed）：`get` 内部要现造 PTC 传输层（要取 PTC runtime、workingDirectory 等服务），这些服务缺失时**会抛错**。异常一律当"不是 PTC"—— 判据拿不到时宁可不注入，也不要把一段讲 PTC 并行的正文塞进一个根本不是 PTC 的会话。

### 3.2 注入（`index.mjs`）

| 字段 | 取值 | 说明 |
|---|---|---|
| `name` | `'adg:ptc-parallel'` | section 名，每个 agent 的 scope 内唯一 |
| `order` | `810` | 落在平台自己的 PTC-only 段（800）之后、文件引用段（900）之前 |
| `text` | `(context) => guideTextFor({ ctx, scope: context?.scope ?? context?.agent })` | **provider**：每次组装提示词时现算（理由见 3.3） |
| 挂载层 | 每个 PTC 呈现 agent 自己的 `agent.ctx` | 由 `apply()` 在 `agent/created` 里逐 agent 注册 |

**order 的选取**：紧挨着平台的 PTC-only 段（那段讲"PTC 模式只有 run_code"）之后 —— 模型先读到"这个模式怎么运作"，紧接着读到"那怎么用它并行"，读起来是一条线。

**为什么 `text` 是 provider 而不是常量字符串**：系统提示词**每次组装都会重新求值** `text`，而"这个 agent 当前看得见哪些工具"是会变的（不同 agent 工具面不同、dsh 升级后新增工具）。写死字符串等于把**一次读数**当锚 —— 所以每次组装都现算一遍：指引部分是常量，末尾的工具清单按当前 scope 现算。

### 3.3 正文（`GUIDE_TEXT` + `CLASSIFICATION_NOTE` + 动态清单，在 [lib/guide.mjs](lib/guide.mjs)）

正文分三块，职责不同：

1. **指引部分（`GUIDE_TEXT`，常量）** —— 讲三件事：
   1. 动手前先拆依赖：无依赖的**一次全发**（`Promise.all`，平台并发执行）、有依赖的**串行接**（中间处理留在程序里）、一次能干完的**别拆多轮**。
   2. 平台按每个工具**自己的并发安全声明**调度：声明了并发的真的并行跑；没声明的一律独占（它不返回，排在它后面的调用都等着）。所以模型**不用背**哪几个工具能并发 —— 最坏情况是独占的退化成串行，不报错也不丢结果；唯一要留神的是"别让一个慢调用挡在快调用前面"。
   3. 并发的子调用数有平台上限，超出的那批会排队（**不写死具体数字**）。

   这一块是**不随会话变化的事实**（平台并发语义），所以是常量；**禁止在正文里写 token 预算 / 次数上限**（根 `AGENTS.md` 红线 4 的同源口径）。

2. **过渡句（`CLASSIFICATION_NOTE`，常量）** —— 告诉模型"下面这份清单是现算的，别把它当常量"，并说明具体某一次调用平台仍按实参再判一次。

3. **工具清单（动态）** —— 每次组装时从**这个 agent 当前可见的工具集合**现算，渲染成两行（可并发 / 独占），空列不渲染。

**为什么清单必须现算、不能写死**（这是本模块最容易犯的错，单独强调）：

- 工具集合会变：dsh 升级新增工具、某个 agent 的工具面被 preset 裁剪、profile 装了额外插件 —— 每一项都会让写死的清单**过期**。
- 过期比没有更糟：模型读了"这个能并发"，会据此把调用拆错。作者写清单那一刻是对的，模型读到那一刻可能已经错了。
- ⇒ 清单**不写进正文常量**，而是每次组装提示词时从 `tools.view(scope).visible` 现算。代码零维护，新工具自动出现。

**分类口径（与平台调度器同源，不自己发明）**：

- 工具定义上**有** `isConcurrencySafe` 函数属性 ⇒ 归"可并发"；**没有** ⇒ 归"独占"。
- 这与 dsh-tools 的 `executionMode` 同源：没有 `isConcurrencySafe` 就直接判独占；有则拿实参问它，答 true 才并行，抛错也兜底成独占。
- **`run_code` 自己不进任何一列** —— 它是"一次调用里发多个子调用"的那个入口，列进清单只会诱导模型去并发调用它自己。
- 两列都按名称排序，输出稳定（不随 Map 迭代顺序抖）。
- **不用"无参调用 `isConcurrencySafe({})` 去探测真假"** —— 平台那份实现会先校验参数，必填参数的工具会被误判成不安全。只看"有没有这个函数属性"，具体某一次调用的结论交给平台（这一点也写进了 `CLASSIFICATION_NOTE`）。

**取工具的路径**：`ctx.get('tools')` 拿 dsh-tools 的 ToolRuntime（cordis 的按名取服务，**不需要 inject**），再 `tools.view(scope)` 取**这个 scope** 当前看得见的工具集合。view 按 scope 链解析（越近的 scope 覆盖越远的，global 层最后），而 ToolRuntime 是全局单例、它那几层 scoped layer 是共享的 —— 所以**传子代理的 scope 进去，看到的就是那个 agent 自己的工具面**，不同 agent 各看各的视图。

**取不到就退回**：整个组装函数体 try/catch —— 服务不存在、view 抛错、返回形状不对、清单为空，都只返回 `GUIDE_TEXT`（少一段清单不影响指引成立），**绝不让提示词组装炸掉**。

## 4. 不变量

| # | 不变量 | 载体 |
|---|---|---|
| I1 | 判定只用公开 API `ctx.get('tools').get('run_code', agent)`，且 scope 传 agent 自己 | `test/ptc-parallel.test.mjs` 的 G4 |
| I2 | 判据抛错 ⇒ 当"不是 PTC"（不注入），异常不外抛 | G2 / G6 |
| I3 | 指引正文只有一份（`lib/guide.mjs` 的 `GUIDE_TEXT`），插件里无副本 | S1 / S2 + [评] 读 `index.mjs` |
| I4 | 本插件不注册任何工具，只有一个 `agent/created` 监听器 | [评] 读 `index.mjs` 的 `inject` / `apply` |
| I5 | 监听器体整个被 try/catch 包住，单个 agent 的失败不拖垮其它 agent | G5 / G6 |
| I6 | 非 PTC 呈现的 agent 一个 section 都不注册 | G3 / W4 |
| I7 | section 注册在 agent 自己的 scope 上（不碰别的 agent） | W3 |
| I8 | 零第三方依赖；Node `>= 22`；只用语言内建能力 | `package.json` 无 `dependencies`；[评] 读 import 行 |
| I9 | 运行中的旧 agent 不补挂 —— section 只在 agent 创建那一刻注册一次 | `AGENTS.md` 的「生效方式」 |
| I10 | **正文与过渡句里不得出现任何工具名硬编码**（清单必须现算） | S3（防回归硬断言） |
| I11 | 分类口径 = "有 `isConcurrencySafe` 函数属性 ⇒ 可并发，否则独占"，且**从不调用**该函数 | L1 / L3 / L4 |
| I12 | `run_code` 不进任何一列；两列按名称排序 | L1 / L2 |
| I13 | 取工具失败 ⇒ 只退回 `GUIDE_TEXT`，不抛异常 | L8 / L9 / L10 |
| I14 | section 的 `text` 是吃 context 的 provider（清单随组装现算） | W8 / C4 |

## 5. 平台契约速查（升级 dsh 后重核这几条）

全部来自 `@deepseek-ai/dsh-tools`（本机解析见根 `AGENTS.md` 的「外部依赖与 ref 解析」）：

- `tools.get(name, scope)` —— public 方法，`scope` 形参类型 `ScopeKey`；按**一个 scope 的视角**解析工具，缺省（不传 scope）是全局视角。
- `run_code` 是**保留名**（注册即拒），它是 PTC 模式的**呈现传输层**；它**不进全局层**，可见性在解析完能力层之后按 scope 追加。
- 可见性追加的条件：**该 scope 的呈现模式不是 `native`**（native scope 的调度表里没有 `run_code`）。
- 呈现模式沿 scope 链解析：最近的 scope 优先，preset 的声明覆盖其下的 agent。
- 取 `run_code` 定义时可能要现造传输层（要取 PTC runtime、workingDirectory、approval、sandboxPolicy 等服务）—— **缺服务时会抛错**，所以判据必须 try/catch。
- `tools.view(scope)` —— 返回该 scope 的可见集合（`{visible: Map<name, definition>}`）。**类型声明里标的是 `private`，但运行时确实存在** —— 所以本模块只在 try/catch 里防御性使用，用坏了也只是退回 `GUIDE_TEXT`。
- 并发分类：调度器 `executionMode(exec)` 的口径是"没有 `isConcurrencySafe` ⇒ 独占；有则按实参问它，答 true ⇒ 并行，抛错 ⇒ 独占"。
- 用户自定义的并发安全声明会被平台包一层：**先校验参数**，不合法直接返回 false —— 所以**不能**拿无参调用去探测。
- `ctx.systemPrompt.section({name, order, text})` —— 注册一段系统提示词；`text` 是 `string | ((context) => string)`，每次组装时求值，`context` 里带当前组装的 `scope`。
- `ctx.get(name, strict)` —— cordis 的按名取服务，**不需要 inject**（本仓库 `delegate/` 模块也这么取 tools 服务）。

## 6. 未观测项

- **未观测**：`agent/created` 触发时该 agent 的 scope 是否已经能解析出呈现模式（契约上 setup 完成先于 `agent/created`，依据同形但未在本仓库实测）；量法：装好后在新 Adg 会话里看系统提示词有没有这一段，没有就查 dsh 日志里 `agent/created` 的时序。
- **未观测**：子代理的 scope 是不是同样被判成 PTC 呈现（子代理由 `delegate` 现给工具面，呈现模式沿 scope 链继承）；量法：装好后派一个子代理，看它的系统提示词里**有没有**「## PTC 并行执行（一次 run_code 里多做）」段。
- **未观测**：现算清单里的"可并发 / 独占"两列与平台**当前**版本的并发安全声明是否逐项一致；量法：在会话里让模型读一次自己的系统提示词，对照 dsh-tools 里各工具的 `isConcurrencySafe` 声明逐项核。
- **未观测**：`tools.view(scope)` 在 dsh 升级后是否还留在同一个位置（类型声明里它是 `private`，只是运行时可用）；量法：升级 dsh 后跑本模块的单测（L 系列覆盖了这条链路），并在真会话里确认清单非空。
- **未观测**：模型读完这段话之后**实际**并行发子调用的比例变化；量法：同一类任务在装/不装本插件的两种会话里各跑若干次，数一轮 `run_code` 里发出的无依赖子调用个数。

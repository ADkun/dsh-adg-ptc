---
title: preset — 测试与验证
owner: Adg preset 维护者
status: current
last_reviewed: 2026-10-15
---

# preset 模块测试指南

本模块的验证分四层：**静态自检**（源文本）、**产物自检**（生成物）、**真实挂载**（运行期注册与委派）、**人工 review**（脚本看不见的语义）。四层缺一不可 —— 静态自检是逐行文本扫描器，不是 YAML 解析器，证明不了挂载。

## 用例总表

**读数是当场读数，不作锚**：下面所有判据都可以当场跑出来；跑出来的通过/警告条数、字节数、行坐标只属于那一次运行，别抄进文档。

| 用例ID | 对象 | 断言内容 | 对应不变量/迁移 | 载体 |
|---|---|---|---|---|
| PV1 | `preset/` 源文本 | `node tools/check-preset.mjs` 退出 0；ERROR 的含义只有一个 —— 这次委派必然抛错 | `drafted → validated` | `[机检]` 命令 |
| PV2 | `tools/check-preset.mjs` 的定位 | 它只 import `node:fs` / `node:path` / `node:url`，且不提 `ctx.load` / `agentPresets` / `compositionInventory` —— 它是纯文本扫描器，不得被当成挂载证明 | I1 | `[机检]` 源码检索 |
| PV3 | WARN 的归属 | 每条 WARN 都对应一个**条件性注册**的工具名（`bash` / `read_image` / `subagent_codex` / `subagent_claude_code`）、"口径上不需要"的写法（委派行 `allow` 或 `delegate` 的 `tools` 里的 `skill`），或唯一委派行**刻意不写 `toolFilter`** 这一当下的形态（能力面由 `delegate` 的 `tools` 逐次给）。要坐标就当场跑脚本读它自己的输出 | I9 / I15 | `[机检]` + `[评]` |
| PV4 | 生成物的源同步 | 重跑生成器后，产物的 `plugins:` 段与源文件逐行一致（只差一层缩进）；四个稳定落点的文件与对应的 `bundle/adg-*` 逐字节一致 | I3 / `validated → deployed` | `[机检]` |
| PV5 | 构建期注入（源侧） | 手写 `compress` / `decompress` / `search_context` / `acp_status` / `acp_cache` / `save_token_expand` 中任一个 ⇒ 退出 1，并指回对应的生成旗标 | I9 / R9 | `[机检]` |
| PV6 | 构建期注入（产物侧） | 四种味道各跑一次 `node tools/check-bundle-flavor.mjs <那份文件> <味道键>` ⇒ 退出 0：该在的全在、不该在的一个都没有、`acp_cache` 出现即错、`compaction-basic` 的 `auto` 只在 bili 味道里为 `false` | I3 / R9 | `[机检]` |
| PV7 | 味道判定的反例 | 把 bili 产物按 plain 断言、把 plain 产物按 save-token 断言都 ⇒ 退出 1；味道键写错（如 `bili-save-token`）⇒ 退出 2「未知的味道键」 | `validated → deployed` | `[机检]` |
| PV8 | 落点味道 | `install.*` 第 4b-1 步断言的是**实际链接到的那一份**的味道（`node_modules/dsh-adg-ptc` 指向哪个稳定目录），判据不能是"包在不在" | `deployed → mounted` | `[机检]` |
| PV9 | 包名核对 | composition 里每个 `@deepseek-ai/*` 包名都对着当前安装存在；用旧名会让 `agentPresets.resolve('adg-ptc').broken` 非空（报 `… never started`） | I7 | `[人]` 真实挂载 |
| EV1 | 委派行的 `config.toolName` | 全文件唯一；active 行里恰好一条 `toolName: agent`（唯一委派入口，`provider: spawn` + `backgroundMode: continuable` 对它是硬要求）；重复报 `toolName "X" 重复…每个委派工具名必须全局唯一`，缺失报 `缺少 toolName` | I8 | `[机检]` |
| EV2 | 工具面的合法名 | 委派行 `allow` 里的未注册名报 `allow 里的 "X" 不是本组合注册过的工具名——restrict() 会抛 "names unknown global tool"`；合法集来自脚本内 `KNOWN_TOOLS`，条件性注册名与调度者专属名只给 WARN；经 `delegate` 的 `tools` 点名的未知名由插件剔除后逐条写进 `tools_note`，`run_code` 当场抛错 | I9 / R8 | `[机检]` + `[人]` |
| EV3 | 工具面语义 | 把 `agent` / `delegate` / `set_child_permission` 写进委派行 `allow` ⇒ WARN（策略越界）；把 `workflow` / `ralph` 写进 `allow` ⇒ ERROR（这两个名字不在 composition 的注册面里 ⇒ `names unknown global tool ...`）；在 `delegate` 的 `tools` 里点名 `agent` / `delegate` / `workflow` / `ralph` / `set_child_permission` / `ask_user_question` ⇒ 都不进子代理工具面（`BUILTIN_DENY`）；点名 `ask_user` ⇒ 进（它是子代理唯一的提问通道，出现在 `BUILTIN_DENY` 里即 ERROR）；点名 `notify_user` ⇒ 进 | I10 / I16 / I17 / R5 / R12 | `[机检]` + `[评]` |
| EV4 | 新增已注册工具 | 新工具注册后忘了同步 `KNOWN_TOOLS` 会误报 ERROR（改名即可修）；反向的"该报没报"没有自动门，只能人工比对 | I9 | `[评]` |
| EV5 | `backgroundMode` | 委派行不是 `continuable` ⇒ WARN；唯一委派入口那条不是 `continuable` ⇒ ERROR | I11 | `[机检]` |
| EV6 | `maxDepth` | 交付前检索 `maxDepth`：委派行里出现即违规（当前唯一命中应是两条 disabled 行的 `maxDepth: provider-managed`）；`delegate` 也不给子代理传 `maxDepth` | I12 | `[机检]` + `[评]` |
| EV7 | jobs 三件套 | 给了 `pwsh` 的每一次委派必须同时给 `job_list` / `job_output` / `job_kill`（落在 `delegate` 的 `tools` 上） | I14 | `[机检]` + `[评]` |
| EV8 | 工具面不写 `skill` | 委派行 `allow` 或 `delegate` 的 `tools` 里出现 `skill` ⇒ WARN；需要技能时由调度者给技能文件的绝对路径 +「先 read 该文件再动手」，不内联技能正文 | I15 | `[机检]` + `[评]` |
| SV1 | 名册 ↔ 委派行 | 委派行加了但名册没同步报 `调度名册里没有 agent_x…`；名册提到但没有委派行报 `调度名册提到 agent_x，但没有对应的委派行…`；找不到 prefix 块报 `没找到顶部 persona 的 prefix: \|- block` | I20 / `mounted → live` | `[机检]` |
| SV2 | 名册语义 | 名册那句"只有一个通用子代理 `agent`，它干什么、能用哪些工具全看你这次委派写什么"与 `delegate` 的契约对得上：**没有固定岗位、没有专家 persona 可对照**，所以这条不再逐个岗位核对，只核"名册没有把能力面写成固定名册" | I20 | `[评]` |
| SV3 | 两个锚段在位 | `## 约束` 的 12 个顶级 `【…】` 段（全文 21 个 `【…】` 标记里，【目标】/【要干什么】/【不要干什么】/【验收标准】是「【拆解立目标】」段的子项，不是顶级段；【思考框架闸门】曾短暂在位，已由插件 `adg-skill-inject` 取代——persona 里**不该**再出现它）、`## 验收标准` 的验收判据那一段与 `## 回复内容` 的交付纪律段都还在。**没有脚本查这三个锚段**（`tools/check-preset.mjs` 是逐行文本扫描器，只扫委派行与 persona 段名），所以本用例靠对抗评审：逐段对照 `preset/agent.cordis.yml` 调度 persona 的原文，判有没有段被删、被合并或被改写 | I22 | `[评]` |
| SV4 | 锚段语义 | 逐段读：不得出现预算 / 字数 / 次数上限；不得被改写成"先做 A 再做 B"的分步流程；不得删掉问用户、挂号、digest、接续、验收判据任何一条 | I23 / R4 / R14–R17 | `[评]` |
| SV5 | 提问纪律 | `ask_user_question` 不进任何一次 `delegate` 的 `tools`（它同样在 `BUILTIN_DENY` 里）；给了 `ask_user` 的子代理撞上必须问人的岔路时**直接问用户**（卡片落在调度者与用户对话的那个会话里，答复回到它手上），不再走"停手 → 等调度者转达"；调度侧仍保留"不确定就问、一次问齐、不设次数上限" | I17 / R12 / R20 | `[机检]` + `[评]` |
| SV6 | 权限闸门 | 调度侧保留"先确认文件策略、受限时先问用户"的措辞；浏览器那一段委派口径保留失败签名与"停手 + 如实报出"；两处都不得写成"权限强制"；切换权限后只能走 `set_child_permission` 或重派，不得写成"旧子代理自动就能用" | R10 / R11 | `[评]` |
| SV7 | 登录入口 | 不存在"预先禁止登录"或把"请用户手动登录"写成失败的措辞 | R13 | `[评]` |
| SV8 | 浏览器模式 | 保留"模式由**调度者**在派发前判定并写进委派"（确定不需要登录 / 验证码 → 无头；确定需要 → 有头；拿不准 → 先无头、真撞上登录墙 / 验证码再换成有头），且不再出现"派发前问用户有头 / 无头、每任务问一次"的措辞；工具层默认 `browser/lib/target.mjs` 的 `MODE_DEFAULT = 'headless'` 不得被改 | R19 | `[评]` + `[机检]` |
| SV9 | 浏览器命令行契约 | 委派文本里给子代理的命令名与输出行（`profile` / `launch` / `status` / `text` / `eval` / `shot` / `close`、`STATE=` / `PORT=` / `PROFILE=`）与 `browser/lib/` 的实现一致。**没有脚本读 persona 文本**，所以本用例靠对抗评审：评审者当场跑 `cd browser && node cli.mjs help` 读出实际命令清单，再拿 persona 里出现的每个命令名与输出行逐项对照，多一个少一个都不算过 | R14 | `[评]` |
| SV10 | 委派一律后台 | 不存在"阻塞等待某个委派"的措辞，也不存在"用 `pwsh` 睡眠 / 轮询等委派跑完"的措辞（派完即结束本轮） | R18 | `[评]` |
| SV11 | 人工介入那一段 | 子代理侧的人工介入默认走 `ask_user` 直问；`notify_user` 是 `BUILTIN_DENY` 之外**刻意可给**的**单向补充**，不是替代 —— `ask_user` 走不通时子代理才退回"喊一声 + 把未决问题写进最终结果报回调度者"（调度 persona 里已不再有"转达"这段，改由技能与 `notify/design.md` 承担） | R20 | `[评]` |
| SV12 | `suffix` 不在位 | 组合文本里 `- id: persona` 的 `config` 内**没有** `suffix:` 字段行：0.2.1-rc.2 起 `{{cwd}}` 不再是注册的 prompt 变量（只有 `provider` / `model`），persona suffix section 走插值路径会抛 `unknown prompt variable "{{cwd}}"`；工作目录由 `working-directory:current` 运行时上下文提供（`interpolate:false`） | 「SchedulerPersona」 | `[机检]` + `[评]` |
| SV13 | plan mode 不挂进 preset | `preset/agent.cordis.yml` 里没有 `planning` 组、没有 `@deepseek-ai/dsh-plan-mode` 行（摘掉处留一段中文注释，写明两条理由与加回方法）；评审时顺带确认会话里的 `/plan` 与 `exit_plan_mode` 来自 host 组合而不是本 preset —— 从本 preset 拿掉它不影响它们存在，只影响它们由谁提供 | R27 | `[评]` |
| BV1 | 真实挂载 | `agentPresets.resolve('adg-ptc')` 的 `.broken` 为空，且名册与委派行的形状符合根 `README.md` 的「真实挂载验证」一节的判据 | `deployed → mounted` / I1 / I2 | `[人]` 真实挂载 |
| BV2 | 真实生效 | 改一个可观察点（例如某次委派经 `delegate` 的 `tools` 少给一个工具），重启 dsh 后在新对话里委派一次，子代理报出的工具目录随之变化 | I2 / I18 | `[人]` 真实委派 |
| BV3 | 成本结论 | 任何成本结论都附改动前后各一次的会话审计数字，且比较看比例与量级 | I4 / I6 | `[人]` 会话审计 |
| DV1 | `delegate` 的动态工具面 | 调度者给的 `tools` 就是子代理那次可见的工具目录；未知名剔除后逐条落在 `tools_note`；`run_code` 当场抛错 | I9 / I16 / I18 | `[人]` 真实委派 |
| DV2 | `BUILTIN_DENY` 的下发 | 在 `tools` 里点名 `agent` / `delegate` / `workflow` / `ralph` / `set_child_permission` / `ask_user_question` ⇒ 都不进子代理工具面；点名 `ask_user` ⇒ 进（它是子代理唯一的提问通道，出现在 `BUILTIN_DENY` 里即 ERROR）；点名 `notify_user` ⇒ 进 | I16 / I17 / R5 / R12 | `[机检]` `cd delegate && node --test test` + `[人]` 真实委派 |
| NV1 | 未观测项的写法 | 每条未观测都写成一行 `**未观测**：<问题>；量法：<怎么测>`；不得写成实测，也不得写成"不可观测" | 全模块 | `[评]` |

**未观测**：`check-preset.mjs` 对纯文本要求的假绿范围有多大；量法：故意改坏一个纯文本锚点（删一段纪律、删一个 `notify_user`），看脚本是否仍然退出 0 —— 它只应拦"这次委派必然抛错"的错误，文本语义靠本节的人工 review 项。

**未观测**：`delegate` 的动态工具面是否真的落成子代理那次的可见工具目录（DV1 / DV2 的判据都还没量过）；量法：派一次子代理，在 `tools` 里混入一个未注册名与 `agent`，读返回的 `tools` / `tools_note`，再让子代理报一次它自己的工具目录。

## 迁移矩阵

行＝当前状态，列＝事件，格＝迁移后的状态（「—」＝不动，「非法」＝不允许，括号里是拒绝理由）。状态与判据见 [`design.md`](design.md) 的「PresetRevision」。

| 当前状态 \ 事件 | 改源文件 | 跑 `check-preset.mjs` 绿 | 跑 `check-preset.mjs` 红 | 重跑生成 + `install.*` | 重启 dsh + 新对话 | 重启前宣称已生效 |
|---|---|---|---|---|---|---|
| `drafted` | — | `validated` | `drafted`（先修 ERROR） | 非法（没自检就装） | 非法（装的是旧文本） | **禁止** |
| `validated` | `drafted` | — | `drafted` | `deployed` | 非法（等于回到 drafted） | **禁止** |
| `deployed` | `drafted` | — | `drafted` | — | `mounted` | **禁止** |
| `mounted` | `drafted` | — | `drafted` | `deployed`（换味道另说） | `live` | **禁止** |
| `live` | `drafted`（只影响下一次新对话） | — | `drafted` | `deployed` | `live`（已锁定的会话不换组合） | **禁止** |

**它不是什么**：`validated` 不等于 `deployed`（文件绿了但没生成、没安装）；`deployed` 不等于 `mounted`（落点了但注册失败）；`mounted` 不等于"已开的会话也换了"（预设选择在会话起步时锁定）。

## 消费方契约测试

改本模块的源文件格式时，下面的消费方会一起坏 —— 它们的依赖点就是本模块的对外契约。

| 消费方 | 它依赖本模块的什么 | 改坏了会怎样 | 怎么验 |
|---|---|---|---|
| `tools/check-preset.mjs` | 委派行必须落在「4 空格 + `- id: agent…`」的形状上；块条目以 `- ` 开头；`KNOWN_TOOLS` / `EXPECTED_ROWS` / persona 段名 | 委派行被漏扫或误判 ⇒ 假绿（比误报更危险） | 改完跑 EV1–EV8 对应的用例，并抽查一条真实委派行是否被扫到 |
| `tools/gen-preset-bundle.mjs` | `preset/preset.yml` 的顶层标量 `name` / `order`；`agent.cordis.yml` 顶层是条目列表 | 生成器 exit 1（报「`preset/preset.yml` 里没有可用的 `name:`」或「order 不是数字」） | 改 `preset.yml` 后重跑生成器，判据 exit 0 |
| `tools/check-bundle-flavor.mjs` | 味道键与注入清单（唯一来源 `tools/flavors.mjs`） | 断言假绿或误报 | 跑 PV6 / PV7 |
| `install.ps1` / `install.sh` 与 `dsh.profile.bundles` | 四个稳定落点目录名（由 `tools/flavors.mjs` 的 `dirNameFor(key)` 推导，**不要写死**）与注册行里的 preset id `adg`；外加 `adg-delegate` 的三格（node_modules 真目录 + dependencies + `dsh.profile.bundles`） | 装上了但 profile 拿不到（光有依赖不算选中）；只装了 bundle 却没装 `adg-delegate` ⇒ 调度者手上没有任何委派工具 | 跑 PV8；再看该 profile 的 `dsh.profile.bundles` 是否含两个包名，并核对 `install.*` 4c-5 的断言 |
| `delegate/` 子插件 | `delegate` 的工具名与参数（`description` / `prompt` / `tools` / `persona` / `background`）、`ask_user` 的工具名与它的提问语义（owner＝派它的调度者）、`BUILTIN_DENY`（含"`ask_user` 不在里面"这条 `MUST_BE_AVAILABLE_TO_CHILDREN` 断言）、`tools_note` 的形状 | 调度 persona 教出插件不认的用法，或点名的工具静默失效 | `cd delegate && node --test test` + 一次真实委派（DV1 / DV2） |
| `notify/` 子插件 | 委派时经 `delegate` 的 `tools` 给子代理的 `notify_user`（人工介入的**单向补充**；默认那条问人通道是 `adg-delegate` 的 `ask_user`，见上一行） | 插件没同时装 ⇒ 每次委派抛 `names unknown global tool "notify_user"` | `cd notify && node --test test` + 一次真实委派让子代理调它 |
| `skills/adg-delegation/SKILL.md` | 委派能力 / 工具面映射的形状与自检命令 | 手册教出坏映射 | 按手册改一次委派能力，跑 PV1 与 SV1 |

## 人工 review 项

**脚本的盲区**（逐行文本扫描器抓不到的坏，必须人读）：

| 盲区 | 它会漏掉什么 |
|---|---|
| 同一行写两个键（`- id: agent-x, toolName: agent_x`） | 整行被当成一个条目，字段都没被校验 |
| YAML 锚点 / 别名 / merge key | 展开后的真实取值看不见 |
| flow 风格（`allow: [read, write]`） | 名单被当成一个字符串，逐个名字的校验失效 |
| Tab 缩进 | 层级判定失准，整块可能被跳过 |
| 多文档流（`---`） | 只扫到第一份文档 |
| persona 与工具面语义不匹配 | 要求子代理做那次 `tools` 之外的事（persona 过短只给 WARN，仍可能语义错） |
| 非标准位置的同名 id | 只认「4 空格 + `- id: agent…`」，别处出现的同名行不被扫 |
| 委派行内部空行后写的内容 | 块边界被切断，后半段不受检 |
| `preset/preset.yml` 完全不看 | 兜底在生成器 exit 1 |

**不许由"自检绿"单独支撑的结论**：preset 能挂载 / 已生效 / 子代理真的能调某工具 / 成本真的降了 / persona 语义正确 / 味道注入正确 / 老会话也换了组合。它唯一能单独支撑的结论是：**源文本里没有被发现"必然抛错"的形状**。

## 怎么重新测量

成本与步数这类结论**必须改动前后各量一次**，且比较看**比例与量级**（语料是活的，两次跑不会一致；绝对值还受"未缓存输入 / 输出 / cache-read"口径差影响）：

1. 读 `${DSH_HOME:-~/.dsh}/sessions` 下的 `session.v*.jsonl.zstd`（注意：它是**多帧 zstd 拼接**，要按 magic `28 b5 2f fd` 切帧后逐帧解；只解第一帧会丢掉大半记录）。
2. 统计口径：按 preset 分组统计请求数与 token 三分类（未缓存输入 / 输出 / cache-read），报告的落点与本次读数写在同一处（本项目**不带**审计脚本，自己按这个口径写一个一次性的即可）。
3. 判据：改动后的比例与量级要好于改动前；拿不出前后对比数字时**不许**宣称省了成本，也不许改体积旋钮。

**未观测**：截断后能不能就地续跑同一个子代理；量法：造一次输出上限截断，然后用 `resume({ resumeSessionId: childId })` 接回同一个子代理，看它是否带着截断前的上下文继续。

**未观测**：重启 dsh 后 `notify_user` 是否真的出现在子代理工具面、子代理是否在正确时机主动调用它、toast 的人眼可见形态；量法：重启后在新会话里委派一次（委派时把 `notify_user` 给它）让它调一次，并核对转录里的调用时点。

**未观测**：`ask_user` 那条登录墙端到端链路是否真的走通（子代理撞墙 → 用 `ask_user` 问用户 → 用户在有头窗口里登录 → 答复回到子代理 → 子代理自己复核登录态 → 抓到登录后内容）；量法：在真站点登录墙前派一次带 `ask_user` 的浏览器委派，在转写里检索它这一轮调的是 `ask_user` 还是 `notify_user`，并核对它拿到答复后有没有自己复核一次登录态（调度者侧的登录口径见【浏览器：模式】与【不确定就问】）。

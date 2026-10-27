# AGENTS.md — dsh-adg-ptc

Adg PTC 模式：一份 DSH agent preset（**一个调度智能体 + 它按需派出的通用子代理** —— 子代理的目标、边界、验收标准与工具面都在委派那一刻由调度者经第一方插件工具 `delegate` 现给，**没有固定专家名册**），外加两个本机操作工具链（`browser/`：默认无头的 Chromium 系浏览器驱动 + 最小 CDP 驱动；`desktop/`：零依赖的 Windows 桌面操控 CLI —— 截屏 / 窗口与 UIA 枚举 / SendInput 合成输入 / 语义 invoke，**要真正驱动普通用户窗口必须跑在完全权限会话里**）、七个仓库内部第一方子插件（`notify/`：包名 `adg-notify`、注册工具 `notify_user`，Windows toast 提醒；`permission/`：包名 `adg-permission`、注册工具 `set_child_permission`，让调度者把自己派出去、却还停在旧文件权限的子代理改到新权限 —— 只有调度者能用，两条守卫（血缘 / 不得超过调用方）在代码里；`delegate/`：包名 `adg-delegate`、注册工具 `delegate`，**唯一的委派入口** —— 只有调度者能用，每次委派现给那一个子代理的目标与工具面；`settings/`：包名 `adg-settings`，**不注册任何工具**，在「设置」里注册一页 **Adg 设置**（登记表驱动的框架，现承载**七条登记**、四种 kind（boolean / string / integer / enum）：通知三项 + 思考框架注入四项 —— 注入开关 / **注入哪个框架**（enum，`'thinking'` | `'execution'`，默认执行框架）/ 是否也注入子代理（默认关）/ 自定义注入正文，写出 `adg-settings.json`）；`skill-inject/`：包名 `adg-skill-inject`，**不注册任何工具**，把框架正文注入 Adg 调度者的系统提示词 —— 非 `adg-ptc` preset 一律不注入；注入**哪一份**由设置键 `skillInjectFramework` 在两份技能文件（`thinking-framework` / `execution-framework`）之间选（**默认执行框架**），子代理是否也注入由设置键 `skillInjectSubagent` 决定（默认关 ＝ 与改动前一致：只注入调度者）；`source-guard/`：包名 `adg-source-guard`，**不注册任何工具**，在全局层改写顶层 `run_code` 的结果正文 —— 成功时补一行当次执行意图（`已执行代码：<description>`，那句「源码未随本结果重复」的说明句默认关闭），失败时逐字不动；`ptc-parallel/`：包名 `adg-ptc-parallel`，**不注册任何工具**，在全局层给 PTC 呈现的 agent（调度者与子代理都算）注册一段「PTC 并行执行」的系统提示词 —— 末尾那份可并发/独占清单每次组装提示词时现算，不写死工具名）、八份用户技能（`skills/`；其中 `thinking-framework` 与 `execution-framework` 两份的正文由 `adg-skill-inject` 按设置键选一份注入调度者系统提示词，出厂默认执行框架）、一个静态自检脚本与一个把 preset 源文件生成成 bundle 的构建脚本、两个安装脚本。

本文件是**给改这个仓库的人/agent 看的路由入口**：只写常驻内容（命令、红线、模块地图、质量门），设计细节一律下沉到模块文档。**给人看的项目总览与安装/使用说明在 `README.md`**（改任何东西之前先读它对应的小节）。

## 命令

零运行时依赖；只要求 Node（`browser/package.json`、`desktop/package.json`、`notify/package.json`、`permission/package.json`、`delegate/package.json`、`skill-inject/package.json`、`source-guard/package.json` 与 `ptc-parallel/package.json` 都声明 `>= 22`）。仓库根没有 `package.json`、没有 monorepo 构建、没有 lint 配置。

```sh
# preset 静态自检（零依赖，逐行文本扫描）：exit 0 通过 / 1 有 ERROR / 2 读不到目标文件。
# 它读的就是仓库里的 preset/agent.cordis.yml —— 那是唯一真相源，没有"已安装的第二份"可以传路径。
node tools/check-preset.mjs
# 生成 preset bundle（产物不入库，落在被 .gitignore 排除的 bundle/adg-<味道>/；install.* 每次按探测结果重跑）
# 不带旗标 = plain；不传位置参数时才落到缺省目录 bundle/adg-ptc/（install.* 每次都显式传位置参数）
node tools/gen-preset-bundle.mjs

# 其余命令按模块分家：各模块的单元测试、四种味道的产物自检、探测与味道映射、首装/重装都在它自己那份
# `AGENTS.md` 的「命令」节 —— 生成 / 味道自检 / 探测 / `install.*` 见 `preset/AGENTS.md`，生成器与校验器
# 的全部命令与退出码见 `tools/AGENTS.md`（含四种味道的生成 + 断言四条）；人向的安装说明见 `README.md`。
```

**本仓库没有"一条命令跑完全部"的入口**：这些命令彼此独立，各自覆盖一层。验收方式是这些命令 + 一次真实挂载，见「Quality Gates」。

## 关键红线

改任何文件前先读本节；每条都只写结论、理由与载体（**违反即返工**）。

1. **禁止加回通用 `subagent` / `subagent_fork` 委派行。** 子代理继承父代理的整套 composition，一旦存在通用行，子代理就能绕过自己那次的能力面再开一个不受限的子代理；`allow` 白名单是第二道保险。载体：`tools/check-preset.mjs`。
2. **`delegate` 的 `tools`（以及委派行若写的 `toolFilter`）是真实的能力边界，不是提示。** 子代理那次可见的工具目录恰好等于它（连 preset 自己注册的工具一起被裁；`toolFilter` 是交集、只减不增），所以禁止在 prompt / persona 里要求它做那次工具面之外的事，也禁止承诺"子代理之间默认能互相转交"。载体：`tools/check-preset.mjs` 的名字校验 + 一次真实委派。
3. **禁止给承载体积旋钮的三行写回覆盖值**（`compaction-basic` / `tool-result-pruner` / `tool-web`）。本 preset 一律用插件出厂默认值 —— 截断工具结果会把工具**已经取到**的事实切掉，模型只能重取、换查询或拿残缺证据下结论，三者都比不裁更贵。载体：`tools/check-preset.mjs`。
4. **禁止在 persona 里写 token／读取预算**（"结论控制在 N 字符内""委派 prompt 自带读取预算"之类）；理由同上一条：那是把子代理的注意力从"做对"挪到"少写"。**禁止删掉或改写调度 persona 的 `## 约束`、`## 验收标准` 与 `## 回复内容`**：`## 约束` 的锚点是那十二个 `【…】` 段（12 个顶级段；原【需要用户本人的事】段已刻意删除，其中两条必要口径并入【浏览器：模式】与【不确定就问】；其中「【拆解立目标】」内含【目标】/【要干什么】/【不要干什么】/【验收标准】四个子项），`## 验收标准` 只留验收判据那一段，交付纪律独立成 `## 回复内容`（以加粗的「面向用户的输出以人类可读性为第一原则」开头，范围＝直接答复 + 文档等一切用户看得到的成果），归口 `preset/design.md` 的「核心数据模型」里 SchedulerPersona 一节，原文在 `preset/agent.cordis.yml` 的调度 persona。在位要点：材料重叠的任务合并成一次委派（含浏览器那半 —— 同一份信息默认只在一个站点取）、同一实体的后续任务接给已经读过它的那个子代理、跨子代理传递大材料走 digest、派发前过必要性闸门并给未纳入的旁路挂号、交付端按验收判据逐条判定且未达标不许静默交付、提问不设次数上限。它们约束"派给谁 / 派几次 / 材料怎么中转 / 写下来的东西怎么组织"，不是"单个子代理能读多少、能写多少" —— **不得改写成预算或字数上限**。**往里加话一律从简**：persona 是每次请求都原样重发的固定前缀，**不可压缩** —— 每多一句都是永久成本，所以判据是"再删一句会不会损失约束力"，不是"要不要写全"；**禁止长篇大论**（铺陈理由、复述别处已有的规定、把一句话能说清的事写成一段）。载体：`tools/check-preset.mjs` 的 persona 段存在性检查 + `preset/design.md`；简洁性只能人工 review。
4b. **禁止把 `agent` / `delegate` / `workflow` / `ralph` / `set_child_permission` / `ask_user_question` 从 `adg-delegate` 的 `BUILTIN_DENY` 里去掉或放宽，也禁止经 `delegate` 的 `tools` 把它们发给子代理。** 子代理能再委派就破坏一跳可达的链路（孙代理对调度者不可见、不可 steer），并让承载编排约束的那几段 `## 约束` 整段失效。`ask_user` **不在**这条名单里（`adg-delegate` 注册的第二个工具，子代理唯一的提问通道，owner 是派它的那个调度者）—— 禁止把它加进 `BUILTIN_DENY`，也禁止改用平台的 `ask_user_question` 让子代理问人。载体：`tools/check-preset.mjs`（`MUST_BE_AVAILABLE_TO_CHILDREN` 判 `ask_user` 是否被 deny）+ `cd delegate && node --test test`。
5. **禁止给任何请求设 `maxTokens` / `agentOptions` / `reasoningEffort`。** 输出只占账单很小一份，压它损伤质量；`reasoningEffort` 在手工声明的路由上会让每次委派直接报 `UNSUPPORTED_REASONING_EFFORT`。载体：`tools/check-preset.mjs`。
6. **禁止给委派行写 `maxDepth`，也不许 `delegate` 给子代理传 `maxDepth`。** 写 `0` 会让每一次委派以 `subagent depth 1 exceeds maxDepth 0` 失败（一跳可达靠内置 deny 加上平台 `maxDepth` 默认 `1`）。载体：`tools/check-preset.mjs`。
7. **`allow` 里只能写已注册的工具名。** `dsh-tools` 的 `restrict()` 遇到未知名直接抛 `names unknown global tool ...`，那一次委派当场失败；合法名单见 `tools/design.md`。载体：`tools/check-preset.mjs` 的 `KNOWN_TOOLS`。
8. **`install.ps1` 必须保留 UTF-8 BOM。** Windows PowerShell 5.1 没有 BOM 时会按系统 ANSI 代码页读脚本，中文乱码并直接解析失败；编辑工具会**悄悄**去掉它，改完单独确认前三个字节仍是 `EF BB BF`。载体：改完手动核前三个字节。
9. **`browser/` 工具链的边界**：禁止引入第三方依赖（`playwright` / `puppeteer` / `ws`）；禁止把 profile 放进会话工作区、或写死任何本机绝对路径；禁止代填账号密码、读取 profile 的 cookie 库、验证码识别与指纹伪装。来源与不变量见 `browser/design.md` 与 `browser/AGENTS.md` 的「红线」一节。载体：`cd browser && node --test test` + 人工 review。
10. **构建期注入组的名字只能由构建期注入，禁止手写进 `preset/agent.cordis.yml`。** 目前两组（清单只有一份，在 `tools/flavors.mjs` 的 `INJECTION_GROUPS`）：billion-context 的 `compress` / `decompress` / `search_context` / `acp_status`（同属该插件的 `acp_cache` 故意不注入），以及 save-token 的 `save_token_expand`。两头都是缺陷：**不给** —— 那两个插件的指令与通知只看自己的 config、不看这个请求有没有那些工具，子代理会收到"去调某个工具"却没有工具可调；**给了但目标 profile 没装那个插件** —— 名字不存在，撞红线 7，每次委派当场抛 `names unknown global tool …`。所以口径是"源文件中立、生成物按探测决定"。载体：`tools/check-preset.mjs`（手写即 ERROR）+ 四条 `tools/check-bundle-flavor.mjs` 断言。

## 生效方式（口径不同，别承诺错）

| 改了什么 | 生效口径 | 复核指针 |
|---|---|---|
| `preset/` 任何文件（含改委派能力 / 工具面映射） | 重新生成 + 重装 bundle + **重启 dsh** + 在**新对话**里选「Adg PTC 模式」（前三步 `install.*` 会自动做） | `README.md` 的「真实挂载验证」一节做一次**真实挂载** —— 静态自检证明不了挂载 |
| 只切换注入组 / 味道（同一份源文件分四种味道、四个稳定落点） | 重新生成 + 重装 bundle + **重启 dsh** + 新会话 | 先看该 profile 的 `node_modules/dsh-adg-ptc` 链接的是哪一份稳定目录，再用 `tools/check-bundle-flavor.mjs <那份文件> <味道键>` 断言那一份（`install.*` 装完已经这么断言） |
| `notify/` 任何文件 | 重装子插件 + **重启 dsh** + 新会话（稳定副本 + `dsh plugin --profile <p> add` 的步骤号见 `notify/AGENTS.md` 的「生效方式」） | `cd notify && node --test test`；再在新会话里把 `notify_user` 写进那次委派的 `tools`、让它真调一次 |
| `permission/` 任何文件 | 重装子插件 + **重启 dsh** + 新会话（步骤号见 `permission/AGENTS.md` 的「生效方式」） | `cd permission && node --test test`；再在新会话里对任一**已经派出去**的子代理调一次 `set_child_permission`（运行中期望 `applied=live`、已停下期望 `applied=persisted`；把权限改到超过自己的那次期望被拒） |
| `skill-inject/` 任何文件 | 重装子插件 + **重启 dsh** + **新 Adg 会话**（步骤号见 `install.ps1` / `install.sh` 的 2b-4 / 4c-8 / 4c-9；运行中的旧 agent 不补挂 —— section 在 agent 创建那一刻注册） | `cd skill-inject && node --test test`；再在新 Adg 会话里核对系统提示词出现与下拉选中那份框架一致的段（出厂＝「# 执行框架（execution-framework）」）、派出的子代理系统提示词里默认没有它（`skillInjectSubagent` 默认关；打开后子代理也有，不需重启，判据见 `skill-inject/testing-guide.md` 的 M 系列） |
| `source-guard/` 任何文件 | 重装子插件 + **重启 dsh** + **新 Adg 会话**（步骤号见 `install.ps1` / `install.sh` 的 2b-5 / 4c-10 / 4c-11；运行中的旧会话不补挂 —— 监听器在插件装载那一刻注册） | `cd source-guard && node --test test`；再在新 Adg 会话里跑一次成功的 `run_code`（结果正文应多出一行「已执行代码：<当次 description>」，前缀句默认不出现）与一次失败的 `run_code`（结果正文与未装本插件时逐字相同） |
| `ptc-parallel/` 任何文件 | 重装子插件 + **重启 dsh** + **新会话**（步骤号见 `install.ps1` 的 2b-6 / 4c-12 / 4c-13；运行中的旧 agent 不补挂 —— section 在 agent 创建那一刻注册；子代理的 scope 同样会被判定） | `cd ptc-parallel && node --test test`；再在新 PTC 会话里核对系统提示词出现「## PTC 并行执行（一次 run_code 里多做）」段、派出的子代理系统提示词里**也有**这一段（判据见 `ptc-parallel/testing-guide.md` 的 M 系列） |
| `delegate/` 任何文件 | 重装子插件 + **重启 dsh** + 新会话（装进 profile 的步骤号见本文件「Context Loading」表的 `delegate` 行） | `cd delegate && node --test test`；再在新会话里让调度者用一次 `delegate`（给 `description` / `prompt` 与要拿的工具名），核对返回的 `tools` / `tools_note` 与子代理实际拿到的工具面 |
| composition 里写的 `@deepseek-ai/*` 包名 | 包名会随 dsh 升级**改名**，改完必须真实挂载 | `agentPresets.resolve('adg-ptc')` 的 `.broken` 为空；用旧名会报 `… never started` |
| `browser/` 任何文件 | **重新跑一次 `install.*` 即生效，不用重启** —— 它是用户根下的普通文件，不是 preset 也不是插件 | `node "${DSH_HOME:-~/.dsh}/browser/cli.mjs" profile` |
| `desktop/` 任何文件 | 同 `browser/` 口径：**重跑一次 `install.*` 即生效，不用重启**（用户根下的普通文件）；但真正驱动普通用户窗口的那一次会话必须跑在完全权限（`danger-full-access`）下 —— 受限会话的 Low 完整性级别会被 UIPI 拦下且**静默丢事件**（细节见 `desktop/AGENTS.md` 的「生效方式」节） | `node "${DSH_HOME:-~/.dsh}/desktop/cli.mjs" profile`；注入类命令只认 `CHANGED=true` 与 `CURSOR_LANDED=true` |
| 本仓库任何 `.md` 文档 | 立即生效（只是文件） | 按 `adg-doc-criterion` 技能的质量红线清单自检 |

## Project Map

| 模块 | 一句话职责 | 规则见 |
|---|---|---|
| `preset/` | Adg preset 的定义：调度 persona（`## 你手上的子代理` 名册 + 分派与验收规则）与 `delegation` 组里**唯一一条委派行 `agent`**（行数以 `node tools/check-preset.mjs` 当场报出的为准）；`preset.yml` / `agent.cordis.yml` / `bundle.package.json` 是 **bundle 的源**（生成与落点见 `tools/AGENTS.md` 与本模块「生效方式」） | `preset/AGENTS.md` |
| `tools/` | 六个脚本：`check-preset.mjs`（preset 的零依赖静态校验器，**不是 YAML 解析器**）+ `gen-preset-bundle.mjs`（从 `preset/` 源文件生成 bundle 的构建脚本，**产物不许手改**）+ 味道表 / 探测 / 产物自检；`KNOWN_TOOLS` 是工具名合法名单的唯一来源 | `tools/AGENTS.md` |
| `browser/` | 默认无头的 Chromium 系浏览器驱动（Chrome / Brave / Edge 探测）+ 最小 CDP 驱动（零依赖，唯一入口 `cli.mjs`） | `browser/AGENTS.md` |
| `notify/` | 仓库内部第一方子插件 **`adg-notify`**：注册工具 `notify_user`（单向把状态告诉人，参数与 toast 实现见 `notify/design.md`） | `notify/AGENTS.md` |
| `permission/` | 仓库内部第一方子插件 **`adg-permission`**：注册工具 `set_child_permission`，把一个**已经派出去**的子代理改到新的文件权限（只改 `sandbox/mode`、**不碰审批**，两条守卫在代码里；参数与守卫见 `permission/design.md`） | `permission/AGENTS.md` |
| `delegate/` | 仓库内部第一方子插件 **`adg-delegate`**：注册全局层工具 `delegate`，**唯一的委派入口**（只有调度者拿得到）；每次委派现给子代理目标与工具面（`tools` 语义、`tools_note` 与六个内置 deny 见 `delegate/design.md`），并在建立窗口里往子代理自己的 scope 层放一份不带平台标记的 `send_message` 克隆（影子注册），摘掉平台自动追加的那段续接提示 | `delegate/AGENTS.md` |
| `settings/` | 仓库内部第一方子插件 **`adg-settings`**：在「设置」里注册一页 **Adg 设置**（客户端 + 宿主同源路由 + 设置文件）。**登记表驱动的框架** —— 加一项配置 = 在 `lib/schema.mjs` 的 `FIELDS` 加一条登记 + 客户端 DICT 两条文案（zh/en），宿主与客户端逻辑都不用改；现存七条登记、kind 四种（boolean / string / integer / enum）、两个消费方（通知三项 → `adg-notify`，注入四项 → `adg-skill-inject`：注入开关 / **注入哪个框架**（enum，默认执行框架）/ 是否也注入子代理（默认关）/ 注入正文），键的真相源与「技术类键不许进页面」见 `settings/design.md` | `settings/AGENTS.md` |
| `skill-inject/` | 仓库内部第一方子插件 **`adg-skill-inject`**：把框架正文注入 **Adg 调度者**的系统提示词（不注册任何工具；正文按设置键 `skillInjectFramework` 在 `skills/thinking-framework/SKILL.md` 与 `skills/execution-framework/SKILL.md` 之间选（默认执行框架），也可在设置页换成自定义正文（自定义正文非空时优先、忽略框架选择），输入框的「超思」开关控制开关；按 preset 身份逐 agent 判定（**注册层**只看 preset 身份，非 `adg-ptc` 不注册；子代理也注册），**内容层**再由设置键 `skillInjectSubagent` 决定给不给子代理（默认关 ＝ 只注入调度者）；判据与降级见 `skill-inject/design.md`） | `skill-inject/AGENTS.md` |
| `desktop/` | 零依赖的 **Windows 桌面操控 CLI**（唯一入口 `cli.mjs` + 随附 PowerShell 桥 `scripts/bridge.ps1`）：截屏 / 窗口与 UIA 枚举 / SendInput 合成输入 / 语义 invoke。**Windows 专用**；注入类命令的成功判据是可观测差异，不是 `SendInput` 的返回值（命令清单与判据见 `desktop/design.md`） | `desktop/AGENTS.md` |
| `source-guard/` | 仓库内部第一方子插件 **`adg-source-guard`**：改写**顶层 `run_code`** 的结果正文（不注册任何工具、不改 `tool/call` 的入参源码；成功时补一行当次执行意图（`已执行代码：<description>`，那句「源码未随本结果重复」的说明句默认关闭），失败时逐字不动；挂载点 `tools/post-execute` 与边界见 `source-guard/design.md`） | `source-guard/AGENTS.md` |
| `ptc-parallel/` | 仓库内部第一方子插件 **`adg-ptc-parallel`**：给 **PTC 呈现的 agent**（调度者与子代理都算）注入一段「PTC 并行执行」的系统提示词（不注册任何工具；按 scope 的呈现模式逐 agent 判定，末尾那份可并发/独占清单每次组装时现算、不写死工具名；判据与不变量见 `ptc-parallel/design.md`） | `ptc-parallel/AGENTS.md` |

**新建模块的登记义务**：在 Project Map 加一行（唯一的登记点），并按「三信号」判断要不要给新模块建 `AGENTS.md`（有独立命令 / 有模块特有红线 / 需要跨模块路由，三者有其一方建）。

不给模块 `AGENTS.md` 的（三样信号都没有，建了就是噪音）：`skills/` 下的八份用户技能文档（`adg-delegation` / `adg-browser-use` / `adg-computer-use` / `adg-file-ops` / `adg-grill-me` / `adg-doc-criterion` / `thinking-framework` / `execution-framework`，装到 `${DSH_HOME:-~/.dsh}/skills/` 下，均无独立命令；`thinking-framework` 与 `execution-framework` 两份的正文由 `adg-skill-inject` 按设置键选一份注入调度者系统提示词；`adg-grill-me` 另有 `/adg-grill-me` 这个用户入口）、`install.ps1` / `install.sh`（部署脚本，无模块红线）、仓库根 `README.md` 与 `AGENTS.md`。

## 版本区（文档目录入口）

版本区 = **一批最终文档**，每个治理域各一份当前真相（写法规范按**名字**引用 `adg-doc-criterion` 技能，本仓库不自持写作规范）。**过程件一律住在被 `.gitignore` 排除的临时工作目录 `docs-work/`，不进版本区，任务交付前必须清空到空目录** —— 仓库里只留最终文档，变更史由 git 提交历史承担。确有长期价值的内容，先合并进对应的最终文档，再删原件。

| 文档 | 是什么 |
|---|---|
| `AGENTS.md`（本文件） | 根入口：路由（命令 / 红线 / 生效方式 / 模块地图 / 版本区 / 质量门） |
| `README.md` | 人向总览：项目是什么、怎么装、怎么用、怎么排错 |
| `preset/`、`tools/`、`browser/`、`desktop/`、`notify/`、`permission/`、`delegate/`、`settings/`、`skill-inject/`、`source-guard/`、`ptc-parallel/` 各自的 `AGENTS.md` → `design.md` → `testing-guide.md` | 模块三件套：路由 → 设计（不变量）→ 验证（用例全表与未观测项） |
| `skills/adg-delegation/SKILL.md`（另有 `adg-browser-use` / `adg-computer-use` / `adg-file-ops` / `adg-grill-me` / `adg-doc-criterion` / `thinking-framework` / `execution-framework`） | 八份用户技能：委派能力与工具面映射 / 浏览器 / 桌面 / 文件操作 / 方案压测访谈 / 文档工程师角色规范 / 思考框架、执行框架（这两份的正文由 `adg-skill-inject` 按设置键 `skillInjectFramework` 二选一注入调度者系统提示词，技能文件是正文的事实源） |
| `docs-work/`（**临时工作目录，不在版本区**） | 过程件（changelog / handoff / pending / 工作稿 / 证据快照）；滚动更新、可被清理，任务交付前清空 |

模块 `AGENTS.md` 的「版本区」一节指回本表，只登记本模块那三份，不另抄一份清单。

### 面向人的阅读顺序（**阅读顺序，非施工步骤**）

| 你现在要做什么 | 按这个顺序读 |
|---|---|
| 只是把它装到本机 | `README.md` 的「安装」→「给 AI 的安装指令」两节（后者是可直接粘给 AI 的完整步骤） |
| 改这个仓库的某一块 | 本文件的「Project Map」定位模块 → 该模块的 `AGENTS.md` → 它的 `design.md`；改完按模块 `testing-guide.md` 与本文件的「Quality Gates」验 |
| 刚接手、什么都还不知道 | 本文件（红线 + Project Map）→ `README.md`（项目是什么、装与用）→ 你要动的那一块的模块文档 |
| 拿不准某条结论能不能当已成立的前提用 | 各模块文档里就地写明的 `**未观测**：…；量法：…` 条目（在 `preset/`、`tools/`、`browser/`、`desktop/`、`notify/`、`permission/`、`delegate/`、`settings/`、`ptc-parallel/` 各自的 `design.md` 与 `testing-guide.md` 里搜 `**未观测**：`）—— 未观测的前提不许当成已成立 |

**诚实原则（现行规范）**：**未观测不许写成实测，也不许写成"不可观测"** —— 每条未观测结论必须写出量法与可复跑的判据，就地写成一行 `**未观测**：<问题>；量法：<怎么测>`。引用别人记载的实测必须写明来源，**不得写成自己验证过**；**文档只描述当前项目状态**：版本区文档不写变更叙述 —— 变更史由 git 提交历史承担；过程件的落点与清理口径只在本文件「版本区（文档目录入口）」一节定义一次，别处只指回它。若某条"未观测"的依据已被本机日志或脚本推翻，**处置权在人** —— 报出来，不要自己按旧口径照抄。

## 外部依赖与 ref 解析

外部依赖的**能力与接口**一律按契约制品引用（包名 + 配置键名 / 导出符号名 / 契约文件名，可 grep），不引对方文档、不引实现行；**版本字面量只在本节的表里出现**，其余文档写"以本节的解析结果为准"，这样本机一直升到最新版时只改这一处。指向对方仓库的文件时用 `<org>/<repo>@<ref>:<path>` 形式，**禁止裸 `main` / `HEAD`**（对方一改就静默指向别处）。

| 依赖包名 | 解析命令（运行时取值） | 当前解析结果 | 引用形式示例 |
|---|---|---|---|
| `@deepseek-ai/dsh` | 版本：`dsh --version`；仓库句柄的 `<ref>`：`git ls-remote --tags https://github.com/deepseek-ai/deepseek-harness "dsh-v*"`（取输出**最后一条**的 tag 名） | 版本 `0.2.1-rc.2`；tag `dsh-v0.2.1-rc.2` | 版本：`@deepseek-ai/dsh@0.2.1-rc.2`；上游句柄：`deepseek-ai/deepseek-harness@dsh-v0.2.1-rc.2:<path>` |
| `@deepseek-ai/dsh-*`（`dsh-subagent` / `dsh-tool-subagent` / `dsh-compaction-basic` …） | `node -p "require('<该 profile 的 node_modules>/@deepseek-ai/dsh-*/package.json').version"` | 与上面同一个值 | 正文只写契约名（如 `toolFilter.allow`、`restrict()`、`auto`），要写版本时写"同 `@deepseek-ai/dsh` 的解析结果" |

- **ref 的派生规则**：上游 tag 名 = `dsh-v` + `dsh --version` 的值（**不是** `v<版本>` —— 形状实测全是 `dsh-v*`）。升级后按解析命令重取，不要手抄。
- **无仓库可引的本机插件**（`dsh-plugin-save-token`、`billion-context`）：只引契约制品或版本号，例如 `dsh-plugin-save-token` 的 `package.json` 里 `dsh.bundle.patch = ./cordis.patch.yml`、`billion-context` 注册的全局工具名 `compress` / `acp_status`。
- 包名会随 dsh 升级**改名**，所以每次升级后按本表重核一遍 composition 里的包名 —— 改名会让整份 preset 变成 `broken` 而不可用。

## Context Loading（按你手上的改动读）

阅读顺序，非施工步骤。

| 你要做什么 | 先读 | 再读 |
|---|---|---|
| 改委派能力 / 工具面映射（派什么子代理、给它哪些工具） | `preset/AGENTS.md` | `skills/adg-delegation/SKILL.md` → `preset/design.md` → 改完 `node tools/check-preset.mjs` |
| 改调度 persona 的「你手上的子代理」段或分派规则 | `preset/design.md` | `preset/testing-guide.md`（该段提到的委派工具名与 `delegation` 组里那条唯一的 `- id: agent` 委派行一一对应 —— `tools/check-preset.mjs` 的检查项 6）；编排层与输出纪律、交付侧验收判据、提问纪律、浏览器模式闸门都写在 `preset/design.md` 的「核心数据模型」里 SchedulerPersona 一节，逐条规定在 `preset/agent.cordis.yml` 调度 persona 的 `## 约束` 段（那边用 `【…】` 段名做锚） |
| 改 `tools/check-preset.mjs` 的判错口径，或改 composition 的 tool 行 | `tools/design.md` | `preset/design.md`（体积旋钮与 `allow` 的约束） |
| 改浏览器工具链（`cli.mjs` 契约 / `launch` / `close` / 驱动层） | `browser/AGENTS.md` → `browser/design.md` | `browser/testing-guide.md`；动 `launch` / `close` 的默认行为再读 `browser/design.md` 的「非功能红线」一节（模式与实例生命周期的不变量在「核心数据模型」的 BrowserMode / BrowserInstance 两节） |
| 改桌面工具链（`cli.mjs` 契约 / 坐标换算 / 注入闸门 / UIA 元素 id） | `desktop/AGENTS.md` → `desktop/design.md` | `desktop/testing-guide.md`；动注入路径（SendInput 的结构体尺寸与标志、UIPI 闸门、`--raise`、光标回读）再读 `desktop/design.md` 的「非功能红线」一节 |
| 改通知子插件（`notify_user` 的参数 / toast 实现 / 装载方式） | `notify/AGENTS.md` → `notify/design.md` | `notify/testing-guide.md`；装进 profile 的步骤见 `install.ps1` / `install.sh` |
| 改权限子插件（`set_child_permission` 的守卫 / 写入路径 / 装载方式） | `permission/AGENTS.md` → `permission/design.md` | `permission/testing-guide.md`；装进 profile 的步骤见 `install.ps1` / `install.sh` 的 2b-1 / 4c-2 / 4c-3 步 |
| 改 `delegate` 插件本身（工具名 / 参数 / 内置 deny 名单 / 装载方式） | `delegate/AGENTS.md` | `delegate/design.md` → `delegate/testing-guide.md`；装进 profile 的步骤见 `install.ps1` / `install.sh` 的 2b-2 / 4c-4 / 4c-5 步 |
| 改设置页框架 / 加一项配置项 / 改通知三项或注入四项的键与界（`adg-settings`） | `settings/AGENTS.md` → `settings/design.md` | `settings/testing-guide.md`；键名与默认值的真相只在 `settings/lib/schema.mjs`，消费方（`adg-notify`、`adg-skill-inject`）改契约时两边都要动；装进 profile 的步骤见 `install.ps1` / `install.sh` 的 2b-3 / 4c-6 / 4c-7 步 |
| 改框架注入（判据 / 降级 / section 位置 / 选哪份技能文件） | `skill-inject/AGENTS.md` → `skill-inject/design.md` | `skill-inject/testing-guide.md`；section 名 / order / 目标 preset 的常量只在 `skill-inject/lib/section.mjs`；装进 profile 的步骤见 `install.ps1` / `install.sh` 的 2b-4 / 4c-8 / 4c-9 步 |
| 改源码守卫（挂载点 / 顶层判据 / 成功前缀文案） | `source-guard/AGENTS.md` → `source-guard/design.md` | `source-guard/testing-guide.md`；判据与文案的常量只在 `source-guard/lib/policy.mjs`；装进 profile 的步骤见 `install.ps1` / `install.sh` 的 2b-5 / 4c-10 / 4c-11 步 |
| 改 PTC 并行执行提示（PTC 判据 / section 位置 / 正文与动态工具清单） | `ptc-parallel/AGENTS.md` → `ptc-parallel/design.md` | `ptc-parallel/testing-guide.md`；正文常量与判定口径只在 `ptc-parallel/lib/guide.mjs`；装进 profile 的步骤见 `install.ps1` 的 2b-6 / 4c-12 / 4c-13 步（`install.sh` 不管本模块） |
| 改浏览器那一段委派口径（模式 / 登录态 / 权限闸门） | `preset/design.md` 的「核心数据模型」里 SchedulerPersona 一节（浏览器模式闸门的选择理由在 `preset/agent.cordis.yml` 调度 persona 的 `【浏览器：模式】` 段） | `browser/AGENTS.md`（它消费的命令行契约）→ 根 `README.md` 的「浏览器工具链与登录态资产」一节 → 改完 `node tools/check-preset.mjs` |
| 只是想装到本机 | `README.md` 的「安装」一节 | `install.sh` / `install.ps1` |
| 改文档 | `adg-doc-criterion` 技能 | 本文件的「版本区」一节 |

## Quality Gates

| 检查项 | 载体 | 期望结果 |
|---|---|---|
| preset 源文件的静态合规 | 机检：`node tools/check-preset.mjs` | exit 0。**允许 WARN**；ERROR 的含义只有一个 —— 这次委派必然抛错。跑完读它自己打印的摘要行，**不要把读数写进文档**（取值范围与结构性判据都在脚本里，读数会漂） |
| 四种味道的生成物都注入正确 | 机检：四条 `gen-preset-bundle.mjs … && node tools/check-bundle-flavor.mjs … <味道键>`（完整四条见 `preset/AGENTS.md` 与 `tools/AGENTS.md` 的「命令」节；**改了 `preset/agent.cordis.yml` / `tools/gen-preset-bundle.mjs` / `tools/flavors.mjs` 时必须跑**） | 四条都 exit 0。`check-preset.mjs` 只看源文件，产物是它的盲区，只跑 plain 证明不了注入生效 |
| preset 真的挂得上 | 机检：按 `README.md`「真实挂载验证」一节做一次**真实挂载** | `agentPresets.resolve('adg-ptc')` 的 `.broken` 为空，且委派行**恰好一条、`toolName` 唯一**。静态自检证明不了挂载 |
| 浏览器工具链 | 机检：`cd browser && node --test test`；改了 `browser/` 再按 `browser/testing-guide.md` 的「交付前的最小闭环」一节跑一次真机闭环 | 单元测试全绿；真机闭环每步的 `STATE=` 与期望一致 |
| 通知子插件 | 机检：`cd notify && node --test test` | 全绿（零依赖，不弹窗） |
| 权限子插件 | 机检：`cd permission && node --test test`（沙箱里加 `--test-isolation=none`）；改了守卫或写入路径再在**新会话**里对任一已派出的子代理真调一次 `set_child_permission` | 单元测试全绿；运行中那次 `applied=live`、已停下那次 `applied=persisted`、把权限改到超过调用方自己的那次被拒 |
| 注入插件 | 机检：`cd skill-inject && node --test test`（纯函数，零依赖）；改了判据或接线再在**新 Adg 会话**里按 `skill-inject/testing-guide.md` 的 M1–M10 核（调度者有框架段且与下拉选中的框架一致 / 子代理默认没有（`skillInjectSubagent` 打开后有，且不需重启）/ 其他 preset 没有 / 设置页改正文或换框架下一轮就换 / 输入框「超思」chip 能关能开且与设置页同值） | 单元测试全绿；M1–M10 与期望一致 |
| 委派插件 | 机检：`cd delegate && node --test test`（沙箱里加 `--test-isolation=none`）；再在**新会话**里让调度者真用一次 `delegate` | 单元测试全绿；返回的 `tools` / `tools_note` 与子代理实际拿到的工具面一致（点名未知名要被逐条剔除并记进 `tools_note`，点 `run_code` 当场抛错） |
| 源码守卫插件 | 机检：`cd source-guard && node --test test`（沙箱里加 `--test-isolation=none`）；改了挂载点或判据再在**新 Adg 会话**里跑一次成功的 `run_code` 与一次失败的 `run_code` | 单元测试全绿；成功那次结果正文应多出一行「已执行代码：<当次 description>」（那句「源码未随本结果重复」的说明句默认不出现），失败那次与未装本插件时逐字相同 |
| PTC 并行提示插件 | 机检：`cd ptc-parallel && node --test test`（沙箱里加 `--test-isolation=none`）；改了判据、section 或正文再在**新 PTC 会话**里核对系统提示词出现「## PTC 并行执行（一次 run_code 里多做）」段（子代理那侧也应有） | 单元测试全绿；动态工具清单随各 agent 当前可见的工具变化（清单不写死在正文里） |
| 设置页框架 | 机检：`cd settings && node --test test`（沙箱里加 `--test-isolation=none`）与 `cd notify && node --test test`（消费方契约在两边各钉一份，改任一侧都要两边都绿）；再在**重启后的 dsh** 里打开设置看「Adg 设置」页 | 两边单元测试全绿；页面能读当前生效值（含来源）/ 改一项保存 / 恢复默认，刷新后仍然生效 |
| 桌面工具链 | 机检：`cd desktop && node --test test`（沙箱里加 `--test-isolation=none`）；改了注入路径再按 `desktop/testing-guide.md` 的「交付前的最小闭环」在**完全权限**会话里跑一次真机闭环 | 单元测试全绿；真机闭环每步的 `CHANGED=` / `CURSOR_LANDED=` 与期望一致（只用 `--dry-run` 证明不了注入） |
| 文档合规 | 评/机检：按 `adg-doc-criterion` 技能的质量红线清单逐条自检；`AGENTS.md` 的 Project Map 与「版本区」表要覆盖本仓库全部模块与文档 | 逐条通过；行数在 `adg-doc-criterion` 技能给的预算内（量法：`node -e "const f=process.argv[1],s=require('fs').readFileSync(f,'utf8');console.log(s.split('\n').length-(s.endsWith('\n')?1:0))" <文件>`，当场读，读数不作锚） |
| 文档里的引用真实存在 | 机检：先取出文档里全部反引号路径引用与链接目标，再逐条判存在（不要抽查几条） | 全存在。命令逐条敲一遍；被 `.gitignore` 排除的临时工作目录只许以反引号路径提及，不许做链接（落点与口径见「版本区（文档目录入口）」一节） |

**能力的边界（不许越界宣称）**：`tools/check-preset.mjs` 是**逐行文本扫描器，不是 YAML 解析器** —— 它证明不了文件能被 YAML 解析，也证明不了 preset 真的挂载。**未观测的结论不许写成实测，也不许写成"不可观测"**：每条未观测项必须就地写成一行 `**未观测**：<问题>；量法：<怎么测>`（不设集中台账，要判"量过没有"就搜 `**未观测**：`），引用别人记载的实测必须写明来源、不得写成自己验证过 —— 不然下一个读者会把没量过的东西当前提用。
# Adg PTC 模式（DSH agent preset）

一份 DSH 自建 agent preset：**一个调度智能体 + 它按需派出的通用子代理**。你把需求说给调度智能体，它判断范围后自己用 `delegate` 在**每一次委派时现定**：这一次子代理干什么、给哪些工具、什么边界、什么验收标准。子代理做完把结果交回来由它汇总。**一跳可达**：子代理不能再开子代理（`delegate` 的内置 deny 名单 + 平台深度默认 1），带与带之间的越界也由调度者续派。

另外八件一起装的东西：

- **`delegate/`** —— 仓库内部第一方子插件 `adg-delegate`，在**全局层**注册工具 `delegate`，而且**只有调度智能体拿得到**：它让调度者对**每一次委派**现定 `description` / `prompt` / `tools`（工具名数组；缺省＝让它继承全部）/ 可选 `persona`（平台语义是**遮蔽**该子代理的部署 persona，不是追加）/ `background`（缺省 `true` ＝ continuable 可续跑）。六个内置 deny 名**永不进子代理的工具面**：`agent` / `delegate` / `workflow` / `ralph` / `set_child_permission` / `ask_user_question`；`notify_user` **刻意可以**给子代理（单向提醒，让撞上登录墙的子代理自己喊人）。它同时注册**第二个工具 `ask_user`** —— 子代理的**提问通道**：子代理调用它时，问题以**派它的那个调度者**为 owner 交给用户提问服务，卡片就落在**你与调度者对话的这个会话**里；你答完，答案直接回到子代理手上、它当场接着干（不是"喊一声就停手"）。点名的未知名逐条写进返回的 `tools_note`；点名 `run_code` 当场抛错；
- **`browser/`** —— 默认无头的 Chromium 系浏览器驱动（Chrome / Brave / Edge 探测）+ 最小 CDP 驱动，零第三方依赖，是**拿到浏览器工具链的那次委派**实际用的工具链；
- **`desktop/`** —— 零依赖的 **Windows 桌面操控 CLI**（唯一入口 `cli.mjs` + 随附桥 `scripts/bridge.ps1`）：截屏 / 窗口与 UIA 枚举 / `SendInput` 合成输入 / 元素自带 UIA pattern 的语义操作 / 动作前后的可观测差异复核，是**拿到桌面工具链的那次委派**那条"真能点按钮"的路；**Windows 专用**，而且**要驱动普通用户窗口，调用它的那一次会话必须是完全权限** —— 受限会话的 Low 完整性级别会被 UIPI 拦下、且是**静默**丢事件，所以注入类命令只认可观测差异（`CHANGED=` / `CURSOR_LANDED=`）、不认 `SendInput` 的返回值；
- **`notify/`** —— 仓库内部第一方子插件 `adg-notify`，注册工具 `notify_user`（Windows 桌面提醒，**单向不阻塞**；默认存活时间 **0 ＝ 常驻**，toast 走 `scenario="reminder"`，不再自己消失）；
- **`permission/`** —— 仓库内部第一方子插件 `adg-permission`，注册工具 `set_child_permission`：让调度者把**在权限切换之前**派出去、还停在旧文件权限的子代理改到新权限（只有调度者能用；两条守卫 —— 只能改自己派出去的、且**不得超过调用方自己** —— 写在代码里，不是提示）；
- **`settings/`** —— 仓库内部第一方子插件 `adg-settings`：在「设置」里注册一页 **Adg 设置**，把 `adg-notify` 的**三项行为**（**通知默认标题** / **响提示音** / **通知常驻**）与 `adg-skill-inject` 的**两项行为**（**注入思考框架** 开关 / **自定义注入正文**）做成可配置项，改动写进 `${DSH_PROFILE_DIR:-${DSH_HOME:-~/.dsh}}/adg-settings.json`（优先当前 profile 目录；本机实际就是 `<profile>\adg-settings.json`），**保存后立即生效、不用重启**（没有这项设置时通知走出厂默认）。它同时是一套**登记表驱动的框架**：加一项配置只需在 `settings/lib/schema.mjs` 的 `FIELDS` 加一条登记 + 在 `settings/client.js` 的 DICT 补两条文案（zh/en），宿主与客户端逻辑都不用改 —— 详见下方「设置页（Adg 设置）」一节；
- **`skill-inject/`** —— 仓库内部第一方子插件 `adg-skill-inject`：把思考框架正文注入 **Adg 调度智能体**的系统提示词 —— 不依赖模型自觉去 read（persona 级的"先读技能"指令已被证过不可靠），系统提示词不参与折叠，"不许压缩"由机制天然满足。正文默认取 `skills/thinking-framework/SKILL.md`，也可在「设置 → Adg 设置」里换成自定义正文；**输入框左侧那颗「超思」开关**控制开关（与设置页同一个值，点一下即写盘、下一轮请求生效）。**只在 Adg PTC 模式注入**：按会话头 `origin`（非 `subagent`）与 preset 身份（`adg-ptc`）逐 agent 判定，子代理与其他 preset 的会话一律不注入。不注册任何工具；
- **`skills/`** —— 七份技能，装到 `${DSH_HOME:-~/.dsh}/skills/`，按**渐进式披露**承载可复用经验（用法：调度者把技能文件的**绝对路径**写进委派 prompt，要子代理先 `read` 再动手）：
  - `adg-delegation` —— 给**调度智能体**看：能力带 → 建议工具面 / 建议 persona 要点 / 边界的映射表，以及怎么给 `tools` 与 `persona`、一跳可达、材料中转、验收判定；
  - `adg-browser-use` —— 给**拿到浏览器工具链的子代理**看：`cli.mjs` 用法、默认无头与换模式的不变量、登录墙人工协议、profile 是资产、标签页纪律、**必须完全权限**与三家浏览器的失败签名去哪看；
  - `adg-computer-use` —— 给**拿到桌面工具链的子代理**看：`${DSH_HOME:-~/.dsh}/desktop/cli.mjs` 的子命令（`screen` / `windows` / `uia` / `click` / `type` / `key` / `invoke` / `verify`）、**必须完全权限**（受限令牌的 Low 完整性级别会被 UIPI **静默**拦下，只认 `CHANGED=` / `CURSOR_LANDED=`、不认返回值）、UIA pattern 的可得性边界；
  - `adg-file-ops` —— 给**做文件与文档工作的子代理**看：检索定位、批量整理、格式转换与文档生成、`read_image` 的两条独立条件、本机工具链要先探测、缺什么直说**不许假装完成**；
  - `adg-grill-me` —— 给**调度智能体自己**看：把方案 / 决策画成设计树，按「轮」追问整个前沿、每问附推荐答案；事实自己查（要子代理就经 `delegate` 现派）、决策一律交用户、**没调 `delegate` 就不许声称派了子代理**、共识达成前不动手。它同时是用户入口（`/adg-grill-me`），取代原先外部的 `dsh-grill-me` 插件；
  - `adg-doc-criterion` —— 给**写文档的调度者与子代理**看：项目「文档工程师」角色规范 —— 文档首先写给人看（清晰、可审核第一）、人类可读与可审核契约、引用形式规范（同仓库相对路径 / 跨仓库绝对 URL + 显式 ref、**禁止行号**）、`AGENTS.md` / `design.md` / `testing-guide.md` 与 `_index.md` 的写作规范、质量红线清单与反模式；
  - `thinking-framework` —— 给**调度智能体**用：思考框架正文不靠人 read —— 由 `adg-skill-inject` 插件（见上）直接注入调度者系统提示词；技能文件本身仍是正文的事实源（改完重启即换）。

要看**怎么改这个仓库**（命令、红线、模块地图、质量门）请看根 `AGENTS.md`；本文是给人看的：怎么装、怎么用、怎么排错。

## 安装

### 最快路径：把仓库地址交给 AI

把仓库地址发给 dsh 里的 AI，说一句「按仓库 README 装到本机」。本文的「给 AI 的安装指令」一节就是写给它看的。

### 手动安装

```sh
git clone <repo-url> ~/dsh-adg-ptc
sh ~/dsh-adg-ptc/install.sh                     # macOS / Linux
```

```powershell
git clone <repo-url> $HOME\dsh-adg-ptc
powershell -ExecutionPolicy Bypass -File $HOME\dsh-adg-ptc\install.ps1   # Windows
```

要求 **Node ≥ 22**。

**安装脚本的参数**（两边行为等价，只是写法不同）：

| 参数 | 作用 |
|---|---|
| 不带参数 | 对**每个"能装 preset 的 profile"**逐个注入组探测，各自决定拿哪一份生成物 |
| 位置参数（`sh install.sh web desktop`；PowerShell 用 `-Profiles web,desktop`） | 只装指定的 profile 子集 |
| `--billion-context=auto\|on\|off`（PowerShell：`-BillionContext`） | `on` / `off` 是**整体覆盖**该注入组的探测结果，覆盖与探测不一致时脚本会多打一行黄字警告 |
| `--save-token=auto\|on\|off`（PowerShell：`-SaveToken`） | 同上，管另一个注入组 |

`auto`（缺省）的语义是"装了什么才注入什么"：脚本对**每个 profile、每个注入组**各探测一次，装着那个插件才把它的全局工具名注入**生成物的调度 persona** —— 生成器在调度 persona 的 `## 约束` 前插一段「本会话的上下文工具」说明，要调度者**每一次委派都把这几个名字一并写进 `delegate` 的 `tools`**（委派行本身刻意不写 `toolFilter`：写进那一次 `tools` 才算数），并给它挑对应的那一份生成物。不传参数时它只挑 `dsh.profile.bundles` 里含 `@deepseek-ai/dsh-web-app` 的 profile —— 判据是 preset 注册服务由那个 bundle 声明，往缺它的 profile 里塞声明行会让该 profile 启动失败。

### 装完必须重启 dsh

**preset 的改动按"重启 + 新会话"验收，别赌热重载。** 装完重启 dsh，然后在**新建对话**里选「Adg PTC 模式」。重启之前 Adg PTC 模式仍在用旧组合运行，不要拿它做验证。

（`browser/` 与 `desktop/` 是例外：重跑一次安装脚本即生效，**不用重启**。但 `desktop/` 还有一层前提 —— 要真正驱动普通用户窗口，**调用它的那一次会话必须是完全权限**，否则受限令牌的 Low 完整性级别会被 UIPI 拦下、且是静默丢事件。）

### 装到哪里

`${DSH_HOME:-~/.dsh}` 是你的 dsh 用户根。

| 仓库里的路径 | 安装到 | 生效方式 |
|---|---|---|
| `preset/`（preset 的源文件） | 先由 `tools/gen-preset-bundle.mjs` 生成 bundle（生成物落在被 `.gitignore` 排除的 `bundle/adg-<味道>/`，**产物不入库、不许手改**），再按味道拷到它的稳定目录 `${DSH_HOME:-~/.dsh}/bundles/dsh-adg-ptc`（以及 `...-bili` / `...-save-token` / `...-bili-save-token`），并把包名 `dsh-adg-ptc` 写进目标 profile 的 `dsh.profile.bundles` | **重启 dsh** + 新会话 |
| `skills/`（`skills/<名字>/SKILL.md`） | `${DSH_HOME:-~/.dsh}/skills/<名字>/SKILL.md` | 用户技能根是热加载的，立即生效 |
| `browser/` | `${DSH_HOME:-~/.dsh}/browser/` | 重跑安装脚本即生效，**不用重启** |
| `desktop/` | `${DSH_HOME:-~/.dsh}/desktop/` | 重跑安装脚本即生效，**不用重启**（但**调用它的那一次会话**要驱动普通用户窗口必须是完全权限） |
| `notify/` | 稳定副本 + `dsh plugin --profile <p> add "file:<稳定副本>"` | **重启 dsh** + 新会话 |
| `permission/` | 稳定副本 + `dsh plugin --profile <p> add "file:<稳定副本>"`（`install.*` 的 2b-1 / 4c-2 / 4c-3 步做的就是这个） | **重启 dsh** + 新会话 |
| `delegate/` | 稳定副本 + `dsh plugin --profile <p> add "file:<稳定副本>"`（`install.*` 的 2b-2 / 4c-4 / 4c-5 步做的就是这个） | **重启 dsh** + 新会话 |
| `settings/` | 稳定副本（`plugins/adg-settings/`，8 个文件）+ `dsh plugin --profile <p> add "file:<稳定副本>"`（`install.*` 的 2b-3 / 4c-6 / 4c-7 步做的就是这个） | **重启 dsh** 后设置里才出现「Adg 设置」那一页；**页面里的改动保存即生效，不用重启** |

## 味道：一份源文件，四种生成物

有**两个可选的外部插件**会往全局工具层注册工具，而它们给模型看的指令与通知只看自己的配置、不看这个请求到底有没有那些工具 —— 所以本 preset 必须按"这个 profile 到底装没装它"决定要不要那段注入说明（也就是委派时给不给子代理那几个名字）。这样一组东西在仓库里叫**构建期注入组**（清单只有一份，写在 `tools/flavors.mjs`）：

- **billion-context**：把会话上下文折叠进 pack，注册 `compress` / `decompress` / `search_context` / `acp_status`（同属该插件的 `acp_cache` **故意不注入** —— 它是给调度者做诊断用的，给每个子代理只会加长它们每次请求的固定前缀）。它激活时还要关掉 preset 自己的自动压缩（给 `compaction-basic` 注入 `config: {auto: false}`）：有 bili 在折叠上下文时，让 dsh 自带的自动压缩同时上工会两套压缩抢同一段历史。`auto: false` 的语义是「关掉自动压缩与溢出恢复，手动 `/compact` 仍可用」，**不是**把这一行禁用。
- **save-token**（`dsh-plugin-save-token`）：在**工具结果进入历史的那一刻**把大输出换成 `[save-token #id] …` 通知，并注册 `save_token_expand` 让人把原文取回来。通知正文会直接点名那个工具，而被委派的子代理确实收得到它，所以**装了就必须注入**，否则子代理会去调一个不存在的工具。

所以口径是"**源文件中立、生成物按探测决定**"：

| 味道键 | 稳定目录（`$DSH_HOME/bundles/`） | 注入说明里点名的工具（调度者要写进 `tools`） | `compaction-basic` 的 `config.auto` |
|---|---|---|---|
| `plain` | `dsh-adg-ptc` | 无 | 不写（这些 profile 里 dsh 自带的自动压缩是唯一的压缩手段） |
| `bili` | `dsh-adg-ptc-bili` | `compress` / `decompress` / `search_context` / `acp_status` | `false` |
| `save-token` | `dsh-adg-ptc-save-token` | `save_token_expand` | 不写 |
| `bili+save-token` | `dsh-adg-ptc-bili-save-token` | 上面五个名字 | `false` |

四份生成物的 `package.json` 逐字节相同、**包名都是 `dsh-adg-ptc`**（所以 `dsh.profile.bundles` 那一行四种味道通用），只有 `cordis.patch.yml` 不同；每个 profile 的 `node_modules/dsh-adg-ptc` 只链接它该拿的那一份。**目录名不要写死**，以 `tools/flavors.mjs` 的 `dirNameFor(key)` 为准（味道键里的 `+` 换成 `-`）。手动生成不带旗标 = plain：忘带旗标只是少个能力，不会装坏。

## 真实挂载验证

**静态自检证明不了挂载 —— 只有真实挂载算证据。** `node tools/check-preset.mjs` 是逐行文本扫描器、不是 YAML 解析器：exit 0 只说明"这些硬约束在文本上没被破坏"。做法：重启 dsh 后在**新对话**里选 Adg PTC 模式，再挂一个注入 `agentPresets` 的临时插件读运行期状态，判据是这几条：

- `agentPresets.resolve('adg-ptc')` 的 `.broken` 为**空** —— 它是"这份组合能不能用"的**唯一**判据，报的是具体哪一行起不来；
- `agentPresets.list()` 里能看到 `adg`。
- `compositionInventory()` 里**恰好一条**启用委派行（`agent`），且**没有** `tool-subagent-fork` 行。判据要写准：它报的是**模块名**，所以 `@deepseek-ai/dsh-tool-subagent` 出现的次数 = **1 条启用委派行 + 两条 `disabled: true` 的 codex / claude-code 行 = 3**，按"出现次数 = 委派行数（1）"去断言会误报失败。

## 子代理与能力带

**没有固定名册。** 调度者每次委派都用 `delegate` 现给 `description` / `prompt` / `tools` / 可选 `persona` / `background`：`description` 是给用户看的一行；`prompt` 是子代理唯一的上下文（它看不到本会话）；`persona` 只在需要专门视角时才给，平台语义是**遮蔽**该子代理的部署 persona；`background` 缺省 `true`，也就是 continuable 可续跑 —— 能被接续、能被你 steer、能被调度者把后续任务接给同一个它。

`tools` 就是那一次的能力边界，而且是**硬的**：平台 `tools.restrict()` 让子代理可见的工具目录**恰好等于**这份名单（连 preset 自己注册的工具一起被裁）。两条派生事实：点名的未知名逐条写进返回的 `tools_note`；内置 deny 的六个名字（`agent` / `delegate` / `workflow` / `ralph` / `set_child_permission` / `ask_user_question`）**点也点不动**。子代理要**问人**走 `adg-delegate` 的第二个工具 **`ask_user`**（不是平台那个 `ask_user_question`）：它是给得下去的提问通道，点名就进面；要人工介入的委派（登录墙 / 验证码 / 需要有人拍板）**都给上它**，否则子代理只能单向喊一声再停手，等下一次委派。

下表是**能力带 → 建议工具面**的对照（不是名册，也不是完整工具清单：能给的名单＝这次会话里已注册的那些名字）。拿不准可以**省略 `tools`** —— 子代理会拿到它继承到的全部（减去那几个永远不给的名字）；配面按「**完成这次委派的所有必需工具**」来配（不要为「以后可能用到」一次塞满），并注意**工具面在子代理创建那一刻就钉死**，它报缺什么只能**新派一个带那个工具的子代理**（`send_message` 只送字、给不了工具），产物用路径交接。带与带之间的越界（例如检索那一带碰上了写入需求）同样由子代理报回、调度者另发一条委派 —— 子代理之间不能直接互相转交。每行的「边界 / 缺口」写的是本环境的真实实现口径，不是宣传语：

| 能力带 | 建议工具面 | 何时派这一带 | 本环境的边界 / 缺口 |
|---|---|---|---|
| 文件与文档 | `read` / `read_image` / `write` / `edit` / `glob` / `grep` / `pwsh` / `job_list` / `job_output` / `job_kill` / `notify_user` | 检索定位、深入阅读与问答、批量整理归类、格式转换与文档生成；包括图片内容理解（`read_image`） | 图片内容理解走 `read_image`（需要模型路由支持图像输入）；文本类文档（PDF / Word / Excel / PPT）用本机已有工具提文本。OCR、人像/场景检索、跨设备传输**取决于本机工具链**：先探测可用工具，缺什么就直说「本机缺少 X，无法完成」并给替代方案，**不允许假装完成** |
| 系统与应用 | `read` / `glob` / `grep` / `pwsh` / `job_list` / `job_output` / `job_kill` / `notify_user`（GUI 闭环另给 `desktop/` 工具链） | 系统与硬件信息、设置修改、优化清理、故障排查、进程与服务控制；桌面软件启停/安装卸载与命令行调用、Android 模拟器上的 App、微信小程序 | 不依赖模拟点击的 **Windows API 路线可用**（PowerShell / CIM / P-Invoke）；软件侧优先 CLI / adb / winget / 软件自带接口。**GUI 闭环也有路**：`desktop/` 工具链（入口 `${DSH_HOME:-~/.dsh}/desktop/cli.mjs`，零依赖）能「`screen` 截屏 → `windows` / `uia` 定位 → `click` / `type` / `key` 合成输入 → 复核可观测变化」，`invoke --id` 还能在**目标应用实现了 UIA provider 时**用元素自带的 UIA pattern 语义操作（不移动真实鼠标、被遮挡也可能点到；pattern 的可得性随"这一次调用的令牌"变化，边界未量全，见 `desktop/testing-guide.md` 的未观测项）；**前提是这一次委派必须完全权限**（`danger-full-access`），受限会话的 Low 完整性级别会被 UIPI 拦下、且是**静默**丢事件（SendInput 照样报"已插入 N 个事件"）—— 所以只认 `CHANGED` 与 `CURSOR_LANDED`，不认调用返回；目标完整性级别更高时工具链会在注入前主动阻断。「完全权限下这条闭环真的成立」来自另一路完全权限会话的实测记载，**不得转述成你自己验证过**。`read_image` 有**两条互相独立的条件**：注册依赖持久 attachments 服务 —— 服务没挂上时这个名字没注册，**那一次委派会直接失败**（不是简单的"看不了图"）；即便注册了，执行时还要求当前会话路由声明图像输入，报错就如实说"看不了图"、改用可查询的状态量作答，不要假装看过。会改变系统状态的操作要先说明影响与回退；不可逆或高风险操作必须先停下、写明需要用户确认（由调度者转达） |
| 网页 | `read` / `read_image` / `write` / `edit` / `glob` / `grep` / `pwsh` / `web_fetch` / `job_list` / `job_output` / `job_kill` / `ask_user` / `notify_user` + `browser/` 工具链（**本次委派必须完全权限**） | 登录态下的站点操作、多步表单、点击与下拉选择、多页跳转抓取 | **本会话必须是「完全权限」（`danger-full-access`）—— 硬约束**（理由见下一节）；走 `browser/` 工具链（默认无头；需要人进去操作时才升级成有头窗口，登录态跨会话复用）；工具链不可用或目标本来就静态可取时**降级**成 `web_fetch` 单次抓取（只能取静态内容、不能交互），并在回答里说明是降级执行；撞上登录墙 / 验证码 / 二次验证时把有头窗口开好，**用 `ask_user` 直接问用户**（登录好了没 / 要不要继续），用户答完它当场接着干；`notify_user` 只是**单向补充**（喊人，不等回话）。截图可以用 `read_image` 自己看 |
| 全网检索 | `web_search` / `web_fetch` / `notify_user` | 多轮联网检索与多源资料综述，结论要带来源链接 | **联网侧只有 `web_search` / `web_fetch`**（另给 `notify_user` 做单向提醒），本地文件与系统级请求被硬性排除（这不是偏好）。天气、汇率、股价这类简单事实、以及一两次抓取就能答完的已知 URL 定点核对由调度智能体**直接回答**，不派子代理 |
| 本地检索与出处 | `read` / `glob` / `grep` / `web_search` / `web_fetch` / `notify_user` | 在本仓库/本机文件里定位实现、配置与出处 | **硬只读** —— 不建议给 `write` / `edit` / `pwsh`，真的改不动东西 |
| 编码改动 | `read` / `read_image` / `write` / `edit` / `glob` / `grep` / `pwsh` / `job_list` / `job_output` / `job_kill` / `notify_user` | 按已确定的方案改动工作区代码，并运行编译/测试自证 | 只在当前工作区内改动文件；不做需求解读、方案设计与系统级运维。能在本机真的跑起来、显示在屏幕上的界面改动后可自己截屏（`pwsh` 截屏 → `read_image` 看图）做**可选**自查；需要浏览器渲染的页面走网页那一带。`read_image` 有两条互相独立的条件：注册依赖持久 attachments 服务（没挂上时那一次委派直接失败），即便注册了、执行时还要求当前路由声明图像输入，报错就如实说明；视觉核对的归属仍是审查那一带 |
| 对抗性审查 | `read` / `read_image` / `write` / `glob` / `grep` / `pwsh` / `web_search` / `web_fetch` / `job_list` / `job_output` / `job_kill` / `notify_user` | 对已有改动做对抗性审查 | 只报告、**不修改被审对象与任何既有文件**。它手上的 `write` 只有一种用途：把程序化验证用的**临时脚本**写进平台临时目录、用完删除；`read_image` 让它能直接看截图做视觉核对；验证仍以只读命令或测试为主 |

**「一跳可达」是机制，不是偏好**：子代理的工具面里没有 `agent` / `delegate`（`adg-delegate` 的内置 deny 名单），开不了子代理；就算绕过去，平台的深度闸门也会当场抛 `subagent depth 2 exceeds maxDepth 1`（平台默认 `maxDepth` 就是 1）。

**能复用的能力不靠名册、靠技能**：某个领域有现成技能时，调度者把技能文件的**绝对路径**写进委派 prompt、要子代理先 `read` 再动手（渐进式披露：技能正文不占调度者每次请求的固定前缀）。

## 浏览器能力需要完全权限

**结论先说：** 拿到浏览器工具链的那一次委派要做真正的浏览器自动化，**必须**让本会话处于 `danger-full-access`（界面 Permissions 选择器里 id 为 `danger-full-access` 的那一项，或 `/permission danger-full-access`）。在 `workspace-write` / `read-only` 下，本机的 Chrome、Edge 与 Brave **三家都起不来**，而且**无头不改变这个结论** —— 有头与无头在受限令牌下同形失败。

**根因（实测到这一层）**：沙箱在 Windows 上用受限令牌运行子进程，而该后端自己的文档把这条边界写在「已知限制」里 —— 受限孙进程的**管道 stdio 捕获不可用**（libuv 的管道 stdio 用有名管道，client 端打开所请求的写访问时没有任何 restricting SID 被授予）。Chromium 的 Mojo IPC 同样走有名管道，于是浏览器在**进程初始化阶段**就死掉，三家浏览器各有自己的失败签名（**签名本体不在这里复述**：三条签名的文本与判读口径见 `browser/AGENTS.md` 的「红线」一节）。同一批命令在 `danger-full-access` 下全部转绿。**换 stdio 救不了浏览器**（它要的是进程内部 IPC，不是它自己的 stdout），`--no-sandbox` / `--single-process` / `--no-zygote`、把 profile 放进工作区或临时目录**都试过、全部无效**。

**这条约束无法从 preset 侧修掉**，逐条原因（都是源码级事实）：

| 问题 | 结论 |
|---|---|
| 父智能体能否给子智能体指定权限范围？ | **不能**。子代理工具行的实例配置里根本没有沙箱相关项 |
| 能否用 preset 文件改默认权限范围？ | **不能**。沙箱模式、权限预设、审批三行都在宿主的部署文件里；模式解析是"请求 > 会话事件 > 部署默认"，**没有 preset 侧入口** |
| 子代理能否自己升权（带 `sandbox_permissions` + 用户批准）？ | **不能**。委派时子会话的审批策略被**钉成 `never`**，策略 `never` 对审批请求直接判拒、**不弹窗** |
| 父级切换权限后，已经在跑的子代理会跟着变吗？ | **不会自动跟**。权限在**委派那一刻**就被捕获并写进子会话 ⇒ 新权限只对"切换之后**新开的**子代理"生效。事后的补救有两条：**重派**（停掉旧的、新开一个），或让调度者对那个已派出的子代理调 `set_child_permission`（**不必新开**，运行中的下一次受限调用就按新模式解析） |

**能把子代理送进完全权限的前提只有一条：你在会话里把权限切到 `danger-full-access`。** 切完之后有两条路把新权限交给那个已经派出去的子代理：**新建委派**（旧的先停掉再重派），或让调度者调一次 `set_child_permission`（见下一段）。**不要等它原地自己变得能用** —— 子代理自己升不了权。

**派发前的处置 = 一道问你的闸门 + 一条它自己判定的口径**（提示级，不是权限强制 —— 它靠 persona 被遵守）：

1. **派发前问权限**：调度者先读自己上下文里那行 `Current DSH file policy:`，不是 `danger-full-access` 就先问你，选项是「已切到完全权限，继续派发」／「改用降级方案：只做静态抓取（不能交互）」／「暂不做这项网页操作」。你答已切换后它会**先确认那行真的变了**再派发；没变就如实说没切成功。
2. **模式由调度者自己判定，不再问你**：完全确定这次不需要登录 / 验证码 → **无头**；确定要登录或过验证码 → **有头**；拿不准 → **先无头**，真撞上登录墙 / 验证码再换成有头（换法只有一条：`launch --headed` —— 优雅关掉无头实例、同 profile 同端口开有头窗口，登录态留在原地）。判定的结果会**写进委派文本**（例：「本次先无头开工；撞上登录墙就 `launch --headed` 换有头并停手报回」）—— 子代理问不了你，委派里没写它只能按工具默认（无头）开工。同一条委派的续派 / 重派、以及沿用的同一个实例都用已定模式。**你主动说了模式 → 照办**，并在交付里写明这是你的要求。**工具层的默认值没改**：不给旗标仍是无头，变的只是**谁来决定这一次用哪种模式**。

**切换之后要让已经派出去的子代理跟上，有两条路**：重派（停掉旧的、新开一个），或调一次 `set_child_permission`（本仓库的第一方子插件 `adg-permission`，只有调度智能体拿得到，**不出现在任何子代理的工具面里** —— `set_child_permission` 在内置 deny 名单上）。它改的是那个子会话的 `sandbox/mode`：**运行中的实例立刻生效**（记 `applied=live`），**已经停下的写进它的会话日志**、下次被续起时才生效（记 `applied=persisted` —— 它只说明写进去了，不等于已经生效）。两条守卫写在代码里、不是提示：① 目标必须是**你自己派出去的**子代理（按 `listDescendants` 判血缘）；② **改后的模式不得超过调用方自己当时的模式**（调度者自己是 `read-only` 就给不出 `workspace-write`，当场被拒）。它**不碰审批** —— 子代理的审批一律钉成 `never`，所以"改完就能用带审批的操作"不成立，能用的仍然只有新模式下不需要审批的那些。装载与复核见 `permission/AGENTS.md`。

**刻意没做的事**：本可以把这道闸门做成**确定性拒绝**（`dsh-tools` 的 `tools[].pre-execute` 钩子真实存在，非放行的判定会带 `reason` 变成一次工具错误）—— 没这么做，是因为它会把一条"流程提醒"升级成硬拦（连你想降级执行也会被一并挡掉），而要做对就得再起一个包、一条部署路径与一套测试，收益与体积不成比例。后来新增的 `set_child_permission` **不是这道闸门**：它管的是"切换之后怎么弥补"，不管"派发前放不放行"；它自带的那两条守卫是确定性的，但只约束那一次改权限的调用。

## 登录墙与验证码：人工介入协议

**能让你手动去登录／过验证码，而且这是默认路径，不是失败。** 需要登录态才拿得到目标时，调度者就该照常派发、请你手动登录一次 —— 它**不许**在派发前就禁止子代理登录，也不许为了回避登录先降级成静态抓取；**只有你明确说过「不想登录／不想验证」时才走收手那条路**。分工是：子代理**把有头窗口开好** → **用 `ask_user` 直接问你** → 你在这个会话的卡片上作答 → **答复直接回到它手上，它当场接着干**（复核登录态、继续取内容）。没有谁来"转达"，也不需要它停手等你重派。撞上登录墙时它**也会**用 `notify_user` 给你发一条**单向**提醒（写清卡在哪、你要做什么）—— 那是补充，不是问答通道：`notify_user` 不阻塞、不等回话，谁也没法在它上面回答你。

**为什么不是把 `ask_user_question` 给子代理（源码级事实）**：`ask_user_question` 按 preset 注册给调度者，而用户提问服务在带上调用者 agent 时只认 **live runtime root**；被委派的子代理会拿到 `DELEGATED_CALLER`，那句错误文本自己就规定了做法 —— 「human interaction is unavailable while the calling agent is owned by another live agent; **include the unresolved question or decision in the child agent's final result**」。所以**不要**指望把平台的 `ask_user_question` 交给子代理（它就在内置 deny 名单里，点名也进不去）。`ask_user` 不是绕过这条边界，而是**换一个真的 live root 去问**：子代理调它时，`adg-delegate` 用建立这个子代理时记下的那个**调度者实例**去调 `userQuestions.ask({ questions, agent: 调度者 })` —— 服务侧的每条断言照旧成立，卡片因此落在**调度者与用户对话的那个会话**里（也就是你正在看的这个），答复再顺着这次调用回到子代理手上。**已知限制**：那条"谁派了谁"的配对表活在插件的内存里，只在**同一个 dsh 进程**里认得出；重启 dsh 之后旧子代理若再调 `ask_user`，它会**如实抛错**、要求把未决问题写进最终结果（不会退化成"以它自己的名义问"那种看起来问过了却没人能答的状态）。

| 你的回答 | 调度者做什么 | 子代理做什么 |
|---|---|---|
| 「我去手动登录／过验证，已完成」 | 重新派发**同一个**浏览器子代理，带上它上一轮报的「CDP 端口 / profile 目录」与「用户已完成」 | **CDP 重连那个已有实例**继续，**不新开浏览器**（登录态在旧实例的 profile 里） |
| 「不想登录或验证」 | 停手，如实汇总「因为未登录，X 拿不到」 | 停手；不绕过、不换路径再试、不拿别的来源冒充 |
| 「试过了还是被挡」 | 停手，把结论交回你换方案（想再试就照常重派 —— 默认**不设次数上限**） | 停手，报「人工验证未通过」并说明还能换的方式；不自己反复催、也不换路径偷试 |
| 「换种方式」 | 走降级路径（静态抓取／换来源），或按你的替代方案另发一条委派 | 说明这次拿不到哪些内容 |

**人工介入没有次数上限。** 需要你本人做的事 —— 登录／验证码／二次验证／切换会话权限／要你拍板的选择／要你在本机某处操作 —— **想做几轮就几轮**，这条口径对**所有子代理、所有任务**都适用（不只浏览器）。它买的是"别把还能请你帮忙错判成已经没救了"，否则智能体会过早放弃、甚至**事前**就禁掉某条路径。**唯一例外是你自己提出的**：说过「不要打扰我 / 别问我」→ 需要介入时直接如实报「因为没有打扰你，X 拿不到」，不许换路径偷试；说过「只介入一轮」→ 该任务最多请你介入一次。真正该收手的判据只有两个：**你说不想做**，或**你自己试过仍被挡**。

**同一份信息默认只在一个站点取。** 浏览器操作很贵，而在两个以上站点取同一份信息基本等于把同一份材料买了 N 次。所以调度者**默认不会**要求同一个信息在两个以上站点各取一遍 —— 除非 ① 你明确要多源 / 对比 / 交叉验证，② 那个站点拿不到、或各站数据互相矛盾，③ 交付物本身就是跨站点比较（比价、同款选型）。真要多源时它会让**一个**子代理在**一条**委派里串行跑完再合并。

## 浏览器工具链与登录态资产

浏览器子代理用的不是"每个任务现写一个脚本"，而是仓库里的工具链：**一个入口** `cli.mjs`、**零依赖**（只用 Node 内建 + 全局 `fetch` / `WebSocket`，要求 Node ≥ 22）、**默认无头**（不抢焦点、不弹窗）、**实例活着就复用**。装完之后它在 `${DSH_HOME:-~/.dsh}/browser/`：

```powershell
node "$env:DSH_HOME\browser\cli.mjs" help        # 契约以它为准（选项、输出行、退出码）
node "$env:DSH_HOME\browser\cli.mjs" profile     # 排错第一站：profile / 端口 / 浏览器可执行文件 / 默认模式
node "$env:DSH_HOME\browser\cli.mjs" launch --url "https://example.com/a"     # 默认无头；活着的是同一种模式就复用（STATE=REUSED）
node "$env:DSH_HOME\browser\cli.mjs" status      # 活着吗、什么版本、现在哪种模式、开着哪些页
node "$env:DSH_HOME\browser\cli.mjs" launch --headed --url "https://example.com/login"   # 需要人登录时才用：优雅关掉无头实例，同 profile 同端口换成有头（STATE=SWITCHED）
node "$env:DSH_HOME\browser\cli.mjs" text --url "https://example.com/a" --out page.txt
node "$env:DSH_HOME\browser\cli.mjs" eval --file probe.js --match example.com
node "$env:DSH_HOME\browser\cli.mjs" tabs        # 看现在开着哪些页（清理前先看这个）
node "$env:DSH_HOME\browser\cli.mjs" close-tab --match hotels.ctrip.com   # 收掉自己开的那些页
node "$env:DSH_HOME\browser\cli.mjs" close       # 唯一让登录态落盘的动作
```

**默认模式为什么是无头**：日常自动化根本不需要人看窗口，而有头窗口会抢焦点、在任务里弹到你面前。**模式不是猜的** —— `/json/version` 的 `User-Agent` 里有没有 `Headless` 就直接决定了它是哪种模式（三家浏览器都成立，无需额外的状态文件）。想全局改默认值用环境变量 `ADG_BROWSER_MODE=headless|headed`（写别的值直接报错，**不静默回落**）；单次覆盖用 `--headless` / `--headed`。

**登录态是资产，不是每任务重来的消耗品。** profile 固定在 `${DSH_HOME:-~/.dsh}/browser-profile`、**与会话工作区无关**（工作区一换 profile 就换，正是"浏览器代理经常被登录拦住"的成因）。于是流程变成：第一次撞登录墙 → 你在那个有头窗口里登录一次 → 每次任务收尾 `close`（cookie 落盘）→ 之后同一个 profile 免登录。要沿用别处已有的 profile 就传 `--profile <绝对路径>`，**不要复制**目录。

**五条不变的行为**（不变量见 `browser/design.md`）：

| 行为 | 为什么 |
|---|---|
| `launch` 幂等：端口活着、模式也一致就 `STATE=REUSED`，**不重启** | 重启会丢内存里的会话态，而"你刚登录完"正是最不该被打断的时刻 |
| 换模式只能**显式**要求：`--headed` / `--headless` 才动手，且只有"活着的正好是另一种模式"时才换；换法唯一＝优雅关掉旧实例 → 等端口落下 → **同 profile 同端口**重开 | 静默统一模式会砸掉你刚登录的窗口；而"直接起第二个实例"根本不成立（同 profile 的第二个有头实例会把启动请求转交给活着的那个再自己退出，无头第二个直接硬失败） |
| 任务进行中**不 `close`**；只有本轮交互全部完成、你不再需要在窗口里操作时才 `close` | `close` 会关掉那个窗口；你可能正登录到一半 |
| 选页必须命中：`--match` / `--tab` 不命中就**报错**，不随便挑一页 | 静默挑错页会让"读到的内容"与"以为在读的内容"不一致 |
| **标签页不堆积**：`text/eval/shot --url <新地址>` 自己开的临时页读完自己收（`--keep` 才留）；存量用 `close-tab` 点名清；不点名不关、**也不许关到只剩 0 个页面** | "读得越多、页越乱"会留下成堆标签页；而关到 0 个页面等于绕过 `close`，你开着登录表单的页更绝不能被自动关掉 |

**边界（不做的事）**：不代填账号密码、不读取 profile 的 cookie 库、不做验证码识别与指纹伪装、不加 `--no-sandbox` 之类降权旗标、不引入 playwright / puppeteer；**不判断**哪一页"已经不需要了"。**登录永远由人在窗口里完成** —— 注意无头模式**没有可操作的窗口**，所以这一步的前提是先把模式升级成有头（同 profile 同端口，登录态留在原地）；无头与有头在受限令牌下**同样起不来**，所以升级模式并不能绕开"需要完全权限"那条硬约束。

## 怎么用

1. 新对话选择 **Adg PTC 模式**，直接说需求。
2. 调度智能体自己负责意图理解、任务拆解、调度与汇总，先判断范围再派发：

派给谁**按上面「子代理与能力带」一节那张表给这一带配 `tools`**（候选工具面、这一带的边界都在那张表里，本节不逐带重复）。只举三个对应关系示意：文件与文档（检索、整理、转换、生成）→ 文件与文档那一带的工具面；系统 / 硬件 / 设置 / 清理 / 故障排查、软件与 App 操作 → 系统与应用那一带；网页登录 / 填表 / 点击 / 多页抓取 → 网页那一带（**需本会话为完全权限**，不是的话调度者会先停下来问你；默认无头，要人工登录或过验证时才换成有头窗口）。

3. 需要多个子代理时（**材料不重叠才拆** —— 重叠就合并成一条），它在同一条回复里并行启动多个委派，而且**一律以后台方式派出**（`delegate` 的 `background` 缺省就是 `true`，不要改成前台）—— 只有后台的可续跑子代理才能被你在界面上发消息、随时停掉，也才能被调度者复用；前台调用会把这次委派降级成一次性运行，复用与"省重读"当场失效。后台不等于结果丢了：子代理结算时会带着收尾正文**唤醒**调度者，后续步骤照常接上，**没有可以阻塞的例外**。
4. 同一个代码库 / 文档库 / 站点的多个"方面"只要读的是**同一份材料**就合并成一条委派、让一个子代理一次通读并分节产出（只读侦察可以按方面并行）；同一实体的后续任务优先接给**已经读过它**的那个子代理（复用它的会话，省掉重读）。它接之前要看那个子代理的状态：子代理还在跑时发消息等于**插进它当前任务那一轮**，所以只有"修正／补充同一件事"才该现在发，"另一件事"要等它结算后再接给同一个它。
5. 每条委派都必须带**验收标准**与**本次不做**，而且派发前要过**必要性闸门**：答案不会改变交付物、又不在验收标准里的旁路**不派子代理**，只在最终答复里挂号「未纳入本次：X（可能影响 Y，未调研）」—— 省钱但不隐瞒。交付时它按**证据落点**（命令与退出码、文件位置锚、URL）逐条判定验收标准，**不拿子代理的"已完成"自报当达标**；未达标的要么返工，要么在交付里写明哪条没达标、缺什么。
6. 子代理的返回值只是给调度智能体汇总用的中间材料，不是给你的最终答复；最终交付由调度智能体整理后给出。
7. 它做的大产出会**分段交付**（先给结论 / 证据位置 / 未验证的梗概，再分段给大正文）：子代理的单条输出有上限，截断是正常结局（不是失败），被截断时调度者会把同一个子代理接回来续写，而不是重做一遍。

**为什么不设 token 预算**：本 preset **不压低任何体积旋钮** —— 上下文压缩阈值、单条工具结果的截断长度、检索与抓取的上限一律用插件**出厂默认值**，persona 里也不写"你能读多少 / 结论写多长"。理由：截断会把工具**已经取到**的事实切掉（模型只能重取、换查询或拿残缺证据下结论，三者都比不裁更贵）；提前压缩不可逆（过了压缩点一切只能基于摘要）；写在 persona 里的预算会把子代理的注意力从"把事情做对"挪到"别写太多"。成本控制改放在**编排层**（材料重叠才合并成一次委派、后续任务接给已经读过它的子代理、大材料走 digest、派发前过必要性闸门）与**输出纪律**（**面向用户的输出以人类可读性为第一原则**，范围＝直接答复 + 文档等一切用户看得到的成果；不回贴工具输出原文、同一结论只说一次、不转述中间过程、**"未验证 / 未纳入"必填块不许为求简短省略** —— **没有字数上限**）。这两层约束的是"派给谁、派几次、材料怎么中转、写下来的东西怎么组织"，不是"单个子代理能读多少、能写多少"。

## 怎么加一份能力

**没有智能体名册可加**：可复用的能力与经验都做成技能 —— 一个目录 `skills/<名字>/`，正文写在 `skills/<名字>/SKILL.md`，装到 `${DSH_HOME:-~/.dsh}/skills/<名字>/SKILL.md`。

技能按**渐进式披露**使用：调度智能体只把技能文件的**绝对路径**写进委派 prompt（不要内联、不要复述技能正文），子代理先 `read` 那份文件再动手 —— 技能正文因此不占调度者每次请求的固定前缀，谁用谁读。

**用户技能根是热加载的**：把技能目录放进用户根立即生效，不用重启 dsh。

改完在仓库里跑一次自检：

```sh
node tools/check-preset.mjs
```

通过（exit 0）即可。动了哪个模块就再跑那个模块的测试：`cd delegate && node --test test`、`cd browser && node --test test`、`cd desktop && node --test test`、`cd notify && node --test test`、`cd permission && node --test test`、`cd settings && node --test test`、`cd skill-inject && node --test test`（DSH 沙箱里一律加 `--test-isolation=none`）。自检还会核对承载体积旋钮的那三行是否完好（行在、包名对、没被关掉、`config:` 里没有插件不认识的键）；本 preset 刻意不覆盖任何旋钮，所以它打印出来的是插件出厂默认值。

## 设置页（Adg 设置）

装好 `settings/` 子插件并**重启 dsh** 之后，设置左栏会出现一页 **Adg 设置**（它只承载本仓库第一方子插件的行为开关）。当前它承载两组配置：

**通知（`adg-notify`，三项）**

| 配置项 | 默认 | 改掉 / 关掉之后 |
|---|---|---|
| 通知默认标题 | `DSH 通知` | 换成你认得出的标题；某一次 `notify_user` 自己带了 `title` 时按那次的来 |
| 响提示音 | 开 | 关掉之后静音弹出（那一次调用显式传 `silent` 也照旧） |
| 通知常驻 | 开 | 关掉之后按 **8 秒**存活投递（会写 `ExpirationTime`）；实测屏幕上在**约 17 秒内**消失（系统回收有粒度，见 `notify/testing-guide.md`）；开着＝常驻，直到你处理 |

**思考框架注入（`adg-skill-inject`，两项）**

| 配置项 | 默认 | 改掉之后 |
|---|---|---|
| 注入思考框架 | 开 | 关掉之后 Adg 调度者的系统提示词里不再有框架段（下一轮请求即生效，不用重启）。输入框左侧那颗「**超思**」开关改的就是这一个值，两处同步 |
| 自定义注入正文 | 空（＝跟随技能文件） | 填了就把这段文字当框架正文注入（**不再读** `skills/thinking-framework/SKILL.md`）；留空 / 全空白＝跟随技能文件；上限 20000 字符 |

**存在哪**：`${DSH_PROFILE_DIR:-${DSH_HOME:-~/.dsh}}/adg-settings.json`（**优先 profile 目录**；本机实际就是 `<profile>\adg-settings.json`，不是用户根那份。原子写；删掉它就回到出厂默认）。页面「当前生效」区逐项标出**这个值从哪来** —— 设置文件 / 插件 Config（行 `config:` 兜底）/ 内置默认，三层优先。**保存即生效、不用重启**：消费方每次调用都重新读那份文件（注入插件在每次组装系统提示词时重读，所以下一轮就换；输入框那颗「超思」开关同理，点一下就写进同一份文件）。

**它同时是一套框架**：加一项配置 = 在 `settings/lib/schema.mjs` 的 `FIELDS` 加一条登记（`key` / `kind` / `default` / 界 / `group` / `labelKey` / `hintKey` / `consumer`）+ 在 `settings/client.js` 的 `DICT` 补 zh / en 两条文案 —— 宿主半边、页面组件、路由与校验都不用动（客户端从 `fields[]` 拿界，不自己定义界）。**新配置项必须先问用户**：只有用户点名要的项才进 `FIELDS`；`adg-notify` 的 `appId` / `timeoutMs` / `scriptPath` / `powerShellPath` 这类**技术类键刻意不进页面**（本机路径或排错旋钮，暴露出来只会让人改坏）。要给某一项接上真正的消费方，先读 `settings/AGENTS.md` 与 `settings/design.md` 的「加一项配置的 5 步」。

## 故障排查

| 症状 | 先看这里 |
|---|---|
| 装完没有「Adg PTC 模式」可选 | 重启 dsh 了吗？装的是**能装 preset 的 profile** 吗（判据：该 profile 的 `dsh.profile.bundles` 含 `@deepseek-ai/dsh-web-app`）？ |
| 调度者手上根本没有 `delegate` 工具（开不了任何子代理） | 那个 profile 没装 `adg-delegate` 子插件。重跑 `install.*`，读回时确认 `adg-delegate` 三格齐；它是全局层工具，不在 preset 源文件里 |
| 某次委派里子代理没拿到注入的那几个上下文工具（`tools_note` 里逐条写着未生效） | 那个 profile 拿错了味道：生成物那段注入说明点名了它实际没装的插件。**这是该 profile 自己的味道选错，不是全局配置问题 —— 四种味道本来就允许共存**；重跑 `install.*` 让它按探测重选，或显式用 `--<组>=on\|off` 覆盖 |
| 子代理收到"去调 `compress` / `save_token_expand`"却没有这个工具 | 同上，反方向：该 profile 装了那个插件，却拿了 plain 味道。重跑 `install.*` 并确认 `node_modules/dsh-adg-ptc` 链接的是哪一份稳定目录 |
| 点名的工具名没进子代理的工具面 | 读 `delegate` 返回的 `tools_note`：那里逐条写着这次哪些点名的名字没生效（未注册 / 内置禁用） |
| `resolve('adg-ptc')` 的 `.broken` 非空 | 它报的就是起不来的那一行；最常见的是 composition 里的 `@deepseek-ai/*` 包名随 dsh 升级改了名（用旧名会报 `… never started`） |
| 改了预设但行为没变 | preset 改动**必须重启 dsh + 新会话**；`browser/` 才是"重跑安装即生效" |
| 浏览器起不来（命中 `browser/AGENTS.md` 的「红线」一节那三条沙箱失败签名里的任意一条） | 本会话不是**完全权限**。切到 `danger-full-access`，然后**新建委派**、或让调度者对那个已派出的子代理调一次 `set_child_permission`（已在跑的子代理不会自己跟上新权限） |
| `set_child_permission` 报「拒绝放大权限」或「不是你派出去的子代理」 | 那是它写在代码里的两条守卫，不是故障：前者是**你（调用方）自己当时就没那个模式**（`read-only` 给不出 `workspace-write`），先把本会话切上去；后者是目标不在你的 `listDescendants` 里 —— 号从 `list_agents` 取 |
| 浏览器子代理说没有可操作的窗口 | 当前是无头实例：需要你操作时用 `launch --headed` 换成有头（同 profile 同端口，登录态留在原地） |
| 手改源文件后在名单里写了个没注册的工具名 | `dsh-tools` 的 `restrict()` 遇到未知名直接抛 `names unknown global tool …`，那一次委派当场失败；回 `node tools/check-preset.mjs` 看它报哪一行（经 `delegate` 的 `tools` 点名的未知名不会走到这里，它们被逐条写进 `tools_note`） |
| 装的时候 `pnpm` 报文件被占用 | dsh 正在运行。要真正装/换依赖先关掉 dsh；脚本会如实报告并继续 |
| `install.ps1` 在 Windows PowerShell 5.1 上直接解析失败 | 检查文件前三个字节是否仍是 `EF BB BF`：这个脚本**必须保留 UTF-8 BOM**，没有 BOM 时 5.1 会按系统 ANSI 代码页读它、中文变乱码 |
| 设置里没有「Adg 设置」这一页 | 那个 profile 没装 `adg-settings` 子插件，或者装完没重启 dsh（插件是挂载期注册的）。重跑 `install.*`，读回时确认 `adg-settings` 三格齐（`node_modules` 真目录 + `dependencies` + `dsh.profile.bundles`）；重启后它出现在设置左栏 |
| 在设置页里改了通知三项，通知没变 | 三处按顺序看：①页面上「当前生效」区每项的来源是「设置文件 / 插件 Config / 内置默认」—— 写盘成功后再看它是否变成「设置文件」；②消费方是 `adg-notify`，它在**下一次 `notify_user` 调用**时才读设置文件（`${DSH_PROFILE_DIR:-${DSH_HOME:-~/.dsh}}/adg-settings.json`，本机在 profile 目录下）（不用重启，但也不会回头改已经弹出来的那条）；③那一次调用自己带了 `title` / `silent` 参数就会压过设置页 |
| 设置页一直显示「加载失败」 | 宿主半边没挂上：先确认那个 profile 的 `adg-settings` 三格齐、且重启过 dsh（`/api/adg-settings/settings` 是同源路由，另一个 profile 装没装不影响这一个） |
| 想知道某个结论"量过没有" | 先看本文末尾的「未观测」一节与各模块的 `**未观测**：` 条目；都没有的就是还没量过，别当成实测 |

## 许可

`preset` 的包清单（`preset/bundle.package.json`）与 `notify/`、`permission/`、`delegate/`、`settings/` 的包清单都声明 **MIT**。仓库里没有单独的 `LICENSE` 文件；以包清单里的字段为准。

## 未观测

**未观测就地写在它所属模块的文档里，本文不留副本、也没有集中台账**：要判"这条量过没有"，就去该模块的 `design.md` / `testing-guide.md` 里搜 `**未观测**：`，命中处紧跟的一行就是它的量法。跨模块的那几条（编排层规则是否被遵守、子代理 `running` 时会不会被插话、截断后是否接回续写、交付端是否逐条判定验收标准、不确定时是否先问用户）不按单个模块切分，所以就地写在 `preset/design.md` 与 `preset/testing-guide.md` 里。

**现行规范（引用任何结论前先看）**：**未观测不许写成实测，也不许写成"不可观测"** —— 每条未观测都必须给出量法与可复跑的判据。引用别人记载的实测必须写明来源，**不得写成自己验证过**。版本区文档只描述当前项目状态，不写变更叙述 —— 变更史由 git 提交历史承担。

## 给 AI 的安装指令

1. `git clone <repo-url> <tempdir>`
2. **生成 bundle**：`node <tempdir>/tools/gen-preset-bundle.mjs bundle/adg-plain`（plain；`--with-billion-context` = bili、`--with-save-token` = save-token、两个旗标叠加 = `bili+save-token`）。输出目录是位置参数；**不传位置参数才**落到缺省 `<tempdir>/bundle/adg-ptc/`，两种写法别混。它读 `preset/preset.yml`（显示元数据）+ `preset/agent.cordis.yml`（插件条目列表）+ `preset/bundle.package.json`（包清单模板），写出 `{cordis.patch.yml, package.json}`。**`bundle/` 是构建产物（在 `.gitignore` 里），任何情况下都不要手改生成物** —— 要改就改 `preset/` 下的源文件再重跑。目标 profile 装着哪个注入组就装哪个味道的产物（**手工装的时候别只装 plain**）；生成完顺手 `node <tempdir>/tools/check-bundle-flavor.mjs <那份文件> <味道键>` 验一遍。
3. **判断每个 profile 该拿哪个味道**：先 `node <tempdir>/tools/has-bundle.mjs "$DSH_HOME/profiles" <profile>` 逐组问一遍（缺省探测 billion-context，换组加 `--package=dsh-plugin-save-token`），再用 `node <tempdir>/tools/resolve-flavor.mjs --<组> …` 翻成"味道键 / 稳定目录名 / gen 旗标"。**每个 profile 只装它该拿的那一份**，不要把多份都链接进同一个 profile。
4. **装 bundle**：用 `plugin_manager` 的 `install_bundle`，`target` 给 bundle 目录的绝对路径 —— 包安装与 `dsh.profile.bundles` 选中由它自己完成，**不要**用 shell 命令复刻这两步。想让"仓库被删/被挪也不影响已装好的 dsh"，先把生成物整个拷到**它自己的稳定目录**（`${DSH_HOME:-~/.dsh}/bundles/` 下；**目录名不要写死**，以 `tools/flavors.mjs` 的 `dirNameFor(key)` 为准），再拿那个稳定目录当 `target`（`install.ps1` / `install.sh` 就是这么做的）。装完 `list_bundles` 里应能看到 `dsh-adg-ptc`。
5. 复制 `<tempdir>/skills/` 下**所有**技能目录 → `${DSH_HOME:-~/.dsh}/skills/<名字>/`（`install.*` 的对应步骤做的就是这件事）。
6. **装 `notify/` 子插件**：把 `notify/` 拷到一个稳定副本，然后 `dsh plugin --profile <p> add "file:<稳定副本>"`，并读回该 profile 的清单确认它真的在（`install.*` 的第 2b / 4c / 4c-1 步做的就是这个）。
7. **装 `permission/` 子插件**：同样拷一个稳定副本 + `dsh plugin --profile <p> add "file:<稳定副本>"` + 读回该 profile 的清单确认三格齐（`install.*` 的第 2b-1 / 4c-2 / 4c-3 步做的就是这个）。它**不会**出现在任何子代理的工具面里（`set_child_permission` 在内置 deny 名单上）—— 只有调度智能体用。
8. **装 `delegate/` 子插件**：同样拷一个稳定副本 + `dsh plugin --profile <p> add "file:<稳定副本>"` + 读回该 profile 的清单确认三格齐（`install.*` 的第 2b-2 / 4c-4 / 4c-5 步做的就是这个）。它是**唯一的委派入口**：只装 preset bundle 而漏装它，调度者手上没有任何能开子代理的工具；它也**不会**出现在任何子代理的工具面里。
9. **装 `settings/` 子插件**：同样拷一个稳定副本（8 个文件：`index.js` / `client.js` / `lib/schema.mjs` / `cordis.patch.yml` / `package.json` / `AGENTS.md` / `design.md` / `testing-guide.md`）+ `dsh plugin --profile <p> add "file:<稳定副本>"` + 读回该 profile 的清单确认三格齐（`install.*` 的第 2b-3 / 4c-6 / 4c-7 步做的就是这个）。它注册的是「设置」里那一页 **Adg 设置**；没装它只是少一页设置，通知仍走出厂默认。
10. **装 `skill-inject/` 子插件**：同样拷一个稳定副本（9 个文件：`index.mjs` / `client.js` / `lib/section.mjs` / `lib/user-settings.mjs` / `cordis.patch.yml` / `package.json` / `AGENTS.md` / `design.md` / `testing-guide.md`）+ `dsh plugin --profile <p> add "file:<稳定副本>"` + 读回清单确认三格齐（`install.*` 的第 2b-4 / 4c-8 / 4c-9 步做的就是这个）。它**不注册任何工具**：在 agent 创建时判定「Adg 调度者」（会话头 `origin` 非 `subagent` 且 preset 为 `adg`），是就把思考框架技能 `skills/thinking-framework/SKILL.md` 的**正文**直接注入调度者的系统提示词 —— 不依赖模型自觉 read；子代理与其他 preset 的会话一律不注入。它依赖第 5 步拷的技能文件；正文与开关**每次组装系统提示词时重新求值**（设置页改完下一轮就换）。
11. **拷两个本机操作工具链**：`<tempdir>/browser/` → `${DSH_HOME:-~/.dsh}/browser/`、`<tempdir>/desktop/` → `${DSH_HOME:-~/.dsh}/desktop/`（`install.*` 的第 2 / 2c 步做的就是这个：**先删后拷整个目录**）。两者都是用户根下的普通文件，重跑安装脚本即生效、**不用重启**；但 `desktop/` 还有前提 —— 要真正驱动普通用户窗口，**调用它的那一次会话必须是完全权限**，否则 UIPI 会静默拦下合成输入。
12. **校验（只有真实挂载算证据）**：挂一个注入 `agentPresets` 的临时插件，按「真实挂载验证」一节那三条判据核 —— `.broken` 必须为空、`list()` 里能看到 `adg`、`compositionInventory()` 里**恰好一条**启用委派行（`agent`）且没有 `tool-subagent-fork` 行（它报的是**模块名**：`@deepseek-ai/dsh-tool-subagent` 出现 3 次＝1 条启用 + 两条 `disabled: true`，按"出现次数 = 委派行数"断言会误报失败）。也可以直接 `node <tempdir>/tools/check-preset.mjs`（exit 0 表示通过），但它只是**文本扫描器**，上面那条真实挂载的校验不能省。
13. 明确告诉用户：**preset 改动与五个子插件（`notify/` / `permission/` / `delegate/` / `settings/` / `skill-inject/`）都按"重启 dsh + 新会话"验收**（已挂载的会话不会中途换组合）。重启后在新建对话里选择「Adg PTC 模式」。
14. 明确告诉用户：可复用的能力/经验都做成 `skills/<名字>/SKILL.md`，装到 `${DSH_HOME:-~/.dsh}/skills/` 后**热加载、立即生效、不用重启**；要让某次委派用上某份技能，就把它的**绝对路径**写进委派 prompt、要子代理先 `read`。
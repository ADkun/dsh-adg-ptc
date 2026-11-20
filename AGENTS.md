# AGENTS.md — dsh-adg-ptc

Adg PTC 模式：一份 DSH agent preset（一个调度智能体 + 它按需派出的通用子代理；子代理的目标、边界、验收标准与工具面都在委派那一刻由调度者经 `delegate` 现给，没有固定专家名册），外加两条本机操作工具链（`browser/`：无头 Chromium 系浏览器驱动；`desktop/`：零依赖 Windows 桌面操控 CLI）、八个仓库内部第一方子插件（`notify/`→`notify_user`、`delegate/`→`delegate`+`ask_user`、`settings/`、`skill-inject/`、`ptc-parallel/`、`turn-bookmarks/`、`harness-identity/`、`sandbox-notice/`；后六个不注册工具）、八份用户技能（`skills/`，其中 `thinking-framework` / `execution-framework` 的正文由 `adg-skill-inject` 注入调度者）、一个静态自检脚本与一个 bundle 生成脚本、两个安装脚本。每个模块的职责、包名、注册的工具与红线见其 `AGENTS.md`；文件在哪、改一块读哪份用 `aoci` 定位（见文末「认知与导航」）。

本文件是**给改这个仓库的人/agent 看的常驻约束**：只写命令、红线、生效方式、外部依赖 ref 规则、质量门与能力边界；模块在哪、改一块读哪份文件这类导航交给 `aoci` 索引（见文末「认知与导航」）。**给人看的项目总览与安装/使用说明在 `README.md`**（改任何东西之前先读它对应的小节）。

## 命令

零运行时依赖；只要求 Node（`browser/package.json`、`desktop/package.json`、`notify/package.json`、`delegate/package.json`、`skill-inject/package.json`、`ptc-parallel/package.json`、`turn-bookmarks/package.json` 与 `harness-identity/package.json` 都声明 `>= 22`）。仓库根没有 `package.json`、没有 monorepo 构建、没有 lint 配置。

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
4b. **禁止把 `agent` / `delegate` / `workflow` / `ralph` / `ask_user_question` 从 `adg-delegate` 的 `BUILTIN_DENY` 里去掉或放宽，也禁止经 `delegate` 的 `tools` 把它们发给子代理。** 子代理能再委派就破坏一跳可达的链路（孙代理对调度者不可见、不可 steer），并让承载编排约束的那几段 `## 约束` 整段失效。`ask_user` **不在**这条名单里（`adg-delegate` 注册的第二个工具，子代理唯一的提问通道，owner 是派它的那个调度者）—— 禁止把它加进 `BUILTIN_DENY`，也禁止改用平台的 `ask_user_question` 让子代理问人。载体：`tools/check-preset.mjs`（`MUST_BE_AVAILABLE_TO_CHILDREN` 判 `ask_user` 是否被 deny）+ `cd delegate && node --test test`。
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
| `skill-inject/` 任何文件 | 重装子插件 + **重启 dsh** + **新 Adg 会话**（步骤号见 `install.ps1` / `install.sh` 的 2b-4 / 4c-8 / 4c-9；运行中的旧 agent 不补挂 —— section 在 agent 创建那一刻注册） | `cd skill-inject && node --test test`；再在新 Adg 会话里核对系统提示词出现下拉选中那份技能文件的正文（出厂＝执行框架正文首行「### 执行框架 BEGIN」）、派出的子代理系统提示词里默认没有它（`skillInjectSubagent` 默认关；打开后子代理也有，不需重启，判据见 `skill-inject/testing-guide.md` 的 M 系列） |
| `ptc-parallel/` 任何文件 | 重装子插件 + **重启 dsh** + **新会话**（步骤号见 `install.ps1` 的 2b-6 / 4c-12 / 4c-13；运行中的旧 agent 不补挂 —— section 在 agent 创建那一刻注册；子代理的 scope 同样会被判定） | `cd ptc-parallel && node --test test`；再在新 PTC 会话里核对系统提示词出现「## PTC 并行执行（一次 run_code 里多做）」段、派出的子代理系统提示词里**也有**这一段（判据见 `ptc-parallel/testing-guide.md` 的 M 系列） |
| `turn-bookmarks/` 任何文件 | 重装子插件 + **重启 dsh** + **新会话**（步骤号见 `install.ps1` 的 2b-7 / 4c-14 / 4c-15；`install.sh` 不管本模块） | `cd turn-bookmarks && node --test test`；再在重启后的新会话里聊过 3 轮、收藏一轮，核对右侧轨道条变粉、左键点它跳到该轮、右键点它切换收藏、正文提问行左侧出现粉线（判据见 `turn-bookmarks/testing-guide.md` 的「未观测项」） |
| `harness-identity/` 任何文件 | 重装子插件 + **重启 dsh** + **新会话**（步骤号见 `install.ps1` 的 2b-8 / 4c-16 / 4c-17；运行中的旧 agent 不补挂 —— section 在 agent 创建那一刻注册；`install.sh` 不管本模块） | `cd harness-identity && node --test test`；再在新 Adg 会话里读系统提示词，确认开头没有 `You are an AI agent, powered by DeepSeek Harness.` 一行（子代理也无，判据见 `harness-identity/testing-guide.md` 的 M1 / M2） |
| `sandbox-notice/` 任何文件 | 重装子插件 + **重启 dsh** + **新会话**（步骤号见 `install.ps1` 的 2b-9 / 4c-18 / 4c-19；运行中的旧会话不补挂 —— `tools/post-execute` 监听在插件加载时挂上；`install.sh` 不管本模块） | `cd sandbox-notice && node --test test`；再在重启后的新 Adg 会话里跑一次 `run_code`，确认结果末尾不再有 `File sandbox enforcement is partial on this host.` 一行（判据见 `sandbox-notice/testing-guide.md` 的 M1 / M2） |
| `delegate/` 任何文件 | 重装子插件 + **重启 dsh** + 新会话（装进 profile 的步骤号见 `install.ps1` / `install.sh` 的 2b-2 / 4c-4 / 4c-5 步） | `cd delegate && node --test test`；再在新会话里让调度者用一次 `delegate`（给 `description` / `prompt` 与要拿的工具名），核对返回的 `tools` / `tools_note` 与子代理实际拿到的工具面 |
| composition 里写的 `@deepseek-ai/*` 包名 | 包名会随 dsh 升级**改名**，改完必须真实挂载 | `agentPresets.resolve('adg-ptc')` 的 `.broken` 为空；用旧名会报 `… never started` |
| `browser/` 任何文件 | **重新跑一次 `install.*` 即生效，不用重启** —— 它是用户根下的普通文件，不是 preset 也不是插件 | `node "${DSH_HOME:-~/.dsh}/browser/cli.mjs" profile` |
| `desktop/` 任何文件 | 同 `browser/` 口径：**重跑一次 `install.*` 即生效，不用重启**（用户根下的普通文件）；但真正驱动普通用户窗口的那一次会话必须跑在完全权限（`danger-full-access`）下 —— 受限会话的 Low 完整性级别会被 UIPI 拦下且**静默丢事件**（细节见 `desktop/AGENTS.md` 的「生效方式」节） | `node "${DSH_HOME:-~/.dsh}/desktop/cli.mjs" profile`；注入类命令只认 `CHANGED=true` 与 `CURSOR_LANDED=true` |
| 本仓库任何 `.md` 文档 | 立即生效（只是文件） | 按 `adg-doc-criterion` 技能自检；并跑 `node skills/adg-doc-criterion/scripts/check-docs.mjs .` 与 `aoci check` |

## 外部依赖与 ref 解析

外部依赖的**能力与接口**一律按契约制品引用（包名 + 配置键名 / 导出符号名 / 契约文件名，可 grep），不引对方文档、不引实现行；**版本字面量只在本节的表里出现**，其余文档写"以本节的解析结果为准"，这样本机一直升到最新版时只改这一处。指向对方仓库的文件时用 `<org>/<repo>@<ref>:<path>` 形式，**禁止裸 `main` / `HEAD`**（对方一改就静默指向别处）。

| 依赖包名 | 解析命令（运行时取值） | 当前解析结果 | 引用形式示例 |
|---|---|---|---|
| `@deepseek-ai/dsh` | 版本：`dsh --version`；仓库句柄的 `<ref>`：`git ls-remote --tags https://github.com/deepseek-ai/deepseek-harness "dsh-v*"`（取输出**最后一条**的 tag 名） | 版本 `0.2.2-rc.1`；tag `dsh-v0.2.2-rc.1` | 版本：`@deepseek-ai/dsh@0.2.2-rc.1`；上游句柄：`deepseek-ai/deepseek-harness@dsh-v0.2.2-rc.1:<path>` |
| `@deepseek-ai/dsh-*`（`dsh-subagent` / `dsh-tool-subagent` / `dsh-compaction-basic` …） | `node -p "require('<该 profile 的 node_modules>/@deepseek-ai/dsh-*/package.json').version"` | 与上面同一个值 | 正文只写契约名（如 `toolFilter.allow`、`restrict()`、`auto`），要写版本时写"同 `@deepseek-ai/dsh` 的解析结果" |

- **ref 的派生规则**：上游 tag 名 = `dsh-v` + `dsh --version` 的值（**不是** `v<版本>` —— 形状实测全是 `dsh-v*`）。升级后按解析命令重取，不要手抄。
- **无仓库可引的本机插件**（`dsh-plugin-save-token`、`billion-context`）：只引契约制品或版本号，例如 `dsh-plugin-save-token` 的 `package.json` 里 `dsh.bundle.patch = ./cordis.patch.yml`、`billion-context` 注册的全局工具名 `compress` / `acp_status`。
- 包名会随 dsh 升级**改名**，所以每次升级后按本表重核一遍 composition 里的包名 —— 改名会让整份 preset 变成 `broken` 而不可用。

## Quality Gates

| 检查项 | 载体 | 期望结果 |
|---|---|---|
| preset 源文件的静态合规 | 机检：`node tools/check-preset.mjs` | exit 0。**允许 WARN**；ERROR 的含义只有一个 —— 这次委派必然抛错。跑完读它自己打印的摘要行，**不要把读数写进文档**（取值范围与结构性判据都在脚本里，读数会漂） |
| 四种味道的生成物都注入正确 | 机检：四条 `gen-preset-bundle.mjs … && node tools/check-bundle-flavor.mjs … <味道键>`（完整四条见 `preset/AGENTS.md` 与 `tools/AGENTS.md` 的「命令」节；**改了 `preset/agent.cordis.yml` / `tools/gen-preset-bundle.mjs` / `tools/flavors.mjs` 时必须跑**） | 四条都 exit 0。`check-preset.mjs` 只看源文件，产物是它的盲区，只跑 plain 证明不了注入生效 |
| preset 真的挂得上 | 机检：按 `README.md`「真实挂载验证」一节做一次**真实挂载** | `agentPresets.resolve('adg-ptc')` 的 `.broken` 为空，且委派行**恰好一条、`toolName` 唯一**。静态自检证明不了挂载 |
| 浏览器工具链 | 机检：`cd browser && node --test test`；改了 `browser/` 再按 `browser/testing-guide.md` 的「交付前的最小闭环」一节跑一次真机闭环 | 单元测试全绿；真机闭环每步的 `STATE=` 与期望一致 |
| 通知子插件 | 机检：`cd notify && node --test test` | 全绿（零依赖，不弹窗） |
| 注入插件 | 机检：`cd skill-inject && node --test test`（纯函数，零依赖）；改了判据或接线再在**新 Adg 会话**里按 `skill-inject/testing-guide.md` 的 M1–M10 核（调度者有框架段且与下拉选中的框架一致 / 子代理默认没有（`skillInjectSubagent` 打开后有，且不需重启）/ 其他 preset 没有 / 设置页改正文或换框架下一轮就换 / 输入框「注入」chip 能关能开且与设置页同值） | 单元测试全绿；M1–M10 与期望一致 |
| 委派插件 | 机检：`cd delegate && node --test test`（沙箱里加 `--test-isolation=none`）；再在**新会话**里让调度者真用一次 `delegate` | 单元测试全绿；返回的 `tools` / `tools_note` 与子代理实际拿到的工具面一致（点名未知名要被逐条剔除并记进 `tools_note`，点 `run_code` 当场抛错） |
| PTC 并行提示插件 | 机检：`cd ptc-parallel && node --test test`（沙箱里加 `--test-isolation=none`）；改了判据、section 或正文再在**新 PTC 会话**里核对系统提示词出现「## PTC 并行执行（一次 run_code 里多做）」段（子代理那侧也应有） | 单元测试全绿；动态工具清单随各 agent 当前可见的工具变化（清单不写死在正文里） |
| 轮次书签插件 | 机检：`cd turn-bookmarks && node --test test`（沙箱里加 `--test-isolation=none`）；改了选择器或映射再在**重启后的新会话**里按 `turn-bookmarks/testing-guide.md` 的「未观测项」逐条核（轨道变粉 / 点击跳转 / 正文粉线 / 星标出现与取消 / 刷新后仍在） | 单元测试全绿；未观测项逐条与期望一致 |
| 去除开场白插件 | 机检：`cd harness-identity && node --test test`（沙箱里加 `--test-isolation=none`）；改了覆盖机制、section 名或判定再在**重启后的新 Adg 会话**里核对系统提示词开头没有 `You are an AI agent, powered by DeepSeek Harness.` 一行（调度者与子代理两侧都看） | 单元测试全绿；调度者与子代理都没有该行、且无多余空行 |
| 沙箱噪声去除插件 | 机检：`cd sandbox-notice && node --test test`（沙箱里加 `--test-isolation=none`）；改了剥除判据或末尾判定再在**重启后的新会话**里跑一次 `run_code`，看结果末尾不再有那句、正文其它字符不变 | 单元测试全绿；正常成功与被拒绝（denied）两种情形都只少该删的那句 |
| 设置页框架 | 机检：`cd settings && node --test test`（沙箱里加 `--test-isolation=none`）与 `cd notify && node --test test`（消费方契约在两边各钉一份，改任一侧都要两边都绿）；再在**重启后的 dsh** 里点左侧边栏「扩展」区的「Adg 设置」入口看该页 | 两边单元测试全绿；页面能读当前生效值（含来源）/ 改一项保存 / 恢复默认，刷新后仍然生效 |
| 桌面工具链 | 机检：`cd desktop && node --test test`（沙箱里加 `--test-isolation=none`）；改了注入路径再按 `desktop/testing-guide.md` 的「交付前的最小闭环」在**完全权限**会话里跑一次真机闭环 | 单元测试全绿；真机闭环每步的 `CHANGED=` / `CURSOR_LANDED=` 与期望一致（只用 `--dry-run` 证明不了注入） |
| 文档合规 | 机检/评：`node skills/adg-doc-criterion/scripts/check-docs.mjs .` + `aoci check`；再按 `adg-doc-criterion` 技能的质量红线清单逐条自检 | 两套机检都 exit 0；行数在技能给的预算内（aoci 托管块不计）；判据与 why 齐全、不与 aoci 导航重复 |
| 文档里的引用真实存在 | 机检：先取出文档里全部反引号路径引用与链接目标，再逐条判存在（不要抽查几条） | 全存在。命令逐条敲一遍；被 `.gitignore` 排除的临时工作目录只许以反引号路径提及，不许做链接（落点与口径见 `adg-doc-criterion` 技能的「过程与状态文件」一节：`docs-work/`） |

**能力的边界（不许越界宣称）**：`tools/check-preset.mjs` 是**逐行文本扫描器，不是 YAML 解析器** —— 它证明不了文件能被 YAML 解析，也证明不了 preset 真的挂载。**未观测的结论不许写成实测，也不许写成"不可观测"**：每条未观测项必须就地写成一行 `**未观测**：<问题>；量法：<怎么测>`（不设集中台账，要判"量过没有"就搜 `**未观测**：`），引用别人记载的实测必须写明来源、不得写成自己验证过 —— 不然下一个读者会把没量过的东西当前提用。

## 认知与导航（aoci）

仓库的文件清单、模块职责、"改某块读哪份"这类导航与检索由 **aoci** 索引承担；本文件与各模块文档只管真相与判据，不自建 Project Map、文件目录或场景路由（避免与 aoci 双写漂移）。

- **分工（防漂移铁律）**：同一事实只有一个家 —— `design.md` / `testing-guide.md` 放当前真相、不变量、状态机、接口、验收判据与红线理由；aoci 每个文件一条 Entry，只回答"在哪 / 改哪份 / 谁是相关方"，条目只概括 + 指针、不复制实现细节。
- **接缝**：`aoci init` 会在本文件末尾追加一段托管块（以 aoci 自身的 begin/end 注释包裹，约 100 行）。它**不计入行数预算**（机检已排除），也**不要手改托管块内部** —— 用 `aoci maintain` 更新。
- **改完文档的验证**：`node skills/adg-doc-criterion/scripts/check-docs.mjs .` 与 `aoci check` 都要 exit 0；改了受管文件先 `aoci scan` / `aoci maintain` 再 `aoci check`，否则索引与文档会 stale。

<!-- aoci:begin -->
## AOCI 仓库认知

AOCI 为本仓库维护一个稳定、可版本化、可增量更新的仓库级认知层，供模型跨任务复用对系统的理解。

`aoci.txt` 是面向模型的结构化认知索引。它以每个受管理文件、数据库表或其他受管理对象一条独立 Entry 的方式，用符号标签与 F/R/A/S 语义表达对象的核心职责、重要关系、对外契约，以及理解或修改系统时必须知道的非显然约束和设计决策。

Header、目录段和全部 Entry 共同组成完整仓库索引，可以覆盖前端、后端、配置、数据库结构及其他受管理内容。受管理内容发生变化时，通常只需维护受影响的认知条目，不需要重新生成整个索引。

AOCI 提供系统架构、对象职责、重要关系、对外契约和关键约束的高密度视图。

### 工作原理

AOCI 采用“模型生成、模型读取”的认知闭环。

Header、Entry 和 Curation 语义的创作只按当前机器签发的 Plan 与实时 Guide 执行；由 Host 模型基于当前绑定证据独立完成。

Entry 的语义必须来自模型对真实证据的理解。不得仅依据路径、文件名、扩展名、AST、符号列表、依赖扫描、正则、固定模板或规则引擎推导、预填、拼接或改写索引语义。

对 Fresh Bootstrap，只按当前机器签发的 Plan 和实时 Guide 执行。当它们要求创作时，Host 模型创作 Root、Meta、Tag 和 F/R/A/S，提供 authoring-run 声明，并把它绑定到 Plan、Evidence 与完整 Candidate。不得要求 AOCI 填写 `origin=host_model`、制造 Receipt 或把程序生成的 Framework 当作语义。本文件不自行重建 Onboarding 流程。内部批次不是用户决策；只有遇到既有批准边界或真实的安全、漂移、CAS、Recovery 条件才停止。

### 最小使用入口

- `aoci_rules`：取得当前AOCI版本的会话运行合同。
- `aoci_overview`：建立或恢复本仓库的完整认知。
- `aoci_maintain`：受管理对象达到最终稳定状态后检查认知是否需要维护。
- `aoci_update_entry`：提交与当前证据和源码摘要绑定的完整语义更新批次。
- `aoci_report`：仅当当前布局和工具状态支持时，在证据不足、无法可靠生成语义时登记待办，不猜写。

其他MCP工具、CLI命令、参数和专项流程，以当前工具说明、Guide和 `--help` 返回内容为准，不在本文件中重复完整手册。

本区块只规定仓库接入、认知使用和收尾原则。`aoci_rules` 承载当前会话合同，Guide实时输出承载当前Plan的执行顺序与停点，工具Schema、Spec和Validator承载机器结构与判据；Prompt、Description、README和静态文档不能覆盖这些机器事实。

### 建立、生成和恢复认知

1. 每个新的 Agent Run 开始时，应先判断：

   - 本仓库是否已经存在可用的完整AOCI索引；
   - 当前上下文中是否已有与本仓库根、当前索引版本和当前AOCI服务相匹配，并且模型仍可可靠使用的完整仓库认知。

2. 仓库已经存在可用的完整索引，但当前Run没有可靠完整认知时，先调用 `aoci_rules`，再调用 `aoci_overview`。

   完整认知仍可靠时直接复用。局部不确定本身不要求机械重读系统全貌。

   本Run从已知Host上下文压缩恢复时（包括宿主注入的压缩摘要），必须把此前模型认知视为不可靠。压缩handoff不得保留或摘要正式Whole-Index，也不得保留或摘要任何Overview Header、Entry、Chunk、Challenge或Attestation正文；只能保留安全续接所需的receipt身份、未完成write或Recovery状态，以及立即重载指令。复制进handoff的Whole-Index语义或receipt不能证明恢复后模型的当前认知可靠。若当前上下文已无法可靠保留运行合同，先调用 `aoci_rules`。继续业务任务前，使用 `refresh_reasons=["context_compaction"]` 和新的 `refresh_event_id` 调用普通完整Whole-Index `aoci_overview`（不设置 `check_only` 或设为false）；不得使用 `check_only` 或认知probe。原样跟随每个 `next_cursor` 直到 `completed=true`，确认交付，并且只基于新交付正文提交一次Attestation。完成这次新的完整传输后，即使Attestation为partial或fail也消费该generation，并按既有合同继续source-bound任务，不再自动调用第二次Overview。

   AOCI可以针对 `context_compaction`、项目 `cognition_refresh_threshold` 下的机器 `semantic_threshold` 或主要 `phase_transition` 提供checkpoint与认知状态事实。只需要这些紧凑事实时使用 `check_only=true`；这些事实只向Agent提供建议，不替模型决定是否需要系统全貌。

   Agent显式调用普通 `aoci_overview`（未设置 `check_only` 或为false）时，只要能形成一致的CognitionSet，AOCI必须完整交付请求scope。不得因为已有receipt、阈值未达到或没有待处理刷新原因而抑制正文。正式认知Dirty或Stale时仍交付正文，但必须标记不可靠。存在未决恢复或无法形成一致snapshot时失败关闭，不返回混合正文。

   普通Overview返回 `continuation_required=true` 时，必须原样提交 `next_cursor` 并自动继续到 `completed=true`。不得询问用户、开始业务任务或给出阶段性系统结论。Host截断、缺块、重复、乱序、cursor失败、Index变化或`chunk_tokens`变化时停止本次认知链。Attestation完成前不得用Memory、源码、Spec、`aoci.txt`、历史会话、scope、search或Entry读取修补或补充Whole-Index认知。Challenge ordinal是正式Entry序列中的1-based位置；Header内容、注释、空行、Section/Overview/Chunk Marker、Receipt与Metadata均不计数，Chunk Receipt ordinal使用同一序列。Attestation必须原样回绑本次Challenge发布的当前`index_sha256`、`entry_sequence_sha256`与`entry_count`；旧Index、旧Entry序列、旧数量或旧Attestation均无效。完整链结束后只正式提交一次既有模型认知Attestation；同一响应只允许一次不改变语义答案的JSON Schema或字段格式修正。对象、Tag或F不匹配即失败且认知吸收不确定，不得语义重试或旁路补答。首次认知失败时还不得执行Root/Meta、Migration、全局布局或其他未重新绑定的系统级决策。上下文压缩刷新若传输完整、认知身份不变、治理对齐且没有Recovery或第三方冲突，即使Attestation为partial或fail也消耗该refresh generation，并继续原任务，不再自动重读Overview。`system_mastery_percent`只自评系统框架——架构、职责、强关系、稳定外部契约以及高熵安全和维护约束——不表示完整实现或运行实况知识；机器索引覆盖率必须分开。默认只向用户输出由本次真实覆盖率、Challenge、块数、Token和掌握度生成的规定成功或失败一句话。Host截断时提示用户把 `overview_delivery.chunk_tokens` 设置为更小的合法值后重新开始，不得自动修改。

   加法认知等级必须与严格证明字段分开解释。`delivery_verified`表示已加载Index且Host交付已确认，但完整认知验证仍未完成；应表达为“已加载且交付已验证”，不得描述为“没有认知”或“没有理解系统”。`cognition_verified`要求Attestation通过（Challenge至少80%的ordinal完全正确且对象身份至多失手一处），`cognition_governed`还要求治理对齐。通用完整读取失败句只用于真实交付故障。

   当Overview响应包含可选`cognition-state/v2`投影时，必须分别解释各维度。其Level止于`model_cognition_usable`；`strict_attestation_verified`、`governance_aligned`与`current_system_cognition_reliable`都是独立状态，绝不参与该Level。ordinal、对象身份、Tag或核心F不匹配可以导致严格Attestation失败，而模型认知仍然可用；不得仅凭这种不匹配就宣称模型没有理解系统。只有`current_system_cognition_reliable=true`允许无保留地声称当前完整系统认知可靠。投影缺失时继续使用上述Legacy解释。

   普通的只读审计、分析、检查、不修改代码或不提交、不push，不自动等于严格零写入，也不改变上述认知有效性判断。Codex Memory和历史Skill只能辅助恢复经验、用户偏好与调查方向，不能替代与当前仓库根、索引摘要、AOCI服务身份和认知范围匹配的当前认知收据；项目AGENTS和当前AOCI身份在AOCI状态上优先于历史Memory。

   只有用户明确禁止Ledger、元数据、`.aoci`运行资产及任何文件写入时，才按严格零写入处理。若必要的认知建立与该边界冲突，必须报告冲突并请求用户裁决或建议使用隔离副本，不得静默以Memory替代当前仓库认知。

3. 仓库没有可用的完整索引，或当前只有最小骨架、Header不完整、Entries未完成、必要Curation尚未裁决时，如果需要建立正式完整AOCI索引，先取得 `aoci_rules`，然后进入当前AOCI Guide。由Guide依据仓库真实状态决定下一阶段并完成必要安全步骤。

   `aoci_maintain` 不替代索引建立流程。

   不在本文件中自行重建或硬编码完整索引生成状态机。

4. 在长程任务中，模型负责保留当前认知收据并正确使用刷新门禁：

   - Host报告上下文压缩或模型已知系统全貌丢失时，执行上述强制 `context_compaction` 重载规则；AOCI不能自行推断Host事件；
   - 进入真正的主要阶段时声明 `phase_transition`，不得把函数、测试运行或小步骤当作阶段；
   - 在有用的稳定检查点通过 `check_only=true` 取得机器语义计数；
   - 除已知压缩的强制重载外，由Agent判断当前任务是否需要再次显式获取指定scope或完整Overview；
   - 在维护和对齐完成前，保留AOCI报告的Dirty或Stale可靠性状态。

### 任务收尾与认知维护

5. 纯只读问答、分析、版本核验，或没有产生受AOCI管理对象变化的任务，不需要调用维护工具。当前AOCI版本是任意`aoci_overview` check_only或`aoci_maintain`响应里的`cognition_receipt.mcp_service_version`；二进制路径是项目`.mcp.json`里的`command`，CLI不必在PATH上。

6. 发生受AOCI管理对象变化时，待其达到本次任务的最终稳定状态后，只调用一次 `aoci_maintain`。不要在每次中间修改后逐文件维护。

7. 若维护结果返回真实语义候选，Host 模型必须基于每个候选绑定的对象和必要证据，独立创作完整标签与F/R/A/S更新。通过 `aoci_update_entry` 一次提交当前机器签发批次的完整候选集合，同时原样保留每项 `source_sha256`、`candidate_id` 与对应domain批次身份。`max_entries`只限制单次请求和原子事务，不限制logical plan、Whole-Index或Managed Scope。`remaining`非零时，在当前批次成功Apply后重新调用Maintain并从新preimage继续；绝不能为满足transport上限缩减Index覆盖或自行截取返回批次。

   没有足够证据且当前布局支持 `aoci_report` 时，使用它而不猜测、套用模板或为消除待办而生成缺乏证据的认知。

8. 必须遵守工具返回的结构化状态和安全边界：

   - `repair_required`：只修复明确命中的候选，再重新提交当前机器签发的完整批次；
   - `stopped`：结束当前写入尝试并检查 `failed_step`、错误、正式写入证据与Recovery。auto模式下，已证明零写入则记录closure并重新Plan；完整Intent和可证明postimage则Resume；策略要求Rollback且preimage可证明则精确恢复后重新Plan。只有证据不足、第三方正式字节冲突、需要审批或外部动作，或命中其他真实安全边界时，才停止整个用户任务；
   - 冲突、审批、人工裁决、权限和安全信号不得忽略；
   - 已经对齐后不得重复维护或重复写入；`refresh_ready_for_overview` 是checkpoint事实，由Agent决定是否为下一阶段请求普通完整Overview。

   维护完成后如果又修改了任何受管理对象，之前的维护结果失效，应在新的最终稳定状态重新完成收尾。

9. 用户只限制业务文件范围，但没有明确禁止仓库托管资产时，AOCI托管资产可以在收尾阶段为保持认知一致而更新，并应在审计和提交中与业务文件区分。

   用户明确禁止修改 `aoci.txt`、`.aoci`、元数据或任何额外文件时，以用户限制为准，不得写入，并如实报告剩余不一致。

### 专项流程

初始化、完整索引生成、Header生成、Entries生成、数据库结构索引、Curation、人工评审和故障恢复，只按当前AOCI Guide或工具在对应阶段返回的指令、命令和安全停点执行。

不预加载、不猜测，也不自行重建这些专项流程。平台调用方式、请求格式、批次上限、审批规则、索引格式细节和恢复步骤由对应Guide、工具说明、模型Prompt和CLI帮助按需提供。
<!-- aoci:end -->

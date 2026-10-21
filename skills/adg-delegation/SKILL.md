---
name: adg-delegation
description: 给 Adg PTC 模式的调度智能体用：`delegate` 的参数语义与硬边界（`tools` 就是子代理那次可见的全部工具、六个内置 deny、未知名与 `run_code` 的后果），七条能力带 → 建议 `tools` / persona 要点 / 边界的映射表，persona 与技能路径的写法口径，以及「哪一次委派该给哪份技能路径」。要写一次委派、要按任务现定能力面、或子代理报「缺工具 / 超出能力范围」时加载。
whenToUse: 在 Adg PTC 模式里要派出一个子代理（写 `delegate` 的 `description` / `prompt` / `tools` / `persona` / `background`）、要按任务选这次的工具面、或要决定把哪份技能文件的绝对路径写进委派时使用。
---

# 在 Adg PTC 模式里委派一个通用子代理

Adg 只有一个委派工具：`delegate`（第一方子插件 `adg-delegate`，全局层注册，**只有调度智能体拿得到**）。没有固定专家名册 —— 子代理干什么、能用什么，全是你这一次委派里写下去的字。

本技能只讲**「怎么把这一次委派写对」**。派不派、派几次、什么时候续派、什么时候问用户这些编排规则在调度 persona 的 `## 约束` 里，不在这里重复。

## 先记住：本 preset 是 PTC 呈现，`delegate` 要在 `run_code` 里调

本 preset 的工具目录里**只有 `run_code`** 一个工具 —— 直呼 `delegate` 会解析成 `UNKNOWN_TOOL`。委派写成一段 async TypeScript 函数的**函数体**（erasable syntax only；顶层 `await` 与 `return` 可用）：

```ts
const a = await tools.delegate({
  description: '抓 A 站三页产品参数',
  prompt: '……目标 / 边界 / 验收标准……',
  tools: ['web_fetch', 'read', 'write'],
})
const b = await tools.delegate({ description: '…', prompt: '…', tools: ['pwsh', 'job_list', 'job_output', 'job_kill'] })
return [a.subagent_id, a.tools_note, b.subagent_id, b.tools_note]
```

四条由此而来的实操差别：

- **只 `return` 你要看的那点**：`delegate` 的返回对象不小（`subagent_id` / `kind` / `tools` / `tools_note` / `persona`），全 `return` 出去等于白换模式 —— 核对完就只回 `subagent_id` 与需要你处置的 `tools_note`。程序里的中间变量不进对话。
- **多次委派写在同一段程序里**：`tools.delegate` 之间没有依赖，可以用 `await Promise.all([...])` 一起发（派发只提交、不等子代理跑完，所以不会撞 `run_code` 的时限）。**但别把「发出去」和「等结果」混在一段程序里** —— 子代理的结果是结算通知唤起的，程序里等不到。
- **单次失败是 `ToolCallError`**（`.toolName === 'delegate'`、`.message` 里是那句人话，例如点名了 `run_code` 或未知名全被剔除）。要区分「这一条委派参数错了」和「程序本身写错了」，就用 `try/catch` 单独包住每次 `delegate` 调用。
- **子代理自己也在 PTC 里**：它的目录里也只有 `run_code`，你给它的 `tools` 是它写程序时能调到的名字。所以 `prompt` 里不要写「直接调用 read 工具」这类原生口吻 —— 写「用 `run_code` 调 `tools.read`」，或者干脆只写要达成什么（它会自己看 `tools:sdk` 段）。**`tools` 里永远不写 `run_code`**：那是传输名，写进去整次委派当场抛错。

## `delegate` 的五个参数

| 参数 | 必需 | 语义 | 判据 |
|---|---|---|---|
| `description` | 是 | 这次委派的一句话说明，显示给用户与 `list_agents` | 短、唯一、能认出是哪件事 |
| `prompt` | 是 | 子代理能看到的**全部**上下文：要解决什么问题、边界、怎么算做对 | 子代理看不到你的会话 —— 它只有你写的字 |
| `tools` | 否 | 这次下发的工具名数组 | **硬边界**，见下一节 |
| `persona` | 否 | 部署 persona 的**遮蔽**（遮蔽 = 换掉，不是追加） | 只在需要专门视角时才给 |
| `background` | 否 | 缺省 `true` = 后台 + `continuable`（可续跑、可被 steer）；`false` = 前台一次性 | 默认值就是对的，不要显式设 `false` |

返回里带上这次真的下发了什么：`subagent_id`、`kind`、`tools`（省略 `tools` 时是空数组）、`tools_note`（一句人话，说清「未过滤 = 它拿到继承到的全部」还是「只保留 N 个」）、`persona: 'set' | 'unset'`。

## `tools` 是硬边界，不是提示

- **名单即目录**：平台 `tools.restrict()` 让子代理**可见的工具目录恰好等于这个名单** —— 连 preset 自己注册的工具也一起被裁。名单里没有的名字，子代理那里**不存在**，它不会「想办法」拿到。
- **省略 `tools`**：只下发 `{deny: 六个内置名 ∩ 本次可用}`，子代理拿到它继承到的全部减去那几项。
- **拿不准就给什么**：本技能下面那七条能力带只是**例子**，不是完整清单 —— 能给的名单＝这次会话里已注册的那些工具名。两种安全做法：①**省略 `tools`**（它拿到继承到的全部，一定不会缺你没想到的工具；代价是它的固定前缀更大、而且它会看到一堆这次用不上的工具）；②点名，然后读返回的 `tools` / `tools_note` 核对（没生效的名字会被逐条列出，不是静默丢弃）。
- **能力带没点名、但本 preset 里确实注册着**：`todo_write`（进度清单）、`present`（把产物作为文件呈现给用户）、`list_agents`（看自己派出去的子代理）、`send_message`（给自己派出去的子代理送消息 —— **只送字，改不了工具面**）。反过来这几个**不要给**：`skill`（技能面只归调度者）、`agent` / `delegate` / `set_child_permission` / `ask_user_question`（六个内置 deny 里的四个）、`run_code`（点名即抛错）。另有两组名字**本 preset 不注册**（composition 里没有它们的注册行）：编排引擎 `workflow` / `ralph`、目标三件 `create_goal` / `get_goal` / `update_goal` —— 写进 `tools` 只会让那一次委派在 `tools_note` 里回一条未知名，不是"给了但不生效"。
- **`tools: []`**：`{allow: []}` —— 什么都不给，它一个工具都没有。不要这样派。
- **未知名**：不在本次可用全局工具名里的名字被**剔除**并逐条写进 `tools_note`（`reason: 'unknown'`）—— **不静默丢弃**。所以子代理报「没有这个工具」时先读 `tools_note`。
- **六个内置 deny 名字永远给不下去**：`agent` / `delegate` / `workflow` / `ralph` / `set_child_permission` / `ask_user_question`。写进 `tools` 会被剔除并记 `reason: 'denied'`。前四个都能**再开子代理**，后两个只认 live runtime root（子代理调 `ask_user_question` 拿 `DELEGATED_CALLER`）。
- **`ask_user` 是给得下去的提问通道**（`adg-delegate` 提供；不是平台那个 `ask_user_question`）：给了它，子代理撞上登录墙 / 验证码 / 必须有人拍板时能**直接问用户**，答复回到它手上、它当场接着干 —— 不用你中转、也不用它单向喊一声就停手。它问出来的卡片落在**你这个会话**里（owner 是派它的你），你与用户都看得见。**要人工介入的任务就把 `ask_user` 写进 `tools`**，并在 `prompt` 里写明「撞上就开有头窗口 + 用 `ask_user` 问用户」。
- **`notify_user` 刻意可以给**：它是单向、不阻塞的提醒。它**不能**替代 `ask_user` —— 用户看得见、但回不了话；撞上登录墙时它是「喊人」而不是「问人」。
- **`run_code` 当场抛错**：它是 PTC 传输保留名，平台的 `tools.restrict()` 对它直接抛错（`cannot name reserved PTC mode presentation transport "run_code"`），`delegate` 替平台挡在前面 —— 点名它的那次调用**整次失败**，是本工具唯一会失败的名单项。
- **条件性注册名**（`read_image` / `bash` / `subagent_codex` / `subagent_claude_code`）：目标环境未必有，给之前先确认这次真的可用；给不了就在 `prompt` 里写明替代判据。
- **有 `pwsh` 就必须同给 `job_list` / `job_output` / `job_kill`**：缺了它们，子代理起的后台作业没有人能收。
- **`tools` 里不写 `skill`**：技能面只归调度者 —— 技能靠路径 + 「先 read 再动手」给，不靠工具面。

## 七条能力带 → 建议工具面 / persona 要点 / 边界

按任务对号入座；`job_*` 一律指 `job_list` / `job_output` / `job_kill` 三个。

### ① 文件与文档

| 项 | 内容 |
|---|---|
| 建议 `tools` | `read` `read_image` `write` `edit` `glob` `grep` `pwsh` `job_list` `job_output` `job_kill` `notify_user` |
| 建议 persona 要点（【目标】/【要干什么】） | 文件与文档的全生命周期：按文件名 / 内容 / 时间 / 类型检索定位；深读 PDF、Word、Excel、PPT、图片并做自然语言问答；复制、移动、删除、重命名、批量归类；生成文档 / 表格 / 图表 / PPT；格式转换（PDF↔Word、图片转 PNG、Excel↔CSV 等） |
| 建议 persona 要点（【不要干什么】） | 只处理文件与文档本身：工作区**代码**改动、需要跑编译或测试自证的活不是它的；不改系统设置、不操作软件界面、不做需要登录的网页交互 |
| 建议 persona 要点（【验收标准】） | 给出改动路径与操作前后状态；批量操作给条数与失败清单；生成/转换出的文件给绝对路径；越界部分写明需要哪条能力带与已核实的最小事实 |
| 深水区 | 给技能 `${DSH_HOME:-~/.dsh}/skills/adg-file-ops/SKILL.md` |

**注意：① 与 ⑥ 的 `tools` 逐字相同。** 两者唯一的差别在你写的【目标】/【要干什么】/【不要干什么】：写清是「整理 / 转换 / 生成文档」还是「按已定方案改工作区代码并自证」。委派里不写这一句，子代理只能自己猜方向。

### ② 系统与应用

| 项 | 内容 |
|---|---|
| 建议 `tools` | `read` `glob` `grep` `pwsh` `job_list` `job_output` `job_kill` `notify_user` |
| 建议 persona 要点（【目标】/【要干什么】） | ①系统与设备层：系统与硬件信息查询（CPU、内存、磁盘、电池健康、网络、显卡）；系统设置修改（分辨率、电源计划、代理、任务栏、锁屏与广告项）；优化清理（磁盘清理、启动项管理、冗余文件、性能分析与调优）；故障排查（网络、WiFi/蓝牙、音频/显示、驱动、应用崩溃）；窗口与桌面管理（Win32 API + `Add-Type` P/Invoke 移动/缩放/平铺窗口，多显示器布局可查询与摆放；虚拟桌面的枚举与切换依赖未公开接口，做不到就直说）；进程、服务与计划任务控制。②应用层：桌面软件（EXE）的打开、关闭、安装、卸载，以及通过软件自带命令行、配置或自动化接口调用其内部功能；Android 应用（APK）在电脑端模拟器环境中的操作；微信小程序内的操作 |
| 建议 persona 要点（【不要干什么】） | 不整理用户文档（①）；不改工作区代码（⑥）；不做网页交互（③）；不绕 UAC、不碰安全桌面 |
| 建议 persona 要点（【验收标准】） | 给出实际执行的命令、改动前后的状态证据（同一查询对比）、回退方式；应用操作另说明操作了哪个应用、用了什么命令或接口、观察到什么证据（进程 / 窗口标题 / 退出码 / 日志摘要），以及没做到的部分与原因 |
| 深水区 | 给技能 `${DSH_HOME:-~/.dsh}/skills/adg-computer-use/SKILL.md` |

**GUI 闭环要另加一条前提**：让它走 `${DSH_HOME:-~/.dsh}/desktop/cli.mjs` 时，**调用方那次委派必须是完全权限**（`danger-full-access`）—— 受限令牌的 Low 完整性级别会被 UIPI **静默**丢事件。这条属于派发前的闸门，写在 `prompt` 里要求它「不是完全权限就停手如实报」，不要让它自己去找绕路。**要它看截图就把 `read_image` 显式加进 `tools`**（调度 persona 的【派给谁】只是提醒你别漏了它，工具名仍由你这一次写）：它是**条件性注册**的名字，两条独立条件 —— 注册依赖持久 attachments 服务，没挂上时那一次委派直接失败；注册了还要求当前会话路由声明图像输入。

### ③ 网页

| 项 | 内容 |
|---|---|
| 建议 `tools` | `read` `read_image` `write` `edit` `glob` `grep` `pwsh` `web_fetch` `job_list` `job_output` `job_kill` `ask_user` `notify_user` |
| 建议 persona 要点（【目标】/【要干什么】） | 多步交互的网页场景：登录态下的站点操作、多步表单填写与提交、按钮点击与下拉选择、多页跳转的数据抽取；自动处理弹窗与 Cookie 提示 |
| 建议 persona 要点（【不要干什么】） | 已明确目标 URL 的**交互式**操作才是它的；开放式检索（只搜不点）是 ④。系统设置 → ②；整理本地文件 → ① |
| 建议 persona 要点（【验收标准】） | 给出操作步骤、抽取到的数据（逐条附出处 URL）或日志证据；被登录墙或验证码阻断时写明卡在哪一步、需要用户做什么；视觉结论要基于 `read_image` 看到的画面，不能只凭 DOM 文本 |
| 深水区 | 给技能 `${DSH_HOME:-~/.dsh}/skills/adg-browser-use/SKILL.md` |

**必须完全权限**（`danger-full-access`）；派发前先读你自己上下文里的 `Current DSH file policy:` 并问一次用户（三选项：切到完全权限后派 / 降级只做 `web_fetch` 静态抓取 / 暂不做）。这次委派的**模式（有头 / 无头）由你判定后写进 `prompt`** —— 完全确定不需要登录 / 验证码就无头；确定要登录 / 过验证码就有头；拿不准就先无头，并在 `prompt` 里写明「撞上登录墙 / 验证码就 `launch --headed` 换有头，然后用 `ask_user` 问用户登录好了没」。**给 `ask_user`，别只给 `notify_user`**：前者能让用户答完、子代理当场接着干；后者只能单向喊一声，子代理还得停手等你重派。

### ④ 全网检索

| 项 | 内容 |
|---|---|
| 建议 `tools` | `web_search` `web_fetch` `notify_user` |
| 建议 persona 要点（【目标】/【要干什么】） | 多轮联网检索 + 综合总结，产出带来源链接的结构化答案 —— 深度调研（行业分析、竞品对比、论文与资料检索）、多源综述与整理、关键信息引用溯源 |
| 建议 persona 要点（【不要干什么】） | 只联网。严格禁止处理本地文件或系统级请求 —— 工具里也没有文件与命令工具，这不是偏好，是硬边界 |
| 建议 persona 要点（【验收标准】） | 关键结论逐条附来源 URL；多来源冲突时并列呈现并说明分歧；无法证实的内容标注为未证实，不要把推断写成结论 |
| 深水区 | **不要给技能路径** —— 这条带的 `tools` 里没有 `read`，它读不了文件；要传达的口径内联进 `prompt` |

### ⑤ 本地检索与出处

| 项 | 内容 |
|---|---|
| 建议 `tools` | `read` `glob` `grep` `web_search` `web_fetch` `notify_user` |
| 建议 persona 要点（【目标】/【要干什么】） | 在本仓库 / 本机文件里定位实现、配置与出处，产出带出处的结论 ——「只读且必须给位置锚」 |
| 建议 persona 要点（【不要干什么】） | 只读：不得写入、编辑、删除任何文件，不得执行会改变系统状态的命令（工具里也没有 `write` / `edit` / `pwsh`）。公网**发现式**调研优先交 ④；这里的 `web_search` / `web_fetch` 只用于**定点核对**（某个已知页面、某个库的版本文档、对一条结论做交叉验证） |
| 建议 persona 要点（【验收标准】） | 结论必须带可复核的位置锚（文件用 `path:line`，网页用 URL，其他介质用页码/章节坐标）；未核实的推断显式标注为推断 |
| 深水区 | 无专门技能；口径内联进 `prompt` |

### ⑥ 编码改动

| 项 | 内容 |
|---|---|
| 建议 `tools` | `read` `read_image` `write` `edit` `glob` `grep` `pwsh` `job_list` `job_output` `job_kill` `notify_user` |
| 建议 persona 要点（【目标】/【要干什么】） | 按**已确定的方案**落地代码改动，并运行编译、测试或等价检查自证改动有效 |
| 建议 persona 要点（【不要干什么】） | 只在当前工作区内改动文件。不做需求解读与方案设计，不承担外部资料调研，不做系统级运维与普通文档整理 |
| 建议 persona 要点（【验收标准】） | 说明改了哪些文件、为什么改、用什么命令证明了改动有效（命令 + 退出码或输出）；修 bug 类任务先留「会失败的那次复现」红证据，再给改到绿的那次，最后给全量测试/回归结果 |
| 深水区 | 无专门技能；口径内联进 `prompt` |

**边写边自测**：`write` / `edit` 与 `pwsh` + `job_*` 要**一次给齐**，别让它下一轮才发现缺工具。能在本机真的跑起来、显示在屏幕上的界面，改动后可以自己截屏核验（`pwsh` 截屏 → `read_image`）—— 这是**可选**的自证手段。视觉核对的归属是 ⑦，不要因此把交付拖成视觉验收。

### ⑦ 对抗性审查

| 项 | 内容 |
|---|---|
| 建议 `tools` | `read` `read_image` `write` `glob` `grep` `pwsh` `web_search` `web_fetch` `job_list` `job_output` `job_kill` `notify_user` |
| 建议 persona 要点（【目标】/【要干什么】） | 对已有改动做对抗性审查 —— 找 bug、找边界条件、找与需求不符之处，并尽量用只读命令或测试验证。需要 `git log -S` / `git blame` / 测试命令的只读核对也归它（它带 `pwsh`，⑤ 不带） |
| 建议 persona 要点（【不要干什么】） | 只报告，**不修改被审对象与任何既有文件**。`write` 只有一种用途：把程序化验证用的**临时脚本**写进平台临时目录（用完删除，不留痕迹）；拿它改仓库里的任何文件、或「顺手修一下」，都算越界 |
| 建议 persona 要点（【验收标准】） | 每条结论给出文件路径 + 符号名/小节名，或命令依据；上游 API / 规范 / 版本这类可查证的事用 `web_search` / `web_fetch` 去核（别停在推断），剩下无法核实的推断必须显式标注为推断 |
| 深水区 | 无专门技能；口径内联进 `prompt` |

**⑦ 不继承写者的编辑内容** —— 要在 `prompt` 里点名验证什么、要它给什么证据。另派一个给它只给 `read` / `grep` / `pwsh` 的最小面也成立。

## `persona` 怎么写

`persona` 是**遮蔽**该子代理的部署 persona（换掉，不是追加），所以：

- **不设岗位人设**（不要「你是文件管家」这类角色扮演）。设 【目标】、【要干什么】、【不要干什么】、【约束】、【验收标准】。
- **不要把整份 SKILL 正文塞进 `persona`**。正确做法是把 SKILL 文件的**绝对路径**写进 `prompt`，要它先 `read` —— 渐进式披露，技能正文只在它真的动手时才进它的上下文。
- **没给 `read` 的那一次**（例如 ④ 只给联网工具）才把必要内容**内联**进 `prompt`，而且要精简到它真的用得上。
- `prompt` 里要写清**本次不做**哪些相邻的事 —— 没有边界的委派，子代理只能猜边界，猜宽了就去探索旁路。

## 技能怎么给：一个路径 + 一句话

```
先 read `${DSH_HOME:-~/.dsh}/skills/adg-file-ops/SKILL.md` 再动手；它是这次干活的判据。
```

| 这一次委派是什么 | 给哪份技能路径 | 前提 |
|---|---|---|
| 文件 / 文档整理、转换、生成、图片理解（①） | `${DSH_HOME:-~/.dsh}/skills/adg-file-ops/SKILL.md` | 那次给了 `read` |
| 桌面 / 系统 / 应用操作（②） | `${DSH_HOME:-~/.dsh}/skills/adg-computer-use/SKILL.md` | 那次给了 `read` |
| 网页交互（③） | `${DSH_HOME:-~/.dsh}/skills/adg-browser-use/SKILL.md` | 那次给了 `read` |
| 联网检索（④）/ 本地检索（⑤）/ 编码改动（⑥）/ 对抗性审查（⑦） | 不给技能路径 | ⑤ 有 `read` 但无对应技能；④ 没有 `read`，给了也读不到 |

技能文件的安装位置就是技能根：`${DSH_HOME:-~/.dsh}/skills/<目录名>/SKILL.md`。**路径写绝对路径**，不要写仓库内相对路径 —— 子代理的工作目录未必是仓库根。

## 一跳可达

子代理**开不了下一层**：内置 deny 已经拿掉 `agent` / `delegate` / `workflow` / `ralph`，平台默认 `maxDepth = 1`，而且**不要给委派写 `maxDepth`**（写 `0` 会让每一次委派以 `subagent depth 1 exceeds maxDepth 0` 失败）。所以不存在「孙代理」：子代理之间不能直接互相转交，它报「超出能力范围」时由你续派。

## 失败长什么样

| 现象 | 含义 | 怎么办 |
|---|---|---|
| `tools_note` 里出现 `reason: 'unknown'` 的名字 | 那个名字不在本次可用的全局工具名里，已被剔除 | 换一个名字，或不再要求它用那个工具 |
| `tools_note` 里出现 `reason: 'denied'` 的名字 | 那是六个内置 deny 之一 | 改设计：要么你自己做，要么换一条能力带 |
| 调用直接抛错，文本里有 `run_code` | 你点名了 PTC 传输保留名 | 删掉它 —— 要限制的是工具，不是承载它们的传输 |
| 调用直接抛错，文本里有 `读不出本次可用的全局工具名` | 工具视图读不出来（API 形状变了） | 这是 fail-closed，不要重试同一条调用；如实报给用户 |
| 子代理报「我没有 X 工具」/ 返回的 `tools_note` 里写着 `reason: 'unknown'` | 你点名的名字这次不存在，已被剔除 —— **委派本身没有失败** | 要它继续做那件事只能**新派一个子代理**并把名字换成真实存在的（或干脆省略 `tools` 让它继承全部），产物用路径交接；`send_message` 补不了工具 |
| 某次委派当场抛 `names unknown global tool …` | 这条路只可能来自**静态名单**（preset 源文件里写死的 `allow`），不是 `delegate` 的 `tools` | 检查那个名字所属的插件（`notify` / `permission` / `delegate`）在这个 profile 装没装，并跑一次 `node tools/check-preset.mjs` |
| 子代理说「我看不了图」 | `read_image` 的两条条件之一没满足 | 要么改用可查询的状态量，要么就不要求视觉判据 |
| 子代理报「我不能问用户 / 我拿不到答复」，或它的报错里出现 `DELEGATED_CALLER` | 你这次没给 `ask_user`，它撞上必须问人的岔路（登录墙 / 验证码 / 要人拍板）只能停手 | 把 `ask_user` 写进 `tools`，连同「撞上就用它问用户」一起重派；`send_message` **补不了工具面** |
| 子代理报「工具不存在 / `UNKNOWN_TOOL`」 | 它在本会话里只能直呼 `run_code` —— 直接写 `tools.read(...)` 这类原生调用会被当成未知工具 | 委派里要它「在 `run_code` 里用 `tools.read({...})`」；`tools:sdk` 段已经在它上下文里，通常只需提醒一句 |
| 子代理报「程序超时 / `code run failed (timeout)`」 | 那段 `run_code` 跑过了它的时限（见 `timeoutMs` 说明），计时**含**程序里等待的嵌套工具与审批 | 拆成多段程序；长命令（编译、批量转换、`Start-Sleep`）改成后台作业再收，或把整件事交给另一个子代理 |

## 未观测

- **未观测**：给子代理 `ask_user` 之后，它撞上登录墙时的**实际选择**（`ask_user` 直接问人 / `notify_user` 单向喊一声就停手），以及答复回到它手上后它会不会自己重新核验状态再继续。—— 量法：在真站点登录墙前派一次带 `ask_user` 的网页委派，在转写里看它这一轮调的是哪个、拿到答复后有没有复核。

- **未观测**：`tools` 省略时子代理实际拿到的「继承到的全部」在本机到底是哪几个名字（本技能只按 `delegate` 的语义描述它）。—— 量法：派一次不带 `tools` 的委派，读返回的 `tools_note`，并让子代理报出它可见的工具名清单，两者对照。
- **未观测**：给 `persona` 之后，被遮蔽的部署 persona 里有哪些内容真的不再出现（平台语义是「遮蔽」，本技能按此描述）。—— 量法：同一条 `prompt` 分别带 / 不带 `persona` 各派一次，让子代理复述它自己收到的角色与边界，逐段比对。
- **未观测**：`read` 一次技能文件是否足以让子代理按技能正文执行（渐进式披露的实际依从率）。—— 量法：同一条委派里让它在最终结果中标注它执行了技能的哪几节，再对最终交付逐条核对。
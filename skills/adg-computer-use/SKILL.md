---
name: adg-computer-use
description: 给在 Adg PTC 模式里拿到桌面工具链的子代理用：`${DSH_HOME:-~/.dsh}/desktop/cli.mjs` 的入口与子命令（`screen` / `windows` / `uia` / `point` / `click` / `type` / `key` / `invoke` / `verify`）、「注入类命令只认可观测差异、不认调用返回」的判据、UIPI 静默拦截与完全权限前提、`invoke --id` 的 UIA pattern 边界、优先走不依赖模拟点击的 Windows API 路线，以及改系统状态前的说明义务。委派要求操作本机桌面 / 系统设置 / 桌面软件界面时加载。
whenToUse: 委派里给了 `${DSH_HOME:-~/.dsh}/desktop/cli.mjs`、要求看屏幕 / 操作窗口 / 点按钮 / 输字 / 改系统设置 / 启停桌面软件时使用；或在 GUI 操作里怀疑「命令报成功但界面没动」时使用。
---

# 用桌面工具链完成一次本机 GUI / 系统操作

## PTC：这条 CLI 要在 `run_code` 里跑

你的工具目录里只有 `run_code`，**直呼 `pwsh` / `read` 会解析成 `UNKNOWN_TOOL`**。下面每条 `node ...\desktop\cli.mjs <子命令>` 都写成程序里的一次嵌套调用：

```ts
const r = await tools.pwsh({ command: 'node "C:\\Users\\<你>\\.dsh\\desktop\\cli.mjs" screen', description: '截屏' })
console.log(r.stdout)   // 只有 print / return 的进对话
```

- 路径要么由委派给你，要么先用 `await tools.pwsh({ command: '$env:DSH_HOME' })` 取回 —— **PTC 程序的 `process.env` 是空字典**，Node 侧读不到环境变量（PowerShell 侧是完整的）。
- 一条操作链（`screen` → `uia` 找元素 → `invoke`/`click` → `verify`）写进**同一段** `run_code`，中间结果留局部变量，只 `return` 最后的判据行（`CHANGED=` / `WARN=` / `ERROR=`）。别把整页元素表 `return` 出来。
- **`run_code` 默认 120s、上限 600s**，计时含每次嵌套调用；桌面操作里等窗口出现之类的等待要用 CLI 自己的等待参数，不要 `Start-Sleep` 长睡。
- 下面那条「完全权限」前提在 PTC 下照样成立：它是**会话令牌**的属性，不因你写程序而改变。

## 入口与硬前提

```powershell
node "$env:DSH_HOME\desktop\cli.mjs" help
```

- 零依赖，Node `>= 22`；原生调用全部在随模块发布的 `scripts/bridge.ps1` 里（Windows PowerShell 5.1 + `Add-Type` + P/Invoke）。
- **Windows 专用**：非 Windows 上除 `profile`（如实打印 `WINDOWS_ONLY=false` + `WARN=`）外每个命令都直接报错，不会假装能做。
- **调用它的那一次会话必须是完全权限**（`danger-full-access`）。受限会话（`workspace-write` / `read-only`）的令牌是 Low 完整性级别，普通窗口是 Medium/High，**UIPI 会拦下合成输入**，而且拦截是**静默**的 —— `SendInput` 照样报「已插入 N 个事件」、`GetLastError=0`，事件随后被丢弃。
- **完全权限解的是「降权」，不是获得管理员权限**：High 完整性级别的管理员窗口与 UAC 安全桌面依旧够不着。

## 子命令

| 命令 | 用途 |
|---|---|
| `help` | 命令 / 选项的**唯一真相源** |
| `profile` | 环境自检：Node / PowerShell / DPI / 屏幕 / **自身完整性级别** |
| `screen [--out <png>] [--region <l,t,w,h>]` | 截屏（不缩放，默认整张虚拟屏）→ 交给 `read_image` 自己看 |
| `windows` | 枚举可见顶层窗口（进程 / 类名 / 矩形 / 完整性级别） |
| `uia [--hwnd <0x..>] [--depth N] [--name <子串>] [--id <el_id>] [--limit N]` | 读 UIA 树并给每个元素一个稳定 `el_id` |
| `point --x <px> --y <px>` | `WindowFromPoint` 往返：这个**物理坐标**下是哪个窗口 / 元素 |
| `click --x <px> --y <px> [--button …] [--double] [--clicks N] [--target-hwnd <0x..>]` | 合成点击 |
| `move --x <px> --y <px>` | 只移指针，绝不点击 |
| `type --text <字符串> --hwnd <0x..>` | 合成输入文字；**`--hwnd` 必填** |
| `key --keys <如 ctrl+s> --hwnd <0x..>` | 合成按键 / 组合键；**`--hwnd` 必填** |
| `scroll --x <px> --y <px> --dy <n>` | 滚轮（正 = 上，负 = 下） |
| `invoke --id <el_id> [--set-value <v>] [--fallback-point] [--hwnd <0x..>]` | 用元素**自带的 UIA pattern** 做语义操作；`--id el_unknown`（折叠 id）**必须**给 `--hwnd` |
| `verify [--x <px> --y <px>] [--expect k=v;k=v]` | 只观测，不注入 |
| `snapshot [--hwnd <0x..>] \| [--x <px> --y <px>]` | 只读内容读数（独立子进程，零副作用） |
| `probe` | 只做内存编码诊断，**从不发事件** |

常用开关：`--json`（末尾追加一行 `JSON=`）、`--dry-run`（只算坐标与归一化值，**不发事件**）、`--force`（跳过三处闸门：目标完整性级别更高、`GEO_MISMATCH`、显式 `--target-hwnd` 与落点不符）、`--target-hwnd <0x..>`（坐标类命令显式声明要操作哪个窗口）、`--raise`、`--settle <ms>`（默认 150）、`--no-content`、`--timeout <ms>`（默认 60000）。

输出契约是 `KEY=VALUE`（一行一个键），出错走 stderr 的 `ERROR=<msg>`。**完整用法与全部选项以 `help` 的当场输出为准**。**用不上的开关一律报用法错**（退出码 2），不许静默忽略。

## 判据：只认「可观测差异」，不认调用返回

**这是本技能最重要的一条。** 每条注入命令都打印 `CHANGED=true|false|unknown` + `BEFORE=` / `AFTER=`；坐标类命令另有硬件级回读 `CURSOR_AFTER=` / `CURSOR_LANDED=`（`GetCursorPos`）。

- **绝不采信 `SendInput` 的返回值**，也不采信 `INSERTED_EVENTS=` 这类计数：UIPI 拦下时它们照样「正常」。
- **`CHANGED=unknown` 是必须的三态**：没有差异、而且这次动作的效果落在判据覆盖范围之外（没抓像素、也读不到任何 UIA 内容属性）时报 `false` 会把真成功说成失败。**「我看不见这类动作的效果」绝不许报成 `false`。** 各命令的判据类别不同：`scroll` 的效果**只有滚动位置读数**看得见；`type` 只有 `Value`；`key` 有 `Value` / 选中态 / `Toggle` / `RangeValue` / 滚动位置几类。需要的那一类一条都没读到 ⇒ 一律 `CHANGED=unknown` + `WARN=`。
- **`EVENTS_MATCH_PLAN=true` 与 `LANDING_IN_TARGET=true` 都不是「靶侧真的收到 / 点中了」的证据**：靶窗被置顶但没拿到前台时，事件数对得上、落点归属也对，靶侧计数却不动。要证明生效只能看靶侧自己的计数 / 日志，或用 `--expect` 复核。
- **`--dry-run` 与真跑同源**：`EVENTS_MATCH_PLAN=` 比的正是「实际插入的事件数」与「dry-run 算出来的计划」。既然 dry-run 不是证据、真跑不算证明，**唯一的结论来源仍然是前后态差异**。
- **`GEO_MISMATCH` 三态口径：「缺测绝不许读成一致」** —— `false` 只在两条读数都取到且都印证时才给，任一条缺失 ⇒ `unknown` + `WARN=`。`true` 时**默认退出码 2 不发事件**。
- **落点归属要先有显式目标**：没给 `--target-hwnd` 时只报 `LANDING_SAME_WINDOW`，`LANDING_IN_TARGET` 记 `unknown`。给了才给布尔值，并且在注入前先闸一道 `LANDING_PREFLIGHT=true|false|unknown`（与几何闸门同款三态）。**这道闸门是「发事件前」的门，事后那行 `LANDING_IN_TARGET=` 是「发完之后」的记录，两道都要看。**
- **内容类判据不许静默缺席**：`verify` 会把 UIA 内容快照的可读条数打出来（`CONTENT_BEARING_COUNT=` / `CONTENT_KINDS=` / `CONTENT_PROBE=ok|failed|skipped`），一条都读不到时 `contentNote` 里留原始异常文本（受限令牌下典型是 `Access is denied`），**不许把读不到当作「没有变化」**。探针崩掉时这一类判据记 `unknown`；像素哈希在也不许改报 `false`（像素看不见「文本框里的字变了」）。
- **坐标一律是真实物理像素**，进程启动即声明 `PER_MONITOR_AWARE_V2`。非 DPI 感知进程拿到的坐标被系统虚拟化。**抬窗 / 移动窗口后至少等 300–500 ms（`--settle`）再取坐标或操作** —— 动画期的窗口矩形是过渡值。

## UIPI：静默拦截 vs 主动阻断

| 情形 | 表现 | 怎么做 |
|---|---|---|
| 会话不是完全权限 | Low 完整性级别，合成输入被 UIPI **静默丢弃**；`CHANGED=false` / `unknown` + 事件计数正常 | 如实报「本次会话不是完全权限，GUI 合成输入不可用」，请调度者切权限后重派。**不要去掉闸门来「跑通」** |
| 目标完整性级别高于自身（管理员 / 高完整性进程、UAC 安全桌面） | 工具链在注入前**主动阻断**，`ERROR=UIPI blocked: target integrity level higher than ours` | **停手如实报**。不要用 `--force` 绕 |
| 级别读不到 | 按 `block-integrity-unknown` 处理 | 不假设它比我们低 |

**`--force` 的定位**：它是「我确认知道闸门在说什么，仍要照原样做」的显式声明，会多打一条 `WARN=`。**不是**用来把「环境不具备」变成「能做」的开关。

## `invoke --id` 的边界

`invoke` 只用元素**自带**的 UIA pattern 做语义操作（不移动真实鼠标、被遮挡也可能点到）：

- 目标应用**没实现 UIA provider** 时它**明确报错**，不猜、也不自动退化成坐标点击（要退化必须显式给 `--fallback-point`，并会打 `WARN=` 说明「这不是语义操作」）。
- pattern 的可得性随「**这一次调用的令牌**」变化 —— 实测两个方向都有读数，边界未量全（边界见 `desktop/testing-guide.md` 的未观测项）。
- **`el_id` 与快照作用域绑定**：`el_…` 只在取它的那次遍历里稳定。从桌面根遍历会在 `--limit` 处停下并报 `TRUNCATED=true`，此时 `COUNT` 是「走到的元素数」不是总数。**截断时找不到 id 报的是截断，不是「元素已消失」**；正确做法是加 `--hwnd`（必要时加 `--name` / `--depth`）后用**同一作用域**重新取 id，再看 `SNAPSHOT_SCOPE=` / `SNAPSHOT_COUNT=` / `SNAPSHOT_TRUNCATED=`。`--limit` 是**遍历预算**，不是显示上限。**反向不成立：id 相同也不保证是同一个元素** —— id 只是 runtimeId 的哈希，而「数命中数」发生在你手上那份定位快照上、动手却发生在桥的第二遍遍历里（见下面两条）。
- **`el_unknown` 是折叠 id，不是身份**：`GetRuntimeId()` 读不到的元素**全被折叠成同一个 `el_unknown`**。它照旧出现在 `uia` / `point` 的快照输出里（藏起来就等于说「这个元素不存在」），但**不许**在未限定窗口时拿它动手：`invoke --id el_unknown` 不给 `--hwnd` ⇒ 用法错、**退出码 2**（文本说的是「占位、不唯一、必须限定窗口」，不是「元素不存在」）。
- **元素身份随调用下发，对不上就一步都不动**：CLI 把定位快照里那个元素的 `runtimeId` 作为 `ElRuntimeId` 原样发给桥，桥在**动手路径的任何动作原语（`.SetValue(` / `.Invoke()` / …）之前**比对 —— 口径要说准：**不是**「文件里第一个 `TryGetCurrentPattern` 之前」（桥构建快照时就已经只读枚举过一次 pattern，那只是清点、不是动作） —— 不一致 ⇒ `OK=false` + `ID_IDENTITY=mismatch`，**一个动作都没执行**，CLI 报用法错、**退出码 2**。这与「动作执行了但没生效」的 **1** 是两件事：**2 要重新取一次 id（元素可能已被替换），1 要去查闸门与靶侧**。`ID_IDENTITY=` 三态：`checked`（下发了身份且一致）/ `absent`（快照没给 runtimeId ⇒ **不下发**、只打一条 `WARN=` 说明这次没有身份复核）/ `mismatch`。所以**别把 `OK=true` 读成「作用到了我想的那个元素」**：只有当 `ID_IDENTITY=checked` 时身份才真的被复核过。
- 内容探针的作用域是**加法的**：`--hwnd` 钉根、`--x/--y` 加读落点与它 3 层内的祖先，两个都给就都读；实际用了哪个看 `CONTENT_SOURCE=` / `SNAPSHOT_SOURCE=`。

## 优先走不依赖模拟点击的路线

能不用合成输入就不用：

1. **软件自带的命令行 / 配置 / 自动化接口**：`winget`、`adb`、应用 CLI、官方 API、脚本接口。
2. **Windows API 路线**：PowerShell / CIM（`Get-CimInstance`、`Invoke-CimMethod`）/ P-Invoke（`Add-Type`）—— 系统信息、服务与进程控制、计划任务、窗口移动与缩放、多显示器布局查询与摆放都走这里。
3. **`invoke --id` 语义操作**（目标实现了 UIA provider 时）。
4. **坐标点击**：只在 1–3 都不可用时，且界面一变就失效。

`screen` → `read_image` 看图是**可选**的自证手段，用来判断「改了之后到底长什么样」（分辨率与多显示器布局、窗口平铺结果、应用界面或报错弹窗的实际渲染）。`read_image` 有**两条互相独立的条件**：①注册依赖持久 attachments 服务，服务没挂上时这个名字根本没注册，**那一次委派会直接失败**（如实报给调度者，不要反复重试同一条路径）；②即便注册了，当前会话路由还得声明图像输入，没声明时它报错，那就如实说明「看不了图」、改用可查询的状态量作答（分辨率、窗口矩形、UIA 读数），**不要假装看过**。

## `type` / `key` 的收键窗口必须显式给

- 键只会送到**前台窗口**，而 Windows 拒绝后台进程抢前台：不给目标时桥会把字符发给「当时的前台窗口」。真机踩过 —— 一次 `type` 把 10 个字符打进**别的窗口**（疑似用户终端），靶侧日志零变化，而 CLI 只报 `CHANGED=unknown`。
- 所以 **`--hwnd` 是必填**（缺它 ⇒ 用法错、退出码 2）；`--x/--y` 只指定观测作用域，不决定「发给谁」。
- 目标抢不到前台时桥会重试；重试后仍非前台 ⇒ **报错且一个键都不发**。
- **组合键必须真按住修饰键**：发射顺序是「修饰键全部按下 → 载荷键 down/up → 修饰键反向抬起」。`--dry-run` 的 `PLAN_KEY <i> | <name> | PHASE= | PATH= | VK= | SCAN= | FLAGS=` 是唯一能在不发事件的前提下看顺序的地方 —— **事件数完全看不出顺序**。

## 安全：改状态前先说清

- 任何**改变系统状态**的操作，先说明：改什么、影响、怎么回退。
- **不可逆或高风险**的操作（删服务 / 启动项、改注册表、卸载驱动、卸载软件、关机重启）**必须先停下**，在回答里写明「需要用户确认后才能执行」，**不得静默执行** —— 你没有向用户提问的工具。
- 明文不做的：不绕 UAC、不碰安全桌面（Winlogon / UAC 同意界面）、不做进程注入、不改系统设置之外的越界项、不驱动管理员权限进程。本工具只**读**窗口与 UI 状态 + 用 `SendInput` 合成输入。
- 虚拟桌面的枚举与切换依赖未公开接口，**做不到就直说**，不要编一条路出来。

## 边界

不整理用户文档（给 `adg-file-ops` 那条能力带）、不改工作区代码、不做网页交互（给 `adg-browser-use`）。越界时不要尝试、不要扩范围，最终回答写明「超出能力范围」+ 你已核实的最小可交付事实。

## 验收标准

- 给出实际执行的命令；改动前后用**同一查询对比**给状态证据；给回退方式。
- 应用操作另说明：操作了哪个应用、用了什么命令或接口、观察到什么证据（进程 / 窗口标题 / 退出码 / 日志摘要）。
- GUI 操作的结论必须附注入命令的 `CHANGED=` / `CURSOR_LANDED=` / `BEFORE=` / `AFTER=` 实际读数；`unknown` 要连同 `WARN=` 一起如实交代，不要改成 `false` 也不要改成 `true`。
- 没做到的部分与原因必须保留。

## 未观测

- **未观测**：完全权限下 GUI 闭环在本机的当前可用性（历史读数来自另一路完全权限会话的实测记载，不是自己验证过）。—— 量法：在完全权限会话里 `screen` 截屏后用 `uia` 取一个元素的 id，`invoke --id` 一次，再看 `CHANGED=` 与靶侧自己的计数 / 日志。
- **未观测**：`invoke --id` 的 UIA pattern 可得性如何随「这一次调用的令牌」变化。—— 量法：同一个元素分别在同一会话的不同委派（不同令牌）里各跑一次 `invoke --id`，对照它返回的 pattern 列表与实际 `CHANGED=`；边界清单见 `desktop/testing-guide.md` 的未观测项。
- **未观测**：`ctrl+a` / `ctrl+c` / `shift+a` 这类组合键在靶侧是否真的成立（顺序与描述符已修，靶侧语义未复验）。—— 量法：完全权限会话里对靶窗跑 `key --keys ctrl+a --hwnd <靶>`，紧接着 `type --text V`；看靶侧是「全选后被替换」还是「追加」。
- **未观测**：`GEO_MISMATCH=true` 这条真机面（受限会话里 `FromPoint` 被拒，只验到两套根矩形一致）。—— 量法：完全权限会话里把靶窗口最大化后跑 `point`，看是否报 `GEO_MISMATCH=true`。
- **未观测**：双击语义在**控件框架**那一层是否触发（OS 层投递已观测，托管事件未观测）。—— 量法：在一个 WinForms 按钮上跑 `click --double`，看靶侧「托管双击事件」与「原始窗口过程日志」是否同时出现，再与 `--clicks 2` 对照。
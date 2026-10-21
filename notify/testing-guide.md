---
title: notify 模块测试指南
owner: Adg preset 维护者
status: current
last_reviewed: 2026-10-08
---

# notify 模块测试指南

本模块有两层验证，**别把它们混起来**：

- **机制层**（自动化；"真弹一次"是可选的、需要人看着屏幕的动作）：工具注册对不对、失败路径抛不抛错、toast 到底弹不弹得出来。`node --test test` 与 `node cli.mjs send` 覆盖这一层。
- **装载层**（只能重启后观测）：dsh 有没有真的把这个包装进 profile 并注册进全局层。静态证据只能证到"包在 + 被选中"，**证不到"运行期已注册"**（见「验证 ≠ 装载」）。

## 命令（可直接照抄）

下列命令的 cwd 都是仓库的 `notify/` 目录：

```sh
node --test test                        # 单元测试；不弹窗、不起真进程（测试注入假 spawn），可安全跑
node --test --test-isolation=none test  # DSH 沙箱（workspace-write）里必须加这个 flag
node cli.mjs help                       # exit 0；打印命令契约
node cli.mjs send                       # 须 exit 2（缺 --message）
node cli.mjs send --message x --ms soon # 须 exit 2（--ms 非整数）
node cli.mjs send --message '…' --show  # 真弹一条（与 notify_user 同一个内核）；会打扰用户，只在要人看时跑
```

**自测能跑起来的前提**：仓库根的 `node_modules/` 必须存在 —— 它是**解析桥**，把 `@deepseek-ai/*` 链到本机 dsh 安装处，好让本模块的自测能像运行时那样解析可选 peer 依赖 `@deepseek-ai/dsh-tools`。它不入库（被 `.gitignore` 排除）、是本机产物而不是依赖清单；缺了它，`node --test test` 会直接 import 失败。判据（在仓库根跑）：`node -p "require('@deepseek-ai/dsh-tools/package.json').version"` 能打印出版本号。

## 用例总表

用例从 `notify/design.md` 的不变量穷举而来；下面的组前缀就是 `notify/test/notify.test.mjs` 里测试标题的前缀（同一组可能有多条用例，**条数是当场读数、不作锚**）。载体一律是 `[机检] cd notify && node --test test`，判据＝exit 0 且没有失败用例。

| 用例 | 对象 | 断言内容 | 对应不变量 | 载体 |
|---|---|---|---|---|
| D1 | 工具注册 | `apply()` 在 stub ctx 上只注册一个工具、名字是 `notify_user`；`export const name` 与 patch 行的 `id` 一致（不一致时 patch 行找不到插件入口） | I7 | [机检] |
| D2 | 工具定义 | 参 schema 的**编译产物**只把 `message` 标必填；**用真 `defineTool` 造定义不抛错**（＝"注册那一刻不会炸"的唯一离线证据）；**反向对照**：对象根形状喂给真 `defineTool` 必须抛 `/parameters\.type must be a value schema object/`（否则上一条是空转）；缺 `message` 的调用在**进 `execute` 之前**就被参数校验拦下 | I13 / I14 | [机检] |
| D3 | Notification / ToastResult | 成功路径返回 `{ shown:true, mechanism:'toast', … }` 并把 `title` / `silent` 透传；**未传 `silent` 时落到默认出声**（I3 的回归：键存在但值为 `undefined` 不许把默认值判反） | I3 / I6 | [机检] |
| D4 | ToastResult | 全部失败路径各自抛错、且**不返回 `shown:false`**；"PowerShell 不存在"抛错前**不起进程**；超时抛错前先 `child.kill()`；"机制不可用"与"非 Windows"都在内；成功路径用 `stdio:'ignore'` 起进程 | I6 | [机检] |
| D5 | Notification / ToastRequest | argv 是 Windows PowerShell 5.1 的调用形状，`-Sound` / `-DisappearAfterMs` 随参数走；空 `message` / 非字符串 `title` / 非整数毫秒都被拒；默认标题 `DSH 通知`、默认存活 `0`（⇒ `scenario="reminder"`，常驻） | I1 / I2 / I4 / I5 | [机检] |
| D6 | 脚本资产 / ToastRequest | `notify/scripts/toast.ps1` **ASCII-only、无 BOM、含 `$ErrorActionPreference = 'Stop'`**，用的是 Windows PowerShell 5.1 宿主、不出现 `pwsh.exe`、不出现 `BurntToast` | I4 | [机检] |
| D7 | 路径解析 | 在 Windows 上默认解析到 `System32\WindowsPowerShell\v1.0\powershell.exe`（不是 `pwsh`）；`PACKAGE_ROOT` 由本文件位置推出，**不写死绝对路径** | I4 | [机检] |
| D8 | 脚本资产（常驻分支） | 常驻分支同时给 `scenario="reminder"` **与**一个 `content="Dismiss"` / `arguments="dismiss"` / `activationType="system"` 的 action（`content` 省掉整条通知到不了屏幕；`activationType` 不许是 foreground / background / protocol）—— **这是源码文本回归**（`readFileSync` + 正则），只防写法回退、**证明不了真机行为**（真机口径见下面「人工 review 项」的已观测条）；`activationType="system"` 本身是官方枚举外的未文档化取值，依据是实测而非文档，见 I5a；`if ($sticky)` 恰好两处（scenario 一处、actions 一处）；`<actions>` 追加在 `<audio>` 之后、action 先挂进 actions 再挂进 toast | I5a | [机检] |

一条**最重要的测试纪律**（D2 的来源）：造工具定义必须用**真的** `defineTool`（本地助手 `realToolDefinition()`）。只跑 stub 的自测证明不了这个插件能被装载 —— schema 形状写错时 `apply()` 会在注册那一刻抛 `JsonSchemaError`。

跑法上的两个细节：测试用 `FakeChild` + `fakeSpawn(plan)` 注入替身，**一个真进程都不起**（所以无桌面环境也能全绿）；D6 直接读 `notify/scripts/toast.ps1` 的字节，BOM 与 ASCII 是**字节级**断言，不是"看起来没问题"。

## 迁移矩阵

**无。** 本模块的对象（Notification / ToastRequest / ToastResult）与两条作者侧契约（`parameters` / `output`）都是**不可变值对象**，没有状态机、没有状态迁移（见 `design.md` 的「核心数据模型」）。逐格验证由上面的用例总表承担，本节不设矩阵表。

## 消费方契约测试

本模块有**三个**消费方，消费的**形状**不同 —— 改它们之前先看这一节：调度 persona 与每次委派的 `tools`（消费**工具名**）、`install.ps1` / `install.sh`（消费**目录名与包名**）、**设置页那份设置文件**（消费**通知三项的键名、默认值与界**）。

### 消费方（调度 persona 与每次委派的 `tools`）消费的是**工具名**

`notify_user` 由调度者在 `delegate` 的 `tools` 里逐次给（`delegate` 的内置 deny 里**没有**它），`tools/check-preset.mjs` 的 `KNOWN_TOOLS` 也收了这个名字。名字必须**恰好等于** `TOOL_NAME`（`notify/index.mjs`）；**改了工具名就要同步改 `tools/check-preset.mjs` 的 `KNOWN_TOOLS` 与 `delegate` 侧的名字口径**，否则两侧各有后果：preset 的静态 `allow` 里出现未知名时 `dsh-tools` 的 `restrict()` 会在**派发那一刻**抛 `names unknown global tool notify_user`，整次委派失败；经 `delegate` 的 `tools` 点名的未知名则会被剔除并逐条写进 `tools_note`（不静默丢、也不让那次委派失败）。

漂移检测（机检）：在仓库根跑 `node tools/check-preset.mjs`，判据＝exit 0（允许 WARN；ERROR 的含义只有一个 —— 那次委派必然抛错）。**不要把它打印的读数写进文档**：`allow` 项数、警告条数、委派行数都是当场读数、不作锚，结构性判据在脚本里。

### `install.ps1` / `install.sh` 消费的是**目录名与包名**

- 源目录名固定 `notify\`（`$notifySrc` / `notify_src`），落点 `${DSH_HOME:-~/.dsh}/plugins/adg-notify/`（`$notifyDest` / `notify_dest`）；改仓库目录名要同时改两个脚本。
- 包名 `adg-notify` 同时出现在：稳定副本的 `package.json`、profile 的 `dependencies`、profile 的 `dsh.profile.bundles`、安装脚本第 4c-1 步的断言里。改名要四处一起改。
- **稳定副本与 profile 副本是硬链接（同一个文件）** ⇒ 刷新稳定副本（`Copy-Item` 就地覆盖，链接因此存活）就等于刷新所有 profile 副本，**不需要 `dsh plugin remove` + `add`**；而仓库源与稳定副本在不同盘、不可能硬链接 ⇒ 改了仓库里 `notify/` 的源码**必须重跑一次安装脚本**（第 2b 步输出里说明已是最新，就是没改）。判据（当场读数、不作锚）：`fsutil hardlink list <稳定副本>\package.json` 与对 profile 副本的同一条命令返回同一组路径，`fsutil file queryFileID` 两处返回同一个 ID。

漂移检测（人工 review）：核对两个脚本的拷贝清单与 `notify/package.json` 的 `files` 字段。**两者故意不同**：脚本多拷 `notify/cli.mjs` 与 `notify/package.json` —— 前者是开发机上的自测入口，不需要被 pnpm 打进 profile 副本；后者是包清单，pnpm 总会拷。判据：profile 的 `node_modules/adg-notify/` 里**运行期四件套**（包内相对路径 `index.mjs` / `lib/toast.mjs` / `lib/user-settings.mjs` / `scripts/toast.ps1`）加 `cordis.patch.yml`、`package.json` 都在，且**没有** `cli.mjs`。`files` 里漏掉运行期文件才是缺陷 —— 漏一个就是"装载时 import 找不到模块"，整个 `notify_user` 会从工具面上消失（2026-10-08 真发生过一次：`lib/user-settings.mjs` 新加进 `index.mjs` 的 import 与 `files`，但安装脚本的拷贝清单漏了它，稳定副本与 profile 副本都没有这个文件）。

**新增文件不会自己传播**：稳定副本 ↔ profile 副本是**逐文件**硬链接，pnpm 只在 `dsh plugin add` 时拷文件 ⇒ 往包里加一个新文件后，重新跑安装脚本的 2b 步只更新稳定副本，**已装好的 profile 副本仍然缺那个文件**。判据（机检）：`install.*` 尾部的「profile 副本缺文件」核对（对每个包、每个 profile 比对稳定副本的文件集合，跳过 `cli.mjs` 与 `node_modules/`），一条都不该打印；真打印了就先关掉 dsh、删掉那个 profile 副本目录再重跑（或 `dsh plugin --profile <n> add "file:<稳定副本>"`）。

### 设置页那份设置文件（本模块 ← `settings/`）消费的是**三个键名、默认值与界**

本模块的三项行为（`notifyTitle` / `notifySound` / `notifyPersist`）不是本模块定的：键名、默认值与界的唯一真相在 `settings/lib/schema.mjs` 的 `FIELDS`（`consumer === 'adg-notify'` 那三条登记）。本模块**只读**那份文件 —— 落点＝`settingsFile()` 的优先序 `${DSH_PROFILE_DIR:-${DSH_HOME:-~/.dsh}}/adg-settings.json`（宿主进程里 `DSH_PROFILE_DIR` 就是当前 profile 目录 ⇒ 真实落点是 `<profile>` 目录下那份，**不是**用户根那份）；读写经 `notify/lib/user-settings.mjs` 的 `settingsFile()` / `readUserDefaults()` / `resolveRequest()`，**不 import `adg-settings` 包** —— 见 R13 与 `design.md` 的 I15。

| 键 | 默认 | 消费点 |
|---|---|---|
| `notifyTitle` | `notify/lib/toast.mjs` 的 `DEFAULT_TITLE` | 某次调用没写 `title`（或写了空白）时用的标题 |
| `notifySound` | `true` | 关掉时给 `sendToast` 写 `silent: true` |
| `notifyPersist` | `true` | 关掉时写 `disappearAfterMs: 8000`（`AUTO_DISMISS_MS`） |

载体 `notify/test/user-settings.test.mjs`（10 条）：①`USER_DEFAULTS` 三项等于出厂默认、冻结，`AUTO_DISMISS_MS === 8000` / `MAX_TITLE_LENGTH === 80` / `STORE_NAME`；②`settingsFile()` 与宿主同口径（`DSH_PROFILE_DIR` > `DSH_HOME`）；③出厂默认下 `resolveRequest({message})` **只有** `message` + `title` 两个字段；④-⑤这一次调用的 `title` / `silent` 压过设置页；⑥空白标题（`''` / `'   '` / 非字符串）算"没写"、回落；⑦`sound:false` 才写 `silent:true`、`persist:false` 才写 `disappearAfterMs`；⑧-⑩`readUserDefaults` 的宽容面（不存在 / 坏 JSON / 数组 / `null` / 缺项 / 坏项 / 字符串布尔 / 标题 80 收、81 不收）一条都不抛错。

**漂移检测（机检）**：`cd notify && node --test test` 与 `cd settings && node --test test` **都要绿** —— 两份漂移用例各从一侧看同一组键，两边都钉住才拦得住"只改了一侧"。**生效口径**：改这三项的**值**保存即生效、不用重启（每次调用都重新读文件）；键名或本模块源码变了才要重装子插件 + 重启 dsh（见「生效方式」）。

## 验证 ≠ 装载

这一节是本模块最容易自欺的地方，单独列出来。

**能证明的**（不重启）：

1. `node --test test` 全绿 ⇒ 注册与失败路径的**代码**是对的（判据：exit 0、没有失败用例）。
2. `node cli.mjs send --message …` exit 0 ⇒ **toast 通路**在这台机器上真的能用（与 `notify_user` 同一个 `sendToast`）。
3. profile 的 `package.json` 里 `dependencies.adg-notify` 与 `dsh.profile.bundles` 都出现，且 `<profile>/node_modules/adg-notify/package.json` 存在 ⇒ **装了，且被选中**。安装脚本第 4c-1 步做的就是这三格断言。
4. `<profile>/node_modules/adg-notify` 是**真目录**（`LinkType` 为空）、不是符号链接。
5. **"插件与 preset 由同一个脚本同一次装上"可以当场证**（这是那些点它的 `tools` 成立的前提，I9）：一次 `install.*` 运行既做第 2b / 4c / 4c-1 步（插件）又生成四份 `bundle/adg-*` 并链接 profile 的 preset bundle；`<profile>/node_modules/dsh-adg-ptc` 是指向 `$DSH_HOME/bundles/dsh-adg-ptc-<味道>` 的 **Junction**（`LinkType: Junction`），四个稳定目录里的 `cordis.patch.yml` 与 `bundle/adg-*` 产物应当逐字节一致（判据：SHA256 比对）。

**证明不了的**（必须重启）：

- dsh 的 loader 有没有 import 这个包、`ctx.tools.register` 有没有真的执行 —— ES 模块按解析路径缓存，被替换的代码不会被重新 import。
- 因此也证明不了"子代理真的能看见 `notify_user`"。要验它：**重启 dsh → 新建会话 → 用 `delegate` 派一个带 `notify_user` 的子代理，让它在撞上登录墙时调它**（或先看它那次拿到的工具面里有没有这个名字）。

**一条很容易踩的假证据**：`dsh --dump-config` / 读静态文件只能说明"配置里有这一行"，**说明不了挂载**。根 `AGENTS.md` 的「Quality Gates」一节对 preset 写的是同一条口径（"静态自检证明不了挂载"）。

## 人工 review 项

自动化抓不到、必须真机跑或必须有人看的部分；每条都带量法。**未观测不许写成实测，也不许写成"不可观测"。**

- **未观测**：重启 dsh 后 `notify_user` 是否真的出现在某次委派给出的子代理工具面里；量法：重启 dsh → 新建 Adg 对话 → 用 `delegate` 派一个带 `notify_user` 的子代理，看它那次拿到的工具面里有没有这个名字，或直接派一次"撞登录墙"的任务看它是否调 `notify_user`。
- **未观测**：子代理是否会在正确的时机主动调它；量法：在会话转写里检索 `notify_user` 的调用；若出现"撞了登录墙却干等 / 直接失败"，说明 description 的触发面写得不够。
- **已观测（2026-10-08，本机 Win11 · 2560×1600 · 截屏 + `read_image` 判读）**：toast 的可见形态 —— 修好后的常驻通知是**屏幕右下角**一条横幅（压在任务栏之上），**标题一行 + 正文一行**，常驻时多一枚按钮（本模块写死 `content="Dismiss"`，所以按钮字是英文 `Dismiss`，不随界面语言变），右上角另有系统的关闭叉。量法：`node cli.mjs send --message '正文' --show` 之后截屏判读。**未逐条核**：正文带换行时的排版（同一条通知里正文换行会撑成多行、但模板是 `ToastText02` 的两段文本）、长标题截断。
- **已观测（2026-10-08，同一台机器，逐张截屏判读）**：默认 `disappearAfterMs = 0`（`scenario="reminder"`）在真机上**会留在屏幕上**，但**前提是同时带一个按钮**（I5a）—— 只设 `scenario` 会被 Windows **静默忽略**、退回普通通知、几秒内自己消失。实测（发送时刻 → 判读）：
  - 修好前：`node cli.mjs send --message 'BASELINE 常驻测试 ms=0' --show`（exit 0，返回 `disappearAfterMs: 0`）→ 弹后 **6.0s 横幅在、19.7s 横幅已消失**。用户报的就是这个现象。
  - 修好后同一条命令 → 弹后 **8.15s / 34.78s / 71.43s 三张里横幅都在**（带 `Dismiss` 按钮）⇒ 满足"≥60 秒仍在屏幕上"。
  - 反向对照（同一条真机路径）：`--ms 5000` → 6.19s 在、17.14s 已消失；`--ms 8000`（＝设置页把「通知常驻」关掉时 `AUTO_DISMISS_MS = 8000` 走的那条，落在 `duration="long"`）→ 5.99s 在、33.77s 已消失。**独立复核子代理在本机复测到的是另一组数：`--ms 8000` 约 16.9s 消失、`--ms 5000` 约 16.8s** —— 与我这两次读数差在**系统回收粒度**上（同一机制：几秒到十几秒后自动消失，与常驻的"分钟级乃至不动"是两个量级）；两组数都只是"某时刻在 / 某时刻不在"的截断读数，不构成精确寿命。
  - 单变量隔离（临时实验脚本 `exp-toast.ps1`，只落系统临时目录、不进仓库）：①`reminder` 无按钮 → 6.0s 在 / 19.7s 无；②`reminder` + system dismiss 按钮 → 8.1s / 34.8s / 72.7s 都在；③**无 `scenario`** + 同一个按钮 → 7.0s 在 / 23.8s 无。⇒ 起作用的是「`scenario` **且** 至少一个按钮」，两者缺一不可。结论与官方两处原文一致，见 I5a。
  - 两个坑（都实测过）：①`cli.mjs send` **不读**设置文件（只吃 `--ms`），所以"设置页关掉常驻 → 8000"这一跳由 `notify/lib/user-settings.mjs` 的用例钉住，真机上验的是同一个 8000 值；②**通知中心（`ToastNotificationManager::History`）里有记录证明不了屏幕上看得见** —— 被静默忽略的 reminder 一样留在 History 里（本机实测），所以判读只能靠截屏。
  - **装到本机之后的端到端（同机、装完未重启 dsh，2026-10-08 约 03:19）**：在宿主里直接调 `notify_user`（走的就是 profile 里那份 `adg-notify`）→ **[人]** 用户本人当场确认：**这条通知不自动关闭，并且有一枚 Dismiss 按钮，点了按钮通知就消失**，屏幕上不留残留。同一时段我自己连拍的三张截屏（`e2e-t05/t30/t70.png`，发送后 ≥6.94s / ≥33.58s / ≥75.22s）**一张都没抓到横幅** —— 因为用户看到后很快就点掉了（Dismiss 会把它同时从屏幕和通知中心拿走）；**这不等于「通知没弹出来」**，这次的常驻判读由 [人] 观测补位。顺带第三个坑：PowerShell 5.1 里 `History.GetHistory($appId)` 的返回值是 `__ComObject`，直接取 `.Count` / `.Size` 都是空值（本次实测）—— 别把它读成「没有通知」，要逐条看内容得换写法。⇒ 装后环境上常驻成立（含按钮可关）；本次只改了 `scripts/toast.ps1`（每次调用重读），`lib/*.mjs` 与 `index.mjs` 的哈希与改前一致 ⇒ **不重启 dsh 就吃到了新脚本**。
- **未观测**：宿主正在运行时 `dsh plugin add` 的失败形态（`os error 32` 是**预期**，脚本会如实报告并不中断后续步骤）；量法：宿主在跑时执行 `install.ps1`，看第 4c 步是否如实报告且没有中断；要真正走到 `dsh plugin add`，先 `dsh plugin --profile <profile> remove adg-notify`（宿主在跑时有风险，何时做由人决定）。
- **未观测**：非 Windows 平台的形状；量法：在非 Windows 机器上跑 `node --test test`，看非 win32 那条用例通过、其余按预期失败。本模块的定位就是 Windows 通知，**不打算**为其他平台实现降级。
- **已观测（2026-10-08，**独立复核子代理**在本机测得，此处转记它的读数、不是我本人复现）**：**并发投递不会互相吞掉** —— 两次 `send` 间隔 ~1.1s（两条都 exit 0）→ 通知中心里两条，9.16s 后仍是两条，屏幕上同时两条横幅、各带一枚 `Dismiss` 按钮。⇒ 原先这条「未观测」就此转成已观测。
- **已观测（同上，独立复核所得）**：`Dismiss` 是**真的系统 action**，不是装饰 —— UIA 树上读到 `Button | VerbButton | Dismiss`，对它 `InvokePattern.Invoke()` 之后通知中心计数从 1 → 0（通知被系统拿走）。
- **已观测（同上，独立复核所得）**：**设置链路端到端**（它写的是"真实设置文件 + 真实消费链，验完已删除还原"；复核后我也确认两处候选落点都不存在该文件）—— 文件不存在 ⇒ 出厂默认 `notifyPersist: true` ⇒ `disappearAfterMs = 0` ⇒ 常驻（8.8s / 43.2s / 71.8s 仍在、带按钮）；文件写 `{"notifyPersist":false}` ⇒ `8000` ⇒ 5s 仍在、12s / 20s 已无。⇒ 「设置页那一跳」在真机上闭环。
- **未观测**：用**鼠标像素级点击**那枚 `Dismiss` 按钮（本机指针注入不生效：`move` 之后光标没动 —— 与 `desktop/` 的既有口径一致，见它的未观测项）；量法：完全权限会话里 `click` 后应得 `CURSOR_LANDED=true` 且通知消失。**但「按钮可关」这一半有 [人] 证据**：用户本人用真鼠标点过那枚按钮，点了通知就消失（同一台机器、同一条常驻通知）。

## 交付前的最小闭环

```powershell
cd notify
node --test --test-isolation=none test          # 须 exit 0、没有失败用例
node cli.mjs send                               # 须 exit 2
node cli.mjs send --message x --ms soon         # 须 exit 2
node cli.mjs send --message '闭环测试' --show    # 须 exit 0，屏幕上真弹一条；会打扰用户，只在需要人看时跑

# 部署侧（可在宿主运行时跑，失败按「已知限制」口径如实报告）
# 必须用 Windows PowerShell 5.1 跑（`powershell`），不是 `pwsh`：install.ps1 是按 5.1 写的、带 BOM 的脚本
powershell -NoProfile -ExecutionPolicy Bypass -File ..\install.ps1 -Profiles <profile>
# 装完后的三格证据（不重启能拿到的最强）：
# 落点以本机 DSH_HOME 为准（缺省才是 $HOME\.dsh）；install 脚本同样优先读它，取值非绝对路径时先归一、归一不到就停下报错：
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
Select-String -Path "$dshHome\profiles\<profile>\package.json" -Pattern 'adg-notify'
Get-Item "$dshHome\profiles\<profile>\node_modules\adg-notify" | Select-Object LinkType
```

（`<profile>` 换成你自己的 profile 名 —— 即 `~/.dsh/profiles/` 下的目录名；本文件其余 `<profile>` 同义。）

（第 2b 步按 **SHA256 内容比对**决定要不要拷；稳定副本已是最新时它只说明已是最新、无需拷贝。）
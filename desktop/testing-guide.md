---
title: desktop 模块测试指南
owner: Adg preset 维护者
status: current
last_reviewed: 2026-10-15
---

# desktop 模块测试指南

不变量在 `design.md`（`I1…I11`、`I2b`、`I6b–I6f`、`I7b–I7g`、`I9b`），本文只写**怎么验**。载体四类：`[机检]`＝`cd desktop && node --test test`（零依赖、不碰真实桌面，全部假数据）；`[真机]`＝要有本机桌面与**在完全权限（`danger-full-access`）会话里**跑（受限会话里注入会被 UIPI 静默丢弃，那些用例只证明"闸门与观测如实工作"，证明不了"注入可用"）；`[人]`＝脚本抓不到、要人眼看；`[评]`＝对 `skills/` / `README.md` 侧文本的审查。判据一律以命令输出为准。

## 命令（可直接照抄）
```sh
cd desktop && node --test test                       # 全部单元用例
cd desktop && node --test --test-isolation=none test # 本机沙箱（workspace-write 等受限会话）里必须加这个 flag
```

第二个 flag 的原因是不变量 I11：`node --test` 默认给每个测试文件起一个 **pipe-stdio** 子进程，而受限令牌下 `spawn(..., { stdio: 'pipe' })` 直接抛 `EPERM`；`--test-isolation=none` 让测试跑在同一个进程里。**同一条限制也是桥的通道设计理由**（`runBridge` 只用文件重定向）——它不是测试环境特有的怪癖。

## 用例总表
「载体」列：`[机检]`＝上面那条单元测试命令；`[真机]`＝「交付前的最小闭环」一节的命令序列；`[人]`＝人工 review 项。
| 用例ID | 对象 | 断言内容 | 对应不变量 / 迁移 | 载体 |
|---|---|---|---|---|
| D1 | ScreenBox | `screenBox` 从 `{screenWidth, screenHeight, virtualLeft, virtualTop, virtualWidth, virtualHeight}` 取出虚拟屏四元组 | I1 | [机检] |
| D2 | ScreenBox | 缺字段时不编造：拿不到的尺寸不参与换算（返回 `undefined`/0 而不是猜一个） | I1 | [机检] |
| D3 | 坐标换算 | 原点 `0,0`、`2560×1600`、目标 `(100,100)` ⇒ 归一化 `2561,4098` | I2 | [机检] |
| D4 | 坐标换算 | 分母是**尺寸减一**：`(2559,1599)` ⇒ `65535,65535`（用尺寸做分母到不了上界） | I2 | [机检] |
| D5 | 坐标换算 | 中点 `(1280,800)` ⇒ `32780,32788`（不是 32768） | I2 | [机检] |
| D6 | 坐标换算 | 负原点屏（`originX=-1920`）：目标恰在原点 ⇒ `0,0`；跨屏点落在 0..65535 内 | I1 / I2 | [机检] |
| D7 | 坐标换算 | `fromAbsolute` 是 `toAbsolute` 的逆（往返误差 ≤ 1 px） | I2 | [机检] |
| D8 | 坐标换算 | 越界点被 `toAbsolute` 标成 `clamped`，`insideScreen` 给 false；`clampRegion` 把区域夹回虚拟屏内 | I2 | [机检] |
| D9 | 坐标换算 | `dpiScale(2560, 1707)` ⇒ ≈1.5（虚拟化系数可判读） | I1 | [机检] |
| D10 | 参数解析 | `--k=v` 与 `--k v` 等价；非 `--` 开头进 `_` | 命令行契约 | [机检] |
| D11 | 参数解析 | `BOOLEAN_FLAGS`（`json`/`dry-run`/`double`/`force`/`fallback-point`/`raise`/`no-pixel`/`no-content`/`hash`/`help`）**绝不吞下一个 token**：`--json windows` ⇒ `json=true` 且 `_=['windows']`（`--target-hwnd` 是**值类**开关，缺值即用法错，见 D64） | 命令行契约 | [机检] |
| D12 | 参数解析 | `hasValue` 对布尔开关给 false，对 `--x 10` 给 true（用于区分"给了值"与"给了开关"） | 命令行契约 | [机检] |
| D13 | 参数校验 | `requireInt` 的区间、非整数、缺值都必须抛 `UsageError`（不是返回 `undefined`） | 命令行契约 | [机检] |
| D14 | 参数校验 | `requirePoint` 缺 `--x` 或 `--y` 抛错；`requireButton` 只认 `left`/`right`/`middle` | 命令行契约 | [机检] |
| D15 | 参数校验 | `assertNoExtra` 对多余位置参数抛错（拼错命令名不许被静默忽略） | 命令行契约 | [机检] |
| D16 | 参数校验 | 越界值（如 `--depth 0`、`--limit -1`）抛 `UsageError` | 命令行契约 | [机检] |
| D17 | 输出格式化 | `patternsText` / `rectText` / `treePrefix` 的形态（空数组给 `-`，矩形给 `l,t,w,h`） | 输出行契约 | [机检] |
| D18 | 元素 id | `fnv1a32` 的固定参考值：`''`→`811c9dc5`、`'a'`→`e40c292c`、`'42.1000.7'`→`5050afed`、`'42.65552'`→`ef243646`、`'保存'`→`a9629697`、`'DeepSeek Harness'`→`1478b7ff` | I6 | [机检] |
| D19 | 元素 id | `elementId` 形如 `el_<8hex>`、`isElementId` 认它并拒绝别的东西 | I6 | [机检] |
| D20 | 元素定位 | `pickElement` 不给选择器 ⇒ 给 `reason`（不猜）；`--name` 命中 0 个 / 命中多个 ⇒ 都给 `reason` | I6 | [机检] |
| D21 | 元素定位 | `--id` 不在快照里 ⇒ `reason`；命中时返回那一个元素 | I6 | [机检] |
| D22 | 语义动作 | `chooseAction` 的优先级固定为 `Invoke → Toggle → SelectionItem → ExpandCollapse` | I7 / 红线 4 | [机检] |
| D23 | 语义动作 | 元素无任何可用 pattern ⇒ `{error}`，**不退化成坐标点击** | 红线 4 | [机检] |
| D24 | 语义动作 | `--set-value` 无 `ValuePattern` ⇒ `{error}`；有 ⇒ `pattern='ValuePattern'` | 红线 4 | [机检] |
| D25 | 注入闸门 | `decideInjection`：目标 IL 高于自身 ⇒ `block-uipi-higher`；自身高 ⇒ `can-inject` | I8 | [机检] |
| D26 | 注入闸门 | 目标 IL `unknown` ⇒ `block-integrity-unknown`（**不假设它比我们低**） | I8 | [机检] |
| D27 | 注入闸门 | `--dry-run` ⇒ `skip-dry-run`（优先于一切，不发事件） | I10b | [机检] |
| D28 | 注入闸门 | `--force` 且目标更高 ⇒ `forced`（而不是 `can-inject`），调用方据此打 `WARN=` | I8 / 非功能红线 5 | [机检] |
| D29 | 完整性级别 | `normalizeIntegrity` 认 `untrusted`/`low`/`medium`/`high`/`system`/`protected` 与 `unknown(rid=N)` 形态；`integrityRank` 对未知返回 `undefined`（**不是 0**） | I5 / I8 | [机检] |
| D30 | 完整性级别 | 大小写与 `S-1-16-4096` 式输入都能归一 | I5 | [机检] |
| D31 | 状态比较 | `compareStates`：前台窗口变化 ⇒ `changed=true` 且 `reasons` 里有对应一条 | I7 | [机检] |
| D32 | 状态比较 | 窗口集合与标题变化（`titlesDigest` 不同）⇒ `changed=true` | I7 | [机检] |
| D33 | 状态比较 | 全同 ⇒ `changed=false`、`reasons` 为空、`digestBefore === digestAfter` | I7 | [机检] |
| D34 | 状态比较 | 缺"前"或"后"时不抛错，按 `normalizeState` 的缺省口径比较 | I7 | [机检] |
| D35 | 判据 | `parseExpect` 认 `EXPECT_KEYS` 的全部键；未知键抛 `UsageError` | 输出行契约 | [机检] |
| D36 | 判据 | `checkExpectations` 逐条给 `ok`，不因一条不符就丢别的（便于定位） | 输出行契约 | [机检] |
| D37 | 不可假成功 | `injectionWarn`：`CHANGED=false` 时给含"静默"、附 `INSERTED_EVENTS` / `LAST_ERROR` / 两边 IL 的 `WARN=`；`CHANGED=true` 时返回 `undefined` | I7 | [机检] |
| D38 | 入口 | `MIN_NODE_MAJOR = 22`；`nodeMajor` / `runtimeVerdict` 对低版本给出人话原因 | 零依赖 | [机检] |
| D39 | 入口 | `dshHome` 优先 `DSH_HOME`、缺省 `<home>/.dsh`；`installedEntry` / `repoEntry` 的拼接固定 | 部署形态 | [机检] |
| D40 | 平台闸门 | `platformVerdict('win32')` ⇒ `null`；其它平台 ⇒ 含「Windows 专用」与平台名的字符串 | 平台闸门 | [机检] |
| D41 | 用法错退出码 | 不认识命令 / 缺值 / 越界 ⇒ 退出码 **2**，stderr 首行 `ERROR=`，**第二行只给一句 `提示：node cli.mjs help 看完整用法。`**（不吐整屏 USAGE） | 命令行契约 / M10 | [机检] |
| D42 | 零依赖 | 只允许 `node:` 内建与相对路径的 import（扫全部 `.mjs`） | 零依赖 | [机检] |
| D43 | 桥脚本形态 | `scripts/bridge.ps1` 是 ASCII-only 且无 BOM（首字节 `0x23`，全部字节 < 128） | 非功能红线 4 / 红线 6 | [机检] |
| D44 | 坐标契约 | 本进程声明了 `PER_MONITOR_AWARE_V2` 且屏幕读数是物理像素 | I1 | [真机] |
| D45 | 截屏 | 截屏不缩放、`WIDTH`/`HEIGHT` 等于物理像素、`SHOT_EXISTS=true`，画面是真实桌面（不是空白/全黑） | 职责与边界 | [真机] |
| D46 | 窗口枚举 | `windows` 的进程名 / 类名 / 矩形 / 完整性级别都读得出；读不到的写 `unknown` 且**不是报错** | I5 | [真机] |
| D47 | 坐标往返 | `point` 报的 `ROOT_HWND` 与 `windows` 里那一行一致（`GetAncestor(GA_ROOT)` 生效） | I4 | [真机] |
| D48 | 元素 id 稳定 | 一个进程里拿到的 `el_…`，在**另一个新进程**里 `uia --id` 报 `FOUND=true` | I6 | [真机] |
| D49 | 语义护栏 | 对无 pattern 的容器元素 `invoke --id` ⇒ `WARN=` + 退出码 **2**（不猜、不退化） | 红线 4 | [真机] |
| D50 | 注入闸门（受限） | 受限会话（`INTEGRITY_SELF=low`）里对 Medium 窗口 `click` ⇒ **注入前**就 `ERROR=UIPI blocked: …` | I8 | [真机] |
| D51 | 干跑 | `click --dry-run` 印出绝对坐标与归一化值，`NORMALIZED_IN_RANGE=true`，不发事件且 `WARN=` 说明 `CHANGED=false` 不是失败 | I10b / I2 | [真机] |
| D52 | 注入生效（完全权限） | `move` 后 `CURSOR_LANDED=true` 且 `CURSOR_AFTER=` 与请求像素相等（±1） | I3 / I7 | [真机] |
| D53 | 注入生效（完全权限） | 对自建测试窗口 `click` ⇒ `CHANGED=true`，且按钮侧计数从 N 变 N+1 | I7 | [真机] |
| D54 | 键盘注入（完全权限） | `type` 后 `CHARACTERS=` 等于字符数、文本被目标控件读回（首字符不丢） | I7 / InjectionPlan | [真机] |
| D55 | 被拦时的正确输出 | 受限会话里真发一次（不带闸门时代不可复现，改用 `--force` 硬发）⇒ `INSERTED_EVENTS>0`、`LAST_ERROR=0`、`CHANGED=false` + `WARN=` | I7 | [真机] |
| D56 | 结构体尺寸 | `INPUT_STRUCT_SIZE=40`（`KEYBDINPUT` 单独放会被 CLR 对齐成 32 ⇒ `rc=0 err=87`） | I9 | [真机] |
| D56b | 诊断取样窗口 | `LAST_ERROR=` 是 `SendInput` 返回后**立刻**取的（成功的调用不清空 `GetLastError`，中间夹一次 `GetCursorPos` 会留下陈旧码，实测出现过 `203` 而同一行写着"已插入 3 个事件"）；判据是它**只作诊断**，不许进任何 `ERROR=` 分支 | InjectionPlan / I7 | [真机] |
| D57 | 抬升 | `--raise` ⇒ `RAISED=true` + `RAISE_TARGET=`；不给就不出现这两行 | `--raise` 副作用 | [真机] |
| D57b | 抬升的三态 | `--raise` 用在**指不出窗口**的命令上（`type`/`key` 不带 `--hwnd`、鼠标类不带 `--x/--y`）⇒ **不发事件**、给一条 `WARN=` 说明它需要哪个参数；`--dry-run` 不报这条 WARN | InjectionPlan / S1 | [机检] |
| D57c | 前台闸门 | 键盘类命令注入前核对 `GetForegroundWindow()`，不是目标就重试；**重试后仍不是前台 ⇒ 报 ERROR 且一个键都不发**；目标取不到同样 ERROR | InjectionPlan / B1 | [真机] |
| D58 | 只观测 | `verify` 单跑 ⇒ `CHANGED=false` + `WARN=` 说明"没有前可比"；带 `--expect` 时给出 `EXPECT_OK=` | I10 | [真机] |
| D59 | 平台闸门 | 非 Windows：除 `profile`（`WINDOWS_ONLY=false` + `WARN=`）外每个命令退出码 1 并给人话原因 | 平台闸门 | [机检] |
| D59b | 结构体字节 | `probe`（**从不调 `SendInput`**）⇒ `INPUT_STRUCT_SIZE=40`、`MOUSE_INPUT_SIZE=32`、`KEY_INPUT_SIZE=24`，且鼠标字节偏移 8/12 的 `dx/dy` **非零**、偏移 20 的 `dwFlags == 0xc001`，键盘偏移 8 处 `wVk == 65`（结构全零缺陷的**唯一**判据：静态审查看不出来） | I9 / P0-A | [机检] |
| D60 | 技能一致性 | `skills/adg-computer-use/SKILL.md` 与 `README.md` 的「子代理与能力带」一节里提到的每条 `cli.mjs` 命令与选项都能在 `help` 里找到同名项 | 消费方契约 | [评] |
| D61 | 单 pattern 不塌陷 | 宿主把"恰好一种 pattern"回成标量时，`patternList` 仍给单元素列表、`patternsText` 仍显示它、`chooseAction` 仍能选中；**坏形状（裸字符串 / 内含数组）另由 `patternShapeProblem` 报出来**，不许靠 `patternList` 静默兜底（桥侧包装只许有一处：`Get-PatternNames` 的 `,@(...)` 保留，调用点用 `[object[]](…)` 且**不加 `@()`**） | I6 / I6b / P0-B | [机检] |
| D62 | 落点归属不参与 CHANGED | `landingNote` 比**顶层**窗口（指针落在目标内部的小控件上也算命中）；注入类命令把 `point` 从差异集合剔除（`IGNORED=point`），否则注入失败也会报 `CHANGED=true` | I7 / P0-C | [机检] |
| D63 | 临时目录不残留 | 任意命令跑完，`(Get-ChildItem $env:TEMP -Directory -Filter 'adg-desktop-*').Count` 不变（成功路径也删） | I11 / B2 | [机检] |
| D64 | 值的开关不静默 | `REQUIRES_VALUE` 里的开关缺值 ⇒ 用法错退出码 2，**不静默变成 `true`**；布尔开关不吞下一个 token | 命令行契约 / M1 | [机检] |
| D65 | 偏移唯一真相源 | `probe` 的 12 个 `OFFSET_*` 逐个等于 `WinUser.h` 推导的绝对偏移（`type=0`、`dx=8`、`dy=12`、`mouseData=16`、**`mouseFlags=20`**、`mouseTime=24`、`mouseExtraInfo=32`、`wVk=8`、`wScan=10`、**`keyFlags=12`**、`keyTime=16`、`keyExtraInfo=24`）；`CANONICAL_STRUCT_SIZE=40` 与 `INPUT_STRUCT_SIZE` 相等 | I9 / 红线 7 | [机检] |
| D66 | 平铺 vs 嵌套 union 逐字节相同 | `MOUSE_MATCHES_CANONICAL` / `KEY_MATCHES_CANONICAL` / `KEY_UP_MATCHES_CANONICAL` **三者必须都是 `true`**，且 `CANONICAL_MOUSE_BYTES_HEX === MOUSE_BYTES_HEX`（参照结构体是 `WinUser.h` 原样的嵌套 union，只用于比对、不用于注入）。这是"偏移改错了、字节却看着对"唯一抓得住的判据 | I9 / 红线 7 | [机检] |
| D67 | 键盘 flags 在偏移 12 | 键盘 down 事件的偏移 12 处是 `KEYEVENTF_UNICODE=4`、keyup 是 `6`（`UNICODE\|KEYUP`）；**同一批字节的偏移 20 必须是 0**（那是 `KEYBDINPUT.time` 的位置，放错就会把 `KEYEVENTF_UNICODE` 静默清零，真机症状是 `INSERTED_EVENTS>0` 而靶窗口一个字符都没进） | I9 / P0-④ | [机检] |
| D68 | 滚轮负数先转位再装箱 | `probe` 的滚轮事件偏移 16 = `0xfffffe98`（`-360` 的 uint32 位模式）、偏移 20 = `0x0800`（`MOUSEEVENTF_WHEEL`）、`WHEEL_DW_DATA=-360`（同一批字节按 int32 读回）、`WHEEL_CLICKS=-3`、`WHEEL_MATCHES_CANONICAL=true`；`scroll --x … --dy -3 --dry-run` 退出码 0 且 `WHEEL_DW_DATA=-360` | I9b / 红线 8 | [机检] |
| D69 | patterns 形状契约（两条路径同源） | 同一份快照里，原始 JSON **不许出现字面 `"patterns":[[`**（两层包装的指纹）；同一 `el_id` 在 `uia --depth` 与 `uia --id` 两条路径下 `patterns` `deepEqual`；文本渲染的 patterns 列与 JSON 逐行一致；`uia --id` 命中时 `elements` **不裁剪**（下游 `invoke` 要整份快照）。桌面窗口会变 ⇒ 样本必须取自**同一次调用**的 `Window` 元素，跨两次调用比行数必然抖动 | I6b / I6c / P0-B | [机检] |
| D70 | dry-run 与真跑同源 | dry-run 由桥的 `-PlanOnly` 走**同一条构造路径**算（只构造、不发送），真跑时报 `EVENTS_MATCH_PLAN=`；dry-run 的输出里**不许出现** `INSERTED_EVENTS` / `EVENTS_MATCH_PLAN`（它们只属于真跑）。`click --double` 真机报 `INSERTED_EVENTS=3 CLICKS=1` 而 JS 侧手写的 plan 说 5 —— 各算各的计划就是假证据 | I7d / 红线 10 | [机检] |
| D71 | `move` 只移指针 | `move --x … --y … --dry-run` ⇒ `PLAN_KIND=move`、`EXPECTED_EVENTS=1`、`BUTTON=`（空）、`CLICKS=0`、`DOUBLE=false`（曾因鼠标分支无条件 append down/up 而变成"移一次顺带点一下"，`BUTTON` 默认 `left`） | I7c / 红线 10 | [机检] |
| D72 | `CHANGED` 三态 | 有差异 ⇒ `true`；无差异**且这次动作的效果在判据覆盖范围内**（抓到像素，或读到过任何 UIA 内容属性）⇒ `false`；无差异**且判据全覆盖不到** ⇒ `unknown` + `VERDICT.reason`。真机实测 `type` / `key` / `scroll` 都报过 `false` 而靶侧独立证据证明已生效 ⇒ 三态里的 `unknown` 是必须的，"看不见"不许报成 `false` | I7b / 红线 1 | [机检] |
| D73 | 内容快照计入判据 | `contentHash` 变 ⇒ `compareStates` 的 `changed=true`、`reasons` 含"UI 内容"；`ignore: [content]` 时不触发。`verify` / 注入命令的复核必打 `CONTENT_BEARING_COUNT=`（可读条数），一条都读不到时 `contentNote` 里留**原始异常文本**（受限令牌下典型是 `Access is denied`） | I7b / 红线 12 | [机检] |
| D74 | id 与作用域绑定 | `invoke --id <不在本作用域快照里的 id>` 且 `SNAPSHOT_TRUNCATED=true` ⇒ 退出码 2，stderr 说的是**截断**（含 `快照被截断` 与「≠「这个元素不存在」」），**不许**说"元素可能已消失"；`SNAPSHOT_SCOPE=` / `SNAPSHOT_COUNT=` / `SNAPSHOT_BUDGET=` / `SNAPSHOT_TRUNCATED=` 四行都打出来；给了 `--hwnd 0xdead` 时 `SNAPSHOT_SCOPE=hwnd=0xdead …`（作用域真的生效） | I6d / 红线 11 | [机检] |
| D75 | `--limit` 是遍历预算 | `uia --limit 3` ⇒ `COUNT=3 SHOWN=3 TRUNCATED=true` + 一条 WARN 说明 `COUNT` 是"走到的元素数"、不是桌面上的元素总数 | I6d | [机检] |
| D76 | 组合键名不泄漏内部标识 | `key --keys ctrl+s --hwnd 0x123456 --dry-run` ⇒ `KEYS=ctrl+s`（不是 `mod17+s`）；`key --keys alt+shift+tab --hwnd 0x123456 --dry-run` ⇒ `KEYS=alt+shift+tab`。**`--hwnd` 是必填**（I7i），照抄旧示例会退 2。根因是脚本参数与函数局部同名遮蔽（`$out`）与 `"mod$mod"` 直接拼名，二者属同一类大小写不敏感陷阱 | 命令行契约 / 红线 10 | [机检] |
| D77 | 静态守卫：range 文本方法一律不许再出现 | 把 `bridge.ps1` 按行剥掉 `#` 注释后，`GetText(` / `GetSelection(` / `GetBoundingRectangles(` / `DocumentRange` **一个都不许有**（那次 AV 的源头就长这样）；同时 POLICY 注释块与正文里的 `exit=3221225477` 必须在（文字没了说明有人删了约束）。真机栈：`System.AccessViolationException at MS.Internal.Automation.UiaCoreApi.RawTextRange_GetText` | I7e / 红线 13 | [机检] |
| D78 | 内容探针必须住独立进程 | `functionBody(bridge.ps1, Invoke-VerifyCommand)` **不许**含 `Get-ContentSnapshot`；`Invoke-SnapshotCommand` **必须**含它、且**不许**含 `Send-Inputs` / `SetForegroundWindow` / `Raise-Window` / `AttachThreadInput`（零副作用）；真机跑 `node cli.mjs snapshot` 时进程**不许**崩（退出码 ≠ `3221225477`、必打 `SNAPSHOT_OK=true\|false`、退出码只能是 0 或 1） | I7e / 红线 13 | [机检] |
| D79 | 子进程崩了要走容错通道 | 对 `test/fixtures/dying-bridge.ps1`（末行 `exit -1073741819`，Windows PowerShell 里 `exit 3221225477` 会被 `[int]` 溢出成 0）—— `runBridge` 抛的 `BridgeError` 消息含 `exit=3221225477` 与 `STATUS_ACCESS_VIOLATION`、`detail` 里有 `exitCode` / `crashed` / `files`，且临时目录已删；`probeBridge` 对同一脚本返回 `{ok:false, exitCode:3221225477, crashed:true, crash:STATUS_ACCESS_VIOLATION (0xC0000005)}` 而**绝不抛** | I7e / I11 / 红线 13 | [机检] |
| D80 | 缺测既不算"变了"也不算"没变" | `compareStates` 在任一端的 `contentProbeFailed` 为真时，内容这一类**退出差异集合**（后一次读到空串 ≠ 界面变了）；`changeVerdict` 见到 probe failed 报 `unknown`——**哪怕像素哈希在也不许报 `false`**（像素看不见"文本框里的字变了"）；对照组：探针正常且读到内容时才允许 `false`；`applyContentSnapshot` 三态（读到 / 崩了 / `ok:true` 但没有 `snapshot` 字段 ⇒ 记 failed） | I7b / I7e / 红线 12 | [机检] |
| D81 | 内容读数的输出面 | `verify` 与注入类复核必打 `CONTENT_PROBE=(ok\|failed\|skipped)` 与 `CONTENT_BEARING_COUNT=<数字>`（`skipped` ＝ 给了 `--no-content`、探针压根没跑，此时必须另有一条说明覆盖面的 `WARN=`，**不许写 `ok`**）；`snapshot` 打 `SNAPSHOT_ROOT=` / `SNAPSHOT_SOURCE=` / `CONTENT_COUNT=` / `CONTENT_BEARING_COUNT=` / `CONTENT_HASH=` / `UIA_AVAILABLE=` 与逐行 `READING <role>\|<kind>\|…`，失败时 `SNAPSHOT_OK=false` + `EXIT_CODE=` + `CRASH=` | I7e / 红线 12 | [机检] |
| D82 | 几何自洽的三态 | `geoVerdict`：两套根矩形逐边差 > 2 px ⇒ `mismatch=true` 且 `reasons` 里带 Win32 与 UIA 两个矩形原文；落点元素自身矩形不含请求点 ⇒ `true`；**任一条读数缺失**（`null`）⇒ `unknown`（**不是 `false`** —— 没读到 ≠ 一致），只拿到一条也一样；唯一例外是 `uia --hwnd` 这一路：它本来就没有查询点，走 `geoVerdict(geo, { requirePoint: false })`、只验根矩形，`reasons` 里必须写明"这一路没有查询点"（`requirePoint:false` 也不许把"根矩形没对上/没读到"洗成 `false`）；两条都取到且都印证 ⇒ `false` | I2b / 红线 14 | [机检] |
| D83 | 几何矛盾时默认不发事件 | `click` / `move` / `scroll` 在 `GEO_MISMATCH=true` 时**注入前**抛用法错 ⇒ 退出码 2、`INSERTED_EVENTS` 不出现（fail-closed）；加 `--force` 才硬发且保留 `WARN=`；`unknown` 只给 `WARN=`、**不许当成"几何一致"** | I2b / 红线 14 | [机检] |
| D84 | 几何读数的输出面 | `point` 打 `GEO_WINDOW_RECT=` / `GEO_UIA_ROOT_RECT=` / `GEO_POINT_RECT=` / `GEO_MISMATCH=` 四行；`uia --hwnd` 打前三行（没有查询点 ⇒ `GEO_POINT_RECT=` 为空）；两者的 `--json` 里都带 `geo`；`GEO_POINT_RECT=` 为空不是"一致"，是"这一路读数没拿到" | I2b | [机检] |
| D85 | 判据按命令钉死 | `neededKinds`：`scroll`→`['scroll']`、`type`→`['value']`、`key`→`['value','selected','toggle','scroll','rangeValue']`、`click`→`[]`；`changeVerdict` 在"所需那一类**两端读数都为 0**"时 ⇒ `CHANGED=unknown` + `reason`（**哪怕像素哈希在**也不许报 `false`），两端都读到且没变才轮到 `false`；`CONTENT_KINDS=` 逐类报数（`ancestorScroll` 同时计入 `scroll`） | I7f / 红线 1 | [机检] |
| D86 | 祖先链只对光标下那一个元素走 | 快照对 `point`（有坐标时）或 focus **其中一个**角色沿 `ControlViewWalker` 走 3 层父元素，角色名 `ancestor1`/`ancestor2`/`ancestor3`；`content\|` 行第 3 段是 `scroll` 且角色以 `ancestor` 开头时另计 `ancestorScroll`；`CONTENT_KINDS=` 的六个键恒在（读不到就是 `0`，不是缺行） | I7f | [机检] |
| D87 | 落点归属必须有显式目标 | `landingNote` 带 `explicitTarget:false` ⇒ 只给 `sameWindow`、`inTarget=null`；CLI 侧不给 `--target-hwnd` ⇒ `LANDING_IN_TARGET=unknown` + `WARN=` 且给 `LANDING_SAME_WINDOW=`；给了 `--target-hwnd 0x…` ⇒ `LANDING_IN_TARGET=true\|false` + `TARGET_SOURCE=--target-hwnd` + `TARGET_HWND`/`TARGET_ROOT_HWND`/`TARGET_IN_WINDOW_LIST`；`--dry-run` 给 `not-evaluated` | I7g / 红线 15 | [机检] |
| D88 | 引导句按命令分开 | `injectionWarn(result, { kind })`：`scroll` 的 `WARN=` **不许**含"坐标落空"这类误导句、要写明"读不到滚动位置时报 `unknown` 不拿 `false` 冒充"；`move` 的那句要指到 `CURSOR_LANDED`（别把 `CHANGED=false` 读成移动失败）；`type` / `key` 指到 `FOCUS_OK` / `FOCUS_TARGET` | I7f / 红线 1 | [机检] |
| D89 | `screen --out` 的父目录不存在 ⇒ **用法错**（不是运行期错） | `cmdScreen` 先查 `path.dirname(--out)` 是否存在，不存在就抛 `UsageError` ⇒ 退出码 **2**、stderr 是 `ERROR=--out 的父目录不存在：<路径>`（**不许**变成 `ERROR=bridge 报错：Exception calling "WriteAllBytes"` 那种把调用方自己的错包装成桥的错）、stdout 为空、且一个字节都不写；本模块**不替调用方建目录**（取舍见 `design.md` 的退出码口径）。载体 `test/cli-contract.test.mjs` | 非功能红线 / 退出码口径 | [机检] |
| D90 | `--raise` 那条 `WARN=` 必须带桥给的原因 | `raiseNoteText(bridgeNote, fallback)`：桥文本非空 ⇒ **原样用它**（`raise-ignored-no-target` 前缀再补一句中文解释，桥的原因不许被丢掉）；桥文本为空/空白 ⇒ 回退中文常量；别的文本 ⇒ 原样透出（不硬塞中文）。`cli.mjs` 的 `report.raiseNote` 分支走这个函数。载体 `test/pure.test.mjs` | I10b / 红线 1 | [机检] |
| D91 | 开关作用域：用不上的开关一律报用法错 | `checkFlagScope(args, cmd)`（`COMMAND_FLAGS` 每条命令一份清单 + `COMMON_FLAGS`）：不认识的开关 ⇒ `UsageError`（"<命令> 不认识开关：--a（这条命令认识：…）"）；CLI 层 `move --button right` / `type --target-hwnd 0x1` / `click --dy 3` / `windows --depth 2` / `point --bogus` 各自退出码 2 且 stderr 含"不认识开关"；`allowedFlags('nosuchcmd')` ⇒ `null`（不猜清单） | I10d | [机检] |
| D92 | CLI→桥 的参数映射是静态契约（漏传没有任何运行期信号） | `test/params-map.test.mjs`：①桥顶层 `param()` 的名字集合等于冻结清单 25 个（第十x轮起多一个 `ElRuntimeId`，见 D105）；②`cmdInject` / `cmdScreen` / `cmdUia` / `cmdInvoke` / `cmdPoint` / `cmdSnapshot` 的函数体里必须出现各自该下发的键（`Hwnd` / `Text` / `Keys` / `X` / `Y` / `Shot` / `ElId` / `SetValue` …），且每个键都在①里；③`invoke` 的身份闸门必须在桥侧、且在**动手路径的任何动作原语之前**（源文本守卫只钉"接线 + 位置"；口径**不是**"文件里第一个 `TryGetCurrentPattern` 之前"—— 快照期 `Get-PatternNames` 就已经只读枚举过 pattern，那是清点不是动作。判定本身在 `scripts/identity.ps1`，真桥与 `test/fixtures/invoke-identity-bridge.ps1` dot-source **同一份**，所以"把判定改坏"红的是**会执行**的用例，见 D108） | I10c / I6f | [机检] |
| D93 | 键盘类命令缺 `--hwnd` ⇒ 用法错（键只发给前台窗口，不指名就可能打进别的窗口） | `type --text ABC --dry-run` / `key --keys ctrl+s --dry-run` 都退出码 2、stderr 含"必须显式指名收键窗口"与"`--hwnd`"、stdout 为空；给了 `--hwnd 0x123456` 则退出码 0 且 `PLAN_FOCUS_SOURCE=hwnd` / `PLAN_HWND=0x123456` / `TARGET_SOURCE=--hwnd` | I7i | [机检] |
| D94 | 内容探针作用域是加法的（不许 if/else 互斥） | `captureState` 同时下发 `Hwnd`+`X`+`Y`（静态断言，且源码不许再出现 `else if (args.x !== undefined`）；运行时 `verify --x … --y …` 打 `CONTENT_SOURCE=point+hwnd`（修前只会是 `hwnd`）；`snapshot` 的 `SNAPSHOT_SOURCE` 在三种参数组合下分别是 `point+hwnd` / `hwnd` / `point` | I7h | [机检] |
| D95 | dry-run 回显"参数到底有没有传下去" | `type` / `key` 的 `--dry-run` 必须打出 `PLAN_FOCUS_SOURCE=` 与 `PLAN_HWND=`（这是唯一不用发事件就能取到的"CLI 有没有把 `--hwnd` 交给桥"的判据） | I10c | [机检] |
| D96 | 组合键里没有 `KEYEVENTF_UNICODE` | 7 组组合键（`ctrl+a` / `ctrl+s` / `ctrl+c` / `ctrl+v` / `ctrl+z` / `alt+f` / `ctrl+shift+a`）的 `--dry-run`：每行 `PLAN_KEY` 都不含 `FLAGS=4`，载荷是 `VK=65`（不是 `SCAN=97`），修饰键在前且 `SCAN=0`，`EXPECTED_EVENTS == PLAN_KEY 行数`（每个描述符只对应**一个**事件 —— 顺序另见 D100）；`key --keys a` 仍 `PATH=unicode SCAN=97 FLAGS=4`（无修饰键的单字符保留字符直送）；`key --keys A` 的 `SCAN=65`（大小写不许被吃掉）；`shift+a` 是 `[0x10, 0x41]` | I7j | [机检] |
| D97 | `PLAN_KEY` 是"这个键走哪条路"的唯一内存判据 | `key` 的 `--dry-run` 必须逐键打 `PLAN_KEY <i> \| <name> \| PHASE= \| PATH= \| VK= \| SCAN= \| FLAGS=`（`PHASE=` 是唯一能区分**发射顺序**的列，见 D100）；`PATH=char-as-vk`/`named`/`modifier` + `FLAGS=0` 是虚拟键、`PATH=unicode` + `FLAGS=4` 是字符直送；真跑时这行不出现（I7d：真跑不打计划） | I7k | [机检] |
| D98 | 未知键名 fail-closed | `key --keys nosuchkey --hwnd 0x123456 --dry-run` ⇒ 退出码 **1**（`ERROR=bridge 报错：unknown key name: 'nosuchkey'; …`，完整原文见 `design.md` I7j）、stdout 里没有 `PLAN_KEY`；**不许**静默变成一个 `wScan=0` 的空事件 | I7j | [机检] |
| D99 | 输出行契约表 ↔ 打印点机检 | 契约表里每个键都真的出现在该命令的打印点，代码里打的每个键也都在表里登记过。**实现口径（照抄 `test/contract-table.test.mjs`，别凭印象描述）**：键名只认**反引号包住的 `KEY=` 形状**（`KEY_TOKEN = /`([A-Z][A-Z0-9_]*)=/g`，取到的是去掉结尾 `=` 的键名 —— `SCREEN=<W>x<H>` 这种"键名后面跟说明"的写法**同样算登记**，因为正则认到第一个 `=` 就停、不解析 `=` 之后的内容，**没有**别的归一化）；键名单元格里不许出现没被反引号包住的裸键名（`/[A-Z][A-Z0-9_]{2,}=/`）；不许用 `CANONICAL_*_BYTES_HEX=` 这类 `*` 通配；`verify` 行的键名单元格里不许有它自己声明"不打"的 `PIXEL_HASH` / `VERDICT` / `DETAIL` / `IGNORED`（混进去会让按单元格切分的核对把这几个键读成 `verify` 打印的）。`OFFSET_` 一族走 D101 | 输出行契约 / 红线 18 | [机检] `test/contract-table.test.mjs` |
| D100 | 组合键的**发射顺序**（判据只能是 `PHASE=`） | `key --keys ctrl+a --hwnd 0x123456 --dry-run` 的逐键 `PHASE` 序列必须是 `modifier-down` → `key-down` → `key-up` → `modifier-up`；`ctrl+shift+a` ⇒ `modifier-down`×2 → `key-down` → `key-up` → `modifier-up`×2，且**抬起是按下顺序的逆序**（`ctrl` 先按、最后抬）；`shift+a` 同型；`key a` / `key A` / `f5`（无修饰键）退化为 `key-down` → `key-up`（行为不变）。**事件数看不出顺序**：真机旧实现把 `ctrl+a` 发成"ctrl↓ ctrl↑ a↓ a↑"，而 `EXPECTED_EVENTS=4 INSERTED_EVENTS=4 EVENTS_MATCH_PLAN=true` 一切正常、靶侧只多一个小写 `a` ⇒ 只有 `PHASE=` 能在内存里判它 | I7l / 红线 20 | [机检] `test/key-chord.test.mjs` |
| D101 | 动态键名模板（`OFFSET_` 一族）不是核对盲区 | `test/contract-table.test.mjs` 从 `cli.mjs` 抽 `print(\`OFFSET_${name.toUpperCase()}=\`)` 这类模板（**跳过被 `//` 注释掉的行**）、按桥侧 `offsets` 引用的 12 个 `InputLayout` 字段展开，再参与"表 ↔ 打印点"两个方向的核对：`templates.length === 1`、`OFFSET_FIELDS.length === 12`、展开出来的键集合与字段名逐值相等、未登记的模板前缀要报 problem。本次反证：把 `cli.mjs` 那一行注释掉 ⇒ `ℹ tests 5 / pass 3 / fail 2`（`exit 1`），断言原文是"`probe` 表里有、打印点没有：OFFSET_TYPE … OFFSET_KEYEXTRAINFO"与"`cli.mjs` 里应恰好有 1 个动态键名模板，实际 0" | 输出行契约 / 红线 18 | [机检] |
| D102 | 组合键里不可映射的字符 fail-closed（**运行时**用例） | `key --keys ctrl+☃ --hwnd 0x123456 --dry-run` ⇒ 退出码 **1**、`ERROR=bridge 报错：this character cannot be sent as part of a chord on the active keyboard layout: '☃'; spell the key out (for example 'ctrl+a'), or send the text with --text`、stdout 里没有 `PLAN_KEY`（`VkKeyScan` 返回 `-1` ⇒ `Fail`）；另有一条**静态**守卫钉住这个分支（`Get-CharVirtualKey` 里 `-1` 必须 `Fail`）。若某键盘布局真能映射该字符，用例退化为断言 `VK>0` 且 `FLAGS=0` —— **不许**悄悄退回 `KEYEVENTF_UNICODE` | I7j | [机检] |
| D103 | `$named` 命名键表 ↔ 报错文案同步（**静态**用例，不发事件） | 从 `bridge.ps1` 的 `$named` 表与那句 `one of: …` 里各取一份清单，逐键核对"字面列出 / 同 VK 的别名 / 落在 `f1-f12` 区间"，给 `$named` 加一个命名键却忘了改报错文案就红 | I7j | [机检] |
| D104 | 显式 `--target-hwnd` 的**注入前**落点闸门（三态 + `--force`） | 给了 `--target-hwnd` 时，注入前先打 `LANDING_PREFLIGHT=true|false|unknown`：**`false` ⇒ 默认不发事件**（`UsageError` + 退出码 2，stdout 里**没有** `INSERTED_EVENTS=`、没有 `UIPI_DECISION=` 与计划行），stderr 文案含「落点像素上的窗口不是目标窗口（期望 0x…，实际 0x…）」与「加 --force」；加 `--force` ⇒ 退出码 0 + 同一段文字变 `WARN=`；`unknown` ⇒ 只 `WARN=`（与几何闸门对 `unknown` 的口径一致，不 fail-closed）；`true` ⇒ 放行。**未给** `--target-hwnd` 时行为不变：不打这一行，`LANDING_IN_TARGET` 仍 `unknown`（`--dry-run` 仍 `not-evaluated`）。本会话（受限）实测：`click --x 1280 --y 800 --dry-run --no-pixel --target-hwnd 0xdead` ⇒ `LANDING_PREFLIGHT=false` + `EXIT=2`（落点实测 `0x50086/0x50086`）；同命令加 `--force` ⇒ `EXIT=0` 且 `LANDING_IN_TARGET=not-evaluated` 保持不变；`--target-hwnd 0x50086`（真的落点窗口）⇒ `LANDING_PREFLIGHT=true` + `EXIT=0`；`move` / `scroll` 走**同一道**闸门（规则只有一套）。**真机面未观测**：完全权限会话里 `--target-hwnd` 指隔壁窗口 ⇒ 期望默认拒发且靶侧零事件；指真靶 ⇒ 放行 | I7g / 红线 15 | [机检] `test/pure.test.mjs`（`landingPreflight` 真值表）+ `test/cli-contract.test.mjs` |
| D105 | `el_unknown` 不许在未限定窗口时当 `--id` 动手（它是折叠 id，不是身份） | `isElementId('el_unknown') === true` 与 `PLACEHOLDER_ELEMENT_ID` **都不变**（形状闸门与 `uia` / `point` 的输出照旧 —— 藏起来就等于说"元素不存在"，触犯红线 11）；`invoke --id el_unknown`（**不给** `--hwnd`）⇒ 退出码 **2**、stdout 为空、stderr `/^ERROR=/` 且同时含「el_unknown」「不唯一」「--hwnd」「限定窗口」、**不含**"元素可能已消失"这类结论；给了 `--hwnd 0x1234` ⇒ 放行走到身份那一步（假桥实测：`ID_IDENTITY=absent` + `WARN=这次没有身份复核` + 退出码 0） | I6e / 红线 21 | [机检] `test/pure.test.mjs` + `test/cli-contract.test.mjs` + `test/element-identity.test.mjs` |
| D106 | 元素身份随 `invoke` 下发，不一致 ⇒ **一步都不动** + 退出码 2 | 假桥（`test/fixtures/invoke-identity-bridge.ps1`，经 `ADG_DESKTOP_BRIDGE` 顶替真桥，**不碰真机**）把"定位快照"与"第二遍遍历"的 runtimeId 设成两个值：`ELEMENT_RUNTIME_ID=<快照值>`（原样下发）、`ID_IDENTITY=mismatch`、`OK=false`、退出码 **2**、stderr `/^ERROR=invoke 拒绝动手：元素身份复核不一致/`、`WARN=元素身份不一致` 里含**实际** runtimeId、且**不含**"语义操作没有真正生效"（那是退出码 1 的措辞）；一致时 ⇒ `ID_IDENTITY=checked` + `OK=true` + `PATTERN_USED=InvokePattern` + 退出码 0；另加源文本守卫：闸门接线在 `Do-InvokeChosen` 里、在**动手路径的任何动作原语之前**（`.SetValue(` / `.Invoke()` / `.Toggle()` / `.Select()` / `.Expand()` / `.Collapse()`；口径**不是**"文件里第一个 `TryGetCurrentPattern` 之前"—— 快照期 `Get-PatternNames` 已只读枚举过），且**拒绝块**的三段位置（`if ($null -ne $identityGate) {` / `Write-Report $identityGate` / 紧随的 `return`）都早于**第一个**动作原语 —— 只钉"调用点在动作之前"是不够的：把拒绝块挪到 `Do-InvokeChosen` 末尾时，判定只"检出"不"拦住"，那些断言照样全绿（G1 补的正是这一条），而且这一块必须**连续成段**（`if` / `Write-Report` / `return` 三行之间只许空白 —— 否则"删掉块内 `return`"、"只搬走 `Write-Report`"这两种改法会让三针同时落空），文案是 `element identity mismatch: id matched but runtimeId differs`。**H1 起再加两条最低文本条件**：拒绝块的紧邻上一条非空源码行必须就是闸门调用语句，且闸门调用与拒绝块之间不许出现 `if (` / `while (` / `foreach (` / `switch (` / `<#` 或行首 `#` 的注释行（那三行还必须独立成行、行文本精确相等）。**这些断言保证的是源码文本层面的位置关系，不保证这段文本会执行** —— 把闸门调用与拒绝块**一起**包进恒假 `if ($false) { … }`（文本一字未动）时两个文件仍然全绿（M6），把这一整段套进 `& { … }` 这类**子作用域**时更糟（M7：块里的 `return` 不退 `Do-InvokeChosen`，桥先报 `invoked=false` / `identityMismatch=true`、**再**继续动手）；**这两张清单（D106 / D108）列的都是已实测形状，非穷举** —— 不可达性与作用域语义的其它变体仍可能存在，细节与读数见 D108。**判定本身在 `scripts/identity.ps1`**（唯一实现，真桥与假桥 dot-source 同一份，见 D108） | I6f / 红线 22 | [机检] `test/element-identity.test.mjs` + `test/params-map.test.mjs` |
| D107 | 不给身份 ⇒ 行为与今天一致（老调用方式回归） | 快照里 runtimeId 为空（`GetRuntimeId()` 读不到的形状）⇒ `ELEMENT_RUNTIME_ID=` 空（**不凭空造**）、`ID_IDENTITY=absent`、`WARN=这次没有身份复核`、`OK=true`、退出码 **0** —— **即使两次遍历报的元素不同也不许拒绝**（没有身份就没有"不一致"可判）；`--no-pixel --no-content` 下 `CHANGED=unknown`（红线 1 的三态，不许报 `false`） | I6f（缺省路径）/ 红线 1 | [机检] `test/element-identity.test.mjs` |
| D108 | 元素身份判定的**唯一实现**只此一份，且被**会执行**的路径覆盖（F1） | 判定不许在 `bridge.ps1` 里内联重写：真桥 `. (Join-Path $PSScriptRoot 'identity.ps1')`、假桥 `. (Join-Path $PSScriptRoot '..\..\scripts\identity.ps1')`，dot-source 的是**同一个** `scripts/identity.ps1` 的 `Get-ElementIdentityGate`；该文件是 ASCII-only / 无 BOM / LF（Buffer 级：首字节 ≠ `0xEF`、不含 `0x0D`、无 >127 字节），且只有**两条**"不拦人"的出口（`return $null` 计数 === 2：没给身份、身份一致 —— 多一条就意味着有人加了别的放行条件）；假桥里不许留下任何平行重写（`$ElRuntimeId -ne ''` 必须不出现）。**反证（在临时副本上实跑，本会话已跑，见交付报告）**：把"身份一致 ⇒ 不拦"改成永真 ⇒ 红的是**会执行**的「身份不一致」用例（断言文本是它对 `ID_IDENTITY=mismatch` 的期待，不是文本守卫）；把"没给身份 ⇒ 不拦"改成永假 ⇒ 红的是 `absent` 那两条用例。**诚实边界**：假桥不读 `bridge.ps1`，「接线」本身只能由**静态**守卫覆盖 —— 下面三种变异红的都是它们（三种都实跑过：各 `15 tests / 13 pass / 2 fail`、退出码 1，红的就是这两条静态守卫）（`test/element-identity.test.mjs` 与 `test/params-map.test.mjs`）：①删掉闸门**调用点**；②**调用点留在原处、只把拒绝块挪到 `Do-InvokeChosen` 末尾**（判定照样"检出"，但不再"拦住"，而旧的"在 gate 之后"式断言全绿 —— 这是 G1 补掉的缺口：现在拒绝块的三段位置 `if ($null -ne $identityGate) {` / `Write-Report $identityGate` / 紧随的 `return` 都必须早于**第一个**动作原语，且每条断言都先要求 needle 存在，免得 `indexOf` 的 `-1` 把"缺失"读成"合格"）。另：只钉"三段各自在动作之前"还有一道缝 —— 删掉块内 `return`、或只把 `Write-Report $identityGate` 搬走时那三针仍成立（`return` 针取的是拒绝块之后的下一个 `return`，而 ValuePattern 失败分支里就有一个），所以守卫另用一条正则要求这一块**连续成段**。那两条守卫是必要的，但不能声称它们证明了运行期行为。**H1（第 3 轮复核的 M6）**：这些 needle 对**未剥注释的源码原文**做 `indexOf` / 正则 ⇒ 只要那段文本还在（哪怕不可达、哪怕在注释里）断言就满足；复核实测把拒绝块整块套进恒假 `if ($false) { … }`（三行字面量与连续性一字未动）时两个文件 `15 pass / 0 fail`。现在补的最低文本条件是：拒绝块的紧邻上一条非空源码行必须就是闸门调用语句、调用与拒绝块之间不许有 `if (` / `while (` / `foreach (` / `switch (` / `<#` / 行首 `#`、三行必须独立成行且行文本精确相等。本会话在临时副本上实跑的 8 个变体（各跑 `node --test --test-isolation=none test/element-identity.test.mjs test/params-map.test.mjs`，未变异对照 `15 / 15 / 0`、退出码 0）：①M6 原形（整块套 `if ($false) {`）⇒ `15 / 13 / 2`、退出码 1，红在**新加的紧邻行断言**（`element-identity.test.mjs` / `params-map.test.mjs`：`拒绝块的紧邻上一条非空源码行必须就是闸门调用语句 —— 中间夹一层恒假 if 或夹一句注释，这块就不会执行了`）；②`<# … #>` 包住 ⇒ 同上（同一断言）；③三行前各加行首 `# ` ⇒ `15 / 13 / 2`，红在**连续成段**断言（两个文件里指向同一条断言的读法）；④**把闸门调用语句与拒绝块一起**套进 `if ($false) {` ⇒ **`15 / 15 / 0`、全绿 —— 挡不住**（紧邻行仍是调用语句、行文本与位置都没变）—— 所以"不可达性"这一类（一起包进恒假分支、更早处的 `return`/`throw`/`exit`、`Do-InvokeChosen` 不再被调用）静态文本守卫判不出来，**不许把这两条守卫说成"证明会执行"**；⑤原有三种（整块后置 / 删块内 `return` / 只搬走 `Write-Report`）复跑仍各 `15 / 13 / 2`、退出码 1，红的仍是原来那几条断言（新断言没把它们挤走）；⑥**M7（第 4 轮复验方自设，比 ④ 更糟）**：把"闸门调用语句 + 拒绝块"**整段套进 `& { … }`** ⇒ 块里的 `return` 只退出脚本块、**不退 `Do-InvokeChosen`**，桥**先报** `invoked=false` / `identityMismatch=true`、**然后继续把动作做了**，而两个测试文件 `15 / 15 / 0` 全绿（复验方在 WinPS 5.1 上的最小 harness：未变异 ⇒ 只报报告、无动作行；`if ($false)` 包裹 ⇒ 无报告、有动作行；`& { }` 包裹 ⇒ 报告**与**动作行都有）。**以上为已实测形状，非穷举** —— 不可达性与作用域语义的其它变体（本静态层与假桥层都覆盖不到）仍可能存在，**不许把这两条守卫读成"证明会执行"** | I6f（判定同源）/ F1 | [机检] `test/element-identity.test.mjs` + `test/params-map.test.mjs` |
| D109 | 测试环境卫生：`runCli` 默认**不继承**外部的 `ADG_DESKTOP_BRIDGE`（F5） | `test/helpers.mjs` 的 `childEnv(opts)` 先**大小写不敏感地**剔掉继承来的 `ADG_DESKTOP_BRIDGE`（按 `key.toLowerCase()` 比 —— **只 `delete` 精确大小写是不够的**：`process.env.adg_desktop_bridge='…'` 仍会漏进子进程，而 `lib/env.mjs` 的 `envGet` 是大小写不敏感比对的、CLI 会认；验收方探针实测 `survivors=['adg_desktop_bridge']`）、再叠加 `opts.env`（**显式注入照旧生效** —— 身份用例就是靠它把 CLI 顶到假桥上的）。用例**执行**该函数（不是文本断言）：临时把 `process.env.ADG_DESKTOP_BRIDGE` 设成毒值 ⇒ `childEnv()` 里没有它；再用**变体大小写**（`process.env.adg_desktop_bridge`）注入一次 ⇒ 展开结果里**任何大小写变体都不存在**、且只少了这一把钥匙（不误删 `SystemRoot` / `Path`）；`childEnv({env:{ADG_DESKTOP_BRIDGE:<fixture>}})` 里有它；`finally` 里恢复。选"默认剔除"而不是"跑测试前断言环境干净"的理由：后者要求每个调用方与 CI 都记得清环境，前者把缝隙收在唯一入口里。来源：验收时真发生过一次 —— shell 里导出过该变量，一条只读 `uia` 落到真桥（`SNAPSHOT_COUNT=45 FOUND=false`、退出码 2，停在定位阶段、无副作用） | 测试缝隙卫生 / I6f | [机检] `test/element-identity.test.mjs` |

## 迁移矩阵
### ScreenBox / 坐标
| 起始状态 | `toAbsolute`（屏内点） | `toAbsolute`（屏外点） | `insideScreen` |
|---|---|---|---|
| 单屏 `origin 0,0` | 落在 0..65535 | `clamped=true`，值被夹到边界 | 屏外给 false |
| 负原点虚拟屏 | 先减原点，仍落在 0..65535 | 同上 | 屏外给 false |
| 虚拟屏尺寸为 0 / 缺字段 | 不参与换算（返回 `undefined`），不抛"除零"错 | 同左 | false |
### InjectionPlan / 闸门
| 起始状态 | `--dry-run` | 目标 IL ≤ 自身 | 目标 IL > 自身 | 目标 IL = unknown | `--force` |
|---|---|---|---|---|---|
| 未注入 | `skip-dry-run`，只打印坐标 | `can-inject` → 发事件 | `block-uipi-higher` → **不发** | `block-integrity-unknown` → **不发** | `forced` → 发，并打 `WARN=` |
| 已注入一次 | 同左（干跑不改状态） | 同上 | 同上 | 同上 | 同上 |
| 目标窗口已消失 | `skip-dry-run` | 报错（拿不到目标） | 报错 | 报错 | 报错 |
### ElementSnapshot / 语义动作
| 起始状态 | `invoke --id`（有 `InvokePattern`） | 有 `ValuePattern` + `--set-value` | 无任何 pattern | 无 `ValuePattern` 但给 `--set-value` |
|---|---|---|---|---|
| 元素在快照里 | `PATTERN=InvokePattern`、`OK=true` | `PATTERN_USED=ValuePattern`、`VALUE_BEFORE`/`VALUE_AFTER` 都给 | `WARN=` + 退出码 2 | `WARN=` + 退出码 2 |
| 元素不在快照里（层级被 `--depth` 截断 / 换了作用域 / 已消失） | `FOUND=false` + `WARN=`，不猜；**`SNAPSHOT_TRUNCATED=true` 时说的是截断**（叫人加 `--hwnd` 后用同一作用域重新取 id），不许说"元素可能已消失" | 同左 | 同左 | 同左 |
| 给了 `--fallback-point` 且无 pattern | 不退化成坐标点击这条路（有 pattern 就走语义） | — | 退化成坐标点击，`FALLBACK_POINT=` + `WARN=`（明说"这不是语义操作"） | 比照左格 |
### VerifyState / 复核
| 起始状态 | 注入类命令（默认自动复核） | `verify` 单跑 | `--dry-run` |
|---|---|---|---|
| 有"前"可比、且判据覆盖得到 | `CHANGED=true`（有差异）或 `false`（无差异但抓到了像素 / 读到过 UIA 内容） | 不适用 | `CHANGED=false` + `WARN=`（没发事件） |
| 有"前"可比、但判据全覆盖不到 | `CHANGED=unknown` + `VERDICT.reason`（"没看到差异 ≠ 动作没生效"） | 不适用 | 同左 |
| 无"前"可比 | 不适用 | `CHANGED=false` + `WARN=`（单次快照） | 同左 |
| 复核拿不到像素（`--no-pixel`） | 还剩窗口 / 前台 / 落点 / UIA 内容四类判据（**落点只作独立归属断言、不进差异集合**） | `PIXEL_HASH=` 不出现、`CONTENT_HASH=` 仍在 | 同左 |
| 内容探针子进程崩了 | `CHANGED=unknown` + `CONTENT_PROBE=failed`，`reasons` 里**不含**"UI 内容"（缺测不是"界面变了"，也不是"界面没变"） | 同左（`CONTENT_HASH=` 为空串） | 同左 |
| 这条命令需要的那一类读数两端都为 0 | `CHANGED=unknown` + `CONTENT_KINDS=…`（**像素读到也不报 `false`**：像素看不见"列表滚了"） | 同左 | 同左 |
| 几何读数互相矛盾（`GEO_MISMATCH=true`） | 不进复核：**注入前**退出码 2（要硬发得显式 `--force`） | 不适用（`verify` 不注入） | `--force` 不在时同样在注入前停 |
| 内容探针的作用域被换掉（前后两次 `CONTENT_SOURCE=` 不是同一个值） | 读到的类目会静默变少（`CONTENT_KINDS` 里 `scroll` / `ancestorScroll` 结构性归 0）⇒ 该报 `unknown`（I7h）；作用域本身由 `CONTENT_SOURCE=foreground|hwnd|point|point+hwnd` 摆在明面上 | 同左 | 不适用（dry-run 不取前后态） |
### 内容判据矩阵（按命令 × 按读数类别）
`CHANGED=false` 有没有资格被读成"没变"，取决于**这条命令需要的那一类读数**这次到底读到了没有（`INJECTION_CRITERIA` / I7f）。本表只写"哪一类读数决定哪条命令的结论"；**具体哪些控件类型暴露哪些 pattern 属未观测**（受限会话里跨完整性级别读被拒，读不到任何 pattern），量法见「人工 review 项」。
| 命令 | 需要哪几类读数 | 读到的实际来源 | 一类都读不到时 |
|---|---|---|---|
| `click` | 不需要专属类别（像素 / 窗口集合 / 前台 / 落点已够；内容类读到就一起比） | 目标区域像素哈希；内容属性（有则一起） | 仍可给 `true` / `false`（像素撑着）；像素也关掉才 `unknown` |
| `type` | `value` | 完全权限会话里 WinForms 文本框的 `ValuePattern`（真机 `--set-value` 10/50/200/800/2590 逐个对上） | `CHANGED=unknown`（**不是 `false`**） |
| `key` | `value` / `selected` / `toggle` / `scroll` / `rangeValue` | 同上（文本框的 `value`） | `CHANGED=unknown` |
| `scroll` | `scroll`（光标下元素自己的，或它 3 层内祖先里带 `ScrollPattern` 的；桥侧把祖先那些也计进 `scroll` 类，`ancestorScroll` 是子集标记） | 真机独立读数 `GetScrollInfo(SB_VERT)` 证明滚了（`nPos 0→15→30`），而**文本类读数看不见** —— 这正是它曾经恒报 `false` 的原因 | `CHANGED=unknown`（滚动不改文本，报 `false` 就是说谎） |
| `move` | 不适用（它不改内容） | `GetCursorPos` 硬件级回读 ⇒ `CURSOR_LANDED` | `CHANGED=false` 不许读成"移动失败"（看 `CURSOR_LANDED`） |

**这一节的读数有个前提**：`CONTENT_KINDS` 里各类的计数取决于这次快照**实际用了哪个作用域**（I7h）。`--hwnd` 钉根、`--x/--y` 加读落点与 3 层祖先 —— 两个都给才拿得到 `point` 与 `ancestorScroll` 那几类；只看 `CONTENT_BEARING_COUNT` 总数会把"根上有别的读数"误读成"这一类读到了"。

## 消费方契约测试
本模块的消费方是 `skills/adg-computer-use/SKILL.md`、`README.md` 的「子代理与能力带」一节、`install.ps1` / `install.sh`（安装落点）与 `browser/`（分界）—— **它们各自消费什么、边界怎么划，见 `desktop/design.md` 的「被依赖」与「跨模块改动路由」两节，本文不复述**。这里只写怎么验证它们对契约的理解没漂移。

过期检测：
```sh
node desktop/cli.mjs help                                                              # 契约真相源
Select-String -Path skills\adg-computer-use\SKILL.md -Pattern 'cli\.mjs' -Encoding UTF8        # 技能提到的每条命令
Select-String -Path README.md -Pattern 'desktop/cli\.mjs|desktop/` 工具链' -Encoding UTF8
```

判据（D60）：技能 / README 里出现的命令名与选项都能在 `help` 的输出里找到同名项 —— 出现「文本让**子代理**跑 A，而 `help` 里没有 A」即失败；改动目录名或落点时 `install.ps1` / `install.sh` 的源与落点必须**同时**改到（只改一处会拷不到东西或拷到旧路径），`install.ps1` 改完还要复核 UTF-8 BOM 前三个字节是 `EF BB BF`（根 `AGENTS.md` 红线 8）；「在网页里点某个元素」的指示必须指向 `browser/`，指向本模块的只能是「点本机某个窗口里的按钮」（本模块看不见 DOM）。

## 已知平台坑
### UIA 的 range 文本方法能抛 AV，而且 `try/catch` 抓不住（I7e）

| 现象（什么坏了） | 证据（栈 / 读数 / 反例） | 处置与判据 |
|---|---|---|
| `bridge.ps1` 里读文本选区那一行让**整条命令**在取前态时就死，Node 侧只看到 `ERROR=bridge 没写出结果文件（exit=3221225477）` | 真机栈是 `System.AccessViolationException` at `MS.Internal.Automation.UiaCoreApi.RawTextRange_GetText(...)` → `TextPatternRange.GetText(Int32)`。`probe` / `windows` / `point` / `uia` / `--dry-run` 不受影响（它们不走内容快照）—— 所以症状看起来像"注入路径坏了"，其实是读数把进程打死了 | 类型：corrupted-state 异常（`0xC0000005 = STATUS_ACCESS_VIOLATION = 3221225477`）。**PowerShell 的 `try{}catch{}` 抓不住**：参数求值时就炸掉整个进程，`catch` 一行都不执行 —— "就地加 `try/catch`"**不是**修法 |
| 触发条件：`TextPattern.GetSelection()[0].GetText(-1)` | **任何暴露 `TextPattern` 的 WinForms 文本框都中，空的（`len=0`）也中**，与"到底有没有选中文字"无关 | 反例（不是"读文本就一定崩"）：同一元素上 `DocumentRange.GetText(-1)` 正常返回（实测 `DOC_OK len=409`），全桌面 1130 个 `TextPattern` 元素逐个 `DocumentRange.GetText(200)` 全部跑完 ⇒ 差别在 selection 这条路径本身，**"换成正的 `maxLength`"不成立** |
| 15 行最小复现（另起进程即现，与 CLI 无关） | 建一个 `TextBox` + `Select(0,5)` → 取 `TextPattern` → 调 `$tp.GetSelection()[0].GetText(-1)` → 与上面一字不差的栈 | 判据：D77 / D78 / D79 / D80 / D81（全是 `[机检]`）。量法＝照「最小复现」另起进程跑一遍，期望复现同一栈 |
| 处置：文本选区这条读数**整个删掉**（`ValuePattern` 的 `value` 已经覆盖"盒子里的内容变了"） | `Read-ElementContent` 只许 `TryGetCurrentPattern` 取 pattern + 读 `Current.*` 属性（源码里有 ASCII 的 POLICY 注释锁住） | 整条内容探针搬进独立子进程 `snapshot`（I7e）：一次崩溃只损失这一次读数、记 `unknown`，不拖垮注入 |

## 人工 review 项
每条都给量法；**未观测的结论不许写成实测**。
| 症状 / 主题 | 判据（已观测 / 未观测） | 量法 |
|---|---|---|
| UIA pattern 的可得性随会话令牌而变 | **已观测（两个方向都有读数）**：本机 `workspace-write`（Low 完整性级别）会话里全屏 `uia --depth 8`（上限 900，实收 53 个元素）的 `patterns` 全是空的，`InvokePattern` / `ValuePattern` / `TogglePattern` / `SelectionItemPattern` / `ExpandCollapsePattern` / `TextPattern` 计数全为 0；另写了一个**同进程**探针（WinForms `Form` + `Button`）也取不到 `InvokePattern`，且那个按钮被报成 `ControlType=Pane` 而不是 `Button`。**而在完全权限会话里同一台机器上**，一次只读的 `uia --depth 6` 拿到 `COUNT=131 SHOWN=131`、其中带 pattern 的 `Pattern` 行 **60 条**（例：`EL el_b1681620 Button InvokePattern,ScrollItemPattern -30294,-31099,24,24 VerticalSmallIncrease 垂直小幅增长`）。⇒ 结论：**pattern 有没有取决于"这次调用"的令牌与目标进程的 UIA provider**，不是选择器写错，也不能当成"本机 UIA 不可用"。**未观测**：这两组读数之间的完整边界（哪些进程在哪种令牌下可读）没有量过。 | 量法：在完全权限与受限两种会话里对同一批窗口跑同一条 `uia --depth 6`，逐元素比对 `patterns` 的差集。 |
| 多显示器 | **未观测**：本机只有一块屏（`profile` 的 `MONITORS=1`、虚拟屏原点 `0,0`），负原点与各屏不同 DPI 只有单测的假数据覆盖（D6）。 | 量法：接第二块屏（或把主屏换成右侧），跑 `profile` 看 `VIRTUAL_ORIGIN` / `VIRTUAL_SIZE` / `MONITORS` 是否随之变化，再 `point --x <副屏上一点的物理坐标>` 看 `HWND` 与 `screen` 的 `ORIGIN` 是否自洽。 |
| 真实第三方应用的端到端点击 | **未观测（本会话）**：本会话只跑了 `--dry-run` 与不注入的命令，真实点击/键盘验收由完全权限的会话执行。已知的覆盖面边界（来自那一路的实测记载，非本会话验证）：Notepad3 的 5 个子元素全是 `ControlType=Pane` 且**无任何 pattern**（该应用没实现 UIA provider）⇒ 语义路线不可用；File Explorer（`CabinetWClass`）能枚举 172 个后代，但有元素 `SetValue` 被拒、异常原文 `值为只读。`。 | 量法：在完全权限会话里对同一批窗口跑 `uia --depth 6` 并统计各类 pattern 的计数，再选一个实现了 provider 的应用跑 `invoke --id --set-value`，期望 `VALUE_AFTER` 与写入值一致。 |
| 被遮挡时的 `--raise` 是否总能救回来 | **未观测**：`RAISED=true` 只证明 `SetWindowPos` 返回成功，不证明窗口真的可见（置顶队列里还有别的 topmost 窗口时仍可能被盖住）。 | 量法：故意用一个 topmost 窗口盖住目标，跑带 `--raise` 的 `click`，对比 `CURSOR_LANDED` 与 `CHANGED`；必要时再截一张 `screen` 人眼确认。 |
| UWP / 沙箱化应用（含 Chrome 系浏览器自身） | **未观测（注入行为）**；完整性**读数的口径已明确**：早期受限会话里 brave 的三个窗口读回 `unknown`（`OpenProcess` 对它返回 `ERROR_ACCESS_DENIED`），返工复测时**同机同进程**读回 `medium` ⇒ 这个字段是"**这次调用**读不到"，不是"这个进程读不到"（见 `design.md` 的 I5）。这类进程的**注入**行为没有量过。 | 量法：在受限与完全权限两种会话里各对浏览器窗口跑一次 `click`，记录 `UIPI_DECISION` 与 `CHANGED`，并各跑一次 `windows` 对比同一 PID 的 `integrity`。 |
| 高 DPI 混合缩放（150% 与 100% 屏共存） | **未观测**：本机是单屏 150%。 | 量法：接一块 100% 缩放的屏，`profile` 看 `DPI_AWARE=PER_MONITOR_AWARE_V2` 与 `SCREEN` 是否仍等于物理像素，并在两块屏上各 `point` 一次核对坐标没被虚拟化。 |
| `install.sh` 的语法 | **未观测**：本机没有可用的 `sh`／`wsl`（都被沙箱挡），新增段只核了 LF 行尾与照抄既有段的缩进/引号风格。 | 量法：在 macOS / Linux 或 WSL 里跑 `sh -n install.sh`（语法）+ 一次真实安装，再用部署后的副本跑 `node cli.mjs profile`。 |
| 子代理是否真的照技能与委派 prompt 用这套工具 | **未观测**：没有真实 Adg 会话走过。 | 量法：转写里检索 `desktop/cli.mjs` 调用；出现"声称点了按钮但没有任何 `CHANGED=` / `CURSOR_LANDED=` 证据"即技能与委派 prompt 未被遵守。 |
| `invoke --set-value` 的 `ValuePattern` 路径与 `scroll` 的 `WHEEL_DW_DATA` | **未观测（真机）**：静态实现与单测都在（`chooseAction` 选 `ValuePattern`、负数按位重解释进 `mouseData`），但"真的写进去了 / 真的滚动了"没有量过。 | 量法：在一个实现了 provider 的应用里 `uia --id <el_id> --set-value <v>`，读回 `VALUE_BEFORE` / `VALUE_AFTER` 并与期望值比对；`scroll` 则对一个能滚动的控件跑正负各一次，用 `screen` 前后像素哈希判 `CHANGED`。 |
| UIA `BoundingRectangle` 是否需要 DPI 折算 | **已观测（同一会话内）**：`uia --id <窗口根元素>` 的 `ELEMENT_RECT` 与 `windows` 里同一窗口的 `left,top,width,height` **逐值相等**（在同一次调用里比对过），所以"代码不折算"在本机 150% 单屏下不产生偏差。**未观测**：换成 100% 缩放屏、或多屏混合缩放下是否仍相等。 | 量法：接一块 100% 缩放的屏，对同一窗口重复上面这条逐值比对。 |
| "单 pattern 且可动作"的元素能否真的 `invoke` 成功 | **未观测（本会话受限）**：本会话只能覆盖**形状**（D61 / D69，证明单 pattern 不再被判空、两条路径同源），证明不了"语义操作真的生效"。受限会话实测 `uia --depth 10 --limit 20000` 只有 `COUNT=27`，**整棵树里 `Invoke` / `Value` / `SelectionItem` / `ExpandCollapse` / `Toggle` 计数全为 0**（同 I5 的令牌现象），所以本机找不到"单 pattern 且可动作"的真机样本；能观测到的只有容器类：`invoke --id el_f1b9c3f1 --dry-run` ⇒ `ELEMENT_PATTERNS=WindowPattern` + `WARN=该元素没有任何可用的语义 pattern（可用：WindowPattern）；它可能只是个容器。要改用坐标点击请显式加 --fallback-point` + 退出码 2（旧输出是「可用：-」，即单 pattern 被拆包后判空）。 | 量法：在完全权限会话里 `uia --depth 6` 找一个带 `InvokePattern` 的 `Button` 的 `el_…`，先 `invoke --id … --dry-run` 期望 `PATTERN=InvokePattern`，再去掉 `--dry-run` 真跑，用裸 `verify` 或靶侧计数独立复核。 |
| 内容类动作的自动判定在完全权限会话里是否够用 | **未观测**：受限令牌下 UIA 跨完整性级别读被拒（`contentNote` 原文 `point:Exception calling "FromPoint" with "1" argument(s): "Access is denied"`，`CONTENT_BEARING_COUNT=0`），所以内容类命令在本会话**只能**报 `CHANGED=unknown`；`true` 那一侧没量过。 | 量法：在完全权限会话里对一个 WinForms 文本框跑 `type`，期望 `CHANGED=true`、`CONTENT_BEARING_COUNT>0`，并与旧的像素/窗口判据并排看是否一致。**本轮修复的直接验收面仍未观测**：六条命令（`verify` / `move` / `click` / `type` / `key` / `invoke`）在完全权限会话里能否跑到"注入 + 打印结论"（修复前的症状是六条全部在取前态时 `exit=3221225477`）。量法：完全权限会话里逐条跑，期望**不再出现** `bridge 没写出结果文件（exit=3221225477）`，且每条都打出 `CONTENT_PROBE=` 与自己的结论行（`CHANGED=` / `CURSOR_LANDED=`）。 |
| `EVENTS_MATCH_PLAN` 在真机上是否真相等 | **未观测**：它只在真跑路径出现（dry-run 不许出现），而真跑属于注入验收。 | 量法：完全权限会话里逐条跑 7 条注入命令，期望 `EVENTS_MATCH_PLAN=true`；出现 `false` 说明"造事件"与"发事件"两条路又分叉了。 |
| `--double` 的靶侧语义（分两半） | **已观测**：真机 `click --double` 的靶侧计数**精确 +2**、`EVENTS_MATCH_PLAN=true` ⇒ "连发两次点击"这半句成立（文档与 `USAGE` 一律这么写）。**已观测（OS 层，真机三靶，来自完全权限会话的记载）**：类带 `CS_DBLCLKS` 时 OS 那层**确实投递** `WM_LBUTTONDBLCLK`（RAW1 自建窗口过程 `CSTYLE=0xB` ⇒ `DOWN / UP / DBLCLK / UP`；RAW2 `CSTYLE=0x3` 无该位 ⇒ `DOWN / UP / DOWN / UP` 无 DBLCLK），三例 CLI 侧都是 `EXIT=0 INSERTED_EVENTS=5 EVENTS_MATCH_PLAN=true CHANGED=true` —— **事件数完全看不出区别**。**仍未观测**：托管层 —— 靶窗口已注册的 `DoubleClick` 处理器**从未触发**（WinForms `BUTTON` `0x8B` 的窗口过程原始日志里**有** DBLCLK，托管事件只有 `CLICK n=1/n=2`、无 `DBLCLK_EVENT`，因为 `ControlStyles.StandardDoubleClick` 默认关）⇒ 不许把 `--double` 写成双击语义的保证。 | 量法：靶窗口挂 `DoubleClick` 事件写日志，按间隔 0 / 50 / 300 / 800 ms × 不同控件类型各跑一次 `click --double`，比对日志条数与 `EVENTS_MATCH_PLAN`。 **机制已查明（两半，来源分开写）**：Windows 只为**注册了 `CS_DBLCLKS` 的那个窗口类**产生 `WM_LBUTTONDBLCLK`（UIA 的 `DoubleClick` 同源），否则第二次 down 仍是普通 `WM_LBUTTONDOWN`。①**本会话只读实测（受限会话，只跑只读探针与 `--dry-run`，一个事件都没发）**：`DCLICK_TIME=500`、`DCLICK_RECT=4x4`；`--double` 的事件构成是 1 个 MOVE + 连续两次 down/up（同坐标、相邻约 1 ms）⇒ 时间与 4×4 矩形两个条件**按构造就满足** —— 变量不在"发几个事件"。逐类 `CS_DBLCLKS`（`GetClassLongPtr(hwnd, -26) & 0x0008`）实测：`True` = `Chrome_WidgetWin_1`(`CSTYLE=0x8`)、`DuiHostWnd`(`0xb`)、`Progman`(`0x8`)、`Shell_TrayWnd`(`0x8`)、`Qt51513QWindowIcon`(`0x8`)、`EdgeUiInputTopWndClass`(`0xb`)；`False` = `HwndWrapper[...]`（WPF，`0x0`）、`CASCADIA_HOSTING_WINDOW_CLASS`(`0x3`)、`Windows.UI.Core.CoreWindow`(`0x3`)、`PseudoConsoleWindow`(`0x0`)。②**判定口径（第十轮定稿）：看的是"接住点击的那个窗口"的窗口类 —— "类里有 `CS_DBLCLKS`"是必要条件、而且确实生效（OS 那层真的投递了 DBLCLK），不充分的是控件框架会把它折叠成自己的"第二次 Click"**（这两句的证据都来自**另一路完全权限会话的真机实测记载，非本会话验证**）：自建 Win32 窗口类 `CSTYLE=0xB`（含 `CS_DBLCLKS`）时 `--double` 真的产生 `WM_LBUTTONDBLCLK`（靶侧日志 `DOWN / UP / DBLCLK / UP`）；而 WinForms 窗体自身 `CSTYLE=0x8` 虽有 `CS_DBLCLKS`，**对它的 `Button` 做 `--double`** 只有 `CLICK n=2/3`、无 DBLCLK ⇒ 顶层窗口有样式**不等于**落点上那个子控件有。所以本条的正确量法＝按落点解析**真正接住点击的窗口**：**先 `WindowFromPoint`**（真机实测它对 WinForms 直接返回**子控件** `BUTTON` / `EDIT`，类样式 `0x8B` / `0x88`），**若要再往下细化子控件才用 `RealChildWindowFromPoint`，且必须把点传成"接收窗口的客户区坐标"**（真机实测语义：`pt` 是接收窗口**客户区**坐标；点在该窗口客户区内且没压到子窗口 ⇒ 返回**这个窗口自己**；落在客户区外才返回 `0`；**与是不是顶层窗口无关**。传屏幕坐标只会得到"巧合正确"的结果 —— 顶层那次恰好返回子控件、非顶层那次恰好返回 `0`，看起来像"只对顶层窗口细化"。真机表：A_FORM 顶层屏幕 (250,204)/客户区 (179,104) 都 ⇒ `0x370a2a`=A_BTN；A_BTN 非顶层 ⇒ 都返回**它自己**；B_FORM 顶层 ⇒ 屏幕 `0x0`、客户区 `0x3f0a94`=B_BTN；B_BTN 非顶层 ⇒ 屏幕 `0x0`、客户区**它自己**；C_FORM/C_RICH ⇒ 屏幕 `0x0`、客户区 `0x120aaa`；RAW1 顶层无子 ⇒ 屏幕 `0x0`、客户区**它自己**）；再读 `GetClassLongPtr(hwnd, -26) & 0x0008`，并且用**自建 `CS_DBLCLKS` 窗口过程**记 `WM_LBUTTONDBLCLK`（只看类样式会被"控件框架把 DBLCLK 收成第二次 `Click`"骗过：WinForms `BUTTON` 实测类样式 `0x8B` 含 `CS_DBLCLKS`，却只有两次 `CLICK n=2,n=3`、无 DBLCLK，因为 `ControlStyles.StandardDoubleClick` 默认关）；**本模块靶上"接住点击的子控件是哪个类"仍是未观测**。该类缺样式时**正确期望**就是"两次 `WM_LBUTTONDOWN`、永无 DBLCLK"，`--double` 只按"连发两次点击"表述。 |
| 落点闸门与注入之间的换位竞态 | **未观测**：复验方两次尝试都**没能稳定命中**这个时序窗口（即"探针取到落点读数之后、事件发出之前"窗口换位），所以"竞态下闸门也会放行错误注入"**没有被观测到**；已有的**正面观测**是"位移发生在探针之前时闸门照样拦得住"。 | 量法：让靶窗口自己定时 `SetWindowPos` / 换前台，同时循环跑 `click --target-hwnd <靶>`，每次记 `LANDING_PREFLIGHT=` 与靶侧计数，找"`=true` 而靶侧零增量"的组合。 |
| `unknown` 分支"只 WARN 不拦"在退出码层面无法端到端观测 | **未观测**：真机上落点读数拿不到时，紧跟其后的下游 UIPI 闸门会**独立**把它拦成 `exit 2`，两个原因叠在同一个退出码上，分不出"落点判据这次没拦"这半句。 | 量法：在**完全权限**会话（UIPI 不拦）里制造"落点读数拿不到"的场景（点在屏外 / 目标已最小化），跑 `click --target-hwnd <靶>`，期望退出码 0 + `LANDING_PREFLIGHT=unknown` + `WARN=`，且靶侧计数不变。 |
| plain `EDIT` 的类样式 `0x88` 未复测 | **未观测**：`WindowFromPoint` 对 WinForms 直接返回子控件时，文档列了 `BUTTON`(`0x8B`) 与 `EDIT`(`0x88`) 两类，但本轮真机靶是 `RichTextBox`（`RichEdit20W`，类样式 `0x4088`）⇒ 只有 `RichEdit20W 0x4088` 有真机读数，plain `EDIT 0x88` 是照它推的。 | 量法：完全权限会话里对真 `EDIT` 控件（WinForms `TextBox`）跑一次 `point`，读回类名与 `GetClassLongPtr(hwnd, -26) & 0x0008`。 |
| `leafHwnd`（历史：第十二轮删除） | **已消除（第十二轮）**：曾担心别的消费方依赖它 —— 全仓 grep（`(?i)leaf`）Node 侧 0 命中，`point` / `click` 的文本与 `--json` 输出都没有这个字段；它曾进过桥的报告对象 —— 改前那份部署副本（96353 字节）里 grep（`(?i)leaf`）命中 **6 行**，含 `Get-InjectionTarget` 的 `leafHwnd = ('0x{0:x}' -f $hwnd.ToInt64())`（填进去的是 `hwnd` 本身），没露出来只因 **Node 侧按白名单打印** ⇒ 第十二轮删除该计算与 P/Invoke 声明（`scripts/bridge.ps1` 96353 → 96321 字节），**无可观测行为变化**。**别把「没出现在 CLI 输出」读成「从来没算过」**。载体：`test/content-safety.test.mjs` 的源码守卫 + 它的反证用例（注入旧语义的文本必须抛错、真实 `bridge.ps1` 必须通过）。 | 量法：`Select-String -Path desktop\scripts\bridge.ps1 -Pattern '(?i)leaf\|RealChildWindowFromPoint'` 只应命中那条说明性注释（第十轮之后的仓库副本 96321 字节）。 |
| `move` 真的只移动指针吗 | **未观测（真机）**：`EXPECTED_EVENTS=1 BUTTON= CLICKS=0` 只钉住了计划（D71）。 | 量法：完全权限会话里把鼠标放到 A 点，跑 `move --x B --y C`，在靶窗口挂 `MouseDown` / `Click` 计数，期望指针到位（`CURSOR_LANDED=true`）而计数**不变**。 |
| `invoke` 的语义动作方法（`Invoke()` / `SetValue()` / `Toggle()` / `Select()` / `Expand()` / `Collapse()`）会不会也抛 AV | **未观测**：它们是唯一还在主桥进程里向 provider 发命令的 UIA 调用（`desktop/scripts/bridge.ps1` 的 `Do-InvokeChosen`：`$pattern.SetValue($SetValue)`，以及它后面按 `Invoke → Toggle → SelectionItem → ExpandCollapse` 优先级依次调用的那五个方法），与已删掉的 `GetSelection()[0].GetText(-1)` 不同 —— 它们不要求返回 range 文本、历史上也没观测到崩；但它们没被隔离到独立子进程，真要崩仍会带走整条 `invoke` 量法： | 量法：完全权限会话里对实现了对应 pattern 的元素逐条跑 `invoke --id`（含 `--set-value`），看有没有 `ERROR=bridge 没写出结果文件（exit=3221225477）`；若出现，按 I7e 的办法把语义动作也挪进独立子进程 |
| `scroll` 的判据在完全权限会话里到底读不读得到滚动位置 | **未观测**：本会话受限令牌下 UIA 跨完整性级别读被拒，`CONTENT_KINDS=value=0,scroll=0,rangeValue=0,toggle=0,selected=0,ancestorScroll=0`，所以"读得到 ⇒ 没变就是 `false`"这一支只用假数据单测过。哪些控件类型真的暴露 `ScrollPattern`（`ListBox` / `TextBox` / `TreeView` / 自绘列表）也没有量过。 | 量法：完全权限会话里对靶窗口的滚动容器跑 `snapshot --x <容器内一点> --y …`，看 `CONTENT_KINDS` 的 `scroll`（或 `ancestorScroll`）是否 >0；再跑 `scroll --dy -5`，期望 `CHANGED=true`（若读到读数）或 `CHANGED=unknown` + `WARN=`（若读不到）—— **任何情况下都不该是 `false`**。 |
| `GEO_MISMATCH=true` 在真机上能不能真被抓到 | **未观测**：本机受限会话里 `point` 的 `FromPoint` 被拒（`GEO_POINT_RECT=` 为空），只验到"最大化窗口下 Win32 与 UIA 根矩形一致"（`GEO_MISMATCH=false`），而真机那次打空正是最大化态下两套读数互不相容。 | 量法：完全权限会话里把靶窗口最大化后跑 `point --x <按钮中心>`，看是否 `GEO_MISMATCH=true`；再跑一次不带 `--force` 的 `click`，期望**注入前**退出码 2（这正是 I2b 想拦住的场景）。 |
| `--target-hwnd` 指向的真机路径 | **未观测**：`TARGET_HWND`/`TARGET_ROOT_HWND`/`TARGET_IN_WINDOW_LIST`/`TARGET_SOURCE=--target-hwnd`/`LANDING_IN_TARGET` 只用 `--dry-run` 与假数据单测验过（真机 `landingNote` 需真注入才有落点读数）。 | 量法：完全权限会话里 `click --x … --y … --target-hwnd 0x<靶>`，期望 `LANDING_SAME_WINDOW=true` 且 `LANDING_IN_TARGET=true`；再故意把 `--x/--y` 指到隔壁窗口，期望 `LANDING_IN_TARGET=false`（这一条正是它存在的理由）。 |
| `scroll` 的两条异常现象（机理未查明，登记而非结论） | **未观测**：①上/下步长不对称 —— 真机 5 格 ≈ 4 行、而 1 格 = 3 行；②连续 `3×dy=+5` 之后再 `1×dy=-5`，`nPos` 纹丝不动停在 71（`nMax=79 nPage=5`，两侧都还有空间）。成因没有查明（可能与应用自身的滚动吞并/惰性重排有关，**不要写成结论**）。 | 量法：对同一容器逐格扫描 `--dy`（±1 … ±10），每格前后各取一次 `GetScrollInfo(SB_VERT)` 的 `nPos`，把"格数 → Δ位置"整张表打出来；停滞现象则在同一脚本里连续发 `+5` 直到不动，再发 `-5`，记录 `nPos` 序列。 |
| `EVENTS_MATCH_PLAN=true` 与 `LANDING_IN_TARGET=true` 是不是"靶侧真的收到了"的证据 | **已观测（反例，来自完全权限会话的实测记载）**：靶窗口被置顶但**没拿到前台**时，`click --double` 靶侧计数只 +1、`click --clicks 3` 靶侧 +0，而 CLI 这两行读数都是 `true`；把靶窗口切到前台之后同样的命令就复现不出来。⇒ 两行只说明"插入的事件数等于计划数""落点像素上还是这个窗口"，**都不是靶侧收到事件的证据**。要证明生效只能看靶侧自己的计数/日志或 `--expect`。**未观测**：这个差异的完整触发条件（哪些前台/置顶组合下只落地一部分）。 | 量法：靶窗口挂点击计数，把"前台/非前台 × 置顶/不置顶 × 单击/双击/连点"组合各跑一遍，记录 CLI 两个布尔与靶侧计数两条线。 |
| 动画期的窗口矩形是过渡值 | **已观测（来自完全权限会话的实测记载）**：抬窗瞬间 `windows` 读到 `0,0,260,51`，不是稳定态的矩形。⇒ 抬窗 / 移动窗口之后至少等 300–500 ms（`--settle`）再取坐标或操作。**未观测**：不同应用/不同动画时长下的确切等待阈值。 | 量法：对同一个窗口以 0 / 100 / 300 / 500 / 1000 ms 的间隔连续 `windows`，把矩形序列打出来看什么时候稳定。 |
| 前台闸门只保证"窗口在前台"，不保证焦点落在可输入的控件上 | **已观测（来自完全权限会话的实测记载）**：真机里焦点停在 `Button` 上时 `type` / `key` 仍 `EXIT=0`、`FOCUS_OK=true`，但靶侧零新 `TEXTCHANGED`、CLI 报 `CHANGED=unknown`（`key` 要看的那几类读数两端都为 0 就是这个原因）—— 这是诚实的三态，不是 bug，**不要**据此去动闸门。**未观测**：注入前如何判断"焦点在能收键盘输入的控件上"（`AutomationElement.FocusedElement` 的 `ControlType` 白名单？）没有量过。 | 量法：靶窗口把焦点分别放在 `Button` 与 `TextBox` 上各跑一次 `type --text ABC`，记录 `FOCUS_OK` / `FOCUS_TARGET` / 靶侧 `TEXTCHANGED` 条数 / `CONTENT_KINDS` 里 `value` 的计数四条线。 |
| `--force` 跨几何闸门的真注入 | **已观测（来自完全权限会话的实测记载）**：竞态下默认被几何闸门拦下 ⇒ `EXIT=2`、完整输出里**没有** `INSERTED_EVENTS=`、靶侧零事件；同一条件加 `--force` ⇒ `EXIT=0` + 同一段文字变成 `WARN=` + `INSERTED_EVENTS=3` + 靶侧 2 条事件 ⇒ `--force` 确实只跳过闸门、注入照常。**未观测**：`--force` 对**目标完整性级别更高**的窗口能否真的注入； | 量法：**刻意不提供本机量法** —— 那需要管理员级（High 完整性级别）的窗口，本机不具备该条件，且属越界未测（红线 5：不驱动管理员权限进程、不绕 UAC），别把 `--force` 用到系统窗口或管理员进程窗口上。这条只能靠上游证据推断：UIPI 的判定是"目标 IL 高于调用者 IL 就丢"，而 `--force` 只跳过我们自己那道闸门、不改变 UIPI 本身。若要在不越界的前提下取读数，只能在**另一台机器或另一个权限上下文**里由管理员自己启动一个靶窗口、再在**那个上下文里**跑一次 `click --force`，比对 `INSERTED_EVENTS` / `EVENTS_MATCH_PLAN` 与靶侧自己的计数或日志（靶侧零事件 ⇒ `--force` 过不了 UIPI）。 |
| 显式 `--target-hwnd` 的落点判据现在是 fail-closed 的（第十轮新增） | **已观测（本会话受限，`--dry-run`）**：`LOADING_*` 见 D104 —— 落点明确不是目标时**一个事件都不发**（退出码 2），要硬发必须 `--force`。⇒ 用它当安全护栏的调用方要注意：这**不**是"加了 `--target-hwnd` 就万无一失"，而是"加错了会当场被拦"。**未观测**：完全权限会话里这条闸门在真注入前的实际拦截（本机受限会话本来就发不出去，只能验到闸门先于注入触发）。 | 量法：完全权限会话里 `click --x <隔壁窗口内一点> --y … --target-hwnd 0x<靶>` ⇒ 期望 `EXIT=2` + 输出无 `INSERTED_EVENTS=` + 靶侧零事件；再加 `--force` ⇒ 期望 `EXIT=0` + 靶侧计数 +1（证明"拒发"是闸门干的、不是发不出去）。 |
| 调用方必须自己确认"前台是靶 + 落点像素属于靶"，不能只依赖 CLI 的读数 | **已观测的教训（来自完全权限会话的记载）**：本项目早前有一轮约 40 次单击落到**用户终端**上（当时窗口几乎盖满屏幕，落点像素上根本不是靶）；第九轮又实测到"给了 `--target-hwnd` 而落点被别的窗口占住、事件照样发出"（这正是本轮闸门要堵的洞）。CLI 能做的只是"给读数 + 拦明显错的"：它看不出来"你其实想在另一个窗口上操作"，也不知道你此刻是不是真的想动用户的机器。所以驱动真实用户窗口前，调用方自己要：①`windows` / `point` 确认前台与落点是靶；②`--target-hwnd` 显式给上（落点不符会被闸门拦）；③注入类命令只认 `CHANGED=true` / `CURSOR_LANDED=true`，`CHANGED=unknown` 不许当成成功；④不可逆或高风险操作先停下问人。**未观测**：有没有更早的自动化手段能在"点下去之前"发现前台被别的应用抢走（例如把 `GetForegroundWindow` 与 `--target-hwnd` 的比对也变成注入前的闸门）—— 现在只对**落点像素**做这道比对。 | 量法：真机上故意把靶窗口最小化/被遮挡后再跑一次坐标类命令，看 `LANDING_PREFLIGHT` 与 `LANDING_IN_TARGET` 各自给什么。 |
| 本轮（I6e / I6f）的真机面未观测 | **未观测**：①`uia --depth 6` 输出里到底有没有 `el_unknown` 行；②常走路径（`uia --id` → `invoke --id`）里 `ID_IDENTITY=` 是否真给到 `checked` | 量法：完全权限会话里跑 `uia --depth 6` 看有没有 `el_unknown` 行；拿一个正常元素 id 跑 `invoke --id <el_id> --hwnd <0x..>` 看 `ELEMENT_RUNTIME_ID=` 与 `ID_IDENTITY=`；`invoke --id el_unknown`（不加 `--hwnd`）应得退出码 2 且 stderr 说「不唯一、必须限定窗口」，加上 `--hwnd` 应得 `ID_IDENTITY=absent` + `WARN=这次没有身份复核` |
| `--fallback-point` 的坐标回退完全不经过身份复核（已知缺口：登记，未修，F4） | **已观测（读代码 + 假桥路径） `chooseAction` 报错时 `cmdInvoke` 用定位快照那块矩形退化成一次坐标点击（`desktop/cli.mjs` 的 `cmdInvoke` 走到 `cmdInject(<synthetic>, 'click')` 那一支），下发的 `params` 里没有 `ElId`、更没有 `ElRuntimeId` ⇒ 无 pattern 的元素与 `el_unknown`（即使已按红线 21 限定 `--hwnd`）仍可借坐标点一下，而「点中的不是这个元素」在这条路上不可检出：`LANDING_PREFLIGHT` / `LANDING_IN_TARGET` 看的是「落点像素上的窗口是不是目标窗口」（红线 15 / I7g），与元素身份无关。**现在不改的理由**：这条退化本来就是调用方显式 opt-in 的「这不是语义操作」（红线 4，要加 `--fallback-point`，且会打 `WARN=`）；要动它得先有落点判据 —— 把落点像素上那个元素的身份也读出来、与定位快照比一次（`point` 已能给出 `ELEMENT_ID`，缺的是与 `ElRuntimeId` 的比对），属判据层立项，本次不做（硬边界：不动 `lib/verify.mjs` 判据本体）。 **未观测**：真机上这条退化路到底会不会点错、点错的概率多大 完全权限会话里对一个无 pattern 的容器元素跑 `invoke --id <el_id> --hwnd <0x..> --fallback-point`，看输出里有没有任何一行能证明「点中的是这个元素」（预期：没有 | ） |
## 交付前的最小闭环
改了 `desktop/` 任何东西之后，单元测试全绿之外还要跑一次真机序列。**判据分两档**：受限会话里只能验证"读数、闸门与观测如实工作"；**注入类命令要证明可用，必须在完全权限（`danger-full-access`）会话里跑**。跑完对照「用例总表」的 D44–D109。

受限会话（`workspace-write` 等）里能跑、也应当跑的部分：
```sh
cd desktop && node --test --test-isolation=none test   # 全绿（不加 flag 会 EPERM，见本文开头）
node cli.mjs help                                      # 退出码 0，命令与选项都在
node cli.mjs probe                                     # D59b+D65–D68：三个 size 常量、12 个 OFFSET_*、四个 *_MATCHES_CANONICAL 全 true（从不发事件）
node cli.mjs profile                                   # D44：DPI_AWARE=PER_MONITOR_AWARE_V2、SCREEN=物理像素、INTEGRITY_SELF=…
node cli.mjs screen --out "$env:TEMP\adg-screen.png"   # D45：WIDTH/HEIGHT=物理像素、SHOT_EXISTS=true
node cli.mjs windows                                   # D46：进程名/类名/矩形/IL 都在；读不到的写 unknown
node cli.mjs point --x 1280 --y 800                    # D47：ROOT_HWND 与 windows 里那一行一致
node cli.mjs uia --depth 3 --limit 12                  # 记下某个 el_… 的 id（patterns 列应显示真值，不是 -）
node cli.mjs uia --id el_xxxxxxxx                      # D48：新进程里 FOUND=true（跨快照稳定）；D69：两条路径的 patterns 必须相同
node cli.mjs click --x 100 --y 100 --dry-run           # D51+D70：PLAN_ONLY=true、WILL_SEND_ABSOLUTE/WILL_SEND_NORMALIZED，不发事件；不许出现 INSERTED_EVENTS
node cli.mjs move --x 100 --y 100 --dry-run            # D71：EXPECTED_EVENTS=1、BUTTON= 空、CLICKS=0
node cli.mjs uia --limit 3                             # D75：TRUNCATED=true + COUNT 口径的 WARN
node cli.mjs invoke --id el_00000000 --limit 3         # D74：退出码 2，stderr 说的是"快照被截断"，不是"元素可能已消失"
node cli.mjs click --x 100 --y 100                     # D50：目标 IL 更高时**注入前**就 ERROR=UIPI blocked: …
node cli.mjs point --x 1280 --y 800                    # D82+D84：GEO_* 四行齐；GEO_MISMATCH=true 时坐标类命令会在注入前 exit 2（D83）
node cli.mjs click --x 100 --y 100 --dry-run --no-pixel --target-hwnd 0x<上面 windows 里某行的 hwnd>   # D87：TARGET_SOURCE=--target-hwnd、LANDING_IN_TARGET=not-evaluated
node cli.mjs snapshot                                  # D78+D81：内容探针自己不许崩（SNAPSHOT_OK=…、逐行 READING）；受限会话里 CONTENT_BEARING_COUNT 常为 0，note 里会留 Access is denied
node cli.mjs verify --no-pixel                         # D80+D81：CONTENT_PROBE=(ok|failed)、CONTENT_BEARING_COUNT=<数字>
node cli.mjs verify --no-content                       # D81：CONTENT_PROBE=skipped + 一条说明覆盖面变小的 WARN（探针没跑就不许报 ok）
```

完全权限（`danger-full-access`）会话里才有效的部分（**只用 `--dry-run` 证明不了注入可用**，见 I10b）：
```sh
node cli.mjs move --x 640 --y 400                      # D52：CURSOR_AFTER=640,400、CURSOR_LANDED=true
node cli.mjs click --x <自建测试窗口按钮中心的物理坐标>   # D53：CHANGED=true，按钮侧计数 +1
node cli.mjs type --text "adg-desktop-probe" --hwnd <靶窗口 hwnd>   # D54+D93：CHARACTERS=17，文本被控件读回、首字符不丢（--hwnd 现在必填）
node cli.mjs key --keys ctrl+a --hwnd <靶窗口 hwnd>     # 组合键（修饰键用 + 连接）；--hwnd 必填，否则字符会打进当时的前台窗口
node cli.mjs type --text x --dry-run                    # D93：不给 --hwnd ⇒ 退出码 2（"键只会发给前台窗口"）
node cli.mjs click --x 1 --y 2 --dry-run --bogus         # D91：用不上的开关 ⇒ 退出码 2，不静默忽略
node cli.mjs key --keys ctrl+a --hwnd <靶窗口 hwnd> --dry-run   # D100：PHASE= 序列 modifier-down → key-down → key-up → modifier-up（发射顺序的唯一内存判据；事件数看不出顺序）
node cli.mjs click --x 100 --y 100 --dry-run --no-pixel --target-hwnd 0x<上面 windows 里某行的 hwnd>   # D104：LANDING_PREFLIGHT=true（落点就是它才放行）；换成别的句柄期望 false + 退出码 2
node cli.mjs click --x 1 --y 2 --dry-run --target-hwnd 0xdead   # D104：落点不是它 ⇒ 退出码 2 且没有 INSERTED_EVENTS=；加 --force ⇒ 退出码 0 + WARN=
node cli.mjs verify --x <靶内一点>                       # D94：CONTENT_SOURCE=point+hwnd（作用域是加法的）
node cli.mjs scroll --x 640 --y 400 --dy -3            # 滚轮：先移到该坐标再发 -3 格
node cli.mjs invoke --id <某个有 ValuePattern 的元素> --set-value "probe"   # VALUE_AFTER=probe
node cli.mjs invoke --id <无 pattern 的容器元素>          # D49：WARN= + 退出码 2（不猜、不退化）
node cli.mjs verify --x 640 --y 400                    # D58+D73：CHANGED=false + WARN=（单次快照）、CONTENT_BEARING_COUNT>0
# 每条注入命令跑完再看两个键：EVENTS_MATCH_PLAN=true（D70）、CHANGED 若不是 unknown 就必须有 CONTENT_BEARING_COUNT 撑着（D72+D73）
# 六条命令都不许再出现 exit=3221225477（I7e）：verify / move / click / type / key / invoke 每条都要跑到"注入 + 打印结论"
# 注入前先断言窗口矩形与 UIA 根矩形一致（I2b）：先跑同坐标的 point，两套矩形不一致时**不要**照 uia 的子元素矩形点（真机最大化窗口踩过这个坑）
# 落点归属要把 --target-hwnd 递进去才作数（I7g）；scroll 的结论先看 CONTENT_KINDS 里 scroll 那一类是否 >0（I7f，读不到就是 unknown 不是 false）
# 组合键看 PHASE= 不看事件数（I7l）：ctrl+a 的序列必须是 modifier-down → key-down → key-up → modifier-up；修好前真机把 ctrl+a 发成 ctrl↓ ctrl↑ a↓ a↑，靶侧只多一个小写 a
# 前台闸门只保证"窗口在前台"、不保证焦点落在可输入的控件上（已观测）：焦点在 Button 上时 type/key 仍 EXIT=0，靶侧零新 TEXTCHANGED、CLI 报 CHANGED=unknown —— 那是诚实的三态，不是 bug
# --force 跨几何闸门已观测：默认拦下 ⇒ EXIT=2、完整输出里没有 INSERTED_EVENTS=、靶侧零事件；同条件加 --force ⇒ EXIT=0 + 那段文字变 WARN= + INSERTED_EVENTS=3 + 靶侧 2 条事件
node cli.mjs snapshot --hwnd <靶窗口 hwnd>              # D81：对真的文本框读内容，期望 CONTENT_BEARING_COUNT>0、SNAPSHOT_OK=true（这是"内容类判据到底能不能用"的正面证据）
```

三条现场注意：①`$LASTEXITCODE` 经过管道会失真（`node cli.mjs … | Select-Object -First 1` 之后读到的不是它的退出码），要判退出码就**单独跑**那条命令、紧接着读 `$LASTEXITCODE`；②`--raise` 会**永久改变用户的 z 序**，只在确认窗口被遮挡时用，用完自己把窗口恢复；③受限会话里真发一次（如 `--force` 硬发）得到的 `INSERTED_EVENTS>0` / `LAST_ERROR=0` / `CHANGED=false` **是正确结果**，不要为了"跑通"去掉闸门 —— 那正是 I7 要钉住的现象。

第四条只对**写测试**的人有意义：本模块的用例**不许跨两次 CLI 调用比元素/行数**。桌面窗口集合在两次调用之间就会变（实测：一次全绿的用例在下一次跑成 59/1，失败项正是"文本渲染与 JSON 逐行一致"那条跨调用比对）。要比值就从**同一次调用**里同时取原始输出与 `--json`，样本优先挑 `controlType === 'Window'` 这类稳定元素。

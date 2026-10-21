#!/usr/bin/env node
// desktop/cli.mjs —— 本模块唯一的入口。
//
// 契约（与 browser/cli.mjs 同形，改任何一条都要同步 desktop/design.md 的「对外接口」）：
//   * 输出一律 `KEY=VALUE`，一行一个键；`ERROR=<msg>` 只出现在 stderr 且必带非零退出码。
//   * 退出码：0 成功 / 1 运行期失败 / 2 用法错误（不认识命令、缺值、值不合法）。
//   * 加 `--json` 时，最后再打一个 `JSON=` 开头的单行 JSON（键名同下面这些 KEY）。
//   * 零运行时依赖：只用 Node 内置模块 + 本目录的 lib/ + scripts/bridge.ps1。
//   * 本文件顶部这段 USAGE 是**唯一真相源**：persona 与文档不复制选项表。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MIN_NODE_MAJOR,
  dshHome,
  envGet,
  installedEntry,
  normalizeIntegrity,
  nodeMajor,
  repoEntry,
  runtimeVerdict,
  platformVerdict,
  decideInjection,
  BLOCK_HIGHER,
} from './lib/env.mjs'
import {
  assertNoExtra,
  checkFlagScope,
  commandOf,
  flagOn,
  hasValue,
  optionalText,
  parseArgs,
  requireButton,
  requireInt,
  requirePoint,
  requireText,
  UsageError,
} from './lib/args.mjs'
import { clampRegion, geoVerdict, insideScreen, screenBox, toAbsolute } from './lib/coords.mjs'
import { elementIdentity, identityState, isElementId, isPlaceholderElementId, patternsText, patternShapeProblem, pickElement, rectText, snapshotScopeText, treePrefix, chooseAction } from './lib/elements.mjs'
import { BridgeError, MODULE_ROOT, bridgeJson, cleanup, probeBridge, runBridge } from './lib/bridge.mjs'
import { applyContentSnapshot, changeVerdict, checkExpectations, compareStates, injectionWarn, landingNote, landingPreflight, neededKinds, normalizeKinds, parseExpect, raiseNoteText } from './lib/verify.mjs'

/** bridge 侧的 `raise-ignored-no-target` 只回英文标记（脚本必须 ASCII-only），中文解释在这边给。 */
const RAISE_NOTE =
  '--raise 对这条命令无效：它需要 --x/--y（鼠标）或 --hwnd（键盘）来指定要抬起的窗口；本模块不会去猜一个窗口。'

const USAGE = `用法：node cli.mjs <命令> [选项]…

命令（本机桌面窗口；坐标一律是**真实物理像素**，进程启动即声明 PerMonitorV2）：
  help                                   打印本页（也就是全部选项的唯一真相源）
  profile                                环境自检：Node / PowerShell / DPI / 屏幕 / 自身完整性级别
  windows                                枚举可见顶层窗口（含进程、类名、矩形、完整性级别）
  screen [--out <png>] [--region <l,t,w,h>] [--hash]
                                         --out 的**父目录必须已存在**（本模块不替你建目录；
                                         不存在 ⇒ 用法错、退出码 2、一个字节都不写）
                                         整屏或指定区域截屏，不缩放；输出 SHOT/WIDTH/HEIGHT/ORIGIN
                                         （--hash 时另给 PIXEL_HASH=，用于前后对比）
  uia [--hwnd <0x..>] [--depth N] [--name <子串>] [--id <el_id>] [--limit N]
                                         枚举 UIA 树（只读），每行一个元素与它支持的 pattern
  point --x <px> --y <px>                该物理坐标下是哪个窗口/哪个元素（WindowFromPoint 往返）
  click --x <px> --y <px> [--button left|right|middle] [--double] [--clicks N] [--force] [--raise]
                                          [--target-hwnd <0x..>]
                                          --double = **连发两次点击**（靶侧计数 +2，真机实测）；
                                          "双击消息（WM_LBUTTONDBLCLK / UIA DoubleClick）到底有没有
                                          触发"**未观测**，别把它当双击语义的保证，量法见
                                          desktop/testing-guide.md。--clicks N 优先于 --double。
  move  --x <px> --y <px> [--force]      移动真实鼠标（SendInput 绝对坐标）；**只移指针，绝不点击**
  type  --text <字符串> --hwnd <0x..> [--x <px> --y <py>] [--force] [--raise]
                                          把字符串按 Unicode 逐字符键入 **--hwnd 指名的那个窗口**
  key   --keys <如 ctrl+s> --hwnd <0x..> [--x <px> --y <py>] [--force] [--raise]
                                          按键或组合键（modifier+key，见下），同样只发到 --hwnd
                                          **type/key 的 --hwnd 是必填的**：键只会发给前台窗口，而
                                          Windows 拒绝后台进程抢前台 —— 不指名就可能把字符打进"当时
                                          的前台窗口"（真机踩过：一次不带 --hwnd 的 type 把 10 个
                                          字符打进了另一个窗口，而 CLI 只报 CHANGED=unknown、
                                          靶侧日志零变化，调用方根本看不出来）。句柄从 windows 或
                                          point 的输出里取，给**顶层窗口**（SetForegroundWindow
                                          只对顶层窗口有效）。--x/--y 在这里只把观测作用域指到那个
                                          点，不影响收键窗口。
  scroll --x <px> --y <px> --dy <n> [--force] [--target-hwnd <0x..>]
                                         滚轮：先移到该坐标，再发 n 格（正=上，负=下）。
                                          它的判据**只看滚动位置读数**（光标下元素自己的，或它 3 层
                                          内祖先中带 ScrollPattern 的那个）：读得到且没变才报 false，
                                          读不到一律报 CHANGED=unknown —— 真机出现过"滚动确实发生，
                                          而文本类读数看不见"，那时报 false 就是判据在说谎。
  invoke --id <el_id> [--set-value <v>] [--fallback-point] [--force]
                                           [--hwnd <0x..>] [--name <子串>] [--depth N] [--limit N]
                                         用元素**自带的 UIA pattern** 操作；不支持就报错，不猜
                                          **--hwnd 强烈建议给**：不给就在整张桌面上遍历，桌面一拥挤就会在
                                          --limit 处截断，于是「快照里没有这个 id」（截断）与「元素真的不
                                          存在」被混成同一句话。口径见下面「id 与作用域绑定」。
                                         **id 相同不保证是同一个元素**（id 只是 runtimeId 的哈希）：定位
                                         快照里那个元素的 runtimeId 随这次调用一起下发，桥在第二遍遍历
                                         命中该 id 时逐字符复核 —— 不一致就**不执行任何动作**，报
                                         ID_IDENTITY=mismatch + 退出码 2。快照没给 runtimeId 时不下发
                                         （绝不凭空造一个），只报 ID_IDENTITY=absent + 一条 WARN。
                                         el_unknown 是 runtimeId 读不到时的占位 id（整类元素折叠成它，
                                         不唯一、也没有身份可复核）⇒ 拿它作 --id 时**必须**给 --hwnd。
  verify [--x <px> --y <py>] [--expect k=v;k=v]
                                         只观测：打印当前状态与判据结果（CHANGED 恒为 false 口径见文档）
  snapshot [--hwnd <0x..>] [--x <px> --y <py>]
                                         只读的**内容快照**探针（UIA Value / 滚动位置 / RangeValue /
                                         Toggle / 选中态），排障用。它跑在独立子进程里：这类读取能抛
                                         PowerShell 抓不住的 AccessViolationException（真机
                                         exit=3221225477），隔离开才不会把注入与其余判据一起带崩。
                                         零副作用：不发输入、不抬窗口、不改前台。
                                          **作用域是加法的**：\`--hwnd\` 钉住根，\`--x/--y\` 再加读
                                          "点上的元素 + 它 3 层祖先"；两个都给 = 都要读（注入类命令
                                          的 before/after 探针就是这么取的）。
  probe                                  **只做内存编码**的诊断命令：把构造出来的鼠标/键盘事件
                                         StructureToPtr 成十六进制回显，**从不调用 SendInput**。
                                         用途是钉住"结构体全零却照样报已插入 N 个事件"这个缺陷
                                         （静态审查看不出来），日常用不到。

通用选项：
  --json                                 末尾再打一行 JSON=（机器可读；KEY=VALUE 仍然照打）
  --dry-run                              click/move/type/key/scroll：只算坐标与归一化值，不发事件
  --force                                明知风险也要发，三处闸门：①目标完整性级别更高（默认阻断并报
                                         ERROR=UIPI blocked）；②坐标类命令的几何自洽检查发现
                                         windows 矩形与 UIA 根/元素矩形互相矛盾（默认阻断并报
                                         GEO_MISMATCH=true）；③显式给了 --target-hwnd 而落点像素上的窗口不是它（默认阻断并报 LANDING_PREFLIGHT=false）。用它会跳过保护，先读懂 WARN 再决定。
  --target-hwnd <0x..>                   坐标类命令（click/move/scroll）：**显式**声明"我要操作的是这个窗口"。给了它，
                                        落点归属才按它比对（LANDING_IN_TARGET=true|false）；不给
                                        就只报 LANDING_SAME_WINDOW 并把 LANDING_IN_TARGET 记成
                                        unknown —— 因为"落点像素上还是同一个窗口"**不等于**
                                        "点进了我想要的那个窗口"（真机：前台是 A、点隔壁 B 的
                                        按钮，照样报"在目标内=true"）。它同时会被 UIPI 闸门用来
                                        判定目标完整性级别。**给了它就会在注入前多一道闸门**（LANDING_PREFLIGHT=true|false|unknown）：落点明确不是它 ⇒ 默认不发事件、退出码 2，要硬发得加 --force；落点读不到 ⇒ 只给一条 WARN。键盘命令**不要**用它 —— 收键窗口是 \`--hwnd\`（混用会报用法错）。
  --raise                                注入前把目标窗口抬到最顶层（SetWindowPos HWND_TOPMOST）。
                                         后台进程用 SetForegroundWindow 会被 Windows 拒绝，所以
                                         被别的窗口盖住时只能靠它；它会改变用户的 z 序，故默认不开。
                                         **只对能指名窗口的命令有效**：click/move/scroll 用 --x/--y，
                                         type/key 用 --hwnd；指不出窗口时不会去猜，只给一条 WARN。
                                         type/key 另有一道前台闸门：目标不在前台就尝试抬到前台，
                                         仍抬不上来 ⇒ 报 ERROR 且一个键都不发。
  --settle <ms>                          注入后等多久再复核（默认 150）
  --no-pixel                             复核时不抓像素哈希（只有窗口/前台/落点三类判据）
  --no-content                           复核时不读 UIA 内容快照（省一次子进程；代价是内容类动作只能报
                                         CHANGED=unknown）
  --hash                                 screen：另给一行 PIXEL_HASH=（PNG 字节的 SHA256 前 16 位）
  --timeout <ms>                         native bridge 超时（默认 60000）
  --hwnd <0x...>                         uia / invoke / snapshot：作用域（遍历或内容快照的子树）。
                                         对 invoke 是**作用域**，不只是显示过滤：元素 id 绑作用域。
                                          type / key：**收键窗口（必填）** —— 键发给它，注入前先把它
                                          抬到前台并核对（前台闸门不过 ⇒ 报错、一个键都不发）。
  --name <子串>                          uia / invoke：按 Name 或 AutomationId 过滤要看/要找的元素。
                                         注意它只过滤"收进快照的元素"，遍历本身仍从桌面根开始 ——
                                         要真正把遍历限定住，用 --hwnd。
                                          给了 --id 时它**不参与匹配**（id 路径只按 id 找）：勾中的元素少了
                                          只是快照小一点，遍历照样全量跑 ⇒ 它只影响耗时、不影响语义。
  --depth <n>                            uia / invoke：树的最大深度（默认 8 / 16）
  --limit <n>                            uia / invoke：**遍历预算**（默认 3000）。走到这个数就停下，
                                         并打 TRUNCATED=true —— 此时 COUNT 是"走到的元素数"，
                                         不是桌面上的元素总数。

开关作用域：**这条命令用不上的开关一律报用法错**（退出码 2），不静默忽略 —— "传了但不生效"
  与"没传"长得一模一样，正是缺陷能藏住的地方（真机：\`--hwnd\` 没被传下去、探针作用域被悄悄换掉）。
  每条命令认识哪些开关由 \`lib/args.mjs\` 的 \`COMMAND_FLAGS\` 定，报错里会把清单打出来。

--keys 的写法：\`ctrl+s\` / \`alt+shift+tab\` / \`enter\` / \`f5\` / \`a\`；
  修饰键 ctrl / alt / shift / win 可叠加（用 + 连接），其余是单个按键名或单个字符。

判据口径（**别把调用返回当成功**）：
  UIPI 拦下合成输入时 SendInput 会照常返回"已插入 N 个事件"且 GetLastError=0，事件随后被静默丢弃。
  所以每条注入类命令都会在动作前后各取一次状态并打印 CHANGED=true|false + BEFORE=/AFTER=；
  CHANGED 只比"会因注入而变"的量（前台 / 窗口集合与标题 / 目标区域像素哈希 / UIA 内容属性），
  取值为 true / false / **unknown** 三态：
    true    确实观测到了差异（DETAIL= 给出是哪一类）。
    false   判据**看见了**这一类动作的效果范围，而它没有变。
    unknown 没有差异，而且这次动作的效果本就落在判据覆盖之外（没有像素区域、也读不到任何对应的
            UIA 内容读数）—— "我看不见"绝不许报成 false。真机实测：type/key/scroll 都报过
            false，而靶窗口自己的 TextChanged 日志 / 独立 UIA ValuePattern 读回 / 独立
            GetScrollInfo(SB_VERT) 都证明动作已生效（nPos 0→15→30）。
  按命令分的判据覆盖面（读不到就必须报 unknown，不许拿 false 冒充）：
    scroll  只看**滚动位置**读数（光标下元素自己，或它 3 层内祖先里带 ScrollPattern 的那个）
    type    只看 Value（文本框内容）
    key     看 Value / 选中态 / Toggle / RangeValue / 滚动位置里能读到的那些
    click   前台 / 窗口集合与标题 / 目标区域像素 / 内容读数
    move    不看 CHANGED，看 CURSOR_AFTER= 与 CURSOR_LANDED=true（硬件级回读 GetCursorPos）
  实际读到哪几类由 CONTENT_KINDS= 逐类报出（例 value=1,scroll=2,ancestorScroll=1）——
  光看 CONTENT_BEARING_COUNT= 总数会误导：scroll 要的是 scroll 那一类。
  坐标类命令在注入前还会做一次**几何自洽检查**（GEO_WINDOW_RECT / GEO_UIA_ROOT_RECT /
  GEO_POINT_RECT / GEO_MISMATCH）：两份读数互相矛盾时默认**不发事件**、报 GEO_MISMATCH=true +
  ERROR（真机踩过：窗口最大化时两套坐标不一致，按 uia 那组点击会打空）。要照原样点得加 --force。
  内容类判据来自 UIA：焦点元素与目标窗口的 Value / 滚动位置 / RangeValue / Toggle / 选中态
  （读得到几条由 CONTENT_BEARING_COUNT= 报出；受限令牌下往往一条都读不到）。
  这一路跑在**独立子进程**里（就是上面的 snapshot 命令）。CONTENT_PROBE= 报三态：ok（跑了、
  没崩）/ failed（子进程崩了或缺读数）/ skipped（给了 --no-content，没跑）。failed 时 CHANGED
  一律降级为 unknown（**缺测绝不报成 false**）；skipped 时另给一条 WARN 说明这次没覆盖内容类
  效果 —— 那种情况下的 false 只代表像素/窗口/前台没变。文本选区那一类**故意不读**：真机上
  TextPattern.GetSelection()[0].GetText(-1) 会以 AccessViolationException 杀掉整个进程，
  而 PowerShell 的 try/catch 抓不住这种 corrupted-state 异常（详见 docs 的 I7e）。
  **id 与作用域绑定**：uia 打印的 el_xxxxxxxx 是 UIA runtime id 的哈希，只在**取它的那次遍历**
  里稳定。桌面一拥挤，从桌面根做的遍历会在 --limit 处截断，于是同一个 id 在 root 快照里找不到、
  在 --hwnd 快照里又找得到（真机 11/11 全失败就是这个）。所以：取 id 与用 id 必须是同一个作用域；
  "快照里没有"不等于"元素不存在"，截断时工具会明说 TRUNCATED=true。
  反过来**不成立**：**id 相同也不保证是同一个元素**。\`el_unknown\` 就是反例 —— 它是 runtimeId
  读不到时整类元素折叠出来的同一个字符串，不唯一、也没有身份可复核，所以不许拿它在**未限定窗口**
  时 invoke（报用法错、退出码 2）。其余 id 的复核结论看 \`ID_IDENTITY=\`：checked（下发的 runtimeId
  与这次命中的元素一致）/ absent（快照没给 runtimeId，这次没有身份复核，另有一条 WARN）/ mismatch
  （不一致 ⇒ 桥一个动作都没执行、退出码 2：这是**拒绝动手**，与"动作没生效"的 1 不是一回事）。
  \`point\` 那一路（这个坐标上是哪个窗口）**不参与 CHANGED** —— 光标一动它就变，算进去会让
  注入失败也报 true（实测出现过这种假成功）；它改成独立几行：
  \`LANDING=\` 说落点窗口、\`LANDING_SAME_WINDOW=\` 说"落点像素上的顶层窗口与这次认定的目标
  是不是同一个"，\`LANDING_IN_TARGET=\` 只在**给了 --target-hwnd** 时才给 true|false ——
  没给显式目标时它恒为 unknown，因为那时根本没有可比的目标，而这一行极易被读成"点对了"。
  它**只记录、不拦截**（事件已经发出去了）—— 拦截是另一行、另一时刻的事：给了 --target-hwnd 时
  注入**前**先打 \`LANDING_PREFLIGHT=true|false|unknown\`（三态口径与几何闸门同款）：明确是别的
  窗口 ⇒ 默认不发事件、退出码 2（要硬发加 --force，那段文字变 WARN=）；读不到落点 ⇒ 只 WARN。
  两道门都要看：探针与注入之间还有竞态，preflight 通过也不代表事后 \`LANDING_IN_TARGET=true\`。
  坐标类命令另有一次**硬件级回读**：\`CURSOR_AFTER=\` 是 \`GetCursorPos\` 读回的落点，
  \`CURSOR_LANDED=true\` 才说明指针真的到了那个像素（SendInput 的返回值证明不了这件事）。
  两条**判据边界**（真机实测教训，别把工具自己的行读成靶侧证据）：
    \`EVENTS_MATCH_PLAN=true\` 只说明"发出去的事件数等于计划数"，\`LANDING_IN_TARGET=true\` 只说明
    "落点像素上的顶层窗口与认定的目标同根"；**两者都不等于靶侧真的收到了那么多次事件**。真机实测：
    靶窗置顶但未获前台时，\`--double\` 靶侧只 +1、\`--clicks 3\` 靶侧 +0，而 CLI 两项都报 true；
    确认前台后完全复现不出来。要断言指令真的落地，必须让靶侧自己计数/写日志（见 testing-guide）。
    抬窗、最大化/复位**动画期间** \`windows\` 会给出过渡矩形（实测 0,0,260,51），而同一时刻 \`point\`
    的两套读数已经一致 —— 抬窗后至少再等 300–500 ms 再操作（\`--settle\` 管的是注入后的等待）。
  目标窗口完整性级别高于本进程时**在注入前就阻断**（ERROR=UIPI blocked: …），不会静默继续。

安全边界（不做的写在 desktop/design.md 的「非功能红线」）：
  不绕 UAC、不碰安全桌面（Winlogon / UAC 同意界面）、不做进程注入、不改系统设置、
  不驱动管理员权限进程。本工具只读窗口/UI 状态 + 用 SendInput 合成输入。`

const print = (...parts) => process.stdout.write(`${parts.join(' ')}\n`)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 收集所有命令共用的 bridge 选项（超时、临时文件用途）。
 *
 * `ADG_DESKTOP_BRIDGE` 可把桥换成另一个脚本（测试与排障用；与 `lib/bridge.mjs` 的
 * `ADG_DESKTOP_POWERSHELL` 同一口径）。存在的理由很具体：`invoke` 的**身份复核发生在桥的
 * 第二遍遍历里**，而"复核不一致 ⇒ 桥一个动作都不执行 ⇒ CLI 按拒动手报退出码 2"这条链路
 * 若没有这条缝隙，就只能在真机上用"故意去操作另一个元素"来证明 —— 那正是本模块不许在
 * 单测里做的事（testing-guide.md 的注入类用例都要求完全权限会话）。
 */
function bridgeOpts(args) {
  const timeoutMs = hasValue(args, 'timeout') ? requireInt(args, 'timeout', [1000, 600000]) : undefined
  const script = envGet(process.env, 'ADG_DESKTOP_BRIDGE')
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(script ? { script } : {}),
  }
}

/** `--json` 时打最后一行；键值里换行一律转义（一行 JSON 是硬要求）。 */
function printJson(args, payload) {
  if (!flagOn(args, 'json')) return
  print(`JSON=${JSON.stringify(payload)}`)
}

/**
 * 窗口句柄一律规整成 `0x` + 小写十六进制的形状。`windows` 列表里的句柄就是这个形状，
 * 与它逐字符比较才不会因为 `0x00AB` / `0xab` 这种写法差异被判成"不同窗口"。
 * 形状不对**直接报用法错**，不去猜调用方想指哪个窗口。
 * `flag` 只影响报错里点名哪个开关（`--hwnd` 与 `--target-hwnd` 是两个不同用途的入口，
 * 报错点错了会把人引到错的选项上）。
 */
function normalizeHwnd(raw, flag = 'target-hwnd') {
  const text = String(raw ?? '').trim()
  const body = text.toLowerCase().startsWith('0x') ? text.slice(2) : text
  if (!/^[0-9a-f]+$/i.test(body)) {
    throw new UsageError(`--${flag} 要是十六进制句柄（如 0x1a2b3c）：${text}`)
  }
  return `0x${BigInt(`0x${body}`).toString(16)}`
}

/**
 * 键盘命令（`type` / `key`）的**收键窗口必须显式给出**（design.md I7i）。
 * 键只会发给前台窗口，而 Windows 拒绝后台进程抢前台 —— 不指名就可能把字符打进"当时的前台窗口"。
 * 真机踩过：一次不带 `--hwnd` 的 `type --text ABCDEFGHIJ` 在靶窗口没抢到前台时，10 个字符进了
 * 另一个窗口（疑似用户的终端），而 CLI 只报 `CHANGED=unknown`、靶侧日志零变化 —— 调用方看不出来。
 * 所以这不是"可选增强"，是硬前置。`--target-hwnd` 是坐标类命令的落点断言，含义不同，混用就报错。
 */
function requireKeyboardHwnd(args) {
  // `--target-hwnd` 混用的情况不用在这里挡：它不在 type/key 的开关清单里，`checkFlagScope`
  // 会在分发之前就以用法错拒掉（报错里会把这条命令认识的开关列出来）。
  if (!hasValue(args, 'hwnd')) {
    throw new UsageError(
      'type/key 必须显式指名收键窗口：--hwnd <0x..>。键只会发给前台窗口，Windows 又拒绝后台进程' +
        '抢前台 —— 不指名就可能把字打到别的窗口里。句柄从 windows 或 point 的输出里取',
    )
  }
  return normalizeHwnd(args.hwnd, 'hwnd')
}

function screenBoxFrom(report) {
  const screen = report?.screen ?? {}
  return screenBox({
    originX: screen.virtualLeft ?? 0,
    originY: screen.virtualTop ?? 0,
    width: screen.virtualWidth ?? screen.width,
    height: screen.virtualHeight ?? screen.height,
  })
}

/**
 * 取一次状态指纹（供验证用）。`--no-pixel` 时不抓像素哈希。
 * 抓像素用 bridge 的 `screen --hash`：PNG 字节的 SHA256 前 16 位，不落盘。
 */
function captureState(args, box, pixelRegion) {
  const view = bridgeJson({ Command: 'verify', X: args.x, Y: args.y }, bridgeOpts(args))
  let pixelHash = ''
  let pixelNote = ''
  if (pixelRegion && !flagOn(args, 'no-pixel')) {
    try {
      const shot = bridgeJson({ Command: 'screen', Region: pixelRegion, Hash: true }, bridgeOpts(args))
      pixelHash = shot.hash ?? ''
      if (pixelHash === '') pixelNote = 'bridge 没给出像素哈希（Region=' + pixelRegion + '）'
    } catch (error) {
      // 静默吞掉会让"像素这一类判据"看起来是"没变化"，而实际是"没测"。
      pixelHash = ''
      pixelNote = `像素抓取失败（Region=${pixelRegion}）：${error?.message ?? String(error)}`
    }
  }
  const state = { ...view.verify, pixelHash }
  if (args.x !== undefined && args.y !== undefined) {
    try {
      const point = bridgeJson({ Command: 'point', X: args.x, Y: args.y }, bridgeOpts(args))
      const rect = point.window
        ? `${point.window.left},${point.window.top},${point.window.width},${point.window.height}`
        : ''
      state.pointRect = rect
      // 落点归属断言要用的两个读数：这个坐标上的窗口，以及它的顶层窗口。
      state.pointRootHwnd = String(point.rootHwnd ?? '')
      state.pointLanded = point.insideVirtualScreen === true
    } catch {
      state.pointRect = ''
    }
  }
  // 内容类判据走**独立子进程**（bridge 的 `snapshot` 命令），而且通道是"绝不抛"的那一条：
  // UIA 内容读取能抛 PowerShell 抓不住的 corrupted-state 异常，整个 powershell.exe 当场消失
  // （真机 exit=3221225477）。它曾经住在 verify 里，于是每条注入类命令的 before 快照都被带崩，
  // click/type/key 连 SendInput 都没走到。现在崩了只损失这一条读数，其余判据与注入照跑，
  // 而且这一条记 unknown —— 读不到绝不等于"没变化"。
  if (!flagOn(args, 'no-content')) {
    // 作用域必须是**加法的**（design.md I7h）：`Hwnd` 把根钉住（before/after 才不会各探各的），
    // `--x/--y` 让"点上的元素 + 它 3 层祖先"也被读到。曾经这里是 if/else —— 只要根拿得到就
    // 不再下发坐标，于是 after 探针从 point 作用域静默退化成 hwnd 作用域，`scroll` 需要的那一类
    // 读数结构性消失（真机：`snapshot --x 1620 --y 480` 读到 scroll=1，而 `scroll --x 1620 --y 480
    // --dy -5` 的 after 探针全 0，靶侧日志却写着 v=48 → 96）。
    const storedRoot = args.hwnd !== undefined && args.hwnd !== '' ? String(args.hwnd) : String(state.contentRoot ?? '')
    const snapshotParams = { Command: 'snapshot' }
    if (storedRoot !== '') snapshotParams.Hwnd = storedRoot
    if (args.x !== undefined && args.y !== undefined) {
      snapshotParams.X = args.x
      snapshotParams.Y = args.y
    }
    applyContentSnapshot(state, probeBridge(snapshotParams, bridgeOpts(args)))
  }
  return { state, pixelNote }
}

/**
 * 内容探针这次处于什么状态：`ok`（跑过且没崩）/ `failed`（子进程崩了或没给出读数）/
 * `skipped`（给了 `--no-content`，压根没跑）。三态都得如实打：把 `skipped` 说成 `ok`，
 * 就是在暗示"内容这类判据这次有效"，而它其实根本没参与判定。
 */
function contentProbeState(args, ...states) {
  if (flagOn(args, 'no-content')) return 'skipped'
  return states.some((s) => s?.contentProbeFailed === true) ? 'failed' : 'ok'
}

/**
 * 内容读数**按类别**报出来（`value=0,scroll=2,...`）。光看总数会误导：`scroll` 要的是 scroll
 * 那一类，读到 3 条 Value 也证明不了"滚动位置被观测到了"（真机：`scroll` 报 false，而
 * GetScrollInfo 的独立读数证明滚了）。
 */
function kindsText(kinds) {
  const source = normalizeKinds(kinds)
  return Object.keys(source)
    .map((key) => `${key}=${source[key]}`)
    .join(',')
}

/** 注入后复核：打印 CHANGED / BEFORE / AFTER / VERDICT，并在 false/unknown 时给 WARN。 */
function reportVerification(args, before, after, extra = {}) {
  const ignore = Array.isArray(extra.ignore) ? extra.ignore : []
  const result = compareStates(before, after, { ignore })
  // 三态：true / false / unknown。没有差异、而且这次动作的效果本来就落在判据覆盖范围之外时，
  // 报 false 会让人以为动作失败了（真机就这么被误导过），所以那一路改成 unknown + WARN。
  // needsKinds 是**按命令**要求的内容类读数（例：`scroll` 必须有滚动位置读数，否则它的成功
  // 结构上就看不见 —— 真机 GetScrollInfo 证明滚了而 CHANGED 报 false）。
  const verdict = changeVerdict(result, {
    noPixel: flagOn(args, 'no-pixel'),
    needsKinds: neededKinds(extra.kind),
  })
  print(`CHANGED=${verdict.changed}`)
  print(`BEFORE=${result.digestBefore}`)
  print(`AFTER=${result.digestAfter}`)
  print(`VERDICT=${verdict.changed === 'true' ? 'changed' : verdict.changed === 'unknown' ? 'unknown' : 'no-observable-change'}`)
  if (ignore.length > 0) print(`IGNORED=${ignore.join(',')}`)
  const contentProbe = contentProbeState(args, before, after)
  // 内容探针这次是"读到了"还是"子进程崩了"：崩了就是缺测，CHANGED 会降级成 unknown。
  // --no-content 时它压根没跑，必须写 skipped —— 写 ok 会让人以为"内容类判据这次是有效的"。
  print(`CONTENT_PROBE=${contentProbe}`)
  // 内容类判据读到了几条：0 就意味着"文本框内容 / 滚动位置"这类效果这次是**看不见**的
  // （受限令牌下 UIA 跨完整性级别读会被拒，note 里给的是 Access is denied 这类原始原因）。
  print(`CONTENT_BEARING_COUNT=${result.after?.contentBearingCount ?? 0}`)
  // 探针这次的作用域（foreground / hwnd / point / point+hwnd，I7h）：带 --x/--y 的注入类命令
  // 必须是 point 那一类，否则"点上的元素 + 3 层祖先"根本没读，滚动位置那类读数结构性缺席。
  print(`CONTENT_SOURCE=${result.after?.contentSource || '-'}`)
  // 按类别报：`scroll` 这类命令要的是特定的一类读数，总数会误导。
  print(`CONTENT_KINDS=${kindsText(result.after?.contentKinds)}`)
  if (typeof after?.contentNote === 'string' && after.contentNote !== '') {
    print(`WARN=UIA 内容快照有读不到的项（${after.contentNote}）`)
  }
  // --no-content 是调用方主动关掉内容判据：这时 CHANGED=false 的覆盖面变小了，得说清。
  if (contentProbe === 'skipped') {
    print('WARN=内容类判据这次被 --no-content 关掉了：CHANGED=false 只覆盖像素/窗口/前台/落点，看不见「文本框里的字变了 / 列表滚了」这类效果')
  }
  if (result.changed) {
    print(`DETAIL=${result.reasons.join(' | ')}`)
  } else if (verdict.reason !== '') {
    print(`WARN=${verdict.reason}`)
  } else {
    const warn = injectionWarn(result, extra)
    if (warn) print(`WARN=${warn}`)
  }
  return { ...result, changed: verdict.changed, changeVerdict: verdict.changed, unknownReason: verdict.reason }
}

/** 注入类命令统一的"前态 → 动作 → 后态 → 复核"包装。 */
function withVerification(args, box, pixelRegion, action, extra = {}) {
  const { state: before, pixelNote: beforePixelNote } = captureState(args, box, pixelRegion)
  const actionResult = action()
  const settle = hasValue(args, 'settle') ? requireInt(args, 'settle', [0, 5000]) : 150
  if (settle > 0) sleep(settle)
  const { state: after, pixelNote: afterPixelNote } = captureState(args, box, pixelRegion)
  const pixelNote = afterPixelNote || beforePixelNote
  if (pixelNote) print(`WARN=${pixelNote}`)
  const verify = reportVerification(args, before, after, { ...extra, ...(actionResult?.extra ?? {}) })
  return { actionResult, verify, before, after }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 注入类命令开工前的闸门：目标窗口完整性级别高于自身就阻断（UIPI 预警）。 */
function injectionGate(args, target) {
  const decision = decideInjection({
    dryRun: flagOn(args, 'dry-run'),
    force: flagOn(args, 'force'),
    ours: target?.oursIntegrity,
    target: target?.window?.integrity,
  })
  print(`UIPI_CHECK=${decision.code}`)
  print(`INTEGRITY_OURS=${decision.ours}`)
  print(`INTEGRITY_TARGET=${decision.target}`)
  if (decision.action === 'block') {
    print(`WARN=${decision.reason}`)
    throw new UsageError(decision.reason)
  }
  if (flagOn(args, 'force') && decision.code === 'forced') print(`WARN=${decision.reason}`)
  return decision
}

// ---------------------------------------------------------------------------
// 各命令
// ---------------------------------------------------------------------------

function cmdProfile(args, platformProblem = null) {
  assertNoExtra(args, 'profile')
  const env = process.env
  const home = dshHome(env)
  const entry = installedEntry(env)
  const verdict = runtimeVerdict()
  // 非 Windows 上不去 spawn PowerShell 桥（必然失败），只报诊断。
  const report = platformProblem === null ? bridgeJson({ Command: 'profile' }, bridgeOpts(args)) : {}
  const screen = report.screen ?? {}

  print(`NODE=${process.version}`)
  print(`NODE_MAJOR=${nodeMajor() ?? 'unknown'}`)
  print(`NODE_OK=${verdict === null}`)
  if (verdict !== null) print(`WARN=${verdict}`)
  print(`PLATFORM=${process.platform}`)
  print(`WINDOWS_ONLY=${platformProblem === null}`)
  if (platformProblem !== null) print(`WARN=${platformProblem}`)
  print(`ARCH=${process.arch}`)
  print(`DSH_HOME=${home}`)
  print(`INSTALLED_ENTRY=${entry}`)
  print(`INSTALLED_EXISTS=${fs.existsSync(entry)}`)
  print(`REPO_ENTRY=${repoEntry(repoRoot)}`)
  print(`MODULE_ROOT=${MODULE_ROOT}`)
  print(`POWERSHELL=${report.powershell ?? 'unknown'}`)
  print(`POWERSHELL_VERSION=${report.powershellVersion ?? 'unknown'}`)
  print(`OS_VERSION=${report.osVersion ?? 'unknown'}`)
  print(`BRIDGE_INJECTED=${report.injected ?? 'unknown'}`)
  print(`DPI_AWARE=${report.dpiAware ?? 'unknown'}`)
  print(`SCREEN=${screen.width ?? '?'}x${screen.height ?? '?'}`)
  print(`VIRTUAL_ORIGIN=${screen.virtualLeft ?? '?'},${screen.virtualTop ?? '?'}`)
  print(`VIRTUAL_SIZE=${screen.virtualWidth ?? '?'}x${screen.virtualHeight ?? '?'}`)
  print(`MONITORS=${screen.monitorCount ?? '?'}`)
  print(`INTEGRITY_SELF=${normalizeIntegrity(report.ourIntegrity)}`)
  print(`UIA_AVAILABLE=${report.uiaAvailable === true}`)
  print(`SCREENSHOT_AVAILABLE=${report.screenshotAvailable === true}`)
  print(`ENTRY=${entry}`)
  printJson(args, {
    node: process.version,
    nodeMajor: nodeMajor(),
    nodeOk: verdict === null,
    platform: process.platform,
    windowsOnly: platformProblem === null,
    arch: process.arch,
    dshHome: home,
    installedEntry: entry,
    installedExists: fs.existsSync(entry),
    repoEntry: repoEntry(repoRoot),
    powershell: report.powershell,
    powershellVersion: report.powershellVersion,
    osVersion: report.osVersion,
    bridgeInjected: report.injected,
    dpiAware: report.dpiAware,
    screen: { width: screen.width, height: screen.height },
    virtualOrigin: { x: screen.virtualLeft, y: screen.virtualTop },
    virtualSize: { width: screen.virtualWidth, height: screen.virtualHeight },
    monitors: screen.monitorCount,
    integritySelf: normalizeIntegrity(report.ourIntegrity),
    uiaAvailable: report.uiaAvailable === true,
    screenshotAvailable: report.screenshotAvailable === true,
  })
  return 0
}

function cmdScreen(args) {
  assertNoExtra(args, 'screen')
  const out = optionalText(args, 'out')
  // `--out` 的父目录不存在算**用法错**（退出码 2），不算运行期错：这是调用方给的参数形状不对，
  // 而且不先说清就会被桥的异常包成 `ERROR=bridge 报错：… WriteAllBytes … Could not find a part
  // of the path` —— 读的人看不出"是我自己没建目录"。**故意不替调用方建目录**：本工具的职责是
  // 截屏，不是替人决定往哪个新目录树里写文件（要写就自己先建好，或换个已存在的目录）。
  if (out) {
    const dir = path.dirname(path.resolve(out))
    if (!fs.existsSync(dir)) {
      throw new UsageError(`--out 的父目录不存在：${dir}（先建好目录，或把 --out 指到已存在的目录下）`)
    }
  }
  // `--hash` 是契约的一部分（PIXEL_HASH= 那一行）：不给桥传 Hash，report.hash 永远是空的，
  // 于是那一行永远不会打印 —— 契约与实现就分家了。
  const report = bridgeJson(
    { Command: 'screen', Shot: out, Region: optionalText(args, 'region'), Hash: flagOn(args, 'hash') },
    bridgeOpts(args),
  )
  const box = screenBoxFrom(report)
  print(`SHOT=${report.shot ?? ''}`)
  print(`WIDTH=${report.width}`)
  print(`HEIGHT=${report.height}`)
  print(`ORIGIN=${report.left},${report.top}`)
  print(`DPR_AWARE=${report.dpiAware ?? 'unknown'}`)
  print(`CLAMPED=${report.clamped === true}`)
  print(`BYTES=${report.bytes ?? '?'}`)
  if (report.hash) print(`PIXEL_HASH=${report.hash}`)
  print(`VIRTUAL_ORIGIN=${box.originX},${box.originY}`)
  print(`VIRTUAL_SIZE=${box.width}x${box.height}`)
  if (out) print(`SHOT_EXISTS=${fs.existsSync(out)}`)
  printJson(args, {
    shot: report.shot ?? '',
    width: report.width,
    height: report.height,
    origin: { x: report.left, y: report.top },
    clamped: report.clamped === true,
    bytes: report.bytes,
    pixelHash: report.hash ?? '',
  })
  return 0
}

function cmdWindows(args) {
  assertNoExtra(args, 'windows')
  const report = bridgeJson({ Command: 'windows' }, bridgeOpts(args))
  const list = Array.isArray(report.windows) ? report.windows : []
  list.forEach((item, index) => {
    print(
      `WIN ${index} | ${item.hwnd} | ${item.pid} | ${item.process} | ${item.class} | ${item.title} | ` +
        `${item.left},${item.top},${item.width},${item.height} | ${normalizeIntegrity(item.integrity)}`,
    )
  })
  print(`COUNT=${list.length}`)
  print(`FOREGROUND=${report.foreground ?? '-'}`)
  print(`FOREGROUND_TITLE=${report.foregroundTitle ?? ''}`)
  print(`INTEGRITY_SELF=${normalizeIntegrity(report.ourIntegrity)}`)
  print(`DPI_AWARE=${report.dpiAware ?? 'unknown'}`)
  printJson(args, {
    count: list.length,
    windows: list,
    foreground: report.foreground,
    foregroundTitle: report.foregroundTitle,
    integritySelf: normalizeIntegrity(report.ourIntegrity),
  })
  return 0
}

function cmdUia(args) {
  assertNoExtra(args, 'uia')
  const depth = hasValue(args, 'depth') ? requireInt(args, 'depth', [0, 64]) : 8
  const limit = hasValue(args, 'limit') ? requireInt(args, 'limit', [1, 20000]) : 3000
  const wantId = optionalText(args, 'id')
  if (wantId !== undefined && !isElementId(wantId)) {
    throw new UsageError(`--id 的形状不对：${wantId}（应是 el_ 加 8 位十六进制，取自 uia 的输出）`)
  }
  const report = bridgeJson(
    { Command: 'uia', Hwnd: optionalText(args, 'hwnd'), Depth: depth, Name: optionalText(args, 'name'), Limit: limit, ElId: wantId },
    bridgeOpts(args),
  )
  const elements = Array.isArray(report.elements) ? report.elements : []
  const shown = elements.slice(0, limit)
  if (wantId !== undefined && report.found !== true) {
    print(`FOUND=false`)
    print(`WARN=快照里没有 ${wantId}（元素可能已消失，或层级被 --depth 截断）`)
  } else {
    print(`FOUND=${wantId === undefined ? '-' : 'true'}`)
  }
  for (const element of shown) {
    print(
      `${treePrefix(element.level)}EL | ${element.id} | ${element.controlType || '-'} | ${patternsText(element.patterns)} | ` +
        `${rectText(element.rect)} | ${element.automationId || '-'} | ${element.name || ''}`,
    )
  }
  print(`COUNT=${elements.length}`)
  print(`SHOWN=${shown.length}`)
  // 形状自检：整棵树里只要有一个元素的 patterns 是坏形状就报一行。`patternList()` 会把坏形状
  // 变成空列表（与"真的没有 pattern"同形），所以这一行是缺陷指纹 —— 它出现就说明桥侧的包装
  // 又叠了一层，而不是"这些元素不支持语义操作"。
  const badShapes = shown.filter((element) => patternShapeProblem(element.patterns) !== null)
  if (badShapes.length > 0) {
    print(`WARN=${badShapes.length} 个元素的 patterns 形状异常（首例 ${badShapes[0].id}）：${patternShapeProblem(badShapes[0].patterns)}`)
  }
  print(`DEPTH=${report.depth ?? depth}`)
  print(`TRUNCATED=${report.truncated === true}`)
  print(`ROOT=${report.rootName ?? ''}`)
  // 几何自洽标记：`--hwnd` 时把窗口的 Win32 矩形与 UIA 根元素矩形并排打出来。真机实测，
  // 窗口最大化时这两套读数可以互相矛盾，而按 uia 那组算出来的坐标会点空（design.md I2b）。
  if (report.geo) {
    // 这一路没有查询点（`uia` 只看树、不点任何地方）⇒ 落点那条读数**不适用**，不是缺测，
    // 所以传 `requirePoint: false`：只验窗口矩形与 UIA 根元素矩形，并说明这次没查落点。
    const geo = geoVerdict(report.geo, { requirePoint: false })
    print(`GEO_WINDOW_RECT=${report.geo.winRect || '-'}`)
    print(`GEO_UIA_ROOT_RECT=${report.geo.uiaRootRect || '-'}`)
    print(`GEO_MISMATCH=${geo.mismatch}`)
    if (geo.mismatch === 'true') {
      print(
        `WARN=几何读数互相矛盾（GEO_MISMATCH=true）：${geo.reasons.join('；')}。` +
          '按这组 uia 矩形换算出来的坐标可能打空，请改用 windows 报的窗口矩形，或先复位窗口。',
      )
    } else if (geo.mismatch === 'unknown') {
      print(`WARN=几何自洽检查这次没有足够读数（${geo.reasons.join('；')}）—— 不能当成"几何一致"`)
    }
  }
  if (report.truncated === true) {
    // 截断必须明说：`COUNT` 是"走到的元素数"，不是"桌面上的元素数"。
    // 一个 id 在截断的快照里找不到，不等于它不存在 —— 这是真机踩过 11/11 的坑。
    print(
      `WARN=快照被截断（truncated=true，走到预算 ${report.budget ?? limit} 就停了）：COUNT 是"走到的元素数"，` +
        `不是桌面上的元素总数。要取某个窗口里的元素 id，请加 --hwnd <0x..> 限定作用域；` +
        `id 与作用域绑定，截断的快照里找不到 ≠ 元素不存在。`,
    )
  }
  printJson(args, {
    count: elements.length,
    shown: shown.length,
    depth: report.depth ?? depth,
    truncated: report.truncated === true,
    found: report.found === true,
    geo: report.geo ?? null,
    elements: shown,
  })
  return 0
}

function cmdPoint(args) {
  assertNoExtra(args, 'point')
  const point = requirePoint(args)
  const report = bridgeJson({ Command: 'point', X: point.x, Y: point.y }, bridgeOpts(args))
  const box = screenBoxFrom(report)
  print(`X=${report.x}`)
  print(`Y=${report.y}`)
  print(`INSIDE_VIRTUAL=${report.insideVirtualScreen === true}`)
  print(`INSIDE_CHECK=${insideScreen(point, box)}`)
  print(`HWND=${report.hwnd ?? ''}`)
  print(`ROOT_HWND=${report.rootHwnd ?? ''}`)
  print(`PID=${report.window?.pid ?? ''}`)
  print(`PROCESS=${report.window?.process ?? ''}`)
  print(`CLASS=${report.window?.class ?? ''}`)
  print(`TITLE=${report.window?.title ?? ''}`)
  print(`RECT=${report.window ? `${report.window.left},${report.window.top},${report.window.width},${report.window.height}` : '-'}`)
  print(`INTEGRITY_TARGET=${normalizeIntegrity(report.window?.integrity)}`)
  print(`INTEGRITY_SELF=${normalizeIntegrity(report.ourIntegrity)}`)
  print(`ELEMENT_ID=${report.element?.id ?? ''}`)
  print(`ELEMENT_TYPE=${report.element?.controlType ?? ''}`)
  print(`ELEMENT_NAME=${report.element?.name ?? ''}`)
  print(`ELEMENT_PATTERNS=${patternsText(report.element?.patterns)}`)
  // 形状自检（同 uia / invoke）：坏形状会被 patternList 变成空列表，这里显式报出来
  const pointShapeProblem = patternShapeProblem(report.element?.patterns)
  if (pointShapeProblem !== null) print(`WARN=patterns 形状异常：${pointShapeProblem}`)
  // 几何自洽标记（design.md I2b）：这个点上的 UIA 元素，自己声明的矩形是否包含这个点？
  // 真机实测：窗口最大化时 uia 给的矩形与物理坐标不在同一坐标系，按它换算的坐标会打空。
  const geo = geoVerdict(report.geo)
  print(`GEO_WINDOW_RECT=${report.geo?.winRect ?? '-'}`)
  print(`GEO_UIA_ROOT_RECT=${report.geo?.uiaRootRect ?? '-'}`)
  print(`GEO_POINT_RECT=${report.geo?.pointRect ?? '-'}`)
  print(`GEO_MISMATCH=${geo.mismatch}`)
  if (geo.mismatch === 'true') {
    print(
      `WARN=几何读数互相矛盾（GEO_MISMATCH=true）：${geo.reasons.join('；')}。` +
        '这个坐标不是从 uia 矩形推出来的就没关系；如果是，请改用 windows 报的窗口矩形换算。',
    )
  } else if (geo.mismatch === 'unknown') {
    print(`WARN=几何自洽检查这次没有足够读数（${geo.reasons.join('；')}）—— 不能当成"几何一致"`)
  }
  printJson(args, {
    x: report.x,
    y: report.y,
    hwnd: report.hwnd,
    rootHwnd: report.rootHwnd,
    window: report.window,
    element: report.element,
    geo: report.geo ?? null,
    integritySelf: normalizeIntegrity(report.ourIntegrity),
  })
  return 0
}

/** click / move / type / key / scroll 走同一条：先看目标、过闸门、发事件、复核。 */
function cmdInject(args, kind) {
  assertNoExtra(args, kind === 'move' ? 'move' : kind)
  const dryRun = flagOn(args, 'dry-run')
  const pixelRegionSize = 96
  let point
  let params
  let keyboardHwnd = ''
  if (kind === 'type') {
    const text = requireText(args, 'text')
    keyboardHwnd = requireKeyboardHwnd(args)
    params = { Command: 'input', Text: text, Hwnd: keyboardHwnd }
  } else if (kind === 'key') {
    const keys = requireText(args, 'keys')
    keyboardHwnd = requireKeyboardHwnd(args)
    params = { Command: 'input', Keys: keys, Hwnd: keyboardHwnd }
  } else {
    point = requirePoint(args)
    if (kind === 'move') {
      params = { Command: 'input', X: point.x, Y: point.y, MoveOnly: true }
    } else if (kind === 'scroll') {
      const dy = requireInt(args, 'dy', [-100, 100])
      if (dy === 0) throw new UsageError('--dy 不能是 0（正=向上滚，负=向下滚）')
      params = { Command: 'input', X: point.x, Y: point.y, WheelDelta: dy }
    } else {
      const button = requireButton(args)
      const clicks = hasValue(args, 'clicks') ? requireInt(args, 'clicks', [1, 10]) : undefined
      params = {
        Command: 'input',
        X: point.x,
        Y: point.y,
        Button: button,
        Double: flagOn(args, 'double'),
        Clicks: clicks,
      }
    }
  }

  const box = screenBoxFrom(bridgeJson({ Command: 'profile' }, bridgeOpts(args)))

  // 目标窗口与闸门：坐标类命令先问"这个点上是哪个窗口"，键类命令问"前台窗口是不是够得着"。
  // TARGET_SOURCE 必须打出来：`point`（这个点上的窗口）/ `foreground`（前台窗口）/
  // `--target-hwnd`（调用方显式指名）—— 三者的"目标"含义完全不同，不写清就会被读混。
  const explicitTargetHwnd = hasValue(args, 'target-hwnd') ? normalizeHwnd(args['target-hwnd']) : ''
  let gateTarget
  let targetSource
  let explicitTarget = null
  // 注入**前**的落点读数（`landingPreflight` 的输入）。事后那行 `LANDING_IN_TARGET=` 是发完
  // 事件才算的，拦不住"事件已经送进别人窗口"这件事，所以两处都要：
  //   - 这里（probe.window / probe.rootHwnd）⇒ 注入**前**的闸门，false 默认拒发；
  //   - `landingNote(after, …)`           ⇒ 注入**后**的如实记录，仍然要读（两次判定之间还有竞态）。
  let landingReading = null
  if (point) {
    const probe = bridgeJson({ Command: 'point', X: point.x, Y: point.y }, bridgeOpts(args))
    landingReading = {
      hwnd: probe.window?.hwnd ?? '',
      rootHwnd: probe.rootHwnd ?? probe.window?.rootHwnd ?? '',
    }
    gateTarget = { window: probe.window, oursIntegrity: probe.ourIntegrity }
    targetSource = 'point'
    print(`TARGET=${probe.window?.hwnd ?? ''}`)
    print(`TARGET_PROCESS=${probe.window?.process ?? ''}`)
    print(`TARGET_TITLE=${probe.window?.title ?? ''}`)
    print(`INSIDE_VIRTUAL=${probe.insideVirtualScreen === true}`)
    // 几何自洽检查（design.md I2b）：窗口最大化时 `windows` 的矩形与 `uia` 的子元素矩形可能
    // 根本不在同一个坐标系里，照 uia 那组算出来的坐标会点空。两套读数不互相印证就不许按它点下去。
    const geo = geoVerdict(probe.geo)
    print(`GEO_WINDOW_RECT=${probe.geo?.winRect ?? '-'}`)
    print(`GEO_UIA_ROOT_RECT=${probe.geo?.uiaRootRect ?? '-'}`)
    print(`GEO_POINT_RECT=${probe.geo?.pointRect ?? '-'}`)
    print(`GEO_MISMATCH=${geo.mismatch}`)
    if (geo.mismatch === 'true') {
      const why =
        `几何读数互相矛盾（GEO_MISMATCH=true）：${geo.reasons.join('；')}。` +
        '按可疑坐标点下去只会打空，而且什么也证明不了 —— 请用 windows 的窗口矩形换算坐标、' +
        '或先复位/还原窗口再取一次 uia 矩形；确实要照原样点，加 --force。'
      if (!flagOn(args, 'force')) throw new UsageError(why)
      print(`WARN=${why}`)
    } else if (geo.mismatch === 'unknown') {
      print(`WARN=几何自洽检查这次没有足够读数（${geo.reasons.join('；')}）—— 不能当成"几何一致"`)
    }
  } else {
    // 键盘命令：目标就是调用方显式给的收键窗口（`requireKeyboardHwnd` 已经保证它非空）。
    // 这里**不留**"当时的前台窗口"这条隐式路径 —— 那就是真机那次"字符进了别的窗口"的来源。
    const windows = bridgeJson({ Command: 'windows' }, bridgeOpts(args))
    const record = (windows.windows ?? []).find(
      (item) => item.hwnd === keyboardHwnd || item.rootHwnd === keyboardHwnd,
    )
    gateTarget = { window: record ?? { hwnd: keyboardHwnd }, oursIntegrity: windows.ourIntegrity }
    targetSource = '--hwnd'
    print(`TARGET=${keyboardHwnd}`)
    print(`TARGET_PROCESS=${record?.process ?? ''}`)
    print(`TARGET_TITLE=${record?.title ?? ''}`)
    print(`TARGET_ROOT_HWND=${record?.rootHwnd ?? keyboardHwnd}`)
    print(`TARGET_IN_WINDOW_LIST=${record !== undefined}`)
    print(`TARGET_INTEGRITY=${normalizeIntegrity(record?.integrity)}`)
    if (record === undefined) {
      print(
        `WARN=--hwnd ${keyboardHwnd} 不在 windows 列表里：收键窗口的进程与完整性级别这次读不到，` +
          'UIPI 闸门按"读不到"处理（默认阻断，除非 --force）。若这是个子控件句柄，请改传它所属的顶层窗口' +
          '—— SetForegroundWindow 只对顶层窗口有效，前台闸门也会因此过不去。',
      )
    }
  }
  if (explicitTargetHwnd !== '') {
    // 显式目标：只为"落点归属"断言用。用 windows 列表把它的 ROOT_HWND 也解析出来，
    // 这样"点在子控件上"不会被误判成"点错了窗口"。
    const windows = bridgeJson({ Command: 'windows' }, bridgeOpts(args))
    const record = (windows.windows ?? []).find(
      (item) => item.hwnd === explicitTargetHwnd || item.rootHwnd === explicitTargetHwnd,
    )
    explicitTarget = {
      hwnd: explicitTargetHwnd,
      rootHwnd: record?.rootHwnd ?? explicitTargetHwnd,
      title: record?.title ?? '',
      integrity: record?.integrity,
    }
    targetSource = '--target-hwnd'
    print(`TARGET_HWND=${explicitTarget.hwnd}`)
    print(`TARGET_ROOT_HWND=${explicitTarget.rootHwnd}`)
    print(`TARGET_IN_WINDOW_LIST=${record !== undefined}`)
    print(`TARGET_INTEGRITY=${normalizeIntegrity(explicitTarget.integrity)}`)
  }
  // 注入**前**的落点闸门（design.md I7g / 红线 15）：显式给了 --target-hwnd 时，坐标上现在压着的
  // 窗口必须先和它对上。三态口径与几何闸门（红线 14）**完全同款**：false ⇒ 默认拒发（--force 才
  // 硬发并保留 WARN）、unknown ⇒ 只 WARN、true ⇒ 放行。只为"事后的 LANDING_IN_TARGET="证明不了
  // 事件没落到别人窗口里 —— 真机上给错目标照样 INSERTED_EVENTS=5 把点击发了出去（本项目更早有
  // 约 40 次单击落到用户终端上的记录）。
  if (point && explicitTarget !== null) {
    const preflight = landingPreflight(landingReading, explicitTarget)
    print(`LANDING_PREFLIGHT=${preflight.verdict}`)
    if (preflight.verdict === 'false') {
      const why =
        `落点像素上的窗口不是目标窗口（期望 ${preflight.want}，实际 ${preflight.actual}）：${preflight.reason}。` +
        '这次不发事件 —— 注入会落到别的窗口上（用户窗口几乎盖满屏幕，这不是理论风险）。' +
        '要照原样点，加 --force；要先确认落点，跑 point --x <px> --y <py>。'
      if (!flagOn(args, 'force')) throw new UsageError(why)
      print(`WARN=${why}`)
    } else if (preflight.verdict === 'unknown') {
      print(`WARN=落点归属这次判不了（${preflight.reason}）—— 不能当成"点对了目标"`)
    }
  }
  print(`TARGET_SOURCE=${targetSource}`)

  const decision = injectionGate(args, gateTarget)
  if (dryRun) {
    print(`DRY_RUN=true`)
    print(`KIND=${kind}`)
    // plan 与"真跑"同源：这里不再在 JS 里重算一遍事件数（那正是"dry-run 报 5 个事件、
    // 真跑只发 3 个"的来源），而是让桥用 -PlanOnly 走**同一条构造路径**。
    // -PlanOnly 只构造不发送：不调 SendInput、不 SetForegroundWindow、不 Raise-Window。
    const planReport = bridgeJson({ ...params, PlanOnly: true }, bridgeOpts(args))
    const plan = planReport.plan ?? {}
    print(`PLAN_ONLY=true`)
    print(`PLAN_KIND=${plan.kind ?? ''}`)
    print(`EXPECTED_EVENTS=${planReport.expected ?? '?'}`)
    if (point) {
      print(`WILL_SEND_ABSOLUTE=${plan.absolute?.x ?? point.x},${plan.absolute?.y ?? point.y}`)
      print(`WILL_SEND_NORMALIZED=${plan.normalized?.dx ?? '?'},${plan.normalized?.dy ?? '?'}`)
      print(`VIRTUAL_ORIGIN=${plan.normalized?.virtualLeft ?? box.originX},${plan.normalized?.virtualTop ?? box.originY}`)
      print(`VIRTUAL_SIZE=${plan.normalized?.virtualWidth ?? box.width}x${plan.normalized?.virtualHeight ?? box.height}`)
    }
    if (plan.button !== undefined) print(`BUTTON=${plan.button}`)
    if (plan.double !== undefined) print(`DOUBLE=${plan.double}`)
    if (plan.clicks !== undefined) print(`CLICKS=${plan.clicks}`)
    if (plan.wheel) {
      print(`WHEEL_CLICKS=${plan.wheel.clicks}`)
      print(`WHEEL_DW_DATA=${plan.wheel.dwData}`)
    }
    if (plan.characters !== undefined) print(`CHARACTERS=${plan.characters}`)
    if (plan.steps !== undefined) print(`KEYS=${(plan.steps ?? []).join('+')}`)
    // 逐键把"这一键到底怎么发"打出来。`KEYS=ctrl+a` 只回显用户怎么拼的，看不出 vk/字符之差：
    // 真机上 `key --keys ctrl+a` 曾报 `INSERTED_EVENTS=4 EVENTS_MATCH_PLAN=true`，而靶侧只多了
    // 一个字符（Ctrl 被绕过）—— 计划里没有一处能暴露它。PATH=virtual|unicode、FLAGS=4 是
    // KEYEVENTF_UNICODE（组合键里出现它就是缺陷）、VK/SCAN 是实际要填进结构体的两个字段。
    // PHASE 是**发射顺序**：修饰键必须真的被按住（`modifier-down … key-down key-up … modifier-up`），
    // 而不是被逐键点一下（`modifier-down modifier-up key-down key-up`）。后者事件数同样是 4、
    // EVENTS_MATCH_PLAN 同样为真，只有顺序能区分 —— 真机上 `ctrl+a` 就是这么变成一个裸 `a` 的。
    for (const [index, keyEvent] of (plan.keys ?? []).entries()) {
      print(
        `PLAN_KEY ${index} | ${keyEvent.name ?? ''} | PHASE=${keyEvent.phase ?? ''} | PATH=${keyEvent.path ?? ''} | ` +
          `VK=${keyEvent.vk ?? ''} | SCAN=${keyEvent.scan ?? ''} | FLAGS=${keyEvent.flags ?? ''}`,
      )
    }
    // 键盘命令的收键窗口必须能从**计划**里读出来（design.md I10b/I7i）：桥用一个变量决定
    // "键发给谁"，plan 与真跑同源；这两行就是"CLI 有没有把 --hwnd 传下去"的判据 ——
    // 漏传时它会显示 foreground（真出过：CLI 根本没把 Hwnd 放进 params，整条前台闸门到不了）。
    if (plan.focusSource !== undefined) print(`PLAN_FOCUS_SOURCE=${plan.focusSource}`)
    if (plan.focusTarget !== undefined) print(`PLAN_HWND=${plan.focusTarget}`)
    print(`UIPI_DECISION=${decision.code}`)
    // 落点归属要真发事件后才评估，所以这里只把"这次用的是哪个目标"回显出来，让
    // --target-hwnd 的解析不用发事件就能验；值给 not-evaluated，不给会让人读成"点对了"的布尔。
    if (explicitTarget !== null) {
      print(`LANDING_TARGET_HWND=${explicitTarget.hwnd}`)
      print(`LANDING_TARGET_ROOT_HWND=${explicitTarget.rootHwnd}`)
    }
    print(`LANDING_IN_TARGET=not-evaluated`)
    print(`CHANGED=false`)
    print(`WARN=--dry-run：没有发送任何事件，所以 CHANGED 恒为 false（这不是失败）`)
    printJson(args, { dryRun: true, planOnly: true, kind, point, plan, expected: planReport.expected, uipi: decision.code, changed: false })
    return 0
  }

  const pixelRegion = point
    ? `${point.x - Math.floor(pixelRegionSize / 2)},${point.y - Math.floor(pixelRegionSize / 2)},${pixelRegionSize},${pixelRegionSize}`
    : undefined
  const region = pixelRegion ? clampRegion(parseRegion(pixelRegion), box) : undefined
  const regionText = region ? `${region.left},${region.top},${region.width},${region.height}` : undefined

  const { actionResult, verify, after } = withVerification(
    args,
    box,
    regionText,
    () => bridgeJson({ ...params, Raise: flagOn(args, 'raise') }, bridgeOpts(args)),
    {
      hint: `命令=${kind}`,
      kind,
      // P0-C：落点探针（point / pointRect）随光标移动而变，与"目标有没有收到事件"无关。
      // 把它算进差异集合，注入失败也会报 CHANGED=true —— 实测出现过这种假成功。
      // 所以它不进 CHANGED，改成下面独立的"落点归属"断言。
      ignore: point ? ['point'] : [],
    },
  )
  const report = actionResult
  print(`KIND=${report.plan?.kind ?? kind}`)
  print(`EXPECTED_EVENTS=${report.expected ?? '?'}`)
  print(`INSERTED_EVENTS=${report.inserted ?? '?'}`)
  // plan 与实际必须同源：真跑发出的条数等于（PlanOnly 会给出的）期望条数。不等就说明
  // "报了一组、发的是另一组"——`--double` 的真机缺陷正是这样（报 5 个、发 3 个）。
  const eventsMatchPlan =
    typeof report.expected === 'number' && typeof report.inserted === 'number'
      ? report.inserted === report.expected
      : null
  print(`EVENTS_MATCH_PLAN=${eventsMatchPlan === null ? 'unknown' : eventsMatchPlan}`)
  if (eventsMatchPlan === false) {
    print(
      `WARN=实际发出的事件数（${report.inserted}）与 plan 的期望值（${report.expected}）不一致；` +
        `注入可能被系统截断，别把这次动作当成完整执行`,
    )
  }
  print(`LAST_ERROR=${report.lastError ?? '?'}`)
  print(`INPUT_STRUCT_SIZE=${report.inputStructSize ?? '?'}`)
  let landing = null
  if (point) {
    print(`WILL_SEND_ABSOLUTE=${point.x},${point.y}`)
    print(`WILL_SEND_NORMALIZED=${report.plan?.normalized?.dx ?? '?'},${report.plan?.normalized?.dy ?? '?'}`)
    // 硬件级回读：SendInput 的返回值证明不了指针真的到了那里。
    print(`CURSOR_BEFORE=${report.cursorBefore ? `${report.cursorBefore.x},${report.cursorBefore.y}` : '?'}`)
    print(`CURSOR_AFTER=${report.cursorAfter ? `${report.cursorAfter.x},${report.cursorAfter.y}` : '?'}`)
    print(`CURSOR_LANDED=${report.cursorLanded === true}`)
    // 第二类判据：指针落在**谁**身上（比 ROOT_HWND，不比叶子窗口）。
    // 没有显式 --target-hwnd 时**不许**把"落点上的窗口"当成目标 —— 那是个同义反复，
    // 真机实测：故意点隔壁窗口的按钮，`在目标内=true` 照样成立（design.md I7g）。
    const landingTarget = explicitTarget !== null ? explicitTarget : gateTarget.window
    landing = landingNote(after, landingTarget, point, { explicitTarget: explicitTarget !== null })
    print(`LANDING=${landing.note}`)
    print(`LANDING_SAME_WINDOW=${landing.sameWindow === null ? '-' : landing.sameWindow}`)
    print(`LANDING_IN_TARGET=${landing.inTarget === null ? 'unknown' : landing.inTarget}`)
    if (landing.inTarget === null) {
      print(
        'WARN=没有显式目标（未给 --target-hwnd）：LANDING_SAME_WINDOW 只说明"落点像素上还是同一个窗口"，' +
          '不能当作"点进了我想要的窗口"的证据 —— 要断言目标请显式给 --target-hwnd <0x..>。',
      )
    }
    if (report.cursorReadbackOk === false) print(`WARN=GetCursorPos 读不回来，落点未经硬件回读确认`)
    else if (report.cursorLanded !== true) print(`WARN=指针没有落在请求的像素上（要求 ${point.x},${point.y}，实际 ${report.cursorAfter?.x},${report.cursorAfter?.y}）`)
  }
  if (report.raise) {
    print(`RAISED=${report.raise.raised === true}`)
    print(`RAISE_TARGET=${report.raise.target ?? ''}`)
    if (report.raise.raised !== true) print(`WARN=SetWindowPos 抬升失败，目标窗口可能仍被别的窗口盖住`)
  }
  if (report.raiseNote) {
    // 桥回的是**带原因的英文标记**（脚本必须 ASCII-only，见 bridge.ps1:1434 的 `raise-ignored-no-target`）。
    // 早先这里只打 `RAISE_NOTE` 那句中文常量、把桥的文本整个丢掉 —— 于是"为什么没抬起"这个信息
    // 在输出里根本不存在。现在：桥给了文本就**原样打出来**（它更具体），已知标记再补一句中文解释；
    // 桥没给文本时才回退到中文常量。组装逻辑在 `lib/verify.mjs` 的 `raiseNoteText`（有单测）。
    print(`WARN=${raiseNoteText(report.raiseNote, RAISE_NOTE)}`)
  }
  if (report.focus) {
    print(`FOCUS_SOURCE=${report.focus.source ?? '-'}`)
    print(`FOCUS_TARGET=${report.focus.target ?? ''}`)
    print(`FOCUS_BEFORE=${report.focus.foregroundBefore ?? ''}`)
    print(`FOCUS_AFTER=${report.focus.foregroundAfter ?? ''}`)
    print(`FOCUS_ALREADY=${report.focus.alreadyForeground === true}`)
    print(`FOCUS_OK=${report.focus.ok === true}`)
  }
  if (report.plan?.clicks) print(`CLICKS=${report.plan.clicks}`)
  if (report.plan?.characters) print(`CHARACTERS=${report.plan.characters}`)
  if (report.plan?.wheel) print(`WHEEL_DW_DATA=${report.plan.wheel.dwData}`)
  print(`CHANGED=${verify.changed}`)
  printJson(args, {
    kind: report.plan?.kind ?? kind,
    expected: report.expected,
    inserted: report.inserted,
    lastError: report.lastError,
    inputStructSize: report.inputStructSize,
    cursorAfter: report.cursorAfter,
    cursorLanded: report.cursorLanded === true,
    landing: landing ? landing.note : '',
    landingInTarget: landing ? landing.inTarget : null,
    landingSameWindow: landing ? landing.sameWindow : null,
    landingTargetExplicit: explicitTarget !== null,
    targetSource,
    target: explicitTarget ?? gateTarget.window ?? null,
    raised: report.raise ? report.raise.raised === true : null,
    focus: report.focus ?? null,
    changed: verify.changed,
    before: verify.digestBefore,
    after: verify.digestAfter,
    reason: verify.reasons,
  })
  return 0
}

function parseRegion(text) {
  const parts = String(text).split(',').map((chunk) => chunk.trim())
  if (parts.length !== 4) throw new UsageError(`区域要写成 left,top,width,height：${text}`)
  const [left, top, width, height] = parts.map((chunk) => Number.parseInt(chunk, 10))
  return { left, top, width, height }
}

function cmdInvoke(args) {
  assertNoExtra(args, 'invoke')
  const wantId = requireText(args, 'id')
  if (!isElementId(wantId)) {
    throw new UsageError(`--id 的形状不对：${wantId}（应是 el_ 加 8 位十六进制，取自 uia 的输出）`)
  }
  const setValue = optionalText(args, 'set-value')
  const depth = hasValue(args, 'depth') ? requireInt(args, 'depth', [0, 64]) : 16
  const limit = hasValue(args, 'limit') ? requireInt(args, 'limit', [1, 20000]) : 3000
  const hwnd = optionalText(args, 'hwnd')
  const name = optionalText(args, 'name')
  // 占位 id 不许在**未限定窗口**时用来动手（design.md I6e）：`el_unknown` 是 `GetRuntimeId()` 读不到时
  // 整类元素折叠出来的同一个字符串，它不唯一、也没有 runtimeId 可复核。真机后果是：一份快照里
  // 恰好一个 `el_unknown` 就能过"命中数"闸门，而桥的第二遍遍历取的是**第一个** `el_unknown` ——
  // 不需要任何竞态，也不需要是同一个元素；不给 `--hwnd` 时甚至可以不在同一个窗口。
  if (isPlaceholderElementId(wantId) && (hwnd === undefined || hwnd === '')) {
    throw new UsageError(
      `el_unknown 是 runtimeId 读不到时的占位 id，**不代表某个具体元素**（凡是 GetRuntimeId() 失败的元素` +
        `都折叠成这一个值），所以它不唯一、也没有身份可复核 —— 必须限定窗口后才能用它动手：` +
        `加 --hwnd <0x..>（并从 windows / point 的输出里取句柄），让这次遍历只在一个窗口里找。`,
    )
  }
  // 作用域必须显式报到输出里：元素 id 是 UIA runtime id 的哈希，**与取它的那次快照的作用域绑定**。
  // 真机缺陷：在桌面根上取到的 id，紧接着 invoke 时因为根遍历在 3000 个元素处被截断而找不到它 ——
  // 11/11 全失败，而同一秒用 --hwnd 限定的快照仍列着那个元素。
  print(`SNAPSHOT_SCOPE=${snapshotScopeText({ hwnd, name, depth, limit })}`)
  const snapshot = bridgeJson(
    { Command: 'uia', Hwnd: hwnd, Name: name, Depth: depth, Limit: limit, ElId: wantId },
    bridgeOpts(args),
  )
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : []
  const snapshotTruncated = snapshot.truncated === true
  const snapshotBudget = snapshot.budget ?? limit
  print(`SNAPSHOT_COUNT=${snapshot.count ?? elements.length}`)
  print(`SNAPSHOT_BUDGET=${snapshotBudget}`)
  print(`SNAPSHOT_TRUNCATED=${snapshotTruncated}`)
  const picked = pickElement(elements, { id: wantId })
  if (picked.element === null) {
    print(`FOUND=false`)
    if (snapshotTruncated) {
      // 「快照里没有」与「元素不存在」是两句不同的话。把截断说成消失，会把读者引向错误结论。
      throw new UsageError(
        `invoke 定位失败：快照被截断（truncated=true，走到预算 ${snapshotBudget} 就停了）——` +
          `所以「快照里没有 ${wantId}」≠「这个元素不存在」。请加 --hwnd <0x..>（推荐）把作用域限定到目标窗口，` +
          `再用**同一作用域**重新取一次 id；id 是 UIA runtime id 的哈希，跨作用域不保证命中。底层原因：${picked.reason}`,
      )
    }
    throw new UsageError(
      `invoke 定位失败：${picked.reason}。id 与作用域绑定 —— 取 id 的那次 uia 与被 invoke 的这次必须是同一个作用域` +
        `（同样的 --hwnd / --name / --depth / --limit）；换了作用域就重新取一次 id。`,
    )
  }
  const element = picked.element
  print(`FOUND=true`)
  print(`ELEMENT_ID=${element.id}`)
  print(`ELEMENT_TYPE=${element.controlType || '-'}`)
  print(`ELEMENT_NAME=${element.name || ''}`)
  print(`ELEMENT_RECT=${rectText(element.rect)}`)
  print(`ELEMENT_PATTERNS=${patternsText(element.patterns)}`)
  // 形状自检：`patternList()` 的防回退分支会把"数组里还嵌着数组"变成空列表，而空列表与
  // "这个元素确实不支持任何 pattern"同形 ⇒ 桥侧的包装缺陷会伪装成正常结果。这里显式报一行，
  // 让缺陷自己冒出来（这条 WARN 是缺陷指纹，不是提示）。
  const shapeProblem = patternShapeProblem(element.patterns)
  if (shapeProblem !== null) print(`WARN=patterns 形状异常：${shapeProblem}`)
  // 元素身份（design.md I6f）：定位快照里这个元素的 runtimeId 随落地调用一起下发，桥在第二遍
  // 遍历命中该 id 时逐字符复核 —— 不一致就**不执行任何动作**。没有它的话，"数命中数"用的是
  // 第一遍那份快照，而动手发生在第二遍，两者之间唯一传过去的东西是 id 这个**哈希**（不是身份）。
  const identity = elementIdentity(element)
  print(`ELEMENT_RUNTIME_ID=${identity.runtimeId ?? ''}`)
  if (identity.state === 'absent') {
    // 缺口要显式可见，不许静默：这类元素（占位 id 就是它）根本没有身份可下发，
    // 于是桥只能按 id 匹配 —— 同一个 id 在第二遍遍历里落到别的元素上时，这次没有任何东西能发现。
    print(
      'WARN=这次没有身份复核：定位快照没给出这个元素的 runtimeId（GetRuntimeId() 读不到的元素会被折叠成 el_unknown）' +
        ' —— 桥只能按 id 匹配，第二遍遍历里的同名命中未必是同一个元素；要收窄这个缺口就把作用域限定到目标窗口（--hwnd）并当场复核',
    )
  }
  const choice = chooseAction(element, setValue === undefined ? {} : { setValue })
  if (choice.error) {
    if (!flagOn(args, 'fallback-point')) {
      print(`WARN=${choice.error}`)
      throw new UsageError(choice.error)
    }
    const rect = element.rect
    if (!rect) {
      throw new UsageError(`${choice.error}；而且这个元素没有矩形，--fallback-point 也无处可点`)
    }
    const target = {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    }
    print(`FALLBACK_POINT=${target.x},${target.y}`)
    print(`WARN=${choice.error}；按 --fallback-point 退化成坐标点击（这不是语义操作）`)
    const synthetic = { ...args, x: target.x, y: target.y }
    return cmdInject(synthetic, 'click')
  }
  print(`PATTERN=${choice.pattern}`)
  print(`PATTERN_WHY=${choice.why}`)
  const box = screenBoxFrom(bridgeJson({ Command: 'profile' }, bridgeOpts(args)))
  const rect = element.rect
  const pixelRegion = rect
    ? `${rect.left},${rect.top},${rect.width},${rect.height}`
    : undefined
  const region = pixelRegion ? clampRegion(parseRegion(pixelRegion), box) : undefined
  const regionText = region ? `${region.left},${region.top},${region.width},${region.height}` : undefined
  const { actionResult, verify } = withVerification(
    { ...args, x: rect ? rect.left : undefined, y: rect ? rect.top : undefined },
    box,
    regionText,
    () =>
      bridgeJson(
        {
          Command: 'uia',
          // 与上面那次定位快照**同一个作用域**：id 绑作用域，换一个就可能命中不了。
          Hwnd: hwnd,
          Name: name,
          ElId: wantId,
          // 身份随落地调用下发（没有就是 undefined ⇒ `runBridge` 跳过这个键，绝不凭空造一个）。
          ElRuntimeId: identity.runtimeId,
          SetValue: setValue,
          Depth: depth,
          Limit: limit,
          Invoke: true,
        },
        bridgeOpts(args),
      ),
    { hint: `UIA pattern=${choice.pattern}（没有移动真实鼠标）` },
  )
  print(`OK=${actionResult.invoked === true}`)
  print(`PATTERN_USED=${actionResult.pattern ?? choice.pattern}`)
  print(`VALUE_BEFORE=${actionResult.valueBefore ?? ''}`)
  print(`VALUE_AFTER=${actionResult.valueAfter ?? ''}`)
  // 身份复核的结论（design.md I6f）：`checked`（一致）/ `absent`（上面已经报了"这次没有身份复核"）/
  // `mismatch`（不一致 —— 桥一个动作都没执行）。这一行必须打，缺了它"到底复核过没有"就无从判断。
  const identityVerdict = identityState(identity, actionResult)
  if (actionResult.patternError && identityVerdict !== 'mismatch') print(`WARN=${actionResult.patternError}`)
  print(`ID_IDENTITY=${identityVerdict}`)
  print(`CHANGED=${verify.changed}`)
  printJson(args, {
    element: {
      id: element.id,
      controlType: element.controlType,
      name: element.name,
      patterns: element.patterns,
      runtimeId: element.runtimeId ?? '',
    },
    identity: { runtimeId: identity.runtimeId ?? '', state: identityVerdict },
    pattern: actionResult.pattern ?? choice.pattern,
    ok: actionResult.invoked === true,
    changed: verify.changed,
    before: verify.digestBefore,
    after: verify.digestAfter,
  })
  // 身份不一致 ⇒ **拒绝动手**：桥侧连 pattern 都没取（`invoked=false`），所以这不是"动作没生效"
  // （那是退出码 1，补救是去查闸门/靶侧），而是"我拒绝按这个 id 动手"（退出码 2，补救是重新取 id）。
  // 与 GEO_MISMATCH / LANDING_PREFLIGHT 的拒发同一条路：stderr 给 `ERROR=`，stdout 里留 WARN=。
  if (identityVerdict === 'mismatch') {
    const expected = identity.runtimeId ?? ''
    const actual = String(actionResult.runtimeIdActual ?? '')
    print(
      `WARN=元素身份不一致：id 命中的元素这次报的 runtimeId 是 ${actual === '' ? '(空)' : actual}，` +
        `而定位快照下发的身份是 ${expected} —— 桥没有执行任何动作（invoked=false）`,
    )
    throw new UsageError(
      `invoke 拒绝动手：元素身份复核不一致（下发 ${expected}，这次命中 ${actual === '' ? '(空)' : actual}）。` +
        `id 相同**不保证**是同一个元素：id 只是 runtimeId 的哈希，而"数命中数"用的是定位快照那份数组，` +
        `动的手却发生在桥的第二遍遍历里。请重取一次 id（同一作用域），或者确认两次之间元素有没有被替换。`,
    )
  }
  // 语义动作真的失败时（元素在手、pattern 在手，但调用抛了）不能报"成功"：退出码 1。
  // 无 pattern 的情形上面已经用 UsageError 走退出码 2 了；这里是运行期失败，与它不同。
  if (actionResult.invoked !== true) {
    print(`WARN=语义操作没有真正生效：元素 ${element.id} 的 pattern 调用失败，界面可能没变`)
    return 1
  }
  return 0
}

function cmdVerify(args) {
  assertNoExtra(args, 'verify')
  const hasPoint = hasValue(args, 'x') && hasValue(args, 'y')
  const point = hasPoint ? requirePoint(args) : undefined
  const specs = parseExpect(optionalText(args, 'expect'))
  if (specs.length === 0) {
    print(`WARN=既没有 --expect 也没有要复核的动作：下面只是"当前状态快照"，CHANGED 恒为 false`)
  }
  const box = screenBoxFrom(bridgeJson({ Command: 'profile' }, bridgeOpts(args)))
  // 注意这里必须 `{ ...args }` 起手再改 x/y：写成 `{ x: undefined, y: undefined }` 会把
  // --no-pixel / --no-content / --timeout 这些开关一起丢掉（真出过：`verify --no-content` 的
  // 快照照样跑了，于是 CONTENT_PROBE=skipped 旁边还挂着一个内容哈希）。
  const probeArgs = point ? { ...args, x: point.x, y: point.y } : { ...args, x: undefined, y: undefined }
  const { state: before } = captureState(probeArgs, box, undefined)
  const after = hasPoint ? captureState(probeArgs, box, undefined).state : before
  const result = compareStates(before, after, { ignore: hasPoint ? ['point'] : [] })
  const normalized = result.after
  print(`FOREGROUND=${normalized.foreground}`)
  print(`FOREGROUND_TITLE=${normalized.foregroundTitle}`)
  print(`WINDOW_COUNT=${normalized.windowCount}`)
  if (point) {
    print(`POINT=${point.x},${point.y}`)
    print(`POINT_HWND=${normalized.point}`)
    print(`POINT_TITLE=${normalized.pointTitle}`)
    print(`POINT_PROCESS=${normalized.pointProcess}`)
    print(`POINT_INTEGRITY=${normalized.pointIntegrity}`)
  }
  print(`TITLES_DIGEST=${normalized.titlesDigest}`)
  // 内容类判据这一路能读到什么：0 条意味着"文本框内容 / 滚动位置"这类变化这次看不见。
  const contentProbe = contentProbeState(args, normalized)
  print(`CONTENT_ROOT=${normalized.contentRoot || '-'}`)
  print(`CONTENT_SOURCE=${normalized.contentSource || '-'}`)
  print(`CONTENT_PROBE=${contentProbe}`)
  print(`CONTENT_BEARING_COUNT=${normalized.contentBearingCount}`)
  print(`CONTENT_KINDS=${kindsText(normalized.contentKinds)}`)
  print(`CONTENT_HASH=${normalized.contentHash || '-'}`)
  if (normalized.contentNote !== '') print(`WARN=UIA 内容快照有读不到的项（${normalized.contentNote}）`)
  // 与 reportVerification 同口径：--no-content 让这次快照少了内容这一类判据，得说明白。
  if (contentProbe === 'skipped') {
    print('WARN=内容类判据这次被 --no-content 关掉了：这次快照里没有「文本框内容 / 滚动位置 / 选中态」，只有像素/窗口/前台/落点')
  }
  print(`BEFORE=${result.digestBefore}`)
  print(`AFTER=${result.digestAfter}`)
  if (specs.length > 0) {
    const checked = checkExpectations(specs, result)
    print(`EXPECT_OK=${checked.ok}`)
    for (const row of checked.rows) print(`EXPECT ${row.key} | ${row.expect} | ${row.actual} | ${row.ok}`)
  }
  print(`CHANGED=${hasPoint ? result.changed : false}`)
  if (!hasPoint) print(`WARN=单次快照没有"前"可比，CHANGED 恒为 false（要看变化请给注入类命令，或自己前后各跑一次 verify）`)
  printJson(args, {
    foreground: normalized.foreground,
    foregroundTitle: normalized.foregroundTitle,
    windowCount: normalized.windowCount,
    titlesDigest: normalized.titlesDigest,
    changed: hasPoint ? result.changed : false,
  })
  return 0
}

/**
 * `probe`：只做**内存编码**的诊断命令，**从不调用 SendInput**。
 *
 * 它存在的原因有两个静态审查看不出来的缺陷，都是"赋值看起来完全正确、字节却是错的"：
 *   1. PowerShell 对嵌套值类型成员给的是副本，所以 `$item.u.mi.dx = 42` 写进一个被丢弃的
 *      临时对象，结构体全零送出而 SendInput 照样回"已插入 N 个事件"、GetLastError 照样 0。
 *   2. 平铺布局里鼠标与键盘的 dwFlags 落在**不同**偏移（INPUT 的 20 与 12，见 winuser.h），
 *      共用一个字段名就会把键盘的 KEYEVENTF_UNICODE 静默清零 —— `type`/`key` 从此永不生效。
 * 两种缺陷的判据都只能是内存里的原始字节，所以这里把构造出来的 INPUT 用与注入路径**同一个**
 * StructureToPtr 编码回十六进制；另外同时编一份 winuser.h 原样的嵌套 union 版本作参照，
 * 逐字节比对（`*_MATCHES_CANONICAL`）—— 偏移只要对不上，这里就报 false。
 * 断言在 `test/injection.test.mjs`。
 */
/**
 * `snapshot`：只读的**内容快照**探针。它单独一条命令、单独一个子进程，理由是安全而不是好看。
 *
 * UIA 的内容读取（Value / 滚动位置 / RangeValue / Toggle / 选中态）可能抛 corrupted-state 的
 * `AccessViolationException` —— PowerShell 的 `try/catch` **抓不住**，整个 powershell.exe 当场退出
 * （真机：`exit=3221225477`，栈 `System.AccessViolationException at RawTextRange_GetText`）。
 * 所以它必须与"读窗口/前台/像素"和注入本身隔离开：崩了只丢这一条读数，别的照跑。
 * 这条命令**零副作用**：不发输入、不抬窗口、不改前台、不写系统设置。
 */
function cmdSnapshot(args) {
  assertNoExtra(args, 'snapshot')
  const params = { Command: 'snapshot' }
  if (hasValue(args, 'hwnd')) params.Hwnd = requireText(args, 'hwnd')
  if (hasValue(args, 'x') || hasValue(args, 'y')) {
    const point = requirePoint(args)
    params.X = point.x
    params.Y = point.y
  }
  const probe = probeBridge(params, bridgeOpts(args))
  if (!probe.ok) {
    print(`SNAPSHOT_OK=false`)
    print(`EXIT_CODE=${probe.exitCode ?? '-'}`)
    print(`CRASH=${probe.crash ?? '-'}`)
    print(`WARN=${probe.reason}`)
    printJson(args, { ok: false, exitCode: probe.exitCode, crash: probe.crash, reason: probe.reason })
    return 1
  }
  const snap = probe.json.snapshot ?? {}
  print(`SNAPSHOT_OK=true`)
  print(`SNAPSHOT_ROOT=${snap.root || '-'}`)
  print(`SNAPSHOT_SOURCE=${snap.source || '-'}`)
  print(`CONTENT_COUNT=${snap.count ?? 0}`)
  print(`CONTENT_BEARING_COUNT=${snap.contentCount ?? 0}`)
  print(`CONTENT_KINDS=${kindsText(snap.kinds)}`)
  print(`CONTENT_HASH=${snap.hash || '-'}`)
  print(`UIA_AVAILABLE=${snap.uia === true}`)
  for (const line of Array.isArray(snap.readings) ? snap.readings : []) print(`READING ${line}`)
  if (typeof snap.note === 'string' && snap.note !== '') {
    print(`WARN=UIA 内容快照有读不到的项（${snap.note}）`)
  }
  printJson(args, snap)
  return 0
}

function cmdProbe(args) {
  assertNoExtra(args, 'probe')
  const report = bridgeJson({ Command: 'probe' }, bridgeOpts(args))
  print(`INPUT_STRUCT_SIZE=${report.inputStructSize}`)
  print(`CANONICAL_STRUCT_SIZE=${report.canonicalStructSize}`)
  print(`MOUSE_INPUT_SIZE=${report.mouseInputSize}`)
  print(`KEY_INPUT_SIZE=${report.keyInputSize}`)
  print(`MOUSE_HEX=${report.mouseHex}`)
  print(`KEY_HEX=${report.keyHex}`)
  print(`KEY_UP_BYTES_HEX=${report.keyUpBytesHex}`)
  print(`MOUSE_BYTES_HEX=${report.mouseBytesHex}`)
  print(`KEY_BYTES_HEX=${report.keyBytesHex}`)
  print(`CANONICAL_MOUSE_BYTES_HEX=${report.canonicalMouseBytesHex}`)
  print(`MOUSE_MATCHES_CANONICAL=${report.mouseMatchesCanonical === true}`)
  print(`KEY_MATCHES_CANONICAL=${report.keyMatchesCanonical === true}`)
  print(`KEY_UP_MATCHES_CANONICAL=${report.keyUpMatchesCanonical === true}`)
  // 滚轮：`--dy` 为负时 dwData 是 -360，必须以 uint32 0xFFFFFEA8 进 mouseData。旧代码把它
  // 直塞 `[uint32]` 参数，整条命令在造事件之前就死在类型转换上（exit 1）。
  print(`WHEEL_BYTES_HEX=${report.wheelBytesHex}`)
  print(`CANONICAL_WHEEL_BYTES_HEX=${report.canonicalWheelBytesHex}`)
  print(`WHEEL_MATCHES_CANONICAL=${report.wheelMatchesCanonical === true}`)
  print(`WHEEL_CLICKS=${report.wheelClicks}`)
  print(`WHEEL_DW_DATA=${report.wheelDwData}`)
  print(`WHEEL_FIELDS=${JSON.stringify(report.wheelFields)}`)
  for (const [name, offset] of Object.entries(report.offsets ?? {})) {
    print(`OFFSET_${name.toUpperCase()}=${offset}`)
  }
  print(`MOUSE_FIELDS=${JSON.stringify(report.mouseFields)}`)
  print(`KEY_FIELDS=${JSON.stringify(report.keyFields)}`)
  print(`OK=true`)
  printJson(args, report)
  return 0
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = commandOf(args)
  if (!cmd || cmd === 'help' || flagOn(args, 'help')) {
    print(USAGE)
    return 0
  }
  const verdict = runtimeVerdict()
  if (verdict !== null) throw new Error(verdict)
  // 开关作用域闸门：这条命令用不上的开关一律报用法错（退出码 2），不静默忽略。
  // 放在分发之前，所以"拼错的开关名"不会走到任何动作里（design.md I10c）。
  checkFlagScope(args, cmd)
  // platform 闸门：非 Windows 时 profile 仍给诊断（并打印 WINDOWS_ONLY=true），其余命令明确报错。
  const platformProblem = platformVerdict()
  if (platformProblem !== null && cmd !== 'profile') throw new Error(platformProblem)
  switch (cmd) {
    case 'profile':
      return cmdProfile(args, platformProblem)
    case 'screen':
      return cmdScreen(args)
    case 'windows':
      return cmdWindows(args)
    case 'uia':
      return cmdUia(args)
    case 'point':
      return cmdPoint(args)
    case 'click':
    case 'move':
    case 'type':
    case 'key':
    case 'scroll':
      return cmdInject(args, cmd)
    case 'invoke':
      return cmdInvoke(args)
    case 'verify':
      return cmdVerify(args)
    case 'snapshot':
      return cmdSnapshot(args)
    case 'probe':
      return cmdProbe(args)
    default:
      throw new UsageError(`不认识命令：${cmd}`)
  }
}

/** 收尾：三条退出码口径与 `ERROR=` 只走 stderr（与 browser/cli.mjs 同形）。 */
main()
  .then((code) => {
    process.exit(code ?? 0)
  })
  .catch((error) => {
    if (error instanceof BridgeError) {
      process.stderr.write(`ERROR=${error.message}\n`)
      if (error.detail?.files?.dir) cleanup(error.detail.files)
      process.exit(1)
    }
    if (error instanceof UsageError) {
      // 用法错只在 stderr 打 ERROR + 一行提示；完整 USAGE 留给 `help` / `--help`。
      // （以前每次用法错都吐一屏 USAGE，把真正的报错顶出视野。）
      process.stderr.write(`ERROR=${error.message}\n提示：node cli.mjs help 看完整用法。\n`)
      process.exit(2)
    }
    process.stderr.write(`ERROR=${error?.message ?? String(error)}\n`)
    process.exit(1)
  })
# AGENTS.md — browser（Adg 浏览器工具链）

本模块 = 一份 **Chromium 系浏览器驱动（默认无头；需要人工介入时才换成有头）**：规范 profile 的解析、实例的复用 / 启动 / **换模式**决策、一条最小 CDP 通道（navigate / evaluate / screenshot）、**五条最小动作命令**（`click` / `hover` / `type` / `select` / `wait-for`，配一层**「动作成败只认可观测差异」的判据**）、**标签页卫生**（自己开的临时页自己收、存量靠 `close-tab` 点名清理），以及唯一命令行入口 `browser/cli.mjs`。设计、不变量（I1..I17）与理由见 `design.md`，用例与未观测项见 `testing-guide.md`。

## 命令

```sh
node cli.mjs help        # 命令行契约：**命令、选项与退出码以它为准**，本文与技能都不复制完整选项表（技能只举常用命令与少数选项）
node cli.mjs profile     # 报解析出来的 profile / 端口 / 浏览器可执行文件 / 默认模式（排错第一站）
node cli.mjs status      # 端口是否活着、浏览器版本串、**当前模式**、当前标签页
node cli.mjs tabs        # 只列标签页（TABS= 计数 + 每行 序号 | 标题 | 地址）—— 清理存量前先看这个
node cli.mjs launch      # 开浏览器：**默认无头**；实例活着就复用；活着的正好是另一种模式、且你**显式**要求了目标模式时，先优雅关掉再按同一 profile / 端口重开
node cli.mjs open <url>  # 新开一个标签页：已有同地址的页就复用它，不重复开
node cli.mjs text        # 一次性读取：读一页的标题 / 地址 / 可见文本（`--url` 选页、`--out` 写正文到文件、`--keep` 留住临时页）
node cli.mjs eval        # 在页面里求值（`--js "<表达式>"` 或 `--file <脚本路径>`）—— 测试指南的那几条探针用它
node cli.mjs shot        # 截图（`--out <png 路径>`，`--full` 截整页）

node cli.mjs click       # 点元素（--selector <css> [--force]）：真实鼠标事件 + 命中自检（点在别的元素上时默认拒发）
node cli.mjs hover       # 悬停（--selector <css> [--force]）：真实指针移到元素中心（一次显式 `buttons: 0` 的 mouseMoved，即不按任何键）+ 同一套命中自检 —— 靠 mouseenter 展开的下拉 / 菜单先 hover 再 click
node cli.mjs type        # 输入（--selector <css> --text <字符串> [--clear]）：聚焦 → 一次 insertText → 前后比对
node cli.mjs select      # 选 <select> 的项（--selector <css> --value <值>）：值必须在选项里，否则拒发
node cli.mjs wait-for    # 等条件（--selector <css> [--visible] | --url-match <子串> | --js "<表达式>"；--timeout / --interval）

node cli.mjs close-tab   # 关标签页：--match <子串> 关所有匹配的，--tab <n> 关那一个
node cli.mjs close       # 优雅关闭 —— 唯一让登录态落盘的动作

cd browser && node --test test                                  # 单元测试全绿（不需要浏览器）
cd browser && node --test --test-isolation=none test            # 本机沙箱（workspace-write）里必须加这个 flag
```

上表是常用命令的速查，**完整用法（选项与退出码的权威文本）以 `cd browser && node cli.mjs help` 的当场输出为准**；表里没列到的项以它为准。

日常自动化走无头（不抢焦点、不弹窗）；运行模式本身**由调度者在派发前判定**（拿不准就先无头，见「红线」最后一条）。**撞上登录墙 / 验证码 / 二次验证才 `node cli.mjs launch --headed`** —— 它会把当前无头实例优雅关掉，再用同一个 profile 开一个有头窗口让人进去操作（登录态因此留在原地）。

零依赖：只要求 Node ≥ 22（需要全局 `WebSocket`；`lib/cdp.mjs` 的 `assertRuntime()` 会显式报错，不静默降级）。没有 `node_modules`、没有构建步骤。

## 红线

一行一条，编号即 `design.md` 的不变量编号，理由与载体都写在那里。

- 禁止引入第三方依赖（`playwright` / `puppeteer` / `ws` 一律不许）。来源：这类库自带注入面与额外进程管理，超出「连上去读一页」的范围。载体：[机检] `cd browser && node --test test`（见 `design.md` 的「非功能红线」一节）。守卫按**形状**判：`browser/` 下全部 `.mjs` 的每个模块 specifier 只能是 `node:` 内建或相对 / 绝对路径，覆盖 `import 'p'` / `import x from 'p'` / `export … from 'p'` / `import('p')` / `require('p')` **五种写法**，并另加 clause 跨行（`import {` 换行 `} from 'ws';`）、语句**不在行首**（`const zz = 1; import x from 'ws';`）、`export * from`、模板插值里的 `import()`；抽 specifier 前**先剥注释与字符串字面量**（`const note = "require('ws');";` 这种正当代码不许被判红）。**不许退回"黑名单 + 只认 `from 'x'`"那种恒真的旧形状**（对 `import 'ws';` 它会抽到 0 个 specifier 而静默全绿）。已知洞（实测全绿，登记在 `testing-guide.md` 的「守卫的变异自证」一节）：运行期拼出来的 specifier（`const p = 'w' + 's'; await import(p)`）抽不到 —— 文本扫描只保证字形。正则字面量按**启发式**认（`/` 后不是 `/` 或 `*`，且前一有效字符是 `=` `(` `,` `:` `[` `!` `&` `|` `?` `{` `}` `;` 或运算符，或紧跟 `return` / `case` / `typeof` 等关键字），整段记成一个 span —— 所以 `const re = /'/; import x from 'ws';` 里的真 import 不会被正则里的引号吞掉，`const re = /import x from 'ws'/;` 也不会被当成真依赖；**但 `/` 前面是 `)` / `]` / 标识符时一律当除法**，语句位置的正则（`if (ok) /re/.test(s)`）认不出来，两个方向都留残余（已用"已知洞"断言钉住，见 `testing-guide.md` 的**覆盖边界 ④**；不许把这两族当真依赖，也不许拿它们放宽守卫）。
- 禁止把 profile 放进会话工作区、禁止写死本机绝对路径：profile 只能是显式配置或 `<DSH_HOME>/browser-profile`。来源：profile 跟着工作区走，登录态就跟着清零。载体：[机检] 单元用例（I1）。
- 禁止重启一个活着的实例（I5）；禁止用 `PageSession.close()` 关浏览器（I6，只有 `node cli.mjs close` 能关）。**换模式是 I5 的唯一例外**，且必须是调用方**显式**指定的目标模式（I4 ③）。**不带旗标不许换掉活着的实例** —— 默认模式只决定新起的实例，换模式必须显式（`--headless` / `--headed` / `ADG_BROWSER_MODE`，判定在 `modeIsExplicit`），否则 `launch` 在活着的另一种模式实例上一律 `STATE=REUSED`（＋一条「你没有显式要求模式」的说明行）且不动它；不许「顺手统一一下模式」，也不许静默换掉一个模式读不出来的活实例。载体：[机检] 单元用例 + [真机] 最小闭环。
- 禁止改掉「**默认无头**」这个工具默认值（I4 ①）—— 有头是「需要人工介入时」的显式升级，不是常态；也禁止用空参数启动浏览器（空 argv 等于启动浏览器自己的默认 profile，会把请求转交给用户日常那个实例，见 I4 ④）。载体：[机检] 单元用例。
- 禁止关掉**不是本任务开的**标签页，也禁止用 `close-tab` 把页面关到 0 个（I8 / I10）：不点名不关、不关到 0 个、自己开的临时页自己收（`--keep` 才留）。用户窗口里的页既有登录态，也可能是他正在用的。载体：[机检] 单元用例 + [人]。
- 禁止代填账号密码、读取 profile 的 cookie 库、验证码识别或指纹伪装：登录永远由人在有头窗口里完成。**人正在那个有头窗口里登录时，不要关它、也不要为了切回无头把它关掉**。载体：[评] + [人]（`design.md` 的「非功能红线」）。
- 禁止把「浏览器起不来」写成重试题：命中沙箱失败签名就停手如实报。三条已知签名（**认文本不认行号**，行号随二进制版本变）的**逐字文本**就在本条，人要拿这里的字面去核日志：Chrome **退出码 21**；Edge 报 `platform_channel.cc … Check failed … 拒绝访问(0x5)`；Brave **退出码 4294930433（0xFFFF7001）** 配 `crashpad_client_win.cc … OpenProcess: 拒绝访问。 (0x5)` 与 `crash server failed to launch, self-terminating`（Brave 那条走 crashpad 而不是 Mojo）。**无头不改变这个结论**：受限令牌下有头无头同形失败，这是**本模块唯一的签名本体** —— `design.md` 与 `testing-guide.md` 只留指向本节的指针，不复述签名文本。**但全库不止一处**：这三条签名的存在与判读口径也写在 `skills/adg-browser-use/SKILL.md` 的「权限前提」一节 —— 那是**运行期识别**用的（子代理读不到本仓库任何文档，只有随委派拿到的那份技能能告诉它命中哪三条就停手），所以**改签名必须两处同步**；不要求两份逐字相同（技能只写指针与数量口径），但**三条的数量与判读口径必须一致**。载体：[人]（量法见 `testing-guide.md` 的「人工 review 项」）。
- 调度方在派发**带浏览器能力的子代理**（`tools` 里有 `pwsh` + 技能 `adg-browser-use` 的那次委派）**之前**必须读当前文件策略，不是 `danger-full-access` 就先问用户放行。来源：受限令牌下浏览器根本起不来 —— **这不是安全边界，是部署前提**；子代理用不了平台那条 `ask_user_question`（它的提问通道是 `adg-delegate` 的 `ask_user`）、也改不了自己那一格权限。规定出处：`preset/design.md` 的「非功能红线」一节里那条**禁止删掉或绕过浏览器任务的权限闸门、也禁止把它写成"权限强制"**的规定。本模块落实处：`design.md` 的「人员放行」一节。载体：[评]。
- 运行模式由**调度者在派发前**判定（确定不需要登录 / 验证码 → 无头；确定需要 → 有头；拿不准 → 先无头，真撞上登录墙 / 验证码再换成有头），同一个实例不为此之外的目的中途换模式（换模式＝优雅关旧实例、同 profile 同端口重开，未提交表单与 SPA 内存态会丢）。来源：换模式只保住持久 cookie，所以模式要尽量在开工前定好；每天最常打的 bare `launch` 不该有砸掉用户登录现场的权力；而「撞上登录墙才换成有头」是登录协议的既定路径，不算中途乱换。载体：[评] 调度 persona 的「浏览器：模式」/「浏览器：权限」两段与 `skills/adg-browser-use/SKILL.md`、以及 `preset/design.md` 的「非功能红线」一节里那条**浏览器模式由调度者在派发前判定、写进委派**的规定。
- 部署落点与仓库路径同名（`browser/` → `${DSH_HOME:-~/.dsh}/browser/`）；改目录名要同步改 `install.ps1` / `install.sh` 与 `skills/adg-browser-use/SKILL.md` 里的 `browser/cli.mjs` 路径。载体：[评]（`design.md` 的「依赖关系」与 `testing-guide.md` 的消费方契约测试）。
- 禁止把动作命令的**调用返回**当成功证据：`DISPATCHED=`（发出几个事件）、CDP 那句 `{}`、`element.click()` 不报错，全都不算 —— 判据是**动作前后的 DOM 可观测差异**，每条动作命令都必须打 `CHANGED=true|false|unknown` 与 `BEFORE=` / `AFTER=`（I13 / I14）。来源：`SendInput` 那类"返回已插入 N 个事件、事件随后被静默丢弃"的坑在浏览器侧同形。载体：[机检] 单元用例 + [真机] 五命令闭环。
- 禁止把 `unknown` 读成、补成或记成 `false`，也禁止把"这条命令专属的那几类判据在动作前**或**动作后读不到（不可比）"读成"没变化"：前者一律 `unknown`，`REASON=` 里逐类点名，那几句"这次判据看不见什么"的引导句要照抄进报告，不许删（I14）。**"我看不见这类动作的效果"绝不许报成 `false`**。载体：[机检] 单元用例（三态） + [评]。
- 禁止绕过闸门先发后查：`click` 的命中自检（点到的不是目标元素）、`hover` 的同一套命中自检（指针移到的不是目标元素）与 `select` 的"值不在选项里"，默认必须在**发事件之前**以**退出码 2** 停手（`--force` 才硬发且保留 `WARN=`）—— 不许发了再说，也不许把闸门的 2、`wait-for` 超时的 1 和判据那三行混起来：判据给 `false` / `unknown` 时退出码仍是 **0**（命令跑通了，只是这次没看到差异 / 判据看不见），2 ＝ 用法错、1 ＝ 运行期错（I16）。载体：[机检] 单元用例 + [真机] 闭环。
- 禁止让 `wait-for` 的超时静默成功：超时是**"没等到"的确定读数** —— `WAIT=timeout` ＋退出码 1 ＋ `POLLS=` / `ELAPSED_MS=`，不许把轮询耗尽写成成功（I15）。载体：[机检] 单元用例 + [真机] 闭环。
- 禁止给动作面引入截图或像素比较判据（判据只认 DOM 可观测差异）；**网络拦截 / 请求改写 / cookie 读写 / 文件上传本次未纳入** —— 需要它们时挂号说明，不许私自扩面（见 `design.md` 的「非功能红线」）。载体：[评]。
- 禁止在**不是本任务开的**实例/页面上跑动作命令：动作会真的改变那个页面的状态（提交表单、下单、发消息），先 `tabs` 看清是谁的页，选页按 I17（`--match` 必须唯一命中，多命中拒绝执行）。载体：[评] + [机检] 单元用例。
- 禁止把闸门的**判定**留在页面表达式里（页面里一个布尔量可以被一行改掉，文本扫描只能按形状抓），也禁止"闸门过了"就报成功：`select` 的判定必须在 Node 侧纯函数 `decideSelect`（页面探针只读原始数据、不知道请求值），写入之后必须**回读自证** —— `select` 的 `SELECT_APPLIED=` 三样（值在选项表里 / `value` 等于请求值 / `selectedIndex` 指着它的位置）缺一 ⇒ **退出码 1** 报"动作没有落地"（受控组件把选择回滚时得到的就是这个读数）；`type` 的 `TYPE_APPLIED=` 与 `click` 的 `HIT_AFTER=` 是同类自证读数（读不到一律 `unknown`，不许当成功）。来源：第四轮返工 —— 复核方三条别名 / 反射变体曾让单测 100 条全绿，而 CLI 端到端从"拒发（2）"翻成"放行（0）"。载体：[机检]（A85 / A92 / A93 / A94）+ [真机]（A97）。
- 禁止把"页面主动撒谎"说成"已经封住"：判据的原料全部来自页面读数，所以页面**连回读一起伪造**时外部分辨不了（实测：单测红 5 条而 CLI 退出码 0）、`type` 的回读表达式被改坏时单测仍全绿（真机 fail-closed 成 `TYPE_APPLIED=unknown`）、`click` 的"点没点到目标"没有任何回读能证明（`hover` 同理：「指针移进的是不是目标元素」也没有回读能证明，而且**不改 `innerText` 的纯视觉属性变化**（`opacity` / 配色 / 边框 / 阴影）判据看不见（改 `display` 那类会把子元素文本带进 / 带出 `body.innerText` ⇒ 判据**看得见**），只能自己 `eval` 回读 `getComputedStyle` / `offsetParent`）。这些残余逐条登记在 `design.md` 的「闸门被绕过 / 页面撒谎时，哪条读数还说得上话（残余）」与 `testing-guide.md` 的覆盖边界 ⑤、A98，报回时必须照原样保留。载体：[评] + [机检]（变异 M11 / M12）。

## 版本区

本模块的最终文档只有三份，都在 `browser/` 下：本文（路由）→ `design.md`（设计与不变量）→ `testing-guide.md`（用例与未观测项）。进 git、互相引用、改了就原地更新，不建「最新稿」。过程件住在被 `.gitignore` 排除的临时工作目录 `docs-work/`，不算版本区，任务交付前清空。完整清单与各文档的职责边界见仓库根 `AGENTS.md` 的「版本区」一节。

## 生效方式

`browser/` 是**用户根下的普通文件**，不是 dsh 插件也不是 preset：改完重新跑一次 `install.ps1` / `install.sh` 就生效，**不需要重启 dsh**（与 `preset/` 的生效方式不同，别承诺错）。preset 侧引用本模块的调度 persona 改动仍按 preset 的口径走：重启 dsh + 新会话验收。

与 `install.*` 的其余步骤解耦：脚本还会生成 / 重装 preset bundle 与通知子插件，`browser/` 的拷贝排在这些步骤**之前**，所以即使后面某步失败（脚本会如实报告并以非零退出码结束），**已拷好的 `browser/` 仍然是最新的**。

复核（部署后跑，两条都做）：

```sh
node "${DSH_HOME:-~/.dsh}/browser/cli.mjs" profile   # 须正常报出 DSH_HOME= / PROFILE= / PROFILE_EXISTS= / PORT= / CHROME= / DEFAULT_MODE=
```

再逐文件比对用户根 `browser/` 与仓库 `browser/`（文件集与内容一致；读数当场取，不作锚）。
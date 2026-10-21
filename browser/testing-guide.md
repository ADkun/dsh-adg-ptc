---
title: browser 模块测试指南
owner: Adg preset 维护者
status: current
last_reviewed: 2026-10-15
---

# browser 模块测试指南

不变量定义在 `design.md`（I1..I17），本文只写**怎么验**。载体四类：`[机检]`＝`cd browser && node --test test`（零依赖、不需要浏览器，CDP 通道用可注入的假 socket 测）；`[真机]`＝要有本机 Chromium 系浏览器，在 `danger-full-access` 会话里跑；`[人]`＝脚本抓不到、要人眼看；`[评]`＝对 `skills/` 与 `README.md` 侧文本的审查。**表里的条数与读数都是当场读数、不作锚**，判据一律以命令输出为准。

## 命令（可直接照抄）

```sh
cd browser && node --test test                       # 全部单元用例
cd browser && node --test --test-isolation=none test # 本机沙箱（workspace-write）里必须加这个 flag
```

第二个 flag 的原因：`node --test` 默认给每个测试文件起 **pipe-stdio** 子进程，受限令牌下 `spawn(..., { stdio: 'pipe' })` 抛 `EPERM`；`--test-isolation=none` 让测试跑在同一个进程里。**这是测试运行方式的问题，与浏览器起不起得来无关** —— 浏览器死在内部 IPC 上（见 `design.md` 的「非功能红线」）。

## 用例总表

「载体」列：`[机检]`＝上面那条单元测试命令；`[真机]`＝「交付前的最小闭环」一节的命令序列；`[人]`＝人工 review 项。

| 用例ID | 对象 | 断言内容 | 对应不变量 / 迁移 | 载体 |
|---|---|---|---|---|
| A1 | BrowserTarget | 默认 profile 固定在 `<DSH_HOME>/browser-profile` | I1 | [机检] |
| A2 | BrowserTarget | 没有 `DSH_HOME` 时回落到 `<home>/.dsh/browser-profile` | I1 | [机检] |
| A3 | BrowserTarget | 换 cwd 不改变默认 profile（与工作区无关） | I1 | [机检] |
| A4 | BrowserTarget | 显式 `--profile` 优先于 `ADG_BROWSER_PROFILE` 与默认值 | I1 | [机检] |
| A5 | BrowserTarget | `dshHome` 优先 `DSH_HOME`，缺省 `~/.dsh` | I1 | [机检] |
| A6 | BrowserTarget | 启动参数必须带 `user-data-dir` 与 `remote-debugging-port` | I2 | [机检] |
| A7 | BrowserTarget | 启动参数禁止出现伪装 / 降权旗标 | I2 | [机检] |
| A8 | BrowserInstance | 实例活着且模式相同 → reuse，且不产生启动参数 | I4 ② / I5 | [机检] |
| A9 | BrowserInstance | 活着的实例模式未知 → 也 reuse（不认识的活实例不许被静默换掉） | I4 ② / I5 | [机检] |
| A10 | BrowserInstance | 活着的是另一种模式 → switch，且必须带上**目标模式**的启动参数 | I4 ③ ④ | [机检] |
| A11 | BrowserInstance | 活着的是另一种模式但没有可用浏览器 → error（不退化成空参数启动） | I4 ④ | [机检] |
| A12 | BrowserTarget | 非法端口一律抛错（非整数 / < 1 / > 65535） | I3 | [机检] |
| A13 | BrowserTarget | 合法端口接受数字与数字串，并遵循优先级 | I3 | [机检] |
| A14 | PageSession | 只认有 ws 端点、非 `devtools://` 的 page 目标 | I7 | [机检] |
| A15 | PageSession | `--match` 命中 url 或 title；未命中必须报错而不是随便挑一页 | I7 | [机检] |
| A16 | PageSession | `--tab` 越界与负数必须报错 | I7 | [机检] |
| A17 | PageSession | 刚创建的标签按 id 定位（站内跳转也能找回来） | I7 | [机检] |
| A18 | PageSession | 空目标列表报「没有可用页面目标」 | I7 | [机检] |
| A19 | 模块整体 | 只允许 `node:` 内建与相对路径的 import（零依赖） | 非功能红线 | [机检] |
| A20 | 运行时 | 本机 Node 满足运行时要求（≥ 22 的全局 `WebSocket`） | 非功能红线 | [机检] |
| A20b | 浏览器探测 | `ADG_CHROME` 永远排第一；win32 候选含 Chrome / Brave / Edge 且 Brave 在 Edge 前 | 非功能红线 | [机检] |
| A21 | 浏览器探测 | 只有 Brave 与 Edge 时选中 Brave（不静默换成系统自带的 Edge） | 非功能红线 | [机检] |
| A22 | 浏览器探测 | `findChrome` 取第一个真实存在的候选；都没有则 `null` | 非功能红线 | [机检] |
| A23 | CDP 通道 | 请求按 `id` 关联：乱序返回也能各归各位 | I9 | [机检] |
| A24 | CDP 通道 | CDP 错误映射成 `Error`，并带上方法名 | I9 | [机检] |
| A25 | CDP 通道 | 事件通知与未知 `id` 被忽略，不炸掉连接 | I9 | [机检] |
| A26 | CDP 通道 | 关闭后 `send` 拒绝，在途请求也被拒绝 | I9 | [机检] |
| A27 | CDP 通道 | 连不上时报错，不静默返回半个客户端 | I9 | [机检] |
| A28 | PageSession | 关浏览器只有一个入口：`closeBrowser` 发 `Browser.close` | I6 | [机检] |
| A29 | PageTab | `--match` 关掉所有匹配的页，没命中必须报错 | I8 | [机检] |
| A30 | PageTab | `--tab` 关且只关一个；越界、负数、缺值都必须报错 | I8 | [机检] |
| A31 | PageTab | 不给选择器就不关：不猜要关哪个 | I8 | [机检] |
| A32 | PageTab | 拒绝关到 0 个页面（那等于关浏览器、绕过 `close`） | I8 | [机检] |
| A33 | PageTab | 关标签页只走 `Target.closeTarget`，`closeBrowser` 仍是唯一的 `Browser.close` | I6 / I8 | [机检] |
| A34 | PageTab | `pageSession` 标出「这一页是不是本命令自己开的」（`created`） | I10 | [机检] |
| A35 | PageTab | 读取命令的收尾只关自己开的页，且受 `--keep` 控制 | I10 | [机检] |
| A36 | PageTab | 新建临时页先开空白标签、attach 后再导航等可读状态（不许抢跑） | I10 ① | [机检] |
| A37 | PageTab | 初始导航失败也要收走自己开的临时页（失败路径同样「谁开的谁收」） | I10 ② | [机检] |
| A38 | 运行模式 | 默认模式是无头：不给 mode 时启动参数带 `--headless=new` | I4 ① | [机检] |
| A39 | 运行模式 | `--headed` 只去掉无头旗标，其余参数逐字相同 | I4 ① | [机检] |
| A40 | 运行模式 | 模式优先级：显式 > `ADG_BROWSER_MODE` > 默认；非法值抛错不回落 | I4 ① | [机检] |
| A41 | 运行模式 | `detectMode` 从 `User-Agent` 读出模式（有头 / 无头两种串） | I4 / BrowserMode | [机检] |
| A42 | 运行模式 | `detectMode` 拿不到 `User-Agent` 时报 `unknown`，不猜 | I4 ② | [机检] |
| A43 | 运行模式 | 没显式要求模式 → 活着的有头实例**不动它**（`modeNotRequested`） | I4 ② | [机检] |
| A44 | 运行模式 | 只有显式要求（旗标 / `ADG_BROWSER_MODE`）才允许换掉活着的实例 | I4 ③ | [机检] |
| A45 | 运行模式 | `launch` 在 spawn 前拒绝空 / 非数组启动参数（源码级断言） | I4 ④ | [机检] |
| A46 | 真机闭环 | `profile` 报出 `DSH_HOME` / `PROFILE` / `PROFILE_EXISTS` / `PORT` / `CHROME` / `DEFAULT_MODE`，且 `CHROME=` 是真实存在的可执行文件 | I1 / 非功能红线「候选次序」 | [真机] |
| A47 | 真机闭环 | 第一次 `launch` → `STATE=STARTED` 且 `MODE=` 是期望模式；紧接着再 `launch` → `STATE=REUSED`（没重启） | I4 ② / I5 | [真机] |
| A48 | 真机闭环 | 显式换模式 → `SWITCHED_FROM=` 非空、`CLOSED=true`、`STATE=SWITCHED`、`MODE=` 是目标模式；且整个过程没有 `RETRY=` | I4 ③ | [真机] |
| A49 | 真机闭环 | 在另一种模式的活实例上跑**不带旗标**的 `launch` → `STATE=REUSED` + `MODE=` 是活实例的实际模式、**没有** `SWITCHED_FROM=` | I4 ② | [真机] |
| A50 | 真机闭环 | 一次性读页（`text --url <新地址>`）→ 正文非空、打 `TAB_CLOSED=`，且前后 `TABS=` 相同（零残留）；同地址加 `--keep` → `TABS=` 加一 | I10 | [真机] |
| A51 | 真机闭环 | `close-tab` 在只剩一个页时被拒（`ERROR=` 提示会剩 0 个页面、退出码 1、浏览器仍 `ALIVE=true`） | I8 | [真机] |
| A52 | 真机闭环 | 选页未命中 → `ERROR=没有 url / title 匹配 …`、退出码 1（不随便挑一页）；页面内抛错 → `ERROR=页面内抛错：…`、退出码 1 | I7 | [真机] |
| A53 | 真机闭环 | `close` → `ALIVE=false` / `CLOSED=true`；随后 `status` 报 `MODE=none` | I6 / 迁移矩阵 | [真机] |
| A54 | 真机闭环 | 同一 profile 换模式后，带 `expires` 的持久 cookie 仍读得到（会话 cookie 不在保证范围） | I4 ③ | [真机] |
| A55 | 判据层 | `hashText` 是 FNV-1a 32 位、8 位十六进制，同输入同输出、异输入异输出 | I14 | [机检] |
| A56 | 判据层 | `normalizeState` 缺字段一律补空值（不补"猜的值"）；探针没返回对象 ⇒ `ok:false` + 原因，不是"没有变化" | I14 | [机检] |
| A57 | 判据层 | `normalizeTabs` 把"读不到"与"读到 0 个"分开 | I14 | [机检] |
| A58 | 判据层 | `kindReadable`：读不到 ≠ 没变化（`unknown` 的唯一来源） | I14 | [机检] |
| A59 | 判据层 | `compareStates`：探针失败整份退出比较；`ignore` 掉的类不参与 | I14 | [机检] |
| A60 | 判据层 | `changeVerdict` 三态：有差异 ⇒ `true`（唯一能正面证明生效的读数）；两侧都读到且都没变 ⇒ `false`；专属判据缺测（含**只在一侧**读得到）⇒ `unknown` 且**不许报 false** | I14 | [机检] |
| A61 | 判据层 | `digestOf` 一行摘要（`BEFORE=` / `AFTER=` 打的就是它）；`stateExpr` 不给选择器时元素读数整段跳过（运行期不读，不是读成"不存在"）；`captureState` 读不到时把原始错误留在明面上 | I13 / I14 | [机检] |
| A62 | 动作面 | 每条命令一份开关清单：用不上的开关报用法错、不许静默忽略；选页方式只能给一个、只接受一个 `--url` | I12 / I17 | [机检] |
| A63 | 动作面 | 五条命令的用法错误面（含 `hover` 的 `--selector` 必给 / `--force` 是开关、`type --text ""` 被拒、`select` 值不在选项里、`wait-for` 条件三选一与"超时 / 间隔必须有"、`--js` 语法当场判） | I11 / I12 / I15 | [机检] |
| A64 | `click` | 几何 + 命中自检 + 真实鼠标事件（`DISPATCHED=2`，不是合成事件）+ 前后比对 | I13 / I14 / I16 | [机检] |
| A65 | `click` | 被遮挡时默认**不发事件**（用法错 2），`--force` 才照原样发并保留 `WARN=` | I16 | [机检] |
| A66 | `click` | 不可见 / 视口外 / 没匹配到三种都拦在发事件之前；命中读数缺失（`elementFromPoint` 没结果）⇒ `unknown`，**不是**"点在目标上" | I16 / I14 | [机检] |
| A67 | `type` | 聚焦成功 ⇒ 一次 `insertText`；焦点没落在目标上 ⇒ **一个字符都不发**；不可输入 / 禁用 / 只读先拦；`contenteditable` 走文本那一类判据 | I13 / I16 | [机检] |
| A68 | `select` | 值在选项里 ⇒ 赋值 + 派发 `input`/`change`；不在选项里 ⇒ 拒绝（不猜）并报可用取值；非 `<select>` / 被禁用先拦 | I13 / I16 | [机检] |
| A69 | `wait-for` | 首次轮询即满足 ⇒ `WAIT=ok` / `POLLS=1`；超时 ⇒ `WAIT=timeout` + 退出码 1（"没等到"的确定读数）；`--url-match` / `--js` 各自成行；探针失败 ⇒ `CHANGED=unknown` | I15 / I14 | [机检] |
| A70 | 真机闭环（无头） | 五条动作命令各至少跑一次（含 `hover`）、逐步打 `CHANGED=` 原文；至少一次 `true`（页面真响应）与一次 `false`（只动了焦点 / 页面没反应） | I14 | [真机] |
| A71 | 真机闭环（无头） | `click` 命中自检：命中别的元素时用法错 2 且**没有** `DISPATCHED=` 行；`--force` 照发后 `CHANGED=false` 且带 `WARN=` | I16 | [真机] |
| A72 | 真机闭环（无头） | `wait-for` 满足 ⇒ `WAIT=ok`；等不存在的元素 ⇒ `WAIT=timeout` + 退出码 1 | I15 | [真机] |
| A73 | 真机闭环（无头） | 两页命中同一个 `--match` ⇒ 动作命令用法错 2（**拒发**，不取第一页） | I17 | [真机] |
| A74 | 真机闭环（无头） | 动作闭环在**临时 profile + 独立端口**上做（不碰用户既有实例），跑完 `close` ⇒ `CLOSED=true`，不留常驻进程 | 红线「谁开的谁收」 | [真机] |
| A75 | 真机闭环（无头） | 页面反应**晚于** `--settle` 取样窗口 ⇒ `CHANGED=false`，紧接着 `wait-for` 给 `WAIT=ok`（证明动作其实生效）—— 这是 `false` 的已知漏报窗口的现场证据 | I14 | [真机] |
| A76 | 动作面 | **决策不在页面表达式里**：探针表达式只**读**原始数据（选项表 `value` 字符串 / `value` / `selectedIndex`）—— 里面**没有** `inOptions`、**没有** `WANT`（不知道请求值 ⇒ 无从按取值特判）、不写 `el.value`、不派发，快照交给 Node 前 `Object.freeze`；写入表达式的形状是 `el.value = WANT;` → `input`（`bubbles: true`）→ `change`（`bubbles: true`）→ `out.dispatched` → **回读** `values` / `value` / `selectedIndex`。表达式层的位置断言（任何一句 needle 缺失即红）**+ 在假文档上真执行探针**（`Object.isFrozen(out.values) === true`、`log.writes` / `log.events` 为空）。needle 是整行字面量：脆但灵敏 —— 它钉的是"形状没变"，**不是**闸门语义本身（语义由 A84 / A85 / A92 / A93 钉） | I16 | [机检] |
| A77 | 选页 | 动作面上 `--url` 与 `--match` 同为**子串**命中；拒发文案报**实际给的那个**开关名（不许写死 `--match`，也不许写"改用 `--url <完整地址>`"） | I17 | [机检] |
| A78 | 零依赖 | `browser/` 下全部 `.mjs` 的模块 specifier 只能是 `node:` 内建或相对 / 绝对路径；覆盖 `import 'p'` / `import x from 'p'` / `export … from 'p'` / `import('p')` / `require('p')` **五种形状**，并另加 clause 跨行、语句不在行首、`export * from`、模板插值里的 `import()`（按形状判，不维护黑名单；抽 specifier 前先剥注释与字符串字面量） | 非功能红线 | [机检] |
| A79 | 真机闭环（无头） | `select` 值不在选项里被拒（退出码 2）后，`eval` 回读 `value` / `selectedIndex` / 关联文本三处都还是原值（拒发真的发生在写页面之前）；正向对照 `select sh` ⇒ `CHANGED=true` 且 `eval` 回读 `value=sh` | I16 | [真机] |
| A80 | 真机闭环（无头） | 元素只改属性、不改文本 ⇒ `CHANGED=false` + `WARN=`，`eval` 回读属性从 `0` 变 `1`（判据域的已知边界，现场证据；设计口径见 `design.md` 的「判据域」一处） | I14 | [真机] |
| A81 | 真机闭环（无头） | `type` 的逐键面：只有 `keydown` 监听器的元素在 `type` 后监听器没跑（`#kdout` 仍 `keydown=0`）而 `value` 变了、`CHANGED=true`；动态装上"只放行数字"的 `keydown` 拦截器后 `type abc` 仍写进去（`eval` 回读 `value=abc`） | I14 / `type` 实现口径 | [真机] |
| A82 | 真机闭环（无头） | 动作闭环全程用**临时 profile + 独立端口 9444**（不碰用户既有实例），跑完 `close` ⇒ `ALIVE=false` / `CLOSED=true`；按命令行过滤该 profile 与端口 ⇒ 无残留进程 | 红线「谁开的谁收」 | [真机] |
| A83 | 动作面 | `select` 派发的 `input` / `change` 必须写 `{ bubbles: true }`，且**真执行**时冒泡到 `document` 上的委托监听（关掉 `bubbles` ⇒ 红 —— 真实页面常用委托） | I16 | [机检] |
| A84 | 动作面 | `select` 闸门是**输入表驱动**的：**十六个**取值（不在选项 / 空串两种 / 大小写近似 `SH` ≠ `sh` / 选项 `value` 与 `text` 不一致两种 / 特判取值 `a1`；R1 的六个表外取值：当场构造的随机串 `q9`、表内取值的五种变异；**再加三个由 `Math.random()` / `Date.now()` 派生的取值，且 expect 不许随机化**）逐个真执行 —— 被拒的一个字节不许写**且写入表达式一次都没跑**（`calls.selectApply.length === 0`）、被接受才写**且 `SELECT_APPLIED=true`**；期望值由选项表**独立**算一遍 | I16 | [机检] |
| A85 | 动作面 | **判定只有一个来源**：`selectProbeExpr` / `selectApplyExpr` 里不许出现 `inOptions`；判定只在纯函数 `decideSelect` 里，且走 `values.includes(want)`；`runSelect` 里 `decideSelect(` 必须排在 `selectApplyExpr(` **之前**；整模块里 `inOptions` 只许以 `decision.inOptions` 的形式被**读**、恰 2 次，且不许被赋值（多一处赋值 / 多一处读就是第二个判定来源） | I16 | [机检] |
| A86 | 零依赖 | 守卫必须看见 clause 跨行 / 语句不在行首 / `export * from` / 模板插值里的 `import()` / **字符串里 `\'` 转义之后紧跟的真 import（R3）**；并登记"自设新形状"的结果（注释不挡检测 = 红；运行期拼出来的 specifier 抽不到 = 已知洞） | 非功能红线 | [机检] |
| A87 | 零依赖 | 字符串字面量与注释里的 specifier 形状**不许**被判成依赖（`const note = "require('ws');";` 这类正当代码判红就是守卫误报） | 非功能红线 | [机检] |
| A88 | 真机闭环（无头） | `select` 的 `change` 真的冒泡到 `document`：`eval` 读委托计数器，`select #city --value sh` 前 `deleg=none`、后 `deleg=sh bubbles=true` | I16 | [真机] |
| A89 | 动作面 | **探针里不许出现写入形状**（**第二层·形状级绊线，不是保证**）：从探针里那句快照构造到 `return out;` 之间，九族形状逐族断言为空 —— 改数组方法（`push`/`splice`/`unshift`/`pop`/`shift`/`sort`/`reverse`/`copyWithin`/`fill`）、别名索引赋值 `\w+\s*\[[^\]]*\]\s*=`、`.length\s*=`、`.\w+.(call|apply)(`、`Reflect.`、`Object.assign`、`Object.defineProperty`、`el.options\s*=`、`el.options\[…\]\s*=`；`Object.freeze(values)` 恰一次且排在 `out.values = values` 之前，`out.values =` 恰一次。**真正的保证来自"决策在 Node 侧 + 写入后回读自证"**（A92 / A93），这一条只提高绕过成本 —— 别名 / 方法变体（`const o = opts; o[o.length] = {…}` / `opts.push.call(…)` / `Reflect.apply(opts.push, …)`）都曾让旧守卫全绿 | I16 | [机检] |
| A90 | 零依赖 | **正则字面量两个方向都不许错**（R2）：`const re = /'/; import x from 'ws';` 必须判红（正则里的引号不许吞掉后面的真 import）、`const re = /import x from 'ws'/;` 必须判绿（正则体里的 import 不算依赖）；字符类 `[/]` 与转义 `\/`、旗标、`return /re/` 各一条；并**把残余局限钉成期望值**（`if (ok) /re/` 这种语句位置的正则认不出来 —— 漏检与误报各一条，修好即红，提醒同步改下面的已知洞表） | 非功能红线 | [机检] |
| A91 | 真机闭环（无头） | **R1 的 CLI 端到端**：同一个表外取值 `q9`，pristine 走 `select --value q9` ⇒ 退出码 2、`OPTION_COUNT=3`、`VALUE_IN_OPTIONS=false`、无 `DISPATCHED`、`eval` 回读三处都是原值；把变异体那一行插进去后同一条命令 ⇒ 退出码 0、`OPTION_COUNT=4`、`VALUE_IN_OPTIONS=true`、`SELECTED_INDEX=-1`、`DOM_VALUE=`、`DISPATCHED=input+change`、`CHANGED=true`，回读 `selectedIndex=-1` 且 `deleg= bubbles=true`（事件真发出去了）—— 单测读数证不了这一层，必须真机 | I16 | [真机] |
| A92 | 动作面 | **`decideSelect` 是判定唯一来源**：纯函数表 —— 普通命中 / 不在选项 / 空串两种 / 大小写近似不命中 / 选项 `value` 与 `text` 不一致时按 `value` 判；数字型 option `value` 也按字符串比；**拿不到选项表（`undefined` / `null`）⇒ 拒绝**（没有数据不许过闸门）；`sample` 只取前 5 个。它不碰页面、不依赖浏览器，普通 JS 就能打靶 | I16 | [机检] |
| A93 | 动作面 | **`selectApplied` 是写入自证唯一来源**：回读里"值在选项表里 + `value` 等于请求值 + `selectedIndex` 指着它在表里的位置"三样对得上才算 `applied:true`；**页面回滚 / `selectedIndex` 错位 / 回读表里没有这个值 / 回读缺字段**四种都算没落地 | I16 | [机检] |
| A94 | 动作面 | **写入被回滚 ⇒ 运行期错（退出码 1）**：受控组件（change 监听把 `this.value` 归位）场景下命令 `runtime` 抛错、`VALUE_IN_OPTIONS=true`、`SELECT_APPLIED=false`，且**事件照发**（`input` / `change` 都发出去了）—— 并有不回滚的正向对照 ⇒ `SELECT_APPLIED=true`。**这是本命令的副作用**：静默成功换成了确定的失败读数 | I16 | [机检] |
| A95 | 动作面 | 探针**没给**选项表（回读里没有 `values`）⇒ 仍然 `usage` 拒绝（退出码 2）、`OPTION_COUNT=0`、写入表达式一次都没跑 —— 数据缺失一律 fail-closed | I16 | [机检] |
| A96 | 动作面 | `type` 回读自证：`typeReadbackVerdict` 三态（读到插入的文本 ⇒ `true`、读到但**不含**文本 ⇒ `false`、选择器读不到 / 面不认识 ⇒ `unknown`）+ 命令层「回读里没有插入文本 ⇒ `TYPE_APPLIED=false` 而判据仍 `CHANGED=true`」（自证与判据是两件事，**都不改退出码**） | I16 | [机检] |
| A97 | 真机闭环（无头） | **现场读数**（原文）：`select #city --value sh` ⇒ 退 0 / `SELECT_APPLIED=true` / `CHANGED=true`；`select #city --value q8` ⇒ 退 2 / `VALUE_IN_OPTIONS=false` / 无 `DISPATCHED` / 见证三处仍是原值；`select #ctrl --value bj`（受控、回滚）⇒ **退 1** / `SELECT_APPLIED=false` / `DOM_VALUE=` / `SELECTED_INDEX=0`；`type #q --text ab` ⇒ `TYPE_APPLIED=true` / `READBACK_KIND=value` / `READBACK_VALUE=ab`；`click #go` ⇒ `HIT_AFTER=button#go` / `HIT_AFTER_IS_TARGET=true`；`click #attr` ⇒ `HIT_AFTER_IS_TARGET=true` / `CHANGED=false`（属性不在判据域） | I16 | [真机] |
| A98 | 残余登记 | 判据原料全来自页面读数 ⇒ **"页面主动撒谎"外部无法分辨**，两条已实测并登记：① 页面连回读一起伪造（闸门放行 + `out.values` / `out.value` / `out.selectedIndex` 全谎报）⇒ 单测红 5 条而 **CLI 端到端 exit 0**（`SELECT_APPLIED=true`，而 pristine `eval` 回读页面其实没变）；② `type` 的回读**表达式**本身被改坏 ⇒ 单测全绿、真机 fail-closed 成 `TYPE_APPLIED=unknown` + `READBACK_NOTE`（不给假成功）。口径见 `design.md` 的「闸门被绕过 / 页面撒谎时，哪条读数还说得上话（残余）」 | I16 / 诚实原则 | [评] + [机检] |
| A99 | `health` | 一条命令给全 `NODE=`（node 可执行文件路径）/ `DSH_HOME=` / `PROFILE=` / `PROFILE_EXISTS=` / `PORT=` / `CHROME=` / `DEFAULT_MODE=` / `ALIVE=`（复用 `cdp.isAlive` 的**纯 HTTP** 探活）/ `PROXY_SET=` / `PROXY_SOURCE=`（那四个代理环境变量**是否存在**），退出码 0；**不报**真实 `MODE=`、**不报** `TABS=`；代理变量有值时只出现存在性、**值一次都不出现**；命令**不 spawn 浏览器、不建 websocket / CDP 会话、不落盘任何状态文件**。`[机检]` 那半钉的是**读数面与文字面**（每一行 `KEY=` 逐字在位、分支里没有 `spawn`、没有 `print(\`MODE=`/`print(\`TABS=`、只经 `envGet` 判存在），**读数本身**（本机 node 路径、Chrome 路径、`ALIVE` 真假、代理变量）只在真机上才取得出来 | I12 / design.md 的「对外接口」 | [机检] + [真机] |
| A100 | `health` | 开关面：`health` 认识且只认识通用开关（`COMMON_FLAGS`）—— `--selector` 这类别的命令的开关必须被 `checkFlagScope` 判成用法错 2，不许静默忽略（`COMMAND_FLAGS` 里漏登记 `health` 会让这条命令在分发前就报"不认识命令"，同样退 2）。**漏登记的守卫**：`test/browser.test.mjs` 从 `USAGE` 命令表里逐行读命令名、逐个与 `COMMAND_FLAGS` 对齐 —— 既有那条泛化断言遍历的是 `COMMAND_FLAGS` 自己的键，漏登记它不会红 | I12 | [机检] |
| A101 | `text --max-bytes` | 小上限下 `BYTES=` 等于真写出去的字节数、`FULL_BYTES=` 是正文原本的字节数、`TRUNCATED=true`；截断**只按 UTF-8 字符边界**（不切碎多字节字符 ⇒ 写出的字节数可以略小于上限，以 `BYTES=` 为准；**切点落在字符内部时退回到它前面那个完整字符之后**，这是 `lib/target.mjs` 的 `truncateUtf8` 的纯函数行为，`[机检]` 钉住）；不带 `--max-bytes` 时 `TRUNCATED=false` 且 `BYTES=FULL_BYTES`（**旧语义逐字未变**：`BYTES=` 仍是这次写出去的正文 UTF-8 字节数）；`--max-bytes` 非整数 / 负数 / 超上限 / 缺值 ⇒ 用法错 2；**与 `--out` 合用 ⇒ 用法错 2**（`--out` 一律写完整正文，两个体积读数不许同时出现） | I11 / design.md 的「对外接口」 | [机检] + [真机] |
| A102 | `hover` | 命令表里有它、被登记成动作命令、开关面与 `click` 同款（认识 `--selector` / `--force` / `--settle` 与三条选页路，不认 `--text` / `--value`） | I12 / I17 | [机检] |
| A103 | `hover` | 只发一次 `mouseMoved`，且参数是**显式 `buttons: 0`**（`DISPATCHED=1`、没有 `button` 字段 ＝ 不按任何键）+ 前后比对；几何 / 命中自检（`HIT_IS_TARGET` 三态）与 `click` 同口径；并且 `click` 的事件序列**未被改动**（仍是 pressed + released 两次） | I13 / I14 / I16 | [机检] |
| A104 | `hover` | 被遮挡时默认**不发事件**（用法错 2）、`--force` 才照原样发（**真机实测**：目标 `#r6btn` 被绝对定位的 `#r6cover` 盖住时，`hover` 默认 ⇒ `HIT=div#r6cover` / `HIT_IS_TARGET=false` ＋ `WARN=指针落点上最上面的元素不是目标（命中的是 div#r6cover）…默认不发事件（要照原样发加 --force）` ＋ `ERROR=…默认不发事件，加 --force 照原样发`、退出码 **2**、没有 `DISPATCHED=` 行、`#r6btn` 上的计数器不变；`--force` 才 `DISPATCHED=1`、退出码 0，`HIT_AFTER=div#r6cover` / `HIT_AFTER_IS_TARGET=false` —— **同页 `click` 同款**：默认退出码 2、`--force` 才 `DISPATCHED=2`，两次都只有盖层收到事件，`#r6btn` 上的计数器 `b_down` / `b_up` / `b_click` 始终 `0`）；不可见 / 视口外 / 没匹配到 / 选择器非法四种都拦在发事件之前（**真机实测**：`display:none` 的元素 ⇒ 退出码 1、`ERROR=hover：元素存在但没有可悬停的区域…`、页面自己的计数器不变）；命中读数缺失（页面把 `elementFromPoint` 覆盖成 `() => null`）⇒ `HIT=(无读数)` / `HIT_IS_TARGET=unknown` + 一句"缺测不许读成'指针进到了目标上'"的 `WARN=`，**按原样发**（真机实测与 `click` 同款：`click` / `click --force` 都 `DISPATCHED=2`、`hover` `DISPATCHED=1`，两者退出码都是 0；不对称的理由见 `design.md` 的残余一节） | I16 / I14 | [机检] + [真机] |
| A105 | `hover`（真机闭环，无头） | 本机自包含 fixture（`%TEMP%\adg-r6\r6.html`，临时 profile + 独立端口 9445 上的本地 HTML，复刻「父项 `mouseenter` → 子容器从内联 `display:none` 变 `block`、子项里是 `<a href>`」）：**反例**先 `eval` 回读子容器 `subDisplay="none"` / `subOffsetParent="null"` / `subRect=[0,0]` / `hasJoin=false`（`body.innerText` 里没有子项文本）；`hover --selector "#r6menu"` 给 `HIT=div#r6menu.r6item`、`HIT_IS_TARGET=true`、`DISPATCHED=1`、`BEFORE … dom=863f192b/86` → `AFTER … dom=4b4f6485/99`、`CHANGED=true` ＋ `REASON=可观测差异：dom / elemtext（共 4 个字段）`、退出码 0；**正例**同一 `eval` 回读翻成 `subDisplay="block"` / `subOffsetParent="[object HTMLBodyElement]"` / `subRect=[1462,21]` / `hasJoin=true`，且 `eval` 从子项读到 `href=https://example.invalid/r6/col26/list`（`c_enter` 0→1、`c_leave` 仍 0）。**"指针真的进去了"的唯一证据是页面自己的事件计数器**（`HIT_AFTER` / `HIT_AFTER_IS_TARGET` 不作此证：`HIT_AFTER` 是动作之后按**新箱子中心**重新解析的、`HIT_AFTER_IS_TARGET=true` 只因 `el.contains(h)`；计数器由 fixture 自己的 `<script>` 挂监听器、**只把次数写进 `window.__c`、不写进任何 DOM 文本** —— 否则那次写入本身就会改 `body.innerText`，把纯样式族的读数污染成 `CHANGED=true`）。同一件事的另一组读数（在 `#r6sub` 上挂只加数的 `mouseenter` ⇒ `window.__c.sub_enter`）：`#r6sub` 还是 `display:none` 时 `hover` 被闸门拦下 ⇒ `VISIBLE=false` / `BOX=0,0,0,0` / `POINT=(无)` / `ERROR=hover：元素存在但没有可悬停的区域（display:none / visibility:hidden / opacity:0 / 零尺寸）：#r6sub —— 真实用户的指针也进不到它上面`、退出码 **1**、`sub_enter` 仍是 `0`；先 `hover` 父项把它展成 `block` 之后跑同一条命令 ⇒ `sub_enter` 变 `1`、`DISPATCHED=1`、退出码 0（`HIT=(无读数)` / `HIT_IS_TARGET=unknown` 时结论同样由计数器给出） | I14 / `hover` 实现口径 | [真机]（读数当场取；逐条命令与原文见本节末的「交付前的最小闭环」） |

**没有自动化判据的部分**：用例总表覆盖「工具做了什么」，覆盖不了「人怎么用它」—— 那部分在「人工 review 项」一节，附量法。

## 守卫的变异自证（已实测的形状；下表每行都是"改哪个文件的哪一处 ⇒ 真跑结果"，第一组改 `select` 闸门与探针）

改本模块的守卫前先读这一节：下面每一条都是**把判据改坏、真跑一遍**量到的（不是推断）。跑法：把整个 `browser/` 拷到临时目录，只改副本里那一处，再在副本里跑 `cd <副本> && node --test --test-isolation=none test`。

| 变异（改哪个文件的哪一处） | 真跑结果 |
|---|---|
| 删 `lib/actions.mjs` 里 `select` 表达式内的 `if (!out.inOptions) { … }` 整块（5 行） | exit=1，`100 / 96 / 4`：A76 位置用例（`表达式的形状变了，找不到 "if (!out.inOptions) {"`）+ A76 真执行用例（`页面被写过了 —— 拒绝必须发生在赋值之前`）+ A84（`不在选项里的普通值：被拒时页面一个字节都不许写`）+ A85；**只删里面的 `return out;`、留着 `if`** ⇒ `100 / 97 / 3`：A76 两条 + A84 |
| `el.value = WANT;` / `hitScopeError` 里的 `${flag}` 等**形状级**改写 | exit=1，`100 / 99 / 1`：A76（`找不到 "el.value = WANT;"`）/ A77（`did not match /^--url file:\/\/\/a\/ 命中 2 页/`） |
| `cli.mjs` / `lib/verify.mjs` 顶部插 `import 'ws';`（含**多行 clause** `import {` 换行 `} from 'ws';`、**不在行首**的 `const zz = 1; import x from 'ws';`、模板插值里的 <code>&#96;${await import('ws')}&#96;</code>） | exit=1，`100 / 99 / 1`：A78（`…\cli.mjs 引了第三方依赖：ws` / `…\lib\verify.mjs …`）—— 五种写法都要认 |
| `lib/verify.mjs` 里插 `const note = "require('ws');";`（**字符串里**的 specifier 形状） | **预期全绿**：`100 / 100 / 0`、exit=0 —— 正当代码不许被判红 |
| 删掉 `scanQuoted` 里 `spans.push([from, i]);`（字符串不再被记成区间） | exit=1，`100 / 98 / 2`：A78 主用例（`…\test\actions.test.mjs 引了第三方依赖：ws, ws, …` —— 守卫咬到自己文件里的样例字符串）+ A87 —— "剥字符串"这一步的哨兵 |
| `cli.mjs` 顶部插 `const p = 'w' + 's'; await import(p);`（运行期拼） | **预期全绿**：`100 / 100 / 0` —— **已知洞**，见覆盖边界 ② |
| `lib/actions.mjs` 里 `bubbles: true` 改成 `false` | exit=1，`100 / 99 / 1`：A83（`input 事件必须写成冒泡的形状，表达式里找不到它`） |
| 闸门前插 `if (WANT === 'a1') out.inOptions = true;`（**行为上无效**：紧接着那行的赋值会覆盖回 `false`） | exit=1，`100 / 98 / 2`：A85 + A89（`闸门判定之前不许出现 WANT —— 出现它就是"按取值特判"`）—— 只有结构断言抓得住它 |
| 闸门整体换成 `out.inOptions = WANT === 'a1' \|\| opts.some(…)`（**真正生效**的按取值特判） | exit=1，`100 / 97 / 3`：A76（`找不到 "out.inOptions = opts.some((o) => o.value === WANT);"`）+ A84（`Missing expected rejection.`）+ A89 |
| `lib/verify.mjs` 里 `页面只改元素属性 / \`class\` / \`style\`` 那一句换掉 | exit=1，`100 / 99 / 1`：`I14 verdictWarn`（`click 的引导句没点名"只改属性 / class / style"这类最常见的漏报面`） |
| **R1**：闸门前改写选项表 —— `opts.push({ value: 'q9' })`（原位置 / 在 `const opts = …` 与 `out.optionCount = …` 之间）、`el.options.push(…)`（**行为上无效**，`opts` 已是快照）、`opts[0] = { value: WANT }`（**真能绕过**）、`opts = opts.concat(…)`（重赋值 ⇒ 闸门里直接抛） | exit=1，`100 / 98 / 2`：A84（`Missing expected rejection.` / `Assignment to constant variable.`）+ A89（逐族各一句：`…[".push("]` / `闸门判定之前不许改 opts 的元素` / `闸门判定之前不许给 opts 重新赋值`）。**加样本（A84）与钉结构（A89）两条都要**：只有样本时换一个取值就漏，只有结构时读不出行为差异 |
| **R1**：闸门换成 `out.inOptions = WANT === 'canon' \|\| opts.some(…)`（按**表内**取值特判） | exit=1，`100 / 98 / 2`：A76（needle 没了）+ A89 |
| **R2 / R3**：清空 `test/actions.test.mjs` 的 `const REGEX_PREV = '…';`（正则识别失效）；删掉 `scanQuoted` 里 `if (src[i] === '\\') { i += 2; continue; }`（转义不跳步） | 各 exit=1，均 `100 / 99 / 1`：R2 红 A90（`正则里的引号不该把后面的真 import 吞掉`）、R3 红 A86 |
| **R4**：`blank()` 改成连 `\n` 一起抹掉 | **预期全绿**：`100 / 100 / 0` —— **已实测无后果**（判据用的正则都吃 `\s`）；登记它只为说明这一条**不是**判据的一部分 |
| **M1–M5**：快照交给 Node 前，用别名 / 方法变体往选项表里加一格 —— **M1** `const o = values; o[o.length] = 'q8';`（别名写法·字符串版）、**M2** 同上但写对象面 `o[o.length] = { value: 'q8' }`、**M3** `values.push('q8')`、**M4** `values.push.call(values, 'q8')`、**M5** `Reflect.apply(values.push, values, ['q8'])` | exit=1，五条同族 ⇒ `105 / 103 / 2`（A76 探针形状 + A89 别名索引赋值那一族）；**CLI 端到端**：**M1 / M3 / M4 / M5** ⇒ **exit 1**（`OPTION_COUNT=4`、`VALUE_IN_OPTIONS=true`、`SELECTED_INDEX=-1`、`DOM_VALUE=`、`DISPATCHED=input+change`、`SELECT_APPLIED=false` + 回读不一致报错 ⟹ **回读自证挡住了**；pristine 同命令是 exit 2），**M2** ⇒ **exit 2**（fail-closed：`OPTION_COUNT=4`、`VALUE_IN_OPTIONS=false`、`WARN=… \| bj \| sh \| [object Object]`） |
| **M6–M9**：**M6** 快照前 `Object.defineProperty(values, 0, { value: 'q8' })`、**M7** 快照前 `values.length = 0`、**M8** **快照之后**（已 `Object.freeze`）`values.push('q8')`、**M9** 冻结之后别名索引赋值 | M6 ⇒ exit=1，`105 / 102 / 3`（A76 + A84 + A89），CLI **exit 1**（`OPTION_COUNT=3`、`VALUE_IN_OPTIONS=true`、`SELECT_APPLIED=false`）；M7 ⇒ exit=1，`105 / 99 / 6`（A76 + A84 + A89 等），CLI **exit 2**（`OPTION_COUNT=0`、`VALUE_IN_OPTIONS=false`、`WARN=…` 空）；M8 ⇒ exit=1，`105 / 99 / 6`，CLI **exit 1**，且 `ERROR=页面内抛错：TypeError: Cannot add property 3, object is not extensible` ⟹ **冻结真的挡住了写**（不再是静默失败）；M9 ⇒ exit=1，`105 / 104 / 1`（A89），CLI **exit 2**（冻结让别名写静默无效 ⇒ fail-closed） |
| **M10 / M10b**：Node 侧决策被改（`if (spec.value === 'q8') decision.inOptions = true;` / 多读一次 `decision.inOptions`） | 单测**曾全绿**（`105 / 105 / 0`，当时是缺口），CLI **exit 1**（回读层挡住）⟹ 据此收紧 A85（禁赋值 + 出现次数恰 2）：再跑 ⇒ exit=1，`105 / 104 / 1` 红 A85；变体 **M10b**（多读一次 `decision.inOptions`）同样红 |
| **M11 / M12**：① 闸门放行 **+ 页面连回读一起伪造**（`out.values = values.concat([WANT]); out.value = WANT; out.selectedIndex = values.length;`）；② 把 `type` 回读表达式里的 `out.kind` 清空 | ① exit=1，`105 / 100 / 5` 红（A76 / A84 / A89 等拦在形状层）；**CLI 端到端 exit 0**：`SELECTED_INDEX=3`、`DOM_VALUE=q8`、`SELECT_APPLIED=true`、`CHANGED=true`，而 pristine `eval` 回读页面仍是 `value=""` / `selectedIndex=-1` ⟹ **残余：页面撒谎时外部分辨不了**（登记在 A98 与 `design.md` 的残余一节）。② **预期全绿**：`105 / 105 / 0`；CLI `exit 0` 且 `TYPE_APPLIED=unknown` + `READBACK_NOTE=回读没有说清这个元素的可读面是什么`（fail-closed，不给假成功）⟹ **残余：回读表达式本身只有纯函数判定被单测钉住**（登记在 A98） |
| **M13 / M14**（各带基线 **117** 条）：删 `lib/actions.mjs` 里 `health: Object.freeze([]),` 一行（**只删副本里这一处**）；把 `lib/target.mjs` 的 `truncateUtf8` 退回"只看切点前一个字节"（`while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end -= 1;`） | M13 ⇒ exit=1，`117 / 115 / 2` 红 `A100 命令表与开关清单对齐`（`AssertionError: USAGE 里有 health 但 COMMAND_FLAGS 没登记 —— 这条命令会 100% 不可用`）+ `A100 health 的开关面`（`AssertionError: COMMAND_FLAGS 必须登记 health`）—— 这就是"漏登记 ⇒ 命令不可用"的 `[机检]` 载体（既有那条泛化断言遍历 `COMMAND_FLAGS` 自己的键，删了对它无影响）。M14 ⇒ exit=1，`117 / 116 / 1` 红 `A101 truncateUtf8 截在字符边界上`（`AssertionError: 切在 emoji 之后 ⇒ 整只 emoji 都在` / `+ body: 'A\ufffd'`、`+ bytes: 2` vs `- body: 'A😀'`、`- bytes: 5` —— 这一版把 `A😀B` 截成 `A` + 半个 emoji，正是**真机 stdout 里会出现的乱码**；补上"退回首字节"那一步才转绿）。**`hover` 的 6 条用例加进来之后两者的红条数完全相同** |

**以下为已实测的形状，非穷举。老守卫重跑确认**：换架构之后逐条确认上一轮红过的守卫**没有回绿** —— P1 `bubbles: true` → `false`（A83）、P2 `${flag}` 写死成 `--match`（A77）、P3 顶部 `import 'ws';`（A78）、P5 清空 `REGEX_PREV`（A90）、P6 去掉转义跳步（A86）、P7 删掉 `if (!applied.applied) { throw … }`（A94）、P8 删掉探针里 `Object.freeze(values);`（A76 + A89）、P9 `inOptions: values.includes(want)` 改成 `inOptions: true`（恒真放行：A13 + A76 + A84 + A85 + A92 + A95），八个都仍是 exit=1；P4 / P4b 见覆盖边界 ①下的说明。

**覆盖边界**：守卫扫的是 `browser/` 下**全部** `.mjs`（`mjsFiles(path.dirname(LIB))`，含 `cli.mjs` / `lib/` / `test/`），五种已知局限：

① 只扫 `.mjs` —— `.cjs` / `.ts` 不在面内（当前 `browser/` 没有这类文件，属**未来隐患**：真要引入这两种扩展名，`mjsFiles` 必须一起改）。**只改字形不改含义的变异无后果**：把 `lib/verify.mjs` 的 `ATTR_BLIND` 只去掉粗体标记（P4）⇒ 全绿；真删掉点名的面（去掉"元素属性"，P4b）⇒ exit=1（`I14 verdictWarn`）。
② **运行期拼出来的 specifier**（`const p = 'w' + 's'; await import(p)`）抽不到 —— 文本扫描只保证字形（上表实测全绿）。要挡住它只能改成"运行期探针"（真加载一次），那是另一种判据，本次不做。
③ 把 `import 'ws';` 插进**被测试文件静态 import** 的模块（例如 `lib/verify.mjs` 的行首）时，Node 在**加载期**就失败 —— 看到的是 `actions.test.mjs` 整个文件加载不起来（`tests 49 / pass 48 / fail 1`），而不是 A78 的断言。它由等价形状（`if (false) { await import('ws'); }`，不改加载行为）证明覆盖。**断言文本必须点名裸包名与文件路径**，否则"模块加载失败"那种红会被误读成守卫生效。
④ **正则字面量只按启发式认**（`scanCode` 的 `canStartRegex`）：`/` 的前一有效字符是 `)` / `]` / 标识符或数字时**一律当除法**，所以约位于语句开头的正则（`if (ok) /re/.test(s)`）认不出来，两个方向都会错：正则体里奇数个引号会把同行后面的真 import 一起吞掉（**漏检**），正则体里写着 `import x from 'ws'` 会被当成真依赖（**误报**）。两族都已由 A90 末尾两条"已知洞"断言**钉成期望值**（修好即红，提醒同步改本节）；`=` / `(` / `,` / `:` / `return` / `case` 等位置的正则已能正确认（上表 R2 为哨兵）。要彻底消歧得上真正的词法分析，本次不做。 ⑤ **`select` 闸门的正确性不靠文本扫描**。现在的两层是：**保证** ＝「决策在 Node 侧纯函数 `decideSelect` 里」+「写入后回读自证（`selectApplied`，不一致 ⇒ 退出码 1）」；**文本扫描**（A89 对探针表达式、A85 对模块里 `inOptions` 的出现次数）只提高绕过成本、**只按形状抓**，抓不到的形状一律靠回读层兜底（上表 M1–M9 的 CLI 端到端读数都是 exit 1 / 2）。**已知的、回读层也兜不住的一族**：页面**连回读一起伪造** —— 单测红、CLI 端到端却 `exit 0`（M11）；同族的还有 `type` 的**回读表达式本身被改坏**（M12：单测全绿、真机 fail-closed 成 `TYPE_APPLIED=unknown`，不给假成功）。这一类**不是**"守卫写漏了"，而是"判据原料全部来自页面读数"的固有代价；逐条登记在 A98 与 `design.md` 的「闸门被绕过 / 页面撒谎时，哪条读数还说得上话（残余）」一节，**不许说成已封住**。

## 迁移矩阵

「目标模式」＝显式旗标 > `ADG_BROWSER_MODE` > 工具默认（无头）；**只有前两者算「显式要求」**（I4 ②）。格子里写目标状态；`非法`＝必须报错且不改状态。下面第一张是 **BrowserInstance**（行＝起始状态，列＝事件）

| 起始状态 | `launch`·目标模式＝活实例模式 | `launch`·目标是另一种模式（**显式**要求） | `launch`·目标是另一种模式（**未**显式要求） | `launch`·探测不到且找到浏览器 | `launch`·等待超时 | `close` | 手工 kill | `text` / `eval` / `shot` |
|---|---|---|---|---|---|---|---|---|
| absent | start → starting → live | start → starting → live | start → starting → live | start → starting → live | 停在 starting，报错 | 无操作（端口本来就不通） | 无操作 | 报错：先跑 `launch` |
| starting | reuse（不再 spawn） | 等端口起来后再判；**两个 `launch` 同时抢换模式未观测** | reuse | 不重复 spawn | 报错 | 无操作 | 进程消失，回到 absent | 报错：端口还没起来 |
| live | reuse（I5） | switch：close → 等端口落下 → 按目标模式重开 → live | reuse（I4 ②，输出说明「没有动它」） | 不适用 | 不适用 | closed | 进程消失，回到 absent（跳过落盘） | 正常执行 |
| closed | start → starting → live | start → starting → live | start → starting → live | start → starting → live | 停在 starting，报错 | 无操作 | 无操作 | 报错：先跑 `launch` |

**PageSession**（三列：起始状态 | `goto` / `text` / `evalJs` / `shot` | `close`）：`open` ⇒ 执行并保持 open / → closed；`closed` ⇒ 非法（报 `ERROR=CDP 连接已关闭`）/ closed（自环，幂等）。**PageTab**（四列：起始状态 | 操作 | `Target.closeTarget` | 已关闭的 target 再关）：`created = true`（本命令自己开的临时页）⇒ 命令结束 → 自动收走、`--keep` → 保留 / → closed / 幂等，不报错；`created = false`（别人开的页）⇒ 命令结束 → 一律不碰 / 只有调用方 `--match` / `--tab` 点名才关 / 幂等，不报错；`已关闭 target` ⇒ 不适用 / 不适用 / 幂等，不报错。

## 消费方契约测试

技能里写的每条 `node cli.mjs …` 都必须真实存在 —— 契约一改，技能的指示就指向不存在的命令。运行模式特有的输出行：`MODE=` / `DEFAULT_MODE=` / `SWITCHED_FROM=` / `STATE=SWITCHED`。

过期检测（换出真实命令名，逐个对照）：

```sh
node cli.mjs help                                                                    # 契约真相源
Select-String -Path skills\adg-browser-use\SKILL.md -Pattern 'cli\.mjs' -Encoding UTF8      # 取出技能提到的每条命令
# `install.ps1` / `install.sh` 消费的是目录名：两个脚本都按目录名 `browser` 定位源与落点
#   （`$browserSrc` / `$browserDest` 与 install.sh 里的对应变量）
```

判据：**`skills/adg-browser-use/SKILL.md`** 里出现的命令名与选项都能在 `help` 的输出里找到同名项，出现「技能让子代理跑 A、而 `help` 里没有 A」即失败；改目录名时两个安装脚本的源与落点必须同时改到（只改一处会让脚本拷不到东西或拷到旧路径）。

## 人工 review 项

一行一条「症状 → 判据 → 量法」；每条都写出量法与可复跑判据 —— **未观测**的条目在症状列写明 `**未观测**：<问题>`，有对照读数的在判据列写明 `**已观测**：<读数>`（**未观测的结论不许写成实测**）。

| 症状（这条判据看不见什么） | 判据 / 已观测到的对照 | 量法（可复跑） |
|---|---|---|
| 真实站点的登录墙 / 验证码端到端 —— 本模块**最重要**的一条未观测项 | 验到的只是机制（有头窗口能开、跨工具调用还能 CDP 重连、能继续驱动同一实例） | 让一次真实 Adg 会话走完「调度者按拿不准判定先无头开抓 → 撞墙 → 子代理按登录协议换有头 → 子代理用 `ask_user` 问用户（卡片落在调度者与用户对话的那个会话里）→ 用户在有头窗口里登录 / 过验证并作答 → 子代理拿到答复后**自己复核一次登录态**（`text --match <站点>` 或 `eval` 取一份独立读数）→ 抓到登录后的内容」 |
| **未观测**：子代理是否真的照技能与委派 prompt 用这套工具 | 没有真实 Adg 会话走过 | 转写里检索 `cli.mjs` 调用；出现现场手写 CDP 脚本即技能与委派 prompt 未被遵守 |
| **未观测**：收尾的点名清理（工具侧护栏与自动收页都有判据，但子代理收尾时会不会主动 `close-tab` 点名清理、会不会关掉该留的页没有真实会话为证） | — | 任务收尾时对比 `tabs` 报出的 `TABS=` 与该任务开始时的值，显著增长即纪律未被遵守 |
| **未观测**：超时 / 失败清理分支（不可达站点不会让浏览器挂住 ⇒ 只有源码级断言，A36 / A37） | 期望报「页面在 30000ms 内没有进入可读状态」 | 用一个在 `--wait` 之外既不进入可读状态、也不报错的本地页面跑 `text --url`，且 `TABS=` 与跑之前相同 |
| **未观测**：macOS / Linux（候选路径与两种模式的启动都没在那两个平台上跑过；单元用例只钉了 win32 的候选形状） | — | 在那两个平台上跑 `node cli.mjs profile` 与「交付前的最小闭环」全序列 |
| **未观测**：`install.sh` 在 Windows 上（本机没有 `sh`，两平台安装落点只做了人工核对） | — | 在对应平台上跑一次安装脚本，再用部署后的副本跑 `node cli.mjs profile` |
| **未观测**：多实例并发同一端口（迁移矩阵的 `starting` 行两格按推断登记） | 看是否有 `RETRY=` 与最终 `MODE=` | 同一个端口起两个 `launch`（一个显式换模式、一个探测） |
| **未观测**：人为时序：用户正在有头窗口里操作时被 `--headless` / `close` 打断（I4 ③ 的已知代价；不带旗标的 `launch` 已被 A49 挡住） | 记录 `STATE=` 与用户侧窗口的结局 | 用户在有头窗口里操作时跑一次带 `--headless` 的 `launch` |
| **未观测**：受限令牌下的失败签名（`read-only` 策略下没量过；`workspace-write` 下已观测到浏览器起不来，三条签名文本与判读口径见 `browser/AGENTS.md` 的「红线」一节） | 与那一节的三条签名对照 | 在 `read-only` 会话里跑一次 `launch`，记下退出码与 stderr 首行 |
| 动作判据看不见的效果（漏报面）：纯 JS 变量 / 网络请求 / 属性与 `class` / 靠 `isTrusted` 分支 / 反应晚于 `--settle` | **已观测两例**：属性那类（A80：`click #attr` ⇒ `CHANGED=false`，`eval` 回读 `data-hit` 从 `0` 变 `1`）、反应晚于取样窗口（A75）。运行时引导句（`browser/lib/verify.mjs` 的 `ATTR_BLIND`，五条动作命令的 `WARN=` 末尾都带）也点名这一类，它 / `design.md` 的「判据域」/ 本表三处口径一致（A14 逐条机检"点没点名"）。**未观测**：剩下三类没量化过 | 本地 fixture 让监听器只改 JS 变量、或只发一次 `fetch` 而不改 DOM，跑动作命令看读数（预期 `false`），再用 `eval` 读回那个变量 / 数请求条数 |
| **未观测**：「TLS / 证书族失败」与「代理空壳页（HTTP 200 但正文极短）」在现有读数下能不能区分 | 现有读数里没有证书 / TLS 错误面，也没有"这页其实是代理出的空壳"的判据（`text` 只看标题 / 地址 / 正文；`health` 只报代理变量**是否存在**）。**上游文档把"两者不可区分"标成推断，本模块没有实测过** —— 不许写成已实测不可区分，也不许写成可区分 | 直连 vs 走代理对比：同一地址在（a）无代理环境变量与（b）`HTTPS_PROXY` 指向一个可用 / 一个不可达代理下各跑一次 `text --url`，记下退出码、`ERROR=` 原文（区分 `ERR_CERT_*` / `ERR_PROXY_*` / `ERR_TUNNEL_*` 几族名字）与 `BYTES=`；再对一个"走代理才拿得到"的地址看 `BYTES=` 是否坍缩到极短正文。判据是**两族读数的可分辨性**，不是某次的具体数字；读数齐了再回填本节 |
| **未观测**：`text` 抓大页面的体积量级 | 没量过"正常重正文页面一次打多少字节"，也没量过默认（不截断）下 stdout 会被撑到多大。**本条不写死任何字节数当锚**（`design.md` 的「对外接口」：字节数一律当场读数、不作锚） | 本地造一个大正文 fixture（仓库外临时目录的 `file://` HTML，一行固定文本重复几百遍）跑 `node cli.mjs text --url "<那个地址>"` 记 `BYTES=` / `FULL_BYTES=`，再跑 `--max-bytes <小值>` 记 `TRUNCATED=`；要跟真实站点比时另找一个不需要登录的大正文页面重复同样两步 |
| **未观测**：同一 profile 被两条子代理线**轮流**使用（量过的是"同一端口多实例并发"，不是"轮流换手"——每次换手都可能碰到前一条线留下的活实例、标签页与临时页） | `TABS=` 不随轮次单调增长、`RETRY=` 每次为 0 或能解释成端口正在起来的正常重试；需要重试才起来、或标签页只增不减即纪律没被遵守 | 两条线按 A → 收尾 → B → 收尾 → 再 A 各跑一轮带读页与动作的闭环，每轮前后记 `tabs` 的 `TABS=` 增量与 `launch` 的 `RETRY=`，看第二 / 三轮 `STATE=` 是 `REUSED` 还是 `STARTED`（`STARTED` 意味着上一轮把实例关掉了） |
| `type` 与逐键事件（`keydown` / `keyup`）：真实站点上靠 `keydown` 做输入校验 / 只认 `isTrusted` 逐键事件的页面占多大比例，以及判据那个 `true` 会不会被调用方误读成"页面接受了这段输入" | **已观测**：`type` 走 `Input.insertText`，逐键事件一次都不发 —— 只有 `keydown` 监听器的元素在 `type` 后监听器没跑（A81 的 `#kdout` 仍 `keydown=0`），"只放行数字"的 `keydown` 拦截器拦不住 `type`（A81：`abc` 照样写进去，`eval` 回读 `value=abc`）；此时判据报 `CHANGED=true`，因为 `value` 真的变了 | 找一个用 `keydown` 拦非数字输入的表单页（或本地 fixture 复刻），跑 `type` 后同时读 `value` 与该页自己的校验提示，把"判据读数"与"页面是否真接受"并排记下来 |
| `--settle` 默认值够不够（150ms 对异步渲染的慢页面够不够没量过；判据只保证"取 `AFTER` 之前等过 settle"） | 窗口不够的**一例已观测**：A75 的 `click #later` ⇒ `CHANGED=false`；`--settle` 该取多大仍未观测 | 本地 fixture 让监听器延迟 500ms 才改 DOM，分别用默认与 `--settle 800` 跑 `click`，比较两次 `CHANGED=` |
| **未观测**：`type` 与真实输入法 / 组合字符（`Input.insertText` 在输入法候选、emoji 组合序列下的行为只按 CDP 语义推断） | 验收给的是直接字符串，`TEXT_BYTES=` 是 UTF-8 字节数 | 在有头窗口里手动敲同样内容，再用 `eval` 读回 `value.length` 与字节数，对比 `TEXT_CHARS=` / `TEXT_BYTES=` |
| **未观测**：`elementFromPoint` 在滚动容器 / iframe 里（命中自检只在本机 fixture 的普通文档流 + 绝对定位覆盖层上量过） | 看 `VISIBLE` / `IN_VIEWPORT` / `SCROLLED` / `HIT_IS_TARGET` 四个读数是否仍然自洽 | 做一个"滚动后才进入视口"的目标 fixture 与一个 iframe 内目标的 fixture |
| **未观测**：`select` 的原生下拉 UI（本命令走 DOM 赋值 + 派发事件，**没有**模拟点开原生下拉） | 只看 `isTrusted` 的页面会显示 `CHANGED=false` | 找一个用 `isTrusted` 判选的页面，跑 `select` 看读数与页面自身状态是否分离 |
| "页面主动撒谎 / 主动回滚"这一族：真实站点上这三类的占比（框架把 `value` 归位 / 只在 JS 变量里记状态 / 组件库自己重写 `select` 结构），以及调用方会不会把退出码 1 误读成工具坏了 | **已观测两例**：① 页面连回读一起伪造 ⇒ 单测红而 **CLI 端到端 exit 0**（M11）；② `type` 回读表达式被改坏 ⇒ 单测全绿、真机 fail-closed 成 `TYPE_APPLIED=unknown`（M12）。**也已观测**受控组件把选择回滚：`select` 报**退出码 1** + `SELECT_APPLIED=false`（A97 的 `#ctrl`；这是本命令的副作用 —— 静默成功换成确定的失败读数） | 换成 React / Vue 的本地 fixture（受控 `<select>`、受控 `<input>`）各跑一遍 `select` / `type`，把"命令退出码与自证读数"和"页面自身状态"并排记下来；页面伪造回读那一类只能靠"页面的独立证据"（例如页面把状态同时写进 `localStorage` 或另一次 `eval` 读回别的引用）对照 |
| 纯 CSS `:hover` 那一族里，真实站点上这四族各占多少，以及这一族配合页面自己的 JS 反应时的读数 | **已观测**（真机，本机自包含 fixture `%TEMP%\adg-r6\r6.html`，零 JS 三族同页并排，每族在指针还停着那一刻 `eval` 回读；`visibility` 另造 `%TEMP%\adg-r7\r7vis.html`、独立端口 9446 补测）：① `display` 族（`.r6card:hover .r6open { display: block }`）⇒ `CHANGED=true`、`dom=863f192b/86 → f87bdc76/105`、`REASON=可观测差异：dom / elemtext`（`display:none → block` 把子元素文本带进 `body.innerText` ⇒ 判据**看得见**；回读 `openDisplay` `"none"` → `"block"`、`openRect` `[0,0]` → `[1462,21]`）；② `opacity` ⇒ `CHANGED=false`（两侧同为 `dom=863f192b/86`，回读 `fadeOpacity` `"0"` → `"1"`）—— 真·假阴性；③ `background-color` ⇒ `CHANGED=false`（两侧同哈希，回读 `card3Bg` `"rgba(0, 0, 0, 0)"` → `"rgb(255, 221, 221)"`）；④ `visibility` 族（`.vis { visibility: hidden }` + `#r7card:hover .vis { visibility: visible }`） ⇒ `CHANGED=true`、`dom=8b39379a/59 → 4e0b3c2a/69`、`elemtext=8853ec9f/10 → 4b1ece4f/20`，回读 `getComputedStyle(#r7vis).visibility` `"hidden"` → `"visible"`（隐藏时 `innerText` 不含 `显隐项`）⇒ `visibility` 与 `display` 同属"看得见"一族，**但回读方式不同**：`visibility` 变化时 `offsetParent` 仍是 `[object HTMLBodyElement]`、`visRect` 仍是 `[1462,21]`（箱子不变、只是不画），只能靠 `getComputedStyle(...).visibility` 回读。**复位那一步自己会报 `CHANGED=true`**（它把上一族展开收回去），别读成"fixture 自己变了"。**判据的边界是"这次变化有没有落在可比字段上"，不是"样式 vs 非样式"**（与 `design.md` 的残余一节同口径） | 真机复量：fresh fixture（`%TEMP%\adg-r8\r8.html`、独立端口 9447）`hover #d8card` ⇒ `BEFORE dom=3d53899c/75` → `AFTER dom=5c9e140e/91`、`CHANGED=true`、`REASON=可观测差异：dom / elemtext（共 4 个字段）`、`exit 0`，同刻 `eval` 回读 `body.innerText` 恰为 **75 → 91 字节**（43 → 49 字符）⇒ 与 `dom=` 那对数逐字节相等；`visibility` 族 ⇒ `…/75 → …/85`、回读 75 → 85 字节（43 → 47 字符）、`offsetParent` 始终 `[object HTMLBodyElement]`、`visRect` 始终 `[1464,17]`。前态干净时 `hover --selector "#hint"`（空白区、无监听器）⇒ `CHANGED=false`、`REASON=可比读到的 url / title / dom / scroll / active / tabs / elem 都没有变化（本次判据只覆盖这些类）`、`exit 0`；`hover #d8card` 之后再 `hover #hint` ⇒ `CHANGED=true`、`REASON=可观测差异：dom（共 2 个字段）`，回读 `innerText` 回基线 75 字节 / 43 字符、`dopen` 回 `"none"`（`visibility` 族同理：park 后回 `"hidden"`） |
| 变异自证基线随新增用例重量（新增用例会不会悄悄改掉某个变异体的红条数） | **已观测**：`hover` 的 6 条用例进来之后在 **117** 条树上复测 —— M13 ⇒ exit=1、`117 / 115 / 2`（红 `A100 命令表与开关清单对齐` + `A100 health 的开关面`，与 111 条时红的两条相同）；M14 ⇒ exit=1、`117 / 116 / 1`（红 `A101 truncateUtf8 截在字符边界上`，同上）⇒ 新增用例没有改变任何变异体的红条数，本节基线按 117 记 | 照「守卫的变异自证」一节的跑法复跑 M13 / M14 两组；**两条量法上的口径**（上表反复用到）：**`dom=` 那个 `/N` 是字节、不是字符**（`lib/verify.mjs` 用 `Buffer.byteLength(document.body.innerText)`）、**别把页面计数器写进 DOM 文本**（`#hits.textContent = …` 那次写入本身会改掉 `body.innerText`，把 `opacity` / `background-color` 两族的读数污染成 `CHANGED=true`）—— 计数器只写进 `window.__c`，用独立 `eval` 回读 |

## 交付前的最小闭环

改了 `browser/` 任何东西之后，单元测试全绿之外还要跑一次真机序列（**要有能在该会话里起浏览器的权限**；受限策略下浏览器起不来，三条失败签名与判读口径见 `browser/AGENTS.md` 的「红线」一节）。跑完对照「用例总表」的 A46–A54、动作面的 A70–A98。

动作面那一段只碰**本地 fixture**（`file://` 的临时 HTML，不进仓库；`--profile` 用临时目录 + 独立端口，避免动用户既有实例），不访问外部站点、不登录，全部在**无头**下跑。

```sh
cd browser && node --test --test-isolation=none test    # 全绿
node cli.mjs profile                                    # A46：CHROME= 指向本机实际装着的那个浏览器
node cli.mjs launch                                     # A47：STATE=STARTED、MODE=headless
node cli.mjs launch                                     # A47：STATE=REUSED、MODE=headless、无 RETRY=
node cli.mjs launch --headed                            # A48：SWITCHED_FROM=headless、CLOSED=true、STATE=SWITCHED、MODE=headed
node cli.mjs launch                                     # A49：STATE=REUSED、MODE=headed、**没有** SWITCHED_FROM=
node cli.mjs launch --headless                          # A48：换回无头（显式要求才换）
node cli.mjs eval --js "navigator.userAgent"            # A41 的真机侧：UA 里能判读出模式
node cli.mjs tabs                                       # 记下 N
node cli.mjs text --url https://example.com/             # A50：打 TAB_CLOSED=、正文非空、TABS 仍是 N
node cli.mjs close-tab --match example.com               # A51：只剩一个页时须被拒（退出码 1、ALIVE=true）
node cli.mjs close                                       # A53：ALIVE=false、CLOSED=true
node cli.mjs status                                      # A53：MODE=none
node cli.mjs health                                      # A99：NODE= / 那 6 行等价读数 / ALIVE= / PROXY_SET= / PROXY_SOURCE=；**没有** MODE= / TABS=，退出码 0
node cli.mjs health --selector "#go"                     # A100：用法错 2（health 不认识别的命令的开关）
# —— `--max-bytes`（A101）：先造一个仓库外的本地大页 fixture（临时目录里的 file:// HTML，正文足够长），同一个地址跑三次对比 —— 不截断 / 小上限 / 与 --out 合用（后者必须退 2）——
node cli.mjs text --url "file:///<大页 fixture 绝对路径>"                      # A101：BYTES=FULL_BYTES、TRUNCATED=false；字符边界那一格（单一元用例抓不到"stdout 里出现半个字符"）：再造一个小页，正文以 emoji 开头（例如 `A😀B` + 若干行），`--max-bytes` 给小到落在 emoji 里面（如 2、3）⇒ BODY 必须是完整的 `A`（不许出现 U+FFFD 乱码）；给 5（正好切在 emoji 之后）⇒ BODY 是 `A😀`。真机读数见 M14 那条自证
node cli.mjs text --url "file:///<大页 fixture 绝对路径>" --max-bytes 50        # A101：BYTES<=50、FULL_BYTES=正文全长、TRUNCATED=true
node cli.mjs text --url "file:///<大页 fixture 绝对路径>" --max-bytes 50 --out "$env:TEMP\adg-max.txt"   # A101：用法错 2

# —— 动作闭环（A70–A82）：自有实例 + 本地 fixture，全程无头 ——
# fixture 是本地 HTML / file:// / 不进仓库，须含：#go（点一下把 #count 文本改掉）、#plain（无监听器的普通 div）、#covered 被 #cover 绝对定位盖住（命中自检用）、#q（监听 input 把值写到 #echo）、#city（三个 option：""/bj/sh，监听 change 写到 #picked）、#later（点后 300ms 把 #late 从 display:none 改成 block）、#attr（click 只 setAttribute 不改文本 —— A80 的判据域边界用）、#kd（只有 keydown 监听器，把触发次数写进 #kdout —— A81 的逐键面用）、#ctrl（**受控** select：change 监听把 this.value 归位 —— A94 / A97 的回滚用）、#deleg（document 上注册 change 委托监听，把收到的值写进它的文本 —— A88 的冒泡用）、#never（不存在，超时用）、#r6btn 被 #r6cover 绝对定位盖住（A104 的遮挡那组用）、#hint（空白区、无监听器 —— 每族量前把指针停到它上面复位，**复位这一步自己会报 `CHANGED=true`**）；#r6menu 父项（`mouseenter` 监听把 #r6sub 从**内联** display:none 改成 block，`mouseleave` 改回 —— A105 的 hover 用），#r6sub 里放一个 `<a id="r6link" href="...">`（验证"展开后能从子项拿到 href"）；#r6card / #r6card2 / #r6card3 是零 JS 的三族纯 CSS `:hover`（`.r6card:hover .r6open { display: block }`、`.r6card2:hover .r6fade { opacity: 1 }`、`.r6card3:hover { background-color: rgb(255, 221, 221) }` ——「判据看得见什么」那三组读数的实测来源）；#r6menu 与三族的读数都要用 `eval` 独立回读（**所有 `mouseenter` / `mouseleave` / `mousedown` 计数只写进 `window.__c`，不许写进任何 DOM 文本**）。读页命令（eval / text / shot）的 `--url` 是"要读的完整地址"，动作命令的 `--url` 是子串命中 —— 下面一律用 `--match` 选页，免得两条语义混起来（见 design.md 的 I17）。
node cli.mjs launch --port 9444 --profile "$env:TEMP\adg-browser-fixture\profile" --url "file:///<fixture 绝对路径>"   # click / type / select / wait-for：单页时 --match 可省，多页选页一律用 --match 子串
node cli.mjs click --selector "#go" --port 9444 --match adg-browser-fixture      # A70：CHANGED=true（页面真响应）
node cli.mjs click --selector "#plain" --port 9444 --match adg-browser-fixture   # A70：CHANGED=false（没人监听它）
node cli.mjs click --selector "#covered" --port 9444 --match adg-browser-fixture # A71：命中自检 ⇒ 用法错 2、无 DISPATCHED
node cli.mjs click --selector "#covered" --force --port 9444 --match adg-browser-fixture   # A71：照发 ⇒ CHANGED=false + WARN=
node cli.mjs type --selector "#q" --text "你好 adg" --port 9444 --match adg-browser-fixture   # A70：CHANGED=true（value 那类）
node cli.mjs select --selector "#city" --value sh --port 9444 --match adg-browser-fixture     # A70：CHANGED=true（selected/value）
node cli.mjs click --selector "#later" --port 9444 --match adg-browser-fixture   # A75：页面 300ms 后才变 ⇒ CHANGED=false（默认 150ms 的取样窗口不够）
# —— hover（A105）：反例（先不 hover）→ hover → 正例，用 eval 独立回读子容器三读数；本组实测端口是 9445（其余动作面行用 9444）——
node cli.mjs eval --file "$env:TEMP\adg-r6\probe.js" --port 9445 --match r6.html   # 反例：subDisplay=none / subOffsetParent=null / subRect=[0,0] / hasJoin=false
node cli.mjs hover --selector "#r6menu" --port 9445 --match r6.html   # A105：DISPATCHED=1 + HIT_IS_TARGET=true + CHANGED=true（REASON：dom / elemtext；dom=863f192b/86 → 4b4f6485/99）
node cli.mjs eval --file "$env:TEMP\adg-r6\probe.js" --port 9445 --match r6.html   # 正例：subDisplay=block / subOffsetParent=[object HTMLBodyElement] / subRect=[1462,21] / hasJoin=true（计数器 c_enter +1）
node cli.mjs eval --js "document.querySelector('#r6link').href" --port 9445 --match r6.html   # A105：展开之后能从子项拿到 href ⇒ https://example.invalid/r6/col26/list
node cli.mjs hover --selector "#r6card" --port 9445 --match r6.html   # 对照：指针离开父项 ⇒ 真实 mouseleave（c_leave +1）⇒ 子容器回到 subDisplay=none / subRect=[0,0]
node cli.mjs wait-for --selector "#late" --visible --timeout 3000 --port 9444 --match adg-browser-fixture   # A75：WAIT=ok ⇒ 上一步其实生效了（A72 同此）
node cli.mjs wait-for --selector "#never" --timeout 400 --interval 100 --port 9444 --match adg-browser-fixture   # A72：WAIT=timeout、退出码 1
# —— A73 / A79 / A80 / A81 / A88：两页选页与"判据看得见什么、看不见什么"（都要读原文读数，别转述）——
node cli.mjs click --selector "#go" --port 9444 --match fixture    # A73：两页命中 ⇒ 用法错 2（先把 fixture 开成两页）
node cli.mjs eval --js "document.querySelector('#city').value" --port 9444 --match adg-browser-fixture   # A79 前置：记下原值
node cli.mjs select --selector "#city" --value zz --port 9444 --match adg-browser-fixture   # A79：值不在选项里 ⇒ 退出码 2、无 DISPATCHED
node cli.mjs eval --js "document.querySelector('#city').value" --port 9444 --match adg-browser-fixture   # A79：仍等于原值 ⇒ 一个字节都没写
node cli.mjs eval --js "document.getElementById('attr').getAttribute('data-hit')" --port 9444 --match adg-browser-fixture   # A80 前置：0
node cli.mjs click --selector "#attr" --port 9444 --match adg-browser-fixture   # A80：CHANGED=false（属性不在判据域里）
node cli.mjs eval --js "document.getElementById('attr').getAttribute('data-hit')" --port 9444 --match adg-browser-fixture   # A80：1 ⇒ 动作其实生效
node cli.mjs eval --js "document.getElementById('kdout').textContent" --port 9444 --match adg-browser-fixture   # A81 前置：keydown=0
node cli.mjs type --selector "#kd" --text ab --port 9444 --match adg-browser-fixture   # A81：CHANGED=true（value 变了）
node cli.mjs eval --js "document.getElementById('kdout').textContent" --port 9444 --match adg-browser-fixture   # A81：仍 keydown=0 ⇒ 逐键事件一次都没发
# —— A88：change 真的冒泡到 document（document 级委托监听）——
node cli.mjs eval --js "document.getElementById('deleg').textContent" --port 9444 --match adg-browser-fixture   # A88 前置：deleg=none
node cli.mjs select --selector "#city" --value sh --port 9444 --match adg-browser-fixture   # A88：CHANGED=true
node cli.mjs eval --js "document.getElementById('deleg').textContent" --port 9444 --match adg-browser-fixture   # A88：deleg=sh bubbles=true ⇒ 委托监听收到了
# —— A91 / A92–A97：决策在 Node 侧 + 写入后回读自证 ——
node cli.mjs select --selector "#city" --value q9 --port 9444 --match adg-browser-fixture   # A91：表外取值 ⇒ 退出码 2、VALUE_IN_OPTIONS=false、**没有** DISPATCHED、写入表达式一次都没跑
node cli.mjs eval --js "document.querySelector('#city').value" --port 9444 --match adg-browser-fixture   # A91：仍是原值 ⇒ 拒发真的在写页面之前
node cli.mjs select --selector "#city" --value sh --port 9444 --match adg-browser-fixture   # A92：退 0、SELECTED_INDEX=2、DOM_VALUE=sh、SELECT_APPLIED=true、CHANGED=true
node cli.mjs select --selector "#ctrl" --value bj --port 9444 --match adg-browser-fixture   # A94：受控组件把写入回滚 ⇒ **退出码 1**、SELECT_APPLIED=false、DISPATCHED=input+change
node cli.mjs eval --js "document.getElementById('ctrlnote').textContent" --port 9444 --match adg-browser-fixture   # A94：ctrl=回滚掉的 ⇒ 页面确实回滚了，命令报的是真话
node cli.mjs type --selector "#q" --text ab --port 9444 --match adg-browser-fixture   # A96：TYPE_APPLIED=true、READBACK_KIND=value、READBACK_VALUE=ab
node cli.mjs click --selector "#go" --port 9444 --match adg-browser-fixture   # A97：HIT_AFTER=button#go、HIT_AFTER_IS_TARGET=true、CHANGED=true
node cli.mjs close --port 9444    # A74 / A82：CLOSED=true
```

A82 的做法：整段用**临时的** `--profile`（`$env:TEMP` 下的独立目录）与**避开用户实例**的端口（本机用户侧在 9333 上有一个实例，动作面一律用 9444），跑完 `close` 之后按命令行过滤确认没有残留浏览器进程；临时 profile 与 fixture 一并清掉。两条现场注意：A51 的「会剩 0 个页面」分支要在**一次性实例**上验（`--port <别的端口> --profile <临时目录>`），别在用户正在用的窗口里试；显式换模式**会**关掉当前实例（持久 cookie 留住、会话 cookie 丢），别在用户正在用的窗口上验。再加一条：**别在不是自己开的实例上跑动作命令** —— `--match` 命中多页时动作命令会拒发（I17），但命中唯一、而那一页又不确定是你的，就等于把点击落在别人的页面上；先 `tabs` 看一眼再动。

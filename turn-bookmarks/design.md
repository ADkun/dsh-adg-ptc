# design.md — turn-bookmarks 设计与不变量

## 1. 两半怎么分工

```
点星标 → client.toggle(turn)：先乐观改本地 Set，再 PUT /api/adg-turn-bookmarks/<sessionId> {turns:[...]}
                                                  ↓ 失败：回滚本地 Set + console.warn
宿主 index.mjs：校验 sessionId → 定位会话目录（不存在则 409）→ normalize → 写 sidecar → 回显
上色器（client）：watch 本地 Set + DOM 变动 → 给轨道按钮 / 提问行加 data-adg-tb → 由 CSS 染色
```

上色**不重新拉数据**：本地 `sessions` Map 里就是这份书签集，写盘成功与否只影响持久化，不影响当下视图。

收藏开关有两个**触发点**、一个**写入口**：星标左键单击、轨道刻度右键 → 都调 `toggle(turn)`；轨道**左键**严格留给 dsh 原生跳转（本插件不挂 `click`、不 `preventDefault`）。

## 2. 核心数据模型

- **书签集**：`Set<number>`，元素是**轮次号**（`TurnLocation.turn`），不是数组下标、不是 seq。
- **存储文件**：`<sessions root>/<profile slug 目录>/<会话目录>/adg-turn-bookmarks.json`，内容 `{"version":1,"turns":[3,8]}`（2 空格缩进 + 结尾换行），权限 `0600`，写入走 `<file>.tmp` → `rename`。
- **sessions root**：优先 `ctx.get('sessionPersistence')` 的 `root`；取不到时退回 `DSH_HOME` 或 `~/.dsh` 下的 `sessions`。
- **会话目录的两种命名形态**：裸 uuid 与 `session-<uuid>`。`sessionDirCandidates` 两种都给，`locateSessionDir` 逐 slug 目录 `statSync` 命中即用 —— 不猜，不拼。
- **为什么不放 `adg-settings.json`**：书签是**每个会话**的数据。放进用户根的单文件会越滚越大，且删会话后书签成孤儿；放进会话目录，删会话即一起删。

## 3. HTTP 契约

| 方法与路径 | 请求体 | 成功 | 失败 |
|---|---|---|---|
| `GET /<sessionId>` | 无 | `200 {"turns":[...]}`；**会话目录不在也给 200 空列表**（新会话不该 404） | 400 坏 sessionId |
| `PUT /<sessionId>` | `{"turns":number[]}` | `200` 回显归一后的列表 | 400 非 `{turns:[]}` / 超 1000；409 会话目录不在 |
| `DELETE /<sessionId>` | 无 | `200 {"turns":[]}`（文件删掉） | 400 坏 sessionId |
| 其它方法 | — | — | 405；前缀下空路径 404 |

- **归一规则**（`normalizeTurns`）：只留非负整数、去重、升序、封顶 1000。PUT 的元素不合法时被**丢弃**而不是报错（手抖传了 `"3"` 不该整次失败）；但**数组本身**不是数组、或长度超上限，是 400。
- **sessionId 校验**（`isSafeSessionId`）：非空、≤200 字符、不含 `..`、匹配 `^[A-Za-z0-9][A-Za-z0-9._-]*$`。拒掉路径穿越。
- **同源栅栏**（与 `settings/index.js` 同一套写法）：`connection` 服务在场时以 `connection.admit(req)` 为准（返回带 rejection 就 401）；否则 Host 必须是回环名、`sec-fetch-site` 不许 `cross-site`、`Origin`/`Referer` 的 authority 与 Host 的 scheme/host/port 三项相等，否则 403。
- 响应头：`content-type: application/json; charset=utf-8` + `cache-control: no-store` + `content-length`；请求体上限 64KB，超了断开并当空体。

## 4. DOM 契约（上色的唯一依据）

- **星标槽**：`conversation.chat.turnTail`（kind `list`、scope `session`），props `{ turn: TurnLocation, seq, openFile }`；会话级 slot 条目由框架补 `sessionId` / `useProjection` / `useAccess`（**没有 `useChat`**）。所以星标只读 `turn.turn`（轮次号）与 `turn.status`；`status === 'open'`（这一轮还没结束）不渲染。
- **右侧轨道刻度**：每格是 `<button data-index="i">`，**没有 `data-turn`**；它是全应用唯一的 `data-index` 按钮（已 grep 确认），且 `aria-label` 恒含「轮」「turn」。`i` 是 `merge(navigation.items(), turnOutline)` 之后的<strong>合并下标</strong>，不等于轮次号。映射**首选**从该刻度自己的 `aria-label` 抽第一个数字（不依赖对齐，流式新轮次让 outline 短暂落后也染不错）；抽不到才回退成 `useProjection('turnOutline')` 的升序轮次列表 `turn = railTurns[i]`。
  实机读数（2026-11-06，本机 3080 的 26 轮会话）：`button[data-index]` 共 26 个、`data-index` 0..25，未加载刻度 `aria-label="加载并跳转到第 N 轮"`、已加载为 `跳转到第 N 轮`。**目录栏只在 `items.length ≥ 2` 时渲染**（`TurnNavigatorRail` 在 `items.length < 2` 时 `return null`，本机 `dsh-client-ui-chat/lib/client.js:419`），单轮会话没有刻度可染，不是故障。同一会话上按本插件逻辑派发 `contextmenu`：命中 `aria-label="加载并跳转到第 2 轮"` → 轮次 2，`defaultPrevented: true`。
- **正文提问行**：包裹层同时带 `data-chat-turn` 与 `data-chat-flow-kind`；用户提问是 `data-chat-flow-kind="user"`。选择器 `[data-chat-turn][data-chat-flow-kind="user"]`。
- **类名是构建期哈希**（如 `eGxaPq_mark`），每版可能变，一律不用；只用 `data-*` 属性这类语义契约。
- **刻度按钮虚拟化**：只有可见的才在 DOM。所以上色必须随 scroll / resize / 子树变化重跑；用 rAF 合并 + 80ms 最小间隔节流，避免滚动时抖动。
- **染色手段**：给按钮加 `data-adg-tb="1"`，用 CSS 覆盖它 `:before` 伪元素的 `background` / `opacity` / `transform`（`!important`，因为要压过内联/状态类）；给提问行加同一属性，用 `box-shadow: inset 3px 0 0 0` 画左侧竖线。**不改 dsh 的任何结构与跳转逻辑**。交互分工同一句：星标单击 / 轨道右键 = 收藏开关；轨道左键 = dsh 原生跳转，本插件不监听、不拦截。
- **星标与原生操作栏同行（且不挤占交付卡）**：`conversation.chat.turnTail` 是共享槽，dsh 核心的交付卡（`dsh-client-ui-deliverables`）、计划卡、定时卡都把整块卡片塞进 `[data-turn-tail]` 根节点（默认 `flex-direction:column; align-items:stretch; gap:16px`）。所以**不能**把根节点改成 `row`——那会把「已编辑 N 个文件」交付卡和星标、操作栏挤成一行（曾犯此错）。本插件只做加性 CSS：根节点**显式重申** dsh 的默认 `column / stretch / gap:16`（用 `!important` 压过后续覆盖）并补 `position:relative` 当定位参照；**仅当原生操作栏存在**时（选择器 `:has(>[data-clock])`；操作栏由 `MessageIconActions` 渲染并带 `data-clock`，见 `dsh-client-ui-chat/lib/client.js:5206-5208`）才把星标绝对定位到根节点行内起点、贴底（`inset-inline-start:0; bottom:0`，尺寸 `calc(28px + var(--dsh-content-font-delta,0px))` 跟随 dsh 字号缩放），并用 `[data-turn-tail]:has(.atb_star):has(>[data-clock])>*:last-child{margin-inline-start:36px}` 把末子项（原生操作栏）右移 36px（28 星宽 + 8 间距）让位。**没有操作栏的轮次**（`closing === null`：被中断 / 报错 / 只调工具没收尾正文的完成轮，核心 `dsh-client-ui-chat/lib/client.js:7015-7019` 只渲染 tail、不渲染操作栏）星标留在正常流里、不绝对定位，既不浮到正文上、也不右移任何卡片。真机读数见 testing-guide.md §7。`data-turn-tail` 是 dsh `TurnTailNodeView` 根节点属性（`dsh-client-ui-chat/lib/client.js:7017/7024`）。

## 5. 不变量

- **I1** 书签是轮次号的集合，且只落**会话目录**的 sidecar。
- **I2** 宿主不造会话目录：目录不在 → 409。
- **I3** 存储形状只在 `lib/bookmarks.mjs`（`parseStore` / `serializeStore`）；写入 0600 + `.tmp` + rename。
- **I4** 客户端不改 dsh 组件、不读别的插件 DOM 来估位置：只给既有按钮/行加/去一个 `data-adg-tb` 属性。
- **I5** 轨道 `index → turn` 首选 `aria-label` 的第一个数字，回退才用 `turnOutline` 对齐；两条路都不猜、不四舍五入。
- **I6** 上色是幂等的：同一元素重复 `applyAttr` 不累积；每轮 paint 都按当前书签集重算（含「取消」时删属性）。
- **I7** 乐观更新 + 失败回滚：本地先改，PUT 失败则回滚并 `console.warn`，不弹框、不打断对话。
- **I8** 卸载回收：`dispose` 断开观察器与监听器，并移除全部 `data-adg-tb`。
- **I9** 同源栅栏与 `settings` 同源同规则（Host 回环 / `sec-fetch-site` / Origin-Referer 对齐 / `connection` 优先）。
- **I10** 上限 `MAX_TURNS = 1000`，PUT 超限 400，不静默截断。
- **I11** 收藏只有一个写入口 `toggle(turn)`（星标单击、轨道右键共用）；轨道 `click` 不监听、不 `preventDefault`，左键跳转保持 dsh 原生行为与原速。
- **I12** 布局修正只走加性 CSS 覆盖：`[data-turn-tail]` 补 `position:relative` 并显式重申 dsh 默认的 `column / stretch / gap:16`；**绝对定位必须门控在 `:has(>[data-clock])`（操作栏存在）之内**，星标才绝对定位、末子项才 `margin-inline-start:36px`——因为 `closing === null` 的轮次没有操作栏，不门控会让星标浮到正文/卡片上、或把卡片右移（核心 `dsh-client-ui-chat/lib/client.js:7015-7019`）。**不得把 `flex-direction` 改成 `row`**（该槽被交付卡/计划卡/定时卡共用，改 row 会挤坏它们），也不插入、不移动、不包裹 dsh 的任何 DOM 节点。

## 6. 失败模式与降级

| 情形 | 表现 |
|---|---|
| 宿主不可达（插件没装 / 路由 404） | 星标照常显示；点击后写入失败 → 回滚 + `console.warn`，对话不受影响 |
| `turnOutline` 还没算出来 / 为空 | `railTurns` 为空 → 轨道暂不上色，下一次 paint 再试 |
| 会话刚建、还没有 sidecar | `GET` 回空列表，星标全是空心 |
| 目录栏不足两轮（dsh 自己不渲染轨道） | 无轨道可染色；星标与正文标记照常工作 |
| 会话目录还没落盘（刚开的新会话） | PUT 得 409 → 回滚 + `console.warn`；等会话落盘后再收藏即可 |

## 7. 非目标

不做跨会话书签总览、不做导出/导入、不做快捷键、不改目录栏组件与它的跳转逻辑、不给书签加备注。这些如果要做，先回到用户那里确认范围。

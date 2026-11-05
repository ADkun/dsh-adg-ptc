# testing-guide.md — turn-bookmarks 验证

## 命令

```sh
node --test test                        # cwd = turn-bookmarks/；零依赖、零副作用
node --test --test-isolation=none test  # dsh 沙箱里加这个 flag
```

期望：`tests 19 / pass 19 / fail 0`（用例增删时读数会变，别把读数当锚）。

## 用例总表

### `test/bookmarks.test.mjs`（纯规则）

| 用例 | 钉住什么 |
|---|---|
| 文件契约：sidecar 名字与上限只有一处 | `STORE_FILE === 'adg-turn-bookmarks.json'`、`MAX_TURNS === 1000` |
| isSafeSessionId：两种合法形态放行，路径穿越与怪字符拒绝 | 裸 uuid / `session-` 前缀放行；`../x`、含 `/`、空、超长、非串拒绝 |
| normalizeTurns：只留非负整数、去重、升序、不猜不四舍五入 | `[3,"3",2.7,-1,3]` → `[2,3]`（等等价断言） |
| parseStore 容错：坏 JSON、错形状、缺 turns 一律当空列表 | 任何一种坏输入都不抛错 |
| serializeStore 与 parseStore 往返一致，且带 version 与结尾换行 | 往返相等 + 文本以换行结尾 |
| sessionDirCandidates：两种目录形态都给，且不含非法候选 | 含裸 id 与 `session-` 形态；坏 id 被过滤 |

### `test/routing.test.mjs`（假 ctx / 假 req-res）

| 用例 | 钉住什么 |
|---|---|
| 插件名与路由前缀是契约 | `name === 'adg-turn-bookmarks'`、`ROUTE_PATH === '/api/adg-turn-bookmarks'` |
| GET：会话目录不存在也给空列表 | 新会话不该 404 |
| PUT 落盘到该会话目录的 sidecar，读回一致且经过归一 | 真实路径 `<root>/<slug>/<sessionDir>/adg-turn-bookmarks.json`、内容已归一 |
| PUT：会话目录不在 -> 409 | R2：不许凭空造目录（并断言没建出目录） |
| PUT：请求体不是 `{turns:number[]}` -> 400 | 三种坏 body |
| PUT：超过上限是 400，不静默截断 | R10：并断言没写盘 |
| DELETE 清空 sidecar；再 GET 回空列表 | 删文件后 GET 仍是空 |
| 方法与路径栅栏 | POST 405、缺 session id 404、坏 id 400 |
| 同源栅栏 | 跨站来源 403、回环同源放行 |
| connection 服务在场时以它的判定为准 | R9：401 直接生效，绕过本地栅栏 |
| 跨半边漂移 | `client.js` 里的 factory id / `ROUTE` / DICT 的 zh-en 键与宿主一致 |
| 轨道右键是收藏入口，且绝不接管左键跳转 | R12：源码有 `contextmenu` 监听 + `preventDefault`（含卸载时摘除），且没有 `addEventListener('click'` |
| 星标进操作栏行、交付卡不挤占 | 源码里有 `[data-turn-tail]{…flex-direction:column…position:relative…}`、`.atb_star` 的 `position:absolute;left:0;bottom:0`、`[data-turn-tail]:has(.atb_star)>*:last-child{margin-left:36px}`、星标 `28px×28px`；且源码中不出现 `flex-direction:row`（回归根因护栏） |

## 测试测不到的（必须真机量）

单元测试只覆盖规则与路由，**碰不到浏览器**。下面这些只能在重启后的 dsh 里观测。

## 已在真机 DOM 上验证（2026-11-06）

前 5 行是未装插件时、用 `~/.dsh/browser/cli.mjs`（默认无头）打开 `http://127.0.0.1:3080` 切到 26 轮会话后把等价 CSS 注入页面的读数；最后一行是插件已装、刷新页面后的实测：

| 验证点 | 读数 |
|---|---|
| 刻度选择器与轮次号 | `querySelectorAll('button[data-index]')` = 26；`data-index` 0..25；`aria-label` =「加载并跳转到第 N 轮」/「跳转到第 N 轮」——与 `turnFromLabel` 的取数一致 |
| 粉色压得住原生样式 | 第 1 格 `::before`：注入前 `background rgba(255,255,255,0.2)`、`scaleX(0.4)`、`opacity .6` → 加 `data-adg-tb="1"` 后 `rgb(255,92,157)`、`scaleX(1)`、`opacity 1` |
| 提问行竖线 | 第 19 轮用户行：`box-shadow none` → `rgb(255,92,157) 3px 0px 0px 0px inset` |
| 右键入口的选择器与拦截 | 同一 26 轮会话上按本插件逻辑派发一次 `contextmenu`：`marks:26`；命中 `aria-label="加载并跳转到第 2 轮"` → 轮次 2；`defaultPrevented:true` |
| 单轮会话没有目录栏 | 单轮会话 `button[data-index]` = 0；源码 `items.length < 2 → return null`（`dsh-client-ui-chat/lib/client.js:419`）解释之 |
| 星标与原生操作栏同行、交付卡独立整行（插件已装、刷新后） | `[data-turn-tail]` computed `flex-direction:column`；无卡 root 740×32、有卡 root 740×198（卡 740×150 独占整行）；星标 `position:absolute` 28×28，与原生操作栏同 y、x=485 / 操作栏 x=521。`data-turn-tail` 是 dsh `TurnTailNodeView` 根节点的属性（`dsh-client-ui-chat/lib/client.js:7017/7024`） |

**边界**：这只证明「选择器、染色 CSS 与右键 `preventDefault` 在真机上成立」（探针用的是注入的等价逻辑，插件本身还没装），**不**证明「槽注册、书签读写、随滚动重染、右键真的切换收藏」——那几项仍要装插件后看。

## 未观测项

- **未观测**：装插件后，paint 是否把属性打到该打的刻度上（染色 CSS 本身已在上表验证）；量法：重启 dsh → 新建会话 → 聊到 3 轮以上（目录栏出现）→ 点第 2 轮末尾星标 → 看右侧第 2 条刻度是否变粉（`#ff5c9d`），再点一次看是否恢复。
- **未观测**：右键刻度是否切换收藏、且不弹浏览器右键菜单；量法：重启 → 聊到 3 轮以上 → 右键第 2 条刻度，看它立刻变粉（再右键变回灰）且没有系统菜单弹出；随后**左键**点同一刻度，确认仍照常跳转。
- **未观测**：点变粉的刻度是否跳到该轮；量法：同上，滚到别处后点那条刻度，确认视口滚到第 2 轮。**这一步是原生行为**，插件只染色；跳错说明轮次号映射错了（R5）。
- **未观测**：装插件后，paint 是否把属性打到该提问行上（竖线 CSS 本身已在上表验证）；量法：收藏后看该轮用户提问气泡左侧边缘。
- **已观测布局、未观测交互**：星标位置与尺寸已在上表末行实测（同行、28px、不挤压）；尚未观测「点一下是否变实心并带 `aria-pressed="true"`、并落到 sidecar」。量法：重启 dsh → 新建会话 → 点某轮末尾星标，看星变实心、`aria-pressed` 变 `true`，刷新后仍为实心。
- **未观测**：刷新页面 / 重启 dsh 后收藏是否还在；量法：收藏后刷新页面，看星标是否仍为实心、轨道是否仍为粉色（读的是 sidecar）。
- **未观测**：悬停刻度弹出的问题预览（dsh 自带）是否不受影响；量法：鼠标悬停任一**未收藏**与**已收藏**的刻度，确认气泡仍正常出现、文字颜色未被粉色污染。
- **未观测**：会话很多时上色是否可接受（虚拟化 + 节流够不够）；量法：开一个 100 轮以上的会话，快速滚动目录栏，看刻度染色是否跟得上、有无明显闪烁。

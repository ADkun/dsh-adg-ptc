# AGENTS.md — turn-bookmarks（`adg-turn-bookmarks` 轮次书签插件）

本模块 = 一个 dsh 插件包 **`adg-turn-bookmarks`**，两半各干一件事：

- **浏览器半边**（`client.js`）：在每轮回答末尾的尾部槽（`conversation.chat.turnTail`）放一颗星标按钮；点一下把这一轮收藏，再点一下取消。已收藏的轮次在**右侧目录栏（TurnNavigator）的轨道条**上染成粉色，正文里那一轮的**提问行左侧**也加一道粉线。轨道条本身就是按钮，**左键**由 dsh 原生跳转 —— 本插件不另造跳转，也绝不拦左键；在刻度条上**右键**即收藏/取消这一轮（与星标同一个开关）。
- **宿主半边**（`index.mjs`）：把某个会话的书签存成**该会话目录里的一个 sidecar 文件** `adg-turn-bookmarks.json`，并用一条同源栅栏保护的路由读写它。

不注册任何工具。设计与不变量见 [design.md](design.md)，验证见 [testing-guide.md](testing-guide.md)。

**为什么本模块有独立文档**（三样信号都在）：有独立命令（`cd turn-bookmarks && node --test test`）；有模块特有红线（只准靠公开 DOM 属性契约上色、书签只落会话目录）；有跨模块路由（`install.ps1` 部署它）。

## 三个名字（不同名也不同物，别串）

| 名字 | 值 | 用在哪 |
|---|---|---|
| 包名 | `adg-turn-bookmarks` | profile 的 `dependencies` 与 `dsh.profile.bundles`、`cordis.patch.yml` 的 `name:`、`package.json` 的 `name` |
| 行 id（= 插件模块的 `export const name` = 浏览器工厂 id） | `adg-turn-bookmarks` | `cordis.patch.yml` 的 `id:`；`client.js` 的 `__ModuleLoader__.load({ id })` |
| HTTP 路由前缀 | `/api/adg-turn-bookmarks` | `index.mjs` 的 `ROUTE_PATH` 与 `client.js` 的 `ROUTE`（两份必须逐字一致，测试钉住） |
| 槽 / 条目 | 槽 `conversation.chat.turnTail`；条目 id `adg-turn-bookmarks-star` | `client.js` 的 `slots.register` |
| 工具名 | **无**（不注册工具） | 不进 preset 的任何 `allow`，也不进 `delegate` 的 `tools` |

## 命令

下列命令的 cwd 都是仓库的 `turn-bookmarks/` 目录：

```sh
node --test test                        # 单元测试：纯规则 + 路由（假 ctx / 假 req-res），零依赖、零副作用
node --test --test-isolation=none test  # dsh 沙箱（workspace-write）里必须加这个 flag
```

零第三方依赖：只用 Node 内建能力与本模块的 `lib/bookmarks.mjs`；没有构建步骤，`main` 直接指 `./index.mjs`。

## 红线

每条一行结论 + 就地理由 + 载体（`[机检]` 给命令与期望判据，`[评]` 给评审判据）。**违反即返工。**

- **R1 书签只落会话目录的 sidecar，禁止写进 `adg-settings.json` 或用户根。** 理由：书签是**每个会话**的数据，放进单个设置文件会越滚越大，删会话后还留下孤儿；放进会话目录，删会话即一起删。载体：[机检] `test/routing.test.mjs` 的「PUT 落盘到该会话目录的 sidecar」。
- **R2 宿主不造会话目录：目录不在就 409，禁止 mkdir 一个假会话。** 理由：凭空的目录会在会话根下留垃圾，且用户打开时会看到一个不存在的会话。载体：[机检] 「PUT：会话目录不在 -> 409」。
- **R3 存储形状只在 `lib/bookmarks.mjs` 的 `parseStore` / `serializeStore` 一处，且写入必须 0600 + `.tmp` + rename。** 理由：两处形状就是漂移源；直接覆写会读到半个文件。载体：[机检] `test/bookmarks.test.mjs` 的「serializeStore 与 parseStore 往返」「parseStore 容错」+ `node --check`。
- **R4 禁止依赖 dsh 的类名（构建期哈希）或读别的插件的 DOM 来估位置；只准用公开 `data-*` 属性契约。** 理由：类名每版都会变，`data-chat-turn` / `data-chat-flow-kind` / `data-index` 这些属性才是稳定契约（且本插件只是给既有元素加/去属性，不估布局）。载体：[评] 读 `client.js` 的 `STYLE` 与 `paint()`，不得出现 `eGxaPq` 之类哈希类名。
- **R5 轨道刻度的 `data-index` 不等于轮次号；轮次号优先读刻度自己的 `aria-label`（「跳转到第 N 轮」/「Jump to turn N」），读不到才用 `turnOutline` 的升序轮次列表按下标对齐。** 理由：刻度是 `merge(navigation.items(), turnOutline)` 之后的**合并下标**，两者数量与顺序都可能不同；拿 index 当轮次会标错，而 `aria-label` 直接就是那一格自己的轮次号，不依赖对齐。载体：[评] 读 `client.js` 的 `turnFromLabel` / `computeRailTurns` / `paint`。
- **R6 禁止在本插件里注册任何工具，也禁止把本插件行写进 `preset/agent.cordis.yml`。** 理由：它只是界面增强，不是能力面；写进 preset 会在子代理 scope 重复挂载、同层重名直接拖垮整个 profile 的插件加载。载体：[机检] `node tools/check-preset.mjs`（preset 里没有它就是对的）+ 读 `index.mjs` 的 `inject`（只有 `webServer`）。
- **R7 禁止只装包、不写 `dsh.profile.bundles`（或反过来）。** 理由：bundle 装载只遍历该列表；只写列表而包装不上会让该 profile 启动报错。载体：[机检] `install.ps1` 第 4c-15 步的读回断言三格（`node_modules` 真目录 + `dependencies` + `dsh.profile.bundles`）。
- **R8 禁止写死本机绝对路径。** 理由：落点由安装脚本按环境变量解析，源码出现盘符路径就换了机器跑不了。载体：[机检] 在 `turn-bookmarks/` 下搜盘符路径（`Select-String -Path index.mjs,client.js,lib/bookmarks.mjs -Pattern '[A-Za-z]:[^ ]'`）期望无输出。
- **R9 路由必须保留同源栅栏，且 `connection` 服务在场时以它的判定为准。** 理由：这条路由能让任意网页改写本地文件，栅栏是唯一防线；平台若有统一的连接判定（401），要以它为准而不是自己再判一遍。载体：[机检] 「同源栅栏：跨站来源 403，回环同源放行」「connection 服务在场时以它的判定为准」。
- **R10 上限 `MAX_TURNS=1000`：超限是 400，禁止静默截断。** 理由：静默截断会让用户点了收藏却什么都没存，且没有任何提示。载体：[机检] 「PUT：超过上限是 400，不静默截断」（并断言没写盘）。
- **R11 卸载必须回收自己打上的 DOM 标记（断开观察器/监听器 + 移除全部 `data-adg-tb`）。** 理由：不回收会在宿主 DOM 上留孤儿属性，插件卸了粉色还留着。载体：[评] 读 `client.js` 的 `startPainter` 返回的清理函数。
- **R12 收藏只有一个写入口 `toggle(turn)`，触发点只有星标单击与轨道刻度右键；轨道上的 `click` 一律不监听、不 `preventDefault`。** 理由：左键是 dsh 原生跳转的唯一入口，接管它要么丢掉跳转、要么为分辨单击/双击把跳转拖慢半拍；右键不跟它抢，且不需要动 dsh 任何代码。载体：[机检] `test/routing.test.mjs` 的「轨道右键是收藏入口，且绝不接管左键跳转」（必须有 `contextmenu` 监听 + `preventDefault`，且源码不得出现 `addEventListener('click'`）。

## 跨模块路由

| 你要做什么 | 先读 | 再读 |
|---|---|---|
| 改轨道上色 / 正文标记的选择器 | [design.md](design.md) 的「DOM 契约」 | [testing-guide.md](testing-guide.md) 的「未观测项」 |
| 改存储形状 / 上限 / 路径 | `lib/bookmarks.mjs`（唯一规则源） | [design.md](design.md) 的「核心数据模型」 |
| 改路由或同源栅栏 | `index.mjs`（栅栏写法与 `settings/index.js` 同源） | [testing-guide.md](testing-guide.md) 的「用例总表」 |
| 改装载形状 | `install.ps1` 的 2b-7 / 4c-14 / 4c-15 步 | （同一种装法：稳定副本 + `dsh plugin add` + 读回断言三格） |

## 版本区

本模块三份：`turn-bookmarks/AGENTS.md`（本文件，路由）→ [design.md](design.md)（设计与不变量）→ [testing-guide.md](testing-guide.md)（用例全表与未观测项）。完整清单与根入口见根 `AGENTS.md` 的「版本区」一节，此处不另抄。

## 生效方式

**本模块是 dsh 插件，装进 profile 之后必须重启 dsh**（loader 按解析路径缓存 ES 模块），再在**新建对话**里验收；`client.js` 那半随 web 客户端加载，同样要重启。

判据分三层，缺一层就不算生效：

1. **包在不在**：`<DSH_HOME>/plugins/adg-turn-bookmarks/`（稳定副本）与 `<profile>/node_modules/adg-turn-bookmarks/package.json`（真目录）。
2. **被选没被选**：该 profile 的 `dependencies` 与 `dsh.profile.bundles` 里都有 `adg-turn-bookmarks` —— **装了 ≠ 被选中**。
3. **运行期生效没生效**：只有重启 dsh 之后才能观测。

部署由 `install.ps1` 的第 2b-7 步（把 `turn-bookmarks/` 拷到用户根的稳定副本）与第 4c-14 / 4c-15 步（逐 profile `dsh plugin --profile <n> add file:<稳定副本>` + 读回断言）完成。**注意 `install.sh` 不管本模块**（它连 `ptc-parallel` 也没管）—— Windows 上装本模块走 `install.ps1`。

**未观测**：重启 dsh 后，收藏一轮是否真的让右侧轨道条变粉、点它是否跳到该轮、正文提问行左侧是否出现粉线。其中**「选择器 + 染色 CSS + 右键 preventDefault 在真机上成立」已用无头浏览器在真实 3080 页面上验证**（读数见 [testing-guide.md](testing-guide.md) 的「已在真机 DOM 上验证」），仍待装插件后验的是槽注册、书签读写与随滚动的重染。量法见同文件「未观测项」。

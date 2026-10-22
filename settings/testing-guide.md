---
title: settings 模块测试指南
owner: Adg preset 维护者
status: current
last_reviewed: 2026-10-15
---

# testing-guide.md — settings（验证：用例全表、消费方契约、未观测项）

本文件回答「我要怎么相信它是对的」。设计见 [design.md](design.md) 的不变量 I1..I14；路由与红线见 [AGENTS.md](AGENTS.md)。

## 1. 命令

```sh
cd settings && node --test test                        # 本模块；不碰真机 profile
cd settings && node --test --test-isolation=none test  # DSH 沙箱（workspace-write）里加这个 flag
cd notify   && node --test test                        # 消费方（含 user-settings.test.mjs 的 10 条）
node tools/check-preset.mjs                            # 仓库根：preset 静态校验（本模块不碰 preset，但改完照跑）
```

全部用例都是**零副作用**的：不弹通知、不起进程、不读写真机 profile —— 落盘一律发生在 `fs.mkdtempSync()` 出来的临时目录里（靠 `DSH_PROFILE_DIR` 指过去，用例结束时恢复环境变量并删目录）。所以这两条命令**任何时候都可以安全跑**。

## 2. 用例总表（`settings/test/settings.test.mjs`）

| # | 用例 | 钉住 | 判据要点 |
|---|---|---|---|
| 1 | I1: 登记表自洽 | I1 / I3 | 键唯一；`kind ∈ KINDS`；`labelKey`/`hintKey` 的命名约定；string 必有 `maxLength`、integer 必有 `min`/`max`；`FIELDS` 的键集合**就是**六项（通知三项 + 注入三项；技术类键不许混进来） |
| 2 | I2: default 必过自己的 validValue | I2 | 逐条 `validValue(field, field.default) === field.default`；`DEFAULTS` 与 `FIELDS` 一致 |
| 3 | I3: `describeFields()` 只有数据 | I4 | `JSON.parse(JSON.stringify(x))` 深等于原值 |
| 4 | validValue: 布尔 | I2 | `true/false/'true'/'false'` 收；`'yes'/1/0/null/undefined/{}/[]` 拒 |
| 5 | validValue: 字符串 | I2 | 非空白、长度内收（**不 trim**、原样返回）；空串 / 全空白 / 超长 / 非字符串拒 |
| 6 | validValue: 整数 | I3 | 合成字段（`FIELDS` 里还没有 integer 项）：`0`/`8000`/`'8000'`/上界收；`''`/`' 8000 '`/`'8000.0'`/`1.5`/越界/`null`/`true`/`'abc'` 拒 |
| 7 | refuseMessage | — | 三种 kind 各一句可读理由，且都点名是哪个键（客户端按它出红字） |
| 8 | normalizeSettings: unknown / dropped | I5 / I8 | 认不得的键进 `unknown`、非法值进 `dropped` 并**逐条** `logger.warn`（含键名、原值、拒绝理由、来源描述） |
| 9 | normalizeSettings: 非对象输入 | I8 | `null`/数字/字符串/数组 → `{settings:{}, unknown:[], dropped:[]}`，不抛错 |
| 10 | buildEffective: 三层优先级 | §2.2 | `stored > configured > default`，逐格 `origin` |
| 11 | `settingsFile()` 的 env 口径 | R10 | `DSH_PROFILE_DIR` > `DSH_HOME` > `~/.dsh`，都拼 `${STORE_NAME}` |
| 12 | 插件名与路由前缀是契约 | I12 | `name === 'adg-settings'`、`STORE_NAME === 'adg-settings.json'` |
| 13 | 漂移: notify 三项的键 / 默认值 / 界 | I1 | 登记表里 `consumer === 'adg-notify'` 的键逐项等于 `USER_DEFAULTS` 的键且默认值相等；`maxLength` 等于消费方的 `MAX_TITLE_LENGTH`；两边 `STORE_NAME` 同名 |
| 13b | 漂移: 注入三项的键 / 默认值 / 界 | I1 | 登记表里 `consumer === 'adg-skill-inject'` 的键逐项等于 `skill-inject/lib/user-settings.mjs` 的 `USER_DEFAULTS`（`skillInjectEnabled` / `skillInjectSubagent` / `skillInjectText`；`skillInjectSubagent` 两边默认都是 `false`）；`skillInjectText.maxLength === MAX_TEXT_LENGTH`；三份 `STORE_NAME` 同名 |
| 13c | 漂移: 注入插件读得懂设置页写的文件 | I1 / I14 | 写一份文件 → `skill-inject` 的 `readUserDefaults()` 读出两个开关（含 `skillInjectSubagent`）与自定义正文；空正文仍是空串（＝跟随技能文件） |
| 13d | 漂移: 子代理开关的两条路径 | I1 / I14 | 写一份文件且 `skillInjectSubagent: false` → `skill-inject` 的 `readUserDefaults()` 读出 `false`；同一份文件改成 `true` → 读出 `true`；键缺失 → 回落出厂默认 `false`（＝ 与这条键引入前一致：只注入调度者） |
| 13e | 漂移: patch config 出厂值与登记表 default 一致 | I1 | 行级读 `settings/cordis.patch.yml` 的 `config:` 块，逐键断言它在 `FIELDS` 里且值深等于 `field.default`（`'…'` 去引号、`true`/`false` 布尔、`''` 空串），锁住「改一处必须同时改另一处」 |
| 14 | 漂移: 消费方能读设置页写的文件 | I1 / I14 | 写一份文件 → `readUserDefaults()` 读出三项 → `resolveRequest` 用上标题、静音、存活毫秒 |
| 15 | 漂移: 没保存过时回落出厂默认 | I14 | `readUserDefaults()` 深等于 `USER_DEFAULTS`；请求形状里**不多写** `silent`/`disappearAfterMs` |
| 16 | R12/I13: 客户端 DICT | I13 | 对 `client.js` 做文本级计数：每条 `labelKey`/`hintKey`/`group.<组>` 至少有 zh 与 en 两份定义 |
| 17 | GET 默认态 | I11 / §4.1 | `200`；`content-type`/`cache-control`；`value` = 内置默认、`origin` 全 `default`；`stored`/`unknown`/`dropped` 空；`fields` = `describeFields()`；`file` 指到临时目录 |
| 18 | POST 写盘 + GET 读回 | I7 / I14 | `200`；文件内容 = 提交的三项；`origin` 转 `stored`；`.tmp` 已改名；非 Windows 上 `mode & 0o777 === 0o600` |
| 19 | POST 逐键合并 | I6 | 先存标题、再存声音，两次之后三项都在，`origin` 逐格正确 |
| 20 | POST 空体 / 非 JSON / 未知键 | I5 | 三条都 `400`（`no settings provided` / `unknown setting "legacyFlag" (not in lib/schema.mjs)`），且**文件不存在** |
| 21 | POST 非法值 | I5 | `400` + `field` 点名 + `error` 是 `refuseMessage`；上一次保存的值还在；落盘内容只有那一次 |
| 22 | 插件 Config 是中间层 | §2.2 | 未保存过的键取 `configured`（`origin: 'configured'`）；保存过的以文件为准；Config 里的错键只 `warn` 不进系统 |
| 23 | DELETE 恢复默认 | I11 | `200`；文件没了；`value`/`origin` 回到底层；日志含 `settings cleared` |
| 24 | 坏掉的设置文件不崩 | I8 | 坏 JSON → 默认值且**不 warn**；坏值 → `dropped` + warn；认不得的键 → `unknown`；好值照收 |
| 25 | 请求栅栏 | I9 | 非回环 `Host` / `cross-site` / 外站 `Origin` → `403 forbidden`；同源 → `200` |
| 26 | `connection` 优先 | I9 | `admit` 拒绝 → `401 unauthorized`；放行 → 不看结构栅栏 |
| 27 | 路由表 | I11 | `HEAD` → `405 method not allowed`；别的路径 → `404 not found` |
| 28 | 请求体上限 | I10 | 70KB body → `400`、`req.destroyed === true`、不落盘 |

## 3. 消费方契约（`notify/test/user-settings.test.mjs`）

| # | 用例 | 判据要点 |
|---|---|---|
| 1 | `USER_DEFAULTS` | 三项等于出厂默认（标题就是 `notify/lib/toast.mjs` 的 `DEFAULT_TITLE`）；冻结；`AUTO_DISMISS_MS === 8000`、`MAX_TITLE_LENGTH === 80`、`STORE_NAME` |
| 2 | `settingsFile()` | 与宿主同口径（`DSH_PROFILE_DIR` > `DSH_HOME`） |
| 3 | 请求形状：默认 | 出厂默认下 `resolveRequest({message})` **只有** `message` + `title` 两个字段 |
| 4-5 | 本次参数压过设置页 | 显式 `title`/`silent` 优先（含显式 `silent:false` 也要写进去） |
| 6 | 空白标题 | `''`/`'   '`/非字符串 → 回落设置页标题 |
| 7 | 两个布尔的效果 | `sound:false` 才写 `silent:true`；`persist:false` 才写 `disappearAfterMs` |
| 8-10 | `readUserDefaults` 的宽容面 | 不存在 / 坏 JSON / 数组 / `null` / 缺项 / 坏项 / 字符串布尔 / 标题 80 收、81 不收、空白不收 —— 全部不抛错 |

**为什么这两份测试都在**：`settings/test` 管"框架与漂移"（键名、默认值、界、两份 `STORE_NAME` 是否还对得上），`notify/test` 管"消费方自己的形状纪律"（工具参数与请求形状）。漂移一旦发生，两条路都会红。

## 4. 人工验收（装进 profile 之后）

```sh
# 1. 部署（两个脚本都做，Windows 用 ps1）
pwsh -File install.ps1            # 或 bash install.sh
# 2. 重启 dsh（loader 按解析路径缓存 ES 模块），然后打开设置
```

三层判据，缺一层就不算生效（与 [AGENTS.md](AGENTS.md) 的「生效方式」同一口径）：

1. **包在不在**：`<DSH_HOME>/plugins/adg-settings/`（稳定副本，8 个文件）与 `<profile>/node_modules/adg-settings/package.json`（真目录）。
2. **被选没被选**：该 profile 的 `dependencies` 与 `dsh.profile.bundles` 里都有 `adg-settings`。
3. **运行期**：重启 dsh → 打开设置 → 左栏出现「Adg 设置」→ 这一页能读出「当前生效」六项、能保存、能恢复默认。

页面上的手动验证步骤（每次改完都值得走一遍）：

1. 打开「Adg 设置」→ 六项显示**出厂默认**（标题「DSH 通知」、声音开、常驻开、注入开、**同时注入子代理关**、自定义正文空），「当前生效」的每格写「来自内置默认」。
2. 改标题 → 保存 → 提示「已保存」→ 刷新页面 → 值还在，来源变「设置文件」。
3. 打开设置文件 → 只有你保存过的键。落点按 `settingsFile()` 的优先序：`${DSH_PROFILE_DIR:-${DSH_HOME:-~/.dsh}}/adg-settings.json` —— 本机 `DSH_PROFILE_DIR` 是当前 profile 目录，所以文件**不在用户根**、在 `<profile>` 下。
4. 让一个子代理弹一条**不带标题**的通知 → 标题就是你在页面上写的那句；关掉「响提示音」再弹一条 → 静音。
5. 点「恢复默认」→ 文件消失 → 页面回到默认。
6. 手工把文件改成 `{"notifySound":"nope","legacy":1}` → 刷新页面 → 不崩，值回落，页面提示"有认不得的键 / 有不合法的值被忽略"。
7. 在「自定义注入正文」里填一段可辨认的文本 → 保存 → **不重启**、在同一会话里发下一条消息 → 调度者的系统提示词里出现「# 思考框架（自定义注入）」+ 那段文本；清空保存 → 下一轮回到「# 思考框架（thinking-framework）」+ 技能正文。
8. 关掉「注入思考框架」→ 下一轮系统提示词里**没有**框架段；同时看聊天输入框那颗「超思」chip 是否也变成关闭态（两处是同一个值）。反向再点一次 chip，回设置页刷新看开关是否同步。
9. 打开「同时注入子代理」→ 保存 → **不重启**、在同一会话里再派一个子代理 → 它的系统提示词里出现框架段；关掉该开关 → 下一次派出的子代理又没有这一段（调度者那侧始终有）。判据细则见 `skill-inject/testing-guide.md` 的 M 系列。

## 5. 已知限制与未观测

- **已知限制（Windows）**：`0600` 的权限断言只在非 Windows 上生效（Windows 的 `fs.statSync().mode` 不表达 ACL），这条在 Windows 上靠代码评审而非用例。
- **已知限制**：`install.sh` 的语法在本机**未观测**（无 `sh`）—— 与 `browser/` / `desktop/` 的既有口径一致；改动它之后只能靠逐行比对 `install.ps1` 的对应段落。
- **未观测**：真浏览器里的观感（开关命中区域、窄窗口换行、暗色主题对比度）与 `order: 38` 是否与别的插件撞车；量法：重启 dsh → 打开设置 → 看左栏顺序与渲染 → `node -e` 列出各插件的 `order` 比对。
- **未观测**：`dsh.client` 的 `immediately: true` / `inject: []` 在 web 半边打包时的实际语义；量法：重启 dsh 后页面出现证明载入路径可用，**不**证明这两个键的语义。
- **未观测**：Composition 没有 HTTP 载体（没有 `webServer` 服务）时本插件的装载行为；量法：在没有 webServer 的宿主上装一次，看是否只缺一页设置而不报错。
- **未观测**：`adg-notify` 与 `adg-settings` **只装了一个**时的行为（理论上两者互不依赖：少装 settings 时 notify 用出厂默认；少装 notify 时设置页照常能读写）；量法：在只装其中一个的 profile 上重启 dsh，分别验证。
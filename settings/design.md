---
title: settings 模块设计 —— 设置页的登记表驱动框架（adg-settings）
owner: Adg preset 维护者
status: current
last_reviewed: 2026-10-15
---

# design.md — settings（Adg 设置页框架：对象、不变量、接口）

本文件说清 **`adg-settings` 是什么、由哪些对象组成、哪些不变量不许破、接口长什么样**。路由与红线见 [AGENTS.md](AGENTS.md)；用例总表与未观测项见 [testing-guide.md](testing-guide.md)。

## 1. 目的与边界

**要解决的事**：把这个 preset 的「可配置项」集中成用户看得见、点得动的一页设置，并让**加一项配置 = 一次登记**（不动宿主逻辑、不动客户端逻辑）。

**明确不做**：

- 不做技术类键的界面（`appId` / `timeoutMs` / `scriptPath` / `powerShellPath`）—— 那些属于机器与部署细节，改它们的位置是 `cordis.patch.yml` 的 `config:` 或 profile。用户的硬约束原话是「以现有的可配置项为准，不新增可配置项，如果要新增可配置项，先问我」。
- 不做运行期推送 / 热重载：设置文件是唯一真相，谁需要谁读（`adg-notify` 每次调用重读一次）。
- 不做第二份界：页面渲染与本地校验都用宿主 `GET` 回来的 `fields[]`。
- 不装任何东西：本插件只读写一个 JSON 文件，零第三方依赖、不弹通知、不起进程。

## 2. 核心数据模型

### 2.1 Field（一条登记项）

| 字段 | 含义 | 谁用 |
|---|---|---|
| `key` | 设置文件的键名（也是 POST body 的键名） | 宿主、客户端、消费方 |
| `kind` | `boolean` / `string` / `integer` / `enum`（`KINDS`） | 宿主校验、客户端选控件 |
| `group` | 页面上的分组名（现只有 `notify` 与 `skillInject`） | 客户端聚卡片 |
| `default` | 内置默认（三层里的第三层） | 宿主、客户端 |
| `consumer` | 谁读它（现只有 `adg-notify` 与 `adg-skill-inject`）；漂移检查按它分组 | 测试 |
| `labelKey` / `hintKey` | 客户端 DICT 的取字键（约定 `field.<key>.label` / `.hint`） | 客户端 |
| `maxLength`（string）/ `min`+`max`（integer）/ `allowValues`（enum） | 界；字符串的界同时是消费方的长度上限；enum 的界就是它的取值集合 | 宿主、客户端、消费方 |
| `allowEmpty`（string，可选） | `true` ＝ 空串 / 全空白算合法值（语义由消费方定义，如「留空＝跟随默认」） | 宿主校验、客户端 |
| `multiline`（string，可选） | `true` ＝ 客户端画多行文本框（仍是 `kind: 'string'`，**不是**新 kind） | 客户端 |

`FIELDS` 是这几条登记的冻结数组；`DEFAULTS` 由它派生。**现存七条、两个分组**：`notify` 组的 `notifyTitle`（string，`maxLength: 80`，默认 `DSH 通知`）、`notifySound`（boolean，默认 `true`）、`notifyPersist`（boolean，默认 `true`），`consumer` 都是 `adg-notify`；`skillInject` 组的 `skillInjectEnabled`（boolean，默认 `true`）、`skillInjectFramework`（enum，`allowValues: ['thinking', 'execution']`，默认 `'execution'` ＝ 注入执行框架那份技能文件）、`skillInjectSubagent`（boolean，默认 `false` ＝ 子代理不注入，与这条开关引入前的行为一致）、`skillInjectText`（string，`maxLength: 20000`、`allowEmpty: true`、`multiline: true`，默认 `''` ＝ 跟随技能文件），`consumer` 都是 `adg-skill-inject`。

`allowEmpty` 与 `multiline` 是**修饰**，不是新的 `kind`：它们只影响「这个字符串允许什么值」与「客户端画成什么控件」，宿主的 `validValue` / `refuseMessage` 与客户端的控件选择都读同一条登记项 —— 所以加一个多行可空文本项仍然只是「加一条登记 + 两条文案」。

`kind: 'integer'` 是**框架备好的、当前没有字段在用**的分支（`FIELDS` 里还没有 integer 项）：它的校验由自测用合成字段覆盖。第一个整数项（比如"通知存活毫秒"）落进来之前要先问用户。

`kind: 'enum'` 与上面两个修饰不同 —— **它真的是第四种 kind**（写入 `KINDS` 的就是四种）：界不是长度、也不是区间，而是一个**取值集合**（`allowValues`，冻结数组）。宿主只收与集合成员**严格相等**的字符串（不折叠大小写、不 trim），客户端照它画 `<select>`、选项文案走 `option.<键>.<值>`。第一个 enum 项就是「注入哪个框架」（I3 那三处已同步改过）。

### 2.2 三层优先级

```text
stored（<DSH_PROFILE_DIR | DSH_HOME | ~/.dsh>/adg-settings.json，见 2.3）  >  configured（cordis.patch.yml 的 config 块）  >  default（内置）
```

`buildEffective()` 逐键取第一层有值的，并把**每一格的值来自哪一层**记成 `origin[key] ∈ 'stored' | 'configured' | 'default'`。页面把 `origin` 显示出来（「设置文件 / 插件配置 / 内置默认」），这样"我保存了怎么没变"和"我以为出厂是关的"这两种疑问都能当场自答。

`config:` 块是**页面写文件之前**的逐字段回退值，不是第二份真相：它只对**没被保存过的键**生效。

### 2.3 设置文件

- 落点：`<DSH_PROFILE_DIR> | <DSH_HOME> | <homedir()>/.dsh` + `/adg-settings.json`（`settingsFile()`）—— **优先 `DSH_PROFILE_DIR`**：宿主进程里它就是当前 profile 目录 ⇒ 真实落点是 `<profile>\adg-settings.json`，**不是**用户根那份。
- 形状：一个 JSON 对象，逐键存值（`{"notifyTitle":"…","notifySound":false}`）。**写进去的只有页面认识的键**。
- 写：`mkdirSync(recursive)` → 写 `${file}.tmp`（`mode 0o600`）→ `renameSync`（原子替换）。读不出来（不存在 / 不是 JSON / 不是对象）= 「还没保存过」，不是错误。

### 2.4 路由与页面

- 宿主半边：`ctx.inject(['webServer'], …)` 注册 `{ kind: 'prefix', path: '/api/adg-settings', handler }`；只有 `/settings` 这条子路由。
- 浏览器半边：`window.__ModuleLoader__.load({ id: 'adg-settings', factory })`，只 `require('react')`；注册进 `settings.section` 插槽（`id: 'adg-settings'`、`order: 38`、`label: () => t('nav')`、`locale: NS`）。

### 2.5 消费方（`adg-notify` 与 `adg-skill-inject`）

```text
notify/lib/user-settings.mjs:
  readUserDefaults()            # 宽容读设置文件（坏值丢、缺项回落出厂默认），绝不抛错
  resolveRequest(args, defaults) # 本次调用参数 > 设置页值；只写偏离默认的字段

skill-inject/lib/user-settings.mjs:
  readUserDefaults()            # 同一个文件、同一种宽容读法，只读自己那四键（skillInjectEnabled / skillInjectFramework / skillInjectSubagent / skillInjectText）
```

生产接线：`notify/index.mjs` 的 `apply()` 里 `defaults: () => readUserDefaults()` —— 每次调用重读一次文件；`skill-inject/index.mjs` 的 `sectionTextNow()` 在**每次组装系统提示词**时重读一次文件（总开关关、或总开关开但这是子代理而 `skillInjectSubagent` 关，都返回空串，空 section 渲染时被丢弃）。**这是"保存后立即生效"的全部实现**：文件是契约，不是热重载通道。两个消费方都**不 import `adg-settings` 包**（I1）。

## 3. 不变量

- **I1 键名 / 默认值 / 界的真相只在 `lib/schema.mjs`。** 消费方按**文件契约**读，不许 `import` 本包（两者在 profile 里可能各装一半；import 解析不到会在挂载期炸掉整个插件）。守卫：`settings/test/settings.test.mjs` 的漂移用例（通知三项 + 注入四项各自的键集合、默认值与界逐项相等）；patch config 的出厂值与登记表 default 的一致性由 `settings/test` 的漂移守卫用例钉住。
- **I2 每条 `default` 必须能过自己的 `validValue`。** 否则页面一开就是红的。守卫：「I2」用例。
- **I3 `kind` 只有四种（`boolean` / `string` / `integer` / `enum`）；新增一种 kind = 改框架。** 要同时改三处：`validValue` / `refuseMessage` / 客户端的控件选择；**另外** `describeFields()` 必须把这一 kind 需要的界一并 JSON 出去（enum 的 `allowValues`），否则客户端只能自己定义界，撞上 I4。守卫：「I1」用例断言 `KINDS`。
- **I4 `describeFields()` 只吐数据**（可 JSON 化），客户端不吃函数。守卫：「I3」用例。
- **I5 认不得的键与非法值一律 400，且都不落盘、都不动已保存的值。** 静默吞掉会让「设置怎么没生效」变成谜。守卫：两条 400 用例。
- **I6 POST 是逐键合并**（读旧文件 → 覆盖/加入本次键 → 写回），不是整份替换。守卫：「逐键合并」用例。
- **I7 写盘原子 + 0600 + 先建目录。** 守卫：写盘用例（`.tmp` 已改名；非 Windows 上断言 `mode & 0o777 === 0o600`）。
- **I8 读半边宽容、写半边严格。** 读：不存在 / 坏 JSON / 坏值 / 认不得的键都不抛错，坏值丢、认不得的键报进 `unknown`；写：任何一条不合法就整次拒绝。
- **I9 同源栅栏不许放宽**：非回环 `Host`、`sec-fetch-site: cross-site`、外站 `Origin`/`Referer` 一律 403；`connection` 服务在场时以它的 `admit` 为准（401 原样透传）。守卫：两条栅栏用例。
- **I10 请求体上限 64KB**，超限 `destroy()` 掉并答 400。守卫：超限用例。
- **I11 路由只认 `/settings`**（其余 404）、**方法只认 `GET` / `POST` / `DELETE`**（其余 405）。守卫：「路由表」用例。
- **I12 `export const name` === `cordis.patch.yml` 的 `id` === 包名。** 行落全局层，重名注册会拖垮整个 profile。守卫：契约用例 + 仓库根 `node tools/check-preset.mjs`。
- **I13 客户端 DICT 覆盖登记表里的每一条 `labelKey` / `hintKey`（zh 与 en 各一份），enum 还覆盖每个取值的 `option.<键>.<值>`。** 守卫：文本级计数用例。
- **I14 设置生效不需要重启。** 保存后第二次 `GET` 就反映真相；`adg-notify` 的下一次调用、`adg-skill-inject` 的下一次系统提示词组装都读到新值 —— 翻 `skillInjectSubagent` 也不例外：下一次组装时子代理是否拿到正文就变了，不必重建会话；换 `skillInjectFramework` 同理 —— 下一轮组装就读到另一份技能文件、导语标题也跟着换。**输入框里那颗「超思」开关**（`skill-inject/client.js`）走的是同一个 `POST`，所以它和设置页是同一份真相的两个入口，不存在第二份开关状态。

## 4. 接口

### 4.1 HTTP（同源；`content-type: application/json; charset=utf-8`、`cache-control: no-store`）

| 方法 | 路径 | 请求体 | 成功 | 失败 |
|---|---|---|---|---|
| `GET` | `/api/adg-settings/settings` | — | `200` + `describe()` | `403` 栅栏 / `401` connection |
| `POST` | 同上 | JSON 对象，键必须是登记表里的键 | `200` + `describe()` | `400` 空体 `no settings provided`；`400` 认不得的键 `unknown setting "x" (not in lib/schema.mjs)`；`400` 非法值 `{error: refuseMessage(field), field: key}`；`500` 写盘失败；`403`/`401` |
| `DELETE` | 同上 | — | `200` + `describe()`（回到 Config / 内置默认） | `500` 清不掉；`403`/`401` |

`describe()` 的形状：

```jsonc
{
  "ok": true,
  "value":  { "notifyTitle": "…", "notifySound": true, "notifyPersist": true }, // 三层合成后的生效值
  "origin": { "notifyTitle": "stored", "notifySound": "configured", "notifyPersist": "default" },
  "stored":     { },          // 文件里真正存着的键（已被校验过的那一份）
  "configured": { },          // 本行 Config（已被校验过的那一份）
  "defaults":   { },          // 内置默认
  "unknown":    [ ],          // 文件里有、登记表里没有的键（只报告，不删）
  "dropped":    [ ],          // 文件里有、但值不合法而被丢掉的键
  "fields":     [ /* describeFields()：客户端渲染与校验的唯一来源 */ ],
  "file":       "<DSH_PROFILE_DIR | DSH_HOME | ~/.dsh>/adg-settings.json"   // 优先 DSH_PROFILE_DIR ⇒ 真实形状就是 <profile> 目录下这一份
}
```

### 4.2 模块导出

- `settings/index.js`：`export const name = 'adg-settings'`、`export function apply(ctx, config = {})`、`export function settingsFile()`、`export const STORE_NAME`。**没有 `inject` 导出** —— `webServer` 是"问"来的（`ctx.inject(['webServer'], …)`），没有 HTTP 载体的 composition 只少一页设置，插件本身照常。
- `settings/lib/schema.mjs`：`KINDS` / `FIELDS` / `DEFAULTS` / `fieldFor(key)` / `refuseMessage(field)` / `validValue(field, raw)` / `normalizeSettings(raw, logger?, where?)` → `{settings, unknown, dropped}` / `buildEffective({stored, configured, defaults})` → `{value, origin}` / `describeFields()`。
- `settings/client.js`：`exports.apply` / `exports.inject = ['slots','locale']` / `exports.name`（ModuleLoader bundle 的三件套）。
- `notify/lib/user-settings.mjs`（消费方）：`STORE_NAME` / `MAX_TITLE_LENGTH` / `AUTO_DISMISS_MS` / `USER_DEFAULTS` / `settingsFile()` / `readUserDefaults(file?)` / `resolveRequest(args?, defaults?)`。
- `skill-inject/lib/user-settings.mjs`（第二个消费方）：`STORE_NAME` / `MAX_TEXT_LENGTH` / `USER_DEFAULTS` / `settingsFile()` / `readUserDefaults(file?)`。它与 `adg-notify` 那份**故意各写一份**（同样的理由：不许 import 本包），两边同名常量靠 `settings/test` 的漂移用例钉住。

## 5. 加一项配置的步骤

1. `settings/lib/schema.mjs` 的 `FIELDS` 加一条登记（**先问用户**）。
2. （可选）`settings/cordis.patch.yml` 的 `config:` 加上同名默认 —— 只影响"页面还没保存过"时的回退值，**不是**第二份真相。
3. `settings/client.js` 的 DICT 加 `field.<key>.label` 与 `.hint` 的 **zh + en** 各一份（分组名要给 `group.<group>`）。
4. 消费方接线：读**文件**（照着 `notify/lib/user-settings.mjs` 或 `skill-inject/lib/user-settings.mjs` 的宽容读法），不要 import 本包。若这一项还要在**别处**有个开关（例如输入框里的 chip），那处开关也只能走同一个 `POST` / `GET`，不许自己存一份状态。
5. 跑 `cd settings && node --test test`（会连带核漂移）与消费方模块的测试。

宿主与客户端的逻辑**一行都不用改** —— 这就是"框架"的含义。

## 6. 决策与理由（为什么这么设计）

- **为什么是登记表**：把"加一项配置"的成本从"改宿主 + 改客户端 + 改测试"降到"改一张表 + 两条文案"；`describeFields()` 让客户端不必知道有哪些键。
- **为什么显示 `origin`**：三层优先级的代价是"我改的为什么没生效"。把来源打在页面上，把排查变成看一眼。
- **为什么未知键 400 而不是忽略**：一个旧页面写回一个已经删掉的键，静默吞掉会让用户以为保存成功；400 让 STS/页面当场报错。
- **为什么消费方读文件而不是 import**：见 I1（profile 可能只装一半）。
- **为什么 `skillInjectText` 用「空串＝跟随技能文件」而不是「空串＝不注入」**：两个诉求（"我要自己写框架"和"我想用仓库那份"）不该靠两套开关表达。空串是一个**合法值**（所以有 `allowEmpty`），语义由消费方定 —— 空串就去读**当前选中的那份**技能文件（`skillInjectFramework` 定，出厂＝`skills/execution-framework/SKILL.md`）；要"完全不注入"用旁边那个布尔开关，"用哪一份"用下拉，三者语义都不重叠。
- **为什么「子代理是否也注入」单独一条登记（`skillInjectSubagent`）而不是绑进 `skillInjectEnabled`**：两个诉求正交（我要不要注入 / 注入给谁），绑在一起就没法表达「我要注入，但只注入调度者」。它的出厂值落在 `false` ＝ 与这条开关引入前完全一致（只注入调度者），所以升级本身不改变任何人的行为；开关的语义与生效时机在消费方那侧（`adg-skill-inject` 的内容层闸门），本模块只负责把一个布尔暴露出来。
- **为什么注入开关同时出现在设置页和输入框**：设置页是"我改配置"的入口，输入框 chip 是"这次我想临时关掉"的入口；两者都写同一个键、都走同一条 `POST`，所以不存在"两个开关打架"的第三种状态。
- **为什么 `notifyPersist` 用布尔而不是毫秒数**：用户要的是"常驻 / 不常驻"这一个决定；毫秒数属于技术细节。关掉常驻时用的是**改成常驻之前的原有默认值** `8000ms`（`AUTO_DISMISS_MS`），不引入新的旋钮。
- **为什么 `order: 38`**：36 = `dsh-insert-context`、37 = `dsh-subagent-mgm`、430 = `dsh-plugin-save-token` 已占用；本页排在这三者之后。
- **为什么只有一条 `/settings` 子路由**：设置页只需要读/写/清三种动作，方法已经能表达，不需要更多路径。

## 7. 非功能红线

零第三方依赖（宿主半边只用 `node:fs` / `node:os` / `node:path`；浏览器半边只用 dsh 供给的 `react`）；不写死本机绝对路径；不弹通知、不起进程、不落日志噪音（只在保存/清除/丢弃非法值时各写一条 `logger`）；文案中英双语；单文件客户端 bundle，没有构建步骤。

## 8. 未观测

- **未观测**：真浏览器里的观感（开关命中区域、窄窗口换行、暗色主题对比度、`order: 38` 是否与别的插件撞车）；量法：重启 dsh → 打开设置 → 看左栏顺序与页面渲染；撞车时用 `node -e` 列出各插件注册的 `order` 比对。
- **未观测**：`dsh.client` 里 `immediately: true` 与 `inject: []` 在 web 半边打包时的实际语义（本模块照 `dsh-insert-context` 的 `package.json` 同形声明）；量法：重启 dsh 后页面出现即证明载入路径可用，**不**证明这两个键的语义。
- **未观测**：`ctx.inject(['webServer'], …)` 在没有 HTTP 载体的 composition 里的降级行为（本模块只在有载体的 profile 上装）；量法：在没有 webServer 的宿主上装载，看它是否只缺一页设置而不报错。
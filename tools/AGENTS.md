# AGENTS.md — tools

`tools/` 有六个脚本：`check-preset.mjs`（源文件静态校验器）、`gen-preset-bundle.mjs`（从 `preset/` 源文件生成 bundle）、`check-bundle-flavor.mjs`（产物味道自检）、`flavors.mjs`（构建期注入组的单一事实来源）、`has-bundle.mjs`（逐 profile 探测）、`resolve-flavor.mjs`（味道键 → 目录 → 旗标映射）。设计见 [`design.md`](design.md)；生成器的形状与退出码记在它自己的头部注释里。

## 命令

```sh
node tools/check-preset.mjs        # 校验仓库里的 preset/agent.cordis.yml（唯一文本真相源；exit 0 通过 / 1 有 ERROR / 2 读不到目标文件）
node tools/gen-preset-bundle.mjs   # 不带旗标 = plain；不传位置参数时才落到缺省出海目录 bundle/adg-ptc/（在 .gitignore 里，不手改）；install.* 每次安装都重跑生成器，且每次都显式传位置参数
# 改过生成器、flavors.mjs 或 agent.cordis.yml → 四种味道都要生成并各自验一遍。
# 为什么非跑不可：check-preset 读的是**源文件**（委派行按 4 空格缩进就够它匹配），产物是它的盲区 ——
# "那段说明在不在 / 名字全不全 / 注错方向 / 自动压缩没关掉"只有 check-bundle-flavor.mjs 钉得住，它自己探测缩进。
node tools/gen-preset-bundle.mjs bundle/adg-plain && node tools/check-bundle-flavor.mjs bundle/adg-plain/cordis.patch.yml plain
node tools/gen-preset-bundle.mjs --with-billion-context bundle/adg-bili && node tools/check-bundle-flavor.mjs bundle/adg-bili/cordis.patch.yml bili
node tools/gen-preset-bundle.mjs --with-save-token bundle/adg-save-token && node tools/check-bundle-flavor.mjs bundle/adg-save-token/cordis.patch.yml save-token
node tools/gen-preset-bundle.mjs --with-billion-context --with-save-token bundle/adg-bili-save-token && node tools/check-bundle-flavor.mjs bundle/adg-bili-save-token/cordis.patch.yml bili+save-token
# 味道键必须写 `bili+save-token`（写成 `bili-save-token` 会 exit 2「未知的味道键」；稳定目录名才是 …-bili-save-token）。两个旗标可叠加。
# 探测与味道映射（安装脚本对**每个注入组各问一次**，再拿结果去映射目录与旗标）：
# 口径是"装了什么才注入什么"：装着才把那一组的全局层工具名写进调度 persona 那段说明（由调度者随每次委派放进 `delegate` 的 `tools`），没装就不注入；
# auto 模式下味道由该 profile 自己的探测结果决定（`--<组>=on|off` 才整体覆盖），装完用 check-bundle-flavor.mjs 断言那一份 —— 见根 `AGENTS.md` 红线 10。
node tools/has-bundle.mjs ~/.dsh/profiles web [desktop ...]                       # 每 profile 一行 "<name>\t<0|1>"（1 = 挂着；缺省探测 billion-context）；正常输出 exit 0，**用法错**（参数不成对等）才 exit 2
node tools/has-bundle.mjs ~/.dsh/profiles web --package=dsh-plugin-save-token    # 换一组问同一个 profile
node tools/resolve-flavor.mjs --billion-context --save-token                      # "<味道键>\t<稳定目录名>\t<gen 旗标>"
```

判据是**退出码**，不是任何一次运行的字节数：四份生成物的大小会随 persona 正文的每一次编辑漂移，只有 `check-bundle-flavor.mjs` 的断言才是判据。

退出码：`check-preset.mjs` — `0` 通过（允许有 WARN）/ `1` 有 ERROR / `2` 目标不存在或不是普通文件；stdout 里两行摘要是 `体积旋钮（生效值）` 与 `裁剪后实际吐出（按生效配置算）`。`gen-preset-bundle.mjs` — `0` 成功 / `1` 输入缺失、形状不符或不认识的旗标（错误在 stderr；两个旗标叠加合法）。`check-bundle-flavor.mjs` — `0` 断言成立 / `1` 有 ERROR（调度 persona 里那段 `**本会话的上下文工具` 说明缺失或出现多段、该在的组缺名字、不该在的组出现名字、出现了该组 `notInjected` 里的名字、`- id: agent` 委派行不恰好一条、`compaction-basic` 的 `auto` 值或有无与该味道不符）/ `2` 参数、味道键或文件不对。`has-bundle.mjs` — 每 profile 一行 `<name>\t<0|1>`（1 = 挂着）：`0` 正常输出（命中与未命中都只是数据，它**不因某个 profile 没挂那个包而失败**）/ `2` **用法错**（参数不成对等：缺 `profilesDir`、一个 profile 都没给、`--package=` 为空）。`resolve-flavor.mjs` — `0` 成功 / `2` 不认识的旗标或位置参数。`flavors.mjs` 不是 CLI，没有退出码。全部零依赖，不需要 `node_modules`。

## 红线

1. **ERROR 只留"这次委派必然抛错"的情形**（例：`allow` 里写了未注册的工具名 ⇒ `restrict()` 抛 `names unknown global tool ...`）。策略性越界（`agent` / `delegate` / `set_child_permission`）与条件性注册的名字（`bash` / `read_image` / `subagent_codex` / `subagent_claude_code`）只能判 WARN。
   来源：`restrict()` 未知名直接抛的实现；载体：[机检] 夹具 A 插 `not_a_tool_name` / `workflow` / `ralph` ⇒ exit `1`（这两个名字不在 composition 的注册面里），插 `set_child_permission` / `bash` ⇒ exit `0` 且各一条 WARN（[`testing-guide.md`](testing-guide.md) 用例 `T-1`）。
2. **禁止把"取值等于某个数"写成判错**：体积旋钮一律用插件出厂默认值，`FACTORY_DEFAULTS` 只在报告里当对照。
   来源：preset 侧体积闸门那次压测的实测后果——截断与提前压缩会把工具**已经取到**的事实切掉；载体：[人] 全文检索 `check-preset.mjs` 是否存在"取值 == 期望值"的比较（`FACTORY_DEFAULTS` 不得参与任何 `fail()` 分支）。
3. **改 composition 的 tool 行必须同步 `KNOWN_TOOLS`**：composition 有而清单无 ⇒ 合法名字被误报；清单有而 composition 无 ⇒ 坏配置被放过（运行期 `restrict()` 抛 `names unknown global tool ...`）。
   来源：`restrict()` 的挂载期判定；载体：[机检] 把差异名单里的任一名字临时加进某个 `allow`（委派行本身刻意不写 `allow`，可临时补一段）跑 `node tools/check-preset.mjs`，期望 ERROR 而 exit `0` = 漏报，期望通过而 ERROR = 误报。
4. **禁止把 WARN 当失败，也禁止把 `exit 0` 说成"运行期一定生效"**：有 WARN 而 ERROR 为 0 时退出码必须是 `0`；`exit 0` 只承诺"这些硬约束在文本上没被破坏"。
   来源：WARN 的语义是"条件不成立时那一次委派才抛错"，把它判成失败会让 CI 把通过读成失败；载体：[机检] 干净副本上只制造一条 WARN ⇒ 末行 `通过：0 个错误，1 个警告`、退出码 `0`。
5. **禁止在校验路径里引入第三方依赖、写文件或联网**。
   来源：零依赖是它的部署前提，本仓库没有 `node_modules`，安装脚本与技能都假设"克隆下来直接能跑"；校验器还必须能在只读介质上跑；载体：[人] 读 `check-preset.mjs` 的 import 行与全部写操作（应只有 `readFileSync` / `statSync`）。
6. **生成物不许手改**：`bundle/adg-plain/`、`bundle/adg-bili/`、`bundle/adg-save-token/`、`bundle/adg-bili-save-token/`（不传位置参数时是 `bundle/adg-ptc/`）是 `gen-preset-bundle.mjs` 的产物，`.gitignore` 忽略、每次安装都被覆盖；`$DSH_HOME/bundles/` 下那四个稳定目录只是落点。**落点目录名不要写死**，以 `flavors.mjs` 的 `dirNameFor(key)` 为准（味道键里的 `+` 换成 `-`）。
   来源：产物是构建输出而非源文件，手改会在下一次安装时静默消失；载体：[机检] 重跑生成器 / 重跑 `install.*` 即被覆盖（[`testing-guide.md`](testing-guide.md) 的「手改过生成物」一行）。

## 构建期注入组（禁忌项）

**构建期注入组的名字只能由构建期注入，禁止手写进 `preset/agent.cordis.yml`。** 目前两组：billion-context 的 `compress` / `decompress` / `search_context` / `acp_status`（同属该插件的 `acp_cache` 故意不注入）、save-token 的 `save_token_expand`。清单**只有一份**，写在 `tools/flavors.mjs` 的 `INJECTION_GROUPS`，其余脚本与本文档一律按它推导，**不另抄**。两侧后果都不轻：不给，子代理收到插件的"去调某个工具"指令却没有工具可用；给了而目标 profile 没装那个插件，名字不存在，每一次委派当场抛 `names unknown global tool ...`。

**改三个旋钮插件的版本 / 包名 / 键集 → 同步 `FACTORY_DEFAULTS` 与 `EXPECTED_ROWS` 的 `name` / `allowedKeys`，并重跑 `node tools/check-preset.mjs`**。`EXPECTED_ROWS` 里每行的 `name` 是期望包名、`allowedKeys` 是该插件 `config:` 认的全部键，`FACTORY_DEFAULTS` 记的是它该有的出厂值。不同步的后果两边都是缺陷：**合法配置被拦下**，或**整行挂载失败被放过**。来源：`@deepseek-ai/dsh-*` 的包名会随 dsh 升级改名，插件也会加删键。载体：[机检] 改完跑 `node tools/check-preset.mjs` ⇒ **exit 0**（ERROR 必须为 0），且报告里委派行清单非空、旋钮生效值行与插件的出厂默认值一致。

## 版本区

本模块在版本区里的文档就是这三份，都在仓库 `tools/` 下：`AGENTS.md`（本文，路由与红线）→ [`design.md`](design.md)（设计、不变量与数据模型）→ [`testing-guide.md`](testing-guide.md)（用例全表、迁移矩阵与未观测项）。三份都进 git、互相引用、**改了就原地更新**，不建"最新稿"、不留过程件。完整清单与根入口见根 `AGENTS.md` 的「版本区」一节，此处不另抄。

## 生效方式

六个脚本都**无常驻状态、也没有安装步骤**：改完存盘，下一次运行就是新版本（`node tools/check-preset.mjs` 直接读仓库里的 `preset/`）。两处例外：① 已经生成的 `bundle/` 产物**不会自动跟随**脚本改动，要重跑 `node tools/gen-preset-bundle.mjs`（或重跑 `install.ps1` / `install.sh`，它们每次安装都重跑生成器）；② 改 `KNOWN_TOOLS` / `FACTORY_DEFAULTS` / `EXPECTED_ROWS` 之后必须重跑 `node tools/check-preset.mjs`，复核委派行清单与旋钮生效值，且 **ERROR 必须为 0**。

脚本本身不参与运行期，所以改它们不需要重启 dsh；要让新的生成物在会话里真正生效，走 `preset/AGENTS.md`「生效方式」的口径：重装 bundle → 重启 dsh → 新对话验收。
# AGENTS.md — preset（Adg preset 的定义）

本模块是 Adg PTC 模式的**定义**：一份调度 persona（`## 你手上的子代理` 名册 + 分派与验收规则）与 `delegation` 组里那条唯一的委派行（委派行数以 `node tools/check-preset.mjs` 当场报出的为准）。**没有固定专家名册**：子代理的目标、边界、验收标准、工具面与可选 persona 全由调度者在每次委派时经全局工具 `delegate` 现给。
`preset.yml` / `agent.cordis.yml` / `bundle.package.json` 是 **bundle 的源**（唯一真相源，仓库里没有"已安装的第二份"）；`bundle/` 下的生成物不许手改，它由 `tools/gen-preset-bundle.mjs` 生成、装进 profile 的 `dsh.profile.bundles`。
**任何改动都要重新生成 + 重新安装 + 重启 dsh + 新对话才生效**（见「生效方式」）。设计细节与不变量一律在 `design.md`，验证判据在 `testing-guide.md`。

## 命令

零依赖，只要 Node（`browser/package.json` 与 `notify/package.json` 都声明 `>= 22`）。仓库根没有 `package.json`。

```sh
# 静态自检（逐行文本扫描，不是 YAML 解析器）：exit 0 通过 / 1 有 ERROR / 2 读不到目标文件
node tools/check-preset.mjs

# 生成 bundle（产物落在被 .gitignore 排除的 bundle/ 下；install.* 每次按探测结果重跑）
node tools/gen-preset-bundle.mjs                                     # plain
node tools/gen-preset-bundle.mjs --with-billion-context              # bili：注入上下文工具 + compaction-basic.auto=false
node tools/gen-preset-bundle.mjs --with-save-token                   # save-token：注入 save_token_expand
node tools/gen-preset-bundle.mjs --with-billion-context --with-save-token   # bili+save-token

# 产物自检（check-preset 看的是源文件，产物是它的盲区）：四种味道都要跑，判据 exit 0
node tools/gen-preset-bundle.mjs bundle/adg-plain && node tools/check-bundle-flavor.mjs bundle/adg-plain/cordis.patch.yml plain
node tools/gen-preset-bundle.mjs --with-billion-context bundle/adg-bili && node tools/check-bundle-flavor.mjs bundle/adg-bili/cordis.patch.yml bili
node tools/gen-preset-bundle.mjs --with-save-token bundle/adg-save-token && node tools/check-bundle-flavor.mjs bundle/adg-save-token/cordis.patch.yml save-token
node tools/gen-preset-bundle.mjs --with-billion-context --with-save-token bundle/adg-bili-save-token && node tools/check-bundle-flavor.mjs bundle/adg-bili-save-token/cordis.patch.yml bili+save-token
# 味道键必须写 `bili+save-token`（写成 `bili-save-token` 会 exit 2「未知的味道键」；稳定目录名才是 …-bili-save-token）

# 探测与味道映射（别在别处重写这份判定；味道键 / 稳定目录名 / 注入清单只有一份，在 tools/flavors.mjs）
node tools/has-bundle.mjs ~/.dsh/profiles web               # 每 profile 一行 `<name>\t<0|1>`（1 = 挂着）；正常输出 exit 0，**用法错**（参数不成对等）才 exit 2
node tools/has-bundle.mjs ~/.dsh/profiles web --package=dsh-plugin-save-token
node tools/resolve-flavor.mjs --billion-context --save-token                 # → `<味道键>\t<稳定目录名>\t<gen 旗标>`

# 首装或重装（技能 + preset bundle + browser / desktop 工具链 + notify / permission / delegate / settings 四枚子插件）
sh install.sh                                                     # macOS / Linux
powershell -ExecutionPolicy Bypass -File .\install.ps1            # Windows
# 只给某个 profile 用 bili 注入版：sh install.sh --billion-context=on web  /  ... -BillionContext on -Profiles web
```

**读数是当场读数，不作锚**：上面各脚本打印的通过/警告条数、字节数、行坐标都随文件变动而漂；要它们就当场跑脚本读它自己的输出，别把数字抄进文档。

## 红线

只列 preset 独有的三类（承载体积旋钮的三行、persona 预算与 `## 约束` / `## 验收标准` / `## 回复内容` 三个锚段、composition 里的 `@deepseek-ai/*` 包名核对）；每条只写结论与理由（**违反即返工**），载体的含义是该条靠什么被钉住。**根 `AGENTS.md`「关键红线」全部适用**；原表其余各条（原 #1 / #2 / #5–#14 / #16 / #17）的结论本体见 `preset/design.md` 的「非功能红线」（R1–R27）与「核心数据模型」的不变量 —— 逐条对照见本表后面的「原表其余各条的去处」。**编号沿用原表编号**（外部文档按编号引用本表，重排会让那些引用指错）。

| # | 红线 | 来源 / 载体 |
|---|---|---|
| 3 | 禁止给承载体积旋钮的三行写回覆盖值（`compaction-basic` / `tool-result-pruner` / `tool-web`）：一律用插件出厂默认；一并禁止把交付侧的证据落点判据（按【拆解立目标】里的【验收标准】逐条判定）简化成"让子代理自报"。理由：截断会把工具**已经取到**的事实切掉，子代理只能重取或拿残缺证据下结论；提前压缩让上下文不可逆失真 —— 两者都比不裁更贵；而拿不出前后对比数字就无法判断改动是否真的省了成本，所以确实要改体积旋钮时，必须按 `preset/design.md` 的「PresetRevision」里那条对比数字的不变量，改动前后各按 `preset/testing-guide.md` 的「怎么重新测量」跑一次会话审计。 | `tools/check-preset.mjs`（旋钮行）；`tools/check-preset.mjs` 的 persona 段存在性检查 + `preset/design.md`（证据落点判据） |
| 4 | 禁止在 persona 里写 token / 读取预算或字数次数上限，也禁止把 `## 约束` / `## 验收标准` / `## 回复内容` 改写成分步流程与固定字段表。理由：那把子代理的注意力从"做对"挪到"少写"；这三个锚段约束的是"派给谁 / 派几次 / 材料怎么中转 / 写下来的东西怎么组织"。 | `tools/check-preset.mjs` 的段存在性检查；`preset/design.md` 的「对外接口」 |
| 15 | composition 里每个 `@deepseek-ai/*` 包名都必须对着当前安装核对（判定口径的唯一本体是 `preset/design.md` 的「核心数据模型」里那条包名核对不变量；改动后怎么生效、怎么复核见本文件「生效方式」表同名那行）。 | 真实挂载；静态自检发现不了 |

**原表其余各条的去处**（原编号 → 结论本体现在在哪，跟着编号仍能找到）：

| 原 # | 现在在哪 |
|---|---|
| 1 | `preset/design.md` 的「非功能红线」R22（`validated` 与 `mounted` 不是一回事）；不变量本体在它的「PresetRevision」一节 I1 / I5 |
| 2 | `preset/design.md` 的「非功能红线」R23（没重启 dsh 不许宣称已生效）；不变量本体在它的 I2 |
| 5 | 根 `AGENTS.md`「关键红线」第 1 条与 `4b`；细节在 `delegate/AGENTS.md` 的 R1 |
| 6 | 根 `AGENTS.md`「关键红线」第 6 条 |
| 7 | 根 `AGENTS.md`「关键红线」第 5 条 |
| 8 | 根 `AGENTS.md`「关键红线」第 7 条；`tools_note` 与条件性注册的名字见 `preset/design.md` 的 R8 |
| 9 | `preset/design.md` 的「非功能红线」R24（有 `pwsh` 就必须同给 `job_list` / `job_output` / `job_kill`）；不变量本体在它的 I14 |
| 10 | `preset/design.md` 的「非功能红线」R25（子代理工具面不写 `skill`）；不变量本体在它的 I15 |
| 11 | 根 `AGENTS.md`「关键红线」第 10 条（构建期注入名不许手写） |
| 12 | `preset/design.md` 的「非功能红线」R10 / R11（权限闸门是提示级、不许写成强制） |
| 13 | `preset/design.md` 的「非功能红线」R12（子代理问人只走 `adg-delegate` 的 `ask_user`） |
| 14 | `preset/design.md` 的「非功能红线」R13（请用户手动登录是正常入口，不是失败） |
| 16 | `preset/design.md` 的「非功能红线」R26（`preset/agent.cordis.yml` 是 UTF-8 无 BOM） |
| 17 | 根 `AGENTS.md`「关键红线」第 2 条（工具面是能力边界，不是提示） |

**编号不重排**：本表只列 preset 独有的三类（#3 / #4 / #15），编号沿用原表编号 —— 外部文档（`permission/AGENTS.md` 的 R9、`desktop/design.md`）按编号引用本表，重排会让那些引用指错；被移走的各条按原编号列在上表，跟着编号仍能找到。原 #3 这一条同时覆盖两项判据（体积旋钮写回 + 交付侧证据落点判据），两项都要照做，不要拆成两条。

**未观测**：不重启 dsh 时新开的会话会不会直接加入重注册后的声明；量法：改一次源文件、重装 bundle，不重启就新开一个会话，读 `agentPresets.resolve('adg-ptc')` 的解析结果与调度 persona 名册是否已是新版。

## 跨模块路由

| 你要做什么 | 先读 | 再读 |
|---|---|---|
| 改委派能力 / 工具面映射（派什么、给哪些工具） | `skills/adg-delegation/SKILL.md` | 本文件「红线」→ `preset/design.md` 的「DelegationRow 与动态工具面」→ 改完跑上节第 1 条命令 |
| 改浏览器那一段委派口径（模式 / 登录态 / 权限闸门） | `preset/design.md` 的「SchedulerPersona」 | `browser/AGENTS.md`（它消费的命令行契约）→ 根 `README.md` 的「浏览器工具链与登录态资产」一节 |
| 改 composition 的 tool 行 / 体积旋钮 | `preset/design.md` 的「非功能红线」 | `tools/design.md`（判错口径） |

其余各条见根 `AGENTS.md` 的「Context Loading」表（全仓路由主表）：改 `delegate` 插件本身 / 改调度 persona 名册 / 通知子插件 / 权限插件 / 只想弄懂怎么装到本机 —— 此处不另抄。

## 版本区

本模块在版本区里的文档就是 `preset/AGENTS.md`（本文件，路由）→ [`design.md`](design.md)（设计、状态机与不变量）→ [`testing-guide.md`](testing-guide.md)（用例全表与未观测项）这三份，加**不在版本区**的临时工作目录 `docs-work/`（过程件住那里，交付前清空到空目录）。完整清单与根入口见根 `AGENTS.md` 的「版本区」一节，此处不另抄。
给人看的安装与使用说明在根 `README.md`。

**未观测**：本模块文档与源文件之间是否还有别的未登记漂移；量法：按根 `AGENTS.md`「Quality Gates」的文档合规那行逐条自检一遍，把发现的漂移就地写进对应文档。

## 生效方式

改动怎么生效、怎么复核（**口径不同，别承诺错**）：

| 改了什么 | 怎么生效 | 怎么复核 |
|---|---|---|
| `preset/` 任何文件（含改委派能力 / 工具面映射） | 重跑生成 + 重装 bundle（`install.*` 会自动做），再**重启 dsh**，然后在**新对话**里选 Adg PTC 模式 | 按根 `README.md` 的「真实挂载验证」一节做一次**真实挂载**；静态自检证明不了挂载 |
| 只切换注入组 / 味道（同一份源文件分四种味道、四个稳定落点） | 重新生成 + 重装 bundle + 重启 dsh + 新会话 | 先看该 profile 的 `node_modules/dsh-adg-ptc` 链接的是哪一份稳定目录，再用 `node tools/check-bundle-flavor.mjs <那份文件> <味道键>` 断言那一份（`install.*` 装完已经这么断言）；再在新会话里用 `delegate` 派一个子代理，让它报工具目录里看得见注入的那几个名字 |
| composition 里写的 `@deepseek-ai/*` 包名 | 包名会随 dsh 升级改名，改完必须真实挂载 | `agentPresets.resolve('adg-ptc')` 的 `.broken` 为空；用旧名会报 `… never started` |

其余各类（`notify/` / `permission/` / `delegate/` / `browser/` / `desktop/` / 本仓库任何 `.md`）的生效口径与复核指针见根 `AGENTS.md` 的「生效方式」表与各自模块 `AGENTS.md` 的对应节 —— 此处不另抄。`@deepseek-ai/*` 包名那行留在本表里，因为本文件「红线」#15 指的就是它。

**已知限制**：dsh 正在运行时 `pnpm` 会因文件被占用而失败（`os error 32` / `ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR`），脚本会如实报告并继续；包已在位时不算失败。要真正装/换依赖先关掉 dsh。

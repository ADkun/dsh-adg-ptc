# 安装 Adg PTC 模式 preset + 配套技能到本机 dsh 用户根。
# 用法： powershell -ExecutionPolicy Bypass -File .\install.ps1
#        powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profiles web,desktop
#        powershell -ExecutionPolicy Bypass -File .\install.ps1 -BillionContext on -SaveToken on -Profiles web
# 注意：本文件必须保留 UTF-8 BOM —— Windows PowerShell 5.1 在没有 BOM 时会按系统 ANSI
# 代码页读取脚本，中文变成乱码并直接解析失败（去掉 BOM 后本机复现过）。载体：改完手动核
# 前三个字节仍是 EF BB BF（见根 AGENTS.md 的红线）。
#
# preset 现在的形状是一个 bundle：包清单声明 dsh.bundle.patch，patch 里 insert 一行
# @deepseek-ai/dsh-agent-preset 声明（id/name/description/order/plugins）。
# `$DSH_HOME\.agent-presets\<id>\` 那套目录发现机制已不存在，拷 preset.yml + agent.cordis.yml
# 装出来的东西没有任何组件会去读。本脚本：生成 bundle → 放到 $DSH_HOME\bundles\ →
# 装进目标 profile 的 node_modules 并写进该 profile 的 dsh.profile.bundles。
#
# preset 的生成物有**四种味道**（两个注入组的四种组合），每种占一个稳定目录 ——
#   $DSH_HOME\bundles\dsh-adg-ptc                 plain（generate 不带旗标）
#   $DSH_HOME\bundles\dsh-adg-ptc-bili            bili（调度 persona 里带 bili 的四个上下文工具）
#   $DSH_HOME\bundles\dsh-adg-ptc-save-token      save-token（带 save_token_expand）
#   $DSH_HOME\bundles\dsh-adg-ptc-bili-save-token 两组都带
# 四种的**包名都是 `dsh-adg-ptc`**，所以 profile 的 `dsh.profile.bundles` 那一行四种味道通用，
# 差别只在它 node_modules 里的那个 link 指向哪一个目录。每个 profile 按**自己的**探测结果选，
# 于是混装（一个 profile 挂 bili、另一个没挂）也能各拿对的形状。味道键、稳定目录名与 gen 旗标都在
# 第 0 / 3 节问 `node tools\resolve-flavor.mjs`（拼法只写在 tools\flavors.mjs，本脚本不重拼）。
# **不要再退回"生成物全机共用一份 + 每个目标 profile 都挂着才注入"那套口径**：那种做法在混装机器上
# 必然给挂着 bili 的那个 profile 装 plain —— 子代理收到 bili 的压缩指令却没有工具可调（本机复现过：
# web 挂 bili、desktop 没挂 ⇒ auto 选中 plain ⇒ web 的子代理报 `unknown tool compress`）。
param(
  [string[]]$Profiles,
  [switch]$SkipPackages,
  # billion-context 协同开关，语义见下面第 0 节「注入组探测」：
  #   auto（默认）= **按每个 profile 自己的探测结果**决定它装哪一份生成物：装了对应插件的装带该组的味道，
  #                 没装的装 plain。混装机器上各归各家：每个 profile 拿它自己该拿的那一份。
  #   on  = 给**所有目标 profile** 都用带 bili 那一组的味道（自己保证它们都挂上了 billion-context，
  #         否则调度者照说明把 compress 那一组写进委派时一个都不生效）
  #   off = 给所有目标 profile 都用不带 bili 那一组的味道
  [ValidateSet('auto', 'on', 'off')] [string]$BillionContext = 'auto',
  # save-token 协同开关，与 $BillionContext **完全并列、语义相同**（同一套 auto/on/off）：
  #   auto（默认）= 按每个 profile 自己的探测结果决定它装哪一份生成物：装了 dsh-plugin-save-token 的
  #                 才往调度 persona 注入 `save_token_expand` 的说明；on / off 是整体覆盖。
  #   给没装的 profile 注入 = 调度者照说明把 `save_token_expand` 写进某次委派，而那个名字在本次会话里
  #   根本不存在 —— `delegate` 会把它剔掉并逐条写进 `tools_note`（那次委派不会失败，但名字等于白给）；
  #   给装了的不注入 = 子代理收到 `[save-token #id] … Call the save_token_expand tool` 的通知却没有工具可调。
  [ValidateSet('auto', 'on', 'off')] [string]$SaveToken = 'auto'
)
$ErrorActionPreference = 'Stop'

$root = $env:DSH_HOME
if (-not $root) { $root = Join-Path $HOME '.dsh' }
# 先把 DSH_HOME 归一成绝对路径：稳定落点、探测与生成日志都按绝对路径用。
if (-not [System.IO.Path]::IsPathRooted($root)) { $root = Join-Path (Get-Location).Path $root }
$root = [System.IO.Path]::GetFullPath($root)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$skillsRoot = Join-Path $root 'skills'
$bundleName = 'dsh-adg-ptc'
# 四个稳定落点（包名都是 $bundleName，见文件头）：名字不在本脚本里拼 —— 第 3 节问
# `node tools\resolve-flavor.mjs` 拿（拼法只写在 tools\flavors.mjs）。每个 profile 的 node_modules 里只 link 其中一个。

# ── 目标 profile ────────────────────────────────────────────────────────────────
# 默认：能装 preset 的所有 profile —— 判据是它的 bundle 列表里有 @deepseek-ai/dsh-web-app，
# 因为 agent-preset-registry（agentPresets 服务）正是这个 bundle 声明的（实测：dsh-base 和
# dsh-headless 都不声明它）。往缺 registry 的 profile 里塞声明行会让该 profile 启动失败。
$profilesDir = Join-Path $root 'profiles'
if (-not $Profiles -or $Profiles.Count -eq 0) {
  $Profiles = @()
  foreach ($dir in Get-ChildItem -LiteralPath $profilesDir -Directory -ErrorAction SilentlyContinue) {
    if ($dir.Name -eq 'node_modules') { continue }
    $manifest = Join-Path $dir.FullName 'package.json'
    if (-not (Test-Path -LiteralPath $manifest)) { continue }
    # 防御式读取：profile 目录里可能有 dsh.profile 缺字段的 package.json（或根本不是 profile），
    # 那样的目录不该让整个安装脚本崩掉，跳过即可（判据本身只认 bundles 列表里有 web-app 的）。
    $json = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $bundles = @()
    if ($json.dsh -and $json.dsh.profile -and $json.dsh.profile.bundles) { $bundles = @($json.dsh.profile.bundles) }
    if ($bundles -contains '@deepseek-ai/dsh-web-app') { $Profiles += $dir.Name }
  }
}
if ($Profiles.Count -eq 0) { throw "在 $profilesDir 下没找到可装 preset 的 profile（判据：dsh.profile.bundles 含 @deepseek-ai/dsh-web-app）" }

# ── 0. 注入组探测（billion-context / save-token；两组各探一次）─────────────────────
# 口径：**先探测该环境下是否装有对应插件；装了才注入它的工具名**（这正是 auto 的语义）。
# 判据只有一条，决定这个 profile 的子代理能看见哪些全局层工具：
#   子代理要不要看见某个插件的全局层工具（bili 的 compress / decompress / search_context / acp_status；
#      save-token 的 save_token_expand）。这决定该 profile 链接哪一种味道的生成物（四个稳定目录，见文件头）。
#      **按 profile 决定**：给没装的 profile 注入，它每一次委派都会抛 `names unknown global tool "<名字>"`
#      （restrict() 的真行为，AGENTS.md 红线 7）；反过来给装了的不注入，子代理就收到该插件的指令却没有工具可调
#      （bili 的压缩指令 / save-token 的 `[save-token #id] … Call the save_token_expand tool` 通知）——
#      两头都是缺陷，所以不能再用"宁可少给"一刀切。
#      `-BillionContext on|off` / `-SaveToken on|off` 是**整体覆盖**（所有目标 profile 同一味道），
#      auto 才是按 profile 选。
# 判据在 tools\has-bundle.mjs（bili 用缺省包名，save-token 加 --package=dsh-plugin-save-token）：
# 每个组两条判据都要成立才算"装着"，两处安装脚本共用一份实现，不要在这里重写。
# 探测结果不能靠 `@(& node ...)` 收（见下面 4b-1 里同一条实测）：把原生命令的 stdout 收进变量时，
# 拿不到输出、$LASTEXITCODE 还是上一条命令留下的值 —— 判据会静默变成"全都没装"，于是装着的 profile 也被
# 当成没装。走 cmd 重定向写文件再读（与 4a 的 pnpm 同一套做法），并且**显式检查探测自己的退出码、
# 也检查结果文件在不在**：探测没跑成（≠"没装"）必须当场停，否则整个安装会按错误的味道装下去。
function Get-BundleMounts {
  param([string]$PackageArg, [string]$LogName)
  $log = Join-Path $root $LogName
  $names = (@($Profiles) | ForEach-Object { '"' + [string]$_ + '"' }) -join ' '
  cmd /c "node `"$here\tools\has-bundle.mjs`" `"$profilesDir`" $names $PackageArg > `"$log`" 2>&1"
  $probeExit = $LASTEXITCODE
  if ($probeExit -ne 0 -or -not (Test-Path -LiteralPath $log)) {
    throw "tools\has-bundle.mjs $PackageArg 探测没跑成（exit $probeExit，结果文件 $(if (Test-Path -LiteralPath $log) { '在' } else { '不在' })）—— 安装停在这里，不要按未探测的状态继续装"
  }
  $mounts = [ordered]@{}
  foreach ($line in @(Get-Content -LiteralPath $log -Encoding UTF8)) {
    $parts = "$line".Split("`t")
    if ($parts.Length -ge 2) { $mounts[[string]$parts[0]] = ($parts[1].Trim() -eq '1') }
  }
  Remove-Item -LiteralPath $log -Force
  foreach ($name in @($Profiles)) {
    if ($mounts[[string]$name] -eq $null) { $mounts[[string]$name] = $false }
  }
  return $mounts
}
$biliMounts = Get-BundleMounts -PackageArg '' -LogName 'adg-bili-probe.log'
$saveTokenMounts = Get-BundleMounts -PackageArg '--package=dsh-plugin-save-token' -LogName 'adg-save-token-probe.log'

# 一组按 auto/on/off 解析：auto = 这个 profile 自己的探测值；on / off = 强制。
function Resolve-GroupWanted {
  param([string]$Mode, [bool]$Probed)
  switch ($Mode) {
    'on' { return $true }
    'off' { return $false }
    default { return $Probed }
  }
}
# 每个目标 profile 最终注入哪几组，以及由 tools\resolve-flavor.mjs 给的三列
# （味道键 / 稳定目录名 / gen 旗标）。探测与 auto/on/off 的判定在上面，resolve-flavor 只做映射。
$biliWanted = [ordered]@{}
$saveTokenWanted = [ordered]@{}
$flavorOf = [ordered]@{}
$bundleDirOf = [ordered]@{}
$flavorResolveLog = Join-Path $root 'adg-resolve-flavor.log'
foreach ($name in @($Profiles)) {
  $wantBili = Resolve-GroupWanted -Mode $BillionContext -Probed ([bool]$biliMounts[[string]$name])
  $wantSaveToken = Resolve-GroupWanted -Mode $SaveToken -Probed ([bool]$saveTokenMounts[[string]$name])
  $biliWanted[[string]$name] = $wantBili
  $saveTokenWanted[[string]$name] = $wantSaveToken
  $groupFlags = @()
  if ($wantBili) { $groupFlags += '--billion-context' }
  if ($wantSaveToken) { $groupFlags += '--save-token' }
  cmd /c "node `"$here\tools\resolve-flavor.mjs`" $($groupFlags -join ' ') > `"$flavorResolveLog`" 2>&1"
  if ($LASTEXITCODE -ne 0) { throw "tools\resolve-flavor.mjs $($groupFlags -join ' ') 失败（exit $LASTEXITCODE）" }
  $resolvedLines = @(Get-Content -LiteralPath $flavorResolveLog -Encoding UTF8)
  Remove-Item -LiteralPath $flavorResolveLog -Force -ErrorAction SilentlyContinue
  if ($resolvedLines.Count -eq 0) { throw "tools\resolve-flavor.mjs 没写出结果（$flavorResolveLog 是空的）" }
  $resolvedParts = "$($resolvedLines[0])".Split("`t")
  if ($resolvedParts.Length -lt 3) { throw "tools\resolve-flavor.mjs 的输出不是三列 TSV：$($resolvedLines[0])" }
  $flavorOf[[string]$name] = [string]$resolvedParts[0]
  $bundleDirOf[[string]$name] = [string]$resolvedParts[1]
}

# 探测名单（供日志与覆盖提醒用）。
$biliOnProfiles = @($Profiles | Where-Object { $biliMounts[[string]$_] })
$biliOffProfiles = @($Profiles | Where-Object { -not $biliMounts[[string]$_] })
$saveTokenOnProfiles = @($Profiles | Where-Object { $saveTokenMounts[[string]$_] })
$saveTokenOffProfiles = @($Profiles | Where-Object { -not $saveTokenMounts[[string]$_] })
$biliOnText = $(if ($biliOnProfiles.Count -gt 0) { "已挂载 [$($biliOnProfiles -join ', ')]" } else { '没有任何目标 profile 挂载' })
$biliOffText = $(if ($biliOffProfiles.Count -gt 0) { "[$($biliOffProfiles -join ', ')]" } else { '无' })
$saveTokenOnText = $(if ($saveTokenOnProfiles.Count -gt 0) { "已挂载 [$($saveTokenOnProfiles -join ', ')]" } else { '没有任何目标 profile 挂载' })
$saveTokenOffText = $(if ($saveTokenOffProfiles.Count -gt 0) { "[$($saveTokenOffProfiles -join ', ')]" } else { '无' })
Write-Host "billion-context 探测：$biliOnText / 未挂载 $biliOffText"
Write-Host "save-token 探测：$saveTokenOnText / 未挂载 $saveTokenOffText"
foreach ($name in @($Profiles)) {
  $flavor = [string]$flavorOf[[string]$name]
  $flavorNoteParts = @()
  if ($biliWanted[[string]$name]) { $flavorNoteParts += 'bili 的四个上下文工具' }
  if ($saveTokenWanted[[string]$name]) { $flavorNoteParts += 'save-token 的 save_token_expand' }
  $flavorNote = $(if ($flavorNoteParts.Count -gt 0) { "调度 persona 里带 $($flavorNoteParts -join ' + ')" } else { '不带任何注入的上下文工具' })
  Write-Host "  味道 -> $name : $flavor（$flavorNote）"
}
# 覆盖开关与探测结果对不上时必须明说：判断错的那一方不是少个能力就是每次委派都挂（红线 7）。
# 每组三档的错配都要报出来：on 但一个都没装 / on 被强制套到没装的 profile / off 把装着的关掉。
$biliWantedProfiles = @($Profiles | Where-Object { $biliWanted[[string]$_] })
$biliUnwantedProfiles = @($Profiles | Where-Object { -not $biliWanted[[string]$_] })
$biliForcedOntoOff = @($biliWantedProfiles | Where-Object { -not $biliMounts[[string]$_] })
$biliForcedOffOfOn = @($biliUnwantedProfiles | Where-Object { $biliMounts[[string]$_] })
if ($BillionContext -eq 'on' -and $biliWantedProfiles.Count -eq 0) {
  Write-Host "billion-context：-BillionContext on 但没有任何目标 profile 挂着它 —— 仍按 on 装带 bili 那一组的味道，请确认这些 profile 之后会装上 billion-context（否则委派会抛 unknown global tool）" -ForegroundColor Yellow
} elseif ($biliForcedOntoOff.Count -gt 0) {
  Write-Host "billion-context：-BillionContext on 强制注入，但这些目标 profile 没挂 bili：$($biliForcedOntoOff -join ', ') —— 它们每一次委派都会抛 names unknown global tool `"compress`"（要么给它们装上 bili，要么改回 auto）" -ForegroundColor Yellow
}
if ($BillionContext -eq 'off' -and $biliForcedOffOfOn.Count -gt 0) {
  Write-Host "billion-context：-BillionContext off 强制不注入，但这些目标 profile 挂着 bili：$($biliForcedOffOfOn -join ', ') —— 它们的子代理会收到 bili 的压缩指令却没有工具可调（改回 auto 才会按 profile 选味道）" -ForegroundColor Yellow
}
$saveTokenWantedProfiles = @($Profiles | Where-Object { $saveTokenWanted[[string]$_] })
$saveTokenUnwantedProfiles = @($Profiles | Where-Object { -not $saveTokenWanted[[string]$_] })
$saveTokenForcedOntoOff = @($saveTokenWantedProfiles | Where-Object { -not $saveTokenMounts[[string]$_] })
$saveTokenForcedOffOfOn = @($saveTokenUnwantedProfiles | Where-Object { $saveTokenMounts[[string]$_] })
if ($SaveToken -eq 'on' -and $saveTokenWantedProfiles.Count -eq 0) {
  Write-Host "save-token：-SaveToken on 但没有任何目标 profile 装着它 —— 仍按 on 装带 save-token 那一组的味道，请确认这些 profile 之后会装上 dsh-plugin-save-token（否则委派会抛 unknown global tool）" -ForegroundColor Yellow
} elseif ($saveTokenForcedOntoOff.Count -gt 0) {
  Write-Host "save-token：-SaveToken on 强制注入，但这些目标 profile 没装 dsh-plugin-save-token：$($saveTokenForcedOntoOff -join ', ') —— 它们每一次委派都会抛 names unknown global tool `"save_token_expand`"（要么给它们装上那个插件，要么改回 auto）" -ForegroundColor Yellow
}
if ($SaveToken -eq 'off' -and $saveTokenForcedOffOfOn.Count -gt 0) {
  Write-Host "save-token：-SaveToken off 强制不注入，但这些目标 profile 装着 dsh-plugin-save-token：$($saveTokenForcedOffOfOn -join ', ') —— 它们的子代理会收到 `"[save-token #id] … Call the save_token_expand tool`" 的通知却没有工具可调（改回 auto 才会按 profile 选味道）" -ForegroundColor Yellow
}

# ── 1. 用户技能 ────────────────────────────────────────────────────────────────
# 拷 skills/ 下的**所有**技能目录：技能是渐进式披露的载体，调度者按绝对路径让子代理先 read 它 ——
# 少拷一份，那条「先 read 该文件再动手」的委派就读不到东西。
$skillsSrc = Join-Path $here 'skills'
$skillCopied = 0
foreach ($skillDir in Get-ChildItem -LiteralPath $skillsSrc -Directory -ErrorAction SilentlyContinue) {
  $src = Join-Path $skillDir.FullName 'SKILL.md'
  if (-not (Test-Path -LiteralPath $src)) { continue }
  $dest = Join-Path $skillsRoot $skillDir.Name
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item -LiteralPath $src -Destination (Join-Path $dest 'SKILL.md') -Force
  $skillCopied++
}
$skillNote = "用户技能 -> $skillsRoot（$skillCopied 份 SKILL.md）"

# ── 2. browser/ 工具链 ─────────────────────────────────────────────────────────
# 它是普通文件、不是插件也不是 preset：重新跑一次本脚本就生效，**不需要重启 dsh**。
# 先删后拷，避免上一层版本的残留。
$browserSrc = Join-Path $here 'browser'
$browserDest = Join-Path $root 'browser'
if (Test-Path -LiteralPath $browserSrc) {
  if (Test-Path -LiteralPath $browserDest) { Remove-Item -LiteralPath $browserDest -Recurse -Force }
  Copy-Item -LiteralPath $browserSrc -Destination $browserDest -Recurse -Force
  $browserNote = "browser/ 工具链 -> $browserDest"
} else {
  $browserNote = "未找到 $browserSrc，跳过 browser/ 工具链部署"
}

# ── 2c. desktop/ 工具链 ────────────────────────────────────────────────────────
# 与 2. browser/ 同口径：普通文件、不是插件也不是 preset，重新跑一次本脚本就生效，
# **不需要重启 dsh**。先删后拷，避免上一层版本的残留。
# 注意：它只是把 CLI 与随附的 PowerShell 桥拷过去；真正驱动普通用户窗口需要在
# **完全权限**（danger-full-access）的会话里调用，受限令牌的 Low 完整性级别会被 UIPI 拦下。
$desktopSrc = Join-Path $here 'desktop'
$desktopDest = Join-Path $root 'desktop'
if (Test-Path -LiteralPath $desktopSrc) {
  if (Test-Path -LiteralPath $desktopDest) { Remove-Item -LiteralPath $desktopDest -Recurse -Force }
  Copy-Item -LiteralPath $desktopSrc -Destination $desktopDest -Recurse -Force
  $desktopNote = "desktop/ 工具链 -> $desktopDest"
} else {
  $desktopNote = "未找到 $desktopSrc，跳过 desktop/ 工具链部署"
}

# ── 2b. notify/ 插件（notify_user 工具）────────────────────────────────────────
# 与 preset bundle 的区别（别混成一条，两者是不同的加载路径）：
#   preset bundle 靠 profile 里的 `link:` 依赖 + dsh.profile.bundles 装载；
#   本插件是**普通插件包**，靠 profile 里的 `file:` 依赖 + dsh.profile.bundles 装载。
#   本机的 anysearch-dsh 与 dsh-windows-notifier 都是 `file:` 形状（装成 profile
#   node_modules 下的真目录），本插件与它们同形。preset bundle 用 `link:`、普通插件包用 `file:`，
#   两条装载路径都可用 —— 本插件用 `file:`（与两个在跑的插件一致；插件的
#   `@deepseek-ai/dsh-tools` 裸 import 由 dsh 自己的解析拦截层满足）。
#
# 先把源码拷到用户根下的**稳定副本**，再让每个 profile 依赖它。理由：profile 里的 `file:`
# 指向仓库工作区的话，仓库一移动/删除，那个 profile 就解析不到包了（preset bundle 特意不这么做）。
# 代价是"改了源码要跑一次本脚本才生效"（note 里写明）。而且稳定副本按内容比对——
# 内容没变就不动它，免得 pnpm 在下次 `add` 时又要重装一遍（dsh 在跑时那一步会 os error 32）。
$notifySrc = Join-Path $here 'notify'
$notifyDest = Join-Path $root 'plugins\adg-notify'
$notifyManifest = Join-Path $notifyDest 'package.json'
# 这里的拷贝清单与 notify\package.json 的 `files` 字段**故意不同**：本清单比它多 `cli.mjs`（仓库内自测 / 手工发通知用）与 `package.json`（稳定副本要能当包被 `dsh plugin add "file:…"` 解析）。`files` 那 8 条是给 npm pack 用的，所以 profiles 里那份副本是 9 个文件、没有 `cli.mjs` 是预期。差异是刻意的，见 notify\testing-guide.md 的漂移检测一节。
# 注意：稳定副本 ↔ profile 副本是**逐文件**硬链接，所以往这里加一个新文件（比如 lib\user-settings.mjs）
# **不会**自己传播到已经装好的 profile —— pnpm 只在 `add` 时拷文件。加了新文件就要重跑本脚本
# （脚本尾部的「profile 副本缺文件」核对会把这种情况报出来）。
$notifyFiles = @('index.mjs', 'cli.mjs', 'lib\toast.mjs', 'lib\user-settings.mjs', 'scripts\toast.ps1', 'cordis.patch.yml',
  'package.json', 'AGENTS.md', 'design.md', 'testing-guide.md')
$notifyNote = ''
$notifySkipped = $false
# dsh CLI：用来把插件装进各 profile（`dsh plugin --profile <n> add file:<dir>`）。
# 找不到就只报告、不安装，其余步骤照跑（与 4a 对 pnpm 缺失的处理同形）。
$dshCmd = (Get-Command dsh -ErrorAction SilentlyContinue)
# $notifyNeedInstall：这个 profile 还欠一次 `dsh plugin add`（只在"这个 profile 里没有这个包"时为真）。
$notifyNeedInstall = $false
if ($SkipPackages) {
  $notifyNote = '跳过（-SkipPackages）'
  $notifySkipped = $true
} elseif (-not (Test-Path -LiteralPath (Join-Path $notifySrc 'package.json'))) {
  $notifyNote = "未找到 $notifySrc，跳过 notify/ 插件部署"
  $notifySkipped = $true
} else {
  # 目录要先建出来：Copy-Item 不会自己创建中间层。
  # 不加 -Recurse -Force 的全目录删除：稳定副本里有 node_modules 时那会连带删掉
  # pnpm 的解析桥（任何进程都在用的 Junction），Windows 会拒绝。
  New-Item -ItemType Directory -Force -Path (Join-Path $notifyDest 'lib') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $notifyDest 'scripts') | Out-Null
  $copied = 0
  $missing = @()
  foreach ($rel in $notifyFiles) {
    $from = Join-Path $notifySrc $rel
    $to = Join-Path $notifyDest $rel
    if (-not (Test-Path -LiteralPath $from)) { $missing += $rel; continue }
    # 先比内容：一样就不碰，省掉一次无谓的重装。
    $same = $false
    if (Test-Path -LiteralPath $to) {
      $a = (Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash
      $b = (Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash
      $same = ($a -eq $b)
    }
    if ($same) { continue }
    Copy-Item -LiteralPath $from -Destination $to -Force
    $copied += 1
  }
  if ($missing.Count -gt 0) {
    $notifyNote = "notify/ 部署不完整：源里缺 $($missing -join ', ')"
  } elseif ($copied -gt 0) {
    $notifyNote = "notify/ 插件 -> $notifyDest（本次更新 $copied 个文件）"
  } else {
    $notifyNote = "notify/ 插件 -> $notifyDest（已是最新，无需拷贝）"
  }
}

# ── 2b-1. permission/ 插件（set_child_permission 工具）────────────────────────
# 与 2b 同形（普通插件包、file: 依赖、用户根下的稳定副本），但**消费方不同**：
# 这个工具只给调度智能体用，不进任何一次委派的 tools（子代理本来就不该有子代理）。
# 所以漏装的后果不是派发时报 `names unknown global tool`，而是调度者需要改权限时调到一个
# 不存在的工具 —— 同样必须装，同样必须重启 dsh 才注册。
$permSrc = Join-Path $here 'permission'
$permDest = Join-Path $root 'plugins\adg-permission'
$permNote = ''
$permSkipped = $false
# 4c-3 的断言要用它；在这里初始化，免得某个分支没赋值就被读。
$permInProfile = ''
if ($SkipPackages) {
  $permNote = '跳过（-SkipPackages）'
  $permSkipped = $true
} elseif (-not (Test-Path -LiteralPath (Join-Path $permSrc 'package.json'))) {
  $permNote = "未找到 $permSrc，跳过 permission/ 插件部署"
  $permSkipped = $true
} else {
  # 本清单与 permission/package.json 的 `files` 字段**故意不同**：多一个 `package.json`
  # （稳定副本要能当包被 `dsh plugin add "file:…"` 解析）。本插件没有 cli.mjs。
  New-Item -ItemType Directory -Force -Path (Join-Path $permDest 'lib') | Out-Null
  $permFiles = @('index.mjs', 'lib\permission.mjs', 'cordis.patch.yml', 'package.json', 'AGENTS.md', 'design.md', 'testing-guide.md')
  $permCopied = 0
  $permMissing = @()
  foreach ($rel in $permFiles) {
    $from = Join-Path $permSrc $rel
    if (-not (Test-Path -LiteralPath $from)) { $permMissing += $rel; continue }
    $to = Join-Path $permDest $rel
    $same = (Test-Path -LiteralPath $to) -and ((Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash)
    if ($same) { continue }
    Copy-Item -Force -LiteralPath $from -Destination $to
    $permCopied += 1
  }
  if ($permMissing.Count -gt 0) {
    $permNote = "permission/ 部署不完整：源里缺 $($permMissing -join ', ')"
    $permSkipped = $true
  } elseif ($permCopied -gt 0) {
    $permNote = "permission/ 插件 -> $permDest（本次更新 $permCopied 个文件）"
  } else {
    $permNote = "permission/ 插件 -> $permDest（已是最新，无需拷贝）"
  }
}

# ── 2b-2. delegate/ 插件（delegate 工具）─────────────────────────────────────
# 与前两段同形（普通插件包、file: 依赖、用户根下的稳定副本），但**它现在是唯一的委派入口**：
# preset 的 delegation 组里只有一行 `agent`，子代理干什么 / 能用哪些工具 / 带不带 persona
# 全由调度智能体在每次委派时通过 `delegate` 现定。漏装的后果不是"某个子代理少个工具"，
# 而是**整套委派机制不存在** —— 调度者手上没有任何能开子代理的工具。
# 它不进任何 allow（子代理的永禁名单里有 delegate / set_child_permission / ask_user_question /
# agent），所以"装着 preset bundle 的 profile 必须同时装着 adg-delegate"这条不变量只有本脚本在守。
$delegateSrc = Join-Path $here 'delegate'
$delegateDest = Join-Path $root 'plugins\adg-delegate'
$delegateNote = ''
$delegateSkipped = $false
# 4c-5 的断言要用它；在这里初始化，免得某个分支没赋值就被读。
$delegateInProfile = ''
if ($SkipPackages) {
  $delegateNote = '跳过（-SkipPackages）'
  $delegateSkipped = $true
} elseif (-not (Test-Path -LiteralPath (Join-Path $delegateSrc 'package.json'))) {
  $delegateNote = "未找到 $delegateSrc，跳过 delegate/ 插件部署"
  $delegateSkipped = $true
} else {
  # 本清单与 delegate/package.json 的 `files` 字段**故意不同**：多一个 `package.json`
  # （稳定副本要能当包被 `dsh plugin add "file:…"` 解析）。本插件没有 cli.mjs。
  New-Item -ItemType Directory -Force -Path (Join-Path $delegateDest 'lib') | Out-Null
  $delegateFiles = @('index.mjs', 'lib\delegate.mjs', 'cordis.patch.yml', 'package.json', 'AGENTS.md', 'design.md', 'testing-guide.md')
  $delegateCopied = 0
  $delegateMissing = @()
  foreach ($rel in $delegateFiles) {
    $from = Join-Path $delegateSrc $rel
    if (-not (Test-Path -LiteralPath $from)) { $delegateMissing += $rel; continue }
    $to = Join-Path $delegateDest $rel
    $same = (Test-Path -LiteralPath $to) -and ((Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash)
    if ($same) { continue }
    Copy-Item -Force -LiteralPath $from -Destination $to
    $delegateCopied += 1
  }
  if ($delegateMissing.Count -gt 0) {
    $delegateNote = "delegate/ 部署不完整：源里缺 $($delegateMissing -join ', ')"
    $delegateSkipped = $true
  } elseif ($delegateCopied -gt 0) {
    $delegateNote = "delegate/ 插件 -> $delegateDest（本次更新 $delegateCopied 个文件）"
  } else {
    $delegateNote = "delegate/ 插件 -> $delegateDest（已是最新，无需拷贝）"
  }
}

# ── 2b-3. settings/ 插件（设置页「Adg 设置」）─────────────────────────────────
# 与前三段同形（普通插件包、file: 依赖、用户根下的稳定副本）。这是**唯一带前端的那枚**：
# 宿主半边 index.js 注册同源路由 /api/adg-settings，客户端半边 client.js 往 settings.section
# 上挂一页（order 38），两半由同一份登记表 lib/schema.mjs 驱动 —— 加一项配置只需要动登记表
# 与客户端的文案，不动这一半的逻辑。
# 漏装的症状是"设置页里少一页"，而不是某次委派报 names unknown global tool；
# 它也**不影响 notify 的默认值**：adg-notify 只按文件契约读 adg-settings.json，文件不存在时
# 回落到出厂默认（见 notify/lib/user-settings.mjs 的文件头）。
$settingsSrc = Join-Path $here 'settings'
$settingsDest = Join-Path $root 'plugins\adg-settings'
$settingsNote = ''
$settingsSkipped = $false
# 4c-7 的断言要用它；在这里初始化，免得某个分支没赋值就被读。
$settingsInProfile = ''
if ($SkipPackages) {
  $settingsNote = '跳过（-SkipPackages）'
  $settingsSkipped = $true
} elseif (-not (Test-Path -LiteralPath (Join-Path $settingsSrc 'package.json'))) {
  $settingsNote = "未找到 $settingsSrc，跳过 settings/ 插件部署"
  $settingsSkipped = $true
} else {
  # 本清单与 settings/package.json 的 `files` 字段**故意不同**：多一个 `package.json`
  # （稳定副本要能当包被 `dsh plugin add "file:…"` 解析）。目录结构是 index.js + client.js +
  # lib/schema.mjs（有子目录，所以要先建出 lib\）。
  New-Item -ItemType Directory -Force -Path (Join-Path $settingsDest 'lib') | Out-Null
  $settingsFiles = @('index.js', 'client.js', 'lib\schema.mjs', 'cordis.patch.yml',
    'package.json', 'AGENTS.md', 'design.md', 'testing-guide.md')
  $settingsCopied = 0
  $settingsMissing = @()
  foreach ($rel in $settingsFiles) {
    $from = Join-Path $settingsSrc $rel
    if (-not (Test-Path -LiteralPath $from)) { $settingsMissing += $rel; continue }
    $to = Join-Path $settingsDest $rel
    $same = (Test-Path -LiteralPath $to) -and ((Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash)
    if ($same) { continue }
    Copy-Item -Force -LiteralPath $from -Destination $to
    $settingsCopied += 1
  }
  if ($settingsMissing.Count -gt 0) {
    $settingsNote = "settings/ 部署不完整：源里缺 $($settingsMissing -join ', ')"
    $settingsSkipped = $true
  } elseif ($settingsCopied -gt 0) {
    $settingsNote = "settings/ 插件 -> $settingsDest（本次更新 $settingsCopied 个文件）"
  } else {
    $settingsNote = "settings/ 插件 -> $settingsDest（已是最新，无需拷贝）"
  }
}

# ── 2b-4. skill-inject/ 插件（思考框架注入）──────────────────────────────────
# 与 2b / 2b-1 / 2b-2 / 2b-3 同形（普通插件包、file: 依赖、用户根下的稳定副本）。
# 它不注册任何工具：在 agent/created 时判定"这个 agent 的 preset 是不是 adg"（判定只看
# preset；子代理是否也注入由设置键 skillInjectSubagent 决定，默认关），是就在它自己的
# agent.ctx 上注册一段系统提示词 section，正文取自
# 用户技能根的 skills\thinking-framework\SKILL.md（本脚本第 1 节拷的那份 —— 所以此插件的
# 注入正文与技能文件永远来自同一次安装）。漏装的症状是调度者的系统提示词里没有思考框架段
# （退回"靠模型自觉 read"的旧状态），不报错。
$injectSrc = Join-Path $here 'skill-inject'
$injectDest = Join-Path $root 'plugins\adg-skill-inject'
$injectNote = ''
$injectSkipped = $false
# 4c-9 的断言要用它；在这里初始化，免得某个分支没赋值就被读。
$injectInProfile = ''
if ($SkipPackages) {
  $injectNote = '跳过（-SkipPackages）'
  $injectSkipped = $true
} elseif (-not (Test-Path -LiteralPath (Join-Path $injectSrc 'package.json'))) {
  $injectNote = "未找到 $injectSrc，跳过 skill-inject/ 插件部署"
  $injectSkipped = $true
} else {
  # 本清单与 skill-inject/package.json 的 `files` 字段**故意不同**：多一个 `package.json`
  # （稳定副本要能当包被 `dsh plugin add "file:…"` 解析）。有子目录 lib\，先建出来。
  New-Item -ItemType Directory -Force -Path (Join-Path $injectDest 'lib') | Out-Null
  $injectFiles = @('index.mjs', 'client.js', 'lib\section.mjs', 'lib\user-settings.mjs', 'cordis.patch.yml', 'package.json', 'AGENTS.md', 'design.md', 'testing-guide.md')
  $injectCopied = 0
  $injectMissing = @()
  foreach ($rel in $injectFiles) {
    $from = Join-Path $injectSrc $rel
    if (-not (Test-Path -LiteralPath $from)) { $injectMissing += $rel; continue }
    $to = Join-Path $injectDest $rel
    $same = (Test-Path -LiteralPath $to) -and ((Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash)
    if ($same) { continue }
    Copy-Item -Force -LiteralPath $from -Destination $to
    $injectCopied += 1
  }
  if ($injectMissing.Count -gt 0) {
    $injectNote = "skill-inject/ 部署不完整：源里缺 $($injectMissing -join ', ')"
    $injectSkipped = $true
  } elseif ($injectCopied -gt 0) {
    $injectNote = "skill-inject/ 插件 -> $injectDest（本次更新 $injectCopied 个文件）"
  } else {
    $injectNote = "skill-inject/ 插件 -> $injectDest（已是最新，无需拷贝）"
  }
}

# ── 2b-5. source-guard/ 插件（run_code 源码守卫）──────────────────────────────
# 与 2b / 2b-1 / 2b-2 / 2b-3 / 2b-4 同形（普通插件包、file: 依赖、用户根下的稳定副本）。
# 它不注册任何工具：在 tools/post-execute（prepend）上监听，对**顶层 run_code** 的结果做
# 成败分流 —— 成功时在最前面补一行当次执行意图（`意图：<description>`；那句「源码未随本结果重复」
# 的说明句默认关闭，源码不进结果本来就是平台默认行为），失败时原样返回。
# 漏装的症状是 run_code 的成功结果里没有多出那行「意图：」（不报错、不崩）。
# 注意：它**不改** tool/call 的 arguments 那份源码 —— 平台没有那个挂载点（design.md 第 1 节）。
$guardSrc = Join-Path $here 'source-guard'
$guardDest = Join-Path $root 'plugins\adg-source-guard'
$guardNote = ''
$guardSkipped = $false
# 4c-10 的断言要用它；在这里初始化，免得某个分支没赋值就被读。
$guardInProfile = ''
if ($SkipPackages) {
  $guardNote = '跳过（-SkipPackages）'
  $guardSkipped = $true
} elseif (-not (Test-Path -LiteralPath (Join-Path $guardSrc 'package.json'))) {
  $guardNote = "未找到 $guardSrc，跳过 source-guard/ 插件部署"
  $guardSkipped = $true
} else {
  # 本清单与 source-guard/package.json 的 `files` 字段**故意不同**：多一个 `package.json`
  # （稳定副本要能当包被 `dsh plugin add "file:…"` 解析）。有子目录 lib\，先建出来。
  New-Item -ItemType Directory -Force -Path (Join-Path $guardDest 'lib') | Out-Null
  $guardFiles = @('index.mjs', 'lib\policy.mjs', 'cordis.patch.yml', 'package.json', 'AGENTS.md', 'design.md', 'testing-guide.md')
  $guardCopied = 0
  $guardMissing = @()
  foreach ($rel in $guardFiles) {
    $from = Join-Path $guardSrc $rel
    if (-not (Test-Path -LiteralPath $from)) { $guardMissing += $rel; continue }
    $to = Join-Path $guardDest $rel
    $same = (Test-Path -LiteralPath $to) -and ((Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash)
    if ($same) { continue }
    Copy-Item -Force -LiteralPath $from -Destination $to
    $guardCopied += 1
  }
  if ($guardMissing.Count -gt 0) {
    $guardNote = "source-guard/ 部署不完整：源里缺 $($guardMissing -join ', ')"
    $guardSkipped = $true
  } elseif ($guardCopied -gt 0) {
    $guardNote = "source-guard/ 插件 -> $guardDest（本次更新 $guardCopied 个文件）"
  } else {
    $guardNote = "source-guard/ 插件 -> $guardDest（已是最新，无需拷贝）"
  }
}

# ── 2b-6. ptc-parallel/ 插件（PTC 并行执行提示）────────────────────────────
# 与 2b / 2b-1 / 2b-2 / 2b-3 / 2b-4 / 2b-5 同形（普通插件包、file: 依赖、用户根下的稳定副本）。
# 它不注册任何工具：在 agent/created 时判定"这个 scope 是不是 PTC 呈现"（判据是
# ctx.get('tools').get('run_code', agent) 不为 undefined），是就在那个 agent 自己的
# agent.ctx 上注册一段系统提示词 section（调度者与子代理都算）。
# 正文里**不写死任何工具名**：末尾那份"可并发 / 独占"清单是每次组装提示词时从
# tools.view(scope).visible 现算的（写死即过期，模型会拿过期清单下结论）。
# 漏装的症状是 PTC 会话的系统提示词里没有「## PTC 并行执行（一次 run_code 里多做）」段
# （退回"模型不知道 PTC 能并行"的旧状态），不报错。
$parallelSrc = Join-Path $here 'ptc-parallel'
$parallelDest = Join-Path $root 'plugins\adg-ptc-parallel'
$parallelNote = ''
$parallelSkipped = $false
# 4c-12 的断言要用它；在这里初始化，免得某个分支没赋值就被读。
$parallelInProfile = ''
if ($SkipPackages) {
  $parallelNote = '跳过（-SkipPackages）'
  $parallelSkipped = $true
} elseif (-not (Test-Path -LiteralPath (Join-Path $parallelSrc 'package.json'))) {
  $parallelNote = "未找到 $parallelSrc，跳过 ptc-parallel/ 插件部署"
  $parallelSkipped = $true
} else {
  # 本清单与 ptc-parallel/package.json 的 `files` 字段**故意不同**：多一个 `package.json`
  # （稳定副本要能当包被 `dsh plugin add "file:…"` 解析）。有子目录 lib\，先建出来。
  New-Item -ItemType Directory -Force -Path (Join-Path $parallelDest 'lib') | Out-Null
  $parallelFiles = @('index.mjs', 'lib\guide.mjs', 'cordis.patch.yml', 'package.json', 'AGENTS.md', 'design.md', 'testing-guide.md')
  $parallelCopied = 0
  $parallelMissing = @()
  foreach ($rel in $parallelFiles) {
    $from = Join-Path $parallelSrc $rel
    if (-not (Test-Path -LiteralPath $from)) { $parallelMissing += $rel; continue }
    $to = Join-Path $parallelDest $rel
    $same = (Test-Path -LiteralPath $to) -and ((Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash)
    if ($same) { continue }
    Copy-Item -Force -LiteralPath $from -Destination $to
    $parallelCopied += 1
  }
  if ($parallelMissing.Count -gt 0) {
    $parallelNote = "ptc-parallel/ 部署不完整：源里缺 $($parallelMissing -join ', ')"
    $parallelSkipped = $true
  } elseif ($parallelCopied -gt 0) {
    $parallelNote = "ptc-parallel/ 插件 -> $parallelDest（本次更新 $parallelCopied 个文件）"
  } else {
    $parallelNote = "ptc-parallel/ 插件 -> $parallelDest（已是最新，无需拷贝）"
  }
}

# ── 3. preset bundle：四种味道全部生成 → 各自落到自己的稳定位置（每 profile 只 link 一份）──
# preset 是一个 **bundle**：仓库里的 preset\ 是唯一文本真相源，本脚本每次安装都重跑生成器
# 把它编译成 bundle\adg-*\cordis.patch.yml，再拷进 $DSH_HOME\bundles\ 下的四个稳定目录。
# 源文件永远只有 preset\preset.yml + preset\agent.cordis.yml；bundle\adg-*\ 是构建产物
# （在 .gitignore 里），每次安装都重新生成，所以没有人需要手改 patch。
# 各注入组的工具名**只进生成物**、不进源文件（见 tools\gen-preset-bundle.mjs 与 tools\flavors.mjs 的注释），
# 所以同一份源文件要生成四份（两个注入组的四种组合）。
# **四份都无条件生成**：省掉"这一跑要不要重建那一份"的判断，稳定目录里的形状永远等于它该有的形状。
# 表里只写"味道键 + 输出目录 + 它含哪几组"；**稳定目录名与 gen 旗标都问 tools\resolve-flavor.mjs**
# （拼法只写在 tools\flavors.mjs，本脚本不重拼），并当场核对它给的味道键与表里一致。
# outDir 传绝对路径：gen 脚本用的是 process.cwd()，不能跟着"用户从哪个目录调用本脚本"漂。
$genFlavors = @(
  [ordered]@{ flavor = 'plain';           out = (Join-Path $here 'bundle\adg-plain');           groups = @();                                     note = '不带任何注入的上下文工具（源文件原样）' },
  [ordered]@{ flavor = 'bili';            out = (Join-Path $here 'bundle\adg-bili');            groups = @('--billion-context');                  note = '调度 persona 里带 bili 的四个上下文工具 + compaction-basic auto: false' },
  [ordered]@{ flavor = 'save-token';      out = (Join-Path $here 'bundle\adg-save-token');      groups = @('--save-token');                       note = '调度 persona 里带 save-token 的 save_token_expand' },
  [ordered]@{ flavor = 'bili+save-token'; out = (Join-Path $here 'bundle\adg-bili-save-token'); groups = @('--billion-context', '--save-token');  note = '上述两组的并集（bili 四个上下文工具 + save_token_expand + auto: false）' }
)
$genResolveLog = Join-Path $root 'adg-gen-flavor.log'
foreach ($gen in $genFlavors) {
  cmd /c "node `"$here\tools\resolve-flavor.mjs`" $($gen.groups -join ' ') > `"$genResolveLog`" 2>&1"
  if ($LASTEXITCODE -ne 0) { throw "tools\resolve-flavor.mjs $($gen.groups -join ' ') 失败（exit $LASTEXITCODE）" }
  $genLines = @(Get-Content -LiteralPath $genResolveLog -Encoding UTF8)
  Remove-Item -LiteralPath $genResolveLog -Force -ErrorAction SilentlyContinue
  if ($genLines.Count -eq 0) { throw "tools\resolve-flavor.mjs 没写出结果（$genResolveLog 是空的）" }
  $genParts = "$($genLines[0])".Split("`t")
  if ($genParts.Length -lt 3) { throw "tools\resolve-flavor.mjs 的输出不是三列 TSV：$($genLines[0])" }
  if ([string]$genParts[0] -ne [string]$gen.flavor) { throw "味道键对不上：本脚本表里是 $($gen.flavor)，tools\resolve-flavor.mjs 给的是 $($genParts[0])" }
  $gen.dest = Join-Path $root "bundles\$($genParts[1])"
  $gen.flags = @(([string]$genParts[2] -split ' ') | Where-Object { $_ -ne '' })
}
foreach ($gen in $genFlavors) {
  & node (Join-Path $here 'tools\gen-preset-bundle.mjs') $gen.out @($gen.flags)
  if ($LASTEXITCODE -ne 0) { throw "tools\gen-preset-bundle.mjs $($gen.flags -join ' ') 失败（exit $LASTEXITCODE）" }
}

# $DSH_HOME\bundles\ 是稳定位置：profile 只引用这里，仓库可以随便挪/删。
# 四种味道的 package.json 必须**逐字节相同、包名都叫 $bundleName**（profile 的 dsh.profile.bundles 那一行
# 四种味道通用，差别只在 link 指向哪个目录），所以拷完当场用哈希验一遍。
$bundlePkgHashes = [ordered]@{}
foreach ($gen in $genFlavors) {
  $dest = $gen.dest
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item -LiteralPath (Join-Path $gen.out 'cordis.patch.yml') -Destination $dest -Force
  Copy-Item -LiteralPath (Join-Path $gen.out 'package.json') -Destination $dest -Force
  $bundlePkgHashes[[string]$gen.flavor] = (Get-FileHash -LiteralPath (Join-Path $dest 'package.json') -Algorithm SHA256).Hash
}
if (@($bundlePkgHashes.Values | Select-Object -Unique).Count -ne 1) {
  throw "四种味道的 package.json 不是逐字节相同（$(($bundlePkgHashes.Keys | ForEach-Object { "$_=$($bundlePkgHashes[$_])" }) -join ' / ')）—— 包名与清单必须一致，profile 的 dsh.profile.bundles 才能四种味道通用"
}
$plainPkgName = "$((Get-Content -LiteralPath (Join-Path $genFlavors[0].dest 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).name)"
if ($plainPkgName -ne $bundleName) {
  throw "稳定目录里的包名是 $plainPkgName，期望 $bundleName（profile 的 dsh.profile.bundles 那一行按这个包名写）"
}

# ── 4. 装进目标 profile（依赖 link + 写进该 profile 的 dsh.profile.bundles）────────
$pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue)
$installNotes = @()
$packageFailed = $false
foreach ($name in $Profiles) {
  $profileDir = Join-Path $profilesDir $name
  $manifest = Join-Path $profileDir 'package.json'
  if (-not (Test-Path -LiteralPath $manifest)) { throw "profile 不存在：$profileDir" }

  # 4a. 依赖（等价于 `dsh plugin --profile <name> add link:<dir>`，那是一条 pnpm 直通命令）。
  # 用 link: 而不是把文件真拷进 node_modules：目标目录在 $DSH_HOME 下的稳定位置，
  # 重新生成 preset 之后不用重装就生效。
  # 这个 profile 该拿哪一种味道的稳定目录（见上面第 0 节的 $flavorOf / $bundleDirOf）。换味道也只在这一步发生：
  # 同一个包名 `link:` 到另一个目录，profile 的 `dsh.profile.bundles` 一行都不用改（四种味道包名相同）。
  $flavor = [string]$flavorOf[[string]$name]
  $wantBundle = Join-Path $root "bundles\$($bundleDirOf[[string]$name])"
  $pnpmFailed = $false
  if ($SkipPackages) {
    $installNotes += "$name : 跳过依赖安装（-SkipPackages）—— 这个 profile 期望的味道是 $flavor（$wantBundle）"
  } elseif (-not $pnpm) {
    $pnpmFailed = $true
    $installNotes += "$name : 未找到 pnpm，跳过依赖安装 —— 请在该 profile 里执行 pnpm add link:`"$wantBundle`""
  } else {
    Push-Location $profileDir
    try {
      # 走 cmd /c 而不是直接 `& pnpm`：Windows PowerShell 5.1 里原生命令写 stderr 会生成
      # ErrorRecord，在 $ErrorActionPreference='Stop' 下直接变成终止错误（实测：脚本在 web
      # 这一步整个退出、exit 1，后面的 profile 根本没跑到）。cmd 自己把两个流重定向进日志，
      # PowerShell 就看不到 stderr 了。
      # pnpm 失败本身有个很常见的原因：**dsh 正在运行时**它发现 node_modules 不是自己管的
      # （.modules.yaml 缺失）就想整目录重建，而文件被运行中的 dsh 占着
      # （实测：ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR / os error 32）。那要先关掉 dsh。
      $pnpmLog = Join-Path $profileDir 'pnpm-adg-install.log'
      cmd /c "pnpm add `"link:$wantBundle`" > `"$pnpmLog`" 2>&1"
      if ($LASTEXITCODE -ne 0) {
        $pnpmFailed = $true
        $installNotes += "$name : pnpm add 失败（exit $LASTEXITCODE）—— 常见原因是 dsh 正在运行、node_modules 被占用；关掉 dsh 后重跑本脚本（日志 $pnpmLog）"
        Write-Host (Get-Content -LiteralPath $pnpmLog -Raw -Encoding UTF8)
      } else {
        Remove-Item -LiteralPath $pnpmLog -Force -ErrorAction SilentlyContinue
        $installNotes += "$name : 已 link $bundleName（$flavor 味道）"
      }
    } finally { Pop-Location }
  }

  # 4b. bundle 必须被选进 dsh.profile.bundles，否则它的 patch 层根本不会被读。
  # 但"选进列表"和"包装上了"必须同时成立：只写列表而包装不上，会让这个 profile 启动时报
  # 未安装的 bundle。所以先确认包真的解析得到，包不在就只报告、不写列表。
  if (-not (Test-Path -LiteralPath (Join-Path $profileDir "node_modules\$bundleName\package.json"))) {
    $packageFailed = $true
    $installNotes += "$name : $bundleName 还没装进这个 profile 的 node_modules —— 未写入 dsh.profile.bundles（先解决上一条的 pnpm 失败）"
    continue
  }
  # pnpm 那一步失败、但包其实早就在位（例如上一次安装留下的）时不算失败，只说明本次没重装依赖。
  if ($pnpmFailed) {
    $installNotes += "$name : pnpm 那一步没成功，但 $bundleName 已在 node_modules 里 —— 本次安装不受影响"
  }
  # 4b-1. 断言**已经链接进去的那一份**的味道，正是这个 profile 该拿的味道。
  # 判据不能是"包在不在"：四种味道的 package.json 逐字节相同、包名也一样，只有产物本体不同 ——
  # 所以让 tools\check-bundle-flavor.mjs 逐行验调度 persona 里那段注入说明与 compaction-basic 的 auto
  # （四种味道各按自己的注入组断言：该有的全有、不该有的一个都不能出现）。
  # 这一格是本缺陷的"静默失效"出口：味道换错时一切看起来都正常，只有调度 persona 少了那段说明（子代理的工具面少那四个名字）
  # （本机复现过：web 链接的是 plain，子代理报 unknown tool compress）。
  $linkedPatch = Join-Path $profileDir "node_modules\$bundleName\cordis.patch.yml"
  $flavorLog = Join-Path $profileDir 'adg-flavor-check.log'
  $flavorReport = @()
  $flavorOk = $false
  if (Test-Path -LiteralPath $linkedPatch) {
    # 同第 0 节：不收原生命令的 stdout，走 cmd 重定向写文件再读 —— 否则拿不到报告、$LASTEXITCODE 还是
    # 上一条命令留下的 0，这一格会**假装通过**（比不做断言更糟：它把"味道错了"报成"味道对"）。
    cmd /c "node `"$here\tools\check-bundle-flavor.mjs`" `"$linkedPatch`" $flavor > `"$flavorLog`" 2>&1"
    $flavorOk = ($LASTEXITCODE -eq 0)
    if (Test-Path -LiteralPath $flavorLog) {
      $flavorReport = @(Get-Content -LiteralPath $flavorLog -Encoding UTF8)
      Remove-Item -LiteralPath $flavorLog -Force
    } else {
      $flavorOk = $false
      $flavorReport = @("tools\check-bundle-flavor.mjs 没写出报告（$flavorLog 不在）")
    }
  } else {
    $flavorReport = @("$linkedPatch 不存在")
  }
  if ($flavorOk) {
    $installNotes += "$name : 落点味道 = $flavor（tools\check-bundle-flavor.mjs 通过）"
  } else {
    $installNotes += "$name : 落点味道 ≠ $flavor —— 链接到的还是另一种味道（换味道那一步没成功；调度 persona 会少/多一段「委派时要带上哪些上下文工具」的说明）"
    foreach ($flavorLine in $flavorReport) { Write-Host "      $flavorLine" }
    $packageFailed = $true
  }

  # 4c. adg-notify 插件（notify_user）也装进这个 profile，并写进同一个 dsh.profile.bundles。
  # **这是硬依赖，不是可选项**：notify_user 是全局层的工具名，调度智能体随时可能在 `delegate` 的
  # `tools` 里把它给某个子代理（"撞上登录墙就推一条通知给用户"）—— 哪个 profile 装了 bundle
  # 却没装本插件，那次委派就抛 `names unknown global tool notify_user`（dsh-tools 的 restrict）。
  # 所以"装着 bundle 的 profile 必须同时装着 adg-notify"这条不变量只有本脚本在守。
  # 用 `dsh plugin --profile <n> add file:<dir>` 而不是手抄 manifest：这条命令自己会
  #   (1) 跑 pnpm add（包以真目录落进该 profile 的 node_modules）
  #   (2) reconcile 一遍，把声明了 dsh.bundle 的依赖追加进 dsh.profile.bundles
  # （2 是它内部做的，所以下面还要**读回来断言**，不拿它的返回码当证据。）
  # 它的输出等价于一条 pnpm 直通命令（实测 `dsh plugin --help` 打印的是 pnpm 的 help）。
  if ($notifySkipped) {
    $installNotes += "$name : adg-notify 未部署（$notifyNote）—— 委派里写 notify_user 会拿到「未生效」"
  } else {
    $notifyInProfile = Join-Path $profileDir "node_modules\adg-notify\package.json"
    $notifyNeedInstall = -not (Test-Path -LiteralPath $notifyInProfile)
    if (-not $notifyNeedInstall) {
      $installNotes += "$name : adg-notify 已经在 node_modules 里"
    } elseif (-not $dshCmd) {
      $installNotes += "$name : 未找到 dsh 命令，跳过 adg-notify 安装 —— 请在该 profile 里执行 dsh plugin --profile $name add `"file:$notifyDest`""
    } else {
      Push-Location $profileDir
      try {
        # 同 4a：走 cmd /c 收流，否则 PS 5.1 下 pnpm 的 stderr 会变成终止错误。
        $notifyLog = Join-Path $profileDir 'pnpm-adg-notify.log'
        cmd /c "dsh plugin --profile $name add `"file:$notifyDest`" > `"$notifyLog`" 2>&1"
        $notifyExit = $LASTEXITCODE
      } finally { Pop-Location }
      if (Test-Path -LiteralPath $notifyInProfile) {
        Remove-Item -LiteralPath $notifyLog -Force -ErrorAction SilentlyContinue
        $installNotes += "$name : 已装 adg-notify（dsh plugin add exit $notifyExit）"
      } else {
        # 宿主正在运行时 pnpm 换目录会被 Windows 拒绝（os error 32 / EPERM）。这不是本插件的缺陷，
        # 按 preset\AGENTS.md「已知限制」的口径：如实报告 + 继续，**不要**为此杀掉 dsh 进程。
        $installNotes += "$name : adg-notify 没装进 $profileDir（dsh plugin add exit $notifyExit）—— 关掉 dsh 后重跑本脚本（日志 $notifyLog）"
        if (Test-Path -LiteralPath $notifyLog) { Write-Host (Get-Content -LiteralPath $notifyLog -Raw -Encoding UTF8) }
      }
    }
  }

  # 4c-2. adg-permission 插件（set_child_permission）也装进这个 profile。
  # 与 4c 同形（file: 依赖 + reconcile），但它**不是** allow 的硬依赖：这个工具不进任何 allow
  # （子代理本来就不该有子代理），只有调度智能体用。所以漏装的后果不是派发时抛
  # `names unknown global tool`，而是 persona 让调度者去调一个不存在的工具 —— 同样要如实报告。
  if ($permSkipped) {
    $installNotes += "$name : adg-permission 未部署（$permNote）—— 调度者改子代理权限时会调到一个不存在的工具"
  } else {
    $permInProfile = Join-Path $profileDir "node_modules\adg-permission\package.json"
    $permNeedInstall = -not (Test-Path -LiteralPath $permInProfile)
    if (-not $permNeedInstall) {
      $installNotes += "$name : adg-permission 已经在 node_modules 里"
    } elseif (-not $dshCmd) {
      $installNotes += "$name : 未找到 dsh 命令，跳过 adg-permission 安装 —— 请在该 profile 里执行 dsh plugin --profile $name add `"file:$permDest`""
    } else {
      Push-Location $profileDir
      try {
        # 同 4a / 4c：走 cmd /c 收流，否则 PS 5.1 下 pnpm 的 stderr 会变成终止错误。
        $permLog = Join-Path $profileDir 'pnpm-adg-permission.log'
        cmd /c "dsh plugin --profile $name add `"file:$permDest`" > `"$permLog`" 2>&1"
        $permExit = $LASTEXITCODE
      } finally { Pop-Location }
      if (Test-Path -LiteralPath $permInProfile) {
        Remove-Item -LiteralPath $permLog -Force -ErrorAction SilentlyContinue
        $installNotes += "$name : 已装 adg-permission（dsh plugin add exit $permExit）"
      } else {
        $installNotes += "$name : adg-permission 没装进 $profileDir（dsh plugin add exit $permExit）—— 关掉 dsh 后重跑本脚本（日志 $permLog）"
        if (Test-Path -LiteralPath $permLog) { Write-Host (Get-Content -LiteralPath $permLog -Raw -Encoding UTF8) }
      }
    }
  }

  # 4c-4. adg-delegate 插件（delegate）—— 本 profile 的**唯一委派入口**。
  # 与 4c / 4c-2 同形（file: 依赖 + reconcile）。漏装的后果最重：preset 的 delegation 组里
  # 只有一行 `agent`，而开子代理的工具（delegate）根本不在 preset 里 —— 它在全局层。所以
  # "装了 bundle 却没装 adg-delegate"的 profile 里，调度者手上没有任何能委派的工具，整套
  # Adg PTC 模式退回成单智能体（不报错，只是静默失去能力）—— 必须在这里如实报告。
  if ($delegateSkipped) {
    $installNotes += "$name : adg-delegate 未部署（$delegateNote）—— 调度者手上没有任何委派工具（delegate 不在 preset 里，它在全局层）"
  } else {
    $delegateInProfile = Join-Path $profileDir "node_modules\adg-delegate\package.json"
    $delegateNeedInstall = -not (Test-Path -LiteralPath $delegateInProfile)
    if (-not $delegateNeedInstall) {
      $installNotes += "$name : adg-delegate 已经在 node_modules 里"
    } elseif (-not $dshCmd) {
      $installNotes += "$name : 未找到 dsh 命令，跳过 adg-delegate 安装 —— 请在该 profile 里执行 dsh plugin --profile $name add `"file:$delegateDest`""
    } else {
      Push-Location $profileDir
      try {
        # 同 4a / 4c：走 cmd /c 收流，否则 PS 5.1 下 pnpm 的 stderr 会变成终止错误。
        $delegateLog = Join-Path $profileDir 'pnpm-adg-delegate.log'
        cmd /c "dsh plugin --profile $name add `"file:$delegateDest`" > `"$delegateLog`" 2>&1"
        $delegateExit = $LASTEXITCODE
      } finally { Pop-Location }
      if (Test-Path -LiteralPath $delegateInProfile) {
        Remove-Item -LiteralPath $delegateLog -Force -ErrorAction SilentlyContinue
        $installNotes += "$name : 已装 adg-delegate（dsh plugin add exit $delegateExit）"
      } else {
        $installNotes += "$name : adg-delegate 没装进 $profileDir（dsh plugin add exit $delegateExit）—— 关掉 dsh 后重跑本脚本（日志 $delegateLog）"
        if (Test-Path -LiteralPath $delegateLog) { Write-Host (Get-Content -LiteralPath $delegateLog -Raw -Encoding UTF8) }
      }
    }
  }

  $json = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
  $bundles = @($json.dsh.profile.bundles)
  if ($bundles -contains $bundleName) {
    $installNotes += "$name : $bundleName 已在 dsh.profile.bundles 里"
  } else {
    Copy-Item -LiteralPath $manifest -Destination "$manifest.bak-adg-bundle" -Force
    $json.dsh.profile.bundles = @($bundles + $bundleName)
    [System.IO.File]::WriteAllText($manifest, ($json | ConvertTo-Json -Depth 10), $utf8NoBom)
    $installNotes += "$name : 已把 $bundleName 加进 dsh.profile.bundles（原文件备份 $manifest.bak-adg-bundle）"
  }

  # 4c-1. 写完之后**读回来断言** adg-notify 的三件事，缺一就不算装好：
  #   ① 包真在 node_modules 里（解析得到）；② dependencies 里有它；③ dsh.profile.bundles 里有它。
  # 只满足其中一部分是最坏的情况：bundle 装了、插件没装时，那次给子代理 `notify_user` 的委派
  # 会在派发时报 `names unknown global tool notify_user`；反过来只写列表而包装不上，这个 profile 启动就先报错。
  # 断言读的是刚落盘的文件，不信任任何上一步的返回值。
  if (-not $notifySkipped) {
    $reread = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $depLine = @($reread.dependencies.PSObject.Properties | Where-Object { $_.Name -eq 'adg-notify' }).Count -gt 0
    $listedLine = @($reread.dsh.profile.bundles) -contains 'adg-notify'
    $pkgName = ''
    if (Test-Path -LiteralPath $notifyInProfile) {
      $pkgName = (Get-Content -LiteralPath $notifyInProfile -Raw -Encoding UTF8 | ConvertFrom-Json).name
    }
    if ($pkgName -ne 'adg-notify') { $notifyNeedInstall = $true }
    if ($depLine -and $listedLine -and ($pkgName -eq 'adg-notify')) {
      $installNotes += "$name : adg-notify 三格齐（node_modules 真目录 + dependencies + dsh.profile.bundles）"
    } elseif ($pkgName -eq 'adg-notify') {
      $installNotes += "$name : adg-notify 包在位，但 manifest 缺一格（dependencies=$depLine / dsh.profile.bundles=$listedLine）—— 手工补上再重启"
    }
  }

  # 4c-3. 同样读回来断言 adg-permission 的三格（判据与 4c-1 一样：node_modules 真目录 + dependencies + dsh.profile.bundles）。
  # 它**不是** allow 的硬依赖，所以"缺一格"的症状不是派发时报错，而是调度者真要用 `set_child_permission` 时
  # 调到一个不存在的工具 —— 一样必须在安装这一步就暴露出来，不能留到用户切完权限才发现。
  if (-not $permSkipped) {
    $permReread = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $permDepLine = @($permReread.dependencies.PSObject.Properties | Where-Object { $_.Name -eq 'adg-permission' }).Count -gt 0
    $permListedLine = @($permReread.dsh.profile.bundles) -contains 'adg-permission'
    $permPkgName = ''
    if (Test-Path -LiteralPath $permInProfile) {
      $permPkgName = (Get-Content -LiteralPath $permInProfile -Raw -Encoding UTF8 | ConvertFrom-Json).name
    }
    if ($permPkgName -ne 'adg-permission') { $permNeedInstall = $true }
    if ($permDepLine -and $permListedLine -and ($permPkgName -eq 'adg-permission')) {
      $installNotes += "$name : adg-permission 三格齐（node_modules 真目录 + dependencies + dsh.profile.bundles）"
    } elseif ($permPkgName -eq 'adg-permission') {
      $installNotes += "$name : adg-permission 包在位，但 manifest 缺一格（dependencies=$permDepLine / dsh.profile.bundles=$permListedLine）—— 手工补上再重启"
    }
  }

  # 4c-5. 同样读回来断言 adg-delegate 的三格（判据与 4c-1 / 4c-3 一样）。
  # 它是**整套委派机制**的载体，症状最隐蔽：装漏了不报错，只是调度者开不了子代理。
  if (-not $delegateSkipped) {
    $delegateReread = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $delegateDepLine = @($delegateReread.dependencies.PSObject.Properties | Where-Object { $_.Name -eq 'adg-delegate' }).Count -gt 0
    $delegateListedLine = @($delegateReread.dsh.profile.bundles) -contains 'adg-delegate'
    $delegatePkgName = ''
    if (Test-Path -LiteralPath $delegateInProfile) {
      $delegatePkgName = (Get-Content -LiteralPath $delegateInProfile -Raw -Encoding UTF8 | ConvertFrom-Json).name
    }
    if ($delegatePkgName -ne 'adg-delegate') { $delegateNeedInstall = $true }
    if ($delegateDepLine -and $delegateListedLine -and ($delegatePkgName -eq 'adg-delegate')) {
      $installNotes += "$name : adg-delegate 三格齐（node_modules 真目录 + dependencies + dsh.profile.bundles）"
    } elseif ($delegatePkgName -eq 'adg-delegate') {
      $installNotes += "$name : adg-delegate 包在位，但 manifest 缺一格（dependencies=$delegateDepLine / dsh.profile.bundles=$delegateListedLine）—— 手工补上再重启"
    }
  }

  # 4c-6. adg-settings 插件（设置页框架）也装进这个 profile。
  # 与 4c / 4c-2 / 4c-4 同形（file: 依赖 + reconcile）。漏装的后果最轻 —— 只是设置里少一页
  # 「Adg 设置」：通知三项读不到设置文件就回落内置默认，委派、权限都不受影响。但仍要如实报告，
  # 因为少了它，那三项就没法在界面上改。
  if ($settingsSkipped) {
    $installNotes += "$name : adg-settings 未部署（$settingsNote）—— 设置里不会出现「Adg 设置」那一页"
  } else {
    $settingsInProfile = Join-Path $profileDir "node_modules\adg-settings\package.json"
    $settingsNeedInstall = -not (Test-Path -LiteralPath $settingsInProfile)
    if (-not $settingsNeedInstall) {
      $installNotes += "$name : adg-settings 已经在 node_modules 里"
    } elseif (-not $dshCmd) {
      $installNotes += "$name : 未找到 dsh 命令，跳过 adg-settings 安装 —— 请在该 profile 里执行 dsh plugin --profile $name add `"file:$settingsDest`""
    } else {
      Push-Location $profileDir
      try {
        # 同 4a / 4c / 4c-2 / 4c-4：走 cmd /c 收流，否则 PS 5.1 下 pnpm 的 stderr 会变成终止错误。
        $settingsLog = Join-Path $profileDir 'pnpm-adg-settings.log'
        cmd /c "dsh plugin --profile $name add `"file:$settingsDest`" > `"$settingsLog`" 2>&1"
        $settingsExit = $LASTEXITCODE
      } finally { Pop-Location }
      if (Test-Path -LiteralPath $settingsInProfile) {
        Remove-Item -LiteralPath $settingsLog -Force -ErrorAction SilentlyContinue
        $installNotes += "$name : 已装 adg-settings（dsh plugin add exit $settingsExit）"
      } else {
        $installNotes += "$name : adg-settings 没装进 $profileDir（dsh plugin add exit $settingsExit）—— 关掉 dsh 后重跑本脚本（日志 $settingsLog）"
        if (Test-Path -LiteralPath $settingsLog) { Write-Host (Get-Content -LiteralPath $settingsLog -Raw -Encoding UTF8) }
      }
    }
  }

  # 4c-7. 读回来断言 adg-settings 的三格（判据与 4c-1 / 4c-3 / 4c-5 一样）。
  # 症状最轻（少一页设置、不报错），但"包在位而 manifest 缺一格"仍会让人以为装好了却在设置里找不到它。
  if (-not $settingsSkipped) {
    $settingsReread = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $settingsDepLine = @($settingsReread.dependencies.PSObject.Properties | Where-Object { $_.Name -eq 'adg-settings' }).Count -gt 0
    $settingsListedLine = @($settingsReread.dsh.profile.bundles) -contains 'adg-settings'
    $settingsPkgName = ''
    if (Test-Path -LiteralPath $settingsInProfile) {
      $settingsPkgName = (Get-Content -LiteralPath $settingsInProfile -Raw -Encoding UTF8 | ConvertFrom-Json).name
    }
    if ($settingsPkgName -ne 'adg-settings') { $settingsNeedInstall = $true }
    if ($settingsDepLine -and $settingsListedLine -and ($settingsPkgName -eq 'adg-settings')) {
      $installNotes += "$name : adg-settings 三格齐（node_modules 真目录 + dependencies + dsh.profile.bundles）"
    } elseif ($settingsPkgName -eq 'adg-settings') {
      $installNotes += "$name : adg-settings 包在位，但 manifest 缺一格（dependencies=$settingsDepLine / dsh.profile.bundles=$settingsListedLine）—— 手工补上再重启"
    }
  }

  # 4c-8. adg-skill-inject 插件（思考框架注入）也装进这个 profile。
  # 与 4c-6 同形（file: 依赖 + reconcile）。漏装的后果：调度者系统提示词里没有思考框架段
  # （不报错、不崩 —— 静默退回"靠模型自觉 read"的旧状态），所以同样要如实报告。
  if ($injectSkipped) {
    $installNotes += "$name : adg-skill-inject 未部署（$injectNote）—— 调度者系统提示词里不会有思考框架段"
  } else {
    $injectInProfile = Join-Path $profileDir "node_modules\adg-skill-inject\package.json"
    $injectNeedInstall = -not (Test-Path -LiteralPath $injectInProfile)
    if (-not $injectNeedInstall) {
      $installNotes += "$name : adg-skill-inject 已经在 node_modules 里"
    } elseif (-not $dshCmd) {
      $installNotes += "$name : 未找到 dsh 命令，跳过 adg-skill-inject 安装 —— 请在该 profile 里执行 dsh plugin --profile $name add `"file:$injectDest`""
    } else {
      Push-Location $profileDir
      try {
        # 同 4a / 4c / 4c-2 / 4c-4 / 4c-6：走 cmd /c 收流，否则 PS 5.1 下 pnpm 的 stderr 会变成终止错误。
        $injectLog = Join-Path $profileDir 'pnpm-adg-skill-inject.log'
        cmd /c "dsh plugin --profile $name add `"file:$injectDest`" > `"$injectLog`" 2>&1"
        $injectExit = $LASTEXITCODE
      } finally { Pop-Location }
      if (Test-Path -LiteralPath $injectInProfile) {
        Remove-Item -LiteralPath $injectLog -Force -ErrorAction SilentlyContinue
        $installNotes += "$name : 已装 adg-skill-inject（dsh plugin add exit $injectExit）"
      } else {
        $installNotes += "$name : adg-skill-inject 没装进 $profileDir（dsh plugin add exit $injectExit）—— 关掉 dsh 后重跑本脚本（日志 $injectLog）"
        if (Test-Path -LiteralPath $injectLog) { Write-Host (Get-Content -LiteralPath $injectLog -Raw -Encoding UTF8) }
      }
    }
  }

  # 4c-9. 读回来断言 adg-skill-inject 的三格（判据与 4c-1 / 4c-3 / 4c-5 / 4c-7 一样）。
  if (-not $injectSkipped) {
    $injectReread = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $injectDepLine = @($injectReread.dependencies.PSObject.Properties | Where-Object { $_.Name -eq 'adg-skill-inject' }).Count -gt 0
    $injectListedLine = @($injectReread.dsh.profile.bundles) -contains 'adg-skill-inject'
    $injectPkgName = ''
    if (Test-Path -LiteralPath $injectInProfile) {
      $injectPkgName = (Get-Content -LiteralPath $injectInProfile -Raw -Encoding UTF8 | ConvertFrom-Json).name
    }
  }

  # 4c-10. adg-source-guard 插件（run_code 源码守卫）也装进这个 profile。
  # 与 4c-8 同形（file: 依赖 + reconcile）。漏装的后果：run_code 的成功结果里不会多出那行
  # 「意图：<当次 description>」（不报错、不崩 —— 静默回到平台默认），所以同样要如实报告。
  if ($guardSkipped) {
    $installNotes += "$name : adg-source-guard 未部署（$guardNote）—— run_code 的成功结果里不会多出「意图：」那行"
  } else {
    $guardInProfile = Join-Path $profileDir "node_modules\adg-source-guard\package.json"
    $guardNeedInstall = -not (Test-Path -LiteralPath $guardInProfile)
    if (-not $guardNeedInstall) {
      $installNotes += "$name : adg-source-guard 已经在 node_modules 里"
    } elseif (-not $dshCmd) {
      $installNotes += "$name : 未找到 dsh 命令，跳过 adg-source-guard 安装 —— 请在该 profile 里执行 dsh plugin --profile $name add `"file:$guardDest`""
    } else {
      Push-Location $profileDir
      try {
        # 同 4a / 4c / 4c-2 / 4c-4 / 4c-6 / 4c-8：走 cmd /c 收流，否则 PS 5.1 下 pnpm 的 stderr 会变成终止错误。
        $guardLog = Join-Path $profileDir 'pnpm-adg-source-guard.log'
        cmd /c "dsh plugin --profile $name add `"file:$guardDest`" > `"$guardLog`" 2>&1"
        $guardExit = $LASTEXITCODE
      } finally { Pop-Location }
      if (Test-Path -LiteralPath $guardInProfile) {
        Remove-Item -LiteralPath $guardLog -Force -ErrorAction SilentlyContinue
        $installNotes += "$name : 已装 adg-source-guard（dsh plugin add exit $guardExit）"
      } else {
        $installNotes += "$name : adg-source-guard 没装进 $profileDir（dsh plugin add exit $guardExit）—— 关掉 dsh 后重跑本脚本（日志 $guardLog）"
        if (Test-Path -LiteralPath $guardLog) { Write-Host (Get-Content -LiteralPath $guardLog -Raw -Encoding UTF8) }
      }
    }
  }

  # 4c-11. 读回来断言 adg-source-guard 的三格（判据与 4c-1 / 4c-3 / 4c-5 / 4c-7 / 4c-9 一样）。
  if (-not $guardSkipped) {
    $guardReread = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $guardDepLine = @($guardReread.dependencies.PSObject.Properties | Where-Object { $_.Name -eq 'adg-source-guard' }).Count -gt 0
    $guardListedLine = @($guardReread.dsh.profile.bundles) -contains 'adg-source-guard'
    $guardPkgName = ''
    if (Test-Path -LiteralPath $guardInProfile) {
      $guardPkgName = (Get-Content -LiteralPath $guardInProfile -Raw -Encoding UTF8 | ConvertFrom-Json).name
    }
    if ($guardPkgName -ne 'adg-source-guard') { $guardNeedInstall = $true }
    if ($guardDepLine -and $guardListedLine -and ($guardPkgName -eq 'adg-source-guard')) {
      $installNotes += "$name : adg-source-guard 三格齐（node_modules 真目录 + dependencies + dsh.profile.bundles）"
    } elseif ($guardPkgName -eq 'adg-source-guard') {
      $installNotes += "$name : adg-source-guard 包在位，但 manifest 缺一格（dependencies=$guardDepLine / dsh.profile.bundles=$guardListedLine）—— 手工补上再重启"
    }
  }

  # 4c-12. adg-ptc-parallel 插件（PTC 并行执行提示）也装进这个 profile。
  # 与 4c-8 / 4c-10 同形（file: 依赖 + reconcile）。漏装的后果：PTC 会话的系统提示词里
  # 没有「## PTC 并行执行（一次 run_code 里多做）」段（模型回到"不知道 PTC 能并行"的旧状态），
  # 不报错、不崩 —— 所以同样要如实报告。装了之后还要**重启 dsh**（插件在 agent/created 时才注册）。
  if ($parallelSkipped) {
    $installNotes += "$name : adg-ptc-parallel 未部署（$parallelNote）—— PTC 会话的系统提示词里不会有那段并行指引"
  } else {
    $parallelInProfile = Join-Path $profileDir "node_modules\adg-ptc-parallel\package.json"
    $parallelNeedInstall = -not (Test-Path -LiteralPath $parallelInProfile)
    if (-not $parallelNeedInstall) {
      $installNotes += "$name : adg-ptc-parallel 已经在 node_modules 里"
    } elseif (-not $dshCmd) {
      $installNotes += "$name : 未找到 dsh 命令，跳过 adg-ptc-parallel 安装 —— 请在该 profile 里执行 dsh plugin --profile $name add `"file:$parallelDest`""
    } else {
      Push-Location $profileDir
      try {
        # 同 4a / 4c / 4c-2 / 4c-4 / 4c-6 / 4c-8 / 4c-10：走 cmd /c 收流，否则 PS 5.1 下 pnpm 的 stderr 会变成终止错误。
        $parallelLog = Join-Path $profileDir 'pnpm-adg-ptc-parallel.log'
        cmd /c "dsh plugin --profile $name add `"file:$parallelDest`" > `"$parallelLog`" 2>&1"
        $parallelExit = $LASTEXITCODE
      } finally { Pop-Location }
      if (Test-Path -LiteralPath $parallelInProfile) {
        Remove-Item -LiteralPath $parallelLog -Force -ErrorAction SilentlyContinue
        $installNotes += "$name : 已装 adg-ptc-parallel（dsh plugin add exit $parallelExit）"
      } else {
        $installNotes += "$name : adg-ptc-parallel 没装进 $profileDir（dsh plugin add exit $parallelExit）—— 关掉 dsh 后重跑本脚本（日志 $parallelLog）"
        if (Test-Path -LiteralPath $parallelLog) { Write-Host (Get-Content -LiteralPath $parallelLog -Raw -Encoding UTF8) }
      }
    }
  }

  # 4c-13. 读回来断言 adg-ptc-parallel 的三格（判据与 4c-1 / 4c-3 / 4c-5 / 4c-7 / 4c-9 / 4c-11 一样）。
  if (-not $parallelSkipped) {
    $parallelReread = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $parallelDepLine = @($parallelReread.dependencies.PSObject.Properties | Where-Object { $_.Name -eq 'adg-ptc-parallel' }).Count -gt 0
    $parallelListedLine = @($parallelReread.dsh.profile.bundles) -contains 'adg-ptc-parallel'
    $parallelPkgName = ''
    if (Test-Path -LiteralPath $parallelInProfile) {
      $parallelPkgName = (Get-Content -LiteralPath $parallelInProfile -Raw -Encoding UTF8 | ConvertFrom-Json).name
    }
    if ($parallelPkgName -ne 'adg-ptc-parallel') { $parallelNeedInstall = $true }
    if ($parallelDepLine -and $parallelListedLine -and ($parallelPkgName -eq 'adg-ptc-parallel')) {
      $installNotes += "$name : adg-ptc-parallel 三格齐（node_modules 真目录 + dependencies + dsh.profile.bundles）"
    } elseif ($parallelPkgName -eq 'adg-ptc-parallel') {
      $installNotes += "$name : adg-ptc-parallel 包在位，但 manifest 缺一格（dependencies=$parallelDepLine / dsh.profile.bundles=$parallelListedLine）—— 手工补上再重启"
    }
  }
}

# 第 6 步：把脚本拷到用户根下的稳定副本。
$installSrc = Join-Path $here 'install.ps1'
$installDest = Join-Path $root 'install.ps1'
$installNote = ''
if (Test-Path -LiteralPath $installSrc) {
  $same = (Test-Path -LiteralPath $installDest) -and ((Get-FileHash -LiteralPath $installSrc -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $installDest -Algorithm SHA256).Hash)
  if ($same) {
    $installNote = "install.ps1 -> $installDest（已是最新，无需拷贝）"
  } else {
    Copy-Item -Force -LiteralPath $installSrc -Destination $installDest
    $installNote = "install.ps1 -> $installDest（本次更新）"
  }
}

# ── 稳定副本 ↔ profile 副本：逐文件核一遍，别让"新加的文件没传播"静默发生 ─────────────
# 两个副本是**逐文件**硬链接，pnpm 只在 `dsh plugin add` 时拷文件 ⇒ 往某个包里加一个新文件后，
# 重跑本脚本只更新稳定副本，已经装好的 profile 副本仍然缺那个文件 —— 表现是装载时 import 找不到
# 模块（工具整条消失 / 设置页不出现），而且没有任何提示（2026-10-08 真发生过一次：
# lib\user-settings.mjs 漏进了 notify 的拷贝清单）。这里统一报出来。
foreach ($spec in @(
    @{ Pkg = 'adg-notify'; Dest = $notifyDest },
    @{ Pkg = 'adg-permission'; Dest = $permDest },
    @{ Pkg = 'adg-delegate'; Dest = $delegateDest },
    @{ Pkg = 'adg-settings'; Dest = $settingsDest },
    @{ Pkg = 'adg-skill-inject'; Dest = $injectDest },
    @{ Pkg = 'adg-source-guard'; Dest = $guardDest },
    @{ Pkg = 'adg-ptc-parallel'; Dest = $parallelDest })) {
  if (-not (Test-Path -LiteralPath $spec.Dest)) { continue }
  $expected = @()
  foreach ($f in Get-ChildItem -LiteralPath $spec.Dest -Recurse -File) {
    $rel = $f.FullName.Substring($spec.Dest.Length + 1)
    if ($rel -eq 'cli.mjs') { continue }
    if ($rel -like 'node_modules*') { continue }
    $expected += $rel
  }
  foreach ($copyDir in (Get-ChildItem -Path (Join-Path $root "profiles\*\node_modules\$($spec.Pkg)") -Directory -ErrorAction SilentlyContinue)) {
    $missing = @($expected | Where-Object { -not (Test-Path -LiteralPath (Join-Path $copyDir.FullName $_)) })
    if ($missing.Count -gt 0) {
      $installNotes += "$($copyDir.Parent.Parent.Name) : $($spec.Pkg) 的 profile 副本缺 $($missing.Count) 个文件（$($missing[0])…）—— 关掉 dsh 后重跑本脚本，或 dsh plugin --profile $($copyDir.Parent.Parent.Name) add `"file:$($spec.Dest)`""
    }
  }
}

Write-Host "已安装到 dsh 用户根：$root"
Write-Host "  skill   -> $skillNote"
foreach ($gen in $genFlavors) {
  Write-Host "  bundle  -> $($gen.dest)（$($gen.flavor) 味道：$($gen.note)；生成物来自 preset\preset.yml + preset\agent.cordis.yml）"
}
Write-Host "  browser -> $browserNote"
Write-Host "  desktop -> $desktopNote"
Write-Host "  install -> $installNote（安装脚本自己的稳定副本；repo 里改完 install.ps1 记得一起带过去）"
Write-Host "  notify  -> $notifyNote（notify_user 工具；每个 profile 的安装结果见下面 profile 行）"
Write-Host "  permission -> $permNote（set_child_permission 工具；只有调度智能体拿得到，子代理拿不到）"
Write-Host "  delegate -> $delegateNote（delegate 工具 —— 现有的**唯一委派入口**；只有调度智能体拿得到，子代理的永禁名单里有 delegate / set_child_permission / ask_user_question / agent。同一枚插件还提供 ask_user —— 子代理的提问通道，可给子代理）"
Write-Host "  settings -> $settingsNote（设置页「Adg 设置」；通知三项——默认标题 / 响提示音 / 通知常驻——在这里改，改完立即生效）"
Write-Host "  skill-inject -> $injectNote（思考框架注入：把 skills\thinking-framework\SKILL.md 正文注入 Adg 调度者的系统提示词；子代理是否也注入由设置页的 skillInjectSubagent 决定，默认关）"
Write-Host "  source-guard -> $guardNote（run_code 源码守卫：成功时在结果正文里前置一行当次执行意图「意图：<description>」，那句「源码未随本结果重复」说明句默认关闭，失败时原样保留；不注册工具）"
Write-Host "  ptc-parallel -> $parallelNote（PTC 并行执行提示：给 PTC 呈现的 agent（调度者与子代理）在自己的 scope 上注册一段系统提示词，说清无依赖的调用该一次全发；末尾那份可并发/独占清单每次组装时现算，不写死工具名；不注册工具）"
foreach ($note in $installNotes) { Write-Host "  profile -> $note" }
Write-Host ""
Write-Host "下一步：重启 dsh，然后在新建对话里选择「Adg PTC 模式」。"
Write-Host "（preset 走的是一条独立的 patch 层：`dsh --profile <name> --dump-config` 能确认它被读到，但只有真的新建一个会话才算挂载成功 —— 静态文件与 --dump-config 都证明不了挂载。）"
Write-Host "（browser/ 与 desktop/ 工具链又是另一回事：用户根下的普通文件，重新跑本脚本即生效，不用重启 dsh。）"
Write-Host "  desktop 的自检：node `"$desktopDest\cli.mjs`" profile —— 要真正驱动普通用户窗口，得在完全权限的会话里调它。"
Write-Host "（adg-notify 插件：装了之后必须重启 dsh 才注册 —— loader 会按解析路径缓存 ES 模块。）"
Write-Host "（adg-permission 插件：同样要重启 dsh 才注册；它不进任何 allow —— 只有调度智能体用。）"
Write-Host "（adg-delegate 插件：同样要重启 dsh 才注册；它是唯一的委派入口 —— 没它调度者开不了子代理。）"
Write-Host "（adg-settings 插件：同样要重启 dsh 才注册 —— 重启后设置里才会出现「Adg 设置」；没装它只是少一页设置，通知的出厂默认照旧。）"
Write-Host "（adg-skill-inject 插件：同样要重启 dsh 才注册 —— 重启后新建的 Adg 会话系统提示词里才有思考框架段；运行中的旧会话不补挂。它随第 1 节的技能拷贝一起工作：技能正文更新后重跑本脚本 + 重启即换。）"
Write-Host "（adg-source-guard 插件：同样要重启 dsh 才注册 —— 重启后新建的 Adg 会话里，顶层 run_code 的成功结果才会多出一行「意图：<当次 description>」（那句「源码未随本结果重复」说明句默认不出现）；失败结果永远逐字不变。注意它只改结果侧，tool/call 里那份入参源码平台没有挂载点可改。）"
Write-Host "（adg-ptc-parallel 插件：同样要重启 dsh 才注册 —— 而且 section 是在 agent 创建那一刻挂上的，所以运行中的旧会话不补挂：重启 dsh + 新建对话才看得到。子代理的 scope 同样会被判定，工具清单按每个 agent 当前可见的工具现算。）"
if ($packageFailed) {
  Write-Host ""
  Write-Host "注意：至少有一步 pnpm 没成功，$bundleName 可能还没装进 profile（上面的 profile 行里写明了）。" -ForegroundColor Yellow
  Write-Host "先关掉正在运行的 dsh（它占着 node_modules 里的文件，pnpm 无法重建目录），再重跑本脚本。" -ForegroundColor Yellow
  exit 2
}
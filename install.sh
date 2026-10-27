#!/usr/bin/env sh
# 安装 Adg PTC 模式 preset + 配套技能到本机 dsh 用户根。
# 用法： sh install.sh [--billion-context=auto|on|off] [--save-token=auto|on|off] [profile ...]
#        不带 profile 参数 = 所有能装 preset 的 profile；两个开关默认 auto（也可以用环境变量
#        ADG_BILLION_CONTEXT / ADG_SAVE_TOKEN 给默认值）。
#
# preset 现在的形状是一个 bundle：包清单声明 dsh.bundle.patch，patch 里 insert 一行
# @deepseek-ai/dsh-agent-preset 声明（id/name/description/order/plugins）。
# `$DSH_HOME/.agent-presets/<id>/` 那套目录发现机制已不存在，拷 preset.yml + agent.cordis.yml
# 装出来的东西没有任何组件会去读。本脚本：生成 bundle → 放到 $DSH_HOME/bundles/ →
# 装进目标 profile 的 node_modules 并写进该 profile 的 dsh.profile.bundles。
#
# preset 的生成物有**四种味道**（两个注入组的四种组合），每种占一个稳定目录 ——
#   $DSH_HOME/bundles/dsh-adg-ptc                 plain（gen 不带旗标）
#   $DSH_HOME/bundles/dsh-adg-ptc-bili            bili（调度 persona 里带 bili 的四个上下文工具）
#   $DSH_HOME/bundles/dsh-adg-ptc-save-token      save-token（带 save_token_expand）
#   $DSH_HOME/bundles/dsh-adg-ptc-bili-save-token 两组都带
# 四种的**包名都是 dsh-adg-ptc**，所以 profile 的 dsh.profile.bundles 那一行四种味道通用，
# 差别只在它 node_modules 里的那个 link 指向哪一个目录。每个 profile 按**自己的**探测结果选，
# 于是混装（一个 profile 挂 bili、另一个没挂）也能各拿对的形状。味道键、稳定目录名与 gen 旗标都在
# 第 0 / 3 节问 `node tools/resolve-flavor.mjs`（拼法只写在 tools/flavors.mjs，本脚本不重拼）。
# **不要再退回"生成物全机共用一份 + 每个目标 profile 都挂着才注入"那套口径**：那种做法在混装机器上
# 必然给挂着 bili 的那个 profile 装 plain —— 子代理收到 bili 的压缩指令却没有工具可调（本机复现过：
# web 挂 bili、desktop 没挂 ⇒ auto 选中 plain ⇒ web 的子代理报 `unknown tool compress`）。
set -eu

root="${DSH_HOME:-$HOME/.dsh}"
here="$(cd "$(dirname "$0")" && pwd)"
bundle_name='dsh-adg-ptc'
# 四个稳定落点（包名都是 $bundle_name，见文件头）：名字不在本脚本里拼 —— 第 3 节问
# `node tools/resolve-flavor.mjs` 拿（拼法只写在 tools/flavors.mjs）。每个 profile 只 link 其中一个。

# 先把 DSH_HOME 归一成绝对路径：稳定落点、探测与生成日志都按绝对路径用。
case "$root" in
  /*) ;;
  *)
    resolved="$(cd "$root" 2>/dev/null && pwd)" || resolved=""
    if [ -z "$resolved" ]; then
      echo "DSH_HOME 得是绝对路径，或者一个已存在的相对路径：$root" >&2
      exit 1
    fi
    root="$resolved"
    ;;
esac

# ── 目标 profile ────────────────────────────────────────────────────────────────
# 默认：能装 preset 的所有 profile —— 判据是它的 bundle 列表里有 @deepseek-ai/dsh-web-app，
# 因为 agent-preset-registry（agentPresets 服务）正是这个 bundle 声明的（实测：dsh-base 和
# dsh-headless 都不声明它）。往缺 registry 的 profile 里塞声明行会让该 profile 启动失败。
#
# 注入组探测（bili / save-token 两组各探一次，与 install.ps1 同一份实现 tools/has-bundle.mjs）：
#   口径是"**先探测该环境下是否装有对应插件；装了才注入它的工具名**"（这正是 auto 的语义）。
#      每个 profile 链接**自己该拿的**那份味道的生成物（四个稳定目录，见文件头）：装着 bili 的拿带 bili
#      那一组的味道（调度 persona 里多一段"委派时要带上那四个上下文工具"的说明）、装着 save-token 的拿带
#      save_token_expand 的那一组；两组都装 / 都不装各有一种味道。不注入 = 子代理收到该插件的指令或
#      `[save-token #id] … Call the save_token_expand tool` 通知却没工具可调；给没装的 profile 注入 =
#      每一次委派抛 names unknown global tool —— 所以每种组合必须分开装，不能"宁可少给"一刀切。
#      `--billion-context=on|off` / `--save-token=on|off` 是整体覆盖。
# 覆盖：--billion-context=auto|on|off，或环境变量 ADG_BILLION_CONTEXT（默认 auto）；
#       --save-token=auto|on|off，或环境变量 ADG_SAVE_TOKEN（默认 auto）。两者完全并列、语义相同。
billion_context_mode="${ADG_BILLION_CONTEXT:-auto}"
save_token_mode="${ADG_SAVE_TOKEN:-auto}"
positional=""
has_positional=0
for arg in "$@"; do
  case "$arg" in
    --billion-context=*) billion_context_mode="${arg#--billion-context=}" ;;
    --billion-context)
      echo "--billion-context 需要值：--billion-context=auto|on|off" >&2
      exit 1
      ;;
    --save-token=*) save_token_mode="${arg#--save-token=}" ;;
    --save-token)
      echo "--save-token 需要值：--save-token=auto|on|off" >&2
      exit 1
      ;;
    *)
      positional="$positional $arg"
      has_positional=1
      ;;
  esac
done
case "$billion_context_mode" in
  auto | on | off) ;;
  *)
    echo "billion-context 模式只认 auto|on|off，给的是：$billion_context_mode" >&2
    exit 1
    ;;
esac
case "$save_token_mode" in
  auto | on | off) ;;
  *)
    echo "save-token 模式只认 auto|on|off，给的是：$save_token_mode" >&2
    exit 1
    ;;
esac

profiles=""
package_failed=0
if [ "$has_positional" -eq 1 ]; then
  # shellcheck disable=SC2086
  profiles="$positional"
else
  profiles="$(node -e '
    const fs = require("fs"), path = require("path");
    const dir = process.argv[1];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === "node_modules") continue;
      const m = path.join(dir, e.name, "package.json");
      if (!fs.existsSync(m)) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(m, "utf8")); } catch { continue; }
      const bundles = (j.dsh && j.dsh.profile && j.dsh.profile.bundles) || [];
      if (bundles.includes("@deepseek-ai/dsh-web-app")) console.log(e.name);
    }' "$root/profiles")"
fi
if [ -z "$profiles" ]; then
  echo "在 $root/profiles 下没找到可装 preset 的 profile（判据：dsh.profile.bundles 含 @deepseek-ai/dsh-web-app）" >&2
  exit 1
fi

# ── 0. 注入组探测（billion-context / save-token；两组各探一次，共用 tools/has-bundle.mjs）────
# 口径：**先探测该环境下是否装有对应插件；装了才注入它的工具名**（这正是 auto 的语义）。
# 每组两张名单：
#   bili_on / save_token_on  = 装着该组的 profile —— 它拿含该组的生成物
#   *_off                    = 没装的 profile —— 它拿不含该组的生成物
# shellcheck disable=SC2086
bili_map="$(node "$here/tools/has-bundle.mjs" "$root/profiles" $profiles)"
# shellcheck disable=SC2086
save_token_map="$(node "$here/tools/has-bundle.mjs" "$root/profiles" $profiles --package=dsh-plugin-save-token)"
tab="$(printf '\t')"
bili_on=""
bili_off=""
while IFS="$tab" read -r bili_name bili_flag; do
  [ -n "$bili_name" ] || continue
  if [ "$bili_flag" = "1" ]; then bili_on="$bili_on $bili_name"; else bili_off="$bili_off $bili_name"; fi
done <<EOF
$bili_map
EOF
save_token_on=""
save_token_off=""
while IFS="$tab" read -r st_name st_flag; do
  [ -n "$st_name" ] || continue
  if [ "$st_flag" = "1" ]; then save_token_on="$save_token_on $st_name"; else save_token_off="$save_token_off $st_name"; fi
done <<EOF
$save_token_map
EOF
# has_bili / has_save_token <profile> → 打印 0/1（auto 判定与覆盖提醒都问它）
has_bili() {
  printf '%s\n' "$bili_map" | awk -F'\t' -v want="$1" '$1 == want { print $2 }'
}
has_save_token() {
  printf '%s\n' "$save_token_map" | awk -F'\t' -v want="$1" '$1 == want { print $2 }'
}
# 每组按 auto/on/off 解析：auto = 这个 profile 自己的探测值；on / off 强制。
want_bili_of() {
  case "$billion_context_mode" in
    on) echo 1 ;;
    off) echo 0 ;;
    *) if [ "$(has_bili "$1")" = "1" ]; then echo 1; else echo 0; fi ;;
  esac
}
want_save_token_of() {
  case "$save_token_mode" in
    on) echo 1 ;;
    off) echo 0 ;;
    *) if [ "$(has_save_token "$1")" = "1" ]; then echo 1; else echo 0; fi ;;
  esac
}
# 每个目标 profile 的三列解析结果（每个 profile 只起一次 node），一行一个：
#   `<profile>\t<味道键>\t<稳定目录名>\t<gen 旗标>`；三列都由 tools/resolve-flavor.mjs 给
#   （拼法只写在 tools/flavors.mjs，本脚本不重拼）。它只做映射、**不做探测**。
flavor_table=""
for name in $profiles; do
  group_flags=""
  if [ "$(want_bili_of "$name")" = "1" ]; then group_flags="$group_flags --billion-context"; fi
  if [ "$(want_save_token_of "$name")" = "1" ]; then group_flags="$group_flags --save-token"; fi
  # shellcheck disable=SC2086
  resolved="$(node "$here/tools/resolve-flavor.mjs" $group_flags)"
  # 行用 printf 的格式串拼：`$(printf '\n')` 会被命令替换吞掉末尾的换行（值变成空串），几行就会挤成一行，
  # 于是除第一个 profile 外谁都查不到自己的味道（实测踩过）。
  flavor_table="$(printf '%s\n%s\t%s' "$flavor_table" "$name" "$resolved")"
done
flavor_of() { printf '%s\n' "$flavor_table" | awk -F'\t' -v want="$1" '$1 == want { print $2 }'; }
bundle_dir_of() { printf '%s\n' "$flavor_table" | awk -F'\t' -v want="$1" '$1 == want { print $3 }'; }
# 每组最终注入与否的名单（供日志与覆盖提醒用）。
bili_wanted_profiles=""
bili_unwanted_profiles=""
save_token_wanted_profiles=""
save_token_unwanted_profiles=""
for name in $profiles; do
  if [ "$(want_bili_of "$name")" = "1" ]; then
    bili_wanted_profiles="$bili_wanted_profiles $name"
  else
    bili_unwanted_profiles="$bili_unwanted_profiles $name"
  fi
  if [ "$(want_save_token_of "$name")" = "1" ]; then
    save_token_wanted_profiles="$save_token_wanted_profiles $name"
  else
    save_token_unwanted_profiles="$save_token_unwanted_profiles $name"
  fi
done
echo "billion-context 探测：$([ -n "$bili_on" ] && echo "已挂载 [${bili_on# }]" || echo "没有任何目标 profile 挂载") / 未挂载 $([ -n "$bili_off" ] && echo "[${bili_off# }]" || echo "无")"
echo "save-token 探测：$([ -n "$save_token_on" ] && echo "已挂载 [${save_token_on# }]" || echo "没有任何目标 profile 挂载") / 未挂载 $([ -n "$save_token_off" ] && echo "[${save_token_off# }]" || echo "无")"
for name in $profiles; do
  flavor="$(flavor_of "$name")"
  case "$flavor" in
    plain) flavor_note="不带任何注入的上下文工具" ;;
    bili) flavor_note="调度 persona 里带 bili 的四个上下文工具说明" ;;
    save-token) flavor_note="调度 persona 里带 save-token 的 save_token_expand 说明" ;;
    bili+save-token) flavor_note="调度 persona 里带 bili 的四个上下文工具 + save-token 的 save_token_expand 说明" ;;
    *) flavor_note="" ;;
  esac
  echo "  味道 -> $name : $flavor（$flavor_note）"
done
# 覆盖开关与探测结果对不上时必须明说：判断错的那一方不是少个能力就是每次委派都挂（红线 7）。
# 每组三档的错配都要报出来：on 但一个都没装 / on 被强制套到没装的 profile / off 把装着的关掉。
bili_forced_onto_off=""
bili_forced_off_of_on=""
for name in $bili_wanted_profiles; do
  if [ "$(has_bili "$name")" != "1" ]; then bili_forced_onto_off="$bili_forced_onto_off $name"; fi
done
for name in $bili_unwanted_profiles; do
  if [ "$(has_bili "$name")" = "1" ]; then bili_forced_off_of_on="$bili_forced_off_of_on $name"; fi
done
save_token_forced_onto_off=""
save_token_forced_off_of_on=""
for name in $save_token_wanted_profiles; do
  if [ "$(has_save_token "$name")" != "1" ]; then save_token_forced_onto_off="$save_token_forced_onto_off $name"; fi
done
for name in $save_token_unwanted_profiles; do
  if [ "$(has_save_token "$name")" = "1" ]; then save_token_forced_off_of_on="$save_token_forced_off_of_on $name"; fi
done
if [ "$billion_context_mode" = "on" ] && [ -z "$bili_wanted_profiles" ]; then
  echo "  注意：--billion-context=on 但按名单没有任何 profile 挂着 billion-context —— 仍按 on 装带 bili 那一组的味道，" >&2
  echo "    请确认这些 profile 之后会装上 billion-context（否则调度者把那四个名字写进委派时一个都不生效 —— delegate 会逐条写进 tools_note）。" >&2
fi
if [ -n "$bili_forced_onto_off" ]; then
  echo "  注意：--billion-context=on 强制注入，但这些目标 profile 没挂 bili：${bili_forced_onto_off# } ——" >&2
  echo "    它们每一次委派都会抛 names unknown global tool \"compress\"（要么装上 bili，要么改回 auto）。" >&2
fi
if [ -n "$bili_forced_off_of_on" ]; then
  echo "  注意：--billion-context=off 强制不注入，但这些目标 profile 挂着 bili：${bili_forced_off_of_on# } ——" >&2
  echo "    它们的子代理会收到 bili 的压缩指令却没有工具可调（改回 auto 才会按 profile 选味道）。" >&2
fi
if [ "$save_token_mode" = "on" ] && [ -z "$save_token_wanted_profiles" ]; then
  echo "  注意：--save-token=on 但按名单没有任何 profile 装着 dsh-plugin-save-token —— 仍按 on 装带 save-token 那一组的味道，" >&2
  echo "    请确认这些 profile 之后会装上 dsh-plugin-save-token（否则调度者把 save_token_expand 写进委派时不生效 —— delegate 会写进 tools_note）。" >&2
fi
if [ -n "$save_token_forced_onto_off" ]; then
  echo "  注意：--save-token=on 强制注入，但这些目标 profile 没装 dsh-plugin-save-token：${save_token_forced_onto_off# } ——" >&2
  echo "    它们每一次委派都会抛 names unknown global tool \"save_token_expand\"（要么给它们装上那个插件，要么改回 auto）。" >&2
fi
if [ -n "$save_token_forced_off_of_on" ]; then
  echo "  注意：--save-token=off 强制不注入，但这些目标 profile 装着 dsh-plugin-save-token：${save_token_forced_off_of_on# } ——" >&2
  echo "    它们的子代理会收到 \"Call the save_token_expand tool\" 的取回通知却没有工具可调（改回 auto 才会按 profile 选味道）。" >&2
fi

# ── 1. 用户技能 ────────────────────────────────────────────────────────────────
# 拷 skills/ 下的**所有**技能目录：技能是渐进式披露的载体，调度者按绝对路径让子代理先 read 它 ——
# 少拷一份，那条「先 read 该文件再动手」的委派就读不到东西。
skill_count=0
for skill_dir in "$here"/skills/*/; do
  [ -f "$skill_dir/SKILL.md" ] || continue
  skill_name=$(basename "$skill_dir")
  mkdir -p "$root/skills/$skill_name"
  cp "$skill_dir/SKILL.md" "$root/skills/$skill_name/SKILL.md"
  skill_count=$((skill_count + 1))
done
skill_note="用户技能 -> $root/skills（$skill_count 份 SKILL.md）"

# ── 2. browser/ 工具链 ─────────────────────────────────────────────────────────
# 它是普通文件、不是插件也不是 preset：重新跑一次本脚本就生效，**不需要重启 dsh**。
# 先删后拷，避免上一层版本的残留。
browser_src="$here/browser"
browser_dest="$root/browser"
if [ -d "$browser_src" ]; then
  rm -rf "$browser_dest"
  mkdir -p "$browser_dest"
  cp -R "$browser_src/." "$browser_dest/"
  browser_note="browser/ 工具链 -> $browser_dest"
else
  browser_note="未找到 $browser_src，跳过 browser/ 工具链部署"
fi

# ── 2c. desktop/ 工具链 ────────────────────────────────────────────────────────
# 与 2. browser/ 同口径：普通文件、不是插件也不是 preset，重新跑一次本脚本就生效，
# **不需要重启 dsh**。先删后拷，避免上一层版本的残留。
# 注意：它只是把 CLI 与随附的 PowerShell 桥拷过去；本模块是 Windows 专用
# （非 Windows 上 profile 会如实报 WINDOWS_ONLY=true），拷贝本身无害。
desktop_src="$here/desktop"
desktop_dest="$root/desktop"
if [ -d "$desktop_src" ]; then
  rm -rf "$desktop_dest"
  mkdir -p "$desktop_dest"
  cp -R "$desktop_src/." "$desktop_dest/"
  desktop_note="desktop/ 工具链 -> $desktop_dest"
else
  desktop_note="未找到 $desktop_src，跳过 desktop/ 工具链部署"
fi

# ── 2b. notify/ 插件（notify_user 工具）────────────────────────────────────────
# 与 preset bundle 的区别（别混成一条，两者是不同的加载路径）：
#   preset bundle 靠 profile 里的 link: 依赖 + dsh.profile.bundles 装载；
#   本插件是**普通插件包**，靠 profile 里的 file: 依赖 + dsh.profile.bundles 装载。
#   本机的 anysearch-dsh 与 dsh-windows-notifier 都是 file: 形状（装成 profile node_modules
#   下的真目录），本插件与它们同形。preset bundle 用 link:、普通插件包用 file:，
#   两条装载路径都可用 —— 本插件用 file:（与两个在跑的插件一致）。
#
# 先把源码拷到用户根下的**稳定副本**，再让每个 profile 依赖它：profile 里的 file: 指向仓库
# 工作区的话，仓库一移动/删除那个 profile 就解析不到包了。代价是改源码后要跑一次本脚本。
# 稳定副本按内容比对——内容没变就不碰，免得 pnpm 在下次 add 时又要重装（dsh 在跑时那步会失败）。
notify_src="$here/notify"
notify_dest="$root/plugins/adg-notify"
notify_note=""
notify_skipped=0
# 4c-1 的断言要用它；在这里初始化，免得 set -u 下某个分支没赋值就展开而整个脚本退出。
notify_in_profile=""
if [ ! -f "$notify_src/package.json" ]; then
  notify_note="未找到 $notify_src，跳过 notify/ 插件部署"
  notify_skipped=1
else
  # 这里的清单与 notify/package.json 的 `files` 字段**故意不同**：本清单比它多 `cli.mjs`（仓库内自测 / 手工发通知用）与 `package.json`（稳定副本要能当包被 `dsh plugin add "file:…"` 解析）。`files` 那 8 条是给 npm pack 用的，所以各 profile 里那份副本是 9 个文件、没有 `cli.mjs` 是预期。差异是刻意的，见 notify/testing-guide.md 的漂移检测一节。
  # 注意：稳定副本 ↔ profile 副本是**逐文件**硬链接，往这里加一个新文件（比如 lib/user-settings.mjs）
  # **不会**自己传播到已经装好的 profile —— pnpm 只在 `add` 时拷文件。脚本尾部的核对会把这种情况报出来。
  mkdir -p "$notify_dest/lib" "$notify_dest/scripts"
  notify_copied=0
  for notify_rel in index.mjs cli.mjs lib/toast.mjs lib/user-settings.mjs scripts/toast.ps1 cordis.patch.yml \
    package.json AGENTS.md design.md testing-guide.md; do
    if [ ! -f "$notify_src/$notify_rel" ]; then
      notify_note="notify/ 部署不完整：源里缺 $notify_rel"
      notify_skipped=1
      break
    fi
    if [ -f "$notify_dest/$notify_rel" ] && cmp -s "$notify_src/$notify_rel" "$notify_dest/$notify_rel"; then
      continue
    fi
    cp "$notify_src/$notify_rel" "$notify_dest/$notify_rel"
    notify_copied=$((notify_copied + 1))
  done
  if [ "$notify_skipped" -eq 0 ]; then
    if [ "$notify_copied" -gt 0 ]; then
      notify_note="notify/ 插件 -> $notify_dest（本次更新 $notify_copied 个文件）"
    else
      notify_note="notify/ 插件 -> $notify_dest（已是最新，无需拷贝）"
    fi
  fi
fi

# ── 2b-1. permission/ 插件（set_child_permission 工具）─────────────────────────
# 与 2b 同形（普通插件包、file: 依赖、用户根下的稳定副本），消费方不同：这个工具只给
# 调度智能体用，永远不会出现在子代理的工具面里（它在 delegate 的内置 deny 名单里）。漏装的后果
# 不是派发时报 names unknown global tool，而是调度者需要改权限时调到一个不存在的工具 ——
# 同样必须装，同样必须重启 dsh 才注册。
permission_src="$here/permission"
permission_dest="$root/plugins/adg-permission"
permission_note=""
permission_skipped=0
# 4c-3 的断言要用它；在这里初始化，免得 set -u 下某个分支没赋值就展开而整个脚本退出。
permission_in_profile=""
if [ ! -f "$permission_src/package.json" ]; then
  permission_note="未找到 $permission_src，跳过 permission/ 插件部署"
  permission_skipped=1
else
  # 本清单与 permission/package.json 的 `files` 字段**故意不同**：多一个 `package.json`
  # （稳定副本要能当包被 `dsh plugin add "file:…"` 解析）。本插件没有 cli.mjs。
  mkdir -p "$permission_dest/lib"
  permission_copied=0
  for permission_rel in index.mjs lib/permission.mjs cordis.patch.yml \
    package.json AGENTS.md design.md testing-guide.md; do
    if [ ! -f "$permission_src/$permission_rel" ]; then
      permission_note="permission/ 部署不完整：源里缺 $permission_rel"
      permission_skipped=1
      break
    fi
    if [ -f "$permission_dest/$permission_rel" ] && cmp -s "$permission_src/$permission_rel" "$permission_dest/$permission_rel"; then
      continue
    fi
    cp "$permission_src/$permission_rel" "$permission_dest/$permission_rel"
    permission_copied=$((permission_copied + 1))
  done
  if [ "$permission_skipped" -eq 0 ]; then
    if [ "$permission_copied" -gt 0 ]; then
      permission_note="permission/ 插件 -> $permission_dest（本次更新 $permission_copied 个文件）"
    else
      permission_note="permission/ 插件 -> $permission_dest（已是最新，无需拷贝）"
    fi
  fi
fi

# ── 2b-2. delegate/ 插件（`delegate` 工具）─────────────────────────────────────
# 与 2b / 2b-1 同形（普通插件包、file: 依赖、用户根下的稳定副本）。它是**唯一的委派入口**：
# preset 里那条委派行只是"子代理后端"（toolName `agent`），调度者真正用来开子代理、并给那一次
# 指定目标 / 工具面 / persona 的是本插件的 `delegate`。漏装的后果比另两个更重 —— 调度者手上会
# 没有任何委派工具（`agent` 在它自己的内置 deny 名单里，子代理永远拿不到它）。同样必须重启 dsh 才注册。
delegate_src="$here/delegate"
delegate_dest="$root/plugins/adg-delegate"
delegate_note=""
delegate_skipped=0
# 4c-5 的断言要用它；在这里初始化，免得 set -u 下某个分支没赋值就展开而整个脚本退出。
delegate_in_profile=""
if [ ! -f "$delegate_src/package.json" ]; then
  delegate_note="未找到 $delegate_src，跳过 delegate/ 插件部署"
  delegate_skipped=1
else
  # 本清单与 delegate/package.json 的 `files` 字段**故意不同**：多一个 `package.json`
  # （稳定副本要能当包被 `dsh plugin add "file:…"` 解析）。本插件没有 cli.mjs。
  mkdir -p "$delegate_dest/lib"
  delegate_copied=0
  for delegate_rel in index.mjs lib/delegate.mjs cordis.patch.yml \
    package.json AGENTS.md design.md testing-guide.md; do
    if [ ! -f "$delegate_src/$delegate_rel" ]; then
      delegate_note="delegate/ 部署不完整：源里缺 $delegate_rel"
      delegate_skipped=1
      break
    fi
    if [ -f "$delegate_dest/$delegate_rel" ] && cmp -s "$delegate_src/$delegate_rel" "$delegate_dest/$delegate_rel"; then
      continue
    fi
    cp "$delegate_src/$delegate_rel" "$delegate_dest/$delegate_rel"
    delegate_copied=$((delegate_copied + 1))
  done
  if [ "$delegate_skipped" -eq 0 ]; then
    if [ "$delegate_copied" -gt 0 ]; then
      delegate_note="delegate/ 插件 -> $delegate_dest（本次更新 $delegate_copied 个文件）"
    else
      delegate_note="delegate/ 插件 -> $delegate_dest（已是最新，无需拷贝）"
    fi
  fi
fi

# ── 2b-3. settings/ 插件（设置页「Adg 设置」）──────────────────────────────────
# 与 2b / 2b-1 / 2b-2 同形（普通插件包、file: 依赖、用户根下的稳定副本）。这是唯一带前端的
# 一枚：宿主半边 index.js 注册同源路由 /api/adg-settings，客户端半边 client.js 往
# settings.section 挂一页（order 38），两半由同一份登记表 lib/schema.mjs 驱动。
# 漏装的症状是"设置页里少一页"，而不是委派报错；它也**不影响 notify 的默认值**：adg-notify
# 只按文件契约读 adg-settings.json，文件不在就回落到出厂默认。同样必须重启 dsh 才注册。
settings_src="$here/settings"
settings_dest="$root/plugins/adg-settings"
settings_note=""
settings_skipped=0
# 4c-7 的断言要用它；在这里初始化，免得 set -u 下某个分支没赋值就展开而整个脚本退出。
settings_in_profile=""
if [ ! -f "$settings_src/package.json" ]; then
  settings_note="未找到 $settings_src，跳过 settings/ 插件部署"
  settings_skipped=1
else
  # 本清单与 settings/package.json 的 `files` 字段**故意不同**：多一个 `package.json`
  # （稳定副本要能当包被 `dsh plugin add "file:…"` 解析）。
  mkdir -p "$settings_dest/lib"
  settings_copied=0
  for settings_rel in index.js client.js lib/schema.mjs cordis.patch.yml \
    package.json AGENTS.md design.md testing-guide.md; do
    if [ ! -f "$settings_src/$settings_rel" ]; then
      settings_note="settings/ 部署不完整：源里缺 $settings_rel"
      settings_skipped=1
      break
    fi
    if [ -f "$settings_dest/$settings_rel" ] && cmp -s "$settings_src/$settings_rel" "$settings_dest/$settings_rel"; then
      continue
    fi
    cp "$settings_src/$settings_rel" "$settings_dest/$settings_rel"
    settings_copied=$((settings_copied + 1))
  done
  if [ "$settings_skipped" -eq 0 ]; then
    if [ "$settings_copied" -gt 0 ]; then
      settings_note="settings/ 插件 -> $settings_dest（本次更新 $settings_copied 个文件）"
    else
      settings_note="settings/ 插件 -> $settings_dest（已是最新，无需拷贝）"
    fi
  fi
fi

# ── 2b-4. skill-inject/ 插件（思考框架注入）──────────────────────────────────
# 与 2b / 2b-1 / 2b-2 / 2b-3 同形（普通插件包、file: 依赖、用户根下的稳定副本）。
# 它不注册任何工具：在 agent/created 时判定"这个 agent 的 preset 是不是 adg-ptc"（判定只看
# preset；子代理是否也注入由设置键 skillInjectSubagent 决定，默认关），是就在它自己的
# agent.ctx 上注册一段系统提示词 section，正文按设置键 skillInjectFramework 在用户技能根的
# skills/thinking-framework/SKILL.md 与 skills/execution-framework/SKILL.md 之间选一份（两份都是
# 本脚本第 1 节拷的；出厂默认执行框架）。漏装的症状是
# 调度者的系统提示词里没有思考框架段（静默退回"靠模型自觉 read"的旧状态），不报错。
inject_src="$here/skill-inject"
inject_dest="$root/plugins/adg-skill-inject"
inject_note=""
inject_skipped=0
# 4c-9 的断言要用它；在这里初始化，免得 set -u 下某个分支没赋值就展开而整个脚本退出。
inject_in_profile=""
if [ ! -f "$inject_src/package.json" ]; then
  inject_note="未找到 $inject_src，跳过 skill-inject/ 插件部署"
  inject_skipped=1
else
  # 本清单与 skill-inject/package.json 的 `files` 字段**故意不同**：多一个 `package.json`
  # （稳定副本要能当包被 `dsh plugin add "file:…"` 解析）。有子目录 lib/。
  mkdir -p "$inject_dest/lib"
  inject_copied=0
  for inject_rel in index.mjs client.js lib/section.mjs lib/user-settings.mjs cordis.patch.yml \
    package.json AGENTS.md design.md testing-guide.md; do
    if [ ! -f "$inject_src/$inject_rel" ]; then
      inject_note="skill-inject/ 部署不完整：源里缺 $inject_rel"
      inject_skipped=1
      break
    fi
    if [ -f "$inject_dest/$inject_rel" ] && cmp -s "$inject_src/$inject_rel" "$inject_dest/$inject_rel"; then
      continue
    fi
    cp "$inject_src/$inject_rel" "$inject_dest/$inject_rel"
    inject_copied=$((inject_copied + 1))
  done
  if [ "$inject_skipped" -eq 0 ]; then
    if [ "$inject_copied" -gt 0 ]; then
      inject_note="skill-inject/ 插件 -> $inject_dest（本次更新 $inject_copied 个文件）"
    else
      inject_note="skill-inject/ 插件 -> $inject_dest（已是最新，无需拷贝）"
    fi
  fi
fi

# ── 3. preset bundle：四种味道全部生成 → 各自落到自己的稳定位置（每 profile 只 link 一份）──
# 源文件永远只有 preset/preset.yml + preset/agent.cordis.yml；bundle/adg-*/ 是构建产物
# （在 .gitignore 里），每次安装都重新生成，所以没有人需要手改 patch。
# 各注入组的工具名只进生成物、不进源文件：源文件得对没装那些插件的人也成立（见 gen 脚本的 --with-* 说明）。
# **四份都无条件生成**：省掉"这一跑要不要重建那一份"的判断，稳定目录里的形状永远等于它该有的形状。
# 表里只写"味道键 + 输出目录 + 它含哪几组"；输出目录按"味道键里的 + 换成 -"，
# **稳定目录名与 gen 旗标都问 tools/resolve-flavor.mjs**（拼法只写在 tools/flavors.mjs，本脚本不重拼），
# 并当场核对它给的味道键与表里一致。
# outDir 传绝对路径：gen 脚本用的是 process.cwd()，不能跟着"用户从哪个目录调用本脚本"漂。
gen_flavors='plain bili save-token bili+save-token'
bundle_dest_table=""
for gen_flavor in $gen_flavors; do
  case "$gen_flavor" in
    plain) gen_groups="" ;;
    bili) gen_groups="--billion-context" ;;
    save-token) gen_groups="--save-token" ;;
    bili+save-token) gen_groups="--billion-context --save-token" ;;
  esac
  # shellcheck disable=SC2086
  gen_resolved="$(node "$here/tools/resolve-flavor.mjs" $gen_groups)"
  gen_key="$(printf '%s' "$gen_resolved" | cut -f1)"
  gen_dir_name="$(printf '%s' "$gen_resolved" | cut -f2)"
  gen_flags="$(printf '%s' "$gen_resolved" | cut -f3)"
  if [ "$gen_key" != "$gen_flavor" ]; then
    echo "味道键对不上：本脚本表里是 $gen_flavor，tools/resolve-flavor.mjs 给的是 $gen_key" >&2
    exit 1
  fi
  gen_out="$here/bundle/adg-$(printf '%s' "$gen_flavor" | tr '+' '-')"
  # shellcheck disable=SC2086
  node "$here/tools/gen-preset-bundle.mjs" $gen_flags "$gen_out"
  # $DSH_HOME/bundles/ 是稳定位置：profile 只引用这里，仓库可以随便挪/删。
  gen_dest="$root/bundles/$gen_dir_name"
  rm -rf "$gen_dest"
  mkdir -p "$gen_dest"
  cp "$gen_out/cordis.patch.yml" "$gen_dest/cordis.patch.yml"
  cp "$gen_out/package.json" "$gen_dest/package.json"
  # 同上：换行由 printf 的格式串给，别用 `$(printf '\n')`（命令替换会把末尾换行吞掉，几行挤成一行）。
  bundle_dest_table="$(printf '%s\n%s\t%s' "$bundle_dest_table" "$gen_flavor" "$gen_dest")"
done
# 四种味道的 package.json 必须**逐字节相同、包名都叫 $bundle_name**（profile 的 dsh.profile.bundles
# 那一行四种味道通用，差别只在 link 指向哪个目录），所以拷完当场验一遍。
plain_dest="$(printf '%s\n' "$bundle_dest_table" | awk -F'\t' -v want='plain' '$1 == want { print $2 }')"
for gen_flavor in $gen_flavors; do
  gen_dest="$(printf '%s\n' "$bundle_dest_table" | awk -F'\t' -v want="$gen_flavor" '$1 == want { print $2 }')"
  if ! cmp -s "$plain_dest/package.json" "$gen_dest/package.json"; then
    echo "$gen_dest/package.json 与 plain 那一份不是逐字节相同 —— 四种味道的包名与清单必须一致，profile 的 dsh.profile.bundles 才能通用" >&2
    exit 1
  fi
done
pkg_name="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name)' "$plain_dest/package.json")"
if [ "$pkg_name" != "$bundle_name" ]; then
  echo "稳定目录里的包名是 $pkg_name，期望 $bundle_name（profile 的 dsh.profile.bundles 那一行按这个包名写）" >&2
  exit 1
fi

# ── 4. 装进目标 profile（依赖 link + 写进该 profile 的 dsh.profile.bundles）────────
for name in $profiles; do
  profile_dir="$root/profiles/$name"
  manifest="$profile_dir/package.json"
  if [ ! -f "$manifest" ]; then
    echo "profile 不存在：$profile_dir" >&2
    exit 1
  fi

  # 4a. 依赖（等价于 `dsh plugin --profile <name> add link:<dir>`，那是一条 pnpm 直通命令）。
  # 用 link: 而不是把文件真拷进 node_modules：目标目录在 $DSH_HOME 下的稳定位置，
  # 重新生成 preset 之后不用重装就生效。
  # pnpm 在 **dsh 正在运行时**会失败：它发现 node_modules 不是自己管的（.modules.yaml 缺失）
  # 就想整目录重建，而文件被运行中的 dsh 占着（实测：os error 32 / ERR_PNPM_…_REMOVE_MODULES_DIR）。
  # 那要先关掉 dsh，重跑没用 —— 所以这里只报告，不中断后面的步骤。
  # 这个 profile 该拿哪一种味道的稳定目录（见上面第 0 节的 flavor_of / bundle_dir_of）。换味道也只在这一步发生：
  # 同一个包名 link: 到另一个目录，profile 的 dsh.profile.bundles 一行都不用改（四种味道包名相同）。
  flavor="$(flavor_of "$name")"
  want_bundle="$root/bundles/$(bundle_dir_of "$name")"
  pnpm_failed=0
  if command -v pnpm >/dev/null 2>&1; then
    if (cd "$profile_dir" && pnpm add "link:$want_bundle"); then
      echo "  profile -> $name : 已 link $bundle_name（$flavor 味道）"
    else
      pnpm_failed=1
      echo "  profile -> $name : pnpm add 失败 —— 常见原因是 dsh 正在运行、node_modules 被占用；关掉 dsh 后重跑本脚本" >&2
    fi
  else
    pnpm_failed=1
    echo "  profile -> $name : 未找到 pnpm，跳过依赖安装 —— 请在该 profile 里执行 pnpm add link:$want_bundle"
  fi

  # 4b. bundle 必须被选进 dsh.profile.bundles，否则它的 patch 层根本不会被读。
  # 但"选进列表"和"包装上了"必须同时成立：只写列表而包装不上，会让这个 profile 启动时报
  # 未安装的 bundle。所以先确认包真的解析得到，包不在就只报告、不写列表。
  if [ ! -f "$profile_dir/node_modules/$bundle_name/package.json" ]; then
    package_failed=1
    echo "  profile -> $name : $bundle_name 还没装进这个 profile 的 node_modules —— 未写入 dsh.profile.bundles"
    continue
  fi
  # pnpm 那一步失败、但包其实早就在位（例如上一次安装留下的）时不算失败，只说明本次没重装依赖。
  if [ "$pnpm_failed" -eq 1 ]; then
    echo "  profile -> $name : pnpm 那一步没成功，但 $bundle_name 已在 node_modules 里 —— 本次安装不受影响"
  fi
  # 4b-1. 断言**已经链接进去的那一份**的味道，正是这个 profile 该拿的味道。
  # 判据不能是"包在不在"：四种味道的 package.json 逐字节相同、包名也一样，只有产物本体不同 ——
  # 所以让 tools/check-bundle-flavor.mjs 逐行验调度 persona 里那段注入说明与 compaction-basic 的 auto
  # （四种味道各按自己的注入组断言：该有的全有、不该有的一个都不能出现）。
  # 这一格是本缺陷的"静默失效"出口：味道换错时一切看起来都正常，只有调度 persona 少了那段说明（子代理的工具面就少那几个名字）。
  linked_patch="$profile_dir/node_modules/$bundle_name/cordis.patch.yml"
  flavor_ok=0
  flavor_report=""
  if [ -f "$linked_patch" ]; then
    flavor_report="$(node "$here/tools/check-bundle-flavor.mjs" "$linked_patch" "$flavor" 2>&1)" || flavor_ok=$?
  else
    flavor_ok=1
    flavor_report="$linked_patch 不存在"
  fi
  if [ "$flavor_ok" -eq 0 ]; then
    echo "  profile -> $name : 落点味道 = $flavor（tools/check-bundle-flavor.mjs 通过）"
  else
    echo "  profile -> $name : 落点味道 ≠ $flavor —— 链接到的还是另一种味道（换味道那一步没成功；调度 persona 会少/多一段「委派时要带上哪些上下文工具」的说明）" >&2
    printf '%s\n' "$flavor_report" | while IFS= read -r flavor_line; do
      echo "      $flavor_line"
    done
    package_failed=1
  fi

  # 4c. adg-notify 插件（notify_user）也装进这个 profile，并写进同一个 dsh.profile.bundles。
  # **半硬依赖**：`notify_user` 刻意在 `delegate` 的内置 deny 名单之外（允许给子代理用），而委派时
  # 点名的名字必须在那次会话里已注册 —— 哪个 profile 装了 bundle 却没装本插件，调度者一旦把
  # notify_user 写进某次委派的 `tools`，那个名字就会被 `delegate` 剔掉并写进 `tools_note`。
  # 用 `dsh plugin --profile <n> add file:<dir>` 而不是手抄 manifest：这条命令自己会
  #   (1) 跑 pnpm add（包以真目录落进该 profile 的 node_modules）
  #   (2) reconcile 一遍，把声明了 dsh.bundle 的依赖追加进 dsh.profile.bundles
  # （2 是它内部做的，所以下面还要**读回来断言**，不拿它的返回码当证据。）
  if [ "$notify_skipped" -eq 1 ]; then
    echo "  profile -> $name : adg-notify 未部署（$notify_note）—— 委派里写 notify_user 会拿到「未生效」" >&2
  else
    notify_in_profile="$profile_dir/node_modules/adg-notify/package.json"
    if [ -f "$notify_in_profile" ]; then
      echo "  profile -> $name : adg-notify 已经在 node_modules 里"
    elif ! command -v dsh >/dev/null 2>&1; then
      echo "  profile -> $name : 未找到 dsh 命令，跳过 adg-notify 安装 —— 请在该 profile 里执行 dsh plugin --profile $name add file:$notify_dest" >&2
    elif (cd "$profile_dir" && dsh plugin --profile "$name" add "file:$notify_dest"); then
      echo "  profile -> $name : 已装 adg-notify"
    else
      # 宿主正在运行时 pnpm 换目录会被拒绝（os error 32 / EPERM）。这不是本插件的缺陷：
      # 按预设的"已知限制"口径如实报告 + 继续，**不要**为此杀掉 dsh 进程。
      echo "  profile -> $name : adg-notify 没装进 $profile_dir（dsh plugin add 失败）—— 关掉 dsh 后重跑本脚本" >&2
    fi
  fi

  # 4c-2. adg-permission 插件（set_child_permission）也装进这个 profile。
  # 与 4c 同形（file: 依赖 + reconcile），但它**不是**任何委派的依赖：这个工具只给调度智能体用，
  # 永远不会进子代理的工具面（delegate 的内置 deny 名单里有它）。所以漏装的后果不是派发时抛
  # names unknown global tool，而是 persona 让调度者去调一个不存在的工具 —— 同样要如实报告。
  if [ "$permission_skipped" -eq 1 ]; then
    echo "  profile -> $name : adg-permission 未部署（$permission_note）—— 调度者改子代理权限时会调到一个不存在的工具" >&2
  else
    permission_in_profile="$profile_dir/node_modules/adg-permission/package.json"
    if [ -f "$permission_in_profile" ]; then
      echo "  profile -> $name : adg-permission 已经在 node_modules 里"
    elif ! command -v dsh >/dev/null 2>&1; then
      echo "  profile -> $name : 未找到 dsh 命令，跳过 adg-permission 安装 —— 请在该 profile 里执行 dsh plugin --profile $name add file:$permission_dest" >&2
    elif (cd "$profile_dir" && dsh plugin --profile "$name" add "file:$permission_dest"); then
      echo "  profile -> $name : 已装 adg-permission"
    else
      echo "  profile -> $name : adg-permission 没装进 $profile_dir（dsh plugin add 失败）—— 关掉 dsh 后重跑本脚本" >&2
    fi
  fi

  # 4c-1. 写完之后**读回来断言** adg-notify 的三件事，缺一就不算装好：
  #   ① 包真在 node_modules 里（解析得到）；② dependencies 里有它；③ dsh.profile.bundles 里有它。
  # 只满足其中一部分是最坏的情况：bundle 装了、插件没装时委派里的 notify_user 会被剔成
  # "未生效"；反过来只写列表而包装不上，这个 profile 启动就先报错。
  # 断言读的是刚落盘的文件，不信任任何上一步的返回值。
  if [ "$notify_skipped" -eq 0 ]; then
    node -e '
      const fs = require("fs");
      const [manifest, pkgJson, pkgName] = process.argv.slice(1);
      let name = "";
      try { name = JSON.parse(fs.readFileSync(pkgJson, "utf8")).name; } catch { name = ""; }
      const j = JSON.parse(fs.readFileSync(manifest, "utf8"));
      const depLine = Boolean(j.dependencies && j.dependencies[pkgName]);
      const listed = Boolean(j.dsh && j.dsh.profile && (j.dsh.profile.bundles || []).includes(pkgName));
      if (name === pkgName && depLine && listed) {
        console.log("三格齐（node_modules 真目录 + dependencies + dsh.profile.bundles）");
      } else if (name === pkgName) {
        console.log("包在位，但 manifest 缺一格（dependencies=" + depLine + " / dsh.profile.bundles=" + listed + "）—— 手工补上再重启");
      } else {
        console.log("包不在 node_modules 里（或 package.json 读不出名字）");
      }' "$manifest" "$notify_in_profile" adg-notify \
      | while IFS= read -r notify_verdict; do
          echo "  profile -> $name : adg-notify $notify_verdict"
        done
  fi

  # 4c-3. 读回来断言 adg-permission 的三格（同 4c-1 的口径与理由）。
  if [ "$permission_skipped" -eq 0 ]; then
    node -e '
      const fs = require("fs");
      const [manifest, pkgJson, pkgName] = process.argv.slice(1);
      let name = "";
      try { name = JSON.parse(fs.readFileSync(pkgJson, "utf8")).name; } catch { name = ""; }
      const j = JSON.parse(fs.readFileSync(manifest, "utf8"));
      const depLine = Boolean(j.dependencies && j.dependencies[pkgName]);
      const listed = Boolean(j.dsh && j.dsh.profile && (j.dsh.profile.bundles || []).includes(pkgName));
      if (name === pkgName && depLine && listed) {
        console.log("三格齐（node_modules 真目录 + dependencies + dsh.profile.bundles）");
      } else if (name === pkgName) {
        console.log("包在位，但 manifest 缺一格（dependencies=" + depLine + " / dsh.profile.bundles=" + listed + "）—— 手工补上再重启");
      } else {
        console.log("包不在 node_modules 里（或 package.json 读不出名字）");
      }' "$manifest" "$permission_in_profile" adg-permission \
      | while IFS= read -r permission_verdict; do
          echo "  profile -> $name : adg-permission $permission_verdict"
        done
  fi

  # 4c-4. adg-delegate 插件（`delegate`）也装进这个 profile。
  # 与 4c / 4c-2 同形（file: 依赖 + reconcile）。它是**唯一的委派入口**：没装它，调度者手上就没有
  # 任何开子代理的工具（preset 那条委派行的 toolName `agent` 对子代理永远关着，而调度者要用的是
  # `delegate`）。漏装不会让某次委派抛 names unknown global tool，而是"调度者想派活却没有工具"。
  if [ "$delegate_skipped" -eq 1 ]; then
    echo "  profile -> $name : adg-delegate 未部署（$delegate_note）—— 调度者手上没有任何委派工具" >&2
  else
    delegate_in_profile="$profile_dir/node_modules/adg-delegate/package.json"
    if [ -f "$delegate_in_profile" ]; then
      echo "  profile -> $name : adg-delegate 已经在 node_modules 里"
    elif ! command -v dsh >/dev/null 2>&1; then
      echo "  profile -> $name : 未找到 dsh 命令，跳过 adg-delegate 安装 —— 请在该 profile 里执行 dsh plugin --profile $name add file:$delegate_dest" >&2
    elif (cd "$profile_dir" && dsh plugin --profile "$name" add "file:$delegate_dest"); then
      echo "  profile -> $name : 已装 adg-delegate"
    else
      echo "  profile -> $name : adg-delegate 没装进 $profile_dir（dsh plugin add 失败）—— 关掉 dsh 后重跑本脚本" >&2
    fi
  fi

  # 4c-5. 读回来断言 adg-delegate 的三格（同 4c-1 / 4c-3 的口径与理由）。
  if [ "$delegate_skipped" -eq 0 ]; then
    node -e '
      const fs = require("fs");
      const [manifest, pkgJson, pkgName] = process.argv.slice(1);
      let name = "";
      try { name = JSON.parse(fs.readFileSync(pkgJson, "utf8")).name; } catch { name = ""; }
      const j = JSON.parse(fs.readFileSync(manifest, "utf8"));
      const depLine = Boolean(j.dependencies && j.dependencies[pkgName]);
      const listed = Boolean(j.dsh && j.dsh.profile && (j.dsh.profile.bundles || []).includes(pkgName));
      if (name === pkgName && depLine && listed) {
        console.log("三格齐（node_modules 真目录 + dependencies + dsh.profile.bundles）");
      } else if (name === pkgName) {
        console.log("包在位，但 manifest 缺一格（dependencies=" + depLine + " / dsh.profile.bundles=" + listed + "）—— 手工补上再重启");
      } else {
        console.log("包不在 node_modules 里（或 package.json 读不出名字）");
      }' "$manifest" "$delegate_in_profile" adg-delegate \
      | while IFS= read -r delegate_verdict; do
          echo "  profile -> $name : adg-delegate $delegate_verdict"
        done
  fi

  # 4c-6. adg-settings 插件（设置页框架）也装进这个 profile。同 4c / 4c-2 / 4c-4 形。
  # 漏装的后果最轻：只是设置里少一页「Adg 设置」—— 通知三项读不到设置文件就回落内置默认。
  if [ "$settings_skipped" -eq 1 ]; then
    echo "  profile -> $name : adg-settings 未部署（$settings_note）—— 设置里不会出现「Adg 设置」那一页" >&2
  else
    settings_in_profile="$profile_dir/node_modules/adg-settings/package.json"
    if [ -f "$settings_in_profile" ]; then
      echo "  profile -> $name : adg-settings 已经在 node_modules 里"
    elif ! command -v dsh >/dev/null 2>&1; then
      echo "  profile -> $name : 未找到 dsh 命令，跳过 adg-settings 安装 —— 请在该 profile 里执行 dsh plugin --profile $name add file:$settings_dest" >&2
    elif (cd "$profile_dir" && dsh plugin --profile "$name" add "file:$settings_dest"); then
      echo "  profile -> $name : 已装 adg-settings"
    else
      echo "  profile -> $name : adg-settings 没装进 $profile_dir（dsh plugin add 失败）—— 关掉 dsh 后重跑本脚本" >&2
    fi
  fi

  # 4c-7. 读回来断言 adg-settings 的三格（同 4c-1 / 4c-3 / 4c-5 的口径与理由）。
  if [ "$settings_skipped" -eq 0 ]; then
    node -e '
      const fs = require("fs");
      const [manifest, pkgJson, pkgName] = process.argv.slice(1);
      let name = "";
      try { name = JSON.parse(fs.readFileSync(pkgJson, "utf8")).name; } catch { name = ""; }
      const j = JSON.parse(fs.readFileSync(manifest, "utf8"));
      const depLine = Boolean(j.dependencies && j.dependencies[pkgName]);
      const listed = Boolean(j.dsh && j.dsh.profile && (j.dsh.profile.bundles || []).includes(pkgName));
      if (name === pkgName && depLine && listed) {
        console.log("三格齐（node_modules 真目录 + dependencies + dsh.profile.bundles）");
      } else if (name === pkgName) {
        console.log("包在位，但 manifest 缺一格（dependencies=" + depLine + " / dsh.profile.bundles=" + listed + "）—— 手工补上再重启");
      } else {
        console.log("包不在 node_modules 里（或 package.json 读不出名字）");
      }' "$manifest" "$settings_in_profile" adg-settings \
      | while IFS= read -r settings_verdict; do
          echo "  profile -> $name : adg-settings $settings_verdict"
        done
  fi

  # 4c-8. adg-skill-inject 插件（思考框架注入）也装进这个 profile。同 4c-6 形。
  # 漏装的后果：调度者系统提示词里没有思考框架段（静默退回"靠模型自觉"的旧状态），要如实报告。
  if [ "$inject_skipped" -eq 1 ]; then
    echo "  profile -> $name : adg-skill-inject 未部署（$inject_note）—— 调度者系统提示词里不会有思考框架段" >&2
  else
    inject_in_profile="$profile_dir/node_modules/adg-skill-inject/package.json"
    if [ -f "$inject_in_profile" ]; then
      echo "  profile -> $name : adg-skill-inject 已经在 node_modules 里"
    elif ! command -v dsh >/dev/null 2>&1; then
      echo "  profile -> $name : 未找到 dsh 命令，跳过 adg-skill-inject 安装 —— 请在该 profile 里执行 dsh plugin --profile $name add file:$inject_dest" >&2
    elif (cd "$profile_dir" && dsh plugin --profile "$name" add "file:$inject_dest"); then
      echo "  profile -> $name : 已装 adg-skill-inject"
    else
      echo "  profile -> $name : adg-skill-inject 没装进 $profile_dir（dsh plugin add 失败）—— 关掉 dsh 后重跑本脚本" >&2
    fi
  fi

  # 4c-9. 读回来断言 adg-skill-inject 的三格（同 4c-1 / 4c-3 / 4c-5 / 4c-7 的口径与理由）。
  if [ "$inject_skipped" -eq 0 ]; then
    node -e '
      const fs = require("fs");
      const [manifest, pkgJson, pkgName] = process.argv.slice(1);
      let name = "";
      try { name = JSON.parse(fs.readFileSync(pkgJson, "utf8")).name; } catch { name = ""; }
      const j = JSON.parse(fs.readFileSync(manifest, "utf8"));
      const depLine = Boolean(j.dependencies && j.dependencies[pkgName]);
      const listed = Boolean(j.dsh && j.dsh.profile && (j.dsh.profile.bundles || []).includes(pkgName));
      if (name === pkgName && depLine && listed) {
        console.log("三格齐（node_modules 真目录 + dependencies + dsh.profile.bundles）");
      } else if (name === pkgName) {
        console.log("包在位，但 manifest 缺一格（dependencies=" + depLine + " / dsh.profile.bundles=" + listed + "）—— 手工补上再重启");
      } else {
        console.log("包不在 node_modules 里（或 package.json 读不出名字）");
      }' "$manifest" "$inject_in_profile" adg-skill-inject \
      | while IFS= read -r inject_verdict; do
          echo "  profile -> $name : adg-skill-inject $inject_verdict"
        done
  fi

  node -e '
    const fs = require("fs");
    const [manifest, bundleName] = process.argv.slice(1);
    const j = JSON.parse(fs.readFileSync(manifest, "utf8"));
    j.dsh = j.dsh || {}; j.dsh.profile = j.dsh.profile || {}; j.dsh.profile.bundles = j.dsh.profile.bundles || [];
    if (j.dsh.profile.bundles.includes(bundleName)) { console.log("present"); process.exit(0); }
    fs.writeFileSync(manifest + ".bak-adg-bundle", fs.readFileSync(manifest));
    j.dsh.profile.bundles.push(bundleName);
    fs.writeFileSync(manifest, JSON.stringify(j, null, 2) + "\n");
    console.log("added");' "$manifest" "$bundle_name" \
    | while read -r verdict; do
        case "$verdict" in
          added) echo "  profile -> $name : 已把 $bundle_name 加进 dsh.profile.bundles（原文件备份 $manifest.bak-adg-bundle）" ;;
          *) echo "  profile -> $name : $bundle_name 已在 dsh.profile.bundles 里" ;;
        esac
      done
done

echo "已安装到 dsh 用户根：$root"
echo "  skill   -> $skill_note"
for gen_flavor in $gen_flavors; do
  gen_dest="$(printf '%s\n' "$bundle_dest_table" | awk -F'\t' -v want="$gen_flavor" '$1 == want { print $2 }')"
  case "$gen_flavor" in
    plain) gen_note="不带任何注入的上下文工具（源文件原样）" ;;
    bili) gen_note="调度 persona 里带 bili 的四个上下文工具说明 + compaction-basic auto: false" ;;
    save-token) gen_note="调度 persona 里带 save-token 的 save_token_expand 说明" ;;
    bili+save-token) gen_note="上述两组的并集（bili 四个上下文工具 + save_token_expand + auto: false）" ;;
    *) gen_note="" ;;
  esac
  echo "  bundle  -> $gen_dest（$gen_flavor 味道：$gen_note；生成物来自 preset/preset.yml + preset/agent.cordis.yml）"
done
# ── 稳定副本 ↔ profile 副本：逐文件核一遍，别让"新加的文件没传播"静默发生 ─────────────
# 两个副本是**逐文件**硬链接，pnpm 只在 `dsh plugin add` 时拷文件 ⇒ 往某个包里加一个新文件后，
# 重跑本脚本只更新稳定副本，已经装好的 profile 副本仍然缺那个文件 —— 表现是装载时 import 找不到
# 模块（工具整条消失 / 设置页不出现），而且没有任何提示（2026-10-08 真发生过一次）。
node -e '
const fs = require("fs"), path = require("path");
const [root, ...pairs] = process.argv.slice(1);
for (const pair of pairs) {
  const i = pair.indexOf("=");
  const pkg = pair.slice(0, i), dest = pair.slice(i + 1);
  if (!fs.existsSync(dest)) continue;
  const expected = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) { if (r !== "node_modules") walk(path.join(dir, e.name), r); }
      else if (r !== "cli.mjs") expected.push(r);
    }
  };
  walk(dest, "");
  const profilesDir = path.join(root, "profiles");
  if (!fs.existsSync(profilesDir)) continue;
  for (const name of fs.readdirSync(profilesDir)) {
    const copy = path.join(profilesDir, name, "node_modules", pkg);
    if (!fs.existsSync(copy)) continue;
    const missing = expected.filter(r => !fs.existsSync(path.join(copy, r)));
    if (missing.length) console.log("  profile -> " + name + " : " + pkg + " 的 profile 副本缺 " + missing.length + " 个文件（" + missing[0] + "…）—— 关掉 dsh 后重跑本脚本，或 dsh plugin --profile " + name + " add \"file:" + dest + "\"");
  }
}' "$root" "adg-notify=$notify_dest" "adg-permission=$permission_dest" "adg-delegate=$delegate_dest" "adg-settings=$settings_dest" "adg-skill-inject=$inject_dest"

echo "  browser -> $browser_note"
echo "  desktop -> $desktop_note"
echo "  notify  -> $notify_note（notify_user 工具；每个 profile 的安装结果见上面 profile 行）"
echo "  delegate -> $delegate_note（delegate 工具 —— 唯一的委派入口；只有调度智能体拿得到，子代理拿不到。同一枚插件还提供 ask_user —— 子代理的提问通道，可给子代理）"
echo "  permission -> $permission_note（set_child_permission 工具；只有调度智能体拿得到，子代理拿不到）"
echo "  settings -> $settings_note（设置页「Adg 设置」；通知三项——默认标题 / 响提示音 / 通知常驻——在这里改，改完立即生效）"
echo "  skill-inject -> $inject_note（框架注入：把技能文件正文注入 Adg 调度者的系统提示词，用哪一份由设置页的 skillInjectFramework 决定（thinking-framework / execution-framework，默认执行框架）；子代理是否也注入由设置页的 skillInjectSubagent 决定，默认关）"
echo ""
echo "下一步：重启 dsh，然后在新建对话里选择「Adg PTC 模式」。"
echo "（preset 走的是一条独立的 patch 层：dsh --profile <name> --dump-config 能确认它被读到，"
echo "  但只有真的新建一个会话才算挂载成功 —— 静态文件与 --dump-config 都证明不了挂载。）"
echo "（browser/ 与 desktop/ 工具链又是另一回事：用户根下的普通文件，重新跑本脚本即生效，不用重启 dsh。"
echo "  desktop 是 Windows 专用，自检：node \"$desktop_dest/cli.mjs\" profile（要真正驱动普通用户窗口，得在完全权限的会话里调它）。）"
echo "（adg-notify 插件：装了之后必须重启 dsh 才注册 —— loader 会按解析路径缓存 ES 模块。）"
echo "（adg-delegate 插件：同样要重启 dsh 才注册；它是**唯一的委派入口** —— 没装它调度者手上就没有开子代理的工具。）"
echo "（adg-permission 插件：同样要重启 dsh 才注册；它不进任何一次委派的 tools —— 只有调度智能体用。）"
echo "（adg-settings 插件：同样要重启 dsh 才注册 —— 重启后设置里才会出现「Adg 设置」；没装它只是少一页设置，通知的出厂默认照旧。）"
echo "（adg-skill-inject 插件：同样要重启 dsh 才注册 —— 重启后新建的 Adg 会话系统提示词里才有思考框架段；运行中的旧会话不补挂。它随第 1 节的技能拷贝一起工作：技能正文更新后重跑本脚本 + 重启即换。）"
if [ "$package_failed" -eq 1 ]; then
  echo ""
  echo "注意：至少有一步 pnpm 没成功，$bundle_name 可能还没装进 profile（上面的 profile 行里写明了）。" >&2
  echo "先关掉正在运行的 dsh（它占着 node_modules 里的文件，pnpm 无法重建目录），再重跑本脚本。" >&2
  exit 2
fi
#!/usr/bin/env node
// `browser/` 的唯一命令行入口。
//
// 为什么只有一个入口：浏览器自动化最容易腐化的地方是「每个任务现写一个 CDP 脚本」——
// 它们各写各的端口、profile、定位方式，登录态就是这么丢的。
// 这里把**可变的部分**收敛成参数，把**不可变的部分**收敛成默认行为：
//   · 规范 profile 固定在 `<DSH_HOME>/browser-profile`（不随工作区漂移）
//   · 默认**无头**（没有窗口、不抢焦点）；要人工介入才 `--headed` 开真窗口
//   · 实例活着就**复用**，绝不为了「干净」重启（重启会丢会话态、逼用户重新登录）；
//     唯一的例外是**显式要求**的换模式：调用方明说「要另一种模式」（`--headless` / `--headed` /
//     `ADG_BROWSER_MODE`）时，先 `closeBrowser`（优雅关、登录态落盘）再按目标模式起新的——
//     同一个 profile 同时只能有一个实例（第二个进程只会转发 URL 然后退 0）。**默认模式只决定
//     新起的实例长什么样**：不带旗标碰上活着的另一种模式实例，一律不动它。
//   · 只断开 CDP 不关浏览器；要关必须显式 `close`（那才是让登录态落盘的动作）
//
// 退出码：0 = 成功；1 = 运行期错误（浏览器没起来 / 端口不通 / 页面内抛错）；2 = 用法错误。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_PORT,
  chromeCandidates,
  detectMode,
  dshHome,
  envGet,
  findChrome,
  planLaunch,
  modeIsExplicit,
  resolveMode,
  resolvePort,
  resolveProfile,
  truncateUtf8,
} from './lib/target.mjs';
import * as cdp from './lib/cdp.mjs';
import {
  ACTION_COMMANDS,
  UsageError,
  allowedFlags,
  checkFlagScope,
  checkPageScope,
  clickSpec,
  hitScopeError,
  hoverSpec,
  intOpt,
  matchHits,
  pageTarget,
  runClick,
  runHover,
  runSelect,
  runType,
  runWaitFor,
  selectSpec,
  typeSpec,
  waitForSpec,
} from './lib/actions.mjs';

/** 换模式时等旧实例真的落下去的上限：`Browser.close` 一发就返回，进程还在退出时不能起新的。 */
const SWITCH_DOWN_WAIT_MS = 10000;

const USAGE = `用法：node cli.mjs <命令> [选项]

命令：
  launch     开浏览器（默认无头；实例活着就复用；**显式**要求另一种模式时才先优雅关掉再按目标模式重开）
  status     报端口是否活着、浏览器版本、模式、当前标签页
  tabs       只列标签页（序号 | 标题 | 地址）—— 清理前先看这个
  profile    报解析出来的 profile / 端口 / Chrome 路径 / 默认模式（排错用）
  health     一次调用报全环境读数：node 路径 + profile / 端口 / Chrome / 默认模式 + 存活探活 + 代理是否存在
  open <url> 新开一个标签页（已有同地址则复用，不重复开）
  text       读当前页的标题 / 地址 / 可见文本
  eval       在页面里求值（--js "<表达式>" 或 --file <脚本路径>）
  shot       截图（--out <png 路径> [--full]）
  click      点元素（--selector <css> [--force]）—— 用真实鼠标事件，命中自检见下
  hover      把真实指针移到元素中心（--selector <css> [--force]）—— 靠 mouseenter 展开的下拉 / 菜单用它
  type       往输入框写字（--selector <css> --text <字符串> [--clear]）
  select     选 <select> 的某一项（--selector <css> --value <值>）
  wait-for   等条件成立（--selector <css> [--visible] | --url-match <子串> | --js "<表达式>"）
  close-tab  关掉标签页：--match <子串> 关掉所有匹配的，--tab <n> 关那一个
  close      优雅关闭浏览器（登录态落盘的唯一可靠动作）

通用选项：
  --port <n>       调试端口（默认 ${DEFAULT_PORT}，或环境变量 ADG_BROWSER_PORT）
  --profile <dir>  profile 目录（默认 <DSH_HOME>/browser-profile，或 ADG_BROWSER_PROFILE）
  --headless       无头模式（**默认**）：没有窗口、不抢焦点，日常抓取与自动化用它
  --headed         有头模式：开一个真窗口，需要人工登录 / 过验证时才用
  --url <u>        launch/open 可重复（要打开的地址）；text/eval/shot 用它指定**要读的完整地址**
                   （同地址已有页就复用，没有就临时开一个、读完收走；要留着加 --keep）
                   动作命令（click/hover/type/select/wait-for）用它按地址**子串**命中来唯一化目标页 ——
                   与 --match 是同一条路，都不要求完整地址；命中多页直接拒发
  --match <子串>   按 url / title 子串选页；close-tab 用它关掉所有匹配的页
  --tab <n>        按序号选页（0 起）；close-tab 用它关那一个
  --out <file>     text 写正文到文件；shot 指定 png 路径
  --max-bytes <n>  text 只把正文前 n 个 UTF-8 字节写到 stdout（默认 0 = 不截断；n 以上照旧是
                   BYTES=/FULL_BYTES= 两个读数：BYTES= 是这次真写出去的字节数、FULL_BYTES= 是正文
                   原本的字节数，截断时另打 TRUNCATED=true）。与 --out 不能合用（--out 一律写完整正文）
  --wait <秒>      launch 等待端口起来的秒数（默认 30）
  --full           shot 截整页
  --keep           text/eval/shot --url 为读新地址而开的**临时标签**默认读完就关，加这个保留它

动作选项（click / hover / type / select / wait-for 共用）：
  --selector <css>  要操作的元素（动作命令必给；wait-for 也可以只用它当条件）
  --text <字符串>   type 要写入的字（允许中文；空字符串会被拒 —— 区分不了"没生效"）
  --value <值>      select 要选中的 <option> 的 value（必须在选项里，否则拒发）
  --clear           type：先选中目标里的现有内容再写（等价于人先全选后输入）
  --force           click / hover：命中自检说"点在别的东西上"时仍然照原样发（默认拒发）
  --visible         wait-for：用 --selector 时要求元素可见（不只是存在于 DOM）
  --url-match <s>   wait-for：等地址里出现这个子串
  --js "<表达式>"   wait-for：等这个表达式为真（抛错当作"还没成立"）；eval 也用这个开关
  --timeout <ms>    wait-for 的上限（默认 10000）—— 超时是"没等到"的确定读数（WAIT=timeout）
  --interval <ms>   wait-for 的轮询间隔（默认 200）
  --settle <ms>     动作后等页面稳定下来的毫秒数（默认 150），之后才取 AFTER 读数

动作命令的成败判据（**调用返回不是证据**）：
  动作前后各取一次 DOM 可观测状态（url / title / DOM 文本 / 滚动 / 焦点 / 目标元素的状态），
  比对后打一行 CHANGED=true|false|unknown：
    true    前后有可观测差异 —— 这是唯一能证明"动作生效了"的读数
    false   前后都读到了、而且都没变（配上 REASON= 说明比了哪几类）—— 注意 false 只说明
            "本次判据覆盖到的几类没有差异"，不等于"动作没生效"
    unknown "这类效果本次看不见"（探针没读成 / 该命令专属的那几类在前后**任何一侧**读不到 ——
            "读没了"不是"没变"）—— 它**绝不许**被读成 false；WARN= 那行会写清这次看不清什么
  配合读 BEFORE= / AFTER=（两次状态摘要）与 REASON= / WARN=。要证明效果，请自己再读一次页面
  （text / eval）—— 判据只负责说清"看得见的变化有没有"，不替你下"任务完成"的结论。

模式：默认无头（"--headless=new"；也可用环境变量 ADG_BROWSER_MODE 全局指定，非法值直接报错）。
碰上登录墙 / 验证码 / 反爬挑战页才用 --headed 开真窗口 —— 人要进去操作。两种模式共用一个
profile：launch --headed 会先把无头实例**优雅关掉**（登录态落盘）再开有头窗口，端口与 profile
都不变；反过来也一样。**不带旗标时默认模式只决定新起的实例**：活着的实例是另一种模式也**不动它**
（输出 STATE=REUSED / MODE=<实际模式> + 一行说明），换模式必须显式要求（旗标或 ADG_BROWSER_MODE）
—— 否则子代理最常打的那条 bare launch 会关掉用户正在登录的窗口。模式不用猜：status 的 MODE= 是从
活着那个实例的 CDP User-Agent 读出来的（headless / headed / unknown；没在跑时 MODE=none）。

标签页卫生：open / launch 开的页会留着（给用户看或后续继续用）；
text / eval / shot --url <新地址> 只是"来读一次"，读完整条命令自己开的临时标签会被收走，
所以一次性抓取不会留下页。存量清理用 close-tab（它拒绝关到只剩 0 个页面 —— 那等于关浏览器）。

例：
  node cli.mjs launch --url "https://example.com"
  node cli.mjs launch --headed --url "https://example.com/login"
  node cli.mjs text --url "https://example.com/a" --out "$env:TEMP\\page.txt"
  node cli.mjs eval --file .\\probe.js --match example.com
  node cli.mjs close-tab --match hotels.ctrip.com
  node cli.mjs click --selector "#submit" --match example.com
  node cli.mjs type --selector "input[name=q]" --text "水壶" --clear
  node cli.mjs select --selector "#city" --value sh
  node cli.mjs wait-for --selector "#result" --visible --timeout 5000
  node cli.mjs close
`;

// 用法错误用 lib/actions.mjs 里的那一个（退出码 2 的判定靠它 instanceof —— 动作层也抛同一个类）。

function parseArgs(argv) {
  const out = { _: [], urls: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--url') {
      const v = argv[i + 1];
      if (v === undefined) throw new UsageError('--url 后面缺少值');
      out.urls.push(v);
      i += 1;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
      continue;
    }
    out._.push(a);
  }
  return out;
}

const print = (...parts) => process.stdout.write(`${parts.join(' ')}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等端口真的落下去。优雅关闭是异步的：`Browser.close` 一发出就返回，进程还在退出中。 */
async function waitPortDown(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await cdp.isAlive(port, { timeoutMs: 1500 }))) return true;
    await sleep(400);
  }
  return !(await cdp.isAlive(port, { timeoutMs: 1500 }));
}

async function requireAlive(port) {
  if (!(await cdp.isAlive(port, { timeoutMs: 2500 }))) {
    throw new Error(`端口 ${port} 上没有运行中的浏览器；先跑 node cli.mjs launch`);
  }
}

async function printTabs(port) {
  const picked = cdp.pickPage(await cdp.listTargets(port), {});
  print(`TABS=${picked.pages.length}`);
  picked.pages.forEach((t, i) => print(`TAB ${i} | ${t.title ?? ''} | ${t.url ?? ''}`));
}

/** 已经有同地址的标签就复用，没有才新开——避免每次操作都堆一个重复标签页。 */
async function ensureOpen(port, url) {
  const targets = await cdp.listTargets(port).catch(() => []);
  const hit = (Array.isArray(targets) ? targets : []).find(
    (t) => t.type === 'page' && String(t.url ?? '') === url,
  );
  if (hit) {
    print(`TAB_EXISTS=${url}`);
    return;
  }
  await cdp.createTarget(port, url);
  print(`TAB_OPENED=${url}`);
  await sleep(600);
}

/** 解析出 text / eval / shot 要操作的那一页：`--url` 是**要读的完整地址** —— 同地址已有页就复用（精确比 `===`），没有就以它新开一个临时页。 */
async function sessionFor(port, args) {
  const url = args.urls[0];
  let opts = { index: args.tab === undefined ? undefined : Number(args.tab), match: args.match };
  let created = false;
  if (url) {
    const targets = await cdp.listTargets(port).catch(() => []);
    const hit = (Array.isArray(targets) ? targets : []).find(
      (t) => t.type === 'page' && String(t.url ?? '') === url,
    );
    opts = hit ? { match: hit.url } : { newUrl: url };
    created = !hit;
  }
  const session = await cdp.pageSession(port, opts);
  return { session, created: created || session.created === true };
}

/**
 * 动作命令要操作的那一页：**只连既有页面，绝不开新页**。
 * 动作是"对现在这一页做点事"，静默开一个空白页等于让调用方对着空气点 —— 那会得到一个
 * 没有报错的空动作（正是判据要防的那类坑）。选页方式与 text / eval / shot 一致
 * （`--url` / `--match` / `--tab`），都没给就是 0 号页；给了多个或非法值由
 * `checkPageScope` / `pageTarget` 报用法错（退出码 2）。
 */
async function actionSession(port, args) {
  const target = pageTarget(args);
  if ('match' in target) {
    // I17：命中多页就拒发 —— 动作会改到那一页上，而调用方从输出里看不出选错了哪一页。
    // 文案由 `hitScopeError` 出，它带的是**实际给的那个开关名**（`--url` 给的就写 `--url`）。
    const picked = cdp.pickPage(await cdp.listTargets(port), {});
    const hits = matchHits(picked.pages, target.match);
    if (hits.length > 1) throw new UsageError(hitScopeError(target.flag, target.match, hits.length));
  }
  const opts = 'match' in target ? { match: target.match } : { index: target.index };
  return cdp.pageSession(port, opts);
}

/**
 * 一次性读取命令的收尾：断开 CDP，并且**只收走本命令自己开的临时标签**（design.md I10）。
 * 别人开的页一律不碰（那可能是用户正在登录的窗口）；`--keep` 明确要留就不关。
 */
async function closeTempTab(port, created, session, keep) {
  const id = session.target?.id;
  session.close();
  if (!created || keep || !id) return;
  try {
    await cdp.closeTarget(port, id);
    print(`TAB_CLOSED=${id}`);
    print('HINT=这是一次性读取自己开的临时标签，读完就收走了；要保留它加 --keep');
  } catch (e) {
    print(`TAB_CLOSE_FAILED=${e?.message ?? String(e)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || cmd === 'help' || args.help) {
    print(USAGE);
    return;
  }

  // 分发**之前**卡一道开关闸门：每条命令只认识自己用得上的开关。理由与 desktop 红线 18 同源 ——
  // 静默忽略一个打错的开关，调用方会以为"它照我说的做了"（例如 `click --selector x --dryrun`）。
  if (allowedFlags(cmd) === null) throw new UsageError(`不认识命令：${cmd}`);
  checkFlagScope(args, cmd);
  checkPageScope(args, cmd);

  const port = resolvePort({ port: args.port });
  const profile = resolveProfile({ profile: args.profile });

  if (cmd === 'profile') {
    const chrome = findChrome();
    print(`DSH_HOME=${dshHome()}`);
    print(`PROFILE=${profile}`);
    print(`PROFILE_EXISTS=${fs.existsSync(profile)}`);
    print(`PORT=${port}`);
    print(`CHROME=${chrome ?? 'NOT_FOUND'}`);
    print(`DEFAULT_MODE=${resolveMode()}`);
    const legacy = path.resolve(process.cwd(), '.browser-profile');
    if (legacy !== path.resolve(profile) && !fs.existsSync(profile) && fs.existsSync(legacy)) {
      print(`HINT=本工作区里有旧 profile：${legacy}；想沿用它就加 --profile "${legacy}"（不要复制）`);
    }
    return;
  }

  // 环境读数一次给全：`profile` 的那 6 行 + node 路径 + 一次纯 HTTP 探活 + 代理**是否存在**。
  // 刻意不报：真实 `MODE=`（那要读活着实例的 CDP User-Agent，只有 status 报）、`TABS=`（会建 CDP 会话）。
  // 探活复用 `cdp.isAlive`（对 CDP 端点的纯 HTTP 读数）—— 这条命令**不 spawn 浏览器、不落盘任何状态**。
  if (cmd === 'health') {
    const chrome = findChrome();
    print(`NODE=${process.execPath}`);
    print(`DSH_HOME=${dshHome()}`);
    print(`PROFILE=${profile}`);
    print(`PROFILE_EXISTS=${fs.existsSync(profile)}`);
    print(`PORT=${port}`);
    print(`CHROME=${chrome ?? 'NOT_FOUND'}`);
    print(`DEFAULT_MODE=${resolveMode()}`);
    print(`ALIVE=${await cdp.isAlive(port, { timeoutMs: 2500 })}`);
    // 代理只报存在性：值里常带凭据 / 内网地址，一条排错命令不该把它回显进日志。
    const proxyNames = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'];
    const proxySet = proxyNames.filter((n) => envGet(process.env, n) !== undefined);
    print(`PROXY_SET=${proxySet.length > 0}`);
    print(`PROXY_SOURCE=${proxySet.length > 0 ? proxySet.join(',') : 'none'}`);
    if (proxySet.length > 0) print('HINT=代理变量只报是否存在，值一律不回显');
    return;
  }

  if (cmd === 'launch') {
    const urls = args.urls.slice();
    const waitSec = Number(args.wait ?? 30);
    if (!Number.isFinite(waitSec) || waitSec <= 0) throw new UsageError('--wait 必须是正数秒');
    if (args.headless && args.headed) throw new UsageError('--headless 与 --headed 不能同时给');
    const modeFlag = args.headless === true ? 'headless' : args.headed === true ? 'headed' : undefined;
    const mode = resolveMode({ mode: modeFlag });
    // 换模式只认**显式**要求（旗标或 ADG_BROWSER_MODE）：默认值不许拿活着的实例开刀（I4 ③）。
    const modeExplicit = modeIsExplicit({ mode: modeFlag });
    const alive = await cdp.isAlive(port, { timeoutMs: 2500 });
    const chrome = findChrome();
    const version = alive ? await cdp.version(port).catch(() => null) : null;
    const aliveMode = alive ? detectMode(version) : null;
    const plan = planLaunch({ alive, aliveMode, chrome, profile, port, urls, mode, modeExplicit });

    if (plan.action === 'error') {
      throw new Error(
        `没找到可用的 Chrome / Edge。候选：${chromeCandidates().join(' | ')}；可用 ADG_CHROME 指定绝对路径`,
      );
    }

    if (plan.action === 'reuse') {
      print('STATE=REUSED');
      print(`MODE=${plan.aliveMode}`);
      print(`PORT=${port}`);
      print(`PROFILE=${profile}`);
      print(`BROWSER=${version?.Browser ?? 'unknown'}`);
      for (const u of urls) await ensureOpen(port, u);
      await printTabs(port);
      if (plan.modeUnverified) {
        print(`HINT=活着的实例没报出 User-Agent，无法确认它是 ${mode} 还是有头；**没有**动它。要强制换成 ${mode}：先 node cli.mjs close，再 launch`);
      } else if (plan.modeNotRequested) {
        print(`HINT=活着的是 ${plan.aliveMode} 实例；你没有显式要求模式，所以**没有**动它（默认模式只决定新起的实例长什么样）。要换成另一种模式：node cli.mjs launch --headed 或 --headless`);
      } else if (plan.aliveMode === 'headless') {
        print('HINT=复用了一个无头实例（没有窗口）；需要人工登录 / 过验证时用 node cli.mjs launch --headed —— 它会先优雅关掉这个实例再开有头窗口，端口与 profile 不变');
      } else {
        print('HINT=复用了既有实例；登录态在它内存与这个 profile 里，不要重启它');
      }
      return;
    }

    // 换模式：先优雅关掉另一种模式的实例（`Browser.close` 会让登录态落盘），再起目标模式。
    // 不在这里强杀进程 —— 强杀跳过落盘；也不静默换掉 unknown 的活实例（planLaunch 把它归为复用）。
    let switchedFrom = null;
    if (plan.action === 'switch') {
      await cdp.closeBrowser(port);
      if (!(await waitPortDown(port, SWITCH_DOWN_WAIT_MS))) {
        throw new Error(
          `端口 ${port} 上的 ${plan.aliveMode} 实例在 ${SWITCH_DOWN_WAIT_MS / 1000}s 内没有退出；` +
            '**没有**强杀进程（强杀会跳过登录态落盘）。稍后重试，或先 node cli.mjs status 看它是否还活着',
        );
      }
      switchedFrom = plan.aliveMode;
      print(`SWITCHED_FROM=${switchedFrom}`);
      print('CLOSED=true');
    }

    fs.mkdirSync(profile, { recursive: true });

    // 启动 + 有界重试。转交签名很明确：**exit=0 且端口从未起来** —— 同一个 profile 上还活着的
    // 实例接走了启动请求、新进程自己干净退出（同一个 profile 同时只能有一个实例）。只有这个
    // 签名才重试；退出码非 0（例如沙箱失败）立即如实报错，绝不重试掩盖。
    // 规定：`switch` 启动时**必须**带 args。理由：不带 args 时 `spawn(chrome, undefined)` 会以
    // **空参数**启动浏览器 —— 那是用户自己的默认 profile，请求被转交给用户日常那个实例：端口
    // 永远不起来、每次都 exit=0，用户侧还多出一堆窗口。下面这道闸门不是装饰。
    if (!Array.isArray(plan.args) || plan.args.length === 0) {
      throw new Error('没有构造出启动参数；拒绝用空参数启动浏览器（那会去动用户自己的默认 profile）');
    }
    const maxStarts = 3;
    let up = false;
    let lastExit = null;
    for (let attempt = 1; attempt <= maxStarts && !up; attempt += 1) {
      const child = spawn(plan.chrome, plan.args, { detached: true, stdio: 'ignore' });
      let spawnError = null;
      let exitCode = null;
      child.on('error', (e) => {
        spawnError = e;
      });
      child.on('exit', (code) => {
        exitCode = code;
      });
      child.unref();

      const deadline = Date.now() + Math.max(1, waitSec) * 1000;
      while (Date.now() < deadline) {
        if (spawnError) throw new Error(`启动浏览器失败：${spawnError.message}`);
        up = await cdp.isAlive(port, { timeoutMs: 2000 });
        if (up || exitCode !== null) break;
        await sleep(700);
      }
      lastExit = exitCode;
      if (up) break;
      if (exitCode === 0 && attempt < maxStarts) {
        print('RETRY=1');
        print('HINT=新进程把启动请求转交给了同一个 profile 上还活着的实例（单例锁没放开），它自己退 0；等它退干净再试');
        await sleep(1200);
      } else {
        break;
      }
    }
    if (!up) {
      throw new Error(
        `启动后 127.0.0.1:${port} 没有起来（CHROME=${plan.chrome} PROFILE=${profile} exit=${lastExit}）；` +
          '先看 node cli.mjs status 确认没有旧实例捏着这个 profile，再重试',
      );
    }

    print(`STATE=${switchedFrom ? 'SWITCHED' : 'STARTED'}`);
    print(`MODE=${mode}`);
    print(`CHROME=${plan.chrome}`);
    print(`PORT=${port}`);
    print(`PROFILE=${profile}`);
    print(`BROWSER=${(await cdp.version(port).catch(() => ({}))).Browser ?? 'unknown'}`);
    await printTabs(port);
    if (mode === 'headless') {
      print('HINT=这是无头实例（没有窗口）；需要人工登录 / 过验证时用 node cli.mjs launch --headed —— 先优雅关掉它再开有头窗口，登录态留在同一个 profile');
    } else {
      print('HINT=这是有头窗口，用户可以直接在里面登录 / 过验证；不要关掉它');
    }
    if (switchedFrom) print(`HINT=上一个 ${switchedFrom} 实例已优雅关闭，登录态已落盘到 ${profile}`);
    return;
  }

  if (cmd === 'status') {
    const alive = await cdp.isAlive(port, { timeoutMs: 2500 });
    print(`ALIVE=${alive}`);
    print(`PORT=${port}`);
    print(`PROFILE=${profile}`);
    print(`DEFAULT_MODE=${resolveMode()}`);
    if (!alive) {
      print('MODE=none');
      print('HINT=浏览器没在跑；用 node cli.mjs launch 开一个（默认无头），需要人工登录 / 过验证时加 --headed');
      return;
    }
    const version = await cdp.version(port).catch(() => null);
    print(`BROWSER=${version?.Browser ?? 'unknown'}`);
    print(`MODE=${detectMode(version)}`);
    await printTabs(port);
    return;
  }

  if (cmd === 'tabs') {
    await requireAlive(port);
    await printTabs(port);
    print('HINT=清理存量用 node cli.mjs close-tab --match <子串>（或 --tab <n> 关一个）');
    return;
  }

  if (cmd === 'open') {
    const url = args._[1] ?? args.urls[0];
    if (!url) throw new UsageError('open 需要 URL：node cli.mjs open <url>');
    await requireAlive(port);
    await ensureOpen(port, url);
    await printTabs(port);
    return;
  }

  if (cmd === 'close-tab') {
    await requireAlive(port);
    const picked = cdp.pickTabsToClose(await cdp.listTargets(port), {
      match: args.match,
      tab: args.tab,
    });
    if (picked.reason) throw new Error(picked.reason);
    for (const t of picked.targets) {
      await cdp.closeTarget(port, t.id);
      print(`TAB_CLOSED=${t.title ?? ''} | ${t.url ?? ''}`);
    }
    print(`CLOSED_TABS=${picked.targets.length}`);
    await sleep(300);
    await printTabs(port);
    return;
  }

  if (cmd === 'close') {
    if (!(await cdp.isAlive(port, { timeoutMs: 2500 }))) {
      print('ALIVE=false');
      print('CLOSED=already');
      return;
    }
    await cdp.closeBrowser(port);
    for (let i = 0; i < 20; i += 1) {
      if (!(await cdp.isAlive(port, { timeoutMs: 1500 }))) break;
      await sleep(500);
    }
    print(`ALIVE=${await cdp.isAlive(port, { timeoutMs: 1500 })}`);
    print('CLOSED=true');
    print(`HINT=优雅关闭，登录态已落盘到 ${profile}；下次 launch 会带着它回来`);
    return;
  }

  if (cmd === 'text') {
    await requireAlive(port);
    const maxBytes = intOpt(args, 'max-bytes', 0, 0, 100 * 1024 * 1024, 'text');
    if (maxBytes > 0 && args.out) throw new UsageError('--max-bytes 与 --out 不能合用：--out 一律写完整正文');
    const { session, created } = await sessionFor(port, args);
    try {
      const t = await session.text();
      const body = String(t.body ?? '');
      const cut = truncateUtf8(body, maxBytes);
      print(`TITLE=${t.title ?? ''}`);
      print(`URL=${t.url ?? ''}`);
      print(`BYTES=${cut.bytes}`);
      print(`FULL_BYTES=${cut.fullBytes}`);
      print(`TRUNCATED=${cut.body !== body}`);
      if (args.out) {
        const abs = path.resolve(String(args.out));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body, 'utf8');
        print(`OUT=${abs}`);
      } else {
        print('---BODY---');
        process.stdout.write(`${cut.body}\n`);
      }
    } finally {
      await closeTempTab(port, created, session, args.keep);
    }
    return;
  }

  if (cmd === 'eval') {
    await requireAlive(port);
    let expr = args.js;
    if (args.file) expr = fs.readFileSync(path.resolve(String(args.file)), 'utf8');
    if (typeof expr !== 'string' || expr.trim() === '') {
      throw new UsageError('eval 需要 --js "<表达式>" 或 --file <脚本路径>');
    }
    const { session, created } = await sessionFor(port, args);
    try {
      const value = await session.evalJs(expr);
      print(`RESULT=${value === undefined ? 'undefined' : JSON.stringify(value, null, 2)}`);
    } finally {
      await closeTempTab(port, created, session, args.keep);
    }
    return;
  }

  if (ACTION_COMMANDS.includes(cmd)) {
    // 参数先判完再碰浏览器：用法错（2）不该依赖"浏览器在不在"—— 参数打错了，
    // 报"端口上没有浏览器"会把调用方引到完全错误的方向。
    const spec =
      cmd === 'click'
        ? clickSpec(args)
        : cmd === 'hover'
          ? hoverSpec(args)
          : cmd === 'type'
            ? typeSpec(args)
            : cmd === 'select'
              ? selectSpec(args)
              : waitForSpec(args);
    await requireAlive(port);
    const session = await actionSession(port, args);
    try {
      // 五条命令共用一套前后比对（I14）：`out` 就是 stdout，一行一个 KEY=value。
      // `listTabs` 让判据能看见"标签页有没有变"（点开新标签是 click 最常见的效果之一）；
      // 读不到只是 `tabs` 这一类缺测（⇒ 可能有 unknown），不会把命令搞失败。
      await { click: runClick, hover: runHover, type: runType, select: runSelect, 'wait-for': runWaitFor }[cmd]({
        session,
        spec,
        out: print,
        listTabs: () => cdp.listTargets(port),
      });
    } finally {
      // 只断 CDP：动作命令不开新页，所以没有"自己开的临时页"要收（I10）；也**不许**关浏览器（I6）。
      session.close();
    }
    return;
  }

  if (cmd === 'shot') {
    await requireAlive(port);
    if (!args.out) throw new UsageError('shot 需要 --out <png 路径>');
    const { session, created } = await sessionFor(port, args);
    try {
      const abs = await session.shot(String(args.out), { full: Boolean(args.full) });
      print(`SHOT=${abs}`);
      const t = await session.text().catch(() => ({}));
      print(`URL=${t.url ?? ''}`);
    } finally {
      await closeTempTab(port, created, session, args.keep);
    }
    return;
  }

  throw new UsageError(`不认识命令：${cmd}`);
}

main().catch((err) => {
  if (err instanceof UsageError) {
    process.stderr.write(`ERROR=${err.message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  process.stderr.write(`ERROR=${err?.message ?? String(err)}\n`);
  process.exit(1);
});
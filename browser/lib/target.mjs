// `browser/` 的纯函数层：把「这次要驱动哪个浏览器」解析成确定的值 ——
// profile 目录、调试端口、浏览器可执行文件、启动参数，以及「该复用还是该启动」的决策。
//
// 本文件不 spawn、不联网、不读真实文件系统（`exists` / `fsImpl` 都是可注入的），
// 所以 `test/browser.test.mjs` 能零依赖、零副作用地钉住 design.md 的 I1..I3
// （profile 来源 / 禁伪装降权旗标 / 非法端口不静默回落）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 固定的调试端口。换端口等于换一个「浏览器实例」的身份，见 design.md I3。 */
export const DEFAULT_PORT = 9333;

/** 规范 profile 的目录名（固定在 DSH 用户根下，与任何工作区无关）。 */
export const PROFILE_DIRNAME = 'browser-profile';

/**
 * 两种模式。**默认无头**：日常抓取不弹窗、不抢焦点，
 * 只有碰到登录墙 / 验证码 / 反爬挑战页时才升级到有头窗口（人要进去操作）。
 */
export const MODES = ['headless', 'headed'];
export const MODE_DEFAULT = 'headless';

/**
 * 无头开关。两种模式用**同一组参数**都能起 CDP，无头**不需要** `--no-sandbox` ——
 * 所以这个旗标不违反 design.md I2。
 */
export const HEADLESS_FLAG = '--headless=new';

/** Windows 的 env 键大小写不敏感，这里统一按小写名查找。 */
export function envGet(env, name) {
  if (env == null) return undefined;
  const want = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === want && env[key] != null && env[key] !== '') return env[key];
  }
  return undefined;
}

/**
 * 把文本截到最多 `max` 个 UTF-8 字节（**不切碎多字节字符**）。返回 `{ body, bytes, fullBytes }`：
 * `bytes` 是这次真写出去的字节数、`fullBytes` 是文本原本的字节数。`max <= 0` = 不截断。
 *
 * 纯函数（只依赖 `Buffer`），所以放在这一层：`text --max-bytes` 的体积读数靠它，
 * 而"截在哪里"要有单测钉住 —— `cli.mjs` 不再导出任何东西（见 design.md 的「库接口」）。
 */
export function truncateUtf8(text, max) {
  const buf = Buffer.from(text, 'utf8');
  if (!(max > 0) || buf.length <= max) return { body: text, bytes: buf.length, fullBytes: buf.length };
  let end = max;
  // 切点正好落在多字节字符**里面**（该字符的首字节在 `end` 之前、续字节还没完）时，退回到它的首字节。
  if ((buf[end] & 0xc0) === 0x80) {
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  } else if (end > 0 && (buf[end - 1] & 0xc0) === 0xc0) {
    end -= 1;
  }
  return { body: buf.subarray(0, end).toString('utf8'), bytes: end, fullBytes: buf.length };
}

/** DSH 用户根：`DSH_HOME` 优先，缺省 `~/.dsh`。 */
export function dshHome(env = process.env, home = os.homedir()) {
  const raw = envGet(env, 'DSH_HOME');
  if (raw) return path.resolve(raw);
  return path.join(home, '.dsh');
}

/**
 * 规范 profile 路径。优先级：显式 `--profile` > `ADG_BROWSER_PROFILE` > `<DSH_HOME>/browser-profile`。
 * 从不回落成「工作区里的相对目录」—— 那会让登录态随工作区漂移（design.md I1）。
 */
export function resolveProfile(opts = {}) {
  const { profile, env = process.env, home = os.homedir(), cwd = process.cwd() } = opts;
  if (typeof profile === 'string' && profile.trim()) return path.resolve(cwd, profile.trim());
  const fromEnv = envGet(env, 'ADG_BROWSER_PROFILE');
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(dshHome(env, home), PROFILE_DIRNAME);
}

/** 调试端口：显式 > `ADG_BROWSER_PORT` > 默认。非法值直接抛（不要静默回落）。 */
export function resolvePort(opts = {}) {
  const { port, env = process.env } = opts;
  const raw = port == null || port === '' ? (envGet(env, 'ADG_BROWSER_PORT') ?? DEFAULT_PORT) : port;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`调试端口不合法：${String(raw)}`);
  return n;
}

/**
 * 浏览器模式：显式 `--headless` / `--headed` > `ADG_BROWSER_MODE` > 默认无头。
 * 非法值直接抛 —— 静默回落会让调用方以为自己在用另一种模式（与 I4 同口径）。
 */
export function resolveMode(opts = {}) {
  const { mode, env = process.env } = opts;
  const raw = mode == null || mode === '' ? (envGet(env, 'ADG_BROWSER_MODE') ?? MODE_DEFAULT) : mode;
  const v = String(raw).trim().toLowerCase();
  if (!MODES.includes(v)) throw new Error(`浏览器模式不合法：${String(raw)}（只能是 headless 或 headed）`);
  return v;
}

/**
 * 目标模式是不是**显式**要求的（单次 `--headless` / `--headed`，或 `ADG_BROWSER_MODE`）。
 *
 * 只有显式要求才允许换掉一个**活着**的实例（design.md I4 ③）：默认值只决定**新起**的实例长什么样，
 * 不许拿它去关用户正在用的窗口 —— 不带旗标的 `launch`（子代理最常打的那条命令）撞上「用户正在有头
 * 窗口里登录」就会砸掉现场，这道闸门就是为它设的。
 */
export function modeIsExplicit(opts = {}) {
  const { mode, env = process.env } = opts;
  if (mode != null && mode !== '') return true;
  const raw = envGet(env, 'ADG_BROWSER_MODE');
  return raw != null && String(raw).trim() !== '';
}

/**
 * 从 CDP `/json/version` 的 `User-Agent` 判出**已经活着**的实例是哪种模式（design.md I4）。
 *
 * 无头的 UA 带 `HeadlessChrome/…`，有头的没有这个 token ⇒ 一条 `/Headless/i` 同时认
 * Chrome / Brave / Edge，**不需要**额外的状态文件（进程是别人起的也认得出）。
 * 拿不到 UA 就报 `unknown`：不猜 —— `planLaunch` 把 unknown 当「复用、不重启」处理。
 */
export function detectMode(version) {
  const ua = typeof version?.['User-Agent'] === 'string' ? version['User-Agent'] : '';
  if (!ua) return 'unknown';
  return /Headless/i.test(ua) ? 'headless' : 'headed';
}

/**
 * 启动参数。**刻意不传** `--no-sandbox` / `--disable-blink-features=AutomationControlled` /
 * `--user-agent=` —— 对 connect-only 驱动零收益，却会让浏览器行为与用户日常浏览器不一致
 * （design.md I2：这三个旗标对 connect-only 驱动零收益，却会让浏览器行为与用户日常浏览器不一致）。
 *
 * `mode` 缺省按 `MODE_DEFAULT`（无头）解析；`headless` 时追加 `--headless=new`（I2 允许的
 * 唯一模式旗标）——它只让浏览器不画窗口，不改 UA 之外的身份、不降权、不关沙箱。
 * `--window-size` 两种模式都传：无头下没有窗口，Chrome 拿它当默认视口尺寸。
 */
export function launchArgs(opts = {}) {
  const { profile, port, urls = [], windowSize = '1500,980', lang = 'zh-CN' } = opts;
  if (!profile) throw new Error('launchArgs 需要 profile');
  const mode = resolveMode({ mode: opts.mode, env: opts.env ?? {} });
  const args = [
    `--remote-debugging-port=${resolvePort({ port })}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--lang=${lang}`,
  ];
  if (mode === 'headless') args.push(HEADLESS_FLAG);
  if (windowSize) args.push(`--window-size=${windowSize}`);
  args.push('--new-window');
  for (const u of urls) if (u) args.push(u);
  return args;
}

/**
 * 候选 Chromium 系浏览器路径，按优先级。`ADG_CHROME` 永远排第一。
 *
 * 次序是 **Chrome → Brave → Edge**。Edge 之所以排最后：它随 Windows 出厂就在，
 * 把系统自带的那个排在用户主动装的浏览器前面，会让"我机器上只有别的浏览器"的人
 * 被迫用它。Brave 与 Chrome 同属"用户主动安装的 Chromium 系浏览器"，两者都只用标准位置探测，不写死任何本机路径。
 * 要指定别的可执行文件（或压过这个次序）就用 `ADG_CHROME=<绝对路径>`。
 */
export function chromeCandidates(env = process.env, platform = process.platform) {
  const out = [];
  const override = envGet(env, 'ADG_CHROME');
  if (override) out.push(override);
  if (platform === 'win32') {
    for (const key of ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA']) {
      const base = envGet(env, key);
      if (!base) continue;
      out.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      out.push(path.join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
      out.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (platform === 'darwin') {
    out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    out.push('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
    out.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    out.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/brave-browser',
      '/usr/bin/brave-browser-stable',
      '/opt/brave.com/brave/brave-browser',
      '/usr/bin/microsoft-edge',
    );
  }
  return out;
}

/** 第一个真实存在的候选；都没有就返回 null（由调用方决定报错口径）。 */
export function findChrome(opts = {}) {
  const {
    env = process.env,
    platform = process.platform,
    exists = (p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    },
  } = opts;
  for (const p of chromeCandidates(env, platform)) if (exists(p)) return p;
  return null;
}

/**
 * 「复用 / 换模式 / 启动」的决策（纯函数）。
 *
 * **同模式一律复用**：实例还活着时绝不重启 —— 重启会丢掉内存里的会话态，也让用户不得不
 * 重新登录（design.md I5）。**另一种模式是例外、且必须是显式请求**（换模式必须先优雅关掉旧实例
 * （`Browser.close`，登录态落盘）再按目标模式起新的）—— 因为同一个 profile 同时只能有一个实例，第二个进程
 * 只会把 URL 转发给活着的那个、自己退 0（形态：`exit 0` + 无 CDP 端点）。
 *
 * **没有显式要求模式时，活着的实例一律不动**（`modeNotRequested`）：解析出来的默认模式只决定
 * **新起**的实例长什么样 —— 否则子代理最常打的那条不带旗标的 `launch` 会顺手把用户正在登录的
 * 有头窗口关掉重开（I4 ③ 与「人不在场不许关有头窗口」那条非功能红线）。
 *
 * **`switch` 与 `start` 一样必须给出 `args`**：调用方无条件 `spawn(chrome, plan.args)`，而
 * `spawn(chrome, undefined)` 是"不带任何参数启动浏览器" —— 那等于启动用户**自己的默认 profile**，
 * 请求会被转交给用户日常那个实例（形态：换模式一直 exit=0、端口从未起来，用户侧还多出一堆窗口）。
 * `args` 是 `planLaunch` 的契约，不是可选装饰。
 *
 * `aliveMode` 来自 `detectMode`：`unknown`（拿不到 UA）**按复用处理** —— 不认识的活实例
 * 不许被静默换掉。
 */
export function planLaunch(opts = {}) {
  const { alive, aliveMode, chrome, profile, urls = [] } = opts;
  const p = resolvePort({ port: opts.port });
  const mode = resolveMode({ mode: opts.mode, env: opts.env ?? {} });
  if (!profile) throw new Error('planLaunch 需要 profile');
  if (alive) {
    const current = aliveMode ?? 'unknown';
    const base = { mode, aliveMode: current, profile, port: p, chrome: chrome ?? null };
    if (current === mode) return { action: 'reuse', ...base };
    if (current === 'unknown') return { action: 'reuse', ...base, modeUnverified: true };
    // 目标模式只是**默认值**、调用方没有显式要求 → 活着的实例绝不因此被动过（I4 ③）。
    const explicit = opts.modeExplicit ?? modeIsExplicit({ mode: opts.mode, env: opts.env ?? {} });
    if (!explicit) return { action: 'reuse', ...base, modeNotRequested: true };
    // 换模式要起一个新进程，所以没有 chrome 就没有可执行的东西（不能落到空参数启动）。
    if (!chrome) return { action: 'error', reason: 'CHROME_NOT_FOUND', mode, profile, port: p };
    return { action: 'switch', ...base, args: launchArgs({ profile, port: p, urls, mode }) };
  }
  if (!chrome) return { action: 'error', reason: 'CHROME_NOT_FOUND', mode, profile, port: p };
  return { action: 'start', mode, profile, port: p, chrome, args: launchArgs({ profile, port: p, urls, mode }) };
}
// 通知投递内核：把一条消息变成一次 Windows toast。
//
// 设计约束（见 design.md）：
//   - 只用 Node 内置能力，零第三方依赖、零运行时依赖；
//   - **只使用 Windows PowerShell v1.0（powershell.exe）**，不用 pwsh —— WinRT 投影只在前者里；
//   - 从不静默成功：拿不到脚本、起不来进程、超时、非零退出，一律抛可读错误；
//   - 可注入（scriptPath / powerShellPath / spawnImpl / platform），所以自测能在任何平台上钉住行为。

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本包根目录（`notify/`），由本文件位置推出，不写死任何绝对路径。 */
export const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 默认的 toast 脚本落点。 */
export const DEFAULT_SCRIPT_PATH = path.join(PACKAGE_ROOT, 'scripts', 'toast.ps1');

/** 默认的 AppId：Windows PowerShell 控制台宿主（总在、总被允许弹 toast）。 */
export const DEFAULT_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/** 默认等待 PowerShell 退出的上限。 */
export const DEFAULT_TIMEOUT_MS = 15000;

/** 默认标题。 */
export const DEFAULT_TITLE = 'DSH 通知';

/**
 * 默认存活时间：**0 = 常驻**（toast.ps1 走 `scenario="reminder"`：留在通知中心直到用户处理）。
 * 之前是 8000ms，感觉上是"弹 6 秒就没了"——需要人动手的通知不该自己消失。
 * 单次调用仍可用 `disappearAfterMs`（或环境变量 `ADG_NOTIFY_TIMEOUT_MS` 之外的入参）覆盖。
 */
export const DEFAULT_DISAPPEAR_AFTER_MS = 0;

/** 合法的 sound 值（与 toast.ps1 的 ValidateSet 一致）。 */
export const SOUND_VALUES = ['default', 'silent'];

/**
 * Windows PowerShell v1.0 的规范路径，退化为裸 `powershell.exe` 交给 PATH。
 * @returns {string} 可执行文件路径（存在性由调用方检查）
 */
export function resolvePowershellPath() {
  const systemRoot = process.env.SystemRoot || process.env.windir;
  if (typeof systemRoot === 'string' && systemRoot.length > 0) {
    const candidate = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existsSync(candidate)) return candidate;
  }
  return 'powershell.exe';
}

/**
 * 把一条消息规整成「标题 / 正文 / 存活毫秒 / 声音」，并做参数校验。
 * @param {{message?: unknown, title?: unknown, silent?: unknown, disappearAfterMs?: unknown}} input
 * @returns {{title: string, body: string, disappearAfterMs: number, sound: string}}
 */
export function normalizeNotification(input = {}) {
  const rawMessage = input.message;
  if (typeof rawMessage !== 'string') {
    throw new TypeError('notify: message must be a string');
  }
  const body = normalizeText(rawMessage);
  if (body.length === 0) {
    throw new TypeError('notify: message must not be empty');
  }
  const rawTitle = input.title;
  if (rawTitle !== undefined && typeof rawTitle !== 'string') {
    throw new TypeError('notify: title must be a string when provided');
  }
  const title = normalizeText(rawTitle ?? DEFAULT_TITLE).trim() || DEFAULT_TITLE;

  const rawMs = input.disappearAfterMs;
  let disappearAfterMs = DEFAULT_DISAPPEAR_AFTER_MS;
  if (rawMs !== undefined) {
    const parsed = Number(rawMs);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new TypeError('notify: disappearAfterMs must be an integer number of milliseconds');
    }
    disappearAfterMs = parsed;
  }
  const sound = input.silent === true ? 'silent' : 'default';
  return { title, body, disappearAfterMs, sound };
}

/**
 * 构造 PowerShell 的 argv。
 * @param {string} scriptPath
 * @param {{title: string, body: string, disappearAfterMs: number, sound: string}} note
 * @param {string} appId
 * @returns {string[]}
 */
export function buildToastArgs(scriptPath, note, appId = DEFAULT_APP_ID) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-Title',
    note.title,
    '-Body',
    note.body,
    '-AppId',
    appId,
    '-Sound',
    note.sound,
    '-DisappearAfterMs',
    String(note.disappearAfterMs),
  ];
}

/**
 * 弹一次 toast，失败抛错（绝不静默成功）。
 *
 * @param {{message: string, title?: string, silent?: boolean, disappearAfterMs?: number}} input
 * @param {{
 *   scriptPath?: string,
 *   powerShellPath?: string,
 *   appId?: string,
 *   timeoutMs?: number,
 *   spawnImpl?: typeof nodeSpawn,
 *   platform?: string,
 * }} [options]
 * @returns {Promise<{shown: true, mechanism: 'toast', title: string, message: string, disappearAfterMs: number, sound: string, scriptPath: string, powerShellPath: string}>}
 */
export async function sendToast(input, options = {}) {
  const note = normalizeNotification(input);

  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new Error(
      `notify: the toast mechanism only exists on Windows (current platform: ${platform}); no notification was shown`,
    );
  }

  const scriptPath = path.resolve(
    process.cwd(),
    options.scriptPath ?? process.env.ADG_NOTIFY_TOAST_SCRIPT ?? DEFAULT_SCRIPT_PATH,
  );
  let scriptStat;
  try {
    scriptStat = statSync(scriptPath);
  } catch (error) {
    throw new Error(
      `notify: toast script not found at "${scriptPath}" (${error && error.code ? error.code : 'unknown error'})`,
      { cause: error },
    );
  }
  if (!scriptStat.isFile()) {
    throw new Error(`notify: toast script path "${scriptPath}" is not a regular file`);
  }

  const configuredPowerShell = options.powerShellPath ?? process.env.ADG_NOTIFY_POWERSHELL;
  const powerShellPath = configuredPowerShell
    ? path.resolve(process.cwd(), configuredPowerShell)
    : resolvePowershellPath();
  const isAbsolutePowerShell = path.isAbsolute(powerShellPath);
  if (isAbsolutePowerShell && !existsSync(powerShellPath)) {
    throw new Error(
      `notify: Windows PowerShell not found at "${powerShellPath}"; no notification was shown`,
    );
  }

  const rawTimeout = options.timeoutMs ?? process.env.ADG_NOTIFY_TIMEOUT_MS;
  const timeoutMs = rawTimeout === undefined ? DEFAULT_TIMEOUT_MS : Number(rawTimeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`notify: timeoutMs must be a positive finite number (got ${String(rawTimeout)})`);
  }

  const appId = options.appId ?? process.env.ADG_NOTIFY_APP_ID ?? DEFAULT_APP_ID;
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const argv = buildToastArgs(scriptPath, note, appId);

  const exit = await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(powerShellPath, argv, { stdio: 'ignore', windowsHide: true });
    } catch (error) {
      reject(
        new Error(`notify: failed to start "${powerShellPath}": ${describe(error)}`, { cause: error }),
      );
      return;
    }

    let settled = false;
    let timer = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      fn(value);
    };

    timer = setTimeout(() => {
      // 到点就杀掉，别留一个挂着的通知进程。
      try {
        child.kill();
      } catch {
        /* 已经退出了 */
      }
      settle(reject, new Error(`notify: toast did not finish within ${timeoutMs} ms; no notification was shown`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.once('error', (error) => {
      settle(reject, new Error(`notify: failed to start "${powerShellPath}": ${describe(error)}`, { cause: error }));
    });
    child.once('exit', (code, signal) => settle(resolve, { code, signal }));
  });

  if (exit.code !== 0) {
    const detail = exit.code === null ? `signal ${String(exit.signal)}` : `exit code ${String(exit.code)}`;
    throw new Error(
      `notify: toast script "${scriptPath}" failed with ${detail}; no notification was shown ` +
        '(run it by hand for the PowerShell error text)',
    );
  }

  return {
    shown: true,
    mechanism: 'toast',
    title: note.title,
    message: note.body,
    disappearAfterMs: note.disappearAfterMs,
    sound: note.sound,
    scriptPath,
    powerShellPath,
  };
}

/** 把任意 throwable 压成一行可读文本。 */
function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 规整换行（CRLF/CR -> LF）并去掉首尾空行 —— 不折叠正文里的空行。 */
function normalizeText(value) {
  return String(value)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}
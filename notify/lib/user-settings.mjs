// adg-notify 侧的「用户默认值」：读 adg-settings 那一页写下的通知三项。
//
// 为什么直接读文件、不 import `adg-settings` 那个包：两者是各自独立的插件包，profile 里
// 可能只装了其中一个（import 一个解析不到的包会在挂载期把整个插件炸掉）。设置文件是两个
// 模块之间**唯一**的契约，所以「设置页保存后立即生效」是真的 —— 每次调用都重读一次文件，
// 不是热重载、也不需要重启 dsh。
//
// 键名与界的真相在 dsh-adg-ptc/settings/lib/schema.mjs（本文件只**读**、不定义）。
// settings/test/settings.test.mjs 里有一条跨模块的漂移检查：核对本文件读的三个键都还在
// 登记表里、默认值与长度上限也一致。认不得的键、多出来的键一律忽略。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_TITLE } from './toast.mjs';

/** 与 adg-settings 的 STORE_NAME 同名（文件契约，两个模块各核一次）。 */
export const STORE_NAME = 'adg-settings.json';

/** 「通知默认标题」的长度上限：与登记表上 `notifyTitle` 的 `maxLength` 一致。 */
export const MAX_TITLE_LENGTH = 80;

/**
 * 关掉「通知常驻」之后通知活多久：改成常驻之前的原有默认值
 * （`toast.mjs` 的 `DEFAULT_DISAPPEAR_AFTER_MS` 注释记了这段来历）。
 */
export const AUTO_DISMISS_MS = 8000;

/**
 * 三项出厂默认：与登记表（`settings/lib/schema.mjs` 的 `DEFAULTS`）逐项一致。
 * `notifyPersist: true` 指「跟随 toast 层的 `DEFAULT_DISAPPEAR_AFTER_MS`」，即常驻。
 */
export const USER_DEFAULTS = Object.freeze({
  notifyTitle: DEFAULT_TITLE,
  notifySound: true,
  notifyPersist: true,
});

/** 设置文件的落点（与 `settings/index.js` 的 `settingsFile()` 同一口径）。 */
export function settingsFile() {
  const base =
    process.env.DSH_PROFILE_DIR ||
    process.env.DSH_HOME ||
    path.join(os.homedir(), '.dsh');
  return path.join(base, STORE_NAME);
}

/** `true` / `false` 与它们的字符串写法都算；别的都算「没写这一项」。 */
function validBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/**
 * 一份（可能被手改过的）设置文件里读得出来的三项；缺项 / 坏项一律回落到出厂默认。
 *
 * 读不出来（文件不存在 / 不是 JSON / 不是对象）就是「页面还没保存过」，**不抛错**：
 * 通知本身才是主线，一份坏掉的设置文件不该让 `notify_user` 挂掉 —— 失败与否由 toast 层
 * 说了算（design.md 的 D4）。
 */
export function readUserDefaults(file = settingsFile()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ...USER_DEFAULTS };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...USER_DEFAULTS };
  const title =
    typeof raw.notifyTitle === 'string' &&
    raw.notifyTitle.trim() !== '' &&
    raw.notifyTitle.length <= MAX_TITLE_LENGTH
      ? raw.notifyTitle
      : USER_DEFAULTS.notifyTitle;
  return {
    notifyTitle: title,
    notifySound: validBoolean(raw.notifySound) ?? USER_DEFAULTS.notifySound,
    notifyPersist: validBoolean(raw.notifyPersist) ?? USER_DEFAULTS.notifyPersist,
  };
}

/**
 * 一次 `notify_user` 调用的实际请求：**这一次调用的参数** > 设置页 / 出厂默认。
 *
 * 形状上有一条纪律：只有偏离 toast 层内置默认的项才写进请求（`title` 除外，它一直是显式
 * 字段）。这不是洁癖 —— `sendToast` 的默认值就是这些值，重复写一遍会让「这个值是谁定的」
 * 变模糊，也会把自测里对请求形状的断言变成环境相关。
 *
 * 单独导出（不读文件）是为了让自测不碰真实文件系统。
 *
 * @param {{message?: string, title?: string, silent?: boolean}} [args] 本次调用的参数
 * @param {{notifyTitle: string, notifySound: boolean, notifyPersist: boolean}} [defaults]
 * @returns {{message?: string, title: string, silent?: boolean, disappearAfterMs?: number}}
 */
export function resolveRequest(args = {}, defaults = USER_DEFAULTS) {
  const request = {
    message: args.message,
    // 空的 / 全空白的标题算「没写」：否则它会绕过设置页的那一句，落回 toast 层的出厂标题。
    title:
      typeof args.title === 'string' && args.title.trim() !== ''
        ? args.title
        : defaults.notifyTitle,
  };
  // silent 只在**这次调用显式传了布尔**时才作数（dsh-tools 的参数校验会把已声明属性补成
  // undefined，所以不能靠 `'silent' in args` 判断），否则跟随设置里的「响提示音」。
  // 出声（默认）时不写这个字段，与历史请求形状一致。
  if (typeof args.silent === 'boolean') request.silent = args.silent;
  else if (defaults.notifySound !== true) request.silent = true;
  // 常驻（默认）时也不写：toast 层的默认就是常驻；只有关掉常驻才需要给出存活毫秒。
  if (defaults.notifyPersist !== true) request.disappearAfterMs = AUTO_DISMISS_MS;
  return request;
}
// adg-skill-inject 侧的「用户设置」：读 adg-settings 那一页写下的注入开关与注入正文。
//
// 为什么直接读文件、不 import `adg-settings` 那个包：两者是各自独立的插件包，profile 里
// 可能只装了其中一个（import 一个解析不到的包会在挂载期把整个插件炸掉）。设置文件是两个
// 模块之间**唯一**的契约，所以「设置页保存后立即生效」是真的 —— 每次组装系统提示词都重读
// 一次文件，不是热重载、也不需要重启 dsh。
//
// 键名与界的真相在 dsh-adg-ptc/settings/lib/schema.mjs（本文件只**读**、不定义）。
// settings/test/settings.test.mjs 里有一条跨模块的漂移检查：核对本文件读的三个键都还在
// 登记表里、默认值与长度上限也一致。认不得的键、多出来的键一律忽略。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 与 adg-settings 的 STORE_NAME 同名（文件契约，两个模块各核一次）。 */
export const STORE_NAME = 'adg-settings.json';

/** 「注入正文」的长度上限：与登记表上 `skillInjectText` 的 `maxLength` 一致。 */
export const MAX_TEXT_LENGTH = 20000;

/**
 * 三项出厂默认：与登记表（`settings/lib/schema.mjs` 的 `DEFAULTS`）逐项一致。
 * `skillInjectText: ''` 指「跟随技能文件」（`DEFAULT_SKILL_PATH` 那份 SKILL.md）；
 * `skillInjectSubagent: false` 指「只注入调度者，子代理不注入」（默认关）。
 */
export const USER_DEFAULTS = Object.freeze({
  skillInjectEnabled: true,
  skillInjectSubagent: false,
  skillInjectText: '',
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
 * 注入本身才是主线，一份坏掉的设置文件不该让系统提示词组装挂掉。
 */
export function readUserDefaults(file = settingsFile()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ...USER_DEFAULTS };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...USER_DEFAULTS };
  const text =
    typeof raw.skillInjectText === 'string' && raw.skillInjectText.length <= MAX_TEXT_LENGTH
      ? raw.skillInjectText
      : USER_DEFAULTS.skillInjectText;
  return {
    skillInjectEnabled: validBoolean(raw.skillInjectEnabled) ?? USER_DEFAULTS.skillInjectEnabled,
    skillInjectSubagent: validBoolean(raw.skillInjectSubagent) ?? USER_DEFAULTS.skillInjectSubagent,
    skillInjectText: text,
  };
}

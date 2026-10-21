// adg-notify 的命令行入口：不开 dsh 就能单独验证 toast 通路。
//
// 为什么需要它（见 testing-guide.md）：运行期是否装载只有重启 dsh 才能观测，
// 而「toast 到底弹不弹得出来」必须能当场验证 —— 这条命令走的是与 `notify_user`
// 完全相同的 lib/toast.mjs 代码路径，所以它是人工 review 的第一站。
//
// 零依赖，只用 Node 内置能力。
//
//   node cli.mjs send --message "需要你登录" [--title "…"] [--silent] [--ms 0]
//   node cli.mjs help
//
// 退出码：0 = 已投递；1 = 没投出去（stderr 给原因）；2 = 用法错误。

import { DEFAULT_APP_ID, DEFAULT_TITLE, sendToast } from './lib/toast.mjs';

/** 打印用法。 */
function usage() {
  const lines = [
    'adg-notify：把一条消息变成 Windows 桌面通知（notify_user 的同一个内核）。',
    '',
    '用法：',
    '  node cli.mjs send --message <正文> [--title <标题>] [--silent] [--ms <毫秒>]',
    '  node cli.mjs help',
    '',
    '说明：',
    `  --title   通知标题，默认 "${DEFAULT_TITLE}"`,
    '  --silent  静音弹出',
    '  --ms      通知存活毫秒，默认 0＝常驻（scenario=reminder）；> 7000 为 long，否则 short',
    `  --appid   覆盖 toast 的 AppId，默认 ${DEFAULT_APP_ID}`,
    '  --show    把脚本路径 / PowerShell 路径 / argv 一起打出来（排错用）',
    '',
    '这条命令只验证"机制能不能弹"，不验证"dsh 有没有装载本插件"——后者见 testing-guide.md。',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * 极简旗标解析。
 * @param {string[]} argv
 * @returns {{_: string[], [key: string]: string|boolean|string[]}}
 */
function parseArgs(argv) {
  const out = { _: [] };
  const takesValue = new Set(['message', 'title', 'ms', 'appid', 'sound']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const key = (equals === -1 ? token.slice(2) : token.slice(2, equals)).toLowerCase();
    if (equals !== -1) {
      out[key] = token.slice(equals + 1);
      continue;
    }
    if (takesValue.has(key)) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`--${key} 需要一个值`);
      out[key] = next;
      index += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

async function main(argv) {
  const parsed = parseArgs(argv);
  const command = parsed._[0] ?? (parsed.help === true ? 'help' : undefined);

  if (parsed.help === true || command === 'help' || command === undefined) {
    usage();
    return command === undefined && parsed.help !== true ? 2 : 0;
  }
  if (command !== 'send') {
    process.stderr.write(`未知子命令：${command}\n\n`);
    usage();
    return 2;
  }

  const message = typeof parsed.message === 'string' ? parsed.message : undefined;
  if (message === undefined) {
    process.stderr.write('缺少 --message <正文>\n\n');
    usage();
    return 2;
  }

  const disappearAfterMs = typeof parsed.ms === 'string' ? Number(parsed.ms) : undefined;
  if (parsed.ms !== undefined && !Number.isInteger(disappearAfterMs)) {
    process.stderr.write(`--ms 必须是整数（收到 ${String(parsed.ms)}）\n`);
    return 2;
  }

  try {
    const result = await sendToast({
      message,
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
      silent: parsed.silent === true ? true : undefined,
      disappearAfterMs,
    });
    if (parsed.show === true) {
      process.stdout.write(`script      ${result.scriptPath}\n`);
      process.stdout.write(`powershell  ${result.powerShellPath}\n`);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
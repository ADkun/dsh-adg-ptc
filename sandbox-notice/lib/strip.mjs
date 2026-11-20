/**
 * adg-sandbox-notice 的纯函数（不 import cordis，可 node --test 直接测）。
 *
 * 目标：从 run_code 的渲染文本里剥掉 PTC 渲染层在末尾追加的那一行
 * "File sandbox enforcement is partial on this host."
 * —— 它是 windows-acl 沙箱档下恒被拼上的状态声明，不是结果本身。
 *
 * 只剥“末尾整行”的那一次出现：程序自己在中途打印同样一句、或结果里含 denied 拒绝句，都不受影响。
 */

/** PTC 渲染层在 enforcement === 'partial' 时追加在末尾的那一行（必须与平台逐字一致）。 */
export const NOTICE = 'File sandbox enforcement is partial on this host.';

/** PTC 渲染层对“空输出”使用的占位文本（剥完无内容时用它回退）。 */
export const EMPTY_OUTPUT = '(run_code completed with no output)';

/**
 * 从单段文本里剥掉末尾那一行 NOTICE（连同其前一个换行）。
 * 不满足“末尾整行”就原样返回；输入非字符串原样返回。
 * @param {string} text
 * @returns {string}
 */
export function stripNoticeLine(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  // 末尾允许有空格 / 制表 / 回车（保守；render 正常不加）
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t' || text[end - 1] === '\r')) {
    end -= 1;
  }
  if (end < NOTICE.length) return text;
  const start = end - NOTICE.length;
  if (text.slice(start, end) !== NOTICE) return text;
  if (start === 0) return '';
  const prev = text[start - 1];
  if (prev === '\n' || prev === '\r') return text.slice(0, start - 1);
  // 内联出现（前面不是行首/换行）→ 不动，避免误伤程序自己的输出
  return text;
}

/**
 * 从 ContentBlock[] 里剥掉末尾的 NOTICE 行。
 * 只处理 type==='text' 的块；有任何一块变化才返回新数组，否则原样返回入参数组（供上层用 === 判变化）。
 * 剥完丢掉变空的 text 块；若最后一个空内容都不剩，回退为单块 EMPTY_OUTPUT。
 * @param {Array<object>} content
 * @returns {Array<object>}
 */
export function stripSandboxNotice(content) {
  if (!Array.isArray(content) || content.length === 0) return content;
  let changed = false;
  const out = content.map((block) => {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      const next = stripNoticeLine(block.text);
      if (next !== block.text) {
        changed = true;
        return { ...block, text: next };
      }
    }
    return block;
  });
  if (!changed) return content;
  const kept = out.filter((block) => !(block && block.type === 'text' && block.text === ''));
  if (kept.length === 0) return [{ type: 'text', text: EMPTY_OUTPUT }];
  return kept;
}

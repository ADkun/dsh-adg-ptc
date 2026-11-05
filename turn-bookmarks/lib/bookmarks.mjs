/**
 * adg-turn-bookmarks — 纯规则（宿主半边与测试共用）。
 *
 * 这里不碰网络、不碰 HTTP：只有"什么算合法书签""sidecar 叫什么名字""会话目录可能叫什么"。
 * 落盘的读写与路由装配都在 ../index.mjs。
 */

/** 每个会话目录里的 sidecar 文件名（文件契约：只此一份）。 */
export const STORE_FILE = 'adg-turn-bookmarks.json';

/** 一个会话最多记多少条书签；超了是 400，不静默截断。 */
export const MAX_TURNS = 1000;

/**
 * 会话 id 能不能安全拼进路径：首字符字母数字、其余 [A-Za-z0-9._-]、长度 <=200、
 * 且不含 '..'（路径穿越）。'session-<uuid>' 与裸 '<uuid>' 都合法。
 */
export function isSafeSessionId(id) {
  if (typeof id !== 'string') return false;
  if (id.length === 0 || id.length > 200) return false;
  if (id.includes('..')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

/**
 * 把任意输入收成一份干净的书签列表：只留非负整数、去重、升序、封顶 MAX_TURNS。
 * 浮点、负数、字符串、NaN、Infinity 一律丢弃（不猜、不四舍五入）。
 */
export function normalizeTurns(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  const seen = new Set();
  for (const value of raw) {
    if (typeof value !== 'number') continue;
    if (!Number.isInteger(value)) continue;
    if (value < 0) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= MAX_TURNS) break;
  }
  out.sort((left, right) => left - right);
  return out;
}

/** 读回 sidecar 的容错解析：坏 JSON / 错形状一律当空列表。 */
export function parseStore(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { turns: [] };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { turns: [] };
  return { turns: normalizeTurns(data.turns) };
}

/** 写 sidecar 的唯一形状：带 version 与结尾换行。 */
export function serializeStore(turns) {
  const body = { version: 1, turns: normalizeTurns(turns) };
  return JSON.stringify(body, undefined, 2) + String.fromCharCode(10);
}

/**
 * 会话目录名可能是 'session-<uuid>' 也可能是裸 '<uuid>'（两种形态在本机并存）。
 * 给出按优先级排的候选目录名，调用方逐个探。
 */
export function sessionDirCandidates(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return [];
  const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId;
  const names = [sessionId, bare, 'session-' + bare];
  const unique = [];
  for (const candidate of names) {
    if (!isSafeSessionId(candidate)) continue;
    if (unique.includes(candidate)) continue;
    unique.push(candidate);
  }
  return unique;
}

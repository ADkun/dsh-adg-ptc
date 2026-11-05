// turn-bookmarks 的纯规则自测：文件契约、会话 id 安全、书签列表归一、sidecar 容错解析。
//
// 纪律：零依赖、零副作用（不碰 HTTP、不碰真机 profile）。
// 跑法：cd turn-bookmarks && node --test test
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_TURNS,
  STORE_FILE,
  isSafeSessionId,
  normalizeTurns,
  parseStore,
  serializeStore,
  sessionDirCandidates,
} from '../lib/bookmarks.mjs';

test('文件契约：sidecar 名字与上限只有一处', () => {
  assert.equal(STORE_FILE, 'adg-turn-bookmarks.json');
  assert.equal(MAX_TURNS, 1000);
});

test('isSafeSessionId：两种合法形态放行，路径穿越与怪字符拒绝', () => {
  for (const id of ['abc', 'session-08d3734b-a5e0-48fc-a9d3-c0a1cc56205c', 'a.b_c-1']) {
    assert.equal(isSafeSessionId(id), true, id);
  }
  for (const id of ['', '-lead', '.lead', 'a/b', 'a..b', 'a b', 'x'.repeat(201)]) {
    assert.equal(isSafeSessionId(id), false, JSON.stringify(id));
  }
  assert.equal(isSafeSessionId(null), false);
  assert.equal(isSafeSessionId(42), false);
});

test('normalizeTurns：只留非负整数、去重、升序、不猜不四舍五入', () => {
  assert.deepEqual(normalizeTurns([3, 1, 1, 2, -1, 1.5, '4', Number.NaN, Number.POSITIVE_INFINITY]), [1, 2, 3]);
  assert.deepEqual(normalizeTurns('nope'), []);
  assert.deepEqual(normalizeTurns([0]), [0]);
  const many = Array.from({ length: MAX_TURNS + 50 }, (_, index) => index);
  const capped = normalizeTurns(many);
  assert.equal(capped.length, MAX_TURNS);
  assert.equal(capped[0], 0);
});

test('parseStore 容错：坏 JSON、错形状、缺 turns 一律当空列表', () => {
  assert.deepEqual(parseStore('{ not json'), { turns: [] });
  assert.deepEqual(parseStore('[]'), { turns: [] });
  assert.deepEqual(parseStore('null'), { turns: [] });
  assert.deepEqual(parseStore('{}'), { turns: [] });
  assert.deepEqual(parseStore(JSON.stringify({ turns: [2, 'x', 2, 7] })), { turns: [2, 7] });
});

test('serializeStore 与 parseStore 往返一致，且带 version 与结尾换行', () => {
  const text = serializeStore([3, 1, 3]);
  assert.equal(text.charCodeAt(text.length - 1), 10);
  assert.deepEqual(JSON.parse(text), { version: 1, turns: [1, 3] });
  assert.deepEqual(parseStore(text), { turns: [1, 3] });
});

test('sessionDirCandidates：两种目录形态都给，且不含非法候选', () => {
  assert.deepEqual(sessionDirCandidates('abc'), ['abc', 'session-abc']);
  assert.deepEqual(sessionDirCandidates('session-abc'), ['session-abc', 'abc']);
  assert.deepEqual(sessionDirCandidates(''), []);
  assert.deepEqual(sessionDirCandidates('a/b'), []);
  assert.deepEqual(sessionDirCandidates(null), []);
});

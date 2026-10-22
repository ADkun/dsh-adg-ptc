// 接线层测试：index.mjs 的 `apply(ctx)` 把策略挂到 tools/post-execute 上。
//
// 这里用一个最小假 ctx（不 import cordis）：只实现 apply() 真正用到的
// `effect` / `on` / `logger`。目的是钉住三件事：挂的是哪个事件、是不是
// prepend、以及 next() 之后的决策确实过了策略。
//
// 跑法：cd source-guard && node --test test

import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, name, inject } from '../index.mjs';

/** 收集 effect/on 调用的最小假 ctx。 */
function fakeCtx() {
  const listeners = [];
  const effects = [];
  const warns = [];
  const off = (handler) => () => {
    const index = listeners.findIndex((entry) => entry.handler === handler);
    if (index >= 0) listeners.splice(index, 1);
  };
  const ctx = {
    listeners,
    effects,
    warns,
    logger: { warn: (message) => warns.push(String(message)) },
    on(event, handler, options) {
      listeners.push({ event, handler, options });
      return off(handler);
    },
    effect(setup, label) {
      effects.push(label);
      ctx.lastDisposer = setup();
      return ctx.lastDisposer;
    },
  };
  return ctx;
}

const topExec = { callId: 'c1', name: 'run_code', arguments: { code: 'x', description: 'd' }, parent: undefined };

test('W1 契约三件套：name / inject / apply 齐且形状正确', () => {
  assert.equal(name, 'adg-source-guard');
  assert.deepEqual(inject, ['tools']);
  assert.equal(typeof apply, 'function');
});

test('W2 挂载：恰好注册一个 tools/post-execute 监听器，且 prepend', () => {
  const ctx = fakeCtx();
  apply(ctx);
  assert.equal(ctx.listeners.length, 1);
  assert.equal(ctx.listeners[0].event, 'tools/post-execute');
  assert.deepEqual(ctx.listeners[0].options, { prepend: true });
  assert.ok(ctx.effects.includes('adg-source-guard.post-execute()'));
});

test('W3 调用：next() 的决策被策略改写（成功 run_code 补意图块）', async () => {
  const ctx = fakeCtx();
  apply(ctx);
  const { handler } = ctx.listeners[0];
  let nextCalled = 0;
  const out = await handler(
    topExec,
    { isError: false, content: [{ type: 'text', text: '42' }] },
    async () => {
      nextCalled += 1;
      return { kind: 'accept' };
    },
  );
  assert.equal(nextCalled, 1);
  assert.equal(out.kind, 'accept');
  assert.equal(out.content.length, 2);
  assert.equal(out.content[0].text, '意图：d\n');
  assert.equal(out.content[1].text, '42');
});

test('W3b 调用：意图缺失时只回平台正文（与未装插件逐字相同，不多一个块）', async () => {
  const ctx = fakeCtx();
  apply(ctx);
  const { handler } = ctx.listeners[0];
  const base = [{ type: 'text', text: '42' }];
  const decision = { kind: 'accept' };
  const out = await handler({ name: 'run_code', arguments: {}, parent: undefined }, { isError: false, content: base }, async () => decision);
  assert.equal(out.kind, 'accept');
  assert.deepEqual(out.content, base);
});

test('W3c 调用：意图与正文都缺失时只补意图块（不为空正文造 content 数组）', async () => {
  const ctx = fakeCtx();
  apply(ctx);
  const { handler } = ctx.listeners[0];
  const decision = { kind: 'accept' };
  const out = await handler(topExec, { isError: false }, async () => decision);
  assert.deepEqual(out.content.map((b) => b.text), ['意图：d']);
});

test('W3d 接线层：下游空串拼接后意图与正文之间仍有换行', async () => {
  const ctx = fakeCtx();
  apply(ctx);
  const { handler } = ctx.listeners[0];
  const out = await handler(topExec, { isError: false, content: [{ type: 'text', text: '42' }] }, async () => ({ kind: 'accept' }));
  const joined = out.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  assert.equal(joined, '意图：d\n42');
});

test('W4 调用：失败结果原样返回 next() 的决策', async () => {
  const ctx = fakeCtx();
  apply(ctx);
  const { handler } = ctx.listeners[0];
  const decision = { kind: 'accept', content: [{ type: 'text', text: 'code run failed' }] };
  const out = await handler(topExec, { isError: true, content: [] }, async () => decision);
  assert.equal(out, decision);
});

test('W5 调用：非 run_code 工具原样返回', async () => {
  const ctx = fakeCtx();
  apply(ctx);
  const { handler } = ctx.listeners[0];
  const decision = { kind: 'accept' };
  const out = await handler({ name: 'read', arguments: {}, parent: undefined }, { isError: false, content: [] }, async () => decision);
  assert.equal(out, decision);
});

test('W6 卸载：effect 返回的 disposer 移除监听器', () => {
  const ctx = fakeCtx();
  apply(ctx);
  assert.equal(ctx.listeners.length, 1);
  const disposer = ctx.lastDisposer;
  assert.equal(typeof disposer, 'function');
  disposer();
  assert.equal(ctx.listeners.length, 0);
});

test('W7 策略抛错时不外抛：落一条 warn 并返回 next() 的决策', async () => {
  const ctx = fakeCtx();
  apply(ctx);
  const { handler } = ctx.listeners[0];
  // 让 applyPolicy 抛错：decision 有 value 键且值为 getter 抛错的对象不行，
  // 改用 content 为会抛错的 Proxy（Object.hasOwn 之外不碰，这里靠 content 展开触发）。
  const decision = {
    kind: 'accept',
    get content() {
      throw new Error('boom-content');
    },
  };
  const out = await handler(topExec, { isError: false, content: [] }, async () => decision);
  assert.equal(out, decision);
  assert.equal(ctx.warns.length, 1);
  assert.match(ctx.warns[0], /adg-source-guard/);
});

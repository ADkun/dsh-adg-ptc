import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NOTICE, EMPTY_OUTPUT, stripNoticeLine, stripSandboxNotice } from '../lib/strip.mjs';
import { name, inject, apply } from '../index.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function makeCtx() {
  const labels = [];
  const listeners = [];
  let effectDisposer = null;
  const ctx = {
    labels,
    listeners,
    effect(fn, label) {
      labels.push(label);
      effectDisposer = fn();
      return effectDisposer;
    },
    on(event, handler, opts) {
      listeners.push({ event, handler, opts });
      return () => {
        const i = listeners.findIndex((x) => x.handler === handler);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
  ctx.dispose = () => { if (typeof effectDisposer === 'function') effectDisposer(); };
  return ctx;
}

function handlerOf() {
  const ctx = makeCtx();
  apply(ctx);
  return { ctx, handler: ctx.listeners[0].handler };
}

const run = (handler, exec, result, decision) => handler(exec, result, async () => decision);

// ---------- N: stripNoticeLine ----------
test('N1 末尾整行 notice（前有换行）被剥', () => {
  assert.equal(stripNoticeLine('a\n' + NOTICE), 'a');
});

test('N2 整段仅 notice ⇒ 空串', () => {
  assert.equal(stripNoticeLine(NOTICE), '');
});

test('N3 notice 在中间（后面还有内容）不动', () => {
  const t = 'x\n' + NOTICE + '\ny';
  assert.equal(stripNoticeLine(t), t);
});

test('N4 内联出现（前不是换行）不动', () => {
  const t = 'a ' + NOTICE;
  assert.equal(stripNoticeLine(t), t);
});

test('N5 notice 后带尾随空格 / 制表仍剥', () => {
  assert.equal(stripNoticeLine(NOTICE + ' \t'), '');
  assert.equal(stripNoticeLine('a\n' + NOTICE + '   '), 'a');
});

test('N6 无 notice / 非字符串原样', () => {
  assert.equal(stripNoticeLine('hi'), 'hi');
  assert.equal(stripNoticeLine(null), null);
  assert.equal(stripNoticeLine(undefined), undefined);
});

test('N7 notice 前的正文逐字保留', () => {
  assert.equal(stripNoticeLine('line1\nline2\n' + NOTICE), 'line1\nline2');
});

// ---------- A: stripSandboxNotice ----------
test('A1 单 text 块末尾 notice 被剥', () => {
  const out = stripSandboxNotice([{ type: 'text', text: 'a\n' + NOTICE }]);
  assert.deepEqual(out, [{ type: 'text', text: 'a' }]);
});

test('A2 仅 notice 的块 ⇒ 回退 EMPTY_OUTPUT', () => {
  const out = stripSandboxNotice([{ type: 'text', text: NOTICE }]);
  assert.deepEqual(out, [{ type: 'text', text: EMPTY_OUTPUT }]);
});

test('A3 image + 仅 notice 的 text 块 ⇒ 保留 image、丢空 text、不回退', () => {
  const img = { type: 'image', source: 'x' };
  const out = stripSandboxNotice([img, { type: 'text', text: NOTICE }]);
  assert.equal(out.length, 1);
  assert.equal(out[0], img);
});

test('A4 无 notice ⇒ 同一引用', () => {
  const input = [{ type: 'text', text: 'hello' }];
  assert.equal(stripSandboxNotice(input), input);
});

test('A5 空数组 / 非数组原样', () => {
  const arr = [];
  assert.equal(stripSandboxNotice(arr), arr);
  assert.equal(stripSandboxNotice(undefined), undefined);
});

test('A6 多块仅末块含 notice：其它块原样、返回新数组', () => {
  const first = { type: 'text', text: 'keep' };
  const input = [first, { type: 'text', text: 'a\n' + NOTICE }];
  const out = stripSandboxNotice(input);
  assert.notEqual(out, input);
  assert.equal(out.length, 2);
  assert.equal(out[0], first);
  assert.equal(out[1].text, 'a');
});

// ---------- W: apply / handler wiring ----------
test('W0 恰好一个 post-execute 监听器、prepend=true、effect 标签在位', () => {
  const ctx = makeCtx();
  apply(ctx);
  assert.equal(ctx.listeners.length, 1);
  assert.equal(ctx.listeners[0].event, 'tools/post-execute');
  assert.equal(ctx.listeners[0].opts.prepend, true);
  assert.deepEqual(ctx.labels, ['adg-sandbox-notice.strip()']);
});

test('W1 run_code accept 含末尾 notice ⇒ 结果被剥、无该行', async () => {
  const { handler } = handlerOf();
  const decision = { kind: 'accept', content: [{ type: 'text', text: 'hello\n' + NOTICE }] };
  const out = await run(handler, { name: 'run_code' }, { content: decision.content }, decision);
  assert.equal(out.kind, 'accept');
  assert.equal(out.content[0].text, 'hello');
  assert.notEqual(out, decision);
});

test('W2 非 run_code ⇒ 原 decision（同一引用）', async () => {
  const { handler } = handlerOf();
  const decision = { kind: 'accept', content: [{ type: 'text', text: 'hi\n' + NOTICE }] };
  const out = await run(handler, { name: 'bash' }, { content: decision.content }, decision);
  assert.equal(out, decision);
});

test('W3 block 决策 ⇒ 原 decision', async () => {
  const { handler } = handlerOf();
  const decision = { kind: 'block', feedback: [{ type: 'text', text: NOTICE }] };
  const out = await run(handler, { name: 'run_code' }, {}, decision);
  assert.equal(out, decision);
});

test('W4 accept-with-value ⇒ 原 decision', async () => {
  const { handler } = handlerOf();
  const decision = { kind: 'accept', value: { ok: true } };
  const out = await run(handler, { name: 'run_code' }, {}, decision);
  assert.equal(out, decision);
});

test('W5 无 notice ⇒ 原 decision（同一引用）', async () => {
  const { handler } = handlerOf();
  const decision = { kind: 'accept', content: [{ type: 'text', text: 'hi' }] };
  const out = await run(handler, { name: 'run_code' }, { content: decision.content }, decision);
  assert.equal(out, decision);
});

test('W6 仅 notice ⇒ 回退 EMPTY_OUTPUT', async () => {
  const { handler } = handlerOf();
  const decision = { kind: 'accept', content: [{ type: 'text', text: NOTICE }] };
  const out = await run(handler, { name: 'run_code' }, { content: decision.content }, decision);
  assert.equal(out.content[0].text, EMPTY_OUTPUT);
});

test('W7 next 返回 null / exec 缺失不抛、返回原值', async () => {
  const { handler } = handlerOf();
  assert.equal(await run(handler, { name: 'run_code' }, {}, null), null);
  const decision = { kind: 'accept', content: [{ type: 'text', text: 'x' }] };
  const out = await run(handler, undefined, {}, decision);
  assert.equal(out, decision);
});

test('W8 disposer 移除监听器', () => {
  const ctx = makeCtx();
  apply(ctx);
  assert.equal(ctx.listeners.length, 1);
  ctx.dispose();
  assert.equal(ctx.listeners.length, 0);
});

// ---------- C: 文件契约 / 防漂移 ----------
test('C1 name === patch id === adg-sandbox-notice', () => {
  const yml = read('../cordis.patch.yml');
  const m = yml.match(/-\s*id:\s*([A-Za-z0-9-]+)/);
  assert.ok(m, 'cordis.patch.yml 里找不到 insert id');
  assert.equal(m[1], name);
  assert.equal(name, 'adg-sandbox-notice');
});

test('C2 inject === [tools]', () => {
  assert.deepEqual(inject, ['tools']);
});

test('C3 package.json 的 name / main / dsh.bundle.patch / engines 与实现一致', () => {
  const pkg = JSON.parse(read('../package.json'));
  assert.equal(pkg.name, 'adg-sandbox-notice');
  assert.equal(pkg.main, './index.mjs');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.engines.node, '>=22');
});

test('C4 零第三方依赖：index.mjs / lib/strip.mjs 不含 @deepseek-ai', () => {
  assert.equal(/@deepseek-ai/.test(read('../index.mjs')), false);
  assert.equal(/@deepseek-ai/.test(read('../lib/strip.mjs')), false);
});

test('C5 NOTICE / EMPTY_OUTPUT 字面量钉死', () => {
  assert.equal(NOTICE, 'File sandbox enforcement is partial on this host.');
  assert.equal(EMPTY_OUTPUT, '(run_code completed with no output)');
});

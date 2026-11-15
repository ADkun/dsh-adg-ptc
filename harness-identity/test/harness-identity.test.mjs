import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { name, inject, apply } from '../index.mjs';
import {
  SECTION_NAME,
  SECTION_ORDER,
  TARGET_PRESET,
  SHADOW_TEXT,
  shouldInjectFor,
  shadowSection,
} from '../lib/section.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const modRoot = join(here, '..');

/** 造一个 agent：pushes 收集它自己 scope 上收到的 section。 */
function makeAgent({ preset = 'adg-ptc', hasCtx = true } = {}) {
  const pushes = [];
  const agentCtx = hasCtx
    ? { systemPrompt: { section: (s) => { pushes.push(s); return () => {}; } } }
    : undefined;
  return { agent: { ctx: agentCtx, session: { header: { agentPreset: preset } } }, pushes };
}

/** 假 ctx：只实现 apply() 用到的 effect / on / get，不 import cordis。 */
function makeCtx({ agentPresets = undefined } = {}) {
  const listeners = [];
  const labels = [];
  let lastDisposer;
  return {
    effect(fn, label) {
      labels.push(label);
      lastDisposer = fn();
      return lastDisposer;
    },
    on(event, cb) {
      if (event !== 'agent/created') return () => {};
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    get(service) {
      return service === 'agentPresets' ? agentPresets : undefined;
    },
    _emit(payload) {
      for (const l of listeners.slice()) l(payload);
    },
    _listeners: listeners,
    _labels: labels,
    _dispose() { if (typeof lastDisposer === 'function') lastDisposer(); },
  };
}

// ===== G：判定 =====
test('G1 shouldInjectFor: header.agentPreset=adg-ptc → true', () => {
  assert.equal(shouldInjectFor({ agentPreset: 'adg-ptc' }, undefined), true);
});

test('G2 shouldInjectFor: 其它 preset → false', () => {
  assert.equal(shouldInjectFor({ agentPreset: 'native-x' }, undefined), false);
});

test('G3 shouldInjectFor: composedPresetId 优先于 header → true', () => {
  assert.equal(shouldInjectFor({ agentPreset: 'native-x' }, 'adg-ptc'), true);
});

test('G4 shouldInjectFor: header 缺失 → false（fail-closed）', () => {
  assert.equal(shouldInjectFor(undefined, undefined), false);
});

test('G5 shouldInjectFor: 空 header → false', () => {
  assert.equal(shouldInjectFor({}, undefined), false);
});

// ===== S：覆盖常量 =====
test('S1 shadowSection 形状固定（同名 / order -1000 / 空文本）', () => {
  assert.deepEqual(shadowSection(), { name: 'harness:identity', order: -1000, text: '' });
});

test('S2 SECTION_NAME 与平台一致', () => {
  assert.equal(SECTION_NAME, 'harness:identity');
  assert.equal(TARGET_PRESET, 'adg-ptc');
});

test('S3 SECTION_ORDER 与平台 HARNESS_IDENTITY 一致且为有限数', () => {
  assert.equal(SECTION_ORDER, -1000);
  assert.equal(Number.isFinite(SECTION_ORDER), true);
});

test('S4 SHADOW_TEXT 为空串（覆盖不留输出、不留空行）', () => {
  assert.equal(SHADOW_TEXT, '');
});

// ===== W：接线 =====
test('W0 恰好注册一个 agent/created 监听器，effect 标签在位', () => {
  const ctx = makeCtx();
  apply(ctx);
  assert.deepEqual(ctx._labels, ['adg-harness-identity.section()']);
  assert.equal(ctx._listeners.length, 1);
});

test('W1 adg-ptc agent 在它自己的 scope 注册覆盖 section', () => {
  const ctx = makeCtx();
  apply(ctx);
  const { agent, pushes } = makeAgent({ preset: 'adg-ptc' });
  ctx._emit({ agent });
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0], { name: 'harness:identity', order: -1000, text: '' });
});

test('W2 非 adg-ptc agent 一个 section 都不注册', () => {
  const ctx = makeCtx();
  apply(ctx);
  const { agent, pushes } = makeAgent({ preset: 'native-x' });
  ctx._emit({ agent });
  assert.equal(pushes.length, 0);
});

test('W3 composedPreset=adg-ptc 时即使 header 是别的也注册', () => {
  const ctx = makeCtx({ agentPresets: { composedPreset: () => 'adg-ptc' } });
  apply(ctx);
  const { agent, pushes } = makeAgent({ preset: 'native-x' });
  ctx._emit({ agent });
  assert.equal(pushes.length, 1);
});

test('W4 composedPreset=别的 时即使 header 是 adg-ptc 也不注册（composed 优先）', () => {
  const ctx = makeCtx({ agentPresets: { composedPreset: () => 'native-x' } });
  apply(ctx);
  const { agent, pushes } = makeAgent({ preset: 'adg-ptc' });
  ctx._emit({ agent });
  assert.equal(pushes.length, 0);
});

test('W5 payload 里没有 agent 时不注册、也不抛错', () => {
  const ctx = makeCtx();
  apply(ctx);
  assert.doesNotThrow(() => ctx._emit({}));
  assert.doesNotThrow(() => ctx._emit(undefined));
});

test('W6 agent.ctx 缺失时不注册、也不抛错', () => {
  const ctx = makeCtx();
  apply(ctx);
  const { agent, pushes } = makeAgent({ preset: 'adg-ptc', hasCtx: false });
  assert.doesNotThrow(() => ctx._emit({ agent }));
  assert.equal(pushes.length, 0);
});

test('W7 section() 抛错时不外抛（单个 agent 失败不拖垮其它 agent）', () => {
  const ctx = makeCtx();
  apply(ctx);
  const agent = {
    ctx: { systemPrompt: { section: () => { throw new Error('boom'); } } },
    session: { header: { agentPreset: 'adg-ptc' } },
  };
  assert.doesNotThrow(() => ctx._emit({ agent }));
});

test('W8 disposer 移除监听器', () => {
  const ctx = makeCtx();
  apply(ctx);
  assert.equal(ctx._listeners.length, 1);
  ctx._dispose();
  assert.equal(ctx._listeners.length, 0);
});

test('W9 agentPresets 服务缺失时按 header 判定仍工作', () => {
  const ctx = makeCtx({ agentPresets: undefined });
  apply(ctx);
  const { agent, pushes } = makeAgent({ preset: 'adg-ptc' });
  ctx._emit({ agent });
  assert.equal(pushes.length, 1);
});

// ===== C：契约 / 防漂移 =====
test('C1 export name === insert id === adg-harness-identity', () => {
  const yml = readFileSync(join(modRoot, 'cordis.patch.yml'), 'utf8');
  const m = yml.match(/- id:\s*(\S+)/);
  assert.equal(name, 'adg-harness-identity');
  assert.equal(m && m[1], name);
});

test('C2 inject 恰好 systemPrompt', () => {
  assert.deepEqual(inject, ['systemPrompt']);
});

test('C3 package.json 的 name / main / dsh.bundle.patch 与实现一致', () => {
  const pkg = JSON.parse(readFileSync(join(modRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'adg-harness-identity');
  assert.equal(pkg.main, './index.mjs');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.engines.node, '>=22');
});

test('C4 零第三方依赖：index.mjs 与 lib/section.mjs 不含 @deepseek-ai', () => {
  for (const rel of ['index.mjs', 'lib/section.mjs']) {
    const src = readFileSync(join(modRoot, rel), 'utf8');
    assert.equal(/@deepseek-ai/.test(src), false, rel + ' 引用了 @deepseek-ai');
  }
});

test('C5 index.mjs 源码里出现 section 名 harness:identity 与 order -1000', () => {
  const src = readFileSync(join(modRoot, 'index.mjs'), 'utf8') + readFileSync(join(modRoot, 'lib/section.mjs'), 'utf8');
  assert.match(src, /harness:identity/);
  assert.match(src, /-1000/);
});

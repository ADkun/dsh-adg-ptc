// adg-ptc-parallel 的单元测试：判定逻辑 + 正文常量 + 动态工具清单 + 接线层 + 契约一致性。
//
// 跑法：cd ptc-parallel && node --test test
//         （DSH 沙箱（workspace-write）里必须加 --test-isolation=none）
//
// 本文件零第三方依赖、零副作用：不写盘、不起进程、不碰真会话、不联网。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { apply, name, inject, GUIDE_TEXT, guideTextFor, isPtcAgent } from '../index.mjs';
import {
  CLASSIFICATION_NOTE,
  classifyVisibleTools,
  renderToolLists,
} from '../lib/guide.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const moduleRoot = join(here, '..');
const readModuleFile = (rel) => readFileSync(join(moduleRoot, rel), 'utf8');

/** 反引号：正文里给工具名加的那种，测试里用变量拼，免得源码里到处是转义。 */
const BT = String.fromCharCode(96);

/**
 * 防回归：正文一旦出现任何工具名硬编码，这条就红。
 * 写死的清单会过期（dsh 升级新增工具、agent 工具面变化），模型会拿过期清单下结论。
 */
const TOOL_NAME_PATTERN = /\b(pwsh|write|edit|glob|grep|read|web_search|web_fetch|delegate|notify_user|ask_user)\b/;

// ── G 系列：isPtcAgent 的判定 ────────────────────────────────────────────────

test('G1 判定：tools 服务不存在 ⇒ false', () => {
  const ctx = { get: () => undefined };
  assert.equal(isPtcAgent(ctx, { id: 'a1' }), false);
});

test('G2 判定：tools.get 抛错（PTC runtime 缺失等）⇒ false，不外抛', () => {
  const ctx = {
    get: () => ({
      get: () => {
        throw new Error('dsh-tools: run_code with an Agent requires workingDirectory');
      },
    }),
  };
  assert.equal(isPtcAgent(ctx, { id: 'a1' }), false);
});

test('G3 判定：get 返回 undefined（native scope）⇒ false', () => {
  const ctx = { get: () => ({ get: () => undefined }) };
  assert.equal(isPtcAgent(ctx, { id: 'a1' }), false);
});

test('G4 判定：get 返回 run_code 的定义 ⇒ true，且 scope 传的就是 agent 自己', () => {
  const calls = [];
  const definition = { name: 'run_code', description: 'program-driven tool calls' };
  const ctx = {
    get: (service) => {
      calls.push(service);
      return {
        get: (toolName, scope) => {
          calls.push(toolName);
          calls.push(scope);
          return definition;
        },
      };
    },
  };
  const agent = { id: 'a1' };
  assert.equal(isPtcAgent(ctx, agent), true);
  // 判据只用公开 API：ctx.get('tools') + tools.get('run_code', agent)
  assert.deepEqual(calls, ['tools', 'run_code', agent]);
});

test('G5 判定：缺 ctx / 缺 agent / ctx.get 不是函数 ⇒ false（判据缺失不注入）', () => {
  assert.equal(isPtcAgent(undefined, { id: 'a1' }), false);
  assert.equal(isPtcAgent({}, { id: 'a1' }), false);
  assert.equal(isPtcAgent({ get: () => ({ get: () => ({}) }) }, undefined), false);
  assert.equal(isPtcAgent({ get: () => ({ get: () => ({}) }) }, null), false);
});

// ── S 系列：正文常量 ──────────────────────────────────────────────────────────

test('S1 正文：非空、含关键锚点（Promise.all / run_code）', () => {
  assert.equal(typeof GUIDE_TEXT, 'string');
  assert.ok(GUIDE_TEXT.length > 0);
  assert.match(GUIDE_TEXT, /Promise\.all/);
  assert.match(GUIDE_TEXT, /run_code/);
});

test('S2 正文：讲的是判据与机制（并发 / 独占 / 上限），不是工具名单', () => {
  assert.match(GUIDE_TEXT, /并发/);
  assert.match(GUIDE_TEXT, /独占/);
  assert.match(GUIDE_TEXT, /上限/);
  // 不该出现的：写死的工具名（见 S3）、写死的并发上限数字。
  assert.doesNotMatch(GUIDE_TEXT, /最多\s*\d+\s*个/);
});

test('S3 防回归：GUIDE_TEXT 与 CLASSIFICATION_NOTE 里不得出现任何工具名', () => {
  assert.doesNotMatch(GUIDE_TEXT, TOOL_NAME_PATTERN);
  assert.doesNotMatch(CLASSIFICATION_NOTE, TOOL_NAME_PATTERN);
});

test('S4 过渡句：CLASSIFICATION_NOTE 非空，且说明清单是现算的', () => {
  assert.equal(typeof CLASSIFICATION_NOTE, 'string');
  assert.ok(CLASSIFICATION_NOTE.trim().length > 0);
  assert.match(CLASSIFICATION_NOTE, /现算/);
});

// ── L 系列：动态工具清单（分类 → 渲染 → 组装）────────────────────────────────

/** 造一个假的 tools 服务：view(scope) 返回该 scope 的可见工具集合。 */
function fakeTools(entries, options = {}) {
  return {
    view: (scope) => {
      if (options.throwOnView) throw new Error('boom: view');
      return { visible: new Map(entries), scope };
    },
  };
}

test('L1 分类：有并发安全声明 ⇒ 可并发；没有 ⇒ 独占；run_code 自己不进任何一列', () => {
  const classified = classifyVisibleTools(new Map([
    ['read', { isConcurrencySafe: () => true }],
    ['pwsh', {}],
    ['run_code', { isConcurrencySafe: () => true }],
  ]));
  assert.deepEqual(classified.parallel, ['read']);
  assert.deepEqual(classified.exclusive, ['pwsh']);
});

test('L2 分类：两列都按名称排序（输出稳定，不随迭代顺序抖）', () => {
  const classified = classifyVisibleTools(new Map([
    ['zeta', { isConcurrencySafe: () => true }],
    ['alpha', {}],
    ['mid', { isConcurrencySafe: () => true }],
    ['beta', {}],
  ]));
  assert.deepEqual(classified.parallel, ['mid', 'zeta']);
  assert.deepEqual(classified.exclusive, ['alpha', 'beta']);
});

test('L3 分类：isConcurrencySafe 存在但不是函数 ⇒ 归独占（形状不对就兜底）', () => {
  const classified = classifyVisibleTools(new Map([
    ['weird', { isConcurrencySafe: 'yes' }],
  ]));
  assert.deepEqual(classified.parallel, []);
  assert.deepEqual(classified.exclusive, ['weird']);
});

test('L4 分类：只回答"有没有声明"，绝不调用 isConcurrencySafe（无参探测会误判）', () => {
  let called = 0;
  const classified = classifyVisibleTools(new Map([
    ['strict', { isConcurrencySafe: () => { called += 1; return false; } }],
  ]));
  assert.equal(called, 0);
  assert.deepEqual(classified.parallel, ['strict']);
});

test('L5 分类：入参不是可迭代集合 ⇒ 两列都空（不猜、不补默认值）', () => {
  assert.deepEqual(classifyVisibleTools(undefined), { parallel: [], exclusive: [] });
  assert.deepEqual(classifyVisibleTools(null), { parallel: [], exclusive: [] });
  assert.deepEqual(classifyVisibleTools(42), { parallel: [], exclusive: [] });
});

test('L6 渲染：两列各出一行，工具名用反引号包着；空列不渲染', () => {
  const rendered = renderToolLists({ parallel: ['read'], exclusive: ['pwsh'] });
  const lines = rendered.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /本次可并发/);
  assert.ok(lines[0].includes(BT + 'read' + BT));
  assert.match(lines[1], /本次独占/);
  assert.ok(lines[1].includes(BT + 'pwsh' + BT));
  // 一列为空时不渲那一行
  const onlyOne = renderToolLists({ parallel: ['read'], exclusive: [] });
  assert.equal(onlyOne.split('\n').length, 1);
  assert.equal(renderToolLists({ parallel: [], exclusive: [] }), '');
});

test('L7 组装：混合定义 ⇒ 指引 + 过渡句 + 两列清单（run_code 不出现在清单里）', () => {
  const tools = fakeTools([
    ['read', { isConcurrencySafe: () => true }],
    ['pwsh', {}],
    ['run_code', {}],
  ]);
  const out = guideTextFor({ ctx: { get: (n) => (n === 'tools' ? tools : undefined) }, scope: { id: 'a1' } });
  assert.ok(out.startsWith(GUIDE_TEXT.trimEnd()));
  assert.ok(out.includes(CLASSIFICATION_NOTE.trimEnd()));
  assert.ok(out.includes(BT + 'read' + BT));
  assert.ok(out.includes(BT + 'pwsh' + BT));
  // 清单里不该出现 run_code（它不是"可并发/独占"的被调度对象）
  const listPart = out.slice(out.indexOf(CLASSIFICATION_NOTE.trimEnd()));
  assert.doesNotMatch(listPart, /run_code/);
});

test('L8 组装：tools 服务不存在 ⇒ 只返回 GUIDE_TEXT（没有清单）', () => {
  const out = guideTextFor({ ctx: { get: () => undefined }, scope: { id: 'a1' } });
  assert.equal(out, GUIDE_TEXT);
  assert.ok(!out.includes(CLASSIFICATION_NOTE.trimEnd()));
});

test('L9 组装：view 抛错 ⇒ 只返回 GUIDE_TEXT，不外抛', () => {
  const tools = fakeTools([], { throwOnView: true });
  const ctx = { get: (n) => (n === 'tools' ? tools : undefined) };
  let out = null;
  assert.doesNotThrow(() => { out = guideTextFor({ ctx, scope: { id: 'a1' } }); });
  assert.equal(out, GUIDE_TEXT);
});

test('L10 组装：可见工具为空 ⇒ 只返回 GUIDE_TEXT（清单整节不渲染）', () => {
  const tools = fakeTools([]);
  const out = guideTextFor({ ctx: { get: (n) => (n === 'tools' ? tools : undefined) }, scope: { id: 'a1' } });
  assert.equal(out, GUIDE_TEXT);
});

test('L11 组装：scope 原样传给 tools.view（拿到的是那个 agent 自己的视图）', () => {
  const seen = [];
  const tools = {
    view: (scope) => {
      seen.push(scope);
      return { visible: new Map([['read', { isConcurrencySafe: () => true }]]) };
    },
  };
  const scope = { id: 'a1' };
  guideTextFor({ ctx: { get: (n) => (n === 'tools' ? tools : undefined) }, scope });
  assert.deepEqual(seen, [scope]);
});

// ── W 系列：接线层（假 ctx，不 import cordis）─────────────────────────────────

/** 收集 effect/on 调用的最小假 ctx：只实现 apply() 真正用到的 effect / on / get。 */
function fakeCtx(tools) {
  const listeners = [];
  const effects = [];
  const off = (handler) => () => {
    const index = listeners.findIndex((entry) => entry.handler === handler);
    if (index >= 0) listeners.splice(index, 1);
  };
  const ctx = {
    listeners,
    effects,
    get: (service) => (service === 'tools' ? tools : undefined),
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

/** 假 agent：只带 ctx.systemPrompt.section 的记录口。 */
function fakeAgent() {
  const sections = [];
  return {
    sections,
    ctx: {
      systemPrompt: {
        section: (spec) => {
          sections.push(spec);
          return spec;
        },
      },
    },
  };
}

test('W1 契约三件套：name / inject / apply 齐且形状正确', () => {
  assert.equal(name, 'adg-ptc-parallel');
  assert.deepEqual(inject, ['systemPrompt']);
  assert.equal(typeof apply, 'function');
});

test('W2 挂载：恰好注册一个 agent/created 监听器，effect 标签在位', () => {
  const ctx = fakeCtx({ get: () => undefined });
  apply(ctx);
  assert.equal(ctx.listeners.length, 1);
  assert.equal(ctx.listeners[0].event, 'agent/created');
  assert.ok(ctx.effects.includes('adg-ptc-parallel.section()'));
});

test('W3 调用：PTC 呈现的 agent 在自己的 scope 上注册了 section（name / order / 正文）', () => {
  const ctx = fakeCtx({ get: () => ({ name: 'run_code' }) });
  apply(ctx);
  const agent = fakeAgent();
  ctx.listeners[0].handler({ agent });
  assert.equal(agent.sections.length, 1);
  assert.equal(agent.sections[0].name, 'adg:ptc-parallel');
  assert.equal(agent.sections[0].order, 810);
  // 假 tools 没有 view ⇒ 现算失败 ⇒ 退回 GUIDE_TEXT
  assert.equal(agent.sections[0].text(), GUIDE_TEXT);
});

test('W4 调用：非 PTC 呈现的 agent 不注册任何 section', () => {
  const ctx = fakeCtx({ get: () => undefined });
  apply(ctx);
  const agent = fakeAgent();
  ctx.listeners[0].handler({ agent });
  assert.equal(agent.sections.length, 0);
});

test('W5 调用：payload 里没有 agent 时不注册、也不抛错', () => {
  const ctx = fakeCtx({ get: () => ({ name: 'run_code' }) });
  apply(ctx);
  const { handler } = ctx.listeners[0];
  assert.doesNotThrow(() => handler(undefined));
  assert.doesNotThrow(() => handler({}));
});

test('W6 调用：判定抛错时不外抛（异常一律当作"不是 PTC"）', () => {
  const ctx = fakeCtx({
    get: () => {
      throw new Error('boom');
    },
  });
  apply(ctx);
  const agent = fakeAgent();
  assert.doesNotThrow(() => ctx.listeners[0].handler({ agent }));
  assert.equal(agent.sections.length, 0);
});

test('W7 卸载：effect 返回的 disposer 移除监听器', () => {
  const ctx = fakeCtx({ get: () => undefined });
  apply(ctx);
  assert.equal(ctx.listeners.length, 1);
  const disposer = ctx.lastDisposer;
  assert.equal(typeof disposer, 'function');
  disposer();
  assert.equal(ctx.listeners.length, 0);
});

test('W8 调用：section 的 text 是 provider（吃 context），清单随组装现算', () => {
  const tools = fakeTools([
    ['read', { isConcurrencySafe: () => true }],
    ['pwsh', {}],
  ]);
  const ctx = fakeCtx({
    get: (name_, scope) => (name_ === 'run_code' ? { name: 'run_code' } : undefined),
    view: tools.view,
  });
  apply(ctx);
  const agent = fakeAgent();
  ctx.listeners[0].handler({ agent });
  assert.equal(agent.sections.length, 1);
  const text = agent.sections[0].text;
  assert.equal(typeof text, 'function');
  const rendered = text({ scope: agent });
  assert.ok(rendered.includes(CLASSIFICATION_NOTE.trimEnd()));
  assert.ok(rendered.includes(BT + 'read' + BT));
  assert.ok(rendered.includes(BT + 'pwsh' + BT));
});

// ── C 系列：文件契约（逐字一致性，防漂移）────────────────────────────────────

test('C1 契约：cordis.patch.yml 的 insert id 与 index.mjs 的 export const name 一致', () => {
  const patch = readModuleFile('cordis.patch.yml');
  const match = patch.match(/- id: (\S+)/);
  assert.ok(match, 'cordis.patch.yml 里没有 - id: 行');
  assert.equal(match[1], 'adg-ptc-parallel');
  assert.equal(name, match[1]);
  // insert 行的两个键：id 与 name（与 skill-inject/cordis.patch.yml 同形，name 与 id 同级）
  assert.match(patch, /name: adg-ptc-parallel/);
});

test('C2 契约：package.json 的 name 与 index.mjs 的 export const name 一致', () => {
  const pkg = JSON.parse(readModuleFile('package.json'));
  assert.equal(pkg.name, 'adg-ptc-parallel');
  assert.equal(pkg.name, name);
  assert.equal(pkg.main, './index.mjs');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
});

test('C3 契约：index.mjs 源码里出现 section name 与 order', () => {
  const source = readModuleFile('index.mjs');
  assert.match(source, /export const name = 'adg-ptc-parallel'/);
  assert.match(source, /'adg:ptc-parallel'/);
  assert.match(source, /810/);
});

test('C4 契约：index.mjs 里的 text 是吃 context 的 provider，不是常量字符串', () => {
  const source = readModuleFile('index.mjs');
  assert.match(source, /text: \(context\) =>/);
  assert.match(source, /guideTextFor\(\{ ctx, scope: context\?\.scope \?\? context\?\.agent \}\)/);
});

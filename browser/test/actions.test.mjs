// `browser/` 动作面与判据层的单测：**零依赖、零副作用**（不起浏览器、不联网、不读写 profile）。
//
// 全部用"罐装读数 + 假 session"跑：`session.evalJs` 按表达式里的标记返回预先排好的读数，
// `session.send` 只把 CDP 调用记下来。这样五条命令的用法错误面、判据三态、以及
// "unknown 不许报成 false" 都能在毫秒级钉住。
//
// 跑法：`cd browser && node --test test`（沙箱里加 `--test-isolation=none`）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  ACTION_CRITERIA,
  INVISIBLE_TAIL,
  KINDS,
  captureState,
  changeVerdict,
  compareStates,
  digestOf,
  hashText,
  kindReadable,
  normalizeState,
  normalizeTabs,
  stateExpr,
  verdictWarn,
} from '../lib/verify.mjs';
import {
  COMMAND_FLAGS,
  UsageError,
  allowedFlags,
  checkFlagScope,
  checkPageScope,
  clickSpec,
  decideSelect,
  hitScopeError,
  hoverSpec,
  matchHits,
  pageTarget,
  resolveExpr,
  runClick,
  runHover,
  runSelect,
  runType,
  runWaitFor,
  selectApplied,
  selectApplyExpr,
  selectProbeExpr,
  selectSpec,
  typeReadbackExpr,
  typeReadbackVerdict,
  typeSpec,
  waitForSpec,
} from '../lib/actions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib');

// ---------------------------------------------------------------------------
// 罐装读数与假 session
// ---------------------------------------------------------------------------

/** 页面探针的罐装返回值（`stateExpr` 的形状）。 */
function st(o = {}) {
  return {
    url: o.url ?? 'file:///fixture/index.html',
    title: o.title ?? 'fixture',
    hasFocus: o.hasFocus ?? true,
    domText: o.domText ?? 'before',
    domTruncated: o.domTruncated ?? false,
    scroll: o.scroll ?? [0, 0, 0, 0],
    active: o.active ?? 'body',
    element: o.element === undefined ? null : o.element,
  };
}

function el(o = {}) {
  return {
    exists: true,
    tag: 'input',
    visible: true,
    disabled: false,
    readOnly: false,
    editable: false,
    value: 'x',
    checked: null,
    selectedIndex: null,
    text: null,
    ...o,
  };
}

function resolveOk(o = {}) {
  return {
    found: true,
    selectorError: null,
    tag: 'button',
    visible: true,
    inViewport: true,
    scrolled: false,
    disabled: false,
    readOnly: false,
    editable: false,
    inputish: false,
    box: [100, 200, 20, 40],
    point: [110, 220],
    onScreen: true,
    hitDesc: 'button#go',
    hitIsTarget: true,
    ...o,
  };
}

const NOT_FOUND = { ...resolveOk(), found: false, tag: '', box: null, point: null, onScreen: false };

/**
 * 假 session：按表达式里的标记把 `plan` 里排好的读数一条条发出去。
 * 队列里放 `Error` 就抛（模拟探针失败 / 页面内抛错）。
 */
function makeSession(plan = {}) {
  const calls = { resolve: [], focus: [], select: [], selectProbe: [], selectApply: [], readback: [], state: [], poll: [], send: [] };
  const seen = { resolve: null, focus: null, selectProbe: null, selectApply: null, readback: null, state: null, poll: null };
  const take = (name) => {
    const q = plan[name];
    if (Array.isArray(q) && q.length > 0) {
      const v = q.shift();
      if (v instanceof Error) throw v;
      seen[name] = v;
      return v;
    }
    // 轮询与探针的调用次数取决于真实时钟，所以"队列发完就重复最后一次读数"，
    // 用例的结果才不随机器快慢漂移（要制造失败就往队列里放 Error）。
    if (seen[name] !== null) return seen[name];
    throw new Error(`假 session 没有 ${name} 的读数了`);
  };
  return {
    calls,
    async evalJs(expr) {
      if (expr.includes('hitIsTarget')) {
        calls.resolve.push(expr);
        return take('resolve');
      }
      if (expr.includes('out.focused')) {
        calls.focus.push(expr);
        return take('focus');
      }
      if (expr.includes('adg-select-probe')) {
        calls.selectProbe.push(expr);
        calls.select.push(expr);
        return take('selectProbe');
      }
      if (expr.includes('adg-select-apply')) {
        calls.selectApply.push(expr);
        calls.select.push(expr);
        return take('selectApply');
      }
      if (expr.includes('adg-type-readback')) {
        calls.readback.push(expr);
        return take('readback');
      }
      if (expr.includes('MAXTEXT')) {
        calls.state.push(expr);
        return take('state');
      }
      if (expr.includes('satisfied')) {
        calls.poll.push(expr);
        return take('poll');
      }
      throw new Error('假 session 收到了不认识的表达式');
    },
    async send(method, params) {
      calls.send.push({ method, params });
    },
  };
}

function collector() {
  const lines = [];
  const out = (line) => lines.push(String(line));
  out.lines = lines;
  out.text = () => lines.join('\n');
  out.has = (prefix) => lines.some((l) => l.startsWith(prefix));
  out.get = (prefix) => lines.find((l) => l.startsWith(prefix));
  return out;
}

/** `KEY=value` → value（用于断言读数行）。 */
function valueOf(out, key) {
  const line = out.get(`${key}=`);
  assert.ok(line, `输出里没有 ${key}= 这一行：\n${out.text()}`);
  return line.slice(key.length + 1);
}

const usage = async (fn, needle) => {
  await assert.rejects(fn, (e) => {
    assert.ok(e instanceof UsageError, `期望用法错（退出码 2），实际是：${e?.message}`);
    if (needle) assert.match(e.message, needle);
    return true;
  });
};

const runtime = async (fn, needle) => {
  await assert.rejects(fn, (e) => {
    assert.equal(e instanceof UsageError, false, `期望运行期错误（退出码 1），实际是用法错：${e?.message}`);
    if (needle) assert.match(e.message, needle);
    return true;
  });
};

// ---------------------------------------------------------------------------
// 判据层：三态（design.md I14）
// ---------------------------------------------------------------------------

test('I14 hashText：FNV-1a 32 位、8 位十六进制、同输入同输出、异输入异输出', () => {
  assert.equal(hashText(''), '811c9dc5');
  assert.equal(hashText('a'), hashText('a'));
  assert.notEqual(hashText('a'), hashText('b'));
  assert.match(hashText('中文 input'), /^[0-9a-f]{8}$/);
  // 按 UTF-8 字节跑：CJK 与它的代理对写法不是一个东西（口径与 desktop 的 fnv1a32 一致）。
  assert.notEqual(hashText('中'), hashText('\u4e2d\u4e2d'));
});

test('I14 normalizeState：缺字段一律补空值，绝不补"猜的值"', () => {
  const s = normalizeState({}, { selector: null });
  assert.equal(s.ok, true);
  assert.equal(s.url, '');
  assert.equal(s.title, '');
  assert.equal(s.hasFocus, null);
  assert.equal(s.elem, null);
  assert.equal(s.tabs.ok, false);
  assert.equal(s.tabs.count, null);
  const e = normalizeState({ element: { exists: false } }, { selector: '#x' });
  assert.deepEqual(e.elem, { exists: false });
});

test('I14 normalizeState：探针没返回对象 ⇒ ok:false + 原因，不是"没有变化"', () => {
  assert.equal(normalizeState(null).ok, false);
  assert.match(normalizeState(null).error, /没有返回对象/);
  assert.equal(normalizeState('nope').ok, false);
});

test('I14 normalizeTabs：读不到与"读到 0 个"必须分开', () => {
  assert.deepEqual(normalizeTabs(null), { ok: false, count: null, error: '标签页列表不是数组' });
  assert.equal(normalizeTabs([]).ok, true);
  assert.equal(normalizeTabs([]).count, 0);
  const list = [
    { type: 'page', url: 'file:///a', webSocketDebuggerUrl: 'ws://x/1' },
    { type: 'page', url: 'devtools://devtools/bundled/x', webSocketDebuggerUrl: 'ws://x/2' },
    { type: 'service_worker', url: 'file:///a', webSocketDebuggerUrl: 'ws://x/3' },
    { type: 'page', url: 'file:///b', webSocketDebuggerUrl: '' },
  ];
  assert.equal(normalizeTabs(list).count, 1);
});

test('I14 kindReadable：读不到 ≠ 没变化（unknown 的唯一来源）', () => {
  const noSel = normalizeState(st(), { selector: null });
  assert.equal(kindReadable(noSel, 'dom'), true);
  assert.equal(kindReadable(noSel, 'elem'), false, '没给选择器就没有元素读数');
  assert.equal(kindReadable(noSel, 'tabs'), false, 'listTabs 没给 ⇒ tabs 这一类缺测');

  const miss = normalizeState(st({ element: { exists: false } }), { selector: '#x' });
  assert.equal(kindReadable(miss, 'elem'), true);
  assert.equal(kindReadable(miss, 'value'), false);
  assert.equal(kindReadable(miss, 'selected'), false);
  assert.equal(kindReadable(miss, 'elemtext'), false);

  const input = normalizeState(st({ element: el() }), { selector: '#x' });
  assert.equal(kindReadable(input, 'value'), true, 'input 有 value 这一类');
  assert.equal(kindReadable(input, 'elemtext'), false, 'input 不是 contenteditable ⇒ 文本那一类缺测');
  assert.equal(kindReadable(input, 'selected'), false, 'input 没有 selectedIndex');

  const editable = normalizeState(st({ element: el({ tag: 'div', editable: true, value: null, text: 'hi' }) }), {
    selector: '#x',
  });
  assert.equal(kindReadable(editable, 'elemtext'), true);
  assert.equal(kindReadable(editable, 'value'), false);

  const failed = normalizeState(null, { selector: '#x' });
  for (const k of KINDS) assert.equal(kindReadable(failed, k), false, `${k} 在探针失败时必须是缺测`);
});

test('I14 compareStates：探针失败整份退出比较（读不到 ≠ 读到了没变）', () => {
  const a = normalizeState(st({ domText: 'A' }), { selector: null });
  const b = normalizeState(st({ domText: 'A' }), { selector: null });
  assert.equal(compareStates(a, b).changed, false);

  const c = normalizeState(st({ domText: 'B' }), { selector: null });
  const cmp = compareStates(a, c);
  assert.equal(cmp.changed, true);
  assert.deepEqual([...new Set(cmp.reasons.map((r) => r.kind))], ['dom']);

  const bad = normalizeState(null, { selector: null });
  const cmp2 = compareStates(a, bad);
  assert.equal(cmp2.probeFailed, true);
  assert.equal(cmp2.changed, false, '探针失败时差异集合为空（整份退出比较）');
  assert.equal(changeVerdict(cmp2, { needsKinds: ['dom'] }).changed, 'unknown');
});

test('I14 compareStates：ignore 掉的类不参与（type/select 的 focus 会动 active，它不承载输入效果）', () => {
  const a = normalizeState(st({ active: 'body', element: el({ value: 'x' }) }), { selector: '#q' });
  const b = normalizeState(st({ active: 'input#q', element: el({ value: 'x' }) }), { selector: '#q' });
  assert.equal(compareStates(a, b).changed, true);
  assert.equal(compareStates(a, b, { ignore: ['active'] }).changed, false);
  assert.deepEqual(compareStates(a, b, { ignore: ['active'] }).reasons, []);
  // 判据本身看得见 value 这一类，所以"都没变"才能报 false。
  assert.equal(changeVerdict(compareStates(a, b, { ignore: ['active'] }), ACTION_CRITERIA.type).changed, 'false');
});

test('I14 changeVerdict：有差异 ⇒ true（唯一能正面证明生效的读数）', () => {
  const a = normalizeState(st({ domText: 'A' }), { selector: null });
  const b = normalizeState(st({ domText: 'B' }), { selector: null });
  const v = changeVerdict(compareStates(a, b), ACTION_CRITERIA.click);
  assert.equal(v.changed, 'true');
  assert.deepEqual(v.kinds, ['dom']);
  assert.match(v.reason, /可观测差异/);
});

test('I14 changeVerdict：读到了、可比、都没变 ⇒ false', () => {
  const a = normalizeState(st({ domText: 'A', element: el({ value: 'x' }) }), { selector: '#q' });
  const b = normalizeState(st({ domText: 'A', element: el({ value: 'x' }) }), { selector: '#q' });
  const v = changeVerdict(compareStates(a, b, { ignore: ACTION_CRITERIA.type.ignore }), ACTION_CRITERIA.type);
  assert.equal(v.changed, 'false');
  assert.match(v.reason, /都没有变化/);
});

test('I14 changeVerdict：type 的专属判据两端都读不到 ⇒ unknown，**不许报 false**', () => {
  // 元素根本不存在：value / elemtext 两类都读不到。DOM 读得到、而且没变 —— 这时报 false 会把
  // "我们看不见输入类效果"说成"输入没生效"。这正是 desktop 红线 1 那条。
  const a = normalizeState(st({ domText: 'A', element: { exists: false } }), { selector: '#q' });
  const b = normalizeState(st({ domText: 'A', element: { exists: false } }), { selector: '#q' });
  const cmp = compareStates(a, b, { ignore: ACTION_CRITERIA.type.ignore });
  const v = changeVerdict(cmp, ACTION_CRITERIA.type);
  assert.equal(v.changed, 'unknown');
  assert.match(v.reason, /读不到/);
  assert.match(verdictWarn('type', v, cmp), /绝不许报 false|绝不等价/);
});

test('I14 changeVerdict：select 的判据缺测 ⇒ unknown（两端都读不到 selected/value）', () => {
  const a = normalizeState(st({ element: el({ tag: 'div', value: null }) }), { selector: '#s' });
  const b = normalizeState(st({ element: el({ tag: 'div', value: null }) }), { selector: '#s' });
  const v = changeVerdict(compareStates(a, b, { ignore: ACTION_CRITERIA.select.ignore }), ACTION_CRITERIA.select);
  assert.equal(v.changed, 'unknown');
});

test('I14 changeVerdict：click 的专属判据缺测（tabs 读不到、DOM 探针也失败）⇒ unknown', () => {
  const failed = normalizeState(null, { selector: null });
  const ok = normalizeState(st(), { selector: null });
  const v = changeVerdict(compareStates(failed, ok), ACTION_CRITERIA.click);
  assert.equal(v.changed, 'unknown');
  assert.match(v.reason, /探针失败/);
});

test('I14 changeVerdict：click 有差异但 tabs 这一类读不到 ⇒ 仍是 true（差异优先）', () => {
  const a = normalizeState(st({ url: 'file:///a' }), { selector: null });
  const b = normalizeState(st({ url: 'file:///b' }), { selector: null });
  assert.equal(a.tabs.ok, false);
  const v = changeVerdict(compareStates(a, b), ACTION_CRITERIA.click);
  assert.equal(v.changed, 'true');
  assert.deepEqual(v.kinds, ['url']);
});

test('I14 verdictWarn：只描述现象，不下"成功/失败"结论；true 不给引导句', () => {
  const a = normalizeState(st({ domText: 'A' }), { selector: null });
  const b = normalizeState(st({ domText: 'B' }), { selector: null });
  const cmp = compareStates(a, b);
  assert.equal(verdictWarn('click', changeVerdict(cmp, ACTION_CRITERIA.click), cmp), null);

  const cmpNo = compareStates(a, normalizeState(st({ domText: 'A' }), { selector: null }));
  const warnFalse = verdictWarn('click', changeVerdict(cmpNo, ACTION_CRITERIA.click), cmpNo);
  assert.match(warnFalse, /绝不等于/);
  assert.match(warnFalse, /不生效|生效/);
  // 每条命令的引导句分开写：不许让 click 挂上 type 的话（写错方向比不写更坏）。
  const seen = new Set();
  for (const cmd of ['click', 'hover', 'type', 'select', 'wait-for']) {
    const w = verdictWarn(cmd, changeVerdict(cmpNo, ACTION_CRITERIA[cmd]), cmpNo);
    assert.ok(w.length > 20, `${cmd} 的引导句太短`);
    // 判据域边界那一句（只改元素属性 / `class` / `style` ⇒ 必然读成"没有差异"）五条命令都必须带：
    // 它与 `design.md` 的「判据域」、`testing-guide.md` 的漏报面条目三处口径一致（N5）。
    assert.match(w, /属性/, `${cmd} 的引导句没点名"只改属性 / class / style"这类最常见的漏报面`);
    assert.equal(seen.has(INVISIBLE_TAIL[cmd]), false, `${cmd} 的引导句与别的命令重复了`);
    seen.add(INVISIBLE_TAIL[cmd]);
  }
});

test('I14 digestOf：一行摘要，够肉眼比对又不撑爆输出', () => {
  const s = normalizeState(st({ element: el({ value: 'hello' }) }), { selector: '#q' });
  const d = digestOf(s);
  for (const key of ['ok=', 'url=', 'title=', 'dom=', 'scroll=', 'active=', 'tabs=', 'elem=', 'value=', 'checked=', 'selected=', 'elemtext=']) {
    assert.ok(d.includes(key), `摘要里缺 ${key}：${d}`);
  }
  const noSel = digestOf(normalizeState(st(), { selector: null }));
  assert.ok(noSel.includes('elem=n/a'));
});

test('I14 stateExpr：不给选择器时元素读数整段跳过（运行期不读，不是读成"不存在"）', () => {
  const noSel = stateExpr(null);
  assert.match(noSel, /const SEL = null;/);
  assert.ok(noSel.includes('if (SEL !== null) {'), '元素读数必须在 if (SEL !== null) 里 —— 没给选择器就整段不执行');
  assert.ok(noSel.indexOf('out.element = null;') < noSel.indexOf('if (SEL !== null) {'), '先置 null，再按需覆盖');
  assert.match(stateExpr('#q'), /const SEL = "#q";/);
  assert.ok(stateExpr('a[href="x"]').includes('"a[href=\\"x\\"]"'), '选择器要按 JSON 转义后嵌进表达式');
  // 命中测试是 click 那条路（resolveExpr）的事，状态探针里不该有它。
  assert.match(resolveExpr('#q'), /elementFromPoint/);
  assert.equal(/elementFromPoint/.test(stateExpr('#q')), false);
});

// ---------------------------------------------------------------------------
// 动作层：用法错误面（退出码 2）
// ---------------------------------------------------------------------------

test('I12 每条命令一份开关清单：用不上的开关必须报用法错，不许静默忽略', () => {
  assert.equal(allowedFlags('nosuchcmd'), null, '不认识的命令不猜清单');
  assert.ok(allowedFlags('click').has('selector'));
  assert.ok(allowedFlags('click').has('settle'));
  assert.equal(allowedFlags('click').has('text'), false);
  assert.ok(allowedFlags('launch').has('wait'));
  for (const cmd of Object.keys(COMMAND_FLAGS)) assert.ok(allowedFlags(cmd).has('port'));

  assert.throws(
    () => checkFlagScope({ _: ['click'], urls: [], selector: '#a', dryrun: true }, 'click'),
    (e) => {
      assert.ok(e instanceof UsageError);
      assert.match(e.message, /click 不认识开关：--dryrun（这条命令认识：/);
      return true;
    },
  );
  assert.throws(() => checkFlagScope({ _: ['close'], urls: [], selector: '#a' }, 'close'), UsageError);
  assert.throws(() => checkFlagScope({ _: ['status'], urls: ['file:///a'] }, 'status'), UsageError);
  assert.doesNotThrow(() => checkFlagScope({ _: ['click'], urls: [], match: 'fixture' }, 'click'));
  assert.doesNotThrow(() => checkFlagScope({ _: ['shot'], urls: [], url: undefined, out: 'a.png', full: true }, 'shot'));
});

test('I17 动作类命令选页方式只能给一个，且只接受一个 --url', () => {
  assert.throws(
    () => checkPageScope({ _: ['click'], urls: ['file:///a'], match: 'fixture' }, 'click'),
    /选页方式只能给一个（收到 --url \+ --match）/,
  );
  assert.throws(
    () => checkFlagScope({ _: ['click'], urls: ['file:///a', 'file:///b'] }, 'click'),
    /只接受一个 --url/,
  );
  assert.doesNotThrow(() => checkPageScope({ _: ['click'], urls: [], tab: '2' }, 'click'));
});

test('I17 pageTarget：三条选页路都不给就是 0 号页；非法值一律报用法错', () => {
  assert.deepEqual(pageTarget({ _: ['click'], urls: [] }), { index: 0 });
  assert.deepEqual(pageTarget({ _: ['click'], urls: ['file:///a'] }), { match: 'file:///a', flag: '--url' });
  assert.deepEqual(pageTarget({ _: ['click'], urls: [], match: 'fix' }), { match: 'fix', flag: '--match' });
  assert.deepEqual(pageTarget({ _: ['click'], urls: [], tab: '3' }), { index: 3 });
  assert.throws(() => pageTarget({ _: ['click'], urls: [], tab: '-1' }), /--tab 必须是 >= 0 的整数/);
  assert.throws(() => pageTarget({ _: ['click'], urls: [], tab: true }), /--tab 后面缺少序号/);
  assert.throws(() => pageTarget({ _: ['click'], urls: [], match: true }), /--match 后面缺少子串/);
});

test('I17 选页：`--url` 与 `--match` 同为子串命中，拒发文案报的是**实际给的那个**开关（G4）', () => {
  // 三条路的口径：`--url` 不是"精确命中"，它和 `--match` 走同一条 `includes` 路（cdp.pickPage 同款）。
  const u = hitScopeError('--url', 'file:///a/', 2);
  assert.match(u, /^--url file:\/\/\/a\/ 命中 2 页/);
  assert.match(u, /唯一命中/);
  assert.match(u, /--tab/);
  assert.equal(u.includes('--match'), false, '用 --url 给的不许报成 --match：调用方会去找一个自己没给过的开关');
  assert.equal(u.includes('完整地址'), false, '不许再把"更完整的地址"当解药 —— --url 也是子串命中，不保证唯一');
  const m = hitScopeError('--match', 'fix', 3);
  assert.match(m, /^--match fix 命中 3 页/);
  assert.equal(m.includes('--url'), false);
});

test('I17 matchHits：`--match` 命中多页就是要拒发的那一类（动作面不取第一个命中）', () => {
  const pages = [
    { url: 'file:///a/fixture.html', title: 'adg browser fixture' },
    { url: 'file:///b/other.html', title: '别的页' },
    { url: 'file:///c/fixture-2.html', title: 'still fixture' },
  ];
  assert.equal(matchHits(pages, 'fixture').length, 2, 'url 命中一页、title 命中另一页');
  assert.deepEqual(matchHits(pages, 'a/fixture').map((p) => p.title), ['adg browser fixture']);
  assert.equal(matchHits(pages, '没有这个').length, 0);
  assert.equal(matchHits(null, 'x').length, 0, '读不到页面列表时不许当成"命中一页"');
});

test('I12 click 的用法错误面', () => {
  assert.throws(() => clickSpec({ _: ['click'], urls: [] }), /需要 --selector/);
  assert.throws(() => clickSpec({ _: ['click'], urls: [], selector: true }), /--selector 后面缺少 CSS 选择器/);
  assert.throws(() => clickSpec({ _: ['click'], urls: [], _2: 0, selector: '#a', settle: 'abc' }), /--settle 必须是/);
  assert.throws(() => clickSpec({ _: ['click'], urls: [], selector: '#a', force: 'yes' }), /--force 是开关/);
  assert.throws(() => clickSpec({ _: ['click', '#a', '#b', '#c'], urls: [] }), /不认识多余的位置参数/);
  assert.deepEqual(clickSpec({ _: ['click'], urls: [], selector: '#a' }), {
    selector: '#a',
    force: false,
    settleMs: 150,
  });
  assert.deepEqual(clickSpec({ _: ['click', '#b'], urls: [], force: true, settle: '0' }), {
    selector: '#b',
    force: true,
    settleMs: 0,
  });
});

test('I12 type 的用法错误面（含"空字符串拒绝执行"）', () => {
  assert.throws(() => typeSpec({ _: ['type'], urls: [], selector: '#q' }), /需要 --text/);
  assert.throws(() => typeSpec({ _: ['type'], urls: [], selector: '#q', text: true }), /--text 后面缺少字符串/);
  assert.throws(
    () => typeSpec({ _: ['type'], urls: [], selector: '#q', text: '' }),
    /--text 是空字符串/,
  );
  assert.throws(() => typeSpec({ _: ['type'], urls: [], selector: '#q', text: 'a', clear: 'true' }), /--clear 是开关/);
  const spec = typeSpec({ _: ['type'], urls: [], selector: '#q', text: '你好', clear: true });
  assert.deepEqual(spec, { selector: '#q', text: '你好', clear: true, settleMs: 150 });
});

test('I12 select 的用法错误面', () => {
  assert.throws(() => selectSpec({ _: ['select'], urls: [], selector: '#s' }), /需要 --value/);
  assert.throws(() => selectSpec({ _: ['select'], urls: [], selector: '#s', value: true }), /--value 后面缺少字符串/);
  assert.deepEqual(selectSpec({ _: ['select'], urls: [], selector: '#s', value: 'b' }), {
    selector: '#s',
    value: 'b',
    settleMs: 150,
  });
});

test('I15 wait-for 的用法错误面：条件三选一、超时与轮询间隔必须有、--js 语法当场判', () => {
  assert.throws(() => waitForSpec({ _: ['wait-for'], urls: [] }), /需要三个条件之一/);
  assert.throws(
    () => waitForSpec({ _: ['wait-for'], urls: [], selector: '#a', js: 'true' }),
    /条件只能给一个（收到 --selector \+ --js）/,
  );
  assert.throws(() => waitForSpec({ _: ['wait-for'], urls: [], 'url-match': 'x', visible: true }), /--visible 只跟 --selector 一起用/);
  assert.throws(() => waitForSpec({ _: ['wait-for'], urls: [], 'url-match': '' }), /--url-match 是空字符串/);
  assert.throws(() => waitForSpec({ _: ['wait-for'], urls: [], js: 'true', visible: true }), /--visible 只跟 --selector 一起用/);
  assert.throws(() => waitForSpec({ _: ['wait-for'], urls: [], selector: '#a', timeout: '0' }), /--timeout 必须是/);
  assert.throws(() => waitForSpec({ _: ['wait-for'], urls: [], selector: '#a', interval: 'x' }), /--interval 必须是/);
  assert.throws(() => waitForSpec({ _: ['wait-for'], urls: [], js: '1 +' }), /--js 不是合法表达式/);

  assert.deepEqual(waitForSpec({ _: ['wait-for'], urls: [], selector: '#a' }), {
    cond: 'selector',
    selector: '#a',
    requireVisible: false,
    timeoutMs: 10000,
    intervalMs: 200,
  });
  assert.deepEqual(waitForSpec({ _: ['wait-for'], urls: [], selector: '#a', visible: true, timeout: '50', interval: '5' }), {
    cond: 'selector',
    selector: '#a',
    requireVisible: true,
    timeoutMs: 50,
    intervalMs: 5,
  });
  assert.deepEqual(waitForSpec({ _: ['wait-for'], urls: [], 'url-match': 'ok.html' }), {
    cond: 'url',
    urlMatch: 'ok.html',
    timeoutMs: 10000,
    intervalMs: 200,
  });
  assert.deepEqual(waitForSpec({ _: ['wait-for'], urls: [], js: 'window.__done === true' }), {
    cond: 'js',
    js: 'window.__done === true',
    timeoutMs: 10000,
    intervalMs: 200,
  });
});

// ---------------------------------------------------------------------------
// 动作层：五条命令的执行体（假 session）
// ---------------------------------------------------------------------------

test('I13 click：几何 + 命中自检 + 真实鼠标事件 + 前后比对', async () => {
  const session = makeSession({
    resolve: [resolveOk()],
    state: [st({ domText: '计数=0' }), st({ domText: '计数=1' })],
  });
  const out = collector();
  const verdict = await runClick({ session, spec: clickSpec({ _: ['click'], urls: [], selector: '#go' }), out });
  assert.equal(verdict.changed, 'true');
  assert.equal(valueOf(out, 'HIT_IS_TARGET'), 'true');
  assert.equal(valueOf(out, 'VISIBLE'), 'true');
  assert.equal(valueOf(out, 'POINT'), '110,220');
  assert.equal(valueOf(out, 'BOX'), '100,200,20,40');
  assert.equal(valueOf(out, 'CHANGED'), 'true');
  assert.equal(valueOf(out, 'DISPATCHED'), '2');
  assert.equal(session.calls.send.length, 2);
  assert.equal(session.calls.send[0].method, 'Input.dispatchMouseEvent');
  assert.equal(session.calls.send[0].params.type, 'mousePressed');
  assert.equal(session.calls.send[0].params.x, 110);
  assert.equal(session.calls.send[0].params.y, 220);
  assert.equal(session.calls.send[0].params.button, 'left');
  assert.equal(session.calls.send[1].params.type, 'mouseReleased');
  assert.equal(session.calls.send[1].params.buttons, 0);
});

test('I13 click：被遮挡时默认**不发事件**（用法错 2），--force 才照原样发', async () => {
  const spec = clickSpec({ _: ['click'], urls: [], selector: '#go' });
  const session = makeSession({ resolve: [resolveOk({ hitIsTarget: false, hitDesc: 'div#cover' })] });
  const out = collector();
  await usage(() => runClick({ session, spec, out }), /默认不发事件/);
  assert.equal(session.calls.send.length, 0, '拒发时一个 CDP 事件都不许发');
  assert.equal(valueOf(out, 'HIT_IS_TARGET'), 'false');
  assert.match(valueOf(out, 'WARN'), /命中的是 div#cover/);
  assert.equal(out.has('CHANGED='), false, '没发事件就不该有 CHANGED 读数');

  const forced = makeSession({
    resolve: [resolveOk({ hitIsTarget: false, hitDesc: 'div#cover' })],
    state: [st({ domText: 'A' }), st({ domText: 'B' })],
  });
  const out2 = collector();
  const v2 = await runClick({
    session: forced,
    spec: clickSpec({ _: ['click'], urls: [], selector: '#go', force: true }),
    out: out2,
  });
  assert.equal(v2.changed, 'true');
  assert.equal(forced.calls.send.length, 2, '--force 要真的发出去');
  assert.match(valueOf(out2, 'WARN'), /照原样发/);
});

test('I13 click：不可见 / 视口外 / 没匹配到 —— 三种都得说清且不发事件', async () => {
  const spec = clickSpec({ _: ['click'], urls: [], selector: '#go' });
  const invisible = makeSession({ resolve: [resolveOk({ visible: false, box: [0, 0, 0, 0], point: null, onScreen: false })] });
  await runtime(() => runClick({ session: invisible, spec, out: collector() }), /没有可点区域/);
  assert.equal(invisible.calls.send.length, 0);

  const offscreen = makeSession({ resolve: [resolveOk({ onScreen: false, point: null })] });
  await runtime(() => runClick({ session: offscreen, spec, out: collector() }), /不在视口内/);
  assert.equal(offscreen.calls.send.length, 0);

  const missing = makeSession({ resolve: [NOT_FOUND] });
  await runtime(() => runClick({ session: missing, spec, out: collector() }), /没有匹配到元素/);
  assert.equal(missing.calls.send.length, 0);

  const bad = makeSession({ resolve: [resolveOk({ found: false, selectorError: "'#(' is not a valid selector" })] });
  await usage(() => runClick({ session: bad, spec, out: collector() }), /选择器不合法/);
});

test('I13 click：命中读数缺失（elementFromPoint 没结果）⇒ unknown 而**不是**"点在目标上"', async () => {
  const session = makeSession({
    resolve: [resolveOk({ hitIsTarget: null, hitDesc: '' })],
    state: [st({ domText: 'A' }), st({ domText: 'A' })],
  });
  const out = collector();
  const v = await runClick({ session, spec: clickSpec({ _: ['click'], urls: [], selector: '#go' }), out });
  assert.equal(valueOf(out, 'HIT_IS_TARGET'), 'unknown');
  assert.match(valueOf(out, 'WARN'), /缺测不许读成"点在目标上"/);
  assert.equal(session.calls.send.length, 2, '缺测只提示，不拦（拦住会把"可能成功"当成"确定失败"）');
  assert.equal(v.changed, 'false', 'DOM 没变且读得到 ⇒ false');
});

test('I12 hover 的用法错误面：与 click 同一套口径（选择器 / --force 开关 / --settle / 位置参数）', () => {
  assert.throws(() => hoverSpec({ _: ['hover'], urls: [] }), /需要 --selector/);
  assert.throws(() => hoverSpec({ _: ['hover'], urls: [], selector: true }), /--selector 后面缺少 CSS 选择器/);
  assert.throws(() => hoverSpec({ _: ['hover'], urls: [], selector: '#a', settle: 'abc' }), /--settle 必须是/);
  assert.throws(() => hoverSpec({ _: ['hover'], urls: [], selector: '#a', force: 'yes' }), /--force 是开关/);
  assert.throws(() => hoverSpec({ _: ['hover', '#a', '#b', '#c'], urls: [] }), /不认识多余的位置参数/);
  // 别的动作命令的开关照旧不许混进来（I12）：hover 不是 click，也不认 --text / --value。
  assert.throws(
    () => checkFlagScope({ _: ['hover'], urls: [], selector: '#a', text: 'x' }, 'hover'),
    /hover 不认识开关：--text/,
  );
  assert.deepEqual(hoverSpec({ _: ['hover'], urls: [], selector: '#a' }), {
    selector: '#a',
    force: false,
    settleMs: 150,
  });
  assert.deepEqual(hoverSpec({ _: ['hover', '#b'], urls: [], force: true, settle: '0' }), {
    selector: '#b',
    force: true,
    settleMs: 0,
  });
});

test('I13 hover：一次 `buttons: 0` 的 mouseMoved + 前后比对（事件序列与 click 不同）', async () => {
  const session = makeSession({
    resolve: [resolveOk({ tag: 'li', hitDesc: 'li#menu' })],
    state: [st({ domText: '下拉=关' }), st({ domText: '下拉=开' })],
  });
  const out = collector();
  const verdict = await runHover({ session, spec: hoverSpec({ _: ['hover'], urls: [], selector: '#menu' }), out });
  assert.equal(verdict.changed, 'true', 'FIXTURE：悬停后子容器可见 ⇒ DOM 那一类有差异');
  assert.equal(valueOf(out, 'HIT_IS_TARGET'), 'true');
  assert.equal(valueOf(out, 'POINT'), '110,220');
  assert.equal(valueOf(out, 'CHANGED'), 'true');
  assert.equal(valueOf(out, 'DISPATCHED'), '1');
  assert.equal(session.calls.send.length, 1, 'hover 只发一个事件 —— 不按下、不松开');
  assert.equal(session.calls.send[0].method, 'Input.dispatchMouseEvent');
  assert.equal(session.calls.send[0].params.type, 'mouseMoved');
  assert.equal(session.calls.send[0].params.x, 110);
  assert.equal(session.calls.send[0].params.y, 220);
  assert.equal(session.calls.send[0].params.buttons, 0, '显式 buttons: 0（按下了就成了拖动 / 点选）');
  assert.equal(session.calls.send[0].params.button, undefined);
  // 回读那一套与 click 同款（只读、不改退出码）。
  assert.equal(valueOf(out, 'HIT_AFTER'), 'li#menu');
  assert.equal(valueOf(out, 'HIT_AFTER_IS_TARGET'), 'true');
});

test('I13 hover：被遮挡时默认**不发事件**（用法错 2），--force 才照原样发', async () => {
  const spec = hoverSpec({ _: ['hover'], urls: [], selector: '#menu' });
  const session = makeSession({ resolve: [resolveOk({ hitIsTarget: false, hitDesc: 'div#cover' })] });
  const out = collector();
  await usage(() => runHover({ session, spec, out }), /默认不发事件/);
  assert.equal(session.calls.send.length, 0, '拒发时一个 CDP 事件都不许发');
  assert.equal(valueOf(out, 'HIT_IS_TARGET'), 'false');
  assert.match(valueOf(out, 'WARN'), /命中的是 div#cover/);
  assert.equal(out.has('CHANGED='), false, '没发事件就不该有 CHANGED 读数');

  const forced = makeSession({
    resolve: [resolveOk({ hitIsTarget: false, hitDesc: 'div#cover' })],
    state: [st({ domText: 'A' }), st({ domText: 'B' })],
  });
  const out2 = collector();
  const v2 = await runHover({
    session: forced,
    spec: hoverSpec({ _: ['hover'], urls: [], selector: '#menu', force: true }),
    out: out2,
  });
  assert.equal(v2.changed, 'true');
  assert.equal(forced.calls.send.length, 1, '--force 要真的发出去');
  assert.equal(forced.calls.send[0].params.type, 'mouseMoved');
  assert.match(valueOf(out2, 'WARN'), /照原样发/);
});

test('I13 hover：不可见 / 视口外 / 没匹配到 / 选择器非法 —— 都说清且不发事件', async () => {
  const spec = hoverSpec({ _: ['hover'], urls: [], selector: '#menu' });
  const invisible = makeSession({
    resolve: [resolveOk({ visible: false, box: [0, 0, 0, 0], point: null, onScreen: false })],
  });
  await runtime(() => runHover({ session: invisible, spec, out: collector() }), /没有可悬停的区域/);
  assert.equal(invisible.calls.send.length, 0);

  const offscreen = makeSession({ resolve: [resolveOk({ onScreen: false, point: null })] });
  await runtime(() => runHover({ session: offscreen, spec, out: collector() }), /不在视口内/);
  assert.equal(offscreen.calls.send.length, 0);

  const missing = makeSession({ resolve: [NOT_FOUND] });
  await runtime(() => runHover({ session: missing, spec, out: collector() }), /没有匹配到元素/);
  assert.equal(missing.calls.send.length, 0);

  const bad = makeSession({ resolve: [resolveOk({ found: false, selectorError: "'#(' is not a valid selector" })] });
  await usage(() => runHover({ session: bad, spec, out: collector() }), /选择器不合法/);
});

test('I13 hover：命中断测缺失（elementFromPoint 没结果）⇒ unknown 而**不是**"指针进到了目标上"', async () => {
  const session = makeSession({
    resolve: [resolveOk({ hitIsTarget: null, hitDesc: '' })],
    state: [st({ domText: 'A' }), st({ domText: 'A' })],
  });
  const out = collector();
  const v = await runHover({ session, spec: hoverSpec({ _: ['hover'], urls: [], selector: '#menu' }), out });
  assert.equal(valueOf(out, 'HIT_IS_TARGET'), 'unknown');
  assert.match(valueOf(out, 'WARN'), /缺测不许读成"指针进到了目标上"/);
  assert.equal(session.calls.send.length, 1, '缺测只提示，不拦（拦住会把"可能成功"当成"确定失败"）');
  assert.equal(v.changed, 'false', 'DOM 没变且读得到 ⇒ false（它不等于"悬停没生效"，见 WARN）');
});

test('I13 type：聚焦成功 → 一次 insertText；focus 不属于被观测的动作', async () => {
  const spec = typeSpec({ _: ['type'], urls: [], selector: '#q', text: '你好', clear: true });
  const session = makeSession({
    resolve: [resolveOk({ tag: 'input', inputish: true })],
    focus: [{ ok: true, reason: null, focused: true, active: 'input#q', cleared: true, inputish: true, selectionStart: 0, selectionEnd: 4 }],
    state: [st({ element: el({ value: '' }) }), st({ element: el({ value: '你好' }) })],
  });
  const out = collector();
  const v = await runType({ session, spec, out });
  assert.equal(v.changed, 'true');
  assert.deepEqual(v.kinds, ['value']);
  assert.equal(valueOf(out, 'CLEAR'), 'true');
  assert.equal(valueOf(out, 'CLEARED'), 'true');
  assert.equal(valueOf(out, 'FOCUS'), 'target');
  assert.equal(valueOf(out, 'TEXT_CHARS'), '2');
  assert.equal(valueOf(out, 'TEXT_BYTES'), '6');
  assert.equal(valueOf(out, 'DISPATCHED'), '1');
  assert.equal(session.calls.send.length, 1);
  assert.equal(session.calls.send[0].method, 'Input.insertText');
  assert.equal(session.calls.send[0].params.text, '你好');
});

test('I13 type：焦点没落在目标上 ⇒ 一个字符都不发（运行期错误 1）', async () => {
  const spec = typeSpec({ _: ['type'], urls: [], selector: '#q', text: 'x' });
  const session = makeSession({
    resolve: [resolveOk({ tag: 'input', inputish: true })],
    focus: [{ ok: true, reason: null, focused: false, active: 'input#other', cleared: false, inputish: true }],
  });
  const out = collector();
  await runtime(() => runType({ session, spec, out }), /没有输入任何字符/);
  assert.equal(session.calls.send.length, 0, '焦点不在目标上时不许发字符');
  assert.equal(valueOf(out, 'FOCUS_ACTIVE'), 'input#other');
  assert.equal(out.has('CHANGED='), false);
});

test('I13 type：目标不是可输入元素 / 被禁用 / 只读 —— 都拦在发字符之前', async () => {
  const spec = typeSpec({ _: ['type'], urls: [], selector: '#d', text: 'x' });
  const div = makeSession({ resolve: [resolveOk({ tag: 'div' })] });
  await usage(() => runType({ session: div, spec, out: collector() }), /只能对 input \/ textarea \/ contenteditable/);
  assert.equal(div.calls.focus.length, 0);

  const disabled = makeSession({ resolve: [resolveOk({ tag: 'input', inputish: true, disabled: true })] });
  await runtime(() => runType({ session: disabled, spec, out: collector() }), /被禁用/);
  const ro = makeSession({ resolve: [resolveOk({ tag: 'textarea', inputish: true, readOnly: true })] });
  await runtime(() => runType({ session: ro, spec, out: collector() }), /只读/);
  const hidden = makeSession({ resolve: [resolveOk({ tag: 'input', inputish: true, visible: false })] });
  await runtime(() => runType({ session: hidden, spec, out: collector() }), /没有可输入区域/);
  for (const s of [disabled, ro, hidden]) assert.equal(s.calls.send.length, 0);
});

test('I13 type：contenteditable 走文本那一类判据', async () => {
  const spec = typeSpec({ _: ['type'], urls: [], selector: '#ed', text: 'abc' });
  const session = makeSession({
    resolve: [resolveOk({ tag: 'div', editable: true })],
    focus: [{ ok: true, reason: null, focused: true, active: 'div#ed', cleared: false, inputish: false }],
    state: [
      st({ element: el({ tag: 'div', editable: true, value: null, text: 'x' }) }),
      st({ element: el({ tag: 'div', editable: true, value: null, text: 'xabc' }) }),
    ],
  });
  const out = collector();
  const v = await runType({ session, spec, out });
  assert.equal(v.changed, 'true');
  assert.deepEqual(v.kinds, ['elemtext']);
  assert.equal(valueOf(out, 'INPUT_KIND'), 'contenteditable');
  assert.equal(valueOf(out, 'SELECTION'), 'n/a(contenteditable)');
});

test('I13 select：值在选项里 ⇒ 赋值 + 派发 input/change，前后比对看得见', async () => {
  const spec = selectSpec({ _: ['select'], urls: [], selector: '#s', value: 'b' });
  const session = makeSession({
    resolve: [resolveOk({ tag: 'select' })],
    state: [
      st({ element: el({ tag: 'select', value: null, selectedIndex: 0 }) }),
      st({ element: el({ tag: 'select', value: null, selectedIndex: 1 }) }),
    ],
    selectProbe: [{ exists: true, selectorError: null, tag: 'select', values: ['a', 'b', 'c'], value: 'a', selectedIndex: 0 }],
    selectApply: [{ exists: true, selectorError: null, dispatched: ['input', 'change'], values: ['a', 'b', 'c'], value: 'b', selectedIndex: 1 }],
  });
  const out = collector();
  const v = await runSelect({ session, spec, out });
  assert.equal(v.changed, 'true');
  assert.deepEqual(v.kinds, ['selected']);
  assert.equal(valueOf(out, 'OPTION_COUNT'), '3');
  assert.equal(valueOf(out, 'VALUE_IN_OPTIONS'), 'true');
  assert.equal(valueOf(out, 'SELECTED_INDEX'), '1');
  assert.equal(valueOf(out, 'DISPATCHED'), 'input+change');
  assert.equal(valueOf(out, 'SELECT_APPLIED'), 'true', '写入后的回读必须自证"请求的值真被选中"');
  assert.equal(session.calls.send.length, 0, 'select 走 DOM 赋值，不发输入事件');
});

test('I13 select：值不在选项里 ⇒ 拒绝（不猜），并报出可用取值', async () => {
  const spec = selectSpec({ _: ['select'], urls: [], selector: '#s', value: 'zzz' });
  const session = makeSession({
    resolve: [resolveOk({ tag: 'select' })],
    state: [st({ element: el({ tag: 'select', value: null, selectedIndex: 0 }) }), st({ element: el({ tag: 'select', value: null, selectedIndex: 0 }) })],
    selectProbe: [{ exists: true, selectorError: null, tag: 'select', values: ['a', 'b'], value: 'a', selectedIndex: 0 }],
  });
  const out = collector();
  await usage(() => runSelect({ session, spec, out }), /不在这个 <select> 的选项里/);
  assert.equal(valueOf(out, 'VALUE_IN_OPTIONS'), 'false');
  assert.match(valueOf(out, 'WARN'), /可用取值（前 5 个）：a \| b/);
  // 判定在 Node 侧：拒绝时**连写入表达式都不许跑**（更别说发事件）。
  assert.equal(session.calls.selectApply.length, 0, '被拒时不许跑写入表达式');
  assert.equal(session.calls.send.length, 0, '被拒时一个 CDP 事件都不许发');
});

test('I13 select：目标不是 <select> / 被禁用 —— 拦在赋值之前', async () => {
  const spec = selectSpec({ _: ['select'], urls: [], selector: '#d', value: 'a' });
  const div = makeSession({ resolve: [resolveOk({ tag: 'div' })] });
  await usage(() => runSelect({ session: div, spec, out: collector() }), /只能对 <select> 元素赋值/);
  assert.equal(div.calls.select.length, 0);
  const disabled = makeSession({ resolve: [resolveOk({ tag: 'select', disabled: true })] });
  await runtime(() => runSelect({ session: disabled, spec, out: collector() }), /被禁用/);
});

/**
 * 假页面沙箱：让 `selectProbeExpr` / `selectApplyExpr` 在 `node:vm` 里**真执行** ——
 * "页面有没有被写、有没有被派发、写完之后回读到了什么"都留痕。
 * 为什么不用罐装读数：罐装读数只看得见命令**输出的行**，看不见"页面已经被写过了"（G1 的教训）。
 * 布局类读数（`resolve` / 状态探针）仍旧罐装：那几个表达式要 `elementFromPoint` / `getComputedStyle`，
 * 本用例不碰它们，只把"探针 / 写入 / 派发 / 回读"这一段换成真跑。
 *
 * `{ rollback: true }` 模拟"受控组件把写入回滚"：值写进去之后页面又把它改回原样 ——
 * 这时回读自证必须报"没落地"（退出码 1），不许静默成功（第四轮返工的核心要求）。
 */
function selectSandbox(optionValues, current = '', { rollback = false } = {}) {
  const log = { writes: [], events: [], delegated: [], reads: 0 };
  // 选项表可以是字符串（`{ value: v }`），也可以是 `{ value, text }` —— 后者用来量"`value` 与 `text` 不一致"那类取值。
  const options = optionValues.map((v) => (typeof v === 'string' ? { value: v } : { value: v.value, text: v.text }));
  let val = current;
  let idx = Math.max(0, options.findIndex((o) => o.value === current));
  const listeners = new Map();
  const el = {
    tagName: 'SELECT',
    options: options.map((o) => ({ value: o.value })),
    get selectedIndex() { return idx; },
    set selectedIndex(n) { idx = n; },
    get value() { log.reads += 1; return val; },
    set value(v) {
      log.writes.push(v);
      if (rollback) return; // 受控组件：写入被回滚，DOM 上一个字节都没留下
      // 真浏览器的语义：赋一个在选项表里的值会同时把 selectedIndex 挪过去；
      // 不在表里则 value 变 ""、selectedIndex 变 -1（这正是闸门要拦的那件事）。
      const i = options.findIndex((o) => o.value === v);
      val = i >= 0 ? v : '';
      idx = i >= 0 ? i : -1;
    },
    dispatchEvent(ev) {
      log.events.push(ev.type);
      // 真浏览器里 `bubbles: true` 的事件会走到 document 上的委托监听 —— 这里照做，
      // 否则"把 bubbles 关掉"这种改法在单测里看不出来（N3）。
      if (ev.bubbles === true) {
        for (const fn of listeners.get(ev.type) || []) {
          log.delegated.push(ev.type);
          fn(ev);
        }
      }
      return true;
    },
  };
  const sandbox = {
    document: {
      querySelector: (sel) => (sel === '#s' ? el : null),
      addEventListener: (type, fn) => {
        const arr = listeners.get(type) || [];
        arr.push(fn);
        listeners.set(type, arr);
      },
    },
    Event: class Event { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
  };
  return { log, sandbox, el, options, listeners };
}

/** 假 session：`select` 的两条表达式真跑沙箱（探针 + 写入各自真执行），其余读数照旧从罐装队列里取。 */
function vmSelectSession(sandbox, plan = {}) {
  // 队列要**深拷一份**：`take()` 是 shift，共用一份读数会让第二个 session 无读数可发。
  const cloned = {};
  for (const [k, v] of Object.entries(plan)) cloned[k] = Array.isArray(v) ? v.slice() : v;
  const canned = makeSession(cloned);
  return {
    calls: canned.calls,
    async evalJs(expr) {
      if (expr.includes('adg-select-probe') || expr.includes('adg-select-apply')) {
        canned.calls.select.push(expr);
        if (expr.includes('adg-select-probe')) canned.calls.selectProbe.push(expr);
        else canned.calls.selectApply.push(expr);
        return vm.runInNewContext(expr, sandbox);
      }
      return canned.evalJs(expr);
    },
    async send(method, params) {
      return canned.send(method, params);
    },
  };
}

const SELECT_PLAN = {
  resolve: [resolveOk({ tag: 'select' })],
  state: [st({ element: el({ tag: 'select', value: null, selectedIndex: 0 }) })],
};

test('I16 select：决策不在页面表达式里（页面只读原始数据）—— 闸门不能活在页面里（第四轮返工）', () => {
  const probe = selectProbeExpr('#s');
  const apply = selectApplyExpr('#s', 'b');
  const at = (s, needle) => {
    const i = s.indexOf(needle);
    assert.ok(i > 0, `表达式的形状变了，找不到 ${JSON.stringify(needle)}：\n${s}`);
    return i;
  };
  // ① 页面里没有接受 / 拒绝的布尔量：判定搬到了 Node 侧的 `decideSelect`。
  //    这一条就是第四轮返工的根：页面里一个 `out.inOptions` 可以被同一段表达式的任意一行改写
  //    （`const o = opts; o[o.length] = {...}` / `opts.push.call(...)` / `Reflect.apply(...)`），
  //    而文本扫描只能按形状抓。现在页面里没有这个东西可改。
  for (const [name, src] of [['探针', probe], ['写入', apply]]) {
    assert.equal(/inOptions/.test(src), false, `${name}表达式里不许出现 inOptions（判定在 Node 侧）：\n${src}`);
    assert.equal(/decideSelect|selectApplied/.test(src), false, `${name}表达式里不许出现 Node 侧判定函数：\n${src}`);
  }
  // 探针连"请求的值"都不知道 ⇒ 页面里根本无从按取值特判。
  assert.equal(/WANT/.test(probe), false, `探针不许知道请求的值（知道就能按取值特判）：\n${probe}`);
  // ② 探针只读：不写、不派发；快照冻结。
  assert.equal(/el\.value\s*=(?!=)/.test(probe), false, `探针只许读，不许写 el.value：\n${probe}`);
  assert.equal(/dispatchEvent/.test(probe), false, `探针不许派发事件：\n${probe}`);
  assert.ok(at(probe, 'Object.freeze(values)') > 0, '探针取的选项表快照必须冻结');
  // ③ 写入表达式的顺序：赋值 → input → change → 回读（回读的是"页面处理完之后"的状态）。
  const iAssign = at(apply, 'el.value = WANT;');
  const iInput = at(apply, "new Event('input'");
  const iChange = at(apply, "new Event('change'");
  const iDispatched = at(apply, "out.dispatched = ['input', 'change'];");
  const iReadback = at(apply, 'out.value = String(el.value == null');
  assert.ok(iAssign < iInput && iInput < iChange, '赋值先于 input，input 先于 change');
  assert.ok(iChange < iDispatched, '两个事件都派发完了才记 dispatched');
  assert.ok(iDispatched < iReadback, '回读必须在两个事件之后');
  // ④ 形状对了不等于行为对了：真执行一遍探针，页面必须一个字节都没被写。
  const box = selectSandbox(['a', 'b'], 'a');
  const probeOut = vm.runInNewContext(probe, box.sandbox);
  assert.deepEqual([...probeOut.values], ['a', 'b']);
  assert.equal(Object.isFrozen(probeOut.values), true, '快照必须是冻结的（页面里再拿到它也没有写入口）');
  assert.deepEqual(box.log.writes, [], '探针不许写页面');
  assert.deepEqual(box.log.events, [], '探针不许派发事件');
});

test('I16 select：值不在选项里时，**真执行**下页面一个字节都没被写（罐装读数证不了这件事）', async () => {
  // ① 不在选项里 ⇒ 拒发（退出码 2），且写入与派发都没发生。
  const badBox = selectSandbox(['a', 'b'], 'a');
  const bad = vmSelectSession(badBox.sandbox, SELECT_PLAN);
  const badSpec = selectSpec({ _: ['select'], urls: [], selector: '#s', value: 'zzz' });
  const out = collector();
  await usage(() => runSelect({ session: bad, spec: badSpec, out }), /不在这个 <select> 的选项里/);
  assert.deepEqual(badBox.log.writes, [], '页面被写过了 —— 拒绝必须发生在赋值之前');
  assert.deepEqual(badBox.log.events, [], 'input/change 被派发过了 —— 拒绝必须发生在派发之前');
  assert.equal(valueOf(out, 'VALUE_IN_OPTIONS'), 'false');

  // ② 在选项里 ⇒ 同一套沙箱下必须真写入一次、真派发两个事件（否则①是恒真的空断言）。
  const goodBox = selectSandbox(['a', 'b'], 'a');
  const good = vmSelectSession(goodBox.sandbox, SELECT_PLAN);
  const goodSpec = selectSpec({ _: ['select'], urls: [], selector: '#s', value: 'b' });
  await runSelect({ session: good, spec: goodSpec, out: collector() });
  assert.deepEqual(goodBox.log.writes, ['b'], '值在选项里时必须真的写进去');
  assert.deepEqual(goodBox.log.events, ['input', 'change'], '两个事件都要派发，且顺序固定');
});

test('I16 select：两个事件必须真的冒泡（`bubbles: true`）—— 关掉它，document 级委托监听就收不到（N3）', async () => {
  const a = selectApplyExpr('#s', 'b');
  const iInput = a.indexOf("new Event('input', { bubbles: true })");
  const iChange = a.indexOf("new Event('change', { bubbles: true })");
  assert.ok(iInput > 0, `input 事件必须写成冒泡的形状，表达式里找不到它：\n${a}`);
  assert.ok(iChange > 0, `change 事件必须写成冒泡的形状，表达式里找不到它：\n${a}`);
  assert.ok(iInput < iChange, 'input 先、change 后');
  assert.equal(/bubbles:\s*false/.test(a), false, `不许把冒泡关掉：\n${a}`);

  // 光看形状不够：真执行一遍，看事件有没有走到 document 上的委托监听（真实页面常用委托）。
  const box = selectSandbox(['a', 'b'], 'a');
  let delegatedSeen = 0;
  box.sandbox.document.addEventListener('change', () => { delegatedSeen += 1; });
  const session = vmSelectSession(box.sandbox, SELECT_PLAN);
  const spec = selectSpec({ _: ['select'], urls: [], selector: '#s', value: 'b' });
  const out = collector();
  await runSelect({ session, spec, out });
  assert.equal(valueOf(out, 'VALUE_IN_OPTIONS'), 'true');
  assert.deepEqual(box.log.events, ['input', 'change'], '元素上该收到两个事件');
  assert.deepEqual(box.log.delegated, ['change'], 'bubbles:true 的 change 必须冒泡到 document');
  assert.equal(delegatedSeen, 1, 'document 上的委托监听必须被调用一次');
});

test('I16 select：闸门是输入表驱动的 —— 表里每个取值都真执行一遍，被拒的一个字节都不许写（N4；R1 扩表；第四轮返工）', async () => {
  const BASE = ['bj', 'sh'];
  const RAND = `q${Math.random().toString(36).slice(2, 10)}`;
  const TIME = `t${Date.now()}`;
  const cases = [
    { name: '不在选项里的普通值', opts: ['bj', 'sh'], want: 'zzz' },
    { name: '空串：选项里没有', opts: ['bj', 'sh'], want: '' },
    { name: '空串：选项里就有', opts: ['', 'bj', 'sh'], want: '' },
    { name: '大小写近似（SH ≠ sh）', opts: ['bj', 'sh'], want: 'SH' },
    { name: 'option 的 text 不是它的 value', opts: [{ value: 'canon', text: '北京' }], want: '北京' },
    { name: 'option 的 value 本身（text 不同）', opts: [{ value: 'canon', text: '北京' }], want: 'canon' },
    { name: '针对单个取值的绕过（a1）', opts: ['bj', 'sh'], want: 'a1' },
    // R1：**表外取值**（上一版样本全是手写字面量，按表外某个取值特判的改法一个都打不着）。
    { name: '表外随机串（当场构造，不写字面量）', opts: BASE, want: 'q' + '9' },
    { name: '表内取值的变异：加前缀', opts: BASE, want: 'x' + BASE[0] },
    { name: '表内取值的变异：加后缀', opts: BASE, want: BASE[1] + 'x' },
    { name: '表内取值的变异：大小写反转', opts: BASE, want: BASE[0].toUpperCase() },
    { name: '表内取值的变异：去掉首字符', opts: BASE, want: BASE[0].slice(1) },
    { name: '表内取值的变异：加空格', opts: BASE, want: BASE[0] + ' ' },
    // 第四轮返工补的：**当场派生、不可预测**的取值（源码里不出现这个字面量，也没法预先写死）。
    // 断言结果不随机：期望值照旧由沙箱自己的选项表独立算，随机的只是"取哪个值"。
    { name: '当场派生的随机串（不可预测，期望值仍独立算）', opts: BASE, want: RAND },
    { name: '当场派生的随机串：它就当选项值 ⇒ 该被接受', opts: [BASE[0], RAND], want: RAND },
    { name: '当场派生的时间串（不可预测，期望值仍独立算）', opts: BASE, want: TIME },
  ];
  const seen = new Set();
  for (const c of cases) {
    const current = typeof c.opts[0] === 'string' ? c.opts[0] : '';
    const box = selectSandbox(c.opts, current);
    // 期望值由**沙箱自己的选项表**独立算一遍（不照抄 Node 侧判定）：任何"按取值特判"的改法都会在这一格露出来。
    const expect = box.options.some((o) => o.value === c.want);
    seen.add(expect);
    const session = vmSelectSession(box.sandbox, SELECT_PLAN);
    const spec = selectSpec({ _: ['select'], urls: [], selector: '#s', value: c.want });
    const out = collector();
    if (expect) {
      await runSelect({ session, spec, out });
      assert.equal(valueOf(out, 'VALUE_IN_OPTIONS'), 'true', `${c.name}：应当被接受`);
      assert.equal(valueOf(out, 'SELECT_APPLIED'), 'true', `${c.name}：写入后的回读必须自证落地`);
      assert.deepEqual(box.log.writes, [c.want], `${c.name}：被接受就必须真的写进去`);
      assert.deepEqual(box.log.events, ['input', 'change'], `${c.name}：被接受就必须派发两个事件`);
    } else {
      await usage(() => runSelect({ session, spec, out }), /不在这个 <select> 的选项里/);
      assert.equal(valueOf(out, 'VALUE_IN_OPTIONS'), 'false', `${c.name}：应当被拒`);
      assert.equal(session.calls.selectApply.length, 0, `${c.name}：被拒时连写入表达式都不许跑`);
      assert.deepEqual(box.log.writes, [], `${c.name}：被拒时页面一个字节都不许写`);
      assert.deepEqual(box.log.events, [], `${c.name}：被拒时一个事件都不许派发`);
    }
  }
  assert.deepEqual([...seen].sort(), [false, true], '表里必须既有被接受的也有被拒的取值，否则这条用例是半边恒真的');
});

test('I16 select：闸门的判定只有一个来源 —— Node 侧的 `decideSelect`（`inOptions` 不许活在页面里）（N4；第四轮返工）', () => {
  const raw = fs.readFileSync(path.join(LIB, 'actions.mjs'), 'utf8');
  // 先剥掉注释：说明文字里提到 inOptions 不算"判定来源"。
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  const sliceOf = (name) => {
    const i = src.indexOf(`function ${name}(`);
    assert.ok(i > 0, `找不到 ${name}：源码形状变了`);
    const j = src.indexOf('\n}\n', i);
    assert.ok(j > i, `${name} 的结尾找不到`);
    return src.slice(i, j);
  };
  const probe = sliceOf('selectProbeExpr');
  const apply = sliceOf('selectApplyExpr');
  const decide = sliceOf('decideSelect');
  for (const [name, body] of [['selectProbeExpr', probe], ['selectApplyExpr', apply]]) {
    assert.equal(/inOptions/.test(body), false, `${name} 里不许出现 inOptions（决策不在页面里）：\n${body}`);
  }
  // 整个模块里：inOptions 只许**在 decideSelect 里算出来**，别处只许**以 `decision.inOptions` 的形式读**。
  // 别处出现"算 inOptions"的写法，就是第二个判定来源（`if (WANT === 'q8') decision.inOptions = true;`
  // 这种改法必须在这一条上露出来）。
  const elsewhere = src.replace(decide, ' ');
  const hits = [...elsewhere.matchAll(/.{0,70}inOptions.{0,30}/g)].map((m) => m[0]);
  const suspicious = hits.filter((h) => !/decision\.inOptions/.test(h));
  assert.deepEqual(suspicious, [], `inOptions 只许以 decision.inOptions 被读：${JSON.stringify(suspicious)}`);
  const noReads = elsewhere.replace(/decision\.inOptions/g, ' ');
  assert.equal(
    /inOptions/.test(noReads),
    false,
    `别处不许再算 / 再写第二个 inOptions：${JSON.stringify([...noReads.matchAll(/.{0,70}inOptions.{0,30}/g)].map((m) => m[0]))}`,
  );
  // `decision.inOptions` 只许被**读**两次（打一行读数、判一次闸门）：赋值是"闸门能被一行改掉"，
  // 多出来的读是"第二个草率的判定处"（第四轮返工：M10 变异就是往 decision 上写）。
  assert.equal(
    /decision\.inOptions\s*=(?!=)/.test(elsewhere),
    false,
    '`decision.inOptions` 不许被赋值 —— 那就是"闸门可以被一行改掉"',
  );
  const readCount = [...elsewhere.matchAll(/decision\.inOptions/g)].length;
  assert.equal(readCount, 2, `decision.inOptions 只该被读两次（打 VALUE_IN_OPTIONS 一次、判闸门一次），实际 ${readCount} 次`);
  assert.match(decide, /values\.includes\(want\)/, 'decideSelect 必须用选项表比对（includes）—— 别写成按取值特判');
  // 顺序：先判定、后写入（源码级）。
  const iDecide = src.indexOf('decideSelect(');
  const iApply = src.indexOf('selectApplyExpr(');
  assert.ok(iDecide > 0 && iApply > 0 && iDecide < iApply, 'select 必须先判定、后写入（反了就是"先写后判"）');
});

test('I16 select：探针里不许出现写入形状（第二层·形状级绊线，不是保证）（R1；第四轮返工）', () => {
  // **这一条不是保证**：形状扫描只抓得住列在下面的几族写法。真正的保证来自两处 ——
  // ① 判定在 Node 侧的 `decideSelect`（页面里没有可改写的布尔量）；② 写入后的回读自证
  //    （`selectApplied`，见下面那条"受控组件回滚"用例）。这里只是把"探针顺手动过快照"这类
  //    明显写法绊一下，并在文档里如实标明它扫的是什么。
  const probe = selectProbeExpr('#s');
  const BUILD = 'const values = Array.from(el.options || []).map((o) => String(o.value));';
  const iBuild = probe.indexOf(BUILD);
  assert.ok(iBuild > 0, `快照的构造形状变了，找不到它：\n${probe}`);
  const iReturn = probe.lastIndexOf('return out;');
  assert.ok(iReturn > iBuild, `探针的收尾形状变了：\n${probe}`);
  const win = probe.slice(iBuild + BUILD.length, iReturn);
  // 反向自证：窗口必须真的是"快照 → 返回"那一段（空窗口上面每条断言都恒真）。
  assert.ok(win.includes('Object.freeze(values)') && win.includes('out.values = values'), `窗口不是"快照构造 → 返回"那一段：\n${win}`);
  const families = [
    [/\.(push|splice|unshift|pop|shift|sort|reverse|copyWithin|fill)\s*\(/g, '改数组的方法'],
    [/\w+\s*\[[^\]]*\]\s*=(?!=)/g, '按索引写（别名写入的形状，例如 `const o = opts; o[o.length] = {…}`）'],
    [/\.length\s*=(?!=)/g, '改数组长度（`opts.length = 0` 后再写）'],
    [/\.\w+\.(call|apply)\s*\(/g, '借方法调用（`opts.push.call(opts, …)` / `Reflect.apply` 那一族的第一步）'],
    [/Reflect\./g, '反射（`Reflect.apply(opts.push, opts, […])`）'],
    [/Object\.assign/g, '`Object.assign` 改写'],
    [/Object\.defineProperty/g, '`Object.defineProperty` 改写'],
    [/el\.options\s*=(?!=)/g, '改写 el.options 本身'],
    [/el\.options\s*\[[^\]]*\]\s*=(?!=)/g, '改写 el.options 的元素'],
  ];
  for (const [re, label] of families) {
    const hits = [...win.matchAll(re)].map((m) => m[0]);
    assert.deepEqual(hits, [], `探针的快照构造之后出现了${label}：${JSON.stringify(hits)}\n${win}`);
  }
  // 冻结必须发生在交接之前，而且只此一次（`Object.freeze` 之外不再有别的"处理"）。
  const freezes = [...win.matchAll(/Object\.freeze\(values\)/g)];
  assert.equal(freezes.length, 1, `快照只许冻结一次，实际 ${freezes.length} 次：\n${win}`);
  assert.ok(win.indexOf('Object.freeze(values)') < win.indexOf('out.values = values'), '必须先冻结、后交接');
  const handed = [...win.matchAll(/out\.values\s*=(?!=)/g)];
  assert.equal(handed.length, 1, `快照只许交接一次（多一次就是换了一张表）：\n${win}`);
});

test('I16 select：`decideSelect` 是普通 JS 纯函数，单测能直接打靶（第四轮返工的点）', () => {
  const opts = ['bj', 'sh', ''];
  const rows = [['bj', true], ['', true], ['zzz', false], ['SH', false], ['bj ', false], [0, false]];
  for (const [want, expect] of rows) {
    const d = decideSelect({ options: opts, value: want });
    assert.equal(d.inOptions, opts.some((o) => o === String(want)), `取值 ${JSON.stringify(want)}：判定与选项表比对不一致`);
    assert.equal(d.inOptions, expect, `取值 ${JSON.stringify(want)} 的期望判定`);
    assert.equal(d.count, opts.length);
  }
  // 数字 option value：与页面里 `String(o.value)` 同一口径（字符串比）。
  assert.equal(decideSelect({ options: [1, 2], value: '1' }).inOptions, true);
  assert.equal(decideSelect({ options: [1, 2], value: 1 }).inOptions, true);
  // 拿不到选项表（探针失败 / 页面没返回）⇒ **拒绝**：没有数据不许靠"没报错"过闸门。
  assert.equal(decideSelect({ options: undefined, value: 'bj' }).inOptions, false);
  assert.equal(decideSelect({ options: null, value: 'bj' }).count, 0);
  assert.deepEqual(decideSelect({ options: ['a', 'b', 'c', 'd', 'e', 'f'], value: 'a' }).sample, ['a', 'b', 'c', 'd', 'e']);
});

test('I16 select：写入后的回读必须三样都对得上（值在表里 / value 等于它 / selectedIndex 指对）', () => {
  const values = ['', 'bj', 'sh'];
  const ok = selectApplied({ readback: { values, value: 'sh', selectedIndex: 2 }, value: 'sh' });
  assert.equal(ok.applied, true);
  assert.equal(ok.expectedIndex, 2);
  // 受控组件把写入回滚：value 还是旧值、index 还是老的 ⇒ 不算落地。
  assert.equal(selectApplied({ readback: { values, value: '', selectedIndex: 0 }, value: 'sh' }).applied, false);
  // 值写进去了但 selectedIndex 没对上（页面自己挪了位置）⇒ 同样不算落地。
  assert.equal(selectApplied({ readback: { values, value: 'sh', selectedIndex: 1 }, value: 'sh' }).applied, false);
  // 值不在回读的选项表里（页面拒了 / 表被换了）⇒ 不算落地。
  assert.equal(selectApplied({ readback: { values: ['', 'bj'], value: 'sh', selectedIndex: -1 }, value: 'sh' }).applied, false);
  // 回读缺字段 ⇒ 一律按"没落地"，绝不按"应该成了"。
  assert.equal(selectApplied({ readback: {}, value: 'sh' }).applied, false);
  assert.equal(selectApplied({ readback: { values }, value: 'sh' }).applied, false);
  assert.equal(selectApplied({ readback: { values, value: 'sh' }, value: 'sh' }).applied, false);
});

test('I16 select：写入被页面回滚 ⇒ 不许报成功，按运行期错（退出码 1）报 `SELECT_APPLIED=false`（第四轮返工）', async () => {
  const spec = selectSpec({ _: ['select'], urls: [], selector: '#s', value: 'b' });
  const box = selectSandbox(['a', 'b'], 'a', { rollback: true });
  const session = vmSelectSession(box.sandbox, SELECT_PLAN);
  const out = collector();
  await runtime(() => runSelect({ session, spec, out }), /回读不一致|动作没有落地/);
  assert.equal(valueOf(out, 'VALUE_IN_OPTIONS'), 'true', '闸门是过的（这个值确实在选项表里）');
  assert.equal(valueOf(out, 'SELECT_APPLIED'), 'false', '回读自证必须报"没落地"');
  assert.deepEqual(box.log.writes, ['b'], '写入确实发出去了 —— 是页面把它回滚了');
  assert.deepEqual(box.log.events, ['input', 'change'], '事件也发出去了');
  // 对照：同一套沙箱不回滚 ⇒ 同一份读数下必须报成功（否则上面那条是恒真的）。
  const okBox = selectSandbox(['a', 'b'], 'a');
  const okSession = vmSelectSession(okBox.sandbox, SELECT_PLAN);
  const okOut = collector();
  await runSelect({ session: okSession, spec, out: okOut });
  assert.equal(valueOf(okOut, 'SELECT_APPLIED'), 'true');
});

test('I16 select：探针失败 / 页面没返回选项表 ⇒ 拒绝，不许靠"没报错"过闸门', async () => {
  const spec = selectSpec({ _: ['select'], urls: [], selector: '#s', value: 'b' });
  const session = makeSession({
    resolve: [resolveOk({ tag: 'select' })],
    selectProbe: [{ exists: true, selectorError: null, tag: 'select' }], // 没有 values 字段
  });
  const out = collector();
  await usage(() => runSelect({ session, spec, out }), /不在这个 <select> 的选项里/);
  assert.equal(valueOf(out, 'VALUE_IN_OPTIONS'), 'false');
  assert.equal(valueOf(out, 'OPTION_COUNT'), '0');
  assert.equal(session.calls.selectApply.length, 0, '没有选项表就一个字节都不许写');
});

test('I14 type：回读自证（`TYPE_APPLIED`）三态 —— `false` 是真话、`unknown` 不许报成 `false`', async () => {
  // 纯函数三态
  assert.equal(typeReadbackVerdict({ readback: { exists: true, kind: 'value', value: 'abc' }, text: 'ab' }).applied, 'true');
  assert.equal(typeReadbackVerdict({ readback: { exists: true, kind: 'value', value: 'xyz' }, text: 'ab' }).applied, 'false');
  assert.equal(typeReadbackVerdict({ readback: { exists: true, kind: 'contenteditable', text: 'ab' }, text: 'ab' }).applied, 'true');
  assert.equal(typeReadbackVerdict({ readback: { exists: false }, text: 'ab' }).applied, 'unknown');
  assert.equal(typeReadbackVerdict({ readback: { exists: true, kind: '', value: '' }, text: 'ab' }).applied, 'unknown');
  assert.equal(typeReadbackVerdict({ readback: { selectorError: 'bad selector' }, text: 'ab' }).applied, 'unknown');
  assert.equal(typeReadbackVerdict({ readback: null, text: 'ab' }).applied, 'unknown');

  // 命令层：焦点闸门被绕过（字符打进了别处）时判据可能读到差异，而目标元素的回读是空 ⇒ 必须出 false。
  const spec = typeSpec({ _: ['type'], urls: [], selector: '#q', text: 'ab' });
  const session = makeSession({
    resolve: [resolveOk({ inputish: true })],
    focus: [{ ok: true, focused: true, active: 'input#q', cleared: false, inputish: true, selectionStart: 0, selectionEnd: 0 }],
    state: [st({ domText: 'A' }), st({ domText: 'B' })],
    readback: [{ exists: true, selectorError: null, kind: 'value', value: '' }],
  });
  const out = collector();
  const v = await runType({ session, spec, out });
  assert.equal(v.changed, 'true', '判据看到页面变了（字符打到了别处）');
  assert.equal(valueOf(out, 'TYPE_APPLIED'), 'false', '目标元素的回读里没有刚插入的文本 ⇒ false，不许含糊成"成功"');
  assert.equal(session.calls.readback.length, 1, '回读只读一次');
});

test('I15 wait-for：第一次轮询就满足 ⇒ WAIT=ok，POLLS=1，不抛', async () => {
  const spec = waitForSpec({ _: ['wait-for'], urls: [], selector: '#ok', timeout: '100', interval: '1' });
  const session = makeSession({
    state: [st({ domText: 'A' }), st({ domText: 'A' })],
    poll: [{ found: true, visible: true, satisfied: true }],
  });
  const out = collector();
  await runWaitFor({ session, spec, out });
  assert.equal(valueOf(out, 'WAIT'), 'ok');
  assert.equal(valueOf(out, 'POLLS'), '1');
  assert.equal(valueOf(out, 'FOUND'), 'true');
  assert.equal(valueOf(out, 'VISIBLE'), 'true');
  assert.equal(valueOf(out, 'COND'), 'selector');
  assert.equal(valueOf(out, 'CHANGED'), 'false', '等待期间页面没变 ⇒ false（这行只是旁证，答案在 WAIT）');
});

test('I15 wait-for：先后三次轮询才成立 ⇒ POLLS=3', async () => {
  const spec = waitForSpec({ _: ['wait-for'], urls: [], selector: '#late', timeout: '500', interval: '1' });
  const session = makeSession({
    state: [st(), st()],
    poll: [
      { found: false, visible: false, satisfied: false },
      { found: true, visible: false, satisfied: false },
      { found: true, visible: true, satisfied: true },
    ],
  });
  const out = collector();
  await runWaitFor({ session, spec, out });
  assert.equal(valueOf(out, 'WAIT'), 'ok');
  assert.equal(valueOf(out, 'POLLS'), '3');
  assert.equal(valueOf(out, 'FOUND'), 'true');
  assert.equal(valueOf(out, 'VISIBLE'), 'true');
});

test('I15 wait-for：超时是"没等到"的确定读数（WAIT=timeout + 退出码 1），不是静默成功', async () => {
  const spec = waitForSpec({ _: ['wait-for'], urls: [], selector: '#never', timeout: '1', interval: '1' });
  const session = makeSession({
    state: [st(), st()],
    poll: [{ found: false, visible: false, satisfied: false }],
  });
  const out = collector();
  await runtime(() => runWaitFor({ session, spec, out }), /没等到/);
  assert.equal(valueOf(out, 'WAIT'), 'timeout');
  assert.equal(valueOf(out, 'FOUND'), 'false');
  assert.ok(Number(valueOf(out, 'POLLS')) >= 1);
});

test('I15 wait-for：--url-match 与 --js 的读数各自成行；表达式抛错当"还不成立"', async () => {
  const urlSpec = waitForSpec({ _: ['wait-for'], urls: [], 'url-match': 'ok.html', timeout: '100', interval: '1' });
  const s1 = makeSession({
    state: [st(), st()],
    poll: [{ url: 'file:///fixture/ok.html', matched: true, satisfied: true }],
  });
  const out1 = collector();
  await runWaitFor({ session: s1, spec: urlSpec, out: out1 });
  assert.equal(valueOf(out1, 'URL'), 'file:///fixture/ok.html');
  assert.equal(valueOf(out1, 'URL_MATCHED'), 'true');
  assert.equal(valueOf(out1, 'COND'), 'url');

  const jsSpec = waitForSpec({ _: ['wait-for'], urls: [], js: 'window.__done === true', timeout: '100', interval: '1' });
  const s2 = makeSession({
    state: [st(), st()],
    poll: [
      { truth: null, error: 'ReferenceError: __done is not defined', satisfied: false },
      { truth: true, error: null, satisfied: true },
    ],
  });
  const out2 = collector();
  await runWaitFor({ session: s2, spec: jsSpec, out: out2 });
  assert.equal(valueOf(out2, 'WAIT'), 'ok');
  assert.equal(valueOf(out2, 'JS_TRUTH'), 'true');
  assert.equal(out2.has('JS_ERROR='), false, '最后一次轮询没抛错就不该有 JS_ERROR=');

  const s3 = makeSession({
    state: [st(), st()],
    poll: [{ truth: null, error: 'TypeError: x is not a function', satisfied: false }],
  });
  const out3 = collector();
  await runtime(
    () => runWaitFor({ session: s3, spec: waitForSpec({ _: ['wait-for'], urls: [], js: 'x()', timeout: '1', interval: '1' }), out: out3 }),
    /没等到/,
  );
  assert.equal(valueOf(out3, 'JS_TRUTH'), 'unknown');
  assert.match(valueOf(out3, 'JS_ERROR'), /TypeError/);
});

test('I15 wait-for：探针失败（页面正在导航等）⇒ CHANGED=unknown，而不是"没变化"', async () => {
  const spec = waitForSpec({ _: ['wait-for'], urls: [], selector: '#x', timeout: '100', interval: '1' });
  const session = makeSession({
    state: [st(), new Error('页面内抛错：Execution context was destroyed.')],
    poll: [{ found: true, visible: true, satisfied: true }],
  });
  const out = collector();
  await runWaitFor({ session, spec, out });
  assert.equal(valueOf(out, 'WAIT'), 'ok');
  assert.equal(valueOf(out, 'PROBE_AFTER'), 'failed');
  assert.equal(valueOf(out, 'CHANGED'), 'unknown');
  assert.match(valueOf(out, 'WARN'), /无从比较|不是"没有变化"/);
});

test('I14 captureState：探针读不到时把原始错误留在明面上（读不到不许当"没有变化"）', async () => {
  const session = makeSession({ state: [new Error('页面内抛错：boom')] });
  const s = await captureState(session, { selector: '#q' });
  assert.equal(s.ok, false);
  assert.match(s.error, /boom/);

  const tabsFail = makeSession({ state: [st()] });
  const s2 = await captureState(tabsFail, { selector: null, listTabs: async () => { throw new Error('端口不通'); } });
  assert.equal(s2.ok, true);
  assert.equal(s2.tabs.ok, false);
  assert.match(s2.tabs.error, /端口不通/);

  const tabsOk = makeSession({ state: [st()] });
  const s3 = await captureState(tabsOk, {
    selector: null,
    listTabs: async () => [{ type: 'page', url: 'file:///a', webSocketDebuggerUrl: 'ws://x/1' }],
  });
  assert.equal(s3.tabs.ok, true);
  assert.equal(s3.tabs.count, 1);
});

// ---------------------------------------------------------------------------
// 零依赖红线（同 browser.test.mjs 的那条，这里覆盖 browser/ 下**所有** .mjs）
// ---------------------------------------------------------------------------

/**
 * 单遍扫描源码：注释一律抹成空格（**保持长度与换行位置**，所以下标不位移），
 * 字符串 / 模板字面量（含 `\\` 转义）与正则字面量（R2）记成区间 `spans`。
 * 为什么要单遍：先按正则去注释再扫，会把字符串里的 `//` 当注释尾巴（`const u = 'http://x'; import w from 'ws';`
 * 这行后面的 import 就再也扫不到了），而先消字符串再扫又会漏掉真语句。一次过、按状态走，两件都做对。
 * 扫描顺序天然把注释里的引号挡在外面：进注释态时不认引号。
 */
function scanCode(src) {
  const out = src.split('');
  const spans = [];
  const blank = (a, b) => { for (let k = a; k < b; k += 1) if (src[k] !== '\n') out[k] = ' '; };

  const scanQuoted = (from, quote) => {
    let i = from + 1;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === quote) { i += 1; break; }
      if (src[i] === '\n') break; // 未闭合的就当到行尾
      i += 1;
    }
    spans.push([from, i]);
    return i;
  };

  // 正则字面量（R2）。不认得它两个方向都会错：
  //  ① 漏检：`const re = /'/; import x from 'ws';` —— 正则里那个奇数引号会被当成字符串起点，
  //     同行后面那个**真** import 就落进 span 被丢掉（实测全绿漏检）；
  //  ② 误报：`const re = /import x from 'ws'/;` —— 正则体里的 import 被当成真的（实测误红）。
  // 判"能不能起正则"用最保守的前一有效字符规则（前一字符是标识符/数字/`)`/`]`/引号 ⇒ 当除法，不当正则），
  // 残余的除法歧义（`a / b` 这类）与真实局限一并登记在 testing-guide 的已知洞表里。
  const REGEX_PREV = '=(,:[!&|?{};+-*%<>~^';
  const REGEX_KEYWORD = /(?:^|[^\w$])(return|case|typeof|instanceof|in|of|void|delete|new|do|else|yield|await|throw)$/;
  const canStartRegex = (at) => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(out[k])) k -= 1; // 看 `out`（注释已抹成空格），不看 src
    if (k < 0) return true;
    if (REGEX_PREV.includes(out[k])) return true;
    // 标识符结尾：只有关键字（return / case / typeof …）后面能起正则，普通标识符后面是除法。
    return /[A-Za-z_$]/.test(out[k]) && REGEX_KEYWORD.test(out.slice(0, k + 1).join(''));
  };

  const scanRegex = (from) => {
    let i = from + 1;
    let inClass = false; // 字符类 `[...]` 里的 `/` 不结束正则，`\/` 也不结束
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') break; // 未闭合的就当到行尾
      if (inClass) { if (c === ']') inClass = false; i += 1; continue; }
      if (c === '[') { inClass = true; i += 1; continue; }
      if (c === '/') { i += 1; break; }
      i += 1;
    }
    while (i < src.length && /[a-z]/i.test(src[i])) i += 1; // 旗标 gimsuy
    spans.push([from, i]);
    return i;
  };

  // 模板：文本部分是字符串内容，但 `${…}` 里的是**代码**（要照常扫，否则 `import(\`…\`)` 那类写法会被漏掉）。
  const scanTemplate = (from) => {
    let i = from + 1;
    let textStart = from;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') { i += 1; break; }
      if (src[i] === '$' && src[i + 1] === '{') {
        spans.push([textStart, i + 2]);
        i = scanCodeAt(i + 2, '}');
        textStart = i - 1;
        continue;
      }
      i += 1;
    }
    spans.push([textStart, i]);
    return i;
  };

  // 扫一段"代码"，直到遇见 `end` 对应的收尾（模板插值的 `}`）或文件尾；返回停止位置。
  const scanCodeAt = (from, end) => {
    let i = from;
    let depth = 0;
    while (i < src.length) {
      const ch = src[i];
      const two = src.slice(i, i + 2);
      if (end === '}' && ch === '}' && depth === 0) return i + 1;
      if (two === '//') {
        const nl = src.indexOf('\n', i);
        const e = nl === -1 ? src.length : nl;
        blank(i, e);
        i = e;
        continue;
      }
      if (two === '/*') {
        const close = src.indexOf('*/', i + 2);
        const e = close === -1 ? src.length : close + 2;
        blank(i, e);
        i = e;
        continue;
      }
      if (ch === '{') { depth += 1; i += 1; continue; }
      if (ch === '}') { depth -= 1; i += 1; continue; }
      if (ch === '/' && two !== '//' && two !== '/*' && canStartRegex(i)) { i = scanRegex(i); continue; }
      if (ch === '"' || ch === "'") { i = scanQuoted(i, ch); continue; }
      if (ch === '`') { i = scanTemplate(i); continue; }
      i += 1;
    }
    return i;
  };

  scanCodeAt(0, null);
  return { code: out.join(''), spans };
}

const inSpans = (spans, idx) => spans.some(([a, b]) => idx >= a && idx < b);

/**
 * 抽出源码里所有模块 specifier —— **五种形状都要看得见**：`import x from 'p'`、裸 `import 'p'`、
 * `export … from 'p'`、`import('p')`、`require('p')`。
 * 上一版只认第一种，所以 `import 'ws';` 抽到 0 个 specifier、黑名单也看不见它 ⇒ 用例恒真（G2）。
 * 判据改成"specifier 的形状"：不是 `node:` 内建、不是相对/绝对/file: 路径，就是第三方 ⇒ 红。
 * 形状上还要满足两条（上一版两条都不满足，第二轮复核各插一次就全绿漏检 —— N1）：
 *  ① **不许有行首锚**：`const zz = 1; import x from 'ws';` 里的 import 不在行首；
 *  ② **clause 可以跨行**：`import {\n  a,\n} from 'ws';` 里 `from` 在下一行。
 * 语句边界靠"不许跨 `;` / 引号"来兜（`[^;'"]*?`），所以放开锚也不会跨语句误配。
 * 命中起点落在字符串/模板区间内的丢掉：`const note = "require('ws');";` 是正当代码，不是依赖（N2 那类误报）。
 * 已知洞（如实登记在 testing-guide）：运行期拼出来的 specifier（`const p = 'w' + 's'; import(p)`）抽不到 ——
 * 这是文本扫描，只保证字形。
 */
function specifiers(src) {
  const { code, spans } = scanCode(src);
  const out = [];
  const push = (m) => { if (!inSpans(spans, m.index)) out.push(m[1]); };
  for (const m of code.matchAll(/import\s+[^;'"]*?\s+from\s*['"]([^'"]+)['"]/g)) push(m);
  for (const m of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) push(m);
  for (const m of code.matchAll(/export\s+[^;'"]*?\s+from\s*['"]([^'"]+)['"]/g)) push(m);
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m);
  for (const m of code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m);
  return out;
}

/** `specifiers()` 抽出来的东西里，哪些算第三方（判据只看形状，不维护黑名单）。 */
const thirdParty = (src) =>
  specifiers(src).filter(
    (s) => !(s.startsWith('node:') || s.startsWith('.') || s.startsWith('/') || s.startsWith('file:')),
  );

function mjsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...mjsFiles(p));
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

test('零依赖：browser/ 下 .mjs 的模块 specifier 只能是 node: 内建或相对/绝对路径（五种形状 × 跨行 clause × 非行首语句）', () => {
  // 先证抽取器与判据都看得见"裸包名"这一形状 —— 否则这条用例会恒真，装了第三方也全绿（G2 踩过的坑）。
  const P = 'ws';
  const q = (s) => `'${s}'`;
  const samples = [
    `import x from ${q(P)};`,
    `import ${q(P)};`,
    `export { a } from ${q(P)};`,
    `const w = await import(${q(P)});`,
    `const w = require(${q(P)});`,
  ];
  for (const s of samples) {
    assert.deepEqual(thirdParty(s), ['ws'], `这一形状的裸包名没被看见：${s}`);
  }
  assert.deepEqual(thirdParty("import fs from 'node:fs';\nimport a from './a.mjs';\nimport b from '/x/b.mjs';"), []);
  assert.deepEqual(specifiers("import 'ws';").length, 1, '裸 import 必须抽到一个 specifier');
  assert.deepEqual(thirdParty('// import w from "ws";\n'), [], '注释里的 import 不算依赖（否则守卫会咬到自己）');

  const files = mjsFiles(path.dirname(LIB));
  assert.ok(files.length >= 5, `browser/ 下至少要扫到 5 个 .mjs，实际 ${files.length}：${files.join(', ')}`);
  for (const f of files) {
    const bad = thirdParty(fs.readFileSync(f, 'utf8'));
    // 断言文本里点名裸包名：红了要一眼看出"是谁混进来了"，不能只报个 [] 不等于 []。
    assert.deepEqual(bad, [], `${f} 引了第三方依赖：${bad.join(', ')}`);
  }
});

test('零依赖：clause 跨行 / 语句不在行首 / `export * from` 都得看见（N1 的两种漏检形状）', () => {
  const P = 'ws';
  const q = (s) => `'${s}'`;
  const BT = String.fromCharCode(96);
  const open = '${';
  const close = '}';
  const shapes = {
    '多行 import clause': `import {\n  a,\n  b,\n} from ${q(P)};`,
    '不在行首的 import': `const zz = 1; import x from ${q(P)};`,
    '不在行首的裸 import': `const zz = 1; import ${q(P)};`,
    '多行 export clause': `doThing(); export {\n  a,\n} from ${q(P)};`,
    'export * from': `export * from ${q(P)};`,
    '注释夹在 import( 与引号之间': `const w = await import(/* c */ ${q(P)});`,
    '字符串里的 http:// 之后仍有真 import': `const u = 'http://x.example/a'; import y from ${q(P)};`,
    '模板插值里的动态 import': `const t = ${BT}${open}await import(${q(P)})${close}${BT};`,
    '字符串里的转义引号之后仍有真 import': `const u = 'a\\''; import y from ${q(P)};`,
  };
  for (const [name, s] of Object.entries(shapes)) {
    assert.deepEqual(thirdParty(s), ['ws'], `${name} 这一形状没被看见：${JSON.stringify(s)}`);
  }
  // 复核方要求"再自设至少一种新形状试着绕过"——这里两组，结果都登记进 testing-guide（红/绿都要报）：
  assert.deepEqual(thirdParty(`await import(/* t */ ${q(P)});`), ['ws'], '注释不该挡住检测（自设形状，红）');
  assert.deepEqual(
    thirdParty(`const p = 'w' + 's'; await import(p);`),
    [],
    '运行期拼出来的 specifier 抽不到 —— 文本扫描的已知洞（自设形状，绿）',
  );
});

test('零依赖：字符串字面量与注释里的 specifier 形状不算依赖（N2 的误报面）', () => {
  const q = (s) => `'${s}'`;
  const BT = String.fromCharCode(96);
  const clean = {
    '双引号字符串里的 require': `const note = "require('ws');";`,
    '单引号字符串里的 import': `const note = 'import x from "ws";';`,
    '整行注释': `// import x from 'ws';`,
    '行内 // 尾巴': `const a = 1; // import w from "ws"`,
    '块注释': `/* import x from 'ws'; */`,
    '模板字面量': `const t = ${BT}import(${q('ws')})${BT};`,
  };
  for (const [name, s] of Object.entries(clean)) {
    assert.deepEqual(thirdParty(s), [], `${name} 被误判成依赖了（N2 那类误报）：${JSON.stringify(s)}`);
  }
});

test('零依赖：正则字面量两个方向都不许错（R2）', () => {
  const P = 'ws';
  const q = (s) => `'${s}'`;
  // 方向一（漏检）：正则里那个奇数引号曾被当成字符串起点，把**同行后面真的** import 吞进 span（实测 98/98/0 全绿）。
  assert.deepEqual(
    thirdParty(`const re = /'/; import x from ${q(P)};`),
    ['ws'],
    '正则里的引号不该把后面的真 import 吞掉（R2 漏检面）',
  );
  // 方向二（误报）：正则体里的 import 不是依赖，正当代码不许判红。
  assert.deepEqual(
    thirdParty(`const re = /import x from ${q(P)}/;`),
    [],
    '正则体里的 import 不算依赖（R2 误报面）',
  );
  // 正则体里能出现 `/` 的两种地方：字符类 `[...]` 与转义 `\/` —— 都不结束正则，后面的真 import 仍要看见。
  assert.deepEqual(
    thirdParty(`const re = /[/]|\\//g; import x from ${q(P)};`),
    ['ws'],
    '字符类 / 转义斜杠之后仍要看见真 import',
  );
  assert.deepEqual(thirdParty(`const re = /import x from ${q(P)}/gi;`), [], '带旗标的正则体里的 import 也不算依赖');
  // 保守规则的残余边界：`/` 前面是标识符 / `)` / `]` ⇒ 一律当除法（不当正则），后面的真 import 照样要看见。
  assert.deepEqual(thirdParty(`const r = a / b;\nimport x from ${q(P)};`), ['ws'], '除法后面的真 import 要看见');
  assert.deepEqual(
    thirdParty(`const r = (a) / b; const t = arr[0] / 2; import x from ${q(P)};`),
    ['ws'],
    '`)` / `]` 后面的除号要当除法',
  );
  assert.deepEqual(thirdParty(`const n = 10; const x = n / 2; import y from ${q(P)};`), ['ws'], '标识符后面的除号要当除法');
  // 关键字后面能起正则：`return /re/` 里的引号同样不许吃掉后面的真 import。
  assert.deepEqual(
    thirdParty(`function f() { return /'/; } import x from ${q(P)};`),
    ['ws'],
    'return 后面的正则里那个引号不许把后面的真 import 吞掉',
  );
  // 残余局限：`/` 前面是 `)` / `]` / 标识符时一律当除法，所以**语句位置的正则**（`if (ok) /re/.test(s)`）认不出来。
  // 这两条把已知洞钉成期望值（跟上面"运行期拼出来的 specifier"一个套路）：哪天修好了它们会红，
  // 正好提醒去改 testing-guide 已知洞表里那一条。
  assert.deepEqual(
    thirdParty(`if (ok) /'/; import x from ${q(P)};`),
    [],
    '已知洞：`if (…) /re/` 位置的正则认不出来 ⇒ 正则里那个引号仍会把后面的真 import 吞掉（漏检）',
  );
  assert.deepEqual(
    thirdParty(`if (ok) /import x from ${q(P)}/;`),
    ['ws'],
    '已知洞：同上位置，正则体里的 import 仍会被误当依赖（误报）',
  );
});
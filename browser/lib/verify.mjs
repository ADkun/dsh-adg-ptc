// `browser/` 的判据层：一个动作到底有没有生效，只看**可观测差异**，不看任何调用的返回。
//
// 这条原则与 `desktop/lib/verify.mjs` 同形（`desktop/AGENTS.md` 红线 1）
// —— 那边的坑是 `SendInput` 报「已插入 N 个事件、GetLastError()=0」而事件被 UIPI 静默丢弃；
// 这边的坑完全一样：`element.click()` 不报错、CDP 的 `Input.dispatchMouseEvent` 回 `{}`、
// 事件真的发出去了，而页面什么也没变（被遮挡 / 被 `preventDefault` / 只是改了个 JS 变量 /
// 页面反应比 `--settle` 慢）。
//
// 所以：**任何 CDP 返回都不是成功证据**，`CHANGED=` 才是。三态里的 `unknown` 是必须的 ——
// **"我看不见这类动作的效果"绝不许报成 `false`**（`false` 会把真成功说成失败）。
//
// 本模块是纯函数 + 一次 DOM 探针的解析：不 import `cdp.mjs`、不 spawn 任何东西、不联网，
// 只要求传进来的 `session` 有 `evalJs(expr)`。所以单测能用罐装数据把三态钉住，全程不碰浏览器。

/** FNV-1a 32 位（与 `desktop/lib/elements.mjs` 的 `fnv1a32` 同算法同输入：按 UTF-8 字节跑）。
 *  这里只用来判"这段文本变没变"，**不是安全用途**；同一算法跨模块对齐，省得再引第二种哈希。 */
export function hashText(value) {
  const bytes = Buffer.from(String(value ?? ''), 'utf8');
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 动作发完之后等页面反应的默认时长（ms）。判据只能看到这段时间内的变化。 */
export const SETTLE_DEFAULT_MS = 150;

/** 判据域：一个动作的"效果"只可能落在这些类里。`ignore` 掉的类不参与比较。 */
export const KINDS = Object.freeze([
  'url',
  'title',
  'dom',
  'scroll',
  'active',
  'tabs',
  'elem',
  'value',
  'checked',
  'selected',
  'elemtext',
]);

/** 每一类判据由哪些字段承载（`CHANGED` 的 `REASON` 按类报，不按字段报）。 */
export const KIND_FIELDS = Object.freeze({
  url: ['url'],
  title: ['title'],
  dom: ['domDigest', 'domBytes'],
  scroll: ['scrollDigest'],
  active: ['activeDigest'],
  tabs: ['tabCount'],
  elem: ['elemExists', 'elemVisible', 'elemDisabled', 'elemReadOnly'],
  value: ['valueDigest', 'valueBytes'],
  checked: ['checked'],
  selected: ['selectedIndex'],
  elemtext: ['elemTextDigest', 'elemTextBytes'],
});

/**
 * 每条动作命令**专属**的判据（design.md 的 I14）。
 * `needsKinds` ＝ 这条命令的效果**只可能**落在这些类里 —— 这些类在前后都读不到时，
 * 结果必须是 `unknown` 而不是 `false`（看见的东西里没有差异，且看得见的东西**正好不含**这类效果）。
 * `ignore` ＝ 已知会被我们自己搅动、又不承载本次动作效果的类：`type` / `select` 会先 `focus()`，
 * `active` 必然变；`click` 的真实鼠标事件也会把焦点挪走（点一个**没人听**的 div 照样动 `active`）。
 * 这三条命令都把 `active` 从*判据*里去掉 —— 它仍然照原样打在 `BEFORE=` / `AFTER=` 里（看得见），
 * 只是不许它单独把读数抬成 `true`：那是"焦点动了"，不是"页面按你的意图作出了反应"。
 */
export const ACTION_CRITERIA = Object.freeze({
  click: Object.freeze({
    needsKinds: Object.freeze(['dom', 'tabs']),
    ignore: Object.freeze(['active']),
  }),
  type: Object.freeze({
    needsKinds: Object.freeze(['value', 'elemtext']),
    ignore: Object.freeze(['active']),
  }),
  select: Object.freeze({
    needsKinds: Object.freeze(['selected', 'value']),
    ignore: Object.freeze(['active']),
  }),
  'wait-for': Object.freeze({
    needsKinds: Object.freeze(['dom', 'tabs']),
    ignore: Object.freeze([]),
  }),
  // `hover` 自己不按键、不聚焦：它发出的是一个真实的指针位移，效果只可能落在"页面内容变了"
  // （下拉展开 / 提示浮层出现 / 内容被换掉）这一类上。`active` **不**忽略 —— 与 `click` 不同，
  // 指针位移本身不会挪焦点，所以焦点一变就是页面对这次悬停的真实反应，不该被从判据里去掉。
  hover: Object.freeze({
    needsKinds: Object.freeze(['dom', 'tabs']),
    ignore: Object.freeze([]),
  }),
});

/**
 * `false` 的引导句：这条命令的判据**看不见**哪些效果（照 desktop 的 `kindTail` 写）。
 * 判据域边界那一句（`ATTR_BLIND`）五条动作命令都带上：元素属性 / `class` / `style` 不在判据域内，
 * 而"只改这三样"是最常见的一类漏报面（真机 A80 已实测）。这句话、`design.md` 的「判据域」一处、
 * 以及 `testing-guide.md` 的漏报面条目**三处口径必须一致**。
 */
const ATTR_BLIND =
  '本判据**不含属性 / `class` / `style` 这几个字段本身**：只有"只改它们、而且正文与其余各类都不动"时才必然读成"没有差异"；这些改动**一旦波及任何可比字段**（正文 `innerText`、目标元素的存在性 / 可见性 / 禁用 / 只读、`value` / `checked` / `selectedIndex`、`url` / `title` / `scroll` / `tabs`（`active` 只在 `hover` / `wait-for` 的判据里 —— `click` / `type` / `select` 把它从判据中去掉了：它仍照原样打在 `BEFORE=` / `AFTER=` 里，只是不许它单独把读数抬成 `true`）），判据**照样看得见**（真机实测：`display:none → block` 与 `visibility:hidden → visible` 都 ⇒ `CHANGED=true`；反过来 A80 的 `click #attr` ⇒ `CHANGED=false`，而回读 `data-hit` 从 `0` 变 `1`）——所以别只盯着这一个 `false`：要证明它生效，请自己用 `--js` 断言表达式或 `eval` 回读你要的那个属性 / 样式。';

export const INVISIBLE_TAIL = Object.freeze({
  click:
    '页面里只改了 JS 变量、发起了网络请求、触发了文件选择框 / 下载 / 新窗口 / 跳转之外的副作用，或页面反应晚于 --settle（默认 150ms）——要证明它生效，请看页面自己的证据（计数器 / 日志 / 服务端）。' +
    ' ' +
    ATTR_BLIND,
  type:
    '页面把输入拦下了（`beforeinput` 里 `preventDefault` —— 注意 `keydown` 里拦不住 `Input.insertText`，见 A81）、或目标不是 `input` / `textarea` / `contenteditable`（那种情况下这条命令会直接报用法错）、或输入进了别的地方；另外，只有 `keydown` 监听器的页面**收不到逐键事件**，而 `value` 变了照样会读成"有差异"。要证明它生效，请独立读回该元素的值。' +
    ' ' +
    ATTR_BLIND,
  select:
    '页面依赖 `isTrusted`（本命令派发的事件不是用户事件），或页面在 `change` 处理函数里把值改回去了，或页面只看原生下拉 UI 的交互。' +
    ' ' +
    ATTR_BLIND,
  'wait-for':
    '等待期间页面可能发生了本判据看不见的变化（JS 变量 / 网络请求）；条件成立与否的答案在 `WAIT=` 那一行，不在 `CHANGED=` 里。' +
    ' ' +
    ATTR_BLIND,
  hover:
    '页面只做了纯 CSS `:hover` 的**样式**变化：判据的边界**不是"样式 vs 非样式"，而是"这次变化有没有落在可比字段上"** —— 改到 `display` / `visibility` 这类**会改动 `body.innerText` 的展开**（下拉 / 折叠 / 带文本的浮层）判据**看得见**（真机实测：`.r6card:hover .r6open { display: block }` ⇒ `CHANGED=true`、`REASON=可观测差异：dom / elemtext`；`.r7card:hover .vis { visibility: visible }` ⇒ `CHANGED=true`、`dom=8b39379a/59 → 4e0b3c2a/69`、`body.innerText` 35 → 39 **字符**（同一条读数的 `dom=` 里 `/59 → /69` 才是**字节**：`dom=` 取的是 `Buffer.byteLength(document.body.innerText)`））；只有不改 `innerText` 的纯视觉属性（配色 / 边框 / 光标 / 阴影 / `opacity`）才必然读成"没有差异"（真机实测：`opacity` 从 `0` 变 `1` ⇒ `CHANGED=false`，而回读 `fadeOpacity` 从 `"0"` 变 `"1"`）。另外：只改了 JS 变量、发起了网络请求、或页面反应晚于 --settle（默认 150ms）也一样看不出来 —— 要证明它生效，请自己用 `eval` 回读（`getComputedStyle` 取 `visibility` / `display`，或 `offsetParent` 判 `display:none`）。' +
    ' ' +
    ATTR_BLIND,
});

/**
 * 页面内取一次「DOM 可观测状态」的表达式（design.md 的 I13）。
 * 只有正则会话里真实存在的东西：`location` / `document` / `getComputedStyle`。
 * 元素用 `style.display`、`getClientRects`、`elementFromPoint` 走**正**路判可见，
 * 不靠任何已废弃 API（旧的 IntersectionObserver 实验性钩子在这里没用，也不用）。
 */
export function stateExpr(selector = null) {
  const sel = selector === null || selector === undefined ? 'null' : JSON.stringify(String(selector));
  return `(() => {
  const SEL = ${sel};
  const MAXTEXT = 200000;
  const clip = (v, n) => { const s = String(v == null ? '' : v); return s.length > n ? s.slice(0, n) : s; };
  const describe = (el) => {
    const cs = window.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const visible =
      cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse' &&
      Number(cs.opacity) !== 0 && (r.width > 0 || r.height > 0);
    return {
      exists: true,
      tag: el.tagName ? String(el.tagName).toLowerCase() : '',
      visible,
      disabled: el.disabled === true,
      readOnly: el.readOnly === true,
      editable: el.isContentEditable === true,
      value: typeof el.value === 'string' ? clip(el.value, 100000) : null,
      checked: typeof el.checked === 'boolean' ? el.checked : null,
      selectedIndex: el.tagName === 'SELECT' && typeof el.selectedIndex === 'number' ? el.selectedIndex : null,
      text: el.innerText != null ? clip(el.innerText, 100000) : null,
    };
  };
  const out = {
    url: location.href,
    title: String(document.title == null ? '' : document.title),
    hasFocus: document.hasFocus(),
  };
  const body = document.body ? String(document.body.innerText == null ? '' : document.body.innerText) : '';
  out.domText = clip(body, MAXTEXT);
  out.domTruncated = body.length > MAXTEXT;
  const de = document.documentElement;
  out.scroll = [window.scrollX, window.scrollY, de ? de.scrollTop : 0, de ? de.scrollLeft : 0];
  const a = document.activeElement;
  out.active = a ? String(a.tagName || '').toLowerCase() + (a.id ? '#' + a.id : '') : '';
  out.element = null;
  if (SEL !== null) {
    let el = null;
    try {
      el = document.querySelector(SEL);
    } catch (e) {
      out.selectorError = String(e && e.message ? e.message : e);
      return out;
    }
    out.element = el ? describe(el) : { exists: false };
  }
  return out;
})()`;
}

function str(value) {
  return value === null || value === undefined ? '' : String(value);
}

/** 探针原始结果 → 归一化状态。**缺字段一律补空值，绝不补"猜的值"**（照 desktop 的 `normalizeState`）。 */
export function normalizeState(raw, { selector = null } = {}) {
  const state = {
    ok: false,
    error: null,
    url: '',
    title: '',
    hasFocus: null,
    domDigest: '',
    domBytes: 0,
    domTruncated: false,
    scrollDigest: '',
    activeDigest: '',
    selector,
    elem: selector === null ? null : { exists: false },
    tabs: { ok: false, count: null, error: null },
  };
  if (!raw || typeof raw !== 'object') {
    state.error = '页面探针没有返回对象';
    return state;
  }
  state.ok = true;
  state.url = str(raw.url);
  state.title = str(raw.title);
  state.hasFocus = typeof raw.hasFocus === 'boolean' ? raw.hasFocus : null;
  const domText = str(raw.domText);
  state.domDigest = hashText(domText);
  state.domBytes = Buffer.byteLength(domText, 'utf8');
  state.domTruncated = raw.domTruncated === true;
  state.scrollDigest = hashText(JSON.stringify(Array.isArray(raw.scroll) ? raw.scroll : null));
  state.activeDigest = hashText(str(raw.active));
  if (selector !== null) state.elem = normalizeElement(raw.element, selector);
  return state;
}

function normalizeElement(el, selector) {
  if (selector === null) return null;
  if (!el || typeof el !== 'object' || el.exists !== true) return { exists: false };
  const value = typeof el.value === 'string' ? el.value : null;
  const text = typeof el.text === 'string' ? el.text : null;
  return {
    exists: true,
    tag: str(el.tag),
    visible: el.visible === true,
    disabled: el.disabled === true,
    readOnly: el.readOnly === true,
    editable: el.editable === true,
    valueDigest: value === null ? null : hashText(value),
    valueBytes: value === null ? null : Buffer.byteLength(value, 'utf8'),
    checked: typeof el.checked === 'boolean' ? el.checked : null,
    selectedIndex: Number.isInteger(el.selectedIndex) ? el.selectedIndex : null,
    textDigest: text === null ? null : hashText(text),
    textBytes: text === null ? null : Buffer.byteLength(text, 'utf8'),
  };
}

/** 标签页读数的归一化：读不到与"读到 0 个"必须分开（`ok:false` vs `ok:true,count:0`）。 */
export function normalizeTabs(list) {
  const pages = Array.isArray(list)
    ? list.filter(
        (t) =>
          t &&
          t.type === 'page' &&
          typeof t.webSocketDebuggerUrl === 'string' &&
          t.webSocketDebuggerUrl !== '' &&
          !String(t.url ?? '').startsWith('devtools://'),
      )
    : null;
  if (pages === null) return { ok: false, count: null, error: '标签页列表不是数组' };
  return { ok: true, count: pages.length, error: null };
}

/**
 * 取一次状态。`session.evalJs(expr)` 抛错**不算致命**：它只是让 DOM 这一类读数缺测
 * （`ok:false` + 原始错误文本），后面由 `changeVerdict` 判成 `unknown` —— 绝不许当成"没有变化"。
 * `listTabs` 同理：给不出就只是 `tabs` 这一类缺测。
 */
export async function captureState(session, { selector = null, listTabs = null } = {}) {
  let state;
  try {
    state = normalizeState(await session.evalJs(stateExpr(selector)), { selector });
  } catch (e) {
    state = normalizeState(null, { selector });
    state.error = e?.message ?? String(e);
  }
  if (typeof listTabs === 'function') {
    try {
      state.tabs = normalizeTabs(await listTabs());
    } catch (e) {
      state.tabs = { ok: false, count: null, error: e?.message ?? String(e) };
    }
  }
  return state;
}

/** 某类判据在这一侧**读到了**吗（读不到 ≠ 没变化；这是三态里 `unknown` 的唯一来源）。 */
export function kindReadable(state, kind) {
  if (!state || state.ok !== true) return false;
  switch (kind) {
    case 'url':
    case 'title':
    case 'dom':
    case 'scroll':
    case 'active':
      return true;
    case 'tabs':
      return state.tabs?.ok === true;
    case 'elem':
      return state.elem !== null;
    case 'value':
      return state.elem?.exists === true && state.elem.valueDigest !== null;
    case 'checked':
      return state.elem?.exists === true && state.elem.checked !== null;
    case 'selected':
      return state.elem?.exists === true && state.elem.selectedIndex !== null;
    case 'elemtext':
      return state.elem?.exists === true && state.elem.editable === true && state.elem.textDigest !== null;
    default:
      return false;
  }
}

/** 字段读取表：字段名 → 取值（缺测一律 `null`，与"读到 false / 0"分开）。 */
const COMPARE_FIELDS = Object.freeze([
  { field: 'url', kind: 'url', get: (s) => (s.ok ? s.url : null) },
  { field: 'title', kind: 'title', get: (s) => (s.ok ? s.title : null) },
  { field: 'domDigest', kind: 'dom', get: (s) => (s.ok ? s.domDigest : null) },
  { field: 'domBytes', kind: 'dom', get: (s) => (s.ok ? s.domBytes : null) },
  { field: 'scrollDigest', kind: 'scroll', get: (s) => (s.ok ? s.scrollDigest : null) },
  { field: 'activeDigest', kind: 'active', get: (s) => (s.ok ? s.activeDigest : null) },
  { field: 'tabCount', kind: 'tabs', get: (s) => (s.tabs?.ok ? s.tabs.count : null) },
  { field: 'elemExists', kind: 'elem', get: (s) => (s.elem === null ? null : s.elem.exists ? 1 : 0) },
  { field: 'elemVisible', kind: 'elem', get: (s) => (s.elem?.exists ? (s.elem.visible ? 1 : 0) : null) },
  { field: 'elemDisabled', kind: 'elem', get: (s) => (s.elem?.exists ? (s.elem.disabled ? 1 : 0) : null) },
  { field: 'elemReadOnly', kind: 'elem', get: (s) => (s.elem?.exists ? (s.elem.readOnly ? 1 : 0) : null) },
  { field: 'valueDigest', kind: 'value', get: (s) => s.elem?.valueDigest ?? null },
  { field: 'valueBytes', kind: 'value', get: (s) => s.elem?.valueBytes ?? null },
  { field: 'checked', kind: 'checked', get: (s) => s.elem?.checked ?? null },
  { field: 'selectedIndex', kind: 'selected', get: (s) => s.elem?.selectedIndex ?? null },
  { field: 'elemTextDigest', kind: 'elemtext', get: (s) => s.elem?.textDigest ?? null },
  { field: 'elemTextBytes', kind: 'elemtext', get: (s) => s.elem?.textBytes ?? null },
]);

/** 一行摘要（`BEFORE=` / `AFTER=` 打的就是它）：够用来肉眼比对，又不至于把输出撑爆。 */
export function digestOf(state) {
  const e = state?.elem ?? null;
  const clip = (v, n) => {
    const s = String(v ?? '');
    return s.length > n ? `${s.slice(0, n)}…` : s;
  };
  const elem = (() => {
    if (state?.selector === null || state?.selector === undefined) return 'n/a';
    if (!e || e.exists !== true) return '不存在';
    const marks = [
      e.visible ? '' : '不可见',
      e.disabled ? 'disabled' : '',
      e.readOnly ? 'readonly' : '',
      e.editable ? 'editable' : '',
    ].filter(Boolean);
    return `${e.tag || '?'}${marks.length ? `(${marks.join(',')})` : ''}`;
  })();
  return [
    `ok=${state?.ok ? 'true' : 'false'}`,
    `url=${clip(state?.url, 80)}`,
    `title=${clip(state?.title, 60)}`,
    `dom=${state?.domDigest || '-'}/${state?.domBytes ?? 0}${state?.domTruncated ? '(截断)' : ''}`,
    `scroll=${state?.scrollDigest || '-'}`,
    `active=${state?.activeDigest || '-'}`,
    `tabs=${state?.tabs?.ok ? state.tabs.count : 'unknown'}`,
    `elem=${elem}`,
    `value=${e?.valueDigest ? `${e.valueDigest}/${e.valueBytes}` : '-'}`,
    `checked=${e?.checked ?? '-'}`,
    `selected=${e?.selectedIndex ?? '-'}`,
    `elemtext=${e?.textDigest ? `${e.textDigest}/${e.textBytes}` : '-'}`,
  ].join(' ');
}

/**
 * 前后状态比对 → 差异集合。两侧至少一侧探针失败时**整份退出比较**（`probeFailed`），
 * 因为"读不到"与"读到了但没变"是两回事（照 desktop 的 `compareStates`）。
 */
export function compareStates(before, after, { ignore = [] } = {}) {
  const skip = new Set(ignore);
  const reasons = [];
  const probeFailed = !(before?.ok === true && after?.ok === true);
  if (!probeFailed) {
    for (const f of COMPARE_FIELDS) {
      if (skip.has(f.kind)) continue;
      const a = f.get(before);
      const b = f.get(after);
      if (a !== b) reasons.push({ field: f.field, kind: f.kind, before: a, after: b });
    }
  }
  const reasonKinds = [...new Set(reasons.map((r) => r.kind))];
  return {
    changed: reasons.length > 0,
    probeFailed,
    beforeOk: before?.ok === true,
    afterOk: after?.ok === true,
    reasons,
    reasonKinds,
    ignore: [...skip],
    digestBefore: digestOf(before),
    digestAfter: digestOf(after),
    before,
    after,
  };
}

/**
 * 差异集合 → 三态。
 * 顺序（与 desktop 的 `changeVerdict` 同）：
 *   1. 有差异 ⇒ `true`（唯一能正面证明"生效"的读数）；
 *   2. 任一侧探针失败 ⇒ `unknown`（"读不到"绝不许读成"没变化"）；
 *   3. 这条命令专属的判据类**每一类**在前后都读不到 ⇒ `unknown`（看不见这类效果）；
 *   4. 还有可比的类且都没变 ⇒ `false`；
 *   5. 连一类可比的都没有 ⇒ `unknown`。
 */
export function changeVerdict(cmp, { needsKinds = [], ignore = [] } = {}) {
  if (cmp.changed) {
    return {
      changed: 'true',
      reason: `可观测差异：${cmp.reasonKinds.join(' / ')}（共 ${cmp.reasons.length} 个字段）`,
      kinds: cmp.reasonKinds,
    };
  }
  if (!cmp.beforeOk || !cmp.afterOk) {
    return {
      changed: 'unknown',
      reason: `${cmp.beforeOk ? '后' : '前'}一次 DOM 探针失败 ⇒ 无从比较，**不是**"没有变化"`,
      kinds: [],
    };
  }
  const needed = needsKinds.filter((k) => KINDS.includes(k));
  // "可比"＝**前后两侧都读得到**：只在一侧读到的类算不可比（那是"读没了"，不是"没变"）。
  const missing = needed.filter((k) => !(kindReadable(cmp.before, k) && kindReadable(cmp.after, k)));
  if (needed.length > 0 && missing.length === needed.length) {
    return {
      changed: 'unknown',
      reason: `这条命令专属的判据（${needed.join(' / ')}）在前后都读不到 —— 看不见这类效果，绝不许报 false`,
      kinds: [],
    };
  }
  const visible = KINDS.filter(
    (k) => !cmp.ignore.includes(k) && kindReadable(cmp.before, k) && kindReadable(cmp.after, k),
  );
  if (visible.length === 0) {
    return { changed: 'unknown', reason: '没有任何一类可读的判据域，比不了', kinds: [] };
  }
  return {
    changed: 'false',
    reason: `可比读到的 ${visible.join(' / ')} 都没有变化（本次判据只覆盖这些类）`,
    kinds: [],
  };
}

/**
 * 引导句：只描述现象与"接下来该怀疑什么"，**不下"成功 / 失败"结论**（照 desktop 的 `injectionWarn`）。
 * 这类行写错方向比不写更坏，所以按命令分开写；`true` 不给引导句（不需要解释）。
 */
export function verdictWarn(action, verdict, cmp) {
  const tail = INVISIBLE_TAIL[action] ?? '本判据覆盖不到的效果无从观察。';
  const changedKinds = cmp.reasonKinds.length > 0 ? `（有差异的类：${cmp.reasonKinds.join(' / ')}）` : '';
  if (verdict.changed === 'true') return null;
  if (verdict.changed === 'unknown') {
    return `${verdict.reason}；unknown 既不是"成功"也不是"没生效"，它是"这类效果本次没读成"。${tail}`;
  }
  return `只有本次判据覆盖到的读数没有差异，**绝不等于**"动作没生效"${changedKinds}。本判据看不见的效果：${tail}`;
}
// `browser/` 的动作面：`click` / `hover` / `type` / `select` / `wait-for` 五条命令的实现与判据接线。
//
// 分层：本模块只做「用法校验 + 页面内动作 + 判据接线」三件事。它不碰 CDP 通道（只要求传进来的
// `session` 有 `evalJs(expr)` 与 `send(method, params)`），也不管端口 / profile / 标签页卫生
// （那些在 `cli.mjs` 与 `lib/cdp.mjs`）。这样 `test/actions.test.mjs` 能用一个假 session
// 把五条命令的用法错误面与三态钉住，全程不碰浏览器、不联网、零依赖。
//
// 四条实现口径（都是本次刻意选的，改动要连文档一起改）：
//   · `click` 走 `Input.dispatchMouseEvent` 的 mousePressed + mouseReleased —— **真实输入事件**，
//     等价于用户真的按了一下鼠标（`element.click()` 或页面内 `dispatchEvent` 是合成事件，
//     页面用 `isTrusted` 就能分辨，而且不经过浏览器的命中测试）。
//   · `hover` 走 `Input.dispatchMouseEvent` 的 mouseMoved（显式 `buttons: 0`）—— 把真实指针移到元素中心，
//     让页面按"鼠标进入"处理（`mouseenter` / `mouseover`，浏览器自己的命中测试决定进入哪个元素）。
//     "靠指针进入才展开"的下拉 / 菜单只有这一条路：它可能是 CSS `:hover`，也可能是页面自己的
//     `mouseenter` 监听；两者都要求指针**真的**进到那个元素上（本用例是后者）。与 `click` 的顺序是
//     先 `hover` 再 `click` —— 展开之前下拉里的项既不可见也点不到。
//     **本次不动 `click` 的事件序列**（仍是 pressed + released，不前置 mouseMoved）：加前置位移会
//     改既有契约，而且"移过去"本身会触发 mouseenter 副作用（有的页面据此记账 / 开浮层）。
//   · `type` 走 `Input.insertText` —— 与 `keyDown`/`keyUp` 逐字符相比，它是**一次插入整段文本**：
//     中文 / emoji / 组合字符不会被拆成半个码位，也不会被输入法状态改写；代价是不触发逐键的
//     `keydown` / `keyup`（只触发 `beforeinput` / `input`）。要知道用哪个域，看下面 `type` 的注释。
//   · `select` 走 `Runtime.evaluate`：设 `<select>` 的 `value` 再派发 `input` / `change`。
//     模拟"点开原生下拉再点选项"需要驱动操作系统级的弹层（Chromium 的下拉是独立窗口，
//     `Input.dispatchMouseEvent` 点不到里面的项），真要做只能靠 `Page.setInterceptFileChooserDialog`
//     那一类实验接口，而它不覆盖 select。DOM 赋值 + 派发事件是浏览器自身在用户选择时做的事，
//     页面能观测到的部分一致（除了 `isTrusted`）。
//
// 五条命令的共同点：**动作发出去之后必须自己复核**（看 `lib/verify.mjs`），
// 输出里没有 `CHANGED=true` 就不算证明生效。
//
// 不变量落点（定义在 `design.md`，编号是跨文件引用的锚）：
//   I11 用法错误＝退出码 2（本模块的 `UsageError`）· I12 每条命令一份开关清单（`COMMAND_FLAGS`）
//   I13 元素定位 / 动作执行 / 状态探针三件事都在页面内各读一次
//   I14 判据三态（`lib/verify.mjs`：`captureState` / `compareStates` / `changeVerdict`）
//   I15 wait-for 的超时是"没等到"的确定读数（`WAIT=timeout` + 退出码 1），不是静默成功
//   I16 所有闸门**先于发事件**（click / hover 的命中自检 / type 的焦点回读与可输入性 / select 的选项存在性）
//   I17 动作类命令选页方式唯一，且 `--match` 必须唯一命中（`matchHits`）

import {
  ACTION_CRITERIA,
  SETTLE_DEFAULT_MS,
  captureState,
  changeVerdict,
  compareStates,
  digestOf,
  verdictWarn,
} from './verify.mjs';

/** 用法错误：退出码 2（与 `cli.mjs` 的约定一致，见 design.md 的 I11）。 */
export class UsageError extends Error {}

export const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

/**
 * 每条命令认识的开关（design.md 的 I12）。`COMMON_FLAGS` 每条命令都能用。
 * 来源：真机踩过 `desktop/` 的 `move --button right` 拿到普通移动、`type --x 5 --y 6` 悄悄丢掉坐标、
 * 拼错开关名（`--dryrun`）什么都不报 —— **用不上的开关必须报用法错，不许静默忽略**。
 */
export const COMMON_FLAGS = Object.freeze(['port', 'profile']);

export const COMMAND_FLAGS = Object.freeze({
  help: [],
  launch: Object.freeze(['url', 'wait', 'headless', 'headed']),
  status: Object.freeze([]),
  tabs: Object.freeze([]),
  profile: Object.freeze([]),
  health: Object.freeze([]),
  open: Object.freeze(['url']),
  'close-tab': Object.freeze(['match', 'tab']),
  close: Object.freeze([]),
  text: Object.freeze(['url', 'match', 'tab', 'out', 'keep', 'max-bytes']),
  eval: Object.freeze(['url', 'match', 'tab', 'js', 'file', 'keep']),
  shot: Object.freeze(['url', 'match', 'tab', 'out', 'full', 'keep']),
  click: Object.freeze(['url', 'match', 'tab', 'selector', 'force', 'settle']),
  hover: Object.freeze(['url', 'match', 'tab', 'selector', 'force', 'settle']),
  type: Object.freeze(['url', 'match', 'tab', 'selector', 'text', 'clear', 'settle']),
  select: Object.freeze(['url', 'match', 'tab', 'selector', 'value', 'settle']),
  'wait-for': Object.freeze([
    'url',
    'match',
    'tab',
    'selector',
    'visible',
    'url-match',
    'js',
    'timeout',
    'interval',
  ]),
});

/** 这次动作面的五条命令（它们共用"选页必须唯一命中"与"一次只对一个页面做动作"的约束）。 */
export const ACTION_COMMANDS = Object.freeze(['click', 'hover', 'type', 'select', 'wait-for']);

/** 某条命令认识的开关集合；不认识的命令返回 `null`（**不猜**清单，交给后面的"不认识命令"）。 */
export function allowedFlags(cmd) {
  const extra = COMMAND_FLAGS[String(cmd ?? '')];
  if (!extra) return null;
  return new Set([...COMMON_FLAGS, ...extra]);
}

/**
 * 开关作用域校验：在**分发之前**跑，把用不上的开关当场判成用法错（退出码 2）。
 * `--url` 收集在 `args.urls` 里（`parseArgs` 的写法），所以它要单独看。
 */
export function checkFlagScope(args, cmd) {
  const allowed = allowedFlags(cmd);
  if (!allowed) return;
  const known = [...allowed].map((f) => `--${f}`).join(' / ');
  for (const key of Object.keys(args)) {
    if (key === '_' || key === 'urls') continue;
    if (!allowed.has(key)) {
      throw new UsageError(`${cmd} 不认识开关：--${key}（这条命令认识：${known}）`);
    }
  }
  if (args.urls.length > 0 && !allowed.has('url')) {
    throw new UsageError(`${cmd} 不认识开关：--url（这条命令认识：${known}）`);
  }
  if (args.urls.length > 1 && ACTION_COMMANDS.includes(cmd)) {
    throw new UsageError(`${cmd} 只接受一个 --url：一次只对一个页面做动作（收到 ${args.urls.length} 个）`);
  }
  return allowed;
}

/** 面向前四条动作命令的位置参数检查（跳过的第一个位置参数是命令名 / 选择器，已在 selectorOf 里用掉）。 */
function extraPositionals(args, cmd) {
  if (args._.length > 2) {
    throw new UsageError(`${cmd} 不认识多余的位置参数：${args._.slice(2).join(' ')}`);
  }
}

function boolFlag(args, name, cmd) {
  const v = args[name];
  if (v === undefined) return false;
  if (v !== true) {
    throw new UsageError(`--${name} 是开关，不接受值（收到 ${String(v)}）—— 不要它就别写这个开关`);
  }
  return true;
}

export function intOpt(args, name, fallback, min, max, cmd) {
  if (args[name] === undefined) return fallback;
  if (args[name] === true || args[name] === '') {
    throw new UsageError(`--${name} 后面缺少值（${cmd}）`);
  }
  const n = Number(args[name]);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(`--${name} 必须是 ${min}…${max} 的整数（收到 ${String(args[name])}）`);
  }
  return n;
}

function selectorOf(args, cmd) {
  const raw = args.selector !== undefined ? args.selector : args._[1];
  if (raw === undefined) {
    throw new UsageError(`${cmd} 需要 --selector <css 选择器>（也可以作为第一个位置参数给出）`);
  }
  if (raw === true || raw === '') throw new UsageError(`${cmd}：--selector 后面缺少 CSS 选择器`);
  if (typeof raw !== 'string') throw new UsageError(`${cmd}：--selector 只接受字符串`);
  return raw;
}

function textFlag(args, name, cmd) {
  const v = args[name];
  if (v === undefined) throw new UsageError(`${cmd} 需要 --${name} <字符串>`);
  if (v === true) throw new UsageError(`${cmd}：--${name} 后面缺少字符串`);
  if (typeof v !== 'string') throw new UsageError(`${cmd}：--${name} 只接受字符串`);
  // 空字符串**不在这里**判：`--text ""` 由 type 单独拒（区分不了"没生效"），
  // `--value ""` 是合法的（很多 <select> 就有个空值的"请选择"项）。
  return v;
}

/**
 * 选页参数（`cdp.pageSession` 的 opts）。三条路只能走一条，**不做任何猜测**：
 * `--url`（按地址**子串**命中 —— 与 `--match` 走同一条路，只是用地址来唯一化）/ `--match`（url 或
 * title 子串）/ `--tab`（序号），都没给就是 0 号页。命中口径在 `cdp.pickPage`，两边都是 `includes`。
 * 动作类命令还要额外过 `matchHits`（I17）：命中多页时**拒发**，不许默默取第一页
 * —— 动作会落在那一页上，而调用方从输出里看不出选错了哪一页。
 * 返回里的 `flag` 是**实际给的那个开关名**，只用于拒发文案（`hitScopeError`）：文案写错开关名，
 * 调用方会去找一个自己没给过的开关。
 */
export function pageTarget(args) {
  if (args.urls.length > 0) return { match: String(args.urls[0]), flag: '--url' };
  if (args.match !== undefined) {
    if (args.match === true || args.match === '') throw new UsageError('--match 后面缺少子串');
    return { match: String(args.match), flag: '--match' };
  }
  if (args.tab !== undefined) {
    if (args.tab === true || args.tab === '') throw new UsageError('--tab 后面缺少序号');
    const n = Number(args.tab);
    if (!Number.isInteger(n) || n < 0) {
      throw new UsageError(`--tab 必须是 >= 0 的整数（收到 ${String(args.tab)}）`);
    }
    return { index: n };
  }
  return { index: 0 };
}

/** 动作类命令的选页方式唯一性（给了多个就拒，不许"优先用某一个"）。 */
export function checkPageScope(args, cmd) {
  const given = [
    args.urls.length > 0 ? '--url' : null,
    args.match !== undefined ? '--match' : null,
    args.tab !== undefined ? '--tab' : null,
  ].filter(Boolean);
  if (given.length > 1) {
    throw new UsageError(`${cmd} 的选页方式只能给一个（收到 ${given.join(' + ')}）`);
  }
}

/**
 * 动作类命令的 `--match` 必须**唯一命中**（I17）——命中多页时由调用方拒发（用法错 2）。
 * 这是 I7「选页不许猜」在动作面上的收紧：读一页时取第一个命中最多是读错页，点一页时是**改错页**。
 * `pages` 传 `cdp.pickPage(targets, {})` 的 `.pages`（可驱动页面的筛选口径一致，见 `cdp.mjs`）。
 */
export function matchHits(pages, match) {
  const want = String(match);
  return (Array.isArray(pages) ? pages : []).filter(
    (t) => String(t?.url ?? '').includes(want) || String(t?.title ?? '').includes(want),
  );
}

/**
 * 命中多页时的拒发文案（I17）。**开关名必须写实际给的那个**：用 `--url` 调用却报 `--match`，
 * 调用方会去找一个自己没给过的开关，读不出"是地址取得太宽"这件事。
 * 也不许写"改用 --url <完整地址>"—— `--url` 与 `--match` 一样是子串命中，"更完整"并不保证唯一。
 * 行为不变：拒发（退出码 2），`--force` 也不能绕过 —— 那条路管的是"点在别的东西上"，不是"选哪一页"。
 */
export function hitScopeError(flag, match, count) {
  return (
    `${flag} ${match} 命中 ${count} 页（动作命令要求唯一命中）：` +
    '请把子串写长一点，或改用 --tab <序号>；多余的页可以先 close-tab 收走'
  );
}

export function clickSpec(args) {
  const selector = selectorOf(args, 'click');
  extraPositionals(args, 'click');
  return {
    selector,
    force: boolFlag(args, 'force', 'click'),
    settleMs: settleOf(args),
  };
}

export function hoverSpec(args) {
  const selector = selectorOf(args, 'hover');
  extraPositionals(args, 'hover');
  return {
    selector,
    force: boolFlag(args, 'force', 'hover'),
    settleMs: settleOf(args),
  };
}

export function typeSpec(args) {
  const selector = selectorOf(args, 'type');
  extraPositionals(args, 'type');
  const text = textFlag(args, 'text', 'type');
  if (text.length === 0) {
    throw new UsageError(
      'type：--text 是空字符串 —— 输入 0 个字符无法与"输入没生效"区分开，拒绝执行（要清空请用 --clear）',
    );
  }
  return { selector, text, clear: boolFlag(args, 'clear', 'type'), settleMs: settleOf(args) };
}

export function selectSpec(args) {
  const selector = selectorOf(args, 'select');
  extraPositionals(args, 'select');
  return {
    selector,
    value: textFlag(args, 'value', 'select'),
    settleMs: settleOf(args),
  };
}

function settleOf(args) {
  return intOpt(args, 'settle', SETTLE_DEFAULT_MS, 0, 60000, '--settle');
}

/**
 * `wait-for` 的三个条件只能给一个；超时与轮询间隔**必须有**（超时是"没等到"的确定读数）。
 * `--js` 在这里做一次**语法检查**（`new Function` 只编译不执行）：语法错当场是用法错（退出码 2），
 * 运行期抛错（比如表达式引用的变量还不存在）留在轮询里当"条件还不成立"，两者不许混。
 */
export function waitForSpec(args) {
  const given = [
    args.selector !== undefined ? '--selector' : null,
    args['url-match'] !== undefined ? '--url-match' : null,
    args.js !== undefined ? '--js' : null,
  ].filter(Boolean);
  if (given.length === 0) {
    throw new UsageError(
      'wait-for 需要三个条件之一：--selector <css>（元素出现/可见）/ --url-match <子串>（地址匹配）/ --js <表达式>（为真）',
    );
  }
  if (given.length > 1) {
    throw new UsageError(`wait-for 的条件只能给一个（收到 ${given.join(' + ')}）`);
  }
  const timeoutMs = intOpt(args, 'timeout', 10000, 1, 600000, 'wait-for');
  const intervalMs = intOpt(args, 'interval', 200, 1, 60000, 'wait-for');
  if (args.visible !== undefined && given[0] !== '--selector') {
    throw new UsageError(`${given[0]} 没有"可见"这一说：--visible 只跟 --selector 一起用`);
  }
  if (given[0] === '--selector') {
    return {
      cond: 'selector',
      selector: selectorOf(args, 'wait-for'),
      requireVisible: boolFlag(args, 'visible', 'wait-for'),
      timeoutMs,
      intervalMs,
    };
  }
  if (given[0] === '--url-match') {
    const urlMatch = textFlag(args, 'url-match', 'wait-for');
    if (urlMatch === '') {
      throw new UsageError('wait-for：--url-match 是空字符串 —— 它匹配任何地址（等于立刻返回），拒绝执行');
    }
    return { cond: 'url', urlMatch, timeoutMs, intervalMs };
  }
  const js = textFlag(args, 'js', 'wait-for');
  try {
    // 只编译，不执行 —— 语法错是用法错，不是"条件还不成立"。
    new Function(`return (${js});`);
  } catch (e) {
    throw new UsageError(`wait-for：--js 不是合法表达式：${e?.message ?? String(e)}`);
  }
  return { cond: 'js', js, timeoutMs, intervalMs };
}

// ---------------------------------------------------------------------------
// 页面内的动作表达式
// ---------------------------------------------------------------------------

/** 定位 + 几何 + 命中测试（`document.elementFromPoint`）的**唯一一次**读数。 */
export function resolveExpr(selector, { scrollIntoView = false } = {}) {
  return `(() => {
  const SEL = ${JSON.stringify(String(selector))};
  const out = {
    found: false, selectorError: null, tag: '', visible: false, inViewport: false, scrolled: false,
    disabled: false, readOnly: false, editable: false, inputish: false,
    box: null, point: null, onScreen: false, hitDesc: '', hitIsTarget: null,
  };
  let el = null;
  try {
    el = document.querySelector(SEL);
  } catch (e) {
    out.selectorError = String(e && e.message ? e.message : e);
    return out;
  }
  if (!el) return out;
  out.found = true;
  const tag = el.tagName ? String(el.tagName).toLowerCase() : '';
  out.tag = tag;
  out.inputish = tag === 'input' || tag === 'textarea';
  out.editable = el.isContentEditable === true;
  out.disabled = el.disabled === true;
  out.readOnly = el.readOnly === true;
  const inView = (r) => r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
  if (${scrollIntoView ? 'true' : 'false'} && !inView(el.getBoundingClientRect())) {
    // 用户点之前会先"看见"它：真实浏览器会把元素滚进视野。不滚就可能点到一个视口外的坐标。
    try {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      out.scrolled = true;
    } catch (e) {}
  }
  const cs = window.getComputedStyle(el);
  const r = el.getBoundingClientRect();
  out.visible =
    cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse' &&
    Number(cs.opacity) !== 0 && (r.width > 0 || r.height > 0);
  out.inViewport = inView(r);
  out.box = [r.left, r.top, r.width, r.height];
  const left = Math.max(r.left, 0);
  const right = Math.min(r.right, window.innerWidth);
  const top = Math.max(r.top, 0);
  const bottom = Math.min(r.bottom, window.innerHeight);
  out.onScreen = right > left && bottom > top;
  if (out.onScreen) {
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    out.point = [x, y];
    try {
      // 浏览器分发鼠标事件时做的就是这件事：这个坐标上**最上面**的那个元素收事件。
      // 被别的元素盖住时这里读到的就是盖子，而真实点击也确实落在它身上。
      const h = document.elementFromPoint(x, y);
      if (h === null) {
        out.hitDesc = '';
        out.hitIsTarget = null;
      } else {
        const cls = typeof h.className === 'string' ? h.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
        out.hitDesc = (h.tagName ? String(h.tagName).toLowerCase() : '?') + (h.id ? '#' + h.id : '') + (cls ? '.' + cls : '');
        out.hitIsTarget = h === el || el.contains(h) === true;
      }
    } catch (e) {
      out.hitDesc = '';
      out.hitIsTarget = null;
    }
  }
  return out;
})()`;
}

/** 聚焦（+可选"选中全部内容"）与焦点回读的唯一来源：**焦点不在目标上就不许发字符**。 */
export function focusExpr(selector, clear) {
  return `(() => {
  const SEL = ${JSON.stringify(String(selector))};
  const CLEAR = ${clear ? 'true' : 'false'};
  const out = { ok: false, reason: null, focused: false, active: '', cleared: false, inputish: false, selectionStart: null, selectionEnd: null };
  let el = null;
  try {
    el = document.querySelector(SEL);
  } catch (e) {
    out.reason = 'selector: ' + String(e && e.message ? e.message : e);
    return out;
  }
  if (!el) {
    out.reason = 'element gone';
    return out;
  }
  out.inputish = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
  try {
    el.focus();
  } catch (e) {
    out.reason = 'focus threw: ' + String(e && e.message ? e.message : e);
    return out;
  }
  const a = document.activeElement;
  out.active = a ? String(a.tagName || '').toLowerCase() + (a.id ? '#' + a.id : '') : '';
  out.focused = a === el || el.contains(a) === true;
  if (CLEAR) {
    // 清空的语义 ＝ "选中现有内容，接下来的插入覆盖它"：与用户 Ctrl+A 之后打字一致。
    // 不走"把 value 置空"是因为那在 contenteditable 上不成立（innerHTML 与撤销栈都不一样）。
    try {
      if (out.inputish && typeof el.select === 'function') {
        el.select();
        out.cleared = true;
      } else if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        out.cleared = true;
      }
    } catch (e) {
      out.cleared = false;
    }
  }
  if (out.inputish && typeof el.selectionStart === 'number') {
    out.selectionStart = el.selectionStart;
    out.selectionEnd = el.selectionEnd;
  }
  out.ok = true;
  return out;
})()`;
}

/**
 * `select` 的**决策**（Node 侧纯函数）：取值是否在这个 `<select>` 的选项里。
 *
 * 为什么判定不放在页面表达式里：那是复核方第四轮挖出的根洞 —— 页面里的布尔量（原来的 `out.inOptions`）
 * 可以被同一段表达式里的任意一行改写（`const o = opts; o[o.length] = {...}` / `opts.push.call(...)` /
 * `Reflect.apply(opts.push, ...)` 全都能让"闸门"形同虚设），而文本扫描只能按**形状**抓，抓不全。
 * 现在页面只**读**原始数据（选项表的 values、当前 `value` / `selectedIndex`），判定在这里算：
 * 普通 JS 单测就能直接打靶 —— 改坏它，断言就红，不再依赖文本扫描。
 */
export function decideSelect({ options, value }) {
  const want = String(value);
  const values = (Array.isArray(options) ? options : []).map((v) => String(v));
  return {
    want,
    count: values.length,
    inOptions: values.includes(want),
    sample: values.slice(0, 5),
  };
}

/**
 * `select` 的**写入自证**（Node 侧纯函数）：写入之后的回读必须显示请求的值真被选中。
 * 判据＝该值在回读的选项表里、`el.value` 等于它、`selectedIndex` 指着它的位置（三样缺一不算落地）。
 * 页面把写入回滚（受控组件）时这里给 `applied:false`，命令按**运行期错（退出码 1）**报 ——
 * 这是"动作没落地"，与"判据说 false"（退出码仍 0）分开。
 */
export function selectApplied({ readback, value }) {
  const want = String(value);
  const values = (Array.isArray(readback?.values) ? readback.values : []).map((v) => String(v));
  const index = values.indexOf(want);
  const gotValue = String(readback?.value == null ? '' : readback.value);
  const gotIndex = typeof readback?.selectedIndex === 'number' ? readback.selectedIndex : null;
  return {
    want,
    expectedIndex: index,
    gotValue,
    gotIndex,
    applied: index >= 0 && gotValue === want && gotIndex === index,
  };
}

/**
 * `select` 的**只读探针**：把决策要用的原始数据读出来。
 * 这里**没有**接受 / 拒绝的布尔量（判定在 `decideSelect`，页面改不到它）；选项表快照只收 `value` 字符串、
 * 不要元素句柄，并 `Object.freeze` —— 页面里再拿到这个数组也没有写入口。
 */
export function selectProbeExpr(selector) {
  return `(() => {
  // adg-select-probe
  const SEL = ${JSON.stringify(String(selector))};
  const out = { exists: false, selectorError: null, tag: '', values: [], value: '', selectedIndex: null };
  let el = null;
  try {
    el = document.querySelector(SEL);
  } catch (e) {
    out.selectorError = String(e && e.message ? e.message : e);
    return out;
  }
  if (!el) return out;
  out.exists = true;
  out.tag = String(el.tagName || '').toLowerCase();
  const values = Array.from(el.options || []).map((o) => String(o.value));
  Object.freeze(values);
  out.values = values;
  out.value = String(el.value == null ? '' : el.value);
  out.selectedIndex = typeof el.selectedIndex === 'number' ? el.selectedIndex : null;
  return out;
})()`;
}

/**
 * `select` 的**写入 + 回读**表达式：赋值、派发 `input` / `change`，然后**当场回读**。
 * 回读那三个读数是自证的另一半（判定在 Node 侧的 `selectApplied`）：写进去了没有、选中位置对不对。
 * 不是用户事件：`isTrusted` 为 false，页面靠这个分辨真假的，本命令不假装自己是用户。
 */
export function selectApplyExpr(selector, value) {
  return `(() => {
  // adg-select-apply
  const SEL = ${JSON.stringify(String(selector))};
  const WANT = ${JSON.stringify(String(value))};
  const out = { exists: false, selectorError: null, dispatched: [], values: [], value: '', selectedIndex: null };
  let el = null;
  try {
    el = document.querySelector(SEL);
  } catch (e) {
    out.selectorError = String(e && e.message ? e.message : e);
    return out;
  }
  if (!el) return out;
  out.exists = true;
  el.value = WANT;
  // 浏览器在用户选中一项时派发的就是这两个（input 先、change 后，都冒泡）。
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  out.dispatched = ['input', 'change'];
  const values = Array.from(el.options || []).map((o) => String(o.value));
  Object.freeze(values);
  out.values = values;
  out.value = String(el.value == null ? '' : el.value);
  out.selectedIndex = typeof el.selectedIndex === 'number' ? el.selectedIndex : null;
  return out;
})()`;
}

/**
 * `type` 的**回读探针**：写入后读目标元素的值 / 文本（只读）。
 */
export function typeReadbackExpr(selector) {
  return `(() => {
  // adg-type-readback
  const SEL = ${JSON.stringify(String(selector))};
  const out = { exists: false, selectorError: null, kind: '', value: '', text: '' };
  let el = null;
  try {
    el = document.querySelector(SEL);
  } catch (e) {
    out.selectorError = String(e && e.message ? e.message : e);
    return out;
  }
  if (!el) return out;
  out.exists = true;
  out.kind = el.isContentEditable ? 'contenteditable' : 'value';
  if (out.kind === 'value') {
    out.value = String(el.value == null ? '' : el.value);
  } else {
    out.text = String(el.textContent == null ? '' : el.textContent);
  }
  return out;
})()`;
}

/**
 * `type` 的**回读判读**（Node 侧纯函数，三态）：插入的文本在不在回读到的内容里。
 * `true`＝读到了、就在里面；`false`＝读到了、但不在（打字没落到目标上 —— 焦点闸门被绕过时就是这个读数）；
 * `unknown`＝读不到（元素没了 / 探针失败 / 没有可读面）。**不改退出码**：页面主动拒绝输入
 * （`beforeinput` 里 preventDefault）是"页面不接受"，不是命令失败，所以这里只出读数；
 * 判据层的三态语义（`true`/`false`/`unknown`）不动。
 */
export function typeReadbackVerdict({ readback, text }) {
  const want = String(text);
  if (!readback || readback.selectorError) {
    return { applied: 'unknown', kind: '', saw: '', reason: String(readback?.selectorError ?? '目标元素回读不到') };
  }
  if (readback.exists !== true) {
    return { applied: 'unknown', kind: '', saw: '', reason: '目标元素在回读时已经不在页面上了' };
  }
  const kind = String(readback.kind ?? '');
  if (kind !== 'value' && kind !== 'contenteditable') {
    return { applied: 'unknown', kind, saw: '', reason: '回读没有说清这个元素的可读面是什么' };
  }
  const saw = String((kind === 'value' ? readback.value : readback.text) ?? '');
  return {
    applied: saw.includes(want) ? 'true' : 'false',
    kind,
    saw,
    reason: saw.includes(want) ? '回读里含刚插入的文本' : '回读里没有刚插入的文本',
  };
}

/** 三个轮询表达式：**只读**，不改页面。 */
export function pollSelectorExpr(selector, requireVisible) {
  return `(() => {
  let el = null;
  try {
    el = document.querySelector(${JSON.stringify(String(selector))});
  } catch (e) {
    return { found: false, visible: false, satisfied: false, error: String(e && e.message ? e.message : e) };
  }
  if (!el) return { found: false, visible: false, satisfied: false };
  const cs = window.getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const visible =
    cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse' &&
    Number(cs.opacity) !== 0 && (r.width > 0 || r.height > 0);
  return { found: true, visible, satisfied: ${requireVisible ? 'visible' : 'true'} };
})()`;
}

export function pollUrlExpr(urlMatch) {
  return `(() => {
  const want = ${JSON.stringify(String(urlMatch))};
  const url = location.href;
  return { url, matched: url.includes(want), satisfied: url.includes(want) };
})()`;
}

/** 用户的 `--js` 包一层：**表达式抛错不算致命**（"变量还没定义"正是要等的状态之一）。 */
export function pollJsExpr(js) {
  return `(() => {
  try {
    const v = (${js});
    return { truth: !!v, type: typeof v, error: null, satisfied: !!v };
  } catch (e) {
    return { truth: null, type: null, error: String(e && e.message ? e.message : e), satisfied: false };
  }
})()`;
}

// ---------------------------------------------------------------------------
// 五条命令的执行体
// ---------------------------------------------------------------------------

function num(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return String(Math.round(n * 10 ** digits) / 10 ** digits);
}

function clipStr(v, n) {
  const s = String(v ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function printTarget(out, selector, r) {
  out(`TARGET=${selector}`);
  out(`TARGET_TAG=${r.tag || '(未命中)'}`);
}

function printBox(out, r) {
  out(`BOX=${r.box ? r.box.map((v) => num(v)).join(',') : '(无)'}`);
  out(`POINT=${r.point ? r.point.map((v) => num(v)).join(',') : '(无)'}`);
}

async function resolveElement(session, selector, { scrollIntoView = false } = {}) {
  return session.evalJs(resolveExpr(selector, { scrollIntoView }));
}

/** 动作前后各取一次状态 → 打 `PROBE_*` / `BEFORE=` / `AFTER=` / `CHANGED=` / `REASON=` / `WARN=`。 */
async function verifyPair(out, action, session, spec, listTabs, dispatch) {
  const before = await captureState(session, { selector: spec.selector ?? null, listTabs });
  out(`PROBE_BEFORE=${before.ok ? 'ok' : 'failed'}`);
  if (!before.ok) out(`PROBE_BEFORE_ERROR=${clipStr(before.error, 200)}`);
  out(`BEFORE=${digestOf(before)}`);
  await dispatch();
  out(`SETTLE_MS=${spec.settleMs}`);
  await sleep(spec.settleMs);
  const after = await captureState(session, { selector: spec.selector ?? null, listTabs });
  out(`PROBE_AFTER=${after.ok ? 'ok' : 'failed'}`);
  if (!after.ok) out(`PROBE_AFTER_ERROR=${clipStr(after.error, 200)}`);
  out(`AFTER=${digestOf(after)}`);
  const cfg = ACTION_CRITERIA[action];
  const cmp = compareStates(before, after, { ignore: cfg.ignore });
  const verdict = changeVerdict(cmp, cfg);
  out(`CHANGED=${verdict.changed}`);
  out(`REASON=${verdict.reason}`);
  const warn = verdictWarn(action, verdict, cmp);
  if (warn) out(`WARN=${warn}`);
  return verdict;
}

/**
 * `click`：选择器定位 → 几何与命中自检 → 前后状态比对。
 * 命中自检（`HIT_IS_TARGET`）是**发事件之前**的门（I16）：真实点击会落在"这个坐标上最上面的元素"身上，
 * 而它可能不是目标（被浮层盖住 / 只有一部分在视口内）。这时默认 **不发事件**（UsageError，退出码 2），
 * 要照原样发必须显式 `--force`（会保留一条 `WARN=`）。三态边界与 desktop 的几何闸门同款：
 * **读不到 `elementFromPoint` 时是 `unknown`，绝不读成"点在目标上"**。
 */
export async function runClick({ session, spec, out, listTabs = null }) {
  const r = await resolveElement(session, spec.selector, { scrollIntoView: true });
  printTarget(out, spec.selector, r);
  if (r.selectorError) {
    throw new UsageError(`click：选择器不合法：${r.selectorError}（--selector ${spec.selector}）`);
  }
  if (!r.found) throw new Error(`click：选择器没有匹配到元素：${spec.selector}`);
  out(`VISIBLE=${r.visible}`);
  out(`IN_VIEWPORT=${r.inViewport}`);
  out(`SCROLLED=${r.scrolled}`);
  printBox(out, r);
  out(`HIT=${r.hitDesc || '(无读数)'}`);
  out(`HIT_IS_TARGET=${r.hitIsTarget === null ? 'unknown' : String(r.hitIsTarget)}`);
  if (!r.visible) {
    throw new Error(
      `click：元素存在但没有可点区域（display:none / visibility:hidden / opacity:0 / 零尺寸）：${spec.selector} —— 真实用户也点不到它`,
    );
  }
  if (!r.onScreen) {
    throw new Error(
      `click：元素不在视口内（滚到视口内之后仍然没有可见部分），点不到：${spec.selector}（box=${r.box ? r.box.map((v) => num(v)).join(',') : '?'}）`,
    );
  }
  if (r.hitIsTarget === false) {
    const msg = `点击坐标上最上面的元素不是目标（命中的是 ${r.hitDesc}）：真实点击会落在它身上，而不是 ${spec.selector}`;
    if (!spec.force) {
      out(`WARN=${msg}；默认**不发事件**（要照原样发加 --force）`);
      throw new UsageError(`${msg}；默认不发事件，加 --force 照原样发`);
    }
    out(`WARN=${msg}；按 --force 照原样发 —— 下面 CHANGED 的读数反映的是**那个**元素收到的点击`);
  } else if (r.hitIsTarget === null) {
    out(
      'WARN=这个坐标上读不到"谁会被点到"（elementFromPoint 没给出结果），HIT_IS_TARGET=unknown —— **缺测不许读成"点在目标上"**；按原样发',
    );
  }
  const x = r.point[0];
  const y = r.point[1];
  const verdict = await verifyPair(out, 'click', session, spec, listTabs, async () => {
    // 真实输入事件：按下 + 松开，坐标用 CSS 像素（CDP 的 Input 域就是这个坐标系）。
    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    out('DISPATCHED=2');
  });
  // 命中面的**回读**（只读，不改退出码）：闸门若被绕过（`HIT_IS_TARGET` 是假读数），这里会把
  // "这个坐标上真正最上面的元素"**再算一遍** —— 与 `HIT=` 不一致就是真话。
  // `click` 没有通用的"写入后回读"：点击的效果是任意的（导航、开菜单、跑副作用），
  // 所以这里只能回读**命中面**这一个可观测量，它证明不了"点击产生了预期效果"（残余，见 design.md）。
  try {
    const after = await session.evalJs(resolveExpr(spec.selector, { scrollIntoView: false }));
    out(`HIT_AFTER=${after?.hitDesc || '(无读数)'}`);
    out(
      `HIT_AFTER_IS_TARGET=${
        after?.hitIsTarget === null || after?.hitIsTarget === undefined ? 'unknown' : String(after.hitIsTarget)
      }`,
    );
  } catch (e) {
    out(`HIT_AFTER=(回读失败)`);
    out('HIT_AFTER_IS_TARGET=unknown');
    out(`HIT_AFTER_NOTE=${clipStr(e?.message ?? String(e), 200)}`);
  }
  return verdict;
}

/**
 * `hover`：选择器定位 → 几何与命中自检 → **真实指针移到元素中心**（`mouseMoved`，显式 `buttons: 0`）→ 前后状态比对。
 * 它打开的是"靠指针进入触发"的下拉 / 菜单（CSS `:hover` 或页面自己的 `mouseenter` 监听）。
 * 闸门与读数面与 `click` **同一套口径**：命中自检先于发事件（I16）、三态边界不放松
 * （读不到就是 `unknown`）、`--settle` 之后才取 `AFTER` 读数。
 * 与 `click` 只有两点差别：①事件形状是一次 `mouseMoved`（显式 `buttons: 0`、不给 `button` 字段），不是按下 + 松开；
 * ②`HIT_AFTER` 回读的是"悬停之后这个坐标上最上面的元素是谁"（浮层弹出后它常常换成浮层里的东西，
 * 那是页面响应了悬停的**旁证**，不是"悬停生效"的证明 —— 证明仍然只在 `CHANGED=` 上）。
 */
export async function runHover({ session, spec, out, listTabs = null }) {
  const r = await resolveElement(session, spec.selector, { scrollIntoView: true });
  printTarget(out, spec.selector, r);
  if (r.selectorError) {
    throw new UsageError(`hover：选择器不合法：${r.selectorError}（--selector ${spec.selector}）`);
  }
  if (!r.found) throw new Error(`hover：选择器没有匹配到元素：${spec.selector}`);
  out(`VISIBLE=${r.visible}`);
  out(`IN_VIEWPORT=${r.inViewport}`);
  out(`SCROLLED=${r.scrolled}`);
  printBox(out, r);
  out(`HIT=${r.hitDesc || '(无读数)'}`);
  out(`HIT_IS_TARGET=${r.hitIsTarget === null ? 'unknown' : String(r.hitIsTarget)}`);
  if (!r.visible) {
    throw new Error(
      `hover：元素存在但没有可悬停的区域（display:none / visibility:hidden / opacity:0 / 零尺寸）：${spec.selector} —— 真实用户的指针也进不到它上面`,
    );
  }
  if (!r.onScreen) {
    throw new Error(
      `hover：元素不在视口内（滚到视口内之后仍然没有可见部分），指针进不去：${spec.selector}（box=${r.box ? r.box.map((v) => num(v)).join(',') : '?'}）`,
    );
  }
  if (r.hitIsTarget === false) {
    const msg = `指针落点上最上面的元素不是目标（命中的是 ${r.hitDesc}）：真实的指针会进到它上面，而不是 ${spec.selector}`;
    if (!spec.force) {
      out(`WARN=${msg}；默认**不发事件**（要照原样发加 --force）`);
      throw new UsageError(`${msg}；默认不发事件，加 --force 照原样发`);
    }
    out(`WARN=${msg}；按 --force 照原样发 —— 下面 CHANGED 的读数反映的是**那个**元素收到的指针进入`);
  } else if (r.hitIsTarget === null) {
    out(
      'WARN=这个坐标上读不到"指针会进到谁身上"（elementFromPoint 没给出结果），HIT_IS_TARGET=unknown —— **缺测不许读成"指针进到了目标上"**；按原样发',
    );
  }
  const x = r.point[0];
  const y = r.point[1];
  const verdict = await verifyPair(out, 'hover', session, spec, listTabs, async () => {
    // 真实输入事件：一次**显式 `buttons: 0`** 的指针位移（不给 `button` 字段 ＝ 没有按下任何键）。
    // 页面按"鼠标进入"处理它（mouseenter / mouseover）；除命中测试外它什么都不做 ——
    // 不点、不聚焦、不选词。这就是"用指针进入以打开下拉"这件事的唯一对应命令。
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      buttons: 0,
    });
    out('DISPATCHED=1');
  });
  // 命中面的**回读**（只读，不改退出码）：与 `click` 同一处埋点，语义一样 —— 它说的是
  // "这个选择器现在指向谁、那个坐标上最上面的是谁"，**证明不了**悬停产生了预期效果。
  try {
    const after = await session.evalJs(resolveExpr(spec.selector, { scrollIntoView: false }));
    out(`HIT_AFTER=${after?.hitDesc || '(无读数)'}`);
    out(
      `HIT_AFTER_IS_TARGET=${
        after?.hitIsTarget === null || after?.hitIsTarget === undefined ? 'unknown' : String(after.hitIsTarget)
      }`,
    );
  } catch (e) {
    out(`HIT_AFTER=(回读失败)`);
    out('HIT_AFTER_IS_TARGET=unknown');
    out(`HIT_AFTER_NOTE=${clipStr(e?.message ?? String(e), 200)}`);
  }
  return verdict;
}

/**
 * `type`：聚焦 → （可选）选中全部内容 → `Input.insertText` 一次插入 → 前后状态比对。
 * **焦点不在目标上就不发字符**（键/文本只会进焦点所在的地方，发出去可能进别的输入框）。
 * `--clear` 的语义 ＝ "先选中现有内容，再插入（插入会覆盖它）"，与用户 Ctrl+A 后打字一致；
 * 输出里的 `CLEARED=` 是"选中动作有没有真的发生"的读数，不是"值一定变空了"。
 */
export async function runType({ session, spec, out, listTabs = null }) {
  const r = await resolveElement(session, spec.selector, { scrollIntoView: false });
  printTarget(out, spec.selector, r);
  if (r.selectorError) {
    throw new UsageError(`type：选择器不合法：${r.selectorError}（--selector ${spec.selector}）`);
  }
  if (!r.found) throw new Error(`type：选择器没有匹配到元素：${spec.selector}`);
  if (!r.inputish && !r.editable) {
    throw new UsageError(
      `type：只能对 input / textarea / contenteditable 输入（目标是 <${r.tag}>）—— 别的元素没有"值 / 文本"这个可观测面，输入进去也看不出来`,
    );
  }
  if (r.disabled) throw new Error(`type：目标被禁用（disabled），真实用户也输不进去：${spec.selector}`);
  if (r.readOnly) throw new Error(`type：目标是只读的（readonly），真实用户也输不进去：${spec.selector}`);
  if (!r.visible) {
    throw new Error(`type：元素存在但没有可输入区域（不可见 / 零尺寸）：${spec.selector}`);
  }
  out(`INPUT_KIND=${r.inputish ? 'value' : 'contenteditable'}`);
  const f = await session.evalJs(focusExpr(spec.selector, spec.clear));
  if (!f || f.ok !== true) {
    out(`FOCUS_ERROR=${clipStr(f?.reason ?? 'unknown', 200)}`);
    throw new Error(`type：聚焦失败（${f?.reason ?? '页面没有返回读数'}）—— **没有输入任何字符**：${spec.selector}`);
  }
  out(`FOCUS_ACTIVE=${f.active || '(无)'}`);
  if (f.focused !== true) {
    throw new Error(
      `type：焦点没有落在目标元素上（现在焦点在 ${f.active || '(未知)'}）—— 输入只会进焦点所在的地方，所以**没有输入任何字符**；目标在 iframe / shadow DOM 里时本命令不支持，先 --selector 定位到宿主元素或改用别的入口`,
    );
  }
  out('FOCUS=target');
  out(`CLEAR=${spec.clear}`);
  if (spec.clear) out(`CLEARED=${f.cleared}`);
  out(`SELECTION=${f.inputish ? `${f.selectionStart}-${f.selectionEnd}` : 'n/a(contenteditable)'}`);
  out(`TEXT_CHARS=${spec.text.length}`);
  out(`TEXT_BYTES=${Buffer.byteLength(spec.text, 'utf8')}`);
  const verdict = await verifyPair(out, 'type', session, spec, listTabs, async () => {
    // 一次插入整段文本：中文 / emoji 不会被拆成半个码位，也不经过输入法状态。
    // 代价是**不触发逐键的 keydown / keyup**（只触发 beforeinput / input）—— 页面若靠 keydown
    // 拦输入（比如只允许数字），这里的判据会显示"没变化"，那是真读数，不是假阴性。
    await session.send('Input.insertText', { text: spec.text });
    out('DISPATCHED=1');
  });
  // 回读自证（读数，不改退出码）：焦点闸门若被绕过，字符会打进**别的**元素 —— 那时判据可能读到差异，
  // 而**目标元素**的回读里根本没有刚插入的文本，`TYPE_APPLIED=false` 就是真话。
  const rb = await readbackType(session, spec.selector, spec.text);
  out(`TYPE_APPLIED=${rb.applied}`);
  if (rb.kind) out(`READBACK_KIND=${rb.kind}`);
  out(`READBACK_VALUE=${clipStr(rb.saw, 80)}`);
  if (rb.applied !== 'true') out(`READBACK_NOTE=${rb.reason}`);
  return verdict;
}

/** `type` 的回读：任何异常都收成 `unknown`，绝不因为它让命令失败（回读只是读数）。 */
async function readbackType(session, selector, text) {
  try {
    const res = await session.evalJs(typeReadbackExpr(selector));
    return typeReadbackVerdict({ readback: res, text });
  } catch (e) {
    return { applied: 'unknown', kind: '', saw: '', reason: `回读失败：${e?.message ?? String(e)}` };
  }
}

/**
 * `select`：**只读探针**取回选项表 → **Node 侧**判定取值在不在里面（不在就一个事件都不发，退出码 2）
 * → 赋值 + 派发 `input` / `change` → **回读自证**（请求的值真被选中才算落地，否则退出码 1）。
 *
 * 两道防线对应两类洞：闸门**不能活在页面里**（页面里一个布尔量可被任意一行改写 —— 判定搬到了
 * `decideSelect`），以及"闸门被绕过之后调用方还能拿到成功读数"（回读不一致一律运行期错 ——
 * 请求的值没被选中时，`SELECT_APPLIED=false` 摆在那里，退出码不是 0）。
 */
export async function runSelect({ session, spec, out, listTabs = null }) {
  const r = await resolveElement(session, spec.selector, { scrollIntoView: false });
  printTarget(out, spec.selector, r);
  if (r.selectorError) {
    throw new UsageError(`select：选择器不合法：${r.selectorError}（--selector ${spec.selector}）`);
  }
  if (!r.found) throw new Error(`select：选择器没有匹配到元素：${spec.selector}`);
  if (r.tag !== 'select') {
    throw new UsageError(
      `select：只能对 <select> 元素赋值（目标是 <${r.tag}>）—— 自定义下拉没有"选项"这个可观测面，请用 click/type 组合`,
    );
  }
  if (r.disabled) throw new Error(`select：目标被禁用（disabled），真实用户也选不了：${spec.selector}`);
  if (!r.visible) {
    throw new Error(`select：元素存在但没有可操作区域（不可见 / 零尺寸）：${spec.selector}`);
  }
  out(`VALUE=${spec.value}`);
  // 闸门（I16）：先读原始数据、再在 Node 侧判 —— 这里失败时**一个事件都不发**。
  const probe = await session.evalJs(selectProbeExpr(spec.selector));
  if (probe?.selectorError) {
    throw new UsageError(`select：选择器不合法：${probe.selectorError}（--selector ${spec.selector}）`);
  }
  if (probe?.exists !== true) {
    throw new Error(`select：选择器没有匹配到元素：${spec.selector}`);
  }
  const decision = decideSelect({ options: probe.values, value: spec.value });
  out(`OPTION_COUNT=${decision.count}`);
  out(`VALUE_IN_OPTIONS=${decision.inOptions}`);
  if (decision.inOptions !== true) {
    out(
      `WARN=这个 <select> 有 ${decision.count} 个选项，可用取值（前 5 个）：${decision.sample.join(' | ') || '(空)'}`,
    );
    throw new UsageError(
      `select：--value "${spec.value}" 不在这个 <select> 的选项里 —— 走 DOM 赋值会得到 value="" 与 selectedIndex=-1，页面看到的是"什么都没选"，所以**不猜**，直接拒绝`,
    );
  }
  const verdict = await verifyPair(out, 'select', session, spec, listTabs, async () => {
    const res = await session.evalJs(selectApplyExpr(spec.selector, spec.value));
    if (res?.selectorError) {
      throw new UsageError(`select：选择器不合法：${res.selectorError}（--selector ${spec.selector}）`);
    }
    if (res?.exists !== true) {
      throw new Error(`select：执行期间这个 <select> 不见了（选择器 ${spec.selector}）`);
    }
    const applied = selectApplied({ readback: res, value: spec.value });
    out(`SELECTED_INDEX=${applied.gotIndex}`);
    out(`DOM_VALUE=${clipStr(applied.gotValue, 80)}`);
    out(`DISPATCHED=${(res.dispatched ?? []).join('+')}`);
    out(`SELECT_APPLIED=${applied.applied}`);
    if (!applied.applied) {
      throw new Error(
        `select：写入之后回读不一致 —— 请求的值 "${spec.value}" 没有被选中（回读 value="${clipStr(applied.gotValue, 80)}"、selectedIndex=${applied.gotIndex}、该值在选项表里的位置=${applied.expectedIndex}）：**动作没有落地**（页面可能把写入回滚了）。这不是"判据说 false"，是本命令的运行期失败（退出码 1）`,
      );
    }
  });
  return verdict;
}

async function pollOnce(session, spec) {
  const evalSafe = async (expr) => {
    try {
      return { ok: true, value: await session.evalJs(expr) };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  };
  if (spec.cond === 'selector') {
    const r = await evalSafe(pollSelectorExpr(spec.selector, spec.requireVisible));
    if (!r.ok) return { satisfied: false, pollError: r.error };
    return {
      satisfied: r.value?.satisfied === true,
      found: r.value?.found === true,
      visible: r.value?.visible === true,
      error: r.value?.error ?? null,
    };
  }
  if (spec.cond === 'url') {
    const r = await evalSafe(pollUrlExpr(spec.urlMatch));
    if (!r.ok) return { satisfied: false, pollError: r.error };
    return { satisfied: r.value?.satisfied === true, url: strOr(r.value?.url), matched: r.value?.matched === true };
  }
  const r = await evalSafe(pollJsExpr(spec.js));
  if (!r.ok) return { satisfied: false, pollError: r.error };
  return {
    satisfied: r.value?.satisfied === true,
    truth: r.value?.truth ?? null,
    jsError: r.value?.error ?? null,
  };
}

function strOr(v) {
  return v === null || v === undefined ? '' : String(v);
}

/**
 * `wait-for`：条件轮询。**超时是"没等到"的确定读数**（`WAIT=timeout` + 退出码 1），
 * 不是静默成功 —— 静默成功正是 desktop 红线 1 那一类坑（"没报错"被当成"做到了"）。
 * 三种条件的读数各自成行（`FOUND=` / `VISIBLE=` / `URL=` / `JS_TRUTH=`），
 * 条件是否成立看 `WAIT=`，`CHANGED=` 只是"等待期间页面有没有变过"的旁证。
 */
export async function runWaitFor({ session, spec, out, listTabs = null }) {
  out(`COND=${spec.cond}`);
  if (spec.cond === 'selector') {
    out(`SELECTOR=${spec.selector}`);
    out(`REQUIRE_VISIBLE=${spec.requireVisible}`);
  } else if (spec.cond === 'url') {
    out(`URL_MATCH=${spec.urlMatch}`);
  } else {
    out(`JS=${clipStr(spec.js, 160)}`);
  }
  out(`TIMEOUT_MS=${spec.timeoutMs}`);
  out(`INTERVAL_MS=${spec.intervalMs}`);
  const probeSpec = { ...spec, selector: spec.cond === 'selector' ? spec.selector : null, settleMs: 0 };
  const before = await captureState(session, {
    selector: probeSpec.selector ?? null,
    listTabs,
  });
  out(`PROBE_BEFORE=${before.ok ? 'ok' : 'failed'}`);
  if (!before.ok) out(`PROBE_BEFORE_ERROR=${clipStr(before.error, 200)}`);
  out(`BEFORE=${digestOf(before)}`);
  const t0 = Date.now();
  let polls = 0;
  let last = null;
  let satisfied = false;
  for (;;) {
    polls += 1;
    last = await pollOnce(session, spec);
    if (last.satisfied) {
      satisfied = true;
      break;
    }
    if (Date.now() - t0 >= spec.timeoutMs) break;
    await sleep(spec.intervalMs);
  }
  const elapsedMs = Date.now() - t0;
  out(`POLLS=${polls}`);
  out(`ELAPSED_MS=${elapsedMs}`);
  if (spec.cond === 'selector') {
    out(`FOUND=${last.found === true}`);
    out(`VISIBLE=${last.visible === true}`);
  } else if (spec.cond === 'url') {
    out(`URL=${last.url ?? ''}`);
    out(`URL_MATCHED=${last.matched === true}`);
  } else {
    out(`JS_TRUTH=${last.truth === null ? 'unknown' : String(last.truth)}`);
    if (last.jsError) out(`JS_ERROR=${clipStr(last.jsError, 200)}`);
  }
  if (last.pollError) out(`POLL_ERROR=${clipStr(last.pollError, 200)}`);
  out(`WAIT=${satisfied ? 'ok' : 'timeout'}`);
  const after = await captureState(session, { selector: probeSpec.selector ?? null, listTabs });
  out(`PROBE_AFTER=${after.ok ? 'ok' : 'failed'}`);
  if (!after.ok) out(`PROBE_AFTER_ERROR=${clipStr(after.error, 200)}`);
  out(`AFTER=${digestOf(after)}`);
  const cfg = ACTION_CRITERIA['wait-for'];
  const cmp = compareStates(before, after, { ignore: cfg.ignore });
  const verdict = changeVerdict(cmp, cfg);
  out(`CHANGED=${verdict.changed}`);
  out(`REASON=${verdict.reason}`);
  const warn = verdictWarn('wait-for', verdict, cmp);
  if (warn) out(`WARN=${warn}`);
  if (!satisfied) {
    const tail =
      spec.cond === 'selector'
        ? `最后读数：FOUND=${last.found === true} VISIBLE=${last.visible === true}`
        : spec.cond === 'url'
          ? `最后读数：URL=${last.url ?? ''}`
          : `最后读数：JS_TRUTH=${last.truth === null ? 'unknown' : String(last.truth)}${last.jsError ? ` JS_ERROR=${clipStr(last.jsError, 120)}` : ''}`;
    throw new Error(
      `wait-for 超时：${spec.timeoutMs}ms 内条件没有满足（轮询 ${polls} 次，用时 ${elapsedMs}ms）—— WAIT=timeout 是"没等到"的确定读数，不是成功。${tail}。要等更久就加 --timeout <ms>`,
    );
  }
  return verdict;
}
// 最小 CDP（Chrome DevTools Protocol）客户端 + 会话便捷层。
//
// 零依赖：只用 Node 的全局 `fetch` 与全局 `WebSocket`（Node >= 22）。
// **刻意不引 playwright-core / puppeteer**：它们会在启动时自带一批注入与旗标
// （`--remote-debugging-pipe`、`Page.addScriptToEvaluateOnNewDocument`、
// `--disable-blink-features=AutomationControlled`），而本模块要的只是
// navigate / evaluate / screenshot 三件事（见 design.md 的「非功能红线」一节）。
//
// `socketFactory` 可注入，所以 `test/browser.test.mjs` 能用一个假 socket
// 把「id 关联、错误映射、事件忽略、关闭后拒绝」这四条协议行为（I9）钉住，全程不碰真浏览器。

import fs from 'node:fs';
import path from 'node:path';

/** Node 22 起才有全局 `WebSocket`；低于此版本必须显式报错，不许静默降级。 */
export const MIN_NODE_MAJOR = 22;

export function assertRuntime() {
  const major = Number(String(process.versions.node).split('.')[0]);
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
    throw new Error(`需要 Node >= ${MIN_NODE_MAJOR}（本机 ${process.versions.node} 没有全局 WebSocket）`);
  }
  if (typeof fetch !== 'function') throw new Error('需要全局 fetch（Node >= 18）');
  if (typeof WebSocket !== 'function') throw new Error(`需要全局 WebSocket（Node >= ${MIN_NODE_MAJOR}）`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 取一个 CDP 的 HTTP 端点并解析成 JSON。用于 `/json/version` 与 `/json/list`。 */
export async function httpJson(url, opts = {}) {
  assertRuntime();
  const { timeoutMs = 6000 } = opts;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function version(port, opts = {}) {
  return httpJson(`http://127.0.0.1:${port}/json/version`, opts);
}

export function listTargets(port, opts = {}) {
  return httpJson(`http://127.0.0.1:${port}/json/list`, opts);
}

/** 端口上有没有活着的浏览器。**不** spawn 任何东西，纯 HTTP 探测。 */
export async function isAlive(port, opts = {}) {
  try {
    await version(port, opts);
    return true;
  } catch {
    return false;
  }
}

/** 从 `/json/list` 的原始结果里筛出可驱动的页面目标（design.md I7：选页必须命中，不猜）。 */
export function pickPage(targets, opts = {}) {
  const { id, match, index = 0 } = opts;
  const pages = (Array.isArray(targets) ? targets : []).filter(
    (t) =>
      t &&
      t.type === 'page' &&
      typeof t.webSocketDebuggerUrl === 'string' &&
      t.webSocketDebuggerUrl !== '' &&
      !String(t.url ?? '').startsWith('devtools://'),
  );
  if (id) {
    // 刚创建的标签：targetId 跨导航稳定，用 id 定位比用 url 可靠（站内会跳转）。
    const hit = pages.find((t) => t.id === id);
    if (!hit) return { page: null, reason: `刚创建的标签 ${id} 没有出现在 /json/list 里`, pages };
    return { page: hit, pages };
  }
  if (match) {
    const hit = pages.find(
      (t) => String(t.url ?? '').includes(match) || String(t.title ?? '').includes(match),
    );
    if (!hit) return { page: null, reason: `没有 url / title 匹配 "${match}" 的页面`, pages };
    return { page: hit, pages };
  }
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0) return { page: null, reason: `--tab 必须是 >= 0 的整数（收到 ${String(index)}）`, pages };
  if (pages.length === 0) return { page: null, reason: '没有可用页面目标（先用 launch 开浏览器）', pages };
  if (n >= pages.length) return { page: null, reason: `--tab ${n} 越界（当前 ${pages.length} 个页面）`, pages };
  return { page: pages[n], pages };
}

/**
 * 从 `/json/list` 里筛出「要关掉哪些标签页」（design.md I8）。
 * 只负责选，**不做任何猜测**：没给选择器、没命中、越界、缺值、会关到 0 个页面，一律返回 `reason`。
 * `--match` 关掉**所有**匹配的页（这是清理存量标签页的主力）；`--tab` 只关那一个。
 */
export function pickTabsToClose(targets, opts = {}) {
  const pages = pickPage(targets, {}).pages;
  const guard = (selected) => {
    if (selected.length === 0) return { targets: [], reason: '没有选中任何标签页' };
    if (selected.length >= pages.length) {
      return {
        targets: [],
        reason: '关掉它（们）会剩 0 个页面，那等于关浏览器；要关浏览器请用 node cli.mjs close',
      };
    }
    return { targets: selected, reason: null };
  };

  const { match, tab } = opts;
  if (match === true || match === '') return { targets: [], reason: '--match 后面缺少子串' };
  if (match !== undefined) {
    const hit = pages.filter(
      (t) => String(t.url ?? '').includes(match) || String(t.title ?? '').includes(match),
    );
    if (hit.length === 0) return { targets: [], reason: `没有 url / title 匹配 "${match}" 的页面` };
    return guard(hit);
  }

  if (tab === true) return { targets: [], reason: '--tab 后面缺少序号' };
  if (tab !== undefined) {
    const n = Number(tab);
    if (!Number.isInteger(n) || n < 0) return { targets: [], reason: `--tab 必须是 >= 0 的整数（收到 ${String(tab)}）` };
    if (n >= pages.length) return { targets: [], reason: `--tab ${n} 越界（当前 ${pages.length} 个页面）` };
    return guard([pages[n]]);
  }

  return { targets: [], reason: 'close-tab 需要 --match <子串> 或 --tab <n>（不猜要关哪个）' };
}

/**
 * 建一条 CDP 连接。`socketFactory` 默认是真 WebSocket，测试时注入假 socket。
 * 返回对象只有 `send` / `close`：id 关联、错误映射、事件丢弃都在这里完成。
 */
export async function connect(wsUrl, opts = {}) {
  const factory = opts.socketFactory ?? ((url) => new WebSocket(url));
  const socket = factory(wsUrl);
  const pending = new Map();
  let nextId = 1;
  let closed = false;

  const api = {
    send(method, params = {}) {
      if (closed) return Promise.reject(new Error('CDP 连接已关闭'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const p of pending.values()) p.reject(new Error('CDP 连接已关闭'));
      pending.clear();
      try {
        socket.close();
      } catch {
        // 关闭失败不影响调用方：连接对象已经不可用了。
      }
    },
  };

  socket.addEventListener('message', (ev) => {
    const raw = typeof ev?.data === 'string' ? ev.data : null;
    if (raw === null) return; // 非文本帧：本模块不消费
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // 解析不了的载荷：丢弃，不要炸掉整条连接
    }
    if (msg.id === undefined) return; // 事件通知（如 executionContextCreated）：不消费
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
    else p.resolve(msg.result);
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', (e) => reject(new Error(`连不上 CDP（${wsUrl}）：${e?.message ?? 'error'}`)));
  });

  return api;
}

/** 在页面上下文里求值。`awaitPromise` 让 `fetch(...)` 这类返回值也能直接拿到。 */
export async function evalJs(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res && res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(`页面内抛错：${d.exception?.description ?? d.text ?? 'unknown'}`);
  }
  return res?.result?.value;
}

/** 读一页的标题 / 地址 / 可见文本。抽到常量里，便于测试与文档引用同一份表达式。 */
export const READ_PAGE_EXPR =
  '(() => ({ title: document.title, url: location.href, body: document.body ? document.body.innerText : "" }))()';

export async function readPage(cdp) {
  const v = await evalJs(cdp, READ_PAGE_EXPR);
  return v ?? { title: '', url: '', body: '' };
}

async function waitForLoad(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await evalJs(cdp, 'document.readyState');
      if (last === 'complete' || last === 'interactive') return { readyState: last, timeout: false };
    } catch {
      // 导航会把上一个执行上下文销毁，这里重试即可。
    }
    await sleep(400);
  }
  return { readyState: last, timeout: true };
}

export async function goto(cdp, url, timeoutMs = 30000) {
  await cdp.send('Page.navigate', { url });
  return waitForLoad(cdp, timeoutMs);
}

export async function screenshot(cdp, file, opts = {}) {
  const params = { format: 'png' };
  if (opts.full) params.captureBeyondViewport = true;
  const res = await cdp.send('Page.captureScreenshot', params);
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from(res.data, 'base64'));
  return abs;
}

/** 浏览器级端点的 ws 地址（页面级端点只能驱动它自己那一页）。 */
export async function browserWsUrl(port, opts = {}) {
  const v = await version(port, opts);
  if (!v?.webSocketDebuggerUrl) throw new Error(`端口 ${port} 上没有可用的浏览器级 CDP 端点`);
  return v.webSocketDebuggerUrl;
}

export async function createTarget(port, url, opts = {}) {
  const cdp = await connect(await browserWsUrl(port, opts), { socketFactory: opts.socketFactory });
  try {
    const res = await cdp.send('Target.createTarget', { url });
    return res.targetId;
  } finally {
    cdp.close();
  }
}

/** 优雅关闭浏览器 —— 这是让登录态落盘的唯一可靠动作，也是关浏览器的唯一入口（design.md I6）。 */
export async function closeBrowser(port, opts = {}) {
  const cdp = await connect(await browserWsUrl(port, opts), { socketFactory: opts.socketFactory });
  try {
    await cdp.send('Browser.close', {});
  } finally {
    cdp.close();
  }
}

/**
 * 关掉一个标签页目标（design.md I8）。必须在**浏览器级**端点上发 ——
 * 页面级端点只能驱动它自己那一页，关不掉别人，也关不掉自己所在的那个 target。
 */
export async function closeTarget(port, targetId, opts = {}) {
  const cdp = await connect(await browserWsUrl(port, opts), { socketFactory: opts.socketFactory });
  try {
    await cdp.send('Target.closeTarget', { targetId });
  } finally {
    cdp.close();
  }
}

/**
 * 一次页面会话：连上既有页面（或先开一个新标签），返回一组便捷方法。
 * 调用方负责 `close()` —— 它只断开 CDP，**不关浏览器**。
 *
 * `newUrl` 的实现刻意分两步：**先开空白标签、attach 之后再 `Page.navigate` 并等可读状态**。
 * 反过来（按目标 URL 建页，再固定等一段时间就读）是**抢跑**：慢半拍的页面会被读到 0 字节，
 * 而空结果又会被当成"这一页没内容"，白烧一整轮。等不到可读状态就**报错**
 * （而不是返回空正文）：空正文与"页面没加载完"在调用方看来一模一样，必须区分（design.md I10 ①）。
 */
export async function pageSession(port, opts = {}) {
  assertRuntime();
  const { match, index, newUrl, timeoutMs = 30000, socketFactory } = opts;
  let picked;
  // `created` 记录「这一页是不是本命令自己开的」—— 只有自己开的临时标签才允许自动收走（I10）。
  let created = false;
  if (newUrl) {
    const targetId = await createTarget(port, 'about:blank', { socketFactory });
    // 新目标不一定立刻出现在 /json/list 里：轮询等它（最多 ~2s），不要用固定 sleep 赌。
    for (let i = 0; i < 10 && !picked?.page; i++) {
      await sleep(200);
      picked = pickPage(await listTargets(port), { id: targetId });
    }
    created = true;
  } else {
    picked = pickPage(await listTargets(port), { match, index });
  }
  if (!picked.page) throw new Error(picked.reason);
  let cdp;
  try {
    cdp = await connect(picked.page.webSocketDebuggerUrl, { socketFactory });
    await cdp.send('Runtime.enable', {});
    await cdp.send('Page.enable', {});
    if (newUrl) {
      const state = await goto(cdp, newUrl, timeoutMs);
      if (state.timeout) {
        throw new Error(
          `页面在 ${timeoutMs}ms 内没有进入可读状态（readyState=${state.readyState ?? '未知'}）：${newUrl}`,
        );
      }
    }
  } catch (e) {
    // 失败也不把自己开的临时页留给用户（I10 的"谁开的谁收"包含失败路径）；别人开的页一律不碰。
    try {
      cdp?.close();
    } catch {
      // 连接本来就没建起来是正常情形。
    }
    if (created) await closeTarget(port, picked.page.id, { socketFactory }).catch(() => {});
    throw e;
  }
  return {
    cdp,
    target: picked.page,
    tabs: picked.pages,
    created,
    goto: (url) => goto(cdp, url, timeoutMs),
    text: () => readPage(cdp),
    evalJs: (expr) => evalJs(cdp, expr),
    // 动作命令要发真实输入事件（`Input.dispatchMouseEvent` / `Input.insertText`）。这里只是直通：
    // 发什么、什么时候发由动作层（lib/actions.mjs）决定，而**"发出去了"从来不是成功证据**（I14）。
    send: (method, params) => cdp.send(method, params),
    shot: (file, o) => screenshot(cdp, file, o),
    close: () => cdp.close(),
  };
}
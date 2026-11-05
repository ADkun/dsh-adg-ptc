// turn-bookmarks 宿主半边的接线自测：同源栅栏、路径解析、四类方法、落盘位置。
//
// 纪律：零依赖、零副作用 —— 所有会话目录都在 mkdtemp 出来的临时根里，跑完即删。
// 跑法：cd turn-bookmarks && node --test test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { STORE_FILE } from '../lib/bookmarks.mjs';
import { ROUTE_PATH, apply, name as pluginName } from '../index.mjs';

/** 一个临时会话根：<root>/<slug>/<sessionDirName>/（模拟 dsh 的真实两层结构）。 */
function makeRoot(sessionDirName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adg-turn-bookmarks-'));
  const dir = path.join(root, 'D-slug', sessionDirName);
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}

/** 假 ctx：真跑 inject 回调，把注册出来的路由留住；sessionPersistence 给一个真 root。 */
function harness(root) {
  const routes = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    get: (service) => (service === 'sessionPersistence' ? { root } : undefined),
    inject: (_names, run) =>
      run({
        logger: ctx.logger,
        get: ctx.get,
        effect: (body) => body(),
        webServer: { register: (route) => routes.push(route) },
      }),
  };
  apply(ctx);
  assert.equal(routes.length, 1, 'apply 应该注册恰好一条路由');
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, ROUTE_PATH);
  return routes[0];
}

/** 假 req/res：把一次请求走完路由，返回 {status, headers, json, req}。 */
function request(route, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const chunks =
      body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8')];
    const req = {
      url: ROUTE_PATH + urlPath,
      method,
      headers: { host: '127.0.0.1:3080', ...(headers === undefined ? {} : headers) },
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
      on(event, handler) {
        if (event === 'data') for (const chunk of chunks) handler(chunk);
        if (event === 'end') handler();
        return this;
      },
    };
    const res = {
      status: 0,
      headers: null,
      writeHead(status, headers_) {
        this.status = status;
        this.headers = headers_;
      },
      end(text) {
        try {
          resolve({ status: this.status, headers: this.headers, json: JSON.parse(text), req });
        } catch (error) {
          reject(error);
        }
      },
    };
    route.handler(req, res).catch(reject);
  });
}

test('插件名与路由前缀是契约（等于 cordis.patch.yml 的 id）', () => {
  assert.equal(pluginName, 'adg-turn-bookmarks');
  assert.equal(ROUTE_PATH, '/api/adg-turn-bookmarks');
});

test('GET：会话目录不存在也给空列表（新会话不该 404）', async () => {
  const { root } = makeRoot('session-abc');
  const route = harness(root);
  const { status, json } = await request(route, 'GET', '/session-abc');
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, sessionId: 'session-abc', turns: [] });
  fs.rmSync(root, { recursive: true, force: true });
});

test('PUT 落盘到该会话目录的 sidecar，读回一致且经过归一', async () => {
  const { root, dir } = makeRoot('session-abc');
  const route = harness(root);
  const put = await request(route, 'PUT', '/session-abc', { turns: [3, 1, 3, -1, '9'] });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.turns, [1, 3]);
  const file = path.join(dir, STORE_FILE);
  assert.equal(fs.existsSync(file), true, 'sidecar 必须落在会话自己的目录里');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, turns: [1, 3] });
  const got = await request(route, 'GET', '/session-abc');
  assert.deepEqual(got.json.turns, [1, 3]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('PUT：会话目录不在 -> 409（不许凭空造目录）', async () => {
  const { root } = makeRoot('session-abc');
  const route = harness(root);
  const { status, json } = await request(route, 'PUT', '/session-nope', { turns: [1] });
  assert.equal(status, 409);
  assert.equal(json.error, 'session directory not found');
  fs.rmSync(root, { recursive: true, force: true });
});

test('PUT：请求体不是 { turns: number[] } -> 400', async () => {
  const { root } = makeRoot('session-abc');
  const route = harness(root);
  assert.equal((await request(route, 'PUT', '/session-abc', { turns: 'x' })).status, 400);
  assert.equal((await request(route, 'PUT', '/session-abc', { other: [] })).status, 400);
  assert.equal((await request(route, 'PUT', '/session-abc', Buffer.from('{ not json', 'utf8'))).status, 400);
  fs.rmSync(root, { recursive: true, force: true });
});

test('PUT：超过上限是 400，不静默截断', async () => {
  const { root, dir } = makeRoot('session-abc');
  const route = harness(root);
  const tooMany = Array.from({ length: 1001 }, (_, index) => index);
  const { status } = await request(route, 'PUT', '/session-abc', { turns: tooMany });
  assert.equal(status, 400);
  assert.equal(fs.existsSync(path.join(dir, STORE_FILE)), false, '被拒的请求不许写盘');
  fs.rmSync(root, { recursive: true, force: true });
});

test('DELETE 清空 sidecar；再 GET 回空列表', async () => {
  const { root, dir } = makeRoot('session-abc');
  const route = harness(root);
  await request(route, 'PUT', '/session-abc', { turns: [2] });
  const file = path.join(dir, STORE_FILE);
  assert.equal(fs.existsSync(file), true);
  const gone = await request(route, 'DELETE', '/session-abc');
  assert.equal(gone.status, 200);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual((await request(route, 'GET', '/session-abc')).json.turns, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('方法与路径栅栏：POST 405、缺 session id 404、坏 id 400', async () => {
  const { root } = makeRoot('session-abc');
  const route = harness(root);
  assert.equal((await request(route, 'POST', '/session-abc', {})).status, 405);
  assert.equal((await request(route, 'GET', '')).status, 404);
  // 路径穿越被 URL 归一化直接吃掉，落成「缺 session id」，比 400 更早；编码过的斜杠才轮到 id 校验。
  assert.equal((await request(route, 'GET', '/..')).status, 404);
  assert.equal((await request(route, 'GET', '/a%2Fb')).status, 400);
  fs.rmSync(root, { recursive: true, force: true });
});

test('同源栅栏：跨站来源 403，回环同源放行', async () => {
  const { root } = makeRoot('session-abc');
  const route = harness(root);
  const crossSite = await request(route, 'GET', '/session-abc', undefined, { 'sec-fetch-site': 'cross-site' });
  assert.equal(crossSite.status, 403);
  const foreignHost = await request(route, 'GET', '/session-abc', undefined, { host: 'evil.example' });
  assert.equal(foreignHost.status, 403);
  const sameOrigin = await request(route, 'GET', '/session-abc', undefined, { origin: 'http://127.0.0.1:3080' });
  assert.equal(sameOrigin.status, 200);
  fs.rmSync(root, { recursive: true, force: true });
});

test('connection 服务在场时以它的判定为准', async () => {
  const { root } = makeRoot('session-abc');
  const routes = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    get: (service) => {
      if (service === 'sessionPersistence') return { root };
      if (service === 'connection') {
        return { admit: (req) => (req.headers.host === '127.0.0.1:3080' ? undefined : { rejection: 401 }) };
      }
      return undefined;
    },
    inject: (_names, run) =>
      run({
        logger: ctx.logger,
        get: ctx.get,
        effect: (body) => body(),
        webServer: { register: (route) => routes.push(route) },
      }),
  };
  apply(ctx);
  const denied = await request(routes[0], 'GET', '/session-abc', undefined, { host: 'elsewhere.local' });
  assert.equal(denied.status, 401);
  assert.equal((await request(routes[0], 'GET', '/session-abc')).status, 200);
  fs.rmSync(root, { recursive: true, force: true });
});

test('跨半边漂移：client.js 的 id / 路由 / 文案键与宿主一致', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const q = String.fromCharCode(39);
  const idMark = 'id: ' + q + 'adg-turn-bookmarks' + q;
  assert.equal(source.includes(idMark), true, 'client.js 的 factory id 用包名');
  assert.equal(source.includes(ROUTE_PATH), true, 'client.js 必须用同一个路由前缀');
  for (const key of ['add:', 'remove:']) {
    const count = source.split(key).length - 1;
    assert.equal(count >= 2, true, '文案键 ' + key + ' 需要 zh 与 en 各一份，实际 ' + count);
  }
});

test('轨道右键是收藏入口，且绝不接管左键跳转', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const clickListen = "addEventListener('" + 'click' + "'";
  assert.equal(source.includes("addEventListener('contextmenu'"), true, '轨道右键要挂 contextmenu 监听');
  assert.equal(source.includes("removeEventListener('contextmenu'"), true, '卸载要把 contextmenu 监听摘掉');
  assert.equal(source.includes('preventDefault'), true, '右键必须先 preventDefault，别弹浏览器菜单');
  assert.equal(source.includes(clickListen), false, '左键跳转必须保持 dsh 原生行为：本插件不挂 click 监听');
});

test('星标进操作栏行（且仅在有操作栏时），交付卡不受挤占', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.equal(
    source.includes('[data-turn-tail]{position:relative!important;flex-direction:column!important;align-items:stretch!important;gap:16px!important}'),
    true,
    'turnTail 根节点必须保持 column（只补 position:relative 当定位参照），绝不能整根改 row',
  );
  assert.equal(
    source.includes('[data-turn-tail]:has(>[data-clock]) .atb_star{position:absolute!important;inset-inline-start:0!important;bottom:0!important}'),
    true,
    '星标必须门控在 has(>[data-clock]) 里才绝对定位；无操作栏的轮次（closing === null）不能被绝对定位浮起',
  );
  assert.equal(
    source.includes('[data-turn-tail]:has(.atb_star):has(>[data-clock])>*:last-child{margin-inline-start:36px!important}'),
    true,
    '只有操作栏存在时，才把最后子项（原生操作栏）按行内起点右移 36px；无操作栏时不许右移卡片',
  );
  assert.equal(
    source.includes('width:calc(28px + var(--dsh-content-font-delta,0px))'),
    true,
    '星标尺寸必须跟随 --dsh-content-font-delta，否则字号放大后比原生按钮小且竖直不居中',
  );
  assert.equal(
    source.includes('width:28px;height:28px'),
    false,
    '别再写死 28px：dsh 原生按钮是 calc(28px + delta)',
  );
  assert.equal(
    /\bflex-direction\s*:\s*row\b/.test(source),
    false,
    'turnTail 里出现 row（含带空格写法）就会把交付卡挤到同一行——回归根因，必须守住',
  );
  assert.equal(
    /\bflex-flow\s*:\s*[^;}]*\brow\b/.test(source),
    false,
    'flex-flow:row 是 row 的变体，同样会把卡片挤成一行',
  );
});

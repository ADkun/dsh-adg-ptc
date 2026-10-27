// settings 模块的自测：登记表的不变量、三层优先级、同源路由的读写/拒绝、以及一条
// **跨模块漂移检查**（设置页登记的键 vs adg-notify 真正读的键）。
//
// 纪律（与 notify/permission/delegate 的测试同一套）：零依赖、零副作用 —— 不弹通知、
// 不起进程、不碰真机 profile。所有落盘都发生在 mkdtemp 出来的临时目录里，靠
// DSH_PROFILE_DIR 指过去，每个用例结束时恢复环境变量。
//
// 跑法：cd settings && node --test test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULTS,
  FIELDS,
  KINDS,
  buildEffective,
  describeFields,
  fieldFor,
  normalizeSettings,
  refuseMessage,
  validValue,
} from '../lib/schema.mjs';
import { STORE_NAME, apply, name as pluginName, settingsFile } from '../index.js';
import {
  MAX_TITLE_LENGTH,
  STORE_NAME as NOTIFY_STORE_NAME,
  USER_DEFAULTS,
  readUserDefaults,
  resolveRequest,
} from '../../notify/lib/user-settings.mjs';
import {
  MAX_TEXT_LENGTH,
  STORE_NAME as INJECT_STORE_NAME,
  USER_DEFAULTS as INJECT_DEFAULTS,
  readUserDefaults as readInjectDefaults,
} from '../../skill-inject/lib/user-settings.mjs';

/** 客户端 half 写死在 client.js 里的那两条常量（这里钉住契约）。 */
const ROUTE_PREFIX = '/api/adg-settings';
const ROUTE = `${ROUTE_PREFIX}/settings`;

/** 全 `default` 的 origin（新增登记项时不必逐条改断言）。 */
function allDefaults() {
  return Object.fromEntries(FIELDS.map((field) => [field.key, 'default']));
}

/** 一个字段的界：字符串给 `maxLength`，整数给 `[min, max]`，布尔什么都没有。 */
function boundsOf(field) {
  if (field.kind === 'string') return { maxLength: field.maxLength };
  if (field.kind === 'integer') return { min: field.min, max: field.max };
  return {};
}

/** 跑一段代码（可以返回 promise），期间把两个环境变量换成临时目录，**settle 之后**才清掉。 */
async function withTempDir(run) {
  const saved = {
    profile: process.env.DSH_PROFILE_DIR,
    home: process.env.DSH_HOME,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adg-settings-'));
  process.env.DSH_PROFILE_DIR = dir;
  delete process.env.DSH_HOME;
  try {
    return await run(dir);
  } finally {
    if (saved.profile === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = saved.profile;
    if (saved.home === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved.home;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 一个假 ctx：真跑 `ctx.inject` 的注册回调，把注册出来的路由记下来。 */
function harness(config) {
  const routes = [];
  const logged = { warn: [], info: [] };
  const ctx = {
    logger: {
      warn: (message) => logged.warn.push(String(message)),
      info: (message) => logged.info.push(String(message)),
      debug: () => {},
    },
    get: () => undefined,
    inject: (names, run) => {
      const scoped = {
        logger: ctx.logger,
        get: ctx.get,
        effect: (body) => {
          body();
        },
        webServer: {
          register: (route) => {
            routes.push(route);
            return () => {};
          },
        },
      };
      run(scoped);
    },
  };
  apply(ctx, config);
  assert.equal(routes.length, 1, 'apply 应该注册恰好一条路由');
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, ROUTE_PREFIX);
  return { route: routes[0], logged };
}

/** 一个假 req/res：把一次请求走完路由，返回 {status, headers, json}。 */
function request(route, method, body, headers = {}, path_ = '/settings') {
  return new Promise((resolve, reject) => {
    const chunks =
      body === undefined
        ? []
        : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8')];
    const req = {
      url: `${ROUTE_PREFIX}${path_}`,
      method,
      headers: { host: '127.0.0.1:3080', ...headers },
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

// ── 框架不变量 ────────────────────────────────────────────────────────────────

test('I1: 登记表自洽 —— 键唯一、kind 合法、必备字段齐全、界与 kind 配套', () => {
  assert.deepEqual(KINDS, ['boolean', 'string', 'integer', 'enum']);
  const keys = FIELDS.map((field) => field.key);
  assert.equal(new Set(keys).size, keys.length, '键不能重名');
  // 键集合就是那七项（通知三项 + 注入四项），顺序即页面顺序。
  assert.deepEqual(keys, [
    'notifyTitle',
    'notifySound',
    'notifyPersist',
    'skillInjectEnabled',
    'skillInjectFramework',
    'skillInjectSubagent',
    'skillInjectText',
  ]);
  for (const field of FIELDS) {
    assert.ok(KINDS.includes(field.kind), `${field.key}: kind 必须是 ${KINDS.join('/')}`);
    assert.equal(typeof field.group, 'string');
    assert.equal(typeof field.consumer, 'string', `${field.key}: 要写清谁读它`);
    assert.equal(field.labelKey, `field.${field.key}.label`);
    assert.equal(field.hintKey, `field.${field.key}.hint`);
    assert.equal('default' in field, true);
    if (field.kind === 'string') {
      assert.ok(Number.isInteger(field.maxLength) && field.maxLength > 0, `${field.key}: 要给出 maxLength`);
    }
    if (field.kind === 'integer') {
      assert.ok(Number.isInteger(field.min) && Number.isInteger(field.max));
      assert.ok(field.min <= field.max);
    }
    if (field.kind === 'enum') {
      // 界的真相在登记表里（R4）：客户端拿 allowValues 画下拉，宿主拿它判合法。
      assert.ok(Object.isFrozen(field.allowValues), `${field.key}: allowValues 要是冻结数组`);
      assert.ok(Array.isArray(field.allowValues) && field.allowValues.length >= 2, `${field.key}: 至少要两个选项`);
      for (const value of field.allowValues) {
        assert.equal(typeof value, 'string', `${field.key}: 选项值要是字符串`);
        assert.equal(value.trim(), value, `${field.key}: 选项值不该带首尾空白`);
      }
      assert.equal(new Set(field.allowValues).size, field.allowValues.length, `${field.key}: 选项不能重复`);
      assert.ok(field.allowValues.includes(field.default), `${field.key}: default 要在 allowValues 里`);
    }
  }
});

test('I2: 每一条 default 都能通过自己的 validValue（页面一开不能就是红的）', () => {
  for (const field of FIELDS) {
    assert.deepEqual(validValue(field, field.default), field.default, `${field.key} 的 default 不合法`);
  }
  assert.deepEqual(DEFAULTS, Object.fromEntries(FIELDS.map((field) => [field.key, field.default])));
});

test('I3: describeFields() 只有数据（客户端拿到的是 JSON 化的登记表）', () => {
  const fields = describeFields();
  assert.deepEqual(JSON.parse(JSON.stringify(fields)), fields);
  assert.equal(fields.length, FIELDS.length);
  assert.deepEqual(fields[0], { ...FIELDS[0] });
});

// ── 校验面 ────────────────────────────────────────────────────────────────────

test('validValue: 布尔收 true/false 与它们的字符串写法，别的都拒', () => {
  const field = fieldFor('notifySound');
  assert.equal(validValue(field, true), true);
  assert.equal(validValue(field, false), false);
  assert.equal(validValue(field, 'true'), true);
  assert.equal(validValue(field, 'false'), false);
  for (const bad of ['yes', 1, 0, null, undefined, {}, []]) {
    assert.equal(validValue(field, bad), undefined, `${JSON.stringify(bad)} 不该被接受`);
  }
});

test('validValue: 字符串收非空白且在长度内，原样返回', () => {
  const field = fieldFor('notifyTitle');
  assert.equal(validValue(field, '浏览器操作需要你登录'), '浏览器操作需要你登录');
  assert.equal(validValue(field, ' DS H '), ' DS H ', '不做 trim：原样落盘');
  assert.equal(validValue(field, 'x'.repeat(field.maxLength)).length, field.maxLength);
  for (const bad of ['', '   ', 'x'.repeat(field.maxLength + 1), 7, null, undefined, ['x']]) {
    assert.equal(validValue(field, bad), undefined, `${JSON.stringify(bad)} 不该被接受`);
  }
});

test('validValue: 整数只收整数字面量（空串/小数/空白串都不算）', () => {
  const field = { key: 'notifyDelay', kind: 'integer', min: 0, max: 600000 };
  assert.equal(validValue(field, 0), 0);
  assert.equal(validValue(field, 8000), 8000);
  assert.equal(validValue(field, '8000'), 8000, '手改的 JSON 里可能是字符串');
  assert.equal(validValue(field, 600000), 600000);
  for (const bad of ['', ' 8000 ', '8000.0', 1.5, -1, 600001, null, undefined, true, 'abc']) {
    assert.equal(validValue(field, bad), undefined, `${JSON.stringify(bad)} 不该被接受`);
  }
});

test('validValue: enum 只收与 allowValues 成员严格相等的字符串（不折叠大小写、不 trim）', () => {
  const field = fieldFor('skillInjectFramework');
  assert.deepEqual([...field.allowValues], ['thinking', 'execution']);
  for (const good of field.allowValues) {
    assert.equal(validValue(field, good), good, `${good} 是合法值`);
  }
  const bad = [
    'Thinking', 'THINKING', 'Execution', 'EXECUTION',
    ' thinking', 'thinking ', '\tthinking', 'thinking\n',
    '', '   ', 'thinking-framework', 'execution-framework', 'skill', 'true', 'false',
    0, 1, true, false, null, undefined, {}, [], ['thinking'],
  ];
  for (const value of bad) {
    assert.equal(validValue(field, value), undefined, `${JSON.stringify(value)} 不该被接受`);
  }
});

test('refuseMessage: 四种 kind 各一句可读的拒绝理由，且都点名是哪个键', () => {
  const text = { key: 'notifyTitle', kind: 'string', maxLength: 80 };
  const flag = { key: 'notifySound', kind: 'boolean' };
  const count = { key: 'notifyDelay', kind: 'integer', min: 0, max: 600000 };
  const choice = fieldFor('skillInjectFramework');
  assert.match(refuseMessage(text), /^notifyTitle must be a non-empty string of at most 80 characters$/);
  assert.match(refuseMessage(flag), /^notifySound must be true or false$/);
  assert.match(refuseMessage(count), /^notifyDelay must be an integer between 0 and 600000$/);
  assert.equal(refuseMessage(choice), 'skillInjectFramework must be one of: thinking, execution');
});

test('normalizeSettings: 认不得的键记在 unknown，非法值记在 dropped 并逐条警告', () => {
  const warned = [];
  const logger = { warn: (message) => warned.push(String(message)) };
  const { settings, unknown, dropped } = normalizeSettings(
    {
      notifyTitle: '自定义标题',
      notifySound: 'false',
      notifyPersist: 'nope',
      legacyFlag: 1,
      notifyDelay: 5,
    },
    logger,
    'the settings file (/tmp/x.json)',
  );
  assert.deepEqual(settings, { notifyTitle: '自定义标题', notifySound: false });
  assert.deepEqual(unknown, ['legacyFlag', 'notifyDelay']);
  assert.deepEqual(dropped, ['notifyPersist']);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /^adg-settings: dropping notifyPersist="nope" in the settings file \(\/tmp\/x\.json\)/);
  assert.match(warned[0], /\(notifyPersist must be true or false\)$/);
});

test('normalizeSettings: 不是对象的输入是「空的设置」而不是崩溃', () => {
  for (const bad of [null, undefined, 42, 'x', ['a']]) {
    const result = normalizeSettings(bad);
    assert.deepEqual(result, { settings: {}, unknown: [], dropped: [] });
  }
});

test('buildEffective: 设置文件 > 插件 Config > 内置默认，逐格标出来源', () => {
  const { value, origin } = buildEffective({
    stored: { notifySound: false },
    configured: { notifyTitle: '来自 Config', notifySound: true },
    defaults: DEFAULTS,
  });
  assert.deepEqual(value, { ...DEFAULTS, notifyTitle: '来自 Config', notifySound: false });
  assert.deepEqual(origin, { ...allDefaults(), notifyTitle: 'configured', notifySound: 'stored' });
});

// ── 设置文件的落点 ────────────────────────────────────────────────────────────

test('settingsFile(): DSH_PROFILE_DIR 优先，其次 DSH_HOME，最后 ~/.dsh', () => {
  const saved = { profile: process.env.DSH_PROFILE_DIR, home: process.env.DSH_HOME };
  try {
    process.env.DSH_PROFILE_DIR = path.join('C:', 'profiles', 'work');
    assert.equal(settingsFile(), path.join('C:', 'profiles', 'work', STORE_NAME));
    delete process.env.DSH_PROFILE_DIR;
    process.env.DSH_HOME = path.join('C:', 'dsh-home');
    assert.equal(settingsFile(), path.join('C:', 'dsh-home', STORE_NAME));
    delete process.env.DSH_HOME;
    assert.equal(settingsFile(), path.join(os.homedir(), '.dsh', STORE_NAME));
  } finally {
    if (saved.profile === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = saved.profile;
    if (saved.home === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved.home;
  }
});

test('插件名与路由前缀是契约（patch 行的 id 必须等于 export const name）', () => {
  assert.equal(pluginName, 'adg-settings');
  assert.equal(STORE_NAME, 'adg-settings.json');
});

// ── 跨模块漂移检查（I1 的守卫）───────────────────────────────────────────────

test('漂移: 设置页登记的 notify 三项与 adg-notify 真正读的键/默认值/界一致', () => {
  const consumed = FIELDS.filter((field) => field.consumer === 'adg-notify').map((field) => field.key);
  assert.deepEqual(consumed, Object.keys(USER_DEFAULTS), 'adg-notify 读的键必须与登记表逐项对上');
  for (const field of FIELDS.filter((item) => item.consumer === 'adg-notify')) {
    assert.deepEqual(USER_DEFAULTS[field.key], field.default, `${field.key} 的默认值两边不一致`);
  }
  assert.equal(fieldFor('notifyTitle').maxLength, MAX_TITLE_LENGTH);
  assert.equal(NOTIFY_STORE_NAME, STORE_NAME, '设置文件名是两个模块之间的契约');
});

test('漂移: 设置页登记的注入四项与 adg-skill-inject 真正读的键/默认值/界一致', () => {
  const consumed = FIELDS.filter((field) => field.consumer === 'adg-skill-inject').map((field) => field.key);
  assert.deepEqual(consumed, Object.keys(INJECT_DEFAULTS), 'adg-skill-inject 读的键必须与登记表逐项对上');
  for (const field of FIELDS.filter((item) => item.consumer === 'adg-skill-inject')) {
    assert.deepEqual(INJECT_DEFAULTS[field.key], field.default, `${field.key} 的默认值两边不一致`);
  }
  assert.equal(fieldFor('skillInjectText').maxLength, MAX_TEXT_LENGTH);
  assert.deepEqual(
    [...fieldFor('skillInjectFramework').allowValues],
    ['thinking', 'execution'],
    '注入框架的界的真相在登记表，消费方与客户端都不另立一份',
  );
  assert.equal(INJECT_STORE_NAME, STORE_NAME, '设置文件名是两个模块之间的契约');
});

test('漂移: 注入插件读得懂设置页写的开关与自定义正文，空正文即跟随技能文件', () => {
  withTempDir((dir) => {
    fs.writeFileSync(
      path.join(dir, STORE_NAME),
      `${JSON.stringify({ skillInjectEnabled: false, skillInjectText: '自定义正文' }, undefined, 2)}\n`,
    );
    assert.deepEqual(readInjectDefaults(), {
      skillInjectEnabled: false,
      skillInjectFramework: 'execution',
      skillInjectSubagent: false,
      skillInjectText: '自定义正文',
    });
    fs.writeFileSync(path.join(dir, STORE_NAME), JSON.stringify({ skillInjectText: '' }));
    assert.deepEqual(readInjectDefaults(), {
      skillInjectEnabled: true,
      skillInjectFramework: 'execution',
      skillInjectSubagent: false,
      skillInjectText: '',
    });
  });
});

test('漂移: 注入框架的两条路径（thinking / execution / 键缺失与非法值回落）', () => {
  withTempDir((dir) => {
    const file = path.join(dir, STORE_NAME);
    fs.writeFileSync(file, JSON.stringify({ skillInjectFramework: 'thinking' }));
    assert.equal(readInjectDefaults().skillInjectFramework, 'thinking', 'thinking 要被如实读出来');
    fs.writeFileSync(file, JSON.stringify({ skillInjectFramework: 'execution' }));
    assert.equal(readInjectDefaults().skillInjectFramework, 'execution', 'execution 要被如实读出来');
    fs.writeFileSync(file, JSON.stringify({ skillInjectEnabled: true }));
    assert.equal(readInjectDefaults().skillInjectFramework, 'execution', '键缺失要回落出厂默认 execution');
    fs.writeFileSync(file, JSON.stringify({ skillInjectFramework: 'Thinking' }));
    assert.equal(readInjectDefaults().skillInjectFramework, 'execution', '非法值要回落出厂默认 execution');
  });
});

test('漂移: 子代理开关的两条路径（false / true / 键缺失回落）', async () => {
  await withTempDir((dir) => {
    const file = path.join(dir, STORE_NAME);
    fs.writeFileSync(file, JSON.stringify({ skillInjectEnabled: true, skillInjectSubagent: false }));
    assert.equal(readInjectDefaults().skillInjectSubagent, false, 'false 要被如实读出来');
    fs.writeFileSync(file, JSON.stringify({ skillInjectEnabled: true, skillInjectSubagent: true }));
    assert.equal(readInjectDefaults().skillInjectSubagent, true, 'true 要被如实读出来');
    fs.writeFileSync(file, JSON.stringify({ skillInjectEnabled: true }));
    assert.equal(readInjectDefaults().skillInjectSubagent, false, '键缺失要回落出厂默认 false');
  });
});

test('漂移: cordis.patch.yml 的 config 出厂值与登记表 default 一致', () => {
  const raw = fs.readFileSync(path.join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8');
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'config:');
  assert.notEqual(start, -1, 'cordis.patch.yml 里要有 config: 块');
  const config = {};
  const re = /^        (\w+): (.*)$/;
  for (const line of lines.slice(start + 1)) {
    const match = re.exec(line);
    if (!match) break;
    const [, key, value] = match;
    if (value === "''") config[key] = '';
    else if (value === 'true') config[key] = true;
    else if (value === 'false') config[key] = false;
    else if (value.startsWith("'") && value.endsWith("'")) config[key] = value.slice(1, -1);
    else assert.fail(`cordis.patch.yml 的 config.${key} 值认不出来：${JSON.stringify(value)}`);
  }
  assert.deepEqual(
    Object.keys(config).sort(),
    FIELDS.map((field) => field.key).sort(),
    'config 里的键集合必须与登记表逐项对上',
  );
  for (const field of FIELDS) {
    assert.deepEqual(config[field.key], field.default, `config.${field.key} 与登记表 default 不一致`);
  }
});

test('漂移: notify 的 readUserDefaults 认得设置页写下的那份文件', () => {
  withTempDir((dir) => {
    fs.writeFileSync(
      path.join(dir, STORE_NAME),
      `${JSON.stringify({ notifyTitle: '自定义标题', notifySound: false, notifyPersist: false }, undefined, 2)}\n`,
    );
    assert.deepEqual(readUserDefaults(), { notifyTitle: '自定义标题', notifySound: false, notifyPersist: false });
    // 生产路径是 `apply` 里 `defaults: () => readUserDefaults()`；这里照着接上。
    const request_ = resolveRequest({ message: '需要你登录' }, readUserDefaults());
    assert.equal(request_.title, '自定义标题');
    assert.equal(request_.silent, true);
    assert.ok(Number.isInteger(request_.disappearAfterMs), '关掉常驻后要给出存活毫秒');
  });
});

test('漂移: 没保存过设置文件时 notify 落到出厂默认，请求形状里不多写字段', () => {
  withTempDir(() => {
    assert.deepEqual(readUserDefaults(), { ...USER_DEFAULTS });
    assert.deepEqual(resolveRequest({ message: 'x' }), { message: 'x', title: USER_DEFAULTS.notifyTitle });
  });
});

// ── 同源路由 ──────────────────────────────────────────────────────────────────

test('GET /settings: 没保存过时三层里的第三层生效，并给出登记表与落点', () => {
  withTempDir((dir) => {
    const { route } = harness();
    return request(route, 'GET').then(({ status, json, headers }) => {
      assert.equal(status, 200);
      assert.equal(headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(headers['cache-control'], 'no-store');
      assert.deepEqual(json.value, DEFAULTS);
      assert.deepEqual(json.origin, allDefaults());
      assert.deepEqual(json.stored, {});
      assert.deepEqual(json.unknown, []);
      assert.deepEqual(json.dropped, []);
      assert.deepEqual(json.fields, describeFields());
      assert.equal(json.file, path.join(dir, STORE_NAME));
    });
  });
});

test('POST 写盘 + GET 读回：保存后 origin 变成 stored，文件是 0600 的原子写', () => {
  withTempDir((dir) => {
    const { route } = harness();
    return request(route, 'POST', { notifyTitle: '自定义标题', notifySound: false, notifyPersist: false })
      .then(({ status, json }) => {
        assert.equal(status, 200);
        assert.deepEqual(json.value, {
          ...DEFAULTS,
          notifyTitle: '自定义标题',
          notifySound: false,
          notifyPersist: false,
        });
        assert.deepEqual(json.origin, {
          ...allDefaults(),
          notifyTitle: 'stored',
          notifySound: 'stored',
          notifyPersist: 'stored',
        });
        const file = path.join(dir, STORE_NAME);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
          notifyTitle: '自定义标题',
          notifySound: false,
          notifyPersist: false,
        });
        assert.equal(fs.existsSync(`${file}.tmp`), false, '临时文件必须已经改名走');
        if (process.platform !== 'win32') {
          assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        }
        return request(route, 'GET');
      })
      .then(({ json }) => {
        assert.equal(json.value.notifyTitle, '自定义标题');
        assert.equal(json.stored.notifySound, false);
      });
  });
});

test('POST 是逐键合并不是整份替换：后一次保存不会抹掉前一次的键', () => {
  withTempDir(() => {
    const { route } = harness();
    return request(route, 'POST', { notifyTitle: 'A' })
      .then(({ status }) => {
        assert.equal(status, 200);
        return request(route, 'POST', { notifySound: false });
      })
      .then(({ status, json }) => {
        assert.equal(status, 200);
        assert.deepEqual(json.value, { ...DEFAULTS, notifyTitle: 'A', notifySound: false });
        assert.deepEqual(json.origin, { ...allDefaults(), notifyTitle: 'stored', notifySound: 'stored' });
      });
  });
});

test('POST: 空体、非 JSON、认不得的键一律 400，且什么也不落盘', () => {
  withTempDir((dir) => {
    const { route } = harness();
    const file = path.join(dir, STORE_NAME);
    return request(route, 'POST', {})
      .then(({ status, json }) => {
        assert.equal(status, 400);
        assert.equal(json.error, 'no settings provided');
        return request(route, 'POST', Buffer.from('{ not json', 'utf8'));
      })
      .then(({ status, json }) => {
        assert.equal(status, 400);
        assert.equal(json.error, 'no settings provided');
        return request(route, 'POST', { legacyFlag: true });
      })
      .then(({ status, json }) => {
        assert.equal(status, 400);
        assert.match(json.error, /^unknown setting "legacyFlag" \(not in lib\/schema\.mjs\)$/);
        assert.equal(fs.existsSync(file), false, '被拒的请求不许写盘');
      });
  });
});

test('POST: 值不合法 400 并点名是哪一格，且不动已保存的值', () => {
  withTempDir((dir) => {
    const { route, logged } = harness();
    return request(route, 'POST', { notifyTitle: '好标题' })
      .then(() => request(route, 'POST', { notifySound: 'yes' }))
      .then(({ status, json }) => {
        assert.equal(status, 400);
        assert.equal(json.field, 'notifySound');
        assert.equal(json.error, 'notifySound must be true or false');
        return request(route, 'GET');
      })
      .then(({ json }) => {
        assert.equal(json.value.notifyTitle, '好标题', '上一次保存的值要还在');
        assert.equal(json.origin.notifySound, 'default');
        const file = JSON.parse(fs.readFileSync(path.join(dir, STORE_NAME), 'utf8'));
        assert.deepEqual(file, { notifyTitle: '好标题' });
        assert.ok(logged.info.some((line) => line.includes('saved notifyTitle')));
      });
  });
});

test('插件 Config 是中间层：页面没保存过时用它，保存过的键以文件为准', () => {
  withTempDir(() => {
    // 认不得的 Config 键只警告、不进系统。
    const { route, logged } = harness({ notifyTitle: '来自 Config', notifyPersist: false, typoKey: 1 });
    assert.ok(
      logged.warn.some((line) => line.includes('ignoring unknown key "typoKey" in the plugin Config')),
    );
    return request(route, 'GET')
      .then(({ json }) => {
        assert.deepEqual(json.value, { ...DEFAULTS, notifyTitle: '来自 Config', notifyPersist: false });
        assert.deepEqual(json.origin, {
          ...allDefaults(),
          notifyTitle: 'configured',
          notifyPersist: 'configured',
        });
        return request(route, 'POST', { notifySound: false });
      })
      .then(({ json }) => {
        assert.equal(json.value.notifyTitle, '来自 Config', '没保存过的键仍由 Config 定');
        assert.equal(json.origin.notifyTitle, 'configured');
        assert.equal(json.origin.notifySound, 'stored');
        assert.equal(json.origin.notifyPersist, 'configured');
      });
  });
});

test('DELETE /settings: 删掉文件、回到 Config 与内置默认，日志说清「清掉了」', () => {
  withTempDir((dir) => {
    const { route, logged } = harness();
    const file = path.join(dir, STORE_NAME);
    return request(route, 'POST', { notifyTitle: 'A' })
      .then(() => request(route, 'DELETE'))
      .then(({ status, json }) => {
        assert.equal(status, 200);
        assert.equal(fs.existsSync(file), false);
        assert.deepEqual(json.value, DEFAULTS);
        assert.deepEqual(json.origin, allDefaults());
        assert.ok(logged.info.some((line) => line.includes('settings cleared')));
      });
  });
});

test('坏掉的设置文件不会让页面崩：坏值丢掉、认不得的键报出来', () => {
  withTempDir((dir) => {
    const file = path.join(dir, STORE_NAME);
    fs.writeFileSync(file, '{ this is not json');
    const { route, logged } = harness();
    return request(route, 'GET')
      .then(({ json }) => {
        assert.deepEqual(json.value, DEFAULTS);
        assert.deepEqual(logged.warn, [], '读不出 JSON 是「没保存过」，不是错误');
        fs.writeFileSync(
          file,
          `${JSON.stringify({ notifySound: 'nope', notifyTitle: '好的', legacyFlag: 2 }, undefined, 2)}\n`,
        );
        return request(route, 'GET');
      })
      .then(({ json }) => {
        assert.equal(json.value.notifyTitle, '好的');
        assert.equal(json.value.notifySound, DEFAULTS.notifySound);
        assert.deepEqual(json.dropped, ['notifySound']);
        assert.deepEqual(json.unknown, ['legacyFlag']);
        assert.ok(logged.warn.some((line) => line.includes('dropping notifySound="nope"')));
      });
  });
});

test('请求栅栏：非回环 Host、cross-site、外站 Origin 一律 403，不读也不写', () => {
  withTempDir(() => {
    const { route } = harness();
    return request(route, 'GET', undefined, { host: 'evil.example.com' })
      .then(({ status, json }) => {
        assert.equal(status, 403);
        assert.equal(json.error, 'forbidden');
        return request(route, 'GET', undefined, { 'sec-fetch-site': 'cross-site' });
      })
      .then(({ status }) => {
        assert.equal(status, 403);
        return request(route, 'POST', { notifyTitle: 'x' }, { origin: 'https://evil.example.com' });
      })
      .then(({ status }) => {
        assert.equal(status, 403);
        return request(route, 'GET', undefined, { origin: 'http://127.0.0.1:3080', referer: 'http://127.0.0.1:3080/' });
      })
      .then(({ status }) => {
        assert.equal(status, 200, '同源请求要放行');
      });
  });
});

test('connection 服务在场时以它的判定为准（不自己再判一次）', () => {
  withTempDir(() => {
    const routes = [];
    const ctx = {
      logger: { warn: () => {}, info: () => {}, debug: () => {} },
      get: (service) =>
        service === 'connection'
          ? {
              admit: (req) => (req.headers.host === '127.0.0.1:3080' ? undefined : { rejection: 401 }),
            }
          : undefined,
      inject: (_names, run) =>
        run({
          logger: ctx.logger,
          get: ctx.get,
          effect: (body) => body(),
          webServer: { register: (route) => routes.push(route) },
        }),
    };
    apply(ctx);
    return request(routes[0], 'GET', undefined, { host: 'elsewhere.local' })
      .then(({ status, json }) => {
        assert.equal(status, 401);
        assert.equal(json.error, 'unauthorized');
        return request(routes[0], 'GET');
      })
      .then(({ status }) => {
        assert.equal(status, 200, 'connection 放行就不该被结构栅栏拦下');
      });
  });
});

test('路由表：只有 /settings，方法只认 GET/POST/DELETE', () => {
  withTempDir(() => {
    const { route } = harness();
    return request(route, 'HEAD')
      .then(({ status, json }) => {
        assert.equal(status, 405);
        assert.equal(json.error, 'method not allowed');
        return request(route, 'GET', undefined, {}, '/other');
      })
      .then(({ status, json }) => {
        assert.equal(status, 404);
        assert.equal(json.error, 'not found');
      });
  });
});

test('R12/I13: 客户端 DICT 覆盖了每条登记项与分组的文案键（zh 与 en 各一份）', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const wanted = new Set(['meta.title', 'meta.description']);
  for (const field of FIELDS) {
    wanted.add(field.labelKey);
    wanted.add(field.hintKey);
    wanted.add(`group.${field.group}`);
    // enum 的每个选项各要一条 option.<键>.<值>（R12：少一份页面就显示裸键）。
    for (const value of field.allowValues ?? []) wanted.add(`option.${field.key}.${value}`);
  }
  for (const key of wanted) {
    const definitions = source.split(`'${key}':`).length - 1;
    assert.ok(definitions >= 2, `client.js 的 DICT 里 ${key} 只有 ${definitions} 份（需要 zh 与 en 各一份）`);
  }
});

test('请求体有上限：超过 64KB 直接掐掉，答 400 且不写盘', () => {
  withTempDir((dir) => {
    const { route } = harness();
    const huge = Buffer.alloc(70 * 1024, 0x61);
    return request(route, 'POST', huge).then(({ status, req }) => {
      assert.equal(status, 400);
      assert.equal(req.destroyed, true, '超限的请求要被 destroy 掉');
      assert.equal(fs.existsSync(path.join(dir, STORE_NAME)), false);
    });
  });
});
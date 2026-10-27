// adg-skill-inject 侧「用户设置」的自测：宽容读取 + 与设置页登记表的键/默认值/界对齐。
//
// 纪律与仓库其它模块一致：零依赖、零副作用 —— 落盘只发生在 mkdtemp 出来的临时目录里，
// 靠 DSH_PROFILE_DIR 指过去，用例结束时恢复环境变量并删目录。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_TEXT_LENGTH,
  STORE_NAME,
  USER_DEFAULTS,
  readUserDefaults,
  settingsFile,
} from '../lib/user-settings.mjs';

/** 跑一段代码，期间把两个环境变量换成临时目录，跑完恢复并删目录。 */
function withTempDir(run) {
  const saved = { profile: process.env.DSH_PROFILE_DIR, home: process.env.DSH_HOME };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adg-skill-inject-settings-'));
  process.env.DSH_PROFILE_DIR = dir;
  delete process.env.DSH_HOME;
  try {
    return run(dir);
  } finally {
    if (saved.profile === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = saved.profile;
    if (saved.home === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved.home;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('USER_DEFAULTS: 出厂默认是「开着 + 执行框架 + 不注入子代理 + 留空即跟随技能文件」', () => {
  assert.deepEqual(USER_DEFAULTS, {
    skillInjectEnabled: true,
    skillInjectFramework: 'execution',
    skillInjectSubagent: false,
    skillInjectText: '',
  });
  assert.equal(Object.isFrozen(USER_DEFAULTS), true);
  assert.equal(STORE_NAME, 'adg-settings.json');
  assert.equal(MAX_TEXT_LENGTH, 20000);
});

test('settingsFile(): 与宿主同口径（DSH_PROFILE_DIR 优先，其次 DSH_HOME）', () => {
  const saved = { profile: process.env.DSH_PROFILE_DIR, home: process.env.DSH_HOME };
  try {
    process.env.DSH_PROFILE_DIR = path.join('C:', 'profiles', 'work');
    assert.equal(settingsFile(), path.join('C:', 'profiles', 'work', STORE_NAME));
    delete process.env.DSH_PROFILE_DIR;
    process.env.DSH_HOME = path.join('C:', 'dsh-home');
    assert.equal(settingsFile(), path.join('C:', 'dsh-home', STORE_NAME));
  } finally {
    if (saved.profile === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = saved.profile;
    if (saved.home === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved.home;
  }
});

test('readUserDefaults: 文件不存在 / 坏 JSON / 不是对象 -> 出厂默认，不抛错', () => {
  withTempDir((dir) => {
    assert.deepEqual(readUserDefaults(), { ...USER_DEFAULTS });
    fs.writeFileSync(path.join(dir, STORE_NAME), '{ not json');
    assert.deepEqual(readUserDefaults(), { ...USER_DEFAULTS });
    fs.writeFileSync(path.join(dir, STORE_NAME), '[1,2,3]');
    assert.deepEqual(readUserDefaults(), { ...USER_DEFAULTS });
    fs.writeFileSync(path.join(dir, STORE_NAME), 'null');
    assert.deepEqual(readUserDefaults(), { ...USER_DEFAULTS });
  });
});

test('readUserDefaults: 缺项 / 项坏只影响那一项（含字符串形式的布尔）', () => {
  withTempDir((dir) => {
    const file = path.join(dir, STORE_NAME);
    fs.writeFileSync(file, JSON.stringify({ skillInjectEnabled: 'false' }));
    assert.deepEqual(readUserDefaults(), {
      skillInjectEnabled: false,
      skillInjectFramework: 'execution',
      skillInjectSubagent: false,
      skillInjectText: '',
    });
    fs.writeFileSync(file, JSON.stringify({ skillInjectEnabled: 'yes', skillInjectText: '正文', extraKey: 1 }));
    assert.deepEqual(readUserDefaults(), {
      skillInjectEnabled: true,
      skillInjectFramework: 'execution',
      skillInjectSubagent: false,
      skillInjectText: '正文',
    });
    fs.writeFileSync(file, JSON.stringify({ skillInjectText: 42 }));
    assert.deepEqual(readUserDefaults(), { ...USER_DEFAULTS });
  });
});

test('readUserDefaults: skillInjectFramework 的读出 / 非法回落 / 出厂默认', () => {
  withTempDir((dir) => {
    const file = path.join(dir, STORE_NAME);
    for (const good of ['thinking', 'execution']) {
      fs.writeFileSync(file, JSON.stringify({ skillInjectFramework: good }));
      assert.equal(readUserDefaults().skillInjectFramework, good);
    }
    // 缺项 / 类型不对 / 大小写不同 / 带空白 / 认不得的名字 —— 一律回落到执行框架。
    fs.writeFileSync(file, JSON.stringify({ skillInjectEnabled: true }));
    assert.equal(readUserDefaults().skillInjectFramework, 'execution');
    for (const bad of ['Thinking', ' thinking', 'thinking ', 'THINKING', '', 'thinking-framework', 'execution-framework', null, true, 1, {}, []]) {
      fs.writeFileSync(file, JSON.stringify({ skillInjectFramework: bad }));
      assert.equal(readUserDefaults().skillInjectFramework, 'execution', JSON.stringify(bad));
    }
    // 文件读不出来（坏 JSON）也回落。
    fs.writeFileSync(file, '{ not json');
    assert.equal(readUserDefaults().skillInjectFramework, 'execution');
  });
});

test('readUserDefaults: skillInjectSubagent 的读出 / 回落 / 字符串写法', () => {
  withTempDir((dir) => {
    const file = path.join(dir, STORE_NAME);
    fs.writeFileSync(file, JSON.stringify({ skillInjectSubagent: true }));
    assert.equal(readUserDefaults().skillInjectSubagent, true);
    fs.writeFileSync(file, JSON.stringify({ skillInjectSubagent: false }));
    assert.equal(readUserDefaults().skillInjectSubagent, false);
    fs.writeFileSync(file, JSON.stringify({ skillInjectSubagent: 'true' }));
    assert.equal(readUserDefaults().skillInjectSubagent, true);
    fs.writeFileSync(file, JSON.stringify({ skillInjectSubagent: 'false' }));
    assert.equal(readUserDefaults().skillInjectSubagent, false);
    for (const bad of ['yes', 1, 0, null, {}, []]) {
      fs.writeFileSync(file, JSON.stringify({ skillInjectSubagent: bad }));
      assert.equal(readUserDefaults().skillInjectSubagent, false);
    }
    fs.writeFileSync(file, JSON.stringify({ skillInjectEnabled: true }));
    assert.equal(readUserDefaults().skillInjectSubagent, false);
  });
});
test('readUserDefaults: 正文的长度上限（正好 20000 收，20001 不收）', () => {
  withTempDir((dir) => {
    const file = path.join(dir, STORE_NAME);
    const long = 'x'.repeat(MAX_TEXT_LENGTH);
    fs.writeFileSync(file, JSON.stringify({ skillInjectText: long }));
    assert.equal(readUserDefaults().skillInjectText.length, MAX_TEXT_LENGTH);
    fs.writeFileSync(file, JSON.stringify({ skillInjectText: `${long}x` }));
    assert.equal(readUserDefaults().skillInjectText, '');
  });
});

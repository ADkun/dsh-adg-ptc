// notify 侧的「用户默认值」层自测：请求形状与设置文件的宽容读取。
//
// 纪律与 notify.test.mjs 相同：零依赖、零副作用 —— 不弹真 toast、不起进程、只读
// mkdtemp 出来的临时目录。`resolveRequest` 是纯函数，所以形状类断言都不碰文件系统。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_TITLE } from '../lib/toast.mjs';
import {
  AUTO_DISMISS_MS,
  MAX_TITLE_LENGTH,
  STORE_NAME,
  USER_DEFAULTS,
  readUserDefaults,
  resolveRequest,
  settingsFile,
} from '../lib/user-settings.mjs';

/** 跑一段代码，期间把 DSH_PROFILE_DIR 换成临时目录，跑完恢复。 */
function withTempDir(run) {
  const saved = { profile: process.env.DSH_PROFILE_DIR, home: process.env.DSH_HOME };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adg-notify-usersettings-'));
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

test('USER_DEFAULTS: 三项出厂默认就是 toast 层的默认（标题沿用 DEFAULT_TITLE）', () => {
  assert.deepEqual(USER_DEFAULTS, { notifyTitle: DEFAULT_TITLE, notifySound: true, notifyPersist: true });
  assert.equal(Object.isFrozen(USER_DEFAULTS), true);
  assert.equal(AUTO_DISMISS_MS, 8000, '改成常驻之前的原有默认值');
  assert.equal(MAX_TITLE_LENGTH, 80);
  assert.equal(STORE_NAME, 'adg-settings.json');
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

test('resolveRequest: 出厂默认下不多写字段（不写 silent / disappearAfterMs）', () => {
  assert.deepEqual(resolveRequest({ message: 'x' }), { message: 'x', title: DEFAULT_TITLE });
  assert.deepEqual(resolveRequest({ message: 'x', title: '标题' }), { message: 'x', title: '标题' });
});

test('resolveRequest: 这一次调用的参数压过设置页的值', () => {
  const saved = { notifyTitle: '设置页标题', notifySound: false, notifyPersist: false };
  assert.deepEqual(resolveRequest({ message: 'x', title: '本次标题' }, saved), {
    message: 'x',
    title: '本次标题',
    silent: true,
    disappearAfterMs: AUTO_DISMISS_MS,
  });
  assert.deepEqual(resolveRequest({ message: 'x', title: '本次标题', silent: false }, saved), {
    message: 'x',
    title: '本次标题',
    silent: false,
    disappearAfterMs: AUTO_DISMISS_MS,
  });
});

test('resolveRequest: 空白标题算「没写」，回落到设置页的标题', () => {
  for (const title of ['', '   ', undefined, null, 7]) {
    assert.equal(resolveRequest({ message: 'x', title }, { notifyTitle: '设置页标题' }).title, '设置页标题');
  }
});

test('resolveRequest: 「响提示音」关掉才写 silent:true；「通知常驻」关掉才写存活毫秒', () => {
  assert.deepEqual(resolveRequest({ message: 'x' }, { notifyTitle: 'T', notifySound: true, notifyPersist: true }), {
    message: 'x',
    title: 'T',
  });
  assert.deepEqual(resolveRequest({ message: 'x' }, { notifyTitle: 'T', notifySound: false, notifyPersist: true }), {
    message: 'x',
    title: 'T',
    silent: true,
  });
  assert.deepEqual(resolveRequest({ message: 'x' }, { notifyTitle: 'T', notifySound: true, notifyPersist: false }), {
    message: 'x',
    title: 'T',
    disappearAfterMs: AUTO_DISMISS_MS,
  });
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

test('readUserDefaults: 缺项 / 项坏只影响那一项，其余照收（含字符串形式的布尔）', () => {
  withTempDir((dir) => {
    const file = path.join(dir, STORE_NAME);
    fs.writeFileSync(file, JSON.stringify({ notifyTitle: '自定义', notifySound: 'false' }));
    assert.deepEqual(readUserDefaults(), { notifyTitle: '自定义', notifySound: false, notifyPersist: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ notifyTitle: 42, notifySound: 'yes', notifyPersist: 'true', extraKey: 1 }),
    );
    assert.deepEqual(readUserDefaults(), { notifyTitle: DEFAULT_TITLE, notifySound: true, notifyPersist: true });
  });
});

test('readUserDefaults: 标题的长度上限在两边一致（正好 80 收，81 不收；空白不收）', () => {
  withTempDir((dir) => {
    const file = path.join(dir, STORE_NAME);
    const long = 'x'.repeat(MAX_TITLE_LENGTH);
    fs.writeFileSync(file, JSON.stringify({ notifyTitle: long }));
    assert.equal(readUserDefaults().notifyTitle, long);
    fs.writeFileSync(file, JSON.stringify({ notifyTitle: `${long}x` }));
    assert.equal(readUserDefaults().notifyTitle, DEFAULT_TITLE);
    fs.writeFileSync(file, JSON.stringify({ notifyTitle: '   ' }));
    assert.equal(readUserDefaults().notifyTitle, DEFAULT_TITLE);
  });
});
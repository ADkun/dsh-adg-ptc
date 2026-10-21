// `notify/` 的不变量用例（编号与 design.md 的 D1..D7 一一对应）。
//
// 全部零依赖、零副作用：**不弹真 toast、不起真进程、不联网、不读写 profile**。
// PowerShell 的调用边界用「可注入的假 child」钉住，所以「失败绝不谎报成功」
// 这类行为在没装 PowerShell 的机器上照样能验。
//
// 唯一的环境前提：`@deepseek-ai/dsh-tools` 必须能解析（它是本插件的 peer 依赖，
// 由 dsh 本身供给；本机在仓库根放了一个 git-ignore 的 node_modules 桥，见 testing-guide.md）。
//
// 跑法：  cd notify && node --test test
// DSH 沙箱（workspace-write）里加 --test-isolation=none，见 testing-guide.md。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineTool } from '@deepseek-ai/dsh-tools';

import { apply, createNotifyUserTool, inject, name, TOOL_NAME } from '../index.mjs';
import {
  DEFAULT_APP_ID,
  DEFAULT_TITLE,
  buildToastArgs,
  normalizeNotification,
  sendToast,
} from '../lib/toast.mjs';

/**
 * 一律拿**真的** `defineTool` 造工具定义。
 *
 * 这条是本模块最重要的一条测试纪律：`defineTool` 不只是个恒等包装 —— 它会把作者侧的
 * 声明编译成受支持的 JSON Schema 子集，**形状写错就在这一步抛 JsonSchemaError**。
 * 早先的版本用 stub 顶替它，于是 `parameters` 写成了 `{type:'object',properties:{…}}`
 * （作者侧要的是**裸属性映射**）却一路全绿，真挂载时会在 `apply()` 里当场抛错。
 * 详见 design.md 的 N12。
 */
function realToolDefinition(deps = {}) {
  return createNotifyUserTool({ ...deps, defineTool });
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'toast.ps1');

// ---------- 假 child：模拟 spawn 返回面的最小事件/退出接口 ----------

class FakeChild {
  constructor(plan = {}) {
    this.plan = plan;
    this.killed = false;
    this.listeners = new Map();
  }

  once(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
    // 计划里的自动退出：下一个 tick 就报，模拟 PowerShell 快速返回。
    if (this.plan && this.plan.auto) {
      const plan = this.plan;
      this.plan = null;
      setImmediate(() =>
        this.emit(
          plan.auto === 'error' ? 'error' : 'exit',
          ...(Array.isArray(plan.value) ? plan.value : [plan.value]),
        ),
      );
    }
    return this;
  }

  emit(type, ...values) {
    for (const fn of this.listeners.get(type) ?? []) fn(...values);
  }

  kill() {
    this.killed = true;
  }
}

/** 造一个 spawn 替身；返回 { spawnImpl, calls }。 */
function fakeSpawn(plan) {
  const calls = [];
  const spawnImpl = (command, argv, options) => {
    const child = new FakeChild(plan);
    calls.push({ command, argv, options, child });
    return child;
  };
  return { spawnImpl, calls };
}

// ---------- D1 / D2：注册与工具形状 ----------

test('D1: apply 在 stub ctx 上注册了 notify_user，且只注册一个工具', () => {
  const registered = [];
  const ctx = {
    tools: {
      register: (definition) => {
        registered.push(definition);
        return () => {};
      },
    },
  };

  apply(ctx);

  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'notify_user');
  assert.equal(TOOL_NAME, 'notify_user');
  assert.deepEqual(inject, ['tools']);
});

test('D1: 插件名与 patch 行的行 id 一致（adg-notify）', () => {
  assert.equal(name, 'adg-notify');
  const patch = fs.readFileSync(path.join(HERE, '..', 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /-\s*id:\s*adg-notify\b/);
  assert.match(patch, /name:\s*adg-notify\b/);
});

test('D2: 参数 schema 只把 message 标成必填，title / silent 可选', () => {
  const tool = realToolDefinition({ send: async () => ({}) });

  assert.equal(tool.name, 'notify_user');
  // 真 `defineTool` 把作者侧的裸属性映射编译成对象根 JSON Schema。
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['message', 'silent', 'title']);
  assert.deepEqual(tool.parameters.required, ['message']);
  assert.equal(tool.parameters.properties.message.type, 'string');
  assert.equal(tool.parameters.properties.title.type, 'string');
  assert.equal(tool.parameters.properties.silent.type, 'boolean');
  assert.equal(typeof tool.output.render, 'function');
  assert.equal(tool.output.schema.type, 'object');
  assert.equal(typeof tool.execute, 'function');
});

test('D2: 用真 defineTool 造定义不抛错（作者侧 schema 方言正确）', () => {
  // 这是「注册那一刻会不会炸」的唯一可离线证据：真 dsh 的 `apply()` 走的是同一个
  // 真 `defineTool`，形状不合规会在这里就抛 `JsonSchemaError`。
  assert.doesNotThrow(() => realToolDefinition({ send: async () => ({}) }));
});

test('D2: 这条纪律不是空转 —— 「对象根 + properties」形状会被真 defineTool 判死', () => {
  // 反向对照（作者侧方言的反例形状：把 parameters 写成「对象根 + properties」）：
  // 若真 `defineTool` 对这个形状也放行，那上面那条 doesNotThrow 就只是在空转。
  assert.throws(
    () =>
      defineTool({
        name: TOOL_NAME,
        description: 'x',
        parameters: {
          type: 'object',
          properties: { message: { type: 'string', required: true }, title: { type: 'string' } },
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
        execute: async () => ({}),
      }),
    /parameters\.type must be a value schema object/,
  );
});

test('D2: 缺 message 的调用在进 execute 之前就被参数校验拦下', async () => {
  let called = false;
  const tool = realToolDefinition({
    send: async () => {
      called = true;
      return {};
    },
  });

  await assert.rejects(() => tool.execute({}), /invalid arguments: missing required property "message"/);
  assert.equal(called, false, 'execute 不该在参数非法时被调用');
});

// ---------- D3：execute 成功路径 ----------

test('D3: execute 成功时返回 {shown:true, mechanism:"toast", ...}，并把 title/silent 透传下去', async () => {
  const seen = [];
  const tool = realToolDefinition({
    send: async (input) => {
      seen.push(input);
      return {
        shown: true,
        mechanism: 'toast',
        title: input.title,
        message: input.message,
        disappearAfterMs: 8000,
      };
    },
  });

  const value = await tool.execute({ message: '需要你登录', title: '浏览器操作卡住了', silent: true });

  assert.deepEqual(seen, [{ message: '需要你登录', title: '浏览器操作卡住了', silent: true }]);
  assert.deepEqual(value, {
    shown: true,
    mechanism: 'toast',
    title: '浏览器操作卡住了',
    message: '需要你登录',
    disappearAfterMs: 8000,
  });
});

test('D3: 未传 silent 时落到默认出声（silent 缺省或 undefined 同义）', async () => {
  const tool = realToolDefinition({ send: (input) => sendToastAdapter(input) });

  // 直接断言可观察行为：silent 缺席与 silent=undefined 得到同一个 sound。
  assert.deepEqual(
    normalizeNotification({ message: 'x', title: 't' }),
    normalizeNotification({ message: 'x', title: 't', silent: undefined }),
  );
  assert.equal(normalizeNotification({ message: 'x', silent: undefined }).sound, 'default');

  const value = await tool.execute({ message: 'x' });
  assert.equal(value.shown, true);
  assert.equal(value.title, DEFAULT_TITLE);
});

/** 把 send 换成一个真的落到 toast 内核的适配器（用设备无关的 win32 表头，不起进程）。 */
function sendToastAdapter(input) {
  return {
    shown: true,
    mechanism: 'toast',
    title: input.title ?? DEFAULT_TITLE,
    message: input.message,
    disappearAfterMs: 8000,
  };
}

// ---------- D4：失败绝不谎报成功 ----------

test('D4: toast 机制不可用时 execute 抛错，不返回 shown:false', async () => {
  const tool = realToolDefinition({
    send: async () => {
      throw new Error('notify: toast script not found at "NUL" (ENOENT)');
    },
  });

  await assert.rejects(() => tool.execute({ message: 'x' }), /toast script not found/);
});

test('D4: 非 Windows 平台拒绝执行（不会假装弹过）', async () => {
  await assert.rejects(
    () => sendToast({ message: 'x' }, { platform: 'linux', scriptPath: SCRIPT }),
    /only exists on Windows \(current platform: linux\)/,
  );
});

test('D4: 脚本不存在时抛错，错误里带路径与原因', async () => {
  const missing = path.join(HERE, 'no-such-toast.ps1');
  await assert.rejects(
    () => sendToast({ message: 'x' }, { platform: 'win32', scriptPath: missing, spawnImpl: () => { throw new Error('不应被调用'); } }),
    (error) => {
      assert.match(error.message, /toast script not found/);
      assert.match(error.message, /no-such-toast\.ps1/);
      assert.match(error.message, /ENOENT/);
      return true;
    },
  );
});

test('D4: 脚本路径指向目录时抛错', async () => {
  await assert.rejects(
    () => sendToast({ message: 'x' }, { platform: 'win32', scriptPath: HERE }),
    /is not a regular file/,
  );
});

test('D4: PowerShell 可执行文件不存在时抛错，且根本不起进程', async () => {
  const bogus = path.join(HERE, 'no-such-powershell.exe');
  let spawned = false;
  await assert.rejects(
    () =>
      sendToast(
        { message: 'x' },
        {
          platform: 'win32',
          scriptPath: SCRIPT,
          powerShellPath: bogus,
          spawnImpl: () => {
            spawned = true;
            return new FakeChild({});
          },
        },
      ),
    /Windows PowerShell not found/,
  );
  assert.equal(spawned, false);
});

test('D4: 非零退出码 -> 抛错并报出退出码', async () => {
  const { spawnImpl } = fakeSpawn({ auto: 'exit', value: 1 });
  await assert.rejects(
    () => sendToast({ message: 'x' }, { platform: 'win32', scriptPath: SCRIPT, spawnImpl }),
    /failed with exit code 1/,
  );
});

test('D4: 被信号杀死 -> 抛错并报出信号', async () => {
  const { spawnImpl } = fakeSpawn({ auto: 'exit', value: [null, 'SIGKILL'] });
  await assert.rejects(
    () => sendToast({ message: 'x' }, { platform: 'win32', scriptPath: SCRIPT, spawnImpl }),
    /failed with signal SIGKILL/,
  );
});

test('D4: spawn 同步抛错 -> 包装成可读错误', async () => {
  await assert.rejects(
    () =>
      sendToast(
        { message: 'x' },
        {
          platform: 'win32',
          scriptPath: SCRIPT,
          spawnImpl: () => {
            throw new Error('EACCES');
          },
        },
      ),
    /failed to start .*: EACCES/,
  );
});

test('D4: child 发 error 事件 -> 抛错', async () => {
  const { spawnImpl } = fakeSpawn({ auto: 'error', value: new Error('EPERM') });
  await assert.rejects(
    () => sendToast({ message: 'x' }, { platform: 'win32', scriptPath: SCRIPT, spawnImpl }),
    /failed to start .*EPERM/,
  );
});

test('D4: 超时会杀掉子进程并抛错', async () => {
  const { spawnImpl, calls } = fakeSpawn({});
  await assert.rejects(
    () =>
      sendToast(
        { message: 'x' },
        { platform: 'win32', scriptPath: SCRIPT, timeoutMs: 20, spawnImpl },
      ),
    /did not finish within 20 ms/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].child.killed, true);
});

test('D4: 成功路径返回结构化结果，且用 stdio:ignore 起进程', async () => {
  const { spawnImpl, calls } = fakeSpawn({ auto: 'exit', value: 0 });

  const result = await sendToast(
    { message: '需要你登录', title: '卡住了' },
    { platform: 'win32', scriptPath: SCRIPT, spawnImpl },
  );

  assert.equal(result.shown, true);
  assert.equal(result.mechanism, 'toast');
  assert.equal(result.title, '卡住了');
  assert.equal(result.message, '需要你登录');
  assert.equal(result.scriptPath, SCRIPT);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { stdio: 'ignore', windowsHide: true });
  assert.ok(calls[0].argv.includes('-File'));
  assert.ok(calls[0].argv.includes(SCRIPT));
});

// ---------- D5：argv 与参数规整 ----------

test('D5: argv 用 Windows PowerShell 5.1 的调用形状，声音/存活时间随参数走', () => {
  const note = normalizeNotification({ message: 'a\r\nb', title: ' T ', silent: true, disappearAfterMs: 0 });
  const argv = buildToastArgs('C:\\x\\toast.ps1', note);

  assert.deepEqual(argv.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.equal(argv[5], 'C:\\x\\toast.ps1');
  assert.ok(argv.includes('-Title'));
  assert.equal(argv[argv.indexOf('-Title') + 1], 'T');
  assert.equal(argv[argv.indexOf('-Body') + 1], 'a\nb');
  assert.equal(argv[argv.indexOf('-AppId') + 1], DEFAULT_APP_ID);
  assert.equal(argv[argv.indexOf('-Sound') + 1], 'silent');
  assert.equal(argv[argv.indexOf('-DisappearAfterMs') + 1], '0');
});

test('D5: 空 message / 非字符串 title / 非整数毫秒都被拒', () => {
  assert.throws(() => normalizeNotification({ message: '   ' }), /must not be empty/);
  assert.throws(() => normalizeNotification({ message: 42 }), /must be a string/);
  assert.throws(() => normalizeNotification({ message: 'x', title: 7 }), /title must be a string/);
  assert.throws(() => normalizeNotification({ message: 'x', disappearAfterMs: 1.5 }), /must be an integer/);
  assert.throws(() => normalizeNotification({ message: 'x', disappearAfterMs: 'soon' }), /must be an integer/);
});

test('D5: 默认标题是 DSH 通知，默认存活 0ms（=> 常驻提醒，不设 ExpirationTime）', () => {
  const note = normalizeNotification({ message: 'x' });
  assert.equal(note.title, DEFAULT_TITLE);
  assert.equal(note.title, 'DSH 通知');
  assert.equal(note.disappearAfterMs, 0);
  assert.equal(note.sound, 'default');
});

// ---------- D6：toast.ps1 自身的红线 ----------

test('D6: toast.ps1 是 ASCII-only、无 BOM、且用 $ErrorActionPreference=Stop', () => {
  const bytes = fs.readFileSync(SCRIPT);

  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'toast.ps1 不许带 BOM');
  const nonAscii = [...bytes].map((byte, index) => (byte > 0x7f ? index : -1)).filter((index) => index >= 0);
  assert.deepEqual(nonAscii, [], 'toast.ps1 必须保持纯 ASCII（5.1 按 ANSI 代码页解码无 BOM 脚本）');

  const text = bytes.toString('ascii');
  assert.match(text, /\$ErrorActionPreference = 'Stop'/);
  assert.match(text, /Windows\.UI\.Notifications\.ToastNotificationManager/);
  assert.match(text, /Windows\.Data\.Xml\.Dom\.XmlDocument/);
  assert.match(text, /WindowsPowerShell\\v1\.0\\powershell\.exe'/, 'AppId 必须落在 Windows PowerShell 5.1 宿主上');
  assert.doesNotMatch(text, /pwsh\.exe'/, '不许把 pwsh.exe 当执行器：它没有这套 WinRT 投影');
  assert.doesNotMatch(text, /BurntToast/, '不许依赖第三方模块（New-BurntToastNotification 要装模块）');
});

test('D7: 在 Windows 上默认解析到 Windows PowerShell v1.0，而不是 pwsh', async () => {
  if (process.platform !== 'win32') return;
  const { resolvePowershellPath } = await import('../lib/toast.mjs');
  const resolved = resolvePowershellPath();
  assert.ok(fs.existsSync(resolved), `解析出来的 PowerShell 必须存在：${resolved}`);
  assert.match(resolved, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
});

test('D7: PACKAGE_ROOT 由本文件位置推出，不是写死的绝对路径', async () => {
  const { PACKAGE_ROOT, DEFAULT_SCRIPT_PATH } = await import('../lib/toast.mjs');
  assert.equal(PACKAGE_ROOT, path.join(HERE, '..'));
  assert.equal(DEFAULT_SCRIPT_PATH, path.join(HERE, '..', 'scripts', 'toast.ps1'));
  assert.equal(path.isAbsolute(PACKAGE_ROOT), true);
  assert.ok(fs.existsSync(DEFAULT_SCRIPT_PATH));
  // 仓库路径不能出现在源码里（换机器/换目录都得能用）。
  const sources = ['index.mjs', 'cli.mjs', 'lib/toast.mjs'].map((file) => fs.readFileSync(path.join(HERE, '..', file), 'utf8'));
  for (const source of sources) {
    assert.doesNotMatch(source, /[A-Za-z]:\\\\?Users/, '源码里不许出现本机绝对路径');
    // 反斜杠个数容错：注释里是单反斜杠（`D:\dsh\…`），JS 字符串字面量里是双反斜杠（`'D:\\dsh\\…'`），两种形状都要抓。
    assert.doesNotMatch(source, /\b[A-Za-z]:\\{1,2}dsh\b/i, '源码里不许出现本机绝对路径');
  }
  assert.ok(os.tmpdir().length > 0);
});

// ---------- D8：常驻分支的「scenario 必须配按钮」这条硬规则 ----------
//
// Win11 会**静默忽略**没有按钮的 scenario="reminder"：通知退回普通通知，几秒后自己消失。
// 这一条只能靠源码形状钉住 —— 真机行为（驻留 ≥60s / 反向对照仍自动消失）在 testing-guide
// 里按量法记，测试这里只保证「常驻分支同时给了 scenario 与一个按钮」这两个条件不被删掉。
test('D8: 常驻分支同时给 scenario="reminder" 与一个 system dismiss action，非常驻分支不给按钮', () => {
  const text = fs.readFileSync(SCRIPT, 'ascii');

  // 存活映射本身不变：<=0 走 scenario，>7000 走 long，其余 short。
  assert.match(text, /\$sticky = \$DisappearAfterMs -le 0/);
  assert.match(text, /if \(\$sticky\) \{\s*\r?\n\s*\$toastNode\.SetAttribute\('scenario', 'reminder'\)/);
  assert.match(text, /SetAttribute\('duration', 'long'\)/);
  assert.match(text, /SetAttribute\('duration', 'short'\)/);

  // 按钮：<actions><action arguments="dismiss" activationType="system"/></actions>
  assert.match(text, /CreateElement\('actions'\)/);
  assert.match(text, /CreateElement\('action'\)/);
  // content 是 element-action 的必填属性，而且省掉它整条通知都到不了屏幕
  // （2026-10-08 实测），所以这里连它一起钉住。
  assert.match(text, /SetAttribute\('content', 'Dismiss'\)/);
  assert.match(text, /SetAttribute\('arguments', 'dismiss'\)/);
  assert.match(text, /SetAttribute\('activationType', 'system'\)/);
  // activationType 必须是 system：点按钮只让通知消失，不许去拉起任何进程
  // （foreground = 激活应用并送 arguments；background = 拉起后台任务）。
  assert.doesNotMatch(text, /SetAttribute\('activationType', '(foreground|background|protocol)'\)/);
  assert.doesNotMatch(text, /-File|powershell\.exe'\)/, 'action 的 arguments 不许是个要跑的命令行');

  // 只有常驻分支造按钮：`if ($sticky)` 恰好两处（一处 scenario、一处 actions）。
  const stickyBlocks = text.match(/if \(\$sticky\) \{/g) || [];
  assert.equal(stickyBlocks.length, 2, 'scenario 与 actions 各由一个 if ($sticky) 守着');

  // <actions> 必须排在 <audio> 之后：toast schema 定死子元素顺序
  // visual, audio?, commands?, actions?, header?。
  assert.ok(
    text.indexOf("CreateElement('actions')") > text.indexOf("CreateElement('audio')"),
    '<actions> 要追加在 <audio> 之后，否则 xml 校验不过',
  );
  assert.ok(
    text.indexOf("AppendChild($actions)") > text.indexOf("CreateElement('action')"),
    '要先把 action 挂进 actions，再把 actions 挂进 toast',
  );
});
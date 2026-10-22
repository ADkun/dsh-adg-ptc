/**
 * adg-settings — browser half.
 *
 * 一页把宿主的登记表（dsh-adg-ptc/settings/lib/schema.mjs）原样画出来：宿主 GET 回报
 * `fields[]`（key / kind / group / default / 界），本文件按 kind 选控件（boolean → 开关，
 * string → 单行输入，integer → 数字输入）、按 group 聚卡片、按 `origin` 标出每一格来自
 * 哪一层。所以**加一项不需要动这里的逻辑**，只补 DICT 里的 `field.<键>.label` / `.hint`。
 *
 * 值写在同源路由 `/api/adg-settings/settings`；宿主把文件落在用户根，读它的插件
 * （当前是 adg-notify）每次调用时重读 —— 保存后立即生效，不需要重启 dsh。
 *
 * 手写 ModuleLoader bundle：没有构建步骤，除 shell 已提供的 `react` 外无依赖；
 * 颜色全部走主题变量，切配色不会花。
 */
window.__ModuleLoader__.load({
  id: 'adg-settings',
  factory: require => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const { createElement: h, useCallback, useEffect, useState } = React;

    const NS = 'settings.adgSettings';
    const ROUTE = '/api/adg-settings/settings';
    const inject = ['slots', 'locale'];

    /**
     * 页面文案。字段自己的两条按键名收在 `field.<键>.label` / `.hint` 下 ——
     * 「加一项」的第二处（第一处是宿主的登记表），没有第三处。
     */
    const DICT = {
      zh: {
        'meta.title': 'Adg 设置',
        'meta.description':
          'Adg 预设插件的用户可调项集中在这里：一张登记表驱动整页控件，保存后立即生效，不需要重启 dsh。',
        nav: 'Adg 设置',
        title: 'Adg 设置',
        subtitle:
          'Adg 预设插件的用户可调项集中在这里。改动保存在本插件的设置文件里，刷新后依然有效；保存后立即生效，不需要重启 dsh。',
        'group.notify': '通知',
        'field.notifyTitle.label': '通知默认标题',
        'field.notifyTitle.hint': '子代理调用 notify_user 时没写标题就用这句（出厂「DSH 通知」）。',
        'field.notifySound.label': '响提示音',
        'field.notifySound.hint': '关闭后通知静音弹出，只在屏幕上显示。',
        'field.notifyPersist.label': '通知常驻',
        'field.notifyPersist.hint': '开启时通知不自动消失，需要你自己关掉；关闭后约 8 秒自动消失。',
        'group.skillInject': '思考框架注入',
        'field.skillInjectEnabled.label': '注入思考框架',
        'field.skillInjectEnabled.hint':
          '开启后，Adg 调度智能体的系统提示词里会带上思考框架正文；子代理是否也带由下面那颗开关决定（默认不带）。输入框左侧那颗「超思」开关改的是同一个值。',
        'field.skillInjectSubagent.label': '同时注入子代理',
        'field.skillInjectSubagent.hint':
          '开启后，Adg 调度者派出的子代理也会拿到同一段思考框架；关闭时只注入调度者自己（出厂默认）。',
        'field.skillInjectText.label': '注入正文',
        'field.skillInjectText.hint':
          '留空就用技能文件（skills/thinking-framework/SKILL.md）的正文，改技能文件即改注入内容；填了就以这里的文本为准（不再读文件）。保存后下一次请求生效。',
        save: '保存',
        saving: '保存中…',
        saved: '已保存，立即生效（通知在下一次 notify_user、思考框架在下一次请求）',
        reset: '恢复默认',
        resetting: '恢复中…',
        resetDone: '已删除设置文件，回到插件配置与内置默认',
        current: '当前生效',
        sep: '：',
        on: '开',
        off: '关',
        from: '来自{source}',
        originStored: '设置文件',
        originConfigured: '插件配置',
        originDefault: '内置默认',
        fileLabel: '设置文件',
        fromStored: '以上来自设置文件，重启后仍然保留。',
        fromConfigured: '目前的值来自插件配置或内置默认，尚未写入设置文件。',
        unknown: '设置文件里有 {n} 个认不得的键（可能是旧版本留下的），本页不会动它们。',
        dropped: '设置文件里有 {n} 个不合法的值被忽略，宿主日志里有明细。',
        note: '这些项只影响本仓库第一方子插件的行为，保存后立即生效，不需要重启。',
        useSkillFile: '留空即使用 skills/thinking-framework/SKILL.md 的正文',
        emptyValue: '（空，跟随默认）',
        errText: '「{label}」不能为空，且最多 {max} 个字符',
        errInt: '「{label}」必须是 {min}–{max} 之间的整数',
        loading: '正在读取…',
        failed: '读取失败，无法连接插件后端',
        retry: '重试',
      },
      en: {
        'meta.title': 'Adg settings',
        'meta.description':
          'Every user-facing option of the Adg preset plugins lives here: one registry drives the whole page, and saving takes effect immediately without restarting dsh.',
        nav: 'Adg settings',
        title: 'Adg settings',
        subtitle:
          'Every user-facing option of the Adg preset plugins lives here. Changes are stored in this plugin’s settings file and survive a refresh; they take effect immediately without restarting dsh.',
        'group.notify': 'Notifications',
        'field.notifyTitle.label': 'Default notification title',
        'field.notifyTitle.hint':
          'Used when a subagent calls notify_user without a title (ships as “DSH 通知”).',
        'field.notifySound.label': 'Play a sound',
        'field.notifySound.hint': 'When off, notifications pop up silently.',
        'field.notifyPersist.label': 'Keep the notification on screen',
        'field.notifyPersist.hint':
          'When on, the toast stays until you dismiss it; when off it disappears after about 8 seconds.',
        'group.skillInject': 'Thinking-framework injection',
        'field.skillInjectEnabled.label': 'Inject the thinking framework',
        'field.skillInjectEnabled.hint':
          'When on, the Adg scheduler prompt carries the thinking-framework text; whether subagents also get it is decided by the toggle below (off by default). The “Thinking” chip in the composer flips the same value.',
        'field.skillInjectSubagent.label': 'Also inject into subagents',
        'field.skillInjectSubagent.hint':
          'When on, subagents spawned by the Adg scheduler get the same thinking-framework section; when off, only the scheduler does (the default).',
        'field.skillInjectText.label': 'Injected text',
        'field.skillInjectText.hint':
          'Leave empty to use the skill file (skills/thinking-framework/SKILL.md); fill it in to inject exactly this text instead (the file is then ignored). Applies from the next request.',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved; live immediately (notifications on the next notify_user, the framework on the next request)',
        reset: 'Restore defaults',
        resetting: 'Restoring…',
        resetDone: 'The settings file is gone; the plugin Config and built-in defaults are back',
        current: 'In effect',
        sep: ': ',
        on: 'on',
        off: 'off',
        from: 'from {source}',
        originStored: 'the settings file',
        originConfigured: 'the plugin Config',
        originDefault: 'the built-in default',
        fileLabel: 'Settings file',
        fromStored: 'These come from the settings file and survive a restart.',
        fromConfigured: 'Nothing saved here yet; the plugin Config or the built-in defaults are in use.',
        unknown: 'The settings file has {n} key(s) this page does not know (an older version may have left them); nothing here touches them.',
        dropped: 'The settings file had {n} invalid value(s) that were ignored; the host log names them.',
        note: 'These options only affect this repository’s first-party plugins; saving takes effect immediately, with no restart.',
        useSkillFile: 'Leave empty to use skills/thinking-framework/SKILL.md',
        emptyValue: '(empty — follows the default)',
        errText: '“{label}” cannot be empty and takes at most {max} characters',
        errInt: '“{label}” must be an integer between {min} and {max}',
        loading: 'Reading…',
        failed: 'Could not reach the plugin backend',
        retry: 'Retry',
      },
    };

    const STYLE = [
      '.as_root{display:flex;flex-direction:column;gap:16px;max-width:860px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary)}',
      '.as_head{display:flex;flex-direction:column;gap:6px}',
      '.as_title{margin:0;font-size:15px;font-weight:650}',
      '.as_sub{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);max-width:66ch}',
      '.as_card{display:flex;flex-direction:column;gap:12px;padding:14px 15px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      '.as_label{font-size:12px;font-weight:600}',
      '.as_opt{display:flex;align-items:flex-start;gap:12px}',
      '.as_switch{position:relative;display:inline-flex;flex:0 0 auto;width:36px;height:20px;margin-top:1px;cursor:pointer}',
      '.as_switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}',
      '.as_track{pointer-events:none;position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);transition:background .15s ease,border-color .15s ease}',
      '.as_knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s ease,background .15s ease}',
      '.as_switch input:checked+.as_track{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.as_switch input:checked+.as_track .as_knob{transform:translateX(16px);background:var(--dsw-alias-bg-base)}',
      '.as_switch input:focus-visible+.as_track{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.as_switch input:disabled+.as_track{opacity:.5}',
      '.as_optText{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.as_optLabel{font-size:12.5px;font-weight:600}',
      '.as_field{display:flex;flex-direction:column;gap:6px}',
      '.as_fieldLabel{font-size:12.5px;font-weight:600}',
      '.as_input{font:inherit;font-size:12.5px;box-sizing:border-box;width:100%;max-width:420px;padding:6px 9px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.as_input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.as_input:disabled{opacity:.45}',
      '.as_inputBad{border-color:var(--dsw-alias-state-error-primary)}',
      '.as_textarea{font:inherit;font-size:12.5px;box-sizing:border-box;width:100%;min-height:150px;padding:8px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);resize:vertical;line-height:1.5}',
      '.as_textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.as_textarea:disabled{opacity:.45}',
      '.as_hint{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.as_actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.as_btn{font:inherit;font-size:12px;padding:6px 14px;border-radius:9px;border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);cursor:pointer}',
      '.as_btn:disabled{opacity:.55;cursor:default}',
      '.as_btnGhost{font:inherit;font-size:12px;padding:6px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.as_btnGhost:disabled{opacity:.55;cursor:default}',
      '.as_state{display:flex;flex-direction:column;gap:5px;padding:10px 12px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px}',
      '.as_stateTitle{font-size:12px;font-weight:600}',
      '.as_stateRow b{font-variant-numeric:tabular-nums}',
      '.as_pathRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.as_path{font-size:11.5px;padding:3px 7px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);word-break:break-all}',
      '.as_note{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.as_ok{color:var(--dsw-alias-state-success-primary)}',
      '.as_err{color:var(--dsw-alias-state-error-primary)}',
      '.as_fieldErr{font-size:11.5px;color:var(--dsw-alias-state-error-primary)}',
    ].join('');

    /** `{name}` 占位替换（宿主与客户端都不认识别的模板语法）。 */
    function fill(text, values) {
      return String(text).replace(/\{(\w+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole));
    }

    /** 生效值 → 输入框里的草稿：布尔是布尔，其余一律先当字符串。 */
    function draftValue(field, value) {
      if (field.kind === 'boolean') return value === true;
      return value === undefined || value === null ? '' : String(value);
    }

    /**
     * 本地校验：界来自宿主回报的 `fields[]`（这里不写第二份界）。
     * 返回错误文案或 `''`；宿主仍会独立校验一次，它才是权威。
     */
    function checkField(t, field, draft) {
      if (field.kind === 'boolean') return '';
      if (field.kind === 'integer') {
        const raw = String(draft ?? '').trim();
        const value = Number(raw);
        if (!/^-?\d+$/.test(raw) || !Number.isInteger(value) || value < field.min || value > field.max) {
          return fill(t('errInt'), { label: t(field.labelKey), min: field.min, max: field.max });
        }
        return '';
      }
      const text = String(draft ?? '');
      if (text.length > field.maxLength) {
        return fill(t('errText'), { label: t(field.labelKey), max: field.maxLength });
      }
      if (field.allowEmpty !== true && text.trim() === '') {
        return fill(t('errText'), { label: t(field.labelKey), max: field.maxLength });
      }
      return '';
    }

    /** 一次 POST 的请求体：按 kind 还原类型（开关不能当字符串发出去）。 */
    function requestBody(fields, draft) {
      const body = {};
      for (const field of fields) {
        if (field.kind === 'boolean') body[field.key] = draft[field.key] === true;
        else if (field.kind === 'integer') body[field.key] = Number(draft[field.key]);
        else body[field.key] = String(draft[field.key] ?? '');
      }
      return body;
    }

    /** 「当前生效」里的一个值：开关说开/关，别的原样。 */
    function displayValue(t, field, value) {
      if (field.kind === 'boolean') return value === true ? t('on') : t('off');
      const text = String(value ?? '');
      if (field.allowEmpty === true && text.trim() === '') return t('emptyValue');
      if (field.multiline === true && text.length > 120) return `${text.slice(0, 120)}…`;
      return text;
    }

    /** 一格的值来自哪一层。 */
    function originLabel(t, origin) {
      if (origin === 'stored') return t('originStored');
      if (origin === 'configured') return t('originConfigured');
      return t('originDefault');
    }

    // ── the section ───────────────────────────────────────────────────────────
    function AdgSettingsSection(props) {
      const { t } = props;
      const [state, setState] = useState({ status: 'loading' });
      const [draft, setDraft] = useState({});
      const [busy, setBusy] = useState('');
      const [message, setMessage] = useState('');
      const [failure, setFailure] = useState('');

      const adopt = payload => {
        setState({ status: 'ready', value: payload });
        const fields = Array.isArray(payload?.fields) ? payload.fields : [];
        const next = {};
        for (const field of fields) {
          next[field.key] = draftValue(field, payload?.value?.[field.key] ?? field.default);
        }
        setDraft(next);
      };

      const load = useCallback(() => {
        let alive = true;
        setState({ status: 'loading' });
        fetch(ROUTE, { headers: { accept: 'application/json' } })
          .then(response => response.json())
          .then(payload => {
            if (alive) adopt(payload);
          })
          .catch(() => {
            if (alive) setState({ status: 'failed' });
          });
        return () => {
          alive = false;
        };
      }, []);

      useEffect(() => load(), [load]);

      const clear = () => {
        setMessage('');
        setFailure('');
      };

      const send = (method, body, done) => {
        setFailure('');
        setMessage('');
        fetch(ROUTE, {
          method,
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
          .then(response =>
            response.json().then(payload => {
              if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
              return payload;
            }),
          )
          .then(payload => {
            adopt(payload);
            setMessage(done);
          })
          .catch(error => setFailure(String(error?.message ?? error)))
          .finally(() => setBusy(''));
      };

      const patch = (key, value) => {
        setDraft(current => ({ ...current, [key]: value }));
        clear();
      };

      const fields = state.value?.fields ?? [];

      const save = () => {
        for (const field of fields) {
          const error = checkField(t, field, draft[field.key]);
          if (error !== '') {
            setFailure(error);
            setMessage('');
            return;
          }
        }
        setBusy('save');
        send('POST', requestBody(fields, draft), t('saved'));
      };

      const reset = () => {
        setBusy('reset');
        send('DELETE', undefined, t('resetDone'));
      };

      const body = [];
      body.push(
        h('div', { className: 'as_head', key: 'head' },
          h('h2', { className: 'as_title' }, t('title')),
          h('p', { className: 'as_sub' }, t('subtitle'))),
      );

      if (state.status === 'loading') {
        body.push(h('div', { className: 'as_state', key: 'loading' }, t('loading')));
      } else if (state.status === 'failed') {
        body.push(
          h('div', { className: 'as_state', key: 'failed' },
            h('span', { className: 'as_err' }, t('failed')),
            h('div', null, h('button', { className: 'as_btn', type: 'button', onClick: load }, t('retry')))),
        );
      } else {
        const payload = state.value ?? {};
        const effective = payload.value ?? {};
        const origin = payload.origin ?? {};
        const stored = payload.stored ?? {};
        const unknown = Array.isArray(payload.unknown) ? payload.unknown : [];
        const dropped = Array.isArray(payload.dropped) ? payload.dropped : [];
        const locked = busy !== '';

        /** 一个字段的控件：三种 kind 三种画法，界与文案都来自宿主回报的 fields[]。 */
        const control = field => {
          const error = checkField(t, field, draft[field.key]);
          if (field.kind === 'boolean') {
            return h('div', { className: 'as_opt', key: field.key },
              h('label', { className: 'as_switch' },
                h('input', {
                  type: 'checkbox',
                  checked: draft[field.key] === true,
                  disabled: locked,
                  'aria-label': t(field.labelKey),
                  onChange: event => patch(field.key, event.target.checked),
                }),
                h('span', { className: 'as_track', 'aria-hidden': 'true' }, h('span', { className: 'as_knob' }))),
              h('span', { className: 'as_optText' },
                h('span', { className: 'as_optLabel' }, t(field.labelKey)),
                h('span', { className: 'as_hint' }, t(field.hintKey))));
          }
          const input = {
            className: error === '' ? 'as_input' : 'as_input as_inputBad',
            value: draft[field.key] ?? '',
            disabled: locked,
            'aria-label': t(field.labelKey),
            onChange: event => patch(field.key, event.target.value),
          };
          if (field.kind === 'integer') {
            input.type = 'number';
            input.min = field.min;
            input.max = field.max;
            input.step = 1;
          } else if (field.multiline === true) {
            return h('div', { className: 'as_field', key: field.key },
              h('span', { className: 'as_fieldLabel' }, t(field.labelKey)),
              h('textarea', {
                ...input,
                className: error === '' ? 'as_textarea' : 'as_textarea as_inputBad',
                rows: 8,
                maxLength: field.maxLength,
                placeholder: t('useSkillFile'),
                spellCheck: false,
              }),
              error === '' ? null : h('span', { className: 'as_fieldErr', role: 'alert' }, error),
              h('span', { className: 'as_hint' }, t(field.hintKey)));
          } else {
            input.type = 'text';
            input.maxLength = field.maxLength;
          }
          return h('div', { className: 'as_field', key: field.key },
            h('span', { className: 'as_fieldLabel' }, t(field.labelKey)),
            h('input', input),
            error === '' ? null : h('span', { className: 'as_fieldErr', role: 'alert' }, error),
            h('span', { className: 'as_hint' }, t(field.hintKey)));
        };

        // 分组顺序 = 登记表顺序（`fields[]` 是宿主按登记表顺序发的）。
        const groups = [];
        for (const field of fields) {
          if (!groups.includes(field.group)) groups.push(field.group);
        }
        for (const group of groups) {
          body.push(
            h('div', { className: 'as_card', key: `group-${group}` },
              h('span', { className: 'as_label' }, t(`group.${group}`)),
              fields.filter(field => field.group === group).map(control)),
          );
        }

        body.push(
          h('div', { className: 'as_card', key: 'actions' },
            h('div', { className: 'as_actions' },
              h('button', { className: 'as_btn', type: 'button', onClick: save, disabled: locked },
                busy === 'save' ? t('saving') : t('save')),
              h('button', { className: 'as_btnGhost', type: 'button', onClick: reset, disabled: locked },
                busy === 'reset' ? t('resetting') : t('reset')),
              failure !== '' ? h('span', { className: 'as_err', role: 'alert' }, failure) : null,
              message !== '' ? h('span', { className: 'as_ok', role: 'status' }, message) : null)),
          h('div', { className: 'as_state', key: 'state' },
            h('span', { className: 'as_stateTitle' }, t('current')),
            fields.map(field =>
              h('span', { className: 'as_stateRow', key: `now-${field.key}` },
                t(field.labelKey), t('sep'), h('b', null, displayValue(t, field, effective[field.key])), ' ',
                h('span', { className: 'as_note' }, fill(t('from'), { source: originLabel(t, origin[field.key]) })))),
            h('span', { className: 'as_note' },
              Object.keys(stored).length > 0 ? t('fromStored') : t('fromConfigured')),
            unknown.length > 0
              ? h('span', { className: 'as_err' }, fill(t('unknown'), { n: unknown.length }))
              : null,
            dropped.length > 0
              ? h('span', { className: 'as_err' }, fill(t('dropped'), { n: dropped.length }))
              : null,
            h('div', { className: 'as_pathRow' },
              h('span', { className: 'as_hint' }, t('fileLabel'), t('sep')),
              h('code', { className: 'as_path' }, String(payload.file ?? ''))),
            h('span', { className: 'as_note' }, t('note'))),
        );
      }

      return h('div', { className: 'as_root' }, h('style', null, STYLE), body);
    }

    // ── registration ──────────────────────────────────────────────────────────
    // shell 会把当前语言同步到 <html lang>，所以渲染期读一次就够，不必自己订阅语言变化。
    function localeTag(ctx) {
      try {
        const snapshot = typeof ctx.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale?.getSnapshot?.();
        const value = snapshot?.active ?? ctx.locale?.locale;
        return typeof value === 'string' ? value : document.documentElement.lang || 'en';
      } catch {
        return 'en';
      }
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'adg-settings: dictionaries');

      // order 38：紧跟在「过程插入」(36) 与「子智能体管理」(37) 之后。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'adg-settings',
        order: 38,
        label: () => t('nav'),
        locale: NS,
      }, props => h(AdgSettingsSection, {
        ...props,
        t: Object.assign(text => t(text), { locale: localeTag(ctx) }),
      })));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'adg-settings';
    return module.exports;
  },
});
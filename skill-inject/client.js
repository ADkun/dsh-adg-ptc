/**
 * adg-skill-inject — browser half.
 *
 * 只做一件事：在聊天输入框的工具行里放一个「超思」开关（`conversation.input.left`），
 * 控制思考框架是否注入 Adg 调度者的系统提示词。
 *
 * 它读写的是 adg-settings 那一页的同源路由 `/api/adg-settings/settings`（键 `skillInjectEnabled`）
 * —— 两个插件包各自独立，**不 import 对方**：设置文件 + 这条路由就是全部契约。所以开关一按，
 * 下一次请求的组装就换了正文（宿主侧每次组装都重读设置文件），不需要重启 dsh。
 *
 * 手写 ModuleLoader bundle：没有构建步骤，除 shell 已提供的 `react` 外无依赖；
 * 颜色全部走主题变量，切配色不会花。
 */
window.__ModuleLoader__.load({
  id: 'adg-skill-inject',
  factory: require => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const { createElement: h, useCallback, useEffect, useRef, useState } = React;

    const NS = 'settings.adgSkillInject';
    const ROUTE = '/api/adg-settings/settings';
    const KEY = 'skillInjectEnabled';
    const inject = ['slots', 'locale'];

    /** 开关文案。 */
    const DICT = {
      zh: {
        on: '超思 开',
        off: '超思 关',
        ariaEnable: '开启思考框架注入',
        ariaDisable: '关闭思考框架注入',
        ariaLoading: '思考框架注入（读取中）',
        titleEnable: '开启中：Adg 调度者的系统提示词里带着思考框架正文。点击关闭。',
        titleDisable: '已关闭：不再注入思考框架正文。点击开启。',
      },
      en: {
        on: 'Thinking on',
        off: 'Thinking off',
        ariaEnable: 'Turn the thinking framework on',
        ariaDisable: 'Turn the thinking framework off',
        ariaLoading: 'Thinking framework (loading)',
        titleEnable: 'On: the Adg scheduler prompt carries the thinking framework. Click to turn it off.',
        titleDisable: 'Off: the thinking framework is not injected. Click to turn it on.',
      },
    };

    const STYLE = [
      '.asj_chip{display:inline-flex;align-items:center;gap:4px;flex:none;height:28px;padding:0 8px 0 6px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:28px;white-space:nowrap;cursor:pointer;transition:color 120ms ease,background-color 120ms ease}',
      '.asj_chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.asj_chip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
      '.asj_chip:disabled{opacity:.5;cursor:not-allowed}',
      '.asj_chip[data-state="active"]{color:var(--dsw-alias-state-success-primary)}',
      '.asj_dot{display:inline-block;width:6px;height:6px;flex:none;border-radius:999px;background:var(--dsw-alias-label-tertiary)}',
      '.asj_dot[data-state="active"]{background:var(--dsw-alias-state-success-primary)}',
      '.asj_dot[data-state="pending"]{background:var(--dsw-alias-state-business-primary)}',
      '@media (prefers-reduced-motion: reduce){.asj_chip{transition:none}}',
    ].join('');

    /** 样式表只插一次；tag id 同时充当重复求值的守卫。 */
    function ensureStyles() {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin="adg-skill-inject"]') !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'adg-skill-inject';
      tag.textContent = STYLE;
      document.head.appendChild(tag);
    }

    /** 工具行里的开关：读同源设置、按一下写回、宿主下一次组装就换正文。 */
    function SkillInjectDock(props) {
      const { t } = props;
      const [state, setState] = useState({ status: 'loading' });
      const [busy, setBusy] = useState(false);
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const adopt = payload => {
        if (!alive.current) return;
        setState({ status: 'ready', enabled: payload?.value?.[KEY] === true });
      };

      const load = useCallback(() => {
        setState({ status: 'loading' });
        fetch(ROUTE, { headers: { accept: 'application/json' } })
          .then(response => response.json())
          .then(payload => adopt(payload))
          .catch(() => {
            if (alive.current) setState({ status: 'failed' });
          });
      }, []);

      useEffect(() => load(), [load]);

      const toggle = () => {
        if (state.status !== 'ready' || busy) return;
        setBusy(true);
        fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ [KEY]: !state.enabled }),
        })
          .then(response =>
            response.json().then(payload => {
              if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
              return payload;
            }),
          )
          .then(payload => adopt(payload))
          .catch(() => {
            if (alive.current) setState({ status: 'failed' });
          })
          .finally(() => {
            if (alive.current) setBusy(false);
          });
      };

      const ready = state.status === 'ready';
      const enabled = ready && state.enabled === true;
      const chipState = !ready ? 'pending' : enabled ? 'active' : 'off';
      const label = t(!ready ? 'ariaLoading' : enabled ? 'on' : 'off');
      const aria = t(!ready ? 'ariaLoading' : enabled ? 'ariaDisable' : 'ariaEnable');
      const title = t(!ready ? 'ariaLoading' : enabled ? 'titleEnable' : 'titleDisable');

      return h('button', {
        type: 'button',
        className: 'asj_chip',
        'data-state': chipState,
        'aria-pressed': enabled,
        'aria-label': aria,
        title,
        disabled: !ready || busy,
        onClick: toggle,
      },
        h('span', { className: 'asj_dot', 'data-state': chipState }),
        h('span', null, label),
      );
    }

    function apply(ctx) {
      ensureStyles();
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'adg-skill-inject: dictionaries');

      // order 21：紧跟在破限模式那颗 chip（20）之后 —— 列表槽按 order 升序排，不重叠。
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'adg-skill-inject-toggle',
        order: 21,
        locale: NS,
      }, props => h(SkillInjectDock, { ...props, t })));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'adg-skill-inject';
    return module.exports;
  },
});

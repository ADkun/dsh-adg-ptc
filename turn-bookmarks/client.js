/**
 * adg-turn-bookmarks — 浏览器半边。
 *
 * 做两件事，都不改动 dsh 自己的 UI 结构：
 *   1. 在每轮回答末尾的尾部槽（conversation.chat.turnTail）放一颗 ☆：点一下收藏，
 *      再点一下取消。收藏状态来自本会话的 sidecar（宿主半边那条路由）。
 *      目录栏的刻度条上**右键**也是同一个开关（左键仍是 dsh 原生跳转）。
 *   2. 一个 DOM"上色器"：把被收藏的轮次在右侧目录栏（TurnNavigator）的轨道条上染成粉色，
 *      并在正文里那一轮的提问行左侧加一道粉色标记。轨道条本身就是按钮，点击即原生跳转
 *      （已加载的直接滚过去，未加载的由 dsh 自己翻页）—— 本插件不另造跳转。
 *
 * 为什么上色要靠 DOM 属性而不是改 dsh 的组件：TurnNavigator 由 ChatView 直接渲染、不经过任何
 * slot，第三方无法往里插元素。所以只在它已有的 <button data-index> 上加一个 data-adg-tb 属性，
 * 用 CSS 覆盖伪元素的颜色 —— 类名哈希每版都会变，属性名不会。
 *
 * 颜色一律走主题变量，只有"重点粉"是常量（用户点名要粉色）。
 */
window.__ModuleLoader__.load({
  id: 'adg-turn-bookmarks',
  factory: require => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const { createElement: h, useEffect, useState } = React;

    const NS = 'adg.turnBookmarks';
    const ROUTE = '/api/adg-turn-bookmarks';
    const inject = ['slots', 'locale'];
    /** 重点色：用户点名要的粉色。 */
    const PINK = '#ff5c9d';

    /** 按钮文案。 */
    const DICT = {
      zh: {
        add: '收藏这一轮（右侧目录栏会标成粉色）',
        remove: '取消收藏这一轮',
      },
      en: {
        add: 'Bookmark this turn (the rail mark turns pink)',
        remove: 'Remove this bookmark',
      },
    };

    const STYLE = [
      '[data-turn-tail]{position:relative!important;flex-direction:column!important;align-items:stretch!important;gap:16px!important}',
      '[data-turn-tail][data-actions-reveal] .atb_star{position:absolute!important;inset-inline-start:0!important;bottom:0!important}',
      '[data-turn-tail][data-actions-reveal]:has(.atb_star)>*:last-child{margin-inline-start:calc(36px + var(--dsh-content-font-delta,0px))!important}',
      '.atb_star{display:inline-flex;align-items:center;justify-content:center;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:calc(16px + var(--dsh-content-font-delta,0px));line-height:1;cursor:pointer;transition:color 120ms ease,background-color 120ms ease}',
      '.atb_star:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.atb_star[data-on="1"]{color:' + PINK + '}',
      '.atb_star:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
      'button[data-index][data-adg-tb="1"]:before{background:' + PINK + ' !important;opacity:1 !important;transform:translateY(-50%) scaleX(1) !important}',
      '[data-chat-turn][data-chat-flow-kind="user"][data-adg-tb="1"]{box-shadow:inset 3px 0 0 0 ' + PINK + '}',
      '@media (prefers-reduced-motion: reduce){.atb_star{transition:none}}',
    ].join('');

    /** 插入样式表并返回卸载函数；tag 的 data-plugin 同时充当重复求值的守卫（热重载时不叠第二份）。 */
    function addStyles() {
      if (typeof document === 'undefined') return () => {};
      if (document.querySelector('style[data-plugin="adg-turn-bookmarks"]') !== null) return () => {};
      const tag = document.createElement('style');
      tag.dataset.plugin = 'adg-turn-bookmarks';
      tag.textContent = STYLE;
      document.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    }

    /** sessionId -> { turns:Set<number>, loaded, loading, subs:Set<Function> } */
    const sessions = new Map();

    function slotOf(sessionId) {
      let slot = sessions.get(sessionId);
      if (slot === undefined) {
        slot = { turns: new Set(), loaded: false, loading: null, subs: new Set() };
        sessions.set(sessionId, slot);
      }
      return slot;
    }

    function notify(sessionId) {
      const slot = sessions.get(sessionId);
      if (slot === undefined) return;
      for (const listener of Array.from(slot.subs)) {
        try {
          listener();
        } catch {
          // 单个订阅者出错不连累别的
        }
      }
    }

    /**
     * 客户端只做一次轻量清洗用于渲染；真正的校验在宿主 lib/bookmarks.mjs（回包还会覆盖一遍）。
     */
    function cleanTurns(raw) {
      const out = [];
      if (!Array.isArray(raw)) return out;
      for (const value of raw) {
        if (typeof value !== 'number') continue;
        if (!Number.isInteger(value) || value < 0) continue;
        if (!out.includes(value)) out.push(value);
      }
      return out;
    }

    function routeFor(sessionId) {
      return ROUTE + '/' + encodeURIComponent(sessionId);
    }

    function ensureLoaded(sessionId) {
      const slot = slotOf(sessionId);
      if (slot.loaded) return Promise.resolve();
      if (slot.loading !== null) return slot.loading;
      slot.loading = fetch(routeFor(sessionId), { headers: { accept: 'application/json' } })
        .then(response => response.json())
        .then(payload => {
          slot.turns = new Set(cleanTurns(payload === null || payload === undefined ? [] : payload.turns));
          slot.loaded = true;
        })
        .catch(error => {
          console.warn('[adg-turn-bookmarks] 读取书签失败：', error);
        })
        .finally(() => {
          slot.loading = null;
          notify(sessionId);
          schedulePaint();
        });
      return slot.loading;
    }

    function toggle(sessionId, turn) {
      const slot = slotOf(sessionId);
      const before = new Set(slot.turns);
      if (slot.turns.has(turn)) slot.turns.delete(turn);
      else slot.turns.add(turn);
      notify(sessionId);
      schedulePaint();
      const payload = Array.from(slot.turns).sort((left, right) => left - right);
      fetch(routeFor(sessionId), {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ turns: payload }),
      })
        .then(response =>
          response.json().then(body => {
            if (!response.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + response.status);
            return body;
          }),
        )
        .then(body => {
          slot.turns = new Set(cleanTurns(body === null || body === undefined ? [] : body.turns));
          slot.loaded = true;
          notify(sessionId);
          schedulePaint();
        })
        .catch(error => {
          slot.turns = before;
          notify(sessionId);
          schedulePaint();
          console.warn('[adg-turn-bookmarks] 保存书签失败：', error);
        });
    }

    /** 上色器的共享状态：当前会话 + 轨道下标到轮次的映射。 */
    const view = { sessionId: null, railTurns: [] };
    const frame = { pending: false, last: 0 };

    /**
     * 流式输出时 body 每帧都在变，按 rAF 合并之外再加一个最小间隔（80ms），
     * 免得长会话里每帧都全文档扫一遍按钮和提问行。
     */
    const MIN_PAINT_INTERVAL_MS = 80;
    function schedulePaint() {
      if (frame.pending) return;
      frame.pending = true;
      const elapsed = Date.now() - frame.last;
      const wait = elapsed >= MIN_PAINT_INTERVAL_MS ? 0 : MIN_PAINT_INTERVAL_MS - elapsed;
      const run = () => {
        frame.pending = false;
        frame.last = Date.now();
        paint();
      };
      if (wait === 0 && typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else setTimeout(run, wait === 0 ? 16 : wait);
    }

    /**
     * 轨道条下标 -> 轮次。dsh 的目录栏 items = 已加载轮次 ∪ turnOutline，按 turn 升序；
     * turnOutline 覆盖整条日志的每一轮，所以只取它就足够对齐下标。
     */
    function computeRailTurns(outline) {
      const turns = new Set();
      if (Array.isArray(outline)) {
        for (const entry of outline) {
          const value = entry === null || entry === undefined ? undefined : entry.turn;
          if (typeof value === 'number' && Number.isInteger(value) && value >= 0) turns.add(value);
        }
      }
      return Array.from(turns).sort((left, right) => left - right);
    }

    /** 兜底：从 aria-label（「跳转到第 3 轮」/「Jump to turn 3」）里取第一个数字。 */
    function turnFromLabel(element) {
      const label = element.getAttribute('aria-label');
      if (typeof label !== 'string') return null;
      const found = label.match(/[0-9]+/);
      if (found === null) return null;
      const value = Number(found[0]);
      return Number.isInteger(value) && value >= 0 ? value : null;
    }

    function applyAttr(element, on) {
      if (on) {
        if (element.getAttribute('data-adg-tb') !== '1') element.setAttribute('data-adg-tb', '1');
      } else if (element.hasAttribute('data-adg-tb')) {
        element.removeAttribute('data-adg-tb');
      }
    }

    /** 一个刻度按钮对应的轮次号：优先 aria-label，回退 turnOutline 下标（见 R5）。 */
    function turnForButton(button) {
      const index = Number(button.getAttribute('data-index'));
      const mapped = Number.isInteger(index) && index >= 0 && index < view.railTurns.length ? view.railTurns[index] : null;
      const fromLabel = turnFromLabel(button);
      return fromLabel === null ? mapped : fromLabel;
    }

    function paint() {
      if (typeof document === 'undefined') return;
      const slot = view.sessionId === null ? undefined : sessions.get(view.sessionId);
      const marked = slot === undefined ? new Set() : slot.turns;
      // 目录栏刻度就是唯一的 button[data-index]（全应用 grep 只有它），再用 aria-label 里的
      // "turn/轮" 认一遍，避免将来别处出现同属性按钮被误染。轮次号**优先从 aria-label 读**：
      // 它不依赖"下标与 outline 对齐"，流式新轮次让 outline 短暂落后时也不会染错一格。
      for (const button of document.querySelectorAll('button[data-index]')) {
        const label = button.getAttribute('aria-label');
        if (typeof label !== 'string' || !/turn|轮/i.test(label)) continue;
        const turn = turnForButton(button);
        applyAttr(button, turn !== null && marked.has(turn));
      }
      const rows = document.querySelectorAll('[data-chat-turn][data-chat-flow-kind="user"]');
      for (const row of rows) {
        const turn = Number(row.getAttribute('data-chat-turn'));
        applyAttr(row, Number.isInteger(turn) && marked.has(turn));
      }
    }

    /** 启动上色器并返回卸载函数（观察器、监听器、帧回调全部回收）。 */
    function startPainter() {
      if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return () => {};
      const observer = new MutationObserver(() => {
        schedulePaint();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const repaint = () => {
        schedulePaint();
      };
      document.addEventListener('scroll', repaint, true);
      window.addEventListener('resize', repaint);
      /**
       * 右键刻度 = 收藏/取消（左键仍走 dsh 原生跳转，本插件绝不拦 click）。
       * 捕获阶段接住，先 preventDefault 免得弹浏览器菜单；认不出刻度就原样放行。
       */
      const onContextMenu = event => {
        const target = event.target;
        if (target === null || typeof target.closest !== 'function') return;
        const button = target.closest('button[data-index]');
        if (button === null) return;
        const label = button.getAttribute('aria-label');
        if (typeof label !== 'string' || !/turn|轮/i.test(label)) return;
        if (view.sessionId === null || view.sessionId === undefined) return;
        const turn = turnForButton(button);
        if (turn === null) return;
        event.preventDefault();
        event.stopPropagation();
        toggle(view.sessionId, turn);
      };
      document.addEventListener('contextmenu', onContextMenu, true);
      schedulePaint();
      return () => {
        observer.disconnect();
        document.removeEventListener('scroll', repaint, true);
        document.removeEventListener('contextmenu', onContextMenu, true);
        window.removeEventListener('resize', repaint);
        // 卸载时把自己打上的标记全部收回，别在宿主 DOM 上留孤儿属性。
        for (const element of document.querySelectorAll('[data-adg-tb]')) {
          element.removeAttribute('data-adg-tb');
        }
      };
    }

    /** 每轮回答末尾的一颗星。 */
    function TurnBookmarkStar(props) {
      const { turn, sessionId, t } = props;
      const hasTurn = turn !== null && turn !== undefined && typeof turn.turn === 'number';
      const turnNo = hasTurn ? turn.turn : null;
      const isOpen = turn !== null && turn !== undefined && turn.status === 'open';
      const [, bump] = useState(0);

      // 会话作用域槽会补齐 useProjection；万一没给，退化成"只上正文色、不染轨道"。
      const useProjection = typeof props.useProjection === 'function' ? props.useProjection : () => undefined;

      useEffect(() => {
        if (sessionId === null || sessionId === undefined) return undefined;
        const slot = slotOf(sessionId);
        const listener = () => bump(value => value + 1);
        slot.subs.add(listener);
        return () => {
          slot.subs.delete(listener);
        };
      }, [sessionId]);

      useEffect(() => {
        if (sessionId === null || sessionId === undefined) return;
        view.sessionId = sessionId;
        ensureLoaded(sessionId);
        schedulePaint();
      }, [sessionId]);

      const outline = useProjection('turnOutline');
      useEffect(() => {
        view.railTurns = computeRailTurns(outline);
        schedulePaint();
      }, [outline]);

      if (turnNo === null || isOpen) return null;
      const marked = sessionId !== null && sessionId !== undefined && slotOf(sessionId).turns.has(turnNo);
      const label = t(marked ? 'remove' : 'add');
      return h(
        'button',
        {
          type: 'button',
          className: 'atb_star',
          'data-on': marked ? '1' : '0',
          'aria-pressed': marked,
          'aria-label': label,
          title: label,
          onClick: () => {
            if (sessionId === null || sessionId === undefined) return;
            toggle(sessionId, turnNo);
          },
        },
        h('span', { 'aria-hidden': 'true' }, marked ? '★' : '☆'),
      );
    }

    function apply(ctx) {
      ctx.effect(() => addStyles(), 'adg-turn-bookmarks: styles');
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'adg-turn-bookmarks: dictionaries');

      ctx.slots.inject('conversation.chat.turnTail', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.turnTail',
            id: 'adg-turn-bookmarks-star',
            order: 10,
            locale: NS,
          },
          props => h(TurnBookmarkStar, { ...props, t }),
        ),
      );

      ctx.effect(() => startPainter(), 'adg-turn-bookmarks: rail painter');
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'adg-turn-bookmarks';
    return module.exports;
  },
});

window.__ModuleLoader__.load({
  id: '@mosire/dshom',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'timing-annotations';

    const DICTS = {
      zh: {
        started: '开始',
        took: '用时',
        thinking: '思考',
        turn: '本轮',
        tool: '工具',
      },
      en: {
        started: 'Started',
        took: 'Took',
        thinking: 'Thinking',
        turn: 'Turn',
        tool: 'Tool',
      },
    };

    const GC_NS = 'goal-confirm';

    const GC_DICTS = {
      zh: {
        label: '续轮确认',
        title: 'Goal 自动续轮确认门（仅本会话）',
        'state.inherit': '默认',
        'state.on': '开',
        'state.wait': '等待',
        'state.off': '关',
        'opt.inherit': '默认（跟随全局）',
        'opt.on': '开启确认门',
        'opt.wait': '等待人工确认',
        'opt.off': '本会话关闭',
        'menu.label': '本会话续轮确认',
        error: '设置失败',
      },
      en: {
        label: 'Goal gate',
        title: 'Goal round confirmation gate (this session only)',
        'state.inherit': 'Default',
        'state.on': 'On',
        'state.wait': 'Wait',
        'state.off': 'Off',
        'opt.inherit': 'Default (follow profile)',
        'opt.on': 'Enable the gate',
        'opt.wait': 'Wait for a human',
        'opt.off': 'Disable for this session',
        'menu.label': 'Goal confirmation gate for this session',
        error: 'Could not change it',
      },
    };

    const CSS = [
      '.mosire-timing{display:inline-flex;align-items:center;white-space:nowrap;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;user-select:none;margin-left:auto;padding:0 2px}',
      '.mosire-timing-tail{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:baseline;gap:4px 12px;box-sizing:border-box;width:100%;margin-top:8px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;user-select:none;text-align:right}',
      '.mosire-timing-tail-title{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.mosire-timing-tail-item,.mosire-timing-tail-more{white-space:nowrap}',
      '.mosire-timing-tail-item b{font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.mosire-timing-live{position:fixed;z-index:40;pointer-events:none;white-space:nowrap;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;user-select:none;padding:0 6px;border-radius:6px;background:color-mix(in srgb, var(--dsw-alias-bg-base) 88%, transparent);box-shadow:0 0 0 1px var(--dsw-alias-border-l1)}',
      '.mosire-goal-confirm{display:inline-flex;align-items:center;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);user-select:none}',
      '.mosire-goal-confirm-btn{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;padding:0 4px;border-radius:6px;color:inherit;font:inherit;font-size:11px;line-height:18px;cursor:pointer}',
      '.mosire-goal-confirm-btn:hover{background:color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent)}',
      '.mosire-goal-confirm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.mosire-goal-confirm-btn[disabled]{opacity:.6;cursor:default}',
      '.mosire-goal-confirm-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
      '.mosire-goal-confirm[data-state="on"] .mosire-goal-confirm-dot{background:var(--dsw-alias-state-success-primary)}',
      '.mosire-goal-confirm[data-state="wait"] .mosire-goal-confirm-dot{background:var(--dsw-alias-state-warn-primary)}',
      '.mosire-goal-confirm[data-state="off"] .mosire-goal-confirm-dot{background:var(--dsw-alias-state-idle-primary);opacity:.5}',
      '.mosire-goal-confirm-menu{position:fixed;z-index:60;display:flex;flex-direction:column;gap:2px;padding:4px;border-radius:8px;background:var(--dsw-alias-bg-overlay);box-shadow:0 0 0 1px var(--dsw-alias-border-l1),0 8px 24px rgba(0,0,0,.18)}',
      '.mosire-goal-confirm-item{border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px;text-align:left;white-space:nowrap;padding:4px 10px;border-radius:6px;cursor:pointer}',
      '.mosire-goal-confirm-item:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)}',
      '.mosire-goal-confirm-item[aria-checked="true"]{color:var(--dsw-alias-brand-primary)}',
      '.mosire-goal-confirm-error{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:18px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    ].join('');

    const styleTag = () => h('style', null, CSS);
    const pad2 = (value) => String(value).padStart(2, '0');

    /** Local clock, 24-hour, at minute precision. */
    function formatClock(ms) {
      const date = new Date(ms);
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    /** Compact duration: 45.2s under a minute, 2m42s from there on. */
    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
      const seconds = ms / 1000;
      if (seconds < 60) return `${(Math.round(seconds * 10) / 10).toFixed(1)}s`;
      const whole = Math.round(seconds);
      return `${Math.floor(whole / 60)}m${pad2(whole % 60)}s`;
    }

    /** Start and duration of one finalized assistant step, from its recorded timing. */
    function assistantSpan(node) {
      if (node === null || typeof node !== 'object') return null;
      const timing = node.timing;
      const start = timing && typeof timing.stepStartTime === 'number'
        ? timing.stepStartTime
        : typeof node.time === 'number' ? node.time : null;
      if (start === null) return null;
      const end = timing && typeof timing.completedTime === 'number' ? timing.completedTime : null;
      const duration = typeof end === 'number' && end > start ? end - start : null;
      return { start, duration };
    }

    /** Latest assistant node with this durable message id. */
    function findAssistantNode(nodes, messageId) {
      if (!Array.isArray(nodes) || typeof messageId !== 'string' || messageId === '') return undefined;
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index];
        if (node !== null && typeof node === 'object' && node.kind === 'assistant' && node.messageId === messageId) return node;
      }
      return undefined;
    }

    /** Right-aligned line beside one finalized assistant message. */
    function AssistantTiming(props) {
      const useChat = props.useChat;
      const messageId = props.messageId;
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const legacy = useChat((snapshot) => (snapshot !== null && typeof snapshot === 'object' ? snapshot.legacy : undefined));
      const nodes = legacy !== null && typeof legacy === 'object' && Array.isArray(legacy.nodes) ? legacy.nodes : [];
      const node = findAssistantNode(nodes, messageId);
      const span = node === undefined ? null : assistantSpan(node);
      if (span === null) return null;
      const duration = formatDuration(span.duration);
      const text = `${t('started')} ${formatClock(span.start)}${duration === null ? '' : ` · ${t('took')} ${duration}`}`;
      return h(React.Fragment, null, styleTag(), h('span', {
        className: 'mosire-timing',
        title: text,
        'aria-label': text,
      }, text));
    }

    /** Right-aligned per-turn line: every thinking step and tool call with start/duration. */
    function TurnTiming(props) {
      const useChat = props.useChat;
      const turn = props.turn;
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const legacy = useChat((snapshot) => (snapshot !== null && typeof snapshot === 'object' ? snapshot.legacy : undefined));
      const nodes = legacy !== null && typeof legacy === 'object' && Array.isArray(legacy.nodes) ? legacy.nodes : [];
      const turnNo = turn !== null && typeof turn === 'object' && typeof turn.turn === 'number' ? turn.turn : null;
      if (turnNo === null) return null;
      const turnStart = typeof turn.start?.time === 'number' ? turn.start.time : null;
      const turnEnd = typeof turn.end?.time === 'number' ? turn.end.time : null;
      const items = [];
      for (const node of nodes) {
        if (node === null || typeof node !== 'object') continue;
        if (node.kind === 'assistant' && node.turn === turnNo) {
          const span = assistantSpan(node);
          if (span !== null) items.push({ at: span.start, label: t('thinking'), start: span.start, duration: span.duration });
          continue;
        }
        if (node.kind !== 'tool-result' || typeof node.callTime !== 'number' || typeof node.time !== 'number') continue;
        if (turnStart !== null && node.callTime < turnStart) continue;
        if (turnEnd !== null && node.callTime > turnEnd) continue;
        items.push({
          at: node.callTime,
          label: typeof node.name === 'string' && node.name !== '' ? node.name : t('tool'),
          start: node.callTime,
          duration: Math.max(0, node.time - node.callTime),
        });
      }
      if (items.length === 0) return null;
      items.sort((left, right) => left.at - right.at);
      const first = turnStart !== null ? turnStart : items[0].start;
      const lastItem = items[items.length - 1];
      const last = turnEnd !== null ? turnEnd : lastItem.start + (lastItem.duration ?? 0);
      const total = formatDuration(last - first);
      const LIMIT = 12;
      const shown = items.length > LIMIT ? items.slice(-LIMIT) : items;
      const hidden = items.length - shown.length;
      const children = [];
      children.push(h('span', { key: 'title', className: 'mosire-timing-tail-title' },
        `${t('turn')} ${formatClock(first)}–${formatClock(last)}${total === null ? '' : ` · ${total}`}`));
      if (hidden > 0) children.push(h('span', { key: 'more', className: 'mosire-timing-tail-more' }, `+${hidden}`));
      shown.forEach((item, index) => {
        const duration = formatDuration(item.duration);
        children.push(h('span', { key: `item-${index}`, className: 'mosire-timing-tail-item' },
          h('b', null, item.label), ` ${formatClock(item.start)}${duration === null ? '' : ` · ${duration}`}`));
      });
      return h(React.Fragment, null, styleTag(), h('div', { className: 'mosire-timing-tail' }, children));
    }

    /** Start of a still-running Chat node, from its recorded location when possible. */
    function runningStart(node, fallback, seen) {
      const location = node.location;
      const stepStart = location && location.step && location.step.start && typeof location.step.start.time === 'number'
        ? location.step.start.time : null;
      if (stepStart !== null) return stepStart;
      const turnStart = location && location.turn && location.turn.start && typeof location.turn.start.time === 'number'
        ? location.turn.start.time : null;
      if (turnStart !== null) return turnStart;
      if (fallback !== null) return fallback;
      const previous = seen.get(node.key);
      if (previous !== undefined) return previous;
      seen.set(node.key, Date.now());
      return Date.now();
    }

    /**
     * Live overlay: while a tool call or an assistant step is still running, pin
     * `开始 HH:MM · 已用 XmYYs` to the right edge of that row. Chat exposes no
     * additive slot inside a running row, so this component (mounted in the
     * composer dock, one per Session) measures the row DOM and renders its own
     * fixed-position labels; it never mutates the measured DOM. Labels disappear
     * when the row settles; the post-run annotations above take over then.
     */
    function LiveTiming(props) {
      const useChat = props.useChat;
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const snapshot = useChat((value) => value);
      const snapshotRef = React.useRef(snapshot);
      snapshotRef.current = snapshot;
      const translateRef = React.useRef(t);
      translateRef.current = t;
      const seenRef = React.useRef(new Map());
      const [labels, setLabels] = React.useState([]);

      React.useEffect(() => {
        let disposed = false;
        const update = () => {
          if (disposed) return;
          const current = snapshotRef.current;
          const running = new Map();
          const now = Date.now();
          if (current !== null && typeof current === 'object' && current.nodes && typeof current.nodes.values === 'function') {
            const translate = translateRef.current;
            for (const node of current.nodes.values()) {
              if (node === null || typeof node !== 'object' || node.visibility === 'hidden') continue;
              const key = node.key;
              if (typeof key !== 'string') continue;
              if (node.kind === 'tool-call') {
                const root = node.data && node.data.root;
                if (root !== null && typeof root === 'object' && typeof root.phase === 'string' && typeof root.time === 'number') {
                  running.set(key, { label: typeof root.name === 'string' && root.name !== '' ? root.name : translate('tool'), start: root.time });
                }
                continue;
              }
              if (node.kind !== 'assistant-step') continue;
              const data = node.data;
              if (data === null || typeof data !== 'object' || data.status !== 'running') continue;
              running.set(key, { label: translate('thinking'), start: runningStart(node, null, seenRef.current) });
            }
          }
          for (const key of [...seenRef.current.keys()]) if (!running.has(key)) seenRef.current.delete(key);
          if (running.size === 0) {
            setLabels((previous) => (previous.length === 0 ? previous : []));
            return;
          }
          const flow = document.querySelector('[data-chat-flow]');
          const flowRect = flow && typeof flow.getBoundingClientRect === 'function' ? flow.getBoundingClientRect() : null;
          const rightEdge = flowRect !== null && flowRect.width > 0 ? flowRect.right - 4 : window.innerWidth - 16;
          const rows = document.querySelectorAll('[data-chat-node-key]');
          const next = [];
          const seenKeys = new Set();
          for (const row of rows) {
            const key = row.getAttribute('data-chat-node-key');
            if (key === null || seenKeys.has(key)) continue;
            const info = running.get(key);
            if (info === undefined) continue;
            const rect = row.getBoundingClientRect();
            if (rect.height < 4 || rect.bottom < 0 || rect.top > window.innerHeight) continue;
            seenKeys.add(key);
            const elapsed = formatDuration(Math.max(0, now - info.start));
            const text = `${translateRef.current('started')} ${formatClock(info.start)}${elapsed === null ? '' : ` · ${elapsed}`}`;
            const top = rect.top + Math.max(0, Math.min(rect.height - 18, (rect.height - 18) / 2));
            next.push({ key, text, top, right: rightEdge });
          }
          setLabels((previous) => {
            if (previous.length === next.length && previous.every((item, index) => {
              const other = next[index];
              return other !== undefined
                && item.key === other.key
                && item.text === other.text
                && Math.abs(item.top - other.top) < 0.5
                && Math.abs(item.right - other.right) < 0.5;
            })) return previous;
            return next;
          });
        };
        update();
        const interval = window.setInterval(update, 500);
        const onViewport = () => update();
        window.addEventListener('scroll', onViewport, true);
        window.addEventListener('resize', onViewport);
        return () => {
          disposed = true;
          window.clearInterval(interval);
          window.removeEventListener('scroll', onViewport, true);
          window.removeEventListener('resize', onViewport);
        };
      }, []);

      if (labels.length === 0) return null;
      return h(React.Fragment, null, styleTag(), labels.map((label) => h('span', {
        key: `live-${label.key}`,
        className: 'mosire-timing-live',
        style: { top: `${label.top}px`, left: `${label.right}px`, transform: 'translateX(-100%)' },
      }, label.text)));
    }

    /**
     * Effective gate state from the projection wire value and profile defaults.
     * A missing projection reads as "follow the profile" with the shipped
     * defaults, so the control renders before the first frame arrives.
     */
    function goalConfirmSnapshot(raw) {
      const value = raw !== null && typeof raw === 'object' ? raw : {};
      const global = value.global !== null && typeof value.global === 'object'
        ? value.global
        : { enabled: true, timeoutSeconds: 30 };
      const overrideEnabled = value.enabled === true || value.enabled === false ? value.enabled : null;
      const overrideTimeout = Number.isInteger(value.timeoutSeconds) ? value.timeoutSeconds : null;
      const enabled = overrideEnabled ?? global.enabled;
      const timeoutSeconds = overrideTimeout ?? global.timeoutSeconds;
      const mode = enabled === false ? 'off' : timeoutSeconds === 0 ? 'wait' : 'on';
      return {
        mode,
        inherited: overrideEnabled === null && overrideTimeout === null,
        enabled,
        timeoutSeconds,
      };
    }

    /**
     * Per-session switch for the goal-round confirmation gate. The value is the
     * host projection `goal-confirm`; every action is the same slash command the
     * agent-facing card uses, so the session log stays the only writer.
     */
    function GoalConfirmSwitch(props) {
      const useProjection = props.useProjection;
      const sessionId = props.sessionId;
      const remote = props.remote;
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const raw = typeof useProjection === 'function' ? useProjection('goal-confirm') : undefined;
      const state = goalConfirmSnapshot(raw);
      const [menu, setMenu] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const rootRef = React.useRef(null);
      const buttonRef = React.useRef(null);

      React.useEffect(() => {
        if (error === null) return undefined;
        const timer = window.setTimeout(() => setError(null), 5000);
        return () => window.clearTimeout(timer);
      }, [error]);

      React.useEffect(() => {
        setMenu(null);
        setError(null);
      }, [sessionId]);

      React.useEffect(() => {
        if (menu === null) return undefined;
        const onDown = (event) => {
          if (rootRef.current !== null && event.target instanceof Node && rootRef.current.contains(event.target)) return;
          setMenu(null);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') setMenu(null);
        };
        const onViewport = () => setMenu(null);
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', onViewport);
        window.addEventListener('scroll', onViewport, true);
        return () => {
          document.removeEventListener('pointerdown', onDown, true);
          document.removeEventListener('keydown', onKey);
          window.removeEventListener('resize', onViewport);
          window.removeEventListener('scroll', onViewport, true);
        };
      }, [menu]);

      if (typeof sessionId !== 'string' || sessionId === '') return null;

      const openMenu = () => {
        const button = buttonRef.current;
        if (button === null) return;
        const rect = button.getBoundingClientRect();
        const width = 188;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        const below = rect.top < 200;
        setMenu({
          left,
          width,
          ...(below ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }),
        });
      };

      const run = async (arg) => {
        setMenu(null);
        if (remote === undefined || remote.commands === undefined || typeof remote.commands.execute !== 'function') {
          setError('commands remote unavailable');
          return;
        }
        setBusy(true);
        setError(null);
        try {
          const result = await remote.commands.execute(sessionId, `/goal-confirm ${arg}`, []);
          if (result !== null && typeof result === 'object' && result.ok === false) {
            throw new Error(result.error && result.error.message ? result.error.message : 'command refused');
          }
          const value = result !== null && typeof result === 'object' && result.ok === true ? result.value : undefined;
          if (value === undefined) throw new Error(`unknown command: /goal-confirm ${arg}`);
          if (value.result !== null && typeof value.result === 'object' && value.result.kind === 'error') {
            throw new Error(value.result.text || 'command failed');
          }
        } catch (failure) {
          setError(String(failure !== null && typeof failure === 'object' && failure.message ? failure.message : failure));
        } finally {
          setBusy(false);
        }
      };

      const valueLabel = state.inherited
        ? t('state.inherit')
        : state.mode === 'off' ? t('state.off') : state.mode === 'wait' ? t('state.wait') : `${state.timeoutSeconds}s`;
      const modeText = state.mode === 'off'
        ? t('opt.off')
        : state.mode === 'wait' ? t('opt.wait') : `${state.timeoutSeconds}s`;
      const title = `${t('title')} · ${modeText}`;
      const items = [
        { arg: 'reset', label: t('opt.inherit'), current: state.inherited },
        { arg: 'on', label: t('opt.on'), current: !state.inherited && state.mode !== 'off' && state.mode !== 'wait' },
        { arg: 'wait', label: t('opt.wait'), current: state.mode === 'wait' },
        { arg: 'off', label: t('opt.off'), current: state.mode === 'off' },
      ];

      return h('div', { className: 'mosire-goal-confirm', 'data-state': state.mode, ref: rootRef },
        h('button', {
          type: 'button',
          ref: buttonRef,
          className: 'mosire-goal-confirm-btn',
          title,
          'aria-haspopup': 'menu',
          'aria-expanded': menu !== null,
          'aria-label': title,
          disabled: busy,
          onClick: () => (menu === null ? openMenu() : setMenu(null)),
        },
          h('span', { className: 'mosire-goal-confirm-dot', 'aria-hidden': 'true' }),
          `${t('label')} · ${valueLabel}`),
        menu === null ? null : h('div', {
          className: 'mosire-goal-confirm-menu',
          role: 'menu',
          'aria-label': t('menu.label'),
          style: {
            left: `${menu.left}px`,
            width: `${menu.width}px`,
            ...(menu.top === undefined ? { bottom: `${menu.bottom}px` } : { top: `${menu.top}px` }),
          },
        }, items.map((item) => h('button', {
          key: item.arg,
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': item.current,
          className: 'mosire-goal-confirm-item',
          onClick: () => run(item.arg),
        }, item.label))),
        error === null ? null : h('span', { className: 'mosire-goal-confirm-error', title: error }, `${t('error')}: ${error}`));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTS), 'timing-annotations: dictionaries');
        ctx.effect(() => ctx.locale.register(GC_NS, GC_DICTS), 'goal-confirm: dictionaries');
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'timing-annotations',
          order: 30,
          locale: NS,
        }, AssistantTiming));
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'timing-annotations-turn',
          order: 30,
          locale: NS,
        }, TurnTiming));
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'timing-annotations-live',
          order: 3,
          locale: NS,
        }, LiveTiming));
        // Optional on purpose: a composition without command remotes keeps the
        // timing annotations and simply omits the switch instead of failing.
        ctx.inject(['remote.commands'], (remoteCtx) => {
          ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'goal-confirm-switch',
            order: 4,
            locale: GC_NS,
          }, (props) => h(GoalConfirmSwitch, Object.assign({}, props, { remote: remoteCtx.remote }))));
        });
      },
    };
  },
});


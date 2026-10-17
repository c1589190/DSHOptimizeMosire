window.__ModuleLoader__.load({
  id: '@mosire/dsh-timing-annotations',
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

    const CSS = [
      '.mosire-timing{display:inline-flex;align-items:center;white-space:nowrap;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;user-select:none;margin-left:auto;padding:0 2px}',
      '.mosire-timing-tail{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:baseline;gap:4px 12px;box-sizing:border-box;width:100%;margin-top:8px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;user-select:none;text-align:right}',
      '.mosire-timing-tail-title{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.mosire-timing-tail-item,.mosire-timing-tail-more{white-space:nowrap}',
      '.mosire-timing-tail-item b{font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.mosire-timing-live{position:fixed;z-index:40;pointer-events:none;white-space:nowrap;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;user-select:none;padding:0 6px;border-radius:6px;background:color-mix(in srgb, var(--dsw-alias-bg-base) 88%, transparent);box-shadow:0 0 0 1px var(--dsw-alias-border-l1)}',
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

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTS), 'timing-annotations: dictionaries');
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
      },
    };
  },
});

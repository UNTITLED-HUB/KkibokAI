// 앱 상태 + 간단한 이벤트 버스
const listeners = new Map();

export const store = {
  user: null,
  balance: { daily: 0, bonus: 0, total: 0 },
  settings: {},
  serverConfig: {},
  chats: [],
  chatId: null,
  mode: 'nobrain',
  submode: 'fast',
  busy: false,

  on(ev, fn) {
    if (!listeners.has(ev)) listeners.set(ev, new Set());
    listeners.get(ev).add(fn);
    return () => listeners.get(ev)?.delete(fn);
  },
  emit(ev, data) {
    for (const fn of listeners.get(ev) || []) {
      try {
        fn(data);
      } catch (e) {
        console.error(e);
      }
    }
  },
  setBalance(b) {
    if (!b) return;
    this.balance = { daily: Number(b.daily || 0), bonus: Number(b.bonus || 0), total: Number(b.total ?? (Number(b.daily || 0) + Number(b.bonus || 0))) };
    this.emit('balance', this.balance);
  },
  setting(key, fallback) {
    const v = this.settings?.[key];
    return v === undefined ? fallback : v;
  },
};

export const local = {
  get(k, d) {
    try {
      const v = localStorage.getItem('kb_' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('kb_' + k, JSON.stringify(v));
    } catch { /* ignore */ }
  },
  clearAll() {
    try {
      Object.keys(localStorage).filter((k) => k.startsWith('kb_') && k !== 'kb_token').forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }
  },
};

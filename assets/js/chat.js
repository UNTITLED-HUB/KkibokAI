// 채팅: 메시지 렌더링, 스트리밍, WORK 도구 실행 왕복, 수정/다시 시도/읽기
import { api, ApiError } from './api.js?v=1.5.0';
import { renderMarkdown } from './markdown.js?v=1.5.0';
import { sandbox } from './sandbox/index.js?v=1.5.0';
import { store } from './store.js?v=1.5.0';
import {
  $, copyText, esc, fmtSeconds, fmtTokens, h, icon, MODE_VAR, modeKey, modeTag, setIcon, toast,
} from './ui.js?v=1.5.0';
import { tts } from './voice.js?v=1.5.0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUNNING = ['running', 'waiting_tools'];
const isRunning = (m) => !!m.streaming || RUNNING.includes(m.meta?.status);

// ---------- 작업 과정 문구 ----------
function cut(s, n = 48) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
const code = (t, n) => `<code>${esc(cut(t, n))}</code>`;
const base = (p) => String(p || '').split('/').filter(Boolean).pop() || p;
function activityHtml(s, live) {
  const t = s.target || '';
  switch (s.kind) {
    case 'exec': return `${code(t)} ${live ? '실행 중...' : '실행'}`;
    case 'write': return `${code(base(t), 40)} ${live ? '파일 편집 중...' : '파일 편집'}`;
    case 'read': return `${code(base(t), 40)} ${live ? '파일 읽는 중...' : '파일 읽음'}`;
    case 'search': return `${live ? '웹 검색 중' : '웹 검색'}: ${esc(cut(t, 50))}`;
    case 'image': return live ? '이미지 만드는 중...' : '이미지 생성';
    case 'plan': return live ? '계획 세우는 중...' : '계획 세움';
    case 'work': return live ? '작업하는 중...' : '작업';
    case 'verify': return live ? '결과 검증하는 중...' : '결과 검증';
    case 'report': return live ? '답변 정리하는 중...' : '답변 정리';
    case 'answer': return live ? '첨부 파일 보는 중...' : '첨부 파일 확인';
    default: return esc(s.label || '');
  }
}

function thread() {
  return $('#thread');
}
function nearBottom() {
  const t = thread();
  return t.scrollHeight - t.scrollTop - t.clientHeight < 140;
}
function scrollBottom(force = false) {
  const t = thread();
  if (force || nearBottom()) t.scrollTop = t.scrollHeight;
}

export const chat = {
  messages: [],
  stream: null,
  readingId: null,
  renderPending: false,

  init() {
    $('#messages').addEventListener('click', async (e) => {
      const b = e.target.closest('.code-copy');
      if (!b) return;
      const code = b.closest('.code')?.querySelector('code')?.textContent || '';
      if (await copyText(code)) {
        setIcon(b, 'check');
        setTimeout(() => setIcon(b, 'copy'), 1400);
      }
    });
    const t = thread();
    t.addEventListener('scroll', () => {
      $('#toBottom').hidden = nearBottom();
      document.querySelector('.topbar').classList.toggle('scrolled', t.scrollTop > 4);
    });
    $('#toBottom').onclick = () => {
      t.scrollTo({ top: t.scrollHeight, behavior: 'smooth' });
    };
    tts.onChange = (on) => {
      if (!on) this.readingId = null;
      this.refreshReadButtons();
    };
    this.renderEmpty();
  },

  renderEmpty() {},

  setTitle(title) {
    $('#chatTitle').textContent = !title || title === 'Unnamed Chat' ? (store.chatId ? 'Unnamed Chat' : '새 채팅') : title;
    document.title = title && title !== 'Unnamed Chat' ? `${title} · KkibokAI` : 'KkibokAI';
  },

  newChat() {
    this.detach();
    tts.stop();
    store.chatId = null;
    this.messages = [];
    this.render();
    this.setTitle(null);
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    store.emit('chat-changed', null);
  },

  async open(id) {
    if (this.stream && store.chatId === id) return;
    this.detach();
    tts.stop();
    store.chatId = id;
    store.emit('chat-changed', id);
    const known = store.chats.find((c) => c.id === id);
    this.setTitle(known?.title);
    this.messages = [];
    $('#messages').innerHTML = '';
    $('#empty').hidden = true;
    try {
      const r = await api.get(`/chats/${id}`);
      if (store.chatId !== id) return;
      this.messages = r.messages || [];
      this.setTitle(r.chat?.title);
      this.render();
      scrollBottom(true);
      if (r.active_run) this.resume(r.active_run);
    } catch (e) {
      if (store.chatId !== id) return;
      toast(e.message, 'error');
      if (e.status === 404) {
        store.chats = store.chats.filter((c) => c.id !== id);
        store.emit('chats');
        this.newChat();
      }
    }
    if (location.hash !== `#/c/${id}`) history.replaceState(null, '', `#/c/${id}`);
  },

  async reload() {
    const id = store.chatId;
    if (!id) return;
    try {
      const r = await api.get(`/chats/${id}`);
      if (store.chatId !== id || store.busy) return;
      const stick = nearBottom();
      this.messages = r.messages || [];
      this.setTitle(r.chat?.title);
      this.render();
      if (stick) scrollBottom(true);
    } catch { /* ignore */ }
  },

  // ---------------- 렌더링 ----------------
  render() {
    const box = $('#messages');
    box.innerHTML = '';
    $('#empty').hidden = this.messages.length > 0 || !!store.chatId;
    if (!this.messages.length && !store.chatId) this.renderEmpty();
    const lastAi = [...this.messages].reverse().find((m) => m.role === 'assistant');
    for (const m of this.messages) {
      const el = m.role === 'user' ? this.userEl(m) : this.aiEl(m);
      if (m === lastAi) el.classList.add('last');
      box.append(el);
    }
  },

  attachmentsEl(atts) {
    const box = h('div', { class: 'msg-atts' });
    for (const a of atts) {
      if (a.kind === 'image' && a.url) {
        box.append(h('a', { class: 'msg-att img', href: a.url, target: '_blank', rel: 'noopener', title: a.name }, h('img', { src: a.url, alt: a.name, loading: 'lazy' })));
      } else {
        box.append(h('span', { class: 'msg-att', title: a.name, html: icon(a.kind === 'image' ? 'image' : 'file') }, h('span', {}, a.name)));
      }
    }
    return box;
  },

  metaEl(meta) {
    const chips = [];
    if (meta.duration_ms != null) chips.push(h('span', { class: 'chip', title: '작업 소요 시간', html: icon('clock') }, fmtSeconds(meta.duration_ms)));
    if (meta.models?.length) chips.push(h('span', { class: 'chip', title: '사용 모델', html: icon('cpu') }, meta.models.join(', ')));
    if (meta.cost != null) chips.push(h('span', { class: 'chip', title: '소모 토큰', html: icon('token') }, `${fmtTokens(meta.cost)} 토큰`));
    return h('div', { class: 'msg-meta' }, ...chips);
  },

  actions(list) {
    const box = h('div', { class: 'msg-actions' });
    for (const [ic, label, fn, extra] of list) {
      const b = h('button', { class: 'icon-btn', 'aria-label': label, title: label, html: icon(ic), ...(extra || {}) });
      b.onclick = () => fn(b);
      box.append(b);
    }
    return box;
  },

  async copy(text, btn) {
    if (await copyText(text)) {
      btn.innerHTML = icon('check');
      setTimeout(() => (btn.innerHTML = icon('copy')), 1400);
    }
  },

  userEl(m) {
    const el = h('div', { class: 'msg user', dataset: { id: m.id } });
    if (m.attachments?.length) el.append(this.attachmentsEl(m.attachments));
    if (m.content) el.append(h('div', { class: 'bubble' }, m.content));
    if (store.setting('show_meta', true) && (m.meta?.duration_ms != null || m.meta?.cost != null)) el.append(this.metaEl(m.meta));
    if (!String(m.id).startsWith('tmp')) {
      el.append(this.actions([
        ['copy', '복사', (b) => this.copy(m.content, b)],
        ['edit', '수정', () => this.startEdit(m, el)],
      ]));
    }
    m._el = el;
    return el;
  },

  aiEl(m) {
    const key = modeKey(m.meta?.mode, m.meta?.submode);
    const el = h('div', { class: 'msg ai', dataset: { id: m.id }, style: { '--tag': MODE_VAR[key] } });
    el.append(h('div', { class: 'ai-head', html: `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 22 12 12 22 2 12Z"/></svg>` },
      h('span', { class: 'mode-tag' }, modeTag(m.meta?.mode, m.meta?.submode))));
    const stepsBox = h('div');
    const body = h('div', { class: 'ai-body md' + (m.meta?.error ? ' error' : '') });
    el.append(stepsBox, body);
    m._el = el;
    m._steps = stepsBox;
    m._body = body;
    this.paintSteps(m);
    this.paintBody(m);
    if (!isRunning(m)) {
      el.append(this.actions([
        ['copy', '복사', (b) => this.copy(m.content, b)],
        ['refresh', '다시 시도', () => this.retry(m)],
        ['volume', '읽어 주기', () => this.read(m), { 'data-read': m.id }],
      ]));
    }
    return el;
  },

  paintBody(m) {
    if (!m._body) return;
    if (isRunning(m) && !m.content) {
      m._body.innerHTML = '<span class="typing" aria-label="생성 중"><i></i><i></i><i></i></span>';
      return;
    }
    m._body.innerHTML = renderMarkdown(m.content, isRunning(m));
  },

  paintSteps(m) {
    const steps = m.meta?.steps || [];
    const box = m._steps;
    if (!box) return;
    if (!steps.length) {
      box.innerHTML = '';
      return;
    }
    const running = isRunning(m);
    const item = (s, i) => {
      const live = running && i === steps.length - 1;
      const li = h('li', { class: `act ${live ? 'now' : 'done'}`, title: s.model || '' },
        h('span', { class: 'dot', html: live ? '<i class="spin"></i>' : icon('check') }),
        h('span', { class: 'txt', html: activityHtml(s, live) }));
      if (s.detail) li.append(h('details', { class: 'act-detail' }, h('summary', {}, '자세히'), h('pre', {}, s.detail)));
      return li;
    };
    if (running) {
      const ol = h('ol', { class: 'activity' });
      const from = Math.max(0, steps.length - 6);
      if (from) ol.append(h('li', { class: 'act more' }, `이전 작업 ${from}개`));
      steps.slice(from).forEach((s, j) => ol.append(item(s, from + j)));
      box.replaceChildren(ol);
      return;
    }
    const wasOpen = box.querySelector('details.steps')?.open;
    const det = h('details', { class: 'steps' });
    det.open = !!wasOpen;
    det.append(h('summary', { html: icon('chevron', 'chev') }, `작업 과정 ${steps.length}단계`));
    const ol = h('ol', { class: 'activity' });
    steps.forEach((s, i) => ol.append(item(s, i)));
    det.append(ol);
    box.replaceChildren(det);
  },

  scheduleRender(m) {
    if (this.renderPending) return;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      const stick = nearBottom();
      this.paintBody(m);
      if (stick) scrollBottom(true);
    });
  },

  refreshReadButtons() {
    document.querySelectorAll('[data-read]').forEach((b) => {
      const on = b.dataset.read === this.readingId;
      b.classList.toggle('on', on);
      b.innerHTML = icon(on ? 'volume-x' : 'volume');
      b.title = on ? '읽기 멈춤' : '읽어 주기';
      b.setAttribute('aria-label', b.title);
    });
  },

  read(m) {
    if (this.readingId === m.id) {
      tts.stop();
      return;
    }
    if (!tts.supported) {
      toast('음성 읽기를 지원하지 않는 브라우저예요.', 'error');
      return;
    }
    if (tts.speak(m.content, { onend: () => { this.readingId = null; this.refreshReadButtons(); } })) {
      this.readingId = m.id;
      this.refreshReadButtons();
    }
  },

  startEdit(m, el) {
    if (store.busy) {
      toast('답변이 끝난 뒤에 할 수 있어요.');
      return;
    }
    const bubble = el.querySelector('.bubble') || h('div', { class: 'bubble' });
    if (!bubble.parentNode) el.insertBefore(bubble, el.querySelector('.msg-meta, .msg-actions'));
    const area = h('textarea', { class: 'edit-area', 'aria-label': '메시지 수정' });
    area.value = m.content;
    const cancel = h('button', { class: 'btn btn-ghost btn-sm' }, '취소');
    const save = h('button', { class: 'btn btn-primary btn-sm' }, '수정해서 보내기');
    bubble.className = 'bubble editing';
    bubble.innerHTML = '';
    bubble.append(area, h('div', { class: 'edit-actions' }, cancel, save));
    el.querySelector('.msg-actions')?.remove();
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    cancel.onclick = () => this.render();
    const submit = () => {
      const v = area.value.trim();
      if (!v && !m.attachments?.length) return;
      this.send({ content: v, editId: m.id });
    };
    save.onclick = submit;
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
      if (e.key === 'Escape') this.render();
    });
  },

  retry(m) {
    if (store.busy) {
      toast('답변이 끝난 뒤에 할 수 있어요.');
      return;
    }
    if (String(m.id).startsWith('tmp')) return;
    this.send({ regenerateId: m.id });
  },

  setBusy(b) {
    store.busy = b;
    store.emit('busy', b);
  },

  // ---------------- 전송 ----------------
  // 서버가 답변을 끝까지 만들고 저장한다. 화면은 실시간으로 받거나(스트림),
  // 연결이 끊기면 저장된 진행 상황을 주기적으로 확인한다(/runs/:id).
  async send({ content = '', attachments = [], editId = null, regenerateId = null, voice = false, hooks = {} } = {}) {
    if (store.busy) {
      toast('답변을 만드는 중이에요.');
      return { text: '' };
    }
    tts.stop();
    const mode = store.mode;
    const submode = store.submode;
    let userMsg;
    let isNew = false;
    if (regenerateId) {
      const idx = this.messages.findIndex((x) => x.id === regenerateId);
      if (idx < 0) return { text: '' };
      this.messages.splice(idx);
      userMsg = [...this.messages].reverse().find((x) => x.role === 'user');
      if (userMsg) userMsg.meta = {};
    } else if (editId) {
      const idx = this.messages.findIndex((x) => x.id === editId);
      if (idx < 0) return { text: '' };
      userMsg = this.messages[idx];
      userMsg.content = content;
      userMsg.meta = {};
      this.messages.splice(idx + 1);
    } else {
      isNew = true;
      userMsg = {
        id: `tmp-${Date.now()}`,
        role: 'user',
        content,
        attachments: attachments.map((a) => ({ name: a.name, mime: a.mime, size: a.size, kind: a.kind, url: a.preview })),
        meta: {},
      };
      this.messages.push(userMsg);
    }
    const ai = { id: `tmp-ai-${Date.now()}`, role: 'assistant', content: '', attachments: [], meta: { mode, submode: mode === 'work' ? submode : null, steps: [], status: 'running' }, streaming: true };
    this.messages.push(ai);
    this.render();
    scrollBottom(true);

    for (const a of attachments) sandbox.saveUpload(a);

    const body = {
      chat_id: store.chatId,
      content,
      mode,
      submode,
      voice,
      sandbox: { enabled: store.setting('sandbox_ai', true), tree: sandbox.summary(), commands: sandbox.commands() },
    };
    if (isNew) body.attachments = attachments.map((a) => ({ name: a.name, mime: a.mime, size: a.size, data: a.data, text: a.text }));
    if (editId) body.edit_message_id = editId;
    if (regenerateId) body.regenerate_message_id = regenerateId;

    const s = this.newStream({ ai, user: userMsg, hooks, mode, chatId: store.chatId });
    try {
      await this.drive(s, '/chat/send', body);
    } catch (e) {
      if (s.stopped || s.detached || e.code === 'ABORTED') {
        /* stop()/detach() 가 처리 */
      } else if (!s.started) {
        this.messages = this.messages.filter((x) => x !== ai && !(isNew && x === userMsg));
        if (!isNew) await this.reloadAfter(0);
        if (isNew) store.emit('restore-input', { content, attachments });
        toast(e.message, 'error');
        if (e.code === 'NO_TOKENS') store.emit('open-panel', 'tokens');
      } else {
        ai.meta.error = true;
        ai.meta.status = 'error';
        ai.content = (ai.content ? ai.content + '\n\n' : '') + `⚠️ ${e.message}`;
      }
    } finally {
      this.endStream(s);
    }
    if (s.done && !voice && store.setting('auto_read', false) && !ai.meta.error) this.read(ai);
    return { text: ai.content, done: s.done };
  },

  newStream({ ai, user, hooks = {}, mode, runId = null, chatId }) {
    const s = { ctrl: new AbortController(), runId, ai, user, hooks, mode, chatId, started: !!runId, done: false, stopped: false, detached: false };
    this.stream = s;
    this.setBusy(true);
    return s;
  },

  endStream(s) {
    s.ai.streaming = false;
    if (this.stream === s) {
      this.stream = null;
      this.setBusy(false);
    }
    if (!s.detached && store.chatId === s.chatId) {
      if (!s.stopped) this.render();
      if (s.started && !s.done && !s.stopped) this.reloadAfter(600);
    }
  },

  /** 다른 채팅으로 이동: 화면만 떠나고 서버 작업은 계속 */
  detach() {
    const s = this.stream;
    if (!s) return;
    s.detached = true;
    s.ctrl.abort();
    this.stream = null;
    this.setBusy(false);
  },

  reloadAfter(ms) {
    return new Promise((r) => setTimeout(async () => {
      await this.reload();
      r();
    }, ms));
  },

  /** 스트림 → (끊기면) 진행 상황 확인 → Sandbox 도구 실행 → 이어서 … 끝날 때까지 */
  async drive(s, path, body) {
    while (!s.done && !s.stopped && !s.detached) {
      let pending = null;
      if (path) {
        try {
          pending = await this._stream(path, body, s);
        } catch (e) {
          if (s.stopped || s.detached) return;
          const transient = ['NETWORK', 'STREAM', 'RUN_BUSY'].includes(e.code) || e.status >= 500;
          if (!s.runId || !transient) throw e;
        }
        path = null;
      }
      if (s.done || s.stopped || s.detached) return;
      if (!pending) pending = await this.poll(s);
      if (!pending || s.done || s.stopped || s.detached) return;
      const results = [];
      for (const c of pending.calls) {
        if (s.stopped || s.detached) return;
        this.markLive(s.ai, c);
        const r = await sandbox.runTool(c);
        results.push({ id: c.id, output: r.output, exit_code: r.exit_code });
      }
      if (s.stopped || s.detached) return;
      path = '/chat/continue';
      body = { run_id: s.runId, tool_results: results };
    }
  },

  /** 지금 실행하는 Sandbox 작업을 진행 표시에 반영 */
  markLive(ai, c) {
    const steps = ai.meta.steps || (ai.meta.steps = []);
    const target = c.name === 'sandbox_exec' ? c.args?.command : c.args?.path;
    const kind = c.name === 'sandbox_exec' ? 'exec' : c.name === 'write_file' ? 'write' : 'read';
    const i = steps.findIndex((x) => x.kind === kind && x.target === target);
    if (i >= 0 && i !== steps.length - 1) steps.push(steps.splice(i, 1)[0]);
    else if (i < 0) steps.push({ phase: 'tool', kind, target, label: '', t: Date.now() });
    this.paintSteps(ai);
  },

  /** 서버에 저장된 진행 상황 확인 (연결이 끊겼거나 다른 기기에서 진행 중일 때) */
  async poll(s) {
    let delay = 700;
    let fails = 0;
    while (!s.stopped && !s.detached) {
      await sleep(delay);
      delay = Math.min(2000, delay + 150);
      if (s.stopped || s.detached) return null;
      let r;
      try {
        r = await api.get(`/runs/${s.runId}`);
        fails = 0;
      } catch (e) {
        if (e.status === 404) {
          s.done = true;
          return null;
        }
        if (++fails > 20) throw e;
        continue;
      }
      this.applyRun(s, r);
      if (!RUNNING.includes(r.status)) {
        s.done = true;
        return null;
      }
      if (r.status === 'waiting_tools' && r.pending_calls?.length) return { run_id: s.runId, calls: r.pending_calls };
    }
    return null;
  },

  applyRun(s, r) {
    const { ai, user } = s;
    const am = r.assistant_message;
    if (am) {
      ai.id = am.id;
      if (am.content !== ai.content) {
        ai.content = am.content;
        this.scheduleRender(ai);
      }
      ai.attachments = am.attachments || [];
      const stepsChanged = (am.meta?.steps?.length || 0) !== (ai.meta?.steps?.length || 0);
      ai.meta = { ...(am.meta || {}) };
      if (stepsChanged) this.paintSteps(ai);
      ai.created_at = am.created_at;
    }
    if (!RUNNING.includes(r.status)) {
      if (r.user_meta) user.meta = { ...(user.meta || {}), ...r.user_meta };
      if (r.balance) store.setBalance(r.balance);
      ai.streaming = false;
    }
  },

  async _stream(path, body, s) {
    let pending = null;
    let error = null;
    const { ai, user } = s;
    await api.stream(path, body, (ev, d) => {
      switch (ev) {
        case 'meta':
          s.started = true;
          s.runId = d.run_id || s.runId;
          if (d.assistant_message) ai.id = d.assistant_message.id;
          if (d.chat_created || !store.chatId) {
            store.chatId = d.chat_id;
            s.chatId = d.chat_id;
            if (!store.chats.find((c) => c.id === d.chat_id)) {
              store.chats.unshift({ id: d.chat_id, title: d.chat_title || 'Unnamed Chat', updated_at: new Date().toISOString() });
            }
            history.replaceState(null, '', `#/c/${d.chat_id}`);
            this.setTitle(d.chat_title);
          }
          store.emit('chats');
          store.emit('chat-changed', d.chat_id);
          if (d.user_message) {
            user.id = d.user_message.id;
            user.attachments = d.user_message.attachments?.length ? d.user_message.attachments : user.attachments;
            user.created_at = d.user_message.created_at;
          }
          break;
        case 'run':
          s.runId = d.run_id;
          s.started = true;
          break;
        case 'step':
          ai.meta.steps = ai.meta.steps || [];
          ai.meta.steps.push(d);
          this.paintSteps(ai);
          scrollBottom();
          break;
        case 'step_update':
          if (ai.meta.steps?.[d.index]) ai.meta.steps[d.index] = d.step;
          this.paintSteps(ai);
          break;
        case 'delta':
          ai.content += d.text;
          this.scheduleRender(ai);
          s.hooks.onDelta?.(d.text);
          break;
        case 'reset':
          ai.content = '';
          this.scheduleRender(ai);
          s.hooks.onReset?.();
          break;
        case 'artifact':
          sandbox.saveArtifact(d);
          break;
        case 'usage':
          store.setBalance(d.balance);
          break;
        case 'title': {
          const c = store.chats.find((x) => x.id === d.chat_id);
          if (c) c.title = d.title;
          store.emit('chats');
          if (store.chatId === d.chat_id) this.setTitle(d.title);
          break;
        }
        case 'tool_calls':
          pending = d;
          break;
        case 'done': {
          s.done = true;
          const am = d.assistant_message;
          if (am) {
            ai.id = am.id;
            ai.content = am.content;
            ai.attachments = am.attachments || [];
            ai.meta = am.meta || ai.meta;
            ai.created_at = am.created_at;
          }
          ai.streaming = false;
          user.meta = { ...(user.meta || {}), ...(d.user_meta || {}) };
          store.setBalance(d.balance);
          const c = store.chats.find((x) => x.id === d.chat_id);
          if (c) {
            c.updated_at = new Date().toISOString();
            store.chats = [c, ...store.chats.filter((x) => x !== c)];
            store.emit('chats');
          }
          break;
        }
        case 'error':
          error = d;
          break;
      }
    }, s.ctrl.signal);
    if (error) throw new ApiError(500, error.code, error.message);
    return pending;
  },

  async stop() {
    const s = this.stream;
    if (!s || s.stopped) return;
    s.stopped = true;
    tts.stop();
    if (s.runId) {
      try {
        await api.post('/chat/cancel', { run_id: s.runId });
      } catch { /* ignore */ }
    }
    s.ctrl.abort();
    s.ai.streaming = false;
    s.ai.meta.status = 'stopped';
    if (!s.ai.content) s.ai.content = '(중지됨)';
    this.render();
    setTimeout(() => this.reload(), 1800);
  },

  // ---------------- 나갔다 돌아왔을 때: 서버에서 진행 중인 작업 이어 보기 ----------------
  async resume(run) {
    if (this.stream) return;
    const ai = this.messages.find((m) => m.id === run.assistant_id) || [...this.messages].reverse().find((m) => m.role === 'assistant');
    if (!ai) return;
    const user = [...this.messages].slice(0, this.messages.indexOf(ai)).reverse().find((m) => m.role === 'user') || { meta: {} };
    ai.streaming = true;
    ai.meta = { ...(ai.meta || {}), status: run.status };
    this.render();
    scrollBottom(true);
    const s = this.newStream({ ai, user, mode: run.mode, runId: run.id, chatId: store.chatId });
    try {
      if (run.status === 'waiting_tools' && run.pending_calls?.length) {
        const results = [];
        for (const c of run.pending_calls) {
          if (s.stopped || s.detached) return;
          this.markLive(ai, c);
          const r = await sandbox.runTool(c);
          results.push({ id: c.id, output: r.output, exit_code: r.exit_code });
        }
        await this.drive(s, '/chat/continue', { run_id: run.id, tool_results: results });
      } else {
        await this.drive(s, null, null);
      }
    } catch (e) {
      if (!s.stopped && !s.detached) toast(e.message, 'error');
    } finally {
      this.endStream(s);
    }
  },
};

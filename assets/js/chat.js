// 채팅: 메시지 렌더링, 스트리밍, WORK 도구 실행 왕복, 수정/다시 시도/읽기
import { api, ApiError } from './api.js';
import { renderMarkdown } from './markdown.js';
import { sandbox } from './sandbox/index.js';
import { store } from './store.js';
import {
  $, copyText, fmtSeconds, fmtTokens, h, icon, MODE_VAR, modeKey, modeTag, setIcon, toast,
} from './ui.js';
import { tts } from './voice.js';

const EXAMPLES = [
  { mode: 'nobrain', text: '오늘 저녁 메뉴 세 가지만 추천해줘' },
  { mode: 'work', sub: 'fast', text: '자바스크립트로 숫자 맞히기 게임을 만들어서 /user/download 에 저장해줘' },
  { mode: 'work', sub: 'think', text: '샌드박스 /user 폴더 구조를 살펴보고 정리 방법을 제안해줘' },
];

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

  renderEmpty() {
    const box = $('#examples');
    box.innerHTML = '';
    for (const ex of EXAMPLES) {
      const key = ex.mode === 'work' ? ex.sub : 'nobrain';
      const b = h('button', { class: 'example', style: { '--ex': MODE_VAR[key] } },
        h('span', { class: 'tag' }, ex.mode === 'work' ? `WORK ${ex.sub.toUpperCase()}` : 'NO BRAIN'), ex.text);
      b.onclick = () => store.emit('example', ex);
      box.append(b);
    }
    const name = store.user?.username;
    $('#emptyHello').textContent = name ? `${name}님, 무엇이든 물어보세요` : '무엇이든 물어보세요';
  },

  setTitle(title) {
    $('#chatTitle').textContent = !title || title === 'Unnamed Chat' ? (store.chatId ? 'Unnamed Chat' : '새 채팅') : title;
    document.title = title && title !== 'Unnamed Chat' ? `${title} · KkibokAI` : 'KkibokAI';
  },

  newChat() {
    if (store.busy) {
      toast('답변이 끝난 뒤 새 채팅을 시작할 수 있어요.');
      return;
    }
    tts.stop();
    store.chatId = null;
    this.messages = [];
    this.render();
    this.setTitle(null);
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    store.emit('chat-changed', null);
  },

  async open(id) {
    if (store.busy) {
      toast('답변이 끝난 뒤 다른 채팅으로 이동할 수 있어요.');
      return;
    }
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
      if (r.active_run) this.showActiveRun(r.active_run);
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
    if (!m.streaming) {
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
    if (m.streaming && !m.content) {
      m._body.innerHTML = '<span class="typing" aria-label="생성 중"><i></i><i></i><i></i></span>';
      return;
    }
    m._body.innerHTML = renderMarkdown(m.content, !!m.streaming);
  },

  paintSteps(m) {
    const steps = m.meta?.steps || [];
    const box = m._steps;
    if (!box) return;
    if (!steps.length) {
      box.innerHTML = '';
      return;
    }
    const wasOpen = box.querySelector('details')?.open;
    const last = steps[steps.length - 1];
    const det = h('details', { class: 'steps' });
    det.open = m.streaming ? (wasOpen ?? true) : !!wasOpen;
    det.append(h('summary', { html: icon('chevron', 'chev') }, m.streaming ? last.label : `작업 과정 ${steps.length}단계`));
    const ol = h('ol');
    steps.forEach((s, i) => {
      const isLast = i === steps.length - 1;
      const li = h('li', { class: `step ${s.phase === 'tool' ? 'tool' : ''} ${m.streaming && isLast ? 'live' : 'done-step'}` },
        h('span', { class: 'label' }, s.label));
      if (s.model) li.append(h('span', { class: 'model' }, s.model));
      if (s.detail) li.append(h('span', { class: 'detail' }, s.detail));
      ol.append(li);
    });
    det.append(ol);
    box.innerHTML = '';
    box.append(det);
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
      toast('이 브라우저는 음성 읽기를 지원하지 않습니다.', 'error');
      return;
    }
    if (tts.speak(m.content, { onend: () => { this.readingId = null; this.refreshReadButtons(); } })) {
      this.readingId = m.id;
      this.refreshReadButtons();
    }
  },

  startEdit(m, el) {
    if (store.busy) {
      toast('답변이 끝난 뒤 수정할 수 있어요.');
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
      toast('답변이 끝난 뒤 다시 시도할 수 있어요.');
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
  async send({ content = '', attachments = [], editId = null, regenerateId = null, voice = false, hooks = {} } = {}) {
    if (store.busy) {
      toast('답변을 만드는 중이에요. 잠시 후 다시 시도해 주세요.');
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
    const ai = { id: `tmp-ai-${Date.now()}`, role: 'assistant', content: '', attachments: [], meta: { mode, submode: mode === 'work' ? submode : null, steps: [] }, streaming: true };
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

    const s = { ctrl: new AbortController(), runId: null, ai, user: userMsg, hooks, mode, started: false, done: false, stopped: false };
    this.stream = s;
    this.setBusy(true);
    try {
      await this._stream('/chat/send', body, s);
    } catch (e) {
      if (s.stopped || e.code === 'ABORTED') {
        /* stop() 가 처리 */
      } else if (!s.started) {
        // 서버가 저장하기 전에 거절됨 → 화면 되돌리기
        this.messages = this.messages.filter((x) => x !== ai && !(isNew && x === userMsg));
        if (!isNew) await this.reloadAfter(0);
        if (isNew) store.emit('restore-input', { content, attachments });
        toast(e.message, 'error');
        if (e.code === 'NO_TOKENS') store.emit('open-panel', 'tokens');
      } else {
        ai.meta.error = true;
        ai.content = (ai.content ? ai.content + '\n\n' : '') + `⚠️ ${e.message}`;
      }
    } finally {
      ai.streaming = false;
      this.stream = null;
      this.setBusy(false);
      if (!s.stopped) this.render();
      if (s.started && !s.done && !s.stopped) this.reloadAfter(600);
    }
    if (s.done && !voice && store.setting('auto_read', false) && !ai.meta.error) this.read(ai);
    return { text: ai.content, done: s.done };
  },

  reloadAfter(ms) {
    return new Promise((r) => setTimeout(async () => {
      await this.reload();
      r();
    }, ms));
  },

  async _stream(path, body, s) {
    let pending = null;
    let yielded = false;
    let error = null;
    const { ai, user } = s;
    await api.stream(path, body, (ev, d) => {
      switch (ev) {
        case 'meta':
          s.started = true;
          if (d.chat_created || !store.chatId) {
            store.chatId = d.chat_id;
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
          break;
        case 'step':
          ai.meta.steps.push(d);
          this.paintSteps(ai);
          scrollBottom();
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
        case 'yield':
          yielded = true;
          break;
        case 'done': {
          s.done = true;
          const am = d.assistant_message;
          ai.id = am.id;
          ai.content = am.content;
          ai.attachments = am.attachments || [];
          ai.meta = am.meta || ai.meta;
          ai.created_at = am.created_at;
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

    if (s.done || s.stopped) return;
    if (error) throw new ApiError(500, error.code, error.message);
    if (pending) {
      const results = [];
      for (const c of pending.calls) {
        if (s.stopped) return;
        const r = await sandbox.runTool(c);
        results.push({ id: c.id, output: r.output, exit_code: r.exit_code });
      }
      if (s.stopped) return;
      return this._stream('/chat/continue', { run_id: pending.run_id, tool_results: results }, s);
    }
    if (yielded && s.runId) return this._stream('/chat/continue', { run_id: s.runId }, s);
  },

  async stop() {
    const s = this.stream;
    if (!s || s.stopped) return;
    s.stopped = true;
    tts.stop();
    if (s.mode === 'work' && s.runId) {
      try {
        await api.post('/chat/cancel', { run_id: s.runId });
      } catch { /* ignore */ }
    }
    s.ctrl.abort();
    s.ai.streaming = false;
    if (!s.ai.content) s.ai.content = '(중지됨)';
    this.render();
    setTimeout(() => this.reload(), 1200);
  },

  // ---------------- 멈춰 있던 WORK 작업 ----------------
  showActiveRun(run) {
    const box = $('#messages');
    const note = h('div', { class: 'notice', role: 'status' });
    if (run.status === 'running') {
      note.append(h('p', { style: { margin: '0 0 10px' } }, '다른 창이나 기기에서 이 채팅의 WORK 작업이 진행 중이에요.'),
        h('button', { class: 'btn btn-sm', onclick: () => this.open(store.chatId) }, '새로고침'));
      box.append(note);
      return;
    }
    const resume = h('button', { class: 'btn btn-primary btn-sm' }, '이어서 진행');
    const cancel = h('button', { class: 'btn btn-ghost btn-sm' }, '중지');
    note.append(h('p', { style: { margin: '0 0 10px' } }, 'WORK 작업이 중간에 멈춰 있어요. 이어서 진행할까요?'), h('div', { class: 'row' }, resume, cancel));
    box.append(note);
    scrollBottom(true);
    cancel.onclick = async () => {
      note.remove();
      try {
        await api.post('/chat/cancel', { run_id: run.id });
      } catch (e) {
        toast(e.message, 'error');
      }
      this.reload();
    };
    resume.onclick = async () => {
      note.remove();
      const user = [...this.messages].reverse().find((m) => m.role === 'user') || { meta: {} };
      const ai = { id: `tmp-ai-${Date.now()}`, role: 'assistant', content: '', attachments: [], meta: { mode: 'work', submode: run.submode, steps: [...(run.steps || [])] }, streaming: true };
      this.messages.push(ai);
      this.render();
      scrollBottom(true);
      const s = { ctrl: new AbortController(), runId: run.id, ai, user, hooks: {}, mode: 'work', started: true, done: false, stopped: false };
      this.stream = s;
      this.setBusy(true);
      try {
        const results = [];
        for (const c of run.pending_calls || []) {
          const r = await sandbox.runTool(c);
          results.push({ id: c.id, output: r.output, exit_code: r.exit_code });
        }
        await this._stream('/chat/continue', results.length ? { run_id: run.id, tool_results: results } : { run_id: run.id }, s);
      } catch (e) {
        if (!s.stopped) toast(e.message, 'error');
      } finally {
        ai.streaming = false;
        this.stream = null;
        this.setBusy(false);
        this.render();
        if (!s.done) this.reloadAfter(600);
      }
    };
  },
};

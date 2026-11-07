// 사이드바: 메뉴, 채팅 목록, 토큰 표시
import { api } from './api.js';
import { chat } from './chat.js';
import { panels } from './panels.js';
import { sandbox } from './sandbox/index.js';
import { local, store } from './store.js';
import { $, $$, confirmDialog, fmtTokens, h, icon, openMenu, promptDialog, toast } from './ui.js';

const mq = window.matchMedia('(max-width: 860px)');

export const sidebar = {
  init() {
    const shell = $('#shell');
    if (local.get('sb_collapsed', false) && !mq.matches) shell.classList.add('sb-collapsed');
    $('#sbOpen').onclick = () => this.open();
    $('#sbClose').onclick = () => this.close();
    $('#scrim').onclick = () => this.close();
    mq.addEventListener('change', () => {
      shell.classList.remove('sb-open');
      $('#scrim').hidden = true;
    });

    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const a = el.dataset.action;
      if (a === 'new-chat') {
        chat.newChat();
        this.closeIfMobile();
        $('#prompt').focus();
      } else if (a === 'panel') {
        panels.open(el.dataset.panel);
        this.closeIfMobile();
      } else if (a === 'sandbox') {
        sandbox.toggle();
        this.closeIfMobile();
      }
    });

    store.on('chats', () => this.renderList());
    store.on('chat-changed', () => this.renderList());
    store.on('balance', () => this.paintTokens());
    store.on('user', () => ($('#meName').textContent = store.user?.username || ''));
    $('#meName').textContent = store.user?.username || '';
    this.paintTokens();
  },

  open() {
    const shell = $('#shell');
    if (mq.matches) {
      shell.classList.add('sb-open');
      $('#scrim').hidden = false;
      $('#sbClose').focus();
    } else {
      shell.classList.remove('sb-collapsed');
      local.set('sb_collapsed', false);
    }
  },

  close() {
    const shell = $('#shell');
    if (mq.matches) {
      shell.classList.remove('sb-open');
      $('#scrim').hidden = true;
    } else {
      shell.classList.add('sb-collapsed');
      local.set('sb_collapsed', true);
    }
  },

  closeIfMobile() {
    if (mq.matches) this.close();
  },

  async loadChats() {
    try {
      const r = await api.get('/chats');
      store.chats = r.chats || [];
      this.renderList();
    } catch (e) {
      toast(e.message, 'error');
    }
  },

  renderList() {
    const ul = $('#chatList');
    ul.innerHTML = '';
    if (!store.chats.length) {
      ul.append(h('li', { class: 'chat-empty' }, '채팅 없음'));
      return;
    }
    for (const c of store.chats) {
      const li = h('li', { class: 'chat-item' + (c.id === store.chatId ? ' current' : '') });
      const open = h('button', { class: 'open', title: c.title }, c.title);
      if (c.id === store.chatId) open.setAttribute('aria-current', 'page');
      open.onclick = () => {
        if (c.id !== store.chatId) chat.open(c.id);
        this.closeIfMobile();
      };
      const more = h('button', { class: 'icon-btn more', 'aria-label': `${c.title} 메뉴`, html: icon('more') });
      more.onclick = (e) => {
        e.stopPropagation();
        openMenu(more, [
          { label: '이름 바꾸기', icon: 'edit', onClick: () => this.rename(c) },
          { label: '삭제', icon: 'trash', danger: true, onClick: () => this.remove(c) },
        ]);
      };
      li.append(open, more);
      ul.append(li);
    }
  },

  async rename(c) {
    const title = await promptDialog({ title: '이름 변경', value: c.title, maxLength: 80 });
    if (!title || title === c.title) return;
    try {
      await api.patch(`/chats/${c.id}`, { title });
      c.title = title;
      this.renderList();
      if (store.chatId === c.id) chat.setTitle(title);
    } catch (e) {
      toast(e.message, 'error');
    }
  },

  async remove(c) {
    if (store.busy && store.chatId === c.id) {
      toast('답변이 끝난 뒤에 할 수 있어요.');
      return;
    }
    if (!(await confirmDialog({ title: '채팅을 삭제할까요?', message: `"${c.title}" · 되돌릴 수 없어요.`, confirmText: '삭제', danger: true }))) return;
    try {
      await api.del(`/chats/${c.id}`);
      store.chats = store.chats.filter((x) => x.id !== c.id);
      if (store.chatId === c.id) chat.newChat();
      this.renderList();
      toast('삭제했어요');
    } catch (e) {
      toast(e.message, 'error');
    }
  },

  paintTokens() {
    const t = store.balance.total;
    for (const el of $$('.token-chip')) {
      el.innerHTML = `<span class="dot"></span>${fmtTokens(t)}`;
      el.classList.toggle('low', t < 25);
      el.title = `일일 ${fmtTokens(store.balance.daily)} + 보너스 ${fmtTokens(store.balance.bonus)}`;
      el.setAttribute('aria-label', el.title);
    }
  },
};

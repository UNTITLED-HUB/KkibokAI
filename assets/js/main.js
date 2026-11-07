// 앱 시작
import { api, session } from './api.js?v=1.5.1';
import { showAuth } from './auth.js?v=1.5.1';
import { chat } from './chat.js?v=1.5.1';
import { composer } from './composer.js?v=1.5.1';
import { live } from './live.js?v=1.5.1';
import { applySettings, panels } from './panels.js?v=1.5.1';
import { sandbox } from './sandbox/index.js?v=1.5.1';
import { sidebar } from './sidebar.js?v=1.5.1';
import { store } from './store.js?v=1.5.1';
import { $, hydrateIcons, toast } from './ui.js?v=1.5.1';

let started = false;

async function loadConfig() {
  try {
    store.serverConfig = await Promise.race([
      api.get('/config'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
    ]);
  } catch {
    store.serverConfig = {};
  }
}

async function startApp(me) {
  store.user = me.user;
  store.settings = me.user.settings || {};
  store.setBalance(me.balance);
  applySettings();
  $('#auth').hidden = true;
  $('#boot').hidden = true;
  $('#shell').hidden = false;

  if (!started) {
    started = true;
    await sandbox.init(me.user.id);
    chat.init();
    composer.init();
    sidebar.init();
    panels.init();
    live.init();
    window.addEventListener('hashchange', route);
  }
  store.emit('user');
  chat.renderEmpty();
  await sidebar.loadChats();
  route();
  if (!window.matchMedia('(hover: none)').matches) $('#prompt').focus();
}

function route() {
  const m = /^#\/c\/([0-9a-f-]{36})$/i.exec(location.hash);
  if (m && m[1] !== store.chatId) chat.open(m[1]);
  else if (!m && store.chatId && !store.busy) chat.newChat();
  else if (!m) chat.render();
}

window.addEventListener('kb:unauthorized', () => {
  if (!session.token) return;
  session.clear();
  toast('다시 로그인해 주세요.', 'error');
  setTimeout(() => location.replace(location.pathname), 1200);
});

// 잔액 주기적 갱신(자정 초기화 반영)
setInterval(async () => {
  if (!started || store.busy || document.hidden) return;
  try {
    const r = await api.get('/me');
    store.setBalance(r.balance);
  } catch { /* ignore */ }
}, 5 * 60 * 1000);

(async function boot() {
  hydrateIcons();
  await loadConfig();
  if (!session.token) {
    showAuth(async (r) => startApp(r));
    return;
  }
  try {
    const me = await api.get('/me');
    await startApp(me);
  } catch (e) {
    if (e.status === 401) {
      session.clear();
      showAuth(async (r) => startApp(r));
    } else {
      $('#boot').innerHTML = `<div style="text-align:center;padding:24px;max-width:360px"><p>${e.message}</p><button class="btn" onclick="location.reload()">다시 시도</button></div>`;
    }
  }
})();

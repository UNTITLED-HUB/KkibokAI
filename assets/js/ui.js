// 공용 UI 유틸: 아이콘, 요소 생성, 토스트, 메뉴, 대화상자, 포맷터
const P = {
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
  ticket: '<path d="M3 9a3 3 0 0 0 0 6v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3a3 3 0 0 0 0-6V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 11v2M13 17v2"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  paperclip: '<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  'arrow-down': '<path d="M12 5v14M5 12l7 7 7-7"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  'volume-x': '<path d="M11 5 6 9H2v6h4l5 4Z"/><path d="m22 9-6 6M16 9l6 6"/>',
  more: '<circle cx="12" cy="5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="19" r="1.2" fill="currentColor"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  token: '<path d="M12 3 21 12 12 21 3 12Z"/>',
  play: '<path d="M7 4v16l13-8Z"/>',
  'file-plus': '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M12 12v6M9 15h6"/>',
  'folder-plus': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 10v6M9 13h6"/>',
  upload: '<path d="M12 15V3M7 8l5-5 5 5M5 21h14"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 8a4 4 0 0 1-.5 10Z"/><path d="M12 15V11M10 13l2-2 2 2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  save: '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M7 3v5h8M7 21v-7h10v7"/>',
};

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
}

/** data-icon 속성을 가진 요소에 SVG 아이콘을 채운다 */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.dataset.iconDone === el.dataset.icon) return;
    el.innerHTML = icon(el.dataset.icon) + (el.dataset.label ? `<span>${esc(el.dataset.label)}</span>` : '');
    el.dataset.iconDone = el.dataset.icon;
  });
}

export function setIcon(el, name) {
  el.dataset.icon = name;
  delete el.dataset.iconDone;
  hydrateIcons(el.parentNode || el);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h('div', {class:'x', onclick}, child, 'text') */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function toast(msg, type = 'info', ms = 3200) {
  const box = $('#toasts');
  const t = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, msg);
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

let openMenuEl = null;
export function closeMenu() {
  openMenuEl?.remove();
  openMenuEl = null;
}
/** items: [{label, icon, danger, onClick}] */
export function openMenu(anchor, items) {
  closeMenu();
  const m = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    const b = h('button', { role: 'menuitem', class: it.danger ? 'danger' : '', html: (it.icon ? icon(it.icon) : '') + `<span>${esc(it.label)}</span>` });
    b.addEventListener('click', () => {
      closeMenu();
      it.onClick?.();
    });
    m.append(b);
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth;
  const mh = m.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = r.top - mh - 4;
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;
  openMenuEl = m;
  m.querySelector('button')?.focus();
  setTimeout(() => {
    const off = (e) => {
      if (!m.contains(e.target)) {
        closeMenu();
        document.removeEventListener('pointerdown', off, true);
      }
    };
    document.addEventListener('pointerdown', off, true);
  });
}

function dialog(build) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const wrap = h('div', { class: 'dialog-wrap' });
    const box = h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true' });
    wrap.append(box);
    const close = (v) => {
      wrap.remove();
      document.removeEventListener('keydown', onKey, true);
      prevFocus?.focus?.();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('pointerdown', (e) => {
      if (e.target === wrap) close(null);
    });
    build(box, close);
    document.body.append(wrap);
    (box.querySelector('input, textarea') || box.querySelector('.btn-primary, .btn-danger'))?.focus();
  });
}

export function confirmDialog({ title, message = '', confirmText = '확인', danger = false }) {
  return dialog((box, close) => {
    box.append(
      h('h3', {}, title),
      message ? h('p', {}, message) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-ghost', onclick: () => close(false) }, '취소'),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => close(true) }, confirmText)),
    );
  }).then((v) => !!v);
}

export function promptDialog({ title, value = '', placeholder = '', confirmText = '저장', maxLength = 200 }) {
  return dialog((box, close) => {
    const input = h('input', { class: 'input', value, placeholder, maxlength: maxLength });
    const ok = () => close(input.value.trim() || null);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) ok();
    });
    box.append(
      h('h3', {}, title),
      input,
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-ghost', onclick: () => close(null) }, '취소'),
        h('button', { class: 'btn btn-primary', onclick: ok }, confirmText)),
    );
    setTimeout(() => input.select());
  });
}

export function fmtTokens(n) {
  const v = Number(n || 0);
  if (v >= 1000) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1).replace(/\.0$/, '');
  return v.toFixed(2).replace(/0$/, '').replace(/\.0?$/, '');
}

export function fmtSeconds(ms) {
  const s = (ms || 0) / 1000;
  return s < 10 ? `${s.toFixed(1)}초` : s < 60 ? `${Math.round(s)}초` : `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초`;
}

export function fmtBytes(b) {
  const v = Number(b || 0);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat('ko-KR', sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
}

export function fmtWait(sec) {
  if (sec >= 86400) return `${Math.ceil(sec / 86400)}일`;
  if (sec >= 3600) return `${Math.ceil(sec / 3600)}시간`;
  if (sec >= 60) return `${Math.ceil(sec / 60)}분`;
  return `${sec}초`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export const MODE_LABEL = { nobrain: 'NO BRAIN', fast: 'FAST', think: 'THINK', deep: 'DEEP', ultra: 'ULTRA' };
export const MODE_VAR = { nobrain: 'var(--nb)', fast: 'var(--w1)', think: 'var(--w2)', deep: 'var(--w3)', ultra: 'var(--w4)' };
export function modeKey(mode, submode) {
  return mode === 'work' ? (submode || 'fast') : 'nobrain';
}
export function modeTag(mode, submode) {
  return mode === 'work' ? `WORK ${MODE_LABEL[submode || 'fast']}` : 'NO BRAIN';
}

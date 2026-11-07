// Sandbox 파일 관리자: 트리 · 보기/편집 · 업로드 · 다운로드 · 잠금 · 백업 · 휴지통 · 서버 전송
import { session } from '../api.js?v=1.5.0';
import { CONFIG } from '../config.js?v=1.5.0';
import { confirmDialog, esc, fmtBytes, fmtTime, h, icon, openMenu, promptDialog, toast } from '../ui.js?v=1.5.0';
import { archiveBase, archiveKind, entryBytes, makeZip, readArchive } from './archive.js?v=1.5.0';
import { bytesToB64, guessMime, MAX_BYTES, nodeSize, TRASH_DAYS } from './vfs.js?v=1.5.0';

const SERVER_LIMIT = 30 * 1024 * 1024;
const SERVER_FILE_MAX = 10 * 1024 * 1024;
const UPLOAD_MAX = 20 * 1024 * 1024;
const PROTECTED = new Set(['/user']);

const baseName = (p) => p.split('/').pop() || '/';
const dirName = (p) => p.replace(/\/[^/]*$/, '') || '/';
const join = (d, n) => (d === '/' ? '' : d) + '/' + n;
const short = (p) => p.replace(/^\/user(?=\/|$)/, '~');

// ---------- 서버 API (바이너리) ----------
async function serverFetch(path, opts = {}) {
  let res;
  try {
    res = await fetch(CONFIG.API_BASE + path, { ...opts, headers: { ...(opts.headers || {}), authorization: `Bearer ${session.token}` } });
  } catch {
    throw new Error('서버에 연결할 수 없어요');
  }
  if (!res.ok) {
    let msg = `요청 실패 (${res.status})`;
    try {
      msg = (await res.json())?.error?.message || msg;
    } catch { /* not json */ }
    throw new Error(msg);
  }
  return res;
}
const remote = {
  list: async () => (await serverFetch('/files')).json(),
  put: (path, bytes, mime) => serverFetch(`/files?path=${encodeURIComponent(path)}`, { method: 'PUT', headers: { 'content-type': mime || 'application/octet-stream' }, body: bytes }),
  get: async (path) => (await serverFetch(`/files/raw?path=${encodeURIComponent(path)}`)).blob(),
  del: (path) => serverFetch(`/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
};

// ---------- HTML 미리보기 콘솔 연결 스크립트 ----------
const BRIDGE = `<script>(function(){var P=parent;function s(v){try{if(typeof v==='string')return v;if(v instanceof Error)return v.stack||String(v);if(v===undefined)return 'undefined';if(typeof v==='function')return String(v);return JSON.stringify(v,null,1)}catch(e){return String(v)}}
function post(l,a){try{P.postMessage({kb:'console',level:l,args:a},'*')}catch(e){}}
['log','info','warn','error','debug'].forEach(function(l){var o=console[l];console[l]=function(){post(l,[].map.call(arguments,s));o&&o.apply(console,arguments)}});
addEventListener('error',function(e){post('error',[e.message+(e.lineno?' ('+e.lineno+':'+e.colno+')':'')])});
addEventListener('unhandledrejection',function(e){post('error',['Unhandled: '+s(e.reason)])});
addEventListener('message',function(e){if(e.source!==P||!e.data||e.data.kb!=='eval')return;try{post('result',[s((0,eval)(e.data.code))])}catch(err){post('error',[s(err)])}});})();<\/script>`;

function kindOf(abs, n) {
  const name = baseName(abs);
  if (archiveKind(name)) return 'archive';
  if (/\.html?$/i.test(name)) return 'html';
  if (n.binary) {
    const m = n.mime || '';
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('audio/')) return 'audio';
    if (m.startsWith('video/')) return 'video';
    if (m === 'application/pdf') return 'pdf';
    return 'binary';
  }
  if (/\.svg$/i.test(name)) return 'svg';
  return 'text';
}

const HL_LANG = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby', sh: 'bash', md: 'markdown', yml: 'yaml', htm: 'html', html: 'xml', svg: 'xml', rs: 'rust', kt: 'kotlin', cs: 'csharp' };

/** 화면 위 모달 */
function modal(title, { wide = false } = {}) {
  const wrap = h('div', { class: 'preview' });
  const titleEl = h('b', { title }, title);
  const actions = h('div', { class: 'row fm-actions' });
  const body = h('div', { class: 'fm-body' });
  const box = h('div', { class: `preview-box${wide ? ' wide' : ''}`, role: 'dialog', 'aria-label': title }, h('header', {}, titleEl, actions), body);
  wrap.append(box);
  const cleanups = [];
  let beforeClose = null;
  const close = async () => {
    if (beforeClose && !(await beforeClose())) return;
    cleanups.forEach((f) => f());
    wrap.remove();
  };
  const x = h('button', { class: 'icon-btn', 'aria-label': '닫기', html: icon('x'), onclick: close });
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target === wrap) close();
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  document.body.append(wrap);
  return {
    wrap, box, body, titleEl, close,
    setActions(...btns) {
      actions.replaceChildren(...btns.filter(Boolean), x);
    },
    onClose: (f) => cleanups.push(f),
    guard: (f) => (beforeClose = f),
    focus: () => x.focus(),
  };
}

const btn = (label, ic, onclick, cls = '') => h('button', { class: `btn btn-sm ${cls}`, html: (ic ? icon(ic) : '') + `<span>${esc(label)}</span>`, onclick });
const iconBtn = (label, ic, onclick) => h('button', { class: 'icon-btn', title: label, 'aria-label': label, html: icon(ic), onclick });

export class FileManager {
  constructor(vfs, box) {
    this.vfs = vfs;
    this.box = box;
    this.expanded = new Set(['/user', '/user/download', '/user/upload']);
    this.cwd = '/user';
    this.fileInput = h('input', { type: 'file', class: 'fm-file', multiple: true, hidden: true });
    this.dirInput = h('input', { type: 'file', class: 'fm-dir', multiple: true, hidden: true, webkitdirectory: true });
    this.fileInput.onchange = () => this.fromInput(this.fileInput);
    this.dirInput.onchange = () => this.fromInput(this.dirInput);
    document.body.append(this.fileInput, this.dirInput);
    this.bindDrop(box, () => this.cwd);
  }

  // ================= 트리 =================
  render() {
    const box = this.box;
    if (!box) return;
    if (!this.vfs.get(this.cwd) || this.vfs.get(this.cwd).type !== 'dir') this.cwd = '/user';
    const bar = h('div', { class: 'fm-bar' },
      iconBtn('새 파일', 'file-plus', () => this.newFile(this.cwd)),
      iconBtn('새 폴더', 'folder-plus', () => this.newFolder(this.cwd)),
      iconBtn('업로드', 'upload', (e) => openMenu(e.currentTarget, [
        { label: '파일 올리기', icon: 'file', onClick: () => this.pick(false) },
        { label: '폴더 올리기', icon: 'folder', onClick: () => this.pick(true) },
      ])),
      iconBtn('더 보기', 'more', (e) => openMenu(e.currentTarget, [
        { label: `휴지통 (${this.vfs.trash.length})`, icon: 'trash', onClick: () => this.showTrash() },
        { label: `백업 (${this.vfs.backups.length})`, icon: 'archive', onClick: () => this.showBackups() },
        { label: '서버 파일', icon: 'cloud', onClick: () => this.showServer() },
      ])),
    );
    const tree = h('div', { class: 'fm-tree' });
    tree.append(this.node('/user', 0));
    if (this.vfs.get('/tmp')) tree.append(this.node('/tmp', 0));
    const used = this.vfs.usedBytes();
    const foot = h('div', { class: 'fm-foot', title: `휴지통 ${fmtBytes(this.vfs.trashSize())} · 백업 ${fmtBytes(this.vfs.backupSize())} 포함` },
      h('span', {}, short(this.cwd)),
      h('span', {}, `${fmtBytes(used)} / ${MAX_BYTES / 1024 / 1024}MB`));
    box.replaceChildren(bar, tree, foot);
  }

  node(abs, depth) {
    const n = this.vfs.get(abs);
    const name = baseName(abs);
    const lock = n.locked ? icon('lock', 'fm-lock') : '';
    const more = h('span', { class: 'fm-more', role: 'button', tabindex: '-1', title: '메뉴', html: icon('more') });
    more.onclick = (e) => {
      e.stopPropagation();
      this.itemMenu(more, abs);
    };
    if (n.type === 'dir') {
      const open = this.expanded.has(abs);
      const row = h('button', { class: `ft-item dir${abs === this.cwd ? ' active' : ''}`, title: abs, html: icon('folder') + `<span>${esc(name)}</span>${lock}` });
      row.append(more);
      row.onclick = () => {
        if (this.cwd === abs || !open) open ? this.expanded.delete(abs) : this.expanded.add(abs);
        this.cwd = abs;
        this.render();
      };
      row.oncontextmenu = (e) => {
        e.preventDefault();
        this.itemMenu(row, abs);
      };
      this.bindDrop(row, () => abs);
      const wrap = h('div', {}, row);
      if (open && depth < 12) {
        const kids = h('div', { class: 'ft-children' });
        const names = Object.keys(n.children).sort((a, b) => {
          const da = n.children[a].type === 'dir';
          const db = n.children[b].type === 'dir';
          return da === db ? a.localeCompare(b) : da ? -1 : 1;
        });
        for (const k of names) kids.append(this.node(join(abs, k), depth + 1));
        if (!names.length) kids.append(h('div', { class: 'ft-item empty' }, '비어 있음'));
        wrap.append(kids);
      }
      return wrap;
    }
    const img = n.binary && /^image\//.test(n.mime || '');
    const row = h('button', { class: 'ft-item', title: `${abs} · ${fmtBytes(nodeSize(n))}`, html: icon(img ? 'image' : archiveKind(name) ? 'archive' : 'file') + `<span>${esc(name)}</span>${lock}` });
    row.append(more);
    row.onclick = () => {
      this.cwd = dirName(abs);
      this.open(abs);
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      this.itemMenu(row, abs);
    };
    return row;
  }

  itemMenu(anchor, abs) {
    const n = this.vfs.get(abs);
    if (!n) return;
    const isDir = n.type === 'dir';
    const items = [];
    if (isDir) {
      items.push(
        { label: '새 파일', icon: 'file-plus', onClick: () => this.newFile(abs) },
        { label: '새 폴더', icon: 'folder-plus', onClick: () => this.newFolder(abs) },
        { label: '여기에 업로드', icon: 'upload', onClick: () => ((this.cwd = abs), this.pick(false)) },
      );
    } else {
      items.push(
        { label: '열기', icon: 'eye', onClick: () => this.open(abs) },
        { label: '원문 보기', icon: 'code', onClick: () => this.open(abs, 'raw') },
      );
    }
    if (!PROTECTED.has(abs)) items.push({ label: '이름 변경', icon: 'edit', onClick: () => this.rename(abs) });
    items.push(
      { label: n.locked ? '잠금 해제' : '잠금', icon: n.locked ? 'unlock' : 'lock', onClick: () => this.toggleLock(abs) },
      { label: '백업', icon: 'archive', onClick: () => this.backup(abs) },
      { label: isDir ? '다운로드 (zip)' : '다운로드', icon: 'download', onClick: () => this.download(abs) },
      { label: '서버로 전송', icon: 'cloud', onClick: () => this.send(abs) },
    );
    if (!PROTECTED.has(abs)) items.push({ label: '삭제', icon: 'trash', danger: true, onClick: () => this.remove(abs) });
    openMenu(anchor, items);
  }

  // ================= 기본 동작 =================
  try(fn) {
    try {
      return fn();
    } catch (e) {
      toast(e.message, 'error');
      return null;
    }
  }

  async newFile(dir) {
    const path = await promptDialog({ title: '새 파일', value: join(dir, 'untitled.txt'), confirmText: '만들기', maxLength: 300 });
    if (!path) return;
    const abs = this.vfs.resolve(path, dir);
    if (this.vfs.get(abs)) return toast('같은 이름이 이미 있어요', 'error');
    if (this.try(() => this.vfs.writeText(abs, '', { mkdirp: true })) === null) return;
    this.expanded.add(dirName(abs));
    this.cwd = dirName(abs);
    this.open(abs, 'edit');
  }

  async newFolder(dir) {
    const path = await promptDialog({ title: '새 폴더', value: join(dir, 'new-folder'), confirmText: '만들기', maxLength: 300 });
    if (!path) return;
    const abs = this.vfs.resolve(path, dir);
    if (this.vfs.get(abs)) return toast('같은 이름이 이미 있어요', 'error');
    if (this.try(() => this.vfs.mkdir(abs, true)) === null) return;
    this.expanded.add(abs);
    this.expanded.add(dirName(abs));
    this.cwd = abs;
    this.render();
  }

  async rename(abs, onDone) {
    const next = await promptDialog({ title: '이름 변경', value: baseName(abs), confirmText: '변경', maxLength: 300 });
    if (!next || next === baseName(abs)) return;
    const to = this.try(() => this.vfs.rename(abs, next));
    if (to) {
      if (this.expanded.has(abs)) this.expanded.add(to);
      onDone?.(to);
    }
  }

  toggleLock(abs) {
    const locked = !this.vfs.isLocked(abs);
    if (this.try(() => this.vfs.setLocked(abs, locked)) === null) return;
    toast(locked ? '잠갔어요. AI가 바꾸려면 승인이 필요해요.' : '잠금을 풀었어요.');
  }

  async backup(abs) {
    try {
      await this.vfs.backup(abs);
      toast('백업했어요');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  remove(abs, onDone) {
    if (this.try(() => this.vfs.rm(abs, true)) === null) return;
    toast(`휴지통으로 옮겼어요 (${TRASH_DAYS}일 후 삭제)`);
    onDone?.();
  }

  // ================= 업로드 =================
  pick(folder) {
    const input = folder ? this.dirInput : this.fileInput;
    input.value = '';
    input.click();
  }

  fromInput(input) {
    const list = [...input.files].map((f) => ({ file: f, rel: f.webkitRelativePath || f.name }));
    this.upload(list, this.cwd);
  }

  bindDrop(el, dest) {
    el.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', async (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drop');
      const items = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
      const list = items.length ? await collectEntries(items) : [...e.dataTransfer.files].map((f) => ({ file: f, rel: f.name }));
      this.upload(list, dest());
    });
  }

  async upload(list, destDir) {
    if (!list.length) return;
    let ok = 0;
    const errors = [];
    for (const { file, rel } of list) {
      if (file.size > UPLOAD_MAX) {
        errors.push(`${rel}: ${UPLOAD_MAX / 1024 / 1024}MB 초과`);
        continue;
      }
      try {
        const abs = this.vfs.uniquePath(this.vfs.resolve(rel, destDir));
        this.vfs.writeBytes(abs, new Uint8Array(await file.arrayBuffer()), file.type);
        ok++;
      } catch (e) {
        errors.push(`${rel}: ${e.message}`);
        if (/저장 공간/.test(e.message)) break;
      }
    }
    this.expanded.add(destDir);
    for (const { rel } of list) {
      const parts = rel.split('/');
      if (parts.length > 1) this.expanded.add(this.vfs.resolve(parts[0], destDir));
    }
    if (ok) toast(`${ok}개 올렸어요`);
    if (errors.length) toast(errors.slice(0, 3).join('\n') + (errors.length > 3 ? `\n외 ${errors.length - 3}개` : ''), 'error', 6000);
  }

  // ================= 다운로드 =================
  filesUnder(abs) {
    const out = [];
    this.vfs.walk(abs, (p, n) => {
      if (n.type === 'file') out.push({ path: p, node: n });
    });
    return out;
  }

  async download(abs) {
    const n = this.vfs.get(abs);
    if (!n) return;
    try {
      let blob;
      let name = baseName(abs);
      if (n.type === 'dir') {
        const files = this.filesUnder(abs).map(({ path }) => ({ path: path.slice(abs.length + 1), bytes: this.vfs.readBytes(path) }));
        blob = await makeZip(files);
        name += '.zip';
      } else {
        blob = new Blob([this.vfs.readBytes(abs)], { type: n.binary ? n.mime : guessMime(name) || 'text/plain;charset=utf-8' });
      }
      saveBlob(blob, name);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // ================= 서버 전송 =================
  async send(abs) {
    const files = this.filesUnder(abs);
    if (!files.length) return toast('보낼 파일이 없어요');
    const big = files.filter((f) => nodeSize(f.node) > SERVER_FILE_MAX);
    const list = files.filter((f) => nodeSize(f.node) <= SERVER_FILE_MAX);
    try {
      const r = await remote.list();
      const existing = new Map(r.files.map((f) => [f.path, f.size]));
      let used = r.used;
      for (const f of list) used += nodeSize(f.node) - (existing.get(f.path) || 0);
      if (used > r.limit) return toast(`서버 저장 한도(${r.limit / 1024 / 1024}MB)를 넘어요`, 'error');
      let ok = 0;
      for (const f of list) {
        await remote.put(f.path, this.vfs.readBytes(f.path), f.node.binary ? f.node.mime : guessMime(f.path) || 'text/plain');
        ok++;
      }
      toast(`서버로 ${ok}개 보냈어요`);
    } catch (e) {
      toast(e.message, 'error');
    }
    if (big.length) toast(`${big.length}개는 ${SERVER_FILE_MAX / 1024 / 1024}MB를 넘어 보내지 않았어요`, 'error');
  }

  async showServer() {
    const m = modal('서버 파일');
    const load = async () => {
      m.body.replaceChildren(h('p', { class: 'fm-empty' }, '불러오는 중…'));
      let r;
      try {
        r = await remote.list();
      } catch (e) {
        m.body.replaceChildren(h('p', { class: 'fm-empty' }, e.message));
        return;
      }
      const pct = Math.min(100, (r.used / r.limit) * 100);
      const head = h('div', { class: 'fm-quota' },
        h('span', {}, `${fmtBytes(r.used)} / ${r.limit / 1024 / 1024}MB`),
        h('div', { class: 'bar' }, h('i', { style: { width: pct + '%' } })));
      const rows = r.files.map((f) => h('div', { class: 'fm-row' },
        h('div', { class: 't' }, h('b', {}, short(f.path)), h('small', {}, `${fmtBytes(f.size)} · ${fmtTime(f.updated_at)}`)),
        h('div', { class: 'row' },
          btn('가져오기', 'download', () => this.pull(f.path).then(load)),
          iconBtn('기기에 저장', 'save', async () => {
            try {
              saveBlob(await remote.get(f.path), baseName(f.path));
            } catch (e) {
              toast(e.message, 'error');
            }
          }),
          iconBtn('서버에서 삭제', 'trash', async () => {
            if (!(await confirmDialog({ title: '서버에서 삭제할까요?', message: short(f.path), confirmText: '삭제', danger: true }))) return;
            try {
              await remote.del(f.path);
              load();
            } catch (e) {
              toast(e.message, 'error');
            }
          }))));
      m.body.replaceChildren(head, ...(rows.length ? rows : [h('p', { class: 'fm-empty' }, '서버에 보낸 파일이 없어요')]));
    };
    m.setActions(iconBtn('새로고침', 'refresh', load));
    m.focus();
    load();
  }

  async pull(path) {
    try {
      const blob = await remote.get(path);
      let abs = path;
      if (this.vfs.get(abs)) {
        const over = await confirmDialog({ title: '같은 파일이 있어요', message: `${short(abs)}\n덮어쓸까요? 취소하면 새 이름으로 저장해요.`, confirmText: '덮어쓰기' });
        if (!over) abs = this.vfs.uniquePath(abs);
      }
      this.vfs.writeBytes(abs, new Uint8Array(await blob.arrayBuffer()), blob.type);
      this.expanded.add(dirName(abs));
      toast(`가져왔어요: ${short(abs)}`);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // ================= 휴지통 / 백업 =================
  showTrash() {
    const m = modal('휴지통');
    const draw = () => {
      this.vfs.purgeTrash();
      const rows = this.vfs.trash.map((t) => {
        const left = Math.max(0, Math.ceil((t.deletedAt + TRASH_DAYS * 86400_000 - Date.now()) / 86400_000));
        return h('div', { class: 'fm-row' },
          h('div', { class: 't' }, h('b', {}, short(t.path) + (t.node.type === 'dir' ? '/' : '')), h('small', {}, `${fmtBytes(nodeSize(t.node))} · ${left}일 후 삭제`)),
          h('div', { class: 'row' },
            btn('복원', 'refresh', () => {
              const p = this.try(() => this.vfs.restoreTrash(t.id));
              if (p) {
                this.expanded.add(dirName(p));
                toast(`복원했어요: ${short(p)}`);
                draw();
              }
            }),
            iconBtn('영구 삭제', 'trash', async () => {
              if (!(await confirmDialog({ title: '영구 삭제할까요?', message: short(t.path), confirmText: '삭제', danger: true }))) return;
              this.vfs.deleteTrash(t.id);
              draw();
            })));
      });
      m.body.replaceChildren(...(rows.length ? rows : [h('p', { class: 'fm-empty' }, '휴지통이 비어 있어요')]));
    };
    m.setActions(btn('비우기', 'trash', async () => {
      if (!this.vfs.trash.length) return;
      if (!(await confirmDialog({ title: '휴지통을 비울까요?', message: '되돌릴 수 없어요.', confirmText: '비우기', danger: true }))) return;
      this.vfs.deleteTrash();
      draw();
    }, 'btn-ghost'));
    draw();
    m.focus();
  }

  showBackups() {
    const m = modal('백업');
    const draw = () => {
      const rows = this.vfs.backups.map((b) => h('div', { class: 'fm-row' },
        h('div', { class: 't' }, h('b', {}, short(b.path) + (b.node.type === 'dir' ? '/' : '')), h('small', {}, `${fmtBytes(nodeSize(b.node))} · ${fmtTime(new Date(b.createdAt).toISOString())}`)),
        h('div', { class: 'row' },
          btn('복원', 'refresh', () => {
            const p = this.try(() => this.vfs.restoreBackup(b.id));
            if (p) {
              this.expanded.add(dirName(p));
              toast(`복원했어요: ${short(p)}`);
            }
          }),
          iconBtn('백업 삭제', 'trash', async () => {
            if (!(await confirmDialog({ title: '백업을 삭제할까요?', message: short(b.path), confirmText: '삭제', danger: true }))) return;
            await this.vfs.deleteBackup(b.id);
            draw();
          }))));
      m.body.replaceChildren(
        h('p', { class: 'fm-note' }, 'AI는 백업에 접근할 수 없어요.'),
        ...(rows.length ? rows : [h('p', { class: 'fm-empty' }, '백업이 없어요')]));
    };
    m.setActions();
    draw();
    m.focus();
  }

  // ================= 보기 / 편집 =================
  open(abs, mode = 'preview') {
    const n = this.vfs.get(abs);
    if (!n || n.type !== 'file') return;
    let path = abs;
    const kind = kindOf(abs, n);
    if (mode === 'preview' && kind === 'text') mode = 'text';
    const m = modal(short(path), { wide: kind === 'html' || kind === 'pdf' });
    let dirty = false;
    let urls = [];
    let msgHandler = null;
    const revoke = () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls = [];
      if (msgHandler) window.removeEventListener('message', msgHandler);
      msgHandler = null;
    };
    m.onClose(revoke);
    m.guard(async () => !dirty || confirmDialog({ title: '저장하지 않고 닫을까요?', confirmText: '닫기', danger: true }));
    const blobUrl = (node) => {
      const u = URL.createObjectURL(new Blob([this.vfs.readBytes(path)], { type: node.mime || guessMime(path) }));
      urls.push(u);
      return u;
    };

    const draw = async () => {
      revoke();
      dirty = false;
      const node = this.vfs.get(path);
      if (!node) return m.close();
      m.titleEl.textContent = short(path) + (node.locked ? ' 🔒' : '');
      const more = iconBtn('더 보기', 'more', (e) => openMenu(e.currentTarget, [
        { label: '이름 변경', icon: 'edit', onClick: () => this.rename(path, (to) => ((path = to), draw())) },
        { label: node.locked ? '잠금 해제' : '잠금', icon: node.locked ? 'unlock' : 'lock', onClick: () => (this.toggleLock(path), draw()) },
        { label: '백업', icon: 'archive', onClick: () => this.backup(path) },
        { label: '서버로 전송', icon: 'cloud', onClick: () => this.send(path) },
        { label: '삭제', icon: 'trash', danger: true, onClick: () => this.remove(path, () => ((dirty = false), m.close())) },
      ]));
      const dl = iconBtn('다운로드', 'download', () => this.download(path));
      const raw = mode === 'raw';
      const toggle = kind !== 'text' ? btn(raw ? '미리보기' : '원문', raw ? 'eye' : 'code', () => ((mode = raw ? 'preview' : 'raw'), draw()), 'btn-ghost') : null;

      if (mode === 'edit') {
        const ta = h('textarea', { class: 'fm-editor', spellcheck: 'false', 'aria-label': '파일 내용' });
        ta.value = node.content || '';
        ta.addEventListener('input', () => (dirty = true));
        const save = () => {
          if (this.try(() => this.vfs.writeText(path, ta.value)) === null) return;
          dirty = false;
          toast('저장했어요');
          mode = kind === 'text' ? 'text' : 'preview';
          draw();
        };
        ta.addEventListener('keydown', (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            save();
          } else if (e.key === 'Tab') {
            e.preventDefault();
            ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
            dirty = true;
          }
        });
        m.setActions(btn('취소', null, async () => {
          if (dirty && !(await confirmDialog({ title: '변경 내용을 버릴까요?', confirmText: '버리기', danger: true }))) return;
          mode = kind === 'text' ? 'text' : 'preview';
          draw();
        }, 'btn-ghost'), btn('저장', 'check', save, 'btn-primary'));
        m.body.replaceChildren(ta);
        ta.focus();
        return;
      }

      const editable = !node.binary;
      const edit = editable ? btn('편집', 'edit', () => ((mode = 'edit'), draw()), 'btn-ghost') : null;

      if (mode === 'raw' || mode === 'text') {
        m.setActions(toggle, edit, dl, more);
        m.body.replaceChildren(this.textView(path, node, mode === 'raw'));
        return;
      }

      if (kind === 'html') {
        const frame = h('iframe', { class: 'fm-frame', sandbox: 'allow-scripts allow-forms allow-modals allow-popups', title: '미리보기' });
        const logs = h('div', { class: 'fm-logs' });
        const input = h('input', { class: 'fm-eval', placeholder: '> JavaScript 실행', spellcheck: 'false' });
        const consoleBox = h('div', { class: 'fm-console', hidden: true }, logs, input);
        const log = (level, text) => {
          logs.append(h('div', { class: `lg ${level}` }, text));
          logs.scrollTop = logs.scrollHeight;
          if (level === 'error') consoleBtn.classList.add('has-error');
        };
        input.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' || e.isComposing || !input.value.trim()) return;
          log('input', '> ' + input.value);
          frame.contentWindow?.postMessage({ kb: 'eval', code: input.value }, '*');
          input.value = '';
        });
        msgHandler = (e) => {
          if (e.source !== frame.contentWindow || e.data?.kb !== 'console') return;
          log(e.data.level, (e.data.args || []).join(' '));
        };
        window.addEventListener('message', msgHandler);
        const reload = () => {
          logs.replaceChildren();
          consoleBtn.classList.remove('has-error');
          frame.srcdoc = this.buildHtml(path);
        };
        const consoleBtn = btn('콘솔', 'terminal', () => {
          consoleBox.hidden = !consoleBox.hidden;
          if (!consoleBox.hidden) input.focus();
        }, 'btn-ghost');
        m.setActions(iconBtn('새로고침', 'refresh', reload), consoleBtn, toggle, edit, dl, more);
        m.body.replaceChildren(h('div', { class: 'fm-html' }, frame, consoleBox));
        reload();
        return;
      }

      if (kind === 'archive') {
        m.setActions(btn('압축 해제', 'archive', () => this.extract(path), 'btn-primary'), toggle, dl, more);
        m.body.replaceChildren(h('p', { class: 'fm-empty' }, '읽는 중…'));
        try {
          const entries = await readArchive(this.vfs.readBytes(path), baseName(path));
          entries.sort((a, b) => a.path.localeCompare(b.path));
          const total = entries.filter((e) => !e.dir).reduce((s, e) => s + (e.size || 0), 0);
          m.body.replaceChildren(
            h('p', { class: 'fm-note' }, `파일 ${entries.filter((e) => !e.dir).length}개 · ${fmtBytes(total)}`),
            h('div', { class: 'fm-archive' }, ...entries.slice(0, 2000).map((e) => {
              const depth = e.path.split('/').length - 1;
              return h('div', { class: 'ar-item', style: { paddingLeft: 8 + depth * 14 + 'px' }, html: icon(e.dir ? 'folder' : 'file') + `<span>${esc(baseName(e.path))}</span>` + (e.dir ? '' : `<small>${fmtBytes(e.size || 0)}</small>`) });
            })));
        } catch (e) {
          m.body.replaceChildren(h('p', { class: 'fm-empty' }, `열 수 없어요: ${e.message}`));
        }
        return;
      }

      m.setActions(toggle, edit, dl, more);
      let view;
      if (kind === 'image') view = h('div', { class: 'fm-media' }, h('img', { src: blobUrl(node), alt: baseName(path) }));
      else if (kind === 'svg') view = h('div', { class: 'fm-media checker' }, h('img', { src: `data:image/svg+xml;base64,${bytesToB64(this.vfs.readBytes(path))}`, alt: baseName(path) }));
      else if (kind === 'audio') view = h('div', { class: 'fm-media' }, h('audio', { src: blobUrl(node), controls: true }));
      else if (kind === 'video') view = h('div', { class: 'fm-media' }, h('video', { src: blobUrl(node), controls: true }));
      else if (kind === 'pdf') view = h('iframe', { class: 'fm-frame', src: blobUrl(node), title: 'PDF' });
      else {
        view = h('div', { class: 'fm-empty' },
          h('p', {}, `미리 볼 수 없는 형식이에요 (${node.mime || '알 수 없음'}, ${fmtBytes(nodeSize(node))})`),
          btn('원문 텍스트로 보기', 'code', () => ((mode = 'raw'), draw())));
      }
      m.body.replaceChildren(view);
    };
    draw();
    m.focus();
  }

  textView(path, node, raw) {
    const LIMIT = 2 * 1024 * 1024;
    let text;
    let cut = false;
    if (node.binary) {
      const bytes = this.vfs.readBytes(path);
      cut = bytes.length > LIMIT;
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, LIMIT));
    } else {
      text = node.content || '';
      cut = text.length > LIMIT;
      if (cut) text = text.slice(0, LIMIT);
    }
    const code = h('code', {});
    const ext = (baseName(path).match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
    const lang = HL_LANG[ext] || ext;
    if (!raw && !node.binary && window.hljs && lang && window.hljs.getLanguage(lang) && text.length < 300_000) {
      code.innerHTML = window.hljs.highlight(text, { language: lang }).value;
      code.className = 'hljs';
    } else code.textContent = text || '(빈 파일)';
    return h('div', { class: 'fm-text' }, h('pre', {}, code), cut ? h('p', { class: 'fm-note' }, '앞부분 2MB만 표시했어요') : null);
  }

  /** HTML 미리보기: 같은 샌드박스 안의 css·js·이미지 연결 + 콘솔 브리지 */
  buildHtml(path) {
    const html = this.vfs.readText(path);
    const base = dirName(path);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const refs = [['link[href]', 'href'], ['script[src]', 'src'], ['img[src]', 'src'], ['source[src]', 'src'], ['audio[src]', 'src'], ['video[src]', 'src'], ['iframe[src]', 'src']];
    for (const [sel, attr] of refs) {
      for (const el of doc.querySelectorAll(sel)) {
        const v = el.getAttribute(attr);
        if (!v || /^([a-z]+:|\/\/|#)/i.test(v)) continue;
        const p = this.vfs.resolve(decodeURIComponent(v.split(/[?#]/)[0]), base);
        const n = this.vfs.get(p);
        if (n?.type !== 'file') continue;
        const mime = n.binary ? n.mime : (guessMime(p) || 'text/plain') + ';charset=utf-8';
        el.setAttribute(attr, `data:${mime};base64,${bytesToB64(this.vfs.readBytes(p))}`);
      }
    }
    const head = doc.head || doc.documentElement;
    head.insertAdjacentHTML('afterbegin', BRIDGE);
    return '<!doctype html>\n' + doc.documentElement.outerHTML;
  }

  async extract(path) {
    const name = baseName(path);
    try {
      const entries = await readArchive(this.vfs.readBytes(path), name);
      const parent = dirName(path);
      let dest;
      if (archiveKind(name) === 'gz') {
        dest = this.vfs.uniquePath(join(parent, archiveBase(name)));
        this.vfs.writeBytes(dest, await entryBytes(entries[0]));
      } else {
        dest = this.vfs.uniquePath(join(parent, archiveBase(name)));
        this.vfs.mkdir(dest, true);
        for (const e of entries) {
          const p = join(dest, e.path);
          if (e.dir) this.vfs.mkdir(p, true, true);
          else this.vfs.writeBytes(p, await entryBytes(e));
        }
        this.expanded.add(dest);
      }
      this.expanded.add(parent);
      toast(`압축을 풀었어요: ${short(dest)}`);
    } catch (e) {
      toast(`압축 해제 실패: ${e.message}`, 'error');
    }
  }
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** 끌어다 놓은 폴더 펼치기 → [{ file, rel }] */
async function collectEntries(entries) {
  const out = [];
  const readAll = (reader) => new Promise((resolve) => {
    const acc = [];
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) return resolve(acc);
      acc.push(...batch);
      next();
    }, () => resolve(acc));
    next();
  });
  const walk = async (entry, prefix) => {
    if (out.length > 5000) return;
    if (entry.isFile) {
      const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
      if (file) out.push({ file, rel: prefix + entry.name });
    } else if (entry.isDirectory) {
      for (const child of await readAll(entry.createReader())) await walk(child, prefix + entry.name + '/');
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

// 가상 파일시스템 — 모든 파일은 이 브라우저의 IndexedDB 에만 저장 (실제 OS 와 분리)
//  - 잠금: AI 가 잠긴 항목을 바꾸려 하면 LockedError → 사용자 승인 후 다시 실행
//  - 휴지통: 삭제한 항목은 7일 보관 후 자동 삭제
//  - 백업: 파일 트리 밖에 보관해 AI(셸·도구)가 접근할 수 없음
const DB_NAME = 'kkibok-sandbox';
const STORE = 'fs';
export const MAX_BYTES = 100 * 1024 * 1024;
export const TRASH_DAYS = 7;

let dbp = null;
function idb() {
  dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => {
      dbp = null;
      reject(r.error);
    };
  });
  return dbp;
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    tx.onsuccess = () => resolve(tx.result);
    tx.onerror = () => reject(tx.error);
  });
}
async function idbPut(key, val) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export class FsError extends Error {}
export class LockedError extends FsError {
  constructor(lockPath, abs) {
    super(`'${abs}': Permission denied (잠긴 항목)`);
    this.lockPath = lockPath;
    this.abs = abs;
  }
}

const now = () => Date.now();
const dir = (children = {}) => ({ type: 'dir', children, mtime: now() });
const file = (content = '') => ({ type: 'file', content, mtime: now() });
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + now());

function defaultTree() {
  return dir({
    user: dir({
      download: dir(),
      upload: dir(),
      'README.txt': file(
        'KkibokAI Sandbox Linux\n\n' +
        '/user/download  AI 결과물\n' +
        '/user/upload    채팅 첨부 파일\n\n' +
        "명령어 목록: help\n",
      ),
    }),
    tmp: dir(),
    etc: dir({
      hostname: file('kkibok\n'),
      motd: file('KkibokAI Sandbox Linux\n'),
    }),
  });
}

export function nodeSize(n) {
  if (!n) return 0;
  if (n.type === 'file') return n.binary ? Math.floor((n.data?.length || 0) * 0.75) : new Blob([n.content || '']).size;
  let s = 0;
  for (const c of Object.values(n.children)) s += nodeSize(c);
  return s;
}

// ---------- 바이트 변환 ----------
export function b64ToBytes(b64) {
  const bin = atob(b64 || '');
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|py|java|kt|c|h|cc|cpp|hpp|cs|go|rs|rb|php|swift|sh|bash|zsh|sql|ya?ml|toml|ini|cfg|conf|log|env|bat|ps1|lua|r|dart|vue|svelte|svg|gitignore|dockerfile|makefile)$/i;
export function looksText(name, mime = '') {
  return /^text\//.test(mime) || /json|xml|javascript|svg/.test(mime) || TEXT_EXT.test(name) || !/\.[^/]+$/.test(name);
}
export function guessMime(name) {
  const e = (name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || '';
  return ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar',
    html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
    md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', xml: 'application/xml',
  })[e] || '';
}

export class VFS {
  constructor(userId) {
    this.key = `fs:${userId}`;
    this.trashKey = `trash:${userId}`;
    this.backupKey = `backup:${userId}`;
    this.root = defaultTree();
    this.trash = []; // [{id, path, node, deletedAt}]
    this.backups = []; // [{id, path, node, createdAt}]
    this.listeners = new Set();
    this.timer = null;
    // AI 실행 중 잠금 검사
    this.actor = 'user';
    this.approved = new Set();
    this.denied = new Set();
    this.lockHit = null;
  }

  async load() {
    try {
      const data = await idbGet(this.key);
      if (data && data.type === 'dir') this.root = data;
      this.trash = (await idbGet(this.trashKey)) || [];
      this.backups = (await idbGet(this.backupKey)) || [];
    } catch (e) {
      console.warn('sandbox load failed', e);
    }
    for (const p of ['/user', '/user/download', '/user/upload', '/tmp']) {
      if (!this.get(p)) this.mkdir(p, true, true);
    }
    this.purgeTrash();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }

  async flush() {
    clearTimeout(this.timer);
    try {
      await idbPut(this.key, this.root);
      await idbPut(this.trashKey, this.trash);
    } catch (e) {
      console.warn('sandbox save failed', e);
    }
    for (const fn of this.listeners) fn();
  }

  async saveBackups() {
    try {
      await idbPut(this.backupKey, this.backups);
    } catch (e) {
      console.warn('backup save failed', e);
    }
    for (const fn of this.listeners) fn();
  }

  async reset() {
    this.root = defaultTree();
    await this.flush();
  }

  totalSize() {
    return nodeSize(this.root);
  }
  trashSize() {
    return this.trash.reduce((s, t) => s + nodeSize(t.node), 0);
  }
  backupSize() {
    return this.backups.reduce((s, b) => s + nodeSize(b.node), 0);
  }
  usedBytes() {
    return this.totalSize() + this.trashSize() + this.backupSize();
  }

  /** 경로 정규화 */
  resolve(path, cwd = '/user') {
    let p = String(path ?? '').trim();
    if (!p) p = cwd;
    if (p === '~') p = '/user';
    else if (p.startsWith('~/')) p = '/user/' + p.slice(2);
    if (!p.startsWith('/')) p = (cwd.endsWith('/') ? cwd : cwd + '/') + p;
    const out = [];
    for (const part of p.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return '/' + out.join('/');
  }

  get(abs) {
    if (abs === '/') return this.root;
    let n = this.root;
    for (const part of abs.split('/').filter(Boolean)) {
      if (!n || n.type !== 'dir') return null;
      n = n.children[part];
    }
    return n || null;
  }

  parent(abs) {
    const parts = abs.split('/').filter(Boolean);
    const name = parts.pop();
    const pAbs = '/' + parts.join('/');
    return { parent: this.get(pAbs), name, parentPath: pAbs };
  }

  checkQuota(extra) {
    if (this.usedBytes() + extra > MAX_BYTES) throw new FsError(`저장 공간(${MAX_BYTES / 1024 / 1024}MB)이 부족합니다`);
  }

  // ---------------- 잠금 ----------------
  /** abs 자신 또는 상위 폴더 중 잠긴 경로 */
  lockedBy(abs) {
    if (this.root.locked) return '/';
    let n = this.root;
    let cur = '';
    for (const part of abs.split('/').filter(Boolean)) {
      n = n?.type === 'dir' ? n.children[part] : null;
      if (!n) return null;
      cur += '/' + part;
      if (n.locked) return cur;
    }
    return null;
  }
  isLocked(abs) {
    return !!this.get(abs)?.locked;
  }
  hasLocks() {
    let found = false;
    const go = (n) => {
      if (found || !n) return;
      if (n.locked) found = true;
      else if (n.type === 'dir') for (const c of Object.values(n.children)) go(c);
    };
    go(this.root);
    return found;
  }
  setLocked(abs, locked) {
    if (this.actor === 'ai') throw new FsError(`'${abs}': Permission denied`);
    const n = this.get(abs);
    if (!n) throw new FsError(`'${abs}': 없는 항목입니다`);
    if (locked) n.locked = true;
    else delete n.locked;
    this.changed();
  }
  guard(abs) {
    if (this.actor !== 'ai') return;
    const lp = this.lockedBy(abs);
    if (!lp || this.approved.has(lp)) return;
    if (!this.denied.has(lp) && !this.lockHit) this.lockHit = { lockPath: lp, abs };
    throw new LockedError(lp, abs);
  }

  /** AI 실행 전 상태 저장 / 되돌리기 */
  snapshot() {
    return { root: structuredClone(this.root), trash: structuredClone(this.trash) };
  }
  rollback(s) {
    this.root = s.root;
    this.trash = s.trash;
    this.changed();
  }

  // ---------------- 파일 조작 ----------------
  mkdir(abs, recursive = false, silent = false) {
    if (abs === '/') return;
    this.guard(abs);
    const parts = abs.split('/').filter(Boolean);
    let n = this.root;
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      cur += '/' + parts[i];
      const child = n.children[parts[i]];
      if (!child) {
        if (i < parts.length - 1 && !recursive) throw new FsError(`'${cur}': 그런 파일이나 디렉터리가 없습니다`);
        n.children[parts[i]] = dir();
        n.mtime = now();
      } else if (child.type !== 'dir') {
        throw new FsError(`'${cur}': 디렉터리가 아닙니다`);
      } else if (i === parts.length - 1 && !recursive && !silent) {
        throw new FsError(`'${abs}': 파일이 이미 있습니다`);
      }
      n = n.children[parts[i]];
    }
    this.changed();
  }

  readdir(abs) {
    const n = this.get(abs);
    if (!n) throw new FsError(`'${abs}': 그런 파일이나 디렉터리가 없습니다`);
    if (n.type !== 'dir') throw new FsError(`'${abs}': 디렉터리가 아닙니다`);
    return Object.keys(n.children).sort((a, b) => a.localeCompare(b));
  }

  readText(abs) {
    const n = this.get(abs);
    if (!n) throw new FsError(`${abs}: 그런 파일이나 디렉터리가 없습니다`);
    if (n.type === 'dir') throw new FsError(`${abs}: 디렉터리입니다`);
    if (n.binary) return `[바이너리 파일: ${n.mime || 'application/octet-stream'}, ${nodeSize(n)} bytes]`;
    return n.content || '';
  }

  /** 파일 내용을 바이트로 */
  readBytes(abs) {
    const n = this.get(abs);
    if (!n || n.type !== 'file') throw new FsError(`${abs}: 파일이 아닙니다`);
    return n.binary ? b64ToBytes(n.data) : new TextEncoder().encode(n.content || '');
  }

  ensureParent(abs, mkdirp) {
    const { parent, name, parentPath } = this.parent(abs);
    if (!name) throw new FsError(`'${abs}': 파일 이름이 필요합니다`);
    let par = parent;
    if (!par) {
      if (!mkdirp) throw new FsError(`'${parentPath}': 그런 파일이나 디렉터리가 없습니다`);
      this.mkdir(parentPath, true);
      par = this.get(parentPath);
    }
    if (par.type !== 'dir') throw new FsError(`'${parentPath}': 디렉터리가 아닙니다`);
    return { par, name };
  }

  writeText(abs, content, { append = false, mkdirp = false } = {}) {
    this.guard(abs);
    const { par, name } = this.ensureParent(abs, mkdirp);
    const ex = par.children[name];
    if (ex?.type === 'dir') throw new FsError(`'${abs}': 디렉터리입니다`);
    const text = String(content ?? '');
    this.checkQuota(new Blob([text]).size - (ex ? nodeSize(ex) : 0));
    if (append && ex && !ex.binary) {
      ex.content += text;
      ex.mtime = now();
    } else {
      par.children[name] = { ...file(text), ...(ex?.locked ? { locked: true } : {}) };
    }
    par.mtime = now();
    this.changed();
  }

  writeBinary(abs, base64, mime, { mkdirp = true } = {}) {
    this.guard(abs);
    const { par, name } = this.ensureParent(abs, mkdirp);
    const ex = par.children[name];
    if (ex?.type === 'dir') throw new FsError(`'${abs}': 디렉터리입니다`);
    this.checkQuota(base64.length * 0.75 - (ex ? nodeSize(ex) : 0));
    par.children[name] = { type: 'file', binary: true, mime: mime || guessMime(name) || 'application/octet-stream', data: base64, mtime: now(), ...(ex?.locked ? { locked: true } : {}) };
    par.mtime = now();
    this.changed();
  }

  /** 바이트를 받아 텍스트/바이너리 자동 판별해 저장 */
  writeBytes(abs, bytes, mime = '', opts = {}) {
    const name = abs.split('/').pop();
    if (bytes.length <= 5 * 1024 * 1024 && looksText(name, mime)) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (!text.includes('\u0000')) return this.writeText(abs, text, { mkdirp: true, ...opts });
      } catch { /* 바이너리 */ }
    }
    return this.writeBinary(abs, bytesToB64(bytes), mime || guessMime(name), { mkdirp: true });
  }

  touch(abs) {
    const n = this.get(abs);
    if (n) {
      this.guard(abs);
      n.mtime = now();
      this.changed();
    } else this.writeText(abs, '');
  }

  /** 삭제 = 휴지통으로 이동 */
  rm(abs, recursive = false) {
    if (abs === '/' || abs === '/user') throw new FsError(`'${abs}' 은(는) 삭제할 수 없습니다`);
    const { parent, name } = this.parent(abs);
    const n = parent?.children?.[name];
    if (!n) throw new FsError(`'${abs}': 그런 파일이나 디렉터리가 없습니다`);
    if (n.type === 'dir' && !recursive) throw new FsError(`'${abs}': 디렉터리입니다 (-r 옵션 필요)`);
    this.guard(abs);
    if (n.type === 'dir') this.walk(abs, (p) => this.guard(p)); // 안쪽에 잠긴 항목이 있으면 막음
    delete parent.children[name];
    parent.mtime = now();
    this.trash.unshift({ id: uid(), path: abs, node: n, deletedAt: now() });
    this.changed();
  }

  rmdir(abs) {
    const n = this.get(abs);
    if (!n) throw new FsError(`'${abs}': 그런 파일이나 디렉터리가 없습니다`);
    if (n.type !== 'dir') throw new FsError(`'${abs}': 디렉터리가 아닙니다`);
    if (Object.keys(n.children).length) throw new FsError(`'${abs}': 디렉터리가 비어 있지 않습니다`);
    this.rm(abs, true);
  }

  clone(n) {
    return structuredClone(n);
  }

  copy(src, dst, { recursive = false, move = false } = {}) {
    const s = this.get(src);
    if (!s) throw new FsError(`'${src}': 그런 파일이나 디렉터리가 없습니다`);
    if (s.type === 'dir' && !recursive && !move) throw new FsError(`'${src}': 디렉터리입니다 (-r 옵션 필요)`);
    let target = dst;
    const d = this.get(dst);
    if (d?.type === 'dir') target = (dst === '/' ? '' : dst) + '/' + src.split('/').pop();
    if (target === src) throw new FsError(`'${src}' 와(과) '${target}' 은(는) 같은 파일입니다`);
    if (s.type === 'dir' && (target + '/').startsWith(src + '/')) throw new FsError('디렉터리를 자기 자신 안으로 옮길 수 없습니다');
    this.guard(target);
    if (move) {
      this.guard(src);
      if (s.type === 'dir') this.walk(src, (p) => this.guard(p));
    }
    const { parent, name, parentPath } = this.parent(target);
    if (!parent || parent.type !== 'dir') throw new FsError(`'${parentPath}': 그런 디렉터리가 없습니다`);
    if (parent.children[name]?.type === 'dir' && s.type !== 'dir') throw new FsError(`'${target}': 디렉터리입니다`);
    if (!move) this.checkQuota(nodeSize(s));
    parent.children[name] = move ? s : this.clone(s);
    parent.children[name].mtime = now();
    parent.mtime = now();
    if (move) {
      const sp = this.parent(src);
      delete sp.parent.children[sp.name];
    }
    this.changed();
    return target;
  }

  /** 이름 변경(같은 폴더) 또는 경로 이동 */
  rename(abs, next) {
    const target = next.includes('/') ? this.resolve(next, this.parent(abs).parentPath) : this.parent(abs).parentPath.replace(/\/$/, '') + '/' + next;
    if (target === abs) return abs;
    if (this.get(target)) throw new FsError(`'${target}': 이미 있습니다`);
    return this.copy(abs, target, { move: true });
  }

  /** 같은 이름이 있으면 "이름 (2).ext" 형태로 */
  uniquePath(abs) {
    if (!this.get(abs)) return abs;
    const m = abs.match(/^(.*?)(\.[^./]+)?$/);
    for (let i = 2; i < 1000; i++) {
      const p = `${m[1]} (${i})${m[2] || ''}`;
      if (!this.get(p)) return p;
    }
    return abs + '-' + now();
  }

  /** 노드를 경로에 넣기 (복원·압축 해제용, 사용자 동작) */
  place(abs, node) {
    const { par, name } = this.ensureParent(abs, true);
    this.checkQuota(nodeSize(node));
    par.children[name] = node;
    par.mtime = now();
    this.changed();
  }

  // ---------------- 휴지통 ----------------
  purgeTrash() {
    const limit = now() - TRASH_DAYS * 86400_000;
    const before = this.trash.length;
    this.trash = this.trash.filter((t) => t.deletedAt > limit);
    if (this.trash.length !== before) this.changed();
  }
  restoreTrash(id) {
    const i = this.trash.findIndex((t) => t.id === id);
    if (i < 0) throw new FsError('휴지통에 없는 항목입니다');
    const t = this.trash[i];
    const path = this.uniquePath(t.path);
    const { par, name } = this.ensureParent(path, true);
    par.children[name] = t.node;
    this.trash.splice(i, 1);
    this.changed();
    return path;
  }
  deleteTrash(id) {
    this.trash = id ? this.trash.filter((t) => t.id !== id) : [];
    this.changed();
  }

  // ---------------- 백업 (AI 접근 불가) ----------------
  backup(abs) {
    const n = this.get(abs);
    if (!n) throw new FsError(`'${abs}': 없는 항목입니다`);
    this.checkQuota(nodeSize(n));
    this.backups.unshift({ id: uid(), path: abs, node: this.clone(n), createdAt: now() });
    return this.saveBackups();
  }
  restoreBackup(id) {
    const b = this.backups.find((x) => x.id === id);
    if (!b) throw new FsError('없는 백업입니다');
    const path = this.uniquePath(b.path);
    this.place(path, this.clone(b.node));
    return path;
  }
  deleteBackup(id) {
    this.backups = this.backups.filter((b) => b.id !== id);
    return this.saveBackups();
  }

  /** 디렉터리 트리 문자열 */
  tree(abs, maxDepth = 3, maxLines = 300) {
    const root = this.get(abs);
    if (!root) throw new FsError(`'${abs}': 그런 파일이나 디렉터리가 없습니다`);
    const lines = [abs];
    let dirs = 0;
    let files = 0;
    const walk = (n, prefix, depth) => {
      if (n.type !== 'dir' || depth > maxDepth) return;
      const names = Object.keys(n.children).sort();
      names.forEach((name, i) => {
        if (lines.length >= maxLines) return;
        const last = i === names.length - 1;
        const c = n.children[name];
        lines.push(`${prefix}${last ? '└── ' : '├── '}${name}${c.type === 'dir' ? '/' : ''}${c.locked ? ' [잠김]' : ''}`);
        if (c.type === 'dir') {
          dirs++;
          walk(c, prefix + (last ? '    ' : '│   '), depth + 1);
        } else files++;
      });
    };
    walk(root, '', 1);
    if (lines.length >= maxLines) lines.push('…(생략)');
    lines.push('', `디렉터리 ${dirs}개, 파일 ${files}개`);
    return lines.join('\n');
  }

  /** 재귀 순회: cb(absPath, node) */
  walk(abs, cb, maxDepth = 20) {
    const n = this.get(abs);
    if (!n) throw new FsError(`'${abs}': 그런 파일이나 디렉터리가 없습니다`);
    const go = (p, node, d) => {
      cb(p, node);
      if (node.type === 'dir' && d < maxDepth) {
        for (const name of Object.keys(node.children).sort()) go((p === '/' ? '' : p) + '/' + name, node.children[name], d + 1);
      }
    };
    go(abs, n, 0);
  }
}

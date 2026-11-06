// 가상 파일시스템 — 사용자별로 브라우저 IndexedDB 에 저장 (실제 OS 와 완전히 분리)
const DB_NAME = 'kkibok-sandbox';
const STORE = 'fs';
export const MAX_BYTES = 50 * 1024 * 1024;

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
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

const now = () => Date.now();
const dir = (children = {}) => ({ type: 'dir', children, mtime: now() });
const file = (content = '') => ({ type: 'file', content, mtime: now() });

function defaultTree() {
  return dir({
    user: dir({
      download: dir(),
      upload: dir(),
      'README.txt': file(
        'KkibokAI Sandbox Linux에 오신 것을 환영합니다.\n\n' +
        '- 이 환경은 브라우저 안에서만 동작하는 가상 Linux입니다. 실제 컴퓨터와 분리되어 있습니다.\n' +
        '- /user/download : AI가 만든 결과물이 저장됩니다.\n' +
        '- /user/upload   : 채팅에 첨부한 파일이 복사됩니다.\n' +
        "- 'help' 를 입력하면 사용할 수 있는 명령어를 볼 수 있습니다.\n",
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

export class VFS {
  constructor(userId) {
    this.key = `fs:${userId}`;
    this.root = defaultTree();
    this.listeners = new Set();
    this.timer = null;
  }

  async load() {
    try {
      const data = await idbGet(this.key);
      if (data && data.type === 'dir') this.root = data;
    } catch (e) {
      console.warn('sandbox load failed', e);
    }
    // 기본 폴더 보장
    for (const p of ['/user', '/user/download', '/user/upload', '/tmp']) {
      if (!this.get(p)) this.mkdir(p, true, true);
    }
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      idbPut(this.key, this.root).catch((e) => console.warn('sandbox save failed', e));
      for (const fn of this.listeners) fn();
    }, 250);
  }

  async reset() {
    this.root = defaultTree();
    await idbPut(this.key, this.root);
    for (const fn of this.listeners) fn();
  }

  totalSize() {
    return nodeSize(this.root);
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
    if (this.totalSize() + extra > MAX_BYTES) throw new FsError(`저장 공간 한도(${MAX_BYTES / 1024 / 1024}MB)를 넘습니다`);
  }

  mkdir(abs, recursive = false, silent = false) {
    if (abs === '/') return;
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

  writeText(abs, content, { append = false, mkdirp = false } = {}) {
    const { parent, name, parentPath } = this.parent(abs);
    if (!name) throw new FsError(`'${abs}': 파일 이름이 필요합니다`);
    let par = parent;
    if (!par) {
      if (!mkdirp) throw new FsError(`'${parentPath}': 그런 파일이나 디렉터리가 없습니다`);
      this.mkdir(parentPath, true);
      par = this.get(parentPath);
    }
    if (par.type !== 'dir') throw new FsError(`'${parentPath}': 디렉터리가 아닙니다`);
    const ex = par.children[name];
    if (ex?.type === 'dir') throw new FsError(`'${abs}': 디렉터리입니다`);
    const text = String(content ?? '');
    this.checkQuota(text.length - (ex ? nodeSize(ex) : 0));
    if (append && ex && !ex.binary) {
      ex.content += text;
      ex.mtime = now();
    } else {
      par.children[name] = file(text);
    }
    par.mtime = now();
    this.changed();
  }

  writeBinary(abs, base64, mime, { mkdirp = true } = {}) {
    const { parent, name, parentPath } = this.parent(abs);
    let par = parent;
    if (!par) {
      if (!mkdirp) throw new FsError(`'${parentPath}': 그런 파일이나 디렉터리가 없습니다`);
      this.mkdir(parentPath, true);
      par = this.get(parentPath);
    }
    this.checkQuota(base64.length * 0.75);
    par.children[name] = { type: 'file', binary: true, mime, data: base64, mtime: now() };
    par.mtime = now();
    this.changed();
  }

  touch(abs) {
    const n = this.get(abs);
    if (n) {
      n.mtime = now();
      this.changed();
    } else this.writeText(abs, '');
  }

  rm(abs, recursive = false) {
    if (abs === '/' || abs === '/user') throw new FsError(`'${abs}' 은(는) 삭제할 수 없습니다`);
    const { parent, name } = this.parent(abs);
    const n = parent?.children?.[name];
    if (!n) throw new FsError(`'${abs}': 그런 파일이나 디렉터리가 없습니다`);
    if (n.type === 'dir' && !recursive) throw new FsError(`'${abs}': 디렉터리입니다 (-r 옵션 필요)`);
    delete parent.children[name];
    parent.mtime = now();
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
    return JSON.parse(JSON.stringify(n));
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
    const { parent, name, parentPath } = this.parent(target);
    if (!parent || parent.type !== 'dir') throw new FsError(`'${parentPath}': 그런 디렉터리가 없습니다`);
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
        lines.push(`${prefix}${last ? '└── ' : '├── '}${name}${c.type === 'dir' ? '/' : ''}`);
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

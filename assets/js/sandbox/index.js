// Sandbox Linux: 터미널 UI + 파일 탐색 + AI 도구 실행 연결
import { $, confirmDialog, esc, h, toast } from '../ui.js?v=1.5.0';
import { FileManager } from './files.js?v=1.5.0';
import { Shell, stripAnsi } from './shell.js?v=1.5.0';
import { VFS } from './vfs.js?v=1.5.0';

// ---------- ANSI → HTML ----------
function ansiToHtml(s) {
  let html = '';
  let cls = [];
  let last = 0;
  const re = /\x1b\[([0-9;]*)m/g;
  let m;
  const flush = (txt) => {
    if (!txt) return;
    html += cls.length ? `<span class="${cls.map((c) => 'ansi-' + c).join(' ')}">${esc(txt)}</span>` : esc(txt);
  };
  while ((m = re.exec(s))) {
    flush(s.slice(last, m.index));
    last = re.lastIndex;
    const codes = (m[1] || '0').split(';');
    for (const c of codes) {
      if (c === '0' || c === '') cls = [];
      else cls = [...cls.filter((x) => !(x.length === 2 && c.length === 2 && x[0] === c[0])), c];
    }
  }
  flush(s.slice(last));
  return html;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// ---------- 터미널 ----------
class Terminal {
  constructor(el, shell) {
    this.el = el;
    this.shell = shell;
    this.histIdx = null;
    this.draft = '';
    this.busy = false;
    el.addEventListener('mouseup', () => {
      if (!window.getSelection()?.toString()) this.focus();
    });
  }

  ps1() {
    const p = this.shell.cwd.replace(/^\/user(?=\/|$)/, '~');
    return `\x1b[1;32muser@kkibok\x1b[0m:\x1b[1;34m${p}\x1b[0m$ `;
  }

  start() {
    this.el.innerHTML = '';
    this.print("\x1b[1mKkibokAI Sandbox Linux\x1b[0m  \x1b[90mhelp: 명령어 목록\x1b[0m");
    this.newPrompt();
  }

  line(html, cls = '') {
    const d = document.createElement('div');
    d.className = 'line ' + cls;
    d.innerHTML = html || '';
    if (this.row) this.el.insertBefore(d, this.row);
    else this.el.append(d);
    return d;
  }

  print(text, cls = '') {
    if (text == null || text === '') return;
    const arr = String(text).replace(/\n$/, '').split('\n');
    for (const l of arr) this.line(ansiToHtml(l), cls);
    this.scroll();
  }

  scroll() {
    this.el.scrollTop = this.el.scrollHeight;
  }

  newPrompt() {
    this.row?.remove();
    const row = h('div', { class: 'prompt-row line' });
    const ps = h('span', { class: 'ps1', html: ansiToHtml(this.ps1()) });
    const input = h('input', { class: 'cmd', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': '명령 입력' });
    input.addEventListener('keydown', (e) => this.onKey(e, input));
    row.append(ps, input);
    this.el.append(row);
    this.row = row;
    this.input = input;
    this.scroll();
    if (!this.el.closest('[hidden]')) input.focus({ preventScroll: true });
  }

  focus() {
    this.input?.focus({ preventScroll: true });
  }

  clear() {
    this.el.innerHTML = '';
    this.row = null;
  }

  async onKey(e, input) {
    const hist = this.shell.history;
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      if (this.busy) return;
      const cmd = input.value;
      this.histIdx = null;
      this.line(ansiToHtml(this.ps1()) + esc(cmd));
      this.row.remove();
      this.row = null;
      this.busy = true;
      const res = await this.shell.run(cmd, { source: 'user' });
      this.busy = false;
      if (res.clear) this.clear();
      this.print(res.out);
      this.print(res.err ? `\x1b[31m${res.err}\x1b[0m` : '');
      this.newPrompt();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hist.length) return;
      if (this.histIdx === null) {
        this.draft = input.value;
        this.histIdx = hist.length;
      }
      this.histIdx = Math.max(0, this.histIdx - 1);
      input.value = hist[this.histIdx] || '';
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.histIdx === null) return;
      this.histIdx++;
      if (this.histIdx >= hist.length) {
        this.histIdx = null;
        input.value = this.draft;
      } else input.value = hist[this.histIdx];
    } else if (e.key === 'Tab') {
      e.preventDefault();
      this.complete(input);
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      this.clear();
      this.newPrompt();
    } else if (e.key === 'c' && e.ctrlKey && !window.getSelection()?.toString()) {
      e.preventDefault();
      this.line(ansiToHtml(this.ps1()) + esc(input.value) + '^C');
      this.newPrompt();
    }
  }

  complete(input) {
    const v = input.value;
    const parts = v.split(/\s+/);
    const word = parts[parts.length - 1];
    let candidates = [];
    if (parts.length === 1) {
      candidates = this.shell.commandNames.filter((c) => c.startsWith(word));
    } else {
      const slash = word.lastIndexOf('/');
      const dirPart = slash >= 0 ? word.slice(0, slash + 1) : '';
      const base = slash >= 0 ? word.slice(slash + 1) : word;
      try {
        const abs = this.shell.fs.resolve(dirPart || '.', this.shell.cwd);
        const node = this.shell.fs.get(abs);
        candidates = this.shell.fs.readdir(abs).filter((n) => n.startsWith(base)).map((n) => dirPart + n + (node.children[n].type === 'dir' ? '/' : ''));
      } catch { /* ignore */ }
    }
    if (candidates.length === 1) {
      parts[parts.length - 1] = candidates[0];
      input.value = parts.join(' ') + (candidates[0].endsWith('/') ? '' : ' ');
    } else if (candidates.length > 1) {
      let prefix = candidates[0];
      for (const c of candidates) while (!c.startsWith(prefix)) prefix = prefix.slice(0, -1);
      if (prefix.length > word.length) {
        parts[parts.length - 1] = prefix;
        input.value = parts.join(' ');
      } else {
        this.line(ansiToHtml(this.ps1()) + esc(v));
        this.print(candidates.map((c) => c.split('/').filter(Boolean).pop() + (c.endsWith('/') ? '/' : '')).join('  '));
      }
    }
  }

  printAI(label, res) {
    this.line(`<span class="ai-tag">AI</span> ${esc(label)}`, 'ai-line');
    if (res?.out) this.print(res.out, 'ai-line');
    if (res?.err) this.print(`\x1b[31m${res.err}\x1b[0m`, 'ai-line');
    this.scroll();
  }
}

// ---------- 컨트롤러 ----------
export const sandbox = {
  vfs: null,
  shell: null,
  term: null,
  fm: null,
  ready: false,

  async init(userId) {
    this.vfs = new VFS(userId);
    await this.vfs.load();
    this.fm = new FileManager(this.vfs, $('#sbxFiles'));
    this.shell = new Shell(this.vfs, {
      open: (p) => this.fm.open(p),
      download: (p) => this.fm.download(p),
    });
    this.term = new Terminal($('#term'), this.shell);
    this.term.start();
    this.vfs.onChange(() => this.renderFiles());
    this.renderFiles();
    this.ready = true;

    $('#sbxClose').onclick = () => this.close();
    $('#sbxFilesToggle').onclick = () => {
      const s = $('#sandbox');
      if (window.innerWidth <= 520) s.classList.toggle('files-open');
      else s.classList.toggle('files-hidden');
    };
  },

  get isOpen() {
    return !$('#sandbox').hidden;
  },
  open() {
    $('#sandbox').hidden = false;
    this.vfs?.purgeTrash();
    this.renderFiles();
    setTimeout(() => this.term?.focus(), 30);
  },
  close() {
    $('#sandbox').hidden = true;
  },
  toggle() {
    this.isOpen ? this.close() : this.open();
  },

  commands() {
    return this.shell ? this.shell.commandNames.filter((c) => !['open', 'download', 'clear', 'history'].includes(c)) : [];
  },

  summary() {
    if (!this.vfs) return '';
    try {
      return this.vfs.tree('/user', 3, 60);
    } catch {
      return '';
    }
  },

  /** AI 도구 호출 실행 → { output, exit_code }
   *  잠긴 항목을 건드리면: 실행을 되돌리고 → 사용자에게 승인 요청 → 결과에 맞춰 다시 실행 */
  async runTool(call) {
    if (!this.ready) return { output: '샌드박스가 아직 준비되지 않았습니다.', exit_code: 1 };
    const vfs = this.vfs;
    const approved = new Set();
    const denied = new Set();
    for (let round = 0; round < 8; round++) {
      const snap = vfs.hasLocks() ? vfs.snapshot() : null;
      vfs.actor = 'ai';
      vfs.approved = approved;
      vfs.denied = denied;
      vfs.lockHit = null;
      let res;
      try {
        res = await this.execTool(call, round === 0);
      } finally {
        vfs.actor = 'user';
        vfs.approved = new Set();
        vfs.denied = new Set();
      }
      const hit = vfs.lockHit;
      vfs.lockHit = null;
      if (!hit || !snap) {
        if (res.label) this.term.printAI(res.label, res.view);
        return { output: res.output, exit_code: res.exit_code };
      }
      vfs.rollback(snap);
      const ok = await confirmDialog({
        title: 'AI가 잠긴 항목을 바꾸려고 해요',
        message: `${hit.abs}${hit.lockPath !== hit.abs ? `\n(잠금: ${hit.lockPath})` : ''}`,
        confirmText: '허용',
      });
      (ok ? approved : denied).add(hit.lockPath);
      this.term.printAI(ok ? `승인: ${hit.lockPath}` : `거부: ${hit.lockPath}`, null);
    }
    return { output: '잠긴 항목 승인 요청이 너무 많아 중단했습니다.', exit_code: 1 };
  },

  /** 실제 실행 (터미널 출력은 runTool 이 마지막 결과만 표시) */
  async execTool(call) {
    const a = call.args || {};
    try {
      if (call.name === 'sandbox_exec') {
        const cmd = String(a.command || '');
        const res = await this.shell.run(cmd, { source: 'ai' });
        if (res.clear) this.term.clear(), this.term.newPrompt();
        const text = stripAnsi(res.out) + (res.err ? (res.out ? '\n' : '') + stripAnsi(res.err) : '');
        return { output: text.slice(0, 12000) || '(출력 없음)', exit_code: res.code, label: `$ ${cmd}`, view: res };
      }
      if (call.name === 'write_file') {
        const abs = this.vfs.resolve(String(a.path || ''), '/user');
        const content = String(a.content ?? '');
        this.vfs.writeText(abs, content, { mkdirp: true });
        return { output: `${abs} 에 저장했습니다 (${new Blob([content]).size} bytes).`, exit_code: 0, label: `파일 작성 ${abs}`, view: { out: `\x1b[90m${content.length}자\x1b[0m` } };
      }
      if (call.name === 'read_file') {
        const abs = this.vfs.resolve(String(a.path || ''), '/user');
        const text = this.vfs.readText(abs);
        return { output: text.slice(0, 12000) + (text.length > 12000 ? `\n…(${text.length - 12000}자 생략)` : ''), exit_code: 0, label: `파일 읽기 ${abs}`, view: { out: `\x1b[90m${text.length}자\x1b[0m` } };
      }
      return { output: `알 수 없는 도구: ${call.name}`, exit_code: 1 };
    } catch (e) {
      return { output: `오류: ${e.message}`, exit_code: 1, label: `${call.name} 실패`, view: { err: e.message } };
    }
  },

  /** AI 가 생성한 이미지를 /user/download 에 저장 */
  async saveArtifact(art) {
    if (!this.ready || art?.kind !== 'image') return;
    try {
      const res = await fetch(art.url);
      const blob = await res.blob();
      const b64 = await blobToBase64(blob);
      this.vfs.writeBinary(`/user/download/${art.filename}`, b64, art.mime || blob.type);
      this.term.printAI(`이미지 저장 /user/download/${art.filename}`, null);
    } catch (e) {
      console.warn('artifact save failed', e);
    }
  },

  /** 채팅 첨부 파일을 /user/upload 로 복사 */
  saveUpload(att) {
    if (!this.ready) return;
    const name = String(att.name || 'file').replace(/[\/\\]/g, '_');
    try {
      if (typeof att.text === 'string') this.vfs.writeText(`/user/upload/${name}`, att.text, { mkdirp: true });
      else if (att.data) this.vfs.writeBinary(`/user/upload/${name}`, att.data, att.mime);
    } catch (e) {
      toast(`샌드박스에 복사하지 못했어요: ${e.message}`, 'error');
    }
  },

  renderFiles() {
    if (!this.fm || $('#sandbox').hidden) return;
    this.fm.render();
  },
};

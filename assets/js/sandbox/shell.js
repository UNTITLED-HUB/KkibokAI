// 가상 셸 — 파이프(|), 리다이렉션(> >> < 2> 2>&1), &&, ||, ;, 따옴표, $변수, 와일드카드(*, ?) 지원
import { FsError, MAX_BYTES, nodeSize } from './vfs.js';

export const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
const C = {
  dir: (s) => `\x1b[1;34m${s}\x1b[0m`,
  img: (s) => `\x1b[35m${s}\x1b[0m`,
  exe: (s) => `\x1b[32m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

class ShellError extends Error {}

// ------------------------------------------------------------
// 토큰화 / 파싱
// ------------------------------------------------------------
function expandVar(line, i, env) {
  if (line[i + 1] === '{') {
    const j = line.indexOf('}', i + 2);
    if (j < 0) throw new ShellError("닫히지 않은 '${'");
    return [env[line.slice(i + 2, j)] ?? '', j + 1];
  }
  const m = /^(\?|[A-Za-z_][A-Za-z0-9_]*)/.exec(line.slice(i + 1));
  if (!m) return ['$', i + 1];
  return [env[m[1]] ?? '', i + 1 + m[1].length];
}

const OPS = ['2>&1', '2>>', '&&', '||', '>>', '2>', '|', '>', '<', ';', '&'];

function tokenize(line, env) {
  const tokens = [];
  let cur = null;
  const push = () => {
    if (cur) tokens.push({ t: 'word', v: cur.v, glob: cur.glob });
    cur = null;
  };
  const ensure = () => (cur ||= { v: '', glob: false });
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ' || c === '\t' || c === '\n') {
      push();
      i++;
      continue;
    }
    if (c === '#' && !cur) break;
    const op = OPS.find((o) => line.startsWith(o, i) && (!o.startsWith('2') || !cur));
    if (op) {
      push();
      tokens.push({ t: 'op', v: op });
      i += op.length;
      continue;
    }
    if (c === "'") {
      ensure();
      const j = line.indexOf("'", i + 1);
      if (j < 0) throw new ShellError('닫히지 않은 작은따옴표');
      cur.v += line.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      ensure();
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) {
          cur.v += line[i + 1];
          i += 2;
        } else if (line[i] === '$') {
          const [v, n] = expandVar(line, i, env);
          cur.v += v;
          i = n;
        } else {
          cur.v += line[i++];
        }
      }
      if (i >= line.length) throw new ShellError('닫히지 않은 큰따옴표');
      i++;
      continue;
    }
    if (c === '\\') {
      ensure();
      if (i + 1 < line.length) cur.v += line[i + 1];
      i += 2;
      continue;
    }
    if (c === '$') {
      ensure();
      const [v, n] = expandVar(line, i, env);
      cur.v += v;
      i = n;
      continue;
    }
    if (c === '~' && !cur && (i + 1 >= line.length || '/ \t'.includes(line[i + 1]))) {
      ensure();
      cur.v += env.HOME || '/user';
      i++;
      continue;
    }
    ensure();
    if (c === '*' || c === '?') cur.glob = true;
    cur.v += c;
    i++;
  }
  push();
  return tokens;
}

function parse(tokens) {
  const seq = [];
  let pipeline = [];
  let cmd = { argv: [], redirs: [] };
  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];
    if (tk.t === 'word') {
      cmd.argv.push(tk);
      continue;
    }
    switch (tk.v) {
      case '|':
        if (!cmd.argv.length) throw new ShellError("구문 오류: '|' 앞에 명령이 없습니다");
        pipeline.push(cmd);
        cmd = { argv: [], redirs: [] };
        break;
      case '&&':
      case '||':
      case ';':
      case '&':
        if (cmd.argv.length) pipeline.push(cmd);
        else if (pipeline.length || tk.v !== ';') throw new ShellError(`구문 오류: '${tk.v}' 근처`);
        if (pipeline.length) seq.push({ pipeline, op: tk.v === '&' ? ';' : tk.v });
        pipeline = [];
        cmd = { argv: [], redirs: [] };
        break;
      case '2>&1':
        cmd.redirs.push({ op: '2>&1' });
        break;
      default: {
        const target = tokens[++k];
        if (!target || target.t !== 'word') throw new ShellError(`구문 오류: '${tk.v}' 다음에 파일 이름이 필요합니다`);
        cmd.redirs.push({ op: tk.v, target: target.v });
      }
    }
  }
  if (cmd.argv.length) pipeline.push(cmd);
  else if (pipeline.length) throw new ShellError('구문 오류: 파이프 뒤에 명령이 없습니다');
  if (pipeline.length) seq.push({ pipeline, op: ';' });
  return seq;
}

function globToRe(p) {
  return new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

/** -la, -n 5, -n5 형태의 짧은 옵션 파싱. valued: 값을 받는 옵션 문자들 */
function opts(args, valued = '') {
  const flags = new Set();
  const values = {};
  const rest = [];
  let stop = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (stop || !a.startsWith('-') || a === '-' || /^-\d+$/.test(a) && !valued.includes('#')) {
      rest.push(a);
      continue;
    }
    if (a === '--') {
      stop = true;
      continue;
    }
    if (a.startsWith('--')) {
      flags.add(a.slice(2));
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const f = a[j];
      if (valued.includes(f)) {
        const v = a.slice(j + 1) || args[++i];
        values[f] = v;
        break;
      }
      flags.add(f);
    }
  }
  return { flags, values, rest };
}

function pad(s, n, left = false) {
  s = String(s);
  return left ? s.padStart(n) : s.padEnd(n);
}

function fmtDate(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function human(n) {
  if (n < 1024) return `${n}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

function lines(text) {
  if (!text) return [];
  const arr = String(text).split('\n');
  if (arr[arr.length - 1] === '') arr.pop();
  return arr;
}
const out = (s) => ({ out: s && !s.endsWith('\n') ? s + '\n' : s || '', code: 0 });

// ------------------------------------------------------------
// JS 실행 (Web Worker, 시간 제한)
// ------------------------------------------------------------
const WORKER_SRC = `
const norm = (p, cwd) => { let s = String(p); if (!s.startsWith('/')) s = cwd.replace(/\\/$/, '') + '/' + s; const o = []; for (const x of s.split('/')) { if (!x || x === '.') continue; if (x === '..') o.pop(); else o.push(x); } return '/' + o.join('/'); };
self.onmessage = async (e) => {
  const { code, args, files, cwd } = e.data;
  const outLines = []; const writes = [];
  const fmt = (a) => a.map((x) => typeof x === 'string' ? x : (() => { try { return JSON.stringify(x, null, 2); } catch { return String(x); } })()).join(' ');
  const con = { log: (...a) => outLines.push(fmt(a)), info: (...a) => outLines.push(fmt(a)), warn: (...a) => outLines.push(fmt(a)), error: (...a) => outLines.push('\\u0001' + fmt(a)), table: (x) => outLines.push(fmt([x])) };
  const fs = {
    readFile: (p) => { const k = norm(p, cwd); if (!(k in files)) throw new Error('파일이 없습니다: ' + k); return files[k]; },
    writeFile: (p, c) => { const k = norm(p, cwd); files[k] = String(c); writes.push([k, String(c), false]); },
    appendFile: (p, c) => { const k = norm(p, cwd); files[k] = (files[k] || '') + String(c); writes.push([k, String(c), true]); },
    exists: (p) => norm(p, cwd) in files,
    list: (d) => { const k = norm(d || '.', cwd).replace(/\\/$/, '') + '/'; return Object.keys(files).filter((f) => f.startsWith(k)).map((f) => f.slice(k.length)); },
  };
  try {
    const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFn('console', 'args', 'fs', code);
    const r = await fn(con, args, fs);
    if (r !== undefined) outLines.push(fmt([r]));
    self.postMessage({ ok: true, out: outLines, writes });
  } catch (err) {
    self.postMessage({ ok: false, out: outLines, writes, error: String((err && err.message) || err) });
  }
};`;
let workerUrl = null;

function runJs(code, args, files, cwd, timeoutMs = 10000) {
  workerUrl ||= URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
  return new Promise((resolve) => {
    const w = new Worker(workerUrl);
    const timer = setTimeout(() => {
      w.terminate();
      resolve({ ok: false, out: [], writes: [], error: `시간 초과 (${timeoutMs / 1000}초)` });
    }, timeoutMs);
    w.onmessage = (e) => {
      clearTimeout(timer);
      w.terminate();
      resolve(e.data);
    };
    w.onerror = (e) => {
      clearTimeout(timer);
      w.terminate();
      resolve({ ok: false, out: [], writes: [], error: e.message || '실행 오류' });
    };
    w.postMessage({ code, args, files, cwd });
  });
}

// ------------------------------------------------------------
// 명령어
// ------------------------------------------------------------
const HELP = [
  ['ls [-la] [경로]', '목록 보기'], ['cd [경로]', '디렉터리 이동'], ['pwd', '현재 위치'], ['cat 파일', '파일 내용'],
  ['echo 텍스트', '출력 (> 로 파일 저장)'], ['mkdir [-p] 이름', '디렉터리 만들기'], ['touch 파일', '빈 파일 만들기'],
  ['rm [-rf] 경로', '휴지통으로 삭제'], ['rmdir 경로', '빈 디렉터리 삭제'], ['mv 원본 대상', '이동/이름 변경'], ['cp [-r] 원본 대상', '복사'],
  ['tree [-L n] [경로]', '트리 보기'], ['find [경로] -name 패턴', '파일 찾기'], ['grep [-inrvc] 패턴 [파일]', '내용 검색'],
  ['head/tail [-n N] 파일', '앞/뒤 일부'], ['wc [-lwc] 파일', '줄·단어·바이트 수'], ['sort [-rnu]', '정렬'], ['uniq [-c]', '중복 제거'],
  ['cut -d, -f1', '열 자르기'], ['tr a-z A-Z', '문자 변환'], ['sed s/찾기/바꾸기/g', '치환'], ['js -e 코드 | js 파일.js', 'JavaScript 실행'],
  ['base64 [-d]', '인코딩'], ['du [-sh] / df', '용량'], ['stat 경로', '정보'], ['date / whoami / uname -a', '시스템 정보'],
  ['env / export K=V', '환경 변수'], ['history / clear', '기록 / 화면 지우기'], ['open 파일', '미리 보기'], ['download 파일', '내 컴퓨터로 내려받기'],
];

const UNSUPPORTED = {
  python: 'Python', python3: 'Python', pip: 'pip', pip3: 'pip', apt: 'apt', 'apt-get': 'apt', sudo: 'sudo', npm: 'npm', npx: 'npx',
  curl: 'curl', wget: 'wget', git: 'git', ssh: 'ssh', vim: 'vim', vi: 'vi', nano: 'nano', gcc: 'gcc', make: 'make', bash: 'bash', sh: 'sh',
};

export class Shell {
  constructor(fs, hooks = {}) {
    this.fs = fs;
    this.cwd = '/user';
    this.prevCwd = '/user';
    this.env = { HOME: '/user', USER: 'user', LOGNAME: 'user', SHELL: '/bin/ksh', HOSTNAME: 'kkibok', PATH: '/bin', LANG: 'ko_KR.UTF-8', TERM: 'xterm-256color', '?': '0' };
    this.history = [];
    this.hooks = hooks; // { open(path), download(path) }
  }

  get commandNames() {
    return Object.keys(this.commands()).sort();
  }

  r(p) {
    return this.fs.resolve(p, this.cwd);
  }

  async run(line, { source = 'user' } = {}) {
    const text = String(line || '').trim();
    if (!text) return { out: '', err: '', code: 0 };
    if (source === 'user') {
      this.history.push(text);
      if (this.history.length > 500) this.history.shift();
    }
    let seq;
    try {
      seq = parse(tokenize(text, { ...this.env, PWD: this.cwd }));
    } catch (e) {
      return { out: '', err: `ksh: ${e.message}\n`, code: 2 };
    }
    let o = '';
    let e = '';
    let last = 0;
    let clear = false;
    for (let i = 0; i < seq.length; i++) {
      const prevOp = i > 0 ? seq[i - 1].op : ';';
      if (prevOp === '&&' && last !== 0) continue;
      if (prevOp === '||' && last === 0) continue;
      const r = await this.pipeline(seq[i].pipeline, source);
      o += r.out;
      e += r.err;
      last = r.code;
      if (r.clear) clear = true;
      this.env['?'] = String(last);
    }
    return { out: o, err: e, code: last, clear };
  }

  expand(words) {
    const res = [];
    for (const w of words) {
      if (!w.glob) {
        res.push(w.v);
        continue;
      }
      const v = w.v;
      const slash = v.lastIndexOf('/');
      const dirPart = slash >= 0 ? v.slice(0, slash + 1) : '';
      const pat = slash >= 0 ? v.slice(slash + 1) : v;
      if (/[*?]/.test(dirPart)) {
        res.push(v);
        continue;
      }
      try {
        const abs = this.r(dirPart || '.');
        const re = globToRe(pat);
        const matches = this.fs.readdir(abs).filter((n) => re.test(n) && (pat.startsWith('.') || !n.startsWith('.')));
        if (matches.length) res.push(...matches.map((m) => dirPart + m));
        else res.push(v);
      } catch {
        res.push(v);
      }
    }
    return res;
  }

  async pipeline(cmds, source) {
    let stdin = '';
    let err = '';
    let code = 0;
    let clear = false;
    for (let i = 0; i < cmds.length; i++) {
      const cmd = cmds[i];
      const argv = this.expand(cmd.argv);
      let input = i === 0 ? '' : stdin;
      let outR = null;
      let errR = null;
      let merge = false;
      for (const rd of cmd.redirs) {
        if (rd.op === '<') {
          try {
            input = this.fs.readText(this.r(rd.target));
          } catch (ex) {
            return { out: '', err: `ksh: ${ex.message}\n`, code: 1 };
          }
        } else if (rd.op === '>' || rd.op === '>>') outR = rd;
        else if (rd.op === '2>' || rd.op === '2>>') errR = rd;
        else if (rd.op === '2>&1') merge = true;
      }
      const piped = i < cmds.length - 1 || !!outR;
      const res = await this.exec(argv, input, piped, source);
      let o = res.out || '';
      let e = res.err || '';
      if (merge) {
        o += e;
        e = '';
      }
      if (outR) {
        try {
          this.fs.writeText(this.r(outR.target), stripAnsi(o), { append: outR.op === '>>' });
        } catch (ex) {
          e += `ksh: ${ex.message}\n`;
        }
        o = '';
      }
      if (errR) {
        try {
          this.fs.writeText(this.r(errR.target), stripAnsi(e), { append: errR.op === '2>>' });
        } catch (ex) {
          e += `ksh: ${ex.message}\n`;
        }
        if (!e.startsWith('ksh:')) e = '';
      }
      err += e;
      code = res.code ?? 0;
      stdin = piped && !outR ? stripAnsi(o) : o;
      if (res.clear) clear = true;
    }
    return { out: stdin, err, code, clear };
  }

  async exec(argv, stdin, piped, source) {
    if (!argv.length) return { code: 0 };
    const [name, ...args] = argv;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name) && !args.length) {
      const k = name.slice(0, name.indexOf('='));
      this.env[k] = name.slice(name.indexOf('=') + 1);
      return { code: 0 };
    }
    if (UNSUPPORTED[name]) {
      return { err: `${name}: 이 샌드박스는 브라우저 안의 가상 환경이라 ${UNSUPPORTED[name]}을(를) 실행할 수 없습니다. JavaScript는 'js' 명령으로 실행할 수 있어요.\n`, code: 127 };
    }
    const fn = this.commands()[name];
    if (!fn) return { err: `${name}: 명령을 찾을 수 없습니다. 'help' 로 사용 가능한 명령을 확인하세요.\n`, code: 127 };
    try {
      return (await fn(args, { stdin, piped, source })) || { code: 0 };
    } catch (e) {
      if (e instanceof FsError || e instanceof ShellError) return { err: `${name}: ${e.message}\n`, code: 1 };
      console.error(e);
      return { err: `${name}: ${e.message || e}\n`, code: 1 };
    }
  }

  commands() {
    if (this._cmds) return this._cmds;
    const fs = this.fs;
    const sh = this;
    const readInputs = (files, stdin) => {
      if (!files.length) return [{ name: '-', text: stdin }];
      return files.map((f) => ({ name: f, text: fs.readText(sh.r(f)) }));
    };
    const colorName = (name, node) => {
      if (node.type === 'dir') return C.dir(name);
      if (node.binary && /^image\//.test(node.mime || '')) return C.img(name);
      if (/\.(sh|js|mjs)$/.test(name)) return C.exe(name);
      return name;
    };

    this._cmds = {
      help: () => out(['사용 가능한 명령어:', ...HELP.map(([a, b]) => `  ${pad(a, 26)} ${b}`), '', '파이프(|), 리다이렉션(> >> <), &&, ||, ; 를 지원합니다.'].join('\n')),

      ls: (args, io) => {
        const { flags, rest } = opts(args);
        const all = flags.has('a') || flags.has('A');
        const long = flags.has('l');
        const hum = flags.has('h');
        const targets = rest.length ? rest : ['.'];
        const blocks = [];
        let err = '';
        let code = 0;
        for (const t of targets) {
          const abs = sh.r(t);
          const n = fs.get(abs);
          if (!n) {
            err += `ls: '${t}'에 접근할 수 없음: 그런 파일이나 디렉터리가 없습니다\n`;
            code = 2;
            continue;
          }
          let entries;
          if (n.type === 'file') entries = [[t, n]];
          else {
            entries = Object.keys(n.children).sort((a, b) => a.localeCompare(b)).filter((k) => all || !k.startsWith('.')).map((k) => [k, n.children[k]]);
            if (all && flags.has('a')) entries.unshift(['.', n], ['..', fs.get(fs.resolve('..', abs)) || n]);
          }
          let body;
          if (long) {
            const rows = entries.map(([name, node]) => {
              const size = node.type === 'dir' ? 4096 : nodeSize(node);
              return `${node.type === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--'} 1 user user ${pad(hum ? human(size) : size, 8, true)} ${fmtDate(node.mtime || Date.now())} ${colorName(name, node)}`;
            });
            body = (n.type === 'dir' ? `합계 ${entries.length}\n` : '') + rows.join('\n');
          } else {
            const names = entries.map(([name, node]) => colorName(name, node));
            body = io.piped || flags.has('1') ? names.join('\n') : names.join('  ');
          }
          blocks.push((targets.length > 1 && n.type === 'dir' ? `${t}:\n` : '') + body);
        }
        const o = blocks.filter((b) => b !== '').join('\n\n');
        return { out: o ? o + '\n' : '', err, code };
      },

      cd: (args) => {
        let target = args[0] || '/user';
        if (target === '-') target = sh.prevCwd;
        const abs = sh.r(target);
        const n = fs.get(abs);
        if (!n) return { err: `cd: ${target}: 그런 파일이나 디렉터리가 없습니다\n`, code: 1 };
        if (n.type !== 'dir') return { err: `cd: ${target}: 디렉터리가 아닙니다\n`, code: 1 };
        sh.prevCwd = sh.cwd;
        sh.cwd = abs;
        return { code: 0 };
      },

      pwd: () => out(sh.cwd),

      cat: (args, io) => {
        const { flags, rest } = opts(args);
        let err = '';
        let text = '';
        for (const f of rest.length ? rest : ['-']) {
          try {
            text += f === '-' ? io.stdin : fs.readText(sh.r(f));
          } catch (e) {
            err += `cat: ${e.message}\n`;
          }
        }
        if (flags.has('n')) text = lines(text).map((l, i) => `${pad(i + 1, 6, true)}  ${l}`).join('\n') + '\n';
        return { out: text, err, code: err ? 1 : 0 };
      },

      echo: (args) => {
        let nl = true;
        let esc = false;
        while (args[0] === '-n' || args[0] === '-e' || args[0] === '-ne' || args[0] === '-en') {
          const a = args.shift();
          if (a.includes('n')) nl = false;
          if (a.includes('e')) esc = true;
        }
        let s = args.join(' ');
        if (esc) s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
        return { out: s + (nl ? '\n' : ''), code: 0 };
      },

      printf: (args) => {
        if (!args.length) return { code: 0 };
        let i = 1;
        const fmt = args[0].replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        let s = fmt.replace(/%([sd%])/g, (_, t) => (t === '%' ? '%' : t === 'd' ? String(parseInt(args[i++] || '0', 10) || 0) : String(args[i++] ?? '')));
        return { out: s, code: 0 };
      },

      mkdir: (args) => {
        const { flags, rest } = opts(args);
        if (!rest.length) return { err: 'mkdir: 피연산자가 없습니다\n', code: 1 };
        for (const d of rest) fs.mkdir(sh.r(d), flags.has('p'), flags.has('p'));
        return { code: 0 };
      },

      rmdir: (args) => {
        for (const d of args) fs.rmdir(sh.r(d));
        return { code: 0 };
      },

      rm: (args) => {
        const { flags, rest } = opts(args);
        const rec = flags.has('r') || flags.has('R');
        const force = flags.has('f');
        if (!rest.length && !force) return { err: 'rm: 피연산자가 없습니다\n', code: 1 };
        let err = '';
        for (const p of rest) {
          try {
            fs.rm(sh.r(p), rec);
          } catch (e) {
            if (!(force && /없습니다/.test(e.message))) err += `rm: ${e.message}\n`;
          }
        }
        return { err, code: err ? 1 : 0 };
      },

      mv: (args) => {
        const { rest } = opts(args);
        if (rest.length < 2) return { err: 'mv: 대상 파일이 없습니다\n', code: 1 };
        const dst = sh.r(rest.pop());
        if (rest.length > 1 && fs.get(dst)?.type !== 'dir') return { err: `mv: 대상 '${dst}' 은(는) 디렉터리가 아닙니다\n`, code: 1 };
        for (const s of rest) fs.copy(sh.r(s), dst, { move: true });
        return { code: 0 };
      },

      cp: (args) => {
        const { flags, rest } = opts(args);
        if (rest.length < 2) return { err: 'cp: 대상 파일이 없습니다\n', code: 1 };
        const dst = sh.r(rest.pop());
        if (rest.length > 1 && fs.get(dst)?.type !== 'dir') return { err: `cp: 대상 '${dst}' 은(는) 디렉터리가 아닙니다\n`, code: 1 };
        for (const s of rest) fs.copy(sh.r(s), dst, { recursive: flags.has('r') || flags.has('R') || flags.has('a') });
        return { code: 0 };
      },

      touch: (args) => {
        if (!args.length) return { err: 'touch: 피연산자가 없습니다\n', code: 1 };
        for (const f of args) fs.touch(sh.r(f));
        return { code: 0 };
      },

      tree: (args) => {
        const { values, rest } = opts(args, 'L');
        return out(fs.tree(sh.r(rest[0] || '.'), parseInt(values.L || '6', 10) || 6));
      },

      find: (args) => {
        const starts = [];
        let name = null;
        let iname = null;
        let type = null;
        let maxdepth = 30;
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a === '-name') name = globToRe(args[++i] || '*');
          else if (a === '-iname') iname = new RegExp(globToRe(args[++i] || '*').source, 'i');
          else if (a === '-type') type = args[++i];
          else if (a === '-maxdepth') maxdepth = parseInt(args[++i], 10) || 0;
          else if (!a.startsWith('-')) starts.push(a);
        }
        if (!starts.length) starts.push('.');
        const res = [];
        for (const s of starts) {
          const abs = sh.r(s);
          const base = abs === '/' ? '' : abs;
          fs.walk(abs, (p, node) => {
            const depth = p === abs ? 0 : p.slice(base.length).split('/').filter(Boolean).length;
            if (depth > maxdepth) return;
            const nm = p.split('/').pop() || '/';
            if (name && !name.test(nm)) return;
            if (iname && !iname.test(nm)) return;
            if (type === 'f' && node.type !== 'file') return;
            if (type === 'd' && node.type !== 'dir') return;
            res.push(s.startsWith('/') ? p : s.replace(/\/$/, '') + p.slice(base.length));
          }, maxdepth);
        }
        return out(res.join('\n'));
      },

      grep: (args, io) => {
        const { flags, values, rest } = opts(args, 'e');
        const pattern = values.e != null ? values.e : rest.shift();
        if (pattern == null) return { err: 'grep: 패턴이 필요합니다\n', code: 2 };
        const pat = String(pattern);
        let src = flags.has('F') ? pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pat;
        if (flags.has('w')) src = `\\b(?:${src})\\b`;
        let re;
        try {
          re = new RegExp(src, flags.has('i') ? 'i' : '');
        } catch {
          re = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags.has('i') ? 'i' : '');
        }
        const rec = flags.has('r') || flags.has('R');
        let files = rest;
        if (rec) {
          const all = [];
          for (const f of files.length ? files : ['.']) {
            const abs = sh.r(f);
            fs.walk(abs, (p, n) => {
              if (n.type === 'file' && !n.binary) all.push(f.startsWith('/') ? p : (f === '.' ? '.' : f.replace(/\/$/, '')) + p.slice(abs === '/' ? 0 : abs.length));
            });
          }
          files = all;
        }
        const inputs = readInputs(files, io.stdin);
        const showName = inputs.length > 1 || rec;
        const res = [];
        let matchedAny = false;
        for (const { name, text } of inputs) {
          let count = 0;
          lines(text).forEach((l, i) => {
            const hit = re.test(l) !== flags.has('v');
            if (!hit) return;
            count++;
            matchedAny = true;
            if (flags.has('c') || flags.has('l')) return;
            res.push(`${showName ? C.exe(name) + ':' : ''}${flags.has('n') ? C.dim(i + 1 + ':') : ''}${l}`);
          });
          if (flags.has('c')) res.push(`${showName ? name + ':' : ''}${count}`);
          if (flags.has('l') && count) res.push(name);
        }
        return { out: res.length ? res.join('\n') + '\n' : '', code: matchedAny ? 0 : 1 };
      },

      head: (args, io) => {
        const { values, rest } = opts(args, 'n');
        let n = parseInt(values.n ?? '10', 10);
        const r2 = rest.filter((a) => {
          if (/^-\d+$/.test(a)) {
            n = parseInt(a.slice(1), 10);
            return false;
          }
          return true;
        });
        return out(readInputs(r2, io.stdin).map(({ text }) => lines(text).slice(0, n).join('\n')).join('\n'));
      },

      tail: (args, io) => {
        const { values, rest } = opts(args, 'n');
        let n = parseInt(values.n ?? '10', 10);
        const r2 = rest.filter((a) => {
          if (/^-\d+$/.test(a)) {
            n = parseInt(a.slice(1), 10);
            return false;
          }
          return true;
        });
        return out(readInputs(r2, io.stdin).map(({ text }) => lines(text).slice(-n).join('\n')).join('\n'));
      },

      wc: (args, io) => {
        const { flags, rest } = opts(args);
        const sel = ['l', 'w', 'c'].filter((f) => flags.has(f));
        const show = sel.length ? sel : ['l', 'w', 'c'];
        const inputs = readInputs(rest, io.stdin);
        const tot = { l: 0, w: 0, c: 0 };
        const rows = inputs.map(({ name, text }) => {
          const v = { l: (text.match(/\n/g) || []).length, w: (text.trim().match(/\S+/g) || []).length, c: new Blob([text]).size };
          for (const k of ['l', 'w', 'c']) tot[k] += v[k];
          return show.map((k) => pad(v[k], 7, true)).join(' ') + (name !== '-' ? ` ${name}` : '');
        });
        if (inputs.length > 1) rows.push(show.map((k) => pad(tot[k], 7, true)).join(' ') + ' 합계');
        return out(rows.join('\n'));
      },

      sort: (args, io) => {
        const { flags, rest } = opts(args);
        let arr = readInputs(rest, io.stdin).flatMap(({ text }) => lines(text));
        if (flags.has('n')) arr.sort((a, b) => parseFloat(a) - parseFloat(b));
        else if (flags.has('f')) arr.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        else arr.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        if (flags.has('r')) arr.reverse();
        if (flags.has('u')) arr = [...new Set(arr)];
        return out(arr.join('\n'));
      },

      uniq: (args, io) => {
        const { flags, rest } = opts(args);
        const arr = readInputs(rest, io.stdin).flatMap(({ text }) => lines(text));
        const res = [];
        for (const l of arr) {
          const last = res[res.length - 1];
          if (last && last.v === l) last.n++;
          else res.push({ v: l, n: 1 });
        }
        return out(res.filter((r) => !flags.has('d') || r.n > 1).map((r) => (flags.has('c') ? `${pad(r.n, 7, true)} ${r.v}` : r.v)).join('\n'));
      },

      cut: (args, io) => {
        const { values, rest } = opts(args, 'dfc');
        const d = values.d ?? '\t';
        const sel = (values.f || values.c || '1').split(',').flatMap((p) => {
          const [a, b] = p.split('-');
          const s = parseInt(a || '1', 10);
          const e = p.includes('-') ? parseInt(b || '9999', 10) : s;
          return Array.from({ length: Math.max(0, Math.min(e, 9999) - s + 1) }, (_, i) => s + i);
        });
        const arr = readInputs(rest, io.stdin).flatMap(({ text }) => lines(text));
        return out(arr.map((l) => {
          if (values.c) return sel.map((i) => l[i - 1] ?? '').join('');
          const parts = l.split(d);
          return sel.filter((i) => i <= parts.length).map((i) => parts[i - 1]).join(d);
        }).join('\n'));
      },

      tr: (args, io) => {
        const { flags, rest } = opts(args);
        const expand = (s) => String(s || '').replace(/(.)-(.)/g, (_, a, b) => {
          let r = '';
          for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) r += String.fromCharCode(c);
          return r;
        }).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        const a = expand(rest[0]);
        const b = expand(rest[1]);
        let s = io.stdin;
        if (flags.has('d')) s = [...s].filter((c) => !a.includes(c)).join('');
        else s = [...s].map((c) => (a.includes(c) ? (b[a.indexOf(c)] ?? b[b.length - 1] ?? '') : c)).join('');
        return { out: s, code: 0 };
      },

      sed: (args, io) => {
        const { flags, rest } = opts(args, 'e');
        const expr = rest.shift();
        if (!expr || expr[0] !== 's') return { err: "sed: 's/찾기/바꾸기/[g]' 형식만 지원합니다\n", code: 1 };
        const dl = expr[1];
        const parts = [];
        let cur = '';
        for (let i = 2; i < expr.length; i++) {
          if (expr[i] === '\\' && expr[i + 1] === dl) {
            cur += dl;
            i++;
          } else if (expr[i] === dl) {
            parts.push(cur);
            cur = '';
          } else cur += expr[i];
        }
        parts.push(cur);
        const [find, rep = '', fl = ''] = parts;
        const re = new RegExp(find, (fl.includes('g') ? 'g' : '') + (fl.includes('i') ? 'i' : ''));
        const conv = (t) => lines(t).map((l) => l.replace(re, rep.replace(/\\(\d)/g, '$$$1').replace(/&/g, '$$&'))).join('\n') + (t.endsWith('\n') ? '\n' : '');
        if (flags.has('i')) {
          for (const f of rest) fs.writeText(sh.r(f), conv(fs.readText(sh.r(f))));
          return { code: 0 };
        }
        return { out: readInputs(rest, io.stdin).map(({ text }) => conv(text)).join(''), code: 0 };
      },

      date: () => out(new Intl.DateTimeFormat('ko-KR', { dateStyle: 'full', timeStyle: 'medium', timeZone: 'Asia/Seoul' }).format(new Date()) + ' KST'),
      whoami: () => out('user'),
      hostname: () => out('kkibok'),
      uname: (args) => out(args.includes('-a') ? 'KkibokLinux kkibok 1.0-browser #1 SMP JS x86_64 Web' : 'KkibokLinux'),
      env: () => out(Object.entries({ ...sh.env, PWD: sh.cwd }).filter(([k]) => k !== '?').map(([k, v]) => `${k}=${v}`).join('\n')),
      printenv: (args) => out(args.length ? args.map((k) => sh.env[k] ?? '').join('\n') : Object.entries(sh.env).filter(([k]) => k !== '?').map(([k, v]) => `${k}=${v}`).join('\n')),
      export: (args) => {
        for (const a of args) {
          const i = a.indexOf('=');
          if (i > 0) sh.env[a.slice(0, i)] = a.slice(i + 1);
        }
        return { code: 0 };
      },
      unset: (args) => {
        for (const a of args) delete sh.env[a];
        return { code: 0 };
      },
      clear: () => ({ code: 0, clear: true }),
      history: () => out(sh.history.map((h, i) => `${pad(i + 1, 5, true)}  ${h}`).join('\n')),
      stat: (args) => {
        const res = [];
        for (const p of args) {
          const abs = sh.r(p);
          const n = fs.get(abs);
          if (!n) return { err: `stat: '${p}': 그런 파일이나 디렉터리가 없습니다\n`, code: 1 };
          res.push(`  파일: ${abs}\n  종류: ${n.type === 'dir' ? '디렉터리' : n.binary ? `바이너리 (${n.mime})` : '일반 파일'}\n  크기: ${nodeSize(n)} bytes\n  수정: ${new Date(n.mtime || 0).toLocaleString('ko-KR')}`);
        }
        return out(res.join('\n'));
      },
      du: (args) => {
        const { flags, rest } = opts(args);
        const res = [];
        for (const p of rest.length ? rest : ['.']) {
          const abs = sh.r(p);
          const n = fs.get(abs);
          if (!n) return { err: `du: '${p}': 그런 파일이나 디렉터리가 없습니다\n`, code: 1 };
          const f = (b) => (flags.has('h') ? human(b) : Math.ceil(b / 1024));
          if (!flags.has('s') && n.type === 'dir') {
            for (const [k, c] of Object.entries(n.children)) if (c.type === 'dir') res.push(`${f(nodeSize(c))}\t${p.replace(/\/$/, '')}/${k}`);
          }
          res.push(`${f(nodeSize(n))}\t${p}`);
        }
        return out(res.join('\n'));
      },
      df: () => {
        const used = fs.totalSize();
        return out(`파일시스템      크기   사용   남음  사용%  마운트\nkkibok-vfs  ${pad(human(MAX_BYTES), 6, true)} ${pad(human(used), 6, true)} ${pad(human(MAX_BYTES - used), 6, true)} ${pad(Math.round((used / MAX_BYTES) * 100) + '%', 5, true)}  /`);
      },
      basename: (args) => out((args[0] || '').replace(/\/+$/, '').split('/').pop()),
      dirname: (args) => {
        const p = (args[0] || '').replace(/\/+$/, '');
        const i = p.lastIndexOf('/');
        return out(i < 0 ? '.' : i === 0 ? '/' : p.slice(0, i));
      },
      seq: (args) => {
        const nums = args.map(Number);
        const [a, b, c] = nums.length === 1 ? [1, nums[0], 1] : nums.length === 2 ? [nums[0], nums[1], 1] : [nums[0], nums[2], nums[1]];
        const res = [];
        for (let x = a; c > 0 ? x <= b : x >= b; x += c) {
          res.push(x);
          if (res.length > 100000) break;
        }
        return out(res.join('\n'));
      },
      rev: (args, io) => out(readInputs(args, io.stdin).flatMap(({ text }) => lines(text)).map((l) => [...l].reverse().join('')).join('\n')),
      base64: (args, io) => {
        const { flags, rest } = opts(args);
        const text = readInputs(rest, io.stdin).map((x) => x.text).join('');
        if (flags.has('d')) {
          const bin = atob(text.replace(/\s/g, ''));
          return { out: new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))), code: 0 };
        }
        const bytes = new TextEncoder().encode(text);
        let s = '';
        for (const b of bytes) s += String.fromCharCode(b);
        return out(btoa(s));
      },
      sleep: async (args) => {
        const s = Math.min(10, parseFloat(args[0] || '0') || 0);
        await new Promise((r) => setTimeout(r, s * 1000));
        return { code: 0 };
      },
      true: () => ({ code: 0 }),
      false: () => ({ code: 1 }),
      which: (args) => {
        const res = args.map((a) => (sh.commands()[a] ? `/bin/${a}` : null));
        return { out: res.filter(Boolean).join('\n') + (res.some(Boolean) ? '\n' : ''), code: res.every(Boolean) ? 0 : 1 };
      },
      expr: (args) => {
        const s = args.join(' ');
        if (!/^[\d\s+\-*/%().]+$/.test(s)) return { err: 'expr: 숫자와 + - * / % ( ) 만 사용할 수 있습니다\n', code: 2 };
        // eslint-disable-next-line no-new-func
        const v = Function(`"use strict"; return (${s.replace(/\s\/\s/g, ' / ')});`)();
        return out(String(Number.isInteger(v) ? v : Math.trunc(v)));
      },
      js: async (args, io) => {
        let code = '';
        let jsArgs = [];
        if (args[0] === '-e') {
          code = args[1] || '';
          jsArgs = args.slice(2);
        } else if (args[0]) {
          code = fs.readText(sh.r(args[0]));
          jsArgs = args.slice(1);
        } else code = io.stdin;
        if (!code.trim()) return { err: "js: 실행할 코드가 없습니다. 예) js -e \"console.log(1+1)\" 또는 js 파일.js\n", code: 2 };
        const files = {};
        let budget = 5 * 1024 * 1024;
        for (const root of ['/user', '/tmp']) {
          if (!fs.get(root)) continue;
          fs.walk(root, (p, n) => {
            if (n.type === 'file' && !n.binary && (n.content || '').length < budget) {
              files[p] = n.content || '';
              budget -= files[p].length;
            }
          });
        }
        const r = await runJs(code, jsArgs, files, sh.cwd);
        for (const [p, c, append] of r.writes || []) {
          try {
            fs.writeText(p, c, { append, mkdirp: true });
          } catch (e) {
            r.out.push('\u0001' + e.message);
          }
        }
        const o = (r.out || []).filter((l) => !l.startsWith('\u0001')).join('\n');
        const e = (r.out || []).filter((l) => l.startsWith('\u0001')).map((l) => l.slice(1)).join('\n') + (r.ok ? '' : (r.error ? `\n${r.error}` : ''));
        return { out: o ? o + '\n' : '', err: e.trim() ? e.trim() + '\n' : '', code: r.ok ? 0 : 1 };
      },
      node: (args, io) => sh.commands().js(args, io),
      open: (args, io) => {
        if (io.source === 'ai') return { err: 'open: 사용자 터미널 전용 명령입니다\n', code: 1 };
        const abs = sh.r(args[0] || '');
        if (!fs.get(abs) || fs.get(abs).type !== 'file') return { err: `open: '${args[0] || ''}' 파일이 없습니다\n`, code: 1 };
        sh.hooks.open?.(abs);
        return { code: 0 };
      },
      download: (args, io) => {
        if (io.source === 'ai') return { err: 'download: 사용자 터미널 전용 명령입니다. 파일은 /user/download 에 저장해 두면 사용자가 내려받을 수 있습니다\n', code: 1 };
        const abs = sh.r(args[0] || '');
        if (!fs.get(abs) || fs.get(abs).type !== 'file') return { err: `download: '${args[0] || ''}' 파일이 없습니다\n`, code: 1 };
        sh.hooks.download?.(abs);
        return out(`내려받기 시작: ${abs}`);
      },
    };
    return this._cmds;
  }
}

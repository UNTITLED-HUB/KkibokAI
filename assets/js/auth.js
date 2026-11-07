// 로그인 / 회원가입 화면
//  - 회원가입: 칸을 벗어날 때 조건 검사 → 빨강(경고) / 초록(충족), 비밀번호 안전도 표시
//  - 로그인 실패 시: 서버가 정한 대기 시간(4초부터 2배씩, 최대 1024초) 동안 버튼 잠금 + hCAPTCHA 요구
import { api, session } from './api.js?v=1.5.1';
import { mountCaptcha } from './captcha.js?v=1.5.1';
import { $, $$, setIcon } from './ui.js?v=1.5.1';
import { bindField, checkPassword, checkUsername, strengthMeter, validateAll } from './validate.js?v=1.5.1';

// ---------------- 기기 ID (기기당 회원가입 1회) ----------------
// 브라우저 저장소 3곳(localStorage·쿠키·IndexedDB)에 같은 값을 보관해, 한 곳이 지워져도 다시 복원한다.
const DEV_KEY = 'kb_device_id';
const validId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(v);

function idbGet() {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open('kb_device', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onerror = () => resolve(null);
      r.onsuccess = () => {
        try {
          const g = r.result.transaction('kv').objectStore('kv').get(DEV_KEY);
          g.onsuccess = () => resolve(g.result || null);
          g.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      };
    } catch {
      resolve(null);
    }
  });
}

function idbSet(v) {
  try {
    const r = indexedDB.open('kb_device', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => {
      try {
        r.result.transaction('kv', 'readwrite').objectStore('kv').put(v, DEV_KEY);
      } catch { /* ignore */ }
    };
  } catch { /* ignore */ }
}

export async function deviceId() {
  let id = null;
  try {
    id = localStorage.getItem(DEV_KEY);
  } catch { /* ignore */ }
  if (!validId(id)) id = (document.cookie.match(/(?:^|; )kb_device_id=([^;]+)/) || [])[1] || null;
  if (!validId(id)) id = await idbGet();
  if (!validId(id)) {
    const a = new Uint8Array(24);
    crypto.getRandomValues(a);
    id = btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  try {
    localStorage.setItem(DEV_KEY, id);
  } catch { /* ignore */ }
  document.cookie = `${DEV_KEY}=${id}; max-age=${60 * 60 * 24 * 3650}; path=/; SameSite=Lax; Secure`;
  idbSet(id);
  return id;
}

// 남은 대기 시간: 4초, 1분 4초, 17분 4초 …
const clock = (s) => (s >= 60 ? `${Math.floor(s / 60)}분${s % 60 ? ` ${s % 60}초` : ''}` : `${s}초`);

export function showAuth(onSuccess) {
  $('#boot').hidden = true;
  $('#shell').hidden = true;
  const root = $('#auth');
  root.hidden = false;
  let mode = 'login';
  let signupCap = null;
  let loginCap = null;
  let waitTimer = 0;
  let waitUntil = 0;
  const form = $('#authForm');
  const err = $('#authError');
  const submit = $('#authSubmit');
  const user = $('#authUser');
  const pass = $('#authPass');
  const pass2 = $('#authPass2');

  // 회원가입 칸 검사 (로그인 모드에서는 형식 검사를 하지 않음)
  const signupOnly = { enabled: () => mode === 'signup' };
  const fUser = bindField(user, () => checkUsername(user.value.trim()), signupOnly);
  const fPass = bindField(pass, () => checkPassword(pass.value), signupOnly);
  const fPass2 = bindField(pass2, () => {
    if (!pass2.value) return '한 번 더 입력해 주세요.';
    return pass2.value === pass.value ? '' : '비밀번호가 달라요.';
  }, { ...signupOnly, okText: '일치해요', live: true });
  const meter = strengthMeter();
  $('#authStrength').append(meter);
  const paintMeter = () => meter.update(mode === 'signup' ? pass.value : '', user.value.trim());
  pass.addEventListener('input', () => {
    paintMeter();
    fPass2.refresh();
  });
  user.addEventListener('input', paintMeter);

  const submitLabel = () => (mode === 'signup' ? '가입하기' : '로그인');

  const setMode = async (m) => {
    mode = m;
    root.classList.toggle('signup', m === 'signup');
    $$('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === m)));
    pass.autocomplete = m === 'signup' ? 'new-password' : 'current-password';
    err.textContent = '';
    [fUser, fPass, fPass2].forEach((f) => f.reset());
    paintMeter();
    paintWait();
    if (m === 'signup' && !signupCap) signupCap = await mountCaptcha($('#authCaptcha'));
  };
  $$('.tabs [data-tab]').forEach((b) => (b.onclick = () => setMode(b.dataset.tab)));

  const toggle = root.querySelector('.pw-toggle');
  toggle.onclick = () => {
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    pass2.type = pass.type;
    setIcon(toggle, show ? 'eye-off' : 'eye');
    toggle.setAttribute('aria-label', show ? '비밀번호 숨기기' : '비밀번호 보기');
  };

  // ---------------- 로그인 실패 대기 / hCAPTCHA ----------------
  function paintWait() {
    const left = Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000));
    const locked = mode === 'login' && left > 0;
    submit.disabled = locked;
    submit.textContent = locked ? `${clock(left)} 후 다시 시도` : submitLabel();
    $('#loginWait').textContent = locked
      ? `${clock(left)} 후 다시 시도할 수 있어요.`
      : (loginCap ? 'hCAPTCHA 인증이 필요해요.' : '');
    if (!left) {
      clearInterval(waitTimer);
      waitTimer = 0;
    }
  }

  async function requireGuard({ wait = 0, captcha = false }) {
    if (wait > 0) {
      waitUntil = Date.now() + wait * 1000;
      clearInterval(waitTimer);
      waitTimer = setInterval(paintWait, 500);
    }
    if (captcha) {
      $('#loginGuard').hidden = false;
      if (!loginCap) loginCap = await mountCaptcha($('#loginCaptcha'));
      else loginCap.reset();
    }
    paintWait();
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    const username = user.value.trim();
    const password = pass.value;
    let captcha;
    if (mode === 'signup') {
      if (!validateAll([[user, fUser], [pass, fPass], [pass2, fPass2]])) {
        err.textContent = '빨간 칸을 확인해 주세요.';
        return;
      }
      captcha = signupCap?.token();
      if (!captcha) return (err.textContent = 'hCAPTCHA 인증을 완료해 주세요.');
    } else {
      if (!username || !password) return (err.textContent = '사용자 이름과 비밀번호를 입력해 주세요.');
      if (Date.now() < waitUntil) return;
      if (loginCap) {
        captcha = loginCap.token();
        if (!captcha) return (err.textContent = 'hCAPTCHA 인증을 완료해 주세요.');
      }
    }
    submit.disabled = true;
    submit.textContent = '확인 중…';
    try {
      const r = mode === 'signup'
        ? await api.post('/auth/signup', { username, password, captcha, device: await deviceId() })
        : await api.post('/auth/login', { username, password, captcha });
      session.set(r.token);
      pass.value = '';
      pass2.value = '';
      clearInterval(waitTimer);
      root.hidden = true;
      onSuccess(r);
      return;
    } catch (ex) {
      err.textContent = ex.message;
      if (mode === 'signup') {
        signupCap?.reset();
        if (ex.code === 'SIGNUP_COOLDOWN' && ex.extra?.wait_seconds) {
          err.textContent = `${clock(Number(ex.extra.wait_seconds))} 후 다시 가입할 수 있어요.`;
        }
        if (ex.code === 'USERNAME_TAKEN' || ex.code === 'INVALID_USERNAME') {
          user.dataset.state = 'invalid';
          user.focus();
        }
      } else {
        const x = ex.extra || {};
        if (x.captcha_required || String(ex.code).startsWith('CAPTCHA') || x.wait_seconds) {
          await requireGuard({ wait: Number(x.wait_seconds || 0), captcha: true });
        }
      }
    }
    submit.disabled = false;
    paintWait();
  };

  setMode('login');
  setTimeout(() => user.focus(), 50);
}

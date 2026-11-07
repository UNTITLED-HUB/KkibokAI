// 로그인 / 회원가입 화면
//  - 회원가입: 칸을 벗어날 때 조건 검사 → 빨강(경고) / 초록(충족), 비밀번호 안전도 표시
//  - 로그인 실패 시: 서버가 정한 대기 시간(4초부터 2배씩, 최대 1024초) 동안 버튼 잠금 + hCAPTCHA 요구
import { api, session } from './api.js';
import { mountCaptcha } from './captcha.js';
import { $, $$, setIcon } from './ui.js';
import { bindField, checkPassword, checkUsername, strengthMeter, validateAll } from './validate.js';

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
    if (!pass2.value) return '비밀번호를 한 번 더 입력해 주세요.';
    return pass2.value === pass.value ? '' : '비밀번호가 서로 달라요.';
  }, { ...signupOnly, okText: '비밀번호가 일치해요' });
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
      ? `로그인에 실패해 잠시 기다려야 해요. ${clock(left)} 남았어요.`
      : (loginCap ? '로그인에 실패한 적이 있어 hCAPTCHA 인증이 필요해요.' : '');
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
        err.textContent = '빨간색으로 표시된 칸을 확인해 주세요.';
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
        ? await api.post('/auth/signup', { username, password, captcha })
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

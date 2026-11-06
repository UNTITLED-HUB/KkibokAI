// 로그인 / 회원가입 화면
import { api, session } from './api.js';
import { mountCaptcha } from './captcha.js';
import { $, $$, setIcon } from './ui.js';

const USER_RE = /^[A-Za-z]{8,24}$/;
const pwOk = (p) => p.length >= 8 && p.length <= 32 && /[A-Za-z]/.test(p) && /\d/.test(p) && !/[^\x21-\x7E]/.test(p);

export function showAuth(onSuccess) {
  $('#boot').hidden = true;
  $('#shell').hidden = true;
  const root = $('#auth');
  root.hidden = false;
  let mode = 'login';
  let cap = null;
  const form = $('#authForm');
  const err = $('#authError');
  const submit = $('#authSubmit');
  const user = $('#authUser');
  const pass = $('#authPass');
  const pass2 = $('#authPass2');

  const setMode = async (m) => {
    mode = m;
    root.classList.toggle('signup', m === 'signup');
    $$('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === m)));
    submit.textContent = m === 'signup' ? '가입하기' : '로그인';
    pass.autocomplete = m === 'signup' ? 'new-password' : 'current-password';
    err.textContent = '';
    if (m === 'signup' && !cap) cap = await mountCaptcha($('#authCaptcha'));
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

  // 사용자 이름은 영문만 입력되도록
  user.addEventListener('input', () => {
    if (mode === 'signup' && /[^A-Za-z]/.test(user.value)) user.setAttribute('aria-invalid', 'true');
    else user.removeAttribute('aria-invalid');
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    const username = user.value.trim();
    const password = pass.value;
    if (mode === 'signup') {
      if (!USER_RE.test(username)) return (err.textContent = '사용자 이름은 영문만 8~24자로 입력해 주세요.');
      if (!pwOk(password)) return (err.textContent = '비밀번호는 8~32자이며 영문과 숫자를 각각 1자 이상 포함해야 합니다(공백 제외).');
      if (password !== pass2.value) return (err.textContent = '비밀번호 확인이 일치하지 않습니다.');
      if (!cap?.token()) return (err.textContent = 'hCAPTCHA 인증을 완료해 주세요.');
    } else if (!username || !password) {
      return (err.textContent = '사용자 이름과 비밀번호를 입력해 주세요.');
    }
    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = '확인 중…';
    try {
      const r = mode === 'signup'
        ? await api.post('/auth/signup', { username, password, captcha: cap.token() })
        : await api.post('/auth/login', { username, password });
      session.set(r.token);
      pass.value = '';
      pass2.value = '';
      root.hidden = true;
      onSuccess(r);
    } catch (ex) {
      err.textContent = ex.message;
      if (mode === 'signup') cap?.reset();
    } finally {
      submit.disabled = false;
      submit.textContent = label;
    }
  };
  setMode('login');
  setTimeout(() => user.focus(), 50);
}

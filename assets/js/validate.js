// 입력 검증: 사용자 이름·비밀번호 규칙, 칸 상태(빨강/초록), 비밀번호 안전도
import { h } from './ui.js';

export const USERNAME_HINT = '영문·숫자 8~24자, 밑줄(_)은 한 번만 쓸 수 있어요';
export const PASSWORD_HINT = '8~32자, 영문과 숫자를 각각 1자 이상 (공백·한글 제외)';

/** 규칙에 맞으면 '' , 아니면 이유 */
export function checkUsername(v) {
  if (!v) return '사용자 이름을 입력해 주세요.';
  if (/[^A-Za-z0-9_]/.test(v)) return '영문, 숫자, 밑줄(_)만 쓸 수 있어요.';
  if ((v.match(/_/g) || []).length > 1) return '밑줄(_)은 한 번만 쓸 수 있어요.';
  if (v.length < 8 || v.length > 24) return `8~24자로 입력해 주세요. (지금 ${v.length}자)`;
  return '';
}

export function checkPassword(v) {
  if (!v) return '비밀번호를 입력해 주세요.';
  if (/[^\x21-\x7E]/.test(v)) return '공백이나 한글 같은 문자는 쓸 수 없어요.';
  if (v.length < 8 || v.length > 32) return `8~32자로 입력해 주세요. (지금 ${v.length}자)`;
  if (!/[A-Za-z]/.test(v)) return '영문을 1자 이상 넣어 주세요.';
  if (!/\d/.test(v)) return '숫자를 1자 이상 넣어 주세요.';
  return '';
}

export const isValidUsername = (v) => !checkUsername(v);
export const isValidPassword = (v) => !checkPassword(v);

// ------------------------------------------------------------
// 비밀번호 안전도 (0 매우 약함 ~ 4 매우 강함)
// ------------------------------------------------------------
const LEVELS = ['매우 약함', '약함', '보통', '강함', '매우 강함'];
const COMMON = ['password', 'passw0rd', 'qwerty', 'asdf', 'zxcv', 'iloveyou', 'admin', 'welcome', 'letmein', 'monkey', 'dragon', 'abc123', 'qwe123', 'test', 'login', 'kkibok'];

function hasSequence(pw, len = 4) {
  const s = pw.toLowerCase();
  let up = 1;
  let down = 1;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    up = d === 1 ? up + 1 : 1;
    down = d === -1 ? down + 1 : 1;
    if (up >= len || down >= len) return true;
  }
  return false;
}

export function passwordStrength(pw, username = '') {
  if (!pw) return { level: 0, label: LEVELS[0] };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes >= 2) score++;
  if (classes >= 3) score++;
  if (classes >= 4) score++;
  const low = pw.toLowerCase();
  if (/(.)\1\1/.test(pw)) score--; // 같은 문자 3번 이상 반복
  if (hasSequence(pw)) score--; // 1234, abcd 같은 연속
  if (COMMON.some((w) => low.includes(w))) score -= 2;
  if (username && username.length >= 4 && low.includes(username.toLowerCase())) score -= 2;
  if (new Set(pw).size <= 3) score -= 2;
  if (pw.length < 8) score = Math.min(score, 0);
  // 점수 0~6 → 단계 0~4
  const level = score <= 1 ? 0 : score === 2 ? 1 : score === 3 ? 2 : score === 4 ? 3 : 4;
  return { level, label: LEVELS[level] };
}

/** 비밀번호 칸 아래 안전도 막대. 반환값.update(password, username) */
export function strengthMeter() {
  const el = h('div', { class: 'pw-strength', hidden: true, 'aria-live': 'polite' },
    h('div', { class: 'bars' }, ...Array.from({ length: 5 }, () => h('i'))),
    h('span', { class: 'label' }));
  el.update = (pw, username = '') => {
    if (!pw) {
      el.hidden = true;
      return;
    }
    const s = passwordStrength(pw, username);
    el.hidden = false;
    el.dataset.level = String(s.level);
    el.querySelector('.label').textContent = `안전도: ${s.label}`;
  };
  return el;
}

// ------------------------------------------------------------
// 칸 상태 표시: 칸을 벗어날 때(다음 단계로 넘어갈 때) 검사 → 빨강(경고) / 초록(충족)
// 한 번 검사한 칸은 입력할 때마다 즉시 다시 검사
// ------------------------------------------------------------
/**
 * @param {HTMLInputElement} input
 * @param {() => string} check  오류 메시지('' 이면 통과)
 * @param {{ hint?: string, okText?: string, enabled?: () => boolean }} opts  enabled 가 false 면 검사·색 표시 안 함
 */
export function bindField(input, check, opts = {}) {
  const field = input.closest('.field') || input.parentElement;
  let msg = field.querySelector('.field-msg');
  if (!msg) {
    msg = field.querySelector('.hint') || h('small', { class: 'hint' });
    msg.classList.add('field-msg');
    if (!msg.parentNode) field.append(msg);
  }
  const hint = opts.hint ?? msg.textContent ?? '';
  msg.dataset.hint = hint;
  if (!msg.id) msg.id = `fm-${Math.random().toString(36).slice(2, 8)}`;
  input.setAttribute('aria-describedby', msg.id);
  let touched = false;

  const paint = () => {
    const err = check();
    input.dataset.state = err ? 'invalid' : 'valid';
    input.setAttribute('aria-invalid', err ? 'true' : 'false');
    msg.dataset.state = input.dataset.state;
    msg.textContent = err || opts.okText || hint;
    return !err;
  };
  const on = () => !opts.enabled || opts.enabled();
  const api = {
    validate() {
      if (!on()) {
        api.reset();
        return true;
      }
      touched = true;
      return paint();
    },
    reset() {
      touched = false;
      delete input.dataset.state;
      delete msg.dataset.state;
      input.removeAttribute('aria-invalid');
      msg.textContent = msg.dataset.hint || '';
    },
    refresh() {
      if (touched && on()) paint();
    },
  };
  input.addEventListener('blur', () => {
    if (input.value || touched) api.validate();
  });
  input.addEventListener('input', () => api.refresh());
  return api;
}

/** 여러 칸을 한꺼번에 검사하고, 첫 번째 잘못된 칸으로 이동 */
export function validateAll(entries) {
  let first = null;
  for (const [input, f] of entries) {
    if (!f.validate() && !first) first = input;
  }
  first?.focus();
  return !first;
}

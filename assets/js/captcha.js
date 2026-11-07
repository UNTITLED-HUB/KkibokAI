// hCAPTCHA 위젯 (필요할 때만 스크립트를 불러온다)
import { CONFIG } from './config.js?v=1.5.0';
import { store } from './store.js?v=1.5.0';
import { h } from './ui.js?v=1.5.0';

let loading = null;

function sitekey() {
  return CONFIG.HCAPTCHA_SITEKEY || store.serverConfig?.hcaptcha_sitekey || '';
}

function load() {
  if (window.hcaptcha) return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      window.__kbHcaptchaReady = () => resolve();
      const s = document.createElement('script');
      s.src = 'https://js.hcaptcha.com/1/api.js?render=explicit&onload=__kbHcaptchaReady&hl=ko&recaptchacompat=off';
      s.async = true;
      s.onerror = () => {
        loading = null;
        reject(new Error('hCAPTCHA를 불러오지 못했어요.'));
      };
      document.head.append(s);
    });
  }
  return loading;
}

/** 컨테이너에 위젯을 그리고 { token(), reset() } 반환 */
export async function mountCaptcha(container) {
  container.innerHTML = '';
  const key = sitekey();
  if (!key) {
    container.append(h('div', { class: 'captcha-note' }, 'hCAPTCHA 사이트 키가 없어요.'));
    return { token: () => '', reset() {}, ok: false };
  }
  try {
    await load();
  } catch (e) {
    container.append(h('div', { class: 'captcha-note' }, e.message + ' 새로고침 후 다시 시도해 주세요.'));
    return { token: () => '', reset() {}, ok: false };
  }
  const box = h('div');
  container.append(box);
  let id;
  try {
    id = window.hcaptcha.render(box, { sitekey: key, theme: 'dark' });
  } catch (e) {
    container.append(h('div', { class: 'captcha-note' }, 'hCAPTCHA를 표시하지 못했어요.'));
    return { token: () => '', reset() {}, ok: false };
  }
  return {
    ok: true,
    token: () => {
      try {
        return window.hcaptcha.getResponse(id) || '';
      } catch {
        return '';
      }
    },
    reset: () => {
      try {
        window.hcaptcha.reset(id);
      } catch { /* ignore */ }
    },
  };
}

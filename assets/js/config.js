// 공개 설정 — 여기에는 비밀 값이 들어가지 않습니다.
// (API 키·hCAPTCHA 비밀키·BOT_PROMPT 는 Supabase 시크릿에만 저장)
export const CONFIG = {
  // Supabase Edge Function 주소
  API_BASE: 'https://ytsxpfmfiwploexaqtid.supabase.co/functions/v1/kkibok',
  // hCAPTCHA 사이트 키(공개 값). 비워 두면 서버 시크릿 HCAPTCHA_SITEKEY 값을 사용합니다.
  HCAPTCHA_SITEKEY: '',
};

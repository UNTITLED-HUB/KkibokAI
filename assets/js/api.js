// 서버 API 클라이언트 (JSON + Server-Sent Events)
import { CONFIG } from './config.js?v=1.5.0';

const TOKEN_KEY = 'kb_token';

export const session = {
  get token() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch {
      return '';
    }
  },
  set(t) {
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch { /* 저장 불가 환경 */ }
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch { /* ignore */ }
  },
};

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function headers(json = true) {
  const h = {};
  if (json) h['content-type'] = 'application/json';
  if (session.token) h.authorization = `Bearer ${session.token}`;
  return h;
}

async function toError(res) {
  let body = null;
  try {
    body = await res.json();
  } catch { /* not json */ }
  const e = body?.error || {};
  const err = new ApiError(res.status, e.code || `HTTP_${res.status}`, e.message || `요청에 실패했습니다 (${res.status}).`, e);
  if (res.status === 401) window.dispatchEvent(new CustomEvent('kb:unauthorized', { detail: err }));
  return err;
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(CONFIG.API_BASE + path, {
      method,
      headers: headers(!(body instanceof FormData)),
      body: body == null ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', '서버에 연결할 수 없습니다. 네트워크를 확인해 주세요.');
  }
  if (!res.ok) throw await toError(res);
  return res.json();
}

/** SSE 스트림: onEvent(eventName, data) */
async function stream(path, body, onEvent, signal) {
  let res;
  try {
    res = await fetch(CONFIG.API_BASE + path, { method: 'POST', headers: headers(true), body: JSON.stringify(body), signal });
  } catch (e) {
    if (signal?.aborted) throw new ApiError(0, 'ABORTED', '중단되었습니다.');
    throw new ApiError(0, 'NETWORK', '서버에 연결할 수 없습니다. 네트워크를 확인해 주세요.');
  }
  if (!res.ok) throw await toError(res);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  const dispatch = (chunk) => {
    let ev = 'message';
    const data = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    let parsed;
    try {
      parsed = JSON.parse(data.join('\n'));
    } catch {
      return;
    }
    onEvent(ev, parsed);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value.replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        dispatch(chunk);
      }
    }
    if (buf.trim()) dispatch(buf);
  } catch (e) {
    if (signal?.aborted) throw new ApiError(0, 'ABORTED', '중단되었습니다.');
    throw new ApiError(0, 'STREAM', '응답을 받는 중 연결이 끊어졌습니다.');
  }
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b = {}) => request('PUT', p, b),
  patch: (p, b = {}) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
  upload: (p, fd) => request('POST', p, fd),
  stream,
};

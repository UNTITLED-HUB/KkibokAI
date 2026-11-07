// 음성: TTS(브라우저 음성 합성), 녹음 + 서버 STT(Groq Whisper)
import { api } from './api.js?v=1.5.1';
import { markdownToSpeech } from './markdown.js?v=1.5.1';
import { store } from './store.js?v=1.5.1';

// ------------------------------------------------------------
// TTS
// ------------------------------------------------------------
const synth = window.speechSynthesis;
let queue = [];
let speakingId = 0;

export const tts = {
  supported: !!synth,
  speaking: false,
  onChange: null,

  voices() {
    return synth ? synth.getVoices() : [];
  },

  pickVoice(text) {
    const list = this.voices();
    const pref = store.setting('tts_voice', '');
    if (pref) {
      const v = list.find((x) => x.name === pref);
      if (v) return v;
    }
    const isKo = /[가-힣]/.test(text);
    const lang = isKo ? 'ko' : (navigator.language || 'en').slice(0, 2);
    return list.find((v) => v.lang?.toLowerCase().startsWith(lang) && /google|natural|online/i.test(v.name)) ||
      list.find((v) => v.lang?.toLowerCase().startsWith(lang)) || null;
  },

  /** 긴 글은 문장 단위로 나눠 읽는다 (브라우저의 장문 끊김 방지) */
  chunks(text) {
    const parts = text.split(/(?<=[.!?。！？\n])\s+/).map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const p of parts) {
      if (p.length <= 220) out.push(p);
      else for (let i = 0; i < p.length; i += 200) out.push(p.slice(i, i + 200));
    }
    return out;
  },

  speak(markdown, { onend } = {}) {
    if (!synth) return false;
    this.stop();
    const text = markdownToSpeech(markdown);
    if (!text) return false;
    const id = ++speakingId;
    queue = this.chunks(text);
    this._next(id, onend);
    return true;
  },

  /** 스트리밍 중 문장이 완성될 때마다 이어서 읽기 */
  enqueue(sentence, onIdle) {
    if (!synth) return;
    const text = markdownToSpeech(sentence);
    if (!text) return;
    const idle = !this.speaking && !queue.length;
    queue.push(...this.chunks(text));
    if (idle) this._next(speakingId, onIdle);
    else this._onIdle = onIdle;
  },

  _next(id, onend) {
    if (id !== speakingId) return;
    const t = queue.shift();
    if (!t) {
      this.speaking = false;
      this.onChange?.(false);
      const cb = this._onIdle || onend;
      this._onIdle = null;
      cb?.();
      return;
    }
    const u = new SpeechSynthesisUtterance(t);
    const v = this.pickVoice(t);
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    } else u.lang = /[가-힣]/.test(t) ? 'ko-KR' : navigator.language;
    u.rate = Number(store.setting('tts_rate', 1)) || 1;
    u.onend = () => this._next(id, onend);
    u.onerror = () => this._next(id, onend);
    this.speaking = true;
    this.onChange?.(true);
    synth.speak(u);
  },

  stop() {
    speakingId++;
    queue = [];
    this._onIdle = null;
    if (synth) synth.cancel();
    if (this.speaking) {
      this.speaking = false;
      this.onChange?.(false);
    }
  },
};
if (synth) synth.onvoiceschanged = () => store.emit('voices');

// ------------------------------------------------------------
// 녹음
// ------------------------------------------------------------
function pickMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

export const recorderSupported = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

/** 녹음 시작 → { stop(): Promise<Blob>, cancel(), level(): 0~1 } */
export async function startRecording({ onLevel } = {}) {
  if (!recorderSupported) throw new Error('녹음을 지원하지 않는 브라우저예요.');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    throw new Error('마이크 권한이 필요해요.');
  }
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = AC ? new AC() : null;
  let analyser = null;
  let raf = 0;
  const buf = new Uint8Array(1024);
  if (ac) {
    analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    ac.createMediaStreamSource(stream).connect(analyser);
  }
  const level = () => {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / buf.length) * 4);
  };
  if (onLevel) {
    const tick = () => {
      onLevel(level());
      raf = requestAnimationFrame(tick);
    };
    tick();
  }
  const cleanup = () => {
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop());
    ac?.close().catch(() => {});
  };
  rec.start(250);
  return {
    mime: rec.mimeType || mime || 'audio/webm',
    level,
    stop: () => new Promise((resolve) => {
      rec.onstop = () => {
        cleanup();
        resolve(new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' }));
      };
      if (rec.state !== 'inactive') rec.stop();
      else {
        cleanup();
        resolve(new Blob(chunks));
      }
    }),
    cancel: () => {
      rec.onstop = null;
      if (rec.state !== 'inactive') rec.stop();
      cleanup();
    },
  };
}

export async function transcribe(blob) {
  const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
  const fd = new FormData();
  fd.append('audio', blob, `voice.${ext}`);
  const lang = store.setting('stt_lang', 'ko');
  if (lang && lang !== 'auto') fd.append('lang', lang.slice(0, 2));
  const r = await api.upload('/stt', fd);
  if (r.balance) store.setBalance(r.balance);
  return (r.text || '').trim();
}

// ------------------------------------------------------------
// 브라우저 실시간 음성 인식 (LIVE 에서 우선 사용)
// ------------------------------------------------------------
export const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;

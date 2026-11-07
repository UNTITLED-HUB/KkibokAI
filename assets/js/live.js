// LIVE 음성 대화: 듣기(STT) → AI 전송 → 실시간 TTS → 다시 듣기
import { chat } from './chat.js?v=1.5.1';
import { store } from './store.js?v=1.5.1';
import { $, toast } from './ui.js?v=1.5.1';
import { SpeechRec, startRecording, transcribe, tts } from './voice.js?v=1.5.1';

const S = { idle: '준비 중', listening: '듣고 있어요', thinking: '생각하는 중', speaking: '말하는 중', paused: '일시 정지' };

export const live = {
  active: false,
  paused: false,
  rec: null,
  recog: null,
  session: 0,

  init() {
    $('#btnLive').onclick = () => this.open();
    $('#liveClose').onclick = () => this.close();
    $('#liveEnd').onclick = () => this.close();
    $('#liveMute').onclick = () => this.togglePause();
    $('#liveOrb').onclick = () => {
      if (this.state === 'speaking') {
        tts.stop();
        this.listen();
      }
    };
    document.addEventListener('keydown', (e) => {
      if (this.active && e.key === 'Escape') this.close();
    });
  },

  set(state, heard) {
    this.state = state;
    $('#liveOrb').dataset.state = state;
    $('#liveStatus').textContent = S[state] || state;
    if (heard !== undefined) $('#liveHeard').textContent = heard;
  },

  async open() {
    if (store.busy) {
      toast('답변이 끝난 뒤에 할 수 있어요.');
      return;
    }
    if (!SpeechRec && !navigator.mediaDevices?.getUserMedia) {
      toast('음성 입력을 지원하지 않는 브라우저예요.', 'error');
      return;
    }
    if (!tts.supported) toast('음성 읽기 미지원 · 답변은 화면에만 표시돼요.');
    this.active = true;
    this.paused = false;
    this.session++;
    $('#live').hidden = false;
    $('#liveReply').textContent = '';
    $('#liveMute').textContent = '말하기 멈춤';
    this.listen();
  },

  close() {
    this.active = false;
    this.session++;
    this.stopListening();
    tts.stop();
    if (store.busy) chat.stop();
    $('#live').hidden = true;
    this.set('idle', '');
  },

  togglePause() {
    this.paused = !this.paused;
    $('#liveMute').textContent = this.paused ? '다시 듣기' : '말하기 멈춤';
    if (this.paused) {
      this.stopListening();
      tts.stop();
      this.set('paused', '');
    } else this.listen();
  },

  stopListening() {
    try {
      this.recog?.abort();
    } catch { /* ignore */ }
    this.recog = null;
    this.rec?.cancel();
    this.rec = null;
  },

  listen() {
    if (!this.active || this.paused) return;
    this.stopListening();
    this.set('listening', '');
    if (SpeechRec && !this.forceRecorder) this.listenBrowser();
    else this.listenRecorder();
  },

  /** 브라우저 내장 음성 인식 (실시간 자막) */
  listenBrowser() {
    const sid = this.session;
    const r = new SpeechRec();
    const lang = store.setting('stt_lang', 'ko');
    r.lang = lang === 'auto' ? (navigator.language || 'ko-KR') : lang.length === 2 ? `${lang}-${lang === 'en' ? 'US' : lang.toUpperCase()}` : lang;
    if (lang === 'ko') r.lang = 'ko-KR';
    if (lang === 'ja') r.lang = 'ja-JP';
    r.interimResults = true;
    r.continuous = false;
    let finalText = '';
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      $('#liveHeard').textContent = (finalText + interim).trim();
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed') {
        toast('마이크 권한이 필요해요.', 'error');
        this.close();
      } else if (['network', 'service-not-allowed', 'language-not-supported', 'audio-capture'].includes(e.error)) {
        // 브라우저 음성 인식을 쓸 수 없으면 녹음 + 서버 인식으로 전환
        this.forceRecorder = true;
      }
    };
    r.onend = () => {
      if (sid !== this.session || !this.active || this.paused || this.recog !== r) return;
      const text = finalText.trim();
      if (text) this.ask(text);
      else setTimeout(() => this.listen(), this.forceRecorder ? 50 : 300); // 아무 말도 없으면 다시 듣기
    };
    this.recog = r;
    try {
      r.start();
    } catch {
      this.listenRecorder();
    }
  },

  /** 녹음 + 서버 음성 인식 (말이 끝나면 1.2초 침묵 후 자동 전송) */
  async listenRecorder() {
    const sid = this.session;
    let spoke = false;
    let silentSince = 0;
    let started = Date.now();
    let done = false;
    let finish = () => {};
    try {
      this.rec = await startRecording({
        onLevel: (lvl) => {
          $('#liveOrb').style.setProperty('--lvl', lvl.toFixed(2));
          const t = Date.now();
          if (lvl > 0.12) {
            spoke = true;
            silentSince = 0;
          } else if (spoke) {
            silentSince ||= t;
            if (t - silentSince > 1200) finish();
          } else if (t - started > 15000) {
            // 15초 동안 말이 없으면 재시작
            started = t;
          }
        },
      });
    } catch (e) {
      toast(e.message, 'error');
      this.close();
      return;
    }
    finish = async () => {
      if (done || sid !== this.session) return;
      done = true;
      const rec = this.rec;
      this.rec = null;
      const blob = await rec.stop();
      if (sid !== this.session) return;
      this.set('thinking', '인식 중…');
      try {
        const text = await transcribe(blob);
        if (sid !== this.session) return;
        if (text) {
          $('#liveHeard').textContent = text;
          this.ask(text);
        } else this.listen();
      } catch (e) {
        toast(e.message, 'error');
        this.listen();
      }
    };
  },

  async ask(text) {
    const sid = this.session;
    this.stopListening();
    this.set('thinking', text);
    $('#liveReply').textContent = '';
    let buffer = '';
    let all = '';
    let streamDone = false;
    const afterSpeech = () => {
      if (sid !== this.session) return;
      if (streamDone && !tts.speaking) this.listen();
    };
    const flushSentences = (final = false) => {
      const re = /^[\s\S]*?[.!?。！？\n](\s|$)/;
      let m;
      while ((m = re.exec(buffer))) {
        const sentence = m[0];
        buffer = buffer.slice(sentence.length);
        if (sentence.trim()) {
          this.set('speaking');
          tts.enqueue(sentence, afterSpeech);
        }
      }
      if (final && buffer.trim()) {
        this.set('speaking');
        tts.enqueue(buffer, afterSpeech);
        buffer = '';
      }
    };
    try {
      await chat.send({
        content: text,
        voice: true,
        hooks: {
          onDelta: (d) => {
            if (sid !== this.session) return;
            all += d;
            buffer += d;
            $('#liveReply').textContent = all;
            if (tts.supported) flushSentences(false);
          },
          onReset: () => {
            all = '';
            buffer = '';
            tts.stop();
          },
        },
      });
    } catch (e) {
      toast(e.message || 'LIVE 응답 실패', 'error');
    }
    if (sid !== this.session) return;
    streamDone = true;
    if (tts.supported) {
      flushSentences(true);
      if (!tts.speaking) this.listen();
    } else this.listen();
  },
};

// 질문 입력창: 실행 모드 선택, 첨부, 음성 전송, 보내기/중지
import { chat } from './chat.js?v=1.5.0';
import { store } from './store.js?v=1.5.0';
import { $, $$, esc, fmtBytes, h, icon, modeKey, setIcon, toast } from './ui.js?v=1.5.0';
import { recorderSupported, startRecording, transcribe } from './voice.js?v=1.5.0';

const MAX_FILES = 4;
const MAX_BYTES = 5 * 1024 * 1024;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|java|kt|c|h|cpp|hpp|cs|go|rs|rb|php|swift|sh|bash|zsh|sql|ya?ml|toml|ini|cfg|conf|log|env|bat|ps1|lua|r|dart|vue|svelte)$/i;

function readAs(file, how) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    if (how === 'text') r.readAsText(file);
    else r.readAsDataURL(file);
  });
}

/** 큰 이미지는 최대 1600px JPEG 로 줄여서 전송량을 아낀다 */
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const max = 1600;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024 && /png|jpe?g|webp/.test(file.type)) return null;
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', 0.86);
    return { dataUrl, mime: 'image/jpeg', name: file.name.replace(/\.\w+$/, '') + '.jpg' };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const composer = {
  files: [],
  rec: null,
  recTimer: 0,

  init() {
    this.ta = $('#prompt');
    this.sendBtn = $('#btnSend');

    // 모드: 시작할 때마다 기본값(설정의 기본 모드, 없으면 NO BRAIN) / WORK 세부 모드는 FAST
    store.mode = store.setting('default_mode', 'nobrain') === 'work' ? 'work' : 'nobrain';
    store.submode = 'fast';
    $$('#modes [data-mode]').forEach((b) => (b.onclick = () => this.setMode(b.dataset.mode)));
    $$('#subModes [data-sub]').forEach((b) => (b.onclick = () => this.setSub(b.dataset.sub)));
    this.paintModes();

    this.ta.addEventListener('input', () => this.autosize());
    this.ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && store.setting('send_on_enter', true) && !this.isTouch()) {
        e.preventDefault();
        this.submit();
      }
    });
    this.sendBtn.onclick = () => (store.busy ? chat.stop() : this.submit());

    $('#btnAttach').onclick = () => $('#fileInput').click();
    $('#fileInput').addEventListener('change', (e) => {
      this.addFiles([...e.target.files]);
      e.target.value = '';
    });
    this.ta.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) {
        e.preventDefault();
        this.addFiles(files);
      }
    });
    const main = $('#main');
    let dragDepth = 0;
    let hint = null;
    main.addEventListener('dragenter', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      dragDepth++;
      if (!hint) {
        hint = h('div', { class: 'drop-hint' }, '놓아서 첨부');
        main.append(hint);
      }
    });
    main.addEventListener('dragover', (e) => e.preventDefault());
    main.addEventListener('dragleave', () => {
      if (--dragDepth <= 0) {
        hint?.remove();
        hint = null;
        dragDepth = 0;
      }
    });
    main.addEventListener('drop', (e) => {
      e.preventDefault();
      hint?.remove();
      hint = null;
      dragDepth = 0;
      if (e.dataTransfer?.files?.length) this.addFiles([...e.dataTransfer.files]);
    });

    $('#btnMic').onclick = () => this.toggleRecord();
    $('#recCancel').onclick = () => this.cancelRecord();
    if (!recorderSupported) $('#btnMic').disabled = true;

    store.on('busy', (b) => this.paintBusy(b));
    store.on('restore-input', ({ content, attachments }) => {
      if (!this.ta.value) this.ta.value = content;
      if (!this.files.length) this.files = attachments || [];
      this.paintFiles();
      this.autosize();
    });
    store.on('example', (ex) => {
      this.setMode(ex.mode);
      if (ex.sub) this.setSub(ex.sub);
      this.ta.value = ex.text;
      this.autosize();
      this.ta.focus();
    });
    this.autosize();
  },

  isTouch() {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  },

  setMode(m) {
    store.mode = m === 'work' ? 'work' : 'nobrain';
    this.paintModes();
  },

  setSub(s) {
    store.submode = s;
    this.paintModes();
  },

  paintModes() {
    const work = store.mode === 'work';
    $$('#modes [data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === store.mode)));
    $$('#subModes [data-sub]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.sub === store.submode)));
    $('#subModes').hidden = !work;
    document.body.dataset.modeColor = modeKey(store.mode, store.submode);
    this.ta.placeholder = work ? '메시지 입력' : '메시지 입력';
  },

  autosize() {
    this.ta.style.height = 'auto';
    this.ta.style.height = Math.min(this.ta.scrollHeight, window.innerHeight * 0.4) + 'px';
    this.paintBusy(store.busy);
  },

  paintBusy(busy) {
    const has = this.ta.value.trim() || this.files.length;
    this.sendBtn.disabled = !busy && !has;
    this.sendBtn.classList.toggle('stop', busy);
    setIcon(this.sendBtn, busy ? 'stop' : 'send');
    this.sendBtn.setAttribute('aria-label', busy ? '중지' : '보내기');
    this.sendBtn.title = busy ? '중지' : '보내기';
    $('#btnMic').disabled = busy || !recorderSupported;
  },

  async submit() {
    if (store.busy) return;
    const content = this.ta.value.trim();
    if (!content && !this.files.length) return;
    const attachments = this.files;
    this.ta.value = '';
    this.files = [];
    this.paintFiles();
    this.autosize();
    await chat.send({ content, attachments });
  },

  async addFiles(list) {
    for (const f of list) {
      if (this.files.length >= MAX_FILES) {
        toast(`최대 ${MAX_FILES}개까지 첨부할 수 있어요.`, 'error');
        break;
      }
      try {
        const isImg = /^image\/(png|jpe?g|webp|gif|heic|heif)$/.test(f.type);
        const isPdf = f.type === 'application/pdf';
        const isText = !isImg && !isPdf && (f.type.startsWith('text/') || TEXT_EXT.test(f.name) || f.type === 'application/json');
        if (!isImg && !isPdf && !isText) {
          toast(`지원하지 않는 형식: ${f.name}`, 'error');
          continue;
        }
        if (isText) {
          if (f.size > 1024 * 1024) {
            toast(`1MB 초과: ${f.name}`, 'error');
            continue;
          }
          const text = await readAs(f, 'text');
          this.files.push({ name: f.name, mime: f.type || 'text/plain', size: f.size, kind: 'text', text });
        } else {
          let dataUrl;
          let mime = f.type;
          let name = f.name;
          if (isImg) {
            const c = await compressImage(f);
            if (c) ({ dataUrl, mime, name } = c);
          }
          dataUrl ||= await readAs(f, 'url');
          const data = String(dataUrl).split(',')[1] || '';
          const size = Math.floor(data.length * 0.75);
          if (size > MAX_BYTES) {
            toast(`5MB 초과: ${f.name}`, 'error');
            continue;
          }
          this.files.push({ name, mime, size, kind: isImg ? 'image' : 'pdf', data, preview: isImg ? dataUrl : null });
        }
      } catch {
        toast(`파일을 읽지 못했어요: ${f.name}`, 'error');
      }
    }
    this.paintFiles();
    this.paintBusy(store.busy);
  },

  paintFiles() {
    const tray = $('#attachTray');
    tray.innerHTML = '';
    tray.hidden = !this.files.length;
    this.files.forEach((f, i) => {
      const chip = h('div', { class: 'att', title: f.name });
      chip.append(f.preview ? h('img', { src: f.preview, alt: '' }) : h('span', { html: icon(f.kind === 'pdf' ? 'file' : 'file') }));
      chip.append(h('span', { class: 'name' }, f.name), h('span', { class: 'size' }, fmtBytes(f.size)));
      const rm = h('button', { class: 'icon-btn rm', 'aria-label': `${esc(f.name)} 첨부 취소`, html: icon('x') });
      rm.onclick = () => {
        this.files.splice(i, 1);
        this.paintFiles();
        this.paintBusy(store.busy);
      };
      chip.append(rm);
      tray.append(chip);
    });
  },

  // ---------------- 🎙 음성 전송 ----------------
  async toggleRecord() {
    if (this.rec) return this.finishRecord();
    try {
      this.rec = await startRecording();
    } catch (e) {
      toast(e.message, 'error');
      return;
    }
    const t0 = Date.now();
    $('#btnMic').classList.add('recording');
    $('#recBar').hidden = false;
    const tick = () => {
      const s = Math.floor((Date.now() - t0) / 1000);
      $('#recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (s >= 120) this.finishRecord(); // 최대 2분
    };
    tick();
    this.recTimer = setInterval(tick, 500);
  },

  resetRecUi() {
    clearInterval(this.recTimer);
    $('#btnMic').classList.remove('recording');
    $('#recBar').hidden = true;
  },

  cancelRecord() {
    this.rec?.cancel();
    this.rec = null;
    this.resetRecUi();
  },

  async finishRecord() {
    const rec = this.rec;
    this.rec = null;
    this.resetRecUi();
    if (!rec) return;
    const blob = await rec.stop();
    if (blob.size < 1200) {
      toast('녹음이 너무 짧아요.');
      return;
    }
    const prev = this.ta.placeholder;
    this.ta.placeholder = '변환 중…';
    $('#btnMic').disabled = true;
    try {
      const text = await transcribe(blob);
      if (!text) {
        toast('알아듣지 못했어요.');
        return;
      }
      const extra = this.ta.value.trim();
      this.ta.value = extra ? `${extra} ${text}` : text;
      this.autosize();
      await this.submit();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      this.ta.placeholder = prev;
      this.paintBusy(store.busy);
    }
  },
};

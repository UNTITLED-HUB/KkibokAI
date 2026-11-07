// 사이드바 패널: 계정, 토큰 받기, 코드 교환, 설정, 저장공간
import { api, session } from './api.js';
import { mountCaptcha } from './captcha.js';
import { chat } from './chat.js';
import { sandbox } from './sandbox/index.js';
import { local, store } from './store.js';
import { $, confirmDialog, debounce, fmtBytes, fmtTime, fmtTokens, fmtWait, h, icon, promptDialog, toast } from './ui.js';
import { bindField, checkPassword, checkUsername, PASSWORD_HINT, strengthMeter, USERNAME_HINT, validateAll } from './validate.js';
import { tts } from './voice.js';

const PURPOSE = {
  answer: '답변', plan: '계획', execute: '실행', review: '검토', verify: '검증', report: '결과 정리',
  title: '제목 생성', memory: '메모리 정리', image: '이미지 생성', search: '웹 검색', stt: '음성 인식',
};

const TITLES = { account: '계정', tokens: '토큰 받기', codes: '코드 교환', settings: '설정', storage: '저장공간' };

function group(title, ...children) {
  return h('section', { class: 'group' }, title ? h('h3', {}, title) : null, ...children);
}
function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
}
function sw(checked, onChange) {
  const input = h('input', { type: 'checkbox', role: 'switch' });
  input.checked = !!checked;
  input.onchange = () => onChange(input.checked);
  return h('span', { class: 'switch' }, input, h('span'));
}
function setting(title, desc, control) {
  return h('div', { class: 'setting' }, h('div', { class: 't' }, h('b', {}, title), desc ? h('small', {}, desc) : null), control);
}
async function busyBtn(btn, fn) {
  if (btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '처리 중…';
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

export const panels = {
  current: null,
  prevFocus: null,

  init() {
    const wrap = $('#sheetWrap');
    wrap.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !wrap.hidden && !document.querySelector('.dialog-wrap, .menu, .preview')) this.close();
    });
    store.on('open-panel', (p) => this.open(p));
  },

  async open(name) {
    if (!TITLES[name]) return;
    this.prevFocus = document.activeElement;
    this.current = name;
    $('#sheetTitle').textContent = TITLES[name];
    const body = $('#sheetBody');
    body.innerHTML = '';
    $('#sheetWrap').hidden = false;
    $('#sheet').querySelector('[data-close].icon-btn')?.focus();
    try {
      await this[name](body);
    } catch (e) {
      body.append(h('p', { class: 'form-error' }, e.message || '불러오지 못했습니다.'));
    }
  },

  close() {
    $('#sheetWrap').hidden = true;
    $('#sheetBody').innerHTML = '';
    this.current = null;
    this.prevFocus?.focus?.();
  },

  // ---------------- 계정 ----------------
  async account(body) {
    const me = await api.get('/me');
    store.user = me.user;
    store.emit('user');
    const u = me.user;
    const capBox = h('div', { class: 'captcha' });
    body.append(
      group('내 계정', h('dl', { class: 'kv' },
        h('dt', {}, '사용자 이름'), h('dd', {}, u.username),
        h('dt', {}, '가입일'), h('dd', {}, new Date(u.created_at).toLocaleDateString('ko-KR')))),
      group('인증', h('p', { class: 'desc' }, '계정 관리 작업은 모두 hCAPTCHA 인증 후에 실행됩니다. 작업마다 새로 인증해 주세요.'), capBox),
    );
    const cap = await mountCaptcha(capBox);
    const needToken = () => {
      const t = cap.token();
      if (!t) throw new Error('먼저 위의 hCAPTCHA 인증을 완료해 주세요.');
      return t;
    };

    // 사용자 이름
    const nameIn = h('input', { maxlength: 24, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', value: u.username });
    const nameErr = h('p', { class: 'form-error', role: 'alert' });
    const nameBtn = h('button', { class: 'btn' }, '사용자 이름 변경');
    const nameCd = u.cooldowns.username_seconds;
    const nameField = field('새 사용자 이름', nameIn, `${USERNAME_HINT} · 7일에 한 번 바꿀 수 있어요`);
    body.append(group('사용자 이름 변경',
      nameField,
      nameCd ? h('p', { class: 'cooldown' }, `${fmtWait(nameCd)} 후에 다시 바꿀 수 있어요.`) : null,
      nameErr, nameBtn));
    const fName = bindField(nameIn, () => {
      const v = nameIn.value.trim();
      return checkUsername(v) || (v === u.username ? '지금 쓰고 있는 이름과 같아요.' : '');
    });
    nameBtn.onclick = () => busyBtn(nameBtn, async () => {
      nameErr.textContent = '';
      if (!validateAll([[nameIn, fName]])) return;
      try {
        const r = await api.post('/account/username', { username: nameIn.value.trim(), captcha: needToken() });
        store.user = r.user;
        store.emit('user');
        toast('사용자 이름을 바꿨어요.');
        this.open('account');
      } catch (e) {
        nameErr.textContent = e.message;
        if (e.code === 'USERNAME_TAKEN') nameIn.dataset.state = 'invalid';
        cap.reset();
      }
    });

    // 비밀번호
    const cur = h('input', { type: 'password', autocomplete: 'current-password', maxlength: 32 });
    const nw = h('input', { type: 'password', autocomplete: 'new-password', maxlength: 32 });
    const nw2 = h('input', { type: 'password', autocomplete: 'new-password', maxlength: 32 });
    const pwErr = h('p', { class: 'form-error', role: 'alert' });
    const pwBtn = h('button', { class: 'btn' }, '비밀번호 변경');
    const pwCd = u.cooldowns.password_seconds;
    const meter = strengthMeter();
    const nwField = field('새 비밀번호', nw, `${PASSWORD_HINT} · 3분에 한 번`);
    nwField.append(meter);
    body.append(group('비밀번호 변경',
      field('현재 비밀번호', cur, ' '),
      nwField,
      field('새 비밀번호 확인', nw2, '위와 같은 비밀번호를 한 번 더 입력해 주세요'),
      pwCd ? h('p', { class: 'cooldown' }, `${fmtWait(pwCd)} 후에 다시 바꿀 수 있어요.`) : null,
      pwErr, pwBtn));
    const fCur = bindField(cur, () => (cur.value ? '' : '현재 비밀번호를 입력해 주세요.'), { okText: ' ' });
    const fNw = bindField(nw, () => checkPassword(nw.value) || (nw.value && nw.value === cur.value ? '현재 비밀번호와 다른 비밀번호를 써 주세요.' : ''));
    const fNw2 = bindField(nw2, () => (!nw2.value ? '새 비밀번호를 한 번 더 입력해 주세요.' : nw2.value === nw.value ? '' : '새 비밀번호가 서로 달라요.'), { okText: '비밀번호가 일치해요', live: true });
    nw.addEventListener('input', () => {
      meter.update(nw.value, u.username);
      fNw2.refresh();
    });
    pwBtn.onclick = () => busyBtn(pwBtn, async () => {
      pwErr.textContent = '';
      if (!validateAll([[cur, fCur], [nw, fNw], [nw2, fNw2]])) return;
      try {
        await api.post('/account/password', { current_password: cur.value, new_password: nw.value, captcha: needToken() });
        toast('비밀번호를 바꿨어요. 다른 기기의 로그인은 모두 해제됐어요.');
        this.open('account');
      } catch (e) {
        pwErr.textContent = e.message;
        if (e.code === 'WRONG_PASSWORD') cur.dataset.state = 'invalid';
        cap.reset();
      }
    });

    // 로그아웃
    const outErr = h('p', { class: 'form-error', role: 'alert' });
    const outBtn = h('button', { class: 'btn', html: icon('logout') + '<span>로그아웃</span>' });
    const outAll = h('button', { class: 'btn btn-ghost' }, '모든 기기에서 로그아웃');
    const doLogout = (all) => async () => {
      outErr.textContent = '';
      try {
        await api.post('/auth/logout', { captcha: needToken(), all });
        session.clear();
        location.replace(location.pathname);
      } catch (e) {
        outErr.textContent = e.message;
        cap.reset();
      }
    };
    outBtn.onclick = () => busyBtn(outBtn, doLogout(false));
    outAll.onclick = () => busyBtn(outAll, doLogout(true));
    body.append(group('로그아웃', h('div', { class: 'row wrap' }, outBtn, outAll), outErr));

    // 계정 삭제
    const delPw = h('input', { type: 'password', autocomplete: 'current-password', maxlength: 32 });
    const delErr = h('p', { class: 'form-error', role: 'alert' });
    const delBtn = h('button', { class: 'btn btn-danger' }, '계정 삭제');
    body.append(group('계정 삭제', h('p', { class: 'desc' }, '채팅, 메모리, 첨부 파일, 토큰이 모두 영구 삭제됩니다.'), field('비밀번호 확인', delPw), delErr, delBtn));
    delBtn.onclick = () => busyBtn(delBtn, async () => {
      delErr.textContent = '';
      try {
        const token = needToken();
        if (!(await confirmDialog({ title: '정말 계정을 삭제할까요?', message: '삭제한 계정은 되돌릴 수 없습니다.', confirmText: '영구 삭제', danger: true }))) return;
        await api.post('/account/delete', { password: delPw.value, captcha: token });
        await sandbox.vfs?.reset();
        session.clear();
        local.clearAll();
        location.replace(location.pathname);
      } catch (e) {
        delErr.textContent = e.message;
        cap.reset();
      }
    });
  },

  // ---------------- 토큰 받기 ----------------
  async tokens(body) {
    const r = await api.get('/tokens');
    store.setBalance(r.balance);
    const b = r.balance;
    const left = Math.max(0, new Date(r.next_reset).getTime() - Date.now());
    const hh = Math.floor(left / 3600000);
    const mm = Math.floor((left % 3600000) / 60000);
    const pct = Math.min(100, (b.daily / (r.daily_amount || 500)) * 100);
    body.append(
      h('div', { class: 'balance-hero' },
        h('span', { class: 'sub' }, '남은 토큰'),
        h('span', { class: 'num' }, fmtTokens(b.total)),
        h('span', { class: 'sub' }, `일일 ${fmtTokens(b.daily)} / ${r.daily_amount} · 보너스 ${fmtTokens(b.bonus)}`),
        h('div', { class: 'meter', role: 'meter', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': '일일 토큰' }, h('i', { style: { width: `${pct}%` } })),
        h('span', { class: 'sub' }, `한국 시간 00:00에 일일 토큰이 ${r.daily_amount}개로 초기화돼요 (${hh}시간 ${mm}분 남음). 보너스 토큰은 초기화되지 않아요.`)),
      group('광고 보고 토큰 받기',
        h('div', { class: 'notice' }, '광고 보상은 준비 중이에요. 열리면 하루 최대 3번 광고를 보고 토큰을 받을 수 있어요.'),
        h('button', { class: 'btn', disabled: true }, '광고 보기 (준비 중)')),
      group('차감 기준', h('p', { class: 'desc' }, `Gemini 호출은 실제 사용 토큰 ÷ 2000, Groq 호출은 실제 사용 토큰 ÷ 8000 만큼 차감돼요. 최근 24시간 동안 ${fmtTokens(r.used_24h)} 토큰을 썼어요.`)),
    );
    const list = h('ul', { class: 'list' });
    if (!r.usage.length) list.append(h('li', {}, h('span', { class: 'sub' }, '아직 사용 기록이 없어요.')));
    for (const u of r.usage) {
      list.append(h('li', {},
        h('div', {}, h('div', {}, PURPOSE[u.purpose] || u.purpose), h('div', { class: 'sub' }, `${u.model} · ${fmtTime(u.created_at)}`)),
        h('span', { class: 'num' }, `−${fmtTokens(u.cost)}`)));
    }
    body.append(group('최근 사용 기록', list));
  },

  // ---------------- 코드 교환 ----------------
  async codes(body) {
    const input = h('input', { class: 'input code-input', maxlength: 40, autocomplete: 'off', spellcheck: 'false', placeholder: '예: KKIBOK2026', 'aria-label': '교환 코드' });
    const err = h('p', { class: 'form-error', role: 'alert' });
    const ok = h('div');
    const btn = h('button', { class: 'btn btn-primary' }, '교환하기');
    const go = () => busyBtn(btn, async () => {
      err.textContent = '';
      ok.innerHTML = '';
      const code = input.value.trim().toUpperCase();
      if (!code) return (err.textContent = '코드를 입력해 주세요.');
      try {
        const r = await api.post('/codes/redeem', { code });
        store.setBalance(r.balance);
        ok.append(h('div', { class: 'notice success' }, `${fmtTokens(r.reward)} 토큰을 받았어요. 지금 잔액은 ${fmtTokens(r.balance.total)} 토큰이에요.`));
        input.value = '';
      } catch (e) {
        err.textContent = e.message;
      }
    });
    btn.onclick = go;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) go();
    });
    body.append(group(null, h('p', { class: 'desc' }, '받은 교환 코드를 입력하면 보너스 토큰이 바로 들어와요. 코드마다 한 번만 쓸 수 있어요.'), input, err, btn, ok));
    setTimeout(() => input.focus(), 50);
  },

  // ---------------- 설정 ----------------
  async settings(body) {
    const save = debounce(async () => {
      try {
        const r = await api.put('/settings', { settings: store.settings });
        store.settings = r.settings;
      } catch (e) {
        toast(e.message, 'error');
      }
    }, 400);
    const set = (k, v) => {
      store.settings = { ...store.settings, [k]: v };
      store.emit('settings', store.settings);
      applySettings();
      save();
    };
    const s = (k, d) => store.setting(k, d);

    const modeSel = h('select', { class: 'input', 'aria-label': '기본 실행 모드' },
      h('option', { value: 'nobrain' }, 'NO BRAIN'), h('option', { value: 'work' }, 'WORK (FAST)'));
    modeSel.value = s('default_mode', 'nobrain');
    modeSel.onchange = () => set('default_mode', modeSel.value);

    body.append(group('AI',
      setting('메모리 사용', '대화에서 알게 된 나에 대한 핵심 정보를 기억하고 답변에 참고해요', sw(s('memory_enabled', true), (v) => set('memory_enabled', v))),
      setting('AI의 샌드박스 사용', 'WORK 모드에서 AI가 Sandbox Linux의 파일과 명령을 쓸 수 있어요', sw(s('sandbox_ai', true), (v) => set('sandbox_ai', v))),
      field('처음 열 때 실행 모드', modeSel)));

    // 메모리 관리
    const memList = h('ul', { class: 'list' });
    const renderMem = async () => {
      memList.innerHTML = '';
      try {
        const r = await api.get('/memories');
        if (!r.memories.length) memList.append(h('li', {}, h('span', { class: 'sub' }, '저장된 메모리가 없어요.')));
        for (const m of r.memories) {
          const edit = h('button', { class: 'icon-btn', 'aria-label': '메모리 수정', html: icon('edit') });
          const del = h('button', { class: 'icon-btn', 'aria-label': '메모리 삭제', html: icon('trash') });
          edit.onclick = async () => {
            const v = await promptDialog({ title: '메모리 수정', value: m.content, maxLength: 300 });
            if (!v) return;
            await api.patch(`/memories/${m.id}`, { content: v }).catch((e) => toast(e.message, 'error'));
            renderMem();
          };
          del.onclick = async () => {
            await api.del(`/memories/${m.id}`).catch((e) => toast(e.message, 'error'));
            renderMem();
          };
          memList.append(h('li', { class: 'mem-item' },
            h('div', { class: 'txt' }, m.content, h('div', { class: 'src' }, m.source === 'manual' ? '직접 추가' : '자동 저장')),
            h('div', { class: 'row' }, edit, del)));
        }
      } catch (e) {
        memList.append(h('li', {}, h('span', { class: 'form-error' }, e.message)));
      }
    };
    const addMem = h('button', { class: 'btn btn-sm', html: icon('plus') + '<span>직접 추가</span>' });
    addMem.onclick = async () => {
      const v = await promptDialog({ title: '메모리 추가', placeholder: '예: 사용자는 TypeScript를 선호한다.', maxLength: 300 });
      if (!v) return;
      await api.post('/memories', { content: v }).catch((e) => toast(e.message, 'error'));
      renderMem();
    };
    body.append(group('메모리', h('p', { class: 'desc' }, '모든 답변에서 참고하는 나에 대한 정보예요. 틀린 내용은 고치거나 지울 수 있어요.'), memList, h('div', {}, addMem)));
    renderMem();

    // 음성
    const voiceSel = h('select', { class: 'input', 'aria-label': '읽기 목소리' });
    const fillVoices = () => {
      voiceSel.innerHTML = '';
      voiceSel.append(h('option', { value: '' }, '자동 (답변 언어에 맞춤)'));
      const vs = tts.voices().slice().sort((a, b) => (a.lang.startsWith('ko') ? -1 : 0) - (b.lang.startsWith('ko') ? -1 : 0) || a.lang.localeCompare(b.lang));
      for (const v of vs) voiceSel.append(h('option', { value: v.name }, `${v.name} (${v.lang})`));
      voiceSel.value = s('tts_voice', '');
    };
    fillVoices();
    const off = store.on('voices', fillVoices);
    const obs = new MutationObserver(() => {
      if (!document.body.contains(voiceSel)) {
        off();
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    voiceSel.onchange = () => set('tts_voice', voiceSel.value);
    const rate = h('input', { type: 'range', min: '0.5', max: '2', step: '0.1', value: String(s('tts_rate', 1)), 'aria-label': '읽기 속도' });
    const rateVal = h('span', { class: 'hint' }, `${Number(s('tts_rate', 1)).toFixed(1)}배`);
    rate.oninput = () => (rateVal.textContent = `${Number(rate.value).toFixed(1)}배`);
    rate.onchange = () => set('tts_rate', Number(rate.value));
    const langSel = h('select', { class: 'input', 'aria-label': '음성 인식 언어' },
      h('option', { value: 'ko' }, '한국어'), h('option', { value: 'en' }, 'English'), h('option', { value: 'ja' }, '日本語'), h('option', { value: 'auto' }, '자동 감지'));
    langSel.value = s('stt_lang', 'ko');
    langSel.onchange = () => set('stt_lang', langSel.value);
    const test = h('button', { class: 'btn btn-sm', html: icon('play') + '<span>들어 보기</span>' });
    test.onclick = () => tts.speak('안녕하세요, KkibokAI입니다. 이 목소리로 답변을 읽어 드릴게요.');
    body.append(group('음성',
      field('읽기 목소리', voiceSel),
      h('label', { class: 'field' }, h('span', {}, '읽기 속도'), rate, rateVal),
      h('div', {}, test),
      field('음성 인식 언어', langSel),
      setting('AI 답변 자동으로 읽기', '답변이 끝나면 바로 소리 내어 읽어요 (LIVE는 항상 읽음)', sw(s('auto_read', false), (v) => set('auto_read', v)))));

    // 화면
    const fontSel = h('select', { class: 'input', 'aria-label': '글자 크기' },
      h('option', { value: 'sm' }, '작게'), h('option', { value: 'md' }, '보통'), h('option', { value: 'lg' }, '크게'));
    fontSel.value = s('font_size', 'md');
    fontSel.onchange = () => set('font_size', fontSel.value);
    body.append(group('화면',
      field('글자 크기', fontSel),
      setting('메시지 정보 표시', '내 질문 아래에 소요 시간, 사용 모델, 소모 토큰을 보여줘요', sw(s('show_meta', true), (v) => {
        set('show_meta', v);
        chat.render();
      })),
      setting('Enter로 보내기', '끄면 Enter는 줄바꿈, 보내기 버튼으로만 전송해요', sw(s('send_on_enter', true), (v) => set('send_on_enter', v)))));
  },

  // ---------------- 저장공간 ----------------
  async storage(body) {
    const r = await api.get('/storage');
    const st = r.stats || {};
    const sbxSize = sandbox.vfs?.totalSize() || 0;
    body.append(group('서버에 저장된 데이터', h('dl', { class: 'kv' },
      h('dt', {}, '채팅'), h('dd', {}, `${st.chats ?? 0}개`),
      h('dt', {}, '메시지'), h('dd', {}, `${st.messages ?? 0}개 (${fmtBytes(st.message_bytes)})`),
      h('dt', {}, '메모리'), h('dd', {}, `${st.memories ?? 0}개`),
      h('dt', {}, '토큰 사용 기록'), h('dd', {}, `${st.usage_rows ?? 0}건`))));
    body.append(group('이 브라우저에 저장된 데이터', h('dl', { class: 'kv' },
      h('dt', {}, 'Sandbox Linux 파일'), h('dd', {}, `${fmtBytes(sbxSize)} / 50 MB`))));

    const act = (label, desc, confirmMsg, fn) => {
      const b = h('button', { class: 'btn btn-danger btn-sm' }, label);
      b.onclick = async () => {
        if (!(await confirmDialog({ title: `${label}할까요?`, message: confirmMsg, confirmText: label, danger: true }))) return;
        await busyBtn(b, async () => {
          try {
            await fn();
            toast(`${label} 완료`);
            this.open('storage');
          } catch (e) {
            toast(e.message, 'error');
          }
        });
      };
      return h('div', { class: 'setting' }, h('div', { class: 't' }, h('b', {}, label), h('small', {}, desc)), b);
    };
    body.append(group('데이터 정리',
      act('모든 채팅 삭제', '채팅 기록과 첨부 파일을 모두 지워요', '삭제한 채팅은 되돌릴 수 없어요.', async () => {
        if (store.busy) throw new Error('답변이 끝난 뒤 삭제할 수 있어요.');
        await api.del('/chats');
        store.chats = [];
        chat.newChat();
        store.emit('chats');
      }),
      act('메모리 전체 삭제', 'AI가 기억한 나에 대한 정보를 모두 지워요', '저장된 메모리가 모두 사라져요.', () => api.del('/memories')),
      act('사용 기록 삭제', '토큰 사용 내역을 지워요 (잔액은 그대로)', '사용 기록만 지워지고 잔액은 바뀌지 않아요.', () => api.del('/usage')),
      act('샌드박스 초기화', 'Sandbox Linux의 모든 파일을 지우고 처음 상태로 되돌려요', '/user 아래 파일이 모두 사라져요.', async () => {
        await sandbox.vfs.reset();
        sandbox.term?.start();
      }),
      act('사이트 설정 초기화', '이 브라우저에 저장된 화면 설정(사이드바 상태 등)을 지워요', '로그인은 유지돼요.', async () => local.clearAll()),
    ));
  },
};

export function applySettings() {
  document.documentElement.dataset.font = store.setting('font_size', 'md');
}

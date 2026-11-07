// 사이드바 패널: 계정, 토큰 받기, 코드 교환, 설정, 저장공간
import { api, session } from './api.js?v=1.5.1';
import { mountCaptcha } from './captcha.js?v=1.5.1';
import { chat } from './chat.js?v=1.5.1';
import { sandbox } from './sandbox/index.js?v=1.5.1';
import { local, store } from './store.js?v=1.5.1';
import { $, confirmDialog, debounce, fmtBytes, fmtTime, fmtTokens, fmtWait, h, icon, promptDialog, toast } from './ui.js?v=1.5.1';
import { bindField, checkPassword, checkUsername, PASSWORD_HINT, strengthMeter, USERNAME_HINT, validateAll } from './validate.js?v=1.5.1';
import { tts } from './voice.js?v=1.5.1';

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

/** 서버가 알려준 차감 기준을 짧은 문장으로 */
function rateText(rt) {
  if (!rt || typeof rt.gemini !== 'number') return 'AI 호출마다 사용량만큼 차감';
  const nb = rt.nobrain ? `NO BRAIN 답변 ${rt.nobrain.min}~${rt.nobrain.max}` : '';
  const wm = rt.work_min ? `WORK 최소 ${rt.work_min.fast}/${rt.work_min.think}/${rt.work_min.deep}/${rt.work_min.ultra}` : '';
  return [`호출 1번당 최소 ${rt.call_min ?? 1}`, `Gemini 토큰 ÷ ${rt.gemini} · Groq 토큰 ÷ ${rt.groq}`, nb, wm].filter(Boolean).join(' · ');
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
      group('인증', capBox),
    );
    const cap = await mountCaptcha(capBox);
    const needToken = () => {
      const t = cap.token();
      if (!t) throw new Error('먼저 hCAPTCHA 인증을 완료해 주세요.');
      return t;
    };

    // 사용자 이름
    const nameIn = h('input', { maxlength: 24, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', value: u.username });
    const nameErr = h('p', { class: 'form-error', role: 'alert' });
    const nameBtn = h('button', { class: 'btn' }, '변경');
    const nameCd = u.cooldowns.username_seconds;
    const nameField = field('새 이름', nameIn, `${USERNAME_HINT} · 7일에 1회`);
    body.append(group('사용자 이름',
      nameField,
      nameCd ? h('p', { class: 'cooldown' }, `${fmtWait(nameCd)} 후 변경 가능`) : null,
      nameErr, nameBtn));
    const fName = bindField(nameIn, () => {
      const v = nameIn.value.trim();
      return checkUsername(v) || (v === u.username ? '현재 이름과 같아요.' : '');
    });
    nameBtn.onclick = () => busyBtn(nameBtn, async () => {
      nameErr.textContent = '';
      if (!validateAll([[nameIn, fName]])) return;
      try {
        const r = await api.post('/account/username', { username: nameIn.value.trim(), captcha: needToken() });
        store.user = r.user;
        store.emit('user');
        toast('이름을 바꿨어요');
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
    const pwBtn = h('button', { class: 'btn' }, '변경');
    const pwCd = u.cooldowns.password_seconds;
    const meter = strengthMeter();
    const nwField = field('새 비밀번호', nw, `${PASSWORD_HINT} · 3분에 1회`);
    nwField.append(meter);
    body.append(group('비밀번호',
      field('현재 비밀번호', cur, ' '),
      nwField,
      field('새 비밀번호 확인', nw2, ' '),
      pwCd ? h('p', { class: 'cooldown' }, `${fmtWait(pwCd)} 후 변경 가능`) : null,
      pwErr, pwBtn));
    const fCur = bindField(cur, () => (cur.value ? '' : '현재 비밀번호를 입력해 주세요.'), { okText: ' ', hint: ' ' });
    const fNw = bindField(nw, () => checkPassword(nw.value) || (nw.value && nw.value === cur.value ? '현재 비밀번호와 달라야 해요.' : ''));
    const fNw2 = bindField(nw2, () => (!nw2.value ? '한 번 더 입력해 주세요.' : nw2.value === nw.value ? '' : '비밀번호가 달라요.'), { okText: '일치해요', hint: ' ', live: true });
    nw.addEventListener('input', () => {
      meter.update(nw.value, u.username);
      fNw2.refresh();
    });
    pwBtn.onclick = () => busyBtn(pwBtn, async () => {
      pwErr.textContent = '';
      if (!validateAll([[cur, fCur], [nw, fNw], [nw2, fNw2]])) return;
      try {
        await api.post('/account/password', { current_password: cur.value, new_password: nw.value, captcha: needToken() });
        toast('비밀번호를 바꿨어요. 다른 기기는 로그아웃됐어요.');
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
    body.append(group('계정 삭제', h('p', { class: 'desc' }, '모든 데이터가 영구 삭제돼요.'), field('비밀번호', delPw), delErr, delBtn));
    delBtn.onclick = () => busyBtn(delBtn, async () => {
      delErr.textContent = '';
      try {
        const token = needToken();
        if (!(await confirmDialog({ title: '계정을 삭제할까요?', message: '되돌릴 수 없어요.', confirmText: '삭제', danger: true }))) return;
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
        h('span', { class: 'sub' }, `${hh}시간 ${mm}분 후 ${r.daily_amount}개로 초기화 · 보너스는 유지`)),
      group('광고 보상', h('button', { class: 'btn', disabled: true }, '준비 중')),
      group('차감 기준', h('p', { class: 'desc' }, rateText(r.rates) + ` · 최근 24시간 ${fmtTokens(r.used_24h)} 사용`)),
    );
    const list = h('ul', { class: 'list' });
    if (!r.usage.length) list.append(h('li', {}, h('span', { class: 'sub' }, '기록 없음')));
    for (const u of r.usage) {
      list.append(h('li', {},
        h('div', {}, h('div', {}, PURPOSE[u.purpose] || u.purpose), h('div', { class: 'sub' }, `${u.model} · ${fmtTime(u.created_at)}`)),
        h('span', { class: 'num' }, `−${fmtTokens(u.cost)}`)));
    }
    body.append(group('사용 기록', list));
  },

  // ---------------- 코드 교환 ----------------
  async codes(body) {
    const input = h('input', { class: 'input code-input', maxlength: 40, autocomplete: 'off', spellcheck: 'false', placeholder: '코드 입력', 'aria-label': '교환 코드' });
    const capBox = h('div', { class: 'captcha' });
    const err = h('p', { class: 'form-error', role: 'alert' });
    const ok = h('div');
    const btn = h('button', { class: 'btn btn-primary' }, '교환');
    body.append(group(null, input, capBox, err, btn, ok));
    const cap = await mountCaptcha(capBox);
    let until = 0;
    let timer = 0;
    let busy = false;
    const paint = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      if (!document.body.contains(btn)) return clearInterval(timer);
      if (left > 0) {
        btn.disabled = true;
        btn.textContent = `${left}초 후 다시 시도`;
      } else {
        clearInterval(timer);
        btn.disabled = busy;
        btn.textContent = busy ? '확인 중…' : '교환';
      }
    };
    const wait = (sec) => {
      until = Date.now() + sec * 1000;
      clearInterval(timer);
      timer = setInterval(paint, 250);
      paint();
    };
    const go = async () => {
      if (busy || Date.now() < until) return;
      err.textContent = '';
      ok.innerHTML = '';
      const code = input.value.trim().toUpperCase();
      if (!code) return (err.textContent = '코드를 입력해 주세요.');
      const captcha = cap.token();
      if (!captcha) return (err.textContent = 'hCAPTCHA 인증을 완료해 주세요.');
      busy = true;
      paint();
      try {
        const r = await api.post('/codes/redeem', { code, captcha });
        store.setBalance(r.balance);
        ok.append(h('div', { class: 'notice success' }, `+${fmtTokens(r.reward)} 토큰 · 잔액 ${fmtTokens(r.balance.total)}`));
        input.value = '';
      } catch (e) {
        err.textContent = e.message;
        if (e.extra?.wait_seconds) wait(Number(e.extra.wait_seconds));
      } finally {
        busy = false;
        cap.reset();
        paint();
      }
    };
    btn.onclick = go;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) go();
    });
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
      setting('메모리', '대화에서 알게 된 정보를 기억해요', sw(s('memory_enabled', true), (v) => set('memory_enabled', v))),
      setting('AI 샌드박스 사용', 'WORK 모드에서 파일·명령 사용', sw(s('sandbox_ai', true), (v) => set('sandbox_ai', v))),
      field('기본 모드', modeSel)));

    // 메모리 관리
    const memList = h('ul', { class: 'list' });
    const renderMem = async () => {
      memList.innerHTML = '';
      try {
        const r = await api.get('/memories');
        if (!r.memories.length) memList.append(h('li', {}, h('span', { class: 'sub' }, '없음')));
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
            h('div', { class: 'txt' }, m.content, h('div', { class: 'src' }, m.source === 'manual' ? '직접' : '자동')),
            h('div', { class: 'row' }, edit, del)));
        }
      } catch (e) {
        memList.append(h('li', {}, h('span', { class: 'form-error' }, e.message)));
      }
    };
    const addMem = h('button', { class: 'btn btn-sm', html: icon('plus') + '<span>추가</span>' });
    addMem.onclick = async () => {
      const v = await promptDialog({ title: '메모리 추가', maxLength: 300 });
      if (!v) return;
      await api.post('/memories', { content: v }).catch((e) => toast(e.message, 'error'));
      renderMem();
    };
    body.append(group('메모리 목록', memList, h('div', {}, addMem)));
    renderMem();

    // 음성
    const voiceSel = h('select', { class: 'input', 'aria-label': '읽기 목소리' });
    const fillVoices = () => {
      voiceSel.innerHTML = '';
      voiceSel.append(h('option', { value: '' }, '자동'));
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
    test.onclick = () => tts.speak('안녕하세요, KkibokAI입니다.');
    body.append(group('음성',
      field('읽기 목소리', voiceSel),
      h('label', { class: 'field' }, h('span', {}, '읽기 속도'), rate, rateVal),
      h('div', {}, test),
      field('음성 인식 언어', langSel),
      setting('답변 자동 읽기', null, sw(s('auto_read', false), (v) => set('auto_read', v)))));

    // 화면
    const fontSel = h('select', { class: 'input', 'aria-label': '글자 크기' },
      h('option', { value: 'sm' }, '작게'), h('option', { value: 'md' }, '보통'), h('option', { value: 'lg' }, '크게'));
    fontSel.value = s('font_size', 'md');
    fontSel.onchange = () => set('font_size', fontSel.value);
    body.append(group('화면',
      field('글자 크기', fontSel),
      setting('메시지 정보 표시', '소요 시간·모델·토큰', sw(s('show_meta', true), (v) => {
        set('show_meta', v);
        chat.render();
      })),
      setting('Enter로 보내기', '끄면 Enter는 줄바꿈', sw(s('send_on_enter', true), (v) => set('send_on_enter', v)))));
  },

  // ---------------- 저장공간 ----------------
  async storage(body) {
    const [r, remote] = await Promise.all([api.get('/storage'), api.get('/files').catch(() => null)]);
    const st = r.stats || {};
    const d = r.detail;
    const files = d?.files || [];
    const chats = d?.chats || [];
    const fileBytes = files.reduce((a, f) => a + Number(f.size || 0), 0);
    const refresh = () => this.open('storage');
    const btn = (label, ic, onclick, cls = 'btn-ghost') => h('button', { class: `btn btn-sm ${cls}`, html: (ic ? icon(ic) : '') + `<span>${label}</span>`, onclick });
    const iconBtn = (label, ic, onclick) => h('button', { class: 'icon-btn', title: label, 'aria-label': label, html: icon(ic), onclick });
    const more = (list, render, limit = 50) => {
      const ul = h('ul', { class: 'list store-list' });
      const draw = (n) => {
        ul.replaceChildren(...list.slice(0, n).map(render));
        if (list.length > n) ul.append(h('li', { class: 'more' }, btn(`${list.length - n}개 더 보기`, null, () => draw(n + limit))));
        if (!list.length) ul.append(h('li', {}, h('span', { class: 'sub' }, '없음')));
      };
      draw(limit);
      return ul;
    };

    // 요약
    body.append(group('요약', h('dl', { class: 'kv' },
      h('dt', {}, '채팅'), h('dd', {}, `${st.chats ?? 0}개 · 메시지 ${st.messages ?? 0}개 (${fmtBytes(st.message_bytes)})`),
      h('dt', {}, '업로드·생성 파일'), h('dd', {}, d ? `${files.length}개 (${fmtBytes(fileBytes)})` : '-'),
      h('dt', {}, '메모리'), h('dd', {}, `${st.memories ?? 0}개`),
      h('dt', {}, '사용 기록'), h('dd', {}, `${st.usage_rows ?? 0}건`),
      h('dt', {}, 'Sandbox 서버'), h('dd', {}, remote ? `${fmtBytes(remote.used)} / ${remote.limit / 1024 / 1024}MB` : '-'),
      h('dt', {}, 'Sandbox 이 브라우저'), h('dd', {}, `${fmtBytes(sandbox.vfs?.usedBytes() || 0)} / 100MB`))));
    if (!d) body.append(h('div', { class: 'notice' }, '자세한 목록을 보려면 채팅 보관 계정에서 6_chat_update_v1_5.sql 을 실행해 주세요.'));

    // 채팅 관리
    if (d) {
      const picked = new Set();
      const delSel = btn('선택 삭제', 'trash', async () => {
        if (!picked.size) return toast('삭제할 채팅을 선택해 주세요.');
        if (!(await confirmDialog({ title: `채팅 ${picked.size}개를 삭제할까요?`, message: '첨부 파일도 함께 지워져요.', confirmText: '삭제', danger: true }))) return;
        await busyBtn(delSel, async () => {
          for (const id of picked) {
            await api.del(`/chats/${id}`).catch((e) => toast(e.message, 'error'));
            store.chats = store.chats.filter((c) => c.id !== id);
            if (store.chatId === id) chat.newChat();
          }
          store.emit('chats');
          toast('삭제했어요');
          refresh();
        });
      }, 'btn-danger');
      const all = h('input', { type: 'checkbox', 'aria-label': '전체 선택' });
      const boxes = [];
      all.onchange = () => boxes.forEach((b) => {
        b.checked = all.checked;
        b.onchange();
      });
      const list = more(chats, (c) => {
        const cb = h('input', { type: 'checkbox', 'aria-label': `${c.title} 선택` });
        cb.onchange = () => (cb.checked ? picked.add(c.id) : picked.delete(c.id));
        boxes.push(cb);
        const open = h('button', { class: 'store-title', onclick: () => (this.close(), chat.open(c.id)) }, c.title || 'Unnamed Chat');
        return h('li', { class: 'store-row' }, cb,
          h('div', { class: 't' }, open, h('span', { class: 'sub' }, `메시지 ${c.messages} · 파일 ${c.files} · ${fmtBytes(c.bytes)} · ${fmtTime(c.updated_at)}`)),
          iconBtn('삭제', 'trash', async () => {
            if (!(await confirmDialog({ title: '채팅을 삭제할까요?', message: c.title, confirmText: '삭제', danger: true }))) return;
            await api.del(`/chats/${c.id}`).catch((e) => toast(e.message, 'error'));
            store.chats = store.chats.filter((x) => x.id !== c.id);
            if (store.chatId === c.id) chat.newChat();
            store.emit('chats');
            refresh();
          }));
      });
      body.append(group(`채팅 (${chats.length})`, h('div', { class: 'row store-bar' }, h('label', { class: 'row' }, all, h('span', {}, '전체')), delSel), list));

      // 업로드·생성 파일
      const fileList = more(files, (f) => h('li', { class: 'store-row' },
        h('span', { class: 'ficon', html: icon(f.kind === 'image' ? 'image' : 'file') }),
        h('div', { class: 't' }, h('b', {}, f.name), h('span', { class: 'sub' }, `${f.role === 'assistant' ? 'AI 생성' : '업로드'} · ${f.chat_title || ''} · ${f.size ? fmtBytes(f.size) + ' · ' : ''}${fmtTime(f.created_at)}`)),
        iconBtn('열기', 'eye', async () => {
          try {
            const u = await api.get(`/attachments/url?message_id=${f.message_id}&index=${f.index}`);
            if (u.url) window.open(u.url, '_blank', 'noopener');
            else toast('열 수 없는 파일이에요.', 'error');
          } catch (e) {
            toast(e.message, 'error');
          }
        }),
        iconBtn('삭제', 'trash', async () => {
          if (!(await confirmDialog({ title: '파일을 삭제할까요?', message: f.name, confirmText: '삭제', danger: true }))) return;
          try {
            await api.del(`/attachments?message_id=${f.message_id}&index=${f.index}`);
            refresh();
          } catch (e) {
            toast(e.message, 'error');
          }
        })));
      body.append(group(`업로드·생성 파일 (${files.length})`, fileList));
    }

    // Sandbox 서버 파일
    if (remote) {
      const list = more(remote.files, (f) => h('li', { class: 'store-row' },
        h('span', { class: 'ficon', html: icon('cloud') }),
        h('div', { class: 't' }, h('b', {}, f.path.replace(/^\/user(?=\/|$)/, '~')), h('span', { class: 'sub' }, `${fmtBytes(f.size)} · ${fmtTime(f.updated_at)}`)),
        iconBtn('서버에서 삭제', 'trash', async () => {
          if (!(await confirmDialog({ title: '서버에서 삭제할까요?', message: f.path, confirmText: '삭제', danger: true }))) return;
          await api.del(`/files?path=${encodeURIComponent(f.path)}`).catch((e) => toast(e.message, 'error'));
          refresh();
        })));
      body.append(group(`Sandbox 서버 파일 (${remote.files.length})`, list));
    }

    const act = (label, desc, confirmMsg, fn) => {
      const b = h('button', { class: 'btn btn-danger btn-sm' }, label);
      b.onclick = async () => {
        if (!(await confirmDialog({ title: `${label}할까요?`, message: confirmMsg, confirmText: label, danger: true }))) return;
        await busyBtn(b, async () => {
          try {
            await fn();
            toast(`${label} 완료`);
            refresh();
          } catch (e) {
            toast(e.message, 'error');
          }
        });
      };
      return h('div', { class: 'setting' }, h('div', { class: 't' }, h('b', {}, label), desc ? h('small', {}, desc) : null), b);
    };
    body.append(group('한꺼번에 정리',
      act('모든 채팅 삭제', '채팅과 첨부 파일', '되돌릴 수 없어요.', async () => {
        chat.detach();
        await api.del('/chats');
        store.chats = [];
        chat.newChat();
        store.emit('chats');
      }),
      act('메모리 전체 삭제', null, '되돌릴 수 없어요.', () => api.del('/memories')),
      act('사용 기록 삭제', '잔액은 유지', '되돌릴 수 없어요.', () => api.del('/usage')),
      act('샌드박스 초기화', '백업은 유지', '/user 아래 파일이 모두 사라져요.', async () => {
        await sandbox.vfs.reset();
        sandbox.term?.start();
      }),
      act('사이트 설정 초기화', '로그인은 유지', '화면 설정을 지워요.', async () => local.clearAll()),
    ));
  },
};

export function applySettings() {
  document.documentElement.dataset.font = store.setting('font_size', 'md');
}

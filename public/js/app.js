/* HSK 3.0 flashcards — data: drkameleon/complete-hsk-vocabulary (wordlists/exclusive/newest) */
'use strict';

const $ = (id) => document.getElementById(id);
const CHOICES = 3;
const STORE = 'hsk-flash-v1';

const state = {
  index: [],            // [{level, label, count}]
  cache: {},            // level -> entries[]
  levels: new Set(['1']),
  pool: [],             // entries for the selected levels
  queue: [],            // questions for this run
  i: 0,
  ok: 0,
  bad: 0,
  streak: 0,
  best: 0,
  wrong: [],            // entries answered incorrectly
  locked: false,
  mode: 'hanzi2en',
  qLimit: 0,            // seconds per question, 0 = off
  tLimit: 0,            // seconds for the whole run, 0 = off
  timeUp: false,        // run ended by the total timer
};

/* ── settings persistence ───────────────────────────────── */

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(STORE)) || {}; } catch { /* ignore */ }
  if (Array.isArray(s.levels) && s.levels.length) state.levels = new Set(s.levels);
  if (s.qcount) $('qcount').value = s.qcount;
  if (s.mode) $('mode').value = s.mode;
  if (s.order) $('order').value = s.order;
  if (s.qtime) $('qtime').value = s.qtime;
  if (s.ttime) $('ttime').value = s.ttime;
  $('autoTTS').checked = !!s.autoTTS;
  $('hidePY').checked = s.hidePY !== false;
  return s;
}

function saveSettings() {
  const prev = (() => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } })();
  localStorage.setItem(STORE, JSON.stringify({
    ...prev,
    levels: [...state.levels],
    qcount: $('qcount').value,
    mode: $('mode').value,
    order: $('order').value,
    qtime: $('qtime').value,
    ttime: $('ttime').value,
    autoTTS: $('autoTTS').checked,
    hidePY: $('hidePY').checked,
  }));
}

function saveScore(pct, total) {
  const prev = (() => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } })();
  const runs = (prev.runs || 0) + 1;
  localStorage.setItem(STORE, JSON.stringify({ ...prev, runs, last: { pct, total } }));
}

/* ── helpers ────────────────────────────────────────────── */

const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const label = (lv) => (lv === '7' ? 'HSK 7-9' : 'HSK ' + lv);

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

/** first meaning, used as the short answer text */
const gloss = (e) => e.en[0];

/** modes whose options are hanzi rather than pinyin/meaning */
const HANZI_OPTS = new Set(['en2hanzi', 'py2hanzi', 'pyen2hanzi']);
/** modes whose question is pinyin */
const PY_QUESTION = new Set(['py2hanzi', 'pyen2hanzi']);

/** what the option actually shows - two options must never render the same text */
function displayKey(e) {
  if (HANZI_OPTS.has(state.mode)) return e.s;
  if (state.mode === 'hanzi2py') return e.py;
  return e.py + '|' + gloss(e);
}

/** character count - equals the pinyin syllable count (data pinyin isn't always space-separated) */
const hanziLen = (e) => [...e.s].length;

/** pinyin ignoring spacing, so homophones (是/事, 他/她/它) are caught */
const pyKey = (e) => e.py.toLowerCase().replace(/[\s'’\d]/g, '');

const mmss = (sec) => Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');

/** lazy shuffle - yields a random order without shuffling the whole list up front */
function* randomOrder(list) {
  const a = list.slice();
  for (let i = 0; i < a.length; i++) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
    yield a[i];
  }
}

/** words share a gloss if any content word of 4+ chars overlaps — bad distractor */
function tooSimilar(a, b) {
  const words = (e) => new Set(
    e.en.join(' ').toLowerCase().match(/[a-z]{4,}/g) || []
  );
  const wa = words(a);
  for (const w of words(b)) if (wa.has(w)) return true;
  return false;
}

/* ── data loading ───────────────────────────────────────── */

async function loadLevel(lv) {
  if (!state.cache[lv]) {
    const res = await fetch(`data/hsk-${lv}.json`);
    if (!res.ok) throw new Error(`โหลด HSK ${lv} ไม่สำเร็จ`);
    const entries = await res.json();
    entries.forEach((e) => { e.lv = lv; });
    state.cache[lv] = entries;
  }
  return state.cache[lv];
}

async function rebuildPool() {
  const lvls = [...state.levels].sort();
  const btn = $('start');
  btn.disabled = true;
  $('pool').textContent = 'กำลังโหลด…';
  try {
    const sets = await Promise.all(lvls.map(loadLevel));
    state.pool = sets.flat();
    $('pool').innerHTML = `คลังคำศัพท์: <b>${state.pool.length.toLocaleString()}</b> คำ · ${lvls.map(label).join(', ')}`;
    btn.disabled = state.pool.length < CHOICES;
    updateTimeHint();
  } catch (err) {
    $('pool').textContent = '⚠️ ' + err.message;
  }
}

/** "20 ข้อ ใน 200 วิ" under the total-time setting */
function updateTimeHint() {
  const per = parseInt($('ttime').value, 10);
  const hint = $('ttimeHint');
  if (!per) { hint.textContent = ''; return; }
  const n = parseInt($('qcount').value, 10);
  const count = n > 0 ? Math.min(n, state.pool.length) : state.pool.length;
  const sec = per * count;
  hint.textContent = `${count.toLocaleString()} ข้อ ใน ${sec.toLocaleString()} วิ (${mmss(sec)}) · หยุดนับตอนดูเฉลย`;
}

/* ── setup screen ───────────────────────────────────────── */

function renderLevels() {
  $('levels').innerHTML = '';
  for (const { level, label: name, count } of state.index) {
    const b = document.createElement('button');
    b.className = 'lv' + (state.levels.has(level) ? ' on' : '');
    b.innerHTML = `<b>${name}</b><small>${count.toLocaleString()}</small>`;
    b.onclick = () => {
      if (state.levels.has(level)) {
        if (state.levels.size > 1) state.levels.delete(level);   // keep at least one
      } else {
        state.levels.add(level);
      }
      renderLevels();
      saveSettings();
      rebuildPool();
    };
    $('levels').appendChild(b);
  }
}

/* ── quiz construction ──────────────────────────────────── */

/** pool grouped by word length (and level + length) so distractors can be drawn length-matched */
function indexPool(pool) {
  const byLen = new Map();
  const byLvLen = new Map();
  const add = (m, k, e) => (m.get(k) || m.set(k, []).get(k)).push(e);
  for (const e of pool) {
    add(byLen, hanziLen(e), e);
    add(byLvLen, e.lv + '|' + hanziLen(e), e);
  }
  return { pool, byLen, byLvLen };
}

function makeQuestion(answer, idx) {
  const opts = [answer];
  const len = hanziLen(answer);
  const sameLv = idx.byLvLen.get(answer.lv + '|' + len) || [];
  const sameLen = idx.byLen.get(len) || [];

  // never two options with the same text, meaning or pinyin - a homophone would be a second right answer
  const distinct = (c) => !opts.some((o) =>
    o.s === c.s || displayKey(o) === displayKey(c) || gloss(o) === gloss(c) || pyKey(o) === pyKey(c));
  const fill = (cands, ok = () => true) => {
    for (const c of cands) {
      if (opts.length === CHOICES) return;
      if (distinct(c) && ok(c)) opts.push(c);
    }
  };
  const unrelated = (c) => !tooSimilar(answer, c);

  // every option has as many characters (= pinyin syllables) as the answer, in every mode -
  // 直到 among 3-character options would give itself away. Same level first: closer in difficulty.
  fill(randomOrder(sameLv), unrelated);
  fill(randomOrder(sameLen), unrelated);
  // then relax the meaning-overlap check, but never the length
  fill(randomOrder(sameLv));
  fill(randomOrder(sameLen));
  // pool has too few words of this length (e.g. a lone 4-char idiom): nearest lengths
  if (opts.length < CHOICES) {
    const gap = (e) => Math.abs(hanziLen(e) - len);
    fill(shuffle(idx.pool.slice()).sort((a, b) => gap(a) - gap(b)));
  }
  return { answer, opts: shuffle(opts) };
}

function buildQueue(source) {
  const order = $('order').value;
  let list = source.slice();
  if (order === 'freq') list.sort((a, b) => (a.q || 1e9) - (b.q || 1e9));
  else shuffle(list);

  const n = parseInt($('qcount').value, 10);
  if (n > 0) list = list.slice(0, n);
  if (order === 'freq') { /* keep frequency order */ } else shuffle(list);

  const idx = indexPool(state.pool);
  return list.map((e) => makeQuestion(e, idx));
}

function startQuiz(source) {
  state.mode = $('mode').value;
  state.queue = buildQueue(source);
  if (!state.queue.length) return;
  Object.assign(state, { i: 0, ok: 0, bad: 0, streak: 0, best: 0, wrong: [], locked: false, timeUp: false });
  state.qLimit = parseInt($('qtime').value, 10) || 0;
  state.tLimit = (parseInt($('ttime').value, 10) || 0) * state.queue.length;
  timer.total = state.tLimit * 1000;
  timer.used = 0;
  $('qTimer').classList.toggle('hidden', !state.qLimit);
  $('tTotal').classList.toggle('hidden', !state.tLimit);
  $('total').textContent = state.queue.length;
  show('quiz');
  renderQuestion();
  startTicking();
}

/* ── timers ─────────────────────────────────────────────── */

// ms left on this question / in the run, and thinking time spent (paused while the answer is shown)
const timer = { id: null, last: 0, q: 0, total: 0, used: 0 };

function startTicking() {
  stopTicking();
  timer.last = performance.now();
  timer.id = setInterval(tick, 100);
}

function stopTicking() {
  clearInterval(timer.id);
  timer.id = null;
}

function tick() {
  // measure real elapsed time - a throttled background tab ticks late, not slower
  const now = performance.now();
  const dt = now - timer.last;
  timer.last = now;
  if (state.locked) return;

  timer.used += dt;
  timer.q -= dt;
  timer.total -= dt;
  renderTimers();

  if (state.tLimit && timer.total <= 0) timeUpAll();
  else if (state.qLimit && timer.q <= 0) answer(-1);
}

function renderTimers() {
  if (state.qLimit) {
    const left = Math.max(0, timer.q);
    const full = state.qLimit * 1000;
    $('qTimerNum').textContent = Math.ceil(left / 1000);
    $('qTimerBar').style.width = (left / full) * 100 + '%';
    $('qTimer').classList.toggle('low', left <= Math.min(3000, full * 0.3));
  }
  if (state.tLimit) {
    const left = Math.max(0, timer.total);
    $('nTime').textContent = mmss(Math.ceil(left / 1000));
    $('tTotal').classList.toggle('low', left <= 10000);
  }
}

/** total time ran out: the current and remaining questions count as unanswered */
function timeUpAll() {
  state.locked = true;
  state.timeUp = true;
  finish();
}

/* ── quiz rendering ─────────────────────────────────────── */

function renderQuestion() {
  const q = state.queue[state.i];
  const a = q.answer;

  $('idx').textContent = state.i + 1;
  $('bar').style.width = (state.i / state.queue.length) * 100 + '%';
  $('nOK').textContent = state.ok;
  $('nBad').textContent = state.bad;
  $('nStreak').textContent = state.streak;
  $('qLevel').textContent = label(a.lv);
  $('feedback').classList.add('hidden');
  state.locked = false;
  timer.q = state.qLimit * 1000;
  renderTimers();

  const main = $('qMain');
  const sub = $('qSub');
  main.classList.remove('small', 'pinyin');

  if (state.mode === 'en2hanzi') {
    main.classList.add('small');
    main.textContent = a.en.slice(0, 2).join('; ');
    sub.textContent = $('hidePY').checked ? '' : a.py;
  } else if (PY_QUESTION.has(state.mode)) {
    main.classList.add('pinyin');
    main.textContent = a.py;
    sub.textContent = state.mode === 'pyen2hanzi' ? a.en.slice(0, 2).join('; ') : '';
  } else {
    main.textContent = a.s;
    sub.textContent = $('hidePY').checked ? '' : a.py;
  }

  bunny('idle');

  const box = $('choices');
  box.innerHTML = '';
  q.opts.forEach((opt, n) => {
    const b = document.createElement('button');
    b.className = 'ch';
    b.innerHTML = `<span class="key">${n + 1}</span><span class="body">${optionBody(opt)}</span>`;
    b.onclick = () => answer(n);
    box.appendChild(b);
  });

  if ($('autoTTS').checked && state.mode !== 'en2hanzi') speak(a.s);
}

function optionBody(e) {
  if (HANZI_OPTS.has(state.mode)) return `<span class="hz">${e.s}</span>`;
  if (state.mode === 'hanzi2py') return `<span class="en">${esc(e.py)}</span>`;
  return `<span class="py">${esc(e.py)}</span><span class="en">${esc(gloss(e))}</span>`;
}

/** pick = -1 when the per-question timer ran out - counts as wrong */
function answer(pick) {
  if (state.locked) return;
  state.locked = true;

  const q = state.queue[state.i];
  const a = q.answer;
  const correct = q.opts[pick] === a;
  const timedOut = pick < 0;
  const btns = [...$('choices').children];

  btns.forEach((b, n) => {
    b.disabled = true;
    if (q.opts[n] === a) b.classList.add('correct');
    else if (n === pick) b.classList.add('wrong');
    else b.classList.add('dim');
  });

  if (correct) {
    state.ok++;
    state.streak++;
    state.best = Math.max(state.best, state.streak);
  } else {
    state.bad++;
    state.streak = 0;
    if (!state.wrong.includes(a)) state.wrong.push(a);
  }

  $('nOK').textContent = state.ok;
  $('nBad').textContent = state.bad;
  $('nStreak').textContent = state.streak;

  const fb = $('fbText');
  fb.textContent = correct ? '✓ ถูกต้อง' : timedOut ? '⏰ หมดเวลา — นับเป็นผิด' : '✕ ผิด';
  fb.className = 'fb-text ' + (correct ? 'ok' : 'bad');
  renderReveal(a);
  $('feedback').classList.remove('hidden');
  $('next').focus();

  bunny(correct ? 'happy' : 'sad', timedOut ? randOf(TOO_SLOW) : pep(correct));
  if (!$('autoTTS').checked) speak(a.s);
}

/** เฉลย: คำ + พินอิน + radical + ทุกความหมาย + ประโยคตัวอย่าง */
function renderReveal(a) {
  $('rvHanzi').textContent = a.s;
  $('rvPy').textContent = a.py;
  $('rvRad').innerHTML = a.r ? `部首 <b>${esc(a.r)}</b>` : '';
  $('rvRad').classList.toggle('hidden', !a.r);
  $('rvEn').textContent = a.en.join('; ');

  const ex = a.ex;
  $('rvEx').classList.toggle('hidden', !ex);
  if (!ex) return;
  // ไฮไลต์คำที่ถามในประโยค
  $('exZh').innerHTML = esc(ex.zh).replaceAll(esc(a.s), `<mark>${esc(a.s)}</mark>`);
  $('exPy').textContent = ex.py;
  $('exEn').textContent = ex.en;
}

function next() {
  state.i++;
  if (state.i >= state.queue.length) finish();
  else renderQuestion();
}

/* ── กระต่ายให้กำลังใจ ─────────────────────────────────── */

const CHEER = ['เก่งมาก! 🥕', 'ถูกต้อง!', 'ใช่เลย!', 'แม่นจริง ๆ', 'เยี่ยม!', 'ปรบมือให้'];
const COMFORT = [
  'ไม่เป็นไร จำไว้แล้วไปต่อ', 'เกือบแล้ว! ลองข้อหน้า', 'ผิดเป็นครูนะ',
  'คำนี้ยาก ช่างมัน', 'ค่อย ๆ ไป เดี๋ยวก็จำได้',
];
const STREAK = { 3: 'ติดกัน 3 ข้อ!', 5: '5 ข้อติด ไฟแรง! 🔥', 10: '10 ข้อติด สุดยอด! 🏆', 20: '20 ข้อติด เทพแล้ว! 👑' };
const IDLE = ['สู้ ๆ นะ', 'ค่อย ๆ คิด', 'ตั้งใจอ่านให้ดี', 'ข้อนี้ไม่ยาก'];
const TOO_SLOW = ['ช้าไปนิด ข้อหน้าเร็วขึ้นนะ', 'เวลาหมดซะแล้ว ⏰', 'ไม่ต้องรีบ แต่ก็อย่าช้านะ'];

const randOf = (a) => a[Math.floor(Math.random() * a.length)];

/** ข้อความให้กำลังใจ - สตรีคมาก่อนคำชมธรรมดา */
function pep(correct) {
  if (!correct) return randOf(COMFORT);
  return STREAK[state.streak] || randOf(CHEER);
}

let bunnyTimer = null;
function bunny(mood, message) {
  const el = $('bunny');
  const bubble = $('bunnyMsg');
  el.className = 'bunny ' + mood;

  clearTimeout(bunnyTimer);
  if (mood === 'idle') {
    // ทักทายเป็นครั้งคราว ไม่ต้องพูดทุกข้อ
    if (Math.random() < 0.3) {
      bubble.textContent = randOf(IDLE);
      bubble.classList.add('show');
      bunnyTimer = setTimeout(() => bubble.classList.remove('show'), 1800);
    } else {
      bubble.classList.remove('show');
    }
    return;
  }
  bubble.textContent = message;
  bubble.classList.add('show');
}

/* ── result ─────────────────────────────────────────────── */

function finish() {
  const total = state.queue.length;
  const pct = Math.round((state.ok / total) * 100);
  $('bar').style.width = '100%';
  $('scorePct').textContent = pct + '%';
  $('scoreRing').style.setProperty('--pct', pct + '%');
  $('scoreLine').textContent =
    `ถูก ${state.ok} จาก ${total} ข้อ · สตรีคสูงสุด ${state.best} · เวลาคิด ${mmss(Math.round(timer.used / 1000))}`;

  const unanswered = total - state.ok - state.bad;
  $('timeLine').textContent = `⏰ หมดเวลารวม — ไม่ได้ตอบ ${unanswered} ข้อ (นับเป็นผิด)`;
  $('timeLine').classList.toggle('hidden', !state.timeUp);

  $('wrongCount').textContent = state.wrong.length ? `(${state.wrong.length})` : '';
  const list = $('wrongList');
  list.innerHTML = '';
  if (!state.wrong.length) {
    list.innerHTML = '<p class="empty">🎉 ไม่มีข้อผิดเลย เก่งมาก!</p>';
  } else {
    for (const e of state.wrong) {
      const d = document.createElement('div');
      d.className = 'wrong-item';
      d.innerHTML =
        `<span class="hz">${e.s}</span>` +
        `<span class="info"><span class="py">${esc(e.py)}</span><br>` +
        `<span class="en">${esc(e.en.join('; '))}</span></span>`;
      d.onclick = () => speak(e.s);
      list.appendChild(d);
    }
  }
  $('retryWrong').disabled = state.wrong.length < 1;
  showResultBunny(pct);
  saveScore(pct, total);
  show('result');
}

const VERDICT = [
  [100, 'happy', 'เต็ม! กระต่ายยอมยกมือไหว้ 🙇'],
  [90, 'happy', 'แม่นมาก ไปเลเวลถัดไปได้แล้ว!'],
  [70, 'happy', 'ดีมาก! อีกนิดก็เต็มแล้ว'],
  [50, 'idle', 'พอใช้ ทบทวนคำที่ผิดอีกรอบนะ'],
  [0, 'sad', 'ไม่เป็นไร เริ่มจากคำที่ผิดก่อน สู้ ๆ 🥕'],
];

function showResultBunny(pct) {
  const [, mood, text] = VERDICT.find(([min]) => pct >= min);
  const box = $('resultBunny');
  box.innerHTML = '';
  const clone = $('bunny').cloneNode(true);
  clone.id = '';
  clone.className = 'bunny ' + mood;
  box.appendChild(clone);
  $('bunnyVerdict').textContent = text;
}

/* ── tts ────────────────────────────────────────────────── */

let zhVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  zhVoice = vs.find((v) => /^zh[-_]CN/i.test(v.lang)) || vs.find((v) => /^zh/i.test(v.lang)) || null;
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = 0.85;
  if (zhVoice) u.voice = zhVoice;
  speechSynthesis.speak(u);
}

/* ── navigation ─────────────────────────────────────────── */

function show(name) {
  if (name !== 'quiz') stopTicking();
  for (const s of ['setup', 'quiz', 'result']) $(s).classList.toggle('hidden', s !== name);
  window.scrollTo(0, 0);
}

document.addEventListener('keydown', (ev) => {
  if ($('quiz').classList.contains('hidden')) return;
  const k = ev.key.toLowerCase();
  const cur = state.queue[state.i].answer;
  if (k === 's') { speak(cur.s); return; }
  if (k === 'a' && state.locked && cur.ex) { speak(cur.ex.zh); return; }
  if (!state.locked && ['1', '2', '3'].includes(k)) {
    const n = +k - 1;
    if (n < state.queue[state.i].opts.length) answer(n);
  } else if (state.locked && (k === 'enter' || k === ' ')) {
    ev.preventDefault();
    next();
  } else if (k === 'escape') {
    show('setup');
  }
});

/* ── boot ───────────────────────────────────────────────── */

async function init() {
  loadSettings();
  ['qcount', 'mode', 'order', 'qtime', 'ttime', 'autoTTS', 'hidePY'].forEach((id) =>
    $(id).addEventListener('change', saveSettings));
  ['qcount', 'ttime'].forEach((id) => $(id).addEventListener('change', updateTimeHint));

  $('start').onclick = () => startQuiz(state.pool);
  $('next').onclick = next;
  $('speak').onclick = () => speak(state.queue[state.i].answer.s);
  $('exSpeak').onclick = () => {
    const ex = state.queue[state.i].answer.ex;
    if (ex) speak(ex.zh);
  };
  $('quit').onclick = () => show('setup');
  $('home').onclick = () => show('setup');
  $('again').onclick = () => startQuiz(state.pool);
  $('retryWrong').onclick = () => {
    const w = state.wrong.slice();
    const keep = $('qcount').value;
    $('qcount').value = '0';                 // review every missed word
    startQuiz(w);
    $('qcount').value = keep;
  };

  if ('speechSynthesis' in window) {
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
  }

  try {
    state.index = await (await fetch('data/index.json')).json();
  } catch {
    $('pool').textContent = '⚠️ โหลด data/index.json ไม่ได้ — ต้องเปิดผ่าน web server (ดู README)';
    return;
  }
  renderLevels();
  await rebuildPool();

  const prev = (() => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } })();
  if (prev.last) {
    $('resume').textContent = `ครั้งล่าสุด: ${prev.last.pct}% (${prev.last.total} ข้อ) · เล่นมาแล้ว ${prev.runs} รอบ`;
    $('resume').classList.remove('hidden');
  }
}

init();

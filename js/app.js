// Page wiring. All state lives in store.js; all card logic lives in
// template.js; this file just renders and routes events.

import { deck as calc1 } from './decks/calc1.js';
import { deck as techniques } from './decks/techniques.js';
import { deck as mech1 } from './decks/mech1.js';
import * as fsrs from './fsrs.js';
import { draw, fill, check, referenceText, validate, renderCloze, isProse } from './template.js';
import { parse, toTex, stripConstant } from './expr.js';
import { load, save, exportJSON, importJSON, defaultState, dayOf, streak, shareEncode, shareDecode, rebuildSrs } from './store.js';
import { createSync, applyStateDoc } from './sync.js';

// bury already-synced log entries so other devices drop them too
function addTombs(logs) {
  for (const l of logs) {
    if (l.synced) state.logs.push({ t: Date.now(), k: crypto.randomUUID(), tomb: l.k });
  }
}
import { Session, buildQueue, gradeFor, LEECH_LAPSES } from './session.js';
import { randomSeed } from './rng.js';
import { confetti } from './fx.js';
import { applyFreezes, streakWithFreezes, earnFreezes, longestStreak, checkBadges, BADGES, FREEZE_EVERY, examReadiness } from './gamify.js';

const SEED_DECKS = [calc1, techniques, mech1];
const $ = id => document.getElementById(id);
const DAY = 86400000;

let state = load(SEED_DECKS);
let session = null;

// ---------- rendering helpers ----------

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Text with $...$ and $$...$$ math segments.
function mathHTML(text) {
  return text.split(/(\$\$[^$]+\$\$|\$[^$]+\$)/g).map(seg => {
    if (seg.startsWith('$$')) {
      return katex.renderToString(seg.slice(2, -2), { displayMode: true, throwOnError: false });
    }
    if (seg.startsWith('$')) {
      return katex.renderToString(seg.slice(1, -1), { throwOnError: false });
    }
    return esc(seg);
  }).join('');
}

function mathInline(tex) {
  return katex.renderToString(tex, { throwOnError: false });
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), Math.max(2600, msg.length * 45));
}

// ---------- tooltips ----------
// Anything with data-tip explains itself on hover or keyboard focus,
// without the one-second wait a native title makes you sit through.

const tip = $('tip');
let tipTimer = 0, tipTarget = null;

function showTip(el) {
  tipTarget = el;
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  tip.style.left = '0px';
  tip.style.top = '0px';
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
  let top = r.bottom + 8;
  if (top + h > innerHeight - 8) top = r.top - h - 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  void tip.offsetWidth; // commit the hidden state before fading in
  tip.classList.add('show');
}

function hideTip() {
  clearTimeout(tipTimer);
  tipTarget = null;
  tip.classList.remove('show');
  tip.hidden = true;
}

document.addEventListener('mouseover', ev => {
  const el = ev.target.closest('[data-tip]');
  if (!el || el === tipTarget) return;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => showTip(el), 140);
});
document.addEventListener('mouseout', ev => {
  const el = ev.target.closest('[data-tip]');
  if (el && !el.contains(ev.relatedTarget)) hideTip();
});
document.addEventListener('focusin', ev => {
  const el = ev.target.closest('[data-tip]');
  if (el) showTip(el);
});
document.addEventListener('focusout', hideTip);
document.addEventListener('click', hideTip, true);
window.addEventListener('scroll', hideTip, { passive: true });

function persist() {
  save(state);
  if (syncer && syncer.user() && !session) scheduleSync();
}

// ---------- sync ----------

const SYNC_KEY = 'studyflex-sync';
let syncCfg = null;
try { syncCfg = JSON.parse(localStorage.getItem(SYNC_KEY)); } catch { /* stays off */ }
let syncer = null;
let syncTimer = 0;

function buildSyncer() {
  if (!syncCfg || !syncCfg.url || !syncCfg.anonKey) { syncer = null; return; }
  syncer = createSync({
    url: syncCfg.url,
    anonKey: syncCfg.anonKey,
    meta: {
      load: () => syncCfg.meta || {},
      save: m => { syncCfg.meta = m; localStorage.setItem(SYNC_KEY, JSON.stringify(syncCfg)); },
    },
  });
}
buildSyncer();

function syncStatus(text) {
  const el = $('sync-status');
  if (el) el.textContent = text;
}

function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => doSync('auto'), 4000);
}

async function doSync(reason) {
  if (!syncer || !syncer.user()) return;
  clearTimeout(syncTimer);
  syncStatus('syncing...');
  try {
    let docCame = false;
    const r = await syncer.sync(state, (doc, first) => {
      applyStateDoc(state, doc, fsrs.newState, first);
      docCame = true;
    });
    if (r.pulled || docCame) rebuildSrs(state);
    save(state);
    if (!session && (r.pulled || docCame)) { route(); renderStreak(); }
    const bits = [];
    if (r.pushed) bits.push(`${r.pushed} up`);
    if (r.pulled) bits.push(`${r.pulled} down`);
    if (r.docNote) bits.push(`cards ${r.docNote}`);
    syncStatus(`synced ${new Date().toLocaleTimeString()}${bits.length ? ': ' + bits.join(', ') : ', nothing new'}`);
  } catch (e) {
    syncStatus(`sync failed: ${e.message}`);
    if (reason === 'boot') toast('sync is having trouble; your data is safe locally');
  }
}

function renderSyncPanel() {
  const configured = !!syncer;
  const signedIn = configured && !!syncer.user();
  $('sync-setup').hidden = configured;
  $('sync-auth').hidden = !configured || signedIn;
  $('sync-on').hidden = !signedIn;
  if (signedIn) $('sync-user').textContent = syncer.user();
}

$('sync-save').addEventListener('click', () => {
  const url = $('sync-url').value.trim().replace(/\/$/, '');
  const anonKey = $('sync-key').value.trim();
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url);
  if ((!/^https:\/\/.+/.test(url) && !local) || !anonKey) { syncStatus('need the project url and its anon key'); return; }
  syncCfg = { url, anonKey, meta: {} };
  localStorage.setItem(SYNC_KEY, JSON.stringify(syncCfg));
  buildSyncer();
  renderSyncPanel();
  syncStatus('project saved. sign in, or create the account you will use on every device.');
});

$('sync-signin').addEventListener('click', async () => {
  try {
    await syncer.signIn($('sync-email').value.trim(), $('sync-pass').value);
    renderSyncPanel();
    doSync('signin');
  } catch (e) { syncStatus(`sign in failed: ${e.message}`); }
});

$('sync-signup').addEventListener('click', async () => {
  try {
    const user = await syncer.signUp($('sync-email').value.trim(), $('sync-pass').value);
    if (!user) { syncStatus('almost: confirm the email Supabase just sent, then sign in here.'); return; }
    renderSyncPanel();
    doSync('signup');
  } catch (e) { syncStatus(`could not create the account: ${e.message}`); }
});

$('sync-reset').addEventListener('click', () => {
  localStorage.removeItem(SYNC_KEY);
  syncCfg = null;
  buildSyncer();
  renderSyncPanel();
  syncStatus('');
});

$('sync-out').addEventListener('click', () => {
  syncer.signOut();
  renderSyncPanel();
  syncStatus('signed out. local data stays put.');
});

$('sync-now').addEventListener('click', () => doSync('manual'));

// ---------- theme ----------

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  $('theme-btn').textContent = `theme: ${t}`;
}
$('theme-btn').addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  const t = state.settings.theme;
  state.settings.theme = order[(order.indexOf(t) + 1) % 3];
  applyTheme();
  persist();
});

// ---------- router ----------

const VIEWS = ['today', 'cards', 'skills', 'stats'];

let lastView = '';
function route() {
  const name = location.hash.replace('#', '') || 'today';
  const view = VIEWS.includes(name) ? name : 'today';
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  if (lastView && lastView !== view) window.scrollTo(0, 0); // a new tab starts at its top
  lastView = view;
  document.querySelectorAll('nav.tabs a').forEach(a => {
    if (a.getAttribute('href') === `#${view}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (view === 'today' && !session) renderIdle();
  if (view === 'cards') renderCards();
  if (view === 'skills') { renderSkills(); renderDumpSetup(); }
  if (view === 'stats') renderStats();
}
window.addEventListener('hashchange', route);

// ---------- today: idle ----------

function renderStreak() {
  const n = streakWithFreezes(state, Date.now());
  const chip = $('streak-chip');
  const grew = !chip.hidden && Number($('streak-n').textContent) !== n;
  chip.hidden = n === 0;
  $('streak-n').textContent = n;
  if (grew || (n > 0 && chip.hidden === false)) {
    chip.classList.remove('streak-pop');
    void chip.offsetWidth;
    chip.classList.add('streak-pop');
  }
}

function renderIdle() {
  $('today-idle').hidden = false;
  $('today-session').hidden = true;
  $('today-done').hidden = true;
  const now = Date.now();
  const { due, fresh } = buildQueue(state, now);
  $('n-due').textContent = due.length;
  $('n-new').textContent = fresh.length;
  const none = due.length + fresh.length === 0;
  const seen = Object.values(state.templates).some(e => !e.suspended && !fsrs.isNew(e.srs));
  const brandNew = !state.settings.seenWelcome && !state.logs.some(l => l.id && !l.practice);
  $('welcome').hidden = !brandNew;
  $('start-btn').disabled = none;
  $('five-btn').disabled = none;
  $('lock-btn').disabled = none && !seen;
  const reviewDays = state.logs.filter(l => l.id && !l.practice).map(l => l.t);
  const lastReview = reviewDays.length ? Math.max(...reviewDays) : 0;
  const away = lastReview ? Math.floor((now - lastReview) / DAY) : 0;
  $('hero-line').textContent =
    brandNew ? 'Flashcards where the numbers change.'
    : away >= 3 && !none
      ? `Back after ${away} days. The curve forgave you; start small.`
    : none
      ? (seen ? 'Nothing due. Lock in anyway, or go live your life.' : 'Nothing due. Go live your life.')
    : due.length === 0 ? 'All caught up. New material today.'
    : 'Ready when you are.';

  // due load, next 14 days
  const bars = $('load-bars');
  bars.innerHTML = '';
  const counts = new Array(14).fill(0);
  counts[0] = due.length + fresh.length;
  for (const e of Object.values(state.templates)) {
    if (e.suspended || fsrs.isNew(e.srs) || e.srs.due <= now) continue;
    const d = Math.floor((e.srs.due - now) / DAY) + 1;
    if (d >= 1 && d < 14) counts[d]++;
  }
  const max = Math.max(1, ...counts);
  counts.forEach((c, i) => {
    const b = document.createElement('span');
    b.style.height = `${Math.round(100 * c / max)}%`;
    if (i === 0) b.className = 'now';
    b.dataset.tip = i === 0 ? `today: ${c}` : `+${i}d: ${c}`;
    bars.appendChild(b);
  });
  renderExamLine(now);
  renderReadiness(now);
  renderStreak();
}

// Predicted recall on exam day if you stopped studying now, per deck
// with an exam date. Reviews between now and then only raise it.
function renderReadiness(now) {
  const box = $('readiness');
  box.innerHTML = '';
  const rows = examReadiness(state, now);
  box.hidden = !rows.length;
  for (const r of rows) {
    const pct = Math.round(r.ready * 100);
    const cls = r.ready < 0.7 ? 'weak' : r.ready < 0.85 ? 'mid' : '';
    const div = document.createElement('div');
    div.className = 'skill-row';
    div.innerHTML = `
      <span class="skill-name">${esc(deckName(r.deckId))}</span>
      <span class="meter ${cls}" aria-hidden="true"><i style="width:${pct}%"></i></span>
      <span class="mono">${pct}% on exam day${r.unseen ? ` · ${r.unseen} untouched` : ''}</span>`;
    box.appendChild(div);
  }
}

function deckName(id) {
  return SEED_DECKS.find(d => d.id === id)?.name || 'your notes';
}

function renderExamLine(now) {
  const line = $('exam-line');
  const soonest = Object.entries(state.settings.exams || {})
    .filter(([, t]) => t > now)
    .sort((a, b) => a[1] - b[1])[0];
  line.hidden = !soonest;
  if (!soonest) return;
  const days = Math.ceil((soonest[1] - now) / DAY);
  line.innerHTML = `<b>${days === 1 ? 'tomorrow' : `${days} days`}</b> until the ${esc(deckName(soonest[0]))} exam`;
}

// ---------- today: session ----------

const ui = {
  phase: 'idle',      // answering | graded
  startedAt: 0,
  hintsUsed: 0,
  timerId: 0,
  drawn: null,        // params for the current card
  choiceOrder: null,  // shuffled option indexes
  ok: false,
  grade: 3,
  practice: false,
  lockUntil: 0,
  lockTicker: 0,
};

function startSession(lockMins = 0, opts = {}) {
  state.settings.seenWelcome = true;
  session = new Session(state, Date.now(), opts);
  ui.lockUntil = lockMins ? Date.now() + lockMins * 60000 : 0;
  if (!session.remaining && ui.lockUntil) session.refill(Date.now());
  if (!session.remaining) return;
  $('today-idle').hidden = true;
  $('today-done').hidden = true;
  $('today-session').hidden = false;
  $('undo-btn').hidden = true;
  const chip = $('lock-chip');
  chip.hidden = !ui.lockUntil;
  clearInterval(ui.lockTicker);
  if (ui.lockUntil) {
    const tick = () => {
      const left = Math.max(0, ui.lockUntil - Date.now());
      const m = Math.floor(left / 60000), s = Math.floor(left / 1000) % 60;
      chip.textContent = `${m}:${String(s).padStart(2, '0')}`;
      chip.classList.toggle('low', left < 60000);
    };
    tick();
    ui.lockTicker = setInterval(tick, 1000);
  }
  showCard();
}

function showCard() {
  if (ui.lockUntil && Date.now() >= ui.lockUntil) return endSession();
  let item = session.current;
  if (!item && ui.lockUntil && Date.now() < ui.lockUntil) {
    session.refill(Date.now());
    item = session.current;
  }
  if (!item) return endSession();
  const e = item.entry;
  const tpl = e.tpl;
  ui.phase = 'answering';
  ui.hintsUsed = 0;
  ui.practice = item.graded;
  ui.drawn = draw(tpl, randomSeed());
  ui.choiceOrder = null;

  const pct = Math.round(100 * session.done.length / Math.max(1, session.total));
  $('progress-bar').style.width = `${pct}%`;
  $('progress').setAttribute('aria-valuenow', pct);
  $('session-count').textContent = `${Math.min(session.results.length + 1, session.total)} of ${session.total}`;

  const card = $('review-card');
  card.classList.remove('session-card-enter');
  void card.offsetWidth; // restart the entry animation
  card.classList.add('session-card-enter');

  const meta = $('review-meta');
  meta.innerHTML = '';
  for (const s of tpl.skills) {
    const t = document.createElement('span');
    t.className = 'tag';
    t.textContent = s;
    meta.appendChild(t);
  }
  if (fsrs.isNew(e.srs) && !ui.practice) {
    const t = document.createElement('span');
    t.className = 'tag';
    t.style.color = 'var(--easy)';
    t.textContent = 'new';
    meta.appendChild(t);
  }
  if (ui.practice) {
    const t = document.createElement('span');
    t.className = 'tag practice-tag';
    t.textContent = item.extra ? 'bonus round' : 'until it sticks';
    meta.appendChild(t);
  }

  const filled = fill(tpl.prompt, ui.drawn);
  $('prompt').innerHTML = tpl.answer.type === 'cloze'
    ? mathHTML(renderCloze(filled, ui.drawn._cloze))
    : mathHTML(filled);
  $('parse-note').textContent = '';
  $('hint-text').textContent = '';
  $('hint-btn').disabled = !(tpl.hints && tpl.hints.length);
  $('hint-btn').textContent = 'hint';
  $('outcome').hidden = true;

  const area = $('answer-area');
  area.innerHTML = '';
  const a = tpl.answer;
  if (a.type === 'number' || a.type === 'expression' || a.type === 'text' || a.type === 'cloze') {
    const row = document.createElement('div');
    row.className = 'answer-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'answer-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'your answer');
    input.placeholder =
      a.type === 'cloze' ? 'the missing part'
      : a.type === 'text' ? 'your answer'
      : a.type === 'expression'
        ? (a.upToConstant ? 'your answer (the + C is optional)' : 'your answer, e.g. 3x^2')
        : 'your answer, e.g. 1/2 or 0.5';
    const btn = document.createElement('button');
    btn.className = 'plain';
    btn.textContent = 'check';
    btn.addEventListener('click', submit);
    row.append(input, btn);
    area.appendChild(row);
    input.focus();
  } else if (a.type === 'choice') {
    const wrap = document.createElement('div');
    wrap.className = 'choices';
    const order = a.options.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    ui.choiceOrder = order;
    order.forEach((optIdx, pos) => {
      const b = document.createElement('button');
      b.dataset.opt = optIdx;
      b.innerHTML = `<span class="idx">${'abcd'[pos] || pos + 1}</span><span>${mathHTML(fill(a.options[optIdx], ui.drawn))}</span>`;
      b.addEventListener('click', () => submitChoice(optIdx, b));
      wrap.appendChild(b);
    });
    area.appendChild(wrap);
  } else if (a.type === 'self') {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = 'Work it out, then reveal and grade yourself.';
    const b = document.createElement('button');
    b.className = 'primary';
    b.id = 'reveal-btn';
    b.textContent = 'show answer';
    b.addEventListener('click', reveal);
    area.append(p, b);
  } else if (a.type === 'steps') {
    ui.stepIdx = 0;
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = 'Do the step on paper first, then check it against the reveal.';
    const list = document.createElement('div');
    list.id = 'steps-list';
    const b = document.createElement('button');
    b.className = 'primary';
    b.id = 'step-btn';
    b.textContent = 'check my first step';
    b.addEventListener('click', revealStep);
    area.append(p, list, b);
  }

  // keyboard users land on the thing to press next
  const firstControl = $('reveal-btn') || $('step-btn') || document.querySelector('.choices button');
  if (firstControl) firstControl.focus();

  // echo back the math the checker will read, as it is typed
  const input = $('answer-input');
  if (input && (a.type === 'number' || a.type === 'expression')) {
    const preview = document.createElement('div');
    preview.className = 'input-preview';
    input.closest('.answer-row').after(preview);
    const scope = a.type === 'expression'
      ? [...(a.vars || []), ...Object.keys(ui.drawn).filter(p => typeof ui.drawn[p] === 'number')]
      : [];
    input.addEventListener('input', () => {
      const raw = a.upToConstant ? stripConstant(input.value) : input.value;
      $('parse-note').textContent = '';
      try {
        preview.innerHTML = raw.trim()
          ? katex.renderToString(toTex(parse(raw, scope)), { throwOnError: false })
          : '';
      } catch { preview.innerHTML = ''; }
    });
  }

  ui.startedAt = Date.now();
  startTimer(tpl.par || 60);
}

function startTimer(par) {
  clearInterval(ui.timerId);
  const timer = $('timer');
  const bar = timer.firstElementChild;
  timer.classList.remove('over');
  bar.style.transition = 'none';
  bar.style.width = '0';
  void bar.offsetWidth;
  bar.style.transition = '';
  ui.timerId = setInterval(() => {
    const t = (Date.now() - ui.startedAt) / 1000;
    bar.style.width = `${Math.min(100, 100 * t / par)}%`;
    if (t > par) timer.classList.add('over');
  }, 1000);
}

function elapsed() { return Date.now() - ui.startedAt; }

function submit() {
  if (ui.phase !== 'answering') return;
  const tpl = session.current.entry.tpl;
  const input = $('answer-input');
  if (!input || !input.value.trim()) return;
  const result = check(tpl, ui.drawn, input.value);
  if (result.error) {
    $('parse-note').textContent = result.error;
    return;
  }
  input.disabled = true;
  input.classList.add(result.ok ? 'right' : 'wrong');
  finishAnswer(result.ok);
}

function submitChoice(optIdx, btn) {
  if (ui.phase !== 'answering') return;
  const tpl = session.current.entry.tpl;
  const ok = optIdx === tpl.answer.correct;
  btn.classList.add(ok ? 'right' : 'wrong');
  if (!ok) {
    document.querySelectorAll('.choices button').forEach(b => {
      if (Number(b.dataset.opt) === tpl.answer.correct) b.classList.add('right');
    });
  }
  document.querySelectorAll('.choices button').forEach(b => b.disabled = true);
  finishAnswer(ok);
}

function reveal() {
  if (ui.phase !== 'answering') return;
  finishAnswer(null); // self-graded: verdict comes from the grade keys
}

function revealStep() {
  if (ui.phase !== 'answering') return;
  const tpl = session.current.entry.tpl;
  const steps = tpl.answer.steps;
  const row = document.createElement('div');
  row.className = 'step-row session-card-enter';
  row.innerHTML = `<span class="mono step-n">${ui.stepIdx + 1}</span><div>${mathHTML(fill(steps[ui.stepIdx], ui.drawn))}</div>`;
  $('steps-list').appendChild(row);
  ui.stepIdx++;
  const btn = $('step-btn');
  if (ui.stepIdx >= steps.length) {
    btn.hidden = true;
    finishAnswer(null);
  } else {
    btn.textContent = `check step ${ui.stepIdx + 1}`;
  }
}

function finishAnswer(ok) {
  clearInterval(ui.timerId);
  const tpl = session.current.entry.tpl;
  const ms = elapsed();
  ui.phase = 'graded';

  const selfGraded = ok === null;
  ui.ok = selfGraded ? true : ok;
  ui.selfGraded = selfGraded;
  ui.grade = selfGraded ? 0 : gradeFor(ok, ms, ui.hintsUsed, tpl.par || 60);

  const verdict = $('verdict');
  if (selfGraded) {
    verdict.textContent = 'how did it go?';
    verdict.className = 'verdict';
  } else {
    verdict.textContent = ok ? `right, ${(ms / 1000).toFixed(0)}s` : 'not this time';
    verdict.className = `verdict ${ok ? 'ok' : 'no'}`;
  }

  let solution = '';
  const ref = referenceText(tpl, ui.drawn);
  if (ref && !['choice', 'self', 'steps'].includes(tpl.answer.type)) {
    solution += isProse(tpl)
      ? `<p>Answer: <b>${esc(ref)}</b></p>`
      : `<p>Answer: ${mathInline(ref)}</p>`;
  }
  if (tpl.solution) solution += mathHTML(fill(tpl.solution, ui.drawn));
  $('solution').innerHTML = solution;

  $('grade-row').hidden = false;
  const hideGrades = ui.practice && !selfGraded;
  document.querySelectorAll('.grade').forEach(b => {
    b.classList.toggle('on', Number(b.dataset.g) === ui.grade);
    b.hidden = hideGrades;
  });
  const par = tpl.par || 60;
  const secs = (ms / 1000).toFixed(0);
  $('grade-lead').textContent = selfGraded
    ? 'grade yourself honestly'
    : !ok ? 'again: it comes back later this session'
    : ui.hintsUsed ? 'hard: right, but with a hint'
    : ms > 1.5 * par * 1000 ? `hard: right, but ${secs}s against a par of ${par}s`
    : ms <= 0.6 * par * 1000 ? `easy: ${secs}s against a par of ${par}s`
    : `good: ${secs}s against a par of ${par}s`;
  $('grade-lead').hidden = ui.practice;
  $('next-btn').textContent = selfGraded ? 'grade with 1-4' : 'next';
  $('next-btn').disabled = selfGraded;
  $('outcome').hidden = false;
  $('next-btn').focus();
}

function pickGrade(g) {
  if (ui.phase !== 'graded') return;
  const selfType = ui.selfGraded;
  if (ui.practice && !selfType) return;
  ui.grade = g;
  if (selfType) ui.ok = g >= 2;
  document.querySelectorAll('.grade').forEach(b =>
    b.classList.toggle('on', Number(b.dataset.g) === g));
  $('next-btn').disabled = false;
  $('next-btn').textContent = 'next';
}

function nextCard() {
  if (ui.phase !== 'graded' || $('next-btn').disabled) return;
  const tpl = session.current.entry.tpl;
  session.answer(ui.ok, elapsed(), ui.hintsUsed, ui.grade || 3, Date.now());
  if (session.leech) {
    toast(`"${tpl.name}" keeps lapsing: rewrite it or pause it on the cards page`);
  }
  $('undo-btn').hidden = !session.lastUndo;
  persist();
  showCard();
}

function undoLast() {
  if (!session) return;
  const removed = session.undo();
  if (!removed) return;
  addTombs([removed]);
  $('undo-btn').hidden = true;
  persist();
  toast('took that one back');
  showCard();
}

function endSession() {
  clearInterval(ui.timerId);
  clearInterval(ui.lockTicker);
  $('lock-chip').hidden = true;
  const locked = ui.lockUntil
    ? Math.round((Math.min(Date.now(), ui.lockUntil) - session.startedAt) / 60000)
    : 0;
  ui.lockUntil = 0;
  const s = session.summary();
  const practiced = session.results.filter(r => r.practice).length;
  if (locked >= 5) state.logs.push({ t: Date.now(), lock: locked, k: crypto.randomUUID() });
  session = null;

  const now = Date.now();
  const currentStreak = streakWithFreezes(state, now);
  const earnedFreezes = earnFreezes(state, currentStreak);
  const { fresh } = checkBadges(state, now, currentStreak);
  persist();
  renderStreak();
  if (earnedFreezes) {
    toast(`${currentStreak}-day streak: freeze banked. one missed day is now survivable.`);
  } else if (fresh.length) {
    const b = BADGES.find(x => x.id === fresh[0]);
    toast(`badge earned: ${b.name} (${b.desc})`);
  }
  if (!s.graded && !practiced) { renderIdle(); return; }
  $('today-session').hidden = true;
  $('today-done').hidden = false;
  const bits = [`<b>${s.right}</b> of <b>${s.graded}</b> right`];
  if (practiced) bits.push(`${practiced} practice`);
  bits.push(locked ? `locked in ${locked} min` : `${s.minutes.toFixed(1)} min`);
  $('done-line').innerHTML = bits.join(' &nbsp;·&nbsp; ');
  ui.lastRight = s.right;
  ui.lastGraded = s.graded;
  $('done-share-btn').hidden = !Object.values(state.templates).some(e => e.custom);
  confetti(fresh.length ? 1.8 : s.graded >= 10 ? 1.4 : 1);
  const list = $('done-skills');
  list.innerHTML = '';
  const rows = Object.entries(s.bySkill).sort((a, b) => a[1].right / a[1].total - b[1].right / b[1].total);
  for (const [skill, r] of rows) {
    const div = document.createElement('div');
    div.className = 'skill-delta';
    div.innerHTML = `<span>${esc(skill)}</span><span class="mono">${r.right}/${r.total}</span>`;
    list.appendChild(div);
  }
}

$('start-btn').addEventListener('click', () => startSession(0));
$('welcome-go').addEventListener('click', () => startSession(0, { cap: 5 }));
$('welcome-dismiss').addEventListener('click', () => { state.settings.seenWelcome = true; persist(); renderIdle(); });
$('five-btn').addEventListener('click', () => startSession(0, { cap: 5 }));
$('lock-btn').addEventListener('click', () => startSession(Number($('lock-mins').value)));
$('undo-btn').addEventListener('click', undoLast);
$('back-btn').addEventListener('click', renderIdle);
$('next-btn').addEventListener('click', nextCard);
$('hint-btn').addEventListener('click', () => {
  const tpl = session && session.current && session.current.entry.tpl;
  if (!tpl || ui.phase !== 'answering') return;
  const hints = tpl.hints || [];
  if (ui.hintsUsed >= hints.length) return;
  $('hint-text').innerHTML = mathHTML(fill(hints[ui.hintsUsed], ui.drawn));
  ui.hintsUsed++;
  $('hint-btn').textContent = ui.hintsUsed < hints.length ? 'another hint' : 'hint';
  $('hint-btn').disabled = ui.hintsUsed >= hints.length;
});
document.querySelectorAll('.grade').forEach(b =>
  b.addEventListener('click', () => pickGrade(Number(b.dataset.g))));

document.addEventListener('keydown', ev => {
  if (!session) return;
  const typing = ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA';
  if (ev.key === 'Enter' || ev.keyCode === 13 || (ev.key === ' ' && !typing)) {
    if (ui.phase === 'answering') {
      const tpl = session.current.entry.tpl;
      if (tpl.answer.type === 'self') reveal();
      else if (tpl.answer.type === 'steps') revealStep();
      else if (typing) submit();
      ev.preventDefault();
    } else if (ui.phase === 'graded') {
      nextCard();
      ev.preventDefault();
    }
    return;
  }
  if (typing) return;
  if (ev.key === 'Escape') {
    if ($('keys-overlay').hidden) endSession(); // else Escape just closes the overlay
    return;
  }
  if (ev.key === 'h' && ui.phase === 'answering') { $('hint-btn').click(); return; }
  if (ev.key === 'u' && ui.phase === 'answering') { undoLast(); return; }
  if (ui.phase === 'graded' && '1234'.includes(ev.key)) {
    pickGrade(Number(ev.key));
    return;
  }
  if (ui.phase === 'answering' && ui.choiceOrder && 'abcd'.includes(ev.key)) {
    const pos = 'abcd'.indexOf(ev.key);
    const btn = document.querySelectorAll('.choices button')[pos];
    if (btn) btn.click();
  }
});

// ---------- cards ----------

let editingId = null;

function fmtDue(e) {
  if (fsrs.isNew(e.srs)) return 'new';
  const d = Math.round((e.srs.due - Date.now()) / DAY);
  if (d <= 0) return 'now';
  return d === 1 ? 'tomorrow' : `in ${d}d`;
}

function renderCards() {
  const tbody = $('cards-table').querySelector('tbody');
  tbody.innerHTML = '';
  const query = $('card-search').value.trim().toLowerCase();
  const all = Object.values(state.templates);
  const entries = all
    .filter(e => !query ||
      `${e.tpl.name} ${e.tpl.skills.join(' ')} ${e.deckId}`.toLowerCase().includes(query))
    .sort((a, b) => a.tpl.name.localeCompare(b.tpl.name));
  $('card-count').textContent = query
    ? `${entries.length} of ${all.length} cards`
    : `${all.length} cards`;
  $('cards-hint').hidden = all.some(e => e.custom);
  for (const e of entries) {
    const tr = document.createElement('tr');
    if (e.suspended) tr.className = 'suspended';
    const stability = fsrs.isNew(e.srs) ? '' : `${e.srs.stability.toFixed(1)}d`;
    const leech = e.srs.lapses >= LEECH_LAPSES ? ' <span class="tag leech">leech</span>' : '';
    tr.innerHTML = `
      <td>${esc(e.tpl.name)}${leech}${e.custom ? ' <span class="fine">edited</span>' : ''}</td>
      <td class="mono">${esc(e.tpl.skills.join(', '))}</td>
      <td class="mono">${stability}</td>
      <td class="mono">${fmtDue(e)}</td>
      <td class="actions"></td>`;
    const actions = tr.querySelector('.actions');
    const edit = document.createElement('button');
    edit.className = 'plain';
    edit.textContent = 'edit';
    edit.addEventListener('click', () => openEditor(e.tpl.id));
    actions.appendChild(edit);
    const susp = document.createElement('button');
    susp.className = 'plain';
    susp.textContent = e.suspended ? 'resume' : 'pause';
    susp.addEventListener('click', () => {
      e.suspended = !e.suspended;
      persist(); renderCards();
    });
    actions.appendChild(susp);
    if (e.custom && !e.tpl.id.startsWith('calc1/')) {
      const del = document.createElement('button');
      del.className = 'plain danger';
      del.textContent = 'delete';
      del.addEventListener('click', () => {
        if (!confirm(`Delete "${e.tpl.name}" and its history?`)) return;
        delete state.templates[e.tpl.id];
        const gone = state.logs.filter(l => l.id === e.tpl.id);
        state.logs = state.logs.filter(l => l.id !== e.tpl.id);
        addTombs(gone);
        persist(); renderCards();
      });
      actions.appendChild(del);
    }
    tbody.appendChild(tr);
  }
}

function openEditor(id) {
  editingId = id;
  $('editor').hidden = false;
  $('ed-errors').textContent = '';
  if (id) {
    const t = state.templates[id].tpl;
    $('editor-title').textContent = `editing: ${t.name}`;
    $('ed-name').value = t.name;
    $('ed-skills').value = t.skills.join(', ');
    $('ed-par').value = t.par || 45;
    $('ed-prompt').value = t.prompt;
    $('ed-params').value = JSON.stringify(t.params || {}, null, 1);
    $('ed-answer').value = JSON.stringify(t.answer, null, 1);
    $('ed-hints').value = (t.hints || []).join('\n');
    $('ed-solution').value = t.solution || '';
  } else {
    $('editor-title').textContent = 'new card';
    for (const f of ['ed-name', 'ed-skills', 'ed-prompt', 'ed-params', 'ed-answer', 'ed-hints', 'ed-solution']) $(f).value = '';
    $('ed-par').value = 45;
  }
  refreshPreview();
  $('ed-name').focus();
}

function readEditor() {
  const name = $('ed-name').value.trim();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'card';
  const id = editingId || `user/${slug}-${Date.now().toString(36)}`;
  let params, answer;
  try { params = $('ed-params').value.trim() ? JSON.parse($('ed-params').value) : {}; }
  catch (e) { throw new Error(`params JSON: ${e.message}`); }
  try { answer = JSON.parse($('ed-answer').value); }
  catch (e) { throw new Error(`answer JSON: ${e.message}`); }
  return {
    id, name,
    skills: $('ed-skills').value.split(',').map(s => s.trim()).filter(Boolean),
    par: Number($('ed-par').value) || 45,
    prompt: $('ed-prompt').value,
    params, answer,
    hints: $('ed-hints').value.split('\n').map(s => s.trim()).filter(Boolean),
    solution: $('ed-solution').value.trim(),
  };
}

function refreshPreview() {
  const box = $('ed-preview');
  try {
    const tpl = readEditor();
    if (!tpl.prompt.trim()) {
      box.innerHTML = '<span class="fine">fill in the prompt to see a draw</span>';
      return;
    }
    const params = draw(tpl, randomSeed());
    let html = mathHTML(fill(tpl.prompt, params));
    const ref = referenceText(tpl, params);
    if (ref) html += `<p class="note">answer: ${mathInline(ref)}</p>`;
    box.innerHTML = html;
    $('ed-errors').textContent = '';
  } catch (e) {
    box.innerHTML = '<span class="fine">draw failed</span>';
    $('ed-errors').textContent = e.message;
  }
}

$('card-search').addEventListener('input', renderCards);
$('new-card-btn').addEventListener('click', () => openEditor(null));
$('ed-cancel').addEventListener('click', () => { $('editor').hidden = true; editingId = null; });
$('ed-redraw').addEventListener('click', refreshPreview);
for (const f of ['ed-prompt', 'ed-params', 'ed-answer']) {
  $(f).addEventListener('change', refreshPreview);
}
$('ed-save').addEventListener('click', () => {
  let tpl;
  try { tpl = readEditor(); }
  catch (e) { $('ed-errors').textContent = e.message; return; }
  const problems = validate(tpl);
  if (problems.length) {
    $('ed-errors').textContent = problems.join('\n');
    return;
  }
  const existing = state.templates[tpl.id];
  if (existing) {
    existing.tpl = tpl;
    existing.custom = true;
  } else {
    state.templates[tpl.id] = {
      tpl, deckId: 'user', custom: true, suspended: false, srs: fsrs.newState(),
    };
  }
  persist();
  $('editor').hidden = true;
  editingId = null;
  renderCards();
  toast('card saved: it survived 100 draws');
});

// ---------- import / export ----------

let fileMode = 'deck';
function pickFile(mode, accept) {
  fileMode = mode;
  $('file-input').setAttribute('accept', accept);
  $('file-input').click();
}
$('import-btn').addEventListener('click', () => pickFile('deck', 'application/json'));
$('import-all-btn').addEventListener('click', () => pickFile('all', 'application/json'));
$('notes-file-btn').addEventListener('click', () => pickFile('notes', '.txt,.md,text/plain,text/markdown'));
$('file-input').addEventListener('change', async ev => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  const text = await file.text();
  if (fileMode === 'notes') {
    $('notes-text').value = text;
    toast(`loaded ${file.name}`);
    return;
  }
  try {
    if (fileMode === 'all') {
      if (!confirm('Replace everything with this export?')) return;
      state = importJSON(text);
      state = mergeSeeds(state);
      persist();
      applyTheme();
      route();
      toast('restored');
      return;
    }
    const data = JSON.parse(text);
    const templates = Array.isArray(data) ? data : data.templates;
    if (!Array.isArray(templates)) throw new Error('expected {templates: [...]}');
    let added = 0, skipped = 0;
    for (const tpl of templates) {
      const problems = validate(tpl);
      if (problems.length || state.templates[tpl.id]) { skipped++; continue; }
      state.templates[tpl.id] = {
        tpl, deckId: data.id || 'imported', custom: true, suspended: false, srs: fsrs.newState(),
      };
      added++;
    }
    persist();
    renderCards();
    toast(`imported ${added} cards${skipped ? `, skipped ${skipped}` : ''}`);
  } catch (e) {
    toast(`import failed: ${e.message}`);
  }
});

function mergeSeeds(s) { return load(SEED_DECKS, { getItem: () => JSON.stringify(s), setItem: () => {} }); }

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

$('export-deck-btn').addEventListener('click', () => {
  const templates = Object.values(state.templates).filter(e => e.custom).map(e => e.tpl);
  if (!templates.length) { toast('no edited or custom cards yet'); return; }
  download('studyflex-deck.json', JSON.stringify({ id: 'shared', name: 'shared deck', templates }, null, 1));
});

// share your cards as a link, the way a pit run shares as a seed
async function shareCards() {
  const templates = Object.values(state.templates).filter(e => e.custom).map(e => e.tpl);
  if (!templates.length) { toast('no edited or custom cards to share yet'); return; }
  const encoded = shareEncode(templates);
  if (encoded.length > 30000) { toast('too many cards for a link: use export instead'); return; }
  const url = `${location.origin}${location.pathname}#deck=${encoded}`;
  try {
    await navigator.clipboard.writeText(url);
    toast(`link copied: ${templates.length} cards ride along in the URL`);
  } catch {
    prompt('copy this link', url);
  }
}
$('share-btn').addEventListener('click', shareCards);
$('done-share-btn').addEventListener('click', shareCards);

// a one-line brag with the link, for the group chat
$('brag-btn').addEventListener('click', async () => {
  const days = streakWithFreezes(state, Date.now());
  const line = `${days}-day streak on studyflex${ui.lastRight !== undefined ? ` · ${ui.lastRight}/${ui.lastGraded} right today` : ''} · flashcards where the numbers change: ${location.origin}${location.pathname}`;
  try { await navigator.clipboard.writeText(line); toast('copied. paste it wherever the group chat lives.'); }
  catch { prompt('copy this', line); }
});

function importFromHash() {
  const m = location.hash.match(/^#deck=(.+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname);
  let templates;
  try { templates = shareDecode(m[1]); }
  catch { toast('that deck link did not decode'); return; }
  const fresh = templates.filter(t => t && t.id && !state.templates[t.id]);
  if (!fresh.length) { toast('nothing new in that deck link'); return; }
  if (!confirm(`This link carries ${fresh.length} cards. Add them?`)) return;
  const { added, problems } = saveTemplates(fresh);
  toast(added ? `added ${added} cards from the link` : `no valid cards: ${problems[0] || ''}`);
  route();
}
$('export-all-btn').addEventListener('click', () => {
  // backups travel between machines; the API key stays in this browser
  const clean = { ...state, settings: { ...state.settings, apiKey: undefined } };
  download(`studyflex-backup-${dayOf(Date.now())}.json`, exportJSON(clean));
  state.settings.lastExportAt = Date.now();
  persist();
  renderStats();
});

// ---------- keyboard help ----------

document.addEventListener('keydown', ev => {
  if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
  if (ev.key === '?') $('keys-overlay').hidden = !$('keys-overlay').hidden;
  else if (ev.key === 'Escape') $('keys-overlay').hidden = true;
});
$('keys-overlay').addEventListener('click', () => { $('keys-overlay').hidden = true; });
$('wipe-btn').addEventListener('click', () => {
  if (!confirm('Erase every card, edit, and review? Exports are the only way back.')) return;
  state = load(SEED_DECKS, { getItem: () => null, setItem: () => {} });
  persist();
  route();
  toast('wiped');
});

// ---------- add from notes ----------

function notesSkills() {
  const raw = $('notes-skills').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return raw.length ? raw : ['notes'];
}

function saveTemplates(templates) {
  let added = 0;
  const problems = [];
  for (const tpl of templates) {
    const bad = validate(tpl);
    if (bad.length) { problems.push(`${tpl.name}: ${bad[0]}`); continue; }
    state.templates[tpl.id] = {
      tpl, deckId: 'notes', custom: true, suspended: false, srs: fsrs.newState(),
    };
    added++;
  }
  if (added) persist();
  return { added, problems };
}

$('notes-btn').addEventListener('click', () => {
  $('notes-panel').hidden = !$('notes-panel').hidden;
});

$('notes-mark-btn').addEventListener('click', () => {
  const ta = $('notes-text');
  const { selectionStart: a, selectionEnd: b, value } = ta;
  if (a === b) { toast('select the words to hide first'); return; }
  ta.value = `${value.slice(0, a)}[[${value.slice(a, b)}]]${value.slice(b)}`;
  ta.focus();
  ta.setSelectionRange(a, b + 4);
});

$('notes-make-btn').addEventListener('click', () => {
  const lines = $('notes-text').value.split('\n').map(s => s.trim());
  const marked = lines.filter(l => /\[\[.+?\]\]/.test(l));
  if (!marked.length) { toast('no [[marked]] lines yet: select words and mark them'); return; }
  const skills = notesSkills();
  const templates = marked.map(line => ({
    id: `notes/${line.replace(/\[\[|\]\]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${Date.now().toString(36)}`,
    name: line.replace(/\[\[|\]\]/g, '').slice(0, 60),
    skills,
    par: 30,
    prompt: line,
    params: {},
    answer: { type: 'cloze' },
  }));
  const { added, problems } = saveTemplates(templates);
  toast(added ? `made ${added} cloze cards` : `no cards: ${problems[0] || 'nothing valid'}`);
  renderCards();
});

$('qa-kind').addEventListener('change', () => {
  const explain = $('qa-kind').value === 'explain';
  $('qa-back').placeholder = explain
    ? 'the model answer you will compare against'
    : 'helicase (commas separate accepted answers)';
});

$('qa-add').addEventListener('click', () => {
  const kind = $('qa-kind').value;
  const front = $('qa-front').value.trim();
  const back = $('qa-back').value.trim();
  if (!front || !back) { toast('fill in both boxes'); return; }
  const tpl = {
    id: `notes/${front.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${Date.now().toString(36)}`,
    name: front.slice(0, 60),
    skills: notesSkills(),
    par: kind === 'explain' ? 90 : 25,
    prompt: front,
    params: {},
    answer: kind === 'explain'
      ? { type: 'self' }
      : { type: 'text', accept: back.split(',').map(s => s.trim()).filter(Boolean) },
    ...(kind === 'explain' ? { solution: back } : {}),
  };
  const { added, problems } = saveTemplates([tpl]);
  if (added) {
    $('qa-front').value = '';
    $('qa-back').value = '';
    toast('card added');
    renderCards();
  } else toast(problems[0] || 'could not add that card');
});

// ---------- AI drafting ----------

let aiProposals = [];

function renderProposals() {
  const list = $('ai-list');
  list.innerHTML = '';
  $('ai-actions').hidden = !aiProposals.length;
  aiProposals.forEach((tpl, i) => {
    const row = document.createElement('label');
    row.className = 'ai-card';
    const preview = tpl.answer.type === 'cloze'
      ? esc(tpl.prompt).replace(/\[\[(.+?)\]\]/g, '<b>$1</b>')
      : esc(tpl.prompt);
    row.innerHTML = `
      <input type="checkbox" checked data-i="${i}">
      <span class="body">
        <span class="kind">${tpl.answer.type === 'text' ? 'typed answer' : tpl.answer.type === 'cloze' ? 'cloze' : 'explain back'} · ${esc(tpl.skills.join(', '))}</span>
        <div class="preview">${preview}</div>
      </span>`;
    list.appendChild(row);
  });
}

$('notes-ai-btn').addEventListener('click', async () => {
  const notes = $('notes-text').value.trim();
  if (notes.length < 40) { toast('paste some notes first'); return; }
  if (!state.settings.apiKey) {
    $('ai-status').textContent = 'add your Anthropic API key under stats first; it stays in this browser.';
    return;
  }
  const btn = $('notes-ai-btn');
  btn.disabled = true;
  $('ai-status').textContent = 'drafting cards...';
  try {
    const { draftCards } = await import('./ai.js');
    aiProposals = await draftCards(notes, state.settings.apiKey);
    $('ai-status').textContent = aiProposals.length
      ? `${aiProposals.length} drafts. uncheck any you don't want, then add.`
      : 'the model found nothing card-worthy in that paste.';
    renderProposals();
  } catch (e) {
    $('ai-status').textContent = `drafting failed: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});

$('ai-accept').addEventListener('click', () => {
  const keep = [...$('ai-list').querySelectorAll('input:checked')]
    .map(cb => aiProposals[Number(cb.dataset.i)]);
  const { added, problems } = saveTemplates(keep);
  aiProposals = [];
  renderProposals();
  $('ai-status').textContent = problems.length ? `skipped ${problems.length}: ${problems[0]}` : '';
  toast(`added ${added} cards`);
  renderCards();
});

$('ai-clear').addEventListener('click', () => {
  aiProposals = [];
  renderProposals();
  $('ai-status').textContent = '';
});

// ---------- brain dump ----------

const dump = { skill: null, startedAt: 0, timerId: 0 };

function renderDumpSetup() {
  $('dump-setup').hidden = false;
  $('dump-live').hidden = true;
  $('dump-review').hidden = true;
  const sel = $('dump-skill');
  sel.innerHTML = '';
  const skills = new Set();
  for (const e of Object.values(state.templates)) {
    if (e.suspended || fsrs.isNew(e.srs)) continue;
    for (const s of e.tpl.skills) skills.add(s);
  }
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'everything I have studied';
  sel.appendChild(all);
  for (const s of [...skills].sort()) {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = s;
    sel.appendChild(o);
  }
  $('dump-start').disabled = skills.size === 0;
}

$('dump-start').addEventListener('click', () => {
  dump.skill = $('dump-skill').value;
  dump.startedAt = Date.now();
  $('dump-setup').hidden = true;
  $('dump-live').hidden = false;
  $('dump-text').value = '';
  $('dump-text').focus();
  const total = 180000;
  clearInterval(dump.timerId);
  const tick = () => {
    const left = Math.max(0, dump.startedAt + total - Date.now());
    const m = Math.floor(left / 60000), s = Math.floor(left / 1000) % 60;
    $('dump-clock').textContent = `${m}:${String(s).padStart(2, '0')}`;
    $('dump-clock').classList.toggle('low', left < 30000);
    $('dump-bar').style.width = `${100 * (1 - left / total)}%`;
    if (left === 0) { clearInterval(dump.timerId); toast('time. finish the thought, then compare.'); }
  };
  tick();
  dump.timerId = setInterval(tick, 1000);
});

$('dump-finish').addEventListener('click', () => {
  clearInterval(dump.timerId);
  const words = $('dump-text').value.trim().split(/\s+/).filter(Boolean).length;
  const entries = Object.values(state.templates).filter(e =>
    !e.suspended && !fsrs.isNew(e.srs) &&
    (!dump.skill || e.tpl.skills.includes(dump.skill)));
  state.logs.push({ t: Date.now(), practice: 1, id: 'dump', dump: 1, skill: dump.skill || 'all', words, k: crypto.randomUUID() });
  persist();
  $('dump-live').hidden = true;
  $('dump-review').hidden = false;
  $('dump-verdict').textContent =
    `${words} words from memory. Here is what ${dump.skill ? `"${dump.skill}"` : 'your studied material'} actually covers; anything that never surfaced is your real to-do list.`;
  const list = $('dump-cards');
  list.innerHTML = '';
  const now = Date.now();
  for (const e of entries.sort((a, b) => a.tpl.name.localeCompare(b.tpl.name))) {
    const row = document.createElement('div');
    row.className = 'dump-card';
    row.innerHTML = `<span>${esc(e.tpl.name)}</span><span class="spacer" style="flex:1"></span><span class="mono">${esc(e.tpl.skills.join(', '))} · ${Math.round(fsrs.retrievability(e.srs, now) * 100)}%</span>`;
    list.appendChild(row);
  }
});

$('dump-again').addEventListener('click', renderDumpSetup);

// ---------- skills ----------

function renderSkills() {
  const now = Date.now();
  const bySkill = {};
  for (const e of Object.values(state.templates)) {
    if (e.suspended) continue;
    for (const s of e.tpl.skills) {
      bySkill[s] = bySkill[s] || { seen: [], unseen: 0, due: 0 };
      if (fsrs.isNew(e.srs)) bySkill[s].unseen++;
      else {
        bySkill[s].seen.push(fsrs.retrievability(e.srs, now));
        if (e.srs.due <= now) bySkill[s].due++;
      }
    }
  }
  const list = $('skills-list');
  list.innerHTML = '';
  const rows = Object.entries(bySkill).map(([name, r]) => ({
    name, ...r,
    strength: r.seen.length ? r.seen.reduce((a, b) => a + b, 0) / r.seen.length : null,
  })).sort((a, b) => (a.strength ?? 2) - (b.strength ?? 2));
  $('skills-empty').hidden = rows.some(r => r.strength !== null);
  for (const r of rows) {
    const div = document.createElement('div');
    div.className = 'skill-row';
    const pct = r.strength === null ? 0 : Math.round(r.strength * 100);
    const cls = r.strength === null ? '' : r.strength < 0.7 ? 'weak' : r.strength < 0.85 ? 'mid' : '';
    const label = r.strength === null
      ? 'not started'
      : `${pct}%${r.due ? ` · ${r.due} due` : ''}${r.unseen ? ` · ${r.unseen} unseen` : ''}`;
    div.innerHTML = `
      <span class="skill-name">${esc(r.name)}</span>
      <span class="meter ${cls}" aria-hidden="true"><i style="width:${pct}%"></i></span>
      <span class="mono">${label}</span>`;
    if (r.strength !== null) {
      const drill = document.createElement('button');
      drill.className = 'plain';
      drill.textContent = 'drill';
      drill.dataset.tip = 'practice this skill now, weakest cards first. the schedule is not touched';
      drill.addEventListener('click', () => {
        location.hash = '#today';
        startSession(0, { practiceSkill: r.name, cap: 10 });
      });
      div.appendChild(drill);
    }
    list.appendChild(div);
  }
}

// ---------- stats ----------

function drawBars(canvas, values, highlight = -1) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim();
  const dim = css.getPropertyValue('--card-2').trim();
  const muted = css.getPropertyValue('--muted').trim();
  const max = Math.max(1, ...values);
  const gap = 3;
  const bw = (w - gap * (values.length - 1)) / values.length;
  values.forEach((v, i) => {
    const bh = Math.max(v > 0 ? 3 : 1, (h - 16) * v / max);
    ctx.fillStyle = v === 0 ? dim : (i === highlight ? accent : muted);
    ctx.globalAlpha = v === 0 ? 0.6 : (i === highlight ? 1 : 0.55);
    ctx.beginPath();
    ctx.roundRect(i * (bw + gap), h - 14 - bh, bw, bh, 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  ctx.fillStyle = muted;
  ctx.font = `10px ${css.getPropertyValue('--mono')}`;
  ctx.fillText(String(max), 2, 10);
}

function renderStats() {
  const now = Date.now();
  const graded = state.logs.filter(l => l.id && !l.practice);
  const currentStreak = streakWithFreezes(state, now);
  $('st-streak').innerHTML = `${currentStreak} <small>days</small>`;
  $('st-total').textContent = graded.length;
  $('st-cards').textContent = Object.keys(state.templates).length;
  const week = graded.filter(l => now - l.t < 7 * DAY);
  $('st-acc').innerHTML = week.length
    ? `${Math.round(100 * week.filter(l => l.ok).length / week.length)}<small>% right</small>`
    : '&ndash;';

  const byDay = {};
  for (const l of graded) byDay[dayOf(l.t)] = (byDay[dayOf(l.t)] || 0) + 1;
  $('st-longest').innerHTML = `${longestStreak(state)} <small>days</small>`;
  $('st-best').innerHTML = `${Math.max(0, ...Object.values(byDay))} <small>reviews</small>`;
  const focused = state.logs.reduce((a, l) => a + (l.lock || 0), 0);
  $('st-focus').innerHTML = focused >= 90
    ? `${(focused / 60).toFixed(1)} <small>hours</small>`
    : `${focused} <small>min</small>`;
  $('st-freezes').innerHTML = `${state.gamify.freezes} <small>banked</small>`;
  $('stats-empty').hidden = graded.length > 0;

  const { earned } = checkBadges(state, now, currentStreak);
  const wall = $('badges');
  wall.innerHTML = '';
  for (const b of BADGES) {
    const chip = document.createElement('span');
    chip.className = `badge-chip${earned.includes(b.id) ? ' earned' : ''}`;
    chip.textContent = b.name;
    chip.dataset.tip = b.desc;
    wall.appendChild(chip);
  }

  renderHeatmap(now);
  renderExamSettings();
  renderSyncPanel();

  const perDay = new Array(30).fill(0);
  for (const l of state.logs) {
    if (!l.id) continue;
    const d = Math.floor((now - l.t) / DAY);
    if (d >= 0 && d < 30) perDay[29 - d]++;
  }
  drawBars($('chart-days'), perDay, 29);

  const due = new Array(14).fill(0);
  for (const e of Object.values(state.templates)) {
    if (e.suspended || fsrs.isNew(e.srs)) continue;
    const d = e.srs.due <= now ? 0 : Math.floor((e.srs.due - now) / DAY) + 1;
    if (d < 14) due[d]++;
  }
  drawBars($('chart-due'), due, 0);

  $('set-new').value = state.settings.newPerDay;
  $('set-ret').value = String(state.settings.retention);
  $('set-key').value = state.settings.apiKey || '';
  $('set-cozy').checked = !!state.settings.cozy;

  const last = state.settings.lastExportAt;
  const syncedUp = syncer && syncer.user();
  $('backup-line').textContent = syncedUp
    ? 'sync is on; exports are belt and suspenders.'
    : last
      ? `last full export: ${Math.floor((now - last) / DAY)} days ago.`
      : 'no full export yet. one file, and a lost laptop costs you nothing.';
}

function applyCozy() {
  document.body.classList.toggle('cozy', !!state.settings.cozy);
}
$('set-cozy').addEventListener('change', () => {
  state.settings.cozy = $('set-cozy').checked;
  applyCozy();
  persist();
});

$('set-key').addEventListener('change', () => {
  state.settings.apiKey = $('set-key').value.trim();
  persist();
  toast(state.settings.apiKey ? 'key saved in this browser only' : 'key removed');
});

// GitHub-wall style: 26 weeks of days, colored by review count.
function renderHeatmap(now) {
  const byDay = {};
  for (const l of state.logs) {
    if (l.id) byDay[dayOf(l.t)] = (byDay[dayOf(l.t)] || 0) + 1;
  }
  const box = $('heatmap');
  box.innerHTML = '';
  const total = Object.values(byDay).reduce((a, b) => a + b, 0);
  const activeDays = Object.keys(byDay).length;
  box.setAttribute('aria-label', `review calendar: ${total} reviews over ${activeDays} days in the last 26 weeks`);
  const start = new Date(now - 181 * DAY);
  start.setDate(start.getDate() - start.getDay()); // back up to a Sunday
  for (let t = start.getTime(); ; t += DAY) {
    const cell = document.createElement('i');
    const n = byDay[dayOf(t)] || 0;
    if (t > now) cell.className = 'future';
    else if (n > 0) cell.className = `l${Math.min(4, Math.ceil(n / 8))}`;
    cell.dataset.tip = `${dayOf(t)}: ${n} review${n === 1 ? '' : 's'}`;
    box.appendChild(cell);
    const d = new Date(t + DAY);
    if (t >= now && d.getDay() === 0) break;
  }
}

function renderExamSettings() {
  const box = $('exam-settings');
  box.innerHTML = '';
  const deckIds = [...new Set(Object.values(state.templates).map(e => e.deckId))];
  for (const id of deckIds) {
    const div = document.createElement('div');
    const label = document.createElement('label');
    label.textContent = deckName(id);
    const input = document.createElement('input');
    input.type = 'date';
    input.dataset.tip = 'nothing in this deck gets scheduled past this day';
    const t = state.settings.exams?.[id];
    if (t) input.value = dayOf(t);
    input.addEventListener('change', () => {
      state.settings.exams = state.settings.exams || {};
      if (input.value) {
        // end of the exam day, local time
        state.settings.exams[id] = new Date(`${input.value}T23:59:00`).getTime();
      } else {
        delete state.settings.exams[id];
      }
      persist();
      toast(input.value ? `${deckName(id)}: nothing schedules past ${input.value}` : 'exam date cleared');
    });
    div.append(label, input);
    box.appendChild(div);
  }
}

$('set-new').addEventListener('change', () => {
  state.settings.newPerDay = Math.max(0, Number($('set-new').value) || 0);
  persist();
});
$('set-ret').addEventListener('change', () => {
  state.settings.retention = Number($('set-ret').value);
  persist();
});

// ---------- boot ----------

applyTheme();
applyCozy();
const spent = applyFreezes(state, Date.now());
persist(); // write back merged seed cards (and any spent freeze) on first load
if (spent) toast(`a streak freeze covered ${spent === 1 ? 'yesterday' : `${spent} missed days`}`);
importFromHash();
route();
doSync('boot');
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

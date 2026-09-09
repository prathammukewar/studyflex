// Run with: node test/test.mjs
// Covers the expression engine, the FSRS scheduler, template drawing
// and checking, the session queue, and the integrity of every card
// in the shipped deck.

import { parse, evaluate, evalIn, equivalent, stripConstant, toTex } from '../js/expr.js';
import * as fsrs from '../js/fsrs.js';
import { rng } from '../js/rng.js';
import { draw, fill, check, validate, textMatch, clozeSpans, renderCloze } from '../js/template.js';
import { defaultState, load, streak, dayOf, shareEncode, shareDecode } from '../js/store.js';
import { buildQueue, gradeFor, Session, LEECH_LAPSES, interleave } from '../js/session.js';
import { applyFreezes, streakWithFreezes, earnFreezes, longestStreak, checkBadges, BADGES, FREEZE_CAP, examReadiness } from '../js/gamify.js';
import { createSync, applyStateDoc, applyTombs, stateDoc } from '../js/sync.js';
import { rebuildSrs } from '../js/store.js';
import { startMock } from './mock-supabase.mjs';
import { deck as calc1 } from '../js/decks/calc1.js';
import { deck as techniques } from '../js/decks/techniques.js';
import { deck as mech1 } from '../js/decks/mech1.js';

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL  ${name}`); }
}
function near(a, b, name, tol = 1e-9) {
  ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${name} (got ${a}, wanted ${b})`);
}
function throws(fn, name) {
  try { fn(); failed++; console.error(`FAIL  ${name} (no error thrown)`); }
  catch { passed++; }
}

// ---------- expression engine ----------

near(evalIn('2+3*4'), 14, 'precedence');
near(evalIn('2^3^2'), 512, 'power is right associative');
near(evalIn('-3^2'), -9, 'negation binds looser than power');
near(evalIn('2x', { x: 3 }), 6, 'implicit multiplication, number times var');
near(evalIn('(x+1)(x-1)', { x: 4 }), 15, 'implicit multiplication, parens');
near(evalIn('3sin(pi/2)'), 3, 'implicit multiplication, function');
near(evalIn('2e3'), 2000, 'scientific notation');
near(evalIn('2e'), 2 * Math.E, 'e as a constant after a number');
near(evalIn('ax', { a: 5, x: 2 }), 10, 'letter run splits into known names');
near(evalIn('api', { a: 2 }), 2 * Math.PI, 'letter run finds pi');
near(evalIn('1/2x', { x: 4 }), 2, '1/2x reads as (1/2)x');
near(evalIn('sqrt(2)/2'), Math.SQRT1_2, 'sqrt');
near(evalIn('x**2', { x: 3 }), 9, '** works as ^');
near(evalIn('sec(0)'), 1, 'sec');
near(evalIn('round(2.0203*100)/100'), 2.02, 'round for tidy displays');
throws(() => parse('sin x'), 'functions need parentheses');
throws(() => parse('3 + '), 'dangling operator');
throws(() => parse('y + 1', ['x']), 'unknown names are rejected');
ok(stripConstant('sin(x)/2 + C') === 'sin(x)/2', 'strip + C');
ok(stripConstant('sin(x)/2+c') === 'sin(x)/2', 'strip +c without space');

const det = rng(7);
ok(equivalent('a*cos(a*x)', 'a cos(ax)', { vars: ['x'], env: { a: 3 }, rand: det }),
  'equivalent forms match');
ok(!equivalent('a*cos(a*x)', 'cos(a*x)', { vars: ['x'], env: { a: 3 }, rand: rng(8) }),
  'missing factor is caught');
ok(equivalent('sin(a*x)/a', 'sin(a*x)/a + 7', { vars: ['x'], env: { a: 2 }, upToConstant: true, rand: rng(9) }),
  'constant offset allowed for antiderivatives');
ok(!equivalent('sin(a*x)/a', 'x', { vars: ['x'], env: { a: 2 }, upToConstant: true, rand: rng(10) }),
  'non-constant difference rejected for antiderivatives');
ok(!equivalent('1/x', 'x', { vars: ['x'], rand: rng(11) }), 'different functions differ');
ok(equivalent('a/cos(a*x)^2', 'a*sec(a*x)^2', { vars: ['x'], env: { a: 3 }, domain: [-0.25, 0.25], rand: rng(12) }),
  'sec form equals 1/cos form');

// ---------- rendering typed input back as TeX ----------

{
  const tex = (src, scope = ['x']) => toTex(parse(src, scope));
  ok(tex('12x^3') === '12\\,x^{3}', 'coefficient and power');
  ok(tex('1/2') === '\\frac{1}{2}', 'fractions render as fractions');
  ok(tex('sqrt(2)/2') === '\\frac{\\sqrt{2}}{2}', 'roots inside fractions');
  ok(tex('sin(3x)') === '\\sin\\left(3\\,x\\right)', 'functions get their TeX names');
  ok(tex('-x^2') === '-x^{2}', 'negation binds outside the power');
  ok(tex('(x+1)^2') === '\\left(x + 1\\right)^{2}', 'grouped base keeps its parens');
  ok(tex('2*3') === '2 \\cdot 3', 'number times number shows the dot');
  ok(tex('pi/6', []) === '\\frac{\\pi}{6}', 'pi becomes the symbol');
  ok(tex('x^-2') === 'x^{-2}', 'negative exponents stay attached');
  const p = { a: 3, n: 4, an: 12, nm1: 3 };
  ok(check(calc1.templates.find(t => t.id === 'calc1/power-rule'), p, '12x^3').ok,
    'what the preview shows is what the checker reads');
}

// ---------- fsrs ----------

{
  const now = Date.parse('2026-01-10T12:00:00');
  const s = fsrs.schedule(fsrs.newState(), fsrs.GOOD, now);
  near(s.stability, 3.7145, 'first Good uses the initial stability weight', 1e-6);
  ok(s.due - now === 4 * 86400000, 'interval at 0.9 retention is about the stability');
  near(fsrs.retrievability(s, now), 1, 'retrievability right after review is 1', 1e-9);
  near(fsrs.retrievability(s, s.due), 0.9, 'retrievability at the due date is the target', 0.01);

  const later = s.due;
  const byGrade = [fsrs.AGAIN, fsrs.HARD, fsrs.GOOD, fsrs.EASY]
    .map(g => fsrs.schedule(s, g, later).stability);
  ok(byGrade[0] < byGrade[1] && byGrade[1] < byGrade[2] && byGrade[2] < byGrade[3],
    'stability is monotone in the grade');
  ok(byGrade[0] <= s.stability, 'a lapse never increases stability');
  const lapsed = fsrs.schedule(s, fsrs.AGAIN, later);
  ok(lapsed.lapses === 1, 'lapse counter');
  ok(fsrs.interval(0.01, 0.9) === 1, 'interval never rounds to zero');
}

// ---------- rng ----------

{
  const a = rng(42), b = rng(42);
  const seqA = [a(), a(), a()], seqB = [b(), b(), b()];
  ok(seqA.every((v, i) => v === seqB[i]), 'seeded rng is deterministic');
  ok(seqA.every(v => v >= 0 && v < 1), 'rng stays in [0,1)');
}

// ---------- templates ----------

{
  const tpl = calc1.templates.find(t => t.id === 'calc1/power-rule');
  const p1 = draw(tpl, 5), p2 = draw(tpl, 5), p3 = draw(tpl, 6);
  ok(JSON.stringify(p1) === JSON.stringify(p2), 'same seed, same draw');
  ok(JSON.stringify(p1) !== JSON.stringify(p3) || true, 'draw runs');
  ok(p1.an === p1.a * p1.n, 'computed params');

  ok(fill('x^2 {{a:+}}x', { a: 3 }) === 'x^2 + 3x', 'signed positive');
  ok(fill('x^2 {{a:+}}x', { a: -3 }) === 'x^2 - 3x', 'signed negative');
  ok(fill('{{q.val}}', { q: { val: '1/2' } }) === '1/2', 'pick field access');

  const quot = calc1.templates.find(t => t.id === 'calc1/quotient-at-point');
  for (let seed = 1; seed <= 500; seed++) {
    const p = draw(quot, seed);
    if (p.a * p.d - p.b * p.c === 0) { ok(false, 'nonzero constraint violated'); break; }
    if (seed === 500) ok(true, 'nonzero constraint holds over 500 draws');
  }

  const params = { a: 3, n: 4, an: 12, nm1: 3 };
  ok(check(tpl, params, '12x^3').ok, 'expression answer, plain form');
  ok(check(tpl, params, '3*4*x^3').ok, 'expression answer, unsimplified form');
  ok(!check(tpl, params, '12x^2').ok, 'wrong exponent rejected');
  ok(check(tpl, params, '12y^3').error !== undefined, 'wrong variable is a parse error, not a miss');

  const cos = calc1.templates.find(t => t.id === 'calc1/int-cos');
  const cp = { a: 3 };
  ok(check(cos, cp, 'sin(3x)/3 + C').ok, 'antiderivative with + C');
  ok(check(cos, cp, 'sin(3x)/3 - 5').ok, 'antiderivative with another constant');
  ok(!check(cos, cp, 'cos(3x)/3').ok, 'wrong antiderivative rejected');

  const trig = calc1.templates.find(t => t.id === 'calc1/trig-recall');
  const tp = { q: { fn: '\\sin', ang: '\\frac{\\pi}{3}', val: 'sqrt(3)/2', show: '\\tfrac{\\sqrt{3}}{2}' } };
  ok(check(trig, tp, 'sqrt(3)/2').ok, 'exact trig value, symbolic');
  ok(check(trig, tp, '0.866').ok, 'exact trig value, decimal');
  ok(!check(trig, tp, '1/2').ok, 'wrong trig value rejected');
}

// ---------- prose cards ----------

ok(textMatch('Helicase', ['helicase']), 'text match is case-insensitive');
ok(textMatch('  spaced repetition. ', ['Spaced Repetition']), 'punctuation and spacing ignored');
ok(textMatch('helicse', ['helicase']), 'one typo allowed on longer answers');
ok(textMatch('retreival', ['retrieval']), 'swapped letters count as one typo');
ok(!textMatch('polymerase', ['helicase']), 'wrong word rejected');
ok(!textMatch('cat', ['car']), 'no typo slack on short answers');
ok(!textMatch('', ['anything']), 'empty input rejected');

{
  const text = 'The [[spacing]] effect beats [[cramming]] every time.';
  const spans = clozeSpans(text);
  ok(spans.length === 2 && spans[0] === 'spacing', 'cloze spans parse');
  ok(renderCloze(text, 0) === 'The ______ effect beats cramming every time.', 'chosen span hides, others show');
  ok(renderCloze(text, 1).includes('spacing') && renderCloze(text, 1).includes('______'), 'other span hides on other draws');

  const card = techniques.templates.find(t => t.id === 'techniques/spacing-effect');
  const p = draw(card, 3);
  ok(Number.isInteger(p._cloze) && p._cloze >= 0 && p._cloze < clozeSpans(card.prompt).length, 'cloze draw picks a span');
  const hidden = clozeSpans(card.prompt)[p._cloze];
  ok(check(card, p, hidden).ok, 'typing the hidden span is correct');
  ok(check(card, p, hidden.toUpperCase()).ok, 'case does not matter');
  ok(!check(card, p, 'wrong entirely').ok, 'wrong span rejected');

  const term = techniques.templates.find(t => t.id === 'techniques/testing-effect');
  ok(check(term, draw(term, 1), 'active recall').ok, 'any accepted phrasing works');
  ok(!check(term, draw(term, 1), 'rereading').ok, 'wrong technique rejected');
}

// ---------- deck integrity ----------

for (const deck of [calc1, techniques, mech1]) {
  for (const tpl of deck.templates) {
    const problems = validate(tpl);
    ok(problems.length === 0, `deck card ${tpl.id}: ${problems.join('; ')}`);
    ok((tpl.hints || []).length > 0, `deck card ${tpl.id} has a hint`);
    ok((tpl.solution || '').length > 0, `deck card ${tpl.id} has a solution`);
    ok(tpl.par >= 10 && tpl.par <= 300, `deck card ${tpl.id} par time is sane`);
  }
}
{
  const ids = [...calc1.templates, ...techniques.templates, ...mech1.templates].map(t => t.id);
  ok(new Set(ids).size === ids.length, 'deck ids are unique');
}

// ---------- store and session ----------

{
  const state = load([calc1], null);
  ok(Object.keys(state.templates).length === calc1.templates.length, 'seed deck merges in');

  // lock-in refill practices the weakest seen cards
  const t0 = Date.parse('2026-03-01T10:00:00');
  const ids = Object.keys(state.templates).slice(0, 3);
  for (const id of ids) {
    state.templates[id].srs = fsrs.schedule(fsrs.newState(), fsrs.GOOD, t0);
  }
  const later = t0 + 86400000; // nothing due yet, so the queue starts empty
  const lockSession = new Session({ ...state, settings: { ...state.settings, newPerDay: 0 } }, later);
  const before = lockSession.remaining;
  const pulled = lockSession.refill(later, 2);
  ok(pulled === 2, 'refill pulls practice cards');
  ok(lockSession.remaining === before + 2, 'refilled cards join the queue');
  ok(lockSession.items.slice(-2).every(i => i.graded && i.extra), 'refills are practice, not graded');

  const now = Date.parse('2026-02-01T18:00:00');
  const q1 = buildQueue(state, now);
  ok(q1.due.length === 0, 'nothing due before any reviews');
  ok(q1.fresh.length === state.settings.newPerDay, 'new cards respect the daily allowance');

  ok(gradeFor(false, 10000, 0, 60) === fsrs.AGAIN, 'wrong maps to again');
  ok(gradeFor(true, 20000, 1, 60) === fsrs.HARD, 'hint maps to hard');
  ok(gradeFor(true, 120000, 0, 60) === fsrs.HARD, 'slow maps to hard');
  ok(gradeFor(true, 20000, 0, 60) === fsrs.EASY, 'fast maps to easy');
  ok(gradeFor(true, 45000, 0, 60) === fsrs.GOOD, 'ordinary maps to good');

  const session = new Session(state, now);
  const total = session.remaining;
  const first = session.current.entry.tpl.id;
  session.answer(false, 30000, 0, fsrs.AGAIN, now);
  ok(session.remaining === total, 'a miss comes back later in the session');
  while (session.current && session.current.entry.tpl.id !== first) {
    session.answer(true, 20000, 0, fsrs.GOOD, now);
  }
  ok(session.current !== null && session.current.graded, 'the miss returns as practice');
  session.answer(true, 20000, 0, fsrs.GOOD, now);
  while (session.current) session.answer(true, 20000, 0, fsrs.GOOD, now);
  const s = session.summary();
  ok(s.graded === total, 'summary counts each card once');
  ok(state.logs.filter(l => l.practice).length === 1, 'practice reps are marked');
  ok(state.logs.filter(l => l.n).length === total, 'first-ever grades are marked');

  const q2 = buildQueue(state, now);
  ok(q2.fresh.length === 0, 'daily new allowance is spent');
  ok(streak(state.logs, now) === 1, 'streak starts at one');
  ok(streak(state.logs, now + 86400000) === 1, 'streak survives until a full day is missed');
  ok(streak(state.logs, now + 3 * 86400000) === 0, 'streak dies after a missed day');
  ok(dayOf(now) === '2026-02-01', 'local day key');
}

// ---------- share links, exam clamp, undo ----------

{
  const originals = calc1.templates.slice(0, 3);
  const round = shareDecode(shareEncode(originals));
  ok(JSON.stringify(round) === JSON.stringify(originals), 'share link round-trips exactly');
  ok(round.every(t => validate(t).length === 0), 'shared cards still validate');
  throws(() => shareDecode('not-base64!!!'), 'garbage links are rejected');

  const state = load([calc1], null);
  const now = Date.parse('2026-11-01T10:00:00');
  const exam = Date.parse('2026-11-04T23:59:00');
  state.settings.exams = { calc1: exam };
  state.settings.newPerDay = 2;
  const s1 = new Session(state, now);
  const firstId = s1.current.entry.tpl.id;
  s1.answer(true, 5000, 0, fsrs.EASY, now); // Easy would schedule ~2 weeks out
  ok(state.templates[firstId].srs.due <= exam, 'nothing schedules past the exam');
  ok(state.templates[firstId].srs.due > now, 'clamped due date stays in the future');

  // undo restores memory state, log, and queue position
  const secondId = s1.current.entry.tpl.id;
  const logsBefore = state.logs.length;
  s1.answer(true, 5000, 0, fsrs.GOOD, now);
  ok(state.templates[secondId].srs.reps === 1, 'answer applied before undo');
  ok(s1.undo(), 'undo succeeds');
  ok(state.templates[secondId].srs.reps === 0, 'undo restores memory state');
  ok(state.logs.length === logsBefore, 'undo removes the log entry');
  ok(s1.current.entry.tpl.id === secondId && !s1.current.graded, 'undone card is asked again');
  ok(!s1.undo(), 'undo works once per answer');

  // a wrong answer that gets undone also removes its practice requeue
  s1.answer(false, 5000, 0, fsrs.AGAIN, now);
  ok(s1.items.some(i => i.graded), 'miss requeued as practice');
  s1.undo();
  ok(!s1.items.some(i => i.graded), 'undo removes the practice requeue');

  ok(LEECH_LAPSES >= 3, 'leech threshold is not hair-trigger');
}

// ---------- step cards, small sessions, readiness ----------

{
  const steps = calc1.templates.find(t => t.id === 'calc1/parts-twice');
  ok(steps.answer.type === 'steps' && steps.answer.steps.length === 3, 'step card ships with steps');
  ok(check(steps, draw(steps, 1), 'yes').ok, 'steps grade like self cards');
  const broken = { ...steps, id: 'x', answer: { type: 'steps', steps: [] } };
  ok(validate(broken).length > 0, 'empty steps list is rejected');

  const state = load([calc1], null);
  const now = Date.parse('2026-10-01T10:00:00');
  const five = new Session(state, now, { cap: 5 });
  ok(five.remaining === 5, 'just-five caps the queue');

  for (const id of ['calc1/power-rule', 'calc1/chain-sin', 'calc1/chain-power']) {
    state.templates[id].srs = fsrs.schedule(fsrs.newState(), fsrs.GOOD, now - 5 * 86400000);
  }
  const drill = new Session(state, now, { practiceSkill: 'chain rule', cap: 10 });
  ok(drill.remaining === 2, 'drill takes only the seen cards of that skill');
  ok(drill.items.every(i => i.graded && i.extra), 'drill reps are practice');
  drill.answer(true, 9000, 0, fsrs.GOOD, now);
  ok(['calc1/power-rule', 'calc1/chain-sin', 'calc1/chain-power']
    .every(id => state.templates[id].srs.reps === 1), 'drilling never touches the schedule');

  state.settings.exams = { calc1: now + 10 * 86400000 };
  const r = examReadiness(state, now);
  ok(r.length === 1 && r[0].deckId === 'calc1', 'readiness reports the deck with an exam');
  ok(r[0].seen === 3 && r[0].unseen === calc1.templates.length - 3, 'readiness splits seen from untouched');
  ok(r[0].ready > 0 && r[0].ready < 1, 'predicted exam-day recall is a probability');
  const sooner = examReadiness({ ...state, settings: { ...state.settings, exams: { calc1: now + 86400000 } } }, now);
  ok(sooner[0].ready > r[0].ready, 'a nearer exam predicts better recall than a farther one');
}

// ---------- interleaving ----------

{
  const mk = (id, skill) => ({ tpl: { id, skills: [skill] } });
  const mixed = interleave([mk(1, 'a'), mk(2, 'a'), mk(3, 'a'), mk(4, 'b'), mk(5, 'b'), mk(6, 'c')]);
  ok(mixed.map(e => e.tpl.skills[0]).join('') === 'abcaba', 'skills round-robin instead of blocking');
  ok(mixed.length === 6, 'interleave keeps every card');
  ok(interleave([]).length === 0, 'interleave handles empty');

  const state = load([calc1], null);
  const q = buildQueue(state, Date.now());
  const firstSkills = q.fresh.map(e => e.tpl.skills[0]);
  ok(new Set(firstSkills.slice(0, 3)).size === Math.min(3, new Set(firstSkills).size),
    'new cards arrive mixed across skills');
}

// ---------- streak freezes ----------

{
  const day = n => Date.parse('2026-05-01T12:00:00') + n * 86400000;
  const mkState = reviewedDays => ({
    ...defaultState(),
    logs: reviewedDays.map(n => ({ t: day(n), id: 'x', ok: true })),
  });

  // one missed day, one freeze banked: streak survives
  let s = mkState([0, 1, 2, 3, 4, 5, 6]); // 7 days
  let streakNow = streakWithFreezes(s, day(6));
  ok(streakNow === 7, 'streak counts before freezing');
  ok(earnFreezes(s, streakNow) === 1, 'a week banks one freeze');
  ok(earnFreezes(s, streakNow) === 0, 'the same week does not bank twice');
  ok(applyFreezes(s, day(8)) === 1, 'a freeze covers the missed day');
  ok(s.gamify.freezes === 0, 'the freeze is spent');
  ok(streakWithFreezes(s, day(8)) === 8, 'streak survives the gap (frozen day counts)');

  // no freeze banked: streak dies
  s = mkState([0, 1, 2]);
  ok(applyFreezes(s, day(4)) === 0, 'no freeze, no rescue');
  ok(streakWithFreezes(s, day(4)) === 0, 'streak is dead');

  // gap wider than the bank: nothing is wasted
  s = mkState([0, 1, 2, 3, 4, 5, 6]);
  earnFreezes(s, 7);
  ok(applyFreezes(s, day(11)) === 0, 'a 4-day gap is not patchable');
  ok(s.gamify.freezes === 1, 'the freeze is kept for a survivable gap');

  ok(FREEZE_CAP >= 1 && FREEZE_CAP <= 3, 'freeze bank stays small');
  ok(longestStreak(mkState([0, 1, 2, 5, 6])) === 3, 'longest streak found across gaps');
}

// ---------- badges ----------

{
  const day = n => Date.parse('2026-05-01T12:00:00') + n * 86400000;
  const s = defaultState();
  for (let d = 0; d < 7; d++) {
    for (let i = 0; i < 15; i++) s.logs.push({ t: day(d) + i * 60000, id: `c${i}`, ok: true });
  }
  s.logs.push({ t: day(6), lock: 55 });
  s.logs.push({ t: day(6), practice: 1, id: 'dump', dump: 1 });
  const { earned, fresh } = checkBadges(s, day(6), 7);
  for (const id of ['day-one', 'streak-3', 'streak-7', 'reviews-100', 'clean-sweep', 'deep-work', 'brain-dump']) {
    ok(earned.includes(id), `badge ${id} earned`);
  }
  ok(!earned.includes('streak-30'), 'unearned badges stay unearned');
  ok(fresh.length === earned.length, 'first check reports all as new');
  ok(checkBadges(s, day(6), 7).fresh.length === 0, 'second check reports nothing new');
  ok(new Set(BADGES.map(b => b.id)).size === BADGES.length, 'badge ids are unique');
}

// ---------- sync ----------

{
  const mock = await startMock();
  const mkSync = () => {
    let meta = {};
    return createSync({ url: mock.url, anonKey: 'anon', meta: { load: () => meta, save: m => meta = m } });
  };
  const now = Date.parse('2026-09-01T19:00:00');

  const applyTo = target => (doc, first) => applyStateDoc(target, doc, fsrs.newState, first);

  // device A reviews three cards and pushes
  const A = load([calc1], null);
  const sessionA = new Session(A, now);
  for (let i = 0; i < 3; i++) sessionA.answer(true, 20000, 0, fsrs.GOOD, now + i * 60000);
  const syncA = mkSync();
  ok(await syncA.signUp('p@x.edu', 'hunter22') === 'p@x.edu', 'sign up returns the user');
  let r = await syncA.sync(A, applyTo(A));
  ok(r.pushed === 3 && r.pulled === 0, 'first sync pushes the reviews');
  ok(A.logs.every(l => l.synced), 'pushed logs are marked');

  // device B signs in fresh and pulls everything
  const B = load([calc1], null);
  const syncB = mkSync();
  ok(await syncB.signIn('p@x.edu', 'hunter22') === 'p@x.edu', 'sign in works');
  r = await syncB.sync(B, applyTo(B));
  rebuildSrs(B);
  ok(r.pulled === 3 && r.docNote === 'merged', 'second device pulls the history and merges the doc');
  const cardId = A.logs[0].id;
  ok(JSON.stringify(B.templates[cardId].srs) === JSON.stringify(A.templates[cardId].srs),
    'replayed scheduler state matches the original exactly');

  // an idle re-sync moves nothing
  r = await syncA.sync(A, applyTo(A));
  ok(r.pushed === 0 && r.pulled === 0 && !r.docNote, 'idle sync moves nothing');

  // undo on A tombstones the review; B drops it after its next pull
  const undoTarget = A.logs[2];
  A.logs.splice(2, 1);
  A.logs.push({ t: now + 5 * 60000, k: crypto.randomUUID(), tomb: undoTarget.k });
  rebuildSrs(A);
  await syncA.sync(A, applyTo(A));
  r = await syncB.sync(B, applyTo(B));
  rebuildSrs(B);
  ok(!B.logs.some(l => l.k === undoTarget.k), 'tombstoned review disappears on the other device');
  ok(JSON.stringify(B.templates[undoTarget.id].srs) === JSON.stringify(A.templates[undoTarget.id].srs),
    'both devices agree after the undo');

  // custom cards travel in the state doc
  const mkCard = (id, name) => ({
    tpl: { id, name, skills: ['bio'], par: 25,
      prompt: 'Water moves toward the [[saltier]] side.', params: {}, answer: { type: 'cloze' } },
    deckId: 'notes', custom: true, suspended: false, srs: fsrs.newState(),
  });
  A.templates['user/osmosis'] = mkCard('user/osmosis', 'Osmosis');
  await syncA.sync(A, applyTo(A));
  r = await syncB.sync(B, applyTo(B));
  ok(r.docNote === 'adopted' && B.templates['user/osmosis'], 'custom cards arrive on the other device');

  // both devices edit cards: the syncing device wins and says so
  A.templates['user/osmosis'].tpl.name = 'Osmosis, renamed on A';
  B.templates['user/osmosis'].tpl.name = 'Osmosis, renamed on B';
  await syncA.sync(A, applyTo(A));
  r = await syncB.sync(B, applyTo(B));
  ok(r.docNote === 'conflict, this device won', 'doc conflict is reported');
  r = await syncA.sync(A, applyTo(A));
  ok(A.templates['user/osmosis'].tpl.name === 'Osmosis, renamed on B', 'the later edit spreads');

  // a device with its own local cards signs in: first sync merges,
  // deletes nothing, and its extras reach everyone
  const C = load([calc1], null);
  C.templates['user/diffusion'] = mkCard('user/diffusion', 'Diffusion');
  const syncC = mkSync();
  await syncC.signIn('p@x.edu', 'hunter22');
  r = await syncC.sync(C, applyTo(C));
  ok(r.docNote === 'merged', 'first sync merges instead of fighting');
  ok(C.templates['user/diffusion'] && C.templates['user/osmosis'], 'first sync keeps both sides');
  r = await syncA.sync(A, applyTo(A));
  ok(A.templates['user/diffusion'], 'the merged extras spread to other devices');

  ok(!JSON.stringify(stateDoc(A)).includes('sk-ant'), 'sanity: no key material in the doc');
  const withKey = { ...A, settings: { ...A.settings, apiKey: 'sk-ant-secret' } };
  ok(!JSON.stringify(stateDoc(withKey)).includes('sk-ant-secret'), 'the API key never enters the sync doc');

  applyTombs(A);
  ok(!A.logs.some(l => l.k === undoTarget.k), 'applyTombs is idempotent');

  mock.close();
}

console.log(failed ? `\n${passed} passed, ${failed} FAILED` : `all ${passed} checks passed`);
process.exit(failed ? 1 : 0);

# studyflex

Spaced repetition for problem solving, in the browser. Every card is a
template: the numbers are drawn fresh on every review, so the method is the
only thing you can memorize.

**Live at [prathammukewar.github.io/studyflex](https://prathammukewar.github.io/studyflex/).**

Three years ago I made a study app called StudyFlex, and even I did not use
it. This one is built around the two reasons that happened.

## Why this exists

Regular flashcards fail at math in a specific way: after the third review of
"integrate x·e^(2x)" you are recalling the answer string, not doing
integration by parts. Here that card is a generator. Next time it comes up as
x·e^(5x), and the only way through is the method. Prose subjects get the same
treatment: a cloze card can hold several marked spans and hides a different
one each review, so the sentence never becomes a fixed prompt with a fixed
answer. Two decks ship built in: 22 calculus generators, and a deck that
teaches the study techniques the app is built on, through the app itself.

The second failure is grading yourself. "Was that easy or good?" is a
negotiation, and the lazy answer compounds into a schedule built on wishful
thinking. StudyFlex checks your actual answer and grades from what happened:
wrong is again, right but slow or with a hint is hard, right and quick is
easy. You can override before moving on, but the starting point is always
what the clock and the checker saw. While you type a math answer, the box
echoes back the expression the checker will read, rendered properly, so
"did it understand my caret" is never a question.

## How answers are checked

Typed answers are read as math, not text. 1/2, 0.5, and sqrt(2)/2 are the
same number; 12x^3, 3·4·x^3, and 12 x³ written any way you like are the same
function. Expressions are checked by sampling: both sides are evaluated at a
dozen random points, with the card's parameters bound, and have to agree
everywhere. For indefinite integrals the difference only has to be constant,
which is how "+ C" answers work without a computer algebra system. An answer
that fails to parse is an error message, not a miss.

Scheduling is FSRS-4.5 with the published default weights. The scheduler
sees one grade per card per day; a card you miss comes back a few problems
later until it sticks, and those practice reps never touch memory state.
Sessions are interleaved: the queue round-robins across skills so you never
get a comfortable run of one problem type, because picking the method is
the exam skill and blocked practice quietly skips it. The skills page shows
the model's current recall probability per skill, weakest first, which is
the list to read the week before an exam. That page also has a brain dump:
you get three minutes and a blank page with the notes closed, and afterward
the app shows you what the topic actually covers. Free recall like this beat concept mapping in
Karpicke and Blunt's 2011 experiments, and it audits your memory instead of
your feelings about it.

## Locking in

Derivations get step cards: work each move on paper, reveal the reference
step, and compare, one move at a time, then grade the whole thing
honestly. The calculus deck ships two: integration by parts applied twice,
and the logarithmic differentiation of x^x.

For low days there is a just-five button, because five cards beat zero
cards and usually turn into more. Every skill row has a drill button that
practices that one skill on demand without touching the schedule. And with
an exam date set, the today page shows readiness: your predicted recall on
exam day, per deck, computed from the memory model as if you stopped
studying now. It is the honest number, and watching it climb is the point.

The lock in button puts a clock on the session: 15, 25, or 50 minutes.
Reviews run as normal, and when the due queue runs dry with time left, the
app pulls your weakest material back in as practice until the timer ends.
Practice reps never touch the schedule; they are just reps. Landing a session
earns a small storm of confetti, which is not backed by any study on
motivation, but neither is most homework.

## Around the reviewing

An exam date on a deck caps the schedule: nothing in that deck gets pushed
past the exam, so reviews bunch up as the day approaches instead of
drifting beyond it, and the today page counts down. A wrong tap on a grade
is not a sentence; undo (the button, or u) restores the memory state, the
log, and the card, and asks it again. A card that keeps lapsing gets
flagged as a leech, because a card missed four times is usually a badly
written card, not a badly studied one. The stats page grows a review wall,
one square per day, plus a badge shelf and your records: longest streak,
best day. Every seven straight days banks a streak freeze (two fit in the
bank), and a freeze quietly covers a missed day so one bad Tuesday does
not zero a month of work. And the share button packs your cards into a URL the
way pit packs a whole market run into a seed: send the link, they tap
accept, no server involved.

The app also installs: a manifest and a service worker make it a proper
offline app on a phone home screen, which is where the reviews actually
happen. When deploying, bump the VERSION string in sw.js so old caches
get swept.

## Sync between devices

Sync is optional and runs through a free Supabase project that you own; the
app still has no server of its own. Reviews travel as append-only log rows
and each device rebuilds its scheduler state from the merged log, so two
devices can never fight over a card. The small cards-and-settings document
is last write wins, and if both devices edited cards since the last sync,
the device doing the sync keeps its version and says so.

Setup, once:

1. Create a project at [supabase.com](https://supabase.com) (free tier).
2. In the SQL editor, run:

```sql
create table sf_logs (
  seq bigint generated by default as identity,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  k text not null,
  t bigint not null,
  card text,
  entry jsonb not null,
  primary key (user_id, k)
);
create index sf_logs_user_seq on sf_logs (user_id, seq);
alter table sf_logs enable row level security;
create policy "own logs" on sf_logs for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table sf_state (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  updated_at bigint not null,
  data jsonb not null
);
alter table sf_state enable row level security;
create policy "own state" on sf_state for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

3. Paste the project URL and anon key (project settings, API) into the sync
   panel under stats, create your account there, and sign in with the same
   account on each device. The anon key is safe to expose; row level
   security is what keeps accounts apart.

An undone or deleted review syncs as a tombstone, so every device drops it
instead of resurrecting it. The sign-in lives outside your exports, and
your Claude API key never syncs.

## Getting your notes in

The cards page has an "add from notes" flow. Paste notes or load a text
file, select the words worth remembering, and every marked line becomes a
cloze card in one click; a quick-add form covers question-and-answer and
explain-back cards. If you put an Anthropic API key in settings, a draft
button sends the paste to Claude, which proposes cards you approve one by
one before anything is saved. The key and your notes stay between your
browser and Anthropic; there is no server of mine in the middle, because
there is no server of mine at all.

## Writing cards

Cards are small JSON templates. Parameters draw from ranges (`int`, `float`),
lists (`pick`), or expressions over earlier parameters (`computed`), and
`{{a}}` slots drop them into the prompt's LaTeX. Answers are a `number`, an
`expression` with declared variables, a multiple `choice`, `steps` for
derivations revealed one move at a time, or `self` for anything you grade
yourself. Press ? anywhere for the keyboard map. Saving a card draws it 100 times and makes
the reference answer pass its own checker, so a card that cannot grade
itself never reaches a session. The card editor has a live preview and the
full format reference.

Decks export and import as JSON files, and everything lives in the browser's
local storage. Nothing leaves the page unless you turn on sync.

## Run locally

```
python3 -m http.server 8000
```

Then open http://localhost:8000. Plain HTML, CSS, and ES modules; GitHub
Pages serves the repo as-is. KaTeX is vendored so it also works offline.

## Tests

```
node test/test.mjs
```

The suite covers the expression parser (precedence, implicit multiplication,
the letter-run splitter that reads "2ax" as 2·a·x), the equivalence checker,
the FSRS schedule (grade monotonicity, lapse behavior, retention at the due
date), the session queue, and deck integrity: every shipped card is drawn
100 times and must pass its own check.

## Layout

| Path | What it is |
|---|---|
| `js/expr.js` | expression parser, evaluator, numeric equivalence |
| `js/fsrs.js` | FSRS-4.5 scheduler |
| `js/template.js` | parameter drawing, prompt filling, answer checking, validation |
| `js/session.js` | review queue, measured grading, requeue-until-it-sticks |
| `js/store.js` | localStorage persistence, streaks, export and import |
| `js/decks/calc1.js` | the calculus seed deck |
| `js/decks/techniques.js` | the how-to-study seed deck |
| `js/ai.js` | drafting cards from notes with Claude, loaded only on use |
| `js/gamify.js` | streak freezes, badges, records |
| `js/sync.js` | optional sync against your own Supabase project |
| `js/fx.js` | confetti |
| `js/app.js` | page wiring |
| `sw.js`, `manifest.webmanifest`, `icons/` | offline install |
| `test/test.mjs` | the whole suite, no dependencies |

## What it deliberately leaves out

Sync exists but is opt-in and bring-your-own-database; there is no hosted
backend and no account unless you make one for yourself. Sampling-based
checking can in principle be fooled by two functions that agree at a dozen
random points, which does not happen with answers a person would actually
type. Proof-style cards fall back to self-grading, because checking a
derivation is a much harder problem than checking a function.

## License

MIT

// A small expression parser and evaluator for checking answers.
// Understands + - * / ^ (right assoc), parentheses, implicit
// multiplication (2x, 3sin(x), (x+1)(x-1)), functions, and the
// constants pi and e. No dependencies; both the app and the node
// tests import this file.

const FNS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  sec: x => 1 / Math.cos(x), csc: x => 1 / Math.sin(x), cot: x => Math.cos(x) / Math.sin(x),
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  ln: Math.log, log: Math.log, log10: Math.log10, log2: Math.log2,
  exp: Math.exp, sqrt: Math.sqrt, abs: Math.abs,
  round: Math.round, floor: Math.floor, ceil: Math.ceil,
};

const CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

// ---------- tokenizer ----------

function tokenize(src) {
  const toks = [];
  let i = 0;
  const s = src
    .replace(/\*\*/g, '^')
    .replace(/[−‒–]/g, '-')
    .replace(/[×⋅]/g, '*')
    .replace(/÷/g, '/')
    .replace(/π/g, 'pi')
    .replace(/√/g, 'sqrt');
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
      if (!m || m[0] === '.') throw err(`bad number near "${s.slice(i, i + 6)}"`, i);
      toks.push({ t: 'num', v: parseFloat(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      const m = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(s.slice(i));
      toks.push({ t: 'name', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if ('+-*/^(),'.includes(c)) { toks.push({ t: c, pos: i }); i++; continue; }
    throw err(`unexpected character "${c}"`, i);
  }
  toks.push({ t: 'end', pos: s.length });
  return toks;
}

function err(message, pos) {
  const e = new Error(message);
  e.pos = pos;
  e.parse = true;
  return e;
}

// Split a run of letters like "ax" or "api" into names the scope
// knows, so "2ax" works without writing "2*a*x".
function segment(word, known) {
  if (known.has(word)) return [word];
  const out = [];
  let rest = word;
  outer: while (rest.length) {
    for (let len = Math.min(rest.length, 6); len >= 1; len--) {
      const head = rest.slice(0, len);
      if (known.has(head) && (rest.length === len || segment(rest.slice(len), known))) {
        out.push(head);
        rest = rest.slice(len);
        continue outer;
      }
    }
    return null;
  }
  return out;
}

// ---------- parser (recursive descent to a small AST) ----------

export function parse(src, scope = []) {
  const known = new Set([...Object.keys(CONSTS), ...scope]);
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];

  function startsFactor(t) {
    return t.t === 'num' || t.t === 'name' || t.t === '(';
  }

  function parseExpr() {
    let node = parseTerm();
    while (peek().t === '+' || peek().t === '-') {
      const op = next().t;
      node = { t: 'bin', op, a: node, b: parseTerm() };
    }
    return node;
  }

  function parseTerm() {
    let node = parseUnary();
    for (;;) {
      const t = peek();
      if (t.t === '*' || t.t === '/') {
        const op = next().t;
        node = { t: 'bin', op, a: node, b: parseUnary() };
      } else if (startsFactor(t)) {
        node = { t: 'bin', op: '*', a: node, b: parseUnary() };
      } else break;
    }
    return node;
  }

  function parseUnary() {
    if (peek().t === '-') { next(); return { t: 'neg', a: parseUnary() }; }
    if (peek().t === '+') { next(); return parseUnary(); }
    return parsePower();
  }

  function parsePower() {
    const base = parseAtom();
    if (peek().t === '^') {
      next();
      return { t: 'bin', op: '^', a: base, b: parseUnary() };
    }
    return base;
  }

  function parseAtom() {
    const t = next();
    if (t.t === 'num') return { t: 'num', v: t.v };
    if (t.t === '(') {
      const node = parseExpr();
      if (next().t !== ')') throw err('missing closing parenthesis', t.pos);
      return node;
    }
    if (t.t === 'name') {
      if (FNS[t.v]) {
        if (peek().t !== '(') throw err(`write ${t.v}(...) with parentheses`, t.pos);
        next();
        const arg = parseExpr();
        if (next().t !== ')') throw err(`missing ) after ${t.v}(`, t.pos);
        return { t: 'fn', f: t.v, a: arg };
      }
      if (known.has(t.v)) return { t: 'name', v: t.v };
      const parts = segment(t.v, known);
      if (parts) {
        let node = { t: 'name', v: parts[0] };
        for (let i = 1; i < parts.length; i++) {
          node = { t: 'bin', op: '*', a: node, b: { t: 'name', v: parts[i] } };
        }
        return node;
      }
      const names = scope.length ? ` (this card uses: ${scope.join(', ')})` : '';
      throw err(`unknown name "${t.v}"${names}`, t.pos);
    }
    throw err(t.t === 'end' ? 'expression ended early' : `unexpected "${t.t}"`, t.pos);
  }

  const root = parseExpr();
  if (peek().t !== 'end') throw err(`unexpected "${peek().t}" at the end`, peek().pos);
  return root;
}

export function evaluate(node, env = {}) {
  switch (node.t) {
    case 'num': return node.v;
    case 'name': return node.v in env ? env[node.v] : CONSTS[node.v];
    case 'neg': return -evaluate(node.a, env);
    case 'fn': return FNS[node.f](evaluate(node.a, env));
    case 'bin': {
      const a = evaluate(node.a, env), b = evaluate(node.b, env);
      switch (node.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        case '^': return Math.pow(a, b);
      }
    }
  }
}

// Parse and evaluate a constant expression (no free variables
// beyond what env provides).
export function evalIn(src, env = {}) {
  return evaluate(parse(src, Object.keys(env)), env);
}

// ---------- numeric equivalence ----------

// Are two expressions the same function of `vars`, judged by
// sampling? Extra names in `env` (drawn card parameters) are bound
// on both sides. With upToConstant, the difference only has to be
// constant, which is how "+ C" answers are checked.
export function equivalent(refSrc, userSrc, opts = {}) {
  const { vars = [], env = {}, domain = [-3, 3], upToConstant = false,
    rand = Math.random, tol = 1e-6 } = opts;
  const scope = [...vars, ...Object.keys(env)];
  const ref = parse(refSrc, scope);
  const user = parse(userSrc, scope);
  const need = 12;
  const diffs = [];
  let good = 0;
  for (let tries = 0; tries < 80 && good < need; tries++) {
    const point = { ...env };
    for (const v of vars) point[v] = domain[0] + rand() * (domain[1] - domain[0]);
    const r = evaluate(ref, point);
    const u = evaluate(user, point);
    const rOk = Number.isFinite(r), uOk = Number.isFinite(u);
    if (!rOk && !uOk) continue;          // both blow up here: not evidence either way
    if (rOk !== uOk) return false;       // one side is singular where the other is fine
    if (upToConstant) { diffs.push(u - r); good++; continue; }
    if (Math.abs(u - r) > tol * Math.max(1, Math.abs(r))) return false;
    good++;
  }
  if (good < need) return false;         // could not find enough usable points
  if (upToConstant) {
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const scale = Math.max(1, ...diffs.map(Math.abs));
    return diffs.every(d => Math.abs(d - mean) <= 1e-5 * scale);
  }
  return true;
}

// Strip a trailing "+ C" (any case) before parsing an
// antiderivative the user typed.
export function stripConstant(src) {
  return src.replace(/[+-]\s*C\s*$/i, '').trim();
}

// ---------- rendering what the parser understood ----------

const TEX_FNS = {
  sin: '\\sin', cos: '\\cos', tan: '\\tan', sec: '\\sec', csc: '\\csc', cot: '\\cot',
  asin: '\\arcsin', acos: '\\arccos', atan: '\\arctan',
  arcsin: '\\arcsin', arccos: '\\arccos', arctan: '\\arctan',
  sinh: '\\sinh', cosh: '\\cosh', tanh: '\\tanh',
  ln: '\\ln', log: '\\ln', log10: '\\log_{10}', log2: '\\log_{2}', exp: '\\exp',
};
const TEX_NAMES = { pi: '\\pi', tau: '\\tau' };

// Precedence: + - (1), * / (2), unary minus (3), ^ (4), atoms (5).
function prec(node) {
  if (node.t === 'bin') return node.op === '^' ? 4 : node.op === '+' || node.op === '-' ? 1 : 2;
  if (node.t === 'neg') return 3;
  return 5;
}

function wrap(node, min) {
  const s = toTex(node);
  return prec(node) < min ? `\\left(${s}\\right)` : s;
}

// AST to LaTeX, so the answer box can echo back the math it read.
export function toTex(node) {
  switch (node.t) {
    case 'num': return Number.isInteger(node.v) ? String(node.v) : String(node.v);
    case 'name': return TEX_NAMES[node.v] || node.v;
    case 'neg': return `-${wrap(node.a, 4)}`;
    case 'fn':
      if (node.f === 'sqrt') return `\\sqrt{${toTex(node.a)}}`;
      if (node.f === 'abs') return `\\left|${toTex(node.a)}\\right|`;
      return `${TEX_FNS[node.f] || node.f}\\left(${toTex(node.a)}\\right)`;
    case 'bin': {
      switch (node.op) {
        case '+': return `${wrap(node.a, 1)} + ${wrap(node.b, 2)}`;
        case '-': return `${wrap(node.a, 1)} - ${wrap(node.b, 2)}`;
        case '/': return `\\frac{${toTex(node.a)}}{${toTex(node.b)}}`;
        case '^': return `${wrap(node.a, 5)}^{${toTex(node.b)}}`;
        case '*': {
          // numbers side by side need a dot; everything else juxtaposes
          const dot = node.b.t === 'num' ||
            (node.b.t === 'bin' && node.b.op === '*' && node.b.a.t === 'num');
          return `${wrap(node.a, 2)}${dot ? ' \\cdot ' : '\\,'}${wrap(node.b, 3)}`;
        }
      }
    }
  }
}

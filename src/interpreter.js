/* frs/src/interpreter.js — fake Rust runtime (println!, vars, exprs, control flow).
 * Pure JS, no deps. Fast + safe: iteration caps, no eval(), no I/O.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    var req = function (p) { try { return require(p); } catch (e) { return root['FRS_' + p.slice(2, -3)]; } };
    module.exports = factory(req('./util.js'), req('./lexer.js'));
  } else root.FRS_interp = factory(root.FRS_util, root.FRS_lexer);
}(typeof self !== 'undefined' ? self : this, function (U, LEX) {
  'use strict';
  var FS_X = null;
  try { FS_X = (typeof require !== 'undefined') ? require('fs') : null; } catch (e) { FS_X = null; }
  var NET_X = null;
  try { NET_X = (typeof require !== 'undefined') ? require('net') : null; } catch (e) { NET_X = null; }
  var TCP_SRVS = [];
  var NET_LISTENING = false;
  U = U || {}; LEX = LEX || {};
  var T = (LEX.T || { IDENT: 1, NUMBER: 2, STRING: 3, CHAR: 4, SYMBOL: 5, LIFETIME: 6, RAWSTR: 7, BYTESTR: 8 });

  var MAX_STEPS = 200000;
  var MAX_LOOP = 10000;
  var MAX_OUT = 20000;
  var openFds = [];
  var STDIN_STATE = null;
  function readStdinLine() {
    if (STDIN_STATE === null) {
      STDIN_STATE = { pos: 0, buf: '' };
      var isTTY = (typeof process !== 'undefined' && process.stdin && process.stdin.isTTY);
      if (!isTTY && FS_X) {
        try { STDIN_STATE.buf = FS_X.readFileSync(0, 'utf8'); } catch (e) { STDIN_STATE.buf = ''; }
      }
    }
    var b = STDIN_STATE.buf, p = STDIN_STATE.pos;
    if (p >= b.length) return '';
    var i = b.indexOf('\n', p);
    var line = i === -1 ? b.slice(p) : b.slice(p, i + 1);
    STDIN_STATE.pos = i === -1 ? b.length : i + 1;
    return line;
  }
  function run(src, opts) {
    opts = opts || {};
    var lexed;
    try { lexed = LEX.lex(src); } catch (e) { lexed = { tokens: [] }; }
    var toks = lexed.tokens || [];
    var env = {};       // name -> {type, value}
    var fns = {};       // name -> {params:[names], bodyToks}
    var qns = {};       // Type::method -> fn entry (exact path calls)
    var stdout = [];
    var stderr = [];
    var steps = 0;
    var panicked = null;

    var macros = {};
    collectFns(toks, fns, qns, macros);

    // register top-level statics/consts into env before running main
    (function scanStatics() {
      var d = 0;
      for (var i = 0; i < toks.length; i++) {
        var v = toks[i].v;
        if (v === '{') d++;
        else if (v === '}') d--;
        else if (d === 0 && toks[i].t === T.IDENT && (v === 'static' || v === 'const')) {
          var j = i + 1, dd = 0, end = -1;
          while (j < toks.length) {
            var vv = toks[j].v;
            if (vv === '(' || vv === '[' || vv === '{' || vv === '<') dd++;
            else if (vv === ')' || vv === ']' || vv === '}' || vv === '>') dd--;
            else if (vv === '>>') dd -= 2;
            else if (vv === ';' && dd === 0) { end = j; break; }
            j++;
          }
          if (end !== -1) {
            var nameT = toks[i + 1];
            var eq = -1;
            for (var q = i + 1; q < end; q++) { if (toks[q].v === '=') { eq = q; break; } }
            if (eq !== -1 && nameT && nameT.t === T.IDENT) {
              try { env[nameT.v] = evalExpr(toks.slice(eq + 1, end), env, fns, { steps: 0, qns: qns, macros: macros, stdout: { push: function () {} }, stderr: { push: function () {} } }); }
              catch (e) { env[nameT.v] = { value: 0, type: 'unknown' }; }
            }
            i = end;
          }
        }
        if (d === 0 && v === 'macro_rules') {
          // skip to end of its {} block
          var k = i + 1;
          while (k < toks.length && toks[k].v !== '{') k++;
          var dd2 = 0;
          while (k < toks.length) {
            if (toks[k].v === '{') dd2++;
            else if (toks[k].v === '}') { dd2--; if (dd2 === 0) break; }
            k++;
          }
          i = k;
        }
      }
    })();

    // Execute fn main body (or whole file if no fn? run top-level lets+prints)
    var main = fns.main;
    var state = { steps: 0, qns: qns, macros: macros };
    try {
      if (main) execBlock(main.bodyToks, env, fns, stdout, stderr, state);
      else execBlock(toks, env, fns, stdout, stderr, state);
    } catch (e) {
      if (e && (e.__frsPanic || e.__frsTryErr)) panicked = e.__frsPanic ? e : { __frsPanic: true, msg: 'Error: ' + rustToString(e.value), line: 1, col: 1 };
      else throw e;
    }
    for (var oi = 0; oi < openFds.length; oi++) { try { FS_X && FS_X.closeSync(openFds[oi]); } catch (eO) {} }
    if (!NET_LISTENING) { for (var si = 0; si < TCP_SRVS.length; si++) { try { TCP_SRVS[si].close(); } catch (eS) {} } }

    var out = stdout.join('');
    var serving = NET_LISTENING;
    if (out.length > MAX_OUT) out = out.slice(0, MAX_OUT);
    return {
      stdout: out,
      stderr: stderr.join(''),
      panicked: panicked, // {msg, line, col}
      env: env,
      serve: serving
    };
  }

  // ---- fn collection: fn name(params) { body } ----
  // Top-level fns go in `fns`; methods inside `impl Type`/`trait` also get
  // qualified aliases `Type::method` in `qns` (exact path calls resolve there).
  function collectFns(toks, fns, qns, macros) {
    // parse macro_rules! defs: name -> [{params: [names], bodyToks: [...]}]
    if (macros) {
      for (var mi = 0; mi < toks.length; mi++) {
        if (toks[mi].t === T.IDENT && toks[mi].v === 'macro_rules') {
          var mni = mi + 1;
          if (toks[mni] && toks[mni].v === '!') mni++;
          var mname = (toks[mni] && toks[mni].t === T.IDENT) ? toks[mni].v : null;
          var msc = mni + 1;
          while (msc < toks.length && toks[msc].v !== '{') msc++;
          if (msc < toks.length && mname) {
            var bme = matchTok(toks, msc, '{', '}');
            var bodyT = bme === -1 ? [] : toks.slice(msc + 1, bme);
            // split arms on top-level `;` where each arm is `PAT => TRAN ::= split top-level '=>'
            // arm separator: `;` or new arm `(` — arms end with `};` or `}` then `,`
            var arms = [];
            // an arm looks like: ( ... ) => { ... } ;
            var ap = 0;
            while (ap < bodyT.length) {
              if (bodyT[ap].v !== '(') { ap++; continue; }
              var pce = matchTok(bodyT, ap, '(', ')');
              if (pce === -1) break;
              var pat = bodyT.slice(ap + 1, pce);
              var arr = pce + 1;
              while (arr < bodyT.length && bodyT[arr].v !== '=>') arr++;
              if (arr >= bodyT.length) break;
              // transcriber: next token group: `{...}` or a single-expr arm
              var tb = arr + 1;
              var tranToks;
              if (bodyT[tb].v === '{') {
                var tbe = matchTok(bodyT, tb, '{', '}');
                tranToks = tbe === -1 ? bodyT.slice(tb + 1) : bodyT.slice(tb + 1, tbe);
                ap = tbe + 1;
              } else {
                var tbe2 = -1;
                var td = 0;
                for (var tr = tb; tr < bodyT.length; tr++) {
                  var tv = bodyT[tr].v;
                  if (tv === '(' || tv === '[' || tv === '{') td++;
                  else if (tv === ')' || tv === ']' || tv === '}') { td--; if (td < 0) { tbe2 = tr; break; } }
                  else if (tv === ';' && td === 0) { tbe2 = tr; break; }
                }
                tranToks = tbe2 === -1 ? bodyT.slice(tb) : bodyT.slice(tb, tbe2);
                ap = tbe2 + 1;
              }
              // capture `$name:expr` params from pat
              var params = [];
              for (var pp = 0; pp < pat.length; pp++) {
                if (pat[pp].v === '$' && pp + 1 < pat.length && pat[pp + 1].t === T.IDENT) {
                  params.push(pat[pp + 1].v);
                  pp++;
                }
              }
              arms.push({ params: params, bodyToks: tranToks });
            }
            macros[mname] = arms;
          }
          mi = msc < toks.length ? Math.max(msc, mi + 1) : mi + 1;
        }
      }
    }

    var n = toks.length;
    // impl/trait ranges + their self type names
    var impls = [];
    for (var s = 0; s < n; s++) {
      if (toks[s].t === T.IDENT && (toks[s].v === 'impl' || toks[s].v === 'trait')) {
        var tname = null;
        for (var q0 = s + 1; q0 < Math.min(n, s + 8); q0++) {
          if (toks[q0].t === T.IDENT && !isKw(toks[q0].v)) {
            if (toks[q0].v[0] >= 'A' && toks[q0].v[0] <= 'Z') { tname = toks[q0].v; break; }
          }
          if (toks[q0].v === '{' || toks[q0].v === ';') break;
        }
        for (var q1 = s + 1; q1 < Math.min(n, s + 30); q1++) {
          if (toks[q1].v === '{') {
            var ee = matchTok(toks, q1, '{', '}');
            impls.push({ type: tname, start: q1, end: ee === -1 ? n : ee });
            break;
          }
          if (toks[q1].v === ';') break;
        }
      }
    }
    function implOf(idx) {
      for (var r = 0; r < impls.length; r++) {
        if (idx > impls[r].start && idx < impls[r].end) return impls[r].type;
      }
      return null;
    }
    for (var i = 0; i < n; i++) {
      if (toks[i].t === T.IDENT && toks[i].v === 'fn' && i + 1 < n && toks[i + 1].t === T.IDENT) {
        var name = toks[i + 1].v;
        var k = i + 2;
        // skip generics
        if (toks[k] && toks[k].v === '<') {
          var gd = 0;
          while (k < n) {
            if (toks[k].v === '<') gd++;
            else if (toks[k].v === '>>') { gd -= 2; if (gd <= 0) { k++; break; } }
            else if (toks[k].v === '>') { gd--; if (gd === 0) { k++; break; } }
            k++;
          }
        }
        if (!toks[k] || toks[k].v !== '(') continue;
        var ce = matchTok(toks, k, '(', ')');
        if (ce === -1) continue;
        // params: ident names = ident followed by `:` (types after `:` are skipped)
        var params = [];
        var d = 0, cur = null;
        for (var p = k + 1; p < ce; p++) {
          var v = toks[p].v;
          if (v === '(' || v === '[' || v === '{') d++;
          else if (v === ')' || v === ']' || v === '}') d--;
          else if (d === 0 && toks[p].t === T.IDENT && v !== 'mut' && !isKw(v)) {
            var nx = toks[p + 1] ? toks[p + 1].v : '';
            if (nx === ':') params.push(v);
            if (v === 'self') params.unshift('self');
          }
        }
        var ak = ce + 1;
        if (toks[ak] && toks[ak].v === '->') {
          while (ak < n && toks[ak].v !== '{' && toks[ak].v !== ';') ak++;
        }
        if (toks[ak] && toks[ak].v === 'where') {
          while (ak < n && toks[ak].v !== '{' && toks[ak].v !== ';') ak++;
        }
        if (toks[ak] && toks[ak].v === '{') {
          var be = matchTok(toks, ak, '{', '}');
          var entry = {
            params: params, bodyToks: be === -1 ? [] : toks.slice(ak + 1, be),
            line: toks[i].line, col: toks[i].col, impl: false
          };
          var selfT = implOf(i);
          if (selfT) {
            entry.impl = true;
            entry.implT = selfT;
            if (qns && selfT) qns[selfT + '::' + name] = entry;
          }
          fns[name] = entry;
        }
      }
    }
  }

  function matchTok(toks, from, open, close) {
    var d = 0;
    for (var i = from; i < toks.length; i++) {
      if (toks[i].v === open) d++;
      else if (toks[i].v === close) { d--; if (d === 0) return i; }
    }
    return -1;
  }

  function isKw(s) {
    return s === 'let' || s === 'mut' || s === 'fn' || s === 'if' || s === 'else' ||
      s === 'for' || s === 'while' || s === 'loop' || s === 'match' || s === 'return' ||
      s === 'break' || s === 'continue' || s === 'in' || s === 'struct' || s === 'enum' ||
      s === 'impl' || s === 'use' || s === 'pub' || s === 'true' || s === 'false' ||
      s === 'as' || s === 'ref' || s === 'where' || s === 'const' || s === 'static';
  }

  // ---- statement splitter (top-level `;` + blocks) ----
  function execBlock(toks, env, fns, stdout, stderr, st) {
    // publish sinks on `st` so nested evalExpr/callFn can print (no null sinks).
    if (stdout && typeof stdout.push === 'function') { st.stdout = stdout; st.stderr = stderr; }
    var i = 0, n = toks.length;
    while (i < n) {
      if (++st.steps > MAX_STEPS) throw { __frsPanic: true, msg: 'execution limit exceeded', line: 1, col: 1, limit: true };
      var tk = toks[i];
      if (!tk) break;

      // skip fn items (already collected)
      if (tk.t === T.IDENT && tk.v === 'fn') { i = skipItem(toks, i); continue; }
      if (tk.t === T.IDENT && (tk.v === 'struct' || tk.v === 'enum' || tk.v === 'trait' || tk.v === 'impl' || tk.v === 'mod' || tk.v === 'use')) { i = skipToSemiOrBlock(toks, i); continue; }
      if (tk.t === T.IDENT && tk.v === 'macro_rules') { i = skipToSemiOrBlock(toks, i); continue; }
      if (tk.t === T.IDENT && tk.v === 'type') { i = skipToSemiOrBlock(toks, i); continue; }
      // static/const: register name -> evaluated value
      if (tk.t === T.IDENT && (tk.v === 'static' || tk.v === 'const')) {
        var scEnd = -1, scDepth = 0;
        for (var sq = i + 1; sq < toks.length && sq < i + 200; sq++) {
          if (toks[sq].t === T.SYMBOL) {
            if (toks[sq].v === '(' || toks[sq].v === '[' || toks[sq].v === '{' || toks[sq].v === '<') scDepth++;
            else if (toks[sq].v === ')' || toks[sq].v === ']' || toks[sq].v === '}' || toks[sq].v === '>') scDepth--;
            else if (toks[sq].v === '>>') scDepth -= 2;
            else if (toks[sq].v === '<<') scDepth += 2;
            else if (toks[sq].v === ';' && scDepth === 0) { scEnd = sq; break; }
          }
        }
        var scStmt = scEnd === -1 ? toks.slice(i) : toks.slice(i, scEnd);
        // name = token after 'static'/'const' (skip `mut`/visibility already skipped since skipToSemiOrBlock used)
        var scName = toks[i + 1] && toks[i + 1].t === T.IDENT ? toks[i + 1].v : null;
        var eqI = -1;
        for (var q = 0; q < scStmt.length; q++) { if (scStmt[q].v === '=') { eqI = q; break; } }
        if (scName && eqI !== -1) {
          try { env[scName] = evalExpr(scStmt.slice(eqI + 1), env, fns, st); }
          catch (e) { env[scName] = { value: 0, type: 'unknown' }; }
          if (env[scName] && env[scName].value !== undefined) {} else env[scName] = { value: 0, type: 'unknown' };
        }
        i = scEnd === -1 ? i + 1 : scEnd + 1;
        continue;
      }
      if (tk.t === T.SYMBOL && (tk.v === '}' || tk.v === ';')) { i++; continue; }

      // let ...
      if (tk.t === T.IDENT && tk.v === 'let') {
        i = execLet(toks, i, env, fns, stdout, stderr, st);
        continue;
      }
      // if / for / while / loop / match / return / break / continue
      if (tk.t === T.IDENT && tk.v === 'if') { i = execIf(toks, i, env, fns, stdout, stderr, st); continue; }
      if (tk.t === T.IDENT && tk.v === 'for') { i = execFor(toks, i, env, fns, stdout, stderr, st); continue; }
      if (tk.t === T.IDENT && (tk.v === 'while' || tk.v === 'loop')) { i = execWhile(toks, i, env, fns, stdout, stderr, st); continue; }
      if (tk.t === T.IDENT && tk.v === 'match') { i = execMatch(toks, i, env, fns, stdout, stderr, st); continue; }
      if (tk.t === T.IDENT && tk.v === 'return') {
        var rv = evalStmtExpr(toks, i + 1, env, fns, st);
        throw { __frsReturn: true, value: rv.value };
      }
      if (tk.t === T.IDENT && tk.v === 'break') throw { __frsBreak: true };
      if (tk.t === T.IDENT && tk.v === 'continue') throw { __frsContinue: true };

      // expression statement: find `;` or block end at depth 0
      var stmt = sliceStmt(toks, i);
      execExprStmt(stmt.toks, env, fns, stdout, stderr, st, tk);
      i = stmt.next;
    }
  }

  function skipItem(toks, i) {
    var n = toks.length;
    var k = i + 1;
    while (k < n && toks[k].v !== '{' && toks[k].v !== ';') k++;
    if (k < n && toks[k].v === '{') {
      var e = matchTok(toks, k, '{', '}');
      return e === -1 ? n : e + 1;
    }
    return Math.min(n, k + 1);
  }

  function skipToSemiOrBlock(toks, i) {
    var n = toks.length, k = i;
    var d = 0;
    while (k < n) {
      var v = toks[k].v;
      if (v === '{') { var e = matchTok(toks, k, '{', '}'); return e === -1 ? n : e + 1; }
      if (v === ';') return k + 1;
      k++;
      if (k - i > 100) return k;
    }
    return n;
  }

  function sliceStmt(toks, i) {
    var n = toks.length, d = 0, k = i;
    while (k < n) {
      var v = toks[k].v;
      if (v === '(' || v === '[' || v === '{') d++;
      else if (v === ')' || v === ']' || v === '}') {
        if (d === 0) break;
        d--;
        // a block-tailed statement like `if..{}`/`{...}` ends without `;`
        if (d < 0) break;
      }
      else if (v === ';' && d === 0) return { toks: toks.slice(i, k), next: k + 1 };
      k++;
      if (k - i > 500) break;
    }
    return { toks: toks.slice(i, k), next: k };
  }

  // ---- let ----
  function execLet(toks, i, env, fns, stdout, stderr, st) {
    var n = toks.length, k = i + 1;
    if (toks[k] && toks[k].v === 'mut') k++;
    var patToks = null, name = (toks[k] && toks[k].t === T.IDENT) ? toks[k].v : '_';
    if (toks[k] && (toks[k].v === '(' || toks[k].v === '[')) {
      // pattern destructuring: `let (a, b) = ...` / `let [a, b] = ...`
      var close = toks[k].v === '(' ? ')' : ']';
      var pe = -1, pd = 0;
      for (var q0 = k; q0 < n; q0++) {
        if (toks[q0].v === toks[k].v) pd++;
        else if (toks[q0].v === close) { pd--; if (pd === 0) { pe = q0; break; } }
      }
      if (pe !== -1) { patToks = toks.slice(k + 1, pe); k = pe + 1; }
      name = '_';
    }
    // find `=` at depth 0
    var eq = -1, d = 0;
    for (var q = k; q < n; q++) {
      var v = toks[q].v;
      if (v === '(' || v === '[' || v === '{') d++;
      else if (v === ')' || v === ']' || v === '}') { if (d === 0) break; d--; }
      else if (v === ';' && d === 0) break;
      else if (v === '=' && d === 0 && toks[q].t === T.SYMBOL) { eq = q; break; }
      if (q - k > 60) break;
    }
    var end = sliceStmt(toks, i).next;
    var valToks = eq === -1 ? [] : toks.slice(eq + 1, end - 1 >= eq + 1 ? end - (toks[end - 1] && toks[end - 1].v === ';' ? 1 : 0) : end);
    // valToks may include trailing junk if sliceStmt stopped at `}` — trim:
    var val = { value: 0, type: 'i32' };
    if (valToks.length) {
      try { val = evalExpr(valToks, env, fns, st); }
      catch (e) { if (e && (e.__frsReturn || e.__frsBreak || e.__frsContinue || e.__frsPanic)) throw e; val = { value: 0, type: 'unknown' }; }
    }
    if (patToks) {
      // destructure: pattern idents get successive tuple/vec elements
      var items = (val.value && val.value.__rust === 'vec') ? val.value.items : [];
      if (!items.length && typeof val.value === 'object' && val.value && 'value' in Object(val.value)) items = [val.value.value];
      var pos = 0;
      for (var pi = 0; pi < patToks.length; pi++) {
        var tv2 = patToks[pi];
        if (tv2.t === T.IDENT && tv2.v !== 'mut' && !isKw(tv2.v) && tv2.v !== '_') {
          env[tv2.v] = pos < items.length ? { value: items[pos], type: 'unknown' } : { value: 0, type: 'unknown' };
          pos++;
        }
      }
      return end;
    }
    if (name !== '_') env[name] = val;
    return end;
  }

  // ---- expression statement (assign / macro / call) ----
  function execExprStmt(stToks, env, fns, stdout, stderr, st, firstTk) {
    if (!stToks.length) return;
    // assignment: IDENT = ...
    if (stToks.length >= 3 && stToks[0].t === T.IDENT && stToks[1].v === '=' && !isKw(stToks[0].v)) {
      var val = evalExpr(stToks.slice(2), env, fns, st);
      env[stToks[0].v] = val;
      return;
    }
    if (stToks.length >= 3 && stToks[0].t === T.IDENT && (stToks[1].v === '+=' || stToks[1].v === '-=' || stToks[1].v === '*=' || stToks[1].v === '/=' || stToks[1].v === '%=')) {
      var cur = env[stToks[0].v] ? num(env[stToks[0].v].value) : 0;
      var rhs = num(evalExpr(stToks.slice(2), env, fns, st).value);
      var op = stToks[1].v[0];
      var r = op === '+' ? cur + rhs : op === '-' ? cur - rhs : op === '*' ? cur * rhs : op === '/' ? (rhs === 0 ? cur : cur / rhs) : cur % rhs;
      env[stToks[0].v] = { value: r, type: 'i32' };
      return;
    }
    // macro statement
    if (stToks[0].t === T.IDENT && stToks[1] && stToks[1].v === '!') {
      execMacro(stToks, env, fns, stdout, stderr, st, firstTk);
      return;
    }
    // bare call / expr — evaluate for side effects (function bodies run)
    try { evalExpr(stToks, env, fns, st); } catch (e) {
      if (e && (e.__frsReturn || e.__frsBreak || e.__frsContinue || e.__frsPanic)) throw e;
    }
  }

  function execMacro(stToks, env, fns, stdout, stderr, st, firstTk) {
    var name = stToks[0].v;
    // find open `(`, `[`, `{`
    var oi = 1;
    while (oi < stToks.length && stToks[oi].v !== '(' && stToks[oi].v !== '[' && stToks[oi].v !== '{') oi++;
    if (oi >= stToks.length) return;
    var open = stToks[oi].v;
    var close = open === '(' ? ')' : open === '[' ? ']' : '}';
    var e = matchTok(stToks, oi, open, close);
    var inner = e === -1 ? stToks.slice(oi + 1) : stToks.slice(oi + 1, e);
    // split top-level args
    var args = splitArgs(inner);
    if (name === 'println' || name === 'print' || name === 'eprintln' || name === 'eprint') {
      var s = formatMacro(args, env, fns, st);
      if (name[0] === 'e') stderr.push(s + (name === 'eprintln' ? '\n' : ''));
      else stdout.push(s + (name === 'println' ? '\n' : ''));
      return;
    }
    if (name === 'write' || name === 'writeln') {
      // writeln!(file, "fmt", args..) or write!(f, "fmt", args..) -> real fd / stdout
      var wTarget = null;
      try { wTarget = args.length ? evalExpr(args[0], env, fns, st).value : null; } catch (ez) { wTarget = null; }
      var wRest = args.slice(1);
      var wText = wRest.length ? formatMacro(wRest, env, fns, st) : '';
      if (name === 'writeln') wText += '\n';
      if (wTarget !== null && typeof wTarget === 'object' && wTarget.__rust === 'file' && FS_X) {
        try { FS_X.writeSync(wTarget._fd, wText); } catch (e6) { stderr.push('error writing file: ' + e6.message + '\n'); }
      } else if (wTarget !== null && typeof wTarget === 'object' && wTarget.__rust === 'stdout') {
        stdout.push(wText);
      } else if (wTarget !== null && typeof wTarget === 'object' && wTarget.__rust === 'stderr') {
        stderr.push(wText);
      } else {
        // default: treat like eprintln where unknown
        stderr.push.apply ? null : null;
        stdout.push(wText);
      }
      return;
    }
    if (name === 'panic') {
      var msg = args.length ? rustToString(evalExpr(args[0], env, fns, st).value) : 'explicit panic';
      // try format-style: panic!("msg {}", x)
      if (args.length >= 1 && args[0].length === 1 && (args[0][0].t === T.STRING || args[0][0].t === T.RAWSTR)) {
        msg = formatMacro(args, env, fns, st);
      }
      var tk = firstTk || stToks[0];
      throw { __frsPanic: true, msg: msg, line: tk.line, col: tk.col };
    }
    if (name === 'assert' || name === 'assert_eq' || name === 'assert_ne') {
      var ok = true;
      if (name === 'assert' && args.length) ok = truthy(evalExpr(args[0], env, fns, st).value);
      if ((name === 'assert_eq' || name === 'assert_ne') && args.length >= 2) {
        var a = rustToString(evalExpr(args[0], env, fns, st).value);
        var b = rustToString(evalExpr(args[1], env, fns, st).value);
        ok = name === 'assert_eq' ? a === b : a !== b;
      }
      if (!ok) {
        var tk2 = firstTk || stToks[0];
        throw { __frsPanic: true, msg: 'assertion failed', line: tk2.line, col: tk2.col };
      }
      return;
    }
    if (name === 'todo' || name === 'unimplemented' || name === 'unreachable') {
      var tk3 = firstTk || stToks[0];
      throw { __frsPanic: true, msg: name === 'todo' ? 'not yet implemented' : 'internal error: entered unreachable code', line: tk3.line, col: tk3.col };
    }
    // try user macro_rules expansion first
    if (st.macros && st.macros[name]) {
      var exp = expandMacro(name, inner, env, fns, st);
      if (exp) {
        try { evalExpr(exp, env, fns, st); } catch (e3) { if (e3 && e3.__frsPanic) throw e3; }
        try { execExprStmt(exp, env, fns, stdout, stderr, st, firstTk || stToks[0]); } catch (e4) { if (e4 && e4.__frsPanic) throw e4; }
        return;
      }
    }
    // unknown macros: evaluate args (side effects), ignore
    for (var a = 0; a < args.length; a++) {
      try { evalExpr(args[a], env, fns, st); } catch (e2) {
        if (e2 && (e2.__frsReturn || e2.__frsPanic || e2.__frsBreak || e2.__frsContinue)) throw e2;
      }
    }
  }

  function expandMacro(name, argToks, env, fns, st) {
    if (!st.macros || !st.macros[name]) return null;
    var arms = st.macros[name];
    var args = splitArgs(argToks).filter(function (a) { return a.length; });
    var chosen = null;
    for (var a = 0; a < arms.length; a++) {
      if (arms[a].params.length === args.length) { chosen = arms[a]; break; }
    }
    if (!chosen) chosen = arms[0];
    // splice: replace $name tokens with the bound raw arg tokens
    var map = {};
    for (var i = 0; i < chosen.params.length; i++) {
      map[chosen.params[i]] = args[i] || [];
    }
    var out = [];
    for (var b = 0; b < chosen.bodyToks.length; b++) {
      var bt = chosen.bodyToks[b];
      // `$` and the name are separate tokens in Rust lexers
      if (bt.v === '$' && b + 1 < chosen.bodyToks.length && chosen.bodyToks[b + 1].t === T.IDENT
          && map[chosen.bodyToks[b + 1].v] !== undefined) {
        var rep = map[chosen.bodyToks[b + 1].v];
        for (var r = 0; r < rep.length; r++) out.push(rep[r]);
        b++;
      } else if (bt.t === T.IDENT && bt.v[0] === '$' && map[bt.v.slice(1)] !== undefined) {
        var rep2 = map[bt.v.slice(1)];
        for (var r2 = 0; r2 < rep2.length; r2++) out.push(rep2[r2]);
      } else out.push(bt);
    }
    return out;
  }

  function evalExpr_inject(toks, env, fns, st) {
    if (toks && toks.length && toks[0] && toks[0].__tv) {
      var b = toks[0].__tv;
      var rt = toks.slice(1);
      if (!rt.length) return { value: b, type: 'unknown' };
      if (rt[0].v === '.') {
        env.__chainBase = { value: b, type: 'unknown' };
        return evalExpr([{ t: T.IDENT, v: '__chainBase', idx: 0, line: 1, col: 1 }].concat(rt), env, fns, st);
      }
      return { value: b, type: 'unknown' };
    }
    return evalExpr(toks, env, fns, st);
  }

  function finishMethodResult(v, rt, env, fns, st) {
    var val = v;
    var rest = rt;
    while (rest.length && rest[0].v === '?') {
      if (val !== null && typeof val === 'object' && val.__rust === 'result' && !val.ok) { throw { __frsTryErr: true, value: val.value }; }
      if (val !== null && typeof val === 'object' && val.__rust === 'option' && !val.some) { throw { __frsTryErr: true, value: undefined }; }
      if (val !== null && typeof val === 'object' && val.__rust === 'result' && val.ok) val = val.value;
      else if (val !== null && typeof val === 'object' && val.__rust === 'option' && val.some) val = val.value;
      rest = rest.slice(1);
    }
    if (rest.length && rest[0].v === '.') {
      env.__chainBase = { value: val, type: 'unknown' };
      var r2 = evalExpr([{ t: T.IDENT, v: '__chainBase', idx: 0, line: 1, col: 1 }].concat(rest), env, fns, st);
      return r2;
    }
    if (!rest.length) return { value: val, type: 'unknown' };
    return evalBinOp({ value: val, type: 'unknown' }, rest, env, fns, st);
  }

  function splitArgs(toks) {
    var out = [], d = 0, cur = [];
    for (var i = 0; i < toks.length; i++) {
      var v = toks[i].v;
      if (v === '(' || v === '[' || v === '{') { d++; cur.push(toks[i]); }
      else if (v === ')' || v === ']' || v === '}') { d--; cur.push(toks[i]); }
      else if (v === ',' && d === 0) { out.push(cur); cur = []; }
      else cur.push(toks[i]);
    }
    if (cur.length || out.length) out.push(cur);
    return out;
  }

  function unquote(t) {
    var s = t.v;
    if (t.t === T.RAWSTR) {
      var q = s.indexOf('"');
      var h = 0;
      for (var k = 1; k < q; k++) if (s[k] === '#') h++;
      return s.slice(q + 1, s.length - 1 - h);
    }
    // "..." with escapes
    var inner = s.slice(1, -1);
    return inner.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
      .replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\0/g, '\0');
  }

  // println!-style formatting: "{}" "{:?}" "{:.2}" "{x}" "{x:?}" + named args
  function formatMacro(args, env, fns, st) {
    if (!args.length) return '';
    var first = args[0];
    var fmt;
    if (first.length === 1 && (first[0].t === T.STRING || first[0].t === T.RAWSTR)) fmt = unquote(first[0]);
    else return rustToString(evalExpr(first, env, fns, st).value);
    // named args: `name = expr`
    var named = {};
    var positional = [];
    for (var i = 1; i < args.length; i++) {
      var a = args[i];
      if (a.length >= 3 && a[0].t === T.IDENT && a[1].v === '=') {
        named[a[0].v] = evalExpr(a.slice(2), env, fns, st).value;
      } else positional.push(evalExpr(a, env, fns, st).value);
    }
    var pi = 0;
    var out = '';
    for (var k = 0; k < fmt.length; k++) {
      var c = fmt[k];
      if (c === '{' && fmt[k + 1] === '{') { out += '{'; k++; continue; }
      if (c === '}' && fmt[k + 1] === '}') { out += '}'; k++; continue; }
      if (c === '{') {
        var e = fmt.indexOf('}', k);
        if (e === -1) { out += c; continue; }
        var inside = fmt.slice(k + 1, e);
        var val;
        if (inside === '' || inside[0] === ':' || (inside[0] >= '0' && inside[0] <= '9')) {
          // positional (+ optional width/precision — value rendered plainly)
          var idx = inside === '' || inside[0] === ':' ? pi++ : (function () { var n = parseInt(inside, 10); pi = Math.max(pi, n + 1); return n; })();
          val = idx < positional.length ? positional[idx] : '';
        } else {
          // named: name or name:spec
          var nm = inside.split(':')[0];
          if (nm in named) val = named[nm];
          else if (env[nm] !== undefined) val = env[nm].value;
          else val = '';
        }
        out += rustDisplay(val, inside);
        k = e;
        continue;
      }
      out += c;
    }
    return out;
  }

  function rustDisplay(val, spec) {
    if (val !== null && typeof val === 'object' && val.__rust === 'struct') {
      var ks = Object.keys(val.fields);
      return val.name + ' { ' + ks.map(function (k) { return k + ': ' + rustDebug(val.fields[k]); }).join(', ') + ' }';
    }
    if (val !== null && typeof val === 'object' && val.__rust === 'vec') {
      if ((spec || '').indexOf('?') !== -1 || (spec || '').indexOf('#') !== -1) {
        return '[' + val.items.map(function (x) { return rustDebug(x); }).join(', ') + ']';
      }
      return '[' + val.items.map(function (x) { return rustToString(x); }).join(', ') + ']';
    }
    if ((spec || '').indexOf('?') !== -1) return rustDebug(val);
    return rustToString(val);
  }

  function rustToString(v) {
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (v === null || v === undefined) return '';
    if (typeof v === 'object' && v.__rust === 'vec') return '[' + v.items.map(rustToString).join(', ') + ']';
    if (typeof v === 'object' && v.__rust === 'option') return v.some ? rustToString(v.value) : '';
    if (typeof v === 'object' && v.__rust === 'result') return rustToString(v.value);
    if (typeof v === 'object' && v.__rust === 'enum') return v.path;
    if (typeof v === 'object' && v.__rust === 'ctor') {
      return v.name + '(' + v.args.map(rustToString).join(', ') + ')';
    }
    if (typeof v === 'object' && v.__rust === 'struct') {
      var ks = Object.keys(v.fields);
      return v.name + ' { ' + ks.map(function (k) { return k + ': ' + rustToString(v.fields[k]); }).join(', ') + ' }';
    }
    if (typeof v === 'number') {
      if (!isFinite(v)) return String(v);
      // print ints without `.0`
      return String(v);
    }
    return String(v);
  }

  function rustDebug(v) {
    if (typeof v === 'string') return '"' + v.replace(/"/g, '\\"') + '"';
    if (v === true || v === false) return String(v);
    if (typeof v === 'object' && v && v.__rust === 'vec') {
      return '[' + v.items.map(rustDebug).join(', ') + ']';
    }
    if (typeof v === 'object' && v && v.__rust === 'option') {
      return v.some ? 'Some(' + rustDebug(v.value) + ')' : 'None';
    }
    if (typeof v === 'object' && v && v.__rust === 'result') {
      return (v.ok ? 'Ok(' : 'Err(') + rustDebug(v.value) + ')';
    }
    if (typeof v === 'object' && v && v.__rust === 'enum') return v.path;
    if (typeof v === 'object' && v && v.__rust === 'ctor') {
      return v.name + '(' + v.args.map(rustDebug).join(', ') + ')';
    }
    if (typeof v === 'number') return String(v);
    return rustToString(v);
  }

  function truthy(v) {
    if (v === false || v === 0 || v === '' || v === null || v === undefined) return false;
    if (typeof v === 'object' && v.__rust === 'option') return !!v.some;
    return true;
  }

  function num(v) {
    if (typeof v === 'number') return v;
    var n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }

  // ---- expression evaluator (literals, vars, arith, comparisons, calls, vec, format) ----
  function evalExpr(toks, env, fns, st) {
    if (!toks.length) return { value: 0, type: 'i32' };
    if (++st.steps > MAX_STEPS) throw { __frsPanic: true, msg: 'execution limit exceeded', line: 1, col: 1, limit: true };
    // trim trailing `,`/`;`
    while (toks.length && (toks[toks.length - 1].v === ',' || toks[toks.length - 1].v === ';')) toks = toks.slice(0, -1);
    if (!toks.length) return { value: 0, type: 'i32' };
    // try-operator `?`: unwrap Result/Option, propagate Err via throw
    var tailQ = false;
    if (toks.length >= 2 && toks[toks.length - 1].v === '?') { tailQ = true; toks = toks.slice(0, -1); }
    var hasQ = false;
    for (var qi = 0; qi < toks.length; qi++) { if (toks[qi].v === '?') { hasQ = true; break; } }
    if (hasQ) {
      var tq = [];
      for (var qi2 = 0; qi2 < toks.length; qi2++) { if (toks[qi2].v !== '?') tq.push(toks[qi2]); }
      toks = tq;
    }
    if (tailQ) {
      var innerR = evalExpr(toks, env, fns, st);
      if (innerR.value !== null && typeof innerR.value === 'object' && innerR.value.__rust === 'result' && !innerR.value.ok) {
        throw { __frsTryErr: true, value: innerR.value.value };
      }
      if (innerR.value !== null && typeof innerR.value === 'object' && innerR.value.__rust === 'option' && !innerR.value.some) {
        throw { __frsTryErr: true, value: undefined };
      }
      if (innerR.value !== null && typeof innerR.value === 'object' && innerR.value.__rust === 'result' && innerR.value.ok) {
        return { value: innerR.value.value, type: 'unknown' };
      }
      if (innerR.value !== null && typeof innerR.value === 'object' && innerR.value.__rust === 'option' && innerR.value.some) {
        return { value: innerR.value.value, type: 'unknown' };
      }
      return innerR;
    }

    // block expr: { stmts } -> value of last expr (tail) or ()
    if (toks[0].v === '{' && matchTok(toks, 0, '{', '}') === toks.length - 1) {
      var inner = toks.slice(1, -1);
      // tail expression? split last stmt: if no trailing `;`, tail is value
      var hasSemi = inner.length && inner[inner.length - 1].v === ';';
      try {
        if (!hasSemi && inner.length) {
          // exec all but tail, eval tail
          var lastStart = findStmtStart(inner);
          var head = inner.slice(0, lastStart);
          var tail = inner.slice(lastStart);
          // head may end with `;` — exec it
          var childEnv = Object.create(env);
          // Note: `let` in block should not leak — use child scope, but outer
          // assignments still visible via prototype chain reads. Writes go to child.
          var O = st.stdout || { push: function () { } };
          var E = st.stderr || { push: function () { } };
          execBlock(head, childEnv, fns, O, E, st);
          // merge mutated outer vars? keep simple: copy back existing keys
          function mergeBack() {
            for (var kk in childEnv) { if (Object.prototype.hasOwnProperty.call(childEnv, kk)) env[kk] = childEnv[kk]; }
          }
          if (!tail.length) { mergeBack(); return { value: 0, type: '()' }; }
          // statement tails (let/loops/return/effect-macros) exec for effects, value ();
          // expression tails (incl. if/match) evaluate to a value.
          var tailEffect = tail.length >= 2 && tail[0].t === T.IDENT && tail[1].v === '!' &&
            tail[0].v !== 'format' && tail[0].v !== 'vec';
          if (tail[0].t === T.IDENT && (tail[0].v === 'let' || tail[0].v === 'for' || tail[0].v === 'while' || tail[0].v === 'loop' || tail[0].v === 'return' || tail[0].v === 'break' || tail[0].v === 'continue') || tailEffect) {
            execBlock(tail, childEnv, fns, O, E, st);
            mergeBack();
            return { value: 0, type: '()' };
          }
          var tv2 = evalExpr(tail, childEnv, fns, st);
          mergeBack();
          return tv2;
        }
        var O2 = st.stdout || { push: function () { } };
        var E2 = st.stderr || { push: function () { } };
        execBlock(inner, env, fns, O2, E2, st);
        return { value: 0, type: '()' };
      } catch (e) {
        if (e && e.__frsReturn) return { value: e.value ? e.value.value : 0, type: 'i32' };
        throw e;
      }
    }

    // if expr as value
    if (toks[0].t === T.IDENT && toks[0].v === 'if') {
      return { value: evalIfExpr(toks, env, fns, st), type: 'unknown' };
    }
    // match expr as value
    if (toks[0].t === T.IDENT && toks[0].v === 'match') {
      return { value: evalMatchExpr(toks, env, fns, st), type: 'unknown' };
    }
    // closure literal: |x, y| expr  /  |x: i32| expr  /  || expr  /  move |x| expr
    var cStart = 0;
    if (toks[0].v === 'move' && toks[1] && toks[1].v === '|' && toks[1].t === T.SYMBOL) cStart = 1;
    if (toks[0].v === '||') {
      return { value: { __rust: 'closure', params: [], body: toks.slice(1) }, type: 'closure' };
    }
    if (toks[cStart].v === '|' && toks[cStart].t === T.SYMBOL) {
      var cparams = [], cend = -1;
      for (var ck2 = cStart + 1; ck2 < Math.min(toks.length, cStart + 15); ck2++) {
        var cw2 = toks[ck2];
        if (cw2.t === T.SYMBOL && cw2.v === '|') { cend = ck2; break; }
        if (cw2.t === T.IDENT && !isKw(cw2.v) && cw2.v !== 'mut') {
          var cnx = toks[ck2 + 1];
          // param iff followed by `:` `,` or (`|`-close right after `|`/`,`)
          if (!cnx) break;
          if (cnx.v === ':' || cnx.v === ',') cparams.push(cw2.v);
          else if (cnx.v === '|' && (ck2 === cStart + 1 || (toks[ck2 - 1] && (toks[ck2 - 1].v === '|' || toks[ck2 - 1].v === ',')))) cparams.push(cw2.v);
        }
      }
      if (cend !== -1) {
        return { value: { __rust: 'closure', params: cparams, body: toks.slice(cend + 1) }, type: 'closure' };
      }
      return { value: 0, type: 'unknown' };
    }
    // user macro_rules expansion (value position)
    if (st.macros && toks.length >= 3 && toks[0].t === T.IDENT && toks[1].v === '!' && st.macros[toks[0].v]) {
      var mgre = expandMacro(toks[0].v, toks.slice(3, matchTok(toks, 2, toks[2].v, toks[2].v === '(' ? ')' : toks[2].v === '[' ? ']' : '}') === -1 ? toks.length : matchTok(toks, 2, toks[2].v, toks[2].v === '(' ? ')' : toks[2].v === '[' ? ']' : '}')), env, fns, st);
      if (mgre) return evalExpr(mgre, env, fns, st);
    }
    // format!(...) as value
    if (toks.length >= 3 && toks[0].t === T.IDENT && toks[0].v === 'format' && toks[1].v === '!') {
      var oi = 2;
      var inner2 = toks.slice(oi + 1, matchTok(toks, oi, toks[oi].v, toks[oi].v === '(' ? ')' : toks[oi].v === '[' ? ']' : '}') === -1 ? toks.length : matchTok(toks, oi, toks[oi].v, toks[oi].v === '(' ? ')' : toks[oi].v === '[' ? ']' : '}'));
      var args = splitArgs(inner2);
      return { value: formatMacro(args, env, fns, st), type: 'String' };
    }
    // vec![...] literal
    if (toks.length >= 3 && toks[0].t === T.IDENT && toks[0].v === 'vec' && toks[1].v === '!' && toks[2].v === '[') {
      var ve = matchTok(toks, 2, '[', ']');
      var vinner = ve === -1 ? toks.slice(3) : toks.slice(3, ve);
      // vec![x; n] repeat form
      var semi = topIndex(vinner, ';');
      if (semi !== -1) {
        var xv = evalExpr(vinner.slice(0, semi), env, fns, st).value;
        var nv = Math.min(MAX_LOOP, Math.max(0, Math.floor(num(evalExpr(vinner.slice(semi + 1), env, fns, st).value))));
        var arr = [];
        for (var vi = 0; vi < nv; vi++) arr.push(xv);
        return { value: { __rust: 'vec', items: arr }, type: 'Vec<_>' };
      }
      var parts = splitArgs(vinner);
      var items = [];
      for (var pi2 = 0; pi2 < parts.length; pi2++) {
        if (!parts[pi2].length) continue;
        items.push(evalExpr(parts[pi2], env, fns, st).value);
      }
      return { value: { __rust: 'vec', items: items }, type: 'Vec<_>' };
    }
    // array literal [...]
    if (toks[0].v === '[' && matchTok(toks, 0, '[', ']') === toks.length - 1) {
      var ainner = toks.slice(1, -1);
      var semiA = topIndex(ainner, ';');
      if (semiA !== -1) {
        // repeat form `[x; n]` (splitArgs only splits on `,`, so split on `;` here)
        var repv = Math.min(MAX_LOOP, Math.max(0, Math.floor(num(evalExpr(ainner.slice(semiA + 1), env, fns, st).value))));
        var repb = evalExpr(ainner.slice(0, semiA), env, fns, st).value;
        var aitems = [];
        for (var ai2 = 0; ai2 < repv; ai2++) aitems.push(repb);
        return { value: { __rust: 'vec', items: aitems }, type: 'Vec<_>' };
      }
      var aparts = splitArgs(ainner);
      var aitems2 = [];
      for (var ai = 0; ai < aparts.length; ai++) {
        if (!aparts[ai].length) continue;
        aitems2.push(evalExpr(aparts[ai], env, fns, st).value);
      }
      return { value: { __rust: 'vec', items: aitems2 }, type: 'Vec<_>' };
    }
    // struct literal: Name { x: 1, y } / Name { x: 1, ..base } -> field map
    if (toks.length >= 3 && toks[0].t === T.IDENT && toks[0].v[0] >= 'A' && toks[0].v[0] <= 'Z' &&
        toks[1].v === '{') {
      var se = matchTok(toks, 1, '{', '}');
      if (se !== -1) {
        var sfields = {};
        var fparts = splitArgs(toks.slice(2, se));
        for (var fp = 0; fp < fparts.length; fp++) {
          var fa = fparts[fp];
          if (!fa.length) continue;
          if (fa.length >= 3 && fa[0].t === T.IDENT && fa[1].v === ':') {
            sfields[fa[0].v] = evalExpr(fa.slice(2), env, fns, st).value;
          } else if (fa.length === 1 && fa[0].t === T.IDENT && fa[0].v !== '_') {
            var fv3 = env[fa[0].v]; // shorthand `Point { x }`
            sfields[fa[0].v] = fv3 !== undefined ? fv3.value : 0;
          }
          // `..base` spread ignored (fake)
        }
        var sv = { __rust: 'struct', name: toks[0].v, fields: sfields };
        var srest = toks.slice(se + 1);
        if (!srest.length) return { value: sv, type: toks[0].v };
        return finishMethodResult(sv, srest, env, fns, st);
      }
    }
    // tuple-struct / enum-ctor call: Some(x), Ok(x), Err(e), Point(x, y)
    if (toks.length >= 2 && toks[0].t === T.IDENT && toks[1].v === '(' &&
        toks[0].v[0] >= 'A' && toks[0].v[0] <= 'Z' && !isKw(toks[0].v)) {
      var tce = matchTok(toks, 1, '(', ')');
      var targs = splitArgs(toks.slice(2, tce === -1 ? toks.length : tce))
        .filter(function (a) { return a.length; })
        .map(function (a) { return evalExpr(a, env, fns, st).value; });
      var tval;
      if (toks[0].v === 'Some') tval = { __rust: 'option', some: true, value: targs.length ? targs[0] : 0 };
      else if (toks[0].v === 'Ok') tval = { __rust: 'result', ok: true, value: targs.length ? targs[0] : 0 };
      else if (toks[0].v === 'Err') tval = { __rust: 'result', ok: false, value: targs.length ? targs[0] : 0 };
      else tval = { __rust: 'ctor', name: toks[0].v, args: targs };
      if (tce !== -1 && tce < toks.length - 1) {
        return finishMethodResult(tval, toks.slice(tce + 1), env, fns, st);
      }
      return { value: tval, type: 'unknown' };
    }
    // slice / index: expr[..b] / expr[a..b] / expr[i] / expr[a..=b]
    var brC = -1;
    for (var sp0 = 0; sp0 < toks.length; sp0++) {
      if (toks[sp0].v === '[' && sp0 > 0) { brC = sp0; break; }
    }
    if (brC !== -1 && toks.length && toks[toks.length - 1].v === ']') {
      var sBaseToks = toks.slice(0, brC);
      var sBaseVal = evalExpr(sBaseToks, env, fns, st).value;
      var sIn = toks.slice(brC + 1, toks.length - 1);
      var sidx = -1;
      for (var jj = 0; jj < sIn.length; jj++) { if (sIn[jj].v === '..') { sidx = jj; break; } }
      var sItems = (sBaseVal !== null && typeof sBaseVal === 'object' && sBaseVal.__rust === 'vec') ? sBaseVal.items : (typeof sBaseVal === 'string' ? sBaseVal.split('') : []);
      var slo = 0, shi = sItems.length, sincl = false;
      if (sidx === -1) {
        var sv = Math.floor(num(evalExpr(sIn, env, fns, st).value));
        return { value: sv >= 0 && sv < sItems.length ? sItems[sv] : 0, type: 'unknown' };
      }
      if (sidx > 0) slo = Math.floor(num(evalExpr(sIn.slice(0, sidx), env, fns, st).value));
      var srhs = sIn.slice(sidx + 1);
      if (srhs.length && srhs[0].v === '=') { sincl = true; srhs = srhs.slice(1); }
      if (srhs.length) shi = Math.floor(num(evalExpr(srhs, env, fns, st).value)) + (sincl ? 1 : 0);
      return { value: { __rust: 'vec', items: sItems.slice(slo, shi) }, type: '&[_]' };
    }

    // function call f(...)
    if (toks.length >= 2 && toks[0].t === T.IDENT && toks[1].v === '(' && !isKw(toks[0].v)) {
      var ce = matchTok(toks, 1, '(', ')');
      if (ce === toks.length - 1 || (ce !== -1 && ce < toks.length - 1 && isBinOp(toks[ce + 1]))) {
        var fnv = callFn(toks[0].v, toks.slice(2, ce === -1 ? toks.length : ce), env, fns, st, toks[0]);
        // trailing binop? `f() + 1`
        if (ce !== -1 && ce < toks.length - 1) {
          return evalBinOp(fnv, toks.slice(ce + 1), env, fns, st);
        }
        return fnv;
      }
    }
    // path call: Type::method(args) / a::b::f(args)
    if (toks.length >= 5 && toks[0].t === T.IDENT && !isKw(toks[0].v)) {
      var pd = 0, po = -1;
      for (var pi3 = 0; pi3 < toks.length; pi3++) {
        var pv3 = toks[pi3].v;
        if (pv3 === '(' || pv3 === '[' || pv3 === '{') {
          if (pv3 === '(' && pd === 0 && pi3 >= 3 &&
              toks[pi3 - 1].t === T.IDENT && toks[pi3 - 2].v === '::' &&
              toks[pi3 - 3].t === T.IDENT) { po = pi3; break; }
          pd++;
        }
        else if (pv3 === ')' || pv3 === ']' || pv3 === '}') pd--;
      }
      if (po !== -1) {
        var mname2 = toks[po - 1].v, tname2 = toks[po - 3].v;
        var ppe = matchTok(toks, po, '(', ')');
        var pargs = toks.slice(po + 1, ppe === -1 ? toks.length : ppe);
        var pvv = callPath(tname2, mname2, pargs, env, fns, st.qns || {}, st, toks[po - 1]);
        if (ppe !== -1 && ppe < toks.length - 1) {
          return finishMethodResult(pvv.value, toks.slice(ppe + 1), env, fns, st);
        }
        return pvv;
      }
    }
    // path value (no call): Dir::North / std::u8::MAX -> symbolic enum value
    if (toks.length >= 3 && isPathValue(toks)) {
      return { value: { __rust: 'enum', path: toks.map(function (t) { return t.v; }).join('') }, type: 'unknown' };
    }
    // method call: expr.method(args)
    var dotCall = findMethodCall(toks);
    if (dotCall) {
      var base = evalExpr(toks.slice(0, dotCall.dot), env, fns, st).value;
      var mname = toks[dotCall.dot + 1].v;
      var margs = toks.slice(dotCall.open + 1, dotCall.close);
      var margVals = splitArgs(margs).filter(function (a) { return a.length; }).map(function (a) { return evalExpr(a, env, fns, st).value; });
      // atomic-ish ops on simple env vars: fetch_add/fetch_sub/store/load
      if (mname === 'fetch_add' || mname === 'fetch_sub' || mname === 'store' || mname === 'swap') {
        var bv = toks.slice(0, dotCall.dot);
        if (bv.length === 1 && bv[0].t === T.IDENT && env[bv[0].v] !== undefined) {
          // find the scope that actually owns the variable (proto chain walk)
          var owner = env;
          while (owner && !Object.prototype.hasOwnProperty.call(owner, bv[0].v)) owner = Object.getPrototypeOf(owner);
          if (!owner) owner = env;
          var old = num(owner[bv[0].v].value);
          var arg0 = margVals.length ? num(margVals[0]) : 0;
          owner[bv[0].v] = { value: mname === 'store' || mname === 'swap' ? arg0 : (mname === 'fetch_add' ? old + arg0 : old - arg0), type: 'i32' };
          var retAtomic = (mname === 'store') ? undefined : old;
          if (dotCall.close < toks.length - 1) return finishMethodResult(retAtomic, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: retAtomic, type: 'unknown' };
        }
      }
      // user-defined struct method (from impl blocks): `x.foo()`
      var bval = evalExpr(toks.slice(0, dotCall.dot), env, fns, st).value;
      // Lazy init: `X.get_or_init(|| expr)` -> eval the closure
      if (mname === 'get_or_init' || mname === 'get_or_try_init') {
        if (margVals.length && margVals[0] && margVals[0].__rust === 'closure') {
          var gv = evalClosure(margVals[0], [], env, fns, st).value;
          if (dotCall.close < toks.length - 1) return finishMethodResult(gv, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: gv, type: 'unknown' };
        }
        return { value: 0, type: 'unknown' };
      }
      // OpenOptions chain
      if (base && typeof base === 'object' && base.__rust === 'openoptions' && FS_X) {
        var o_append = base._append === true;
        if (mname === 'append') { base._append = !!margVals[0]; if (dotCall.close < toks.length - 1) return finishMethodResult(base, toks.slice(dotCall.close + 1), env, fns, st); return { value: base, type: 'OpenOptions' }; }
        if (mname === 'truncate') { base._truncate = !!margVals[0]; if (dotCall.close < toks.length - 1) return finishMethodResult(base, toks.slice(dotCall.close + 1), env, fns, st); return { value: base, type: 'OpenOptions' }; }
        if (mname === 'open') {
          var o_path = (splitArgs(margs).filter(function (a) { return a.length; })[0] || []);
          var o_pv = o_path.length ? evalExpr(o_path, env, fns, st).value : '';
          var o_flags = base._append ? 'a' : (base._truncate ? 'w' : 'r+');
          try {
            var o_fd = FS_X.openSync(String(o_pv), o_flags);
            openFds.push(o_fd);
            return { value: { __rust: 'result', ok: true, value: { __rust: 'file', _fd: o_fd, path: String(o_pv) } }, type: 'Result' };
          } catch (eO) {
            return { value: { __rust: 'result', ok: false, value: String(eO.message || eO) }, type: 'Result' };
          }
        }
      }
      // file/tcpstream read/write_all
      if (mname === 'write_all' || mname === 'write') {
        if (base && typeof base === 'object' && (base.__rust === 'file' || base.__rust === 'tcpstream')) {
          var w_margs = splitArgs(margs).filter(function (a) { return a.length; })[0] || [];
          var w_v = w_margs.length ? evalExpr(w_margs, env, fns, st).value : '';
          var w_bytes;
          if (w_v !== null && typeof w_v === 'object' && w_v.__rust === 'bytes') w_bytes = w_v.raw;
          else if (w_v !== null && typeof w_v === 'object' && w_v.__rust === 'vec') w_bytes = Buffer.from(w_v.items.map(function (x) { return x | 0; }));
          else w_bytes = String(w_v);
          try {
            if (base.__rust === 'file' && FS_X) FS_X.writeSync(base._fd, w_bytes);
            else if (base.__rust === 'tcpstream' && typeof base._sock.write === 'function') base._sock.write(w_bytes);
          } catch (eW) { return { value: { __rust: 'result', ok: false, value: String(eW.message || eW) }, type: 'Result' }; }
          return { value: { __rust: 'result', ok: true, value: 0 }, type: 'Result' };
        }
      }
      if (mname === 'read') {
        if (base && typeof base === 'object' && (base.__rust === 'file' || base.__rust === 'tcpstream')) {
          var rda = splitArgs(margs).filter(function (a) { return a.length; })[0] || [];
          var rn = null;
          for (var qx2 = 0; qx2 < rda.length; qx2++) { if (rda[qx2].t === T.IDENT && rda[qx2].v !== 'mut' && rda[qx2].v !== 'ref') { rn = rda[qx2].v; break; } }
          var rbuf = rn ? ((env[rn] && env[rn].value && env[rn].value.__rust === 'vec') ? env[rn].value : null) : null;
          var rbufitems = rbuf && rbuf.items ? rbuf.items : [];
          var r_data = null;
          if (base.__rust === 'file' && FS_X) {
            try { r_data = FS_X.readSync(base._fd, Buffer.alloc(rbufitems.length || 1024), 0, rbufitems.length || 1024, null); } catch (eR) { r_data = null; }
            if (r_data && typeof r_data.bytesRead === 'number') {
              var rbr = Buffer.alloc(r_data.bytesRead);
              (r_data.buffer || r_data).copy ? r_data.buffer.copy(rbr, 0, 0, r_data.bytesRead) : Buffer.from(r_data).copy(rbr, 0, 0, r_data.bytesRead);
              r_data = rbr;
            }
          } else if (base.__rust === 'tcpstream') {
            r_data = (base._chunk && base._chunk.length) ? base._chunk : Buffer.alloc(0);
          }
          var nRead = r_data && r_data.length ? Math.min(r_data.length, rbufitems.length || r_data.length) : 0;
          if (rbuf && rbuf.items) {
            for (var ri = 0; ri < nRead; ri++) { var bv2 = r_data[ri]; rbuf.items[ri] = Array.isArray(bv2) ? bv2[0] : (bv2 | 0); }
          }
          return { value: { __rust: 'result', ok: true, value: nRead }, type: 'Result' };
        }
      }
      // std::io real stdin buffer + buffer-arg write
      if (mname === 'read_line') {
        var btoklist = splitArgs(margs).filter(function (a) { return a.length; });
        var rlArgs = (btoklist.length && btoklist[0]) || [];
        var rlName = null;
        for (var qx = 0; qx < rlArgs.length; qx++) {
          if (rlArgs[qx].t === T.IDENT && rlArgs[qx].v !== 'mut' && rlArgs[qx].v !== 'ref' && rlArgs[qx].v !== '&') { rlName = rlArgs[qx].v; break; }
        }
        var rline = readStdinLine();
        if (rlName) {
          var own = env;
          while (own && !Object.prototype.hasOwnProperty.call(own, rlName)) own = Object.getPrototypeOf(own);
          if (own) own[rlName] = { value: rline, type: 'String' };
        }
        if (dotCall.close < toks.length - 1) { var rb = rline.length; return finishMethodResult({ __rust: 'result', ok: true, value: rb }, toks.slice(dotCall.close + 1), env, fns, st); }
        return { value: { __rust: 'result', ok: true, value: rline.length }, type: 'unknown' };
      }
      if ((mname === 'accept' || mname === 'incoming') && base && typeof base === 'object' && base.__rust === 'tcplistener') {
        if (mname === 'accept') return { value: { __rust: 'result', ok: false, value: 'would block' }, type: 'Result<(TcpStream, SocketAddr)>' };
        return { value: { __rust: 'tcpincoming', _srv: base._srv }, type: 'Incoming<_>' };
      }
      if (mname === 'local_addr') return { value: { __rust: 'result', ok: true, value: '0.0.0.0:0' }, type: 'Result' };
      if (mname === 'lines' && base && typeof base === 'object' && base.__rust === 'bufreader' && FS_X) {
        var ltext = '';
        try { ltext = FS_X.readFileSync(base._path || '', 'utf8'); } catch (e5) { ltext = ''; }
        var lparts = String(ltext).split('\n').filter(function (x, i, a) { return i < a.length - 1 || x !== ''; });
        var litems = lparts.map(function (l) { return { __rust: 'result', ok: true, value: l }; });
        var lvec = { __rust: 'vec', items: litems };
        if (dotCall.close < toks.length - 1) return finishMethodResult(lvec, toks.slice(dotCall.close + 1), env, fns, st);
        return { value: lvec, type: 'Vec<_>' };
      }
      // Cell<T>-style / struct field get-set: `self.x.set(v)` / `self.x.get()`
      var btoks = toks.slice(0, dotCall.dot);
      if ((mname === 'set' || mname === 'get') && btoks.length === 3 && btoks[1].v === '.' && btoks[0].t === T.IDENT) {
        var objName = btoks[0].v, fName = btoks[2].v;
        if (env[objName] !== undefined) {
          var ov = env[objName].value;
          if (ov && ov.__rust === 'struct' && ov.fields) {
            if (mname === 'set') { ov.fields[fName] = margVals.length ? margVals[0] : 0; return { value: undefined, type: '()' }; }
            return { value: ov.fields[fName] !== undefined ? ov.fields[fName] : 0, type: 'unknown' };
          }
        }
      }
      // vec/iterator chains: `.iter().map(f).filter(g).collect()` / `.for_each`
      if (base && typeof base === 'object' && base.__rust === 'vec' &&
          (mname === 'iter' || mname === 'into_iter' || mname === 'values' || mname === 'map' || mname === 'filter' || mname === 'collect' || mname === 'for_each' || mname === 'cloned' || mname === 'rev')) {
        if (mname === 'iter' || mname === 'into_iter' || mname === 'values' || mname === 'clone' || mname === 'cloned' || mname === 'rev') {
          var rv2 = mname === 'rev' ? { __rust: 'vec', items: base.items.slice().reverse() } : base;
          if (dotCall.close < toks.length - 1) return finishMethodResult(rv2, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: rv2, type: 'Vec<_>' };
        }
        if (mname === 'collect') {
          if (dotCall.close < toks.length - 1) return finishMethodResult(base, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: base, type: 'Vec<_>' };
        }
        // map / filter / for_each take a closure arg
        var cvt = (margVals.length && margVals[0] && margVals[0].__rust === 'closure') ? margVals[0] : null;
        if (!cvt) {
          if (mname === 'for_each' && margVals.length === 0) { /* nothing */ }
          if (dotCall.close < toks.length - 1) return finishMethodResult(base, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: base, type: 'unknown' };
        }
        var out = [];
        for (var mi = 0; mi < base.items.length && mi < MAX_LOOP; mi++) {
          var r = evalClosureValues(cvt, [{ value: base.items[mi], type: 'unknown' }], env, fns, st);
          if (mname === 'filter') { if (truthy(r.value)) out.push(base.items[mi]); }
          else if (mname === 'for_each') { out = base.items; }
          else out.push(r.value);
        }
        if (mname === 'for_each') return { value: undefined, type: '()' };
        var mv = { __rust: 'vec', items: out };
        if (dotCall.close < toks.length - 1) return finishMethodResult(mv, toks.slice(dotCall.close + 1), env, fns, st);
        return { value: mv, type: 'Vec<_>' };
      }
      var selfStruct = (bval !== null && typeof bval === 'object' && bval.__rust === 'struct') ? bval : null;
      if (selfStruct && st.qns && st.qns[selfStruct.name + '::' + mname]) {
        var qentry = st.qns[selfStruct.name + '::' + mname];
        var qchild = execFnBody(qentry, margs, env, fns, st, { value: selfStruct, type: selfStruct.name });
        if (dotCall.close < toks.length - 1) return finishMethodResult(qchild.value, toks.slice(dotCall.close + 1), env, fns, st);
        return qchild;
      }
      var r = evalMethod(base, mname, margVals);
      return finishMethodResult(r, toks.slice(dotCall.close + 1), env, fns, st);
    }
    // field access: expr.field (no parens — methods handled above)
    var fdot = topFieldDot(toks);
    if (fdot !== -1) {
      var fbase = evalExpr(toks.slice(0, fdot), env, fns, st).value;
      var ff = toks[fdot + 1].v;
      var fvv = (fbase !== null && typeof fbase === 'object' && fbase.__rust === 'struct' &&
        Object.prototype.hasOwnProperty.call(fbase.fields, ff)) ? fbase.fields[ff] : 0;
      var frest = toks.slice(fdot + 2);
      if (!frest.length) return { value: fvv, type: 'unknown' };
      return finishMethodResult(fvv, frest, env, fns, st);
    }
    // unary: ! - &
    if (toks[0].v === '!') return { value: truthy(evalExpr(toks.slice(1), env, fns, st).value) ? false : true, type: 'bool' };
    if (toks[0].v === '-' && toks.length > 1) {
      var iv = evalExpr(toks.slice(1), env, fns, st);
      return { value: -num(iv.value), type: iv.type };
    }
    if (toks[0].v === '&') return evalExpr(toks.slice(1), env, fns, st);

    // parens
    if (toks[0].v === '(' && matchTok(toks, 0, '(', ')') === toks.length - 1) {
      var inner10 = toks.slice(1, -1);
      var hasComma = topIndex(inner10, ',');
      if (hasComma !== -1) {
        var tps = splitArgs(inner10).filter(function (x) { return x.length; });
        return { value: { __rust: 'vec', items: tps.map(function (x) { return evalExpr(x, env, fns, st).value; }) }, type: 'tuple' };
      }
      // `()` unit
      if (!inner10.length) return { value: 0, type: '()' };
      return evalExpr(inner10, env, fns, st);
    }

    // literals / var
    if (toks.length === 1) {
      var s = toks[0];
      if (s.t === T.NUMBER) return { value: parseRustNum(s.v), type: 'i32' };
      if (s.t === T.STRING || s.t === T.RAWSTR) return { value: unquote(s), type: '&str' };
      if (s.t === T.BYTESTR) { var br2 = s.v.slice(2, s.v.length - 1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\0/g, '\0'); return { value: { __rust: 'bytes', raw: br2 }, type: '&[u8]' }; }
      if (s.t === T.CHAR) return { value: unquoteChar(s.v), type: 'char' };
      if (s.t === T.IDENT) {
        if (s.v === 'true') return { value: true, type: 'bool' };
        if (s.v === 'false') return { value: false, type: 'bool' };
        if (s.v === 'None') return { value: { __rust: 'option', some: false }, type: 'unknown' };
        if (env[s.v] !== undefined) return env[s.v];
        return { value: 0, type: 'unknown' };
      }
    }
    // binary ops (lowest precedence split)
    var bi = topBinOp(toks);
    if (bi !== -1) {
      var L = evalExpr(toks.slice(0, bi), env, fns, st).value;
      var OP = toks[bi].v;
      var R = evalExpr(toks.slice(bi + 1), env, fns, st).value;
      return { value: applyOp(L, OP, R), type: 'unknown' };
    }
    // range a..b as value? represent as vec
    var ri = topIndex(toks, '..');
    if (ri !== -1) {
      var a2 = Math.floor(num(evalExpr(toks.slice(0, ri), env, fns, st).value));
      var rest = toks.slice(ri + 1);
      var incl = false;
      if (rest.length && rest[0].v === '=') { incl = true; rest = rest.slice(1); }
      var b2 = Math.floor(num(evalExpr(rest, env, fns, st).value));
      var lo = Math.min(a2, b2), hi2 = incl ? b2 + 1 : b2, rr = [];
      for (var q2 = lo; q2 < hi2 && rr.length < MAX_LOOP; q2++) rr.push(q2);
      return { value: { __rust: 'vec', items: rr }, type: 'Vec<_>' };
    }
    // fallback: first token value
    if (toks[0].t === T.IDENT && env[toks[0].v] !== undefined) return env[toks[0].v];
    return { value: 0, type: 'unknown' };
  }

  function evalBinOp(left, restToks, env, fns, st) {
    // restToks starts with binop
    if (!restToks.length) return left;
    var op = restToks[0].v;
    var rhs = evalExpr(restToks.slice(1), env, fns, st).value;
    return { value: applyOp(left.value, op, rhs), type: 'unknown' };
  }

  function isBinOp(t) {
    return t && t.t === T.SYMBOL && (t.v === '+' || t.v === '-' || t.v === '*' || t.v === '/' || t.v === '%' || t.v === '==' || t.v === '!=' || t.v === '<' || t.v === '>' || t.v === '<=' || t.v === '>=' || t.v === '&&' || t.v === '||');
  }

  function topBinOp(toks) {
    // precedence: || -> && -> ==/!=/</>/<=/>= -> +,- -> *,/,%
    var levels = [['||'], ['&&'], ['==', '!=', '<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];
    for (var l = 0; l < levels.length; l++) {
      var d = 0, found = -1;
      for (var i = toks.length - 1; i >= 0; i--) {
        var v = toks[i].v;
        if (v === ')' || v === ']' || v === '}') d++;
        else if (v === '(' || v === '[' || v === '{') d--;
        else if (d === 0 && levels[l].indexOf(v) !== -1) {
          // avoid `<` of generics / `->`? we only split on spaced ops; keep simple
          found = i; break;
        }
      }
      if (found !== -1) return found;
    }
    return -1;
  }

  // IDENT (:: IDENT)+ with nothing else -> path value (enums, consts)
  function isPathValue(toks) {
    if (toks.length < 3 || (toks.length % 2) !== 1) return false;
    for (var i = 0; i < toks.length; i++) {
      if (i % 2 === 0) { if (toks[i].t !== T.IDENT) return false; }
      else if (toks[i].v !== '::') return false;
    }
    return true;
  }

  // first `.` at depth 0 shaped like `.field` (not `.method(`)
  function topFieldDot(toks) {
    var d = 0;
    for (var i = 0; i < toks.length; i++) {
      var v = toks[i].v;
      if (v === '(' || v === '[' || v === '{') d++;
      else if (v === ')' || v === ']' || v === '}') d--;
      else if (d === 0 && v === '.' && toks[i + 1] && toks[i + 1].t === T.IDENT &&
               (!toks[i + 2] || toks[i + 2].v !== '(')) return i;
    }
    return -1;
  }

  function topIndex(toks, op) {    var d = 0;
    for (var i = 0; i < toks.length; i++) {
      var v = toks[i].v;
      if (v === '(' || v === '[' || v === '{') d++;
      else if (v === ')' || v === ']' || v === '}') d--;
      else if (d === 0 && v === op) return i;
    }
    return -1;
  }

  function applyOp(L, OP, R) {
    switch (OP) {
      case '+': return (typeof L === 'string' || typeof R === 'string') ? String(L) + String(R) : num(L) + num(R);
      case '-': return num(L) - num(R);
      case '*': return num(L) * num(R);
      case '/': return num(R) === 0 ? 0 : num(L) / num(R);
      case '%': return num(R) === 0 ? 0 : num(L) % num(R);
      case '==': return rustToString(L) === rustToString(R);
      case '!=': return rustToString(L) !== rustToString(R);
      case '<': return num(L) < num(R);
      case '>': return num(L) > num(R);
      case '<=': return num(L) <= num(R);
      case '>=': return num(L) >= num(R);
      case '&&': return truthy(L) && truthy(R);
      case '||': return truthy(L) || truthy(R);
      default: return R;
    }
  }

  function parseRustNum(s) {
    var t = String(s).replace(/_/g, '');
    var m = t.match(/^(0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+|\d+\.?\d*(?:[eE][+-]?\d+)?)/);
    var core = m ? m[1] : t;
    if (/^0x/i.test(core)) return parseInt(core.slice(2), 16);
    if (/^0o/i.test(core)) return parseInt(core.slice(2), 8);
    if (/^0b/i.test(core)) return parseInt(core.slice(2), 2);
    var f = parseFloat(core);
    return isNaN(f) ? 0 : f;
  }

  function unquoteChar(s) {
    var inner = s.slice(1, s.length - 1);
    if (inner[0] === '\\') {
      if (inner[1] === 'n') return '\n';
      if (inner[1] === 't') return '\t';
      if (inner[1] === 'r') return '\r';
      if (inner[1] === '0') return '\0';
      return inner[1] || '';
    }
    return inner;
  }

  function findMethodCall(toks) {
    // find `.` ident `(` at depth 0
    var d = 0;
    for (var i = 0; i < toks.length; i++) {
      var v = toks[i].v;
      if (v === '(' || v === '[' || v === '{') d++;
      else if (v === ')' || v === ']' || v === '}') d--;
      else if (d === 0 && v === '.' && toks[i + 1] && toks[i + 1].t === T.IDENT && toks[i + 2] && toks[i + 2].v === '(') {
        return { dot: i, open: i + 2, close: matchTok(toks, i + 2, '(', ')') };
      }
    }
    return null;
  }

  function evalMethod(base, mname, margVals) {
    if (mname === 'to_string' || mname === 'to_owned') return rustToString(base);
    if (mname === 'len') {
      if (base !== null && typeof base === 'object' && base.__rust === 'vec') return base.items.length;
      if (typeof base === 'string') return base.length;
      return 0;
    }
    if (mname === 'is_empty') {
      if (base !== null && typeof base === 'object' && base.__rust === 'vec') return base.items.length === 0;
      if (typeof base === 'string') return base.length === 0;
      return true;
    }
    if (mname === 'contains') return String(base).indexOf(String(margVals[0] || '')) !== -1;
    if (mname === 'parse') { var n = parseFloat(base); return { __rust: 'result', ok: !isNaN(n), value: isNaN(n) ? base : n }; }
    if (mname === 'abs') return Math.abs(num(base));
    if (mname === 'map_err') return base;
    if (mname === 'unwrap' || mname === 'expect') {
      if (base !== null && typeof base === 'object' && base.__rust === 'result') { if (base.ok) return base.value; throw { __frsTryErr: true, value: base.value }; }
      if (base !== null && typeof base === 'object' && base.__rust === 'option') { if (base.some) return base.value; return undefined; }
      return base;
    }
    if (mname === 'unwrap_or' || mname === 'unwrap_or_else') {
      if (base !== null && typeof base === 'object' && base.__rust === 'result') return base.ok ? base.value : (typeof margVals[0] === 'object' && margVals[0] && margVals[0].__rust === 'closure' ? evalClosureValues(margVals[0], [], {}, {}, { steps: 0 }).value : margVals[0]);
      return base;
    }
    if (mname === 'is_ok') return !!(base && base.__rust === 'result' && base.ok);
    if (mname === 'is_err') return !!(base && base.__rust === 'result' && !base.ok);
    if (mname === 'is_some') return !!(base && base.__rust === 'option' && base.some);
    if (mname === 'is_none') return !!(base && base.__rust === 'option' && !base.some);
    if (mname === 'lock' || mname === 'read' || mname === 'try_lock' || mname === 'write') return base;
    if (mname === 'flush') return base;
    if (mname === 'trim') return String(base).trim();
    if (mname === 'trim_end') return String(base).replace(/\s+$/, '');
    if (mname === 'to_lowercase') return String(base).toLowerCase();
    if (mname === 'to_uppercase') return String(base).toUpperCase();
    if (mname === 'as_str') return rustToString(base);
    if (mname === 'as_secs') return base;
    if (mname === 'as_bytes') return { __rust: 'bytes', raw: rustToString(base) };
    if (mname === 'starts_with') return String(base).indexOf(String(margVals[0] || '')) === 0;
    if (mname === 'ends_with') { var es = String(base); var ew = String(margVals[0] || ''); return es.slice(es.length - ew.length) === ew; }
    if (mname === 'push_str') return base;
    if (mname === 'get' && base !== null && typeof base === 'object' && base.__rust === 'vec') {
      var gi = margVals[0] | 0;
      return gi >= 0 && gi < base.items.length ? base.items[gi] : 0;
    }
    if (mname === 'into') return rustToString(base) && base;
    if (mname === 'split') { var p = base.split(String(margVals[0] || ',')); return { __rust: 'vec', items: p }; }
    if (mname === 'split_whitespace') { var q = String(base).split(/\s+/).filter(Boolean); return { __rust: 'vec', items: q }; }
    if (mname === 'join') {
      if (base !== null && typeof base === 'object' && base.__rust === 'vec') {
        var sep = margVals.length ? String(margVals[0]) : '';
        return base.items.map(function (x) { return rustToString(x); }).join(sep);
      }
      return '';
    }
    if (mname === 'push' && base !== null && typeof base === 'object' && base.__rust === 'vec') { base.items.push(margVals[0]); return base; }
    if (mname === 'insert') {
      if (base !== null && typeof base === 'object' && base.__rust === 'vec') { base.items.push(margVals.length === 2 ? margVals[1] : margVals[0]); return base; }
      return base;
    }
    if (mname === 'send' || mname === 'recv' || mname === 'try_recv') {
      if (mname === 'try_recv') return { __rust: 'result', ok: false, value: 'empty' };
      return base;
    }
    if (mname === 'get' && typeof base === 'number') return base;
    if (mname === 'set') return base;
    return base;
  }

  function throwFrsTry(v) { throw { __frsTryErr: true, value: v }; }

  function evalClosureValues(cv, argVals, env, fns, st) {
    var cchild = Object.create(env);
    for (var cp = 0; cp < cv.params.length; cp++) {
      cchild[cv.params[cp]] = cp < argVals.length ? argVals[cp] : { value: 0, type: 'unknown' };
    }
    try { return evalExpr(cv.body.slice(), cchild, fns, st); }
    catch (e2) {
      if (e2 && e2.__frsReturn) return { value: e2.value ? e2.value.value : 0, type: 'unknown' };
      throw e2;
    }
  }

  function evalClosure(cv, cparts, env, fns, st) {
    var cchild = Object.create(env);
    for (var cp2 = 0; cp2 < cv.params.length; cp2++) {
      cchild[cv.params[cp2]] = (cp2 < cparts.length && cparts[cp2].length)
        ? evalExpr(cparts[cp2], env, fns, st) : { value: 0, type: 'unknown' };
    }
    try { return evalExpr(cv.body.slice(), cchild, fns, st); }
    catch (e2) {
      if (e2 && e2.__frsReturn) return { value: e2.value ? e2.value.value : 0, type: 'unknown' };
      throw e2;
    }
  }

  function callFn(name, argToks, env, fns, st, tk) {
    var fn = fns[name];
    if (!fn) {
      // closure variable? `let f = |x| ...; f(1)`
      var ev = (env !== null && typeof env === 'object' && env[name] !== undefined) ? env[name] : null;
      var cv = ev && ev.value && ev.value.__rust === 'closure' ? ev.value
        : (ev && ev.__rust === 'closure' ? ev : null);
      if (cv) return evalClosure(cv, splitArgs(argToks), env, fns, st);
      // unknown fn: evaluate args for side effects, return 0
      var parts = splitArgs(argToks);
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].length) { try { evalExpr(parts[i], env, fns, st); } catch (e) { if (e && e.__frsPanic) throw e; } }
      }
      return { value: 0, type: 'unknown' };
    }
    return execFnBody(fn, argToks, env, fns, st);
  }

  // qualified path call: Type::method(args) — exact impl match, else builtin/lenient
  function callPath(typeName, methodName, argToks, env, fns, qns, st, tk) {
    var q = qns[typeName + '::' + methodName];
    if (q) return execFnBody(q, argToks, env, fns, st);
    // real file/socket I/O backed by Node fs/net (when available)
    if (FS_X) {
      if (typeName === 'File' || typeName === 'OpenOptions') {
        var nva = splitArgs(argToks).filter(function (a) { return a.length; });
        var p0 = nva.length ? evalExpr(nva[0], env, fns, st).value : '';
        if (methodName === 'create') {
          try { var wfd = FS_X.openSync(String(p0), 'w'); openFds.push(wfd); return { value: { __rust: 'file', _fd: wfd, path: String(p0) }, type: 'File' }; }
          catch (e2) { return { value: { __rust: 'result', ok: false, value: String(e2.message || e2) }, type: 'Result<File,Error>' }; }
        }
        if (methodName === 'open') {
          try { var rfd = FS_X.openSync(String(p0), 'r'); openFds.push(rfd); return { value: { __rust: 'file', _fd: rfd, path: String(p0) }, type: 'File' }; }
          catch (e2) { return { value: { __rust: 'result', ok: false, value: String(e2.message || e2) }, type: 'Result<File,Error>' }; }
        }
      }
      if (typeName === 'fs') {
        var fsva = splitArgs(argToks).filter(function (a) { return a.length; });
        var fp = fsva.length ? evalExpr(fsva[0], env, fns, st).value : '';
        try {
          if (methodName === 'read_to_string') return { value: { __rust: 'result', ok: true, value: FS_X.readFileSync(String(fp), 'utf8') }, type: 'Result' };
          if (methodName === 'write') { FS_X.writeFileSync(String(fp), rustToString(evalExpr(fsva[1] || [], env, fns, st).value)); return { value: { __rust: 'result', ok: true, value: 0 }, type: 'Result' }; }
          if (methodName === 'remove_file') { FS_X.unlinkSync(String(fp)); return { value: { __rust: 'result', ok: true, value: 0 }, type: 'Result' }; }
        } catch (e3) { return { value: { __rust: 'result', ok: false, value: String(e3.message || e3) }, type: 'Result' }; }
      }
      if (typeName === 'TcpListener' && methodName === 'bind') {
        var bindArgs = splitArgs(argToks).filter(function (a) { return a.length; });
        var bindAddr = bindArgs.length ? rustToString(evalExpr(bindArgs[0], env, fns, st).value) : '127.0.0.1:0';
        if (!NET_X) return { value: { __rust: 'result', ok: false, value: 'net unavailable' }, type: 'Result' };
        try {
          var portM = /:(\d+)$/.exec(bindAddr);
          var netSrv = NET_X.createServer();
          netSrv.listen(portM ? parseInt(portM[1], 10) : 0, bindAddr.replace(/:[0-9]+$/, '') || undefined);
          TCP_SRVS.push(netSrv);
          return { value: { __rust: 'tcplistener', _srv: netSrv }, type: 'TcpListener' };
        } catch (eN) { return { value: { __rust: 'result', ok: false, value: String(eN.message || eN) }, type: 'Result' }; }
      }
      if (typeName === 'BufReader' && methodName === 'new') {
        var brows = splitArgs(argToks).filter(function (a) { return a.length; });
        var brv = brows.length ? evalExpr(brows[0], env, fns, st).value : null;
        var pfd = (brv !== null && typeof brv === 'object' && brv.__rust === 'file') ? brv._fd : null;
        var ppath = (brv !== null && typeof brv === 'object' && brv.__rust === 'file') ? brv.path : null;
        return { value: { __rust: 'bufreader', _fd: pfd, _path: ppath }, type: 'BufReader<File>' };
      }
      if (typeName === 'io' && methodName === 'stdin') return { value: { __rust: 'stdin' }, type: 'Stdin' };
      if (typeName === 'io' && methodName === 'stdout') return { value: { __rust: 'stdout' }, type: 'Stdout' };
    }
    if (typeName === 'OpenOptions' && methodName === 'new') {
      return { value: { __rust: 'openoptions', _append: false, _truncate: false }, type: 'OpenOptions' };
    }
    if (typeName === 'String' && (methodName === 'from_utf8_lossy' || methodName === 'from_utf8' || methodName === 'from_utf8_unchecked')) {
      var fa = splitArgs(argToks).filter(function (a) { return a.length; });
      if (fa.length) {
        var fv = evalExpr(fa[0], env, fns, st).value;
        var chars = '';
        if (fv !== null && typeof fv === 'object' && fv.__rust === 'vec') {
          chars = fv.items.map(function (x) { return String.fromCharCode(x); }).join('');
        } else if (fv !== null && typeof fv === 'object' && fv.__rust === 'bytes') {
          chars = fv.raw;
        } else {
          chars = rustToString(fv);
        }
        return { value: chars, type: 'Cow<str>' };
      }
      return { value: '', type: 'Cow<str>' };
    }
    if (methodName === 'new') {
      if (typeName === 'Vec' || typeName === 'VecDeque') {
        return { value: { __rust: 'vec', items: [] }, type: 'Vec<_>' };
      }
      if (typeName === 'String') return { value: '', type: 'String' };
      if (typeName === 'HashMap' || typeName === 'BTreeMap' || typeName === 'HashSet') {
        return { value: { __rust: 'vec', items: [] }, type: typeName };
      }
      // std wrapper types: Cell/Mutex/RwLock/Atomic*/RefCell/OnceLock -> adopt first arg
      var newArgs = splitArgs(argToks).filter(function (a) { return a.length; });
      if (newArgs.length) {
        try { return evalExpr(newArgs[0], env, fns, st); } catch (e) { /* fall */ }
      }
      return { value: 0, type: 'unknown' };
    }
    if (methodName === 'from' && typeName === 'String') {
      var fargs = splitArgs(argToks).filter(function (a) { return a.length; });
      if (fargs.length) { try { return { value: rustToString(evalExpr(fargs[0], env, fns, st).value), type: 'String' }; } catch (e) {} }
    }
    if (methodName === 'from' && typeName === 'Value') return { value: 0, type: 'Value' };
    var f = fns[methodName];
    if (f && !f.impl) return execFnBody(f, argToks, env, fns, st);
    var parts = splitArgs(argToks);
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].length) { try { evalExpr(parts[i], env, fns, st); } catch (e) { if (e && e.__frsPanic) throw e; } }
    }
    return { value: 0, type: 'unknown' };
  }

  function execFnBody(fn, argToks, env, fns, st, selfVal) {
    var parts2 = splitArgs(argToks);
    var child = Object.create(env);
    var hasSelf = fn.params.length && fn.params[0] === 'self';
    var pStart = 0, argOff = 0;
    if (hasSelf) {
      child['self'] = selfVal !== undefined ? selfVal : (parts2.length && parts2[0].length ? evalExpr(parts2[0], env, fns, st) : { value: 0, type: 'unknown' });
      pStart = 1;
      argOff = selfVal !== undefined ? 1 : 0;
    }
    for (var p = pStart; p < fn.params.length; p++) {
      var ai = p - (hasSelf ? 1 : 0) + (hasSelf ? (selfVal !== undefined ? 0 : 1) : 0);
      var pv = (ai >= 0 && ai < parts2.length && parts2[ai].length) ? evalExpr(parts2[ai], env, fns, st) : { value: 0, type: 'unknown' };
      child[fn.params[p]] = pv;
    }
    var O3 = st.stdout || { push: function () { } };
    var E3 = st.stderr || { push: function () { } };
    // Rust implicit tail return: last statement without `;` is the value.
    var body2 = fn.bodyToks;
    var ls2 = findStmtStart(body2);
    var tail2 = body2.slice(ls2);
    var head2 = body2.slice(0, ls2);
    var tailIsStmt = tail2.length > 0 && tail2[0].t === T.IDENT &&
      (tail2[0].v === 'let' || tail2[0].v === 'for' || tail2[0].v === 'while' ||
       tail2[0].v === 'loop' || tail2[0].v === 'return' || tail2[0].v === 'fn' ||
       tail2[0].v === 'break' || tail2[0].v === 'continue' ||
       tail2[0].v === 'struct' || tail2[0].v === 'use');
    if (tail2.length >= 2 && tail2[0].t === T.IDENT && tail2[1].v === '!' &&
        tail2[0].v !== 'format' && tail2[0].v !== 'vec') tailIsStmt = true;
    try {
      execBlock(head2, child, fns, O3, E3, st);
      if (!tail2.length || tailIsStmt) {
        if (tail2.length) execBlock(tail2, child, fns, O3, E3, st);
        return { value: 0, type: 'unknown' };
      }
      var tr = evalExpr(tail2, child, fns, st);
      if (tr && tr.value && tr.value.__rust === 'struct' && tr.value.name === 'Self' && fn.implT) tr.value.name = fn.implT;
      return tr;
    } catch (e) {
      if (e && e.__frsReturn) return { value: e.value ? e.value.value : 0, type: 'unknown' };
      if (e && e.__frsTryErr) return { value: { __rust: 'result', ok: false, value: e.value }, type: 'unknown' };
      throw e;
    }
  }

  function evalStmtExpr(toks, i, env, fns, st) {
    var stmt = sliceStmt(toks, i);
    return evalExpr(stmt.toks, env, fns, st);
  }

  function findStmtStart(inner) {
    // find start of last `;`-separated statement
    var d = 0;
    for (var i = inner.length - 1; i >= 0; i--) {
      var v = inner[i].v;
      if (v === ')' || v === ']' || v === '}') d++;
      else if (v === '(' || v === '[' || v === '{') d--;
      else if (d === 0 && v === ';') return i + 1;
    }
    return 0;
  }

  // ---- if ----
  function condValue(toks, env, fns, st) {
    // `if/while let PAT = expr` — destructure (binds) and test
    if (toks.length >= 2 && toks[0].t === T.IDENT && toks[0].v === 'let') {
      var eq = -1, ed = 0;
      for (var i = 1; i < toks.length; i++) {
        var w = toks[i].v;
        if (w === '(' || w === '[' || w === '{') ed++;
        else if (w === ')' || w === ']' || w === '}') ed--;
        else if (w === '=' && ed === 0) { eq = i; break; }
      }
      if (eq !== -1) {
        var rhs;
        try { rhs = evalExpr(toks.slice(eq + 1), env, fns, st).value; }
        catch (e) { if (e && e.__frsPanic) throw e; rhs = 0; }
        try { return matchPat(toks.slice(1, eq), rhs, env); }
        catch (e2) { if (e2 && e2.__frsPanic) throw e2; return false; }
      }
    }
    return truthy(evalExpr(toks, env, fns, st).value);
  }

  function execIf(toks, i, env, fns, stdout, stderr, st) {
    var n = toks.length, k = i + 1, d = 0, q = k, thenOpen = -1;
    while (q < n) {
      var v = toks[q].v;
      if (v === '(' || v === '[') d++;
      else if (v === ')' || v === ']') d--;
      else if (v === '{' && d === 0) { thenOpen = q; break; }
      else if (v === ';' && d === 0) break;
      q++;
      if (q - k > 200) break;
    }
    if (thenOpen === -1) return Math.min(n, k + 1);
    var condToks = toks.slice(k, thenOpen);
    var thenEnd = matchTok(toks, thenOpen, '{', '}');
    if (thenEnd === -1) thenEnd = n - 1;
    var thenBody = toks.slice(thenOpen + 1, thenEnd);
    var after = thenEnd + 1;
    // else / else if chain
    var elseBody = null, elseIf = null;
    if (toks[after] && toks[after].v === 'else') {
      if (toks[after + 1] && toks[after + 1].v === 'if') {
        // else if: recurse as nested if at `after+1`
        var sub = execIfChain(toks, after + 1, env, fns, stdout, stderr, st);
        // decide branch
        var c;
        try { c = condValue(condToks, env, fns, st); } catch (e) { if (e && e.__frsPanic) throw e; c = false; }
        if (c) execBlock(thenBody, env, fns, stdout, stderr, st);
        else { /* else-if already executed inside sub? no — run it now */ execIf(toks, after + 1, env, fns, stdout, stderr, st); }
        return sub.next;
      } else if (toks[after + 1] && toks[after + 1].v === '{') {
        var ee = matchTok(toks, after + 1, '{', '}');
        if (ee === -1) ee = n - 1;
        elseBody = toks.slice(after + 2, ee);
        after = ee + 1;
      }
    }
    var c2;
    try { c2 = condValue(condToks, env, fns, st); } catch (e2) { if (e2 && e2.__frsPanic) throw e2; c2 = false; }
    try {
      if (c2) execBlock(thenBody, env, fns, stdout, stderr, st);
      else if (elseBody) execBlock(elseBody, env, fns, stdout, stderr, st);
    } catch (e3) {
      if (e3 && (e3.__frsBreak || e3.__frsContinue || e3.__frsReturn || e3.__frsPanic)) throw e3;
    }
    return after;
  }

  function execIfChain(toks, i, env, fns, stdout, stderr, st) {
    // returns {next} — helper for else-if scanning
    var n = toks.length, k = i + 1, d = 0, q = k, thenOpen = -1;
    while (q < n) {
      var v = toks[q].v;
      if (v === '(' || v === '[') d++;
      else if (v === ')' || v === ']') d--;
      else if (v === '{' && d === 0) { thenOpen = q; break; }
      q++;
      if (q - k > 200) break;
    }
    if (thenOpen === -1) return { next: Math.min(n, k + 1) };
    var thenEnd = matchTok(toks, thenOpen, '{', '}');
    if (thenEnd === -1) return { next: n };
    var after = thenEnd + 1;
    if (toks[after] && toks[after].v === 'else') {
      if (toks[after + 1] && toks[after + 1].v === '{') {
        var ee = matchTok(toks, after + 1, '{', '}');
        after = ee === -1 ? n : ee + 1;
      } else if (toks[after + 1] && toks[after + 1].v === 'if') {
        after = execIfChain(toks, after + 1, env, fns, stdout, stderr, st).next;
      }
    }
    return { next: after };
  }

  function evalIfExpr(toks, env, fns, st) {
    // execute the taken branch, value = branch tail expression
    var n = toks.length, k = 1, d = 0, q = k, thenOpen = -1;
    while (q < n) {
      var v = toks[q].v;
      if (v === '(' || v === '[') d++;
      else if (v === ')' || v === ']') d--;
      else if (v === '{' && d === 0) { thenOpen = q; break; }
      q++;
    }
    if (thenOpen === -1) return 0;
    var condToks = toks.slice(1, thenOpen);
    var thenEnd = matchTok(toks, thenOpen, '{', '}');
    if (thenEnd === -1) return 0;
    var c = false;
    try { c = condValue(condToks, env, fns, st); } catch (e) { c = false; }
    var branch = c ? toks.slice(thenOpen, thenEnd + 1) : null;
    var after = thenEnd + 1;
    if (!c && toks[after] && toks[after].v === 'else') {
      if (toks[after + 1] && toks[after + 1].v === '{') {
        var ee = matchTok(toks, after + 1, '{', '}');
        branch = toks.slice(after + 1, (ee === -1 ? n - 1 : ee) + 1);
      } else if (toks[after + 1] && toks[after + 1].v === 'if') {
        return evalIfExpr(toks.slice(after + 1), env, fns, st);
      }
    }
    if (!branch) return 0;
    var r = evalExpr(branch, env, fns, st);
    return r.value;
  }

  // ---- for ----
  function execFor(toks, i, env, fns, stdout, stderr, st) {
    var n = toks.length;
    // for pat in expr { body }
    var k = i + 1, d = 0, q = k, inIdx = -1, open = -1;
    while (q < n) {
      var v = toks[q].v;
      if (v === '(' || v === '[') d++;
      else if (v === ')' || v === ']') d--;
      else if (d === 0 && toks[q].t === T.IDENT && toks[q].v === 'in') { inIdx = q; }
      else if (d === 0 && v === '{') { open = q; break; }
      else if (d === 0 && v === ';') break;
      q++;
      if (q - k > 200) break;
    }
    if (inIdx === -1 || open === -1) return Math.min(n, i + 2);
    var patToks = toks.slice(k, inIdx);
    var iterToks = toks.slice(inIdx + 1, open);
    var end = matchTok(toks, open, '{', '}');
    if (end === -1) end = n - 1;
    var body = toks.slice(open + 1, end);
    var varName = patToks.length ? patToks[patToks.length - 1].v : '_';
    if (patToks[0] && patToks[0].v === 'mut' && patToks[1]) varName = patToks[1].v;
    var iterVal;
    try { iterVal = evalExpr(iterToks.slice(), env, fns, st).value; }
    catch (e) { if (e && e.__frsPanic) throw e; iterVal = []; }
    // real socket incoming loop (continuous server, pure Node.js net)
    if (iterVal !== null && typeof iterVal === 'object' && iterVal.__rust === 'tcpincoming' && NET_X) {
      NET_LISTENING = true;
      var srvListen = iterVal._srv;
      try {
        srvListen.on('error', function (eL2) {
          try { if (typeof process !== 'undefined' && process.stderr) process.stderr.write('error: failed to bind listener: ' + (eL2 && eL2.message || eL2) + '\n'); } catch (eI) {}
        });
        srvListen.on('connection', function (sock) {
          var conn = { __rust: 'tcpstream', _sock: sock, _chunk: Buffer.alloc(0) };
          try { sock.setNoDelay && sock.setNoDelay(true); } catch (eN) {}
          // one Rust `for stream in listener.incoming()` iteration == one connection.
          // use `once` so a chunked request is handled exactly once, then close
          // (mimics Rust dropping `stream` at end of loop body).
          sock.once('data', function (d) {
            conn._chunk = d;
            var child = Object.create(env);
            child[varName] = { value: { __rust: 'result', ok: true, value: conn }, type: 'unknown' };
            var outMark = stdout.length, errMark = stderr.length;
            try { execBlock(body, child, fns, stdout, stderr, st); }
            catch (eS) { if (eS && eS.__frsPanic && process.stderr) { try { process.stderr.write('thread panicked: ' + eS.msg + '\n'); } catch (eW) {} } }
            // live-flush any println!/eprintln! from this hit (run() already returned)
            try {
              if (typeof process !== 'undefined') {
                if (stdout.length > outMark && process.stdout) process.stdout.write(stdout.slice(outMark).join(''));
                if (stderr.length > errMark && process.stderr) process.stderr.write(stderr.slice(errMark).join(''));
              }
            } catch (eF) {}
            // finish HTTP hit: flush socket write then end (so curl/browser completes)
            try { sock.end(); } catch (eE) {}
            try { setTimeout(function () { try { sock.destroy(); } catch (eD) {} }, 2000); } catch (eT) {}
          });
          sock.on('error', function () {});
        });
      } catch (eL) {}
      return end + 1;
    }
    var items = toItems(iterVal);
    var had = Object.prototype.hasOwnProperty.call(env, varName);
    var saved = env[varName];
    for (var j = 0; j < items.length && j < MAX_LOOP; j++) {
      if (varName !== '_') env[varName] = { value: items[j], type: 'unknown' };
      try { execBlock(body, env, fns, stdout, stderr, st); }
      catch (e2) {
        if (e2 && e2.__frsBreak) break;
        if (e2 && e2.__frsContinue) continue;
        if (e2 && (e2.__frsReturn || e2.__frsPanic)) throw e2;
      }
    }
    if (!had) delete env[varName]; else env[varName] = saved;
    return end + 1;
  }

  function toItems(v) {
    if (v !== null && typeof v === 'object' && v.__rust === 'vec') return v.items.slice();
    if (typeof v === 'number') { var r = []; for (var i = 0; i < v && i < MAX_LOOP; i++) r.push(i); return r; }
    if (typeof v === 'string') return v.split('');
    return [];
  }

  // ---- while / loop ----
  function execWhile(toks, i, env, fns, stdout, stderr, st) {
    var isLoop = toks[i].v === 'loop';
    var n = toks.length, open = -1, q = i + 1, d = 0;
    while (q < n) {
      var v = toks[q].v;
      if (v === '(' || v === '[') d++;
      else if (v === ')' || v === ']') d--;
      else if (v === '{' && d === 0) { open = q; break; }
      else if (v === ';' && d === 0) break;
      q++;
      if (q - i > 200) break;
    }
    if (open === -1) return Math.min(n, i + 2);
    var condToks = isLoop ? [] : toks.slice(i + 1, open);
    var end = matchTok(toks, open, '{', '}');
    if (end === -1) end = n - 1;
    var body = toks.slice(open + 1, end);
    var iter = 0;
    while (iter++ < MAX_LOOP) {
      var c = true;
      if (!isLoop) { try { c = condValue(condToks, env, fns, st); } catch (e) { if (e && e.__frsPanic) throw e; c = false; } }
      if (!c) break;
      try { execBlock(body, env, fns, stdout, stderr, st); }
      catch (e2) {
        if (e2 && e2.__frsBreak) break;
        if (e2 && e2.__frsContinue) continue;
        if (e2 && (e2.__frsReturn || e2.__frsPanic)) throw e2;
      }
      if (isLoop && iter >= MAX_LOOP) break;
    }
    return end + 1;
  }

  // ---- match (simple: literal/ident/_ arms, `=>` expr or block) ----
  function execMatch(toks, i, env, fns, stdout, stderr, st) {
    var res = matchRun(toks, i, env, fns, st);
    try {
      if (res.armBody) execBlock(res.armBody, env, fns, stdout, stderr, st);
    } catch (e) {
      if (e && (e.__frsBreak || e.__frsContinue || e.__frsReturn || e.__frsPanic)) throw e;
    }
    return res.next;
  }

  function evalMatchExpr(toks, env, fns, st) {
    var res = matchRun(toks, 0, env, fns, st);
    if (!res.armBody) return 0;
    // arm body: `expr ,` or `{...}` — eval tail
    var body = res.armBody.slice();
    while (body.length && (body[body.length - 1].v === ',')) body = body.slice(0, -1);
    if (!body.length) return 0;
    try {
      if (body[0].v === '{' && matchTok(body, 0, '{', '}') === body.length - 1) {
        return evalExpr(body, env, fns, st).value;
      }
      return evalExpr(body, env, fns, st).value;
    } catch (e) { return 0; }
  }

  function matchRun(toks, i, env, fns, st) {
    var n = toks.length, q = i + 1, d = 0, open = -1;
    while (q < n) {
      var v = toks[q].v;
      if (v === '(' || v === '[') d++;
      else if (v === ')' || v === ']') d--;
      else if (v === '{' && d === 0) { open = q; break; }
      else if (v === ';' && d === 0) break;
      q++;
      if (q - i > 200) break;
    }
    if (open === -1) return { next: Math.min(n, i + 2), armBody: null };
    var scrut = toks.slice(i + 1, open);
    var end = matchTok(toks, open, '{', '}');
    if (end === -1) return { next: n, armBody: null };
    var svalRaw = 0;
    try { svalRaw = evalExpr(scrut.slice(), env, fns, st).value; } catch (e) { svalRaw = 0; }
    // split arms by top-level `=>`
    var inner = toks.slice(open + 1, end);
    var arms = [];
    var depth = 0, cur = [], arrow = -1;
    // first split by `,` at depth 0 where depth counts braces (arm bodies with blocks contain no top comma issue — handle by scanning `=>`)
    var k = 0;
    while (k < inner.length) {
      if (inner[k].v === '(' || inner[k].v === '[' || inner[k].v === '{') depth++;
      else if (inner[k].v === ')' || inner[k].v === ']' || inner[k].v === '}') depth--;
      else if (depth === 0 && inner[k].v === '=>') {
        var pat = cur; cur = [];
        // body: until `,` at depth 0 or end
        var bd = 0, bstart = k + 1, bend = -1;
        for (var j = k + 1; j < inner.length; j++) {
          var w = inner[j].v;
          if (w === '(' || w === '[' || w === '{') bd++;
          else if (w === ')' || w === ']' || w === '}') bd--;
          else if (bd === 0 && w === ',') { bend = j; break; }
        }
        var body = bend === -1 ? inner.slice(bstart) : inner.slice(bstart, bend);
        arms.push({ pat: pat, body: body });
        cur = [];
        k = bend === -1 ? inner.length : bend + 1;
        continue;
      }
      cur.push(inner[k]);
      k++;
    }
    for (var a = 0; a < arms.length; a++) {
      try {
        if (matchPat(arms[a].pat, svalRaw, env)) {
          return { next: end + 1, armBody: arms[a].body };
        }
      } catch (e2) { if (e2 && e2.__frsPanic) throw e2; }
    }
    return { next: end + 1, armBody: null };
  }

  function isSome(v) { return v !== null && typeof v === 'object' && v.__rust === 'option' && !!v.some; }
  function isNone(v) { return v !== null && typeof v === 'object' && v.__rust === 'option' && !v.some; }
  function isOk(v) { return v !== null && typeof v === 'object' && v.__rust === 'result' && !!v.ok; }
  function isErr(v) { return v !== null && typeof v === 'object' && v.__rust === 'result' && !v.ok; }

  // destructure-match a pattern against a runtime value; binds idents; returns matched?
  // (shared by `match` arms and `if/while let` conditions)
  function matchPat(pat, val, env) {
    if (!pat.length) return false;
    // strip guard `if ...` (assume it passes — conditions already evaluate elsewhere)
    var g = -1;
    for (var gi = 0; gi < pat.length; gi++) {
      if (pat[gi].t === T.IDENT && pat[gi].v === 'if') { g = gi; break; }
    }
    var core = g === -1 ? pat : pat.slice(0, g);
    if (!core.length) return false;
    // strip binding modifiers: `mut x`, `ref x`, `&x`, `&mut x`
    var stripped = true;
    while (stripped && core.length) {
      stripped = false;
      if (core[0].t === T.IDENT && (core[0].v === 'mut' || core[0].v === 'ref')) { core = core.slice(1); stripped = true; }
      else if (core[0].v === '&') { core = core.slice(1); stripped = true; }
    }
    if (!core.length) return false;
    if (core.length === 1 && core[0].v === '_') return true;
    // single token: literals, None, bare binding/ctor
    if (core.length === 1) {
      var one = core[0];
      if (one.t === T.NUMBER) return num(val) === parseRustNum(one.v);
      if (one.t === T.STRING || one.t === T.RAWSTR) return rustToString(val) === unquote(one);
      if (one.t === T.CHAR) return rustToString(val) === unquoteChar(one.v);
      if (one.v === 'true') return val === true;
      if (one.v === 'false') return val === false;
      if (one.v === 'None') return isNone(val);
      if (one.t === T.IDENT) {
        if (one.v[0] >= 'A' && one.v[0] <= 'Z') {
          if (val !== null && typeof val === 'object' && val.__rust === 'enum') {
            var segs = val.path.split('::');
            return segs[segs.length - 1] === one.v;
          }
          return true; // unknown shape: lenient first-match
        }
        env[one.v] = { value: val, type: 'unknown' };
        return true;
      }
      return false;
    }
    // path pattern: Dir::North / Option::None
    if (isPathValue(core)) {
      var pp = core.map(function (t) { return t.v; }).join('');
      if (pp === 'None' || /::None$/.test(pp)) return isNone(val);
      if (pp === 'Some' || /::Some$/.test(pp)) return isSome(val);
      if (val !== null && typeof val === 'object' && val.__rust === 'enum') return val.path === pp;
      return true;
    }
    // struct pattern: Name { x, y: b, .. }
    if (core.length >= 3 && core[0].t === T.IDENT && core[1].v === '{') {
      var sfields = (val !== null && typeof val === 'object' && val.__rust === 'struct') ? val.fields : {};
      var sce = matchTok(core, 1, '{', '}');
      var sfparts = splitArgs(core.slice(2, sce === -1 ? core.length : sce));
      for (var sf = 0; sf < sfparts.length; sf++) {
        var sfa = sfparts[sf];
        if (!sfa.length) continue;
        if (sfa[0].v === '.' ) continue; // `..` rest
        if (sfa.length >= 3 && sfa[0].t === T.IDENT && sfa[1].v === ':') {
          var svv = Object.prototype.hasOwnProperty.call(sfields, sfa[0].v) ? sfields[sfa[0].v] : 0;
          matchPat(sfa.slice(2), svv, env);
        } else if (sfa.length === 1 && sfa[0].t === T.IDENT && sfa[0].v !== '_') {
          env[sfa[0].v] = {
            value: Object.prototype.hasOwnProperty.call(sfields, sfa[0].v) ? sfields[sfa[0].v] : 0,
            type: 'unknown'
          };
        }
      }
      return true;
    }
    // ctor pattern: Some(x) / Ok(v) / Err(e) / Foo(a, b)
    if (core.length >= 3 && core[0].t === T.IDENT && core[1].v === '(') {
      var cname = core[0].v;
      var cce = matchTok(core, 1, '(', ')');
      var cinner = cce === -1 ? core.slice(2) : core.slice(2, cce);
      var csub = splitArgs(cinner);
      if (cname === 'Some') {
        if (!isSome(val)) return false;
        return csub.length === 1 ? matchPat(csub[0], val.value, env) : true;
      }
      if (cname === 'Ok') {
        if (!isOk(val)) return false;
        return csub.length === 1 ? matchPat(csub[0], val.value, env) : true;
      }
      if (cname === 'Err') {
        if (!isErr(val)) return false;
        return csub.length === 1 ? matchPat(csub[0], val.value, env) : true;
      }
      if (val !== null && typeof val === 'object' && val.__rust === 'ctor' &&
          val.name === cname && val.args.length === csub.length) {
        for (var ca = 0; ca < csub.length; ca++) {
          if (!matchPat(csub[ca], val.args[ca], env)) return false;
        }
        return true;
      }
      return true; // unknown shape: lenient
    }
    // range pattern `1..=5` / `1..5`
    for (var r = 0; r < core.length; r++) {
      if (core[r].v === '..') {
        var lo = parseFloat(core[0] ? core[0].v : 'NaN');
        var rrest = core.slice(r + 1);
        if (rrest.length && rrest[0].v === '=') rrest = rrest.slice(1);
        var hi = parseFloat(rrest.length ? rrest[rrest.length - 1].v : 'NaN');
        var sv2 = num(val);
        if (!isNaN(lo) && !isNaN(hi) && sv2 >= lo && sv2 <= hi) return true;
        return false;
      }
    }
    return true;
  }

  // (matchPat lives above; old string-based armMatches removed)

  return { run: run, MAX_STEPS: MAX_STEPS, MAX_LOOP: MAX_LOOP };
}));

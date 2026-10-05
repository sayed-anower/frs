/* frs/src/checker.js — fast single-pass syntax+type checker (core engine).
 * Rule tables + implementations live in src/rules/*.js (see src/rules/index.js).
 * Pure JS, no deps.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    var req = function (p) { try { return require(p); } catch (e) { return null; } };
    var rulesMod = req('./rules/index.js') || req('./rules.js');
    module.exports = factory(req('./util.js'), req('./lexer.js'), rulesMod);
  } else root.FRS_checker = factory(root.FRS_util, root.FRS_lexer, root.FRS_rules);
}(typeof self !== 'undefined' ? self : this, function (U, LEX, RULES_MOD) {
  'use strict';
  U = U || {}; LEX = LEX || {}; RULES_MOD = RULES_MOD || {};
  var T = (LEX.T || { IDENT: 1, NUMBER: 2, STRING: 3, CHAR: 4, SYMBOL: 5, LIFETIME: 6, RAWSTR: 7, BYTESTR: 8 });
  var RULES = RULES_MOD.RULES || [];
  var KNOWN_TYPES = RULES_MOD.KNOWN_TYPES || {};
  var KNOWN_MACROS = RULES_MOD.KNOWN_MACROS || {};
  var KNOWN_FNS = RULES_MOD.KNOWN_FNS || {};

  var KEYWORDS = {
    'let': 1, 'mut': 1, 'fn': 1, 'if': 1, 'else': 1, 'for': 1, 'while': 1,
    'loop': 1, 'match': 1, 'return': 1, 'break': 1, 'continue': 1, 'in': 1,
    'struct': 1, 'enum': 1, 'impl': 1, 'trait': 1, 'mod': 1, 'use': 1,
    'pub': 1, 'crate': 1, 'self': 1, 'Self': 1, 'true': 1, 'false': 1,
    'as': 1, 'ref': 1, 'move': 1, 'where': 1, 'dyn': 1, 'static': 1,
    'const': 1, 'type': 1, 'unsafe': 1, 'extern': 1, 'async': 1, 'await': 1,
    'try': 1, 'macro': 1, 'yield': 1, 'union': 1, 'super': 1, 'do': 1,
    'box': 1, 'abstract': 1, 'become': 1, 'final': 1, 'override': 1, 'typeof': 1,
    'unsized': 1, 'virtual': 1, 'macro_rules': 1
  };
  var BLOCK_KW = { 'if': 1, 'for': 1, 'while': 1, 'loop': 1, 'match': 1, 'else': 1, 'unsafe': 1 };
  var PRINT_LIKE = { 'println': 1, 'print': 1, 'eprintln': 1, 'eprint': 1, 'format': 1, 'panic': 1, 'assert': 1, 'assert_eq': 1, 'assert_ne': 1, 'dbg': 1, 'todo': 1, 'unreachable': 1, 'unimplemented': 1 };

  function isKw(s) { return !!KEYWORDS[s]; }

  function check(src, filename, opts) {
    opts = opts || {};
    var t0 = LEX.lex(src);
    var toks = t0.tokens, lexErrs = t0.lexErrs;
    var n = toks.length;
    for (var pi0 = 0; pi0 < n; pi0++) toks[pi0].pos = pi0; // token-order index (not char offset)

    // ---- structures ----
    var diags = [];
    var lets = [];      // let bindings
    var extraBindings = []; // scope-aware pseudo-bindings: fn params, loop vars,
    // if/while-let + match-arm + closure bindings {name, idx, lo, hi}
    var assigns = [];   // assignments
    var calls = [];     // fn calls
    var macros = [];    // macro uses
    var kws = [];       // break/continue/return/else occurrences
    var fns = {};       // top-level fns: name -> {params, ret, line, col, used, count}
    var methods = {};   // impl/trait methods (kept separate: no dup-fn / unused-fn noise)
    var fnOrder = [];
    var structs = {};   // user type names
    var modNames = {};  // declared modules (`mod foo;` / `mod foo { }`)
    var useRoots = [];  // `use` crate roots {root, line, col} for unknown-crate check
    var uses = [];      // use stmts
    var stmts = [];     // generic stmt nodes for R002/R010/R012/R014/R018
    var identUses = []; // {name, idx, line, col}
    var refAliases = {}; // `let r = &x` -> {target} (deref-write + borrow resolution)
    var strayCloses = []; // `}`/`)`/`]` without opener
    var stack = [];     // delimiter stack {ch, line, col, idx}
    var macroRanges = []; // macro arg ranges (named `x = v` args are NOT assignments)
    var loopRanges = []; // {start,end} token-index ranges of loop bodies
    var fnRanges = [];   // {start,end} token-index ranges of fn bodies
    var hasMain = false;

    function tv(i) { return toks[i].v; }
    function tt(i) { return toks[i].t; }

    // Pre-scan: impl/trait body ranges (methods live in their own namespace —
    // a `fn new` in two impl blocks is NOT a duplicate, and methods are never
    // "unused" in the top-level sense).
    var implRanges = [];
    (function () {
      for (var ps = 0; ps < n; ps++) {
        if (toks[ps].t === T.IDENT && (toks[ps].v === 'impl' || toks[ps].v === 'trait')) {
          for (var pq = ps + 1; pq < Math.min(n, ps + 40); pq++) {
            if (toks[pq].t === T.SYMBOL && toks[pq].v === '{') {
              var pe = matchBrace(pq, '{', '}');
              implRanges.push({ start: pq, end: pe === -1 ? n : pe });
              break;
            }
            if (toks[pq].t === T.SYMBOL && toks[pq].v === ';') break;
          }
        }
      }
    })();
    function inRanges(ranges, idx) {
      for (var r = 0; r < ranges.length; r++) {
        if (idx > ranges[r].start && idx < ranges[r].end) return true;
      }
      return false;
    }

    // Parse a `use` tree (`std::{a::b::{X, Y as Z}, w}`) and register every
    // leaf name (alias-aware) as a file-wide binding so uses resolve.
    function bindUseTree(pathToks, lo, hi) {
      var parts = [], d = 0, cur = [];
      for (var p = 0; p < pathToks.length; p++) {
        var pv = pathToks[p].v;
        if (pv === '{' || pv === '(' || pv === '[') { d++; cur.push(pathToks[p]); }
        else if (pv === '}' || pv === ')' || pv === ']') { d--; cur.push(pathToks[p]); }
        else if (pv === ',' && d === 0) { parts.push(cur); cur = []; }
        else cur.push(pathToks[p]);
      }
      if (cur.length) parts.push(cur);
      for (var q = 0; q < parts.length; q++) {
        var seg = parts[q];
        // find top-level `{` in segment -> recurse
        var ob = -1, dd3 = 0;
        for (var qq = 0; qq < seg.length; qq++) {
          if (seg[qq].v === '{') { ob = qq; break; }
        }
        if (ob !== -1) {
          // tokens before `{` are the prefix path (ignored; leaf names matter)
          var closeI = seg.length - 1;
          while (closeI >= 0 && seg[closeI].v !== '}') closeI--;
          bindUseTree(seg.slice(ob + 1, closeI), lo, hi);
          continue;
        }
        // leaf: last IDENT, honoring `as` alias
        var alias = null, last = null;
        for (var z = 0; z < seg.length; z++) {
          if (seg[z].v === 'as' && z + 1 < seg.length && seg[z + 1].t === T.IDENT) alias = seg[z + 1].v;
          else if (seg[z].t === T.IDENT && seg[z].v !== 'as' && seg[z].v !== 'self' && !isKw(seg[z].v)) last = seg[z].v;
        }
        var name = alias || last;
        if (name && name !== 'self' && name !== 'Self') {
          extraBindings.push({ name: name, idx: lo, lo: lo, hi: hi, src: 'use' });
        }
      }
    }

    // Bind pattern identifiers (`for (a, b)`, `if let Some(x)`, match arms,
    // `|a, b|` closures) so uses resolve without false E0425s.
    function bindPatIdents(patToks, lo, hi, src) {
      var skipDepth = 0, afterColon = false;
      for (var bp = 0; bp < patToks.length; bp++) {
        var bt = patToks[bp];
        if (bt.v === '<') { skipDepth++; afterColon = false; continue; }
        if (bt.v === '>') { skipDepth = Math.max(0, skipDepth - 1); continue; }
        if (bt.v === ':') { afterColon = true; continue; }
        if (bt.v === ',' || bt.v === '|' || bt.v === '(' || bt.v === ')') { afterColon = false; }
        if (bt.t === T.IDENT && !isKw(bt.v) && bt.v !== '_' && bt.v !== 'mut' && bt.v !== 'ref') {
          if (bt.v[0] >= 'A' && bt.v[0] <= 'Z') continue; // ctors/types
          if (bt.v === 'true' || bt.v === 'false') continue;
          if (skipDepth > 0) continue; // inside `Vec<...>` — not a binding
          if (afterColon) {
            // `x: Type` (closure/fn params) vs `Point { x: y }` (binds y):
            // skip known/primitive/generic types, keep lowercase bindings.
            var nxb = patToks[bp + 1];
            if (KNOWN_TYPES[bt.v] || (nxb && (nxb.v === '<' || nxb.v === '::'))) continue;
          }
          extraBindings.push({ name: bt.v, idx: lo, lo: lo, hi: hi, src: src || 'pat' });
        }
        if (bt.t === T.IDENT && bt.v === 'if') break; // match guard: rest are uses
      }
    }

    // Heuristic: is toks[i] (lowercase ident) inside a match-arm *pattern*?
    // (patterns bind; only arm bodies/guards are real uses)
    function inPatternPos(ii) {
      var pv = ii > 0 ? toks[ii - 1].v : null;
      if (pv !== '(' && pv !== ',' && pv !== '{' && pv !== '|' && pv !== '[') return false;
      for (var s = 0, kk = ii + 1; s < 14 && kk < n; s++, kk++) {
        var w = toks[kk].v, wt = toks[kk].t;
        if (w === '=>') return true;
        if (wt === T.SYMBOL) {
          if (w === '(' || w === ')' || w === '{' || w === '}' || w === '[' || w === ']' ||
              w === ',' || w === '|' || w === ':' || w === '.' || w === '&' ||
              w === '::' || w === '..' || w === '...' || w === '-' || w === '+' || w === '@') continue;
          return false;
        }
        if (wt === T.IDENT) {
          if (w === 'if' || w === 'in') return false;
          continue;
        }
      }
      return false;
    }

    // Bind every match-arm pattern (`Some(x) => ...` binds `x` for its arm).
    function bindMatchArms(mi) {
      var fo = -1;
      for (var q = mi + 1; q < Math.min(n, mi + 60); q++) {
        if (toks[q].t === T.SYMBOL && toks[q].v === '{') { fo = q; break; }
        if (toks[q].t === T.SYMBOL && toks[q].v === ';') return;
      }
      if (fo === -1) return;
      var fe = matchBrace(fo, '{', '}');
      if (fe === -1) fe = n;
      var armStart = fo + 1, k = fo + 1, depth = 0;
      while (k < fe) {
        var w = toks[k].v;
        if (toks[k].t === T.SYMBOL) {
          if (w === '(' || w === '[' || w === '{') depth++;
          else if (w === ')' || w === ']' || w === '}') depth--;
          else if (w === '=>' && depth === 0) {
            var pat = toks.slice(armStart, k);
            var bd = 0, bend = fe;
            for (var j = k + 1; j < fe; j++) {
              var u = toks[j].v;
              if (toks[j].t === T.SYMBOL) {
                if (u === '(' || u === '[' || u === '{') bd++;
                else if (u === ')' || u === ']' || u === '}') bd--;
                else if (u === ',' && bd === 0) { bend = j; break; }
              }
            }
            bindPatIdents(pat, armStart, bend, 'match');
            armStart = bend + 1;
            k = bend + 1;
            continue;
          }
        }
        k++;
      }
    }

    // Heuristic: is the `=` at toks[eqIdx] (with ident at eqIdx-1... actually
    // ident at `idx`, `=` at idx+1) nested inside `<...>` generics?
    // e.g. `where T: ServiceFactory<A, Config = ()>` — that `=` is a bound,
    // not an assignment. Scans backwards for an unmatched `<`.
    function inAngleBrackets(idx) {
      var ad = 0, ag = 0;
      for (var b = idx - 1, steps = 0; b >= 0 && steps < 80; b--, steps++) {
        var bv = toks[b].v, bt = toks[b].t;
        if (bt === T.SYMBOL) {
          if (bv === ')' || bv === ']' || bv === '}') { ad++; continue; }
          if (bv === '(' || bv === '[' || bv === '{') { if (ad === 0) return false; ad--; continue; }
          if (ad !== 0) continue;
          if (bv === ';' || bv === '->' || bv === '=>' || bv === '<=' || bv === '>=') return false;
          if (bv === '=') continue; // `A<B = C, D = E>`: earlier `=` is also a bound
          if (bv === '>') { ag++; continue; }
          if (bv === '>>') { ag += 2; continue; }
          if (bv === '<') { if (ag === 0) return true; ag--; continue; }
          if (bv === '<<') { if (ag >= 2) ag -= 2; else return false; continue; }
          continue;
        }
        if (ad === 0 && bt === T.IDENT && (bv === 'let' || bv === 'fn' || bv === 'where' ||
            bv === 'struct' || bv === 'enum' || bv === 'impl' || bv === 'trait' ||
            bv === 'return' || bv === 'if' || bv === 'match')) return false;
      }
      return false;
    }

    // helper: find matching close from openIdx (toks[openIdx].v is open ch)
    // We do brace matching on the fly with a local depth counter (fast).
    function matchBrace(from, open, close) {
      var d = 0;
      for (var i = from; i < n; i++) {
        if (tt(i) === T.SYMBOL) {
          if (tv(i) === open) d++;
          else if (tv(i) === close) { d--; if (d === 0) return i; }
        }
      }
      return -1;
    }

    // ---- main scan ----
    var i = 0;
    var braceDepth = 0;
    while (i < n) {
      var tk = toks[i], v = tk.v, t = tk.t;

      // delimiter stack
      if (t === T.SYMBOL) {
        if (v === '{' || v === '(' || v === '[') {
          stack.push({ ch: v, line: tk.line, col: tk.col, idx: i, span: 1 });
          if (v === '{') braceDepth++;
          i++; continue;
        }
        if (v === '}' || v === ')' || v === ']') {
          var want = v === '}' ? '{' : v === ')' ? '(' : '[';
          if (stack.length && stack[stack.length - 1].ch === want) {
            stack.pop();
            if (v === '}') braceDepth--;
          } else {
            strayCloses.push({ ch: v, line: tk.line, col: tk.col, idx: i });
          }
          i++; continue;
        }
      }

      // ---- closure params: `|a, b| expr` (value position only) ----
      if (t === T.SYMBOL && v === '|' && i + 1 < n) {
        var cpv = i > 0 ? toks[i - 1].v : null;
        if (cpv === '=' || cpv === '(' || cpv === ',' || cpv === '[' || cpv === '{' ||
            cpv === '=>' || cpv === ':' || cpv === 'return' || cpv === 'move') {
          var ck = i + 1, cok = true, vend = -1;
          for (var cs = 0; cs < 12 && ck < n; cs++, ck++) {
            var cw = toks[ck].v, cwt = toks[ck].t;
            if (cwt === T.SYMBOL && cw === '|') { vend = ck; break; }
            if (cwt === T.IDENT || cwt === T.LIFETIME) continue;
            if (cwt === T.SYMBOL && (cw === ',' || cw === ':' || cw === '&' ||
                cw === '<' || cw === '>' || cw === '(' || cw === ')')) continue;
            cok = false; break;
          }
          if (cok && vend !== -1) {
            var stmtEnd = n, sd = 0;
            for (var se2 = vend + 1; se2 < Math.min(n, vend + 120); se2++) {
              var sw = toks[se2].v;
              if (sw === '(' || sw === '[' || sw === '{') sd++;
              else if (sw === ')' || sw === ']' || sw === '}') { if (sd === 0) break; sd--; }
              else if (sw === ';' && sd === 0) { stmtEnd = se2; break; }
            }
            bindPatIdents(toks.slice(i + 1, vend), i, stmtEnd, 'closure');
          }
        }
        i++; continue;
      }

      // ---- attributes: `#[...]` / `#![...]` (contents are not code) ----
      if (t === T.SYMBOL && v === '#') {
        var ak2 = i + 1;
        if (ak2 < n && toks[ak2].v === '!') ak2++;
        if (ak2 < n && toks[ak2].v === '[') {
          var aClose = matchBrace(ak2, '[', ']');
          i = (aClose === -1 ? n : aClose + 1);
          continue;
        }
        i++; continue;
      }

      if (t !== T.IDENT) { i++; continue; }

      // ---- macro_rules! name { ... } (body is matcher/transcriber, not code) ----
      if (v === 'macro_rules') {
        var mk2 = i + 1;
        if (mk2 < n && toks[mk2].v === '!') mk2++;
        if (mk2 < n && toks[mk2].t === T.IDENT) mk2++;
        if (mk2 < n && toks[mk2].v === '{') {
          var mEnd2 = matchBrace(mk2, '{', '}');
          i = (mEnd2 === -1 ? n : mEnd2 + 1);
          continue;
        }
        i++; continue;
      }

      // ---- type / const / static declarations (skip RHS; register name) ----
      if (v === 'type' || v === 'const' || v === 'static') {
        var dname = null;
        if (i + 1 < n && toks[i + 1].t === T.IDENT && !isKw(toks[i + 1].v)) dname = toks[i + 1].v;
        if (dname) structs[dname] = 1;
        var dk = i + 1, dd2 = 0;
        while (dk < n) {
          var dv = toks[dk].v;
          if (toks[dk].t === T.SYMBOL) {
            if (dv === '(' || dv === '[' || dv === '{') dd2++;
            else if (dv === '<') dd2++;
            else if (dv === '>>') dd2 -= 2;
            else if (dv === '<<') dd2 += 2;
            else if (dv === ')' || dv === ']' || dv === '}' || dv === '>') dd2--;
            else if (dv === ';' && dd2 === 0) break;
          }
          dk++;
          if (dk - i > 200) break;
        }
        i = Math.min(n, dk + 1);
        continue;
      }

      // ---- use ----
      if (v === 'use') {
        var s = i, semi = false;
        var k = i + 1, ud = 0;
        while (k < n) {
          var uv = toks[k].v;
          if (toks[k].t === T.SYMBOL) {
            if (uv === '{' || uv === '(' || uv === '[') ud++;
            else if (uv === '<') ud++;
            else if (uv === '>>') ud -= 2;
            else if (uv === '<<') ud += 2;
            else if (uv === '}' || uv === ')' || uv === ']' || uv === '>') ud--;
            else if (uv === ';' && ud === 0) { semi = true; k++; break; }
          }
          if (toks[k].t === T.IDENT && (toks[k].v === 'fn' || toks[k].v === 'let' || toks[k].v === 'struct')) break;
          k++;
          if (k - s > 400) break;
        }
        var un = { kind: 'use', line: tk.line, col: tk.col, spanLen: 3, hasSemi: semi, idx: s, endIdx: k };
        uses.push(un); stmts.push(un);
        // record the crate root (`use actix_web::{...}` -> `actix_web`) for T018
        (function recordUseRoot() {
          var r0 = s + 1;
          if (r0 < n && toks[r0].t === T.IDENT) {
            var r0v = toks[r0].v;
            // `crate::` / `self::` / `super::` are always local — never external
            if ((r0v === 'crate' || r0v === 'self' || r0v === 'super') &&
                r0 + 1 < n && toks[r0 + 1].v === '::') return;
            useRoots.push({ root: r0v, line: toks[r0].line, col: toks[r0].col });
          }
        })();
        // register imported names as bindings so uses resolve (alias-aware)
        bindUseTree(toks.slice(s + 1, semi ? k - 1 : k), i, n);
        i = Math.max(i + 1, Math.min(k, n)); // skip the whole `use ...;` (no code inside)
        continue;
      }

      // ---- struct / enum (record type names, skip declaration bodies) ----
      if (v === 'struct' || v === 'enum') {
        var nm = (i + 1 < n && toks[i + 1].t === T.IDENT) ? toks[i + 1].v : null;
        if (nm && !isKw(nm)) structs[nm] = 1;
        var sn = { kind: 'stmt', kw: v, line: tk.line, col: tk.col, spanLen: v.length, idx: i };
        stmts.push(sn);
        // skip `struct Foo;` or `struct Foo { ... }` — fields are NOT code
        var sk = i + 1, done = false;
        for (var sq = i + 1; sq < Math.min(n, i + 25); sq++) {
          if (toks[sq].t === T.SYMBOL && toks[sq].v === '{') {
            var se = matchBrace(sq, '{', '}');
            i = (se === -1 ? n : se + 1);
            done = true; break;
          }
          if (toks[sq].t === T.SYMBOL && (toks[sq].v === ';' || toks[sq].v === '}')) {
            i = sq + 1; done = true; break;
          }
        }
        if (!done) i++;
        continue;
      }
      if (v === 'trait') {
        var nm2 = (i + 1 < n && toks[i + 1].t === T.IDENT) ? toks[i + 1].v : null;
        if (nm2 && !isKw(nm2)) structs[nm2] = 1;
        stmts.push({ kind: 'stmt', kw: v, line: tk.line, col: tk.col, spanLen: v.length, idx: i });
        i++;
        continue;
      }
      if (v === 'impl') {
        stmts.push({ kind: 'stmt', kw: v, line: tk.line, col: tk.col, spanLen: v.length, idx: i });
        i++;
        continue;
      }
      // ---- mod declaration: `mod name;` / `pub mod name;` / `mod name { ... }`
      // (the name is a module, not a value — never an ident use)
      if (v === 'mod') {
        stmts.push({ kind: 'stmt', kw: v, line: tk.line, col: tk.col, spanLen: v.length, idx: i });
        var mnx = i + 1;
        if (mnx < n && toks[mnx].t === T.IDENT && !isKw(toks[mnx].v)) {
          modNames[toks[mnx].v] = 1;
          mnx++;
          // `mod name;` — skip the semicolon too; inline `mod name { }` body scans normally
          if (mnx < n && toks[mnx].v === ';') { i = mnx + 1; continue; }
          i = mnx;
          continue;
        }
        i++;
        continue;
      }
      // ---- extern crate: `extern crate name [as alias];` (declares a crate, not a value)
      // `extern "ABI" { ... }` blocks scan normally (signatures inside are real items).
      if (v === 'extern' && i + 1 < n && toks[i + 1].t === T.IDENT && toks[i + 1].v === 'crate') {
        var exk = i + 2, exd = 0;
        while (exk < n) {
          var exv = toks[exk].v;
          if (toks[exk].t === T.SYMBOL) {
            if (exv === '(' || exv === '[' || exv === '{') exd++;
            else if (exv === ')' || exv === ']' || exv === '}') exd--;
            else if (exv === ';' && exd === 0) { exk++; break; }
          }
          exk++;
          if (exk - i > 20) break;
        }
        i = Math.min(n, exk);
        continue;
      }
      // ---- where clause (item level: `impl ... where ... {`, `fn ... where ... {`)
      // Bounds contain `=` inside `<...>` (e.g. `Config = ()`) which is not assignment.
      if (v === 'where') {
        var wk = i + 1, wd = 0;
        while (wk < n) {
          var wv = toks[wk].v;
          if (toks[wk].t === T.SYMBOL) {
            if (wv === '(' || wv === '[' || wv === '{') {
              if (wd === 0) break; // body block starts — do not consume it
              wd++;
            }
            else if (wv === ')' || wv === ']' || wv === '}') { if (wd === 0) break; wd--; }
            else if (wv === ';' && wd === 0) { wk++; break; }
          }
          wk++;
          if (wk - i > 300) break;
        }
        i = Math.min(n, wk);
        continue;
      }

      // ---- fn definition ----
      if (v === 'fn') {
        var fname = null, fi = i + 1;
        if (fi < n && toks[fi].t === T.IDENT && !isKw(toks[fi].v)) { fname = toks[fi].v; fi++; }
        // generics skip: <...>
        if (fi < n && toks[fi].v === '<') {
          var gd = 0, gk = fi;
          while (gk < n) {
            if (toks[gk].v === '<') gd++;
            else if (toks[gk].v === '>>') { gd -= 2; if (gd <= 0) { gk += 0; break; } }
            else if (toks[gk].v === '>') { gd--; if (gd === 0) break; }
            gk++;
            if (gk - fi > 40) break;
          }
          fi = gk + 1;
        }
        var params = -1, ret = null, bodyOpen = -1, hasSemiDecl = false, ce = -1;
        if (fname !== null && fi < n && toks[fi].v === '(') {
          ce = matchBrace(fi, '(', ')');
          if (ce !== -1) {
            params = countTopArgs(toks, fi + 1, ce);
            // self counts as a param too (fine)
            var ak = ce + 1;
            if (ak < n && toks[ak].v === '->') {
              var rk = ak + 1;
              var rt = [];
              var pd2 = 0;
              // return type may span many lines (`-> App<impl ServiceFactory<...>>`);
              // scan to `{`/`;`/`where` at depth 0 (token-capped, not line-capped)
              while (rk < n && rk - ak < 200) {
                var rkv = toks[rk].v;
                if (toks[rk].t === T.SYMBOL) {
                  if (rkv === '(' || rkv === '[' || rkv === '<') pd2++;
                  else if (rkv === '{') { if (pd2 === 0) break; pd2++; }
                  else if (rkv === ')' || rkv === ']' || rkv === '}') pd2--;
                  else if (rkv === '>>') pd2 -= 2;
                  else if (rkv === '>' && pd2 > 0) pd2--;
                  else if (rkv === ';' && pd2 === 0) break;
                }
                if (pd2 === 0 && toks[rk].t === T.IDENT && rkv === 'where') break;
                if (rt.join('').length <= 60 &&
                    (toks[rk].t === T.IDENT || toks[rk].t === T.SYMBOL || toks[rk].t === T.LIFETIME)) rt.push(rkv);
                rk++;
              }
              ret = rt.join('').replace(/,/g, ', ') || null;
              ak = rk;
              // where clause skip
              if (ak < n && toks[ak].v === 'where') {
                while (ak < n && toks[ak].v !== '{' && toks[ak].v !== ';') ak++;
              }
            }
            if (ak < n && toks[ak].v === '{') bodyOpen = ak;
            else if (ak < n && toks[ak].v === ';') hasSemiDecl = true;
          }
        }
        var fnNode = {
          kind: 'fn', name: fname, fnameMissing: fname === null,
          params: params, ret: ret, line: tk.line, col: tk.col,
          spanLen: 2 + (fname ? fname.length : 0), idx: i,
          bodyOpen: bodyOpen, hasSemiDecl: hasSemiDecl, afterIdx: fi,
          inImpl: inRanges(implRanges, i)
        };
        stmts.push(fnNode);
        // fn body end (for param scoping)
        var fnBodyEnd = n;
        if (bodyOpen !== -1) {
          var be0 = matchBrace(bodyOpen, '{', '}');
          fnBodyEnd = be0 === -1 ? n : be0;
        }
        if (fname) {
          if (fnNode.inImpl) {
            // methods: own namespace (no dup-fn / unused-fn / arg-count noise)
            if (methods[fname]) methods[fname].count++;
            else methods[fname] = { params: params, ret: ret, line: tk.line, col: tk.col, used: true, count: 1 };
          } else {
            if (fns[fname]) fns[fname].count++;
            else { fns[fname] = { params: params, ret: ret, line: tk.line, col: tk.col, used: false, count: 1, firstIdx: i }; fnOrder.push(fname); }
            if (fname === 'main') hasMain = true;
          }
          // bind params (`fn add(a: i32, b: i32)`) so body uses resolve
          if (ce !== -1 && fi < n && toks[fi].v === '(') {
            for (var pp = fi + 1; pp < ce; pp++) {
              if (toks[pp].t === T.IDENT && toks[pp].v === 'self') {
                extraBindings.push({ name: 'self', idx: i, lo: i, hi: fnBodyEnd, src: 'param' });
                continue;
              }
              if (toks[pp].t === T.IDENT && !isKw(toks[pp].v) &&
                  pp + 1 < n && toks[pp + 1].v === ':') {
                extraBindings.push({ name: toks[pp].v, idx: i, lo: i, hi: fnBodyEnd, src: 'param' });
              }
            }
          }
          // record fn body range for return-inside check
          if (bodyOpen !== -1) {
            fnRanges.push({ start: bodyOpen, end: fnBodyEnd });
          }
        }
        // skip signature (`fn name(params) -> Ret`); the BODY is still scanned
        // so inner lets/uses are collected normally.
        var sigEnd = bodyOpen !== -1 ? bodyOpen : (ce !== -1 ? ce + 1 : i + 2);
        i = Math.max(i + 1, Math.min(sigEnd, n));
        continue;
      }

      // ---- let binding ----
      if (v === 'let') {
        // `if let PAT = ...` / `while let ...`: a let-CONDITION, not a statement
        // (already pattern-bound by the if/while handler).
        var pl = i > 0 ? toks[i - 1].v : null;
        if (pl === 'if' || pl === 'while') { i++; continue; }
        var li = i + 1, lmut = false;
        if (li < n && toks[li].v === 'mut' && toks[li].t === T.IDENT) { lmut = true; li++; }
        var lname = null, lann = null, lnameTok = null;
        if (li < n && toks[li].t === T.IDENT && !isKw(toks[li].v)) { lname = toks[li].v; lnameTok = toks[li]; li++; }
        else if (li < n && toks[li].v === '_') { lname = '_'; lnameTok = toks[li]; li++; }
        else if (li < n && (toks[li].v === '(' || toks[li].v === '[')) {
          // destructuring pattern: `let (a, b) = ...;` / `let [a, b] = ...;`
          var openCh = toks[li].v, closeCh = openCh === '(' ? ')' : ']';
          var pe2 = matchBrace(li, openCh, closeCh);
          if (pe2 !== -1) bindPatIdents(toks.slice(li + 1, pe2), i, n, 'letpat');
          lname = '_'; lnameTok = toks[li]; li = pe2 === -1 ? li + 1 : pe2 + 1;
        }
        // optional `: Type` (depth-aware: `HashMap<String, i32>`, `(i32, bool)`)
        if (lname && li < n && toks[li].v === ':') {
          li++;
          var at = [], adepth = 0;
          while (li < n) {
            var av = toks[li].v;
            if (toks[li].t === T.SYMBOL) {
              if (av === '(' || av === '[' || av === '{' || av === '<') adepth++;
              else if (av === '<<') adepth += 2;
              else if (av === ')' || av === ']' || av === '}' || av === '>') adepth--;
              else if (av === '>>') adepth -= 2;
              else if (adepth <= 0 && (av === '=' || av === ';' || av === ',')) break;
              if (adepth < 0) break;
              at.push(av);
            } else if (toks[li].t === T.IDENT || toks[li].t === T.LIFETIME) {
              at.push(av);
            } else break;
            li++;
            if (at.join('').length > 80) break;
          }
          lann = at.join('').replace(/\s+/g, '') || null;
        }
        var hasEq = (li < n && toks[li].v === '=');
        var valStart = hasEq ? li + 1 : -1, valEnd = -1, hasSemi = false;
        if (hasEq) {
          var depth = 0, q = valStart;
          while (q < n) {
            var qv = toks[q].v;
            if (toks[q].t === T.SYMBOL) {
              if (qv === '(' || qv === '[' || qv === '{') depth++;
              else if (qv === ')' || qv === ']' || qv === '}') {
                if (depth === 0) break;
                depth--;
                if (depth < 0) break;
              }
              else if (qv === ';' && depth === 0) { hasSemi = true; valEnd = q; break; }
            }
            // stop if next statement keyword at depth 0 on later line without semi
            if (depth === 0 && toks[q].t === T.IDENT && (toks[q].v === 'let' || toks[q].v === 'fn') && q > valStart && toks[q].line > tk.line) { valEnd = q; break; }
            q++;
            if (q - valStart > 400) break;
          }
          if (valEnd === -1) valEnd = Math.min(q, n);
        } else {
          // `let x;`? needs semi
          var q2 = li;
          while (q2 < n && toks[q2].line <= tk.line + 1 && q2 - i < 10) {
            if (toks[q2].v === ';') { hasSemi = true; break; }
            q2++;
          }
        }
        var valToks = (hasEq && valStart !== -1) ? toks.slice(valStart, valEnd === -1 ? valStart : valEnd) : [];
        // strip trailing `}` depth artifact? keep as-is
        var node = {
          kind: 'let', name: lname, isMut: lmut, ann: lann, valToks: valToks,
          line: tk.line, col: tk.col, spanLen: 3, idx: i,
          nameLine: lnameTok ? lnameTok.line : tk.line,
          nameCol: lnameTok ? lnameTok.col : tk.col + 4,
          nameLen: lname ? lname.length : 1,
          hasSemi: hasSemi, hasEq: hasEq, missingName: !lname,
          valEndIdx: valEnd, valStartIdx: valStart,
          used: false, mutated: false
        };
        lets.push(node); stmts.push(node);
        // `let r = &x` / `let r = &mut x`: remember the borrow target so
        // deref writes (`*r = ...`) and borrow rules can resolve through `r`
        if (hasEq && valToks.length >= 2 && valToks[0].v === '&') {
          var ak2 = 1;
          if (valToks[ak2] && valToks[ak2].v === 'mut') ak2++;
          if (ak2 < valToks.length && valToks[ak2].t === T.IDENT && ak2 === valToks.length - 1 &&
              lname && lname !== '_') {
            refAliases[lname] = { target: valToks[ak2].v, idx: i };
          }
        }
        // record ident uses inside value expr (token-order positions)
        for (var vi = 0; vi < valToks.length; vi++) {
          var vt = valToks[vi];
          if (vt.t === T.IDENT && !isKw(vt.v) && !KNOWN_MACROS[vt.v] && vt.v !== '_') {
            // skip field access (prev is .) and path second segment (prev is ::)
            // (approx via raw neighbors in valToks)
            var prev = vi > 0 ? valToks[vi - 1].v : null;
            if (prev === '.' || prev === '::') continue;
            var nxt = vi + 1 < valToks.length ? valToks[vi + 1].v : null;
            if (nxt === '::' || nxt === '!') continue;
            if (nxt === ':') continue; // struct-literal field label `Point { x: ... }`
            identUses.push({ name: vt.v, idx: vt.pos, line: vt.line, col: vt.col, spanLen: vt.v.length });
          }
        }
        // Skip past `let [mut] name [: Type] [=]` — the VALUE is scanned
        // normally afterwards (inner lets/uses still collected), but the
        // binding prefix must not be re-read as assignment/use.
        if (hasEq && valStart !== -1) i = Math.max(i + 1, valStart);
        else i = Math.max(i + 1, li);
        continue;
      }

      // ---- print-like without bang: println ( ... ) ----
      if (PRINT_LIKE[v] && i + 1 < n && toks[i + 1].v === '(') {
        stmts.push({ kind: 'stmt', kw: v, sub: 'print-bang', line: tk.line, col: tk.col, spanLen: v.length, idx: i });
        // fall through to generic ident-use handling? println isn't a var; skip use-record
        i++;
        continue;
      }

      // ---- macro use: name ! ( ... ) / [ ... ] / { ... } ----
      if (t === T.IDENT && !isKw(v) && i + 1 < n && toks[i + 1].v === '!') {
        var mName = v;
        var mk = i + 2, open = null;
        if (mk < n && (toks[mk].v === '(' || toks[mk].v === '[' || toks[mk].v === '{')) open = toks[mk].v;
        var mClose = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : null;
        var mEnd = -1, fmtStr = null, argCount = 0, placeholders = 0;
        if (open && mClose) {
          var me = matchBrace(mk, open, mClose);
          mEnd = me;
          var inner = me === -1 ? toks.slice(mk + 1, Math.min(mk + 60, n)) : toks.slice(mk + 1, me);
          // first STRING/RAWSTR is format string
          for (var mi = 0; mi < inner.length; mi++) {
            if (inner[mi].t === T.STRING || inner[mi].t === T.RAWSTR) { fmtStr = inner[mi].v; break; }
            if (inner[mi].t === T.IDENT || inner[mi].t === T.NUMBER) break; // e.g. vec![1,2] has no fmt
            if (mi > 4) break;
          }
          if (fmtStr !== null && PRINT_LIKE[mName]) {
            placeholders = countPlaceholders(fmtStr);
            argCount = countTopArgs(toks, mk + 1, me === -1 ? Math.min(mk + 60, n - 1) : me);
            // args after fmt string: total top-level args minus 1 (fmt itself)
            argCount = Math.max(0, argCount - 1);
            // inline captures `{name}` need no args: if all placeholders are named-inline, zero them
            if (hasOnlyNamedCaptures(fmtStr)) { placeholders = 0; argCount = 0; }
          }
          // record ident uses inside macro args (token-order positions)
          // (macros whose args are NOT evaluated as code define no uses)
          var noEvalMacro = mName === 'stringify' || mName === 'cfg' || mName === 'compile_error' ||
            mName === 'env' || mName === 'option_env' || mName === 'include' ||
            mName === 'include_str' || mName === 'include_bytes';
          // unknown macros (not std-known: `codegen_reexport!(main)`, `bitflags!`, user macros —
          // their args may be patterns/types, not expressions):
          // stay lenient instead of flagging their idents as values.
          // EXCEPT cfg-gate macros (`cfg_if!`, `cfg_fs!`, `cfg_not_*`, ...): they
          // wrap REAL items (`cfg_fs! { pub mod fs; }`) — scan those normally.
          var knownMacro = noEvalMacro || (KNOWN_MACROS && KNOWN_MACROS[mName]) || (typeof PRINT_LIKE !== 'undefined' && PRINT_LIKE[mName]);
          var cfgGate = !knownMacro && (mName === 'cfg_if' || (mName.length > 4 && mName.slice(0, 4) === 'cfg_'));
          var transparentGate = cfgGate && open !== null;
          for (var ui = 0; ui < inner.length; ui++) {
            // cfg-gates are scanned by the main loop (real items inside);
            // non-evaluated / unknown macros define no uses.
            if (transparentGate || noEvalMacro || !knownMacro) break;
            var ut = inner[ui];
            if (ut.t === T.IDENT && !isKw(ut.v) && ut.v !== '_') {
              var up = ui > 0 ? inner[ui - 1].v : null;
              if (up === '.' || up === '::') continue;
              var unx = ui + 1 < inner.length ? inner[ui + 1].v : null;
              if (unx === '::' || unx === '!') continue;
              if (unx === ':') continue; // struct-literal field label
              if (unx === '=') continue; // named format arg `name = expr`
              identUses.push({ name: ut.v, idx: ut.pos, line: ut.line, col: ut.col, spanLen: ut.v.length });
            }
          }
        }
        var mNode = {
          kind: 'macro', name: mName, line: tk.line, col: tk.col,
          spanLen: mName.length + 1, idx: i, fmtStr: fmtStr,
          argCount: argCount, placeholders: placeholders, endIdx: mEnd
        };
        macros.push(mNode);
        if (open && mEnd !== -1) macroRanges.push({ start: mk, end: mEnd });
        // body is transparent for cfg-gates (real items inside); skipped for
        // non-evaluated and other unknown macros.
        if (!transparentGate && (noEvalMacro || !knownMacro) && open && mEnd !== -1) { i = mEnd + 1; continue; }
        i += 2;
        continue;
      }

      // ---- block keywords: track loop bodies for break/continue ----
      if (v === 'for' || v === 'while' || v === 'loop') {
        // a real `for` must contain `in` before its block — otherwise it is
        // e.g. the `for` in `impl X for Y` and must not be treated as a loop
        if (v === 'for') {
          var hasIn = false;
          for (var fz0 = i + 1; fz0 < Math.min(n, i + 80); fz0++) {
            if (toks[fz0].v === ';') break;
            if (toks[fz0].t === T.IDENT && toks[fz0].v === 'in') { hasIn = true; break; }
          }
          if (!hasIn) { i++; continue; }
        }
        // find first `{` ahead (within ~80 toks, before `;`)
        var fk = i + 1, fo = -1;
        for (var z = i + 1; z < Math.min(n, i + 80); z++) {
          if (toks[z].v === ';' && toks[z].t === T.SYMBOL) break;
          if (toks[z].v === '{' && toks[z].t === T.SYMBOL) { fo = z; break; }
        }
        stmts.push({ kind: 'stmt', kw: v, line: tk.line, col: tk.col, spanLen: v.length, idx: i, braceIdx: fo });
        var loopBodyEnd = n;
        if (fo !== -1) {
          var fe = matchBrace(fo, '{', '}');
          loopBodyEnd = fe === -1 ? n : fe;
          loopRanges.push({ start: fo, end: loopBodyEnd });
        }
        // bind loop/pattern vars so body uses resolve:
        // `for pat in expr`, `while let PAT = expr`
        if (v === 'for' && fo !== -1) {
          var inIdx = -1;
          for (var fz = i + 1; fz < fo; fz++) {
            if (toks[fz].t === T.IDENT && toks[fz].v === 'in') { inIdx = fz; break; }
          }
          if (inIdx !== -1) bindPatIdents(toks.slice(i + 1, inIdx), i, loopBodyEnd, 'for');
        } else if (v === 'while' && fo !== -1 && toks[i + 1] && toks[i + 1].v === 'let') {
          var weq = -1;
          for (var wz = i + 2; wz < fo; wz++) {
            if (toks[wz].v === '=') { weq = wz; break; }
          }
          bindPatIdents(toks.slice(i + 2, weq === -1 ? fo : weq), i, loopBodyEnd, 'while');
        }
        i++;
        continue;
      }
      if (v === 'if' || v === 'match') {
        stmts.push({ kind: 'stmt', kw: v, line: tk.line, col: tk.col, spanLen: v.length, idx: i });
        if (v === 'if' && toks[i + 1] && toks[i + 1].v === 'let') {
          // `if let PAT = expr { then } [else ...]` — PAT visible in then-block
          var ibrace = -1;
          for (var iz = i + 2; iz < Math.min(n, i + 60); iz++) {
            if (toks[iz].v === '{') { ibrace = iz; break; }
            if (toks[iz].v === ';') break;
          }
          if (ibrace !== -1) {
            var ieq = -1;
            for (var iq = i + 2; iq < ibrace; iq++) {
              if (toks[iq].v === '=') { ieq = iq; break; }
            }
            var iend = matchBrace(ibrace, '{', '}');
            bindPatIdents(toks.slice(i + 2, ieq === -1 ? ibrace : ieq), i, iend === -1 ? n : iend, 'iflet');
          }
        }
        if (v === 'match') bindMatchArms(i);
        i++;
        continue;
      }
      if (v === 'else' || v === 'break' || v === 'continue' || v === 'return') {
        kws.push({ kind: 'kw', kw: v, line: tk.line, col: tk.col, spanLen: v.length, idx: i });
        stmts.push({ kind: 'stmt', kw: v, line: tk.line, col: tk.col, spanLen: v.length, idx: i });
        i++;
        continue;
      }

      // ---- assignment: ident = ... / += -= *= /= %= (==, =>, !=, <=, >= are single toks) ----
      // (never inside macro args: `println!("{x}", x = 2)` named args aren't assigns)
      // (never inside `<...>` generics: `where T: Trait<Config = ()>` bounds aren't assigns)
      // (never a deref target: `*r = ...` writes through the borrow, not to `r`)
      if (!isKw(v) && i > 0 && toks[i - 1].v !== '.' && toks[i - 1].v !== '*' && i + 1 < n && toks[i + 1].t === T.SYMBOL &&
          (toks[i + 1].v === '=' || toks[i + 1].v === '+=' || toks[i + 1].v === '-=' ||
           toks[i + 1].v === '*=' || toks[i + 1].v === '/=' || toks[i + 1].v === '%=') &&
          !inRanges(macroRanges, i) && !inAngleBrackets(i)) {
        // make sure not `==` (lexer merges ==, so single `=` only here)
        var aStart = i + 2, aEnd = -1, aSemi = false, ad = 0, aq = aStart;
        while (aq < n) {
          var av = toks[aq].v;
          if (toks[aq].t === T.SYMBOL) {
            if (av === '(' || av === '[' || av === '{') ad++;
            else if (av === ')' || av === ']' || av === '}') { if (ad === 0) break; ad--; }
            else if (av === ';' && ad === 0) { aSemi = true; aEnd = aq; break; }
          }
          if (ad === 0 && toks[aq].t === T.IDENT && (toks[aq].v === 'let' || toks[aq].v === 'fn') && aq > aStart) { aEnd = aq; break; }
          aq++;
          if (aq - aStart > 300) break;
        }
        if (aEnd === -1) aEnd = Math.min(aq, n);
        var aVal = toks.slice(aStart, aEnd);
        var an = { kind: 'assign', name: v, valToks: aVal, line: tk.line, col: tk.col, spanLen: v.length, idx: i, hasSemi: aSemi };
        assigns.push(an); stmts.push(an);
        for (var ai = 0; ai < aVal.length; ai++) {
          var at2 = aVal[ai];
          if (at2.t === T.IDENT && !isKw(at2.v) && at2.v !== '_') {
            var ap = ai > 0 ? aVal[ai - 1].v : null;
            if (ap === '.' || ap === '::') continue;
            var anx = ai + 1 < aVal.length ? aVal[ai + 1].v : null;
            if (anx === '::' || anx === '!') continue;
            if (anx === ':') continue; // struct-literal field label
            identUses.push({ name: at2.v, idx: at2.pos, line: at2.line, col: at2.col, spanLen: at2.v.length });
          }
        }
        i++;
        continue;
      }

      // ---- call: ident ( ... ) ----
      if (!isKw(v) && i + 1 < n && toks[i + 1].v === '(' && toks[i + 1].t === T.SYMBOL) {
        var isMethod = (i > 0 && toks[i - 1].v === '.');
        var isPath = (i > 0 && toks[i - 1].v === '::');
        var methodBase = null;
        if (isMethod && i - 2 >= 0 && toks[i - 2].t === T.IDENT && !isKw(toks[i - 2].v)) {
          methodBase = toks[i - 2].v; // `obj.method(...)` — obj is read (+maybe mutated)
        }
        var cEnd = matchBrace(i + 1, '(', ')');
        var ac = cEnd === -1 ? 0 : countTopArgs(toks, i + 2, cEnd);
        var cn = { kind: 'call', name: v, argCount: ac, line: tk.line, col: tk.col, spanLen: v.length, idx: i, isMethod: isMethod, isPath: isPath, endIdx: cEnd, base: methodBase };
        calls.push(cn);
        // args idents (token-order positions)
        if (cEnd !== -1) {
          for (var ci = i + 2; ci < cEnd; ci++) {
            var ct = toks[ci];
            if (ct.t === T.IDENT && !isKw(ct.v) && ct.v !== '_') {
              var cp = toks[ci - 1] ? toks[ci - 1].v : null;
              if (cp === '.' || cp === '::') continue;
              var cnx = ci + 1 < n ? toks[ci + 1].v : null;
              if (cnx === '::' || cnx === ':') continue;
              identUses.push({ name: ct.v, idx: ci, line: ct.line, col: ct.col, spanLen: ct.v.length });
              // `foo(&mut x)` mutates the caller's binding (like a method call)
              if (cp === 'mut' && toks[ci - 2] && toks[ci - 2].v === '&') {
                touchMut(ct.v, ci);
              }
            }
          }
        }
        i++;
        continue;
      }

      // ---- generic ident (possible var use: conditions, etc.) ----
      if (!isKw(v) && !KNOWN_MACROS[v]) {
        var pv = i > 0 ? toks[i - 1].v : null;
        var nx2 = i + 1 < n ? toks[i + 1].v : null;
        if (pv !== '.' && pv !== '::' && nx2 !== '::' && nx2 !== '!' && nx2 !== '(') {
          // Uppercase = types/ctors; `_` = wildcard; `name:` = field label.
          if (v !== '_' && nx2 !== ':' && !(v[0] >= 'A' && v[0] <= 'Z') && !inPatternPos(i)) {
            identUses.push({ name: v, idx: i, line: tk.line, col: tk.col, spanLen: v.length });
            // `*r = ...`: writes through the borrow — the TARGET is mutated
            // (resolves `let r = &x`; falls back to no-op when unknown)
            if (pv === '*' && (nx2 === '=' || nx2 === '+=' || nx2 === '-=' ||
                nx2 === '*=' || nx2 === '/=' || nx2 === '%=')) {
              var al = refAliases[v];
              if (al) touchMut(al.target, i);
            }
          }
        }
      }
      i++;
    }

    // during-scan mutation marker (byName isn't built until the scan ends):
    // flags the latest binding of `name` visible at token `idx`
    function touchMut(name, idx) {
      var best = null;
      for (var tm = 0; tm < lets.length; tm++) {
        if (lets[tm].name === name && lets[tm].idx < idx) best = lets[tm];
      }
      for (var te = 0; te < extraBindings.length; te++) {
        if (extraBindings[te].name === name && extraBindings[te].idx < idx &&
            (!best || extraBindings[te].idx > best.idx)) best = extraBindings[te];
      }
      if (best) { best.mutated = true; best.used = true; }
    }

    // ---- mark used/mutated ----
    // name -> bindings sorted by idx (lets + scope-aware pseudo-bindings)
    var byName = {};
    function addBinding(b) {
      if (!b.name || b.name === '_') return;
      (byName[b.name] = byName[b.name] || []).push(b);
    }
    for (var bi = 0; bi < lets.length; bi++) addBinding(lets[bi]);
    for (var ei = 0; ei < extraBindings.length; ei++) addBinding(extraBindings[ei]);
    for (var sk2 in byName) {
      byName[sk2].sort(function (a, b2) { return a.idx - b2.idx; });
    }
    function bindingFor(name, useIdx) {
      var arr = byName[name];
      if (!arr) return null;
      // binary search: rightmost binding with idx < useIdx (O(log n))
      var lo = 0, hi = arr.length - 1, ans = -1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (arr[mid].idx < useIdx) { ans = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      // walk back over out-of-scope pseudo-bindings (rare; ans usually hits)
      while (ans >= 0) {
        var cand = arr[ans];
        // scoped pseudo-bindings (fn params, loop/match/closure vars):
        // only visible inside [lo, hi]
        if (cand.lo === undefined || (useIdx >= cand.lo && useIdx <= cand.hi)) return cand;
        ans--;
      }
      return null;
    }
    for (var ui2 = 0; ui2 < identUses.length; ui2++) {
      var u2 = identUses[ui2];
      var bb = bindingFor(u2.name, u2.idx);
      if (bb) bb.used = true;
    }
    for (var aj = 0; aj < assigns.length; aj++) {
      var bb2 = bindingFor(assigns[aj].name, assigns[aj].idx);
      if (bb2) { bb2.mutated = true; bb2.used = true; }
    }
    // `obj.method(...)` reads obj; assume it may mutate (kills mut-never-mutated
    // false positives for push/insert/... — warnings stay conservative).
    for (var mj = 0; mj < calls.length; mj++) {
      if (calls[mj].isMethod && calls[mj].base) {
        var mb = bindingFor(calls[mj].base, calls[mj].idx);
        if (mb) { mb.mutated = true; mb.used = true; }
      }
    }

    // fn used marking: calls referencing fn names
    for (var cj = 0; cj < calls.length; cj++) {
      var cc = calls[cj];
      if (!cc.isMethod && fns[cc.name]) fns[cc.name].used = true;
    }

    // web handlers are "used" even though nothing calls them directly:
    // (a) `#[get("/")]`-style route attributes directly above the fn,
    // (b) `.service(handler)` / `.to(handler)` registrations.
    (function markRouteHandlers() {
      var ROUTE_ATTRS = { get: 1, post: 1, put: 1, delete: 1, head: 1, options: 1, patch: 1, trace: 1, connect: 1, route: 1 };
      function attrHasRoute(o, c) {
        for (var a = o; a < c; a++) {
          if (toks[a].t === T.IDENT && ROUTE_ATTRS[toks[a].v]) {
            var nx = toks[a + 1] ? toks[a + 1].v : null;
            if (nx === '(' || nx === '::') return true;
          }
        }
        return false;
      }
      for (var fn in fns) {
        var fi2 = fns[fn].firstIdx;
        if (fi2 === undefined) continue;
        // skip modifiers between attrs and `fn` (`async fn`, `pub(crate) fn`, ...)
        var j = fi2 - 1;
        while (j >= 0 && toks[j]) {
          var mjv = toks[j].v;
          if (toks[j].t === T.IDENT && (mjv === 'async' || mjv === 'pub' || mjv === 'unsafe' || mjv === 'const' || mjv === 'extern')) { j--; continue; }
          if (mjv === ')') {
            var mo = j, md = 0;
            while (mo >= 0) {
              if (toks[mo].v === ')') md++;
              else if (toks[mo].v === '(') { md--; if (md === 0) break; }
              mo--;
            }
            if (mo < 0) break;
            j = mo - 1; continue;
          }
          break;
        }
        var guards = 0;
        while (j >= 0 && toks[j] && toks[j].v === ']' && guards < 8) {
          guards++;
          var o2 = j, d3 = 0;
          while (o2 >= 0) {
            if (toks[o2].v === ']') d3++;
            else if (toks[o2].v === '[') { d3--; if (d3 === 0) break; }
            o2--;
          }
          if (o2 < 1 || !toks[o2 - 1] || toks[o2 - 1].v !== '#') break;
          if (attrHasRoute(o2 + 1, j)) { fns[fn].used = true; break; }
          j = o2 - 2;
        }
      }
      for (var rs = 2; rs < n - 2; rs++) {
        if (toks[rs].t === T.IDENT && (toks[rs].v === 'service' || toks[rs].v === 'to') &&
            toks[rs - 1] && toks[rs - 1].v === '.' && toks[rs + 1] && toks[rs + 1].v === '(') {
          var ra = rs + 2;
          if (toks[ra] && toks[ra].t === T.IDENT && toks[ra + 1] && toks[ra + 1].v === ')' && fns[toks[ra].v]) {
            fns[toks[ra].v].used = true;
          }
        }
      }
    })();

    // loop depth at kw positions: inside any loopRange?
    function insideRanges(ranges, idx) {
      for (var r = 0; r < ranges.length; r++) {
        if (idx > ranges[r].start && idx < ranges[r].end) return true;
      }
      return false;
    }

    // ================= ctx (what rules see) =================
    // normType is shared with out-of-file rule modules (borrow checker).
    function normTypeShared(a) {
      return normType(a);
    }
    var ctx = {
      src: src, toks: toks, lexErrs: lexErrs, lets: lets, assigns: assigns,
      calls: calls, macros: macros, kws: kws, fns: fns, fnOrder: fnOrder,
      structs: structs, uses: uses, stmts: stmts, identUses: identUses,
      strayCloses: strayCloses, stack: stack, loopRanges: loopRanges,
      fnRanges: fnRanges, hasMain: hasMain, isLib: !!opts.lib,
      modNames: modNames, useRoots: useRoots, externs: opts.externs || null,
      localMods: opts.localMods || null,
      current: null, byName: byName,
      bindingFor: bindingFor, insideRanges: insideRanges,
      infer: inferExprType, compat: typesCompatible
    };

    // ---- rule check implementations (src/rules/*.js) ----
    // Syntax (R*), types (T*), borrows (B*) and warnings (W*) attach their
    // ctx.check* methods here; the token scan above stays the core engine.
    if (RULES_MOD.attachAll) {
      try {
        RULES_MOD.attachAll(ctx, {
          T: T, BLOCK_KW: BLOCK_KW, PRINT_LIKE: PRINT_LIKE, isKw: isKw,
          countPlaceholders: countPlaceholders,
          hasOnlyNamedCaptures: hasOnlyNamedCaptures, normType: normTypeShared,
          KNOWN_TYPES: KNOWN_TYPES, KNOWN_MACROS: KNOWN_MACROS, KNOWN_FNS: KNOWN_FNS
        });
      } catch (eAttach) {}
    } else if (RULES_MOD.attachBorrow) {
      // legacy single-module shape (old src/rules.js without the folder index)
      try {
        RULES_MOD.attachBorrow(ctx, { T: T, isKw: isKw, normType: normTypeShared });
      } catch (eAttach2) {}
    }


    // ================= run RULES dispatch =================
    // anchor -> nodes
    var anchorNodes = {
      'stmt': stmts, 'decl': lets, 'assign': assigns, 'call': calls,
      'macro': macros, 'keyword': kws, 'eof': [null]
    };
    // T004 needs identUses too — handle by appending a pseudo pass:
    var extraUndeclaredDone = false;

    for (var ri = 0; ri < RULES.length; ri++) {
      var r = RULES[ri];
      var nodes = anchorNodes[r.anchor];
      if (!nodes) continue;
      if (r.anchor === 'eof') {
        ctx.current = null;
        var res = null;
        try { res = r.check(ctx); } catch (e) { res = null; }
        pushRes(res, r);
      } else {
        for (var ni = 0; ni < nodes.length; ni++) {
          // tiny fast-path: skip rules that can't apply to this node kind
          if (!applies(r, nodes[ni])) continue;
          ctx.current = nodes[ni];
          var res2 = null;
          try { res2 = r.check(ctx); } catch (e) { res2 = null; }
          pushRes(res2, r);
        }
      }
      // after T004 rule, also run identUses pass once
      if (r.id === 'T004' && !extraUndeclaredDone) {
        extraUndeclaredDone = true;
        var res3 = null;
        try { res3 = ctx.checkUndeclaredVars(); } catch (e) { res3 = null; }
        if (res3) {
          var arr = Array.isArray(res3) ? res3 : [res3];
          for (var q5 = 0; q5 < arr.length; q5++) {
            arr[q5].level = 'error'; arr[q5].code = arr[q5]._code || r.code;
            arr[q5].rule = r.id;
            delete arr[q5]._code;
            diags.push(arr[q5]);
          }
        }
      }
    }

    function pushRes(res, rule) {
      if (!res) return;
      var arr2 = Array.isArray(res) ? res : [res];
      for (var q6 = 0; q6 < arr2.length; q6++) {
        var d = arr2[q6];
        d.level = d.level || rule.level;
        d.code = d.code || d._code || rule.code;
        d.rule = rule.id;
        delete d._code;
        diags.push(d);
      }
    }

    // sort by position for rustc-like order
    diags.sort(function (a, b) { return (a.line - b.line) || (a.col - b.col); });

    var errCount = 0, warnCount = 0;
    for (var di = 0; di < diags.length; di++) {
      if (diags[di].level === 'warning') warnCount++; else errCount++;
    }

    return {
      diags: diags, errCount: errCount, warnCount: warnCount,
      lets: lets, assigns: assigns, calls: calls, macros: macros,
      fns: fns, structs: structs, toks: toks, lexErrs: lexErrs,
      success: errCount === 0
    };
  }

  function applies(rule, node) {
    if (!node) return false;
    switch (rule.id) {
      case 'R002': return node.kind === 'let' || node.kind === 'assign';
      case 'R003': return node.kind === 'let';
      case 'R004': return node.kind === 'fn';
      case 'R010': return node.kind === 'fn' || (node.kind === 'stmt' && !!BLOCK_KW[node.kw]);
      case 'R012': return node.kind === 'use';
      case 'R014': return node.kind === 'stmt' && node.sub === 'print-bang';
      case 'R015': return node.kind === 'kw';
      case 'R018': return node.kind === 'fn';
      case 'T001': case 'T005': return node.kind === 'let';
      case 'T002': case 'T003': return node.kind === 'assign';
      case 'T004': case 'T007': return node.kind === 'call';
      case 'T013': return node.kind === 'macro';
      case 'T015': case 'T016': return node.kind === 'kw';
      case 'T017': return node.kind === 'fn';
      default: return true;
    }
  }

  // ---------- type inference (simple, fast) ----------
  function inferExprType(valToks, byName, useIdx, structs) {
    if (!valToks || !valToks.length) return 'unknown';
    // skip leading `&` (references), then strip fully-wrapping parens:
    // `(T)` -> T, `()` -> (), `(a, b)` tuples -> unknown (pass, no false +)
    var i = 0;
    while (i < valToks.length && valToks[i].v === '&') i++;
    while (i < valToks.length && valToks[i].v === '(' && valToks[i].t === T.SYMBOL) {
      var me = matchInList(valToks, i);
      if (me !== valToks.length - 1) break; // not fully wrapped
      if (me === i + 1) return '()';
      var dd = 0, isTuple = false;
      for (var tc = i + 1; tc < me; tc++) {
        var wv = valToks[tc].v;
        if (wv === '(' || wv === '[' || wv === '{') dd++;
        else if (wv === ')' || wv === ']' || wv === '}') dd--;
        else if (wv === ',' && dd === 0) { isTuple = true; break; }
      }
      if (isTuple) return 'unknown';
      i++;
      while (i < valToks.length && valToks[i].v === '&') i++;
    }
    if (i >= valToks.length) return 'unknown';
    var f = valToks[i];

    // String::from / .to_string() / format! anywhere -> String
    var raw = '';
    for (var r = 0; r < valToks.length; r++) raw += valToks[r].v;
    if (raw.indexOf('to_string()') !== -1 || raw.indexOf('String::from') !== -1) return 'String';

    if (f.t === T.STRING || f.t === T.RAWSTR) return '&str';
    if (f.t === T.CHAR) return 'char';
    if (f.t === T.NUMBER) {
      var num = f.v;
      var low = num.toLowerCase();
      var m = low.match(/(i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64)$/);
      if (m) return m[1];
      if (low.indexOf('.') !== -1 || low.indexOf('e') !== -1) return 'float-lit';
      return 'int-lit';
    }
    if (f.t === T.IDENT) {
      if (f.v === 'true' || f.v === 'false') return 'bool';
      if (f.v === 'vec' || f.v === 'Vec') return 'Vec<_>';
      if (f.v === 'Some') return 'Option<_>';
      if (f.v === 'Ok' || f.v === 'Err') return 'Result<_, _>';
      if (f.v === 'format') return 'String';
      // var reference?
      if (byName && byName[f.v]) {
        var arr = byName[f.v], best = null;
        for (var k = 0; k < arr.length; k++) {
          if (arr[k].idx < useIdx) best = arr[k];
          else break;
        }
        if (best) {
          if (best.ann) return normType(best.ann);
          if (best.valToks && best.valToks.length && best !== undefined) {
            // shallow recurse (one level to avoid cycles)
            return shallowInfer(best.valToks);
          }
        }
      }
      // binary op: `x + 1` -> type of x
      return 'unknown';
    }
    if (f.v === '[') return 'Vec<_>';
    if (f.v === '(') {
      if (valToks.length === 2 + i && valToks[i + 1] && valToks[i + 1].v === ')') return '()';
      return 'unknown';
    }
    if (f.v === '-') {
      // negative literal
      if (valToks[i + 1] && valToks[i + 1].t === T.NUMBER) {
        var n2 = { t: T.NUMBER, v: valToks[i + 1].v };
        return inferExprType([n2], byName, useIdx, structs);
      }
    }
    return 'unknown';
  }

  // match `(` at arr[from] within a token ARRAY (for type inference)
  function matchInList(arr, from) {
    var d = 0;
    for (var k = from; k < arr.length; k++) {
      if (arr[k].v === '(') d++;
      else if (arr[k].v === ')') { d--; if (d === 0) return k; }
    }
    return -1;
  }

  function shallowInfer(valToks) {
    if (!valToks || !valToks.length) return 'unknown';
    var f = valToks[0];
    if (f.t === T.STRING || f.t === T.RAWSTR) return '&str';
    if (f.t === T.CHAR) return 'char';
    if (f.t === T.NUMBER) {
      var low = String(f.v).toLowerCase();
      var m = low.match(/(i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64)$/);
      if (m) return m[1];
      if (low.indexOf('.') !== -1) return 'float-lit';
      return 'int-lit';
    }
    if (f.v === 'true' || f.v === 'false') return 'bool';
    return 'unknown';
  }

  function normType(a) {
    return String(a).replace(/\s+/g, '');
  }

  function typesCompatible(ann, actual) {
    var a = normType(ann), b = normType(actual);
    if (b === 'unknown' || b === '_') return true;
    if (a === b) return true;
    // generic int/float literals fit any int/float type
    var ints = { 'i8': 1, 'i16': 1, 'i32': 1, 'i64': 1, 'i128': 1, 'isize': 1, 'u8': 1, 'u16': 1, 'u32': 1, 'u64': 1, 'u128': 1, 'usize': 1 };
    var floats = { 'f32': 1, 'f64': 1 };
    if (b === 'int-lit' && ints[a]) return true;
    if (b === 'float-lit' && floats[a]) return true;
    // &str vs &str with lifetime: &'a str == &str
    if (a.replace(/&'[a-z]+\s+/, '&') === b.replace(/&'[a-z]+\s+/, '&')) return true;
    return false;
  }

  // count top-level comma-separated args in toks[start, end)
  function countTopArgs(tk, start, end) {
    if (!tk) return 0;
    var d = 0, commas = 0, seen = false;
    for (var i = start; i < end; i++) {
      var v = tk[i].v;
      if (tk[i].t === T.SYMBOL) {
        if (v === '(' || v === '[' || v === '{') d++;
        else if (v === ')' || v === ']' || v === '}') d--;
        else if (v === ',' && d === 0) commas++;
        else if (d === 0 && v !== ',') seen = true;
      } else { if (d === 0) seen = true; }
    }
    if (!seen) return 0;
    return commas + 1;
  }

  function countPlaceholders(fmt) {
    // strip `{{` `}}`, then count `{...}` occurrences
    var s = String(fmt);
    // remove outer quotes
    if ((s[0] === '"' && s[s.length - 1] === '"') || s[0] === 'r') {
      var q = s.indexOf('"');
      if (q !== -1) s = s.slice(q);
    }
    s = s.replace(/{{/g, '').replace(/}}/g, '');
    var count = 0, k = 0;
    while ((k = s.indexOf('{', k)) !== -1) {
      var e = s.indexOf('}', k + 1);
      if (e === -1) break;
      var inside = s.slice(k + 1, e);
      // positional if empty or starts with : or digit
      if (inside === '' || inside[0] === ':' || (inside[0] >= '0' && inside[0] <= '9')) count++;
      // named `{name}` / `{name:?}` -> inline capture, not counted
      k = e + 1;
    }
    return count;
  }

  function hasOnlyNamedCaptures(fmt) {
    var s = String(fmt);
    s = s.replace(/{{/g, '').replace(/}}/g, '');
    var k = 0, hasPos = false, hasNamed = false;
    while ((k = s.indexOf('{', k)) !== -1) {
      var e = s.indexOf('}', k + 1);
      if (e === -1) break;
      var inside = s.slice(k + 1, e);
      if (inside === '' || inside[0] === ':' || (inside[0] >= '0' && inside[0] <= '9')) hasPos = true;
      else hasNamed = true;
      k = e + 1;
    }
    return hasNamed && !hasPos;
  }

  return { check: check, inferExprType: inferExprType, typesCompatible: typesCompatible, KEYWORDS: KEYWORDS };
}));

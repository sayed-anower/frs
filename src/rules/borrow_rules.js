/* frs/src/rules/borrow_rules.js — ownership & borrow checker (B-rules).
 * Part of src/rules/ (see src/rules/index.js). Pure JS, no deps.
 *
 * NLL-style model built from the checker's single-pass structures (lets,
 * assigns, calls, identUses + token stream). All queries resolve through
 * `bindingFor`, so shadowing and re-initialization behave like rustc:
 * a `let x = ...` shadow or `x = ...` re-init ends a moved state.
 *
 * Tracked (conservative, false-negative-leaning — unknown code passes):
 *   moves    `let y = x;` / `y = x;` / by-value call args / `drop(x)`
 *            where `x` is a non-Copy value (String, Vec, collections, user
 *            structs/enums). `.clone()`/`.to_owned()`/refs never move.
 *   borrows  `let r = &x;` / `let r = &mut x;` (+ short `foo(&x)` call borrows).
 *            A borrow is live from creation to the last use of its reference
 *            (NLL: a never-used borrow blocks nothing).
 *   Liveness + scope come from token order + `bindingFor` identity.
 *
 * Rules: B001 use-after-move (E0382), B002 double `&mut` (E0499),
 *        B003 use/mutation during live borrow (E0502), B004 move-while-
 *        borrowed (E0505), B005 `&mut` of non-`mut` binding (E0596),
 *        B006 return reference to local (E0515).
 *
 * Node   -> require('./borrow_rules.js')  (or the folder index)
 * Browser-> <script src="src/rules/borrow_rules.js"> gives `FRS_borrow_rules`
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.FRS_borrow_rules = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Non-Copy std types. Everything else (primitives, `&` refs, tuples of
  // Copy, unknown/generic) is treated as Copy -> never moves, never errors.
  var NONCOPY = {
    String: 1, Vec: 1, VecDeque: 1, HashMap: 1, HashSet: 1,
    BTreeMap: 1, BTreeSet: 1, Box: 1, PathBuf: 1, OsString: 1
  };
  var COPY_PRIMS = {
    i8: 1, i16: 1, i32: 1, i64: 1, i128: 1, isize: 1,
    u8: 1, u16: 1, u32: 1, u64: 1, u128: 1, usize: 1,
    f32: 1, f64: 1, bool: 1, char: 1, str: 1, '()': 1
  };
  // `&self`-style methods: calling them never mutates the base.
  var READ_METHODS = {
    len: 1, is_empty: 1, contains: 1, get: 1, first: 1, last: 1,
    as_str: 1, as_bytes: 1, starts_with: 1, ends_with: 1,
    is_some: 1, is_none: 1, is_ok: 1, is_err: 1,
    clone: 1, to_owned: 1, to_string: 1, trim: 1,
    split: 1, split_whitespace: 1, join: 1, parse: 1
  };
  // Taking ownership even without a known signature.
  var MOVE_FNS = { drop: 1, forget: 1 };
  // Constants / ctors that never move even when bare.
  var NON_MOVE_NAMES = {
    self: 1, Self: 1, true: 1, false: 1, Some: 1, None: 1, Ok: 1, Err: 1
  };

  var BORROW_RULES = [
    {
      id: 'B001', code: 'E0382', level: 'error', anchor: 'eof',
      name: 'use-after-move',
      desc: 'A moved value cannot be used again (unless re-initialized).',
      check: function (ctx) { return ctx.checkBorrowUseAfterMove(); }
    },
    {
      id: 'B002', code: 'E0499', level: 'error', anchor: 'eof',
      name: 'double-mut-borrow',
      desc: 'Cannot borrow as mutable more than once at a time.',
      check: function (ctx) { return ctx.checkBorrowDoubleMut(); }
    },
    {
      id: 'B003', code: 'E0502', level: 'error', anchor: 'eof',
      name: 'use-during-borrow',
      desc: 'Cannot use/mutate a value while it is borrowed incompatibly.',
      check: function (ctx) { return ctx.checkBorrowUseDuring(); }
    },
    {
      id: 'B004', code: 'E0505', level: 'error', anchor: 'eof',
      name: 'move-while-borrowed',
      desc: 'Cannot move out of a value while it is borrowed.',
      check: function (ctx) { return ctx.checkBorrowMoveWhileBorrowed(); }
    },
    {
      id: 'B005', code: 'E0596', level: 'error', anchor: 'eof',
      name: 'mut-borrow-of-immutable',
      desc: '`&mut x` needs `let mut x`.',
      check: function (ctx) { return ctx.checkBorrowMutOfImmutable(); }
    },
    {
      id: 'B006', code: 'E0515', level: 'error', anchor: 'eof',
      name: 'return-local-ref',
      desc: 'Cannot return a reference to a function-local value.',
      check: function (ctx) { return ctx.checkBorrowReturnLocal(); }
    }
  ];

  // ---------------------------------------------------------------- model

  function attachBorrow(ctx, shared) {
    shared = shared || {};
    var T = shared.T || { IDENT: 1 };
    var isKw = shared.isKw || function () { return false; };

    function getModel() {
      if (ctx.__borrow) return ctx.__borrow;
      var m = buildModel();
      ctx.__borrow = m;
      return m;
    }

    function buildModel() {
      var toks = ctx.toks, n = toks.length;
      var structs = ctx.structs || {};
      var fns = scanFns(toks, n, T, isKw);
      var aliases = scanAliases(ctx.lets); // refVar -> [{target, idx}]
      var borrows = [];
      var moves = [];
      var mutations = []; // {name, idx, binding, line, col, len, read}
      var i, k;
      function pushBorrow(target, kind, refVar, createIdx, srcPos, lastUse, line, col, partialOrCall) {
        borrows.push({
          target: target, kind: kind, refVar: refVar, createIdx: createIdx,
          srcPos: srcPos, lastUse: lastUse, line: line, col: col,
          binding: ctx.bindingFor(target, createIdx),
          partial: partialOrCall === true,
          fromCall: refVar === null
        });
      }

      function isRefVar(name, idx) {
        var arr = aliases[name];
        if (!arr) return false;
        var best = null;
        for (var a = 0; a < arr.length; a++) {
          if (arr[a].idx < idx && (!best || arr[a].idx > best.idx)) best = arr[a];
        }
        if (!best) return false;
        // cleared by a rebinding after the alias was created?
        if (rebound(name, best.idx, idx)) return false;
        return true;
      }
      function rebound(name, fromIdx, toIdx) {
        for (var r = 0; r < ctx.lets.length; r++) {
          var L = ctx.lets[r];
          if (L.name === name && L.idx > fromIdx && L.idx < toIdx) return true;
        }
        for (var s2 = 0; s2 < ctx.assigns.length; s2++) {
          var A = ctx.assigns[s2];
          if (A.name === name && A.idx > fromIdx && A.idx < toIdx) return true;
        }
        return false;
      }
      function bindingIsNonCopy(name, idx) {
        var b = ctx.bindingFor(name, idx);
        if (!b) return false;
        if (b.ann) return typeIsNonCopy(shared.normType ? shared.normType(b.ann) : b.ann, structs);
        if (b.valToks && b.valToks.length) {
          var t = ctx.infer(b.valToks, ctx.byName, b.idx, structs);
          return typeIsNonCopy(t, structs);
        }
        // fn params: look up the declared parameter kind
        if (b.src === 'param') {
          var pk = paramKind(name, idx, fns);
          return pk === 'move';
        }
        return false; // loop vars, patterns, unknown -> lenient Copy
      }
      function addMove(name, tokIdx, line, col) {
        if (NON_MOVE_NAMES[name]) return;
        if (!bindingIsNonCopy(name, tokIdx)) return;
        if (isRefVar(name, tokIdx)) return; // moving a `&` copies the ref
        var b = ctx.bindingFor(name, tokIdx);
        if (!b) return;
        moves.push({ name: name, idx: tokIdx, srcPos: tokIdx, line: line, col: col, len: name.length, binding: b });
      }

      // ---- moves: `let y = x;` / `y = x;`
      for (i = 0; i < ctx.lets.length; i++) {
        var L = ctx.lets[i];
        if (!L.hasEq || !L.valToks || L.valToks.length !== 1) continue;
        var vt = L.valToks[0];
        if (vt.t === T.IDENT && !isKw(vt.v)) addMove(vt.v, vt.pos, vt.line, vt.col);
      }
      for (i = 0; i < ctx.assigns.length; i++) {
        var A = ctx.assigns[i];
        if (!A.valToks || A.valToks.length !== 1) continue;
        var at = A.valToks[0];
        if (at.t === T.IDENT && !isKw(at.v)) addMove(at.v, at.pos, at.line, at.col);
      }
      // ---- moves: by-value call args + drop(x)
      for (i = 0; i < ctx.calls.length; i++) {
        var C = ctx.calls[i];
        if (C.isMethod || C.endIdx === -1 || C.endIdx === undefined) continue;
        if (C.idx + 1 >= n) continue;
        var args = splitTop(toks, C.idx + 2, C.endIdx);
        var kinds = fns[C.name] ? fns[C.name].params : null;
        for (k = 0; k < args.length; k++) {
          if (args[k].length !== 1) continue;
          var ak = args[k][0];
          if (ak.t !== T.IDENT || isKw(ak.v)) continue;
          if (MOVE_FNS[C.name]) { addMove(ak.v, ak.pos !== undefined ? ak.pos : C.idx, ak.line, ak.col); continue; }
          if (!kinds || k >= kinds.length) continue; // unknown fn -> lenient
          if (kinds[k].kind === 'move') addMove(ak.v, ak.pos !== undefined ? ak.pos : C.idx, ak.line, ak.col);
        }
        // short borrows: `foo(&x)` / `foo(&mut x)` live for the call only.
        // Bare `&x` args are precise; `&x[i]` / `&x.f` shapes are partial.
        if (C.endIdx !== -1) {
          for (var ci = C.idx + 2; ci < C.endIdx; ci++) {
            if (toks[ci].v === '&' && ci + 1 < C.endIdx) {
              var mk = ci + 1, kk = 'imm';
              if (toks[mk].v === 'mut' && toks[mk].t === T.IDENT) { kk = 'mut'; mk++; }
              if (mk < C.endIdx && toks[mk].t === T.IDENT && !isKw(toks[mk].v) && toks[mk].v !== 'self') {
                var after = toks[mk + 1] ? toks[mk + 1].v : ')';
                var precise = (mk + 1 >= C.endIdx) || after === ',' || after === ')';
                pushBorrow(toks[mk].v, kk, null, C.idx, toks[mk].pos !== undefined ? toks[mk].pos : ci,
                  C.endIdx, toks[ci].line, toks[ci].col, !precise);
              }
            }
          }
        }
      }
      // ---- borrows: `let r = &x;` / `let r = &mut x;` (+ `&x.field`, `&x[i]`)
      for (i = 0; i < ctx.lets.length; i++) {
        var L2 = ctx.lets[i];
        if (!L2.hasEq || !L2.valToks || !L2.valToks.length || L2.valToks[0].v !== '&') continue;
        if (!L2.name || L2.name === '_') continue;
        var q = 1, kind2 = 'imm';
        if (L2.valToks[q] && L2.valToks[q].v === 'mut') { kind2 = 'mut'; q++; }
        if (q >= L2.valToks.length || L2.valToks[q].t !== T.IDENT) continue;
        var tgt = L2.valToks[q].v;
        if (isKw(tgt) || tgt === 'self' || tgt === 'Self') continue;
        var partial = L2.valToks.length > q + 1; // `&x.f`, `&x[i]` — imprecise
        pushBorrow(tgt, kind2, L2.name, L2.idx,
          L2.valToks[q].pos, -1, L2.valToks[0].line, L2.valToks[0].col, partial);
      }
      // liveness: last use of each reference (NLL — dead refs block nothing)
      for (i = 0; i < borrows.length; i++) {
        var B = borrows[i];
        if (B.lastUse !== -1) continue; // call borrows already have one
        B.lastUse = lastRefUse(B.refVar, B.createIdx, fns, toks, n);
      }
      borrows = borrows.filter(function (B2) { return B2.lastUse > B2.createIdx; });

      // ---- mutations of plain bindings
      for (i = 0; i < ctx.assigns.length; i++) {
        var A2 = ctx.assigns[i];
        mutations.push({
          name: A2.name, idx: A2.idx, binding: ctx.bindingFor(A2.name, A2.idx),
          line: A2.line, col: A2.col, len: A2.name.length, read: false
        });
      }
      // deref writes `*r = ...` mutate the borrow target
      scanDerefWrites(toks, n, T, isKw, aliases, function (target, idx, line, col) {
        mutations.push({
          name: target, idx: idx, binding: ctx.bindingFor(target, idx),
          line: line, col: col, len: target.length, read: false, viaDeref: true
        });
      });
      // method calls: base is read, and mutated unless `&self`-style
      for (i = 0; i < ctx.calls.length; i++) {
        var C2 = ctx.calls[i];
        if (!C2.isMethod || !C2.base) continue;
        mutations.push({
          name: C2.base, idx: C2.idx, binding: ctx.bindingFor(C2.base, C2.idx),
          line: C2.line, col: C2.col, len: C2.base.length,
          read: !!READ_METHODS[C2.name], method: C2.name
        });
      }

      return { fns: fns, aliases: aliases, borrows: borrows, moves: moves, mutations: mutations, n: n };
    }

    function scanAliases(lets) {
      var out = {};
      for (var i = 0; i < lets.length; i++) {
        var L = lets[i];
        if (!L.hasEq || !L.valToks || L.valToks.length < 2 || L.valToks.length > 3) continue;
        if (L.valToks[0].v !== '&' || !L.name || L.name === '_') continue;
        var k = 1;
        if (L.valToks[k] && L.valToks[k].v === 'mut') k++;
        if (k < L.valToks.length && L.valToks[k].t === T.IDENT && k === L.valToks.length - 1) {
          (out[L.name] = out[L.name] || []).push({ target: L.valToks[k].v, idx: L.idx });
        }
      }
      return out;
    }

    // ---- the six checks ----

    ctx.checkBorrowUseAfterMove = function () {
      var m = getModel(), out = [];
      for (var i = 0; i < m.moves.length; i++) {
        var mv = m.moves[i];
        var uses = ctx.identUses;
        for (var u = 0; u < uses.length; u++) {
          var uu = uses[u];
          if (uu.name !== mv.name || uu.idx <= mv.idx || uu.idx === mv.srcPos) continue;
          if (ctx.bindingFor(uu.name, uu.idx) !== mv.binding) continue;
          if (reassigned(ctx, mv.name, mv.binding, mv.idx, uu.idx)) continue;
          out.push({
            msg: 'use of moved value: `' + mv.name + '`', line: uu.line, col: uu.col,
            spanLen: uu.name.length, label: 'value used here after move',
            hint: 'borrow with `&' + mv.name + '` or call `.clone()` if both are needed',
            note: 'move occurs here (-->' + mv.line + ':' + mv.col + ')'
          });
          break; // first use per move (rustc reports the first, too)
        }
      }
      return out.length ? out : null;
    };

    ctx.checkBorrowDoubleMut = function () {
      var m = getModel(), out = [], seen = {};
      var live = m.borrows.filter(function (B) { return !B.partial && B.kind === 'mut'; });
      if (live.length > 300) return null; // pathological file: stay fast
      for (var i = 0; i < live.length; i++) {
        for (var j = 0; j < live.length; j++) {
          if (i === j) continue;
          var A = live[i], B = live[j];
          if (A.binding !== B.binding || !A.binding) continue;
          if (B.createIdx > A.createIdx && B.createIdx < A.lastUse) {
            var key = B.refVar + '@' + B.createIdx;
            if (seen[key]) continue;
            seen[key] = 1;
            out.push({
              msg: 'cannot borrow `' + B.target + '` as mutable more than once at a time',
              line: B.line, col: B.col, spanLen: 4,
              label: 'second mutable borrow occurs here',
              hint: 'use the first borrow, or wait until it is last used'
            });
          }
        }
      }
      return out.length ? out : null;
    };

    ctx.checkBorrowUseDuring = function () {
      var m = getModel(), out = [], seen = {};
      var srcPos = {}; // borrow-creation RHS tokens are not "uses"
      m.borrows.forEach(function (B) { srcPos[B.target + '@' + B.srcPos] = 1; });
      var movePos = {};
      m.moves.forEach(function (M) { movePos[M.name + '@' + M.srcPos] = 1; });
      for (var i = 0; i < m.borrows.length; i++) {
        var B2 = m.borrows[i];
        if (B2.partial || !B2.binding) continue;
        if (B2.kind === 'mut') {
          // any direct use of the target while mutably borrowed (E0502)
          var uses = ctx.identUses;
          for (var u = 0; u < uses.length; u++) {
            var uu = uses[u];
            if (uu.name !== B2.target) continue;
            if (uu.idx <= B2.createIdx || uu.idx >= B2.lastUse) continue;
            if (uu.idx === B2.srcPos || srcPos[uu.name + '@' + uu.idx]) continue;
            if (movePos[uu.name + '@' + uu.idx]) continue; // B004 owns moves
            if (ctx.bindingFor(uu.name, uu.idx) !== B2.binding) continue;
            var k2 = 'u' + uu.idx;
            if (seen[k2]) continue;
            seen[k2] = 1;
            out.push({
              msg: 'cannot use `' + B2.target + '` because it was mutably borrowed',
              line: uu.line, col: uu.col, spanLen: uu.name.length,
              label: 'use of borrowed value',
              hint: 'wait until the borrow (`' + B2.refVar + '`) is last used'
            });
          }
          // method calls on the target count as uses, too
          for (var c = 0; c < ctx.calls.length; c++) {
            var C = ctx.calls[c];
            if (!C.isMethod || C.base !== B2.target) continue;
            if (C.idx <= B2.createIdx || C.idx >= B2.lastUse) continue;
            if (ctx.bindingFor(C.base, C.idx) !== B2.binding) continue;
            var k3 = 'c' + C.idx;
            if (seen[k3]) continue;
            seen[k3] = 1;
            out.push({
              msg: 'cannot use `' + B2.target + '` because it was mutably borrowed',
              line: C.line, col: C.col, spanLen: C.base.length,
              label: 'use of borrowed value',
              hint: 'wait until the borrow (`' + B2.refVar + '`) is last used'
            });
          }
          // (borrow-vs-borrow conflicts handled in the shared loop below)
        }
        // incompatible borrow creations inside a live range (E0502, all kinds)
        for (var o = 0; o < m.borrows.length; o++) {
          var Bo = m.borrows[o];
          if (Bo === B2 || Bo.partial || B2.partial || !Bo.binding || Bo.binding !== B2.binding) continue;
          if (Bo.createIdx <= B2.createIdx || Bo.createIdx >= B2.lastUse) continue;
          var ko = 'o' + Bo.createIdx;
          if (seen[ko]) continue;
          seen[ko] = 1;
          if (B2.kind === 'mut') {
            out.push({
              msg: 'cannot borrow `' + Bo.target + '` as ' +
                (Bo.kind === 'mut' ? 'mutable' : 'immutable') +
                ' because it is also borrowed as mutable',
              line: Bo.line, col: Bo.col, spanLen: Bo.kind === 'mut' ? 4 : 1,
              label: 'incompatible borrow occurs here',
              hint: 'wait until the borrow (`' + (B2.refVar || 'here') + '`) is last used'
            });
          } else if (Bo.kind === 'mut') {
            out.push({
              msg: 'cannot borrow `' + Bo.target + '` as mutable because it is also borrowed as immutable',
              line: Bo.line, col: Bo.col, spanLen: 4,
              label: 'mutable borrow occurs here',
              hint: 'wait until the shared borrow (`' + (B2.refVar || 'here') + '`) is last used'
            });
          }
        }
        if (B2.kind !== 'mut') {
          // mutation of the target while immutably borrowed (E0502)
          for (var q = 0; q < m.mutations.length; q++) {
            var M2 = m.mutations[q];
            if (M2.read || M2.name !== B2.target) continue;
            if (M2.idx <= B2.createIdx || M2.idx >= B2.lastUse) continue;
            if (!M2.binding || M2.binding !== B2.binding) continue;
            var k4 = 'm' + M2.idx;
            if (seen[k4]) continue;
            seen[k4] = 1;
            out.push({
              msg: 'cannot borrow `' + B2.target + '` as mutable because it is also borrowed as immutable',
              line: M2.line, col: M2.col, spanLen: M2.len,
              label: 'mutable borrow occurs here',
              hint: 'wait until the shared borrow (`' + B2.refVar + '`) is last used'
            });
          }
        }
      }
      return out.length ? out : null;
    };

    ctx.checkBorrowMoveWhileBorrowed = function () {
      var m = getModel(), out = [];
      for (var i = 0; i < m.moves.length; i++) {
        var mv = m.moves[i];
        for (var b = 0; b < m.borrows.length; b++) {
          var B = m.borrows[b];
          if (!B.binding || B.binding !== mv.binding) continue;
          if (mv.idx > B.createIdx && mv.idx < B.lastUse) {
            out.push({
              msg: 'cannot move out of `' + mv.name + '` because it is borrowed',
              line: mv.line, col: mv.col, spanLen: mv.len,
              label: 'move occurs while borrowed',
              hint: 'wait until the borrow (`' + (B.refVar || 'here') + '`) is last used'
            });
            break;
          }
        }
      }
      return out.length ? out : null;
    };

    ctx.checkBorrowMutOfImmutable = function () {
      var m = getModel(), out = [];
      for (var i = 0; i < m.borrows.length; i++) {
        var B = m.borrows[i];
        if (B.kind !== 'mut') continue;
        var b = B.binding || ctx.bindingFor(B.target, B.createIdx);
        if (b && b.kind === 'let' && !b.isMut) {
          out.push({
            msg: 'cannot borrow `' + B.target + '` as mutable, as it is not declared as mutable',
            line: B.line, col: B.col, spanLen: 4,
            label: 'immutable binding',
            hint: 'declare with `let mut ' + B.target + ' ...`'
          });
        }
      }
      return out.length ? out : null;
    };

    ctx.checkBorrowReturnLocal = function () {
      var m = getModel(), out = [];
      var names = Object.keys(m.fns);
      for (var i = 0; i < names.length; i++) {
        var F = m.fns[names[i]];
        if (!F.retHasRef || F.bodyStart === -1) continue;
        var localLets = {};
        for (var l = 0; l < ctx.lets.length; l++) {
          var L = ctx.lets[l];
          if (L.idx > F.bodyStart && L.idx < F.bodyEnd && L.name && L.name !== '_') localLets[L.name] = 1;
        }
        for (var t = F.bodyStart; t < F.bodyEnd; t++) {
          var tk = ctx.toks[t];
          if (!tk || tk.v !== '&') continue;
          var nx = ctx.toks[t + 1];
          if (!nx || nx.t !== T.IDENT) continue;
          if (!localLets[nx.v]) continue;
          out.push({
            msg: 'cannot return reference to local variable `' + nx.v + '`',
            line: nx.line, col: nx.col, spanLen: nx.v.length + 1,
            label: 'returns a reference to data owned by the function',
            hint: 'return an owned value instead, or a `\'static` reference'
          });
          break;
        }
      }
      return out.length ? out : null;
    };

  }

  // ---------------------------------------------------------------- scans
  // (pure helpers: only touch their arguments)

  function typeIsNonCopy(ty, structs) {
    var t = String(ty || 'unknown').replace(/\s+/g, '');
    if (!t || t === 'unknown' || t === '_') return false;
    if (t[0] === '&') return false; // shared refs are Copy
    if (COPY_PRIMS[t]) return false;
    if (t === 'int-lit' || t === 'float-lit') return false;
    var base = t.split('<')[0].split('(')[0].split('[')[0];
    base = base.replace(/^mut\s+/, '');
    if (NONCOPY[base]) return true;
    if (structs && structs[base]) return true; // user struct/enum
    return false; // unknown -> lenient Copy
  }

  function paramKind(name, idx, fns) {
    var names = Object.keys(fns);
    for (var i = 0; i < names.length; i++) {
      var F = fns[names[i]];
      if (idx >= F.sigStart && idx <= F.bodyEnd) {
        for (var p = 0; p < F.params.length; p++) {
          if (F.params[p].name === name) return F.params[p].kind;
        }
      }
    }
    return null;
  }

  function scanFns(toks, n, T, isKw) {
    var out = {};
    for (var i = 0; i < n; i++) {
      if (toks[i].t !== T.IDENT || toks[i].v !== 'fn') continue;
      if (i + 1 >= n || toks[i + 1].t !== T.IDENT) continue;
      var name = toks[i + 1].v, k = i + 2;
      if (toks[k] && toks[k].v === '<') { // generics: skip balanced
        var gd = 0;
        while (k < n) {
          if (toks[k].v === '<') gd++;
          else if (toks[k].v === '>') { gd--; if (gd === 0) { k++; break; } }
          k++;
        }
      }
      if (!toks[k] || toks[k].v !== '(') continue;
      var ce = matchBrace(toks, k, '(', ')');
      if (ce === -1) continue;
      var parts = splitTop(toks, k + 1, ce);
      var params = [];
      for (var p = 0; p < parts.length; p++) {
        var part = parts[p], nm = null, ty = '', isMut = false;
        for (var q = 0; q < part.length; q++) {
          if (part[q].t === T.IDENT && !isKw(part[q].v) && part[q + 1] && part[q + 1].v === ':') {
            nm = part[q].v;
            if (q > 0 && part[q - 1].v === 'mut') isMut = true;
            ty = part.slice(q + 2).map(function (t) { return t.v; }).join('');
            break;
          }
        }
        if (nm === 'self' || nm === null) {
          if (nm) params.push({ name: nm, kind: 'copy', isMut: isMut });
          continue;
        }
        var kind = 'copy';
        if (/^&/.test(ty)) kind = 'ref';
        else {
          var base = ty.split('<')[0].replace(/[^A-Za-z0-9_]/g, '');
          if (NONCOPY[base]) kind = 'move';
        }
        params.push({ name: nm, kind: kind, isMut: isMut, ty: ty });
      }
      var ak = ce + 1, retHasRef = false;
      if (toks[ak] && toks[ak].v === '->') {
        var rk = ak + 1, depth = 0;
        while (rk < n) {
          var rv = toks[rk].v;
          if ((rv === '{' || rv === ';') && depth === 0) break;
          if (rv === '(' || rv === '[' || rv === '{' || rv === '<') depth++;
          else if (rv === ')' || rv === ']' || rv === '}' || rv === '>') depth--;
          if (rv === '&' && depth === 0) retHasRef = true;
          if (toks[rk].t === T.IDENT && toks[rk].v === 'where' && depth === 0) break;
          rk++;
          if (rk - ak > 60) break;
        }
        ak = rk;
        if (toks[ak] && toks[ak].v === 'where') {
          while (ak < n && toks[ak].v !== '{' && toks[ak].v !== ';') ak++;
        }
      }
      var bodyStart = -1, bodyEnd = -1;
      if (toks[ak] && toks[ak].v === '{') {
        bodyStart = ak;
        var be = matchBrace(toks, ak, '{', '}');
        bodyEnd = be === -1 ? n - 1 : be;
      }
      out[name] = {
        params: params, retHasRef: retHasRef,
        sigStart: i, bodyStart: bodyStart, bodyEnd: bodyEnd
      };
    }
    return out;
  }

  function scanDerefWrites(toks, n, T, isKw, aliases, emit) {
    for (var i = 0; i + 2 < n; i++) {
      if (toks[i].v !== '*') continue;
      var j = i + 1;
      while (j < n && toks[j].v === '*') j++;
      if (j >= n || toks[j].t !== T.IDENT || isKw(toks[j].v)) continue;
      var nx = toks[j + 1] ? toks[j + 1].v : null;
      if (nx !== '=' && nx !== '+=' && nx !== '-=' && nx !== '*=' && nx !== '/=' && nx !== '%=') continue;
      var target = resolveAlias(aliases, toks[j].v, i);
      if (!target) continue;
      emit(target, i, toks[j].line, toks[j].col);
    }
  }

  function resolveAlias(aliases, name, idx) {
    var arr = aliases[name];
    if (!arr) return null;
    var best = null;
    for (var a = 0; a < arr.length; a++) {
      if (arr[a].idx < idx && (!best || arr[a].idx > best.idx)) best = arr[a];
    }
    return best ? best.target : null;
  }

  function lastRefUse(refVar, createIdx, fns, toks, n) {
    if (!refVar) return createIdx;
    // enclosing fn body (or whole file) bounds the NLL region
    var lo = 0, hi = n, names = Object.keys(fns);
    for (var i = 0; i < names.length; i++) {
      var F = fns[names[i]];
      if (F.bodyStart !== -1 && createIdx > F.bodyStart && createIdx < F.bodyEnd) {
        lo = F.bodyStart; hi = F.bodyEnd; break;
      }
    }
    var last = createIdx;
    for (var t = lo; t < hi; t++) {
      if (toks[t].t === 1 && toks[t].v === refVar && t > createIdx) {
        // token-order index lives on `.pos` (checker stamps it); fall back to t
        var pi = toks[t].pos !== undefined ? toks[t].pos : t;
        if (pi > last) last = pi;
      }
    }
    return last;
  }

  function reassigned(ctx, name, binding, fromIdx, toIdx) {
    for (var i = 0; i < ctx.assigns.length; i++) {
      var A = ctx.assigns[i];
      if (A.name !== name || A.idx <= fromIdx || A.idx >= toIdx) continue;
      if (ctx.bindingFor(A.name, A.idx) === binding) return true;
    }
    return false;
  }

  function splitTop(toks, start, end) {
    var out = [], d = 0, cur = [];
    for (var i = start; i < end; i++) {
      var v = toks[i].v;
      if (v === '(' || v === '[' || v === '{') { d++; cur.push(toks[i]); }
      else if (v === ')' || v === ']' || v === '}') { d--; cur.push(toks[i]); }
      else if (v === ',' && d === 0) { out.push(cur); cur = []; }
      else cur.push(toks[i]);
    }
    if (cur.length || out.length) out.push(cur);
    return out;
  }

  function matchBrace(toks, from, open, close) {
    var d = 0;
    for (var i = from; i < toks.length; i++) {
      if (toks[i].v === open) d++;
      else if (toks[i].v === close) { d--; if (d === 0) return i; }
    }
    return -1;
  }

  // `RULES`/`attach` aliases match the other src/rules/*.js modules so the
  // folder index can treat every module uniformly (`BORROW_RULES` /
  // `attachBorrow` kept for back-compat).
  return { RULES: BORROW_RULES, attach: attachBorrow, BORROW_RULES: BORROW_RULES, attachBorrow: attachBorrow };
}));


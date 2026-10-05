/* frs/src/rules/type_rules.js — T* rules: mutability, names, types, calls.
 * Each entry is {id, code, level, anchor, name, desc, check(ctx)}.
 * `attachTypes(ctx, shared)` installs the ctx.check* implementations.
 * Pure JS, no deps. Node: require('./type_rules.js'). Browser: FRS_rules_types.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.FRS_rules_types = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TYPE_RULES = [
    {
      id: 'T001', code: 'E0308', level: 'error', anchor: 'decl',
      name: 'let-type-mismatch',
      desc: '`let x: T = v` — value type must match T.',
      check: function (ctx) { return ctx.checkLetType(); }
    },
    {
      id: 'T002', code: 'E0308', level: 'error', anchor: 'assign',
      name: 'assign-type-mismatch',
      desc: 'Reassignment must keep the original type.',
      check: function (ctx) { return ctx.checkAssignType(); }
    },
    {
      id: 'T003', code: 'E0384', level: 'error', anchor: 'assign',
      name: 'assign-to-immutable',
      desc: 'Cannot assign to immutable binding; use `let mut`.',
      check: function (ctx) { return ctx.checkMutAssign(); }
    },
    {
      id: 'T004', code: 'E0425', level: 'error', anchor: 'call',
      name: 'undeclared-var',
      desc: 'Variable used before declaration.',
      check: function (ctx) { return ctx.checkUndeclared(); }
    },
    {
      id: 'T005', code: 'E0412', level: 'error', anchor: 'decl',
      name: 'unknown-type',
      desc: 'Type annotation must be a known type.',
      check: function (ctx) { return ctx.checkKnownType(); }
    },
    {
      id: 'T007', code: 'E0107', level: 'error', anchor: 'call',
      name: 'arg-count-mismatch',
      desc: 'Call must pass the same number of args as the definition.',
      check: function (ctx) { return ctx.checkArgCount(); }
    },
    {
      id: 'T013', code: null, level: 'error', anchor: 'macro',
      name: 'format-arg-mismatch',
      desc: 'println!/format! placeholders must match arg count.',
      check: function (ctx) { return ctx.checkFormatArgs(); }
    },
    {
      id: 'T015', code: null, level: 'error', anchor: 'keyword',
      name: 'break-outside-loop',
      desc: '`break`/`continue` only valid inside a loop.',
      check: function (ctx) { return ctx.checkBreakOutside(); }
    },
    {
      id: 'T016', code: null, level: 'error', anchor: 'keyword',
      name: 'return-outside-fn',
      desc: '`return` only valid inside a function.',
      check: function (ctx) { return ctx.checkReturnOutside(); }
    },
    {
      id: 'T017', code: 'E0255', level: 'error', anchor: 'stmt',
      name: 'duplicate-item',
      desc: 'Duplicate top-level fn/struct/enum name.',
      check: function (ctx) { return ctx.checkDuplicateItem(); }
    },
    {
      id: 'T018', code: 'E0433', level: 'error', anchor: 'eof',
      name: 'unknown-crate',
      desc: '`use foo::...` where `foo` is not a dependency (project mode only).',
      check: function (ctx) { return ctx.checkUnknownCrate(); }
    }
  ];

  function attachTypes(ctx, shared) {
    shared = shared || {};
    var isKw = shared.isKw || function () { return false; };
    var PRINT_LIKE = shared.PRINT_LIKE || {};
    var KNOWN_TYPES = shared.KNOWN_TYPES || {};
    var KNOWN_MACROS = shared.KNOWN_MACROS || {};
    var KNOWN_FNS = shared.KNOWN_FNS || {};
    var normType = shared.normType || function (a) { return String(a).replace(/\s+/g, ''); };

    ctx.checkLetType = function () {
      var dl = ctx.current;
      if (!dl || dl.kind !== 'let' || !dl.ann || !dl.hasEq) return null;
      var actual = ctx.infer(dl.valToks, ctx.byName, dl.idx, ctx.structs);
      if (!actual || actual === 'unknown') return null;
      if (!ctx.compat(dl.ann, actual)) {
        return {
          msg: 'mismatched types', line: dl.nameLine, col: dl.nameCol,
          spanLen: Math.max(1, String(dl.valToks.map(function (x) { return x.v; }).join(' ')).length > 40 ? dl.nameLen : dl.nameLen),
          label: 'expected `' + normType(dl.ann) + '`, found `' + actual + '`',
          hint: 'change the annotation or the value',
          _code: 'E0308'
        };
      }
      return null;
    };

    ctx.checkAssignType = function () {
      var an2 = ctx.current;
      if (!an2 || an2.kind !== 'assign') return null;
      var bb3 = ctx.bindingFor(an2.name, an2.idx);
      if (!bb3) return null;
      if (!bb3.ann && (!bb3.valToks || !bb3.valToks.length)) return null; // param/loop var: unknown type, pass
      var orig = bb3.ann || ctx.infer(bb3.valToks, ctx.byName, bb3.idx, ctx.structs);
      if (!orig || orig === 'unknown') return null;
      var act = ctx.infer(an2.valToks, ctx.byName, an2.idx, ctx.structs);
      if (!act || act === 'unknown') return null;
      if (!ctx.compat(orig, act)) {
        return { msg: 'mismatched types', line: an2.line, col: an2.col, spanLen: an2.name.length, label: 'expected `' + normType(orig) + '`, found `' + act + '`', hint: 'value must keep type `' + normType(orig) + '`', _code: 'E0308' };
      }
      return null;
    };

    ctx.checkMutAssign = function () {
      var an3 = ctx.current;
      if (!an3 || an3.kind !== 'assign') return null;
      var bb4 = ctx.bindingFor(an3.name, an3.idx);
      if (bb4 && !bb4.isMut && bb4.name !== '_') {
        var h = bb4.src === 'for'
          ? 'use `for mut ' + an3.name + ' ...`'
          : 'declare with `let mut ' + an3.name + ' ...`';
        return { msg: 'cannot assign to immutable variable `' + an3.name + '`', line: an3.line, col: an3.col, spanLen: an3.name.length, label: 'immutable binding', hint: h, _code: 'E0384' };
      }
      return null;
    };

    ctx.checkUndeclared = function () {
      var cn2 = ctx.current;
      if (!cn2) return null;
      if (cn2.kind === 'call') {
        if (cn2.isMethod || cn2.isPath) return null;
        if (isKw(cn2.name) || KNOWN_TYPES[cn2.name] || ctx.structs[cn2.name]) return null;
        if (ctx.fns[cn2.name] || KNOWN_FNS[cn2.name]) return null;
        // Uppercase = probably type ctor; skip
        if (cn2.name[0] >= 'A' && cn2.name[0] <= 'Z') return null;
        // if it's a declared var used as fn? still undeclared-fn error? report as undeclared var-ish
        if (ctx.bindingFor(cn2.name, cn2.idx)) return null; // var shadows (calling var — different error, skip)
        // only flag if it looks like unknown function AND not a method chain artifact
        // To reduce false positives on std fns (e.g. foo::bar), only flag lowercase bare calls
        // that are never defined anywhere. This matches rustc E0425.
        return { msg: 'cannot find function `' + cn2.name + '` in this scope', line: cn2.line, col: cn2.col, spanLen: cn2.name.length, label: 'not found', hint: 'define `fn ' + cn2.name + '(...)` or check spelling', _code: 'E0425' };
      }
      return null;
    };

    // undeclared variable uses (from identUses, anchor 'call' too — reuse)
    ctx.checkUndeclaredVars = function () {
      var out3 = [];
      var seen = {};
      var identUses = ctx.identUses;
      for (var g = 0; g < identUses.length; g++) {
        var uu = identUses[g];
        if (isKw(uu.name) || KNOWN_TYPES[uu.name] || ctx.structs[uu.name] || ctx.fns[uu.name] || KNOWN_MACROS[uu.name]) continue;
        if (uu.name[0] >= 'A' && uu.name[0] <= 'Z') continue;
        if (uu.name === 'Ok' || uu.name === 'Err' || uu.name === 'Some' || uu.name === 'None') continue;
        if (!ctx.bindingFor(uu.name, uu.idx)) {
          var key = uu.name + '@' + uu.line + ':' + uu.col;
          if (seen[key]) continue;
          seen[key] = 1;
          out3.push({ msg: 'cannot find value `' + uu.name + '` in this scope', line: uu.line, col: uu.col, spanLen: uu.name.length, label: 'not found in this scope', hint: 'define `let ' + uu.name + ' = ...` first', _code: 'E0425' });
        }
      }
      return out3.length ? out3 : null;
    };

    // unresolved extern crate roots (`use nosuch::x;` when `nosuch` is neither
    // a dependency nor std/core/alloc). Only active when the caller passes
    // `opts.externs` (project mode); single-file mode skips it.
    ctx.checkUnknownCrate = function () {
      if (!ctx.externs) return null;
      var out = [];
      var seen = {};
      var alwaysOk = { std: 1, core: 1, alloc: 1 };
      var local = null;
      if (ctx.localMods) {
        local = {};
        for (var li = 0; li < ctx.localMods.length; li++) local[ctx.localMods[li]] = 1;
      }
      for (var g = 0; g < ctx.useRoots.length; g++) {
        var u = ctx.useRoots[g];
        if (alwaysOk[u.root] || seen[u.root]) continue;
        seen[u.root] = 1;
        if (ctx.modNames[u.root]) continue; // local `mod foo;` — relative path, not extern
        if (local && local[u.root]) continue; // sibling module file in the same crate
        var found = false;
        var want = String(u.root).replace(/-/g, '_');
        for (var e = 0; e < ctx.externs.length; e++) {
          if (String(ctx.externs[e]).replace(/-/g, '_') === want) { found = true; break; }
        }
        if (!found) {
          out.push({
            msg: 'unresolved import `use ' + u.root + '::...`',
            line: u.line, col: u.col, spanLen: u.root.length,
            label: 'unlinked crate', hint: 'add `' + u.root + '` to `[dependencies]` in Cargo.toml',
            _code: 'E0433'
          });
        }
      }
      return out.length ? out : null;
    };

    ctx.checkKnownType = function () {
      var dl2 = ctx.current;
      if (!dl2 || dl2.kind !== 'let' || !dl2.ann) return null;
      var a = normType(dl2.ann);
      // strip generics/ref/slices for base check: Vec<i32> -> Vec
      var base = a.split('<')[0].replace(/\[\]/g, '').replace(/\(.*\)/, '').replace(/;/g, '');
      base = base.replace(/^&+/, '').replace(/^mut\s+/, '').trim();
      // allow tuples/arrays: (i32, bool), [u8; 4]
      if (/^\(.*\)$/.test(a) || /^\[.*\]$/.test(a)) {
        // check each inner word? keep simple: pass
        return null;
      }
      // allow references &: &i32, &mut String, &'a str
      base = base.replace(/^'.*?\s+/, '');
      if (!base) return null;
      var first = base.split(/[^A-Za-z0-9_]/)[0];
      if (!first) return null;
      if (KNOWN_TYPES[first] || ctx.structs[first] || first === '_') return null;
      return { msg: 'cannot find type `' + first + '` in this scope', line: dl2.nameLine, col: dl2.nameCol, spanLen: dl2.nameLen, label: 'unknown type', hint: 'did you mean `i32`, `String`, `bool`...?', _code: 'E0412' };
    };

    ctx.checkArgCount = function () {
      var cn3 = ctx.current;
      if (!cn3 || cn3.kind !== 'call' || cn3.isMethod || cn3.isPath) return null;
      var f = ctx.fns[cn3.name];
      if (!f || f.params === -1) return null;
      // allow `main` skip; self-methods already excluded
      if (cn3.argCount !== f.params) {
        return { msg: 'this function takes ' + f.params + ' argument' + (f.params === 1 ? '' : 's') + ' but ' + cn3.argCount + ' ' + (cn3.argCount === 1 ? 'was' : 'were') + ' supplied', line: cn3.line, col: cn3.col, spanLen: cn3.name.length, label: 'expected ' + f.params + ', found ' + cn3.argCount, hint: 'check `fn ' + cn3.name + '(...)` signature', _code: 'E0107' };
      }
      return null;
    };

    ctx.checkFormatArgs = function () {
      var m = ctx.current;
      if (!m || m.kind !== 'macro') return null;
      if (!PRINT_LIKE[m.name] || m.fmtStr === null) return null;
      if (m.placeholders > m.argCount) {
        return { msg: m.argCount + ' argument(s) given but format string needs ' + m.placeholders, line: m.line, col: m.col, spanLen: m.name.length + 1, label: 'missing ' + (m.placeholders - m.argCount) + ' argument(s)', hint: 'add values: ' + m.name + '!("...", val)' };
      }
      return null;
    };

    ctx.checkBreakOutside = function () {
      var k2 = ctx.current;
      if (k2 && k2.kind === 'kw' && (k2.kw === 'break' || k2.kw === 'continue')) {
        if (!ctx.insideRanges(ctx.loopRanges, k2.idx)) {
          return { msg: '`' + k2.kw + '` outside of a loop', line: k2.line, col: k2.col, spanLen: k2.kw.length, label: 'not inside a loop', hint: 'remove `' + k2.kw + '` or wrap code in `loop { ... }`' };
        }
      }
      return null;
    };

    ctx.checkReturnOutside = function () {
      var k3 = ctx.current;
      if (k3 && k3.kind === 'kw' && k3.kw === 'return') {
        if (!ctx.insideRanges(ctx.fnRanges, k3.idx)) {
          return { msg: '`return` outside of a function', line: k3.line, col: k3.col, spanLen: 6, label: 'not inside `fn`', hint: 'remove `return` or wrap code in a function' };
        }
      }
      return null;
    };

    ctx.checkDuplicateItem = function () {
      var dl3 = ctx.current;
      if (!dl3 || dl3.kind !== 'fn' || !dl3.name) return null;
      var f2 = ctx.fns[dl3.name];
      if (f2 && f2.count > 1 && dl3.idx !== f2.firstIdx) {
        return { msg: 'the name `' + dl3.name + '` is defined multiple times', line: dl3.line, col: dl3.col, spanLen: 2 + dl3.name.length, label: 'redefined here', hint: 'rename one definition', _code: 'E0255' };
      }
      return null;
    };
  }

  return { RULES: TYPE_RULES, attachTypes: attachTypes };
}));

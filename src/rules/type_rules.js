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

    // ---- generic-wildcard compat: `Vec<_>` / `Option<_>` / `Result<_,_>`
    // match any concrete generic args (rustc infers `Vec::new()` / `vec![]`
    // / `Ok(..)` against the annotation). Core `compat` stays untouched;
    // this wrapper only ADDS passes, never new errors.
    if (!ctx.__wildcardCompat) {
      ctx.__wildcardCompat = 1;
      var __origCompat = ctx.compat;
      ctx.compat = function (ann, actual) {
        if (__origCompat(ann, actual)) return true;
        return genericWildcardCompat(normType(ann), normType(actual));
      };
    }

    // ---- host-OS cfg gating (rustc parity): code under a false
    // `#[cfg(target_os = "..")]` / `#[cfg(target_family = "..")]` /
    // `#[cfg(windows|unix|linux|macos)]` / `#[cfg(test)]` / not/any/all
    // is NOT compiled for this host (linux/mac/windows via Node
    // process.platform; unknown hosts stay lenient and compile everything).
    installCfgHelper(ctx);

    // ---- method-chain inference: the core infers from the FIRST token
    // (`"42".parse()` -> `&str`, `v.len()` -> type-of-`v`), which
    // false-positives on annotated bindings. The LAST `.method()` in the
    // chain decides the value type; unknown shapes stay `unknown` (pass).
    if (!ctx.__methodInfer) {
      ctx.__methodInfer = 1;
      var __origInfer = ctx.infer;
      ctx.infer = function (valToks, byName, useIdx, structs) {
        var mt = methodChainType(valToks);
        if (mt !== null) return mt;
        return __origInfer(valToks, byName, useIdx, structs);
      };
    }

    function methodChainType(valToks) {
      if (!valToks || !valToks.length) return null;
      // last `.name(` at depth 0 of the token slice
      var last = -1, d = 0;
      for (var q = 0; q + 2 < valToks.length + 1; q++) {
        var w = valToks[q] ? valToks[q].v : null;
        if (w === '(' || w === '[' || w === '{') d++;
        else if (w === ')' || w === ']' || w === '}') d--;
        else if (d === 0 && w === '.' && valToks[q + 1] &&
            valToks[q + 2] && valToks[q + 2].v === '(' &&
            /^[A-Za-z_]/.test(valToks[q + 1].v)) {
          last = q + 1;
        }
      }
      if (last === -1) return null;
      var m = valToks[last].v;
      if (m === 'len' || m === 'capacity') return 'usize';
      if (m === 'is_empty' || m === 'contains' || m === 'starts_with' ||
          m === 'ends_with' || m === 'is_some' || m === 'is_none' ||
          m === 'is_ok' || m === 'is_err' || m === 'eq' || m === 'ne' ||
          m === 'lt' || m === 'gt') return 'bool';
      if (m === 'to_string' || m === 'to_owned' || m === 'to_lowercase' ||
          m === 'to_uppercase' || m === 'join' || m === 'replace' ||
          m === 'repeat' || m === 'trim_start_matches') return 'String';
      if (m === 'trim' || m === 'trim_start' || m === 'trim_end' ||
          m === 'as_str' || m === 'get') return null; // keep core guess (often right)
      if (m === 'clone') return null; // same type as base: core handles it
      return 'unknown'; // parse/unwrap/expect/collect/find/map/...: pass
    }

    function genericWildcardCompat(a, b) {
      if (!a || !b || b === 'unknown' || a === 'unknown') return true;
      if (a === b || b === '_') return true;
      var pa = parseGeneric(a), pb = parseGeneric(b);
      if (!pa || !pb) return false;
      if (pa.base !== pb.base || pa.args.length !== pb.args.length) return false;
      for (var k = 0; k < pa.args.length; k++) {
        var xa = pa.args[k], xb = pb.args[k];
        if (xa === '_' || xb === '_' || xa === xb) continue;
        // nested generics: recurse structurally
        if (xa.indexOf('<') !== -1 || xb.indexOf('<') !== -1) {
          if (!genericWildcardCompat(xa, xb)) return false;
          continue;
        }
        return false;
      }
      return true;
    }

    function parseGeneric(s) {
      var lt = s.indexOf('<');
      if (lt === -1) return null;
      if (s[s.length - 1] !== '>') return null;
      var inner = s.slice(lt + 1, -1);
      return { base: s.slice(0, lt), args: splitTopType(inner) };
    }

    function splitTopType(s) {
      var out = [], d = 0, cur = '';
      for (var q = 0; q < s.length; q++) {
        var c = s[q];
        if (c === '<' || c === '(' || c === '[') { d++; cur += c; }
        else if (c === '>' || c === ')' || c === ']') { d--; cur += c; }
        else if (c === ',' && d === 0) { out.push(cur.trim()); cur = ''; }
        else cur += c;
      }
      if (cur.trim() !== '' || out.length) out.push(cur.trim());
      return out;
    }

    ctx.checkLetType = function () {
      var dl = ctx.current;
      if (!dl || dl.kind !== 'let' || !dl.ann || !dl.hasEq) return null;
      if (ctx.isCfgGatedOut && ctx.isCfgGatedOut(dl.nameLine, dl.nameCol)) return null;
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
      if (ctx.isCfgGatedOut && ctx.isCfgGatedOut(an2.line, an2.col)) return null;
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
      if (ctx.isCfgGatedOut && ctx.isCfgGatedOut(an3.line, an3.col)) return null;
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
        if (ctx.isCfgGatedOut && ctx.isCfgGatedOut(cn2.line, cn2.col)) return null;
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
    // Lenient by design (unknown code passes):
    //  - idents inside non-evaluated / unknown-macro bodies are not values
    //    (`stringify!(hi)`, outer `println!("{}", my_macro!(x))` — the core
    //    skips unknown-macro bodies, so these would otherwise false-positive);
    //  - an ident at its own binding site (match-arm `n @ ...` / `n if ...`
    //    patterns bind at the same token index) is a definition, not a use;
    //  - cfg-gated-out code is not compiled (rustc parity).
    var NOEVAL_MACROS = {
      stringify: 1, cfg: 1, compile_error: 1, env: 1, option_env: 1,
      include: 1, include_str: 1, include_bytes: 1
    };
    ctx.checkUndeclaredVars = function () {
      var out3 = [];
      var seen = {};
      var identUses = ctx.identUses;
      var skipRanges = null; // lazy: token-idx ranges that hold no values
      function inSkip(idx) {
        if (skipRanges === null) {
          skipRanges = [];
          for (var m = 0; m < ctx.macros.length; m++) {
            var mc = ctx.macros[m];
            if (mc.endIdx === -1 || mc.endIdx === undefined) continue;
            var cfgGate = mc.name === 'cfg_if' ||
              (mc.name.length > 4 && mc.name.slice(0, 4) === 'cfg_');
            if (NOEVAL_MACROS[mc.name]) {
              skipRanges.push({ s: mc.idx, e: mc.endIdx });
            } else if (!KNOWN_MACROS[mc.name] && !cfgGate) {
              skipRanges.push({ s: mc.idx, e: mc.endIdx });
            }
          }
        }
        for (var q = 0; q < skipRanges.length; q++) {
          if (idx > skipRanges[q].s && idx < skipRanges[q].e) return true;
        }
        return false;
      }
      for (var g = 0; g < identUses.length; g++) {
        var uu = identUses[g];
        if (isKw(uu.name) || KNOWN_TYPES[uu.name] || ctx.structs[uu.name] || ctx.fns[uu.name] || KNOWN_MACROS[uu.name]) continue;
        if (uu.name[0] >= 'A' && uu.name[0] <= 'Z') continue;
        if (uu.name === 'Ok' || uu.name === 'Err' || uu.name === 'Some' || uu.name === 'None') continue;
        if (inSkip(uu.idx)) continue;
        if (ctx.isCfgGatedOut && ctx.isCfgGatedOut(uu.line, uu.col)) continue;
        if (!ctx.bindingFor(uu.name, uu.idx)) {
          // binding declared AT this exact token (match-arm `@`/guard
          // patterns, `for`/`|` params): a definition, not a use. The core
          // `bindingFor` needs idx < useIdx, so it misses these.
          if (isBindingSite(uu.name, uu.idx)) continue;
          var key = uu.name + '@' + uu.line + ':' + uu.col;
          if (seen[key]) continue;
          seen[key] = 1;
          out3.push({ msg: 'cannot find value `' + uu.name + '` in this scope', line: uu.line, col: uu.col, spanLen: uu.name.length, label: 'not found in this scope', hint: 'define `let ' + uu.name + ' = ...` first', _code: 'E0425' });
        }
      }
      return out3.length ? out3 : null;
    };

    function isBindingSite(name, idx) {
      var arr = ctx.byName && ctx.byName[name];
      if (!arr) return false;
      for (var b = 0; b < arr.length; b++) {
        if (arr[b].idx === idx) return true;
      }
      return false;
    }

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
        if (ctx.isCfgGatedOut && ctx.isCfgGatedOut(u.line, u.col)) continue;
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
      if (ctx.isCfgGatedOut && ctx.isCfgGatedOut(dl2.nameLine, dl2.nameCol)) return null;
      var a = normType(dl2.ann);
      // qualified paths (`winit::Foo`), trait objects (`dyn Display`,
      // `impl Trait`), fn pointers and `+`-bounds resolve via imports —
      // never flag them.
      if (a.indexOf('::') !== -1) return null;
      if (/(^|&)dyn[A-Z]/.test(a) || /(^|&)impl[A-Z]/.test(a) ||
          a.indexOf('+') !== -1 || a.indexOf('fn(') !== -1) return null;
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
      if (first[0] === '_') return null; // `_`, `_T`: placeholders / must_use hints
      if (KNOWN_TYPES[first] || ctx.structs[first] || first === '_') return null;
      return { msg: 'cannot find type `' + first + '` in this scope', line: dl2.nameLine, col: dl2.nameCol, spanLen: dl2.nameLen, label: 'unknown type', hint: 'did you mean `i32`, `String`, `bool`...?', _code: 'E0412' };
    };

    ctx.checkArgCount = function () {
      var cn3 = ctx.current;
      if (!cn3 || cn3.kind !== 'call' || cn3.isMethod || cn3.isPath) return null;
      if (ctx.isCfgGatedOut && ctx.isCfgGatedOut(cn3.line, cn3.col)) return null;
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
      if (ctx.isCfgGatedOut && ctx.isCfgGatedOut(m.line, m.col)) return null;
      if (!PRINT_LIKE[m.name] || m.fmtStr === null) return null;
      if (m.placeholders > m.argCount) {
        return { msg: m.argCount + ' argument(s) given but format string needs ' + m.placeholders, line: m.line, col: m.col, spanLen: m.name.length + 1, label: 'missing ' + (m.placeholders - m.argCount) + ' argument(s)', hint: 'add values: ' + m.name + '!("...", val)' };
      }
      return null;
    };

    ctx.checkBreakOutside = function () {
      var k2 = ctx.current;
      if (k2 && k2.kind === 'kw' && (k2.kw === 'break' || k2.kw === 'continue')) {
        if (ctx.isCfgGatedOut && ctx.isCfgGatedOut(k2.line, k2.col)) return null;
        if (!ctx.insideRanges(ctx.loopRanges, k2.idx)) {
          return { msg: '`' + k2.kw + '` outside of a loop', line: k2.line, col: k2.col, spanLen: k2.kw.length, label: 'not inside a loop', hint: 'remove `' + k2.kw + '` or wrap code in `loop { ... }`' };
        }
      }
      return null;
    };

    ctx.checkReturnOutside = function () {
      var k3 = ctx.current;
      if (k3 && k3.kind === 'kw' && k3.kw === 'return') {
        if (ctx.isCfgGatedOut && ctx.isCfgGatedOut(k3.line, k3.col)) return null;
        if (!ctx.insideRanges(ctx.fnRanges, k3.idx)) {
          return { msg: '`return` outside of a function', line: k3.line, col: k3.col, spanLen: 6, label: 'not inside `fn`', hint: 'remove `return` or wrap code in a function' };
        }
      }
      return null;
    };

    ctx.checkDuplicateItem = function () {
      var dl3 = ctx.current;
      if (!dl3 || dl3.kind !== 'fn' || !dl3.name) return null;
      if (ctx.isCfgGatedOut && ctx.isCfgGatedOut(dl3.line, dl3.col)) return null;
      var f2 = ctx.fns[dl3.name];
      if (f2 && f2.count > 1 && dl3.idx !== f2.firstIdx) {
        return { msg: 'the name `' + dl3.name + '` is defined multiple times', line: dl3.line, col: dl3.col, spanLen: 2 + dl3.name.length, label: 'redefined here', hint: 'rename one definition', _code: 'E0255' };
      }
      return null;
    };
  }

  // ---- host-OS cfg gating shared helper (rustc parity) ----
  // First module to attach wins; every rule file carries this same copy so
  // no cross-module load order is required. Code under a cfg that is false
  // for the current host (linux/mac/windows via Node, lenient elsewhere)
  // is NOT compiled: all rules skip it, like rustc.
  function installCfgHelper(ctx) {
    if (ctx.isCfgGatedOut) return;
    var host = (function () {
      try {
        if (typeof process !== 'undefined' && process && process.platform) {
          var p = process.platform, arch = null;
          try {
            var a = process.arch;
            if (a === 'x64') arch = 'x86_64';
            else if (a === 'arm64') arch = 'aarch64';
            else if (a === 'ia32') arch = 'x86';
            else if (typeof a === 'string') arch = a;
          } catch (eA) {}
          if (p === 'win32') return { os: 'windows', family: 'windows', arch: arch };
          if (p === 'darwin') return { os: 'macos', family: 'unix', arch: arch };
          if (p === 'linux') return { os: 'linux', family: 'unix', arch: arch };
          return { os: null, family: null, arch: arch };
        }
      } catch (eH) {}
      return { os: null, family: null, arch: null };
    })();
    var ranges = null;
    ctx.__cfgHost = host;
    ctx.isCfgGatedOut = function (line, col) {
      if (ranges === null) ranges = computeGatedRanges(ctx, host);
      for (var i = 0; i < ranges.length; i++) {
        var r = ranges[i];
        if (line < r.sl || line > r.el) continue;
        if (line === r.sl && col < r.sc) continue;
        if (line === r.el && col > r.ec) continue;
        return true;
      }
      return false;
    };
  }

  function computeGatedRanges(ctx, host) {
    var toks = ctx.toks, n = toks.length, out = [];
    var i = 0;
    while (i < n - 1) {
      if (toks[i].v === '#' && toks[i + 1] && toks[i + 1].v === '[') {
        var close = findClose(toks, i + 1, '[', ']');
        if (close === -1) { i++; continue; }
        // collect a stack of consecutive attributes above one item
        var stack = [{ open: i + 1, close: close }];
        var j = close + 1;
        while (j < n - 1 && toks[j].v === '#' && toks[j + 1] && toks[j + 1].v === '[') {
          var c2 = findClose(toks, j + 1, '[', ']');
          if (c2 === -1) break;
          stack.push({ open: j + 1, close: c2 });
          j = c2 + 1;
        }
        var itemIdx = skipMods(toks, j, n);
        var itemEnd = itemExtent(toks, itemIdx, n);
        var gated = false;
        for (var s = 0; s < stack.length; s++) {
          var pred = cfgPredToks(toks, stack[s].open, stack[s].close);
          if (pred && !evalCfgPred(pred, host)) { gated = true; break; }
        }
        if (gated && itemIdx < n && itemEnd >= itemIdx) {
          out.push({
            sl: toks[itemIdx].line, sc: toks[itemIdx].col,
            el: toks[Math.min(itemEnd, n - 1)].line,
            ec: toks[Math.min(itemEnd, n - 1)].col + 1
          });
        }
        i = j;
        continue;
      }
      i++;
    }
    return out;
  }

  function skipMods(toks, j, n) {
    var k = j, guard = 0;
    while (k < n && guard++ < 8) {
      var w = toks[k] && toks[k].v;
      if (w === 'pub' || w === 'unsafe' || w === 'async' || w === 'const' || w === 'extern') { k++; continue; }
      if (w === 'crate' && toks[k + 1] && toks[k + 1].v === '(') {
        var ce = findClose(toks, k + 1, '(', ')');
        k = ce === -1 ? k + 1 : ce + 1;
        continue;
      }
      break;
    }
    return k;
  }

  var CFG_ITEMS = {
    fn: 1, struct: 1, enum: 1, union: 1, mod: 1, static: 1, const: 1,
    type: 1, use: 1, impl: 1, trait: 1, macro_rules: 1, extern: 1
  };

  function itemExtent(toks, from, n) {
    if (from >= n || !toks[from]) return from;
    if (!CFG_ITEMS[toks[from].v]) return from; // not an item: gate just this token
    for (var k = from + 1; k < Math.min(n, from + 80); k++) {
      var w = toks[k].v;
      if (w === ';') return k;
      if (w === '{') {
        var e = findClose(toks, k, '{', '}');
        return e === -1 ? k : e;
      }
    }
    return Math.min(n - 1, from + 4);
  }

  function findClose(toks, open, o, c) {
    var d = 0;
    for (var k = open; k < toks.length; k++) {
      if (toks[k].v === o) d++;
      else if (toks[k].v === c) { d--; if (d === 0) return k; }
    }
    return -1;
  }

  // inner tokens of `#[cfg(...)]` (null when this attribute is not a cfg)
  function cfgPredToks(toks, open, close) {
    for (var k = open + 1; k < close; k++) {
      if (toks[k].v === 'cfg' && toks[k + 1] && toks[k + 1].v === '(') {
        var e = k + 1, d = 0, end = -1;
        for (var q = k + 1; q <= close; q++) {
          if (toks[q].v === '(') d++;
          else if (toks[q].v === ')') { d--; if (d === 0) { end = q; break; } }
        }
        if (end === -1) return null;
        return toks.slice(k + 2, end);
      }
    }
    return null;
  }

  function evalCfgPred(pred, host) {
    var pos = 0;
    function peek() { return pos < pred.length ? pred[pos].v : null; }
    function parseOr() {
      var v = parseAtom();
      while (peek() === ',') { pos++; var rhs = parseAtom(); v = v || rhs; }
      return v;
    }
    function parseAtom() {
      var w = peek();
      if (w === 'not' && pred[pos + 1] && pred[pos + 1].v === '(') {
        pos += 2;
        var v = parseOr();
        if (peek() === ')') pos++;
        return !v;
      }
      if ((w === 'any' || w === 'all') && pred[pos + 1] && pred[pos + 1].v === '(') {
        var isAny = w === 'any';
        pos += 2;
        var acc = isAny ? false : true, first = true;
        while (pos < pred.length && peek() !== ')') {
          if (peek() === ',') { pos++; continue; }
          var cv = parseAtom();
          acc = isAny ? (acc || cv) : (acc && cv);
          first = false;
        }
        if (!first && pos >= pred.length) return acc;
        if (peek() === ')') pos++;
        return acc;
      }
      // key = "value"  or  key = value  or bare ident
      var key = w;
      pos++;
      if (peek() === '=') {
        pos++;
        var val = peek() || '';
        pos++;
        if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') {
          val = val.slice(1, -1);
        }
        return evalCfgKey(key, val, host);
      }
      return evalCfgBare(key, host);
    }
    if (!pred.length) return true;
    var r = parseOr();
    return !!r;
  }

  function evalCfgBare(key, host) {
    if (key === 'test') return false; // normal (non-test) build
    if (key === 'debug_assertions') return true;
    if (key === 'doc') return false;
    if (key === 'unix') return host.family ? host.family === 'unix' : true;
    if (key === 'windows') return host.family ? host.family === 'windows' : true;
    if (key === 'linux' || key === 'macos' || key === 'ios' ||
        key === 'android' || key === 'freebsd' || key === 'openbsd') {
      return host.os ? host.os === key : true;
    }
    return true; // unknown flags (feature gates, custom cfgs): stay compiled
  }

  function evalCfgKey(key, val, host) {
    if (key === 'target_os') return host.os ? host.os === val : true;
    if (key === 'target_family') return host.family ? host.family === val : true;
    if (key === 'target_arch') return host.arch ? host.arch === val : true;
    return true; // target_env / feature / target_feature / ... : lenient
  }

  return { RULES: TYPE_RULES, attachTypes: attachTypes };
}));

/* frs/src/rules/warn_rules.js — W* rules: unused bindings and functions.
 * Each entry is {id, code, level, anchor, name, desc, check(ctx)}.
 * `attachWarn(ctx, shared)` installs the ctx.check* implementations.
 * Pure JS, no deps. Node: require('./warn_rules.js'). Browser: FRS_rules_warn.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.FRS_rules_warn = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var WARN_RULES = [
    {
      id: 'W001', code: null, level: 'warning', anchor: 'eof',
      name: 'unused-variable',
      desc: 'Variable never read after definition.',
      check: function (ctx) { return ctx.checkUnusedVars(); }
    },
    {
      id: 'W002', code: null, level: 'warning', anchor: 'eof',
      name: 'unused-function',
      desc: 'Function never called (except main).',
      check: function (ctx) { return ctx.checkUnusedFns(); }
    },
    {
      id: 'W003', code: null, level: 'warning', anchor: 'eof',
      name: 'mut-never-mutated',
      desc: '`let mut` that is never mutated.',
      check: function (ctx) { return ctx.checkMutNeverUsed(); }
    }
  ];

  function attachWarn(ctx, shared) {
    installCfgHelperW(ctx);
    // Names referenced as values (desktop/GUI callbacks like
    // `dioxus::launch(app)`, `thread::spawn(f)`, `.service(handler)`)
    // count as uses even without a direct `name(...)` call, which is all
    // the core scan marks. Gated-out items are not compiled (rustc parity).
    var usedAsValue = null;
    function isUsedAsValue(name) {
      if (usedAsValue === null) {
        usedAsValue = {};
        // Only references that bind to NOTHING are fn-value uses
        // (`dioxus::launch(app)`); shadowed locals resolve to a binding
        // and must not mark the fn used.
        for (var u = 0; u < ctx.identUses.length; u++) {
          var uu = ctx.identUses[u];
          if (!ctx.bindingFor(uu.name, uu.idx)) usedAsValue[uu.name] = 1;
        }
      }
      return !!usedAsValue[name];
    }
    function hasAllowDead(tokIdx) {
      // `#[allow(dead_code)]` / `#[allow(unused...)]` directly above
      var toks = ctx.toks;
      var j = tokIdx - 1, guards = 0;
      while (j >= 0 && toks[j] && toks[j].v === ']' && guards < 4) {
        guards++;
        var o = j, d = 0;
        while (o >= 0) {
          if (toks[o].v === ']') d++;
          else if (toks[o].v === '[') { d--; if (d === 0) break; }
          o--;
        }
        if (o < 1 || !toks[o - 1] || toks[o - 1].v !== '#') break;
        for (var a = o + 1; a < j; a++) {
          if (toks[a].v === 'allow' && toks[a + 1] && toks[a + 1].v === '(') {
            for (var b = a + 2; b < j; b++) {
              if (toks[b].v === 'dead_code' || toks[b].v === 'unused') return true;
            }
          }
        }
        j = o - 2;
      }
      return false;
    }
    ctx.checkUnusedVars = function () {
      var out4 = [];
      var lets = ctx.lets;
      for (var b4 = 0; b4 < lets.length; b4++) {
        var lb = lets[b4];
        if (!lb.name || lb.name === '_' || lb.name[0] === '_') continue;
        if (ctx.isCfgGatedOut && ctx.isCfgGatedOut(lb.nameLine, lb.nameCol)) continue;
        if (!lb.used) {
          out4.push({ msg: 'unused variable: `' + lb.name + '`', line: lb.nameLine, col: lb.nameCol, spanLen: lb.nameLen, label: 'never read', hint: 'prefix with `_`: `_' + lb.name + '`' });
        }
      }
      return out4.length ? out4 : null;
    };

    ctx.checkUnusedFns = function () {
      var out5 = [];
      var fns = ctx.fns, fnOrder = ctx.fnOrder;
      for (var fi2 = 0; fi2 < fnOrder.length; fi2++) {
        var fn2 = fnOrder[fi2];
        if (fn2 === 'main') continue;
        if (!fns[fn2].used && !isUsedAsValue(fn2)) {
          if (ctx.isCfgGatedOut && ctx.isCfgGatedOut(fns[fn2].line, fns[fn2].col)) continue;
          if (hasAllowDead(fns[fn2].firstIdx)) continue;
          out5.push({ msg: 'function `' + fn2 + '` is never used', line: fns[fn2].line, col: fns[fn2].col, spanLen: 2 + fn2.length, label: 'never called', hint: 'remove it or prefix with `_`' });
        }
      }
      return out5.length ? out5 : null;
    };

    ctx.checkMutNeverUsed = function () {
      var out6 = [];
      var lets = ctx.lets;
      for (var b5 = 0; b5 < lets.length; b5++) {
        var lb2 = lets[b5];
        if (lb2.isMut && !lb2.mutated && lb2.name && lb2.name !== '_') {
          if (ctx.isCfgGatedOut && ctx.isCfgGatedOut(lb2.nameLine, lb2.nameCol)) continue;
          // the core scan only records `= += -= *= /= %=` as mutations;
          // `<<= >>= &= |= ^=` mutate too (prompt.txt op list) — re-scan.
          if (hasMissedCompoundMut(lb2.name, lb2.idx)) continue;
          out6.push({ msg: 'variable `' + lb2.name + '` does not need to be mutable', line: lb2.nameLine, col: lb2.nameCol, spanLen: lb2.nameLen, label: 'never mutated', hint: 'remove `mut`' });
        }
      }
      return out6.length ? out6 : null;
    };

    // `x <<= ..` / `>>=` / `&= ` / `|=` / `^=` — valid mutations the core
    // assignment scan does not record (it covers `= += -= *= /= %=`).
    function hasMissedCompoundMut(name, declIdx) {
      var toks = ctx.toks, n = toks.length;
      for (var q = 0; q + 1 < n; q++) {
        var tk = toks[q];
        if (!tk || tk.v !== name) continue;
        if (q <= declIdx) continue;
        var pv = q > 0 && toks[q - 1] ? toks[q - 1].v : null;
        if (pv === '.' || pv === '::') continue; // field/path, not the binding
        var nx = toks[q + 1];
        if (nx && (nx.v === '<<=' || nx.v === '>>=' || nx.v === '&=' ||
            nx.v === '|=' || nx.v === '^=')) return true;
      }
      return false;
    }
  }

  // ---- host-OS cfg gating shared helper (rustc parity) ----
  // Same copy as in the other rule files; first module to attach wins.
  function installCfgHelperW(ctx) {
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
      if (ranges === null) ranges = computeGatedRangesW(ctx, host);
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

  function computeGatedRangesW(ctx, host) {
    var toks = ctx.toks, n = toks.length, out = [];
    var i = 0;
    while (i < n - 1) {
      if (toks[i].v === '#' && toks[i + 1] && toks[i + 1].v === '[') {
        var close = findCloseW(toks, i + 1, '[', ']');
        if (close === -1) { i++; continue; }
        var stack = [{ open: i + 1, close: close }];
        var j = close + 1;
        while (j < n - 1 && toks[j].v === '#' && toks[j + 1] && toks[j + 1].v === '[') {
          var c2 = findCloseW(toks, j + 1, '[', ']');
          if (c2 === -1) break;
          stack.push({ open: j + 1, close: c2 });
          j = c2 + 1;
        }
        var itemIdx = skipModsW(toks, j, n);
        var itemEnd = itemExtentW(toks, itemIdx, n);
        var gated = false;
        for (var s = 0; s < stack.length; s++) {
          var pred = cfgPredToksW(toks, stack[s].open, stack[s].close);
          if (pred && !evalCfgPredW(pred, host)) { gated = true; break; }
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

  function skipModsW(toks, j, n) {
    var k = j, guard = 0;
    while (k < n && guard++ < 8) {
      var w = toks[k] && toks[k].v;
      if (w === 'pub' || w === 'unsafe' || w === 'async' || w === 'const' || w === 'extern') { k++; continue; }
      if (w === 'crate' && toks[k + 1] && toks[k + 1].v === '(') {
        var ce = findCloseW(toks, k + 1, '(', ')');
        k = ce === -1 ? k + 1 : ce + 1;
        continue;
      }
      break;
    }
    return k;
  }

  var CFG_ITEMS_W = {
    fn: 1, struct: 1, enum: 1, union: 1, mod: 1, static: 1, const: 1,
    type: 1, use: 1, impl: 1, trait: 1, macro_rules: 1, extern: 1
  };

  function itemExtentW(toks, from, n) {
    if (from >= n || !toks[from]) return from;
    if (!CFG_ITEMS_W[toks[from].v]) return from;
    for (var k = from + 1; k < Math.min(n, from + 80); k++) {
      var w = toks[k].v;
      if (w === ';') return k;
      if (w === '{') {
        var e = findCloseW(toks, k, '{', '}');
        return e === -1 ? k : e;
      }
    }
    return Math.min(n - 1, from + 4);
  }

  function findCloseW(toks, open, o, c) {
    var d = 0;
    for (var k = open; k < toks.length; k++) {
      if (toks[k].v === o) d++;
      else if (toks[k].v === c) { d--; if (d === 0) return k; }
    }
    return -1;
  }

  function cfgPredToksW(toks, open, close) {
    for (var k = open + 1; k < close; k++) {
      if (toks[k].v === 'cfg' && toks[k + 1] && toks[k + 1].v === '(') {
        var d = 0, end = -1;
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

  function evalCfgPredW(pred, host) {
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
      var key = w;
      pos++;
      if (peek() === '=') {
        pos++;
        var val = peek() || '';
        pos++;
        if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') {
          val = val.slice(1, -1);
        }
        return evalCfgKeyW(key, val, host);
      }
      return evalCfgBareW(key, host);
    }
    if (!pred.length) return true;
    return !!parseOr();
  }

  function evalCfgBareW(key, host) {
    if (key === 'test') return false;
    if (key === 'debug_assertions') return true;
    if (key === 'doc') return false;
    if (key === 'unix') return host.family ? host.family === 'unix' : true;
    if (key === 'windows') return host.family ? host.family === 'windows' : true;
    if (key === 'linux' || key === 'macos' || key === 'ios' ||
        key === 'android' || key === 'freebsd' || key === 'openbsd') {
      return host.os ? host.os === key : true;
    }
    return true;
  }

  function evalCfgKeyW(key, val, host) {
    if (key === 'target_os') return host.os ? host.os === val : true;
    if (key === 'target_family') return host.family ? host.family === val : true;
    if (key === 'target_arch') return host.arch ? host.arch === val : true;
    return true;
  }

  return { RULES: WARN_RULES, attachWarn: attachWarn };
}));

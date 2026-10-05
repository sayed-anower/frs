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
    ctx.checkUnusedVars = function () {
      var out4 = [];
      var lets = ctx.lets;
      for (var b4 = 0; b4 < lets.length; b4++) {
        var lb = lets[b4];
        if (!lb.name || lb.name === '_' || lb.name[0] === '_') continue;
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
        if (!fns[fn2].used) {
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
          out6.push({ msg: 'variable `' + lb2.name + '` does not need to be mutable', line: lb2.nameLine, col: lb2.nameCol, spanLen: lb2.nameLen, label: 'never mutated', hint: 'remove `mut`' });
        }
      }
      return out6.length ? out6 : null;
    };
  }

  return { RULES: WARN_RULES, attachWarn: attachWarn };
}));

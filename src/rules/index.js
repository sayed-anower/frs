/* frs/src/rules/index.js — one import for every rule module.
 *
 *   Node:    require('./rules/index.js')  (or the back-compat src/rules.js)
 *   Browser: load each src/rules/*.js via <script> (see index.html order),
 *            then this file merges the `FRS_rules_*` globals.
 *
 * Exports: { RULES, KNOWN_TYPES, KNOWN_MACROS, KNOWN_FNS, attachAll }.
 * `attachAll(ctx, shared)` installs every module's ctx.check* methods on
 * the checker's analysis context. Missing modules degrade to empty
 * (their rules simply don't run) — never a crash.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(
      require('./known.js'),
      require('./syntax_rules.js'),
      require('./type_rules.js'),
      require('./borrow_rules.js'),
      require('./warn_rules.js')
    );
  } else {
    root.FRS_rules_merged = factory(
      root.FRS_rules_known,
      root.FRS_rules_syntax,
      root.FRS_rules_types,
      root.FRS_borrow_rules,
      root.FRS_rules_warn
    );
  }
}(typeof self !== 'undefined' ? self : this, function (KNOWN_MOD, SYN_MOD, TYP_MOD, BOR_MOD, WRN_MOD) {
  'use strict';

  var MODULES = [SYN_MOD, TYP_MOD, BOR_MOD, WRN_MOD];

  function modRules(m) {
    if (!m) return [];
    return m.RULES || m.SYNTAX_RULES || m.TYPE_RULES || m.BORROW_RULES || m.WARN_RULES || [];
  }
  function modAttach(m) {
    if (!m) return null;
    return m.attach || m.attachSyntax || m.attachTypes || m.attachBorrow || m.attachWarn || null;
  }

  var RULES = [];
  for (var i = 0; i < MODULES.length; i++) {
    var rs = modRules(MODULES[i]);
    for (var j = 0; j < rs.length; j++) RULES.push(rs[j]);
  }

  function attachAll(ctx, shared) {
    for (var i = 0; i < MODULES.length; i++) {
      var fn = modAttach(MODULES[i]);
      if (fn) {
        try { fn(ctx, shared); } catch (e) {}
      }
    }
  }

  var KNOWN_TYPES = (KNOWN_MOD && KNOWN_MOD.KNOWN_TYPES) || {};
  var KNOWN_MACROS = (KNOWN_MOD && KNOWN_MOD.KNOWN_MACROS) || {};
  var KNOWN_FNS = (KNOWN_MOD && KNOWN_MOD.KNOWN_FNS) || {};

  // back-compat: the old src/rules.js exposed `attachBorrow`
  function attachBorrow(ctx, shared) {
    var fn = BOR_MOD && (BOR_MOD.attach || BOR_MOD.attachBorrow);
    if (fn) {
      try { fn(ctx, shared); } catch (e) {}
    }
  }

  return {
    RULES: RULES,
    KNOWN_TYPES: KNOWN_TYPES, KNOWN_MACROS: KNOWN_MACROS, KNOWN_FNS: KNOWN_FNS,
    attachAll: attachAll, attachBorrow: attachBorrow
  };
}));

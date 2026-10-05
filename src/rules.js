/* frs/src/rules.js — BACK-COMPAT SHIM (kept so old require paths keep working).
 *
 * The real rule modules live in src/rules/ (see src/rules/index.js):
 *   known.js         KNOWN_TYPES / KNOWN_MACROS / KNOWN_FNS vocabularies
 *   syntax_rules.js  R* table + attachSyntax
 *   type_rules.js    T* table + attachTypes
 *   borrow_rules.js  B* table + attachBorrow (ownership & borrows)
 *   warn_rules.js    W* table + attachWarn
 *   int_rules.js     interpreter lookup tables (loaded by interpreter.js)
 *   index.js         merges everything (+ attachAll)
 *
 * New code should require('./rules/index.js') directly.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./rules/index.js'), null);
  } else {
    root.FRS_rules = factory(root.FRS_rules_merged, root);
  }
}(typeof self !== 'undefined' ? self : this, function (MERGED, ROOT) {
  'use strict';
  MERGED = MERGED || {};
  // Browser without index.js loaded: assemble from the individual globals.
  if (!MERGED.RULES) {
    var mods = [(ROOT || {}).FRS_rules_syntax, (ROOT || {}).FRS_rules_types,
                (ROOT || {}).FRS_borrow_rules, (ROOT || {}).FRS_rules_warn];
    var RULES = [];
    for (var i = 0; i < mods.length; i++) {
      var rs = (mods[i] && (mods[i].RULES || mods[i].BORROW_RULES)) || [];
      for (var j = 0; j < rs.length; j++) RULES.push(rs[j]);
    }
    var KNOWN = ((ROOT || {}).FRS_rules_known) || {};
    MERGED = {
      RULES: RULES,
      KNOWN_TYPES: KNOWN.KNOWN_TYPES || {}, KNOWN_MACROS: KNOWN.KNOWN_MACROS || {}, KNOWN_FNS: KNOWN.KNOWN_FNS || {},
      attachAll: function (ctx, shared) {
        for (var k = 0; k < mods.length; k++) {
          var fn = mods[k] && (mods[k].attach || mods[k].attachBorrow);
          if (fn) { try { fn(ctx, shared); } catch (e) {} }
        }
      }
    };
  }
  return MERGED;
}));

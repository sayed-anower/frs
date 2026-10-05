/* frs/src/rules/known.js — shared vocabularies for all rule modules.
 * Pure JS, no deps. Node: require('./known.js'). Browser: FRS_rules_known.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.FRS_rules_known = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Known primitive + common std types (for T005 unknown-type rule).
  var KNOWN_TYPES = {
    'i8': 1, 'i16': 1, 'i32': 1, 'i64': 1, 'i128': 1, 'isize': 1,
    'u8': 1, 'u16': 1, 'u32': 1, 'u64': 1, 'u128': 1, 'usize': 1,
    'f32': 1, 'f64': 1, 'bool': 1, 'char': 1, 'str': 1, 'String': 1,
    'Vec': 1, 'Option': 1, 'Result': 1, 'Box': 1, 'Rc': 1, 'Arc': 1,
    'HashMap': 1, 'HashSet': 1, 'BTreeMap': 1, 'VecDeque': 1,
    '()': 1, '&str': 1
  };

  // Known bare std free-functions (not macros, not methods, not paths).
  var KNOWN_FNS = {
    'drop': 1, 'forget': 1
  };

  // Known macros (anything else -> lenient pass, NOT an error).
  var KNOWN_MACROS = {
    'println': 1, 'print': 1, 'eprintln': 1, 'eprint': 1, 'format': 1,
    'vec': 1, 'panic': 1, 'assert': 1, 'assert_eq': 1, 'assert_ne': 1,
    'dbg': 1, 'todo': 1, 'unimplemented': 1, 'unreachable': 1,
    'include_str': 1, 'include_bytes': 1, 'env': 1, 'option_env': 1,
    'stringify': 1, 'concat': 1, 'matches': 1
  };

  return { KNOWN_TYPES: KNOWN_TYPES, KNOWN_MACROS: KNOWN_MACROS, KNOWN_FNS: KNOWN_FNS };
}));

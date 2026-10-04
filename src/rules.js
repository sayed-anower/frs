/* frs/src/rules.js — DECLARATIVE RULE TABLE.
 *
 * HOW TO ADD A NEW RULE (devs read this):
 *   1. Add one object to RULES below.
 *   2. Pick an `anchor`: where the checker calls you:
 *        'eof'      — once at end (unbalanced delimiters, missing main, ...)
 *        'stmt'     — on every statement-start keyword (let/fn/use/...)
 *        'assign'   — on every `x = ...` assignment
 *        'call'     — on every `foo(...)` / `foo!(...)` call
 *        'decl'     — on every `let` binding
 *        'macro'    — on every `name!(...)` macro use
 *        'keyword'  — on every keyword occurrence (break/continue/return/else)
 *   3. Write `check(ctx)` returning either null (pass) or a partial
 *      diagnostic {msg, code, line, col, spanLen, label, hint, note, level}.
 *      `ctx` gives you helpers + scope (see checker.js `makeCtx`).
 *   4. Done — checker auto-runs it. No other file to touch.
 *
 * Keep `check` tiny + allocation-free on pass (return null fast).
 * Pure JS, no deps.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.FRS_rules = factory();
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

  // Known macros (anything else -> T014 unknown-macro warning, NOT error).
  var KNOWN_MACROS = {
    'println': 1, 'print': 1, 'eprintln': 1, 'eprint': 1, 'format': 1,
    'vec': 1, 'panic': 1, 'assert': 1, 'assert_eq': 1, 'assert_ne': 1,
    'dbg': 1, 'todo': 1, 'unimplemented': 1, 'unreachable': 1,
    'include_str': 1, 'include_bytes': 1, 'env': 1, 'option_env': 1,
    'stringify': 1, 'concat': 1, 'matches': 1
  };

  var RULES = [
    // ---------- syntax ----------
    {
      id: 'R001', code: 'E0765', level: 'error', anchor: 'eof',
      name: 'unbalanced-delimiter',
      desc: 'Every `{`, `(`, `[` must be closed.',
      check: function (ctx) { return ctx.checkUnbalanced(); }
    },
    {
      id: 'R002', code: null, level: 'error', anchor: 'stmt',
      name: 'missing-semicolon',
      desc: 'let/use/return/expr statements need `;` (unless block-tailed).',
      check: function (ctx) { return ctx.checkMissingSemi(); }
    },
    {
      id: 'R003', code: 'E0425', level: 'error', anchor: 'stmt',
      name: 'let-needs-binding',
      desc: '`let` must be followed by a binding (ident or _ / mut ident).',
      check: function (ctx) { return ctx.checkLetBinding(); }
    },
    {
      id: 'R004', code: null, level: 'error', anchor: 'stmt',
      name: 'fn-needs-name',
      desc: '`fn` must be followed by a function name.',
      check: function (ctx) { return ctx.checkFnName(); }
    },
    {
      id: 'R006', code: null, level: 'error', anchor: 'eof',
      name: 'unterminated-string',
      desc: 'String literal missing closing `"`.',
      check: function (ctx) { return ctx.checkLexErr('unterminated-string', 'unterminated string literal', 'add `\"` here'); }
    },
    {
      id: 'R007', code: null, level: 'error', anchor: 'eof',
      name: 'bad-char-literal',
      desc: 'Char literal must be one char: \'a\', \'\\n\'.',
      check: function (ctx) { return ctx.checkCharErr(); }
    },
    {
      id: 'R008', code: null, level: 'error', anchor: 'eof',
      name: 'unterminated-comment',
      desc: 'Block comment missing closing `*/`.',
      check: function (ctx) { return ctx.checkLexErr('unterminated-comment', 'unterminated block comment', 'add `*/` here'); }
    },
    {
      id: 'R010', code: null, level: 'error', anchor: 'stmt',
      name: 'expected-block',
      desc: 'fn/if/for/while/loop/match/struct/enum/impl need `{`.',
      check: function (ctx) { return ctx.checkExpectedBlock(); }
    },
    {
      id: 'R012', code: null, level: 'error', anchor: 'stmt',
      name: 'use-needs-semi',
      desc: '`use ...` must end with `;`.',
      check: function (ctx) { return ctx.checkUseSemi(); }
    },
    {
      id: 'R014', code: null, level: 'error', anchor: 'stmt',
      name: 'println-needs-bang',
      desc: '`println(...)` needs `!`: `println!(...)`.',
      check: function (ctx) { return ctx.checkPrintBang(); }
    },
    {
      id: 'R015', code: null, level: 'error', anchor: 'keyword',
      name: 'else-without-if',
      desc: '`else` must follow an `if` block.',
      check: function (ctx) { return ctx.checkElseWithoutIf(); }
    },
    {
      id: 'R018', code: null, level: 'error', anchor: 'stmt',
      name: 'arrow-needs-type',
      desc: '`->` must be followed by a return type.',
      check: function (ctx) { return ctx.checkArrowType(); }
    },
    {
      id: 'R020', code: null, level: 'error', anchor: 'eof',
      name: 'unclosed-attribute',
      desc: '`#[...]` attribute missing `]`.',
      check: function (ctx) { return ctx.checkAttribute(); }
    },
    {
      id: 'R021', code: null, level: 'error', anchor: 'eof',
      name: 'missing-main',
      desc: 'Binary crates need `fn main()`.',
      check: function (ctx) { return ctx.checkMissingMain(); }
    },
    {
      id: 'R022', code: 'E0599', level: 'error', anchor: 'stmt',
      name: 'struct-literal-needs-brace',
      desc: 'Struct literal `Name { ... }` needs `{`.',
      check: function (ctx) { return null; } // placeholder: keep table extensible
    },

    // ---------- semantics / types ----------
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

    // ---------- warnings ----------
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

  return { RULES: RULES, KNOWN_TYPES: KNOWN_TYPES, KNOWN_MACROS: KNOWN_MACROS, KNOWN_FNS: KNOWN_FNS };
}));

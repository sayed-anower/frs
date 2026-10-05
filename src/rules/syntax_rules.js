/* frs/src/rules/syntax_rules.js — R* rules: delimiters, terminators, blocks.
 * Each entry is {id, code, level, anchor, name, desc, check(ctx)}.
 * `attachSyntax(ctx, shared)` installs the ctx.check* implementations.
 * Pure JS, no deps. Node: require('./syntax_rules.js'). Browser: FRS_rules_syntax.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.FRS_rules_syntax = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SYNTAX_RULES = [
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
      check: function (ctx) { return ctx.checkLexErr('unterminated-string', 'unterminated string literal', 'add `"` here'); }
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
    }
  ];

  function attachSyntax(ctx, shared) {
    shared = shared || {};
    var T = shared.T || { IDENT: 1 };
    var BLOCK_KW = shared.BLOCK_KW || {};

    ctx.checkUnbalanced = function () {
      var out = [];
      var strayCloses = ctx.strayCloses, stack = ctx.stack;
      for (var s2 = 0; s2 < strayCloses.length; s2++) {
        var sc = strayCloses[s2];
        out.push({
          msg: 'mismatched closing delimiter `' + sc.ch + '`',
          line: sc.line, col: sc.col, spanLen: 1,
          label: 'unexpected `' + sc.ch + '`', hint: 'remove this bracket'
        });
      }
      if (stack.length) {
        var o = stack[stack.length - 1];
        var exp = o.ch === '{' ? '}' : o.ch === '(' ? ')' : ']';
        out.push({
          msg: 'mismatched closing delimiter, expected `' + exp + '`',
          line: o.line, col: o.col, spanLen: 1,
          label: 'unclosed delimiter', hint: 'add `' + exp + '` here'
        });
      }
      return out.length ? out : null;
    };

    ctx.checkLexErr = function (kind, msg, hint) {
      var out = [];
      var lexErrs = ctx.lexErrs;
      for (var e = 0; e < lexErrs.length; e++) {
        if (lexErrs[e].kind === kind) {
          out.push({
            msg: msg, line: lexErrs[e].line, col: lexErrs[e].col, spanLen: 1,
            label: msg, hint: hint
          });
        }
      }
      return out.length ? out : null;
    };

    ctx.checkCharErr = function () {
      var out = [];
      var lexErrs = ctx.lexErrs;
      for (var e2 = 0; e2 < lexErrs.length; e2++) {
        var le = lexErrs[e2];
        if (le.kind === 'unterminated-char') {
          out.push({ msg: 'unterminated character literal', line: le.line, col: le.col, spanLen: 1, label: 'unterminated char', hint: "add `'` here" });
        } else if (le.kind === 'char-too-long') {
          out.push({ msg: 'character literal must be a single character', line: le.line, col: le.col, spanLen: (le.raw || "'?'").length, label: 'more than one character', hint: 'use a string `"..."` for text' });
        }
      }
      return out.length ? out : null;
    };

    ctx.checkMissingSemi = function () {
      var st = ctx.current;
      if (!st) return null;
      if (st.kind === 'let') {
        if (!st.hasSemi && !st.missingName) {
          return {
            msg: 'expected `;`, found end of statement', line: st.nameLine, col: st.nameCol + st.nameLen,
            spanLen: 1, label: '', hint: 'add `;` here'
          };
        }
        return null;
      }
      if (st.kind === 'assign') {
        if (!st.hasSemi) {
          return { msg: 'expected `;`, found end of statement', line: st.line, col: st.col + st.spanLen, spanLen: 1, label: '', hint: 'add `;` here' };
        }
      }
      return null;
    };

    ctx.checkLetBinding = function () {
      var st2 = ctx.current;
      if (st2 && st2.kind === 'let' && st2.missingName) {
        return { msg: 'expected identifier, found `' + (st2.valToks[0] ? st2.valToks[0].v : 'end') + '`', line: st2.line, col: st2.col + 4, spanLen: 1, label: 'expected a binding name', hint: 'write `let x = ...;`' };
      }
      return null;
    };

    ctx.checkFnName = function () {
      var st3 = ctx.current;
      if (st3 && st3.kind === 'fn' && st3.fnameMissing) {
        return { msg: 'expected function name after `fn`', line: st3.line, col: st3.col + 3, spanLen: 1, label: 'expected a name', hint: 'write `fn name() { ... }`' };
      }
      return null;
    };

    ctx.checkExpectedBlock = function () {
      var st4 = ctx.current;
      if (!st4) return null;
      var toks = ctx.toks, n = toks.length;
      if (st4.kind === 'fn' && st4.name && st4.params !== -1 && st4.bodyOpen === -1 && !st4.hasSemiDecl) {
        return { msg: 'expected `{` after function signature', line: st4.line, col: st4.col + st4.spanLen, spanLen: 1, label: 'expected a block', hint: 'add `{ ... }` here' };
      }
      if (st4.kind === 'stmt' && BLOCK_KW[st4.kw]) {
        if (st4.kw === 'for' || st4.kw === 'while' || st4.kw === 'loop') {
          if (st4.braceIdx === -1 || st4.braceIdx === undefined) {
            return { msg: 'expected `{` after `' + st4.kw + '`', line: st4.line, col: st4.col + st4.spanLen, spanLen: 1, label: 'expected a block', hint: 'add `{ ... }` here' };
          }
        }
        // if/match: look ahead up to 40 toks for `{` before `;`
        if (st4.kw === 'if' || st4.kw === 'match') {
          var si = st4.idx + 1, found = false;
          for (var q3 = si; q3 < Math.min(n, si + 40); q3++) {
            if (toks[q3].v === '{') { found = true; break; }
            if (toks[q3].v === ';') break;
            if (toks[q3].t === T.IDENT && (toks[q3].v === 'let' || toks[q3].v === 'fn') && toks[q3].line > st4.line) break;
          }
          if (!found) return { msg: 'expected `{` after `' + st4.kw + ' ...`', line: st4.line, col: st4.col + st4.spanLen, spanLen: 1, label: 'expected a block', hint: 'add `{ ... }` here' };
        }
      }
      return null;
    };

    ctx.checkUseSemi = function () {
      var st5 = ctx.current;
      if (st5 && st5.kind === 'use' && !st5.hasSemi) {
        return { msg: 'expected `;`, found end of `use` statement', line: st5.line, col: st5.col + 3, spanLen: 1, label: '', hint: 'add `;` here' };
      }
      return null;
    };

    ctx.checkPrintBang = function () {
      var st6 = ctx.current;
      if (st6 && st6.kind === 'stmt' && st6.sub === 'print-bang') {
        var sug = st6.kw === 'vec' ? 'vec![...]' : st6.kw + '!(...)';
        return { msg: 'expected `!` after `' + st6.kw + '` (it is a macro)', line: st6.line, col: st6.col + st6.spanLen, spanLen: 1, label: 'missing `!`', hint: 'write `' + sug + '`' };
      }
      return null;
    };

    // For every `if`, find the `{` that opens its then-block and record it.
    // An `else` is valid only when the token right before it is the `}` that
    // closes one of those if-blocks.
    var ifBlockSet = {};
    (function () {
      var toks = ctx.toks, n = toks.length;
      for (var ii = 0; ii < n; ii++) {
        if (toks[ii].t === T.IDENT && toks[ii].v === 'if') {
          var pd = 0;
          for (var q = ii + 1; q < Math.min(n, ii + 80); q++) {
            var vw = toks[q].v;
            if (vw === '(') pd++;
            else if (vw === ')') pd--;
            else if (vw === '{' && pd === 0) { ifBlockSet[q] = 1; break; }
            else if (vw === ';' && pd === 0) break;
          }
        }
      }
    })();

    ctx.checkElseWithoutIf = function () {
      var k = ctx.current;
      var toks = ctx.toks;
      if (k && k.kind === 'kw' && k.kw === 'else') {
        var ok = false;
        if (k.idx > 0 && toks[k.idx - 1].v === '}') {
          // backward brace-match from that `}` to its `{`
          var d = 1, j = k.idx - 2;
          while (j >= 0 && d > 0) {
            if (toks[j].v === '}') d++;
            else if (toks[j].v === '{') { d--; if (d === 0) break; }
            j--;
          }
          if (d === 0 && ifBlockSet[j] !== undefined) ok = true;
        }
        if (!ok) return { msg: '`else` without `if`', line: k.line, col: k.col, spanLen: 4, label: 'no matching `if`', hint: 'remove `else` or add an `if` block before it' };
      }
      return null;
    };

    ctx.checkArrowType = function () {
      var st7 = ctx.current;
      var toks = ctx.toks, n = toks.length;
      if (st7 && st7.kind === 'fn' && st7.name) {
        // if tokens contain `->` but ret empty/null
        // detect: scan signature region for `->` followed by `{`/`;`
        for (var q4 = st7.idx; q4 < Math.min(n, st7.idx + 40); q4++) {
          if (toks[q4].v === '->') {
            var nx3 = toks[q4 + 1];
            if (!nx3 || nx3.v === '{' || nx3.v === ';') {
              return { msg: 'expected a type after `->`', line: toks[q4].line, col: toks[q4].col + 2, spanLen: 1, label: 'expected a return type', hint: 'write `-> i32`, `-> String`, ...' };
            }
            break;
          }
        }
      }
      return null;
    };

    ctx.checkAttribute = function () {
      // raw scan for `#[` / `#![` closed by a balanced `]` (attributes may span
      // many lines, e.g. multi-line `#[cfg(all(...))]`)
      var toks = ctx.toks, n = toks.length;
      var out2 = [];
      for (var a3 = 0; a3 < n - 1; a3++) {
        if (toks[a3].v === '#' && toks[a3 + 1].v === '[') {
          var d2 = 0, closed = false;
          for (var c3 = a3 + 1; c3 < Math.min(n, a3 + 400); c3++) {
            if (toks[c3].v === '[') d2++;
            else if (toks[c3].v === ']') { d2--; if (d2 === 0) { closed = true; break; } }
          }
          if (!closed) {
            out2.push({ msg: 'unclosed attribute, expected `]`', line: toks[a3].line, col: toks[a3].col, spanLen: 2, label: 'missing `]`', hint: 'add `]` here' });
          }
        }
      }
      return out2.length ? out2 : null;
    };

    ctx.checkMissingMain = function () {
      if (ctx.isLib) return null;
      if (!ctx.hasMain) {
        // point at EOF / first line
        return { msg: '`main` function not found in crate', line: 1, col: 1, spanLen: 1, label: 'no `main` here', hint: 'add `fn main() { ... }`', note: 'to build a library instead, pass `--lib`' };
      }
      // also validate main signature: no params
      var fns = ctx.fns;
      for (var f in fns) {
        if (f === 'main' && fns[f].params !== 0 && fns[f].params !== -1) {
          return { msg: 'function `main` must take no arguments', line: fns[f].line, col: fns[f].col, spanLen: 8, label: 'takes ' + fns[f].params + ' args', hint: 'write `fn main() { ... }`' };
        }
      }
      return null;
    };
  }

  return { RULES: SYNTAX_RULES, attachSyntax: attachSyntax };
}));

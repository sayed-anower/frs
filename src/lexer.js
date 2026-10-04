/* frs/src/lexer.js — extreme-fast single-pass Rust lexer. Pure JS, no deps. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    try { var U = require('./util.js'); } catch (e) { var U = root.FRS_util; }
    module.exports = factory(U);
  } else root.FRS_lexer = factory(root.FRS_util);
}(typeof self !== 'undefined' ? self : this, function (U) {
  'use strict';
  U = U || (typeof self !== 'undefined' ? self.FRS_util : this.FRS_util);

  // Token kinds as small ints (fast compare). v = raw text.
  var T = {
    IDENT: 1, NUMBER: 2, STRING: 3, CHAR: 4,
    SYMBOL: 5, LIFETIME: 6, RAWSTR: 7, BYTESTR: 8
  };

  // Multi-char symbols are matched by charCode dispatch in the hot loop below
  // (`...` `..=` `..` `<<=` `>>=` `==` `!=` `<=` `>=` `&&` `||` `<<` `>>`
  //  `+=` `-=` `*=` `/=` `%=` `&=` `|=` `^=` `->` `=>` `::` `##`).

  function lex(src, opts) {
    opts = opts || {};
    var n = src.length;
    var toks = [];         // {t,v,idx,line,col}
    var errs = [];         // unterminated literal/comment diagnostics (raw)
    var starts = U.lineStarts(src);
    var line = 1, col = 1, ls = 0; // track incrementally (faster than posOf per token)
    var i = 0;

    function push(t, v, idx, l, c) { toks.push({ t: t, v: v, idx: idx, line: l, col: c }); }

    while (i < n) {
      var ch = src.charCodeAt(i);

      // whitespace
      if (ch === 32 || ch === 9 || ch === 13) { i++; col++; continue; }
      if (ch === 10) { i++; line++; col = 1; ls = i; continue; }

      // comments: //...  /* ... */
      if (ch === 47 && i + 1 < n) {
        var nx = src.charCodeAt(i + 1);
        if (nx === 47) { // line comment
          var j = i + 2;
          while (j < n && src.charCodeAt(j) !== 10) j++;
          i = j; continue; // newline handled next iter (col reset)
        }
        if (nx === 42) { // block comment (nestable like Rust)
          var depth = 1, k = i + 2, l = line, c0 = col;
          var ll = line, cc = col + 2;
          while (k < n && depth > 0) {
            var a = src.charCodeAt(k);
            if (a === 10) { ll++; cc = 1; k++; continue; }
            if (a === 47 && k + 1 < n && src.charCodeAt(k + 1) === 42) { depth++; k += 2; cc += 2; continue; }
            if (a === 42 && k + 1 < n && src.charCodeAt(k + 1) === 47) { depth--; k += 2; cc += 2; continue; }
            k++; cc++;
          }
          if (depth > 0) {
            errs.push({ kind: 'unterminated-comment', idx: i, line: l, col: c0 });
            // advance to EOF to avoid cascade
            // update line/col
            line = ll; col = cc; i = k;
            break;
          }
          // update line/col by scanning consumed text
          for (var q = i; q < k; q++) {
            if (src.charCodeAt(q) === 10) { line++; col = 1; }
            else col++;
          }
          i = k; continue;
        }
      }

      // raw string: r"..." r#"..."# r##"..."##
      if (ch === 114 && (src.charCodeAt(i + 1) === 34 || src.charCodeAt(i + 1) === 35)) {
        var h = 0, p = i + 1;
        while (src.charCodeAt(p) === 35) { h++; p++; }
        if (src.charCodeAt(p) === 34) {
          var end = src.indexOf('"' + rep('#', h), p + 1);
          // need closing quote + h hashes
          var m = -1, s = p + 1;
          while (true) {
            m = src.indexOf('"', s);
            if (m === -1) break;
            var ok = true;
            for (var hh = 0; hh < h; hh++) {
              if (src.charCodeAt(m + 1 + hh) !== 35) { ok = false; break; }
            }
            if (ok) break;
            s = m + 1;
          }
          if (m === -1) {
            errs.push({ kind: 'unterminated-string', idx: i, line: line, col: col, hash: h });
            push(T.RAWSTR, src.slice(i, n), i, line, col);
            // consume rest
            for (var z = i; z < n; z++) if (src.charCodeAt(z) === 10) line++;
            i = n; break;
          } else {
            var endI = m + 1 + h;
            push(T.RAWSTR, src.slice(i, endI), i, line, col);
            for (var z2 = i; z2 < endI; z2++) {
              if (src.charCodeAt(z2) === 10) { line++; col = 1; } else col++;
            }
            i = endI; continue;
          }
        }
        // else fall through as ident
      }

      // string "..."
      if (ch === 34) {
        var s0 = i, l0 = line, c00 = col, esc = false, term = false;
        i++; col++;
        while (i < n) {
          var d = src.charCodeAt(i);
          if (d === 10) break; // Rust strings can't span raw newline (must use \); report unterminated
          if (esc) { esc = false; i++; col++; continue; }
          if (d === 92) { esc = true; i++; col++; continue; }
          if (d === 34) { term = true; i++; col++; break; }
          i++; col++;
        }
        var raw = src.slice(s0, i);
        push(T.STRING, raw, s0, l0, c00);
        if (!term) errs.push({ kind: 'unterminated-string', idx: s0, line: l0, col: c00 });
        continue;
      }

      // char / lifetime: 'a'  '\n'  'static
      if (ch === 39) {
        var q0 = i, ql = line, qc = col;
        // lifetime? '<-tick><ident>  (but not char literal)
        // Heuristic: if next char is alpha/_ and the char after ident is NOT a closing quote, treat as lifetime.
        var r = i + 1;
        if (r < n && U.isAlphaU(src.charCodeAt(r))) {
          var re = r + 1;
          while (re < n && U.isAlnumU(src.charCodeAt(re))) re++;
          if (re < n && src.charCodeAt(re) === 39 && (re - r) <= 2) {
            // looks like 'a' char literal -> parse as char below
          } else {
            push(T.LIFETIME, src.slice(q0, re), q0, ql, qc);
            col += (re - q0); i = re; continue;
          }
        }
        // char literal parse until closing ' on same line
        i++; col++;
        var ces = false, cterm = false;
        while (i < n) {
          var dc = src.charCodeAt(i);
          if (dc === 10) break;
          if (ces) { ces = false; i++; col++; continue; }
          if (dc === 92) { ces = true; i++; col++; continue; }
          if (dc === 39) { cterm = true; i++; col++; break; }
          i++; col++;
        }
        var craw = src.slice(q0, i);
        push(T.CHAR, craw, q0, ql, qc);
        if (!cterm) errs.push({ kind: 'unterminated-char', idx: q0, line: ql, col: qc });
        else if (charTooLong(craw)) {
          errs.push({ kind: 'char-too-long', idx: q0, line: ql, col: qc, raw: craw });
        }
        continue;
      }

      // single char literal = exactly one char (code point) or one escape
      function charTooLong(raw) {
        var inner = raw.slice(1, -1); // raw ends with `'` when terminated
        if (!inner.length) return true; // `''`
        if (inner.charCodeAt(0) === 92) { // escape: consume one sequence
          if (inner[1] === 'u' && inner[2] === '{') {
            var ue = inner.indexOf('}');
            if (ue === -1) return false; // let it pass; not our rule's job
            inner = inner.slice(ue + 1);
          } else if (inner[1] === 'x') inner = inner.slice(4);
          else inner = inner.slice(2);
          return inner.length > 0;
        }
        // one unicode code point (surrogate-pair aware)
        var c0 = inner.charCodeAt(0);
        var w = (c0 >= 0xD800 && c0 <= 0xDBFF && inner.length >= 2) ? 2 : 1;
        return inner.length > w;
      }

      // number: 123, 1_000, 0x.., 0o.., 0b.., floats
      if (U.isDigit(ch)) {
        var n0 = i, nl = line, nc = col;
        // hex/oct/bin prefix
        if (ch === 48 && i + 1 < n) {
          var pfx = src.charCodeAt(i + 1);
          if (pfx === 120 || pfx === 88 || pfx === 111 || pfx === 79 || pfx === 98 || pfx === 66) {
            i += 2; col += 2;
            while (i < n && (U.isAlnumU(src.charCodeAt(i)) || src.charCodeAt(i) === 95)) { i++; col++; }
          } else {
            while (i < n && (U.isDigit(src.charCodeAt(i)) || src.charCodeAt(i) === 95)) { i++; col++; }
            if (i < n && src.charCodeAt(i) === 46 && i + 1 < n && U.isDigit(src.charCodeAt(i + 1))) {
              i++; col++;
              while (i < n && (U.isDigit(src.charCodeAt(i)) || src.charCodeAt(i) === 95)) { i++; col++; }
            }
            if (i < n && (src.charCodeAt(i) === 101 || src.charCodeAt(i) === 69)) {
              var se = i + 1;
              if (src.charCodeAt(se) === 43 || src.charCodeAt(se) === 45) se++;
              if (U.isDigit(src.charCodeAt(se))) {
                i = se + 1; col += (i - n0) - (col - nc); // recompute below anyway
                while (i < n && (U.isDigit(src.charCodeAt(i)) || src.charCodeAt(i) === 95)) { i++; }
                col = nc + (i - n0);
              }
            }
            // type suffix like i32/f64
            var ts = i;
            while (ts < n && U.isAlphaU(src.charCodeAt(ts))) ts++;
            if (ts > i) { col += (ts - i); i = ts; }
          }
        } else {
          while (i < n && (U.isDigit(src.charCodeAt(i)) || src.charCodeAt(i) === 95)) { i++; col++; }
          if (i < n && src.charCodeAt(i) === 46) {
            // careful: `..` range vs float. Only consume `.` if followed by digit.
            if (i + 1 < n && U.isDigit(src.charCodeAt(i + 1))) {
              i++; col++;
              while (i < n && (U.isDigit(src.charCodeAt(i)) || src.charCodeAt(i) === 95)) { i++; col++; }
            }
          }
          if (i < n && (src.charCodeAt(i) === 101 || src.charCodeAt(i) === 69)) {
            var se2 = i + 1;
            if (src.charCodeAt(se2) === 43 || src.charCodeAt(se2) === 45) se2++;
            if (se2 < n && U.isDigit(src.charCodeAt(se2))) {
              i = se2 + 1;
              while (i < n && (U.isDigit(src.charCodeAt(i)) || src.charCodeAt(i) === 95)) i++;
              col = nc + (i - n0);
            }
          }
          var te = i;
          while (te < n && U.isAlphaU(src.charCodeAt(te))) te++;
          // only consume suffix if it looks like a type (i,u,f) — keep simple: consume all alpha suffix
          if (te > i) { col += (te - i); i = te; }
        }
        push(T.NUMBER, src.slice(n0, i), n0, nl, nc);
        continue;
      }

      // ident / keyword
      if (U.isAlphaU(ch)) {
        var b0 = i, bl = line, bc = col;
        i++; col++;
        while (i < n) {
          var cc2 = src.charCodeAt(i);
          if (cc2 === 95 || (cc2 >= 48 && cc2 <= 57) || (cc2 >= 65 && cc2 <= 90) || (cc2 >= 97 && cc2 <= 122)) { i++; col++; }
          else if (cc2 > 127) { i++; col++; } // unicode ident char (approx)
          else break;
        }
        var identTok = src.slice(b0, i);
        // byte string: b"..." right after a lone `b` (no space)
        if (identTok === 'b' && i < n && src.charCodeAt(i) === 34) {
          var bs0 = b0, bsEsc = false, bsTerm = false;
          i++; col++;
          while (i < n) {
            var bd = src.charCodeAt(i);
            if (bd === 10) break;
            if (bsEsc) { bsEsc = false; i++; col++; continue; }
            if (bd === 92) { bsEsc = true; i++; col++; continue; }
            if (bd === 34) { bsTerm = true; i++; col++; break; }
            i++; col++;
          }
          var bsRaw = src.slice(bs0, i);
          push(T.BYTESTR, bsRaw, bs0, bl, bc);
          if (!bsTerm) errs.push({ kind: 'unterminated-string', idx: bs0, line: bl, col: bc });
          continue;
        }
        push(T.IDENT, identTok, b0, bl, bc);
        continue;
      }

      // symbols: charCode-dispatched longest match (no slice allocs on miss).
      // (comments are intercepted above, so `/` here can only start `/=`.)
      var c1 = i + 1 < n ? src.charCodeAt(i + 1) : -1;
      var matched = null;
      if (ch === 46 && c1 === 46) { // `.` -> `...` | `..=` | `..`
        var c2d = i + 2 < n ? src.charCodeAt(i + 2) : -1;
        matched = c2d === 46 ? '...' : c2d === 61 ? '..=' : '..';
      } else if (ch === 60) { // `<` -> `<<=` | `<=` | `<<`
        if (c1 === 60) matched = (i + 2 < n && src.charCodeAt(i + 2) === 61) ? '<<=' : '<<';
        else if (c1 === 61) matched = '<=';
      } else if (ch === 62) { // `>` -> `>>=` | `>=` | `>>`
        if (c1 === 62) matched = (i + 2 < n && src.charCodeAt(i + 2) === 61) ? '>>=' : '>>';
        else if (c1 === 61) matched = '>=';
      } else if (c1 === 61) { // `X=` -> `==` `!=` `+=` `-=` `*=` `/=` `%=` `&=` `|=` `^=`
        if (ch === 61 || ch === 33 || ch === 43 || ch === 45 || ch === 42 || ch === 47 ||
            ch === 37 || ch === 38 || ch === 124 || ch === 94) matched = src[i] + '=';
      } else if (ch === 61 && c1 === 62) matched = '=>'; // `=>`
      else if (ch === 45 && c1 === 62) matched = '->'; // `->`
      else if (ch === 58 && c1 === 58) matched = '::';   // `::`
      else if (ch === 38 && c1 === 38) matched = '&&';   // `&&`
      else if (ch === 124 && c1 === 124) matched = '||'; // `||`
      else if (ch === 35 && c1 === 35) matched = '##';   // `##`
      if (matched !== null) { push(T.SYMBOL, matched, i, line, col); i += matched.length; col += matched.length; continue; }
      push(T.SYMBOL, src[i], i, line, col); i++; col++;
      continue;
    }

    return { tokens: toks, lexErrs: errs, starts: starts };
  }

  function rep(s, n) { var o = ''; for (var i = 0; i < n; i++) o += s; return o; }

  return { T: T, lex: lex };
}));

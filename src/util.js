/* frs/src/util.js — tiny fast helpers. Pure JS, no deps. Works in Node + browsers. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.FRS_util = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- char classes via lookup (faster than regex in hot loops) ---
  var TABLE = new Uint8Array(128);
  // bit 1 = alpha/_ , 2 = digit, 4 = space
  for (var i = 0; i < 128; i++) {
    var c = i;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) TABLE[i] |= 1;
    if (c >= 48 && c <= 57) TABLE[i] |= 2;
    if (c === 32 || c === 9 || c === 10 || c === 13) TABLE[i] |= 4;
  }
  function isAlphaU(c) { return c < 128 ? (TABLE[c] & 1) !== 0 : c > 127; }
  function isDigit(c) { return c < 128 ? (TABLE[c] & 2) !== 0 : false; }
  function isAlnumU(c) { return c < 128 ? (TABLE[c] & 3) !== 0 : c > 127; }
  function isSpace(c) { return c < 128 ? (TABLE[c] & 4) !== 0 : false; }

  // Build line-start offsets once: O(n). Then line/col is binary search.
  function lineStarts(src) {
    var out = [0];
    for (var i = 0; i < src.length; i++) {
      if (src.charCodeAt(i) === 10) out.push(i + 1);
    }
    return out;
  }

  function posOf(starts, idx) {
    // binary search: line = number of starts <= idx
    var lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: idx - starts[lo] + 1 };
  }

  function splitLines(src) { return src.split('\n'); }

  function repeat(s, n) {
    var o = '';
    for (var i = 0; i < n; i++) o += s;
    return o;
  }

  // Minimal ANSI helpers (disabled when not a TTY or --no-color).
  var useColor = false;
  function setColor(b) { useColor = !!b; }
  function red(s) { return useColor ? '\x1b[1;31m' + s + '\x1b[0m' : s; }
  function bold(s) { return useColor ? '\x1b[1m' + s + '\x1b[0m' : s; }
  function blue(s) { return useColor ? '\x1b[1;34m' + s + '\x1b[0m' : s; }
  function yellow(s) { return useColor ? '\x1b[1;33m' + s + '\x1b[0m' : s; }

  return {
    isAlphaU: isAlphaU, isDigit: isDigit, isAlnumU: isAlnumU, isSpace: isSpace,
    lineStarts: lineStarts, posOf: posOf, splitLines: splitLines, repeat: repeat,
    setColor: setColor, red: red, bold: bold, blue: blue, yellow: yellow
  };
}));

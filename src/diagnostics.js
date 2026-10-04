/* frs/src/diagnostics.js — rustc-style error rendering. Pure JS, no deps. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    try { var U = require('./util.js'); } catch (e) { var U = root.FRS_util; }
    module.exports = factory(U);
  } else root.FRS_diag = factory(root.FRS_util);
}(typeof self !== 'undefined' ? self : this, function (U) {
  'use strict';
  U = U || (typeof self !== 'undefined' ? self.FRS_util : this.FRS_util);

  // Diagnostic: {level:'error'|'warning', code:'E0308'|null, msg, file, line, col,
  //              spanLen, lineText, label, hint, note}
  function render(diags, src, filename) {
    var lines = U.splitLines(src);
    var out = [];
    for (var i = 0; i < diags.length; i++) {
      out.push(renderOne(diags[i], lines, filename));
    }
    return out.join('\n');
  }

  function renderOne(d, lines, filename) {
    var file = filename || d.file || 'main.rs';
    var head;
    if (d.level === 'warning') {
      head = U.yellow('warning') + ': ' + d.msg;
    } else {
      head = U.red('error') + (d.code ? '[' + d.code + ']' : '') + ': ' + d.msg;
    }
    var s = head + '\n';
    var ln = d.line, col = d.col;
    var loc = ' ' + '--> ' + file + ':' + ln + ':' + col;
    s += U.blue(loc) + '\n';
    // gutter
    var w = String(ln).length;
    var gutter = U.repeat(' ', w);
    s += U.blue(gutter + ' |') + '\n';
    var text = (lines[ln - 1] !== undefined ? lines[ln - 1] : '');
    // tabs -> spaces for caret alignment
    var disp = text.replace(/\t/g, '    ');
    s += U.blue(' ' + ln + ' | ') + disp + '\n';
    // caret line
    var span = Math.max(1, d.spanLen || 1);
    // adjust col for tabs
    var pre = text.slice(0, Math.max(0, col - 1)).replace(/\t/g, '    ');
    var carets = U.repeat('^', Math.min(span, 60));
    var lbl = d.label ? ' ' + d.label : '';
    s += U.blue(gutter + ' | ') + U.repeat(' ', pre.length) + U.red(carets) + lbl + '\n';
    if (d.hint) {
      s += U.blue(gutter + ' | ') + 'help: ' + d.hint + '\n';
    }
    if (d.note) {
      s += U.blue(gutter + ' | ') + 'note: ' + d.note + '\n';
    }
    s += U.blue(gutter + ' |');
    return s;
  }

  // Summary footer like rustc: "error: aborting due to N previous errors"
  function footer(errCount, warnCount) {
    var s = '';
    if (errCount > 0) {
      s += U.red('error') + ': aborting due to ' + errCount + ' previous error' + (errCount > 1 ? 's' : '');
      if (warnCount > 0) s += '; ' + warnCount + ' warning' + (warnCount > 1 ? 's' : '') + ' emitted';
    } else if (warnCount > 0) {
      s += U.yellow('warning') + ': ' + warnCount + ' warning' + (warnCount > 1 ? 's' : '') + ' emitted';
    }
    return s;
  }

  // Runtime panic rendering (rustc runtime style)
  function renderPanic(msg, file, line, col) {
    return "thread 'main' panicked at '" + msg + "', " + (file || 'main.rs') + ':' + line + ':' + col + "\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace";
  }

  return { render: render, renderOne: renderOne, footer: footer, renderPanic: renderPanic };
}));

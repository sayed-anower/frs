/* frs/src/frs.js — core engine facade. Pure JS, no deps. Node + browser. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    var req = function (p) { try { return require(p); } catch (e) { return null; } };
    module.exports = factory(req('./util.js'), req('./diagnostics.js'), req('./checker.js'), req('./interpreter.js'));
  } else {
    // browser globals (see index.html script order)
    root.FRS = factory(root.FRS_util, root.FRS_diag, root.FRS_checker, root.FRS_interp);
  }
}(typeof self !== 'undefined' ? self : this, function (U, DIAG, CHECKER, INTERP) {
  'use strict';

  var VERSION = '0.1.0';

  // opts: {file, lib, noColor, run:true/false, warnings:true/false}
  function compile(src, opts) {
    opts = opts || {};
    var file = opts.file || 'main.rs';
    var t0 = now();
    var rep = CHECKER.check(src, file, { lib: !!opts.lib });
    var diags = rep.diags;
    if (opts.warnings === false) diags = diags.filter(function (d) { return d.level !== 'warning'; });
    var stderr = '';
    if (diags.length) {
      stderr = DIAG.render(diags, src, file);
      var f = DIAG.footer(rep.errCount, opts.warnings === false ? 0 : rep.warnCount);
      if (f) stderr += '\n' + f;
      stderr += '\n';
    }
    var stdout = '', runRes = null, panicText = '';
    var success = rep.errCount === 0;
    if (success && opts.run !== false) {
      runRes = INTERP.run(src, {});
      stdout = runRes.stdout || '';
      if (runRes.stderr) panicText = runRes.stderr;
      if (runRes.panicked && !runRes.panicked.limit) {
        var p = runRes.panicked;
        panicText = DIAG.renderPanic(p.msg, file, p.line || 1, p.col || 1);
        success = false; // runtime failure (rustc compiles, but program fails — we surface exit 1)
      } else if (runRes.panicked && runRes.panicked.limit) {
        panicText = DIAG.renderPanic('frs: execution limit exceeded (infinite loop?)', file, 1, 1);
        success = false;
      }
    }
    if (runRes && runRes.serve) { try { if (typeof global !== 'undefined') global.__frsServerRunning = true; } catch (e) {} }
    return {
      success: success && !runResPanicked(runRes),
      compileOk: rep.errCount === 0,
      diagnostics: diags,
      stderr: stderr,
      stdout: stdout,
      runStderr: panicText,
      serve: !!(runRes && runRes.serve),
      errCount: rep.errCount,
      warnCount: rep.warnCount,
      timeMs: now() - t0,
      version: VERSION
    };
  }

  function runResPanicked(r) {
    return !!(r && r.panicked);
  }

  // check-only (no execution)
  function check(src, opts) {
    opts = opts || {};
    opts.run = false;
    return compile(src, opts);
  }

  function now() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  return { compile: compile, check: check, VERSION: VERSION };
}));

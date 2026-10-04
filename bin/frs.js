#!/usr/bin/env node
/* frs — CLI mimicking rustc. Pure JS, zero deps. */
'use strict';
var fs = require('fs');
var path = require('path');

var SRC_DIR = path.join(__dirname, '..', 'src');
var U = require(path.join(SRC_DIR, 'util.js'));
var FRS = require(path.join(SRC_DIR, 'frs.js'));

function newSub(root, name) {
  var PM = require(path.join(SRC_DIR, 'pm.js'));
  return PM.newProject(root, name);
}

function usage() {
  return 'Usage: frs <file.rs> [options]\n' +
    '  --lib          treat input as library (no fn main required)\n' +
    '  --check-only   only check, do not run\n' +
    '  --no-color     disable colors\n' +
    '  --no-warnings  hide warnings\n' +
    '  -o <file>      (accepted for rustc-compat, ignored)\n' +
    '  --version      print version\n';
}

function main(argv) {
  // cargo-style subcommands (async handler wrapper)
  var sub = argv[2];
  if (sub === 'new' || sub === 'build' || sub === 'run' || sub === 'check' || sub === 'init') {
    var PM = require(path.join(SRC_DIR, 'pm.js'));
    var rest = argv.slice(3);
    if (sub === 'new' || sub === 'init') {
      return newSub(process.cwd(), rest[0]);
    }
    if (sub === 'build' || sub === 'run') {
      var p2;
      try {
        p2 = (sub === 'build' ? PM.build : PM.run)(process.cwd());
      } catch (e) { process.stderr.write(String(e && e.message || e) + '\n'); return 1; }
      p2.then(function (code) { process.exit(code); }, function (e) { process.stderr.write(String(e && e.message || e) + '\n'); process.exit(1); });
      return; // async
    }
    if (sub === 'check') {
      var PM2 = require(path.join(SRC_DIR, 'pm.js'));
      PM2.build(process.cwd()).then(function (code) { process.exit(code === 0 ? 0 : 1); }, function (e) { process.stderr.write(String(e) + '\n'); process.exit(1); });
      return;
    }
  }

  var file = null, lib = false, checkOnly = false, noColor = false, noWarn = false;
  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--lib') lib = true;
    else if (a === '--check-only' || a === '--no-run') checkOnly = true;
    else if (a === '--no-color') noColor = true;
    else if (a === '--no-warnings' || a === '--quiet') noWarn = true;
    else if (a === '--version' || a === '-V') { console.log('frs ' + FRS.VERSION); return 0; }
    else if (a === '--help' || a === '-h') { process.stdout.write(usage()); return 0; }
    else if (a === '-o') { i++; }
    else if (a[0] === '-') { process.stderr.write('error: unknown flag `' + a + '`\n' + usage()); return 1; }
    else file = a;
  }
  if (!file) { process.stderr.write(usage()); return 1; }
  var src;
  try { src = fs.readFileSync(file, 'utf8'); }
  catch (e) { process.stderr.write('error: could not read file `' + file + '`\n'); return 1; }

  U.setColor(!noColor && process.stderr.isTTY && !process.env.NO_COLOR);
  var res = FRS.compile(src, {
    file: path.basename(file),
    lib: lib,
    run: !checkOnly,
    warnings: !noWarn
  });
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.compileOk && !checkOnly) {
    if (res.runStderr) {
      process.stderr.write(res.runStderr + '\n');
      return 101; // like a Rust panic exit code
    }
    if (res.stdout) process.stdout.write(res.stdout);
  }
  return res.compileOk && !res.runStderr ? 0 : (res.compileOk ? 101 : 1);
}

var _code = main(process.argv);
if (_code !== undefined) process.exit(_code);

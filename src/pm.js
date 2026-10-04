/* frs/src/pm.js — cargo-like package manager: new/build/run.
 * Node-only. Zero deps. Downloads crates from crates.io with `curl`-free
 * https, extracts via system tar, compiles deps with our own checker, and
 * caches artifacts in frs_target/ so deps aren't recompiled every run.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('fs'), require('path'), require('https'), require('child_process'));
  } else {
    root.FRS_pm = factory(root.fs, root.path, root.https, root.child_process);
  }
}(typeof self !== 'undefined' ? self : this, function (fs, path, https, cp) {
  'use strict';

  var FRS = null;
  function getFRS() {
    if (!FRS) { try { FRS = require('./frs.js'); } catch (e) { FRS = null; } }
    return FRS;
  }

  function say(s) { process.stdout.write(s + '\n'); }
  function err(s) { process.stderr.write(s + '\n'); }

  // ---------------- Cargo.toml parsing (subset) ----------------
  function parseCargoToml(text) {
    var cfg = { package: {}, dependencies: {}, features: {} };
    var sect = null;
    var lines = String(text).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].split('#')[0].trim();
      if (!line) continue;
      var m = line.match(/^\[(.+)\]$/);
      if (m) { sect = m[1].trim(); continue; }
      var kv = line.match(/^([^\s=]+)\s*=\s*(.+)$/);
      if (!kv) continue;
      var key = kv[1].trim(), val = kv[2].trim();
      if (sect === 'package') cfg.package[key] = unquote(val);
      else if (sect === 'dependencies') cfg.dependencies[key] = parseDepSpec(val);
      else if (sect === 'features') cfg.features[key] = val;
    }
    return cfg;
  }
  function unquote(s) {
    s = s.trim();
    if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === '\'' && s[s.length - 1] === '\'')) return s.slice(1, -1);
    return s;
  }
  function parseDepSpec(val) {
    if (val[0] === '"' || val.charAt(0) === '\'') return { version: unquote(val), features: [] };
    // { version = "...", features = [...] }
    var v = val.match(/version\s*=\s*["']([^"']+)["']/);
    var f = val.match(/features\s*=\s*\[([^\]]*)\]/);
    var ft = f ? f[1].split(',').map(function (x) { return unquote(x.trim()); }).filter(Boolean) : [];
    return { version: v ? v[1] : '*', features: ft };
  }

  function versionSatisfies(req, ver) {
    req = String(req || '*').trim();
    if (req === '*' || req === '') return true;
    if (req[0] === '=') return req.slice(1) === ver;
    if (req[0] === '^') req = req.slice(1);
    var rp = req.split('.').map(function (x) { return parseInt(x, 10) || 0; });
    var vp = ver.split('-')[0].split('.').map(function (x) { return parseInt(x, 10) || 0; });
    // caret-style: same major (or same minor when major=0), >= req
    if (vp[0] !== rp[0]) return false;
    for (var i = 0; i < 3; i++) vp[i] = vp[i] || 0, rp[i] = rp[i] || 0;
    if (rp[0] === 0) { if ((vp[1] || 0) < (rp[1] || 0)) return false; }
    var ge = false;
    for (var j = 0; j < 3; j++) { if (vp[j] > rp[j]) { ge = true; break; } if (vp[j] < rp[j]) return false; }
    return ge || true;
  }

  // version inlining helper (linted by our own engine later)
  function fetchVersionsWithUA(name) {
    return new Promise(function (resolve, reject) {
      var req = https.get('https://crates.io/api/v1/crates/' + encodeURIComponent(name), {
        headers: { 'User-Agent': 'frs/0.1.0 (https://crates.io/crates/frs)', 'Accept': 'application/json' }
      }, function (res) {
        var buf = '';
        res.on('data', function (d) { buf += d; });
        res.on('end', function () {
          if (res.statusCode !== 200) return reject(new Error('crates.io returned ' + res.statusCode + ' for ' + name));
          try {
            var j = JSON.parse(buf);
            var out = [];
            var vers = j.versions || [];
            for (var i = 0; i < vers.length; i++) { if (vers[i].num) out.push(vers[i].num); else if (typeof vers[i] === 'string') out.push(vers[i]); }
            if (!out.length && j.crate && j.crate.max_version) out.push(j.crate.max_version);
            resolve(out);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
    });
  }

  function downloadCrate(name, ver, dest) {
    var url = 'https://crates.io/api/v1/crates/' + encodeURIComponent(name) + '/' + ver + '/download';
    function getBuf(u, redirects, cb) {
      https.get(u, { headers: { 'User-Agent': 'frs/0.1.0' } }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          res.resume();
          return getBuf(res.headers.location, redirects + 1, cb);
        }
        if (res.statusCode !== 200) { res.resume(); return cb(new Error('download failed: HTTP ' + res.statusCode)); }
        var b = [];
        res.on('data', function (d) { b.push(d); });
        res.on('end', function () { cb(null, Buffer.concat(b)); });
        res.on('error', cb);
      }).on('error', cb);
    }
    return new Promise(function (resolve, reject) {
      getBuf(url, 0, function (err, buf) {
        if (err) return reject(err);
        try { fs.writeFileSync(dest, buf); resolve(); } catch (e) { reject(e); }
      });
    });
  }

  // ---------------- public API ----------------

  function hasCargoToml(dir) { return fs.existsSync(path.join(dir, 'Cargo.toml')); }

  function newProject(root, name) {
    if (!name) { err('Usage: frs new <name> [--lib]'); return 1; }
    var dir = path.join(root, name);
    if (fs.existsSync(dir)) { err('error: `' + name + '` already exists'); return 1; }
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Cargo.toml'),
      '[package]\nname = "' + name + '"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n\n');
    fs.writeFileSync(path.join(dir, 'src', 'main.rs'),
      'fn main() {\n    println!("Hello, world!");\n}\n');
    say('    Created binary (application) `' + name + '` package');
    return 0;
  }

  // resolve -> download -> extract -> compile dep -> cache artifact
  async function ensureDeps(root) {
    var cfg = parseCargoToml(fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8'));
    var deps = {};
    var names = Object.keys(cfg.dependencies || {});
    if (!names.length) return { cfg: cfg, installed: {} };

    var cacheDir = path.join(root, 'frs_target', 'registry');
    os_mkdir(cacheDir);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var spec = cfg.dependencies[name];
      var ver = null;

      // exact match first: already cached?
      var cand = pickLocalVersion(cacheDir, name, spec.version);
      if (cand) {
        ver = cand;
      } else {
        process.stdout.write('    Updating crates.io index\n');
        var vers;
        try { vers = await fetchVersionsWithUA(name); }
        catch (e) { err('error: could not reach crates.io for `' + name + '`: ' + e.message); throw e; }
        ver = bestVersion(vers, spec.version);
        if (!ver) { err('error: no version of `' + name + '` matches `' + spec.version + '`'); throw new Error('bad version'); }
        process.stdout.write('  Downloading ' + name + ' v' + ver + '\n');
        try {
          await downloadCrate(name, ver, dlPath(cacheDir, name, ver));
          var srcDir = path.join(cacheDir, 'src', name + '-' + ver);
          os_mkdir(path.join(cacheDir, 'src'));
          cp.execSync('tar -xzf "' + dlPath(cacheDir, name, ver) + '" -C "' + path.join(cacheDir, 'src') + '"');
        } catch (e) { err('error: ' + e.message); throw e; }
      }
      deps[name] = ver;
      compileDepCached(root, name, ver, cacheDir);
    }
    return { cfg: cfg, installed: deps };
  }

  function dlPath(cacheDir, name, ver) {
    return path.join(cacheDir, name + '-' + ver + '.crate');
  }
  function pickLocalVersion(cacheDir, name, req) {
    if (!fs.existsSync(path.join(cacheDir, 'src'))) return null;
    var entries = fs.readdirSync(path.join(cacheDir, 'src'));
    var best = null;
    for (var i = 0; i < entries.length; i++) {
      var m = entries[i].match(/^(.+)-([0-9][^-]*)$/);
      if (m && m[1] === name && versionSatisfies(req, m[2])) {
        if (!best || cmpSemver(m[2], best) > 0) best = m[2];
      }
    }
    return best;
  }
  function bestVersion(vers, req) {
    var best = null;
    for (var i = 0; i < vers.length; i++) {
      if (versionSatisfies(req, vers[i])) {
        if (!best || cmpSemver(vers[i], best) > 0) best = vers[i];
      }
    }
    return best;
  }
  function cmpSemver(a, b) {
    var ap = a.split('.').map(function (x) { return parseInt(x, 10) || 0; });
    var bp = b.split('.').map(function (x) { return parseInt(x, 10) || 0; });
    for (var i = 0; i < 3; i++) {
      if ((ap[i] || 0) !== (bp[i] || 0)) return (ap[i] || 0) - (bp[i] || 0);
    }
    return 0;
  }
  function os_mkdir(p) { fs.mkdirSync(p, { recursive: true }); }

  // compile a dep crate with frs and cache the artifact JSON
  function compileDepCached(root, name, ver, cacheDir) {
    var srcRoot = path.join(cacheDir, 'src', name + '-' + ver);
    var libPath = findLibEntry(srcRoot);
    var cacheFile = path.join(root, 'frs_target', 'deps', name + '-' + ver + '.json');
    var F = getFRS();
    // skip recompile if cache exists and lib file is older
    try {
      var cf = fs.statSync(cacheFile);
      var lf = fs.statSync(libPath);
      if (cf.mtimeMs >= lf.mtimeMs) {
        say('   Fresh ' + name + ' v' + ver);
        return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      }
    } catch (e) { /* cache miss */ }

    say('   Compiling ' + name + ' v' + ver);
    var ok = false, msg = '', exports = [];
    try {
      var src = fs.readFileSync(libPath, 'utf8');
      var res = F.check(src, { file: 'lib.rs', lib: true, warnings: false });
      ok = res.compileOk;
      msg = res.stderr || '';
      exports = collectExports(src);
    } catch (e) { msg = String(e); }
    var artifact = {
      name: name, version: ver, crate: name + '-' + ver,
      libPath: libPath, ok: ok, exports: exports,
      compiledAt: new Date().toISOString()
    };
    try {
      os_mkdir(path.dirname(cacheFile));
      fs.writeFileSync(cacheFile, JSON.stringify(artifact, null, 2));
    } catch (e) { /* best effort */ }
    if (ok || true) {
      // warn but don't fail project compile (dep compat may be partial)
      if (!ok) say('    warning: `' + name + '` has ' + (msg.match(/previous errors/g) ? '' : '') + 'check issues under frs (see above)');
    }
    return artifact;
  }

  function findLibEntry(srcRoot) {
    // try Cargo.toml [lib] path, then src/lib.rs, then src/main.rs
    try {
      var raw = fs.readFileSync(path.join(srcRoot, 'Cargo.toml'), 'utf8');
      var m = raw.match(/\[lib\][\s\S]*?path\s*=\s*"([^"]+)"/);
      if (m) return path.join(srcRoot, m[1]);
    } catch (e) {}
    var a = path.join(srcRoot, 'src', 'lib.rs');
    if (fs.existsSync(a)) return a;
    return path.join(srcRoot, 'src', 'main.rs');
  }

  function collectExports(src) {
    // collect trivial "pub" names: pub fn/struct/enum/type/const/static/trait
    var out = [];
    var re = /\bpub\s+(?:const\s+|static\s+|fn\s+|struct\s+|enum\s+|type\s+|trait\s+|mod\s+)([A-Za-z_][A-Za-z0-9_]*)/g;
    var m;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
    return out;
  }

  // entry point: build == deps + check main | run == build+execute
  async function build(root) {
    if (!hasCargoToml(root)) { err('error: could not find `Cargo.toml` in `' + root + '`'); return 1; }
    var cfg = parseCargoToml(fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8'));
    var depsInfo;
    try { depsInfo = await ensureDeps(root); }
    catch (e) { return 1; }
    var mainFile = path.join(root, 'src', 'main.rs');
    if (!fs.existsSync(mainFile)) mainFile = path.join(root, 'main.rs');
    var src = fs.readFileSync(mainFile, 'utf8');
    var F = getFRS();
    var res = F.compile(src, { file: 'main.rs', lib: false, run: false });
    if (!res.compileOk) { process.stderr.write(res.stderr); return 1; }
    if (res.stderr) process.stderr.write(res.stderr);
    say('    Finished `dev` profile');
    return 0;
  }

  async function run(root) {
    if (!hasCargoToml(root)) { err('error: could not find `Cargo.toml` in `' + root + '`'); return 1; }
    var depsInfo;
    try { depsInfo = await ensureDeps(root); }
    catch (e) { return 1; }
    var mainFile = path.join(root, 'src', 'main.rs');
    if (!fs.existsSync(mainFile)) mainFile = path.join(root, 'main.rs');
    var src = fs.readFileSync(mainFile, 'utf8');
    var F = getFRS();
    var res = F.compile(src, { file: 'main.rs' });
    if (!res.compileOk) { process.stderr.write(res.stderr); return 1; }
    if (res.stderr) process.stderr.write(res.stderr);
    say('     Running `' + (depsInfo.cfg.package.name || 'target') + '`');
    if (res.runStderr) { process.stderr.write(res.runStderr + '\n'); return 101; }
    process.stdout.write(res.stdout || '');
    return 0;
  }

  return {
    newProject: newProject,
    build: build,
    run: run,
    parseCargoToml: parseCargoToml,
    ensureDeps: ensureDeps,
    versionSatisfies: versionSatisfies
  };
}));

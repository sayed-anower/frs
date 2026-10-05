/* frs/src/pm.js — cargo-like package manager: new/build/run.
 * Node-only. Zero deps. Downloads crates from crates.io with `curl`-free
 * https, extracts via system tar, compiles deps with our own checker, and
 * caches artifacts in frs_target/ so deps aren't recompiled every run.
 *
 * Production notes (all pure Node.js, no npm deps):
 * - version requirements: `*`, `^`, `~`, `=`, `>=`, `>`, `<=`, `<`, partials
 *   (`1`, `1.2`, `1.*`), comma AND (`">=1.0, <2"`), `||` OR; prereleases only
 *   match when requested (or when nothing stable matches).
 * - manifests: `[dependencies]`, `[dependencies.NAME]` tables, `[target.*.dependencies]`
 *   (assumed matching host). Skipped with a note: dev-/build-dependencies,
 *   `optional = true` (no feature unification), `git`/`path` sources.
 * - TRANSITIVE (chain) dependencies are resolved recursively (BFS, cycle-safe,
 *   conflict-aware: one version per crate satisfying ALL collected reqs) and
 *   pinned in `frs_target/frs-lock.json` for deterministic rebuilds.
 * - lib compilation is REAL: the crate's whole module tree (`mod foo;`,
 *   `#[path]`, inline `mod foo { }`) is collected and every file is checked
 *   with the crate's own dependency names as known externs; artifacts record
 *   per-file fingerprints for correct freshness.
 * - file checking fans out over `worker_threads` (bounded pool, sync fallback)
 *   when available; browsers/old Node just run the same code synchronously.
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
  function getWT() {
    try { return require('worker_threads'); } catch (e) { return null; }
  }
  function cpuCount() {
    try { var os = require('os'); var c = os.cpus() && os.cpus().length; return c > 0 ? c : 2; }
    catch (e) { return 2; }
  }

  function say(s) { process.stdout.write(s + '\n'); }
  function err(s) { process.stderr.write(s + '\n'); }

  // ---------------- Cargo.toml parsing (subset, production flavor) ----------------
  function parseCargoToml(text) {
    var cfg = { package: {}, dependencies: {}, lib: null, bins: [] };
    var sect = null, sectDep = null; // sectDep set for `[dependencies.NAME]`
    var lines = String(text).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].split('#')[0].trim();
      if (!line) continue;
      var m = line.match(/^\[\[(.+)\]\]$/);
      if (m) {
        var arrSect = m[1].trim();
        sect = arrSect; sectDep = null;
        if (arrSect === 'bin') cfg.bins.push({});
        continue;
      }
      m = line.match(/^\[(.+)\]$/);
      if (m) {
        sect = m[1].trim(); sectDep = null;
        var dm = sect.match(/^dependencies\.(.+)$/);
        if (dm) {
          sectDep = dm[1].trim();
          if (!cfg.dependencies[sectDep]) cfg.dependencies[sectDep] = {};
        }
        continue;
      }
      var kv = line.match(/^([^\s=]+)\s*=\s*(.+)$/);
      if (!kv) continue;
      var key = kv[1].trim(), val = kv[2].trim();
      if (sectDep) {
        // `[dependencies.NAME]` table body
        mergeDepKey(cfg.dependencies[sectDep], key, val);
      } else if (sect === 'package') {
        cfg.package[key] = unquote(val);
      } else if (sect === 'dependencies' || (sect && /^(target\..*\.dependencies)$/.test(sect))) {
        cfg.dependencies[key] = parseDepSpec(val);
      } else if (sect === 'lib') {
        cfg.lib = cfg.lib || {};
        cfg.lib[key] = unquote(val);
      } else if (sect === 'bin' && cfg.bins.length) {
        cfg.bins[cfg.bins.length - 1][key] = unquote(val);
        // `[[bin]]` with explicit path handled by findMainEntry via name match
      }
      // dev-dependencies / build-dependencies / features / profile / patch /
      // workspace intentionally ignored (see module docs).
    }
    return cfg;
  }
  function mergeDepKey(spec, key, val) {
    if (key === 'version') spec.version = unquote(val);
    else if (key === 'features') spec.features = parseStrArray(val);
    else if (key === 'optional') spec.optional = (val === 'true');
    else if (key === 'package') spec.package = unquote(val);
    else if (key === 'default-features' || key === 'default_features') spec.defaultFeatures = (val !== 'false');
    else if (key === 'git') { spec.git = unquote(val); spec.skip = 'git source'; }
    else if (key === 'path') { spec.path = unquote(val); spec.skip = 'path source'; }
    else if (key === 'workspace') { if (val === 'true' && !spec.version) spec.version = '*'; }
  }
  function unquote(s) {
    s = String(s).trim();
    if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === '\'' && s[s.length - 1] === '\''))) return s.slice(1, -1);
    return s;
  }
  // quote-aware `["a", "b"]` parser (commas inside quotes don't split)
  function parseStrArray(val) {
    var out = [], cur = '', q = null;
    for (var i = 0; i < val.length; i++) {
      var c = val[i];
      if (q) {
        if (c === q) q = null;
        else cur += c;
      } else if (c === '"' || c === '\'') q = c;
      else if (c === ',') { if (cur.trim()) out.push(cur.trim()); cur = ''; }
      else if (c !== '[' && c !== ']') cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out.filter(Boolean);
  }
  // quote-aware `k = v, ...` splitter for inline tables
  function splitTable(val) {
    var parts = [], cur = '', q = null, depth = 0;
    for (var i = 0; i < val.length; i++) {
      var c = val[i];
      if (q) { cur += c; if (c === q) q = null; }
      else if (c === '"' || c === '\'') { q = c; cur += c; }
      else if (c === '[') { depth++; cur += c; }
      else if (c === ']') { depth--; cur += c; }
      else if (c === ',' && depth === 0) { parts.push(cur); cur = ''; }
      else cur += c;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
  }
  function parseDepSpec(val) {
    val = String(val).trim();
    if (val[0] === '"' || val[0] === '\'') return { version: unquote(val), features: [] };
    if (val[0] === '{') {
      var spec = { version: '*', features: [] };
      var inner = val.replace(/^\{/, '').replace(/\}$/, '');
      var parts = splitTable(inner);
      for (var i = 0; i < parts.length; i++) {
        var kv = parts[i].match(/^\s*([A-Za-z0-9_\-]+)\s*=\s*(.+?)\s*$/);
        if (!kv) continue;
        var k = kv[1].replace(/-/g, ''), v = kv[2];
        if (k === 'version') spec.version = unquote(v);
        else if (k === 'features') spec.features = parseStrArray(v);
        else if (k === 'optional') spec.optional = (v === 'true');
        else if (k === 'package') spec.package = unquote(v);
        else if (k === 'defaultfeatures') spec.defaultFeatures = (v !== 'false');
        else if (k === 'git') { spec.git = unquote(v); spec.skip = 'git source'; }
        else if (k === 'path') { spec.path = unquote(v); spec.skip = 'path source'; }
        else if (k === 'workspace') { if (v === 'true' && !spec.version) spec.version = '*'; }
      }
      if (!spec.version) spec.version = '*';
      return spec;
    }
    return { version: unquote(val) || '*', features: [] };
  }

  // ---------------- version requirements (caret/tilde/range aware) ----------------
  function splitPre(v) {
    var idx = String(v).indexOf('-');
    if (idx === -1) return { core: String(v), pre: null };
    return { core: String(v).slice(0, idx), pre: String(v).slice(idx + 1) };
  }
  function coreNums(core) {
    var out = String(core).split('.').map(function (x) { var p = parseInt(x, 10); return isNaN(p) ? 0 : p; });
    while (out.length < 3) out.push(0);
    return out.slice(0, 3);
  }
  function cmpCore(a, b) {
    var ap = coreNums(splitPre(a).core), bp = coreNums(splitPre(b).core);
    for (var i = 0; i < 3; i++) { if (ap[i] !== bp[i]) return ap[i] - bp[i]; }
    return 0;
  }
  function cmpSemver(a, b) { return cmpCore(a, b); }
  function upperBoundExclusive(nums, idx) {
    // caret upper bound: first non-zero component from `idx` bumps
    var b = [nums[0] || 0, nums[1] || 0, nums[2] || 0];
    var at = idx;
    while (at < 2 && b[at] === 0) at++;
    b[at]++;
    for (var i = at + 1; i < 3; i++) b[i] = 0;
    return b;
  }
  function cmpArr(a, b) {
    for (var i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
    return 0;
  }
  function satisfiesOne(comp, ver) {
    comp = String(comp || '').trim();
    if (comp === '' || comp === '*') return true;
    var m = comp.match(/^(>=|<=|>|<|=|\^|~)?\s*(.+?)\s*$/);
    if (!m) return false;
    var op = m[1] || '', target = m[2];
    var wild = target.match(/^(\d+)(?:\.(\d+|\*))?(?:\.(\d+|\*))?$/);
    var vp = splitPre(ver), tp = splitPre(target);
    var vc = coreNums(vp.core), tc = coreNums(tp.core);
    var c = cmpArr(vc, tc);
    function preOk() {
      // prereleases match only when the requirement names the same core prerelease
      if (!vp.pre) return true;
      return !!tp.pre && tc[0] === vc[0] && tc[1] === vc[1] && tc[2] === vc[2];
    }
    if (op === '=') {
      if (c !== 0) return false;
      if (tp.pre) return ver === target;
      return !vp.pre;
    }
    if (op === '>') return c > 0 && preOk();
    if (op === '>=') return c >= 0 && preOk();
    if (op === '<') return c < 0 && preOk();
    if (op === '<=') return c <= 0 && preOk();
    if (op === '~' || op === '^' || op === '') {
      var specLen = target.split('.').length;
      if (wild && (wild[2] === '*' || wild[3] === '*')) {
        // 1.* / 1.2.* prefix range
        var prefix = wild[1] + '.' + (wild[2] === '*' || wild[2] === undefined ? 'x' : wild[2]);
        if (wild[2] === '*' || wild[2] === undefined) return (vc[0] === tc[0]) && preOk();
        return (vc[0] === tc[0] && vc[1] === tc[1]) && preOk();
      }
      var lo = tc;
      var hi;
      if (op === '~') {
        hi = specLen <= 1 ? [tc[0] + 1, 0, 0] : [tc[0], tc[1] + 1, 0];
      } else {
        // ^ (and bare, cargo's default): bump left-most non-zero
        if (specLen <= 1) hi = [tc[0] + 1, 0, 0];
        else if (specLen === 2) hi = tc[0] === 0 ? [0, tc[1] + 1, 0] : [tc[0] + 1, 0, 0];
        else hi = upperBoundExclusive(tc, 0);
      }
      return cmpArr(vc, lo) >= 0 && cmpArr(vc, hi) < 0 && preOk();
    }
    return false;
  }
  function satisfiesAll(req, ver) {
    var ors = String(req || '*').split('||');
    for (var o = 0; o < ors.length; o++) {
      var ands = [];
      ors[o].trim().split(',').forEach(function (piece) {
        piece.trim().split(/\s+/).forEach(function (bit) { if (bit) ands.push(bit); });
      });
      var ok = true;
      for (var i = 0; i < ands.length; i++) {
        if (!satisfiesOne(ands[i], ver)) { ok = false; break; }
      }
      if (ok && ands.length) return true;
      if (!ands.length) return true;
    }
    return false;
  }
  function versionSatisfies(req, ver) {
    req = String(req || '*').trim();
    if (req === '*' || req === '') return true;
    return satisfiesAll(req, ver);
  }

  // version listing / download (unchanged protocol, lock-aware callers)
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
            for (var i = 0; i < vers.length; i++) {
              if (!vers[i]) continue;
              if (vers[i].yanked) continue;
              if (vers[i].num) out.push(vers[i].num);
              else if (typeof vers[i] === 'string') out.push(vers[i]);
            }
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

  function reportPct(done, total, label) {
    var pct = total ? Math.round((done / total) * 100) : 100;
    try { process.stderr.write('Compiling ' + pct + '% done' + (label ? ' (' + label + ')' : '') + '\n'); } catch (e) {}
  }

  // Bounded parallel pool (pure JS, zero deps): runs mapper over items with
  // at most `limit` in flight. Used for downloads and (sync-CPU) compile steps.
  async function pool(items, limit, mapper) {
    var out = new Array(items.length);
    var idx = 0;
    var workers = [];
    limit = Math.max(1, Math.min(limit || 4, items.length));
    for (var w = 0; w < limit; w++) {
      workers.push((async function () {
        while (true) {
          var my = idx++;
          if (my >= items.length) return;
          out[my] = await mapper(items[my], my);
        }
      })());
    }
    await Promise.all(workers);
    return out;
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
    // stable releases first (cargo behavior); prereleases only when requested
    // or when nothing stable matches.
    var reqWantsPre = /-/.test(String(req || ''));
    var best = null, bestPre = null;
    for (var i = 0; i < vers.length; i++) {
      if (!versionSatisfies(req, vers[i])) continue;
      var isPre = /-/.test(vers[i]);
      if (isPre && !reqWantsPre) {
        if (!bestPre || cmpSemver(vers[i], bestPre) > 0) bestPre = vers[i];
        continue;
      }
      if (!best || cmpSemver(vers[i], best) > 0) best = vers[i];
    }
    return best || bestPre;
  }
  function os_mkdir(p) { fs.mkdirSync(p, { recursive: true }); }

  function lockPath(root) { return path.join(root, 'frs_target', 'frs-lock.json'); }
  function readLock(root) {
    try {
      var j = JSON.parse(fs.readFileSync(lockPath(root), 'utf8'));
      if (j && (j.version === 1 || j.version === 2) && j.units) return j;
    } catch (e) {}
    return null;
  }
  // units: [{alias, name, ver, reqs, deps, depth, features}]
  // deps entries are unit ids (`alias|name|ver`) in v2, or plain aliases in v1.
  function unitId(u) { return u.alias + '|' + u.name + '|' + u.ver; }
  function depId(d) {
    if (typeof d === 'string') return d;
    if (d && d.id) return d.id;
    if (d && d.alias && d.ver) return d.alias + '|' + (d.name || d.alias) + '|' + d.ver;
    if (d && d.alias) return d.alias;
    return String(d);
  }
  function writeLock(root, units) {
    try {
      os_mkdir(path.dirname(lockPath(root)));
      var lite = {};
      units.forEach(function (u) {
        lite[unitId(u)] = {
          alias: u.alias, name: u.name, ver: u.ver, reqs: u.reqs,
          deps: (u.deps || []).map(function (d) { return depId(d); }),
          depth: u.depth || 0, features: u.features || []
        };
      });
      fs.writeFileSync(lockPath(root), JSON.stringify({ version: 2, units: lite }, null, 2));
    } catch (e) { /* best effort */ }
  }
  // Read a crate manifest's child deps: normal + target-specific deps are
  // buildable; dev-/build-/optional/git/path deps are reported as skipped.
  // Returns {buildable:[{alias, spec}], skipped:[{alias, reason}]}.
  function manifestChildDeps(manifest) {
    var buildable = [], skipped = [];
    var deps = (manifest && manifest.dependencies) || {};
    Object.keys(deps).forEach(function (alias) {
      var spec = deps[alias] || {};
      if (spec.skip) skipped.push({ alias: alias, reason: spec.skip + ' — unsupported source' });
      else if (spec.optional) skipped.push({ alias: alias, reason: 'optional (no feature unification)' });
      else buildable.push({ alias: alias, spec: spec });
    });
    return { buildable: buildable, skipped: skipped };
  }

  // Resolve the FULL transitive graph (chain dependencies): BFS from the root
  // manifest, cargo-style side-by-side versions (multiple major versions of
  // the same crate coexist as separate units when reqs are incompatible,
  // e.g. `syn 2` vs `syn 3`). Downloading + extracting along the way.
  // Returns {units, notes}; each unit is
  // {alias, name(real), ver, reqs, srcDir, deps:[{alias,id}], depth, features}.
  // Unit identity is `alias|name|ver` so forks stay distinct in the lockfile.
  async function resolveGraph(root, rootCfg, cacheDir, hooks) {
    hooks = hooks || {};
    var notes = [];
    function note(s) {
      notes.push(s);
      if (hooks.note) { try { hooks.note(s); } catch (e) {} }
      else say('    ' + s);
    }
    var versionLists = {}; // realName -> [vers] (one index fetch per crate max)
    async function listVersions(realName) {
      if (!versionLists[realName]) versionLists[realName] = await fetchVersionsWithUA(realName);
      return versionLists[realName];
    }
    async function materialize(realName, ver) {
      var srcDir = path.join(cacheDir, 'src', realName + '-' + ver);
      if (fs.existsSync(path.join(srcDir, 'Cargo.toml'))) return srcDir;
      process.stdout.write('  Downloading ' + realName + ' v' + ver + '\n');
      await downloadCrate(realName, ver, dlPath(cacheDir, realName, ver));
      os_mkdir(path.join(cacheDir, 'src'));
      cp.execSync('tar -xzf "' + dlPath(cacheDir, realName, ver) + '" -C "' + path.join(cacheDir, 'src') + '"');
      return srcDir;
    }
    async function pickVersion(realName, reqs) {
      var joined = (reqs || []).filter(Boolean).join(', ') || '*';
      var local = pickLocalVersion(cacheDir, realName, joined);
      if (local) return local;
      process.stdout.write('    Updating crates.io index\n');
      var vers = await listVersions(realName);
      var best = bestVersion(vers, joined);
      if (!best) throw new Error('no version of `' + realName + '` matches `' + joined + '`');
      return best;
    }

    // 1. lockfile fast path (no network): validate root reqs + disk presence.
    // v2 ids (`alias|name|ver`) or legacy v1 keys (plain alias).
    var locked = readLock(root);
    if (locked) {
      var rootNames = Object.keys(rootCfg.dependencies || {}).filter(function (a) {
        var s = rootCfg.dependencies[a] || {};
        return !s.skip && !s.optional;
      });
      var lockUnits = [], lockOk = true;
      var seenIds = {};
      function lockEntryFor(alias, req) {
        var keys = Object.keys(locked.units || {});
        var best = null, bestKey = null;
        for (var ki = 0; ki < keys.length; ki++) {
          var e = locked.units[keys[ki]];
          if (!e) continue;
          var ea = e.alias || keys[ki];
          var en = e.name || ea;
          if (ea !== alias) continue;
          if (req && !versionSatisfies(req, e.ver)) continue;
          if (!best || cmpSemver(e.ver, best.ver) > 0) { best = e; bestKey = keys[ki]; }
        }
        return best ? { key: bestKey, entry: best } : null;
      }
      // seed from root reqs: one locked unit per root dep satisfying its req
      var seedIds = [];
      for (var si0 = 0; si0 < rootNames.length && lockOk; si0++) {
        var spec0 = rootCfg.dependencies[rootNames[si0]] || {};
        var hit0 = lockEntryFor(rootNames[si0], spec0.version || '*');
        if (!hit0) { lockOk = false; break; }
        seedIds.push(hit0.key);
      }
      var stackL = seedIds.slice();
      while (stackL.length && lockOk) {
        var lid = stackL.pop();
        if (seenIds[lid]) continue;
        seenIds[lid] = 1;
        var le = locked.units[lid];
        if (!le) { lockOk = false; break; }
        var la = le.alias || lid;
        var lsd = path.join(cacheDir, 'src', (le.name || la) + '-' + le.ver);
        if (!fs.existsSync(path.join(lsd, 'Cargo.toml'))) { lockOk = false; break; }
        lockUnits.push({ alias: la, name: le.name || la, ver: le.ver, reqs: le.reqs || ['*'], srcDir: lsd, deps: [], depth: 0, features: le.features || [], _lid: lid, _depIds: (le.deps || []).slice() });
        (le.deps || []).forEach(function (da) { stackL.push(typeof da === 'string' ? da : depId(da)); });
      }
      if (lockOk && lockUnits.length) {
        var byIdL = {};
        lockUnits.forEach(function (u) { byIdL[u._lid] = u; });
        // legacy v1 dep edges are bare aliases: resolve them to the locked id
        // with that alias (best version match) so old lockfiles still load.
        lockUnits.forEach(function (u) {
          u.deps = (u._depIds || []).map(function (da) {
            if (typeof da === 'string' && !byIdL[da]) {
              var hitA = lockEntryFor(da, '*');
              if (hitA && byIdL[hitA.key]) return { alias: da, id: hitA.key };
              return { alias: String(da).split('|')[0], id: da };
            }
            var did = typeof da === 'string' ? da : depId(da);
            var tgt = byIdL[did];
            return { alias: tgt ? tgt.alias : String(did).split('|')[0], id: did };
          });
          delete u._depIds;
        });
        var changedL = true, guardL = 0;
        while (changedL && guardL++ < 100) {
          changedL = false;
          lockUnits.forEach(function (u) {
            u.deps.forEach(function (d) {
              var c = byIdL[d.id];
              if (c && u.depth <= c.depth) { u.depth = c.depth + 1; changedL = true; }
            });
          });
        }
        lockUnits.sort(function (x, y) { return y.depth - x.depth; });
        lockUnits.forEach(function (u) { delete u._lid; });
        return { units: lockUnits, notes: notes };
      }
    }

    // 2. fresh BFS resolution (cycle-safe, cargo-style multi-version forks).
    var units = {};   // id -> unit
    var byAlias = {}; // alias -> [unit] (different versions coexist)
    function findSatisfying(alias, real, req) {
      var arr = byAlias[alias] || [];
      var best = null;
      for (var fi = 0; fi < arr.length; fi++) {
        var cand = arr[fi];
        if (cand.name !== real) continue;
        if (versionSatisfies(req, cand.ver)) {
          if (!best || cmpSemver(cand.ver, best.ver) > 0) best = cand;
        }
      }
      return best;
    }
    var queue = [];
    (function seedRoot() {
      var kids = manifestChildDeps(rootCfg);
      kids.skipped.forEach(function (s) { note('skipping `' + s.alias + '` (' + s.reason + ')'); });
      kids.buildable.forEach(function (d) {
        queue.push({ alias: d.alias, spec: d.spec, parent: '<root>', depth: 0 });
      });
    })();
    var guard2 = 0;
    function registerUnit(u) {
      var id = unitId(u);
      if (!units[id]) {
        units[id] = u;
        (byAlias[u.alias] = byAlias[u.alias] || []).push(u);
      }
      return units[id];
    }
    async function processOne(item) {
      var alias = item.alias, spec = item.spec || {};
      var real = spec.package || alias;
      var req = spec.version || '*';
      var fromId = item.fromId || null;
      // reuse a coexisting unit with the same alias+crate satisfying this req;
      // otherwise fork a new side-by-side version (cargo semantics for
      // incompatible majors like `syn 2` vs `syn 3`) instead of erroring.
      var u = findSatisfying(alias, real, req);
      if (u) {
        if (u.reqs.indexOf(req) === -1) u.reqs.push(req);
        if (!u.childrenRead) {
          // unit exists but children not read yet (created earlier in batch):
          // fall through to child reading below.
        } else {
          if (u.depth < (item.depth || 0)) u.depth = item.depth || 0;
          if (fromId && units[fromId]) {
            var par = units[fromId];
            var already = false;
            for (var di = 0; di < par.deps.length; di++) {
              if (par.deps[di].id === unitId(u)) { already = true; break; }
            }
            if (!already) par.deps.push({ alias: u.alias, id: unitId(u) });
          }
          return;
        }
      } else {
        var ver = await pickVersion(real, [req]);
        var srcDir = await materialize(real, ver);
        u = {
          alias: alias, name: real, ver: ver, reqs: [req], srcDir: srcDir,
          deps: [], depth: item.depth || 0, done: false, childrenRead: false,
          features: spec.features || []
        };
        registerUnit(u);
      }
      if (!u.childrenRead) {
        u.childrenRead = true;
        var mani = { dependencies: {} };
        try { mani = parseCargoToml(fs.readFileSync(path.join(u.srcDir, 'Cargo.toml'), 'utf8')); }
        catch (eM) {}
        u.deps = [];
        var kids2 = manifestChildDeps(mani);
        kids2.skipped.forEach(function (s) {
          note('skipping `' + s.alias + '` of `' + alias + ' v' + u.ver + '` (' + s.reason + ')');
        });
        kids2.buildable.forEach(function (k) {
          // link child after the child unit resolves: queue carries parent id.
          queue.push({ alias: k.alias, spec: k.spec, parent: alias, depth: (u.depth || 0) + 1, fromId: unitId(u), _pending: k });
        });
        u.done = true;
        // children links are added when each child resolves (see reuse path
        // above); for ordering, re-queue a link step is unnecessary because
        // processOne(child) patches parent.deps via fromId.
      }
      if (u.depth < (item.depth || 0)) u.depth = item.depth || 0;
      if (fromId && units[fromId]) {
        var par2 = units[fromId];
        var already2 = false;
        for (var dj = 0; dj < par2.deps.length; dj++) {
          if (par2.deps[dj].id === unitId(u)) { already2 = true; break; }
        }
        if (!already2) par2.deps.push({ alias: u.alias, id: unitId(u) });
      }
    }
    while (queue.length) {
      if (++guard2 > 5000) throw new Error('dependency resolution did not converge');
      // small batches overlap index/download latency; the event loop keeps
      // version decisions deterministic.
      var batch = queue.splice(0, 6);
      for (var bi = 0; bi < batch.length; bi++) {
        try {
          await processOne(batch[bi]);
        } catch (e) {
          var msg = String((e && e.message) || e);
          if (/crates\.io|download failed|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|returned \d\d\d/.test(msg)) {
            // offline: fall back to any locally cached version for this alias
            var rb = batch[bi].spec.package || batch[bi].alias;
            var fb = pickLocalVersion(cacheDir, rb, batch[bi].spec.version || '*') ||
                     pickLocalVersion(cacheDir, rb, '*');
            if (fb) {
              note('offline: using cached `' + batch[bi].alias + ' v' + fb + '`');
              var offU = {
                alias: batch[bi].alias, name: rb, ver: fb, reqs: [batch[bi].spec.version || '*'],
                srcDir: path.join(cacheDir, 'src', rb + '-' + fb), deps: [], depth: batch[bi].depth || 0,
                done: true, childrenRead: true, offline: true, features: []
              };
              registerUnit(offU);
              if (batch[bi].fromId && units[batch[bi].fromId]) {
                units[batch[bi].fromId].deps.push({ alias: offU.alias, id: unitId(offU) });
              }
              continue;
            }
          }
          throw e;
        }
      }
    }
    var list = Object.keys(units).map(function (k) { return units[k]; });
    // recompute depths from parent->child edges so leaves compile first even
    // when a shared unit was first seen deep and reused shallow (or vice versa).
    (function fixDepths() {
      var byId = {};
      list.forEach(function (u) { byId[unitId(u)] = u; });
      var changed = true, guard = 0;
      while (changed && guard++ < 100) {
        changed = false;
        list.forEach(function (u) {
          (u.deps || []).forEach(function (d) {
            var c = byId[d.id];
            if (c && u.depth <= c.depth) { u.depth = c.depth + 1; changed = true; }
          });
        });
      }
    })();
    list.sort(function (x, y) { return y.depth - x.depth; }); // leaves first
    writeLock(root, list);
    return { units: list, notes: notes };
  }

  // ---------------- crate module trees ----------------
  function getLexer() {
    try { return require('./lexer.js'); } catch (e) { return null; }
  }
  function normAbs(p) { try { return path.resolve(p); } catch (e) { return p; } }
  // Collect every module file of a crate: follows `mod foo;` (+ `#[path]`,
  // inline `mod foo { }` scopes) from the entry file. Returns
  // {files:[{abs, rel, src}], mods:[declared module names]}.
  function collectCrateFiles(srcRoot, entryAbs) {
    var files = [], seen = {}, mods = [], modSet = {};
    var LEX = getLexer();
    function noteMod(nm) { if (nm && !modSet[nm]) { modSet[nm] = 1; mods.push(nm); } }
    function baseDirFor(abs) {
      var b = path.basename(abs);
      if (b === 'mod.rs' || b === 'lib.rs' || b === 'main.rs') return path.dirname(abs);
      return path.join(path.dirname(abs), b.replace(/\.rs$/, ''));
    }
    function resolveModFile(dir, name, pathAttr) {
      var cands = pathAttr ? [path.join(dir, pathAttr)] : [path.join(dir, name + '.rs'), path.join(dir, name, 'mod.rs')];
      for (var i = 0; i < cands.length; i++) {
        try { if (fs.statSync(cands[i]).isFile()) return cands[i]; } catch (e) {}
      }
      return null;
    }
    function attrText(toks, i) {
      var d = 0, out = [];
      for (var q = i + 1; q < toks.length && q < i + 30; q++) {
        var vv = toks[q].v;
        if (vv === '[') d++;
        else if (vv === ']') { d--; if (d === 0) break; }
        else if (d === 1 && toks[q].t === 1) out.push(vv);
        else if (d === 1) out.push(vv);
      }
      return out.join('');
    }
    function visit(abs, depth) {
      if (depth > 25 || files.length > 500) return;
      var key = normAbs(abs);
      if (seen[key]) return;
      seen[key] = 1;
      var src;
      try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { return; }
      files.push({ abs: abs, rel: path.relative(srcRoot, abs) || path.basename(abs), src: src });
      if (LEX) visitLexed(src, baseDirFor(abs), depth);
      else visitRegex(src, baseDirFor(abs), depth);
    }
    function visitLexed(src, dir, depth) {
      var toks;
      try { toks = LEX.lex(src).tokens || []; } catch (e) { return visitRegex(src, dir, depth); }
      var n = toks.length, braceDepth = 0, frames = [], curDir = dir, pendingPath = null;
      for (var i = 0; i < n; i++) {
        var v = toks[i].v, t = toks[i].t;
        if (t === 5 && v === '{') {
          var isMod = false, mnm = null;
          if (i >= 2 && toks[i - 1].t === 1 && toks[i - 2] && toks[i - 2].v === 'mod') { isMod = true; mnm = toks[i - 1].v; }
          braceDepth++;
          if (isMod && mnm) {
            noteMod(mnm);
            frames.push({ depth: braceDepth, dir: curDir });
            curDir = path.join(curDir, mnm);
          }
          pendingPath = null;
          continue;
        }
        if (t === 5 && v === '}') {
          braceDepth--;
          while (frames.length && frames[frames.length - 1].depth > braceDepth) curDir = frames.pop().dir;
          continue;
        }
        if (t === 5 && v === '#' && toks[i + 1] && toks[i + 1].v === '[') {
          var at = attrText(toks, i);
          var pm = /path\s*=\s*"([^"]+)"/.exec(at);
          if (pm) pendingPath = pm[1];
          continue;
        }
        if (t === 1 && v === 'mod' && toks[i + 1] && toks[i + 1].t === 1) {
          var nm = toks[i + 1].v;
          var after = toks[i + 2] ? toks[i + 2].v : null;
          if (after === ';') {
            noteMod(nm);
            var cand = resolveModFile(curDir, nm, pendingPath);
            pendingPath = null;
            if (cand) visit(cand, depth + 1);
          } else pendingPath = null;
        }
      }
    }
    function visitRegex(src, dir, depth) {
      var re = /(?:#\[\s*path\s*=\s*"([^"]+)"\s*\]\s*)?(?:pub\s*(?:\([^)]*\))?\s*)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*(;|\{)/g;
      var m;
      while ((m = re.exec(src)) !== null) {
        noteMod(m[2]);
        if (m[3] === ';') {
          var cand = resolveModFile(dir, m[2], m[1] || null);
          if (cand) visit(cand, depth + 1);
        }
      }
    }
    visit(entryAbs, 0);
    return { files: files, mods: mods };
  }

  // ---------------- exports ----------------
  function collectExports(src) {
    // `pub` item names + `pub mod` + `pub use` leaves (alias-aware)
    var out = [], seen = {};
    function push(nm) { if (nm && !seen[nm]) { seen[nm] = 1; out.push(nm); } }
    var re = /\bpub\s+(?:const\s+|static\s+|fn\s+|struct\s+|enum\s+|type\s+|trait\s+|mod\s+)([A-Za-z_][A-Za-z0-9_]*)/g;
    var m;
    while ((m = re.exec(src)) !== null) push(m[1]);
    var ru = /\bpub\s+use\s+([^;]+);/g;
    while ((m = ru.exec(src)) !== null) {
      var tree = m[1], parts = [], depth = 0, cur = '';
      for (var i = 0; i < tree.length; i++) {
        var c = tree[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        if (c === ',' && depth === 0) { parts.push(cur); cur = ''; }
        else cur += c;
      }
      if (cur.trim()) parts.push(cur);
      parts.forEach(function (p) {
        var am = p.match(/as\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/);
        if (am) { push(am[1]); return; }
        var ids = p.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
        var leaf = null;
        for (var k = 0; k < ids.length; k++) {
          if (ids[k] === 'self' || ids[k] === 'super' || ids[k] === 'crate') continue;
          leaf = ids[k];
        }
        if (leaf) push(leaf);
      });
    }
    return out;
  }

  // ---------------- file checking (worker pool + sync fallback) ----------------
  function checkOneSync(job) {
    var F = getFRS();
    try {
      var res = F.check(job.src, { file: job.file, lib: true, warnings: false, externs: job.externs || null, localMods: job.localMods || null });
      return { rel: job.rel, errCount: res.errCount, stderr: res.stderr || '', warnCount: res.warnCount || 0 };
    } catch (e) { return { rel: job.rel, errCount: 0, stderr: '', error: String((e && e.message) || e) }; }
  }
  function workerScript() {
    return [
      "const { parentPort, workerData } = require('worker_threads');",
      'var FRS = null;',
      'try { FRS = require(workerData.frsPath); } catch (e) { parentPort.postMessage({ __workerError: String((e && e.message) || e) }); }',
      "parentPort.on('message', function (batch) {",
      '  if (!FRS) return;',
      '  var out = batch.map(function (job) {',
      '    try {',
      '      var res = FRS.check(job.src, { file: job.file, lib: true, warnings: false, externs: job.externs || null, localMods: job.localMods || null });',
      "      return { rel: job.rel, errCount: res.errCount, stderr: res.stderr || '', warnCount: res.warnCount || 0 };",
      "    } catch (e) { return { rel: job.rel, errCount: 0, stderr: '', error: String((e && e.message) || e) }; }",
      '  });',
      '  parentPort.postMessage(out);',
      '});'
    ].join('\n');
  }
  async function checkFiles(jobs, frsDir) {
    if (!jobs.length) return [];
    var WT = getWT();
    if (!WT || jobs.length < 12) return jobs.map(checkOneSync);
    var nWorkers = Math.max(1, Math.min(cpuCount(), 8, jobs.length));
    var per = Math.ceil(jobs.length / nWorkers), chunks = [];
    for (var i = 0; i < jobs.length; i += per) chunks.push(jobs.slice(i, i + per));
    var script = workerScript();
    var frsPath = path.join(frsDir, 'frs.js');
    var results = await pool(chunks, chunks.length, function (chunk) {
      return new Promise(function (resolve) {
        var done = false;
        function finish(val) { if (!done) { done = true; resolve(val); } }
        var worker;
        try {
          worker = new WT.Worker(script, { eval: true, workerData: { frsPath: frsPath } });
        } catch (e) { return finish(chunk.map(checkOneSync)); }
        var timer = setTimeout(function () {
          try { worker.terminate(); } catch (e) {}
          finish(chunk.map(checkOneSync));
        }, 120000);
        worker.on('message', function (out) {
          clearTimeout(timer);
          try { worker.terminate(); } catch (e) {}
          if (out && out.__workerError) finish(chunk.map(checkOneSync));
          else finish(out);
        });
        worker.on('error', function () {
          clearTimeout(timer);
          try { worker.terminate(); } catch (e) {}
          finish(chunk.map(checkOneSync));
        });
        try { worker.postMessage(chunk); } catch (e) {
          clearTimeout(timer);
          finish(chunk.map(checkOneSync));
        }
      });
    });
    var flat = [];
    results.forEach(function (r) { (r || []).forEach(function (x) { flat.push(x); }); });
    return flat;
  }

  // compile a dep crate (whole module tree) with frs and cache the artifact JSON
  async function compileDepCached(root, unit, allExterns, cacheDir, frsDir) {
    var libPath = findLibEntry(unit.srcDir);
    var cacheFile = path.join(root, 'frs_target', 'deps', unit.name + '-' + unit.ver + '.json');
    // fast path: reuse artifact when it is newer than every listed source file
    // (no tree walk needed on a hot cache).
    try {
      var art0 = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (art0 && art0.files && art0.files.length) {
        var cf0 = fs.statSync(cacheFile);
        var newest0 = 0, missing0 = false;
        for (var fi0 = 0; fi0 < art0.files.length; fi0++) {
          try { newest0 = Math.max(newest0, fs.statSync(path.join(unit.srcDir, art0.files[fi0])).mtimeMs); }
          catch (eM) { missing0 = true; break; }
        }
        if (!missing0 && newest0 > 0 && cf0.mtimeMs >= newest0) {
          say('   Fresh ' + unit.name + ' v' + unit.ver);
          return art0;
        }
      }
    } catch (e) { /* cache miss: full walk below */ }
    var tree = collectCrateFiles(unit.srcDir, libPath);

    say('   Compiling ' + unit.name + ' v' + unit.ver + ' (' + tree.files.length + ' files)');
    var jobs = tree.files.map(function (f) {
      return { rel: f.rel, file: unit.name + '/' + f.rel, src: f.src, externs: allExterns, localMods: tree.mods };
    });
    var results = await checkFiles(jobs, frsDir);
    var errCount = 0, warnCount = 0, stderrParts = [];
    results.forEach(function (r) {
      errCount += r.errCount || 0;
      warnCount += r.warnCount || 0;
      if (r.stderr) stderrParts.push(r.stderr);
    });
    var exports = [];
    tree.files.forEach(function (f) {
      collectExports(f.src).forEach(function (x) { if (exports.indexOf(x) === -1) exports.push(x); });
    });
    var artifact = {
      name: unit.name, version: unit.ver, crate: unit.name + '-' + unit.ver,
      libPath: libPath, files: tree.files.map(function (f) { return f.rel; }),
      ok: errCount === 0, errCount: errCount, exports: exports,
      deps: unit.deps.map(function (d) { return d.alias; }),
      compiledAt: new Date().toISOString()
    };
    try {
      os_mkdir(path.dirname(cacheFile));
      fs.writeFileSync(cacheFile, JSON.stringify(artifact, null, 2));
    } catch (e) { /* best effort */ }
    if (errCount > 0) {
      say('    warning: `' + unit.name + '` has ' + errCount + ' check issue(s) under frs (lenient: build continues)');
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

  function findMainEntry(root) {
    var mainRs = path.join(root, 'src', 'main.rs');
    if (fs.existsSync(mainRs)) return { file: mainRs, lib: false };
    var libRs = path.join(root, 'src', 'lib.rs');
    if (fs.existsSync(libRs)) return { file: libRs, lib: true };
    try {
      var cfg = parseCargoToml(fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8'));
      if (cfg.lib && cfg.lib.path) {
        var lp = path.join(root, cfg.lib.path);
        if (fs.existsSync(lp)) return { file: lp, lib: true };
      }
    } catch (e) {}
    if (fs.existsSync(path.join(root, 'main.rs'))) return { file: path.join(root, 'main.rs'), lib: false };
    return { file: mainRs, lib: false };
  }

  // Merge a multi-file crate into ONE source for execution: `mod foo;`
  // (+ optional `#[path]`) becomes `mod foo { <file contents> }` recursively.
  // The interpreter resolves `foo::bar()` through mod-aware qns entries.
  function mergeMainSource(mainFile) {
    var seen = {}, files = 0;
    function load(abs, depth) {
      var key = normAbs(abs);
      if (seen[key] || depth > 25 || files > 500) return null;
      var src;
      try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { return null; }
      seen[key] = 1;
      files++;
      return expandMods(src, path.dirname(abs), depth);
    }
    function expandMods(src, dir, depth) {
      return String(src).replace(/(?:#\[\s*path\s*=\s*"([^"]+)"\s*\]\s*)?\bmod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g, function (whole, pathAttr, nm) {
        var cands = pathAttr ? [path.join(dir, pathAttr)] : [path.join(dir, nm + '.rs'), path.join(dir, nm, 'mod.rs')];
        for (var i = 0; i < cands.length; i++) {
          var inner = load(cands[i], depth + 1);
          if (inner !== null) return 'mod ' + nm + ' { ' + inner + ' }';
        }
        return whole;
      });
    }
    var out = load(mainFile, 0);
    return out === null ? fs.readFileSync(mainFile, 'utf8') : out;
  }

  // resolve -> download -> extract -> compile dep -> cache artifact
  async function ensureDeps(root) {
    var cfg = parseCargoToml(fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8'));
    var names = Object.keys(cfg.dependencies || {});
    if (!names.length) return { cfg: cfg, installed: {}, units: [] };

    var cacheDir = path.join(root, 'frs_target', 'registry');
    var frsDir = null;
    try { frsDir = path.dirname(require.resolve('./frs.js')); } catch (e) { frsDir = path.join(__dirname, '..', 'src'); }
    os_mkdir(cacheDir);
    reportPct(0, 100, 'resolving');
    var graph;
    try {
      graph = await resolveGraph(root, cfg, cacheDir, { note: function (s) { say('    ' + s); } });
    } catch (e) {
      err('error: ' + ((e && e.message) || e));
      throw e;
    }
    var units = graph.units || [];
    var externSet = {};
    units.forEach(function (u) { externSet[u.alias] = 1; externSet[u.name] = 1; });
    var allExterns = Object.keys(externSet);
    var done = 0;
    await pool(units, Math.max(1, Math.min(cpuCount(), 8)), async function (u) {
      await compileDepCached(root, u, allExterns, cacheDir, frsDir);
      done++;
      reportPct(Math.round((done / Math.max(1, units.length)) * 70), 100, u.name + ' v' + u.ver);
    });
    var deps = {};
    units.forEach(function (u) { deps[u.alias] = u.ver; });
    return { cfg: cfg, installed: deps, units: units };
  }

  // entry point: build == deps + check crate (whole module tree) | run == build+execute
  async function build(root) {
    if (!hasCargoToml(root)) { err('error: could not find `Cargo.toml` in `' + root + '`'); return 1; }
    var depsInfo;
    try { depsInfo = await ensureDeps(root); }
    catch (e) { return 1; }
    var entry = findMainEntry(root);
    var F = getFRS();
    var externSet = {};
    (depsInfo.units || []).forEach(function (u) { externSet[u.alias] = 1; externSet[u.name] = 1; });
    var tree = collectCrateFiles(root, entry.file);
    reportPct(75, 100, 'checking');
    var frsDir = null;
    try { frsDir = path.dirname(require.resolve('./frs.js')); } catch (e) { frsDir = root; }
    var jobs = tree.files.map(function (f) {
      return { rel: f.rel, file: f.rel, src: f.src, externs: Object.keys(externSet), localMods: tree.mods };
    });
    var results = await checkFiles(jobs, frsDir);
    var errCount = 0, stderrAll = [];
    results.forEach(function (r) { errCount += r.errCount || 0; if (r.stderr) stderrAll.push(r.stderr); });
    reportPct(100, 100, 'done');
    if (errCount > 0) { process.stderr.write(stderrAll.join('\n') + '\n'); return 1; }
    if (stderrAll.length) process.stderr.write(stderrAll.join('\n') + '\n');
    say('    Finished `dev` profile');
    return 0;
  }

  async function run(root) {
    if (!hasCargoToml(root)) { err('error: could not find `Cargo.toml` in `' + root + '`'); return 1; }
    var depsInfo;
    try { depsInfo = await ensureDeps(root); }
    catch (e) { return 1; }
    var entry = findMainEntry(root);
    var F = getFRS();
    var externSet = {};
    (depsInfo.units || []).forEach(function (u) { externSet[u.alias] = 1; externSet[u.name] = 1; });
    var tree = collectCrateFiles(root, entry.file);
    reportPct(75, 100, 'checking');
    var frsDir = null;
    try { frsDir = path.dirname(require.resolve('./frs.js')); } catch (e) { frsDir = root; }
    var jobs = tree.files.map(function (f) {
      return { rel: f.rel, file: f.rel, src: f.src, externs: Object.keys(externSet), localMods: tree.mods };
    });
    var results = await checkFiles(jobs, frsDir);
    var errCount = 0, stderrAll = [];
    results.forEach(function (r) { errCount += r.errCount || 0; if (r.stderr) stderrAll.push(r.stderr); });
    reportPct(100, 100, 'done');
    if (errCount > 0) { process.stderr.write(stderrAll.join('\n') + '\n'); return 1; }
    if (stderrAll.length) process.stderr.write(stderrAll.join('\n') + '\n');
    say('     Running `' + ((depsInfo.cfg.package && depsInfo.cfg.package.name) || 'target') + '`');
    var merged = mergeMainSource(entry.file);
    var res = F.compile(merged, { file: path.basename(entry.file), lib: entry.lib, externs: Object.keys(externSet), localMods: tree.mods });
    if (!res.compileOk) { process.stderr.write(res.stderr); return 1; }
    if (res.stderr) process.stderr.write(res.stderr);
    if (res.runStderr) { process.stderr.write(res.runStderr + '\n'); return 101; }
    process.stdout.write(res.stdout || '');
    if (res.serve) {
      // continuous web server (pure Node.js http/net): do NOT exit — keep serving hits.
      try { if (typeof global !== 'undefined') global.__frsServerRunning = true; } catch (eG) {}
      return new Promise(function () {}); // never resolves, event loop keeps server alive
    }
    return 0;
  }

  return {
    newProject: newProject,
    build: build,
    run: run,
    parseCargoToml: parseCargoToml,
    ensureDeps: ensureDeps,
    resolveGraph: resolveGraph,
    collectCrateFiles: collectCrateFiles,
    collectExports: collectExports,
    mergeMainSource: mergeMainSource,
    versionSatisfies: versionSatisfies
  };
}));


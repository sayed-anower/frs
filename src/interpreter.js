/* frs/src/interpreter.js — fake Rust runtime (println!, vars, exprs, control flow).
 * Pure JS, no deps. Fast + safe: iteration caps, no eval(), no I/O.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    var req = function (p) { try { return require(p); } catch (e) { return null; } };
    module.exports = factory(req('./util.js'), req('./lexer.js'), req('./rules/int_rules.js'));
  } else root.FRS_interp = factory(root.FRS_util, root.FRS_lexer, root.FRS_rules_int);
}(typeof self !== 'undefined' ? self : this, function (U, LEX, INT_RULES) {
  'use strict';
  INT_RULES = INT_RULES || {};
  var FS_X = null;
  try { FS_X = (typeof require !== 'undefined') ? require('fs') : null; } catch (e) { FS_X = null; }
  var NET_X = null;
  try { NET_X = (typeof require !== 'undefined') ? require('net') : null; } catch (e) { NET_X = null; }
  var HTTP_X = null;
  try { HTTP_X = (typeof require !== 'undefined') ? require('http') : null; } catch (e) { HTTP_X = null; }
  var TCP_SRVS = [];
  var NET_LISTENING = false;
  U = U || {}; LEX = LEX || {};
  var T = (LEX.T || { IDENT: 1, NUMBER: 2, STRING: 3, CHAR: 4, SYMBOL: 5, LIFETIME: 6, RAWSTR: 7, BYTESTR: 8 });

  var MAX_STEPS = 200000;
  var MAX_LOOP = 10000;
  var MAX_OUT = 20000;
  // Runtime lookup tables (src/rules/int_rules.js; inline fallback keeps the
  // engine working when the tables file isn't loaded, e.g. minimal embeds).
  var HTTP_STATUS = INT_RULES.HTTP_STATUS || {
    Ok: 200, Created: 201, Accepted: 202, NoContent: 204,
    MovedPermanently: 301, Found: 302, SeeOther: 303, NotModified: 304,
    TemporaryRedirect: 307, PermanentRedirect: 308,
    BadRequest: 400, Unauthorized: 401, PaymentRequired: 402, Forbidden: 403,
    NotFound: 404, MethodNotAllowed: 405, Conflict: 409, Gone: 410,
    UnprocessableEntity: 422, InternalServerError: 500, NotImplemented: 501,
    BadGateway: 502, ServiceUnavailable: 503, GatewayTimeout: 504
  };
  // route-attr macros: #[get("/")] / #[post(..)] / #[route(..)] / ...
  var HTTP_ROUTE_METHODS = INT_RULES.HTTP_ROUTE_METHODS || {
    get: 'GET', post: 'POST', put: 'PUT', delete: 'DELETE', head: 'HEAD',
    options: 'OPTIONS', patch: 'PATCH', trace: 'TRACE', connect: 'CONNECT'
  };
  var openFds = [];
  var STDIN_STATE = null;
  function readStdinLine() {
    if (STDIN_STATE === null) {
      STDIN_STATE = { pos: 0, buf: '', tty: false };
      var isTTY = (typeof process !== 'undefined' && process.stdin && process.stdin.isTTY);
      STDIN_STATE.tty = !!isTTY;
      if (!isTTY && FS_X) {
        try { STDIN_STATE.buf = FS_X.readFileSync(0, 'utf8'); } catch (e) { STDIN_STATE.buf = ''; }
      }
    }
    // Interactive terminal: block for one line like Python's input().
    // (Prompts are flushed to the terminal by the caller first.)
    if (STDIN_STATE.tty) return readTtyLine();
    var b = STDIN_STATE.buf, p = STDIN_STATE.pos;
    if (p >= b.length) return '';
    var i = b.indexOf('\n', p);
    var line = i === -1 ? b.slice(p) : b.slice(p, i + 1);
    STDIN_STATE.pos = i === -1 ? b.length : i + 1;
    return line;
  }
  // Blocking single-line read from a terminal, byte-by-byte so no
  // over-read: bytes after the first `\n` stay available for the next call.
  // EOF (Ctrl+D) yields '' — Rust's `Ok(0)` at end of input.
  function readTtyLine() {
    try {
      if (!FS_X || typeof FS_X.readSync !== 'function') return '';
      if (typeof Buffer === 'undefined') return '';
      // Never read fd 0 here when it is a real terminal: merely accessing
      // `process.stdin` (even `.isTTY`) makes libuv put fd 0 in O_NONBLOCK,
      // so raw fd-0 reads fail instantly with EAGAIN (busy "Invalid option"
      // loop instead of waiting). A fresh open() of /dev/tty is blocking
      // and immune to that. Non-terminal fd 0 (pipes, faked tests) is read
      // directly — raw reads block fine there.
      var useFd = ttyInputFd();
      if (process.env.FRS_DEBUG_STDIN) process.stderr.write('[tty-read start fd=' + useFd + ']\n');
      var bytes = [], one = Buffer.alloc(1);
      while (bytes.length < 1048576) {
        var n = 0;
        try { n = FS_X.readSync(useFd, one, 0, 1); } catch (eR) {
          if (process.env.FRS_DEBUG_STDIN) process.stderr.write('[tty-read threw ' + (eR && eR.code) + ' after ' + bytes.length + 'B]\n');
          break;
        }
        if (!n) {
          if (process.env.FRS_DEBUG_STDIN) process.stderr.write('[tty-read EOF after ' + bytes.length + 'B]\n');
          break; // EOF
        }
        bytes.push(one[0]);
        if (one[0] === 10) break; // '\n'
      }
      if (!bytes.length) return '';
      return Buffer.from(bytes).toString('utf8');
    } catch (e2) { return ''; }
  }
  // Input fd for terminal reads, cached for the process lifetime.
  // Returns a fresh blocking /dev/tty fd when stdin itself is a terminal,
  // else 0 (piped input, or no controlling terminal — e.g. Windows).
  function ttyInputFd() {
    if (STDIN_STATE.ttyFd === undefined || STDIN_STATE.ttyFd === null) {
      var fd = 0;
      var fd0IsTty = false;
      try {
        var s0 = FS_X.fstatSync(0);
        fd0IsTty = !!(s0 && s0.isCharacterDevice && s0.isCharacterDevice());
      } catch (eS) {}
      if (fd0IsTty) {
        try {
          if (FS_X && typeof FS_X.openSync === 'function') {
            var fresh = FS_X.openSync('/dev/tty', 'r');
            if (typeof fresh === 'number' && fresh >= 0) fd = fresh;
          }
        } catch (eO) { fd = 0; }
      }
      STDIN_STATE.ttyFd = fd;
    }
    return STDIN_STATE.ttyFd;
  }
  // Write out everything the program printed so far, so prompts are visible
  // BEFORE a blocking terminal read. Flushed text is marked on the array so
  // run() does not return (and re-print) it a second time.
  function flushProgramStdout(st) {
    try {
      if (typeof process === 'undefined' || !process.stdout || !process.stdout.isTTY) return;
      var arr = st && st.stdout;
      if (!arr || typeof arr.push !== 'function' || typeof process.stdout.write !== 'function') return;
      var from = arr.__flushed || 0;
      if (arr.length > from) {
        process.stdout.write(arr.slice(from).join(''));
        arr.__flushed = arr.length;
      }
    } catch (eF) {}
  }
  function run(src, opts) {
    opts = opts || {};
    // serving state is per-run: a previous server run in this process must not
    // leak `serve:true` into later runs (tests run many compiles in one process).
    NET_LISTENING = false;
    var lexed;
    try { lexed = LEX.lex(src); } catch (e) { lexed = { tokens: [] }; }
    var toks = lexed.tokens || [];
    var env = {};       // name -> {type, value}
    var fns = {};       // name -> {params:[names], bodyToks}
    var qns = {};       // Type::method -> fn entry (exact path calls)
    var stdout = [];
    var stderr = [];
    var steps = 0;
    var panicked = null;

    var macros = {};
    collectFns(toks, fns, qns, macros);

    // register top-level statics/consts into env before running main
    (function scanStatics() {
      var d = 0;
      for (var i = 0; i < toks.length; i++) {
        var v = toks[i].v;
        if (v === '{') d++;
        else if (v === '}') d--;
        else if (d === 0 && toks[i].t === T.IDENT && (v === 'static' || v === 'const')) {
          var j = i + 1, dd = 0, end = -1;
          while (j < toks.length) {
            var vv = toks[j].v;
            if (vv === '(' || vv === '[' || vv === '{' || vv === '<') dd++;
            else if (vv === ')' || vv === ']' || vv === '}' || vv === '>') dd--;
            else if (vv === '>>') dd -= 2;
            else if (vv === ';' && dd === 0) { end = j; break; }
            j++;
          }
          if (end !== -1) {
            var nameT = toks[i + 1];
            var eq = -1;
            for (var q = i + 1; q < end; q++) { if (toks[q].v === '=') { eq = q; break; } }
            if (eq !== -1 && nameT && nameT.t === T.IDENT) {
              try { env[nameT.v] = evalExpr(toks.slice(eq + 1, end), env, fns, { steps: 0, qns: qns, macros: macros, stdout: { push: function () {} }, stderr: { push: function () {} } }); }
              catch (e) { env[nameT.v] = { value: 0, type: 'unknown' }; }
            }
            i = end;
          }
        }
        if (d === 0 && v === 'macro_rules') {
          // skip to end of its {} block
          var k = i + 1;
          while (k < toks.length && toks[k].v !== '{') k++;
          var dd2 = 0;
          while (k < toks.length) {
            if (toks[k].v === '{') dd2++;
            else if (toks[k].v === '}') { dd2--; if (dd2 === 0) break; }
            k++;
          }
          i = k;
        }
      }
    })();

    // Execute fn main body (or whole file if no fn? run top-level lets+prints)
    var main = fns.main;
    var state = { steps: 0, qns: qns, macros: macros, opts: opts };
    // actix-web style route table (`#[get("/")]` + factory `.service/.route`)
    // collected up-front so `HttpServer::run()` can dispatch per request.
    state.routes = collectRoutes(toks, fns);
    try {
      if (main) execBlock(main.bodyToks, env, fns, stdout, stderr, state);
      else execBlock(toks, env, fns, stdout, stderr, state);
    } catch (e) {
      if (e && (e.__frsPanic || e.__frsTryErr)) panicked = e.__frsPanic ? e : { __frsPanic: true, msg: 'Error: ' + rustToString(e.value), line: 1, col: 1 };
      else throw e;
    }
    for (var oi = 0; oi < openFds.length; oi++) { try { FS_X && FS_X.closeSync(openFds[oi]); } catch (eO) {} }
    if (!NET_LISTENING) { for (var si = 0; si < TCP_SRVS.length; si++) { try { TCP_SRVS[si].close(); } catch (eS) {} } }

    // Text already flushed live to a terminal during interactive reads is
    // not returned again (the CLI would print it twice).
    var out = stdout.slice(stdout.__flushed || 0).join('');
    var serving = NET_LISTENING;
    if (out.length > MAX_OUT) out = out.slice(0, MAX_OUT);
    return {
      stdout: out,
      stderr: stderr.join(''),
      panicked: panicked, // {msg, line, col}
      env: env,
      serve: serving
    };
  }

  // ---- actix-web style routing + serving (pure Node.js http, zero deps) ----
  // Routes come from `#[get("/path")]`-style attributes on handler fns plus
  // `.route("path", web::get().to(handler))` registrations in the factory.
  function matchTokIn(arr, from, open, close) {
    var d = 0;
    for (var i = from; i < arr.length; i++) {
      if (arr[i].v === open) d++;
      else if (arr[i].v === close) { d--; if (d === 0) return i; }
    }
    return -1;
  }
  function routeArgString(argToks) {
    if (!argToks || argToks.length !== 1) return null;
    var t = argToks[0];
    if (t.t === T.STRING) {
      var inner = t.v.slice(1, -1);
      return inner.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (t.t === T.RAWSTR) {
      var q = t.v.indexOf('"'), h = 0, k;
      for (k = 1; k < q; k++) if (t.v[k] === '#') h++;
      return t.v.slice(q + 1, t.v.length - 1 - h);
    }
    return null;
  }
  function parseRouteAttr(inner, fname, routes) {
    // macro name = last IDENT before `(` (handles `actix_web::get("/..")` too)
    var mname = null, paren = -1;
    for (var a = 0; a < inner.length; a++) {
      if (inner[a].t === T.IDENT && inner[a + 1] && inner[a + 1].v === '(') { mname = inner[a].v; paren = a + 1; break; }
    }
    if (!mname || paren === -1) return;
    var close = matchTokIn(inner, paren, '(', ')');
    var args = splitArgs(inner.slice(paren + 1, close === -1 ? inner.length : close)).filter(function (x) { return x.length; });
    if (HTTP_ROUTE_METHODS[mname]) {
      var p = args.length ? routeArgString(args[0]) : null;
      if (p !== null) routes.push({ method: HTTP_ROUTE_METHODS[mname], path: p, handler: fname });
      return;
    }
    if (mname === 'route') {
      var rp = args.length ? routeArgString(args[0]) : null;
      if (rp === null) rp = '/';
      var methods = [];
      for (var q = 0; q < args.length; q++) {
        var aa = args[q];
        for (var w = 0; w + 2 < aa.length; w++) {
          if (aa[w].t === T.IDENT && aa[w].v === 'method' && aa[w + 1].v === '=') {
            var mv = routeArgString([aa[w + 2]]);
            if (mv) methods.push(mv.toUpperCase());
          }
        }
      }
      if (!methods.length) methods.push('*');
      for (var m2 = 0; m2 < methods.length; m2++) routes.push({ method: methods[m2], path: rp, handler: fname });
    }
  }
  function scanFactoryRoutes(toks, fns, routes) {
    // `.route("path", web::get().to(handler))` inside the HttpServer factory
    for (var i = 0; i + 3 < toks.length; i++) {
      if (toks[i].t !== T.IDENT || toks[i].v !== 'route') continue;
      if (!toks[i + 1] || toks[i + 1].v !== '(') continue;
      var ce = matchTok(toks, i + 1, '(', ')');
      if (ce === -1 || ce - i > 80) continue;
      var args = splitArgs(toks.slice(i + 2, ce)).filter(function (x) { return x.length; });
      if (args.length < 2) continue;
      var rp = routeArgString(args[0]);
      if (rp === null) continue;
      var meth = null, handler = null;
      var rest = args[1];
      for (var r2 = 0; r2 < rest.length; r2++) {
        if (rest[r2].t === T.IDENT && HTTP_ROUTE_METHODS[rest[r2].v] && rest[r2 + 1] && rest[r2 + 1].v === '(') {
          if (!meth) meth = HTTP_ROUTE_METHODS[rest[r2].v];
        }
        if (rest[r2].t === T.IDENT && rest[r2].v === 'to' && rest[r2 + 1] && rest[r2 + 1].v === '(' &&
            rest[r2 + 2] && rest[r2 + 2].t === T.IDENT && rest[r2 + 3] && rest[r2 + 3].v === ')') {
          handler = rest[r2 + 2].v;
        }
      }
      if (handler && fns[handler]) routes.push({ method: meth || '*', path: rp, handler: handler });
    }
  }
  function collectRoutes(toks, fns) {
    var routes = [];
    for (var i = 0; i + 1 < toks.length; i++) {
      if (toks[i].t === T.IDENT && toks[i].v === 'fn' && toks[i + 1] && toks[i + 1].t === T.IDENT) {
        var fname = toks[i + 1].v;
        if (!fns[fname]) continue;
        // scan back over `#[...]` attribute groups directly above the fn,
        // skipping modifiers (`async fn`, `pub fn`, `pub(crate) fn`, ...)
        var j = skipFnModifiers(toks, i - 1), guards = 0;
        while (j >= 0 && toks[j].v === ']' && guards < 8) {
          guards++;
          var o = j, d = 0;
          while (o >= 0) {
            if (toks[o].v === ']') d++;
            else if (toks[o].v === '[') { d--; if (d === 0) break; }
            o--;
          }
          if (o < 1 || !toks[o - 1] || toks[o - 1].v !== '#') break;
          parseRouteAttr(toks.slice(o + 1, j), fname, routes);
          j = skipFnModifiers(toks, o - 2);
        }
      }
    }
    try { scanFactoryRoutes(toks, fns, routes); } catch (eF) {}
    return routes;
  }
  function skipFnModifiers(toks, j) {
    while (j >= 0 && toks[j]) {
      var mv = toks[j].v;
      if (toks[j].t === T.IDENT && (mv === 'async' || mv === 'pub' || mv === 'unsafe' || mv === 'const' || mv === 'extern')) { j--; continue; }
      if (mv === ')') {
        var o2 = j, d2 = 0;
        while (o2 >= 0) {
          if (toks[o2].v === ')') d2++;
          else if (toks[o2].v === '(') { d2--; if (d2 === 0) break; }
          o2--;
        }
        if (o2 < 0) break;
        j = o2 - 1; continue;
      }
      break;
    }
    return j;
  }
  function routePathMatches(tmpl, path) {
    if (tmpl === path) return true;
    var a = String(tmpl).split('/'), b = String(path).split('/');
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      var s = a[i];
      if (s.length >= 2 && s[0] === '{' && s[s.length - 1] === '}') { if (!b[i].length) return false; continue; }
      if (s !== b[i]) return false;
    }
    return true;
  }
  function matchHttpRoute(routes, method, path) {
    for (var i = 0; i < routes.length; i++) {
      var r = routes[i];
      if (r.method !== '*' && r.method !== method) continue;
      if (routePathMatches(r.path, path)) return r;
    }
    return null;
  }
  function parseBindAddr(margs, env, fns, st) {
    var inner = margs.slice();
    if (inner.length >= 2 && inner[0].v === '(' && matchTok(inner, 0, '(', ')') === inner.length - 1) {
      inner = inner.slice(1, -1);
    }
    var parts = splitArgs(inner).filter(function (a) { return a.length; });
    try {
      if (parts.length >= 2) {
        var host = rustToString(evalExpr(parts[0], env, fns, st).value);
        var port = Math.floor(num(evalExpr(parts[1], env, fns, st).value));
        if (!isFinite(port) || port < 0 || port > 65535) return { ok: false, error: 'invalid port in bind address' };
        return { ok: true, host: host || '127.0.0.1', port: port };
      }
      if (parts.length === 1) {
        var one = evalExpr(parts[0], env, fns, st).value;
        if (typeof one === 'number') {
          var p0 = Math.floor(one);
          if (!isFinite(p0) || p0 < 0 || p0 > 65535) return { ok: false, error: 'invalid port in bind address' };
          return { ok: true, host: '127.0.0.1', port: p0 };
        }
        var s = rustToString(one);
        var m = /^(.*):(\d+)$/.exec(s);
        if (m) {
          var p1 = parseInt(m[2], 10);
          if (!isFinite(p1) || p1 < 0 || p1 > 65535) return { ok: false, error: 'invalid port in bind address' };
          return { ok: true, host: m[1] || '127.0.0.1', port: p1 };
        }
        var p2 = parseInt(s, 10);
        if (isFinite(p2) && String(p2) === s.trim()) return { ok: true, host: '127.0.0.1', port: p2 };
        return { ok: false, error: 'invalid bind address `' + s + '`' };
      }
    } catch (eP) { return { ok: false, error: String((eP && eP.message) || eP) }; }
    return { ok: false, error: 'invalid bind address' };
  }
  function httpBodyString(v) {
    if (v !== null && typeof v === 'object' && v.__rust === 'bytes') return v.raw || '';
    if (v !== null && typeof v === 'object' && v.__rust === 'vec') {
      try {
        if (typeof Buffer !== 'undefined') return Buffer.from(v.items.map(function (x) { return x | 0; })).toString('utf8');
      } catch (eB) {}
      return v.items.map(function (x) { return String.fromCharCode(x | 0); }).join('');
    }
    return rustToString(v);
  }
  function rustToJson(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v === 'object') {
      if (v.__rust === 'bytes') return JSON.stringify(v.raw || '');
      if (v.__rust === 'vec') return '[' + v.items.map(rustToJson).join(',') + ']';
      if (v.__rust === 'option') return v.some ? rustToJson(v.value) : 'null';
      if (v.__rust === 'result') return v.ok ? rustToJson(v.value) : '{"Err":' + rustToJson(v.value) + '}';
      if (v.__rust === 'struct' && v.fields) {
        var ks = Object.keys(v.fields);
        return '{' + ks.map(function (k2) { return JSON.stringify(k2) + ':' + rustToJson(v.fields[k2]); }).join(',') + '}';
      }
      if (v.__rust === 'ctor') return JSON.stringify(v.name + '(' + (v.args || []).map(rustToJson).join(', ') + ')');
    }
    return JSON.stringify(rustToString(v));
  }
  function httpResponseOf(v) {
    if (v !== null && typeof v === 'object') {
      if (v.__rust === 'httpresponse') return { status: v.status || 200, body: v.body || '', ctype: v.ctype || 'text/plain; charset=utf-8' };
      if (v.__rust === 'result') {
        return v.ok ? httpResponseOf(v.value)
                    : { status: 500, body: 'Internal Server Error', ctype: 'text/plain; charset=utf-8' };
      }
      if (v.__rust === 'option') {
        return v.some ? httpResponseOf(v.value)
                      : { status: 200, body: '', ctype: 'text/plain; charset=utf-8' };
      }
      if (v.__rust === 'bytes') return { status: 200, body: v.raw || '', ctype: 'application/octet-stream' };
      if (v.__rust === 'vec') return { status: 200, body: httpBodyString(v), ctype: 'text/plain; charset=utf-8' };
    }
    if (typeof v === 'string') return { status: 200, body: v, ctype: 'text/plain; charset=utf-8' };
    if (typeof v === 'number' || typeof v === 'boolean') return { status: 200, body: String(v), ctype: 'text/plain; charset=utf-8' };
    if (v === undefined || v === null) return { status: 200, body: '', ctype: 'text/plain; charset=utf-8' };
    return { status: 200, body: rustToString(v), ctype: 'text/plain; charset=utf-8' };
  }
  function startHttpServer(srv, routes, env, fns, stdout, stderr, st) {
    NET_LISTENING = true;
    if (st && st.opts && st.opts.noListen) return { ok: true, skipped: true };
    if (!HTTP_X) return { ok: false, error: 'net unavailable' };
    var host = srv._host || '127.0.0.1';
    var port = (srv._port === undefined || srv._port === null) ? 8080 : srv._port;
    try {
      var server = HTTP_X.createServer(function (req, res) {
        dispatchHttpRequest(routes, req, res, env, fns, stdout, stderr, st);
      });
      server.on('error', function (eH) {
        try { if (typeof process !== 'undefined' && process.stderr) process.stderr.write('error: failed to bind listener: ' + ((eH && eH.message) || eH) + '\n'); } catch (eI) {}
      });
      server.listen(port, host);
      TCP_SRVS.push(server);
      return { ok: true };
    } catch (eL) { return { ok: false, error: String((eL && eL.message) || eL) }; }
  }
  function dispatchHttpRequest(routes, req, res, env, fns, stdout, stderr, st) {
    var method = 'GET', path = '/';
    try {
      method = String(req.method || 'GET').toUpperCase();
      var url = String(req.url || '/');
      path = (url.split('?')[0] || '/').split('#')[0] || '/';
      try { path = decodeURIComponent(path); } catch (eD) {}
    } catch (eU) {}
    function send(status, body, ctype) {
      var b = (body === undefined || body === null) ? '' : String(body);
      var len = b.length, buf = b;
      try {
        if (typeof Buffer !== 'undefined') { buf = Buffer.from(b, 'utf8'); len = buf.length; }
        else len = b.length;
      } catch (eB) {}
      try {
        res.writeHead(status, { 'Content-Type': ctype || 'text/plain; charset=utf-8', 'Content-Length': len });
      } catch (eH) { try { res.statusCode = status; } catch (eS) {} }
      try { res.end(buf); } catch (eE) {}
    }
    var hit = null;
    try { hit = matchHttpRoute(routes, method, path); } catch (eM) { hit = null; }
    if (!hit) { send(404, 'Not Found'); return; }
    var handler = fns[hit.handler];
    if (!handler) { send(500, 'handler not found'); return; }
    var outMark = stdout.length, errMark = stderr.length, savedSteps = st.steps;
    st.steps = 0; // fresh execution budget per request (infinite loops still capped)
    try {
      var rv = execFnBody(handler, [], env, fns, st);
      var resp = httpResponseOf(rv && rv.value);
      send(resp.status, resp.body, resp.ctype);
    } catch (eX) {
      if (eX && eX.__frsPanic && process.stderr) { try { process.stderr.write('thread panicked: ' + eX.msg + '\n'); } catch (eW) {} }
      try { send(500, 'Internal Server Error'); } catch (e5) {}
    }
    st.steps = savedSteps;
    // live-flush handler prints (run() already returned); trim buffer growth
    try {
      if (typeof process !== 'undefined') {
        if (stdout.length > outMark && process.stdout) process.stdout.write(stdout.slice(outMark).join(''));
        if (stderr.length > errMark && process.stderr) process.stderr.write(stderr.slice(errMark).join(''));
      }
      if (stdout.length > 4000) stdout.splice(0, stdout.length - 4000);
      if (stderr.length > 1000) stderr.splice(0, stderr.length - 1000);
    } catch (eF) {}
  }

  // ---- fn collection: fn name(params) { body } ----
  // Top-level fns go in `fns`; methods inside `impl Type`/`trait` also get
  // qualified aliases `Type::method` in `qns` (exact path calls resolve there).
  function collectFns(toks, fns, qns, macros) {
    // parse macro_rules! defs: name -> [{params: [names], bodyToks: [...]}]
    if (macros) {
      for (var mi = 0; mi < toks.length; mi++) {
        if (toks[mi].t === T.IDENT && toks[mi].v === 'macro_rules') {
          var mni = mi + 1;
          if (toks[mni] && toks[mni].v === '!') mni++;
          var mname = (toks[mni] && toks[mni].t === T.IDENT) ? toks[mni].v : null;
          var msc = mni + 1;
          while (msc < toks.length && toks[msc].v !== '{') msc++;
          if (msc < toks.length && mname) {
            var bme = matchTok(toks, msc, '{', '}');
            var bodyT = bme === -1 ? [] : toks.slice(msc + 1, bme);
            // split arms on top-level `;` where each arm is `PAT => TRAN ::= split top-level '=>'
            // arm separator: `;` or new arm `(` — arms end with `};` or `}` then `,`
            var arms = [];
            // an arm looks like: ( ... ) => { ... } ;
            var ap = 0;
            while (ap < bodyT.length) {
              if (bodyT[ap].v !== '(') { ap++; continue; }
              var pce = matchTok(bodyT, ap, '(', ')');
              if (pce === -1) break;
              var pat = bodyT.slice(ap + 1, pce);
              var arr = pce + 1;
              while (arr < bodyT.length && bodyT[arr].v !== '=>') arr++;
              if (arr >= bodyT.length) break;
              // transcriber: next token group: `{...}` or a single-expr arm
              var tb = arr + 1;
              var tranToks;
              if (bodyT[tb].v === '{') {
                var tbe = matchTok(bodyT, tb, '{', '}');
                tranToks = tbe === -1 ? bodyT.slice(tb + 1) : bodyT.slice(tb + 1, tbe);
                ap = tbe + 1;
              } else {
                var tbe2 = -1;
                var td = 0;
                for (var tr = tb; tr < bodyT.length; tr++) {
                  var tv = bodyT[tr].v;
                  if (tv === '(' || tv === '[' || tv === '{') td++;
                  else if (tv === ')' || tv === ']' || tv === '}') { td--; if (td < 0) { tbe2 = tr; break; } }
                  else if (tv === ';' && td === 0) { tbe2 = tr; break; }
                }
                tranToks = tbe2 === -1 ? bodyT.slice(tb) : bodyT.slice(tb, tbe2);
                ap = tbe2 + 1;
              }
              // capture `$name:expr` params from pat
              var params = [];
              for (var pp = 0; pp < pat.length; pp++) {
                if (pat[pp].v === '$' && pp + 1 < pat.length && pat[pp + 1].t === T.IDENT) {
                  params.push(pat[pp + 1].v);
                  pp++;
                }
              }
              arms.push({ params: params, bodyToks: tranToks });
            }
            macros[mname] = arms;
          }
          mi = msc < toks.length ? Math.max(msc, mi + 1) : mi + 1;
        }
      }
    }

    var n = toks.length;
    // impl/trait ranges + their self type names
    var impls = [];
    for (var s = 0; s < n; s++) {
      if (toks[s].t === T.IDENT && (toks[s].v === 'impl' || toks[s].v === 'trait')) {
        var tname = null;
        for (var q0 = s + 1; q0 < Math.min(n, s + 8); q0++) {
          if (toks[q0].t === T.IDENT && !isKw(toks[q0].v)) {
            if (toks[q0].v[0] >= 'A' && toks[q0].v[0] <= 'Z') { tname = toks[q0].v; break; }
          }
          if (toks[q0].v === '{' || toks[q0].v === ';') break;
        }
        for (var q1 = s + 1; q1 < Math.min(n, s + 30); q1++) {
          if (toks[q1].v === '{') {
            var ee = matchTok(toks, q1, '{', '}');
            impls.push({ type: tname, start: q1, end: ee === -1 ? n : ee });
            break;
          }
          if (toks[q1].v === ';') break;
        }
      }
    }
    function implOf(idx) {
      for (var r = 0; r < impls.length; r++) {
        if (idx > impls[r].start && idx < impls[r].end) return impls[r].type;
      }
      return null;
    }
    // module ranges (`mod foo { ... }`) so `foo::bar()` resolves through qns.
    // (Merged multi-file crates keep their `mod foo { }` wrappers; see pm merge.)
    var modRanges = [];
    (function () {
      for (var ms = 0; ms < n; ms++) {
        if (toks[ms].t === T.IDENT && toks[ms].v === 'mod' && ms + 1 < n && toks[ms + 1].t === T.IDENT) {
          var mname0 = toks[ms + 1].v;
          for (var mq = ms + 2; mq < Math.min(n, ms + 8); mq++) {
            if (toks[mq].v === '{') {
              var me = matchTok(toks, mq, '{', '}');
              modRanges.push({ name: mname0, start: mq, end: me === -1 ? n : me });
              break;
            }
            if (toks[mq].v === ';') break;
          }
        }
      }
    })();
    function modOf(idx) {
      var best = null;
      for (var r2 = 0; r2 < modRanges.length; r2++) {
        if (idx > modRanges[r2].start && idx < modRanges[r2].end) {
          if (!best || modRanges[r2].start > best.start) best = modRanges[r2];
        }
      }
      return best ? best.name : null;
    }
    for (var i = 0; i < n; i++) {
      if (toks[i].t === T.IDENT && toks[i].v === 'fn' && i + 1 < n && toks[i + 1].t === T.IDENT) {
        var name = toks[i + 1].v;
        var k = i + 2;
        // skip generics
        if (toks[k] && toks[k].v === '<') {
          var gd = 0;
          while (k < n) {
            if (toks[k].v === '<') gd++;
            else if (toks[k].v === '>>') { gd -= 2; if (gd <= 0) { k++; break; } }
            else if (toks[k].v === '>') { gd--; if (gd === 0) { k++; break; } }
            k++;
          }
        }
        if (!toks[k] || toks[k].v !== '(') continue;
        var ce = matchTok(toks, k, '(', ')');
        if (ce === -1) continue;
        // params: ident names = ident followed by `:` (types after `:` are skipped)
        var params = [];
        var d = 0, cur = null;
        for (var p = k + 1; p < ce; p++) {
          var v = toks[p].v;
          if (v === '(' || v === '[' || v === '{') d++;
          else if (v === ')' || v === ']' || v === '}') d--;
          else if (d === 0 && toks[p].t === T.IDENT && v !== 'mut' && !isKw(v)) {
            var nx = toks[p + 1] ? toks[p + 1].v : '';
            if (nx === ':') params.push(v);
            if (v === 'self') params.unshift('self');
          }
        }
        var ak = ce + 1;
        if (toks[ak] && toks[ak].v === '->') {
          while (ak < n && toks[ak].v !== '{' && toks[ak].v !== ';') ak++;
        }
        if (toks[ak] && toks[ak].v === 'where') {
          while (ak < n && toks[ak].v !== '{' && toks[ak].v !== ';') ak++;
        }
        if (toks[ak] && toks[ak].v === '{') {
          var be = matchTok(toks, ak, '{', '}');
          var entry = {
            params: params, bodyToks: be === -1 ? [] : toks.slice(ak + 1, be),
            line: toks[i].line, col: toks[i].col, impl: false
          };
          var selfT = implOf(i);
          if (selfT) {
            entry.impl = true;
            entry.implT = selfT;
            if (qns && selfT) qns[selfT + '::' + name] = entry;
          }
          // module-qualified alias so `foo::bar()` resolves after mod merging
          var modT = modOf(i);
          if (modT && qns) qns[modT + '::' + name] = entry;
          fns[name] = entry;
        }
      }
    }
  }

  function matchTok(toks, from, open, close) {
    var d = 0;
    for (var i = from; i < toks.length; i++) {
      if (toks[i].v === open) d++;
      else if (toks[i].v === close) { d--; if (d === 0) return i; }
    }
    return -1;
  }

  function isKw(s) {
    return s === 'let' || s === 'mut' || s === 'fn' || s === 'if' || s === 'else' ||
      s === 'for' || s === 'while' || s === 'loop' || s === 'match' || s === 'return' ||
      s === 'break' || s === 'continue' || s === 'in' || s === 'struct' || s === 'enum' ||
      s === 'impl' || s === 'use' || s === 'pub' || s === 'true' || s === 'false' ||
      s === 'as' || s === 'ref' || s === 'where' || s === 'const' || s === 'static';
  }

  // ---- statement splitter (top-level `;` + blocks) ----
  function execBlock(toks, env, fns, stdout, stderr, st) {
    // publish sinks on `st` so nested evalExpr/callFn can print (no null sinks).
    if (stdout && typeof stdout.push === 'function') { st.stdout = stdout; st.stderr = stderr; }
    var i = 0, n = toks.length;
    while (i < n) {
      if (++st.steps > MAX_STEPS) throw { __frsPanic: true, msg: 'execution limit exceeded', line: 1, col: 1, limit: true };
      var tk = toks[i];
      if (!tk) break;

      // skip fn items (already collected)
      if (tk.t === T.IDENT && tk.v === 'fn') { i = skipItem(toks, i); continue; }
      if (tk.t === T.IDENT && (tk.v === 'struct' || tk.v === 'enum' || tk.v === 'trait' || tk.v === 'impl' || tk.v === 'mod' || tk.v === 'use')) { i = skipToSemiOrBlock(toks, i); continue; }
      if (tk.t === T.IDENT && tk.v === 'macro_rules') { i = skipToSemiOrBlock(toks, i); continue; }
      if (tk.t === T.IDENT && tk.v === 'type') { i = skipToSemiOrBlock(toks, i); continue; }
      // static/const: register name -> evaluated value
      if (tk.t === T.IDENT && (tk.v === 'static' || tk.v === 'const')) {
        var scEnd = -1, scDepth = 0;
        for (var sq = i + 1; sq < toks.length && sq < i + 200; sq++) {
          if (toks[sq].t === T.SYMBOL) {
            if (toks[sq].v === '(' || toks[sq].v === '[' || toks[sq].v === '{' || toks[sq].v === '<') scDepth++;
            else if (toks[sq].v === ')' || toks[sq].v === ']' || toks[sq].v === '}' || toks[sq].v === '>') scDepth--;
            else if (toks[sq].v === '>>') scDepth -= 2;
            else if (toks[sq].v === '<<') scDepth += 2;
            else if (toks[sq].v === ';' && scDepth === 0) { scEnd = sq; break; }
          }
        }
        var scStmt = scEnd === -1 ? toks.slice(i) : toks.slice(i, scEnd);
        // name = token after 'static'/'const' (skip `mut`/visibility already skipped since skipToSemiOrBlock used)
        var scName = toks[i + 1] && toks[i + 1].t === T.IDENT ? toks[i + 1].v : null;
        var eqI = -1;
        for (var q = 0; q < scStmt.length; q++) { if (scStmt[q].v === '=') { eqI = q; break; } }
        if (scName && eqI !== -1) {
          try { env[scName] = evalExpr(scStmt.slice(eqI + 1), env, fns, st); }
          catch (e) { env[scName] = { value: 0, type: 'unknown' }; }
          if (env[scName] && env[scName].value !== undefined) {} else env[scName] = { value: 0, type: 'unknown' };
        }
        i = scEnd === -1 ? i + 1 : scEnd + 1;
        continue;
      }
      if (tk.t === T.SYMBOL && (tk.v === '}' || tk.v === ';')) { i++; continue; }

      // let ...
      if (tk.t === T.IDENT && tk.v === 'let') {
        i = execLet(toks, i, env, fns, stdout, stderr, st);
        continue;
      }
      // if / for / while / loop / match / return / break / continue
      if (tk.t === T.IDENT && tk.v === 'if') { i = execIf(toks, i, env, fns, stdout, stderr, st); continue; }
      if (tk.t === T.IDENT && tk.v === 'for') { i = execFor(toks, i, env, fns, stdout, stderr, st); continue; }
      if (tk.t === T.IDENT && (tk.v === 'while' || tk.v === 'loop')) { i = execWhile(toks, i, env, fns, stdout, stderr, st); continue; }
      if (tk.t === T.IDENT && tk.v === 'match') { i = execMatch(toks, i, env, fns, stdout, stderr, st); continue; }
      if (tk.t === T.IDENT && tk.v === 'return') {
        var rv = evalStmtExpr(toks, i + 1, env, fns, st);
        throw { __frsReturn: true, value: rv.value };
      }
      if (tk.t === T.IDENT && tk.v === 'break') throw { __frsBreak: true };
      if (tk.t === T.IDENT && tk.v === 'continue') throw { __frsContinue: true };

      // expression statement: find `;` or block end at depth 0
      var stmt = sliceStmt(toks, i);
      execExprStmt(stmt.toks, env, fns, stdout, stderr, st, tk);
      i = stmt.next;
    }
  }

  function skipItem(toks, i) {
    var n = toks.length;
    var k = i + 1;
    while (k < n && toks[k].v !== '{' && toks[k].v !== ';') k++;
    if (k < n && toks[k].v === '{') {
      var e = matchTok(toks, k, '{', '}');
      return e === -1 ? n : e + 1;
    }
    return Math.min(n, k + 1);
  }

  function skipToSemiOrBlock(toks, i) {
    var n = toks.length, k = i;
    var d = 0;
    while (k < n) {
      var v = toks[k].v;
      if (v === '{') { var e = matchTok(toks, k, '{', '}'); return e === -1 ? n : e + 1; }
      if (v === ';') return k + 1;
      k++;
      if (k - i > 100) return k;
    }
    return n;
  }

  function sliceStmt(toks, i) {
    var n = toks.length, d = 0, k = i;
    while (k < n) {
      var v = toks[k].v;
      if (v === '(' || v === '[' || v === '{') d++;
      else if (v === ')' || v === ']' || v === '}') {
        if (d === 0) break;
        d--;
        // a block-tailed statement like `if..{}`/`{...}` ends without `;`
        if (d < 0) break;
      }
      else if (v === ';' && d === 0) return { toks: toks.slice(i, k), next: k + 1 };
      k++;
      if (k - i > 500) break;
    }
    return { toks: toks.slice(i, k), next: k };
  }

  // ---- let ----
  function execLet(toks, i, env, fns, stdout, stderr, st) {
    var n = toks.length, k = i + 1;
    if (toks[k] && toks[k].v === 'mut') k++;
    var patToks = null, name = (toks[k] && toks[k].t === T.IDENT) ? toks[k].v : '_';
    if (toks[k] && (toks[k].v === '(' || toks[k].v === '[')) {
      // pattern destructuring: `let (a, b) = ...` / `let [a, b] = ...`
      var close = toks[k].v === '(' ? ')' : ']';
      var pe = -1, pd = 0;
      for (var q0 = k; q0 < n; q0++) {
        if (toks[q0].v === toks[k].v) pd++;
        else if (toks[q0].v === close) { pd--; if (pd === 0) { pe = q0; break; } }
      }
      if (pe !== -1) { patToks = toks.slice(k + 1, pe); k = pe + 1; }
      name = '_';
    }
    // find `=` at depth 0
    var eq = -1, d = 0;
    for (var q = k; q < n; q++) {
      var v = toks[q].v;
      if (v === '(' || v === '[' || v === '{') d++;
      else if (v === ')' || v === ']' || v === '}') { if (d === 0) break; d--; }
      else if (v === ';' && d === 0) break;
      else if (v === '=' && d === 0 && toks[q].t === T.SYMBOL) { eq = q; break; }
      if (q - k > 60) break;
    }
    var end = sliceStmt(toks, i).next;
    var valToks = eq === -1 ? [] : toks.slice(eq + 1, end - 1 >= eq + 1 ? end - (toks[end - 1] && toks[end - 1].v === ';' ? 1 : 0) : end);
    // valToks may include trailing junk if sliceStmt stopped at `}` — trim:
    var val = { value: 0, type: 'i32' };
    if (valToks.length) {
      try { val = evalExpr(valToks, env, fns, st); }
      catch (e) { if (e && (e.__frsReturn || e.__frsBreak || e.__frsContinue || e.__frsPanic)) throw e; val = { value: 0, type: 'unknown' }; }
    }
    if (patToks) {
      // destructure: pattern idents get successive tuple/vec elements
      var items = (val.value && val.value.__rust === 'vec') ? val.value.items : [];
      if (!items.length && typeof val.value === 'object' && val.value && 'value' in Object(val.value)) items = [val.value.value];
      var pos = 0;
      for (var pi = 0; pi < patToks.length; pi++) {
        var tv2 = patToks[pi];
        if (tv2.t === T.IDENT && tv2.v !== 'mut' && !isKw(tv2.v) && tv2.v !== '_') {
          env[tv2.v] = pos < items.length ? { value: items[pos], type: 'unknown' } : { value: 0, type: 'unknown' };
          pos++;
        }
      }
      return end;
    }
    if (name !== '_') {
      env[name] = val;
      trackRefBind(env, name, valToks); // `let r = &x` aliases r -> x (else tombstone)
    }
    return end;
  }

  // ---- expression statement (assign / macro / call) ----
  function execExprStmt(stToks, env, fns, stdout, stderr, st, firstTk) {
    if (!stToks.length) return;
    // deref assignment: `*r = ...` / `*r += ...` writes through to the
    // borrow target (`r` aliases it via `let r = &mut x`)
    if (stToks[0].v === '*') {
      var dk = 0;
      while (dk < stToks.length && stToks[dk].v === '*') dk++;
      if (dk < stToks.length && stToks[dk].t === T.IDENT && !isKw(stToks[dk].v) &&
          dk + 1 < stToks.length &&
          (stToks[dk + 1].v === '=' || stToks[dk + 1].v === '+=' || stToks[dk + 1].v === '-=' ||
           stToks[dk + 1].v === '*=' || stToks[dk + 1].v === '/=' || stToks[dk + 1].v === '%=')) {
        var dTarget = resolveRef(env, stToks[dk].v);
        var dRhs = stToks.slice(dk + 2);
        if (stToks[dk + 1].v === '=') {
          assignVar(env, dTarget, evalExpr(dRhs, env, fns, st));
        } else {
          var dCur = lookupVar(env, dTarget);
          var dCurV = dCur ? dCur.value : 0;
          var dRhsV = evalExpr(dRhs, env, fns, st).value;
          var dOp = stToks[dk + 1].v[0];
          if (typeof dCurV === 'string' || typeof dRhsV === 'string') {
            if (dOp !== '+') { dCurV = num(dCurV); dRhsV = num(dRhsV); }
            else { assignVar(env, dTarget, { value: String(dCurV) + String(dRhsV), type: 'String' }); return; }
          }
          var dRes = dOp === '+' ? num(dCurV) + num(dRhsV) : dOp === '-' ? num(dCurV) - num(dRhsV)
            : dOp === '*' ? num(dCurV) * num(dRhsV) : dOp === '/' ? (num(dRhsV) === 0 ? num(dCurV) : num(dCurV) / num(dRhsV))
            : num(dCurV) % num(dRhsV);
          assignVar(env, dTarget, { value: dRes, type: 'i32' });
        }
        return;
      }
    }
    // assignment: IDENT = ...
    if (stToks.length >= 3 && stToks[0].t === T.IDENT && stToks[1].v === '=' && !isKw(stToks[0].v)) {
      var val = evalExpr(stToks.slice(2), env, fns, st);
      env[stToks[0].v] = val;
      trackRefBind(env, stToks[0].v, stToks.slice(2)); // reborrow or tombstone
      return;
    }
    if (stToks.length >= 3 && stToks[0].t === T.IDENT && (stToks[1].v === '+=' || stToks[1].v === '-=' || stToks[1].v === '*=' || stToks[1].v === '/=' || stToks[1].v === '%=')) {
      var cur = env[stToks[0].v] ? num(env[stToks[0].v].value) : 0;
      var rhs = num(evalExpr(stToks.slice(2), env, fns, st).value);
      var op = stToks[1].v[0];
      var r = op === '+' ? cur + rhs : op === '-' ? cur - rhs : op === '*' ? cur * rhs : op === '/' ? (rhs === 0 ? cur : cur / rhs) : cur % rhs;
      env[stToks[0].v] = { value: r, type: 'i32' };
      return;
    }
    // macro statement
    if (stToks[0].t === T.IDENT && stToks[1] && stToks[1].v === '!') {
      execMacro(stToks, env, fns, stdout, stderr, st, firstTk);
      return;
    }
    // bare call / expr — evaluate for side effects (function bodies run)
    try { evalExpr(stToks, env, fns, st); } catch (e) {
      if (e && (e.__frsReturn || e.__frsBreak || e.__frsContinue || e.__frsPanic)) throw e;
    }
  }

  function execMacro(stToks, env, fns, stdout, stderr, st, firstTk) {
    var name = stToks[0].v;
    // find open `(`, `[`, `{`
    var oi = 1;
    while (oi < stToks.length && stToks[oi].v !== '(' && stToks[oi].v !== '[' && stToks[oi].v !== '{') oi++;
    if (oi >= stToks.length) return;
    var open = stToks[oi].v;
    var close = open === '(' ? ')' : open === '[' ? ']' : '}';
    var e = matchTok(stToks, oi, open, close);
    var inner = e === -1 ? stToks.slice(oi + 1) : stToks.slice(oi + 1, e);
    // split top-level args
    var args = splitArgs(inner);
    if (name === 'println' || name === 'print' || name === 'eprintln' || name === 'eprint') {
      var s = formatMacro(args, env, fns, st);
      if (name[0] === 'e') stderr.push(s + (name === 'eprintln' ? '\n' : ''));
      else stdout.push(s + (name === 'println' ? '\n' : ''));
      return;
    }
    if (name === 'write' || name === 'writeln') {
      // writeln!(file, "fmt", args..) or write!(f, "fmt", args..) -> real fd / stdout
      var wTarget = null;
      try { wTarget = args.length ? evalExpr(args[0], env, fns, st).value : null; } catch (ez) { wTarget = null; }
      var wRest = args.slice(1);
      var wText = wRest.length ? formatMacro(wRest, env, fns, st) : '';
      if (name === 'writeln') wText += '\n';
      if (wTarget !== null && typeof wTarget === 'object' && wTarget.__rust === 'file' && FS_X) {
        try { FS_X.writeSync(wTarget._fd, wText); } catch (e6) { stderr.push('error writing file: ' + e6.message + '\n'); }
      } else if (wTarget !== null && typeof wTarget === 'object' && wTarget.__rust === 'stdout') {
        stdout.push(wText);
      } else if (wTarget !== null && typeof wTarget === 'object' && wTarget.__rust === 'stderr') {
        stderr.push(wText);
      } else {
        // default: treat like eprintln where unknown
        stderr.push.apply ? null : null;
        stdout.push(wText);
      }
      return;
    }
    if (name === 'panic') {
      var msg = args.length ? rustToString(evalExpr(args[0], env, fns, st).value) : 'explicit panic';
      // try format-style: panic!("msg {}", x)
      if (args.length >= 1 && args[0].length === 1 && (args[0][0].t === T.STRING || args[0][0].t === T.RAWSTR)) {
        msg = formatMacro(args, env, fns, st);
      }
      var tk = firstTk || stToks[0];
      throw { __frsPanic: true, msg: msg, line: tk.line, col: tk.col };
    }
    if (name === 'assert' || name === 'assert_eq' || name === 'assert_ne') {
      var ok = true;
      if (name === 'assert' && args.length) ok = truthy(evalExpr(args[0], env, fns, st).value);
      if ((name === 'assert_eq' || name === 'assert_ne') && args.length >= 2) {
        var a = rustToString(evalExpr(args[0], env, fns, st).value);
        var b = rustToString(evalExpr(args[1], env, fns, st).value);
        ok = name === 'assert_eq' ? a === b : a !== b;
      }
      if (!ok) {
        var tk2 = firstTk || stToks[0];
        throw { __frsPanic: true, msg: 'assertion failed', line: tk2.line, col: tk2.col };
      }
      return;
    }
    if (name === 'todo' || name === 'unimplemented' || name === 'unreachable') {
      var tk3 = firstTk || stToks[0];
      throw { __frsPanic: true, msg: name === 'todo' ? 'not yet implemented' : 'internal error: entered unreachable code', line: tk3.line, col: tk3.col };
    }
    // try user macro_rules expansion first
    if (st.macros && st.macros[name]) {
      var exp = expandMacro(name, inner, env, fns, st);
      if (exp) {
        try { evalExpr(exp, env, fns, st); } catch (e3) { if (e3 && e3.__frsPanic) throw e3; }
        try { execExprStmt(exp, env, fns, stdout, stderr, st, firstTk || stToks[0]); } catch (e4) { if (e4 && e4.__frsPanic) throw e4; }
        return;
      }
    }
    // unknown macros: evaluate args (side effects), ignore
    for (var a = 0; a < args.length; a++) {
      try { evalExpr(args[a], env, fns, st); } catch (e2) {
        if (e2 && (e2.__frsReturn || e2.__frsPanic || e2.__frsBreak || e2.__frsContinue)) throw e2;
      }
    }
  }

  function expandMacro(name, argToks, env, fns, st) {
    if (!st.macros || !st.macros[name]) return null;
    var arms = st.macros[name];
    var args = splitArgs(argToks).filter(function (a) { return a.length; });
    var chosen = null;
    for (var a = 0; a < arms.length; a++) {
      if (arms[a].params.length === args.length) { chosen = arms[a]; break; }
    }
    if (!chosen) chosen = arms[0];
    // splice: replace $name tokens with the bound raw arg tokens
    var map = {};
    for (var i = 0; i < chosen.params.length; i++) {
      map[chosen.params[i]] = args[i] || [];
    }
    var out = [];
    for (var b = 0; b < chosen.bodyToks.length; b++) {
      var bt = chosen.bodyToks[b];
      // `$` and the name are separate tokens in Rust lexers
      if (bt.v === '$' && b + 1 < chosen.bodyToks.length && chosen.bodyToks[b + 1].t === T.IDENT
          && map[chosen.bodyToks[b + 1].v] !== undefined) {
        var rep = map[chosen.bodyToks[b + 1].v];
        for (var r = 0; r < rep.length; r++) out.push(rep[r]);
        b++;
      } else if (bt.t === T.IDENT && bt.v[0] === '$' && map[bt.v.slice(1)] !== undefined) {
        var rep2 = map[bt.v.slice(1)];
        for (var r2 = 0; r2 < rep2.length; r2++) out.push(rep2[r2]);
      } else out.push(bt);
    }
    return out;
  }

  function evalExpr_inject(toks, env, fns, st) {
    if (toks && toks.length && toks[0] && toks[0].__tv) {
      var b = toks[0].__tv;
      var rt = toks.slice(1);
      if (!rt.length) return { value: b, type: 'unknown' };
      if (rt[0].v === '.') {
        env.__chainBase = { value: b, type: 'unknown' };
        return evalExpr([{ t: T.IDENT, v: '__chainBase', idx: 0, line: 1, col: 1 }].concat(rt), env, fns, st);
      }
      return { value: b, type: 'unknown' };
    }
    return evalExpr(toks, env, fns, st);
  }

  function finishMethodResult(v, rt, env, fns, st) {
    var val = v;
    var rest = rt;
    while (rest.length && rest[0].v === '?') {
      if (val !== null && typeof val === 'object' && val.__rust === 'result' && !val.ok) { throw { __frsTryErr: true, value: val.value }; }
      if (val !== null && typeof val === 'object' && val.__rust === 'option' && !val.some) { throw { __frsTryErr: true, value: undefined }; }
      if (val !== null && typeof val === 'object' && val.__rust === 'result' && val.ok) val = val.value;
      else if (val !== null && typeof val === 'object' && val.__rust === 'option' && val.some) val = val.value;
      rest = rest.slice(1);
    }
    if (rest.length && rest[0].v === '.') {
      env.__chainBase = { value: val, type: 'unknown' };
      var r2 = evalExpr([{ t: T.IDENT, v: '__chainBase', idx: 0, line: 1, col: 1 }].concat(rest), env, fns, st);
      return r2;
    }
    if (!rest.length) return { value: val, type: 'unknown' };
    return evalBinOp({ value: val, type: 'unknown' }, rest, env, fns, st);
  }

  function splitArgs(toks) {
    var out = [], d = 0, cur = [];
    for (var i = 0; i < toks.length; i++) {
      var v = toks[i].v;
      if (v === '(' || v === '[' || v === '{') { d++; cur.push(toks[i]); }
      else if (v === ')' || v === ']' || v === '}') { d--; cur.push(toks[i]); }
      else if (v === ',' && d === 0) { out.push(cur); cur = []; }
      else cur.push(toks[i]);
    }
    if (cur.length || out.length) out.push(cur);
    return out;
  }

  function unquote(t) {
    var s = t.v;
    if (t.t === T.RAWSTR) {
      var q = s.indexOf('"');
      var h = 0;
      for (var k = 1; k < q; k++) if (s[k] === '#') h++;
      return s.slice(q + 1, s.length - 1 - h);
    }
    // "..." with escapes
    var inner = s.slice(1, -1);
    return inner.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
      .replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\0/g, '\0');
  }

  // println!-style formatting: "{}" "{:?}" "{:.2}" "{x}" "{x:?}" + named args
  function formatMacro(args, env, fns, st) {
    if (!args.length) return '';
    var first = args[0];
    var fmt;
    if (first.length === 1 && (first[0].t === T.STRING || first[0].t === T.RAWSTR)) fmt = unquote(first[0]);
    else return rustToString(evalExpr(first, env, fns, st).value);
    // named args: `name = expr`
    var named = {};
    var positional = [];
    for (var i = 1; i < args.length; i++) {
      var a = args[i];
      if (a.length >= 3 && a[0].t === T.IDENT && a[1].v === '=') {
        named[a[0].v] = evalExpr(a.slice(2), env, fns, st).value;
      } else positional.push(evalExpr(a, env, fns, st).value);
    }
    var pi = 0;
    var out = '';
    for (var k = 0; k < fmt.length; k++) {
      var c = fmt[k];
      if (c === '{' && fmt[k + 1] === '{') { out += '{'; k++; continue; }
      if (c === '}' && fmt[k + 1] === '}') { out += '}'; k++; continue; }
      if (c === '{') {
        var e = fmt.indexOf('}', k);
        if (e === -1) { out += c; continue; }
        var inside = fmt.slice(k + 1, e);
        var val;
        if (inside === '' || inside[0] === ':' || (inside[0] >= '0' && inside[0] <= '9')) {
          // positional (+ optional width/precision — value rendered plainly)
          var idx = inside === '' || inside[0] === ':' ? pi++ : (function () { var n = parseInt(inside, 10); pi = Math.max(pi, n + 1); return n; })();
          val = idx < positional.length ? positional[idx] : '';
        } else {
          // named: name or name:spec
          var nm = inside.split(':')[0];
          if (nm in named) val = named[nm];
          else if (env[nm] !== undefined) val = env[nm].value;
          else val = '';
        }
        out += rustDisplay(val, inside);
        k = e;
        continue;
      }
      out += c;
    }
    return out;
  }

  function rustDisplay(val, spec) {
    if (val !== null && typeof val === 'object' && val.__rust === 'struct') {
      var ks = Object.keys(val.fields);
      return val.name + ' { ' + ks.map(function (k) { return k + ': ' + rustDebug(val.fields[k]); }).join(', ') + ' }';
    }
    if (val !== null && typeof val === 'object' && val.__rust === 'vec') {
      if ((spec || '').indexOf('?') !== -1 || (spec || '').indexOf('#') !== -1) {
        return '[' + val.items.map(function (x) { return rustDebug(x); }).join(', ') + ']';
      }
      return '[' + val.items.map(function (x) { return rustToString(x); }).join(', ') + ']';
    }
    if ((spec || '').indexOf('?') !== -1) return rustDebug(val);
    // float precision `{:.2}` (widths still render plainly)
    var pm = /\.(\d+)/.exec(spec || '');
    if (pm && typeof val === 'number' && isFinite(val)) return val.toFixed(parseInt(pm[1], 10));
    return rustToString(val);
  }

  function rustToString(v) {
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (v === null || v === undefined) return '';
    if (typeof v === 'object' && v.__rust === 'vec') return '[' + v.items.map(rustToString).join(', ') + ']';
    if (typeof v === 'object' && v.__rust === 'option') return v.some ? rustToString(v.value) : '';
    if (typeof v === 'object' && v.__rust === 'result') return rustToString(v.value);
    if (typeof v === 'object' && v.__rust === 'enum') return v.path;
    if (typeof v === 'object' && v.__rust === 'ctor') {
      return v.name + '(' + v.args.map(rustToString).join(', ') + ')';
    }
    if (typeof v === 'object' && v.__rust === 'struct') {
      var ks = Object.keys(v.fields);
      return v.name + ' { ' + ks.map(function (k) { return k + ': ' + rustToString(v.fields[k]); }).join(', ') + ' }';
    }
    if (typeof v === 'number') {
      if (!isFinite(v)) return String(v);
      // print ints without `.0`
      return String(v);
    }
    return String(v);
  }

  function rustDebug(v) {
    if (typeof v === 'string') return '"' + v.replace(/"/g, '\\"') + '"';
    if (v === true || v === false) return String(v);
    if (typeof v === 'object' && v && v.__rust === 'vec') {
      return '[' + v.items.map(rustDebug).join(', ') + ']';
    }
    if (typeof v === 'object' && v && v.__rust === 'option') {
      return v.some ? 'Some(' + rustDebug(v.value) + ')' : 'None';
    }
    if (typeof v === 'object' && v && v.__rust === 'result') {
      return (v.ok ? 'Ok(' : 'Err(') + rustDebug(v.value) + ')';
    }
    if (typeof v === 'object' && v && v.__rust === 'enum') return v.path;
    if (typeof v === 'object' && v && v.__rust === 'ctor') {
      return v.name + '(' + v.args.map(rustDebug).join(', ') + ')';
    }
    if (typeof v === 'number') return String(v);
    return rustToString(v);
  }

  function truthy(v) {
    if (v === false || v === 0 || v === '' || v === null || v === undefined) return false;
    if (typeof v === 'object' && v.__rust === 'option') return !!v.some;
    return true;
  }

  function num(v) {
    if (typeof v === 'number') return v;
    var n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }

  // ---- borrow/reference aliasing (`&x`, `&mut x`, `*r`) ----
  // References evaluate transparently, but `*r = v` / `*r` reads resolve
  // through per-scope alias cells (`__ref_<name>` -> target name) so that
  // mutation through `&mut` is observable, like real Rust. Only bare-ident
  // targets (`&x`, `&mut x`) create aliases; anything else stays transparent.
  var REF_PREFIX = '__ref_';
  function refTargetOf(exprToks) {
    if (!exprToks || !exprToks.length || exprToks[0].v !== '&') return null;
    var k = 1;
    if (exprToks[k] && exprToks[k].v === 'mut' && exprToks[k].t === T.IDENT) k++;
    if (k < exprToks.length && exprToks[k].t === T.IDENT && !isKw(exprToks[k].v) &&
        k === exprToks.length - 1) return exprToks[k].v;
    return null;
  }
  function findAlias(env, name) {
    // own-property only (null tombstone shadows outer scopes); null = no alias
    var key = REF_PREFIX + name, e = env;
    while (e && e !== Object.prototype) {
      if (Object.prototype.hasOwnProperty.call(e, key)) return e[key];
      e = Object.getPrototypeOf(e);
      if (e === null) break;
    }
    return null;
  }
  function resolveRef(env, name) {
    var seen = {}, cur = name, g = 0;
    while (g++ < 8) {
      var t = findAlias(env, cur);
      if (!t || seen[t]) break;
      seen[cur] = 1; cur = t;
    }
    return cur;
  }
  function lookupVar(env, name) {
    var e = env;
    while (e && e !== Object.prototype) {
      if (Object.prototype.hasOwnProperty.call(e, name)) return e[name];
      e = Object.getPrototypeOf(e);
      if (e === null) break;
    }
    return undefined;
  }
  function assignVar(env, name, val) {
    // write to the scope that owns the binding (outer `let` through `&mut`)
    var e = env;
    while (e && e !== Object.prototype) {
      if (Object.prototype.hasOwnProperty.call(e, name)) { e[name] = val; return; }
      e = Object.getPrototypeOf(e);
      if (e === null) break;
    }
    env[name] = val;
  }
  function trackRefBind(env, boundName, rhsToks) {
    if (boundName === '_' || !boundName) return;
    var tgt = refTargetOf(rhsToks);
    try {
      if (tgt) env[REF_PREFIX + boundName] = tgt;
      else env[REF_PREFIX + boundName] = null; // tombstone: shadows outer alias
    } catch (eT) {}
  }

  // ---- expression evaluator (literals, vars, arith, comparisons, calls, vec, format) ----
  function evalExpr(toks, env, fns, st) {
    if (!toks.length) return { value: 0, type: 'i32' };
    if (++st.steps > MAX_STEPS) throw { __frsPanic: true, msg: 'execution limit exceeded', line: 1, col: 1, limit: true };
    // trim trailing `,`/`;`
    while (toks.length && (toks[toks.length - 1].v === ',' || toks[toks.length - 1].v === ';')) toks = toks.slice(0, -1);
    if (!toks.length) return { value: 0, type: 'i32' };
    // try-operator `?`: split at the FIRST depth-0 `?` (it binds tighter than
    // method chains: `a()?.b()` == `(a()?) .b()`), unwrap-or-throw, and continue
    // with the remainder. `?` inside brackets belongs to that sub-expression
    // and is left for its own recursive evaluation.
    var qd = 0, qi = -1;
    for (var qk = 0; qk < toks.length; qk++) {
      var qqv = toks[qk].v;
      if (qqv === '(' || qqv === '[' || qqv === '{') qd++;
      else if (qqv === ')' || qqv === ']' || qqv === '}') qd--;
      else if (qqv === '?' && qd === 0) { qi = qk; break; }
    }
    if (qi !== -1) {
      var leftQ = evalExpr(toks.slice(0, qi), env, fns, st);
      var lv = leftQ.value;
      if (lv !== null && typeof lv === 'object' && lv.__rust === 'result' && !lv.ok) {
        throw { __frsTryErr: true, value: lv.value };
      }
      if (lv !== null && typeof lv === 'object' && lv.__rust === 'option' && !lv.some) {
        throw { __frsTryErr: true, value: undefined };
      }
      if (lv !== null && typeof lv === 'object' && lv.__rust === 'result' && lv.ok) lv = lv.value;
      else if (lv !== null && typeof lv === 'object' && lv.__rust === 'option' && lv.some) lv = lv.value;
      if (qi === toks.length - 1) return { value: lv, type: 'unknown' }; // trailing `?`
      env.__tryVal = { value: lv, type: 'unknown' };
      return evalExpr([{ t: T.IDENT, v: '__tryVal', idx: 0, line: toks[qi].line, col: toks[qi].col }].concat(toks.slice(qi + 1)), env, fns, st);
    }

    // block expr: { stmts } -> value of last expr (tail) or ()
    if (toks[0].v === '{' && matchTok(toks, 0, '{', '}') === toks.length - 1) {
      var inner = toks.slice(1, -1);
      // tail expression? split last stmt: if no trailing `;`, tail is value
      var hasSemi = inner.length && inner[inner.length - 1].v === ';';
      try {
        if (!hasSemi && inner.length) {
          // exec all but tail, eval tail
          var lastStart = findStmtStart(inner);
          var head = inner.slice(0, lastStart);
          var tail = inner.slice(lastStart);
          // head may end with `;` — exec it
          var childEnv = Object.create(env);
          // Note: `let` in block should not leak — use child scope, but outer
          // assignments still visible via prototype chain reads. Writes go to child.
          var O = st.stdout || { push: function () { } };
          var E = st.stderr || { push: function () { } };
          execBlock(head, childEnv, fns, O, E, st);
          // merge mutated outer vars? keep simple: copy back existing keys
          function mergeBack() {
            for (var kk in childEnv) { if (Object.prototype.hasOwnProperty.call(childEnv, kk)) env[kk] = childEnv[kk]; }
          }
          if (!tail.length) { mergeBack(); return { value: 0, type: '()' }; }
          // statement tails (let/loops/return/effect-macros) exec for effects, value ();
          // expression tails (incl. if/match) evaluate to a value.
          var tailEffect = tail.length >= 2 && tail[0].t === T.IDENT && tail[1].v === '!' &&
            tail[0].v !== 'format' && tail[0].v !== 'vec';
          if (tail[0].t === T.IDENT && (tail[0].v === 'let' || tail[0].v === 'for' || tail[0].v === 'while' || tail[0].v === 'loop' || tail[0].v === 'return' || tail[0].v === 'break' || tail[0].v === 'continue') || tailEffect) {
            execBlock(tail, childEnv, fns, O, E, st);
            mergeBack();
            return { value: 0, type: '()' };
          }
          var tv2 = evalExpr(tail, childEnv, fns, st);
          mergeBack();
          return tv2;
        }
        var O2 = st.stdout || { push: function () { } };
        var E2 = st.stderr || { push: function () { } };
        execBlock(inner, env, fns, O2, E2, st);
        return { value: 0, type: '()' };
      } catch (e) {
        if (e && e.__frsReturn) return { value: e.value ? e.value.value : 0, type: 'i32' };
        throw e;
      }
    }

    // if expr as value
    if (toks[0].t === T.IDENT && toks[0].v === 'if') {
      return { value: evalIfExpr(toks, env, fns, st), type: 'unknown' };
    }
    // match expr as value
    if (toks[0].t === T.IDENT && toks[0].v === 'match') {
      return { value: evalMatchExpr(toks, env, fns, st), type: 'unknown' };
    }
    // closure literal: |x, y| expr  /  |x: i32| expr  /  || expr  /  move |x| expr
    var cStart = 0;
    if (toks[0].v === 'move' && toks[1] && toks[1].v === '|' && toks[1].t === T.SYMBOL) cStart = 1;
    if (toks[0].v === '||' || (toks[0].v === 'move' && toks[1] && toks[1].v === '||')) {
      var b0 = toks[0].v === '||' ? 1 : 2;
      return { value: { __rust: 'closure', params: [], body: toks.slice(b0) }, type: 'closure' };
    }
    if (toks[cStart].v === '|' && toks[cStart].t === T.SYMBOL) {
      var cparams = [], cend = -1;
      for (var ck2 = cStart + 1; ck2 < Math.min(toks.length, cStart + 15); ck2++) {
        var cw2 = toks[ck2];
        if (cw2.t === T.SYMBOL && cw2.v === '|') { cend = ck2; break; }
        if (cw2.t === T.IDENT && !isKw(cw2.v) && cw2.v !== 'mut') {
          var cnx = toks[ck2 + 1];
          // param iff followed by `:` `,` or (`|`-close right after `|`/`,`)
          if (!cnx) break;
          if (cnx.v === ':' || cnx.v === ',') cparams.push(cw2.v);
          else if (cnx.v === '|' && (ck2 === cStart + 1 || (toks[ck2 - 1] && (toks[ck2 - 1].v === '|' || toks[ck2 - 1].v === ',')))) cparams.push(cw2.v);
        }
      }
      if (cend !== -1) {
        return { value: { __rust: 'closure', params: cparams, body: toks.slice(cend + 1) }, type: 'closure' };
      }
      return { value: 0, type: 'unknown' };
    }
    // user macro_rules expansion (value position)
    if (st.macros && toks.length >= 3 && toks[0].t === T.IDENT && toks[1].v === '!' && st.macros[toks[0].v]) {
      var mgre = expandMacro(toks[0].v, toks.slice(3, matchTok(toks, 2, toks[2].v, toks[2].v === '(' ? ')' : toks[2].v === '[' ? ']' : '}') === -1 ? toks.length : matchTok(toks, 2, toks[2].v, toks[2].v === '(' ? ')' : toks[2].v === '[' ? ']' : '}')), env, fns, st);
      if (mgre) return evalExpr(mgre, env, fns, st);
    }
    // cfg!(...) as value: evaluated for this host (linux/mac/windows via
    // Node; unknown hosts stay lenient/true), exactly like rustc.
    if (toks.length >= 3 && toks[0].t === T.IDENT && toks[0].v === 'cfg' && toks[1].v === '!') {
      var oi3 = 2;
      var ce3 = matchTok(toks, oi3, toks[oi3].v, toks[oi3].v === '(' ? ')' : toks[oi3].v === '[' ? ']' : '}');
      var pred3 = toks.slice(oi3 + 1, ce3 === -1 ? toks.length : ce3);
      return { value: evalCfgPredI(pred3, hostOsInfo()), type: 'bool' };
    }
    // format!(...) as value
    if (toks.length >= 3 && toks[0].t === T.IDENT && toks[0].v === 'format' && toks[1].v === '!') {
      var oi = 2;
      var inner2 = toks.slice(oi + 1, matchTok(toks, oi, toks[oi].v, toks[oi].v === '(' ? ')' : toks[oi].v === '[' ? ']' : '}') === -1 ? toks.length : matchTok(toks, oi, toks[oi].v, toks[oi].v === '(' ? ')' : toks[oi].v === '[' ? ']' : '}'));
      var args = splitArgs(inner2);
      return { value: formatMacro(args, env, fns, st), type: 'String' };
    }
    // vec![...] literal
    if (toks.length >= 3 && toks[0].t === T.IDENT && toks[0].v === 'vec' && toks[1].v === '!' && toks[2].v === '[') {
      var ve = matchTok(toks, 2, '[', ']');
      var vinner = ve === -1 ? toks.slice(3) : toks.slice(3, ve);
      // vec![x; n] repeat form
      var semi = topIndex(vinner, ';');
      if (semi !== -1) {
        var xv = evalExpr(vinner.slice(0, semi), env, fns, st).value;
        var nv = Math.min(MAX_LOOP, Math.max(0, Math.floor(num(evalExpr(vinner.slice(semi + 1), env, fns, st).value))));
        var arr = [];
        for (var vi = 0; vi < nv; vi++) arr.push(xv);
        return { value: { __rust: 'vec', items: arr }, type: 'Vec<_>' };
      }
      var parts = splitArgs(vinner);
      var items = [];
      for (var pi2 = 0; pi2 < parts.length; pi2++) {
        if (!parts[pi2].length) continue;
        items.push(evalExpr(parts[pi2], env, fns, st).value);
      }
      return { value: { __rust: 'vec', items: items }, type: 'Vec<_>' };
    }
    // array literal [...]
    if (toks[0].v === '[' && matchTok(toks, 0, '[', ']') === toks.length - 1) {
      var ainner = toks.slice(1, -1);
      var semiA = topIndex(ainner, ';');
      if (semiA !== -1) {
        // repeat form `[x; n]` (splitArgs only splits on `,`, so split on `;` here)
        var repv = Math.min(MAX_LOOP, Math.max(0, Math.floor(num(evalExpr(ainner.slice(semiA + 1), env, fns, st).value))));
        var repb = evalExpr(ainner.slice(0, semiA), env, fns, st).value;
        var aitems = [];
        for (var ai2 = 0; ai2 < repv; ai2++) aitems.push(repb);
        return { value: { __rust: 'vec', items: aitems }, type: 'Vec<_>' };
      }
      var aparts = splitArgs(ainner);
      var aitems2 = [];
      for (var ai = 0; ai < aparts.length; ai++) {
        if (!aparts[ai].length) continue;
        aitems2.push(evalExpr(aparts[ai], env, fns, st).value);
      }
      return { value: { __rust: 'vec', items: aitems2 }, type: 'Vec<_>' };
    }
    // struct literal: Name { x: 1, y } / Name { x: 1, ..base } -> field map
    if (toks.length >= 3 && toks[0].t === T.IDENT && toks[0].v[0] >= 'A' && toks[0].v[0] <= 'Z' &&
        toks[1].v === '{') {
      var se = matchTok(toks, 1, '{', '}');
      if (se !== -1) {
        var sfields = {};
        var fparts = splitArgs(toks.slice(2, se));
        for (var fp = 0; fp < fparts.length; fp++) {
          var fa = fparts[fp];
          if (!fa.length) continue;
          if (fa.length >= 3 && fa[0].t === T.IDENT && fa[1].v === ':') {
            sfields[fa[0].v] = evalExpr(fa.slice(2), env, fns, st).value;
          } else if (fa.length === 1 && fa[0].t === T.IDENT && fa[0].v !== '_') {
            var fv3 = env[fa[0].v]; // shorthand `Point { x }`
            sfields[fa[0].v] = fv3 !== undefined ? fv3.value : 0;
          }
          // `..base` spread ignored (fake)
        }
        var sv = { __rust: 'struct', name: toks[0].v, fields: sfields };
        var srest = toks.slice(se + 1);
        if (!srest.length) return { value: sv, type: toks[0].v };
        return finishMethodResult(sv, srest, env, fns, st);
      }
    }
    // tuple-struct / enum-ctor call: Some(x), Ok(x), Err(e), Point(x, y)
    if (toks.length >= 2 && toks[0].t === T.IDENT && toks[1].v === '(' &&
        toks[0].v[0] >= 'A' && toks[0].v[0] <= 'Z' && !isKw(toks[0].v)) {
      var tce = matchTok(toks, 1, '(', ')');
      var targs = splitArgs(toks.slice(2, tce === -1 ? toks.length : tce))
        .filter(function (a) { return a.length; })
        .map(function (a) { return evalExpr(a, env, fns, st).value; });
      var tval;
      if (toks[0].v === 'Some') tval = { __rust: 'option', some: true, value: targs.length ? targs[0] : 0 };
      else if (toks[0].v === 'Ok') tval = { __rust: 'result', ok: true, value: targs.length ? targs[0] : 0 };
      else if (toks[0].v === 'Err') tval = { __rust: 'result', ok: false, value: targs.length ? targs[0] : 0 };
      else tval = { __rust: 'ctor', name: toks[0].v, args: targs };
      if (tce !== -1 && tce < toks.length - 1) {
        return finishMethodResult(tval, toks.slice(tce + 1), env, fns, st);
      }
      return { value: tval, type: 'unknown' };
    }
    // slice / index: expr[..b] / expr[a..b] / expr[i] / expr[a..=b]
    var brC = -1;
    for (var sp0 = 0; sp0 < toks.length; sp0++) {
      if (toks[sp0].v === '[' && sp0 > 0) { brC = sp0; break; }
    }
    if (brC !== -1 && toks.length && toks[toks.length - 1].v === ']') {
      var sBaseToks = toks.slice(0, brC);
      var sBaseVal = evalExpr(sBaseToks, env, fns, st).value;
      var sIn = toks.slice(brC + 1, toks.length - 1);
      var sidx = -1, sidxIncl = false;
      for (var jj = 0; jj < sIn.length; jj++) {
        if (sIn[jj].v === '..') { sidx = jj; break; }
        if (sIn[jj].v === '..=') { sidx = jj; sidxIncl = true; break; }
      }
      var sItems = (sBaseVal !== null && typeof sBaseVal === 'object' && sBaseVal.__rust === 'vec') ? sBaseVal.items : (typeof sBaseVal === 'string' ? sBaseVal.split('') : []);
      var slo = 0, shi = sItems.length, sincl = sidxIncl;
      if (sidx === -1) {
        var sv = Math.floor(num(evalExpr(sIn, env, fns, st).value));
        return { value: sv >= 0 && sv < sItems.length ? sItems[sv] : 0, type: 'unknown' };
      }
      if (sidx > 0) slo = Math.floor(num(evalExpr(sIn.slice(0, sidx), env, fns, st).value));
      var srhs = sIn.slice(sidx + 1);
      if (srhs.length && srhs[0].v === '=') { sincl = true; srhs = srhs.slice(1); }
      if (srhs.length) shi = Math.floor(num(evalExpr(srhs, env, fns, st).value)) + (sincl ? 1 : 0);
      return { value: { __rust: 'vec', items: sItems.slice(slo, shi) }, type: '&[_]' };
    }

    // function call f(...)
    if (toks.length >= 2 && toks[0].t === T.IDENT && toks[1].v === '(' && !isKw(toks[0].v)) {
      var ce = matchTok(toks, 1, '(', ')');
      if (ce === toks.length - 1 || (ce !== -1 && ce < toks.length - 1 && isBinOp(toks[ce + 1]))) {
        var fnv = callFn(toks[0].v, toks.slice(2, ce === -1 ? toks.length : ce), env, fns, st, toks[0]);
        // trailing binop? `f() + 1`
        if (ce !== -1 && ce < toks.length - 1) {
          return evalBinOp(fnv, toks.slice(ce + 1), env, fns, st);
        }
        return fnv;
      }
    }
    // path call: Type::method(args) / a::b::f(args)
    if (toks.length >= 5 && toks[0].t === T.IDENT && !isKw(toks[0].v)) {
      var pd = 0, po = -1;
      for (var pi3 = 0; pi3 < toks.length; pi3++) {
        var pv3 = toks[pi3].v;
        if (pv3 === '(' || pv3 === '[' || pv3 === '{') {
          if (pv3 === '(' && pd === 0 && pi3 >= 3 &&
              toks[pi3 - 1].t === T.IDENT && toks[pi3 - 2].v === '::' &&
              toks[pi3 - 3].t === T.IDENT) { po = pi3; break; }
          pd++;
        }
        else if (pv3 === ')' || pv3 === ']' || pv3 === '}') pd--;
      }
      if (po !== -1) {
        var mname2 = toks[po - 1].v, tname2 = toks[po - 3].v;
        var ppe = matchTok(toks, po, '(', ')');
        var pargs = toks.slice(po + 1, ppe === -1 ? toks.length : ppe);
        var pvv = callPath(tname2, mname2, pargs, env, fns, st.qns || {}, st, toks[po - 1]);
        if (ppe !== -1 && ppe < toks.length - 1) {
          return finishMethodResult(pvv.value, toks.slice(ppe + 1), env, fns, st);
        }
        return pvv;
      }
    }
    // path value (no call): Dir::North / std::u8::MAX -> symbolic enum value.
    // `std::env::consts::{OS,FAMILY,ARCH,...}` resolve to this host instead.
    if (toks.length >= 3 && isPathValue(toks)) {
      if (toks.length >= 5 && toks[toks.length - 3].v === 'consts') {
        var hcv = hostConstValue(toks[toks.length - 1].v);
        if (hcv !== null) return { value: hcv, type: '&str' };
      }
      return { value: { __rust: 'enum', path: toks.map(function (t) { return t.v; }).join('') }, type: 'unknown' };
    }
    // method call: expr.method(args)
    var dotCall = findMethodCall(toks);
    if (dotCall) {
      var base = evalExpr(toks.slice(0, dotCall.dot), env, fns, st).value;
      var mname = toks[dotCall.dot + 1].v;
      var margs = toks.slice(dotCall.open + 1, dotCall.close);
      var margVals = splitArgs(margs).filter(function (a) { return a.length; }).map(function (a) { return evalExpr(a, env, fns, st).value; });
      // atomic-ish ops on simple env vars: fetch_add/fetch_sub/store/load
      if (mname === 'fetch_add' || mname === 'fetch_sub' || mname === 'store' || mname === 'swap') {
        var bv = toks.slice(0, dotCall.dot);
        if (bv.length === 1 && bv[0].t === T.IDENT && env[bv[0].v] !== undefined) {
          // find the scope that actually owns the variable (proto chain walk)
          var owner = env;
          while (owner && !Object.prototype.hasOwnProperty.call(owner, bv[0].v)) owner = Object.getPrototypeOf(owner);
          if (!owner) owner = env;
          var old = num(owner[bv[0].v].value);
          var arg0 = margVals.length ? num(margVals[0]) : 0;
          owner[bv[0].v] = { value: mname === 'store' || mname === 'swap' ? arg0 : (mname === 'fetch_add' ? old + arg0 : old - arg0), type: 'i32' };
          var retAtomic = (mname === 'store') ? undefined : old;
          if (dotCall.close < toks.length - 1) return finishMethodResult(retAtomic, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: retAtomic, type: 'unknown' };
        }
      }
      // user-defined struct method (from impl blocks): `x.foo()`
      var bval = evalExpr(toks.slice(0, dotCall.dot), env, fns, st).value;
      // Lazy init: `X.get_or_init(|| expr)` -> eval the closure
      if (mname === 'get_or_init' || mname === 'get_or_try_init') {
        if (margVals.length && margVals[0] && margVals[0].__rust === 'closure') {
          var gv = evalClosure(margVals[0], [], env, fns, st).value;
          if (dotCall.close < toks.length - 1) return finishMethodResult(gv, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: gv, type: 'unknown' };
        }
        return { value: 0, type: 'unknown' };
      }
      // OpenOptions chain (std + tokio::fs share the `OpenOptions::new()` shape)
      if (base && typeof base === 'object' && base.__rust === 'openoptions' && FS_X) {
        var o_append = base._append === true;
        if (mname === 'append') { base._append = !!margVals[0]; if (dotCall.close < toks.length - 1) return finishMethodResult(base, toks.slice(dotCall.close + 1), env, fns, st); return { value: base, type: 'OpenOptions' }; }
        if (mname === 'truncate') { base._truncate = !!margVals[0]; if (dotCall.close < toks.length - 1) return finishMethodResult(base, toks.slice(dotCall.close + 1), env, fns, st); return { value: base, type: 'OpenOptions' }; }
        if (mname === 'create') { base._create = !!margVals[0]; if (dotCall.close < toks.length - 1) return finishMethodResult(base, toks.slice(dotCall.close + 1), env, fns, st); return { value: base, type: 'OpenOptions' }; }
        if (mname === 'create_new') { base._createNew = !!margVals[0]; if (dotCall.close < toks.length - 1) return finishMethodResult(base, toks.slice(dotCall.close + 1), env, fns, st); return { value: base, type: 'OpenOptions' }; }
        if (mname === 'write') { base._write = !!margVals[0]; if (dotCall.close < toks.length - 1) return finishMethodResult(base, toks.slice(dotCall.close + 1), env, fns, st); return { value: base, type: 'OpenOptions' }; }
        if (mname === 'read') { base._read = !!margVals[0]; if (dotCall.close < toks.length - 1) return finishMethodResult(base, toks.slice(dotCall.close + 1), env, fns, st); return { value: base, type: 'OpenOptions' }; }
        if (mname === 'open') {
          var o_path = (splitArgs(margs).filter(function (a) { return a.length; })[0] || []);
          var o_pv = o_path.length ? evalExpr(o_path, env, fns, st).value : '';
          var o_name = String(o_pv);
          var oRes;
          try {
            var o_exists = false;
            try { FS_X.accessSync(o_name); o_exists = true; } catch (eA) { o_exists = false; }
            if (base._createNew && o_exists) throw new Error('File exists (os error 17)');
            if ((base._create || base._createNew || base._append) && !o_exists) FS_X.writeFileSync(o_name, '');
            var o_flags = base._append ? 'a' : (base._truncate ? 'w' : (base._write ? (o_exists ? 'r+' : 'w') : 'r'));
            var o_fd = FS_X.openSync(o_name, o_flags);
            openFds.push(o_fd);
            oRes = { __rust: 'result', ok: true, value: { __rust: 'file', _fd: o_fd, path: o_name } };
          } catch (eO) {
            oRes = { __rust: 'result', ok: false, value: String(eO.message || eO) };
          }
          if (dotCall.close < toks.length - 1) return finishMethodResult(oRes, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: oRes, type: 'Result' };
        }
      }
      // ---- actix-web HttpServer builder chain: .bind(addr)? .workers(n) .run().await ----
      if (base && typeof base === 'object' && base.__rust === 'httpserver') {
        if (mname === 'bind') {
          var bnd = parseBindAddr(margs, env, fns, st);
          var nb = { __rust: 'httpserver', _factory: base._factory, _host: bnd.host, _port: bnd.port };
          var nbRes = bnd.ok ? { __rust: 'result', ok: true, value: nb }
                             : { __rust: 'result', ok: false, value: bnd.error };
          if (dotCall.close < toks.length - 1) return finishMethodResult(nbRes, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: nbRes, type: 'Result<HttpServer>' };
        }
        if (mname === 'workers' || mname === 'worker' || mname === 'shutdown_timeout' || mname === 'disable_signals' || mname === 'keep_alive') {
          if (dotCall.close < toks.length - 1) return finishMethodResult(base, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: base, type: 'HttpServer' };
        }
        if (mname === 'run') {
          var routes = (st && st.routes) || [];
          var stOut = (st && st.stdout) || { push: function () {} };
          var stErr = (st && st.stderr) || { push: function () {} };
          var runOut = startHttpServer(base, routes, env, fns, stOut, stErr, st);
          var runRes = runOut.ok ? { __rust: 'result', ok: true, value: 0 }
                                 : { __rust: 'result', ok: false, value: runOut.error || 'bind failed' };
          if (dotCall.close < toks.length - 1) return finishMethodResult(runRes, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: runRes, type: 'Result' };
        }
      }
      // ---- actix-web HttpResponse builder: .body(x) .json(x) .finish() .status(n) ----
      if (base && typeof base === 'object' && base.__rust === 'httpresponse') {
        if (mname === 'body') {
          base.body = httpBodyString(margVals.length ? margVals[0] : '');
          if (dotCall.close < toks.length - 1) return finishMethodResult(base, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: base, type: 'HttpResponse' };
        }
        if (mname === 'json') {
          base.body = rustToJson(margVals.length ? margVals[0] : 0);
          base.ctype = 'application/json';
          if (dotCall.close < toks.length - 1) return finishMethodResult(base, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: base, type: 'HttpResponse' };
        }
        if (mname === 'finish' || mname === 'build') {
          base.body = '';
          if (dotCall.close < toks.length - 1) return finishMethodResult(base, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: base, type: 'HttpResponse' };
        }
        if (mname === 'status') {
          var sc0 = margVals.length ? margVals[0] : 0;
          var scn = (typeof sc0 === 'number') ? sc0 : parseInt(rustToString(sc0), 10);
          if (isFinite(scn) && scn >= 100 && scn <= 599) base.status = scn;
          if (dotCall.close < toks.length - 1) return finishMethodResult(base, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: base, type: 'HttpResponse' };
        }
        if (mname === 'content_type' || mname === 'append_header' || mname === 'insert_header') {
          if (mname === 'content_type' && margVals.length) base.ctype = rustToString(margVals[0]);
          if (dotCall.close < toks.length - 1) return finishMethodResult(base, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: base, type: 'HttpResponse' };
        }
      }
      // file/tcpstream read/write_all
      if (mname === 'write_all' || mname === 'write') {
        if (base && typeof base === 'object' && (base.__rust === 'file' || base.__rust === 'tcpstream')) {
          var w_margs = splitArgs(margs).filter(function (a) { return a.length; })[0] || [];
          var w_v = w_margs.length ? evalExpr(w_margs, env, fns, st).value : '';
          var w_bytes;
          if (w_v !== null && typeof w_v === 'object' && w_v.__rust === 'bytes') w_bytes = w_v.raw;
          else if (w_v !== null && typeof w_v === 'object' && w_v.__rust === 'vec') w_bytes = Buffer.from(w_v.items.map(function (x) { return x | 0; }));
          else w_bytes = String(w_v);
          try {
            if (base.__rust === 'file' && FS_X) FS_X.writeSync(base._fd, w_bytes);
            else if (base.__rust === 'tcpstream' && typeof base._sock.write === 'function') base._sock.write(w_bytes);
          } catch (eW) { return { value: { __rust: 'result', ok: false, value: String(eW.message || eW) }, type: 'Result' }; }
          return { value: { __rust: 'result', ok: true, value: 0 }, type: 'Result' };
        }
      }
      if (mname === 'read') {
        if (base && typeof base === 'object' && (base.__rust === 'file' || base.__rust === 'tcpstream')) {
          var rda = splitArgs(margs).filter(function (a) { return a.length; })[0] || [];
          var rn = null;
          for (var qx2 = 0; qx2 < rda.length; qx2++) { if (rda[qx2].t === T.IDENT && rda[qx2].v !== 'mut' && rda[qx2].v !== 'ref') { rn = rda[qx2].v; break; } }
          var rbuf = rn ? ((env[rn] && env[rn].value && env[rn].value.__rust === 'vec') ? env[rn].value : null) : null;
          var rbufitems = rbuf && rbuf.items ? rbuf.items : [];
          var r_data = null;
          if (base.__rust === 'file' && FS_X) {
            try { r_data = FS_X.readSync(base._fd, Buffer.alloc(rbufitems.length || 1024), 0, rbufitems.length || 1024, null); } catch (eR) { r_data = null; }
            if (r_data && typeof r_data.bytesRead === 'number') {
              var rbr = Buffer.alloc(r_data.bytesRead);
              (r_data.buffer || r_data).copy ? r_data.buffer.copy(rbr, 0, 0, r_data.bytesRead) : Buffer.from(r_data).copy(rbr, 0, 0, r_data.bytesRead);
              r_data = rbr;
            }
          } else if (base.__rust === 'tcpstream') {
            r_data = (base._chunk && base._chunk.length) ? base._chunk : Buffer.alloc(0);
          }
          var nRead = r_data && r_data.length ? Math.min(r_data.length, rbufitems.length || r_data.length) : 0;
          if (rbuf && rbuf.items) {
            for (var ri = 0; ri < nRead; ri++) { var bv2 = r_data[ri]; rbuf.items[ri] = Array.isArray(bv2) ? bv2[0] : (bv2 | 0); }
          }
          return { value: { __rust: 'result', ok: true, value: nRead }, type: 'Result' };
        }
      }
      // std::io real stdin buffer + buffer-arg write
      if (mname === 'read_line') {
        var btoklist = splitArgs(margs).filter(function (a) { return a.length; });
        var rlArgs = (btoklist.length && btoklist[0]) || [];
        var rlName = null;
        for (var qx = 0; qx < rlArgs.length; qx++) {
          if (rlArgs[qx].t === T.IDENT && rlArgs[qx].v !== 'mut' && rlArgs[qx].v !== 'ref' && rlArgs[qx].v !== '&') { rlName = rlArgs[qx].v; break; }
        }
        // On a terminal, show pending prompts BEFORE blocking for input.
        flushProgramStdout(st);
        var rline = readStdinLine();
        if (rlName) {
          var own = env;
          while (own && !Object.prototype.hasOwnProperty.call(own, rlName)) own = Object.getPrototypeOf(own);
          if (own) own[rlName] = { value: rline, type: 'String' };
        }
        if (dotCall.close < toks.length - 1) { var rb = rline.length; return finishMethodResult({ __rust: 'result', ok: true, value: rb }, toks.slice(dotCall.close + 1), env, fns, st); }
        return { value: { __rust: 'result', ok: true, value: rline.length }, type: 'unknown' };
      }
      if ((mname === 'accept' || mname === 'incoming') && base && typeof base === 'object' && base.__rust === 'tcplistener') {
        if (mname === 'accept') return { value: { __rust: 'result', ok: false, value: 'would block' }, type: 'Result<(TcpStream, SocketAddr)>' };
        return { value: { __rust: 'tcpincoming', _srv: base._srv }, type: 'Incoming<_>' };
      }
      if (mname === 'local_addr') return { value: { __rust: 'result', ok: true, value: '0.0.0.0:0' }, type: 'Result' };
      if (mname === 'lines' && base && typeof base === 'object' && base.__rust === 'bufreader' && FS_X) {
        var ltext = '';
        try { ltext = FS_X.readFileSync(base._path || '', 'utf8'); } catch (e5) { ltext = ''; }
        var lparts = String(ltext).split('\n').filter(function (x, i, a) { return i < a.length - 1 || x !== ''; });
        var litems = lparts.map(function (l) { return { __rust: 'result', ok: true, value: l }; });
        var lvec = { __rust: 'vec', items: litems };
        if (dotCall.close < toks.length - 1) return finishMethodResult(lvec, toks.slice(dotCall.close + 1), env, fns, st);
        return { value: lvec, type: 'Vec<_>' };
      }
      // Cell<T>-style / struct field get-set: `self.x.set(v)` / `self.x.get()`
      var btoks = toks.slice(0, dotCall.dot);
      if ((mname === 'set' || mname === 'get') && btoks.length === 3 && btoks[1].v === '.' && btoks[0].t === T.IDENT) {
        var objName = btoks[0].v, fName = btoks[2].v;
        if (env[objName] !== undefined) {
          var ov = env[objName].value;
          if (ov && ov.__rust === 'struct' && ov.fields) {
            if (mname === 'set') { ov.fields[fName] = margVals.length ? margVals[0] : 0; return { value: undefined, type: '()' }; }
            return { value: ov.fields[fName] !== undefined ? ov.fields[fName] : 0, type: 'unknown' };
          }
        }
      }
      // vec/iterator chains: `.iter().map(f).filter(g).collect()` / `.for_each`
      // (items are shared refs, so `iter_mut().find(..)` + field writes persist)
      if (base && typeof base === 'object' && base.__rust === 'vec' &&
          (mname === 'iter' || mname === 'iter_mut' || mname === 'into_iter' || mname === 'values' || mname === 'map' || mname === 'filter' || mname === 'find' || mname === 'retain' || mname === 'collect' || mname === 'for_each' || mname === 'cloned' || mname === 'rev')) {
        if (mname === 'iter' || mname === 'iter_mut' || mname === 'into_iter' || mname === 'values' || mname === 'clone' || mname === 'cloned' || mname === 'rev') {
          var rv2 = mname === 'rev' ? { __rust: 'vec', items: base.items.slice().reverse() } : base;
          if (dotCall.close < toks.length - 1) return finishMethodResult(rv2, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: rv2, type: 'Vec<_>' };
        }
        if (mname === 'collect') {
          if (dotCall.close < toks.length - 1) return finishMethodResult(base, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: base, type: 'Vec<_>' };
        }
        // map / filter / find / retain / for_each take a closure arg
        var cvt = (margVals.length && margVals[0] && margVals[0].__rust === 'closure') ? margVals[0] : null;
        if (!cvt) {
          if (mname === 'for_each' && margVals.length === 0) { /* nothing */ }
          if (dotCall.close < toks.length - 1) return finishMethodResult(base, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: base, type: 'unknown' };
        }
        if (mname === 'find') {
          var found = null, hasFound = false;
          for (var fi9 = 0; fi9 < base.items.length && fi9 < MAX_LOOP; fi9++) {
            var rf = evalClosureValues(cvt, [{ value: base.items[fi9], type: 'unknown' }], env, fns, st);
            if (truthy(rf.value)) { found = base.items[fi9]; hasFound = true; break; }
          }
          var fopt = { __rust: 'option', some: hasFound, value: found };
          if (dotCall.close < toks.length - 1) return finishMethodResult(fopt, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: fopt, type: 'Option<_>' };
        }
        if (mname === 'retain') {
          var kept = [];
          for (var rk = 0; rk < base.items.length && rk < MAX_LOOP; rk++) {
            var rr2 = evalClosureValues(cvt, [{ value: base.items[rk], type: 'unknown' }], env, fns, st);
            if (truthy(rr2.value)) kept.push(base.items[rk]);
          }
          base.items = kept;
          if (dotCall.close < toks.length - 1) return finishMethodResult(undefined, toks.slice(dotCall.close + 1), env, fns, st);
          return { value: undefined, type: '()' };
        }
        var out = [];
        for (var mi = 0; mi < base.items.length && mi < MAX_LOOP; mi++) {
          var r = evalClosureValues(cvt, [{ value: base.items[mi], type: 'unknown' }], env, fns, st);
          if (mname === 'filter') { if (truthy(r.value)) out.push(base.items[mi]); }
          else if (mname === 'for_each') { out = base.items; }
          else out.push(r.value);
        }
        if (mname === 'for_each') return { value: undefined, type: '()' };
        var mv = { __rust: 'vec', items: out };
        if (dotCall.close < toks.length - 1) return finishMethodResult(mv, toks.slice(dotCall.close + 1), env, fns, st);
        return { value: mv, type: 'Vec<_>' };
      }
      var selfStruct = (bval !== null && typeof bval === 'object' && bval.__rust === 'struct') ? bval : null;
      if (selfStruct && st.qns && st.qns[selfStruct.name + '::' + mname]) {
        var qentry = st.qns[selfStruct.name + '::' + mname];
        var qchild = execFnBody(qentry, margs, env, fns, st, { value: selfStruct, type: selfStruct.name });
        if (dotCall.close < toks.length - 1) return finishMethodResult(qchild.value, toks.slice(dotCall.close + 1), env, fns, st);
        return qchild;
      }
      var r = evalMethod(base, mname, margVals);
      return finishMethodResult(r, toks.slice(dotCall.close + 1), env, fns, st);
    }
    // field access: expr.field / tuple `.0` (no parens — methods handled above).
    // Precedence: leading unary `!`/`-`, top-level binops and `as` casts all
    // bind looser than `.` — when one governs, skip here so its own splitter
    // runs first (it recurses back for the field part).
    var fdot = topFieldDot(toks);
    if (fdot !== -1) {
      if (fdot > 0 && (toks[0].v === '!' || toks[0].v === '-')) fdot = -1;
      else {
        var fbi = topBinOp(toks);
        if (fbi !== -1 && fbi < fdot) fdot = -1;
        else if (topAsCast(toks) !== -1) fdot = -1;
      }
    }
    if (fdot !== -1) {
      var fbase = evalExpr(toks.slice(0, fdot), env, fns, st).value;
      var ff = toks[fdot + 1].v;
      // `.await` is a transparent no-op: async runs synchronously in this engine
      // (tokio/actix futures execute inline; `x.await?` still unwraps via `?`).
      if (ff === 'await') return finishMethodResult(fbase, toks.slice(fdot + 2), env, fns, st);
      var frest = toks.slice(fdot + 2);
      var fIsIdx = /^(0|[1-9][0-9]*)$/.test(ff);
      // field assignment `obj.field = v` / `op=`: write through (struct
      // objects and vecs are shared refs, so `item.x = ..` persists).
      if (frest.length && (frest[0].v === '=' || frest[0].v === '+=' || frest[0].v === '-=' ||
          frest[0].v === '*=' || frest[0].v === '/=' || frest[0].v === '%=')) {
        var fHolder = null, fKey = null;
        if (fbase !== null && typeof fbase === 'object' && fbase.__rust === 'struct' && fbase.fields) {
          fHolder = fbase.fields; fKey = ff;
        } else if (fbase !== null && typeof fbase === 'object' && fbase.__rust === 'vec' && fIsIdx) {
          fHolder = fbase.items; fKey = parseInt(ff, 10);
        }
        var fRhsV = evalExpr(frest.slice(1), env, fns, st).value;
        if (fHolder !== null && fKey !== null) {
          if (frest[0].v === '=') fHolder[fKey] = fRhsV;
          else {
            var fCurV = (fHolder[fKey] !== undefined && fHolder[fKey] !== null &&
              typeof fHolder[fKey] === 'object' && 'value' in fHolder[fKey]) ? fHolder[fKey].value : fHolder[fKey];
            var fOp = frest[0].v[0];
            fHolder[fKey] = fOp === '+' ? num(fCurV) + num(fRhsV) : fOp === '-' ? num(fCurV) - num(fRhsV)
              : fOp === '*' ? num(fCurV) * num(fRhsV) : fOp === '/' ? (num(fRhsV) === 0 ? num(fCurV) : num(fCurV) / num(fRhsV))
              : num(fCurV) % num(fRhsV);
          }
          return { value: fHolder[fKey], type: 'unknown' };
        }
        return { value: 0, type: 'unknown' };
      }
      var fvv;
      if (fbase !== null && typeof fbase === 'object' && fbase.__rust === 'struct' &&
        Object.prototype.hasOwnProperty.call(fbase.fields, ff)) fvv = fbase.fields[ff];
      else if (fbase !== null && typeof fbase === 'object' && fbase.__rust === 'vec' && fIsIdx) {
        var fi0 = parseInt(ff, 10);
        fvv = (fi0 >= 0 && fi0 < fbase.items.length) ? fbase.items[fi0] : 0;
      } else fvv = 0;
      if (!frest.length) return { value: fvv, type: 'unknown' };
      return finishMethodResult(fvv, frest, env, fns, st);
    }
    // unary: ! - & *
    if (toks[0].v === '!') return { value: truthy(evalExpr(toks.slice(1), env, fns, st).value) ? false : true, type: 'bool' };
    if (toks[0].v === '-' && toks.length > 1) {
      var iv = evalExpr(toks.slice(1), env, fns, st);
      return { value: -num(iv.value), type: iv.type };
    }
    if (toks[0].v === '&') {
      // `&mut x` has a `mut` marker token — skip it, references are transparent
      var aInner = toks.slice(1);
      if (aInner.length && aInner[0].v === 'mut' && aInner[0].t === T.IDENT) aInner = aInner.slice(1);
      return evalExpr(aInner, env, fns, st);
    }
    if (toks[0].v === '*') {
      // deref: `*r` reads through the borrow target so `&mut` stays fresh
      var dd = 1;
      while (dd < toks.length && toks[dd].v === '*') dd++;
      if (dd < toks.length && toks[dd].t === T.IDENT && !isKw(toks[dd].v)) {
        var real = resolveRef(env, toks[dd].v);
        var got = lookupVar(env, real);
        var dv = got !== undefined ? got.value : 0;
        var restD = toks.slice(dd + 1);
        if (!restD.length) return { value: dv, type: 'unknown' };
        return finishMethodResult(dv, restD, env, fns, st);
      }
      return evalExpr(toks.slice(dd), env, fns, st);
    }

    // parens
    if (toks[0].v === '(' && matchTok(toks, 0, '(', ')') === toks.length - 1) {
      var inner10 = toks.slice(1, -1);
      var hasComma = topIndex(inner10, ',');
      if (hasComma !== -1) {
        var tps = splitArgs(inner10).filter(function (x) { return x.length; });
        return { value: { __rust: 'vec', items: tps.map(function (x) { return evalExpr(x, env, fns, st).value; }) }, type: 'tuple' };
      }
      // `()` unit
      if (!inner10.length) return { value: 0, type: '()' };
      return evalExpr(inner10, env, fns, st);
    }

    // literals / var
    if (toks.length === 1) {
      var s = toks[0];
      if (s.t === T.NUMBER) return { value: parseRustNum(s.v), type: 'i32' };
      if (s.t === T.STRING || s.t === T.RAWSTR) return { value: unquote(s), type: '&str' };
      if (s.t === T.BYTESTR) { var br2 = s.v.slice(2, s.v.length - 1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\0/g, '\0'); return { value: { __rust: 'bytes', raw: br2 }, type: '&[u8]' }; }
      if (s.t === T.CHAR) return { value: unquoteChar(s.v), type: 'char' };
      if (s.t === T.IDENT) {
        if (s.v === 'true') return { value: true, type: 'bool' };
        if (s.v === 'false') return { value: false, type: 'bool' };
        if (s.v === 'None') return { value: { __rust: 'option', some: false }, type: 'unknown' };
        // reads follow `&x` aliases so shared refs stay fresh
        var gotS = lookupVar(env, resolveRef(env, s.v));
        if (gotS !== undefined) return gotS;
        return { value: 0, type: 'unknown' };
      }
    }
    // binary ops (lowest precedence split)
    var bi = topBinOp(toks);
    if (bi !== -1) {
      var L = evalExpr(toks.slice(0, bi), env, fns, st).value;
      var OP = toks[bi].v;
      var R = evalExpr(toks.slice(bi + 1), env, fns, st).value;
      return { value: applyOp(L, OP, R), type: 'unknown' };
    }
    // `expr as Type`: numeric casts keep the JS number (bool/char widen too)
    var ai2 = topAsCast(toks);
    if (ai2 !== -1) {
      var cv = evalExpr(toks.slice(0, ai2), env, fns, st).value;
      var tnx = toks.slice(ai2 + 1).map(function (t) { return t.v; }).join('');
      if (/^(u8|u16|u32|u64|u128|usize|i8|i16|i32|i64|i128|isize)$/.test(tnx)) return { value: Math.trunc(num(cv)), type: tnx };
      if (/^(f32|f64)$/.test(tnx)) return { value: num(cv), type: tnx };
      if (tnx === 'bool') return { value: truthy(cv), type: 'bool' };
      if (tnx === 'char') return { value: String.fromCodePoint(Math.trunc(num(cv)) || 0), type: 'char' };
      return { value: cv, type: 'unknown' };
    }
    // range a..b / a..=b as value? represent as vec
    // (the lexer emits `..=` as one token; split `..` `=` handled too)
    var ri = topIndex(toks, '..');
    var riIncl = false;
    if (ri === -1) { ri = topIndex(toks, '..='); if (ri !== -1) riIncl = true; }
    if (ri !== -1) {
      var a2 = Math.floor(num(evalExpr(toks.slice(0, ri), env, fns, st).value));
      var rest = toks.slice(ri + 1);
      var incl = riIncl;
      if (!incl && rest.length && rest[0].v === '=') { incl = true; rest = rest.slice(1); }
      var b2 = Math.floor(num(evalExpr(rest, env, fns, st).value));
      var lo = Math.min(a2, b2), hi2 = incl ? b2 + 1 : b2, rr = [];
      for (var q2 = lo; q2 < hi2 && rr.length < MAX_LOOP; q2++) rr.push(q2);
      return { value: { __rust: 'vec', items: rr }, type: 'Vec<_>' };
    }
    // fallback: first token value
    if (toks[0].t === T.IDENT) {
      var gotF = lookupVar(env, resolveRef(env, toks[0].v));
      if (gotF !== undefined) return gotF;
    }
    return { value: 0, type: 'unknown' };
  }

  function evalBinOp(left, restToks, env, fns, st) {
    // restToks starts with binop
    if (!restToks.length) return left;
    var op = restToks[0].v;
    var rhs = evalExpr(restToks.slice(1), env, fns, st).value;
    return { value: applyOp(left.value, op, rhs), type: 'unknown' };
  }

  function isBinOp(t) {
    return t && t.t === T.SYMBOL && (t.v === '+' || t.v === '-' || t.v === '*' || t.v === '/' || t.v === '%' || t.v === '==' || t.v === '!=' || t.v === '<' || t.v === '>' || t.v === '<=' || t.v === '>=' || t.v === '&&' || t.v === '||');
  }

  function topBinOp(toks) {
    // precedence: || -> && -> ==/!=/</>/<=/>= -> +,- -> *,/,%
    var levels = [['||'], ['&&'], ['==', '!=', '<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];
    for (var l = 0; l < levels.length; l++) {
      var d = 0, found = -1;
      for (var i = toks.length - 1; i >= 0; i--) {
        var v = toks[i].v;
        if (v === ')' || v === ']' || v === '}') d++;
        else if (v === '(' || v === '[' || v === '{') d--;
        else if (d === 0 && levels[l].indexOf(v) !== -1) {
          // avoid `<` of generics / `->`? we only split on spaced ops; keep simple
          found = i; break;
        }
      }
      if (found !== -1) return found;
    }
    return -1;
  }

  // IDENT (:: IDENT)+ with nothing else -> path value (enums, consts)
  function isPathValue(toks) {
    if (toks.length < 3 || (toks.length % 2) !== 1) return false;
    for (var i = 0; i < toks.length; i++) {
      if (i % 2 === 0) { if (toks[i].t !== T.IDENT) return false; }
      else if (toks[i].v !== '::') return false;
    }
    return true;
  }

  // first `.` at depth 0 shaped like `.field` (not `.method(`)
  function topFieldDot(toks) {
    var d = 0;
    for (var i = 0; i < toks.length; i++) {
      var v = toks[i].v;
      if (v === '(' || v === '[' || v === '{') d++;
      else if (v === ')' || v === ']' || v === '}') d--;
      // `.field` or tuple index `.0` (a following `(` means method call)
      else if (d === 0 && v === '.' && toks[i + 1] &&
               (toks[i + 1].t === T.IDENT || toks[i + 1].t === T.NUMBER) &&
               (!toks[i + 2] || toks[i + 2].v !== '(')) return i;
    }
    return -1;
  }

  function topIndex(toks, op) {    var d = 0;
    for (var i = 0; i < toks.length; i++) {
      var v = toks[i].v;
      if (v === '(' || v === '[' || v === '{') d++;
      else if (v === ')' || v === ']' || v === '}') d--;
      else if (d === 0 && v === op) return i;
    }
    return -1;
  }

  function topAsCast(toks) {
    // depth-0 `as` keyword (cast); `r#as` raw idents never equal this
    var d = 0;
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i], v = t.v;
      if (v === '(' || v === '[' || v === '{') d++;
      else if (v === ')' || v === ']' || v === '}') d--;
      else if (d === 0 && v === 'as' && t.t === T.IDENT) return i;
    }
    return -1;
  }

  // ---- host OS info (linux/mac/windows via Node; nulls when unknown) ----
  // Drives `cfg!(..)`, `std::env::consts::*` and mirrors the rule-side
  // `#[cfg]` gating so checks and runs agree on every host.
  function hostOsInfo() {
    try {
      if (typeof process !== 'undefined' && process && process.platform) {
        var p = process.platform;
        var os = p === 'win32' ? 'windows' : p === 'darwin' ? 'macos' : p === 'linux' ? 'linux' : null;
        var fam = p === 'win32' ? 'windows' : (os ? 'unix' : null);
        var arch = null;
        try {
          var pa = process.arch;
          arch = pa === 'x64' ? 'x86_64' : pa === 'arm64' ? 'aarch64' : pa === 'ia32' ? 'x86' : (typeof pa === 'string' ? pa : null);
        } catch (eA) {}
        return { os: os, family: fam, arch: arch };
      }
    } catch (eH) {}
    return { os: null, family: null, arch: null };
  }

  function hostConstValue(key) {
    var h = hostOsInfo();
    if (key === 'OS') return h.os || 'unknown';
    if (key === 'FAMILY') return h.family || 'unknown';
    if (key === 'ARCH') return h.arch || 'unknown';
    if (key === 'DLL_PREFIX') return h.os === 'windows' ? '' : 'lib';
    if (key === 'DLL_SUFFIX' || key === 'DLL_EXTENSION') {
      return h.os === 'windows' ? 'dll' : h.os === 'macos' ? 'dylib' : 'so';
    }
    if (key === 'EXE_SUFFIX' || key === 'EXE_EXTENSION') return h.os === 'windows' ? 'exe' : '';
    return null;
  }

  function evalCfgPredI(pred, host) {
    var pos = 0;
    function peek() { return pos < pred.length ? pred[pos].v : null; }
    function parseOr() {
      var v = parseAtom();
      while (peek() === ',') { pos++; var rhs = parseAtom(); v = v || rhs; }
      return v;
    }
    function parseAtom() {
      var w = peek();
      if (w === 'not' && pred[pos + 1] && pred[pos + 1].v === '(') {
        pos += 2;
        var nv = parseOr();
        if (peek() === ')') pos++;
        return !nv;
      }
      if ((w === 'any' || w === 'all') && pred[pos + 1] && pred[pos + 1].v === '(') {
        var isAny = w === 'any';
        pos += 2;
        var acc = isAny ? false : true;
        while (pos < pred.length && peek() !== ')') {
          if (peek() === ',') { pos++; continue; }
          var cv = parseAtom();
          acc = isAny ? (acc || cv) : (acc && cv);
        }
        if (peek() === ')') pos++;
        return acc;
      }
      var key = w;
      pos++;
      if (peek() === '=') {
        pos++;
        var val = peek() || '';
        pos++;
        if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') val = val.slice(1, -1);
        if (key === 'target_os') return host.os ? host.os === val : true;
        if (key === 'target_family') return host.family ? host.family === val : true;
        if (key === 'target_arch') return host.arch ? host.arch === val : true;
        return true;
      }
      if (key === 'test' || key === 'doc') return false;
      if (key === 'debug_assertions') return true;
      if (key === 'unix') return host.family ? host.family === 'unix' : true;
      if (key === 'windows') return host.family ? host.family === 'windows' : true;
      if (key === 'linux' || key === 'macos' || key === 'ios' ||
          key === 'android' || key === 'freebsd' || key === 'openbsd') {
        return host.os ? host.os === key : true;
      }
      return true;
    }
    if (!pred.length) return true;
    return !!parseOr();
  }

  function applyOp(L, OP, R) {
    switch (OP) {
      case '+': return (typeof L === 'string' || typeof R === 'string') ? String(L) + String(R) : num(L) + num(R);
      case '-': return num(L) - num(R);
      case '*': return num(L) * num(R);
      case '/': return num(R) === 0 ? 0 : num(L) / num(R);
      case '%': return num(R) === 0 ? 0 : num(L) % num(R);
      case '==': return rustToString(L) === rustToString(R);
      case '!=': return rustToString(L) !== rustToString(R);
      case '<': return num(L) < num(R);
      case '>': return num(L) > num(R);
      case '<=': return num(L) <= num(R);
      case '>=': return num(L) >= num(R);
      case '&&': return truthy(L) && truthy(R);
      case '||': return truthy(L) || truthy(R);
      default: return R;
    }
  }

  function parseRustNum(s) {
    var t = String(s).replace(/_/g, '');
    var m = t.match(/^(0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+|\d+\.?\d*(?:[eE][+-]?\d+)?)/);
    var core = m ? m[1] : t;
    if (/^0x/i.test(core)) return parseInt(core.slice(2), 16);
    if (/^0o/i.test(core)) return parseInt(core.slice(2), 8);
    if (/^0b/i.test(core)) return parseInt(core.slice(2), 2);
    var f = parseFloat(core);
    return isNaN(f) ? 0 : f;
  }

  function unquoteChar(s) {
    var inner = s.slice(1, s.length - 1);
    if (inner[0] === '\\') {
      if (inner[1] === 'n') return '\n';
      if (inner[1] === 't') return '\t';
      if (inner[1] === 'r') return '\r';
      if (inner[1] === '0') return '\0';
      return inner[1] || '';
    }
    return inner;
  }

  function findMethodCall(toks) {
    // find `.` ident `(` at depth 0
    var d = 0;
    for (var i = 0; i < toks.length; i++) {
      var v = toks[i].v;
      if (v === '(' || v === '[' || v === '{') d++;
      else if (v === ')' || v === ']' || v === '}') d--;
      else if (d === 0 && v === '.' && toks[i + 1] && toks[i + 1].t === T.IDENT && toks[i + 2] && toks[i + 2].v === '(') {
        return { dot: i, open: i + 2, close: matchTok(toks, i + 2, '(', ')') };
      }
    }
    return null;
  }

  function evalMethod(base, mname, margVals) {
    if (mname === 'to_string' || mname === 'to_owned') return rustToString(base);
    if (mname === 'len') {
      if (base !== null && typeof base === 'object' && base.__rust === 'vec') return base.items.length;
      if (typeof base === 'string') return base.length;
      return 0;
    }
    if (mname === 'is_empty') {
      if (base !== null && typeof base === 'object' && base.__rust === 'vec') return base.items.length === 0;
      if (typeof base === 'string') return base.length === 0;
      return true;
    }
    if (mname === 'contains') return String(base).indexOf(String(margVals[0] || '')) !== -1;
    if (mname === 'parse') { var n = parseFloat(base); return { __rust: 'result', ok: !isNaN(n), value: isNaN(n) ? base : n }; }
    if (mname === 'abs') return Math.abs(num(base));
    if (mname === 'map_err') return base;
    if (mname === 'unwrap' || mname === 'expect') {
      if (base !== null && typeof base === 'object' && base.__rust === 'result') { if (base.ok) return base.value; throw { __frsTryErr: true, value: base.value }; }
      if (base !== null && typeof base === 'object' && base.__rust === 'option') { if (base.some) return base.value; return undefined; }
      return base;
    }
    if (mname === 'unwrap_or' || mname === 'unwrap_or_else') {
      if (base !== null && typeof base === 'object' && base.__rust === 'result') return base.ok ? base.value : (typeof margVals[0] === 'object' && margVals[0] && margVals[0].__rust === 'closure' ? evalClosureValues(margVals[0], [], {}, {}, { steps: 0 }).value : margVals[0]);
      return base;
    }
    if (mname === 'is_ok') return !!(base && base.__rust === 'result' && base.ok);
    if (mname === 'is_err') return !!(base && base.__rust === 'result' && !base.ok);
    if (mname === 'is_some') return !!(base && base.__rust === 'option' && base.some);
    if (mname === 'is_none') return !!(base && base.__rust === 'option' && !base.some);
    if (mname === 'lock' || mname === 'read' || mname === 'try_lock' || mname === 'write') return base;
    if (mname === 'flush') return base;
    if (mname === 'trim') return String(base).trim();
    if (mname === 'trim_end') return String(base).replace(/\s+$/, '');
    if (mname === 'to_lowercase') return String(base).toLowerCase();
    if (mname === 'to_uppercase') return String(base).toUpperCase();
    if (mname === 'as_str') return rustToString(base);
    if (mname === 'as_secs') return base;
    if (mname === 'as_bytes') return { __rust: 'bytes', raw: rustToString(base) };
    if (mname === 'starts_with') return String(base).indexOf(String(margVals[0] || '')) === 0;
    if (mname === 'ends_with') { var es = String(base); var ew = String(margVals[0] || ''); return es.slice(es.length - ew.length) === ew; }
    if (mname === 'push_str') return base;
    if (mname === 'get' && base !== null && typeof base === 'object' && base.__rust === 'vec') {
      var gi = margVals[0] | 0;
      return gi >= 0 && gi < base.items.length ? base.items[gi] : 0;
    }
    if (mname === 'into') return rustToString(base) && base;
    if (mname === 'split') { var p = base.split(String(margVals[0] || ',')); return { __rust: 'vec', items: p }; }
    if (mname === 'split_whitespace') { var q = String(base).split(/\s+/).filter(Boolean); return { __rust: 'vec', items: q }; }
    if (mname === 'join') {
      if (base !== null && typeof base === 'object' && base.__rust === 'vec') {
        var sep = margVals.length ? String(margVals[0]) : '';
        return base.items.map(function (x) { return rustToString(x); }).join(sep);
      }
      return '';
    }
    if (mname === 'push' && base !== null && typeof base === 'object' && base.__rust === 'vec') { base.items.push(margVals[0]); return base; }
    if (mname === 'insert') {
      if (base !== null && typeof base === 'object' && base.__rust === 'vec') { base.items.push(margVals.length === 2 ? margVals[1] : margVals[0]); return base; }
      return base;
    }
    if (mname === 'send' || mname === 'recv' || mname === 'try_recv') {
      if (mname === 'try_recv') return { __rust: 'result', ok: false, value: 'empty' };
      return base;
    }
    if (mname === 'get' && typeof base === 'number') return base;
    if (mname === 'set') return base;
    return base;
  }

  function throwFrsTry(v) { throw { __frsTryErr: true, value: v }; }

  function evalClosureValues(cv, argVals, env, fns, st) {
    var cchild = Object.create(env);
    for (var cp = 0; cp < cv.params.length; cp++) {
      cchild[cv.params[cp]] = cp < argVals.length ? argVals[cp] : { value: 0, type: 'unknown' };
      try { cchild[REF_PREFIX + cv.params[cp]] = null; } catch (eC) {}
    }
    try { return evalExpr(cv.body.slice(), cchild, fns, st); }
    catch (e2) {
      if (e2 && e2.__frsReturn) return { value: e2.value ? e2.value.value : 0, type: 'unknown' };
      throw e2;
    }
  }

  function evalClosure(cv, cparts, env, fns, st) {
    var cchild = Object.create(env);
    for (var cp2 = 0; cp2 < cv.params.length; cp2++) {
      var cpt2 = cp2 < cparts.length ? cparts[cp2] : [];
      // same self-reborrow rule as fn params (see execFnBody)
      if (!(cpt2.length && refTargetOf(cpt2) === cv.params[cp2])) {
        cchild[cv.params[cp2]] = (cp2 < cparts.length && cparts[cp2].length)
          ? evalExpr(cparts[cp2], env, fns, st) : { value: 0, type: 'unknown' };
      }
      trackRefBind(cchild, cv.params[cp2], cpt2);
    }
    try { return evalExpr(cv.body.slice(), cchild, fns, st); }
    catch (e2) {
      if (e2 && e2.__frsReturn) return { value: e2.value ? e2.value.value : 0, type: 'unknown' };
      throw e2;
    }
  }

  function callFn(name, argToks, env, fns, st, tk) {
    var fn = fns[name];
    if (!fn) {
      // closure variable? `let f = |x| ...; f(1)`
      var ev = (env !== null && typeof env === 'object' && env[name] !== undefined) ? env[name] : null;
      var cv = ev && ev.value && ev.value.__rust === 'closure' ? ev.value
        : (ev && ev.__rust === 'closure' ? ev : null);
      if (cv) return evalClosure(cv, splitArgs(argToks), env, fns, st);
      // unknown fn: evaluate args for side effects, return 0
      var parts = splitArgs(argToks);
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].length) { try { evalExpr(parts[i], env, fns, st); } catch (e) { if (e && e.__frsPanic) throw e; } }
      }
      return { value: 0, type: 'unknown' };
    }
    return execFnBody(fn, argToks, env, fns, st);
  }

  // qualified path call: Type::method(args) — exact impl match, else builtin/lenient
  function callPath(typeName, methodName, argToks, env, fns, qns, st, tk) {
    var q = qns[typeName + '::' + methodName];
    if (!q && (typeName === 'super' || typeName === 'crate' || typeName === 'self')) {
      // relative path: `super::helper()`, `crate::util()` — resolve leniently
      var ff = fns[methodName];
      if (ff && !ff.impl) return execFnBody(ff, argToks, env, fns, st);
      for (var qk in qns) {
        if (qk.length > methodName.length + 2 &&
            qk.slice(qk.length - methodName.length - 2) === '::' + methodName) {
          q = qns[qk];
          break;
        }
      }
    }
    if (q) return execFnBody(q, argToks, env, fns, st);
    // real file/socket I/O backed by Node fs/net (when available)
    if (FS_X) {
      if (typeName === 'File' || typeName === 'OpenOptions') {
        var nva = splitArgs(argToks).filter(function (a) { return a.length; });
        var p0 = nva.length ? evalExpr(nva[0], env, fns, st).value : '';
        if (methodName === 'create') {
          try { var wfd = FS_X.openSync(String(p0), 'w'); openFds.push(wfd); return { value: { __rust: 'file', _fd: wfd, path: String(p0) }, type: 'File' }; }
          catch (e2) { return { value: { __rust: 'result', ok: false, value: String(e2.message || e2) }, type: 'Result<File,Error>' }; }
        }
        if (methodName === 'open') {
          try { var rfd = FS_X.openSync(String(p0), 'r'); openFds.push(rfd); return { value: { __rust: 'file', _fd: rfd, path: String(p0) }, type: 'File' }; }
          catch (e2) { return { value: { __rust: 'result', ok: false, value: String(e2.message || e2) }, type: 'Result<File,Error>' }; }
        }
      }
      if (typeName === 'fs') {
        var fsva = splitArgs(argToks).filter(function (a) { return a.length; });
        var fp = fsva.length ? evalExpr(fsva[0], env, fns, st).value : '';
        try {
          if (methodName === 'read_to_string') return { value: { __rust: 'result', ok: true, value: FS_X.readFileSync(String(fp), 'utf8') }, type: 'Result' };
          if (methodName === 'write') { FS_X.writeFileSync(String(fp), rustToString(evalExpr(fsva[1] || [], env, fns, st).value)); return { value: { __rust: 'result', ok: true, value: 0 }, type: 'Result' }; }
          if (methodName === 'remove_file') { FS_X.unlinkSync(String(fp)); return { value: { __rust: 'result', ok: true, value: 0 }, type: 'Result' }; }
        } catch (e3) { return { value: { __rust: 'result', ok: false, value: String(e3.message || e3) }, type: 'Result' }; }
      }
      if (typeName === 'TcpListener' && methodName === 'bind') {
        var bindArgs = splitArgs(argToks).filter(function (a) { return a.length; });
        var bindAddr = bindArgs.length ? rustToString(evalExpr(bindArgs[0], env, fns, st).value) : '127.0.0.1:0';
        if (!NET_X) return { value: { __rust: 'result', ok: false, value: 'net unavailable' }, type: 'Result' };
        try {
          var portM = /:(\d+)$/.exec(bindAddr);
          var netSrv = NET_X.createServer();
          netSrv.listen(portM ? parseInt(portM[1], 10) : 0, bindAddr.replace(/:[0-9]+$/, '') || undefined);
          TCP_SRVS.push(netSrv);
          return { value: { __rust: 'tcplistener', _srv: netSrv }, type: 'TcpListener' };
        } catch (eN) { return { value: { __rust: 'result', ok: false, value: String(eN.message || eN) }, type: 'Result' }; }
      }
      // actix-web style: HttpServer::new(factory) captures the app factory;
      // `.bind(addr)?` + `.run().await` starts a real Node http server.
      // (The factory closure is never executed: routes come from `#[get]` attrs
      // and `.service/.route` registrations, see collectRoutes.)
      if (typeName === 'HttpServer' && methodName === 'new') {
        return { value: { __rust: 'httpserver', _factory: argToks.slice(), _host: null, _port: null }, type: 'HttpServer' };
      }
      // actix-web style: HttpResponse::Ok() / ::NotFound() / ... status builders.
      if (typeName === 'HttpResponse' && HTTP_STATUS[methodName] !== undefined) {
        return { value: { __rust: 'httpresponse', status: HTTP_STATUS[methodName], body: '', ctype: 'text/plain; charset=utf-8' }, type: 'HttpResponse' };
      }
      if (typeName === 'BufReader' && methodName === 'new') {
        var brows = splitArgs(argToks).filter(function (a) { return a.length; });
        var brv = brows.length ? evalExpr(brows[0], env, fns, st).value : null;
        var pfd = (brv !== null && typeof brv === 'object' && brv.__rust === 'file') ? brv._fd : null;
        var ppath = (brv !== null && typeof brv === 'object' && brv.__rust === 'file') ? brv.path : null;
        return { value: { __rust: 'bufreader', _fd: pfd, _path: ppath }, type: 'BufReader<File>' };
      }
      if (typeName === 'io' && methodName === 'stdin') return { value: { __rust: 'stdin' }, type: 'Stdin' };
      if (typeName === 'io' && methodName === 'stdout') return { value: { __rust: 'stdout' }, type: 'Stdout' };
    }
    if (typeName === 'OpenOptions' && methodName === 'new') {
      return { value: { __rust: 'openoptions', _append: false, _truncate: false, _create: false, _createNew: false, _write: false, _read: false }, type: 'OpenOptions' };
    }
    if (typeName === 'String' && (methodName === 'from_utf8_lossy' || methodName === 'from_utf8' || methodName === 'from_utf8_unchecked')) {
      var fa = splitArgs(argToks).filter(function (a) { return a.length; });
      if (fa.length) {
        var fv = evalExpr(fa[0], env, fns, st).value;
        var chars = '';
        if (fv !== null && typeof fv === 'object' && fv.__rust === 'vec') {
          chars = fv.items.map(function (x) { return String.fromCharCode(x); }).join('');
        } else if (fv !== null && typeof fv === 'object' && fv.__rust === 'bytes') {
          chars = fv.raw;
        } else {
          chars = rustToString(fv);
        }
        return { value: chars, type: 'Cow<str>' };
      }
      return { value: '', type: 'Cow<str>' };
    }
    if (methodName === 'new') {
      if (typeName === 'Vec' || typeName === 'VecDeque') {
        return { value: { __rust: 'vec', items: [] }, type: 'Vec<_>' };
      }
      if (typeName === 'String') return { value: '', type: 'String' };
      if (typeName === 'HashMap' || typeName === 'BTreeMap' || typeName === 'HashSet') {
        return { value: { __rust: 'vec', items: [] }, type: typeName };
      }
      // std wrapper types: Cell/Mutex/RwLock/Atomic*/RefCell/OnceLock -> adopt first arg
      var newArgs = splitArgs(argToks).filter(function (a) { return a.length; });
      if (newArgs.length) {
        try { return evalExpr(newArgs[0], env, fns, st); } catch (e) { /* fall */ }
      }
      return { value: 0, type: 'unknown' };
    }
    if (methodName === 'from' && typeName === 'String') {
      var fargs = splitArgs(argToks).filter(function (a) { return a.length; });
      if (fargs.length) { try { return { value: rustToString(evalExpr(fargs[0], env, fns, st).value), type: 'String' }; } catch (e) {} }
    }
    if (methodName === 'from' && typeName === 'Value') return { value: 0, type: 'Value' };
    var f = fns[methodName];
    if (f && !f.impl) return execFnBody(f, argToks, env, fns, st);
    var parts = splitArgs(argToks);
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].length) { try { evalExpr(parts[i], env, fns, st); } catch (e) { if (e && e.__frsPanic) throw e; } }
    }
    return { value: 0, type: 'unknown' };
  }

  function execFnBody(fn, argToks, env, fns, st, selfVal) {
    var parts2 = splitArgs(argToks);
    var child = Object.create(env);
    var hasSelf = fn.params.length && fn.params[0] === 'self';
    var pStart = 0, argOff = 0;
    if (hasSelf) {
      child['self'] = selfVal !== undefined ? selfVal : (parts2.length && parts2[0].length ? evalExpr(parts2[0], env, fns, st) : { value: 0, type: 'unknown' });
      pStart = 1;
      argOff = selfVal !== undefined ? 1 : 0;
    }
    for (var p = pStart; p < fn.params.length; p++) {
      var ai = p - (hasSelf ? 1 : 0) + (hasSelf ? (selfVal !== undefined ? 0 : 1) : 0);
      var argToksP = (ai >= 0 && ai < parts2.length) ? parts2[ai] : [];
      var pv = (ai >= 0 && ai < parts2.length && parts2[ai].length) ? evalExpr(parts2[ai], env, fns, st) : { value: 0, type: 'unknown' };
      // Direct self-reborrow `f(&mut n)` with the param also named `n`:
      // keep NO local copy — reads/writes fall through to the caller's
      // binding, so `*n += 1` writes back. (A value copy here would shadow
      // the caller's slot and silently lose every write-back.)
      if (refTargetOf(argToksP) !== fn.params[p]) child[fn.params[p]] = pv;
      // `foo(&mut h)` aliases param -> caller's var so `*s = ...` writes back
      trackRefBind(child, fn.params[p], argToksP);
    }
    var O3 = st.stdout || { push: function () { } };
    var E3 = st.stderr || { push: function () { } };
    // Rust implicit tail return: last statement without `;` is the value.
    var body2 = fn.bodyToks;
    var ls2 = findStmtStart(body2);
    var tail2 = body2.slice(ls2);
    var head2 = body2.slice(0, ls2);
    var tailIsStmt = tail2.length > 0 && tail2[0].t === T.IDENT &&
      (tail2[0].v === 'let' || tail2[0].v === 'for' || tail2[0].v === 'while' ||
       tail2[0].v === 'loop' || tail2[0].v === 'return' || tail2[0].v === 'fn' ||
       tail2[0].v === 'break' || tail2[0].v === 'continue' ||
       tail2[0].v === 'struct' || tail2[0].v === 'use');
    if (tail2.length >= 2 && tail2[0].t === T.IDENT && tail2[1].v === '!' &&
        tail2[0].v !== 'format' && tail2[0].v !== 'vec') tailIsStmt = true;
    try {
      execBlock(head2, child, fns, O3, E3, st);
      if (!tail2.length || tailIsStmt) {
        if (tail2.length) execBlock(tail2, child, fns, O3, E3, st);
        return { value: 0, type: 'unknown' };
      }
      var tr = evalExpr(tail2, child, fns, st);
      if (tr && tr.value && tr.value.__rust === 'struct' && tr.value.name === 'Self' && fn.implT) tr.value.name = fn.implT;
      return tr;
    } catch (e) {
      if (e && e.__frsReturn) return { value: e.value ? e.value.value : 0, type: 'unknown' };
      if (e && e.__frsTryErr) return { value: { __rust: 'result', ok: false, value: e.value }, type: 'unknown' };
      throw e;
    }
  }

  function evalStmtExpr(toks, i, env, fns, st) {
    var stmt = sliceStmt(toks, i);
    return evalExpr(stmt.toks, env, fns, st);
  }

  function findStmtStart(inner) {
    // find start of last `;`-separated statement — or the statement following
    // a block-tailed statement (`if/for/while/loop/match/{...}` needs no `;`).
    var d = 0, blockEnd = -1;
    for (var i = inner.length - 1; i >= 0; i--) {
      var v = inner[i].v;
      if (v === ')' || v === ']' || v === '}') {
        if (v === '}' && d === 0) blockEnd = i;
        d++;
      }
      else if (v === '(' || v === '[' || v === '{') {
        d--;
        if (v === '{' && d === 0 && blockEnd !== -1) {
          var t = blockEnd + 1;
          if (inner[t] && inner[t].v === ';') t++;
          if (t < inner.length) return t; // code follows the block: split here
          blockEnd = -1; // the block IS the tail (trailing if/match value): keep looking
        }
      }
      else if (d === 0 && v === ';') return i + 1;
    }
    return 0;
  }

  // ---- if ----
  function condValue(toks, env, fns, st) {
    // `if/while let PAT = expr` — destructure (binds) and test
    if (toks.length >= 2 && toks[0].t === T.IDENT && toks[0].v === 'let') {
      var eq = -1, ed = 0;
      for (var i = 1; i < toks.length; i++) {
        var w = toks[i].v;
        if (w === '(' || w === '[' || w === '{') ed++;
        else if (w === ')' || w === ']' || w === '}') ed--;
        else if (w === '=' && ed === 0) { eq = i; break; }
      }
      if (eq !== -1) {
        var rhs;
        try { rhs = evalExpr(toks.slice(eq + 1), env, fns, st).value; }
        catch (e) { if (e && e.__frsPanic) throw e; rhs = 0; }
        try { return matchPat(toks.slice(1, eq), rhs, env, fns, st); }
        catch (e2) { if (e2 && e2.__frsPanic) throw e2; return false; }
      }
    }
    return truthy(evalExpr(toks, env, fns, st).value);
  }

  function execIf(toks, i, env, fns, stdout, stderr, st) {
    var n = toks.length, k = i + 1, d = 0, q = k, thenOpen = -1;
    while (q < n) {
      var v = toks[q].v;
      if (v === '(' || v === '[') d++;
      else if (v === ')' || v === ']') d--;
      else if (v === '{' && d === 0) { thenOpen = q; break; }
      else if (v === ';' && d === 0) break;
      q++;
      if (q - k > 200) break;
    }
    if (thenOpen === -1) return Math.min(n, k + 1);
    var condToks = toks.slice(k, thenOpen);
    var thenEnd = matchTok(toks, thenOpen, '{', '}');
    if (thenEnd === -1) thenEnd = n - 1;
    var thenBody = toks.slice(thenOpen + 1, thenEnd);
    var after = thenEnd + 1;
    // else / else if chain
    var elseBody = null, elseIf = null;
    if (toks[after] && toks[after].v === 'else') {
      if (toks[after + 1] && toks[after + 1].v === 'if') {
        // else if: recurse as nested if at `after+1`
        var sub = execIfChain(toks, after + 1, env, fns, stdout, stderr, st);
        // decide branch
        var c;
        try { c = condValue(condToks, env, fns, st); } catch (e) { if (e && e.__frsPanic) throw e; c = false; }
        if (c) execBlock(thenBody, env, fns, stdout, stderr, st);
        else { /* else-if already executed inside sub? no — run it now */ execIf(toks, after + 1, env, fns, stdout, stderr, st); }
        return sub.next;
      } else if (toks[after + 1] && toks[after + 1].v === '{') {
        var ee = matchTok(toks, after + 1, '{', '}');
        if (ee === -1) ee = n - 1;
        elseBody = toks.slice(after + 2, ee);
        after = ee + 1;
      }
    }
    var c2;
    try { c2 = condValue(condToks, env, fns, st); } catch (e2) { if (e2 && e2.__frsPanic) throw e2; c2 = false; }
    try {
      if (c2) execBlock(thenBody, env, fns, stdout, stderr, st);
      else if (elseBody) execBlock(elseBody, env, fns, stdout, stderr, st);
    } catch (e3) {
      if (e3 && (e3.__frsBreak || e3.__frsContinue || e3.__frsReturn || e3.__frsPanic)) throw e3;
    }
    return after;
  }

  function execIfChain(toks, i, env, fns, stdout, stderr, st) {
    // returns {next} — helper for else-if scanning
    var n = toks.length, k = i + 1, d = 0, q = k, thenOpen = -1;
    while (q < n) {
      var v = toks[q].v;
      if (v === '(' || v === '[') d++;
      else if (v === ')' || v === ']') d--;
      else if (v === '{' && d === 0) { thenOpen = q; break; }
      q++;
      if (q - k > 200) break;
    }
    if (thenOpen === -1) return { next: Math.min(n, k + 1) };
    var thenEnd = matchTok(toks, thenOpen, '{', '}');
    if (thenEnd === -1) return { next: n };
    var after = thenEnd + 1;
    if (toks[after] && toks[after].v === 'else') {
      if (toks[after + 1] && toks[after + 1].v === '{') {
        var ee = matchTok(toks, after + 1, '{', '}');
        after = ee === -1 ? n : ee + 1;
      } else if (toks[after + 1] && toks[after + 1].v === 'if') {
        after = execIfChain(toks, after + 1, env, fns, stdout, stderr, st).next;
      }
    }
    return { next: after };
  }

  function evalIfExpr(toks, env, fns, st) {
    // execute the taken branch, value = branch tail expression
    var n = toks.length, k = 1, d = 0, q = k, thenOpen = -1;
    while (q < n) {
      var v = toks[q].v;
      if (v === '(' || v === '[') d++;
      else if (v === ')' || v === ']') d--;
      else if (v === '{' && d === 0) { thenOpen = q; break; }
      q++;
    }
    if (thenOpen === -1) return 0;
    var condToks = toks.slice(1, thenOpen);
    var thenEnd = matchTok(toks, thenOpen, '{', '}');
    if (thenEnd === -1) return 0;
    var c = false;
    try { c = condValue(condToks, env, fns, st); } catch (e) { c = false; }
    var branch = c ? toks.slice(thenOpen, thenEnd + 1) : null;
    var after = thenEnd + 1;
    if (!c && toks[after] && toks[after].v === 'else') {
      if (toks[after + 1] && toks[after + 1].v === '{') {
        var ee = matchTok(toks, after + 1, '{', '}');
        branch = toks.slice(after + 1, (ee === -1 ? n - 1 : ee) + 1);
      } else if (toks[after + 1] && toks[after + 1].v === 'if') {
        return evalIfExpr(toks.slice(after + 1), env, fns, st);
      }
    }
    if (!branch) return 0;
    var r = evalExpr(branch, env, fns, st);
    return r.value;
  }

  // ---- for ----
  function execFor(toks, i, env, fns, stdout, stderr, st) {
    var n = toks.length;
    // for pat in expr { body }
    var k = i + 1, d = 0, q = k, inIdx = -1, open = -1;
    while (q < n) {
      var v = toks[q].v;
      if (v === '(' || v === '[') d++;
      else if (v === ')' || v === ']') d--;
      else if (d === 0 && toks[q].t === T.IDENT && toks[q].v === 'in') { inIdx = q; }
      else if (d === 0 && v === '{') { open = q; break; }
      else if (d === 0 && v === ';') break;
      q++;
      if (q - k > 200) break;
    }
    if (inIdx === -1 || open === -1) return Math.min(n, i + 2);
    var patToks = toks.slice(k, inIdx);
    var iterToks = toks.slice(inIdx + 1, open);
    var end = matchTok(toks, open, '{', '}');
    if (end === -1) end = n - 1;
    var body = toks.slice(open + 1, end);
    var varName = patToks.length ? patToks[patToks.length - 1].v : '_';
    if (patToks[0] && patToks[0].v === 'mut' && patToks[1]) varName = patToks[1].v;
    var iterVal;
    try { iterVal = evalExpr(iterToks.slice(), env, fns, st).value; }
    catch (e) { if (e && e.__frsPanic) throw e; iterVal = []; }
    // real socket incoming loop (continuous server, pure Node.js net)
    if (iterVal !== null && typeof iterVal === 'object' && iterVal.__rust === 'tcpincoming' && NET_X) {
      NET_LISTENING = true;
      var srvListen = iterVal._srv;
      try {
        srvListen.on('error', function (eL2) {
          try { if (typeof process !== 'undefined' && process.stderr) process.stderr.write('error: failed to bind listener: ' + (eL2 && eL2.message || eL2) + '\n'); } catch (eI) {}
        });
        srvListen.on('connection', function (sock) {
          var conn = { __rust: 'tcpstream', _sock: sock, _chunk: Buffer.alloc(0) };
          try { sock.setNoDelay && sock.setNoDelay(true); } catch (eN) {}
          // one Rust `for stream in listener.incoming()` iteration == one connection.
          // use `once` so a chunked request is handled exactly once, then close
          // (mimics Rust dropping `stream` at end of loop body).
          sock.once('data', function (d) {
            conn._chunk = d;
            var child = Object.create(env);
            child[varName] = { value: { __rust: 'result', ok: true, value: conn }, type: 'unknown' };
            var outMark = stdout.length, errMark = stderr.length;
            try { execBlock(body, child, fns, stdout, stderr, st); }
            catch (eS) { if (eS && eS.__frsPanic && process.stderr) { try { process.stderr.write('thread panicked: ' + eS.msg + '\n'); } catch (eW) {} } }
            // live-flush any println!/eprintln! from this hit (run() already returned)
            try {
              if (typeof process !== 'undefined') {
                if (stdout.length > outMark && process.stdout) process.stdout.write(stdout.slice(outMark).join(''));
                if (stderr.length > errMark && process.stderr) process.stderr.write(stderr.slice(errMark).join(''));
              }
            } catch (eF) {}
            // finish HTTP hit: flush socket write then end (so curl/browser completes)
            try { sock.end(); } catch (eE) {}
            try { setTimeout(function () { try { sock.destroy(); } catch (eD) {} }, 2000); } catch (eT) {}
          });
          sock.on('error', function () {});
        });
      } catch (eL) {}
      return end + 1;
    }
    var items = toItems(iterVal);
    var had = Object.prototype.hasOwnProperty.call(env, varName);
    var saved = env[varName];
    for (var j = 0; j < items.length && j < MAX_LOOP; j++) {
      if (varName !== '_') env[varName] = { value: items[j], type: 'unknown' };
      try { execBlock(body, env, fns, stdout, stderr, st); }
      catch (e2) {
        if (e2 && e2.__frsBreak) break;
        if (e2 && e2.__frsContinue) continue;
        if (e2 && (e2.__frsReturn || e2.__frsPanic)) throw e2;
      }
    }
    if (!had) delete env[varName]; else env[varName] = saved;
    return end + 1;
  }

  function toItems(v) {
    if (v !== null && typeof v === 'object' && v.__rust === 'vec') return v.items.slice();
    if (typeof v === 'number') { var r = []; for (var i = 0; i < v && i < MAX_LOOP; i++) r.push(i); return r; }
    if (typeof v === 'string') return v.split('');
    return [];
  }

  // ---- while / loop ----
  function execWhile(toks, i, env, fns, stdout, stderr, st) {
    var isLoop = toks[i].v === 'loop';
    var n = toks.length, open = -1, q = i + 1, d = 0;
    while (q < n) {
      var v = toks[q].v;
      if (v === '(' || v === '[') d++;
      else if (v === ')' || v === ']') d--;
      else if (v === '{' && d === 0) { open = q; break; }
      else if (v === ';' && d === 0) break;
      q++;
      if (q - i > 200) break;
    }
    if (open === -1) return Math.min(n, i + 2);
    var condToks = isLoop ? [] : toks.slice(i + 1, open);
    var end = matchTok(toks, open, '{', '}');
    if (end === -1) end = n - 1;
    var body = toks.slice(open + 1, end);
    var iter = 0;
    while (iter++ < MAX_LOOP) {
      var c = true;
      if (!isLoop) { try { c = condValue(condToks, env, fns, st); } catch (e) { if (e && e.__frsPanic) throw e; c = false; } }
      if (!c) break;
      try { execBlock(body, env, fns, stdout, stderr, st); }
      catch (e2) {
        if (e2 && e2.__frsBreak) break;
        if (e2 && e2.__frsContinue) continue;
        if (e2 && (e2.__frsReturn || e2.__frsPanic)) throw e2;
      }
      if (isLoop && iter >= MAX_LOOP) break;
    }
    return end + 1;
  }

  // ---- match (simple: literal/ident/_ arms, `=>` expr or block) ----
  function execMatch(toks, i, env, fns, stdout, stderr, st) {
    var res = matchRun(toks, i, env, fns, st);
    try {
      if (res.armBody) execBlock(res.armBody, env, fns, stdout, stderr, st);
    } catch (e) {
      if (e && (e.__frsBreak || e.__frsContinue || e.__frsReturn || e.__frsPanic)) throw e;
    }
    return res.next;
  }

  function evalMatchExpr(toks, env, fns, st) {
    var res = matchRun(toks, 0, env, fns, st);
    if (!res.armBody) return 0;
    // arm body: `expr ,` or `{...}` — eval tail
    var body = res.armBody.slice();
    while (body.length && (body[body.length - 1].v === ',')) body = body.slice(0, -1);
    if (!body.length) return 0;
    try {
      if (body[0].v === '{' && matchTok(body, 0, '{', '}') === body.length - 1) {
        return evalExpr(body, env, fns, st).value;
      }
      return evalExpr(body, env, fns, st).value;
    } catch (e) { return 0; }
  }

  function matchRun(toks, i, env, fns, st) {
    var n = toks.length, q = i + 1, d = 0, open = -1;
    while (q < n) {
      var v = toks[q].v;
      if (v === '(' || v === '[') d++;
      else if (v === ')' || v === ']') d--;
      else if (v === '{' && d === 0) { open = q; break; }
      else if (v === ';' && d === 0) break;
      q++;
      if (q - i > 200) break;
    }
    if (open === -1) return { next: Math.min(n, i + 2), armBody: null };
    var scrut = toks.slice(i + 1, open);
    var end = matchTok(toks, open, '{', '}');
    if (end === -1) return { next: n, armBody: null };
    var svalRaw = 0;
    try { svalRaw = evalExpr(scrut.slice(), env, fns, st).value; } catch (e) { svalRaw = 0; }
    // split arms by top-level `=>`
    var inner = toks.slice(open + 1, end);
    var arms = [];
    var depth = 0, cur = [], arrow = -1;
    // first split by `,` at depth 0 where depth counts braces (arm bodies with blocks contain no top comma issue — handle by scanning `=>`)
    var k = 0;
    while (k < inner.length) {
      if (inner[k].v === '(' || inner[k].v === '[' || inner[k].v === '{') depth++;
      else if (inner[k].v === ')' || inner[k].v === ']' || inner[k].v === '}') depth--;
      else if (depth === 0 && inner[k].v === '=>') {
        var pat = cur; cur = [];
        // body: a `{...}` block needs no trailing `,` (valid Rust omits it);
        // an expression body runs until `,` at depth 0 or the end.
        var bstart = k + 1, bend = -1, afterBody = -1;
        if (inner[bstart] && inner[bstart].v === '{') {
          var bex = matchTok(inner, bstart, '{', '}');
          if (bex !== -1) {
            bend = bex + 1;
            afterBody = (inner[bend] && inner[bend].v === ',') ? bend + 1 : bend;
          }
        }
        if (afterBody === -1) {
          var bd = 0;
          for (var j = bstart; j < inner.length; j++) {
            var w = inner[j].v;
            if (w === '(' || w === '[' || w === '{') bd++;
            else if (w === ')' || w === ']' || w === '}') bd--;
            else if (bd === 0 && w === ',') { bend = j; afterBody = j + 1; break; }
          }
          if (afterBody === -1) { bend = inner.length; afterBody = inner.length; }
        }
        var body = inner.slice(bstart, bend);
        arms.push({ pat: pat, body: body });
        cur = [];
        k = afterBody;
        continue;
      }
      cur.push(inner[k]);
      k++;
    }
    for (var a = 0; a < arms.length; a++) {
      try {
        if (matchPat(arms[a].pat, svalRaw, env, fns, st)) {
          return { next: end + 1, armBody: arms[a].body };
        }
      } catch (e2) { if (e2 && e2.__frsPanic) throw e2; }
    }
    return { next: end + 1, armBody: null };
  }

  function isSome(v) { return v !== null && typeof v === 'object' && v.__rust === 'option' && !!v.some; }
  function isNone(v) { return v !== null && typeof v === 'object' && v.__rust === 'option' && !v.some; }
  function isOk(v) { return v !== null && typeof v === 'object' && v.__rust === 'result' && !!v.ok; }
  function isErr(v) { return v !== null && typeof v === 'object' && v.__rust === 'result' && !v.ok; }

  // destructure-match a pattern against a runtime value; binds idents; returns matched?
  // (shared by `match` arms and `if/while let` conditions)
  function matchPat(pat, val, env, fns, st) {
    if (!pat.length) return false;
    // match guard `if ...`: evaluated AFTER the core pattern matches, with
    // the arm bindings in scope (real Rust semantics).
    var g = -1;
    for (var gi = 0; gi < pat.length; gi++) {
      if (pat[gi].t === T.IDENT && pat[gi].v === 'if') { g = gi; break; }
    }
    var core = g === -1 ? pat : pat.slice(0, g);
    var guard = g === -1 ? null : pat.slice(g + 1);
    if (!core.length) return false;
    // top-level `|` alternatives: first match wins (binds on success)
    var depth = 0, start = 0, alt = null;
    for (var oi = 0; oi <= core.length; oi++) {
      var ov = oi < core.length ? core[oi].v : '|';
      if (oi < core.length) {
        if (ov === '(' || ov === '[' || ov === '{') depth++;
        else if (ov === ')' || ov === ']' || ov === '}') depth--;
      }
      if (ov === '|' && depth === 0) {
        if (alt === null) alt = [];
        alt.push(core.slice(start, oi));
        start = oi + 1;
      }
    }
    if (alt !== null) {
      for (var ao = 0; ao < alt.length; ao++) {
        if (matchCore(alt[ao], val, env, fns, st) && guardOk(guard, env, fns, st)) return true;
      }
      return false;
    }
    if (!matchCore(core, val, env, fns, st)) return false;
    return guardOk(guard, env, fns, st);
  }

  function guardOk(guard, env, fns, st) {
    if (!guard || !guard.length) return true;
    if (!fns || !st) return true; // engine fallback: assume it passes
    try { return truthy(evalExpr(guard.slice(), env, fns, st).value); }
    catch (e) { if (e && e.__frsPanic) throw e; return true; }
  }

  function matchCore(core, val, env, fns, st) {
    if (!core.length) return false;
    // `name @ subpat`: match the sub-pattern, bind the name on success
    if (core.length >= 3 && core[0].t === T.IDENT && core[1].v === '@' &&
        !(core[0].v[0] >= 'A' && core[0].v[0] <= 'Z')) {
      var sub = core.slice(2);
      // sub-pattern may itself hold `|` alternatives
      var od = 0, os = 0, oalt = null;
      for (var ox = 0; ox <= sub.length; ox++) {
        var ow = ox < sub.length ? sub[ox].v : '|';
        if (ox < sub.length) {
          if (ow === '(' || ow === '[' || ow === '{') od++;
          else if (ow === ')' || ow === ']' || ow === '}') od--;
        }
        if (ow === '|' && od === 0) {
          if (oalt === null) oalt = [];
          oalt.push(sub.slice(os, ox));
          os = ox + 1;
        }
      }
      var ok = oalt !== null
        ? oalt.some(function (a) { return matchCore(a, val, env, fns, st); })
        : matchCore(sub, val, env, fns, st);
      if (ok) {
        if (core[0].v !== '_') env[core[0].v] = { value: val, type: 'unknown' };
        return true;
      }
      return false;
    }
    // strip binding modifiers: `mut x`, `ref x`, `&x`, `&mut x`
    var stripped = true;
    while (stripped && core.length) {
      stripped = false;
      if (core[0].t === T.IDENT && (core[0].v === 'mut' || core[0].v === 'ref')) { core = core.slice(1); stripped = true; }
      else if (core[0].v === '&') { core = core.slice(1); stripped = true; }
    }
    if (!core.length) return false;
    if (core.length === 1 && core[0].v === '_') return true;
    // single token: literals, None, bare binding/ctor
    if (core.length === 1) {
      var one = core[0];
      if (one.t === T.NUMBER) return num(val) === parseRustNum(one.v);
      if (one.t === T.STRING || one.t === T.RAWSTR) return rustToString(val) === unquote(one);
      if (one.t === T.CHAR) return rustToString(val) === unquoteChar(one.v);
      if (one.v === 'true') return val === true;
      if (one.v === 'false') return val === false;
      if (one.v === 'None') return isNone(val);
      if (one.t === T.IDENT) {
        if (one.v[0] >= 'A' && one.v[0] <= 'Z') {
          if (val !== null && typeof val === 'object' && val.__rust === 'enum') {
            var segs = val.path.split('::');
            return segs[segs.length - 1] === one.v;
          }
          return true; // unknown shape: lenient first-match
        }
        env[one.v] = { value: val, type: 'unknown' };
        return true;
      }
      return false;
    }
    // path pattern: Dir::North / Option::None
    if (isPathValue(core)) {
      var pp = core.map(function (t) { return t.v; }).join('');
      if (pp === 'None' || /::None$/.test(pp)) return isNone(val);
      if (pp === 'Some' || /::Some$/.test(pp)) return isSome(val);
      if (val !== null && typeof val === 'object' && val.__rust === 'enum') return val.path === pp;
      return true;
    }
    // struct pattern: Name { x, y: b, .. }
    if (core.length >= 3 && core[0].t === T.IDENT && core[1].v === '{') {
      var sfields = (val !== null && typeof val === 'object' && val.__rust === 'struct') ? val.fields : {};
      var sce = matchTok(core, 1, '{', '}');
      var sfparts = splitArgs(core.slice(2, sce === -1 ? core.length : sce));
      for (var sf = 0; sf < sfparts.length; sf++) {
        var sfa = sfparts[sf];
        if (!sfa.length) continue;
        if (sfa[0].v === '.' ) continue; // `..` rest
        if (sfa.length >= 3 && sfa[0].t === T.IDENT && sfa[1].v === ':') {
          var svv = Object.prototype.hasOwnProperty.call(sfields, sfa[0].v) ? sfields[sfa[0].v] : 0;
          matchPat(sfa.slice(2), svv, env, fns, st);
        } else if (sfa.length === 1 && sfa[0].t === T.IDENT && sfa[0].v !== '_') {
          env[sfa[0].v] = {
            value: Object.prototype.hasOwnProperty.call(sfields, sfa[0].v) ? sfields[sfa[0].v] : 0,
            type: 'unknown'
          };
        }
      }
      return true;
    }
    // ctor pattern: Some(x) / Ok(v) / Err(e) / Foo(a, b)
    if (core.length >= 3 && core[0].t === T.IDENT && core[1].v === '(') {
      var cname = core[0].v;
      var cce = matchTok(core, 1, '(', ')');
      var cinner = cce === -1 ? core.slice(2) : core.slice(2, cce);
      var csub = splitArgs(cinner);
      if (cname === 'Some') {
        if (!isSome(val)) return false;
        return csub.length === 1 ? matchPat(csub[0], val.value, env, fns, st) : true;
      }
      if (cname === 'Ok') {
        if (!isOk(val)) return false;
        return csub.length === 1 ? matchPat(csub[0], val.value, env, fns, st) : true;
      }
      if (cname === 'Err') {
        if (!isErr(val)) return false;
        return csub.length === 1 ? matchPat(csub[0], val.value, env, fns, st) : true;
      }
      if (val !== null && typeof val === 'object' && val.__rust === 'ctor' &&
          val.name === cname && val.args.length === csub.length) {
        for (var ca = 0; ca < csub.length; ca++) {
          if (!matchPat(csub[ca], val.args[ca], env, fns, st)) return false;
        }
        return true;
      }
      return true; // unknown shape: lenient
    }
    // range pattern `1..=5` (inclusive) / `1..5` (exclusive end)
    for (var r = 0; r < core.length; r++) {
      if (core[r].v === '..' || core[r].v === '..=') {
        var incl = core[r].v === '..=';
        var rrest = core.slice(r + 1);
        if (!incl && rrest.length && rrest[0].v === '=') { incl = true; rrest = rrest.slice(1); }
        var lo = parseFloat(core[0] ? core[0].v : 'NaN');
        var hi = parseFloat(rrest.length ? rrest[rrest.length - 1].v : 'NaN');
        if (isNaN(lo) || isNaN(hi)) return false;
        var sv2 = num(val);
        return incl ? (sv2 >= lo && sv2 <= hi) : (sv2 >= lo && sv2 < hi);
      }
    }
    return true;
  }

  // (matchPat lives above; old string-based armMatches removed)

  return { run: run, MAX_STEPS: MAX_STEPS, MAX_LOOP: MAX_LOOP };
}));

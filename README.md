# frs — extreme-fast fake Rust compiler in pure JavaScript

`frs` doesn't compile to machine code. It **checks** Rust code (syntax + types)
and prints errors **exactly like `rustc`**, then runs the program in a fake
runtime that really executes `fs`, sockets and stdio **through Node.js**. No
build steps, no native deps, no npm dependencies.

- **Zero dependencies, pure JS** — runs in Node *and* browsers (`index.html`).
- **Fast** — single-pass lexer + single-pass checker, `O(n)`, no regex in hot
  loops, int-enum tokens, precomputed line map, allocation-free rule pass.
- **rustc-like output** — `error[E0308]: …`, `--> main.rs:2:5`, caret spans,
  `help:`/`note:`, abort footer, panic format, TTY colors.
- **Rule table** — every check is one declarative entry in `src/rules.js`.
  Adding a check = adding one object.
- **Cargo-like workflow** — `frs new/build/run/check`, real `Cargo.toml`
  parsing, dependencies downloaded from crates.io, compiled and cached.
- **Real side effects (Node only)** — `File::create/open`, `read_to_string`,
  `writeln!(file, …)`, stdin `read_line`, TCP listeners (`TcpListener::bind`),
  binary buffers via `b"…"` + `&[u8]`.

## Layout

```
frs/
  src/
    util.js         char tables, line map, colors
    lexer.js        single-pass tokenizer (strings, chars, byte-strings,
                    comments, numbers, ask: `b"..."` support)
    diagnostics.js  rustc-style renderer
    rules.js        *** THE RULE TABLE — declare checks here ***
    checker.js      one-pass syntax+type checker, runs RULES
    interpreter.js  runtime (println!/format!/vars/loops/fns/match/impls/
                    macros/fs/stdin/tcp)
    frs.js          core engine: compile(src, opts) -> {stderr, stdout, ...}
    pm.js           cargo-like package manager (new/build/run/imports deps)
  bin/frs(.js)      CLI (rustc-like flags + subcommands)
  examples/         hello.rs, error_demo.rs, advanced.rs, web_server.rs,
                    highly_advance.rs, extreme_advance.rs
  tests/run.js      zero-dep tests (`npm test`)
  index.html        browser demo (loads src/*.js via <script>)
```

## Quick start

```sh
node bin/frs.js examples/hello.rs
node bin/frs.js examples/error_demo.rs   # shows rustc-style errors
npm test
```

As a library (Node):

```js
const FRS = require('./src/frs.js');
const r = FRS.compile('fn main() { println!("hi {}", 1); }', { file: 'main.rs' });
console.log(r.stderr);  // rustc-style errors ('' if clean)
console.log(r.stdout);  // program output
console.log(r.success, r.timeMs + 'ms');
```

In a browser:

```html
<script src="src/util.js"></script>
<script src="src/lexer.js"></script>
<script src="src/diagnostics.js"></script>
<script src="src/rules.js"></script>
<script src="src/checker.js"></script>
<script src="src/interpreter.js"></script>
<script src="src/frs.js"></script>
<script>
  var r = FRS.compile('fn main() { println!("hi"); }', { file: 'main.rs' });
  console.log(r.stdout);
</script>
```

Open `index.html` for a ready-made playground. In the browser there is no real
filesystem/network — those calls degrade to `Err(..)` results, matching
sandboxed environments.

## CLI

```
Usage: frs <file.rs> [options]
  --lib          library mode (no `fn main` required)
  --check-only   only check, do not run
  --no-color     disable colors
  --no-warnings  hide warnings
  -o <file>      accepted for rustc-compat, ignored
  --version      print version
```

Exit codes: `0` clean run, `1` compile error, `101` runtime panic (like Rust).

## Cargo-like package manager (`src/pm.js`)

```sh
frs new <name>            # create a new project (Cargo.toml + src/main.rs)
cd <name>
frs check                 # syntax/type check only (no run)
frs build                 # fetch + compile deps, then check the crate
frs run                   # build, then execute src/main.rs
```

`[dependencies]` in `Cargo.toml` are downloaded from
`https://crates.io/api/v1/crates/<name>/<version>/download` (one request per
dep total, cached), extracted to `frs_target/registry/src/<name>-<version>/`,
compiled (syntax/type checked by our own engine), and the artifact is cached as
`frs_target/deps/<name>-<version>.json`. Re-runs reuse it (`Fresh` line).
Version reqs support `"*"`, `"^1"`, `"1.2"`, `"=1.2.3"`. Features arrays are
parsed and stored on the artifact. Build messages are cargo-flavored
(`Downloading`, `Compiling`, `Finished`, `Running`).

## What it checks (current rules)

| id | rustc code | what |
|----|-----------|------|
| R001 | E0765 | unbalanced `{}()` / stray closer |
| R002 | — | missing `;` after `let` / assignment / `use` |
| R003 | E0425 | `let` without a binding name |
| R004 | — | `fn` without a name |
| R006 | — | unterminated `"string"` |
| R007 | — | bad/unterminated `'char'` |
| R008 | — | unterminated `/* comment` |
| R010 | — | `fn`/`if`/`for`/`while`/`loop`/`match` missing `{` |
| R012 | — | `use …` missing `;` |
| R014 | — | `println(…)` missing `!` |
| R015 | — | `else` without `if` |
| R018 | — | `->` without a return type |
| R020 | — | unclosed `#[attr]` |
| R021 | — | missing `fn main` (binary mode) + bad `main` args |
| R022 | E0599 | *(reserved placeholder)* |
| T001/T002 | E0308 | `let x: T = v` / reassignment type mismatch |
| T003 | E0384 | assign to immutable `let` (needs `mut`) |
| T004 | E0425 | use of undeclared variable / unknown function |
| T005 | E0412 | unknown type annotation |
| T007 | E0107 | wrong arg count on `fn` call |
| T013 | — | `println!`/`format!` placeholder ↔ arg mismatch |
| T015/T016 | — | `break`/`continue` outside loop, `return` outside `fn` |
| T017 | E0255 | duplicate `fn` name |
| W001/W002/W003 | — | unused var / unused fn / `mut` never mutated |

Type inference is intentionally simple: literals (`5`→`int-lit` fits any int,
`"…"`→`&str`, `b"…"`→`&[u8]`, `'…'`→`char`, `true`→`bool`), `vec![…]`→`Vec<_>`,
`format!`/`to_string`/`String::from`→`String`, plus one-level var lookup.
Unknown types never error (no false positives on complex expressions).

### Syntax it accepts

`structures`: `struct`/`enum` (incl. fieldless + discriminants), `impl`/
`trait` blocks, `type` aliases, `const`/`static`, `union`-less `mod` and
`macro_rules!` blocks, attributes `#[..]`/`#![..]` (skipped, not code).

`items inside fns`: `let`/patterns `let (a, b) = …`, `if let`/`while let`,
destructuring match arms, struct literals `Self { .. }` / field init shorthand,
closures `|x|`, `async`/`await` keywords pass through, raw strings `r#"…"#`,
byte strings `b"…"`, nested `use` trees with braces/aliases, generics incl.
`where` clauses, `<S: Type>` generics, lifetimes, `unsafe` blocks.

### Runtime features (interpreter.js)

(fake side effects where noted; *real* side effects run through Node)

- Output: `println!`/`print!`/`eprintln!`/`eprint!` with `{}`, `{:?}`, `{:.2}`,
  positional `{0}`, named `{x}`, inline captures.
- Macros: `format!`, `vec![…]`, `vec![x; n]`, users `macro_rules!` (`$name:expr`
  params, first-match-of-arity transcribers), `panic!`, `assert[_eq/_ne]`,
  `todo!`, `unreachable!`.
- Data: structs/enums/tuple structs, `Option`/`Result` created by constructors,
  `Vec`, arrays incl. `[0; 1024]`, ranges, indexing `v[i]`, slices `v[..n]` /
  `v[a..b]` / `v[a..=b]`.
- Control: `if/else` (else-if chains), `match` with guard-less patterns,
  `for`, `loop`, `while`, break/continue, `return`, recursion (step-capped).
- Traits/impls: `Type::new`, `Type::method`, blanket shapes, `Self` rebash,
  `Display` methods live as `Type::fmt` and are used indirectly.
- Try: `?` on `Result`/`Option` (Err/None throws `__frsTryErr` and is returned
  from the enclosing fn).
- **fs (real)**: `File::create`, `File::open`, `OpenOptions::append/open`,
  `fs::read_to_string`, `fs::write`, `fs::remove_file`, `write!`/`writeln!`
  to files via fd, `BufReader::lines`.
- **io (real)**: stdin (`io::stdin().read_line(&mut buf)`), stdout/stderr
  printing, `io::stdout().flush()`.
- **net (real)**: `TcpListener::bind("127.0.0.1:PORT")` starts a real Node
  server; the loop body of `for stream in listener.incoming() { ... }` is
  executed per connection; `accept`/`incoming`/`local_addr` supported;
  `stream.read(&mut buf)` and `stream.write_all(b"..")` work on the socket.
- **buffers (real)**: `b"..."` literals, `u8` arrays, `as_bytes()`,
  `&[u8]` slicing, `String::from_utf8_lossy`.

## How to add a new rule (2 minutes)

All rules live in **`src/rules.js`** as data. The checker in
`src/checker.js` exposes everything through a `ctx` object — you never edit
the scan loop.

**1. Add one entry to `RULES`:**

```js
{
  id: 'T020',            // R*=syntax, T*=type, W*=warning
  code: 'E0599',         // rustc code or null
  level: 'error',        // 'error' | 'warning'
  anchor: 'call',        // WHERE it runs (see table below)
  name: 'no-foo-call',
  desc: 'Forbids calling foo().',
  check: function (ctx) { return ctx.checkNoFoo(); }
},
```

**Anchors** (pick the one closest to your check):

| anchor | `ctx.current` is… | good for |
|--------|-------------------|----------|
| `eof` | `null` (whole file) | unbalanced delimiters, missing main, unused vars |
| `stmt` | `let`/`fn`/`use`/`assign`/keyword stmt node | `;`, `{`, `!`, `->` |
| `decl` | a `let` node `{name, isMut, ann, valToks, …}` | type/unknown-type checks |
| `assign` | an `x = …` node `{name, valToks, …}` | mutability, type drift |
| `call` | a `foo(…)` node `{name, argCount, isMethod, …}` | arg counts, unknown fns |
| `macro` | a `name!(…)` node `{name, fmtStr, argCount, placeholders}` | format-string checks |
| `keyword` | a `break`/`continue`/`return`/`else` node | context checks |

**2. Implement the check** — inline or as a `ctx.checkX` method in
`src/checker.js`:

```js
ctx.checkNoFoo = function () {
  var n = ctx.current;
  if (n && n.name === 'foo') {
    return {
      msg: 'do not call `foo`',
      line: n.line, col: n.col,
      spanLen: n.name.length,
      label: 'forbidden call',
      hint: 'call `bar()` instead',
      // note: 'extra info',
    };
  }
  return null; // pass
};
```

Return `null` (pass), one object, or an array. `level`/`code` default to the
`RULES` entry; override per-diagnostic with `level`/`_code` fields if needed.

**3. Helpers available on `ctx`:**

```js
ctx.toks, ctx.lets, ctx.assigns, ctx.calls, ctx.macros, ctx.kws
ctx.fns          // {name: {params, ret, used, line, col, count}}
ctx.structs      // user-defined type names
ctx.identUses    // every variable read {name, idx, line, col}
ctx.bindingFor(name, useIdx)   // latest `let` visible at a use
ctx.infer(valToks, byName, useIdx, structs) // -> 'i32'|'&str'|'int-lit'|…
ctx.compat(ann, actual)        // generic-lit-aware equality
ctx.stack / ctx.strayCloses
ctx.lexErrs      // lexer problems
ctx.loopRanges / ctx.fnRanges
ctx.insideRanges(ranges, idx)
```

**Performance rules** (keeps `frs` extreme-fast):

- Return `null` on the fast path with zero allocation (compare cheap fields first).
- Never regex/slice the source in `check` — use pre-lexed `ctx.toks`.
- Prefer `stmt`/`decl` anchors over `eof` re-scans.
- Add your rule id in `checker.js → applies()` if it only applies to a subset
  of its anchor's nodes.

**4. Test it** — add a line in `tests/run.js`:

```js
t('no foo', 'fn main() { foo(); }', { ok: false, errContains: 'do not call `foo`' });
```

```sh
npm test
```

## Architecture notes (for contributors)

- **Tokens** are `{ t, v, idx, line, col, pos }`; `t` is one of
  `IDENT=1, NUMBER=2, STRING=3, CHAR=4, SYMBOL=5, LIFETIME=6, RAWSTR=7, BYTESTR=8`.
- **Checker**: single token walk gathers `lets/assigns/calls/macros/kws/fns/
  structs/loopRanges/fnRanges`, then runs RULES per anchor. Diagnostics are
  sorted once emitted.
- **Interpreter**: token-slice evaluator (`execBlock`/`execExprStmt`/`evalExpr`),
  caps: `MAX_STEPS=200000`, `MAX_LOOP=10000`, `MAX_OUT=20000`. Method calls
  on structs dispatch through `qns[Type::method]`; real-world side effects are
  gated by `FS_X`/`NET_X` (`require('fs')`/`require('net')` under Node, `null`
  in browsers).
- **Package manager**: `src/pm.js` uses only `fs`, `path`, `https`,
  `child_process` (for `tar -xzf`). All deps are checked by this same engine.

## Honest limitations

Fake compiler: shallow inference (complex exprs → `unknown` → pass), no borrow
checker, traits are namespaced by `Type::method` only (no dynamic-dispatch
trait objects), closures evaluate as names, async forms don't run, and hitting
the step limit produces `thread 'main' panicked at 'frs: execution limit
exceeded'`. Error messages match rustc in *shape*, but coverage is not 1:1.
These are deliberate so users get rustc *feelings* without the Rust toolchain.

## Contributing / Contact

This project is `frs` under MIT — pull requests welcome.

If something is missing (an enum pattern it can't use, a macro knot it chokes
on, a dependency that won't get fetched, a wrong span), please try to fix it —
a rule entry in `src/rules.js` plus a line in `tests/run.js` is most of the
work. If you're not able to fix it yourself, contact us and we'll do it.

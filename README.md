# frs — extreme-fast fake Rust compiler in pure JavaScript

`frs` doesn't really compile anything. It **checks** Rust code (syntax + simple
types) and prints errors **exactly like `rustc`**, then **fakes the program
output** (runs `println!`, `for`, `if`, `fn`, `vec!`, … in JS).

- **Zero dependencies, pure JS** — runs in Node *and* browsers (`index.html` demo).
- **Fast** — single-pass lexer + single-pass checker, `O(n)`, no regex in hot
  loops, int-enum tokens, precomputed line map, allocation-free rule pass.
- **rustc-like output** — `error[E0308]: …`, `--> main.rs:2:5`, caret spans,
  `help:`/`note:`, abort footer, panic format, TTY colors.
- **Rule table** — every check is one declarative entry in `src/rules.js`.
  Adding a check = adding one object. Nothing else to touch.

```
frs/
  src/
    util.js         char tables, line map, colors
    lexer.js        single-pass tokenizer (strings, chars, comments, numbers)
    diagnostics.js rustc-style renderer
    rules.js        *** THE RULE TABLE — declare checks here ***
    checker.js      one-pass syntax+type checker, runs RULES
    interpreter.js  fake runtime (println!/format!/vars/loops/fns/match)
    frs.js          core engine: compile(src, opts) -> {stderr, stdout, ...}
  bin/frs(.js)      CLI (rustc-like flags)
  examples/         hello.rs, error_demo.rs, advanced.rs
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
console.log(r.stdout);  // fake program output
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

Open `index.html` for a ready-made playground.

## CLI

```
Usage: frs <file.rs> [options]
  --lib          library mode (no `fn main` required)
  --check-only   only check, do not run
  --no-color     disable colors
  --no-warnings  hide warnings
  -o <file>      accepted for rustc-compat, ignored
```

Exit codes: `0` clean run, `1` compile error, `101` runtime panic (like Rust).

## Cargo-like package manager

```sh
frs new <name>            # create a new project (Cargo.toml + src/main.rs)
cd <name>
frs check                 # syntax/type check only (no run)
frs build                 # fetch + compile deps, then check the crate, cache in frs_target/
frs run                   # does what `frs build` does, then runs src/main.rs
```

`[dependencies]` in `Cargo.toml` are downloaded from
`https://crates.io/api/v1/crates/<name>/<version>` (needs network once per
dep), extracted to `frs_target/registry/src/<name>-<version>/`, compiled
(checked) with our own engine, and cached as `frs_target/deps/<name>-<version>.json`
so they are not recompiled all the time. Version reqs support `"*"`, `"^1"`,
`"1.2"`, `"=1.2.3"`. Build flags/messages and rerun-only-once behavior are
cargo-flavored; the dependency resolver is intentionally simple but real.

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
| R022 | E0599 | *(reserved placeholder — struct-literal rule goes here)* |
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
`"…"`→`&str`, `'…'`→`char`, `true`→`bool`), `vec![…]`→`Vec<_>`,
`format!`/`to_string`/`String::from`→`String`, plus one-level var lookup.
Unknown types never error (no false positives on complex expressions).

## Fake runtime support

`println!`/`print!`/`eprintln!`/`eprint!` (with `{}`, `{:?}`, `{:.2}`,
positional `{0}`, named `{x}` + inline captures), `format!`, `vec![…]` /
`vec![x; n]`, arrays, `String::from`/`.to_string()`/`.len()`/`.parse()`,
integers/floats/bools/chars/strings, `+ - * / % == != < > && ||`,
`&`/`!`/`-`, ranges `0..3`/`0..=3`, `if/else`, `for x in …`, `while`/`loop`
(with `break`/`continue`, capped at 10k iters), `match` (literals/`_`/
bindings/ranges/`Ok`/`Some`-style ctors), user `fn` (params, `return`,
recursion via step cap), `panic!`/`assert*!`/`todo!`/`unreachable!`,
`+= -= *= /= %=`. Output goes to `stdout`; panics render like
`thread 'main' panicked at '…', main.rs:L:C`.

## How to add a new rule (2 minutes)

All rules live in **`src/rules.js`** as data. The checker in
`src/checker.js` exposes everything through a `ctx` object — you never edit
the scan loop.

**1. Add one entry to `RULES`:**

```js
{
  id: 'T020',            // your new id (R*=syntax, T*=type, W*=warning)
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

**2. Implement the check** — either inline or as a `ctx.checkX` method in
`src/checker.js` next to the others:

```js
ctx.checkNoFoo = function () {
  var n = ctx.current;
  if (n && n.name === 'foo') {
    return {
      msg: 'do not call `foo`',          // after `error: `
      line: n.line, col: n.col,           // span start
      spanLen: n.name.length,             // caret width
      label: 'forbidden call',            // after carets
      hint: 'call `bar()` instead',       // `help: …` (optional)
      // note: 'extra info',             // `note: …` (optional)
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
ctx.bindingFor(name, useIdx)   // latest `let` visible at a use (shadowing-aware)
ctx.infer(valToks, byName, useIdx, structs) // -> 'i32' | '&str' | 'int-lit' | …
ctx.compat(ann, actual)        // generic-lit-aware equality
ctx.stack        // leftover open delimiters; ctx.strayCloses for stray closers
ctx.lexErrs      // lexer problems (unterminated string/comment/char)
ctx.loopRanges / ctx.fnRanges  // token ranges (for break/return checks)
ctx.insideRanges(ranges, idx)  // is a node inside a loop/fn body?
```

**Performance rules** (keeps `frs` extreme-fast):

- Return `null` on the fast path with zero allocation (compare cheap fields first).
- Never regex/slice the source in `check` — use the pre-lexed `ctx.toks`.
- `eof`-anchor rules run once; prefer `stmt`/`decl` anchors over re-scanning.
- See `checker.js → applies()` — add your rule id there if it only applies to a
  subset of its anchor's nodes (avoids useless calls).

**4. Test it** — add a line in `tests/run.js`:

```js
t('no foo', 'fn main() { foo(); }', { ok: false, errContains: 'do not call `foo`' });
```

```sh
npm test
node bin/frs.js examples/error_demo.rs
```

## Speed notes

- Lexer: one `charCodeAt` loop, table-driven char classes, `indexOf` fast-path
  for raw strings, incremental line/col (no per-token binary search).
- Checker: one token walk builds lets/assigns/calls/macros/ranges; each rule is
  `O(nodes-of-its-anchor)`; diagnostics sorted once at the end.
- Interpreter: statement splitter + Pratt-lite evaluator, capped steps/loops/
  output so hostile inputs can't hang the page.

## Honest limitations

This is a *fake* compiler: no borrow checker, no traits/generics resolution, no
macros beyond the built-ins, and type inference is shallow by design (complex
expressions yield `unknown` and pass). Error messages are simple on purpose —
`expected X, found Y` + `help:` — not full rustc suggestions. Anything it can't
prove is passed silently to avoid false positives.

# frs — High-Performance JavaScript-Based Rust Environment
frs is an execution and analysis environment written entirely in JavaScript. Rather than compiling to machine code, frs performs single-pass syntax and type validation matching rustc diagnostics, then executes programs through a managed runtime with native Node.js support for I/O operations including filesystem access, sockets, and standard streams. It operates with zero build steps, zero native bindings, and zero external npm dependencies.
 * **Zero Dependencies & Pure JS** — Runs seamlessly in Node.js environments and browser contexts (index.html).
 * **High Performance** — Designed with O(n) single-pass lexing and validation, linear token processing with integer enums, precomputed line mappings, and zero-allocation execution paths.
 * **rustc-Compatible Diagnostics** — Renders identical output structures (error[E0308]: …, --> main.rs:2:5, caret spans, help:/note: annotations, abort footers, panics, and TTY color output).
 * **Declarative Rule Engine** — All diagnostic validation logic resides in src/rules.js. Adding new checks requires defining a single configuration object.
 * **Cargo-Compatible Workflow** — Supports frs new, build, run, and check, featuring native Cargo.toml parsing along with dependency resolution, extraction, compilation, and artifact caching from crates.io.
 * **Native Side Effects (Node.js)** — Supports system-level I/O operations including File::create/open, read_to_string, writeln!, standard input reading, TcpListener::bind network server sockets, and binary buffer management via byte strings and slices (b"...", &[u8]).
## Directory Structure
```
frs/
  src/
    util.js         Character utilities, line mapping, and formatting options
    lexer.js        Single-pass lexical analyzer supporting byte strings and literals
    diagnostics.js  Rustc-compliant diagnostic output generator
    rules.js        Declarative validation rule configurations
    checker.js      Single-pass syntax and type validation engine
    interpreter.js  Runtime execution engine (I/O, formatting, control flow, traits)
    frs.js          Core compilation pipeline API: compile(src, opts)
    pm.js           Package management module for project setup and dependency management
  bin/frs(.js)      CLI interface supporting standard flags and subcommands
  examples/         Sample applications ranging from basic scripts to socket servers
  tests/run.js      Zero-dependency test suite runner (`npm test`)
  index.html        Browser-based interactive demo interface

```
## Quick Start
```sh
node bin/frs.js examples/hello.rs
node bin/frs.js examples/error_demo.rs   # Displays rustc-style diagnostics
npm test

```
### Programmatic Usage (Node.js)
```js
const FRS = require('./src/frs.js');
const result = FRS.compile('fn main() { println!("hi {}", 1); }', { file: 'main.rs' });

console.log(result.stderr);  // Diagnostic output (empty string if valid)
console.log(result.stdout);  // Program execution output
console.log(result.success, result.timeMs + 'ms');

```
### Browser Execution
```html
<script src="src/util.js"></script>
<script src="src/lexer.js"></script>
<script src="src/diagnostics.js"></script>
<script src="src/rules.js"></script>
<script src="src/checker.js"></script>
<script src="src/interpreter.js"></script>
<script src="src/frs.js"></script>
<script>
  var result = FRS.compile('fn main() { println!("hi"); }', { file: 'main.rs' });
  console.log(result.stdout);
</script>

```
Open index.html to launch the browser playground. When executing inside a sandboxed browser context without access to native filesystem or network sockets, non-supported operations gracefully evaluate to Err(..) structures.
## Command Line Interface
```
Usage: frs <file.rs> [options]
  --lib          Library compilation mode (omits main function requirement)
  --check-only   Perform syntax and type validation without execution
  --no-color     Disable terminal color rendering
  --no-warnings  Suppress diagnostic warning outputs
  -o <file>      Retained for rustc CLI compatibility (ignored)
  --version      Display package version information

```
**Exit Codes:** 0 on successful execution, 1 on compilation errors, and 101 on runtime panics.
## Package Management (src/pm.js)
```sh
frs new <name>            # Initialize a workspace with Cargo.toml and src/main.rs
cd <name>
frs check                 # Execute syntax and type checking
frs build                 # Download dependencies, compile packages, and validate
frs run                   # Build workspace and execute target application

```
Dependencies declared in [dependencies] within Cargo.toml are fetched from [https://crates.io/api/v1/crates/](https://crates.io/api/v1/crates/)<name>/<version>/download, extracted into frs_target/registry/src/<name>-<version>/, validated using the static analysis engine, and cached under frs_target/deps/<name>-<version>.json. Subsequent invocations reference existing build artifacts (Fresh). Version requirements support standard ranges including "*", "^1", "1.2", and "=1.2.3". Feature flags are processed during artifact generation, and build logs follow standard Cargo operational status messages (Downloading, Compiling, Finished, Running).
## Static Analysis Rules
| Identifier | Diagnostic Code | Target Check Description |
|---|---|---|
| R001 | E0765 | Unbalanced delimiter pairings ({}()) or unexpected closing tokens |
| R002 | — | Missing semicolon following let, assignments, or use statements |
| R003 | E0425 | Variable declaration lacking binding identifier |
| R004 | — | Function definition lacking identifier |
| R006 | — | Unterminated double-quoted string literal |
| R007 | — | Malformed or unterminated character literal |
| R008 | — | Unterminated block comment (/*) |
| R010 | — | Missing block opening { for fn, if, for, while, loop, or match |
| R012 | — | Missing semicolon following use directive |
| R014 | — | Missing macro exclamation mark on println call |
| R015 | — | Orphaned else branch without preceding if statement |
| R018 | — | Return type arrow (->) missing target type definition |
| R020 | — | Unclosed attribute macro (#[attr]) |
| R021 | — | Missing fn main entry point or invalid signature parameters |
| R022 | E0599 | Reserved rule placeholder |
| T001/T002 | E0308 | Type mismatch in let initialization or reassignments |
| T003 | E0384 | Reassignment to immutable variable (requires mut binding) |
| T004 | E0425 | Reference to undeclared variable or undefined function |
| T005 | E0412 | Unrecognized type annotation |
| T007 | E0107 | Incorrect argument count provided to function call |
| T013 | — | Mismatch between macro placeholders and supplied arguments |
| T015/T016 | — | Invalid placement of break/continue or return statements |
| T017 | E0255 | Duplicate function definition within scope |
| W001/W002/W003 | — | Unused variable, unused function, or unmutated mut binding warnings |
Type inference evaluates standard primitives (5 \to int-lit, "..." \to &str, b"..." \to &[u8], '...' \to char, true \to bool), macro initializations (vec![...] \to Vec<_>, format!/to_string/String::from \to String), and single-level variable bindings. Ambiguous type expressions are safely bypassed to prevent false-positive diagnostic reports.
### Supported Language Syntax
 * **Structures:** Declarations for struct, enum (including discriminants and fieldless variants), impl and trait blocks, type aliases, const/static declarations, mod structures, macro_rules! blocks, and outer/inner attribute annotations (#[..], #![..]).
 * **Statements & Expressions:** Variable patterns (let (a, b) = ...), pattern matching constructs (if let, while let, destructuring match arms), struct initialization patterns (Self { .. }), closures (|x|), keyword syntax (async/await), raw strings (r#"..."#), byte strings (b"..."), nested import trees, generic type signatures (including where clauses and lifetime parameters), and unsafe blocks.
### Runtime Engine Capabilities (interpreter.js)
 * **Standard I/O Formatting:** println!, print!, eprintln!, and eprint! with support for display {} and debug {:?} specifications, alignment parameters {:.2}, positional indexes {0}, named references {x}, and variable capture syntax.
 * **Built-in Macros:** Support for format!, vec![...], vec![x; n], user-defined macro_rules! (evaluating $name:expr bindings and pattern matching variants), panic!, assertion macros (assert!, assert_eq!, assert_ne!), todo!, and unreachable!.
 * **Data Types & Structures:** Structs, enums, tuple variants, Option and Result constructors, dynamic Vec structures, fixed-size arrays ([0; 1024]), numeric ranges, indexing operations (v[i]), and slices (v[..n], v[a..b], v[a..=b]).
 * **Control Flow Logic:** Standard branching (if/else), match expression evaluation, iteration construct loops (for, loop, while), control interruptions (break, continue, return), and recursion depth validation.
 * **Traits & Implementations:** Associated functions (Type::new), method dispatch (Type::method), static trait implementations, structural bindings (Self), and indirect Display execution using Type::fmt.
 * **Error Propagation:** Early return handling with the ? operator on Result and Option primitives.
 * **Native File Operations:** Full implementation for File::create, File::open, OpenOptions, fs::read_to_string, fs::write, fs::remove_file, write!/writeln! file operations, and BufReader::lines.
 * **Native System Stream Operations:** Standard input stream reading (io::stdin().read_line(&mut buf)), system output routing, and manual flushing (io::stdout().flush()).
 * **Native Networking Sockets:** Server creation via TcpListener::bind("127.0.0.1:PORT"), connection polling with for stream in listener.incoming(), and read/write stream handling on connected client sockets.
 * **Binary Data Operations:** Direct byte literal evaluations (b"..."), unsigned 8-bit array handling, as_bytes() conversions, slice referencing, and UTF-8 string conversions via String::from_utf8_lossy.
## Adding Custom Validation Rules
Rules are declared as structured configuration objects in **src/rules.js**. Static analysis queries are dispatched through the unified context object (ctx) inside src/checker.js.
### 1. Register Rule Entry (src/rules.js)
```js
{
  id: 'T020',            // Prefix designation: R* (syntax), T* (type), W* (warning)
  code: 'E0599',         // Corresponding rustc E-code identifier or null
  level: 'error',        // Severity classification: 'error' | 'warning'
  anchor: 'call',        // Execution scope anchor point
  name: 'no-foo-call',
  desc: 'Forbids calling foo().',
  check: function (ctx) { return ctx.checkNoFoo(); }
},

```
#### Available Scope Anchors
| Anchor Name | Node Structure (ctx.current) | Typical Usage |
|---|---|---|
| eof | null (entire file sweep) | Unmatched delimiters, entry point validation, unused components |
| stmt | Statement node (let, fn, use, assign) | Syntax structure, delimiters, type markers |
| decl | Declaration node ({name, isMut, ann, valToks}) | Type matching and binding verification |
| assign | Assignment node ({name, valToks}) | Reassignment type evaluation and mutability flags |
| call | Invocation node ({name, argCount, isMethod}) | Parameter signature and target check verification |
| macro | Macro invocation node ({name, fmtStr, argCount}) | Format argument matching and string validation |
| keyword | Keyword statement node (break, continue, return) | Execution context scope verification |
### 2. Implement Rule Logic (src/checker.js)
```js
ctx.checkNoFoo = function () {
  var node = ctx.current;
  if (node && node.name === 'foo') {
    return {
      msg: 'do not call `foo`',
      line: node.line, col: node.col,
      spanLen: node.name.length,
      label: 'forbidden call',
      hint: 'call `bar()` instead',
    };
  }
  return null; // Diagnostic checks pass
};

```
Return null on successful checks, or supply a diagnostic report object (or array of objects). Diagnostic properties default to configured RULES values unless overridden directly.
### 3. Execution Context Helper API (ctx)
```js
ctx.toks, ctx.lets, ctx.assigns, ctx.calls, ctx.macros, ctx.kws
ctx.fns          // Object registry: {name: {params, ret, used, line, col, count}}
ctx.structs      // User-defined data types registry
ctx.identUses    // Sequential identifier references: {name, idx, line, col}
ctx.bindingFor(name, useIdx)   // Resolves active variable declaration for reference position
ctx.infer(valToks, byName, useIdx, structs) // Evaluates type signature ('i32', '&str', etc.)
ctx.compat(ann, actual)        // Type equivalence comparison helper
ctx.stack / ctx.strayCloses
ctx.lexErrs      // Tokenizer error collection
ctx.loopRanges / ctx.fnRanges
ctx.insideRanges(ranges, idx)

```
#### Performance Guidelines
 * Perform cheap structural evaluations first to ensure zero-allocation execution paths on passing checks.
 * Avoid source string slicing or regex operations inside check invocations; process token structures via ctx.toks.
 * Prefer explicit statement or declaration anchors over complete source sweeps (eof).
 * Filter target node evaluations inside checker.js -> applies() for checks restricted to precise anchor subsets.
### 4. Integration Verification
Add test assertions directly within tests/run.js:
```js
t('no foo', 'fn main() { foo(); }', { ok: false, errContains: 'do not call `foo`' });

```
```sh
npm test

```
## System Architecture
 * **Token Representation:** Tokens are structured as { t, v, idx, line, col, pos }, using enumerated type tags (IDENT=1, NUMBER=2, STRING=3, CHAR=4, SYMBOL=5, LIFETIME=6, RAWSTR=7, BYTESTR=8).
 * **Static Checker Pipeline:** A single token pass collects scope structures (lets/assigns/calls/macros/kws/fns/structs/loopRanges/fnRanges) and evaluates declarative rules matching registered anchors. Emitted diagnostics are sorted chronologically.
 * **Runtime Execution:** Token-stream evaluation (execBlock/execExprStmt/evalExpr) executes under configured safety bounds (MAX_STEPS=200000, MAX_LOOP=10000, MAX_OUT=20000). Struct method calls dispatch via qns[Type::method]. Native side-effect execution switches conditionally based on host environment availability (require('fs')/require('net') under Node.js, null inside browser contexts).
 * **Package Management Subsystem:** src/pm.js utilizes standard Node.js APIs (fs, path, https, child_process). Remote packages are fetched, extracted, and verified using the core analysis engine.
## Operational Constraints
frs is an execution engine focused on rapid validation and portable execution rather than full compiler parity:
 * Type inference uses shallow evaluations; complex expressions evaluate to unknown without throwing false positives.
 * Borrow checking and lifetime validations are omitted.
 * Trait dispatch is namespaced via static bindings (Type::method) without dynamic vtable dispatch.
 * Closures evaluate in local contexts, and asynchronous execution workflows pass without native runtime yield scheduling.
 * Reaching defined execution step limits generates standard execution panics (thread 'main' panicked at 'frs: execution limit exceeded').
Diagnostic output mirrors rustc structural conventions to provide an authentic developer experience without requiring native build chain installations.
## Contribution Guidelines
Contributions to frs are welcome under the terms of the MIT License. Feature additions, diagnostic coverage improvements, edge-case fixes, and package manager enhancements are encouraged via Pull Requests.

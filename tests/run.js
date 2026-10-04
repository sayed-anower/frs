'use strict';
/* frs tests — zero deps, run with: node tests/run.js */
var path = require('path');
var FRS = require(path.join(__dirname, '..', 'src', 'frs.js'));

var passed = 0, failed = 0;
function t(name, src, want) {
  var r = FRS.compile(src, { file: 'main.rs', run: true });
  var ok = true, why = '';
  if (want.ok !== undefined && r.compileOk !== want.ok) { ok = false; why = 'compileOk=' + r.compileOk + ' want ' + want.ok; }
  if (want.stdout !== undefined && r.stdout !== want.stdout) { ok = false; why += ' stdout=' + JSON.stringify(r.stdout) + ' want ' + JSON.stringify(want.stdout); }
  if (want.errContains && !(r.stderr || '').includes(want.errContains)) { ok = false; why += ' stderr missing ' + JSON.stringify(want.errContains) + ' got:\n' + r.stderr; }
  if (want.noErr && r.errCount !== 0) { ok = false; why += ' expected 0 errors, got ' + r.errCount + ':\n' + r.stderr; }
  if (ok) { passed++; console.log('ok - ' + name); }
  else { failed++; console.log('FAIL - ' + name + ' :: ' + why); }
}

t('hello', 'fn main() { println!("hi"); }', { ok: true, stdout: 'hi\n' });
t('format positional', 'fn main() { let x = 5; println!("{}", x); }', { ok: true, stdout: '5\n' });
t('format two args', 'fn main() { println!("{}-{}", 1, 2); }', { ok: true, stdout: '1-2\n' });
t('for range', 'fn main() { for i in 0..3 { print!("{} ", i); } }', { ok: true, stdout: '0 1 2 ' });
t('while', 'fn main() { let mut i = 0; while i < 3 { print!("{}", i); i += 1; } }', { ok: true, stdout: '012' });
t('arith', 'fn main() { println!("{}", 2 + 3 * 4); }', { ok: true, stdout: '14\n' });
t('if/else', 'fn main() { if true { println!("y"); } else { println!("n"); } }', { ok: true, stdout: 'y\n' });
t('match', 'fn main() { let n = 2; match n { 1 => println!("a"), 2 => println!("b"), _ => println!("c"), } }', { ok: true, stdout: 'b\n' });
t('fn call', 'fn add(a: i32, b: i32) -> i32 { a + b } fn main() { println!("{}", add(2, 3)); }', { ok: true, stdout: '5\n' });
t('vec debug', 'fn main() { let v = vec![1, 2]; println!("{:?}", v); }', { ok: true, stdout: '[1, 2]\n' });
t('panic', 'fn main() { panic!("boom"); }', { ok: true }); // compiles, panics at runtime
t('type mismatch', 'fn main() { let x: i32 = "hi"; }', { ok: false, errContains: 'mismatched types' });
t('missing semi', 'fn main() { let x = 5 }', { ok: false, errContains: 'expected `;`' });
t('println bang', 'fn main() { println("hi"); }', { ok: false, errContains: 'missing `!`' });
t('undeclared var', 'fn main() { println!("{}", zzz); }', { ok: false, errContains: 'cannot find value `zzz`' });
t('immutable assign', 'fn main() { let x = 1; x = 2; }', { ok: false, errContains: 'immutable' });
t('unbalanced', 'fn main() { if true { println!("x"); }', { ok: false, errContains: 'mismatched closing delimiter' });
t('unterminated string', 'fn main() { let s = "abc; }', { ok: false, errContains: 'unterminated string' });
t('missing main', 'fn foo() {}', { ok: false, errContains: '`main` function not found' });
t('arg count', 'fn f(a: i32, b: i32) {} fn main() { f(1); }', { ok: false, errContains: 'takes 2 argument' });
t('break outside', 'fn main() { break; }', { ok: false, errContains: 'outside of a loop' });
t('unknown type', 'fn main() { let x: Izz32 = 5; println!("{}", x); }', { ok: false, errContains: 'cannot find type' });
t('struct field', 'struct P { x: i32 } fn main() { let p = P { x: 7 }; println!("{}", p.x); }', { ok: true, stdout: '7\n' });
t('closure', 'fn main() { let f = |x: i32| x + 1; println!("{}", f(1)); }', { ok: true, stdout: '2\n' });
t('if let', 'fn main() { let o = Some(3); if let Some(v) = o { println!("{}", v); } }', { ok: true, stdout: '3\n' });
t('named fmt arg', 'fn main() { let x = 1; println!("{x}", x = 2); }', { ok: true, stdout: '2\n' });
t('inline capture', 'fn main() { let x = 42; println!("{x}"); }', { ok: true, stdout: '42\n' });
t('else without if', 'fn main() { else { } }', { ok: false, errContains: '`else` without `if`' });
t('arrow needs type', 'fn f() -> { 1 } fn main() {}', { ok: false, errContains: 'expected a type after `->`' });
t('return outside fn', 'fn main() {} return 1;', { ok: false, errContains: '`return` outside of a function' });
t('missing main args', 'fn main(x: i32) {}', { ok: false, errContains: 'must take no arguments' });
t('duplicate fn', 'fn a() {} fn a() {} fn main() {}', { ok: false, errContains: 'defined multiple times' });
t('format mismatch', 'fn main() { println!("{} {}", 1); }', { ok: false, errContains: 'format string needs 2' });
t('char too long', "fn main() { let c = 'ab'; }", { ok: false, errContains: 'single character' });
t('raw string', 'fn main() { let s = r#"a"b"#; println!("{}", s); }', { ok: true, stdout: 'a"b\n' });
t('block comment', 'fn main() { /* nested /* x */ still */ println!("ok"); }', { ok: true, stdout: 'ok\n' });
t('impl methods ok', 'struct A; impl A { fn new() -> i32 { 1 } fn new2() -> i32 { 2 } } fn main() { println!("{} {}", A::new(), A::new2()); }', { ok: true, stdout: '1 2\n' });
t('op assign', 'fn main() { let mut x = 1; x += 2; x *= 3; println!("{}", x); }', { ok: true, stdout: '9\n' });
t('shadowing', 'fn main() { let x = 1; let x = "s"; println!("{}", x); }', { ok: true, stdout: 's\n' });
t('nested use tree', 'use std::collections::{HashMap, HashSet}; fn main() { let h: HashMap<i32, i32> = HashMap::new(); let s = HashSet::new(); }', { ok: true });
t('attribute derive', '#[derive(Debug)] struct P; fn main() {}', { ok: true });
t('static & const', 'static C: AtomicUsize = AtomicUsize::new(0); const N: i32 = 3; fn main() {}', { ok: true });
t('type alias', 'type R<T> = Vec<T>; fn main() {}', { ok: true });
t('pattern let', 'fn main() { let (a, b) = (1, 2); println!("{}", a + b); }', { ok: true, stdout: '3\n' });
t('macro_rules interp', 'macro_rules! m { ($x:expr) => { $x + 1 }; } fn main() { println!("{}", m!(1)); }', { ok: true, stdout: '2\n' });
t('if let no false else-err', 'fn main() { let x = Some(1); if let Some(v) = x { println!("{}", v); } else { println!("n"); } }', { ok: true, stdout: '1\n' });
t('parse.rs syntax', 'fn f<S: Into<String>>(s: S) -> String { S::from(s) } fn main() {}', { ok: true });

console.log('\n' + passed + ' passed, ' + failed + ' failed');

// ---- browser compat: load every src/*.js in a `module`-less vm sandbox ----
(function () {
  try {
    var vm = require('vm');
    var fs = require('fs');
    var sandbox = {};
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    ['util.js', 'lexer.js', 'diagnostics.js', 'rules.js', 'checker.js', 'interpreter.js', 'frs.js']
      .forEach(function (f) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), sandbox, { filename: f });
      });
    var r = vm.runInContext('FRS.compile(\'fn main() { println!("browser ok {}", 1 + 1); }\', {file:"main.rs"})', sandbox);
    if (r && r.compileOk && r.stdout === 'browser ok 2\n') { passed++; console.log('ok - browser bundle (vm, no require)'); }
    else { failed++; console.log('FAIL - browser bundle :: ' + JSON.stringify(r && { ok: r.compileOk, out: r.stdout, err: r.stderr })); }
  } catch (e) { failed++; console.log('FAIL - browser bundle threw: ' + e.message); }
  console.log('\n' + passed + ' passed, ' + failed + ' failed (incl. browser)');
})();

process.exit(failed ? 1 : 0);

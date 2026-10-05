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

// ---- ownership & borrows (B001-B006) ----
t('B001 use after move', 'fn main() { let s = String::from("x"); let t = s; println!("{}", s); }', { ok: false, errContains: 'moved value' });
t('B001 move into call', 'fn take(s: String) -> usize { s.len() } fn main() { let s = String::from("x"); take(s); println!("{}", s); }', { ok: false, errContains: 'moved value' });
t('B001 clone keeps both', 'fn main() { let s = String::from("x"); let t = s.clone(); println!("{}{}", s, t); }', { ok: true, stdout: 'xx\n' });
t('B001 reinit heals move', 'fn main() { let mut s = String::from("a"); let t = s; s = String::from("b"); println!("{}{}", s, t); }', { ok: true, stdout: 'ba\n' });
t('B002 double &mut', 'fn main() { let mut x = 5; let a = &mut x; let b = &mut x; println!("{}{}", a, b); }', { ok: false, errContains: 'more than once' });
t('B002 sequential &mut ok', 'fn main() { let mut x = 5; let a = &mut x; println!("{}", a); let b = &mut x; println!("{}", b); }', { ok: true, stdout: '5\n5\n' });
t('B003 use while mutably borrowed', 'fn main() { let mut x = 5; let m = &mut x; println!("{}", x); println!("{}", m); }', { ok: false, errContains: 'mutably borrowed' });
t('B003 &mut while shared', 'fn main() { let mut v = String::from("v"); let r = &v; let m = &mut v; println!("{}{}", r, m); }', { ok: false, errContains: 'also borrowed as immutable' });
t('B003 & while mutably borrowed', 'fn main() { let mut x = 5; let m = &mut x; let r = &x; println!("{}{}", m, r); }', { ok: false, errContains: 'also borrowed as mutable' });
t('B003 NLL release ok', 'fn main() { let mut w = String::from("a"); let m = &mut w; println!("{}", m); println!("{}", w); }', { ok: true, stdout: 'a\na\n' });
t('B004 move while borrowed', 'fn main() { let s = String::from("x"); let r = &s; let t = s; println!("{}{}", r, t); }', { ok: false, errContains: 'because it is borrowed' });
t('B005 &mut of immutable', 'fn main() { let x = 5; let r = &mut x; println!("{}", r); }', { ok: false, errContains: 'not declared as mutable' });
t('B005 &mut call arg of immutable', 'fn f(s: &mut String) {} fn main() { let h = String::from("h"); f(&mut h); }', { ok: false, errContains: 'not declared as mutable' });
t('B006 return local ref', 'fn f() -> &i32 { let x = 1; &x } fn main() {}', { ok: false, errContains: 'local variable' });
t('B006 return owned ok', 'fn f() -> String { String::from("x") } fn main() { println!("{}", f()); }', { ok: true, stdout: 'x\n' });
t('deref write runs', 'fn main() { let mut x = 5; let r = &mut x; *r += 1; println!("{}", x); }', { ok: true, stdout: '6\n' });
t('&mut param writes back', 'fn bump(n: &mut i32) { *n += 10; } fn main() { let mut x = 1; bump(&mut x); println!("{}", x); }', { ok: true, stdout: '11\n' });

console.log('\n' + passed + ' passed, ' + failed + ' failed');

// ---- check-only helper (valid code must COMPILE; no execution) ----
function tc(name, src, want) {
  var r = FRS.compile(src, { file: 'main.rs', run: false });
  var ok = true, why = '';
  if (want.ok !== undefined && r.compileOk !== want.ok) { ok = false; why = 'compileOk=' + r.compileOk + ' want ' + want.ok; }
  if (want.errContains && !(r.stderr || '').includes(want.errContains)) { ok = false; why += ' stderr missing ' + JSON.stringify(want.errContains) + ' got:\n' + r.stderr; }
  if (want.noErr && r.errCount !== 0) { ok = false; why += ' expected 0 errors, got ' + r.errCount + ':\n' + r.stderr; }
  if (ok) { passed++; console.log('ok - ' + name); }
  else { failed++; console.log('FAIL - ' + name + ' :: ' + why); }
}

// ---- valid-Rust acceptance: every prompt.txt-shaped snippet must compile ----
tc('todo.rs compiles', require('fs').readFileSync(path.join(__dirname, '..', 'examples', 'todo.rs'), 'utf8'), { ok: true });
tc('Vec::new generic', 'fn main() { let mut todos: Vec<String> = Vec::new(); println!("{}", todos.len()); }', { ok: true });
tc('vec! annotated', 'fn main() { let v: Vec<i32> = vec![1, 2]; println!("{:?}", v); }', { ok: true });
tc('Result Ok annotated', 'fn main() { let x: Result<i32, String> = Ok(5); println!("{:?}", x); }', { ok: true });
tc('Option None annotated', 'fn main() { let x: Option<i32> = None; }', { ok: true });
tc('HashMap::new generic', 'use std::collections::HashMap; fn main() { let h: HashMap<String, i32> = HashMap::new(); }', { ok: true });
tc('to_string/len/parse chains', 'fn main() { let s: String = "42".to_string(); let n: usize = "42".parse().unwrap(); let l: usize = s.len(); let e: bool = s.is_empty(); }', { ok: true });
tc('match guard', 'fn main() { let x = 5; match x { n if n > 3 => println!("big"), _ => println!("small"), } }', { ok: true });
tc('at-pattern', 'fn main() { let x = 5; match x { n @ 1..=5 => println!("{}", n), _ => {} } }', { ok: true });
tc('or-pattern', 'fn main() { let x = 1; match x { 1 | 2 => println!("a"), _ => {} } }', { ok: true });
tc('stringify nested', 'fn main() { println!("{}", stringify!(hi)); }', { ok: true });
tc('raw ident', 'fn main() { let r#type = 5; println!("{}", r#type); }', { ok: true });
tc('compound assign ops', 'fn main() { let mut x = 5; x <<= 1; x >>= 1; x &= 3; x |= 1; x ^= 2; println!("{}", x); }', { ok: true });
tc('ref/deref/move/range ops', 'fn main() { let mut x = 5; let r = &mut x; *r += 1; let y = 1..3; let z = 1..=3; let w = &x; println!("{}{}", x, w); }', { ok: true });
tc('question mark op', 'fn f() -> Result<i32, String> { Ok(1) } fn g() -> Result<i32, String> { let x = f()?; Ok(x) } fn main() {}', { ok: true });
tc('lifetimes/generics/where', 'fn f<\'a>(x: &\'a str) -> &\'a str { x } fn g<T>(x: T) -> T where T: Clone { x.clone() } fn main() {}', { ok: true });
tc('dyn/impl trait', 'trait T {} fn f(x: &dyn T) {} fn g(x: impl Into<i32>) {} fn main() {}', { ok: true });
tc('desktop callback use', 'fn app() -> String { String::from("hi") } fn main() { dioxus::launch(app); }', { ok: true });
tc('desktop winit', 'use winit::event_loop::EventLoop; fn main() { println!("gui"); }', { ok: true });
tc('allow dead_code', '#[allow(dead_code)] fn helper() {} fn main() {}', { ok: true });

// ---- OS-aware compilation (rustc parity): false cfg is not compiled ----
(function () {
  var plat = typeof process !== 'undefined' ? process.platform : '';
  var hostOs = plat === 'win32' ? 'windows' : (plat === 'darwin' ? 'macos' : 'linux');
  var otherOs = hostOs === 'windows' ? 'linux' : 'windows';
  tc('cfg(false-os) not compiled', '#[cfg(target_os = "' + otherOs + '")] fn gated_broken() { let x: i32 = "bad"; } fn main() {}', { ok: true });
  t('cfg(true-os) runs', '#[cfg(target_os = "' + hostOs + '")] fn plat() -> i32 { 41 } fn main() { println!("{}", plat()); }', { ok: true, stdout: '41\n' });
  tc('cfg(not/any/all)', '#[cfg(not(target_os = "' + otherOs + '"))] fn a() {} #[cfg(any(target_os = "' + otherOs + '", target_os = "' + hostOs + '"))] fn b() {} #[cfg(all(unix, not(target_os = "' + otherOs + '")))] fn c() {} fn main() { a(); b(); }', { ok: true });
  t('cfg! macro host', 'fn main() { println!("{}", cfg!(target_os = "' + hostOs + '")); }', { ok: true, stdout: 'true\n' });
  t('consts::OS host', 'fn main() { println!("{}", std::env::consts::OS); }', { ok: true, stdout: hostOs + '\n' });
})();

// ---- runtime semantics for everyday valid code ----
t('range inclusive run', 'fn main() { for i in 1..=3 { print!("{}", i); } }', { ok: true, stdout: '123' });
t('match block arms', 'fn main() { let mut i = 0; loop { i += 1; match i { 3 => { println!("three"); break; } _ => println!("n={}", i), } } }', { ok: true, stdout: 'n=1\nn=2\nthree\n' });
t('or-pattern runs', 'fn main() { let x = 5; match x { 1 | 2 => println!("low"), _ => println!("other"), } }', { ok: true, stdout: 'other\n' });
t('at-pattern binds', 'fn main() { let x = 5; match x { n @ 3..=6 if n > 4 => println!("mid {}", n), _ => println!("other"), } }', { ok: true, stdout: 'mid 5\n' });
t('same-name &mut writes back', 'fn add(n: &mut usize) { *n += 1; } fn main() { let mut n: usize = 1; add(&mut n); add(&mut n); println!("{}", n); }', { ok: true, stdout: '3\n' });
t('struct field write', 'struct P { x: i32 } fn main() { let mut p = P { x: 1 }; p.x = 5; println!("{}", p.x); }', { ok: true, stdout: '5\n' });
t('tuple index', 'fn main() { let t = (1, "hi"); println!("{} {}", t.0, t.1); }', { ok: true, stdout: '1 hi\n' });
t('as cast', 'fn main() { let x = 5 as f64; println!("{}", x); }', { ok: true, stdout: '5\n' });
t('find/retain/iter_mut', 'struct T { id: usize } fn main() { let mut v = vec![T { id: 1 }, T { id: 2 }]; if let Some(t) = v.iter_mut().find(|x| x.id == 2) { t.id = 9; } v.retain(|x| x.id != 1); println!("{} {}", v.len(), v[0].id); }', { ok: true, stdout: '1 9\n' });
t('move closure captures', 'fn main() { let v = vec![1]; let f = move || v.len(); println!("{}", f()); }', { ok: true, stdout: '1\n' });
t('format precision', 'fn main() { println!("{:.1}", 3.14159); }', { ok: true, stdout: '3.1\n' });
t('negated field assign', 'struct T { on: bool } fn main() { let mut t = T { on: false }; t.on = !t.on; println!("{}", t.on); }', { ok: true, stdout: 'true\n' });

console.log('\n' + passed + ' passed, ' + failed + ' failed (incl. acceptance)');

// ---- interactive terminal input: prompts flush live, reads block per line ----
// (spawns a child that fakes TTY flags with piped keystrokes standing in for
// typed lines — byte-wise reads behave identically on a real terminal)
(function () {
  try {
    var cp = require('child_process');
    var frsPath = path.join(__dirname, '..', 'src', 'frs.js');
    var todoPath = path.join(__dirname, '..', 'examples', 'todo.rs');
    var helper = "process.stdin.isTTY=true;process.stdout.isTTY=true;" +
      "var FRS=require(" + JSON.stringify(frsPath) + ");" +
      "var fs=require('fs');" +
      "var src=fs.readFileSync(" + JSON.stringify(todoPath) + ",'utf8');" +
      "var r=FRS.compile(src,{file:'todo.rs',run:true});" +
      "process.stdout.write('\\n[END ok='+r.compileOk+' tail='+JSON.stringify(r.stdout.slice(-20))+']');";
    var res = cp.spawnSync(process.execPath, ['-e', helper], { input: '2\nBuy milk\n1\n6\n', timeout: 20000, encoding: 'utf8' });
    var out = (res.stdout || '') + (res.stderr || '');
    var okTty = res.status === 0 && out.indexOf('Choose an option') !== -1 &&
      out.indexOf('Buy milk') !== -1 && out.indexOf('Goodbye!') !== -1;
    if (okTty) { passed++; console.log('ok - interactive tty input'); }
    else { failed++; console.log('FAIL - interactive tty input :: status=' + res.status + ' err=' + (res.error && res.error.message) + ' out=' + JSON.stringify(out.slice(-300))); }
  } catch (e) { failed++; console.log('FAIL - interactive tty input threw: ' + e.message); }
})();

// ---- browser compat: load every src/*.js in a `module`-less vm sandbox ----
(function () {
  try {
    var vm = require('vm');
    var fs = require('fs');
    var sandbox = {};
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    ['util.js', 'lexer.js', 'diagnostics.js',
     'rules/known.js', 'rules/syntax_rules.js', 'rules/type_rules.js',
     'rules/borrow_rules.js', 'rules/warn_rules.js', 'rules/int_rules.js',
     'rules/index.js', 'rules.js', 'checker.js', 'interpreter.js', 'frs.js']
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

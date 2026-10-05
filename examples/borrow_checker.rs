// Ownership, moves and borrows — every pattern in this file is VALID Rust.
// frs checks it clean (all B-rules pass) and runs it for real:
// `node bin/frs.js examples/borrow_checker.rs`

// Shared borrow: reads, never moves.
fn len_of(s: &String) -> usize {
    s.len()
}

// Exclusive borrow: writes back through the reference.
fn replace_with_bang(s: &mut String) {
    let bang = String::from("!");
    *s = bang;
}

// By value: takes ownership, returns an owned value.
fn take(s: String) -> usize {
    s.len()
}

fn main() {
    // --- Copy types: assignment copies, both sides stay usable ---
    let n = 42;
    let a = n;
    println!("copy: {} {}", n, a);

    // --- clone() copies instead of moving ---
    let s = String::from("hi");
    let t = s.clone();
    println!("clone: {} {}", s, t);

    // --- move: ownership transfers, old name rests ---
    let u = s;
    println!("move: {}", u);

    // --- shared borrows coexist ---
    let v = String::from("hey");
    let r1 = &v;
    let r2 = &v;
    println!("shared: {} {}", r1, r2);
    println!("owner still usable: {}", v);

    // --- exclusive borrow, then released (NLL): owner usable again ---
    let mut w = String::from("a");
    let m = &mut w;
    *m = String::from("ab");
    println!("exclusive: {}", m);
    println!("released: {}", w);

    // --- deref write through `&mut` (NLL: `x` usable after last `*r` use) ---
    let mut x = 5;
    let r = &mut x;
    *r += 1;
    println!("deref: {}", *r);
    println!("owner: {}", x);

    // --- borrows as call arguments ---
    let g = String::from("gg");
    println!("arg shared: {}", len_of(&g));
    let mut h = String::from("h");
    replace_with_bang(&mut h);
    println!("arg exclusive: {}", h);
    println!("by value: {}", take(String::from("owned")));

    // --- slice borrow of a vector ---
    let arr = vec![1, 2, 3];
    let sl = &arr[1..3];
    println!("slice: {:?} len={}", sl, sl.len());
}

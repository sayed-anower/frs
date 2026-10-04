use std::collections::HashMap;

struct Point { x: i32, y: i32 }

enum Dir { North, South }

fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn main() {
    let p = Point { x: 1, y: 2 };
    println!("p.x = {}, p.y = {}", p.x, p.y);

    let mut m: HashMap<String, i32> = HashMap::new();
    m.insert("one".to_string(), 1);
    println!("map ok");

    let s: String = "hi".to_string();
    let f = format!("{}-{}", 1, 2);
    println!("{:?}", f);

    let n = 3;
    match n {
        1 => println!("one"),
        2 => println!("two"),
        _ => println!("other: {}", n),
    }

    let r = add(2, 3);
    println!("2 + 3 = {}", r);

    let mut i = 0;
    while i < 3 {
        println!("i = {}", i);
        i += 1;
    }

    let t: (i32, bool) = (1, true);
    println!("tuple ok");
    drop(t);
    drop(Dir::North);
    println!("s = {}", s);
}

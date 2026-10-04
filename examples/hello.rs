fn main() {
    let x: i32 = 5;
    let name = "frs";
    println!("hello from {}! x = {}", name, x);

    let mut total = 0;
    for i in 0..5 {
        total += i;
    }
    println!("total = {}", total);

    if total > 5 {
        println!("big!");
    } else {
        println!("small");
    }

    let v = vec![1, 2, 3];
    println!("v = {:?}", v);

    println!("2 + 3 = {}", 2 + 3);
    println!("debug: {:?}", name);
}

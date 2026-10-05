use std::io::{self, Write};

struct TodoItem {
    id: usize,
    title: String,
    completed: bool,
}

fn main() {
    let mut todos: Vec<TodoItem> = Vec::new();
    let mut next_id: usize = 1;

    println!("=== Terminal To-Do App ===");

    loop {
        println!("\n--- Options ---");
        println!("1. View To-Dos");
        println!("2. Add To-Do");
        println!("3. Edit To-Do");
        println!("4. Toggle Complete");
        println!("5. Delete To-Do");
        println!("6. Exit");
        print!("Choose an option (1-6): ");
        io::stdout().flush().unwrap();

        let choice = read_input();

        match choice.trim() {
            "1" => list_todos(&todos),
            "2" => add_todo(&mut todos, &mut next_id),
            "3" => edit_todo(&mut todos),
            "4" => toggle_todo(&mut todos),
            "5" => delete_todo(&mut todos),
            "6" => {
                println!("Goodbye!");
                break;
            }
            _ => println!("Invalid option. Please try again."),
        }
    }
}

// Helper function to read a line from standard input
fn read_input() -> String {
    let mut input = String::new();
    io::stdin()
        .read_line(&mut input)
        .expect("Failed to read input");
    input.trim().to_string()
}

// Helper to prompt the user and read a string
fn prompt(message: &str) -> String {
    print!("{}", message);
    io::stdout().flush().unwrap();
    read_input()
}

fn list_todos(todos: &[TodoItem]) {
    if todos.is_empty() {
        println!("\nYour to-do list is empty.");
        return;
    }

    println!("\n--- Your To-Do List ---");
    for item in todos {
        let status = if item.completed { "[X]" } else { "[ ]" };
        println!("{} {} - {}", status, item.id, item.title);
    }
}

fn add_todo(todos: &mut Vec<TodoItem>, next_id: &mut usize) {
    let title = prompt("Enter task title: ");

    if title.is_empty() {
        println!("Task title cannot be empty.");
        return;
    }

    todos.push(TodoItem {
        id: *next_id,
        title,
        completed: false,
    });

    println!("Added task with ID: {}", *next_id);
    *next_id += 1;
}

fn edit_todo(todos: &mut [TodoItem]) {
    list_todos(todos);
    if todos.is_empty() {
        return;
    }

    let id_str = prompt("Enter the ID of the task to edit: ");
    let id: usize = match id_str.parse() {
        Ok(num) => num,
        Err(_) => {
            println!("Invalid ID format.");
            return;
        }
    };

    if let Some(item) = todos.iter_mut().find(|t| t.id == id) {
        let new_title = prompt(&format!("Enter new title for task {} (current: '{}'): ", item.id, item.title));
        if !new_title.is_empty() {
            item.title = new_title;
            println!("Task updated successfully.");
        } else {
            println!("Title unchanged.");
        }
    } else {
        println!("Task with ID {} not found.", id);
    }
}

fn toggle_todo(todos: &mut [TodoItem]) {
    list_todos(todos);
    if todos.is_empty() {
        return;
    }

    let id_str = prompt("Enter the ID of the task to toggle: ");
    let id: usize = match id_str.parse() {
        Ok(num) => num,
        Err(_) => {
            println!("Invalid ID format.");
            return;
        }
    };

    if let Some(item) = todos.iter_mut().find(|t| t.id == id) {
        item.completed = !item.completed;
        println!(
            "Task {} marked as {}",
            item.id,
            if item.completed { "completed" } else { "pending" }
        );
    } else {
        println!("Task with ID {} not found.", id);
    }
}

fn delete_todo(todos: &mut Vec<TodoItem>) {
    list_todos(todos);
    if todos.is_empty() {
        return;
    }

    let id_str = prompt("Enter the ID of the task to delete: ");
    let id: usize = match id_str.parse() {
        Ok(num) => num,
        Err(_) => {
            println!("Invalid ID format.");
            return;
        }
    };

    let initial_len = todos.len();
    todos.retain(|item| item.id != id);

    if todos.len() < initial_len {
        println!("Task {} deleted.", id);
    } else {
        println!("Task with ID {} not found.", id);
    }
}
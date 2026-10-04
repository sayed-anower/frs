use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fmt::{self, Display, Formatter};
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::RwLock;

#[allow(dead_code)]

// 1. ATOMIC COUNTER & ID GENERATION

// Demonstrates thread-safe atomic types for auto-incrementing unique IDs.
static GLOBAL_ID_COUNTER: AtomicUsize = AtomicUsize::new(1);

fn generate_id() -> usize {
    GLOBAL_ID_COUNTER.fetch_add(1, Ordering::SeqCst)
}

// 2. ERROR HANDLING & CUSTOM RESULT TYPES

// Demonstrates Enums with associated data, standard Error conversion, and custom Result type alias.
#[derive(Debug)]
pub enum TodoError {
    IoError(io::Error),
    ItemNotFound(usize),
    InvalidInput(String),
    CategoryNotFound(String),
    ParseError(String),
}

impl Display for TodoError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            TodoError::IoError(err) => write!(f, "IO Error: {}", err),
            TodoError::ItemNotFound(id) => write!(f, "Item with ID {} not found.", id),
            TodoError::InvalidInput(msg) => write!(f, "Invalid input: {}", msg),
            TodoError::CategoryNotFound(cat) => write!(f, "Category '{}' not found.", cat),
            TodoError::ParseError(msg) => write!(f, "Failed to parse data: {}", msg),
        }
    }
}

impl From<io::Error> for TodoError {
    fn from(err: io::Error) -> Self {
        TodoError::IoError(err)
    }
}

pub type Result<T> = std::result::Result<T, TodoError>;


// 3. ENUMS, TUPLE STRUCTS, AND DERIVE MACROS


// Priority uses Ord/PartialOrd to allow comparison and sorting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Priority {
    Low = 1,
    Medium = 2,
    High = 3,
    Critical = 4,
}

impl Display for Priority {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Priority::Low => write!(f, "[LOW]"),
            Priority::Medium => write!(f, "[MED]"),
            Priority::High => write!(f, "[HIGH]"),
            Priority::Critical => write!(f, "[CRIT]"),
        }
    }
}

// Tuple Struct representing Metadata (Created Timestamp String, Estimated Time in Minutes)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskMeta(pub String, pub u32);

// Status Enum representing state transitions
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Pending,
    InProgress(u8), // Progress percentage 0-100
    Completed,
}

impl Display for Status {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Status::Pending => write!(f, "Pending"),
            Status::InProgress(pct) => write!(f, "In Progress ({}%)", pct),
            Status::Completed => write!(f, "Done"),
        }
    }
}


// 4. MAIN TASK DATA STRUCTURE

#[derive(Debug, Clone)]
pub struct Task {
    pub id: usize,
    pub title: String,
    pub priority: Priority,
    pub status: Status,
    pub tags: HashSet<String>,   // HashSet guarantees unique tags per task
    pub meta: TaskMeta,         // Tuple struct
    pub dependency_id: Option<usize>, // Rust Option type
}

impl Task {
    pub fn new(title: String, priority: Priority, est_minutes: u32) -> Self {
        Self {
            id: generate_id(),
            title,
            priority,
            status: Status::Pending,
            tags: HashSet::new(),
            meta: TaskMeta("2026-10-04".to_string(), est_minutes),
            dependency_id: None,
        }
    }

    pub fn add_tag(&mut self, tag: impl Into<String>) {
        self.tags.insert(tag.into());
    }
}

impl Display for Task {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        let tag_list: Vec<String> = self.tags.iter().map(|t| format!("#{}", t)).collect();
        let dep_str = match self.dependency_id {
            Some(dep) => format!(" (Blocked by ID #{})", dep),
            None => String::new(),
        };
        
        write!(
            f,
            "[{}] ID #{}: {} | Priority: {} | Status: {} | Time: {}m | Tags: {}{}",
            if self.status == Status::Completed { "X" } else { " " },
            self.id,
            self.title,
            self.priority,
            self.status,
            self.meta.1,
            if tag_list.is_empty() { "None".to_string() } else { tag_list.join(", ") },
            dep_str
        )
    }
}


// 5. TRAITS & GENERICS (ABSTRACTIONS)


// Generic Trait for items that can be filtered dynamically using closures
pub trait Filterable<T> {
    fn filter_by<F>(&self, predicate: F) -> Vec<&T>
    where
        F: Fn(&T) -> bool;
}

// Custom Trait for export/import capability
pub trait Exportable {
    fn serialize(&self) -> String;
}

impl Exportable for Task {
    fn serialize(&self) -> String {
        let tags_str = self.tags.iter().cloned().collect::<Vec<_>>().join(",");
        let dep = self.dependency_id.map(|d| d.to_string()).unwrap_or_else(|| "NONE".to_string());
        format!(
            "{}|{}|{:?}|{:?}|{}|{}|{}",
            self.id, self.title, self.priority, self.status, self.meta.1, tags_str, dep
        )
    }
}


// 6. ADVANCED STORAGE ENGINE (COMPLEX DATA STRUCTURE INTERACTION)

// Uses HashMap, BTreeMap, VecDeque, Rc, RefCell, and RwLock.
pub struct TodoEngine {
    // Primary storage mapping ID -> Reference-Counted Interior-Mutable Task
    tasks: HashMap<usize, Rc<RefCell<Task>>>,
    // Categorized index mapping Category Name -> List of Task IDs
    categories: HashMap<String, HashSet<usize>>,
    // Priority Index using sorted BTreeMap: Priority -> List of Task Shared References
    priority_index: BTreeMap<Priority, Vec<Rc<RefCell<Task>>>>,
    // Task execution history (Undo log) using double-ended queue
    history: VecDeque<String>,
    // Thread-safe system metrics locked behind Read-Write Lock
    metrics: RwLock<(usize, usize)>, // Tuple: (Total Created, Total Completed)
}

impl TodoEngine {
    pub fn new() -> Self {
        Self {
            tasks: HashMap::new(),
            categories: HashMap::new(),
            priority_index: BTreeMap::new(),
            history: VecDeque::with_capacity(50),
            metrics: RwLock::new((0, 0)),
        }
    }

    pub fn add_task(&mut self, category: String, mut task: Task) -> usize {
        let id = task.id;
        task.add_tag(&category);
        
        let rc_task = Rc::new(RefCell::new(task.clone()));
        
        // 1. Insert into primary HashMap
        self.tasks.insert(id, Rc::clone(&rc_task));

        // 2. Add to Category Index (HashMap -> HashSet)
        self.categories
            .entry(category.clone())
            .or_insert_with(HashSet::new)
            .insert(id);

        // 3. Add to Sorted BTreeMap Priority Index
        self.priority_index
            .entry(task.priority)
            .or_insert_with(Vec::new)
            .push(Rc::clone(&rc_task));

        // 4. Log to VecDeque History
        if self.history.len() >= 50 {
            self.history.pop_front();
        }
        self.history.push_back(format!("Added Task #{} [{}]", id, task.title));

        // 5. Update thread-safe RwLock metrics
        if let Ok(mut m) = self.metrics.write() {
            m.0 += 1;
        }

        id
    }

    pub fn mark_complete(&mut self, id: usize) -> Result<()> {
        if let Some(task_rc) = self.tasks.get(&id) {
            let mut task = task_rc.borrow_mut();
            task.status = Status::Completed;

            self.history.push_back(format!("Completed Task #{}", id));

            if let Ok(mut m) = self.metrics.write() {
                m.1 += 1;
            }
            Ok(())
        } else {
            Err(TodoError::ItemNotFound(id))
        }
    }

    pub fn list_by_priority(&self) {
        println!("\n=== Tasks Sorted by Priority (BTreeMap) ===");
        // Iterating over sorted map keys (Critical -> High -> Medium -> Low) in reverse
        for (priority, task_list) in self.priority_index.iter().rev() {
            println!("-- Priority Group: {} --", priority);
            for task_rc in task_list {
                println!("  {}", task_rc.borrow());
            }
        }
    }

    pub fn print_metrics(&self) {
        if let Ok(m) = self.metrics.read() {
            println!("\n=== Engine Metrics (RwLock) ===");
            println!("Total Created: {} | Total Completed: {}", m.0, m.1);
        }
    }

    pub fn save_to_file(&self, filename: &str) -> Result<()> {
        let mut file = File::create(filename)?;
        for task_rc in self.tasks.values() {
            let task = task_rc.borrow();
            writeln!(file, "{}", task.serialize())?;
        }
        println!("Successfully exported tasks to {}", filename);
        Ok(())
    }
}

// Blanket implementation of Filterable trait for TodoEngine
impl Filterable<Task> for TodoEngine {
    fn filter_by<F>(&self, predicate: F) -> Vec<&Task>
    where
        F: Fn(&Task) -> bool,
    {
        // Demonstrates high-order iterator pipelines and RefCell borrowing
        self.tasks
            .values()
            .map(|rc| unsafe { &*rc.as_ptr() }) // Unsafe pointer conversion for zero-cost lifetime projection demo
            .filter(|task| predicate(task))
            .collect()
    }
}


// 7. CLI INTERACTION LAYER & INPUT READING

fn prompt_input(prompt: &str) -> String {
    print!("{}", prompt);
    io::stdout().flush().unwrap();
    let mut buffer = String::new();
    io::stdin().read_line(&mut buffer).unwrap();
    buffer.trim().to_string()
}

fn display_menu() {
    println!("# RUST ADVANCED TODO CLI APPLICATION:");
    println!("1. Add Task");
    println!("2. Mark Task as Completed");
    println!("3. List All Tasks (by Priority)");
    println!("4. Filter Tasks by Tag");
    println!("5. View System Metrics");
    println!("6. Save Tasks to File");
    println!("7. Exit");
}

// 8. MAIN ENTRY POINT

fn main() {
    let mut engine = TodoEngine::new();

    // Pre-populating sample data
    let mut task1 = Task::new("Implement Core Modules".into(), Priority::Critical, 120);
    task1.add_tag("Rust");
    task1.add_tag("Backend");

    let mut task2 = Task::new("Write Unit Tests".into(), Priority::High, 45);
    task2.add_tag("Testing");
    task2.dependency_id = Some(task1.id);

    engine.add_task("Work".into(), task1);
    engine.add_task("Work".into(), task2);

    loop {
        display_menu();
        let choice = prompt_input("Select an option (1-7): ");

        match choice.as_str() {
            "1" => {
                let title = prompt_input("Enter Task Title: ");
                let category = prompt_input("Enter Category: ");
                let p_input = prompt_input("Priority (1=Low, 2=Med, 3=High, 4=Crit): ");
                
                let priority = match p_input.as_str() {
                    "1" => Priority::Low,
                    "2" => Priority::Medium,
                    "3" => Priority::High,
                    "4" => Priority::Critical,
                    _ => Priority::Medium,
                };

                let time_str = prompt_input("Estimated Minutes: ");
                let est_time: u32 = time_str.parse().unwrap_or(30);

                let task = Task::new(title, priority, est_time);
                let id = engine.add_task(category, task);
                println!("Task added successfully with ID #{}.", id);
            }
            "2" => {
                let id_str = prompt_input("Enter Task ID to complete: ");
                if let Ok(id) = id_str.parse::<usize>() {
                    match engine.mark_complete(id) {
                        Ok(_) => println!("Task #{} marked as completed!", id),
                        Err(e) => println!("Error: {}", e),
                    }
                } else {
                    println!("Invalid ID format.");
                }
            }
            "3" => {
                engine.list_by_priority();
            }
            "4" => {
                let search_tag = prompt_input("Enter Tag to search: ");
                let results = engine.filter_by(|task| task.tags.contains(&search_tag));
                
                println!("\n--- Filter Results for '#{}' ---", search_tag);
                if results.is_empty() {
                    println!("No matching tasks found.");
                } else {
                    for t in results {
                        println!("{}", t);
                    }
                }
            }
            "5" => {
                engine.print_metrics();
            }
            "6" => {
                let filename = prompt_input("Enter export filename (e.g., tasks.txt): ");
                if let Err(e) = engine.save_to_file(&filename) {
                    println!("Failed to save: {}", e);
                }
            }
            "7" => {
                println!("Exiting system. Goodbye!");
                break;
            }
            _ => println!("Invalid option! Please choose between 1 and 7."),
        }
    }
}

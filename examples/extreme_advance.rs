//! Ultimate Rust Syntax & Standard Library Coverage Todo App
//! Designed to test custom compilers, syntax checkers, and linters.

#![deny(clippy::all)]
#![allow(unused_imports, unused_variables)]

use std::{
    alloc::{alloc, dealloc, Layout},
    any::{Any, TypeId},
    borrow::{Cow, ToOwned},
    cell::{Cell, RefCell},
    cmp::{Ordering, PartialOrd},
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    fmt::{self, Display, Formatter},
    fs::{File, OpenOptions},
    future::Future,
    io::{self, BufRead, BufReader, Write},
    marker::PhantomData,
    mem::{self, ManuallyDrop, MaybeUninit},
    ops::{Add, Deref, Index},
    path::{Path, PathBuf},
    pin::Pin,
    process,
    rc::Rc,
    slice,
    str::FromStr,
    sync::{
        atomic::{AtomicUsize, Ordering as AtomicOrdering},
        mpsc::{channel, Receiver, Sender},
        Arc, Mutex, OnceLock,
    },
    task::{Context, Poll, Waker},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};


// 1. MACROS (Declarative & Rules)


macro_rules! create_todo {
    ($id:expr, $title:expr) => {
        TodoItem::new($id, $title, Priority::Medium)
    };
    ($id:expr, $title:expr, $prio:expr) => {
        TodoItem::new($id, $title, $prio)
    };
}

macro_rules! log_action {
    ($action:expr) => {
        if let Ok(mut guard) = GLOBAL_LOG.lock() {
            guard.push(format!("[LOG {}]: {}", now_timestamp(), $action));
        }
    };
}


// 2. CONSTANTS, STATICS & GLOBAL STATE


const APP_NAME: &'static str = "RustSyntaxTodo";
static TOTAL_TODOS_CREATED: AtomicUsize = AtomicUsize::new(0);
static GLOBAL_LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
static VERSION_LOCK: OnceLock<String> = OnceLock::new();


// 3. ENUMS, STRUCTS & TYPES

pub type TodoId = usize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Priority {
    Low = 1,
    Medium = 2,
    High = 3,
    Critical = 4,
}

impl Display for Priority {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        let label = match self {
            Self::Low => "LOW",
            Self::Medium => "MED",
            Self::High => "HIGH",
            Priority::Critical => "CRIT",
        };
        write!(f, "{}", label)
    }
}

impl FromStr for Priority {
    type Err = TodoError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_lowercase().as_str() {
            "1" | "low" => Ok(Priority::Low),
            "2" | "med" | "medium" => Ok(Priority::Medium),
            "3" | "high" => Ok(Priority::High),
            "4" | "crit" | "critical" => Ok(Priority::Critical),
            _ => Err(TodoError::InvalidInput("Invalid priority value".into())),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Tag(pub String);

#[derive(Debug)]
pub struct TodoItem {
    pub id: TodoId,
    pub title: String,
    pub priority: Priority,
    pub completed: bool,
    pub tags: HashSet<Tag>,
    pub created_at: SystemTime,
}

impl TodoItem {
    pub fn new<S: Into<String>>(id: TodoId, title: S, priority: Priority) -> Self {
        TOTAL_TODOS_CREATED.fetch_add(1, AtomicOrdering::SeqCst);
        Self {
            id,
            title: title.into(),
            priority,
            completed: false,
            tags: HashSet::new(),
            created_at: SystemTime::now(),
        }
    }

    pub fn toggle(&mut self) -> bool {
        self.completed = !self.completed;
        self.completed
    }
}

// Custom Smart Pointer wrapper using Deref
pub struct RefCellTodoWrapper<'a> {
    inner: &'a RefCell<TodoItem>,
}

// Unsafe Manual Allocation Struct (Testing manual memory layout)
pub struct RawBuffer<T> {
    ptr: *mut T,
    cap: usize,
    _marker: PhantomData<T>,
}

impl<T> RawBuffer<T> {
    pub fn new(cap: usize) -> Self {
        let layout = Layout::array::<T>(cap).unwrap();
        let ptr = unsafe { alloc(layout) as *mut T };
        Self {
            ptr,
            cap,
            _marker: PhantomData,
        }
    }
}

impl<T> Drop for RawBuffer<T> {
    fn drop(&mut self) {
        let layout = Layout::array::<T>(self.cap).unwrap();
        unsafe {
            dealloc(self.ptr as *mut u8, layout);
        }
    }
}

// Dead Code Macro Allowed On Select Structures (Testing Linter Warnings)
#[allow(dead_code)]
pub struct DeadCodeTester {
    pub unused_field: u64,
    pub unused_flag: bool,
}

#[allow(dead_code)]
pub enum UnusedEnum {
    VariantA,
    VariantB(String),
}

// Intentional dead code WITHOUT allow macro (Your compiler should catch this!)
pub struct UnusedStructWithoutAllow {
    pub value: String,
}

pub fn unused_function_without_allow() {
    println!("I am dead code without #[allow(dead_code)]");
}


// 4. TRAITS, GENERICS & ASSOCIATED TYPES


pub trait Summarizable {
    type Output;
    fn summarize(&self) -> Self::Output;
    fn verbose_summary(&self) -> String where Self: Display {
        format!("Verbose: {}", self)
    }
}

impl Summarizable for TodoItem {
    type Output = String;

    fn summarize(&self) -> Self::Output {
        let status = if self.completed { "[x]" } else { "[ ]" };
        format!("{} #{} {} [{}]", status, self.id, self.title, self.priority)
    }
}

pub trait Filterable<T> {
    fn filter_by<F>(&self, predicate: F) -> Vec<&T>
    where
        F: Fn(&T) -> bool;
}

// Lifetime Bounds on Traits
pub trait Repository<'a, T: 'a> {
    fn add(&mut self, item: T);
    fn get(&'a self, id: TodoId) -> Option<&'a T>;
}


// 5. CUSTOM ERRORS & RESULT HANDLING


#[derive(Debug)]
pub enum TodoError {
    Io(io::Error),
    NotFound(TodoId),
    InvalidInput(String),
    SystemTimeError(std::time::SystemTimeError),
    Unknown,
}

impl Display for TodoError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "I/O Error: {}", e),
            Self::NotFound(id) => write!(f, "Todo ID #{} not found", id),
            Self::InvalidInput(msg) => write!(f, "Invalid Input: {}", msg),
            Self::SystemTimeError(e) => write!(f, "Clock Error: {}", e),
            Self::Unknown => write!(f, "An unknown error occurred"),
        }
    }
}

impl std::error::Error for TodoError {}

impl From<io::Error> for TodoError {
    fn from(err: io::Error) -> Self {
        TodoError::Io(err)
    }
}

impl From<std::time::SystemTimeError> for TodoError {
    fn from(err: std::time::SystemTimeError) -> Self {
        TodoError::SystemTimeError(err)
    }
}


// 6. MAIN TODO MANAGER


pub struct TodoManager {
    items: BTreeMap<TodoId, RefCell<TodoItem>>,
    history: VecDeque<String>,
    categories: HashMap<String, Vec<TodoId>>,
    next_id: Cell<usize>,
    tx_channel: Sender<String>,
    rx_channel: Receiver<String>,
}

impl TodoManager {
    pub fn new() -> Self {
        let (tx, rx) = channel();
        Self {
            items: BTreeMap::new(),
            history: VecDeque::with_capacity(100),
            categories: HashMap::new(),
            next_id: Cell::new(1),
            tx_channel: tx,
            rx_channel: rx,
        }
    }

    pub fn add_todo(&mut self, title: String, priority: Priority) -> TodoId {
        let id = self.next_id.get();
        self.next_id.set(id + 1);

        let item = create_todo!(id, title, priority);
        log_action!(format!("Added todo #{}", id));
        self.items.insert(id, RefCell::new(item));

        let _ = self.tx_channel.send(format!("Event: Created #{}", id));
        id
    }

    pub fn list_all(&self) {
        println!("\n========= TODO LIST =========");
        if self.items.is_empty() {
            println!("(No todos found)");
            return;
        }

        // Pattern Matching, Iterators, and Adapters
        self.items
            .iter()
            .map(|(id, item)| (id, item.borrow()))
            .for_each(|(id, item)| {
                println!("{}", item.summarize());
            });
        println!("=============================\n");
    }

    pub fn toggle_todo(&self, id: TodoId) -> Result<bool, TodoError> {
        match self.items.get(&id) {
            Some(cell) => {
                let mut item = cell.borrow_mut();
                let status = item.toggle();
                log_action!(format!("Toggled #{} to {}", id, status));
                Ok(status)
            }
            None => Err(TodoError::NotFound(id)),
        }
    }

    pub fn remove_todo(&mut self, id: TodoId) -> Result<TodoItem, TodoError> {
        if let Some(cell) = self.items.remove(&id) {
            log_action!(format!("Removed #{}", id));
            Ok(cell.into_inner())
        } else {
            Err(TodoError::NotFound(id))
        }
    }

    pub fn export_to_file<P: AsRef<Path>>(&self, path: P) -> Result<(), TodoError> {
        let mut file = File::create(path)?;
        for cell in self.items.values() {
            let item = cell.borrow();
            writeln!(
                file,
                "{},{},{},{}",
                item.id, item.completed, item.priority as u8, item.title
            )?;
        }
        Ok(())
    }

    pub fn import_from_file<P: AsRef<Path>>(&mut self, path: P) -> Result<(), TodoError> {
        let file = File::open(path)?;
        let reader = BufReader::new(file);

        for line in reader.lines() {
            let line = line?;
            let parts: Vec<&str> = line.split(',').collect();
            if let [id_s, comp_s, prio_s, title_s] = parts.as_slice() {
                let id: usize = id_s.parse().map_err(|_| TodoError::InvalidInput("Bad ID".into()))?;
                let completed: bool = comp_s.parse().map_err(|_| TodoError::InvalidInput("Bad Bool".into()))?;
                let prio_num: u8 = prio_s.parse().map_err(|_| TodoError::InvalidInput("Bad Prio".into()))?;
                
                let priority = match prio_num {
                    1 => Priority::Low,
                    2 => Priority::Medium,
                    3 => Priority::High,
                    4 => Priority::Critical,
                    _ => Priority::Medium,
                };

                let mut todo = TodoItem::new(id, *title_s, priority);
                todo.completed = completed;
                
                self.items.insert(id, RefCell::new(todo));
                if id >= self.next_id.get() {
                    self.next_id.set(id + 1);
                }
            }
        }
        Ok(())
    }
}


// 7. ASYNC / FUTURE EXECUTOR DEMO


pub struct SimpleTimerFuture {
    expiration: Instant,
}

impl Future for SimpleTimerFuture {
    type Output = &'static str;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if Instant::now() >= self.expiration {
            Poll::Ready("Async Sync-Check Task Finished!")
        } else {
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }
}


// 8. HELPER FUNCTIONS & UNSAFE DEMOS


fn now_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// Function with raw pointer ops and slice manipulation
fn perform_unsafe_inspection(todo: &TodoItem) {
    let ptr: *const TodoItem = todo;
    unsafe {
        let ref_from_raw = &*ptr;
        // Transmute test
        let bytes: [u8; mem::size_of::<usize>()] = mem::transmute(ref_from_raw.id);
    }
}

// Closure and higher order functions
fn process_with_closure<F>(val: usize, f: F) -> usize
where
    F: FnOnce(usize) -> usize,
{
    f(val)
}


// 9. MAIN ENTRY POINT & TERMINAL LOOP


fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Lazy Initialization test
    let version = VERSION_LOCK.get_or_init(|| String::from("1.0.0"));
    println!("Starting {} v{}...", APP_NAME, version);

    // Multithread Background Worker Channel Test
    let (async_tx, async_rx) = channel::<String>();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(100));
        let _ = async_tx.send(String::from("Background task synchronized successfully."));
    });

    let mut manager = TodoManager::new();

    // Default Items
    manager.add_todo("Test Compiler Parser".into(), Priority::Critical);
    manager.add_todo("Verify Dead Code Rules".into(), Priority::High);
    manager.add_todo("Check Std Trait Implementations".into(), Priority::Low);

    let stdin = io::stdin();
    let mut handle = stdin.lock();

    loop {
        println!("\nCommands: [l]ist | [a]dd | [t]oggle | [r]emove | [s]ave | [o]ad | [e]xit");
        print!("> ");
        io::stdout().flush()?;

        let mut input = String::new();
        if handle.read_line(&mut input)? == 0 {
            break; // EOF
        }

        let trimmed = input.trim();
        let mut parts = trimmed.split_whitespace();
        let command = parts.next().unwrap_or("");

        match command {
            "l" | "list" => {
                manager.list_all();
            }
            "a" | "add" => {
                print!("Enter todo title: ");
                io::stdout().flush()?;
                let mut title = String::new();
                handle.read_line(&mut title)?;

                print!("Enter priority (1:Low, 2:Med, 3:High, 4:Crit): ");
                io::stdout().flush()?;
                let mut prio_str = String::new();
                handle.read_line(&mut prio_str)?;

                let priority = prio_str.parse::<Priority>().unwrap_or(Priority::Medium);
                let id = manager.add_todo(title.trim().to_string(), priority);
                println!("Added Todo #{}", id);
            }
            "t" | "toggle" => {
                if let Some(id_str) = parts.next() {
                    if let Ok(id) = id_str.parse::<usize>() {
                        match manager.toggle_todo(id) {
                            Ok(status) => println!("Todo #{} status set to: {}", id, status),
                            Err(e) => println!("Error: {}", e),
                        }
                    }
                } else {
                    println!("Usage: t <id>");
                }
            }
            "r" | "remove" => {
                if let Some(id_str) = parts.next() {
                    if let Ok(id) = id_str.parse::<usize>() {
                        match manager.remove_todo(id) {
                            Ok(item) => println!("Removed item: {}", item.title),
                            Err(e) => println!("Error: {}", e),
                        }
                    }
                } else {
                    println!("Usage: r <id>");
                }
            }
            "s" | "save" => {
                let path = PathBuf::from("todos.db");
                match manager.export_to_file(&path) {
                    Ok(_) => println!("Exported successfully to {:?}", path),
                    Err(e) => println!("Failed export: {}", e),
                }
            }
            "o" | "load" => {
                let path = PathBuf::from("todos.db");
                match manager.import_from_file(&path) {
                    Ok(_) => println!("Imported successfully from {:?}", path),
                    Err(e) => println!("Failed import: {}", e),
                }
            }
            "e" | "exit" => {
                println!("Exiting application...");
                break;
            }
            _ => {
                println!("Unknown command. Type 'l', 'a', 't', 'r', 's', 'o', or 'e'.");
            }
        }

        // Check async background message
        if let Ok(msg) = async_rx.try_recv() {
            println!("[ASYNC NOTIFY]: {}", msg);
        }
    }

    println!("Total todos created in session: {}", TOTAL_TODOS_CREATED.load(AtomicOrdering::SeqCst));
    Ok(())
}

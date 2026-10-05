use std::sync::mpsc;
use std::thread;

#[derive(Debug)]
pub struct DataProcessor {
    pub name: String,
    pub buffer: Vec<i32>,
}

impl DataProcessor {
    pub fn new(name: &str) -> Self {
        DataProcessor {
            name: name.to_string(),
            buffer: vec![10, 20, 30, 40, 50],
        }
    }

    // --- PART 1: SIMPLE SECTION ---

    pub fn print_and_clear(&mut self) {
        let first_element = &self.buffer[0];

        // MISTAKE #1: Can you spot what happens here?
        self.buffer.clear();

        println!("First element was: {}", first_element);
    }

    pub fn inspect_name(&self) {
        println!("Processor name: {}", self.name);
    }
}

// --- PART 2: MORE COMPLEX SECTION ---

pub fn run_pipeline(processor: DataProcessor) {
    let (tx, rx) = mpsc::channel();

    // Spawn a worker thread to process numbers
    let handle = thread::spawn(move || {
        let mut sum = 0;
        for val in &processor.buffer {
            sum += val;
        }
        tx.send(sum).unwrap();
        
        // MISTAKE #2: Can you spot what happens here with processor?
    });

    // MISTAKE #3: Can you spot what happens here on the main thread?
    processor.inspect_name();

    let result = rx.recv().unwrap();
    println!("Pipeline result sum: {}", result);

    handle.join().unwrap();
}

fn main() {
    let mut proc = DataProcessor::new("Alpha");

    // Try running simple section
    proc.print_and_clear();

    // Try running pipeline section
    run_pipeline(proc);
}

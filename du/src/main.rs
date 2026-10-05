use axum::{
    routing::get,
    Router,
};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;

#[tokio::main]
async fn main() {
    // Build our application with a single route for "/"
    let app = Router::new().route("/", get(hit_handler));

    // Bind listener to port 3000
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await.unwrap();
    println!("Server running on http://127.0.0.1:3000");

    // Run the Axum server
    axum::serve(listener, app).await.unwrap();
}

async fn hit_handler() -> &'static str {
    // Open `log.bin` in append mode, creating it if it doesn't exist
    let result = OpenOptions::new()
        .create(true)
        .append(true)
        .open("log.bin")
        .await;

    if let Ok(mut file) = result {
        // Write "hit" followed by a newline into log.bin
        if let Err(e) = file.write_all(b"hit\n").await {
            eprintln!("Failed to write to log.bin: {}", e);
        }
    } else {
        eprintln!("Failed to open log.bin");
    }

    "Hit recorded!"
}

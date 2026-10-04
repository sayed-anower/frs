use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpListener;

fn main() -> std::io::Result<()> {
    // Create or truncate the file initially with "# Log\n"
    let mut initial_file = File::create("log.txt")?;
    initial_file.write_all(b"# Log\n")?;

    // Bind web server to localhost:8080
    let listener = TcpListener::bind("127.0.0.1:8080")?;
    println!("Server running on http://127.0.0.1:8080");

    for stream in listener.incoming() {
        let mut stream = match stream {
            Ok(s) => s,
            Err(_) => continue,
        };

        let mut buffer = [0; 1024];
        let bytes_read = stream.read(&mut buffer)?;
        let request = String::from_utf8_lossy(&buffer[..bytes_read]);

        // Check if HTTP request target is /log
        if request.starts_with("GET /log ") {
            // Append "1\n2\n" to log.txt
            if let Ok(mut log_file) = OpenOptions::new().append(true).open("log.txt") {
                let _ = log_file.write_all(b"1\n2\n");
            }

            let response = "HTTP/1.1 200 OK\r\nContent-Length: 15\r\n\r\nLogged 1 and 2!";
            let _ = stream.write_all(response.as_bytes());
        } else {
            let response = "HTTP/1.1 404 NOT FOUND\r\nContent-Length: 9\r\n\r\nNot Found";
            let _ = stream.write_all(response.as_bytes());
        }
    }

    Ok(())
}

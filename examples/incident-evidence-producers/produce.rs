//! Minimal Rust sketch for building a directory-form Incident Evidence Bundle v1.
//! Not a library API — copy the idea into your collector.

use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::Path;

fn sha256_file(path: &Path) -> (u64, String) {
    let mut f = fs::File::open(path).expect("open");
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    let mut total = 0u64;
    loop {
        let n = f.read(&mut buf).expect("read");
        if n == 0 {
            break;
        }
        total += n as u64;
        hasher.update(&buf[..n]);
    }
    let hex = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    (total, hex)
}

fn main() {
    let root = Path::new("./incident-evidence-out");
    let log_rel = "logs/app.log";
    let log_path = root.join(log_rel);
    fs::create_dir_all(log_path.parent().unwrap()).unwrap();
    fs::write(&log_path, b"2024-01-15T12:00:00Z INFO synthetic\n").unwrap();
    let (bytes, sha256) = sha256_file(&log_path);

    let manifest = serde_json::json!({
        "schemaId": "contextdesk.incident_evidence.v1",
        "minReaderVersion": 1,
        "bundleId": "example-rust-bundle",
        "createdAt": "2024-01-15T12:05:00Z",
        "producer": { "name": "example-rust-collector", "version": "0.1.0" },
        "privacy": {
            "redactionDeclared": true,
            "containsCredentials": false,
            "containsPii": false
        },
        "timeBasis": { "timezone": "UTC", "timezoneResolved": true },
        "components": [{
            "id": "log-app",
            "role": "log",
            "path": log_rel,
            "mediaType": "text/plain",
            "bytes": bytes,
            "sha256": sha256,
            "sourceLabel": "app"
        }]
    });
    fs::write(
        root.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();
    eprintln!("wrote {}", root.display());
}

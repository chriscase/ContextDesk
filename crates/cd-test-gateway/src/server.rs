//! The scripted server: binds a loopback port and serves connections
//! according to a `Step` script.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

use crate::request::{read_request, RecordedRequest};
use crate::script::{Body, Response, Step};

/// A running scripted gateway. Dropping it aborts the accept loop and
/// releases the port; requests recorded before the drop remain readable.
pub struct MockGateway {
    base_url: String,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    accepted: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for MockGateway {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl MockGateway {
    /// Serve accepted connections **in order** against `steps`: the Nth
    /// connection gets `steps[N]`; once the script is exhausted, every
    /// further connection repeats the last step (convenient for "keeps
    /// returning the terminal state" scenarios without padding the vector).
    /// Connections are accepted strictly one at a time — the (N+1)th
    /// connection is not even `accept()`-ed until the Nth has been fully
    /// served — which is what makes this the right mode for sequential
    /// retry/backoff scripts where call order is the assertion.
    ///
    /// Panics (at bind time only) if `steps` is empty.
    pub async fn start_ordered(steps: Vec<Step>) -> Self {
        assert!(
            !steps.is_empty(),
            "start_ordered requires at least one Step"
        );
        let (listener, base_url) = bind_loopback();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let accepted = Arc::new(AtomicUsize::new(0));

        let requests_task = requests.clone();
        let accepted_task = accepted.clone();
        let task = tokio::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).expect("tokio listener");
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let index = accepted_task.fetch_add(1, Ordering::SeqCst);
                let step = steps
                    .get(index)
                    .cloned()
                    .unwrap_or_else(|| steps.last().cloned().expect("non-empty script"));
                serve_one(stream, step, index, &requests_task).await;
            }
        });

        Self {
            base_url,
            requests,
            accepted,
            task,
        }
    }

    /// Serve an unbounded number of connections **concurrently**: each
    /// accepted connection is handled on its own task immediately, so
    /// multiple requests can be in flight (and mid-delay) at once. `route`
    /// decides the `Step` for each request after it has been fully read —
    /// match on method/path/headers/body, or close over an `Arc<AtomicUsize>`
    /// for call-index-dependent behavior.
    ///
    /// Use this for fan-out scenarios (concurrent embedding batches,
    /// parallel discovery probes) where `start_ordered`'s one-at-a-time
    /// acceptance would serialize requests the production code intentionally
    /// issues in parallel.
    pub async fn start_routed<F>(route: F) -> Self
    where
        F: Fn(&RecordedRequest) -> Step + Send + Sync + 'static,
    {
        let (listener, base_url) = bind_loopback();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let accepted = Arc::new(AtomicUsize::new(0));
        let route = Arc::new(route);

        let requests_task = requests.clone();
        let accepted_task = accepted.clone();
        let task = tokio::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).expect("tokio listener");
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let index = accepted_task.fetch_add(1, Ordering::SeqCst);
                let requests_conn = requests_task.clone();
                let route = route.clone();
                tokio::spawn(async move {
                    let Some(mut request) = read_request(&mut stream).await else {
                        return;
                    };
                    request.seq = index;
                    let step = route(&request);
                    requests_conn.lock().expect("requests lock").push(request);
                    match step {
                        Step::Respond(response) => write_response(stream, response).await,
                        Step::CloseBeforeHeaders { reset } => hard_close(stream, reset).await,
                        Step::Stall => std::future::pending::<()>().await,
                    }
                });
            }
        });

        Self {
            base_url,
            requests,
            accepted,
            task,
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn request_count(&self) -> usize {
        self.accepted.load(Ordering::SeqCst)
    }

    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().expect("requests lock").clone()
    }
}

fn bind_loopback() -> (std::net::TcpListener, String) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    listener.set_nonblocking(true).expect("nonblocking");
    let port = listener.local_addr().expect("local addr").port();
    (listener, format!("http://127.0.0.1:{port}"))
}

async fn serve_one(
    mut stream: TcpStream,
    step: Step,
    index: usize,
    requests: &Arc<Mutex<Vec<RecordedRequest>>>,
) {
    let Some(mut request) = read_request(&mut stream).await else {
        return;
    };
    request.seq = index;
    requests.lock().expect("requests lock").push(request);

    match step {
        Step::Respond(response) => write_response(stream, response).await,
        Step::CloseBeforeHeaders { reset } => hard_close(stream, reset).await,
        Step::Stall => std::future::pending::<()>().await,
    }
}

async fn write_response(mut stream: TcpStream, resp: Response) {
    if resp.header_delay > Duration::ZERO {
        tokio::time::sleep(resp.header_delay).await;
    }

    let mut explicit_content_length = false;
    let mut explicit_connection = false;
    let mut explicit_transfer_encoding = false;
    for (k, _) in &resp.headers {
        let lk = k.to_ascii_lowercase();
        explicit_content_length |= lk == "content-length";
        explicit_connection |= lk == "connection";
        explicit_transfer_encoding |= lk == "transfer-encoding";
    }

    let mut head = format!(
        "HTTP/1.1 {} {}\r\n",
        resp.status,
        reason_phrase(resp.status)
    );
    for (k, v) in &resp.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    match &resp.body {
        Body::Empty if !explicit_content_length => head.push_str("content-length: 0\r\n"),
        Body::Fixed { data, .. } if !explicit_content_length => {
            head.push_str(&format!("content-length: {}\r\n", data.len()));
        }
        Body::FixedFragments(frames) if !explicit_content_length => {
            let total: usize = frames.iter().map(|f| f.data.len()).sum();
            head.push_str(&format!("content-length: {total}\r\n"));
        }
        Body::FixedThenDrop { declared_len, .. } if !explicit_content_length => {
            head.push_str(&format!("content-length: {declared_len}\r\n"));
        }
        Body::Chunked(_) | Body::ChunkedThenDrop { .. } if !explicit_transfer_encoding => {
            head.push_str("transfer-encoding: chunked\r\n");
        }
        _ => {}
    }
    if !explicit_connection {
        head.push_str("connection: close\r\n");
    }
    head.push_str("\r\n");

    if stream.write_all(head.as_bytes()).await.is_err() {
        return;
    }
    if stream.flush().await.is_err() {
        return;
    }

    match resp.body {
        Body::Empty => {}
        Body::Fixed { data, delay } => {
            if delay > Duration::ZERO {
                tokio::time::sleep(delay).await;
            }
            let _ = stream.write_all(&data).await;
        }
        Body::FixedFragments(frames) | Body::Stream(frames) => {
            for f in frames {
                if f.delay > Duration::ZERO {
                    tokio::time::sleep(f.delay).await;
                }
                if stream.write_all(&f.data).await.is_err() {
                    return;
                }
                let _ = stream.flush().await;
                tokio::task::yield_now().await;
            }
        }
        Body::FixedThenDrop { sent, reset, .. } => {
            let _ = stream.write_all(&sent).await;
            let _ = stream.flush().await;
            hard_close(stream, reset).await;
        }
        Body::Chunked(frames) => {
            for f in frames {
                if f.delay > Duration::ZERO {
                    tokio::time::sleep(f.delay).await;
                }
                if write_chunk(&mut stream, &f.data).await.is_err() {
                    return;
                }
                tokio::task::yield_now().await;
            }
            let _ = stream.write_all(b"0\r\n\r\n").await;
            let _ = stream.flush().await;
        }
        Body::ChunkedThenDrop { frames, reset } => {
            for f in frames {
                if f.delay > Duration::ZERO {
                    tokio::time::sleep(f.delay).await;
                }
                if write_chunk(&mut stream, &f.data).await.is_err() {
                    return;
                }
                tokio::task::yield_now().await;
            }
            hard_close(stream, reset).await;
        }
        Body::NeverEnds => {
            std::future::pending::<()>().await;
        }
    }
}

async fn write_chunk(stream: &mut TcpStream, data: &[u8]) -> std::io::Result<()> {
    stream
        .write_all(format!("{:x}\r\n", data.len()).as_bytes())
        .await?;
    stream.write_all(data).await?;
    stream.write_all(b"\r\n").await?;
    stream.flush().await
}

async fn hard_close(mut stream: TcpStream, reset: bool) {
    if reset {
        // SO_LINGER(0) turns the eventual close into a real TCP RST rather
        // than a graceful FIN — deprecated because linger can block on
        // drop, but a zero timeout aborts instead, which is the point.
        #[allow(deprecated)]
        let _ = stream.set_linger(Some(Duration::ZERO));
    }
    let _ = stream.shutdown().await;
    drop(stream);
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Status",
    }
}

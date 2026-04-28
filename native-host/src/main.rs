use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

const HOST_VERSION: &str = env!("CARGO_PKG_VERSION");
const COMPATIBLE_FORMAT_SELECTOR: &str =
    "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*[ext=mp4][vcodec!*=av01]+ba[ext=m4a]/b[ext=mp4]/best[ext=mp4]/best";

type SharedWriter = Arc<Mutex<io::Stdout>>;
type SharedState = Arc<Mutex<HostState>>;

#[derive(Default)]
struct HostState {
    active_job: Option<String>,
    active_pid: Option<u32>,
    cancelled_jobs: HashSet<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum Request {
    #[serde(rename = "ping")]
    Ping { id: Option<String> },
    #[serde(rename = "checkTools")]
    CheckTools { id: Option<String> },
    #[serde(rename = "download")]
    Download { id: String, payload: DownloadPayload },
    #[serde(rename = "cancel")]
    Cancel {
        id: Option<String>,
        #[serde(rename = "jobId")]
        job_id: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadPayload {
    page_url: Option<String>,
    media_url: Option<String>,
    title: Option<String>,
    use_cookies: Option<bool>,
    cookies_browser: Option<String>,
    output_dir: Option<String>,
    prefer_page_url: Option<bool>,
}

#[derive(Clone, Debug)]
struct ToolStatus {
    yt_dlp: Option<PathBuf>,
    ffmpeg: Option<PathBuf>,
}

#[derive(Clone, Debug)]
struct DownloadTarget {
    url: String,
    referer: Option<String>,
}

enum RunResult {
    Success,
    Failed(String),
    Cancelled,
}

fn main() {
    let writer: SharedWriter = Arc::new(Mutex::new(io::stdout()));
    let state: SharedState = Arc::new(Mutex::new(HostState::default()));

    send_message(
        &writer,
        &json!({
            "type": "ready",
            "hostVersion": HOST_VERSION
        }),
    );

    loop {
        let Some(value) = read_message() else {
            break;
        };

        let request = serde_json::from_value::<Request>(value);
        match request {
            Ok(Request::Ping { id }) => {
                send_message(
                    &writer,
                    &json!({
                        "type": "pong",
                        "id": id,
                        "hostVersion": HOST_VERSION
                    }),
                );
            }
            Ok(Request::CheckTools { id }) => {
                send_tool_status(&writer, id.as_deref(), &resolve_tools());
            }
            Ok(Request::Download { id, payload }) => {
                handle_download(id, payload, Arc::clone(&writer), Arc::clone(&state));
            }
            Ok(Request::Cancel { id, job_id }) => {
                handle_cancel(id, job_id, Arc::clone(&writer), Arc::clone(&state));
            }
            Err(error) => {
                send_message(
                    &writer,
                    &json!({
                        "type": "error",
                        "error": format!("invalid request: {error}")
                    }),
                );
            }
        }
    }
}

fn read_message() -> Option<Value> {
    let mut stdin = io::stdin();
    let mut length_bytes = [0_u8; 4];

    if stdin.read_exact(&mut length_bytes).is_err() {
        return None;
    }

    let length = u32::from_le_bytes(length_bytes) as usize;
    if length == 0 || length > 16 * 1024 * 1024 {
        return None;
    }

    let mut buffer = vec![0_u8; length];
    if stdin.read_exact(&mut buffer).is_err() {
        return None;
    }

    serde_json::from_slice(&buffer).ok()
}

fn send_message(writer: &SharedWriter, message: &Value) {
    let Ok(payload) = serde_json::to_vec(message) else {
        return;
    };

    let Ok(length) = u32::try_from(payload.len()) else {
        return;
    };

    if let Ok(mut stdout) = writer.lock() {
        let _ = stdout.write_all(&length.to_le_bytes());
        let _ = stdout.write_all(&payload);
        let _ = stdout.flush();
    }
}

fn handle_download(
    request_id: String,
    payload: DownloadPayload,
    writer: SharedWriter,
    state: SharedState,
) {
    let job_id = format!("job-{}", now_millis());
    let output_dir = payload
        .output_dir
        .as_deref()
        .map(expand_env_path)
        .unwrap_or_else(default_output_dir);

    let targets = select_targets(&payload);
    let Some(primary_target) = targets.first().cloned() else {
        send_message(
            &writer,
            &json!({
                "type": "error",
                "id": request_id,
                "error": "no valid http(s) target was provided"
            }),
        );
        return;
    };

    let tools = resolve_tools();
    let missing = missing_tools(&tools);
    if !missing.is_empty() {
        send_message(
            &writer,
            &json!({
                "type": "error",
                "id": request_id,
                "error": format!("missing required native tools: {}", missing.join(", "))
            }),
        );
        return;
    }

    {
        let mut locked = state.lock().expect("state lock poisoned");
        if let Some(active_job) = &locked.active_job {
            send_message(
                &writer,
                &json!({
                    "type": "error",
                    "id": request_id,
                    "error": "another native download is already running",
                    "jobId": active_job
                }),
            );
            return;
        }

        locked.active_job = Some(job_id.clone());
        locked.active_pid = None;
        locked.cancelled_jobs.remove(&job_id);
    }

    let title = payload.title.clone().unwrap_or_else(|| "video".to_string());
    send_message(
        &writer,
        &json!({
            "type": "started",
            "id": request_id,
            "jobId": job_id,
            "title": title,
            "target": primary_target.url,
            "outputDir": output_dir.to_string_lossy()
        }),
    );

    thread::spawn(move || {
        if let Err(error) = fs::create_dir_all(&output_dir) {
            send_job_error(&writer, &job_id, format!("cannot create output directory: {error}"));
            clear_active_job(&state, &job_id);
            return;
        }

        let fallback_target = targets.get(1).cloned();
        let first = run_yt_dlp(
            &job_id,
            &payload,
            &primary_target,
            &output_dir,
            &tools,
            Arc::clone(&writer),
            Arc::clone(&state),
        );

        let final_result = match (first, fallback_target) {
            (RunResult::Failed(error), Some(fallback)) => {
                send_progress(
                    &writer,
                    &job_id,
                    &format!("primary target failed, retrying detected media URL: {error}"),
                    None,
                );
                run_yt_dlp(
                    &job_id,
                    &payload,
                    &fallback,
                    &output_dir,
                    &tools,
                    Arc::clone(&writer),
                    Arc::clone(&state),
                )
            }
            (result, _) => result,
        };

        match final_result {
            RunResult::Success => {
                send_message(
                    &writer,
                    &json!({
                        "type": "done",
                        "jobId": job_id,
                        "outputDir": output_dir.to_string_lossy()
                    }),
                );
            }
            RunResult::Failed(error) => send_job_error(&writer, &job_id, error),
            RunResult::Cancelled => {
                send_message(
                    &writer,
                    &json!({
                        "type": "cancelled",
                        "jobId": job_id
                    }),
                );
            }
        }

        clear_active_job(&state, &job_id);
    });
}

fn handle_cancel(
    request_id: Option<String>,
    job_id: Option<String>,
    writer: SharedWriter,
    state: SharedState,
) {
    let (target_job, target_pid) = {
        let mut locked = state.lock().expect("state lock poisoned");
        let active = locked.active_job.clone();
        let should_cancel = match (&job_id, &active) {
            (Some(requested), Some(active_job)) => requested == active_job,
            (None, Some(_)) => true,
            _ => false,
        };

        if should_cancel {
            if let Some(active_job) = &active {
                locked.cancelled_jobs.insert(active_job.clone());
            }
            (active, locked.active_pid)
        } else {
            (None, None)
        }
    };

    if let Some(pid) = target_pid {
        let _ = kill_process_tree(pid);
    }

    send_message(
        &writer,
        &json!({
            "type": "cancelled",
            "id": request_id,
            "jobId": target_job,
            "ok": true
        }),
    );
}

fn send_tool_status(writer: &SharedWriter, request_id: Option<&str>, tools: &ToolStatus) {
    let missing = missing_tools(tools);
    send_message(
        writer,
        &json!({
            "type": "tools",
            "id": request_id,
            "ok": missing.is_empty(),
            "hostVersion": HOST_VERSION,
            "ytDlp": {
                "found": tools.yt_dlp.is_some(),
                "path": tools.yt_dlp.as_ref().map(|path| path.to_string_lossy().to_string())
            },
            "ffmpeg": {
                "found": tools.ffmpeg.is_some(),
                "path": tools.ffmpeg.as_ref().map(|path| path.to_string_lossy().to_string())
            },
            "missing": missing
        }),
    );
}

fn send_job_error(writer: &SharedWriter, job_id: &str, error: impl Into<String>) {
    send_message(
        writer,
        &json!({
            "type": "error",
            "jobId": job_id,
            "error": error.into()
        }),
    );
}

fn send_progress(writer: &SharedWriter, job_id: &str, line: &str, percent: Option<f64>) {
    send_message(
        writer,
        &json!({
            "type": "progress",
            "jobId": job_id,
            "line": line,
            "percent": percent
        }),
    );
}

fn run_yt_dlp(
    job_id: &str,
    payload: &DownloadPayload,
    target: &DownloadTarget,
    output_dir: &Path,
    tools: &ToolStatus,
    writer: SharedWriter,
    state: SharedState,
) -> RunResult {
    let Some(yt_dlp) = &tools.yt_dlp else {
        return RunResult::Failed("yt-dlp.exe was not found".to_string());
    };
    let Some(ffmpeg) = &tools.ffmpeg else {
        return RunResult::Failed("ffmpeg.exe was not found".to_string());
    };

    send_progress(&writer, job_id, &format!("yt-dlp target: {}", target.url), None);

    let mut command = Command::new(yt_dlp);
    command
        .arg("--newline")
        .arg("--no-playlist")
        .arg("--restrict-filenames")
        .arg("--ffmpeg-location")
        .arg(ffmpeg.parent().unwrap_or_else(|| Path::new(".")))
        .arg("-f")
        .arg(COMPATIBLE_FORMAT_SELECTOR)
        .arg("--merge-output-format")
        .arg("mp4")
        .arg("-o")
        .arg(output_dir.join("%(title).200B [%(id)s].%(ext)s"));

    if let Some(referer) = target.referer.as_deref().filter(|value| is_http_url(value)) {
        command.arg("--referer").arg(referer);
    }

    if payload.use_cookies.unwrap_or(false) {
        command
            .arg("--cookies-from-browser")
            .arg(sanitize_cookie_browser(payload.cookies_browser.as_deref()));
    }

    command
        .arg(&target.url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return RunResult::Failed(format!("cannot start yt-dlp: {error}")),
    };

    {
        let mut locked = state.lock().expect("state lock poisoned");
        locked.active_pid = Some(child.id());
    }

    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let stdout_thread = child.stdout.take().map(|stdout| {
        spawn_output_reader(
            BufReader::new(stdout),
            job_id.to_string(),
            Arc::clone(&writer),
            Arc::clone(&tail),
        )
    });
    let stderr_thread = child.stderr.take().map(|stderr| {
        spawn_output_reader(
            BufReader::new(stderr),
            job_id.to_string(),
            Arc::clone(&writer),
            Arc::clone(&tail),
        )
    });

    let status = match child.wait() {
        Ok(status) => status,
        Err(error) => return RunResult::Failed(format!("yt-dlp wait failed: {error}")),
    };

    if let Some(handle) = stdout_thread {
        let _ = handle.join();
    }
    if let Some(handle) = stderr_thread {
        let _ = handle.join();
    }

    {
        let mut locked = state.lock().expect("state lock poisoned");
        if locked.active_job.as_deref() == Some(job_id) {
            locked.active_pid = None;
        }
        if locked.cancelled_jobs.contains(job_id) {
            return RunResult::Cancelled;
        }
    }

    if status.success() {
        return RunResult::Success;
    }

    let summary = tail
        .lock()
        .ok()
        .and_then(|lines| lines.iter().rev().find(|line| line.contains("ERROR:")).cloned())
        .or_else(|| {
            tail.lock().ok().and_then(|lines| {
                let text = lines
                    .iter()
                    .rev()
                    .take(3)
                    .cloned()
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join(" | ");
                if text.is_empty() { None } else { Some(text) }
            })
        })
        .unwrap_or_else(|| format!("yt-dlp exited with status {status}"));

    RunResult::Failed(summary)
}

fn spawn_output_reader<R: Read + Send + 'static>(
    reader: BufReader<R>,
    job_id: String,
    writer: SharedWriter,
    tail: Arc<Mutex<Vec<String>>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for line in reader.lines().map_while(Result::ok) {
            let cleaned = line.trim().to_string();
            if cleaned.is_empty() {
                continue;
            }

            if let Ok(mut locked) = tail.lock() {
                locked.push(cleaned.clone());
                if locked.len() > 24 {
                    locked.remove(0);
                }
            }

            let percent = parse_progress_percent(&cleaned);
            send_progress(&writer, &job_id, &cleaned, percent);
        }
    })
}

fn select_targets(payload: &DownloadPayload) -> Vec<DownloadTarget> {
    let page_url = payload.page_url.as_deref().filter(|value| is_http_url(value));
    let media_url = payload.media_url.as_deref().filter(|value| is_http_url(value));
    let prefer_page = payload.prefer_page_url.unwrap_or(true);
    let mut targets = Vec::new();

    let mut push_unique = |url: &str, referer: Option<&str>| {
        if targets.iter().any(|target: &DownloadTarget| target.url == url) {
            return;
        }
        targets.push(DownloadTarget {
            url: url.to_string(),
            referer: referer.map(ToOwned::to_owned),
        });
    };

    if prefer_page {
        if let Some(url) = page_url {
            push_unique(url, None);
        }
        if let Some(url) = media_url {
            push_unique(url, page_url);
        }
    } else {
        if let Some(url) = media_url {
            push_unique(url, page_url);
        }
        if let Some(url) = page_url {
            push_unique(url, None);
        }
    }

    targets
}

fn resolve_tools() -> ToolStatus {
    ToolStatus {
        yt_dlp: find_tool("yt-dlp.exe"),
        ffmpeg: find_tool("ffmpeg.exe"),
    }
}

fn missing_tools(tools: &ToolStatus) -> Vec<&'static str> {
    let mut missing = Vec::new();
    if tools.yt_dlp.is_none() {
        missing.push("yt-dlp.exe");
    }
    if tools.ffmpeg.is_none() {
        missing.push("ffmpeg.exe");
    }
    missing
}

fn find_tool(name: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name));
            candidates.push(dir.join("tools").join(name));
            if let Some(native_root) = dir.parent().and_then(Path::parent) {
                candidates.push(native_root.join("tools").join(name));
            }
        }
    }

    if let Some(path) = find_in_path(name) {
        candidates.push(path);
    }

    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| fs::canonicalize(&candidate).ok().or(Some(candidate)))
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    env::split_paths(&path_var)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

fn default_output_dir() -> PathBuf {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Downloads")
        .join("Video Catcher")
}

fn expand_env_path(input: &str) -> PathBuf {
    let mut output = String::new();
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '%' {
            output.push(ch);
            continue;
        }

        let mut name = String::new();
        while let Some(next) = chars.peek().copied() {
            chars.next();
            if next == '%' {
                break;
            }
            name.push(next);
        }

        if name.is_empty() {
            output.push('%');
            continue;
        }

        match env::var(&name) {
            Ok(value) => output.push_str(&value),
            Err(_) => {
                output.push('%');
                output.push_str(&name);
                output.push('%');
            }
        }
    }

    PathBuf::from(output)
}

fn sanitize_cookie_browser(value: Option<&str>) -> &'static str {
    match value.unwrap_or("brave").to_ascii_lowercase().as_str() {
        "chrome" => "chrome",
        "edge" => "edge",
        "firefox" => "firefox",
        "opera" => "opera",
        "vivaldi" => "vivaldi",
        _ => "brave",
    }
}

fn is_http_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn parse_progress_percent(line: &str) -> Option<f64> {
    let percent_index = line.find('%')?;
    let before = &line[..percent_index];
    let start = before
        .rfind(|ch: char| !(ch.is_ascii_digit() || ch == '.' || ch.is_ascii_whitespace()))
        .map(|index| index + 1)
        .unwrap_or(0);
    let number = before[start..].trim();
    number.parse::<f64>().ok().filter(|value| (0.0..=100.0).contains(value))
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn kill_process_tree(pid: u32) -> io::Result<()> {
    #[cfg(windows)]
    {
        Command::new("taskkill.exe")
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/T")
            .arg("/F")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|_| ())
    }

    #[cfg(not(windows))]
    {
        Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|_| ())
    }
}

fn clear_active_job(state: &SharedState, job_id: &str) {
    let mut locked = state.lock().expect("state lock poisoned");
    if locked.active_job.as_deref() == Some(job_id) {
        locked.active_job = None;
        locked.active_pid = None;
    }
    locked.cancelled_jobs.remove(job_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_yt_dlp_percent() {
        assert_eq!(
            parse_progress_percent("[download]  42.3% of 10.00MiB at 1.2MiB/s ETA 00:04"),
            Some(42.3)
        );
        assert_eq!(parse_progress_percent("[Merger] Merging formats"), None);
    }

    #[test]
    fn prefers_page_url_and_keeps_media_fallback() {
        let payload = DownloadPayload {
            page_url: Some("https://example.com/watch/1".to_string()),
            media_url: Some("https://cdn.example.com/video.mp4".to_string()),
            title: None,
            use_cookies: None,
            cookies_browser: None,
            output_dir: None,
            prefer_page_url: Some(true),
        };
        let targets = select_targets(&payload);
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].url, "https://example.com/watch/1");
        assert_eq!(targets[1].url, "https://cdn.example.com/video.mp4");
        assert_eq!(targets[1].referer.as_deref(), Some("https://example.com/watch/1"));
    }

    #[test]
    fn expands_percent_environment_variables() {
        env::set_var("VC_TEST_HOME", "C:\\Users\\Test");
        assert_eq!(
            expand_env_path("%VC_TEST_HOME%\\Downloads")
                .to_string_lossy()
                .to_string(),
            "C:\\Users\\Test\\Downloads"
        );
    }
}

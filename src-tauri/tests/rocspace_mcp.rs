//! The `rocspace-mcp` binary, driven the way an agent CLI drives it.
//!
//! `src/mcp/mod.rs` tests the protocol against `handle_line`, which proves the
//! logic and nothing about the thing that actually ships. Everything between
//! that function and a working server is here: that the binary exists under the
//! hyphenated name the MCP config points at, that it takes the project path off
//! argv, that stdout carries one JSON object per line and NOTHING else, that
//! responses arrive while the client is still holding the pipe open — and that
//! the file left behind is a board the app can read.
//!
//! Written against a temporary directory so the suite never touches the
//! repository's own `.rocspace/plan.json`.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};

/// Cargo builds the binary before running this test and hands over its path,
/// so there is no `target/debug` guesswork and no chance of driving a stale
/// build.
const BINARY: &str = env!("CARGO_BIN_EXE_rocspace-mcp");

/// A live server plus the two pipe halves, so a test reads as the transcript it
/// is.
struct Session {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Session {
    fn start(project: &Path) -> Self {
        let mut child = Command::new(BINARY)
            .arg(project)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // stderr is inherited: a panic in the server shows up in the test
            // output instead of disappearing into a pipe nobody reads.
            .spawn()
            .expect("rocspace-mcp starts");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = BufReader::new(child.stdout.take().expect("stdout"));
        Self {
            child,
            stdin,
            stdout,
        }
    }

    /// Send a request and read the one line it answers with.
    fn request(&mut self, request: Value) -> Value {
        self.send(request);
        let mut line = String::new();
        let read = self.stdout.read_line(&mut line).expect("read a response");
        assert_ne!(read, 0, "the server closed stdout instead of answering");
        serde_json::from_str(&line)
            .unwrap_or_else(|e| panic!("not one JSON object: {line:?} ({e})"))
    }

    /// Send something that earns no reply — a notification, or a line the
    /// server is expected to answer only when the NEXT request comes in.
    fn send(&mut self, message: Value) {
        writeln!(self.stdin, "{message}").expect("write a request");
        self.stdin.flush().expect("flush");
    }

    fn call(&mut self, id: i64, name: &str, arguments: Value) -> Value {
        self.request(json!({
            "jsonrpc": "2.0", "id": id, "method": "tools/call",
            "params": { "name": name, "arguments": arguments },
        }))
    }

    /// Close stdin and wait. Returns the exit status; a server that hangs here
    /// is a server that would outlive its agent session.
    fn finish(mut self) -> std::process::ExitStatus {
        drop(self.stdin);
        self.child
            .wait()
            .expect("the server exits when stdin closes")
    }
}

/// The text content of a tool result, and whether it was flagged as an error.
fn content(response: &Value) -> (String, bool) {
    let result = response
        .get("result")
        .unwrap_or_else(|| panic!("expected a tool result, got {response}"));
    (
        result["content"][0]["text"]
            .as_str()
            .expect("text content")
            .to_string(),
        result["isError"].as_bool().expect("isError"),
    )
}

#[test]
fn a_full_session_drives_the_board_from_empty_to_in_review() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let project = tmp.path();
    let mut session = Session::start(project);

    // -- initialize / initialized -------------------------------------------
    let initialized = session.request(json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "claude-code", "version": "test" },
        },
    }));
    assert_eq!(initialized["jsonrpc"], "2.0");
    assert_eq!(initialized["id"], 1);
    assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(initialized["result"]["serverInfo"]["name"], "rocspace-mcp");
    assert!(initialized["result"]["capabilities"]["tools"].is_object());

    // The handshake's third leg earns no response. Nothing reads a line here —
    // if the server answered it, the assertion on the NEXT response's id fails,
    // which is exactly the desynchronisation a real client would suffer.
    session.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));

    // -- tools/list ----------------------------------------------------------
    let listed = session.request(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
    assert_eq!(listed["id"], 2, "the notification was answered");
    let names: Vec<&str> = listed["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|t| t["name"].as_str().expect("name"))
        .collect();
    // The board's five, and only those: RocMind's three are offered only for a
    // project that HAS memories under `~/.claude/projects`, and this one is a
    // temporary directory nothing has ever written a memory about. (That is
    // also what keeps this assertion from depending on the developer's own
    // corpus — see `mcp::tests::corpus` for the memory tools' own coverage.)
    assert_eq!(
        names,
        vec![
            "rocplan_list_tasks",
            "rocplan_get_task",
            "rocplan_create_task",
            "rocplan_update_task_status",
            "rocplan_append_finding",
        ]
    );

    // -- an empty board ------------------------------------------------------
    let (empty, is_error) = content(&session.call(3, "rocplan_list_tasks", json!({})));
    assert!(!is_error, "{empty}");
    assert!(empty.contains("empty"), "{empty}");

    // -- create --------------------------------------------------------------
    let (created, is_error) = content(&session.call(
        4,
        "rocplan_create_task",
        json!({
            "title": "Teach the watcher to ignore our own writes",
            "description": "Compare the stamp plan_write reported.",
            "priority": "high",
        }),
    ));
    assert!(!is_error, "{created}");
    let created: Value = serde_json::from_str(&created).expect("a task");
    let id = created["id"].as_str().expect("an id").to_string();
    assert_eq!(created["status"], "todo");
    assert_eq!(created["priority"], "high");

    // -- move ----------------------------------------------------------------
    let (moved, is_error) = content(&session.call(
        5,
        "rocplan_update_task_status",
        json!({ "id": id, "status": "in_review" }),
    ));
    assert!(!is_error, "{moved}");
    assert_eq!(
        serde_json::from_str::<Value>(&moved).unwrap()["status"],
        "in_review"
    );

    // -- log something -------------------------------------------------------
    let (logged, is_error) = content(&session.call(
        6,
        "rocplan_append_finding",
        json!({ "id": id, "text": "The stamp comes off the temp file." }),
    ));
    assert!(!is_error, "{logged}");

    // -- and the board reflects all of it ------------------------------------
    let (listed, is_error) = content(&session.call(7, "rocplan_list_tasks", json!({})));
    assert!(!is_error, "{listed}");
    let tasks: Value = serde_json::from_str(&listed).expect("a task array");
    assert_eq!(tasks.as_array().expect("array").len(), 1);
    assert_eq!(tasks[0]["id"], id.as_str());

    assert_eq!(session.finish().code(), Some(0));

    // -- the file the app will open ------------------------------------------
    //
    // Asserted on the bytes rather than through the library, because the point
    // of this test is that a separate PROCESS wrote something the app can read.
    let raw = std::fs::read_to_string(project.join(".rocspace").join("plan.json"))
        .expect("the board file exists");
    let board: Value = serde_json::from_str(&raw).expect("valid JSON");
    assert_eq!(board["version"], 1);
    assert_eq!(board["tasks"][0]["id"], id.as_str());
    assert_eq!(board["tasks"][0]["status"], "in_review");
    assert_eq!(board["tasks"][0]["priority"], "high");
    assert_eq!(board["tasks"][0]["assignedTerminalName"], Value::Null);
    assert_eq!(board["tasks"][0]["findings"][0]["by"], "mcp:claude");
    assert_eq!(
        board["tasks"][0]["findings"][0]["text"],
        "The stamp comes off the temp file."
    );
}

#[test]
fn the_server_survives_everything_a_confused_client_can_send() {
    // The failure this rules out is the worst one available: a server that dies
    // on a bad line takes the board away from the agent for the rest of the
    // session, and the only symptom is tools that stopped existing.
    let tmp = tempfile::tempdir().expect("tempdir");
    let mut session = Session::start(tmp.path());

    let parse_error = session.request(json!("this is valid JSON but not a request"));
    assert_eq!(parse_error["error"]["code"], -32600);

    let unknown_method =
        session.request(json!({ "jsonrpc": "2.0", "id": 2, "method": "resources/read" }));
    assert_eq!(unknown_method["error"]["code"], -32601);

    let unknown_tool = session.call(3, "rm_minus_rf", json!({}));
    assert_eq!(unknown_tool["error"]["code"], -32602);

    let missing_task = session.call(4, "rocplan_get_task", json!({ "id": "01NOTHING" }));
    let (text, is_error) = content(&missing_task);
    assert!(is_error, "{text}");

    // Raw, un-parseable input — not even JSON.
    writeln!(session.stdin, "{{ half a line").expect("write");
    session.stdin.flush().expect("flush");
    let mut line = String::new();
    session.stdout.read_line(&mut line).expect("answered");
    assert_eq!(
        serde_json::from_str::<Value>(&line).expect("JSON")["error"]["code"],
        -32700
    );

    // Not even UTF-8. `BufRead::lines()` made one byte like this an `Err`, and
    // the process ended on it — the board gone from the agent for the rest of
    // the session, with no symptom but tools that had stopped existing.
    session.stdin.write_all(b"\xff\xfe\n").expect("write");
    session.stdin.flush().expect("flush");
    let mut line = String::new();
    session.stdout.read_line(&mut line).expect("answered");
    assert_eq!(
        serde_json::from_str::<Value>(&line).expect("JSON")["error"]["code"],
        -32700,
        "{line}"
    );

    // …and after all of that it is still a working server.
    let still_alive = session.request(json!({ "jsonrpc": "2.0", "id": 9, "method": "ping" }));
    assert_eq!(still_alive["result"], json!({}));
    assert_eq!(session.finish().code(), Some(0));
}

#[test]
fn a_project_whose_board_does_not_exist_yet_still_serves() {
    // Every project starts without a `.rocspace/`, and the directory the server
    // is pointed at may not even be there yet. Refusing to start would take the
    // tools away from exactly the sessions that would have created the first
    // card.
    let tmp = tempfile::tempdir().expect("tempdir");
    let project = tmp.path().join("not-created-yet");
    let mut session = Session::start(&project);

    let (empty, is_error) = content(&session.call(1, "rocplan_list_tasks", json!({})));
    assert!(!is_error, "{empty}");

    let (created, is_error) = content(&session.call(
        2,
        "rocplan_create_task",
        json!({ "title": "The first card" }),
    ));
    assert!(!is_error, "{created}");
    assert_eq!(session.finish().code(), Some(0));

    assert!(project.join(".rocspace").join("plan.json").is_file());
}

#[test]
fn a_board_a_newer_rocspace_wrote_survives_this_one_editing_it() {
    // The failure this rules out is a data loss with no error attached to it:
    // an agent appends one finding through this server, and every key the
    // server's schema does not have a field for — a newer RocSpace's, a
    // person's, another tool's — is gone from the user's repository. Driven
    // through the real binary because the process that does the damage is this
    // one, not the library under a test harness.
    let tmp = tempfile::tempdir().expect("tempdir");
    let project = tmp.path();
    std::fs::create_dir_all(project.join(".rocspace")).expect("dir");
    let before = json!({
        "version": 2,
        "generatedBy": "RocSpace 2",
        "columns": [{ "id": "blocked", "title": "Blocked" }],
        "tasks": [
            {
                "id": "keep",
                "title": "Has keys this version never heard of",
                "epic": "phase-4",
                "blockedBy": ["other"],
                "findings": [{ "at": 1, "by": "you", "text": "one", "commit": "abc123" }],
            },
            { "id": "unreadable", "title": 7, "note": "typed by hand, wrongly" },
        ],
    });
    std::fs::write(
        project.join(".rocspace").join("plan.json"),
        serde_json::to_vec_pretty(&before).unwrap(),
    )
    .expect("write");

    let mut session = Session::start(project);
    let (text, is_error) = content(&session.call(
        1,
        "rocplan_append_finding",
        json!({ "id": "keep", "text": "and the agent added this" }),
    ));
    assert!(!is_error, "{text}");
    assert_eq!(session.finish().code(), Some(0));

    let raw = std::fs::read_to_string(project.join(".rocspace").join("plan.json")).expect("read");
    let after: Value = serde_json::from_str(&raw).expect("valid JSON");

    assert_eq!(after["generatedBy"], "RocSpace 2");
    assert_eq!(after["columns"][0]["id"], "blocked");
    assert_eq!(after["tasks"][0]["epic"], "phase-4");
    assert_eq!(after["tasks"][0]["blockedBy"], json!(["other"]));
    assert_eq!(after["tasks"][0]["findings"][0]["commit"], "abc123");
    // The entry the parser could not read is still the user's to fix.
    assert_eq!(after["tasks"][1]["title"], 7);
    assert_eq!(after["tasks"][1]["note"], "typed by hand, wrongly");
    // …and the write the agent actually asked for happened.
    assert_eq!(
        after["tasks"][0]["findings"][1]["text"],
        "and the agent added this"
    );
}

#[test]
fn four_panes_appending_at_once_all_land_on_the_board() {
    // The shape of a real workspace: one `rocspace-mcp` per Claude pane, all of
    // them told to record what they found. Read-then-write made that
    // last-writer-wins — four at once left ONE finding on the file, forty left
    // three, and every call reported success, because each had written a whole
    // valid board over the last one. Findings are contractually append-only.
    //
    // Driven as processes rather than threads because the lock has to work
    // across a process boundary, which is the only place these writers meet.
    let tmp = tempfile::tempdir().expect("tempdir");
    let project = tmp.path();

    let mut opening = Session::start(project);
    let (created, is_error) = content(&opening.call(
        1,
        "rocplan_create_task",
        json!({ "title": "The card four panes are working" }),
    ));
    assert!(!is_error, "{created}");
    let id = serde_json::from_str::<Value>(&created).unwrap()["id"]
        .as_str()
        .expect("an id")
        .to_string();
    assert_eq!(opening.finish().code(), Some(0));

    const PANES: usize = 8;
    let children: Vec<Child> = (0..PANES)
        .map(|pane| {
            let mut child = Command::new(BINARY)
                .arg(project)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .expect("rocspace-mcp starts");
            let request = json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {
                    "name": "rocplan_append_finding",
                    "arguments": { "id": id, "text": format!("pane {pane} was here") },
                },
            });
            let mut stdin = child.stdin.take().expect("stdin");
            writeln!(stdin, "{request}").expect("write");
            // Dropped, so the server sees EOF and exits once it has answered.
            drop(stdin);
            child
        })
        .collect();

    for (pane, child) in children.into_iter().enumerate() {
        let out = child.wait_with_output().expect("finishes");
        assert!(out.status.success(), "pane {pane} exited {:?}", out.status);
        let response: Value = serde_json::from_slice(&out.stdout)
            .unwrap_or_else(|e| panic!("pane {pane}: {:?} ({e})", out.stdout));
        assert_eq!(
            response["result"]["isError"], false,
            "pane {pane}: {response}"
        );
    }

    let raw = std::fs::read_to_string(project.join(".rocspace").join("plan.json")).expect("read");
    let board: Value = serde_json::from_str(&raw).expect("valid JSON");
    let findings = board["tasks"][0]["findings"]
        .as_array()
        .expect("a findings array");
    let mut texts: Vec<&str> = findings
        .iter()
        .map(|f| f["text"].as_str().unwrap())
        .collect();
    texts.sort_unstable();
    let expected: Vec<String> = (0..PANES).map(|p| format!("pane {p} was here")).collect();
    assert_eq!(texts, expected, "a pane's finding was overwritten");

    // …and nothing was left beside the board: no lock, no temp file.
    let names: Vec<String> = std::fs::read_dir(project.join(".rocspace"))
        .expect("dir")
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["plan.json".to_string()]);
}

#[test]
fn running_it_with_no_project_path_explains_itself_and_exits() {
    let out = Command::new(BINARY)
        .stdin(Stdio::null())
        .output()
        .expect("runs");

    assert!(!out.status.success());
    assert!(out.stdout.is_empty(), "stdout belongs to the protocol");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("usage"), "{stderr}");
}

#[test]
fn a_project_path_that_is_not_absolute_is_refused_before_anything_is_written() {
    // An empty argument used to be accepted, and every path this server builds
    // is a join onto it — so `.rocspace/plan.json` resolved against the working
    // directory, which for this process is the AGENT's. The agent created a
    // board inside the repository it was working in, committed it with the
    // work, and the window's board never saw any of it.
    let tmp = tempfile::tempdir().expect("tempdir");

    for argument in ["", "   ", "relative/project", "./project", ".."] {
        let out = Command::new(BINARY)
            .arg(argument)
            .current_dir(tmp.path())
            .stdin(Stdio::null())
            .output()
            .expect("runs");

        assert!(!out.status.success(), "{argument:?} was accepted");
        assert!(out.stdout.is_empty(), "stdout belongs to the protocol");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.contains("absolute"), "{argument:?}: {stderr}");
    }

    // …and nothing was written into the directory it was started in.
    assert!(!tmp.path().join(".rocspace").exists());
}

#[test]
fn stdout_carries_the_protocol_and_nothing_else() {
    // One stray `println!` anywhere in the library this binary links — a debug
    // line, a warning about a corrupt board — is a line the client tries to
    // parse as a response, and the session is desynchronised from then on.
    let tmp = tempfile::tempdir().expect("tempdir");
    // A board file that cannot be read: the failure most likely to make some
    // layer want to print something.
    std::fs::create_dir_all(tmp.path().join(".rocspace")).expect("dir");
    std::fs::write(
        tmp.path().join(".rocspace").join("plan.json"),
        b"<<<<<<< HEAD\n",
    )
    .expect("write");

    let session = [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }).to_string(),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string(),
        json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": { "name": "rocplan_list_tasks", "arguments": {} },
        })
        .to_string(),
    ]
    .join("\n");

    let mut child = Command::new(BINARY)
        .arg(tmp.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("starts");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(session.as_bytes())
        .expect("write");
    let out = child.wait_with_output().expect("finishes");

    let lines: Vec<&str> = std::str::from_utf8(&out.stdout)
        .expect("utf-8")
        .lines()
        .collect();
    assert_eq!(lines.len(), 2, "one line per request: {lines:?}");
    for line in lines {
        serde_json::from_str::<Value>(line).unwrap_or_else(|e| panic!("{line:?}: {e}"));
    }
    // The corrupt board came back as a tool error rather than as a crash, and
    // the file itself is untouched.
    assert_eq!(
        std::fs::read(tmp.path().join(".rocspace").join("plan.json")).unwrap(),
        b"<<<<<<< HEAD\n"
    );
}

//! The MCP server behind the `rocspace-mcp` binary — the board, as five tools
//! an agent can call.
//!
//! A Claude Code pane launched in a project gets this server on its
//! `--mcp-config` (see `agents::command`), so the agent working on a card can
//! read the board, add cards, move its own card to In Review and append what it
//! found — without any of that going through the app's window.
//!
//! Hand-rolled rather than pulled in as a dependency, because the surface is
//! small and completely specified: MCP over stdio is JSON-RPC 2.0 with ONE JSON
//! object per line (no Content-Length framing — that is the HTTP transport),
//! and this server implements six methods of it. The protocol code lives in the
//! library rather than in `bin/rocspace_mcp.rs` so it can be tested without
//! spawning a process; the binary is the argv, the lock on stdin/stdout, and
//! nothing else.
//!
//! Two rules run through everything below.
//!
//! *Never exit on bad input.* This process is a child of a long-lived agent
//! session. A malformed line, an unknown method, a tool that fails — each is
//! answered and the loop carries on, because the alternative is that one
//! confused message silently removes the board from an agent's reach for the
//! rest of its life.
//!
//! *Every call re-reads the file.* The app writes this file too, and so does
//! the user. Holding the board in memory between calls would mean an agent's
//! `rocplan_update_task_status` quietly reverting a card the user dragged two
//! minutes ago. Read, modify, write atomically, drop it.

use std::io::{BufRead, Write};
use std::path::Path;

use serde_json::{json, Map, Value};

use crate::rocplan::{self, RocTask, RocTaskPriority, RocTaskStatus};

/// What `initialize` reports as `serverInfo.name`. Also the name the MCP config
/// gives the server, so it is what tool errors in a transcript are attributed
/// to.
pub const SERVER_NAME: &str = "rocspace-mcp";
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The protocol revisions this server implements, newest first.
///
/// The six methods here have been stable across all three, which is why the
/// list is a list rather than a version gate.
pub const SUPPORTED_PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// Answered when the client names no protocol version, or names one that is not
/// in `SUPPORTED_PROTOCOL_VERSIONS`.
pub const DEFAULT_PROTOCOL_VERSION: &str = SUPPORTED_PROTOCOL_VERSIONS[0];

/// The most text one tool call may put on a card.
///
/// The board file is committed to the user's repository. With no bound, a model
/// that decides the right way to record a finding is to paste a build log — or
/// a source file, or the diff it just made — commits it, and the user's next
/// `git status` is a sixty-megabyte change nobody asked for and nobody can
/// review. 64 KiB is longer than any card a person writes and short enough that
/// the accident is caught by the tool that would have caused it.
const MAX_TEXT_BYTES: usize = 64 * 1024;

/// `by` on every finding this server appends. The `mcp:` prefix is the
/// contract's marker for "this came in over the MCP server" — the board renders
/// it differently from a finding the user typed.
const FINDING_AUTHOR: &str = "mcp:claude";

// JSON-RPC 2.0 error codes.
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/// The most this server will hold for one request line.
///
/// A line with no newline in it is an unbounded allocation, and this stream is
/// written by a model. Four mebibytes is far past any real tool call and still
/// small enough that a client which has lost its framing — or is piping a file
/// in by mistake — cannot exhaust the machine. Over it, the rest of the line is
/// drained and thrown away rather than held, and the client is told.
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

/// One line's worth of input.
#[derive(Debug, PartialEq, Eq)]
enum Line {
    /// Text to handle.
    Text(String),
    /// A line longer than `MAX_LINE_BYTES`. Drained, not kept.
    TooLong,
    /// The client closed its end.
    Eof,
}

/// Read up to the next newline, holding at most `MAX_LINE_BYTES` of it.
///
/// Bytes rather than `BufRead::lines()`, and this is the whole reason: `lines()`
/// yields `Result<String>`, one byte that is not valid UTF-8 makes it an `Err`,
/// and `serve` propagated that out of the loop and ended the process. A single
/// malformed byte on the pipe — a client that split a write mid-character, a
/// binary blob sent by mistake, a terminal echoing something — took the board
/// away from the agent for the rest of the session, and the only symptom the
/// user got was tools that had stopped existing.
///
/// So the bytes are decoded lossily. The replacement characters make the line
/// invalid JSON, which is answered with a parse error, which is a thing a client
/// can see and report. Nothing a peer can send down this pipe is fatal.
fn read_line(input: &mut impl BufRead) -> std::io::Result<Line> {
    let mut buffer: Vec<u8> = Vec::new();
    let mut over = false;
    loop {
        let (consumed, complete) = {
            let available = match input.fill_buf() {
                Ok(bytes) => bytes,
                // Not an error: a signal arrived mid-read. Ask again.
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            if available.is_empty() {
                break;
            }
            let (chunk, complete) = match available.iter().position(|b| *b == b'\n') {
                Some(at) => (&available[..at], true),
                None => (available, false),
            };
            // The newline is consumed with the chunk it terminates, so the next
            // call starts on the next line rather than on an empty one.
            let consumed = chunk.len() + usize::from(complete);
            if over || buffer.len() + chunk.len() > MAX_LINE_BYTES {
                over = true;
                // Released rather than cleared: a client that sent 300 MB on
                // one line should not leave this process holding four of them.
                buffer = Vec::new();
            } else {
                buffer.extend_from_slice(chunk);
            }
            (consumed, complete)
        };
        input.consume(consumed);
        if complete {
            return Ok(finished(buffer, over));
        }
    }
    // End of input. A last line with no newline after it is still a line.
    Ok(match finished(buffer, over) {
        Line::Text(text) if text.is_empty() => Line::Eof,
        line => line,
    })
}

fn finished(buffer: Vec<u8>, over: bool) -> Line {
    if over {
        Line::TooLong
    } else {
        Line::Text(String::from_utf8_lossy(&buffer).into_owned())
    }
}

/// Read requests from `input` until it closes, writing one response line per
/// request to `output`.
///
/// Flushed after every response: the client is blocked waiting for it, and a
/// buffered stdout is a hung agent.
///
/// Notifications produce no line at all, which is not an optimisation — a
/// response to a notification is a protocol violation, and clients that count
/// lines would be one out from then on.
pub fn serve(
    project: &Path,
    mut input: impl BufRead,
    mut output: impl Write,
) -> std::io::Result<()> {
    serve_in(
        project,
        crate::rocmind::projects_root(),
        &mut input,
        &mut output,
    )
}

/// `serve`, with the memory root injected.
///
/// Only the tests use the second argument. It exists because the memory tools
/// are resolved against `~/.claude/projects`, and a suite whose answers
/// depended on the developer's own corpus would pass on one machine and fail on
/// the next.
pub fn serve_in(
    project: &Path,
    memory_root: Option<std::path::PathBuf>,
    mut input: impl BufRead,
    mut output: impl Write,
) -> std::io::Result<()> {
    loop {
        let response = match read_line(&mut input)? {
            Line::Eof => return Ok(()),
            Line::TooLong => Some(error_response(
                Value::Null,
                INVALID_REQUEST,
                &format!("request line longer than {MAX_LINE_BYTES} bytes"),
            )),
            Line::Text(line) => {
                if line.trim().is_empty() {
                    continue;
                }
                handle_line_in(project, memory_root.as_deref(), &line)
            }
        };
        if let Some(response) = response {
            writeln!(output, "{response}")?;
            output.flush()?;
        }
    }
}

/// One line in, at most one response out. `None` means "say nothing", which is
/// the correct answer to a notification and to a notification that was itself
/// malformed.
pub fn handle_line(project: &Path, line: &str) -> Option<Value> {
    handle_line_in(project, crate::rocmind::projects_root().as_deref(), line)
}

/// `handle_line`, with the memory root injected. See `serve_in`.
pub fn handle_line_in(project: &Path, memory_root: Option<&Path>, line: &str) -> Option<Value> {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        // Nothing else is knowable here — not even whose request this was — so
        // the id is null, which is what JSON-RPC reserves for exactly this.
        Err(e) => return Some(error_response(Value::Null, PARSE_ERROR, &e.to_string())),
    };
    let Value::Object(request) = value else {
        // Including a JSON array: batching was removed from MCP in the
        // 2025-06-18 revision, and no client sends it over stdio.
        return Some(error_response(
            Value::Null,
            INVALID_REQUEST,
            "expected a JSON-RPC request object",
        ));
    };
    handle_request(project, memory_root, &request)
}

/// What a message's `id` field makes it.
#[derive(Debug, PartialEq, Eq)]
enum RequestId {
    /// A request. This is what its response has to carry back.
    Id(Value),
    /// No `id` key at all: a notification. Nothing it can do earns a reply, not
    /// even an error.
    Notification,
    /// An `id` that is present but is not a string or a number — `null`, an
    /// object, an array.
    Invalid,
}

/// JSON-RPC allows a string or a number for an id, and MCP narrows that
/// further: the id MUST NOT be null. `null` was being treated as "no id", i.e.
/// as a notification, so a client that sent one got silence and waited for a
/// reply that was never coming. It is a malformed REQUEST, and the reply is an
/// error whose own id is null — which is exactly what JSON-RPC reserves null
/// for: a response that cannot name the request it answers.
fn request_id(request: &Map<String, Value>) -> RequestId {
    match request.get("id") {
        None => RequestId::Notification,
        Some(id @ (Value::String(_) | Value::Number(_))) => RequestId::Id(id.clone()),
        Some(_) => RequestId::Invalid,
    }
}

fn handle_request(
    project: &Path,
    memory_root: Option<&Path>,
    request: &Map<String, Value>,
) -> Option<Value> {
    let id = match request_id(request) {
        RequestId::Id(id) => Some(id),
        RequestId::Notification => None,
        RequestId::Invalid => {
            return Some(error_response(
                Value::Null,
                INVALID_REQUEST,
                "\"id\" must be a string or a number",
            ))
        }
    };
    let method = request.get("method").and_then(Value::as_str);

    let Some(method) = method else {
        return Some(error_response(id?, INVALID_REQUEST, "missing \"method\""));
    };
    let params = request.get("params");

    // Every arm goes through `id?`, which is where notifications drop out: the
    // handshake's `notifications/initialized`, a `notifications/cancelled`, a
    // method we have never heard of — none of them carry an id, so none of them
    // produce a line. That is the rule rather than a list of known
    // notifications, because the list is open-ended and a stray response is
    // worse than a missing one.
    // Resolved once per request rather than held for the process's lifetime,
    // for the reason every tool here re-reads its file: a project whose first
    // memory is written mid-session should get the memory tools without the
    // agent restarting, and one whose home directory went away should lose
    // them rather than serve an empty corpus as if it were the truth.
    let memory = MemoryContext::resolve(memory_root, project);

    match method {
        "initialize" => Some(result_response(id?, initialize_result(params, &memory))),
        "ping" => Some(result_response(id?, json!({}))),
        "tools/list" => Some(result_response(
            id?,
            json!({ "tools": tool_definitions(&memory) }),
        )),
        "tools/call" => Some(match call_tool(project, &memory, params) {
            Ok(result) => result_response(id?, result),
            Err(rpc) => error_response(id?, rpc.code, &rpc.message),
        }),
        _ => Some(error_response(
            id?,
            METHOD_NOT_FOUND,
            &format!("unknown method \"{method}\""),
        )),
    }
}

fn result_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// A protocol-level failure: the request could not be dispatched at all.
/// Distinct from a tool that ran and failed — see `call_tool`.
struct RpcError {
    code: i64,
    message: String,
}

fn invalid_params(message: impl Into<String>) -> RpcError {
    RpcError {
        code: INVALID_PARAMS,
        message: message.into(),
    }
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

/// What the client puts in front of the model alongside the tool list: what
/// this board IS, and the one habit that makes it worth having — moving your
/// own card and writing down what you found, rather than only saying it in a
/// chat the board never sees.
///
/// `concat!` rather than a `\`-continued literal because rustfmt reindents the
/// continuation lines, and every space it adds would land inside the string.
const INSTRUCTIONS: &str = concat!(
    "RocPlan is the kanban board for this project, stored at .rocspace/plan.json. ",
    "Cards move todo -> in_progress -> in_review -> complete. When you are working a ",
    "card, move it with rocplan_update_task_status and record what you found with ",
    "rocplan_append_finding rather than only saying it in chat.",
);

/// The revision to answer `initialize` with.
///
/// The spec's rule, rather than the client's string: if the version asked for
/// is one this server speaks, answer with that one; otherwise answer with one
/// it does. Echoing whatever arrived meant `"protocolVersion": "banana"` — or,
/// worse, a plausible future revision this server does NOT implement, which a
/// client would then hold it to.
fn negotiate_protocol_version(params: Option<&Value>) -> &'static str {
    params
        .and_then(|p| p.get("protocolVersion"))
        .and_then(Value::as_str)
        .and_then(|asked| {
            SUPPORTED_PROTOCOL_VERSIONS
                .into_iter()
                .find(|known| *known == asked)
        })
        .unwrap_or(DEFAULT_PROTOCOL_VERSION)
}

/// Added to `INSTRUCTIONS` only for a project that has memories, because for
/// one that does not it would be an instruction to use tools that are not
/// there.
const MEMORY_INSTRUCTIONS: &str = concat!(
    " This project also has memories — what you and other agents chose to write ",
    "down about it, including inside its git worktrees. Search them with ",
    "mind_search before asking the user something the project may already have ",
    "recorded. They are read-only here; write one through Claude Code's own ",
    "memory mechanism.",
);

fn initialize_result(params: Option<&Value>, memory: &MemoryContext) -> Value {
    let mut instructions = INSTRUCTIONS.to_string();
    if memory.is_available() {
        instructions.push_str(MEMORY_INSTRUCTIONS);
    }
    json!({
        "protocolVersion": negotiate_protocol_version(params),
        "capabilities": { "tools": {} },
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
        "instructions": instructions,
    })
}

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

/// The five tools, with their schemas. Names and schemas are the contract the
/// agent is prompted against — changing one is changing what every dispatched
/// card's prompt refers to.
///
/// Every schema closes with `additionalProperties: false`. Four of them were
/// open, which means a model that invents an argument — `assignee`, `dueDate`,
/// a misspelling of one that exists — gets no signal at all: the call succeeds,
/// the argument is dropped, and the model believes it did something it did not.
/// A validating client rejects it up front and tells the model what the tool
/// actually takes, which is the only place that correction is cheap.
fn tool_definitions(memory: &MemoryContext) -> Value {
    let mut tools = json!([
        {
            "name": "rocplan_list_tasks",
            "description": "List every task on this project's RocPlan board, with status, priority, assignee and findings.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
        },
        {
            "name": "rocplan_get_task",
            "description": "Read one task by id.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "description": "The task's id." } },
                "required": ["id"],
                "additionalProperties": false,
            },
        },
        {
            "name": "rocplan_create_task",
            "description": "Add a task to the board. It starts in the To Do column, unassigned.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "One line naming the work." },
                    "description": { "type": "string", "description": "What doing it involves. Prose, not a pasted file — the board is committed to this repository." },
                    "priority": {
                        "type": "string",
                        "enum": ["critical", "high", "medium", "low"],
                        "description": "Defaults to medium.",
                    },
                },
                "required": ["title"],
                "additionalProperties": false,
            },
        },
        {
            "name": "rocplan_update_task_status",
            "description": "Move a task to another column. Move the card you are working to in_review when your turn is done.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The task's id." },
                    "status": {
                        "type": "string",
                        "enum": ["todo", "in_progress", "in_review", "complete", "cancelled"],
                    },
                },
                "required": ["id", "status"],
                "additionalProperties": false,
            },
        },
        {
            "name": "rocplan_append_finding",
            "description": "Add a line to a task's log — what you changed, what you found, what is still open.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The task's id." },
                    "text": { "type": "string", "description": "One or two sentences. Not a log or a diff — the board is committed to this repository." },
                },
                "required": ["id", "text"],
                "additionalProperties": false,
            },
        },
    ]);
    if let (Some(list), true) = (tools.as_array_mut(), memory.is_available()) {
        list.extend(memory_tool_definitions());
    }
    tools
}

// ---------------------------------------------------------------------------
// RocMind
// ---------------------------------------------------------------------------

/// The memory scopes this project can see, if any.
///
/// Resolved from `~/.claude/projects` — the directories Claude Code writes and
/// RocSpace only ever reads. `None` for the root means there is no home
/// directory to look in; an empty `scopes` means this project has no memories,
/// which is most projects.
struct MemoryContext {
    root: Option<std::path::PathBuf>,
    scopes: Vec<String>,
}

impl MemoryContext {
    fn resolve(root: Option<&Path>, project: &Path) -> Self {
        let Some(root) = root else {
            return Self {
                root: None,
                scopes: Vec::new(),
            };
        };
        let scopes = crate::rocmind::scopes_for_project(root, project)
            .into_iter()
            .map(|scope| scope.slug)
            .collect();
        Self {
            root: Some(root.to_path_buf()),
            scopes,
        }
    }

    /// Are the memory tools worth offering?
    ///
    /// Only for a project that HAS memories. A model shown three tools that
    /// answer "nothing here" for the whole session learns to call them anyway
    /// and to distrust the answers; a model that never sees them asks the user
    /// instead, which is the better failure.
    fn is_available(&self) -> bool {
        self.root.is_some() && !self.scopes.is_empty()
    }

    fn root(&self) -> Result<&Path, String> {
        self.root
            .as_deref()
            .ok_or_else(|| "no home directory, so no memories to read".to_string())
    }
}

/// How many hits `mind_search` answers with.
///
/// Six: enough that a second-best match is visible, few enough that the reply
/// is a paragraph rather than a page. The model is given names and
/// descriptions, not bodies — the descriptions are one-line summaries written
/// for exactly this, and a search that pasted six full memories into the
/// context would cost more than it told.
const MIND_SEARCH_LIMIT: usize = 6;

/// The three memory tools.
///
/// Read-only, and every description says so. Agents already create memories
/// through Claude Code's own mechanism; a second writer would race it for a
/// file nobody asked us to own, and the loser would be whichever process
/// happened to finish second.
fn memory_tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "mind_search",
            "description": "Search this project's memories — everything you and other agents chose to write down about it, including memories written inside its git worktrees. Returns names and one-line descriptions, best match first; call mind_read for the one you want. READ-ONLY: memories are created through Claude Code's own memory mechanism, not through this server.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Words to look for. Every word has to appear somewhere, so more words narrow the search." },
                },
                "required": ["query"],
                "additionalProperties": false,
            },
        }),
        json!({
            "name": "mind_read",
            "description": "Read one memory in full, by the name mind_search reported (which is also what [[wikilinks]] point at). READ-ONLY.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "The memory's name, e.g. payments-provider-migration." },
                },
                "required": ["name"],
                "additionalProperties": false,
            },
        }),
        json!({
            "name": "mind_backlinks",
            "description": "Which memories link TO this one — the context around a memory, which is often where the reason for it is written. READ-ONLY.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "The memory's name." },
                },
                "required": ["name"],
                "additionalProperties": false,
            },
        }),
    ]
}

fn mind_search(memory: &MemoryContext, query: &str) -> Result<String, String> {
    let root = memory.root()?;
    let hits = crate::rocmind::search_in(root, &memory.scopes, query, MIND_SEARCH_LIMIT);
    if hits.is_empty() {
        return Ok(format!(
            "No memory of this project matches \"{query}\". Every word has to appear somewhere — try fewer."
        ));
    }
    let mut out = String::new();
    for hit in hits {
        let description = if hit.memory.description.is_empty() {
            "(no description)".to_string()
        } else {
            hit.memory.description.clone()
        };
        let kind = if hit.memory.memory_type.is_empty() {
            String::new()
        } else {
            format!(" [{}]", hit.memory.memory_type)
        };
        out.push_str(&format!("- {}{kind} — {description}\n", hit.memory.name));
    }
    out.push_str("\nCall mind_read with a name to see one in full.");
    Ok(out)
}

fn mind_read(memory: &MemoryContext, name: &str) -> Result<String, String> {
    let root = memory.root()?;
    let (found, body) = crate::rocmind::find_in(root, &memory.scopes, name).ok_or_else(|| {
        format!("No memory of this project is called \"{name}\". Call mind_search to find one.")
    })?;
    // The same cap the Tauri command enforces, in the same words. Without it
    // this side had none: whatever was on disk was serialised into a
    // `tools/call` result and from there into the model's context window.
    if let Some(refusal) = crate::rocmind::too_large(found.bytes) {
        return Err(format!("\"{name}\": {refusal}."));
    }
    Ok(body)
}

fn mind_backlinks(memory: &MemoryContext, name: &str) -> Result<String, String> {
    let root = memory.root()?;
    if crate::rocmind::find_in(root, &memory.scopes, name).is_none() {
        return Err(format!(
            "No memory of this project is called \"{name}\". Call mind_search to find one."
        ));
    }
    let sources = crate::rocmind::backlinks_in(root, &memory.scopes, name);
    if sources.is_empty() {
        return Ok(format!("Nothing links to \"{name}\"."));
    }
    let mut out = format!("Memories that link to \"{name}\":\n");
    for source in sources {
        let description = if source.description.is_empty() {
            "(no description)".to_string()
        } else {
            source.description.clone()
        };
        out.push_str(&format!("- {} — {description}\n", source.name));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

/// Dispatch a `tools/call`.
///
/// `Err` is for the two things that are the CLIENT's mistake — a tool that does
/// not exist and arguments that do not typecheck — which MCP asks to be
/// JSON-RPC errors. Everything the tool itself can run into (no such task, an
/// unreadable board, a full disk) comes back as `Ok` of an `isError` result:
/// that is what puts the message in front of the model, which is the only party
/// that can do anything about it.
fn call_tool(
    project: &Path,
    memory: &MemoryContext,
    params: Option<&Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| invalid_params("missing \"params\""))?;
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("missing tool \"name\""))?;
    let empty = json!({});
    let args = match params.get("arguments") {
        None | Some(Value::Null) => &empty,
        Some(args @ Value::Object(_)) => args,
        Some(_) => return Err(invalid_params("\"arguments\" must be an object")),
    };

    let outcome = match name {
        "rocplan_list_tasks" => list_tasks(project),
        "rocplan_get_task" => get_task(project, required_str(args, "id")?),
        "rocplan_create_task" => create_task(
            project,
            required_str(args, "title")?,
            optional_str(args, "description")?.unwrap_or_default(),
            optional_str(args, "priority")?,
        ),
        "rocplan_update_task_status" => update_task_status(
            project,
            required_str(args, "id")?,
            required_str(args, "status")?,
        ),
        "rocplan_append_finding" => append_finding(
            project,
            required_str(args, "id")?,
            required_str(args, "text")?,
        ),
        // Refused with the same error as a tool that does not exist when this
        // project has no memories, because for this session it does not: the
        // name was never in `tools/list`, and answering it anyway would teach a
        // model to call tools it was not offered.
        "mind_search" | "mind_read" | "mind_backlinks" if !memory.is_available() => {
            return Err(invalid_params(format!(
                "unknown tool \"{name}\" (this project has no memories)"
            )))
        }
        "mind_search" => mind_search(memory, required_str(args, "query")?),
        "mind_read" => mind_read(memory, required_str(args, "name")?),
        "mind_backlinks" => mind_backlinks(memory, required_str(args, "name")?),
        _ => return Err(invalid_params(format!("unknown tool \"{name}\""))),
    };
    Ok(tool_result(outcome))
}

fn required_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, RpcError> {
    match args.get(key) {
        Some(Value::String(s)) => Ok(s),
        Some(_) => Err(invalid_params(format!("\"{key}\" must be a string"))),
        None => Err(invalid_params(format!("missing \"{key}\""))),
    }
}

fn optional_str<'a>(args: &'a Value, key: &str) -> Result<Option<&'a str>, RpcError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(invalid_params(format!("\"{key}\" must be a string"))),
    }
}

/// A tool's outcome as MCP renders it: text content, and `isError` telling the
/// model whether to believe it.
fn tool_result(outcome: Result<String, String>) -> Value {
    let (text, is_error) = match outcome {
        Ok(text) => (text, false),
        Err(message) => (message, true),
    };
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

// -- the tools themselves ---------------------------------------------------

fn list_tasks(project: &Path) -> Result<String, String> {
    let tasks = rocplan::read_tasks(project)?;
    if tasks.is_empty() {
        return Ok("The board is empty.".to_string());
    }
    describe(&tasks)
}

fn get_task(project: &Path, id: &str) -> Result<String, String> {
    let tasks = rocplan::read_tasks(project)?;
    let task = tasks
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| no_task(id))?;
    describe(task)
}

// The three tools that CHANGE the board go through `rocplan::update_plan`
// rather than read-then-write, which holds the board's lock across the read and
// the write. A workspace is several Claude panes and therefore several of these
// servers, all told to work their own card: without the lock, four of them
// appending a finding at once left one finding on the file and reported four
// successes, because each had written a whole valid board over the last one.

/// A tool error rather than a truncation when a string is too big for the
/// board.
///
/// A tool error, because the model is the only party that can do anything about
/// it and it is the one that has to. Truncating would leave a half-sentence on
/// a card that reads as if it were the whole finding, which is worse than
/// saying no.
fn bounded<'a>(what: &str, text: &'a str) -> Result<&'a str, String> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(format!(
            "that {what} is {} bytes and the board takes at most {MAX_TEXT_BYTES}. \
             This file is committed to the repository — summarise it, or leave the \
             detail in a file and name the file here.",
            text.len()
        ));
    }
    Ok(text)
}

fn create_task(
    project: &Path,
    title: &str,
    description: &str,
    priority: Option<&str>,
) -> Result<String, String> {
    let title = bounded("title", title)?;
    let description = bounded("description", description)?;
    let mut task = RocTask::new(title, description);
    if let Some(priority) = priority {
        task.priority = parse_priority(priority)?;
    }
    let created = task.clone();
    rocplan::update_plan(project, move |tasks| {
        tasks.push(task);
        Ok(())
    })?;
    describe(&created)
}

fn update_task_status(project: &Path, id: &str, status: &str) -> Result<String, String> {
    let status = parse_status(status)?;
    let updated = rocplan::update_plan(project, |tasks| {
        let task = tasks
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| no_task(id))?;
        task.status = status;
        task.updated_at = rocplan::now_ms();
        Ok(task.clone())
    })?;
    describe(&updated)
}

fn append_finding(project: &Path, id: &str, text: &str) -> Result<String, String> {
    let text = bounded("finding", text)?;
    let title = rocplan::update_plan(project, |tasks| {
        let task = tasks
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| no_task(id))?;
        task.push_finding(FINDING_AUTHOR, text);
        Ok(task.title.clone())
    })?;
    Ok(format!("Added a finding to \"{title}\"."))
}

fn no_task(id: &str) -> String {
    format!("No task on this board has the id \"{id}\". Call rocplan_list_tasks to see what does.")
}

/// A task (or a list of them) as the text content of a tool result: the same
/// JSON the board file holds, pretty-printed. The model is going to reason
/// about ids and statuses, so it gets the structure rather than prose.
fn describe(value: &impl serde::Serialize) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(|e| format!("serialize: {e}"))
}

fn parse_status(raw: &str) -> Result<RocTaskStatus, String> {
    serde_json::from_value(Value::String(raw.to_string())).map_err(|_| {
        format!(
            "\"{raw}\" is not a status. Use one of: todo, in_progress, in_review, complete, cancelled."
        )
    })
}

fn parse_priority(raw: &str) -> Result<RocTaskPriority, String> {
    serde_json::from_value(Value::String(raw.to_string())).map_err(|_| {
        format!("\"{raw}\" is not a priority. Use one of: critical, high, medium, low.")
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Send one request, expect one response.
    fn ask(project: &Path, request: Value) -> Value {
        handle_line(project, &request.to_string()).expect("a request gets a response")
    }

    fn call(project: &Path, name: &str, arguments: Value) -> Value {
        ask(
            project,
            json!({
                "jsonrpc": "2.0", "id": 7, "method": "tools/call",
                "params": { "name": name, "arguments": arguments },
            }),
        )
    }

    /// The text content of a tool result, and whether it was an error.
    fn content(response: &Value) -> (String, bool) {
        let result = response
            .get("result")
            .unwrap_or_else(|| panic!("expected a result, got {response}"));
        (
            result["content"][0]["text"]
                .as_str()
                .expect("text")
                .to_string(),
            result["isError"].as_bool().expect("isError"),
        )
    }

    fn create(project: &Path, title: &str) -> String {
        let (text, is_error) = content(&call(
            project,
            "rocplan_create_task",
            json!({ "title": title }),
        ));
        assert!(!is_error, "{text}");
        let task: Value = serde_json::from_str(&text).expect("a task");
        task["id"].as_str().expect("an id").to_string()
    }

    // -- Handshake ---------------------------------------------------------

    #[test]
    fn initialize_answers_with_the_clients_version_when_we_speak_it() {
        let tmp = tempfile::tempdir().unwrap();
        for asked in SUPPORTED_PROTOCOL_VERSIONS {
            let response = ask(
                tmp.path(),
                json!({
                    "jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": { "protocolVersion": asked, "capabilities": {} },
                }),
            );

            assert_eq!(response["jsonrpc"], "2.0");
            assert_eq!(response["id"], 1);
            assert_eq!(response["result"]["protocolVersion"], asked);
            assert_eq!(response["result"]["serverInfo"]["name"], SERVER_NAME);
            assert!(response["result"]["capabilities"]["tools"].is_object());
        }
    }

    #[test]
    fn initialize_answers_with_a_version_we_speak_when_the_clients_is_not_one() {
        // The spec's rule, and not "echo whatever arrived". Echoing gave
        // `"protocolVersion": "banana"` for the asking, and — the case that
        // actually matters — let a client name a future revision this server
        // does not implement and then hold it to that revision's rules.
        let tmp = tempfile::tempdir().unwrap();
        for asked in ["banana", "2099-01-01", "", "2025-06-19"] {
            let response = ask(
                tmp.path(),
                json!({
                    "jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": { "protocolVersion": asked },
                }),
            );

            let answered = response["result"]["protocolVersion"]
                .as_str()
                .expect("a version");
            assert!(
                SUPPORTED_PROTOCOL_VERSIONS.contains(&answered),
                "asked {asked:?}, answered {answered:?}"
            );
        }
    }

    #[test]
    fn initialize_without_a_protocol_version_answers_with_ours() {
        let tmp = tempfile::tempdir().unwrap();
        let response = ask(
            tmp.path(),
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }),
        );

        assert_eq!(
            response["result"]["protocolVersion"],
            DEFAULT_PROTOCOL_VERSION
        );
    }

    #[test]
    fn a_request_whose_id_is_null_is_answered_with_an_error_not_with_silence() {
        // JSON-RPC allows a string or a number; MCP says the id MUST NOT be
        // null. Treating null as "no id" made it a notification — so a client
        // that sent one got nothing back and waited for a reply that was never
        // coming.
        let tmp = tempfile::tempdir().unwrap();
        for id in [json!(null), json!({}), json!([1]), json!(true)] {
            let response = handle_line(
                tmp.path(),
                &json!({ "jsonrpc": "2.0", "id": id, "method": "ping" }).to_string(),
            )
            .unwrap_or_else(|| panic!("id {id} earned silence"));

            assert_eq!(response["error"]["code"], INVALID_REQUEST, "id {id}");
            assert_eq!(response["id"], Value::Null, "id {id}");
        }
    }

    #[test]
    fn a_notification_is_never_answered() {
        // Answering one is a protocol violation, and a client counting lines
        // would be one out from then on. That holds for the handshake's
        // `initialized`, for any other notification, and for a notification
        // whose method we do not know.
        let tmp = tempfile::tempdir().unwrap();
        for notification in [
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 1 } }),
            json!({ "jsonrpc": "2.0", "method": "notifications/nothing-we-know-about" }),
            json!({ "jsonrpc": "2.0", "method": "some/unknown/notification" }),
            json!({ "jsonrpc": "2.0" }),
        ] {
            assert_eq!(
                handle_line(tmp.path(), &notification.to_string()),
                None,
                "{notification}"
            );
        }
    }

    #[test]
    fn ping_is_answered_with_an_empty_result() {
        let tmp = tempfile::tempdir().unwrap();
        let response = ask(
            tmp.path(),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }),
        );
        assert_eq!(response["result"], json!({}));
    }

    // -- Nothing takes the server down --------------------------------------

    #[test]
    fn malformed_input_is_answered_rather_than_fatal() {
        let tmp = tempfile::tempdir().unwrap();

        let parse_error = handle_line(tmp.path(), "{ not json").expect("answered");
        assert_eq!(parse_error["error"]["code"], PARSE_ERROR);
        assert_eq!(parse_error["id"], Value::Null);

        let not_an_object = handle_line(tmp.path(), "[1, 2, 3]").expect("answered");
        assert_eq!(not_an_object["error"]["code"], INVALID_REQUEST);

        let no_method = handle_line(
            tmp.path(),
            &json!({ "jsonrpc": "2.0", "id": 4 }).to_string(),
        )
        .expect("answered");
        assert_eq!(no_method["error"]["code"], INVALID_REQUEST);
        assert_eq!(no_method["id"], 4);
    }

    #[test]
    fn an_unknown_method_is_an_error_not_a_crash() {
        let tmp = tempfile::tempdir().unwrap();
        let response = ask(
            tmp.path(),
            json!({ "jsonrpc": "2.0", "id": 5, "method": "resources/list" }),
        );

        assert_eq!(response["error"]["code"], METHOD_NOT_FOUND);
        assert_eq!(response["id"], 5);
    }

    #[test]
    fn the_id_is_echoed_whatever_shape_it_is() {
        // JSON-RPC allows a string or a number, and clients use both.
        let tmp = tempfile::tempdir().unwrap();
        for id in [json!(1), json!("req-1"), json!(0)] {
            let response = ask(
                tmp.path(),
                json!({ "jsonrpc": "2.0", "id": id, "method": "ping" }),
            );
            assert_eq!(response["id"], id);
        }
    }

    // -- tools/list --------------------------------------------------------

    #[test]
    fn tools_list_offers_exactly_the_five_tools_in_the_contract() {
        let tmp = tempfile::tempdir().unwrap();
        let response = ask(
            tmp.path(),
            json!({ "jsonrpc": "2.0", "id": 6, "method": "tools/list" }),
        );

        let tools = response["result"]["tools"].as_array().expect("tools");
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
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
        for tool in tools {
            assert_eq!(tool["inputSchema"]["type"], "object", "{tool}");
            assert!(
                tool["description"].as_str().is_some_and(|d| !d.is_empty()),
                "{tool}"
            );
            // An open schema gives a model that invents an argument no signal
            // at all: the call succeeds, the argument is dropped, and it
            // believes it did something it did not.
            assert_eq!(
                tool["inputSchema"]["additionalProperties"],
                json!(false),
                "{tool}"
            );
        }
    }

    #[test]
    fn the_status_and_priority_enums_in_the_schemas_match_the_rust_ones() {
        // The schema is what the model picks a value from; a value it picks
        // that Rust cannot parse is a tool call that can only fail.
        let tmp = tempfile::tempdir().unwrap();
        let response = ask(
            tmp.path(),
            json!({ "jsonrpc": "2.0", "id": 6, "method": "tools/list" }),
        );
        let tools = response["result"]["tools"].as_array().unwrap();

        let statuses = &tools[3]["inputSchema"]["properties"]["status"]["enum"];
        for status in statuses.as_array().expect("an enum") {
            let raw = status.as_str().expect("a string");
            assert!(parse_status(raw).is_ok(), "{raw}");
        }
        let priorities = &tools[2]["inputSchema"]["properties"]["priority"]["enum"];
        for priority in priorities.as_array().expect("an enum") {
            let raw = priority.as_str().expect("a string");
            assert!(parse_priority(raw).is_ok(), "{raw}");
        }
    }

    // -- The tools ---------------------------------------------------------

    #[test]
    fn listing_an_untouched_project_says_so_instead_of_failing() {
        // A project whose board has never been opened has no `.rocspace/` at
        // all, and that is not an error the model should have to reason about.
        let tmp = tempfile::tempdir().unwrap();
        let (text, is_error) = content(&call(tmp.path(), "rocplan_list_tasks", json!({})));

        assert!(!is_error);
        assert!(text.contains("empty"), "{text}");
    }

    #[test]
    fn a_created_task_lands_on_the_board_file_as_a_todo() {
        let tmp = tempfile::tempdir().unwrap();
        let (text, is_error) = content(&call(
            tmp.path(),
            "rocplan_create_task",
            json!({ "title": "Wire the watcher", "description": "poll it", "priority": "high" }),
        ));
        assert!(!is_error, "{text}");

        let created: Value = serde_json::from_str(&text).expect("a task");
        assert_eq!(created["status"], "todo");
        assert_eq!(created["priority"], "high");
        assert_eq!(created["assignedTerminalName"], Value::Null);

        let tasks = rocplan::read_tasks(tmp.path()).expect("read");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "Wire the watcher");
        assert_eq!(tasks[0].description, "poll it");
        assert_eq!(tasks[0].id, created["id"].as_str().unwrap());
    }

    #[test]
    fn creating_a_task_keeps_the_ones_already_there() {
        // Every call re-reads the file, which is what makes this true even when
        // the app added a card between the two creates.
        let tmp = tempfile::tempdir().unwrap();
        let first = create(tmp.path(), "First");
        let second = create(tmp.path(), "Second");

        let ids: Vec<String> = rocplan::read_tasks(tmp.path())
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(ids, vec![first, second]);
    }

    #[test]
    fn a_task_created_by_someone_else_is_visible_immediately() {
        // The app writes this file too. Nothing is cached between calls.
        let tmp = tempfile::tempdir().unwrap();
        create(tmp.path(), "Ours");
        let mut tasks = rocplan::read_tasks(tmp.path()).unwrap();
        tasks.push(RocTask::new("Dragged in by the user", ""));
        rocplan::write_tasks(tmp.path(), &tasks).unwrap();

        let (text, _) = content(&call(tmp.path(), "rocplan_list_tasks", json!({})));

        assert!(text.contains("Dragged in by the user"), "{text}");
    }

    #[test]
    fn getting_a_task_returns_it_and_getting_a_missing_one_is_a_tool_error() {
        let tmp = tempfile::tempdir().unwrap();
        let id = create(tmp.path(), "Findable");

        let (found, is_error) = content(&call(tmp.path(), "rocplan_get_task", json!({ "id": id })));
        assert!(!is_error);
        assert!(found.contains("Findable"), "{found}");

        let (missing, is_error) = content(&call(
            tmp.path(),
            "rocplan_get_task",
            json!({ "id": "01NOPE" }),
        ));
        assert!(is_error, "a missing task is an error the MODEL can act on");
        assert!(missing.contains("01NOPE"), "{missing}");
    }

    #[test]
    fn moving_a_task_writes_the_new_status_and_bumps_updated_at() {
        let tmp = tempfile::tempdir().unwrap();
        let id = create(tmp.path(), "Movable");
        let before = rocplan::read_tasks(tmp.path()).unwrap()[0].updated_at;

        let (text, is_error) = content(&call(
            tmp.path(),
            "rocplan_update_task_status",
            json!({ "id": id, "status": "in_review" }),
        ));
        assert!(!is_error, "{text}");

        let task = rocplan::read_tasks(tmp.path()).unwrap().remove(0);
        assert_eq!(task.status, RocTaskStatus::InReview);
        assert!(task.updated_at >= before);
    }

    #[test]
    fn a_status_nobody_has_heard_of_is_a_tool_error_that_names_the_real_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let id = create(tmp.path(), "Movable");

        let (text, is_error) = content(&call(
            tmp.path(),
            "rocplan_update_task_status",
            json!({ "id": id, "status": "done-ish" }),
        ));

        assert!(is_error);
        assert!(text.contains("in_review"), "{text}");
        // …and the board is untouched.
        assert_eq!(
            rocplan::read_tasks(tmp.path()).unwrap()[0].status,
            RocTaskStatus::Todo
        );
    }

    #[test]
    fn a_finding_is_appended_under_the_mcp_author() {
        let tmp = tempfile::tempdir().unwrap();
        let id = create(tmp.path(), "Logged");

        let (_, is_error) = content(&call(
            tmp.path(),
            "rocplan_append_finding",
            json!({ "id": id, "text": "The watcher was polling the wrong path." }),
        ));
        assert!(!is_error);

        let task = rocplan::read_tasks(tmp.path()).unwrap().remove(0);
        assert_eq!(task.findings.len(), 1);
        assert_eq!(task.findings[0].by, FINDING_AUTHOR);
        assert_eq!(
            task.findings[0].text,
            "The watcher was polling the wrong path."
        );
        assert!(task.findings[0].at > 0);
    }

    #[test]
    fn findings_accumulate_rather_than_replace() {
        let tmp = tempfile::tempdir().unwrap();
        let id = create(tmp.path(), "Logged");
        for text in ["first", "second", "third"] {
            call(
                tmp.path(),
                "rocplan_append_finding",
                json!({ "id": id, "text": text }),
            );
        }

        let task = rocplan::read_tasks(tmp.path()).unwrap().remove(0);
        let texts: Vec<&str> = task.findings.iter().map(|f| f.text.as_str()).collect();
        assert_eq!(texts, vec!["first", "second", "third"]);
    }

    // -- Bad calls ---------------------------------------------------------

    #[test]
    fn an_unknown_tool_is_a_json_rpc_error() {
        // MCP asks for a protocol error here rather than an `isError` result:
        // the client, not the model, is the one that got this wrong.
        let tmp = tempfile::tempdir().unwrap();
        let response = call(tmp.path(), "rocplan_delete_everything", json!({}));

        assert_eq!(response["error"]["code"], INVALID_PARAMS);
        assert!(response.get("result").is_none());
    }

    #[test]
    fn missing_or_mistyped_arguments_are_json_rpc_errors() {
        let tmp = tempfile::tempdir().unwrap();
        for arguments in [json!({}), json!({ "title": 42 })] {
            let response = call(tmp.path(), "rocplan_create_task", arguments.clone());
            assert_eq!(
                response["error"]["code"], INVALID_PARAMS,
                "{arguments} was accepted"
            );
        }
        // …and nothing was written.
        assert!(rocplan::read_tasks(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn a_call_with_no_arguments_key_is_treated_as_no_arguments() {
        // Clients omit `arguments` entirely for a tool whose schema has no
        // properties; that is a valid call, not a missing parameter.
        let tmp = tempfile::tempdir().unwrap();
        let response = ask(
            tmp.path(),
            json!({
                "jsonrpc": "2.0", "id": 8, "method": "tools/call",
                "params": { "name": "rocplan_list_tasks" },
            }),
        );

        assert!(response.get("error").is_none(), "{response}");
    }

    #[test]
    fn a_call_with_no_params_at_all_is_an_error_rather_than_a_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let response = ask(
            tmp.path(),
            json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/call" }),
        );

        assert_eq!(response["error"]["code"], INVALID_PARAMS);
    }

    #[test]
    fn text_too_big_for_a_committed_file_is_refused_rather_than_written() {
        // The board is committed to the user's repository. Without a bound, a
        // model that decides the way to record a finding is to paste the build
        // log commits the build log, and `git status` is a sixty-megabyte
        // change nobody asked for and nobody can review.
        let tmp = tempfile::tempdir().unwrap();
        let id = create(tmp.path(), "Logged");
        let huge = "x".repeat(MAX_TEXT_BYTES + 1);

        for (tool, arguments) in [
            ("rocplan_append_finding", json!({ "id": id, "text": huge })),
            ("rocplan_create_task", json!({ "title": huge })),
            (
                "rocplan_create_task",
                json!({ "title": "Fine", "description": huge }),
            ),
        ] {
            let (text, is_error) = content(&call(tmp.path(), tool, arguments));
            assert!(is_error, "{tool} accepted {} bytes", huge.len());
            // …and it says what to do instead, because the model is the only
            // party that can.
            assert!(text.contains(&MAX_TEXT_BYTES.to_string()), "{text}");
        }

        // Nothing was written: one card, no findings.
        let tasks = rocplan::read_tasks(tmp.path()).unwrap();
        assert_eq!(tasks.len(), 1);
        assert!(tasks[0].findings.is_empty());
    }

    #[test]
    fn text_that_fits_is_still_accepted() {
        let tmp = tempfile::tempdir().unwrap();
        let id = create(tmp.path(), "Logged");
        let big = "x".repeat(MAX_TEXT_BYTES);

        let (text, is_error) = content(&call(
            tmp.path(),
            "rocplan_append_finding",
            json!({ "id": id, "text": big }),
        ));

        assert!(!is_error, "{text}");
        assert_eq!(
            rocplan::read_tasks(tmp.path()).unwrap()[0].findings[0].text.len(),
            MAX_TEXT_BYTES
        );
    }

    #[test]
    fn a_corrupt_board_is_a_tool_error_and_is_not_overwritten() {
        // The file is checked in and hand-edited; a merge conflict left in it
        // must not be silently replaced by whatever the agent was doing.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(rocplan::PLAN_DIR)).unwrap();
        let path = rocplan::plan_path(tmp.path());
        std::fs::write(&path, b"<<<<<<< HEAD\n").unwrap();

        let (text, is_error) = content(&call(
            tmp.path(),
            "rocplan_create_task",
            json!({ "title": "New" }),
        ));

        assert!(is_error, "{text}");
        assert_eq!(std::fs::read(&path).unwrap(), b"<<<<<<< HEAD\n");
    }

    // -- The loop ----------------------------------------------------------

    #[test]
    fn a_byte_that_is_not_utf_8_is_answered_rather_than_fatal() {
        // `BufRead::lines()` turns one bad byte into an `Err`, `serve`
        // propagated it, and the process ended — taking the board away from the
        // agent for the rest of its session, with no symptom but tools that had
        // stopped existing.
        let tmp = tempfile::tempdir().unwrap();
        let mut session: Vec<u8> = Vec::new();
        session.extend_from_slice(b"\xff\xfe not JSON and not UTF-8\n");
        // …including a bad byte INSIDE something that would otherwise parse.
        session.extend_from_slice(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"pi\xffng\"}\n");
        session.extend_from_slice(
            json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" })
                .to_string()
                .as_bytes(),
        );
        session.push(b'\n');

        let mut out = Vec::new();
        serve(tmp.path(), session.as_slice(), &mut out).expect("served");

        let lines: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).expect("each line is one JSON object"))
            .collect();
        assert_eq!(lines.len(), 3, "{lines:?}");
        assert_eq!(lines[0]["error"]["code"], PARSE_ERROR);
        assert_eq!(lines[1]["error"]["code"], METHOD_NOT_FOUND, "{:?}", lines[1]);
        assert_eq!(lines[2]["id"], 2, "still a working server");
    }

    #[test]
    fn a_line_longer_than_the_cap_is_refused_without_being_held() {
        // A line with no newline in it is an unbounded allocation, on a stream
        // a model writes.
        let tmp = tempfile::tempdir().unwrap();
        let mut session: Vec<u8> = vec![b'x'; MAX_LINE_BYTES + 1];
        session.push(b'\n');
        session.extend_from_slice(
            json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })
                .to_string()
                .as_bytes(),
        );
        session.push(b'\n');

        let mut out = Vec::new();
        serve(tmp.path(), session.as_slice(), &mut out).expect("served");

        let lines: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).expect("JSON"))
            .collect();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert_eq!(lines[0]["error"]["code"], INVALID_REQUEST);
        assert_eq!(lines[0]["id"], Value::Null);
        // …and the line after it is read as its own line, not as the tail of
        // the one that was thrown away.
        assert_eq!(lines[1]["id"], 1);
    }

    #[test]
    fn reading_splits_on_newlines_and_ends_at_the_end() {
        let mut input: &[u8] = b"one\n\ntwo\nthree";
        let mut lines = Vec::new();
        loop {
            match read_line(&mut input).expect("read") {
                Line::Eof => break,
                line => lines.push(line),
            }
        }
        assert_eq!(
            lines,
            vec![
                Line::Text("one".to_string()),
                Line::Text(String::new()),
                Line::Text("two".to_string()),
                // A final line with no newline after it is still a line.
                Line::Text("three".to_string()),
            ]
        );
    }

    #[test]
    fn serve_answers_requests_in_order_and_stays_silent_for_notifications() {
        let tmp = tempfile::tempdir().unwrap();
        let session = [
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }).to_string(),
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string(),
            String::new(), // a blank line is not a request
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }).to_string(),
            "{ garbage".to_string(),
            json!({ "jsonrpc": "2.0", "id": 3, "method": "ping" }).to_string(),
        ]
        .join("\n");

        let mut out = Vec::new();
        serve(tmp.path(), session.as_bytes(), &mut out).expect("served");

        let lines: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).expect("each line is one JSON object"))
            .collect();
        assert_eq!(lines.len(), 4, "{lines:?}");
        assert_eq!(lines[0]["id"], 1);
        assert_eq!(lines[1]["id"], 2);
        assert_eq!(lines[2]["error"]["code"], PARSE_ERROR);
        assert_eq!(lines[3]["id"], 3);
    }
    // -- RocMind -----------------------------------------------------------

    /// A project directory with a matching memory scope under a fake
    /// `~/.claude/projects`, and the pair of roots to drive it with.
    ///
    /// The memory root is passed explicitly rather than through `HOME`: these
    /// answers must not depend on the developer's own corpus, or the suite
    /// passes on one machine and fails on the next.
    struct Corpus {
        _home: tempfile::TempDir,
        _repo: tempfile::TempDir,
        root: std::path::PathBuf,
        project: std::path::PathBuf,
    }

    fn corpus(files: &[(&str, &str)]) -> Corpus {
        corpus_at(files, &[])
    }

    /// `corpus`, plus memories written inside a git worktree of the same
    /// project — the scope Claude Code files separately.
    fn corpus_at(files: &[(&str, &str)], worktree: &[(&str, &str)]) -> Corpus {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let root = home.path().join(".claude").join("projects");
        let project = repo.path().join("Storefront");
        std::fs::create_dir_all(&project).unwrap();

        let write = |dir: &std::path::Path, files: &[(&str, &str)]| {
            if files.is_empty() {
                return;
            }
            std::fs::create_dir_all(dir).unwrap();
            for (name, body) in files {
                std::fs::write(dir.join(name), body).unwrap();
            }
        };
        let slug = crate::rocmind::encode_path(&project.to_string_lossy());
        write(&root.join(&slug).join("memory"), files);

        let worktree_path = project.join(".claude").join("worktrees").join("v1.2");
        if !worktree.is_empty() {
            std::fs::create_dir_all(&worktree_path).unwrap();
            let slug = crate::rocmind::encode_path(&worktree_path.to_string_lossy());
            write(&root.join(&slug).join("memory"), worktree);
        }

        Corpus {
            _home: home,
            _repo: repo,
            root,
            project,
        }
    }

    impl Corpus {
        fn tools(&self) -> Vec<String> {
            let response = handle_line_in(
                &self.project,
                Some(&self.root),
                &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }).to_string(),
            )
            .expect("a response");
            response["result"]["tools"]
                .as_array()
                .expect("tools")
                .iter()
                .map(|t| t["name"].as_str().expect("name").to_string())
                .collect()
        }

        fn call(&self, name: &str, arguments: Value) -> (String, bool) {
            let response = handle_line_in(
                &self.project,
                Some(&self.root),
                &json!({
                    "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                    "params": { "name": name, "arguments": arguments },
                })
                .to_string(),
            )
            .expect("a response");
            if response.get("error").is_some() {
                return (
                    response["error"]["message"].as_str().unwrap().to_string(),
                    true,
                );
            }
            content(&response)
        }
    }

    const PAYMENTS: &str = "---\nname: payments-provider-migration\ndescription: \"Payments provider moved to Acme Pay\"\nmetadata:\n  type: project\n---\n\nMerchant acct-4417 since July. See [[internal-builds-test-keys]].\n";
    const TEST_KEYS: &str = "---\nname: internal-builds-test-keys\ndescription: \"Internal builds must use test payments keys\"\nmetadata:\n  type: feedback\n---\n\nNever ship a build with live payment keys.\n";

    #[test]
    fn a_project_with_no_memories_is_not_offered_the_memory_tools() {
        // A model shown three tools that answer "nothing here" all session
        // learns to call them anyway and to distrust the answers. One that
        // never sees them asks the user instead, which is the better failure.
        let corpus = corpus(&[]);
        assert_eq!(corpus.tools().len(), 5);
        assert!(!corpus.tools().iter().any(|t| t.starts_with("mind_")));
    }

    #[test]
    fn a_project_with_memories_is_offered_all_three() {
        let corpus = corpus(&[("payments.md", PAYMENTS)]);
        assert_eq!(
            corpus.tools(),
            vec![
                "rocplan_list_tasks",
                "rocplan_get_task",
                "rocplan_create_task",
                "rocplan_update_task_status",
                "rocplan_append_finding",
                "mind_search",
                "mind_read",
                "mind_backlinks",
            ]
        );
    }

    #[test]
    fn every_memory_tool_says_it_is_read_only() {
        // Agents already create memories through Claude Code's own mechanism.
        // Two writers would race for a file nobody asked us to own, so the
        // descriptions have to say the tools do not write — otherwise a model
        // spends a turn looking for the one that does.
        let corpus = corpus(&[("payments.md", PAYMENTS)]);
        let response = handle_line_in(
            &corpus.project,
            Some(&corpus.root),
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }).to_string(),
        )
        .expect("a response");
        for tool in response["result"]["tools"].as_array().unwrap() {
            let name = tool["name"].as_str().unwrap();
            if !name.starts_with("mind_") {
                continue;
            }
            let description = tool["description"].as_str().unwrap();
            assert!(description.contains("READ-ONLY"), "{name}: {description}");
        }
    }

    #[test]
    fn searching_ranks_a_name_hit_over_a_description_hit_over_a_body_hit() {
        let corpus = corpus(&[("payments.md", PAYMENTS), ("keys.md", TEST_KEYS)]);
        let (text, is_error) = corpus.call("mind_search", json!({ "query": "payments" }));
        assert!(!is_error, "{text}");
        let lines: Vec<&str> = text.lines().filter(|l| l.starts_with("- ")).collect();
        assert_eq!(lines.len(), 2, "{text}");
        assert!(lines[0].contains("payments-provider-migration"), "{text}");
        assert!(lines[1].contains("internal-builds-test-keys"), "{text}");
        // Names and descriptions, not bodies — the descriptions exist for
        // exactly this, and six full memories would cost more than they tell.
        assert!(text.contains("Payments provider moved"), "{text}");
        assert!(!text.contains("acct-4417"), "{text}");
    }

    #[test]
    fn searching_says_so_when_nothing_matches() {
        let corpus = corpus(&[("payments.md", PAYMENTS)]);
        let (text, is_error) = corpus.call("mind_search", json!({ "query": "kubernetes" }));
        assert!(!is_error, "{text}");
        assert!(text.contains("No memory"), "{text}");
    }

    #[test]
    fn searching_narrows_as_words_are_added() {
        let corpus = corpus(&[("payments.md", PAYMENTS), ("keys.md", TEST_KEYS)]);
        let (both, _) = corpus.call("mind_search", json!({ "query": "ad" }));
        assert_eq!(both.lines().filter(|l| l.starts_with("- ")).count(), 2);
        let (one, _) = corpus.call("mind_search", json!({ "query": "pay acme" }));
        assert_eq!(one.lines().filter(|l| l.starts_with("- ")).count(), 1);
    }

    #[test]
    fn reading_answers_with_the_whole_memory_by_name() {
        let corpus = corpus(&[("payments.md", PAYMENTS)]);
        let (text, is_error) =
            corpus.call("mind_read", json!({ "name": "payments-provider-migration" }));
        assert!(!is_error, "{text}");
        assert_eq!(text, PAYMENTS);
    }

    #[test]
    fn reading_a_memory_over_the_cap_is_refused_the_way_the_app_refuses_it() {
        // The renderer's `mind_read` has enforced 5 MB since it was written;
        // this side enforced nothing, so whatever was on disk went into the
        // model's context window. A memory that big is a memory something went
        // wrong writing, and the answer is the same sentence in both places.
        let huge = format!(
            "---\nname: huge-memory\n---\n\n{}",
            "x".repeat(5 * 1024 * 1024 + 1024)
        );
        let corpus = corpus(&[("payments.md", PAYMENTS), ("huge.md", &huge)]);

        let (text, is_error) = corpus.call("mind_read", json!({ "name": "huge-memory" }));
        assert!(is_error, "{text}");
        assert!(text.contains("larger than 5 MB"), "{text}");

        // The one beside it still reads.
        let (ok, is_error) = corpus.call("mind_read", json!({ "name": "payments-provider-migration" }));
        assert!(!is_error, "{ok}");
    }

    #[test]
    fn reading_a_name_that_is_not_there_is_a_tool_error_that_says_what_to_do() {
        let corpus = corpus(&[("payments.md", PAYMENTS)]);
        let (text, is_error) = corpus.call("mind_read", json!({ "name": "nope" }));
        assert!(is_error, "{text}");
        assert!(text.contains("mind_search"), "{text}");
    }

    #[test]
    fn backlinks_answer_from_the_other_direction() {
        let corpus = corpus(&[("payments.md", PAYMENTS), ("keys.md", TEST_KEYS)]);
        let (text, is_error) = corpus.call(
            "mind_backlinks",
            json!({ "name": "internal-builds-test-keys" }),
        );
        assert!(!is_error, "{text}");
        assert!(text.contains("payments-provider-migration"), "{text}");

        let (none, is_error) = corpus.call(
            "mind_backlinks",
            json!({ "name": "payments-provider-migration" }),
        );
        assert!(!is_error, "{none}");
        assert!(none.contains("Nothing links"), "{none}");
    }

    #[test]
    fn a_projects_worktree_memories_are_part_of_its_corpus() {
        // The thing RocSpace can do that Claude Code today does not: a memory
        // written inside `.claude/worktrees/v1.2` is invisible to the main
        // project's own scope, and the next session there would never find it.
        let worktree_note = "---\nname: worktree-only-finding\ndescription: \"Found while on the v1.2 branch\"\n---\n\nBody.\n";
        let corpus = corpus_at(&[("payments.md", PAYMENTS)], &[("wt.md", worktree_note)]);

        let (text, is_error) = corpus.call("mind_search", json!({ "query": "worktree" }));
        assert!(!is_error, "{text}");
        assert!(text.contains("worktree-only-finding"), "{text}");
    }

    #[test]
    fn a_memory_tool_called_by_a_project_that_has_none_is_an_unknown_tool() {
        // It was never in `tools/list` for this session. Answering it anyway
        // would teach a model to call tools it was not offered.
        let corpus = corpus(&[]);
        let (text, is_error) = corpus.call("mind_search", json!({ "query": "anything" }));
        assert!(is_error, "{text}");
        assert!(text.contains("unknown tool"), "{text}");
    }

    #[test]
    fn a_memory_tool_with_the_wrong_arguments_is_a_json_rpc_error() {
        let corpus = corpus(&[("payments.md", PAYMENTS)]);
        let (text, is_error) = corpus.call("mind_search", json!({}));
        assert!(is_error, "{text}");
        assert!(text.contains("query"), "{text}");
    }

    #[test]
    fn the_memory_tools_appear_as_soon_as_the_first_memory_is_written() {
        // Resolved per request rather than once per process: an agent that
        // writes its first memory mid-session should not have to restart to be
        // able to read it back.
        let corpus = corpus(&[]);
        assert!(!corpus.tools().iter().any(|t| t.starts_with("mind_")));

        let slug = crate::rocmind::encode_path(&corpus.project.to_string_lossy());
        let dir = corpus.root.join(slug).join("memory");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("payments.md"), PAYMENTS).unwrap();

        assert!(corpus.tools().iter().any(|t| t == "mind_search"));
    }
}

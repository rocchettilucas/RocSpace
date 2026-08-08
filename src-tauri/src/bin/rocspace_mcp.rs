//! `rocspace-mcp <project_path>` — the RocPlan board as an MCP server.
//!
//! Launched by a Claude Code pane through `--mcp-config` (see
//! `agents::command::mcp_config_json`), one process per agent session, speaking
//! JSON-RPC over stdin/stdout for as long as that session lives.
//!
//! Everything interesting is in `rocspace_lib::mcp`, which is testable without
//! a process. What is here is the three things a binary has to do that a
//! library cannot: read argv, lock stdio, and decide what an exit code means.
//!
//! stdout belongs to the protocol. Nothing in this process may print to it —
//! a stray `println!` is a line the client tries to parse as a response, and
//! the session desynchronises from that point on. Diagnostics go to stderr,
//! which the agent CLI shows the user when a server misbehaves.

use std::io::{self, BufReader};
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    // `args_os`, not `args`: a project path is a filesystem path and does not
    // have to be UTF-8. Nothing here needs to read it as text.
    let Some(project) = std::env::args_os().nth(1).map(PathBuf::from) else {
        return usage("no project path");
    };

    // Absolute, or nothing. Everything this server touches is built by joining
    // onto that path, and joining onto an empty or relative one resolves
    // against the process's working directory — which for this process is the
    // AGENT's, i.e. the user's repository. An empty argument had the agent
    // create a `.rocspace/plan.json` in whatever it happened to be sitting in,
    // committed alongside the work, and invisible to the board on screen that
    // was pointed somewhere else entirely.
    //
    // Refused at startup rather than at the first write, because the failure
    // the user can act on is "the server would not start", and the one they
    // cannot is "the board silently went somewhere else".
    if project.as_os_str().is_empty() {
        return usage("the project path is empty");
    }
    if !project.is_absolute() {
        return usage(&format!(
            "{} is not an absolute path",
            project.to_string_lossy()
        ));
    }

    // The directory is NOT required to exist yet, and a missing one is not
    // checked for here: a project with no board is the state every project
    // starts in, `rocplan` answers it with an empty board, and the first
    // `rocplan_create_task` creates the directory. Refusing to start would take
    // the tools away from exactly the sessions that would have created the
    // first card.
    let stdin = BufReader::new(io::stdin().lock());
    let stdout = io::stdout().lock();

    match rocspace_lib::mcp::serve(&project, stdin, stdout) {
        // stdin closed: the client is gone, which is the ordinary way this
        // process ends.
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("rocspace-mcp: {e}");
            ExitCode::FAILURE
        }
    }
}

/// Explain the argument this was started with, on stderr, and exit 2.
///
/// stderr because stdout belongs to the protocol even on the path where the
/// protocol never starts: a client that reads a usage message as a response
/// desynchronises rather than reporting a misconfigured server.
fn usage(problem: &str) -> ExitCode {
    eprintln!("rocspace-mcp: {problem}");
    eprintln!("usage: rocspace-mcp <absolute_project_path>");
    eprintln!("Serves <project_path>/.rocspace/plan.json as MCP tools over stdio.");
    ExitCode::from(2)
}

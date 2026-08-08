//! RocSpace shared data models.
//!
//! These types are the single source of truth for workspace state. They are serialized
//! over the Tauri IPC boundary and mirrored by hand into `src/lib/bindings.ts`.
//!
//! **Nothing regenerates that file.** The types derive `specta::Type` and
//! `make_specta_builder()` exists in `lib.rs`, but no `.export()` is ever called, so a
//! change here reaches TypeScript only when a person makes it. This comment used to
//! claim codegen ran on `pnpm tauri dev` startup; believing it is how you ship a
//! frontend that calls a command the release binary does not have. See follow-up #5.

use serde::{Deserialize, Serialize};
use specta::Type;

// ---------------------------------------------------------------------------
// Agent + permissions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentType {
    ClaudeCode,
    Codex,
    OpenCode,
    Shell,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSettings {
    pub auto_accept_edits: bool,
    pub ask_before_running_commands: bool,
    pub read_only_mode: bool,
    pub allow_file_edits: bool,
    pub allow_package_installs: bool,
    pub allow_git_commands: bool,
}

impl Default for PermissionSettings {
    /// Conservative defaults — no auto-accept, no installs, no git ops.
    /// User must opt in per terminal in the wizard or right panel.
    fn default() -> Self {
        Self {
            auto_accept_edits: false,
            ask_before_running_commands: true,
            read_only_mode: false,
            allow_file_edits: true,
            allow_package_installs: false,
            allow_git_commands: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    /// `type` in JSON — Rust reserves the keyword.
    #[serde(rename = "type")]
    pub agent_type: AgentType,
    pub task_prompt: Option<String>,
    pub model: Option<String>,
    pub permissions: PermissionSettings,
    pub custom_args: Option<Vec<String>>,
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatus {
    Idle,
    Running,
    AwaitingApproval,
    Error,
    Complete,
    Paused,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OutputStream {
    Stdout,
    Stderr,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputLine {
    pub id: String,
    pub ts: i64,
    pub stream: OutputStream,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: String,
    /// The workspace this session belongs to. Was `profile_id` through schema
    /// v5; the renderer's v6 migration rewrites the field in place (a profile
    /// id becomes the workspace id it migrated into).
    pub workspace_id: String,
    pub name: String,
    pub agent_config: AgentConfig,
    pub status: TerminalStatus,
    pub project_path: String,
    pub command_history: Vec<String>,
    pub output: Vec<TerminalOutputLine>,
    pub created_at: i64,
    pub updated_at: i64,
    /// Child PID of the live PTY, or `None` when nothing is running. Set from
    /// `SpawnResult` — before Phase 1 this was declared and never written.
    pub pid: Option<u32>,
    /// Claude Code `--session-id` of the live PTY. Generated fresh in Rust on
    /// every spawn (a restarted CLI cannot reuse a live session id), so it is
    /// `None` for every other agent type and for a terminal that has never
    /// been spawned. Additive since schema v5: absent in older snapshots.
    /// Phase 2 reads it back for `claude --resume {uuid}`.
    #[serde(default)]
    pub claude_session_id: Option<String>,
}

/// What `terminal_spawn` hands back: the identity of the process that was just
/// started. Both fields are recorded on the renderer's `TerminalSession`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    /// `None` when the platform declines to report a pid (portable-pty returns
    /// `Option<u32>`; the spawn itself still succeeded).
    pub pid: Option<u32>,
    /// Present only for `AgentType::ClaudeCode`.
    pub claude_session_id: Option<String>,
    /// The spawn was asked to resume a conversation Claude Code no longer has,
    /// and started a fresh one instead — `claude_session_id` above is the new
    /// conversation's, not the one that was asked for.
    ///
    /// The pane is running either way; this is what lets the renderer SAY so.
    /// A `--resume` at a conversation that was never written fails at launch
    /// and kills the pane (`agents::transcript`), and silently starting fresh
    /// instead would be the same lie in a friendlier costume: the user would
    /// find an agent with no memory of the work it was in the middle of and no
    /// indication that anything had been lost.
    pub conversation_lost: bool,
}

// ---------------------------------------------------------------------------
// Pane tree
// ---------------------------------------------------------------------------

/// `Row` = side-by-side, `Column` = stacked. Named for the flex direction of the
/// split, matching the CSS the renderer applies.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SplitDirection {
    Row,
    Column,
}

/// The binary split tree that lays out a workspace's panes. Mirrors
/// `src/lib/paneTree.ts`, which owns the operations — Rust only has to carry the
/// shape across IPC and through the persisted workspace.
///
/// Serialized internally tagged on `kind` (`{"kind":"leaf","terminalId":…}`) so
/// the TypeScript discriminated union deserializes without a wrapper object.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PaneNode {
    #[serde(rename_all = "camelCase")]
    Leaf { terminal_id: String },
    #[serde(rename_all = "camelCase")]
    Split {
        direction: SplitDirection,
        /// Fraction of the split given to `first`, clamped to [0.15, 0.85] by
        /// the renderer.
        ratio: f32,
        first: Box<PaneNode>,
        second: Box<PaneNode>,
    },
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/// The six accent slots a workspace can wear. Persisted verbatim (renaming one
/// is a migration); the renderer maps each to a theme token in
/// `src/lib/accentColors.ts`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceAccent {
    Violet,
    Cyan,
    Green,
    Amber,
    Rose,
    Blue,
}

/// A project workspace: one directory, one pane tree, one accent. Replaced the
/// workspace/profile/group triple in Phase 2. Sessions are NOT held here — they
/// live in the renderer's `useTerminalsStore` and point back via
/// `TerminalSession.workspace_id`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub accent: WorkspaceAccent,
    /// `None` = no directory chosen; panes spawn in the user's home.
    pub project_path: Option<String>,
    /// How this workspace's panes are split. `None` means "not derived yet" —
    /// the renderer rebuilds a balanced tree from its live sessions. The serde
    /// default is what lets a migrated snapshot with no tree deserialize.
    #[serde(default)]
    pub pane_tree: Option<PaneNode>,
    #[serde(default)]
    pub focused_terminal_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A directory the user has opened a workspace on. Offered by the
/// new-workspace modal, newest first.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub last_opened_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire shape `src/lib/paneTree.ts` declares. If this drifts, the
    /// renderer's discriminated union stops matching and every persisted layout
    /// silently degrades to a rebuilt balanced tree.
    #[test]
    fn pane_tree_serializes_as_a_kind_tagged_camel_case_union() {
        let tree = PaneNode::Split {
            direction: SplitDirection::Row,
            ratio: 0.5,
            first: Box::new(PaneNode::Leaf {
                terminal_id: "a".into(),
            }),
            second: Box::new(PaneNode::Leaf {
                terminal_id: "b".into(),
            }),
        };

        let json = serde_json::to_string(&tree).expect("serialize");

        assert_eq!(
            json,
            r#"{"kind":"split","direction":"row","ratio":0.5,"first":{"kind":"leaf","terminalId":"a"},"second":{"kind":"leaf","terminalId":"b"}}"#
        );
        assert_eq!(
            serde_json::from_str::<PaneNode>(&json).expect("round trip"),
            tree
        );
    }

    /// A workspace whose tree has not been derived yet (freshly migrated out of
    /// a v5 profile that never had one) must still deserialize.
    #[test]
    fn workspace_tolerates_a_missing_pane_tree() {
        let json = r#"{
            "id": "w1",
            "name": "rocspace",
            "accent": "violet",
            "projectPath": "/tmp/proj",
            "createdAt": 1,
            "updatedAt": 2
        }"#;

        let workspace: Workspace = serde_json::from_str(json).expect("deserialize");

        assert!(workspace.pane_tree.is_none());
        assert!(workspace.focused_terminal_id.is_none());
        assert_eq!(workspace.accent, WorkspaceAccent::Violet);
    }

    /// The accent is persisted as a bare lowercase string, which is what
    /// `src/lib/accentColors.ts` reads back out. Any other casing would make a
    /// round trip through Rust silently re-colour every workspace.
    #[test]
    fn workspace_accent_serializes_lowercase() {
        let json = serde_json::to_string(&WorkspaceAccent::Green).expect("serialize");
        assert_eq!(json, r#""green""#);
        assert_eq!(
            serde_json::from_str::<WorkspaceAccent>(r#""blue""#).expect("round trip"),
            WorkspaceAccent::Blue
        );
    }
}

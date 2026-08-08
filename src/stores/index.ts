/** Barrel export for stores. Prefer importing from "@/stores" rather than the
 * individual files so call sites stay stable as we refactor. */

export {
  useWorkspacesStore,
  useWorkspaces,
  useActiveWorkspace,
  useActiveWorkspaceId,
  useActiveWorkspacePaneTree,
  useWorkspaceById,
  setWorkspaceSpawner,
  restoreFocus,
  type CreateWorkspaceOptions,
  type WorkspacePaneCount,
  type WorkspacesActions,
  type WorkspacesState,
} from "@/stores/workspaces";

export {
  useTerminalsStore,
  useTerminalById,
  useActiveWorkspaceTerminals,
  useActiveWorkspaceTerminalCount,
  useCanAddPane,
  hasPaneRoom,
  OUTPUT_RING_BUFFER_CAP,
} from "@/stores/terminals";

export {
  useTerminalRuntimeStore,
  useTerminalHasUserInput,
  useTerminalConfigDirty,
  useResumableClaudeSession,
  useTerminalTurnFinished,
} from "@/stores/terminalRuntime";

export {
  useSavedSessionsStore,
  useSavedSessions,
} from "@/stores/savedSessions";

export {
  useHistoryStore,
  useStartupFailures,
  MAX_HISTORY_FAILURES,
  type StartupFailure,
} from "@/stores/history";

export {
  useUIStore,
  isAnyBlockingModalOpen,
  arePaneChordsBlocked,
  useFocusedTerminalId,
  useHighlightedTerminalId,
  useMaximizedTerminalId,
  useIsWorkspaceModalOpen,
  useIsSaveSessionModalOpen,
  useIsQuickOpenOpen,
  useEditorPrompt,
  useIsWhatsNewOpen,
  useIsSettingsOpen,
  useMainView,
  useSettingsSection,
  useTaskEditor,
  useGitDialog,
  useTopModal,
  DEFAULT_SETTINGS_SECTION,
  type GitDialogKind,
  type EditorPrompt,
  type MainView,
  type SettingsSectionId,
  type TaskEditorTarget,
} from "@/stores/ui";

export {
  useGitStore,
  useGitRepo,
  useGitStatus,
  useGitSelection,
  useGitBranches,
  useGitMessage,
  gitErrorMessage,
  hasStagedChanges,
  listFor,
  resetGitState,
  unstagePathsFor,
  watchGitRepo,
  type GitSelection,
} from "@/stores/git";

export {
  useConfirmStore,
  useConfirmRequest,
  confirmAction,
  isConfirmOpen,
  resetConfirmState,
  type ConfirmDraft,
  type ConfirmRequest,
} from "@/stores/confirm";

export {
  useNotificationsStore,
  useNotifications,
  useUnreadCount,
  type Notification,
  type NotificationKind,
} from "@/stores/notifications";

export {
  useToastsStore,
  useToasts,
  resetToastsState,
  TOAST_TTL_MS,
  type Toast,
  type ToastAction,
  type ToastDraft,
} from "@/stores/toasts";

export {
  useRocTalkStore,
  useRocTalkStatus,
  useRocTalkAmplitude,
  useRocTalkPosition,
} from "@/stores/roctalk";

export {
  useRocStore,
  useRocPhase,
  useRocOpen,
  useRocExpanded,
  useRocTranscript,
  useRocSelection,
  useRocLog,
  useRocFocusedRail,
  useRocReply,
  useRocBrainError,
  ROC_LOG_CAP,
  type RocDispatchRecord,
  type RocPhase,
  type RocTarget,
} from "@/stores/roc";

export {
  useSettingsStore,
  useThemeId,
  useTerminalSettings,
  useAgentDefaults,
  useVoiceSettings,
  useRocSettings,
  useNotificationSettings,
  useZoom,
  useWhatsNewSeen,
  useSettingsHydrated,
  DEFAULT_AGENT_DEFAULTS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_TERMINAL_SETTINGS,
  DEFAULT_VOICE_SETTINGS,
  DEFAULT_ROC_SETTINGS,
  PERMISSION_MODES,
  ROC_PERSONAS,
  ROC_SPEECH_RATE_MAX,
  ROC_SPEECH_RATE_MIN,
  SCROLLBACK_OPTIONS,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  VOICE_ROUTES,
  WINDOWS_PTT_ACCELERATOR,
  type AgentDefaults,
  type NotificationSettings,
  type PermissionMode,
  type RocPersona,
  type RocSettings,
  type TerminalSettings,
  type VoiceRoute,
  type VoiceSettings,
} from "@/stores/settings";

export {
  useRocPlanStore,
  useBoardTasks,
  useBoardError,
  useBoardLoaded,
  useBoardLoading,
  useTasksByStatus,
  ensureBoardLoaded,
  holdBoard,
  flushPlanWrites,
  hasPendingPlanWrite,
  isBoardFollowed,
  resetRocPlanModuleState,
  PLAN_WRITE_DEBOUNCE_MS,
  ROC_TASK_PRIORITIES,
  ROC_TASK_STATUSES,
  type BoardError,
  type BoardHold,
  type RocPlanActions,
  type RocPlanState,
} from "@/stores/rocplan";

export {
  useRocMindStore,
  useMindScopes,
  useMindMemories,
  useMindSelected,
  useMindBody,
  useMindTree,
  useMindActiveScope,
  useMindQuery,
  useMindExpanded,
  useMindSearchResults,
  useMindGraphSource,
  useMindBacklinks,
  onMindScopeChanged,
  resetRocMindModuleState,
  type MindPanel,
  type RocMindActions,
  type RocMindState,
} from "@/stores/rocmind";

export {
  useEditorStore,
  useRightDockMode,
  useRightPanelCollapsed,
  useSidebarCollapsed,
  useRocViewLayout,
  useEditorTabs,
  useActiveEditorPath,
  useActiveEditorTab,
  useDirtyBuffers,
  useDirtyBuffer,
  useIsDirty,
  hasUnsavedBuffers,
  type RightDockMode,
  type EditorTab,
} from "@/stores/editor";

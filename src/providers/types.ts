/**
 * Thin provider interface for coding-agent session backends.
 * Codex is first-class; Claude is stubbed.
 */

export type ProviderName = 'codex' | 'claude' | 'muse';

export type SessionSource = 'wingman' | 'discovered';

export interface SessionSummary {
  id: string;
  provider: ProviderName;
  cwd?: string;
  preview?: string;
  name?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  /** Origin of this session: 'wingman' = created via Wingman, 'discovered' = found via SDK/disk. */
  source?: SessionSource;
  /** Git branch at end of session (discovered sessions). */
  gitBranch?: string;
  /** User-set tag (discovered sessions - legacy single tag). */
  tag?: string;
  /** User-set tags for categorization/filtering. */
  tags?: string[];
  /** Host identifier for multi-host setups. */
  hostId?: string;
  /** Human-friendly host name for display. */
  hostName?: string;
}

export interface TranscriptItem {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'unknown';
  text: string;
  turnId?: string;
  itemId?: string;
  type?: string;
}

export interface Transcript {
  sessionId: string;
  provider: ProviderName;
  items: TranscriptItem[];
}

export interface SendMessageResult {
  sessionId: string;
  turnId?: string;
  status: string;
}

export interface InterruptResult {
  sessionId: string;
  turnId?: string;
  status: string;
}

export interface CreateSessionResult {
  sessionId: string;
  provider: ProviderName;
  cwd?: string;
  /** Status: 'created' (no prompt), 'accepted' (prompt started in background) */
  status?: 'created' | 'accepted';
  /** Turn ID when prompt is provided and status is 'accepted' */
  turnId?: string;
  /** Model used for the session (Codex-specific; from explicit arg or WINGMAN_CODEX_MODEL) */
  model?: string;
}

export interface SessionDetail extends SessionSummary {
  activeTurnId?: string;
  activeTurnStartedAt?: number;
  /** User-set tags for categorization/filtering. */
  tags?: string[];
}

export interface WaitTurnOptions {
  /** Maximum time to wait in milliseconds (default: 60000) */
  timeoutMs?: number;
  /** Poll interval in milliseconds for checking turn status (default: 500) */
  pollIntervalMs?: number;
}

export interface WaitTurnResult {
  sessionId: string;
  turnId?: string;
  /** Final status: 'completed' | 'interrupted' | 'failed' | 'timeout' | 'idle' */
  status: 'completed' | 'interrupted' | 'failed' | 'timeout' | 'idle';
  /** Snippet of the latest agent message if available */
  latestMessage?: string;
  /** Error message if status is 'failed' */
  error?: string;
}

export interface SteerResult {
  sessionId: string;
  turnId?: string;
  /** Whether the steer was accepted */
  accepted: boolean;
  /** Error message if not accepted */
  error?: string;
}

export type ApprovalKind = 'command' | 'fileChange' | 'network' | 'writeStdin';
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface Approval {
  /** Unique approval ID */
  id: string;
  /** Session ID this approval belongs to */
  sessionId: string;
  /** Turn ID this approval belongs to */
  turnId?: string;
  /** Item ID if associated with an item */
  itemId?: string;
  /** Kind of approval request */
  kind: ApprovalKind;
  /** Command to execute (for command approvals) */
  command?: string;
  /** Working directory (for command approvals) */
  cwd?: string;
  /** Description / reason for the approval */
  reason?: string;
  /** Timestamp when approval was requested */
  requestedAt: number;
}

export interface ListApprovalsResult {
  sessionId: string;
  approvals: Approval[];
}

export interface ResolveApprovalResult {
  sessionId: string;
  approvalId: string;
  /** Whether the resolution was applied */
  resolved: boolean;
  /** Decision that was applied */
  decision?: ApprovalDecision;
  /** Error message if not resolved */
  error?: string;
}

export interface SetSessionMetaOptions {
  /** Human-friendly name for the session */
  name?: string;
  /** Tags for categorization/filtering */
  tags?: string[];
}

export interface SetSessionMetaResult {
  sessionId: string;
  /** Whether the metadata was updated */
  updated: boolean;
  /** Current name after update */
  name?: string;
  /** Current tags after update */
  tags?: string[];
  /** Error message if not updated */
  error?: string;
}

export interface CreateSessionOptions {
  cwd?: string;
  prompt?: string;
  name?: string;
  tags?: string[];
  /** Model override for Codex sessions. Optional; defaults to Codex config/defaults. */
  model?: string;
}

export interface SessionProvider {
  readonly name: ProviderName;
  listSessions(): Promise<SessionSummary[]>;
  getSession?(sessionId: string): Promise<SessionDetail | null>;
  readTranscript(sessionId: string, limit?: number): Promise<Transcript>;
  sendMessage(sessionId: string, text: string, opts?: { originBotId?: string }): Promise<SendMessageResult>;
  interrupt(sessionId: string): Promise<InterruptResult>;
  createSession?(opts?: CreateSessionOptions): Promise<CreateSessionResult>;
  
  /** Wait for an active turn to complete (Codex-specific) */
  waitTurn?(sessionId: string, opts?: WaitTurnOptions): Promise<WaitTurnResult>;
  /** Add guidance to an in-flight turn without starting a new turn (Codex-specific) */
  steer?(sessionId: string, text: string, opts?: { originBotId?: string }): Promise<SteerResult>;
  /** List pending approvals for a session (Codex-specific) */
  listApprovals?(sessionId: string): Promise<ListApprovalsResult>;
  /** Resolve a pending approval (Codex-specific) */
  resolveApproval?(sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<ResolveApprovalResult>;
  /** Set session metadata (name, tags) for easier discovery */
  setSessionMeta?(sessionId: string, meta: SetSessionMetaOptions): Promise<SetSessionMetaResult>;
}

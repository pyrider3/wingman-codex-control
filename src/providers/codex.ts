/**
 * Codex app-server client (JSON-RPC over stdio).
 *
 * Docs:
 * - https://learn.chatgpt.com/docs/app-server
 * - https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
 *
 * Methods used (v2):
 * - initialize / initialized
 * - thread/list, thread/start, thread/resume, thread/read
 * - turn/start, turn/interrupt
 *
 * Do NOT use removed/legacy `codex mcp-server` for this bridge.
 * Set CODEX_MOCK=1 for in-memory mock mode (no codex binary required).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type {
  Approval,
  ApprovalDecision,
  ApprovalKind,
  CreateSessionResult,
  InterruptResult,
  ListApprovalsResult,
  ResolveApprovalResult,
  SendMessageResult,
  SessionDetail,
  SessionProvider,
  SessionSummary,
  SteerResult,
  Transcript,
  TranscriptItem,
  WaitTurnOptions,
  WaitTurnResult,
  SetSessionMetaResult,
} from './types.js';
import {
  resolveWaitTurnTimeoutMs,
  resolveWaitTurnPollMs,
  resolveCodexModel,
  resolveHostId,
  resolveHostName,
} from '../config.js';

type JsonRpcId = number;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

interface MockApproval extends Approval {
  jsonRpcId?: number;
}

interface MockSession {
  id: string;
  cwd?: string;
  name?: string;
  preview?: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
  items: TranscriptItem[];
  activeTurnId?: string;
  turnStartedAt?: number;
  pendingApprovals: MockApproval[];
}

function useMock(): boolean {
  return process.env.CODEX_MOCK === '1' || process.env.CODEX_MOCK === 'true';
}

interface PendingApproval {
  requestId: JsonRpcId;
  approval: Approval;
}

interface TurnState {
  turnId: string;
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed';
  latestMessage?: string;
  error?: string;
  completedAt?: number;
}

export class CodexProvider implements SessionProvider {
  readonly name = 'codex' as const;
  private mockSessions = new Map<string, MockSession>();
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private activeTurns = new Map<string, string>(); // threadId -> turnId
  private turnStates = new Map<string, TurnState>(); // threadId -> TurnState
  private pendingApprovals = new Map<string, PendingApproval[]>(); // threadId -> approvals
  private ready: Promise<void> | null = null;

  constructor() {
    if (useMock()) {
      // Seed a couple of mock sessions for easy pair demos.
      const a = this.seedMock({ cwd: process.cwd(), name: 'mock-demo', preview: 'Hello from mock Codex' });
      a.items.push(
        { role: 'user', text: 'Hello from mock Codex', turnId: 'turn_mock_1' },
        { role: 'assistant', text: 'Mock Codex ready. Set CODEX_MOCK=0 and install `codex` for real mode.', turnId: 'turn_mock_1' },
      );
    }
  }

  private seedMock(opts?: { cwd?: string; name?: string; preview?: string; tags?: string[] }): MockSession {
    const now = Date.now();
    const s: MockSession = {
      id: `thr_mock_${randomUUID().slice(0, 8)}`,
      cwd: opts?.cwd,
      name: opts?.name,
      preview: opts?.preview,
      tags: opts?.tags,
      createdAt: now,
      updatedAt: now,
      items: [],
      pendingApprovals: [],
    };
    this.mockSessions.set(s.id, s);
    return s;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const hostId = resolveHostId();
    const hostName = resolveHostName();
    
    if (useMock()) {
      return [...this.mockSessions.values()].map((s) => ({
        id: s.id,
        provider: 'codex',
        cwd: s.cwd,
        name: s.name,
        preview: s.preview,
        tags: s.tags,
        status: s.activeTurnId ? 'active' : 'idle',
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        hostId,
        hostName,
      }));
    }

    await this.ensureConnected();
    const result = (await this.request('thread/list', {
      cursor: null,
      limit: 50,
      sortKey: 'updated_at',
    })) as { data?: Array<Record<string, unknown>> };

    return (result.data ?? []).map((t) => ({
      id: String(t.id ?? ''),
      provider: 'codex' as const,
      cwd: typeof t.cwd === 'string' ? t.cwd : undefined,
      name: typeof t.name === 'string' ? t.name : undefined,
      preview: typeof t.preview === 'string' ? t.preview : undefined,
      status: summarizeStatus(t.status),
      createdAt: typeof t.createdAt === 'number' ? t.createdAt : undefined,
      updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : undefined,
      hostId,
      hostName,
    }));
  }

  async getSession(sessionId: string): Promise<SessionDetail | null> {
    const hostId = resolveHostId();
    const hostName = resolveHostName();
    
    if (useMock()) {
      const s = this.mockSessions.get(sessionId);
      if (!s) return null;
      const activeTurnId = this.activeTurns.get(sessionId);
      return {
        id: s.id,
        provider: 'codex',
        cwd: s.cwd,
        name: s.name,
        preview: s.preview,
        tags: s.tags,
        status: activeTurnId ? 'running' : (s.activeTurnId ? 'active' : 'idle'),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        activeTurnId: activeTurnId ?? s.activeTurnId,
        hostId,
        hostName,
      };
    }

    const sessions = await this.listSessions();
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return null;

    const activeTurnId = this.activeTurns.get(sessionId);
    return {
      ...session,
      status: activeTurnId ? 'running' : session.status,
      activeTurnId,
      hostId,
      hostName,
    };
  }

  async readTranscript(sessionId: string, limit = 50): Promise<Transcript> {
    if (useMock()) {
      const s = this.mockSessions.get(sessionId);
      if (!s) throw new Error(`Unknown mock session: ${sessionId}`);
      const items = s.items.slice(-Math.max(1, limit));
      return { sessionId, provider: 'codex', items };
    }

    await this.ensureConnected();
    // Read persisted history without loading a second live copy of a desktop thread.
    const read = (await this.request('thread/read', {
      threadId: sessionId,
      includeTurns: true,
    })) as { thread?: Record<string, unknown> };
    const thread = read.thread ?? {};
    const items = extractTranscriptItems(thread).slice(-Math.max(1, limit));
    return { sessionId, provider: 'codex', items };
  }

  async sendMessage(sessionId: string, text: string): Promise<SendMessageResult> {
    if (useMock()) {
      const s = this.mockSessions.get(sessionId);
      if (!s) throw new Error(`Unknown mock session: ${sessionId}`);
      const turnId = `turn_mock_${randomUUID().slice(0, 8)}`;
      s.activeTurnId = turnId;
      s.turnStartedAt = Date.now();
      s.items.push({ role: 'user', text, turnId });
      
      // Simulate approval request if message contains "sudo" or "rm"
      const needsApproval = /\b(sudo|rm\s+-rf?)\b/i.test(text);
      if (needsApproval) {
        const approval: MockApproval = {
          id: `appr_mock_${randomUUID().slice(0, 8)}`,
          sessionId,
          turnId,
          kind: 'command',
          command: text,
          cwd: s.cwd,
          reason: 'Command requires approval',
          requestedAt: Date.now(),
        };
        s.pendingApprovals.push(approval);
        // Turn stays in progress waiting for approval
        return { sessionId, turnId, status: 'inProgress' };
      }
      
      // Simulate async turn completion
      setTimeout(() => {
        if (s.activeTurnId === turnId) {
          s.items.push({
            role: 'assistant',
            text: `[mock] Received: ${text}`,
            turnId,
          });
          s.preview = text.slice(0, 80);
          s.updatedAt = Date.now();
          s.activeTurnId = undefined;
          s.turnStartedAt = undefined;
        }
      }, 50);
      
      return { sessionId, turnId, status: 'inProgress' };
    }

    await this.ensureConnected();
    // Ensure thread is loaded before turn/start.
    try {
      await this.request('thread/resume', { threadId: sessionId });
    } catch {
      // Thread may already be loaded; continue.
    }

    const result = (await this.request('turn/start', {
      threadId: sessionId,
      input: [{ type: 'text', text }],
    })) as { turn?: { id?: string; status?: string } };

    const turnId = result.turn?.id;
    if (turnId) this.activeTurns.set(sessionId, turnId);
    return {
      sessionId,
      turnId,
      status: result.turn?.status ?? 'inProgress',
    };
  }

  async interrupt(sessionId: string): Promise<InterruptResult> {
    if (useMock()) {
      const s = this.mockSessions.get(sessionId);
      if (!s) throw new Error(`Unknown mock session: ${sessionId}`);
      const turnId = s.activeTurnId;
      s.activeTurnId = undefined;
      s.items.push({
        role: 'system',
        text: '[mock] Interrupted',
        turnId,
      });
      return { sessionId, turnId, status: 'interrupted' };
    }

    await this.ensureConnected();
    const turnId = this.activeTurns.get(sessionId);
    if (!turnId) {
      // Best-effort: interrupt without a known turnId is not supported by protocol.
      // TODO: track turnId from turn/started notifications for accuracy.
      throw new Error(
        `No known active turnId for session ${sessionId}. ` +
          `Send a message first, or track turn/started notifications.`,
      );
    }

    await this.request('turn/interrupt', { threadId: sessionId, turnId });
    this.activeTurns.delete(sessionId);
    return { sessionId, turnId, status: 'interrupted' };
  }

  async createSession(opts?: { cwd?: string; prompt?: string; name?: string; tags?: string[]; model?: string }): Promise<CreateSessionResult> {
    // Resolve model: explicit arg > WINGMAN_CODEX_MODEL env > undefined (use Codex default)
    const model = resolveCodexModel(opts?.model);
    
    if (useMock()) {
      const s = this.seedMock({
        cwd: opts?.cwd ?? process.cwd(),
        name: opts?.name ?? 'mock-created',
        preview: opts?.prompt?.slice(0, 80),
        tags: opts?.tags,
      });
      if (opts?.prompt) {
        await this.sendMessage(s.id, opts.prompt);
      }
      return { sessionId: s.id, provider: 'codex', cwd: s.cwd, model };
    }

    await this.ensureConnected();
    const params: Record<string, unknown> = {};
    if (opts?.cwd) params.cwd = opts.cwd;
    // Note: Codex app-server thread/start may not support model param directly.
    // The model is typically read from user's ~/.codex/config.toml.
    // For Wingman-spawned sessions, setting CODEX_MODEL env may work,
    // or users can pre-configure their config.toml. Document this limitation.
    if (model) params.model = model;

    const result = (await this.request('thread/start', params)) as {
      thread?: { id?: string };
    };
    const sessionId = result.thread?.id;
    if (!sessionId) throw new Error('thread/start did not return thread.id');

    if (opts?.prompt) {
      await this.sendMessage(sessionId, opts.prompt);
    }

    return { sessionId, provider: 'codex', cwd: opts?.cwd, model };
  }

  async waitTurn(sessionId: string, opts?: WaitTurnOptions): Promise<WaitTurnResult> {
    const timeoutMs = opts?.timeoutMs ?? resolveWaitTurnTimeoutMs();
    const pollIntervalMs = opts?.pollIntervalMs ?? resolveWaitTurnPollMs();

    if (useMock()) {
      const s = this.mockSessions.get(sessionId);
      if (!s) throw new Error(`Unknown mock session: ${sessionId}`);

      // No active turn
      if (!s.activeTurnId) {
        const lastAssistant = [...s.items].reverse().find((i) => i.role === 'assistant');
        return {
          sessionId,
          status: 'idle',
          latestMessage: lastAssistant?.text?.slice(0, 200),
        };
      }

      // If there are pending approvals, return waiting status
      if (s.pendingApprovals.length > 0) {
        return {
          sessionId,
          turnId: s.activeTurnId,
          status: 'inProgress' as WaitTurnResult['status'],
          latestMessage: `Waiting for ${s.pendingApprovals.length} approval(s)`,
        };
      }

      const turnId = s.activeTurnId;
      const startTime = Date.now();

      // Poll until turn completes or timeout
      while (Date.now() - startTime < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        
        if (!s.activeTurnId || s.activeTurnId !== turnId) {
          // Turn completed
          const lastAssistant = [...s.items]
            .reverse()
            .find((i) => i.role === 'assistant' && i.turnId === turnId);
          return {
            sessionId,
            turnId,
            status: 'completed',
            latestMessage: lastAssistant?.text?.slice(0, 200),
          };
        }

        // Check for pending approvals
        if (s.pendingApprovals.length > 0) {
          return {
            sessionId,
            turnId,
            status: 'inProgress' as WaitTurnResult['status'],
            latestMessage: `Waiting for ${s.pendingApprovals.length} approval(s)`,
          };
        }
      }

      return { sessionId, turnId, status: 'timeout' };
    }

    // Real mode: poll turn state
    const turnId = this.activeTurns.get(sessionId);
    if (!turnId) {
      return { sessionId, status: 'idle' };
    }

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const state = this.turnStates.get(sessionId);
      if (state && state.turnId === turnId) {
        if (state.status !== 'inProgress') {
          return {
            sessionId,
            turnId,
            status: state.status,
            latestMessage: state.latestMessage?.slice(0, 200),
            error: state.error,
          };
        }
      }

      // Check for pending approvals
      const approvals = this.pendingApprovals.get(sessionId) ?? [];
      if (approvals.length > 0) {
        return {
          sessionId,
          turnId,
          status: 'inProgress' as WaitTurnResult['status'],
          latestMessage: `Waiting for ${approvals.length} approval(s)`,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return { sessionId, turnId, status: 'timeout' };
  }

  async steer(sessionId: string, text: string): Promise<SteerResult> {
    if (useMock()) {
      const s = this.mockSessions.get(sessionId);
      if (!s) throw new Error(`Unknown mock session: ${sessionId}`);

      if (!s.activeTurnId) {
        return {
          sessionId,
          accepted: false,
          error: 'No active turn to steer. Use send_message to start a turn first.',
        };
      }

      // Add steering input to the turn
      s.items.push({ role: 'user', text: `[steer] ${text}`, turnId: s.activeTurnId });
      return { sessionId, turnId: s.activeTurnId, accepted: true };
    }

    // Real mode: call turn/steer
    await this.ensureConnected();
    const turnId = this.activeTurns.get(sessionId);
    if (!turnId) {
      return {
        sessionId,
        accepted: false,
        error: 'No active turn to steer. Use send_message to start a turn first.',
      };
    }

    try {
      const result = (await this.request('turn/steer', {
        threadId: sessionId,
        input: [{ type: 'text', text }],
      })) as { turnId?: string };

      return {
        sessionId,
        turnId: result.turnId ?? turnId,
        accepted: true,
      };
    } catch (err) {
      return {
        sessionId,
        turnId,
        accepted: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listApprovals(sessionId: string): Promise<ListApprovalsResult> {
    if (useMock()) {
      const s = this.mockSessions.get(sessionId);
      if (!s) throw new Error(`Unknown mock session: ${sessionId}`);
      return { sessionId, approvals: [...s.pendingApprovals] };
    }

    // Real mode: return tracked pending approvals
    const approvals = this.pendingApprovals.get(sessionId) ?? [];
    return {
      sessionId,
      approvals: approvals.map((p) => p.approval),
    };
  }

  async resolveApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<ResolveApprovalResult> {
    if (useMock()) {
      const s = this.mockSessions.get(sessionId);
      if (!s) throw new Error(`Unknown mock session: ${sessionId}`);

      const idx = s.pendingApprovals.findIndex((a) => a.id === approvalId);
      if (idx === -1) {
        return {
          sessionId,
          approvalId,
          resolved: false,
          error: `Approval not found: ${approvalId}`,
        };
      }

      const approval = s.pendingApprovals[idx];
      s.pendingApprovals.splice(idx, 1);

      // Add result to transcript
      const turnId = approval.turnId;
      if (decision === 'accept' || decision === 'acceptForSession') {
        s.items.push({
          role: 'system',
          text: `[mock] Approval ${approvalId} accepted`,
          turnId,
        });

        // Complete the turn after approval if no more pending
        if (s.pendingApprovals.length === 0 && s.activeTurnId) {
          setTimeout(() => {
            if (s.activeTurnId === turnId) {
              s.items.push({
                role: 'assistant',
                text: `[mock] Command executed after approval`,
                turnId,
              });
              s.updatedAt = Date.now();
              s.activeTurnId = undefined;
              s.turnStartedAt = undefined;
            }
          }, 30);
        }
      } else {
        s.items.push({
          role: 'system',
          text: `[mock] Approval ${approvalId} ${decision}d`,
          turnId,
        });
        // Turn ends on decline/cancel
        s.activeTurnId = undefined;
        s.turnStartedAt = undefined;
      }

      return { sessionId, approvalId, resolved: true, decision };
    }

    // Real mode: respond to the JSON-RPC request
    const approvals = this.pendingApprovals.get(sessionId);
    if (!approvals) {
      return {
        sessionId,
        approvalId,
        resolved: false,
        error: `No pending approvals for session: ${sessionId}`,
      };
    }

    const idx = approvals.findIndex((p) => p.approval.id === approvalId);
    if (idx === -1) {
      return {
        sessionId,
        approvalId,
        resolved: false,
        error: `Approval not found: ${approvalId}`,
      };
    }

    const pending = approvals[idx];
    approvals.splice(idx, 1);

    // Send response to the JSON-RPC request
    if (this.proc?.stdin.writable) {
      const response = {
        id: pending.requestId,
        result: { decision },
      };
      this.proc.stdin.write(`${JSON.stringify(response)}\n`);
    }

    return { sessionId, approvalId, resolved: true, decision };
  }

  async setSessionMeta(
    sessionId: string,
    meta: { name?: string; tags?: string[] },
  ): Promise<SetSessionMetaResult> {
    if (useMock()) {
      const s = this.mockSessions.get(sessionId);
      if (!s) {
        return {
          sessionId,
          updated: false,
          error: `Session not found: ${sessionId}`,
        };
      }
      if (meta.name !== undefined) s.name = meta.name;
      if (meta.tags !== undefined) s.tags = meta.tags;
      s.updatedAt = Date.now();
      return {
        sessionId,
        updated: true,
        name: s.name,
        tags: s.tags,
      };
    }

    // Real mode: Codex doesn't support session metadata natively
    // We would need a local registry similar to Claude, but for now return an error
    return {
      sessionId,
      updated: false,
      error: 'Session metadata is not supported for Codex sessions in real mode (Codex app-server does not support custom metadata)',
    };
  }

  async close(): Promise<void> {
    if (this.proc) {
      for (const [, p] of this.pending) {
        p.reject(new Error('Codex app-server closed'));
      }
      this.pending.clear();
      this.proc.kill();
      this.proc = null;
      this.ready = null;
    }
  }

  private ensureConnected(): Promise<void> {
    if (useMock()) return Promise.resolve();
    if (this.ready) return this.ready;
    this.ready = this.startProcess();
    return this.ready;
  }

  private async startProcess(): Promise<void> {
    // Prefer `codex app-server` (default stdio). See docs linked above.
    const bin = process.env.CODEX_BIN?.trim() || 'codex';
    const args = (process.env.CODEX_APP_SERVER_ARGS ?? 'app-server')
      .split(/\s+/)
      .filter(Boolean);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      throw new Error(
        `Failed to spawn Codex app-server (${bin} ${args.join(' ')}): ${(err as Error).message}. ` +
          `Install Codex CLI and ensure \`codex\` is on PATH, or set CODEX_MOCK=1.`,
      );
    }

    this.proc = child;

    child.on('error', (err) => {
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.proc = null;
      this.ready = null;
    });

    child.on('close', (code) => {
      const err = new Error(`Codex app-server exited with code ${code}`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.proc = null;
      this.ready = null;
    });

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.onLine(line));

    child.stderr.on('data', (buf: Buffer) => {
      const msg = buf.toString('utf8').trim();
      if (msg) console.error('[codex app-server]', msg);
    });

    // Handshake required before any other method.
    await this.request('initialize', {
      clientInfo: {
        name: 'wingman',
        title: 'Wingman',
        version: '0.1.0',
      },
    });
    this.notify('initialized', {});
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: {
      id?: JsonRpcId;
      result?: unknown;
      error?: { code?: number; message?: string };
      method?: string;
      params?: unknown;
    };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      console.error('[codex] non-JSON line:', trimmed.slice(0, 200));
      return;
    }

    // Track turn lifecycle from notifications.
    if (msg.method === 'turn/started') {
      const params = msg.params as { turn?: { id?: string }; threadId?: string } | undefined;
      const turnId = params?.turn?.id;
      const threadId = (params as { threadId?: string } | undefined)?.threadId;
      if (threadId && turnId) {
        this.activeTurns.set(threadId, turnId);
        this.turnStates.set(threadId, { turnId, status: 'inProgress' });
      }
    }

    if (msg.method === 'turn/completed') {
      const params = msg.params as {
        turn?: { id?: string; status?: string; error?: { message?: string } };
        threadId?: string;
      } | undefined;
      const threadId = (params as { threadId?: string } | undefined)?.threadId;
      const turnId = params?.turn?.id;
      const status = params?.turn?.status as 'completed' | 'interrupted' | 'failed' | undefined;
      const errorMsg = params?.turn?.error?.message;
      if (threadId && turnId) {
        this.activeTurns.delete(threadId);
        this.turnStates.set(threadId, {
          turnId,
          status: status ?? 'completed',
          error: errorMsg,
          completedAt: Date.now(),
        });
      }
    }

    // Handle server-initiated approval requests
    if (
      msg.method === 'item/commandExecution/requestApproval' ||
      msg.method === 'item/fileChange/requestApproval'
    ) {
      const requestId = msg.id as JsonRpcId;
      const params = msg.params as {
        threadId?: string;
        turnId?: string;
        itemId?: string;
        command?: string;
        cwd?: string;
        reason?: string;
        kind?: string;
      } | undefined;

      if (params?.threadId && requestId !== undefined && requestId !== null) {
        const kind: ApprovalKind = msg.method.includes('fileChange')
          ? 'fileChange'
          : (params.kind as ApprovalKind) ?? 'command';

        const approval: Approval = {
          id: `appr_${requestId}_${Date.now()}`,
          sessionId: params.threadId,
          turnId: params.turnId,
          itemId: params.itemId,
          kind,
          command: params.command,
          cwd: params.cwd,
          reason: params.reason,
          requestedAt: Date.now(),
        };

        const list = this.pendingApprovals.get(params.threadId) ?? [];
        list.push({ requestId, approval });
        this.pendingApprovals.set(params.threadId, list);
      }
      return; // Don't process as regular request/response
    }

    // Handle serverRequest/resolved to clean up approvals
    if (msg.method === 'serverRequest/resolved') {
      const params = msg.params as { threadId?: string; requestId?: JsonRpcId } | undefined;
      if (params?.threadId && params.requestId !== undefined) {
        const list = this.pendingApprovals.get(params.threadId);
        if (list) {
          const idx = list.findIndex((p) => p.requestId === params.requestId);
          if (idx !== -1) {
            list.splice(idx, 1);
          }
        }
      }
    }

    if (msg.id === undefined || msg.id === null) return; // notification
    const pending = this.pending.get(msg.id as JsonRpcId);
    if (!pending) return;
    this.pending.delete(msg.id as JsonRpcId);
    if (msg.error) {
      pending.reject(
        new Error(`Codex RPC error ${msg.error.code ?? '?'}: ${msg.error.message ?? 'unknown'}`),
      );
    } else {
      pending.resolve(msg.result);
    }
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (!this.proc?.stdin.writable) {
      return Promise.reject(new Error('Codex app-server is not running'));
    }
    const id = this.nextId++;
    const payload = { method, id, params: params ?? {} };
    // Wire format omits "jsonrpc":"2.0" per Codex docs.
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timeoutMs = Number(process.env.CODEX_RPC_TIMEOUT_MS ?? 60_000);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Codex RPC timeout after ${timeoutMs}ms: ${method}`));
        }
      }, timeoutMs).unref?.();
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.proc?.stdin.writable) return;
    this.proc.stdin.write(`${JSON.stringify({ method, params: params ?? {} })}\n`);
  }
}

function summarizeStatus(status: unknown): string | undefined {
  if (!status) return undefined;
  if (typeof status === 'string') return status;
  if (typeof status === 'object' && status !== null && 'type' in status) {
    return String((status as { type: unknown }).type);
  }
  return undefined;
}

function extractTranscriptItems(thread: Record<string, unknown>): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const turn of turns) {
    if (!turn || typeof turn !== 'object') continue;
    const t = turn as { id?: string; items?: unknown[] };
    const turnItems = Array.isArray(t.items) ? t.items : [];
    for (const raw of turnItems) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const type = typeof item.type === 'string' ? item.type : 'unknown';
      const itemId = typeof item.id === 'string' ? item.id : undefined;
      if (type === 'userMessage') {
        items.push({
          role: 'user',
          text: contentToText(item.content) || String(item.text ?? ''),
          turnId: t.id,
          itemId,
          type,
        });
      } else if (type === 'agentMessage') {
        items.push({
          role: 'assistant',
          text: String(item.text ?? contentToText(item.content) ?? ''),
          turnId: t.id,
          itemId,
          type,
        });
      } else if (typeof item.text === 'string' && item.text) {
        items.push({
          role: 'unknown',
          text: item.text,
          turnId: t.id,
          itemId,
          type,
        });
      }
    }
  }
  return items;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (!c || typeof c !== 'object') return '';
      const o = c as { type?: string; text?: string };
      if (o.type === 'text' || o.type === 'output_text') return o.text ?? '';
      return o.text ?? '';
    })
    .filter(Boolean)
    .join('\n');
}

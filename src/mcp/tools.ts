import { z } from 'zod';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderRegistry, ProviderName } from '../providers/index.js';
import type { Transcript, TranscriptItem } from '../providers/types.js';

export const ProviderSchema = z.enum(['codex', 'claude', 'muse']);
export const ExportFormatSchema = z.enum(['markdown', 'json']);

export const ListSessionsSchema = z.object({
  provider: ProviderSchema.optional(),
});

export const ReadTranscriptSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  limit: z.number().int().positive().max(500).optional(),
});

export const SendMessageSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  text: z.string().min(1),
  origin_bot_id: z.string().uuid().optional(),
});

export const InterruptSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
});

export const CreateSessionSchema = z.object({
  provider: ProviderSchema,
  cwd: z.string().optional(),
  prompt: z.string().optional(),
  name: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** Model override for Codex sessions. Optional; defaults to Codex config/defaults. Ignored for other providers. */
  model: z.string().optional(),
});

export const SetSessionMetaSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  name: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const GetSessionSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
});

export const WaitTurnSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  timeout_ms: z.number().int().positive().max(300_000).optional(),
  poll_interval_ms: z.number().int().positive().max(10_000).optional(),
});

export const SteerSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  text: z.string().min(1),
  origin_bot_id: z.string().uuid().optional(),
});

export const ListApprovalsSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
});

export const ApprovalDecisionSchema = z.enum(['accept', 'acceptForSession', 'decline', 'cancel']);

export const ResolveApprovalSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  approval_id: z.string().min(1),
  decision: ApprovalDecisionSchema,
});

export const ExportTranscriptSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  format: ExportFormatSchema,
  limit: z.number().int().positive().max(500).optional(),
});

function textResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: message }],
  };
}

export function createToolHandlers(providers: ProviderRegistry) {
  return {
    async list_sessions(args: z.infer<typeof ListSessionsSchema>) {
      try {
        const names: ProviderName[] = args.provider
          ? [args.provider]
          : ['codex', 'claude', 'muse'];
        const sessions = [];
        for (const name of names) {
          try {
            const list = await providers.get(name).listSessions();
            sessions.push(...list);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const isSpawnError = errMsg.includes('ENOENT') || errMsg.includes('spawn') || errMsg.includes('not found');
            
            if (name === 'codex') {
              // Gracefully degrade when Codex binary not found (Windows PATH issue, etc.)
              // Instead of hard-failing, return a stub so Claude-only mode works
              sessions.push({
                id: '_codex_stub',
                provider: 'codex' as const,
                preview: isSpawnError 
                  ? 'Codex binary not found — install Codex or set CODEX_MOCK=1' 
                  : errMsg,
                status: 'not_enabled',
              });
            } else if (name === 'claude') {
              sessions.push({
                id: '_claude_stub',
                provider: 'claude' as const,
                preview: errMsg,
                status: 'not_enabled',
              });
            } else if (name === 'muse') {
              sessions.push({
                id: '_muse_stub',
                provider: 'muse' as const,
                preview: errMsg,
                status: 'not_enabled',
              });
            } else {
              throw err;
            }
          }
        }
        return textResult({ sessions });
      } catch (err) {
        return errorResult(err);
      }
    },

    async read_transcript(args: z.infer<typeof ReadTranscriptSchema>) {
      try {
        const transcript = await providers
          .get(args.provider)
          .readTranscript(args.session_id, args.limit);
        return textResult(transcript);
      } catch (err) {
        return errorResult(err);
      }
    },

    async send_message(args: z.infer<typeof SendMessageSchema>) {
      try {
        const result = await providers
          .get(args.provider)
          .sendMessage(args.session_id, args.text, { originBotId: args.origin_bot_id });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async interrupt(args: z.infer<typeof InterruptSchema>) {
      try {
        const result = await providers.get(args.provider).interrupt(args.session_id);
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async create_session(args: z.infer<typeof CreateSessionSchema>) {
      try {
        const provider = providers.get(args.provider);
        if (!provider.createSession) {
          return errorResult(`create_session not supported for ${args.provider}`);
        }
        const result = await provider.createSession({
          cwd: args.cwd,
          prompt: args.prompt,
          name: args.name,
          tags: args.tags,
          model: args.model,
        });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async set_session_meta(args: z.infer<typeof SetSessionMetaSchema>) {
      try {
        const provider = providers.get(args.provider);
        if (!provider.setSessionMeta) {
          return errorResult(`set_session_meta not supported for ${args.provider}`);
        }
        const result = await provider.setSessionMeta(args.session_id, {
          name: args.name,
          tags: args.tags,
        });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async get_session(args: z.infer<typeof GetSessionSchema>) {
      try {
        const provider = providers.get(args.provider);
        if (!provider.getSession) {
          return errorResult(`get_session not supported for ${args.provider}`);
        }
        const result = await provider.getSession(args.session_id);
        if (!result) {
          return errorResult(`Session not found: ${args.session_id}`);
        }
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async wait_turn(args: z.infer<typeof WaitTurnSchema>) {
      try {
        const provider = providers.get(args.provider);
        if (!provider.waitTurn) {
          return errorResult(`wait_turn not supported for ${args.provider}`);
        }
        const result = await provider.waitTurn(args.session_id, {
          timeoutMs: args.timeout_ms,
          pollIntervalMs: args.poll_interval_ms,
        });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async steer(args: z.infer<typeof SteerSchema>) {
      try {
        const provider = providers.get(args.provider);
        if (!provider.steer) {
          return errorResult(`steer not supported for ${args.provider}`);
        }
        const result = await provider.steer(args.session_id, args.text, { originBotId: args.origin_bot_id });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async list_approvals(args: z.infer<typeof ListApprovalsSchema>) {
      try {
        const provider = providers.get(args.provider);
        if (!provider.listApprovals) {
          return errorResult(`list_approvals not supported for ${args.provider}`);
        }
        const result = await provider.listApprovals(args.session_id);
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async resolve_approval(args: z.infer<typeof ResolveApprovalSchema>) {
      try {
        const provider = providers.get(args.provider);
        if (!provider.resolveApproval) {
          return errorResult(`resolve_approval not supported for ${args.provider}`);
        }
        const result = await provider.resolveApproval(
          args.session_id,
          args.approval_id,
          args.decision,
        );
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async export_transcript(args: z.infer<typeof ExportTranscriptSchema>) {
      try {
        const limit = args.limit ?? 100;
        const transcript = await providers
          .get(args.provider)
          .readTranscript(args.session_id, limit);

        const content =
          args.format === 'markdown'
            ? formatTranscriptAsMarkdown(transcript)
            : formatTranscriptAsJson(transcript);

        const exportDir = join(homedir(), '.wingman', 'exports');
        mkdirSync(exportDir, { recursive: true, mode: 0o700 });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const ext = args.format === 'markdown' ? 'md' : 'json';
        const filename = `${args.provider}_${args.session_id}_${timestamp}.${ext}`;
        const filePath = join(exportDir, filename);

        writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });

        return textResult({
          sessionId: args.session_id,
          provider: args.provider,
          format: args.format,
          itemCount: transcript.items.length,
          path: filePath,
          content,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}

function formatTranscriptAsMarkdown(transcript: Transcript): string {
  const lines: string[] = [
    `# Session Transcript`,
    '',
    `- **Session ID**: ${transcript.sessionId}`,
    `- **Provider**: ${transcript.provider}`,
    `- **Exported**: ${new Date().toISOString()}`,
    `- **Messages**: ${transcript.items.length}`,
    '',
    '---',
    '',
  ];

  for (const item of transcript.items) {
    const roleLabel = formatRole(item.role);
    lines.push(`### ${roleLabel}`);
    if (item.turnId) {
      lines.push(`_Turn: ${item.turnId}_`);
    }
    lines.push('');
    lines.push(item.text);
    lines.push('');
  }

  return lines.join('\n');
}

function formatTranscriptAsJson(transcript: Transcript): string {
  return JSON.stringify(
    {
      sessionId: transcript.sessionId,
      provider: transcript.provider,
      exportedAt: new Date().toISOString(),
      itemCount: transcript.items.length,
      items: transcript.items,
    },
    null,
    2,
  );
}

function formatRole(role: TranscriptItem['role']): string {
  switch (role) {
    case 'user':
      return 'User';
    case 'assistant':
      return 'Assistant';
    case 'system':
      return 'System';
    case 'tool':
      return 'Tool';
    default:
      return 'Unknown';
  }
}

export type ToolHandlers = ReturnType<typeof createToolHandlers>;

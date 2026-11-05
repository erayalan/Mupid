import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { AUTOMATIC_MEDIATION_TEXT, BACKGROUND_MATCHMAKING_TEXT, HUMAN_CONFIRMED_DESCRIPTION, REQUEST_ID_DESCRIPTION, START_TEXT, TOKEN_ARG_DESCRIPTION } from './playbook.js';
import { canonicalJson, type ParticipantRow } from '../db/store.js';
import { MupitError } from '../domain/errors.js';
import { authenticate, getSelf, registerParticipant, setActive, updateIntroduction } from '../domain/profiles.js';
import { discoverCandidates } from '../domain/discovery.js';
import { pollEvents } from '../domain/events.js';
import {
  blockParticipant, closeConversation, listConversations, openConversation, readConversation, sendMessage, setAssessment,
} from '../domain/conversations.js';
import { getConnectionContact, proposeConnection, respondConnection, submitContact, type ApprovalProvenance } from '../domain/connections.js';
import { withIdempotency } from '../domain/idempotency.js';
import { createProvider } from '../facilitator/provider.js';
import { facilitate } from '../facilitator/runner.js';
import { FACILITATOR_PROMPT_VERSION } from '../facilitator/prompt.js';
import {
  ASSESSMENTS, CHANNELS, IntroductionSchema, MESSAGE_KINDS, PreferencesSchema,
} from '../domain/schemas.js';
import { sha256Hex } from '../security/tokens.js';
import { logError, redact } from '../security/redaction.js';

export const SERVER_VERSION = '0.1.0';
export const SERVER_NAME = 'mupit';

const TokenField = z.string().min(16).max(256).describe(TOKEN_ARG_DESCRIPTION);
const RequestIdField = z.string().min(8).max(128).describe(REQUEST_ID_DESCRIPTION);
const HumanConfirmedField = z.boolean().describe(HUMAN_CONFIRMED_DESCRIPTION);

function ok(result: unknown): CallToolResult {
  const body = { ok: true, ...(result as Record<string, unknown>) };
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body as Record<string, unknown>,
  };
}

function fail(tool: string, err: unknown, logFields: Record<string, unknown> = {}): CallToolResult {
  if (err instanceof MupitError) {
    logError(`tool.${tool}`, err, logFields);
    const body = { ok: false, code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}), retryable: err.retryable };
    return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: true };
  }
  if (err && typeof err === 'object' && 'issues' in err) {
    // zod validation error (should be rare: SDK validates inputs first)
    logError(`tool.${tool}`, err, logFields);
    const body = { ok: false, code: 'VALIDATION_ERROR', message: 'Invalid arguments.', details: { issues: (err as { issues: unknown }).issues }, retryable: false };
    return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: true };
  }
  logError(`tool.${tool}`, err, logFields);
  const body = { ok: false, code: 'INTERNAL_ERROR', message: 'Internal error. Retry with a fresh request_id; report if it persists.', retryable: true };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: true };
}

function provenanceFor(ctx: AppContext, caller: ParticipantRow, demoFlag: boolean | undefined): ApprovalProvenance {
  if (demoFlag === true) {
    if (!ctx.cfg.demoMode || caller.is_simulated !== 1) {
      throw new MupitError('FORBIDDEN', 'demo_simulated_consent is accepted only for fixture-owned (simulated) identities in explicit demo mode (MUPIT_DEMO_MODE=1).');
    }
    return 'simulated_fixture';
  }
  return 'human_reported_by_personal_agent';
}

function clampLimit(ctx: AppContext, v: number | undefined): number {
  const raw = v ?? ctx.cfg.defaultPageLimit;
  return Math.max(1, Math.min(ctx.cfg.maxPageLimit, Math.floor(raw)));
}

export function createMcpServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
  const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
  const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

  /** Authenticate + rate-limit + run a mutation exactly once per request_id. */
  function mutate<T extends Record<string, unknown>>(
    op: string,
    token: string,
    requestId: string,
    payload: unknown,
    fn: (caller: ParticipantRow) => T,
  ): T & { idempotent_replay: boolean } {
    const caller = authenticate(ctx.db, token);
    ctx.writes.check(caller.token_hash);
    return ctx.store.transaction(() => withIdempotency(ctx.store, caller.id, op, requestId, payload, () => fn(caller)));
  }

  function authed(token: string): ParticipantRow {
    return authenticate(ctx.db, token);
  }

  // -- public -----------------------------------------------------------------
  server.registerTool('mupit_start', {
    description: 'Start here when the human wants to find love with Mupid/Mupit or join: read the conversational interview, privacy, approval, real search, return-check, and contact-exchange playbook. Public; no registration happens here.',
    annotations: readOnly,
  }, async () => ok({
    guidance: START_TEXT + (ctx.cfg.demoMode && ctx.cfg.backgroundDemo ? BACKGROUND_MATCHMAKING_TEXT : '') + (ctx.cfg.automaticMediation !== false ? AUTOMATIC_MEDIATION_TEXT : ''),
    guidance_revision: '2026-10-30-automatic-mediation-v1',
    automatic_mediation: ctx.cfg.automaticMediation !== false,
    background_matching_enabled: ctx.cfg.demoMode && ctx.cfg.backgroundDemo === true,
    demo_mode: ctx.cfg.demoMode,
    background_demo: ctx.cfg.demoMode && ctx.cfg.backgroundDemo === true,
    server: SERVER_NAME,
    server_version: SERVER_VERSION,
    facilitator_prompt_version: FACILITATOR_PROMPT_VERSION,
    facilitator_mode: ctx.cfg.facilitatorMode,
    privacy: 'Approved shared introductions and pair conversations are processed by a Meta-hosted model (Meta Model API). Not fully offline. Tokens, keys, and contact values never leave the local server except the allowlisted pair context sent for inference.',
  }));

  // -- identity ---------------------------------------------------------------
  server.registerTool('mupit_register', {
    description: 'Register a human-approved pseudonymous introduction. Requires 18+ self-attestation + publication confirmation. Returns participant ID and a SECRET token (shown once). Idempotent via registration_key.',
    inputSchema: {
      registration_key: z.string().min(16).max(256).describe('Fresh high-entropy client-generated key (SECRET, never logged). Retrying with the same key + identical content returns the same identity instead of duplicating.'),
      introduction: IntroductionSchema.describe('Approved introduction: age 18+, about_me/looking_for (<=1500 chars each, no identifiers), relationship_intent, region, open_to_long_distance, interests/values/lifestyle/dealbreakers.'),
      preferences: PreferencesSchema.describe('Structured hard filters: age_min/max (>=18), optional gender + accepted_genders, accepted_intents, same_region_only.'),
      adult_attested: z.boolean().describe('REQUIRED true: human self-attests age 18+. Self-attestation, not verified age.'),
      publication_confirmed: z.boolean().describe('REQUIRED true: human approved the EXACT introduction above for sharing with registered participants.'),
      simulated: z.boolean().optional().describe('Demo provisioning only: mark as simulated. Honored ONLY when the server runs in explicit demo mode; ordinary clients cannot set it.'),
    },
    annotations: mutation,
  }, async (args) => {
    try {
      return ok(registerParticipant(ctx.db, ctx.cfg, {
        registration_key: args.registration_key,
        introduction: args.introduction,
        preferences: args.preferences,
        adult_attested: args.adult_attested,
        publication_confirmed: args.publication_confirmed,
        simulated: args.simulated,
      }));
    } catch (err) { return fail('mupit_register', err, {}); }
  });

  server.registerTool('mupit_get_self', {
    description: 'Return your own introduction, preferences, version, and status. No token is ever returned.',
    inputSchema: { participant_token: TokenField },
    annotations: readOnly,
  }, async (args) => {
    try {
      const caller = authed(args.participant_token);
      return ok(getSelf(ctx.db, caller.id));
    } catch (err) { return fail('mupit_get_self', err, {}); }
  });

  server.registerTool('mupit_update_introduction', {
    description: 'Replace your introduction/preferences with human-approved content (optimistic concurrency via expected_version). May invalidate pending connection progression.',
    inputSchema: {
      participant_token: TokenField,
      request_id: RequestIdField,
      expected_version: z.number().int().min(1).describe('Current introduction_version from mupit_get_self/read; stale values fail with VERSION_CONFLICT.'),
      introduction: IntroductionSchema.describe('Approved replacement introduction (same rules as registration).'),
      preferences: PreferencesSchema.describe('Approved replacement preferences.'),
      publication_confirmed: z.boolean().describe('REQUIRED true: human approved the EXACT replacement for sharing.'),
    },
    annotations: mutation,
  }, async (args) => {
    try {
      return ok(mutate('mupit_update_introduction', args.participant_token, args.request_id, args, (caller) =>
        updateIntroduction(ctx.db, caller.id, {
          expected_version: args.expected_version, introduction: args.introduction,
          preferences: args.preferences, publication_confirmed: args.publication_confirmed,
        })));
    } catch (err) { return fail('mupit_update_introduction', err, {}); }
  });

  server.registerTool('mupit_set_active', {
    description: 'Pause (hide from discovery, block new initiations) or resume. Existing threads stay readable/closable; existing approvals are NOT revoked.',
    inputSchema: {
      participant_token: TokenField,
      request_id: RequestIdField,
      active: z.boolean().describe('false = pause discovery; true = resume.'),
    },
    annotations: mutation,
  }, async (args) => {
    try {
      return ok(mutate('mupit_set_active', args.participant_token, args.request_id, args, (caller) => setActive(ctx.db, caller.id, args.active)));
    } catch (err) { return fail('mupit_set_active', err, {}); }
  });

  // -- discovery & inbox -------------------------------------------------------
  server.registerTool('mupit_discover', {
    description: 'Find NEW reciprocal candidates by age, gender, intent, and region. EXCLUDES all pairs with existing conversations: always poll/list/read current conversations first when checking matches. Free-text dealbreakers need introduction/conversation evidence. Stable order, paginated; missing explicit requirements appear under needs_clarification.',
    inputSchema: {
      participant_token: TokenField,
      cursor: z.string().max(128).optional().describe('next_cursor from the previous page; omit to start.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max eligible candidates to return (default 20).'),
    },
    annotations: readOnly,
  }, async (args) => {
    try {
      const caller = authed(args.participant_token);
      return ok(discoverCandidates(ctx.db, caller.id, args.cursor, clampLimit(ctx, args.limit)));
    } catch (err) { return fail('mupit_discover', err, {}); }
  });

  server.registerTool('mupit_poll', {
    description: 'Non-destructive ordered inbox of messages + state-change events (no contact values). Keep the cursor privately; fetching never consumes. If the cursor is lost, mupit_list_conversations reconstructs pending work.',
    inputSchema: {
      participant_token: TokenField,
      cursor: z.string().max(32).optional().describe('next_cursor from the previous poll; omit/"0" to start.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max events (default 20).'),
    },
    annotations: readOnly,
  }, async (args) => {
    try {
      const caller = authed(args.participant_token);
      return ok(pollEvents(ctx.db, caller.id, args.cursor, clampLimit(ctx, args.limit)));
    } catch (err) { return fail('mupit_poll', err, {}); }
  });

  server.registerTool('mupit_list_conversations', {
    description: 'List current pair conversations with safe summaries, pending-action hints, and proposal state. ALWAYS use on a match check, even if the inbox is empty; read current threads before summarizing. Discovery excludes these pairs, so it cannot replace this call.',
    inputSchema: {
      participant_token: TokenField,
      status: z.enum(['active', 'closed', 'released']).optional().describe('Filter by lifecycle status.'),
      cursor: z.string().max(128).optional().describe('next_cursor from the previous page; omit to start.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max conversations (default 20).'),
    },
    annotations: readOnly,
  }, async (args) => {
    try {
      const caller = authed(args.participant_token);
      return ok(listConversations(ctx.db, caller.id, args.status, args.cursor, clampLimit(ctx, args.limit)));
    } catch (err) { return fail('mupit_list_conversations', err, {}); }
  });

  // -- conversations ------------------------------------------------------------
  server.registerTool('mupit_open_conversation', {
    description: 'Open an agent-to-agent thread through Mupit and post an opening message. The server automatically queues AI mediation when enabled. Rechecks eligibility/blocks; existing active pairs reuse their thread. This never messages the human directly.',
    inputSchema: {
      participant_token: TokenField,
      request_id: RequestIdField,
      target_participant_id: z.string().min(1).max(64).describe('Opaque participant ID from discovery.'),
      kind: z.enum(MESSAGE_KINDS).describe('Message kind: question | answer | assessment | needs_user_input.'),
      body: z.string().min(1).max(4000).describe('Opening message (no contact details; channel names by discussion only).'),
    },
    annotations: mutation,
  }, async (args) => {
    try {
      return ok(mutate('mupit_open_conversation', args.participant_token, args.request_id, args, (caller) =>
        openConversation(ctx.db, ctx.cfg, caller.id, { target_participant_id: args.target_participant_id, kind: args.kind, body: args.body })));
    } catch (err) { return fail('mupit_open_conversation', err, {}); }
  });

  server.registerTool('mupit_read_conversation', {
    description: 'Read an authorized thread: messages, both assessments, safe proposal state (booleans only), and both current public introductions/versions.',
    inputSchema: {
      participant_token: TokenField,
      conversation_id: z.string().min(1).max(64),
      after_seq: z.number().int().min(0).optional().describe('Return messages with seq greater than this (default 0).'),
      limit: z.number().int().min(1).max(100).optional().describe('Max messages (default 50).'),
    },
    annotations: readOnly,
  }, async (args) => {
    try {
      const caller = authed(args.participant_token);
      return ok(readConversation(ctx.db, caller.id, args.conversation_id, args.after_seq ?? 0, Math.min(args.limit ?? 50, 100)));
    } catch (err) { return fail('mupit_read_conversation', err, {}); }
  });

  server.registerTool('mupit_send_message', {
    description: 'Send to the other personal agent through the server-side Mupit conversation. Automatically queues AI mediation when enabled; no separate facilitate call is needed. Never messages the human directly. Authorship derives from your token. Rejected after close/release.',
    inputSchema: {
      participant_token: TokenField,
      request_id: RequestIdField,
      conversation_id: z.string().min(1).max(64),
      kind: z.enum(MESSAGE_KINDS),
      body: z.string().min(1).max(4000).describe('Message text (no contact details). Unknown info stays unknown; ask your human when needed.'),
    },
    annotations: mutation,
  }, async (args) => {
    try {
      return ok(mutate('mupit_send_message', args.participant_token, args.request_id, args, (caller) =>
        sendMessage(ctx.db, ctx.cfg, caller.id, { conversation_id: args.conversation_id, kind: args.kind, body: args.body })));
    } catch (err) { return fail('mupit_send_message', err, {}); }
  });

  server.registerTool('mupit_facilitate', {
    description: 'Optional manual compatibility/recovery tool; normally the server schedules mediation automatically. Request at most ONE Meta-powered Mupit facilitator turn for new eligible context (question, clarification, or evidence-grounded recommendation). Reads/polls never trigger inference. At most one committed result per input revision; concurrent callers share it.',
    inputSchema: {
      participant_token: TokenField,
      request_id: RequestIdField,
      conversation_id: z.string().min(1).max(64),
      expected_revision: z.number().int().min(1).describe('Current conversation revision from read/list; stale values return retryable stale_context.'),
    },
    annotations: mutation,
  }, async (args) => {
    try {
      const caller = authed(args.participant_token);
      ctx.writes.check(caller.token_hash);
      // Two-phase idempotency: no DB write lock may span the network call.
      const payloadHash = sha256Hex(canonicalJson({ ...args, participant_token: undefined }));
      const existing = ctx.store.getIdempotent(caller.id, 'mupit_facilitate', args.request_id);
      if (existing) {
        if (existing.payload_hash !== payloadHash) {
          throw new MupitError('REQUEST_ID_REUSED', `request_id "${args.request_id}" was already used with different arguments.`, undefined, false);
        }
        return ok({ ...(JSON.parse(existing.result_json) as Record<string, unknown>), idempotent_replay: true });
      }
      const provider = createProvider(ctx.cfg); // throws SETUP_ERROR without a key — never silent mock
      const result = await facilitate(ctx.db, ctx.cfg, provider, caller.id, args.conversation_id, args.expected_revision);
      if (result.status === 'complete' || result.status === 'waiting_for_agent' || result.status === 'waiting_for_human') {
        ctx.store.putIdempotent(caller.id, 'mupit_facilitate', args.request_id, payloadHash, JSON.stringify(redact(result)));
      }
      return ok({ ...result, idempotent_replay: false });
    } catch (err) { return fail('mupit_facilitate', err, {}); }
  });

  server.registerTool('mupit_set_assessment', {
    description: 'Record YOUR agent opinion of the thread (exploring | promising | not_a_fit | needs_user_input). Explicitly NOT human consent; never authorizes contact release.',
    inputSchema: {
      participant_token: TokenField,
      request_id: RequestIdField,
      conversation_id: z.string().min(1).max(64),
      assessment: z.enum(ASSESSMENTS),
      rationale: z.string().min(1).max(500).describe('Concise evidence-grounded rationale.'),
    },
    annotations: mutation,
  }, async (args) => {
    try {
      return ok(mutate('mupit_set_assessment', args.participant_token, args.request_id, args, (caller) =>
        setAssessment(ctx.db, caller.id, args.conversation_id, args.assessment, args.rationale)));
    } catch (err) { return fail('mupit_set_assessment', err, {}); }
  });

  // -- contact exchange ----------------------------------------------------------
  const simulatedConsentField = z.boolean().optional().describe('Demo fixtures ONLY: true records simulated_fixture provenance. Accepted only for simulated identities in explicit demo mode; forbidden otherwise.');

  server.registerTool('mupit_propose_connection', {
    description: 'Propose (or counter-propose) a contact channel. Approves the CHANNEL for your human (not any value). A new channel creates a new version and invalidates prior approvals + pending submissions.',
    inputSchema: {
      participant_token: TokenField,
      request_id: RequestIdField,
      conversation_id: z.string().min(1).max(64),
      expected_version: z.number().int().min(0).describe('Current proposal version (0 when none exists); stale values fail.'),
      channel: z.enum(CHANNELS).describe('email | instagram | phone. Must be the same for both parties.'),
      human_confirmed: HumanConfirmedField,
      demo_simulated_consent: simulatedConsentField,
    },
    annotations: mutation,
  }, async (args) => {
    try {
      return ok(mutate('mupit_propose_connection', args.participant_token, args.request_id, args, (caller) =>
        proposeConnection(ctx.db, caller.id, args.conversation_id, args.expected_version, args.channel, args.human_confirmed, provenanceFor(ctx, caller, args.demo_simulated_consent))));
    } catch (err) { return fail('mupit_propose_connection', err, {}); }
  });

  server.registerTool('mupit_respond_connection', {
    description: 'Accept / decline / revoke a proposal version with explicit human approval. Decline closes the introduction; revoke clears your approval + pending submissions.',
    inputSchema: {
      participant_token: TokenField,
      request_id: RequestIdField,
      conversation_id: z.string().min(1).max(64),
      proposal_version: z.number().int().min(1).describe('Exact version being decided; stale values fail.'),
      decision: z.enum(['accept', 'decline', 'revoke']),
      human_confirmed: HumanConfirmedField,
      demo_simulated_consent: simulatedConsentField,
    },
    annotations: mutation,
  }, async (args) => {
    try {
      return ok(mutate('mupit_respond_connection', args.participant_token, args.request_id, args, (caller) =>
        respondConnection(ctx.db, caller.id, args.conversation_id, args.proposal_version, args.decision, args.human_confirmed, provenanceFor(ctx, caller, args.demo_simulated_consent))));
    } catch (err) { return fail('mupit_respond_connection', err, {}); }
  });

  server.registerTool('mupit_submit_contact', {
    description: 'Privately store your human\'s EXACT channel contact for THIS match version (encrypted vault; hidden from counterpart). Release happens atomically only when both sides approve + submit the current version. Never echoes the value.',
    inputSchema: {
      participant_token: TokenField,
      request_id: RequestIdField,
      conversation_id: z.string().min(1).max(64),
      proposal_version: z.number().int().min(1).describe('Exact current proposal version; stale values fail.'),
      channel: z.enum(CHANNELS).describe('Must match the proposal channel.'),
      contact_value: z.string().min(1).max(320).describe('SECRET exact contact value (email/handle/phone). Stored encrypted; never returned except to the counterpart after mutual release.'),
      human_confirmed: z.boolean().describe('REQUIRED true: human approved releasing THIS value to THIS participant if both submit.'),
      demo_simulated_consent: simulatedConsentField,
    },
    annotations: mutation,
  }, async (args) => {
    try {
      return ok(mutate('mupit_submit_contact', args.participant_token, args.request_id, { ...args, contact_value: undefined }, (caller) =>
        submitContact(ctx.db, ctx.vault, caller.id, args.conversation_id, args.proposal_version, args.channel, args.contact_value, args.human_confirmed, provenanceFor(ctx, caller, args.demo_simulated_consent))));
    } catch (err) { return fail('mupit_submit_contact', err, {}); }
  });

  server.registerTool('mupit_get_connection_contact', {
    description: 'THE ONLY counterpart contact-read path. Returns the other participant\'s approved value ONLY after atomic mutual release of the given version. Blocked pairs are refused.',
    inputSchema: {
      participant_token: TokenField,
      conversation_id: z.string().min(1).max(64),
      proposal_version: z.number().int().min(1),
    },
    annotations: readOnly,
  }, async (args) => {
    try {
      const caller = authed(args.participant_token);
      return ok(getConnectionContact(ctx.db, ctx.vault, caller.id, args.conversation_id, args.proposal_version));
    } catch (err) { return fail('mupit_get_connection_contact', err, {}); }
  });

  // -- lifecycle ------------------------------------------------------------------
  server.registerTool('mupit_close_conversation', {
    description: 'Close the thread (no explanation required) and purge pending unreleased contacts. Final: pairs cannot be reopened.',
    inputSchema: {
      participant_token: TokenField,
      request_id: RequestIdField,
      conversation_id: z.string().min(1).max(64),
    },
    annotations: destructive,
  }, async (args) => {
    try {
      return ok(mutate('mupit_close_conversation', args.participant_token, args.request_id, args, (caller) =>
        closeConversation(ctx.db, caller.id, args.conversation_id)));
    } catch (err) { return fail('mupit_close_conversation', err, {}); }
  });

  server.registerTool('mupit_block_participant', {
    description: 'Block a participant: prevents discovery, messages, proposals, and FUTURE contact reads between the pair; closes the active pair. Already-disclosed information cannot be recalled.',
    inputSchema: {
      participant_token: TokenField,
      request_id: RequestIdField,
      participant_id: z.string().min(1).max(64).describe('Opaque participant ID to block.'),
    },
    annotations: destructive,
  }, async (args) => {
    try {
      return ok(mutate('mupit_block_participant', args.participant_token, args.request_id, args, (caller) =>
        blockParticipant(ctx.db, caller.id, args.participant_id)));
    } catch (err) { return fail('mupit_block_participant', err, {}); }
  });

  return server;
}

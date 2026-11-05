import type { MupitConfig } from '../config.js';
import { MupitError } from '../domain/errors.js';
import { FACILITATOR_JSON_SCHEMA } from './schema.js';

export interface ProviderCallOptions {
  timeoutMs: number;
  maxOutputTokens: number;
}

export interface ProviderCallResult {
  outputJson: unknown;
  modelId: string;
  latencyMs: number;
  usage: Record<string, unknown> | null;
}

export interface FacilitatorProvider {
  readonly modelId: string;
  readonly label: string; // "live-meta" | "mock" — surfaced in run metadata, never hidden
  complete(systemPrompt: string, userContent: string, opts: ProviderCallOptions): Promise<ProviderCallResult>;
}

/**
 * Meta Model API provider (verified 2026-10-28 against https://dev.meta.ai/docs):
 * OpenAI-compatible Chat Completions at POST {base}/chat/completions,
 * Authorization: Bearer key, response_format json_schema for structured output.
 */
export class MetaProvider implements FacilitatorProvider {
  readonly label = 'live-meta';
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(cfg: MupitConfig) {
    if (!cfg.metaApiKey) {
      throw new MupitError(
        'SETUP_ERROR',
        'Live facilitator requires META_API_KEY (or MODEL_API_KEY). Get a key from the Meta developer platform, set it, and retry. Mock mode is available only with explicit MUPIT_FACILITATOR_MODE=mock.',
      );
    }
    this.apiKey = cfg.metaApiKey;
    this.modelId = cfg.metaModel;
    this.baseUrl = cfg.metaBaseUrl;
  }

  async complete(systemPrompt: string, userContent: string, opts: ProviderCallOptions): Promise<ProviderCallResult> {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.modelId,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'MupitFacilitatorTurn', schema: FACILITATOR_JSON_SCHEMA } },
          temperature: 0.2,
          max_tokens: opts.maxOutputTokens,
        }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new MupitError(
        'PROVIDER_UNAVAILABLE',
        timedOut ? `Meta API request timed out after ${opts.timeoutMs}ms.` : `Meta API request failed: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        true,
      );
    }
    const latencyMs = Date.now() - started;
    const text = await res.text();
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      // Never include key material; truncate provider body (it echoes no secrets by construction).
      throw new MupitError(
        'PROVIDER_UNAVAILABLE',
        `Meta API returned HTTP ${res.status}: ${text.slice(0, 300)}`,
        { http_status: res.status },
        retryable,
      );
    }
    let parsed: { choices?: Array<{ finish_reason?: string; message?: { content?: string } }>; usage?: Record<string, unknown> };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new MupitError('PROVIDER_ERROR', 'Meta API returned malformed JSON.', undefined, true);
    }
    const content = parsed.choices?.[0]?.message?.content;
    if (!content) {
      const exhausted = parsed.choices?.[0]?.finish_reason === 'length';
      throw new MupitError(
        'PROVIDER_ERROR',
        exhausted
          ? `Meta API exhausted its ${opts.maxOutputTokens}-token completion budget before producing an answer. Increase the budget to allow for reasoning.`
          : 'Meta API returned no message content.',
        { finish_reason: parsed.choices?.[0]?.finish_reason, max_tokens: opts.maxOutputTokens },
        !exhausted,
      );
    }
    let outputJson: unknown;
    try {
      outputJson = JSON.parse(content);
    } catch {
      throw new MupitError('PROVIDER_ERROR', 'Meta API output was not valid JSON against the requested schema.', undefined, true);
    }
    return { outputJson, modelId: this.modelId, latencyMs, usage: parsed.usage ?? null };
  }
}

/**
 * Deterministic mock for offline tests / explicitly labeled mock demos.
 * Construed from the same context shape; output passes the same validation
 * (it cites real message IDs supplied in context).
 */
export class MockProvider implements FacilitatorProvider {
  readonly label = 'mock';
  readonly modelId = 'mock-facilitator-v1';

  async complete(_systemPrompt: string, userContent: string, _opts: ProviderCallOptions): Promise<ProviderCallResult> {
    const started = Date.now();
    const jsonStart = userContent.indexOf('{');
    const ctx = JSON.parse(jsonStart >= 0 ? userContent.slice(jsonStart) : userContent) as {
      pair: { a_id: string; b_id: string };
      messages: Array<{ id: string; sender_role: string }>;
      previous_facilitator_action: string | null;
    };
    const agentMsgs = ctx.messages.filter((m) => m.sender_role === 'personal_agent');
    const hadTurn = ctx.previous_facilitator_action !== null;
    const firstEvidence = agentMsgs[0]?.id ?? `intro:${ctx.pair.a_id}:about_me`;
    const outputJson = !hadTurn
      ? {
          action: 'ask_agents',
          addressed_participant_ids: [ctx.pair.a_id, ctx.pair.b_id],
          message:
            `Agent for participant ${ctx.pair.a_id} and agent for participant ${ctx.pair.b_id}: ` +
            `your introductions passed reciprocal filters, but daily-life compatibility is still unknown. ` +
            `Please ask your person how much time together vs. independent time they want in a typical week, and share only what they approve.`,
          reasons: ['Reciprocal hard filters passed for this pair.'],
          tensions: [],
          unknowns: ['Desired time-together balance is unstated for both participants.'],
          evidence_refs: [firstEvidence],
          awaiting_participant_ids: [ctx.pair.a_id, ctx.pair.b_id],
        }
      : {
          action: 'recommend_introduction',
          addressed_participant_ids: [ctx.pair.a_id, ctx.pair.b_id],
          message:
            `Agent for participant ${ctx.pair.a_id} and agent for participant ${ctx.pair.b_id}: ` +
            `MOCK assessment — the pair exchanged substantive answers. Review the thread and decide independently whether to propose contact exchange.`,
          reasons: ['Both agents provided substantive answers in the shared thread.'],
          tensions: [],
          unknowns: ['Mock mode performs no real compatibility reasoning.'],
          evidence_refs: agentMsgs.slice(-2).map((m) => m.id),
          awaiting_participant_ids: [],
        };
    return { outputJson, modelId: this.modelId, latencyMs: Date.now() - started, usage: { mock: true } };
  }
}

export function createProvider(cfg: MupitConfig): FacilitatorProvider {
  if (cfg.facilitatorMode === 'mock') return new MockProvider();
  return new MetaProvider(cfg); // throws SETUP_ERROR when the key is missing — never silent mock
}

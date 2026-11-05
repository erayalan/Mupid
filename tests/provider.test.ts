import { describe, expect, it, vi } from 'vitest';
import { MetaProvider } from '../src/facilitator/provider.js';
import { testConfig } from './helpers.js';

describe('live provider response handling', () => {
  it('reports reasoning budget exhaustion as actionable rather than an empty transient reply', async () => {
    const probe = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: '' } }],
      usage: { completion_tokens: 1200, completion_tokens_details: { reasoning_tokens: 1198 } },
    }), { status: 200 }));
    try {
      const provider = new MetaProvider(testConfig('unused', { metaApiKey: 'test-only' }));
      await expect(provider.complete('system', 'approved pair context', { timeoutMs: 5000, maxOutputTokens: 1200 }))
        .rejects.toMatchObject({
          code: 'PROVIDER_ERROR', retryable: false,
          message: expect.stringContaining('completion budget'),
          details: { finish_reason: 'length', max_tokens: 1200 },
        });
    } finally {
      probe.mockRestore();
    }
  });
});

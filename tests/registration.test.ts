import { describe, expect, it } from 'vitest';
import { INTRO_A, PREFS_A, TClient, makeTestContext, regKey, registerUser, req } from './helpers.js';

describe('registration (acceptance #2, #3)', () => {
  it('rejects under-18, missing attestation, and missing publication confirmation', async () => {
    const ctx = makeTestContext();
    try {
      const c = await TClient.connect(ctx, 't');
      try {
        // Schema-shape violations (age < 18) are rejected at the MCP input-validation
        // layer as protocol InvalidParams; semantic violations return envelopes.
        await expect(c.call('mupit_register', {
          registration_key: regKey('u18'), introduction: { ...INTRO_A, age: 17 }, preferences: PREFS_A,
          adult_attested: true, publication_confirmed: true,
        })).rejects.toThrow(/MCP error -32602/);
        await c.fails('mupit_register', {
          registration_key: regKey('noatt'), introduction: INTRO_A, preferences: PREFS_A,
          adult_attested: false, publication_confirmed: true,
        }, 'VALIDATION_ERROR');
        await c.fails('mupit_register', {
          registration_key: regKey('nopub'), introduction: INTRO_A, preferences: PREFS_A,
          adult_attested: true, publication_confirmed: false,
        }, 'VALIDATION_ERROR');
        const n = (ctx.db.prepare('SELECT COUNT(*) AS n FROM participants').get() as { n: number }).n;
        expect(n).toBe(0);
      } finally {
        await c.close();
      }
    } finally {
      ctx.close();
    }
  });

  it('registration retry returns the same identity/token; conflicting reuse fails', async () => {
    const ctx = makeTestContext();
    try {
      const c = await TClient.connect(ctx, 't');
      try {
        const key = regKey('retry');
        const first = await c.call('mupit_register', {
          registration_key: key, introduction: INTRO_A, preferences: PREFS_A,
          adult_attested: true, publication_confirmed: true,
        });
        expect(first.returning_registration).toBe(false);
        const second = await c.call('mupit_register', {
          registration_key: key, introduction: INTRO_A, preferences: PREFS_A,
          adult_attested: true, publication_confirmed: true,
        });
        expect(second.returning_registration).toBe(true);
        expect(second.participant_id).toBe(first.participant_id);
        expect(second.participant_token).toBe(first.participant_token);
        await c.fails('mupit_register', {
          registration_key: key, introduction: { ...INTRO_A, age: 31 }, preferences: PREFS_A,
          adult_attested: true, publication_confirmed: true,
        }, 'VERSION_CONFLICT');
        const n = (ctx.db.prepare('SELECT COUNT(*) AS n FROM participants').get() as { n: number }).n;
        expect(n).toBe(1);
      } finally {
        await c.close();
      }
    } finally {
      ctx.close();
    }
  });

  it('mutation retry with the same request_id replays; reuse with different args fails', async () => {
    const ctx = makeTestContext();
    try {
      const c = await TClient.connect(ctx, 't');
      try {
        const u = await registerUser(c, 'a');
        const rid = req();
        const args = { participant_token: u.token, request_id: rid, active: false };
        const first = await c.call('mupit_set_active', args);
        expect(first.idempotent_replay).toBe(false);
        const second = await c.call('mupit_set_active', args);
        expect(second.idempotent_replay).toBe(true);
        expect(second.is_active).toBe(false);
        await c.fails('mupit_set_active', { participant_token: u.token, request_id: rid, active: true }, 'REQUEST_ID_REUSED');
        const self = await c.call('mupit_get_self', { participant_token: u.token });
        expect(self.is_active).toBe(false);
      } finally {
        await c.close();
      }
    } finally {
      ctx.close();
    }
  });
});

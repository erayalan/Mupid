import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { INTRO_A, INTRO_B, PREFS_A, PREFS_B, TClient, makeTestContext, registerUser, req } from './helpers.js';
import { ContactVault } from '../src/security/contact-vault.js';

describe('contact vault (acceptance #18)', () => {
  it('wrong vault key fails safely; data intact once the right key returns', async () => {
    const ctx = makeTestContext();
    try {
      const a = await TClient.connect(ctx, 'a');
      const b = await TClient.connect(ctx, 'b');
      try {
        const A = await registerUser(a, 'a', INTRO_A, PREFS_A);
        const B = await registerUser(b, 'b', INTRO_B, PREFS_B);
        const opened = await a.call('mupit_open_conversation', {
          participant_token: A.token, request_id: req(), target_participant_id: B.id, kind: 'question', body: 'hi',
        });
        const conv = String(opened.conversation_id);
        await a.call('mupit_propose_connection', {
          participant_token: A.token, request_id: req(), conversation_id: conv, expected_version: 0, channel: 'email', human_confirmed: true,
        });
        await b.call('mupit_respond_connection', {
          participant_token: B.token, request_id: req(), conversation_id: conv, proposal_version: 1, decision: 'accept', human_confirmed: true,
        });
        await a.call('mupit_submit_contact', {
          participant_token: A.token, request_id: req(), conversation_id: conv, proposal_version: 1,
          channel: 'email', contact_value: 'a@example.com', human_confirmed: true,
        });
        await b.call('mupit_submit_contact', {
          participant_token: B.token, request_id: req(), conversation_id: conv, proposal_version: 1,
          channel: 'email', contact_value: 'b@example.com', human_confirmed: true,
        });

        const goodVault = ctx.app.vault;
        ctx.app.vault = new ContactVault(randomBytes(32), 'v1'); // simulate key rotation/loss
        await b.fails('mupit_get_connection_contact', { participant_token: B.token, conversation_id: conv, proposal_version: 1 }, 'INTERNAL_ERROR');
        // Sealed data still present (nothing erased or replaced).
        const n = (ctx.db.prepare('SELECT COUNT(*) AS n FROM contact_submissions').get() as { n: number }).n;
        expect(n).toBe(2);
        // Right key restores reads.
        ctx.app.vault = goodVault;
        const back = await b.call('mupit_get_connection_contact', { participant_token: B.token, conversation_id: conv, proposal_version: 1 });
        expect(back.contact_value).toBe('a@example.com');
      } finally {
        await a.close(); await b.close();
      }
    } finally {
      ctx.close();
    }
  });

  it('vault round-trips and rejects tampered payloads', () => {
    const vault = new ContactVault(randomBytes(32));
    const sealed = vault.seal('hello@example.com');
    expect(vault.open(sealed)).toBe('hello@example.com');
    expect(() => vault.open(sealed.slice(0, -2) + 'xx')).toThrow();
    expect(() => vault.open('v2.aaaa')).toThrow();
  });
});

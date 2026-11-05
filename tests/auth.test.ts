import { describe, expect, it } from 'vitest';
import { INTRO_A, INTRO_B, PREFS_A, PREFS_B, TClient, makeTestContext, registerUser, req } from './helpers.js';

describe('auth + isolation (acceptance #4, #17)', () => {
  it('invalid tokens fail; C cannot touch the A-B thread via guessed IDs/cursors', async () => {
    const ctx = makeTestContext();
    try {
      const a = await TClient.connect(ctx, 'a');
      const b = await TClient.connect(ctx, 'b');
      const c = await TClient.connect(ctx, 'c');
      try {
        const A = await registerUser(a, 'a', INTRO_A, PREFS_A);
        const B = await registerUser(b, 'b', INTRO_B, PREFS_B);
        const C = await registerUser(c, 'c', INTRO_A, PREFS_A);
        await a.fails('mupit_get_self', { participant_token: 'bogus-token-value-000' }, 'UNAUTHORIZED');

        const opened = await a.call('mupit_open_conversation', {
          participant_token: A.token, request_id: req(), target_participant_id: B.id, kind: 'question', body: 'Hello B',
        });
        const conv = String(opened.conversation_id);

        // Cross-participant reads/writes: leak-safe NOT_FOUND / UNAUTHORIZED.
        await c.fails('mupit_read_conversation', { participant_token: C.token, conversation_id: conv }, 'NOT_FOUND');
        await c.fails('mupit_send_message', {
          participant_token: C.token, request_id: req(), conversation_id: conv, kind: 'answer', body: 'I am C intruding',
        }, 'NOT_FOUND');
        await c.fails('mupit_facilitate', {
          participant_token: C.token, request_id: req(), conversation_id: conv, expected_revision: 1,
        }, 'NOT_FOUND');
        await c.fails('mupit_set_assessment', {
          participant_token: C.token, request_id: req(), conversation_id: conv, assessment: 'promising', rationale: 'x',
        }, 'NOT_FOUND');
        await c.fails('mupit_propose_connection', {
          participant_token: C.token, request_id: req(), conversation_id: conv, expected_version: 0, channel: 'email', human_confirmed: true,
        }, 'NOT_FOUND');
        await c.fails('mupit_get_connection_contact', { participant_token: C.token, conversation_id: conv, proposal_version: 1 }, 'NOT_FOUND');
        await c.fails('mupit_close_conversation', { participant_token: C.token, request_id: req(), conversation_id: conv }, 'NOT_FOUND');

        // C's own inbox must not contain A-B events.
        const poll = await c.call('mupit_poll', { participant_token: C.token });
        expect(poll.events).toEqual([]);
        const list = await c.call('mupit_list_conversations', { participant_token: C.token });
        expect(list.conversations).toEqual([]);

        // Guessing event cursors / message IDs yields nothing of A-B.
        const pollGuess = await c.call('mupit_poll', { participant_token: C.token, cursor: '0' });
        expect(pollGuess.events).toEqual([]);
      } finally {
        await a.close(); await b.close(); await c.close();
      }
    } finally {
      ctx.close();
    }
  });

  it('SQLite holds no plaintext tokens; contact values are sealed', async () => {
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
          channel: 'email', contact_value: 'alex.secret@example.com', human_confirmed: true,
        });

        const tables = ['participants', 'conversations', 'messages', 'connection_proposals', 'contact_submissions', 'events', 'idempotency', 'facilitator_runs'];
        const secretNeedles = [A.token, B.token, 'alex.secret@example.com', A.regKey, B.regKey];
        for (const t of tables) {
          const rows = ctx.db.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>;
          const blob = JSON.stringify(rows);
          for (const needle of secretNeedles) {
            expect(blob.includes(needle)).toBe(false);
          }
        }
        // Sealed value present but opaque.
        const sub = ctx.db.prepare('SELECT sealed_value FROM contact_submissions').get() as { sealed_value: string };
        expect(sub.sealed_value.startsWith('v1.')).toBe(true);
        expect(sub.sealed_value.includes('alex.secret')).toBe(false);
        // Idempotency record for submit_contact holds status only.
        const idem = ctx.db.prepare("SELECT result_json FROM idempotency WHERE operation = 'mupit_submit_contact'").get() as { result_json: string };
        expect(idem.result_json.includes('alex.secret')).toBe(false);
      } finally {
        await a.close(); await b.close();
      }
    } finally {
      ctx.close();
    }
  });
});

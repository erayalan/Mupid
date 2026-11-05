import { describe, expect, it } from 'vitest';
import { INTRO_A, INTRO_B, PREFS_A, PREFS_B, TClient, makeTestContext, registerUser, req, tempDbPath, cleanupDbPath } from './helpers.js';

describe('conversations (acceptance #6, #7)', () => {
  it('A->B and B->A initiation collapse to exactly one canonical conversation', async () => {
    const ctx = makeTestContext();
    try {
      const a = await TClient.connect(ctx, 'a');
      const b = await TClient.connect(ctx, 'b');
      try {
        const A = await registerUser(a, 'a', INTRO_A, PREFS_A);
        const B = await registerUser(b, 'b', INTRO_B, PREFS_B);
        const first = await a.call('mupit_open_conversation', {
          participant_token: A.token, request_id: req(), target_participant_id: B.id, kind: 'question', body: 'Hello from A',
        });
        const second = await b.call('mupit_open_conversation', {
          participant_token: B.token, request_id: req(), target_participant_id: A.id, kind: 'question', body: 'Hello from B',
        });
        expect(second.conversation_id).toBe(first.conversation_id);
        expect(second.created).toBe(false);
        const n = (ctx.db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n;
        expect(n).toBe(1);
        // Both agents see the same thread authorship.
        const read = await a.call('mupit_read_conversation', { participant_token: A.token, conversation_id: String(first.conversation_id) });
        const msgs = read.messages as Array<{ sender_role: string; sender_participant_id: string }>;
        expect(msgs).toHaveLength(2);
        expect(msgs[0]).toMatchObject({ sender_role: 'personal_agent', sender_participant_id: A.id });
        expect(msgs[1]).toMatchObject({ sender_role: 'personal_agent', sender_participant_id: B.id });
      } finally {
        await a.close(); await b.close();
      }
    } finally {
      ctx.close();
    }
  });

  it('messages survive restart; polling is non-destructive + paginated; cursor loss recovers via list', async () => {
    const dbPath = tempDbPath('mupit-restart');
    try {
      const ctx1 = makeTestContext({}, dbPath);
      let conv = '';
      let tokenA = '';
      let tokenB = '';
      {
        const a = await TClient.connect(ctx1, 'a');
        const b = await TClient.connect(ctx1, 'b');
        try {
          const A = await registerUser(a, 'a', INTRO_A, PREFS_A);
          const B = await registerUser(b, 'b', INTRO_B, PREFS_B);
          tokenA = A.token; tokenB = B.token;
          const opened = await a.call('mupit_open_conversation', {
            participant_token: A.token, request_id: req(), target_participant_id: B.id, kind: 'question', body: 'msg1',
          });
          conv = String(opened.conversation_id);
          await b.call('mupit_send_message', { participant_token: B.token, request_id: req(), conversation_id: conv, kind: 'answer', body: 'msg2' }, );
          await a.call('mupit_send_message', { participant_token: A.token, request_id: req(), conversation_id: conv, kind: 'answer', body: 'msg3' });
        } finally {
          await a.close(); await b.close();
        }
        ctx1.db.close(); // simulate restart (keep files)
      }
      const ctx2 = makeTestContext({}, dbPath);
      try {
        const a = await TClient.connect(ctx2, 'a2');
        const b = await TClient.connect(ctx2, 'b2');
        try {
          // Messages survived.
          const read = await a.call('mupit_read_conversation', { participant_token: tokenA, conversation_id: conv });
          expect((read.messages as unknown[])).toHaveLength(3);
          // Non-destructive paginated poll: same page twice, then next page, no skips.
          const p1 = await b.call('mupit_poll', { participant_token: tokenB, limit: 2 });
          const p1again = await b.call('mupit_poll', { participant_token: tokenB, limit: 2 });
          expect(p1again.events).toEqual(p1.events);
          const p2 = await b.call('mupit_poll', { participant_token: tokenB, cursor: String(p1.next_cursor), limit: 2 });
          const ids1 = (p1.events as Array<{ event_id: number }>).map((e) => e.event_id);
          const ids2 = (p2.events as Array<{ event_id: number }>).map((e) => e.event_id);
          expect(new Set([...ids1, ...ids2]).size).toBe(ids1.length + ids2.length);
          expect(Math.min(...ids2) > Math.max(...ids1)).toBe(true);
          // Lost cursor: list_conversations reconstructs pending work.
          const list = await b.call('mupit_list_conversations', { participant_token: tokenB });
          const item = (list.conversations as Array<{ conversation_id: string; awaiting_my_reply: boolean }>).find((c) => c.conversation_id === conv);
          expect(item).toBeDefined();
        } finally {
          await a.close(); await b.close();
        }
      } finally {
        ctx2.db.close();
      }
    } finally {
      cleanupDbPath(dbPath);
    }
  });

  it('clients cannot forge mupit authorship; all agent messages carry the authenticated author', async () => {
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
        // No tool accepts a sender role; extra fields are ignored by validation.
        await a.call('mupit_send_message', {
          participant_token: A.token, request_id: req(), conversation_id: conv, kind: 'answer',
          body: 'claiming to be mupit', sender_role: 'mupit', sender_participant_id: B.id,
        });
        const rows = ctx.db.prepare('SELECT sender_role, sender_participant_id FROM messages WHERE conversation_id = ? ORDER BY seq').all(conv) as Array<{
          sender_role: string; sender_participant_id: string;
        }>;
        expect(rows.every((r) => r.sender_role === 'personal_agent')).toBe(true);
        expect(rows.every((r) => r.sender_participant_id === A.id)).toBe(true);
      } finally {
        await a.close(); await b.close();
      }
    } finally {
      ctx.close();
    }
  });
});

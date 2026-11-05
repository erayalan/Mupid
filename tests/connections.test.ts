import { describe, expect, it } from 'vitest';
import { INTRO_A, INTRO_B, PREFS_A, PREFS_B, TClient, makeTestContext, registerUser, req } from './helpers.js';

async function openPair(ctx: Parameters<typeof TClient.connect>[0]) {
  const a = await TClient.connect(ctx, 'a');
  const b = await TClient.connect(ctx, 'b');
  const A = await registerUser(a, 'a', INTRO_A, PREFS_A);
  const B = await registerUser(b, 'b', INTRO_B, PREFS_B);
  const opened = await a.call('mupit_open_conversation', {
    participant_token: A.token, request_id: req(), target_participant_id: B.id, kind: 'question', body: 'hi B',
  });
  return { a, b, A, B, conv: String(opened.conversation_id) };
}

describe('contact exchange (acceptance #8-#15)', () => {
  it('assessment never authorizes approval/release; full negotiate->counter->release flow works', async () => {
    const ctx = makeTestContext();
    try {
      const { a, b, A, B, conv } = await openPair(ctx);
      try {
        await a.call('mupit_set_assessment', {
          participant_token: A.token, request_id: req(), conversation_id: conv, assessment: 'promising', rationale: 'looks good',
        });
        // Assessment alone: no proposal exists; submission impossible.
        await a.fails('mupit_submit_contact', {
          participant_token: A.token, request_id: req(), conversation_id: conv, proposal_version: 1,
          channel: 'email', contact_value: 'a@example.com', human_confirmed: true,
        }, 'CONSENT_REQUIRED');

        const p1 = await a.call('mupit_propose_connection', {
          participant_token: A.token, request_id: req(), conversation_id: conv, expected_version: 0, channel: 'instagram', human_confirmed: true,
        });
        expect(p1.version).toBe(1);
        // B counters with email -> v2; stale v1 acceptance fails.
        const p2 = await b.call('mupit_propose_connection', {
          participant_token: B.token, request_id: req(), conversation_id: conv, expected_version: 1, channel: 'email', human_confirmed: true,
        });
        expect(p2.version).toBe(2);
        await a.fails('mupit_respond_connection', {
          participant_token: A.token, request_id: req(), conversation_id: conv, proposal_version: 1, decision: 'accept', human_confirmed: true,
        }, 'VERSION_CONFLICT');
        const p3 = await a.call('mupit_respond_connection', {
          participant_token: A.token, request_id: req(), conversation_id: conv, proposal_version: 2, decision: 'accept', human_confirmed: true,
        });
        expect(p3.status).toBe('awaiting_contacts');

        // One-sided submission: withheld everywhere.
        const s1 = await a.call('mupit_submit_contact', {
          participant_token: A.token, request_id: req(), conversation_id: conv, proposal_version: 2,
          channel: 'email', contact_value: 'a@example.com', human_confirmed: true,
        });
        expect(s1.released).toBe(false);
        await b.fails('mupit_get_connection_contact', { participant_token: B.token, conversation_id: conv, proposal_version: 2 }, 'CONTACT_NOT_RELEASED');
        // No read path leaks the value.
        const read = await b.call('mupit_read_conversation', { participant_token: B.token, conversation_id: conv });
        expect(JSON.stringify(read).includes('a@example.com')).toBe(false);
        const poll = await b.call('mupit_poll', { participant_token: B.token });
        expect(JSON.stringify(poll).includes('a@example.com')).toBe(false);
        const disc = await b.call('mupit_discover', { participant_token: B.token });
        expect(JSON.stringify(disc).includes('a@example.com')).toBe(false);

        // Mutual submission -> exactly one atomic release; each reads ONLY the counterpart's.
        const s2 = await b.call('mupit_submit_contact', {
          participant_token: B.token, request_id: req(), conversation_id: conv, proposal_version: 2,
          channel: 'email', contact_value: 'b@example.com', human_confirmed: true,
        });
        expect(s2.released).toBe(true);
        const ca = await a.call('mupit_get_connection_contact', { participant_token: A.token, conversation_id: conv, proposal_version: 2 });
        const cb = await b.call('mupit_get_connection_contact', { participant_token: B.token, conversation_id: conv, proposal_version: 2 });
        expect(ca.contact_value).toBe('b@example.com');
        expect(cb.contact_value).toBe('a@example.com');
        const n = (ctx.db.prepare("SELECT COUNT(*) AS n FROM connection_proposals WHERE status = 'released'").get() as { n: number }).n;
        expect(n).toBe(1);
        // Post-release matchmaking is over.
        await a.fails('mupit_send_message', {
          participant_token: A.token, request_id: req(), conversation_id: conv, kind: 'answer', body: 'after release',
        }, 'CONVERSATION_RELEASED');
      } finally {
        await a.close(); await b.close();
      }
    } finally {
      ctx.close();
    }
  });

  it('counter/revoke/decline during negotiation invalidate pending submissions (race-equivalent outcomes)', async () => {
    const ctx = makeTestContext();
    try {
      const { a, b, A, B, conv } = await openPair(ctx);
      try {
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
        // Counter wipes A's pending submission; B's later submit for v1 fails.
        await b.call('mupit_propose_connection', {
          participant_token: B.token, request_id: req(), conversation_id: conv, expected_version: 1, channel: 'phone', human_confirmed: true,
        });
        const subs = (ctx.db.prepare('SELECT * FROM contact_submissions WHERE conversation_id = ?').all(conv) as unknown[]).length;
        expect(subs).toBe(0);
        await b.fails('mupit_submit_contact', {
          participant_token: B.token, request_id: req(), conversation_id: conv, proposal_version: 1,
          channel: 'email', contact_value: 'b@example.com', human_confirmed: true,
        }, 'VERSION_CONFLICT');
        // No release possible on stale consent.
        await a.fails('mupit_get_connection_contact', { participant_token: A.token, conversation_id: conv, proposal_version: 2 }, 'CONTACT_NOT_RELEASED');

        // Fresh approvals + submissions on v2, then revoke clears everything.
        await a.call('mupit_respond_connection', {
          participant_token: A.token, request_id: req(), conversation_id: conv, proposal_version: 2, decision: 'accept', human_confirmed: true,
        });
        await a.call('mupit_submit_contact', {
          participant_token: A.token, request_id: req(), conversation_id: conv, proposal_version: 2,
          channel: 'phone', contact_value: '+1-555-0100', human_confirmed: true,
        });
        const rv = await b.call('mupit_respond_connection', {
          participant_token: B.token, request_id: req(), conversation_id: conv, proposal_version: 2, decision: 'revoke', human_confirmed: true,
        });
        expect(rv.status).toBe('negotiating');
        const subs2 = (ctx.db.prepare('SELECT * FROM contact_submissions WHERE conversation_id = ?').all(conv) as unknown[]).length;
        expect(subs2).toBe(0);

        // Decline closes the introduction; nothing reusable.
        await b.call('mupit_respond_connection', {
          participant_token: B.token, request_id: req(), conversation_id: conv, proposal_version: 2, decision: 'decline', human_confirmed: true,
        });
        await a.fails('mupit_propose_connection', {
          participant_token: A.token, request_id: req(), conversation_id: conv, expected_version: 2, channel: 'email', human_confirmed: true,
        }, 'CONVERSATION_CLOSED');
      } finally {
        await a.close(); await b.close();
      }
    } finally {
      ctx.close();
    }
  });

  it('block/close/reject rules: closed threads refuse messages; block stops future contact reads', async () => {
    const ctx = makeTestContext();
    try {
      const { a, b, A, B, conv } = await openPair(ctx);
      try {
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
        const before = await a.call('mupit_get_connection_contact', { participant_token: A.token, conversation_id: conv, proposal_version: 1 });
        expect(before.contact_value).toBe('b@example.com');
        // Block prevents FUTURE reads (prior disclosure acknowledged in docs).
        await b.call('mupit_block_participant', { participant_token: B.token, request_id: req(), participant_id: A.id });
        await a.fails('mupit_get_connection_contact', { participant_token: A.token, conversation_id: conv, proposal_version: 1 }, 'CONTACT_NOT_RELEASED');
        // Closed pair: messages + reopen refused.
        await a.fails('mupit_send_message', {
          participant_token: A.token, request_id: req(), conversation_id: conv, kind: 'answer', body: 'x',
        }, 'CONVERSATION_CLOSED');
        await a.fails('mupit_open_conversation', {
          participant_token: A.token, request_id: req(), target_participant_id: B.id, kind: 'question', body: 'again?',
        });
      } finally {
        await a.close(); await b.close();
      }
    } finally {
      ctx.close();
    }
  });

  it('introduction update that invalidates eligibility blocks pending connection progression', async () => {
    const ctx = makeTestContext();
    try {
      const { a, b, A, B, conv } = await openPair(ctx);
      try {
        const self = await b.call('mupit_get_self', { participant_token: B.token });
        // B narrows intent to casual-only: pair no longer reciprocal.
        await b.call('mupit_update_introduction', {
          participant_token: B.token, request_id: req(), expected_version: self.introduction_version,
          introduction: { ...INTRO_B, relationship_intent: 'casual' },
          preferences: { ...PREFS_B, accepted_intents: ['casual'] },
          publication_confirmed: true,
        });
        await a.fails('mupit_propose_connection', {
          participant_token: A.token, request_id: req(), conversation_id: conv, expected_version: 0, channel: 'email', human_confirmed: true,
        }, 'INELIGIBLE_PAIR');
        // Optimistic concurrency on updates.
        await b.fails('mupit_update_introduction', {
          participant_token: B.token, request_id: req(), expected_version: self.introduction_version,
          introduction: INTRO_B, preferences: PREFS_B, publication_confirmed: true,
        }, 'VERSION_CONFLICT');
      } finally {
        await a.close(); await b.close();
      }
    } finally {
      ctx.close();
    }
  });
});

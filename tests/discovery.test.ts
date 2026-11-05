import { describe, expect, it } from 'vitest';
import {
  INTRO_A, INTRO_B, INTRO_CASUAL, PREFS_A, PREFS_B, PREFS_CASUAL,
  TClient, makeTestContext, registerUser, req,
} from './helpers.js';

describe('discovery filters (acceptance #5)', () => {
  it('reciprocal filters exclude one-sided matches, self, paused, blocked; missing-data goes to needs_clarification', async () => {
    const ctx = makeTestContext();
    try {
      const a = await TClient.connect(ctx, 'a');
      try {
        const A = await registerUser(a, 'a', INTRO_A, PREFS_A);
        const B = await registerUser(a, 'b', INTRO_B, PREFS_B);
        const D = await registerUser(a, 'd', INTRO_CASUAL, PREFS_CASUAL);
        // Gender unstated while A requires an explicit gender match.
        const N = await registerUser(a, 'n', {
          age: 27, about_me: 'Test cyclist from Portland.', looking_for: 'A long-term partner.',
          relationship_intent: 'long_term', region: 'Portland', open_to_long_distance: true,
          interests: [], values: [], lifestyle: [], dealbreakers: [],
        }, { age_min: 24, age_max: 40, accepted_intents: ['dating', 'long_term'], same_region_only: false });

        const disc = await a.call('mupit_discover', { participant_token: A.token });
        const ids = ((disc.candidates as Array<{ participant_id: string }>)).map((c) => c.participant_id);
        expect(ids).toContain(B.id); // eligible
        expect(ids).not.toContain(A.id); // self excluded
        expect(ids).not.toContain(D.id); // reciprocal mismatch excluded
        expect(ids).not.toContain(N.id); // missing explicit-required data: NOT in eligible list
        const needs = (disc.needs_clarification as Array<{ participant_id: string; reasons: string[] }>);
        expect(needs.map((n) => n.participant_id)).toContain(N.id);
        expect(needs.find((n) => n.participant_id === N.id)?.reasons.join(' ')).toMatch(/gender/i);

        // Opening an ineligible pair fails; ineligible open does not create threads.
        await a.fails('mupit_open_conversation', {
          participant_token: A.token, request_id: req(), target_participant_id: D.id, kind: 'question', body: 'hi',
        }, 'INELIGIBLE_PAIR');

        // Paused candidates disappear from discovery.
        await a.call('mupit_set_active', { participant_token: B.token, request_id: req(), active: false });
        const disc2 = await a.call('mupit_discover', { participant_token: A.token });
        expect(((disc2.candidates as Array<{ participant_id: string }>)).map((c) => c.participant_id)).not.toContain(B.id);
        await a.call('mupit_set_active', { participant_token: B.token, request_id: req(), active: true });

        // Blocked pairs disappear from discovery.
        await a.call('mupit_block_participant', { participant_token: A.token, request_id: req(), participant_id: B.id });
        const disc3 = await a.call('mupit_discover', { participant_token: A.token });
        expect(((disc3.candidates as Array<{ participant_id: string }>)).map((c) => c.participant_id)).not.toContain(B.id);
      } finally {
        await a.close();
      }
    } finally {
      ctx.close();
    }
  });
});

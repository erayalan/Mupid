import type { PersonaFixture } from './types.js';

/**
 * Fictional-human policy fixture: deterministic simulated-human decisions.
 * This is the ONLY source of simulated consent and prewritten follow-up
 * answers. Model-generated enthusiasm can never synthesize consent: the
 * runner consults this module (not the LLM) for every proposal/contact
 * decision, and records `simulated_fixture` provenance on each call.
 */

export type ProposalDecision =
  | { decision: 'accept' }
  | { decision: 'counter'; channel: string }
  | { decision: 'decline' };

export function decideProposal(fixture: PersonaFixture, channel: string): ProposalDecision {
  const d = fixture.decisions;
  if (d.decline_all) return { decision: 'decline' };
  if (d.accept_channels.includes(channel)) return { decision: 'accept' };
  const counter = d.counter_with[channel];
  if (counter) return { decision: 'counter', channel: counter };
  // Unknown/unacceptable channel: decline rather than invent acceptance.
  return { decision: 'decline' };
}

export function contactFor(fixture: PersonaFixture, channel: string): string | null {
  return fixture.decisions.contacts[channel] ?? null;
}

const TOPIC_KEYWORDS: Array<{ topic: string; keywords: RegExp }> = [
  { topic: 'time_together', keywords: /time together|together.*time|independent|alone time| evenings|weekends|balance/i },
  { topic: 'pace', keywords: /\bpace\b|how fast|how slow|move in|moving in|commit|meet in person|meet up|timeline/i },
  { topic: 'kids', keywords: /\bkids\b|children|child-free|childfree|family plans|parent/i },
  { topic: 'communication', keywords: /communicat|texting|call|contact frequency|how often.*(talk|text|call)/i },
  { topic: 'distance', keywords: /distance|long distance|relocate|move to|two cities|travel/i },
];

/** Match a question to a prewritten fictional-human answer, if one exists. */
export function followupAnswer(fixture: PersonaFixture, questionText: string): { topic: string; answer: string } | null {
  for (const { topic, keywords } of TOPIC_KEYWORDS) {
    if (keywords.test(questionText)) {
      const answer = fixture.decisions.followups[topic];
      if (answer) return { topic, answer };
    }
  }
  return null;
}

/** Share channel willingness, never contact values or approval for the other human. */
export function channelPreferenceText(fixture: PersonaFixture): string {
  const d = fixture.decisions;
  if (d.decline_all) return 'Not currently open to exchanging contact details.';
  return `Preferred contact channel: ${d.prefer_channel}. Open to: ${d.accept_channels.join(', ')}. ` +
    'This states a preference only; an exchange still requires mutual channel approval and private submissions.';
}

import type { DatabaseSync } from 'node:sqlite';
import { Store, parseIntro, parsePrefs, type ParticipantRow } from '../db/store.js';
import type { Introduction, Preferences } from './schemas.js';

export interface EligibilityResult {
  eligible: boolean;
  /** True when the ONLY blockers are missing explicit-required data (documented: excluded until clarified). */
  needsClarification: boolean;
  reasons: string[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function checkEligibility(
  aIntro: Introduction, aPrefs: Preferences,
  bIntro: Introduction, bPrefs: Preferences,
): EligibilityResult {
  const reasons: string[] = [];
  let clarificationOnly = true;

  const genderOk = (holder: string, accepted: string[] | undefined, candGender: string | undefined): { ok: boolean; missing: boolean; note: string } => {
    if (!accepted || accepted.length === 0) return { ok: true, missing: false, note: '' };
    if (!candGender) return { ok: false, missing: true, note: `${holder} requires an explicit gender match, but the candidate has not stated one.` };
    const normAccepted = accepted.map(norm);
    if (!normAccepted.includes(norm(candGender))) {
      return { ok: false, missing: false, note: `${holder} does not accept the candidate's stated gender category.` };
    }
    return { ok: true, missing: false, note: '' };
  };

  // Full reciprocal evaluation (both directions, explicit requirements only).
  const pairs: Array<{ seekerPrefs: Preferences; candIntro: Introduction; candGender: string | undefined; seekerTag: string; seekerRegion: string; seekerLDR: boolean }> = [
    { seekerPrefs: aPrefs, candIntro: bIntro, candGender: bPrefs.gender, seekerTag: 'A', seekerRegion: aIntro.region, seekerLDR: aIntro.open_to_long_distance },
    { seekerPrefs: bPrefs, candIntro: aIntro, candGender: aPrefs.gender, seekerTag: 'B', seekerRegion: bIntro.region, seekerLDR: bIntro.open_to_long_distance },
  ];
  for (const p of pairs) {
    if (p.candIntro.age < p.seekerPrefs.age_min || p.candIntro.age > p.seekerPrefs.age_max) {
      reasons.push(`Party ${p.seekerTag} requires age ${p.seekerPrefs.age_min}-${p.seekerPrefs.age_max}; counterpart is ${p.candIntro.age}.`);
      clarificationOnly = false;
    }
    if (!p.seekerPrefs.accepted_intents.includes(p.candIntro.relationship_intent)) {
      reasons.push(`Party ${p.seekerTag} does not accept relationship intent "${p.candIntro.relationship_intent}".`);
      clarificationOnly = false;
    }
    const g = genderOk(`Party ${p.seekerTag}`, p.seekerPrefs.accepted_genders, p.candGender);
    if (!g.ok) {
      reasons.push(g.note);
      if (!g.missing) clarificationOnly = false;
    }
    const sameRegion = norm(p.seekerRegion) === norm(p.candIntro.region);
    if (p.seekerPrefs.same_region_only && !sameRegion) {
      reasons.push(`Party ${p.seekerTag} requires the same region ("${p.seekerRegion.trim()}").`);
      clarificationOnly = false;
    } else if (!sameRegion && !p.seekerLDR) {
      reasons.push(`Party ${p.seekerTag} is not open to long distance.`);
      clarificationOnly = false;
    }
  }

  if (reasons.length === 0) return { eligible: true, needsClarification: false, reasons: [] };
  return { eligible: false, needsClarification: clarificationOnly, reasons };
}

export interface CandidateView {
  participant_id: string;
  introduction: Introduction;
  preferences: Preferences;
  introduction_version: number;
  is_simulated: boolean;
  match_notes: string[];
}

function matchNotes(aIntro: Introduction, aPrefs: Preferences, bIntro: Introduction, bPrefs: Preferences): string[] {
  const notes: string[] = ['Reciprocal age fit', 'Mutually accepted relationship intentions'];
  if (norm(aIntro.region) === norm(bIntro.region)) notes.push(`Same region (${aIntro.region.trim()})`);
  else if (aIntro.open_to_long_distance && bIntro.open_to_long_distance) notes.push('Both open to long distance');
  if ((aPrefs.accepted_genders?.length ?? 0) > 0 || (bPrefs.accepted_genders?.length ?? 0) > 0) notes.push('Gender preferences mutually satisfied');
  return notes;
}

function toCandidate(row: ParticipantRow, me: ParticipantRow): CandidateView {
  const intro = parseIntro(row);
  const prefs = parsePrefs(row);
  return {
    participant_id: row.id,
    introduction: intro,
    preferences: prefs,
    introduction_version: row.version,
    is_simulated: row.is_simulated === 1,
    match_notes: matchNotes(parseIntro(me), parsePrefs(me), intro, prefs),
  };
}

export interface DiscoverResult {
  candidates: CandidateView[];
  needs_clarification: Array<{ participant_id: string; reasons: string[]; introduction_version: number }>;
  next_cursor: string | null;
}

/**
 * Reciprocal discovery. Excludes self, paused participants, blocked pairs,
 * and any pair with an existing conversation (active, released, or closed).
 * Ordering is stable (participant ID ascending). Cursor = last seen ID.
 */
export function discoverCandidates(db: DatabaseSync, callerId: string, cursor: string | undefined, limit: number): DiscoverResult {
  const store = new Store(db);
  const me = store.getParticipantById(callerId);
  if (!me) throw new Error('authenticated participant vanished');
  const candidates: CandidateView[] = [];
  const needs: DiscoverResult['needs_clarification'] = [];
  let lastScanned: string | null = null;
  let stoppedEarly = false;

  for (const row of store.listActiveParticipantsExcluding(callerId)) {
    if (cursor && row.id <= cursor) continue;
    lastScanned = row.id;
    if (store.isBlockedPair(callerId, row.id)) continue;
    if (store.getConversationForPair(callerId, row.id)) continue;
    const verdict = checkEligibility(parseIntro(me), parsePrefs(me), parseIntro(row), parsePrefs(row));
    if (verdict.eligible) {
      candidates.push(toCandidate(row, me));
    } else if (verdict.needsClarification && needs.length < limit) {
      needs.push({ participant_id: row.id, reasons: verdict.reasons, introduction_version: row.version });
    }
    if (candidates.length >= limit) {
      stoppedEarly = true;
      break;
    }
  }
  return { candidates, needs_clarification: needs, next_cursor: stoppedEarly && lastScanned ? lastScanned : null };
}

/** Shared types for the local simulated-personal-agent demo harness. */
export interface FixtureDecisions {
  prefer_channel: string;
  accept_channels: string[];
  counter_with: Record<string, string>;
  decline_all: boolean;
  propose_first: boolean;
  contacts: Record<string, string>;
  followups: Record<string, string>;
}

export interface PersonaFixture {
  name: string;
  label: string;
  persona_private: string;
  introduction: Record<string, unknown>;
  preferences: Record<string, unknown>;
  disclosable_facts: string[];
  /** Fixture-authored, approved outreach for the optional background demo. No contacts. */
  background_introduction?: string;
  decisions: FixtureDecisions;
  script: Array<{ kind: string; reply: string }>;
}

export interface AgentState {
  name: string;
  participant_id: string;
  token: string;
  registration_key: string;
  event_cursor: string;
  request_seq: number;
  /** conversation_id -> bookkeeping */
  threads: Record<string, {
    counterpart_id: string;
    last_seen_seq: number;
    responses_sent: number;
    script_index: number;
    facilitated_revs: number[];
    assessment: string | null;
    proposed: boolean;
    background_intro_sent?: boolean;
  }>;
  llm_calls: number;
  completed_releases: string[];
}

export function newAgentState(name: string): AgentState {
  return {
    name, participant_id: '', token: '', registration_key: '',
    event_cursor: '0', request_seq: 0, threads: {}, llm_calls: 0, completed_releases: [],
  };
}

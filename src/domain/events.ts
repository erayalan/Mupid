import type { DatabaseSync } from 'node:sqlite';
import { Store, type EventRow } from '../db/store.js';

export type EventType =
  | 'message.created'
  | 'assessment.updated'
  | 'proposal.updated'
  | 'contact.submitted' // boolean only: which side submitted; never values
  | 'connection.released'
  | 'conversation.closed';

export interface PollResult {
  events: Array<{ event_id: number; type: string; payload: Record<string, unknown>; created_at: string }>;
  next_cursor: string;
  has_more: boolean;
  hints: { new_messages: number; proposal_updates: number; releases: number };
}

/** Recipient-scoped, non-destructive, paginated inbox. Cursor = last event id. */
export function pollEvents(db: DatabaseSync, recipientId: string, cursor: string | undefined, limit: number): PollResult {
  const store = new Store(db);
  const after = cursor === undefined || cursor === '' ? 0 : Number.parseInt(cursor, 10);
  if (!Number.isInteger(after) || after < 0) throw new Error('Invalid event cursor.');
  const rows: EventRow[] = store.pollEvents(recipientId, after, limit + 1);
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const hints = { new_messages: 0, proposal_updates: 0, releases: 0 };
  for (const e of page) {
    if (e.type === 'message.created') hints.new_messages += 1;
    else if (e.type === 'proposal.updated' || e.type === 'contact.submitted') hints.proposal_updates += 1;
    else if (e.type === 'connection.released') hints.releases += 1;
  }
  const lastId = page.length > 0 ? page[page.length - 1]!.id : after;
  return {
    events: page.map((e) => ({ event_id: e.id, type: e.type, payload: JSON.parse(e.payload_json) as Record<string, unknown>, created_at: e.created_at })),
    next_cursor: String(lastId),
    has_more: hasMore,
    hints,
  };
}

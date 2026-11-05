import { z } from 'zod';
import { FACILITATOR_ACTIONS } from '../domain/schemas.js';

/** Strict validated result schema for facilitator output (model AND mock). */
export const FacilitatorOutputSchema = z.object({
  action: z.enum(FACILITATOR_ACTIONS),
  addressed_participant_ids: z.array(z.string().min(1).max(64)).min(1).max(2),
  message: z.string().trim().min(1).max(2000),
  reasons: z.array(z.string().trim().min(1).max(300)).max(8),
  tensions: z.array(z.string().trim().min(1).max(300)).max(8),
  unknowns: z.array(z.string().trim().min(1).max(300)).max(8),
  evidence_refs: z.array(z.string().min(1).max(80)).max(12),
  awaiting_participant_ids: z.array(z.string().min(1).max(64)).max(2),
});
export type FacilitatorOutput = z.infer<typeof FacilitatorOutputSchema>;

/** JSON Schema (plain) sent to Meta's API via response_format json_schema. */
export const FACILITATOR_JSON_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...FACILITATOR_ACTIONS] },
    addressed_participant_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
    message: { type: 'string', minLength: 1, maxLength: 2000 },
    reasons: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 8 },
    tensions: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 8 },
    unknowns: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 8 },
    evidence_refs: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 12 },
    awaiting_participant_ids: { type: 'array', items: { type: 'string' }, maxItems: 2 },
  },
  required: ['action', 'addressed_participant_ids', 'message', 'reasons', 'tensions', 'unknowns', 'evidence_refs', 'awaiting_participant_ids'],
  additionalProperties: false,
} as const;

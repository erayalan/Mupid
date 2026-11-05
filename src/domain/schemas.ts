import { z } from 'zod';

export const RELATIONSHIP_INTENTS = ['dating', 'long_term', 'marriage', 'casual', 'friendship_first', 'open_to_discussing'] as const;
export type RelationshipIntent = (typeof RELATIONSHIP_INTENTS)[number];

export const CHANNELS = ['email', 'instagram', 'phone'] as const;
export type Channel = (typeof CHANNELS)[number];

export const MESSAGE_KINDS = ['question', 'answer', 'assessment', 'needs_user_input'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const ASSESSMENTS = ['exploring', 'promising', 'not_a_fit', 'needs_user_input'] as const;
export type Assessment = (typeof ASSESSMENTS)[number];

export const FACILITATOR_ACTIONS = ['ask_agents', 'recommend_introduction', 'recommend_no_fit', 'needs_clarification', 'wait'] as const;
export type FacilitatorAction = (typeof FACILITATOR_ACTIONS)[number];

const shortText = (max: number) => z.string().trim().min(1).max(max);
const textList = (itemMax: number, countMax: number) =>
  z.array(z.string().trim().min(1).max(itemMax)).max(countMax).default([]);

export const IntroductionSchema = z.object({
  age: z.number().int().min(18).max(120),
  about_me: shortText(1500),
  looking_for: shortText(1500),
  relationship_intent: z.enum(RELATIONSHIP_INTENTS),
  region: shortText(120),
  open_to_long_distance: z.boolean(),
  interests: textList(200, 12),
  values: textList(200, 12),
  lifestyle: textList(200, 12),
  dealbreakers: textList(300, 12),
});
export type Introduction = z.infer<typeof IntroductionSchema>;

export const PreferencesSchema = z
  .object({
    age_min: z.number().int().min(18).max(120),
    age_max: z.number().int().min(18).max(120),
    gender: z.string().trim().max(60).optional(),
    accepted_genders: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
    accepted_intents: z.array(z.enum(RELATIONSHIP_INTENTS)).min(1).max(6),
    same_region_only: z.boolean(),
  })
  .refine((p) => p.age_min <= p.age_max, { message: 'age_min must be <= age_max' });
export type Preferences = z.infer<typeof PreferencesSchema>;

export const ParticipantTokenSchema = z.string().min(16).max(256);

export const RequestIdSchema = z.string().min(8).max(128);

export const RegistrationKeySchema = z.string().min(16).max(256);

export const CursorSchema = z.string().max(128).optional();

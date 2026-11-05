# Mupit demo script (video storyboard)

Prerecorded conversations and cuts between sessions are fine; nothing must happen live. Phrases in quotes are suggested verbatim user prompts. Screens marked [Muse] are the real personal-agent session; [sim] is the local harness; [cli] is a terminal.

For the complete conversational rehearsal, see [natural-demo.md](natural-demo.md). Suggested replies are examples, never substitutes for actual tool results.

## Setup (before recording)

```bash
npm install
npm run setup:local
cp .env.example .env   # set META_API_KEY
npm run demo:up -- --live
```

This starts the demo server on port 3001 with the demo database, seeds the five fictional adults (wren, sam, jules, theo, noor) if needed, and polls sim agents every 4s. Connect real Muse to `http://127.0.0.1:3001/mcp` (streamable_http) or via the stdio adapter — see [reviewer-guide](reviewer-guide.md). Suggested persona to play: [suggested-user.json](../demo/fixtures/suggested-user.json).

## Scene 1 — Join [Muse]

Prompt: "I want to find love with Mupid."

- Agent calls `mupit_start`, asks you to describe yourself and whom you seek, follows up on missing details, then shows the EXACT introduction + all preferences in readable language.
- You approve publication and adult self-attestation; agent registers and saves the token privately. It starts discovery and up to two relevant agent conversations. Only after that work succeeds does it say it has started and invite you to check back.
- Proves: natural onboarding, exact-approval step, no identifiers published.

CUT.

## Scene 2 — Check matches, first facilitator question [Muse] + [sim]

Prompt: "Is there anyone out there for me?"

- Agent polls and reads replies to the threads started after registration; discovery fills gaps if useful. Present people by their public aliases or descriptive labels, with evidence for fit and open questions. Technical filtering details can be shown in the separate inspector view.
- Agent continues the existing Seattle bookworm thread (or opens it if still appropriate and not yet opened), then calls `mupit_facilitate` once when available. Never select Sam merely because the script names the fixture.
- Proves: reciprocal filtering with honest edge cases, one bounded check.

CUT to [cli]: `npm run demo:tick` (or wait for the background poll) so sam's sim replies from its persona + fixture facts. CUT back.

Prompt: "Is there anyone out there for me?" (second check)

- Agent reads sam's reply AND a REAL model-generated Mupit question that goes beyond profile filtering (e.g., time-together balance). Agent relays the question to YOU in its own words; you answer ("about half and half"); agent replies in-thread and facilitates again for an evidence-grounded recommendation (reasons / tensions / unknowns).
- Show `npm run inspect:demo -- --conversation <id>` output: the mupit message labeled separately from both personal agents, with model + latency metadata.
- Proves: three-way async conversation, real inference adding value, evidence grounding, human stays in the loop.

CUT.

## Scene 3 — The mismatch [Muse] + [sim] (negative example)

Prompt: "Also ask jules's agent about pace and time together."

- Thread with jules: Mupit asks; jules's sim answers honestly from fixture facts (fast commitment, deep togetherness, kids within a year — no softening).
- Next facilitate: `recommend_no_fit` with cited evidence. Your agent summarizes the caring mismatch and does NOT push. You close the thread.
- Proves: Mupit optimizes for worthwhile introductions, not match count; `not_a_fit` is a first-class outcome. Do not force a matching outcome.

CUT.

## Scene 4 — Channel negotiation [Muse] + [sim]

Prompt: "I'd like to connect with sam via Instagram."

- Agent proposes Instagram v1 (human_confirmed=true) after your approval.
- [sim tick] sam's fixture counters with email → v2 (v1 approvals invalidated).
- Agent: "They countered with email — is that OK?" You: "Yes, email is fine."
- Agent accepts v2 → `awaiting_contacts`.
- Proves: human-decided negotiation, version invalidation, no auto-accept. (Sam's consent is labeled `simulated_fixture` in `inspect:demo` + provenance.)

CUT.

## Scene 5 — Withheld, then released [Muse] + [sim]

Prompt: "Here's my email <your demo address> — submit it for the sam introduction."

- Agent submits; status shows released=false, awaiting counterpart. Show that sam CANNOT read it (release event absent; contact-read fails) — narrate: "one-sided submissions stay hidden."
- [sim tick] sam's fixture submits its reserved `sam@example.com` → atomic release; both get `connection.released`.
- Agent reads via `mupit_get_connection_contact` and presents sam's intro + released contact. It does NOT send any message anywhere.
- Proves: the essential invariant — release only after both current approvals + both current submissions; single dedicated read path; Mupit only exchanges details.

CUT.

## Scene 6 — Close [cli]

- `npm run inspect:demo` full transcript for the record (sanitized: no tokens/contacts).
- Ctrl-C `demo:up` for clean shutdown.
- Narrate what was real vs simulated (README table): real local MCP service/auth/workflow/SQLite/vault, real Meta inference, fictional people + fixture consent.

## What each screen proves (checklist for the edit)

- [ ] Exact-approval onboarding, token saved privately (never on screen).
- [ ] Discovery: eligible + mismatch excluded + needs_clarification, with reasons.
- [ ] Real Mupit question beyond filtering; human consulted mid-thread.
- [ ] Evidence-grounded recommendation (reasons/tensions/unknowns + evidence refs).
- [ ] Negative example: honest mismatch → no_fit → close.
- [ ] Instagram countered with email; version invalidation; explicit re-approval.
- [ ] One-sided submission withheld; mutual submission → atomic release; dedicated read.
- [ ] Simulated provenance labeled everywhere it matters; no scheduled-activity claims (every check is a manual or explicitly polled tick).

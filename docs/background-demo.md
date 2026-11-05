# Background conversation demo

The background process, not the chat session, prepares introductions while the
human is away. It uses the same MCP service, authentication, SQLite database,
conversation threads, and encrypted contact exchange. It never needs the
human's participant token and never approves anything on their behalf.

## Run it

Keep the existing `.env` and demo database. Stop the old `demo:up` process first;
do not reset the database. Choose the mode explicitly:

```bash
# Live agent replies and facilitator analysis (requires working Meta billing):
npm run demo:up -- --live --background

# Explicitly simulated rehearsal, independent of Meta billing:
MUPIT_FACILITATOR_MODE=mock npm run demo:up -- --background
```

Both variants poll every four seconds. The background option additionally seeds
Leo, a fictional Portland photographer and home cook, plus Mira, Ivy, and Elena,
three fictional women for a man seeking women. Eligibility remains reciprocal;
the roster supports both demonstrated profile directions. Wren, Sam, and Leo have
fixture-approved introductions covering daily-life preferences and contact
channel willingness. They discover eligible player identities and start threads
without waiting for Muse to initiate. Jules remains an honest mismatch example
and does not send background introductions. Theo and Noor retain their existing
eligibility/clarification behavior.

Fixture introductions are always labeled simulated, even in live mode. Live
mode uses actual model calls for subsequent replies and facilitator analysis;
mock mode uses clearly labeled scripted replies and mock facilitation. Discovery
and fixture introductions can work even if live inference is blocked. A billing
failure does not magically resolve while the human waits.

An existing tunnel continues to point at the same port. Re-read `mupit_start`
from Muse after restarting; it reports `background_matching_enabled: true` and
generic matchmaking guidance. Scenario setup stays in this operator document;
accurate provenance remains available in structured metadata. Muse should keep
the already established profile context and avoid repetitive disclaimers. `/healthz` also reports `backgroundDemo`.
For a single manual cycle instead of the continuous worker:

```bash
npm run demo:tick -- --background
```

## Conversation to rehearse

**User:** Find me love with Mupid.

**Muse:** Tell me how you'd like to introduce yourself and who you're looking for.

**User:** [Describes the approved fictional adult Portland persona.]

**Muse:** [Shows the exact introduction and readable preferences, briefly explains
publication and Meta processing, and asks for publication approval and 18+
self-attestation.]

**User:** I approve this introduction and preferences and confirm the persona is 18+.

**Muse:** Noted. Check back in a bit and we'll see who's interested.

The worker now discovers the new player, opens three eligible conversations,
and posts actual fixture-approved introductions and contact-channel preferences.
No user turn, human token delegation, or open chat session is needed. Subsequent
worker cycles continue agent replies within their budgets. Each new reply
automatically schedules the server-side mediator; the simulated agents do not
need separate facilitation calls. Closed or
blocked threads stay closed; restarting creates no replacement player identity.

**User:** Is there anyone out there for me?

Muse polls, lists, and reads the actual conversations before discovering anyone
new. An example shortlist, only when the messages support it:

1. **Portland trail runner, 29.** His steady pace, independent weeknights and
   shared weekends sound close to yours. Prefers email; Instagram also works.
2. **Seattle bookworm, 32.** Values independence and is open to alternating
   Portland–Seattle weekends. He does not want children, so that needs to work
   for you. Prefers email and only accepts email.
3. **Portland photographer and home cook, 34.** Shared interests and a steady
   pace, with room for independent weeknights. Prefers Instagram; email also
   works. His plans about children are unknown.

**Muse:** Who would you like to connect with, and how?

These are possible fits supported by fixture statements. If a real facilitator
contributed, Muse can explain its actual reasoning. A mock facilitator does not
perform genuine compatibility reasoning. Never invent a positive recommendation
or exactly three results when the current player is not eligible for them.
Muse keeps the shortlist's displayed order mapped to participant IDs privately.

**User:** Give my Instagram to the first person.

If the exact handle is not already available with approval for this exchange:

**Muse:** What Instagram handle would you like me to share with the trail runner
once they've agreed?

**User:** Use alex.demo. Share that handle with him once he's agreed and submitted
his contact too.

Muse proposes Instagram for the selected person. The worker's Wren fixture
accepts Instagram and submits its own fictional contact on subsequent cycles.
Muse submits the user's exact approved handle for the current proposal version
only when both sides have accepted. If the worker is still pending, Muse gives
a short waiting update and resumes on a later check; it does not poll forever.
Contact values stay in the private contact tools. They are released only after
both approvals and both submissions. Muse can then show the counterpart contact;
it never sends an Instagram DM.

A counter to a different channel needs fresh explicit approval; "Instagram" does
not approve an email counter. If the handle is already privately available and
the user explicitly approved release to this person, Muse should not ask for it
again. A copied old approval or an unrelated social handle is insufficient.

## Verified behavior

`tests/simulator.test.ts` exercises a fresh player registration followed by
worker ticks with no player activity: three real MCP threads, candidate-specific
channel preferences, Sam's child-free caveat, no exposed contacts or proposals,
no duplicate introductions after reloading state, and a selected Instagram
exchange that remains hidden until mutual submission. The worker never receives
the player's token. Live model quality still depends on working inference.

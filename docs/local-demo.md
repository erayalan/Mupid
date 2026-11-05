# Local demo with your personal Muse

For the "find me love / check back / choose from three" background flow, use
[background-demo.md](background-demo.md).

Verified on October 29, 2026: the live background server runs at
`http://127.0.0.1:3001/mcp`, with proactive fictional-agent introductions enabled.
The existing HTTPS tunnel also reports `facilitator_mode: live` and
`background_demo: true`.

Billing is fixed and actual Meta inference succeeds. The initial 1,200-token
completion limit was too small: internal reasoning exhausted it before any
answer text. The facilitator and live simulated-agent budgets are now 8,192
tokens; response text remains separately bounded. Actual live facilitator output
was committed through MCP using `muse-spark-1.3`, and the background worker has
posted a real model-generated agent reply. Earlier billing errors below or in
historical notes do not describe the current state. No mock fallback is enabled.
Live questions may still need human answers before a recommendation is possible.

## 1. Open Muse

In a terminal:

```bash
cd /Users/erayalan/Documents/Mupid
muse -c 'mcpServers.mupit-demo={"transport":"streamable_http","url":"http://127.0.0.1:3001/mcp"}'
```

This adds the MCP server for this Muse session without changing global settings.
Use `/mcp` to inspect connectivity. Then paste:

> Call mupit_start and report server_version and facilitator_mode. Follow its
> playbook for this demo. Keep my participant token in a private local file with
> permissions 0600, and reuse my identity throughout this session. Ask for my
> explicit approval before publishing my introduction, approving a connection
> channel, or releasing any contact value. All other participants are fictional.

## 2. Start with the human's goal

The intended conversation is in [natural-demo.md](natural-demo.md). Start simply:

> I want to find love with Mupid.

Muse calls `mupit_start`, then asks you to describe yourself and whom you seek.
Answer in your own voice; for the fictional demo you can use:

> I'm a 30-year-old woman in Portland, looking for a man aged 26–38 and something
> long-term. I love hiking, photography, and cooking. Kindness, independence, and
> being direct matter to me. I don't smoke and wouldn't date a smoker or someone
> who's only looking for something casual. I like taking things steadily, having
> my own weeknights, and spending weekends together. Portland–Seattle could work.

Muse asks only for missing details, drafts an introduction, and shows the exact
text plus all preferences with readable labels. JSON is available if requested.
Review publication, model processing, and adult self-attestation before approving.
No registration until you explicitly approve. Tokens stay in private storage.

After registration, Muse starts one real, bounded check: discovery and up to two
agent conversations, with facilitation when available. Once actually waiting for
replies it invites you to check back. It does not run continuously between turns.
The separately running demo agents can respond while you are away. Live replies
require working inference; a live-mode label alone does not prove it.

## 3. Come back for recommendations

> Is there anyone out there for me?

Muse polls, reads actual replies, continues relevant conversations from approved
facts, and uses the facilitator when available. It brings any new personal
questions back to you. It summarizes promising possibilities with specific
reasons, tensions, and unknowns. A profile-only possibility must be labeled as
such; no forced recommendations or invented replies.

The demo has fictional adults with different expectations. Public introductions
may have no names, so Muse should use descriptions such as "the Seattle bookworm"
instead of exposing opaque IDs or inventing names. Fixture labels and expected
outcomes are setup context, not evidence for a recommendation. If nobody fits or
answers are still pending, Muse should say so.

## 4. Choose someone and exchange contact preferences

> I'd like to connect with the Seattle bookworm. Instagram would be good.

Muse proposes that channel for your chosen person. If their agent counters with
email, Muse asks whether you want to accept it. It must wait for your approval of
the current proposal; choosing Instagram does not approve an email counter.

> Yes, email works.

When both sides accept, Muse asks for the exact contact and permission to release
it to that person only if both submit. For the fictional demo:

> Use alex.demo@example.com. I approve sharing that address with the Seattle
> bookworm once they've submitted theirs too.

Muse uses the private contact tool, never an ordinary agent message. It explains
whether the exchange is waiting or released based on actual tool results. On a
later check it retrieves the contact only after mutual release and presents it;
it sends no email or DM. The fictional Sam fixture uses `sam@example.com`.

With background simulator polling, release may be immediate if the other side
has already submitted. To record the withheld state, use separate manual ticks
as described in the reviewer guide. A channel counter invalidates earlier
approvals and submissions, so Muse must use the current version.

## 5. Inspect and rerun

Sanitized transcript (tokens and contact values are omitted):

```bash
npm run inspect:demo
```

For future live runs, start this in one terminal and keep it running, then open
Muse in another. Do not start a second server while port 3001 is occupied.

```bash
cd /Users/erayalan/Documents/Mupid
npm run demo:up -- --live
```

Ctrl-C in that server terminal stops it. Keep the current `.env`; do not replace
it with `.env.example`.

For an explicitly simulated protocol demo without Meta API billing:

```bash
npm run demo
```

That automated demo uses a mock facilitator; it does not test your personal Muse.

To test personal Muse with mock Mupit replies if live inference is unavailable, stop
the live demo first, then run:

```bash
MUPIT_FACILITATOR_MODE=mock npm run demo:up
```

Use the same Muse launch command and prompts above. This uses scripted fictional
agents and a mock facilitator, and reports `facilitator_mode: mock` explicitly.

# Mupid

**Find love with the AI agent you already talk to.**

Personal agents are coming in hot, and there's a loneliness epidemic out there. So how about giving our personal agents the tools to help us find love? That's Mupid.

Mupid is an agent-to-agent matchmaking prototype for adults (18+). Tell your personal agent about yourself and who you hope to meet. A Meta AI-powered matchmaker facilitates conversations between personal agents, explores possible fits, and brings back questions worth asking. When you both choose to connect, Mupid exchanges the contact details you explicitly approve. Your agent helps with the introduction. The rest is up to you.

The experience lives in your existing chat with Muse. The backend exposes 19 MCP tools and can work with other MCP-capable personal agents too. The source package, commands, environment variables, and tool names retain the original `mupit` spelling.

## Who it helps and why

Meeting someone can take a lot of repetitive introductions and time figuring out whether you want the same things. Mupid is for single adults who want help with that early work, through an agent they already talk to. The opportunity is to make worthwhile introductions easier while keeping personal decisions with the people involved. Whether it improves dating outcomes still needs to be tested with real users.

## The experience

1. **Describe yourself.** Muse drafts your introduction and preferences. You approve the exact profile and confirm you are 18+ before registration.
2. **Explore possible fits.** Mupid checks requirements in both directions: age, stated gender preferences, relationship intent, and location/distance. Eligibility is rule-based; it is not an AI compatibility score.
3. **Ask what matters.** Personal agents exchange messages in pair-specific threads. A Meta-powered matchmaker identifies reasons for fit, tensions, and unanswered questions, such as plans for children. It asks rather than assumes.
4. **Choose a connection.** You choose a person and a communication channel. A counterproposal requires fresh approval.
5. **Exchange details.** Both sides must approve the current channel and submit their contacts before either contact is released. Mupid does not send Instagram DMs or emails. The rest is up to you.

In the demo walkthrough, a fictional Portland persona explores Mira, Ivy, and Elena, clarifies openness to children, and exchanges Instagram handles with Ivy. The other participants are fictional, with simulated answers and approvals.

## How it works

```text
Your Muse  <-- MCP -->  Mupid backend  <-- MCP -->  Other personal agents
                            |
                 +----------+-----------+
                 |          |           |
              SQLite     Meta model   Encrypted
             profiles,   matchmaker    contacts
             threads,    (hosted)      (vault)
             events,
             work queue
```

The backend is a Node.js/TypeScript service. New personal-agent messages automatically enqueue mediation in a durable SQLite queue. A worker calls Meta's Model API, validates the structured response, and commits a facilitator message only if the conversation is still current. Reads and polls do not trigger inference. Manual facilitation remains available for recovery.

The matchmaker receives an allowlisted view of the pair's approved introductions and shared context. Tokens, keys, contact values, private agent memory, and unrelated conversations are excluded. Its suggestions cannot approve connections, release contacts, or override eligibility rules. Contacts are encrypted with AES-256-GCM and released atomically after the required approvals and submissions.

Storage location is a deployment detail. This prototype runs the service and SQLite on the demo machine, with an optional HTTPS tunnel for remote Muse access; inference is hosted by Meta. A hosted backend is a future deployment option, not an implemented production service. The current server deliberately binds only to loopback.

See the [architecture and trust boundaries](docs/architecture.md) for the full design.

## Where Meta AI is used

- **Muse Code** was used to build the project.
- **Muse** is the personal-agent interface in the demonstrated experience.
- **The Mupid matchmaker** uses Meta's Model API for compatibility discussions, evidence-backed suggestions, and follow-up questions. The configured default is `muse-spark-1.3` at `https://api.meta.ai/v1`.
- **Other agents in the live demo** use Meta inference to reply from isolated fictional personas. Their personal facts and consent policies come from fixtures, not real people.

The model adds conversational reasoning beyond profile filtering. Backend rules retain control over identity, eligibility, approval states, and contact release. Missing or failing live credentials never silently switch the server to mock output.

### Why the models matter

Getting past “you both like hiking” takes a conversation. Muse Spark helps the matchmaker interpret what each side has actually said, identify tensions and unknowns, and formulate useful follow-up questions. For example, “I'm open to kids” leaves room for clarification when another person is unsure or wants a child-free relationship. Each personal agent can bring the question back to its human instead of inventing an answer.

That creates a three-way conversation: two personal agents representing their humans, with a separate Meta-powered matchmaker helping them explore fit. The matchmaker's structured output includes reasons, tensions, unknowns, and references to conversation evidence; the backend validates it before committing it. This use of Meta inference is central to the conversational experience. Rule-based discovery and contact-release enforcement remain useful and testable independently of the model.

## What to look for in the demo

The Muse walkthrough shows the complete path from “help me find love” to a mutually approved Instagram exchange. Watch for the children question: possible overlap becomes a conversation about a meaningful unknown, which the human clarifies. Then watch the contact exchange: selecting Ivy and proposing Instagram does not release a handle; both sides must approve the channel and submit contacts first.

The demo uses the implemented MCP service, persistence, mediation queue, and contact-release rules, with real Meta inference in live mode. Follow the reproduction steps below or see the [reviewer guide](docs/reviewer-guide.md) for a closer look.

## Run it

Requires **Node.js 24+** and npm. SQLite uses Node's built-in `node:sqlite`; there is no separate database server to install.

### Verify without API credentials

```bash
npm ci
npm run setup:local     # creates private secrets; preserves existing keys
npm run typecheck
npm test
npm run build
npm run demo            # real MCP + SQLite workflow, explicitly mocked model
```

The deterministic demo uses its own `demo/state/flow.db` and resets that rehearsal database on each run. It does not exercise live model quality or Muse integration.

### Reproduce the Muse walkthrough with live inference

Create `.env` from [.env.example](.env.example) **only if you do not already have one**, then set `META_API_KEY` to a working Meta Model API key. Live calls require available credits/billing.

```bash
npm run demo:up -- --live --background
```

This starts the demo backend at `http://127.0.0.1:3001/mcp`, seeds fictional adults, and runs simulated agents on a four-second polling loop. Background mode includes Mira, Ivy, and Elena and lets eligible fictional agents initiate introductions while Muse is idle. Existing profiles and threads are retained. Each new agent message schedules server-side mediation; this is separate from scheduling or notifications in Muse.

Connect a local MCP client to that endpoint. For remote Muse, install and configure ngrok, then run in a second terminal:

```bash
npm run demo:tunnel
```

Use the verified HTTPS `/mcp` URL printed by the launcher, then ask Muse to help you find love with Mupid. The launcher checks demo mode and MCP connectivity and disables ngrok request inspection. A remote chat still needs native MCP support or an MCP SDK client; pasting a URL alone does not install tools. Keep both processes running during the demo; Ctrl-C stops each separately. See [remote Muse setup](docs/tunnel-demo.md) and the [background demo](docs/background-demo.md).

For a fully mocked interactive rehearsal:

```bash
MUPIT_FACILITATOR_MODE=mock npm run demo:up -- --background
```

### Other commands

| Command | Purpose |
|---|---|
| `npm run dev` | Normal backend at `127.0.0.1:3000`, database `data/mupit.db` |
| `npm start` | Run the compiled backend after `npm run build` |
| `npm run seed:demo` | Idempotently seed a running demo-mode instance |
| `npm run demo:tick -- --live --background` | One bounded background-agent cycle against a running demo |
| `npm run inspect:demo` | Inspect sanitized demo transcripts without tokens or contacts |
| `node --env-file=.env --import tsx scripts/demo-live.ts` | Live facilitator smoke test with `.env` loaded; resets only `demo/state/flow-live.db` |

Health: `GET /healthz` on the backend port. A healthy service or configured API key does not establish inference readiness; check an actual live facilitator result. `seed:demo --reset` deletes the configured demo database and demo-agent state; it is not needed for normal startup.

## What is real versus simulated

| Component | Demo status |
|---|---|
| Personal-agent experience | Muse personal-agent walkthrough |
| MCP tools, authentication, persistence, contact exchange | Implemented backend |
| Matchmaker | Real Meta inference in live mode; explicit mock in rehearsal mode |
| Other participants | Fictional seeded adults |
| Other agents | Simulated clients; model-generated replies with `--live` |
| Other participants' answers and approvals | Fictional persona facts and policy fixtures, labeled as simulated |
| Automated tests / deterministic demo | Credential-free mocks; do not establish live model quality |

## Validation and current limits

Verified on November 4, 2026: type checking, build, and **40 tests across 14 files**, including real HTTP socket tests. Coverage includes all 19 MCP tools, authentication and isolation, reciprocal discovery, persistence and retries, proposal versions, mutual contact release, vault failures, facilitator context restrictions, automatic mediation/recovery, simulated-agent provenance, and tunnel host/origin restrictions. Socket tests can return early in environments that prohibit listening; use a normal development environment or CI to exercise them.

The automated suite uses model mocks. Live inference can be checked separately with the smoke-test command above. Compatibility quality, user outcomes, and production scalability have not been evaluated.

Age is self-attested, and human approvals are reported by the personal agent; the backend cannot independently prove who gave an approval. Contact screening in free text is best-effort. Rate limits are in-memory; key rotation and token recovery are not implemented. Hosted deployment, production abuse controls, and Muse-scheduled check-ins/notifications remain future work. This is a hackathon prototype, not a production dating service.

## Demo and reviewer resources

- [Architecture slide PNG](output/presentation/mupid-architecture.png) and [under-three-minute voice-over](output/presentation/mupid-voice-over.md)
- [Reviewer guide](docs/reviewer-guide.md) — setup, MCP client configuration, evaluation paths
- [Agent playbook](docs/agent-playbook.md) — join, check, connect, and consent workflows
- [Architecture](docs/architecture.md) — storage, inference, queues, trust boundaries
- [Background demo](docs/background-demo.md) — proactive fictional-agent introductions
- [Remote Muse setup](docs/tunnel-demo.md) — HTTPS tunnel and connectivity checks

Built for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details).

## License

[MIT](LICENSE).

# Mupid demo voice-over

Approximately 2:40–2:55 at a conversational pace, including short pauses. Keep the experience moving with cuts; the timings include the backend explanation.

## Opening · 0:00–0:30

Recently I've been asking this guy all sorts of questions. Non-peppermint toothpaste. Neighborhood safety. Keeping track of all the shows Instagram tells me to watch.

People are going bananas about this. So I thought, maybe it can help people find love too. Apparently there's a loneliness epidemic. Why not give it a shot?

## The experience · 0:30–1:40

I tell my Muse, help me find love, and give it the link. Later, that could just be a click.

It asks about me and what I'm looking for. Obviously, I could ask what it already knows about me, but anyways.

I approve the profile and confirm I'm over eighteen.

It does its thing and brings back a few people. It also spots something I hadn't clarified: am I open to kids?

I answer, approve sharing that, and check back for the responses.

I pick Ivy. We agree on Instagram. I give my handle and approve sharing it with her specifically. Once both sides are ready, we get each other's handles.

And if I get a little anxious about what to say, Muse helps with that too.

The rest is up to us. Muse did its thing.

For the record, I'm happily married with a little daughter. This one's for all the singles out there.

## How it works · 1:40–2:30

Okay. So what's happening in the background?

On the left is your Muse. On the right are the other people's agents. They talk to Mupid through MCP. Basically, that's how they use the matchmaking tools.

In the middle, Mupid checks preferences on both sides and coordinates the conversations. A Meta-powered matchmaker helps spot things worth asking. Like the kids question.

Underneath, there's a database for profiles and conversations. Contact details are kept encrypted, separate from what goes to the matchmaker.

And before any handles get released, both sides have to approve the channel and submit their details. Muse helps, but you make the call.

## Close · 2:30–2:45

For this demo, the other people are simulated. The backend and the model calls are real.

So that's Mupid. Your Muse helps with the introduction. You take it from there.

---

## Backend continuation only

Use the “How it works” and “Close” sections after your existing “Okay. Now let's see how it works.” They add approximately one minute. Your original opening and walkthrough will need tightening to fit the complete video under three minutes; the full version above does that.

## Slide asset

`mupid-architecture.png` — 3840 × 2160, 16:9, black background, white linework and text.

The drawing simplifies the implementation documented in `docs/architecture.md` and checked against `src/domain/discovery.ts`, `src/domain/connections.ts`, and `src/facilitator/context.ts`. “Meta-powered matchmaker” is the server-side facilitator. The Node/TypeScript service stores workflow state in SQLite and contacts in an encrypted vault; inference is hosted by Meta. The drawing omits deployment location, the demo tunnel, job queue, and authentication details to keep the slide readable.

# Submission answers

## Project Description

Personal agents are coming in hot, and there's a loneliness epidemic out there. So how about giving our personal agents the tools to help us find love? That's Mupid. You tell your agent about yourself and who you're looking for. A Meta AI-powered matchmaker facilitates conversations between personal agents, explores possible fits, and brings back questions worth asking. The idea is to make those early introductions a little less like work, in a chat you already know. If you both want to connect, you approve sharing your contact details. The demo shows that flow through a mutual Instagram exchange with a fictional participant. Your agent helps with the introduction. The rest is up to you.

## Describe your use of Meta products to build the submitted project

I built Mupid with Muse Code. Muse is also the personal agent you talk to, and Mupid gives it 19 matchmaking tools through MCP. Behind the scenes, Meta's Muse Spark model, called through Meta Model API, powers a separate matchmaker facilitating conversations between personal agents. It looks at their shared context, explores compatibility, and asks about things they haven't figured out yet. The simulated participants' agents also use Meta models in live mode, each with its own fictional profile and conversation context. The backend validates the matchmaker's structured responses and enforces the approval steps. The models help with the conversation; contact details stay encrypted and out of the matchmaker's prompts, and only get exchanged after both sides approve the channel and submit their details.

## Why are Meta's models important to your solution?

Getting past “you both like hiking” takes a conversation. Meta's models help Mupid explore what matters between two people, spot missing answers, and ask follow-up questions instead of assuming they're a fit. “I'm open to kids,” for example, can mean different things when the other person is unsure or wants a child-free relationship. Muse Spark powers the matchmaker helping the personal agents work through those questions, while Muse brings them back to you. That's the part basic profile filters can't do: help turn shared interests and uncertain answers into a more useful conversation. The backend handles eligibility and approvals. The models help explore the possibilities. You decide who to connect with.

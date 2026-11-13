# Tablamigo: Google Summer of Code project ideas

Hookstep plans to apply as a mentoring organisation for Google Summer of Code 2027. These are the project ideas for Tablamigo. Sizes follow GSoC's scale: 175 hours (medium) and 350 hours (large).

If one of them interests you, open an issue or comment on an existing one to start the conversation, and pick up a [`good first issue`](https://github.com/hookstep/tablamigo/issues?q=is%3Aopen+label%3A%22good+first+issue%22) first so we can work together on something small. You can also write to support@hookstep.in.

## Ideas

1. **Full internationalisation (175 h, medium).** Move every user-facing string in `apps/mobile` to a proper i18n library with plurals and interpolation, add a lint rule that blocks new literal strings, and ship two complete community translations. Skills: TypeScript, React Native.
2. **iOS build (350 h, hard).** The Expo app ships on Android and web only. Make it build and pass the existing tests on iOS: sign-in with Apple, push through APNs, location permissions, an App Store billing adapter behind the same interface as `play-billing.ts`. Skills: React Native, Expo, iOS.
3. **Offline-first plans and chat (350 h, hard).** Saved plans already work offline (`051_saved_plans_and_offline_sync.sql`). Extend that to a local store for nearby plans and chat with conflict-free sync when the phone comes back online, plus tests for flaky networks. Skills: TypeScript, SQLite, sync design.
4. **Moderation tools for community hosts (175 h, medium).** Reports already exist (`054_report_target_types.sql`, `lib/moderation.ts`). Build a host-facing moderation queue: review reports, mute, remove from a city chat, with an audit log and API tests. Skills: Fastify, Postgres, React Native.

## Proposing your own idea

Ideas not on this list are welcome. Open an issue describing the problem, who it helps, and a rough plan, and we'll help you shape it into a proposal.

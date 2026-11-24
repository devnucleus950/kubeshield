# KubeShield

Kubernetes runtime security platform. Building in phases; the Phase 1
spec is in docs/phase1.md. Read it before starting work.

## About the developer
Beginner with Kubernetes, Redis Streams and event pipelines.
Knows JavaScript, React, Next.js, Express. Learning TypeScript backends.

## Environment
Ubuntu Linux, bash, native Docker Engine (no Docker Desktop, no WSL).
Section 13 of docs/phase1.md covers Ubuntu pitfalls and fixes; it applies.
Everything else in the spec applies unchanged.

## Rules
- Work ONE step at a time from section 7 of docs/phase1.md.
- Before each step, explain the new concept in 3 to 5 plain sentences.
- Write only that step's files. Run its checkpoint and show real output.
- One git commit per step, then STOP and wait for me to say continue.
- Ask before adding any dependency not listed in section 3 of the spec.
- Never commit secrets. Keep .env.example current.
- Use 127.0.0.1 rather than localhost in URLs.
- Use `node --env-file=.env` to load config; do not add dotenv.
- If the spec seems wrong or unclear, say so instead of guessing.

## Progress
(Update this line after each step.) Setup (step 0) done. Steps done: none.

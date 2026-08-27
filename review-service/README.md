# Carpo durable Flue review service

This is a separately deployed, trusted QA Worker. It receives one frozen Carpo candidate package, runs a durable Flue agent against the isolated `carpo-pr-review` Worker, stores private screenshot/report evidence in `carpo-pr-review-evidence`, and exposes an authenticated Browser Run replay.

It intentionally does not expose arbitrary Code Mode, shell, repository, deployment, GitHub, or general network access to the model. GitHub is optional; the API and Queue contracts work without it.

The Durable service and local reviewer share `@carpo/review-contract` as their provider-neutral policy core. That workspace owns the v1 report schemas, positive route catalog, safe-action checks, proof challenges, completion criteria, coverage boundary, diagnostics verdict, and common reviewer instructions. The adapters own only their transport, browser, persistence, and provider integrations, so a safety or proof rule cannot silently drift between backends.

## Validate locally

From the repository root:

```bash
npm run review:service:test
npm run review:service:typecheck
npm run review:service:build
```

The production build uses Flue's Cloudflare target, the official Cloudflare Vite plugin, a generated SQLite Durable Object, Workers AI, Browser Run, R2, and an optional Queue consumer.

## One-time Cloudflare setup

Create the optional queue if it does not already exist:

```bash
npx wrangler queues create carpo-pr-review-events
```

Set these secrets from `review-service/` with `npx wrangler secret put <NAME>`:

- `AUDIT_API_TOKEN`: high-entropy bearer token used by the local runner and Queue/API clients.
- `REVIEW_VIEW_TOKEN`: separate high-entropy human viewer token for private reports and replay.
- `TARGET_REVIEW_AUTH_TOKEN`: stable token shared only with the isolated target Worker.
- `CLOUDFLARE_ACCOUNT_ID`: account containing the Browser Run sessions.
- `CLOUDFLARE_READ_TOKEN`: token scoped to Browser Rendering read access for finalized recording retrieval.

Set the exact same stable target token on the isolated Carpo Worker:

```bash
npx wrangler secret put PR_REVIEW_AUTH_TOKEN --env pr-review
```

Do not print, commit, or pass these tokens in URLs. The report login exchanges the viewer token for a Secure, HttpOnly, SameSite cookie.

Deploy only when explicitly authorized:

```bash
npm run review:service:deploy
```

## Run an exact-candidate review

Export the two local runner values without committing them:

```bash
export CARPO_REVIEW_SERVICE_TOKEN='<same value as AUDIT_API_TOKEN>'
export CARPO_PR_REVIEW_AUTH_TOKEN='<same value as both target review secrets>'
```

Then run:

```bash
npm run review:pr -- --pr <number> --agent-backend durable
```

The ordinary deterministic Browser Run remains the release signal. When it passes, the runner stages the frozen package for the optional Builds adapter, submits it to the durable service, waits for Flue settlement, downloads screenshots into the normal output directory, uploads the evidence through the existing R2 publisher, and adds a private report/replay link to the PR comment.

The proven local agent backend remains the default. Use `CARPO_PR_REVIEW_AGENT_BACKEND=durable` to make the durable service the default for your shell, or `--no-agentic` for deterministic-only review.

## Optional Workers Builds adapter

Create an account-level [Workers Builds event subscription](https://developers.cloudflare.com/workers/ci-cd/builds/event-subscriptions/) for `cf.workersBuilds.worker.build.succeeded` with `carpo-pr-review-events` as its Queue destination. The consumer accepts only the configured Cloudflare account, Worker name, and a full 40-character commit SHA. It then loads `durable-inputs/<sha>.json` from the evidence bucket and refuses a package whose frozen head differs from the event commit.

The Queue also accepts a compact `carpo.review.candidate-ready.v1` message containing only `headSha`, so another trusted Cloudflare trigger can dispatch the already-staged review without GitHub or exceeding Queue message limits. Missing staged input is acknowledged and ignored rather than reconstructed from mutable external state.

# Carpo launch entry rollout

The review candidate adds a public homepage, `/sign-in`, the private editor at `/create`, and `/auth/login` with a validated same-origin return destination. Old `/?video=...` and proposal handoffs still reach the editor. Session expiry pauses the existing workspace, unregisters WebMCP tools, and disconnects Ask Carpo. Signing in through a second tab preserves the same-account draft; switching accounts discards the old workspace and query cache. No writes are retried automatically after an auth redirect.

## Production change

`config/launch-access.json` is the reviewable desired configuration, not evidence of deployment. Save the current destination and cookie settings before changing them. Apply it to the **existing** Carpo Access application after deploying this candidate. Preserve its ID, audience, Google identity provider, instant authentication, 24-hour session duration, Google Allow policy, and Mac helper Service Auth policy. Replace the Worker-wide destination with the six public-hostname paths in the configuration. Do not retain the Worker destination: it protects the whole Worker, including the homepage and `/share/*`. Do not create a second identity application with a different audience.

The existing encoder callback application on `/api/internal/jobs/*` must remain in place. The new parent `/api` destination keeps private API routes protected, while the more-specific callback application preserves per-job callback delivery. `/share/*` needs no Access bypass after this change: it is outside the protected destinations and its Worker handler still checks the opaque token, expiry, and revocation. `/artifacts` remains private.

Disable Worker version preview URLs with the checked-in Wrangler setting before replacing the Worker-wide destination. Keep cookies HttpOnly and scoped to the whole host, so one sign-in covers `/auth`, `/api`, `/create`, and `/library`.

Observed on September 2: the dashboard's `Carpo Google users` policy includes Everyone and requires the Google login method. The application already supports first-time Google users; no policy expansion is needed. The local Wrangler credential cannot read this Access application (`403 auth.forbidden`), so this plan was grounded in the signed-in dashboard. The dashboard application ID is `22c933d3-c74a-4e27-b5a6-9d903f057911`. Do not use the API's empty list response as proof that the app is absent.

## Acceptance

Run `npm run check:launch-access` after deployment and the Access change. The read-only command requires an anonymous `200` homepage and sign-in page, a `404` invalid share page (not a login redirect), and authentication on every private route. It strips redirect query strings from its report.

Then use a fresh Google account session: sign in, upload a small owned MP4, create a clip, confirm playback and download, create a share, open it without authentication, and revoke it. Verify a different Google account has an empty library and cannot fetch the first account's video, clip, or artifact URL. Finally expire/logout the original session and confirm reauthentication resumes its draft only for the same account.

Local test identities and the encoder stub prove application routing and ownership, not Google OAuth or real production encoding. `npm run test:encoder` exercises the real encoder contract separately. The existing Flue reviewer requires a deployed version-bound PR-review candidate and cannot review an unstaged local checkout; run it after the review candidate is deployed to that isolated environment.

## Local evidence for review — September 2

- Branch: `feature/launch-ready-entry-flow`, based on `66a6293`, including the existing unstaged identity redesign. No commits, staging, pushes, deployments, or Access policy writes were performed.
- 253 backend tests and 180 frontend tests passed. The existing review publisher, runner, contract, agent, and service suites passed; the two new read-only Access-check tests passed. Repository typechecking and the frontend production build passed.
- New coverage checks signed JWT issuer/audience/expiry/signature, first-account provisioning, same-account draft recovery, account-change cache isolation, safe return destinations, upload auth failures, private artifacts, and anonymous share revocation. The account journey uses the encoder stub.
- A separate browser run used isolated local D1/R2 state and the real Docker encoder: the public entry reached Create, an 18-second uploaded sample produced a playable five-second H.264 clip, the library retained it, a separate browser opened its share, and revocation displayed the unavailable page. The downloaded output was probed as 5.000 seconds at 960×540. This local lane explicitly uses legacy authentication; it does not prove Google OAuth.
- Desktop and 390px mobile landing evidence, the visual reviewer’s `ship` report, output probe, and sanitized current-production reachability check are under `test-output/launch/`. The public-entry design record is `web/.impeccable/surfaces/public-entry.md`.
- The local Flue attempt stopped at the repository’s fixed hosted-target guard. The current hosted reachability check still fails for public pages because the production Access change remains unapplied. Fresh Google sign-in, logout/expiry, and hosted private/public separation remain required after rollout.

Rollback: restore the prior Worker-wide Access destination and cookie settings from the dashboard snapshot. This closes the public homepage/shares again while retaining private data protection. Roll back Worker code if needed; no schema migration is introduced by this change.

References: [Access paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/), [authorization cookies](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/), [current destinations API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/update/).

# Launch release verification — September 2, 2026

Hosted application evidence captured against commit 7a8585922ca03d762d2fd18ddc78076d6c3d70f9 on feature/launch-ready-entry-flow.
Base: 66a6293330f52ede8b6eab19533c48673b623f00.
Production Worker version at capture: 19a6e119-e27f-427b-87a9-23173194ec4e.
Private PR: https://github.com/dayhaysoos/carpo/pull/32

## Standards review

Two findings resolved: Library mode selection no longer submits its form; clean caption drafts adopt refreshed saved tracks while dirty drafts remain intact. No additional actionable findings in auth, shared proposal ownership, or deployment configuration.

## Requirements review

One finding resolved: shared portaled dialogs now hide, become inert, and pause active media when the session expires, retaining drafts for same-account recovery. Follow-up review found no defects in the canonical /api/auth/login endpoint and safe legacy redirect, which fit the dashboard's five-destination limit.

## Deterministic verification

254 API tests, 193 frontend tests, 12 review publisher tests, 38 review runner tests, 13 review contract tests, 39 browser-agent tests, 5 review-service tests, and 2 Access-check tests pass. Repository typecheck and builds pass. Staged launch changes passed redacted Gitleaks; GitHub's history scan also passed.

## Hosted browser evidence

Production native WebMCP discovered the active private QA source and accepted an explicit 0-5 second timestamp proposal without a transcript. Proposal output created no clips. The UI approval decision still left zero clips; the separate Create action produced exactly one clip. Native readClipWorkspace reported complete and returned private outputs.

Clip: dbd316a4-ee67-53fb-ac47-ba2488c4839b.
Source: f22bc62d-489a-43af-8991-7a47ef9d8411 (licensed Charge QA upload).
Downloaded/probed output: 5.000 seconds, H.264/AAC, 960x402, 850688 bytes.
The hosted caption suggestion also opened as unsaved; a manual correction was saved and export controls became available. Caption render completion is tracked in the local evidence directory.

A real Cloudflare sign-out caused a protected read to signal expiry; the workspace paused and native tool discovery returned no tools. Google SSO sign-in through /api/auth/login returned to the refresh page, then Check session again restored the original title draft. This was a fresh Carpo session with existing Google SSO, not a credential-empty incognito test or second-account test.

## Pending approvals

The existing Access form is prepared but unsaved. Automatic approval review rejected saving when its launcher must change to /create. Anonymous production remains behind the old Worker-wide Access gate. No attempt to bypass that rejection was made.

Automatic approval review also rejected visual QA because it requires explicit consent to send sampled private-upload frames to Cloudflare Workers AI. The original spoken QA fixture is prepared locally but has not been uploaded. Provider-based visual/transcript/Library acceptance awaits that consent.

The first dedicated hosted PR review stopped before app checks: five seconds after deployment, its browser location still observed the base Worker tag. The shared browser-review runtime now waits through up to sixteen initial identity reads, two seconds apart, but accepts only the expected tag. Authorization errors, malformed metadata, and changes to an already pinned version still fail immediately. Four new interface tests passed; the follow-up hosted review remains required. The repository remains private. License and publication are outside this pass.

## Evidence files

Local, ignored artifacts are in `test-output/launch-release/`: deployment logs, before/proposed Access snapshots, separate code-review outcomes, hosted proposal and completed-workspace JSON, session-expiry and playback screenshots, and the downloaded/probed MP4. Credentials and authentication URLs are not part of this report.

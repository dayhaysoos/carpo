# WebMCP Challenge verification

Historical local verification from September 2, 2026 (America/New_York), recorded
before the release commits on `feature/launch-ready-entry-flow`, based on
`66a6293330f52ede8b6eab19533c48673b623f00`. The observations and outstanding items
below describe that earlier snapshot. See [release verification](launch-release-verification.md)
for subsequent production evidence and current approval boundaries. This is not a submission claim.

## What works on the launch candidate

Native browser WebMCP calls were made through the in-app browser's WebMCP
capability, using tools actually registered by the page. Calls were not simulated
by invoking React handlers or by substituting API requests for WebMCP.

| Path | Evidence |
| --- | --- |
| Homepage discovery | Only `getCarpoInstructions` is exposed, with sign-in/source-selection guidance and no private workspace access. |
| Active source | Eight native tools discovered; `readClipWorkspace` returned the real source, revision, transcript availability, and existing clips. |
| No-transcript proposal | `proposeClips` with timestamp basis opened the shared review, with pending decision, WebMCP provenance, and `createdClipIds: []`. |
| Validation and retry | A stale revision and a range beyond the 18-second source were rejected; retrying the same valid request preserved one draft. |
| Human decision | UI approval alone left the clip count unchanged. The separate Create approved clip action created one clip. Rejecting a second draft and finishing review created none. |
| Encode and outputs | WebMCP reported the new clip complete and returned private MP4 and thumbnail URLs. The downloaded video is H.264/AAC, about five seconds long. |
| Caption proposal | WebMCP opened an unsaved/unrendered sound-caption suggestion. The UI's manual fallback remains available when transcription fails. |
| Caption save/render | A manual text correction survived saving; rendering became available and completed. WebMCP returned VTT, SRT, and captioned MP4 URLs. Downloads contain the corrected text; the captioned MP4 is 5.003 seconds, H.264/AAC. |
| Stale captions | Reusing the earlier saved revision was rejected with `Caption revision is stale`. |
| Library discovery | Native tools registered after navigation. Exact search returned an explicit empty result with coverage: zero searchable and two unavailable videos. This does not prove a successful result handoff. |

The source was the licensed 18-second Charge sample in `web/public/demo/charge.mp4`.
The successful new local clip is `5b5aff9c-ef11-595c-9a83-9488cb296be2` on video
`9c6caca2-0871-497a-994e-a2b385a94c07`. QA uses isolated
`.wrangler/launch-qa` storage and local legacy identity, not production Google auth.

Local evidence is ignored by Git under `test-output/launch/`:

- `webmcp-native-results.json`, `webmcp-final-checks.json`
- `webmcp-review-final.png`, `webmcp-caption-complete.png`
- `webmcp-opening.mp4`, `webmcp-opening-captioned.mp4`, `.vtt`, `.srt`
- `webmcp-caption-regression-red.log` and `webmcp-caption-regression-green.log`
- `webmcp-web-tests.log`, `webmcp-api-tests.log`, `webmcp-review-agent-tests.log`
- `webmcp-typecheck.log`, `webmcp-build.log`, `webmcp-flue-attempt.log`

Deterministic verification: 191 frontend tests, 253 API tests, and 35 browser-review
infrastructure tests passed, plus repository typecheck, frontend production build,
and diff whitespace validation. The caption regression failed before the fix and
passed afterward. Flue was attempted afterward but its existing guard accepts
only the dedicated hosted PR-review origin; no Flue verdict exists for this
unstaged localhost candidate. The guard was left intact.

## Fixes made in this pass

- Added explicit timestamp proposals without weakening transcript grounding or
  the shared Clip Proposal Review's range, idempotency, and human-approval rules.
- Exposed completed clip artifacts and caption exports through existing read tools.
- Registered getting-started instructions on the public landing page.
- Reported a failed transcript as unavailable even if an earlier checking result
  remains cached, so an agent is not told to wait forever.
- Fixed caption draft remounting on save: the saved server revision previously
  reapplied the original agent proposal, lost manual corrections, and kept exports
  disabled. The draft now stays mounted until the clip or incoming proposal changes.
- Kept review/approval controls visible while the preview and trim area scroll on
  shorter screens; clarified the caption-proposal fallback button.

## What remains unverified or blocked

1. **Hosted launch candidate and clean login.** The deployed app is the previous
   version. An unauthenticated HTTP request still redirects to Cloudflare Access.
   An existing authenticated browser session loaded the old app; that does not
   prove a clean Google sign-in. Deploy and perform the separate Access rollout in
   `launch-entry-rollout.md`, then repeat this journey in a clean browser before
   claiming the public candidate works.
2. **Real visual/semantic AI results and transcript acquisition on this candidate.**
   The local server's `--local` mode disables remote AI. Starting the normal dev
   proxy instead required Cloudflare Access service-token credentials. A clearly
   labeled private `charge-webmcp-qa.mp4` upload was accepted by the deployed app,
   and its no-speech transcription correctly produced no usable word timestamps.
   Native visual search on that upload was then blocked by automatic approval
   review because sampled private-upload frames would go to Cloudflare's AI
   provider without explicit payload/destination consent. No workaround was used.
   Approval is needed to run that exact hosted provider test. The QA upload remains
   private; no hosted clips or share links were created by this pass.
3. **Transcript/Library result handoffs.** Deterministic suites cover these paths,
   but this run's local sample has no transcript. Do not describe a successful
   native transcript-grounded or Library-result handoff as verified by this pass.
4. **Repository access and license.** GitHub reports `dayhaysoos/carpo` is private
   with no detectable license. The recorded GitHub Support history-cleanup gate
   (#4718475) needs confirmation before publication. License selection, publication,
   and final release approval are still owner decisions.
5. **Submission materials.** No video was recorded/uploaded, no Devpost submission
   was made, and no Submitted status was verified in this pass.

## Judge walkthrough for the final hosted candidate

Use this only after the hosted candidate and clean login have been verified.
Keep the licensed sample's attribution from `web/public/demo/README.md` with any
recording or distributed copy of its footage.

1. Open the live URL in a WebMCP-capable browser. Ask the agent to discover Carpo's
   tools and call `getCarpoInstructions`.
2. Sign in, open Create, and upload your video. The homepage podcast/action samples
   are curated demonstrations; they are not automatically imported private videos.
3. Ask: **“Use Carpo's WebMCP tools to propose the first five seconds as a clip
   titled Opening. This video may have no transcript. Leave it for me to review.”**
   The agent reads `readClipWorkspace`, retains the exact IDs/revision, and calls
   `proposeClips` with timestamp basis, empty block IDs, and a rationale.
4. Preview and adjust the draft, approve it, then choose Create approved clip.
   Ask the agent to read the workspace again and report the processing result and
   private download URL. Download/play the finished clip.
5. Optional: ask for an editable timed-caption suggestion appropriate to the source.
   Review and correct its text, save it, then render. Ask the agent to read the saved
   caption track and retrieve its VTT/SRT/captioned-video links.
6. For spoken content, use real returned transcript block IDs with transcript basis.
   For visible objects, use the visual instructions/search/review tools only after
   the provider test above has passed. Never claim timestamp selection performed
   visual understanding.

## A focused video under three minutes

- **0:00–0:20:** Show the source and explain: “Carpo turns moments from your videos
  into clips. WebMCP lets an agent work with the same timeline and review process
  that I use.”
- **0:20–1:00:** Show real tool discovery, workspace read, and a timestamp proposal
  on a video without a transcript. Explain that captions are optional.
- **1:00–1:45:** Preview, adjust, approve, create, and show the finished clip.
  Make the separate human decision visible.
- **1:45–2:25:** Show WebMCP reading the output; optionally demonstrate a caption
  correction and export if this remains quick. Cut waiting time honestly.
- **2:25–2:40:** Show the tool registration source and explain that WebMCP uses the
  same validation and human-review boundary as the app.

Record the final deployed version. This is an outline, not a completed video.

## Work added during the Submission Period

Carpo existed before the challenge. The repository's dated history identifies
the WebMCP additions; preserve these references in the submission description:

| Date | Commit | Addition |
| --- | --- | --- |
| August 28 | `0c9bbe0` | Browser WebMCP clip-proposal workflow |
| August 28 | `cc2ca5f` | Live WebMCP verification journey |
| August 29 | `49836a4` | Timed captions and WebMCP caption tools |
| August 29 | `4c4c891` | Private Library discovery |
| August 29 | `3acb485` | Sampled visual moment search |
| September 2 | Unstaged launch candidate | Public entry/auth work, real interface walkthrough, and the fixes recorded above |

See the [official rules](https://webmcp.devpost.com/rules). They require an accessible
working project, a public licensed repository, and a public YouTube demonstration
under three minutes. The supplied deadline notice specifies September 3 at 1 PM
Pacific (4 PM Eastern), with judging through September 21 at 5 PM Pacific. Freeze
the submitted repository/site/video at the deadline and keep the presented version
available throughout judging. Verify Devpost shows **Submitted**, not a draft.

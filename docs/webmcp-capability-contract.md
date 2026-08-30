# WebMCP capability contract

Carpo's built-in intelligence is optional. The manual UI, built-in Think assistant, and external WebMCP agents are adapters to the same provider-independent application capabilities. Think has no privileged domain access. Client parity means that the adapters share domain semantics and deterministic constraints; it does not mean that agents inherit the user's authority.

This document is the target capability contract, not a claim that every row is implemented today. A capability is complete only when the shared Carpo boundary exists and every required client can use it without duplicating domain logic.

See [ADR 0002](./adr/0002-keep-capabilities-independent-from-intelligence-provider.md) for the architectural decision and [Carpo's glossary](../CONTEXT.md) for canonical caption terminology.

## Purpose and source of truth

WebMCP is an app-native adapter into Carpo's existing workspace and Clip Proposal Review. It is not a replacement UI, a second agent experience, or an automation layer over Think's chat interface.

The user-visible Clip Proposal Review is the source of truth while a review is active. Agent chat and transient tool output are not authoritative product state. A proposal records its source video and transcript version, suggested ranges, title and presentation options, rationale, validation state, provenance, and review status. In accordance with [ADR 0001](./adr/0001-human-reviewed-clip-proposals.md), unfinished reviews are session-scoped today; durable proposal history is a separate future capability and must not be implied by the first WebMCP adapter.

## Initial WebMCP surface

The initial tool surface should remain small and typed. The exact names may change, but it should cover these responsibilities:

- `getCarpoInstructions`: explain the workspace, terminology, tool boundaries, and human-review requirement.
- `readClipWorkspace`: read the active video identity, readiness, transcript, caption state, and current Clip Proposal Review.
- `proposeClips`: create validated Clip Proposal drafts grounded in the current transcript and source video.
- `updateClipProposalDraft`: revise proposal fields without approving or creating a Clip.
- `getCarpoDocumentation`: return concise documentation for the exposed capabilities and their constraints.

The first implemented tracer bullet registers `getCarpoInstructions`, `readClipWorkspace`, and `proposeClips`. It shares the existing Clip Proposal Review with Think, binds proposals to the current video and a content-derived transcript revision, requires real overlapping transcript block IDs, preserves manual range corrections across idempotent retries, and leaves unsupported browsers on the normal manual interface. Draft revision and broader documentation tools remain future slices.

Clip Proposal Review owns provider-neutral admission for both Think and WebMCP: canonical proposal identity, shared title/range/quality/Overlay Text validation, frozen per-video batches, bounded FIFO review, idempotent retries, and pre-creation revalidation. Each adapter retains only its own translation and evidence rules; WebMCP therefore keeps workspace-revision and transcript-grounding checks without duplicating shared proposal policy.

Tools register in the browser only when the relevant authenticated Carpo workspace is available. They use the same authorization, validation, idempotency, and provider-independent application boundaries as the manual and Think adapters. Mutating tools return structured validation results and the resulting current proposal state.

Carpo does not initially expose an arbitrary JavaScript executor through WebMCP. Runme benefits from bounded JavaScript because a notebook is an open-ended document model; Carpo's narrower and more consequential media workflow is better served by typed capabilities.

## Client parity

`Required` means the adapter must support the capability. `Draft only` means an agent may prepare or revise user-reviewable state but may not commit the consequential action. `Not exposed` means the action remains exclusively in the user-controlled manual interface.

| Capability | Manual UI | Think | WebMCP |
| --- | --- | --- | --- |
| Inspect video identity, metadata, duration, and source readiness | Required | Required | Required |
| Inspect transcript and Source Caption availability | Required | Required | Required |
| Search for exact spoken words or phrases | Required | Required | Required |
| Find semantic moments grounded in real transcript blocks | Required | Required | Required |
| Find visible moments from bounded, revision-bound sampled frames | Required | Required | Required |
| Propose one or more clip ranges | Required | Required | Required |
| Edit trim range, title, quality, Overlay Text, and caption proposal options | Required | Draft only | Draft only |
| Preview Clip Proposals | Required | Required | Required |
| Approve or reject Clip Proposals | Required | Not exposed | Not exposed |
| Create approved Clips idempotently | Required | Not exposed | Not exposed |
| Inspect processing status and failures | Required | Required | Required |
| Retrieve finished video, thumbnail, GIF, and caption artifacts | Required | Required | Required |
| Import, generate, and edit a Timed Caption Track | Required | Draft only | Draft only |
| Configure and preview Themed Open Captions | Required | Draft only | Draft only |
| Render Themed Open Captions into an approved Clip | Required | Not exposed | Not exposed |
| Export Closed Caption Artifacts as WebVTT and SubRip | Required | Required | Required |

WebMCP tools expose structured Carpo capabilities; they do not reproduce or automate Think's chat interface. An external agent may choose tools and propose creative decisions, but Carpo remains responsible for enforcing timestamps, clip-duration limits, source readiness, authorization, idempotency, and review requirements.

## Caption outputs

Carpo maintains one editable Timed Caption Track from Source Captions, speech-to-text, or user-authored cues. Corrections belong to that track so regenerating an agent suggestion does not discard manual work. When producing a Clip, Carpo slices the applicable cues and rebases their timing to the Clip.

A user can select either, both, or neither of these outputs:

- **Themed Open Captions** are permanently rendered into the video. Themes may control typography, placement, colors, safe areas, line breaking, and active-word emphasis, but timing and rendering remain deterministic Carpo behavior.
- **Closed Caption Artifacts** remain separate and toggleable. WebVTT is the primary browser-playback format; WebVTT and SubRip downloads support publishing workflows such as YouTube.

Overlay Text remains a separate capability: it is one static message displayed for the full Clip, not a substitute for a Timed Caption Track.

## Human control

Agent-produced Clip Proposals and caption changes remain editable before Clip creation. The manual path must remain available when an agent makes a poor suggestion, and an agent integration must not bypass the review and safety boundaries described in [ADR 0001](./adr/0001-human-reviewed-clip-proposals.md).

In the initial contract, WebMCP and Think may inspect workspace state, propose creative decisions, and revise drafts. They may not approve a proposal, create or encode a Clip, render irreversible presentation changes, publish, or share artifacts. Those actions require an explicit user decision in the manual UI. A future expansion of agent authority requires a separate reviewed decision; it must not emerge accidentally by adding another tool.

## Provenance and reusable outcomes

Every agent-authored proposal mutation records, when available:

- the originating adapter and agent or provider identity;
- the source video, transcript, caption, and proposal revisions it used;
- the tool-contract version and timestamp;
- the proposed rationale and deterministic validation result.

Visual discovery evidence additionally records the uploaded source revision,
sample timestamps, private representative-frame identifiers, model confidence,
and uncertainty. Its tools must disclose that bounded frame sampling is not an
exhaustive claim about every frame in the video.

Carpo preserves the user's edits and final review outcome instead of replacing them when an agent regenerates a suggestion. Authorized future runs may use this durable product state as context, but Carpo does not require or preserve private chain-of-thought.

## Non-goals

The initial WebMCP integration does not:

- duplicate or automate Think's chat interface;
- grant an external agent approval, encoding, publishing, or sharing authority;
- expose arbitrary JavaScript execution or unrestricted application state;
- bypass deterministic timestamp, duration, readiness, authorization, idempotency, or review constraints;
- make WebMCP a prerequisite for the manual product experience.

## Acceptance criteria

The initial contract is satisfied when an unfamiliar authorized browser agent can:

1. Discover the tool purpose, terminology, and authority boundary without relying on DOM scraping.
2. Read the exact active workspace and the source revisions on which a proposal will depend.
3. Create and revise an editable Clip Proposal through the same deterministic constraints used by the other adapters.
4. Receive structured, actionable validation failures for invalid or stale inputs.
5. Observe the resulting session-scoped proposal and provenance in the manual UI.

The same verification must prove that the agent cannot approve, create, encode, publish, or share a Clip through the WebMCP surface; manual corrections survive agent regeneration; and the existing manual workflow remains usable when no agent is present.

## Design precedent

OpenAI's [Runme WebMCP case study](https://developers.openai.com/blog/automating-repetitive-work-at-openai-with-codex) demonstrates the useful general pattern: register a small browser-side capability surface for instructions, documentation, and bounded access to a shared artifact while retaining human approval boundaries. Carpo adopts that pattern with typed media-domain tools and Clip Proposal Review as its shared artifact rather than copying Runme's notebook-specific JavaScript interface.

## Extending Carpo

Before calling a new product capability complete:

1. Put the behavior behind a provider-independent Carpo boundary.
2. Preserve deterministic validation and authorization at that boundary.
3. Add or update the manual, Think, and WebMCP adapters.
4. Preserve manual correction and human review where an agent makes a proposal.
5. Update the parity table and verification coverage.

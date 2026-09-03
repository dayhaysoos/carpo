# Cloudflare Think for agentic video clipping

Research date: 2026-07-22. Sources are current, first-party Cloudflare documentation.

## Conclusion

**Think is a good fit for Carpo's conversational control plane, not its media-analysis engine.** It can provide the stateful chat, decide which Carpo tools to call, remember the conversation, stream progress, request approval, and recover interrupted turns. It does not, by itself, watch or listen to a video.

The example request — “clip every time the word `code` is said” — is nevertheless very feasible. Carpo would extract the source audio, transcribe it once with word timestamps, find exact matches deterministically, and create one clip for each accepted range. Think would orchestrate and explain that pipeline.

## What Think provides (verified)

- `@cloudflare/think` is an opinionated harness on the Agents SDK. A subclass supplies a model; Think owns the agent loop, tool calls and results, message persistence, WebSocket streaming, stream resumption, client tools, and durable recovery. Each agent instance is backed by Durable Object SQLite. A React client connects with `useAgent()` and `useAgentChat()`. [Think overview](https://developers.cloudflare.com/agents/harnesses/think/)
- Think supports server-side custom tools through `getTools()`. These are standard AI SDK tools with Zod input schemas; Cloudflare's example calls an HTTP API with `fetch()`. Tools can use `needsApproval` to pause for user confirmation. [Think tools](https://developers.cloudflare.com/agents/harnesses/think/tools/)
- Think's Session storage includes tree-structured messages, persistent context blocks, compaction, branching, and full-text search. This is useful for conversation state, preferences, and job references; it is not where large video/audio objects should live. [Think overview](https://developers.cloudflare.com/agents/harnesses/think/)
- `runTurn({ mode: "submit" })` / `submitMessages()` provides idempotent, durable acceptance for work that should acknowledge quickly and finish later. Think also integrates with Cloudflare Workflows for durable multi-step jobs and retryable side effects. [Think turn APIs](https://developers.cloudflare.com/agents/harnesses/think/), [Think Workflows](https://developers.cloudflare.com/agents/harnesses/think/workflows/)
- Cloudflare recommends Agents for real-time communication and quick API calls, and Agent + Workflow for processing over 30 seconds, multi-step pipelines, and approval flows. [Agents with Workflows](https://developers.cloudflare.com/agents/runtime/execution/run-workflows/)
- Agent invocations have 30 seconds of active CPU, while time spent awaiting I/O or a model does not count as active CPU. Each agent has up to 1 GB of state. [Agents limits](https://developers.cloudflare.com/agents/platform/limits/)
- Some Think surfaces relevant here are marked **experimental**: `runTurn()` is stable in shape but may evolve, and the Actions API may also change. [Think turn APIs](https://developers.cloudflare.com/agents/harnesses/think/), [Think Actions](https://developers.cloudflare.com/agents/harnesses/think/actions/)

## What Think does not provide

The documented Think harness has no built-in video/audio ingestion or media-understanding step. Browser tools inspect pages and screenshots; they are not a substitute for processing a source video's audio or frames. Any claim that Think itself can “watch the video” would overstate the product.

Think can call a tool that performs media analysis, then reason over its structured result. That distinction matters: the agent chooses and coordinates actions, while a deterministic Carpo pipeline handles bytes, timestamps, and renders.

For visually defined requests such as “clip every time the logo appears,” Carpo would need a separate frame-sampling/scene-analysis tool. That is a later capability and is not required for spoken-word clipping.

## The spoken-word path is unusually strong

Cloudflare Workers AI offers `@cf/openai/whisper-large-v3-turbo` for automatic speech recognition. Its documented response includes:

- transcript text;
- segments with start/end times;
- individual words with start/end times; and
- WebVTT output.

It is batch-capable and currently listed at $0.00051 per audio minute. [Whisper Large v3 Turbo model](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/)

Cloudflare also publishes a tutorial for transcribing large audio inputs in chunks to address Worker memory and execution constraints. [Whisper chunking tutorial](https://developers.cloudflare.com/workers-ai/guides/tutorials/build-a-workers-ai-whisper-with-chunking/)

Word timestamps mean the LLM should **not** be asked to guess where `code` occurred. Normal code can normalize punctuation/case, select each matching word, add configurable lead-in/lead-out, merge overlapping ranges, keep every range inside the source duration, and produce a reviewable list. That makes results repeatable and testable.

## Recommended Carpo architecture

```text
User chat
   -> Think agent
      -> analyzeVideo(videoId)             [starts/reuses durable workflow]
         -> acquire source audio
         -> create valid time-based audio chunks
         -> Workers AI transcription
         -> persist timestamped transcript by source video
      -> findSpokenMatches(videoId, phrase, padding)
         -> return proposed ranges
      -> user reviews / approves
      -> createClips(videoId, ranges)
         -> existing Carpo clip jobs
      -> report clip status and links in chat
```

The heavyweight pipeline should be a Workflow or existing encoder job, not an open Think turn. Video/audio stays in R2 or the existing source/encoder path; transcripts, analysis status, and match ranges belong to Carpo's video data model. Analyze each source once and reuse the transcript for later instructions.

Think should receive narrow, authenticated tools rather than general internal access:

- `getVideo(videoId)`
- `analyzeVideo(videoId)`
- `getTranscriptStatus(videoId)`
- `findSpokenMatches(videoId, phrase, beforeSeconds, afterSeconds)`
- `createClips(videoId, ranges)`
- `getClipJobs(ids)`

Those tools can call Carpo's Worker handlers or shared service functions. The existing `POST /api/videos/:videoId/clips` route is already the natural final action for each range; the new work is transcript acquisition/storage and a batch-safe tool boundary.

## Product slice to build first

1. Add transcript generation for one reusable source video and store word timestamps.
2. Add deterministic exact word/phrase matching with padding and range merging.
3. Expose “find matches” and “create clips” as server-side tools.
4. Put a Think chat on the video page, scoped to that video.
5. Return proposed clips first, with one **Create all clips** approval action.
6. Run creation in the background and stream/poll status into the conversation.

This slice proves the valuable behavior without pretending the agent has general visual understanding. Later iterations can add semantic transcript requests (“find the section where pricing is explained”), scene/frame analysis, caption generation, aspect-ratio reframing, and multi-step editing.

## Important implementation cautions

- A YouTube source still has to be acquired before transcription; Think does not solve YouTube delivery/rate-limit problems.
- Production audio chunking should create valid, time-indexed media chunks (with controlled overlap), not merely split compressed file bytes. Chunk offsets must be added back to returned timestamps and overlapping words deduplicated.
- ASR is probabilistic. Exact-match results need a preview and confidence-aware UX, especially for names, homophones, crosstalk, and noisy audio.
- Batch clip creation needs idempotency and bounded concurrency so a phrase repeated 100 times does not accidentally produce duplicate or overwhelming work.
- Require user confirmation before a tool creates many clips. Think's approval mechanism supports this, but Carpo should also enforce authorization and limits at its API boundary.

## Recommendation

Adopt Think only after proving the transcript-to-ranges tool independently. The tool is the durable product capability; Think then becomes a compelling, relatively thin interface over it. If Think's experimental API changes, Carpo's transcription, matching, and clip creation remain intact.

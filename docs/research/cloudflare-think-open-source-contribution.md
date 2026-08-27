# Is Cloudflare Think open source, and should Carpo contribute video understanding?

_Research date: 2026-07-22_

## Short answer

Yes. `@cloudflare/think` is published from the public [`cloudflare/agents`](https://github.com/cloudflare/agents) monorepo, its source lives under [`packages/think`](https://github.com/cloudflare/agents/tree/main/packages/think), and both the repository and package declare the [MIT License](https://github.com/cloudflare/agents/blob/main/LICENSE). The current npm release is `0.14.0`, which also identifies the same repository and MIT license in its [package metadata](https://github.com/cloudflare/agents/blob/main/packages/think/package.json).

However, open-source licensing is not the same thing as an open contribution queue. Cloudflare's current repository README says it is **not accepting external pull requests at this time** because the SDK is evolving quickly; it directs bug reports and feature requests to [Issues](https://github.com/cloudflare/agents/issues) and ideas/questions to [Discussions](https://github.com/cloudflare/agents/discussions). See the repository's [Contributing section](https://github.com/cloudflare/agents#contributing).

So Carpo can legally fork, extend, and publish MIT-licensed work, but the appropriate upstream move today is a focused issue or discussion—not an unsolicited implementation PR.

## Think already has a visual foundation

Think is not text-only anymore. Its built-in workspace `read` tool can pass images and PDFs to multimodal models, according to the current [Think tools documentation](https://github.com/cloudflare/agents/blob/main/docs/think/tools.md#built-in-workspace-tools). Cloudflare added this in merged PR [#1435, “Add multimodal workspace read support”](https://github.com/cloudflare/agents/pull/1435), which keeps persisted tool results compact and rehydrates image or PDF bytes when preparing model input.

There is also an open broader request, [#1392, “Memory: support multimodal content”](https://github.com/cloudflare/agents/issues/1392), covering files, images, audio, PDFs, generated artifacts, and derived text. The active Think roadmap explicitly treats multimodal memory as a separate follow-up after image/PDF workspace reads; it does not list full-video understanding as a core Think feature ([roadmap issue #1439](https://github.com/cloudflare/agents/issues/1439)).

Workers AI supplies useful primitives for a video-analysis pipeline: its current [model catalog](https://developers.cloudflare.com/workers-ai/models/) includes automatic speech recognition, object detection, and vision/image models. For example, [Kimi K2.6](https://developers.cloudflare.com/ai/models/%40cf/moonshotai/kimi-k2.6/) accepts image inputs alongside text. The catalog does not document a Cloudflare-hosted model that accepts an entire video as one native input; assembling video understanding from audio plus sampled frames is therefore the practical path today.

## What belongs in Think versus Carpo

Think's documented role is the agent harness: model turns, memory, tool selection, persistence, streaming, and recovery. It intentionally supports application-specific capabilities through custom server tools in [`getTools()`](https://developers.cloudflare.com/agents/harnesses/think/tools/#custom-tools). That makes Carpo's video analysis an excellent **tool used by Think**, but a poor fit as hard-coded Think core behavior.

The Carpo-specific pipeline should remain in Carpo:

1. Acquire the source and extract audio/frames.
2. Transcribe speech and preserve word-level timestamps.
3. Sample frames or scenes and run image/vision inference.
4. Turn detections into timestamp ranges.
5. Preview, approve, and create clips through Carpo's encoder.
6. Cache transcripts, frame observations, and clip plans against the source video.

Putting FFmpeg or YouTube acquisition directly inside Think would also conflict with the Agents repository's own contributor boundary: Workers code must avoid native/FFI dependencies, according to its public [`AGENTS.md`](https://github.com/cloudflare/agents/blob/main/AGENTS.md). Think can call a typed tool, service binding, Agent, or Workflow that performs the media work elsewhere.

## A contribution that could fit upstream

A good upstream proposal would be narrower and generic rather than “add Carpo to Think”:

- A documented **time-indexed media artifact** convention: an R2-backed asset plus transcript, sampled-frame references, timestamps, and derived observations.
- A reusable tool/result shape that lets an agent request ranges or frames without persisting large binary payloads in chat history.
- A reference example showing Think + Workflows + R2 + Workers AI for durable audio transcription and sampled-frame analysis.
- Multimodal-memory hooks that let applications register derived media text and image references, contributing to the existing scope of issue [#1392](https://github.com/cloudflare/agents/issues/1392).

The strongest evidence would come from Carpo first: build the pipeline as narrow Think tools, measure it on real videos, then publish the generic seam and limitations in an issue/discussion. That gives Cloudflare a concrete use case and avoids asking the harness to own media decoding, provider-specific video acquisition, or clip-domain policy.

## Recommended next move

1. Build a small Carpo tracer bullet: “find every time this logo appears” using scene/frame sampling, a vision model, timestamped proposals, and approved clip creation.
2. Keep the tool contract generic enough to separate `analyzeMedia` from `createCarpoClips`.
3. Once it works, open a Cloudflare Agents discussion or feature issue linking the working architecture and propose the generic media-artifact/tool seam.
4. Do not begin with a fork of Think. Fork only if Carpo needs a core harness change that cannot be expressed through `getTools()`, Actions, Workflows, or existing multimodal workspace reads.

This route lets Carpo benefit immediately while producing contribution-quality evidence. If Cloudflare later reopens external PRs, the reusable tool shape or reference example would be a much stronger candidate than the full video pipeline.

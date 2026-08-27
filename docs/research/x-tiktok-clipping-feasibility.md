# X/Twitter and TikTok clipping feasibility

Research date: 2026-07-22

## Bottom line

Carpo can technically download and clip public X and TikTok videos with its existing yt-dlp/FFmpeg encoder. yt-dlp ships extractors for both [TikTok](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md#L1641) and [Twitter/X](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md#L1726). A proof-of-concept is small. A product-quality implementation is not: Carpo currently treats “remote video” as synonymous with YouTube throughout its database, API, UI, metadata resolver, preview player, encoder errors, and tests.

My recommendation is **TikTok first, X second, using an ingest-once remote-source model**. Download the source into R2 once, then preview and create every subsequent clip from that stored original. This makes the source durable like uploaded videos, gives both providers the same native player/precision controls, and avoids repeatedly scraping the provider for every clip.

There is a separate go/no-go issue: both platforms' current terms expressly restrict automated extraction. That does not make the implementation technically impossible, but it makes arbitrary-public-URL downloading a risky product foundation. This needs a product/legal decision before it becomes a marketed feature.

## What Carpo can reuse

- The FFmpeg trim, scale, caption, thumbnail, GIF, artifact upload, and job-status pipeline is provider-neutral once a local source file exists.
- The yt-dlp process supervision, progress parsing, timeout/stall handling, section-download fallback, and format selector are reusable after removing YouTube-specific names and messages.
- `source_videos` already groups many clips under one reusable source and cascades source deletion to clips/artifacts at the application layer.
- The library/project UI and native uploaded-video player already represent the desired post-ingestion experience.
- The large encoder contract suite provides good scaffolding for deterministic provider failure and trim tests.

## Required refactors

### 1. Make remote providers first-class

Today `SourceType`, `ClipSource`, both D1 `CHECK` constraints, URL validation, serialization, routes, helper reconstruction, and frontend types only allow `youtube | upload`. Adding `x | tiktok` everywhere would work, but would repeat the same provider branching problem.

A more durable seam is a generic remote source carrying `provider`, `canonicalUrl`, and `externalId`, while keeping uploaded objects separate. At minimum, each provider needs:

- strict URL parsing and canonicalization;
- a stable source reference for deduplication;
- provider-neutral title, thumbnail, duration, and metadata-resolution fields;
- explicit media selection rules.

X posts can contain multiple videos or quoted-post media. The product must either choose a specific media index, present a chooser, or reject ambiguity. TikTok photo/slideshow posts should be rejected as unsupported until Carpo deliberately supports them.

### 2. Split acquisition from clipping

The current encoder downloads a padded YouTube section for each clip. For X/TikTok, create a source-ingestion job that:

1. probes the URL with yt-dlp and records canonical metadata;
2. downloads the full source once;
3. stores the original in R2;
4. marks the source ready;
5. sends later clip jobs through the existing upload/native-file path.

This costs more storage up front but removes repeated provider requests, allows reliable re-clipping, and gives X a workable precise-trim experience. Storage lifecycle should be explicit: archived sources remain stored; only explicit deletion removes the original and clips, matching Carpo's current product decision.

### 3. Generalize the encoder boundary

`container/encoder.py` currently accepts only `youtube`, `upload`, and test `file` sources. Its remote runner, timeouts, classifiers, and user-facing failures are all named or worded as YouTube behavior. Refactor those into provider-aware acquisition failures such as `login_required`, `private`, `geo_or_ip_blocked`, `rate_limited`, `unsupported_media`, and `provider_changed`.

Keep the PO-token and Mac-helper paths YouTube-only. They do not apply to X or TikTok.

TikTok's current yt-dlp extractor makes impersonated webpage requests and handles JavaScript challenges. yt-dlp documents `curl_cffi` as the recommended browser-impersonation dependency and installs it through `yt-dlp[default,curl-cffi]`; Carpo currently installs only `yt-dlp[default]`. The container therefore needs that extra and an image-size/security review. [yt-dlp dependency documentation](https://github.com/yt-dlp/yt-dlp#dependencies), [TikTok extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py#L1352)

### 4. Add provider-appropriate preview UX

TikTok has an official Embed Player with `play`, `pause`, and `seekTo`, plus current-time and duration events. It could support a YouTube-like first-run editor before ingestion completes. [TikTok Embed Player](https://developers.tiktok.com/doc/embed-player?enter_method=left_navigation)

X's official embedded-post product displays post media but its documented interface does not expose equivalent seek/current-time controls. [X Embedded Posts](https://docs.x.com/x-for-websites/embedded-posts/overview) An X embed beside manual time fields would be a weak editor. Ingesting first and then using Carpo's native video player is the better UX and can become the common behavior for both providers.

### 5. Move metadata into ingestion

YouTube titles are currently resolved separately with YouTube oEmbed and stored in YouTube-specific columns. yt-dlp already returns title/description/uploader, duration, thumbnails, formats, and stable IDs for X and TikTok. Capture that probe result once during ingestion and store provider-neutral metadata. Do not depend on expiring third-party thumbnail URLs; copy the selected thumbnail to R2 or generate one from the stored source.

## Reliability and operations

An extractor being listed by yt-dlp is not an availability guarantee; yt-dlp itself says websites change and the only reliable check is to try them. [Supported-sites warning](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md#L244-L246)

### TikTok

- The extractor handles short URLs, device/app identifiers, cookies, login redirects, challenges, private content, and IP blocking. That is evidence of active anti-automation complexity, not a stable API contract. [TikTok extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py)
- Browser impersonation is likely required in the production image.
- Sound availability, region-dependent results, 403s, and extractor/challenge churn are active failure classes in the official tracker. Representative reports: [403 on some videos](https://github.com/yt-dlp/yt-dlp/issues/9789), [intermittent missing audio](https://github.com/yt-dlp/yt-dlp/issues/16622).
- Passing locally does not prove Cloudflare-container egress will work; production-region canaries are required.

### X/Twitter

- yt-dlp accepts both `twitter.com` and `x.com` status URLs and offers GraphQL, legacy, and syndication extraction modes. Syndication is a fallback with reduced metadata/media coverage. [yt-dlp extractor arguments](https://github.com/yt-dlp/yt-dlp#extractor-arguments)
- Guest-token/rate-limit behavior and protected or sensitive posts create provider-specific failures. Cookie-based login should not be treated as a dependable product contract.
- Quoted posts and multiple media entries require deterministic selection. Current tracker examples include [protected-post failures despite cookies](https://github.com/yt-dlp/yt-dlp/issues/17243) and [quoted-post media selection](https://github.com/yt-dlp/yt-dlp/issues/14664).

For either provider, avoid a shared browser-cookie account in production. It creates account-security, consent, lockout, and cross-user data risks. Proxies can redistribute egress failures but do not create a stable or policy-compliant API; adding them would increase cost and abuse surface.

## Platform and rights constraints

This is a product/legal risk summary, not legal advice.

- X's current terms prohibit crawling or scraping without prior written consent and prohibit bypassing security or authentication measures. [X Terms of Service](https://x.com/en/tos)
- TikTok's current US terms prohibit automated scraping, crawling, exporting, or extracting platform data/content without written approval, and separately restrict commercial use of another user's content without permission. [TikTok Terms of Service](https://t.tiktok.com/legal/page/us/terms-of-service/en)
- User consent to Carpo's terms does not prove that the user owns a pasted post or its music, likeness, or underlying footage.

TikTok does offer a more defensible owner-authorized metadata path: its Display API's video-query endpoint requires an authorized user's token, verifies that requested videos belong to that user, and returns title, duration, cover, and embed fields. It does **not** document a downloadable original-media URL. [TikTok Query Videos](https://developers.tiktok.com/doc/tiktok-api-v2-video-query?enter_method=left_navigation) Therefore “connect TikTok, verify ownership, then upload the original” is policy-safer and more reliable, but it does not provide paste-any-URL clipping.

## Test plan

- Unit: accepted hosts/path shapes, short-link resolution, canonical IDs, deduplication, malicious/irrelevant URL rejection.
- Metadata: title/duration/thumbnail persistence, expiring thumbnail replacement, posts with multiple media, quoted X posts, TikTok photo posts.
- Encoder contracts per provider: public success, no video, private/login required, 403, 429, geo/IP block, silent stall, redirect, missing audio, vertical video, HLS/direct MP4, and exact trim duration.
- Frontend: ingest states, retryable vs terminal failures, native-player readiness and seeking, creation of multiple clips from one stored source.
- Scheduled production canaries: a few stable public URLs per provider, executed from the same Cloudflare deployment/egress as real jobs. Keep these out of the deterministic PR test suite.

## Rough effort

Assuming one engineer familiar with Carpo, and excluding OAuth/app-review/legal lead time:

| Slice | Estimate | What it proves |
| --- | ---: | --- |
| Disposable encoder spike | 1–2 days | Current container can probe/download representative public X and TikTok URLs from Cloudflare egress |
| Generic remote-source + ingest-to-R2 foundation | 4–7 days | Durable originals, provider-neutral metadata/errors, native preview, reusable clips |
| TikTok product slice | 3–5 additional days | Validation, short URLs, edge cases, UI copy, contract tests, canaries |
| X product slice | 4–7 additional days | Media selection, quoted posts, ingest UX, provider failures, tests/canaries |
| Operational hardening | 3–7 additional days | Monitoring, regression canaries, retry/backoff, storage cleanup, support diagnostics |

So: **a spike is small; both providers as a credible product feature are roughly 3–5 engineering weeks**, with X the harder UX and TikTok the harder anti-bot/runtime dependency. That estimate does not remove the possibility that platform changes break acquisition later.

## Recommended sequence

1. Make an explicit product decision between arbitrary public URLs and owner-authorized sources. Do not let a successful yt-dlp spike silently decide the policy.
2. Run a no-UI spike against a test matrix from the deployed encoder, including `curl_cffi`, audio verification, and full-source download. Stop if Cloudflare egress is broadly blocked.
3. Build the generic ingest-once source boundary and provider-neutral metadata/error model.
4. Ship TikTok first: its official controllable embed can optionally improve the ingest wait, and its single-post model is simpler.
5. Ship X second using the stored original/native player; explicitly handle multiple/quoted media.
6. Keep upload as the guaranteed fallback and label remote acquisition as best-effort unless/until there is an approved official access arrangement.

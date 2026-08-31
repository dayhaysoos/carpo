# Creator workspace visual baseline

Issue: [#30 — Redesign Carpo as a source-centered creator workspace](https://github.com/dayhaysoos/carpo/issues/30)

Decision date: 2026-08-30

## Accepted direction

Variant A, **Clip production line**, is the accepted visual specification for Carpo's creator workspace. It optimizes for producing many clips from one source rather than for long-form, multi-track editing.

The primary source is [`CreatorPage.visual-prototype.html`](../../../web/src/pages/CreatorPage.visual-prototype.html). Open it with `?variant=rundown&state=ready`; the supported prototype states are `ready`, `importing`, `blocked`, `rendering`, and `complete`.

This is deliberately throwaway prototype code. Production work must rewrite the accepted design as tested React components instead of promoting this file directly.

## Design invariants

- Identify the active source once in the top ribbon.
- Keep the desktop workspace split into a left clip builder, center moment workspace, and right clip queue.
- Keep the builder limited to clip inputs and the Create button; communicate readiness through the button instead of explanatory prose.
- Do not add decorative status pills, including a "Private copy ready" pill.
- Make "Choose another video" visibly actionable.
- Keep clip rows compact, with a frame thumbnail, title, duration, and visible status.
- Preview a selected clip over the center workspace without expanding its queue row.
- Put retry and source-file recovery on the affected blocked clip.
- Keep Ask Carpo secondary and summonable. Manual clipping remains complete without it.
- Preserve validation, ownership, authorization, clipping, proposal, and recoverable manual-correction rules.

## Canonical evidence

| View | Evidence |
| --- | --- |
| Ready desktop | [creator-workspace-ready-desktop.png](./creator-workspace-ready-desktop.png) |
| Importing desktop | [creator-workspace-importing-desktop.png](./creator-workspace-importing-desktop.png) |
| Blocked desktop | [creator-workspace-blocked-desktop.png](./creator-workspace-blocked-desktop.png) |
| Blocked recovery | [creator-workspace-blocked-retry-desktop.png](./creator-workspace-blocked-retry-desktop.png) |
| Rendering desktop | [creator-workspace-rendering-desktop.png](./creator-workspace-rendering-desktop.png) |
| Complete clip preview | [creator-workspace-complete-desktop.png](./creator-workspace-complete-desktop.png) |
| Ready clip preview | [creator-workspace-clip-preview-desktop.png](./creator-workspace-clip-preview-desktop.png) |
| Ask Carpo open | [creator-workspace-ask-carpo-desktop.png](./creator-workspace-ask-carpo-desktop.png) |
| Ready mobile | [creator-workspace-ready-mobile.png](./creator-workspace-ready-mobile.png) |

The screenshots are part of the baseline because the prototype uses externally hosted fonts and video frames that may change independently of this branch.

## Production styling decision

Use StyleX for the creator-workspace rewrite, introduced as a bounded migration rather than a repository-wide styling conversion. Keep global resets, fonts, native elements, and unmigrated screens in the existing global stylesheet. Start by proving the StyleX Vite build path on the active-source ribbon, then implement the three-region workspace in bounded slices.

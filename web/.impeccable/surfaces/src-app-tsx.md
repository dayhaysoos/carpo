# Carpo Authenticated App Surfaces

This brief records how the approved Carpo identity is expressed across the authenticated React app. The global design system lives in `web/DESIGN.md`; this file owns composition that is specific to these surfaces and must not be promoted into universal component rules.

## Shared shell

- A 70px carbon header carries the square Carpo mark, centered Create/Library navigation, and compact account actions.
- Saira Condensed supplies product identity, navigation, headings, and button labels. Atkinson Hyperlegible Next supplies readable operational copy. Atkinson Hyperlegible Mono supplies time and metadata.
- The active navigation destination is marked by vermilion, not a pill.
- Every surface establishes its active source before presenting that source's clips or controls.
- Manual operation remains the complete path. Ask Carpo and WebMCP are optional adapters to the same capabilities and must not obscure correction or recovery.

## Creator: production bench

Creator is the densest surface and may use the warm workbench-rose tone. Its wide layout is a three-zone bench:

1. A narrow builder for title, overlay, quality, errors, recovery, and the single Create clip action.
2. A dominant source stage for the video, trim controls, transcript, and proposal review.
3. A compact reel for thumbnail-first clip output and state.

The active-source ribbon spans the workspace once; do not repeat the source in the builder. Clip rows remain small and scannable. Status is communicated beside the output. Ask Carpo stays secondary and may overlay the bench without replacing its controls.

## Library: source contact sheet

Library is more breathable than Creator. Transcript search and Videos/Archived navigation precede a source-organized poster grid. Each source card uses an unobstructed thumbnail first, followed by title, clip count, and restrained metadata. Source-level overflow actions remain distinct from the primary card target.

On mobile, source cards become compact media-left rows. Preserve search, the active section, source identity, and a touch-sized primary target.

## Video detail: source mast and clip sheet

Video detail opens with a wide source mast that binds poster, source title, origin, and source-level Create/Archive/Delete actions. The clip-management sheet follows that mast; it does not visually compete with the source.

Desktop clip cards may expose the full management action strip. Mobile cards convert to media-left rows and a visible action grid. Play, captions, share/export, download, GIF, delete, and selection must never require horizontal scrolling. Every target remains at least 44px tall.

## Clip viewer: cinematic exception

The clip viewer is a temporary media-dominant overlay with a dark scrim, vermilion top rule, explicit close control, and previous/next sequence controls. Its viewer shadow and near-full-width mobile sheet are deliberate exceptions to the otherwise flat system. Do not reuse this elevated treatment as the default modal or card style.

## Responsive rules

- Compact before removing: supporting metadata yields before source identity or primary actions.
- Stack workspace regions when their tasks no longer fit side by side.
- Convert management cards to media-left rows on mobile.
- Wrap essential controls into visible grids instead of horizontal action rails.
- Respect reduced-motion preferences; no product meaning may depend on animation.

## Verification record

The production implementation was checked against real local Carpo data on desktop and mobile for Creator, Library, video detail, and the clip viewer. The implemented surfaces showed no page-wide horizontal overflow or browser console errors. Deterministic verification covered the complete repository test suite, typecheck, production builds, and the PR browser-selector contract.

The visual browser pass did not exhaustively walk every empty, loading, archived, bulk-select, upload-entry, Ask Carpo-open, or secondary-dialog state. Those states inherit the shared tokens and component rules, but should receive focused browser evidence when future work changes them.

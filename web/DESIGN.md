# Creator Workspace Visual System

This document records the accepted Issue #30 creator workspace (`issue-30-clip-production-line`). It is a preservation guide for the current product and visual decisions, not a proposal for a different editor.

## Product and visual thesis

Carpo is a clip production line for making many clips from one source. It is not a traditional long-form editor, a multitrack timeline, or a dashboard of unrelated cards.

The workspace tells one continuous story: choose one private source, mark a moment, create a clip, and repeat while completed and in-progress clips accumulate beside the same source. The manual workflow is primary. Ask Carpo is an optional overlay on that workflow, not a replacement for it.

The visual world is a near-black and olive production bench:

- Flat work surfaces and fine rules establish structure; cards are not the default container.
- Restrained amber marks production actions and the current selection.
- Blue is reserved for time references such as transcript timestamps.
- Compact film-strip details and clip rows make the source-to-output relationship visible.
- Off-white type, accessible typefaces, and explicit focus rings carry most of the hierarchy.
- Corners are mostly square on work surfaces and inputs. Small 6–8px radii are reserved for controls and overlays; oversized pills are absent from the main workflow.
- Shadows belong to media and temporary overlays, not every section.

## Layout hierarchy

The application header sits above the workspace. The active-source ribbon spans the full width immediately below it, followed by a three-zone desktop workspace:

1. **Builder — “New clip.”** A narrow left column holds the clip title, optional overlay text, quality, errors/recovery, and the full-width Create clip action.
2. **Stage — “Mark a moment.”** The flexible center column is dominant. It contains the 16:9 source viewer, trim controls, and transcript. Selecting a reel item opens its preview over this stage.
3. **Reel — “Clips.”** A narrow right column contains dense, newest-first clip rows with thumbnail, title, duration, and processing state.

At full desktop width the columns are approximately `286–310px / flexible / 238–276px`. Below 1080px they tighten to `260px / flexible / 260px`. The desktop workspace fills the remaining viewport below the 70px header and 76px source ribbon, with each zone able to scroll independently.

The source ribbon is a persistent identity strip, not another card. Its edge perforations, thumbnail, truncated title, source type, duration, and “private workspace” metadata identify the material on the bench. “Choose another video” is a clear outlined escape action.

Upload-only visual search and the collapsed “Other clip jobs” section sit below the production line. They are secondary utilities and do not compete in the first viewport. Ask Carpo is fixed to the lower-right and opens over the workspace.

## Palette

The creator workspace uses the tokens in `creatorWorkspaceTokens.stylex.ts`:

| Role | Value | Use |
| --- | --- | --- |
| Ink | `#f7f5ee` | Primary text and icons |
| Dim / faint ink | `#cfccc2` / `#a7a59b` | Instructions, labels, metadata |
| Bench | `#171814` | Root work surface |
| Raised / high bench | `#20211c` / `#292a24` | Panels, hover and selected rows |
| Source surface | `#323329` | Active-source ribbon |
| Deep media surfaces | `#11120f` / `#080907` | Timeline, transcript, and viewer wells |
| Line / source line | `#3b3c34` / `#575748` | Zone boundaries and stronger source edges |
| Amber / hover | `#f1b84b` / `#ffd071` | Create, trim selection, active tab, selection readouts |
| Blue | `#7ba5ff` | Transcript and time references |
| Green | `#9fce93` | Ready and complete states |
| Red / red surface | `#ff8478` / `#4e2724` | Failure text and failure panels |
| Paper / paper ink | `#e7e1d1` / `#1f211c` | Selected quality control |
| Focus | `#a9c4ff` | Keyboard focus outlines |

Amber is scarce by design. The large Create clip button is its strongest use; time selection and small navigation marks are subordinate. Status colors always accompany words or other state information.

## Typography

The workspace UI declares the self-hosted `Atkinson Hyperlegible Next`, then Segoe UI and system sans-serif fallbacks. Time values declare the self-hosted `Atkinson Hyperlegible Mono`, then SFMono, Consolas, and system monospace fallbacks.

- Body copy begins at 16px with generous line height.
- The stage title scales from 24px to 32px; builder and reel headings are 24px and 20px.
- Labels are generally 14px and semibold; metadata, status, and time values are 11–13px.
- Titles use sentence case and compact weight contrast, not display typography.
- Durations and timestamps use the mono stack and tabular-looking alignment.

## Components and states

### Builder

- Source tabs appear only before a source is active. The active tab uses text plus a 2px amber underline.
- Inputs are square, dark wells with persistent labels and muted placeholders. Validation sits directly below the relevant field in green or red.
- Quality choices are compact outlined buttons. The selected choice switches to the light paper surface with dark ink.
- Create clip is the only full-width amber control, 56px high. Its disabled state becomes dim olive with muted text and a not-allowed cursor.
- Import and creation failures use bordered red surfaces. Retry import, upload-file recovery, and secondary actions remain explicit and adjacent to the failure.

### Stage, timeline, and transcript

- The centered 16:9 viewer sits in a black well with the workspace shadow. It remains the largest single object.
- The trim surface is separated by top and bottom rules. Amber fill and handles show the active window; existing clips use a separate violet rail and overlaps use warning amber.
- The selected duration is a small amber mono readout at the heading edge, not a badge.
- Transcript timestamps are blue and monospaced. Hover, active, and selected transcript rows use the raised olive surface.
- Loading, importing, unavailable, and failed source states occupy the stage in direct status panels rather than detached notifications.

### Clip reel and preview

- Reel rows are film-strip dense: a `42×24px` thumbnail, one-line ellipsized title, mono duration, and right-aligned state.
- Rows are divided by 1px rules. Hover and `aria-pressed` selection use the high bench surface without growing the row.
- Ready, working, and failed states use green, warm amber, and red respectively, always with a dot and a text label.
- A selected clip previews in a raised overlay inside the stage. Complete clips play; working clips show labeled progress; failures show the failure message. Time range, duration, close, and Download remain visible around the media.

### Ask Carpo

- The closed trigger is a compact, outlined 44px control fixed at the lower-right. Its dark treatment keeps it secondary to Create clip.
- The open state is a right-side dialog, up to 390px wide, inset from the header and viewport edges. It overlays rather than rearranges the production line.
- The drawer uses the same bench surfaces, fine lines, small radii, and compact composer. User messages use amber with dark ink; other messages use raised olive.
- The assistant copy describes clips by time, phrase, or idea and makes approval-before-creation explicit. Examples belong inside this secondary surface, not in the core builder.

## Responsive behavior

- At `900px` and below, the workspace becomes one column in the order **stage → builder → reel**. DOM and visual order match. Zone scrolling is released into normal page flow.
- The source ribbon becomes one column, with “Choose another video” below and right-aligned. Long source metadata remains one line and truncates.
- At `640px` and below, the header becomes 62px high; the brand tagline and account summary are hidden and navigation gaps tighten.
- At `560px` and below, stage and builder side padding becomes 14px, the ribbon thumbnail shrinks to 66px, and the desktop selected-duration label is hidden. Start and End inputs remain side by side.
- On small screens Ask Carpo is inset 12px, and its drawer fills the available width (`100vw - 24px`) below the compact header.
- The floating assistant may sit over lower-right content while closed; it remains a secondary overlay rather than entering the document flow.

## Accessibility contracts

- Preserve the current named regions: active source, creator workspace, clip builder, moment workspace, clips reel, clip preview, and Ask Carpo dialog.
- Keep persistent form labels, semantic source tabs, `aria-pressed` quality and clip choices, labeled progress, and `role="status"` / `role="alert"` announcements for asynchronous states.
- Keep visible blue focus treatment on every interactive control. Current primary targets are generally 42–56px high; close controls are 36–40px square and must retain an obvious label and focus state.
- Never communicate selection, completion, progress, or failure by color alone. Text labels, underlines, dots, and/or progress geometry carry the same information.
- Preserve focus restoration and Escape behavior: closing a clip preview returns focus to its reel row; closing Ask Carpo returns focus to its trigger. The closed drawer remains `inert` and `aria-hidden`.
- Keep source-image alternative text meaningful and clip-row thumbnails decorative when the button label already names the clip and state.
- Preserve reduced-motion handling for the drawer/trigger transitions and precision-trim entrance animation.
- Keep the mobile stage → builder → reel order consistent in both layout and keyboard navigation.

## Content and copy rules

- Use short, operational nouns and verbs: “New clip,” “Mark a moment,” “Create clip,” “Clips,” “Download,” and “Choose another video.”
- Keep the core workflow to one-line instructions and compact metadata. Explain only what is required to take the next action.
- Name the assistant **Carpo** and the entry point **Ask Carpo**.
- Keep source provenance, duration, and privacy together in the ribbon. Keep clip duration and status in the reel.
- Put recovery language beside the failure and name the action directly: retry the import, retry the upload, or upload the file.
- Truncate long source and clip titles visually while preserving the full value through native title or accessible labeling.
- Reserve examples and longer guidance for the assistant or a secondary state; do not turn the builder or empty reel into onboarding prose.

## StyleX and compatibility CSS boundary

StyleX owns the creator-workspace-specific system: shared tokens, source ribbon, three-zone form shell, builder and stage surfaces, clip reel and preview, and Ask Carpo trigger/drawer. These components express their responsive and interaction states beside the component.

`index.css` still owns the global application frame and compatibility styling for reused, unmigrated descendants: TrimSlider, TranscriptPanel, VideoAgentChat, VisualMomentSearchPanel, status/background jobs, embedded/native player hooks, and shared legacy buttons/cards. The “Creator workspace” compatibility block restates the production-line palette for those adapters.

Keep that boundary explicit: creator components should consume the StyleX tokens rather than acquire new global selectors, while compatibility selectors should target only the legacy adapters they currently bridge. The StyleX token values and the matching `:root`/compatibility colors must remain visually aligned while both systems coexist.

## Anti-patterns

- A generic card-grid dashboard or a conventional multitrack editor shell.
- Multiple competing sources, or navigation that removes the user from the active source after each clip.
- A clip gallery with large cards instead of compact accumulating reel rows.
- Amber on routine secondary controls, or blue used as a general brand accent instead of a time reference.
- Oversized pills, excessive rounding, gradients, glow-heavy decoration, or shadows on every section.
- Explanatory paragraphs, marketing copy, or large empty-state illustrations in the core production line.
- Making Ask Carpo more prominent than Create clip or allowing it to obscure the manual workflow by default.
- Duplicating workspace state styles across StyleX and global CSS without respecting the compatibility boundary.

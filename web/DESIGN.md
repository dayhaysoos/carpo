---
name: Carpo
description: A source-organized, high-throughput clip production workspace.
colors:
  carbon: "#08090c"
  carbon-raised: "#0e0f10"
  ink-navy: "#131517"
  navy-raised: "#1d212c"
  media-black: "#050608"
  workbench-rose: "#19181c"
  rule: "#434755"
  rule-strong: "#5b6170"
  ink: "#efefef"
  ink-dim: "#c8b5b3"
  metadata-rose: "#af8d89"
  vermilion: "#ff412c"
  vermilion-hover: "#ff6858"
  vermilion-deep: "#791f16"
  cobalt: "#248fd2"
  time-blue: "#7ec9ff"
  focus-blue: "#62b8ef"
  complete-green: "#82dc9a"
  warning-yellow: "#ffd166"
  destructive-red: "#ff887a"
typography:
  display:
    fontFamily: "Saira Condensed, Arial Narrow, sans-serif"
    fontSize: "clamp(1.625rem, 3vw, 2.625rem)"
    fontWeight: 700
    lineHeight: 0.96
    letterSpacing: "0.035em"
  body:
    fontFamily: "Atkinson Hyperlegible Next, Segoe UI, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0.006em"
  label:
    fontFamily: "Saira Condensed, Arial Narrow, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.035em"
  mono:
    fontFamily: "Atkinson Hyperlegible Mono, SFMono-Regular, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "0.04em"
rounded:
  structural: "0"
  control: "2px"
spacing:
  compact: "8px"
  control: "12px"
  section: "20px"
  shell: "26px"
components:
  button-primary:
    backgroundColor: "{colors.vermilion}"
    textColor: "{colors.carbon}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.carbon-raised}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
    height: "44px"
  field:
    backgroundColor: "{colors.media-black}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "11px 12px"
    height: "44px"
---

# Design System: Carpo

## Overview

**Creative North Star: "The Production Signal"**

Carpo should feel like a focused production instrument: dark, compact, legible, and unmistakably in motion. Its visual identity borrows the urgency and clarity of a live production package without imitating a traditional video editor. The source stays visually dominant, the next action is easy to find, and completed output accumulates around that source without turning the interface into a dashboard of unrelated cards.

The system combines condensed industrial display type, highly readable operational text, flat layered surfaces, firm rules, and a small set of meaningful signals. Vermilion carries the brand and decisive actions. Blue indicates time, selection, and focus. Green, yellow, and soft red communicate state. Decorative explanation, oversized pills, soft generic cards, and ambient gradients are outside this world.

Manual clip creation is the complete product path. Ask Carpo, WebMCP, and other intelligent adapters may accelerate that path, but must remain visually and behaviorally secondary to the shared controls and recoverable state.

**Key Characteristics:**

- Dense but readable production layouts organized around one source.
- Condensed, forceful headings paired with accessible operational text.
- Flat near-black surfaces divided by precise slate rules.
- Vermilion brand and action signals used with restraint.
- Media-first cards with clean frames and diamond play geometry.
- Compact, explicit state rather than explanatory prose or decorative pills.

## Colors

The palette is a carbon production floor punctuated by vermilion action, cool blue utility, and restrained state colors. The frontmatter tokens are the normative values.

### Primary

- **Signal Vermilion:** The Carpo mark, primary actions, active navigation underline, and restrained section accents. It is rare enough to remain decisive and never covers source footage.
- **Hot Vermilion:** Hover and active emphasis for primary actions.
- **Deep Vermilion:** Selected or low-emphasis vermilion surfaces; never body copy.

### Secondary

- **Functional Cobalt:** Search, selected controls, and functional highlights that should not compete with the primary action.
- **Time Blue:** Transcript timestamps, trim values, and other literal time references.
- **Focus Blue:** Keyboard focus rings and accessibility state.

### Neutral

- **Carbon:** The page canvas and global shell.
- **Raised Carbon and Ink Navy:** Structural surfaces, controls, and section separation.
- **Media Black:** Video, poster, and image wells.
- **Workbench Rose:** Creator-only operational surfaces; do not spread it across every page.
- **Rule and Strong Rule:** Borders, section dividers, and input outlines.
- **Ink:** Primary text.
- **Dim Ink and Metadata Rose:** Supporting copy and metadata.

### State

- **Complete Green:** Successfully completed or ready media.
- **Warning Yellow:** Pending, blocked, or attention-needed states.
- **Destructive Red:** Destructive actions and failure states; never the default accent.

**The Vermilion Is Action Rule.** Vermilion identifies Carpo and the decisive next action. Do not use it as ambient decoration or on multiple equal-priority actions.

**The Blue Has a Job Rule.** Blue means time, focus, search, or selection. It does not replace vermilion as the primary product signal.

## Typography

**Display Font:** Saira Condensed, with Arial Narrow and sans-serif fallbacks.

**Body Font:** Atkinson Hyperlegible Next, with Segoe UI, system UI, and sans-serif fallbacks.

**Metadata Font:** Atkinson Hyperlegible Mono, with system monospace fallbacks.

**Character:** Saira Condensed gives the interface its urgent production voice. Atkinson Hyperlegible keeps forms, instructions, transcript text, and recovery states easy to read. Mono type separates timestamps and machine-like metadata without making the whole product feel technical.

### Hierarchy

- **Display** (700, fluid 1.625–2.625rem, 0.96 line-height): Page titles, source titles, and major section headings. Uppercase is appropriate when the label is short.
- **Headline** (700, 1.5–2rem, about 1 line-height): Section identity and prominent media titles.
- **Title** (600–700, 1.125–1.375rem): Clip titles, source-card titles, and compact panel headings.
- **Body** (400, 1rem, 1.55 line-height): Explanatory copy, field content, transcript, and recovery guidance. Keep readable lines below roughly 72 characters.
- **Label** (600, 1.0625rem, 0.035em tracking): Buttons, navigation, field labels, and compact controls.
- **Metadata** (400, 0.75rem, 0.04em tracking): Time, format, status detail, counts, and provenance.

**The Two-Voice Rule.** Use condensed type for identity and action; use hyperlegible type for anything a person must read, enter, or recover from.

**The Compression Is Not Crowding Rule.** Dense layouts may reduce space, but never collapse line-height, contrast, or target size below comfortable reading and interaction.

## Layout

The global shell is a persistent dark header with the Carpo mark, centered primary navigation, and a compact identity/action area. Content aligns to strong left edges and horizontal rules. Source identity precedes outputs on every authenticated surface.

Spacing follows a compact rhythm: 8px for close relationships, 12px inside controls, 20px between sections, and approximately 26px for shell gutters. Interactive targets remain at least 44px tall even when the surrounding layout is dense.

Surface composition is deliberately specific:

- **Creator** is a three-zone production bench: builder, dominant source stage, and compact clip reel. It is the densest surface.
- **Library** is a more breathable source contact sheet with transcript search and source-level grouping.
- **Video detail** begins with a source mast and follows with a clip-management sheet.
- **Clip viewer** is a cinematic overlay with dominant media and sequence controls.

At narrower widths, columns stack or become compact media-left rows. Essential controls wrap into visible grids rather than disappearing into horizontal scrolling. The source remains identifiable, all actions retain touch-sized targets, and supporting metadata yields before the primary task does.

**The Source-Before-Output Rule.** Always establish which video is active before presenting its clips, proposals, or controls. Do not repeat the source in multiple competing panels.

## Elevation & Depth

Carpo is flat by default. Depth comes from tonal layering, borders, media wells, and overlap—not generic card shadows. The only substantial ambient shadow belongs to temporary overlays such as the clip viewer. Media may use a hard offset shadow when it strengthens the production-poster composition.

### Shadow Vocabulary

- **Viewer Lift** (`0 20px 46px rgba(0, 0, 0, 0.48)`): Temporary media overlays and no other resting surface.
- **Media Offset** (`8px 8px 0 rgba(0, 0, 0, 0.6)`): Select feature media where a hard editorial offset is part of the composition.

**The Flat-by-Default Rule.** Resting surfaces are separated by tone and line. Do not add soft shadows to every card or control.

## Shapes

The core form language is square and precise. Structural panels, cards, media wells, and fields use square corners. Small 2px rounding is reserved for tactile controls and never grows into a pill. Thin slate borders structure the workspace; heavy outlines are used only for focus or decisive selection.

The diamond play mark is the signature media geometry. It indicates playback or media activation without modifying the source image beneath it. Thumbnail borders and small clipped corners may frame media, but decorative color bars, tints, and stripes never cross user footage.

**The Unobstructed Media Rule.** Source frames and clip thumbnails remain visually unobstructed. Playback controls may overlay media only when they clearly communicate an available action.

## Components

### Buttons

- **Shape:** Tight rectangular controls with 2px corners and a minimum 44px target.
- **Primary:** Vermilion surface, carbon text, condensed label type, and direct action language.
- **Secondary:** Raised carbon surface, ink text, and a visible rule; hover strengthens the border or surface.
- **Destructive:** Quiet by default and soft red only when the destructive meaning must be explicit.
- **Focus:** A visible focus-blue ring that is not replaced by hover styling.

### Inputs / Fields

- **Style:** Media-black or raised-carbon fill, one-pixel rule, square-to-2px corners, and hyperlegible text.
- **Focus:** Focus blue strengthens the outline without shifting layout.
- **Error / Disabled:** Error uses soft red with readable text. Disabled controls lose contrast but remain legible and keep their geometry.

### Navigation

- **Style:** Compact condensed labels inside the persistent carbon shell.
- **Active state:** Vermilion underline or mark, not a filled pill.
- **Mobile:** Preserve the same destinations and visible active state; reduce spacing before removing labels.

### Source Cards and Source Masts

- **Character:** Media first, source title second, operational metadata last.
- **Geometry:** Square containers, dark media wells, a clean thumbnail, and no decorative overlay across the footage.
- **Behavior:** The whole useful target is clickable, while overflow or source-management actions remain distinct.

### Clip Rows and Clip Cards

- **Character:** Compact output records with a thumbnail or first frame, title, duration, and status visible at a glance.
- **Desktop:** Use the density appropriate to the surface: tiny reel rows in Creator and larger management cards on video detail.
- **Mobile:** Convert to media-left rows with a visible action grid. Never hide core actions behind horizontal scroll.

### Clip Viewer

- **Character:** A media-dominant temporary overlay with a vermilion top rule, explicit close control, and previous/next sequence controls.
- **Boundary:** This is the exception to the flat surface system, not the default dialog template.

### Ask Carpo

- **Character:** A compact secondary launcher and overlay attached to the shared manual workflow.
- **Boundary:** It may propose or accelerate work but must not obscure the source, primary create action, manual correction, or recoverable state.

**The Manual-First Rule.** The complete manual workflow must remain visible, understandable, and correct without Ask Carpo, WebMCP, or another intelligent adapter.

## Do's and Don'ts

### Do:

- **Do** organize each surface around the active source and its outputs.
- **Do** use vermilion for the single decisive action and Carpo identity.
- **Do** show compact clip thumbnails, time, and state where people scan output.
- **Do** keep source images and clip thumbnails visually unobstructed.
- **Do** keep controls rectangular, labels direct, and interactive targets at least 44px.
- **Do** use state color together with readable text or accessible names.
- **Do** preserve manual recovery and correction on every intelligent path.

### Don't:

- **Don't** introduce oversized pills, soft generic cards, ambient gradients, or decorative glass effects.
- **Don't** explain behavior in prose when state, hierarchy, and button treatment can make it obvious.
- **Don't** make Ask Carpo the visual center of the product or rename it to Think in user-facing UI.
- **Don't** reuse the Creator three-column composition as a universal page template.
- **Don't** place decorative stripes, color bars, or tints across source images or clip thumbnails.
- **Don't** hide essential mobile actions in a horizontally scrolling strip.

# Carpo Public Entry

## Overview

This surface brief records the implemented landing, sign-in, and session-recovery presentation. The shared identity remains in `web/DESIGN.md`; its tokens and the existing `.impeccable/design.json` remain authoritative. These public-page compositions and local type sizes do not redefine the authenticated workspace.

**Thesis:** Introduce Carpo through the visible relationship between one source and several useful cuts, then provide a clear Google entry into a private library.

**Own world:** Inherit the Production Signal world: carbon, vermilion, Saira Condensed, readable operational copy, flat rules, and unobstructed footage.

**Story:** Source → moment → export. The page proceeds from the headline and start action to a selectable source and its three authored moments, the manual workflow, and a closing entry action.

**First viewport:** A public wordmark and two navigation links precede the two-line headline, concise pitch, Start clipping action, and explicit Google sign-in context. The demo follows immediately.

**Form:** Surface seed `2d4a2d57`, assigned structure index `5`, a library/source-to-clip walkthrough. `web/index.html:16` corroborates the public seed; the older authenticated-app contract following it remains separate context.

## Colors

The landing consumes the existing canvas, text, elevated surface, border, primary, hover, and time variables. Vermilion marks the wordmark punctuation, selected headline phrases, workflow numbers, entry actions, and active demo border. Time Blue remains attached to literal timestamps.

The closing entry section deliberately uses a full vermilion field with a carbon action. This is a public-page closing composition, not a new default container treatment. The selected demo row has a local warm dark fill; the video well uses literal black. Neither adds a global palette token.

## Typography

Saira Condensed supplies the public wordmark and major headings through the existing display variable. Atkinson Hyperlegible Next remains the inherited reading face; Atkinson Hyperlegible Mono distinguishes moment numbers, source duration, and cut times.

Observed local hierarchy:

| Role | Implemented treatment |
| --- | --- |
| Public wordmark | 800 weight, 2.6rem, line-height 1, −0.025em tracking; 2.3rem below 600px |
| Landing headline | 800 weight, uppercase, balanced wrap, `clamp(3.6rem, 7.5vw, 6rem)`, line-height 0.98, −0.025em tracking |
| Workflow heading | 700 weight, uppercase, `clamp(2.7rem, 4.5vw, 4rem)`, line-height 1.02 |
| Closing heading | 800 weight, uppercase, `clamp(2.7rem, 4vw, 4rem)`, line-height 1; 2.8rem below 600px |
| Session heading | 700 weight, balanced wrap, `clamp(2.8rem, 7vw, 4.5rem)`, line-height 1.05 |
| Introductory copy | 1.15rem, line-height 1.6, within a 440px pitch column; 1rem below 600px |
| Moment title and time | 0.95rem/600 title with a separate 0.75rem mono timestamp |
| Session copy | 1.05rem, line-height 1.65, maximum 60ch; supporting account note at 0.85rem |

**The Public Display Rule.** Large condensed type introduces the product; instructions, moment choices, and recovery guidance retain the readable operational face. The landing's larger scale is local to public entry.

## Layout

Header, main, and footer share a centered container capped at 1280px, with 48px gutters on either side at wide widths. The 96px header has a bottom rule. The introduction uses a 1.1:0.9 split, aligned at the bottom, with a 64px gap. The demo gives the source the larger 1.65:1 share and places its moments alongside it. The visual workflow uses a full-width editor image followed by two focused image/copy rows.

At 900px and below, outer gutters become 24px, the demo stacks source before moments, and the separating border moves from the left edge to the top. The intro gaps tighten and the screenshot detail rows stack.

At 600px and below, the header becomes 80px tall while both navigation links remain visible. The landing intro and screenshot introduction each become one column. The headline becomes `clamp(3.4rem, 14vw, 5rem)`. Moment controls remain full width; their panel padding contracts to 20px vertically and 16px horizontally. The closing section stacks its copy and action, and the footer wraps as needed. The source, moment controls, and workflow preserve their reading order.

Session pages use a centered column capped at 760px with 24px outer gutters, a wordmark, and a separate content panel. That panel starts 72px below the wordmark, reduced to 48px below 600px. Session actions wrap with a 16px gap.

**The Source-Then-Cuts Rule.** The single source remains identifiable before its selectable moments on both wide and narrow layouts; do not split the demonstration into unrelated feature cards.

## Elevation & Depth

The public surface is flat. The demo uses elevated carbon tone and one-pixel rules; selected controls change fill and border. There are no landing shadows or decorative overlays on the source footage.

## Shapes

The landing uses square frames and rectangular actions. Start clipping has a 56px minimum height, and each moment has a 76px minimum height. Header links retain 44px targets. Native media controls supply familiar playback rather than introducing a new custom player shape.

## Components

### Public navigation and entry actions

The wordmark returns home. How it works anchors the workflow, and Sign in opens `/sign-in`. Start clipping and the closing Open Carpo action reach the same sign-in entry. The first action is accompanied by “Early access · Sign in with Google”; the sign-in page makes Google and private-library ownership explicit with a Continue with Google action. A keyboard skip link moves focus past navigation to the main content.

### Source and three moments

The demonstration uses the real, local Charge poster and 18-second video, with visible Blender Foundation attribution, a CC BY 4.0 link, and disclosure that the sample was shortened and starts muted. The video starts muted, retains the film’s audio, plays inline, and uses native controls with `preload="none"`. A visible Sound off/on button toggles audio. The same video element persists between selections so its sound and volume choices remain intact; native volume controls and the button stay synchronized.

Three full-width buttons select six-second intervals: The first strike (00:00–00:06), The power surge (00:06–00:12), and The counterattack (00:12–00:18). Selection is conveyed through `aria-pressed`, a vermilion border, and a warm dark fill. A click plays the corresponding pre-cut sample file; this works even when static hosting cannot seek by HTTP byte range. The caption identifies the selected moment and original source interval. The six-second file ends naturally, and clicking its button again replays it. A semantic status line communicates playback or an unavailable preview without removing the entry action.

The sample carousel adds a Podcast / Action film selector and previous/next buttons. The Next Token is the default first sample, cued and muted on entry. It never rotates automatically. The heading and counter identify the current source; changing sources resets the selected cut, stops the previous player, and retains the visitor's sound choice. The counter yields space on small screens while the named choices remain visible. The source list and moment metadata live in `landing-demo-samples.ts`; `LandingDemo` owns selection and playback, leaving the page composition independent of the media adapters.

The Podcast slide embeds Episode 02 of The Next Token from the official YouTube channel. It offers three moments from Dillon's workflow discussion, each with its own episode timestamp, duration, and short spoken excerpt. English captions are requested in the native player. The selected sample is cued without autoplay; choosing a moment plays its bounded interval. Attribution identifies the show, Cloudflare sponsorship, and YouTube as the player source. A timestamped source link remains available when playback fails. The remote player loads with the default podcast slide and is destroyed when it leaves the carousel.

**The Real Sample Rule.** Preserve playable source footage, explicit cut boundaries, and its attribution. The demonstration represents authored sample moments and does not imply that a visitor has uploaded, generated, or exported clips.

### Workflow and closing entry

The section below the carousel introduces the actual workspace with a large screenshot, then shows two focused views: **Find the moment** and **Your clips, ready to share**. The moment story centers on previewing footage, dragging trim handles, and adjusting precise start/end times. Transcript selection remains an optional app capability and is not the landing walkthrough's organizing idea; the demonstration works with action footage without dialogue.

The screenshots are real browser captures of the local Carpo interface. The Charge source was uploaded and three six-second clips were rendered through the actual workflow before capture. Desktop images show the editor, precision trim controls, and completed clip cards. Separate narrow-screen captures and a focused clip-card crop keep mobile controls readable. Screenshot provenance and film attribution are recorded in `web/public/screenshots/README.md`; visible attribution also appears below the walkthrough.

The introductory heading and explanatory copy share two columns above the full-width editor image. Two image/copy rows follow with generous vertical separation; the delivery row places its image on the left at wide widths. Below 900px the detail rows stack in reading order, and below 600px the introduction stacks and the images use their mobile sources. Images have intrinsic dimensions, descriptive alternative text, lazy loading, and flat borders. The closing band repeats the entry action after the walkthrough.

### Session states and recovery

Sign-in, loading, signed-out, expired, failed-check, and refresh-success presentations share the restrained session column and the existing primary/secondary controls. Loading exposes a status message. A failed check exposes its error and a Check session again action. Expiry offers Sign in again (new tab), keeps draft-continuation instructions visible, and lets the user recheck on return. The account-change note explains that a different account opens its own workspace; saved clips remain with their owner. The refresh-success page identifies the signed-in account and directs the person back to the original draft tab.

These are source-observed presentation contracts. The landing screenshots do not establish hosted authentication, account isolation, or persistence behavior.

## Do's and Don'ts

- **Do** keep Google entry understandable before someone leaves the public page.
- **Do** retain source → moments → workflow order and a visible source on mobile.
- **Do** preserve readable status, selection semantics, familiar media controls, and the sample's attribution.
- **Do** reuse the existing production identity without imposing this marketing page's spacious layout on the workspace.
- **Don't** promote local headline sizes, the selected-row tint, literal video black, or the closing accent field into general-purpose brand tokens.
- **Don't** turn the authored sample into claims of automated selection or completed output.

Evidence inspected: `web/src/components/LandingDemo.tsx`, `web/src/components/landing-demo-samples.ts`, `web/src/pages/LandingPage.tsx`, `web/src/styles/landing.css`, `web/src/App.tsx`, and `web/src/components/SessionBoundary.tsx`; desktop and mobile images at `test-output/launch/landing-desktop.png` and `test-output/launch/landing-mobile.png`. The visual finish review records a ship disposition at `test-output/launch/design-finish-review.md`, with entry/session rendering unverified. `test-output/launch/design-detector.json` carries advisory type-ramp and literal-black deviations; this surface brief records observations without suppressing or reclassifying those findings. No generated comp or external quality-bar reference was supplied.

Not canonized: one-off literal colors and off-scale type sizes remain surface observations, not shared design-system additions. No new durable brand prohibition is inferred from the detector or this landing composition.

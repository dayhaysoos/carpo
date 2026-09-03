# Landing walkthrough screenshots

Refreshed from the real Carpo UI on 2026-09-03 at 3× device-pixel density.
The source is the licensed 18-second Charge sample documented in `../demo/README.md`.
The local browser capture uses an isolated API fixture with that source and the
three checked-in six-second clip files. Video playback, trim controls, clip cards,
fonts, and responsive layouts are rendered by the actual application; interface
content is not composited or AI-generated. This is a presentation capture, not new
evidence that a backend upload or encoding run succeeded.

- `workspace.webp`: desktop editor with the selected range and three completed clips.
- `workspace-mobile.webp`: the actual narrow-screen editor, showing the video and trim controls.
- `moment.webp` and `moment-mobile.webp`: close-ups of the actual precision trim controls.
- `clips.webp` and `clips-mobile.webp`: completed clips and their real preview/export/download controls.

Each crop has lossless WebP variants: the unsuffixed 1× image, `@2x`, and `@3x`.
The lower-density variants are downsampled from the original 3× PNG capture, never
upscaled from the old compressed images. `LandingPage.tsx` supplies width-based
`srcSet`/`sizes`, mobile art direction, and matching intrinsic aspect ratios.
Lazy loading is retained. Keep these properties when refreshing the screenshots:
small lossy captures smear the interface text on high-density screens.

Desktop capture viewport: 1440 × 1300 CSS pixels. Mobile: 430 × 1300.
Desktop workspace crop: 1440 × 900 CSS pixels. Detail crops follow the actual
controls; the desktop clips crop contains the first two cards and mobile shows
one complete card. Original PNGs and the local capture/encoding scripts are in
`test-output/landing-fidelity/` in the authoring checkout (ignored, not deployed).
Canonical assets live here; `npm run build:web` copies them to `public/screenshots/`.

Film: https://studio.blender.org/projects/charge/
Charge © Blender Foundation, CC BY 4.0: https://creativecommons.org/licenses/by/4.0/
The footage was shortened for this sample. The landing page retains visible attribution.

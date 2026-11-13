# Tablamigo framed Play Store screenshots

Turns raw 1080x2400 captures into 1080x1920 Play screenshots (headline, brand gradient, CSS phone frame, floating cutouts) plus a 1024x500 feature graphic.

## Re-render

    node render.cjs                  # all slides + feature graphic + contact sheets -> out/
    node render.cjs --only 03-chat-vote-meet --no-sheet

render.cjs starts its own local http server and headless Chrome (Playwright from ~/Desktop/hookpost/node_modules, channel 'chrome'). No other setup. Exit code 2 means a safe-zone check failed; the reason is printed.

After swapping the raw captures in ../screenshots/, re-run the command. If a screen's layout changed, update that slide's cutout `rect`s (they are raw-screenshot pixels). Anything below raw y ~2110 is off the canvas, so debug toasts there never show.

## Files

- index.html: the template. `window.build(slide, defaults)` draws one slide.
- render.cjs: renders every slide in slides.json, checks safe zones, writes out/*.png, out/web/*.webp (540x960 and 270x480, q65, via cwebp), out/_contact-sheet.png (360 px wide each) and out/_contact-thumbs.png (180 px, roughly listing size).
- slides.json: the story. fonts/: Plus Jakarta Sans 600/700/800 (OFL), copied from the app.

## Slide config

    {
      "name": "01-never-eat-alone",              // output file name
      "raw": "../screenshots/1-explore.png",     // relative to slides.json, or absolute
      "headline": "never eat\n*alone* again",    // \n = line break, *word* = accent colour
      "sub": "optional one-line sub",
      "phone": {"top": 510},                     // optional override of defaults.phone
      "cutouts": [
        {"rect": [x, y, w, h], "scale": 1.25, "radius": 44, "rotate": -3, "dx": 0, "dy": 0},
        {"chip": "Women only", "bg": "#F1EAFF", "fg": "#8E5CF7", "size": 46, "at": [800, 1352], "rotate": 6}
      ]
    }

- A cutout is a crop of the raw screenshot. By default it sits exactly over the same UI on the phone and is enlarged by `scale` (1 = on-phone size), so it reads as popping out of the screen. `dx`/`dy` nudge it; `at: [cx, cy]` places its centre anywhere on the canvas. `src` crops from a different raw capture (use with `at`).
- A chip recreates the app's `Pill` component (components/ui.tsx) for UI that is not in the capture. Use it only for real in-app labels.
- Headline starts at 112 px and shrinks to fit the 940 px copy box, never below 88 px (the check fails instead).
- Checks: text stays 60 px from the sides and out of the bottom 8%; cutouts stay on the canvas and off the text.

Design tokens come from apps/mobile/src/lib/theme.ts and apps/web/style.css (#FF5A36 coral, #E0421F/#C8371A deeps, #8E5CF7 women purple). No user counts, ratings or awards in copy.

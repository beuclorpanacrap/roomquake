# RoomQuake design system

A field notebook surrounding a live instrument: warm paper, ink typography, practical rules, numbered observations. Color conveys signal provenance and intensity rather than decorating generic cards. All assets are local, including the custom array illustration.

## Tokens and composition

`public/style.css` is the token source. Paper `--paper`, raised paper `--surface`, primary text `--ink`, secondary text `--muted`, separators `--line`, instrument `--dark`, virtual signal `--signal`, real signal `--real`, caution `--alert`. Use 4/8/12/16/24/32/48 px spacing tokens as the base rhythm. Radius: 12 px panels, 6 px controls, 4 px compact labels. Elevation is a border except for the editorial landing illustration.

Typography: Arial/system sans for explanation and controls; system monospace for timestamps, measurements and labels; Georgia italic only for the landing word “instrument.” Desktop display 82 px maximum, mobile 56–64 px; page title 35–40 px, section 23–27 px, body 13–18 px, secondary 11–12 px, instrument metadata 8–10 px. Measurement values must remain readable and never be replaced by decorative chart graphics.

## Components and states

Shared components are represented by CSS classes: `.role-card`, `.card`, `.cardhead`, `.badge`, `.healthbar`, `.empty`, `.phone-step`, `.statusline`, `.event`. Controls have default, hover, focus-visible and disabled states. Inputs retain labels; all actions have a minimum 46 px hit height. Error/status notices use an accessible live region. Focus is a 3 px burnt-orange outline with 4 px offset. Neutral, live, simulated, disconnected and idle states always include text so color is not the only cue.

The host flow leads with room sharing and measured health, then spatial/waveform evidence, then intervention and events. The phone flow presents placement before permission. Joining never enables motion. Pre-flight content explains the same network, trusted HTTPS, flat placement and gentle inputs before a physical experiment.

## Motion and responsive rules

No decorative animations. Only a 120 ms button-background transition, disabled for reduced-motion preferences. Waveforms render on the next animation frame, with stable canvas nodes between metadata changes. Lower-power mode coalesces telemetry/rendering at 100 ms. Use a two-column desktop layout; collapse to a single readable column at 760 px. At 390 px or below, dense join fields and experiment actions stack. Avoid horizontal scrolling, line clipping, invisible units and data-viz color ambiguity.

Validate landing, host empty/live, sensor onboarding, denied permission and responsive states using Playwright screenshots, including 1440×1000, 390×844 and 360×800. Do not promise a rating: judge legibility, task clarity, data accuracy and screenshot evidence.

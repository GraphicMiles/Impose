# Taste pass, 2026-09-17

Applied from the taste-skill redesign protocol (`Leonxlnx/taste-skill`, the
`redesign-existing-projects` and `design-taste-frontend` skills), plus the
product language brief and the flow completeness brief supplied with it.

**Design read:** redesign, preserve, of the public and auth surface of a
dark, flat, borderless AI workspace, for people evaluating whether to trust
it with their provider keys, leaning toward the app shell's own house
language rather than a new one.

The skill's own rule governs the scope: *"work with the existing tech stack,
do not migrate, do not break functionality, small targeted improvements over
big rewrites."* The house design (dark, flat, no shadows, no gradients, no
focus rings, Lucide only, no dashes) is the project's own and overrides the
skill's generic defaults wherever the two disagree. Notably the skill
suggests moving off Lucide and adding shadows and grain; all three were
declined because the repo bans them deliberately, and its own README records
the reasoning.

The app shell (`index.html`, `styles.css`, `community.css`) had already been
through a taste pass in an earlier commit. The surface that had **not** been
through one was everything around it: six public and legal pages, the auth
screens, and the routes for addresses that match nothing. That is the gap
this pass closes.

## Audit findings and what was done

| # | Finding | Rule | Fix |
|---|---|---|---|
| F1 | Public and auth pages rendered in the system font stack while the app used Geist. Signing in looked like a different product from the one being signed into. | redesign-skill, typography | `fonts.css`, one shared face, linked by all seven public pages and `auth.html`. Generated from `styles.css` by `tools/sync_fonts.py`. |
| F2 | Public palette (`#212121`, `#171717`, `#2f2f2f`) was a separate gray family from the app shell (`#202124`, `#16171a`, `#2b2c30`). Two warm/cool families in one product. | redesign-skill, colour and surfaces | Public tokens realigned to the shell. One gray family across the whole product. |
| F3 | Three equal card columns on About and Contact. The skill names this the single most generic AI layout. | taste-skill 9.C | Asymmetric grid: a lead tile spanning two rows beside two stacked supporting tiles. Base rule is now single column, so the layout is genuinely mobile-first per the repo's 390px constraint. |
| F4 | No 404 page. A mistyped legal URL dead-ended on the host's default error page, off-brand and with no route back. | redesign-skill, strategic omissions; flow.txt 15 | `404.html`, branded, `noindex`, explains the cause, offers the app plus every real destination. Wired as the terminal `/*` rewrite in `render.yaml`. |
| F5 | No skip link on any page. Keyboard users tabbed the full nav on every long legal page. | redesign-skill, strategic omissions | `.skip-link` on all seven pages, targeting `#main`. Hidden until focused, which respects the no-focus-ring house rule while still being a real visible control. |
| F6 | The table of contents on the long legal pages gave no indication of the section in view. | redesign-skill, interactivity | `IntersectionObserver` sets `aria-current` on the active entry. No scroll listener, per taste-skill's explicit ban. |
| F7 | The mobile menu could be opened but not dismissed by keyboard, and stayed open over the destination after an in-page jump. | flow.txt 14, back navigation | Escape closes and returns focus to the trigger. Selecting a link closes it. |
| F8 | Four em-dashes in shipped source, two of them in user-facing copy in the access gate. | taste-skill 9.G, binary ban | All removed. Sentences restructured, not just substituted. |
| F9 | The access gate explained the Workspace in one dash-spliced 34-word sentence. | text.txt 1, 6, 20 | Rewritten as three plain sentences: what is open, what the Workspace is, how you get in. |
| F10 | Numbers in tables and meta rows were proportional, so columns jittered between rows. | redesign-skill, typography | `font-variant-numeric: tabular-nums` on data surfaces. |
| F11 | Cards had no hover state and a uniform radius at every nesting depth. | redesign-skill, interactivity and layout | Surface responds on hover, radius varies by depth. |
| F12 | Hero sections were flat text on flat fill. | redesign-skill, colour and surfaces | One neutral radial wash tinted from the page background. Explicitly not the purple AI gradient the skill bans. |

## Flow consequences, checked

Applying the flow brief to the one genuinely new surface, the 404:

- **Every button has a destination.** The "Go back" control is the only new
  interactive element. If the page was opened in a fresh tab from a bad
  link there is no history, and `window.history.back()` would do nothing:
  a control that looks functional but is dead, which the brief bans
  outright. It detects this and relabels itself to "Read about Botocracy"
  with a real destination. Both states are asserted in the test suite.
- **Deep links resolve.** Every destination the 404 offers is checked
  against `render.yaml` routes and built files by a test, so the page that
  exists to rescue broken links cannot itself accumulate broken links.
- **Terminal state.** A mistyped URL now reaches a defined conclusion with a
  next action, instead of the host's unstyled dead end.

## Regression protection

`agent/tests/taste.js`, 18 assertions, added to the CI gate in
`.github/workflows/regression.yml`. This pass is almost entirely static
assets, which no existing suite would have noticed rotting. The suite pins
the em-dash ban, the shared palette and face, `fonts.css` being in sync with
`styles.css`, the skip links, the 404 and its routing, both states of the
back control, the asymmetric grid, tabular figures, the absence of filler
marketing verbs, and the Render build shipping every new asset.

It earned its place during this pass: refactoring the grid from a column
span to a row span broke the layout assertion, and leaving the base
three-column rule in place while overriding it later broke a second one.
Both were real defects in the change, caught before commit.

## Full gate at time of writing

```
run                  51 passed, 0 failed
features             63 passed, 0 failed
lifecycle            14 passed, 0 failed
orchestrator         24 passed, 0 failed
audit-regressions     7 passed, 0 failed
taste                18 passed, 0 failed
build_inline --check  impose-standalone.html is current
pytest backend        81 passed
audit/run.js          6360 scenarios, 0 failed
audit/relay.py        1308 scenarios, 0 failed
```

Rendering was verified in headless Chromium at 1280px and 390px across the
404, About, and Privacy pages. No console errors.

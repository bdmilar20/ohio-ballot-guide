# Design standard

This project takes its visual direction from the federal design work published by
the National Design Studio (NDS) under the "America by Design" initiative, and
from the U.S. Web Design System (USWDS) that initiative builds on. The point of
writing it down is that the guide is meant to grow past Ohio: a contributor
adding a state should not have to reverse-engineer the look from the stylesheet.

Everything below is a rule a reviewer can check, not a mood. Where a number came
from an NDS property, the source is named.

## Reference

The values in the "NDS reference" column were read from the stylesheets the
National Design Studio serves on its own sites, on 2026-10-14:

- `americabydesign.gov` — `/_next/static/chunks/2y_xxz5684vw_.css`
- `trumprx.gov` — `/_next/static/chunks/2ha8achmnwdnd.css`

USWDS is the underlying system: <https://designsystem.digital.gov>.

## Surface and ink

| Token | This project | NDS reference |
| --- | --- | --- |
| Page | `--paper: #f7f3eb` | `--surface-page: #f5f4eb` |
| Card | `--surface: #fffdf8` | `--surface-card: #fffef1` |
| Ink | `--ink: #1d211f` | `--foreground: #0a0a0a`, `--text-primary: #333334` |

The background is warm paper, not white and not a cool gray. This is the single
most recognizable property of the NDS sites and it is the reason the guide reads
as a printed civic document rather than a dashboard. Do not introduce a
`#ffffff` page background or a blue-gray neutral ramp.

Text is near-black, never pure `#000`.

## Type

- One display face (Georgia) for `h1`/`h2` and the date numeral; one text face
  (Inter) for everything else. Do not add a third.
- Display sizes are fluid: `clamp()` with a floor that is readable at 320px.
- Negative tracking on display type only. NDS uses `-0.02em`; this project uses
  `-0.035em` on the serif, which needs the extra tightening.
- **Nothing renders below 12px.** NDS's smallest routine step is
  `--text-micro: .75rem`. Labels, party chips, verification dates and the footer
  all sit at that floor. When you need something to recede, change weight or
  color — do not go smaller.
- **Write `font-size` in `rem`, or as a `clamp()` whose first argument is in
  `rem`.** Those are the forms the floor can be proven in without a browser, so
  they are the only ones `test/styles.test.mjs` accepts — `em`, `%`, `var()` and
  a `clamp()` with a `vw` floor fail the suite as unevaluatable rather than
  passing unchecked. Set `font-size` on its own; the `font` shorthand can carry a
  size, so the suite rejects it except for `font: inherit`.
- Body copy is `line-height: 1.55`; NDS uses `--leading-relaxed: 1.625`. Keep
  body leading above 1.5.

## Accessibility

The America by Design brief names WCAG 2.2 AA as the bar, so these are
requirements rather than preferences.

- Every text/background pair meets **WCAG 2.2 AA** contrast — 4.5:1 for body,
  3:1 for large text. The lowest pair in the current build is 4.76:1.
- Every interactive target is at least **24x24 CSS px** (WCAG 2.2 SC 2.5.8).
  Where a link is visually small, expand the hit area to its card with an
  absolutely positioned `::after`, as the essentials cards do.
- Nothing is communicated by color alone.
- `prefers-reduced-motion` is honored.

Only the 12px type floor is machine-checked, by `test/styles.test.mjs`. It reads
every `font-size` declaration in `styles.css` and fails on any value it cannot
evaluate, so a new unit or function cannot slip past by matching no pattern. The
project has no dependencies and no build step, and a headless browser is too
much to ask of a contributor fixing a candidate's name, so contrast and target
size are confirmed in review against a rendered page rather than in `npm test`.
Measure them before claiming them; do not assert them from the stylesheet.

## Layout

- Content column is `min(1120px, 100% - 40px)`. NDS uses a 1024px container with
  a 1260px outer bound. Do not widen past 1120px — long measure hurts reading.
- Section rhythm is large and consistent. NDS uses a 100px `--section-gap`.
- No page may require horizontal scrolling at 320px.

## Color and neutrality

The guide is nonpartisan and says so on its face. That constrains the palette in
a way it would not constrain an ordinary product:

- Party affiliation is rendered as a neutral text chip. Never color-code a
  candidate by party; the chip is the same for every party.
- One accent, used for interactive affordance and nothing else.
- **Avoid red and blue as the brand accent.** In a U.S. election context both are
  party colors and a voter will read them that way. NDS reserves red for
  destructive actions only (`--destructive: #e40014`) and uses a muted green for
  affirmative state (`--accent-green: #366e56`).

### Resolved: the accent is moss green

`--accent: #42594c` with `--accent-dark: #314037`. The guide shipped with a
crimson accent (`#7b2432`), which read as a party color on a page whose own hero
says "No political spin." The project owner chose green on 2026-10-15.

Moss was already defined in `styles.css` for the notice rail, within a few points
of the NDS affirmative green (`#366e56`), so the switch reuses an existing token
rather than introducing a hue. It carries the eyebrow labels, the primary button,
the date numeral, every source link and the focus ring.

Contrast on the two surfaces, measured rather than assumed:

| pair | ratio |
|---|---|
| `#42594c` on `--paper: #f7f3eb` | 6.86:1 |
| `#42594c` on `--surface: #fffdf8` | 7.47:1 |
| `white` on `#42594c` (primary button) | 7.60:1 |
| `white` on `#314037` (button hover) | 10.94:1 |

All clear WCAG 2.2 AA for normal text (4.5:1). The accent stays fully tokenized —
`--accent`, `--accent-dark`, and two `rgba()` literals — so it remains four
values wide and reversible.

## Content

Braeden's brief for the project is "minimalist and very simple UI and not an
overload of content," and the NDS brief is task completion in as few steps as
possible. Both point the same way:

- The landing page has exactly one job: take a city or ZIP.
- Never add a section that does not help a voter vote.
- Every contest carries its official source link and its `last_verified` date.
  Trust here comes from citation, not from reassuring copy.
- A result is addressable: the search and the chosen county live in the query
  string, so a voter can bookmark their guide or send it to someone.

### Resolved: no contest is hidden behind a control

"Not an overload of content" governs how many *sections* the page has. It never
licenses hiding a contest that is on the ballot.

The statewide list used to render three cards and put the rest behind a "Show
all contests" button. On the 2026 general ballot that hid Secretary of State,
Auditor, Treasurer and both Ohio Supreme Court seats. Judicial races are the
ones a voter is least likely to have heard of, and they sit at the bottom of the
printed ballot too, so the one section of the guide that could have helped most
was the section a voter had to know to ask for. Braeden searched his own ZIP on
launch day and reported the guide had about a tenth of his ballot; a third of
that gap was this collapse.

So: every published contest renders, in ballot order, with no expand control.
`test/contest-visibility.test.mjs` fails if a hiding CSS rule, a collapse
control, a `data-secondary` tag, or a cutoff argument comes back. If the list
ever gets long enough to need navigation, add navigation — a jump list or
anchors — never a control that makes a contest invisible by default.

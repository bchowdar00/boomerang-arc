# Boomerang's page: the design as built

The campaign page is a school gym's scoreboard that already shows both endings. The board says how much is left and how long. The receipt beside it says what one pledge does if the target is met and what comes back if it is not, with the contract's own figure, before anyone pays.

The approved direction is `design/DIRECTION.md` in the build folder. This file records what the code does, and it wins where the two differ.

## Colour

The board is the same royal blue in both themes. The page around it follows the reader's light or dark setting. Tokens are at the top of `src/styles/app.css`.

| Token | Value | Use |
|---|---|---|
| `--field` | `#1d3fbf` | the board |
| `--plate` | `#142c8a` | recessed plates, the receipt |
| `--band` | `#2a4dcc` | the early-bonus band on the chart |
| `--chalk` | `#f5f7ff` | figures, the plate rules, chart lettering |
| `--chalk-soft` | `#b9c4f2` | captions, units, secondary lines on the board |
| `--flag` | `#ffd23f` | a figure that is still moving, and the Pledge button |
| `--on-flag` | `#10204f` | text on yellow |
| `--ground` | `#eef1f8` light, `#0a1338` dark | the page |
| `--ink` / `--soft` | `#10204f` / `#4a5680` light, `#eef1ff` / `#a9b6e6` dark | text off the board |
| `--link` | `#1d3fbf` light, `#8ea2ec` dark | links, focus rings off the board |

Yellow means one thing: this figure is still moving. It is used for TO GO while pledges can come in, the early-bonus clock, the "if it falls short" amount while the bonus can still change, and the now point on the chart. A settled figure is chalk.

Contrast, computed:
- chalk on the field 7.8, on a plate 11.17, on the band 6.47;
- yellow on the field 5.78, on a plate 8.28;
- chalk-soft on the field 4.87, on a plate 6.97;
- navy on yellow 10.84, on the light ground 13.84;
- `--soft` on the light ground 6.33.

Chalk-soft is never used on the band, where it would measure 4.04.

## Type

- **Barlow Condensed 600 and 700** (self-hosted, `@fontsource/barlow-condensed` 5.2.8, Latin): the board's numerals, the campaign name, headings and the board's captions.
- **Barlow 400 and 500** (`@fontsource/barlow` 5.2.8): every sentence.
- Uppercase appears on the board only: captions, units, flags, Home's campaign names and the campaign's h1.
- Two digit sizes on the board. TO GO and a result flag use `clamp(3rem, 1.6rem + 4.2vw, 5.25rem)`; the other plates use `clamp(2.25rem, 1.5rem + 2.2vw, 3.5rem)`.
- Figures use tabular numerals.
- Monospace is for addresses only.

## Shape

The board has square corners and no shadows: it is painted, not floating. Plates are parted by 2px chalk rules, drawn as a 2px gap over a chalk background. Controls off the board have 4px corners. The receipt's two halves are parted by a dashed tear line.

## The campaign page

1. **Band:** three plates while the campaign takes pledges or waits (`views/board.ts`).
   - TO GO comes first. The second plate is TIME LEFT, or OPENS IN before opening.
   - The third is EARLY BONUS ENDS IN while the early window is open and there is a bonus pool, otherwise BACKERS.
   - Once the campaign is over, a result flag (REACHED, FELL SHORT or NEVER OPENED) and two plates: DEADLINE and BACKERS.
   - A plate's clock shows days, then hours, then `m:ss` as time runs out.
2. **Chart:** inline SVG at the size it is shown (`views/chart.ts`, `ui/Chart.tsx`).
   - Opening to closing across, the early band, a dashed target line, and the now point at the contract's total.
   - While pledges can come in, a dotted PACE NEEDED line and the now line are drawn too. Before opening and once closed, neither is drawn.
   - The climb line is the keeper's running total of pledges and rescue. It is drawn only when that total equals the contract's; otherwise the chart says why.
   - A screen reader gets a one-sentence summary and a table of the points.
3. **Receipt:** the two halves, "If the target is met" and "If it falls short", from the form's quote (`views/receipt.ts`).
   - A pledge that would finish the campaign collapses it to one line.
   - Then come the amount field and the yellow Pledge button that names the amount.
   - The two-step approve-then-pledge, the one-at-a-time submit and the check just before sending are unchanged from the old Pledge page (`ui/PledgeBox.tsx`).
   - Once the campaign is over, the receipt shows what happened: the status, the figures (for a missed campaign, what goes back and the bonus), and the Settle button where Pledge was.
   - `#/campaign/N/pledge` is the same page with the cursor in the amount field.
4. **Under the board:** the rule in one sentence, then the newest four events (with an EARLY tag and how long ago) beside the terms.

On a phone (under 760px), TO GO takes the full width, the other two plates share a row, and the receipt comes before the chart. At 390 wide the Pledge button sits in the bottom half of the first screen.

## Other pages

- **Home** is an out-of-town board: one line per campaign with its name, the board's first two readings and its status. Open campaigns come first.
- **My money and Proof** are working screens: the palette and type, ruled rows and standard controls, no board.

## Motion

- **Durations:** 120ms (press, reduced-motion fades), 220ms (interface), 280ms (the flip).
- **Curve:** `cubic-bezier(0.16, 1, 0.3, 1)`. No ease-in, no bounce, nothing over 500ms.
- **What animates:** only `transform` and `opacity`, apart from colour transitions on controls.
- **The flip** (`ui/Plate.tsx`, `views/flip.ts`) is the one authored moment.
  - When TO GO or BACKERS changes because a pledge or settlement was read from the chain, each changed character slides: the old one up and out, the new one up from below.
  - Characters go right to left, 40ms apart. Unchanged characters do not move, and nothing moves on first render.
  - The clocks do not flip: they change every block.
- **Receipt:** a figure that changes while the typed amount stays the same rises 4px and fades in over 160ms. Typing never animates.
- **Feed:** a new row fades in from above (250ms, 50ms delay) while the rows below shift down (200ms).
- **Chart:** the newest step of the climb extends from its riser to the new point (`scaleX`, 400ms).
- **Press:** `scale(0.97)` over 120ms. Hover effects only on devices with a fine pointer.
- **Reduced motion:** the flip becomes a 120ms crossfade, feed rows appear in place, and the climb updates without moving.
- **Screen readers:** a changed total is announced once (`role="status"`, `aria-atomic`).

## Words

The board's own words: TO GO, TIME LEFT, EARLY BONUS ENDS IN, OPENS IN, BACKERS, DEADLINE, REACHED, FELL SHORT, NEVER OPENED, EARLY, PACE NEEDED, TARGET, "If the target is met", "If it falls short", and "… ago".

Every other word comes from the tested view functions in `src/views/`. The site speaks of the campaign in the third person. There are no em dashes in visible copy.

## Checks

- Tests: `web/test/board.test.ts` holds the plates, clocks, results, climb, chart geometry, receipt, flip positions, "how long ago" and the missed receipt.
- Captures of every state at 1280 and 390, light and dark, are in `design/checks/` in the build folder.

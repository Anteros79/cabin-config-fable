# Visual appearance check: design

Status: draft, owner answers folded in, awaiting approval. 2026-11-18.

## Intent

Cabin Kit is a pitch demo. It shows appearance technicians and decision makers, from outside the company and using only fictional or public data, what a visual appearance check could look like. The technician should never have to learn the logging system.

The visual workflow:
1. Tap the exact piece on a 3D model of the cabin.
2. See what it is and which part replaces it.
3. Record what was done.

At the end, everything done in one check is shown together in an after-action report, both on a picture of the cabin and as a list.

Once the project is approved, the details will be worked out inside the company with real data: real parts, the real MEL, and sign-off and authentication.

## Goals

1. **Every piece a technician deals with can be tapped in 3D.**
   - **Seat:** cushion, backrest, headrest, armrests, tray table, seat belt, seat-back net, and the life vest under the seat.
   - **Floor:** carpet.
   - **Overhead bin:** the bin opens on tap, and the pieces inside can be tapped.
2. **Selecting a piece shows** its name, its position (for example "Seat 12A · Headrest"), and its part with any approved alternates. Picking a piece in 3D or in the map/list selects the same thing.
3. **For any piece, the technician can:**
   - replace it now;
   - note a problem;
   - defer a noted problem until the next check or the next stop, with a reason such as no stock on hand.
4. **Bin types and sizes are part of each cabin configuration.** The 3D model draws the bins that configuration really has: type, length and count per side, from the bin research.
5. **Each piece carries a minimum equipment list (MEL) label: cosmetic, MEL item, or no-go.**
   - A cosmetic item may be deferred freely.
   - An MEL item may be deferred only under its MEL entry, with its category and due date.
   - A no-go item can't be deferred.
   - The MEL is data, as the parts list is. A short fictional MEL ships with the demo.
6. **Deferred items carry forward.** The next check on the same tail opens with them marked in 3D and in a "Carried over" list. An overdue item is shown as overdue.
7. **The after-action report** shows the whole check: replaced, noted, deferred, carried over and must-fix.
   - It shows them on a cabin picture, with every touched piece coloured by what was done, and as a list in the order the work happened.
   - The PDF includes the cabin picture.
8. **Light and dark mode cover all new screens.** The 3D view follows the theme, as it already does. Printed and PDF output stay light (existing rule).

## Non-goals (for this demo)

- No real company data: no real part numbers, MEL, tails or layouts.
- No sign-in, roles or approval of deferrals. The technician decides, and the record says the technician did.
- No photo-real models. Clean, readable shapes are the goal. Detailed models are a later option (see Approaches).
- No inventory system. "No stock on hand" is a reason the technician picks, not a stock lookup.
- Nothing is sent to maintenance systems.

## Anti-goals (failure even if it works)

- **A technician needs the old codes or a manual to do a check.** Every label in the workflow is plain words: piece names, actions, reasons.
- **A deferral is lost between checks,** or a no-go item can be deferred.
- **The demo looks like real company data,** or claims to be a maintenance authority. The existing "fictional demonstration" banner and footer stay.
- **The 3D view becomes slow or unusable on a phone.**
- **The report disagrees with what was recorded,** in the counts or in where things are on the picture.

## Constraints

- **Build on what exists.**
  - The procedural three.js scene (`src/web/scene/CabinScene.ts`) draws one instanced mesh per seat part and tags each mesh with a component (`:636-654`). Picking already returns `{location, component}`.
  - The domain model has components per location kind (`fixtures/fixture-data.json` `components`), rules that bind component to part, and an append-only visit event log (`src/server/visitStore.ts`).
- **Every existing check stays green.** That covers unit, integration, process and e2e tests, axe accessibility, keyboard-only use, and the light/dark tokens.
- **Performance budgets** (`budgets.json`, PF-21) currently allow 32 draw calls and 525,000 triangles on the 176-seat layout.
  - New pieces will add instanced meshes, so the budget gets re-measured and reset once on purpose. It must not drift.
  - The mobile project in e2e must still pick and render.
- **New fictional data goes in `fixtures/fixture-data.json`** (strict schema in `src/importer/fixtureSchema.ts`), plus the generator in `src/importer/fixtures.ts`.
  - `fixtures/originals/` holds the unmodified supplied originals, whose hashes are pinned. It is never edited.
  - The new data changes the reference release's content hash (today `9cf6c6d2`). That is expected: the tests and docs that pin it move with it.
- **Stable piece names**, for example `SEAT:12A` + `HEADREST`, are the contract between data, 3D and report. A drawn shape attaches to a name, so it can later be swapped for a detailed model without touching data or reports.
- **Use only public sources** for bin facts, cited in `docs/research/2026-11-18-southwest-737-overhead-bins.md`.

## Approaches

1. **Extend the existing procedural 3D model (chosen).**
   - Split each seat into its tappable pieces, add opening bins with inner pieces, and extend the existing data, log and report.
   - Keeps every test, the performance budget, theming and keyboard support. The look stays clean rather than photo-real.
2. **Detailed 3D models made separately (later, if needed).** Seat and bin models built in a 3D tool, with named sub-meshes mapped to the same piece names.
   - More realistic.
   - Needs model files we are allowed to use, and more work up front, and it strains the phone budget.
   - The stable piece names in this design are what make this a drop-in later.
3. **A separate throwaway demo (dropped).** It would lose the hardened, tested app.

The owner chose 1, with 2 as a later extension.

## Design

### Pieces (data)

The seat components grow from 2 to 8 kinds. All names are fictional demo wording.

| Piece id | Name | Where it is drawn | Belongs to |
|---|---|---|---|
| CUSHION | Seat cushion cover | seat pan | the seat |
| BACKREST | Seat backrest cover | seat back | the seat |
| HEADREST | Headrest cover | top of the seat back | the seat |
| SEATBELT | Seat belt | on the pan | the seat |
| TRAY | Tray table | back of the seat in front; bulkhead wall or armrest in row 1 | the seat behind (the passenger who uses it) |
| SEATBACK_NET | Seat-back net | back of the seat in front, or the bulkhead | the seat behind |
| LIFE_VEST | Life vest (under seat) | under the pan; shown with the "Under seat" layer | the seat |
| ARMREST | Armrest | between seats | its own location (below) |

**Armrests are their own locations,** so a shared armrest is logged once.
- Example ids: `ARMREST:12-A` (outboard of A), `ARMREST:12-AB`, `ARMREST:12-BC` and `ARMREST:12-C` (aisle side), and the same for D, E and F.
- Each is labelled by the seats on either side, for example "Armrest between 12A and 12B".

**Floors keep CARPET_KIT and CARPET_PANEL.**

**Bins:**
- Each bin location carries a bin type and length from its configuration (see Bins).
- Its pieces come from the research. Candidates are door or bucket, latch, floor liner, side panels, bumper strip, placards and bin number label.
- BIN_DOOR stays, and new ids are added.

**Every piece has a rule binding it to a fictional part,** with alternates where it makes sense, as today. The fixtures gain these parts, rules and the fictional MEL.

### MEL labels (data)

**The class comes from the piece and the condition the technician picks** (builder's call). Each component has a small table from condition to class:
- **Condition:** stained, torn, worn, broken, missing, won't latch, other.
- **Class:** one of
  - `{ class: "COSMETIC" }`
  - `{ class: "MEL", item: "FX-25-21-01", category: "C", intervalDays: 10, conditions: "Seat blocked and placarded INOP", blocksSeat?: true }`
  - `{ class: "NO_GO", reason: "…" }`
- Every condition maps to exactly one class, so the technician never has to choose between "X or Y".
- A configuration can override an entry.
- The categories follow the usual pattern, with fictional values: A (as stated), B 3 days, C 10 days and D 120 days.

**Seat blocked** (builder's call):
- An MEL entry marked `blocksSeat` puts the seat into a "blocked" state for as long as the deferral is open. The seat belt entry is one of these.
- While a seat is blocked, entries that say "allowed if the seat is blocked" become deferrable on that seat. For example, a missing life vest is no-go, but becomes MEL C once the seat is blocked.
- The 3D view and the report show a blocked seat.

**The demo MEL is short and fictional**, for example:
- seat belt broken or missing: MEL C, blocks the seat;
- life vest missing: no-go, or MEL C while the seat is blocked;
- tray table broken: MEL D, stained: cosmetic;
- bin door won't latch: no-go, worn: cosmetic;
- covers, carpet and placard wear: cosmetic.

**Overrides:**
- A technician may raise a class (cosmetic → MEL → no-go), never lower it.
- **An MEL deferral past its due date becomes no-go** (owner decision). It can no longer be deferred, it shows as must-fix, and the aircraft is not releasable until it is fixed.

### What the technician records (visit)

**A record stays as today:** "replaced with part X, qty N", one per piece.

**A new finding** on any piece records:
- condition: stained, torn, worn, broken, missing or other, plus a free note;
- outcome: one of
  - **Replaced:** linked to the record;
  - **Deferred:** until the next check or the next stop, with a reason (no stock on hand, no time on this turn, other) and a note;
  - **Must fix before flight:** for no-go items;
  - **Noted only:** cosmetic, with no action needed.

**A deferred MEL item** stores its MEL entry and a due date (the visit date plus the interval). A deferred cosmetic item has no due date.

**Completing a visit while a must-fix item is open is allowed only if the technician confirms "Aircraft held, reported."** (owner decision). The visit stores that flag, and the report shows "Not releasable" at the top.

**A visit can be completed with findings and no replacements** (builder's call). The storage rule `visits_complete_needs_records` (EMPTY_VISIT) relaxes from "at least one record" to "at least one record or finding". The migration and tests change with it.

**Every finding change is a new event in the append-only log:** FINDING_ADDED, FINDING_UPDATED and FINDING_CLOSED, carrying full before and after values. The report can then replay the check in order. Existing record events gain the previous values too.

### Carry-forward

- Open deferred findings belong to the tail, not the visit.
- A new visit on that tail lists them under "Carried over". Each is marked in 3D, and is overdue if its due date has passed.
- The technician can close one (replaced or fixed) or defer it again. A re-deferral keeps the original due date for an MEL item. Once that date has passed, the item is must-fix and can't be deferred.
- **Carried-over findings are keyed by tail and piece** (location id and component id), and are never dropped (builder's call).
  - **The next visit has the same piece:** the finding attaches there.
  - **A bin changed:** for example, after a retrofit or a new module layout, the finding goes to the bin that covers its first row on the same side.
  - **The piece doesn't exist in the new configuration:** for example, BIN_ASSIST after a move to LARGE_PIVOT. The finding is listed under "Carried over: no longer at this position", with its original label, until the technician closes it by hand.
- "Next stop" deferrals appear on any visit for that tail, the same as "next check". The label only tells the next technician what was intended.

### 3D view

**Seats:**
- Each seat piece is its own instanced mesh, tagged with its piece id. Hovering highlights only that piece and shows its name. A tap selects it.
- The headrest is split from the backrest. Tray and net are drawn on the back of the seat in front, or on the bulkhead, and tagged with the seat behind.
- The seat belt is drawn on the pan. The life vest is drawn under the pan and is hidden unless the "Under seat" layer is on.
- Armrests are tagged with their armrest location.

**Bins:**
- Each bin is drawn to its type and length. A tap on a closed bin opens it: the door lifts or the bucket pivots, depending on type, with a short animation. Reduced motion cuts straight to open.
- The inner pieces then become tappable. A second tap on the door, or "Close bin", closes it.
- Bins with open findings show a marker while closed.

**Colour by status** extends to pieces: replaced, noted, deferred, must-fix and carried over each get a distinct, accessible colour, with the legend updated.
- Colour is never the only signal. The badge and outline rule still applies.

**Keyboard and map/list:**
- Every piece is reachable from the map/list and from "Go to location". Typing "12A headrest" works.
- The keyboard selection flow covers pieces.

### Inspector (the side panel)

- **The heading** names the piece and its position.
- **Below it:** the part and its alternates, the MEL label in plain words, any open or carried-over findings, and three buttons: Replace now, Note a problem, Defer.
- **Replace now** is the existing record form.
- **Note a problem / Defer** is one short form:
  1. pick the condition;
  2. pick the outcome. The choices offered depend on the MEL class: no Defer for no-go, and a due date shown for an MEL item;
  3. pick the reason;
  4. add an optional note.
- All copy is plain language, with no codes shown unless the person expands "Details".

### After-action report

**On screen and in the PDF:**
- **Summary at the top:** counts of replaced, deferred (cosmetic and MEL), must-fix, noted and carried over, and the release flag.
- **Cabin picture.** The 2D cabin map, reused from `CabinMap`, with every touched piece coloured by outcome.
  - On screen, a "View in 3D" toggle shows the same marking on the 3D model.
  - The PDF gets the 2D picture as vector drawing.
- **Timeline.** Every event of the visit in order: time, piece, what changed, before and after.
- **Lists by outcome.** Replaced, with the existing part totals. Deferred, with the MEL item, category and due date. Must fix. Carried over in, and still open out.

The existing sections stay: frozen configuration, aggregate part totals, gaps, sources and advisories.

### Light and dark

The theme control and tokens already exist (`ThemeControl.tsx`, `tokens.css`). All new UI uses the tokens, and the new status colours get light and dark values that pass contrast. The axe runs in the e2e `dark` project cover the new screens.

## Bins

This section is based on the public research in `docs/research/2026-11-18-southwest-737-overhead-bins.md`. Where public sources stop, the demo uses labelled fictional values. No real part numbers are used. The part numbers the research found are unverified listing titles and stay out of the app.

### What the public record shows

- **Bin type is per aircraft, not per model.** Many 737-800s and early MAX 8s have pivot bins (Boeing Sky Interior). New MAX 8 deliveries and an ongoing retrofit bring larger pivot bins (Space Bin-style).
- **The 737-700 bin type** is disputed in public sources.
- **Capacity, as Boeing publishes it:** a pivot bin holds about 4 bags, a larger bin about 6.
- **Both pivot types open the same way:** a bucket pivots down on side pivots. The larger bin hangs about 2 in lower when open and has no assist mechanism.
- **No public source gives** bins per side, bin lengths by position, or how bins are numbered.

### Bin types in the demo

Bin type is part of each cabin configuration, so a retrofit shows up as a new configuration, the same way the V05 → V04 retrofit already does.

| Demo bin type | Opens by | Capacity label | Used by (fictional) |
|---|---|---|---|
| CLASSIC (fictional stand-in for the pre-Sky-Interior bin) | door hinged at the top, lifting up over a fixed shelf (fictional; public sources do not confirm the real mechanism) | 3 bags | FX-700 configurations (V09, V10) |
| PIVOT | bucket pivots down; spring assist and damper | 4 bags | FX-800 V05, V06, V07 and V08; FX-MAX8 V02 and V03 |
| LARGE_PIVOT | deeper bucket pivots down and hangs lower; no assist | 6 bags | FX-800 V04 (retrofit); FX-MAX8 V01 |

**Bin modules per side** are made-up values, labelled as such in the data:
- Each layout lists its modules per side as a sequence of lengths in rows (2, 3 or 4), with shorter modules near the doors and over the wings.
- This replaces today's fixed three rows per module (`src/importer/fixtures.ts:150`).
- Bin ids stay `BIN:<side>-<nn>`. The label adds the row span and the capacity, for example "Overhead bin L-04 (rows 10-12, 6 bags)", following the research's suggestion to key bins by side and row span.

### Bin pieces

| Piece id | Name | Bin types | Demo MEL class |
|---|---|---|---|
| BIN_DOOR | Bin door / bucket face | all (a door on CLASSIC, the bucket face on pivots) | cosmetic (wear); no-go if it can't latch |
| BIN_LATCH | Latch and release button | all | MEL (C): bin placarded INOP, empty and locked |
| BIN_STRIKER | Latch striker | all | MEL (C): as for the latch |
| BIN_PIVOT | Hinge / pivot | all | no-go |
| BIN_ASSIST | Assist spring and damper | PIVOT only | MEL (D) |
| BIN_LINER | Floor liner | all | cosmetic (fictional: public sources do not confirm a separate liner) |
| BIN_SIDE_PANEL | Inner side / end panels | all | cosmetic |
| BIN_BUMPER | Stop bumper | pivot types | cosmetic |
| BIN_SEAL | Closeout seal between bins | all | cosmetic |
| BIN_PLACARD | Maximum-weight placard | all | no-go until replaced (a required placard) |
| BIN_LABEL | Row / bin label | all | cosmetic |

- **Classes are fictional demo values** that follow the regulatory split in the research: retention parts and required placards are airworthiness items, and finish items are cosmetic. They are not Southwest's MEL.
- **Out of scope** as adjacent assemblies: the passenger service unit under the bins (reading lights, oxygen), and the ceiling, sidewall and lighting panels.

### In 3D

- Each bin type has its own closed shape and its own opening motion: CLASSIC's door lifts up, and both pivot types swing their bucket down.
- Opening a bin shows its inner pieces.
- Bins with an open finding show a marker on the closed bin face.

## Left to the builder

- Exact mesh shapes, proportions and instance layout within the re-measured budget.
- Fictional part numbers, descriptions, alternates and MEL entries.
- Event payload shapes, and the migration of the visit schema for existing stores. The data is fictional and disposable, but an existing store must open or be rebuilt cleanly.
- Animation timings.
- The exact status colours, within contrast.
- How "Go to location" parses piece names.

## Decisions

**Owner decisions:**
- The technician decides deferrals. Sign-off and roles come later.
- Data is public or fictional only.
- The MEL decides which items are safety items.
- A must-fix item open at completion: complete only with "Aircraft held, reported", and the report says "Not releasable".
- An overdue MEL item becomes must-fix.

**Builder's calls, for the owner to check:**
- The class depends on the piece and the condition.
- A "seat blocked" state comes from MEL entries.
- Carry-forward is keyed by tail and piece, with bin row-span mapping and a "no longer at this position" list.
- A finding-only visit can be completed.
- Armrests are their own locations.
- Tray table and net belong to the seat behind.
- The three demo bin types and their configuration mapping.
- Module lengths are made up.

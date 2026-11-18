# Visual families and image analysis

The 14 supplied images are the only visual evidence. None of them is linked by any supplied file to a tail, layout, date or seat set, so every visual profile in this build is labelled `unassigned-illustrative`. The model is not dimensionally accurate and makes no claim about which aircraft carries which appearance.

Each original was opened at full resolution (previews in `evidence/image-previews/`, made by `tools/make-image-previews.mjs`). Pixel sizes and metadata come from `evidence/inventory.json`.

## Per-image analysis

"Kind" is my judgment from the picture, not from metadata. Confidence is how sure I am of that judgment.

| # | File | Size | Kind (confidence) | What it shows | Used for | Limits |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `Southwest-Airlines-new-RECARO-seats-Video-still-Southwest.png` | 970×521 | Computer render, video still (high; metadata says "Screenshot") | Gray-lilac seat fronts, headrest with one pale face on the outer wing, heart mark, angled upper panel, vertical stitch lines | Concept family: colour, headrest shape, stitch direction | Render, not a cabin. Colours are artistic |
| 2 | `barrier.webp` | 960×1048 | Photograph (medium) | Forward barrier and galley area, a card reading "737-MAX8" | Context only: forward monument exists | No seats usable for modelling. The card is not a layout assignment |
| 3 | `carpet.jpg` | 1000×750 | Phone photograph from above (high; Pixel 6a EXIF, GPS present) | Dashed-arc carpet, two pale border strips along the aisle, seat pans, pale arms, belts | Carpet pattern, aisle borders, pan and arm tops | Small area. Location data is not used or shown |
| 4 | `forward galley flight deck.jpg` | 5184×3456 | Press photograph (high) | Forward galley and flight-deck door | Context only | Metadata names American Airlines (2015). Treated as another operator's cabin and not modelled |
| 5 | `rear galley.jpg` | 1920×1281 | Photograph (medium) | Aft galley | Context only: aft monument exists | No seat or bin detail |
| 6 | `recarro 2.jpg` | 1140×641 | Daylight photograph (high) | Dark headrest with pale-blue wing faces, pale-blue angled band on the upper back, stitched dark lower field, literature card behind the headrest | Band family: band, headrest, stitch field | Strong window light; colours shift with exposure |
| 7 | `seats 1.jpeg` | 736×416 | Photograph in blue cabin light (medium) | Seat fronts, pale arms with dark pads, silver legs, carpet | Arms, legs, blue-light look | Low resolution |
| 8 | `seats 2 .jpeg` | 617×324 | Photograph looking aft (medium) | Whole cabin, bins, ceiling arch, blue light, band visible on backs | Cabin proportions, bin line, aisle view | Low resolution; wide lens |
| 9 | `seats 3.jpg` | 1440×480 | Photograph, close crop (high) | Rear shell: literature slot, device-holder ledge, panel with two openings | Rear-shell furniture | Narrow crop. Does not show which seats have the panel |
| 10 | `seats 4.jpg` | 2500×1667 | Professional photograph (high; Canon EXIF, Lightroom) | Side view of a row, bin doors and segmented underside with service units, rear shell, arms, legs | Bin shape, underside, seat profile | One row only |
| 11 | `seats 5.jpg` | 4032×3024 | Photograph in blue light (high) | Navy seats with no pale band, headrest nearly as wide as the back with one pale wing face, heart mark | Plain family | Differs from image 6 on headrest width |
| 12 | `seats 6.avif` | 1920×1080 | Stylised image, possibly a render (low) | Headrests, heart emblem on a bulkhead | Weak support for headrest shape | Kind uncertain; not used for colour |
| 13 | `seats 8.jpg` | 1280×720 | Computer render (high) | Gray seats, arms | Concept family | Render |
| 14 | `southwest seats-7.webp` | 1600×1067 | Photograph looking forward (high) | Pale rear shells with dark top edge, literature cards, tray tables, aisle, bins, blue ceiling light | Rear shells, aisle, bin line | Cards hide the upper shell |

## The three families

| Family | Profile id | Supported by | Distinguishing features | Notes |
| --- | --- | --- | --- | --- |
| Navy with pale band | `photo-navy-band` | 6, 7, 8, 10 | Pale-blue angled band across the upper back, dark headrest, pale wing face | Default profile |
| Navy without band | `photo-navy-plain` | 11 | Upper back same navy as the rest; one pale wing face | Only one image, so support is thin |
| Concept gray | `concept-gray` | 1, 13 (12 weakly) | Gray-lilac covering, bold stitch lines | Render-based. Kept separate from the photographed families |

Shared by all three in the model: three-part headrest with projecting wings, separate pan and back, pale arms with dark pads, silver legs, pale rear shell (literature ledge, device ledge, tray and latch, mesh pocket, two-opening panel), dashed-arc carpet with aisle border strips, pale convex bin doors with seams and a recessed handle, segmented underside.

Two lighting presets (`neutral`, `blue`) reproduce the two lighting conditions in the photographs. Lighting is independent of the family.

## Materials and light

Final values after tuning by eye against comparison sheets 01 (`recarro 2.jpg`) and 03 (`seats 5.jpg`). They live in `src/web/scene/materials.ts` and `src/web/scene/environment.ts`.

| Part | Material | Values |
| --- | --- | --- |
| Upholstery (back front, pan; plain on headrest, back core and wing faces) | `MeshPhysicalMaterial` | roughness 0.55, specularIntensity 0.5, sheen 0.4, sheenRoughness 0.5, sheen colour = the part's colour lifted 20 % toward white, clearcoat 0.08, clearcoatRoughness 0.6, normalScale (0.6, 0.6) |
| Shell (rear relief; rear shell with its map; arms in the arm colour) | `MeshStandardMaterial` | roughness 0.7, metalness 0 |
| Legs | `MeshStandardMaterial` | metalness 1, roughness 0.35 |
| Arm pads | `MeshStandardMaterial` | roughness 0.5 |
| Cabin shell sidewalls (context layer, 5.6) | `MeshStandardMaterial`, back faces only, vertex colours | roughness 0.85, metalness 0; wall `#eef0f3`, window reveal `#d3d8e0`, pane `#9fb0c6` |
| Cabin shell ceiling (context layer, 5.6) | `MeshStandardMaterial`, back faces only | colour `#f1f2f5`, roughness 0.85; emissive at 1.6 through a 2 × 1 mask: full on the two light channels, sRGB 96 elsewhere (a faint glow) |
| End bulkheads (context layer) | `MeshStandardMaterial`, one pass, both sides | `#e2e4ea`, roughness 0.7, opacity 0.55 |

Changed from the starting values: specularIntensity 0.5 (added; at 1.0 the bright room's reflection greyed the dark navy to slate) and a sheen colour only 20 % lighter than the leather (at 60 % the sheen laid a grey haze over the navy).

Seat back and pan maps are 512 × 1024. Each colour map has a height map drawn from the same seam layout (stitched channels and seams as dark grooves, piping as a light ridge), turned into a tangent-space normal map by a Sobel pass (strength 2.5), and a roughness map that is 0.8 of the base along the piping. The normal and roughness maps depend only on where the seams run, so the families share them (two back layouts, with and without the band, and one pan).

Light: three's `RoomEnvironment`, prefiltered with PMREM, one per light mode; `environmentIntensity` 1.0 neutral, 0.55 blue. In blue mode the room's emissive panels are `#7d94ff` and its main light `#c4cdff`. One directional key from the left (window) side, `#fff8ee` at 1.4 neutral, `#b9c5ff` at 1.2 blue; in blue mode a `#6f86ff` fill at 0.8 from the other side. Tone mapping ACES, exposure 1.0 neutral, 1.05 blue. The ceiling's light channels are emissive (no light of their own): white in neutral light, `#6f8dff` in blue. No shadow maps: a soft radial contact patch on the carpet under each seat grounds it.

Cabin shell (context layer, Task 5.6): the half cross-section is `shellProfile()` in `src/domain/geometry.ts`, extruded along the cabin and mirrored. A sidewall arc of radius 1.9 m centred on the centreline through the floor edge (widest 1.9 m from the centreline at 0.72 m), a recess stepping out behind the drawn bins and over them (3 cm clear of their 2.30 m top and 0.76 m inboard edge), and a ceiling arch from 2.33 m just inboard of the bins to 2.45 m on the centreline, with a 12 cm light channel recessed 5 cm into it each side (0.56–0.68 m from the centreline). The ceiling height was raised from the plan's 2.15 m, which would have cut the drawn bins. Windows are rounded rectangles 0.26 × 0.36 m (corner radius 0.075 m) centred 1.06 m up, one per row pitch, recessed 5 cm. Faces wind outward and the materials draw back faces only, so a wall seen from outside shows nothing; from outside the shell the ceiling and the sidewall nearest the camera also fade to 0.1 (both sidewalls from above). Every value is illustrative: no drawing gives the cabin height or cross-section. Four draw calls: two sidewalls, the ceiling and both bulkheads together.

Status in 3D: a location shows one status, by precedence unresolved > recorded > alternate > none (a seat with any unresolved component needs attention), the same in 3D and in the map (Task 5.4), with a glyph badge so status is never colour alone. On a seat the status is a tint in the headrest's own material (below); floor areas carry a translucent overlay (one instanced draw call) and bin doors are tinted halfway from white toward the status colour. The selection and hover outlines and the floor frame use the `--select` token, ochre `#b97c00`, the same in every theme (Task 5.7).

Status overlays are not tone mapped, so they are drawn in exactly the legend swatch colours (`tests/web/materials.test.ts` checks ΔE ≤ 10 against the `--status-*` tokens in `src/web/styles/tokens.css`; tone mapped at exposure 1.0, "recorded" would be ΔE 26.5 off and "unresolved" ΔE 11.5). The headrest's status tint is no overlay: the headrest's own material mixes its final colour 60 % toward the status colour after tone mapping (`withStatusTint`, Task 6.5), the same sum the translucent overlay made, without a second copy of the headrest's 900 triangles per seat.

## What the images do not establish

- Which layout, tail or date any family belongs to.
- Any dimension: seat pitch, width, cabin height and bin size in the model are illustrative.
- Whether the power panel exists on every seat. It is visible on the seats in images 9 and 10 only; the model draws it on every rear shell as appearance, and the application makes no availability claim.
- Whether the two headrest widths (images 6 and 11) are different products or different viewpoints.
- True colour. Every photograph is taken under tinted or strong light.

Deliberately not modelled: the heart mark and any wordmark (brand marks), literature cards, window shades, passengers. (Seat belts were left out until 2.1.0; see "Piece meshes" below.)

## Piece meshes (2.1.0)

Every piece a technician can tap is its own instanced mesh, tagged with its location id and component id (`SEAT:12A` + `HEADREST`). The shapes are clean and illustrative, not photo-real, and a detailed model can later replace a shape without changing data or reports. The scene budget is 39 draw calls, 546,307 triangles and 3,175 triangles per seat on the 176-seat layout (`budgets.json`).

| Piece | Where it is drawn |
| --- | --- |
| Cushion, backrest, headrest | Seat pan, seat back and the top of the seat back; the headrest keeps its own material and takes the status tint |
| Seat belt | On the pan |
| Tray table, seat-back net | On the back of the seat in front, or the bulkhead panel in row 1; tagged with the seat behind. No tray or net is drawn for a seat behind an omitted seat |
| Life vest | Under the pan, shown only with the "Under seat" layer |
| Armrest | Between two seats, tagged with its own `ARMREST:<row>-<span>` location |
| Bins | Three fictional types. PIVOT and LARGE_PIVOT swing the bucket down on side pivots (LARGE_PIVOT is deeper and hangs lower); CLASSIC keeps a fixed fascia and swings a shorter lower panel up about its top edge, so it stays under the ceiling. A tap on a closed bin opens it (reduced motion cuts straight to open); the inner pieces are then tappable, from the focus view too |

Status colours for the new piece states (replaced, noted, deferred, carried over, must-fix, blocked) are tokens in `src/web/styles/tokens.css` with light and dark values; printed and PDF output stays light.

The judged comparison of renders against these originals is in [`verification/README.md`](../verification/README.md).

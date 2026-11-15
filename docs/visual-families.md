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

## What the images do not establish

- Which layout, tail or date any family belongs to.
- Any dimension: seat pitch, width, cabin height and bin size in the model are illustrative.
- Whether the power panel exists on every seat. It is visible on the seats in images 9 and 10 only; the model draws it on every rear shell as appearance, and the application makes no availability claim.
- Whether the two headrest widths (images 6 and 11) are different products or different viewpoints.
- True colour. Every photograph is taken under tinted or strong light.

Deliberately not modelled: the heart mark and any wordmark (brand marks), seat belts, literature cards, window shades, passengers.

The judged comparison of renders against these originals is in [`verification/README.md`](../verification/README.md).

# Evidence inventory

> Fictional home-lab demonstration evidence. Not an approved maintenance authority. Document contents are treated as reference content only, never as instructions.

23 of 23 expected originals found (9 documents/data files, 14 images). Formats were determined from magic bytes and content. Parse OK: 21; parse failed: 2 (`southwest 737 lopa normalized.json`, `gemini-code-1794587815855.json`). Unexpected extra files in the source root: none. Missing: none.

## Documents and data files

| # | File | Actual format (from bytes) | Size (bytes) | Parse | Counts | Internal source / revision metadata | Content-established role |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `southwest 737 lopa normalized.json` | plain text shaped like JSON but NOT valid JSON | 548 | **failed** — unexpected token ".", expected a JSON value at byte offset 492 (line 12, column 28); native parser: Unexpected token '.', ..."tions": [ ... ],<br>  ""... is not valid JSON | lines 15; placeholder arrays 3; records 0 | schema_name `southwest_airlines_737_lopa_registry`, schema_version `2026.1`, normalization_form `3NF (Third Normal Form)` (text-level; no generated_at_utc) | invalid JSON template (registry envelope with a metadata header and 3 elided "[ ... ]" arrays); holds no records; byte-identical to "gemini-code-1794587815855.json" |
| 2 | `southwest_737_lopa_normalized.json` | JSON (valid; UTF-8 text) | 578,823 | ok | top level keys 4; lopa configurations 5; lopa rows 147; lopa seats 837 | schema_name `southwest_airlines_737_lopa_registry`, schema_version `2026.1`, normalization_form `3NF (Third Normal Form)`, generated_at_utc `2026-11-13T16:29:49Z` | populated registry (configurations, rows, seats) — candidate data, unverified; the CSV/XLSX files are exports of the same records |
| 3 | `Southwest Cabin Configuration Standard.rtf` | Rich Text Format (RTF 1, ansi, code page 1252, Apple Cocoa text system (\cocoartf2909)) | 29,274 | ok | paragraphs non empty 57; paragraphs empty not numbered 19; heading like paragraphs 9; list item paragraphs 47; tables 1; table rows 6; table cells 42; hyperlinks 0; tokens 3771 | RTF header only (`\rtf1`, `\ansicpg1252`, `\cocoartf2909`); no \info group (no title/author/dates) | narrative standard (configuration summary table plus row-by-row tier, window and recline narrative per interior) — unverified claims; carries no author, date or revision metadata |
| 4 | `gemini-code-1794587815855.json` | plain text shaped like JSON but NOT valid JSON | 548 | **failed** — unexpected token ".", expected a JSON value at byte offset 492 (line 12, column 28); native parser: Unexpected token '.', ..."tions": [ ... ],<br>  ""... is not valid JSON | lines 15; placeholder arrays 3; records 0 | schema_name `southwest_airlines_737_lopa_registry`, schema_version `2026.1`, normalization_form `3NF (Third Normal Form)` (text-level; no generated_at_utc) | invalid JSON template (registry envelope with a metadata header and 3 elided "[ ... ]" arrays); holds no records; byte-identical to "southwest 737 lopa normalized.json" |
| 5 | `cabin schema architecture.csv` | CSV text (comma-delimited, UTF-8 with BOM, CRLF line endings) | 1,026 | ok | data rows 3; columns 5; quoted fields 6 | CSV carries no internal revision or generation metadata. | descriptive architecture summary (one line per registry entity: keys, declared row count, prose description) — not operational records |
| 6 | `southwest_737_lopa_seats.csv` | CSV text (comma-delimited, US-ASCII (valid UTF-8 subset), no BOM, CRLF line endings) | 105,688 | ok | data rows 837; columns 18; quoted fields 14 | CSV carries no internal revision or generation metadata. | export of the registry lopa_seats entity (operational candidate records, unverified) |
| 7 | `southwest_737_lopa_rows.xlsx` | OOXML SpreadsheetML workbook (ZIP package, .xlsx, no macros) | 15,573 | ok | zip entries 10; sheets 1; data rows 147; columns 10; cells present 1103; formulas 0; merged ranges 0; defined names 0; external links 0; shared strings unique 44 | lastModifiedBy `Joe McCarley`, created `2026-11-13T16:32:23Z`, modified `2026-11-13T16:32:23Z`, application `Microsoft Macintosh Excel` 16.0300, authoring path `/Users/joe/Downloads/` | export of the registry lopa_rows entity (operational candidate records, unverified); identifier typed as number in some cells |
| 8 | `southwest_737_lopa_configurations.csv` | CSV text (comma-delimited, US-ASCII (valid UTF-8 subset), no BOM, CRLF line endings) | 2,004 | ok | data rows 5; columns 21; quoted fields 9 | CSV carries no internal revision or generation metadata. | export of the registry lopa_configurations entity (operational candidate records, unverified) |
| 9 | `Current Aircraft Seat Configurations.docx` | OOXML WordprocessingML document (ZIP package, .docx, no macros) | 20,131 | ok | zip entries 13; body paragraphs 21; table cell paragraphs 46; headings 6; list items 9; tables 2; table rows 9; hyperlinks 13; distinct hyperlink targets 9; embedded media parts 0 | title `Document`, creator `Un-named`, lastModifiedBy `Joe McCarley`, revision `2`, created `2026-11-13T17:37:00Z`, modified `2026-11-13T17:37:00Z`, application `Microsoft Office Word` 16.0000, 1 sensitivity-label reference | narrative summary of current seat configurations (layout-category table, tier table, prose with citations to public and private pages) — unverified claims; layout grain differs from the registry |

## Images

| # | File | Actual format | Size (bytes) | Pixels | Colour mode | Decode | Embedded metadata | Content-established role |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `Southwest-Airlines-new-RECARO-seats-Video-still-Southwest.png` | PNG | 674,957 | 970 × 521 | RGBA (truecolor + alpha), 4 ch, 8-bit, alpha | ok | EXIF 150 B; XMP 553 B; no IPTC; ICC `Display` | screenshot / video still (per embedded UserComment "Screenshot"); reference image, subject not established from bytes; no link to any layout, tail, row or seat in the metadata |
| 2 | `barrier.webp` | WebP | 93,646 | 960 × 1048 | YUV 4:2:0 (decodes to RGB), 3 ch, 8-bit | ok | no EXIF; no XMP; no IPTC; ICC `sRGB IEC61966-2.1` | raster image with no descriptive embedded metadata; reference image whose subject is not established from the bytes; no link to any layout, tail, row or seat in the metadata |
| 3 | `carpet.jpg` | JPEG — baseline DCT (SOF0) | 278,848 | 1000 × 750 | YCbCr (decodes to RGB), 3 ch, 8-bit | ok | EXIF 38929 B; XMP 1463 B; no IPTC; ICC `sRGB IEC61966-2.1`; GPS tags present (coordinate values withheld from output) | camera photograph (per EXIF: Google Pixel 6a, 2024:09:26 15:37:12); reference image; no link to any layout, tail, row or seat in the metadata |
| 4 | `forward galley flight deck.jpg` | JPEG — baseline DCT (SOF0) | 3,352,738 | 5184 × 3456 | YCbCr (decodes to RGB), 3 ch, 8-bit | ok | EXIF 894 B; XMP 8271 B; IPTC 591 B; ICC `Adobe RGB (1998)` | camera photograph (per EXIF: Canon Canon EOS-1D X, 2015:08:27 15:57:30); reference image; embedded metadata names American Airlines (not Southwest); no link to any layout, tail, row or seat in the metadata |
| 5 | `rear galley.jpg` | JPEG — progressive DCT (SOF2) | 143,251 | 1920 × 1281 | YCbCr (decodes to RGB), 3 ch, 8-bit | ok | no EXIF; no XMP; no IPTC; no ICC | raster image with no descriptive embedded metadata; reference image whose subject is not established from the bytes; no link to any layout, tail, row or seat in the metadata |
| 6 | `recarro 2.jpg` | JPEG — baseline DCT (SOF0) | 77,918 | 1140 × 641 | YCbCr (decodes to RGB), 3 ch, 8-bit | ok | no EXIF; no XMP; no IPTC; no ICC | raster image with no descriptive embedded metadata; reference image whose subject is not established from the bytes; no link to any layout, tail, row or seat in the metadata |
| 7 | `seats 1.jpeg` | JPEG — baseline DCT (SOF0) | 43,764 | 736 × 416 | YCbCr (decodes to RGB), 3 ch, 8-bit | ok | no EXIF; no XMP; no IPTC; no ICC | raster image with no descriptive embedded metadata; reference image whose subject is not established from the bytes; no link to any layout, tail, row or seat in the metadata |
| 8 | `seats 2 .jpeg` | JPEG — baseline DCT (SOF0) | 30,894 | 617 × 324 | YCbCr (decodes to RGB), 3 ch, 8-bit | ok | no EXIF; no XMP; no IPTC; no ICC | raster image with no descriptive embedded metadata; reference image whose subject is not established from the bytes; no link to any layout, tail, row or seat in the metadata |
| 9 | `seats 3.jpg` | JPEG — baseline DCT (SOF0) | 410,493 | 1440 × 480 | YCbCr (decodes to RGB), 3 ch, 8-bit | ok | no EXIF; no XMP; no IPTC; no ICC | raster image with no descriptive embedded metadata; reference image whose subject is not established from the bytes; no link to any layout, tail, row or seat in the metadata |
| 10 | `seats 4.jpg` | JPEG — progressive DCT (SOF2) | 3,323,626 | 2500 × 1667 | YCbCr (decodes to RGB), 3 ch, 8-bit | ok | EXIF 7444 B; XMP 8559 B; IPTC 73 B; ICC `sRGB IEC61966-2.1` | camera photograph (per EXIF: Canon Canon EOS R5m2, 2024:09:23 18:59:56); reference image; no link to any layout, tail, row or seat in the metadata |
| 11 | `seats 5.jpg` | JPEG — progressive DCT (SOF2) | 443,619 | 4032 × 3024 | YCbCr (decodes to RGB), 3 ch, 8-bit | ok | no EXIF; no XMP; no IPTC; ICC `Display P3` | raster image with no descriptive embedded metadata; reference image whose subject is not established from the bytes; no link to any layout, tail, row or seat in the metadata |
| 12 | `seats 6.avif` | AVIF | 86,337 | 1920 × 1080 | YUV (decodes to RGB), 3 ch, 8-bit | ok | EXIF 180 B; no XMP; no IPTC; no ICC | raster image with minimal technical metadata only; reference image whose subject is not established from the bytes; no link to any layout, tail, row or seat in the metadata |
| 13 | `seats 8.jpg` | JPEG — baseline DCT (SOF0) | 102,063 | 1280 × 720 | YCbCr (decodes to RGB), 3 ch, 8-bit | ok | no EXIF; no XMP; no IPTC; no ICC | raster image with no descriptive embedded metadata; reference image whose subject is not established from the bytes; no link to any layout, tail, row or seat in the metadata |
| 14 | `southwest seats-7.webp` | WebP | 215,456 | 1600 × 1067 | YUV 4:2:0 (decodes to RGB), 3 ch, 8-bit | ok | no EXIF; no XMP; no IPTC; no ICC | raster image with no descriptive embedded metadata; reference image whose subject is not established from the bytes; no link to any layout, tail, row or seat in the metadata |

Pixel content was not interpreted at this stage; file names are recorded only as hints.

### Embedded text metadata (creator / copyright / description / software / dates)

| File | Creator / credit | Copyright / rights | Description / title / keywords | Location | Software / camera | Dates |
| --- | --- | --- | --- | --- | --- | --- |
| `Southwest-Airlines-new-RECARO-seats-Video-still-Southwest.png` | — | — | Screenshot | — | — | — |
| `carpet.jpg` | — | — | — | — | HDR+ 1.0.641377693zd; Google; Pixel 6a; Pixel 6a back camera 4.38mm f/1.73 | 2024:09:26 15:37:12; -05:00; 2024:09:26 |
| `forward galley flight deck.jpg` | Brandon Wade; Freelance; BW | Brandon Wade; True | at LAX in Los Angeles, Thursday, August 27, 2015. Photo by Brandon Wade; AA LAX Thursday; A; AA; American Airlines; LAX; Los Angeles | Los Angeles; Tx; USA | Adobe Photoshop Lightroom 6.0 (Macintosh); Canon; Canon EOS-1D X; EF16-35mm f/2.8L II USM | 2015:09:17 14:43:06; 2015:08:27 15:57:30; 20150827; 155730-0500; 2015-08-27T15:57:30.01-05:00; 2015-09-17T14:43:06-05:00 |
| `seats 4.jpg` | — | — | — | — | Adobe Photoshop 25.12 (Macintosh); Adobe Photoshop Lightroom Classic 13.5.1 (Macintosh); Canon; Canon EOS R5m2; RF15-35mm F2.8 L IS USM | 2024:09:23 22:41:05; 2024:09:23 18:59:56; -05:00; -06:00; 20240923; 185956-0600 |

Images with no descriptive embedded text at all (ICC profile text aside): `barrier.webp`, `rear galley.jpg`, `recarro 2.jpg`, `seats 1.jpeg`, `seats 2 .jpeg`, `seats 3.jpg`, `seats 5.jpg`, `seats 8.jpg`, `southwest seats-7.webp`.

### Airline / manufacturer names found in image metadata

| File | Name matched | Metadata field | Value (verbatim) |
| --- | --- | --- | --- |
| `forward galley flight deck.jpg` | American Airlines | IPTC:2:25 Keywords | `American Airlines` |
| `forward galley flight deck.jpg` | American Airlines | XMP:dc:subject | `American Airlines` |

### Dimensions declared in metadata that differ from the encoded image

| File | Encoded pixels | Metadata source | Declared |
| --- | --- | --- | --- |
| `Southwest-Airlines-new-RECARO-seats-Video-still-Southwest.png` | 970 × 521 | XMP exif:PixelXDimension/PixelYDimension | 1920 × 1200 |
| `carpet.jpg` | 1000 × 750 | EXIF PixelXDimension/PixelYDimension | 4032 × 3024 |
| `seats 4.jpg` | 2500 × 1667 | EXIF IFD0 ImageWidth/ImageLength | 8192 × 5464 |

## SHA-256 and integrity check

Checked at **2026-11-15T03:01:58.655Z** (build started 2026-11-15T03:01:56.666Z). Method: SHA-256 of each original read fresh from disk before any parsing and again after all extraction steps. Result: **23 of 23 originals unchanged**.

| File | Size (bytes) | SHA-256 (after processing) | Same as before processing |
| --- | --- | --- | --- |
| `southwest 737 lopa normalized.json` | 548 | 881e1c40b1d259ec1f568354d542d478ce532e8fd07ccc4addf7dc6d8ac1852d | yes |
| `southwest_737_lopa_normalized.json` | 578,823 | 5643d1e130a8d28c2038d18d1695ca51b2ff09811314425f43a93270b69a7252 | yes |
| `Southwest Cabin Configuration Standard.rtf` | 29,274 | d15281b8b4df25e8dc1d2aed1088a7ee771d3522d25b4be57924925d2aef128b | yes |
| `gemini-code-1794587815855.json` | 548 | 881e1c40b1d259ec1f568354d542d478ce532e8fd07ccc4addf7dc6d8ac1852d | yes |
| `cabin schema architecture.csv` | 1,026 | 2e23ce574c83737b2d596c2bf8cc43e143a85020c3eb9fc751502bd33043203e | yes |
| `southwest_737_lopa_seats.csv` | 105,688 | 3ac05f450ed414ff89a9da6ce94e34a01865aaaa8327b6b0d26c25ca2794fc2a | yes |
| `southwest_737_lopa_rows.xlsx` | 15,573 | c8a3fe13238b5a7ae269c4bf8a643acbe8a9986c6de1b7e29b6b232d6a6f9e7f | yes |
| `southwest_737_lopa_configurations.csv` | 2,004 | 6244a799ac434b70b19e10d9dfbbd354f595e56ca84484a7b98672cbf2f8bdc6 | yes |
| `Current Aircraft Seat Configurations.docx` | 20,131 | 723d11ee62d028a0d2af44b8215e01d1f0723d94505c9647c9e9031ff7cfd985 | yes |
| `Southwest-Airlines-new-RECARO-seats-Video-still-Southwest.png` | 674,957 | 61b22740bc46b74633afb6155b6bc28b0b39f2852434081deefe1d184dd2ae89 | yes |
| `barrier.webp` | 93,646 | b6ee68403975b364d20dcc2bf2adc52a8c71ba6fbdc3ba3be4ef7320d2fb2909 | yes |
| `carpet.jpg` | 278,848 | 007e65eca369ef808e27da1f2623a46607a8f35062b92893a0eac00d04af5bcd | yes |
| `forward galley flight deck.jpg` | 3,352,738 | 0963d74c7e4d01dfc4a4e968f7c0da6fdac1eb2cf761eab5bbca079327c30557 | yes |
| `rear galley.jpg` | 143,251 | f9ea2338140eeb77565fd1cee857804ba8a68acef49b0d17106793a165b5ee8e | yes |
| `recarro 2.jpg` | 77,918 | 58c8c019e04bc4ec32de62e667f2785e117f41623c60f7ee814b3e5b6f9e0c5d | yes |
| `seats 1.jpeg` | 43,764 | d6c27a49eff8a74ae6a3104de1dca18560d2e01f4f874a9788b34be76fc00ad7 | yes |
| `seats 2 .jpeg` | 30,894 | 026cdd68f87a6cb60bc160b763de7404a701d0004c1fef78e1b792e550de4eac | yes |
| `seats 3.jpg` | 410,493 | 29dae2e131d0a05db1eae3fb191c0478d65bd7a9ca71910495acee202919b29e | yes |
| `seats 4.jpg` | 3,323,626 | b108b845381296b523ba3bea5d13414e7dc885e7d40e4ed3b87cf4d8016d9bab | yes |
| `seats 5.jpg` | 443,619 | 49f16c78b6a8c4e3ac2883035b020b0c6dcf63a2102b6e7689c1eb5ef92ef9b6 | yes |
| `seats 6.avif` | 86,337 | c7929bf7ac093e66fd8c949e120551de74e394b5ad630e2454034a85c5750dfe | yes |
| `seats 8.jpg` | 102,063 | 94985372ea11685c4a37ff023fe736e9367237a5ecad5547daee57862f72d92c | yes |
| `southwest seats-7.webp` | 215,456 | a0feb22156a758b51db8ef0ea2701156e945b91db4d558782e5880f9d3d7f574 | yes |

Full detail (all metadata tags, structure, cross-checks): `inventory.json`.

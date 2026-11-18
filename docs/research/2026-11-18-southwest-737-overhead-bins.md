# Southwest Airlines 737 overhead stowage bins: research for the cabin-check 3D model

Date: 2026-11-18. Status: desk research from public sources only. No AMM, IPC, CMM or Southwest engineering data was available.

Conventions:
- **[S1]**-style tags point to the Sources list.
- **UNCONFIRMED** means no public source was found.
- **INFERENCE** means a conclusion drawn here, not stated by any source.
- "snippet-only" means the claim came from a search-result summary and the page itself was not fetched (403, 404 or not attempted).

---

## Summary

- **Fleet.** Southwest flies only Boeing 737s. As of September 2026 Wikipedia lists 271 737-700s, 189 737-800s and 343 737 MAX 8s, a total of 803 [S1]. The 737 MAX 7 is on order (269) and is "expected to enter service in 2027" [S1]. Other sources give slightly different counts (see Fleet).
- **Three bin generations.** Three bin generations are relevant:
  - Pre-Sky-Interior 737NG bins, most likely on the 737-700.
  - Boeing Sky Interior (BSI) pivot bins, on most 737-800s and MAX 8s originally.
  - Boeing Space Bins (larger pivot bins), on new MAX 8 deliveries and being retrofitted to -800s and MAX 8s [S2][S3][S4].
  Southwest's own release says only "larger overhead bins" and never uses the name "Space Bins" [S2]. The "Space Bins" identification comes from secondary sources [S4][S5].
- **Retrofit in progress.** About 20% of the fleet had the larger bins in October 2025 [S6]. Southwest targets about 70% by the end of 2026 [S7][S4], roughly all -800s and MAX 8s [S4]. Whether the 737-700 will get Space Bins is disputed (see Fleet).
- **Modelling implication (INFERENCE).** Bin type is a **per-tail attribute**, not a per-variant attribute, for the -800 and MAX 8. The model should carry `binType ∈ {legacyNG, bsiPivot, spaceBin}` per aircraft.
- **Capacity.** Boeing's figures:
  - Space Bins hold 6 standard 9 × 14 × 22 in bags per bin, against 4 for BSI pivot bins [S3][S8].
  - Aircraft totals are 118 → 174 or 178 bags (737-800 / MAX 8) and 90 → 130 or 134 bags (737-700 / MAX 7). Boeing's own sources disagree between the two figures [S3][S4].
- **Gaps.** No public source gives bins per side, the individual bin lengths for Southwest, or Southwest's bin-numbering scheme. These remain open.

---

## Fleet and bin types

### Fleet counts (sources disagree)

| Variant | Count | Seats | Source |
|---|---|---|---|
| 737-700 | 271 | 137 | Wikipedia fleet table, Sep 2026 [S1] |
| 737-800 | 189 | 175 | [S1] |
| 737 MAX 8 | 343 | 175 | [S1] |
| 737 MAX 7 | 0 in service, 269 on order | 150 (planned) | [S1]. "Expected to enter service in 2027." |

Other counts:
- Simple Flying (19 Sep 2026) lists 272 / 188 / 338, a total of 798 [S4].
- AeroLOPA lists 277 737-700s and 204 + 46 737-800s split across two cabin versions [S9]. Those totals do not match the others, and AeroLOPA's fleet numbers may be stale.
- A secondary report says the MAX 7 was FAA-certified on 3 Aug 2026 (snippet-only, via aerocorner.com [S10]). This is UNCONFIRMED against an FAA source.

### Bin type by variant

| Variant | Factory bin | Retrofit status (Nov 2026) | Confidence |
|---|---|---|---|
| 737-700 | Most likely pre-BSI 737NG bins (INFERENCE: [S4] says the Sky Interior is on all -800s and MAX 8s, without listing the -700). Boeing's generations are "Standard Bins (1998)" and "BigBins (2002)" [S3]. Which one Southwest's -700s carry is UNCONFIRMED, and so is their current bag capacity. [S4]'s "90 to 134" uses Boeing's pivot-bin baseline for the type, not a Southwest-specific figure. | Disputed. Simple Flying says a -700 bin retrofit "would require a Supplemental Type Certificate" and that it is "unclear" whether -700s will get Space Bins [S4]. Simple Flying (Oct 2025) says -700 retrofits start in the second half of 2026 and finish by mid-2027, but the work it describes is for in-seat power, and it does not say the -700s get bins [S6][S11]. Seatcompare.ai (updated Oct 2026) says -700s now have "pivot-style Boeing Space Bins" [S12]. That claim conflicts with [S4] and is treated as low-confidence. No Southwest-held STC was found, but only a web search was done; the FAA DRS was not queried. | Low |
| 737-800 | BSI pivot bins on most aircraft. Simple Flying says all -800s and MAX 8s have the Sky Interior and "most" have the original BSI bins [S4]. | Being retrofitted with larger bins [S2][S4]. Southwest has about ten 737s per night in work at its Dallas, Houston, Phoenix, Atlanta, Orlando and Denver maintenance facilities [S4]. | Medium |
| 737 MAX 8 | Early deliveries (from 2017) have BSI pivot bins [S4]. AeroLOPA's base MAX 8 layout is labelled Space Bins + Sky Interior + "Heart" interior [S15], which disagrees with [S4] ("most" still have the original BSI bins); AeroLOPA may reflect newer tails. Later deliveries have the larger bins [S2][S6]. The Feb 2024 release already says "All new 737 MAX 8 aircraft delivered … [have] larger overhead bins" [S2]. Business Insider (Oct 2021) said Southwest "opted for conventional bins" at that time [S5]. That is a difference in date, not a contradiction. | Retrofit in progress, alongside the -800 [S2][S4]. | Medium |
| 737 MAX 8, "2025 Elevated cabin" (first aircraft N8972S, in service 16 Oct 2025) | Larger bins plus RECARO R2 seats, a refreshed BSI lighting package and 46 Extra Legroom seats [S13][S14][S6]. | Factory-fitted on all new deliveries [S6]. | Medium-high |
| 737 MAX 7 | Not in service, so UNCONFIRMED. Boeing quotes MAX 7 Space Bin capacity, so Space Bins are an option [S3][S4]. | n/a | Low |

The "2025 Elevated cabin" refresh does not introduce a new bin product. Sources describe it as the larger bins together with new seats, power, Extra Legroom and a lighting refresh [S13][S6]. No source names a bin supplier other than Boeing. No public evidence was found linking Diehl, Collins or Safran bins to Southwest. A Safran/C&D Zodiac patent describes pivot bins in general terms only [S16].

---

## Sizes and counts

### Bags per bin and per aircraft (Boeing figures; reference bag 9 × 14 × 22 in)

| Bin generation | Bags per bin | 737-700 / MAX 7 | 737-800 / MAX 8 | 737-900ER / MAX 9 | Source |
|---|---|---|---|---|---|
| Standard Bins (1998) | — | — | — | 77 | [S3] |
| BigBins (2002) | — | — | — | 125 | [S3] |
| BSI pivot bins (2010) | 4 | 90 | 118 | 132 (Alaska's own count: 117) | [S3][S8] |
| Space Bins (2015) | 6 | 130 [S3] / 134 [S4] | 174 [S3] / 178 [S4] | 194 [S3] / 198 [S8] (Alaska's own count: 174) | [S3][S4][S8] |

Where the sources disagree:
- **Boeing's own totals.** Boeing's 2014/2015 releases give 174 and 130 bags [S3][S17]. The later Boeing product page and Alaska's release give 178, 134 and 198 [S8], as relayed by [S4]. The Boeing product page itself now returns 404.
- **Percentage increase.** Sources quote "48 percent" [S8], "50 percent" [S3][S7] and "60% more bags" [S6]. The 60% figure is probably a garbled version of the 60 extra bags (178 − 118 = 60).
- **Bag orientation.** Simple Flying says Space Bins "fit luggage sideways" [S4]. The fetched Business Insider article [S5] does not address flat versus on-side.

### Bin length

- Business Insider describes "Boeing's 60-inch Space Bins" [S5].
- Boeing's parts-shop listing titles show other sizes, for example a "Bin Bucket Assembly-28 Inches" (412A7110-1327D) [S18] and latch assemblies in 43, 47 and 53 inch lengths (659A4000-26, -30, -36) [S18]. Their 737 applicability comes from search snippets only; the pages returned 403.
- INFERENCE: bins probably come in **mixed lengths**. This rests on unverified listing titles. No source says shorter bins sit near the doors, over the wings or at the aft galley. Which lengths sit where on Southwest aircraft is UNCONFIRMED.

### Bins per side

- **UNCONFIRMED.** No public source gives a per-side count for any Southwest variant.
- INFERENCE, labelled: 118 ÷ 4 = 29.5 and 178 ÷ 6 ≈ 29.7. Neither is a whole number, which also suggests mixed bin lengths and capacities. These figures are not a bin count and must not be used as one.
- Seat-map context:
  - MAX 8 rows run 1–30, all economy, 175 seats [S15].
  - 737-700 rows reportedly run 1–9 and 14–27, 137 seats [S12]. This source is low-confidence.

### Bin size or count as a configuration differentiator

- Bin generation changes capacity by about 50% at the same seat count (118 vs 178 on a 175-seat -800 / MAX 8) [S3][S4]. For an inspection model the useful key is binType per tail, not variant.
- Space Bins hang about 2 in lower when open [S8] and "sit two inches lower in the cabin, which reduces headspace" [S5]. Bin geometry therefore differs visibly between configurations.
- Southwest-specific allocations also change bin use without changing hardware:
  - Crew-only bins have been above rows 2–3, and the forward ones lock on some aircraft [S19].
  - In Feb 2026 Southwest decided to move dedicated crew bin space to the rear of the cabin [S19].
  - In March 2026 it added signage reserving bins over Extra Legroom rows [S7][S4].
  - Southwest has said it will fit locks on crew bins on all aircraft. This is snippet-only, from TravelPulse/AOL search results [S20], and UNCONFIRMED.

---

## How each bin opens

| Bin type | Opening motion | Visible when open | Source |
|---|---|---|---|
| Pre-BSI 737NG bins (likely -700) | UNCONFIRMED from a primary source. The 737 Classic bin (ex-Southwest 737-300) is described as derived from the 757 "Advanced Technologies Interior" (snippet-only) [S21]. Whether it is a hinged up-swinging door over a fixed shelf could not be confirmed. | UNCONFIRMED | [S21] |
| BSI pivot bin | Runway Girl describes BSI "bins that pivot up and out of the way" [S30]. The whole bucket pivots downward to open on side pivots, rather than a door lifting up (bucket-pivot geometry from the patent reference [S16]; not confirmed for the Boeing part). When closed it partially retracts into the ceiling (NPR, snippet-only) [S22]. Trade press describes a handle that engages a cam to shift the pivot point and ease closing (snippet-only) [S22]. Boeing says pivot bins use a "bin assist mechanism" [S3]. Patent background describes assist springs and a lock-open detent position (snippet-only) [S23]. | Bucket floor and inner walls, bucket side panels, the fixed upper housing (strongback), latch hardware and the bucket lip | [S3][S22][S23] |
| Space Bin | Also a pivot (bucket) bin. Sources for this are thin: Seatcompare calls them "pivot-style" [S12] and a search snippet says they "pivot up and away from the aisle" when pushed closed (not confirmed on fetch of AirlineGeeks [S31]). It is "as easy to close as the current pivot bins, but require[s] no bin assist mechanism" [S3][S17]. When open its bottom edge hangs about 2 in (5 cm) lower, giving a lower lip and better view into the back [S8][S17]. | A deeper bucket that fits bags sideways [S4]. Otherwise as for the BSI pivot bin. | [S3][S8][S17] |

Generic pivot-bin anatomy (Safran/C&D Zodiac patent US10000286B2) [S16]. This is a reference design, not a confirmed Southwest or Boeing configuration.
- A **bucket** pivots on axles at each side of a fixed **upper housing (strongback and side panels)**. The housing may integrate a PSU channel and a lighting valence.
- Left and right **latch assemblies** are each a hook plus a **striker**, mounted one on the side panel and one on the bucket. A **release button** sits on the bucket.
- **Rotary dampers** or gas or fluid cylinders slow the bucket as it opens.
- A coil **assist spring** is preloaded as the bucket opens fully.
- **Stop members** limit how far the bucket opens.

---

## Bin parts

Basis of the "Cosmetic or safety" column (regulation, not Southwest's MEL or AMM):
- 14 CFR 25.787 requires stowage compartments to be designed for their **placarded maximum weight** and emergency-landing loads. Latched doors in passenger areas must account for wear and deterioration [S24].
- 14 CFR 25.1557(a) requires each baggage compartment to have a placard stating content limitations [S25].
- 14 CFR 121.589 requires carry-ons to go in compartments "placarded for its maximum weight" and overhead racks to have "approved restraining devices or doors" [S26].

Any part that affects retention (latch, striker, hinge or pivot, attach structure) or the required placards is therefore airworthiness-related. Finish items are cosmetic. **Southwest MEL relief for bin items is UNCONFIRMED.** No public MMEL or policy-letter entry for 737 bin latches was found.

Part numbers below are **titles of public Boeing parts-shop listings seen in search results**. The pages returned 403, so applicability to a given 737 or Southwest tail is **unverified**. Do not treat them as Southwest's fitted parts.

| Part | Bin type | Cosmetic or safety | Belongs to | Notes / public part numbers | Source |
|---|---|---|---|---|---|
| Bucket (bin body, pivoting) | BSI pivot, Space Bin | Safety (structure and retention) plus cosmetic face | Bin | "Bin Bucket Assembly-28 Inches…" 412A7110-1327D (listing title) | [S16][S18] |
| Door (separate hinged panel) | Pre-BSI NG only (UNCONFIRMED) | Safety (retention) plus cosmetic | Bin | — | [S21] |
| Latch / handle / release button | All | **Safety** | Bin | Listing titles: "Classic Bin Latch Assembly" 412A1281-1B; "Big Bin Latch Assembly" 412A1282-1B; bin latch assemblies 659A4000-26 (43 in), -30 (47 in), -36 (53 in); Hartwell "Door Latch With Lock Overhead Stowage Bin" HA951-3. Kapco PMA latch HA225-7ATS (OEM Hartwell HA225-7) for the B737NG bin door, shroud 131728-1ATS (snippet-only). | [S18][S27] |
| Latch striker / keeper | All | **Safety** | Bin (on the bucket or housing) | No public part number found | [S16] |
| Damper / assist spring / gas strut | BSI pivot ("bin assist mechanism"). The Space Bin has no assist [S3]. | Functional. Safety only if the bin fails to stay open or closed (INFERENCE). | Bin | No public 737 part number found | [S3][S16] |
| Hinge / pivot axle and clevis | All | **Safety** | Bin | — | [S16] |
| Stop / bumper | Pivot bins | Functional or cosmetic | Bin | "Bin Stop Rubber Bumper" 422W1127-48B is excluded as probably not 737: Boeing's "W" drawing prefix is typically 777 (INFERENCE, unverified). | [S18] |
| Closeout seals between bins | All | Cosmetic or fit | Bin installation | Listing titles: "Closeout Seal Detail-Stowage Bins" 403A3210-189J (snippet says 737-800 / MAX 8) and "Seal Detail-Stowage Bins" 403A3210-159J | [S18] |
| Side / end panels, upper housing (strongback) | All | Safety (structure) plus cosmetic | Bin | "Overhead Stowage Bin Installation-Forward Left Hand" 412A7010-1B (listing title) | [S16][S18] |
| Floor liner / mat | All | Cosmetic | Bin | UNCONFIRMED whether Southwest uses a separate liner. No listing found. | — |
| Rub strips / edge trim | All | Cosmetic | Bin face | No bin-specific listing found. The rub-strip listings found were for other areas. | [S18] |
| Max-weight placard | All | **Safety (regulatory)** | Bin | Required by 25.787, 25.1557 and 121.589 | [S24][S25][S26] |
| Crew-only and Extra Legroom placards or signage, crew-bin lock | Southwest-specific | Operational (airline policy) | Bin face | Above rows 2–3, moving aft (Feb 2026); Extra Legroom signage from Mar 2026 | [S19][S7] |
| Bin-number or row labels | — | Cosmetic or operational | Probably PSU or bin edge (UNCONFIRMED) | See Numbering | — |
| Interior lighting lens | — | — | Not a bin part on the 737 (UNCONFIRMED) | No source shows lighting inside 737 bins. BSI LED lighting is ceiling and sidewall wash [S22]. A patent places a lighting valence on the fixed housing [S16]. | [S16][S22] |
| PSU (reading lights, gasper, oxygen, signs) | — | Safety (oxygen) | **Adjacent assembly** under the bins | The patent describes the housing integrating a PSU channel [S16]. 737 PSU / life-vest-panel AD activity exists (Federal Register 2016-24508, snippet-only, not fetched). | [S16] |
| Sidewall and ceiling panels, BSI lighting | — | Cosmetic (lighting is functional) | **Adjacent assemblies** | — | [S22] |
| Bin modification (1992) | Pre-NG 737s | Safety | Bin | AD 92-19-16 required modifying overhead bins on 737s listed in a Boeing alert service bulletin, with different compliance times by bin category, including bins holding a life raft or video equipment (snippet-only; PDF returned 403). Likely pre-NG and not applicable to Southwest's current fleet (INFERENCE). | [S32] |
| Center overhead stowage (COS) boxes | Optional, not passenger outboard bins | Safety | Adjacent or optional | AD 2013-02-07 (Boeing SB 737-25-1641) required brackets and stiffeners because COS boxes "could fall from their supports" at under 9 g. The boxes "typically contain life rafts, palletized equipment". Whether Southwest has COS boxes is UNCONFIRMED. | [S28] |

---

## Numbering

- **UNCONFIRMED.** No public source describes how Southwest numbers or labels individual bins. No source confirms whether row numbers sit on the bin lip or on the PSU.
- Related facts:
  - Southwest identifies bins operationally by the seat rows beneath them, for example "crew bins above rows 2 and 3" [S19] and bins "above Extra Legroom seats" [S7].
  - Special-livery aircraft carry bin artwork or names mounted on the bins [S1].
- Modelling suggestion (INFERENCE): key bins as `side (L/R) + row span` and add a separate optional `label` field for any physical bin marking.

---

## Open questions

1. Which pre-BSI bin (Standard or BigBins) Southwest's 737-700s have, and how its door opens.
2. Whether any 737-700s have received or will receive Space Bins, and whether a Southwest STC exists. [S4] conflicts with [S12].
3. Bins per side, and the length and position of each bin (door zones, overwing, aft galley), for each variant and binType.
4. Which aircraft have been retrofitted (a tail list). The figures available are about 20% in Oct 2025 and a 70% target by the end of 2026 [S6][S7].
5. Southwest bin-label and row-number placement, and placard text and locations.
6. Whether Southwest bins have a separate floor liner, and which rub strips and trim it uses.
7. Southwest MEL items for bin latches or bins placarded inoperative.
8. Confirmed 737 applicability of the Boeing parts-shop part numbers. Every shop page returned 403.
9. Resolved: Federal Register 2024-28786 is AD 2024-24-07 on the CL-600-2B19 regional jet (bin hook assemblies and support tubes), not the 737 [S29]. No current 737 passenger-bin latch AD was found.
10. The definitive Space Bin bag counts (174 vs 178, 130 vs 134).

---

## Sources

- [S1] Wikipedia, Southwest Airlines fleet (table as of Sep 2026). https://en.wikipedia.org/wiki/Southwest_Airlines_fleet
- [S2] Southwest Airlines, press release, 2 Feb 2024. https://investors.southwest.com/news-events/press-releases/detail/93/southwest-airlines-plans-customer-experience-enhancements-and-modernization-of-brand-elements-with-a-redesigned-cabin-new-seats-and-a-uniform-refresh
- [S3] Boeing, "Boeing Showcases Space Bins at Aircraft Interiors Expo", 14 Apr 2015. https://boeing.mediaroom.com/Boeing-Showcases-Space-Bins-at-Aircraft-Interiors-Expo
- [S4] Simple Flying, "Inside Southwest Airlines' Secret Overnight Operation To Retrofit 10 Boeing 737s Per Night", 19 Sep 2026. https://simpleflying.com/inside-southwest-airlines-secret-overnight-operation-to-retrofit-10-boeing-737s-night/
- [S5] Business Insider via Yahoo, "Overhead bins on planes are getting bigger", 17 Oct 2021. https://www.yahoo.com/news/overhead-bins-planes-getting-bigger-125200212.html
- [S6] Simple Flying, "Southwest Airlines Officially Debuts Updated Cabin Interior On New Boeing 737 MAX 8", 15 Oct 2025. https://simpleflying.com/southwest-airlines-debut-updated-cabin-interior-new-boeing-737-max-8/
- [S7] The Points Guy, "Southwest Airlines refining boarding, overhead bin policies", 2 Mar 2026. https://thepointsguy.com/news/southwest-airlines-refining-boarding-overhead-bin-policies
- [S8] Alaska Airlines newsroom, first 737 with Space Bins, 9 Oct 2015. https://news.alaskaair.com/newsroom/alaska-airlines-increases-overhead-storage-nearly-50-percent-with-first-737-featuring-new-boeing-space-bins/
- [S9] AeroLOPA, Southwest aircraft index. https://www.aerolopa.com/wn
- [S10] AeroCorner, "How many planes does Southwest have" (snippet-only). https://aerocorner.com/blog/how-many-planes-does-southwest-have/
- [S11] Runway Girl Network, "Southwest's first new 737 MAX with refreshed cabin enters service", Oct 2025. https://runwaygirlnetwork.com/2025/10/southwest-airlines-first-new-737-max-with-refreshed-cabin-enters-service/
- [S12] Seatcompare.ai, Southwest 737-700 seat guide (updated 21 Oct 2026; low-confidence). https://seatcompare.ai/insights/southwest-airlines-737-700-seat-selection-guide-2026
- [S13] One Mile at a Time, Southwest new cabins, 15 Oct 2025. https://onemileatatime.com/news/southwest-airlines-new-cabins-seats/
- [S14] Runway Girl Network (same article as S11): N8972S with 175 seats and 46 Extra Legroom seats, refreshed BSI lighting. https://runwaygirlnetwork.com/2025/10/southwest-airlines-first-new-737-max-with-refreshed-cabin-enters-service/
- [S15] AeroLOPA, Southwest 737 MAX 8. https://www.aerolopa.com/wn-7m8
- [S16] US10000286B2, "Pivot bin assembly with lift assist" (C&D Zodiac, now Safran Cabin). https://patents.google.com/patent/US10000286
- [S17] Boeing, "Boeing's Space Bins Make Room for More Bags on 737s", 10 Jul 2014. https://boeing.mediaroom.com/2014-07-10-Boeings-Space-Bins-Make-Room-for-More-Bags-on-737s
- [S18] Boeing parts shop listing titles, seen in search results; pages returned 403:
  - https://shop.boeing.com/cpd/bpp_412a7110-1327d
  - https://shop.boeing.com/cpd/bpp_412a1281-1b
  - https://shop.boeing.com/cpd/bpp_412a1282-1b
  - https://shop.boeing.com/cpd/bpp_659a4000-26
  - https://shop.boeing.com/cpd/bpp_659a4000-30
  - https://shop.boeing.com/cpd/bpp_659a4000-36
  - https://shop.boeing.com/cpd/bpp_ha951-3
  - https://shop.boeing.com/cpd/bpp_403a3210-189j
  - https://shop.boeing.com/cpd/bpp_403a3210-159j
  - https://shop.boeing.com/cpd/bpp_412a7010-1b%23j
  - https://shop.boeing.com/cpd/bpp_422w1127-48b
- [S19] View from the Wing, Southwest crew bins moved aft, 13 Feb 2026. https://viewfromthewing.com/southwest-flight-attendants-furious-after-airline-moves-their-bags-to-back-of-plane-passengers-will-steal-them/
- [S20] TravelPulse, Southwest "refining" assigned seating (snippet-only). https://www.travelpulse.com/news/airlines-airports/southwest-refining-assigned-seating-policy-following-customer-backlash
- [S21] Air Sky Store, Boeing 737 Classic overhead bin listing (snippet-only). https://airskystore.com/shop/boeing-737-classic-overhead-bin/
- [S22] NPR, "Airline 'Sky' Cabins Roomier and More Colorful", 31 May 2011 (snippet-only), https://www.npr.org/2011/05/31/136818890/airline-sky-cabins-roomier-and-more-colorful. AIN, Farnborough 2010 (snippet-only), https://oldain.ainonline.com/aviation-news/2010-07-16/boeing-brings-blue-sky-interior-737
- [S23] Boeing pivot bin patent application (snippet-only). https://patents.justia.com/patent/20130206903
- [S24] 14 CFR 25.787, Stowage compartments. https://www.law.cornell.edu/cfr/text/14/25.787
- [S25] 14 CFR 25.1557, Miscellaneous markings and placards. https://www.law.cornell.edu/cfr/text/14/25.1557
- [S26] 14 CFR 121.589, Carry-on baggage. https://www.law.cornell.edu/cfr/text/14/121.589
- [S27] Proponent/Kapco PMA latch assembly sheet (snippet-only; 403). https://www.proponent.com/wp-content/uploads/2018/01/25-Latch_Assembly_ATS_LC.pdf
- [S28] FAA AD 2013-02-07, Amendment 39-17328, 78 FR 6200, 30 Jan 2013 (EASA mirror PDF, text extracted). https://ad.easa.europa.eu/blob/20130207.pdf/AD_US-2013-02-07_1
- [S29] Federal Register 2024-28786, AD 2024-24-07 (MHI RJ CL-600-2B19; not 737). https://www.govinfo.gov/content/pkg/FR-2024-12-09/html/2024-28786.htm
- [S30] Runway Girl Network, "Boeing Sky Interior offered for 737NG retrofits", 30 Dec 2013. https://runwaygirlnetwork.com/2013/12/30/boeing-sky-interior-offered-for-737ng-retrofits/
- [S31] AirlineGeeks, "Alaska Airlines Increases Overhead Storage Using New Bins", 9 Oct 2015 (bins hang about 2 in lower and are easier to close). https://airlinegeeks.com/2015/10/09/alaska-airlines-increases-overhead-storage-using-new-bins/
- [S32] FAA AD 92-19-16 (snippet-only; 403). https://www.faa.gov/sites/faa.gov/files/2022-11/92-19-16.pdf

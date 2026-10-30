# Data map

Which report answers which question, where the header row sits, and how each
one lies. Verified against the 7 September 2026 refresh.

---

## The nine reports

Verified against the **3 October 2026** refresh (`Cin7 Refresh 03102026`).

| Report | Header row (0-idx) | Answers | Rows 3 Oct |
|---|---|---|---|
| AvailabilityReport (CSV) | 0 | stock, allocated, on order, PriceTier2 | 6,105 |
| Sale Order Details | 5 | demand by order date, line level | 9,231 |
| Customer Orders by Product | 5 | invoiced sales — what shipped | 8,420 |
| Sale Overview | 4 | status ladder, payment state | 725 orders |
| Sale Backorder Details | 0 | committed customer orders | 687 |
| Sale Outstanding Quotes | 6 | uncommitted interest | 1,756 |
| Inventory Movement Details | 5 | stock movement history — **12 months, stock movement date** | 33,903 |
| Pending Purchase Orders | 4 | inbound still to arrive | 584 |
| Purchase Order Details | 5 | what was ordered, cost, invoice status | 2,118 |

Header rows differ per report and have changed before. Verify each export rather
than assuming. Header rows were identical on 7 September and 3 October.


## Which number to use for demand

**Sale Order Details `Sale`.** Nothing else.

`Sale Overview` has a `Sale` column and it is **not** order value. It reads zero
until the order is invoiced. On the 7 September refresh, the same 460 orders
came to $929,085.65 in Sale Order Details and $623,821.20 in Sale Overview, and
only 188 of the 460 matched. The largest single gap was SQ36955 at $35,895
against zero. Use Sale Overview for the status ladder and payment state only.

---

## Traps — first confirmed 7 Sep; re-confirmed 3 Oct where marked

**Sale Order Details omits orders at Ordering and Estimating status.** *(re-confirmed 3 Oct: 69 orders, 65 at Ordering.)* 63 orders
appear in Sale Overview and not in Sale Order Details: 50 Ordering, 7 Estimated,
3 Closed, 2 Estimating, 1 Completed. Their combined Sale Overview value is
minus $22.95, so **they carry no value in either report** — the only place that
demand is visible is the Outstanding Quotes report. That makes the quotes export
load-bearing, not optional.

Confirmed on the corrected quotes export: 38,114 units and $806,452 ex-tax sit
in open quotes that Sale Order Details cannot see at all.

**The availability report carries other businesses.** *(re-confirmed 3 Oct: 3,168 of 6,105 rows are Rhino Rhino.)* 2,982 of 5,919 rows are
`Category = "Rhino Rhino"`. The rest is `custom` (2,406 rows, Project Clothing
and AAMI umpire uniforms), `Shopify` (406) and `Service` (125). All carry zero
stock and zero on-order so totals are unaffected, but they will pollute any SKU
join or count. **Filter on Category.** 126 rows have a blank Brand.

**A SKU absent from the availability report is absent, not zero.** It only
returns SKUs with a stock record, so new lines vanish from every join.

**`Available` excludes incoming, `OnHand` does not.** `InTransit` is zero across
the whole file — it is not in use here, so `OnOrder` is the only forward signal.

**Outstanding Quotes is tax inclusive.** Every other report is exclusive. Divide
by 1.10. Blank-brand rows are freight and the 1.5% card surcharge — strip them.

**The backorder report has no Customer column**, so internal accounts cannot be
excluded from it.

**Internal accounts distort totals.** `RHINO RHINO TEST` and `Rhino Rhino
Marketing` are 299 of 6,942 Sale Order Details rows on this refresh. Exclude
them everywhere they can be identified.

**Status values mislead.** Backorder lines stay flagged Backorder with ship
dates already past. Supplier lines marked Received can have nothing physically
packed weeks later.

**The migration boundary is 1 July 2025.** Order numbers run `Q…` before it and
`SQ…` after. No opening balance exists, so earlier stock cannot be reconstructed
and an apparent customer-count collapse across the boundary is an artefact.

---

## On-order is not always free stock

**Check every large pending PO against the open quotes before treating it as
supply.** PO-00082 (30,133 units, IBTT, 15 June) is a back-to-back against MeeQ
Chadstone quote SQ36627 (16 June). All ten SKUs match and every quantity matches
exactly. That stock is sold before it lands.

Counting it as available forward supply overstates Miffy cover at 22.5 months
against a real uncommitted position of 18.9. The custom SKUs carry an
`IBTTCM…` prefix and have no sales history, so they add nothing to the demand
rate while adding 30,133 units to on-order — the distortion runs one way only.

The same logic applies to the quote side: 79% of all quoted units on this
refresh are that single order. Genuine uncommitted interest is 7,981 units,
not 38,114.

---

## Invoiced sales can exceed ordered sales — check for custom shipments

On the 3 October 2026 refresh, Customer Orders by Product showed $1.92m invoiced
against $1.22m ordered for the same July–October window. Not an error: 35,533 units
of custom Miffy for MeeQ were ordered before July and shipped inside the window.
**Never use invoiced sales as demand in a window containing a custom shipment** —
strip the `IBTTCM…` SKUs first, or use Sale Order Details.

## Twelve-month movement reconstruction

From the 3 October 2026 refresh, Inventory Movement Details covers a full twelve
months (Stock movement date mode). Walking it back from current OnHand gives a
plausible opening balance on 5,535 of 5,543 SKUs. Eight imply negative stock at
the window start — Cin7 allowed stock to go negative — and three materially so:
BL01BS (−155), IBTT24182617 (−491), IBTT33177023 (−302). Treat stockout
reconstruction on those three with caution.

---

## Authoritative files — use these, not lookalikes

Folder cleanup on 3 October 2026 moved superseded drafts into `_to_delete\` folders
beside where they sat, and superseded guidance into `Ordering\_ARCHIVE\`. Each has
a README. Where names mislead, this table is the authority.

| Brand / topic | Authoritative | Do not use |
|---|---|---|
| IBTT SS27 order (PO-00088) | `IBTT\New Order Form\IBTT - Distributor Order Form SS27 - Rhino Rhino completed PO-000088 (Submitted).xlsx` | anything in `IBTT\_to_delete\`, incl. "FINAL 21-08" |
| IBTT method and decisions | `IBTT\New Order Form\IBTT ORDERING - OPERATING ARCHIVE.md` | the older "COMPLETE ANALYSIS ARCHIVE" files |
| MTD September order | `September Orders\MTD\MTD ORDER 09092026 - FINAL.xlsx` | the five drafts in `_to_delete` |
| Mr Maria September order | **Two files, both needed:** `...FILLED 07092026 v3 (launch-rate fix).xlsx` has the corrected rates; `...v2 (split lead time).xlsx` holds **Sean's own edits** — the China pallet request block and pallet columns. Not merged. | — |
| Just Dutch | `September Orders\Just Dutch\Just Dutch Ordering - FILLED 10092026.xlsx` (order held 2–3 weeks; re-run before placing) | — |
| Meri Meri top-up | `Meri Meri\Final Meri Meri File\Final Top up Order - 20August2026.xlsx`, approval PDF 23-08; checklist `Meri Meri\MERI MERI - ORDER CHECKLIST.md` | `_to_delete` folders within Meri Meri |
| Liewood August top-up (PO-00089) | `Liewood August Topup\Final PO-00089 Paperwork\Liewood PO-00089 FINAL.xlsx` | the archived spoke briefs (wrong increment rule) |
| Liewood SS27 buy | `SS27 Order\Jenny's Preliminary Order\Liewood SS27 Buy Shortlist (colour-level)_Jenny Done Second Version.xlsx` | `Liewood SS27 Buy Shortlist (updated).xlsx` — the **oldest** despite its name. Left in place because Jenny's area. |
| Liewood Essential flags, pricing, Liewood's own order book | `Liewood 2.27 (From Colleague 03102026)\Liewood Master File.xlsx` (2 Oct 2026) | the June 2026 Liewood models — archived 3 Oct |
| Liewood 2.27 pre-order (colleague's work) | `Liewood 2.27 (From Colleague 03102026)\` — **read-only**; start with `Liewood 2.27 Handover.md`. New workings go in `Liewood 2.27 Workings\` | — |
| Availability for any analysis | `Cin7 Refresh 03102026\AvailabilityReport_2026-10-03.csv` | the 2 Oct availability in the colleague's folder — a day older and different |
| MTD analysis | `September Orders\MTD\MTD ORDER 09092026 - FINAL.xlsx` and `Brands\BRAND - MTD.md` | the July `MTD Analysis` — archived 3 Oct |
| Atelier Pierre / AP Junior | no current working exists; `8th july Atelier Pierre\Atelier Pierre Order Assessment.xlsx` is July and **predates the Cin7 brand split** — re-run before relying on it | — |
| Clearance and slow stock | `Clearance & Specials\` (incl. `ANALYSIS RULES - Rhino Rhino Stock & Clearance.md`, moved there 3 Oct) — **not yet reviewed against the current method** | — |
| Two closed sales years | `Cin7 Auto\_base\SALES BASE - FY2425 + FY2526 (frozen).csv` | `Sales\Combined to 2026-07-08\` (moved; every "demand" row was a quote) |

## Cin7 brand labels that changed — check before comparing years

**Atelier Pierre was split around July 2026.** In FY25/26 the Cin7 brand "Atelier
Pierre" held the whole Vanhalst range — mostly the kids lines (`MNI-`, `MND-`, `MNB-`)
plus 192 units of lamps (`APC-`). From July the kids lines carry the brand **"AP
Junior"** and "Atelier Pierre" is lamps only. So Atelier Pierre now *looks* like it
has 0.4 months of cover and AP Junior *looks* like a three-month-old brand. Neither is
true. Combine them, or map by SKU prefix, before any year-on-year comparison.

**"Miffy Plush - Custom" is a separate Cin7 brand** holding the `IBTTCM…` custom
SKUs, many prefixed "PAID". At 3 October 2026 it had **24,733 units on hand and
available — pre-sold, paid stock awaiting delivery to MeeQ**, plus 9,072 on order
(PO-00091). Never include it in Miffy cover or free supply.

---

## Reconciliation that passed

Availability `OnOrder` totalled 140,516 units. Pending Purchase Orders
`To receive` totalled 140,516 units. Exact match.

That proves Cin7 agrees with itself and that no pending PO sits outside the
12-month report window. It does **not** prove the picture is complete — see
`OPEN ITEMS.md`. Both reports read from the same system, so a PO missing from
Cin7 is missing from both and the check cannot see it.

---

## Report date ranges to request

Ranges are capped at 12 months. From a run date, request 12 months back for the
rolling reports and 1 July of the current financial year for the year-to-date
ones. Full detail in `..\Knowledge Base\CIN7 REFRESH - CHECKLIST.md`.

*Last updated 3 October 2026.*

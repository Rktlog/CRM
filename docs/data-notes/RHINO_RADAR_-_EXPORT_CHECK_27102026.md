# Rhino Radar export check — 27 Oct 2026

What was checked: the nine files in `Cin7 Refresh (Rhino Radar) 27102026\`. Each was compared with the DEAR exports of 3 Oct 2026 (`Cin7 Refresh 03102026\`) and the frozen sales base, over the period both cover. All figures are Rhino Rhino category only unless stated.

## Verdict per report

| # | Report | Usable? | Notes |
|---|---|---|---|
| 1 | Availability | **Yes, for quantities** | On hand, available and on order look right. On order equals Pending POs outstanding exactly (108,092). **No cost or price columns** (DEAR had StockValue and PriceTier1/2). Carries all categories (custom, Service, Shopify), so filter `Category = Rhino Rhino` as before. |
| 2 | Sale Order Details | **No — order dates wrong** | See fix 1. Lines and quantities match DEAR: 412 orders completed by 3 Oct, zero line differences. |
| 3 | Customer Orders by Product | Partly | Order-based, not invoiced: its units equal report 2's "Counts as a sale" units exactly (235,540). DEAR's version was invoiced. Inherits the date problem. |
| 4 | Sale Overview | Yes | 2,401 orders with statuses and payments. Probably shares the date problem (not tested). |
| 5 | Sale Backorder Details | Yes, improved | Now has a Customer column (DEAR's didn't). 141 orders, 4,657 units. |
| 6 | Sale Outstanding Quotes | **No — empty** | 0 rows. DEAR had 1,756 quote lines on 3 Oct. |
| 7 | Inventory Movement Details | **No — doesn't reconcile** | See fix 3. |
| 8 | Pending Purchase Orders | Yes, improved | Includes PO-00088 (IBTT SS27, 44,919 outstanding), which DEAR didn't show on 3 Oct. Ties to Availability on order exactly. |
| 9 | Purchase Order Details | Partly | 48 POs, PO-00037 to PO-00098. **No cost, currency or invoice columns** (DEAR had Cost and Total). |

## Fixes for the Radar team

1. **Order date.**
   - 1,890 of 2,061 orders found in both systems are dated **one day earlier** than DEAR, which looks like a UTC/Melbourne timezone conversion. For example, SQ36712 is 1 Jul in DEAR and 30 Jun in Radar.
   - **119 orders (14,283 units)** carry a date a **median 65 days later** than DEAR's order date, sometimes after their own invoice date. For example, SQ34887: DEAR 21 Sep 2025, Radar 24 Aug 2026, invoiced 14 Jan 2026. It looks like a last-modified or re-authorised date.
   - 16,047 units (6.8%) land in the wrong month.
   - Ordering runs on order date, so this has to be DEAR's sale order date, as a local calendar date.
2. **Quotes.** Report 6 is empty. Quotes and estimates don't seem to be syncing; Sale Overview has only 1 "ESTIMATED" order.
3. **Inventory movements.** Over 27 Oct 2025 – 3 Oct 2026:
   - **Purchases match DEAR exactly** (411,778 units).
   - **Per SKU it doesn't match.** 959 of 2,683 SKUs differ from DEAR, by 31,977 units in total, and the full year reconstructs **107 SKUs to negative opening stock** (DEAR's own 12-month report: 8). Worst: Mr Maria Bundle of Light lines (BL01MF −2,701), plus Miffy, Peanuts and AP Junior lines.
   - **Likely causes:**
     - sales are dated by invoice date, not stock movement date;
     - receipts in several parts are collapsed onto one date;
     - **customer returns and credit notes are missing** (DEAR: ~2,700 units in);
     - adjustments differ: Radar shows 43,608 units, DEAR's net stock movements 33,566.
   - **What's needed:** DEAR's movement ledger (Inventory Movement / stock movements), with every movement type on its stock movement date.
4. **Cost.** Add average cost or stock value to Availability. Add cost, currency rate and line total to Purchase Order Details.
5. **ORDERING status.** These lines are flagged "Counts as a sale = No": 1,590 lines, including the 9,072-unit custom Miffy order behind PO-00091. That's fine as a default, but ordering treats Ordering-status orders as owed stock (Maison Deux, Oct 2026), so keep them in the file, as now.
6. **Sales range.** Reports 2–4 run 12 months, so they overlap the frozen sales base (to 30 Jun 2026). Use the base to 30 Jun and Radar only from 1 Jul, unless fix 1 is made and the base is rebuilt from Radar.

## For ordering until fixed

- **Use Radar for:** availability (quantities), pending POs, backorders and sale overview.
- **Still pull from DEAR:**
  - Sale Order Details (1 Jul → today);
  - Sale Outstanding Quotes;
  - Inventory Movement Details (12 months);
  - Availability, if stock at cost is needed.

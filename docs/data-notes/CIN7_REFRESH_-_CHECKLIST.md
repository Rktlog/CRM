# Cin7 refresh — what to download before an order run

The standard export set, what each one is for, and what can be skipped.
Worked here for **3 October 2026**; the pattern repeats every refresh.

Destination: a new dated folder, `Ordering\Cin7 Refresh 03102026\`.
Never overwrite a previous refresh. The old folders are the audit trail.

---

## Settings that must be right at export time

Get these wrong and the file has to be pulled again, so check before exporting:

- **All brands.** No brand filter.
- **Brand column on.** Several reports omit it by default and it cannot be
  reconstructed afterwards.
- **No status filters.** Filter later in analysis, not at export. Status
  meanings differ per report and filtering at source loses rows silently.
- **All products including zero stock** on the availability report.
- **Base currency.**

---

## Download these nine

| # | Report | Period | Answers |
|---|---|---|---|
| 1 | Availability Report (CSV) | point in time | stock, allocated, on order, in transit, PriceTier2 |
| 2 | Sale Order Details | 1 Jul 2026 → 3 Oct 2026 | demand, by order date, line level |
| 3 | Customer Orders by Product | 1 Jul 2026 → 3 Oct 2026 | invoiced sales — what actually shipped |
| 4 | Sale Overview | 1 Jul 2026 → 3 Oct 2026 | true status ladder, incl. payment status |
| 5 | Sale Backorder Details | as at today | committed customer orders, line level |
| 6 | Sale Outstanding Quotes | 3 Oct 2025 → 3 Oct 2026 | uncommitted interest |
| 7 | Inventory Movement Details | **3 Oct 2025 → 3 Oct 2026** | stock movement history — see below |
| 8 | Pending Purchase Orders | 3 Oct 2025 → 3 Oct 2026 | inbound supply still to arrive, per SKU |
| 9 | Purchase Order Details | 3 Oct 2025 → 3 Oct 2026 | what was ordered, cost, invoice status |

**Pull Inventory Movement Details for a full twelve months, not the financial year
to date.** It is the single report that most improves the analysis. Stock levels are
rebuilt day by day from it plus current OnHand, and that reconstruction is what
drives the stockout correction — on MTD it lifted individual lines two to four times
over while moving the brand total only 5%. A financial-year-to-date window can only
reconstruct stock back to 1 July, so every stockout before that has to be estimated
from the gap between a line's last sale and its replenishing PO. Twelve months of
movements removes the guesswork.

**#4 was missing from the 21 August refresh.** There is a Sale Overview for
FY25/26 but none for the current year, so quotes cannot currently be separated
from real orders in FY26/27 data. Join it to #2 on order number.

---

## Do not download

**Anything for FY24/25 or FY25/26.** Both years are closed and already on disk:

- Sale Order Details for both years is consolidated into
  `Cin7 Auto\_base\SALES BASE - FY2425 + FY2526 (frozen).csv`
- The other closed-year reports sit in `FY 24-25 (Old Cin7)\` and
  `Cin7 Refresh 21082026\Jul 2025 to June 2026\`

Note the base covers **Sale Order Details only** — one report of the seven. The
other six still need their closed-year files kept where they are.

---

## Purchase orders — reports 8 and 9

Both exist as proper Cin7 reports and replace exporting one PO at a time from
the PO screen, which is what the files in `Purchase Orders\` are.

**Pending Purchase Orders** is the one that matters for ordering. A PO counts as
pending once it is at least draft and the stock is not yet received. It carries
SKU, brand, PO number, supplier and three quantity columns: Total ordered,
In Production (not yet billed) and **To Receive** (not yet received). To Receive
across all open POs is the forward supply position, which is Step 3 of the
method.

**Its default date filter is "Last Month" and must be changed every time.** The
filter runs on PO date, not expected arrival, so on the default a PO raised in
March that still has not landed simply is not there. Set the widest range the
report allows — believed to be 12 months, so 12 months back from the run date.
Widening costs nothing: the report is already restricted to pending POs, so a
fully received order never appears however far back the range goes.

**Verify nothing sits outside that window.** Longest lead time in the book is
IBTT at roughly seven months, so a 12-month range should catch everything, but
it is not guaranteed. Sum To Receive per SKU and compare against OnOrder in the
availability report. A SKU with OnOrder the pending report does not account for
is either a PO older than the window or trap 10 — OnOrder with no supplier
document behind it. Exclude Liewood and Meri Meri from this check while their
POs are still not loaded.

Neither cost price nor non-inventory items are included.

**Purchase Order Details** is the record rather than the decision tool: 40+
fields including PO number, date, status, supplier, SKU, brand, cost, line
totals, currency rate, required delivery date and invoice status. Filtered by
purchase order date, so it also needs a wide range. Cloned POs and service-only
purchases are excluded. Exports to Excel, PDF or RTF.

Both need the Purchase Reporting permission.

Standing conflict: Cin7 `OnOrder` can carry supply not traceable to any supplier
document, and supplier paperwork can exist with no Cin7 record. Decide which is
authoritative for a given run and state it — the two disagree.

## Header rows differ per report

Verify per export rather than assuming. As last observed, 0-indexed:

| Report | Header row |
|---|---|
| Sale Order Details | 5 |
| Customer Orders by Product | 5 |
| Availability Report | 0 |
| Sale Backorder Details | 0 |
| Sale Outstanding Quotes | 6 |
| Sale Overview | 4 |
| Inventory Movement Details | varies |

---

## Before using the data

Four corrections that have each caused a wrong number before:

1. **Outstanding Quotes is tax inclusive.** Every other report is exclusive.
   Divide by 1.10.
2. **Strip blank-brand quote rows.** Freight and the 1.5% card surcharge.
3. **Exclude internal accounts.** `RHINO RHINO TEST` and `Rhino Rhino Marketing`
   distort totals by 6–9%. The backorder report has no Customer column, so this
   cannot be applied there.
4. **A SKU absent from the availability report is absent, not zero.** The report
   only returns SKUs with a stock record, so new lines vanish from every join.

Full trap list in `RHINO RHINO - ORDERING METHOD.md` section 3.2.

---

## After downloading

Rebuild `Ordering Operating System\CURRENT POSITION.md` on the new refresh, and
check `DATA MAP.md` → *Authoritative files* still names the current files. (The old
SOURCE OF TRUTH REGISTER was archived on 3 October 2026.)

---

*The menu paths inside Cin7 are not recorded here — the report names above are
the ones already in use, and the navigation is unchanged.*

*Written 7 September 2026.*

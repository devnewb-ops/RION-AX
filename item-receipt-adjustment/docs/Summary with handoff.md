# Handoff: RionAX IR Component Depletion — Location Criss-Cross (Header ↔ Line)

**Project:** Rion (NorthShoreConsulting)
**Prepared:** 2026-09-16
**Purpose:** Context for a Claude Code session that will implement a location-handling change to `rax_ue_ir_depletion.js`.

## Background

`rax_ue_ir_depletion.js` is a UserEventScript (`afterSubmit`, CREATE only) on Item Receipt. For each received FG line whose item has RionAX Component rows (custom BOM), it generates an Inventory Adjustment that depletes each component, decrements the line-level RionAX Lot's remaining quantity, and stamps `custbody_rax_built` on the receipt.

This session covered:

1. **Initial script review** of the SBX-deployed version — found a partial-success/lot-decrement correctness gap, a lost-update race in `decrementLot`, no floor on lot remaining quantity, floating-point quantity math, and a hardcoded `INV_STATUS_ID`. None of these are fixed yet — see the earlier review for detail if picked up later.
2. **GL account change request** — customer wants DEBIT finished-goods inventory 113500 / CREDIT packaging inventory 113300 on the generated adjustment. Flagged a real risk: 113500 is (likely) the FG item's own Inventory Asset account, and posting to it via the adjustment's header `account` field bypasses item costing/valuation, which can desync the GL balance from the Inventory Valuation report. Not yet resolved with the customer — open question is whether these FG items are true Assembly items (Work Order/Assembly Build is the natively-reconciled path) or plain Inventory items received via PO (where Landed Cost would be the natively-reconciled path). **This decision is still open.**
3. **Diffed Prod vs. SBX deployed scripts** — Prod was running a materially older version (no `inventorydetailreq` gating, no per-component retry, no inactive-item filtering, dynamic name/number-based ID resolution instead of hardcoded IDs). Colleague confirmed it's fine to overwrite Prod with the SBX version.
4. **Production test after overwrite (receipt 1245, FG 1024) still failed** — all three packaging components (654, 653, 652) failed to create adjustments; item 808 correctly skipped as still lot/serial-tracked (that one's a data cleanup item, not a bug). Root-caused to: **Inventory Status is enabled in Prod but not in SBX** — the opposite of what the script's own comments assumed. This explains why the negative/absolute sign-fallback logic never actually worked: the true blocker is that `inventorystatus` isn't getting set on the detail subrecord line, and the `catch (es) {}` around that call swallows the real reason.
5. **`INV_STATUS_ID` confirmed as `1`, which is valid in Prod** — so the ID itself isn't wrong. **This defect is still open as of this handoff.** Next diagnostic step (not yet done): replace the empty catch with one that logs `es.message`, redeploy, and re-trigger a test receipt — or check whether items 654/653/652 have an item-level Preferred/Restricted Inventory Status list that excludes status `1`. Whoever picks this up should not assume it's fixed; there's no confirmation yet that a successful depletion has occurred in Prod.

## New requirement from today's conversation: location criss-cross

The customer wants the location fields on the auto-generated Inventory Adjustment to be **derived from the Item Receipt**, replacing the current hardcoded `DEPLETION_LOC = '1'`. Specifically, described as a criss-cross:

- The **Inventory Adjustment header** (`adjlocation`, the Main/header location) should reflect the **location on the IR's item line** — i.e., wherever the FG was actually received (currently captured in the script as `lineLoc`, but never applied — only logged).
- The **Inventory Adjustment component lines' location** should reflect the **location on the IR's header/Main line** (currently captured as `headerLoc`).

So the header and line locations swap roles relative to the source transaction — the adjustment's header location comes from the IR's *line*, and the adjustment's *line* location comes from the IR's header. This fully replaces `DEPLETION_LOC`; the business rule that components "always deplete at location 1" no longer applies.

**⚠️ Confirm this mapping before implementing.** This is my best reconstruction of "the Main/header to reflect the location on the inventory line of the IR... and the line level of the inventory adjustment to reflect the location on the main line" from a verbal description, not a written spec — worth a quick confirmation with the customer/colleague before coding, since getting header vs. line backwards here would misstate inventory location on every depletion. Also confirm what should happen when either IR field is blank (currently `lineLoc` falls back to `headerLoc` if the line itself has no location set — decide whether that fallback still makes sense once locations are also feeding the header the other way).

### Where this lives in the code today

In `rax_ue_ir_depletion.js`:

- `headerLoc = ir.getValue({ fieldId: 'location' })` — IR header location (already extracted, line ~69).
- `lineLoc = ir.getSublistValue({ sublistId: 'item', fieldId: 'location', line: i }) || headerLoc` — IR line location per FG line (already extracted, line ~81).
- `DEPLETION_LOC = '1'` (constant, line ~41) is currently passed as a single `locationId` into `createDepletionAdjustment(itemId, qty, DEPLETION_LOC, comps, ir.id)` (line ~96), where it's used for **both**:
  - the header: `adj.setValue({ fieldId: 'adjlocation', value: locationId })`
  - every component line: `adj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'location', value: locationId })`

### What needs to change

- Remove (or repurpose) `DEPLETION_LOC`.
- Split the single `locationId` parameter into two — e.g. `headerLocationId` (→ `lineLoc` from the IR) and `lineLocationId` (→ `headerLoc` from the IR) — and thread both through `createDepletionAdjustment`.
- Update the call site (currently in the per-FG-line loop, and again in the per-component retry loop) to pass both values per receipt line, since `lineLoc` varies per IR line while `headerLoc` is constant for the whole receipt.
- Re-verify the `if (locationId) {...}` null-guards on both the header `adjlocation` set and the line `location` set now that there are two independently-nullable values instead of one constant that's always truthy.
- Update the header comment (currently: "Depletion location is HARDCODED to DEPLETION_LOC... components always deplete at location 1") — that whole paragraph is now wrong and should describe the criss-cross instead.

## Files

Local (device-bridged), folder `Rion`:
- `SBX Deployed Script\rax_ue_ir_depletion.js` — current SBX version (has the `inventorydetailreq`/retry/inactive-filtering fixes; does not yet have the location criss-cross)
- `Prod Deployed Script\rax_ue_ir_depletion.js` — was just overwritten with the SBX version; still has the open Inventory Status defect (item 3 above) unresolved
- `Script Review\rax_ue_ir_depletion.js` — mirror of the SBX version used for review

## Recommended next steps, in order

1. Confirm the header↔line location mapping with the customer (see ⚠️ above) before writing code.
2. Implement the criss-cross in `createDepletionAdjustment` and its call sites.
3. Separately — do not bundle with the above — continue root-causing the Inventory Status set failure (item 5 above): add real error logging to the swallowed catch, redeploy just that, and re-test receipt 1245 or similar in Prod.
4. Keep the GL account/costing question (item 2) and the earlier correctness findings (item 1) open and tracked — none of these are resolved yet, and none should be assumed fixed by the location or Inventory Status work.
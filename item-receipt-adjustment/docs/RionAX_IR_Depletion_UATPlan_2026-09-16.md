# RionAX Item Receipt Depletion — UAT Plan (Location Criss-Cross)

**Client:** Rion Aesthetics
**Script:** `rax_ue_ir_depletion.js` (UserEventScript, Item Receipt, `afterSubmit`, CREATE only)
**Change under test:** the generated Inventory Adjustment's **header** location now comes
from the IR **line's** location, and its **component line** locations now come from the
IR **header's** location. Replaces the old hardcoded `DEPLETION_LOC = '1'`.
**Environment:** SBX (`9693623-sb1`)
**Test locations used:** **Rion Aesthetics Inc.** and **Rion Therapeutics**
**Tester:** _______________
**Date run:** _______________

## ⚠️ Before sign-off

The header↔line mapping was reconstructed from a verbal description, not a written
spec (see `Summary with handoff.md`). Get it confirmed with the customer/colleague
even though test #1 passed — a passing test only proves the code does what was
built, not that it's the intended business rule.

| Adjustment field | Sourced from |
|---|---|
| Header location (`adjlocation`) | IR **line** location (falls back to IR header location if the line has none) |
| Component line location(s) | IR **header** location |

## Pre-conditions

| # | Check | Status |
|---|---|---|
| 1 | Updated script deployed to SBX (`/SuiteScripts/rax_ue_ir_depletion.js` via SDF) | ✅ Confirmed 2026-09-16 |
| 2 | FG item exists with active, non-lot/serial/bin RionAX Component rows | ✅ |
| 3 | Two distinct locations available: **Rion Aesthetics Inc.** and **Rion Therapeutics** | ✅ |
| 4 | RionAX Lot record linked via `custcol_rax_lot` on a test line, with known Remaining Qty | ☐ |
| 5 | At least one component item deliberately lot/serial-tracked or inactive (regression check) | ☐ |

## Test cases

Legend: **P** = Pass, **P\*** = Pass with an open question (see notes), **F** = Fail,
**B** = Blocked, **N/A** = not applicable / not reachable.

| # | Scenario | Steps | Expected result | Result | Notes |
|---|---|---|---|---|---|
| 1 | Basic criss-cross | IR header = Rion Aesthetics Inc., line = Rion Therapeutics | IA header = Rion Therapeutics (from IR line); IA component line = Rion Aesthetics Inc. (from IR header) | **P** | Confirmed 2026-09-16 in SBX |
| 2 | Same location both sides | IR header = Rion Aesthetics Inc., line = Rion Aesthetics Inc. | IA header and line both = Rion Aesthetics Inc. | **P** | Control case, passed again |
| 3 | Line location blank | IR header = Rion Aesthetics Inc., line location left blank | N/A — native NetSuite validation blocks saving an IR with a blank line location | **N/A** | Confirms the `\|\| headerLoc` fallback in code is unreachable for UI-created receipts (may still matter for CSV/API imports, which can sometimes skip field validation — not urgent) |
| 4 | Header location blank | IR with no header location | N/A — header location is mandatory on the IR | **N/A** | Confirmed unreachable |
| 5 | Multi-line IR, different line locations | IR header = Rion Aesthetics Inc.; item 1 line = Rion Aesthetics Inc.; item 2 line = Rion Therapeutics | Item 1 IA: header = Rion Aesthetics Inc., line = Rion Aesthetics Inc. Item 2 IA: header = Rion Therapeutics, line = Rion Aesthetics Inc. | **P*** | Location mapping correct on every resulting IA, **but** item 2 generated 3 separate IAs instead of 1 combined one — see open question below |
| 6 | Multi-component FG | FG with 3+ active RionAX Component rows | One combined IA, all components as lines, correct header-derived location | ☐ | Regression |
| 7 | Component retry path | Force one component to fail (e.g. make it temporarily inactive) | Combined IA fails, retries per component; healthy ones still deplete at correct locations; failed one skipped with a named log entry | ☐ | Confirms both locations thread correctly into the retry call too |
| 8 | Lot decrement unaffected | IR with `custcol_rax_lot` set | RionAX Lot Remaining Qty decrements by received qty | ☐ | Regression |
| 9 | Built flag stamped | Successful depletion on CREATE | `custbody_rax_built` = T on the receipt | ☐ | Regression |
| 10 | Non-tracked FG untouched | IR line for an item with no RionAX Component rows | No IA created, no error | ☐ | Regression |
| 11 | Lot/serial component still skipped | FG component is itself lot/serial-tracked | Component skipped, logged "still lot/serial-tracked"; others still process | ☐ | Regression |
| 12 | Inactive component still skipped | FG component points at an inactive item | Component skipped, logged "INACTIVE item"; others still process | ☐ | Regression |
| 13 | GL/account fields unaffected | Any successful IA above | Subsidiary, Account, Department, Class match confirmed IA09 values | ☐ | Unrelated to this change — just confirming it's untouched |

## Open questions from testing so far

- **Test #5 — item 2 (FG 1032) produced 3 separate Inventory Adjustments instead of 1.**
  **Root cause identified (2026-09-16), unrelated to the location change.** Execution log
  for receipt 5563 shows `NUM_ITEMS_NOT_EQUAL_TO_QTY: The number of lot numbers entered
  (0) is not equal to the item quantity (1)` for component **item 812 "Intense Main 15ml
  V1"**. The tracked-item skip guard in `getComponentsForFg` (which is supposed to filter
  out lot/serial items before they reach `createDepletionAdjustment`) did not catch item
  812. Its inclusion fails the combined IA for the whole FG line, the script's existing
  per-component retry then succeeds individually for the other 3 components (matching the
  3 IAs observed) and correctly skips 812 with a named log entry. Location mapping was
  correct on every resulting IA.
  **Confirmed and fixed 2026-09-16:** item 812 is genuinely Lot Numbered. The guard's
  `isTracked` check only matched the JS boolean `true`, but `search.lookupFields`
  returns checkbox values as the string `'T'` on this account (same pattern already
  handled defensively everywhere else in the sibling approval-workflow scripts) — so a
  truly lot-numbered item silently passed the guard. Fixed to check both `true` and
  `'T'` for `islotitem`, `isserialitem`, `usebins`, and `isinactive`. Deployed to SBX and
  verified. **Re-test #5 and #6** to confirm item 812 is now filtered upstream (should
  log "still lot/serial-tracked — SKIPPED" immediately, with FG 1032's other 3
  components landing in a single combined IA instead of 3 separate ones).

## Not covered by this UAT pass

Still open per `Summary with handoff.md` — don't treat these as resolved:

- Inventory Status (`inventorystatus`) swallowed-catch defect in Prod.
- GL account / item-costing question (DEBIT 113500 / CREDIT 113300 request).
- Partial-success / lot-decrement correctness gap, `decrementLot` lost-update race,
  no floor on lot remaining quantity, floating-point quantity math.

## Sign-off

| Role | Name | Date | Result |
|---|---|---|---|
| Tester | | | ☐ Pass ☐ Fail |
| Customer/colleague — location mapping confirmed | | | ☐ Confirmed as intended ☐ Needs rework |
| Reviewer | | | ☐ Approved for next environment |

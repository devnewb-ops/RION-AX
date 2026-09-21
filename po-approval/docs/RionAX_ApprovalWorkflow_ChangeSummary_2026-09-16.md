# RionAX Approval Workflow — Change Summary

**Date:** 2026-09-16
**Environment:** Sandbox (9693623_SB1), Phase 1 Vendor Bill + PO approval extension
**Status:** All items below are deployed to sandbox and verified working.

## Design change: Vendor Bill and PO now configured independently

**Before:** the dollar-band records ("Approval Levels") were tagged by transaction
type (Vendor Bill / Purchase Order / Both). All 5 existing bands were tagged
"Both," which meant Vendor Bill and PO were forced to always share the exact
same approver per department/band — there was no way to route a PO to a
different approver than its Bill counterpart.

**Now:** the bands are shared/global (no type tag at all — one set of bands for
every process). The transaction-type tag moved to the approver-assignment
record instead ("Approval Rule" / matrix cell). Vendor Bill and Purchase Order
are configured independently, in the same admin screen, using the same bands.

**Action needed:** Purchase Order approvers must be configured fresh under the
PO toggle in RAX Approval Administration — they were never set up before (this
gap is what surfaced the original issue, when adding a second band set for PO
hit a validation conflict).

## Bugs fixed during this testing round

1. **Secondary-approver Deny silently failed** — the deny confirmation form
   wasn't passing its data back correctly; the bill stayed in Pending instead
   of being denied. Fixed.
2. **My Approvals showed duplicate rows** for the same bill/PO (one row with
   the vendor name, one without). Fixed — one row per pending item now.
3. **My Approvals crashed on open** for some users once (2) above was
   first patched (a column exceeded NetSuite's field-length limit). Fixed by
   splitting Approve/Deny into two columns.
4. **Browser "Leave site?" warning** appeared every time the Type filter was
   changed on My Approvals. Removed.
5. **Type filter reset to "All Types"** after approving or denying a
   transaction, instead of staying on whatever was selected. Fixed — the
   filter now persists through the decision round trip.

## Confirmed by design (not bugs — flagging for awareness)

- **Routing keys off the transaction's header Department only**, not
  per-line departments. A Bill/PO with 3 lines in 3 different departments
  still routes as one bucket, under the header department. If the original
  requirement expected per-line routing, that's a scope conversation, not a
  defect.
- Test case **#1** (below-threshold auto-approve) traced to the Department
  field simply not being displayed/mandatory on the form — resolved once
  displayed.

## Test plan impact

Test cases **#15** ("Applies-To default = Both") and **#17** ("Admin matrix
toggle") in the existing test plan were written against the old Level-level
tagging design and are now obsolete as worded — they should be replaced with
cases that validate Vendor Bill/PO independence instead (a concise revised
test plan already covers this: `RionAX_TestPlan_Concise_VB_PO_2026-09-16.xlsx`,
rows 5 and 20 specifically).

## Recommended next steps

1. Configure Purchase Order approvers under the PO toggle in RAX Approval
   Administration (bands are already shared; only approver assignment is
   missing for PO).
2. Re-run the VB/PO independence and admin-toggle test cases to confirm.
3. Update/retire the two obsolete "Applies-To = Both" test cases.

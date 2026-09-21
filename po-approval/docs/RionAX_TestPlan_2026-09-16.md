# RionAX Approval Workflow — Test Plan (v6.3-po, SBX)

**Client:** Rion Aesthetics
**Account:** 9693623_SB1 (sandbox)
**Feature:** Vendor Bill + Purchase Order approval extension
**Deployed:** 2026-09-16 (phase 1 SDF deploy + manual "Applies To" update on 5 Approval Level records)
**Tester:** _______________
**Date run:** _______________

## Pre-conditions (confirm before testing)

| # | Check | Status |
|---|---|---|
| 1 | `suitecloud project:deploy` completed successfully (174/174 steps) | ✅ Done 2026-09-16 |
| 2 | `customdeploy_rax_ue_po_approval` deployment is set to **Purchase Order** record type and **Released** | ✅ | done
| 3 | RAX Approval subtab fields appear on the Purchase Order transaction form (same as Bill form) | ✅ | 
| 4 | **Setup → Accounting → Preferences → Approval Routing → Purchase Orders** is checked | ✅ |
| 5 | **Setup → Accounting → Preferences → Approval Routing → Vendor Bills** is checked | ✅ |
| 6 | No native SuiteFlow / supervisor-hierarchy approval active on Vendor Bill or Purchase Order | ✅ |
| 7 | All 5 RAX Approval Level records (Functional Owner, Director, Department Executive, Designated Functional Approver, C-Suite) have **Applies To = Both** | ✅ Done 2026-09-16 |
| 8 | One active RAX Approval Setting record exists | ☐ | Comment - settings is still showing in the RAX Approval Matrix Administration. This can be hidden from the UI.
| 9 | RAX Approval Administration matrix has at least one configured cell per test department below | ✅ | applied fix to error regarding create

## Test cases

Legend: **P** = Pass, **F** = Fail, **B** = Blocked, **N/A** = not applicable this run.

| # | Scenario | Steps | Expected result | Result | Notes |
|---|---|---|---|---|---|
| 1 | Below-threshold Bill, single dept | Create Bill, one line, dept with a rule below band 1 threshold | `No Approval Needed`, `approvalstatus = 2`, no steps created | ☐ | | in the matrix for vendor bill for functional owner of up to 5,000$, added approval required for myself. Created a vendor bill for this department, under 5000, and the bill was approved. 
| 2 | Above-threshold Bill, single dept | Create Bill, one line, above band 1 threshold | One step created, Current, `nextapprover` set, `approvalstatus = 1` | ☐ | made a copy of test 1, changed amount to 6000. Bill was approved. |
| 3 | Multi-department Bill | Bill with 3 lines across 3 departments | 3 steps, ordered by subtotal descending | ☐ | |
| 4 | Merged approver | Two departments sharing the same approver | Steps merge into one | ☐ | |
| 5 | Gate step | 5 lines × $9,000 across 5 departments, each under a $10,000 band | Bill Total Gate step appended as final step | ☐ | |
| 6 | Secondary approval | Secondary approver approves a step | Step advances; secondary recorded as Decided By | ☐ | |
| 7 | Denial | Deny at step 2 of 3 | Bill Denied, step 3 Skipped, payment blocked | ☐ | |
| 8 | Edit resets chain | Edit a line amount at step 2 of 3 | All approvals reset, chain rebuilt, warning banner shown | ☐ | |
| 9 | Edit lock | Edit a fully approved Bill as a non-approver | Blocked with lock message | ☐ | |
| 10 | CSV import | Import a Bill via CSV | Chain builds correctly | ☐ | |
| 11 | Unmatched department | Line in a department absent from the matrix | No step, Bill auto-approves, `log.audit` written | ☐ | |
| 12 | Band inheritance | Department configured at band 1 only; Bill lands in band 3 | Step inherits band 1 approver, shown as `(inherited)` | ☐ | |
| 13 | Inheritance + gate | Same as #12 but with a gate approver set on band 3 | Band-1 step **plus** gate step, both present | ☐ | |
| 14 | PO / Bill independence | Approve a Bill and a PO, same dept/amount, same session; then approve PO fully and create a Bill from it | Each transaction's chain is fully independent; the new Bill starts at step 1, does not inherit PO's approved status | ☐ | |
| 15 | Applies-To default (Both) | Create a PO in a dept/band with only a Both-tagged Level | Routes identically to how a Bill would for that dept/band | ☐ | Validates today's manual "Applies To = Both" fix |
| 16 | Merged My Approvals queue | User has one pending Bill and one pending PO | Both appear in one list with correct Type column; filtering to "Purchase Order" hides the Bill row without a reload | ☐ | |
| 17 | Admin matrix toggle | Open RAX Approval Administration, switch Transaction Type toggle PO → Bill → PO | Grid re-renders to Levels tagged for the selected type (or Both) each time; no residual state | ☐ | |

## Sign-off

| Role | Name | Date | Result |
|---|---|---|---|
| Tester | | | ☐ Pass ☐ Fail |
| Reviewer | | | ☐ Approved for next environment |

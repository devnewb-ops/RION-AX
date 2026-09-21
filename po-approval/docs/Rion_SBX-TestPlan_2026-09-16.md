# Rion — Approval Workflow PO Extension — SBX Test Plan

**Project:** RionAX Approval Workflow v6.3-po
**Environment:** SBX only (no production changes in this phase)
**Prepared:** 2026-09-16
**Prepared by:** David Patry / NorthShoreConsulting

## 1. Pre-deploy checklist

- [ ] **Confirm SDF auth ID.** `src/project.json` currently sets `defaultAuthId: rionprod_1`. Confirm this resolves to the Rion **sandbox** account, not production, before running `project:deploy`. Do not proceed until this is verified.
- [ ] Confirm the SuiteCloud CLI is authenticated to the correct Rion SBX account on the deploying machine (`suitecloud account:manageauth --list`).
- [ ] Confirm SBX has a recent, known-good backup/snapshot state (or is a refreshable sandbox) in case rollback is needed.
- [ ] Confirm no one else has pending unreleased customizations on `customrecord_rax_approval_level`, `customrecord_rax_approval_setting`, or the approval scripts in this account.

## 2. Deploy steps

1. `suitecloud project:deploy` from `Context/RionAX_ApprovalWorkflow_PO/src`.
2. Verify `customdeploy_rax_ue_po_approval` (User Event → Purchase Order) shows **Released** in Script Deployments. SDF deploy status can silently vary by role/permission — confirm manually, don't assume from CLI output alone.
3. Confirm the existing `customdeploy_rax_ue_vb_approval` (Vendor Bill) is still Released and untouched.
4. **Lists → Custom → RAX Approval Level** — confirm all existing bands migrated with **Applies To = Both**. Sequence still unique; exactly one Unlimited band at the highest sequence.
5. **RAX Approval Setting** — confirm the single settings record still exists, Applies To hidden/defaulted to Both.
6. Open the **RAX Approval Administration** Suitelet — confirm the Transaction Type toggle is present and defaults sensibly.

## 3. Manual account configuration (not carried by SDF deploy)

- [ ] Add the RAX Approval subtab's fields to the **Purchase Order** transaction form, matching their placement on the Vendor Bill form. (No new fields needed — all carry `bodypurchase=T` already; this is a form-layout step only.)
- [ ] Check **Setup → Accounting → Preferences → Approval Routing → Purchase Orders**. Confirmed in SBX beforehand that no native SuiteFlow/supervisor-hierarchy approval is active on PO, so there is nothing to disable first — this is additive.
- [ ] Confirm **Setup → Accounting → Preferences → Approval Routing → Vendor Bills** is still checked (unchanged, but verify nothing reset it).
- [ ] Confirm no SuiteFlow workflow is defined for Purchase Order approval (would fight this engine the same way it would for Vendor Bill).

## 4. Functional test cases

Carried forward from the project's existing Vendor Bill regression script (`Context/RionAX_ApprovalWorkflow_PO/README.md`), re-run in full since the shared engine changed, plus the PO-specific cases (14–17) that validate the extension itself.

### 4.1 Regression — Vendor Bill (must still pass unchanged)

| # | Case | Expected result |
|---|---|---|
| 1 | Bill, one line, dept with a rule below band 1 threshold | `No Approval Needed`, `approvalstatus 2`, no steps |
| 2 | Bill, one line, above threshold | One step, Current, `nextapprover` set, `approvalstatus 1` |
| 3 | Bill, three lines, three departments | Three steps ordered by subtotal desc |
| 4 | Two departments sharing an approver | Merged into one step |
| 5 | Five lines × $9,000 across five departments under a $10,000 band | Gate step appended |
| 6 | Secondary approver approves | Step advances; secondary recorded as Decided By |
| 7 | Deny at step 2 | Bill Denied, step 3 Skipped, payment blocked |
| 8 | Edit a line amount at step 2 of 3 | All approvals reset, chain rebuilt, warning banner shown |
| 9 | Edit a fully approved bill as a non-approver | Blocked with lock message |
| 10 | CSV import a bill | Chain builds correctly |
| 11 | Line in a department absent from the matrix | No step, bill approves, `log.audit` written (intended) |
| 12 | Department configured at band 1 but not band 3; bill lands in band 3 | Step inherits band 1 approver, level shown as `(inherited)` |
| 13 | Same bill, large total, gate approver set on band 3 | Band 1 step **plus** the gate step |

### 4.2 New — Purchase Order extension

| # | Case | Expected result |
|---|---|---|
| 14 | **PO independence.** Approve a Bill and a PO for the same department/amount in the same session, then approve the PO fully and create a Bill from it | Each transaction builds and advances its own chain independently — approving one does not touch the other's steps. The Bill created from the approved PO starts its own chain from step 1, does not inherit PO approval status. |
| 15 | Create a PO in a department/band with no PO-specific Level (only a Both-tagged Level exists) | Routes exactly like a Bill would for that department/band, confirming Applies To filter defaults correctly |
| 16 | Open **My Approvals** with ≥1 pending Bill and ≥1 pending PO for the same user | Both appear in one list with correct Type column; filtering to "Purchase Order" hides the Bill row without a full reload |
| 17 | Open **RAX Approval Administration**, switch Transaction Type toggle to Purchase Order, then back to Vendor Bill | Grid re-renders using only PO-or-Both Levels, then reverts to the pre-toggle Bill view with no change to Bill routing |

### 4.3 Additional PO-specific edge cases (not in original script — recommend adding)

| # | Case | Expected result |
|---|---|---|
| 18 | PO edit after partial approval — change header department or amount | Same edit-lock/reset behavior as Bill (table in README §"Edit lock") applies identically to PO |
| 19 | Deny a PO at a mid-chain step | PO Denied, remaining steps Skipped — confirm there is no payment-guard equivalent blocking anything (PO has no payment step, per design) |
| 20 | Universal approver (C-Suite) approves a pending PO directly | Settles the whole PO chain in one action, same as Bill |
| 21 | Native "Approve" button clicked directly on a PO by the correct current-step approver | Absorbed into the RAX chain (`afterSubmit` `nativeSync`), same behavior as Bill |
| 22 | Native "Approve" button clicked on a PO by someone who is *not* the current step's approver | Reverted, `approvalstatus` restored to Pending, `log.audit` entry written |

## 5. Sign-off

- [ ] All regression cases (4.1) pass with no behavior change from pre-extension baseline.
- [ ] All PO extension cases (4.2, 4.3) pass.
- [ ] Manual account configuration (§3) confirmed complete.
- [ ] Rion stakeholder reviews and approves before any production rollout is scheduled (separate phase, out of scope here).

## Open questions for Rion / stakeholder before sign-off

- Confirm §4.3 edge cases (18–22) are acceptable additions to the test scope, or if any should be deferred.
- Confirm who performs UAT sign-off on the Rion side before this moves toward a production conversation.

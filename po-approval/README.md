# RionAX Approval Workflow — v6.4-po (SBX)

Vendor Bill **and Purchase Order** approval driven by the same Department ×
Approval Level matrix, administered through one Suitelet. See
`PO_Approval_Extension_Design.md` (project outputs folder) for the full
design rationale; this file covers what actually changed and how to deploy
and verify it.

## What changed in v6.4-po — Next Approver guard, admin label fix

Cosmetic changes only; no change to who may approve or how the chain builds.

| Area | v6.4-po behaviour |
|---|---|
| Next Approver guard (new file `rax_cs_next_approver_guard.js`) | Customer-requested cosmetic constraint on the native `nextapprover` field: a human editing it on a Bill or PO with a Current step can only leave it set to that step's primary or secondary approver (read from `custbody_rax_appr_approver` / `custbody_rax_appr_secondary`, which the engine already keeps in sync). An out-of-list pick is blocked/reverted on `fieldChanged` and `saveRecord`, with an alert. Deployed as its own standalone Client Script (`customscript_rax_cs_next_approver_guard`, deployments `customdeploy_rax_cs_nag_vb` / `customdeploy_rax_cs_nag_po`) rather than piggybacking on `rax_cs_vb_approval.js`, so it fires on every load regardless of the UE's approver-gated attach logic. **Platform limit, confirmed:** `nextapprover`'s picker is a live employee search, not a static list — there is no supported API (client or server) to prune what it displays. The popup will still show every employee; only the value that's actually saved is constrained. A true short list would require hiding the native field and substituting a custom one — not built, since it's a materially bigger change (see "Next Approver — known limitation" below). |
| Admin matrix label fix (`rax_sl_approval_admin.js`) | The "Use bill's Secondary Approver" checkbox in the matrix grid was hardcoded to say "bill's" even when the Transaction Type toggle was set to Purchase Order. Now reads `lib.esc(txn.label)` the same way the help text below it already did, so it correctly says "Use Vendor Bill's Secondary Approver" or "Use Purchase Order's Secondary Approver" depending on the toggle. |

### Next Approver — known limitation

The customer asked for the `Next Approver` dropdown to show only the current step's primary and secondary approver. NetSuite's native `nextapprover` field has no supported mechanism (client script, server script, or Transaction Form field property) to filter its search results — confirmed by inspecting the field's rendering (a dynamic employee-search popup, not a static `<select>`) and by checking Oracle's own documentation, which describes no such option. What's deployed instead validates the value after it's picked rather than narrowing the picker itself. Getting an actual short list would mean hiding `nextapprover` and adding a custom field populated with just the two names, syncing the chosen value into `nextapprover` server-side — a real scope increase, not built as part of this pass.

## What changed in v6.3-po — extending approval to Purchase Orders

One engine, two Script Deployments (Vendor Bill and Purchase Order) of the
same User Event, selected by NetSuite's own deployment mechanism rather than
a config field. Nothing in the 1,100-line engine was forked.

| Area | v6.3-po behaviour |
|---|---|
| Data model | New optional **Applies To** field (Vendor Bill / Purchase Order / Both) on `customrecord_rax_approval_level`. Every existing Level migrates tagged **Both** — PO reuses the exact same thresholds and approvers as Bill on day one. Same field added to `customrecord_rax_approval_setting`, defaulted to Both and **hidden** from the admin Suitelet (only Both is a real option today; the engine still reads it). No change to the matrix rule schema or its (Level, Department) uniqueness constraint. |
| Script deployment | `rax_ue_vb_approval.js` now has a second deployment (`customdeploy_rax_ue_po_approval`) bound to Purchase Order, alongside its original Vendor Bill deployment. Both share the same file. |
| Engine (`rax_lib_approval.js`) | New `TXN` config map (`lib.TXN.VENDOR_BILL` / `lib.TXN.PURCHASE_ORDER`) resolved from `context.newRecord.type` (or, when only a bare id is available, one `search.Type.TRANSACTION` lookup). Every function that used to hardcode `record.Type.VENDOR_BILL` / `search.Type.VENDOR_BILL` (`buildChain`, `advance`, `denyChain`, `applyStepDecision`) now takes or resolves this. `getLevels(txn)` filters Levels by Applies To; Both/blank always matches. |
| My Approvals (`rax_sl_my_approvals.js`) | **One merged queue** for Bills and POs, not a second Suitelet or separate tabs. A Type column plus a "Show" filter (all / Bill / PO) — default shows everything. |
| Approval Action (`rax_sl_approval_action.js`) | Redirect and lookups now use the transaction type carried on the button/list URL's `type` param (falls back to a generic transaction lookup if it's ever missing). |
| Admin matrix (`rax_sl_approval_admin.js`) | New **Transaction Type** toggle at the top of the screen. Selecting Bill or PO filters the grid to Levels tagged for that type (or Both); the department list and the matrix cells are unaffected by the toggle — only which Levels a cell can point at differs by type. |
| Chain independence | A PO's approval chain is fully independent of the Bill it becomes — NetSuite treats the two as unrelated transactions and nothing here links them. |
| Bill Payment guard (`rax_ue_vp_guard.js`) | **Unchanged, Bill-only.** No Purchase Order analog exists (POs have no payment step); this was a deliberate scope decision, not an oversight. |
| `customrecord_rax_appr_step` | No schema change. The "Vendor Bill" field label is renamed to **"Transaction"** (cosmetic; scriptid `custrecord_rax_st_bill` is unchanged) since the same step record now backs both types. |

### Manual steps (not carried by SDF deploy)

1. Deploy this project (`suitecloud project:deploy`), which creates the second UE deployment. **Confirm `customdeploy_rax_ue_po_approval` is set to Purchase Order and Released** — SDF deploy status can vary by role/permissions in some accounts.
2. Add the RAX Approval subtab's fields to the **Purchase Order** transaction form the same way they already appear on the Bill form (the fields all carry `bodypurchase=T`, so no new fields are needed — this is a form-layout confirmation, not a customization).
3. Check **Setup → Accounting → Preferences → Approval Routing → Purchase Orders** (mirrors the Vendor Bills checkbox already relied on — see "Native approval settings" below). **Confirmed in SBX:** no native SuiteFlow or supervisor-hierarchy approval is currently active on Purchase Order, so there is nothing to disable first.
4. Re-run the test script below against Purchase Orders, plus the new cross-type independence test (#14).
5. **Set Applies To = Both on the 5 existing RAX Approval Level records (IDs 1–5)** — Functional Owner, Director, Department Executive, Designated Functional Approver, C-Suite. These records predate this project's SDF ownership (no scriptid tag), so SDF does not create or update them; this is a one-time manual field edit per record. Confirmed done in SBX 2026-09-16.

### SDF deploy quirk — `customlist_rax_txn_applies_to` cross-file value references (SBX, 2026-09-16)

SuiteCloud CLI (tested 4.0.0 and 4.1.0, account customization framework 1.0) cannot statically resolve `[scriptid=customvalue_rax_applies_both]` when that reference appears in a **different** object file than the customlist that defines it — even after the list is deployed and the value exists in the account. This blocked validation on:
- `<defaultselection>` in the `custrecord_rax_al_applies_to` / `custrecord_rax_as_applies_to` field definitions — **fixed** by removing the `<defaultselection>` (the field simply has no pre-filled default now; every current use sets the value explicitly anyway).
- The `custrecord_rax_al_applies_to` value inside `customrecord_rax_approval_level.xml`'s `<instances>` block (5 seed records) — **not fixable in SDF.** `[internalid=X]` is rejected outright by the field's schema, `--accountspecificvalues WARNING` does not cover this error class, and framework 1.1 is not a supported version for this account. Resolution: the `<instances>` block was dropped from the project entirely; those 5 records are managed by the manual step above instead.

**Deploy order used:** two-phase — (1) deploy everything except the 5 seed instances so the list/fields/scripts land first, (2) set `Applies To = Both` manually on the 5 pre-existing records. If this project is ever deployed to a fresh account where those 5 records don't exist yet, they'll need to be created manually post-deploy (not via SDF) with the same values as the "Install order" section below.

## What changed in v6.3

| Area | v6.3 behaviour |
|---|---|
| Automatic C-Suite approval | A universal-flagged level (C-Suite) is no longer a departmental band. Bills band against the remaining levels only; when the bill total reaches the universal level, its approval is appended as an ADDITIONAL final step (Department Executive -> C-Suite -> Approved). Approvers for that step come from the (C-Suite, department) matrix cell, then the level's gate fields, then the fallback. Marking a department No Approval Needed at the C-Suite band suppresses the step. |
| Bill-selected Secondary Approver | New editable `custbody_rax_bill_secondary` field on the bill (Approval subtab). Matrix cells ticked "Use bill's Secondary Approver" route to whoever the preparer picked: alone, that person IS the approver; alongside a named primary, they join as co-approver. The selection is part of the approval fingerprint, so changing it resets approvals. A Required cell relying on the flag with an empty bill field routes to the fallback and logs. |
| Direct C-Suite approval | Unchanged from v6.2: universal approvers may decide any bill at any amount in one action, which settles the whole chain. Self-approval policy still applies. |

## What changed in v6.2

| Previous behaviour | v6.2 behaviour |
|---|---|
| Line departments subtotalled per department; multi-step chain per department | The **header department** determines the approval path. Line amounts are still summed for the routed total, but line departments have no routing effect. Chains are single-step in practice. |
| Rearranging or recoding lines reset approvals | The approval fingerprint is header department + summed total + currency, so only those inputs reset approvals |
| No override tier | **Universal Approver Level** checkbox on the Approval Level record. Anyone named (primary or secondary) on a matrix rule at a flagged level may approve or deny ANY bill, at any amount, in one action. A universal approval settles the whole bill. Self-approval policy still applies to universal approvers. Universal approvers see every pending bill in My Approvals and in the native queue. |
| Bill Total Gate guarded against line-splitting across departments | With header-only routing the gate cannot fire (the routed subtotal IS the bill total). Gate fields are retained but dormant; safe to leave unset. |

## What changed from v4

| v4 behaviour | v5 behaviour |
|---|---|
| Unmatched matrix cell returned `No Approval Needed` → bill auto-approved | The matrix is **opt-in**: a department with no rules needs no approval, and an empty band **inherits the nearest configured band below it**. A cell explicitly marked Required with no approver is still an error and routes to the fallback. |
| Read header `department` | Reads **line** departments, subtotalled per department |
| Read `usertotal` / `total` in `beforeSubmit` (0 for CSV/API/script creates) | Sums line amounts directly — never trusts an uncalculated header total |
| Single approver, Backup vs Co-approver mode setting | Ordered **chain** of steps; each step has a primary and secondary, **either may approve** |
| Native `nextapprover` never set | Set on every advance, so the standard queue and saved searches work |
| `approvalstatus` written via `afterSubmit` `submitFields` | Written on the record in `beforeSubmit` |
| No threshold gate | **Bill Total Gate** step blocks splitting a large bill across departments |
| Payment guard `catch → continue` (fail-open) | Guard blocks when it cannot verify a bill (fail-closed) |
| No logging anywhere | `log.error` / `log.audit` on every failure path and gap |

## Install order

1. `suitecloud project:deploy`
2. **Lists → Custom → RAX Approval Level** — create bands (or confirm the migrated ones). Sequence must be unique; exactly one band ticked **Unlimited** with the highest sequence. Set the **Total Gate Approver** on the bands that should catch split transactions. Leave **Applies To** at its default **Both** unless Vendor Bill and Purchase Order genuinely need different thresholds.
3. **RAX Approval Setting** — create one record. Fallback Approver is optional unless Strict Gap Handling is on. Applies To is hidden on this record for now (see above) — leave it at Both.
4. Open the **RAX Approval Administration** Suitelet, pick a Transaction Type, and configure the matrix. You only need a cell where routing *changes* — leave the rest blank. Because Levels default to Both, one pass through the grid covers both types today.
5. Confirm **Setup → Company → Enable Features → Employees → Approval Routing → Vendor Bills** is *checked* (see below), **and** confirm **Setup → Accounting → Preferences → Approval Routing → Purchase Orders** is checked the same way.
6. Undeploy any other approval solution on Vendor Bill or Purchase Order.

## Native approval settings

Leave the **Vendor Bills** and **Purchase Orders** boxes under Approval Routing **checked**, and do **not** build a SuiteFlow workflow for either.

That checkbox means "something other than standard approval owns this record." It makes `approvalstatus` and `nextapprover` writable, which this project requires. It does **not** put a transaction into Pending Approval — a workflow normally does that, and here the User Event does it instead. That gap is why every bill in the sandbox originally saved as Approved: the box was checked, nothing set the status, and NetSuite defaulted to `2`. The same would happen for Purchase Order if the preference were enabled without this project's second UE deployment in place.

Unchecking either box would restore supervisor-hierarchy approvals for that record type, which ignore the matrix entirely and would fight this script.

The field help's warning about clearing Pending Approval transactions applies to *enabling* the preference, which has already happened for Vendor Bills. No native SuiteFlow or supervisor-hierarchy approval is currently active on Purchase Order in SBX, so enabling the preference there has nothing to clear.

## Configuration checklist

- Department is **mandatory on the header** of both Vendor Bill and Purchase Order. Line departments are ignored for routing.
- Exactly **one** active RAX Approval Setting record, shared by both transaction types.
- Gate Approver fields on the universal level act as the fallback approver source for the automatic C-Suite step when a department has no C-Suite matrix cell. Fill the C-Suite matrix row instead where possible.
- Fallback Approver only needed for Strict Gap Handling or for lines that somehow have no department.

## How routing works

1. Line amounts are summed into a single total, attributed to the **header department**.
2. That total is banded against the Approval Levels.
3. The matrix cell for (band, department) yields a primary and secondary approver.
   - Department has **no rules at all** → no approval required.
   - Band has **no cell** → inherits the nearest configured band *below* it that names an approver. Inheritance is downward only, so a larger bill can never draw a weaker approver than a smaller one in the same department.
   - Cell says **No Approval Needed** → that department clears.
   - Cell says **Approval Required with no approver** → configuration error; routes to the fallback and logs `log.error`.
4. Steps routing to the same primary are **merged**; the highest band's approver pair wins.
5. Steps are ordered **largest subtotal first**, line order as tiebreak.
6. If the **bill total** bands higher than any department subtotal did, that band's Total Gate Approver is appended as the final step.
7. Step 1 becomes Current. `approvalstatus = 1`, `nextapprover` = step 1's primary.
8. Either the primary or the secondary approves. The chain advances. When the last step approves, `approvalstatus = 2`.
9. Any denial denies the bill and marks remaining steps Skipped.

### Self-approval

When Prevent Self-Approval is on and the preparer is the matrix approver: the secondary takes the step → else escalate to the next band naming someone else → else fallback approver.

## Edit lock

| Bill state | Routing-relevant edit | Result |
|---|---|---|
| Fully approved | yes | **Blocked** unless Approver on this bill or override role; authorised edit rebuilds the chain from zero |
| Fully approved | no (memo, attachment) | allowed, no reset |
| Partially approved | yes | allowed, **all approvals reset**, chain rebuilt |
| Partially approved | no | allowed, chain untouched |

"Routing-relevant" is decided by comparing a stored fingerprint of line departments, line amounts, currency and exchange rate. This covers UI, CSV, RESTlet and scripted edits without maintaining a field list.

An orange banner warns on edit when approvals exist; a red banner warns when the bill is fully approved.

## Known behaviours to watch in the sandbox

- **`record.submitFields` fires user events as XEDIT.** The UE exempts its own execution contexts (`SUITELET`, `USER_EVENT`, `WORKFLOW`) so the engine cannot lock or re-trigger itself. If you add a Map/Reduce that touches bills, add `SCHEDULED`/`MAPREDUCE` to `SELF_CONTEXTS` or it will trip the edit lock.
- **Native approvals are absorbed, not ignored.** If the current step's approver clicks NetSuite's own Approve button, `afterSubmit` records it against the step and advances. Anyone else's native approval is reverted and logged.
- **Custom list internal IDs differ per account.** Nothing compares display text; IDs are resolved at runtime from the list scriptid and memoised per execution. Renaming a list *value* is safe; renaming the *list* is not.
- **`getLineCount` returns `-1`** when a sublist is absent — all loops guard for it.
- **`<name>` not `<n>`** in the object XML. The v4 zip had `<n>` tags, which are not valid SDF and would fail validation.

## Files

```
src/FileCabinet/SuiteScripts/RionAX/
  rax_lib_approval.js        engine: TXN map, banding, matrix lookup, chain build, steps, decisions, tab HTML
  rax_ue_vb_approval.js      Vendor Bill + Purchase Order UE (two deployments, one file): build, lock, native sync
  rax_ue_vp_guard.js         Bill Payment UE: fail-closed payment block (Vendor Bill only - no PO analog)
  rax_ue_matrix_validate.js  Rule/Level UE: uniqueness and consistency
  rax_cs_vb_approval.js      Approve/Deny buttons (attached to both deployments)
  rax_cs_next_approver_guard.js  standalone: blocks/reverts nextapprover picks outside the current step's primary/secondary
  rax_sl_approval_action.js  applies decisions, deny-reason form (type-aware redirect)
  rax_sl_my_approvals.js     merged Bill + PO approver queue (primary OR secondary), Type column + filter
  rax_cs_my_approvals.js     reloads the queue when the Type filter changes
  rax_sl_approval_admin.js   matrix grid, coverage report, settings - Transaction Type toggle
  rax_cs_approval_admin.js   grid serialisation, reloads the grid when the Transaction Type toggle changes
```

## Test script

1. Bill, one line, dept with a rule below band 1 threshold → `No Approval Needed`, `approvalstatus 2`, no steps.
2. Bill, one line, above threshold → one step, Current, `nextapprover` set, `approvalstatus 1`.
3. Bill, three lines, three departments → three steps ordered by subtotal desc.
4. Two departments sharing an approver → merged into one step.
5. Five lines × $9,000 across five departments under a $10,000 band → gate step appended.
6. Secondary approver approves → step advances; secondary is recorded as Decided By.
7. Deny at step 2 → bill Denied, step 3 Skipped, payment blocked.
8. Edit a line amount at step 2 of 3 → all approvals reset, chain rebuilt, warning banner shown.
9. Edit a fully approved bill as a non-approver → blocked with the lock message.
10. CSV import a bill → chain builds correctly (this is the case `usertotal` broke in v4).
11. Line in a department absent from the matrix → no step, bill approves, `log.audit` written. This is intended behaviour.
12. Department configured at band 1 (Director) but not band 3; bill lands in band 3 → step inherits Director, level shown as `(inherited)`.
13. Same bill, large total, gate approver set on band 3 → Director step **plus** the gate step.
14. **PO independence.** Approve a Bill and a Purchase Order for the same department, same amount, in the same session → each builds and advances its own chain; approving one does not touch the other's step records. Then approve the PO fully and create a Bill from it → the new Bill starts its own chain from step 1 rather than inheriting the PO's approved status.
15. Create a PO in a department/band with no PO-specific Level (i.e. only a Both-tagged Level exists) → routes exactly like a Bill would for that department/band, confirming the Applies To filter defaults correctly.
16. Open **My Approvals** with at least one pending Bill and one pending PO awaiting the same user → both appear in one list with the correct Type column; filtering to "Purchase Order" hides the Bill row without reloading anything else.
17. Open the **RAX Approval Administration** Suitelet, switch the Transaction Type toggle to Purchase Order → the grid re-renders using only Levels tagged Purchase Order or Both; switch back to Vendor Bill → unchanged from before this phase.

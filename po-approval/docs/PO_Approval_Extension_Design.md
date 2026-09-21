# Extending RionAX Approval Workflow to Purchase Orders

**Prepared for:** David Patry / NorthShoreConsulting — Rion project
**Based on:** RionAX_ApprovalWorkflow v6.3 (Vendor Bill approval, deployed Prod + SBX)
**Target for this phase:** SBX only

## 1. The ask, restated

The colleague wants the same department × approval-level matrix approval process that currently governs Vendor Bills to also govern Purchase Orders, configured through the same admin experience. Their framing left the mechanism open: a config toggle on the existing setup, or a duplicated script/deployment for PO. This doc lays out what the current code actually supports, recommends a specific approach, and lists what has to change.

## 2. What the current build already gives us for free

I pulled the SDF project apart before deciding anything. A few things make this easier than a from-scratch build:

- Every custom body field the engine reads and writes (`custbody_rax_appr_status`, `_approver`, `_level`, `_chain`, `_fingerprint`, `_bill_secondary`, etc.) is defined with `bodypurchase = T`. That's the NetSuite field-category flag that covers the whole Purchase transaction family — Purchase Orders included, not just Vendor Bills. **None of these fields need to be recreated for PO** — they just need to be placed on the PO form's subtab, the same way they're placed on the Bill form today.
- The step child record (`customrecord_rax_appr_step`) stores the parent transaction only as an internal ID. It has no dependency on which transaction type that ID belongs to, so it already works for either.
- The matrix cell record (`customrecord_rax_approval_rule`) keys on (Approval Level, Department) — it has no transaction-type dimension today, which is the one real gap.

The gap is entirely in the scripts: `record.Type.VENDOR_BILL` / `search.Type.VENDOR_BILL` are hardcoded in about a dozen places across `rax_lib_approval.js`, `rax_ue_vb_approval.js`, `rax_sl_my_approvals.js`, and `rax_sl_approval_action.js`. That's what has to be generalized.

## 3. Recommendation: one engine, two deployments, type-tagged levels

Rather than a manual "mode: Bill / PO" switch, use NetSuite's own mechanism for this: **one User Event script, two Script Deployment records** — one bound to Vendor Bill, one bound to Purchase Order. NetSuite tells the script which record type it's running against via `context.newRecord.type` at execution time, so the script doesn't need a config field to know which mode it's in. This is what the colleague's "just add a config option" and "duplicate the deployment" instincts were both reaching for — the deployment IS the config option, and it's the native way to do it rather than a custom field that someone has to remember to set correctly.

The engine (`rax_lib_approval.js`) and both Suitelets stay as a **single shared codebase**, parameterized by transaction type, rather than forked into parallel PO scripts. Given how much logic lives in the 1,100-line library (banding, chain-building, self-approval, universal approvers, the C-Suite gate step, fingerprinting) forking it means every future fix has to be made twice and will eventually drift. The only genuinely separate piece is the admin UI's default landing state (see §5) and the payment guard (see §6), which don't need to be shared.

Where Bill and PO *do* need independent configuration — thresholds, approvers, whether a department needs approval at all — that's handled by tagging the **Approval Level** records, not by duplicating the rule matrix engine. See §4.

## 4. Data model changes

### 4.1 `customrecord_rax_approval_level` — add "Applies To"

Add a select/list field, e.g. `custrecord_rax_al_applies_to`, with values **Vendor Bill**, **Purchase Order**, **Both**. **Decided:** PO reuses the exact same dollar bands and approvers as Vendor Bill, so every existing level record migrates tagged **Both** (not Vendor Bill) — no new PO-specific Level records are created for this phase.

The field still earns its place even though day one is fully shared: it's what lets Bill and PO diverge later — independently or per-department — without touching the rule/matrix schema.

The rule record (`customrecord_rax_approval_rule`) needs **no new field** — its (Level, Department) uniqueness constraint is untouched, because a rule already points at one Level, and that Level now carries the transaction-type tag. The engine just filters which Levels it bands against by the transaction type it's currently processing.

### 4.2 `customrecord_rax_approval_setting`

Add an optional `custrecord_rax_as_applies_to` field, same three values, defaulting to **Both**. **Decided:** self-approval blocking, exempt roles, and fallback approver are shared across both transaction types — one settings record, no PO-specific override for this phase. Since this is the only real-world value for now, **hide the field from the admin Suitelet edit screen** (`rax_sl_approval_admin.js`) rather than exposing a toggle with one usable option; keep the field defined and read by the engine so a future divergence needs no schema change, just re-exposing the control.

### 4.3 `customrecord_rax_appr_step`

No schema change required. Consider renaming the field label "Bill" → "Transaction" in the UI (cosmetic only, scriptid stays the same) so the admin coverage report doesn't read oddly for POs.

### 4.4 Custom list / requirement values, C-Suite gate, universal approver flag

All unaffected — these live on the Level and Setting records already covered above.

## 5. Script changes

| File | Change |
|---|---|
| `rax_lib_approval.js` | Add a small `TXN` config map (`{ VENDOR_BILL: { recordType, searchType, bodyFieldSet }, PURCHASE_ORDER: { ... } }`). Every function that currently hardcodes `record.Type.VENDOR_BILL` / `search.Type.VENDOR_BILL` (`advance`, `denyChain`, `applyStepDecision`, the lookup in self-approval, the coverage/report queries) takes the transaction type as a parameter or reads it off the record/step it's already been handed, and looks up the right constant from `TXN`. Banding (`buildChain`) filters Approval Levels by the record's transaction type via the new "Applies To" field. This is the bulk of the work — call it the core of the effort. |
| `rax_ue_vb_approval.js` | Generalize slightly (it already just calls into the lib) and give it a second **Script Deployment** applied to Purchase Order, alongside its existing Vendor Bill deployment. Consider renaming the file to `rax_ue_txn_approval.js` for clarity since it's no longer Bill-specific, though that's cosmetic and not required to ship. |
| `rax_sl_my_approvals.js` | Currently searches only `search.Type.VENDOR_BILL`. Needs to also surface Purchase Orders awaiting the logged-in user's action. **Decided:** one **merged queue** rather than a second Suitelet or separate tabs, so an approver acting on both sees one worklist. Build it with **both** a visible Type column (Bill vs PO) *and* a filter control, so the default view shows everything and the filter narrows it — nothing is hidden unless the approver chooses to hide it. |
| `rax_sl_approval_action.js` | `redirect.toRecord({ type: record.Type.VENDOR_BILL, ... })` needs to redirect to whichever type the step actually belongs to. Store the transaction type on the step record (or resolve it via `search.lookupFields` against both types, or simplest: pass the type through the button URL's query string) so the redirect lands on the right record. |
| `rax_sl_approval_admin.js` / `rax_cs_approval_admin.js` | Add a **Transaction Type toggle** (two tabs or a dropdown: "Vendor Bill" / "Purchase Order") at the top of the matrix grid. Selecting one filters the grid to Levels tagged for that type (or Both) and the coverage report runs against that type's transactions. This keeps the admin experience in one place, as the colleague suggested, rather than a second Suitelet. |
| `rax_ue_matrix_validate.js` | No logic change needed — (Level, Department) uniqueness is still correct since a Level is now type-scoped. |
| `rax_cs_vb_approval.js` (Approve/Deny buttons) | Rename to something type-neutral and add a second Client Script deployment on the PO form, same pattern as the UE. |
| `rax_ue_vp_guard.js` (Bill Payment guard) | **Leave Bill-only.** A Purchase Order doesn't have a Bill Payment analog — POs flow into Bills downstream, and this project's existing scope stops at "don't let an unapproved bill get paid." Whether an unapproved PO should block downstream bill creation is a separate question worth raising with the colleague (§7), not something to build speculatively now. |

## 6. Form / UI changes (no script involved)

- Add the RAX Approval subtab (already exists as `custtab_rax_approval`, shared) to the Purchase Order transaction form, with the same body fields placed on it as the Bill form.
- Add the Approve/Deny buttons to the PO form via the client script deployment above.
- Confirm **Setup → Accounting → Preferences → Approval Routing → Purchase Orders** is checked, mirroring the Vendor Bills checkbox called out in the current README — same reasoning applies (makes `approvalstatus`/`nextapprover` writable, doesn't itself queue anything). *(Corrected from an earlier draft of this doc, which pointed at Enable Features instead — Approval Routing lives under Accounting Preferences.)*
- Undeploy/disable any native SuiteFlow or supervisor-hierarchy approval on Purchase Order, same as was done for Vendor Bill. **Confirmed in SBX:** no existing scripts or workflows govern PO approval today, so there's nothing to disable — this step is just enabling the preference above.

## 7. Design decisions — finalized

Resolved by David / Rion stakeholders (see `RionAX_PO_Standardization_Inventory.xlsx`, "Key Design Decisions" tab) before build starts:

1. **Same $ thresholds and approvers for PO as Bill.** Existing Approval Level records migrate tagged "Both" — no independent PO bands for this phase (§4.1).
2. **My Approvals: one merged queue**, shown with both a Type column and a filter (§5).
3. **PO approval does not survive into the Bill it becomes.** Fully independent chains — matches how NetSuite otherwise treats the two transactions as unrelated (§5, `rax_lib_approval.js`).
4. **Universal approver / self-approval policy is shared** across both types, with the "Applies To" toggle hidden from the admin UI rather than removed from the schema (§4.2).
5. **No existing native approval routing or SuiteFlow is active on Purchase Order in SBX.** Nothing to disable; the only action needed is enabling the Approval Routing accounting preference for Purchase Orders (§6).

No open design questions remain for this phase.

## 8. Suggested build order (SBX)

1. Add "Applies To" field to Approval Level and Setting; tag existing Levels **Both**; hide the Setting field from the admin Suitelet.
2. Generalize `rax_lib_approval.js` behind the `TXN` config map — this is the load-bearing change everything else depends on.
3. Add the second UE deployment (Purchase Order) and confirm a test PO builds a chain correctly.
4. Update the two Suitelets (My Approvals merge with Type column + filter, admin grid type toggle) and the action redirect.
5. Form work: Approval subtab + buttons on the PO form; enable **Setup → Accounting → Preferences → Approval Routing → Purchase Orders**.
6. Re-run the existing test script (README §"Test script") against Purchase Orders. Even though bands are shared today, still run one cross-type test (approve a Bill and a PO for the same department in the same session) to confirm the two chains stay independent, since that's the behavior §7.3 actually depends on.

## 9. What this does *not* require

- No fork of the 1,100-line engine.
- No new custom body fields (the Purchase category flag already covers them).
- No change to the rule/matrix record schema.
- No change to the Level/Department uniqueness validation.

This keeps the maintenance surface to one engine and one admin screen, which is what "keep it in the same place" was asking for, while still letting Bill and PO diverge on thresholds and approvers wherever Rion actually needs them to.

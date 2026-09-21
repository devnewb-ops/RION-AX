# Handoff: RionAX Approval Workflow — Purchase Order Extension

**Project:** Rion (NorthShoreConsulting)
**Prepared:** 2026-09-16
**Purpose:** Context for a Claude Code session that will implement and deploy this change to SBX.

## Background

Rion has a working custom approval engine (`RionAX_ApprovalWorkflow`, SDF project, currently v6.3) that routes **Vendor Bills** through a Department × Approval Level matrix, deployed in both Prod and SBX. The colleague who owns this wants the same matrix-driven approval experience extended to **Purchase Orders**, configured through the same admin UI where possible. Scope for this phase is **SBX only**.

## What's been done so far (planning, no code changes yet)

1. Pulled apart the existing SDF project (`RionAX_ApprovalWorkflow.zip` in the Rion "Approval WF" folder) — 9 SuiteScript files (~3,000 lines total) and ~20 custom objects (records, fields, lists, center categories).
2. Confirmed the engine's data model is mostly transaction-type-agnostic already: every custom body field is flagged `bodypurchase=T` (covers the whole Purchase transaction family, PO included) and the approval-step child record's parent field is typed to the generic Transaction reference (`-30`), not specifically Vendor Bill. **No new custom fields are needed.**
3. Identified the actual gap: `record.Type.VENDOR_BILL` / `search.Type.VENDOR_BILL` are hardcoded in ~12 places across `rax_lib_approval.js`, `rax_ue_vb_approval.js`, `rax_sl_my_approvals.js`, and `rax_sl_approval_action.js`.
4. Wrote a design doc (`PO_Approval_Extension_Design.md`, saved in the Rion project and the Approval WF folder) recommending: **one shared engine, generalized to be transaction-type-aware, deployed via two Script Deployment records** (Vendor Bill + Purchase Order) on the existing User Event script — rather than forking the codebase or building a manual mode-toggle field. Bill/PO divergence in thresholds and approvers is handled by tagging the **Approval Level** record with an "Applies To" field (Bill / PO / Both), not by duplicating the matrix engine.
5. Built a full **object inventory** (`RionAX_PO_Standardization_Inventory.xlsx`, in the same folder) — all 19 objects, each tagged with the action needed: No change / Add field / Code change / New deployment / Form config.
6. Logged **5 outstanding design decisions** that should ideally be confirmed before or during the build (see below) — none have been answered yet as of this handoff.

## Files to pull into the Claude Code session

All in: `Rion\Approval WF\` (also mirrored in the "Rion" Claude project as docs)

- `RionAX_ApprovalWorkflow.zip` — the current SDF project (source of truth for the existing Vendor Bill implementation)
- `PO_Approval_Extension_Design.md` — the full design/architecture recommendation
- `RionAX_PO_Standardization_Inventory.xlsx` — object-by-object action list (tab 1) and open decisions (tab 2)

## Recommended build order (from the design doc)

1. Add "Applies To" field (Bill / PO / Both) to `customrecord_rax_approval_level`; tag existing Level records.
2. Generalize `rax_lib_approval.js` behind a small transaction-type config map — this is the load-bearing change everything else depends on.
3. Add a second User Event deployment (Purchase Order) for `rax_ue_vb_approval.js`; confirm a test PO builds a chain correctly.
4. Update `rax_sl_my_approvals.js` (merge Bill + PO into one queue with a Type column) and `rax_sl_approval_action.js` (fix the redirect to resolve the correct transaction type).
5. Add a Transaction Type toggle to `rax_sl_approval_admin.js`'s matrix grid.
6. Add a second Client Script deployment (Approve/Deny buttons) on the PO form; add the Approval subtab/fields to the PO form; enable Setup → Company → Enable Features → Approval Routing → Purchase Orders in SBX.
7. Re-run the existing Vendor Bill test script against Purchase Orders, plus a mixed test where the same department has different PO vs. Bill bands, to confirm the two chains don't cross-contaminate.

`rax_ue_vp_guard.js` (Bill Payment guard), `rax_ue_matrix_validate.js`, `rax_cs_approval_admin.js`, the matrix rule record, the step record, and the custom list all need **no changes** — see the inventory spreadsheet for the full reasoning per object.

## Open decisions — confirm before or during build

These don't block starting the code generalization (step 2 above), but do need answers before the deployment/config steps:

1. **Threshold sharing** — do Bill and PO reuse the same $ bands and approvers, or does PO get independent Level records? *(No recommendation — this is Rion's call.)*
2. **My Approvals layout** — merged queue with a Type column, or separate tabs? *(Recommended: merged.)*
3. **PO → Bill relationship** — fully independent approval chains, or should the resulting Bill inherit/skip based on PO approval? *(Recommended: independent — simplest, matches how NetSuite treats the two transactions.)*
4. **Settings scope** — shared self-approval/fallback policy for both types, or a separate settings record for PO? *(Recommended: shared, default "Applies To" = Both.)*
5. **Existing native/SuiteFlow approval on PO in SBX** — needs to be checked and disabled before go-live, same as was done for Vendor Bill.

## Next step (this handoff is for)

Implement the above in the SDF project, deploy to SBX, and test end-to-end using the build order and test cases referenced in the design doc and the existing project README's test script (adapted for Purchase Orders).

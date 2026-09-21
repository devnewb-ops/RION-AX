# RION-AX

NetSuite SuiteScript customizations for Rion Aesthetics (RionAX).

This repo holds three separate solutions, each with its own SDF project(s), docs, and archive of superseded files:

- [`po-approval/`](po-approval/) — Vendor Bill & Purchase Order approval workflow. Latest package pushed to SBX: `po-approval/RionAX_ApprovalWorkflow_PO.zip` (v6.4-po). See `po-approval/README.md` for full engine details, deploy notes, and known limitations.
- [`item-receipt-adjustment/`](item-receipt-adjustment/) — Item Receipt depletion adjustment (SBX and PROD SDF projects).
- [`lot-field/`](lot-field/) — Lot source capture client script (SBX SDF project).

Each solution folder follows:
- `RionAX_<Solution>_SDF_<SBX|PROD>/` — the SuiteCloud (SDF) project(s) actually deployed.
- `docs/` — design docs, test plans, handoff notes for that solution.
- `archive/` — superseded zips/scripts kept for reference, not active.

`/docs` at the repo root holds client-wide deliverables (estimates, SDDs) not tied to a single solution.

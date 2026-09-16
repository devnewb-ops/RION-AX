Claude Code Instructions

## Project context
This repo contains NetSuite SuiteScript customizations for [Client Name].
Engagement type: [retainer / project / one-off]. Read README.md for full context.

## Never do without asking first
- Deploy or push changes to the production NetSuite account.
- Push directly to `main` — work in a branch, open a PR for review.
- Delete or overwrite existing scripts without confirming first.

## Folder structure (follow this)
- `/src` — SuiteScript source files
- `/deploy` — SDF XML (script + deployment records)
- `/docs` — deliverables, estimates, notes for this client
- Ask before creating a new top-level folder.

## Naming conventions
- Scripts: `nsc_[type]_solutionname` (lowercase, underscores)
  - `ue` = User Event · `cs` = Client Script · `sl` = Suitelet
  - `mr` = Map/Reduce · `sched` = Scheduled Script · `rl` = RESTlet · `wf` = Workflow Action
  - Example: `nsc_ue_autoapprovepo`
- Deliverables (docx/pptx/pdf/xlsx): `ClientName_DocType_YYYY-MM-DD`

## SuiteScript standards (always follow)
- Default to **SuiteScript 2.1** unless told otherwise.
- Use `define()` with proper dependency injection — no monolithic scripts.
- Include JSDoc annotations: `@NApiVersion`, `@NScriptType`, `@NModuleScope`.
- Every script needs try/catch with `N/log` error logging.
- Never fabricate field IDs or API signatures — use a clearly marked placeholder and flag it for me to verify.
- Prefer native NetSuite solutions (fields, SuiteFlow, saved searches) over custom code — only write a script when native options don't cover it, and say why.
- Avoid `record.load()` in loops; prefer `search.lookupFields()`, `submitFields()`, or `N/query` where possible.
- Note governance cost for anything long-running or high-volume.
- For bigger builds, this repo can use the `netsuite-suitescript-codegen` skill (after an estimate) — it enforces this same standard in more depth.

## Data sensitivity
- Normal care — don't reference this client's data/config in work for other clients.

## Notes
- (anything else Claude should always know before working in this repo)
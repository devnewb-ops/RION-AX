/**
 * rax_cs_next_approver_guard.js  —  RAX v6.4-po
 *
 * Standalone Client Script deployment (Vendor Bill + Purchase Order) - not
 * attached via a UE's form.clientScriptModulePath, so it fires unconditionally
 * on every load/edit rather than only when another script's gating logic
 * happens to attach it.
 *
 * COSMETIC GUARD, per customer request: keeps a human editing the native
 * nextapprover field pointed at the current step's primary or secondary
 * approver, read from custbody_rax_appr_approver / custbody_rax_appr_secondary
 * (kept in lockstep with the Current customrecord_rax_appr_step by
 * rax_lib_approval.js - see BILL.approver/secondary writes there). This does
 * NOT change who may act: rax_sl_my_approvals.js already lists both approvers
 * by querying the step record directly, independent of nextapprover. This
 * guard never writes to custrecord_rax_appr_step and never runs during the
 * engine's own server-side submitFields calls, so it cannot fight the engine.
 *
 * PLATFORM LIMIT (confirmed - no documented API covers this): nextapprover is
 * a standard field backed by its own dynamic employee search popup, not a
 * static <select>. There is no supported client or server API to prune that
 * popup's search results the way addSelectOption/insertSelectOption does for
 * custom fields. This guard instead validates on fieldChanged/saveRecord and
 * reverts/blocks an out-of-list pick - the popup itself will keep listing
 * every employee; only the accepted value is constrained.
 *
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/log'], (log) => {

    const NEXT_APPROVER_FIELD = 'nextapprover';
    const BODY = {
        approver:  'custbody_rax_appr_approver',
        secondary: 'custbody_rax_appr_secondary'
    };

    // Last value the guard accepted, so an out-of-list pick can be reverted
    // instead of just cleared.
    let lastValidNextApprover = '';

    /**
     * Primary/secondary of the record's current approval step, or [] when
     * there isn't one (not yet routed, or already fully approved - both
     * clear these fields, see rax_lib_approval.js BILL.approver/secondary).
     * An empty result means "nothing to restrict against" - the guard steps
     * aside rather than blocking the native field.
     */
    const getAllowedApprovers = (rec) => {
        const primary = rec.getValue({ fieldId: BODY.approver });
        const secondary = rec.getValue({ fieldId: BODY.secondary });
        return [primary, secondary].filter((v) => v).map(String);
    };

    const pageInit = (context) => {
        try {
            const rec = context.currentRecord;
            lastValidNextApprover = String(rec.getValue({ fieldId: NEXT_APPROVER_FIELD }) || '');
        } catch (e) {
            log.error({ title: 'rax_cs_next_approver_guard pageInit failed', details: e.message });
        }
    };

    const fieldChanged = (context) => {
        if (context.fieldId !== NEXT_APPROVER_FIELD) return;
        try {
            const rec = context.currentRecord;
            const allowed = getAllowedApprovers(rec);
            if (!allowed.length) {
                lastValidNextApprover = String(rec.getValue({ fieldId: NEXT_APPROVER_FIELD }) || '');
                return;
            }
            const val = String(rec.getValue({ fieldId: NEXT_APPROVER_FIELD }) || '');
            if (val && allowed.indexOf(val) === -1) {
                alert('Next Approver must be the primary or secondary approver for the current approval step.');
                rec.setValue({ fieldId: NEXT_APPROVER_FIELD, value: lastValidNextApprover, ignoreFieldChange: true });
                return;
            }
            lastValidNextApprover = val;
        } catch (e) {
            log.error({ title: 'rax_cs_next_approver_guard fieldChanged failed', details: e.message });
        }
    };

    const saveRecord = (context) => {
        try {
            const rec = context.currentRecord;
            const allowed = getAllowedApprovers(rec);
            if (!allowed.length) return true;
            const val = String(rec.getValue({ fieldId: NEXT_APPROVER_FIELD }) || '');
            if (val && allowed.indexOf(val) === -1) {
                alert('Next Approver must be the primary or secondary approver for the current approval step.');
                return false;
            }
            return true;
        } catch (e) {
            // Cosmetic guard: fail open rather than blocking a save over a bug here.
            log.error({ title: 'rax_cs_next_approver_guard saveRecord failed', details: e.message });
            return true;
        }
    };

    return { pageInit, fieldChanged, saveRecord };
});

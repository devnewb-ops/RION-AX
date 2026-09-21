/**
 * rax_cs_vb_approval.js  —  RAX v6.0
 *
 * Attached by rax_ue_vb_approval - no deployment record needed.
 * Button handlers only.
 *
 * The previous version imported the server library to render a live preview of
 * the approval outcome as the user typed. That is dropped deliberately: it ran
 * several searches on every field change, and the chain now depends on line
 * departments and subtotals that are not stable until save. The approval tab
 * shows the resolved chain immediately after saving.
 *
 * The Next Approver guard used to live here; it moved to its own standalone
 * deployment (rax_cs_next_approver_guard.js) so it fires unconditionally on
 * every Bill/PO load instead of only when this file happens to be attached
 * by the UE's approver-gated beforeLoad logic.
 *
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/currentRecord', 'N/url'], (currentRecord, url) => {

    const goToAction = (action) => {
        const rec = currentRecord.get();
        window.location = url.resolveScript({
            scriptId: 'customscript_rax_sl_approval_action',
            deploymentId: 'customdeploy_rax_sl_approval_action',
            params: { billid: rec.id, action: action, src: 'record', type: rec.type }
        });
    };

    return {
        pageInit: () => {},
        raxApprove: () => goToAction('approve'),
        raxDeny: () => goToAction('deny')
    };
});

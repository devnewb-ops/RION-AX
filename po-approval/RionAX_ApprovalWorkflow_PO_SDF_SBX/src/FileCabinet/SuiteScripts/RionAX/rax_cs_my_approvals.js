/**
 * rax_cs_my_approvals.js  —  RAX v6.3-po
 *
 * Attached by rax_sl_my_approvals. The Show (type) filter is a plain SELECT
 * with no submit button of its own, so picking a value reloads the page with
 * that value on the query string - the Suitelet re-renders the queue
 * server-side already filtered, matching how the list resets any other GET
 * parameter.
 *
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/currentRecord', 'N/url'], (currentRecord, url) => {

    const fieldChanged = (context) => {
        if (context.fieldId !== 'custpage_type_filter') return;
        const value = context.currentRecord.getValue({ fieldId: 'custpage_type_filter' });
        // Changing this filter is the intended reload, not an accidental
        // navigation away from unsaved edits - suppress NetSuite's native
        // "Leave site?" prompt before triggering it.
        window.onbeforeunload = null;
        window.location = url.resolveScript({
            scriptId: 'customscript_rax_sl_my_approvals',
            deploymentId: 'customdeploy_rax_sl_my_approvals',
            params: { custpage_type_filter: value }
        });
    };

    return { fieldChanged };
});

/**
 * rax_sl_approval_action.js  —  RAX v6.3-po
 *
 * Applies a decision against the CURRENT step of a transaction's approval
 * chain (Vendor Bill or Purchase Order). Reached from the record buttons or
 * the My Approvals list.
 *
 * Approve is applied on GET. Deny renders a short form first so the reason is
 * captured, then applies on POST. Authorisation is re-validated server-side in
 * the library on every call, against freshly read state - the buttons are
 * convenience, not security.
 *
 * Params: billid, action (approve|deny), src (record|list), type (optional -
 *   a record.Type value; the record buttons and My Approvals list both send
 *   it, so the redirect and the lib calls below know the type without an
 *   extra lookup. Falls back to a generic transaction search when absent.),
 *   typefilter (optional - the My Approvals list's own Type filter selection,
 *   round-tripped so returning to that list after a decision keeps the
 *   filter the approver had set instead of resetting to "All Types").
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/redirect', 'N/record', 'N/ui/serverWidget', './rax_lib_approval'],
(redirect, record, serverWidget, lib) => {

    const onRequest = (context) => {
        const req = context.request;
        const p = req.parameters;
        const isPost = req.method === 'POST';
        // The deny form re-submits these as custpage_-prefixed fields (required
        // for Suitelet form field ids), unlike the plain params the action links use.
        const action = (isPost ? p.custpage_action : p.action) === 'approve' ? 'approve' : 'deny';
        const src = (isPost ? p.custpage_src : p.src) === 'list' ? 'list' : 'record';
        const billId = isPost ? p.custpage_billid : p.billid;
        const typeFilter = isPost ? p.custpage_typefilter : p.typefilter;
        const txn = lib.resolveTxn(isPost ? p.custpage_type : p.type) ||
            (billId ? lib.resolveTxnForId(billId) : lib.TXN.VENDOR_BILL);

        if (!billId) return finish(context, src, null, txn, 'Missing transaction reference.', typeFilter);

        if (req.method === 'GET' && action === 'deny') {
            context.response.writePage(denyForm(billId, src, txn, typeFilter));
            return;
        }

        const comment = (req.method === 'POST' ? req.parameters.custpage_reason : '') || '';

        let result;
        try {
            result = lib.applyStepDecision(billId, action, comment, txn);
        } catch (e) {
            log.error({ title: 'RAX applyStepDecision failed',
                details: 'transaction=' + billId + ' action=' + action + ' :: ' + e.message });
            result = { ok: false, reason: 'The decision could not be applied: ' + e.message };
        }

        finish(context, src, billId, txn, result.ok ? result.reason : 'Not applied: ' + result.reason,
            typeFilter);
    };

    const denyForm = (billId, src, txn, typeFilter) => {
        const form = serverWidget.createForm({ title: 'Deny ' + txn.label });
        form.addField({ id: 'custpage_billid', type: serverWidget.FieldType.TEXT, label: 'Transaction' })
            .updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN })
            .defaultValue = String(billId);
        form.addField({ id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action' })
            .updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN })
            .defaultValue = 'deny';
        form.addField({ id: 'custpage_src', type: serverWidget.FieldType.TEXT, label: 'Source' })
            .updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN })
            .defaultValue = src;
        form.addField({ id: 'custpage_type', type: serverWidget.FieldType.TEXT, label: 'Type' })
            .updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN })
            .defaultValue = txn.recordType;
        form.addField({ id: 'custpage_typefilter', type: serverWidget.FieldType.TEXT, label: 'Type Filter' })
            .updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN })
            .defaultValue = typeFilter || '';

        const reason = form.addField({
            id: 'custpage_reason', type: serverWidget.FieldType.TEXTAREA, label: 'Reason for Denial'
        });
        reason.isMandatory = true;
        reason.setHelpText({
            help: 'This is recorded on the approval step and shown on the transaction. Denying ' +
                  'clears the remaining steps; the preparer must correct and resubmit it.'
        });

        form.addSubmitButton({ label: 'Deny ' + txn.label });
        form.addButton({ id: 'custpage_cancel', label: 'Cancel', functionName: 'history.back' });
        return form;
    };

    const finish = (context, src, billId, txn, msg, typeFilter) => {
        if (src === 'list' || !billId) {
            redirect.toSuitelet({
                scriptId: 'customscript_rax_sl_my_approvals',
                deploymentId: 'customdeploy_rax_sl_my_approvals',
                parameters: { custparam_msg: msg, custpage_type_filter: typeFilter || '' }
            });
            return;
        }
        redirect.toRecord({ type: txn.recordType, id: billId });
    };

    return { onRequest };
});

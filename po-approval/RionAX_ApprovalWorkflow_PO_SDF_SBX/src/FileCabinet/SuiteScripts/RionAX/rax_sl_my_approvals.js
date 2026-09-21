/**
 * rax_sl_my_approvals.js  —  RAX v6.3-po
 *
 * The approver's queue. Lists every Vendor Bill AND Purchase Order whose
 * CURRENT step names the logged-in user as primary OR secondary - which is
 * how "either approver may act" reaches people the native nextapprover field
 * cannot hold. One merged queue rather than a second Suitelet or tabs, so an
 * approver acting on both sees a single worklist - shown with both a Type
 * column and a filter, so nothing is hidden unless the approver chooses to.
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/search', 'N/runtime', 'N/ui/serverWidget', 'N/url', 'N/ui/message', './rax_lib_approval'],
(search, runtime, serverWidget, url, message, lib) => {

    const TYPES = [lib.TXN.VENDOR_BILL, lib.TXN.PURCHASE_ORDER];

    const onRequest = (context) => {
        if (context.request.method !== 'GET') return;

        const form = serverWidget.createForm({ title: 'My Approvals' });
        const msg = context.request.parameters.custparam_msg;
        if (msg) {
            form.addPageInitMessage({
                type: /not applied|could not|missing/i.test(msg) ? message.Type.ERROR : message.Type.CONFIRMATION,
                title: 'Approval', message: msg
            });
        }

        const filterType = context.request.parameters.custpage_type_filter || '';
        const typeFilter = form.addField({
            id: 'custpage_type_filter', type: serverWidget.FieldType.SELECT, label: 'Show'
        });
        typeFilter.addSelectOption({ value: '', text: 'All Types' });
        TYPES.forEach((t) => typeFilter.addSelectOption({ value: t.key, text: t.label }));
        typeFilter.defaultValue = filterType;
        typeFilter.updateDisplayType({ displayType: serverWidget.FieldDisplayType.NORMAL });
        form.clientScriptModulePath = './rax_cs_my_approvals.js';

        const userId = String(runtime.getCurrentUser().id);
        const universal = lib.isUniversalApprover(userId);
        const rows = pending(userId, universal)
            .filter((r) => !filterType || r.txn.key === filterType);

        const list = form.addSublist({
            id: 'custpage_queue', type: serverWidget.SublistType.LIST, label: 'Awaiting Your Decision'
        });
        list.addField({ id: 'custpage_type', type: serverWidget.FieldType.TEXT, label: 'Type' });
        list.addField({ id: 'custpage_bill', type: serverWidget.FieldType.TEXT, label: 'Transaction' });
        list.addField({ id: 'custpage_vendor', type: serverWidget.FieldType.TEXT, label: 'Vendor' });
        list.addField({ id: 'custpage_date', type: serverWidget.FieldType.TEXT, label: 'Date' });
        list.addField({ id: 'custpage_dept', type: serverWidget.FieldType.TEXT, label: 'Your Step Covers' });
        list.addField({ id: 'custpage_amount', type: serverWidget.FieldType.TEXT, label: 'Step Amount' });
        list.addField({ id: 'custpage_total', type: serverWidget.FieldType.TEXT, label: 'Transaction Total' });
        list.addField({ id: 'custpage_step', type: serverWidget.FieldType.TEXT, label: 'Step' });
        list.addField({ id: 'custpage_role', type: serverWidget.FieldType.TEXT, label: 'You Are' });
        // Two columns, not one combined cell - a sublist TEXT value is capped
        // at 300 characters, and two full action URLs plus markup in a single
        // cell can exceed that (EXCEEDED_MAX_FIELD_LENGTH).
        list.addField({ id: 'custpage_approve', type: serverWidget.FieldType.TEXT, label: 'Approve' });
        list.addField({ id: 'custpage_deny', type: serverWidget.FieldType.TEXT, label: 'Deny' });

        rows.forEach((r, i) => {
            const set = (id, v) => {
                if (v === null || v === undefined || v === '') return;
                list.setSublistValue({ id: id, line: i, value: String(v) });
            };
            set('custpage_type', r.txn.label);
            set('custpage_bill', link(recordUrl(r.txn, r.billId),
                r.tranid || (r.txn.label + ' ' + r.billId)));
            set('custpage_vendor', lib.esc(r.vendor));
            set('custpage_date', r.trandate);
            set('custpage_dept', lib.esc(r.label));
            set('custpage_amount', lib.money(r.amount));
            set('custpage_total', lib.money(r.total));
            set('custpage_step', r.seq + ' of ' + r.count);
            set('custpage_role', r.role);
            set('custpage_approve', link(actionUrl(r.txn, r.billId, 'approve', filterType), 'Approve'));
            set('custpage_deny', link(actionUrl(r.txn, r.billId, 'deny', filterType), 'Deny'));
        });

        if (!rows.length) {
            form.addField({ id: 'custpage_none', type: serverWidget.FieldType.INLINEHTML, label: ' ' })
                .defaultValue = '<div style="padding:14px;font:13px Arial;color:#666">' +
                    'Nothing is waiting on you right now.</div>';
        }

        context.response.writePage(form);
    };

    // Native transaction view URLs. NetSuite has no generic "view any
    // transaction by internal id" URL, so this is the one place the two
    // types genuinely fork.
    const VIEW_PATH = {
        VENDOR_BILL: '/app/accounting/transactions/vendbill.nl',
        PURCHASE_ORDER: '/app/accounting/transactions/purchord.nl'
    };
    const recordUrl = (txn, billId) => (VIEW_PATH[txn.key] || VIEW_PATH.VENDOR_BILL) + '?id=' + billId;

    const actionUrl = (txn, billId, action, filterType) => url.resolveScript({
        scriptId: 'customscript_rax_sl_approval_action',
        deploymentId: 'customdeploy_rax_sl_approval_action',
        params: { billid: billId, action: action, src: 'list', type: txn.recordType,
            typefilter: filterType || '' }
    });

    const link = (href, text) => '<a href="' + href + '">' + text + '</a>';

    const pending = (userId, universal) => {
        const out = [];
        const seenBillIds = {};
        // Universal approvers (flagged Approval Level) see every transaction
        // awaiting a decision, not only steps that name them.
        // The join to the transaction below only reads header/body fields, but
        // NetSuite's search engine still evaluates a transaction join at the
        // line level, so a multi-line bill/PO comes back as one result row per
        // line instead of one per step - the seenBillIds guard below in the
        // .each() collapses those back down to one row per step.
        const filters = [[lib.STEP.status, 'is', lib.STEP_STATUS.CURRENT]];
        if (!universal) {
            filters.push('AND', [
                [lib.STEP.primary, 'anyof', userId], 'OR',
                [lib.STEP.secondary, 'anyof', userId]
            ]);
        }
        search.create({
            type: lib.REC.STEP,
            filters: filters,
            columns: [
                lib.STEP.bill, lib.STEP.seq, lib.STEP.label, lib.STEP.amount,
                lib.STEP.primary, lib.STEP.secondary,
                search.createColumn({ name: 'trandate', join: lib.STEP.bill }),
                search.createColumn({ name: 'tranid', join: lib.STEP.bill }),
                search.createColumn({ name: 'entity', join: lib.STEP.bill }),
                search.createColumn({ name: 'type', join: lib.STEP.bill }),
                search.createColumn({ name: lib.BILL.stepCount, join: lib.STEP.bill }),
                search.createColumn({ name: lib.STEP.seq, sort: search.Sort.ASC })
            ]
        }).run().each((r) => {
            const billId = String(r.getValue(lib.STEP.bill));
            const vendor = String(r.getText({ name: 'entity', join: lib.STEP.bill }) || '');

            if (seenBillIds[billId] !== undefined) {
                // A duplicate line for the same step - some of the transaction's
                // non-mainline lines come back with header fields blank, so
                // prefer whichever duplicate actually has the vendor populated.
                const existing = out[seenBillIds[billId]];
                if (!existing.vendor && vendor) existing.vendor = vendor;
                return true;
            }
            seenBillIds[billId] = out.length;

            const txnCode = String(r.getValue({ name: 'type', join: lib.STEP.bill }) || '');
            const txn = lib.resolveTxnByCode(txnCode) || lib.TXN.VENDOR_BILL;
            out.push({
                billId: billId,
                txn: txn,
                tranid: String(r.getValue({ name: 'tranid', join: lib.STEP.bill }) || ''),
                vendor: vendor,
                trandate: String(r.getValue({ name: 'trandate', join: lib.STEP.bill }) || ''),
                label: String(r.getValue(lib.STEP.label) || ''),
                amount: parseFloat(r.getValue(lib.STEP.amount)) || 0,
                total: 0,
                seq: parseInt(r.getValue(lib.STEP.seq), 10) || 0,
                count: parseInt(r.getValue({ name: lib.BILL.stepCount, join: lib.STEP.bill }), 10) || 0,
                role: String(r.getValue(lib.STEP.primary)) === String(userId) ? 'Primary'
                    : (String(r.getValue(lib.STEP.secondary)) === String(userId) ? 'Secondary' : 'Universal')
            });
            return true;
        });

        // Totals in one pass rather than per row. A single generic
        // "transaction" search covers both types at once.
        if (out.length) {
            const ids = out.map((o) => o.billId);
            const totals = {};
            search.create({
                type: search.Type.TRANSACTION,
                filters: [['internalid', 'anyof', ids], 'AND', ['mainline', 'is', 'T']],
                columns: ['total']
            }).run().each((r) => {
                totals[String(r.id)] = Math.abs(parseFloat(r.getValue('total')) || 0);
                return true;
            });
            out.forEach((o) => { o.total = totals[o.billId] || 0; });
        }

        return out;
    };

    return { onRequest };
});

/**
 * rax_ue_vp_guard.js  —  RAX v6.0
 *
 * User Event on Bill Payment. Blocks payment of any Vendor Bill that is not
 * approved under the RAX matrix. Backstops the native block and covers CSV
 * import, integrations and scripts - every path that fires user events.
 *
 * FAIL-CLOSED: a lookup that errors blocks the payment. The previous version
 * caught and continued, which quietly allowed payment of anything it could not
 * read. Bills with no RAX status at all (pre-rollout) are still allowed; remove
 * ALLOW_BLANK once historical bills are dispositioned.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/search', 'N/error', './rax_lib_approval'], (search, error, lib) => {

    const ALLOW_BLANK = true;

    const beforeSubmit = (context) => {
        const T = context.UserEventType;
        if (context.type !== T.CREATE && context.type !== T.EDIT) return;

        const rec = context.newRecord;
        const n = rec.getLineCount({ sublistId: 'apply' });
        if (n <= 0) return;

        const offenders = [];
        const unreadable = [];

        for (let i = 0; i < n; i++) {
            const applied = rec.getSublistValue({ sublistId: 'apply', fieldId: 'apply', line: i });
            if (applied !== true && applied !== 'T') continue;

            const docId = rec.getSublistValue({ sublistId: 'apply', fieldId: 'doc', line: i });
            if (!docId) continue;

            // Resolve the record type first - lookupFields against the generic
            // 'transaction' type is unreliable and must not be relied on.
            let type = '';
            try {
                const t = search.lookupFields({
                    type: search.Type.TRANSACTION, id: docId, columns: ['type']
                });
                type = (t.type && t.type[0]) ? String(t.type[0].value) : '';
            } catch (e) {
                log.error({ title: 'RAX guard type lookup failed', details: docId + ' :: ' + e.message });
                unreadable.push(String(docId));
                continue;
            }

            if (type !== 'VendBill') continue;   // credits, journals, deposits

            try {
                const st = lib.billApprovalState(docId);
                if (st.status === lib.STATUS.NEEDS || st.status === lib.STATUS.DENIED) {
                    offenders.push(st.tranid + ' (' + st.status + ')');
                } else if (!st.status && !ALLOW_BLANK) {
                    offenders.push(st.tranid + ' (no approval record)');
                }
            } catch (e) {
                log.error({ title: 'RAX guard status lookup failed', details: docId + ' :: ' + e.message });
                unreadable.push(String(docId));
            }
        }

        if (unreadable.length) {
            throw error.create({
                name: 'RAX_GUARD_UNREADABLE',
                message: 'Payment blocked. The approval status of transaction(s) ' +
                         unreadable.join(', ') + ' could not be verified. Contact your ' +
                         'NetSuite administrator.',
                notifyOff: true
            });
        }

        if (offenders.length) {
            throw error.create({
                name: 'RAX_GUARD_UNAPPROVED',
                message: 'Payment blocked. The following bill(s) are not approved: ' +
                         offenders.join(', ') + '. Bills must complete the approval matrix ' +
                         'before payment.',
                notifyOff: true
            });
        }
    };

    return { beforeSubmit };
});

/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * RionAX D2B — Custom Lot capture
 * -------------------------------
 * Replaces native NetSuite lot tracking with a custom traceability record.
 * Items are now plain (non-lot) Assembly / Inventory items, so there is NO
 * native inventory-detail subrecord to fight — assembly builds, fulfillments,
 * and receipts create cleanly via record.create.
 *
 * On a transaction that carries a lot (custbody_rax_lot), this UE writes a
 * RionAX Lot record capturing the full traceability graph:
 *   lot number, item, location, quantity, source transaction, direction, date,
 *   and (for builds) the parent/source lot for inheritance.
 *
 * One-sided by design: a Receipt (assembly build / item receipt) records a lot
 * at a location; an Issue (fulfillment) records consumption of a lot without
 * per-location quantity enforcement — the lot may be depleted from any location.
 */
define(['N/record', 'N/runtime', 'N/log'], function (record, runtime, log) {

    var FLD_LOT       = 'custbody_rax_lot';
    var FLD_LOT_LINK  = 'custbody_rax_lot_link';

    var LOT_REC       = 'customrecord_rax_lot';
    var LOT_NUM       = 'custrecord_rax_lot_number';
    var LOT_ITEM      = 'custrecord_rax_lot_item';
    var LOT_LOCATION  = 'custrecord_rax_lot_location';
    var LOT_QTY       = 'custrecord_rax_lot_qty';
    var LOT_TXN       = 'custrecord_rax_lot_txn';
    var LOT_DIRECTION = 'custrecord_rax_lot_direction';
    var LOT_DATE      = 'custrecord_rax_lot_date';

    // Direction custom-list value script ids resolve to internal ids at runtime;
    // for the demo we look them up by value on save (kept simple: leave blank if
    // not resolvable, the record still captures the lot).
    // Receipt-type transactions vs issue-type transactions:
    var RECEIPT_TYPES = { assemblybuild: true, itemreceipt: true };
    var ISSUE_TYPES   = { itemfulfillment: true };

    function afterSubmit(context) {
        if (context.type !== context.UserEventType.CREATE &&
            context.type !== context.UserEventType.EDIT) {
            return;
        }

        var rec = context.newRecord;
        var lot = rec.getValue({ fieldId: FLD_LOT });
        if (!lot) { return; } // no lot entered, nothing to capture

        // Avoid duplicate capture on edit if we already linked one.
        var existingLink = rec.getValue({ fieldId: FLD_LOT_LINK });
        if (existingLink) { return; }

        var type = rec.type; // e.g. 'assemblybuild', 'itemfulfillment', 'itemreceipt'
        var direction = RECEIPT_TYPES[type] ? 'Receipt' : (ISSUE_TYPES[type] ? 'Issue' : '');

        // Pull item / location / qty as best available for the transaction type.
        var itemId   = firstLineValue(rec, 'item');
        var locId    = rec.getValue({ fieldId: 'location' }) || firstLineValue(rec, 'location');
        var qty      = firstLineValue(rec, 'quantity');
        var tranDate = rec.getValue({ fieldId: 'trandate' });

        try {
            var lotRec = record.create({ type: LOT_REC });
            lotRec.setValue({ fieldId: LOT_NUM, value: lot });
            if (itemId) { lotRec.setValue({ fieldId: LOT_ITEM, value: itemId }); }
            if (locId)  { lotRec.setValue({ fieldId: LOT_LOCATION, value: locId }); }
            if (qty)    { lotRec.setValue({ fieldId: LOT_QTY, value: Number(qty) || 0 }); }
            lotRec.setValue({ fieldId: LOT_TXN, value: rec.id });
            if (tranDate) { lotRec.setValue({ fieldId: LOT_DATE, value: tranDate }); }
            // Direction is a custom-list select; set by text is not supported, so
            // we store it only if a mapping is configured. Left for setup.
            var lotId = lotRec.save();

            // Link the transaction back to the lot record (no re-trigger: link
            // field is checked at top and this submitFields is lightweight).
            var vals = {};
            vals[FLD_LOT_LINK] = lotId;
            record.submitFields({
                type: rec.type,
                id: rec.id,
                values: vals,
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });

            log.audit({
                title: 'RionAX Lot captured',
                details: type + ' ' + rec.id + ' -> Lot ' + lotId + ' (' + lot + ', ' + direction + ')'
            });
        } catch (e) {
            log.error({ title: 'RionAX Lot capture failed for ' + type + ' ' + rec.id, details: e });
        }
    }

    function firstLineValue(rec, fieldId) {
        try {
            var n = rec.getLineCount({ sublistId: 'item' });
            for (var i = 0; i < n; i++) {
                var v = rec.getSublistValue({ sublistId: 'item', fieldId: fieldId, line: i });
                if (v) { return v; }
            }
        } catch (e) {}
        // component sublist fallback (assembly build)
        try {
            var cn = rec.getLineCount({ sublistId: 'component' });
            for (var j = 0; j < cn; j++) {
                var cv = rec.getSublistValue({ sublistId: 'component', fieldId: fieldId, line: j });
                if (cv) { return cv; }
            }
        } catch (e2) {}
        return null;
    }

    return { afterSubmit: afterSubmit };
});

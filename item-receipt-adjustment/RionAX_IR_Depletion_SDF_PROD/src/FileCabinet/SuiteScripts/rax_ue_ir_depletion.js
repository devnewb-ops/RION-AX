/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * RionAX — Item Receipt component depletion (Finished Good Recognition Point)
 * ---------------------------------------------------------------------------
 * On Item Receipt save (CREATE), for each received line whose item has RionAX
 * Component rows (the custom bill of materials on the item's tab):
 *   - Creates an Inventory Adjustment with NEGATIVE lines depleting each
 *     component (qty-per-unit x received qty).
 *   - Location criss-cross: the adjustment's HEADER location (adjlocation)
 *     comes from the IR LINE's location (where the FG was actually received);
 *     the adjustment's component LINE locations come from the IR HEADER's
 *     location. The two swap roles relative to the source transaction. The
 *     IR line location falls back to the IR header location when the line
 *     itself has none set.
 *   - Inventory detail is written ONLY when the line's own
 *     inventorydetailreq flag says NetSuite requires it (lot/serial/bin
 *     items, bin-enabled locations, or the Inventory Status feature).
 *     Plain items at plain locations never get a detail subrecord. When
 *     required: negative quantity first, absolute as fallback.
 *   - Reads the LINE-level RionAX Lot (custcol_rax_lot; carried from the PO
 *     line) and decrements that lot's Remaining Quantity by the line qty.
 *   - Stamps custbody_rax_built on the receipt when done. An inherited
 *     Built=T from the PO on a NEWLY CREATED receipt is a false positive
 *     (body fields copy on transform) — logged and ignored.
 *
 * IA header mirrors the confirmed manual IA09: Subsidiary Rion Aesthetics
 * Inc., Adjustment Location, Account 551000 (id 205), Dept/Class Non-Specific.
 * 09/14/2026 David Patry - Updating ADJ_ACCOUNT id and DEPT_ID
 */
define(['N/record', 'N/search', 'N/log'], function (record, search, log) {

    var COL_LOT   = 'custcol_rax_lot';   // line-level lot selection
    var FLD_BUILT = 'custbody_rax_built';
    // ======================= PRODUCTION INTERNAL IDS ========================
    // Fill these four from the production account (Setup > Company lists /
    // COA). Everything else in this script is environment-independent.
    var DEPT_ID       = '11';    // Department "Non-Specific" (production)
    var CLASS_ID      = '101';  // Class "Non-Specific" (production)
    var ADJ_ACCOUNT   = '147';  // Account 551000 Cost Variances and Adjustments : Inventory Variance
    var SUBSIDIARY_ID = '2';    // Subsidiary Rion Aesthetics Inc.
    // ========================================================================
    var INV_STATUS_ID = '1';   // only used if a line requires inventory detail

    var LOT_REC       = 'customrecord_rax_lot';
    var LOT_REMAINING = 'custrecord_rax_lot_qty_remaining';

    var COMP_REC  = 'customrecord_rax_component';
    var COMP_FG   = 'custrecord_rax_comp_fg';
    var COMP_ITEM = 'custrecord_rax_comp_item';
    var COMP_QTY  = 'custrecord_rax_comp_qty';

    function afterSubmit(context) {
        log.debug({ title: 'RionAX IR depletion fired', details: 'type ' + context.type + ' | receipt ' + (context.newRecord ? context.newRecord.id : '?') });
        if (context.type !== context.UserEventType.CREATE) {
            log.debug({ title: 'RionAX IR depletion skip', details: 'non-CREATE event (' + context.type + ')' });
            return;
        }

        var ir = context.newRecord;

        // custbody_rax_built INHERITS from the PO on transform. A newly
        // created receipt cannot have been processed before, so an inherited
        // T is a false positive — log and proceed. Idempotency holds because
        // this UE only acts on CREATE and stamps the flag afterward.
        if (ir.getValue({ fieldId: FLD_BUILT })) {
            log.audit({ title: 'RionAX IR note', details: 'receipt ' + ir.id + ' inherited Built=T from its PO — ignoring on CREATE and processing normally.' });
        }

        var headerLoc = ir.getValue({ fieldId: 'location' }) || null;

        var lineCount = ir.getLineCount({ sublistId: 'item' });
        var adjIds = [];
        var totalFgQty = 0;

        for (var i = 0; i < lineCount; i++) {
            var received = ir.getSublistValue({ sublistId: 'item', fieldId: 'itemreceive', line: i });
            if (received === false || received === 'F') { continue; }

            var itemId = ir.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
            var qty    = Number(ir.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i })) || 0;
            var lineLoc = ir.getSublistValue({ sublistId: 'item', fieldId: 'location', line: i }) || headerLoc;
            var lineLot = ir.getSublistValue({ sublistId: 'item', fieldId: COL_LOT, line: i }) || null;
            // Criss-cross: the adjustment header takes the IR LINE location;
            // the adjustment's component lines take the IR HEADER location.
            var adjHeaderLoc = lineLoc;
            var adjLineLoc = headerLoc;
            log.debug({ title: 'RionAX IR line', details: 'item ' + itemId + ' qty ' + qty + ' | FG received at loc ' + lineLoc + ' | adj header loc ' + adjHeaderLoc + ' | adj component line loc ' + adjLineLoc + ' | lot ' + lineLot });

            if (!itemId || qty <= 0) { continue; }

            var comps = getComponentsForFg(itemId);
            if (!comps.length) { continue; } // not a tracked FG

            // Try one combined IA for all of this FG's components. If ANY
            // component makes the save fail, retry each component in its own
            // IA so the healthy ones still deplete and only the broken one
            // errors — by name.
            var lineOk = false;
            try {
                var adjId = createDepletionAdjustment(itemId, qty, adjHeaderLoc, adjLineLoc, comps, ir.id);
                if (adjId) { adjIds.push(adjId); lineOk = true; }
            } catch (e) {
                log.error({ title: 'RionAX combined IA failed (receipt ' + ir.id + ', FG ' + itemId + ') — retrying per component', details: (e.name || '') + ' ' + (e.message || e) });
                for (var ci = 0; ci < comps.length; ci++) {
                    try {
                        var soloId = createDepletionAdjustment(itemId, qty, adjHeaderLoc, adjLineLoc, [comps[ci]], ir.id);
                        if (soloId) { adjIds.push(soloId); lineOk = true; }
                    } catch (se) {
                        log.error({
                            title: 'RionAX component depletion failed — SKIPPED',
                            details: 'Component "' + (comps[ci].name || comps[ci].itemId) + '" (id ' + comps[ci].itemId + ') for FG ' + itemId + ': ' + (se.message || se)
                        });
                    }
                }
            }
            if (lineOk) {
                totalFgQty += qty;
                if (lineLot) {
                    try { decrementLot(lineLot, qty); }
                    catch (le) { log.error({ title: 'RionAX lot decrement failed', details: 'lot ' + lineLot + ': ' + (le.message || le) }); }
                }
            }
        }

        if (!adjIds.length) {
            log.debug({ title: 'RionAX IR depletion skip', details: 'receipt ' + ir.id + ': no adjustments created (no component rows found, or every attempt failed — see errors above).' });
            return;
        }

        try {
            var vals = {};
            vals[FLD_BUILT] = true;
            record.submitFields({ type: record.Type.ITEM_RECEIPT, id: ir.id, values: vals, options: { ignoreMandatoryFields: true } });
        } catch (fe) {
            log.error({ title: 'RionAX IR flag failed (receipt ' + ir.id + ')', details: fe });
        }

        log.audit({
            title: 'RionAX IR depletion complete',
            details: 'receipt ' + ir.id + ' -> adjustments ' + adjIds.join(',') + ' | FG qty ' + totalFgQty
        });
    }

    function getComponentsForFg(fgItemId) {
        var out = [];
        try {
            search.create({
                type: COMP_REC,
                filters: [
                    [COMP_FG, 'anyof', fgItemId], 'AND',
                    ['isinactive', 'is', 'F']   // tab hides inactive rows; the search must too
                ],
                columns: [
                    search.createColumn({ name: COMP_ITEM }),
                    search.createColumn({ name: COMP_QTY })
                ]
            }).run().each(function (r) {
                var ci = r.getValue({ name: COMP_ITEM });
                var ct = r.getText({ name: COMP_ITEM });
                var q  = Number(r.getValue({ name: COMP_QTY })) || 0;
                if (ci && q > 0) { out.push({ itemId: ci, qty: q, name: ct }); }
                return true;
            });
        } catch (e) {
            log.audit({ title: 'RionAX component search failed', details: e.message });
        }

        // Guard: adjustments on lot/serial/bin items need detail this script
        // does not supply per-item. Skip with a named log entry.
        var clean = [];
        out.forEach(function (comp) {
            var isTracked = false;
            try {
                var lf = search.lookupFields({ type: search.Type.ITEM, id: comp.itemId, columns: ['islotitem', 'isserialitem', 'usebins', 'isinactive'] });
                // lookupFields returns checkbox values as boolean true/false OR
                // as the string 'T'/'F' depending on the field/account — both
                // forms must be checked, or a genuinely tracked item silently
                // passes this guard (confirmed: item 812, a lot-numbered item,
                // slipped through with only a `=== true` check).
                isTracked = (lf.islotitem === true) || (lf.islotitem === 'T') ||
                            (lf.isserialitem === true) || (lf.isserialitem === 'T');
                comp.usesBins = (lf.usebins === true) || (lf.usebins === 'T');
                comp.itemInactive = (lf.isinactive === true) || (lf.isinactive === 'T');
            } catch (e) {}
            if (comp.itemInactive) {
                log.error({
                    title: 'RionAX component references INACTIVE item — SKIPPED',
                    details: 'Component "' + (comp.name || comp.itemId) + '" (id ' + comp.itemId + ') for FG ' + fgItemId +
                             ' points at an inactive item (an old pre-migration item). Edit this RionAX Component row and re-point it to the active replacement item.'
                });
            } else if (isTracked) {
                log.error({
                    title: 'RionAX component still lot/serial-tracked — SKIPPED',
                    details: 'Component "' + (comp.name || comp.itemId) + '" (id ' + comp.itemId + ') for FG ' + fgItemId +
                             ' is lot/serial-numbered. Re-point this RionAX Component row to the migrated non-lot item, then re-receive.'
                });
            } else if (comp.usesBins) {
                log.error({
                    title: 'RionAX component uses bins — SKIPPED',
                    details: 'Component "' + (comp.name || comp.itemId) + '" (id ' + comp.itemId + ') for FG ' + fgItemId +
                             ' has Use Bins checked, so adjustments demand a bin allocation. Uncheck Use Bins on the item, then re-receive.'
                });
            } else {
                clean.push(comp);
            }
        });
        return clean;
    }

    function createDepletionAdjustment(fgItemId, fgQty, headerLocationId, lineLocationId, comps, receiptId) {
        var adj = record.create({ type: record.Type.INVENTORY_ADJUSTMENT, isDynamic: true });

        adj.setValue({ fieldId: 'subsidiary', value: SUBSIDIARY_ID });
        adj.setValue({ fieldId: 'account', value: ADJ_ACCOUNT });
        adj.setValue({ fieldId: 'department', value: DEPT_ID });
        adj.setValue({ fieldId: 'class', value: CLASS_ID });
        adj.setValue({ fieldId: 'memo', value: 'RionAX depletion @ receipt ' + receiptId + ': FG ' + fgItemId + ' x' + fgQty });

        var added = 0;
        for (var i = 0; i < comps.length; i++) {
            adj.selectNewLine({ sublistId: 'inventory' });
            adj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'item', value: comps[i].itemId });
            if (lineLocationId) { adj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'location', value: lineLocationId }); }
            var lineQty = -(comps[i].qty * fgQty);
            adj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', value: lineQty });
            adj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'department', value: DEPT_ID });
            adj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'class', value: CLASS_ID });

            // Account-wide requirement: every adjustment line needs an
            // inventory detail (confirmed via IA09 XML on a plain item).
            // Absolute quantity + default status.
            // Only touch the inventory detail when THIS LINE requires it
            // (inventorydetailreq): sandbox (Inventory Status on) demands a
            // detail on every line; production treats it as optional, and
            // instantiating an optional detail leaves it half-configured and
            // fails the save ("still need to reconfigure"). When required,
            // sign convention still differs by account: negative first
            // (matches the line), absolute as fallback.
            var detReq = false;
            try {
                var drv = adj.getCurrentSublistValue({ sublistId: 'inventory', fieldId: 'inventorydetailreq' });
                detReq = (drv === true || drv === 'T');
            } catch (edr) {}
            log.debug({ title: 'RionAX detail req', details: 'item ' + comps[i].itemId + ' inventorydetailreq=' + detReq });
            if (detReq) {
                if (!setInventoryDetail(adj, lineQty, comps[i].itemId)) {
                    setInventoryDetail(adj, Math.abs(lineQty), comps[i].itemId);
                }
            }

            adj.commitLine({ sublistId: 'inventory' });
            added++;
        }

        if (!added) { throw 'No component lines added for FG ' + fgItemId; }

        var adjId = adj.save({ enableSourcing: true, ignoreMandatoryFields: true });

        // enableSourcing on save re-derives the header adjlocation field from
        // the committed inventory lines' own location values, overwriting
        // whatever this function sets on the header — before OR after the
        // lines are built, it gets clobbered at save time either way. A
        // direct field patch after save, with sourcing off, is the only way
        // found to make the header value stick independent of the lines.
        if (headerLocationId) {
            try {
                record.submitFields({
                    type: record.Type.INVENTORY_ADJUSTMENT, id: adjId,
                    values: { adjlocation: headerLocationId },
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });
            } catch (eloc) {
                log.error({ title: 'RionAX header location patch failed',
                    details: 'adjustment ' + adjId + ' target=' + headerLocationId + ' :: ' +
                             (eloc.name || '') + ' ' + (eloc.message || eloc) });
            }
        }

        return adjId;
    }

    function decrementLot(lotRecId, byQty) {
        var lot = record.load({ type: LOT_REC, id: lotRecId });
        var remaining = Number(lot.getValue({ fieldId: LOT_REMAINING })) || 0;
        lot.setValue({ fieldId: LOT_REMAINING, value: remaining - byQty });
        lot.save();
        log.audit({ title: 'RionAX lot consumed', details: 'lot ' + lotRecId + ' -' + byQty + ' (remaining ' + (remaining - byQty) + ')' });
    }

    function setInventoryDetail(adj, qtyValue, itemId) {
        try {
            var det = adj.getCurrentSublistSubrecord({ sublistId: 'inventory', fieldId: 'inventorydetail' });
            det.selectNewLine({ sublistId: 'inventoryassignment' });
            det.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: qtyValue });
            try { det.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'inventorystatus', value: INV_STATUS_ID }); } catch (es) {}
            det.commitLine({ sublistId: 'inventoryassignment' });
            return true;
        } catch (edet) {
            log.audit({ title: 'RionAX inventory detail note', details: 'item ' + itemId + ' qty ' + qtyValue + ': ' + edet.message });
            return false;
        }
    }




    return { afterSubmit: afterSubmit };
});
/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 *
 * RionAX D2B — Lot record: source Item from the originating PO line
 * -------------------------------------------------------------------
 * POC. Deployed against customrecord_rax_lot's create form (attached via
 * that custom record type's "Client Script" field — see deployment notes).
 *
 * custcol_rax_lot on the Purchase Order item sublist is a List/Record column
 * pointing at customrecord_rax_lot. When a user clicks "New" on that column,
 * NetSuite opens this record's create form in a popup. This script reaches
 * back into the opener window (the PO page the popup was launched from),
 * reads the item on the PO line currently being edited, and pre-populates
 * custrecord_rax_lot_item with it.
 *
 * PLACEHOLDER — verify against the account before promoting past POC:
 *   - custrecord_rax_lot_item : List/Record field on customrecord_rax_lot,
 *     confirmed in rax_ue_lot_capture.js — re-verify it is still List/Record
 *     (Item) and not, e.g., free text.
 *   - Purchase Order sublist id 'item' / column id 'item' — standard ids;
 *     confirm no relabeling/replacement column in this account.
 *
 * Known limitations (flag before promoting past POC):
 *   - Relies on window.opener (same-origin). Fails silently to manual entry
 *     if the popup was opened in a new tab (e.g. middle-click) or a popup
 *     blocker intervened — there is no reliable client-side fallback for
 *     that case short of the server-side safety net below.
 *   - Only reliable while the PO line is still "in progress" in the line
 *     entry area (getCurrentSublistValue). If a lot record is instead
 *     created by re-opening an already-committed line for inline edit, the
 *     current-line APIs on the opener may not resolve the same way — verify
 *     against this account's actual sublist UI (inline-editable grid vs.
 *     classic line entry) during POC testing.
 *   - Client-side only: does not guarantee correctness if the lot record is
 *     created any other way (CSV import, Suitelet, mass update, SuiteScript
 *     API, copy). If that matters, pair this with a server-side
 *     reconciliation safety net (User Event afterSubmit on the PO, in the
 *     same spirit as rax_ue_lot_capture.js) that corrects
 *     custrecord_rax_lot_item after the fact — not included here since it
 *     wasn't asked for; flag if wanted as a follow-up.
 */
define(['N/log'], function (log) {

    var FLD_LOT_ITEM = 'custrecord_rax_lot_item';
    var PO_TYPE = 'purchaseorder';
    var PO_SUBLIST = 'item';
    var PO_ITEM_COLUMN = 'item';

    function pageInit(scriptContext) {
        try {
            if (scriptContext.mode !== 'create') { return; } // only source on new-record entry

            var thisRecord = scriptContext.currentRecord;

            // Don't clobber a manual entry (e.g. re-init after a validation error).
            if (thisRecord.getValue({ fieldId: FLD_LOT_ITEM })) { return; }

            if (!window.opener || window.opener.closed) {
                log.debug({
                    title: 'RionAX Lot sourcing',
                    details: 'No opener window available; leaving ' + FLD_LOT_ITEM + ' for manual entry.'
                });
                return;
            }

            sourceItemFromOpener(thisRecord);
        } catch (e) {
            log.error({ title: 'RionAX Lot sourcing - pageInit failed', details: e });
        }
    }

    function sourceItemFromOpener(thisRecord) {
        window.opener.require(['N/currentRecord'], function (openerCurrentRecord) {
            try {
                var openerRecord = openerCurrentRecord.get();
                if (!openerRecord || openerRecord.type !== PO_TYPE) { return; }

                var itemValue = openerRecord.getCurrentSublistValue({
                    sublistId: PO_SUBLIST,
                    fieldId: PO_ITEM_COLUMN
                });
                if (!itemValue) { return; }

                thisRecord.setValue({ fieldId: FLD_LOT_ITEM, value: itemValue });

                log.debug({
                    title: 'RionAX Lot sourcing',
                    details: 'Sourced ' + FLD_LOT_ITEM + ' = ' + itemValue + ' from opener PO line.'
                });
            } catch (innerErr) {
                log.error({ title: 'RionAX Lot sourcing - opener read failed', details: innerErr });
            }
        });
    }

    return { pageInit: pageInit };
});

/**
 * rax_ue_vb_approval.js  —  RAX v6.3-po
 *
 * User Event shared by Vendor Bill and Purchase Order - deployed twice, once
 * per record type (see customscript_rax_ue_vb_approval.xml). NetSuite tells
 * this script which type it is running against via context.newRecord.type /
 * context.newRecord.id; nothing here needs to be told which mode it is in.
 *
 *  beforeLoad   - approval tab HTML, Approve/Deny buttons, reset warning
 *  beforeSubmit - CREATE: build chain, stamp summary + native approvalstatus
 *                 EDIT/XEDIT: enforce the post-approval edit lock, rebuild the
 *                 chain when the routing fingerprint moved
 *  afterSubmit  - persist the chain as step records; catch native approvals
 *                 taken from the standard queue and reconcile them
 *
 * WHY approvalstatus IS SET IN beforeSubmit
 *   With Approval Routing enabled for Vendor Bills/Purchase Orders and no
 *   SuiteFlow workflow present, NetSuite saves new records as Approved.
 *   Nothing puts them into Pending. This script does that job, on the
 *   record, before the write - not via a submitFields round trip afterwards.
 *
 * WHY THE CHAIN IS STASHED ON THE RECORD
 *   A new record has no internal ID in beforeSubmit, so child step records
 *   cannot be created there. beforeSubmit writes the resolved chain to a
 *   hidden long-text field; afterSubmit reads it back and persists it. The
 *   field is set to '' on every save that does not rebuild, so afterSubmit
 *   never acts on a stale chain.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/runtime', 'N/error', 'N/record', 'N/ui/message', 'N/ui/serverWidget',
    './rax_lib_approval'],
(runtime, error, record, message, serverWidget, lib) => {

    // Contexts in which this script's own writes originate. The edit lock must
    // not fire on them, or the approval engine blocks itself.
    //
    // Built lazily: SuiteScript modules (including their enums) are unavailable
    // while the define callback runs, so reading runtime.ContextType at module
    // level fails when NetSuite evaluates the file to create the script record.
    let _selfContexts = null;
    const selfContexts = () => {
        if (!_selfContexts) {
            _selfContexts = [
                runtime.ContextType.SUITELET,
                runtime.ContextType.USER_EVENT,
                runtime.ContextType.WORKFLOW
            ];
        }
        return _selfContexts;
    };

    // Body fields an inline (XEDIT) change may touch on a fully approved bill.
    const XEDIT_ALLOW = ['memo', 'custbody_rax_appr_status', 'custbody_rax_appr_approver',
        'custbody_rax_appr_secondary', 'custbody_rax_appr_by', 'custbody_rax_appr_date',
        'custbody_rax_appr_step_current', 'custbody_rax_appr_step_count',
        'custbody_rax_appr_fingerprint', 'custbody_rax_appr_chain',
        'approvalstatus', 'nextapprover', 'tobeprinted'];

    /* ===================== beforeLoad ===================== */

    const beforeLoad = (context) => {
        // Nothing rendered here is worth blocking a record over. An exception
        // escaping beforeLoad shows the user a bare "unexpected error" page with
        // no indication of the cause, so everything below is contained.
        try {
            renderApproval(context);
        } catch (e) {
            log.error({ title: 'RAX beforeLoad failed',
                details: 'bill=' + (context.newRecord && context.newRecord.id) +
                         ' :: ' + e.message + '\n' + (e.stack || '') });
        }
    };

    const renderApproval = (context) => {
        if (runtime.executionContext !== runtime.ContextType.USER_INTERFACE) return;
        const rec = context.newRecord;
        const form = context.form;
        log.debug({ title: 'RAX beforeLoad', details: 'type=' + context.type + ' bill=' + rec.id });

        if (context.type === context.UserEventType.VIEW) {
            // NO custpage fields are injected here. Injecting an INLINEHTML
            // field into the vendor bill view form caused an unhandled 500
            // during NetSuite's form serialization - after beforeLoad returned,
            // where no try/catch can reach - on every bill in the account.
            // The chain is displayed instead through the native child-record
            // sublist (the step record is Record-is-Parent, so NetSuite lists
            // the steps on the bill automatically) and the My Approvals page.
            let steps = [];
            try { steps = lib.getSteps(rec.id); }
            catch (e) {
                log.error({ title: 'RAX beforeLoad getSteps', details: e.message });
                return;
            }

            const cur = lib.currentStep(steps);
            const uid0 = runtime.getCurrentUser().id;
            if (cur && (lib.isStepActor(cur, uid0) || lib.isUniversalApprover(uid0))) {
                try {
                    form.clientScriptModulePath = '/SuiteScripts/RionAX/rax_cs_vb_approval.js';
                    form.addButton({ id: 'custpage_rax_approve', label: 'Approve', functionName: 'raxApprove' });
                    form.addButton({ id: 'custpage_rax_deny',    label: 'Deny',    functionName: 'raxDeny' });
                } catch (e) {
                    log.error({ title: 'RAX buttons unavailable', details: e.message });
                }
            }
            log.debug({ title: 'RAX beforeLoad', details: 'view complete bill=' + rec.id });
            return;
        }

        if (context.type === context.UserEventType.EDIT) {
            let steps = [];
            try { steps = lib.getSteps(rec.id); } catch (e) { return; }
            const done = steps.filter((s) => s.status === lib.STEP_STATUS.APPROVED);
            if (!done.length) return;

            const allApproved = steps.every((s) =>
                s.status === lib.STEP_STATUS.APPROVED || s.status === lib.STEP_STATUS.SKIPPED);

            form.addPageInitMessage({
                type: allApproved ? message.Type.ERROR : message.Type.WARNING,
                title: allApproved ? 'This bill is fully approved' : 'Approvals will reset',
                message: allApproved
                    ? 'Changing the amount, header department, Secondary Approver or the currency requires Approver or ' +
                      'Administrator rights, and will clear all ' + done.length +
                      ' approval(s) and restart the chain.'
                    : done.length + ' of ' + steps.length + ' approval(s) have been recorded. ' +
                      'Changing the amount, header department, Secondary Approver or the currency will clear them and ' +
                      'restart the approval chain from step 1.'
            });
        }
    };

    /* ===================== beforeSubmit ===================== */

    const beforeSubmit = (context) => {
        const rec = context.newRecord;
        const t = context.type;
        const T = context.UserEventType;

        if (t === T.CREATE) {
            rec.setValue({ fieldId: lib.BILL.createdBy, value: runtime.getCurrentUser().id });
            applyChain(rec);
            return;
        }

        if (t !== T.EDIT && t !== T.XEDIT) return;
        if (selfContexts().indexOf(runtime.executionContext) !== -1) return;

        const statusText = lib.billStatusText(rec.getValue(lib.BILL.status));
        const fullyApproved = statusText === lib.STATUS.APPROVED;

        /* ---- XEDIT: sublists are unreadable, so decide on field names ---- */
        if (t === T.XEDIT) {
            if (!fullyApproved) return;
            const touched = (rec.getFields() || []).filter((f) => XEDIT_ALLOW.indexOf(f) === -1);
            if (!touched.length) return;
            if (!lib.canOverride(rec.id)) throw lockError(touched.join(', '));
            // Authorised inline edit on an approved bill: reset from scratch.
            applyChain(rec);
            return;
        }

        /* ---- EDIT ---- */
        const oldFp = String(rec.getValue(lib.BILL.fingerprint) || '');
        const newFp = lib.fingerprint(rec);
        const routingChanged = oldFp !== newFp;

        if (!routingChanged) {
            rec.setValue({ fieldId: lib.BILL.chain, value: '' });   // nothing for afterSubmit to do
            return;
        }

        if (fullyApproved && !lib.canOverride(rec.id)) throw lockError('the amount, header department or Secondary Approver');

        // Routing inputs moved: every prior approval is void.
        applyChain(rec);
    };

    const lockError = (what) => error.create({
        name: 'RAX_APPROVED_LOCK',
        message: 'This transaction has already been fully approved and cannot be edited (' + what +
                 '). Only an Approver on it or an Administrator may change it, and doing so ' +
                 'will reset all approvals and restart the approval chain.',
        notifyOff: true
    });

    /**
     * Resolve the chain and stamp every summary field on the record itself.
     * Never leaves a bill approved because resolution failed.
     */
    const applyChain = (rec) => {
        let chain;
        try {
            chain = lib.buildChain(rec);
        } catch (e) {
            log.error({ title: 'RAX buildChain failed', details: e.message + '\n' + (e.stack || '') });
            // Fail closed: hold the bill rather than release it.
            rec.setValue({ fieldId: 'approvalstatus', value: lib.NATIVE.PENDING });
            rec.setValue({ fieldId: lib.BILL.status, value: safeStatusId(lib.STATUS.NEEDS) });
            rec.setValue({ fieldId: lib.BILL.chain, value: '' });
            return;
        }

        const first = chain.steps[0] || null;
        const needs = !!first;

        rec.setValue({ fieldId: lib.BILL.status,
            value: lib.billStatusId(needs ? lib.STATUS.NEEDS : lib.STATUS.NONE) });
        rec.setValue({ fieldId: 'approvalstatus',
            value: needs ? lib.NATIVE.PENDING : lib.NATIVE.APPROVED });
        // Native Next Approver is validated by NetSuite at write time, and an
        // employee it will not accept fails the whole save with a platform error
        // that never reaches the execution log. Switchable off in settings.
        if (!lib.getSettings().skipNative) {
            rec.setValue({ fieldId: 'nextapprover', value: needs ? (first.primary || '') : '' });
        }
        rec.setValue({ fieldId: lib.BILL.approver,  value: needs ? (first.primary || '') : '' });
        rec.setValue({ fieldId: lib.BILL.secondary, value: needs ? (first.secondary || '') : '' });
        rec.setValue({ fieldId: lib.BILL.level,     value: needs ? (first.levelId || '') : '' });
        rec.setValue({ fieldId: lib.BILL.stepCurrent, value: needs ? 1 : 0 });
        rec.setValue({ fieldId: lib.BILL.stepCount,   value: chain.steps.length });
        rec.setValue({ fieldId: lib.BILL.apprBy,   value: '' });
        rec.setValue({ fieldId: lib.BILL.apprDate, value: null });   // '' is not a valid DATE clear
        rec.setValue({ fieldId: lib.BILL.fingerprint, value: chain.fingerprint });

        // The stash field is a TEXTAREA (4,000 chars). A chain that will not fit
        // is flagged for rebuild in afterSubmit rather than silently truncated.
        const packed = lib.packChain(chain);
        rec.setValue({ fieldId: lib.BILL.chain,
            value: packed.length > 3800 ? 'REBUILD' : packed });

        if (chain.unresolved) {
            log.audit({ title: 'RAX unresolved routing',
                details: chain.unresolved + ' step(s) had no matrix rule and went to the fallback approver.' });
        }
    };

    const safeStatusId = (text) => {
        try { return lib.billStatusId(text); } catch (e) { return ''; }
    };

    /* ===================== afterSubmit ===================== */

    const afterSubmit = (context) => {
        const T = context.UserEventType;
        if (context.type === T.DELETE) return;
        const rec = context.newRecord;

        /* ---- 1. Persist a freshly built chain ---- */
        let raw = '';
        try { raw = String(rec.getValue(lib.BILL.chain) || ''); } catch (e) { raw = ''; }

        if (raw) {
            try {
                const chain = raw === 'REBUILD'
                    ? lib.buildChain(record.load({ type: rec.type, id: rec.id }))
                    : lib.unpackChain(raw);
                lib.writeChain(rec.id, chain);
                // Clear the stash so a later unrelated save cannot replay it.
                record.submitFields({
                    type: rec.type, id: rec.id,
                    values: { [lib.BILL.chain]: '' },
                    options: { ignoreMandatoryFields: true }
                });
            } catch (e) {
                log.error({ title: 'RAX writeChain failed',
                    details: 'bill=' + rec.id + ' :: ' + e.message });
            }
            return;
        }

        /* ---- 2. Native approval taken from the standard queue ---- */
        try { nativeSync(context); }
        catch (e) {
            log.error({ title: 'RAX native sync failed',
                details: 'bill=' + rec.id + ' :: ' + e.message });
        }
    };

    const nativeSync = (context) => {
        const T = context.UserEventType;
        const rec = context.newRecord;
        if (selfContexts().indexOf(runtime.executionContext) !== -1) return;
        if (context.type !== T.EDIT && context.type !== T.XEDIT) return;

        const old = context.oldRecord;
        if (!old) return;

        const was = String(old.getValue('approvalstatus') || '');
        const now = String(rec.getValue('approvalstatus') || '');
        if (was === now) return;

        let steps;
        try { steps = lib.getSteps(rec.id); }
        catch (e) { log.error({ title: 'RAX native sync getSteps', details: e.message }); return; }

        const cur = lib.currentStep(steps);
        if (!cur) return;                       // chain already finished through the Suitelet

        const uid = String(runtime.getCurrentUser().id);
        const txn = lib.resolveTxn(rec.type);

        if (now === String(lib.NATIVE.APPROVED)) {
            const universal = lib.isUniversalApprover(uid);
            if (lib.isStepActor(cur, uid) || universal) {
                lib.recordDecision(cur.id, 'approve', uid,
                    (universal ? '[Universal approver] ' : '') + 'Approved from the standard approval queue');
                if (universal) {
                    const skipped = lib.stepStatusId(lib.STEP_STATUS.SKIPPED);
                    steps.forEach((s2) => {
                        if (s2.status === lib.STEP_STATUS.PENDING) {
                            record.submitFields({ type: lib.REC.STEP, id: s2.id,
                                values: { [lib.STEP.status]: skipped } });
                        }
                    });
                }
                lib.advance(rec.id, txn);       // rewrites approvalstatus back to Pending if more remain
                log.audit({ title: 'RAX native approval absorbed',
                    details: 'transaction=' + rec.id + ' step=' + cur.seq + ' user=' + uid });
            } else {
                revert(rec.id, cur, txn);
                log.audit({ title: 'RAX native approval reverted',
                    details: 'transaction=' + rec.id + ' user=' + uid + ' is not an approver for step ' + cur.seq });
            }
            return;
        }

        if (now === String(lib.NATIVE.REJECTED)) {
            if (lib.isStepActor(cur, uid) || lib.isUniversalApprover(uid)) {
                lib.recordDecision(cur.id, 'deny', uid, 'Rejected from the standard approval queue');
                const skipped = lib.stepStatusId(lib.STEP_STATUS.SKIPPED);
                steps.forEach((s) => {
                    if (s.status === lib.STEP_STATUS.PENDING) {
                        record.submitFields({ type: lib.REC.STEP, id: s.id,
                            values: { [lib.STEP.status]: skipped } });
                    }
                });
                record.submitFields({
                    type: rec.type, id: rec.id,
                    values: Object.assign(
                        lib.getSettings().skipNative ? {} : { nextapprover: '' },
                        {
                        [lib.BILL.status]: lib.billStatusId(lib.STATUS.DENIED),
                        [lib.BILL.apprBy]: uid,
                        [lib.BILL.apprDate]: new Date()
                    }),
                    options: { ignoreMandatoryFields: true }
                });
            } else {
                revert(rec.id, cur, txn);
            }
        }
    };

    const revert = (billId, cur, txn) => {
        record.submitFields({
            type: (txn && txn.recordType) || record.Type.VENDOR_BILL, id: billId,
            values: Object.assign(
                lib.getSettings().skipNative ? {} : { nextapprover: cur.primary || '' },
                {
                approvalstatus: lib.NATIVE.PENDING,
                [lib.BILL.status]: lib.billStatusId(lib.STATUS.NEEDS)
            }),
            options: { ignoreMandatoryFields: true }
        });
    };

    return { beforeLoad, beforeSubmit, afterSubmit };
});

/**
 * rax_lib_approval.js  —  RAX v6.3-po
 *
 * Shared approval engine for Rion Aesthetics. Drives both Vendor Bill and
 * Purchase Order approval - see the TXN config map below.
 *
 * MODEL
 *   Line departments are subtotalled per transaction. Each department
 *   subtotal is banded against the Approval Level records, and the matrix
 *   cell for (level, department) yields a primary + secondary approver.
 *   Those become ordered STEPS, stored as child records of the transaction.
 *   One step is Current at a time; either its primary or secondary may
 *   decide. When the last step approves, the transaction is approved.
 *
 *   A final "gate" step is appended when the TRANSACTION TOTAL bands higher
 *   than any department subtotal did, so line-splitting cannot dodge a
 *   threshold.
 *
 * FAIL-CLOSED
 *   A department with no matrix cell, or a cell with no approver, does NOT
 *   auto-approve. It produces an unresolved step routed to the fallback
 *   approver from the settings record. Silence is never consent.
 *
 * TRANSACTION TYPES
 *   One engine, two record types (Vendor Bill, Purchase Order), selected via
 *   NetSuite's own script-deployment mechanism rather than a config field -
 *   see rax_ue_vb_approval.js, which is deployed once per type. Approval
 *   Level records carry an optional "Applies To" tag (Vendor Bill / Purchase
 *   Order / Both) so the two types can diverge on thresholds and approvers
 *   later without any code or matrix schema change.
 *
 * @NApiVersion 2.1
 */
define(['N/search', 'N/record', 'N/runtime', 'N/query'],
(search, record, runtime, query) => {

    /* ================= Constants ================= */

    const REC = {
        SETTING: 'customrecord_rax_approval_setting',
        LEVEL:   'customrecord_rax_approval_level',
        RULE:    'customrecord_rax_approval_rule',
        STEP:    'customrecord_rax_appr_step'
    };

    const LIST = {
        REQUIREMENT: 'customlist_rax_approval_requirement',
        APPLIES_TO:  'customlist_rax_txn_applies_to'
    };

    const FLD = {
        // settings
        blockSelf:      'custrecord_rax_as_block_self',
        overrideRls:    'custrecord_rax_as_exempt_roles',
        fallback:       'custrecord_rax_as_fallback_approver',
        strictGaps:     'custrecord_rax_as_strict_gaps',
        skipNative:     'custrecord_rax_as_skip_native_approver',
        settingAppliesTo: 'custrecord_rax_as_applies_to',
        // level - bands only; shared across every transaction type
        threshold:   'custrecord_rax_al_threshold',
        sequence:    'custrecord_rax_al_sequence',
        unlimited:   'custrecord_rax_al_unlimited',
        gateAppr:    'custrecord_rax_al_gate_approver',
        gateSec:     'custrecord_rax_al_gate_secondary',
        universal:   'custrecord_rax_al_universal',
        // rule
        level:       'custrecord_rax_apr_level',
        dept:        'custrecord_rax_apr_dept',
        requirement: 'custrecord_rax_apr_requirement',
        approver:    'custrecord_rax_apr_approver',
        secondary:   'custrecord_rax_apr_secondary',
        useBillSec:  'custrecord_rax_apr_use_bill_sec',
        ruleAppliesTo: 'custrecord_rax_apr_applies_to'
    };

    // Values of the shared customlist_rax_txn_applies_to list.
    const APPLIES_TO = { VENDOR_BILL: 'Vendor Bill', PURCHASE_ORDER: 'Purchase Order', BOTH: 'Both' };

    /**
     * One engine, two transaction types. NetSuite tells the running script
     * which type it is via context.newRecord.type (UE) or the record it
     * loads (Suitelets), so this map is looked up - never a config field.
     */
    const TXN = {
        VENDOR_BILL: {
            key: 'VENDOR_BILL',
            recordType: record.Type.VENDOR_BILL,
            searchType: search.Type.VENDOR_BILL,
            txnCode: 'VendBill',
            appliesToText: APPLIES_TO.VENDOR_BILL,
            label: 'Vendor Bill'
        },
        PURCHASE_ORDER: {
            key: 'PURCHASE_ORDER',
            recordType: record.Type.PURCHASE_ORDER,
            searchType: search.Type.PURCHASE_ORDER,
            txnCode: 'PurchOrd',
            appliesToText: APPLIES_TO.PURCHASE_ORDER,
            label: 'Purchase Order'
        }
    };

    const resolveTxn = (recordType) => {
        const rt = String(recordType || '');
        if (rt === TXN.VENDOR_BILL.recordType) return TXN.VENDOR_BILL;
        if (rt === TXN.PURCHASE_ORDER.recordType) return TXN.PURCHASE_ORDER;
        return null;
    };

    const resolveTxnByCode = (code) => {
        const c = String(code || '');
        if (c === TXN.VENDOR_BILL.txnCode) return TXN.VENDOR_BILL;
        if (c === TXN.PURCHASE_ORDER.txnCode) return TXN.PURCHASE_ORDER;
        return null;
    };

    const resolveTxnByKey = (key) => {
        const k = String(key || '');
        if (k === TXN.VENDOR_BILL.key) return TXN.VENDOR_BILL;
        if (k === TXN.PURCHASE_ORDER.key) return TXN.PURCHASE_ORDER;
        return null;
    };

    /**
     * Resolve the transaction type of an id whose record type the caller
     * does not already know (e.g. a bare billid query param). Falls back to
     * Vendor Bill on any failure, preserving this project's pre-PO behaviour
     * rather than leaving a step unresolvable.
     */
    const resolveTxnForId = (txnId) => {
        try {
            const lk = search.lookupFields({
                type: search.Type.TRANSACTION, id: txnId, columns: ['type']
            });
            const code = (lk.type && lk.type[0]) ? String(lk.type[0].value) : '';
            return resolveTxnByCode(code) || TXN.VENDOR_BILL;
        } catch (e) {
            log.error({ title: 'RAX resolveTxnForId failed', details: txnId + ' :: ' + e.message });
            return TXN.VENDOR_BILL;
        }
    };

    const STEP = {
        bill:      'custrecord_rax_st_bill',
        seq:       'custrecord_rax_st_seq',
        dept:      'custrecord_rax_st_dept',
        label:     'custrecord_rax_st_label',
        amount:    'custrecord_rax_st_amount',
        level:     'custrecord_rax_st_level',
        levelSeq:  'custrecord_rax_st_level_seq',
        primary:   'custrecord_rax_st_primary',
        secondary: 'custrecord_rax_st_secondary',
        status:    'custrecord_rax_st_status',
        decidedBy: 'custrecord_rax_st_decided_by',
        decidedOn: 'custrecord_rax_st_decided_on',
        comment:   'custrecord_rax_st_comment',
        isGate:    'custrecord_rax_st_is_gate',
        unresolved:'custrecord_rax_st_unresolved'
    };

    const BILL = {
        status:      'custbody_rax_appr_status',
        approver:    'custbody_rax_appr_approver',
        secondary:   'custbody_rax_appr_secondary',
        level:       'custbody_rax_appr_level',
        apprBy:      'custbody_rax_appr_by',
        apprDate:    'custbody_rax_appr_date',
        createdBy:   'custbody_rax_created_by',
        fingerprint: 'custbody_rax_appr_fingerprint',
        chain:       'custbody_rax_appr_chain',
        stepCurrent: 'custbody_rax_appr_step_current',
        stepCount:   'custbody_rax_appr_step_count',
        billSecondary: 'custbody_rax_bill_secondary'
    };

    // Canonical text of each list value. IDs are resolved at runtime.
    const STATUS = {
        NEEDS:    'Needs Approval',
        APPROVED: 'Approved',
        DENIED:   'Denied',
        NONE:     'No Approval Needed'
    };

    const STEP_STATUS = {
        PENDING:  'Pending',
        CURRENT:  'Current',
        APPROVED: 'Approved',
        DENIED:   'Denied',
        SKIPPED:  'Skipped'
    };

    const NATIVE = { PENDING: 1, APPROVED: 2, REJECTED: 3 };

    /* ================= List value resolution =================
     * Custom list internal IDs are assigned at deploy time and differ per
     * account, so nothing in this project compares display text. Resolve once
     * per execution and memoise.
     */

    const _lists = {};

    /**
     * Custom list values, for the administration Suitelet only. The routing
     * engine never calls this - it reads display text straight off the rule
     * search result, so a list that cannot be enumerated can never break a save.
     *
     * Two strategies, because searchability of custom lists is not dependable:
     * a select field on a dynamic record exposes its options directly, and a
     * plain search is the fallback.
     */
    const loadList = (list, hostRecordType, hostFieldId) => {
        if (_lists[list]) return _lists[list];
        const map = { byText: {}, byId: {} };
        const put = (id, txt) => {
            if (!id || id === ' ' || !txt) return;
            map.byText[String(txt).toLowerCase()] = String(id);
            map.byId[String(id)] = String(txt);
        };

        if (hostRecordType && hostFieldId) {
            try {
                const opts = record.create({ type: hostRecordType, isDynamic: true })
                    .getField({ fieldId: hostFieldId }).getSelectOptions();
                (opts || []).forEach((o) => put(o.value, o.text));
            } catch (e) {
                log.error({ title: 'RAX loadList via field failed', details: list + ' :: ' + e.message });
            }
        }

        if (!Object.keys(map.byId).length) {
            try {
                search.create({ type: list, columns: ['name'] }).run().each((r) => {
                    put(r.id, r.getValue('name')); return true;
                });
            } catch (e) {
                log.error({ title: 'RAX loadList via search failed', details: list + ' :: ' + e.message });
            }
        }

        _lists[list] = map;
        return map;
    };

    const listId = (list, text, hostRecordType, hostFieldId) => {
        const m = loadList(list, hostRecordType || REC.RULE, hostFieldId || FLD.requirement);
        const v = m.byText[String(text).toLowerCase()];
        if (!v) log.error({ title: 'RAX missing list value', details: list + ' :: ' + text });
        return v || '';
    };

    const listText = (list, id, hostRecordType, hostFieldId) =>
        (id ? (loadList(list, hostRecordType || REC.RULE, hostFieldId || FLD.requirement).byId[String(id)] || '') : '');

    // The bill status body field is plain TEXT and is only ever written by this
    // project, so it needs no list-ID resolution. These stay as functions so
    // callers do not have to care which storage a field uses.
    const billStatusId   = (t) => String(t || '');
    const billStatusText = (v) => String(v || '');
    const stepStatusId   = (t) => String(t || '');
    const stepStatusText = (v) => String(v || '');

    /* ================= Settings ================= */

    let _settings = null;
    let _settingAppliesToMissing = false;

    const getSettings = () => {
        if (_settings) return _settings;
        let out = { id: null, blockSelf: false, overrideRoles: [],
                    fallbackApprover: '', strictGaps: false, skipNative: false,
                    appliesTo: APPLIES_TO.BOTH };
        let count = 0;

        const run = (withAppliesTo) => {
            count = 0;
            const cols = [FLD.blockSelf, FLD.overrideRls, FLD.fallback, FLD.strictGaps, FLD.skipNative];
            if (withAppliesTo) cols.push(FLD.settingAppliesTo);
            search.create({
                type: REC.SETTING,
                filters: [['isinactive', 'is', 'F']],
                columns: cols
            }).run().each((r) => {
                count++;
                if (count > 1) return false;
                const raw = r.getValue(FLD.overrideRls);
                out = {
                    id: String(r.id),
                    blockSelf: r.getValue(FLD.blockSelf) === true || r.getValue(FLD.blockSelf) === 'T',
                    overrideRoles: Array.isArray(raw)
                        ? raw.map(String)
                        : String(raw || '').split(',').map((s) => s.trim()).filter(Boolean),
                    fallbackApprover: String(r.getValue(FLD.fallback) || ''),
                    strictGaps: r.getValue(FLD.strictGaps) === true || r.getValue(FLD.strictGaps) === 'T',
                    skipNative: r.getValue(FLD.skipNative) === true || r.getValue(FLD.skipNative) === 'T',
                    appliesTo: withAppliesTo
                        ? (String(r.getText(FLD.settingAppliesTo) || '') || APPLIES_TO.BOTH)
                        : APPLIES_TO.BOTH
                };
                return true;
            });
        };

        if (_settingAppliesToMissing) {
            run(false);
        } else {
            try {
                run(true);
            } catch (e) {
                if (String(e.name) === 'SSS_INVALID_SRCH_COL' &&
                    String(e.message).indexOf(FLD.settingAppliesTo) !== -1) {
                    _settingAppliesToMissing = true;
                    log.error({ title: 'RAX setting applies-to field not deployed',
                        details: FLD.settingAppliesTo + ' is not on the Setting record yet; ' +
                                 'treated as Both.' });
                    run(false);
                } else {
                    throw e;
                }
            }
        }
        if (count > 1) {
            log.error({ title: 'RAX multiple setting records',
                details: 'Only one active RAX Approval Setting record is supported. Using id ' + out.id });
        }
        if (!count) log.error({ title: 'RAX no setting record', details: 'Defaults applied.' });
        _settings = out;
        return out;
    };

    /* ================= Levels ================= */

    /**
     * The universal flag is OPTIONAL schema: if custrecord_rax_al_universal has
     * not been deployed to the account yet, levels load without it and the
     * universal feature is simply off. A missing feature field must never be
     * able to break level loading - bill saves depend on this function.
     */
    let _universalFieldMissing = false;

    /**
     * Every active band, shared across every transaction type - Levels carry
     * no type dimension at all; that lives on the Rule (matrix cell) instead.
     */
    const getLevels = () => {
        const out = [];
        const run = (withUniversal) => {
            out.length = 0;
            const cols = ['name', FLD.threshold, FLD.unlimited, FLD.gateAppr, FLD.gateSec];
            if (withUniversal) cols.push(FLD.universal);
            cols.push(search.createColumn({ name: FLD.sequence, sort: search.Sort.ASC }));
            search.create({
                type: REC.LEVEL,
                filters: [['isinactive', 'is', 'F']],
                columns: cols
            }).run().each((r) => {
                const seq = parseInt(r.getValue(FLD.sequence), 10);
                const th = parseFloat(r.getValue(FLD.threshold));
                const unl = r.getValue(FLD.unlimited) === true || r.getValue(FLD.unlimited) === 'T';
                let uni = false;
                if (withUniversal) {
                    uni = r.getValue(FLD.universal) === true || r.getValue(FLD.universal) === 'T';
                }
                out.push({
                    id: String(r.id),
                    name: String(r.getValue('name') || ''),
                    sequence: isNaN(seq) ? 9999 : seq,
                    unlimited: unl,
                    threshold: unl ? Infinity : (isNaN(th) ? 0 : th),
                    gateApprover: String(r.getValue(FLD.gateAppr) || ''),
                    gateSecondary: String(r.getValue(FLD.gateSec) || ''),
                    universal: uni
                });
                return true;
            });
        };

        const attempt = (withUniversal) => {
            try {
                run(withUniversal);
            } catch (e) {
                if (String(e.name) !== 'SSS_INVALID_SRCH_COL') throw e;
                if (withUniversal && String(e.message).indexOf(FLD.universal) !== -1) {
                    _universalFieldMissing = true;
                    log.error({ title: 'RAX universal field not deployed',
                        details: FLD.universal + ' is not on the Approval Level record yet. ' +
                                 'Levels loaded without it; the universal approver feature is ' +
                                 'inactive until the object deploy runs.' });
                    return attempt(false);
                }
                throw e;
            }
        };

        attempt(!_universalFieldMissing);

        out.sort((a, b) => a.sequence - b.sequence);
        return out;
    };

    const bandFor = (levels, amount) => {
        const amt = Math.abs(parseFloat(amount) || 0);
        return levels.find((l) => l.unlimited || amt <= l.threshold) || levels[levels.length - 1];
    };

    /* ================= Rules ================= */

    /**
     * One search for every department involved, filtered to the given
     * transaction type - a Rule row only counts if it is tagged for exactly
     * this type (Rules are never tagged Both; see rax_ue_matrix_validate.js).
     * @returns {Object} deptId -> { levelId -> cell }
     */
    // The use-bill-secondary flag is OPTIONAL schema (same discipline as the
    // universal flag): a file upload ahead of the object deploy must degrade,
    // never detonate.
    let _useBillSecMissing = false;

    const getRulesForDepts = (deptIds, txn) => {
        const out = {};
        if (!deptIds || !deptIds.length) return out;
        deptIds.forEach((d) => { out[String(d)] = {}; });

        const run = (withFlag) => {
            deptIds.forEach((d) => { out[String(d)] = {}; });
            const cols = [FLD.dept, FLD.level, FLD.requirement, FLD.approver, FLD.secondary, FLD.ruleAppliesTo];
            if (withFlag) cols.push(FLD.useBillSec);
            search.create({
                type: REC.RULE,
                filters: [
                    ['isinactive', 'is', 'F'], 'AND',
                    [FLD.dept, 'anyof', deptIds]
                ],
                columns: cols
            }).run().each((r) => {
                if (String(r.getText(FLD.ruleAppliesTo) || '') !== txn.appliesToText) return true;
                const d = String(r.getValue(FLD.dept));
                const l = String(r.getValue(FLD.level));
                if (!out[d]) out[d] = {};
                if (out[d][l]) {
                    log.error({ title: 'RAX duplicate matrix cell',
                        details: 'dept=' + d + ' level=' + l + ' type=' + txn.appliesToText +
                                 ' - routing is ambiguous.' });
                }
                out[d][l] = {
                    id: String(r.id),
                    requirement: String(r.getValue(FLD.requirement) || ''),
                    notRequired: /^\s*no approval/i.test(String(r.getText(FLD.requirement) || '')),
                    approver: String(r.getValue(FLD.approver) || ''),
                    secondary: String(r.getValue(FLD.secondary) || ''),
                    useBillSec: withFlag &&
                        (r.getValue(FLD.useBillSec) === true || r.getValue(FLD.useBillSec) === 'T')
                };
                return true;
            });
        };

        if (_useBillSecMissing) {
            run(false);
        } else {
            try { run(true); }
            catch (e) {
                if (String(e.name) === 'SSS_INVALID_SRCH_COL' &&
                    String(e.message).indexOf(FLD.useBillSec) !== -1) {
                    _useBillSecMissing = true;
                    log.error({ title: 'RAX use-bill-secondary field not deployed',
                        details: FLD.useBillSec + ' is not on the rule record yet; matrix loaded without it.' });
                    run(false);
                } else { throw e; }
            }
        }
        return out;
    };

    const getParentDept = (deptId) => {
        try {
            const rs = query.runSuiteQL({
                query: 'SELECT parent FROM department WHERE id = ?',
                params: [parseInt(deptId, 10)]
            }).asMappedResults();
            return (rs.length && rs[0].parent) ? String(rs[0].parent) : null;
        } catch (e) {
            log.error({ title: 'RAX getParentDept failed', details: deptId + ' :: ' + e.message });
            return null;
        }
    };

    const deptNames = (ids) => {
        const map = {};
        if (!ids.length) return map;
        search.create({
            type: 'department',
            filters: [['internalid', 'anyof', ids]],
            columns: ['name']
        }).run().each((r) => { map[String(r.id)] = String(r.getValue('name')); return true; });
        return map;
    };

    /* ================= Amount extraction ================= */

    const SUBLISTS = ['item', 'expense'];

    /**
     * v6.2: the HEADER department determines the approval path. Line amounts
     * are still summed here (`total` and `usertotal` are not calculated in
     * beforeSubmit for scripted, CSV or integration-created records), but the
     * whole sum accrues to the single header-department bucket. Line-level
     * departments have no routing effect.
     */
    const subtotalsByDept = (rec) => {
        const byDept = {};
        let total = 0;

        SUBLISTS.forEach((sub) => {
            const n = rec.getLineCount({ sublistId: sub });
            for (let i = 0; i < (n > 0 ? n : 0); i++) {
                total += Math.abs(parseFloat(
                    rec.getSublistValue({ sublistId: sub, fieldId: 'amount', line: i })) || 0);
            }
        });

        const hdr = rec.getValue('department');
        const key = hdr ? String(hdr) : '__BLANK__';
        if (total) byDept[key] = total;

        const firstLine = {};
        firstLine[key] = 0;
        return { byDept: byDept, total: total, firstLine: firstLine };
    };

    /**
     * v6.2: derived from the header department, the summed line total, and the
     * currency. Rearranging lines or recoding line departments no longer
     * resets approvals, because those inputs no longer influence routing.
     */
    const fingerprint = (rec) => {
        let total = 0;
        SUBLISTS.forEach((sub) => {
            const n = rec.getLineCount({ sublistId: sub });
            for (let i = 0; i < (n > 0 ? n : 0); i++) {
                total += Math.abs(parseFloat(
                    rec.getSublistValue({ sublistId: sub, fieldId: 'amount', line: i })) || 0);
            }
        });
        return 'd' + String(rec.getValue('department') || '0')
            + ':' + total.toFixed(2)
            + '#c' + String(rec.getValue('currency') || '')
            + '#x' + String(rec.getValue('exchangerate') || '')
            + '#s' + String(rec.getValue(BILL.billSecondary) || '');
    };

    /* ================= Chain construction ================= */

    /**
     * @returns {Object} { steps, total, unresolved, fingerprint }
     *   steps: [{ seq, depts[], label, amount, levelId, levelSeq, primary,
     *             secondary, isGate, unresolved }]
     */
    const buildChain = (rec) => {
        const txn = resolveTxn(rec.type) || TXN.VENDOR_BILL;
        const settings = getSettings();
        const createdBy = String(rec.getValue(BILL.createdBy) || runtime.getCurrentUser().id || '');
        const levels = getLevels();
        const { byDept, total, firstLine } = subtotalsByDept(rec);

        if (!levels.length) {
            log.error({ title: 'RAX no approval levels',
                details: 'No active RAX Approval Level records for ' + txn.label + ' - routing to fallback.' });
            return {
                steps: settings.fallbackApprover
                    ? [fallbackStep(settings, total, 'Unconfigured')] : [],
                total: total, unresolved: 1, fingerprint: fingerprint(rec)
            };
        }

        const realDepts = Object.keys(byDept).filter((k) => k !== '__BLANK__');
        const parentOf = {};
        const lookupIds = realDepts.slice();
        realDepts.forEach((d) => {
            const p = getParentDept(d);
            if (p) { parentOf[d] = p; if (lookupIds.indexOf(p) === -1) lookupIds.push(p); }
        });
        const rules = getRulesForDepts(lookupIds, txn);
        const names = deptNames(realDepts);

        let steps = [];

        // Blank department -> impossible under a mandatory-department config,
        // but never silently ignored.
        if (byDept.__BLANK__) {
            log.error({ title: 'RAX bill with no header department',
                details: 'amount=' + byDept.__BLANK__ + ' - the header department is mandatory.' });
            if (settings.fallbackApprover) {
                steps.push(fallbackStep(settings, byDept.__BLANK__, 'No Department'));
            }
        }

        // v6.3: universal-flagged levels (C-Suite) are NOT departmental bands.
        // Departmental routing bands against the remaining levels; amounts above
        // their range clamp to the highest departmental band (inheritance then
        // finds the configured cell). The universal level is appended as an
        // ADDITIONAL final step below when the bill total reaches it.
        const deptLevels = levels.filter((l) => !l.universal);
        const bandLevels = deptLevels.length ? deptLevels : levels;
        const billSec = String(rec.getValue(BILL.billSecondary) || '');
        let headerCells = {};

        realDepts.forEach((deptId) => {
            const amt = byDept[deptId];
            const band = bandFor(bandLevels, amt);

            // Cells for this department, falling back to its parent department.
            let cells = rules[deptId] || {};
            if (!Object.keys(cells).length && parentOf[deptId]) {
                cells = rules[parentOf[deptId]] || {};
            }
            headerCells = cells;

            const base = {
                depts: [deptId],
                label: names[deptId] || ('Department ' + deptId),
                amount: amt,
                levelId: band.id,
                levelSeq: band.sequence,
                levelName: band.name,
                firstLine: firstLine[deptId] === undefined ? 999 : firstLine[deptId],
                isGate: false,
                unresolved: false,
                inherited: false
            };

            // UNGOVERNED: the department appears nowhere in the matrix. By design
            // this needs no approval - the matrix is opt-in, not a whitelist.
            if (!Object.keys(cells).length) {
                log.audit({ title: 'RAX department not in matrix',
                    details: 'dept=' + deptId + ' amount=' + amt + ' - no approval required.' });
                if (settings.strictGaps) {
                    steps.push(Object.assign({}, base, { unresolved: true,
                        primary: settings.fallbackApprover, secondary: '' }));
                }
                return;
            }

            let cell = cells[band.id];
            let usedLevel = band;

            // BAND INHERITANCE: an unconfigured band inherits the nearest
            // configured band BELOW it that names an approver. Configure a cell
            // only where routing actually changes. Inheriting downward (never
            // upward) means a bigger bill can never get a weaker approver than
            // a smaller one in the same department.
            if (!cell) {
                const lower = bandLevels
                    .filter((l) => l.sequence < band.sequence && cells[l.id] &&
                                   !cells[l.id].notRequired &&
                                   (cells[l.id].approver || cells[l.id].useBillSec))
                    .sort((a, b) => b.sequence - a.sequence);
                if (lower.length) {
                    usedLevel = lower[0];
                    cell = cells[usedLevel.id];
                    base.inherited = true;
                    base.levelId = usedLevel.id;
                    base.levelSeq = usedLevel.sequence;
                    base.levelName = usedLevel.name + ' (inherited)';
                }
            }

            // Governed department, but nothing at or below this band requires
            // approval. The bill-total gate is the backstop for large amounts.
            if (!cell) {
                log.audit({ title: 'RAX no cell at or below band',
                    details: 'dept=' + deptId + ' band=' + band.name + ' amount=' + amt +
                             ' - no approval required.' });
                if (settings.strictGaps) {
                    steps.push(Object.assign({}, base, { unresolved: true,
                        primary: settings.fallbackApprover, secondary: '' }));
                }
                return;
            }

            if (cell.notRequired) return;              // explicitly cleared at this band

            if (!cell.approver && !cell.useBillSec) {
                log.error({ title: 'RAX cell marked Required with no approver',
                    details: 'dept=' + deptId + ' level=' + usedLevel.id +
                             ' - routed to the fallback approver.' });
                steps.push(Object.assign({}, base, { unresolved: true,
                    primary: settings.fallbackApprover, secondary: '' }));
                return;
            }

            let primary = cell.approver;
            let secondary = cell.secondary;

            // v6.3: cells flagged Use Bill Secondary Approver route to the
            // employee chosen in the bill's Secondary Approver field. With a
            // named primary the selection joins as co-approver; with no named
            // primary the selection IS the approver.
            if (cell.useBillSec) {
                if (primary) {
                    if (billSec && billSec !== String(primary)) secondary = billSec;
                } else if (billSec) {
                    primary = billSec;
                } else {
                    log.error({ title: 'RAX bill secondary approver missing',
                        details: 'dept=' + deptId + ' level=' + usedLevel.id +
                                 ' requires the Secondary Approver field on the bill, and it is ' +
                                 'empty. Routed to the fallback approver.' });
                    steps.push(Object.assign({}, base, { unresolved: true,
                        primary: settings.fallbackApprover, secondary: '' }));
                    return;
                }
            }

            // The preparer must not be able to act as the SECONDARY either.
            // Either approver can decide a step, so leaving the preparer in the
            // secondary slot is a self-approval route around the primary check.
            if (settings.blockSelf && secondary && String(secondary) === createdBy) {
                secondary = '';
            }

            // Self-approval: prefer the secondary, then escalate a band, then fallback.
            if (settings.blockSelf && String(primary) === createdBy) {
                if (secondary && String(secondary) !== createdBy) {
                    primary = secondary;
                    secondary = '';
                } else {
                    const esc = escalate(levels, cells, usedLevel.sequence, createdBy);
                    if (esc) {
                        primary = esc.approver; secondary = esc.secondary;
                        base.levelId = esc.levelId; base.levelSeq = esc.levelSeq;
                        base.levelName = esc.levelName;
                    } else {
                        primary = settings.fallbackApprover; secondary = '';
                        base.unresolved = true;
                    }
                }
            }

            if (!primary) {
                log.error({ title: 'RAX unresolved step with no approver',
                    details: 'dept=' + deptId + ' - self-approval blocked and no fallback approver ' +
                             'is configured. Fail closed instead of silently dropping the step.' });
                steps.push(Object.assign({}, base, { unresolved: true, primary: '', secondary: '' }));
                return;
            }

            steps.push(Object.assign({}, base, { primary: String(primary), secondary: String(secondary || '') }));
        });

        steps = dedupe(steps, names);

        // Deterministic order: biggest exposure first, line order as tiebreak.
        steps.sort((a, b) => (b.amount - a.amount) || (a.firstLine - b.firstLine));

        // v6.3: automatic C-Suite step. When the bill total reaches a
        // universal-flagged level, that level's approval is required IN
        // ADDITION to the departmental approval - the client's example:
        // Department Executive -> C-Suite -> Approved. Approvers come from the
        // (universal level, department) matrix cell, then the level's gate
        // fields, then the fallback approver.
        const totalBand = bandFor(levels, total);
        if (totalBand && totalBand.universal) {
            const uniCell = headerCells[totalBand.id];
            if (uniCell && uniCell.notRequired) {
                log.audit({ title: 'RAX universal band explicitly cleared',
                    details: 'The matrix marks this department No Approval Needed at ' +
                             totalBand.name + '; no C-Suite step appended.' });
            } else {
                let p = uniCell ? String(uniCell.approver || '') : '';
                let sec = uniCell ? String(uniCell.secondary || '') : '';
                if (uniCell && uniCell.useBillSec) {
                    if (p) { if (billSec && billSec !== p) sec = billSec; }
                    else if (billSec) { p = billSec; }
                }
                let unresolvedUni = false;
                if (!p) { p = String(totalBand.gateApprover || ''); sec = String(totalBand.gateSecondary || ''); }
                if (!p) { p = String(settings.fallbackApprover || ''); sec = ''; unresolvedUni = true; }

                // Self-approval on the universal step: prefer the cell secondary.
                if (settings.blockSelf && sec && String(sec) === createdBy) sec = '';
                if (settings.blockSelf && p && String(p) === createdBy) {
                    if (sec) { p = sec; sec = ''; }
                    else { p = String(settings.fallbackApprover || ''); unresolvedUni = true; }
                }

                if (p) {
                    const already = steps.some((st) =>
                        String(st.primary) === p && (st.levelSeq || 0) >= totalBand.sequence);
                    if (!already) {
                        steps.push({
                            depts: [], label: totalBand.name + ' (Bill Total)', amount: total,
                            levelId: totalBand.id, levelSeq: totalBand.sequence, levelName: totalBand.name,
                            primary: p, secondary: sec && sec !== p ? sec : '',
                            firstLine: 9999, isGate: true, unresolved: unresolvedUni
                        });
                    }
                } else {
                    log.error({ title: 'RAX universal step has no approver',
                        details: 'Bill total ' + total + ' bands into ' + totalBand.name +
                                 ' but no matrix cell, gate approver or fallback resolves an approver.' });
                }
            }
        }

        steps.forEach((s, i) => { s.seq = i + 1; });

        return {
            steps: steps,
            total: total,
            unresolved: steps.filter((s) => s.unresolved).length,
            fingerprint: fingerprint(rec)
        };
    };

    /**
     * Compact chain payload. The stash field is a transaction body TEXTAREA,
     * capped at 4,000 characters - LONGTEXT is not a permitted body field type.
     * Only the keys writeChain needs are serialised.
     */
    const packChain = (chain) => JSON.stringify({
        f: chain.fingerprint,
        u: chain.unresolved,
        s: chain.steps.map((s) => [s.seq, s.depts, s.label, s.amount, s.levelId,
            s.levelSeq, s.primary, s.secondary, s.isGate ? 1 : 0, s.unresolved ? 1 : 0])
    });

    const unpackChain = (raw) => {
        const o = JSON.parse(raw);
        return {
            fingerprint: o.f, unresolved: o.u,
            steps: (o.s || []).map((a) => ({
                seq: a[0], depts: a[1], label: a[2], amount: a[3], levelId: a[4],
                levelSeq: a[5], primary: a[6], secondary: a[7],
                isGate: !!a[8], unresolved: !!a[9]
            }))
        };
    };

    const fallbackStep = (settings, amount, label) => ({
        depts: [], label: label, amount: amount,
        levelId: '', levelSeq: 0, levelName: '',
        primary: settings.fallbackApprover, secondary: '',
        firstLine: -1, isGate: false, unresolved: true
    });

    const escalate = (levels, cells, fromSeq, blockedUser) => {
        const higher = levels.filter((l) => l.sequence > fromSeq).sort((a, b) => a.sequence - b.sequence);
        for (let i = 0; i < higher.length; i++) {
            const c = cells[higher[i].id];
            if (c && !c.notRequired && c.approver && String(c.approver) !== String(blockedUser)) {
                return {
                    approver: c.approver, secondary: c.secondary,
                    levelId: higher[i].id, levelSeq: higher[i].sequence, levelName: higher[i].name
                };
            }
        }
        return null;
    };

    /** Collapse steps that route to the same primary approver. */
    const dedupe = (steps, names) => {
        const byApprover = {};
        const order = [];
        steps.forEach((s) => {
            const k = String(s.primary || 'UNRESOLVED') + '|' + (s.isGate ? 'G' : 'D');
            if (!byApprover[k]) { byApprover[k] = Object.assign({}, s); order.push(k); return; }
            const t = byApprover[k];
            t.amount += s.amount;
            t.depts = t.depts.concat(s.depts);
            t.firstLine = Math.min(t.firstLine, s.firstLine);
            t.unresolved = t.unresolved || s.unresolved;
            if ((s.levelSeq || 0) > (t.levelSeq || 0)) {   // keep the highest band's pair
                t.levelId = s.levelId; t.levelSeq = s.levelSeq; t.levelName = s.levelName;
                t.secondary = s.secondary;
            }
        });
        return order.map((k) => {
            const s = byApprover[k];
            if (s.depts.length > 1) {
                s.label = s.depts.map((d) => names[d] || d).join(', ');
            }
            return s;
        });
    };

    /* ================= Step persistence ================= */

    const getSteps = (billId) => {
        const out = [];
        if (!billId) return out;
        search.create({
            type: REC.STEP,
            filters: [[STEP.bill, 'anyof', billId]],
            columns: [STEP.seq, STEP.dept, STEP.label, STEP.amount, STEP.level, STEP.levelSeq,
                STEP.primary, STEP.secondary, STEP.status, STEP.decidedBy, STEP.decidedOn,
                STEP.comment, STEP.isGate, STEP.unresolved,
                search.createColumn({ name: STEP.seq, sort: search.Sort.ASC })]
        }).run().each((r) => {
            out.push({
                id: String(r.id),
                seq: parseInt(r.getValue(STEP.seq), 10) || 0,
                label: String(r.getValue(STEP.label) || ''),
                amount: parseFloat(r.getValue(STEP.amount)) || 0,
                levelName: String(r.getText(STEP.level) || ''),
                levelSeq: parseInt(r.getValue(STEP.levelSeq), 10) || 0,
                primary: String(r.getValue(STEP.primary) || ''),
                primaryName: String(r.getText(STEP.primary) || ''),
                secondary: String(r.getValue(STEP.secondary) || ''),
                secondaryName: String(r.getText(STEP.secondary) || ''),
                statusId: String(r.getValue(STEP.status) || ''),
                status: stepStatusText(r.getValue(STEP.status)),
                decidedBy: String(r.getValue(STEP.decidedBy) || ''),
                decidedByName: String(r.getText(STEP.decidedBy) || ''),
                decidedOn: String(r.getValue(STEP.decidedOn) || ''),
                comment: String(r.getValue(STEP.comment) || ''),
                isGate: r.getValue(STEP.isGate) === true || r.getValue(STEP.isGate) === 'T',
                unresolved: r.getValue(STEP.unresolved) === true || r.getValue(STEP.unresolved) === 'T'
            });
            return true;
        });
        out.sort((a, b) => a.seq - b.seq);
        return out;
    };

    const deleteSteps = (billId) => {
        getSteps(billId).forEach((s) => {
            try { record.delete({ type: REC.STEP, id: s.id }); }
            catch (e) { log.error({ title: 'RAX step delete failed', details: s.id + ' :: ' + e.message }); }
        });
    };

    /**
     * Replace the whole chain. Only ever called when the routing fingerprint
     * changed, which by design resets every prior approval.
     */
    const writeChain = (billId, chain) => {
        deleteSteps(billId);
        const pendingId = stepStatusId(STEP_STATUS.PENDING);
        const currentId = stepStatusId(STEP_STATUS.CURRENT);

        chain.steps.forEach((s, i) => {
            const r = record.create({ type: REC.STEP, isDynamic: false });
            r.setValue({ fieldId: STEP.bill, value: billId });
            r.setValue({ fieldId: STEP.seq, value: s.seq || (i + 1) });
            if (s.depts && s.depts.length) r.setValue({ fieldId: STEP.dept, value: s.depts });
            r.setValue({ fieldId: STEP.label, value: s.label });
            r.setValue({ fieldId: STEP.amount, value: s.amount });
            if (s.levelId) r.setValue({ fieldId: STEP.level, value: s.levelId });
            r.setValue({ fieldId: STEP.levelSeq, value: s.levelSeq || 0 });
            if (s.primary) r.setValue({ fieldId: STEP.primary, value: s.primary });
            if (s.secondary) r.setValue({ fieldId: STEP.secondary, value: s.secondary });
            r.setValue({ fieldId: STEP.status, value: i === 0 ? currentId : pendingId });
            r.setValue({ fieldId: STEP.isGate, value: !!s.isGate });
            r.setValue({ fieldId: STEP.unresolved, value: !!s.unresolved });
            r.save({ ignoreMandatoryFields: true });
        });
    };

    /* ================= Decisions ================= */

    const isStepActor = (step, userId) => {
        const u = String(userId);
        return !!step && (u === String(step.primary) || (!!step.secondary && u === String(step.secondary)));
    };

    const canOverride = (billId) => {
        const s = getSettings();
        const user = runtime.getCurrentUser();
        if (s.overrideRoles.indexOf(String(user.role)) !== -1) return true;
        if (String(user.role) === '3') return true;                 // Administrator
        return getSteps(billId).some((st) => String(st.decidedBy) === String(user.id));
    };

    /**
     * v6.2: universal approvers. Anyone named (primary or secondary) on any
     * active matrix rule whose Approval Level is flagged Universal Approver
     * Level may decide ANY bill regardless of amount, department or step
     * assignment. Identified by the flag, never by the level's name.
     * Self-approval policy still applies. Memoised per execution.
     */
    const _universalCache = {};
    const isUniversalApprover = (userId) => {
        const uid = String(userId || '');
        if (!uid) return false;
        if (_universalCache[uid] !== undefined) return _universalCache[uid];
        let found = false;
        try {
            search.create({
                type: REC.RULE,
                filters: [
                    ['isinactive', 'is', 'F'], 'AND',
                    [FLD.level + '.' + FLD.universal, 'is', 'T'], 'AND',
                    [[FLD.approver, 'anyof', uid], 'OR', [FLD.secondary, 'anyof', uid]]
                ],
                columns: ['internalid']
            }).run().each(() => { found = true; return false; });
        } catch (e) {
            log.error({ title: 'RAX isUniversalApprover', details: e.message });
        }
        _universalCache[uid] = found;
        return found;
    };

    const currentStep = (steps) => steps.find((s) => s.status === STEP_STATUS.CURRENT) || null;

    /**
     * Move the chain forward. Called after a step is approved.
     * @param {string} billId
     * @param {Object} [txn] - a TXN entry; resolved from billId if omitted.
     */
    const advance = (billId, txn) => {
        const t = txn || resolveTxnForId(billId);
        const steps = getSteps(billId);
        const next = steps.find((s) => s.status === STEP_STATUS.PENDING);

        if (!next) {
            record.submitFields({
                type: t.recordType, id: billId,
                values: Object.assign(
                    getSettings().skipNative ? {} : { nextapprover: '' },
                    {
                    approvalstatus: NATIVE.APPROVED,
                    [BILL.status]: billStatusId(STATUS.APPROVED),
                    [BILL.approver]: '',
                    [BILL.secondary]: '',
                    [BILL.apprDate]: new Date(),
                    [BILL.stepCurrent]: steps.length
                }),
                options: { ignoreMandatoryFields: true }
            });
            log.audit({ title: 'RAX transaction fully approved', details: t.key + '=' + billId });
            return;
        }

        record.submitFields({
            type: REC.STEP, id: next.id,
            values: { [STEP.status]: stepStatusId(STEP_STATUS.CURRENT) }
        });
        record.submitFields({
            type: t.recordType, id: billId,
            values: Object.assign(
                getSettings().skipNative ? {} : { nextapprover: next.primary || '' },
                {
                approvalstatus: NATIVE.PENDING,
                [BILL.status]: billStatusId(STATUS.NEEDS),
                [BILL.approver]: next.primary || '',
                [BILL.secondary]: next.secondary || '',
                [BILL.stepCurrent]: next.seq
            }),
            options: { ignoreMandatoryFields: true }
        });
    };

    const recordDecision = (stepId, action, userId, comment) => {
        record.submitFields({
            type: REC.STEP, id: stepId,
            values: {
                [STEP.status]: stepStatusId(action === 'approve' ? STEP_STATUS.APPROVED : STEP_STATUS.DENIED),
                [STEP.decidedBy]: userId,
                [STEP.decidedOn]: new Date(),
                [STEP.comment]: comment || ''
            }
        });
    };

    /**
     * @param {string} billId
     * @param {Array} steps
     * @param {string} userId
     * @param {string} comment
     * @param {Object} [txn] - a TXN entry; resolved from billId if omitted.
     */
    const denyChain = (billId, steps, userId, comment, txn) => {
        const t = txn || resolveTxnForId(billId);
        const skipped = stepStatusId(STEP_STATUS.SKIPPED);
        steps.forEach((s) => {
            if (s.status === STEP_STATUS.PENDING) {
                record.submitFields({ type: REC.STEP, id: s.id, values: { [STEP.status]: skipped } });
            }
        });
        record.submitFields({
            type: t.recordType, id: billId,
            values: Object.assign(
                getSettings().skipNative ? {} : { nextapprover: '' },
                {
                approvalstatus: NATIVE.REJECTED,
                [BILL.status]: billStatusId(STATUS.DENIED),
                [BILL.apprBy]: userId,
                [BILL.apprDate]: new Date()
            }),
            options: { ignoreMandatoryFields: true }
        });
    };

    /**
     * Apply an approve/deny against the CURRENT step, re-reading state first.
     * The button URL is a snapshot of the page at render time; the chain may
     * have moved since (secondary acted, admin rebuilt, bill denied elsewhere).
     * @param {string} billId
     * @param {string} action - 'approve' | 'deny'
     * @param {string} comment
     * @param {Object} [txn] - a TXN entry (lib.TXN.VENDOR_BILL / PURCHASE_ORDER).
     *   Callers that already know the type (the record buttons, or a URL that
     *   carries a type param) should pass it; when omitted it is resolved
     *   with one extra lookup against the generic transaction search type.
     */
    const applyStepDecision = (billId, action, comment, txn) => {
        const t = txn || resolveTxnForId(billId);
        const userId = String(runtime.getCurrentUser().id);
        const steps = getSteps(billId);
        const cur = currentStep(steps);

        if (!cur) return { ok: false, reason: 'This transaction is no longer awaiting approval.' };
        const universal = isUniversalApprover(userId);
        if (!isStepActor(cur, userId) && !universal) {
            return { ok: false, reason: 'You are not an approver for the current step.' };
        }

        // Re-check self-approval here as well as at chain build: a chain built
        // before the policy changed would otherwise still allow it.
        const s = getSettings();
        if (s.blockSelf && s.overrideRoles.indexOf(String(runtime.getCurrentUser().role)) === -1) {
            const lk = search.lookupFields({
                type: t.searchType, id: billId, columns: [BILL.createdBy]
            });
            const preparer = (lk[BILL.createdBy] && lk[BILL.createdBy][0])
                ? String(lk[BILL.createdBy][0].value) : '';
            if (preparer && preparer === userId) {
                return { ok: false,
                    reason: 'You prepared this transaction, so you cannot approve it. Ask the other ' +
                            'approver on this step, or an approver with override rights.' };
            }
        }

        recordDecision(cur.id, action, userId,
            (universal ? '[Universal approver] ' : '') + (comment || ''));

        if (action === 'approve') {
            record.submitFields({
                type: t.recordType, id: billId,
                values: { [BILL.apprBy]: userId },
                options: { ignoreMandatoryFields: true }
            });
            // A universal decision settles the whole transaction: remaining steps skip.
            if (universal) {
                const skipped = stepStatusId(STEP_STATUS.SKIPPED);
                steps.forEach((st) => {
                    if (st.status === STEP_STATUS.PENDING) {
                        record.submitFields({ type: REC.STEP, id: st.id,
                            values: { [STEP.status]: skipped } });
                    }
                });
            }
            advance(billId, t);
            return { ok: true, reason: universal
                ? 'Transaction approved.'
                : 'Step ' + cur.seq + ' approved.' };
        }

        denyChain(billId, steps, userId, comment, t);
        return { ok: true, reason: 'Transaction denied.' };
    };

    /* ================= Presentation ================= */

    const money = (n) => '$' + (parseFloat(n) || 0).toLocaleString('en-US',
        { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const STYLE = {
        [STEP_STATUS.APPROVED]: { bg: '#eaf6ec', bd: '#2e7d32', icon: '&#10003;', fg: '#2e7d32' },
        [STEP_STATUS.CURRENT]:  { bg: '#fff8e1', bd: '#f9a825', icon: '&#9654;', fg: '#b26a00' },
        [STEP_STATUS.PENDING]:  { bg: '#fafafa', bd: '#cfcfcf', icon: '&#9675;', fg: '#777' },
        [STEP_STATUS.DENIED]:   { bg: '#fdecea', bd: '#c62828', icon: '&#10007;', fg: '#c62828' },
        [STEP_STATUS.SKIPPED]:  { bg: '#f5f5f5', bd: '#cfcfcf', icon: '&#8212;', fg: '#999' }
    };

    const renderChainHtml = (stepsOrBillId) => {
        const steps = Array.isArray(stepsOrBillId) ? stepsOrBillId : getSteps(stepsOrBillId);
        if (!steps.length) {
            return '<div style="padding:12px;font:13px Arial;color:#666">' +
                   'No approval steps. This bill did not require approval, or it predates the ' +
                   'approval matrix rollout.</div>';
        }

        const rows = steps.map((s) => {
            const st = STYLE[s.status] || STYLE[STEP_STATUS.PENDING];
            const who = s.status === STEP_STATUS.APPROVED || s.status === STEP_STATUS.DENIED
                ? esc(s.decidedByName) + '<br><span style="color:#888;font-size:11px">' +
                  esc(String(s.decidedOn).split(' ')[0] || '') + '</span>'
                : '<span style="color:#999">&mdash;</span>';
            const approvers = esc(s.primaryName) +
                (s.secondaryName ? '<br><span style="color:#888;font-size:11px">or ' +
                    esc(s.secondaryName) + '</span>' : '');
            const flag = s.unresolved
                ? ' <span title="No matrix rule matched - routed to fallback" ' +
                  'style="color:#c62828;font-weight:bold">&#9888;</span>' : '';
            const gate = s.isGate
                ? ' <span style="background:#e8eaf6;color:#3949ab;font-size:10px;' +
                  'padding:1px 5px;border-radius:8px">TOTAL GATE</span>' : '';

            return '<tr style="background:' + st.bg + '">' +
                '<td style="border-left:4px solid ' + st.bd + ';padding:8px 10px;width:34px;' +
                    'font-size:16px;color:' + st.fg + '">' + st.icon + '</td>' +
                '<td style="padding:8px 10px;width:34px;color:#888">' + s.seq + '</td>' +
                '<td style="padding:8px 10px"><b>' + esc(s.label) + '</b>' + gate + flag +
                    '<br><span style="color:#888;font-size:11px">' + esc(s.levelName) + '</span></td>' +
                '<td style="padding:8px 10px;text-align:right;white-space:nowrap">' + money(s.amount) + '</td>' +
                '<td style="padding:8px 10px">' + approvers + '</td>' +
                '<td style="padding:8px 10px;color:' + st.fg + ';font-weight:bold;white-space:nowrap">' +
                    esc(s.status) + '</td>' +
                '<td style="padding:8px 10px">' + who + '</td>' +
                '<td style="padding:8px 10px;color:#666;font-size:11px">' + esc(s.comment) + '</td>' +
                '</tr>';
        }).join('');

        const done = steps.filter((s) => s.status === STEP_STATUS.APPROVED).length;
        const active = steps.filter((s) => s.status !== STEP_STATUS.SKIPPED).length;

        return '<div style="font:13px Arial,sans-serif;padding:4px 0 12px">' +
            '<div style="margin:0 0 8px;color:#555">Approval progress: <b>' + done + ' of ' +
                active + '</b> step(s) complete.</div>' +
            '<table style="border-collapse:collapse;width:100%;border:1px solid #ddd">' +
            '<thead><tr style="background:#eee;color:#444;text-align:left">' +
            '<th style="padding:6px 10px"></th><th style="padding:6px 10px">#</th>' +
            '<th style="padding:6px 10px">Department</th>' +
            '<th style="padding:6px 10px;text-align:right">Amount</th>' +
            '<th style="padding:6px 10px">Approver(s)</th>' +
            '<th style="padding:6px 10px">Status</th>' +
            '<th style="padding:6px 10px">Decided By</th>' +
            '<th style="padding:6px 10px">Comment</th></tr></thead>' +
            '<tbody>' + rows + '</tbody></table></div>';
    };

    /**
     * Vendor Bill payment guard support. Deliberately still Vendor-Bill-only
     * (rax_ue_vp_guard.js has no Purchase Order analog - see the design doc),
     * so txn defaults to VENDOR_BILL rather than resolving generically.
     */
    const billApprovalState = (billId, txn) => {
        const t = txn || TXN.VENDOR_BILL;
        const lk = search.lookupFields({
            type: t.searchType, id: billId,
            columns: [BILL.status, 'tranid']
        });
        const raw = lk[BILL.status];
        const id = Array.isArray(raw) ? (raw[0] ? raw[0].value : '') : String(raw || '');
        return { status: billStatusText(id), tranid: String(lk.tranid || billId) };
    };

    return {
        REC, FLD, BILL, STEP, LIST, STATUS, STEP_STATUS, NATIVE,
        APPLIES_TO, TXN, resolveTxn, resolveTxnByCode, resolveTxnByKey, resolveTxnForId,
        listId, listText, billStatusId, billStatusText, stepStatusId, stepStatusText,
        getSettings, getLevels, bandFor, getRulesForDepts, getParentDept, deptNames,
        subtotalsByDept, fingerprint, buildChain,
        getSteps, deleteSteps, writeChain, packChain, unpackChain, currentStep, isStepActor, canOverride,
        isUniversalApprover,
        advance, recordDecision, applyStepDecision,
        renderChainHtml, billApprovalState, money, esc
    };
});

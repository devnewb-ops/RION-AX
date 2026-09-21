/**
 * rax_ue_matrix_validate.js  —  RAX v6.0
 *
 * User Event deployed on the Approval Rule and Approval Level records.
 * Enforces the invariants the routing engine depends on:
 *
 *   Rule   - (Level, Department, Transaction Type) must be unique. Two rows
 *            for the same cell make routing depend on search result order.
 *          - Transaction Type is required and may not be "Both" - a cell
 *            always belongs to exactly one type; the band it points at
 *            (Level) is what's shared across types.
 *          - Approval Required implies an approver.
 *          - No Approval Needed implies no approver.
 *          - Primary and secondary must differ.
 *   Level  - Sequence is unique.
 *          - Exactly one level may be Unlimited, and it must be the last.
 *          - Non-unlimited levels need a threshold above zero.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/search', 'N/error', './rax_lib_approval'], (search, error, lib) => {

    const beforeSubmit = (context) => {
        const T = context.UserEventType;
        if (context.type !== T.CREATE && context.type !== T.EDIT && context.type !== T.XEDIT) return;

        const rec = context.newRecord;
        const type = rec.type;

        if (type === lib.REC.RULE)  return validateRule(rec);
        if (type === lib.REC.LEVEL) return validateLevel(rec);
    };

    const fail = (name, msg) => { throw error.create({ name: name, message: msg, notifyOff: true }); };

    const validateRule = (rec) => {
        const level = String(rec.getValue(lib.FLD.level) || '');
        const dept  = String(rec.getValue(lib.FLD.dept) || '');
        const req   = String(rec.getValue(lib.FLD.requirement) || '');
        const appr  = String(rec.getValue(lib.FLD.approver) || '');
        const sec   = String(rec.getValue(lib.FLD.secondary) || '');
        const appliesTo = String(rec.getValue(lib.FLD.ruleAppliesTo) || '');

        if (!level || !dept) fail('RAX_RULE_INCOMPLETE', 'Approval Level and Department are both required.');
        if (!appliesTo) fail('RAX_RULE_NO_TYPE',
            'Transaction Type is required - pick Vendor Bill or Purchase Order. The band (Approval ' +
            'Level) is shared, but each transaction type is configured independently.');
        const bothId = lib.listId(lib.LIST.APPLIES_TO, 'Both', lib.REC.RULE, lib.FLD.ruleAppliesTo);
        if (appliesTo === bothId) fail('RAX_RULE_TYPE_BOTH_NOT_ALLOWED',
            'A matrix rule must be tagged Vendor Bill or Purchase Order specifically - "Both" is not ' +
            'permitted on an individual cell. Create one row per type when the approver is the same ' +
            'for each.');
        if (!req) fail('RAX_RULE_NO_REQUIREMENT',
            'Approval Requirement is required on a saved rule. To mean "no rule here", delete the ' +
            'row instead - an absent cell inherits the nearest configured band below it.');

        const notRequired = req === lib.listId(lib.LIST.REQUIREMENT, 'No Approval Needed');

        const useBillSec = rec.getValue(lib.FLD.useBillSec) === true ||
                           rec.getValue(lib.FLD.useBillSec) === 'T';
        const sec2 = String(rec.getValue(lib.FLD.secondary) || '');
        if (useBillSec && sec2) fail('RAX_RULE_SEC_CONFLICT',
            'Use Bill Secondary Approver and a named Secondary Approver cannot be combined - ' +
            'the bill selection takes the secondary slot.');
        if (!notRequired && !appr && !useBillSec) fail('RAX_RULE_NO_APPROVER',
            'This cell is set to Approval Required but has no Approver. Set an approver, or ' +
            'change the requirement to No Approval Needed.');
        if (notRequired && appr) fail('RAX_RULE_CONFLICT',
            'This cell is set to No Approval Needed but names an Approver. Clear one of them.');
        if (appr && sec && appr === sec) fail('RAX_RULE_SAME_APPROVER',
            'The primary and secondary approver cannot be the same person.');

        const filters = [
            ['isinactive', 'is', 'F'], 'AND',
            [lib.FLD.level, 'anyof', level], 'AND',
            [lib.FLD.dept, 'anyof', dept], 'AND',
            [lib.FLD.ruleAppliesTo, 'anyof', appliesTo]
        ];
        if (rec.id) filters.push('AND', ['internalid', 'noneof', rec.id]);

        let dupe = null;
        search.create({ type: lib.REC.RULE, filters: filters, columns: ['internalid'] })
            .run().each((r) => { dupe = r.id; return false; });

        if (dupe) fail('RAX_RULE_DUPLICATE',
            'A rule already exists for this Approval Level, Department, and Transaction Type ' +
            '(record ' + dupe + '). Edit that record instead - duplicate cells make routing ambiguous.');
    };

    const validateLevel = (rec) => {
        const seq = parseInt(rec.getValue(lib.FLD.sequence), 10);
        const th  = parseFloat(rec.getValue(lib.FLD.threshold));
        const unl = rec.getValue(lib.FLD.unlimited) === true || rec.getValue(lib.FLD.unlimited) === 'T';

        if (isNaN(seq)) fail('RAX_LEVEL_NO_SEQUENCE',
            'Sequence is required. Levels are banded in sequence order; a blank sequence makes ' +
            'band selection non-deterministic.');
        if (!unl && (isNaN(th) || th <= 0)) fail('RAX_LEVEL_NO_THRESHOLD',
            'Enter an Approval Threshold greater than zero, or tick Unlimited for the top band.');
        if (unl && !isNaN(th) && th > 0) fail('RAX_LEVEL_CONFLICT',
            'An Unlimited level cannot also carry a threshold.');

        const seqFilters = [
            ['isinactive', 'is', 'F'], 'AND', [lib.FLD.sequence, 'equalto', seq]
        ];
        if (rec.id) seqFilters.push('AND', ['internalid', 'noneof', rec.id]);
        let dupe = null;
        search.create({ type: lib.REC.LEVEL, filters: seqFilters, columns: ['internalid'] })
            .run().each((r) => { dupe = r.id; return false; });
        if (dupe) fail('RAX_LEVEL_DUP_SEQ',
            'Sequence ' + seq + ' is already used by level ' + dupe + '. Sequences must be unique.');

        if (unl) {
            const unlFilters = [['isinactive', 'is', 'F'], 'AND', [lib.FLD.unlimited, 'is', 'T']];
            if (rec.id) unlFilters.push('AND', ['internalid', 'noneof', rec.id]);
            let other = null;
            search.create({ type: lib.REC.LEVEL, filters: unlFilters, columns: ['internalid'] })
                .run().each((r) => { other = r.id; return false; });
            if (other) fail('RAX_LEVEL_DUP_UNLIMITED',
                'Level ' + other + ' is already the Unlimited band. Only one is permitted.');
        }
    };

    return { beforeSubmit };
});

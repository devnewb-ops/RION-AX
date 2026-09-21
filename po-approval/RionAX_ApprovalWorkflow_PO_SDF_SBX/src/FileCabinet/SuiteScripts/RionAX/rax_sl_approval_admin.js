/**
 * rax_sl_approval_admin.js  —  RAX v6.3-po
 *
 * Approval matrix administration - one screen for both Vendor Bill and
 * Purchase Order, per the "keep it in the same place" design goal.
 *
 *  - Bands (Approval Levels) are shared, unfiltered, across every
 *    transaction type - the same columns always show regardless of the
 *    toggle. The Transaction Type toggle instead filters which Rule cells
 *    (approver assignments) are shown/edited: each cell carries its own
 *    type tag, so Vendor Bill and Purchase Order can route the same
 *    department/band to different approvers.
 *  - Coverage grid: every active department against every band for the
 *    selected type, with gaps highlighted. A gap is not cosmetic - under
 *    this design it routes to the fallback approver, so the grid is the
 *    pre-go-live checklist.
 *  - Cell editing: set requirement, primary and secondary per cell and save
 *    the whole grid in one POST. Every cell saved from this screen is
 *    tagged with whichever type is currently toggled - configuring Vendor
 *    Bill never touches the Purchase Order rows for the same cell, and
 *    vice versa.
 *  - Settings: self-approval policy, override roles, fallback approver -
 *    shared across both types for this phase (§4.2 of the design doc).
 *
 * Levels are maintained on their own record (Lists > Custom > RAX Approval
 * Level), which the validation user event guards.
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/search', 'N/record', 'N/runtime', 'N/ui/serverWidget', 'N/ui/message', 'N/url',
    './rax_lib_approval'],
(search, record, runtime, serverWidget, message, url, lib) => {

    const TYPES = [lib.TXN.VENDOR_BILL, lib.TXN.PURCHASE_ORDER];

    const onRequest = (context) => {
        if (context.request.method === 'POST') return handlePost(context);
        const p = context.request.parameters;
        const txn = lib.resolveTxnByKey(p.custpage_txn_type) || lib.TXN.VENDOR_BILL;
        context.response.writePage(buildForm(p.custparam_msg, txn));
    };

    /* ============ Data ============ */

    const activeDepartments = () => {
        const out = [];
        search.create({
            type: 'department',
            filters: [['isinactive', 'is', 'F']],
            columns: [search.createColumn({ name: 'name', sort: search.Sort.ASC })]
        }).run().each((r) => {
            out.push({ id: String(r.id), name: String(r.getValue('name')) });
            return true;
        });
        return out;
    };

    const activeEmployees = () => {
        const out = [];
        search.create({
            type: 'employee',
            filters: [['isinactive', 'is', 'F'], 'AND', ['giveaccess', 'is', 'T']],
            columns: [search.createColumn({ name: 'entityid', sort: search.Sort.ASC })]
        }).run().each((r) => {
            out.push({ id: String(r.id), name: String(r.getValue('entityid')) });
            return true;
        });
        return out;
    };

    // Flattens the library's deptId -> levelId -> cell map into the
    // dept|level flat key the grid/summary HTML below already expects -
    // reuses the exact same resolver the live routing engine calls, so the
    // admin display and buildChain() can never again disagree about which
    // rule applies to a given cell.
    const rulesFor = (txn, depts, levels) => {
        const nested = lib.getRulesForDepts(depts.map((d) => d.id), txn);
        const out = {};
        depts.forEach((d) => levels.forEach((l) => {
            const c = nested[d.id] && nested[d.id][l.id];
            if (c) out[d.id + '|' + l.id] = c;
        }));
        return out;
    };

    /* ============ Form ============ */

    const buildForm = (msg, txn) => {
        const form = serverWidget.createForm({ title: 'RAX Approval Matrix Administration' });
        form.clientScriptModulePath = './rax_cs_approval_admin.js';

        if (msg) {
            form.addPageInitMessage({
                type: /error|fail/i.test(msg) ? message.Type.ERROR : message.Type.CONFIRMATION,
                title: 'Approval Matrix', message: msg
            });
        }

        const typeField = form.addField({
            id: 'custpage_txn_type', type: serverWidget.FieldType.SELECT, label: 'Transaction Type'
        });
        TYPES.forEach((t) => typeField.addSelectOption({ value: t.key, text: t.label }));
        typeField.defaultValue = txn.key;
        typeField.setHelpText({
            help: 'The bands (Approval Levels) below are shared by every transaction type - the same ' +
                  'columns show either way. This toggle instead filters which matrix cells you are ' +
                  'viewing and editing: Vendor Bill and Purchase Order approvers are configured ' +
                  'independently, even for the same department and band.'
        });

        const levels = lib.getLevels();
        const depts = activeDepartments();
        const rules = rulesFor(txn, depts, levels);
        const employees = activeEmployees();
        const settings = lib.getSettings();

        form.addTab({ id: 'custpage_tab_matrix', label: 'Matrix' });
        form.addTab({ id: 'custpage_tab_settings', label: 'Settings' });

        /* --- coverage summary --- */
        let gaps = 0;
        depts.forEach((d) => levels.forEach((l) => { if (!rules[d.id + '|' + l.id]) gaps++; }));

        form.addField({
            id: 'custpage_summary', type: serverWidget.FieldType.INLINEHTML, label: ' ',
            container: 'custpage_tab_matrix'
        }).defaultValue = summaryHtml(depts.length, levels.length, gaps, levels, settings.strictGaps);

        if (!levels.length) {
            form.addField({
                id: 'custpage_nolevels', type: serverWidget.FieldType.INLINEHTML, label: ' ',
                container: 'custpage_tab_matrix'
            }).defaultValue = '<div style="padding:14px;background:#fdecea;border:1px solid #c62828;' +
                'font:13px Arial">No active Approval Levels exist. Create Levels under ' +
                '<b>Lists &gt; Custom &gt; RAX Approval Level</b> before configuring the matrix - ' +
                'bands are shared across every transaction type.</div>';
            context_settings(form, settings, employees);
            return form;
        }

        /* --- grid --- */
        form.addField({
            id: 'custpage_grid', type: serverWidget.FieldType.INLINEHTML, label: ' ',
            container: 'custpage_tab_matrix'
        }).defaultValue = gridHtml(depts, levels, rules, employees, txn);

        form.addField({
            id: 'custpage_payload', type: serverWidget.FieldType.LONGTEXT, label: 'Payload',
            container: 'custpage_tab_matrix'
        }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });

        context_settings(form, settings, employees);

        form.addSubmitButton({ label: 'Save Matrix & Settings' });
        return form;
    };

    const context_settings = (form, settings, employees) => {
        const blockSelf = form.addField({
            id: 'custpage_block_self', type: serverWidget.FieldType.CHECKBOX,
            label: 'Prevent Self-Approval', container: 'custpage_tab_settings'
        });
        blockSelf.defaultValue = settings.blockSelf ? 'T' : 'F';
        blockSelf.setHelpText({
            help: 'When a bill preparer is also the matrix approver for their own department, the ' +
                  'secondary approver takes the step. If there is no secondary, the step escalates ' +
                  'to the next band that names someone else, and failing that goes to the fallback ' +
                  'approver.'
        });

        const fallback = form.addField({
            id: 'custpage_fallback', type: serverWidget.FieldType.SELECT,
            label: 'Fallback Approver', container: 'custpage_tab_settings'
        });
        fallback.addSelectOption({ value: '', text: '' });
        employees.forEach((e) => fallback.addSelectOption({ value: e.id, text: e.name }));
        fallback.defaultValue = settings.fallbackApprover;
        fallback.isMandatory = false;
        fallback.setHelpText({
            help: 'Receives steps that cannot be resolved at all - a line with no department, or ' +
                  'any unconfigured cell when Strict Gap Handling is on. Required if you turn ' +
                  'Strict Gap Handling on.'
        });

        const strict = form.addField({
            id: 'custpage_strict_gaps', type: serverWidget.FieldType.CHECKBOX,
            label: 'Strict Gap Handling', container: 'custpage_tab_settings'
        });
        strict.defaultValue = settings.strictGaps ? 'T' : 'F';
        strict.setHelpText({
            help: 'Off (default): departments absent from the matrix need no approval, and an ' +
                  'empty band inherits the nearest configured band below it. On: any unresolved ' +
                  'cell routes to the Fallback Approver. Turn this on only once the matrix is ' +
                  'complete, and set a Fallback Approver first.'
        });

        const skipNative = form.addField({
            id: 'custpage_skip_native', type: serverWidget.FieldType.CHECKBOX,
            label: 'Do Not Populate Native Next Approver', container: 'custpage_tab_settings'
        });
        skipNative.defaultValue = settings.skipNative ? 'T' : 'F';
        skipNative.setHelpText({
            help: 'Leave unticked to keep bills visible in the standard Bills to Approve queue. ' +
                  'Tick it if a save fails with an approver-reference error - the chain, the ' +
                  'Approval tab and the payment guard do not depend on this field.'
        });

        const roles = form.addField({
            id: 'custpage_override_roles', type: serverWidget.FieldType.MULTISELECT,
            label: 'Approval Override Roles', container: 'custpage_tab_settings',
            source: 'role'
        });
        roles.defaultValue = settings.overrideRoles;
        roles.setHelpText({
            help: 'These roles bypass the self-approval block and may edit a fully approved bill. ' +
                  'Editing an approved bill still resets every approval on it.'
        });
    };

    /* ============ HTML ============ */

    const summaryHtml = (nDepts, nLevels, gaps, levels, strict) => {
        const cells = nDepts * nLevels;
        const pct = cells ? Math.round(((cells - gaps) / cells) * 100) : 0;
        const bar = strict ? (gaps === 0 ? '#2e7d32' : '#c62828') : '#1565c0';
        const bands = levels.map((l) =>
            '<span style="display:inline-block;background:#eef;border:1px solid #ccd;border-radius:3px;' +
            'padding:2px 8px;margin:2px 4px 2px 0;font-size:11px">' +
            lib.esc(l.name) + ' &middot; ' +
            (l.unlimited ? 'unlimited' : 'to ' + lib.money(l.threshold)) +
            (l.gateApprover ? ' &middot; gated' : '') + '</span>').join('');

        return '<div style="font:13px Arial;padding:6px 0 14px">' +
            '<div style="margin-bottom:6px">' + bands + '</div>' +
            '<div style="background:#eee;height:10px;border-radius:5px;overflow:hidden;max-width:420px">' +
            '<div style="background:' + bar + ';height:10px;width:' + pct + '%"></div></div>' +
            '<div style="margin-top:6px;color:' + (strict && gaps ? '#c62828' : '#555') + '">' +
            (strict
                ? (gaps
                    ? '<b>Strict Gap Handling is ON and ' + gaps + ' of ' + cells + ' cells are ' +
                      'empty.</b> Every empty cell routes to the fallback approver.'
                    : '<b>All ' + cells + ' cells configured.</b>')
                : '<b>' + (cells - gaps) + ' of ' + cells + ' cells configured.</b> Empty cells are ' +
                  'fine: a department with no rules at all needs no approval, and an empty band ' +
                  'inherits the nearest configured band below it. Configure a cell only where ' +
                  'routing changes.') +
            '</div></div>';
    };

    const gridHtml = (depts, levels, rules, employees, txn) => {
        const reqRequired = lib.listId(lib.LIST.REQUIREMENT, 'Approval Required');
        const reqNone = lib.listId(lib.LIST.REQUIREMENT, 'No Approval Needed');

        const opts = (selected) => '<option value=""></option>' + employees.map((e) =>
            '<option value="' + e.id + '"' + (String(selected) === e.id ? ' selected' : '') + '>' +
            lib.esc(e.name) + '</option>').join('');

        const head = '<tr style="background:#444;color:#fff">' +
            '<th style="padding:8px 10px;text-align:left;position:sticky;left:0;background:#444">' +
            'Department</th>' +
            levels.map((l) => '<th style="padding:8px 10px;text-align:left;min-width:230px">' +
                lib.esc(l.name) + '<br><span style="font-weight:normal;font-size:11px;opacity:.8">' +
                (l.unlimited ? 'unlimited' : 'up to ' + lib.money(l.threshold)) + '</span></th>').join('') +
            '</tr>';

        const body = depts.map((d, di) => {
            const bg = di % 2 ? '#fafafa' : '#fff';
            const cells = levels.map((l) => {
                const k = d.id + '|' + l.id;
                const r = rules[k];
                const missing = !r;
                const none = r && r.requirement === reqNone;
                const cellBg = missing ? '#fbfbfb' : (none ? '#f2f2f2' : '#eaf6ec');

                return '<td style="padding:6px 8px;background:' + cellBg + ';border:1px solid #e3e3e3;' +
                    'vertical-align:top" data-cell="' + k + '">' +
                    '<select class="rax-req" data-k="' + k + '" style="width:100%;margin-bottom:3px">' +
                        '<option value=""' + (missing ? ' selected' : '') + '>-- inherit / none --</option>' +
                        '<option value="' + reqRequired + '"' +
                            (r && r.requirement === reqRequired ? ' selected' : '') + '>Approval Required</option>' +
                        '<option value="' + reqNone + '"' + (none ? ' selected' : '') + '>No Approval Needed</option>' +
                    '</select>' +
                    '<select class="rax-p" data-k="' + k + '" style="width:100%;margin-bottom:3px"' +
                        (none ? ' disabled' : '') + '>' + opts(r ? r.approver : '') + '</select>' +
                    '<select class="rax-s" data-k="' + k + '" style="width:100%;font-size:11px;color:#666"' +
                        (none ? ' disabled' : '') + '>' + opts(r ? r.secondary : '') + '</select>' +
                    '<label style="display:block;font-size:10px;color:#555;margin-top:2px">' +
                        '<input type="checkbox" class="rax-b" data-k="' + k + '"' +
                        (r && r.useBillSec ? ' checked' : '') + (none ? ' disabled' : '') +
                        '> Use ' + lib.esc(txn.label) + '\'s Secondary Approver</label>' +
                    '<input type="hidden" class="rax-id" data-k="' + k + '" value="' +
                        (r ? r.id : '') + '">' +
                    '</td>';
            }).join('');

            return '<tr style="background:' + bg + '">' +
                '<td style="padding:8px 10px;font-weight:bold;position:sticky;left:0;background:' + bg +
                ';border:1px solid #e3e3e3;white-space:nowrap">' + lib.esc(d.name) + '</td>' +
                cells + '</tr>';
        }).join('');

        return '<div style="font:12px Arial;overflow-x:auto;max-width:100%;border:1px solid #ddd">' +
            '<table id="raxGrid" style="border-collapse:collapse;width:100%">' +
            '<thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' +
            '<div style="font:11px Arial;color:#777;padding:6px 0">' +
            'Green = approver assigned &nbsp;&middot;&nbsp; Grey = explicitly no approval needed ' +
            '&nbsp;&middot;&nbsp; Blank = inherits the nearest configured band to its left, or no ' +
            'approval if the department has no rules at all. ' +
            'The second dropdown in each cell is the primary approver; the third is the secondary. ' +
            'Either may approve. Ticking "Use bill\'s Secondary Approver" routes the cell to the ' +
            'employee chosen in the Secondary Approver field on each ' + lib.esc(txn.label) +
            ': alone, that person is the approver; alongside a named primary, they are the ' +
            'co-approver. Saving this grid only writes cells for ' + lib.esc(txn.label) +
            ' - switch the toggle above to configure the other transaction type\'s approvers ' +
            'for these same bands.</div>';
    };

    /* ============ POST ============ */

    const handlePost = (context) => {
        const p = context.request.parameters;
        let saved = 0, removed = 0, errors = [];

        /* --- settings --- */
        try {
            const s = lib.getSettings();
            const values = {
                [lib.FLD.blockSelf]: p.custpage_block_self === 'T',
                [lib.FLD.fallback]: p.custpage_fallback || '',
                [lib.FLD.strictGaps]: p.custpage_strict_gaps === 'T',
                [lib.FLD.skipNative]: p.custpage_skip_native === 'T',
                [lib.FLD.overrideRls]: (p.custpage_override_roles || '')
                    .split('\u0005').filter(Boolean)
            };
            if (s.id) {
                record.submitFields({ type: lib.REC.SETTING, id: s.id, values: values });
            } else {
                const r = record.create({ type: lib.REC.SETTING });
                r.setValue({ fieldId: 'name', value: 'RAX Approval Settings' });
                Object.keys(values).forEach((k) => r.setValue({ fieldId: k, value: values[k] }));
                r.save({ ignoreMandatoryFields: true });
            }
        } catch (e) {
            log.error({ title: 'RAX settings save failed', details: e.message });
            errors.push('Settings: ' + e.message);
        }

        /* --- matrix cells --- */
        // Every cell on this page belongs to whichever type is toggled - the
        // grid never mixes types, so one resolved id covers the whole save.
        const txn = lib.resolveTxnByKey(p.custpage_txn_type) || lib.TXN.VENDOR_BILL;
        const applyId = lib.listId(lib.LIST.APPLIES_TO, txn.appliesToText, lib.REC.RULE, lib.FLD.ruleAppliesTo);

        let cells = [];
        try { cells = JSON.parse(p.custpage_payload || '[]'); }
        catch (e) { errors.push('Grid payload could not be read.'); }

        cells.forEach((c) => {
            try {
                const parts = String(c.k).split('|');
                const deptId = parts[0], levelId = parts[1];

                if (!c.req) {                                  // reverted to unconfigured
                    if (c.id) { record.delete({ type: lib.REC.RULE, id: c.id }); removed++; }
                    return;
                }

                const values = {
                    [lib.FLD.level]: levelId,
                    [lib.FLD.dept]: deptId,
                    [lib.FLD.requirement]: c.req,
                    [lib.FLD.approver]: c.p || '',
                    [lib.FLD.secondary]: c.s || '',
                    [lib.FLD.useBillSec]: !!c.b,
                    [lib.FLD.ruleAppliesTo]: applyId
                };

                if (c.id) {
                    record.submitFields({ type: lib.REC.RULE, id: c.id, values: values });
                } else {
                    const r = record.create({ type: lib.REC.RULE });
                    Object.keys(values).forEach((k) => r.setValue({ fieldId: k, value: values[k] }));
                    r.save({ ignoreMandatoryFields: true });
                }
                saved++;
            } catch (e) {
                errors.push(lib.esc(c.label || c.k) + ': ' + e.message);
                log.error({ title: 'RAX rule save failed', details: c.k + ' :: ' + e.message });
            }
        });

        const msg = errors.length
            ? 'Saved ' + saved + ' cell(s) with errors: ' + errors.slice(0, 5).join(' | ')
            : 'Saved ' + saved + ' cell(s)' + (removed ? ', removed ' + removed : '') + '.';

        context.response.sendRedirect({
            type: 'SUITELET',
            identifier: 'customscript_rax_sl_approval_admin',
            id: 'customdeploy_rax_sl_approval_admin',
            parameters: { custparam_msg: msg, custpage_txn_type: p.custpage_txn_type || '' }
        });
    };

    return { onRequest };
});

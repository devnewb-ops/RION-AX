/**
 * rax_cs_approval_admin.js  —  RAX v6.3-po
 *
 * Serialises the matrix grid into the hidden payload field on save, keeps the
 * approver dropdowns consistent with the requirement dropdown, and reloads
 * the page when the Transaction Type toggle changes (the grid it drives is
 * built server-side, so there is nothing to re-render client-side).
 *
 * Attached via form.clientScriptModulePath from rax_sl_approval_admin.
 *
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/currentRecord', 'N/url'], (currentRecord, url) => {

    const fieldChanged = (context) => {
        if (context.fieldId !== 'custpage_txn_type') return;
        const value = context.currentRecord.getValue({ fieldId: 'custpage_txn_type' });
        window.location = url.resolveScript({
            scriptId: 'customscript_rax_sl_approval_admin',
            deploymentId: 'customdeploy_rax_sl_approval_admin',
            params: { custpage_txn_type: value }
        });
    };

    const pageInit = () => {
        const grid = document.getElementById('raxGrid');
        if (!grid) return;

        // No approval needed -> approver selects are meaningless.
        grid.addEventListener('change', (ev) => {
            const el = ev.target;
            if (!el.classList || !el.classList.contains('rax-req')) return;
            const k = el.getAttribute('data-k');
            const none = el.options[el.selectedIndex].text === 'No Approval Needed';
            ['rax-p', 'rax-s'].forEach((cls) => {
                const sel = grid.querySelector('select.' + cls + '[data-k="' + k + '"]');
                if (!sel) return;
                sel.disabled = none;
                if (none) sel.value = '';
            });
            const box = grid.querySelector('input.rax-b[data-k="' + k + '"]');
            if (box) { box.disabled = none; if (none) box.checked = false; }
            const td = grid.querySelector('td[data-cell="' + k + '"]');
            if (td) td.style.background = !el.value ? '#fdecea' : (none ? '#f2f2f2' : '#eaf6ec');
        });
    };

    const saveRecord = () => {
        const grid = document.getElementById('raxGrid');
        if (!grid) return true;

        const cells = [];
        const problems = [];

        grid.querySelectorAll('select.rax-req').forEach((req) => {
            const k = req.getAttribute('data-k');
            const p = grid.querySelector('select.rax-p[data-k="' + k + '"]');
            const s = grid.querySelector('select.rax-s[data-k="' + k + '"]');
            const id = grid.querySelector('input.rax-id[data-k="' + k + '"]');
            const b = grid.querySelector('input.rax-b[data-k="' + k + '"]');
            const useBillSec = !!(b && b.checked);
            const none = req.value && req.options[req.selectedIndex].text === 'No Approval Needed';

            // A cell may be Required with no named primary when the bill's
            // Secondary Approver carries it.
            if (req.value && !none && !p.value && !useBillSec) problems.push(k);
            if (p.value && s.value && p.value === s.value) problems.push(k);
            // The flag and a named secondary compete for the same slot.
            if (useBillSec && s.value) problems.push(k);

            cells.push({
                k: k,
                id: id ? id.value : '',
                req: req.value || '',
                p: none ? '' : (p ? p.value : ''),
                s: none ? '' : (s ? s.value : ''),
                b: none ? 0 : (useBillSec ? 1 : 0)
            });
        });

        if (problems.length) {
            alert('Some cells are incomplete: a cell set to Approval Required needs a primary ' +
                  'approver or the Use bill\'s Secondary Approver flag, the primary and secondary ' +
                  'cannot be the same person, and the flag cannot be combined with a named ' +
                  'secondary. ' + problems.length + ' cell(s) affected.');
            return false;
        }

        currentRecord.get().setValue({
            fieldId: 'custpage_payload',
            value: JSON.stringify(cells),
            ignoreFieldChange: true
        });
        return true;
    };

    return { pageInit, saveRecord, fieldChanged };
});

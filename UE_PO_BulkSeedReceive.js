/**
 * UE_PO_BulkSeedReceive.js
 * User Event Script — Purchase Order
 * Deploys on: Purchase Order | Event: beforeLoad
 *
 * When custbody_bcc_seed_po is TRUE and the PO is in VIEW mode:
 *  1. Hides the standard "Receive" button server-side
 *  2. Adds a "Receive Bulk Seed" button
 *  3. Attaches the companion Client Script
 */
/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['N/ui/serverWidget', 'N/log'], (serverWidget, log) => {
    const beforeLoad = (context) => {
        if (context.type !== context.UserEventType.VIEW) return;
        const rec = context.newRecord;
        const isSeedPO = rec.getValue({ fieldId: 'custbody_bcc_seed_po' });
        if (!isSeedPO) return;
        const form = context.form;
        // ── 1. Hide the standard Receive button server-side ──────────────────
        // NetSuite's internal button ID for the Receive button on a PO is 'receive'.
        try {
            const receiveBtn = form.getButton({ id: 'receive' });
            if (receiveBtn) {
                receiveBtn.isHidden = true;
            }
        } catch (e) {
            log.debug({ title: 'UE_PO_BulkSeedReceive: could not hide Receive btn', details: e.message });
        }
        // ── 2. Add Receive Bulk Seed button ──────────────────────────────────
        form.addButton({
            id:           'custpage_receive_bulk_seed',
            label:        'Receive Bulk Seed',
            functionName: 'receiveBulkSeed(' + rec.id + ')'
        });
        // ── 3. Attach companion Client Script ────────────────────────────────
        form.clientScriptModulePath = './CS_PO_BulkSeedReceive.js';
    };
    return { beforeLoad };
});
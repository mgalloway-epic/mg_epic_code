/**
 * CS_PO_BulkSeedReceive.js
 * Client Script — Purchase Order
 * Loaded via form.clientScriptModulePath from UE_PO_BulkSeedReceive.js
 *
 * 1. pageInit  — fallback hide of standard Receive button (in case server-side hide didn't work)
 * 2. receiveBulkSeed(poId) — opens the Bulk Seed Check-in Suitelet
 */

/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 */
define(['N/url'], (url) => {

    // ─── pageInit ────────────────────────────────────────────────────────────
    const pageInit = (context) => {
        // Fallback: aggressively find and hide any remaining Receive button.
        // The server-side hide is primary; this catches edge cases.
        try {
            // Style the Receive Bulk Seed button blue to match primary buttons
            const bulkBtn = document.getElementById('custpage_receive_bulk_seed')
                         || document.querySelector('input[value="Receive Bulk Seed"]')
                         || document.querySelector('button[id*="bulk_seed"]');
            if (bulkBtn) {
                bulkBtn.style.backgroundColor = '#1A6EBF';
                bulkBtn.style.color           = '#ffffff';
                bulkBtn.style.borderColor     = '#1A6EBF';
                bulkBtn.className = (bulkBtn.className || '') + ' uir-button-style-primary';
            }
        } catch(e) {}

        try {
            // Try multiple selector strategies across NS versions
            const selectors = [
                '#tdbtnreceive',                          // Classic wrapper td
                'td[id*="receive"]',                      // Any td whose ID contains "receive"
                'input[value="Receive"]',                  // Input button with label "Receive"
                'button[id*="receive"]:not([id*="bulk"])'  // Button IDs containing receive but NOT bulk
            ];

            selectors.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    // Don't hide our own Receive Bulk Seed button
                    if (el.id && el.id.includes('bulk_seed')) return;
                    if (el.value && el.value.toLowerCase().includes('bulk')) return;
                    const td = el.closest('td') || el;
                    td.style.display = 'none';
                });
            });
        } catch (e) {
            console.warn('CS_PO_BulkSeedReceive: button hide fallback error', e);
        }
    };

    // ─── receiveBulkSeed ─────────────────────────────────────────────────────
    const receiveBulkSeed = (poId) => {
        try {
            const suiteletUrl = url.resolveScript({
                scriptId:     'customscript_sl_bulk_seed_checkin',
                deploymentId: 'customdeploy_sl_bulk_seed_checkin',
                params:       { poid: poId }
            });

            // Opens in a new tab — change to window.location.href for same tab
            window.open(suiteletUrl, '_blank');
        } catch (e) {
            console.error('receiveBulkSeed error:', e);
            alert('Unable to open Bulk Seed Check-in.\n\n' + e.message);
        }
    };

    return { pageInit, receiveBulkSeed };
});
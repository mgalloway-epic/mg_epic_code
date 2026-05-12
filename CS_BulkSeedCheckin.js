/**
 * CS_BulkSeedCheckin.js
 * Client Script — Bulk Seed Bag Check-in Suitelet
 *
 * Two separate fields toggled by item UOM:
 *   - Weight items:     shows custpage_scale_weight  (Bag Weight from Scale gm)
 *   - Seed count items: shows custpage_seeds_in_bag  (Seeds in Bag)
 */

/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 */
define(['N/currentRecord', 'N/format', 'N/url'], (currentRecord, format, url) => {

    let bagEntries           = [];   // bags for the CURRENTLY selected item (used for display/recalc)
    let allBagEntries        = [];   // ALL bags across ALL items (used for JSON payload)
    let itemNameMap          = {};   // itemId -> item name (loaded from hidden field on pageInit)
    let perItemBinMap        = {};   // itemId -> resolved preferred bin name
    let printedBagNumbers    = [];   // bag numbers already receipted via Print button
    let remainingMap         = {};
    let originalRemainingMap = {};
    let pendingDeleteWeight  = 0;
    let perItemBagCounter    = {};   // itemId -> next bag number for that item

    // ─── Find a field's container row by locating its input element ───────────
    const getFieldRow = (fieldId) => {
        const input = document.getElementById(fieldId)
                   || document.getElementById(fieldId + '_val');
        if (!input) return null;
        let el = input.parentElement;
        while (el && el.tagName !== 'TR' && el.tagName !== 'BODY') {
            if (el.tagName === 'TR') break;
            el = el.parentElement;
        }
        return el && el.tagName === 'TR' ? el : null;
    };

    // ─── toggleWeightFields ───────────────────────────────────────────────────
    const toggleWeightFields = (itemId) => {
        const seedCount = !!(itemId && isSeedCountItem(itemId));
        const scaleRow  = getFieldRow('custpage_scale_weight');
        const seedRow   = getFieldRow('custpage_seeds_in_bag');

        if (scaleRow) scaleRow.style.display = seedCount ? 'none' : '';
        if (seedRow)  seedRow.style.display  = seedCount ? ''     : 'none';

        const getWeightBtn = document.getElementById('custpage_get_weight')
                          || document.querySelector('input[value="Get Weight"]')
                          || document.querySelector('button[id*="get_weight"]');
        if (getWeightBtn) {
            const btnCell = getWeightBtn.closest('td') || getWeightBtn;
            btnCell.style.display = seedCount ? 'none' : '';
        }

        try {
            const rec = currentRecord.get();
            rec.setValue({ fieldId: 'custpage_scale_weight', value: 0  });
            rec.setValue({ fieldId: 'custpage_seeds_in_bag', value: '' });
        } catch(e) {}
    };

    // ─── printBag ─────────────────────────────────────────────────────────────
    const printBag = async (bagNumber) => {
        try {
            const bag = allBagEntries.find(e => e.bagNumber === bagNumber);
            if (!bag) { alert('Bag not found: ' + bagNumber); return; }

            const rec       = currentRecord.get();
            const poId      = rec.getValue({ fieldId: 'custpage_poid'               }) || '';
            const vendorLot = rec.getValue({ fieldId: 'custpage_lot_number'         }) || '';
            const coo       = rec.getValue({ fieldId: 'custpage_country_of_origin'  }) || '';

            const postUrl = url.resolveScript({
                scriptId:     'customscript_sl_bulk_seed_checkin',
                deploymentId: 'customdeploy_sl_bulk_seed_checkin'
            });

            const formData = new FormData();
            formData.append('action',                     'printbag');
            formData.append('custpage_poid',              poId);
            formData.append('custpage_lot_number',        vendorLot);
            formData.append('custpage_country_of_origin', coo);
            formData.append('custpage_print_bag_json',    JSON.stringify(bag));

            const response = await fetch(postUrl, { method: 'POST', body: formData });
            const result   = await response.json();

            if (result.error) {
                alert('Error creating receipt for bag ' + bagNumber + ': ' + result.error);
                return;
            }

            if (!printedBagNumbers.includes(bagNumber)) {
                printedBagNumbers.push(bagNumber);
                try { rec.setValue({ fieldId: 'custpage_printed_bags', value: JSON.stringify(printedBagNumbers) }); } catch(e) {}
            }

            try {
                const lineCount = rec.getLineCount({ sublistId: 'custpage_bags' });
                for (let i = 0; i < lineCount; i++) {
                    const bn = rec.getSublistValue({ sublistId: 'custpage_bags', fieldId: 'custpage_sl_bagnumber', line: i });
                    if (bn === bagNumber) {
                        rec.selectLine({ sublistId: 'custpage_bags', line: i });
                        rec.setCurrentSublistValue({ sublistId: 'custpage_bags', fieldId: 'custpage_sl_print', value: '✅ Printed' });
                        rec.commitLine({ sublistId: 'custpage_bags' });
                        break;
                    }
                }
            } catch(e) {}

            window.open('/app/accounting/transactions/itemrcpt.nl?id=' + result.receiptId, '_blank');

        } catch(e) {
            console.error('printBag error:', e);
            alert('Error printing bag tag: ' + e.message);
        }
    };

    // ─── injectPrintButtons ────────────────────────────────────────────────────
    const injectPrintButtons = () => {
        try {
            document.querySelectorAll('table td').forEach(cell => {
                const txt = cell.textContent.trim();
                if (!txt.startsWith('🖨|')) return;
                cell.style.color    = 'transparent';
                cell.style.fontSize = '0';
            });
        } catch(e) {
            console.warn('injectPrintButtons error:', e);
        }
    };

    const startPrintButtonObserver = () => {
        try {
            const observer = new MutationObserver(() => { injectPrintButtons(); });
            observer.observe(document.body, { childList: true, subtree: true });
        } catch(e) {}
    };

    // ─── pageInit ────────────────────────────────────────────────────────────
    const pageInit = (context) => {
        try {
            const rec         = currentRecord.get();
            const nameMapJson = rec.getValue({ fieldId: 'custpage_item_name_map' });
            if (nameMapJson) itemNameMap = JSON.parse(nameMapJson);
        } catch(e) { console.warn('pageInit: could not parse item name map', e); }

        try {
            const rec     = currentRecord.get();
            const mapJson = rec.getValue({ fieldId: 'custpage_remaining_map' });
            if (mapJson) {
                const parsed = JSON.parse(mapJson);
                Object.keys(parsed).forEach(id => {
                    remainingMap[id]         = parsed[id].qty;
                    originalRemainingMap[id] = { qty: parsed[id].qty, isSeedCount: parsed[id].isSeedCount };
                });
            }
        } catch (e) {
            console.warn('CS_BulkSeedCheckin pageInit: could not parse remaining map', e);
        }

        try {
            const rec    = currentRecord.get();
            const itemId = rec.getValue({ fieldId: 'custpage_item_id' });
            toggleWeightFields(itemId || null);
            if (itemId) updateRemainingDisplay();
        } catch(e) {}

        try {
            const rec      = currentRecord.get();
            const existing = rec.getValue({ fieldId: 'custpage_bags_json' });
            if (existing && existing !== '[]') {
                const parsed  = JSON.parse(existing);
                allBagEntries = parsed;
                bagEntries    = parsed;
            }
        } catch(e) { console.warn('pageInit bag restore error:', e); }

        try {
            const rec2    = currentRecord.get();
            const printed = rec2.getValue({ fieldId: 'custpage_printed_bags' });
            if (printed && printed !== '[]') printedBagNumbers = JSON.parse(printed);
        } catch(e) {}

        setTimeout(startPrintButtonObserver, 300);
        setTimeout(injectPrintButtons, 600);

        updateFooter();
    };

    // ─── helpers ─────────────────────────────────────────────────────────────
    const isSeedCountItem = (itemId) => {
        return !!(originalRemainingMap[String(itemId)] && originalRemainingMap[String(itemId)].isSeedCount);
    };

    // ─── syncBagsJson ────────────────────────────────────────────────────────
    const syncBagsJson = (itemId) => {
        try {
            const rec = currentRecord.get();
            const payload = allBagEntries.map(e => ({
                itemId:         e.itemId,
                bagNumber:      e.bagNumber,
                weight:         e.weight         || 0,
                seedCount:      e.seedCount      || 0,
                isSeedCount:    e.isSeedCount    || false,
                tareWeight:     e.tareWeight     || 0,
                expirationDate: e.expirationDate || '',
                vendorLot:      e.vendorLot      || '',
                coo:            e.coo            || '',
                itemName:       e.itemName       || ''
            }));
            rec.setValue({ fieldId: 'custpage_bags_json', value: JSON.stringify(payload) });
        } catch(e) {
            console.warn('syncBagsJson error:', e);
        }
    };

    // ─── lookupPreferredBin ──────────────────────────────────────────────────
    const lookupPreferredBin = async (itemId) => {
        try {
            const rec        = currentRecord.get();
            const locationId = rec.getValue({ fieldId: 'custpage_location_id' }) || '';
            const binUrl     = url.resolveScript({
                scriptId:     'customscript_sl_bulk_seed_checkin',
                deploymentId: 'customdeploy_sl_bulk_seed_checkin',
                params:       { action: 'getbin', item: itemId, location: locationId }
            });
            const response = await fetch(binUrl);
            const result   = await response.json();
            const binName  = result.binName || '';
            try { rec.setValue({ fieldId: 'custpage_preferred_bin', value: binName }); } catch(e) {}
            perItemBinMap[String(itemId)] = binName;
        } catch(e) {
            console.warn('lookupPreferredBin error:', e);
        }
    };

    // ─── fieldChanged ─────────────────────────────────────────────────────────
    const fieldChanged = (context) => {
        if (context.fieldId === 'custpage_item_id') {
            const rec    = currentRecord.get();
            const itemId = rec.getValue({ fieldId: 'custpage_item_id' });
            toggleWeightFields(itemId);
            updateRemainingDisplay();

            try {
                const itemName = itemNameMap[String(itemId)] || '';
                rec.setValue({ fieldId: 'custpage_selected_item_name', value: itemName });
            } catch(e) { console.warn('fieldChanged item name error:', e); }

            try {
                rec.setValue({ fieldId: 'custpage_lot_number',        value: '' });
                rec.setValue({ fieldId: 'custpage_country_of_origin', value: '' });
                rec.setValue({ fieldId: 'custpage_expiration_date',   value: '' });
                rec.setValue({ fieldId: 'custpage_bag_name',          value: '' });
                rec.setValue({ fieldId: 'custpage_tare_weight',       value: '' });
            } catch(e) { console.warn('fieldChanged clear fields error:', e); }

            if (itemId) {
                const nextNum = perItemBagCounter[String(itemId)] || 1;
                rec.setValue({ fieldId: 'custpage_next_bag', value: nextNum });
                lookupPreferredBin(itemId);
            } else {
                try { rec.setValue({ fieldId: 'custpage_preferred_bin', value: '' }); } catch(e) {}
                perItemBinMap[String(itemId)] = '';
            }
        }
    };

    // ─── updateRemainingDisplay ───────────────────────────────────────────────
    const updateRemainingDisplay = () => {
        try {
            const rec       = currentRecord.get();
            const itemId    = rec.getValue({ fieldId: 'custpage_item_id' });
            const remaining = (itemId && remainingMap[String(itemId)] !== undefined)
                ? remainingMap[String(itemId)] : null;

            let displayVal = '';
            if (remaining === null || itemId === '') {
                displayVal = '';
            } else if (remaining < 0) {
                const seedCount = isSeedCountItem(itemId);
                const overAmt   = seedCount ? Math.abs(Math.round(remaining)).toString() : Math.abs(remaining).toFixed(2);
                const overLabel = seedCount ? ' seeds' : ' gm';
                displayVal = 'OVER RECEIVED by ' + overAmt + overLabel;
            } else if (remaining === 0) {
                displayVal = 'FULLY RECEIVED';
            } else {
                const seedCount = isSeedCountItem(itemId);
                const label     = seedCount ? ' seeds remaining' : ' gm remaining';
                const display   = seedCount ? Math.round(remaining).toString() : remaining.toFixed(2);
                displayVal = display + label;
            }
            try { rec.setValue({ fieldId: 'custpage_remaining_display',  value: displayVal }); } catch(e) {}
            try { rec.setValue({ fieldId: 'custpage_remaining_display2', value: displayVal }); } catch(e) {}
        } catch (e) {
            console.warn('updateRemainingDisplay error:', e);
        }
    };

    // ─── addNewBag ────────────────────────────────────────────────────────────
    const addNewBag = async () => {
        try {
            const rec        = currentRecord.get();
            const bagName    = rec.getValue({ fieldId: 'custpage_bag_name'     });
            const nextBagNum = parseInt(rec.getValue({ fieldId: 'custpage_next_bag' }), 10) || 1;
            const increment  = rec.getValue({ fieldId: 'custpage_increment' });
            const itemId     = rec.getValue({ fieldId: 'custpage_item_id'   });
            const seedCount  = isSeedCountItem(itemId);

            const itemText       = rec.getValue({ fieldId: 'custpage_selected_item_name' }) || '';
            const scaleWeight    = parseFloat(rec.getValue({ fieldId: 'custpage_scale_weight'   })) || 0;
            const tareWeight     = parseFloat(rec.getValue({ fieldId: 'custpage_tare_weight'    })) || 0;
            const seedsInBag     = parseInt(rec.getValue({  fieldId: 'custpage_seeds_in_bag'    }), 10) || 0;
            const vendorLot      = rec.getValue({ fieldId: 'custpage_lot_number'        }) || '';
            const coo            = rec.getValue({ fieldId: 'custpage_country_of_origin' }) || '';

            let preferredBin = perItemBinMap[String(itemId)] || '';
            if (!preferredBin) {
                try {
                    const locationId = rec.getValue({ fieldId: 'custpage_location_id' }) || '';
                    const binUrl = url.resolveScript({
                        scriptId:     'customscript_sl_bulk_seed_checkin',
                        deploymentId: 'customdeploy_sl_bulk_seed_checkin',
                        params:       { action: 'getbin', item: String(itemId), location: locationId }
                    });
                    const resp   = await fetch(binUrl);
                    const result = await resp.json();
                    preferredBin = result.binName || '';
                    if (preferredBin) perItemBinMap[String(itemId)] = preferredBin;
                    try { rec.setValue({ fieldId: 'custpage_preferred_bin', value: preferredBin }); } catch(e) {}
                } catch(e) { console.warn('inline bin lookup error:', e); }
            }

            const expDateVal = rec.getValue({ fieldId: 'custpage_expiration_date' });
            let expirationDate = '';
            if (expDateVal) {
                try {
                    const d    = (expDateVal instanceof Date) ? expDateVal : new Date(expDateVal);
                    const yyyy = d.getFullYear();
                    const mm   = String(d.getMonth() + 1).padStart(2, '0');
                    const dd   = String(d.getDate()).padStart(2, '0');
                    expirationDate = yyyy + '-' + mm + '-' + dd;
                } catch(e) {
                    expirationDate = String(expDateVal);
                }
            }

            if (!bagName) { alert('Bag Name is required before adding a bag.');           return; }
            if (!itemId)  { alert('Please select a Bulk Seed Item before adding a bag.'); return; }
            if (!seedCount && scaleWeight <= 0) {
                alert('Please enter the bag weight from the scale (must be > 0).'); return;
            }
            if (seedCount && seedsInBag <= 0) {
                alert('Please enter the number of seeds in this bag (must be > 0).'); return;
            }

            const proposedBagNumber = bagName + '-' + String(nextBagNum);
            try {
                const lotCheckUrl = url.resolveScript({
                    scriptId:     'customscript_sl_bulk_seed_checkin',
                    deploymentId: 'customdeploy_sl_bulk_seed_checkin',
                    params:       { action: 'checklot', lot: proposedBagNumber, item: itemId }
                });
                const response = await fetch(lotCheckUrl);
                const result   = await response.json();
                if (result.exists) {
                    const proceed = confirm('Warning: Lot number "' + proposedBagNumber + '" already exists in NetSuite for this item. The existing lot expiration date will be used instead of the one entered here. Do you want to proceed anyway?');
                    if (!proceed) return;
                }
            } catch(lotErr) {
                console.warn('Lot check failed (non-blocking):', lotErr);
            }

            const netWeight = seedCount ? 0 : Math.max(0, scaleWeight - tareWeight);
            const netSeeds  = seedCount ? seedsInBag : 0;
            const deductVal = seedCount ? netSeeds : netWeight;

            const entry = {
                bagNumber:      bagName + '-' + String(nextBagNum),
                date:           format.format({ value: new Date(), type: format.Type.DATE }),
                status:         'Received',
                weight:         netWeight,
                seedCount:      netSeeds,
                vendorLot:      vendorLot,
                coo:            coo,
                tareWeight:     tareWeight,
                expirationDate: expirationDate,
                preferredBin:   preferredBin
            };

            bagEntries.push(entry);
            allBagEntries.push({ ...entry, itemId: String(itemId), isSeedCount: seedCount, vendorLot: vendorLot, coo: coo, itemName: itemText });

            rec.selectNewLine({ sublistId: 'custpage_bags' });
            rec.setCurrentSublistValue({ sublistId: 'custpage_bags', fieldId: 'custpage_sl_bagnumber', value: entry.bagNumber });
            rec.setCurrentSublistValue({ sublistId: 'custpage_bags', fieldId: 'custpage_sl_item',      value: itemText || '' });
            rec.setCurrentSublistValue({ sublistId: 'custpage_bags', fieldId: 'custpage_sl_date',      value: new Date()     });
            rec.setCurrentSublistValue({ sublistId: 'custpage_bags', fieldId: 'custpage_sl_status',    value: entry.status   });
            if (!seedCount && netWeight > 0) {
                rec.setCurrentSublistValue({ sublistId: 'custpage_bags', fieldId: 'custpage_sl_weight',     value: parseFloat(netWeight.toFixed(2)) });
            }
            if (seedCount) {
                rec.setCurrentSublistValue({ sublistId: 'custpage_bags', fieldId: 'custpage_sl_seed_count', value: netSeeds });
            }
            if (tareWeight > 0) {
                rec.setCurrentSublistValue({ sublistId: 'custpage_bags', fieldId: 'custpage_sl_tare', value: parseFloat(tareWeight) });
            }
            if (vendorLot) {
                rec.setCurrentSublistValue({ sublistId: 'custpage_bags', fieldId: 'custpage_sl_vendor_lot', value: vendorLot });
            }
            if (coo) {
                rec.setCurrentSublistValue({ sublistId: 'custpage_bags', fieldId: 'custpage_sl_coo', value: coo });
            }
            if (expDateVal) {
                try { rec.setCurrentSublistValue({ sublistId: 'custpage_bags', fieldId: 'custpage_sl_exp_date', value: expDateVal }); } catch(e) {}
            }

            try {
                rec.setCurrentSublistValue({ sublistId: 'custpage_bags', fieldId: 'custpage_sl_print', value: '🖨|' + entry.bagNumber });
            } catch(e) { console.warn('print col error:', e); }

            rec.commitLine({ sublistId: 'custpage_bags' });

            if (remainingMap[String(itemId)] !== undefined) {
                remainingMap[String(itemId)] = remainingMap[String(itemId)] - deductVal;
            }

            const newBagNum = increment === 'DESC' ? nextBagNum - 1 : nextBagNum + 1;
            rec.setValue({ fieldId: 'custpage_next_bag',     value: newBagNum });
            rec.setValue({ fieldId: 'custpage_scale_weight', value: 0         });
            rec.setValue({ fieldId: 'custpage_seeds_in_bag', value: ''        });

            perItemBagCounter[String(itemId)] = newBagNum;

            if (remainingMap[String(itemId)] !== undefined && remainingMap[String(itemId)] < 0) {
                try {
                    const rec2      = currentRecord.get();
                    const lineCount = rec2.getLineCount({ sublistId: 'custpage_bags' });
                    const lastLine  = lineCount - 1;
                    rec2.selectLine({ sublistId: 'custpage_bags', line: lastLine });
                    rec2.setCurrentSublistValue({ sublistId: 'custpage_bags', fieldId: 'custpage_sl_over_recv', value: '⚠ YES' });
                    rec2.commitLine({ sublistId: 'custpage_bags' });
                } catch(e) {
                    console.warn('over received column error:', e);
                }
            }

            syncBagsJson(itemId);
            updateRemainingDisplay();
            updateFooter();

        } catch (e) {
            console.error('addNewBag error:', e);
            alert('Error adding bag: ' + e.message);
        }
    };

    // ─── getWeight ───────────────────────────────────────────────────────────
    const getWeight = async () => {
        try {
            const rec     = currentRecord.get();
            const bagName = rec.getValue({ fieldId: 'custpage_bag_name' });
            const itemId  = rec.getValue({ fieldId: 'custpage_item_id'  });
            const tare    = parseFloat(rec.getValue({ fieldId: 'custpage_tare_weight' })) || 0;

            if (!bagName) { alert('Please enter a Bag Name before getting weight.');                return; }
            if (!itemId)  { alert('Please select a Bulk Seed Item before getting weight.');         return; }
            if (tare <= 0) { alert('Please enter a Tare Weight (GM) before getting weight.');       return; }

            const currentWeight = parseFloat(rec.getValue({ fieldId: 'custpage_scale_weight' })) || 0;

            if (currentWeight <= 0) {
                alert('Scale not yet connected. To use Get Weight, enter the weight manually in the Bag Weight from Scale field then click Get Weight to add the bag. Scale integration will be enabled once the scale is connected to NetSuite.');
                return;
            }

            await addNewBag();

        } catch (e) {
            console.error('getWeight error:', e);
            alert('Error reading weight: ' + e.message);
        }
    };

    // ─── clearBagEntry ────────────────────────────────────────────────────────
    const clearBagEntry = () => {
        const rec = currentRecord.get();
        rec.setValue({ fieldId: 'custpage_scale_weight', value: 0  });
        rec.setValue({ fieldId: 'custpage_seeds_in_bag', value: '' });
    };

    // ─── showSummary ──────────────────────────────────────────────────────────
    const showSummary = () => {
        if (bagEntries.length === 0) { alert('No bags have been added yet.'); return; }
        const totalWeight = bagEntries.reduce((sum, e) => sum + (parseFloat(e.weight)  || 0), 0);
        const totalSeeds  = bagEntries.reduce((sum, e) => sum + (parseInt(e.seedCount) || 0), 0);
        let msg = '=== Bag Check-in Summary ===\n\nBag Count: ' + bagEntries.length + '\n';
        if (totalWeight > 0) msg += 'Total Net Weight: ' + totalWeight.toFixed(2) + ' gm\n';
        if (totalSeeds  > 0) msg += 'Total Seeds: ' + totalSeeds + '\n';
        msg += '\n--- Bag Detail ---\n';
        bagEntries.forEach((e, idx) => {
            const val = e.seedCount > 0 ? e.seedCount + ' seeds' : e.weight.toFixed(2) + ' gm';
            msg += (idx + 1) + '. ' + e.bagNumber + '  |  ' + val + '  |  ' + e.date + '\n';
        });
        alert(msg);
    };

    // ─── recalculateRemaining ─────────────────────────────────────────────────
    const recalculateRemaining = () => {
        try {
            const rec    = currentRecord.get();
            const itemId = rec.getValue({ fieldId: 'custpage_item_id' });
            if (!itemId) { alert('Please select a Bulk Seed Item first.'); return; }

            const seedCount = isSeedCountItem(itemId);
            const lineCount = rec.getLineCount({ sublistId: 'custpage_bags' });
            let sumVal = 0;
            for (let i = 0; i < lineCount; i++) {
                const fId = seedCount ? 'custpage_sl_seed_count' : 'custpage_sl_weight';
                sumVal += parseFloat(rec.getSublistValue({ sublistId: 'custpage_bags', fieldId: fId, line: i })) || 0;
            }

            const origEntry = originalRemainingMap[String(itemId)];
            if (origEntry !== undefined) {
                remainingMap[String(itemId)] = Math.max(0, origEntry.qty - sumVal);
            }

            bagEntries = [];
            for (let i = 0; i < lineCount; i++) {
                bagEntries.push({
                    bagNumber: rec.getSublistValue({ sublistId: 'custpage_bags', fieldId: 'custpage_sl_bagnumber',  line: i }),
                    weight:    rec.getSublistValue({ sublistId: 'custpage_bags', fieldId: 'custpage_sl_weight',     line: i }) || 0,
                    seedCount: rec.getSublistValue({ sublistId: 'custpage_bags', fieldId: 'custpage_sl_seed_count', line: i }) || 0,
                    date:      rec.getSublistValue({ sublistId: 'custpage_bags', fieldId: 'custpage_sl_date',       line: i })
                });
            }

            allBagEntries = allBagEntries.filter(e => e.itemId !== String(itemId));
            bagEntries.forEach(e => allBagEntries.push({ ...e, itemId: String(itemId), isSeedCount: isSeedCountItem(itemId) }));
            if (itemId) syncBagsJson(itemId);
            updateRemainingDisplay();
            updateFooter();
        } catch (e) {
            console.error('recalculateRemaining error:', e);
            alert('Error recalculating: ' + e.message);
        }
    };

    // ─── validateDelete / sublistChanged ─────────────────────────────────────
    const validateDelete = (context) => {
        if (context.sublistId !== 'custpage_bags') return true;
        try {
            const rec    = currentRecord.get();
            const itemId = rec.getValue({ fieldId: 'custpage_item_id' });
            const fId    = isSeedCountItem(itemId) ? 'custpage_sl_seed_count' : 'custpage_sl_weight';
            pendingDeleteWeight = parseFloat(rec.getSublistValue({ sublistId: 'custpage_bags', fieldId: fId, line: context.line })) || 0;
        } catch (e) { pendingDeleteWeight = 0; }
        return true;
    };

    const sublistChanged = (context) => {
        if (context.sublistId !== 'custpage_bags' || context.operation !== 'remove') return;
        try {
            const rec    = currentRecord.get();
            const itemId = rec.getValue({ fieldId: 'custpage_item_id' });
            if (itemId && pendingDeleteWeight > 0 && remainingMap[String(itemId)] !== undefined) {
                remainingMap[String(itemId)] += pendingDeleteWeight;
                const idx = bagEntries.findIndex(e =>
                    parseFloat(e.weight) === pendingDeleteWeight || parseInt(e.seedCount) === pendingDeleteWeight
                );
                if (idx !== -1) bagEntries.splice(idx, 1);
                const allIdx = allBagEntries.findIndex(e =>
                    e.itemId === String(rec.getValue({ fieldId: 'custpage_item_id' })) &&
                    (parseFloat(e.weight) === pendingDeleteWeight || parseInt(e.seedCount) === pendingDeleteWeight)
                );
                if (allIdx !== -1) allBagEntries.splice(allIdx, 1);
                pendingDeleteWeight = 0;
                syncBagsJson(itemId);
                updateRemainingDisplay();
                updateFooter();
            }
        } catch (e) { console.warn('sublistChanged error:', e); }
    };

    // ─── updateFooter ─────────────────────────────────────────────────────────
    const updateFooter = () => {
        const totalWeight   = bagEntries.reduce((sum, e) => sum + (parseFloat(e.weight) || 0), 0);
        const bagCountEl    = document.getElementById('custpage_bag_count_display');
        const totalWeightEl = document.getElementById('custpage_total_weight_display');
        if (bagCountEl)    bagCountEl.innerText    = bagEntries.length;
        if (totalWeightEl) totalWeightEl.innerText = totalWeight.toFixed(2) + ' gm';
    };

    // ─── showBinErrorBanner ───────────────────────────────────────────────────
    // Injects a red error banner above the form listing items with no preferred
    // bin, with direct links to each item record so the user can fix them without
    // leaving the page (links open in a new tab). All bag data stays intact.
    const showBinErrorBanner = (itemsMissingBin) => {
        const existing = document.getElementById('custpage_bin_error_banner');
        if (existing) existing.remove();

        const itemLinks = itemsMissingBin.map(id => {
            const name = itemNameMap[id] || ('Item ID ' + id);
            return '<a href="/app/common/item/item.nl?id=' + id + '" target="_blank" ' +
                   'style="color:#7b1c1c;font-weight:bold;text-decoration:underline;display:inline-flex;align-items:center;gap:4px;">' +
                   name + ' &#x2197;</a>';
        }).join('<br>');

        const banner = document.createElement('div');
        banner.id = 'custpage_bin_error_banner';
        banner.innerHTML =
            '<div style="background:#fde8e8;border:2px solid #c0392b;color:#7b1c1c;' +
            'padding:14px 18px;margin:10px 0 16px 0;border-radius:5px;font-size:13px;line-height:1.7;">' +
                '<div style="font-size:15px;font-weight:bold;margin-bottom:8px;">' +
                    '&#x1F6AB; Submission blocked — preferred bin not set' +
                '</div>' +
                '<div style="margin-bottom:10px;">' +
                    'The following item(s) do not have a preferred bin configured. ' +
                    'Open each link below in a new tab, set the preferred bin for the correct location, then save the item record:' +
                '</div>' +
                '<div style="margin-bottom:12px;padding-left:8px;display:flex;flex-direction:column;gap:6px;">' +
                    itemLinks +
                '</div>' +
                '<div style="background:rgba(192,57,43,0.08);border-radius:4px;padding:8px 10px;">' +
                    'Once done, click <strong>Re-check Preferred Bins</strong> on this form, ' +
                    'then click <strong>Done — Create Item Receipt</strong> again. ' +
                    '<em>All your bag data has been preserved — do not close or refresh this tab.</em>' +
                '</div>' +
            '</div>';

        const target = document.querySelector('.uir-page-title-main-cell')
                    || document.querySelector('table.uir-form')
                    || document.body.firstChild;
        document.body.insertBefore(banner, target);
        banner.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    // ─── recheckBins ──────────────────────────────────────────────────────────
    // Re-fetches preferred bins for every item currently in allBagEntries by
    // clearing the client-side cache and hitting the server fresh. Call this
    // after fixing item records, before re-submitting.
    const recheckBins = async () => {
        const uniqueItemIds = [...new Set(allBagEntries.map(e => String(e.itemId)))];
        if (!uniqueItemIds.length) { alert('No bags have been added yet.'); return; }

        // Clear cached results so lookupPreferredBin fetches fresh data
        uniqueItemIds.forEach(id => { delete perItemBinMap[id]; });

        await Promise.all(uniqueItemIds.map(id => lookupPreferredBin(id)));

        const stillMissing = uniqueItemIds.filter(id => !perItemBinMap[id]);
        if (stillMissing.length) {
            showBinErrorBanner(stillMissing);
        } else {
            const existing = document.getElementById('custpage_bin_error_banner');
            if (existing) existing.remove();
            alert('✅ All items now have a preferred bin. You can submit the form.');
        }
    };

    // ─── saveRecord ───────────────────────────────────────────────────────────
    // Hard stop — blocks submission if any item in allBagEntries has no resolved
    // preferred bin. The form never navigates away so all bag data is preserved.
    // The user fixes bins in other tabs, clicks Re-check Preferred Bins, then
    // resubmits.
    const saveRecord = (context) => {
        const uniqueItemIds   = [...new Set(allBagEntries.map(e => String(e.itemId)))];
        const itemsMissingBin = uniqueItemIds.filter(id => !perItemBinMap[id]);

        if (itemsMissingBin.length) {
            showBinErrorBanner(itemsMissingBin);
            return false; // hard stop — form stays open, all data intact
        }

        // All bins resolved — clear any leftover error banner and allow submit
        const existing = document.getElementById('custpage_bin_error_banner');
        if (existing) existing.remove();

        return true;
    };

    return {
        pageInit,
        fieldChanged,
        saveRecord,
        recheckBins,
        addNewBag,
        getWeight,
        clearBagEntry,
        showSummary,
        recalculateRemaining,
        validateDelete,
        sublistChanged
    };
});

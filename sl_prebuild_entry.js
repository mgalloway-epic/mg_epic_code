/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * Script:      sl_prebuild_entry.js
 * Description: Pre-Build Weigh-In Suitelet. Renders a form showing all
 *              BS/MX lot-tracked components on the Work Order BOM.
 *              Supervisor enters the scale weight for each lot before
 *              the Assembly Build is created. On submit:
 *                1. Looks up current on-hand qty for each lot
 *                2. Calculates adjustment qty (pre-build weight - on-hand)
 *                3. Creates Inventory Adjustment to reconcile on-hand
 *                4. Saves a customrecord_prebuild_entry per lot
 *
 * Deployment:  Script ID:     customscript_sl_prebuild_entry
 *              Deployment ID: customdeploy_sl_prebuild_entry
 *
 * Script Parameters:
 *   custscript_sl_prebuild_gl_account (Integer) — GL account for weight adjustments
 *
 * FIXES APPLIED:
 *
 *  1. validateForm uses totalRows (actual rendered lot rows) instead of rows.length.
 *
 *  2. All search.Result.getValue()/getText() calls reuse the same Column object
 *     that was passed into search.create(). Creating a fresh search.createColumn()
 *     inside a forEach doesn't match the search's column list and causes NetSuite
 *     to return a raw ScriptNullObjectAdapter. All getValue results are also guarded
 *     with typeof === 'string' so stray adapters are silently discarded.
 *
 *  3. getLotsForItem now does ONE batch bin search for all lots instead of one
 *     search per lot. The previous per-lot approach triggered "Script Execution
 *     Usage Limit Exceeded" when a component had many lots. That governance failure
 *     caused subsequent getValue() calls to return ScriptNullObjectAdapters (truthy,
 *     so || '' fallbacks didn't help), which ended up rendered verbatim in the page.
 *
 *     Old cost: 1 lot-search + N*(1 bin-balance + 1 bin-id) searches per item
 *     New cost: 1 lot-search + 1 bin-balance + 1 bin-id search per item  (flat)
 *
 *  4. All three getRange({ start: 0, end: N }) calls in getLotsForItem replaced
 *     with .each() so that all lots are retrieved regardless of count. The previous
 *     hard caps (100 for lots, 200 for bin balance/bin ID) caused items with more
 *     than 100 lots (e.g. 323 lots) to only return a partial set, and lexicographic
 *     sort ordering meant lots like NO1623-100 through NO1623-199 appeared instead
 *     of NO1623-1 through NO1623-99.
 */
define(['N/record', 'N/search', 'N/runtime', 'N/log', 'N/url'],
function (record, search, runtime, log, url) {

    function onRequest(context) {
        context.request.method === 'GET' ? handleGet(context) : handlePost(context);
    }

    // -------------------------------------------------------------------------
    // GET — Render Form
    // -------------------------------------------------------------------------
    function handleGet(context) {
        const woId       = context.request.parameters.woid;
        const selLotIds  = context.request.parameters.sellots ? context.request.parameters.sellots.split(',') : [];
        const selWeights = context.request.parameters.weights ? context.request.parameters.weights.split(',') : [];
        if (!woId) { context.response.write(errorPage('No Work Order ID was provided.')); return; }

        try {
            const woRec    = record.load({ type: 'workorder', id: woId });
            const woNumber = woRec.getValue({ fieldId: 'tranid' });
            const locId    = woRec.getValue({ fieldId: 'location' });

            const bomRevId = woRec.getValue({ fieldId: 'billofmaterialsrevision' });
            if (!bomRevId) {
                context.response.write(errorPage('No BOM Revision found on Work Order ' + woNumber + '.'));
                return;
            }

            const bomComponents = [];
            const allComponents = [];

            let sublistId = 'item';
            let lineCount = woRec.getLineCount({ sublistId: 'item' });
            if (lineCount === 0) {
                lineCount  = woRec.getLineCount({ sublistId: 'component' });
                sublistId  = 'component';
            }

            const locIdForLog = woRec.getValue({ fieldId: 'location' }) || 'none';
            log.debug({ title: 'WO sublist', details: 'sublistId=' + sublistId + ' lineCount=' + lineCount + ' locationId=' + locIdForLog });

            for (let c = 0; c < lineCount; c++) {
                let itemId = String(woRec.getSublistValue({ sublistId: sublistId, fieldId: 'item',   line: c }) || '');
                if (!itemId) itemId = String(woRec.getSublistValue({ sublistId: sublistId, fieldId: 'itemid', line: c }) || '');
                const qty = parseFloat(woRec.getSublistValue({ sublistId: sublistId, fieldId: 'quantity', line: c })) || 0;
                log.debug({ title: 'WO component line ' + c, details: 'itemId=' + itemId + ' qty=' + qty });
                if (itemId) allComponents.push({ itemId, qty });
            }

            if (allComponents.length > 0) {
                const itemIds      = [...new Set(allComponents.map(function (c) { return c.itemId; }))];
                const colItemName  = search.createColumn({ name: 'itemid' });
                const colStockUnit = search.createColumn({ name: 'stockunit' });
                const itemNameMap  = {};
                const itemUomMap   = {};
                search.create({
                    type:    search.Type.ITEM,
                    filters: [['internalid', 'anyof', itemIds]],
                    columns: [ search.createColumn({ name: 'internalid' }), colItemName, colStockUnit ]
                }).run().each(function (r) {
                    const v = r.getValue(colItemName);
                    itemNameMap[r.id] = (v && typeof v === 'string') ? v : String(r.id);
                    const u = r.getText(colStockUnit);
                    itemUomMap[r.id]  = (u && typeof u === 'string') ? u : '';
                    return true;
                });

                itemIds.forEach(function (itemId) {
                    const itemName = itemNameMap[itemId] || itemId;
                    const prefix   = typeof itemName === 'string' ? itemName.substring(0, 2).toUpperCase() : '';
                    if (prefix === 'BS' || prefix === 'MX') {
                        const comp = allComponents.find(function (c) { return c.itemId === itemId; });
                        bomComponents.push({ itemId: itemId, itemName, uom: itemUomMap[itemId] || '', qty: comp ? comp.qty : 0 });
                    }
                });

                log.debug({ title: 'BOM components found', details: bomComponents.map(function(c){return c.itemName;}).join(', ') });
            }

            if (!bomComponents.length) {
                context.response.write(errorPage('No BS or MX lot-tracked components found on the BOM for Work Order ' + woNumber + '.'));
                return;
            }

            const rows = [];
            bomComponents.forEach(function (comp) {
                const lots = getLotsForItem(comp.itemId, locId);
                if (!lots.length) {
                    rows.push({ itemId: comp.itemId, itemName: comp.itemName, uom: comp.uom, bomQty: comp.qty,
                                lotId: '', lotText: 'No lots found', binId: '', binName: '', onHand: 0, lots: [] });
                } else {
                    rows.push({ itemId: comp.itemId, itemName: comp.itemName, uom: comp.uom, bomQty: comp.qty,
                                lotId: lots[0].id, lotText: lots[0].text, binId: lots[0].binId,
                                binName: lots[0].binName, onHand: lots[0].onHand, lots: lots });
                }
            });

            const history = getPrebuildHistory(woId);

            const seenRowItems = {};
            const dedupedRows  = rows.filter(function (r) {
                if (seenRowItems[r.itemId]) return false;
                seenRowItems[r.itemId] = true;
                return true;
            });

            context.response.write(renderForm(woId, woNumber, dedupedRows, history, selLotIds, selWeights));

        } catch (e) {
            log.error({ title: 'sl_prebuild GET Error', details: e.message + '\n' + (e.stack || '') });
            context.response.write(errorPage('An unexpected error occurred: ' + e.message));
        }
    }

    // -------------------------------------------------------------------------
    // POST — Process Submission
    // -------------------------------------------------------------------------
    function handlePost(context) {
        const params     = context.request.parameters;
        const woId       = params.wo_id;
        const rowCount   = parseInt(params.row_count, 10);
        const submitTime = new Date();

        const glAccountId = parseInt(
            runtime.getCurrentScript().getParameter({ name: 'custscript_sl_prebuild_gl_account' }), 10
        );

        if (!glAccountId) {
            context.response.write(errorPage('Script parameter custscript_sl_prebuild_gl_account is not configured yet. Please contact your administrator.'));
            return;
        }

        const woLookup     = search.lookupFields({ type: 'workorder', id: woId, columns: ['subsidiary', 'location', 'tranid'] });
        const subsidiaryId = woLookup.subsidiary && woLookup.subsidiary[0] ? parseInt(woLookup.subsidiary[0].value, 10) : null;
        const locationId   = woLookup.location   && woLookup.location[0]   ? parseInt(woLookup.location[0].value,   10) : null;
        const woNumber     = woLookup.tranid || woId;

        const errors = [];

        for (let i = 0; i < rowCount; i++) {
            const preBuildWeight = parseFloat(params['prebuild_weight_' + i]);
            if (isNaN(preBuildWeight) || preBuildWeight <= 0) continue;

            const itemId   = parseInt(params['item_id_'   + i], 10);
            const itemName = params['item_name_' + i] || '';
            const lotText  = params['lot_text_'  + i] || '';
            const binId    = parseInt(params['bin_id_'    + i], 10) || null;
            const onHand   = parseFloat(params['on_hand_' + i]) || 0;

            let lotId = parseInt(params['lot_id_' + i], 10) || 0;
            if (!lotId && lotText) {
                const lotLookup = search.create({
                    type:    'inventorynumber',
                    filters: [['inventorynumber', 'is', lotText]],
                    columns: ['internalid']
                }).run().getRange({ start: 0, end: 1 });
                if (lotLookup.length > 0) lotId = parseInt(lotLookup[0].id, 10);
            }
            log.debug({ title: 'POST lot resolve', details: 'lotText=' + lotText + ' lotId=' + lotId });

            const adjQty = preBuildWeight - onHand;

            if (adjQty === 0) {
                try {
                    savePrebuildRecord(woId, woNumber, itemId, itemName, lotId, lotText, binId, locationId, subsidiaryId, preBuildWeight, onHand, 0, null, submitTime);
                } catch (e) { errors.push(itemName + ' (lot ' + lotText + '): ' + e.message); }
                continue;
            }

            try {
                const invAdj = record.create({ type: record.Type.INVENTORY_ADJUSTMENT, isDynamic: true });
                if (subsidiaryId) invAdj.setValue({ fieldId: 'subsidiary',   value: subsidiaryId });
                invAdj.setValue({ fieldId: 'account',     value: glAccountId });
                invAdj.setValue({ fieldId: 'adjlocation', value: locationId });
                invAdj.setValue({ fieldId: 'trandate',    value: submitTime });
                invAdj.setValue({ fieldId: 'memo',        value: 'Pre-Build Weigh-In | WO: ' + woNumber + ' | ' + itemName + ' | Lot: ' + lotText });

                invAdj.selectNewLine({ sublistId: 'inventory' });
                invAdj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'item',        value: itemId });
                invAdj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'location',    value: locationId });
                invAdj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', value: adjQty });

                const invDetail = invAdj.getCurrentSublistSubrecord({ sublistId: 'inventory', fieldId: 'inventorydetail' });
                invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
                if (adjQty > 0) {
                    invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'receiptinventorynumber', value: lotText });
                } else {
                    invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'issueinventorynumber', value: lotId });
                }
                // Only set binnumber if a valid non-zero bin ID exists — passing 0 or NaN throws "Invalid Field Value 0 for field: binnumber"
                if (binId) {
                    invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: binId });
                }
                invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity',  value: adjQty > 0 ? Math.abs(adjQty) : -Math.abs(adjQty) });
                invDetail.commitLine({ sublistId: 'inventoryassignment' });
                invAdj.commitLine({ sublistId: 'inventory' });
                const adjId = invAdj.save();

                log.audit({ title: 'Pre-Build Adjustment Created', details: 'Adj ID: ' + adjId + ' | Item: ' + itemName + ' | Lot: ' + lotText + ' | AdjQty: ' + adjQty });
                savePrebuildRecord(woId, woNumber, itemId, itemName, lotId, lotText, binId, locationId, subsidiaryId, preBuildWeight, onHand, adjQty, adjId, submitTime);

            } catch (e) {
                log.error({ title: 'Pre-Build Error row ' + i, details: e.message });
                errors.push(itemName + ' (lot ' + lotText + '): ' + e.message);
            }
        }

        if (errors.length > 0) {
            context.response.write(errorPage('The following lines failed:\n\n' + errors.join('\n')));
            return;
        }
        context.response.write(successPage(woId, woNumber));
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function savePrebuildRecord(woId, woNumber, itemId, itemName, lotId, lotText, binId, locationId, subsidiaryId, preBuildWeight, onHand, adjQty, adjId, submitTime) {
        const rec = record.create({ type: 'customrecord_prebuild_entry' });
        rec.setValue({ fieldId: 'name',                             value: woNumber + ' | ' + itemName + ' | ' + lotText + ' | ' + formatDateTime(submitTime) });
        rec.setValue({ fieldId: 'custrecord_prebuild_wo',           value: parseInt(woId, 10) });
        rec.setValue({ fieldId: 'custrecord_prebuild_item',         value: itemId });
        rec.setValue({ fieldId: 'custrecord_prebuild_lot_text',     value: lotText });
        rec.setValue({ fieldId: 'custrecord_prebuild_lot_id',       value: lotId });
        rec.setValue({ fieldId: 'custrecord_prebuild_weight',       value: preBuildWeight });
        rec.setValue({ fieldId: 'custrecord_prebuild_on_hand',      value: onHand });
        rec.setValue({ fieldId: 'custrecord_prebuild_adj_qty',      value: adjQty });
        rec.setValue({ fieldId: 'custrecord_prebuild_bin',          value: binId || null });
        rec.setValue({ fieldId: 'custrecord_prebuild_location',     value: locationId });
        rec.setValue({ fieldId: 'custrecord_prebuild_subsidiary',   value: subsidiaryId });
        rec.setValue({ fieldId: 'custrecord_prebuild_inv_adj',      value: adjId || null });
        rec.setValue({ fieldId: 'custrecord_prebuild_submitted_at', value: submitTime });
        rec.save();
    }

    /**
     * Returns all on-hand lots for itemId at locationId, each with bin info.
     *
     * GOVERNANCE: flat cost of 3 searches regardless of how many lots exist.
     *   1. inventorynumber search  — get all lots
     *   2. inventorybalance search — get bin names for ALL lots in one call
     *   3. bin search              — get bin IDs for all unique bin names in one call
     *
     * Previously steps 2+3 ran inside a per-lot forEach, costing 2*N searches and
     * triggering "Script Execution Usage Limit Exceeded" for work orders with many lots.
     *
     * FIX: All three searches now use .each() instead of getRange({ start, end }) so
     * that every lot is returned regardless of count. The previous hard caps of 100
     * (lots) and 200 (bin balance / bin ID) caused partial results for items with
     * more than 100 lots. NetSuite's .each() supports up to 4,000 rows.
     */
    function getLotsForItem(itemId, locationId) {
        const lots = [];
        try {
            // ── Step 1: get ALL on-hand lots using .each() ───────────────────────────
            const lotFilters = [
                ['item', 'anyof', itemId],
                'AND',
                ['quantityonhand', 'greaterthan', 0]
            ];
            if (locationId) {
                lotFilters.push('AND');
                lotFilters.push(['location', 'anyof', locationId]);
            }

            const colLotNum = search.createColumn({ name: 'inventorynumber' });
            const colOnHand = search.createColumn({ name: 'quantityonhand' });

            const lotIds = [];
            search.create({
                type:    'inventorynumber',
                filters: lotFilters,
                columns: [ search.createColumn({ name: 'internalid' }), colLotNum, colOnHand ]
            }).run().each(function (r) {
                const lotId   = String(r.id || '');
                const rawText = r.getValue(colLotNum);
                const lotText = (rawText && typeof rawText === 'string') ? rawText : '';
                const onHand  = parseFloat(r.getValue(colOnHand)) || 0;
                if (lotId && !lots.some(function (l) { return l.id === lotId; })) {
                    lots.push({ id: lotId, text: lotText, binId: '', binName: '', onHand: onHand });
                    lotIds.push(lotId);
                }
                return true; // must return true to continue iteration
            });

            log.debug({ title: 'getLotsForItem', details: 'itemId=' + itemId + ' locationId=' + locationId + ' lots=' + lots.length });

            if (!lotIds.length) return lots;

            // ── Step 2: batch bin-name lookup for ALL lots using .each() ─────────────
            try {
                const binBalFilters = [
                    ['inventorynumber', 'anyof', lotIds],
                    'AND',
                    ['item', 'anyof', itemId]
                ];
                if (locationId) {
                    binBalFilters.push('AND');
                    binBalFilters.push(['location', 'anyof', locationId]);
                }

                const colBalLot  = search.createColumn({ name: 'inventorynumber' });
                const colBinName = search.createColumn({ name: 'binnumber' });

                // Build lotId → binName map
                const lotToBinName = {};
                search.create({
                    type:    'inventorybalance',
                    filters: binBalFilters,
                    columns: [ colBalLot, colBinName ]
                }).run().each(function (br) {
                    const rawLot = br.getValue(colBalLot);
                    const lotKey = (rawLot  && typeof rawLot  === 'string') ? rawLot  : '';
                    const rawTxt = br.getText(colBinName);
                    const rawVal = br.getValue(colBinName);
                    const bName  = (rawTxt && typeof rawTxt === 'string') ? rawTxt
                                 : (rawVal && typeof rawVal === 'string') ? rawVal
                                 : '';
                    if (lotKey && bName && !lotToBinName[lotKey]) {
                        lotToBinName[lotKey] = bName;
                    }
                    return true;
                });

                log.debug({ title: 'batch bin lookup', details: 'lotToBinName keys=' + Object.keys(lotToBinName).length });

                // ── Step 3: batch bin-ID lookup for unique bin names using .each() ────
                const uniqueBinNames = [];
                Object.keys(lotToBinName).forEach(function (k) {
                    const bn = lotToBinName[k];
                    if (bn && uniqueBinNames.indexOf(bn) === -1) uniqueBinNames.push(bn);
                });

                const binNameToId = {};
                if (uniqueBinNames.length && locationId) {
                    const colBinIdF  = search.createColumn({ name: 'internalid' });
                    const colBinNumF = search.createColumn({ name: 'binnumber' });
                    search.create({
                        type:    'bin',
                        filters: [ ['binnumber', 'anyof', uniqueBinNames], 'AND', ['location', 'anyof', locationId] ],
                        columns: [ colBinIdF, colBinNumF ]
                    }).run().each(function (bir) {
                        const bNum = bir.getValue(colBinNumF);
                        if (bNum && typeof bNum === 'string') {
                            binNameToId[bNum] = String(bir.id || '');
                        }
                        return true;
                    });
                }

                // Apply bin data back to each lot
                lots.forEach(function (lot) {
                    const bName = lotToBinName[lot.id] || '';
                    lot.binName = bName;
                    lot.binId   = bName ? (binNameToId[bName] || '') : '';
                });

            } catch (e2) {
                log.error({ title: 'batch bin lookup failed', details: e2.message });
                // Lots are still returned, just without bin info — form still renders
            }

        } catch (e) {
            log.error({ title: 'getLotsForItem failed', details: e.message });
        }
        return lots;
    }

    function getPrebuildHistory(woId) {
        const history = [];
        try {
            const colName  = search.createColumn({ name: 'name' });
            const colItem  = search.createColumn({ name: 'custrecord_prebuild_item' });
            const colLot   = search.createColumn({ name: 'custrecord_prebuild_lot_text' });
            const colWt    = search.createColumn({ name: 'custrecord_prebuild_weight' });
            const colOH    = search.createColumn({ name: 'custrecord_prebuild_on_hand' });
            const colAdj   = search.createColumn({ name: 'custrecord_prebuild_adj_qty' });
            const colSubAt = search.createColumn({ name: 'custrecord_prebuild_submitted_at' });
            search.create({
                type:    'customrecord_prebuild_entry',
                filters: [['custrecord_prebuild_wo', 'anyof', woId]],
                columns: [ colName, colItem, colLot, colWt, colOH, colAdj, colSubAt ]
            }).run().each(function (r) {
                history.push({
                    name:        r.getValue(colName)  || '',
                    item:        r.getText(colItem)   || '',
                    lot:         r.getValue(colLot)   || '',
                    weight:      r.getValue(colWt)    || 0,
                    onHand:      r.getValue(colOH)    || 0,
                    adjQty:      r.getValue(colAdj)   || 0,
                    submittedAt: r.getValue(colSubAt) || ''
                });
                return true;
            });
        } catch (e) { /* no history yet */ }
        return history;
    }

    function formatDateTime(d) {
        return (d.getMonth()+1) + '/' + d.getDate() + '/' + d.getFullYear() + ' ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2,'0');
    }

    // -------------------------------------------------------------------------
    // Render Form
    // -------------------------------------------------------------------------
    function renderForm(woId, woNumber, rows, history, selLotIds, selWeights) {
        selLotIds  = selLotIds  || [];
        selWeights = selWeights || [];
        const postUrl = url.resolveScript({ scriptId: 'customscript_sl_prebuild_entry', deploymentId: 'customdeploy_sl_prebuild_entry' });

        let tableRows = '';
        let rowIndex  = 0;

        rows.forEach(function (row) {
            if (!row.lots || row.lots.length === 0) {
                tableRows +=
                    '<tr class="' + (rowIndex % 2 === 0 ? 'row-even' : 'row-odd') + '" data-lot="">' +
                    '<td class="td-item">' + esc(row.itemName) + '</td>' +
                    '<td class="td-lot muted">No lots found</td>' +
                    '<td class="td-bin muted">—</td>' +
                    '<td class="td-qty right muted">—</td>' +
                    '<td class="td-weight"><span class="muted">No lot available</span></td>' +
                    '<td class="td-uom muted">—</td>' +
                    '</tr>' +
                    '<input type="hidden" name="item_id_'   + rowIndex + '" value="' + esc(row.itemId)   + '" />' +
                    '<input type="hidden" name="item_name_' + rowIndex + '" value="' + esc(row.itemName) + '" />' +
                    '<input type="hidden" name="lot_id_'    + rowIndex + '" value="" />' +
                    '<input type="hidden" name="lot_text_'  + rowIndex + '" value="" />' +
                    '<input type="hidden" name="bin_id_'    + rowIndex + '" value="" />' +
                    '<input type="hidden" name="on_hand_'   + rowIndex + '" value="0" />';
                rowIndex++;
                return;
            }
            row.lots.forEach(function (lot) {
                const rowClass = rowIndex % 2 === 0 ? 'row-even' : 'row-odd';
                tableRows +=
                    '<tr class="' + rowClass + '" data-lot="' + esc(lot.text) + '">' +
                    '<td class="td-item">'      + esc(row.itemName)       + '</td>' +
                    '<td class="td-lot">'       + esc(lot.text)           + '</td>' +
                    '<td class="td-bin">'       + esc(lot.binName || '—') + '</td>' +
                    '<td class="td-qty right">' + esc(lot.onHand)         + '</td>' +
                    '<td class="td-weight"><input type="number" name="prebuild_weight_' + rowIndex + '" min="0" step="0.001" class="field-num" placeholder="0.000" /></td>' +
                    '<td class="td-uom">'       + esc(row.uom || '—')    + '</td>' +
                    '</tr>' +
                    '<input type="hidden" name="item_id_'   + rowIndex + '" value="' + esc(row.itemId)   + '" />' +
                    '<input type="hidden" name="item_name_' + rowIndex + '" value="' + esc(row.itemName) + '" />' +
                    '<input type="hidden" name="lot_id_'    + rowIndex + '" value="' + esc(lot.id)       + '" />' +
                    '<input type="hidden" name="lot_text_'  + rowIndex + '" value="' + esc(lot.text)     + '" />' +
                    '<input type="hidden" name="bin_id_'    + rowIndex + '" value="' + esc(lot.binId)    + '" />' +
                    '<input type="hidden" name="on_hand_'   + rowIndex + '" value="' + esc(lot.onHand)   + '" />';
                rowIndex++;
            });
        });

        const totalRows = rowIndex;

        let historyHtml = '';
        if (history.length > 0) {
            let histRows = '';
            history.forEach(function (h) {
                const adjClass = parseFloat(h.adjQty) > 0 ? 'adj-pos' : (parseFloat(h.adjQty) < 0 ? 'adj-neg' : '');
                histRows +=
                    '<tr><td>' + esc(h.item) + '</td><td>' + esc(h.lot) + '</td>' +
                    '<td class="right">' + esc(h.onHand) + '</td>' +
                    '<td class="right">' + esc(h.weight) + '</td>' +
                    '<td class="right ' + adjClass + '">' + (parseFloat(h.adjQty) > 0 ? '+' : '') + esc(h.adjQty) + '</td>' +
                    '<td>' + esc(h.submittedAt) + '</td></tr>';
            });
            historyHtml =
                '<div class="section-title">Previous Submissions</div>' +
                '<table><thead><tr>' +
                '<th>Item</th><th>Lot</th><th style="text-align:right;">On-Hand at Weigh-In</th><th style="text-align:right;">Pre-Build Weight</th><th style="text-align:right;">Adjustment</th><th>Submitted At</th>' +
                '</tr></thead><tbody>' + histRows + '</tbody></table>';
        }

        return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pre-Build Weigh-In — ' + esc(woNumber) + '</title>' +
            '<style>' +
            '*, *::before, *::after { box-sizing: border-box; }' +
            'body { margin: 0; background: #f5f7f9; font-family: Arial, sans-serif; font-size: 12px; color: #333; }' +
            /* Page title bar */
            '.page-header { background: #fff; border-bottom: 2px solid #c8d2e0; padding: 12px 20px; }' +
            '.page-header h1 { margin: 0 0 3px; font-size: 15px; font-weight: bold; color: #1f1f1f; letter-spacing: .01em; }' +
            '.page-header .wo-ref { font-size: 11px; color: #666; }' +
            '.page-header .wo-ref span { color: #1778c5; font-weight: bold; }' +
            /* Toolbar */
            '.btn-bar { background: #edf1f7; border-bottom: 1px solid #c0cad8; padding: 6px 20px; display: flex; gap: 8px; align-items: center; }' +
            /* NS blue primary button */
            '.btn-primary { background: #1778c5; color: #fff; border: 1px solid #1060a3; padding: 5px 22px; font-size: 12px; font-weight: bold; cursor: pointer; border-radius: 2px; white-space: nowrap; line-height: 1.6; }' +
            '.btn-primary:hover { background: #1464a8; }' +
            /* NS cancel button */
            '.btn-secondary { background: #fff; color: #444; border: 1px solid #aaa; padding: 5px 16px; font-size: 12px; cursor: pointer; border-radius: 2px; white-space: nowrap; line-height: 1.6; }' +
            '.btn-secondary:hover { background: #f4f6f9; }' +
            '.page-body { padding: 16px 20px; }' +
            '.hint { font-size: 11px; color: #666; margin-bottom: 14px; line-height: 1.65; max-width: 820px; }' +
            /* Table */
            'table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #b4bece; }' +
            'th { background: #c5d0e0; color: #2a2a2a; padding: 7px 12px; text-align: left; font-size: 11px; font-weight: bold; border: 1px solid #a2b0c4; vertical-align: top; }' +
            'td { padding: 6px 12px; border-bottom: 1px solid #dde3ed; border-right: 1px solid #dde3ed; vertical-align: middle; font-size: 12px; }' +
            /* Alternating rows — white / very subtle blue tint */
            '.row-even td { background: #fff; }' +
            '.row-odd  td { background: #f3f6fb; }' +
            '.td-item { min-width: 180px; } .td-lot { min-width: 160px; } .td-bin { min-width: 100px; }' +
            '.td-qty { min-width: 130px; } .td-weight { min-width: 140px; } .td-uom { min-width: 60px; color: #555; }' +
            '.right { text-align: right; }' +
            '.muted { color: #aaa; font-style: italic; }' +
            '.adj-pos { color: #1a6e1a; font-weight: bold; }' +
            '.adj-neg { color: #b30000; font-weight: bold; }' +
            /* Number input */
            '.field-num { width: 110px; padding: 4px 7px; border: 1px solid #aaa; font-size: 12px; text-align: right; background: #fff; transition: border-color .15s; }' +
            '.field-num:focus { border-color: #1778c5; outline: none; box-shadow: inset 0 1px 2px rgba(0,0,0,.07); }' +
            /* Lot search in header */
            '.lot-search-wrap { position: relative; margin-top: 6px; }' +
            '.lot-search-wrap::before { content: "\\1F50D"; position: absolute; left: 6px; top: 50%; transform: translateY(-50%); font-size: 10px; pointer-events: none; opacity: .45; }' +
            '.lot-search { width: 100%; padding: 4px 7px 4px 22px; border: 1px solid #aaa; font-size: 11px; font-weight: normal; letter-spacing: 0; text-transform: none; color: #333; background: #fff; transition: border-color .15s; }' +
            '.lot-search:focus { border-color: #1778c5; outline: none; }' +
            '.lot-search::placeholder { color: #bbb; font-style: italic; }' +
            '.no-match-msg { display: none; padding: 14px; text-align: center; color: #999; font-style: italic; font-size: 12px; background: #fff; border: 1px solid #b4bece; border-top: none; }' +
            /* Section label */
            '.section-title { margin: 24px 0 9px; font-size: 11px; font-weight: bold; color: #555; border-bottom: 1px solid #c8d2e0; padding-bottom: 5px; text-transform: uppercase; letter-spacing: .06em; }' +
            '</style></head><body>' +
            /* Page title - NS record header style */
            '<div class="page-header">' +
                '<h1>Pre-Build Weigh-In</h1>' +
                '<div class="wo-ref">Work Order: <span>' + esc(woNumber) + '</span></div>' +
            '</div>' +
            /* NS-style toolbar with action buttons at the top */
            '<div class="btn-bar">' +
                '<button type="submit" form="prebuildForm" class="btn-primary">Submit Weigh-In</button>' +
                '<button type="button" class="btn-secondary" onclick="window.close();">Cancel</button>' +
            '</div>' +
            '<div class="page-body">' +
            '<p class="hint">Enter the scale weight for each bulk seed lot before starting the build. An inventory adjustment will be posted immediately to reconcile any humidity gain or loss. Leave any lot blank to skip it.</p>' +
            '<form id="prebuildForm" method="POST" action="' + esc(postUrl) + '" onsubmit="return validateForm();">' +
            '<input type="hidden" name="wo_id"     value="' + esc(woId)     + '" />' +
            '<input type="hidden" name="row_count" value="' + esc(totalRows) + '" />' +
            '<table id="lotTable"><thead><tr>' +
            '<th>Item</th>' +
            '<th>Lot Number' +
                '<div class="lot-search-wrap">' +
                    '<input type="text" id="lotSearch" class="lot-search" placeholder="Search lots…" oninput="filterLots(this.value);" autocomplete="off" />' +
                '</div>' +
            '</th>' +
            '<th>Bin</th><th style="text-align:right;">Current On-Hand Qty</th><th>Pre-Build Weight</th><th>UOM</th>' +
            '</tr></thead><tbody id="lotTbody">' + tableRows + '</tbody></table>' +
            '<div id="noMatchMsg" class="no-match-msg">No lots match your search.</div>' +
            '</form>' +
            historyHtml +
            '</div>' +
            '<script>' +
            'function filterLots(q){' +
                'q=q.trim().toLowerCase();' +
                'var rows=document.querySelectorAll("#lotTbody tr");' +
                'var visible=0;' +
                'rows.forEach(function(row){' +
                    'var lot=(row.getAttribute("data-lot")||"").toLowerCase();' +
                    'var show=!q||lot.indexOf(q)!==-1;' +
                    'row.style.display=show?"":"none";' +
                    'if(show)visible++;' +
                '});' +
                'document.getElementById("noMatchMsg").style.display=(q&&visible===0)?"block":"none";' +
            '}' +
            'function validateForm(){var n=' + totalRows + ',h=false;for(var i=0;i<n;i++){var w=document.querySelector("[name=\'prebuild_weight_"+i+"\']");if(w&&parseFloat(w.value)>0){h=true;break;}}if(!h){alert("Please enter a Pre-Build Weight for at least one lot.");return false;}return true;}' +
            '<\/script>' +
            '</body></html>';
    }

    function esc(s) { if (s == null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    function successPage(woId, woNumber) {
        const woUrl = '/app/accounting/transactions/workord.nl?id=' + woId;
        return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3;url=' + woUrl + '"><style>*{box-sizing:border-box;font-family:Arial,sans-serif;}body{background:#f5f7f9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}.card{background:#fff;border:1px solid #c8d2e0;padding:40px 36px;text-align:center;max-width:400px;width:100%;}.icon{font-size:42px;color:#1778c5;margin-bottom:8px;}h2{color:#1f1f1f;margin:0 0 8px;font-size:16px;}p{color:#666;margin:4px 0;font-size:12px;}a{display:inline-block;margin-top:20px;background:#1778c5;color:#fff;text-decoration:none;padding:6px 20px;font-size:12px;font-weight:bold;border:1px solid #1060a3;border-radius:2px;}</style></head><body><div class="card"><div class="icon">&#10003;</div><h2>Weigh-In Submitted</h2><p>Inventory adjustment posted.</p><p style="color:#999;margin-top:8px;">Redirecting to WO ' + esc(woNumber) + '&#8230;</p><a href="' + woUrl + '">Go to Work Order Now</a></div></body></html>';
    }

    function errorPage(msg) {
        return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box;font-family:Arial,sans-serif;}body{background:#f5f7f9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}.card{background:#fff;border:1px solid #c8d2e0;padding:36px;text-align:center;max-width:480px;width:100%;}.icon{font-size:36px;color:#b30000;margin-bottom:8px;}h2{color:#1f1f1f;margin:0 0 8px;font-size:15px;}p{color:#555;white-space:pre-wrap;text-align:left;font-size:12px;background:#fff5f5;border:1px solid #e0b0b0;padding:10px;margin-top:10px;}button{margin-top:18px;background:#1778c5;color:#fff;border:1px solid #1060a3;padding:5px 18px;font-size:12px;font-weight:bold;cursor:pointer;border-radius:2px;}</style></head><body><div class="card"><div class="icon">&#10007;</div><h2>Something went wrong</h2><p>' + esc(msg) + '</p><button onclick="window.history.back();">Go Back &amp; Fix</button></div></body></html>';
    }

    return { onRequest };
});

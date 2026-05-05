/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * Script:      sl_scrap_entry.js
 * Deployment:  customscript_sl_scrap_entry / customdeploy_sl_scrap_entry
 * Parameter:   custscript_sl_scrap_gl_account (Integer) — GL 956
 */
define(['N/record', 'N/search', 'N/runtime', 'N/log', 'N/url'],
function (record, search, runtime, log, url) {

    function onRequest(context) {
        context.request.method === 'GET' ? handleGet(context) : handlePost(context);
    }

    // -------------------------------------------------------------------------
    // GET
    // -------------------------------------------------------------------------
    function handleGet(context) {
        const woId = context.request.parameters.woid;
        if (!woId) { context.response.write(errorPage('No Work Order ID was provided.')); return; }

        try {
            const woRec    = record.load({ type: 'workorder', id: woId });
            const woNumber = woRec.getValue({ fieldId: 'tranid' });

            // Get ALL assembly builds for this WO
            const allBuildIds = [];
            search.create({
                type:    'assemblybuild',
                filters: [['createdfrom', 'anyof', woId]],
                columns: [search.createColumn({ name: 'internalid' })]
            }).run().each(function (r) {
                allBuildIds.push(r.id);
                return true;
            });

            if (!allBuildIds.length) { context.response.write(errorPage('No Assembly Builds found for WO ' + woNumber + '.')); return; }

            // Look up most recent pre-build entry per lot for this WO
            const prebuildMap = {};
            try {
                search.create({
                    type:    'customrecord_prebuild_entry',
                    filters: [['custrecord_prebuild_wo', 'anyof', woId]],
                    columns: ['custrecord_prebuild_lot_id', 'custrecord_prebuild_weight', 'custrecord_prebuild_submitted_at']
                }).run().each(function (r) {
                    const lotId  = r.getValue('custrecord_prebuild_lot_id');
                    const weight = r.getValue('custrecord_prebuild_weight');
                    const ts     = r.getValue('custrecord_prebuild_submitted_at');
                    if (lotId && (!prebuildMap[lotId] || ts > prebuildMap[lotId].ts)) {
                        prebuildMap[lotId] = { weight: parseFloat(weight) || 0, ts };
                    }
                    return true;
                });
            } catch (e) {
                log.debug({ title: 'prebuildMap lookup failed', details: e.message });
            }

            // Pass 1: load every build once, collect component item IDs and raw lot/bin data
            const componentItemIdSet = {};
            const buildLineData      = [];

            allBuildIds.forEach(function (buildId) {
                const buildRec  = record.load({ type: 'assemblybuild', id: buildId, isDynamic: true });
                const lineCount = buildRec.getLineCount({ sublistId: 'component' });
                const lines     = [];

                for (let i = 0; i < lineCount; i++) {
                    const itemId  = String(buildRec.getSublistValue({ sublistId: 'component', fieldId: 'item',     line: i }));
                    const qtyUsed = buildRec.getSublistValue({         sublistId: 'component', fieldId: 'quantity', line: i }) || 0;
                    componentItemIdSet[itemId] = true;

                    buildRec.selectLine({ sublistId: 'component', line: i });
                    const { lots, bins } = extractLotsAndBins(buildRec, true);
                    lines.push({ itemId, qtyUsed, lots, bins });
                }
                buildLineData.push(lines);
            });

            // Item name and UOM lookup (one batch search across all builds)
            const componentItemIds = Object.keys(componentItemIdSet);
            const itemNameMap = {};
            const itemUomMap  = {};
            if (componentItemIds.length > 0) {
                const colItemName  = search.createColumn({ name: 'itemid' });
                const colStockUnit = search.createColumn({ name: 'stockunit' });
                search.create({
                    type:    search.Type.ITEM,
                    filters: [['internalid', 'anyof', componentItemIds]],
                    columns: [search.createColumn({ name: 'internalid' }), colItemName, colStockUnit]
                }).run().each(function (r) {
                    const v = r.getValue(colItemName);
                    itemNameMap[r.id] = (v && typeof v === 'string') ? v : String(r.id);
                    const u = r.getText(colStockUnit);
                    itemUomMap[r.id]  = (u && typeof u === 'string') ? u : '';
                    return true;
                });
            }

            log.debug({ title: 'allBuildIds', details: 'count=' + allBuildIds.length + ' ids=' + allBuildIds.join(',') });
            buildLineData.forEach(function (lines, bi) {
                lines.forEach(function (line) {
                    log.debug({ title: 'buildLine bi=' + bi, details: 'itemId=' + line.itemId + ' qtyUsed=' + line.qtyUsed + ' lots=' + line.lots.length });
                });
            });

            // Pass 2: build deduplicated rows across all builds
            // Key: itemId+'|'+lotId for lot-tracked, itemId+'|' for non-lot
            const rowMap = {};
            const epBuildSeen = {}; // prevents counting an EP item more than once per build

            buildLineData.forEach(function (lines, buildIndex) {
                lines.forEach(function (line) {
                    const itemId       = line.itemId;
                    const itemName     = itemNameMap[itemId] || itemId;
                    const uom          = itemUomMap[itemId]  || '';
                    const prefix       = (itemName || '').trim().substring(0, 2).toUpperCase();
                    const isLotTracked = prefix === 'BS' || prefix === 'MX';

                    log.debug({ title: 'Component ' + itemName, details: 'lots=' + line.lots.length + ' bins=' + line.bins.length });

                    if (isLotTracked && line.lots.length > 0) {
                        line.lots.forEach(function (lot) {
                            const key = itemId + '|' + lot.id;
                            if (!rowMap[key]) {
                                const prebuildWeight = prebuildMap[lot.id] ? prebuildMap[lot.id].weight : null;
                                rowMap[key] = {
                                    itemId, itemName, uom, isLotTracked: true, isAssembly: false,
                                    qtyUsed: lot.qty || line.qtyUsed, lotId: lot.id, lotText: lot.text,
                                    bins: line.bins,
                                    prebuildWeight,
                                    lockedBinId:   lot.binId   || '',
                                    lockedBinText: lot.binText || ''
                                };
                            }
                        });
                    } else if (!isLotTracked) {
                        // Only count this item once per build — the same EP line can repeat
                        // once for every BS/MX lot used in the same build component sublist
                        const buildKey = itemId + '|' + buildIndex;
                        if (epBuildSeen[buildKey]) return;
                        epBuildSeen[buildKey] = true;

                        const key = itemId + '|';
                        if (!rowMap[key]) {
                            rowMap[key] = {
                                itemId, itemName, uom, isLotTracked: false, isAssembly: false,
                                qtyUsed: line.qtyUsed, lotId: '', lotText: '',
                                bins: line.bins, prebuildWeight: null,
                                lockedBinId: '', lockedBinText: ''
                            };
                        } else {
                            rowMap[key].qtyUsed = (parseFloat(rowMap[key].qtyUsed) || 0) + (parseFloat(line.qtyUsed) || 0);
                        }
                    }
                });
            });

            // Sort: EP (non-lot) first, then BS/MX sorted by itemName then lotText
            const rows = Object.values(rowMap).sort(function (a, b) {
                if (a.isLotTracked !== b.isLotTracked) return a.isLotTracked ? 1 : -1;
                if (a.itemName !== b.itemName) return a.itemName < b.itemName ? -1 : 1;
                return a.lotText < b.lotText ? -1 : 1;
            });

            context.response.write(renderForm(woId, woNumber, rows));

        } catch (e) {
            log.error({ title: 'GET Error', details: e.message + '\n' + (e.stack || '') });
            context.response.write(errorPage('An unexpected error occurred: ' + e.message));
        }
    }

    // -------------------------------------------------------------------------
    // Extract lots and bins — called AFTER selectLine in dynamic mode
    // -------------------------------------------------------------------------
    function extractLotsAndBins(buildRec, isLotTracked) {
        const lots = [];
        const bins = [];

        const fieldIds = ['inventorydetail', 'componentinventorydetail'];

        for (let f = 0; f < fieldIds.length; f++) {
            const fieldId = fieldIds[f];
            try {
                const invDetail   = buildRec.getCurrentSublistSubrecord({ sublistId: 'component', fieldId: fieldId });
                const assignCount = invDetail.getLineCount({ sublistId: 'inventoryassignment' });

                log.debug({ title: 'invDetail fieldId=' + fieldId, details: 'assignCount=' + assignCount });

                for (let j = 0; j < assignCount; j++) {
                    const lotId   = invDetail.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'issueinventorynumber', line: j });
                    const lotText = invDetail.getSublistText({  sublistId: 'inventoryassignment', fieldId: 'issueinventorynumber', line: j }) || '';

                    let binId   = invDetail.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber',  line: j });
                    let binText = invDetail.getSublistText({  sublistId: 'inventoryassignment', fieldId: 'binnumber',  line: j }) || '';
                    if (!binId) {
                        binId   = invDetail.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumbers', line: j });
                        binText = invDetail.getSublistText({  sublistId: 'inventoryassignment', fieldId: 'binnumbers', line: j }) || '';
                    }

                    const lotQty = parseFloat(invDetail.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', line: j })) || 0;
                    if (lotId && isLotTracked) {
                        if (!lots.some(function (l) { return String(l.id) === String(lotId); })) {
                            lots.push({ id: String(lotId), text: lotText, qty: lotQty, binId: binId ? String(binId) : '', binText: binText });
                        }
                    }
                    if (binId) {
                        if (!bins.some(function (b) { return String(b.id) === String(binId); })) {
                            bins.push({ id: String(binId), name: binText });
                        }
                    }
                }
                if (lots.length > 0 || bins.length > 0) break;

            } catch (e) {
                log.debug({ title: 'getCurrentSublistSubrecord failed for fieldId=' + fieldId, details: e.message });
            }
        }

        return { lots, bins };
    }

    // Extract bins from the assembly header inventory detail subrecord
    function extractBinsFromSubrecord(buildRec) {
        const bins = [];
        try {
            const invDetail   = buildRec.getSubrecord({ fieldId: 'inventorydetail' });
            const assignCount = invDetail.getLineCount({ sublistId: 'inventoryassignment' });
            for (let j = 0; j < assignCount; j++) {
                let binId   = invDetail.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber',  line: j });
                let binText = invDetail.getSublistText({  sublistId: 'inventoryassignment', fieldId: 'binnumber',  line: j }) || '';
                if (!binId) {
                    binId   = invDetail.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumbers', line: j });
                    binText = invDetail.getSublistText({  sublistId: 'inventoryassignment', fieldId: 'binnumbers', line: j }) || '';
                }
                if (binId && !bins.some(function (b) { return String(b.id) === String(binId); })) {
                    bins.push({ id: String(binId), name: binText });
                }
            }
        } catch (e) {
            log.debug({ title: 'Assembly header inv detail failed', details: e.message });
        }
        return bins;
    }

    // -------------------------------------------------------------------------
    // POST
    // -------------------------------------------------------------------------
    function handlePost(context) {
        const params         = context.request.parameters;
        const woId           = params.wo_id;
        const rowCount       = parseInt(params.row_count, 10);
        const scrapAccountId = parseInt(runtime.getCurrentScript().getParameter({ name: 'custscript_sl_scrap_gl_account' }), 10);

        if (!scrapAccountId) { context.response.write(errorPage('custscript_sl_scrap_gl_account not configured.')); return; }

        const woLookup     = search.lookupFields({ type: 'workorder', id: woId, columns: ['subsidiary', 'location', 'tranid'] });
        const subsidiaryId = woLookup.subsidiary && woLookup.subsidiary[0] ? parseInt(woLookup.subsidiary[0].value, 10) : null;
        const locationId   = woLookup.location   && woLookup.location[0]   ? parseInt(woLookup.location[0].value,   10) : null;
        const woNumber     = woLookup.tranid || woId;
        const errors       = [];

        for (let i = 0; i < rowCount; i++) {
            const scrapQty = parseFloat(params['scrap_qty_' + i]) || 0;
            if (scrapQty <= 0) continue;

            const itemId       = parseInt(params['item_id_'        + i], 10);
            const itemName     = params['item_name_'    + i] || '';
            const lotId        = params['lot_id_'       + i] || '';
            const lotText      = params['lot_text_'     + i] || '';
            const binId        = parseInt(params['bin_id_'  + i], 10);
            const qtyUsed      = parseFloat(params['qty_used_' + i]) || 0;
            const isLotTracked = params['is_lot_tracked_' + i] === 'true';

            try {
                const invAdj = record.create({ type: record.Type.INVENTORY_ADJUSTMENT, isDynamic: true });
                if (subsidiaryId) invAdj.setValue({ fieldId: 'subsidiary',   value: subsidiaryId });
                invAdj.setValue({ fieldId: 'account',     value: scrapAccountId });
                invAdj.setValue({ fieldId: 'adjlocation', value: locationId });
                invAdj.setValue({ fieldId: 'trandate',    value: new Date() });
                invAdj.setValue({ fieldId: 'memo',        value: 'Scrap | WO: ' + woNumber + ' | ' + itemName });

                invAdj.selectNewLine({ sublistId: 'inventory' });
                invAdj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'item',        value: itemId });
                invAdj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'location',    value: locationId });
                invAdj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', value: -Math.abs(scrapQty) });

                if (binId) {
                    const invDetail = invAdj.getCurrentSublistSubrecord({ sublistId: 'inventory', fieldId: 'inventorydetail' });
                    invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
                    if (isLotTracked && lotId) {
                        invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'issueinventorynumber', value: parseInt(lotId, 10) });
                    }
                    invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: binId });
                    invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity',  value: -Math.abs(scrapQty) });
                    invDetail.commitLine({ sublistId: 'inventoryassignment' });
                }

                invAdj.commitLine({ sublistId: 'inventory' });
                const adjId = invAdj.save();

                const scrapLine = record.create({ type: 'customrecord_scrap_line' });
                scrapLine.setValue({ fieldId: 'name',                             value: woNumber + '-' + (i + 1) + '-' + itemName.substring(0, 20) });
                scrapLine.setValue({ fieldId: 'custrecord_scrap_line_wo',         value: parseInt(woId, 10) });
                scrapLine.setValue({ fieldId: 'custrecord_scrap_line_item',       value: itemId });
                scrapLine.setValue({ fieldId: 'custrecord_scrap_line_lot_text',   value: lotText });
                scrapLine.setValue({ fieldId: 'custrecord_scrap_line_lot_id',     value: lotId ? parseInt(lotId, 10) : null });
                scrapLine.setValue({ fieldId: 'custrecord_scrap_line_qty_used',   value: qtyUsed });
                scrapLine.setValue({ fieldId: 'custrecord_scrap_line_scrap_qty',  value: scrapQty });
                scrapLine.setValue({ fieldId: 'custrecord_scrap_line_bin',        value: binId || null });
                scrapLine.setValue({ fieldId: 'custrecord_scrap_line_location',   value: locationId });
                scrapLine.setValue({ fieldId: 'custrecord_scrap_line_subsidiary', value: subsidiaryId });
                scrapLine.setValue({ fieldId: 'custrecord_scrap_line_inv_adj',    value: adjId });
                scrapLine.save();

                log.audit({ title: 'Scrap Line Created', details: 'Item: ' + itemName + ' | Adj: ' + adjId });

            } catch (lineErr) {
                log.error({ title: 'Error row ' + i, details: lineErr.message });
                errors.push(itemName + ': ' + lineErr.message);
            }
        }

        if (errors.length > 0) { context.response.write(errorPage('The following lines failed:\n\n' + errors.join('\n'))); return; }
        context.response.write(successPage(woId, woNumber));
    }

    // -------------------------------------------------------------------------
    // Render Form
    // -------------------------------------------------------------------------
    function renderForm(woId, woNumber, rows) {
        const postUrl = url.resolveScript({ scriptId: 'customscript_sl_scrap_entry', deploymentId: 'customdeploy_sl_scrap_entry' });

        // Split rows into two groups while preserving original index for POST field names
        const epRows   = [];
        const bsMxRows = [];
        rows.forEach(function (row, i) {
            if (row.isLotTracked) {
                bsMxRows.push({ row: row, idx: i });
            } else {
                epRows.push({ row: row, idx: i });
            }
        });

        // --- EP table rows (simplified: no lot/prebuild/finalbag columns) ---
        let epTableRows = '';
        epRows.forEach(function (entry, n) {
            const row       = entry.row;
            const i         = entry.idx;
            const rowClass  = n % 2 === 0 ? 'row-even' : 'row-odd';
            const binCell   = '<td>' + buildBinDropdown('bin_id_' + i, row.bins, row.lockedBinId) + '</td>';
            const scrapCell = '<td class="td-scrap"><input type="number" name="scrap_qty_' + i + '" min="0" step="0.01" class="field-num" placeholder="0" /></td>';

            epTableRows +=
                '<tr class="' + rowClass + '">' +
                '<td class="td-item">' + esc(row.itemName) + '</td>' +
                '<td class="td-qty right">' + esc(row.qtyUsed) + '</td>' +
                '<td class="td-uom">' + esc(row.uom || '—') + '</td>' +
                scrapCell +
                binCell +
                '</tr>' +
                '<input type="hidden" name="item_id_'        + i + '" value="' + esc(row.itemId)  + '" />' +
                '<input type="hidden" name="item_name_'      + i + '" value="' + esc(row.itemName) + '" />' +
                '<input type="hidden" name="qty_used_'       + i + '" value="' + esc(row.qtyUsed)  + '" />' +
                '<input type="hidden" name="is_lot_tracked_' + i + '" value="false" />' +
                '<input type="hidden" name="is_assembly_'    + i + '" value="false" />' +
                '<input type="hidden" name="lot_id_'         + i + '" value="" />' +
                '<input type="hidden" name="lot_text_'       + i + '" value="" />';
        });

        // --- BS/MX table rows ---
        let bsMxTableRows = '';
        bsMxRows.forEach(function (entry, n) {
            const row      = entry.row;
            const i        = entry.idx;
            const rowClass = n % 2 === 0 ? 'row-even' : 'row-odd';
            const dataLot  = esc(row.lotText);

            // Lot shown as plain text — each row is already one specific lot
            const lotCell = '<td class="td-lot">' + esc(row.lotText || '—') + '</td>';

            let binCell;
            if (row.lockedBinId) {
                binCell = '<td>' + esc(row.lockedBinText) +
                    '<input type="hidden" name="bin_id_' + i + '" value="' + esc(row.lockedBinId) + '" /></td>';
            } else {
                binCell = '<td>' + buildBinDropdown('bin_id_' + i, row.bins, '') + '</td>';
            }

            const prebuildCell = row.prebuildWeight !== null
                ? '<td class="td-qty right">' + esc(row.prebuildWeight) + '</td>'
                : '<td class="td-qty muted">Not weighed</td>';

            let finalBagCell, scrapCell;
            if (row.prebuildWeight !== null) {
                finalBagCell = '<td class="td-scrap"><input type="number" name="final_bag_' + i + '" min="0" step="0.001" class="field-num" placeholder="0.000"' +
                    ' oninput="calcScrap(' + i + ',' + row.prebuildWeight + ',' + row.qtyUsed + ')" /></td>';
                scrapCell = '<td class="td-scrap"><input type="number" name="scrap_qty_' + i + '" id="scrap_calc_' + i + '" class="field-num" readonly style="background:#f5f7f9;" placeholder="auto" /></td>';
            } else {
                finalBagCell = '<td class="td-scrap muted">N/A</td>';
                scrapCell    = '<td class="td-scrap"><input type="number" name="scrap_qty_' + i + '" min="0" step="0.01" class="field-num" placeholder="0" /></td>';
            }

            bsMxTableRows +=
                '<tr class="' + rowClass + '" data-lot="' + dataLot + '">' +
                '<td class="td-item">' + esc(row.itemName) + '</td>' +
                lotCell +
                prebuildCell +
                '<td class="td-qty right">' + esc(row.qtyUsed) + '</td>' +
                '<td class="td-uom">' + esc(row.uom || '—') + '</td>' +
                finalBagCell +
                scrapCell +
                binCell +
                '</tr>' +
                '<input type="hidden" name="item_id_'        + i + '" value="' + esc(row.itemId)   + '" />' +
                '<input type="hidden" name="item_name_'      + i + '" value="' + esc(row.itemName)  + '" />' +
                '<input type="hidden" name="qty_used_'       + i + '" value="' + esc(row.qtyUsed)   + '" />' +
                '<input type="hidden" name="is_lot_tracked_' + i + '" value="true" />' +
                '<input type="hidden" name="is_assembly_'    + i + '" value="false" />' +
                '<input type="hidden" name="lot_id_'         + i + '" value="' + esc(row.lotId)     + '" />' +
                '<input type="hidden" name="lot_text_'       + i + '" value="' + esc(row.lotText)   + '" />';
        });

        const epSection = epRows.length === 0 ? '' :
            '<div class="section-title">EP Components</div>' +
            '<div class="table-scroll">' +
            '<table><thead><tr>' +
            '<th>Item</th>' +
            '<th style="text-align:right;">Qty Used in Build</th>' +
            '<th>UOM</th>' +
            '<th>Scrap Qty</th>' +
            '<th>Bin Number</th>' +
            '</tr></thead><tbody>' + epTableRows + '</tbody></table>' +
            '</div>';

        const bsMxSection = bsMxRows.length === 0 ? '' :
            '<div class="section-title">BS / MX Components</div>' +
            '<div class="table-scroll">' +
            '<table><thead><tr>' +
            '<th>Item</th>' +
            '<th>Lot Number' +
                '<div class="lot-search-wrap">' +
                    '<input type="text" id="lotSearch" class="lot-search" placeholder="Search lots…" oninput="filterLots(this.value);" autocomplete="off" />' +
                '</div>' +
            '</th>' +
            '<th style="text-align:right;">Pre-Build Weight</th>' +
            '<th style="text-align:right;">Qty Used in Build</th>' +
            '<th>UOM</th>' +
            '<th>Final Bag Weight</th>' +
            '<th>Scrap Qty</th>' +
            '<th>Bin Number</th>' +
            '</tr></thead><tbody id="scrapTbody">' + bsMxTableRows + '</tbody></table>' +
            '</div>' +
            '<div id="noMatchMsg" class="no-match-msg">No lots match your search.</div>';

        return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Log Scrap — ' + esc(woNumber) + '</title>' +
            '<style>' +
            '*, *::before, *::after { box-sizing: border-box; }' +
            'body { margin: 0; background: #f5f7f9; font-family: Arial, sans-serif; font-size: 12px; color: #333; }' +
            '.page-header { background: #fff; border-bottom: 2px solid #c8d2e0; padding: 12px 20px; }' +
            '.page-header h1 { margin: 0 0 3px; font-size: 15px; font-weight: bold; color: #1f1f1f; letter-spacing: .01em; }' +
            '.page-header .wo-ref { font-size: 11px; color: #666; }' +
            '.page-header .wo-ref span { color: #1778c5; font-weight: bold; }' +
            '.btn-bar { background: #edf1f7; border-bottom: 1px solid #c0cad8; padding: 6px 20px; display: flex; gap: 8px; align-items: center; }' +
            '.btn-primary { background: #1778c5; color: #fff; border: 1px solid #1060a3; padding: 5px 22px; font-size: 12px; font-weight: bold; cursor: pointer; border-radius: 2px; white-space: nowrap; line-height: 1.6; }' +
            '.btn-primary:hover { background: #1464a8; }' +
            '.btn-secondary { background: #fff; color: #444; border: 1px solid #aaa; padding: 5px 16px; font-size: 12px; cursor: pointer; border-radius: 2px; white-space: nowrap; line-height: 1.6; }' +
            '.btn-secondary:hover { background: #f4f6f9; }' +
            '.page-body { padding: 16px 20px; }' +
            '.hint { font-size: 11px; color: #666; margin-bottom: 14px; line-height: 1.65; max-width: 900px; }' +
            '.section-title { margin: 20px 0 8px; font-size: 11px; font-weight: bold; color: #555; border-bottom: 1px solid #c8d2e0; padding-bottom: 5px; text-transform: uppercase; letter-spacing: .06em; }' +
            '.section-title:first-of-type { margin-top: 0; }' +
            'table { width: 100%; border-collapse: collapse; background: #fff; }' +
            '.table-scroll { overflow: auto; max-height: 480px; border: 1px solid #b4bece; }' +
            'th { background: #c5d0e0; color: #2a2a2a; padding: 7px 12px; text-align: left; font-size: 11px; font-weight: bold; border: 1px solid #a2b0c4; vertical-align: top; position: sticky; top: 0; z-index: 1; }' +
            'td { padding: 6px 12px; border-bottom: 1px solid #dde3ed; border-right: 1px solid #dde3ed; vertical-align: middle; font-size: 12px; }' +
            '.row-even td { background: #fff; }' +
            '.row-odd  td { background: #f3f6fb; }' +
            '.td-item { min-width: 220px; } .td-lot { min-width: 160px; } .td-qty { min-width: 120px; } .td-scrap { min-width: 110px; } .td-uom { min-width: 60px; color: #555; }' +
            '.right { text-align: right; }' +
            '.muted { color: #aaa; font-style: italic; }' +
            '.field-num { width: 90px; padding: 4px 7px; border: 1px solid #aaa; font-size: 12px; text-align: right; background: #fff; transition: border-color .15s; }' +
            '.field-num:focus { border-color: #1778c5; outline: none; box-shadow: inset 0 1px 2px rgba(0,0,0,.07); }' +
            '.field-select { padding: 4px 7px; border: 1px solid #aaa; border-radius: 2px; font-size: 12px; background: #fff; min-width: 150px; max-width: 300px; width: 100%; transition: border-color .15s; }' +
            '.field-select:focus { border-color: #1778c5; outline: none; }' +
            '.lot-search-wrap { position: relative; margin-top: 6px; }' +
            '.lot-search-wrap::before { content: "\\1F50D"; position: absolute; left: 6px; top: 50%; transform: translateY(-50%); font-size: 10px; pointer-events: none; opacity: .45; }' +
            '.lot-search { width: 100%; padding: 4px 7px 4px 22px; border: 1px solid #aaa; font-size: 11px; font-weight: normal; letter-spacing: 0; text-transform: none; color: #333; background: #fff; transition: border-color .15s; }' +
            '.lot-search:focus { border-color: #1778c5; outline: none; }' +
            '.lot-search::placeholder { color: #bbb; font-style: italic; }' +
            '.no-match-msg { display: none; padding: 14px; text-align: center; color: #999; font-style: italic; font-size: 12px; background: #fff; border: 1px solid #b4bece; border-top: none; }' +
            '</style></head><body>' +
            '<div class="page-header">' +
                '<h1>Log Scrap</h1>' +
                '<div class="wo-ref">Work Order: <span>' + esc(woNumber) + '</span></div>' +
            '</div>' +
            '<div class="btn-bar">' +
                '<button type="submit" form="scrapForm" class="btn-primary" onclick="return validateForm();">Submit Scrap Entry</button>' +
                '<button type="button" class="btn-secondary" onclick="window.close();">Cancel</button>' +
            '</div>' +
            '<div class="page-body">' +
            '<p class="hint">Enter a Scrap Qty for any items scrapped during this build. Leave blank or 0 to skip a line.</p>' +
            '<form id="scrapForm" method="POST" action="' + esc(postUrl) + '">' +
            '<input type="hidden" name="wo_id"     value="' + esc(woId)        + '" />' +
            '<input type="hidden" name="row_count" value="' + esc(rows.length) + '" />' +
            epSection +
            bsMxSection +
            '</form></div>' +
            '<script>' +
            'function filterLots(q){' +
                'q=q.trim().toLowerCase();' +
                'var rows=document.querySelectorAll("#scrapTbody tr");' +
                'var visible=0;' +
                'rows.forEach(function(row){' +
                    'var lot=(row.getAttribute("data-lot")||"").toLowerCase();' +
                    'var show=!q||lot.indexOf(q)!==-1;' +
                    'row.style.display=show?"":"none";' +
                    'if(show)visible++;' +
                '});' +
                'document.getElementById("noMatchMsg").style.display=(q&&visible===0)?"block":"none";' +
            '}' +
            'function calcScrap(i,pre,qtyUsed){' +
                'var finalEl=document.querySelector("[name=\'final_bag_"+i+"\']");' +
                'if(!finalEl)return;' +
                'var finalBag=parseFloat(finalEl.value)||0;' +
                'var scrap=pre-qtyUsed-finalBag;' +
                'if(scrap<0)scrap=0;' +
                'var el=document.getElementById("scrap_calc_"+i);' +
                'if(el)el.value=scrap>0?scrap.toFixed(3):"";' +
            '}' +
            'function validateForm(){var n=' + rows.length + ',h=false;for(var i=0;i<n;i++){var q=document.querySelector("[name=\'scrap_qty_"+i+"\']");if(!q)continue;var v=parseFloat(q.value)||0;if(v>0){h=true;var b=document.querySelector("[name=\'bin_id_"+i+"\']");if(!b||!b.value){alert("Please select a Bin Number for all items with Scrap Qty > 0.");if(b)b.focus();return false;}}}if(!h){alert("Please enter a Scrap Qty for at least one item.");return false;}return true;}' +
            '<\/script>' +
            '</body></html>';
    }

    function buildBinDropdown(name, bins, selectedId) {
        let h = '<select name="' + esc(name) + '" class="field-select"><option value="">-- Select Bin --</option>';
        if (bins && bins.length) {
            bins.forEach(function (b) { h += '<option value="' + esc(b.id) + '"' + (String(b.id) === String(selectedId) ? ' selected' : '') + '>' + esc(b.name) + '</option>'; });
        }
        return h + '</select>';
    }

    function esc(s) { if (s == null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    function successPage(woId, woNumber) {
        const woUrl = '/app/accounting/transactions/workord.nl?id=' + woId;
        return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3;url=' + woUrl + '"><style>*{box-sizing:border-box;font-family:Arial,sans-serif;}body{background:#f5f7f9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}.card{background:#fff;border:1px solid #c8d2e0;padding:40px 36px;text-align:center;max-width:400px;width:100%;}.icon{font-size:42px;color:#1778c5;margin-bottom:8px;}h2{color:#1f1f1f;margin:0 0 8px;font-size:16px;}p{color:#666;margin:4px 0;font-size:12px;}a{display:inline-block;margin-top:20px;background:#1778c5;color:#fff;text-decoration:none;padding:6px 20px;font-size:12px;font-weight:bold;border:1px solid #1060a3;border-radius:2px;}</style></head><body><div class="card"><div class="icon">&#10003;</div><h2>Scrap Entry Submitted</h2><p>Inventory adjustments posted.</p><p style="color:#999;margin-top:8px;">Redirecting to WO ' + esc(woNumber) + '&#8230;</p><a href="' + woUrl + '">Go to Work Order Now</a></div></body></html>';
    }

    function errorPage(msg) {
        return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box;font-family:Arial,sans-serif;}body{background:#f5f7f9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}.card{background:#fff;border:1px solid #c8d2e0;padding:36px;text-align:center;max-width:480px;width:100%;}.icon{font-size:36px;color:#b30000;margin-bottom:8px;}h2{color:#1f1f1f;margin:0 0 8px;font-size:15px;}p{color:#555;white-space:pre-wrap;text-align:left;font-size:12px;background:#fff5f5;border:1px solid #e0b0b0;padding:10px;margin-top:10px;}button{margin-top:18px;background:#1778c5;color:#fff;border:1px solid #1060a3;padding:5px 18px;font-size:12px;font-weight:bold;cursor:pointer;border-radius:2px;}</style></head><body><div class="card"><div class="icon">&#10007;</div><h2>Something went wrong</h2><p>' + esc(msg) + '</p><button onclick="window.history.back();">Go Back &amp; Fix</button></div></body></html>';
    }

    return { onRequest };
});

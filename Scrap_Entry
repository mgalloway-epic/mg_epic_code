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
            const woRec          = record.load({ type: 'workorder', id: woId });
            const woNumber       = woRec.getValue({ fieldId: 'tranid' });
            const locationId     = woRec.getValue({ fieldId: 'location' });
            const assemblyItemId = String(woRec.getValue({ fieldId: 'assemblyitem' }));

            // Get assembly item's itemid (SKU)
            const asmLookup        = search.lookupFields({ type: search.Type.ITEM, id: assemblyItemId, columns: ['itemid'] });
            const assemblyItemName = asmLookup.itemid || assemblyItemId;

            // Most recent build
            const buildResults = search.create({
                type:    'assemblybuild',
                filters: [['createdfrom', 'anyof', woId]],
                columns: [search.createColumn({ name: 'internalid' }), search.createColumn({ name: 'trandate', sort: search.Sort.DESC })]
            }).run().getRange({ start: 0, end: 1 });

            if (!buildResults.length) { context.response.write(errorPage('No Assembly Build found for WO ' + woNumber + '.')); return; }

            const buildId = buildResults[0].id;

            // Load with isDynamic: true so subrecords are accessible
            const buildRec = record.load({ type: 'assemblybuild', id: buildId, isDynamic: true });
            const builtQty = buildRec.getValue({ fieldId: 'quantity' });

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

            const rows = [];

            // --- Assembly row intentionally excluded ---
            // The finished assembly item is not a candidate for scrap logging.
            // Only BOM components are shown on this form.

            // --- Component rows ---
            const lineCount = buildRec.getLineCount({ sublistId: 'component' });

            const componentItemIds = [];
            for (let i = 0; i < lineCount; i++) {
                componentItemIds.push(String(buildRec.getSublistValue({ sublistId: 'component', fieldId: 'item', line: i })));
            }

            const itemNameMap = {};
            if (componentItemIds.length > 0) {
                search.create({
                    type:    search.Type.ITEM,
                    filters: [['internalid', 'anyof', componentItemIds]],
                    columns: ['internalid', 'itemid']
                }).run().each(function (r) {
                    itemNameMap[r.id] = r.getValue('itemid') || r.id;
                    return true;
                });
            }

            for (let i = 0; i < lineCount; i++) {
                const itemId   = String(buildRec.getSublistValue({ sublistId: 'component', fieldId: 'item',     line: i }));
                const itemName = itemNameMap[itemId] || itemId;
                const qtyUsed  = buildRec.getSublistValue({ sublistId: 'component', fieldId: 'quantity', line: i }) || 0;

                const prefix       = (itemName || '').trim().substring(0, 2).toUpperCase();
                const isLotTracked = prefix === 'BS' || prefix === 'MX';

                buildRec.selectLine({ sublistId: 'component', line: i });
                const { lots, bins } = extractLotsAndBins(buildRec, isLotTracked);

                log.debug({ title: 'Component ' + itemName, details: 'lots=' + lots.length + ' bins=' + bins.length });

                if (isLotTracked && lots.length > 0) {
                    lots.forEach(function (lot) {
                        const prebuildWeight = prebuildMap[lot.id] ? prebuildMap[lot.id].weight : null;
                        const lotQtyUsed = lot.qty || qtyUsed;
                        rows.push({
                            itemId, itemName, isLotTracked: true, isAssembly: false,
                            qtyUsed: lotQtyUsed, lotId: lot.id, lotText: lot.text,
                            lots, bins,
                            prebuildWeight,
                            lockedBinId:   lot.binId   || '',
                            lockedBinText: lot.binText || ''
                        });
                    });
                } else {
                    rows.push({ itemId, itemName, isLotTracked: false, isAssembly: false, qtyUsed, lotId: '', lotText: '', lots: [], bins, prebuildWeight: null, lockedBinId: '', lockedBinText: '' });
                }
            }

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

                    let binId   = invDetail.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', line: j });
                    let binText = invDetail.getSublistText({  sublistId: 'inventoryassignment', fieldId: 'binnumber', line: j }) || '';
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
                let binId   = invDetail.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', line: j });
                let binText = invDetail.getSublistText({  sublistId: 'inventoryassignment', fieldId: 'binnumber', line: j }) || '';
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

        let tableRows = '';
        rows.forEach(function (row, i) {
            const rowClass = i % 2 === 0 ? 'row-even' : 'row-odd';

            const lotCell = row.isLotTracked && row.lots && row.lots.length > 0
                ? '<td class="td-lot">'        + buildLotDropdown('lot_id_' + i, row.lots, row.lotId) + '</td>'
                : '<td class="td-lot muted">N/A</td>';

            let binCell;
            if (row.isLotTracked && row.lockedBinId) {
                binCell = '<td>' + esc(row.lockedBinText) +
                    '<input type="hidden" name="bin_id_' + i + '" value="' + esc(row.lockedBinId) + '" /></td>';
            } else {
                binCell = '<td>' + buildBinDropdown('bin_id_' + i, row.bins, row.lockedBinId) + '</td>';
            }

            let prebuildCell;
            if (row.isLotTracked && row.prebuildWeight !== null) {
                prebuildCell = '<td class="td-qty">' + esc(row.prebuildWeight) + '</td>';
            } else if (row.isLotTracked) {
                prebuildCell = '<td class="td-qty muted">Not weighed</td>';
            } else {
                prebuildCell = '<td class="td-qty muted">N/A</td>';
            }

            let finalBagCell, scrapCell;
            if (row.isLotTracked && row.prebuildWeight !== null) {
                finalBagCell = '<td class="td-scrap"><input type="number" name="final_bag_' + i + '" min="0" step="0.001" class="field-num" placeholder="0.000"' +
                    ' oninput="calcScrap(' + i + ',' + row.prebuildWeight + ',' + row.qtyUsed + ')" /></td>';
                scrapCell = '<td class="td-scrap"><input type="number" name="scrap_qty_' + i + '" id="scrap_calc_' + i + '" class="field-num" readonly style="background:#f5f5f5;color:#333;" placeholder="auto" /></td>';
            } else {
                finalBagCell = '<td class="td-scrap muted">N/A</td>';
                scrapCell    = '<td class="td-scrap"><input type="number" name="scrap_qty_' + i + '" min="0" step="0.01" class="field-num" placeholder="0" /></td>';
            }

            tableRows +=
                '<tr class="' + rowClass + '">' +
                '<td class="td-item">' + esc(row.itemName) + '</td>' +
                lotCell +
                prebuildCell +
                '<td class="td-qty">' + esc(row.qtyUsed) + '</td>' +
                finalBagCell +
                scrapCell +
                binCell +
                '</tr>' +
                '<input type="hidden" name="item_id_'        + i + '" value="' + esc(row.itemId)      + '" />' +
                '<input type="hidden" name="item_name_'      + i + '" value="' + esc(row.itemName)     + '" />' +
                '<input type="hidden" name="qty_used_'       + i + '" value="' + esc(row.qtyUsed)      + '" />' +
                '<input type="hidden" name="is_lot_tracked_' + i + '" value="' + esc(row.isLotTracked) + '" />' +
                '<input type="hidden" name="is_assembly_'    + i + '" value="false" />' +
                '<input type="hidden" name="lot_id_'         + i + '" value="' + esc(row.lotId)        + '" />' +
                '<input type="hidden" name="lot_text_'       + i + '" value="' + esc(row.lotText)      + '" />';
        });

        return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Log Scrap \u2014 ' + esc(woNumber) + '</title>' +
            '<style>*,*::before,*::after{box-sizing:border-box;}body{margin:0;background:#f0f2f5;font-family:Arial,sans-serif;font-size:13px;color:#222;}' +
            '.page-header{background:#1f3a6e;color:#fff;padding:18px 28px;}.page-header h1{margin:0;font-size:18px;font-weight:bold;}.page-header p{margin:4px 0 0;font-size:12px;opacity:.75;}' +
            '.page-body{padding:24px 28px;}.hint{font-size:12px;color:#666;margin-bottom:16px;}' +
            'table{width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1);}' +
            'th{background:#e4e8ee;color:#333;padding:10px 14px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid #ccd0d8;}' +
            'td{padding:9px 14px;border-bottom:1px solid #eef0f3;vertical-align:middle;}' +
            '.row-even td{background:#fff;}.row-odd td{background:#fafbfc;}' +
            '.td-item{min-width:220px;}.td-lot{min-width:160px;}.td-qty{text-align:right;min-width:110px;}.td-scrap{min-width:100px;}' +
            '.muted{color:#aaa;font-style:italic;}' +
            '.field-num{width:80px;padding:5px 8px;border:1px solid #ccc;border-radius:3px;font-size:13px;text-align:right;}' +
            '.field-num:focus{border-color:#1f3a6e;outline:none;box-shadow:0 0 0 2px rgba(31,58,110,.15);}' +
            '.field-select{padding:5px 8px;border:1px solid #ccc;border-radius:3px;font-size:13px;background:#fff;min-width:150px;max-width:300px;width:100%;}' +
            '.field-select:focus{border-color:#1f3a6e;outline:none;}' +
            '.actions{margin-top:20px;display:flex;gap:12px;justify-content:flex-end;}' +
            '.btn-primary{background:#1f3a6e;color:#fff;border:none;padding:11px 32px;border-radius:4px;font-size:14px;font-weight:bold;cursor:pointer;}' +
            '.btn-primary:hover{background:#162d56;}' +
            '.btn-secondary{background:#fff;color:#444;border:1px solid #bbb;padding:11px 24px;border-radius:4px;font-size:14px;cursor:pointer;}' +
            '.btn-secondary:hover{background:#f5f5f5;}' +
            '</style></head><body>' +
            '<div class="page-header"><h1>Log Scrap</h1><p>Work Order: ' + esc(woNumber) + '</p></div>' +
            '<div class="page-body">' +
            '<p class="hint">Enter a Scrap Qty for any items scrapped during this build. Leave blank or 0 to skip a line.</p>' +
            '<form method="POST" action="' + esc(postUrl) + '" onsubmit="return validateForm();">' +
            '<input type="hidden" name="wo_id"     value="' + esc(woId)        + '" />' +
            '<input type="hidden" name="row_count" value="' + esc(rows.length) + '" />' +
            '<table><thead><tr>' +
            '<th>Item</th><th>Lot Number</th><th style="text-align:right;">Pre-Build Weight</th><th style="text-align:right;">Qty Used in Build</th><th>Final Bag Weight</th><th>Scrap Qty</th><th>Bin Number</th>' +
            '</tr></thead><tbody>' + tableRows + '</tbody></table>' +
            '<div class="actions">' +
            '<button type="button" class="btn-secondary" onclick="window.close();">Cancel</button>' +
            '<button type="submit" class="btn-primary">Submit Scrap Entry</button>' +
            '</div></form></div>' +
            '<script>' +
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

    function buildLotDropdown(name, lots, selectedId) {
        if (!lots || !lots.length) return '<span class="muted">No lots found</span>';
        let h = '<select name="' + esc(name) + '" class="field-select">';
        lots.forEach(function (l) { h += '<option value="' + esc(l.id) + '"' + (String(l.id) === String(selectedId) ? ' selected' : '') + '>' + esc(l.text) + '</option>'; });
        return h + '</select>';
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
        return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3;url=' + woUrl + '"><style>*{box-sizing:border-box;font-family:Arial,sans-serif;}body{background:#f0f2f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}.card{background:#fff;border-radius:8px;padding:48px 40px;text-align:center;max-width:420px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.1);}.icon{font-size:52px;color:#2e7d32;}h2{color:#2e7d32;margin:12px 0 8px;}p{color:#666;margin:4px 0;}a{display:inline-block;margin-top:24px;background:#1f3a6e;color:#fff;text-decoration:none;padding:11px 32px;border-radius:4px;font-size:14px;font-weight:bold;}</style></head><body><div class="card"><div class="icon">&#10003;</div><h2>Scrap Entry Submitted</h2><p>Inventory adjustments posted.</p><p style="font-size:12px;color:#999;margin-top:8px;">Redirecting to WO ' + esc(woNumber) + '...</p><a href="' + woUrl + '">Go to Work Order Now</a></div></body></html>';
    }

    function errorPage(msg) {
        return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box;font-family:Arial,sans-serif;}body{background:#f0f2f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}.card{background:#fff;border-radius:8px;padding:48px 40px;text-align:center;max-width:480px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.1);}.icon{font-size:52px;color:#c62828;}h2{color:#c62828;margin:12px 0 8px;}p{color:#555;white-space:pre-wrap;text-align:left;font-size:13px;background:#fff8f8;border:1px solid #fcc;border-radius:4px;padding:12px;margin-top:12px;}button{margin-top:24px;background:#555;color:#fff;border:none;padding:11px 28px;border-radius:4px;font-size:14px;cursor:pointer;}</style></head><body><div class="card"><div class="icon">&#10007;</div><h2>Something went wrong</h2><p>' + esc(msg) + '</p><button onclick="window.history.back();">Go Back &amp; Fix</button></div></body></html>';
    }

    return { onRequest };
});

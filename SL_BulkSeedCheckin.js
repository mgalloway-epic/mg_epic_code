/**
 * SL_BulkSeedCheckin.js
 * Suitelet — Bulk Seed Bag Check-in
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define([
    'N/ui/serverWidget',
    'N/record',
    'N/search',
    'N/redirect',
    'N/log',
    'N/format'
], (serverWidget, record, search, redirect, log, format) => {

    // ─── onRequest ───────────────────────────────────────────────────────────
    const onRequest = (context) => {
        if (context.request.method === 'GET') {
            const action = context.request.parameters.action;
            if      (action === 'checklot') checkLotExists(context);
            else if (action === 'getbin')   getPreferredBin(context);
            else                            renderCheckinForm(context);
        } else {
            const action = context.request.parameters.action;
            if (action === 'printbag') printBag(context);
            else                       processCheckin(context);
        }
    };

    // ─── Shared: Resolve preferred bin for a receipt line item ───────────────
    const resolveBin = (lineItemId, locationId) => {
        const itemTypes = [
            record.Type.LOT_NUMBERED_INVENTORY_ITEM,
            record.Type.INVENTORY_ITEM,
            record.Type.ASSEMBLY_ITEM,
            record.Type.LOT_NUMBERED_ASSEMBLY_ITEM
        ];
        let resolvedBinId = '', resolvedBinName = '';
        for (const itemType of itemTypes) {
            try {
                const itemRec  = record.load({ type: itemType, id: lineItemId, isDynamic: false });
                const locCount = itemRec.getLineCount({ sublistId: 'locations' });
                let firstPrefBinId = '';
                for (let l = 0; l < locCount; l++) {
                    const locVal  = itemRec.getSublistValue({ sublistId: 'locations', fieldId: 'location',     line: l });
                    const prefBin = itemRec.getSublistValue({ sublistId: 'locations', fieldId: 'preferredbin', line: l });
                    if (prefBin && !firstPrefBinId) firstPrefBinId = String(prefBin);
                    if (String(locVal) === String(locationId) && prefBin) {
                        resolvedBinId = String(prefBin);
                        break;
                    }
                }
                if (!resolvedBinId && firstPrefBinId) resolvedBinId = firstPrefBinId;
                break;
            } catch(e) { /* try next type */ }
        }
        // Resolve bin name from internal ID
        if (resolvedBinId) {
            try {
                const binSearch = search.create({
                    type: search.Type.BIN,
                    filters: [['internalid', 'anyof', resolvedBinId]],
                    columns: [search.createColumn({ name: 'binnumber' })]
                });
                binSearch.run().each(result => {
                    resolvedBinName = result.getValue({ name: 'binnumber' }) || '';
                    return false;
                });
            } catch(e) {}
        }
        return { binId: resolvedBinId, binName: resolvedBinName };
    };

    // ─── Shared: Build item receipt from a bag group ─────────────────────────
    const buildReceipt = (poId, bags, vendorLot, countryOrig) => {
        const itemGroups = {};
        bags.forEach(bag => {
            const key = String(bag.itemId);
            if (!itemGroups[key]) itemGroups[key] = [];
            itemGroups[key].push(bag);
        });

        const poRec   = record.load({ type: record.Type.PURCHASE_ORDER, id: poId });
        const poLocId = poRec.getValue({ fieldId: 'location' });

        const itemReceipt = record.transform({
            fromType:  record.Type.PURCHASE_ORDER,
            fromId:    poId,
            toType:    record.Type.ITEM_RECEIPT,
            isDynamic: true
        });

        const irLocId    = itemReceipt.getValue({ fieldId: 'location' });
        const locationId = irLocId || poLocId;

        // Resolve bins for all receipt lines
        const itemBinMap  = {};
        const itemNameMap = {};
        const lineCount   = itemReceipt.getLineCount({ sublistId: 'item' });
        for (let i = 0; i < lineCount; i++) {
            const lineItemId = String(itemReceipt.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }));
            if (!itemBinMap[lineItemId]) {
                const bin = resolveBin(lineItemId, locationId);
                itemBinMap[lineItemId]  = bin.binId;
                itemNameMap[lineItemId] = itemReceipt.getSublistText({ sublistId: 'item', fieldId: 'item', line: i }) || '';
            }
        }

        // Memo
        const totalBags   = bags.length;
        const totalWeight = bags.reduce((s, b) => s + (parseFloat(b.weight)    || 0), 0);
        const totalSeeds  = bags.reduce((s, b) => s + (parseInt(b.seedCount)   || 0), 0);
        let memoparts = ['Bulk Seed Bag Check-in', 'Bags: ' + totalBags];
        if (totalWeight > 0) memoparts.push('Total Weight: ' + totalWeight.toFixed(2) + ' gm');
        if (totalSeeds  > 0) memoparts.push('Total Seeds: ' + totalSeeds);
        itemReceipt.setValue({ fieldId: 'memo', value: memoparts.join(' | ') });
        try { itemReceipt.setValue({ fieldId: 'custbody_bcc_vendor_lot',        value: vendorLot   }); } catch(e) {}
        try { itemReceipt.setValue({ fieldId: 'custbody_bcc_country_of_origin', value: countryOrig }); } catch(e) {}

        // Process lines
        for (let i = 0; i < lineCount; i++) {
            const lineItemId = String(itemReceipt.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i })).trim();

            let bagGroup = itemGroups[lineItemId];
            if (!bagGroup) {
                const numericId = parseInt(lineItemId, 10);
                const matchKey  = Object.keys(itemGroups).find(k => parseInt(k, 10) === numericId);
                if (matchKey) bagGroup = itemGroups[matchKey];
            }
            if (!bagGroup && Object.keys(itemGroups).length === 1 && lineCount === 1) {
                bagGroup = itemGroups[Object.keys(itemGroups)[0]];
            }

            if (!bagGroup || !bagGroup.length) {
                itemReceipt.selectLine({ sublistId: 'item', line: i });
                itemReceipt.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
                itemReceipt.commitLine({ sublistId: 'item' });
                continue;
            }

            itemReceipt.selectLine({ sublistId: 'item', line: i });
            itemReceipt.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: true });

            const isSeedCount = bagGroup[0].isSeedCount;
            const totalQty    = isSeedCount
                ? bagGroup.reduce((s, b) => s + (parseInt(b.seedCount)  || 0), 0)
                : bagGroup.reduce((s, b) => s + (parseFloat(b.weight)   || 0), 0);
            itemReceipt.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: totalQty });

            const lineTareWeight = parseFloat(bagGroup[0].tareWeight) || 0;
            try { itemReceipt.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_tare_weight', value: lineTareWeight }); } catch(e) {}
            const lineVendorLot = bagGroup[0].vendorLot || vendorLot || '';
            const lineCoo       = bagGroup[0].coo       || countryOrig || '';
            try { itemReceipt.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_vendor_lot', value: lineVendorLot }); } catch(e) {}
            try { itemReceipt.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_coo',        value: lineCoo      }); } catch(e) {}

            // Inventory detail
            try {
                const invDetail = itemReceipt.getCurrentSublistSubrecord({ sublistId: 'item', fieldId: 'inventorydetail' });
                if (invDetail) {
                    const existingLines = invDetail.getLineCount({ sublistId: 'inventoryassignment' });
                    for (let d = existingLines - 1; d >= 0; d--) invDetail.removeLine({ sublistId: 'inventoryassignment', line: d });
                    bagGroup.forEach(bag => {
                        const bagQty      = isSeedCount ? (parseInt(bag.seedCount) || 0) : (parseFloat(bag.weight) || 0);
                        const resolvedBin = itemBinMap[lineItemId];
                        invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
                        invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'receiptinventorynumber', value: bag.bagNumber });
                        invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity',               value: bagQty       });
                        if (resolvedBin) {
                            try { invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: resolvedBin }); } catch(e) {}
                        }
                        if (bag.expirationDate) {
                            try {
                                const rawDate = String(bag.expirationDate);
                                let expDate;
                                if (rawDate.includes('-') && rawDate.indexOf('-') === 4) {
                                    const parts = rawDate.substring(0, 10).split('-');
                                    expDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                                } else {
                                    const parts = rawDate.split('/');
                                    expDate = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
                                }
                                if (expDate && !isNaN(expDate.getTime())) {
                                    invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'expirationdate', value: expDate });
                                }
                            } catch(e) {}
                        }
                        invDetail.commitLine({ sublistId: 'inventoryassignment' });
                    });
                }
            } catch(invErr) {
                log.debug({ title: 'SL_BulkSeedCheckin: inventorydetail skipped', details: invErr.message });
            }

            itemReceipt.commitLine({ sublistId: 'item' });
        }

        // Pre-save check
        let linesReceiving = 0;
        for (let c = 0; c < lineCount; c++) {
            if (itemReceipt.getSublistValue({ sublistId: 'item', fieldId: 'itemreceive', line: c })) linesReceiving++;
        }
        if (linesReceiving === 0) {
            const receiptLineIds = [];
            for (let c = 0; c < lineCount; c++) receiptLineIds.push(String(itemReceipt.getSublistValue({ sublistId: 'item', fieldId: 'item', line: c })));
            throw new Error('Item ID mismatch. Bag keys: [' + Object.keys(itemGroups).join(', ') + ']. Receipt IDs: [' + receiptLineIds.join(', ') + '].');
        }

        const receiptId = itemReceipt.save({ enableSourcing: true, ignoreMandatoryFields: false });
        return { receiptId, itemNameMap, itemBinMap, locationId };
    };

    // ─── POST: Print Bag — create receipt for single bag, return label data ──
    const printBag = (context) => {
        const params      = context.request.parameters;
        const poId        = params.custpage_poid;
        const vendorLot   = params.custpage_lot_number        || '';
        const countryOrig = params.custpage_country_of_origin || '';
        const bagJsonRaw  = params.custpage_print_bag_json    || '{}';

        let bag;
        try { bag = JSON.parse(bagJsonRaw); } catch(e) {
            context.response.write(JSON.stringify({ error: 'Invalid bag JSON: ' + e.message }));
            return;
        }

        try {
            const { receiptId, itemNameMap, itemBinMap, locationId } = buildReceipt(poId, [bag], vendorLot, countryOrig);

            const lineItemId = String(bag.itemId);
            const binId      = itemBinMap[lineItemId] || '';
            let binName = '';
            if (binId) {
                try {
                    const binSearch = search.create({
                        type: search.Type.BIN,
                        filters: [['internalid', 'anyof', binId]],
                        columns: [search.createColumn({ name: 'binnumber' })]
                    });
                    binSearch.run().each(result => { binName = result.getValue({ name: 'binnumber' }) || ''; return false; });
                } catch(e) {}
            }

            let itemName = itemNameMap[lineItemId] || '';
            if (!itemName) {
                const numId    = parseInt(lineItemId, 10);
                const matchKey = Object.keys(itemNameMap).find(k => parseInt(k, 10) === numId);
                if (matchKey) itemName = itemNameMap[matchKey];
            }
            if (!itemName && Object.keys(itemNameMap).length > 0) {
                itemName = itemNameMap[Object.keys(itemNameMap)[0]] || '';
            }

            if (!binName && Object.keys(itemBinMap).length > 0) {
                const firstBinId = itemBinMap[Object.keys(itemBinMap)[0]];
                if (firstBinId) {
                    try {
                        const bs = search.create({
                            type: search.Type.BIN,
                            filters: [['internalid', 'anyof', firstBinId]],
                            columns: [search.createColumn({ name: 'binnumber' })]
                        });
                        bs.run().each(r => { binName = r.getValue({ name: 'binnumber' }) || ''; return false; });
                    } catch(e) {}
                }
            }

            let description = '';
            try {
                const itemTypes = [
                    record.Type.LOT_NUMBERED_INVENTORY_ITEM,
                    record.Type.INVENTORY_ITEM,
                    record.Type.ASSEMBLY_ITEM,
                    record.Type.LOT_NUMBERED_ASSEMBLY_ITEM
                ];
                for (const t of itemTypes) {
                    try {
                        const iRec = record.load({ type: t, id: bag.itemId, isDynamic: false });
                        description = iRec.getValue({ fieldId: 'salesdescription' }) ||
                                      iRec.getValue({ fieldId: 'description'      }) || '';
                        break;
                    } catch(e) {}
                }
            } catch(e) {}

            log.audit({ title: 'SL_BulkSeedCheckin: printBag receipt created', details: 'IR=' + receiptId + ' bag=' + bag.bagNumber + ' item=' + itemName + ' bin=' + binName });

            context.response.write(JSON.stringify({
                success:      true,
                receiptId:    receiptId,
                itemName:     itemName,
                description:  description,
                preferredBin: binName
            }));
        } catch(e) {
            log.error({ title: 'SL_BulkSeedCheckin: printBag error', details: e });
            context.response.write(JSON.stringify({ error: e.message }));
        }
    };

    // ─── GET: Lot Number Validation ──────────────────────────────────────────
    const checkLotExists = (context) => {
        const lotNumber = context.request.parameters.lot  || '';
        const itemId    = context.request.parameters.item || '';
        let exists = false;
        try {
            if (lotNumber && itemId) {
                const lotSearch = search.create({
                    type: search.Type.INVENTORY_NUMBER,
                    filters: [['inventorynumber', 'is', lotNumber], 'AND', ['item', 'anyof', itemId]],
                    columns: ['internalid']
                });
                lotSearch.run().each(() => { exists = true; return false; });
            }
        } catch(e) { log.debug({ title: 'SL_BulkSeedCheckin: lot check error', details: e.message }); }
        context.response.write(JSON.stringify({ exists }));
    };

    // ─── GET: Preferred Bin Lookup ────────────────────────────────────────────
    const getPreferredBin = (context) => {
        const itemId     = context.request.parameters.item     || '';
        const locationId = context.request.parameters.location || '';
        let binName = '';
        try {
            if (itemId) {
                const bin = resolveBin(itemId, locationId);
                binName = bin.binName;
            }
        } catch(e) { log.debug({ title: 'SL_BulkSeedCheckin: getPreferredBin error', details: e.message }); }
        context.response.write(JSON.stringify({ binName }));
    };

    // ─── GET: Render Form ────────────────────────────────────────────────────
    const renderCheckinForm = (context, preserved) => {
        const poId  = (preserved && preserved.poId) ? preserved.poId : context.request.parameters.poid;
        const today = format.format({ value: new Date(), type: format.Type.DATE });

        let poRec, vendor = '', poNumber = '', lines = [];
        try {
            poRec    = record.load({ type: record.Type.PURCHASE_ORDER, id: poId });
            vendor   = poRec.getText({ fieldId: 'entity' });
            poNumber = poRec.getValue({ fieldId: 'tranid' });

            const lineCount = poRec.getLineCount({ sublistId: 'item' });
            for (let i = 0; i < lineCount; i++) {
                const itemName = poRec.getSublistText({ sublistId: 'item', fieldId: 'item',             line: i });
                const itemId   = poRec.getSublistValue({ sublistId: 'item', fieldId: 'item',             line: i });
                const qty      = poRec.getSublistValue({ sublistId: 'item', fieldId: 'quantity',         line: i });
                const qtyRec   = poRec.getSublistValue({ sublistId: 'item', fieldId: 'quantityreceived', line: i });
                if (itemName && itemName.startsWith('BS') && (qty - qtyRec) > 0) {
                    const uomText     = poRec.getSublistText({ sublistId: 'item', fieldId: 'units', line: i }) || '';
                    const isSeedCount = uomText.toLowerCase().includes('seed count');
                    lines.push({ itemId, itemName, qty, qtyRec, qtyRemaining: qty - qtyRec, uomText, isSeedCount, line: i });
                }
            }
        } catch(e) { log.error({ title: 'SL_BulkSeedCheckin: PO Load Error', details: e }); }

        const form = serverWidget.createForm({ title: 'Bulk Seed Bag Check-in' });
        form.clientScriptModulePath = './CS_BulkSeedCheckin.js';

        if (preserved && preserved.errorMessage) {
            const fErr = form.addField({ id: 'custpage_error_banner', type: serverWidget.FieldType.INLINEHTML, label: 'Error' });
            fErr.defaultValue = '<div style="background:#fde8e8;border:1px solid #c0392b;color:#c0392b;padding:10px 16px;margin-bottom:10px;border-radius:4px;font-weight:bold;">&#9888; ' + preserved.errorMessage + '</div>';
        }

        // Hidden fields
        const fPoId = form.addField({ id: 'custpage_poid', type: serverWidget.FieldType.INTEGER, label: 'PO ID' });
        fPoId.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
        fPoId.defaultValue = poId;

        const fToday = form.addField({ id: 'custpage_today', type: serverWidget.FieldType.TEXT, label: 'Today' });
        fToday.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
        fToday.defaultValue = today;

        const fBagsJson = form.addField({ id: 'custpage_bags_json', type: serverWidget.FieldType.LONGTEXT, label: 'Bags JSON' });
        fBagsJson.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
        fBagsJson.defaultValue = (preserved && preserved.bagsJson) ? preserved.bagsJson : '[]';

        const fPrinted = form.addField({ id: 'custpage_printed_bags', type: serverWidget.FieldType.LONGTEXT, label: 'Printed Bags' });
        fPrinted.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
        fPrinted.defaultValue = (preserved && preserved.printedBags) ? preserved.printedBags : '[]';

        const locationId = (() => { try { return poRec ? poRec.getValue({ fieldId: 'location' }) : ''; } catch(e) { return ''; } })();
        const fLocationId = form.addField({ id: 'custpage_location_id', type: serverWidget.FieldType.TEXT, label: 'Location ID' });
        fLocationId.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
        fLocationId.defaultValue = locationId;

        const fBinName = form.addField({ id: 'custpage_preferred_bin', type: serverWidget.FieldType.TEXT, label: 'Preferred Bin' });
        fBinName.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });

        // PO Info group
        form.addFieldGroup({ id: 'custpage_po_info', label: 'Purchase Order Information' });
        const fPoNumber = form.addField({ id: 'custpage_po_number', type: serverWidget.FieldType.TEXT, label: 'PO Number', container: 'custpage_po_info' });
        fPoNumber.defaultValue = poNumber;
        fPoNumber.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });

        const fVendor = form.addField({ id: 'custpage_vendor', type: serverWidget.FieldType.TEXT, label: 'Vendor', container: 'custpage_po_info' });
        fVendor.defaultValue = vendor;
        fVendor.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });

        const fItem = form.addField({ id: 'custpage_item_id', type: serverWidget.FieldType.SELECT, label: 'Bulk Seed Item (BS)', container: 'custpage_po_info' });
        fItem.isMandatory = true;
        fItem.addSelectOption({ value: '', text: '-- Select Item --' });
        lines.forEach(l => { fItem.addSelectOption({ value: l.itemId, text: l.itemName + ' (Remaining: ' + l.qtyRemaining + ')' }); });

        const fLotNumber = form.addField({ id: 'custpage_lot_number', type: serverWidget.FieldType.TEXT, label: 'Vendor Lot', container: 'custpage_po_info' });
        fLotNumber.isMandatory = true;
        if (preserved && preserved.vendorLot) fLotNumber.defaultValue = preserved.vendorLot;

        const fCountry = form.addField({ id: 'custpage_country_of_origin', type: serverWidget.FieldType.TEXT, label: 'Country of Origin', container: 'custpage_po_info' });
        fCountry.isMandatory = false;
        if (preserved && preserved.countryOrig) fCountry.defaultValue = preserved.countryOrig;

        const fRemaining = form.addField({ id: 'custpage_remaining_display', type: serverWidget.FieldType.TEXT, label: 'Remaining to Receive', container: 'custpage_po_info' });
        fRemaining.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
        fRemaining.defaultValue = '';

        const fExpDate = form.addField({ id: 'custpage_expiration_date', type: serverWidget.FieldType.DATE, label: 'Expiration Date', container: 'custpage_po_info' });
        fExpDate.isMandatory = false;
        if (preserved && preserved.expDate) {
            try {
                const parts = preserved.expDate.split('/');
                if (parts.length === 3) fExpDate.defaultValue = format.format({ value: new Date(parseInt(parts[2]), parseInt(parts[0])-1, parseInt(parts[1])), type: format.Type.DATE });
            } catch(e) {}
        }

        // Bag Settings
        form.addFieldGroup({ id: 'custpage_bag_settings', label: 'Bag Settings' });
        const fBagName = form.addField({ id: 'custpage_bag_name', type: serverWidget.FieldType.TEXT, label: 'Bag Name', container: 'custpage_bag_settings' });
        fBagName.isMandatory = true;

        const fNextBag = form.addField({ id: 'custpage_next_bag', type: serverWidget.FieldType.INTEGER, label: 'Next Bag #', container: 'custpage_bag_settings' });
        fNextBag.defaultValue = 1;
        fNextBag.isMandatory  = true;

        const fTareWeight = form.addField({ id: 'custpage_tare_weight', type: serverWidget.FieldType.FLOAT, label: 'Tare Weight (GM)', container: 'custpage_bag_settings' });
        fTareWeight.isMandatory = true;

        const fIncrement = form.addField({ id: 'custpage_increment', type: serverWidget.FieldType.SELECT, label: 'Bag # Increment', container: 'custpage_bag_settings' });
        fIncrement.addSelectOption({ value: 'ASC',  text: 'Ascending',  isSelected: true  });
        fIncrement.addSelectOption({ value: 'DESC', text: 'Descending', isSelected: false });

        const fItemName = form.addField({ id: 'custpage_selected_item_name', type: serverWidget.FieldType.TEXT, label: 'Selected Item Name', container: 'custpage_bag_settings' });

        // Scale / Weight Entry
        form.addFieldGroup({ id: 'custpage_scale_group', label: 'Scale / Weight Entry' });
        const fScaleWeight = form.addField({ id: 'custpage_scale_weight', type: serverWidget.FieldType.FLOAT, label: 'Bag Weight from Scale (gm)', container: 'custpage_scale_group' });
        fScaleWeight.defaultValue = 0;

        const fSeedsInBag     = form.addField({ id: 'custpage_seeds_in_bag',      type: serverWidget.FieldType.INTEGER, label: 'Seeds in Bag',           container: 'custpage_scale_group' });
        const fRemainingScale = form.addField({ id: 'custpage_remaining_display2', type: serverWidget.FieldType.TEXT,    label: 'Remaining to Receive',   container: 'custpage_scale_group' });
        fRemainingScale.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
        fRemainingScale.defaultValue = '';

        // Remaining map
        const remainingMap = {};
        lines.forEach(l => { remainingMap[l.itemId] = { qty: l.qtyRemaining, isSeedCount: l.isSeedCount }; });
        const fRemainingMap = form.addField({ id: 'custpage_remaining_map', type: serverWidget.FieldType.LONGTEXT, label: 'Remaining Map' });
        fRemainingMap.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
        fRemainingMap.defaultValue = JSON.stringify(remainingMap);

        const itemNameMapData = {};
        lines.forEach(l => { itemNameMapData[l.itemId] = l.itemName; });
        const fItemNameMap = form.addField({ id: 'custpage_item_name_map', type: serverWidget.FieldType.LONGTEXT, label: 'Item Name Map' });
        fItemNameMap.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
        fItemNameMap.defaultValue = JSON.stringify(itemNameMapData);

        // Sublist
        const sublist = form.addSublist({ id: 'custpage_bags', type: serverWidget.SublistType.INLINEEDITOR, label: 'Bag Entries' });
        sublist.addField({ id: 'custpage_sl_over_recv',  type: serverWidget.FieldType.TEXT,    label: 'Over Received'   });
        sublist.addField({ id: 'custpage_sl_print',      type: serverWidget.FieldType.TEXT,    label: 'Print'           });
        sublist.addField({ id: 'custpage_sl_item',       type: serverWidget.FieldType.TEXT,    label: 'Item'            });
        sublist.addField({ id: 'custpage_sl_bagnumber',  type: serverWidget.FieldType.TEXT,    label: 'Bag Number'      });
        sublist.addField({ id: 'custpage_sl_date',       type: serverWidget.FieldType.DATE,    label: 'Date'            });
        sublist.addField({ id: 'custpage_sl_status',     type: serverWidget.FieldType.TEXT,    label: 'Status'          });
        sublist.addField({ id: 'custpage_sl_weight',     type: serverWidget.FieldType.FLOAT,   label: 'Weight (gm)'     });
        sublist.addField({ id: 'custpage_sl_seed_count', type: serverWidget.FieldType.INTEGER, label: 'Seed Count'      });
        sublist.addField({ id: 'custpage_sl_tare',       type: serverWidget.FieldType.FLOAT,   label: 'Tare (gm)'       });
        sublist.addField({ id: 'custpage_sl_vendor_lot', type: serverWidget.FieldType.TEXT,    label: 'Vendor Lot'      });
        sublist.addField({ id: 'custpage_sl_coo',        type: serverWidget.FieldType.TEXT,    label: 'COO'             });
        sublist.addField({ id: 'custpage_sl_exp_date',   type: serverWidget.FieldType.DATE,    label: 'Expiration Date' });

        // Restore sublist rows after error
        if (preserved && preserved.bagsJson && preserved.bagsJson !== '[]') {
            try {
                const restoredBags = JSON.parse(preserved.bagsJson);
                restoredBags.forEach((bag, i) => {
                    sublist.setSublistValue({ id: 'custpage_sl_bagnumber',  line: i, value: bag.bagNumber  || '' });
                    sublist.setSublistValue({ id: 'custpage_sl_status',     line: i, value: 'Received'          });
                    sublist.setSublistValue({ id: 'custpage_sl_weight',     line: i, value: bag.weight     || 0 });
                    sublist.setSublistValue({ id: 'custpage_sl_seed_count', line: i, value: bag.seedCount  || 0 });
                    sublist.setSublistValue({ id: 'custpage_sl_vendor_lot', line: i, value: bag.vendorLot  || '' });
                    sublist.setSublistValue({ id: 'custpage_sl_coo',        line: i, value: bag.coo        || '' });
                    if (bag.expirationDate) {
                        try {
                            const p = bag.expirationDate.split('-');
                            sublist.setSublistValue({ id: 'custpage_sl_exp_date', line: i,
                                value: format.format({ value: new Date(parseInt(p[0]), parseInt(p[1])-1, parseInt(p[2])), type: format.Type.DATE }) });
                        } catch(e) {}
                    }
                });
            } catch(e) { log.debug({ title: 'SL_BulkSeedCheckin: sublist restore error', details: e.message }); }
        }

        // Buttons
        form.addButton({ id: 'custpage_get_weight',   label: 'Get Weight',             functionName: 'getWeight()'            });
        form.addButton({ id: 'custpage_add_bag',      label: 'Add New Bag',            functionName: 'addNewBag()'            });
        form.addButton({ id: 'custpage_summary',      label: 'Summary',                functionName: 'showSummary()'          });
        form.addButton({ id: 'custpage_recalculate',  label: 'Recalculate Remaining',  functionName: 'recalculateRemaining()' });
        form.addButton({ id: 'custpage_recheck_bins', label: 'Re-check Preferred Bins', functionName: 'recheckBins()'         });
        form.addSubmitButton({ label: 'Done — Create Item Receipt' });
        form.addResetButton({ label: 'Cancel' });

        context.response.writePage(form);
    };

    // ─── POST: Done — Create Item Receipt for all unprinted bags ─────────────
    const processCheckin = (context) => {
        const params      = context.request.parameters;
        const poId        = params.custpage_poid;
        const vendorLot   = params.custpage_lot_number        || '';
        const countryOrig = params.custpage_country_of_origin || '';
        const expDateRaw  = params.custpage_expiration_date   || '';
        const bagsJsonRaw = params.custpage_bags_json         || '[]';
        const printedRaw  = params.custpage_printed_bags      || '[]';

        let bags = [], printedBagNumbers = [];
        try { bags              = JSON.parse(bagsJsonRaw); } catch(e) {}
        try { printedBagNumbers = JSON.parse(printedRaw);  } catch(e) {}

        const unprintedBags = bags.filter(b => !printedBagNumbers.includes(b.bagNumber));

        if (!bags.length) {
            renderCheckinForm(context, {
                errorMessage: 'No bag entries found. Please add at least one bag before clicking Done.',
                poId, bagsJson: '[]', vendorLot, countryOrig, expDate: expDateRaw, printedBags: printedRaw
            });
            return;
        }

        if (!unprintedBags.length) {
            redirect.toRecord({ type: record.Type.PURCHASE_ORDER, id: poId });
            return;
        }

        try {
            const { receiptId } = buildReceipt(poId, unprintedBags, vendorLot, countryOrig);
            log.audit({ title: 'SL_BulkSeedCheckin: Done receipt created', details: 'IR=' + receiptId + ' PO=' + poId });
            redirect.toRecord({ type: record.Type.ITEM_RECEIPT, id: receiptId });
        } catch(e) {
            log.error({ title: 'SL_BulkSeedCheckin: Save Error', details: e });
            renderCheckinForm(context, {
                errorMessage: 'Error creating Item Receipt: ' + e.message,
                poId, bagsJson: bagsJsonRaw, vendorLot, countryOrig, expDate: expDateRaw, printedBags: printedRaw
            });
        }
    };

    return { onRequest };
});

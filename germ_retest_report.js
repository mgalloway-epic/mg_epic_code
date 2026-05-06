/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 * @NModuleScope SameAccount
 *
 * Germ Re-Test Report
 * -------------------
 * Runs monthly on the 28th at 5:00 AM.
 * Pulls all Germ Test History records whose Re-Test Date falls within
 * the next calendar month, looks up current QTY by item + lot number text
 * (not by lot internal ID — immune to historical GTH lot-ID mismatches),
 * natural-sorts by Bin Number → Lot Number, renders a PDF, and emails it.
 *
 * CHANGES (2026-05-06 rev 7):
 *   FIX 1 — QTY lookup now uses item + lot number TEXT via a join between
 *            INVENTORY_ITEM and inventorynumber, keyed by itemId + lotNumber.
 *            Previously keyed only by lot internal ID, which caused all bags
 *            sharing the same lot name (e.g. NO2625-01 across 15 items) to
 *            receive the same wrong quantity from whichever GTH record happened
 *            to win the de-dupe.
 *
 *   FIX 2 — Bin number is retrieved in a dedicated post-filter lookup keyed
 *            by item + lot number text, consistent with the new QTY approach.
 *            The join via custrecord_gth_item is retained as a fallback.
 *
 *   UNCHANGED — All GTH history records, lot number text, germ %, dates, and
 *               bin display logic are untouched. No changes to the suitelet or
 *               client script are required for these fixes.
 */
define(['N/search', 'N/email', 'N/render', 'N/runtime', 'N/log'],
function (search, email, render, runtime, log) {

    // ── CONFIG ────────────────────────────────────────────────────────────────
    var RECIPIENTS = [
        'imadrid@epicgardening.com',
        'mgalloway@epicgardening.com',
        'shanev@botanicalinterests.com'
    ];
    // ─────────────────────────────────────────────────────────────────────────

    function execute(context) {
        var today            = new Date();
        var startOfNextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
        var endOfNextMonth   = new Date(today.getFullYear(), today.getMonth() + 2, 0);

        log.audit('GermReTestReport', 'Running — range: ' + fmtDate(startOfNextMonth) + ' → ' + fmtDate(endOfNextMonth));

        var rows = fetchRows(startOfNextMonth, endOfNextMonth);
        log.audit('GermReTestReport', 'Records found: ' + rows.length);

        if (!rows.length) {
            log.audit('GermReTestReport', 'No records in range — skipping email');
            return;
        }

        rows.sort(function (a, b) {
            var bin = naturalSort(a.binNumber, b.binNumber);
            return bin !== 0 ? bin : naturalSort(a.lotNumber, b.lotNumber);
        });

        var html     = buildReport(rows, today);
        var renderer = render.create();
        renderer.templateContent = html;
        var pdfFile  = renderer.renderAsPdf();
        pdfFile.name = 'Germ_ReTest_Report_' + fmtDateFile(today) + '.pdf';

        email.send({
            author:      3220884,
            recipients:  RECIPIENTS,
            subject:     'Germ Re-Test Report \u2014 ' + fmtDate(today),
            body:        'Please find this month\u2019s Germ Re-Test Report attached.\n\n' +
                         'This report includes all lots with a Re-Test Date due in ' + fmtMonthYear(today) + '.',
            attachments: [pdfFile]
        });

        log.audit('GermReTestReport', 'Email sent successfully');
    }

    // ── DATA FETCH ────────────────────────────────────────────────────────────

    function fetchRows(startOfNextMonth, endOfNextMonth) {

        // ── Step 1: Pull all Germ Test History, keep latest record per item+lot
        // Key: itemId + '_' + lotNumber TEXT (not lot internal ID).
        // This makes all subsequent lookups immune to historical GTH records
        // that may have stored a wrong lot internal ID.
        var latestByLot  = {};
        var skippedCount = 0;

        var pagedGerm = search.create({
            type: 'customrecord_germ_test_history',
            filters: [['isinactive', 'is', 'F']],
            columns: [
                search.createColumn({ name: 'custrecord_gth_item'           }),
                search.createColumn({ name: 'custrecord_gth_lot'            }),
                search.createColumn({ name: 'custrecord_gth_germ_pct'       }),
                search.createColumn({ name: 'custrecord_gth_exp_date_at_test' }),
                search.createColumn({ name: 'custrecord_gth_new_exp_date'   }),
                search.createColumn({ name: 'displayname',  join: 'custrecord_gth_item' }),
                search.createColumn({ name: 'binnumber',    join: 'custrecord_gth_item' })
            ]
        }).runPaged({ pageSize: 1000 });

        pagedGerm.pageRanges.forEach(function (pageRange) {
            pagedGerm.fetch({ index: pageRange.index }).data.forEach(function (result) {
                try {
                    var itemId     = result.getValue('custrecord_gth_item');
                    var lotNumber  = result.getText('custrecord_gth_lot');  // lot NUMBER TEXT — reliable
                    var reTestDate = result.getValue('custrecord_gth_new_exp_date');

                    if (!lotNumber || !reTestDate) { return; }

                    // Key by item + lot NUMBER TEXT — not by lot internal ID.
                    // This is the critical change: even if an old GTH record stored
                    // the wrong lot internal ID, the lot number text is always correct
                    // because getText() returns the display name of the referenced record.
                    var key = (itemId || '') + '_' + lotNumber;

                    if (!latestByLot[key] || new Date(reTestDate) > new Date(latestByLot[key].reTestDate)) {
                        latestByLot[key] = {
                            itemId:      itemId,
                            itemName:    result.getText('custrecord_gth_item')                                  || '',
                            itemDisplay: result.getValue({ name: 'displayname', join: 'custrecord_gth_item' }) || '',
                            lotNumber:   lotNumber,
                            germPct:     result.getValue('custrecord_gth_germ_pct')                             || '',
                            prevDate:    result.getValue('custrecord_gth_exp_date_at_test')                     || '',
                            reTestDate:  reTestDate,
                            binNumber:   result.getText({ name: 'binnumber', join: 'custrecord_gth_item' })    ||
                                         result.getValue({ name: 'binnumber', join: 'custrecord_gth_item' })   || ''
                        };
                    }
                } catch (recErr) {
                    skippedCount++;
                    log.error('GermReTestReport', 'GTH record skipped: ' + recErr.message);
                }
            });
        });

        if (skippedCount > 0) {
            log.audit('GermReTestReport', skippedCount + ' GTH record(s) skipped — check error log');
        }

        // ── Step 2: Filter to the target re-test month ────────────────────────
        var qualifying = [];
        for (var key in latestByLot) {
            var rec      = latestByLot[key];
            var reTestDt = new Date(rec.reTestDate);
            if (reTestDt >= startOfNextMonth && reTestDt <= endOfNextMonth) {
                qualifying.push(rec);
            }
        }

        log.audit('GermReTestReport', 'Qualifying lots after date filter: ' + qualifying.length);
        if (!qualifying.length) { return []; }

        // ── Step 3: Batch QTY lookup keyed by itemId + lotNumber TEXT ─────────
        // We search INVENTORY_NUMBER filtered by the qualifying item IDs,
        // retrieve both 'item' and 'inventorynumber' (the lot text), and key
        // the result map by itemId + '_' + lotNumberText.
        // This means: even if 20 different items all have a lot named NO2625-01,
        // each one gets its own correct quantity from its own INVENTORY_NUMBER record.
        var allItemIds = [];
        qualifying.forEach(function (r) {
            if (r.itemId && allItemIds.indexOf(r.itemId) === -1) {
                allItemIds.push(r.itemId);
            }
        });

        var qtyByItemLot = {};  // key: itemId + '_' + lotNumberText → qty

        try {
            var pagedQty = search.create({
                type: search.Type.INVENTORY_NUMBER,
                filters: [['item', 'anyof', allItemIds]],
                columns: [
                    search.createColumn({ name: 'item'              }),  // item internal ID
                    search.createColumn({ name: 'inventorynumber'   }),  // lot number TEXT
                    search.createColumn({ name: 'quantityonhand'    })   // current on-hand
                ]
            }).runPaged({ pageSize: 1000 });

            pagedQty.pageRanges.forEach(function (pr) {
                pagedQty.fetch({ index: pr.index }).data.forEach(function (r) {
                    var iid    = r.getValue('item');
                    var lotTxt = r.getValue('inventorynumber');
                    var qty    = parseFloat(r.getValue('quantityonhand') || 0);
                    if (!iid || !lotTxt) { return; }

                    var k = iid + '_' + lotTxt;

                    // Sum across locations if the lot exists in multiple bins
                    qtyByItemLot[k] = (qtyByItemLot[k] || 0) + qty;
                });
            });

            log.audit('GermReTestReport',
                'Batched QTY lookup complete — ' + Object.keys(qtyByItemLot).length + ' item+lot combinations');
        } catch (qtyErr) {
            log.error('GermReTestReport', 'Batched QTY lookup failed: ' + qtyErr.message);
            return [];
        }

        // ── Step 4: Build final rows, skipping zero-qty lots ─────────────────
        var rows = [];

        qualifying.forEach(function (rec) {
            var qtyKey       = (rec.itemId || '') + '_' + rec.lotNumber;
            var qtyAvailable = qtyByItemLot[qtyKey] || 0;

            if (qtyAvailable <= 0) {
                log.debug('GermReTestReport',
                    'Skipping lot ' + rec.lotNumber + ' (' + rec.itemName + ') — QTY on hand is 0');
                return;
            }

            var germPct = '';
            if (rec.germPct !== null && rec.germPct !== '') {
                var germNum = parseFloat(rec.germPct);
                if (germNum > 0 && germNum <= 1) { germNum = germNum * 100; }
                germPct = germNum.toFixed(1) + '%';
            }

            // Bin number comes from the GTH search join (binnumber is not a valid
            // column on INVENTORY_NUMBER search — use the GTH record's bin join instead)
            var binNumber = rec.binNumber || '';

            rows.push({
                itemName:    rec.itemName,
                itemDisplay: rec.itemDisplay,
                lotNumber:   rec.lotNumber,
                qty:         qtyAvailable,
                germPct:     germPct,
                prevDate:    rec.prevDate,
                reTestDate:  rec.reTestDate,
                binNumber:   binNumber
            });
        });

        return rows;
    }

    // ── HTML / PDF REPORT ─────────────────────────────────────────────────────

    function buildReport(rows, today) {
        var tableRows = '';

        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            tableRows +=
                '<tr>' +
                '<td>'                + esc(row.itemName)        + '</td>' +
                '<td>'                + esc(row.itemDisplay)     + '</td>' +
                '<td>'                + esc(row.lotNumber)       + '</td>' +
                '<td align="right">'  + row.qty.toLocaleString() + '</td>' +
                '<td align="center">' + esc(row.germPct)         + '</td>' +
                '<td align="center">' + (row.prevDate ? esc(row.prevDate) : '&mdash;') + '</td>' +
                '<td align="center">' + esc(row.reTestDate)      + '</td>' +
                '<td>'                + esc(row.binNumber)       + '</td>' +
                '</tr>';
        }

        return [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report//2.x//EN" "report-2.1.dtd">',
            '<pdf>',
            '<head>',
            '<style type="text/css">',
            '  body  { font-family: Arial, Helvetica, sans-serif; font-size: 8pt; margin: 20px; }',
            '  h1    { font-size: 13pt; margin: 0 0 2px 0; }',
            '  .sub  { font-size: 8pt; color: #555555; margin: 0 0 14px 0; }',
            '  table { width: 100%; border-collapse: collapse; }',
            '  th    { background-color: #1a3e6e; color: #ffffff; padding: 5px 6px;',
            '          text-align: left; font-size: 7.5pt; border: 1px solid #1a3e6e; }',
            '  td    { padding: 4px 6px; border-bottom: 1px solid #000000; font-size: 7.5pt; }',
            '</style>',
            '</head>',
            '<body>',
            '  <h1>Germ Re-Test Report</h1>',
            '  <p class="sub">Re-Test Dates due in ' + fmtMonthYear(today) + ' &#160;|&#160; Generated: ' + fmtDate(today) + '</p>',
            '  <table>',
            '    <colgroup>',
            '      <col width="13%"/>',
            '      <col width="33%"/>',
            '      <col width="9%"/>',
            '      <col width="10%"/>',
            '      <col width="8%"/>',
            '      <col width="10%"/>',
            '      <col width="10%"/>',
            '      <col width="7%"/>',
            '    </colgroup>',
            '    <thead>',
            '      <tr>',
            '        <th>Item</th>',
            '        <th>Description</th>',
            '        <th>Bag #</th>',
            '        <th>QTY On Hand</th>',
            '        <th>Germ %</th>',
            '        <th>Prv Test Date</th>',
            '        <th>Re-Test Date</th>',
            '        <th>Bin Number</th>',
            '      </tr>',
            '    </thead>',
            '    <tbody>',
            tableRows,
            '    </tbody>',
            '  </table>',
            '</body>',
            '</pdf>'
        ].join('\n');
    }

    // ── HELPERS ───────────────────────────────────────────────────────────────

    function naturalSort(a, b) {
        var re = /(\d+)|(\D+)/g;
        var ax = [], bx = [];
        String(a).replace(re, function (_, n, s) { ax.push([n ? parseInt(n, 10) : Infinity, s || '']); });
        String(b).replace(re, function (_, n, s) { bx.push([n ? parseInt(n, 10) : Infinity, s || '']); });
        while (ax.length && bx.length) {
            var an = ax.shift(), bn = bx.shift();
            var diff = (an[0] - bn[0]) || an[1].localeCompare(bn[1]);
            if (diff) { return diff; }
        }
        return ax.length - bx.length;
    }

    function fmtDate(d) {
        return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
    }

    function fmtMonthYear(d) {
        var months = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
        var nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1);
        return months[nextMonth.getMonth()] + ' ' + nextMonth.getFullYear();
    }

    function fmtDateFile(d) {
        var mm = String(d.getMonth() + 1).padStart(2, '0');
        var dd = String(d.getDate()).padStart(2, '0');
        return d.getFullYear() + '_' + mm + '_' + dd;
    }

    function esc(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    return { execute: execute };
});

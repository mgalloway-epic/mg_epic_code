/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 * @NModuleScope SameAccount
 *
 * Germ Re-Test Report
 * -------------------
 * Runs monthly on the 28th at 5:00 AM.
 * Pulls all Germ Test History records whose Re-Test Date falls within
 * the next 30 days, looks up the correct Quantity On Hand per lot
 * (bypassing the saved-search join aggregation bug), natural-sorts by
 * Bin Number → Lot Number, adds a blank separator row between items,
 * renders an HTML file attachment, and emails it to the configured recipients.
 */
define(['N/search', 'N/email', 'N/render', 'N/runtime', 'N/log'],
function (search, email, render, runtime, log) {

    // ── CONFIG ────────────────────────────────────────────────────────────────
    // Update these to the real email addresses before deploying.
    var RECIPIENTS = [
        'imadrid@epicgardening.com',        // Isaiah Madrid
        'mgalloway@epicgardening.com',      // Mason Galloway
        'shanev@botanicalinterests.com'     // Shane Van De Boogaard
    ];
    // ─────────────────────────────────────────────────────────────────────────

    function execute(context) {
        var today        = new Date();
        var startOfNextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
        var endOfNextMonth   = new Date(today.getFullYear(), today.getMonth() + 2, 0); // day 0 = last day of prior month

        log.audit('GermReTestReport', 'Running — range: ' + fmtDate(startOfNextMonth) + ' → ' + fmtDate(endOfNextMonth));

        var rows = fetchRows(startOfNextMonth, endOfNextMonth);
        log.audit('GermReTestReport', 'Records found: ' + rows.length);

        if (!rows.length) {
            log.audit('GermReTestReport', 'No records in range — skipping email');
            return;
        }

        // Natural sort: Bin Number first, then Lot Number
        rows.sort(function (a, b) {
            var bin = naturalSort(a.binNumber, b.binNumber);
            return bin !== 0 ? bin : naturalSort(a.lotNumber, b.lotNumber);
        });

        var html = buildReport(rows, today);

        // Use render.create() with NetSuite's BFO PDF format.
        // Note: render.htmlToPdf is not available in all accounts —
        // render.create() with a <pdf> root element is the correct alternative.
        var renderer = render.create();
        renderer.templateContent = html;
        var pdfFile = renderer.renderAsPdf();
        pdfFile.name = 'Germ_ReTest_Report_' + fmtDateFile(today) + '.pdf';

        email.send({
            author:      3220884, // Mason Galloway
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
        var latestByLot = {}; // keyed by lotId, keeps only the newest GTH record per lot

        // Pull ALL active germ test records first — we deduplicate before date
        // filtering so an old record doesn't appear just because its re-test date
        // falls in the target month when a newer record exists for the same lot.
        var germSearch = search.create({
            type: 'customrecord_germ_test_history',
            filters: [['isinactive', 'is', 'F']],
            columns: [
                search.createColumn({ name: 'custrecord_gth_item' }),
                search.createColumn({ name: 'custrecord_gth_lot' }),
                search.createColumn({ name: 'custrecord_gth_germ_pct' }),
                search.createColumn({ name: 'custrecord_gth_exp_date_at_test' }),
                search.createColumn({ name: 'custrecord_gth_new_exp_date' }),
                search.createColumn({ name: 'custrecord_gth_vendor_lot' }),
                search.createColumn({ name: 'displayname', join: 'custrecord_gth_item' }),
                search.createColumn({ name: 'binnumber',   join: 'custrecord_gth_item' })
            ]
        });

        var pagedResults = germSearch.runPaged({ pageSize: 1000 });

        pagedResults.pageRanges.forEach(function (pageRange) {
            var page = pagedResults.fetch({ index: pageRange.index });
            page.data.forEach(function (result) {
                var lotId      = result.getValue('custrecord_gth_lot');
                var reTestDate = result.getValue('custrecord_gth_new_exp_date');

                if (!lotId || !reTestDate) { return; }

                // Keep only the newest re-test date per lot
                if (!latestByLot[lotId] || new Date(reTestDate) > new Date(latestByLot[lotId].reTestDate)) {
                    latestByLot[lotId] = {
                        itemId:      result.getValue('custrecord_gth_item'),
                        itemName:    result.getText('custrecord_gth_item')                                  || '',
                        itemDisplay: result.getValue({ name: 'displayname', join: 'custrecord_gth_item' }) || '',
                        lotId:       lotId,
                        lotNumber:   result.getText('custrecord_gth_lot')                                   || '',
                        germPct:     result.getValue('custrecord_gth_germ_pct')                             || '',
                        prevDate:    result.getValue('custrecord_gth_exp_date_at_test')                     || '',
                        reTestDate:  reTestDate,
                        vendorLot:   result.getValue('custrecord_gth_vendor_lot')                           || '',
                        binNumber:   result.getText({ name: 'binnumber', join: 'custrecord_gth_item' })     ||
                                     result.getValue({ name: 'binnumber', join: 'custrecord_gth_item' })    || ''
                    };
                }
            });
        });

        // Filter to lots whose newest re-test date falls in next month,
        // then do the quantity lookup for those lots only
        var rows = [];

        for (var id in latestByLot) {
            var rec      = latestByLot[id];
            var reTestDt = new Date(rec.reTestDate);

            if (reTestDt < startOfNextMonth || reTestDt > endOfNextMonth) { continue; }

            // Quantity lookup
            var qtyOnHand = 0;
            try {
                var invFields = search.lookupFields({
                    type:    search.Type.INVENTORY_NUMBER,
                    id:      id,
                    columns: ['quantityonhand']
                });
                qtyOnHand = parseFloat(invFields.quantityonhand || 0);
            } catch (e) {
                log.error('GermReTestReport', 'Qty lookup failed for lot ID ' + id + ': ' + e.message);
            }

            // Germ % formatting
            var germPct = '';
            if (rec.germPct !== null && rec.germPct !== '') {
                var germNum = parseFloat(rec.germPct);
                if (germNum > 0 && germNum <= 1) { germNum = germNum * 100; }
                germPct = germNum.toFixed(1) + '%';
            }

            rows.push({
                itemId:      rec.itemId,
                itemName:    rec.itemName,
                itemDisplay: rec.itemDisplay,
                lotNumber:   rec.lotNumber,
                qty:         qtyOnHand,
                germPct:     germPct,
                prevDate:    rec.prevDate,
                reTestDate:  rec.reTestDate,
                vendorLot:   rec.vendorLot,
                binNumber:   rec.binNumber
            });
        }

        return rows;
    }

    // ── HTML / PDF REPORT ─────────────────────────────────────────────────────

    function buildReport(rows, today) {
        var tableRows = '';
        var lastItemId = null;

        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];



            tableRows +=
                '<tr>' +
                '<td>'             + esc(row.itemName)    + '</td>' +
                '<td>'             + esc(row.itemDisplay)  + '</td>' +
                '<td>'             + esc(row.lotNumber)    + '</td>' +
                '<td align="right">'  + row.qty.toLocaleString() + '</td>' +
                '<td align="center">' + esc(row.germPct)     + '</td>' +
                '<td align="center">' + esc(row.prevDate)    + '</td>' +
                '<td align="center">' + esc(row.reTestDate)  + '</td>' +
                '<td>'             + esc(row.vendorLot)    + '</td>' +
                '<td>'             + esc(row.binNumber)    + '</td>' +
                '</tr>';

            lastItemId = row.itemId;
        }

        // NetSuite BFO renderer requires <pdf> root element — plain <html> causes UNEXPECTED_ERROR
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
            '      <col width="12%"/>',
            '      <col width="28%"/>',
            '      <col width="8%"/>',
            '      <col width="9%"/>',
            '      <col width="7%"/>',
            '      <col width="9%"/>',
            '      <col width="9%"/>',
            '      <col width="7%"/>',
            '      <col width="11%"/>',
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
            '        <th>Vendor Lot</th>',
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

    /**
     * Natural sort comparator.
     * Splits strings into alternating numeric / non-numeric chunks and
     * compares numerics as integers so that "BS-10-B-01" < "BS-12-D-02"
     * even though "1" > "12" lexicographically.
     */
    function naturalSort(a, b) {
        var re = /(\d+)|(\D+)/g;
        var ax = [], bx = [];
        String(a).replace(re, function (_, n, s) { ax.push([n ? parseInt(n, 10) : Infinity, s || '']); });
        String(b).replace(re, function (_, n, s) { bx.push([n ? parseInt(n, 10) : Infinity, s || '']); });
        while (ax.length && bx.length) {
            var an = ax.shift(), bn = bx.shift();
            var diff = (an[0] - bn[0]) || an[1].localeCompare(bn[1]);
            if (diff) return diff;
        }
        return ax.length - bx.length;
    }

    /** Format a Date as M/D/YYYY */
    function fmtDate(d) {
        return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
    }

    /** Format a Date as "Month YYYY" (e.g. "May 2026") */
    function fmtMonthYear(d) {
        var months = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
        var nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1);
        return months[nextMonth.getMonth()] + ' ' + nextMonth.getFullYear();
    }

    /** Format a Date as YYYY_MM_DD for use in file names */
    function fmtDateFile(d) {
        var mm = String(d.getMonth() + 1).padStart(2, '0');
        var dd = String(d.getDate()).padStart(2, '0');
        return d.getFullYear() + '_' + mm + '_' + dd;
    }

    /** Escape special HTML characters */
    function esc(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    return { execute: execute };
});
/**
 * SL_PrintBagTag.js
 * Suitelet — Bulk Seed Bag Tag Label Printer
 * Label size: 6in wide x 4in tall (landscape)
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define(['N/log'], (log) => {

    const onRequest = (context) => {
        if (context.request.method !== 'GET') return;

        const p            = context.request.parameters;
        const bagNumber    = p.bagNumber    || '';
        const itemName     = p.itemName     || '';
        const weight       = p.weight       || '0';
        const seedCount    = p.seedCount    || '0';
        const isSeedCount  = p.isSeedCount  === 'true';
        const vendorLot    = p.vendorLot    || '';
        const coo          = p.coo          || '';
        const expDate      = p.expDate      || '';
        const tareWeight   = p.tareWeight   || '0';
        const preferredBin = p.preferredBin || 'N/A';
        const poNumber     = p.poNumber     || '';
        const date         = p.date         || '';
        const description  = p.description  || '';

        // Format expiration date
        let expDisplay = 'N/A';
        if (expDate) {
            try {
                let d;
                if (expDate.includes('-') && expDate.indexOf('-') === 4) {
                    const parts = expDate.substring(0, 10).split('-');
                    d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                } else {
                    const parts = expDate.split('/');
                    d = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
                }
                if (!isNaN(d.getTime())) {
                    expDisplay = (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
                }
            } catch(e) { expDisplay = expDate; }
        }

        const qtyDisplay = isSeedCount
            ? parseInt(seedCount).toLocaleString() + ' Seeds'
            : parseFloat(weight).toLocaleString() + ' Gram';

        const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

        const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Bag Tag - ${esc(bagNumber)}</title>
<style>
  /* Remove all browser print headers/footers and margins */
  @page {
    size: 6in 4in landscape;
    margin: 0;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  html, body {
    font-family: Helvetica, Arial, sans-serif;
    background: #fff;
    width: 6in;
    height: 4in;
    overflow: hidden;
  }

  .label {
    position: absolute;
    top: 0;
    left: 0;
    width: 6in;
    height: 4in;
    border: 2px solid #000;
    display: flex;
    flex-direction: column;
  }

  .item-header {
    background: #e0e0e0;
    font-weight: bold;
    font-size: 12pt;
    padding: 3pt 8pt;
    border-bottom: 1.5px solid #000;
    flex-shrink: 0;
  }

  .barcode-row {
    border-bottom: 1.5px solid #000;
    text-align: center;
    padding: 1pt 0;
    background: #fff;
    flex-shrink: 0;
  }

  .desc-row {
    padding: 2pt 8pt;
    font-size: 9pt;
    border-bottom: 1.5px solid #000;
    flex-shrink: 0;
  }

  .lot-header {
    display: flex;
    align-items: center;
    padding: 2pt 8pt;
    border-bottom: 1.5px solid #000;
    background: #f5f5f5;
    flex-shrink: 0;
  }
  .lot-header .lbl { font-weight: bold; font-size: 9pt; min-width: 38%; }
  .lot-header .val { font-size: 9pt; }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    flex: 1;
  }
  .data-table td {
    font-size: 9pt;
    padding: 2pt 8pt;
    border-bottom: 1px solid #000;
    vertical-align: middle;
  }
  .data-table tr:last-child td { border-bottom: none; }
  .data-table .lbl {
    font-weight: bold;
    width: 38%;
    border-right: 1.5px solid #000;
    background: #f5f5f5;
  }
  .data-table .val { width: 62%; }

  .print-btn {
    display: block;
    margin: 8pt auto;
    padding: 6pt 20pt;
    background: #1a6ebf;
    color: #fff;
    border: none;
    border-radius: 4px;
    font-size: 11pt;
    cursor: pointer;
  }
  @media print {
    .print-btn { display: none !important; }
    html, body { width: 6in; height: 4in; }
  }
</style>
</head>
<body>

<button class="print-btn" onclick="window.print()">🖨 Print Label</button>

<div class="label">

  <div class="item-header">Item Number: ${esc(itemName)}</div>

  <div class="barcode-row"><svg id="item-bc"></svg></div>

  <div class="desc-row">${esc(description) || '&nbsp;'}</div>

  <div class="lot-header">
    <span class="lbl">Lot Number (Bag #):</span>
    <span class="val">${esc(bagNumber)}</span>
  </div>

  <div class="barcode-row"><svg id="lot-bc"></svg></div>

  <table class="data-table">
    <tr>
      <td class="lbl">Initial Quantity:</td>
      <td class="val">${esc(qtyDisplay)}</td>
    </tr>
    <tr>
      <td class="lbl">Tare Weight:</td>
      <td class="val">${esc(tareWeight)} gm</td>
    </tr>
    <tr>
      <td class="lbl">Preferred Bin:</td>
      <td class="val">${esc(preferredBin)}</td>
    </tr>
    <tr>
      <td class="lbl">Receiving Reference:</td>
      <td class="val">${esc(poNumber)}</td>
    </tr>
    <tr>
      <td class="lbl">Exp Date: <span style="font-weight:normal;">${esc(expDisplay)}</span></td>
      <td style="border-left:1.5px solid #000;" class="lbl">Date Received: <span style="font-weight:normal;">${esc(date)}</span></td>
    </tr>
  </table>

</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.6/JsBarcode.all.min.js"></script>
<script>
  window.onload = function() {
    try {
      JsBarcode('#item-bc', ${JSON.stringify(itemName || 'ITEM')}, {
        format: 'CODE128', displayValue: false,
        width: 2, height: 38, margin: 4
      });
    } catch(e) {}
    try {
      JsBarcode('#lot-bc', ${JSON.stringify(bagNumber || 'LOT')}, {
        format: 'CODE128', displayValue: false,
        width: 2, height: 38, margin: 4
      });
    } catch(e) {}
  };
</script>
</body>
</html>`;

        context.response.write(html);
    };

    return { onRequest };
});

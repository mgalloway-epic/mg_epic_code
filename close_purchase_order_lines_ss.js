/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 * @NModuleScope SameAccount
 */

/**
 * Scheduled Script to close Purchase Order line items based on saved search results.
 * Runs monthly to close PO lines from the "Close Test Vendor Purchase Orders" saved search,
 * excluding lines where the vendor is "Test Vendor".
 */
define(['N/search', 'N/record', 'N/log'], (search, record, log) => {

    /**
     * Main execution function for the Scheduled Script
     * @param {Object} scriptContext
     * @param {string} scriptContext.type - The context in which the script is executed
     */
    const execute = (scriptContext) => {
        log.audit('Script Start', 'Beginning Close Purchase Order Lines process');

        try {
            // Load the saved search by name
            const savedSearchId = 'customsearch_close_test_vendor_po'; // Update with your saved search ID
            // Alternatively, you can search by name:
            // const savedSearch = search.load({ id: 'Close Test Vendor Purchase Orders' });

            const poSearch = search.load({ id: savedSearchId });

            // Object to track PO lines to close, grouped by PO Internal ID
            const poLinesToClose = {};

            // Run the search and process results
            const searchResultSet = poSearch.run();
            let searchResults = [];
            let start = 0;
            const pageSize = 1000;

            // Paginate through all results
            do {
                searchResults = searchResultSet.getRange({ start: start, end: start + pageSize });

                searchResults.forEach((result) => {
                    // Get values from search results
                    // Adjust these column names/indexes based on your actual saved search columns
                    const poInternalId = result.getValue({ name: 'internalid' }) ||
                                        result.getValue(result.columns[0]);
                    const vendorName = result.getText({ name: 'entity' }) ||
                                      result.getText({ name: 'vendor' }) ||
                                      result.getValue({ name: 'vendorname' }) ||
                                      result.getText(result.columns[1]);
                    const lineItem = result.getValue({ name: 'item' }) ||
                                    result.getValue(result.columns[2]);
                    const lineId = result.getValue({ name: 'line' }) ||
                                  result.getValue({ name: 'linesequencenumber' });

                    // Filter out "Test Vendor" lines
                    if (vendorName && vendorName.toLowerCase() === 'test vendor') {
                        log.debug('Skipping Test Vendor Line', `PO: ${poInternalId}, Item: ${lineItem}`);
                        return; // Skip this line
                    }

                    // Group lines by PO Internal ID
                    if (!poLinesToClose[poInternalId]) {
                        poLinesToClose[poInternalId] = [];
                    }

                    poLinesToClose[poInternalId].push({
                        item: lineItem,
                        lineId: lineId
                    });
                });

                start += pageSize;
            } while (searchResults.length === pageSize);

            log.audit('Search Complete', `Found ${Object.keys(poLinesToClose).length} Purchase Orders to process`);

            // Process each Purchase Order
            let successCount = 0;
            let errorCount = 0;

            for (const poId in poLinesToClose) {
                try {
                    closePurchaseOrderLines(poId, poLinesToClose[poId]);
                    successCount++;
                    log.audit('PO Processed', `Successfully closed lines on PO Internal ID: ${poId}`);
                } catch (e) {
                    errorCount++;
                    log.error('PO Processing Error', `Error processing PO ${poId}: ${e.message}`);
                }
            }

            log.audit('Script Complete', `Processed ${successCount} POs successfully, ${errorCount} errors`);

        } catch (e) {
            log.error('Script Error', `Fatal error in scheduled script: ${e.message}`);
            throw e;
        }
    };

    /**
     * Closes specified line items on a Purchase Order
     * @param {string} poInternalId - The internal ID of the Purchase Order
     * @param {Array} linesToClose - Array of line objects with item/lineId info
     */
    const closePurchaseOrderLines = (poInternalId, linesToClose) => {
        // Load the Purchase Order record
        const poRecord = record.load({
            type: record.Type.PURCHASE_ORDER,
            id: poInternalId,
            isDynamic: false
        });

        const lineCount = poRecord.getLineCount({ sublistId: 'item' });

        // Iterate through lines and close matching ones
        for (let i = 0; i < lineCount; i++) {
            const lineItem = poRecord.getSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            });

            const lineNum = poRecord.getSublistValue({
                sublistId: 'item',
                fieldId: 'line',
                line: i
            });

            // Check if this line should be closed
            const shouldClose = linesToClose.some((lineToClose) => {
                // Match by item ID or line number
                return lineToClose.item == lineItem || lineToClose.lineId == lineNum;
            });

            if (shouldClose) {
                // Set the line to closed
                poRecord.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'isclosed',
                    line: i,
                    value: true
                });

                log.debug('Line Closed', `PO ${poInternalId}, Line ${i}, Item ${lineItem}`);
            }
        }

        // Save the Purchase Order
        const savedId = poRecord.save({
            enableSourcing: true,
            ignoreMandatoryFields: false
        });

        return savedId;
    };

    return { execute };
});

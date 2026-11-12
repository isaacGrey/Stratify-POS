import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

const cash = cents => Number(cents) / 100;
const number = value => Number(value);
const col = (key, label, format, width = 18) => ({ key, label, format, width });
const currency = (key, label) => col(key, label, cash);

function sections(report) {
    return [
        ['Summary', [col('metric', 'Metric', null, 28), col('value', 'Value')], [
            { metric: 'Paid orders', value: report.summary.orders },
            ...[['Revenue', 'revenue_cents'], ['Discounts', 'discount_cents'], ['Tax', 'tax_cents'],
                ['Service charge', 'service_cents'], ['Recorded expenses', 'expenses_cents']]
                .map(([label, key]) => ({ metric: label + ' (PHP)', value: cash(report.summary[key]) }))
        ]],
        ['Sales trend', [col('day', 'Period'), col('orders', 'Orders', number), currency('revenue', 'Sales (PHP)')], report.daily],
        ['Product performance', [col('name', 'Product', null, 30), col('variation', 'Variation', null, 25),
            col('units', 'Units', number), currency('sales', 'Gross item sales (PHP)')], report.top],
        ['Cashiers', [col('name', 'Cashier', null, 30), col('orders', 'Orders', number), currency('sales', 'Sales (PHP)')], report.cashiers],
        ['Promotions', [col('code', 'Code', null, 30), col('orders', 'Orders', number),
            currency('discount_cents', 'Discounts (PHP)')], report.discounts],
        ['Transactions', [col('order_number', 'Order #'), col('local_time', 'Local time', null, 24),
            col('branch', 'Branch', null, 26), col('cashier', 'Cashier', null, 25), col('status', 'Status'),
            col('payment_method', 'Method'), currency('subtotal_cents', 'Subtotal (PHP)'),
            currency('discount_cents', 'Discount (PHP)'), currency('tax_cents', 'Tax (PHP)'),
            currency('service_cents', 'Service (PHP)'), currency('total_cents', 'Total (PHP)'),
            col('promo_code', 'Promo code')], report.transactions],
        ['Current inventory', [col('name', 'Item', null, 30), col('category', 'Category', null, 25),
            col('unit', 'Unit'), col('quantity', 'Balance', number), col('low_stock_at', 'Reorder point', number)], report.balances],
        ['Stock movements', [col('local_time', 'Local time', null, 24), col('name', 'Item', null, 26),
            col('branch', 'Branch', null, 26), col('unit', 'Unit', null, 10),
            col('delta', 'Change', number), col('movement_type', 'Type'),
            col('reason', 'Reason', null, 35), col('reference_id', 'Reference', null, 38)], report.movements]
    ];
}

const value = (column, row) => {
    const cell = row[column.key];
    return cell == null ? '' : column.format ? column.format(cell) : cell;
};

export async function excelReport(report) {
    const book = new ExcelJS.Workbook();
    book.creator = 'StratifyPOS';
    const filters = book.addWorksheet('Filters');
    filters.columns = [{ width: 22 }, { width: 36 }];
    filters.addRows([
        ['StratifyPOS report'], ['From', report.filters.from], ['Through', report.filters.to],
        ['Time zone', report.filters.zone], ['Branch', report.filters.branch_name || 'All branches']
    ]);
    for (const [name, columns, rows] of sections(report)) {
        const sheet = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
        sheet.columns = columns.map(column => ({ header: column.label, width: column.width,
            style: column.format === cash ? { numFmt: '#,##0.00' } : {} }));
        sheet.getRow(1).font = { bold: true };
        sheet.addRows(rows.map(row => columns.map(column => value(column, row))));
        sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    }
    return book.xlsx.writeBuffer();
}

export function pdfReport(report) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.fontSize(19).text('StratifyPOS report');
        doc.fontSize(10).text(report.filters.from + ' through ' + report.filters.to + '  |  ' +
            report.filters.zone + '  |  ' + (report.filters.branch_name || 'All branches'));
        for (const [name, columns, records] of sections(report)) {
            doc.moveDown();
            if (doc.y + 56 > doc.page.height - doc.page.margins.bottom) doc.addPage();
            doc.fontSize(12).text(name);
            if (!records.length) {
                doc.fontSize(9).text('No records');
                continue;
            }
            doc.fontSize(8);
            doc.table({
                maxWidth: doc.page.width - 60,
                columnStyles: columns.map(() => '*'),
                defaultStyle: { padding: 3, border: [0, 0, 0.4, 0], borderColor: '#d4dce3' },
                rowStyles: index => index === 0 ? { backgroundColor: '#e8eff5' } : {},
                data: [
                    columns.map(column => column.label),
                    ...records.map(row => columns.map(column => {
                        const cell = value(column, row);
                        return column.format === cash && typeof cell === 'number' ? cell.toFixed(2) : String(cell);
                    }))
                ]
            });
        }
        doc.end();
    });
}

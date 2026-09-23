/**
 * parse-excel.js
 * Baca file Excel Indikator Makro BPS Jeneponto
 * dan simpan ke db/indikator.json
 */
const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');

const EXCEL_FILE = path.join(__dirname, '..', '7304 Indikator Makro BPS Jeneponto.xlsx');
const OUT_FILE   = path.join(__dirname, 'db', 'indikator.json');

if (!fs.existsSync(EXCEL_FILE)) {
  console.error('File tidak ditemukan:', EXCEL_FILE);
  process.exit(1);
}

const wb = XLSX.readFile(EXCEL_FILE, { cellDates: true, cellNF: true, cellText: false });
const result = {};

wb.SheetNames.forEach(sheetName => {
  const ws   = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
  result[sheetName] = rows;
  console.log(`  Sheet "${sheetName}": ${rows.length} baris`);
});

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), 'utf-8');
console.log(`\nDisimpan ke: ${OUT_FILE}`);

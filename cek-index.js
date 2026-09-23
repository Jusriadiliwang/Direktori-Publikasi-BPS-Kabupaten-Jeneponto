// cek-index.js — Pastikan semua data (PDF upload) sudah masuk index chat bot.
// Jalankan: node cek-index.js
const fs = require('fs');
const path = require('path');

const DB = path.join(__dirname, 'db');
const upDir = path.join(__dirname, 'uploads', 'files');

const baca = f => { try { return JSON.parse(fs.readFileSync(path.join(DB, f), 'utf-8')); } catch { return null; } };

const pubs   = baca('publikasi.json') || [];
const upload = baca('pdf-index-upload.json') || [];

const dgnPdf = pubs.filter(p => p && p.fileLokal && p.fileLokal.toLowerCase().endsWith('.pdf'));
const byFile = new Map(upload.map(e => [e.file, e]));

console.log('┌────────────────────────────────────────────────────┐');
console.log('│  Status Index Data Chat Bot                        │');
console.log('└────────────────────────────────────────────────────┘');
console.log(`Publikasi total            : ${pubs.length}`);
console.log(`Publikasi dgn file PDF     : ${pubs.length ? dgnPdf.length : '(belum ada upload)'}`);
console.log(`Terindeks di chat bot      : ${upload.length}`);
console.log('');

let bermasalah = 0;
for (const p of dgnPdf) {
  const f = path.basename(p.fileLokal);
  const e = byFile.get(f);
  const ada = fs.existsSync(path.join(upDir, f));
  const ok = e && e.chunks && e.chunks.length > 0;
  if (!ok) bermasalah++;
  console.log(`  ${ok ? 'OK  ' : 'KURANG'} ${f.slice(0, 42).padEnd(42)} | upload:${ada ? 'y' : 't'} index:${e ? (e.chunks.length + ' chunk') : 'TIDAK'} | ${(p.judul || '').slice(0, 40)}`);
}
console.log('');

if (!dgnPdf.length) {
  console.log('→ Belum ada publikasi yang di-upload admin.');
} else if (bermasalah === 0) {
  console.log(`✓ SEMUA TERINDEX (${dgnPdf.length} file). Semua upload sudah bisa dicari di chat bot.`);
} else {
  console.log(`⚠ ${bermasalah} file belum sepenuhnya terindex/belum ada teks.`);
  console.log('  Penyebab umum: file kosong (scan tanpa teks) atau ekstraksi gagal.');
}

// Cek jumlah chunk upload
const totalChunk = upload.reduce((s, e) => s + (e.chunks || []).length, 0);
console.log(`Upload index: ${upload.length} dokumen, ${totalChunk} chunk.`);
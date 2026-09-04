/**
 * refresh-indikator.js
 * Ambil "Executive Summary Indikator Makro BPS Kabupaten Jeneponto" terbaru
 * dari Google Sheets BPS (shortlink s.bps.go.id/7304_indikatormakro),
 * lalu perbarui otomatis:
 *   - db/indikator.json      (semua sheet, format array-of-arrays)
 *   - db/tabel-makro.json    (tabel-tabel terstruktur utk tabel.html/chat)
 *
 * Bisa dipakai sebagai: 
 *   - CLI   : node refresh-indikator.js
 *   - modul : const { refreshIndikator, buildTabelMakro } = require('./refresh-indikator');
 *             await refreshIndikator(onInfo, onError)
 */
'use strict';

const XLSX  = require('xlsx');
const fs    = require('fs');
const path  = require('path');

const BASE = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
const DB   = path.join(BASE, 'db');
const INDIK_FILE   = path.join(DB, 'indikator.json');
const MAKRO_FILE   = path.join(DB, 'tabel-makro.json');
const KEC_FILE     = path.join(DB, 'kecamatan.json');

const SHEET_ID = '1EHAwV0IL6y9n3K2LhojTM8vXl5-zqQmSZWophthKhrM';
const SOURCE_URL = 'https://s.bps.go.id/7304_indikatormakro';
const EXPORT_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`;

// ubah '' / undefined -> null supaya konsisten dengan format indikator.json
function toNullAoa(aoa) {
  return aoa.map(row =>
    Array.isArray(row)
      ? row.map(c => (c === '' || c === undefined ? null : c))
      : [null]);
}

// ── unduh + parse semua sheet dari Google Sheets ──────────────────
async function unduhIndikator(kirim, timeoutMs = 45000) {
  const p = (m) => { if (typeof kirim === 'function') kirim(m); };
  p('> Mengunduh Indikator Makro dari Google Sheets BPS…');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(EXPORT_URL, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36' },
    });
  } catch (e) {
    throw new Error(`Unduh gagal (${e.name === 'AbortError' ? 'timeout' : e.message}). Cek koneksi internet.`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Unduh gagal: HTTP ${res.status} dari ${SOURCE_URL}`);
  const buf = Buffer.from(await res.arrayBuffer());
  p(`> Berhasil unduh (${(buf.length / 1024).toFixed(0)} KB)`);

  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
  const indikator = {};
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
    indikator[name] = toNullAoa(aoa);
  }
  return indikator;
}

// ── bangun tabel-makro.json dari indikator (port build_tabel_makro.py) ──
function buildTabelMakro(indikator) {
  const t = indikator['Tahunan'] || [];
  const isHeader = r => Array.isArray(r) && r.some(c => typeof c === 'string' && c.trim().toLowerCase().startsWith('indikator'));
  const isTitle  = r => Array.isArray(r) && r.some(c => c && String(c).includes('Executive Summary'));

  const rows = t.filter(r => Array.isArray(r) && r.some(c => c !== null && c !== ''));
  const dataRows = rows.filter(r => !isTitle(r));

  const tables = [];
  let current = null;
  for (const r of dataRows) {
    if (isHeader(r)) {
      const nama = r[0];
      const years = r.slice(2, -1).map(c => String(c));
      current = { nama, years, rows: [] };
      tables.push(current);
    } else if (current) {
      const label = r[0];
      if (label === null || label === '' || label === undefined) continue;
      const satuan = r[1] !== undefined ? r[1] : null;
      const lenYears = current.years.length;
      const ket = r.length > (2 + lenYears) ? r[r.length - 1] : null;
      const vals = r.slice(2, 2 + lenYears);
      current.rows.push({
        label: String(label).trim(),
        satuan,
        nilai: vals,
        ket: ket !== null && ket !== '' ? ket : null,
      });
    }
  }

  const result = tables.map(tb => ({ nama: tb.nama, years: tb.years, rows: tb.rows }));

  // Data Kependudukan Menurut Kecamatan
  if (fs.existsSync(KEC_FILE)) {
    const kec = JSON.parse(fs.readFileSync(KEC_FILE, 'utf-8'));
    const cols = ['Penduduk', 'Laki-laki', 'Perempuan', 'Jumlah KK', 'Luas (km²)'];
    const kecRows = [];
    for (const k of (kec || [])) {
      if (!k || typeof k !== 'object' || !k.kecamatan) continue;
      kecRows.push({
        label: String(k.kecamatan),
        satuan: null,
        nilai: [k.penduduk, k.laki, k.perempuan, k.kk, k.luas_km2],
        ket: null,
      });
    }
    if (kecRows.length) {
      result.push({ nama: 'Kependudukan Menurut Kecamatan', years: cols, rows: kecRows, perKecamatan: true });
    }
  }

  return {
    sumber: 'Executive Summary Indikator Makro + Data Kecamatan BPS Kabupaten Jeneponto',
    satuan: 'Beragam - lihat kolom Satuan',
    tabel: result,
  };
}

// ── tulis file + backup ───────────────────────────────────────────
function simpan(f, data) {
  if (fs.existsSync(f)) fs.copyFileSync(f, `${f}.bak`);
  fs.writeFileSync(f, JSON.stringify(data));
}

// ── proses utama ──────────────────────────────────────────────────
async function refreshIndikator(kirim) {
  const p = (m) => { if (typeof kirim === 'function') kirim(m); };

  const indikator = await unduhIndikator(kirim);
  simpan(INDIK_FILE, indikator);
  p(`> indikator.json diperbarui: ${Object.keys(indikator).length} sheet, ` +
    `${(indikator['Tahunan'] || []).length} baris Tahunan, ` +
    `${(indikator['Summary'] || []).length} baris Summary`);

  const makro = buildTabelMakro(indikator);
  simpan(MAKRO_FILE, makro);
  p(`> tabel-makro.json diperbarui: ${makro.tabel.length} tabel — ` +
    makro.tabel.map(tb => `${tb.nama} (${tb.rows.length})`).join(', '));

  return { indikator, makro };
}

if (require.main === module) {
  const line = [];
  refreshIndikator(m => { line.push(m); console.log(m); })
    .then(() => { console.log('✓ Selesai.'); })
    .catch(e => { console.error('✗ ' + e.message); process.exit(1); });
}

module.exports = { refreshIndikator, buildTabelMakro, unduhIndikator, EXPORT_URL, SOURCE_URL };
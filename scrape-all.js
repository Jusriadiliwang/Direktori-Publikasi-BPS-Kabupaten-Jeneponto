/**
 * scrape-all.js
 * Ambil semua publikasi dari jenepontokab.bps.go.id/id/publication
 * dan simpan ke db/publikasi.json
 *
 * Jalankan: node scrape-all.js
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL   = 'https://jenepontokab.bps.go.id/id/publication';
const OUTPUT     = path.join(__dirname, 'db', 'publikasi.json');
const RETRY_MAX  = 3;
const JEDA_MS    = 1200;   // jeda antar halaman (ms)

// ── Helper: buka halaman dengan retry ────────────────────────────
async function bukaHalaman(page, url, retry = RETRY_MAX) {
  for (let i = 0; i < retry; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try { await page.waitForSelector('a.rounded-xl', { timeout: 12000 }); } catch {}
      await page.waitForTimeout(JEDA_MS);
      return true;
    } catch (e) {
      if (i === retry - 1) { console.log(`  [SKIP] ${e.message.slice(0, 60)}`); return false; }
      console.log(`  [RETRY ${i+1}] ...`);
      await page.waitForTimeout(2000);
    }
  }
  return false;
}

// ── Helper: parse kartu publikasi ─────────────────────────────────
async function parseHalaman(page) {
  return page.evaluate(() => {
    const cards = document.querySelectorAll('a.rounded-xl');
    return Array.from(cards).map(card => {
      const href      = card.href || '';
      const judulEl   = card.querySelector('p[class*="text-main-primary"]');
      const tglEl     = card.querySelector('p[class*="caption"]');
      const deskEl    = card.querySelector('p[class*="overflow-text-ellipsis"]');
      const imgEl     = card.querySelector('img[alt]');

      const judul    = judulEl ? judulEl.innerText.trim() : '';
      const tanggal  = tglEl  ? tglEl.innerText.trim()   : '';
      const deskripsi = deskEl ? deskEl.innerText.trim()  : '';
      const cover    = imgEl  ? (imgEl.src || '')         : '';

      // Ekstrak tahun dari tanggal
      const tahunMatch = tanggal.match(/\b(20\d{2})\b/);
      const tahun = tahunMatch ? parseInt(tahunMatch[1]) : null;

      // Tebak kategori dari judul
      let kategori = 'Lainnya';
      const j = judul.toLowerCase();
      if (j.includes('dalam angka'))         kategori = 'Dalam Angka';
      else if (j.includes('statistik daerah')) kategori = 'Statistik Daerah';
      else if (j.includes('pdrb') || j.includes('produk domestik')) kategori = 'PDRB';
      else if (j.includes('ipm') || j.includes('pembangunan manusia')) kategori = 'IPM';
      else if (j.includes('kemiskinan') || j.includes('miskin')) kategori = 'Kemiskinan';
      else if (j.includes('ketenagakerjaan') || j.includes('tenaga kerja')) kategori = 'Ketenagakerjaan';
      else if (j.includes('pertanian') || j.includes('hortikultura')) kategori = 'Pertanian';
      else if (j.includes('kesejahteraan')) kategori = 'Kesejahteraan';
      else if (j.includes('kecamatan'))     kategori = 'Kecamatan';
      else if (j.includes('inflasi') || j.includes('harga')) kategori = 'Harga & Inflasi';
      else if (j.includes('potensi desa') || j.includes('podes')) kategori = 'Potensi Desa';

      return { judul, tanggal, tahun, deskripsi, kategori, cover, url: href };
    }).filter(d => d.judul.length > 3 && d.url.includes('/publication/'));
  });
}

// ── Helper: ambil total dari teks halaman ─────────────────────────
async function ambilTotal(page) {
  return page.evaluate(() => {
    const t = document.body.innerText;
    const m = t.match(/dari\s+([\d.]+)\s+Publikasi/i);
    return m ? parseInt(m[1].replace(/\./g, ''), 10) : 0;
  });
}

// ── Main ──────────────────────────────────────────────────────────
(async () => {
  const tMulai = Date.now();
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   SCRAPER PUBLIKASI BPS KABUPATEN JENEPONTO      ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
    locale: 'id-ID',
  });
  const page = await context.newPage();

  const semua  = [];
  const urlSet = new Set();

  // ── Halaman 1: cari total ──
  console.log('  Membuka halaman 1 untuk mendeteksi total...');
  const ok1 = await bukaHalaman(page, `${BASE_URL}?page=1`);
  if (!ok1) { console.error('GAGAL membuka halaman 1.'); await browser.close(); process.exit(1); }

  const total       = await ambilTotal(page);
  const totalHalaman = Math.ceil(total / 10);
  console.log(`  Total: ${total} publikasi, ${totalHalaman} halaman\n`);

  // ── Parse halaman 1 ──
  const h1 = await parseHalaman(page);
  h1.forEach(p => { if (!urlSet.has(p.url)) { urlSet.add(p.url); semua.push(p); } });
  tampilProgress(1, totalHalaman, semua.length);

  // ── Loop halaman 2..N ──
  for (let n = 2; n <= totalHalaman; n++) {
    const ok = await bukaHalaman(page, `${BASE_URL}?page=${n}`);
    if (!ok) { console.log(`  Halaman ${n} dilewati.`); continue; }

    const hasil = await parseHalaman(page);
    if (!hasil.length) { console.log(`  Halaman ${n} kosong, selesai.`); break; }

    hasil.forEach(p => { if (!urlSet.has(p.url)) { urlSet.add(p.url); semua.push(p); } });
    tampilProgress(n, totalHalaman, semua.length);
  }

  await browser.close();

  // ── Simpan ke JSON ──
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(semua, null, 2), 'utf-8');

  const detik = ((Date.now() - tMulai) / 1000).toFixed(1);
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(`║  SELESAI: ${semua.length} publikasi disimpan ke:`);
  console.log(`║  ${OUTPUT}`);
  console.log(`║  Durasi: ${detik} detik`);
  console.log('╚══════════════════════════════════════════════════╝');

  // ── Ringkasan per kategori ──
  const katMap = {};
  semua.forEach(p => { katMap[p.kategori] = (katMap[p.kategori] || 0) + 1; });
  console.log('\n  Distribusi Kategori:');
  Object.entries(katMap).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => {
    console.log(`    ${k.padEnd(25)} : ${v}`);
  });
})();

function tampilProgress(n, total, jumlah) {
  const persen  = Math.round((n / total) * 100);
  const filled  = Math.round(persen / 5);
  const bar     = '█'.repeat(filled) + '░'.repeat(20 - filled);
  process.stdout.write(`\r  [${bar}] ${persen}% — Hal ${n}/${total} — ${jumlah} publikasi`);
  if (n === total) process.stdout.write('\n');
}

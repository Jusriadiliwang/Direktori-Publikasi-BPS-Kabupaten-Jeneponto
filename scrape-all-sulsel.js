/**
 * scrape-all-sulsel.js
 * Ambil semua publikasi dari sulsel.bps.go.id/publication.html (format BPS lama)
 * dan simpan ke db/publikasi-sulsel.json
 *
 * Jalankan: node scrape-all-sulsel.js
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL   = 'https://sulsel.bps.go.id/publication.html';
const OUTPUT     = path.join(__dirname, 'db', 'publikasi-sulsel.json');
const RETRY_MAX  = 3;
const JEDA_MS    = 700;   // jeda antar halaman (ms)

// ── Helper: buka halaman dengan retry ────────────────────────────
async function bukaHalaman(page, url, retry = RETRY_MAX) {
  for (let i = 0; i < retry; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try { await page.waitForSelector('div.pub', { timeout: 12000 }); } catch {}
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

// ── Helper: decode cover bps → URL kanonik portalpublikasi ───────
function coverCanonik(src) {
  if (!src) return '';
  const full = src.startsWith('http') ? src : `https://sulsel.bps.go.id${src}`;
  // format lama: getImageCover.html?url=<base64 "tanggal#url">
  try {
    const m = src.match(/url=([^&]+)/);
    if (m) {
      const decoded = decodeURIComponent(m[1]);
      const raw = Buffer.from(decoded, 'base64').toString('utf-8');
      const hashIdx = raw.indexOf('#');
      if (hashIdx >= 0 && raw.slice(hashIdx + 1).startsWith('http')) return raw.slice(hashIdx + 1);
    }
  } catch {}
  return full;
}

// ── Helper: tebak kategori dari judul ────────────────────────────
function tebakKategori(judul) {
  let kategori = 'Lainnya';
  const j = judul.toLowerCase();
  if (j.includes('dalam angka'))               kategori = 'Dalam Angka';
  else if (j.includes('statistik daerah'))     kategori = 'Statistik Daerah';
  else if (j.includes('pdrb') || j.includes('produk domestik') || j.includes('nilai tambah')) kategori = 'PDRB';
  else if (j.includes('ipm') || j.includes('pembangunan manusia') || j.includes('ipg')) kategori = 'IPM';
  else if (j.includes('kemiskinan') || j.includes('miskin')) kategori = 'Kemiskinan';
  else if (j.includes('ketenagakerjaan') || j.includes('tenaga kerja') || j.includes('angkatan kerja') || j.includes('sakernas')) kategori = 'Ketenagakerjaan';
  else if (j.includes('pertanian') || j.includes('hortikultura') || j.includes('padi') || j.includes('perkebunan') || j.includes('ternak')) kategori = 'Pertanian';
  else if (j.includes('kesejahteraan') || j.includes('susenas')) kategori = 'Kesejahteraan';
  else if (j.includes('inflasi') || j.includes('harga') || j.includes('itk') || j.includes('konsumsi')) kategori = 'Harga & Inflasi';
  else if (j.includes('ekspor') || j.includes('impor') || j.includes('perdagangan')) kategori = 'Perdagangan';
  else if (j.includes('industri') || j.includes('manufaktur')) kategori = 'Industri';
  else if (j.includes('pariwisata') || j.includes('hotel') || j.includes('wisatawan')) kategori = 'Pariwisata';
  else if (j.includes('transportasi') || j.includes('pelabuhan')) kategori = 'Transportasi';
  else if (j.includes('potensi desa') || j.includes('podes')) kategori = 'Potensi Desa';
  else if (j.includes('geografi') || j.includes('iklim') || j.includes('cuaca')) kategori = 'Geografi';
  else if (j.includes('energi') || j.includes('listrik') || j.includes('gas')) kategori = 'Energi';
  else if (j.includes('keuangan') || j.includes('perbankan') || j.includes('apbd')) kategori = 'Keuangan Daerah';
  else if (j.includes('gender'))               kategori = 'Gender';
  else if (j.includes('pendidikan'))           kategori = 'Pendidikan';
  else if (j.includes('kesehatan'))            kategori = 'Kesehatan';
  else if (j.includes('analisis') || j.includes('kajian') || j.includes('ringkasan eksekutif') || j.includes('brs')) kategori = 'Analisis';
  return kategori;
}

// ── Helper: parse kartu publikasi ─────────────────────────────────
async function parseHalaman(page) {
  return page.evaluate(() => {
    const cards = document.querySelectorAll('div.pub');
    return Array.from(cards).map(card => {
      const judulEl = card.querySelector('.thumbnail-judul-publikasi a');
      const imgEl   = card.querySelector('.thumbnail-sampul-publikasi img');

      const judul   = judulEl ? judulEl.innerText.trim() : '';
      const url     = judulEl ? judulEl.href : '';
      const cover   = imgEl ? imgEl.getAttribute('src') || '' : '';

      const meta    = card.innerText || '';
      const tglM    = meta.match(/Tanggal Rilis\s*:\s*([\d-]+)/);
      const ukM     = meta.match(/Ukuran File\s*:\s*([\d.]+\s*MB)/);
      const tanggal = tglM ? tglM[1] : '';
      const ukuran  = ukM  ? ukM[1]  : '';

      // Deskripsi: teks setelah "Ukuran File : ..."
      let deskripsi = '';
      const baris = meta.split('\n');
      for (let i = 0; i < baris.length; i++) {
        if (/Ukuran File/.test(baris[i])) {
          deskripsi = baris.slice(i + 1).join(' ').replace(/\s+/g, ' ').trim();
          break;
        }
      }
      // potong jika ada label sisa
      deskripsi = deskripsi.replace(/^UNDUH PUBLIKASI\s*/i, '');

      const tahunM = tanggal.match(/\b(20\d{2})\b/) || url.match(/\/publication\/(20\d{2})\//);
      const tahun  = tahunM ? parseInt(tahunM[1], 10) : null;

      return {
        judul, tanggal, tahun, deskripsi, kategori: '', cover, url, ukuran,
      };
    }).filter(d => d.judul.length > 3 && d.url.includes('/publication/'));
  });
}

// Terapkan tebak kategori di Node (fungsi di page.evaluate tak bisa dipakai luar)
// ── Main ──────────────────────────────────────────────────────────
(async () => {
  const tMulai = Date.now();
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   SCRAPER PUBLIKASI BPS PROVINSI SULAWESI SELATAN    ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

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

  // ── Halaman 1: deteksi total ──
  console.log('  Membuka halaman 1 untuk mendeteksi total...');
  const ok1 = await bukaHalaman(page, `${BASE_URL}?page=1`);
  if (!ok1) { console.error('GAGAL membuka halaman 1.'); await browser.close(); process.exit(1); }

  const info = await page.evaluate(() => {
    const m = document.body.innerText.match(/Menampilkan\s+[\d.,]+\s*-\s*[\d.,]+\s+dari\s+([\d.,]+)\s+hasil/i);
    const last = document.querySelector('a[href*="page="][class*="last"], .pagination li:last-child a');
    return { total: m ? parseInt(m[1].replace(/\./g, ''), 10) : 0,
             lastHref: last ? last.href : null, lastText: last ? last.innerText.trim() : null };
  });
  let totalHalaman = 0;
  if (info.lastHref) {
    const pm = info.lastHref.match(/page=(\d+)/);
    if (pm) totalHalaman = parseInt(pm[1], 10);
  }
  if (!totalHalaman) totalHalaman = Math.ceil((info.total || 770) / 10);
  console.log(`  Total: ${info.total || '?'} publikasi, ${totalHalaman} halaman\n`);

  // ── Parse halaman 1 ──
  let h1 = await parseHalaman(page);
  h1.forEach(p => { if (!urlSet.has(p.url)) { urlSet.add(p.url); semua.push(p); } });
  tampilProgress(1, totalHalaman, semua.length);

  // ── Loop halaman 2..N ──
  for (let n = 2; n <= totalHalaman; n++) {
    const ok = await bukaHalaman(page, `${BASE_URL}?page=${n}`);
    if (!ok) { console.log(`\n  Halaman ${n} dilewati.`); continue; }

    const hasil = await parseHalaman(page);
    if (!hasil.length) { console.log(`\n  Halaman ${n} kosong, selesai.`); break; }

    hasil.forEach(p => { if (!urlSet.has(p.url)) { urlSet.add(p.url); semua.push(p); } });
    tampilProgress(n, totalHalaman, semua.length);
  }

  await browser.close();

  // ── Lengkapi kategori & cover kanonik di Node ──
  for (const p of semua) {
    p.kategori = tebakKategori(p.judul);
    if (p.cover) p.cover = coverCanonik(p.cover);
  }

  // ── Simpan ke JSON ──
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(semua, null, 2), 'utf-8');

  const detik = ((Date.now() - tMulai) / 1000).toFixed(1);
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(`║  SELESAI: ${semua.length} publikasi disimpan ke:`);
  console.log(`║  ${OUTPUT}`);
  console.log(`║  Durasi: ${detik} detik`);
  console.log('╚══════════════════════════════════════════════════╝');

  const katMap = {};
  semua.forEach(p => { katMap[p.kategori] = (katMap[p.kategori] || 0) + 1; });
  console.log('\n  Distribusi Kategori:');
  Object.entries(katMap).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    console.log(`    ${k.padEnd(22)} : ${v}`);
  });
})();

function tampilProgress(n, total, jumlah) {
  const persen  = Math.round((n / total) * 100);
  const filled  = Math.round(persen / 5);
  const bar     = '█'.repeat(filled) + '░'.repeat(20 - filled);
  process.stdout.write(`\r  [${bar}] ${persen}% — Hal ${n}/${total} — ${jumlah} publikasi`);
  if (n === total) process.stdout.write('\n');
}
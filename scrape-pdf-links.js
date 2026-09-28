/**
 * scrape-pdf-links.js
 * Lengkapi field `url_pdf` (tautan langsung file PDF, web-api.bps.go.id/download.php?f=…)
 * untuk setiap publikasi di db/publikasi.json (atau db/publikasi-sulsel.json).
 * Hanya publikasi yang belum punya `url_pdf` yang dikunjungi, jadi aman dijalankan ulang.
 *
 * Jalankan (HEADED, disarankan agar lolos Cloudflare):
 *   node scrape-pdf-links.js
 *   node scrape-pdf-links.js --wilayah sulsel
 *   node scrape-pdf-links.js --maks 50          (batasi jumlah publikasi per sesi)
 *   node scrape-pdf-links.js --headless
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const argv     = process.argv.slice(2);
const opsi     = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const WILAYAH  = opsi('--wilayah') === 'sulsel' ? 'sulsel' : 'jeneponto';
const MAKS     = parseInt(opsi('--maks') || '0', 10) || Infinity;
const HEADLESS = argv.includes('--headless');
const FILE     = path.join(__dirname, 'db', WILAYAH === 'sulsel' ? 'publikasi-sulsel.json' : 'publikasi.json');
const JEDA_MS  = 1500;

const baca  = f => JSON.parse(fs.readFileSync(f, 'utf-8'));
const tulis = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2), 'utf-8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tungguCf(page, detik = 40) {
  for (let i = 0; i < detik; i++) {
    const t = (await page.title().catch(() => '')).toLowerCase();
    if (!/moment|tunggu sebentar|challenge|verifikasi/.test(t)) return true;
    if (i === 3) console.log('\n  [CF] Verifikasi Cloudflare terdeteksi — selesaikan di jendela browser bila diminta...');
    await sleep(1000);
  }
  return false;
}

// Cari tautan unduh PDF di halaman publikasi (situs baru maupun lama).
async function ambilLinkPdf(page) {
  for (let i = 0; i < 15; i++) {
    const link = await page.evaluate(() => {
      const semua = Array.from(document.querySelectorAll('a[href]'));
      const cocok = semua.find(a => /download\.php\?f=/i.test(a.href))
        || semua.find(a => /\/download|\.pdf(\?|$)/i.test(a.href));
      return cocok ? cocok.href : null;
    }).catch(() => null);
    if (link) return link;
    await sleep(1000);
  }
  return null;
}

(async () => {
  if (!fs.existsSync(FILE)) { console.error(`File tidak ada: ${FILE}`); process.exit(1); }
  const data  = baca(FILE);
  const antre = data.filter(p => p.url && !p.url_pdf).slice(0, MAKS);
  console.log(`\nWilayah: ${WILAYAH} | total ${data.length} publikasi | belum ada url_pdf: ${data.filter(p => !p.url_pdf).length} | diproses sesi ini: ${antre.length}`);
  if (!antre.length) { console.log('Semua publikasi sudah punya url_pdf.'); return; }

  const args = ['--disable-blink-features=AutomationControlled', '--no-sandbox'];
  let browser;
  try { browser = await chromium.launch({ channel: 'chrome', headless: HEADLESS, args }); }
  catch { browser = await chromium.launch({ headless: HEADLESS, args }); }
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'id-ID', viewport: { width: 1280, height: 800 },
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await ctx.newPage();

  let ok = 0, gagal = 0;
  for (let i = 0; i < antre.length; i++) {
    const pub = antre[i];
    process.stdout.write(`[${i + 1}/${antre.length}] ${pub.judul.slice(0, 55).padEnd(55)} `);
    let link = null;
    for (let coba = 1; coba <= 2 && !link; coba++) {
      try {
        await page.goto(pub.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await tungguCf(page);
        link = await ambilLinkPdf(page);
      } catch (e) {
        if (coba === 2) process.stdout.write(`[ERR ${e.message.slice(0, 40)}] `);
        await sleep(2000);
      }
    }
    if (link) {
      const target = data.find(p => p.url === pub.url);
      if (target) target.url_pdf = link;
      ok++; console.log('OK');
    } else {
      gagal++; console.log('- tidak ditemukan');
    }
    if ((i + 1) % 5 === 0 || i === antre.length - 1) tulis(FILE, data);
    await sleep(JEDA_MS);
  }

  await browser.close();
  console.log(`\nSelesai: ${ok} berhasil, ${gagal} gagal. Tersimpan di ${FILE}`);
})().catch(e => { console.error('Gagal:', e.message); process.exit(1); });

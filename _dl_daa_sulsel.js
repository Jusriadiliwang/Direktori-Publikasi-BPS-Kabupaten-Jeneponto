const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PUB_URL = 'https://sulsel.bps.go.id/publication/2026/02/27/fa1adde42bea0a82c4e86dcb/provinsi-sulawesi-selatan-dalam-angka-2026.html';
const OUT = path.join(__dirname, 'downloads', 'Provinsi_Sulawesi_Selatan_Dalam_Angka_2026.pdf');

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36', locale: 'id-ID' });
  const page = await ctx.newPage();
  await page.goto(PUB_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  const dl = await page.evaluate(() => {
    for (const a of document.querySelectorAll('a')) {
      if (a.href && a.href.includes('download')) return a.href;
    }
    return null;
  });
  console.log('DL:', dl);
  if (!dl) { console.log('TIDAK ADA LINK DOWNLOAD'); await browser.close(); return; }
  try {
    const resp = await page.request.get(dl, { timeout: 120000 });
    console.log('Status:', resp.status(), 'Type:', resp.headers()['content-type'], 'Len:', resp.headers()['content-length']);
    const buf = await resp.body();
    fs.writeFileSync(OUT, buf);
    console.log('SIMPAN:', OUT, buf.length, 'bytes');
  } catch (e) { console.log('DL ERR:', e.message); }
  await browser.close();
})();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// [judul] = url publikasi
const pubs = {
  'Indikator_Makro_Sosial_Ekonomi_Sulsel_TW2_2026': 'https://sulsel.bps.go.id/publication/2026/08/31/e0e9b2a494016f52eaafebc0/indikator-makro-sosial-ekonomi-provinsi--sulawesi-selatan-triwulan-2-2026.html',
};

const OUTDIR = path.join(__dirname, 'downloads');
fs.mkdirSync(OUTDIR, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36', locale: 'id-ID' });
  const page = await ctx.newPage();
  for (const [name, pubUrl] of Object.entries(pubs)) {
    await page.goto(pubUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const dl = await page.evaluate(() => {
      for (const a of document.querySelectorAll('a')) if (a.href && a.href.includes('download')) return a.href;
      return null;
    });
    if (!dl) { console.log(name, 'NO DL'); continue; }
    const resp = await page.request.get(dl, { timeout: 120000 });
    const buf = await resp.body();
    const out = path.join(OUTDIR, name + '.pdf');
    fs.writeFileSync(out, buf);
    console.log(name, '->', out, buf.length, 'bytes');
  }
  await browser.close();
})();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PUB_URL = 'https://sulsel.bps.go.id/publication/2026/08/31/e0e9b2a494016f52eaafebc0/indikator-makro-sosial-ekonomi-provinsi--sulawesi-selatan-triwulan-2-2026.html';
const OUT = path.join(__dirname, 'downloads', 'sulsel', '_debug.pdf');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    locale: 'id-ID', acceptDownloads: true,
  });
  const page = await ctx.newPage();
  await page.goto(PUB_URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(2500);
  const dl = await page.evaluate(() => {
    for (const a of document.querySelectorAll('a')) {
      const src = a.href || a.getAttribute('data-url') || '';
      if (String(src).includes('download')) return String(src);
    }
    return null;
  });
  console.log('DL:', (dl || '').slice(0, 90));

  const dlPromise = page.waitForEvent('download', { timeout: 120000 });
  await page.goto(dl, { waitUntil: 'commit', timeout: 60000 }).catch(e => {});
  const download = await dlPromise.catch(e => { console.log('no download event:', e.message.split('\n')[0]); return null; });
  if (!download) { await browser.close(); return; }
  console.log('suggested:', download.suggestedFilename());
  const p = await download.path().catch(e => { console.log('path err', e.message.split('\n')[0]); return null; });
  if (p) { fs.copyFileSync(p, OUT); console.log('SAVED bytes:', fs.statSync(OUT).size, 'head:', fs.readFileSync(OUT).slice(0,5).toString()); }
  await browser.close();
})();
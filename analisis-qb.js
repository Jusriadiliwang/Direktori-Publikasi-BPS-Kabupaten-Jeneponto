/**
 * Gunakan Playwright untuk intercept seluruh API query-builder
 * dan simpan semua data indikator ke JSON
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx  = await browser.newContext({ locale: 'id-ID' });
  const page = await ctx.newPage();

  // Kumpulkan semua JSON response dari query-builder
  const results = [];
  page.on('response', async res => {
    const url = res.url();
    if (!url.includes('bps.go.id/id/query-builder')) return;
    if (res.status() !== 200) return;
    try {
      const text = await res.text();
      // Parse RSC format: "0:{...}\n1:{...}"
      const lines = text.split('\n').filter(l => l.match(/^\d+:/));
      for (const line of lines) {
        const json = line.replace(/^\d+:/, '');
        try {
          const obj = JSON.parse(json);
          results.push({ url, data: obj });
        } catch {}
      }
    } catch {}
  });
  
  // ── Load halaman utama ──────────────────────────────────
  console.log('1. Load Query Builder...');
  await page.goto('https://jenepontokab.bps.go.id/id/query-builder', {
    waitUntil: 'networkidle', timeout: 40000
  });
  await page.waitForTimeout(3000);

  console.log(`   ${results.length} responses terkumpul`);
  results.forEach((r, i) => {
    if (r.data?.response?.data) {
      const d = r.data.response.data;
      console.log(`   [${i}] Data array length: ${Array.isArray(d) ? d.length : JSON.stringify(d).length}`);
      if (Array.isArray(d) && Array.isArray(d[1])) {
        d[1].slice(0,3).forEach(item => console.log('     -', JSON.stringify(item).slice(0,100)));
      }
    }
  });

  // ── Simpan raw results ─────────────────────────────────
  const outFile = path.join(__dirname, 'db', 'qb-raw.json');
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`\nDisimpan ke: ${outFile}`);

  // ── Coba buka pilihan pertama ──────────────────────────
  console.log('\n2. Mencoba interaksi dengan halaman...');
  
  // Ambil semua teks yang terlihat di daftar indikator
  const listItems = await page.evaluate(() => {
    // Cari semua elemen yang mungkin berupa item daftar
    const all = document.querySelectorAll('li, [class*="item"], [class*="row"]');
    return Array.from(all)
      .map(el => el.innerText.trim())
      .filter(t => t.length > 5 && t.length < 200)
      .slice(0, 30);
  });
  console.log('Items di halaman:');
  listItems.slice(0, 20).forEach(t => console.log(' -', t.replace(/\n/g, ' ').slice(0, 100)));

  await browser.close();
})();

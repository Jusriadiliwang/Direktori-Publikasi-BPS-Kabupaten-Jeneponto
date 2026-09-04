/**
 * Ambil semua indikator - capture Next-Action dari halaman live
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'db', 'tabel-dinamis.json');

function parseRSC(text) {
  const results = [];
  for (const line of text.split('\n')) {
    if (!line.match(/^\d+:/)) continue;
    try { results.push(JSON.parse(line.replace(/^\d+:/, ''))); } catch {}
  }
  return results;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx  = await browser.newContext({ locale: 'id-ID' });
  const page = await ctx.newPage();

  // Capture Next-Action IDs dan responses
  const actionMap   = {}; // { body_pattern: actionId }
  let allVars       = [];
  let varsActionId  = '';
  let yearsActionId = '';

  page.on('request', req => {
    if (req.method() !== 'POST' || !req.url().includes('bps.go.id')) return;
    const na   = req.headers()['next-action'];
    const body = req.postData() || '';
    if (!na) return;
    console.log(`  POST → Action: ${na.slice(0,20)} | Body: ${body.slice(0,80)}`);
    if (body.includes('"page"')) varsActionId = na;
    if (body.includes('"var_id"')) yearsActionId = na;
    actionMap[body.slice(0,40)] = na;
  });

  page.on('response', async res => {
    if (!res.url().includes('bps.go.id')) return;
    if (res.request().method() !== 'POST') return;
    try {
      const text = await res.text();
      for (const obj of parseRSC(text)) {
        const d = obj?.response?.data;
        if (!Array.isArray(d) || !Array.isArray(d[1])) continue;
        if (d[1][0]?.var_id !== undefined) {
          d[1].forEach(v => { if (!allVars.find(x=>x.var_id===v.var_id)) allVars.push(v); });
        }
      }
    } catch {}
  });

  console.log('1. Memuat halaman...');
  await page.goto('https://jenepontokab.bps.go.id/id/query-builder', {
    waitUntil: 'networkidle', timeout: 40000
  });
  await page.waitForTimeout(3000);

  console.log(`\nVars: ${allVars.length} | varsAction: "${varsActionId.slice(0,30)}"`);
  console.log('actionMap:', Object.keys(actionMap));

  if (!varsActionId) {
    console.log('ACTION ID TIDAK TERDETEKSI - coba ambil dari page source');
    // Coba dari script
    const scripts = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('script'))
        .map(s => s.textContent)
        .filter(t => t.includes('query-builder') || t.includes('nextAction'));
    });
    console.log('Scripts with nextAction:', scripts.length);
    scripts.forEach((s,i) => console.log(`Script ${i}: ${s.slice(0,200)}`));
  }

  // JIKA sudah dapat halaman 1 dari vars, paginate secara manual
  if (allVars.length > 0 && varsActionId) {
    console.log('\n2. Paginasi halaman 2-5...');
    for (let pg = 2; pg <= 5; pg++) {
      const text = await page.evaluate(async ([action, p]) => {
        const r = await fetch('/id/query-builder', {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain;charset=UTF-8',
            'Next-Action': action,
          },
          // Gunakan format persis sama dengan request yang berhasil
          body: JSON.stringify([{"locale":"id","keyword":"$undefined","page":p,"subjectcsa":"$undefined"}]),
        });
        return r.text();
      }, [varsActionId, pg]);

      let found = 0;
      for (const obj of parseRSC(text)) {
        const d = obj?.response?.data;
        if (!Array.isArray(d)||!Array.isArray(d[1])) continue;
        if (d[1][0]?.var_id !== undefined) {
          d[1].forEach(v => { if(!allVars.find(x=>x.var_id===v.var_id)) { allVars.push(v); found++; } });
        }
      }
      console.log(`   Halaman ${pg}: +${found} (total ${allVars.length})`);
      await page.waitForTimeout(500);
    }
  }

  await browser.close();

  console.log(`\nTotal: ${allVars.length} indikator`);
  allVars.forEach((v,i) => console.log(`  [${i+1}] ${v.title.slice(0,70)}`));

  const output = {
    diambilPada: new Date().toISOString(),
    sumber: 'https://jenepontokab.bps.go.id/id/query-builder',
    total: allVars.length,
    indikator: allVars.map(v => ({
      var_id: v.var_id, judul: v.title,
      subjek: v.sub_name||'', sub_id: v.sub_id,
      kategori: v.subcsa_name||'', definisi: v.def||'',
      catatan: v.notes||'',
      url_bps: `https://jenepontokab.bps.go.id/id/query-builder`,
    }))
  };
  fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
  console.log(`\nDisimpan: ${OUT}`);
})();

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DBSPUBS = path.join(__dirname, 'db', 'publikasi-sulsel.json');
const OUTDIR = path.join(__dirname, 'downloads', 'sulsel');
const MANIFEST = path.join(__dirname, 'db', 'sulsel-manifest.json');

const PRIORITAS = [
  { kw: /provinsi sulawesi selatan dalam angka 2026/i, label: 'daa2026' },
  { kw: /provinsi sulawesi selatan dalam angka 2025$/i, label: 'daa2025' },
  { kw: /statistik daerah provinsi sulawesi selatan 2025$/i, label: 'stda2025' },
  { kw: /indikator makro sosial ekonomi provinsi sulawesi selatan triwulan 2/i, label: 'makro-tw2' },
  { kw: /indikator makro sosial ekonomi provinsi sulawesi selatan triwulan 1/i, label: 'makro-tw1' },
  { kw: /keadaan angkatan kerja provinsi sulawesi selatan februari 2026$/i, label: 'sakernas-feb26' },
  { kw: /keadaan angkatan kerja provinsi sulawesi selatan agustus 2025$/i, label: 'sakernas-ags25' },
  { kw: /produk domestik regional bruto provinsi sulawesi selatan menurut pengeluaran 2021-2025$/i, label: 'pdrb-pengeluaran' },
  { kw: /produk domestik regional bruto provinsi sulawesi selatan menurut lapangan usaha 2021-2025$/i, label: 'pdrb-lapangan' },
  { kw: /produk domestik regional bruto kabupaten\/kota se-provinsi sulawesi selatan menurut pengeluaran 2021-2025$/i, label: 'pdrb-kab-pengeluaran' },
  { kw: /produk domestik regional bruto kabupaten\/kota se-provinsi sulawesi selatan menurut lapangan usaha 2021-2025$/i, label: 'pdrb-kab-lapangan' },
  { kw: /data dan informasi kemiskinan provinsi sulawesi selatan 2024$/i, label: 'miskin' },
  { kw: /indeks pembangunan manusia provinsi sulawesi selatan 2025$/i, label: 'ipm2025' },
  { kw: /indikator kesejahteraan rakyat provinsi sulawesi selatan 2025$/i, label: 'ikesra2025' },
  { kw: /inflasi provinsi sulawesi selatan 20(2[56])/i, label: 'inflasi2025or26' },
  { kw: /penduduk provinsi sulawesi selatan hasil long form sensus penduduk 2020/i, label: 'lfsp' },
  { kw: /hasil pencacahan lengkap sensus pertanian 2023 tahap ii provinsi sulawesi selatan/i, label: 'st2023' },
  { kw: /ringkasan eksekutif luas panen dan produksi padi di provinsi sulawesi selatan 2025/i, label: 'padi' },
  { kw: /sensus ekonomi 2016 analisis hasil listing potensi ekonomi provinsi sulawesi selatan/i, label: 'se2016' },
  { kw: /keadaan angkatan kerja provinsi sulawesi selatan februari 2025$/i, label: 'sakernas-feb25' },
];

function slug(label, pub) {
  const base = label + '-' + String(pub.tahun || '').trim();
  return base.replace(/[^a-z0-9-]/gi, '_') + '.pdf';
}

async function unduh(page, dl, fpath) {
  const dlPromise = page.waitForEvent('download', { timeout: 120000 });
  await page.goto(dl, { waitUntil: 'commit', timeout: 60000 }).catch(() => {});
  const download = await dlPromise.catch(() => null);
  if (!download) return null;
  const p = await download.path().catch(() => null);
  if (!p) return null;
  const raw = fs.readFileSync(p);
  const i = raw.indexOf(Buffer.from('%PDF-'));
  if (i < 0) return null;
  const pdf = raw.slice(i);
  if (!pdf.slice(0, 5).toString('ascii').startsWith('%PDF-') || pdf.length < 30000) return null;
  fs.writeFileSync(fpath, pdf);
  return pdf.length;
}

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const pubs = JSON.parse(fs.readFileSync(DBSPUBS, 'utf-8'));
  const picked = [];
  const seen = new Set();

  for (const { kw, label } of PRIORITAS) {
    const hit = pubs.find(p => kw.test(p.judul || '') && !seen.has(p.url));
    if (!hit) { console.log('  (kosong)', kw.source.slice(0, 75)); continue; }
    seen.add(hit.url);
    picked.push({ pub: hit, fname: slug(label, hit) });
    console.log('  PILIH:', hit.judul.slice(0, 85));
  }
  console.log('\nTotal dipilih:', picked.length);

  const oldManifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf-8')) : [];
  const manifest = [];
  let ok = 0;

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    locale: 'id-ID', acceptDownloads: true,
  });

  for (const [i, { pub, fname }] of picked.entries()) {
    const fpath = path.join(OUTDIR, fname);
    if (fs.existsSync(fpath) && fs.statSync(fpath).size > 30000) {
      console.log(`[${i + 1}/${picked.length} SUDAH ADA] ${fname}`);
      manifest.push({ file: fname, ...pub });
      ok++;
      continue;
    }
    console.log(`[${i + 1}/${picked.length}] ${pub.judul.slice(0, 72)}...`);
    const page = await ctx.newPage();
    try {
      await page.goto(pub.url, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await page.waitForTimeout(1500);
      const dl = await page.evaluate(() => {
        for (const a of document.querySelectorAll('a')) {
          const src = a.href || a.getAttribute('data-url') || '';
          if (String(src).includes('download')) return new URL(String(src), location.href).href;
        }
        return null;
      });
      if (!dl) { console.log('    tanpa link download'); continue; }
      const size = await unduh(page, dl, fpath);
      if (size) {
        manifest.push({ file: fname, ...pub });
        ok++;
        console.log(`    OK ${(size / 1048576).toFixed(1)} MB -> ${fname}`);
      } else {
        console.log('    tidak tersimpan (bukan PDF valid)');
      }
    } catch (e) {
      console.log('    ERR:', (e.message || '').split('\n')[0].slice(0, 120));
    } finally {
      await page.close().catch(() => {});
    }
    if ((i + 1) % 4 === 0) fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  }
  await browser.close();
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`\nSelesai: ${ok}/${picked.length} PDF tersimpan di ${OUTDIR}`);
  console.log('Manifest:', MANIFEST);
})();
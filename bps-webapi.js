/**
 * bps-webapi.js — Sinkron tautan file PDF (url_pdf) publikasi dari BPS WebAPI.
 *
 * WebAPI (https://webapi.bps.go.id) tidak dilindungi Cloudflare, sehingga bisa
 * dijalankan di server mana pun. Butuh API key gratis (daftar di webapi.bps.go.id),
 * diberikan lewat env BPS_API_KEY.
 *
 * Dipakai oleh server.js (sinkron otomatis saat start) dan CLI:
 *   node bps-webapi.js                    → Jeneponto (7304)
 *   node bps-webapi.js --wilayah sulsel   → Sulsel (7300)
 * Key dibaca dari env BPS_API_KEY atau file .env (BPS_API_KEY=...) di root proyek.
 */
const fs   = require('fs');
const path = require('path');

// Muat variabel dari file .env di root proyek (tanpa menimpa env yang sudah ada).
function muatEnv(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const baris of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const m = baris.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || baris.trim().startsWith('#')) continue;
    const nilai = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = nilai;
  }
}
muatEnv();

const DOMAIN = { jeneponto: '7304', sulsel: '7300' };
const API    = 'https://webapi.bps.go.id/v1/api/list/model/publication';

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// pub_id BPS = segmen heksadesimal 24 karakter di URL halaman publikasi
const pubIdDariUrl = u => { const m = String(u || '').match(/\/([0-9a-f]{24})\//i); return m ? m[1].toLowerCase() : ''; };

async function ambilHalaman(key, domain, page) {
  const r = await fetch(`${API}/domain/${domain}/page/${page}/key/${encodeURIComponent(key)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`WebAPI HTTP ${r.status}`);
  const j = await r.json();
  if (j.status === 'Error') throw new Error(j.message || 'WebAPI menolak permintaan (cek API key)');
  const info  = Array.isArray(j.data) ? j.data[0] : null;
  const items = Array.isArray(j.data) ? (j.data[1] || []) : [];
  return { pages: Number(info && info.pages) || 1, items };
}

/** Ambil semua publikasi (pub_id, title, pdf, size) dari satu domain. */
async function ambilSemua(key, domain, log = () => {}) {
  const semua = [];
  const p1 = await ambilHalaman(key, domain, 1);
  semua.push(...p1.items);
  log(`  halaman 1/${p1.pages} (${p1.items.length} publikasi)`);
  for (let p = 2; p <= p1.pages; p++) {
    const h = await ambilHalaman(key, domain, p);
    semua.push(...h.items);
    log(`  halaman ${p}/${p1.pages} (${h.items.length} publikasi)`);
  }
  return semua;
}

/**
 * Lengkapi url_pdf pada file publikasi JSON.
 * @returns {Promise<{total:number, dilengkapi:number, belum:number}>}
 */
async function sinkronUrlPdf({ key, wilayah = 'jeneponto', file, log = () => {} }) {
  if (!key) throw new Error('BPS_API_KEY belum di-set');
  const domain = DOMAIN[wilayah] || DOMAIN.jeneponto;
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const perluIsi = data.filter(p => !p.url_pdf);
  if (!perluIsi.length) return { total: data.length, dilengkapi: 0, belum: 0 };

  log(`Mengambil daftar publikasi domain ${domain} dari WebAPI...`);
  const daftar = await ambilSemua(key, domain, log);
  const byId = new Map(), byJudul = new Map();
  for (const it of daftar) {
    if (!it || !it.pdf) continue;
    if (it.pub_id) byId.set(String(it.pub_id).toLowerCase(), it);
    byJudul.set(norm(it.title), it);
  }

  let n = 0;
  for (const p of perluIsi) {
    const it = byId.get(pubIdDariUrl(p.url)) || byJudul.get(norm(p.judul));
    if (!it) continue;
    p.url_pdf = it.pdf;
    if (!p.ukuran && it.size) p.ukuran = it.size;
    n++;
  }
  if (n) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  }
  return { total: data.length, dilengkapi: n, belum: perluIsi.length - n };
}

module.exports = { sinkronUrlPdf, muatEnv, DOMAIN };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--wilayah');
  const wilayah = i >= 0 && argv[i + 1] === 'sulsel' ? 'sulsel' : 'jeneponto';
  const file = path.join(__dirname, 'db', wilayah === 'sulsel' ? 'publikasi-sulsel.json' : 'publikasi.json');
  sinkronUrlPdf({ key: process.env.BPS_API_KEY, wilayah, file, log: console.log })
    .then(r => console.log(`Selesai: ${r.dilengkapi} url_pdf ditambahkan, ${r.belum} belum cocok, total ${r.total} publikasi.`))
    .catch(e => { console.error('Gagal:', e.message); process.exit(1); });
}

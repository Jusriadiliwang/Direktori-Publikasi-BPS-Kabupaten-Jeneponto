/**
 * server.js v4.0 – BPS Jeneponto
 * Fitur baru v4: PDF text search, pencarian publikasi chatbot, indikator lengkap
 */

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const { chromium } = require('playwright');
const { refreshIndikator } = require('./refresh-indikator');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'bps-jeneponto-2024-secret';

// ── Penyimpanan data ────────────────────────────────────────────
// Jika DATA_DIR di-set (mis. persistent disk Render /data), semua data &
// upload disimpan di sana agar persisten lintas restart/redeploy.
// Default (lokal): folder db/ dan uploads/ di dalam proyek.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : __dirname;

const DB_DIR     = path.join(DATA_DIR, 'db');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DATA_FILE  = path.join(DB_DIR, 'publikasi.json');
const ADMIN_FILE = path.join(DB_DIR, 'admin.json');
const USERS_FILE = path.join(DB_DIR, 'users.json');
const INDIK_FILE = path.join(DB_DIR, 'indikator.json');
const KECAM_FILE = path.join(DB_DIR, 'kecamatan.json');
const PDF_INDEX_FILE = path.join(DB_DIR, 'pdf-index.json');
const SUMBER_FILE = path.join(DB_DIR, 'sumber.json');
const BASE_URL   = 'https://jenepontokab.bps.go.id/id/publication';

// ── Seed data awal dari repo ke folder data persisten ────────────
// Saat pertama dijalankan di platform (persistent disk kosong), salin
// data bawaan agar server langsung punya isi.
const SEED_DB = path.join(__dirname, 'db');
function seed(dataDir, seedDir, name) {
  if (dataDir === seedDir) return;
  const dst = path.join(dataDir, name);
  if (!fs.existsSync(dst) && fs.existsSync(path.join(seedDir, name))) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(path.join(seedDir, name), dst, { recursive: true });
  }
}

// ── Init files ──────────────────────────────────────────────────
fs.mkdirSync(DB_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(path.join(UPLOAD_DIR,'covers'), { recursive: true });
fs.mkdirSync(path.join(UPLOAD_DIR,'files'),  { recursive: true });
seed(DATA_DIR, __dirname, 'db');
seed(DATA_DIR, __dirname, 'uploads');

if (!fs.existsSync(ADMIN_FILE)) {
  fs.writeFileSync(ADMIN_FILE, JSON.stringify([
    { id: 1, username: 'admin', password: bcrypt.hashSync('admin123', 10), nama: 'Administrator' }
  ], null, 2));
}
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');

// ── Data helpers ────────────────────────────────────────────────
const baca  = f => JSON.parse(fs.readFileSync(f, 'utf-8'));
const tulis = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

// ── Multer ──────────────────────────────────────────────────────
const upload = multer({
  limits: { fileSize: 50 * 1024 * 1024 },
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = file.fieldname === 'cover'
        ? path.join(UPLOAD_DIR,'covers')
        : path.join(UPLOAD_DIR,'files');
      cb(null, dir);
    },
    filename: (req, file, cb) =>
      cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + path.extname(file.originalname)),
  }),
});

// ── Auth middlewares ─────────────────────────────────────────────
function parseToken(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  try { return t ? jwt.verify(t, JWT_SECRET) : null; } catch { return null; }
}

function requireAuth(req, res, next) {
  const user = parseToken(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login diperlukan' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = parseToken(req);
  if (!user || user.role !== 'admin')
    return res.status(403).json({ ok: false, error: 'Akses admin diperlukan' });
  req.user = user;
  next();
}

// ── Middleware ──────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(UPLOAD_DIR)));

// ══════════════════════════════════════════════════════
// AUTH: REGISTER & LOGIN (untuk user biasa)
// ══════════════════════════════════════════════════════

// POST /api/register
app.post('/api/register', (req, res) => {
  const { username, password, nama } = req.body;
  if (!username || !password || username.length < 3)
    return res.status(400).json({ ok: false, error: 'Username min. 3 karakter' });
  if (password.length < 6)
    return res.status(400).json({ ok: false, error: 'Password min. 6 karakter' });

  const users  = baca(USERS_FILE);
  const admins = baca(ADMIN_FILE);
  const allNames = [...users.map(u=>u.username), ...admins.map(a=>a.username)];
  if (allNames.includes(username))
    return res.status(400).json({ ok: false, error: 'Username sudah dipakai' });

  const newUser = {
    id: Date.now(),
    username,
    password: bcrypt.hashSync(password, 10),
    nama: nama || username,
    role: 'viewer',
    aktif: true,
    dibuatPada: new Date().toISOString(),
  };
  users.push(newUser);
  tulis(USERS_FILE, users);

  const token = jwt.sign({ id: newUser.id, username, nama: newUser.nama, role: 'viewer' }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ ok: true, token, nama: newUser.nama, role: 'viewer' });
});

// POST /api/login (user biasa)
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = baca(USERS_FILE);
  const user  = users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ ok: false, error: 'Username atau password salah' });
  if (!user.aktif)
    return res.status(403).json({ ok: false, error: 'Akun dinonaktifkan oleh admin' });

  const token = jwt.sign({ id: user.id, username, nama: user.nama, role: user.role || 'viewer' }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ ok: true, token, nama: user.nama, role: user.role || 'viewer' });
});

// POST /api/admin/login (admin)
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const admins = baca(ADMIN_FILE);
  const admin  = admins.find(a => a.username === username);
  if (!admin || !bcrypt.compareSync(password, admin.password))
    return res.status(401).json({ ok: false, error: 'Username atau password salah' });

  const token = jwt.sign({ id: admin.id, username, nama: admin.nama, role: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ ok: true, token, nama: admin.nama, role: 'admin' });
});

// ══════════════════════════════════════════════════════
// PUBLIC API – CHATBOT BPS v4
// ══════════════════════════════════════════════════════

// ── PDF Index helpers ───────────────────────────────────────────
let _pdfIndexCache = null;
function getPdfIndex() {
  if (_pdfIndexCache) return _pdfIndexCache;
  if (!fs.existsSync(PDF_INDEX_FILE)) return [];
  try { _pdfIndexCache = baca(PDF_INDEX_FILE); } catch { _pdfIndexCache = []; }
  return _pdfIndexCache;
}

function cariDalamPDF(keyword, maks = 4) {
  const index = getPdfIndex();
  if (!index.length) return [];
  const kwWords = keyword.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (!kwWords.length) return [];

  const hasil = [];
  for (const doc of index) {
    let bestChunk = '', bestScore = 0;
    for (const chunk of (doc.chunks || [])) {
      const cl = chunk.toLowerCase();
      const score = kwWords.reduce((s, w) => s + (cl.includes(w) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; bestChunk = chunk; }
    }
    if (bestScore >= 1) {
      const sents = bestChunk.split(/(?<=[.;])\s+/);
      const rel   = sents.find(s => kwWords.some(w => s.toLowerCase().includes(w))) || sents[0] || '';
      hasil.push({
        judul    : doc.judul,
        tahun    : doc.tahun,
        fileLokal: doc.fileLokal || null,
        url_bps  : doc.url_bps  || '',
        cover    : doc.cover    || '',
        snippet  : rel.trim().substring(0, 280),
        skor     : bestScore
      });
    }
  }
  return hasil.sort((a, b) => b.skor - a.skor).slice(0, maks);
}

app.post('/api/chat', (req, res) => {
  const pesan = (req.body.pesan || req.body.q || '').trim();
  if (!pesan) return res.json({ ok: false, error: 'Pesan kosong' });

  const lower = pesan.toLowerCase();
  const words = lower.split(/\s+/);

  const allPub   = baca(DATA_FILE);
  const allKec   = fs.existsSync(KECAM_FILE) ? baca(KECAM_FILE) : [];
  const indMakro = getIndikatorMakro();

  // ── Helper: format angka ──────────────────────────────
  function fmt(n) {
    const s = String(n || '').trim().replace(/\s/g, '');
    const f = parseFloat(s.replace(/,/g, '.'));
    return isNaN(f) ? s : f.toLocaleString('id-ID', { maximumFractionDigits: 2 });
  }

  // ── Helper: cari indikator ────────────────────────────
  function cariIndikator(kw) {
    const kwL     = kw.toLowerCase();
    const kwWords = kwL.split(/\s+/).filter(w => w.length > 2);
    return indMakro
      .filter(v => kwWords.every(w => v.nama.toLowerCase().includes(w)))
      .sort((a, b) => a.nama.length - b.nama.length);
  }

  // ── Helper: cari publikasi ────────────────────────────
  function cariPub(keyword, maks = 5) {
    const stopWords = new Set(['dan','atau','yang','di','dari','untuk','dengan','ke','pada','oleh',
      'ini','itu','dalam','angka','adalah','berapa','apa','berdasarkan','bagaimana','dimana','kenapa']);
    const kwWords = keyword.toLowerCase().replace(/[?!.,;:()]/g, ' ').split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
    if (!kwWords.length) return [];
    return allPub
      .filter(p => {
        const txt = ((p.judul || '') + ' ' + (p.deskripsi || '')).toLowerCase();
        return kwWords.some(w => txt.includes(w));
      })
      .sort((a, b) => {
        const ta = ((a.judul || '') + (a.deskripsi || '')).toLowerCase();
        const tb = ((b.judul || '') + (b.deskripsi || '')).toLowerCase();
        const sa = kwWords.filter(w => ta.includes(w)).length;
        const sb = kwWords.filter(w => tb.includes(w)).length;
        return sb - sa;
      })
      .slice(0, maks);
  }

  // ── Sinonim & peta kata kunci ─────────────────────────
  const SINONIM = {
    'tingkat kemiskinan'  : 'persentase penduduk miskin',
    'angka kemiskinan'    : 'persentase penduduk miskin',
    'kemiskinan'          : 'penduduk miskin',
    'ipm'                 : 'indeks pembangunan manusia',
    'tpt'                 : 'tingkat pengangguran',
    'tingkat pengangguran': 'pengangguran terbuka',
    'tpak'                : 'partisipasi angkatan kerja',
    'harapan hidup'       : 'umur harapan hidup',
    'uhh'                 : 'umur harapan hidup',
    'hls'                 : 'harapan lama sekolah',
    'rls'                 : 'rata-rata lama sekolah',
    'pertumbuhan ekonomi' : 'laju pertumbuhan',
    'pertumbuhan pdrb'    : 'laju pertumbuhan',
    'gini'                : 'gini rasio',
    'pdrb per kapita'     : 'pdrb perkapita',
    'pdrb harga berlaku'  : 'harga berlaku',
    'kemiskinan ekstrem'  : 'kemiskinan ekstrem',
    'jumlah penduduk'     : 'penduduk',
    'luas wilayah'        : 'luas daerah',
    'wilayah'             : 'luas daerah',
    'lahan sawah'         : 'lahan pertanian sawah',
    'sawah'               : 'lahan pertanian sawah',
    'perkebunan'          : 'luas lahan perkebunan',
  };

  function normalisasiKw(kw) {
    let hasil = kw.toLowerCase()
      .replace(/[?!.,;:()"']/g, ' ')
      .replace(/\b20\d{2}\b/g, ' ')
      .replace(/\b(kabupaten|kab|jeneponto|saat ini|terbaru|terakhir|sekarang|tahun ini|di|untuk|dari|dengan|dan|atau|yang|adalah)\b/gi, ' ')
      .replace(/\s+/g, ' ').trim();

    const sortedSinonim = Object.entries(SINONIM).sort((a, b) => b[0].length - a[0].length);
    for (const [key, val] of sortedSinonim) {
      if (hasil.includes(key)) { hasil = val; break; }
    }
    return hasil.trim();
  }

  // ── Deteksi intent ────────────────────────────────────
  const isBerapa    = /^(berapa|berapakah|berapa\s+jumlah|berapa\s+nilai|berapa\s+angka)/i.test(pesan);
  const isApa       = /^(apa|apakah|apa\s+itu|apa\s+yang)/i.test(pesan);
  const isTampilkan = /^(tampilkan|lihat|show|buka|cari|temukan|perlihatkan|download|unduh)/i.test(pesan);
  const isTrend     = /\b(trend|tren|perkembangan|perubahan|dari\s+tahun|sepanjang\s+tahun|histori)\b/i.test(pesan);
  const isKecamatan = /\b(kecamatan|per\s*kecamatan|tiap\s*kecamatan|semua\s*kecamatan|bangkala|tamalatea|bontoramba|binamu|turatea|batang|arungkeke|tarowang|kelara|rumbia)\b/i.test(pesan);
  const isTertinggi = /\b(tertinggi|terbanyak|terbesar|paling\s+tinggi|paling\s+banyak|terluas)\b/i.test(pesan);
  const isTerendah  = /\b(terendah|terkecil|tersedikit|paling\s+rendah|paling\s+kecil|paling\s+sedikit)\b/i.test(pesan);
  const isLahan     = /\b(lahan|sawah|perkebunan|pertanian|ladang|kebun|tanah|hektar|ha\b|luas|wilayah|area)\b/i.test(pesan);
  const isAset      = /\b(aset|asset|kekayaan|barang\s+daerah|apbd|anggaran|belanja|pendapatan\s+daerah|keuangan\s+daerah)\b/i.test(pesan);
  const isDesa      = /\b(desa|kelurahan|potensi\s+desa|jumlah\s+desa|podes)\b/i.test(pesan);
  const isPertanian = /\b(pertanian|tanaman|pangan|hortikultura|ternak|peternakan|perikanan|nelayan|padi|jagung|ubi|singkong|kelapa|kakao)\b/i.test(pesan);

  let jawaban    = '';
  let tipe       = 'info';
  let dataKartu  = [];
  let publikasi  = [];
  let kecamatan  = [];
  let trendData  = [];
  let saranKueri = [];
  let pdfHasil   = [];   // hasil pencarian dalam PDF
  let tabelMakro = [];   // tabel statistik makro (seri data penuh)

  // Siapkan tabel makro utk pencarian
  let makroAll = [];
  try { if (fs.existsSync(MAKRO_FILE)) makroAll = baca(MAKRO_FILE).tabel || []; } catch {}
  const STOP_MAKRO = new Set(['berapa','berapakah','jumlah','berapa','apa','apakah','data','tampilkan','lihat','jelaskan','tolong','cari','berapa nilai','berapa angka','itu','yang','dimaksud','dengan','dari','untuk','dan','atau']);
  function cocokMakro(kw) {
    const kwWords = String(kw).toLowerCase().replace(/[?!.,;:()]/g,' ').split(/\s+/)
      .filter(w => w.length > 2 && !STOP_MAKRO.has(w));
    if (!kwWords.length) return [];
    return makroAll.filter(t => kwWords.some(w =>
      t.nama.toLowerCase().includes(w) || t.rows.some(r => r.label.toLowerCase().includes(w))
    )).slice(0, 3).map(t => ({
      nama: t.nama, years: [t.years[0], t.years[t.years.length-1]], jml: t.rows.length,
      perKecamatan: !!t.perKecamatan, rows: t.rows
    }));
  }

  // ═══ 1. PERTANYAAN BERAPA / APA (nilai numerik) ══════
  // Tapi jika pertanyaan tentang lahan/aset/desa, redirect ke intent khusus
  if ((isBerapa || (isApa && !isTampilkan)) && !isLahan && !isAset && !isDesa && !isPertanian) {
    const rawKw   = lower.replace(/^(berapa|berapakah|berapa jumlah|berapa nilai|berapa angka|apa|apakah|apa itu|apa yang dimaksud)\s*/, '').replace(/\s+/g, ' ').trim();
    const keyword = normalisasiKw(rawKw);

    let hits = cariIndikator(keyword);
    if (!hits.length && keyword.split(' ').length > 2)
      hits = cariIndikator(keyword.split(' ').slice(0, 2).join(' '));
    if (!hits.length) {
      const longest = keyword.split(' ').sort((a, b) => b.length - a.length)[0];
      if (longest && longest.length > 3) hits = cariIndikator(longest);
    }

    if (hits.length > 0) {
      tipe = 'data';
      const utama = hits[0];
      jawaban  = `Berdasarkan data BPS Kabupaten Jeneponto, **${utama.nama}** pada tahun **${utama.tahun}** adalah:\n\n**${fmt(utama.nilai)} ${utama.satuan}**`;
      dataKartu = hits.slice(0, 4).map(v => ({
        nama: v.nama, nilai: fmt(v.nilai), satuan: v.satuan, tahun: v.tahun,
        sumber: cariPub(v.nama.split(' ').slice(0, 2).join(' '), 1)[0] || null
      }));

      if (isTrend) {
        const rowData = baca(INDIK_FILE)['Tahunan'] || [];
        let headerRow = null;
        for (const row of rowData) {
          if (!row) continue;
          if (row.filter(c => /^20\d{2}$/.test(String(c || '').trim())).length >= 3) { headerRow = row; continue; }
          if (!row[0] || !headerRow) continue;
          if (String(row[0]).trim().toLowerCase() === utama.nama.toLowerCase()) {
            trendData = headerRow
              .map((h, i) => ({ tahun: String(h || '').trim(), nilai: row[i] }))
              .filter(x => /^20\d{2}$/.test(x.tahun) && x.nilai !== null && x.nilai !== '')
              .map(x => ({ tahun: x.tahun, nilai: fmt(x.nilai) }));
            break;
          }
        }
        if (trendData.length) jawaban += `\n\nBerikut tren ${utama.nama} dari ${trendData[0].tahun} hingga ${trendData[trendData.length - 1].tahun}:`;
      }

      publikasi  = cariPub(keyword.split(' ').slice(0, 2).join(' '), 3);
      pdfHasil   = cariDalamPDF(rawKw);
      saranKueri = [`Tren ${utama.nama}`, `Publikasi tentang ${keyword}`, `Data kecamatan ${keyword}`];
    } else {
      // Coba cari di PDF juga
      pdfHasil  = cariDalamPDF(rawKw);
      publikasi = cariPub(lower.replace(/^(berapa|apa|lihat|tampilkan)\s*/, '').trim(), 4);
      if (pdfHasil.length || publikasi.length) {
        tipe    = pdfHasil.length ? 'pdf' : 'publikasi';
        jawaban = `Saya menemukan informasi tentang **"${rawKw}"** di dalam publikasi BPS:`;
      } else {
        tipe    = 'notfound';
        jawaban = `Maaf, saya tidak menemukan data untuk "**${pesan}**".\n\nCoba pertanyaan seperti:\n- Berapa jumlah penduduk Jeneponto?\n- Berapa IPM 2025?\n- Berapa kemiskinan?\n- Luas lahan sawah Jeneponto\n- Berapa aset daerah?`;
        saranKueri = ['Berapa jumlah penduduk?', 'Berapa IPM Jeneponto?', 'Berapa angka kemiskinan?', 'Luas lahan pertanian'];
      }
    }
  }

  // ═══ 2. KECAMATAN ════════════════════════════════════
  else if (isKecamatan) {
    tipe = 'kecamatan';
    const namaKec = words.find(w => allKec.some(k => k.kecamatan.toLowerCase().includes(w) && w.length > 3));

    if (namaKec) {
      const kec = allKec.filter(k => k.kecamatan.toLowerCase().includes(namaKec) && k.kecamatan !== 'TOTAL');
      kecamatan = kec;
      jawaban   = `Data penduduk **Kecamatan ${kec.map(k => k.kecamatan).join(', ')}** di Kabupaten Jeneponto:`;
      publikasi = cariPub(`kecamatan ${namaKec} dalam angka`, 3);
      pdfHasil  = cariDalamPDF(`kecamatan ${namaKec}`);
    } else if (isTertinggi) {
      const sorted = [...allKec].filter(k => k.kecamatan !== 'TOTAL').sort((a, b) => b.penduduk - a.penduduk);
      kecamatan  = sorted.slice(0, 3);
      jawaban    = `Kecamatan dengan **penduduk terbanyak** di Kabupaten Jeneponto:\n1. **${sorted[0].kecamatan}** – ${sorted[0].penduduk.toLocaleString('id')} jiwa\n2. **${sorted[1].kecamatan}** – ${sorted[1].penduduk.toLocaleString('id')} jiwa\n3. **${sorted[2].kecamatan}** – ${sorted[2].penduduk.toLocaleString('id')} jiwa`;
    } else if (isTerendah) {
      const sorted = [...allKec].filter(k => k.kecamatan !== 'TOTAL').sort((a, b) => a.penduduk - b.penduduk);
      kecamatan  = sorted.slice(0, 3);
      jawaban    = `Kecamatan dengan **penduduk paling sedikit** di Kabupaten Jeneponto:\n1. **${sorted[0].kecamatan}** – ${sorted[0].penduduk.toLocaleString('id')} jiwa\n2. **${sorted[1].kecamatan}** – ${sorted[1].penduduk.toLocaleString('id')} jiwa\n3. **${sorted[2].kecamatan}** – ${sorted[2].penduduk.toLocaleString('id')} jiwa`;
    } else {
      kecamatan  = allKec.filter(k => k.kecamatan !== 'TOTAL');
      const total = allKec.find(k => k.kecamatan === 'TOTAL');
      jawaban    = `Berikut data **penduduk seluruh kecamatan** di Kabupaten Jeneponto (Total: **${total?.penduduk.toLocaleString('id') || '418.966'} jiwa**):`;
    }
    saranKueri = ['Kecamatan dengan penduduk terbanyak', 'Kecamatan dengan penduduk paling sedikit', 'Berapa jumlah penduduk Jeneponto?'];
  }

  // ═══ 3. LAHAN / PERTANIAN ════════════════════════════
  else if (isLahan || isPertanian) {
    tipe = 'pdf';
    const topik = isLahan ? 'luas lahan' : 'pertanian';
    pdfHasil  = cariDalamPDF(lower.replace(/\b(berapa|jelaskan|tampilkan|lihat|cari)\b/gi, '').trim());
    publikasi = cariPub(lower, 4);

    const indHits = cariIndikator(topik);
    if (indHits.length) {
      dataKartu = indHits.slice(0, 3).map(v => ({
        nama: v.nama, nilai: fmt(v.nilai), satuan: v.satuan, tahun: v.tahun, sumber: null
      }));
      jawaban = `Data **${topik}** di Kabupaten Jeneponto:`;
    } else if (pdfHasil.length) {
      jawaban = `Berikut informasi **${topik}** dari publikasi BPS Kabupaten Jeneponto:`;
    } else if (publikasi.length) {
      tipe    = 'publikasi';
      jawaban = `Berikut publikasi BPS Jeneponto terkait **${topik}**:`;
    } else {
      tipe    = 'notfound';
      jawaban = `Data spesifik tentang **${topik}** belum tersedia. Silakan cek publikasi "Jeneponto Dalam Angka" atau "Sensus Pertanian".`;
    }
    saranKueri = ['Luas lahan sawah Jeneponto', 'Produksi padi Jeneponto', 'Tampilkan Sensus Pertanian 2023', 'Berapa luas wilayah Jeneponto?'];
  }

  // ═══ 4. ASET / KEUANGAN DAERAH ═══════════════════════
  else if (isAset) {
    tipe      = 'pdf';
    pdfHasil  = cariDalamPDF('aset daerah keuangan');
    publikasi = cariPub('keuangan daerah aset dalam angka', 4);

    const indHits = cariIndikator('aset');
    if (indHits.length) {
      dataKartu = indHits.slice(0, 3).map(v => ({
        nama: v.nama, nilai: fmt(v.nilai), satuan: v.satuan, tahun: v.tahun, sumber: null
      }));
      jawaban = `Data **aset dan keuangan daerah** Kabupaten Jeneponto:`;
    } else if (pdfHasil.length || publikasi.length) {
      jawaban = `Berikut informasi **aset daerah** dari publikasi BPS Kabupaten Jeneponto:`;
    } else {
      tipe    = 'notfound';
      jawaban = `Data aset daerah dapat ditemukan di publikasi "Jeneponto Dalam Angka". Coba: **Tampilkan Jeneponto Dalam Angka 2026**`;
    }
    saranKueri = ['Tampilkan Jeneponto Dalam Angka 2026', 'Berapa APBD Jeneponto?', 'Data keuangan daerah Jeneponto'];
  }

  // ═══ 5. DESA / POTENSI DESA ══════════════════════════
  else if (isDesa) {
    tipe      = 'pdf';
    pdfHasil  = cariDalamPDF('desa kelurahan potensi');
    publikasi = cariPub('potensi desa dalam angka', 4);
    jawaban   = pdfHasil.length || publikasi.length
      ? `Berikut informasi **desa dan kelurahan** dari publikasi BPS Kabupaten Jeneponto:`
      : `Data potensi desa tersedia di publikasi "Statistik Potensi Desa". Coba: **Tampilkan Potensi Desa 2025**`;
    saranKueri = ['Tampilkan Potensi Desa Jeneponto 2025', 'Berapa jumlah desa di Jeneponto?', 'Data kecamatan Jeneponto'];
  }

  // ═══ 6. TAMPILKAN / CARI PUBLIKASI ═══════════════════
  else if (isTampilkan) {
    const keyword = lower.replace(/^(tampilkan|lihat|show|buka|cari|temukan|perlihatkan|download|unduh)\s*/, '').trim();
    publikasi = cariPub(keyword, 6);
    pdfHasil  = cariDalamPDF(keyword);
    tipe      = 'publikasi';

    if (publikasi.length) {
      jawaban = `Ditemukan **${publikasi.length} publikasi** untuk "**${keyword}**":`;
    } else if (pdfHasil.length) {
      tipe    = 'pdf';
      jawaban = `Ditemukan informasi tentang "**${keyword}**" di dalam publikasi:`;
    } else {
      tipe    = 'notfound';
      jawaban = `Tidak ditemukan publikasi untuk "**${keyword}**". Coba kata kunci seperti "dalam angka", "statistik daerah", atau "PDRB".`;
    }
    saranKueri = ['Tampilkan Kabupaten Jeneponto Dalam Angka 2026', 'Tampilkan statistik daerah', 'Cari publikasi PDRB', 'Tampilkan Potensi Desa 2025'];
  }

  // ═══ 7. PENCARIAN UMUM ═══════════════════════════════
  else {
    const indHits = cariIndikator(lower).slice(0, 4);
    const pubHits = cariPub(lower, 4);
    const pdfHits = cariDalamPDF(lower);
    const kecHits = words.filter(w => allKec.some(k => k.kecamatan.toLowerCase().includes(w) && w.length > 3));

    if (indHits.length || pubHits.length || pdfHits.length || kecHits.length) {
      tipe      = indHits.length ? 'gabungan' : (pdfHits.length ? 'pdf' : 'publikasi');
      dataKartu = indHits.map(v => ({ nama: v.nama, nilai: fmt(v.nilai), satuan: v.satuan, tahun: v.tahun, sumber: cariPub(v.nama.split(' ').slice(0, 2).join(' '), 1)[0] || null }));
      publikasi = pubHits;
      pdfHasil  = pdfHits;
      tabelMakro = cocokMakro(lower);
      if (kecHits.length) kecamatan = allKec.filter(k => kecHits.some(w => k.kecamatan.toLowerCase().includes(w)) && k.kecamatan !== 'TOTAL');
      jawaban   = `Hasil pencarian untuk "**${pesan}**":`;
    } else {
      tipe    = 'notfound';
      jawaban = `Maaf, saya tidak menemukan data untuk "**${pesan}**".\n\nCoba tanya:\n- Berapa jumlah penduduk?\n- Berapa IPM 2025?\n- Luas lahan sawah\n- Aset daerah Jeneponto\n- Data kecamatan Binamu\n- Tampilkan Dalam Angka 2026`;
      saranKueri = ['Berapa jumlah penduduk Jeneponto?', 'Berapa IPM 2025?', 'Luas lahan pertanian', 'Tampilkan Dalam Angka 2026'];
    }
  }

  // Fallback: pastikan tabel makro selalu tersedia bila relevan dgn pertanyaan
  if (!tabelMakro.length) tabelMakro = cocokMakro(lower);

  res.json({ ok: true, tipe, jawaban, dataKartu, publikasi, kecamatan, trendData, saranKueri, pdfHasil, tabelMakro });
});

// ══════════════════════════════════════════════════════
// PUBLIC API – PENCARIAN UNIVERSAL
// ══════════════════════════════════════════════════════

// Cache parsed indikator makro (agar tidak parsing ulang tiap request)
let _indikatorCache = null;
function getIndikatorMakro() {
  if (_indikatorCache) return _indikatorCache;
  if (!fs.existsSync(INDIK_FILE)) return [];

  const data   = baca(INDIK_FILE);
  const result = [];
  const namaSet = new Set(); // hindari duplikat

  // Parse satu sheet dan tambah ke result
  function parseSheet(rows) {
    let headerRow = null;
    for (const row of (rows || [])) {
      if (!row || row.every(c => !c)) continue;

      // Deteksi baris header tahun
      const colsWithYear = row.filter(c => /^20\d{2}$/.test(String(c || '').trim()));
      if (colsWithYear.length >= 3) { headerRow = row; continue; }

      if (!row[0] || !headerRow) continue;
      const nama = String(row[0]).trim();
      if (nama.length < 3 || namaSet.has(nama.toLowerCase())) continue;

      // Skip section headers
      const dataCols = row.filter(c => c !== null && c !== '');
      if (dataCols.length <= 2 && !row[1]) continue;

      const satuan = String(row[1] || '').trim();

      // Ambil nilai terbaru (tahun terakhir yang ada datanya)
      let latestTahun = '', latestNilai = '';
      for (let i = 2; i < (headerRow.length || 0); i++) {
        const tahun = String(headerRow[i] || '').trim();
        const nilai = row[i];
        if (/^20\d{2}$/.test(tahun) && nilai !== null && nilai !== '' && String(nilai).trim() !== '') {
          latestTahun = tahun;
          latestNilai = String(nilai).trim().replace(/\s+/g, ' ');
        }
      }

      if (latestNilai) {
        result.push({ nama, satuan, tahun: latestTahun, nilai: latestNilai });
        namaSet.add(nama.toLowerCase());
      }
    }
  }

  // Parse: Tahunan (utama) → Summary (pelengkap)
  parseSheet(data['Tahunan']);
  parseSheet(data['Summary']);

  _indikatorCache = result;
  return result;
}

// Invalidate cache saat server restart (otomatis)
// GET /api/search?q=... – pencarian universal
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q || q.length < 2) return res.json({ ok:true, query:q, indikatorMakro:[], publikasi:[], tabelDinamis:[] });

  const words = q.split(/\s+/).filter(w => w.length > 1);

  function cocok(teks) {
    const t = (teks || '').toLowerCase();
    return words.every(w => t.includes(w));
  }

  const allPub = baca(DATA_FILE);

  // ── Peta sumber publikasi untuk tiap kategori indikator ──────
  const SUMBER_MAP = {
    'miskin'       : ['kemiskinan','statistik daerah','kesejahteraan'],
    'kemiskinan'   : ['kemiskinan','statistik daerah'],
    'penduduk'     : ['dalam angka','statistik daerah'],
    'pdrb'         : ['pdrb','produk domestik','lapangan usaha'],
    'ipm'          : ['pembangunan manusia','statistik daerah','dalam angka'],
    'tpak'         : ['ketenagakerjaan','dalam angka'],
    'pengangguran' : ['ketenagakerjaan','dalam angka'],
    'angkatan kerja':['ketenagakerjaan','dalam angka'],
    'gini'         : ['statistik daerah','kesejahteraan'],
    'inflasi'      : ['inflasi','harga','statistik daerah'],
    'pertanian'    : ['pertanian','hortikultura','statistik daerah'],
    'ipg'          : ['gender','dalam angka','statistik daerah'],
    'harapan hidup': ['pembangunan manusia','statistik daerah'],
    'sekolah'      : ['pembangunan manusia','statistik daerah'],
    'default'      : ['dalam angka','statistik daerah'],
  };

  function cariSumber(namaIndikator) {
    const n = namaIndikator.toLowerCase();
    let kwList = SUMBER_MAP['default'];
    for (const [key, kws] of Object.entries(SUMBER_MAP)) {
      if (key !== 'default' && n.includes(key)) { kwList = kws; break; }
    }
    for (const kw of kwList) {
      const match = allPub.find(p =>
        (p.judul||'').toLowerCase().includes(kw) ||
        (p.deskripsi||'').toLowerCase().includes(kw)
      );
      if (match) return { judul: match.judul, tahun: match.tahun, url: match.url };
    }
    return null;
  }

  // ── 1. Indikator Makro + sumber ───────────────────────
  const indikatorMakro = getIndikatorMakro()
    .filter(v => cocok(v.nama))
    .slice(0, 8)
    .map(v => ({
      ...v,
      sumber      : cariSumber(v.nama),
      sumberExcel : 'Indikator Makro BPS Kab. Jeneponto',
      sumberUrl   : 'https://s.bps.go.id/7304_indikatormakro',
    }));

  // ── 2. Tabel Dinamis ─────────────────────────────────
  let tabelDinamis = [];
  if (fs.existsSync(TABEL_FILE)) {
    const td = baca(TABEL_FILE);
    tabelDinamis = (td.indikator || [])
      .filter(v => cocok(v.judul) || cocok(v.subjek) || cocok(v.kategori))
      .slice(0, 5);
  }

  // ── 2b. Tabel Statistik Makro (seri tahun penuh) ─────
  let tabelMakro = [];
  try {
    if (fs.existsSync(MAKRO_FILE)) {
      const makro = baca(MAKRO_FILE).tabel || [];
      tabelMakro = makro.filter(t =>
        cocok(t.nama) || t.rows.some(r => cocok(r.label))
      ).slice(0, 3).map(t => ({ nama: t.nama, years: [t.years[0], t.years[t.years.length-1]], jml: t.rows.length }));
    }
  } catch {}

  // ── 3. Publikasi (gunakan allPub yang sudah di-load) ──
  const publikasi = allPub
    .filter(p => cocok(p.judul) || cocok(p.deskripsi))
    .slice(0, 5);

  // ── 4. Data Kecamatan ─────────────────────────────────
  let kecamatan = [];
  const kecWords = ['kecamatan','penduduk','bangkala','tamalatea','bontoramba',
    'binamu','turatea','batang','arungkeke','tarowang','kelara','rumbia'];
  const isKecQuery = words.some(w => kecWords.includes(w)) ||
                     q.includes('perkecamatan') || q.includes('per kecamatan') ||
                     q.includes('tiap kecamatan') || q.includes('semua kecamatan');

  if (fs.existsSync(KECAM_FILE)) {
    const allKec = baca(KECAM_FILE);
    if (isKecQuery) {
      // Cari kecamatan tertentu atau tampilkan semua
      const namaKec = words.find(w => allKec.some(k => k.kecamatan.toLowerCase().includes(w)));
      if (namaKec) {
        kecamatan = allKec.filter(k => k.kecamatan.toLowerCase().includes(namaKec));
      } else {
        kecamatan = allKec.filter(k => k.kecamatan !== 'TOTAL');
      }
    }
    // Cari kecamatan spesifik dari kata kunci
    allKec.filter(k => k.kecamatan !== 'TOTAL').forEach(k => {
      if (cocok(k.kecamatan) && !kecamatan.find(x => x.kecamatan === k.kecamatan)) {
        kecamatan.push(k);
      }
    });
  }

  // Sumber publikasi kecamatan
  const pubKec = (baca(DATA_FILE))
    .filter(p => p.judul?.toLowerCase().includes('dalam angka') && p.judul?.toLowerCase().includes('kecamatan'))
    .slice(0, 3);

  res.json({ ok:true, query:q, indikatorMakro, tabelMakro, tabelDinamis, publikasi, kecamatan, pubKec });
});

// ══════════════════════════════════════════════════════
// PUBLIC API – TABEL DINAMIS (Query Builder)
// ══════════════════════════════════════════════════════

const TABEL_FILE   = path.join(DB_DIR, 'tabel-dinamis.json');
const MAKRO_FILE   = path.join(DB_DIR, 'tabel-makro.json');
const QB_ACTION_ID = '4021dfaf43c953af11f195251034832558459c7b'; // Next-Action ID

// GET /api/tabel-makro – tabel statistik makro langsung (data aktual Jeneponto)
app.get('/api/tabel-makro', (req, res) => {
  if (!fs.existsSync(MAKRO_FILE)) return res.json({ ok: true, tabel: [] });
  const data = baca(MAKRO_FILE);
  const q = (req.query.q || '').toLowerCase().trim();
  let tabel = data.tabel || [];
  if (q) tabel = tabel.filter(t => t.nama.toLowerCase().includes(q) || t.rows.some(r => r.label.toLowerCase().includes(q)));
  res.json({ ok: true, sumber: data.sumber, satuan: data.satuan, total: tabel.length, tabel });
});

// GET /api/tabel-makro/:nama/export – unduh tabel makro sebagai file Excel (.xlsx)
app.get('/api/tabel-makro/:nama/export', (req, res) => {
  if (!fs.existsSync(MAKRO_FILE)) return res.status(404).json({ ok: false, error: 'Data tidak tersedia' });
  const data   = baca(MAKRO_FILE);
  const nama   = decodeURIComponent(req.params.nama);
  const tabel  = (data.tabel || []).find(t => t.nama.toLowerCase() === nama.toLowerCase());
  if (!tabel) return res.status(404).json({ ok: false, error: `Tabel "${nama}" tidak ditemukan` });

  try {
    const XLSX = require('xlsx');
    // Baris pertama: [nama, tahun1, tahun2, ...]
    const aoa = [['Indikator', ...tabel.years]];
    tabel.rows.forEach(r => {
      aoa.push([r.label + (r.satuan ? ' (' + r.satuan + ')' : ''), ...r.nilai.map(v => (v ?? '') === '' ? '' : v)]);
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 45 }, ...tabel.years.map(() => ({ wch: 14 }))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, tabel.nama.slice(0, 31));
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fname = tabel.nama.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/tabel-makro/export-all – gabungkan semua tabel makro dalam satu Excel
app.get('/api/tabel-makro/export-all', (req, res) => {
  if (!fs.existsSync(MAKRO_FILE)) return res.status(404).json({ ok: false, error: 'Data tidak tersedia' });
  const data = baca(MAKRO_FILE);
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    (data.tabel || []).forEach((tabel, i) => {
      const aoa = [['Indikator', ...tabel.years]];
      tabel.rows.forEach(r => {
        aoa.push([r.label + (r.satuan ? ' (' + r.satuan + ')' : ''), ...r.nilai.map(v => (v ?? '') === '' ? '' : v)]);
      });
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      XLSX.utils.book_append_sheet(wb, ws, ('T' + (i + 1) + ' ' + tabel.nama).slice(0, 31));
    });
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="tabel-makro-jeneponto.xlsx"');
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/tabel-dinamis – daftar semua indikator
app.get('/api/tabel-dinamis', (req, res) => {
  if (!fs.existsSync(TABEL_FILE)) return res.json({ ok: true, total: 0, indikator: [] });
  const data = baca(TABEL_FILE);
  const q    = (req.query.q || '').toLowerCase();
  const kat  = req.query.kategori || '';
  let list   = data.indikator || [];
  if (q)   list = list.filter(v => v.judul?.toLowerCase().includes(q) || v.subjek?.toLowerCase().includes(q) || v.kategori?.toLowerCase().includes(q));
  if (kat) list = list.filter(v => v.kategori === kat);
  res.json({ ok: true, total: list.length, diambilPada: data.diambilPada, indikator: list });
});

// POST /api/tabel-dinamis/refresh – ambil ulang dari BPS (admin only)
app.post('/api/tabel-dinamis/refresh', requireAdmin, async (req, res) => {
  res.json({ ok: true, pesan: 'Gunakan: node scrape-tabel-dinamis.js untuk refresh data' });
});

// GET /api/tabel-dinamis/data/:var_id – ambil data tabel untuk indikator tertentu
app.get('/api/tabel-dinamis/data/:var_id', async (req, res) => {
  const varId = req.params.var_id;
  const tahun = req.query.tahun || '';
  const judul = (baca(TABEL_FILE).indikator || []).find(v => String(v.var_id) === String(varId))?.judul || varId;

  // 1) Coba cari data makro yang relevan (langsung, tanpa scrape BPS)
  let makro = [];
  try { if (fs.existsSync(MAKRO_FILE)) makro = baca(MAKRO_FILE).tabel || []; } catch {}
  if (makro.length) {
    const low = String(judul).toLowerCase();
    const cand = makro.filter(t => {
      // cocokkan kata kunci subjek pada judul tabel vs nama/baris makro
      const kata = ['penduduk','kemiskinan','ketenagakerjaan','tenaga kerja','pekerja',
                    'pembangunan','ipm','kependudukan','konstruksi','pertanian','padi','jagung',
                    'pengangguran','tpak','tpt','pdrb','ekonomi'];
      const k = kata.find(w => low.includes(w));
      if (!k) return false;
      return true;
    });
    if (cand.length) {
      return res.json({ ok: true, var_id: varId, judul, sumber: 'Tabel Statistik Makro BPS Jeneponto', data: { datacontent: cand } });
    }
  }

  res.json({ ok: true, var_id: varId, judul, data: null, catatan: 'Data tabular Query Builder tidak diambil on-demand. Buka Query Builder BPS untuk data interaktif penuh.' });
});

// GET /api/tabel-dinamis/data/:var_id/export – unduh data tabel dinamis sebagai Excel (.xlsx)
app.get('/api/tabel-dinamis/data/:var_id/export', (req, res) => {
  try {
    const varId = req.params.var_id;
    const judul = (baca(TABEL_FILE).indikator || []).find(v => String(v.var_id) === String(varId))?.judul || 'tabel-' + varId;

    let aoa = []; let sheetName = 'Data';
    if (fs.existsSync(MAKRO_FILE)) {
      const makro = baca(MAKRO_FILE).tabel || [];
      const low = String(judul).toLowerCase();
      const kata = ['penduduk','kemiskinan','ketenagakerjaan','tenaga kerja','pekerja',
                    'pembangunan','ipm','kependudukan','konstruksi','pertanian','padi','jagung',
                    'pengangguran','tpak','tpt','pdrb','ekonomi'];
      const k = kata.find(w => low.includes(w));
      const cand = k ? makro : [];
      // Jika banyak kandidat, ambil yang paling cocok dengan subjek utama
      const tabel = (cand.length === 1) ? cand[0] : (cand.find(t => t.nama.toLowerCase().includes(low.split(' ')[0])) || cand[0]);
      if (tabel) {
        aoa = [['Indikator', ...tabel.years]];
        tabel.rows.forEach(r => {
          aoa.push([r.label + (r.satuan ? ' (' + r.satuan + ')' : ''), ...r.nilai.map(v => (v ?? '') === '' ? '' : v)]);
        });
        sheetName = tabel.nama.slice(0, 31);
      }
    }

    if (!aoa.length) {
      aoa = [['Informasi'], ['Data tabular belum tersedia untuk var_id ini. Gunakan Query Builder BPS resmi.']];
    }

    const XLSX = require('xlsx');
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 45 }, ...(aoa[0] || []).slice(1).map(() => ({ wch: 14 }))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Data');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fname = (String(judul).toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'tabel') + '.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════
// PUBLIC API – PUBLIKASI
// ══════════════════════════════════════════════════════

app.get('/api/publikasi', (req, res) => {
  let data = baca(DATA_FILE);
  const q  = (req.query.q || '').toLowerCase().trim();
  const th = req.query.tahun || '';
  const kt = req.query.kategori || '';
  const pg = parseInt(req.query.page  || '1', 10);
  const lm = parseInt(req.query.limit || '12', 10);

  if (q)  data = data.filter(p => p.judul?.toLowerCase().includes(q) || p.deskripsi?.toLowerCase().includes(q));
  if (th) data = data.filter(p => String(p.tahun) === th);
  if (kt) data = data.filter(p => p.kategori === kt);

  const total = data.length;
  res.json({ ok: true, total, halaman: pg, limit: lm, data: data.slice((pg-1)*lm, pg*lm) });
});

app.get('/api/stats', (req, res) => {
  const data = baca(DATA_FILE);
  const kat = {}; const thn = new Set();
  data.forEach(p => { kat[p.kategori] = (kat[p.kategori]||0)+1; if(p.tahun) thn.add(p.tahun); });
  res.json({ ok: true, total: data.length, totalKategori: Object.keys(kat).length,
    totalTahun: thn.size, tahunMin: Math.min(...thn), tahunMax: Math.max(...thn),
    kategori: kat, terbaru: data.slice(0, 6) });
});

// ══════════════════════════════════════════════════════
// API – SUMBER DATA (interkoneksi BPS)
// ══════════════════════════════════════════════════════

app.get('/api/sumber', (req, res) => {
  let data = { sumber: [] };
  try { if (fs.existsSync(SUMBER_FILE)) data = baca(SUMBER_FILE); } catch {}
  const tgl = f => { try { return fs.existsSync(f) ? fs.statSync(f).mtime.toISOString() : null; } catch { return null; } };
  res.json({
    ok: true,
    keterangan: data.keterangan || '',
    sumber: (data.sumber || []).map(s => ({
      ...s,
      updateTerakhir: s.file ? tgl(path.join(DB_DIR, path.basename(String(s.file)))) : null,
    })),
  });
});

// ══════════════════════════════════════════════════════
// API – COVER PUBLIKASI (proxy BPS agar tampil di browser)
// ══════════════════════════════════════════════════════

const coverCache = new Map();
const COVER_TTL = 30 * 60 * 1000;
app.get('/api/cover', async (req, res) => {
  let u = req.query.url || req.query.u || '';
  if (!u) return res.status(400).json({ ok: false, error: 'Parameter url diperlukan' });
  try { u = decodeURIComponent(u); } catch {}

  // terima juga link proxy _next/image BPS, ambil param url sebenarnya
  const m = u.match(/[?&]url=([^&]+)/);
  if (u.includes('_next/image') && m) {
    try { u = decodeURIComponent(m[1]); } catch { u = m[1]; }
  }

  const hit = coverCache.get(u);
  const kirim = (type, buf) => {
    res.set('Content-Type', type);
    res.set('Cache-Control', 'public, max-age=1800');
    res.send(buf);
  };
  if (hit && Date.now() - hit.t < COVER_TTL) return kirim(hit.type, hit.buf);

  try {
    const r = await fetch(u, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36' },
    });
    if (!r.ok) return res.status(502).json({ ok: false, error: 'Sumber cover: HTTP ' + r.status });
    const buf = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get('content-type') || 'image/jpeg';
    if (coverCache.size > 250) coverCache.delete(coverCache.keys().next().value);
    coverCache.set(u, { t: Date.now(), buf, type });
    kirim(type, buf);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════
// API – INDIKATOR MAKRO (baca publik, edit perlu login)
// ══════════════════════════════════════════════════════

// GET /api/indikator – daftar sheet
app.get('/api/indikator', (req, res) => {
  const data = baca(INDIK_FILE);
  res.json({ ok: true, sheets: Object.keys(data) });
});

// GET /api/indikator/:sheet – data satu sheet
app.get('/api/indikator/:sheet', (req, res) => {
  const data  = baca(INDIK_FILE);
  const sheet = decodeURIComponent(req.params.sheet);
  if (!data[sheet]) return res.status(404).json({ ok: false, error: 'Sheet tidak ditemukan' });
  res.json({ ok: true, sheet, rows: data[sheet] });
});

// PUT /api/indikator/:sheet/cell – update sel (perlu login)
app.put('/api/indikator/:sheet/cell', requireAuth, (req, res) => {
  const data  = baca(INDIK_FILE);
  const sheet = decodeURIComponent(req.params.sheet);
  const { row, col, value } = req.body;
  if (!data[sheet]) return res.status(404).json({ ok: false, error: 'Sheet tidak ditemukan' });
  if (row === undefined || col === undefined) return res.status(400).json({ ok: false, error: 'row/col diperlukan' });

  if (!data[sheet][row]) data[sheet][row] = [];
  data[sheet][row][col] = value ?? null;
  tulis(INDIK_FILE, data);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════
// ADMIN API – PUBLIKASI CRUD
// ══════════════════════════════════════════════════════

app.get('/api/admin/publikasi', requireAdmin, (req, res) => {
  const data = baca(DATA_FILE);
  const q    = (req.query.q || '').toLowerCase();
  const items = q ? data.filter(p => p.judul?.toLowerCase().includes(q)) : data;
  res.json({ ok: true, total: items.length, data: items });
});

app.post('/api/admin/publikasi', requireAdmin,
  upload.fields([{ name:'cover',maxCount:1 },{ name:'file',maxCount:1 }]),
  (req, res) => {
    const data = baca(DATA_FILE); const files = req.files||{}; const body = req.body;
    const tm = (body.tanggal||'').match(/\b(20\d{2}|19\d{2})\b/);
    const pub = {
      id: Date.now(), judul: body.judul||'', tanggal: body.tanggal||'',
      tahun: tm ? parseInt(tm[1]) : null,
      deskripsi: body.deskripsi||'', kategori: body.kategori||'Lainnya',
      cover: files.cover ? `/uploads/covers/${files.cover[0].filename}` : (body.coverUrl||''),
      url: body.url||'',
      fileLokal: files.file ? `/uploads/files/${files.file[0].filename}` : '',
      lokal: true, dibuatPada: new Date().toISOString(),
    };
    data.unshift(pub); tulis(DATA_FILE, data);
    res.json({ ok: true, data: pub });
  }
);

app.put('/api/admin/publikasi/:id', requireAdmin,
  upload.fields([{ name:'cover',maxCount:1 },{ name:'file',maxCount:1 }]),
  (req, res) => {
    const data = baca(DATA_FILE); const files = req.files||{}; const body = req.body;
    const idx = data.findIndex(p => String(p.id) === String(req.params.id));
    if (idx < 0) return res.status(404).json({ ok: false, error: 'Tidak ditemukan' });
    const pub = { ...data[idx] };
    if (body.judul)     pub.judul     = body.judul;
    if (body.tanggal)   pub.tanggal   = body.tanggal;
    if (body.deskripsi) pub.deskripsi = body.deskripsi;
    if (body.kategori)  pub.kategori  = body.kategori;
    if (body.url)       pub.url       = body.url;
    if (files.cover)    pub.cover     = `/uploads/covers/${files.cover[0].filename}`;
    if (files.file)     pub.fileLokal = `/uploads/files/${files.file[0].filename}`;
    const tm = (pub.tanggal||'').match(/\b(20\d{2}|19\d{2})\b/);
    if (tm) pub.tahun = parseInt(tm[1]);
    pub.diupdatePada = new Date().toISOString();
    data[idx] = pub; tulis(DATA_FILE, data);
    res.json({ ok: true, data: pub });
  }
);

app.delete('/api/admin/publikasi/:id', requireAdmin, (req, res) => {
  let data = baca(DATA_FILE);
  const n  = data.length;
  data = data.filter(p => String(p.id) !== String(req.params.id));
  if (data.length === n) return res.status(404).json({ ok: false, error: 'Tidak ditemukan' });
  tulis(DATA_FILE, data); res.json({ ok: true });
});

// ══════════════════════════════════════════════════════
// ADMIN API – USER MANAGEMENT
// ══════════════════════════════════════════════════════

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = baca(USERS_FILE).map(({ password: _, ...u }) => u);
  res.json({ ok: true, total: users.length, data: users });
});

app.put('/api/admin/users/:id', requireAdmin, (req, res) => {
  const users = baca(USERS_FILE);
  const idx   = users.findIndex(u => String(u.id) === String(req.params.id));
  if (idx < 0) return res.status(404).json({ ok: false, error: 'User tidak ditemukan' });
  const { role, aktif, nama } = req.body;
  if (role  !== undefined) users[idx].role  = role;
  if (aktif !== undefined) users[idx].aktif = aktif;
  if (nama)                users[idx].nama  = nama;
  tulis(USERS_FILE, users);
  const { password: _, ...u } = users[idx];
  res.json({ ok: true, data: u });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  let users = baca(USERS_FILE);
  const n   = users.length;
  users     = users.filter(u => String(u.id) !== String(req.params.id));
  if (users.length === n) return res.status(404).json({ ok: false, error: 'User tidak ditemukan' });
  tulis(USERS_FILE, users); res.json({ ok: true });
});

// ══════════════════════════════════════════════════════
// ADMIN API – GANTI PASSWORD
// ══════════════════════════════════════════════════════

app.put('/api/admin/password', requireAdmin, (req, res) => {
  const { passwordLama, passwordBaru } = req.body;
  if (!passwordBaru || passwordBaru.length < 6)
    return res.status(400).json({ ok: false, error: 'Password baru min. 6 karakter' });
  const admins = baca(ADMIN_FILE);
  const idx    = admins.findIndex(a => a.id === req.user.id);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'Admin tidak ditemukan' });
  if (!bcrypt.compareSync(passwordLama, admins[idx].password))
    return res.status(400).json({ ok: false, error: 'Password lama salah' });
  admins[idx].password = bcrypt.hashSync(passwordBaru, 10);
  tulis(ADMIN_FILE, admins);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════
// ADMIN API – IMPORT dari BPS (SSE)
// ══════════════════════════════════════════════════════

// GET /api/admin/refresh/indikator – refresh Indikator Makro saja (SSE, cepat)
app.get('/api/admin/refresh/indikator', requireAdmin, async (req, res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders();
  const kirim = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  try {
    await refreshIndikator(pesan => kirim({ tipe:'indikator', pesan }));
    kirim({ tipe:'selesai', totalSheet: 0, pesan: 'Indikator Makro berhasil diperbarui otomatis' });
    const makro = baca(MAKRO_FILE);
    kirim({ tipe:'makro', tabel: (makro.tabel||[]).map(t => ({ nama:t.nama, jml:t.rows.length })) });
  } catch(e) {
    kirim({ tipe:'error', pesan:e.message });
  } finally {
    res.end();
  }
});

app.get('/api/admin/import', requireAdmin, async (req, res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders();

  const kirim = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // Langkah 1: auto-refresh Indikator Makro dari Google Sheets BPS
  try {
    await refreshIndikator(pesan => kirim({ tipe:'indikator', pesan }));
    kirim({ tipe:'indikator', pesan: '✓ Indikator Makro otomatis diperbarui' });
  } catch(e) {
    kirim({ tipe:'indikator', pesan: `⚠ Indikator Makro dilewati: ${e.message}` });
  }

  const browser = await chromium.launch({
    channel:'chrome', headless:true,
    args:['--disable-blink-features=AutomationControlled','--no-sandbox']
  });
  const ctx     = await browser.newContext({
    userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale:'id-ID', viewport:{ width:1920, height:1080 }
  });
  const page    = await ctx.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator,'webdriver',{get:()=>false}); });

  try {
    const dataLama = baca(DATA_FILE).filter(p => p.lokal);
    await page.goto(`${BASE_URL}?page=1`, { waitUntil:'domcontentloaded', timeout:30000 });
    for (let i = 0; i < 20; i++) {
      const c = await page.evaluate(() => document.querySelectorAll('a.rounded-xl').length);
      if (c) break;
      await new Promise(r => setTimeout(r, 1200));
    }

    const total = await page.evaluate(()=>{
      const m = document.body.innerText.match(/dari\s+([\d.]+)\s+Publikasi/i);
      return m ? parseInt(m[1].replace(/\./g,''),10) : 0;
    });
    const totalHal = Math.ceil(total/10);
    kirim({ tipe:'info', total, totalHalaman:totalHal });

    // ── Ekstraktor DOM (dijalankan di tiap halaman) ──
    const EXTRACT = () => {
      return Array.from(document.querySelectorAll('a.rounded-xl')).map(card=>{
        const j=card.querySelector('p[class*="text-main-primary"]');
        const t=card.querySelector('p[class*="caption"]');
        const d=card.querySelector('p[class*="overflow-text-ellipsis"]');
        const im=card.querySelector('img[alt]');
        const judul=j?j.innerText.trim():'';const tanggal=t?t.innerText.trim():'';
        const deskripsi=d?d.innerText.trim():'';const cover=im?im.src:'';
        const tm=tanggal.match(/\b(20\d{2})\b/);const tahun=tm?parseInt(tm[1]):null;
        const jl=judul.toLowerCase();let kategori='Lainnya';
        if(jl.includes('dalam angka'))kategori='Dalam Angka';
        else if(jl.includes('statistik daerah'))kategori='Statistik Daerah';
        else if(jl.includes('pdrb')||jl.includes('produk domestik'))kategori='PDRB';
        else if(jl.includes('ipm')||jl.includes('pembangunan manusia'))kategori='IPM';
        else if(jl.includes('kemiskinan')||jl.includes('miskin'))kategori='Kemiskinan';
        else if(jl.includes('ketenagakerjaan')||jl.includes('tenaga kerja'))kategori='Ketenagakerjaan';
        else if(jl.includes('pertanian')||jl.includes('hortikultura'))kategori='Pertanian';
        else if(jl.includes('kesejahteraan'))kategori='Kesejahteraan';
        else if(jl.includes('kecamatan'))kategori='Kecamatan';
        else if(jl.includes('inflasi')||jl.includes('harga'))kategori='Harga & Inflasi';
        else if(jl.includes('potensi desa')||jl.includes('podes'))kategori='Potensi Desa';
        return{judul,tanggal,tahun,deskripsi,kategori,cover,url:card.href||''};
      }).filter(d=>d.judul.length>3&&d.url.includes('/publication/'));
    };

    // ── Sequential (Chrome asli bypasses CF reliably) ──
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const buka = async n => {
      for (let a = 1; a <= 3; a++) {
        try {
          await page.goto(`${BASE_URL}?page=${n}`, { waitUntil:'domcontentloaded', timeout:30000 });
        } catch {}
        let items = [];
        const t0 = Date.now();
        for (let i = 0; i < 20; i++) {
          try {
            const c = await page.evaluate(() => document.querySelectorAll('a.rounded-xl').length);
            if (c) { items = await page.evaluate(EXTRACT); if (items.length) break; }
          } catch {}
          if (Date.now() - t0 > 20000) break;
          await sleep(1200);
        }
        if (items.length) return items;
        await sleep(2000);
      }
      return [];
    };

    const hasil = []; const urlSet = new Set();
    for (let nTotal = 1; nTotal <= totalHal; nTotal++) {
      const items = await buka(nTotal);
      items.forEach(p => { if (!urlSet.has(p.url)) { urlSet.add(p.url); hasil.push(p); } });
      kirim({ tipe:'halaman', nomor:nTotal, totalHalaman:totalHal, jumlah:items.length, totalDitemukan:hasil.length });
      await sleep(800);
    }

    const gabung=[...hasil,...dataLama];
    tulis(DATA_FILE,gabung);
    kirim({tipe:'selesai',total:hasil.length,totalDenganLokal:gabung.length});
  } catch(e) {
    kirim({tipe:'error',pesan:e.message});
  } finally {
    await browser.close(); res.end();
  }
});

// ── Start ────────────────────────────────────────────
app.listen(PORT, () => {
  const d = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE)).length : 0;
  const u = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE)).length : 0;
  console.log(`\n╔════════════════════════════════════════════╗`);
  console.log(`║  BPS Jeneponto v3.0  → http://localhost:${PORT}  ║`);
  console.log(`║  Publikasi: ${String(d).padEnd(5)} | Users: ${String(u).padEnd(5)}             ║`);
  console.log(`╚════════════════════════════════════════════╝\n`);
});

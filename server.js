/**
 * server.js v4.0 – BPS Jeneponto
 * Fitur baru v4: PDF text search, pencarian publikasi chatbot, indikator lengkap
 */

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const { chromium } = require('playwright');
const { refreshIndikator } = require('./refresh-indikator');
const pdfIndexer = require('./pdf-indexer');
const { sinkronUrlPdf } = require('./bps-webapi');

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
const SULSEL_PUB_FILE = path.join(DB_DIR, 'publikasi-sulsel.json');
const SULSEL_INDIK_FILE = path.join(DB_DIR, 'indikator-sulsel.json');
const SULSEL_KAB_FILE = path.join(DB_DIR, 'kabupaten-sulsel.json');
const SULSEL_PDF_INDEX_FILE = path.join(DB_DIR, 'pdf-index-sulsel.json');
const UPLOAD_PDF_INDEX_FILE = path.join(DB_DIR, 'pdf-index-upload.json');
const SULSEL_DL_DIR = path.join(__dirname, 'downloads', 'sulsel');
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
// Halaman terpisah Publikasi BPS Sulawesi Selatan
app.get('/sulsel', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// File publikasi Sulsel yang diunduh ke folder lokal downloads/sulsel
// disajikan juga di /uploads/sulsel-files agar link "buka file" bekerja.
if (fs.existsSync(SULSEL_DL_DIR)) {
  app.use('/uploads/sulsel-files', express.static(SULSEL_DL_DIR));
}

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

// ── Index PDF hasil upload admin (otomatis, selalu dicari) ────────
let _uploadIndexCache = null;
function bacaUploadIndex() {
  if (_uploadIndexCache) return _uploadIndexCache;
  if (!fs.existsSync(UPLOAD_PDF_INDEX_FILE)) return [];
  try { _uploadIndexCache = baca(UPLOAD_PDF_INDEX_FILE); } catch { _uploadIndexCache = []; }
  return _uploadIndexCache;
}

function resetPdfCaches() {
  _pdfIndexCache = null;
  _uploadIndexCache = null;
  _pdfIndexSulselCache = null;
}

// Gabung sumber index (statis + hasil upload) tanpa duplikat per file.
function sumberPdf(own) {
  const up = bacaUploadIndex();
  if (!up.length) return own;
  const seen = new Set(); const out = [];
  for (const d of [...(own || []), ...up]) {
    if (!d || seen.has(d.file)) continue;
    seen.add(d.file); out.push(d);
  }
  return out;
}

// Nomor halaman tempat posisi karakter `pos` di dalam chunk ke-idx berada.
// Butuh chunk_mulai & hal_mulai (indeks kata) dari indexer versi baru; null jika tidak ada.
function halamanKutipan(doc, idx, chunk, pos) {
  if (!Array.isArray(doc.chunk_mulai) || !Array.isArray(doc.hal_mulai) || !doc.hal_mulai.length) return null;
  const mulai = doc.chunk_mulai[idx];
  if (typeof mulai !== 'number') return null;
  const offset = pos > 0 ? chunk.slice(0, pos).split(/\s+/).filter(Boolean).length : 0;
  const kata = mulai + offset;
  let hal = doc.hal_mulai[0][0];
  for (const [h, k] of doc.hal_mulai) { if (k <= kata) hal = h; else break; }
  return hal;
}

// Kata yang terlalu umum untuk pencarian isi PDF (muncul di hampir semua halaman).
const STOP_PDF = new Set(['jumlah','total','banyak','banyaknya','nilai','angka','data','tahun','berapa','berapakah',
  'tingkat','persentase','persen','rata','laju','indeks','kecamatan','kec','desa','kelurahan',
  'terbanyak','tertinggi','terendah','terbesar','terkecil','paling','sedikit','tren','perkembangan',
  'kabupaten','kab','jeneponto','provinsi','sulsel','sulawesi','selatan','dan','atau','yang','di','dari','untuk',
  'dengan','pada','oleh','ini','itu','dalam','adalah','apa','apakah','bagaimana','tentang','menurut','per','tiap','setiap']);

// Sinonim/istilah padanan (termasuk bahasa Inggris, karena publikasi BPS dwibahasa).
// Kunci = kata dasar dari pertanyaan; nilai = bentuk lain yang dianggap kata yang sama.
const SINONIM_PDF = {
  penduduk    : ['population','jiwa','kependudukan'],
  kemiskinan  : ['miskin','poverty','poor','garis kemiskinan'],
  miskin      : ['kemiskinan','poverty'],
  ipm         : ['indeks pembangunan manusia','pembangunan manusia','human development'],
  pengangguran: ['tpt','unemployment','penganggur'],
  pdrb        : ['produk domestik regional bruto','gross regional domestic','grdp'],
  ekonomi     : ['economic','economy','pertumbuhan ekonomi'],
  inflasi     : ['inflation','indeks harga konsumen','ihk'],
  pertanian   : ['agriculture','agricultural','padi','tanaman pangan','sawah'],
  sawah       : ['lahan sawah','wetland','paddy field'],
  sekolah     : ['pendidikan','school','education','murid','siswa'],
  pendidikan  : ['education','sekolah'],
  kesehatan   : ['health','rumah sakit','puskesmas'],
  kerja       : ['ketenagakerjaan','labor','labour','angkatan kerja','tpak','employment'],
  gini        : ['rasio gini','gini ratio','ketimpangan'],
  aset        : ['asset','kekayaan daerah','neraca'],
  desa        : ['village','kelurahan','desa/kelurahan','pemerintahan desa','banyaknya desa','jumlah desa'],
  kriminalitas: ['kejahatan','crime','tindak pidana','kriminal','kepolisian'],
  kriminal    : ['kejahatan','crime','tindak pidana','kriminalitas'],
  ternak      : ['peternakan','livestock','populasi ternak','ekor'],
  sapi        : ['sapi potong','sapi perah','ekor'],
  perikanan   : ['fishery','fisheries','ikan','nelayan','tangkap','budidaya'],
  hotel       : ['akomodasi','penginapan','pariwisata','tamu hotel'],
  wisatawan   : ['pariwisata','tourism','kunjungan wisata','tamu'],
  jalan       : ['road','panjang jalan','kondisi jalan'],
  kendaraan   : ['vehicle','bermotor','kendaraan bermotor'],
  listrik     : ['pln','electricity','pelanggan listrik','daya tersambung'],
  koperasi    : ['cooperative','kud','usaha mikro'],
  pasar       : ['market','perdagangan','pasar tradisional'],
  masjid      : ['tempat ibadah','rumah ibadah','mosque'],
  puskesmas   : ['fasilitas kesehatan','health center','kesehatan'],
  rumah       : ['rumah sakit','hospital','rumah tangga'],
  hujan       : ['curah hujan','rainfall','iklim','climate'],
  murid       : ['siswa','student','pupils','sekolah'],
  garam       : ['salt','tambak garam','produksi garam'],
  rumput      : ['rumput laut','seaweed','budidaya laut'],
  kecamatan   : ['subdistrict','sub district'],
  harapan     : ['angka harapan hidup','life expectancy','umur harapan hidup'],
  luas        : ['area','hektar','km2'],
  wilayah     : ['luas wilayah','area','geografis','km2'],
  'luas wilayah': ['km2','km²','luas daerah','total area'],
  'rumah sakit' : ['hospital','rs ','rsud'],
  'rumah tangga': ['household','ruta','kepala keluarga'],
  'garis kemiskinan': ['poverty line'],
  'penduduk miskin' : ['poor people','kemiskinan'],
  'angkatan kerja'  : ['labor force','tpak','bekerja'],
  'pengangguran terbuka': ['tpt','unemployment rate'],
  'harapan hidup'   : ['life expectancy','uhh','ahh'],
  'lama sekolah'    : ['years of schooling','hls','rls'],
  'per kapita'      : ['per capita','perkapita'],
  'pertumbuhan ekonomi': ['economic growth','laju pertumbuhan','pdrb'],
  'lahan sawah'     : ['sawah','wetland','paddy field','luas baku'],
  'curah hujan'     : ['rainfall','hari hujan'],
  'kendaraan bermotor': ['motor vehicle','kendaraan'],
  'jenis kelamin'   : ['sex','laki-laki','perempuan','rasio jenis kelamin'],
  'kemahalan konstruksi': ['ikk','construction cost index','indeks kemahalan','konstruksi'],
  konstruksi  : ['construction','bangunan','ikk'],
  apbd        : ['anggaran','realisasi anggaran','keuangan daerah','budget'],
};

// Pola angka data statistik (pemisah ribuan/desimal Indonesia), bukan sekadar digit.
const ANGKA_RE = /\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?\b|\b\d+[.,]\d+\b|\b\d{4,}\b/;
const NAMA_KEC_RE = /\b(bangkala|tamalatea|bontoramba|binamu|turatea|batang|arungkeke|tarowang|kelara|rumbia)\b/i;

// Frasa baku dua kata: dianggap satu kelompok kata kunci (lebih tajam daripada dua kata terpisah).
const FRASA_PDF = ['luas wilayah','rumah sakit','rumah tangga','garis kemiskinan','penduduk miskin','angkatan kerja',
  'pengangguran terbuka','harapan hidup','lama sekolah','per kapita','pertumbuhan ekonomi','lahan sawah','rumput laut',
  'bawang merah','cabai rawit','cabai besar','kendaraan bermotor','curah hujan','tenaga kerja','asli daerah','beban ketergantungan',
  'jenis kelamin','kemahalan konstruksi','pembangunan manusia','pembangunan gender','pemberdayaan gender','melek huruf','air bersih'];

// Siapkan kelompok kata kunci dari pertanyaan: tiap kelompok = kata/frasa + sinonimnya.
function siapkanKw(keyword) {
  let teks = keyword.toLowerCase().replace(/[?!.,;:()"']/g, ' ').replace(/\s+/g, ' ').trim();
  const frasa = [];
  for (const f of FRASA_PDF) {
    if (teks.includes(f)) { frasa.push(f); teks = teks.replace(f, ' '); }
  }
  const kata = teks.split(/\s+/).filter(w => w.length > 2);
  const tahun = kata.filter(w => /^20\d\d$/.test(w));
  let inti = kata.filter(w => !STOP_PDF.has(w) && !/^\d+$/.test(w));
  if (!inti.length && !frasa.length) inti = kata.filter(w => !/^\d+$/.test(w));
  const grup = [
    ...frasa.map(f => { const sin = SINONIM_PDF[f] || []; return [f, ...sin]; }),
    ...inti.map(w => {
      const dasar = w.replace(/(nya|kah|lah)$/, '');
      const sin = SINONIM_PDF[dasar] || SINONIM_PDF[w] || [];
      return [dasar, ...sin].map(s => s.toLowerCase());
    }),
  ];
  return { grup, tahun };
}

// Cari kata kunci di sebuah index PDF; kembalikan kutipan + nomor halaman.
// Chunk = satu (bagian) halaman. Skor:
//  - kelompok kata kunci berbeda yang muncul dalam satu jendela 40 kata (kedekatan)
//  - kelompok berbeda yang muncul di mana pun pada halaman
//  - frekuensi kemunculan (dibatasi)
//  - angka statistik di dekat kata kunci, tahun yang ditanya
//  - penalti sampul / kata pengantar / daftar isi / daftar tabel
function cariDiIndex(index, keyword, maks = 4) {
  if (!index.length) return [];
  const { grup, tahun } = siapkanKw(keyword);
  if (!grup.length) return [];
  const JENDELA = 40;

  const hasil = [];
  for (const doc of index) {
    const chunks = doc.chunks || [];
    if (!chunks.length) continue;

    // Posisi tiap kelompok kata kunci di tiap halaman (dihitung sekali)
    const perChunk = chunks.map(chunk => {
      const cl = chunk.toLowerCase();
      const kataArr = cl.split(/\s+/);
      const posisi = grup.map(() => []);
      grup.forEach((g, gi) => {
        for (const s of g) {
          if (s.includes(' ')) {                         // frasa multi-kata: cari di teks utuh
            let p = cl.indexOf(s);
            while (p !== -1) { posisi[gi].push(cl.slice(0, p).split(/\s+/).length - 1); p = cl.indexOf(s, p + s.length); }
          } else {
            kataArr.forEach((k, ki) => { if (k.startsWith(s)) posisi[gi].push(ki); });
          }
        }
      });
      return { cl, kataArr, posisi };
    });

    // Bobot kelompok = seberapa membedakan ia di dokumen INI. Kata yang muncul di
    // >50% halaman (mis. nama kecamatan pada buku "Kecamatan X Dalam Angka", atau
    // "ipm" pada buku IPM) tidak bisa menentukan halaman → bobot kecil.
    const df = grup.map((_, gi) => perChunk.filter(c => c.posisi[gi].length).length / chunks.length);
    const bobot = df.map(f => (f > 0.5 ? 0.3 : 1));
    // Bila ada kata kunci pembeda dalam pertanyaan tetapi tidak satu pun muncul di
    // dokumen ini, dokumen dianggap tidak membahas topiknya → tidak ada halaman.
    const adaPembeda = df.some((f, gi) => f > 0 && bobot[gi] === 1);
    const perluPembeda = bobot.some(b => b === 1);
    if (perluPembeda && !adaPembeda) continue;

    let best = null;
    perChunk.forEach(({ cl, kataArr, posisi }, i) => {
      const grupAda = posisi.reduce((s, p, gi) => s + (p.length ? bobot[gi] : 0), 0);
      if (!grupAda) return;
      if (adaPembeda && !posisi.some((p, gi) => p.length && bobot[gi] === 1)) return; // halaman tanpa kata pembeda

      // Kedekatan: bobot kelompok berbeda terbanyak dalam satu jendela kata
      let dekatMaks = 0, pusat = -1;
      posisi.forEach((p, gi) => { if (p.length && bobot[gi] > dekatMaks) { dekatMaks = bobot[gi]; pusat = p[0]; } });
      if (grup.length > 1) {
        const semua = [];
        posisi.forEach((arr, gi) => arr.forEach(k => semua.push([k, gi])));
        semua.sort((a, b) => a[0] - b[0]);
        for (let a = 0; a < semua.length; a++) {
          const set = new Set();
          for (let b = a; b < semua.length && semua[b][0] - semua[a][0] <= JENDELA; b++) set.add(semua[b][1]);
          const w = [...set].reduce((s, gi) => s + bobot[gi], 0);
          if (w > dekatMaks) { dekatMaks = w; pusat = semua[a][0]; }
        }
      }

      const hits = Math.min(posisi.reduce((s, p, gi) => s + p.length * bobot[gi], 0), 12);
      const sekitar = kataArr.slice(Math.max(0, pusat - 25), pusat + 25).join(' ');
      const adaAngka = ANGKA_RE.test(sekitar);
      const adaTahun = tahun.length && tahun.some(t => cl.includes(t));
      const daftar = /daftar isi|table of contents|daftar tabel|list of tables|daftar gambar|list of figures|daftar grafik|daftar lampiran|list of appendi|penjelasan teknis|technical note|konsep dan definisi|glosarium|glossary/.test(cl)
        || (cl.match(/\.{4,}/g) || []).length >= 3
        || (cl.match(/\b(tabel|table|gambar|figure|lampiran|appendix)\s+\d+(\.\d+)*\b/g) || []).length >= 6;
      // Halaman ulasan/uraian (bukan tabel mentah) paling informatif untuk dibaca
      const ulasan = /\bulasan\b|\bdescription\b|\buraian\b|\banalisis\b/.test(cl) && !daftar;
      const sampul = i === 0 || /kata pengantar|preface|katalog\s*[:/]|isbn|issn|tim penyusun|penanggung jawab/.test(cl);

      const score = dekatMaks * 14 + grupAda * 6 + hits + (adaAngka ? 6 : 0) + (adaTahun ? 5 : 0) + (ulasan ? 3 : 0)
        - (daftar ? 18 : 0) - (sampul ? 8 : 0);
      if (!best || score > best.score) best = { score, chunk: chunks[i], idx: i, pusat, kataArr };
    });

    if (best) {
      // Publikasi rujukan umum kabupaten (Dalam Angka / Statistik Daerah) sedikit
      // diutamakan saat skor berimbang dengan publikasi tematik.
      const rujukan = /dalam angka|statistik daerah/i.test(doc.judul || '') && !/^kecamatan\s/i.test(doc.judul || '');
      const skorDoc = best.score + (rujukan ? 3 : 0);
      // Kutipan: ±22 kata di sekitar pusat jendela terbaik
      const a = Math.max(0, best.pusat - 12), b = Math.min(best.kataArr.length, best.pusat + 30);
      const asli = best.chunk.split(/\s+/);
      const snippet = asli.slice(a, b).join(' ').substring(0, 280);
      hasil.push({
        judul    : doc.judul,
        tahun    : doc.tahun,
        fileLokal: doc.fileLokal || null,
        url_bps  : doc.url_bps  || '',
        cover    : doc.cover    || '',
        halaman  : halamanKutipan(doc, best.idx, best.chunk, 0),
        hal_total: doc.hal_total || null,
        snippet,
        skor     : skorDoc
      });
    }
  }
  return hasil.sort((a, b) => b.skor - a.skor).slice(0, maks);
}

function cariDalamPDF(keyword, maks = 4) {
  let index = sumberPdf(getPdfIndex());
  // Buku "Kecamatan X Dalam Angka" hanya relevan bila pertanyaan menyebut kecamatannya;
  // untuk pertanyaan tingkat kabupaten pakai publikasi kabupaten saja.
  if (!NAMA_KEC_RE.test(keyword)) {
    const kab = index.filter(d => !/^kecamatan\s/i.test(d.judul || ''));
    if (kab.length) index = kab;
  }
  return cariDiIndex(index, keyword, maks);
}

// ── PDF Index Sulsel ────────────────────────────────────────────
let _pdfIndexSulselCache = null;
function getPdfIndexSulsel() {
  if (_pdfIndexSulselCache) return _pdfIndexSulselCache;
  if (!fs.existsSync(SULSEL_PDF_INDEX_FILE)) return [];
  try { _pdfIndexSulselCache = baca(SULSEL_PDF_INDEX_FILE); } catch { _pdfIndexSulselCache = []; }
  return _pdfIndexSulselCache;
}

function cariDalamPDFSulsel(keyword, maks = 4) {
  return cariDiIndex(sumberPdf(getPdfIndexSulsel()), keyword, maks);
}

// Path absolut sebuah fileLokal (/uploads/files/… atau /uploads/sulsel-files/…), null jika tidak ada.
function pathFileLokal(fileLokal) {
  if (!fileLokal || typeof fileLokal !== 'string') return null;
  const nama = path.basename(fileLokal);
  const dir  = fileLokal.startsWith('/uploads/sulsel-files/') ? SULSEL_DL_DIR : path.join(UPLOAD_DIR, 'files');
  const abs  = path.join(dir, nama);
  return fs.existsSync(abs) ? abs : null;
}

// Salinan objek dengan fileLokal dikosongkan bila filenya tidak ada di server ini.
function bersihkanLokal(o) {
  if (!o || !o.fileLokal || pathFileLokal(o.fileLokal)) return o;
  return { ...o, fileLokal: null };
}

// Lengkapi hasil pencarian PDF dengan tautan langsung file PDF BPS (url_pdf)
// dari data publikasi, dicocokkan lewat URL halaman BPS (url_bps) atau fileLokal.
function lengkapiUrlPdf(pdfHasil, allPub) {
  if (!pdfHasil || !pdfHasil.length) return pdfHasil;
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const byUrl = new Map(), byLokal = new Map(), byJudul = new Map();
  for (const p of allPub || []) {
    if (!p.url_pdf) continue;
    if (p.url)       byUrl.set(p.url, p.url_pdf);
    if (p.fileLokal) byLokal.set(p.fileLokal, p.url_pdf);
    if (p.judul)     byJudul.set(norm(p.judul), p.url_pdf);
  }
  return pdfHasil.map(h => bersihkanLokal({
    ...h,
    url_pdf: h.url_pdf || byUrl.get(h.url_bps) || byLokal.get(h.fileLokal) || byJudul.get(norm(h.judul)) || '',
  }));
}

// ── Halaman untuk kartu publikasi ────────────────────────────────
// Kartu publikasi (hasil cariPub) diberi nomor halaman + kutipan dengan mencari
// kata kunci di indeks PDF publikasi tsb. Bila publikasi belum terindeks tetapi
// punya url_pdf, PDF diunduh & diindeks di latar belakang untuk permintaan berikutnya.
const _antriIndex = new Set();
let _rantaiIndex = Promise.resolve();
// Di platform cloud (DATA_DIR di-set, disk terbatas) PDF yang diunduh hanya
// untuk diindeks dihapus setelah selesai; di komputer lokal disimpan.
const SIMPAN_PDF_INDEKS = process.env.SIMPAN_PDF_INDEKS ? process.env.SIMPAN_PDF_INDEKS !== '0' : !process.env.DATA_DIR;

// Nama file PDF: judul (dipotong) + hash pendek URL agar judul panjang yang hanya
// berbeda di ujung (mis. seri Sensus Pertanian UTP) tidak saling menimpa.
function slugPdf(judul, url = '') {
  const s = String(judul || 'publikasi').replace(/[\\/:*?"<>|]/g, ' ').trim().replace(/\s+/g, '_');
  const h = url ? '_' + crypto.createHash('md5').update(String(url)).digest('hex').slice(0, 8) : '';
  return (s.slice(0, 70) || 'publikasi') + h + '.pdf';
}

function antriIndexPublikasi(pub, wilayah = 'jeneponto') {
  if (!pub || !pub.url_pdf || _antriIndex.has(pub.url_pdf)) return;
  _antriIndex.add(pub.url_pdf);
  const sulsel   = wilayah === 'sulsel';
  const indexFile = sulsel ? SULSEL_PDF_INDEX_FILE : UPLOAD_PDF_INDEX_FILE;
  const dir       = sulsel ? SULSEL_DL_DIR : path.join(UPLOAD_DIR, 'files');
  const prefix    = sulsel ? '/uploads/sulsel-files/' : '/uploads/files/';
  _rantaiIndex = _rantaiIndex.then(async () => {
    const nama = pub.fileLokal ? path.basename(pub.fileLokal) : slugPdf(pub.judul, pub.url);
    const abspath = path.join(dir, nama);
    let diunduh = false;
    try {
      if (!fs.existsSync(abspath)) {
        console.log(`[index-pub] mengunduh ${nama}...`);
        await unduhKeFile(pub.url_pdf, abspath);
        diunduh = true;
      }
      const r = await pdfIndexer.upsertUpload(indexFile, {
        file: nama, fileLokal: prefix + nama, judul: pub.judul, tahun: pub.tahun,
        kategori: pub.kategori, url_bps: pub.url || '', cover: pub.cover || '',
      }, abspath);
      if (r.ok) { resetPdfCaches(); console.log(`[index-pub] ${pub.judul} → ${r.chunks} chunk`); }
      if (diunduh && !SIMPAN_PDF_INDEKS) fs.rmSync(abspath, { force: true });
    } catch (e) {
      console.error('[index-pub]', nama, e.message);
    } finally {
      _antriIndex.delete(pub.url_pdf);
    }
  }).catch(() => {});
}

function lengkapiHalamanPub(pubs, keyword, index, wilayah = 'jeneponto') {
  if (!pubs || !pubs.length) return pubs;
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return pubs.map(p => {
    const doc = index.find(d => (d.url_bps && d.url_bps === p.url) || norm(d.judul) === norm(p.judul));
    if (!doc) { antriIndexPublikasi(p, wilayah); return p; }
    const hit = cariDiIndex([doc], keyword, 1)[0];
    if (!hit) return { ...p, hal_total: doc.hal_total || null };
    return { ...p, halaman: hit.halaman, hal_total: hit.hal_total, snippet: hit.snippet };
  });
}

// Pra-indeks isi publikasi terbaru saat server start, agar nomor halaman sudah
// tersedia sejak pertanyaan pertama (bukan baru setelah publikasi pernah muncul).
// Dibatasi (tahun & jumlah) agar indeks dan disk tidak membengkak; publikasi
// lain tetap diindeks otomatis saat pertama kali muncul di chat.
const PRAINDEKS_TAHUN_MIN = Number(process.env.PRAINDEKS_TAHUN_MIN) || 2024;
const PRAINDEKS_MAKS      = Number(process.env.PRAINDEKS_MAKS) || 60;
function praIndeksPublikasi() {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const kandidat = [];
  for (const [wilayah, file, getIndex] of [['jeneponto', DATA_FILE, getPdfIndex], ['sulsel', SULSEL_PUB_FILE, getPdfIndexSulsel]]) {
    if (!fs.existsSync(file)) continue;
    const index = sumberPdf(getIndex());
    const ada = new Set(index.flatMap(d => [d.url_bps, norm(d.judul)]).filter(Boolean));
    baca(file)
      .filter(p => p.url_pdf && p.kategori !== 'Lainnya' && (p.tahun || 0) >= PRAINDEKS_TAHUN_MIN && !ada.has(p.url) && !ada.has(norm(p.judul)))
      .forEach(p => kandidat.push({ p, wilayah }));
  }
  // Jeneponto lebih dulu, lalu yang terbaru
  kandidat.sort((a, b) => (a.wilayah === 'sulsel') - (b.wilayah === 'sulsel') || (b.p.tahun || 0) - (a.p.tahun || 0));
  const dipilih = kandidat.slice(0, PRAINDEKS_MAKS);
  dipilih.forEach(({ p, wilayah }) => antriIndexPublikasi(p, wilayah));
  if (dipilih.length) console.log(`[index-pub] ${dipilih.length} publikasi ≥${PRAINDEKS_TAHUN_MIN} diantrekan untuk pra-indeks di latar belakang`);
}

// ── Peta sumber publikasi untuk tiap kategori indikator ──────
const SUMBER_MAP = {
  'miskin'        : ['kemiskinan','statistik daerah','kesejahteraan'],
  'kemiskinan'    : ['kemiskinan','statistik daerah'],
  'penduduk'      : ['dalam angka','statistik daerah'],
  'pdrb'          : ['pdrb','produk domestik','lapangan usaha'],
  'ipm'           : ['pembangunan manusia','statistik daerah','dalam angka'],
  'tpak'          : ['ketenagakerjaan','dalam angka'],
  'pengangguran'  : ['ketenagakerjaan','dalam angka'],
  'angkatan kerja': ['ketenagakerjaan','dalam angka'],
  'gini'          : ['statistik daerah','kesejahteraan'],
  'inflasi'       : ['inflasi','harga','statistik daerah'],
  'pertanian'     : ['pertanian','hortikultura','statistik daerah'],
  'ipg'           : ['gender','dalam angka','statistik daerah'],
  'harapan hidup' : ['pembangunan manusia','statistik daerah'],
  'sekolah'       : ['pembangunan manusia','statistik daerah'],
  'default'       : ['dalam angka','statistik daerah'],
};

// Temukan publikasi sumber paling relevan untuk sebuah indikator.
// Mengembalikan objek publikasi PENUH (ikut fileLokal, url, cover).
function cariSumberIndikator(namaIndikator, allPub) {
  const n = String(namaIndikator || '').toLowerCase();
  let kwList = SUMBER_MAP['default'];
  for (const [key, kws] of Object.entries(SUMBER_MAP)) {
    if (key !== 'default' && n.includes(key)) { kwList = kws; break; }
  }
  for (const kw of kwList) {
    const match = allPub.find(p =>
      (p.judul || '').toLowerCase().includes(kw) ||
      (p.deskripsi || '').toLowerCase().includes(kw)
    );
    if (match) return match;
  }
  return null;
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
    if (typeof n === 'number') {
      return n.toLocaleString('id-ID', { maximumFractionDigits: 3 });
    }
    const s = String(n == null || n === '' ? '' : n).trim().replace(/\s/g, '');
    if (!s) return s;
    const hasComma = s.includes(',');
    let f;
    if (hasComma)      f = parseFloat(s.replace(/\./g, '').replace(',', '.'));
    else               f = parseFloat(s);
    return isNaN(f) ? s : f.toLocaleString('id-ID', { maximumFractionDigits: 3 });
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
      'ini','itu','dalam','angka','adalah','berapa','apa','berdasarkan','bagaimana','dimana','kenapa',
      'data','jeneponto','kabupaten','kab','tampilkan','lihat','cari','tentang','informasi','publikasi','buku','laporan','jumlah','tahun']);
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
        return (sb - sa) || ((b.tahun || 0) - (a.tahun || 0));
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

  // ═══ 0. MODE SULAWESI SELATAN (sulsel.bps.go.id) ═════════════
  // Pertanyaan tentang Provinsi Sulawesi Selatan / 24 kabupaten-kota
  // dijawab dari dataset db/publikasi-sulsel.json, db/indikator-sulsel.json,
  // db/kabupaten-sulsel.json, db/pdf-index-sulsel.json. Jeneponto dikecualikan
  // (tetap dilayani oleh logika Jeneponto di bawah).
  const SULSEL_ALIAS = [
    ['kepulauan selayar', 'Kepulauan Selayar'], ['selayar', 'Kepulauan Selayar'],
    ['bulukumba', 'Bulukumba'], ['bantaeng', 'Bantaeng'], ['jeneponto', 'Jeneponto'],
    ['takalar', 'Takalar'], ['gowa', 'Gowa'], ['sinjai', 'Sinjai'], ['maros', 'Maros'],
    ['pangkajene dan kepulauan', 'Pangkajene Dan Kepulauan'], ['pangkajene', 'Pangkajene Dan Kepulauan'], ['pangkep', 'Pangkajene Dan Kepulauan'],
    ['barru', 'Barru'], ['bone', 'Bone'], ['soppeng', 'Soppeng'], ['wajo', 'Wajo'],
    ['sidenreng rappang', 'Sidenreng Rappang'], ['sidenreng', 'Sidenreng Rappang'], ['sidrap', 'Sidenreng Rappang'],
    ['pinrang', 'Pinrang'], ['enrekang', 'Enrekang'],
    ['luwu utara', 'Luwu Utara'], ['luwu timur', 'Luwu Timur'], ['luwu', 'Luwu'],
    ['tana toraja', 'Tana Toraja'], ['toraja utara', 'Toraja Utara'],
    ['makassar', 'Kota Makassar'], ['parepare', 'Kota Parepare'], ['palopo', 'Kota Palopo'],
  ];
  const SULSEL_ALIAS_SORT = [...SULSEL_ALIAS].sort((a, b) => b[0].length - a[0].length);
  function matchKabSulsel(t) {
    const L = (' ' + t.toLowerCase() + ' ');
    for (const [k, long] of SULSEL_ALIAS_SORT) {
      const rx = new RegExp('\\b' + k.replace(/\s+/g, '[\\s._-]+') + '\\b');
      if (rx.test(L)) return long;
    }
    return null;
  }

  const matchedKab  = matchKabSulsel(pesan);
  const isSulsel    = /\b(sulsel|sulawesi\s*selatan|sulawesi)\b/i.test(pesan) ||
                      (matchedKab && matchedKab !== 'Jeneponto');

  if (isSulsel) {
    const sulsulKab = fs.existsSync(SULSEL_KAB_FILE) ? baca(SULSEL_KAB_FILE) : [];
    const sulsulPub = fs.existsSync(SULSEL_PUB_FILE) ? baca(SULSEL_PUB_FILE) : [];
    const sulsulInd = getIndikatorSulsel();

    function cariPubSulsel(keyword, maks = 5) {
      const stop = new Set(['sulsel','sulawesi','selatan','provinsi','dan','atau','yang','di','dari','untuk','dengan','ke','pada','oleh','ini','itu','tahun','buku','revisi','bagus','lebih','dapat','menurut','kabupaten','kota']);
      const kw = keyword.toLowerCase().replace(/[?!.,;:()]/g, ' ').split(/\s+/)
        .filter(w => w.length > 2 && !stop.has(w));
      if (!kw.length) return [];
      return sulsulPub.filter(p => {
        const txt = ((p.judul || '') + ' ' + (p.deskripsi || '')).toLowerCase();
        return kw.some(w => txt.includes(w));
      }).sort((a, b) => {
        const ta = ((a.judul || '') + (a.deskripsi || '')).toLowerCase();
        const tb = ((b.judul || '') + (b.deskripsi || '')).toLowerCase();
        return kw.filter(w => tb.includes(w)).length - kw.filter(w => ta.includes(w)).length;
      }).slice(0, maks).map(p => ({
        judul: p.judul, tahun: p.tahun, url: p.url, cover: p.cover || '', ukuran: p.ukuran || ''
      }));
    }

    const SIN_SUL = {
      'tingkat kemiskinan': 'penduduk miskin', 'angka kemiskinan': 'penduduk miskin', 'kemiskinan': 'penduduk miskin',
      'ipm': 'indeks pembangunan manusia',
      'tpt': 'tingkat pengangguran', 'tingkat pengangguran': 'pengangguran terbuka',
      'tpak': 'partisipasi angkatan kerja',
      'uhh': 'umur harapan hidup', 'hls': 'harapan lama sekolah', 'rls': 'rata-rata lama sekolah',
      'pertumbuhan ekonomi': 'laju pertumbuhan ekonomi', 'pertumbuhan pdrb': 'laju pertumbuhan ekonomi',
      'pertumbuhan': 'laju pertumbuhan ekonomi',
      'gini': 'gini rasio', 'pdrb per kapita': 'pdrb perkapita', 'pdrb perkapita': 'pdrb perkapita',
      'jumlah penduduk': 'jumlah penduduk', 'penduduk': 'jumlah penduduk',
    };
    function normSul(kw) {
      let h = kw.toLowerCase().replace(/[?!.,;:()"']/g, ' ').replace(/\b20\d{2}\b/g, ' ')
        .replace(/\b(sulsel|sulawesi|selatan|provinsi|prov|kabupaten|kab|kota|terbaru|terakhir|sekarang|saat ini|tahun ini|tahun|di|untuk|dari|dengan|dan|atau|yang|adalah|berapa|berapakah|apa|apakah|apa itu|tampilkan|lihat|show|buka|cari|temukan|data|tentang)\b/gi, ' ')
        .replace(/\s+/g, ' ').trim();
      const sorted = Object.entries(SIN_SUL).sort((a, b) => b[0].length - a[0].length);
      for (const [k, v] of sorted) if (h.includes(k)) { h = v; break; }
      return h.trim();
    }
    function cariIndSulsel(kw) {
      const w = kw.toLowerCase().split(/\s+/).filter(x => x.trim().length > 2);
      return sulsulInd.filter(v => w.every(z => v.nama.toLowerCase().includes(z)))
        .sort((a, b) => a.nama.length - b.nama.length);
    }

    let jawSul = '', tipeSul = 'info', kartuSul = [], pubSul = [], trendSul = [], saranSul = [], pdfSul = [];
    const isTrendSul = /\b(trend|tren|perkembangan|sejarah|sejak|dari tahun|antara)\b/i.test(pesan);
    const isMaxMin   = /\b(tertinggi|terendah|terbanyak|tersedikit|terbesar|terkecil|paling)\b/i.test(pesan);

    // ── A. KABUPATEN/KOTA TERTENTU ──────────────────────────
    const kab = matchedKab && sulsulKab.length
      ? (sulsulKab.find(x => x.kabupaten === matchedKab) || sulsulKab.find(x => x.nama === matchedKab))
      : null;

    if (kab) {
      tipeSul = 'data';
      const nama = kab.nama || kab.kabupaten;

      // Tertinggi/terendah antar kabupaten
      if (isMaxMin) {
        const byPenduduk = /\b(penduduk|penduduk terbanyak|tersedikit)\b/i.test(pesan);
        const byIpm      = /\b(ipm|indeks pembangunan)\b/i.test(pesan);
        const key        = byIpm ? 'ipm' : 'penduduk';
        const desc       = byIpm ? 'IPM 2025' : 'Jumlah Penduduk 2026';
        const sorted = [...sulsulKab].sort((a, b) =>
          (byIpm ? b.ipm['2025'] : b.penduduk) - (byIpm ? a.ipm['2025'] : a.penduduk));
        const top3 = sorted.slice(0, 3), bot3 = sorted.slice(-3).reverse();
        jawSul = byIpm
          ? `Kabupaten/kota di Sulawesi Selatan dengan **IPM tertinggi 2025**:\n` +
            top3.map((x, i) => `${i + 1}. **${x.nama}** – ${fmt(x.ipm['2025'])}`).join('\n') +
            `\n\nTerendah:\n` + bot3.map((x, i) => `${i + 1}. **${x.nama}** – ${fmt(x.ipm['2025'])}`).join('\n')
          : `Kabupaten/kota di Sulawesi Selatan dengan **penduduk terbanyak (2026)**:\n` +
            top3.map((x, i) => `${i + 1}. **${x.nama}** – ${fmt(x.penduduk)} jiwa`).join('\n') +
            `\n\nTersedikit:\n` + bot3.map((x, i) => `${i + 1}. **${x.nama}** – ${fmt(x.penduduk)} jiwa`).join('\n');
      }
      // Trend penduduk
      else if (isTrendSul && /\b(penduduk|jumlah)\b/i.test(pesan)) {
        trendSul = [
          { tahun: '2020', nilai: fmt(kab.penduduk_2020) },
          { tahun: '2025', nilai: fmt(kab.penduduk_2025) },
          { tahun: '2026', nilai: fmt(kab.penduduk) },
        ];
        jawSul = `Perkembangan penduduk **${nama}** (Sulawesi Selatan):`;
      }
      else {
        const L = lower;
        const F = [
          { kw: ['rasio jenis kelamin'], get: () => [fmt(kab.rasio_jk), 'rasio', 'Rasio Jenis Kelamin (2026)'] },
          { kw: ['rasio ketergantungan'], get: () => [fmt(kab.rasio_ketergantungan), 'rasio', 'Rasio Ketergantungan (2026)'] },
          { kw: ['kepadatan'], get: () => [fmt(kab.kepadatan), 'jiwa/km2', 'Kepadatan Penduduk (2026)'] },
          { kw: ['laju pertumbuhan penduduk', 'laju penduduk', 'pertumbuhan penduduk'], get: () => [fmt(kab.laju_pertumbuhan), '% per tahun', 'Laju Pertumbuhan Penduduk'] },
          { kw: ['angka kemiskinan', 'tingkat kemiskinan', 'kemiskinan', 'penduduk miskin', 'miskin'], get: () => [fmt(kab.kemiskinan['2025'].persen), '% penduduk (Maret 2025)', 'Penduduk Miskin'] },
          { kw: ['indeks pembangunan', 'ipm'], get: () => [fmt(kab.ipm['2025']), 'indeks (2025)', 'Indeks Pembangunan Manusia'] },
          { kw: ['umur harapan', 'harapan hidup', 'uhh'], get: () => [fmt(kab.uhh_2025), 'tahun (2025)', 'Umur Harapan Hidup'] },
          { kw: ['harapan lama sekolah', 'hls'], get: () => [fmt(kab.hls_2025), 'tahun (2025)', 'Harapan Lama Sekolah'] },
          { kw: ['rata-rata lama sekolah', 'rls'], get: () => [fmt(kab.rls_2025), 'tahun (2025)', 'Rata-rata Lama Sekolah'] },
          { kw: ['pengeluaran per kapita', 'pengeluaran'], get: () => [fmt(kab.pengeluaran_2025), 'ribu rupiah/tahun (2025)', 'Pengeluaran per Kapita'] },
          { kw: ['gini', 'ketimpangan'], get: () => [fmt(kab.gini['2025']), 'rasio (Maret 2025)', 'Gini Rasio'] },
          { kw: ['tpak'], get: () => [fmt(kab.tpak['2025']), '% (Agustus 2025)', 'TPAK'] },
          { kw: ['tpt', 'pengangguran', 'penganggur', 'pengangguran terbuka'], get: () => [fmt(kab.tpt['2025']), '% (Agustus 2025)', 'TPT'] },
          { kw: ['angkatan kerja', 'bekerja'], get: () => [fmt(kab.angkatan_kerja.total), 'orang (Agustus 2025)', 'Angkatan Kerja'] },
          { kw: ['pdrb per kapita', 'pdrb perkapita'], get: () => [fmt(kab.pdrb_perkapita['2025']), 'juta rupiah (2025)', 'PDRB per Kapita'] },
          { kw: ['pdrb', 'produk domestik', 'harga berlaku'], get: () => [fmt(kab.pdrb.adhb_2025), 'miliar rupiah (2025)', 'PDRB ADHB'] },
          { kw: ['pertumbuhan ekonomi', 'pertumbuhan pdrb', 'laju pertumbuhan'], get: () => [fmt(kab.pertumbuhan_ekonomi['2025']), '% (2025)', 'Pertumbuhan Ekonomi'] },
          { kw: ['penduduk', 'jumlah penduduk', 'penduduk 2026'], get: () => [fmt(kab.penduduk), 'jiwa (2026)', 'Jumlah Penduduk'] },
        ];
        let matchedField = null;
        for (const f of F) if (f.kw.some(w => L.includes(w))) { matchedField = f; break; }

        const isKemiskinan = matchedField && matchedField.kw.some(w => /miskin|kemiskinan/.test(w));
        if (matchedField && isKemiskinan) {
          jawSul = `Pada **${nama}** (Sulawesi Selatan), penduduk miskin **Maret 2025** berjumlah **${fmt(kab.kemiskinan['2025'].jumlah)} jiwa** (${fmt(kab.kemiskinan['2025'].persen)}% dari penduduk).`;
          kartuSul = [
            { nama: 'Penduduk Miskin (jumlah)', nilai: fmt(kab.kemiskinan['2025'].jumlah), satuan: 'jiwa', tahun: '2025', sumber: null },
            { nama: 'Penduduk Miskin (persentase)', nilai: fmt(kab.kemiskinan['2025'].persen), satuan: '%', tahun: '2025', sumber: null },
          ];
        } else if (matchedField) {
          const [nilai, sat, label] = matchedField.get();
          jawSul = `Pada **${nama}** (Sulawesi Selatan), **${label.toLowerCase()}** adalah **${nilai} ${sat}**.`;
          kartuSul.push({ nama: label, nilai, satuan: sat, tahun: /2026/.test(sat) ? '2026' : '2025', sumber: null });
        } else {
          // Ringkasan default
          jawSul = `Data **${nama}** (Provinsi Sulawesi Selatan):\n` +
            `- **Penduduk 2026**: ${fmt(kab.penduduk)} jiwa\n` +
            `- **IPM 2025**: ${fmt(kab.ipm['2025'])}\n` +
            `- **Penduduk miskin (Maret 2025)**: ${fmt(kab.kemiskinan['2025'].jumlah)} jiwa (${fmt(kab.kemiskinan['2025'].persen)}%)\n` +
            `- **TPT Agustus 2025**: ${fmt(kab.tpt['2025'])}%\n` +
            `- **PDRB per kapita 2025**: ${fmt(kab.pdrb_perkapita['2025'])} juta rupiah`;
          kartuSul = [
            { nama: 'Jumlah Penduduk 2026', nilai: fmt(kab.penduduk), satuan: 'jiwa', tahun: '2026', sumber: null },
            { nama: 'IPM', nilai: fmt(kab.ipm['2025']), satuan: 'indeks', tahun: '2025', sumber: null },
            { nama: 'Penduduk Miskin', nilai: fmt(kab.kemiskinan['2025'].persen), satuan: '%', tahun: '2025', sumber: null },
            { nama: 'TPT', nilai: fmt(kab.tpt['2025']), satuan: '%', tahun: '2025', sumber: null },
          ];
        }
      }
      pubSul = cariPubSulsel(nama, 3);
      pdfSul = cariDalamPDFSulsel(nama);
      saranSul = [`Perkembangan penduduk ${nama}`, `IPM ${nama}`, `Penduduk miskin ${nama}`, `Tampilkan publikasi tentang ${nama}`];
    }

    // ── B. TINGKAT PROVINSI ───────────────────────────────
    else {
      // Daftar 24 kabupaten/kota
      if (/daftar|semua kabupaten|berapa kabupaten|nama kabupaten|kabupaten di/.test(lower) ||
          (/\bkabupaten\b/.test(lower) && /\b(daftar|banyak|berapa|list|semua)\b/.test(lower))) {
        tipeSul = 'info';
        jawSul  = `Sulawesi Selatan terdiri dari **${sulsulKab.length} kabupaten/kota** (data penduduk 2026, proyeksi BPS):\n` +
          sulsulKab.map(x => `- **${x.nama}**: ${fmt(x.penduduk)} jiwa`).join('\n');
        saranSul = ['Berapa penduduk Kota Makassar?', 'IPM tertinggi', 'Penduduk Tana Toraja'];
      }
      else if (isMaxMin) {
        // Ranking antar kabupaten/kota (level provinsi)
        tipeSul = 'data';
        const dirTinggi = /tertinggi|terbanyak|terbesar|paling/.test(pesan);
        let F;
        if (/\bgini\b|\bketimpangan\b/.test(pesan))              F = { k: k => k.gini['2025'],                  label: 'Gini Rasio',         sat: 'rasio (Maret 2025)' };
        else if (/\btpak\b/.test(pesan))                          F = { k: k => k.tpak['2025'],                 label: 'TPAK',               sat: '% (Agustus 2025)' };
        else if (/\b(tpt|penganggur|pengangguran)\b/.test(pesan)) F = { k: k => k.tpt['2025'],                   label: 'TPT',                sat: '% (Agustus 2025)' };
        else if (/\b(miskin|kemiskinan)\b/.test(pesan))           F = { k: k => k.kemiskinan['2025'].persen,    label: 'Penduduk Miskin',    sat: '% (Maret 2025)' };
        else if (/\bpdrb\b/.test(pesan) && /\bper ?kapita|perkapita\b/.test(pesan)) F = { k: k => k.pdrb_perkapita['2025'], label: 'PDRB per Kapita', sat: 'juta rupiah (2025)' };
        else if (/\bpdrb\b/.test(pesan))                          F = { k: k => k.pdrb.adhb_2025,               label: 'PDRB ADHB',         sat: 'miliar rupiah (2025)' };
        else if (/\b(ipm|indeks pembangunan)\b/.test(pesan))      F = { k: k => k.ipm['2025'],                  label: 'IPM',                sat: 'indeks (2025)' };
        else if (/\bpenduduk\b/.test(pesan))                      F = { k: k => k.penduduk,                     label: 'Jumlah Penduduk',    sat: 'jiwa (2026)' };
        else                                                      F = { k: k => k.ipm['2025'],                  label: 'IPM',                sat: 'indeks (2025)' };
        const sorted = [...sulsulKab].sort((a, b) => (dirTinggi ? F.k(b) - F.k(a) : F.k(a) - F.k(b)));
        const picks  = sorted.slice(0, 3);
        jawSul = `Kabupaten/kota di Sulawesi Selatan dengan **${F.label.toLowerCase()} ${dirTinggi ? 'tertinggi' : 'terendah'}**:\n` +
          picks.map((x, i) => `${i + 1}. **${x.nama}** – ${fmt(F.k(x))} ${F.sat}`).join('\n');
        kartuSul = picks.map(x => ({ nama: x.nama, nilai: fmt(F.k(x)), satuan: F.sat, tahun: '', sumber: null }));
        saranSul = ['Berapa penduduk Kota Makassar?', 'Berapa IPM Gowa?', 'Berapa angka kemiskinan Sulsel?'];
      }
      else {
        const rawKw = lower.replace(/^(berapa|berapakah|berapa jumlah|berapa nilai|berapa angka|apa|apakah|apa itu|apa yang dimaksud|tampilkan|lihat|show|buka|cari|temukan|perlihatkan|download|unduh|data)\s*/, '')
          .replace(/\s+/g, ' ').trim();
        const isTampilSul = /\b(tampilkan|lihat|show|buka|cari|temukan|download|unduh|publikasi)\b/i.test(pesan);
        let keyword = normSul(rawKw);

        let hits = cariIndSulsel(keyword);
        if (!hits.length && keyword.split(' ').length > 2)
          hits = cariIndSulsel(keyword.split(' ').slice(0, 2).join(' '));
        if (!hits.length && /\bpdrb\b/.test(keyword) && !/\bkapita\b/.test(keyword))
          hits = cariIndSulsel('PDRB Atas Dasar Harga Berlaku');
        if (!hits.length) {
          const w = keyword.split(' ').find(x =>
            /^(penduduk|pddk|miskin|kemiskinan|ipm|indeks|pdrb|kapita|perkapita|tpak|tpt|penganggur|angkatan|gini|garis|harapan|sekolah|ketergantungan|kepadatan|uhh|hls|rls|inflasi|pertumbuhan)$/.test(x));
          if (w) hits = cariIndSulsel(w);
        }

        if (!isTampilSul && hits.length > 0) {
          tipeSul = 'data';
          const utama = hits[0];
          jawSul = `Berdasarkan data BPS Provinsi Sulawesi Selatan, **${utama.nama}** (${utama.tahun}) adalah:\n\n**${fmt(utama.nilai)} ${utama.satuan}**`;
          kartuSul = hits.slice(0, 4).map(v => ({
            nama: v.nama, nilai: fmt(v.nilai), satuan: v.satuan, tahun: v.tahun,
            sumber: cariSumberIndikator(v.nama, sulsulPub)
          }));
          if (isTrendSul) {
            let sulsulIndikRaw = [];
            try { if (fs.existsSync(SULSEL_INDIK_FILE)) sulsulIndikRaw = baca(SULSEL_INDIK_FILE)['Tahunan'] || []; } catch {}
            let headerRow = null;
            for (const row of sulsulIndikRaw) {
              if (!row) continue;
              if (row.filter(c => /^20\d{2}$/.test(String(c || '').trim())).length >= 3) { headerRow = row; continue; }
              if (!row[0] || !headerRow) continue;
              if (String(row[0]).trim().toLowerCase() === utama.nama.toLowerCase()) {
                trendSul = headerRow
                  .map((h, i) => ({ tahun: String(h || '').trim(), nilai: row[i] }))
                  .filter(x => /^20\d{2}$/.test(x.tahun) && x.nilai !== null && x.nilai !== '')
                  .map(x => ({ tahun: x.tahun, nilai: fmt(x.nilai) }));
                break;
              }
            }
            if (trendSul.length) jawSul += `\n\nBerikut tren **${utama.nama}** dari ${trendSul[0].tahun} hingga ${trendSul[trendSul.length - 1].tahun}:`;
          }
          pubSul = cariPubSulsel(keyword.split(' ').slice(0, 2).join(' '), 3);
          pdfSul = cariDalamPDFSulsel(rawKw);
          saranSul = [`Tren ${utama.nama}`, `Publikasi tentang ${keyword}`, `Berapa IPM Kota Makassar?`];
        } else {
          pdfSul  = cariDalamPDFSulsel(rawKw);
          pubSul  = cariPubSulsel(rawKw, 5);
          if (pubSul.length || pdfSul.length) {
            tipeSul = pdfSul.length ? 'pdf' : 'publikasi';
            jawSul  = pdfSul.length
              ? `Saya menemukan informasi tentang **"${rawKw}"** di dalam publikasi BPS Provinsi Sulawesi Selatan:`
              : `Ditemukan publikasi BPS Provinsi Sulawesi Selatan untuk "**${rawKw}**":`;
          } else {
            tipeSul = 'notfound';
            jawSul  = `Maaf, saya belum punya data untuk "**${pesan}**". Coba tanya:\n- Berapa jumlah penduduk Sulsel?\n- Berapa IPM Sulawesi Selatan 2025?\n- Berapa penduduk Kota Makassar?\n- Daerah dengan IPM tertinggi\n- Tampilkan publikasi pertanian Sulsel`;
            saranSul = ['Berapa jumlah penduduk Sulsel?', 'Berapa IPM Sulawesi Selatan?', 'Berapa angka kemiskinan Sulsel?', 'Penduduk Kota Makassar'];
          }
        }
      }
    }

    const idxSul = sumberPdf(getPdfIndexSulsel());
    return res.json({ ok: true, tipe: tipeSul, jawaban: jawSul,
      dataKartu: kartuSul.map(k => ({ ...k, sumber: k.sumber ? lengkapiHalamanPub([bersihkanLokal(k.sumber)], lower, idxSul, 'sulsel')[0] : k.sumber })),
      publikasi: lengkapiHalamanPub(pubSul.map(bersihkanLokal), lower, idxSul, 'sulsel'), kecamatan: [], trendData: trendSul, saranKueri: saranSul,
      pdfHasil: lengkapiUrlPdf(pdfSul, sulsulPub), tabelMakro: [] });
  }

  let jawaban    = '';
  let tipe       = 'info';
  let dataKartu  = [];
  let publikasi  = [];
  let kwHalaman  = lower;   // kata kunci untuk menentukan halaman pada kartu publikasi/sumber
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
        sumber: cariSumberIndikator(v.nama, allPub)
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
      // Topik dari pertanyaan (mis. penduduk) + nama kecamatan; default penduduk
      const topikKec = lower.replace(/\b(data|jumlah|kecamatan|kec|jeneponto|kabupaten|berapa|tampilkan|lihat)\b/g, ' ').replace(namaKec, ' ').trim();
      kwHalaman = `${topikKec || 'penduduk'} ${namaKec}`;
      pdfHasil  = cariDalamPDF(kwHalaman);
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
    // Sumber untuk tabel per kecamatan: halaman "penduduk menurut kecamatan" di
    // publikasi kabupaten (Dalam Angka / Statistik Daerah), bukan buku per kecamatan.
    if (!pdfHasil.length) {
      kwHalaman = 'penduduk menurut kecamatan jenis kelamin';
      const idxKab = sumberPdf(getPdfIndex()).filter(d => !/^kecamatan\s/i.test(d.judul || ''));
      pdfHasil = cariDiIndex(idxKab, kwHalaman, 4);
    }
    if (!publikasi.length) {
      publikasi = allPub
        .filter(p => /^kabupaten jeneponto dalam angka/i.test(p.judul || ''))
        .sort((a, b) => (b.tahun || 0) - (a.tahun || 0)).slice(0, 2);
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
        nama: v.nama, nilai: fmt(v.nilai), satuan: v.satuan, tahun: v.tahun, sumber: cariSumberIndikator(v.nama, allPub)
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
        nama: v.nama, nilai: fmt(v.nilai), satuan: v.satuan, tahun: v.tahun, sumber: cariSumberIndikator(v.nama, allPub)
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
    kwHalaman = /jumlah|banyak|berapa/.test(lower) ? 'jumlah desa kelurahan kecamatan' : lower;
    pdfHasil  = cariDalamPDF(kwHalaman);
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
      dataKartu = indHits.map(v => ({ nama: v.nama, nilai: fmt(v.nilai), satuan: v.satuan, tahun: v.tahun, sumber: cariSumberIndikator(v.nama, allPub) }));
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

  // Fallback sumber: bila ada kartu indikator tetapi belum ada kutipan PDF,
  // cari isi publikasi dengan nama indikatornya (lalu bentuk yang lebih umum).
  if (!pdfHasil.length && dataKartu.length) {
    const nama = String(dataKartu[0].nama || '').replace(/\(.*?\)/g, ' ').trim();
    const kandidat = [nama, nama.split(/\s+/).slice(0, 2).join(' '), nama.split(/\s+/).sort((a, b) => b.length - a.length)[0]]
      .filter(k => k && k.length > 3);
    for (const k of kandidat) {
      pdfHasil = cariDalamPDF(k);
      if (pdfHasil.length) { kwHalaman = k; break; }
    }
  }

  const idxJnp = sumberPdf(getPdfIndex());
  res.json({ ok: true, tipe, jawaban,
    dataKartu: dataKartu.map(k => ({ ...k, sumber: k.sumber ? lengkapiHalamanPub([bersihkanLokal(k.sumber)], kwHalaman, idxJnp)[0] : k.sumber })),
    publikasi: lengkapiHalamanPub(publikasi.map(bersihkanLokal), kwHalaman, idxJnp), kecamatan, trendData, saranKueri,
    pdfHasil: lengkapiUrlPdf(pdfHasil, allPub), tabelMakro });
});

// ══════════════════════════════════════════════════════
// PUBLIC API – PENCARIAN UNIVERSAL
// ══════════════════════════════════════════════════════

// Cache parsed indikator makro (agar tidak parsing ulang tiap request)
let _indikatorCache = null;
function getIndikatorMakro() {
  if (_indikatorCache) return _indikatorCache;
  _indikatorCache = parseIndikatorFile(INDIK_FILE);
  return _indikatorCache;
}

let _indikatorSulselCache = null;
function getIndikatorSulsel() {
  if (_indikatorSulselCache) return _indikatorSulselCache;
  _indikatorSulselCache = parseIndikatorFile(SULSEL_INDIK_FILE);
  return _indikatorSulselCache;
}

function parseIndikatorFile(file) {
  if (!fs.existsSync(file)) return [];

  const data   = baca(file);
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

  parseSheet(data['Tahunan']);
  parseSheet(data['Summary']);

  return result;
}

// Invalidate cache saat server restart (otomatis)
// GET /api/search?q=... – pencarian universal
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q || q.length < 2) return res.json({ ok:true, query:q, indikatorMakro:[], publikasi:[], tabelDinamis:[] });

  const words = q.split(/\s+/).filter(w => w.length > 1);
  const wil = (req.query.wilayah || '').toLowerCase() === 'sulsel' ? 'sulsel' : 'jeneponto';

  function cocok(teks) {
    const t = (teks || '').toLowerCase();
    return words.every(w => t.includes(w));
  }

  const allPub = wil === 'sulsel' ? baca(SULSEL_PUB_FILE) : baca(DATA_FILE);

  // ── 1. Indikator Makro + sumber ───────────────────────
  const indSumber = wil === 'sulsel' ? getIndikatorSulsel() : getIndikatorMakro();
  const indikatorMakro = indSumber
    .filter(v => cocok(v.nama))
    .slice(0, 8)
    .map(v => ({
      ...v,
      sumber      : cariSumberIndikator(v.nama, allPub),
      sumberExcel : wil === 'sulsel' ? 'Indikator Makro BPS Prov. Sulawesi Selatan' : 'Indikator Makro BPS Kab. Jeneponto',
      sumberUrl   : wil === 'sulsel' ? 'https://sulsel.bps.go.id' : 'https://s.bps.go.id/7304_indikatormakro',
    }));

  // ── 2. Tabel Dinamis ─────────────────────────────────
  let tabelDinamis = [];
  if (wil !== 'sulsel' && fs.existsSync(TABEL_FILE)) {
    const td = baca(TABEL_FILE);
    tabelDinamis = (td.indikator || [])
      .filter(v => cocok(v.judul) || cocok(v.subjek) || cocok(v.kategori))
      .slice(0, 5);
  }

  // ── 2b. Tabel Statistik Makro (seri tahun penuh) ─────
  let tabelMakro = [];
  try {
    if (wil !== 'sulsel' && fs.existsSync(MAKRO_FILE)) {
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

  // ── 4. Data Kecamatan (hanya Jeneponto) ──────────────
  let kecamatan = [];
  const pubKec = [];
  if (wil === 'jeneponto') {
    const kecWords = ['kecamatan','penduduk','bangkala','tamalatea','bontoramba',
      'binamu','turatea','batang','arungkeke','tarowang','kelara','rumbia'];
    const isKecQuery = words.some(w => kecWords.includes(w)) ||
                       q.includes('perkecamatan') || q.includes('per kecamatan') ||
                       q.includes('tiap kecamatan') || q.includes('semua kecamatan');

    if (fs.existsSync(KECAM_FILE)) {
      const allKec = baca(KECAM_FILE);
      if (isKecQuery) {
        const namaKec = words.find(w => allKec.some(k => k.kecamatan.toLowerCase().includes(w)));
        if (namaKec) {
          kecamatan = allKec.filter(k => k.kecamatan.toLowerCase().includes(namaKec));
        } else {
          kecamatan = allKec.filter(k => k.kecamatan !== 'TOTAL');
        }
      }
      allKec.filter(k => k.kecamatan !== 'TOTAL').forEach(k => {
        if (cocok(k.kecamatan) && !kecamatan.find(x => x.kecamatan === k.kecamatan)) {
          kecamatan.push(k);
        }
      });
    }

    pubKec.push(...(baca(DATA_FILE))
      .filter(p => p.judul?.toLowerCase().includes('dalam angka') && p.judul?.toLowerCase().includes('kecamatan'))
      .slice(0, 3));
  }

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
// PUBLIC API – PUBLIKASI SULAWESI SELATAN (bagian terpisah)
// ══════════════════════════════════════════════════════

function idSulsel(p) {
  return 'sulsel-' + crypto.createHash('sha1')
    .update(String(p.url||'') + '|' + String(p.judul||''))
    .digest('hex').slice(0, 10);
}

app.get('/api/publikasi-sulsel', (req, res) => {
  let data = baca(SULSEL_PUB_FILE).map(p => ({ ...p, wilayah: 'sulsel' }));
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

app.get('/api/stats-sulsel', (req, res) => {
  const data = baca(SULSEL_PUB_FILE);
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

// Index isi PDF hasil upload admin → langsung bisa dicari di chat bot.
function indexUploadLokal(fileLokal, meta) {
  if (!fileLokal || !fileLokal.toLowerCase().endsWith('.pdf')) return;
  const fname = path.basename(fileLokal);
  const abspath = path.join(UPLOAD_DIR, 'files', fname);
  if (!fs.existsSync(abspath)) return;
  const m = {
    file: fname, fileLokal,
    judul: meta.judul || fname,
    tahun: meta.tahun || null,
    kategori: meta.kategori || 'Lainnya',
    url_bps: meta.url || '',
    cover: meta.cover || '',
  };
  setImmediate(() => {
    pdfIndexer.upsertUpload(UPLOAD_PDF_INDEX_FILE, m, abspath)
      .then(r => { if (r.ok) resetPdfCaches(); })
      .catch(e => console.error('[upload-index]', e.message));
  });
}

function hapusIndexUpload(fileLokal) {
  if (!fileLokal || !fileLokal.toLowerCase().endsWith('.pdf')) return;
  const fname = path.basename(fileLokal);
  pdfIndexer.removeUpload(UPLOAD_PDF_INDEX_FILE, fname)
    .then(r => { if (r.removed) resetPdfCaches(); })
    .catch(e => console.error('[upload-index]', e.message));
}

app.get('/api/admin/publikasi', requireAdmin, (req, res) => {
  const data = baca(DATA_FILE);
  const q    = (req.query.q || '').toLowerCase();
  const items = q ? data.filter(p => p.judul?.toLowerCase().includes(q)) : data;
  res.json({ ok: true, total: items.length, data: items.map(p => ({ ...p, wilayah: 'jeneponto' })) });
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
    indexUploadLokal(pub.fileLokal, pub);
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
    const fileLokalLama = pub.fileLokal;
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
    if (pub.fileLokal !== fileLokalLama) hapusIndexUpload(fileLokalLama);
    indexUploadLokal(pub.fileLokal, pub);
    res.json({ ok: true, data: pub });
  }
);

app.delete('/api/admin/publikasi/:id', requireAdmin, (req, res) => {
  let data = baca(DATA_FILE);
  const del = data.find(p => String(p.id) === String(req.params.id));
  const n  = data.length;
  data = data.filter(p => String(p.id) !== String(req.params.id));
  if (data.length === n) return res.status(404).json({ ok: false, error: 'Tidak ditemukan' });
  tulis(DATA_FILE, data);
  if (del) hapusIndexUpload(del.fileLokal);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════
// ADMIN API – PUBLIKASI SULAWESI SELATAN
// ══════════════════════════════════════════════════════

app.get('/api/admin/publikasi-sulsel', requireAdmin, (req, res) => {
  const data = baca(SULSEL_PUB_FILE);
  const q    = (req.query.q || '').toLowerCase();
  const items = q ? data.filter(p => (p.judul||'').toLowerCase().includes(q)) : data;
  res.json({ ok: true, total: items.length, data: items.map(p => ({ ...p, id: idSulsel(p), wilayah: 'sulsel', lokal: !!p.fileLokal })) });
});

app.put('/api/admin/publikasi-sulsel/:id', requireAdmin,
  upload.fields([{ name:'cover',maxCount:1 },{ name:'file',maxCount:1 }]),
  (req, res) => {
    const data = baca(SULSEL_PUB_FILE); const files = req.files||{}; const body = req.body;
    const idx = data.findIndex(p => idSulsel(p) === req.params.id);
    if (idx < 0) return res.status(404).json({ ok:false, error:'Tidak ditemukan' });
    const pub = { ...data[idx] };
    const fileLokalLama = pub.fileLokal;
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
    data[idx] = pub; tulis(SULSEL_PUB_FILE, data);
    if (pub.fileLokal !== fileLokalLama) hapusIndexUpload(fileLokalLama);
    indexUploadLokal(pub.fileLokal, pub);
    res.json({ ok: true, data: { ...pub, id: idSulsel(pub), wilayah: 'sulsel' } });
  }
);

app.delete('/api/admin/publikasi-sulsel/:id', requireAdmin, (req, res) => {
  let data = baca(SULSEL_PUB_FILE);
  const idx = data.findIndex(p => idSulsel(p) === req.params.id);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'Tidak ditemukan' });
  const del = data[idx];
  data.splice(idx, 1); tulis(SULSEL_PUB_FILE, data);
  hapusIndexUpload(del.fileLokal);
  res.json({ ok: true });
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
    const semuaLama = baca(DATA_FILE);
    const dataLama = semuaLama.filter(p => p.lokal);
    // url_pdf hasil scrape-pdf-links.js tidak ada di daftar BPS; pertahankan.
    const urlPdfLama = new Map(semuaLama.filter(p => p.url_pdf).map(p => [p.url, p.url_pdf]));
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

    hasil.forEach(p => { if (urlPdfLama.has(p.url)) p.url_pdf = urlPdfLama.get(p.url); });
    const gabung=[...hasil,...dataLama];
    tulis(DATA_FILE,gabung);
    kirim({tipe:'indikator',pesan:'✓ Menyinkronkan indeks PDF lokal (upload admin)...'});
    let terindex = 0;
    try {
      terindex = await pdfIndexer.syncUploads(UPLOAD_PDF_INDEX_FILE, path.join(UPLOAD_DIR,'files'), gabung);
      resetPdfCaches();
      kirim({tipe:'indikator',pesan:`✓ Indeks PDF lokal tersinkron (${terindex} file)`});
    } catch(e) {
      console.error('[import-sync]', e.message);
      kirim({tipe:'indikator',pesan:`⚠ Sinkron indeks PDF gagal: ${e.message}`});
    }
    kirim({tipe:'selesai',total:hasil.length,totalDenganLokal:gabung.length});
  } catch(e) {
    kirim({tipe:'error',pesan:e.message});
  } finally {
    await browser.close(); res.end();
  }
});

// ── Sinkron tautan file PDF publikasi (url_pdf) dari BPS WebAPI ─────
// Key dari env BPS_API_KEY atau file .env (dimuat oleh bps-webapi.js).
// Gratis, daftar di webapi.bps.go.id. Tanpa key, url_pdf bisa diisi manual
// lewat scrape-pdf-links.js (AMBIL LINK PDF.bat).
const BPS_API_KEY = process.env.BPS_API_KEY || '';
async function sinkronSemuaUrlPdf(log = console.log) {
  if (!BPS_API_KEY) return { ok: false, error: 'BPS_API_KEY belum di-set' };
  const hasil = {};
  for (const [wilayah, file] of [['jeneponto', DATA_FILE], ['sulsel', SULSEL_PUB_FILE]]) {
    if (!fs.existsSync(file)) continue;
    try {
      hasil[wilayah] = await sinkronUrlPdf({ key: BPS_API_KEY, wilayah, file, log: m => log(`[url-pdf ${wilayah}] ${m}`) });
      log(`[url-pdf ${wilayah}] +${hasil[wilayah].dilengkapi} tautan PDF, ${hasil[wilayah].belum} belum cocok`);
    } catch (e) {
      hasil[wilayah] = { error: e.message };
      log(`[url-pdf ${wilayah}] gagal: ${e.message}`);
    }
  }
  return { ok: true, hasil };
}

app.post('/api/admin/sinkron-pdf', requireAdmin, async (req, res) => {
  res.json(await sinkronSemuaUrlPdf(() => {}));
});

// ── Lengkapi data halaman pada indeks PDF lama ──────────────────
// Indeks yang dibuat sebelum ada chunk_mulai/hal_mulai diindeks ulang satu per
// satu di latar belakang. Bila file PDF-nya tidak ada di server ini, diunduh
// dulu dari url_pdf (webapi.bps.go.id, tidak dilindungi Cloudflare).
async function unduhKeFile(url, tujuan) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 500 || buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('bukan file PDF');
  fs.mkdirSync(path.dirname(tujuan), { recursive: true });
  fs.writeFileSync(tujuan, buf);
}

async function lengkapiHalamanIndex() {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const pubs = [
    ...(fs.existsSync(DATA_FILE) ? baca(DATA_FILE) : []),
    ...(fs.existsSync(SULSEL_PUB_FILE) ? baca(SULSEL_PUB_FILE) : []),
  ];
  const urlPdfUntuk = d => {
    const p = pubs.find(x => x.url_pdf && ((d.url_bps && x.url === d.url_bps) || norm(x.judul) === norm(d.judul)));
    return p ? p.url_pdf : null;
  };
  const daftar = [
    { file: PDF_INDEX_FILE,        dir: path.join(UPLOAD_DIR, 'files') },
    { file: UPLOAD_PDF_INDEX_FILE, dir: path.join(UPLOAD_DIR, 'files') },
    { file: SULSEL_PDF_INDEX_FILE, dir: SULSEL_DL_DIR },
  ];
  let n = 0;
  for (const { file, dir } of daftar) {
    if (!fs.existsSync(file)) continue;
    let index = [];
    try { index = baca(file); } catch { continue; }
    for (const d of index) {
      if (!d || (Number(d.indeks_versi) || 0) >= pdfIndexer.INDEKS_VERSI) continue;
      const nama = path.basename(d.file || d.fileLokal || '');
      if (!nama) continue;
      const abspath = path.join(dir, nama);
      try {
        if (!fs.existsSync(abspath)) {
          const u = urlPdfUntuk(d);
          if (!u) continue;
          console.log(`[index-halaman] mengunduh ${nama}...`);
          await unduhKeFile(u, abspath);
        }
        const r = await pdfIndexer.upsertUpload(file, d, abspath);
        if (r.ok) { n++; resetPdfCaches(); console.log(`[index-halaman] ${d.judul} → ${r.chunks} chunk`); }
      } catch (e) { console.error('[index-halaman]', nama, e.message); }
    }
  }
  if (n) console.log(`[index-halaman] ${n} PDF kini punya data halaman`);
}

// ── Start ────────────────────────────────────────────
app.listen(PORT, () => {
  const d = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE)).length : 0;
  const u = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE)).length : 0;
  console.log(`\n╔════════════════════════════════════════════╗`);
  console.log(`║  BPS Jeneponto v3.0  → http://localhost:${PORT}  ║`);
  console.log(`║  Publikasi: ${String(d).padEnd(5)} | Users: ${String(u).padEnd(5)}             ║`);
  console.log(`╚════════════════════════════════════════════╝\n`);
  if (BPS_API_KEY) setTimeout(() => sinkronSemuaUrlPdf().catch(() => {}).then(() => lengkapiHalamanIndex()).then(() => praIndeksPublikasi()).catch(e => console.error('[index-halaman]', e.message)), 1500);
  else {
    console.log('[url-pdf] BPS_API_KEY tidak di-set (env atau file .env) — tautan PDF langsung tidak disinkron otomatis');
    setTimeout(() => lengkapiHalamanIndex().then(() => praIndeksPublikasi()).catch(e => console.error('[index-halaman]', e.message)), 1500);
  }
});

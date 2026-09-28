/**
 * pdf-indexer.js — Index otomatis isi PDF untuk chat bot.
 * Dipanggil server.js setiap kali admin upload/perbarui/hapus publikasi
 * (atau setelah import dari BPS), agar isi file langsung bisa dicari.
 */
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

// Antrian tulis sederhana agar dua request tidak menimpa satu sama lain.
let _antrian = Promise.resolve();
const mutex = fn => {
  const r = _antrian.then(fn);
  _antrian = r.catch(() => {});
  return r;
};

// Versi format indeks; server mengindeks ulang entri dengan versi lebih rendah.
const INDEKS_VERSI = 2;

// Pecah teks jadi chunk yang SEJAJAR HALAMAN (satu chunk tidak pernah melintasi
// dua halaman; halaman panjang dipecah tiap `ukuran` kata). Kembalikan juga:
//  - halMulai  : [[nomorHalaman, indeksKataAwal], ...] untuk tiap halaman
//  - chunkMulai: indeks kata awal tiap chunk
// sehingga skor pencarian = skor per halaman dan nomor halaman kutipan pasti tepat.
function pecahChunk(pages, ukuran = 350) {
  const words = [], halMulai = [], chunks = [], chunkMulai = [];
  for (const p of pages) {
    const w = String(p.text || '').split(/\s+/).filter(Boolean);
    if (!w.length) continue;
    halMulai.push([p.num, words.length]);
    for (let i = 0; i < w.length; i += ukuran) {
      const chunk = w.slice(i, i + ukuran).join(' ');
      if (chunk.length > 30) { chunks.push(chunk); chunkMulai.push(words.length + i); }
    }
    words.push(...w);
  }
  return { chunks, chunkMulai, halMulai };
}

async function ekstrakPdf(filePath) {
  const buf = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buf, verbosity: 0 });
  try {
    const r = await parser.getText();
    const teks = String((r && r.text) || '').replace(/\s+/g, ' ').trim();
    const pages = Array.isArray(r && r.pages) && r.pages.length
      ? r.pages.map(p => ({ num: Number(p.num) || 1, text: p.text }))
      : [{ num: 1, text: teks }];
    let halaman = Number(r && r.total) || pages.length;
    if (!halaman) {
      try {
        const info = await parser.getInfo(); // bisa dipanggil tanpa parsePageInfo
        halaman = Number(info && info.total) || 0;
      } catch {}
    }
    return { teks, pages, halaman };
  } finally {
    try { await parser.destroy(); } catch {}
  }
}

/**
 * Upsert satu PDF ke index (array JSON).
 * @param {string} indexFile  path ke file index (mis. db/pdf-index-upload.json)
 * @param {object} meta       { file, fileLokal, judul, tahun, kategori, url_bps, cover }
 * @param {string} pdfPath    path absolut file PDF
 */
function upsertUpload(indexFile, meta, pdfPath) {
  const f = path.posix.join(indexFile);
  return mutex(async () => {
    const file = path.basename(meta.file || pdfPath);
    if (!fs.existsSync(pdfPath)) return { ok: false, error: 'File tidak ada' };

    const { teks, pages, halaman } = await ekstrakPdf(pdfPath);
    const { chunks, chunkMulai, halMulai } = pecahChunk(pages);
    const entry = {
      file,
      fileLokal: meta.fileLokal || `/uploads/files/${file}`,
      judul: meta.judul || file,
      tahun: meta.tahun || null,
      kategori: meta.kategori || 'Lainnya',
      url_bps: meta.url_bps || '',
      cover: meta.cover || '',
      hal_total: halaman,
      chunks,
      chunk_mulai: chunkMulai,
      hal_mulai: halMulai,
      indeks_versi: INDEKS_VERSI,
      teks_full: teks.slice(0, 8000),
      diindexPada: new Date().toISOString(),
    };

    let index = [];
    try { index = JSON.parse(fs.readFileSync(f, 'utf-8') || '[]'); } catch {}
    if (!Array.isArray(index)) index = [];
    index = index.filter(d => d.file !== file);
    index.unshift(entry);

    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf-8');
    fs.renameSync(tmp, f);
    return { ok: true, judul: entry.judul, chunks: entry.chunks.length };
  });
}

/** Hapus satu PDF dari index berdasarkan nama file. */
function removeUpload(indexFile, fileName) {
  return mutex(() => {
    let index = [];
    try { index = JSON.parse(fs.readFileSync(indexFile, 'utf-8') || '[]'); } catch {}
    if (!Array.isArray(index)) index = [];
    const n = index.length;
    index = index.filter(d => d.file !== fileName);
    if (index.length === n) return { ok: true, removed: false };
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), 'utf-8');
    return { ok: true, removed: true };
  });
}

/**
 * Sinkronkan index upload dengan daftar publikasi lokal:
 * - index file yang ada & tersimpan, buang entri yang file-nya hilang.
 * @param {Array<object>} pubs  daftar publikasi (memuat fileLokal / url / judul dst.)
 */
async function syncUploads(indexFile, uploadDir, pubs) {
  const daftar = pubs.filter(p => p && p.fileLokal && p.fileLokal.toLowerCase().endsWith('.pdf'));
  const target = {};
  for (const p of daftar) {
    const fname = path.basename(p.fileLokal);
    const abspath = path.join(uploadDir, fname);
    if (fs.existsSync(abspath) && abspath.toLowerCase().endsWith('.pdf')) {
      target[fname] = {
        file: fname,
        fileLokal: p.fileLokal,
        judul: p.judul || fname,
        tahun: p.tahun || null,
        kategori: p.kategori || 'Lainnya',
        url_bps: p.url || '',
        cover: p.cover || '',
        path: abspath,
      };
    }
  }
  // Buang entri yang filenya tak lagi dipakai publikasi lokal manapun.
  await mutex(async () => {
    let index = [];
    try { index = JSON.parse(fs.readFileSync(indexFile, 'utf-8') || '[]'); } catch {}
    if (!Array.isArray(index)) index = [];
    index = index.filter(d => target[d.file]);
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), 'utf-8');
  });
  // Index/update tiap file yang belum ada di index.
  let terindex = 0;
  for (const fname of Object.keys(target)) {
    const t = target[fname];
    const r = await upsertUpload(indexFile, t, t.path);
    if (r.ok) terindex++;
  }
  return terindex;
}

module.exports = { upsertUpload, removeUpload, syncUploads, pecahChunk, INDEKS_VERSI };
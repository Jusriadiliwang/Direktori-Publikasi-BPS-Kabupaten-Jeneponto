// Diagnostik sekali-pakai: cari kata di indeks PDF dan tampilkan halaman kandidat.
// node _cari-halaman.js "<judul regex>" "<kata>" [maks]
const a = [...require('./db/pdf-index.json'), ...require('./db/pdf-index-upload.json')];
const [, , judulRe, kw, maks = '6'] = process.argv;
const re = new RegExp(judulRe, 'i');
for (const d of a.filter(x => re.test(x.judul))) {
  const hal = i => { let h = 1; for (const [p, k] of d.hal_mulai) { if (k <= d.chunk_mulai[i]) h = p; else break; } return h; };
  console.log('== ' + d.judul);
  let n = 0;
  d.chunks.forEach((c, i) => {
    const cl = c.toLowerCase(); const p = cl.indexOf(kw.toLowerCase());
    if (p >= 0 && n < +maks) { n++; console.log('  hal', hal(i), '|', c.slice(Math.max(0, p - 70), p + 110).replace(/\s+/g, ' ')); }
  });
}

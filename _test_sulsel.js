const BASE = 'http://127.0.0.1:3000/api/chat';
async function t(nama, pesan) {
  try {
    const r = await fetch(BASE, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pesan })
    });
    const j = await r.json();
    console.log(`\n[${nama}] "${pesan}"`);
    console.log('  tipe:', j.tipe);
    console.log('  jawaban:', (j.jawaban || '').replace(/\n/g, ' | ').slice(0, 320));
    if (j.dataKartu && j.dataKartu.length) console.log('  kartu:', j.dataKartu.map(k => `${k.nama}=${k.nilai}${k.satuan || ''}(${k.tahun || ''})`).join('; '));
    if (j.publikasi && j.publikasi.length) console.log('  publikasi:', j.publikasi.slice(0, 2).map(p => p.judul).join(' | '));
  } catch (e) { console.log(`[${nama}] ERROR`, e.message); }
}

(async () => {
  const Q = [
    ['pddk-sulsel', 'berapa jumlah penduduk sulsel?'],
    ['ipm-sulsel', 'berapa ipm sulawesi selatan 2025?'],
    ['miskin-sulsel', 'berapa angka kemiskinan sulsel?'],
    ['tpt-sulsel', 'berapa tpt nya sulsel'],
    ['gini-sulsel', 'berapa gini rasio sulsel'],
    ['pdrbkap-sulsel', 'berapa pdrb per kapita sulsel'],
    ['pdrb-sulsel', 'berapa total pdrb sulawesi selatan'],
    ['tpak-sulsel', 'berapa tpak sulsel'],
    ['penduduk-makassar', 'berapa penduduk kota makassar?'],
    ['tpt-makassar', 'berapa tpt makassar'],
    ['ipm-gowa', 'berapa ipm gowa'],
    ['miskin-jeneponto', 'berapa penduduk miskin jeneponto 2025'],
    ['data-gowa', 'data gowa'],
    ['data-selayar', 'tolong data kepulauan selayar'],
    ['ipm-tertinggi', 'kabupaten dengan ipm tertinggi di sulsel'],
    ['pddk-terbanyak', 'daerah mana penduduk terbanyak sulawesi selatan'],
    ['daftar-kab', 'daftar kabupaten di sulsel'],
    ['tren-makassar', 'perkembangan penduduk makassar dari tahun ke tahun'],
    ['pub-pertanian', 'tampilkan publikasi pertanian sulsel'],
    ['pub-daa', 'cari publikasi dalam angka sulsel'],
    ['sensus-ekonomi', 'ada data sensus ekonomi sulsel?'],
    ['jeneponto-standar', 'berapa jumlah penduduk jeneponto?'],
    ['kec-binamu', 'data kecamatan binamu'],
    ['sapa', 'halo apa kabar'],
  ];
  for (const [n, q] of Q) await t(n, q);
  process.exit(0);
})();
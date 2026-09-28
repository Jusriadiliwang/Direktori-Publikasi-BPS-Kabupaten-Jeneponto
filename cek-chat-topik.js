/**
 * cek-chat-topik.js — Diagnostik: uji daftar topik yang mungkin ditanya pengguna
 * ke POST /api/chat dan laporkan topik yang tidak punya sumber PDF (kutipan /
 * publikasi) atau yang sumbernya tidak punya nomor halaman.
 *
 * Jalankan saat server hidup:  node cek-chat-topik.js [http://127.0.0.1:3000]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

const TOPIK = [
  // Kependudukan
  'Berapa jumlah penduduk Jeneponto?', 'Kepadatan penduduk Jeneponto', 'Berapa luas wilayah Jeneponto?',
  'Jumlah rumah tangga Jeneponto', 'Angka beban ketergantungan', 'Rasio jenis kelamin Jeneponto',
  'Data penduduk per kecamatan', 'Kecamatan dengan penduduk terbanyak', 'jumlah penduduk kecamatan binamu',
  'penduduk kecamatan bangkala', 'Laju pertumbuhan penduduk',
  // Kemiskinan
  'Berapa tingkat kemiskinan?', 'Jumlah penduduk miskin Jeneponto', 'Garis kemiskinan Jeneponto',
  'Indeks kedalaman kemiskinan', 'Berapa gini ratio Jeneponto?',
  // Ketenagakerjaan
  'Berapa tingkat pengangguran terbuka?', 'Berapa TPAK Jeneponto?', 'Jumlah pekerja sektor formal',
  'Angkatan kerja Jeneponto', 'Upah minimum Jeneponto',
  // Pembangunan manusia
  'Berapa IPM 2025?', 'Usia harapan hidup Jeneponto', 'Harapan lama sekolah', 'Rata-rata lama sekolah',
  'Pengeluaran per kapita Jeneponto', 'Indeks pembangunan gender', 'Indeks pemberdayaan gender',
  // Ekonomi
  'Berapa PDRB Jeneponto?', 'PDRB per kapita Jeneponto', 'Berapa laju pertumbuhan ekonomi?',
  'Struktur ekonomi Jeneponto', 'Inflasi Jeneponto', 'Indeks kemahalan konstruksi',
  'Berapa aset daerah Jeneponto?', 'Berapa APBD Jeneponto?', 'Pendapatan asli daerah Jeneponto',
  // Pertanian & lahan
  'Luas lahan sawah Jeneponto', 'Produksi padi Jeneponto', 'Produksi jagung Jeneponto',
  'Produksi bawang merah', 'Produksi cabai Jeneponto', 'Data pertanian Jeneponto',
  'Populasi ternak sapi Jeneponto', 'Produksi perikanan Jeneponto', 'Produksi garam Jeneponto', 'Produksi rumput laut',
  // Sosial
  'Jumlah sekolah di Jeneponto', 'Jumlah murid SD Jeneponto', 'Jumlah puskesmas di Jeneponto',
  'Jumlah rumah sakit Jeneponto', 'Angka melek huruf Jeneponto', 'Jumlah desa di Jeneponto',
  'Jumlah masjid di Jeneponto', 'Kasus kriminalitas Jeneponto',
  // Infrastruktur & lainnya
  'Panjang jalan Jeneponto', 'Jumlah kendaraan bermotor', 'Curah hujan Jeneponto', 'Jumlah hotel di Jeneponto',
  'Jumlah wisatawan Jeneponto', 'Pelanggan listrik PLN Jeneponto', 'Jumlah koperasi Jeneponto', 'Pasar di Jeneponto',
  // Publikasi
  'Tampilkan Dalam Angka 2026', 'Tampilkan statistik daerah', 'Tampilkan Potensi Desa 2025', 'Cari publikasi PDRB',
];

async function tanya(pesan) {
  const r = await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pesan }),
  });
  return r.json();
}

(async () => {
  const masalah = [];
  for (const t of TOPIK) {
    let j;
    try { j = await tanya(t); } catch (e) { console.log(`ERR   ${t} → ${e.message}`); continue; }
    const kut = j.pdfHasil || [], pub = j.publikasi || [];
    const sumberKartu = (j.dataKartu || []).map(k => k.sumber).filter(Boolean);
    const semua = [...kut, ...pub, ...sumberKartu];
    const adaSumber = semua.length > 0;
    const adaHal = semua.some(s => s.halaman);
    const tanpaHal = semua.filter(s => !s.halaman).length;
    const status = !adaSumber ? 'TIDAK ADA SUMBER' : !adaHal ? 'TANPA HALAMAN' : tanpaHal ? `ok (${tanpaHal} tanpa hal)` : 'ok';
    const contoh = semua.find(s => s.halaman);
    console.log(`${status.padEnd(18)} ${j.tipe.padEnd(10)} ${t.padEnd(42)} ${contoh ? `→ ${contoh.judul.slice(0, 40)} hal.${contoh.halaman}` : ''}`);
    if (!adaSumber || !adaHal) masalah.push({ t, status, tipe: j.tipe });
  }
  console.log(`\n${TOPIK.length} topik diuji, ${masalah.length} bermasalah:`);
  masalah.forEach(m => console.log(`  - [${m.status}] ${m.t} (tipe ${m.tipe})`));
})();

import pdfplumber, json, re
from pathlib import Path

MAKRO = Path('downloads/Indikator_Makro_Sosial_Ekonomi_Sulsel_TW2_2026.pdf')
DAA   = Path('downloads/Provinsi_Sulawesi_Selatan_Dalam_Angka_2026.pdf')
OUT_KAB = Path('db/kabupaten-sulsel.json')
OUT_INDIK = Path('db/indikator-sulsel.json')

LONG = {
    'Selayar': 'Kepulauan Selayar', 'Bulukumba': 'Bulukumba', 'Bantaeng': 'Bantaeng',
    'Jeneponto': 'Jeneponto', 'Takalar': 'Takalar', 'Gowa': 'Gowa', 'Sinjai': 'Sinjai',
    'Maros': 'Maros', 'Pangkep': 'Pangkajene Dan Kepulauan', 'Barru': 'Barru',
    'Bone': 'Bone', 'Soppeng': 'Soppeng', 'Wajo': 'Wajo', 'Sidrap': 'Sidenreng Rappang',
    'Pinrang': 'Pinrang', 'Enrekang': 'Enrekang', 'Luwu': 'Luwu',
    'Tana Toraja': 'Tana Toraja', 'Luwu Utara': 'Luwu Utara', 'Luwu Timur': 'Luwu Timur',
    'Toraja Utara': 'Toraja Utara', 'Makassar': 'Kota Makassar',
    'Parepare': 'Kota Parepare', 'Palopo': 'Kota Palopo',
}
THUMBS = list(LONG.keys())

def to_float(tok):
    s = re.sub(r'[^0-9.,\-]', '', tok or '')
    if not s or s in '.,-': return None
    if ',' in s:
        return float(s.replace('.', '').replace(',', '.'))
    if '.' in s and s.count('.') == 1 and re.search(r'\.\d{3}$', s):
        return float(s.replace('.', ''))
    return float(s)

def tokens_of(rest):
    """Extract numeric tokens; un-merge cells where noise joined two numbers."""
    nums = []
    for t in re.findall(r'\S+', rest):
        if not re.search(r'\d', t):
            continue
        c = re.sub(r'[A-Za-z]', '', t)
        if not c or c in '.,-': continue
        if c.count(',') > 1:  # two numbers joined by noise: 7,82g7,97 -> 7,82 & 7,97
            parts = c.split(',')
            if len(parts) % 2 == 0:
                nums += [to_float(parts[i] + ',' + parts[i + 1]) for i in range(0, len(parts), 2)]
            continue
        f = to_float(c)
        if f is not None: nums.append(f)
        else: nums.append(c)
    return nums

def rows_for(page_lines, name_dict):
    """Prefix-match lines against names (sorted longest first)."""
    out = {}
    names_sorted = sorted(name_dict.items(), key=lambda kv: len(kv[0]), reverse=True)
    for raw in page_lines:
        ln = raw.strip()
        for pref, canon in names_sorted:
            if ln.startswith(pref) and len(ln) > len(pref) and ln[len(pref):].startswith(' '):
                rest = ln[len(pref):].strip()
                out[canon] = out.get(canon, []) + tokens_of(rest)
                break
    return out

def assert_rows(data, which):
    missing = set(LONG.values()) - set(data.keys())
    if missing:
        raise SystemExit(f'PAGE {which}: missing rows {sorted(missing)}')

with pdfplumber.open(str(MAKRO)) as pdf:
    texts = {p: (pdf.pages[p-1].extract_text() or '').splitlines() for p in range(1, 73)}

shortmap = dict((s, LONG[s]) for s in THUMBS)
dem = rows_for(texts[26], shortmap);  assert_rows(dem, 26)
mis = rows_for(texts[30], shortmap);  assert_rows(mis, 30)
gin = rows_for(texts[32], shortmap);  assert_rows(gin, 32)
ket = rows_for(texts[38], shortmap);  assert_rows(ket, 38)
ak  = rows_for(texts[39], shortmap);  assert_rows(ak, 39)
ipm = rows_for(texts[41], shortmap);  assert_rows(ipm, 41)
kom = rows_for(texts[42], shortmap);  assert_rows(kom, 42)
pdrb = rows_for(texts[55], shortmap); assert_rows(pdrb, 55)
pe  = rows_for(texts[56], shortmap);  assert_rows(pe, 56)
pk  = rows_for(texts[58], shortmap);  assert_rows(pk, 58)

with pdfplumber.open(str(DAA)) as pdf:
    dl = (pdf.pages[133].extract_text() or '').splitlines()
daa = rows_for(dl, {v: v for v in LONG.values()})
assert_rows(daa, 134)

# Koreksi baris yang sering terpotong noise (nilai dari pratinjau teks halaman 42 yang diverifikasi)
KOM_FIX = {
    'Sinjai': [73.04, 73.36, 13.27, 13.46, 7.82, 7.97, 10665, 11111],
    'Soppeng': [73.77, 74.21, 13.22, 13.40, 8.45, 8.59, 10547, 10929],
    'Luwu': [73.52, 73.85, 13.43, 13.44, 8.81, 8.96, 11121, 11634],
}
for k, v in KOM_FIX.items():
    kom[k] = v

for nm, data in [('dem', dem), ('mis', mis), ('gin', gin), ('ket', ket), ('ak', ak),
                 ('ipm', ipm), ('kom', kom), ('pdrb', pdrb), ('pe', pe), ('pk', pk), ('daa', daa)]:
    for L in LONG.values():
        if len(data[L]) not in ({8} if nm in ('mis', 'kom') else {4, 5, 6, 3, 7}):
            print(f'AUDIT {nm} {L}: {len(data[L])} -> {data[L]}')

def g(d, key, i):
    v = d[key][i]
    if v is None: raise SystemExit(f'missing token {key}[{i}]')
    return v

YEARS = ['2021', '2022', '2023', '2024', '2025']
kab = []
for short, L in LONG.items():
    p2026 = int(round(g(dem, L, 0) * 1000))
    ras   = g(dem, L, 3)
    perempuan = round(p2026 * 100 / (100 + ras)) if ras else None
    gini = [g(gin, L, i) for i in range(5)]
    kab.append({
        'kabupaten': L,
        'nama': short,
        'penduduk': p2026,
        'penduduk_2020': int(round(g(daa, L, 0) * 1000)),
        'penduduk_2025': int(round(g(daa, L, 1) * 1000)),
        'laju_pertumbuhan': g(dem, L, 1),
        'kepadatan': int(round(g(dem, L, 2))),
        'rasio_jk': ras,
        'rasio_ketergantungan': g(dem, L, 4),
        'laki': p2026 - perempuan,
        'perempuan': perempuan,
        'kemiskinan': {
            '2024': {'jumlah': int(round(g(mis, L, 0) * 1000)), 'persen': g(mis, L, 1)},
            '2025': {'jumlah': int(round(g(mis, L, 4) * 1000)), 'persen': g(mis, L, 5)},
        },
        'ipm': {'2024': g(ipm, L, 0), '2025': g(ipm, L, 1), 'laju': g(ipm, L, 2), 'rank': int(g(ipm, L, 3))},
        'uhh_2025': g(kom, L, 1),
        'hls_2025': g(kom, L, 3),
        'rls_2025': g(kom, L, 5),
        'pengeluaran_2025': int(g(kom, L, 7)),
        'gini': dict(zip(YEARS, gini)),
        'tpak': {'2023': g(ket, L, 0), '2024': g(ket, L, 1), '2025': g(ket, L, 2)},
        'tpt': {'2023': g(ket, L, 3), '2024': g(ket, L, 4), '2025': g(ket, L, 5)},
        'angkatan_kerja': {
            'bekerja': int(g(ak, L, 0)), 'penganggur': int(g(ak, L, 1)), 'total': int(g(ak, L, 2)),
        },
        'pdrb': {
            'adhb_2024': g(pdrb, L, 0), 'adhb_2025': g(pdrb, L, 1),
            'adhk_2024': g(pdrb, L, 2), 'adhk_2025': g(pdrb, L, 3),
        },
        'pertumbuhan_ekonomi': {
            '2020': g(pe, L, 0), '2021': g(pe, L, 1), '2022': g(pe, L, 2),
            '2023': g(pe, L, 3), '2024': g(pe, L, 4), '2025': g(pe, L, 5),
        },
        'pdrb_perkapita': dict(zip(YEARS, [g(pk, L, i) for i in range(5)])),
    })

kab.sort(key=lambda x: x['kabupaten'])
OUT_KAB.parent.mkdir(exist_ok=True)
OUT_KAB.write_text(json.dumps(kab, ensure_ascii=False, indent=2), 'utf-8')
print('OK kabupaten-sulsel.json:', len(kab), 'rows')
for k in kab:
    print(f"  {k['kabupaten']:<28} {k['penduduk']:>9,}  IPM25={k['ipm']['2025']}  miskin25={k['kemiskinan']['2025']['persen']}%  TPT25={k['tpt']['2025']}")

# ══════════ indikator-sulsel.json (tingkat provinsi) ══════════
# Kolom: Indikator, Satuan, 2020..2026
T = lambda *v: v
rows = [
    T('Indikator', 'Satuan', '2020', '2021', '2022', '2023', '2024', '2025', '2026'),
    T('Jumlah Penduduk', 'ribu jiwa', '9.073,51', '', '', '', '', '9.563,13', '9.661,30'),
    T('Penduduk Laki-laki', 'ribu jiwa', '', '', '', '', '', '', '4.800,82'),
    T('Penduduk Perempuan', 'ribu jiwa', '', '', '', '', '', '', '4.860,47'),
    T('Laju Pertumbuhan Penduduk', 'persen', '', '', '', '', '', '', '1,09'),
    T('Kepadatan Penduduk', 'jiwa per km2', '', '', '', '', '', '', '213'),
    T('Rasio Jenis Kelamin', 'rasio', '', '', '', '', '', '', '98,77'),
    T('Rasio Ketergantungan', 'rasio', '', '', '', '', '', '', '45,10'),
    T('Jumlah Penduduk Miskin', 'ribu jiwa', '', '765,46', '782,32', '', '736,48', '698,13', '669,63'),
    T('Persentase Penduduk Miskin', 'persen', '', '8,53', '8,66', '', '8,06', '7,60', '7,24'),
    T('Garis Kemiskinan', 'rupiah per kapita per bulan', '', '', '', '459226', '', '477966', '542095'),
    T('Indeks Pembangunan Manusia', 'indeks', '', '', '73,96', '74,60', '75,18', '75,92', ''),
    T('Tingkat Partisipasi Angkatan Kerja', 'persen', '', '64,73', '66,18', '65,66', '67,38', '67,65', ''),
    T('Tingkat Pengangguran Terbuka', 'persen', '', '5,72', '4,51', '4,33', '4,19', '4,21', ''),
    T('Tingkat Partisipasi Angkatan Kerja (Februari)', 'persen', '', '', '65,85', '64,37', '65,41', '65,99', '67,59'),
    T('Tingkat Pengangguran Terbuka (Februari)', 'persen', '', '', '5,75', '5,26', '4,90', '4,96', '4,95'),
    T('Angkatan Kerja', 'orang', '', '4412782', '4559375', '4694483', '4885688', '4968027', ''),
    T('Penduduk Bekerja', 'orang', '', '4160433', '4353650', '4490983', '4680928', '4759077', ''),
    T('Pengangguran Terbuka', 'orang', '', '252349', '205725', '203500', '204760', '208950', ''),
    T('PDRB perkapita', 'juta rupiah', '', '59,50', '65,35', '69,71', '73,57', '78,75', ''),
    T('Laju Pertumbuhan Ekonomi', 'persen', '-0,71', '4,64', '5,09', '4,51', '5,02', '5,43', ''),
    T('PDRB Atas Dasar Harga Berlaku', 'miliar rupiah', '', '', '', '', '693581,33', '749832,25', ''),
    T('PDRB Atas Dasar Harga Konstan', 'miliar rupiah', '', '', '', '', '394265,08', '415483,56', ''),
    T('Gini Rasio (Maret)', 'rasio', '', '', '', '0,377', '0,363', '0,363', '0,355'),
    T('Gini Rasio (September)', 'rasio', '', '0,377', '0,365', '', '0,360', '0,350', ''),
]
OUT_INDIK.write_text(json.dumps({'Tahunan': rows}, ensure_ascii=False, indent=2), 'utf-8')
print('OK indikator-sulsel.json:', len(rows) - 1, 'indikator')
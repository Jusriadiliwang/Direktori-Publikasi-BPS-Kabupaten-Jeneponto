"""
build_tabel_makro.py
Mengubah indikator.json (Executive Summary Indikator Makro BPS Jeneponto)
menjadi tabel-tabel terstruktur siap ditampilkan di tabel.html
"""
import json
from pathlib import Path

BASE = Path(__file__).parent
SRC  = BASE / 'db' / 'indikator.json'
OUT  = BASE / 'db' / 'tabel-makro.json'

raw = json.load(open(SRC, 'r', encoding='utf-8'))
t = raw['Tahunan']  # array of arrays (baris tabel)

def is_header(r):
    return any(str(c).strip().lower().startswith('indikator') for c in r if isinstance(c, str))

def is_title(r):
    return any('Executive Summary' in str(c) for c in r if c)

# 1. Kumpulkan baris data non-kosong
rows = [r for r in t if any(c not in (None, '') for c in r)]
rows = [r for r in rows if not is_title(r)]

tables = []
current = None
for r in rows:
    if is_header(r):
        # header: ["Indikator Kemiskinan", "Satuan", "2010", "2011", ..., "2025", "Ket"]
        nama = r[0]
        years = [str(c) for c in r[2:-1]]
        current = {'nama': nama, 'satuan_len': None, 'years': years, 'rows': []}
        tables.append(current)
    elif current is not None:
        # data row: [label, satuan, v2010, v2011, ..., v2025, ket]
        label = r[0]
        if not label:
            continue
        satuan = r[1] if len(r) > 1 else None
        ket    = r[-1] if len(r) > (2 + len(current['years'])) else None
        vals   = r[2:2 + len(current['years'])]
        current['rows'].append({
            'label': str(label).strip(),
            'satuan': satuan,
            'nilai': vals,
            'ket': ket if ket not in (None, '') else None,
        })

result = []
for tb in tables:
    result.append({
        'nama': tb['nama'],
        'years': tb['years'],
        'rows': tb['rows'],
    })

# ── 2. Data Kependudukan Menurut Kecamatan (dari kecamatan.json) ──
KEC_FILE = BASE / 'db' / 'kecamatan.json'
if KEC_FILE.exists():
    kec = json.load(open(KEC_FILE, 'r', encoding='utf-8'))
    cols = ['Penduduk', 'Laki-laki', 'Perempuan', 'Jumlah KK', 'Luas (km²)']
    kec_rows = []
    for k in kec:
        if not isinstance(k, dict) or not k.get('kecamatan'):
            continue
        kec_rows.append({
            'label': str(k['kecamatan']),
            'satuan': None,
            'nilai': [k.get('penduduk'), k.get('laki'), k.get('perempuan'), k.get('kk'), k.get('luas_km2')],
            'ket': None,
        })
    if kec_rows:
        result.append({
            'nama': 'Kependudukan Menurut Kecamatan',
            'years': cols,
            'rows': kec_rows,
            'perKecamatan': True,
        })

OUT.write_text(json.dumps({
    'sumber': 'Executive Summary Indikator Makro + Data Kecamatan BPS Kabupaten Jeneponto',
    'satuan': 'Beragam - lihat kolom Satuan',
    'tabel': result,
}, ensure_ascii=False, indent=2), 'utf-8')

print(f'Buat {len(result)} tabel makro:')
for tb in result:
    print(f"  - {tb['nama']} ({len(tb['rows'])} {('kecamatan' if tb.get('perKecamatan') else 'baris')}, tahun {tb['years'][0]}-{tb['years'][-1]})")

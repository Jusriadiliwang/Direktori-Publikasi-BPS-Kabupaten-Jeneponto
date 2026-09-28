"""
build_pdf_index.py
Ekstrak teks dari semua PDF lokal dan buat db/pdf-index.json
untuk pencarian chatbot.
"""
import json, re, sys
from pathlib import Path

import pdfplumber

BASE  = Path(__file__).parent
PDF_DIR = BASE / 'uploads' / 'files'
OUT   = BASE / 'db' / 'pdf-index.json'
DB    = BASE / 'db' / 'publikasi.json'

def bersihkan(teks):
    t = re.sub(r'\s+', ' ', teks or '').strip()
    t = re.sub(r'[^\w\s.,:\-%()/]', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()

INDEKS_VERSI = 2  # format indeks; harus sama dengan pdf-indexer.js

def pecah_chunk(halaman, ukuran=350):
    """Pecah teks jadi chunk SEJAJAR HALAMAN (tidak melintasi dua halaman;
    halaman panjang dipecah tiap `ukuran` kata).
    Mengembalikan (chunks, chunk_mulai, hal_mulai):
      chunk_mulai = indeks kata awal tiap chunk
      hal_mulai   = [[nomor_halaman, indeks_kata_awal], ...]
    sehingga skor pencarian = skor per halaman dan nomor halaman kutipan tepat."""
    words, hal_mulai, chunks, chunk_mulai = [], [], [], []
    for h in halaman:
        w = h['teks'].split()
        if not w:
            continue
        hal_mulai.append([h['hal'], len(words)])
        for i in range(0, len(w), ukuran):
            chunk = ' '.join(w[i:i+ukuran])
            if len(chunk) > 30:
                chunks.append(chunk)
                chunk_mulai.append(len(words) + i)
        words.extend(w)
    return chunks, chunk_mulai, hal_mulai

def ekstrak_pdf(path):
    teks_halaman = []
    try:
        with pdfplumber.open(str(path)) as pdf:
            print(f'    {len(pdf.pages)} halaman...', end=' ', flush=True)
            for i, page in enumerate(pdf.pages):
                try:
                    t = page.extract_text() or ''
                    if len(t.strip()) > 20:
                        teks_halaman.append({
                            'hal': i + 1,
                            'teks': bersihkan(t)
                        })
                except:
                    pass
    except Exception as e:
        print(f'\n    ERROR: {e}')
        return []
    return teks_halaman

def cari_nilai_angka(teks_list):
    """Cari pasangan: label - angka dari teks PDF untuk data terstruktur."""
    pola = re.compile(
        r'([A-Za-z][A-Za-z\s,./\-]{3,60}?)\s*[:\-]?\s*'
        r'([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)\s*'
        r'([a-zA-Z%/]{0,15})',
        re.IGNORECASE
    )
    hasil = []
    for item in teks_list:
        for m in pola.finditer(item['teks']):
            label = m.group(1).strip()
            angka = m.group(2).replace('.', '').replace(',', '.')
            satuan = m.group(3).strip()
            if len(label) > 5 and len(label) < 60:
                try:
                    float(angka)
                    hasil.append({'label': label, 'nilai': angka, 'satuan': satuan, 'hal': item['hal']})
                except:
                    pass
    return hasil[:200]

def main():
    pub_data = json.loads(DB.read_text('utf-8'))
    pub_map = {p.get('fileLokal', ''): p for p in pub_data if p.get('fileLokal')}

    index = []
    pdf_files = sorted(PDF_DIR.glob('*.pdf'))
    print(f'Ditemukan {len(pdf_files)} PDF\n')

    for pdf_path in pdf_files:
        fname = pdf_path.name
        lokal_key = f'/uploads/files/{fname}'
        pub = pub_map.get(lokal_key, {})
        judul = pub.get('judul', fname.replace('_', ' ').replace('.pdf', ''))
        tahun = pub.get('tahun', 0)
        kategori = pub.get('kategori', 'Lainnya')
        url_bps = pub.get('url', '')
        cover = pub.get('cover', '')

        print(f'  [{fname[:50]}]', end=' ', flush=True)
        halaman = ekstrak_pdf(pdf_path)
        if not halaman:
            print('(kosong/error)')
            continue

        semua_teks = ' '.join(h['teks'] for h in halaman)
        chunks, chunk_mulai, hal_mulai = pecah_chunk(halaman)

        entry = {
            'file'     : fname,
            'fileLokal': lokal_key,
            'judul'    : judul,
            'tahun'    : tahun,
            'kategori' : kategori,
            'url_bps'  : url_bps,
            'cover'    : cover,
            'hal_total': len(halaman),
            'chunks'   : chunks,                 # satu chunk = satu (bagian) halaman
            'chunk_mulai': chunk_mulai,          # indeks kata awal tiap chunk
            'hal_mulai': hal_mulai,              # [[halaman, indeks kata awal], ...]
            'indeks_versi': INDEKS_VERSI,
            'teks_full': semua_teks[:8000],      # preview 8 KB pertama
        }
        index.append(entry)
        print(f'{len(chunks)} chunk OK')

    OUT.write_text(json.dumps(index, ensure_ascii=False, indent=2), 'utf-8')
    total_chunk = sum(len(e['chunks']) for e in index)
    print(f'\nIndex selesai: {len(index)} dokumen, {total_chunk} chunk')
    print(f'Disimpan ke: {OUT}')

if __name__ == '__main__':
    main()

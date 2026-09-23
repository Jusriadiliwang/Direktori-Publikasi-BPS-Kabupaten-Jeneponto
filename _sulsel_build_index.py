"""
_sulsel_build_index.py
Baca db/sulsel-manifest.json + downloads/sulsel/*.pdf -> db/pdf-index-sulsel.json
untuk pencarian isi PDF Provinsi Sulawesi Selatan.
"""
import json, re, sys
from pathlib import Path

import pdfplumber

BASE = Path(__file__).parent
PDF_DIR = BASE / 'downloads' / 'sulsel'
OUT = BASE / 'db' / 'pdf-index-sulsel.json'
MANIFEST = BASE / 'db' / 'sulsel-manifest.json'


def bersihkan(teks):
    t = re.sub(r'\s+', ' ', teks or '').strip()
    t = re.sub(r'[^\w\s.,:\-%()/]', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()


def pecah_chunk(teks, ukuran=400, overlap=80):
    words = teks.split()
    chunks = []
    i = 0
    while i < len(words):
        chunk = ' '.join(words[i:i + ukuran])
        if len(chunk) > 50:
            chunks.append(chunk)
        i += ukuran - overlap
    return chunks


def ekstrak_pdf(path):
    teks_halaman = []
    try:
        with pdfplumber.open(str(path)) as pdf:
            print(f'    {len(pdf.pages)} halaman...', end=' ', flush=True)
            for i, page in enumerate(pdf.pages):
                try:
                    t = page.extract_text() or ''
                    if len(t.strip()) > 20:
                        teks_halaman.append({'hal': i + 1, 'teks': bersihkan(t)})
                except Exception:
                    pass
    except Exception as e:
        print(f'\n    ERROR: {e}')
        return []
    return teks_halaman


def main():
    manifest = json.loads(MANIFEST.read_text('utf-8'))
    by_file = {p['file']: p for p in manifest}
    pdf_files = [p for p in sorted(PDF_DIR.glob('*.pdf')) if p.name in by_file]
    print(f'Ditemukan {len(pdf_files)} PDF untuk diindex\n')

    index = []
    for pdf_path in pdf_files:
        meta = by_file[pdf_path.name]
        print(f'  [{pdf_path.name[:45]}]', end=' ', flush=True)
        halaman = ekstrak_pdf(pdf_path)
        if not halaman:
            print('(kosong/error)')
            continue
        semua_teks = ' '.join(h['teks'] for h in halaman)
        chunks = pecah_chunk(semua_teks)
        entry = {
            'file': pdf_path.name,
            'fileLokal': f'/uploads/sulsel-files/{pdf_path.name}',
            'judul': meta.get('judul', pdf_path.name),
            'tahun': meta.get('tahun', 0),
            'kategori': meta.get('kategori', 'Lainnya'),
            'url_bps': meta.get('url', ''),
            'cover': meta.get('cover', ''),
            'hal_total': len(halaman),
            'chunks': chunks[:120],
            'teks_full': semua_teks[:8000],
        }
        index.append(entry)
        print(f'{len(entry["chunks"])} chunk OK')

    OUT.write_text(json.dumps(index, ensure_ascii=False, indent=2), 'utf-8')
    total_chunk = sum(len(e['chunks']) for e in index)
    print(f'\nIndex selesai: {len(index)} dokumen, {total_chunk} chunk -> {OUT}')


if __name__ == '__main__':
    main()
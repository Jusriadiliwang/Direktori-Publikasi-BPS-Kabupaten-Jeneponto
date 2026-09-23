const fs = require('fs');
const path = require('path');

const dir = 'D:/Data Pindahan C/Desktop/BPS/web/public';
const files = ['index.html', 'chat.html', 'indikator.html', 'tabel.html', 'admin/index.html'];

const MAP = [
  ['â”€', '\u2500'],
  ['â†’', '\u2192'],
  ['â€¹', '\u2039'],
  ['â€º', '\u203A'],
  ['ðŸ“Š', '\u{1F4CA}'],
  ['ðŸ“„', '\u{1F4D8}'],
  ['ðŸ“‹', '\u{1F4CB}'],
  ['Â²', '\u00B2'],
  ['Ã©', '\u00E9'],
  ['â™¦', '\u2666'],
  ['â€¦', '\u2026'],
];

let total = 0;
for (const f of files) {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) { console.log('skip (not exists):', f); continue; }
  let c = fs.readFileSync(p, 'utf8');
  let hit = 0;
  for (const [old, nw] of MAP) {
    const before = c.split(old).length - 1;
    if (before > 0) { c = c.split(old).join(nw); hit += before; }
  }
  if (hit > 0) {
    fs.writeFileSync(p, c, 'utf8');
    console.log(`fixed ${hit}x -> ${f}`);
    total += hit;
  } else {
    console.log(`clean: ${f}`);
  }
}
console.log('TOTAL replacements:', total);

const { chromium } = require('playwright');
(async()=>{
  const b = await chromium.launch({headless:true});
  const p = await b.newPage();
  
  const url = 'https://jenepontokab.bps.go.id/id/publication/2026/04/30/610b9dbba38158e6ad79a10e/produk-domestik-regional-bruto-kabupaten-jeneponto-menurut-pengeluaran-2021-2025.html';
  console.log('Loading:', url);
  
  await p.goto(url, {waitUntil:'domcontentloaded', timeout:20000});
  await p.waitForTimeout(3000);
  
  const links = await p.evaluate(()=>{
    const sels = ['a[href*=".pdf"]', 'a[href*="unduh"]', 'a[href*="download"]', 
                  'a[href*="flipbook"]', 'a[href*="perpustakaan"]', 'button'];
    const found = [];
    sels.forEach(sel=>{
      document.querySelectorAll(sel).forEach(a=>{
        const txt = (a.innerText||'').trim().substring(0,60);
        const href = a.href||'';
        if(txt.length>0) found.push({text:txt, href, tag:a.tagName});
      });
    });
    return found.slice(0,20);
  });
  
  console.log('\n=== DOWNLOAD LINKS ===');
  links.forEach(l => console.log(' -', l.tag, '|', l.text, '|', l.href.substring(0,80)));
  
  // Screenshot
  await p.screenshot({path:'db/pub-preview.png'});
  console.log('\nScreenshot saved: db/pub-preview.png');
  
  await b.close();
})();

// Test: klik tombol halaman 2 dari halaman 1
const {chromium}=require('playwright');
(async()=>{
  const b=await chromium.launch({headless:true});
  const ctx=await b.newContext({
    userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    locale:'id-ID'
  });
  const p=await ctx.newPage();
  
  // Mulai dari halaman 1
  await p.goto('https://jenepontokab.bps.go.id/id/publication',{waitUntil:'domcontentloaded',timeout:20000});
  try{await p.waitForSelector('a.rounded-xl',{timeout:10000});}catch{}
  await p.waitForTimeout(2000);
  
  const items1=await p.evaluate(()=>document.querySelectorAll('a.rounded-xl').length);
  console.log('Page 1 items:', items1);
  
  // Cari tombol paginasi
  const pagerButtons=await p.evaluate(()=>{
    const btns=document.querySelectorAll('button,a');
    return Array.from(btns)
      .map(b=>({text:b.innerText.trim().slice(0,20),class:b.className.slice(0,50)}))
      .filter(x=>x.text.match(/^[0-9]$|next|selanjutnya|›|>/i))
      .slice(0,10);
  });
  console.log('Pager buttons:', JSON.stringify(pagerButtons));
  
  // Screenshot untuk lihat UI
  await p.screenshot({path:'db/pager-test.png'});
  console.log('Screenshot saved');
  
  await b.close();
})();

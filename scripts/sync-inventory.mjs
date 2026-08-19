#!/usr/bin/env node
import fs from "node:fs/promises";

const BASE = "https://www.waxusedcars.com";
const SITEMAP = `${BASE}/sitemap.aspx`;
const OUT = new URL("../inventory.json", import.meta.url);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function decode(s=""){
  return s
    .replace(/&amp;/g,"&").replace(/&#38;/g,"&")
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/&nbsp;/g," ").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&#x([0-9a-f]+);/gi,(_,h)=>String.fromCharCode(parseInt(h,16)))
    .replace(/&#(\d+);/g,(_,d)=>String.fromCharCode(parseInt(d,10)));
}
function clean(s=""){
  return decode(s.replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim());
}
function num(s){
  if(s==null) return null;
  const n=Number(String(s).replace(/[^\d.]/g,""));
  return Number.isFinite(n)?n:null;
}
function unique(arr){ return [...new Set(arr.filter(Boolean))]; }

async function fetchText(url, tries=3){
  let last;
  for(let i=0;i<tries;i++){
    try{
      const r=await fetch(url,{
        headers:{
          "user-agent":"Mozilla/5.0 (compatible; MarcellInventorySync/1.0)",
          "accept":"text/html,application/xhtml+xml"
        },
        redirect:"follow"
      });
      if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return await r.text();
    }catch(e){
      last=e;
      await sleep(650*(i+1));
    }
  }
  throw last;
}

function parseUrlSummary(url){
  const pathname=new URL(url).pathname;
  const slug=decodeURIComponent(pathname.split("/").pop()||"").replace(/\+/g," ");
  const m=slug.match(/^used-Waxahachie-(\d{4})-([^-]+)-(.+)-([A-HJ-NPR-Z0-9]{17})$/i);
  if(!m) return {url};
  const year=Number(m[1]);
  const make=m[2].replace(/%20/g," ");
  const rest=m[3].replace(/-/g," ");
  const vin=m[4];
  return {url,year,make,slugModel:rest,vin};
}


async function imageExists(url){
  try{
    let r=await fetch(url,{
      method:"HEAD",
      headers:{"user-agent":"Mozilla/5.0 (compatible; MarcellInventorySync/1.0)"},
      redirect:"follow"
    });
    if(r.ok){
      const ct=(r.headers.get("content-type")||"").toLowerCase();
      return !ct || ct.startsWith("image/");
    }
    if(r.status===405){
      r=await fetch(url,{
        method:"GET",
        headers:{
          "user-agent":"Mozilla/5.0 (compatible; MarcellInventorySync/1.0)",
          "range":"bytes=0-0"
        },
        redirect:"follow"
      });
      const ct=(r.headers.get("content-type")||"").toLowerCase();
      return r.ok && (!ct || ct.startsWith("image/"));
    }
  }catch{}
  return false;
}

async function discoverNumberedGallery(images){
  const existing=unique(images||[]);
  const primary=existing.find(u=>/\/inventoryphotos\/.+\/ip\/\d+\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(u));
  if(!primary) return existing;

  let parsed;
  try{ parsed=new URL(primary); }catch{ return existing; }

  const m=parsed.pathname.match(/^(.*\/ip\/)(\d+)(\.(?:jpe?g|png|webp))$/i);
  if(!m) return existing;

  const prefix=`${parsed.origin}${m[1]}`;
  const ext=m[3];
  const found=new Map();

  for(const u of existing){
    const n=u.match(/\/ip\/(\d+)\.(?:jpe?g|png|webp)(?:[?#]|$)/i);
    if(n) found.set(Number(n[1]),u);
  }

  let misses=0;
  for(let n=1;n<=100;n++){
    if(found.has(n)){ misses=0; continue; }
    const candidate=`${prefix}${n}${ext}`;
    if(await imageExists(candidate)){
      found.set(n,candidate);
      misses=0;
    }else{
      misses++;
      if(found.size>0 && misses>=3) break;
    }
  }

  return found.size
    ? [...found.entries()].sort((a,b)=>a[0]-b[0]).map(([,u])=>u)
    : existing;
}

function getJsonLd(html){
  const out=[];
  const rx=/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while((m=rx.exec(html))){
    try{
      const x=JSON.parse(m[1]);
      out.push(x);
    }catch{}
  }
  return out;
}

function flattenJson(value,out=[]){
  if(Array.isArray(value)) value.forEach(v=>flattenJson(v,out));
  else if(value && typeof value==="object"){
    out.push(value);
    Object.values(value).forEach(v=>flattenJson(v,out));
  }
  return out;
}

function imageCandidatesFromJson(html){
  const objs=flattenJson(getJsonLd(html));
  const imgs=[];
  for(const o of objs){
    const image=o.image;
    if(typeof image==="string") imgs.push(image);
    else if(Array.isArray(image)){
      image.forEach(x=>{
        if(typeof x==="string") imgs.push(x);
        else if(x?.url) imgs.push(x.url);
        else if(x?.contentUrl) imgs.push(x.contentUrl);
      });
    }else if(image?.url) imgs.push(image.url);
    else if(image?.contentUrl) imgs.push(image.contentUrl);
  }
  return imgs;
}

function extractImages(html,vin){
  const imgs=[...imageCandidatesFromJson(html)];

  const meta=[...html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/gi)];
  meta.forEach(m=>imgs.push(decode(m[1])));

  const attrs=[...html.matchAll(/\b(?:src|data-src|data-lazy|data-original|data-full|data-image|data-zoom-image)=["']([^"']+)["']/gi)];
  attrs.forEach(m=>imgs.push(decode(m[1])));

  const deescaped=html
    .replace(/\\\//g,"/")
    .replace(/\\u0026/gi,"&")
    .replace(/&amp;/g,"&");

  for(const m of deescaped.matchAll(/(?:https?:)?\/\/[^"'<>\\\s]+\/inventoryphotos\/[^"'<>\\\s]+/gi)){
    imgs.push(m[0].startsWith("//") ? `https:${m[0]}` : m[0]);
  }
  for(const m of deescaped.matchAll(/["'(=:\s]((?:\/)?inventoryphotos\/[^"'<>\\\s)]+)/gi)){
    imgs.push(new URL(m[1].startsWith("/") ? m[1] : `/${m[1]}`, BASE).href);
  }

  const bad=/logo|icon|sprite|favicon|pixel|dealeron|carfax|autocheck|loading|placeholder|transparent|award/i;
  const byKey=new Map();

  for(const raw of imgs){
    try{
      const u=new URL(String(raw).replace(/&amp;/g,"&"),BASE);
      if(!/^https?:$/i.test(u.protocol)) continue;
      if(bad.test(u.pathname)) continue;
      if(!(/\.(?:jpe?g|png|webp)$/i.test(u.pathname) || /image|photo|vehicle|inventory/i.test(u.pathname))) continue;
      const key=(u.origin+u.pathname).toLowerCase();
      if(!byKey.has(key)) byKey.set(key,u.href);
    }catch{}
  }

  const normalized=[...byKey.values()];
  const vinLower=String(vin||"").toLowerCase();

  const gallery=normalized.filter(u=>{
    const l=u.toLowerCase();
    return l.includes("/inventoryphotos/") && (!vinLower || l.includes(vinLower));
  });

  const photoNumber=u=>{
    const m=u.match(/\/ip\/(\d+)\.(?:jpe?g|png|webp)/i);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };

  if(gallery.length){
    gallery.sort((a,b)=>photoNumber(a)-photoNumber(b));
    return gallery;
  }

  const vinMatches=normalized.filter(u=>vinLower && u.toLowerCase().includes(vinLower));
  return vinMatches.length ? vinMatches : normalized;
}

function field(text,label,nextLabels=[]){
  const stop=nextLabels.length?`(?=${nextLabels.map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|")}|$)`:"$";
  const rx=new RegExp(`${label}\\s*:?\\s*(.+?)\\s*${stop}`,"i");
  const m=text.match(rx);
  return m?m[1].trim():null;
}

function parseVehicle(html,url,index){
  const summary=parseUrlSummary(url);
  const text=clean(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ")
  );

  const h1=html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title=clean(h1?.[1]||"") ||
    text.match(/\b(20\d{2}\s+[A-Za-z0-9 .&+\-]+\s+[A-Za-z0-9 .&+\-]+)\b/)?.[1] ||
    [summary.year,summary.make,summary.slugModel].filter(Boolean).join(" ");

  const tm=title.match(/^(20\d{2})\s+([^\s]+)\s+(.+)$/);
  const year=tm?Number(tm[1]):summary.year;
  const make=tm?tm[2]:summary.make;
  const model=tm?tm[3]:summary.slugModel;

  const price=num(text.match(/\$([\d,]+)\s+SELLING PRICE/i)?.[1]);
  const vin=(text.match(/\bVIN:\s*([A-HJ-NPR-Z0-9]{17})\b/i)?.[1]||summary.vin||"").toUpperCase() || null;
  const stock=text.match(/\bStock\s*#:\s*([A-Z0-9-]+)/i)?.[1] || null;
  const miles=num(text.match(/\bMileage\s+([\d,]+)/i)?.[1]);

  const body=field(text,"Body Style",["Exterior Color","Interior Color","Mileage","Engine"]);
  const exterior=field(text,"Exterior Color",["Interior Color","Mileage","Engine"]);
  const interior=field(text,"Interior Color",["Mileage","City/Highway","Engine"]);
  const engine=field(text,"Engine",["Transmission","Fuel Type","Highlighted Features","Dealer Comments"]);
  let transFull=field(text,"Transmission",["Fuel Type","Highlighted Features","Dealer Comments"]);
  let trans=transFull, drivetrain=null;
  if(transFull?.includes("/")){
    const parts=transFull.split("/").map(x=>x.trim()).filter(Boolean);
    trans=parts[0]||transFull;
    drivetrain=parts.slice(1).join(" / ")||null;
  }
  const fuel=field(text,"Fuel Type",["Highlighted Features","Dealer Comments","Eligible Benefits"]);

  const images=extractImages(html,vin);
  return {
    id:vin || `wax-${index+1}`,
    listed:99999-index,
    year,make,model,title,price,miles,
    trans,drivetrain,engine,fuel,body,exterior,interior,
    stock,vin,url,
    image:images[0]||"",
    images,
    badge:"Available"
  };
}

async function mapLimit(items,limit,fn){
  const results=new Array(items.length);
  let cursor=0;
  async function worker(){
    while(true){
      const i=cursor++;
      if(i>=items.length) return;
      try{ results[i]=await fn(items[i],i); }
      catch(e){
        console.error(`Failed ${items[i]}:`,e.message);
        results[i]={...parseUrlSummary(items[i]),id:`fallback-${i}`,listed:99999-i,title:null,images:[],image:"",badge:"Available"};
      }
      await sleep(90);
    }
  }
  await Promise.all(Array.from({length:limit},worker));
  return results;
}

const sitemap=await fetchText(SITEMAP);
const hrefs=[...sitemap.matchAll(/href=["']([^"']*\/used-Waxahachie-[^"']+)["']/gi)]
  .map(m=>new URL(decode(m[1]),BASE).href.replace(/\s/g,"%20"));
const urls=unique(hrefs);

if(!urls.length){
  throw new Error("No used-vehicle URLs found in Waxahachie Autoplex sitemap.");
}

console.log(`Found ${urls.length} vehicle pages. Fetching details...`);
const vehicles=await mapLimit(urls,8,async(url,i)=>{
  const html=await fetchText(url);
  const v=parseVehicle(html,url,i);

  if((v.images?.length||0)<=1){
    v.images=await discoverNumberedGallery(v.images||[]);
    v.image=v.images[0]||v.image||"";
  }

  console.log(`${i+1}/${urls.length} ${v.title||v.vin||url} — ${v.images?.length||0} photos`);
  return v;
});

const cleaned=vehicles
  .filter(v=>v && (v.title || v.vin || v.url))
  .map((v,i)=>({...v,listed:vehicles.length-i}));

const payload={
  updatedAt:new Date().toISOString(),
  source:SITEMAP,
  count:cleaned.length,
  vehicles:cleaned
};

await fs.writeFile(OUT,JSON.stringify(payload,null,2));
console.log(`Wrote ${cleaned.length} vehicles to inventory.json`);

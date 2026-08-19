import fs from "node:fs/promises";
const data=JSON.parse(await fs.readFile(new URL("../inventory.json",import.meta.url),"utf8"));
const vehicles=data.vehicles||[];
const counts=vehicles.map(v=>({title:v.title,vin:v.vin,photos:(v.images||[]).length}));
console.log(`Vehicles: ${vehicles.length}`);
console.log(`With multiple photos: ${counts.filter(x=>x.photos>1).length}`);
console.log(`With one photo: ${counts.filter(x=>x.photos===1).length}`);
console.log(`With zero photos: ${counts.filter(x=>x.photos===0).length}`);
counts.slice(0,25).forEach(x=>console.log(`${x.photos}\t${x.vin||""}\t${x.title||""}`));

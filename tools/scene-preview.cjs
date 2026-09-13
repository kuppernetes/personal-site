// Render the actual material layer and sprite placement without browser/DOM.
// node tools/scene-preview.cjs [grid-width] [grid-height] [output.png] [idle-ticks]
// Sky is a flat preview backdrop; WebGL atmosphere and HTML are not captured.
const fs = require('node:fs');
const vm = require('node:vm');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const source = fs.readFileSync('index.html', 'utf8');
const W = +(process.argv[2] || 480), H = +(process.argv[3] || 250);
const ticks=+(process.argv[5]||0);
function between(a, b) {
  const start = source.indexOf(a), end = source.indexOf(b, start);
  assert(start >= 0 && end > start, a);
  return source.slice(start, end);
}
function fn(name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start >= 0, name);
  const lineEnd = source.indexOf('\n', start);
  return source.slice(start, source[lineEnd - 1] === '}' ? lineEnd : source.indexOf('\n}', start) + 2);
}
const ctx = vm.createContext({ performance, console });
vm.runInContext([
  `const W=${W},H=${H},VH=H,SCALE=4;let camY=0;
   const DEPTH_LAYOUT={bands:{surface:{top:0,bot:1}}};
   const CHROME_ROWS=17;function measureChromeRows(){}
   let seed=17;Math.random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
   function burnMask(){return false;}`,
  between('const EMPTY=0', '/* ═══ THE FRAME'),
  between('const ZONES=[', 'const CW=32'),
  between('const CW=32', '/* ═══════════════════════════════════════════════════════\n   COLORS'),
  between('const JITTER=', 'function matColor('),
  fn('matTexel'), fn('rockTexture'), fn('hash2i'),
  fn('hillNoise'), fn('putCell'),
  between('const SPRITE_MATS=', '// Stamp a sprite anchored so its bottom-left'),
  fn('spriteW'), fn('spriteH'), fn('meadowCottageX'), fn('meadowOakX'), fn('stampSprite'),
  between('function vnoise(', 'function spawnContent('),
  `const placements=[];const rawStamp=stampSprite;
   stampSprite=(name,x,y)=>{placements.push({name,x,y,w:spriteW(name),h:spriteH(name)});rawStamp(name,x,y);};
   spawnNaturalLandscape();
   const initial=grid.slice();
   wakeRect(0,0,W-1,H-1);
   for(let n=0;n<${ticks};n++){doSceneAmbient();simulate();updateChunks();}
   const retention=placements.map(p=>{
     let total=0,kept=0;
     const art=SPRITES[p.name];
     for(let y=0;y<p.h;y++)for(let x=0;x<art[y].length;x++){
       if(art[y][x]==='.')continue;
       const i=(p.y-p.h+1+y)*W+p.x+x;
       if(initial[i]===EMPTY)continue;total++;if(grid[i]===initial[i])kept++;
     }
     return {name:p.name,kept:Math.round(kept/Math.max(1,total)*100)};
   });
   globalThis.scene={grid,variant,placements,retention,matTexel,surf,RELIEF,EMPTY};`,
].join('\n'), ctx);
const scene = ctx.scene;
// Overlay sprites are a separate canvas in the site. Include the real chest
// renderer here so its scale and placement can be inspected against the grove.
vm.runInContext([
  'function dayFactor(){return 1;}function inWordmark(){return false;}let LW=0,LH=0,WW=0,WH=0,coreBuf=null,wideBuf=null;',
  between('const EVIL_CHEST_AT=','/* ── placement: the chest'),
  fn('evilSoilY'),fn('placeEvilChest'),
  `evilCtx={createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData(){}};
   placeEvilChest();drawEvilChest();
   globalThis.chest={x:evilSX,y:evilSY-EVIL_PAD,w:EVIL_W,footprint:evilChestWidth(),h:EVIL_BH,pixels:evilImg.data};`
].join('\n'),ctx);
const chest=ctx.chest;
assert(chest.x>=0&&chest.x+chest.footprint<=W,'Chest fits the viewport');
assert(scene.placements.some(p => p.name === 'cottage'), 'Cottage remains visible');
assert(scene.placements.some(p => p.name === 'oak'), 'Oak remains visible');
for (const p of scene.placements) {
  assert(p.x >= 0 && p.x + p.w <= W && p.y - p.h >= 0 && p.y < H, 'Placement bounds: ' + p.name);
}
const y0 = Math.max(0, Math.round(H * .74) - 34);
const y1 = Math.max(y0+1,H-17);
const scale = 4, width = W * scale, height = (y1 - y0) * scale;
const pixels = Buffer.alloc(width * height * 4), rgba = new Uint8ClampedArray(4);
for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) {
  const i = y * W + x, m = scene.grid[i];
  scene.matTexel(m, scene.variant[i], x, y, rgba, 0, scene.RELIEF[m] ? scene.surf(x,y,i) : 0);
  const alpha = rgba[3] / 255;
  const backdrop=y<Math.round(H*.74)?[151,185,198]:[48,38,33];
  const rgb = backdrop.map((c,k) => Math.round(rgba[k] * alpha + c * (1-alpha)));
  const cx=x-chest.x,cy=y-chest.y;
  if(cx>=0&&cx<chest.w&&cy>=0&&cy<chest.h){
    const j=(cy*chest.w+cx)*4,a=chest.pixels[j+3]/255;
    for(let k=0;k<3;k++)rgb[k]=Math.round(chest.pixels[j+k]*a+rgb[k]*(1-a));
  }
  for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
    const at = (((y-y0)*scale+dy)*width+x*scale+dx)*4;
    pixels[at]=rgb[0];pixels[at+1]=rgb[1];pixels[at+2]=rgb[2];pixels[at+3]=255;
  }
}
function crc(buf) { let c=0xffffffff;for(const b of buf){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0; }
function chunk(type,data) { const t=Buffer.from(type),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([len,t,data,sum]); }
const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
const scan=Buffer.alloc((width*4+1)*height);
for(let y=0;y<height;y++)pixels.copy(scan,y*(width*4+1)+1,y*width*4,(y+1)*width*4);
const dest=process.argv[4]||'tools/scene-preview.png';
fs.writeFileSync(dest,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]));
console.log(JSON.stringify({grid:[W,H],placements:scene.placements.map(p=>p.name),...(ticks?{ticks,changed:scene.retention.filter(p=>p.kept<100)}:{}),preview:dest}));
if(ticks)for(const p of scene.retention)assert(p.kept>=98,'Idle sprite lost pixels: '+p.name+' ('+p.kept+'% retained)');

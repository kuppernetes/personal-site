// Offline contact sheet of the site's actual material renderer and sprite data.
// Run: node tools/art-preview.cjs [output.png]
// This checks pixel assets, not browser compositing or DOM layout.
const fs = require('node:fs');
const vm = require('node:vm');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const source = fs.readFileSync('index.html', 'utf8');
for (const match of source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
  new vm.Script(match[1]);
}
function between(a, b) { return source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a))); }
function fn(name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start >= 0, name);
  const line = source.slice(start, source.indexOf('\n', start));
  return line.endsWith('}') ? line : source.slice(start, source.indexOf('\n}', start) + 2);
}
const ctx = vm.createContext({ console });
vm.runInContext([
  between('const EMPTY=0', '/* Variant bit'),
  'const W=360,VH=200,H=2000; let sunX=0,sunK=1; const artRGB=new Uint32Array(W*H);',
  between('const ZONES=[', 'let grid,variant'),
  'let depthArt=Array.from({length:H},(_,y)=>typeof UNDERGROUND_PALETTE!=="undefined"&&y>=VH*1.05?UNDERGROUND_PALETTE[zoneAt(y).id]:null);',
  between('const JITTER=', '/* ═══ SURFACE MASK'),
  between('const S_UP=', 'function surf('),
  between('const RELIEF=', '/* ═══ THE SUN'),
  between('const SHADE=', 'function matColor('),
  between('const SPRITE_MATS=', '// ─── SPRITES'),
  between('const SPRITES=', '/* ═══════════════════════════════════════════════════════\n   SPECTACLES'),
  fn('hash2i'), fn('matTexel'),
  source.includes('function rockTexture(') ? fn('rockTexture') : '',
  'globalThis.art={SPRITES,SPRITE_MATS,matTexel,STONE,DIRT,BRICK,WOOD,S_DEEP,S_SPRITE};'
].join('\n'), ctx);
const a=ctx.art,projectArt=process.argv.includes('--projects');
// Underground props must not pick up a world-anchored checker/grout pattern.
assert(source.includes('float ud=0.5;'),'Underground dithering must remain disabled');
assert(source.includes('float levels=mix(7.0,31.0,ugK);'),'Keep fine, hue-preserving underground light steps');
for(const material of [a.WOOD,a.BRICK]){
  const colors=[];
  for(let y=950;y<958;y++)for(let x=10;x<22;x++){
    const out=new Uint8ClampedArray(4);a.matTexel(material,0,x,y,out,0,a.S_SPRITE);colors.push([...out].join(','));
  }
  assert.equal(new Set(colors).size,1,'Hand-shaded underground props should retain a clean, authored face');
}
const names=projectArt?['spatialCube','speechPair','agentBot','catGladiator','flytrap','larpMushroom','hactor','songbirdSax','hoverstaff']:
  ['sarcophagus','candelabra','urn','console','cylinder','crates','cabinet','lowboy','vending','lectern','bookstack'];
// Exercise the actual emitter scan with an isolated glass pixel. The GPU
// upload and blur are stubbed; the source selection and day/depth logic are real.
vm.runInContext(`
  let grid=new Uint8Array(W*H),variant=new Uint8Array(W*H),frozen=new Uint8Array(W*H);
  const BIG=1e9,LW=Math.ceil(W/4),LH=Math.ceil(VH/4),WW=Math.ceil(W/16),WH=Math.ceil(VH/16);
  const EMIT=new Uint8Array(64),rcMinX=[],rcMinY=[],rcMaxX=[],rcMaxY=[];
  let edX0=BIG,edY0=BIG,edX1=-1,edY1=-1,emX0=BIG,emY0=BIG,emX1=-1,emY1=-1;
  let camY=0,camDirty=true,lightScanAll=1,lightHadEmitters=false,testDay=1;
  const coreF=Array.from({length:3},()=>new Float32Array(LW*LH));
  const wideF=Array.from({length:3},()=>new Float32Array(WW*WH));
  const tmpF=new Float32Array(LW*LH),tmpW=new Float32Array(WW*WH);
  const occRaw=new Float32Array(LW*LH),occBlur=new Float32Array(LW*LH),occTmp=new Float32Array(LW*LH);
  const coreBuf=new Uint8Array(LW*LH*4),wideBuf=new Uint8Array(WW*WH*4);
  const lightTexC={},lightTexW={},gl={activeTexture(){},bindTexture(){},texSubImage2D(){}};
  function dayFactor(){return testDay;}
  function occRebuild(){return false;}
  function blurL(){}
  ${fn('buildLight')}
  globalThis.scanGlass=(row,day,cellRow=row+30)=>{
    grid.fill(0);frozen.fill(0);coreBuf.fill(0);wideBuf.fill(0);
    camY=row;testDay=day;camDirty=true;lightScanAll=1;lightHadEmitters=false;
    const i=cellRow*W+30;grid[i]=GLASS;frozen[i]=1;
    buildLight();
    const rgb=[0,0,0];for(let i=0;i<coreBuf.length;i+=4)for(let c=0;c<3;c++)rgb[c]+=coreBuf[i+c];
    return rgb;
  };
`,ctx);
for(const row of [300,600,950,1300,1600]){
  const day=Array.from(ctx.scanGlass(row,1)),night=Array.from(ctx.scanGlass(row,0));
  assert(day.some(c=>c>0),`Underground glass must emit in daylight at row ${row}`);
  assert.deepEqual(day,night,`Underground lamp colour must be independent of the sun at row ${row}`);
}
assert.deepEqual(Array.from(ctx.scanGlass(0,1)),[0,0,0],'Surface glass stays unlit at noon');
assert(ctx.scanGlass(0,0).some(c=>c>0),'Surface glass lights at night');
assert(ctx.scanGlass(100,1,230).some(c=>c>0),'Underground glass lights while entering from the surface');
const roomArt=process.argv.includes('--rooms');
const width=roomArt?1500:990,height=roomArt?540:465,scale=3,pixels=Buffer.alloc(width*height*4);
function pixel(x,y,c) {
  if(x<0||y<0||x>=width||y>=height)return;
  const i=(y*width+x)*4; pixels[i]=c[0];pixels[i+1]=c[1];pixels[i+2]=c[2];pixels[i+3]=255;
}
for(let y=0;y<height;y++)for(let x=0;x<width;x++)pixel(x,y,[24,29,37]);
function cell(x,y,c) {for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++)pixel(x*scale+dx,y*scale+dy,c);}
const rgba=new Uint8ClampedArray(4);
const propRows=projectArt?[600,600,600,950,950,950,1300,1300,1600]:[600,600,600,950,950,300,1300,1300,1300,1600,1600];
names.forEach((name,i)=>{
  const sprite=a.SPRITES[name],ox=8+(i%6)*54,oy=8+Math.floor(i/6)*40;
  sprite.forEach((row,y)=>[...row].forEach((ch,x)=>{
    assert(Object.hasOwn(a.SPRITE_MATS,ch),`${name}: unknown material ${ch}`);
    const spec=a.SPRITE_MATS[ch];if(!spec)return;
    a.matTexel(spec.m,spec.v,x,propRows[i]+y,rgba,0,a.S_SPRITE);
    cell(ox+x,oy+y,rgba);
  }));
});
// Five columns: workshop, vaults, lab, arcade, core. Raw rock over soil.
[300,600,950,1300,1600].forEach((worldY,i)=>{
  for(let y=0;y<52;y++)for(let x=0;x<60;x++){
    const m=y<30?a.STONE:a.DIRT;
    a.matTexel(m,(x+y)%4,x,worldY+y,rgba,0,a.S_DEEP);
    cell(8+i*64+x,99+y,rgba);
  }
});
if(roomArt){
  vm.runInContext([
    'const idx=(x,y)=>y*W+x; function wakeRect(){} function pixDirtyRect(){}',
    between('const PANEL_FRAME=','// Each room is one working exhibit.'),
    between('const STRUCT_MAT=','/* \u2550\u2550\u2550 UNIT-SNAPPED MASONRY PAINTING'),
    ...['brickVariant','woodVariant','stoneVariant','bakeVariant','slab','stampSprite','spriteW','spriteH','specsArt','drawProjectScene'].map(fn),
    `globalThis.scene=(p,r)=>{grid.fill(0);variant.fill(0);frozen.fill(0);drawProjectScene(p,r);return {grid,variant};};`
  ].join('\n'),ctx);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)pixel(x,y,[18,24,30]);
  const scenes=[['about','workshop','console',300],['imagine-together','crypt','spatialCube',600],
    ['snaptrap','lab','flytrap',950],['retrovirus-vr','arcade','hactor',1300],['nira','core','hoverstaff',1600]];
  const allScenes=[...scenes,['translation','crypt','speechPair',600],['agent-center','crypt','agentBot',600],
    ['catiator','lab','catGladiator',950],['larp','lab','larpMushroom',950],['songbird','arcade','songbirdSax',1300],
    ['education','core','bookstack',1600]];
  for(const [w,h] of [[53,61],[149,73],[92,144],[125,142]])for(const [id,zone,sprite,worldY] of allScenes){
    const r={x:10,y:worldY,w,h},s=ctx.scene({id,zone,sprite},r);
    for(let y=0;y<2000;y++)for(let x=0;x<360;x++)if(s.grid[y*360+x]){
      assert(x>=r.x&&x<r.x+r.w&&y>=r.y&&y<r.y+r.h,id+': scene escaped '+w+'x'+h+' footprint');
    }
  }
  console.log('All 11 scene selections stay in bounds at four narrow/wide diorama sizes.');
  scenes.forEach(([id,zone,sprite,worldY],k)=>{
    const r={x:10,y:worldY,w:92,h:144},s=ctx.scene({id,zone,sprite},r);
    for(let y=0;y<2000;y++)for(let x=0;x<360;x++){
      if(s.grid[y*360+x])assert(x>=r.x&&x<r.x+r.w&&y>=r.y&&y<r.y+r.h,id+': scene escaped its footprint');
    }
    for(let y=0;y<r.h;y++)for(let x=0;x<r.w;x++){
      const i=(worldY+y)*360+10+x,m=s.grid[i];if(!m)continue;
      a.matTexel(m,s.variant[i],10+x,worldY+y,rgba,0,a.S_SPRITE);
      cell(k*100+4+x,8+y,rgba);
    }
  });
  console.log('Five actual project scene builders rendered within their material footprints. Raw pixels only, not DOM or shader compositing.');
}
function crc(buf){let c=0xffffffff;for(const b of buf){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(type,data){const t=Buffer.from(type),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([len,t,data,sum]);}
const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
const scan=Buffer.alloc((width*4+1)*height);for(let y=0;y<height;y++)pixels.copy(scan,y*(width*4+1)+1,y*width*4,(y+1)*width*4);
const dest=process.argv[2]||'art-preview.png';
fs.writeFileSync(dest,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]));
console.log(`Passed script syntax, ${names.length} sprite palettes, five zones of day/night lighting, and surface lighting; wrote ${dest}`);

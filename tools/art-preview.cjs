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
// The world is one screenful, so W/VH/H here are what the real grid looks like:
// H === VH, and every row the shader can reach is a row this tool can reach.
const W = 360, VH = 200, H = 200;
const ctx = vm.createContext({ console });
vm.runInContext([
  between('const EMPTY=0', '/* Variant bit'),
  `const W=${W},VH=${VH},H=${H}; let sunX=0,sunK=1; const artRGB=new Uint32Array(W*H);`,
  between('const ZONES=[', 'let grid,variant'),
  'let depthArt=new Array(H).fill(null);',
  between('const JITTER=', '/* ═══ SURFACE MASK'),
  between('const S_UP=', 'function surf('),
  between('const RELIEF=', '/* ═══ THE SUN'),
  between('const SHADE=', 'function matColor('),
  between('const SPRITE_MATS=', '// ─── SPRITES'),
  between('const SPRITES=', '// Stamp a sprite anchored so its bottom-left'),
  fn('hash2i'), fn('matTexel'),
  source.includes('function rockTexture(') ? fn('rockTexture') : '',
  'globalThis.art={SPRITES,SPRITE_MATS,matTexel,STONE,DIRT,BRICK,WOOD,S_DEEP,S_SPRITE};'
].join('\n'), ctx);
const a = ctx.art;
/* ugK is not dead with the descent gone: it ramps in over the bottom ~14% of
   the frame, which is the meadow's own subsoil. These two lines are what keep
   that band from dithering against a world-anchored grid and from posterizing
   into flat steps, and they are the reason the berm reads as earth. */
assert(source.includes('float ud=0.5;'), 'Underground dithering must remain disabled');
assert(source.includes('float levels=mix(7.0,31.0,ugK);'), 'Keep fine, hue-preserving underground light steps');
/* There was a third assertion here: that a sprite's WOOD or BRICK cell comes
   out one flat authored colour. That was an UNDERGROUND property — it held
   because depthArt short-circuits the relief and jitter for a buried row, and
   on the meadow those are exactly what is wanted. It went with the descent
   rather than being weakened into something that would pass. */
// Every sprite the meadow actually stands up, in the order it is placed.
const names = ['cottage', 'turbine', 'signpost', 'greenhouse', 'archway', 'solarpanel',
  'oak', 'pine', 'smallpine', 'rock', 'cattail', 'mushroom', 'bush', 'flower',
  'fence', 'well'];
// Exercise the actual emitter scan with an isolated glass pixel. The GPU
// upload and blur are stubbed; the source selection and day logic are real.
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
  globalThis.scanGlass=(day,cellRow=30)=>{
    grid.fill(0);frozen.fill(0);coreBuf.fill(0);wideBuf.fill(0);
    testDay=day;camDirty=true;lightScanAll=1;lightHadEmitters=false;
    const i=cellRow*W+30;grid[i]=GLASS;frozen[i]=1;
    buildLight();
    const rgb=[0,0,0];for(let i=0;i<coreBuf.length;i+=4)for(let c=0;c<3;c++)rgb[c]+=coreBuf[i+c];
    return rgb;
  };
`, ctx);
/* Glass is a lamp with a clock on it: dark while the sun is up, lit once it
   is not. buildLight used to grant a second exemption for anything below the
   first screenful — a lamp down the shaft is on at noon — and with no world
   below the first screenful that branch is now unreachable by construction,
   which is what these two lines assert between them. */
assert.deepEqual(Array.from(ctx.scanGlass(1)), [0, 0, 0], 'Glass stays unlit at noon');
assert(ctx.scanGlass(0).some(c => c > 0), 'Glass lights at night');
assert.deepEqual(Array.from(ctx.scanGlass(1, Math.round(VH * 0.97))), [0, 0, 0],
  'Glass buried in the berm is still surface glass');

const width = 990, height = 560, scale = 3, pixels = Buffer.alloc(width * height * 4);
function pixel(x, y, c) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const i = (y * width + x) * 4; pixels[i] = c[0]; pixels[i + 1] = c[1]; pixels[i + 2] = c[2]; pixels[i + 3] = 255;
}
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixel(x, y, [24, 29, 37]);
function cell(x, y, c) { for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) pixel(x * scale + dx, y * scale + dy, c); }
const rgba = new Uint8ClampedArray(4);
// Sprites stand ON the meadow, so they are textured from the rows they stand at.
const spriteRow = Math.round(VH * 0.9);
names.forEach((name, i) => {
  const sprite = a.SPRITES[name];
  assert(sprite, `${name}: no such sprite`);
  const ox = 8 + (i % 6) * 54, oy = 8 + Math.floor(i / 6) * 40;
  sprite.forEach((row, y) => [...row].forEach((ch, x) => {
    assert(Object.hasOwn(a.SPRITE_MATS, ch), `${name}: unknown material ${ch}`);
    const spec = a.SPRITE_MATS[ch]; if (!spec) return;
    a.matTexel(spec.m, spec.v, x, spriteRow + y, rgba, 0, a.S_SPRITE);
    cell(ox + x, oy + y, rgba);
  }));
});
// The ground under all of it: raw rock over soil, at the depths it is dug from.
[Math.round(VH * 0.93), Math.round(VH * 0.97)].forEach((worldY, i) => {
  for (let y = 0; y < 52; y++) for (let x = 0; x < 60; x++) {
    const m = y < 30 ? a.STONE : a.DIRT;
    a.matTexel(m, (x + y) % 4, x, worldY + y, rgba, 0, a.S_DEEP);
    cell(8 + i * 64 + x, 128 + y, rgba);
  }
});
function crc(buf) { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const t = Buffer.from(type), len = Buffer.alloc(4), sum = Buffer.alloc(4); len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, sum]); }
const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
const scan = Buffer.alloc((width * 4 + 1) * height); for (let y = 0; y < height; y++) pixels.copy(scan, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
const dest = process.argv[2] || 'art-preview.png';
fs.writeFileSync(dest, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(scan)), chunk('IEND', Buffer.alloc(0))]));
console.log(`Passed script syntax, ${names.length} sprite palettes, and day/night surface lighting; wrote ${dest}`);

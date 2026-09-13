// Offline render of the actual chest, including its opening poses and lighting.
// Run: node tools/chest-preview.cjs [output.png] [grid-width]
// This does not capture browser compositing or DOM interaction.
const fs=require('node:fs'),vm=require('node:vm'),zlib=require('node:zlib');
const assert=require('node:assert/strict');
const source=fs.readFileSync('index.html','utf8');
const gridWidth=+(process.argv[3]||360);
function between(a,b){const s=source.indexOf(a),e=source.indexOf(b,s);assert(s>=0&&e>s,a);return source.slice(s,e);}
function fn(name){const s=source.indexOf('function '+name+'('),e=source.indexOf('\n',s);assert(s>=0,name);return source.slice(s,source[e-1]==='}'?e:source.indexOf('\n}',s)+2);}
const ctx=vm.createContext({console});
vm.runInContext([
  between('const EMPTY=0','/* Variant bit'),
  `const W=${gridWidth},H=200,VH=H;let camY=0,sunX=0,sunK=1,testDay=1;const artRGB=new Uint32Array(W*H);function dayFactor(){return testDay;}`,
  between('const ZONES=[','let grid,variant'),
  'let depthArt=new Array(H).fill(null);',
  between('const JITTER=','/* ═══ SURFACE MASK'),
  between('const S_UP=','function surf('),
  between('const RELIEF=','/* ═══ THE SUN'),
  between('const SHADE=','function matColor('),
  fn('hash2i'),fn('matTexel'),fn('rockTexture'),
  'let LW=90,LH=50,WW=23,WH=13;const coreBuf=new Uint8Array(LW*LH*4),wideBuf=new Uint8Array(WW*WH*4);',
  between('const EVIL_CHEST_AT=','/* ── placement: the chest'),
  fn('evilChestHit'),
  `evilCtx={createImageData:(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}),putImageData(){}};
   evilSX=W-EVIL_W;evilSY=150;
   globalThis.chest={w:EVIL_W,h:EVIL_BH,pad:EVIL_PAD,
     render(open,day,tick=0){evilOpenT=open;testDay=day;evilTick=tick;drawEvilChest();return {pixels:evilImg.data.slice(),materials:evilMat.slice()};},
     hit(x,y){return evilChestHit(evilSX+x,evilSY+y);}};`
].join('\n'),ctx);
const chest=ctx.chest,scale=6,gap=10,cols=4,rows=2;
const width=(chest.w+gap)*cols*scale,height=(chest.h+gap)*rows*scale;
const pixels=Buffer.alloc(width*height*4);
for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;pixels.set(y<height/2?[151,185,198,255]:[28,38,56,255],i);}
for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
  const open=[0,.3,.65,1][c],frame=chest.render(open,1-r),ox=(gap/2+c*(chest.w+gap))*scale,oy=(gap/2+r*(chest.h+gap))*scale;
  assert(frame.materials.some(Boolean),'Chest is not empty');
  assert(frame.pixels.some((v,i)=>i%4!==3&&v>0),'Chest retains colour');
  for(let y=0;y<chest.h;y++)for(let x=0;x<chest.w;x++){
    const i=(y*chest.w+x)*4;if(!frame.pixels[i+3])continue;
    for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++)pixels.set(frame.pixels.subarray(i,i+4),((oy+y*scale+dy)*width+ox+x*scale+dx)*4);
  }
}
function crc(buf){let c=0xffffffff;for(const b of buf){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(type,data){const t=Buffer.from(type),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([len,t,data,sum]);}
const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
const scan=Buffer.alloc((width*4+1)*height);for(let y=0;y<height;y++)pixels.copy(scan,y*(width*4+1)+1,y*width*4,(y+1)*width*4);
const dest=process.argv[2]||'tools/chest-preview.png';
fs.writeFileSync(dest,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]));
console.log('Rendered four chest poses in day and night: '+dest);

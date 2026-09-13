// Byte-level palette parity and deterministic CPU work checks. Run from personal-site:
// node tools/render-check.cjs
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('index.html','utf8');
function fn(name){
  const start=source.indexOf('function '+name+'(');
  assert(start>=0,name);
  const end=source.indexOf('\n}',start);
  if(name==='hash2i')return source.slice(start,source.indexOf('\n',start));
  return source.slice(start,end+2);
}
const enumStart=source.indexOf('const EMPTY=');
const materialIds=source.slice(enumStart).replace(/\/\/[^\n]*/g,'').split(';')[0]+';';
const palette=source.slice(source.indexOf('const JITTER='),source.indexOf('function matColor('));
const cache=source.slice(source.indexOf('const particleColors='),source.indexOf('/* ═══ THE WORLD\'S PALETTE'));
const context=vm.createContext({assert,performance});
vm.runInContext(`
${materialIds}
${palette}
${cache}
${fn('matTexel')}
${fn('rockTexture')}
${fn('hash2i')}
let W=96,H=96,grid=new Uint8Array(W*H),variant=new Uint8Array(W*H);
let texData=new Uint8Array(W*H*4),artRGB=new Uint32Array(W*H),depthArt=new Array(H).fill(null);
const art={rock:[65,80,95],earth:[93,71,48],cut:[110,120,135],wood:[90,65,40],brick:[120,90,60],glass:[80,130,160]};
const expected=new Uint8Array(4);
let checks=0,seed=1;
Math.random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
function check(x,y){
  const i=y*W+x,m=grid[i],dst=((H-1-y)*W+x)*4;
  const oldSeed=seed;
  matTexel(m,variant[i],x,y,expected,0,RELIEF[m]?surf(x,y,i):0);
  const expectedSeed=seed;seed=oldSeed;
  fillTexel(x,y);
  for(let c=0;c<4;c++)assert.equal(texData[dst+c],expected[c],'material '+m+', variant '+variant[i]+', at '+x+','+y+', channel '+c);
  assert.equal(seed,expectedSeed,'Flicker consumes the same random values');checks++;
}
for(const [sx,sk] of [[-1,0.45],[0,1],[1,0.8]]){
  sunX=sx;sunK=sk;prepareTexelCache();
  for(const underground of [false,true]){
    depthArt.fill(underground?art:null);
    for(const m of [SAND,WATER])for(let v=0;v<256;v++)for(let mask=0;mask<16;mask++){
      for(const [x,y] of [[12,12],[13,13],[10,14],[15,15]]){
        grid.fill(STONE);const i=y*W+x;grid[i]=m;variant[i]=v;
        if(mask&1)grid[i-W]=EMPTY;if(mask&2)grid[i+W]=EMPTY;
        if(mask&4)grid[i-1]=EMPTY;if(mask&8)grid[i+1]=EMPTY;
        check(x,y);
      }
    }
    for(let m=0;m<=63;m++)for(let v=0;v<256;v++){
      const x=10+v%17,y=10+(v*7)%19,i=y*W+x;
      grid[i]=m;variant[i]=v;artRGB[i]=0xa57639;check(x,y);
    }
  }
}
// Resizing must replace the packed view even if the sun has not changed.
texData=new Uint8Array(W*H*4);prepareTexelCache();grid[0]=SAND;check(0,0);
// Exercise caches across randomized material changes and a different buffer size.
W=480;H=270;grid=new Uint8Array(W*H);variant=new Uint8Array(W*H);
texData=new Uint8Array(W*H*4);depthArt=new Array(H).fill(null);artRGB=new Uint32Array(W*H);prepareTexelCache();
for(let i=0;i<grid.length;i++){grid[i]=i%5===0?EMPTY:i%3===0?WATER:SAND;variant[i]=i&7;}
function referenceFill(x,y){const i=y*W+x,m=grid[i];matTexel(m,variant[i],x,y,texData,((H-1-y)*W+x)*4,RELIEF[m]?surf(x,y,i):0);}
function time(fill){const t=performance.now();for(let n=0;n<15;n++)for(let y=0;y<H;y++)for(let x=0;x<W;x++)fill(x,y);return (performance.now()-t)/15;}
time(referenceFill);time(fillTexel);
const before=[],after=[];
for(let n=0;n<7;n++){before.push(time(referenceFill));after.push(time(fillTexel));}
before.sort((a,b)=>a-b);after.sort((a,b)=>a-b);
globalThis.result={checks,referenceMedianMs:before[3],cachedMedianMs:after[3],reductionPercent:100*(1-after[3]/before[3])};
`,context);
console.log(JSON.stringify(context.result,null,2));

// Apply actual texture uploads to a mock GPU. Compare every byte, including
// untouched neighbors, to catch an incorrect merged rectangle or unpack offset.
const W=95,H=140,VH=38,CW=32,ncx=Math.ceil(W/CW),BIG=1e9,n=ncx*Math.ceil(H/CW);
const rcMinX=new Int32Array(n).fill(BIG),rcMinY=new Int32Array(n).fill(BIG);
const rcMaxX=new Int32Array(n).fill(-1),rcMaxY=new Int32Array(n).fill(-1);
const texData=new Uint8Array(W*H*4).fill(55),gpu=texData.slice(),unpack={};
let uploads=0,pixels=0,fills=0,generation=1;
const gl=new Proxy({}, {get:(_,key)=>{
  if(key==='pixelStorei')return (name,value)=>{unpack[name]=value;};
  if(key==='texSubImage2D')return (target,level,dx,dy,width,height,format,type,data)=>{
    uploads++;pixels+=width*height;
    const stride=unpack.UNPACK_ROW_LENGTH||width;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<4;c++){
      const src=((y+(unpack.UNPACK_SKIP_ROWS||0))*stride+x+(unpack.UNPACK_SKIP_PIXELS||0))*4+c;
      gpu[((dy+y)*W+dx+x)*4+c]=data[src];
    }
  };
  return /^[A-Z_0-9]+$/.test(key)?key:()=>{};
}});
const renderContext=vm.createContext({W,H,VH,ncx,BIG,rcMinX,rcMinY,rcMaxX,rcMaxY,texData,gl,
  camY:0,updateSun(){},prepareTexelCache(){},dayFactor(){return 1;},
  fillTexel(x,y){const d=((H-1-y)*W+x)*4;texData.set([generation,x,y,255],d);fills++;},
  prog:0,vbuf:0,aloc:0,tex:0,uTimeLoc:0,gTime:0,uDayLoc:0,uGridLoc:0,
  TASKBAR_PX:30,SCALE:4,uCamLoc:0,uSunLoc:0,sunX:0,uParLoc:0,parX:0,uZoneColLoc:0,zoneColBuf:[],
  uZoneCol2Loc:0,zoneCol2Buf:[],uZoneTopLoc:0,zoneTopBuf:[],uZoneStyleLoc:0,
  zoneStyleBuf:[],uZoneFadeLoc:0,uZoneNLoc:0,ZMAX_JS:8,ZONES:[0],
  edX0:BIG,edY0:BIG,edX1:-1,edY1:-1});
vm.runInContext(fn('render'),renderContext);
function dirty(x0,y0,x1,y1){
  const c=Math.floor(y0/CW)*ncx+Math.floor(x0/CW);
  rcMinX[c]=x0;rcMinY[c]=y0;rcMaxX[c]=x1;rcMaxY[c]=y1;
}
function paint(){
  uploads=0;pixels=0;fills=0;renderContext.render();
  assert.deepEqual(gpu,texData,'All painted bytes reach the GPU; clean bytes stay unchanged');
  assert(pixels<=fills*1.5,'Merged uploads add at most 50% clean pixels');
  for(const key of ['UNPACK_ROW_LENGTH','UNPACK_SKIP_PIXELS','UNPACK_SKIP_ROWS'])assert.equal(unpack[key],0,'Reset '+key);
  generation++;
}
dirty(0,3,31,20);dirty(32,5,63,22);dirty(70,40,73,43);dirty(5,101,8,107);
paint();assert.equal(uploads,1,'Adjacent rectangles with different y extents merge');
assert.equal(rcMinX[3*ncx],5,'Offscreen dirt remains deferred');
paint();assert.equal(uploads,0,'Idle render does not upload deferred dirt');
dirty(2,7,4,9);dirty(80,7,85,10);paint();
assert.equal(uploads,2,'Nonadjacent dirty chunks do not bridge a skipped chunk');
renderContext.camY=38;paint();assert.equal(uploads,1,'Scrolling paints the newly visible dirty chunk');
renderContext.camY=H-VH;paint();assert.equal(uploads,1,'Deep deferred dirt becomes current on arrival');
dirty(0,99,31,120);dirty(32,97,63,118);dirty(64,101,94,121);paint();
assert.equal(uploads,1,'A partial right-edge chunk merges correctly');
console.log('Sparse upload, source offsets, camera deferral, and clean-neighbor checks passed.');

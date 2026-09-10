// Exact lighting regression: cropped kernels must match the full-field stencil,
// including reused scratch buffers, texture edges, moving lights and extinction.
// Run from any directory: node personal-site/tools/light-check.cjs
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function fn(name){
  const start=source.indexOf('function '+name+'(');
  assert(start>=0,name);
  return source.slice(start,source.indexOf('\n}',start)+2);
}
function referenceBlur(a,tmp,w,h){
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=y*w+x;
    tmp[i]=(a[y*w+Math.max(0,x-1)]+a[i]*1.1+a[y*w+Math.min(w-1,x+1)])/3.1;
  }
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=y*w+x;
    a[i]=(tmp[Math.max(0,y-1)*w+x]+tmp[i]*1.1+tmp[Math.min(h-1,y+1)*w+x])/3.1;
  }
}
let seed=781;
function random(){return ((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);}
const blurCtx=vm.createContext({});
vm.runInContext(fn('blurL'),blurCtx);
let blurCases=0;
for(const [w,h] of [[1,1],[1,17],[17,1],[17,13],[121,68],[241,136]]){
  for(let n=0;n<60;n++){
    const x0=(random()*w)|0,y0=(random()*h)|0;
    const x1=x0+((random()*(w-x0))|0),y1=y0+((random()*(h-y0))|0);
    const passes=3+n%2;
    const a=new Float32Array(w*h),tmp=new Float32Array(w*h).fill(73);
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)a[y*w+x]=random()*1.8;
    const expected=a.slice(),refTmp=new Float32Array(w*h);
    for(let p=0;p<passes;p++){
      blurCtx.blurL(a,tmp,w,h,Math.max(0,x0-passes),Math.max(0,y0-passes),Math.min(w-1,x1+passes),Math.min(h-1,y1+passes));
      referenceBlur(expected,refTmp,w,h);
      assert.deepEqual(a,expected,`Exact float field ${w}x${h}, rect ${n}, pass ${p}`);
    }
    blurCases++;
  }
}
function context(reference,W,VH){
  const ctx=vm.createContext({gl:new Proxy({}, {get:()=>()=>({})}),BufferCopy:a=>Array.from(a)});
  vm.runInContext(`
    const W=${W},VH=${VH},H=VH*3,BIG=1e9;
    const FIRE=3,FUSE=27,BOMB=28,ACID=6,GLASS=24,LAVA=10;
    let LW,LH,WW,WH,coreBuf,wideBuf,coreF,wideF,tmpF,tmpW,occRaw,occBlur,occTmp;
    const lightTexC={},lightTexW={},EMIT=new Uint8Array(256),OCC=new Uint8Array(256);
    for(const m of [FIRE,FUSE,BOMB,ACID,GLASS,LAVA])EMIT[m]=1;
    for(const m of [1,2,4,ACID,GLASS,LAVA])OCC[m]=1;
    const grid=new Uint8Array(W*H),frozen=new Uint8Array(W*H),variant=new Uint8Array(W*H),depthArt=[];
    const rcMinX=[],rcMinY=[],rcMaxX=[],rcMaxY=[];
    let emX0=BIG,emY0=BIG,emX1=-1,emY1=-1,edX0=BIG,edY0=BIG,edX1=-1,edY1=-1;
    let lightScanAll=1,lightHadEmitters=true,camY=0,camDirty=true,lightNightQ=-1,hoverCells=[];
    let testDay=0;
    function dayFactor(){return testDay;}
    ${fn('allocLight')}
    ${fn('occRebuild')}
    ${reference?referenceBlur.toString().replace('referenceBlur','blurL'):fn('blurL')}
    ${fn('buildLight')}
    allocLight();
    globalThis.state=()=>[coreBuf,wideBuf,occBlur,...coreF,...wideF].map(a=>BufferCopy(a));
    globalThis.change=(x,y,m)=>{
      const i=y*W+x;grid[i]=m;variant[i]=128;frozen[i]=1;
      edX0=Math.min(edX0,x);edY0=Math.min(edY0,y);edX1=Math.max(edX1,x);edY1=Math.max(edY1,y);
    };
  `,ctx);
  return ctx;
}
let frames=0;
for(const [W,VH] of [[1,1],[17,19],[480,270],[960,540]]){
  const actual=context(false,W,VH),expected=context(true,W,VH);
  function run(code){
    for(const ctx of [actual,expected])vm.runInContext(code+';buildLight();',ctx);
    assert.deepEqual(Array.from(actual.state()),Array.from(expected.state()),`Packed and float lighting at ${W}x${VH}, frame ${frames++}`);
  }
  run('');
  run(`change(0,0,FIRE);change(W-1,VH-1,LAVA)`);
  run('grid.fill(0);edX0=0;edY0=0;edX1=W-1;edY1=VH-1');
  for(let frame=0;frame<20;frame++){
    const changes=[];
    for(let n=0;n<30;n++)changes.push(`change(${(random()*W)|0},${(random()*VH)|0},${[0,1,2,3,6,10,24,27,28][(random()*9)|0]})`);
    run(changes.join(';'));
  }
  run('testDay=1');
  run('camY=VH;camDirty=true');
  run('change(0,camY,FIRE)');
  run('change(0,camY,0)');
  run('camY=0;camDirty=true;testDay=0');
  run('allocLight()');
}
console.log(JSON.stringify({blurCases,lightingFrames:frames,result:'Bit-identical full-field and cropped lighting, including stale scratch, edges, extinction, daylight, camera changes and reallocation.'},null,2));

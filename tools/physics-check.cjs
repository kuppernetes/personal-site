// Deterministic checks of the actual cellular rules, including random ordering.
// Run from personal-site: node tools/physics-check.cjs [reference-index.html]
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const source=fs.readFileSync('index.html','utf8');
function physicsSource(s){
  const material=s.slice(s.indexOf('const EMPTY=0'),s.indexOf('/* ═══ THE FRAME'));
  const arrays=s.slice(s.indexOf('let grid,variant'),s.indexOf('const CW=32'));
  const rules=s.slice(s.indexOf('const CW=32'),s.indexOf('\n}',s.indexOf('function simulate('))+2);
  return material+arrays+rules;
}
function world(s){
  const ctx=vm.createContext({performance});
  return vm.runInContext(`(()=>{
    let W=99,H=97,VH=97,camY=0;
    const ZONES=[],DEPTH_LAYOUT={bands:{}};
    let randomState=1,randomCalls=0,burns=[];
    Math.random=()=>{randomCalls++;randomState=(Math.imul(randomState,1664525)+1013904223)>>>0;return randomState/4294967296;};
    function burnMask(x,y,kind){burns.push([x,y,kind]);return false;}
    ${physicsSource(s)}
    function reset(scene,seed){
      randomState=seed;randomCalls=0;burns=[];frameId=1;chunks.length=0;allocArrays();allocChunks();
      for(let y=0;y<H;y++)for(let x=0;x<W;x++){
        const i=idx(x,y),r=Math.random();
        if(y>=H-3){grid[i]=STONE;continue;}
        if(scene==='sand'){
          if(y>8&&y<55&&r<0.6)grid[i]=SAND;
          else if(y>70&&r<0.5)grid[i]=WATER;
        }else if(scene==='acid'){
          if(y>10&&y<85&&r<0.65)grid[i]=[ACID,WATER,OIL,WOOD,BRICK,SAND,LEAF,MASK][(r*100)|0&7];
        }else{
          if(r<0.7)grid[i]=[SAND,WATER,WOOD,BRICK,PLANT,OIL,STONE,FIRE][(r*100)|0&7];
          variant[i]=(Math.random()*8)|0;
        }
      }
      if(scene==='blast')for(const [x,y] of [[0,0],[W-1,0],[0,H-4],[W-1,H-4],[32,32],[64,64]]){
        grid[idx(x,y)]=BOMB;variant[idx(x,y)]=0x80;
      }
      wakeRect(0,0,W-1,H-1);
    }
    function tick(n){for(let i=0;i<n;i++){simulate();updateChunks();}}
    function snapshot(){return {arrays:[grid,variant,frozen,updated,inChunk,dcMinX,dcMinY,dcMaxX,dcMaxY,dnMinX,dnMinY,dnMaxX,dnMaxY,rcMinX,rcMinY,rcMaxX,rcMaxY].map(a=>Array.from(a)),randomState,randomCalls,burns,chunks:chunks.map(c=>({...c,set:Array.from(c.set)}))};}
    function changedCheck(){
      const bounds=()=>JSON.stringify([dnMinX,dnMinY,dnMaxX,dnMaxY,rcMinX,rcMinY,rcMaxX,rcMaxY]);
      for(let y=-2;y<=H+1;y++)for(let x=-2;x<=W+1;x++){
        allocChunks();wakeRect(3,5,45,47);pixDirtyRect(55,59,90,80);
        wake3(x,y);pixDirty(x,y);const expected=bounds();
        allocChunks();wakeRect(3,5,45,47);pixDirtyRect(55,59,90,80);
        cellChanged(x,y);if(bounds()!==expected)throw Error('Changed bounds '+x+','+y);
      }
    }
    return {reset,tick,snapshot,changedCheck};
  })()
  `,ctx);
}
const actual=world(source);
actual.changedCheck();
const reference=process.argv[2]?world(fs.readFileSync(process.argv[2],'utf8')):null;
// Golden snapshots come from the pre-optimization rules, not this implementation.
// The two blast entries below were re-taken when PLANT grew VIGOUR — that scene
// is the only one of the three that seeds PLANT cells, and the growth rule no
// longer spends the same draws on the same ticks (a pond-deep drink no longer
// swallows the cell, and a spent cell no longer calls setMat at all). sand and
// acid are untouched and still hold their original hashes, which is the check
// that the edit stayed inside the plant path. blast/839 landed on the same
// hash as before.
const expected={
  'sand/1/20':'8023733624cd8f773ecb3b28046048e78e928ef8c19dca6cd2a5b8ba4a5ce6eb',
  'sand/17/20':'0adf4d46861a3ef994d85b2ca92972d0c2e39cbf214fdd4e73cece1c268717ff',
  'sand/839/20':'14a1a012f3581e803e44752bed5c68aa327c1ff22e83627fd261d89f26133608',
  'acid/1/20':'aa395079328cfc3ae9229df727b35905b5c3101b313b404036cb5e07dcdd7d95',
  'acid/17/20':'f7e99b6b1d35b2d280b756ccfa30c5485f4e08f56cacf5074628e1c6d3aba829',
  'acid/839/20':'734acee96cdc632700fb88f39638964681b3f76c947316d67f8657face4fde10',
  'blast/1/20':'89fb30d923252ed16e0c1858f834b9df9ec106bc305a643d19aa0e2b29de4946',
  'blast/17/20':'28c4f3caa9f722b8303af17a7ba4876f89f5f8f68ff863f8c911050c7b18f72a',
  'blast/839/20':'f7519bf74c8e284043738aed986d0d3294d1e72a64c696d9704e2c0ec9eaacb1',
};
const results={};
for(const scene of ['sand','acid','blast'])for(const seed of [1,17,839]){
  actual.reset(scene,seed);if(reference)reference.reset(scene,seed);
  for(const ticks of [1,4,20]){
    actual.tick(ticks);if(reference)reference.tick(ticks);
    const state=actual.snapshot();
    if(reference)assert.deepEqual(JSON.parse(JSON.stringify(state)),JSON.parse(JSON.stringify(reference.snapshot())),`${scene}, seed ${seed}, +${ticks} steps`);
    const key=`${scene}/${seed}/${ticks}`;
    const hash=createHash('sha256').update(JSON.stringify(state)).digest('hex');
    results[key]=hash;
    if(expected[key])assert.equal(hash,expected[key],key);
  }
}
console.log('Physics mutation bounds and deterministic material scenarios pass.');
if(reference&&process.argv.includes('--benchmark')){
  function median(a){a.sort((a,b)=>a-b);return a[a.length>>1];}
  for(const scene of ['sand','acid','blast']){
    const times=[[],[]];
    for(let n=0;n<24;n++)for(const k of n&1?[1,0]:[0,1]){
      const w=k?actual:reference;w.reset(scene,839);
      const t0=performance.now();w.tick(scene==='blast'?1:25);
      const elapsed=performance.now()-t0;if(n>=8)times[k].push(elapsed);
    }
    const before=median(times[0]),after=median(times[1]);
    console.log(JSON.stringify({scene,beforeMs:before,afterMs:after,savingsPercent:100*(1-after/before)}));
  }
}

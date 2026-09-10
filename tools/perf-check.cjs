// Deterministic checks of the actual renderer/scheduler with GPU and DOM spies.
// These measure submitted work, not browser frame rate. Run: node tools/perf-check.cjs
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('index.html', 'utf8');
function fn(name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
for (const match of source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
new vm.Script(fs.readFileSync('robot.js', 'utf8'));
function checkRender(W, VH, H) {
  const BIG = 1e9, cols = Math.ceil(W / 32), rows = Math.ceil(H / 32);
  const rcMinX = [], rcMinY = [], rcMaxX = [], rcMaxY = [];
  function dirtyWorld() {
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const c = y * cols + x;
      rcMinX[c] = x * 32; rcMinY[c] = y * 32;
      rcMaxX[c] = Math.min(W - 1, x * 32 + 31); rcMaxY[c] = Math.min(H - 1, y * 32 + 31);
    }
  }
  dirtyWorld();
  let fills = 0, uploads = 0;
  const painted = new Uint8Array(W * H);
  const gl = new Proxy({}, { get: (_, key) => key === 'texSubImage2D' ?
    (target, level, x, y, width, height) => { uploads += width * height; } : () => {} });
  const ctx = vm.createContext({ W, VH, H, ncx: cols, camY: 0, BIG, rcMinX, rcMinY, rcMaxX, rcMaxY,
    gl, updateSun() {}, prepareTexelCache() {}, dayFactor() { return 1; },
    fillTexel(x, y) { fills++; painted[y * W + x] = 1; },
    prog: 0, vbuf: 0, aloc: 0, tex: 0, texData: [],
    uTimeLoc: 0, gTime: 0, uDayLoc: 0, uGridLoc: 0, TASKBAR_PX: 30, SCALE: 4,
    uCamLoc: 0, uShaftLoc: 0, SHAFT: null, uZoneColLoc: 0, zoneColBuf: [],
    uZoneCol2Loc: 0, zoneCol2Buf: [], uZoneTopLoc: 0, zoneTopBuf: [], uZoneStyleLoc: 0,
    zoneStyleBuf: [], uZoneFadeLoc: 0, uZoneNLoc: 0, ZMAX_JS: 8, ZONES: [0],
    edX0: BIG, edY0: BIG, edX1: -1, edY1: -1 });
  vm.runInContext(fn('render'), ctx);
  ctx.render();
  const firstFills = fills;
  assert.equal(fills, uploads, 'Every painted rectangle is uploaded');
  assert(firstFills <= W * (VH + 33), 'Only visible chunks and the sampling margin are painted');
  assert(rcMinX.some(x => x !== BIG), 'Offscreen dirt remains pending');
  ctx.render();
  assert.equal(fills, firstFills, 'Idle frames do not repaint deferred chunks');
  // Jump around, then sweep every row: arriving terrain must be current before drawing.
  for (const y of [H - VH, Math.floor(H / 2), 0, ...Array.from({ length: Math.ceil(H / VH) }, (_, i) => Math.min(H - VH, i * VH))]) {
    ctx.camY = y; ctx.render();
    for (let row = y; row < y + VH; row++) for (let x = 0; x < W; x++) {
      assert.equal(painted[row * W + x], 1, `Missing visible texel ${x},${row}`);
    }
  }
  assert.equal(painted.reduce((n, p) => n + p, 0), W * H, 'The entire world becomes paintable');
  // A global sun/material invalidation must also survive while outside the camera.
  ctx.camY = 0; dirtyWorld(); painted.fill(0); ctx.render();
  ctx.camY = H - VH; ctx.render();
  assert.equal(painted[W * H - 1], 1, 'Offscreen invalidation is repainted when revisited');
  return { W, VH, H, fullWorldPixels: W * H, firstFramePixels: firstFills,
    reductionPercent: +(100 * (1 - firstFills / (W * H))).toFixed(1) };
}
const counts = [checkRender(480, 250, 2500), checkRender(90, 160, 4600)];

// Use the actual mask/hash/damage functions with DOM geometry spies. World
// surfaces move on screen when scrolling, but damage must stay on the same
// local pixel; floating windows instead change their world origin.
let maskRectReads = 0, canvasRectReads = 0;
const maskCtx = vm.createContext({});
const maskElements = Array.from({ length: 35 }, (_, i) => ({
  style: {}, dataset: {}, isConnected: true, worldTop: 400 + i * 30,
  getBoundingClientRect() {
    maskRectReads++;
    const top = (this.worldTop - maskCtx.camY) * 4;
    return { left: 40, top, right: 80, bottom: top + 80, width: 40, height: 80 };
  }
}));
Object.assign(maskCtx, { W: 100, H: 2000, SCALE: 4, camY: 250, BIG: 1e9,
  EMPTY: 0, MASK: 19, grid: new Uint8Array(200000), variant: new Uint8Array(200000),
  maskOwner: new Int16Array(200000), burnables: [], _stack: [], _stampSeq: 0,
  _winMaskCells: [], _winMaskRects: [], _winMaskHash: '',
  idx: (x, y) => y * 100 + x, pixDirtyRect() {}, wakeRect() {},
  reshape() { throw new Error('Unchanged dimensions must not reshape damage'); },
  document: { querySelectorAll: () => maskElements },
  canvas: { getBoundingClientRect() { canvasRectReads++; return { left: 0, top: 0 }; } }
});
vm.runInContext(['_windowRects', '_winsHash', 'updateWindowMasks', 'burnableFor', 'lcell', 'ownerBelow'].map(fn).join('\n'), maskCtx);
maskCtx.updateWindowMasks();
assert.equal(maskRectReads, 35, 'A changed mask pass measures each surface once');
assert.equal(canvasRectReads, 1, 'A changed mask pass measures the canvas once');
const maskHash = maskCtx._winMaskHash, maskStamp = maskCtx._stampSeq;
maskRectReads = 0; canvasRectReads = 0;
maskCtx.updateWindowMasks();
assert.equal(maskRectReads, 35, 'An unchanged check measures one snapshot');
assert.equal(canvasRectReads, 0, 'An unchanged hash skips stamping and canvas measurement');
assert.equal(maskCtx._stampSeq, maskStamp);
assert.equal(maskCtx._winsHash(), maskHash, 'The no-argument hash API is preserved');
const snapshot = maskCtx._windowRects();
maskRectReads = 0;
assert.equal(maskCtx._winsHash(snapshot), maskHash);
assert.equal(maskRectReads, 0, 'Hashing a supplied snapshot performs no extra DOM reads');
const burnPanel = maskElements[0]._burn, hitX = 12, hitY = 410;
const localHit = 10 * burnPanel.cw + 2;
assert.equal(maskCtx.lcell(burnPanel, hitX, hitY), localHit, 'Scrolled world hit maps to local row 10');
burnPanel.gone = 1; burnPanel.dmg[localHit] = 1;
maskCtx.grid[hitY * 100 + hitX] = 0;
maskCtx.camY = 290;
maskCtx.updateWindowMasks();
assert.equal(burnPanel.dy, 400 * 4, 'World panel origin stays fixed when the camera moves');
assert.equal(maskCtx.lcell(burnPanel, hitX, hitY), localHit);
assert.equal(maskCtx.grid[hitY * 100 + hitX], 0, 'The burned hole stays open after scrolling');
assert.equal(maskCtx.grid[(hitY + 1) * 100 + hitX], 19, 'Adjacent undamaged equipment remains solid');
const floating = { style: { zIndex: '5' }, dataset: {}, isConnected: true,
  getBoundingClientRect() {
    maskRectReads++;
    return { left: 40, top: 80, right: 80, bottom: 160, width: 40, height: 80 };
  } };
maskElements.push(floating);
maskCtx.updateWindowMasks();
const floatingHit = 5 * floating._burn.cw + 2;
assert.equal(maskCtx.lcell(floating._burn, 12, maskCtx.camY + 25), floatingHit);
maskCtx.camY = 310; maskCtx.updateWindowMasks();
assert.equal(maskCtx.lcell(floating._burn, 12, maskCtx.camY + 25), floatingHit,
  'A viewport-fixed window uses its new world origin after scrolling');
// The snapshot preserves original visibility and z-order behavior.
floating.style.zIndex = '9';
assert.notEqual(maskCtx._winsHash(), maskCtx._winMaskHash, 'Z-order changes invalidate the hash');
floating.style.display = 'none'; maskRectReads = 0;
maskCtx.updateWindowMasks();
assert.equal(maskRectReads, 35, 'Hidden windows are skipped before geometry reads');
assert.equal(maskCtx._stack.length, 35);

function checkBudget(cost, expected, physicsOn = true) {
  let now = 0, steps = 0;
  const ctx = vm.createContext({ gTime: 0, dayPhase: 0, DAY_PERIOD: 240, dayWarp: 0,
    lastSim: 0, simAcc: 0, frameNo: 0, physicsOn, simSpeed: 1, SIM_BUDGET_MS: 10,
    stepCostMs: 0.5, performance: { now: () => now }, painting: false, dragBody: null,
    simulate() { now += cost; steps++; }, requestAnimationFrame() {} });
  for (const name of ['buildLight', 'restampDOMMasks', 'updateWindowMasks', 'updateBodies',
    'restampBodies', 'updateSpriteBodies', 'doRain', 'doAmbient', 'updateChunks',
    'updateBoids', 'updateGhosts', 'updateCats', 'applyHoverFreeze', 'updateBurns',
    'renderAll', 'drawBirds', 'drawGhost', 'drawCats', 'updateEvil', 'flickerCaveLava']) ctx[name] = () => {};
  vm.runInContext(fn('loop'), ctx);
  ctx.loop(100);
  assert.equal(steps, expected, `${cost}ms steps, physics=${physicsOn}`);
}
checkBudget(12, 1); checkBudget(6, 1); checkBudget(5, 2); checkBudget(3, 3);
checkBudget(1, 4); checkBudget(1, 0, false);

// Compare batched wake regions with the original individual cell updates at
// chunk seams, partial edge chunks and coordinates outside the world.
const wakeCtx = vm.createContext({});
vm.runInContext(`
  const W=67,H=65,CW=32,ncx=Math.ceil(W/CW),BIG=1e9;
  const n=ncx*Math.ceil(H/CW);
  const dnMinX=new Int32Array(n),dnMinY=new Int32Array(n),dnMaxX=new Int32Array(n),dnMaxY=new Int32Array(n);
  ${fn('clearNext')}
  ${fn('wake')}
  ${fn('wakeRect')}
  ${fn('wake3')}
  function snapshot(){return [dnMinX,dnMinY,dnMaxX,dnMaxY].map(a=>Array.from(a));}
  function checkWake(x,y){
    clearNext();
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)wake(x+dx,y+dy);
    const expected=snapshot();clearNext();wake3(x,y);
    return [snapshot(),expected];
  }
`, wakeCtx);
for(let y=-2;y<=67;y++)for(let x=-2;x<=69;x++){
  const [actual,expected]=wakeCtx.checkWake(x,y);
  assert.deepEqual(actual,expected,`Wake neighbourhood at ${x},${y}`);
}

// Compare the optimized blur to the clamped stencil at edges and interiors.
const blurCtx=vm.createContext({});
vm.runInContext(fn('blurL'),blurCtx);
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
for(const [w,h] of [[1,1],[1,8],[8,1],[17,13],[121,68]]){
  const actual=Float32Array.from({length:w*h},(_,i)=>((i*37)%101)/31);
  const expected=actual.slice(),tmp=new Float32Array(w*h),refTmp=new Float32Array(w*h);
  for(let p=0;p<4;p++){
    blurCtx.blurL(actual,tmp,w,h);referenceBlur(expected,refTmp,w,h);
    assert.deepEqual(actual,expected,`Identical blur at ${w}x${h}, pass ${p}`);
  }
}

let lightAllocations = 0, lightUpdates = 0;
const lightGl = new Proxy({}, { get: (_, key) => {
  if (key === 'texImage2D') return () => { lightAllocations++; };
  if (key === 'texSubImage2D') return () => { lightUpdates++; };
  return () => {};
} });
const lightCtx = vm.createContext({ gl: lightGl });
vm.runInContext(`
  const W=64,VH=64,H=640,BIG=1e9;
  const FIRE=3,FUSE=27,BOMB=28,ACID=6,GLASS=24,LAVA=10;
  let LW,LH,WW,WH,coreBuf,wideBuf,coreF,wideF,tmpF,tmpW,occRaw,occBlur,occTmp;
  const lightTexC={},lightTexW={},EMIT=new Uint8Array(256),OCC=new Uint8Array(256);
  const grid=new Uint8Array(W*H),frozen=new Uint8Array(W*H),variant=new Uint8Array(W*H),depthArt=[];
  const rcMinX=[],rcMinY=[],rcMaxX=[],rcMaxY=[];
  let emX0=BIG,emY0=BIG,emX1=-1,emY1=-1,edX0=BIG,edY0=BIG,edX1=-1,edY1=-1;
  let lightScanAll=1,lightHadEmitters=true,camY=0,camDirty=true,lightNightQ=-1,hoverCells=[];
  let testDay=0;
  function dayFactor(){return testDay;}
  ${fn('allocLight')}
  ${fn('occRebuild')}
  ${fn('blurL')}
  ${fn('buildLight')}
  allocLight();
  grid[32*W+32]=GLASS;frozen[32*W+32]=1;
  for(let n=0;n<10;n++)buildLight();
`, lightCtx);
assert.equal(lightAllocations, 2, 'Two light textures allocated once');
assert.equal(lightUpdates, 2, 'A still scene builds the light once, then bails out');
// A repaint anywhere in the band has to bring the light buffers back with it.
vm.runInContext('for(let n=0;n<3;n++){edX0=30;edY0=30;edX1=34;edY1=34;buildLight();}', lightCtx);
assert.equal(lightUpdates, 8, 'Each repainted region rebuilds and re-uploads both textures');
vm.runInContext('allocLight();buildLight();', lightCtx);
assert.equal(lightAllocations, 4, 'Resize reallocates both light textures');

// Exercise extinction, moving shadows, dusk and a camera jump with the actual
// blur and texture data. Reusing a buffer must never leave old light behind.
vm.runInContext(`
  let rgbBlurs=0,aoBlurs=0;
  const actualBlur=blurL;
  blurL=function(a,tmp,w,h){if(a===occBlur)aoBlurs++;else rgbBlurs++;actualBlur(a,tmp,w,h);};
  OCC[1]=1;
  testDay=1;grid.fill(0);grid[32*W+32]=1;
  edX0=0;edY0=0;edX1=W-1;edY1=VH-1;buildLight();
  globalThis.lightState=()=>({rgbBlurs,aoBlurs,core:Array.from(coreBuf),wide:Array.from(wideBuf)});
`, lightCtx);
let lightState=lightCtx.lightState();
assert.equal(lightState.rgbBlurs,0,'Extinguished sources clear without blurring black channels');
assert.equal(lightState.aoBlurs,3,'Changed solids rebuild occlusion');
assert(lightState.core.some((v,i)=>i%4===3&&v>0),'A solid still casts occlusion');
assert(lightState.wide.every((v,i)=>i%4===3||v===0),'Last source clears the wide glow');
const darkUpdates=lightUpdates;
vm.runInContext('grid[32*W+32]=0;edX0=32;edY0=32;edX1=32;edY1=32;buildLight();',lightCtx);
assert.equal(lightUpdates,darkUpdates+1,'An unlit shadow update uploads only the core texture');
assert(lightCtx.lightState().core.every(v=>v===0),'Removing the solid clears its shadow');
vm.runInContext('for(let y=32;y<36;y++)for(let x=32;x<36;x++){grid[y*W+x]=GLASS;frozen[y*W+x]=1;}testDay=0;buildLight();',lightCtx);
lightState=lightCtx.lightState();
assert.equal(lightState.rgbBlurs,21,'Dusk restores both scales of glass light');
assert.equal(lightState.aoBlurs,6,'Changing only the light reuses blurred occlusion');
assert(lightState.wide.some((v,i)=>i%4!==3&&v>0),'Glass glow reaches the wide texture');
vm.runInContext('camY=200;camDirty=true;buildLight();',lightCtx);
assert(lightCtx.lightState().core.every(v=>v===0),'Camera jump clears offscreen light');

// Exercise the complete robot script and its observer callbacks. No shader/GPU
// behavior is emulated: only layout reads, draw requests, and scheduling count.
let rectReads = 0, draws = 0, nextId = 1, intersection, resizeObserver;
const frames = new Map(), windowEvents = {}, documentEvents = {};
const robotGl = new Proxy({}, { get: (_, key) => {
  if (key === 'getShaderParameter' || key === 'getProgramParameter') return () => true;
  if (key === 'drawArrays') return () => { draws++; };
  return () => ({});
} });
const canvas = { dataset: {}, style: {}, width: 0, height: 0, offsetParent: {},
  getContext: () => robotGl, getAttribute: () => null, addEventListener() {},
  getBoundingClientRect() { rectReads++; return { left: 0, top: 0, width: 200, height: 180 }; } };
class IntersectionObserver { constructor(cb) { intersection = cb; } observe() {} }
class ResizeObserver { constructor(cb) { resizeObserver = cb; } observe() {} }
const document = { hidden: false, readyState: 'complete', getElementById: () => canvas,
  addEventListener(name, cb) { documentEvents[name] = cb; } };
const window = { devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800,
  matchMedia: () => ({ matches: false }), IntersectionObserver, ResizeObserver,
  addEventListener(name, cb) { windowEvents[name] = cb; } };
const robotCtx = vm.createContext({ window, document, IntersectionObserver, ResizeObserver,
  performance: { now: () => 0 }, console,
  requestAnimationFrame(cb) { const id = nextId++; frames.set(id, cb); return id; },
  cancelAnimationFrame(id) { frames.delete(id); } });
vm.runInContext(fs.readFileSync('robot.js', 'utf8'), robotCtx);
function tick() { const pending = [...frames.values()]; frames.clear(); for (const cb of pending) cb(100); }
assert.equal(rectReads, 1, 'One startup size measurement');
for (let i = 0; i < 120; i++) tick();
assert.equal(draws, 120); assert.equal(rectReads, 1, 'Steady frames do not measure layout');
intersection([{ isIntersecting: false, intersectionRatio: 0 }]);
assert.equal(frames.size, 0, 'No animation callbacks remain while offscreen');
windowEvents.pointermove({ clientX: 12, clientY: 34 });
assert.equal(rectReads, 1, 'Invisible robot ignores pointer layout reads');
intersection([{ isIntersecting: true, intersectionRatio: 1 }]);
assert.equal(frames.size, 1, 'Returning to view schedules exactly one frame');
document.hidden = true; documentEvents.visibilitychange();
assert.equal(frames.size, 0, 'Background document cancels robot animation');
document.hidden = false; documentEvents.visibilitychange();
tick(); assert.equal(draws, 121, 'Animation resumes');
resizeObserver(); assert.equal(rectReads, 2, 'Panel resizing updates the buffer');
window.devicePixelRatio = 2; tick();
assert.equal(canvas.width, 400, 'Display scale changes resize the buffer');
console.log(JSON.stringify({ renderWork: counts, maskRectReadsPerChangedPass: 36,
  checks: 'Syntax, camera jumps, deferred invalidation, mask geometry reuse, scrolled burn locations, elapsed simulation budget, light texture reuse, robot visibility/resizing passed' }, null, 2));

// Actual room geometry and selection checks; not browser typography or FPS QA.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('index.html','utf8');
function between(a,b){const i=source.indexOf(a);return source.slice(i,source.indexOf(b,i));}
function fn(name){const start=source.indexOf('function '+name+'(');assert(start>=0,name);const line=source.slice(start,source.indexOf('\n',start));return line.endsWith('}')?line:source.slice(start,source.indexOf('\n}',start)+2);}
const ctx=vm.createContext({console});
vm.runInContext([
 'let W,VH,H,SCALE,DEPTH_LAYOUT;',
 between('const WORLD_PANELS=[','/* The sign over each room'),
 between('const ROOM_STORIES=','function placeRoomSurface('),
 ...['worldBands','shaftBand','exhibitBounds','roomMetrics','roomSignBand','roomProjectHTML'].map(fn),
 'globalThis.projects=WORLD_PANELS;globalThis.stories=PROJECT_STORIES;',
 `globalThis.layout=(width,height)=>{
  SCALE=Math.max(4,Math.round(Math.sqrt(width*height)/346));
  W=Math.floor(width/SCALE);VH=Math.floor(height/SCALE);DEPTH_LAYOUT=worldBands(width,height);
  H=Math.ceil(VH*DEPTH_LAYOUT.total);
  return Object.entries(DEPTH_LAYOUT.bands).filter(([id])=>id!=='surface').map(([id,b])=>{
   const bounds=exhibitBounds(W,SCALE),count=WORLD_PANELS.filter(p=>p.zone===id).length,m=roomMetrics(bounds.width,count);
   const ceil=Math.floor(b.top*VH)+Math.floor(VH*.18),floor=ceil+Math.ceil(b.minRoom/SCALE);
   const top=(roomSignBand(ceil).y1+6)*SCALE;
   const regions=[[0,0,bounds.width,m.header],[0,m.header+16,bounds.width,m.selector],
    [0,m.stageY,m.leftWidth,m.art],[0,m.stageY+m.art,m.leftWidth,m.caption],
    [m.monitorX,m.monitorY,m.rightWidth,m.monitor],
    ...[0,1,2].map(i=>{const w=m.narrow?bounds.width:(bounds.width-32)/3;
     return [m.narrow?0:i*(w+16),m.stepsY+(m.narrow?i*(m.stepHeight+16):0),w,m.stepHeight]})];
   return {id,bounds,m,regions,top,floor:floor*SCALE,worldWidth:W*SCALE,shaft:shaftBand().x1*SCALE};
  });
 };`
].join('\n'),ctx);
const dimensions=[[320,568],[390,844],[768,600],[800,600],[1024,768],[1280,720],[1440,900],[1920,1080],[2560,1440]];
for(const [width,height] of dimensions){
 const rooms=ctx.layout(width,height);
 for(const r of rooms){
  assert(r.top+r.m.height+32<=r.floor,width+'x'+height+': '+r.id+' exceeds its room');
  assert(r.bounds.x>r.shaft,'Sand shaft stays open');
  assert(r.bounds.x+r.bounds.width<=r.worldWidth);
  for(const [x,y,w,h] of r.regions){
   assert(w>190&&h>0,width+': readable region minimum');
   assert(x>=0&&y>=0&&x+w<=r.bounds.width+1&&y+h<=r.m.height+1);
  }
  for(let i=0;i<r.regions.length;i++)for(let j=i+1;j<r.regions.length;j++){
   const [x,y,w,h]=r.regions[i],[a,b,c,d]=r.regions[j];
   assert(!(x<a+c-.1&&x+w>a+.1&&y<b+d-.1&&y+h>b+.1),width+': '+r.id+' equipment overlaps');
  }
 }
 for(let i=1;i<rooms.length;i++)assert(rooms[i].top>rooms[i-1].floor);
}
const linked=new Set();
for(const p of ctx.projects){
 linked.add(p.id);for(const [id] of p.related||[])linked.add(id);
 assert(source.includes("'"+p.id+"': { title:")||source.includes(p.id+": { title:"),'Missing route '+p.id);
 if(p.thumb&&!p.thumb.startsWith('https:'))assert(fs.existsSync(p.thumb),'Missing image '+p.thumb);
 assert.equal(ctx.stories[p.id].steps.length,3);assert(ctx.roomProjectHTML(p).includes('#/'+p.id));
}
for(const id of ['imagine-together','translation','agent-center','ai-playground','ai-music-gen','rsg','snaptrap','catiator','intarnet','larp','retrovirus-vr','songbird','nira'])assert(linked.has(id),'Missing project '+id);
let redraws=0,markup='',selected=[];
const monitor={scrollTop:24,querySelector(){return {remove(){}}},insertAdjacentHTML(pos,html){markup=html},setAttribute(){}};
const cap={},steps=[{},{},{}],buttons=ctx.projects.filter(p=>p.zone==='lab').map(p=>({dataset:{project:p.id},setAttribute(k,v){selected.push([this.dataset.project,v])}}));
const section={dataset:{},_scene:{},querySelector(q){return q==='.room-monitor'?monitor:cap},
 querySelectorAll(q){return q.includes('room-step')?steps:buttons}};
ctx.drawProjectScene=()=>redraws++;
vm.runInContext('let _winMaskHash="old",lightScanAll=0;'+fn('selectRoomProject'),ctx);
for(const p of ctx.projects.filter(p=>p.zone==='lab')){
 selected=[];ctx.selectRoomProject(section,p);
 assert(markup.includes(p.name));assert(cap.innerHTML.includes(ctx.stories[p.id].caption));
 assert(steps.every(s=>s.innerHTML.includes('<h4>')));
 assert.equal(selected.filter(([,v])=>v==='true').length,1);assert.equal(section.dataset.project,p.id);
}
assert.equal(redraws,3);assert.equal(monitor.scrollTop,0);
console.log('Passed 9 viewport geometries, room/shaft separation, three live project selections, image paths, routes, and all 13 projects.');

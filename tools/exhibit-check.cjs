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
 ...['worldBands','shaftBand','exhibitBounds','roomMetrics','cardBox','roomSignBand','roomCardHTML','roomRecordHTML'].map(fn),
 'globalThis.projects=WORLD_PANELS;globalThis.stories=PROJECT_STORIES;',
 `globalThis.layout=(width,height)=>{
  SCALE=Math.max(4,Math.round(Math.sqrt(width*height)/346));
  W=Math.floor(width/SCALE);VH=Math.floor(height/SCALE);DEPTH_LAYOUT=worldBands(width,height);
  H=Math.ceil(VH*DEPTH_LAYOUT.total);
  return Object.entries(DEPTH_LAYOUT.bands).filter(([id])=>id!=='surface').map(([id,b])=>{
   const bounds=exhibitBounds(W,SCALE),count=WORLD_PANELS.filter(p=>p.zone===id).length,m=roomMetrics(bounds.width,count);
   const ceil=Math.floor(b.top*VH)+Math.floor(VH*.18),floor=ceil+Math.ceil(b.minRoom/SCALE);
   const top=(roomSignBand(ceil).y1+6)*SCALE;
   const regions=[[0,0,bounds.width,m.header],
    [0,m.stageY,m.leftWidth,m.art],[0,m.stageY+m.art,m.leftWidth,m.caption],
    ...Array.from({length:count},(_,i)=>{const b=cardBox(m,i);return [b.x,b.y,b.width,b.height]})];
   // The record is excluded from the overlap sweep on purpose: covering the
   // grid is its job. It must still fit the room and the carved bay.
   const record=[m.gridX,m.gridY,m.rightWidth,m.grid];
   return {id,count,bounds,m,regions,record,top,floor:floor*SCALE,worldWidth:W*SCALE,shaft:shaftBand().x1*SCALE};
  });
 };`
].join('\n'),ctx);
// worldBands hardcodes a per-room work count because it runs before
// WORLD_PANELS exists. Catch the two drifting apart.
{
 const literal=source.match(/for\(const \[id,count\] of (\[.*?\])\)/s)[1];
 for(const [id,count] of JSON.parse(literal.replace(/'/g,'"')))
  assert.equal(count,ctx.projects.filter(p=>p.zone===id).length,'worldBands count for '+id);
}
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
  // Every card is on screen at once: the grid must hold all of them.
  assert.equal(r.regions.length-3,r.count,width+': '+r.id+' shows every work');
  const [rx,ry,rw,rh]=r.record;
  assert(rw>190&&rh>0&&rx>=0&&ry>=0&&rx+rw<=r.bounds.width+1&&ry+rh<=r.m.height+1,
   width+': '+r.id+' record fits the room');
  // The record must cover the cards it replaces, or opening one would leave
  // the grid showing through around it.
  for(const [x,y,w,h] of r.regions.slice(3))
   assert(x>=rx-.1&&y>=ry-.1&&x+w<=rx+rw+.1&&y+h<=ry+rh+.1,width+': '+r.id+' record covers its grid');
 }
 for(let i=1;i<rooms.length;i++)assert(rooms[i].top>rooms[i-1].floor);
}
const linked=new Set();
for(const p of ctx.projects){
 linked.add(p.id);for(const [id] of p.related||[])linked.add(id);
 assert(source.includes("'"+p.id+"': { title:")||source.includes(p.id+": { title:"),'Missing route '+p.id);
 if(p.thumb&&!p.thumb.startsWith('https:'))assert(fs.existsSync(p.thumb),'Missing image '+p.thumb);
 assert.equal(ctx.stories[p.id].steps.length,3);
 assert(ctx.roomRecordHTML(p).includes('#/'+p.id));
 // The three instrument labels moved into the record.
 for(const st of ctx.stories[p.id].steps)assert(ctx.roomRecordHTML(p).includes(st[0]),'step in record '+p.id);
 assert(ctx.roomCardHTML(p,0).includes(p.name));
}
for(const id of ['imagine-together','translation','agent-center','ai-playground','ai-music-gen','rsg','snaptrap','catiator','intarnet','larp','retrovirus-vr','songbird','nira'])assert(linked.has(id),'Missing project '+id);
const works=ctx.projects.filter(p=>p.zone==='arcade');
let redraws=0,markup='',expanded=[];
const record={scrollTop:24,hidden:true,querySelector(){return {remove(){}}},
 insertAdjacentHTML(pos,html){markup=html},setAttribute(){}};
const cards=works.map(p=>({dataset:{project:p.id},setAttribute(k,v){expanded.push([this.dataset.project,v])}}));
const section={dataset:{zone:'arcade'},_scene:{},
 querySelector(q){return q==='.room-record'?record:null},querySelectorAll(){return cards}};
ctx.drawProjectScene=()=>redraws++;
ctx.WORLD_PANELS=ctx.projects;
let tickSyncs=0;ctx.syncDepthTicks=()=>tickSyncs++;
vm.runInContext(['let _winMaskHash="old",lightScanAll=0;',fn('openRoomRecord'),fn('closeRoomRecord')].join(String.fromCharCode(10)),ctx);

for(const p of works){
 expanded=[];record.hidden=true;
 ctx.openRoomRecord(section,p);
 assert(markup.includes(p.name),'record names '+p.id);
 assert(!record.hidden,'opening reveals the record');
 // Exactly one card reads as expanded; the rest report closed.
 assert.equal(expanded.filter(([,v])=>v==='true').length,1,'one card expanded');
 assert.equal(expanded.length,works.length,'every card gets a state');
 assert.equal(section.dataset.project,p.id);
}
assert.equal(redraws,works.length);assert.equal(record.scrollTop,0);
// Closing hides the record and hands the diorama back to the room.
expanded=[];ctx.closeRoomRecord(section);
assert(record.hidden,'closing hides the record');
assert.equal(section.dataset.project,'');
assert(expanded.every(([,v])=>v==='false'),'closing clears every card');
assert.equal(redraws,works.length+1,'closing redraws the room scene');
// The core sample's lit notch is driven from open/close, not the scroll sync.
assert.equal(tickSyncs,works.length+1,'open and close both republish the notches');
console.log('Passed 9 viewport geometries, room/shaft separation, all '+works.length+' works visible at once in the merged games room, record cover and collapse, image paths, routes, and all 13 projects.');

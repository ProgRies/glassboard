import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {createApp} from '../server.mjs';
import {makePatch} from '../public/merge.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t){const dataDir=await mkdtemp(join(tmpdir(),'glassboard-live-'));const server=await createApp({dataDir});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;const clients=[];
 t.after(async()=>{for(const c of clients)c.ws.terminate();await new Promise(r=>server.close(r));await rm(dataDir,{recursive:true,force:true})});
 const request=async(path,method='GET',body,headers={})=>{const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,data:r.status===204?null:await r.json()}};
 async function peer(board){const ws=new WebSocket(base.replace('http:','ws:')+'/api/live',{origin:base}),messages=[];ws.on('message',b=>messages.push(JSON.parse(b)));ws.on('error',()=>{});await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});const c={ws,messages,send:m=>ws.send(JSON.stringify(m)),wait:async predicate=>{for(let i=0;i<200;i++){const found=messages.find(predicate);if(found)return found;await delay(5)}throw Error('Timed out waiting for live message')}};clients.push(c);const hello=await c.wait(m=>m.type==='hello');c.id=hello.peer;c.send({type:'join',board});await c.wait(m=>m.type==='joined');return c}
 async function board(){const b={id:randomUUID(),title:'Live',items:[],view:{x:0,y:0,z:1}};return(await request('/api/boards/'+b.id,'PUT',{create:true,board:b})).data}
 return{base,request,peer,board};}
test('live stroke segments arrive before any save; only room peers receive them',async t=>{
 const f=await fixture(t),b=await f.board(),other=await f.board(),a=await f.peer(b.id),c=await f.peer(b.id),outsider=await f.peer(other.id);
 const stroke={id:randomUUID(),type:'pen',color:'#7187f3',width:3,points:[{x:0,y:0}]};const started=performance.now();a.send({type:'preview',op:'upsert',item:stroke});a.send({type:'preview',op:'append',id:stroke.id,index:1,points:[{x:10,y:20},{x:20,y:30}]});
 await c.wait(m=>m.op==='append');assert(performance.now()-started<1000);assert.equal((await f.request('/api/boards/'+b.id)).data.items.length,0,'Preview must not write an unfinished stroke');
 await delay(20);assert(!outsider.messages.some(m=>m.type==='preview'));const late=await f.peer(b.id);const append=await late.wait(m=>m.op==='append');assert.equal(append.points.length,2,'Mid-stroke join must catch up');
 a.send({type:'preview',op:'clear',id:stroke.id});await c.wait(m=>m.op==='clear');
});
test('saved object deltas push immediately, previews clear, deletes and disconnects notify peers',async t=>{
 const f=await fixture(t),b=await f.board(),a=await f.peer(b.id),c=await f.peer(b.id);const item={id:randomUUID(),type:'rect',x:1,y:2,w:30,h:40,color:'#303746',width:3};
 a.send({type:'preview',op:'upsert',item});await c.wait(m=>m.type==='preview');
 const result=await f.request('/api/boards/'+b.id,'PATCH',{baseRevision:b.revision,patch:makePatch(b,{...b,items:[item]})},{'X-Glassboard-Peer':a.id});assert.equal(result.status,200);const event=await c.wait(m=>m.type==='commit');assert.equal(event.source,a.id);assert.equal(event.put.length,1);assert.equal(event.revision,2);
 a.send({type:'cursor',x:123,y:456});assert.equal((await c.wait(m=>m.type==='cursor')).x,123);
 a.ws.close();await c.wait(m=>m.type==='peer-left');assert.equal((await f.request('/api/boards/'+b.id,'DELETE',undefined,{'If-Match':'2'})).status,204);await c.wait(m=>m.type==='deleted');
});
test('cross-origin upgrades and invalid canvas messages are rejected',async t=>{
 const f=await fixture(t),b=await f.board();const bad=new WebSocket(f.base.replace('http:','ws:')+'/api/live',{origin:'https://evil.example'});bad.on('error',()=>{});
 const status=await new Promise(r=>bad.once('unexpected-response',(_req,res)=>{res.resume();bad.terminate();r(res.statusCode)}));assert.equal(status,403);
 const a=await f.peer(b.id);const closed=new Promise(r=>a.ws.once('close',r));a.send({type:'preview',op:'upsert',item:{id:randomUUID(),type:'rect',x:'invalid',y:0,w:10,h:10}});assert.equal(await closed,1008);
});
test('object-only patches preserve concurrent changes and reject same-object conflicts',async t=>{
 const f=await fixture(t),b=await f.board(),a={id:randomUUID(),type:'rect',x:0,y:0,w:10,h:10},c={...a,id:randomUUID(),x:20};
 await f.request('/api/boards/'+b.id,'PATCH',{baseRevision:1,patch:makePatch(b,{...b,items:[a]})});
 const second=await f.request('/api/boards/'+b.id,'PATCH',{baseRevision:1,patch:makePatch(b,{...b,items:[c]})});assert.equal(second.status,200);assert.equal(second.data.board.items.length,2);
 const base=second.data.board;const one={...base,items:base.items.map(o=>o.id===a.id?{...o,x:100}:o)},two={...base,items:base.items.map(o=>o.id===a.id?{...o,x:200}:o)};
 assert.equal((await f.request('/api/boards/'+b.id,'PATCH',{baseRevision:base.revision,patch:makePatch(base,one)})).status,200);assert.equal((await f.request('/api/boards/'+b.id,'PATCH',{baseRevision:base.revision,patch:makePatch(base,two)})).status,409);
});

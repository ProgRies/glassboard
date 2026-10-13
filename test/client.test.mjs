import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {WebSocket} from 'ws';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, webcrypto } from 'node:crypto';
import { createApp } from '../server.mjs';
import { mergeSnapshots, equal, makePatch } from '../public/merge.mjs';

function storage() { const map=new Map();return {get length(){return map.size},key:i=>[...map.keys()][i],getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)}; }
async function client(url,live=false) {
 const nodes=new Map(),events=new Map();const context2d=new Proxy({measureText:()=>({width:10})},{get:(o,k)=>o[k]??(()=>{})});
 const element=(tag='div')=>({tagName:tag.toUpperCase(),style:{},value:'',textContent:'',className:'',classList:{add(){},remove(){},toggle(){},contains(){return false}},dataset:{},addEventListener(){},setAttribute(){},append(){},remove(){},focus(){},matches(){return false},click(){},getContext:()=>context2d,toDataURL:()=> 'data:image/webp;base64,AAAA',setPointerCapture(){}});
 const get=id=>{if(!nodes.has(id))nodes.set(id,element(['title','search'].includes(id)?'input':'div'));return nodes.get(id)};
 const document={getElementById:get,querySelectorAll:()=>[],createElement:element,body:element(),activeElement:element(),hidden:false,addEventListener:(k,f)=>events.set(k,f)};
 const timers=new Map();let next=0;
 const sandbox={console,document,innerWidth:1440,innerHeight:900,devicePixelRatio:1,location:{hash:'',pathname:'/',protocol:'http:',host:new URL(url).host},crypto:webcrypto,structuredClone,localStorage:storage(),sessionStorage:storage(),setTimeout:(f,ms)=>{const id=++next;timers.set(id,f);return id},clearTimeout:id=>timers.delete(id),setInterval:()=>{},requestAnimationFrame:()=>{},fetch:(path,options)=>fetch(url+path,options),Image:class {constructor(){this.complete=false}},Uint8Array};
 if(live)sandbox.WebSocket=WebSocket;
 sandbox.window={addEventListener:(k,f)=>events.set(k,f),history:{replaceState(){}}};
 const context=vm.createContext(sandbox);
 const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');const source=html.match(/<script type="module">([\s\S]*)<\/script>/)[1].replace(/import[^\n]+\n/,'');
 sandbox.equal=equal;sandbox.mergeSnapshots=mergeSnapshots;sandbox.makePatch=makePatch;vm.runInContext(source,context);
 await vm.runInContext('loadBoards()',context);
 return {run:code=>vm.runInContext(code,context),inject:(k,v)=>context[k]=structuredClone(v),nodes,storage:sandbox.localStorage};
}
async function fixture(t,live=false) {
 const dataDir=await mkdtemp(join(tmpdir(),'glassboard-client-'));const server=await createApp({dataDir});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dataDir,{recursive:true,force:true})});
 return {url,a:await client(url,live),b:await client(url,live)};
}
function initial() {return {id:randomUUID(),title:'Team',items:[0,1].map(i=>({id:randomUUID(),type:'rect',x:10+i*10,y:30,w:40,h:50,color:'#303746',width:3})),view:{x:0,y:0,z:1}};}
async function seed(f) {const input=initial();const r=await fetch(f.url+'/api/boards/'+input.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({create:true,board:input})});const board=await r.json();for(const c of [f.a,f.b]){c.inject('seed',board);c.run('activate(seed,seed)')}return board;}

test('two browser clients save independent edits, synchronize, and undo without erasing a peer',async t=>{
 const f=await fixture(t),board=await seed(f);
 f.a.run('checkpoint();items[0].x=101;changed()');await f.a.run('persist()');
 f.b.run('checkpoint();items[1].x=202;changed()');await f.b.run('persist()');
 assert.deepEqual(Array.from(f.b.run('items.map(o=>o.x)')),[101,202]);await f.a.run('poll()');
 assert.deepEqual(Array.from(f.a.run('items.map(o=>o.x)')),[101,202]);
 f.a.run('undo()');await f.a.run('persist()');const remote=await (await fetch(f.url+'/api/boards/'+board.id)).json();assert.deepEqual(remote.items.map(o=>o.x),[10,202]);
});
test('same object changes automatically create a recovery board in the second client',async t=>{
 const f=await fixture(t),board=await seed(f);
 f.a.run('checkpoint();items[0].x=111;changed()');await f.a.run('persist()');
 f.b.run('checkpoint();items[0].x=222;changed()');await f.b.run('persist()');
 assert.notEqual(f.b.run('current.id'),board.id);assert.match(f.b.run('current.title'),/recovered/);assert.equal(f.b.run('items[0].x'),222);
 const remote=await (await fetch(f.url+'/api/boards/'+board.id)).json();assert.equal(remote.items[0].x,111);
 assert.equal((await (await fetch(f.url+'/api/boards')).json()).length,2);
});
test('a lost save response is retried idempotently and later local edits remain pending',async t=>{
 const f=await fixture(t);await seed(f);f.a.run('checkpoint();items[0].x=9;changed()');
 f.a.run('const normalApi=api;let lostOnce=false;api=async (...args)=>{const result=await normalApi(...args);if(!lostOnce&&args[1]?.method==="PATCH"){lostOnce=true;throw Error("connection dropped after save")}return result}');
 await f.a.run('persist()');assert.equal(f.a.nodes.get('save').textContent,'Retry save');assert.equal(f.a.storage.length>0,true);
 await f.a.run('persist()');assert.equal(f.a.nodes.get('save').textContent,'Saved');assert.equal(f.a.run('hasChanges()'),false);
});

async function waitFor(predicate){for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5))}throw Error('Timed out waiting for live controller')}
test('live browser controllers render incremental strokes, cursors and commit deltas without a poll',async t=>{
 const f=await fixture(t,true);await waitFor(()=>f.a.run('socket?.readyState===1')&&f.b.run('socket?.readyState===1'));await seed(f);await waitFor(()=>f.a.run('roomPeers===2')&&f.b.run('roomPeers===2'));
 const stroke={id:randomUUID(),type:'pen',color:'#7187f3',width:3,points:[{x:1,y:1}]};f.a.inject('newStroke',stroke);f.a.run("checkpoint();items.push(newStroke);gesture={kind:'draw',item:newStroke};streamGesture(true)");
 await waitFor(()=>f.b.run('remotePreviews.size===1'));f.a.run('newStroke.points.push({x:22,y:33});streamGesture(true)');await waitFor(()=>f.b.run('[...remotePreviews.values()][0].item.points.length===2'));
 assert.equal(f.b.run('items.length'),2,'Unfinished stroke is a preview');f.a.run('liveSend({type:"cursor",x:70,y:80})');await waitFor(()=>f.b.run('remoteCursors.size===1'));
 f.a.run('gesture=null;changed()');await f.a.run('persist()');await waitFor(()=>f.b.run('items.length===3&&remotePreviews.size===0'));assert.equal(f.b.run('items.at(-1).points[1].y'),33);
});

test('a reconnected live controller clears previews and resynchronizes missed saved changes',async t=>{
 const f=await fixture(t,true);await waitFor(()=>f.a.run('socket?.readyState===1')&&f.b.run('socket?.readyState===1'));await seed(f);await waitFor(()=>f.a.run('roomPeers===2')&&f.b.run('roomPeers===2'));
 f.b.run('socket.close()');await waitFor(()=>f.b.run('socket.readyState===3'));f.a.run('checkpoint();items[0].x=777;changed()');await f.a.run('persist()');assert.equal(f.b.run('items[0].x'),10);
 f.b.run('connectLive()');await waitFor(()=>f.b.run('items[0].x===777'));assert.equal(f.b.run('remotePreviews.size'),0);
});

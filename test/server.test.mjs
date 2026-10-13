import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';
import { mergeSnapshots } from '../public/merge.mjs';
import vm from 'node:vm';

const rect = (id = randomUUID(), x = 10) => ({ id, type: 'rect', x, y: 20, w: 30, h: 40, color: '#303746', width: 3 });
const sample = () => ({ id: randomUUID(), title: 'Planning', items: [], view: {x:0,y:0,z:1}, thumb: '' });
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'glassboard-test-'));
  const server = await createApp({dataDir}); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let active = server;
  const url = () => 'http://127.0.0.1:'+active.address().port;
  const request = async (path, method='GET', body, headers={}) => {
    const r = await fetch(url()+path, {method,headers:{...(body?{'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:Buffer.isBuffer(body)?body:JSON.stringify(body)}:{})});
    return {status:r.status,headers:r.headers,data:r.status===204?null:await r.json().catch(()=>null)};
  };
  t.after(async()=>{await new Promise(resolve=>active.close(resolve));await rm(dataDir,{recursive:true,force:true})});
  return {request,dataDir,restart:async()=>{await new Promise(resolve=>active.close(resolve));active=await createApp({dataDir});await new Promise(resolve=>active.listen(0,'127.0.0.1',resolve))}};
}
async function create(request, b=sample()) { const r=await request('/api/boards/'+b.id,'PUT',{create:true,board:b});assert.equal(r.status,201);return r.data; }
const edit=(base,items,title=base.title)=>({baseRevision:base.revision,base:{title:base.title,items:base.items},board:{...base,title,items}});

test('no login; board creation, list, conditional polling and durable restart',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/health')).status,200);const b=await create(f.request);
 assert.equal((await f.request('/api/boards')).data.length,1);
 assert.equal((await f.request('/api/boards/'+b.id+'?revision=1')).status,204);
 await f.restart();assert.equal((await f.request('/api/boards/'+b.id)).data.title,'Planning');
 assert.equal((await f.request('/api/boards/'+b.id,'PUT',{create:true,board:b})).status,409);
});
test('simultaneous changes to different objects merge without lost updates',async t=>{
 const {request}=await fixture(t);const original=sample();original.items=[rect(),rect()];const b=await create(request,original);
 const left=structuredClone(b.items),right=structuredClone(b.items);left[0].x=100;right[1].x=200;
 const changes=await Promise.all([request('/api/boards/'+b.id,'PATCH',edit(b,left)),request('/api/boards/'+b.id,'PATCH',edit(b,right))]);
 assert.deepEqual(changes.map(x=>x.status),[200,200]);const saved=(await request('/api/boards/'+b.id)).data;
 assert.deepEqual(saved.items.map(x=>x.x),[100,200]);assert.equal(saved.revision,3);
});
test('simultaneous new drawings both survive, including idempotent retry',async t=>{
 const {request}=await fixture(t);const b=await create(request);const a=rect(),c=rect();
 await Promise.all([request('/api/boards/'+b.id,'PATCH',edit(b,[a])),request('/api/boards/'+b.id,'PATCH',edit(b,[c]))]);
 const retry=await request('/api/boards/'+b.id,'PATCH',edit(b,[a]));assert.equal(retry.status,200);assert.equal(retry.data.board.items.length,2);
});
test('same-object conflicts reject the complete change; recovered board retains both versions',async t=>{
 const {request}=await fixture(t);const original=sample();original.items=[rect()];const b=await create(request,original),a=structuredClone(b.items),c=structuredClone(b.items);a[0].x=90;c[0].x=180;
 assert.equal((await request('/api/boards/'+b.id,'PATCH',edit(b,a))).status,200);
 const response=await request('/api/boards/'+b.id,'PATCH',edit(b,c));assert.equal(response.status,409);assert.deepEqual(response.data.conflicts,[b.items[0].id]);assert.equal(response.data.board.items[0].x,90);
 const recovery=await create(request,{...b,id:randomUUID(),title:'Planning (recovered)',items:c});assert.equal(recovery.items[0].x,180);assert.equal((await request('/api/boards')).data.length,2);
});
test('delete and rename conflicts are guarded, stale edits do not resurrect deleted boards',async t=>{
 const {request}=await fixture(t);const b=await create(request);await request('/api/boards/'+b.id,'PATCH',edit(b,[rect()],'Renamed'));
 assert.equal((await request('/api/boards/'+b.id,'PATCH',edit(b,[],'Other name'))).status,409);
 assert.equal((await request('/api/boards/'+b.id,'DELETE',undefined,{'If-Match':'1'})).status,409);
 assert.equal((await request('/api/boards/'+b.id,'DELETE',undefined,{'If-Match':'2'})).status,204);
 assert.equal((await request('/api/boards/'+b.id,'PATCH',edit(b,[rect()]))).status,404);
});
test('image bytes survive restart; unsafe image formats, geometry and cross-origin writes rejected',async t=>{
 const f=await fixture(t);const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNc8AAAAASUVORK5CYII=','base64');
 const image=await f.request('/api/assets','POST',png,{'Content-Type':'image/png'});assert.equal(image.status,201);
 await f.restart();const disk=await readFile(join(f.dataDir,'assets',image.data.url.split('/').at(-1)));assert.deepEqual(disk,png);
 assert.equal((await f.request('/api/assets','POST',Buffer.from('not an image'),{'Content-Type':'image/png'})).status,415);
 assert.equal((await f.request('/api/assets','POST',Buffer.from('<svg/>'),{'Content-Type':'image/svg+xml'})).status,415);
 const b=sample();assert.equal((await f.request('/api/boards/'+b.id,'PUT',{create:true,board:b},{Origin:'https://evil.example'})).status,403);
 b.items=[{...rect(),x:'bad'}];assert.equal((await f.request('/api/boards/'+b.id,'PUT',{create:true,board:b})).status,400);
});
test('client merging and undo preserve a colleague’s objects',()=>{
 const a=rect(),c=rect();const empty={title:'Board',items:[]},mine={title:'Board',items:[a]},remote={title:'Board',items:[a,c]};
 assert.deepEqual(mergeSnapshots(mine,empty,remote).board.items,[c]);
 const edited=structuredClone(remote);edited.items[0].x=5;assert.equal(mergeSnapshots(mine,empty,edited).conflicts.length,1);
});
test('client script parses as a module',async()=>{
 const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');const source=html.match(/<script type="module">([\s\S]*)<\/script>/)[1];
 new vm.Script(source.replace(/import[^\n]+\n/,''));
 assert(!html.includes('Boards save privately to your account'));
});

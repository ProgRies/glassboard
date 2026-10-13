// Run against a locally built image; all containers/volumes use random names.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {WebSocket} from 'ws';
const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/smoke-container.mjs IMAGE');
const suffix = randomUUID(), name = 'glassboard-smoke-' + suffix, volume = name + '-data';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
let container;const liveClients=[];
async function launch() {
  container = docker('run','--detach','--rm','--name',name,'--publish','127.0.0.1::3000','--volume',volume+':/app/data',image);
  const port = docker('port',container,'3000/tcp').split(':').at(-1);
  const base = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let attempt=0;attempt<60;attempt++) {
    try { if ((await fetch(base+'/api/health')).ok) { ready=true;break; } } catch {}
    await new Promise(r=>setTimeout(r,500));
  }
  if (!ready) throw new Error('Container did not become healthy');
  return base;
}
try {
  docker('volume','create',volume);
  let base=await launch();
  assert.equal((await fetch(base)).status,200,'Homepage must not require login');
  assert.notEqual(docker('exec',container,'id','-u'),'0','Container must run without root');
  const id=randomUUID(),board={id,title:'Container smoke test',items:[],view:{x:0,y:0,z:1}};
  const created=await fetch(base+'/api/boards/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({create:true,board})});
  assert.equal(created.status,201);
  // Real WebSocket traffic through the published container port.
  async function livePeer(){const ws=new WebSocket(base.replace('http:','ws:')+'/api/live'),messages=[];liveClients.push(ws);ws.on('message',b=>messages.push(JSON.parse(b)));ws.on('error',()=>{});await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});ws.send(JSON.stringify({type:'join',board:id}));return{ws,messages}}
  const a=await livePeer(),b=await livePeer();
  for(let i=0;i<100&&!b.messages.some(m=>m.type==='joined');i++)await new Promise(r=>setTimeout(r,10));
  const stroke={id:randomUUID(),type:'pen',color:'#7187f3',width:3,points:[{x:1,y:1}]};
  a.ws.send(JSON.stringify({type:'preview',op:'upsert',item:stroke}));a.ws.send(JSON.stringify({type:'preview',op:'append',id:stroke.id,index:1,points:[{x:2,y:2}]}));
  for(let i=0;i<100&&!b.messages.some(m=>m.op==='append');i++)await new Promise(r=>setTimeout(r,10));
  assert(b.messages.some(m=>m.op==='append'),'WebSocket previews must pass through the container port');
  a.ws.close();b.ws.close();
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNc8AAAAASUVORK5CYII=','base64');
  const uploaded=await fetch(base+'/api/assets',{method:'POST',headers:{'Content-Type':'image/png'},body:png});assert.equal(uploaded.status,201);const asset=await uploaded.json();
  docker('stop',container);container=undefined;
  base=await launch();
  assert.equal((await (await fetch(base+'/api/boards/'+id)).json()).title,board.title,'Board must survive restart');
  assert.deepEqual(Buffer.from(await (await fetch(base+asset.url)).arrayBuffer()),png,'Image must survive restart');
  console.log('Container checks passed: no login, non-root, live WebSockets, board/image persistence across restart.');
} finally {
  for(const ws of liveClients)ws.terminate();
  if (container) { try { docker('rm','--force',container); } catch {} }
  try { docker('volume','rm',volume); } catch {}
}

// Run against a locally built image; all containers/volumes use random names.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/smoke-container.mjs IMAGE');
const suffix = randomUUID(), name = 'glassboard-smoke-' + suffix, volume = name + '-data';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
let container;
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
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNc8AAAAASUVORK5CYII=','base64');
  const uploaded=await fetch(base+'/api/assets',{method:'POST',headers:{'Content-Type':'image/png'},body:png});assert.equal(uploaded.status,201);const asset=await uploaded.json();
  docker('stop',container);container=undefined;
  base=await launch();
  assert.equal((await (await fetch(base+'/api/boards/'+id)).json()).title,board.title,'Board must survive restart');
  assert.deepEqual(Buffer.from(await (await fetch(base+asset.url)).arrayBuffer()),png,'Image must survive restart');
  console.log('Container checks passed: no login, non-root, board/image persistence across restart.');
} finally {
  if (container) { try { docker('rm','--force',container); } catch {} }
  try { docker('volume','rm',volume); } catch {}
}

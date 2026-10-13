import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { equal } from './public/merge.mjs';
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const point = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
const palette = ['#7187f3','#e47784','#68ad90','#e2aa4b','#ae7ade'];

// Volatile previews never write to disk; only validated HTTP commits are durable.
export function attachRealtime(server, { revision, validateItem }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128*1024, perMessageDeflate: false });
  const rooms = new Map(); let colorIndex = 0;
  function send(ws, value) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024*1024) { ws.terminate(); return; }
    ws.send(typeof value === 'string' ? value : JSON.stringify(value));
  }
  function roomSend(id, value, except) {
    const payload = JSON.stringify(value);
    for (const peer of rooms.get(id) || []) if (peer !== except) send(peer,payload);
  }
  function presence(id) {
    if (!id) return;
    roomSend(id,{type:'presence',board:id,peers:[...(rooms.get(id)||[])].map(ws=>({id:ws.peerId,color:ws.color}))});
  }
  function leave(ws) {
    const id=ws.board;if(!id)return;
    rooms.get(id)?.delete(ws);if(!rooms.get(id)?.size)rooms.delete(id);
    ws.board=null;ws.previews.clear();roomSend(id,{type:'peer-left',peer:ws.peerId});presence(id);
  }
  function sendPreview(target,source,item) {
    if(item.type==='pen') {
      send(target,{type:'preview',peer:source.peerId,op:'upsert',item:{...item,points:item.points.slice(0,1)}});
      for(let i=1;i<item.points.length;i+=800)send(target,{type:'preview',peer:source.peerId,op:'append',id:item.id,index:i,points:item.points.slice(i,i+800)});
    } else send(target,{type:'preview',peer:source.peerId,op:'upsert',item});
  }
  server.on('upgrade',(req,socket,head)=>{
    let valid=false;
    try { valid=new URL(req.url,'http://localhost').pathname==='/api/live' && (!req.headers.origin||new URL(req.headers.origin).host===req.headers.host); } catch {}
    if(!valid||wss.clients.size>=500){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
  });
  wss.on('connection',ws=>{
    ws.peerId=randomUUID();ws.color=palette[colorIndex++%palette.length];ws.previews=new Map();ws.alive=true;ws.rateStart=Date.now();ws.rateCount=0;
    send(ws,{type:'hello',peer:ws.peerId,color:ws.color});
    ws.on('pong',()=>{ws.alive=true});ws.on('error',()=>{});ws.on('close',()=>leave(ws));
    ws.on('message',(bytes,binary)=>{
      const now=Date.now();if(now-ws.rateStart>1000){ws.rateStart=now;ws.rateCount=0}if(++ws.rateCount>150){ws.close(1008,'Message rate exceeded');return}
      try {
        if(binary)throw Error('JSON required');const msg=JSON.parse(bytes);
        if(msg.type==='join'&&uuid(msg.board)) {
          leave(ws);ws.board=msg.board;if(!rooms.has(msg.board))rooms.set(msg.board,new Set());rooms.get(msg.board).add(ws);
          send(ws,{type:'joined',board:msg.board,revision:revision(msg.board)||0});presence(msg.board);
          for(const peer of rooms.get(msg.board))if(peer!==ws)for(const entry of peer.previews.values()) {
            if(entry.item)sendPreview(ws,peer,entry.item);else send(ws,{type:'preview',peer:peer.peerId,...entry.packet});
          }
          return;
        }
        if(msg.type==='leave'){leave(ws);return}
        if(!ws.board)return;
        if(msg.type==='cursor'&&point(msg)) {roomSend(ws.board,{type:'cursor',peer:ws.peerId,color:ws.color,x:msg.x,y:msg.y},ws);return}
        if(msg.type!=='preview')return;
        if(msg.op==='clear') {
          if(msg.id){ws.previews.delete(msg.id);roomSend(ws.board,{type:'preview',peer:ws.peerId,op:'clear',id:msg.id},ws)}
          else{ws.previews.clear();roomSend(ws.board,{type:'preview',peer:ws.peerId,op:'clear'},ws)}return;
        }
        if(msg.op==='upsert') {
          validateItem(msg.item);if(msg.item.type==='pen'&&msg.item.points.length>800)throw Error('Use incremental points');
          if(!ws.previews.has(msg.item.id)&&ws.previews.size>=16)throw Error('Too many previews');
          ws.previews.set(msg.item.id,{item:msg.item});roomSend(ws.board,{type:'preview',peer:ws.peerId,op:'upsert',item:msg.item},ws);return;
        }
        if(msg.op==='append') {
          const item=ws.previews.get(msg.id)?.item;
          if(!item||item.type!=='pen'||msg.index!==item.points.length||!Array.isArray(msg.points)||msg.points.length>800||msg.points.some(p=>!point(p))||item.points.length+msg.points.length>100000)throw Error('Invalid stroke segment');
          item.points.push(...msg.points);roomSend(ws.board,{type:'preview',peer:ws.peerId,op:'append',id:msg.id,index:msg.index,points:msg.points},ws);return;
        }
        if(msg.op==='move'&&uuid(msg.id)&&Number.isFinite(msg.dx)&&Number.isFinite(msg.dy)) {
          const packet={op:'move',id:msg.id,dx:msg.dx,dy:msg.dy};ws.previews.set(msg.id,{packet});roomSend(ws.board,{type:'preview',peer:ws.peerId,...packet},ws);return;
        }
        if(msg.op==='delete'&&Array.isArray(msg.ids)&&msg.ids.length<=1000&&msg.ids.every(uuid)) {
          for(const id of msg.ids)ws.previews.set(id,{packet:{op:'delete',ids:[id]}});
          roomSend(ws.board,{type:'preview',peer:ws.peerId,op:'delete',ids:msg.ids},ws);return;
        }
        if(msg.op==='end'&&uuid(msg.id)){roomSend(ws.board,{type:'preview',peer:ws.peerId,op:'end',id:msg.id},ws);return}
        throw Error('Invalid live message');
      } catch {ws.close(1008,'Invalid live message')}
    });
  });
  const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.alive){ws.terminate();continue}ws.alive=false;ws.ping()}},20000);heartbeat.unref();
  // HTTP server.close() must also close upgraded sockets (tests and SIGTERM).
  const originalClose=server.close.bind(server);
  server.close=function(...args){clearInterval(heartbeat);for(const ws of wss.clients)ws.terminate();wss.close();return originalClose(...args)};
  return {
    commit(before,after,source) {
      const old=new Map((before?.items||[]).map(o=>[o.id,o])),next=new Map(after.items.map(o=>[o.id,o]));
      const put=after.items.filter(o=>!equal(o,old.get(o.id))),remove=[...old.keys()].filter(id=>!next.has(id));
      for(const peer of rooms.get(after.id)||[])if(peer.peerId===source)peer.previews.clear();
      roomSend(after.id,{type:'commit',board:after.id,revision:after.revision,title:after.title,updated:after.updated,put,remove,source});
      for(const peer of wss.clients)if(!peer.board)send(peer,{type:'library'});
    },
    deleted(id) {roomSend(id,{type:'deleted',board:id});for(const peer of wss.clients)if(!peer.board)send(peer,{type:'library'})}
  };
}

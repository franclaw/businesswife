// Ephemeral, server-authoritative curve rooms. No account or installation needed.
const crypto = require('crypto');
const { readBody, json } = require('./http');
const sse = require('./sse');
const { Sim, wormTemplate, PLAYER_COLORS } = require('../games/vendor/zatacka/engine.cjs');
const rooms = new Map();
const colors = PLAYER_COLORS.map(c => c.fill);
const id = () => crypto.randomBytes(4).toString('hex');
function state(r, full = false) { return { id:r.id, phase:r.phase, host:r.host, players:r.players.map(({token, ...p}) => p), trails:full ? r.trails : r.trails.slice(r.sent), full, generation:r.generation, winner:r.winner, countdown:r.phase === 'playing' && r.sim?.phase === 'countdown' ? Math.max(1, Math.ceil(3-r.sim.phaseT)) : null, solo:r.players.length===1 }; }
function broadcast(r) { sse.send(r.listeners, state(r)); r.sent=r.trails.length; }
function createGames() {
  setInterval(() => {
    const now = Date.now();
    for (const [key,r] of rooms) {
      if (now-r.touched > 3600000) { for (const res of r.listeners) res.end(); rooms.delete(key); continue; }
      if (r.phase !== 'playing') continue;
      for (let n=0; n<3; n++) {
        for (const p of r.players) r.sim.setInput(p.id, p.turn === -1, p.turn === 1);
        r.sim.step(1/60);
        if (r.sim.phase === 'playing') for (const w of r.sim.worms) {
          if (w.alive && !w.inHole) r.trails.push({x:Math.round(w.x),y:Math.round(w.y),player:w.id});
        }
      }
      for (const p of r.players) {
        const w=r.sim.worms.find(w=>w.id===p.id); Object.assign(p,{x:w.x,y:w.y,alive:w.alive,score:w.score});
      }
      r.tick++;
      if (r.sim.phase==='roundend' || (r.players.length===1 && !r.sim.worms[0].alive) || r.tick>2400) {
        r.phase='over'; const alive=r.sim.worms.filter(w=>w.alive); r.winner=alive.length===1 && r.players.length>1 ? alive[0].id : null;
        if (r.players.length===1) r.players[0].score=Math.floor(r.sim.time);
      }
      broadcast(r);
    }
  }, 50).unref();
  return { listeners: () => [...rooms.values()].map(r => r.listeners), async handle(req,res,path) {
    if (path === '/games/api/rooms' && req.method === 'POST') {
      if (rooms.size>=200) { json(res,503,{error:'Room limit reached. Try again later.'}); return; }
      const r={id:id(),players:[],listeners:new Set(),phase:'lobby',trails:[],tick:0,winner:null,touched:Date.now(),host:null,sent:0,generation:0}; rooms.set(r.id,r); json(res,201,{id:r.id}); return;
    }
    const m=path.match(/^\/games\/api\/rooms\/([a-f0-9]{8})(?:\/(join|events|turn|start))?$/); if(!m) return false;
    const r=rooms.get(m[1]); if(!r) { json(res,404,{error:'Room not found or expired.'}); return; }
    r.touched=Date.now(); const action=m[2];
    if(req.method==='GET' && action==='events') { sse.open(req,res,r.listeners,state(r,true)); return; }
    if(req.method==='GET' && !action) { json(res,200,state(r,true)); return; }
    if(req.method!=='POST') { json(res,405,{error:'Method not allowed'}); return; }
    const body=await readBody(req,2048);
    if(action==='join') {
      const existing=r.players.find(p=>p.token===body.token);
      if(existing) { json(res,200,{id:existing.id,token:existing.token}); return; }
      if(r.phase==='playing' || r.players.length>=6) { json(res,409,{error:'Game in progress or room full.'}); return; }
      const name=String(body.name||'').trim().slice(0,20); if(!name) { json(res,400,{error:'Enter your name.'}); return; }
      const p={id:id(),token:crypto.randomBytes(16).toString('hex'),name,color:colors[r.players.length],alive:false,turn:0,x:0,y:0,angle:0}; r.players.push(p); if(!r.host) r.host=p.id;
      json(res,200,{id:p.id,token:p.token}); broadcast(r); return;
    }
    const p=r.players.find(p=>p.token===body.token); if(!p) { json(res,403,{error:'Join the room first.'}); return; }
    if(action==='turn') { if(r.phase==='playing' && [-1,0,1].includes(body.turn)) p.turn=body.turn; json(res,200,{ok:true}); return; }
    if(action==='start') {
      if(p.id!==r.host || r.phase==='playing') { json(res,400,{error:'Only the host can start the game.'}); return; }
      r.trails=[]; r.sent=0; r.generation++; r.tick=0; r.winner=null; r.phase='playing';
      r.sim=new Sim({speed:1,holes:true,barriers:0,targetScore:5},crypto.randomBytes(4).readUInt32LE(),r.players.map((player,i)=>wormTemplate(player.id,player.name,i,'human')));
      r.players.forEach((player,i)=>Object.assign(player,{x:r.sim.worms[i].x,y:r.sim.worms[i].y,alive:true,turn:0,score:0}));
      json(res,200,{ok:true}); broadcast(r); return;
    }
    json(res,404,{error:'Not found'});
  }};
}
module.exports={createGames};

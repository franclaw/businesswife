'use strict';
const $ = id => document.getElementById(id);
const roomId = location.pathname.match(/^\/games\/([a-f0-9]{8})\/?$/)?.[1];
let me = null, game = null, source = null, held = 0;
const canvas=$('arena'), ctx=canvas.getContext('2d');
function error(e){ $('error').textContent = e || ''; }
async function api(path, body) { const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const data=await response.json(); if(!response.ok) throw new Error(data.error||'Something went wrong.'); return data; }
// Keep the arena in an offscreen canvas and apply only new trail points.
const layer=document.createElement('canvas'); layer.width=960; layer.height=640;
const ink=layer.getContext('2d'); let generation=null, positions=new Map(), frameAt=performance.now();
function clearArena(){
 ink.fillStyle='#161217'; ink.fillRect(0,0,960,640); ink.strokeStyle='#2a2028'; ink.lineWidth=1;
 for(let x=40;x<960;x+=40){ink.beginPath();ink.moveTo(x,0);ink.lineTo(x,640);ink.stroke()}
 for(let y=40;y<640;y+=40){ink.beginPath();ink.moveTo(0,y);ink.lineTo(960,y);ink.stroke()}
}
function draw(now=performance.now()) {
 ctx.drawImage(layer,0,0);
 if(game?.phase==='playing') for(const p of game.players.filter(p=>p.alive)) {
   const pos=positions.get(p.id); const t=Math.min(1,Math.max(0,(now-frameAt)/50));
   const x=pos ? pos.fromX+(pos.toX-pos.fromX)*t : p.x, y=pos ? pos.fromY+(pos.toY-pos.fromY)*t : p.y;
   ctx.fillStyle=p.color;ctx.beginPath();ctx.arc(x,y,5,0,Math.PI*2);ctx.fill();
 }
 requestAnimationFrame(draw);
}
function render(g){
 const reset=g.full || generation!==g.generation;
 if(reset){clearArena();generation=g.generation;positions.clear();game=null;}
 const colors=Object.fromEntries(g.players.map(p=>[p.id,p.color]));
 for(const t of g.trails){ink.fillStyle=colors[t.player]||'#fff';ink.beginPath();ink.arc(t.x,t.y,3,0,Math.PI*2);ink.fill()}
 // Retain the trail history for reconnects and diagnostics, but don't redraw it.
 if(!reset && game){game.trails.push(...g.trails);g.trails=game.trails;}
 const old=game; game=g; frameAt=performance.now();
 for(const p of g.players){const prev=old?.players.find(x=>x.id===p.id);positions.set(p.id,{fromX:prev?.x??p.x,fromY:prev?.y??p.y,toX:p.x,toY:p.y});}
 $('count').textContent=`${g.players.length} / 6`; const list=$('players');list.replaceChildren(); for(const p of g.players){const li=document.createElement('li'),dot=document.createElement('span'),label=document.createElement('span');dot.className='dot';dot.style.background=p.color;label.textContent=p.name+(p.id===me?.id?' (you)':'')+(p.id===g.host?' ♛':'')+(g.phase!=='lobby'?` · ${p.score || 0} ${g.solo?'sec':'pts'}`:'')+(g.phase==='playing'&&!p.alive?' · out':'');li.append(dot,label);list.append(li)}
 const host=me?.id===g.host; $('start').hidden=!host||g.phase==='playing';$('start').disabled=false;$('start').firstChild.textContent=g.phase==='over'?'Play again ':'Start game ';
 $('overlay').hidden=g.phase==='playing'&&!g.countdown;
 const winner=g.players.find(p=>p.id===g.winner); $('overlay').querySelector('strong').textContent=g.countdown ? String(g.countdown) : g.phase==='over'?(g.solo?'RUN COMPLETE':winner?`${winner.name} WINS`:'IT’S A DRAW'):'THE FLOOR IS YOURS';
 $('overlay').querySelector('span').textContent=g.countdown?'Get ready':g.phase==='over'?(g.solo?'How long can you last next time?':'Ready for another game?'):'Play solo or invite friends.';
 $('status').textContent=g.phase==='playing'?(g.solo?'Survive as long as you can.':'Last curve standing wins.') : g.phase==='over'?(g.solo?'Survival time shown above.':'Final scores shown above.') : host?'Play solo or invite your friends.':'Waiting for the host to start.';
}
clearArena(); requestAnimationFrame(draw);
async function join(){ try { const saved=JSON.parse(sessionStorage.getItem('curve-'+roomId)||'null'); me=await api(`/games/api/rooms/${roomId}/join`,{name:$('name').value,token:saved?.token});sessionStorage.setItem('curve-'+roomId,JSON.stringify(me)); $('home').hidden=true;$('room').hidden=false;error('');source=new EventSource(`/games/api/rooms/${roomId}/events`);source.onmessage=e=>render(JSON.parse(e.data));source.onerror=()=>{$('status').textContent='Connection interrupted. Reconnecting…';}; }catch(e){error(e.message)} }
$('create').addEventListener('click',async()=>{try{if(!$('name').value.trim()){error('Enter your name first.');return}const r=await api('/games/api/rooms',{});sessionStorage.setItem('curve-name',$('name').value.trim());const joined=await api(`/games/api/rooms/${r.id}/join`,{name:$('name').value.trim()});sessionStorage.setItem('curve-'+r.id,JSON.stringify(joined));location.href='/games/'+r.id}catch(e){error(e.message)}});
if(roomId){$('create').textContent='Join room ↗'; $('create').replaceWith($('create').cloneNode(true)); $('create').addEventListener('click',join); const saved=JSON.parse(sessionStorage.getItem('curve-'+roomId)||'null');$('name').value=sessionStorage.getItem('curve-name')||'';if(saved)join();}
$('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(location.href);$('invite').textContent='Invite link copied.'}catch{$('invite').textContent='Copy this link: '+location.href}});
$('start').addEventListener('click',async()=>{try{await api(`/games/api/rooms/${roomId}/start`,{token:me.token});error('')}catch(e){error(e.message)}});
function turn(n){if(!me||held===n)return;held=n;api(`/games/api/rooms/${roomId}/turn`,{token:me.token,turn:n}).catch(e=>error(e.message))}
for(const [id,n] of [['left',-1],['right',1]]){const b=$(id);b.addEventListener('pointerdown',e=>{e.preventDefault();b.setPointerCapture(e.pointerId);turn(n)});b.addEventListener('pointerup',()=>turn(0));b.addEventListener('pointercancel',()=>turn(0));b.addEventListener('lostpointercapture',()=>turn(0));}
window.addEventListener('keydown',e=>{if(['ArrowLeft','a','A','ArrowRight','d','D'].includes(e.key)&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){e.preventDefault();turn(['ArrowLeft','a','A'].includes(e.key)?-1:1)}});window.addEventListener('keyup',e=>{if(['ArrowLeft','a','A','ArrowRight','d','D'].includes(e.key))turn(0)});window.addEventListener('blur',()=>turn(0));

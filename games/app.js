'use strict';
const $ = id => document.getElementById(id);
const roomId = location.pathname.match(/^\/games\/([a-f0-9]{8})\/?$/)?.[1];
let me = null, game = null, source = null, held = 0;
const canvas=$('arena'), ctx=canvas.getContext('2d');
function error(e){ $('error').textContent = e || ''; }
async function api(path, body) { const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const data=await response.json(); if(!response.ok) throw new Error(data.error||'Something went wrong.'); return data; }
function draw() {
 ctx.clearRect(0,0,960,640); ctx.fillStyle='#161217'; ctx.fillRect(0,0,960,640);
 ctx.strokeStyle='#2a2028';ctx.lineWidth=1; for(let x=40;x<960;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,640);ctx.stroke()} for(let y=40;y<640;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(960,y);ctx.stroke()}
 if(!game)return; const colors=Object.fromEntries(game.players.map(p=>[p.id,p.color]));
 for(const t of game.trails){ctx.fillStyle=colors[t.player]||'#fff';ctx.beginPath();ctx.arc(t.x,t.y,3,0,Math.PI*2);ctx.fill()}
 for(const p of game.players.filter(p=>p.alive)){ctx.fillStyle=p.color;ctx.beginPath();ctx.arc(p.x,p.y,5,0,Math.PI*2);ctx.fill()}
}
function render(g){ game=g; $('count').textContent=`${g.players.length} / 6`; const list=$('players');list.replaceChildren(); for(const p of g.players){const li=document.createElement('li'),dot=document.createElement('span'),label=document.createElement('span');dot.className='dot';dot.style.background=p.color;label.textContent=p.name+(p.id===me?.id?' (you)':'')+(p.id===g.host?' ♛':'')+(g.phase==='playing'?` · ${p.score || 0} pts`:'')+(g.phase==='playing'&&!p.alive?' · out':'');li.append(dot,label);list.append(li)}
 const host=me?.id===g.host; $('start').hidden=!host||g.phase==='playing';$('start').disabled=g.players.length<2;$('start').firstChild.textContent=g.phase==='over'?'Play again ':'Start game ';$('overlay').hidden=g.phase==='playing';
 const winner=g.players.find(p=>p.id===g.winner); $('overlay').querySelector('strong').textContent=g.phase==='over'?(winner?`${winner.name} WINS`:'IT’S A DRAW'):'THE FLOOR IS YOURS'; $('overlay').querySelector('span').textContent=g.phase==='over'?'Ready for another round?':'Invite a friend to get the game going.';
 $('status').textContent=g.phase==='playing'?'First to 5 points wins. Avoid the lines.':g.players.length<2?'Waiting for another player…':host?'Everyone ready?':'Waiting for the host to start.'; draw(); }
async function join(){ try { const saved=JSON.parse(sessionStorage.getItem('curve-'+roomId)||'null'); me=await api(`/games/api/rooms/${roomId}/join`,{name:$('name').value,token:saved?.token});sessionStorage.setItem('curve-'+roomId,JSON.stringify(me)); $('home').hidden=true;$('room').hidden=false;error('');source=new EventSource(`/games/api/rooms/${roomId}/events`);source.onmessage=e=>render(JSON.parse(e.data));source.onerror=()=>{$('status').textContent='Connection interrupted. Reconnecting…';}; }catch(e){error(e.message)} }
$('create').addEventListener('click',async()=>{try{if(!$('name').value.trim()){error('Enter your name first.');return}const r=await api('/games/api/rooms',{});sessionStorage.setItem('curve-name',$('name').value.trim());const joined=await api(`/games/api/rooms/${r.id}/join`,{name:$('name').value.trim()});sessionStorage.setItem('curve-'+r.id,JSON.stringify(joined));location.href='/games/'+r.id}catch(e){error(e.message)}});
if(roomId){$('create').textContent='Join room ↗'; $('create').replaceWith($('create').cloneNode(true)); $('create').addEventListener('click',join); const saved=JSON.parse(sessionStorage.getItem('curve-'+roomId)||'null');$('name').value=sessionStorage.getItem('curve-name')||'';if(saved)join();}
$('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(location.href);$('invite').textContent='Invite link copied.'}catch{$('invite').textContent='Copy this link: '+location.href}});
$('start').addEventListener('click',async()=>{try{await api(`/games/api/rooms/${roomId}/start`,{token:me.token});error('')}catch(e){error(e.message)}});
function turn(n){if(!me||held===n)return;held=n;api(`/games/api/rooms/${roomId}/turn`,{token:me.token,turn:n}).catch(e=>error(e.message))}
for(const [id,n] of [['left',-1],['right',1]]){const b=$(id);b.addEventListener('pointerdown',e=>{e.preventDefault();b.setPointerCapture(e.pointerId);turn(n)});b.addEventListener('pointerup',()=>turn(0));b.addEventListener('pointercancel',()=>turn(0));b.addEventListener('lostpointercapture',()=>turn(0));}
window.addEventListener('keydown',e=>{if(['ArrowLeft','a','A','ArrowRight','d','D'].includes(e.key)&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){e.preventDefault();turn(['ArrowLeft','a','A'].includes(e.key)?-1:1)}});window.addEventListener('keyup',e=>{if(['ArrowLeft','a','A','ArrowRight','d','D'].includes(e.key))turn(0)});window.addEventListener('blur',()=>turn(0));draw();

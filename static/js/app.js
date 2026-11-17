const $=id=>document.getElementById(id),cv=$('cv'),clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
let frame=null,rows=[],sess={dt:[],pt:[],pd:null},drag=null,pend=false,restored=false,busy=false,saveT=0,readyQ=[],logCache=[],printTarget=null;
const BOOT=JSON.parse(document.getElementById('boot').textContent);
/* every change goes to the Flask API (MySQL); the header is a CSRF guard the server checks */
async function api(method,url,body){const o={method,headers:{'X-MIDSnap':'1'}};
 if(body instanceof FormData)o.body=body;else if(body!==undefined){o.body=JSON.stringify(body);o.headers['Content-Type']='application/json'}
 const r=await fetch(url,o);if(!r.ok){let m='';try{m=(await r.json()).error}catch{}throw new Error(m||`Request failed (${r.status})`)}
 return r.status===204?null:r.json()}
const say=t=>$('fs').textContent=t;
/* ---- toast notifications: every action result (rendering, download, print, errors) shows up here ---- */
const toastBox=$('toasts');let toastEl=null,toastT=0;
function toast(t){clearTimeout(toastT);
 if(!t){if(toastEl){const e=toastEl;toastEl=null;e.classList.add('out');setTimeout(()=>e.remove(),250)}return}
 const work=/(…|\.\.\.)$/.test(t),bad=/could not|couldn't|cancel|failed|error|refused|not set up|rejected|first\.|too large/i.test(t),
  kind=work?'work':bad?'bad':'ok';
 if(!toastEl){toastEl=document.createElement('div');toastBox.append(toastEl)}
 const e=toastEl;e.className='toast '+kind;e.textContent='';
 const ic=document.createElement('i');ic.setAttribute('aria-hidden','true');ic.textContent=work?'':kind==='bad'?'!':'✓';
 const m=document.createElement('span');m.textContent=t;
 const x=document.createElement('button');x.type='button';x.className='tx';x.textContent='✕';x.setAttribute('aria-label','Dismiss');x.onclick=()=>toast('');
 e.append(ic,m,x);e.setAttribute('role',bad?'alert':'status');
 if(!work)toastT=setTimeout(()=>toast(''),bad?7000:4500)}
const osay=toast;
/* toasts live in <body>, but while a modal popup is open they move inside it, so they always show above the popup */
const dlgStack=[];
function placeToasts(){const h=dlgStack.length?dlgStack[dlgStack.length-1]:document.body;if(toastBox.parentNode!==h)h.append(toastBox)}
{const sm=HTMLDialogElement.prototype.showModal;HTMLDialogElement.prototype.showModal=function(){sm.call(this);dlgStack.push(this);placeToasts()}}
document.addEventListener('close',e=>{const i=dlgStack.indexOf(e.target);if(i>=0)dlgStack.splice(i,1);placeToasts()},true);
/* strip ID (XXXX-XXXX): shown in the preview, kept for the strip when it is MIDSnapped */
const IDCH='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genId=()=>{const a=new Uint8Array(8);crypto.getRandomValues(a);const s=[...a].map(v=>IDCH[v%IDCH.length]).join('');return s.slice(0,4)+'-'+s.slice(4)};
let curId='';try{curId=localStorage.getItem('ps_curid')||''}catch{}
function setCurId(v){curId=/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(v||'')?v:genId();try{localStorage.setItem('ps_curid',curId)}catch{}$('sid').textContent='ID '+curId}
const newCurId=()=>setCurId('');setCurId(curId);
const redraw=()=>{if(pend)return;pend=true;requestAnimationFrame(()=>{pend=false;render(cv,true);persist()})};
const kc={key:'',c:null};
function askConfirm(title,msg){const d=$('cdlg');if(!d.showModal)return Promise.resolve(confirm(msg));
 return new Promise(res=>{$('cdt').textContent=title;$('cdm').textContent=msg;let done=false;
  const fin=v=>{if(done)return;done=true;d.onclick=null;d.close();res(v)};
  $('cdok').onclick=()=>fin(true);$('cdno').onclick=()=>fin(false);d.oncancel=e=>{e.preventDefault();fin(false)};d.onclick=e=>{if(e.target===d)fin(false)};d.showModal()})}
function snapFx(){const f=$('flash');f.classList.remove('go');void f.offsetWidth;f.classList.add('go')}
const MM_W=102,MM_H=152;

/* ---- print details: suggested and fixed (they are shown, but cannot be changed) ---- */
const SZ={lbl:'4 in × 6 in (North American)',w:'4in',h:'6in',mmw:101.6,mmh:152.4};
const PAPER={glossy:'Photo Paper - Glossy',matte:'Photo Paper - Matte'};
const QUAL={draft:'Draft',standard:'Standard',high:'High Quality'};
const FMT={png:'PNG',jpg:'JPG'};
const prefs=Object.freeze({fmt:'png',copies:1,paper:'glossy',quality:'high',borderless:true,ask:true});
const fillSel=(id,o)=>{$(id).innerHTML='';Object.entries(o).forEach(([k,v])=>{const op=document.createElement('option');op.value=k;op.textContent=v;$(id).append(op)})};
function enhance(id){const sel=$(id),dd=document.createElement('div'),b=document.createElement('button'),ul=document.createElement('ul');
 dd.className='dd';b.type='button';b.className='ddb';b.disabled=sel.disabled;b.setAttribute('aria-haspopup','listbox');b.setAttribute('aria-expanded','false');ul.className='ddl';ul.setAttribute('role','listbox');b.innerHTML='<span></span><i></i>';
 const upd=()=>{b.firstChild.textContent=sel.options[sel.selectedIndex]?sel.options[sel.selectedIndex].text:'';[...ul.children].forEach((li,k)=>li.classList.toggle('sel',k===sel.selectedIndex))};
 const close=()=>{dd.classList.remove('open');b.setAttribute('aria-expanded','false')};
 [...sel.options].forEach((o,k)=>{const li=document.createElement('li');li.textContent=o.text;li.setAttribute('role','option');li.onclick=()=>{sel.selectedIndex=k;sel.dispatchEvent(new Event('change'));upd();close()};ul.append(li)});
 b.onclick=e=>{e.stopPropagation();if(b.disabled)return;document.querySelectorAll('.dd.open').forEach(x=>{if(x!==dd)x.classList.remove('open')});dd.classList.toggle('open');b.setAttribute('aria-expanded',String(dd.classList.contains('open')))};
 document.addEventListener('click',close);sel.hidden=true;sel.after(dd);dd.append(b,ul);sel._dd=upd;upd()}
fillSel('pfmt',FMT);fillSel('ppaper',PAPER);fillSel('pq',QUAL);['pfmt','ppaper','pq'].forEach(enhance);
$('pfmt').value=prefs.fmt;$('ppaper').value=prefs.paper;$('pq').value=prefs.quality;$('pcopies').value=prefs.copies;$('pbl').checked=prefs.borderless;$('pask').checked=prefs.ask;
['pfmt','ppaper','pq'].forEach(i=>$(i)._dd());
$('pnote').textContent='These settings are fixed, but a browser can\'t apply the paper type or quality by itself. You\'ll be reminded to choose them in the print window.';
const pdStr=p=>p?`${SZ.lbl} · Copies: ${p.copies||1} · ${PAPER[p.paper]||PAPER.glossy} · ${QUAL[p.quality]||QUAL.high} · ${p.borderless?'Borderless':'With margins'}`:'–';

/* ---- IndexedDB: only the frame and the photoshoot in progress (this browser). Saved strips live in MySQL. ---- */
let dbp;const idb=()=>dbp||(dbp=new Promise((ok,no)=>{const r=indexedDB.open('ps',1);r.onupgradeneeded=()=>r.result.createObjectStore('k');r.onsuccess=()=>ok(r.result);r.onerror=no}));
const idbSet=async(k,v)=>{try{(await idb()).transaction('k','readwrite').objectStore('k').put(v,k)}catch{}};
const idbGet=async k=>{try{const d=await idb();return await new Promise(ok=>{const q=d.transaction('k').objectStore('k').get(k);q.onsuccess=()=>ok(q.result);q.onerror=()=>ok()})}catch{}};
function persist(){if(!restored||!frame)return;clearTimeout(saveT);saveT=setTimeout(()=>idbSet('cur',{rows:rows.map(r=>({b:r.blob||null,z:r.z,ox:r.ox,oy:r.oy})),sess}),300)}
try{navigator.storage&&navigator.storage.persist&&navigator.storage.persist()}catch{}

/* ---- frame import: the SVG is used untouched; green pixels are the placeholders ---- */
function groupRows(rs){const s=[...rs].sort((a,b)=>a.y+a.h/2-b.y-b.h/2),g=[];
 s.forEach(r=>{const c=r.y+r.h/2,f=g.find(o=>Math.abs(o.c-c)<r.h*.5);f?f.i.push(r):g.push({c,i:[r]})});
 return g.map(o=>o.i.sort((a,b)=>a.x-b.x))}
function findGreen(img,vw,vh){
 const k=Math.min(2,1400/Math.max(vw,vh)),w=Math.round(vw*k),h=Math.round(vh*k),N=w*h,c=document.createElement('canvas');c.width=w;c.height=h;
 const x=c.getContext('2d');x.drawImage(img,0,0,w,h);const d=x.getImageData(0,0,w,h).data,m=new Uint8Array(N);
 for(let i=0;i<N;i++)m[i]=d[i*4+1]>200&&d[i*4]<90&&d[i*4+2]<90&&d[i*4+3]>200?1:0;
 let out=[];
 for(let s=0;s<N;s++){if(m[s]!==1)continue;const st=[s];let n=0,x0=w,y0=h,x1=0,y1=0;m[s]=2;
  while(st.length){const p=st.pop(),px=p%w,py=(p/w)|0;n++;x0=Math.min(x0,px);x1=Math.max(x1,px);y0=Math.min(y0,py);y1=Math.max(y1,py);
   const go=q=>{if(m[q]===1){m[q]=2;st.push(q)}};if(px>0)go(p-1);if(px<w-1)go(p+1);if(py>0)go(p-w);if(py<h-1)go(p+w)}
  if(n>N*.002)out.push({x:(x0-1.5)/k,y:(y0-1.5)/k,w:(x1-x0+4)/k,h:(y1-y0+4)/k})}
 const hit=(a,b)=>a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h;
 for(let ch=true;ch;){ch=false;for(let i=0;i<out.length;i++)for(let j=i+1;j<out.length;j++)if(hit(out[i],out[j])){
  const a=out[i],b=out[j],x0=Math.min(a.x,b.x),y0=Math.min(a.y,b.y);out[i]={x:x0,y:y0,w:Math.max(a.x+a.w,b.x+b.w)-x0,h:Math.max(a.y+a.h,b.y+b.h)-y0};out.splice(j,1);ch=true;j--}}
 return out}
async function loadFrame(file,name,silent,fresh){
 const head=await file.slice(0,4000).text(),tag=(head.match(/<svg[^>]*>/i)||[''])[0],vb=tag.match(/viewBox="([^"]+)"/);
 let vw,vh;if(vb)[,,vw,vh]=vb[1].trim().split(/[\s,]+/).map(Number);else{vw=parseFloat((tag.match(/\swidth="([\d.]+)/)||[])[1]);vh=parseFloat((tag.match(/\sheight="([\d.]+)/)||[])[1])}
 if(!(vw>0&&vh>0))return say('That file is not a usable SVG (no size found).');
 const img=new Image(),url=URL.createObjectURL(new Blob([file],{type:'image/svg+xml'}));
 try{await new Promise((ok,no)=>{img.onload=ok;img.onerror=no;img.src=url})}catch{return say('The SVG could not be drawn.')}
 const rs=findGreen(img,vw,vh);
 if(!rs.length)return say('No green (#00FF00) placeholders found in this SVG.');
 const g=groupRows(rs);
 if(fresh)rows.forEach(wipe);
 frame={name,file,url,img,vw,vh,rects:g.flatMap((r,i)=>r.map(o=>({...o,row:i})))};kc.key='';
 rows=g.map((_,i)=>(!fresh&&rows[i])||{img:null,z:1,ox:0,oy:0});
 say(`${rs.length} placeholders found in ${g.length} rows.`);
 if(!silent)idbSet('frame',{name,blob:file});
 showFrameThumb();buildSlots();redraw();
}
function showFrameThumb(){const el=$('fthumb');el.innerHTML='';$('fb').textContent=frame?'Replace frame':'Import SVG frame';if(!frame)return;const im=new Image();im.src=frame.url;im.alt='Frame template';el.append(im)}
async function clearFrame(){if(!frame)return;if(rows.some(r=>r.img)&&!await askConfirm('Clear frame','Clear the frame? The photos on the strip will be removed too.'))return;
 rows.forEach(wipe);rows=[];frame=null;kc.key='';idbSet('frame',null);idbSet('cur',null);showFrameThumb();buildSlots();redraw();updateLive();
 say('No frame yet. Green areas are treated as photo placeholders. The frame always fills the strip (edges may be cropped).')}
$('fb').onclick=()=>$('ff').click();$('fclr').onclick=()=>clearFrame();
$('ff').onchange=e=>{const f=e.target.files[0];if(f)loadFrame(f,f.name);e.target.value=''};

/* ---- photos: add, replace, remove, swap rows, or clear everything ---- */
const isImg=f=>/^image\/(png|jpeg)$/.test(f.type)||/\.(png|jpe?g)$/i.test(f.name);
const hasT=(e,t)=>[...(e.dataTransfer.types||[])].includes(t);
const wipe=st=>{if(st.url)URL.revokeObjectURL(st.url);st.img=null;st.url=null;st.blob=null;st.z=1;st.ox=st.oy=0};
const clearRow=i=>{wipe(rows[i]);buildSlots();redraw();updateLive()};
function swapRows(a,b){if(a===b||!rows[a]||!rows[b])return;[rows[a],rows[b]]=[rows[b],rows[a]];rows[a].flash=rows[b].flash=true;buildSlots();redraw();updateLive()}
$('clr').onclick=async()=>{if(!rows.some(r=>r.img))return;if(!await askConfirm('Clear all photos','Remove all photos from the strip? The frame stays.'))return;rows.forEach(wipe);buildSlots();redraw();updateLive()};
const sp=z=>{z.style.setProperty('--p',(z.value-1)/4*100+'%');if(z.zv)z.zv.textContent=(+z.value).toFixed(1)+'×'};
document.addEventListener('pointerup',()=>document.querySelectorAll('.row').forEach(x=>x.draggable=true));
function buildSlots(){const el=$('slots');el.innerHTML='';const dsp=rows.length?'':'none';$('drop').style.display=dsp;$('pbtns').style.display=dsp;
 if(!rows.length){el.innerHTML='<p class="hint">Rows appear after you import a frame.</p>';syncBtns();return}
 rows.forEach((st,i)=>{
  const r=document.createElement('div');r.className='row'+(st.flash?' flash':'');st.flash=false;r.draggable=true;
  const grip=document.createElement('div');grip.className='grip';grip.textContent='⋮⋮';
  r.ondragstart=e=>{e.dataTransfer.setData('text/ps-row',String(i));e.dataTransfer.effectAllowed='move';e.dataTransfer.setDragImage(r,24,24);requestAnimationFrame(()=>r.classList.add('dragging'))};
  r.ondragend=()=>r.classList.remove('dragging');
  r.ondragover=e=>{if(hasT(e,'text/ps-row')){e.preventDefault();r.classList.add('dz')}};
  r.ondragleave=()=>r.classList.remove('dz');
  r.ondrop=e=>{r.classList.remove('dz');const from=e.dataTransfer.getData('text/ps-row');if(from!==''){e.preventDefault();swapRows(+from,i)}};
  const s=document.createElement('div');s.className='slot'+(st.url?' has':'')+(st.fresh?' pop':'');st.fresh=false;s.tabIndex=0;s.setAttribute('role','button');s.setAttribute('aria-label',(st.img?'Replace photo for row ':'Add photo for row ')+(i+1));s.textContent='Row '+(i+1);
  if(st.url)s.style.backgroundImage=`url(${st.url})`;
  const inp=document.createElement('input');inp.type='file';inp.accept='image/png,image/jpeg';inp.hidden=true;
  inp.onchange=()=>{if(inp.files[0])setImg(i,inp.files[0]);inp.value=''};
  s.onclick=()=>inp.click();s.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();inp.click()}};
  s.ondragover=e=>{if(hasT(e,'Files')){e.preventDefault();s.classList.add('over')}};s.ondragleave=()=>s.classList.remove('over');
  s.ondrop=e=>{s.classList.remove('over');if(e.dataTransfer.files.length){e.preventDefault();e.stopPropagation();const f=[...e.dataTransfer.files].find(isImg);if(f)setImg(i,f)}};
  const mk=(t,fn,dis,title)=>{const b=document.createElement('button');b.className='sm';b.textContent=t;if(title){b.title=title;b.setAttribute('aria-label',title)}b.disabled=!!dis;b.onclick=fn;return b};
  const zc=document.createElement('div');zc.className='zc';
  if(st.img){
   const zh=document.createElement('div');zh.className='zh';const zl=document.createElement('span'),zv=document.createElement('span');zl.textContent='Zoom';zh.append(zl,zv);
   const z=document.createElement('input');z.type='range';z.min=1;z.max=5;z.step=.01;z.value=st.z;z.setAttribute('aria-label','Zoom row '+(i+1));z.zv=zv;sp(z);
   z.onpointerdown=()=>{r.draggable=false};z.oninput=()=>{st.z=+z.value;sp(z);redraw()};st.zi=z;
   const rb=document.createElement('div');rb.className='rb';
   rb.append(mk('Replace',()=>inp.click()),mk('Remove',()=>clearRow(i)),mk('Reset crop',()=>{st.z=1;st.ox=st.oy=0;z.value=1;sp(z);redraw()}));
   zc.append(zh,z,rb)
  }else{st.zi=null;zc.style.justifyItems='center';zc.append(mk('Add photo',()=>inp.click()))}
  const arr=document.createElement('div');arr.className='arr';
  arr.append(mk('↑',()=>swapRows(i,i-1),i===0,'Move row up'),mk('↓',()=>swapRows(i,i+1),i===rows.length-1,'Move row down'));
  r.append(grip,s,inp,zc,arr);el.append(r)});
 syncBtns()}
async function setImg(i,f){try{const st=rows[i],bm=await createImageBitmap(f);if(st.url)URL.revokeObjectURL(st.url);st.img=bm;st.blob=f;st.url=URL.createObjectURL(f);st.z=1;st.ox=st.oy=0;st.fresh=true;buildSlots();redraw();updateLive()}catch{osay('That photo could not be read. Use PNG or JPG.')}}
const many=fs=>{const order=[...rows.keys()].sort((a,b)=>(!!rows[a].img)-(!!rows[b].img)||a-b);[...fs].filter(isImg).slice(0,rows.length).forEach((f,k)=>setImg(order[k],f))};
$('drop').onclick=()=>$('multi').click();$('drop').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('multi').click()}};
$('multi').onchange=e=>{many(e.target.files);e.target.value=''};
$('drop').ondragover=e=>{e.preventDefault();$('drop').classList.add('over')};$('drop').ondragleave=()=>$('drop').classList.remove('over');
$('drop').ondrop=e=>{e.preventDefault();$('drop').classList.remove('over');many(e.dataTransfer.files)};

/* ---- render: photos first, then the frame (always fills the strip) with only its green pixels keyed out ---- */
function keyed(w,h,cache,fr){fr=fr||frame;const key=w+'x'+h;if(cache&&kc.key===key)return kc.c;
 const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d');x.drawImage(fr.img,0,0,w,h);
 const im=x.getImageData(0,0,w,h),d=im.data;
 for(let i=0;i<d.length;i+=4){const m=Math.max(d[i],d[i+2]),g=d[i+1];if(g>m+8)d[i+3]*=1-Math.min(1,(g-m)/255*1.6)}
 x.putImageData(im,0,0);if(cache){kc.key=key;kc.c=c}return c}
function render(c,preview,fr,rw){fr=fr||frame;rw=rw||rows;
 const W=c.width,H=c.height,x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,W,H);
 if(!fr){x.fillStyle='#4a3fb0';x.font="800 28px Montserrat,sans-serif";x.textAlign='center';x.fillText('Import your SVG frame',W/2,H/2);return}
 const sx=Math.max(W/fr.vw,H/fr.vh),sy=sx;
 const ox=(W-fr.vw*sx)/2,oy=(H-fr.vh*sy)/2;
 fr.rects.forEach(r=>{
  const X=ox+r.x*sx,Y=oy+r.y*sy,w=r.w*sx,h=r.h*sy,st=rw[r.row]||{img:null,z:1,ox:0,oy:0};if(preview)r.px={X,Y,w,h};
  if(st.img){const iw=st.img.width,ih=st.img.height,s=Math.max(w/iw,h/ih)*st.z,dw=iw*s,dh=ih*s,mx=(dw-w)/2,my=(dh-h)/2;
   st.ox=clamp(st.ox*w,-mx,mx)/w;st.oy=clamp(st.oy*h,-my,my)/h;
   x.save();x.beginPath();x.rect(X,Y,w,h);x.clip();x.drawImage(st.img,X+(w-dw)/2+st.ox*w,Y+(h-dh)/2+st.oy*h,dw,dh);x.restore()}
  else if(preview){x.fillStyle='#e3ebff';x.fillRect(X,Y,w,h)}
 });
 x.drawImage(keyed(Math.round(fr.vw*sx),Math.round(fr.vh*sy),preview,fr),ox,oy);
 if(preview)fr.rects.forEach(r=>{if(!(rw[r.row]&&rw[r.row].img)){x.fillStyle='#4a27a0';x.font="800 26px Montserrat,sans-serif";x.textAlign='center';x.fillText('Add photo '+(r.row+1),r.px.X+r.px.w/2,r.px.Y+r.px.h/2)}});
}
const pt=e=>{const b=cv.getBoundingClientRect();return{x:(e.clientX-b.left)*cv.width/b.width,y:(e.clientY-b.top)*cv.height/b.height}};
const hit=p=>frame&&frame.rects.find(r=>r.px&&p.x>=r.px.X&&p.x<=r.px.X+r.px.w&&p.y>=r.px.Y&&p.y<=r.px.Y+r.px.h);
cv.onpointerdown=e=>{const p=pt(e),r=hit(p);if(r&&rows[r.row].img){drag={row:r.row,x:p.x,y:p.y,w:r.px.w,h:r.px.h};cv.setPointerCapture(e.pointerId);cv.style.cursor='grabbing'}};
cv.onpointermove=e=>{if(!drag)return;const p=pt(e),st=rows[drag.row];st.ox+=(p.x-drag.x)/drag.w;st.oy+=(p.y-drag.y)/drag.h;drag.x=p.x;drag.y=p.y;redraw()};
cv.onpointerup=cv.onpointercancel=()=>{drag=null;cv.style.cursor='grab'};
cv.onwheel=e=>{const r=hit(pt(e));if(!r||!rows[r.row].img)return;e.preventDefault();const st=rows[r.row];st.z=clamp(st.z*Math.exp(-e.deltaY*.0015),1,5);if(st.zi){st.zi.value=st.z;sp(st.zi)}redraw()};

/* ---- preview window: minimize / expand ---- */
const stage=$('stage');
const I={min:'<svg viewBox="0 0 12 12"><path d="M2 6h8"/></svg>',plus:'<svg viewBox="0 0 12 12"><path d="M6 2v8M2 6h8"/></svg>',x:'<svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>'};
const wset=(b,svg,t)=>{b.innerHTML=svg;b.title=t;b.setAttribute('aria-label',t)};
function syncWin(){const c=stage.classList.contains('col');wset($('bmin'),c?I.plus:I.min,c?'Expand':'Collapse');$('bmin').setAttribute('aria-expanded',String(!c))}
$('bmin').onclick=()=>{stage.classList.toggle('col');syncWin()};
syncWin();

/* ---- export: exact physical-size metadata ---- */
const T=[...Array(256)].map((_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;return c>>>0});
const crc=b=>{let c=~0;for(const v of b)c=T[(c^v)&255]^(c>>>8);return ~c>>>0};
function setPhys(b,ppmX,ppmY){const k=new Uint8Array(21),d=new DataView(k.buffer);
 d.setUint32(0,9);k.set([112,72,89,115],4);d.setUint32(8,ppmX);d.setUint32(12,ppmY);k[16]=1;d.setUint32(17,crc(k.subarray(4,17)));
 const o=new Uint8Array(b.length+21);o.set(b.subarray(0,33));o.set(k,33);o.set(b.subarray(33),54);return o}
/* Browsers can't hold a 5760 dpi canvas (it comes out blank), so we render at dpi values that work
   and stamp the PNG with the exact physical size. Tries each dpi in order until one works. */
function setJfif(b,dpi){if(b[2]===255&&b[3]===224&&b[6]===74&&b[7]===70){b[13]=1;b[14]=dpi>>8;b[15]=dpi&255;b[16]=dpi>>8;b[17]=dpi&255}return b}
async function makePNG(list,wmm,hmm,fmt,fr,rw){
 for(const d of list){
  const w=Math.round(wmm/25.4*d),h=Math.round(hmm/25.4*d);let c;
  try{
   c=document.createElement('canvas');c.width=w;c.height=h;
   render(c,false,fr,rw);
   const t=document.createElement('canvas');t.width=16;t.height=24;const tx=t.getContext('2d');tx.drawImage(c,0,0,16,24);
   const px=tx.getImageData(0,0,16,24).data;let blank=true;for(let i=0;i<px.length;i+=4)if(px[i]<250||px[i+1]<250||px[i+2]<250){blank=false;break}
   if(blank)throw 0;
   const bl=await new Promise(r=>c.toBlob(r,fmt==='jpg'?'image/jpeg':'image/png',.95));if(!bl)throw 0;
   c.width=c.height=0;
   const buf=new Uint8Array(await bl.arrayBuffer());
   const jpg=fmt==='jpg';return{blob:new Blob([jpg?setJfif(buf,Math.round(w/(wmm/25.4))):setPhys(buf,Math.round(w/(wmm/1000)),Math.round(h/(hmm/1000)))],{type:jpg?'image/jpeg':'image/png'}),w,h,dpi:d}
  }catch{if(c)c.width=c.height=0}
 }
 return null}
const tick=()=>new Promise(r=>setTimeout(r,40));
const ready=()=>{if(!frame||!rows.some(r=>r.img)){osay('Import a frame and add at least one photo first.');return false}return true};
const save=async(blob,name)=>{
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),4000);return true};
const setBusy=(b,on)=>{busy=on;document.body.classList.toggle('working',on);if(b)b.classList.toggle('busy',on);syncBtns()};
/* ---- QR code (byte mode, error correction M, versions 1-10) ---- */
function qrMatrix(text){
 const EXP=new Uint8Array(512),LOG=new Uint8Array(256);{let x=1;for(let i=0;i<255;i++){EXP[i]=x;LOG[x]=i;x<<=1;if(x&256)x^=0x11d}for(let i=255;i<512;i++)EXP[i]=EXP[i-255]}
 const mul=(a,b)=>a&&b?EXP[LOG[a]+LOG[b]]:0;
 const gen=n=>{let g=[1];for(let i=0;i<n;i++){const h=new Array(g.length+1).fill(0);g.forEach((c,j)=>{h[j]^=c;h[j+1]^=mul(c,EXP[i])});g=h}return g};
 const rs=(d,n)=>{const g=gen(n),r=new Array(n).fill(0);d.forEach(b=>{const f=b^r[0];r.shift();r.push(0);if(f)for(let i=0;i<n;i++)r[i]^=mul(g[i+1],f)});return r};
 const EC=[0,[10,1,16],[16,1,28],[26,1,44],[18,2,32],[24,2,43],[16,4,27],[18,4,31],[22,2,38,2,39],[22,3,36,2,37],[26,4,43,1,44]];
 const AP=[0,[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50]];
 const bytes=[...new TextEncoder().encode(text)],cap=e=>e[1]*e[2]+(e[3]||0)*(e[4]||0);
 let v=1;for(;v<=9;v++)if(4+8+8*bytes.length<=8*cap(EC[v]))break;
 if(v>9)return null;
 const e=EC[v],total=cap(e),bits=[],put=(val,n)=>{for(let i=n-1;i>=0;i--)bits.push((val>>>i)&1)};
 put(4,4);put(bytes.length,v<10?8:16);bytes.forEach(b=>put(b,8));put(0,Math.min(4,total*8-bits.length));while(bits.length%8)bits.push(0);
 const data=[];for(let i=0;i<bits.length;i+=8){let b=0;for(let j=0;j<8;j++)b=b<<1|bits[i+j];data.push(b)}
 for(let p=0xEC;data.length<total;p^=0xEC^0x11)data.push(p);
 const blocks=[];let o=0;for(let g=0;g<2;g++){const nb=g?(e[3]||0):e[1],d=g?e[4]:e[2];for(let k=0;k<nb;k++){blocks.push(data.slice(o,o+d));o+=d}}
 const ecs=blocks.map(b=>rs(b,e[0])),out=[],md=Math.max(...blocks.map(b=>b.length));
 for(let i=0;i<md;i++)blocks.forEach(b=>{if(i<b.length)out.push(b[i])});for(let i=0;i<e[0];i++)ecs.forEach(b=>out.push(b[i]));
 const n=17+4*v,M=Array.from({length:n},()=>Array(n).fill(0)),F=Array.from({length:n},()=>Array(n).fill(false));
 const set=(x,y,val)=>{if(x>=0&&y>=0&&x<n&&y<n){M[y][x]=val?1:0;F[y][x]=true}};
 [[3,3],[n-4,3],[3,n-4]].forEach(([cx,cy])=>{for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const d=Math.max(Math.abs(dx),Math.abs(dy));set(cx+dx,cy+dy,d!==4&&d!==2)}});
 for(let i=8;i<n-8;i++){set(i,6,i%2===0);set(6,i,i%2===0)}
 const ap=AP[v];ap.forEach((a,i)=>ap.forEach((b,j)=>{if((i===0&&j===0)||(i===0&&j===ap.length-1)||(i===ap.length-1&&j===0))return;for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)set(a+dx,b+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1)}));
 for(let i=0;i<9;i++){if(!F[8][i])set(i,8,0);if(!F[i][8])set(8,i,0)}
 for(let i=0;i<8;i++){set(n-1-i,8,0);set(8,n-1-i,0)}
 set(8,n-8,1);
 if(v>=7){let r=v;for(let i=0;i<12;i++)r=(r<<1)^((r>>>11)*0x1F25);const bv=v<<12|r;for(let i=0;i<18;i++){const bit=(bv>>>i)&1,a=n-11+i%3,b=Math.floor(i/3);set(a,b,bit);set(b,a,bit)}}
 let k=0;const nb=out.length*8;
 for(let right=n-1;right>=1;right-=2){if(right===6)right=5;for(let vert=0;vert<n;vert++)for(let j=0;j<2;j++){const x=right-j,up=((right+1)&2)===0,y=up?n-1-vert:vert;if(!F[y][x]&&k<nb){M[y][x]=(out[k>>>3]>>>(7-(k&7)))&1;k++}}}
 const MF=[(x,y)=>(x+y)%2===0,(x,y)=>y%2===0,(x,y)=>x%3===0,(x,y)=>(x+y)%3===0,(x,y)=>(Math.floor(x/3)+Math.floor(y/2))%2===0,(x,y)=>x*y%2+x*y%3===0,(x,y)=>(x*y%2+x*y%3)%2===0,(x,y)=>((x+y)%2+x*y%3)%2===0];
 const build=mk=>{const Q=M.map(r=>r.slice());for(let y=0;y<n;y++)for(let x=0;x<n;x++)if(!F[y][x]&&MF[mk](x,y))Q[y][x]^=1;
  let r=mk;for(let i=0;i<10;i++)r=(r<<1)^((r>>>9)*0x537);const fb=(mk<<10|r)^0x5412,g=i=>(fb>>>i)&1,sq=(x,y,b)=>{Q[y][x]=b};
  for(let i=0;i<=5;i++)sq(8,i,g(i));sq(8,7,g(6));sq(8,8,g(7));sq(7,8,g(8));for(let i=9;i<15;i++)sq(14-i,8,g(i));
  for(let i=0;i<8;i++)sq(n-1-i,8,g(i));for(let i=8;i<15;i++)sq(8,n-15+i,g(i));sq(8,n-8,1);return Q};
 const pen=Q=>{let p=0;for(let a=0;a<2;a++)for(let y=0;y<n;y++){let run=1;for(let x=1;x<n;x++){const c=a?Q[x][y]:Q[y][x],q=a?Q[x-1][y]:Q[y][x-1];if(c===q){run++;if(run===5)p+=3;else if(run>5)p++}else run=1}}
  for(let y=0;y<n-1;y++)for(let x=0;x<n-1;x++)if(Q[y][x]===Q[y][x+1]&&Q[y][x]===Q[y+1][x]&&Q[y][x]===Q[y+1][x+1])p+=3;
  const dk=Q.flat().filter(Boolean).length;return p+Math.floor(Math.abs(dk*20-n*n*10)/(n*n))*10};
 let best=null,bp=1e9;for(let mk=0;mk<8;mk++){const Q=build(mk),p=pen(Q);if(p<bp){bp=p;best=Q}}return best}
function drawQR(c,text){const Q=qrMatrix(text),x=c.getContext('2d');
 if(!Q){c.width=c.height=200;x.fillStyle='#fff';x.fillRect(0,0,200,200);x.fillStyle='#000';x.font='14px sans-serif';x.fillText('Link too long',50,100);return}
 const n=Q.length,qz=4,sc=Math.max(4,Math.floor(480/(n+2*qz)));c.width=c.height=(n+2*qz)*sc;x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.fillStyle='#000';
 for(let y=0;y<n;y++)for(let xx=0;xx<n;xx++)if(Q[y][xx])x.fillRect((xx+qz)*sc,(y+qz)*sc,sc,sc)}

/* ---- MIDSnapped: the only place to download, print or share a strip ---- */
const qsay=toast;
const fcache=new Map();
async function frameFor(it){if(it.fr)return it.fr;const k=it.name+'|'+(it.fb&&it.fb.size);if(fcache.has(k))return fcache.get(k);
 const head=await it.fb.slice(0,4000).text(),tag=(head.match(/<svg[^>]*>/i)||[''])[0],vb=tag.match(/viewBox="([^"]+)"/);
 let vw,vh;if(vb)[,,vw,vh]=vb[1].trim().split(/[\s,]+/).map(Number);else{vw=parseFloat((tag.match(/\swidth="([\d.]+)/)||[])[1]);vh=parseFloat((tag.match(/\sheight="([\d.]+)/)||[])[1])}
 const img=new Image();img.src=URL.createObjectURL(new Blob([it.fb],{type:'image/svg+xml'}));await new Promise((ok,no)=>{img.onload=ok;img.onerror=no});
 const g=groupRows(findGreen(img,vw,vh)),fr={name:it.name,file:it.fb,img,vw,vh,rects:g.flatMap((r,i)=>r.map(o=>({...o,row:i})))};fcache.set(k,fr);return fr}
async function outItem(it,fmt,wmm,hmm,list){let rw=[];try{await hydrate(it);const fr=await frameFor(it);
 rw=await Promise.all(it.rows.map(async c=>({img:c.b?await createImageBitmap(c.b):null,z:c.z||1,ox:c.ox||0,oy:c.oy||0})));
 return await makePNG(list,wmm,hmm,fmt,fr,rw)}catch{return null}finally{rw.forEach(r=>r.img&&r.img.close&&r.img.close())}}
async function logUse(it,kind,n){applyEvent(it,await api('POST',`/api/midsnapped/${it.id}/events`,{kind:kind==='dl'?'download':'print',copies:n||1}))}
async function qDownload(it,btn,fm){fm=fm==='jpg'?'jpg':'png';if(busy)return;setBusy(btn,true);qsay('Rendering your photostrip, please wait…');await tick();
 const r=await outItem(it,fm,MM_W,MM_H,[600,300]);setBusy(btn,false);
 if(!r)return qsay('The image could not be rendered. Try a desktop browser.');
 const ok=await save(r.blob,`midsnap-${it.code||new Date(it.ts).toISOString().slice(0,19).replace(/[-:T]/g,'')}-102x152mm.${fm}`);
 if(!ok)return qsay('Download cancelled.');
 try{await logUse(it,'dl')}catch(e){return qsay('Downloaded, but the count could not be saved: '+e.message)}
 qsay(`Downloaded 102 × 152 mm ${fm.toUpperCase()} (${r.w} × ${r.h} px, ${r.dpi} dpi).`)}
function fillDlg(){const t=$('pdt');t.innerHTML='';[['Paper size',SZ.lbl],['Paper type',PAPER[prefs.paper]],['Quality',QUAL[prefs.quality]],['Borderless margin',prefs.borderless?'On':'Off']].forEach(([a,b])=>{const tr=document.createElement('tr'),x=document.createElement('td'),y=document.createElement('td');x.textContent=a;y.textContent=b;tr.append(x,y);t.append(tr)})}
const applyEvent=(it,r)=>{Object.assign(it,r.midsnapped);
 if(r.log){const i=logCache.findIndex(x=>x.id===r.log.id);if(i<0)logCache.push(r.log);else logCache[i]=r.log}
 lastSyncSig='';showHist();showReady()};
let printBtn=null;
function qPrint(it,btn){if(busy)return;printTarget=it;printBtn=btn||null;
 const d=$('pdlg');if(d.showModal){fillDlg();d.showModal()}else doPrint(it,btn)}
$('pdgo').onclick=()=>{$('pdlg').close();doPrint(printTarget,printBtn)};
$('pdcancel').onclick=()=>$('pdlg').close();
/* Print opens the browser's own print overlay with the strip at 4 x 6 in, no margins. A browser cannot choose
   the paper type or the quality, so a reminder is shown first. */
async function doPrint(it,btn){if(busy||!it)return;setBusy(btn||null,true);qsay('Preparing print…');await tick();
 const sz=SZ,r=await outItem(it,'png',sz.mmw,sz.mmh,[600,300]);
 if(!r){setBusy(btn||null,false);return qsay('The print image could not be prepared.')}
 const n=prefs.copies;setBusy(btn||null,false);
 const u=URL.createObjectURL(r.blob);
 $('pstyle').textContent=`@page{size:${sz.w} ${sz.h};margin:0}@media print{#pr .pg{width:${sz.w};height:${sz.h};padding:0;box-sizing:border-box;overflow:hidden;break-after:page}#pr .pg:last-child{break-after:auto}#pr .pg img{width:100%;height:100%;object-fit:fill;display:block}}`;
 const pr=$('pr');pr.innerHTML='';const g=document.createElement('div');g.className='pg';const im=new Image();im.alt='Photostrip';
 const ld=new Promise(ok=>{im.onload=im.onerror=ok});im.src=u;g.append(im);pr.append(g);await ld;
 await new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok)));qsay('');window.print();
 try{applyEvent(it,await api('POST',`/api/midsnapped/${it.id}/events`,{kind:'print',copies:n}))}catch(e){qsay('Printed, but the count could not be saved: '+e.message)}}
const fdt=t=>t?`${dstr(t)} ${tstr(t).slice(0,5)}`:'–';
/* "tomorrow 12:52 PM" style time for the online-copy expiry */
function whenTxt(t){const d=new Date(t),n=new Date(),day=x=>new Date(x.getFullYear(),x.getMonth(),x.getDate()),diff=Math.round((day(d)-day(n))/864e5),
 tm=d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true});
 return(diff===0?'today':diff===1?'tomorrow':'on '+dstr(t))+' '+tm}
function liveLink(it){if(it.link&&!(it.linkExp>Date.now())){it.link=null;it.linkExp=null}return it.link||null}
/* a saved strip's frame and photos are fetched from the server the first time it is rendered */
async function hydrate(it){if(it._hy)return;
 const g=async u=>{const r=await fetch(u);if(!r.ok)throw new Error(`Could not load the saved strip (${r.status})`);return r.blob()};
 it.fb=await g(`/api/snaps/${it.id}/frame`);
 it.rows=await Promise.all(it.layout.map(async(c,i)=>({b:c.has?await g(`/api/snaps/${it.id}/photos/${i}`):null,z:c.z||1,ox:c.ox||0,oy:c.oy||0})));
 it._hy=true}
async function qQr(it,btn){
 if(liveLink(it)){it._open=!it._open;showReady();return}                 /* link exists: Show / Hide QR code */
 if(it._busy)return;it._open=true;it._busy=true;it._msg='';showReady();qsay('Uploading your photostrip…');
 try{const cap=(BOOT.share&&BOOT.share.max)||1e7;let r=await outItem(it,'png',MM_W,MM_H,[600,300]);   /* high-quality PNG; 300 dpi only if Cloudinary's size limit needs it */
  if(r&&r.blob.size>cap)r=await outItem(it,'png',MM_W,MM_H,[300,200])||r;if(!r)throw new Error('could not render the strip');
  const fd=new FormData();fd.append('image',r.blob,'strip.png');
  const s=await api('POST',`/api/midsnapped/${it.id}/share`,fd);it.link=s.url;it.linkExp=s.expires;lastSyncSig=''}
 catch(e){it._msg='Could not create the download link: '+(e.message||'unknown error')}
 it._busy=false;showReady();qsay(it.link?'Download link ready. It works for '+((BOOT.share&&BOOT.share.hours)||24)+' hours.':it._msg)}
async function qUnlink(it){try{await api('DELETE',`/api/midsnapped/${it.id}/share`)}catch(e){return qsay('Could not delete the online copy: '+e.message)}
 it.link=null;it.linkExp=null;it._open=false;lastSyncSig='';showReady();qsay('Online copy deleted. Its QR code no longer works.')}
async function qRemove(it){if(busy)return;if(!await askConfirm('Remove from MIDSnapped','Remove this strip from MIDSnapped? Its record, counts and online copy are deleted, so its QR code stops working.'))return;
 try{await api('DELETE',`/api/midsnapped/${it.id}`)}catch(e){return qsay('Could not remove the strip: '+e.message)}
 readyQ=readyQ.filter(o=>o!==it);lastSyncSig='';showReady();qsay('Removed from MIDSnapped.')}
/* ---- MIDSnapped rows (click one to open its popup) and the strip popup ---- */
let popItem=null;
function ago(t){const s=Math.max(0,(Date.now()-t)/1000);if(s<45)return'just now';const m=Math.round(s/60);if(m<60)return m<=1?'1 minute ago':m+' minutes ago';
 const h=Math.round(m/60);if(h<24)return h===1?'1 hour ago':h+' hours ago';const d=Math.round(h/24);return d<=7?(d===1?'1 day ago':d+' days ago'):dstr(t)}
function agoEl(t){const e=document.createElement('span');if(!t){e.textContent='–';return e}e.dataset.ago=t;e.title=fdt(t);e.textContent=ago(t);return e}
setInterval(()=>document.querySelectorAll('[data-ago]').forEach(e=>{e.textContent=ago(+e.dataset.ago)}),20000);
const mkb=(t,fn,cls)=>{const x=document.createElement('button');x.type='button';x.className=cls||'sm';x.textContent=t;x.onclick=e=>fn(e.currentTarget);return x};
const cnt=(lbl,n,times)=>{const c=document.createElement('span');c.className='chip '+(n>0?'on':'zero');c.textContent=`${n} ${lbl}`;if(times&&times.length)c.title=times.map(fdt).join('\n');return c};
function lastLine(it){const ls=[['Last downloaded: ',it.lastDl],['Last printed: ',it.lastPr]].filter(l=>l[1]);if(!ls.length)return null;
 const d=document.createElement('div');d.className='hint lastl';d.style.margin='0';
 ls.forEach(([l,t])=>{const r=document.createElement('div');r.append(l,agoEl(t));d.append(r)});return d}
function thumb(it){const im=new Image();im.src=it.t;im.alt='MIDSnapped strip '+(it.code||'');im.className='qt';im.draggable=false;im.onload=im.onerror=()=>fitList();return im}
async function copyText(t){try{await navigator.clipboard.writeText(t);return true}catch{}
 try{const a=document.createElement('textarea');a.value=t;a.setAttribute('readonly','');a.style.cssText='position:fixed;left:0;top:0;opacity:0';
  ($('sdlg').open?$('sdlg'):document.body).append(a);a.select();const ok=document.execCommand('copy');a.remove();return ok}catch{return false}}
function fitList(){const el=$('qlist'),k=[...el.children];el.style.maxHeight='';el.classList.toggle('scroll',k.length>=5);
 if(k.length>=5){const l=k[4];el.style.maxHeight=(l.offsetTop+l.offsetHeight)+'px'}}
addEventListener('resize',()=>fitList());
function showReady(){const el=$('qlist');el.innerHTML='';const has=readyQ.length>0;
 const qs=$('qstats');qs.innerHTML='';{const d=document.createElement('div'),b=document.createElement('b');d.className='stat';b.textContent=readyQ.length;d.append(b,'MIDSnapped photostrips');qs.append(d)}
 $('qempty').style.display=has?'none':'';
 readyQ.forEach(it=>{
  const w=document.createElement('div');w.className='qi';w.tabIndex=0;w.setAttribute('role','button');w.setAttribute('aria-label','Open strip '+(it.code||''));w.title='Click to download, print or get a QR code';
  const m=document.createElement('div'),tp=document.createElement('div'),hd=document.createElement('div');m.className='qm';tp.className='qtop';hd.className='qh';
  const idb=document.createElement('b');idb.className='sid2';idb.textContent=it.code||'';const wh=agoEl(it.ts);wh.className='when';hd.append(idb,wh);
  const ch=document.createElement('span');ch.className='qchips';ch.append(cnt('Downloaded',it.dl,it.dlt),cnt('Printed',it.pr,it.prt));
  const lk=liveLink(it);if(lk){const c=document.createElement('span');c.className='chip ok';c.textContent='Online copy ready';c.title='Expires '+fdt(it.linkExp);ch.append(c)}
  tp.append(hd,ch);
  const a=document.createElement('div');a.className='qa';a.append(mkb('Edit',()=>editStrip(it)),mkb('Remove',()=>qRemove(it)));a.onclick=e=>e.stopPropagation();
  m.append(...[tp,lastLine(it),a].filter(Boolean));w.append(thumb(it),m);
  w.onclick=()=>openStrip(it);w.onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&e.target===w){e.preventDefault();openStrip(it)}};
  el.append(w)});
 fitList();if(popItem&&$('sdlg').open)renderPop()}
function openStrip(it){popItem=it;renderPop();const d=$('sdlg');if(!d.open)d.showModal()}
function closePop(){const d=$('sdlg');popItem=null;if(d.open)d.close()}
$('sdlg').addEventListener('click',e=>{if(e.target===$('sdlg'))closePop()});
$('sdlg').addEventListener('close',()=>{popItem=null});
wset($('sdx'),I.x,'Close');$('sdx').onclick=closePop;
function renderPop(){const it=popItem;if(!it)return;if(!readyQ.includes(it))return closePop();
 const lk=liveLink(it),b=$('sdb');$('sdt').textContent='Strip';$('sdid').textContent=it.code||'';b.innerHTML='';
 const pi=document.createElement('div'),pm=document.createElement('div'),ch=document.createElement('span');pi.className='pi';pm.className='pm';ch.className='qchips';
 const wh=agoEl(it.ts);wh.className='when';ch.append(cnt('Downloaded',it.dl,it.dlt),cnt('Printed',it.pr,it.prt));
 if(lk){const c=document.createElement('span');c.className='chip ok';c.textContent='Online copy ready';c.title='Expires '+fdt(it.linkExp);ch.append(c)}
 pm.append(...[wh,ch,lastLine(it)].filter(Boolean));pi.append(thumb(it),pm);
 const a=document.createElement('div');a.className='qa pa';
 a.append(mkb('Download PNG',x=>qDownload(it,x,'png'),'main sm'),mkb('Download JPG',x=>qDownload(it,x,'jpg')),
  mkb(lk?(it._open?'Hide QR code':'Show QR code'):'Generate QR code',x=>qQr(it,x)),mkb('Print',x=>qPrint(it,x)));
 b.append(pi,a);
 if(it._open){const q=document.createElement('div');q.className='qr';
  if(it._busy)q.textContent='Creating your download link…';
  else if(lk){const c=document.createElement('canvas');drawQR(c,lk);const t=document.createElement('div');t.className='hint';t.textContent='Scan with a phone camera to download the photostrip';
   const l=document.createElement('div');l.className='lnk';l.textContent=lk;const r=document.createElement('div');r.className='qa';
   r.append(mkb('Copy link',async x=>{const ok=await copyText(lk);x.textContent=ok?'Link copied ✓':'Copy failed';x.classList.toggle('copied',ok);
     qsay(ok?'Link copied to the clipboard.':'Could not copy the link. Select it and copy it by hand.');clearTimeout(x._t);x._t=setTimeout(()=>{x.textContent='Copy link';x.classList.remove('copied')},2200)}),mkb('Delete online copy',()=>qUnlink(it)));
   const n=document.createElement('div');n.className='hint';n.textContent=`You can download the strip from this link until ${whenTxt(it.linkExp)}. It will get deleted automatically after ${BOOT.share&&BOOT.share.hours||24} hours. Delete the online copy sooner if you no longer need it.`;q.append(c,t,l,r,n)}
  else q.textContent=it._msg||'Preparing…';
  b.append(q)}
 }

/* ---- photo log: kept in MySQL, tracked live ---- */
const hist=()=>logCache;
const pad=n=>String(n).padStart(2,'0');
const dstr=t=>{const d=new Date(t);return`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`};
const tstr=t=>{const d=new Date(t);return`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`};
const pl=(n,w)=>`${n} ${w}${n==1?'':'s'}`;
const times=a=>(a&&a.length)?` (${a.map(tstr).join(', ')})`:'';
function csv(){const q=s=>'"'+String(s).replace(/"/g,'""')+'"',j=a=>q((a||[]).map(t=>dstr(t)+' '+tstr(t)).join(' | '));
 return'\ufeff'+['shoot_id,date,time,frame,photos,downloads,prints,download_times,print_times,print_details',...hist().map((e,i)=>[i+1,dstr(e.ts),tstr(e.ts),q(e.f),e.n,e.d,e.p,j(e.dt),j(e.pt),q(pdStr(e.pd))].join(','))].join('\r\n')+'\r\n'}
function report(){const h=hist(),s=stats(h);
 return['MIDSNAP PHOTO LOG',`Generated: ${dstr(Date.now())} ${tstr(Date.now())}`,'',`Photoshoots: ${s.shoots}`,`Photos taken: ${s.photos}`,`Strips downloaded: ${s.dl+sess.dt.length}`,`Strips printed: ${s.pr+sess.pt.length}`,'',
 ...h.map((e,i)=>`#${i+1}  ${dstr(e.ts)} ${tstr(e.ts)}  frame: ${e.f}  photos: ${e.n}  downloads: ${e.d}  prints: ${e.p}${times(e.pt)}  print details: ${pdStr(e.pd)}`)].join('\r\n')+'\r\n'}
$('csv').onclick=()=>save(new Blob([csv()],{type:'text/csv'}),'midsnap-photo-log.csv');
$('txt').onclick=()=>save(new Blob([report()],{type:'text/plain'}),'midsnap-photo-log.txt');
$('end').onclick=async()=>{if(busy)return;const n=rows.filter(r=>r.img).length;if(!frame||!n)return;snapFx();
 const c=document.createElement('canvas');c.width=204;c.height=304;render(c,false);
 const tb=await new Promise(r=>c.toBlob(r,'image/jpeg',.6));
 const rowsData=rows.map(r=>({b:r.blob||null,z:r.z,ox:r.ox,oy:r.oy}));
 const fd=new FormData();fd.append('meta',JSON.stringify({name:frame.name,code:curId,layout:rowsData.map(r=>({has:!!r.b,z:r.z,ox:r.ox,oy:r.oy}))}));
 fd.append('thumb',tb,'thumb.jpg');fd.append('frame',frame.file,frame.name);rowsData.forEach((r,i)=>{if(r.b)fd.append('photo'+i,r.b,'photo'+i)});
 setBusy($('end'),true);osay('Saving to MIDSnapped…');let res;
 try{res=await api('POST','/api/snaps',fd)}catch(e){setBusy($('end'),false);return osay('Could not save this strip: '+e.message)}
 setBusy($('end'),false);osay('');
 const it={...res.midsnapped,fb:frame.file,rows:rowsData,fr:frame,_hy:true};
 readyQ=[it,...readyQ.filter(o=>o.id!==it.id)];logCache=[...logCache,res.log];lastSyncSig='';
 rows.forEach(wipe);sess={dt:[],pt:[],pd:null};buildSlots();redraw();persist();showHist();showReady();
 newCurId();qsay('Added to MIDSnapped as '+it.code+'.');openStrip(it)};
$('ch').onclick=async()=>{if(await askConfirm('Clear photo log','Delete the whole photo log? Download the CSV first if you need it.')){try{await api('DELETE','/api/log')}catch(err){return osay(err.message)}logCache=[];lastSyncSig='';showHist()}};
function stats(h){const hr={};h.forEach(e=>{const k=new Date(e.ts).getHours();hr[k]=(hr[k]||0)+1});const pk=Object.entries(hr).sort((a,b)=>b[1]-a[1])[0];
 return{shoots:h.length,photos:h.reduce((s,e)=>s+e.n,0),dl:h.reduce((s,e)=>s+e.d,0),pr:h.reduce((s,e)=>s+e.p,0),peak:pk?new Date(2000,0,1,+pk[0]).toLocaleTimeString([],{hour:'numeric'}):'–'}}
function syncBtns(){const has=rows.some(r=>r.img),ok=!!frame&&has,n=hist().length;
 $('clr').disabled=!has;$('fclr').disabled=!frame;$('end').disabled=!ok||busy;['csv','txt','ch'].forEach(k=>$(k).disabled=!n)}
function updateLive(){syncBtns();const n=rows.filter(r=>r.img).length,d=sess.dt.length,p=sess.pt.length,el=$('live');el.innerHTML='';
 [['In-progress photos',n]].forEach(([l,v])=>{const c=document.createElement('div');c.className='stat';const b=document.createElement('b');b.textContent=v;c.append(b,l);el.append(c)})}
function showHist(){
 const h=hist(),now=new Date(),s=stats(h),td=dstr(now);updateLive();
 const prToday=h.reduce((a,e)=>a+((e.pt&&e.pt.length)?e.pt.filter(t=>dstr(t)===td).length:(dstr(e.ts)===td?e.p:0)),0)+sess.pt.filter(t=>dstr(t)===td).length;
 $('stats').innerHTML='';[['Finished photostrips',s.shoots],['Printed photostrips',s.pr],['Downloaded photostrips',s.dl]].forEach(([l,v])=>{const d=document.createElement('div');d.className='stat';const b=document.createElement('b');b.textContent=v;d.append(b,l);$('stats').append(d)});
 const tb=$('log');tb.innerHTML='';
 const hr=document.createElement('thead'),tr0=document.createElement('tr');
 ['#','Strip','Date','Time','Frame','Photos','Downloads','Prints','Print times','Print details',''].forEach(c=>{const th=document.createElement('th');th.textContent=c;if(['Photos','Downloads','Prints'].includes(c))th.style.textAlign='right';tr0.append(th)});hr.append(tr0);tb.append(hr);
 const body=document.createElement('tbody');tb.append(body);
 const cell=(tr,txt,cls)=>{const c=document.createElement('td');if(cls)c.className=cls;c.textContent=txt;tr.append(c);return c};
 if(!h.length){const tr=document.createElement('tr'),c=cell(tr,'No photoshoots logged yet. Finishing a photoshoot saves it here.','empty');c.colSpan=11;body.append(tr)}
 [...h].map((e,i)=>({e,i})).reverse().forEach(({e,i},k)=>{const tr=document.createElement('tr');tr.style.setProperty('--i',Math.min(k,12));
  cell(tr,i+1,'n');
  const ti=document.createElement('td');if(e.t){const im=new Image();im.src=e.t;im.alt='Strip';im.draggable=false;ti.append(im)}else ti.textContent='–';tr.append(ti);
  cell(tr,dstr(e.ts));cell(tr,tstr(e.ts));cell(tr,e.f||'–');cell(tr,e.n,'n');cell(tr,e.d,'n');cell(tr,e.p,'n');
  cell(tr,(e.pt&&e.pt.length)?e.pt.map(tstr).join(', '):'–');cell(tr,pdStr(e.pd));
  const ta=document.createElement('td'),x=document.createElement('button');x.className='sm';x.textContent='Delete';x.onclick=async()=>{try{await api('DELETE','/api/log/'+e.id)}catch(err){return osay(err.message)}logCache=logCache.filter(o=>o.id!==e.id);lastSyncSig='';showHist()};ta.append(x);tr.append(ta);body.append(tr)})}

/* ---- live sync across devices without refreshing ---- */
let lastSyncSig='',syncInFlight=false;
async function liveSync(){
 if(syncInFlight)return;
 syncInFlight=true;
 try{
  const res=await api('GET','/api/sync');
  if(!res||res.sig===lastSyncSig)return;
  lastSyncSig=res.sig;

  const oldMap=new Map(readyQ.map(it=>[it.id,it]));
  const openId=popItem?popItem.id:null;

  readyQ=(res.midsnapped||[]).map(fresh=>{
   const prev=oldMap.get(fresh.id);
   if(prev){
    Object.assign(prev,fresh);
    return prev;
   }
   return fresh;
  });

  if(openId){
   popItem=readyQ.find(it=>it.id===openId)||null;
  }

  logCache=res.log||[];
  showReady();
  showHist();
 }catch{}finally{
  syncInFlight=false;
 }
}
setInterval(liveSync,2500);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)liveSync()});

/* ---- MIDSnapped strips can be reopened: the frame and photos come back on the strip, fully editable ---- */
async function applyRows(list){for(let i=0;i<rows.length&&i<list.length;i++){const c=list[i],st=rows[i];st.z=c.z||1;st.ox=c.ox||0;st.oy=c.oy||0;
 if(c.b){try{st.img=await createImageBitmap(c.b);st.blob=c.b;st.url=URL.createObjectURL(c.b);st.fresh=true}catch{}}}buildSlots()}
async function editStrip(e){if(busy)return;
 if(rows.some(r=>r.img)&&!await askConfirm('Edit strip','Replace the photos currently on the strip with this MIDSnapped strip?'))return;
 try{await hydrate(e)}catch(x){return osay(x.message)}
 await loadFrame(e.fb,e.name,false,true);
 if(!frame||frame.name!==e.name)return;
 await applyRows(e.rows);redraw();updateLive();$('cFrame').scrollIntoView({behavior:'smooth',block:'start'});
 newCurId();osay('Strip opened for editing. Press MIDSnap-it to save the changes as a new strip.')}

/* ---- startup: restore the frame and the photoshoot in progress ---- */
async function restore(){
 const cur=await idbGet('cur');
 if(cur){
  if(cur.sess)sess={dt:cur.sess.dt||[],pt:cur.sess.pt||[],pd:cur.sess.pd||null};
  if(frame&&cur.rows)await applyRows(cur.rows);
 }
 restored=true;redraw();showHist()}
const hOpen=o=>{wset($('hbtn'),o?I.min:I.plus,o?'Collapse':'Expand');$('hbtn').setAttribute('aria-expanded',String(o))};
$('hsum').onclick=e=>{e.preventDefault();const d=$('hist');if(d.open&&d.classList.contains('show')){d.classList.remove('show');hOpen(false);setTimeout(()=>{d.open=false},300)}else{d.open=true;hOpen(true);requestAnimationFrame(()=>requestAnimationFrame(()=>d.classList.add('show')))}};hOpen(false);
const setIc=(b,col)=>wset(b,col?I.plus:I.min,col?'Expand':'Collapse');
document.querySelectorAll('.card:not(.hist)').forEach(c=>{const ch=c.querySelector(':scope>.ch'),cb=c.querySelector(':scope>.cb');if(!ch||!cb)return;
 const w=document.createElement('div');w.className='cw';c.insertBefore(w,cb);w.append(cb);c.classList.add('open');
 const bs=document.createElement('span');bs.className='wbs';const b=document.createElement('button');b.className='wb';b.type='button';setIc(b,false);b.setAttribute('aria-expanded','true');bs.append(b);ch.append(bs);
 b.onclick=()=>{const col=!c.classList.contains('col');c.classList.toggle('col',col);b.setAttribute('aria-expanded',String(!col));setIc(b,col);if(col)c.classList.remove('open');else setTimeout(()=>c.classList.add('open'),320)};
 if(c.id==='cOut'){c.classList.add('col');c.classList.remove('open');b.setAttribute('aria-expanded','false');setIc(b,true)}});
const BGD=[['star',2,16,46,-12,7,0,.85],['flower',4,46,54,10,8,1,.8],['sparkle',1.5,76,40,0,6,.5,.9],['clover',5,90,48,14,9,2,.8],
 ['star',95,12,40,10,6.5,1,.85],['sparkle',93,38,52,0,7,0,.9],['flower',96,64,50,-8,8,1.5,.8],['star',92,88,44,-14,7,.5,.85],
 ['sparkle',9,6,30,0,5,2,.8],['star',88,4,30,8,5.5,.3,.8],['clover',10,96,34,-10,8,1,.7],['flower',50,97,36,0,9,2,.6]];
const VB={star:'0 0 100 100',sparkle:'-50 -50 100 100',flower:'-60 -60 120 120',clover:'-62 -62 124 124'};
BGD.forEach(([sy,l,t,w,r,d,dl,o])=>{const NS='http://www.w3.org/2000/svg',v=document.createElementNS(NS,'svg'),u=document.createElementNS(NS,'use');v.setAttribute('class','deco fl');v.setAttribute('viewBox',VB[sy]);
 v.style.cssText=`left:${l}%;top:${t}%;width:${w}px;--r:${r}deg;--d:${d}s;animation-delay:${dl}s;--o:${o}`;u.setAttribute('href','#'+sy);v.append(u);$('bgd').append(v)});
readyQ=BOOT.midsnapped;logCache=BOOT.log;
buildSlots();showFrameThumb();showHist();showReady();redraw();
(async()=>{const r=await idbGet('frame');if(r&&r.blob)await loadFrame(r.blob,r.name,true);await restore();})();
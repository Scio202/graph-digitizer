/* Graph Digitizer - client-side plot digitizer.
   Extracts data points from a graph image and exports them as CSV.
   No dependencies, no build step, no server. */
"use strict";

const PALETTE = ["#4f8cff","#ff5c72","#26c281","#f7b32b","#b06bff","#00c2d1","#ff8f4d","#e05fa8"];

const state = {
  img: null, imgData: null, scale: 1,
  mode: "points",       // points | delete | pan | calibrate | eyedropper
  calTarget: null,      // "X1"|"X2"|"Y1"|"Y2"|"BL"|"TR"
  cornerMode: false,
  cal: { X1:null, X2:null, Y1:null, Y2:null },
  logX: false, logY: false,
  series: [], active: 0,
  autoColor: null,
  selPt: null,          // selected point (drag / nudge / delete)
  drag: null,
  bg: undefined,        // cached background colour
  lasso: null,          // in-progress freeform selection [{px,py}]
  axes: undefined       // cached axis detection (reset per image)
};

const $ = id => document.getElementById(id);
const canvas = $("canvas"), ctx = canvas.getContext("2d");
const loupe = $("loupe"), lctx = loupe.getContext("2d");
const wrap = $("canvasWrap");
const offscreen = document.createElement("canvas");
const offctx = offscreen.getContext("2d", { willReadFrequently: true });
const valMap = { X1:"valX1", X2:"valX2", Y1:"valY1", Y2:"valY2" };

// ============================================================ image loading
function loadImageFromSource(src){
  const img = new Image();
  img.onload = () => {
    state.img = img; state.axes = undefined; state.bg = undefined;
    offscreen.width = img.naturalWidth; offscreen.height = img.naturalHeight;
    offctx.drawImage(img, 0, 0);
    try { state.imgData = offctx.getImageData(0,0,img.naturalWidth,img.naturalHeight); }
    catch(e){ state.imgData = null; }
    $("placeholder").style.display = "none";
    zoomFit(); setMode("points");
  };
  img.src = src;
}
function handleFile(file){
  if(!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = e => loadImageFromSource(e.target.result);
  reader.readAsDataURL(file);
}
$("fileInput").addEventListener("change", e => handleFile(e.target.files[0]));
const dz = $("dropzone");
["dragenter","dragover"].forEach(ev => dz.addEventListener(ev, e=>{e.preventDefault();dz.classList.add("drag");}));
["dragleave","drop"].forEach(ev => dz.addEventListener(ev, e=>{e.preventDefault();dz.classList.remove("drag");}));
dz.addEventListener("drop", e => { if(e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
window.addEventListener("paste", e => {
  for(const item of e.clipboardData.items){
    if(item.type.startsWith("image/")){ handleFile(item.getAsFile()); break; }
  }
});

// ============================================================ zoom / render
function setZoom(s){
  if(!state.img) return;
  state.scale = Math.min(8, Math.max(0.05, s));
  canvas.width  = Math.round(state.img.naturalWidth  * state.scale);
  canvas.height = Math.round(state.img.naturalHeight * state.scale);
  $("zoomLabel").textContent = Math.round(state.scale*100)+"%";
  render();
}
function zoomFit(){
  if(!state.img) return;
  const pad = 24;
  setZoom(Math.min((wrap.clientWidth-pad)/state.img.naturalWidth,(wrap.clientHeight-pad)/state.img.naturalHeight,1));
}
$("zoomIn").onclick  = () => setZoom(state.scale*1.25);
$("zoomOut").onclick = () => setZoom(state.scale/1.25);
$("zoomFit").onclick = zoomFit;
wrap.addEventListener("wheel", e => {
  if(!state.img) return;
  if(e.ctrlKey || e.metaKey){ e.preventDefault(); setZoom(state.scale*(e.deltaY<0?1.1:0.9)); }
}, { passive:false });

function render(){
  if(!state.img) return;
  const s = state.scale, c = state.cal;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(state.img, 0, 0, canvas.width, canvas.height);

  if(state.cornerMode){
    if(c.X1) drawCross(c.X1.px*s, c.X1.py*s, "#f7b32b", "BL");
    if(c.X2) drawCross(c.X2.px*s, c.X2.py*s, "#f7b32b", "TR");
    if(c.X1 && c.X2){
      ctx.setLineDash([5,5]); ctx.lineWidth=1; ctx.strokeStyle="rgba(247,179,43,.6)";
      ctx.strokeRect(c.X1.px*s, c.X2.py*s, (c.X2.px-c.X1.px)*s, (c.X1.py-c.X2.py)*s);
      ctx.setLineDash([]);
    }
  } else {
    const calColors = { X1:"#ff5c72", X2:"#ff5c72", Y1:"#26c281", Y2:"#26c281" };
    for(const k of ["X1","X2","Y1","Y2"]){ if(c[k]) drawCross(c[k].px*s, c[k].py*s, calColors[k], k); }
    ctx.setLineDash([5,5]); ctx.lineWidth=1;
    if(c.X1 && c.X2){ ctx.strokeStyle="rgba(255,92,114,.5)";
      line(c.X1.px*s,0,c.X1.px*s,canvas.height); line(c.X2.px*s,0,c.X2.px*s,canvas.height); }
    if(c.Y1 && c.Y2){ ctx.strokeStyle="rgba(38,194,129,.5)";
      line(0,c.Y1.py*s,canvas.width,c.Y1.py*s); line(0,c.Y2.py*s,canvas.width,c.Y2.py*s); }
    ctx.setLineDash([]);
  }

  const tracePoly = (poly, close) => {
    ctx.beginPath(); poly.forEach((p,i) => i ? ctx.lineTo(p.px*s,p.py*s) : ctx.moveTo(p.px*s,p.py*s));
    if(close) ctx.closePath();
  };
  state.series.forEach((ser,i) => {
    if(!ser.sel) return;
    tracePoly(ser.sel, true);
    ctx.fillStyle = ser.color + "22"; ctx.fill();
    ctx.setLineDash([6,4]); ctx.lineWidth = i===state.active ? 2 : 1; ctx.strokeStyle = ser.color; ctx.stroke();
    ctx.setLineDash([]);
  });
  if(state.lasso){ tracePoly(state.lasso, false); ctx.lineWidth = 1.5; ctx.strokeStyle = "#fff"; ctx.stroke(); }

  if($("showFit").checked) state.series.forEach(ser => {
    if(ser.points.length<2) return;
    tracePoly(ser.points, false);
    ctx.lineWidth=3.5; ctx.strokeStyle="rgba(0,0,0,.55)"; ctx.stroke();
    ctx.lineWidth=1.5; ctx.strokeStyle=ser.color; ctx.stroke();
  });
  state.series.forEach((ser,i) => {
    ctx.fillStyle = ser.color;
    ctx.strokeStyle = i===state.active ? "#fff" : "rgba(255,255,255,.4)";
    ctx.lineWidth = i===state.active ? 1.5 : 1;
    for(const pt of ser.points){
      ctx.beginPath(); ctx.arc(pt.px*s, pt.py*s, i===state.active?4:3, 0, Math.PI*2);
      ctx.fill(); ctx.stroke();
    }
  });
  if(state.selPt){
    ctx.strokeStyle="#ffe14d"; ctx.lineWidth=2;
    ctx.beginPath(); ctx.arc(state.selPt.px*s, state.selPt.py*s, 8, 0, Math.PI*2); ctx.stroke();
  }
}
function line(x1,y1,x2,y2){ ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke(); }
function drawCross(x,y,color,label){
  ctx.strokeStyle=color; ctx.lineWidth=2;
  line(x-8,y,x+8,y); line(x,y-8,x,y+8);
  ctx.fillStyle=color; ctx.font="bold 12px system-ui"; ctx.fillText(label, x+9, y-9);
}

// ============================================================ transform
function interp(p, p1, v1, p2, v2, log){
  const t = (p - p1) / (p2 - p1);
  if(log){ if(v1<=0||v2<=0) return NaN;
    const l1=Math.log10(v1), l2=Math.log10(v2); return Math.pow(10, l1 + t*(l2-l1)); }
  return v1 + t*(v2 - v1);
}
function calibrated(){
  const c = state.cal;
  return c.X1&&c.X2&&c.Y1&&c.Y2 &&
    isFinite(c.X1.val)&&isFinite(c.X2.val)&&isFinite(c.Y1.val)&&isFinite(c.Y2.val);
}
function pxToData(px, py){
  const c = state.cal;
  return { x: interp(px, c.X1.px, c.X1.val, c.X2.px, c.X2.val, state.logX),
           y: interp(py, c.Y1.py, c.Y1.val, c.Y2.py, c.Y2.val, state.logY) };
}

// ============================================================ modes
function setMode(m){
  state.mode = m;
  if(m!=="calibrate") state.calTarget = null;
  canvas.className = "mode-" + m;
  document.querySelectorAll(".mbtn").forEach(b => b.classList.toggle("active", b.dataset.mode===m));
  document.querySelectorAll(".cbtn").forEach(b =>
    b.classList.toggle("active", m==="calibrate" && b.dataset.cal===state.calTarget));
}
document.querySelectorAll(".mbtn").forEach(b => b.onclick = () => setMode(b.dataset.mode));
document.querySelectorAll(".cbtn").forEach(b => b.onclick = () => { state.calTarget = b.dataset.cal; setMode("calibrate"); });

for(const k in valMap){
  $(valMap[k]).addEventListener("input", e => {
    if(state.cal[k]) state.cal[k].val = parseFloat(e.target.value);
    updateCalibStatus();
  });
}
$("logX").addEventListener("change", e => { state.logX = e.target.checked; refreshData(); });
$("logY").addEventListener("change", e => { state.logY = e.target.checked; refreshData(); });

$("cornerMode").addEventListener("change", e => {
  state.cornerMode = e.target.checked;
  $("buttons4").hidden = state.cornerMode;
  $("buttons2").hidden = !state.cornerMode;
  if(state.cornerMode){
    $("lblX1").textContent="X min"; $("lblX2").textContent="X max";
    $("lblY1").textContent="Y min"; $("lblY2").textContent="Y max";
    $("calibHint").textContent='Set the bottom-left corner of the plot area, then the top-right. Enter the min/max axis values. Assumes rectangular, axis-aligned plots.';
  } else {
    $("lblX1").innerHTML="X&#8321; value"; $("lblX2").innerHTML="X&#8322; value";
    $("lblY1").innerHTML="Y&#8321; value"; $("lblY2").innerHTML="Y&#8322; value";
    $("calibHint").textContent='Click a "Set" button, click that reference point on the image, then type its real value.';
  }
  updateCalibStatus(); render();
});

function updateCalibStatus(){
  const c = state.cal;
  document.querySelectorAll(".cbtn").forEach(b => {
    const t = b.dataset.cal; let set=false;
    if(t==="BL") set = !!(c.X1&&c.Y1);
    else if(t==="TR") set = !!(c.X2&&c.Y2);
    else set = !!c[t];
    b.classList.toggle("set", set);
  });
  const st = $("calibStatus");
  if(calibrated()){ st.textContent="Calibrated ✓"; st.className="status ok"; }
  else {
    if(state.cornerMode){
      const n=(c.X1&&c.Y1?1:0)+(c.X2&&c.Y2?1:0);
      st.textContent=`${n}/2 corners placed`+(n===2?" – enter min/max values":"");
    } else {
      const n=["X1","X2","Y1","Y2"].filter(k=>c[k]).length;
      st.textContent=`${n}/4 points placed`+(n===4?" – enter all values":"");
    }
    st.className="status";
  }
  refreshData();
}

// ============================================================ canvas interaction
function canvasToNatural(e){
  const r = canvas.getBoundingClientRect();
  return { px:(e.clientX-r.left)/state.scale, py:(e.clientY-r.top)/state.scale };
}
let panning=false, panStart=null, justDragged=false;
canvas.addEventListener("mousedown", e => {
  if(!state.img) return;
  if(state.mode==="pan"){ panning=true; panStart={x:e.clientX,y:e.clientY,l:wrap.scrollLeft,t:wrap.scrollTop}; canvas.style.cursor="grabbing"; }
  else if(state.mode==="lasso" && state.series[state.active]){ state.lasso=[canvasToNatural(e)]; }
  else if(state.mode==="points" && state.series[state.active]){
    const ser=state.series[state.active], {px,py}=canvasToNatural(e), i=nearestPoint(ser,px,py);
    if(i>=0){ state.drag={ser,pt:ser.points[i],moved:false}; state.selPt=ser.points[i]; render(); }
  }
});
window.addEventListener("mousemove", e => {
  if(panning && panStart){ wrap.scrollLeft=panStart.l-(e.clientX-panStart.x); wrap.scrollTop=panStart.t-(e.clientY-panStart.y); }
  if(state.drag){ const p=canvasToNatural(e); Object.assign(state.drag.pt,p); state.drag.moved=true; render(); }
  if(state.lasso){
    const p=canvasToNatural(e), q=state.lasso[state.lasso.length-1];
    if(Math.hypot(p.px-q.px,p.py-q.py)*state.scale>=3){ state.lasso.push(p); render(); }
  }
});
window.addEventListener("mouseup", () => {
  if(panning){ panning=false; canvas.style.cursor=""; }
  if(state.drag){
    const d=state.drag; state.drag=null;
    justDragged=true; setTimeout(()=>justDragged=false,0);   // swallow the click that follows
    if(d.moved){ sortPoints(d.ser); afterEdit(); }
  }
  if(state.lasso){
    const ser=state.series[state.active];
    if(state.lasso.length>=3 && ser) ser.sel=state.lasso;
    state.lasso=null; renderSeries(); render(); commit();
  }
});

canvas.addEventListener("mousemove", e => {
  if(!state.img) return;
  const {px,py} = canvasToNatural(e);
  updateLoupe(e, px, py);
  const ro = $("cursorReadout");
  if(calibrated()){ const d=pxToData(px,py); ro.textContent=`x: ${fmt(d.x)}   y: ${fmt(d.y)}`; }
  else ro.textContent=`px: ${Math.round(px)}, ${Math.round(py)}`;
});
canvas.addEventListener("mouseleave", () => { loupe.style.display="none"; });

canvas.addEventListener("click", e => {
  if(!state.img || panning || justDragged) return;
  const {px,py} = canvasToNatural(e);

  if(state.mode==="calibrate" && state.calTarget){
    const t = state.calTarget;
    if(t==="BL"){
      state.cal.X1={px,py,val:parseFloat($("valX1").value)};
      state.cal.Y1={px,py,val:parseFloat($("valY1").value)};
    } else if(t==="TR"){
      state.cal.X2={px,py,val:parseFloat($("valX2").value)};
      state.cal.Y2={px,py,val:parseFloat($("valY2").value)};
    } else {
      state.cal[t]={px,py,val:parseFloat($(valMap[t]).value)};
    }
    state.calTarget=null; setMode("points"); updateCalibStatus(); render(); return;
  }
  if(state.mode==="eyedropper"){
    const col = sampleColor(px,py);
    if(col) setAutoColor(col);
    setMode("points"); return;
  }
  if(state.mode==="trace"){ traceAt(px,py); return; }
  const ser = state.series[state.active];
  if(!ser) return;
  if(state.mode==="points"){
    const pt = $("snap").checked ? (snapPoint(px,py) || {px,py}) : {px,py};
    ser.points.push(pt); state.selPt=pt; sortPoints(ser); afterEdit();
  }
  else if(state.mode==="delete"){ const idx=nearestPoint(ser,px,py); if(idx>=0){ ser.points.splice(idx,1); afterEdit(); } }
});
function nearestPoint(ser, px, py){
  let best=-1, bd=(12/state.scale)**2;
  ser.points.forEach((pt,i)=>{ const d=(pt.px-px)**2+(pt.py-py)**2; if(d<bd){ bd=d; best=i; } });
  return best;
}
function sortPoints(ser){ ser.points.sort((a,b)=>a.px-b.px); }
function afterEdit(){ render(); refreshData(); commit(); }

function updateLoupe(e, px, py){
  if(!state.img){ loupe.style.display="none"; return; }
  const zoom=6, size=150, half=size/(2*zoom);
  loupe.style.display="block";
  const wr = wrap.getBoundingClientRect();
  let lx=e.clientX-wr.left+20, ly=e.clientY-wr.top+20;
  if(lx+size>wrap.clientWidth) lx=e.clientX-wr.left-size-20;
  if(ly+size>wrap.clientHeight) ly=e.clientY-wr.top-size-20;
  loupe.style.left=lx+"px"; loupe.style.top=ly+"px";
  lctx.clearRect(0,0,size,size); lctx.imageSmoothingEnabled=false;
  lctx.drawImage(state.img, px-half, py-half, half*2, half*2, 0,0, size, size);
  lctx.strokeStyle="rgba(255,255,255,.8)"; lctx.lineWidth=1;
  lctx.beginPath(); lctx.moveTo(size/2,0); lctx.lineTo(size/2,size);
  lctx.moveTo(0,size/2); lctx.lineTo(size,size/2); lctx.stroke();
}
function bgRGB(){
  if(state.bg!==undefined) return state.bg;
  const {data,width:W,height:H}=state.imgData, cnt=new Map();
  const add=i=>{ const k=(data[i*4]>>3)<<10|(data[i*4+1]>>3)<<5|(data[i*4+2]>>3); const e=cnt.get(k); e?e.n++:cnt.set(k,{n:1,r:data[i*4],g:data[i*4+1],b:data[i*4+2]}); };
  for(let x=0;x<W;x++){ add(x); add((H-1)*W+x); }
  for(let y=0;y<H;y++){ add(y*W); add(y*W+W-1); }
  let best=null; cnt.forEach(e=>{ if(!best||e.n>best.n) best=e; });
  return state.bg=best;
}
function setAutoColor(col){ state.autoColor=col; $("colorSwatch").style.background=`rgb(${col.r},${col.g},${col.b})`; }
// click near a thin curve: take the pixel in a small window that differs most from the background
function traceAt(px,py){
  if(!state.imgData){ alert("Load an image first."); return; }
  const {data,width:W,height:H}=state.imgData, bg=bgRGB(), cx=Math.round(px), cy=Math.round(py);
  let best=null, bd=-1, bx=cx, by=cy;
  for(let y=Math.max(0,cy-3);y<=Math.min(H-1,cy+3);y++) for(let x=Math.max(0,cx-3);x<=Math.min(W-1,cx+3);x++){
    const i=(y*W+x)*4, d=(data[i]-bg.r)**2+(data[i+1]-bg.g)**2+(data[i+2]-bg.b)**2;
    if(d>bd){ bd=d; best={r:data[i],g:data[i+1],b:data[i+2]}; bx=x; by=y; }
  }
  if(!best||bd<30*30*3){ alert("That spot looks like background. Click directly on the curve."); return; }
  setAutoColor(best);
  if($("autoKind").value==="markers"){ const s=measureMarker(bx,by); if(s) $("markerSize").value=s; }
  $("runAuto").onclick();
}
// nearest pixel of the picked colour within a small radius, refined to the centre of its stroke
function snapPoint(px,py){
  if(!state.imgData||!state.autoColor) return null;
  const {data,width:W,height:H}=state.imgData, {r,g,b}=state.autoColor, t2=(+$("tolerance").value)**2*3;
  const R=Math.max(3,12/state.scale), hit=(x,y)=>{ const i=(y*W+x)*4; return (data[i]-r)**2+(data[i+1]-g)**2+(data[i+2]-b)**2<=t2; };
  let n=null, nd=R*R;
  for(let y=Math.max(0,Math.floor(py-R));y<=Math.min(H-1,Math.ceil(py+R));y++)
    for(let x=Math.max(0,Math.floor(px-R));x<=Math.min(W-1,Math.ceil(px+R));x++){
      const d=(x-px)**2+(y-py)**2; if(d<nd&&hit(x,y)){ nd=d; n={x,y}; } }
  if(!n) return null;
  let sx=0,sy=0,c=0;
  for(let y=Math.max(0,n.y-3);y<=Math.min(H-1,n.y+3);y++) for(let x=Math.max(0,n.x-3);x<=Math.min(W-1,n.x+3);x++) if(hit(x,y)){ sx+=x; sy+=y; c++; }
  return {px:sx/c,py:sy/c};
}
function sampleColor(px,py){
  if(!state.imgData) return null;
  const x=Math.round(px), y=Math.round(py), w=state.imgData.width;
  if(x<0||y<0||x>=w||y>=state.imgData.height) return null;
  const i=(y*w+x)*4, d=state.imgData.data;
  return { r:d[i], g:d[i+1], b:d[i+2] };
}

// ============================================================ series
function addSeries(){
  const color = PALETTE[state.series.length % PALETTE.length];
  state.series.push({ name:"Series "+(state.series.length+1), color, points:[] });
  state.active = state.series.length-1;
  renderSeries(); refreshData(); commit();
}
function renderSeries(){
  const list = $("seriesList"); list.innerHTML="";
  state.series.forEach((ser,i)=>{
    const div=document.createElement("div");
    div.className="series-item"+(i===state.active?" active":"");
    div.innerHTML=`<input type="color" value="${ser.color}">
      <input type="text" value="${ser.name.replace(/"/g,'&quot;')}">
      ${ser.sel?'<span class="sel" title="Has a lasso region">&#11036;</span>':''}
      <span class="count">${ser.points.length}</span>
      <button class="del" title="Delete series">&times;</button>`;
    div.querySelector('input[type=color]').oninput = e=>{ ser.color=e.target.value; render(); };
    div.querySelector('input[type=text]').oninput  = e=>{ ser.name=e.target.value; refreshData(); };
    div.querySelector('input[type=color]').onchange = commit;
    div.querySelector('input[type=text]').onchange  = commit;
    div.querySelector('.del').onclick = e=>{ e.stopPropagation(); deleteSeries(i); };
    div.onclick = ()=>{ state.active=i; renderSeries(); render(); };
    list.appendChild(div);
  });
}
function deleteSeries(i){
  state.series.splice(i,1);
  if(state.active>=state.series.length) state.active=state.series.length-1;
  renderSeries(); afterEdit();
}
$("addSeries").onclick = addSeries;
$("undoPoint").onclick = ()=>{ const s=state.series[state.active]; if(s&&s.points.length){ s.points.pop(); afterEdit(); } };
$("clearSeries").onclick = ()=>{ const s=state.series[state.active]; if(s){ s.points=[]; afterEdit(); } };

// ============================================================ automatic extraction (cluster + continuity trace)
$("eyedropper").onclick = ()=> setMode("eyedropper");
$("tolerance").oninput = e=> $("tolVal").textContent=e.target.value;
$("xstep").oninput = e=> $("stepVal").textContent=e.target.value;

function regionBox(){
  const c=state.cal, W=state.imgData.width, H=state.imgData.height;
  let x0=0,x1=W-1,y0=0,y1=H-1;
  if(c.X1&&c.X2){ x0=Math.max(0,Math.floor(Math.min(c.X1.px,c.X2.px))); x1=Math.min(W-1,Math.ceil(Math.max(c.X1.px,c.X2.px))); }
  if(c.Y1&&c.Y2){ y0=Math.max(0,Math.floor(Math.min(c.Y1.py,c.Y2.py))); y1=Math.min(H-1,Math.ceil(Math.max(c.Y1.py,c.Y2.py))); }
  return {x0,x1,y0,y1};
}
// rasterise a freeform selection into a W*H 0/1 mask
function buildMask(poly){
  const W=state.imgData.width, H=state.imgData.height;
  const c=document.createElement("canvas"); c.width=W; c.height=H;
  const g=c.getContext("2d",{willReadFrequently:true});
  g.beginPath(); poly.forEach((p,i)=> i ? g.lineTo(p.px,p.py) : g.moveTo(p.px,p.py)); g.closePath(); g.fill();
  const a=g.getImageData(0,0,W,H).data, m=new Uint8Array(W*H);
  for(let i=0;i<m.length;i++) m[i]=a[i*4+3]>127?1:0;
  return m;
}

// search area for ser: its lasso (bbox + mask) if set, else the calibrated box inset from the axes
function regionOf(ser){
  const W=state.imgData.width, H=state.imgData.height;
  if(ser.sel){
    const xs=ser.sel.map(p=>p.px), ys=ser.sel.map(p=>p.py);
    return { x0:Math.max(0,Math.floor(Math.min(...xs))), x1:Math.min(W-1,Math.ceil(Math.max(...xs))),
             y0:Math.max(0,Math.floor(Math.min(...ys))), y1:Math.min(H-1,Math.ceil(Math.max(...ys))), mask:buildMask(ser.sel) };
  }
  const r=regionBox(), inset=3;
  return { x0:Math.max(0,r.x0+inset), x1:Math.min(W-1,r.x1-inset), y0:Math.max(0,r.y0+inset), y1:Math.min(H-1,r.y1-inset), mask:null };
}

// ---- marker detection (circles / triangles / squares, filled or outline) ----
// connected components (8-neighbour) of a w*h 0/1 mask -> [{minx,maxx,miny,maxy,area}]
function components(m,w,h){
  const seen=new Uint8Array(w*h), stack=new Int32Array(w*h), out=[];
  for(let s=0;s<w*h;s++){
    if(!m[s]||seen[s]) continue;
    let sp=0, c={minx:w,maxx:0,miny:h,maxy:0,area:0}; stack[sp++]=s; seen[s]=1;
    while(sp){
      const i=stack[--sp], x=i%w, y=(i-x)/w;
      c.area++; if(x<c.minx)c.minx=x; if(x>c.maxx)c.maxx=x; if(y<c.miny)c.miny=y; if(y>c.maxy)c.maxy=y;
      for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
        const nx=x+dx, ny=y+dy; if(nx<0||ny<0||nx>=w||ny>=h) continue;
        const n=ny*w+nx; if(m[n]&&!seen[n]){ seen[n]=1; stack[sp++]=n; }
      }
    }
    out.push(c);
  }
  return out;
}
// outline markers -> solid: anything not reachable from the border through empty pixels is "inside"
function fillHoles(m,w,h){
  const out=new Uint8Array(m), seen=new Uint8Array(w*h), stack=new Int32Array(w*h); let sp=0;
  const push=i=>{ if(!m[i]&&!seen[i]){ seen[i]=1; stack[sp++]=i; } };
  for(let x=0;x<w;x++){ push(x); push((h-1)*w+x); }
  for(let y=0;y<h;y++){ push(y*w); push(y*w+w-1); }
  while(sp){
    const i=stack[--sp], x=i%w, y=(i-x)/w;
    if(x>0)push(i-1); if(x<w-1)push(i+1); if(y>0)push(i-w); if(y<h-1)push(i+w);
  }
  for(let i=0;i<w*h;i++) if(!m[i]&&!seen[i]) out[i]=1;
  return out;
}
// square erosion / dilation of radius r (separable; pixels outside the area are ignored)
function boxFilter(src,w,h,r,erode){
  const tmp=new Uint8Array(w*h), out=new Uint8Array(w*h);
  const pass=(a,b,horiz)=>{
    const n1=horiz?w:h, n2=horiz?h:w;
    for(let u=0;u<n2;u++) for(let v=0;v<n1;v++){
      let acc=erode?1:0;
      for(let k=-r;k<=r;k++){
        const q=v+k; if(q<0||q>=n1) continue;
        const val=a[horiz?u*w+q:q*w+u];
        if(erode){ if(!val){ acc=0; break; } } else if(val){ acc=1; break; }
      }
      b[horiz?u*w+v:v*w+u]=acc;
    }
  };
  pass(src,tmp,true); pass(tmp,out,false);
  return out;
}
function colorMask(x0,y0,w,h,mask){
  const {data,width:W}=state.imgData, {r,g,b}=state.autoColor, t2=(+$("tolerance").value)**2*3;
  const m=new Uint8Array(w*h);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=(y+y0)*W+x+x0;
    if(mask&&!mask[i]) continue;
    const dr=data[i*4]-r, dg=data[i*4+1]-g, db=data[i*4+2]-b;
    if(dr*dr+dg*dg+db*db<=t2) m[y*w+x]=1;
  }
  return m;
}
// Find every blob of the picked colour in ser's region and return its centre. Shape-agnostic:
// holes are filled (outline markers), then an opening removes thin lines/text that touch the markers.
function detectMarkers(ser){
  const {x0,x1,y0,y1,mask}=regionOf(ser), w=x1-x0+1, h=y1-y0+1;
  if(w<3||h<3){ alert("The search area is too small."); return null; }
  const m=colorMask(x0,y0,w,h,mask);
  let d=+$("markerSize").value;
  if(!(d>0)){   // auto size: median of the compact blobs
    const s=components(m,w,h).map(c=>({bw:c.maxx-c.minx+1,bh:c.maxy-c.miny+1}))
      .filter(c=>Math.max(c.bw,c.bh)>=4&&Math.max(c.bw,c.bh)<=80&&Math.max(c.bw,c.bh)<=1.6*Math.min(c.bw,c.bh))
      .map(c=>Math.max(c.bw,c.bh)).sort((a,b)=>a-b);
    d=s.length?s[s.length>>1]:10;
    $("markerSize").placeholder="auto: "+d;
  }
  const f=fillHoles(m,w,h), rho=Math.max(1,Math.floor(d*0.2));
  const core=boxFilter(boxFilter(f,w,h,rho,true),w,h,rho,false);   // opening
  const near=boxFilter(core,w,h,rho,false);
  for(let i=0;i<f.length;i++) near[i]&=f[i];                       // restore tips / corners
  const pts=components(near,w,h)
    .filter(c=>c.area>=Math.max(6,0.15*d*d)&&c.maxx-c.minx+1<=2.2*d&&c.maxy-c.miny+1<=2.2*d)
    .map(c=>({px:x0+(c.minx+c.maxx)/2,py:y0+(c.miny+c.maxy)/2}))
    .sort((a,b)=>a.px-b.px);
  if(!pts.length){ alert("No markers found. Check the colour, tolerance and marker size, or pick a marker with Trace."); return null; }
  return pts;
}
// click on a marker: measure its size from the connected blob of the picked colour around (cx,cy)
function measureMarker(cx,cy){
  const {width:W,height:H}=state.imgData, R=80;
  const x0=Math.max(0,cx-R), y0=Math.max(0,cy-R), w=Math.min(W,cx+R+1)-x0, h=Math.min(H,cy+R+1)-y0;
  const m=colorMask(x0,y0,w,h,null);
  const seed=(cy-y0)*w+(cx-x0); if(!m[seed]) return 0;
  const only=new Uint8Array(w*h), stack=[seed]; only[seed]=1;
  while(stack.length){
    const i=stack.pop(), x=i%w, y=(i-x)/w;
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
      const nx=x+dx, ny=y+dy; if(nx<0||ny<0||nx>=w||ny>=h) continue;
      const n=ny*w+nx; if(m[n]&&!only[n]){ only[n]=1; stack.push(n); }
    }
  }
  const c=components(only,w,h)[0], s=Math.max(c.maxx-c.minx,c.maxy-c.miny)+1;
  // if the marker is joined to a line its bbox is meaningless; estimate from the largest square that fits inside
  const filled=fillHoles(only,w,h);
  let k=0; while(k<40 && boxFilter(filled,w,h,k+1,true).some(v=>v)) k++;
  const est=Math.round(1.4*(2*k+1));
  return s<=2.2*est ? s : est;
}

// Trace up to n same-coloured curves inside ser's region (lasso if set, else the calibrated box).
// Returns an array of point lists (top curve first) or null on failure.
function traceCurves(ser, n){
  const tol=+$("tolerance").value, step=+$("xstep").value;
  const {data,width:W,height:H}=state.imgData, tol2=tol*tol*3;
  const {r:tr,g:tg,b:tb}=state.autoColor, gap=2;
  const {x0,x1,y0,y1,mask}=regionOf(ser);
  const maxThick=Math.max(15,(y1-y0)*0.5);

  // 1. per column, cluster matched rows into contiguous runs
  const cols=[];
  for(let x=x0;x<=x1;x+=step){
    const clusters=[]; let s=null,p=null;
    for(let y=y0;y<=y1;y++){
      const i=y*W+x;
      if(mask && !mask[i]) continue;
      const dr=data[i*4]-tr, dg=data[i*4+1]-tg, db=data[i*4+2]-tb;
      if(dr*dr+dg*dg+db*db<=tol2){
        if(s===null){ s=y; p=y; } else if(y-p<=gap){ p=y; } else { clusters.push({c:(s+p)/2,n:p-s+1}); s=y; p=y; }
      }
    }
    if(s!==null) clusters.push({c:(s+p)/2,n:p-s+1});
    // drop clusters too tall to be a curve (vertical gridlines, axes, solid fills)
    cols.push({x,clusters:clusters.filter(cl=>cl.n<=maxThick)});
  }
  if(!cols.some(c=>c.clusters.length)){ alert("No matching pixels found. Raise the tolerance or re-pick the colour."); return null; }

  // 2. seed column: the one where the n thickest clusters are strongest (prefer columns that have all n)
  const top=col=>col.clusters.slice().sort((a,b)=>b.n-a.n).slice(0,n);
  const score=col=>(col.clusters.length>=n?1e6:0)+top(col).reduce((s,c)=>s+c.n,0);
  let si=0, bs=-1;
  cols.forEach((col,i)=>{ const sc=score(col); if(sc>bs){ bs=sc; si=i; } });
  const seeds=top(cols[si]).sort((a,b)=>a.c-b.c).map(cl=>({x:cols[si].x,y:cl.c,n:cl.n}));

  // 3. follow each curve outward from the seed; each column's clusters are matched to curves
  //    greedily by (thickness - distance from the curve's extrapolated position)
  const maxJump=Math.max(10,(y1-y0)*0.25), THICK_GAIN=6;
  const follow=order=>{
    const T=seeds.map(s=>({x:s.x,y:s.y,vy:0,th:s.n,pts:[]}));
    for(const col of order){
      const pred=T.map(t=>t.y+t.vy*(col.x-t.x));
      // curves crossing: a cluster much thicker than the curves, spanning 2+ predictions, is a merge.
      // Those curves coast on their extrapolated path instead of snapping to the merged centre.
      const coast=new Set(), dead=new Set();
      col.clusters.forEach((cl,ci)=>{
        const in_=T.map((t,ti)=>ti).filter(ti=>Math.abs(pred[ti]-cl.c)<=cl.n/2+2);
        if(in_.length>=2 && cl.n>1.3*Math.max(...in_.map(ti=>T[ti].th))){ in_.forEach(ti=>coast.add(ti)); dead.add(ci); }
      });
      const pairs=[];
      T.forEach((t,ti)=>{
        if(coast.has(ti)) return;
        col.clusters.forEach((cl,ci)=>{ if(dead.has(ci)) return; const d=Math.abs(cl.c-pred[ti]); if(d<=maxJump) pairs.push({ti,ci,s:THICK_GAIN*cl.n-d}); });
      });
      pairs.sort((a,b)=>b.s-a.s);
      const ut=new Set(), uc=new Set();
      for(const p of pairs){
        if(ut.has(p.ti)||uc.has(p.ci)) continue;
        ut.add(p.ti); uc.add(p.ci);
        const t=T[p.ti], cl=col.clusters[p.ci];
        t.vy=0.5*t.vy+0.5*(cl.c-t.y)/(col.x-t.x); t.th=0.8*t.th+0.2*cl.n;
        t.x=col.x; t.y=cl.c; t.pts.push({px:col.x,py:cl.c});
      }
      coast.forEach(ti=>{ const t=T[ti]; t.x=col.x; t.y=pred[ti]; t.pts.push({px:col.x,py:pred[ti]}); });
    }
    return T.map(t=>t.pts);
  };
  const right=follow(cols.slice(si+1)), left=follow(cols.slice(0,si).reverse());
  const bridge=+$("bridge").value;
  const fill=pts=>{ if(!bridge) return pts; const o=[pts[0]];
    for(let i=1;i<pts.length;i++){ const a=pts[i-1], b=pts[i], dx=b.px-a.px;
      if(dx>step*1.5 && dx<=bridge) for(let x=a.px+step;x<b.px;x+=step) o.push({px:x,py:a.py+(b.py-a.py)*(x-a.px)/dx});
      o.push(b); }
    return o; };
  const out=seeds.map((s,k)=>[...left[k].reverse(),{px:s.x,py:s.y},...right[k]]).filter(p=>p.length>=2).map(fill);
  if(!out.length){ alert("Couldn't trace a continuous curve. Try a different tolerance / colour, or place points by hand."); return null; }
  return out;
}

// Trace into series `si`; extra curves go into the following series (created if missing).
function extractInto(si, n){
  const markers=$("autoKind").value==="markers";
  const tracks=markers ? [detectMarkers(state.series[si])].filter(Boolean) : traceCurves(state.series[si], n);
  if(!tracks||!tracks.length) return false;
  const act=state.active;
  tracks.forEach((pts,k)=>{
    while(si+k>=state.series.length) addSeries();
    state.series[si+k].points=pts;
  });
  state.active=act; renderSeries(); afterEdit();
  return true;
}
function autoPrecheck(){
  if(!state.imgData){ alert("Load an image first (auto extract needs pixel access)."); return false; }
  if(!state.autoColor){ alert("Pick the curve / marker colour first (Pick colour, or the Trace tool)."); return false; }
  return true;
}
$("runAuto").onclick = ()=>{
  if(!autoPrecheck()) return;
  if(!state.series[state.active]){ alert("Add a series first."); return; }
  const n=$("autoKind").value==="markers" ? 1 : Math.max(1,Math.min(12,Math.round(+$("nCurves").value)||1));
  const clobber=state.series.slice(state.active+1,state.active+n).some(s=>s.points.length);
  if(clobber && !confirm("Extra curves are written into the next series, replacing their points. Continue?")) return;
  extractInto(state.active,n);
};
$("runRegions").onclick = ()=>{
  if(!autoPrecheck()) return;
  const idx=state.series.map((s,i)=>s.sel?i:-1).filter(i=>i>=0);
  if(!idx.length){ alert("Draw a region (Lasso) for at least one series first."); return; }
  idx.forEach(i=>extractInto(i,1));
};
$("clearRegion").onclick = ()=>{ const s=state.series[state.active]; if(s){ s.sel=null; renderSeries(); render(); commit(); } };

// ============================================================ data table + CSV
function fmt(v){
  if(!isFinite(v)) return "NaN";
  const a=Math.abs(v);
  if(a!==0 && (a<1e-4||a>=1e6)) return v.toExponential(4);
  return (Math.round(v*1e6)/1e6).toString();
}
function seriesData(ser){ return ser.points.map(p=>pxToData(p.px,p.py)); }
function refreshData(){
  renderSeriesCounts();
  const tbl=$("dataTable");
  const total=state.series.reduce((n,s)=>n+s.points.length,0);
  $("pointCount").textContent=`(${total} point${total===1?"":"s"})`;
  if(!calibrated()){ tbl.innerHTML=`<tr><td style="text-align:left;color:var(--muted);border:none;padding:8px">Calibrate the axes to see data values.</td></tr>`; return; }
  const cols=state.series.map(seriesData);
  const maxLen=Math.max(0,...state.series.map(s=>s.points.length));
  let head="<tr>"; state.series.forEach(s=>{ head+=`<th>${esc(s.name)} X</th><th>${esc(s.name)} Y</th>`; }); head+="</tr>";
  let body="";
  for(let r=0;r<maxLen;r++){
    body+="<tr>";
    cols.forEach(col=>{ if(col[r]) body+=`<td>${fmt(col[r].x)}</td><td>${fmt(col[r].y)}</td>`; else body+="<td></td><td></td>"; });
    body+="</tr>";
  }
  tbl.innerHTML=head+body;
}
function renderSeriesCounts(){
  document.querySelectorAll("#seriesList .series-item").forEach((el,i)=>{
    const c=el.querySelector(".count"); if(c&&state.series[i]) c.textContent=state.series[i].points.length;
  });
}
function esc(s){ return String(s).replace(/[&<>]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[m])); }

function buildCSV(){
  if(!calibrated()) return null;
  const fmtN=v=>isFinite(v)?(Math.round(v*1e8)/1e8):"";
  const q=s=>/[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;
  if($("csvFormat").value==="long"){
    let out="series,x,y\n";
    state.series.forEach(s=>seriesData(s).forEach(d=>{ out+=`${q(s.name)},${fmtN(d.x)},${fmtN(d.y)}\n`; }));
    return out;
  }
  const cols=state.series.map(seriesData);
  const maxLen=Math.max(0,...state.series.map(s=>s.points.length));
  let out=state.series.map(s=>`${q(s.name+" x")},${q(s.name+" y")}`).join(",")+"\n";
  for(let r=0;r<maxLen;r++) out+=cols.map(col=>col[r]?`${fmtN(col[r].x)},${fmtN(col[r].y)}`:",").join(",")+"\n";
  return out;
}
function csvFileName(){
  const n=$("csvName").value.trim().replace(/\.csv$/i,"").replace(/[\\/:*?"<>|]+/g,"_");
  return (n||"digitized-data")+".csv";
}
$("exportCsv").onclick=()=>{
  const csv=buildCSV();
  if(!csv){ alert("Calibrate the axes (all points + values) before exporting."); return; }
  const blob=new Blob([csv],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=csvFileName(); a.click();
  URL.revokeObjectURL(a.href);
};
$("copyCsv").onclick=async()=>{
  const csv=buildCSV();
  if(!csv){ alert("Calibrate the axes before copying."); return; }
  try{ await navigator.clipboard.writeText(csv); const b=$("copyCsv"), t=b.textContent; b.textContent="Copied!"; setTimeout(()=>b.textContent=t,1200); }
  catch(e){ alert("Clipboard blocked. Use Download CSV instead."); }
};
$("dataDrawerHandle").onclick=()=>$("dataDrawer").classList.toggle("open");

// ============================================================ auto calibration (axis + tick detection)
// Finds the x-axis (bottom-most long ink row) and y-axis (left-most long ink column), then their tick marks.
function detectAxes(){
  if(state.axes!==undefined) return state.axes;
  const {data,width:W,height:H}=state.imgData;
  const L=new Float32Array(W*H);
  for(let i=0;i<W*H;i++){ const a=data[i*4+3]/255; L[i]=(0.299*data[i*4]+0.587*data[i*4+1]+0.114*data[i*4+2])*a+255*(1-a); }
  const hist=new Uint32Array(256), edge=i=>hist[L[i]|0]++;
  for(let x=0;x<W;x++){ edge(x); edge((H-1)*W+x); }
  for(let y=0;y<H;y++){ edge(y*W); edge(y*W+W-1); }
  const bg=hist.indexOf(Math.max(...hist));
  const ink=new Uint8Array(W*H);
  for(let i=0;i<W*H;i++) ink[i]=Math.abs(L[i]-bg)>100?1:0;

  const rc=new Uint32Array(H), cc=new Uint32Array(W);
  for(let y=0;y<H;y++) for(let x=0;x<W;x++) if(ink[y*W+x]){ rc[y]++; cc[x]++; }
  // bottom-most / left-most "strong" line, grown into its full thickness band
  const band=(cnt,minLen)=>{
    const strong=Math.max(minLen,0.6*Math.max(...cnt));
    let hi=-1; for(let i=cnt.length-1;i>=0;i--) if(cnt[i]>=strong){ hi=i; break; }
    return hi<0?null:{hi};
  };
  const rb=band(rc,0.2*W), cb=band(cc,0.2*H);
  if(!rb||!cb){ return state.axes=null; }
  const grow=(cnt,hi,dir)=>{ const t=0.5*cnt[hi]; let i=hi; while(cnt[i+dir]>=t) i+=dir; return i; };
  // x-axis band rows [xt,xb]; y-axis band cols [yl,yr] (left-most strong column)
  let yl=-1; { const strong=Math.max(0.2*H,0.6*Math.max(...cc)); for(let i=0;i<W;i++) if(cc[i]>=strong){ yl=i; break; } }
  const xb=rb.hi, xt=grow(rc,xb,-1), yr=grow(cc,yl,1);
  const ay=(xt+xb)/2, ax=(yl+yr)/2;
  // extent of the axis lines (longest run with small gaps)
  const run=(get,len,mid)=>{ let best=[mid,mid], s=-1, last=-1;
    for(let i=0;i<=len;i++){ const on=i<len&&get(i);
      if(on){ if(s<0) s=i; last=i; }
      else if(s>=0 && i-last>3){ if(s<=mid&&mid<=last+3||last-s>best[1]-best[0]) best=[s,last]; s=-1; } }
    return best; };
  const [x0,x1]=run(i=>ink[Math.round(ay)*W+i],W,Math.round(ax));
  const [y0,y1]=run(i=>ink[i*W+Math.round(ax)],H,Math.round(ay));
  // tick marks: short perpendicular ink strokes just outside (preferred) or inside the axis
  const ticks=(from,to,count,perp)=>{ // perp(i,d) = ink at position i, offset d from axis
    const find=side=>{ const hits=[]; for(let i=from;i<=to;i++){ let n=0; for(let d=1;d<=6;d++) n+=perp(i,side*d); if(n>=3) hits.push(i); }
      const cl=[]; let g=[];
      for(const h of hits){ if(g.length&&h-g[g.length-1]>1){ cl.push(g); g=[]; } g.push(h); }
      if(g.length) cl.push(g);
      return cl.filter(c=>c.length<=6).map(c=>(c[0]+c[c.length-1])/2); };
    const out=find(1), inn=find(-1);
    return out.length>=2?out:inn.length>=2?inn:null; };
  const xTicks=ticks(x0,x1,0,(i,d)=>{ const y=d>0?xb+d:xt+d; return y>=0&&y<H?ink[y*W+i]:0; });
  const yTicks=ticks(y0,y1,0,(i,d)=>{ const x=d>0?yl-d:yr-d; return x>=0&&x<W?ink[i*W+x]:0; });
  return state.axes={ ay, ax, x0, x1, y0, y1, xTicks, yTicks };
}
function autoCal(t){
  if(!state.imgData){ alert("Load an image first."); return; }
  const A=detectAxes();
  if(!A){ alert("Couldn't find the axes automatically. Place the points by hand."); return; }
  const first=a=>a[0], last=a=>a[a.length-1];
  let note="";
  const xs=A.xTicks||(note="x-axis",[A.x0,A.x1]), ys=A.yTicks||(note="y-axis",[A.y0,A.y1]);
  const val=k=>parseFloat($(valMap[k]).value);
  const set=(k,px,py)=>{ state.cal[k]={px,py,val:val(k)}; };
  if(t==="X1") set("X1",first(xs),A.ay);
  else if(t==="X2") set("X2",last(xs),A.ay);
  else if(t==="Y1") set("Y1",A.ax,last(ys));   // bottom
  else if(t==="Y2") set("Y2",A.ax,first(ys));   // top
  else if(t==="BL"){ set("X1",A.x0,A.ay); set("Y1",A.ax,A.y1); }
  else if(t==="TR"){ set("X2",A.x1,A.ay); set("Y2",A.ax,A.y0); }
  if(!["BL","TR"].includes(t) && ((t[0]==="X"&&!A.xTicks)||(t[0]==="Y"&&!A.yTicks)))
    alert(`No tick marks found on the ${note}; used the axis end instead. Nudge with Set if needed.`);
  updateCalibStatus(); render();
  const f=$(valMap[t==="BL"?"X1":t==="TR"?"X2":t]); if(f) f.focus();
}
document.querySelectorAll(".abtn").forEach(b => b.onclick = () => autoCal(b.dataset.auto));

// ============================================================ undo / redo / hotkeys
const hist={stack:[],i:-1};
function commit(){
  const j=JSON.stringify({a:state.active,s:state.series.map(s=>({name:s.name,color:s.color,points:s.points,sel:s.sel||null}))});
  if(hist.stack[hist.i]===j) return;
  hist.stack.length=hist.i+1; hist.stack.push(j);
  if(hist.stack.length>100) hist.stack.shift();
  hist.i=hist.stack.length-1;
}
function restore(){
  const o=JSON.parse(hist.stack[hist.i]);
  state.series=o.s; state.active=Math.max(0,Math.min(o.a,o.s.length-1)); state.selPt=null;
  renderSeries(); render(); refreshData();
}
function undo(){ if(hist.i>0){ hist.i--; restore(); } }
function redo(){ if(hist.i<hist.stack.length-1){ hist.i++; restore(); } }
$("undoBtn").onclick=undo; $("redoBtn").onclick=redo;
$("showFit").onchange=render;

window.addEventListener("keydown", e=>{
  if(/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const k=e.key.toLowerCase(), mod=e.ctrlKey||e.metaKey;
  if(mod&&k==="z"){ e.preventDefault(); e.shiftKey?redo():undo(); return; }
  if(mod&&k==="y"){ e.preventDefault(); redo(); return; }
  if(mod||e.altKey) return;
  if(/^[1-9]$/.test(k)){ if(state.series[k-1]){ state.active=k-1; renderSeries(); render(); } return; }
  const modes={a:"points",d:"delete",l:"lasso",t:"trace",h:"pan"};
  if(modes[k]){ setMode(modes[k]); return; }
  if(k==="escape"){ state.selPt=null; render(); return; }
  const ser=state.series.find(s=>s.points.includes(state.selPt));
  if(!ser) return;
  const st=e.shiftKey?5:1, mv={arrowleft:[-st,0],arrowright:[st,0],arrowup:[0,-st],arrowdown:[0,st]}[k];
  if(mv){ e.preventDefault(); state.selPt.px+=mv[0]; state.selPt.py+=mv[1]; sortPoints(ser); afterEdit(); }
  else if(k==="delete"||k==="backspace"){ e.preventDefault(); ser.points.splice(ser.points.indexOf(state.selPt),1); state.selPt=null; afterEdit(); }
});

// ============================================================ init
addSeries(); setMode("points"); updateCalibStatus();
window.addEventListener("resize", ()=>{ if(state.img) render(); });

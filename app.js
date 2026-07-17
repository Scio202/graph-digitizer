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
  autoColor: null
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
    state.img = img;
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

  state.series.forEach((ser,i) => {
    ctx.fillStyle = ser.color;
    ctx.strokeStyle = i===state.active ? "#fff" : "rgba(255,255,255,.4)";
    ctx.lineWidth = i===state.active ? 1.5 : 1;
    for(const pt of ser.points){
      ctx.beginPath(); ctx.arc(pt.px*s, pt.py*s, i===state.active?4:3, 0, Math.PI*2);
      ctx.fill(); ctx.stroke();
    }
  });
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
let panning=false, panStart=null;
canvas.addEventListener("mousedown", e => {
  if(!state.img) return;
  if(state.mode==="pan"){ panning=true; panStart={x:e.clientX,y:e.clientY,l:wrap.scrollLeft,t:wrap.scrollTop}; canvas.style.cursor="grabbing"; }
});
window.addEventListener("mousemove", e => {
  if(panning && panStart){ wrap.scrollLeft=panStart.l-(e.clientX-panStart.x); wrap.scrollTop=panStart.t-(e.clientY-panStart.y); }
});
window.addEventListener("mouseup", () => { if(panning){ panning=false; canvas.style.cursor=""; } });

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
  if(!state.img || panning) return;
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
    if(col){ state.autoColor=col; $("colorSwatch").style.background=`rgb(${col.r},${col.g},${col.b})`; }
    setMode("points"); return;
  }
  const ser = state.series[state.active];
  if(!ser) return;
  if(state.mode==="points"){ ser.points.push({px,py}); sortPoints(ser); afterEdit(); }
  else if(state.mode==="delete"){ const idx=nearestPoint(ser,px,py); if(idx>=0){ ser.points.splice(idx,1); afterEdit(); } }
});
function nearestPoint(ser, px, py){
  let best=-1, bd=(12/state.scale)**2;
  ser.points.forEach((pt,i)=>{ const d=(pt.px-px)**2+(pt.py-py)**2; if(d<bd){ bd=d; best=i; } });
  return best;
}
function sortPoints(ser){ ser.points.sort((a,b)=>a.px-b.px); }
function afterEdit(){ render(); refreshData(); }

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
  renderSeries(); refreshData();
}
function renderSeries(){
  const list = $("seriesList"); list.innerHTML="";
  state.series.forEach((ser,i)=>{
    const div=document.createElement("div");
    div.className="series-item"+(i===state.active?" active":"");
    div.innerHTML=`<input type="color" value="${ser.color}">
      <input type="text" value="${ser.name.replace(/"/g,'&quot;')}">
      <span class="count">${ser.points.length}</span>
      <button class="del" title="Delete series">&times;</button>`;
    div.querySelector('input[type=color]').oninput = e=>{ ser.color=e.target.value; render(); };
    div.querySelector('input[type=text]').oninput  = e=>{ ser.name=e.target.value; refreshData(); };
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
$("runAuto").onclick = ()=>{
  if(!state.imgData){ alert("Load an image first (auto extract needs pixel access)."); return; }
  if(!state.autoColor){ alert("Pick the curve colour first."); return; }
  const ser = state.series[state.active];
  if(!ser){ alert("Add a series first."); return; }
  const tol=+$("tolerance").value, step=+$("xstep").value;
  const r=regionBox(), inset=3, W=state.imgData.width, H=state.imgData.height;
  const x0=Math.max(0,r.x0+inset), x1=Math.min(W-1,r.x1-inset);
  const y0=Math.max(0,r.y0+inset), y1=Math.min(H-1,r.y1-inset);
  const {data,width}=state.imgData, tol2=tol*tol*3;
  const {r:tr,g:tg,b:tb}=state.autoColor, gap=2;
  const maxThick=Math.max(15,(y1-y0)*0.5);

  // 1. per column, cluster matched rows into contiguous runs
  const cols=[];
  for(let x=x0;x<=x1;x+=step){
    const clusters=[]; let s=null,p=null;
    for(let y=y0;y<=y1;y++){
      const i=(y*width+x)*4;
      const dr=data[i]-tr, dg=data[i+1]-tg, db=data[i+2]-tb;
      if(dr*dr+dg*dg+db*db<=tol2){
        if(s===null){ s=y; p=y; } else if(y-p<=gap){ p=y; } else { clusters.push({c:(s+p)/2,n:p-s+1}); s=y; p=y; }
      }
    }
    if(s!==null) clusters.push({c:(s+p)/2,n:p-s+1});
    // drop clusters too tall to be a curve (vertical gridlines, axes, solid fills)
    const filtered=clusters.filter(cl=>cl.n<=maxThick);
    cols.push({x,clusters:filtered});
  }
  const withC=cols.filter(c=>c.clusters.length);
  if(!withC.length){ alert("No matching pixels found. Raise the tolerance or re-pick the colour."); return; }

  // 2. seed from the thickest cluster in the first valid column (the curve, not a 1px gridline)
  let lastY=withC[0].clusters.reduce((a,b)=>b.n>a.n?b:a).c;

  // 3. follow the cluster nearest the previous point (continuity); rejects gridlines/axes/text
  const maxJump=Math.max(10,(y1-y0)*0.25), THICK_GAIN=6;
  const pts=[];
  for(const col of cols){
    if(!col.clusters.length) continue;
    // among clusters within reach, prefer the thickest (the curve) over thin gridlines
    let best=null, bs=-Infinity;
    for(const cl of col.clusters){
      const d=Math.abs(cl.c-lastY);
      if(d>maxJump) continue;
      const score=cl.n*THICK_GAIN - d;
      if(score>bs){ bs=score; best=cl; }
    }
    if(best){ pts.push({px:col.x,py:best.c}); lastY=best.c; }
  }
  if(pts.length<2){ alert("Couldn't trace a continuous curve. Try a different tolerance / colour, or place points by hand."); return; }
  ser.points=pts; afterEdit();
};

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
$("exportCsv").onclick=()=>{
  const csv=buildCSV();
  if(!csv){ alert("Calibrate the axes (all points + values) before exporting."); return; }
  const blob=new Blob([csv],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="digitized-data.csv"; a.click();
  URL.revokeObjectURL(a.href);
};
$("copyCsv").onclick=async()=>{
  const csv=buildCSV();
  if(!csv){ alert("Calibrate the axes before copying."); return; }
  try{ await navigator.clipboard.writeText(csv); const b=$("copyCsv"), t=b.textContent; b.textContent="Copied!"; setTimeout(()=>b.textContent=t,1200); }
  catch(e){ alert("Clipboard blocked. Use Download CSV instead."); }
};
$("dataDrawerHandle").onclick=()=>$("dataDrawer").classList.toggle("open");

// ============================================================ init
addSeries(); setMode("points"); updateCalibStatus();
window.addEventListener("resize", ()=>{ if(state.img) render(); });

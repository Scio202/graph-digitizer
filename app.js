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
  box: null,            // in-progress box selection {a,b}
  selMod: null,         // {add,neg} modifiers of the selection being drawn
  hint: null,           // Trace click: curves must start within 10 px of it
  bdrag: null,          // dragging a series-bound line / node
  nextId: 0, ocr: null,
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
    state.img = img; state.axes = undefined; state.bg = undefined; state.ocr = null;
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

  const tracePath = (pts, close, spline) => {
    ctx.beginPath(); if(!pts.length) return;
    ctx.moveTo(pts[0].px*s, pts[0].py*s);
    if(spline && pts.length>2){
      for(let i=0;i<pts.length-1;i++){
        const p0=pts[i-1]||pts[i], p1=pts[i], p2=pts[i+1], p3=pts[i+2]||p2;
        ctx.bezierCurveTo((p1.px+(p2.px-p0.px)/6)*s,(p1.py+(p2.py-p0.py)/6)*s,(p2.px-(p3.px-p1.px)/6)*s,(p2.py-(p3.py-p1.py)/6)*s,p2.px*s,p2.py*s);
      }
    } else for(let i=1;i<pts.length;i++) ctx.lineTo(pts[i].px*s, pts[i].py*s);
    if(close) ctx.closePath();
  };
  const tracePoly = (poly, close) => tracePath(poly, close, false);
  state.series.forEach((ser,i) => {
    for(const r of ser.regs||[]){
      const col = r.neg ? "#ff5c72" : ser.color;
      tracePoly(r.poly, true); ctx.fillStyle = col + "22"; ctx.fill();
      ctx.setLineDash([6,4]); ctx.lineWidth = i===state.active ? 2 : 1; ctx.strokeStyle = col; ctx.stroke();
      ctx.setLineDash([]);
    }
  });
  const act = state.series[state.active];
  if(act && act.bound) drawBound(act);
  const preview = (poly, close) => { tracePoly(poly, close); ctx.lineWidth = 1.5; ctx.strokeStyle = state.selMod&&state.selMod.neg ? "#ff5c72" : "#fff"; ctx.stroke(); };
  if(state.lasso) preview(state.lasso, false);
  if(state.box){ const {a,b}=state.box; preview([a,{px:b.px,py:a.py},b,{px:a.px,py:b.py}], true); }

  if($("showFit").checked) state.series.forEach(ser => {
    if(ser.points.length<2) return;
    tracePath(ser.points, false, $("fitMode").value==="spline");
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
      if(pt.q!==undefined && pt.q<0.25){   // low match probability: ring it for review
        ctx.strokeStyle="#ff8f4d"; ctx.lineWidth=1.5; ctx.beginPath(); ctx.arc(pt.px*s, pt.py*s, 7, 0, Math.PI*2); ctx.stroke();
        ctx.strokeStyle = i===state.active ? "#fff" : "rgba(255,255,255,.4)"; ctx.lineWidth = i===state.active ? 1.5 : 1;
      }
    }
  });
  if(state.selPt){
    ctx.strokeStyle="#ffe14d"; ctx.lineWidth=2;
    ctx.beginPath(); ctx.arc(state.selPt.px*s, state.selPt.py*s, 8, 0, Math.PI*2); ctx.stroke();
  }
}
// boundary of a "look only above/below this curve" region (kept side tinted)
function drawBound(ser){
  const b=ser.bound, s=state.scale, ns=boundNodes(b); if(ns.length<2) return;
  const W=state.img.naturalWidth, edge=b.side==="above" ? 0 : state.img.naturalHeight;
  ctx.beginPath(); ctx.moveTo(0,ns[0].py*s); ns.forEach(n=>ctx.lineTo(n.px*s,n.py*s));
  ctx.lineTo(W*s,ns[ns.length-1].py*s); ctx.lineTo(W*s,edge*s); ctx.lineTo(0,edge*s); ctx.closePath();
  ctx.fillStyle="rgba(247,179,43,.10)"; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0,ns[0].py*s); ns.forEach(n=>ctx.lineTo(n.px*s,n.py*s)); ctx.lineTo(W*s,ns[ns.length-1].py*s);
  ctx.setLineDash([8,4]); ctx.lineWidth=2; ctx.strokeStyle="#f7b32b"; ctx.stroke(); ctx.setLineDash([]);
  if(state.mode==="bound"){ ctx.fillStyle="#f7b32b"; ctx.strokeStyle="#000"; ctx.lineWidth=1;
    ns.forEach(n=>{ ctx.fillRect(n.px*s-4,n.py*s-4,8,8); ctx.strokeRect(n.px*s-4,n.py*s-4,8,8); }); }
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
  else if(state.mode==="lasso" && state.series[state.active]){ state.lasso=[canvasToNatural(e)]; state.selMod=selModOf(e); }
  else if(state.mode==="box" && state.series[state.active]){ const p=canvasToNatural(e); state.box={a:p,b:p}; state.selMod=selModOf(e); }
  else if(state.mode==="bound"){
    const b=(state.series[state.active]||{}).bound, p=canvasToNatural(e);
    if(b){
      const node=b.nodes.findIndex(n=>Math.hypot(n.px-p.px,n.py+b.off-p.py)*state.scale<=10);
      if(node>=0) state.bdrag={kind:"node",i:node};
      else if(distToPoly(boundNodes(b),p)*state.scale<=10) state.bdrag={kind:"line",y0:p.py,off0:b.off};
    }
  }
  else if(state.mode==="points" && state.series[state.active]){
    const ser=state.series[state.active], {px,py}=canvasToNatural(e), i=nearestPoint(ser,px,py);
    if(i>=0){ state.drag={ser,pt:ser.points[i],moved:false}; state.selPt=ser.points[i]; render(); }
  }
});
window.addEventListener("mousemove", e => {
  if(panning && panStart){ wrap.scrollLeft=panStart.l-(e.clientX-panStart.x); wrap.scrollTop=panStart.t-(e.clientY-panStart.y); }
  if(state.drag){ const p=canvasToNatural(e); Object.assign(state.drag.pt,p); delete state.drag.pt.q; state.drag.moved=true; render(); }
  if(state.box){ state.box.b=canvasToNatural(e); render(); }
  if(state.bdrag){
    const b=state.series[state.active].bound, p=canvasToNatural(e);
    if(state.bdrag.kind==="node"){ const n=b.nodes[state.bdrag.i]; n.px=p.px; n.py=p.py-b.off; }
    else { b.off=state.bdrag.off0+(p.py-state.bdrag.y0); $("boundOff").value=Math.round(b.off*10)/10; }
    render();
  }
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
  const ser=state.series[state.active];
  if(state.lasso){
    if(state.lasso.length>=3 && ser) addRegion(ser,state.lasso,state.selMod);
    state.lasso=null; renderSeries(); render(); commit();
  }
  if(state.box){
    const {a,b}=state.box; state.box=null;
    if(ser && Math.abs(a.px-b.px)*state.scale>=4 && Math.abs(a.py-b.py)*state.scale>=4)
      addRegion(ser,[a,{px:b.px,py:a.py},b,{px:a.px,py:b.py}],state.selMod);
    renderSeries(); render(); commit();
  }
  if(state.bdrag){
    const b=ser.bound; state.bdrag=null; b.nodes.sort((p,q)=>p.px-q.px); render(); commit();
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
const selModOf = e => ({ add:e.shiftKey, neg:$("selNeg").checked || e.altKey });
// plain drag replaces the positive regions, Shift adds one, negative (checkbox / Alt) subtracts
function addRegion(ser, poly, mod){
  ser.regs = ser.regs || [];
  if(!mod.neg && !mod.add) ser.regs = ser.regs.filter(r=>r.neg);
  ser.regs.push({ poly, neg:!!mod.neg });
}
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
  // thin / anti-aliased / dashed lines are lighter than their darkest pixel: scale the tolerance to the contrast
  const tol=Math.round(Math.max(40,Math.min(140,0.45*Math.sqrt(bd/3))));
  $("tolerance").value=tol; $("tolVal").textContent=tol;
  if($("autoKind").value==="markers"){ const s=measureMarker(bx,by); if(s) $("markerSize").value=s; }
  state.hint={px,py};
  try{ $("runAuto").onclick(); } finally { state.hint=null; }
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
  state.series.push({ id:++state.nextId, name:"Series "+(state.series.length+1), color, points:[], regs:[], bound:null });
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
      ${(ser.regs&&ser.regs.length)||ser.bound?'<span class="sel" title="Has a search region / bound">&#11036;</span>':''}
      <span class="count">${ser.points.length}</span>
      <button class="del" title="Delete series">&times;</button>`;
    div.querySelector('input[type=color]').oninput = e=>{ ser.color=e.target.value; render(); };
    div.querySelector('input[type=text]').oninput  = e=>{ ser.name=e.target.value; refreshData(); };
    div.querySelector('input[type=color]').onchange = commit;
    div.querySelector('input[type=text]').onchange  = commit;
    div.querySelector('.del').onclick = e=>{ e.stopPropagation(); deleteSeries(i); };
    // switching the active series must not rebuild the list, or a text box being edited loses focus
    div.onclick = ()=>{
      if(state.active===i) return;
      state.active=i;
      list.querySelectorAll(".series-item").forEach((el,k)=>el.classList.toggle("active",k===i));
      syncBoundUI(); render();
    };
    list.appendChild(div);
  });
  syncBoundUI();
}
function deleteSeries(i){
  const gone=state.series.splice(i,1)[0];
  state.series.forEach(s=>{ if(s.bound&&s.bound.ref===gone.id) s.bound=null; });
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
// rasterise polygons (their union) into a W*H 0/1 mask
function buildMask(polys){
  const W=state.imgData.width, H=state.imgData.height;
  const c=document.createElement("canvas"); c.width=W; c.height=H;
  const g=c.getContext("2d",{willReadFrequently:true});
  for(const poly of polys){ g.beginPath(); poly.forEach((p,i)=> i ? g.lineTo(p.px,p.py) : g.moveTo(p.px,p.py)); g.closePath(); g.fill(); }
  const a=g.getImageData(0,0,W,H).data, m=new Uint8Array(W*H);
  for(let i=0;i<m.length;i++) m[i]=a[i*4+3]>127?1:0;
  return m;
}
// ---- "only look above / below another digitized curve" ----
function boundNodes(b){ return b.nodes.map(n=>({px:n.px,py:n.py+b.off})).sort((a,c)=>a.px-c.px); }
function segDist(p,a,b){
  const dx=b.px-a.px, dy=b.py-a.py, L=dx*dx+dy*dy; let t=L?((p.px-a.px)*dx+(p.py-a.py)*dy)/L:0;
  t=Math.max(0,Math.min(1,t)); return Math.hypot(p.px-a.px-t*dx, p.py-a.py-t*dy);
}
function distToPoly(ns,p){ let m=Infinity; for(let i=0;i<ns.length-1;i++) m=Math.min(m,segDist(p,ns[i],ns[i+1])); return m; }
function simplifyPts(pts,eps){   // Douglas-Peucker; pts sorted by x
  const out=pts.map(p=>({px:p.px,py:p.py}));
  if(out.length<3) return out;
  const keep=new Uint8Array(out.length); keep[0]=keep[out.length-1]=1; const st=[[0,out.length-1]];
  while(st.length){
    const [a,b]=st.pop(); let md=0, mi=-1;
    for(let i=a+1;i<b;i++){ const d=segDist(out[i],out[a],out[b]); if(d>md){ md=d; mi=i; } }
    if(md>eps && mi>0){ keep[mi]=1; st.push([a,mi],[mi,b]); }
  }
  return out.filter((_,i)=>keep[i]);
}
function applyBound(mask,b,W,H){
  const ns=boundNodes(b); if(ns.length<2) return;
  let k=0;
  for(let x=0;x<W;x++){
    while(k<ns.length-2 && x>ns[k+1].px) k++;
    const a=ns[k], c=ns[k+1]; const t=Math.max(0,Math.min(1,(x-a.px)/(c.px-a.px||1)));
    const yb=a.py+t*(c.py-a.py);
    for(let y=0;y<H;y++) if(b.side==="above" ? !(y<yb) : !(y>yb)) mask[y*W+x]=0;
  }
}

// search area for ser: union of its positive regions (else the calibrated box inset from the axes),
// minus its negative regions, limited to one side of its bound curve
function regionOf(ser){
  const W=state.imgData.width, H=state.imgData.height;
  const pos=(ser.regs||[]).filter(r=>!r.neg), neg=(ser.regs||[]).filter(r=>r.neg);
  let box;
  if(pos.length){
    let a=Infinity,b=-Infinity,c=Infinity,d=-Infinity;
    for(const r of pos) for(const p of r.poly){ a=Math.min(a,p.px); b=Math.max(b,p.px); c=Math.min(c,p.py); d=Math.max(d,p.py); }
    box={ x0:Math.max(0,Math.floor(a)), x1:Math.min(W-1,Math.ceil(b)), y0:Math.max(0,Math.floor(c)), y1:Math.min(H-1,Math.ceil(d)) };
  } else {
    const r=regionBox(), inset=3;
    box={ x0:Math.max(0,r.x0+inset), x1:Math.min(W-1,r.x1-inset), y0:Math.max(0,r.y0+inset), y1:Math.min(H-1,r.y1-inset) };
  }
  if(!pos.length && !neg.length && !ser.bound) return { ...box, mask:null };
  const mask = pos.length ? buildMask(pos.map(r=>r.poly)) : new Uint8Array(W*H).fill(1);
  if(neg.length){ const nm=buildMask(neg.map(r=>r.poly)); for(let i=0;i<mask.length;i++) if(nm[i]) mask[i]=0; }
  if(ser.bound) applyBound(mask,ser.bound,W,H);
  return { ...box, mask };
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
// outline markers -> solid: background pockets that don't reach the border and are no bigger than maxArea
// (so a closed plot frame is NOT filled in, but the inside of a ring is)
function fillHoles(m,w,h,maxArea){
  const out=new Uint8Array(m), seen=new Uint8Array(w*h), stack=new Int32Array(w*h);
  const flood=(start,keep)=>{
    let sp=0, n=0; stack[sp++]=start; seen[start]=1; const cells=keep?[]:null;
    while(sp){
      const i=stack[--sp], x=i%w, y=(i-x)/w; n++; if(keep) cells.push(i);
      const go=k=>{ if(!m[k]&&!seen[k]){ seen[k]=1; stack[sp++]=k; } };
      if(x>0)go(i-1); if(x<w-1)go(i+1); if(y>0)go(i-w); if(y<h-1)go(i+w);
    }
    return cells;
  };
  for(let x=0;x<w;x++){ for(const i of [x,(h-1)*w+x]) if(!m[i]&&!seen[i]) flood(i,false); }
  for(let y=0;y<h;y++){ for(const i of [y*w,y*w+w-1]) if(!m[i]&&!seen[i]) flood(i,false); }
  for(let s=0;s<w*h;s++){
    if(m[s]||seen[s]) continue;
    const cells=flood(s,true);
    if(cells.length<=maxArea) for(const i of cells) out[i]=1;
  }
  return out;
}
// chamfer distance (in px) from each foreground pixel to the nearest background pixel
function distMap(m,w,h){
  const D=new Float32Array(w*h);
  for(let i=0;i<w*h;i++) D[i]=m[i]?1e9:0;
  const at=(x,y,add,i)=>{ if(x<0||y<0||x>=w||y>=h) return 1e9; return D[y*w+x]+add; };
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){ const i=y*w+x; if(!D[i]) continue;
    D[i]=Math.min(D[i],at(x-1,y,3),at(x-1,y-1,4),at(x,y-1,3),at(x+1,y-1,4)); }
  for(let y=h-1;y>=0;y--) for(let x=w-1;x>=0;x--){ const i=y*w+x; if(!D[i]) continue;
    D[i]=Math.min(D[i],at(x+1,y,3),at(x+1,y+1,4),at(x,y+1,3),at(x-1,y+1,4)); }
  for(let i=0;i<w*h;i++) D[i]/=3;
  return D;
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
// Find every marker of the picked colour in ser's region and return its centre. Shape-agnostic:
// pockets are filled (outline markers), an opening strips thin things that touch the markers (error bars,
// connecting lines, axes, text), then each marker is located as a peak of the distance map, which also
// separates markers that touch or overlap.
function detectMarkers(ser){
  const {x0,x1,y0,y1,mask}=regionOf(ser), w=x1-x0+1, h=y1-y0+1;
  if(w<3||h<3){ alert("The search area is too small."); return null; }
  const m=colorMask(x0,y0,w,h,mask);
  let d=+$("markerSize").value;
  if(!(d>0)){   // auto size: the thickest solid part of the picked colour
    const D=distMap(fillHoles(m,w,h,400),w,h); let mx=0; for(let i=0;i<D.length;i++) if(D[i]>mx&&D[i]<1e8) mx=D[i];
    d=Math.max(8,Math.round(2*mx));
    $("markerSize").placeholder="auto: "+d;
  }
  const f=fillHoles(m,w,h,d*d), rho=Math.max(1,Math.floor(d*0.2));
  const core=boxFilter(boxFilter(f,w,h,rho,true),w,h,rho,false);   // opening
  const D=distMap(core,w,h), minR=0.3*d, sep=0.6*d;
  const cand=[]; for(let i=0;i<D.length;i++) if(D[i]>=minR&&D[i]<1e8) cand.push(i);
  cand.sort((a,b)=>D[b]-D[a]);
  const seeds=[];
  for(const i of cand){
    const x=i%w, y=(i-x)/w;
    if(seeds.every(s=>(s.x-x)**2+(s.y-y)**2>=sep*sep)) seeds.push({x,y,r:D[i]});
  }
  // centre = middle of the flat top of the distance peak
  const pts=seeds.map(s=>{
    let sx=0,sy=0,c=0, R=Math.ceil(0.4*d);
    for(let y=Math.max(0,s.y-R);y<=Math.min(h-1,s.y+R);y++) for(let x=Math.max(0,s.x-R);x<=Math.min(w-1,s.x+R);x++)
      if(D[y*w+x]>=s.r-1){ sx+=x; sy+=y; c++; }
    return {px:x0+sx/c,py:y0+sy/c};
  }).sort((a,b)=>a.px-b.px);
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
  // if the marker is joined to lines its bbox is meaningless; estimate from the largest square that fits inside
  const inscribed=b=>{ let k=0; while(k<40 && boxFilter(b,w,h,k+1,true).some(v=>v)) k++; return k; };
  let k=inscribed(only);
  if(k<3) k=inscribed(fillHoles(only,w,h,R*R));   // thin outline marker: fill its inside first
  const est=Math.round(1.4*(2*k+1));
  return s<=2.2*est ? s : est;
}

// Trace up to n same-coloured curves inside ser's region (lasso if set, else the calibrated box).
// Returns an array of point lists (top curve first) or null on failure.
function traceCurves(ser, n, overwritten){
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
  //    (a click with the Trace tool seeds at the ink nearest the click, within 10 px, and nowhere else)
  const top=col=>col.clusters.slice().sort((a,b)=>b.n-a.n).slice(0,n);
  const score=col=>(col.clusters.length>=n?1e6:0)+top(col).reduce((s,c)=>s+c.n,0);
  let si=0, seeds;
  if(state.hint){
    const h=state.hint; let best=null, bd=100;
    cols.forEach((col,i)=>col.clusters.forEach((cl,ci)=>{ const d=(col.x-h.px)**2+(cl.c-h.py)**2; if(d<=bd){ bd=d; best={i,cl,ci}; } }));
    if(!best){ alert("No pixels of the picked colour within 10 px of your click. Click right on the curve, or raise the colour tolerance."); return null; }
    si=best.i;
    // the other curves of a bundle: nearest similar-thickness ink to the click, searched over a few columns
    // either side (dashed curves have gaps), within 150 px, one seed per distinct ink
    const picks=[{k:best.i,ci:best.ci,cl:best.cl}];
    const cand=[];
    for(let k=Math.max(0,si-3);k<=Math.min(cols.length-1,si+3);k++) cols[k].clusters.forEach((cl,ci)=>{
      if(cl.n>=0.4*best.cl.n&&cl.n<=2.5*best.cl.n) cand.push({k,ci,cl,d:Math.hypot(cols[k].x-h.px,cl.c-h.py)});
    });
    cand.sort((a,b)=>a.d-b.d);
    for(const c of cand){
      if(picks.length>=n||c.d>150) break;
      if(picks.every(p=>Math.abs(p.cl.c-c.cl.c)>=8)) picks.push(c);
    }
    seeds=picks.sort((a,b)=>a.cl.c-b.cl.c).map(p=>({k:p.k,x:cols[p.k].x,y:p.cl.c,n:p.cl.n,ci:p.ci}));
  } else {
    let bs=-1;
    cols.forEach((col,i)=>{ const sc=score(col); if(sc>bs){ bs=sc; si=i; } });
    seeds=top(cols[si]).sort((a,b)=>a.c-b.c).map(cl=>({k:si,x:cols[si].x,y:cl.c,n:cl.n,ci:cols[si].clusters.indexOf(cl)}));
  }

  // 3. best path per curve by dynamic programming (Viterbi). A path is a chain of clusters, one per visited
  //    column, scored by smoothness (acceleration energy over the last three clusters, so a curve may bend but
  //    not hop to its neighbour), thickness consistency, and a small penalty per skipped column. Skipping up to
  //    `maxGap` columns lets it cross the gaps of dashed / dotted lines on its own momentum. Curves are
  //    extracted one after another and each claims its ink, so two curves can never share the same ink.
  const maxGap=Math.max(2,Math.ceil(Math.max(+$("bridge").value,40)/step)+1);
  const SKIP=0.15, R_COL=1.2, W_TH=0.4, W_ACC=8, W_SUP=10, P_SHARE=3, BEAM=40;   // R_COL: reward per column advanced, so a curve keeps going
  const hit=(x,y)=>{
    if(x<0||y<0||x>=W||y>=H||(mask&&!mask[y*W+x])) return false;
    const i=(y*W+x)*4, dr=data[i]-tr, dg=data[i+1]-tg, db=data[i+2]-tb; return dr*dr+dg*dg+db*db<=tol2;
  };
  // fraction of the straight segment between two cluster centres that lies on ink of the picked colour
  const support=(xa,ya,xb,yb)=>{
    const n=Math.max(1,Math.abs(xb-xa)); let ok=0;
    for(let t=0;t<=n;t++){
      const x=Math.round(xa+(xb-xa)*t/n), y=Math.round(ya+(yb-ya)*t/n);
      if(hit(x,y)||hit(x,y-1)||hit(x,y+1)||hit(x-1,y)||hit(x+1,y)) ok++;
    }
    return ok/(n+1);
  };
  const claimed=cols.map(c=>c.clusters.map(()=>false));
  // ink already digitized in other series counts as taken, so a new curve can't wander onto a finished one
  state.series.forEach(o=>{
    if(o===ser||(overwritten&&overwritten.includes(o))) return;
    for(const p of o.points){
      const k=Math.round((p.px-cols[0].x)/step); if(k<0||k>=cols.length||Math.abs(cols[k].x-p.px)>step) continue;
      cols[k].clusters.forEach((cl,ci)=>{ if(Math.abs(cl.c-p.py)<=Math.max(3,cl.n/2+2)) claimed[k][ci]=true; });
    }
  });
    const bestPath=(seed,dir,above)=>{   // above[k] = y of the previous (higher) curve in column k, if any
    const byCol=new Map();      // column -> Map(key -> entry)
    const add=(k,e)=>{ let m=byCol.get(k); if(!m){ m=new Map(); byCol.set(k,m); } const key=e.ci+"|"+(e.parent?e.parent.k+":"+e.parent.ci:"-"); const o=m.get(key); if(!o||e.cost<o.cost) m.set(key,e); };
    add(seed.k,{k:seed.k,ci:seed.ci,cl:cols[seed.k].clusters[seed.ci],parent:null,cost:0,count:0,th:seed.n,loc:0});
    let best=null, bv=Infinity;
    for(let k=seed.k;k>=0&&k<cols.length;k+=dir){
      const m=byCol.get(k); if(!m) continue;
      let list=[...m.values()];
      if(list.length>BEAM){ list.sort((a,b)=>a.cost-b.cost); list=list.slice(0,BEAM); }   // keep the best few paths per column
      for(const e of list){
        if(e.parent&&e.cost<bv){ bv=e.cost; best=e; }
        for(let g=1;g<=maxGap;g++){
          const j=k+dir*g; if(j<0||j>=cols.length) break;
          const cl=cols[j].clusters;
          for(let bi=0;bi<cl.length;bi++){
            const b=cl[bi], xi=cols[k].x, xj=cols[j].x, s2=(b.c-e.cl.c)/(xj-xi);
            let acc=0;
            if(e.parent){ const xh=cols[e.parent.k].x, s1=(e.cl.c-e.parent.cl.c)/(xi-xh); acc=W_ACC*(s2-s1)*(s2-s1)/(Math.abs(xj-xh)/2); }
            const lt=Math.log(b.n/(e.th*Math.sqrt(1+s2*s2)))/0.45;
            // a sideways move away from the momentum line is only believable if there is ink along the way
            const yp=e.parent ? e.cl.c+(e.cl.c-e.parent.cl.c)/(xi-cols[e.parent.k].x)*(xj-xi) : e.cl.c;
            const dev=Math.abs(b.c-yp);
            const sup = dev>4 ? support(xi,e.cl.c,xj,b.c) : 1;
            let loc=acc+W_TH*Math.min(lt*lt,4)+(dev>4 ? W_SUP*(1-sup)*(1-sup)*((dev-4)/8)**2 : 0);
            if(claimed[j][bi] && b.n<=2.5*seed.n) loc+=P_SHARE;                         // ink another curve already uses
            if(above && above[j]!==undefined && b.c+b.n/2<above[j]-1) loc+=3+0.5*(above[j]-1-b.c-b.n/2);   // curves keep their order (a merged blob may reach down to this curve)
            const c=e.cost+loc+SKIP*(g-1)-R_COL*g;
            add(j,{k:j,ci:bi,cl:b,parent:e,cost:c,count:e.count+1,th:0.8*e.th+0.2*b.n/Math.sqrt(1+s2*s2),loc});
          }
        }
      }
    }
    const path=[]; for(let e=best;e&&e.parent;e=e.parent) path.push(e);
    return path;     // far end first
  };
  let above=null;
  const tracks=seeds.map(seed=>{
    const prev=above||[];
    const right=bestPath(seed,1,above), left=bestPath(seed,-1,above);
    const used=[...left,...right];
    const pts=[...left.reverse(),{k:seed.k,ci:seed.ci,loc:0},...right.reverse()].map(e=>{ return e; });
    used.forEach(e=>{ if(cols[e.k].clusters[e.ci].n<=2.5*seed.n) claimed[e.k][e.ci]=true; });
    claimed[seed.k][seed.ci]=true;
    above=above||[];
    const out=pts.map(e=>{
      const cl=cols[e.k].clusters[e.ci], a=prev[e.k];
      // inside a merged blob the centre belongs to the whole bundle: keep this curve just below the one above it
      const y = (a!==undefined && cl.n>1.5*seed.n && cl.c<a+1) ? a+2 : cl.c;
      return {px:cols[e.k].x, py:y, q:Math.exp(-e.loc)};
    });
    out.forEach((p,i)=>{ const k=pts[i].k; if(above[k]===undefined||p.py>above[k]) above[k]=p.py; });
    return out;
  });

  // 4. never put two curves in the same spot: where two tracks have a point in the same column closer than a
  //    curve thickness, keep the real measurement (over a coasted one), else the more probable, and drop the other
  const minSep=Math.max(2,0.6*Math.min(...seeds.map(s=>s.n)));
  const byX=new Map();
  tracks.forEach(pts=>pts.forEach(p=>{ const a=byX.get(p.px)||[]; a.push(p); byX.set(p.px,a); }));
  const drop=new Set();
  byX.forEach(list=>{
    for(let a=0;a<list.length;a++) for(let b=a+1;b<list.length;b++){
      const A=list[a], B=list[b];
      if(drop.has(A)||drop.has(B)||Math.abs(A.py-B.py)>=minSep) continue;
      drop.add(A.coast&&!B.coast ? A : B.coast&&!A.coast ? B : (A.q>=B.q ? B : A));
    }
  });
  const bridge=+$("bridge").value;
  const fill=pts=>{ if(!bridge) return pts; const o=[pts[0]];
    for(let i=1;i<pts.length;i++){ const a=pts[i-1], b=pts[i], dx=b.px-a.px;
      if(dx>step*1.5 && dx<=bridge) for(let x=a.px+step;x<b.px;x+=step) o.push({px:x,py:a.py+(b.py-a.py)*(x-a.px)/dx});
      o.push(b); }
    return o; };
  const out=tracks.map(pts=>pts.filter(p=>!drop.has(p))).filter(p=>p.length>=2).map(fill);
  if(!out.length){ alert("Couldn't trace a continuous curve. Try a different tolerance / colour, or place points by hand."); return null; }
  return out;
}
// Trace into series `si`; extra curves go into the following series (created if missing).
function extractInto(si, n){
  const markers=$("autoKind").value==="markers";
  const tracks=markers ? [detectMarkers(state.series[si])].filter(Boolean) : traceCurves(state.series[si], n, state.series.slice(si,si+n));
  if(!tracks||!tracks.length) return false;
  const act=state.active;
  tracks.forEach((pts,k)=>{
    while(si+k>=state.series.length) addSeries();
    state.series[si+k].points=pts.slice().sort((a,b)=>a.px-b.px);
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
  const idx=state.series.map((s,i)=>(s.regs&&s.regs.some(r=>!r.neg))||s.bound?i:-1).filter(i=>i>=0);
  if(!idx.length){ alert("Give at least one series a region (Lasso / Box) or a bound first."); return; }
  idx.forEach(i=>extractInto(i,1));
};
$("clearRegion").onclick = ()=>{ const s=state.series[state.active]; if(s){ s.regs=[]; renderSeries(); render(); commit(); } };

// ---- bound UI ----
function syncBoundUI(){
  const sel=$("boundRef"), cur=sel.value, act=state.series[state.active], b=act&&act.bound;
  sel.innerHTML=state.series.filter(s=>s!==act&&s.points.length>=2).map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join("")
    || '<option value="">(digitize another series first)</option>';
  if(b){ sel.value=b.ref; $("boundSide").value=b.side; $("boundOff").value=Math.round(b.off*10)/10; }
  else if([...sel.options].some(o=>o.value===cur)) sel.value=cur;
  $("boundInfo").textContent = b ? `Bound to "${(state.series.find(s=>s.id===b.ref)||{name:"?"}).name}", ${b.side}, ${b.nodes.length} nodes. Use the Bound tool (G) to drag the line or its nodes.` : "No bound on this series.";
}
$("boundApply").onclick = ()=>{
  const act=state.series[state.active], ref=state.series.find(s=>String(s.id)===$("boundRef").value);
  if(!act||!ref||ref.points.length<2){ alert("Pick another series that already has points."); return; }
  const pts=ref.points.slice().sort((a,b)=>a.px-b.px);
  let nodes=simplifyPts(pts,1.5), eps=1.5; while(nodes.length>60){ eps*=1.5; nodes=simplifyPts(pts,eps); }
  act.bound={ ref:ref.id, side:$("boundSide").value, off:+$("boundOff").value||0, nodes };
  setMode("bound"); renderSeries(); render(); commit();
};
$("boundClear").onclick = ()=>{ const a=state.series[state.active]; if(a){ a.bound=null; renderSeries(); render(); commit(); } };
$("boundSide").onchange = ()=>{ const b=(state.series[state.active]||{}).bound; if(b){ b.side=$("boundSide").value; render(); commit(); } };
$("boundOff").oninput = ()=>{ const b=(state.series[state.active]||{}).bound; if(b){ b.off=+$("boundOff").value||0; render(); } };
$("boundOff").onchange = commit;

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
  const keys=t==="BL"?["X1","Y1"]:t==="TR"?["X2","Y2"]:[t];
  if($("ocrAuto").checked) ocrFill(keys);
  else { const f=$(valMap[keys[0]]); if(f) f.focus(); }
}
document.querySelectorAll(".abtn").forEach(b => b.onclick = () => autoCal(b.dataset.auto));

// ============================================================ undo / redo / hotkeys
const hist={stack:[],i:-1};
function commit(){
  const j=JSON.stringify({a:state.active,s:state.series.map(s=>({id:s.id,name:s.name,color:s.color,points:s.points,regs:s.regs||[],bound:s.bound||null}))});
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
$("showFit").onchange=render; $("fitMode").onchange=render;

window.addEventListener("keydown", e=>{
  if(/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const k=e.key.toLowerCase(), mod=e.ctrlKey||e.metaKey;
  if(mod&&k==="z"){ e.preventDefault(); e.shiftKey?redo():undo(); return; }
  if(mod&&k==="y"){ e.preventDefault(); redo(); return; }
  if(mod||e.altKey) return;
  if(/^[1-9]$/.test(k)){ if(state.series[k-1]){ state.active=k-1; renderSeries(); render(); } return; }
  const modes={a:"points",d:"delete",l:"lasso",b:"box",g:"bound",t:"trace",h:"pan"};
  if(modes[k]){ setMode(modes[k]); return; }
  if(k==="escape"){ state.selPt=null; render(); return; }
  const ser=state.series.find(s=>s.points.includes(state.selPt));
  if(!ser) return;
  const st=e.shiftKey?5:1, mv={arrowleft:[-st,0],arrowright:[st,0],arrowup:[0,-st],arrowdown:[0,st]}[k];
  if(mv){ e.preventDefault(); state.selPt.px+=mv[0]; state.selPt.py+=mv[1]; sortPoints(ser); afterEdit(); }
  else if(k==="delete"||k==="backspace"){ e.preventDefault(); ser.points.splice(ser.points.indexOf(state.selPt),1); state.selPt=null; afterEdit(); }
});

// ============================================================ OCR for reference values (tesseract.js, loaded on demand)
let tessPromise=null;
function loadTesseract(){
  if(window.Tesseract) return Promise.resolve();
  return tessPromise || (tessPromise=new Promise((res,rej)=>{
    const s=document.createElement("script");
    s.src="https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
    s.onload=res; s.onerror=()=>{ tessPromise=null; rej(new Error("Couldn't load the OCR library (are you offline?).")); };
    document.head.appendChild(s);
  }));
}
function parseNum(t){
  const c=t.replace(/,/g,".").replace(/^[^\d.+-]+|[^\d]+$/g,"");
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(c) ? parseFloat(c) : null;
}
let tessWorker=null;
async function getWorker(psm){
  await loadTesseract();
  if(!tessWorker){
    tessWorker=await Tesseract.createWorker("eng");
    await tessWorker.setParameters({ tessedit_char_whitelist:"0123456789.-+" });
  }
  await tessWorker.setParameters({ tessedit_pageseg_mode:Tesseract.PSM[psm] });
  return tessWorker;
}
// numbers on the image with their centres, read once per image
async function ocrNumbers(){
  if(state.ocr) return state.ocr;
  const f=state.img.naturalWidth<1400?2:1;     // small images read better upscaled
  const cv=document.createElement("canvas"); cv.width=state.img.naturalWidth*f; cv.height=state.img.naturalHeight*f;
  cv.getContext("2d").drawImage(state.img,0,0,cv.width,cv.height);
  const {data}=await (await getWorker("SPARSE_TEXT")).recognize(cv);
  return state.ocr=(data.words||[]).map(w=>({ v:parseNum(w.text), text:w.text,
      cx:(w.bbox.x0+w.bbox.x1)/2/f, cy:(w.bbox.y0+w.bbox.y1)/2/f, h:(w.bbox.y1-w.bbox.y0)/f }))
    .filter(w=>w.v!==null);
}
// X labels sit under their tick: nearest horizontally, ties go to the right. Y labels sit beside theirs:
// nearest vertically, ties go to the one above. A small term for the other axis keeps it on the same row/column.
// Returns {w, off} (off = distance along the matching axis) or null.
function pickLabel(k,words,h){
  const pt=state.cal[k]; if(!pt||!words.length) return null;
  const X=k[0]==="X", pen=0.75*h;
  // labels are below the x axis / left of the y axis; ignore everything else when something qualifies
  const side=words.filter(w=> X ? w.cy>pt.py : w.cx<pt.px);
  const pool=side.length?side:words;
  let best=null, bs=Infinity;
  for(const w of pool){
    const s = X ? Math.abs(w.cx-pt.px)+(w.cx<pt.px?pen:0)+0.05*Math.abs(w.cy-pt.py)
                : Math.abs(w.cy-pt.py)+(w.cy>pt.py?pen:0)+0.05*Math.abs(w.cx-pt.px);
    if(s<bs){ bs=s; best=w; }
  }
  return best && { w:best, off: X ? Math.abs(best.cx-pt.px) : Math.abs(best.cy-pt.py) };
}
// the full-page pass drops lone digits like "0"; read the expected label spot on its own, enlarged
async function cropOcr(k,h){
  const pt=state.cal[k], X=k[0]==="X";
  let x0,x1,y0,y1;
  if(X){ x0=pt.px-3*h; x1=pt.px+3*h; y0=pt.py+0.6*h; y1=pt.py+3.5*h; }
  else { x0=pt.px-8*h; x1=pt.px-0.7*h; y0=pt.py-1.2*h; y1=pt.py+1.2*h; }
  x0=Math.max(0,x0); y0=Math.max(0,y0); x1=Math.min(state.img.naturalWidth,x1); y1=Math.min(state.img.naturalHeight,y1);
  if(x1-x0<4||y1-y0<4) return null;
  const f=3, pad=24, cv=document.createElement("canvas"); cv.width=(x1-x0)*f+2*pad; cv.height=(y1-y0)*f+2*pad;
  const g=cv.getContext("2d"); g.fillStyle="#fff"; g.fillRect(0,0,cv.width,cv.height);
  g.drawImage(state.img,x0,y0,x1-x0,y1-y0,pad,pad,(x1-x0)*f,(y1-y0)*f);
  const {data}=await (await getWorker("SINGLE_WORD")).recognize(cv);
  return parseNum(data.text.trim());
}
async function ocrFill(keys){
  if(!state.img){ alert("Load an image first."); return; }
  const st=$("ocrStatus"); st.textContent="Reading numbers… (first use downloads the OCR model)";
  try{
    const words=await ocrNumbers(), got=[];
    const hs=words.map(w=>w.h).sort((a,b)=>a-b), h=hs.length?hs[hs.length>>1]:20;
    for(const k of keys){
      const hit=pickLabel(k,words,h);
      let v = hit && hit.off<=1.5*h ? hit.w.v : null;
      if(v===null) v=await cropOcr(k,h);
      if(v===null) v = hit ? hit.w.v : null;
      if(v===null) continue;
      state.cal[k].val=v; $(valMap[k]).value=v; got.push(`${k}=${v}`);
    }
    st.textContent=got.length?`OCR: ${got.join(", ")} — check them.`:"OCR found no numbers near the placed points.";
    updateCalibStatus(); render();
  } catch(err){ st.textContent=""; alert(err.message||err); }
}
$("ocrBtn").onclick=()=>ocrFill(["X1","X2","Y1","Y2"].filter(k=>state.cal[k]));

// ============================================================ init
addSeries(); setMode("points"); updateCalibStatus();
window.addEventListener("resize", ()=>{ if(state.img) render(); });

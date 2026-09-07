import { createRenderer } from 'moraine/render';
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
/* every asset sits beside this module on the CDN · import.meta.url IS the base, so the page
   carries no URL literal for aura to rewrite and the same file works from any host */
const B = new URL('.', import.meta.url).href;
const BIKE_URL=B+"bike.glb", DRIVE_URL=B+"drivetrain.glb";
const VAT_JSON_URL=null, CLIPS_URL=B+"clips.json", GEOM_URL=B+"geometry.json", FALLBACK_URL=B+"hero-fallback.jpg";
const ENV_URL=B+"env.glb", ENV_CLIPS_URL=B+"env-clips.json";
/* ── K · kinetic type ───────────────────────────────────────────────────────────────────────
   Words arrive one per beat and assemble IN PLACE on a fixed baseline (Apple "Don't Blink"
   #0050→#0051 · "Two" → "Two new"). Scale is the emphasis, not weight. The word just read dims as
   the next lands (#0090). Numbers count to their value. Nothing slides in as a block · that is the
   sticky column this replaces. Everything is driven by the same scroll t the camera reads, so type
   and model are one clock. */
const K = (() => {
  const S = new WeakMap();
  const clampf = (v,a,b)=>Math.max(a,Math.min(b,v));
  const ease = u => { u=clampf(u,0,1); return u*u*(3-2*u); };
  function split(el){
    if (S.has(el)) return S.get(el);
    const words = [...el.querySelectorAll('.w')];
    if (!words.length){
      /* plain text · split on spaces, keep <em> emphasis */
      const html = el.innerHTML.trim().split(/\s+/).map(w => `<span class="w">${w}</span>`).join(' ');
      el.innerHTML = html;
    }
    const st = { words: [...el.querySelectorAll('.w')] };
    S.set(el, st); return st;
  }
  /* assemble: words appear one by one across [from,to] of t; the previous word dims to 0.55 */
  function assemble(el, t, from=0, to=0.4, hold=1.0, out=1.01){
    const { words } = split(el); const n = words.length; if (!n) return;
    const u = clampf((t-from)/Math.max(1e-6,(to-from)),0,1) * n;
    const leave = clampf((t-hold)/Math.max(1e-6,(out-hold)),0,1);
    for (let i=0;i<n;i++){
      const w = words[i]; const a = clampf(u - i, 0, 1); const e = ease(a);
      const isLast = i === n-1; const dim = (!isLast && u > i+1.6) ? 0.55 : 1;
      const op = e * dim * (1-leave);
      const tr = `translateY(${((1-e)*0.35).toFixed(3)}em)`;
      if (w.dataset.op !== op.toFixed(3)){ w.style.opacity = op.toFixed(3); w.style.transform = tr; w.dataset.op = op.toFixed(3); }
    }
  }
  /* count: a numeral ticks from data-from to data-to across [from,to] */
  function count(el, t, from=0, to=0.5, hold=1.0, out=1.01){
    const a = +(el.dataset.from ?? 0), b = +(el.dataset.to ?? 0), dp = +(el.dataset.dp ?? 0);
    const u = ease(clampf((t-from)/Math.max(1e-6,(to-from)),0,1));
    const leave = clampf((t-hold)/Math.max(1e-6,(out-hold)),0,1);
    const v = a + (b-a)*u; const txt = dp ? v.toFixed(dp) : Math.round(v).toString();
    if (el.dataset.txt !== txt){ el.textContent = txt; el.dataset.txt = txt; }
    const op = (u > 0 ? 1 : 0) * (1-leave); if (el.dataset.op !== op.toFixed(2)){ el.style.opacity = op.toFixed(2); el.dataset.op = op.toFixed(2); }
  }
  /* show: a caption or block fades in over [from, from+0.06] and out over [hold, out] */
  function show(el, t, from=0, hold=1.0, out=1.01){
    const inn = ease(clampf((t-from)/0.06,0,1)), leave = clampf((t-hold)/Math.max(1e-6,(out-hold)),0,1);
    const op = inn*(1-leave); if (el.dataset.op !== op.toFixed(2)){ el.style.opacity = op.toFixed(2); el.dataset.op = op.toFixed(2); }
  }
  /* ladder: items light one by one across [from,to]; the ones passed dim (Apple #0090) */
  function ladder(el, t, from=0.1, to=0.85){
    const items = [...el.children]; const n = items.length; const u = clampf((t-from)/Math.max(1e-6,(to-from)),0,1)*n;
    items.forEach((it,i)=>{ const on = u >= i+0.5, passed = u >= i+1.5; const cls = on ? (passed ? 'lit passed' : 'lit') : '';
      if (it.dataset.cls !== cls){ it.className = cls; it.dataset.cls = cls; } });
    return Math.min(n-1, Math.max(0, Math.floor(u-0.5)));
  }
  return { split, assemble, count, show, ladder, ease };
})();

/* ── SHAPE · the orange device ──────────────────────────────────────────────────────────────
   One fixed SVG path in Trail Orange that is, in turn, a STROKE (the hero draws it at the down
   tube's angle), the strokes of an M, a BAR that wipes across the frame between fast sections
   (Haibike #0014), a BLOCK behind a single number (Haibike #0060), and a ROAD the bike rolls onto in
   the closer · a strip that widens into a perspective trapezoid (Haibike #0103–#0111). All keyframe
   paths share one command shape (6 points) so any two can be interpolated. Coordinates are 0..100
   in both axes (viewBox), non-uniform scaled to the viewport on purpose. */
const SHAPE = (() => {
  const svg = () => document.getElementById('shape'), path = () => document.getElementById('shapePath');
  /* six points: a closed hexagon-ish ribbon. stroke = thin diagonal ribbon at ~48° like the down tube */
  const KEY = {
    none:   [[50,50],[50,50],[50,50],[50,50],[50,50],[50,50]],
    stroke: [[22,72],[24,71.2],[76,28],[78,28.8],[76,30.4],[24,73.6]],
    strokeFat:[[20,74],[26,70],[76,26],[80,30],[74,34],[26,78]],
    bar:    [[0,44],[0,44],[100,44],[100,56],[100,56],[0,56]],
    barOff: [[100,44],[100,44],[200,44],[200,56],[200,56],[100,56]],
    barIn:  [[-100,44],[-100,44],[0,44],[0,56],[0,56],[-100,56]],
    /* the CURTAIN · a full-frame rectangle that sweeps across on a wall clock at one boundary (owner
       2026-09-06: the band parked over the wheel when the reader stopped mid-scroll, and the ground's
       paper→ink flip happened in the open). The band above stays: the closer morphs it into the road. */
    curtainIn:  [[-100,0],[-100,0],[0,0],[0,100],[0,100],[-100,100]],
    curtain:    [[0,0],[0,0],[100,0],[100,100],[100,100],[0,100]],
    curtainOff: [[100,0],[100,0],[200,0],[200,100],[200,100],[100,100]],
    block:  [[6,58],[6,58],[42,58],[42,92],[42,92],[6,92]],
    strip:  [[49,20],[49,20],[51,20],[51,100],[51,100],[49,100]],
    road:   [[0,67],[38,66],[62,66],[100,67],[100,76],[0,76]],
  };
  let cur = 'none', p = 1, drawn = 1;
  const lerp=(a,b,u)=>a+(b-a)*u;
  function d(pts){ return 'M'+pts.map(q=>q[0].toFixed(2)+','+q[1].toFixed(2)).join('L')+'Z'; }
  function mix(A,B,u){ return A.map((a,i)=>[lerp(a[0],B[i][0],u), lerp(a[1],B[i][1],u)]); }
  /* set(mode, progress) · mode is 'a>b' to interpolate two keys, or one key. drawnFrac clips the
     ribbon left→right (the hero's stroke drawing itself) */
  function set(mode, prog=1, drawnFrac=1, opacity=1){
    const el = path(); if (!el) return;
    const [a,b] = mode.includes('>') ? mode.split('>') : [mode, mode];
    const pts = mix(KEY[a]||KEY.none, KEY[b]||KEY.none, SHAPE.ease(prog));
    el.setAttribute('d', d(pts));
    const s = svg(); if (s){ s.style.opacity = opacity.toFixed(3); s.style.setProperty('--draw', drawnFrac.toFixed(3)); }
    cur = mode; p = prog; drawn = drawnFrac;
  }
  const ease = u => { u=Math.max(0,Math.min(1,u)); return u*u*(3-2*u); };
  return { set, ease, KEY, state:()=>({cur,p,drawn}) };
})();

/* ═══════════ MORAINE · the page ═══════════
   The scrollbar is the clock. This file owns the DOM side of the state
   machine: which chapter has the viewport, how far through it we are, and
   every readout, chip and reveal. The 3D side (_scene.js) subscribes to the
   same chapter progress and drives the renderer; nothing here touches WebGPU.
   That split is what lets the page be tested without a GPU. */

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const lerp = (a,b,t)=>a+(b-a)*t;
const eInOutCubic = t => t<.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── the chapters ─────────────────────────────────────────────────────────
   id = the section, word = what sits BEHIND the bike, range = the Blender
   timeline range the chapter scrubs (see model/clips.json). `t` inside a
   chapter is 0..1 of its sticky scroll. */
/* wy/wsc place the word so it never sits under that chapter's copy: copy-right
   chapters keep the word big and mid-left, copy-left chapters push it low and
   small, where the bike's lower half is. */
const CHAPTERS = [
  { id:'top',        word:'MORAINE',  range:'arrive',    idx:'00', cam:'Cam_Hero',       wy:'38%', wsc:1 },
  { id:'geometry',   word:'FIT',      range:'geometry',  idx:'01', cam:'Cam_Geometry',   wy:'50%', wsc:1 },
  { id:'contact',    word:'GRIP',     range:'roll',      idx:'02', cam:'Cam_Contact',    wy:'30%', wsc:.8 },
  { id:'drivetrain', word:'CLIMB',    range:'shift',     idx:'03', cam:'Cam_Drivetrain', wy:'50%', wsc:1 },
  { id:'drive',      word:'TORQUE',   range:'drive',     idx:'04', cam:'Cam_Drive',      wy:'84%', wsc:.62 },
  { id:'battery',    word:'RANGE',    range:'battery',   idx:'05', cam:'Cam_Battery',    wy:'50%', wsc:1 },
  { id:'finish',     word:'PAINT',    range:'finish',    idx:'06', cam:'Cam_Finish',     wy:'30%', wsc:.8 },
  { id:'control',    word:'HOLD',     range:'control',   idx:'07', cam:'Cam_Control',    wy:'84%', wsc:.62 },
  { id:'order',      word:'MORAINE',  range:'configure', idx:'08', cam:'Cam_Configure',  wy:'86%', wsc:.5 },
];

/* ── shared state, read by _scene.js every frame ───────────────────────── */
export const STATE = {
  chapter: CHAPTERS[0], t: 0,            /* who owns the viewport, and how far */
  size: 'M', way: 0, tyre: 45,           /* the configuration */
  steer: 0, lever: 0,                    /* pointer-driven, control chapter */
  heroDone: false,                       /* the arrive clip has finished */
  geometry: null,                        /* model/geometry.json once loaded */
  listeners: new Set(),
};
const emit = ()=>STATE.listeners.forEach(f=>f(STATE));
/* the verifier reads the state machine directly rather than inferring it from classes */
window.MORAINE = STATE;

/* ── the rail index ───────────────────────────────────────────────────── */
const idx = $('#idx');   /* the rail index is retired (v3) · the scrub line carries the chapter id */
if (idx) CHAPTERS.forEach(c=>{
  const b=document.createElement('button'); b.textContent=c.idx; b.dataset.ch=c.id;
  b.setAttribute('aria-label', c.id); idx.appendChild(b);
});
function setCurrent(id){
  $$('#idx button').forEach(b=>b.setAttribute('aria-current', b.dataset.ch===id ? 'true' : 'false'));
  const pr = $('#prog'); if (pr) pr.dataset.ch = id;
}

/* ── the word behind the bike, one span per letter ─────────────────────── */
const word = $('#behindWord');
let wordNow = '';
function setWord(w, c){
  if (!word) return;   /* the watermark word is retired (script v2) · the wordmark is the hero's own */
  if (c){ word.style.setProperty('--wy', c.wy); word.style.setProperty('--wsc', c.wsc); }
  if (w===wordNow) return; wordNow = w;
  word.classList.remove('on'); word.innerHTML='';
  [...w].forEach((ch,i)=>{ const s=document.createElement('span'); s.textContent=ch; s.style.setProperty('--d',(i*0.045)+'s'); word.appendChild(s); });
  requestAnimationFrame(()=>requestAnimationFrame(()=>word.classList.add('on')));
}

/* ── anchors: every href="#" is a placeholder and must not jump to the hero;
   real anchors scroll smoothly. One delegated handler. ─────────────────── */
document.addEventListener('click', e=>{
  const a = e.target.closest('a[href^="#"]'); if(!a) return;
  const h = a.getAttribute('href');
  e.preventDefault();
  if (h.length>1){ const el=document.getElementById(h.slice(1)); if(el) el.scrollIntoView({behavior: REDUCED?'auto':'smooth', block:'start'}); }
});
$('#idx')?.addEventListener('click', e=>{
  const b=e.target.closest('button'); if(!b) return;
  document.getElementById(b.dataset.ch).scrollIntoView({behavior: REDUCED?'auto':'smooth'});
});

/* ── chapter progress from the scrollbar ───────────────────────────────── */
const secs = CHAPTERS.map(c=>({c, el:document.getElementById(c.id)}));
function readScroll(){
  const y = scrollY, vh = innerHeight, mid = y + vh*0.5;
  let owner = secs[0];
  for (const s of secs){ if (s.el.offsetTop <= mid) owner = s; }
  const h = owner.el.offsetHeight;
  const start = owner === secs[0] ? 0 : owner.el.offsetTop - vh*0.5;      /* hand-over in */
  const end = owner.el.offsetTop + h - vh*0.5;                                 /* hand-over out */
  const t = clamp((y - start)/Math.max(1, end - start), 0, 1);
  if (owner.c !== STATE.chapter){
    STATE.chapter = owner.c; setCurrent(owner.c.id); setWord(owner.c.word, owner.c);
    document.documentElement.classList.toggle('heroOn', owner.c.id==='top');
    secs.forEach(s=>s.el.classList.toggle('on', s===owner));
  }
  STATE.t = t;
  onChapter(owner.c, t);
  emit();
}
addEventListener('scroll', readScroll, {passive:true});
addEventListener('resize', readScroll);

/* ── per-chapter readouts ──────────────────────────────────────────────── */
const SIZE_LABEL = {S:'52', M:'54', L:'56', XL:'58'};
const COGS = [10,11,13,15,17,19,21,24,28,32,38,44];
const ladder = $$('#ladder span');
const parts  = $$('#parts li');
const cellsEl = $('#cells'); if(cellsEl) for(let i=0;i<24;i++){ cellsEl.appendChild(document.createElement('i')); }
const cells = $$('#cells i');

function onChapter(c, t){
  switch(c.id){
    case 'drivetrain': {
      /* the shift range: 15T until frame 120, 21T until 160, 28T until 200, then 38T · frames 100..220 */
      const f = 100 + t*120;
      const cog = f<120 ? 15 : f<160 ? 21 : f<200 ? 28 : 38;
      ladder.forEach(s=>{ const n=+s.textContent; s.classList.toggle('on', n===cog); s.classList.toggle('was', n<cog && n>=15); });
      { const a=$('#gCog'), b=$('#gRatio'); if(a) a.textContent = cog+' T'; if(b) b.textContent = (40/cog).toFixed(2); }
      break; }
    case 'drive': {
      /* case goes to glass over the first third, then the unit comes apart · one part lights per step */
      const e = clamp((t-0.33)/0.67, 0, 1);
      const step = Math.floor(eInOutCubic(e)*5.99);
      parts.forEach((li,i)=>li.classList.toggle('on', t>0.05 && i<=step));
      break; }
    case 'battery': {
      const n = Math.round(clamp((t-0.17)/0.83,0,1)*24);
      cells.forEach((el,i)=>el.classList.toggle('on', i<n));
      { const e=$('#bCells'); if(e) e.textContent = n+' / 24'; }
      break; }
    case 'finish': {
      const f = 700 + t*120;
      /* the file's stops: raw to 740, coat by 760, orange at 780, bone at 800, ink at 820 (6-frame ramps) */
      const stage = f<740 ? 'raw carbon' : f<777 ? 'clearcoat' : f<797 ? 'trail orange' : f<817 ? 'bone' : 'ink';
      { const e=$('#fStage'); if(e) e.textContent = stage; }
      break; }
    case 'control': {
      /* the lever follows the scroll after the crane has landed (t 0.30), or the pointer: press and hold squeezes */
      STATE.lever = clamp(Math.max((t-0.30)/0.35, STATE.press||0), 0, 1);
      { const e=$('#hLever'); if(e) e.textContent = Math.round(STATE.lever*100)+' %'; }
      break; }
    /* contact has no live readout any more. The old one printed a "Deflection" in millimetres
       computed from a Gaussian over the VAT frame · when the macro model was retired for the bike's
       own wheel, nothing on screen deformed and that number was measuring nothing at all. A caption
       that reports a value the render cannot support is worse than no caption, so the third stat is
       now the tyre's section, which is true, on the sidewall, and in the headline. */
  }
}

/* ── the configuration chips: size, colour, tyre · order and chapter chips are the SAME state */
function pressGroup(sel, attr, value){ if(!document.querySelector(sel)) return;
  $$(sel+' button').forEach(b=>b.setAttribute('aria-pressed', String(b.dataset[attr]===String(value))));
}
function setSize(s){
  STATE.size = s; pressGroup('#sizes','size',s); pressGroup('#oSizes','size',s);
  const g = STATE.geometry?.sizes?.[s]; if(!g) return;
  countTo('#dStack', g.stack); countTo('#dReach', g.reach); countTo('#dHta', g.hta, 1); countTo('#dSta', g.sta, 1);
  countTo('#dCs', g.cs); countTo('#dWb', g.wb);
  emit();
}
function setWay(w){ STATE.way = +w; pressGroup('#swatches','way',w); pressGroup('#oWay','way',w); emit(); }
function setTyre(w){ STATE.tyre = +w; pressGroup('#oTyres','tyre',w); $('#oTyre').textContent = '700c x '+w+' mm'; emit(); }
/* a chosen size pins the frame · the geometry chapter's four-size sweep stops (script v2) */
$('#sizes').addEventListener('click', e=>{ const b=e.target.closest('button'); if(b){ STATE.sizePinned = true; setSize(b.dataset.size); } });
$('#oSizes').addEventListener('click', e=>{ const b=e.target.closest('button'); if(b){ STATE.sizePinned = true; setSize(b.dataset.size); } });
$('#swatches')?.addEventListener('click', e=>{ const b=e.target.closest('button'); if(b) setWay(b.dataset.way); });
$('#oWay').addEventListener('click', e=>{ const b=e.target.closest('button'); if(b) setWay(b.dataset.way); });
$('#oTyres')?.addEventListener('click', e=>{ const b=e.target.closest('button'); if(b) setTyre(b.dataset.tyre); });
{ const c=$('#cart'); if(c) c.addEventListener('click', ()=>{ const b=$('#cart span'); if(b) b.textContent='Added · view cart'; }); }

/* a number that counts to its target · reads as a measurement changing, not a label swapping */
const counters = new Map();
function countTo(sel, target, dp=0){
  const el=$(sel); const from=parseFloat(el.textContent)||target; const t0=performance.now();
  counters.set(sel, {el, from, target, dp, t0});
}
function tickCounters(now){
  for (const [k,c] of counters){
    const u = REDUCED ? 1 : clamp((now-c.t0)/650, 0, 1);
    c.el.textContent = lerp(c.from, c.target, eInOutCubic(u)).toFixed(c.dp);
    if (u>=1) counters.delete(k);
  }
}

/* ── the control chapter: the pointer turns the bars ───────────────────── */
addEventListener('pointermove', e=>{
  if (STATE.press && STATE.dragFrom){ STATE.orbit = [clamp((e.clientX-STATE.dragFrom[0])/innerWidth*2 + STATE.orbitBase[0], -1.2, 1.2), clamp((e.clientY-STATE.dragFrom[1])/innerHeight*2 + STATE.orbitBase[1], -0.5, 0.5)]; }
  if (STATE.chapter.id!=='control') return;
  const x = (e.clientX/innerWidth - 0.5) * 2;     /* -1 .. 1 across the frame */
  STATE.steer = clamp(x, -1, 1) * 22;              /* degrees of steer at full deflection */
  { const e2=$('#hSteer'); if(e2) e2.textContent = STATE.steer.toFixed(1)+'°'; }
}, {passive:true});
/* press: the brake lever squeezes (control) · drag: the closer orbits (order). Discovered, never captioned. */
STATE.press = 0; STATE.orbit = [0,0]; STATE.orbitBase = [0,0]; STATE.dragFrom = null;
addEventListener('pointerdown', e=>{ if (e.target.closest('button, a, input')) return; STATE.press = 1; STATE.dragFrom = [e.clientX, e.clientY]; STATE.orbitBase = STATE.orbit.slice();
  if (STATE.chapter.id==='control'){ STATE.lever = 1; const el=$('#hLever'); if(el) el.textContent='100 %'; } }, {passive:true});
const release = ()=>{ STATE.press = 0; STATE.dragFrom = null; };
addEventListener('pointerup', release, {passive:true}); addEventListener('pointercancel', release, {passive:true});
/* the scrub line · the film's only index */
addEventListener('scroll', ()=>{ const h = document.documentElement.scrollHeight - innerHeight; document.documentElement.style.setProperty('--prog', (h>0 ? Math.min(100, scrollY/h*100) : 0).toFixed(2)+'%'); }, {passive:true});

/* ── the hero: type waits for the light ────────────────────────────────── */
const hero = $('#top');
export function heroArrived(){
  if (STATE.heroDone) return; STATE.heroDone = true; hero.classList.add('in'); emit();
}
/* the data strip: every number read from the model's numbers, never typed */
function fillStrip(g){
  const w = g.wheel, d = g.drivetrain, u = g.drive_unit, b = g.battery;
  const items = [
    ['Torque', u.torque_nm+' Nm'], ['Battery', b.wh+' Wh'], ['Cells', b.cells+' × 21700'],
    ['Wheel', w.bsd+' × '+w.tyre], ['Circumference', (w.circumference/1000).toFixed(3)+' m'],
    ['Cassette', d.cassette[0]+' to '+d.cassette[d.cassette.length-1]], ['Chain', d.chain_links+' links'],
    ['Sizes', Object.values(g.sizes).map(s=>s.label).join(' ')], ['Reduction', u.planetary.total+' : 1'],
  ];
  const run = items.map(([k,v])=>`<span>${k}<b>${v}</b></span>`).join('');
  /* two copies, the animation moves one width · seamless at any viewport */
  /* the marquee strip is retired (owner 2026-09-06) · the numbers still feed the readouts and the verifier */
  const stripEl = $('#strip'); if (stripEl) stripEl.innerHTML = `<div class="run">${run}${run}</div>`;
  window.MORAINE_STRIP = run;
}

/* ── boot ──────────────────────────────────────────────────────────────── */
export async function bootSite(geometryUrl){
  try { STATE.geometry = await (await fetch(geometryUrl)).json(); fillStrip(STATE.geometry); }
  catch(e){ console.warn('geometry.json missing', e); }
  setCurrent('top'); setWord('MORAINE', CHAPTERS[0]); secs[0].el.classList.add('on'); document.documentElement.classList.add('heroOn');
  readScroll();
  /* without a renderer (no WebGPU) the page still has to be a page: the hero keeps the
     blue-hour still and the night palette, every later chapter is paper */
  if (document.documentElement.classList.contains('nogpu')){
    const sunFor = ()=>{};   /* the ground is the scene's (v3 · three acts) */
    sunFor(); STATE.listeners.add(sunFor); heroArrived();
  }
  const loop = now=>{ tickCounters(now); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  /* reduced motion: no seven-second wait for the type */
  if (REDUCED) heroArrived();
}
export { CHAPTERS };

/* ═══════════ MORAINE · the scene ═══════════
   The bridge between the page's state machine (_site.js: which chapter, how
   far, which size, which colour) and the renderer (_render.js). Every 3D beat
   on the page is a Blender timeline range sampled at a time this file picks:
   the hero on a wall clock, every other chapter on the scrollbar.

   Nothing here is a keyframe. The keyframes are in the GLBs. */

let R = null;                 /* the renderer, once booted */
let CLIPS = null;             /* model/clips.json · ranges in frames, fps */
let VAT = null;               /* model/tyre_vat.json */
const FPS = ()=>CLIPS?.fps || 30;
const sec = (glb, range, t01)=>{ const r = CLIPS?.[glb]?.[range]; if (!r) return 0; return (r[0] + (r[1]-r[0])*clamp(t01,0,1)) / FPS(); };
const eOutCubic = t => 1-Math.pow(1-t,3);

/* node selectors · a chapter times only the nodes it owns; everything else
   holds the rest pose. Names are the contract's. */
const N = {
  bikeAll:   n => n.glb==='bike',
  driveUnit: n => n.glb==='bike' && /^(MotorRoot|MotorX_|Motor_|Sun[12]|Carrier[12]|Planet|Ring[12]|Spindle|TorqueSensor)/.test(n.name),
  battery:   n => n.glb==='bike' && /^(BatteryCover|BatteryCase|BatteryLid|Cell_)/.test(n.name),
  brakes:    n => n.glb==='bike' && /^(Lever|Piston|Pad)/.test(n.name),
  hero:      n => n.glb==='bike' && !/^(MotorX_|BatteryCover|BatteryCase|BatteryLid|Cell_)/.test(n.name),
  drivetrain:n => n.glb==='drivetrain',
  rearWheel: n => n.glb==='bike' && /^(WheelR|HubR|RimR|RotorR|SpokesR|TyreR)$/.test(n.name),
  contact:   n => n.glb==='contact',
  cameras:   n => /^Cam_/.test(n.name),
};
/* the two grades · the page is one exposure for the bike chapters and another for the macro, and
   both are written every frame so neither leaks into the other */
const BIKE_GRADE = { ev:0.62, exposure:0.15, contrast:0.10, saturation:0.04, contact:0.6, contactRadius:90, dust:0.25, aoRadius:18, hazeAmt:0, specStrength:1, envStrength:1 };
const MACRO = { key:2.60, studio:1.00, sun:0.05, grade:{ ambient:0.09, spotRange:1400,
  ev:0.30, exposure:-0.05, contrast:0.26, saturation:0.02, specStrength:0.45, envStrength:0.80,
  contact:0.95, contactRadius:26, dust:0.05, aoRadius:7,
  /* hazeCol is a LINEAR scene radiance, not a screen colour: it goes through ev and AgX like
     everything else, so the page's paper needs roughly paper/ev to survive the grade. */
  hazeAmt:0.92, hazeNear:320, hazeFar:1250, hazeCol:[1.70, 1.65, 1.55] } };

/* material pointer channels are timed by material name, not node */
const MAT = { paint:'Paint', motorCase:'Motor_Case' };

/* ── the hose rig · the GLB carries no runtime IK, so the page bends the hoses ─────────
   Blender solved these with IK against four empties and the export keeps them: _HoseBarL and
   _HoseBarR ride the Bar, _HoseFork rides the Fork, _HosePort is bolted to the frame. Both ends of
   the FRONT hose sit on the steerer, so it turns as one rigid piece: the whole angle on its first
   bone, nothing after. The REAR hose has one end on the bar and the other on the frame, so it is
   SOLVED, not swept. Sweeping it (the whole angle on the first bone, an eased share given back
   along the run) left the tail 40 mm off the port at full lock, because unwinding an ORIENTATION
   does not undo the DISPLACEMENT the parents already applied. FABRIK against the two live anchors
   keeps every bone length and puts the tail on the port at any angle. */
const HOSE = { front:[], rear:[], built:false, pivot:null, rig:null, bar:null, port:null,
               restPts:null, pts:null, len:null, tipLocal:null };
function nrm(v){ const l=Math.hypot(v[0],v[1],v[2])||1; return [v[0]/l,v[1]/l,v[2]/l]; }
/* Rodrigues · rotate v about a unit axis by ang */
function vrot(v, k, ang){
  const c=Math.cos(ang), s=Math.sin(ang);
  const kv=[k[1]*v[2]-k[2]*v[1], k[2]*v[0]-k[0]*v[2], k[0]*v[1]-k[1]*v[0]];
  const kd=k[0]*v[0]+k[1]*v[1]+k[2]*v[2];
  return [v[0]*c+kv[0]*s+k[0]*kd*(1-c), v[1]*c+kv[1]*s+k[1]*kd*(1-c), v[2]*c+kv[2]*s+k[2]*kd*(1-c)];
}
/* rotate v by the INVERSE of quaternion q · takes a parent-space direction into the bone's own frame */
function vbyqinv(v, q){
  const x=-q[0], y=-q[1], z=-q[2], w=q[3];
  const tx=2*(y*v[2]-z*v[1]), ty=2*(z*v[0]-x*v[2]), tz=2*(x*v[1]-y*v[0]);
  return [v[0]+w*tx+(y*tz-z*ty), v[1]+w*ty+(z*tx-x*tz), v[2]+w*tz+(x*ty-y*tx)];
}
/* rotate v BY quaternion q */
function vbyq(v, q){
  const x=q[0], y=q[1], z=q[2], w=q[3];
  const tx=2*(y*v[2]-z*v[1]), ty=2*(z*v[0]-x*v[2]), tz=2*(x*v[1]-y*v[0]);
  return [v[0]+w*tx+(y*tz-z*ty), v[1]+w*ty+(z*tx-x*tz), v[2]+w*tz+(x*ty-y*tx)];
}
/* the shortest rotation taking unit a onto unit b */
function qFromTo(a, b){
  const d = a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  if (d >  0.999999) return [0,0,0,1];
  if (d < -0.999999){
    let o = Math.abs(a[0]) > 0.9 ? [0,1,0] : [1,0,0];
    const c = nrm([a[1]*o[2]-a[2]*o[1], a[2]*o[0]-a[0]*o[2], a[0]*o[1]-a[1]*o[0]]);
    return [c[0], c[1], c[2], 0];
  }
  const c=[a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]], w=1+d;
  const l=Math.hypot(c[0],c[1],c[2],w)||1;
  return [c[0]/l, c[1]/l, c[2]/l, w/l];
}
/* a world point into the space of a node whose world matrix is m · general affine, scale allowed */
function intoLocal(m, p){
  const a=m[0],b=m[4],c=m[8], d=m[1],e=m[5],f=m[9], g=m[2],h=m[6],i=m[10];
  const det = a*(e*i-f*h) - b*(d*i-f*g) + c*(d*h-e*g) || 1;
  const x=p[0]-m[12], y=p[1]-m[13], z=p[2]-m[14];
  return [ ((e*i-f*h)*x + (c*h-b*i)*y + (b*f-c*e)*z)/det,
           ((f*g-d*i)*x + (a*i-c*g)*y + (c*d-a*f)*z)/det,
           ((d*h-e*g)*x + (b*g-a*h)*y + (a*e-b*d)*z)/det ];
}
function buildHoseRig(){
  HOSE.built = true;
  const H = R.scene?.('bike'); if (!H) return; const sc = H.scene;
  sc.updateWorld();
  const st = sc.byName.get('Steer'); if (!st) return;
  const aw = nrm([st.world[4], st.world[5], st.world[6]]);          /* the steerer's own Y, in world */
  const pw = [st.world[12], st.world[13], st.world[14]];            /* and the point it turns about */
  const chain = re => sc.nodes.filter(n=>re.test(n.name)).sort((a,b)=>a.name.localeCompare(b.name)).map(n=>{
    const par = n.parent>=0 ? sc.nodes[n.parent] : null, m = par ? par.world : null;
    /* the steer axis and pivot in this bone's PARENT space */
    const ap = m ? nrm([ m[0]*aw[0]+m[1]*aw[1]+m[2]*aw[2],
                         m[4]*aw[0]+m[5]*aw[1]+m[6]*aw[2],
                         m[8]*aw[0]+m[9]*aw[1]+m[10]*aw[2] ]) : aw;
    let pp = pw;
    if (m){ const d=[pw[0]-m[12], pw[1]-m[13], pw[2]-m[14]];
      pp = [ m[0]*d[0]+m[1]*d[1]+m[2]*d[2], m[4]*d[0]+m[5]*d[1]+m[6]*d[2], m[8]*d[0]+m[9]*d[1]+m[10]*d[2] ]; }
    return { name:n.name, axisParent:ap, pivot:pp, rest:[n.t[0],n.t[1],n.t[2]],
             /* pose() post-multiplies, so the axis has to be expressed AFTER the bone's rest
                rotation · without this the bone turns about a skewed axis and the run flies out */
             axisLocal: nrm(vbyqinv(ap, [n.r[0],n.r[1],n.r[2],n.r[3]])) };
  });
  HOSE.front = chain(/^hf_\d+$/);
  /* the rear run keeps its rest chain in HoseRig space · everything downstream is solved there, so
     the bike's own travel and the size morphs never enter the arithmetic */
  HOSE.rig  = sc.byName.get('HoseRig')   || null;
  HOSE.bar  = sc.byName.get('_HoseBarR') || null;
  HOSE.port = sc.byName.get('_HosePort') || null;
  HOSE.rear = sc.nodes.filter(n=>/^hr_\d+$/.test(n.name)).sort((a,b)=>a.name.localeCompare(b.name))
                .map(n=>({ name:n.name, t:[n.t[0],n.t[1],n.t[2]], r:[n.r[0],n.r[1],n.r[2],n.r[3]] }));
  if (!(HOSE.rig && HOSE.port && HOSE.rear.length)) return;
  const P = [], A = [[0,0,0,1]];                 /* A[i] = HoseRig space → bone i's PARENT frame */
  let p = [0,0,0];
  for (let i=0;i<HOSE.rear.length;i++){
    const off = vbyq(HOSE.rear[i].t, A[i]);
    p = [p[0]+off[0], p[1]+off[1], p[2]+off[2]];
    P.push(p);
    A.push(qmul(A[i], HOSE.rear[i].r));
  }
  const last = HOSE.rear.length - 1;
  const portRig = intoLocal(HOSE.rig.world, [HOSE.port.world[12], HOSE.port.world[13], HOSE.port.world[14]]);
  /* at rest the last bone's TAIL sits on the port (Blender solved it there with use_tail), so the
     tail offset in that bone's own frame is exactly the gap the FK leaves */
  HOSE.tipLocal = vbyqinv([portRig[0]-P[last][0], portRig[1]-P[last][1], portRig[2]-P[last][2]], A[last+1]);
  HOSE.restPts = P.concat([portRig]);
  HOSE.pts = HOSE.restPts.map(v=>v.slice());
  HOSE.len = HOSE.restPts.slice(0,-1).map((v,i)=>Math.hypot(
    HOSE.restPts[i+1][0]-v[0], HOSE.restPts[i+1][1]-v[1], HOSE.restPts[i+1][2]-v[2]));
}
let hoseAt = null;
function poseHoses(deg){
  if (!HOSE.built) buildHoseRig();
  /* no change-guard here on purpose: the range sampler rewrites these bones from the clip every
     frame, so a pose written once is undone on the next one. Measured, not guessed: with the
     guard in place hf_00's world position was identical at -22°, 0° and +22°. */
  hoseAt = deg;
  const rad = deg*Math.PI/180;
  const sc = R.scene?.('bike')?.scene; if (!sc) return;
  /* the front run turns about the steerer's axis THROUGH the steerer, which is a rotation and a
     move · a bone rotates about its own head, and the lever sits 200 mm off the steering axis, so
     rotation alone throws the run sideways. The rest of the chain follows as children. */
  const b = HOSE.front[0];
  if (b){
    const d = [b.rest[0]-b.pivot[0], b.rest[1]-b.pivot[1], b.rest[2]-b.pivot[2]];
    const r = vrot(d, b.axisParent, rad);
    sc.setTranslation(b.name, [b.pivot[0]+r[0], b.pivot[1]+r[1], b.pivot[2]+r[2]]);
    R.pose(b.name, axisAngle(b.axisLocal, rad));
  }
  for (let i=1;i<HOSE.front.length;i++) R.pose(HOSE.front[i].name, [0,0,0,1]);
  solveRear(sc);
}
/* FABRIK on the rear run · the head is pinned to the bar anchor (already carried round by this
   frame's Steer pose) and the tail to the frame port, every bone length kept. It restarts from the
   rest shape each frame, so the solution is a function of the steer angle and nothing accumulates. */
function solveRear(sc){
  if (!HOSE.restPts || !HOSE.bar || !HOSE.port || !HOSE.rig) return;
  sc.updateWorld();                              /* the Steer pose was written a line ago; read it back */
  const W = HOSE.rig.world;
  const A = intoLocal(W, [HOSE.bar.world[12],  HOSE.bar.world[13],  HOSE.bar.world[14]]);
  const B = intoLocal(W, [HOSE.port.world[12], HOSE.port.world[13], HOSE.port.world[14]]);
  const P = HOSE.pts, L = HOSE.len, n = HOSE.rear.length, last = P.length - 1;
  for (let i=0;i<=last;i++){ P[i][0]=HOSE.restPts[i][0]; P[i][1]=HOSE.restPts[i][1]; P[i][2]=HOSE.restPts[i][2]; }
  const reach = (a, from, l) => {
    const d=[P[a][0]-P[from][0], P[a][1]-P[from][1], P[a][2]-P[from][2]];
    const m=Math.hypot(d[0],d[1],d[2])||1e-6;
    P[a][0]=P[from][0]+d[0]/m*l; P[a][1]=P[from][1]+d[1]/m*l; P[a][2]=P[from][2]+d[2]/m*l;
  };
  for (let it=0; it<16; it++){
    P[last][0]=B[0]; P[last][1]=B[1]; P[last][2]=B[2];
    for (let i=last-1;i>=0;i--) reach(i, i+1, L[i]);
    P[0][0]=A[0]; P[0][1]=A[1]; P[0][2]=A[2];
    for (let i=1;i<=last;i++) reach(i, i-1, L[i-1]);
  }
  /* points back to bone transforms · each bone aims its child's rest offset down the solved segment */
  sc.setTranslation(HOSE.rear[0].name, [P[0][0], P[0][1], P[0][2]]);
  let acc = [0,0,0,1];                           /* HoseRig space → this bone's PARENT frame */
  for (let i=0;i<n;i++){
    const bone = HOSE.rear[i];
    const childLocal = (i < n-1) ? HOSE.rear[i+1].t : HOSE.tipLocal;
    const u = nrm([P[i+1][0]-P[i][0], P[i+1][1]-P[i][1], P[i+1][2]-P[i][2]]);
    const q = qFromTo(nrm(childLocal), vbyqinv(vbyqinv(u, acc), bone.r));
    R.pose(bone.name, q);
    acc = qmul(qmul(acc, bone.r), q);
  }
}

/* ── the gravel bed rolls by modulo its own period ──────────────────────────────────
   The ground slides 7.4 m past a fixed camera. Covering that at gravel density is 50k+ vertices, so
   the bed is PERIODIC in X and only three cells long, and its travel is taken modulo the period.
   The sawtooth has to live HERE and not in the file: baked keys would be right at every integer
   frame and wrong between them, and the scrub samples continuously, so the bed would slide a whole
   period backwards inside one frame. Evaluating the modulo directly is exact at any sub-frame time. */
let bedRest = null;
function rollGravel(t){
  const P = VAT?.gravel_period_mm, VS = VAT?.surface_mm_per_frame;
  if (!P || !VS) return;
  const sc = R.scene?.('contact')?.scene; if (!sc) return;
  if (!bedRest){ const n = sc.byName.get('GravelBed'); if (!n) return; bedRest = [n.t[0], n.t[1], n.t[2]]; }
  const travel = VS * t * ((VAT.frames || 90) - 1);
  sc.setTranslation('GravelBed', [bedRest[0] - (travel % P), bedRest[1], bedRest[2]]);
}

/* ── the cutaway · the frame stops hiding the unit it contains ────────────────────
   The exploded drive unit sits inside an opaque frame, so its parts came out through the down
   tube. Rather than throwing the spread wider, which loses the scale of the thing, every part
   that is NOT the drive unit thins to a stipple while the case is glass, and returns on the way
   out. */
let ghostApplied = -1, ghostNow = 0, batGhost = 0, camHandover = false, lastChapter = null, lastId = null;
let tRaw = 0, tSmooth = 0, chapterJustChanged = false;
/* THE CURTAIN · the one honest cut on the page (contact↔drivetrain, paper→ink). It is TIME-driven, not
   scroll-driven: a scroll-driven wipe parks half-drawn over the product the moment the reader stops, which
   is what the owner saw (2026-09-06, "the big orange line animation is hiding the wheel"), and it left the
   ground's paper→ink flip happening in the open, which is the flash. 0.62 s: 0.30 in, 0.32 out, the act
   changes at the midpoint when the frame is fully covered. */
const WIPE = { t0: -9, dur: 0.62, on: false, hold: null };
const wipeU = now => WIPE.hold != null ? WIPE.hold : (WIPE.on ? clamp((now - WIPE.t0)/1000 / WIPE.dur, 0, 1) : -1);
window.MORAINE_WIPE = WIPE;   /* the gate and the ladder hold the curtain at a chosen point to photograph it */
function applyGhost(amount){
  if (Math.abs(amount - ghostApplied) < 0.004) return;
  ghostApplied = amount;
  const B = R.scene?.('bike'), D = R.scene?.('drivetrain');
  /* PARTS ONLY (owner review 2026-09-05, RESEARCH.md rule 1). The cutaway used to thin the frame,
     battery and cranks to a 0.28 stipple and leave the wheels, fork, bars and saddle solid · so the
     exploded motor sat inside a whole ghost bike and was never the subject, and the stipple itself
     read as a white wash arriving at the section cut. Brose #0000–#0014: nothing but the part is
     present. Everything that is not the drive unit now fades to ZERO, wheels included, and the
     drivetrain scene with it. What remains is the motor, alone on the paper. */
  if (B) R.ghost(B, n => !N.driveUnit(n) && !/^Stone_/.test(n.name), lerp(1, 0, amount));
  if (D) R.ghost(D, () => true, lerp(1, 0, amount));
}
/* ONE PART PER BEAT (rule 2 and 3). As each part separates it is the subject; the ones already out
   drop to a translucent 0.16 so the eye is handed forward, Brose #0005–#0009. Beats are the explode
   windows animate.py keys, expressed as t across the drive range. */
const DRIVE_BEATS = [
  { parts: /^MotorX_Case[LR]$|^Motor_Case[LR]$/, from: 0.10, to: 0.28 },
  { parts: /^MotorX_Stator$|^Motor_Stator$/,     from: 0.32, to: 0.48 },
  { parts: /^MotorX_Rotor$|^Motor_Rotor$/,       from: 0.52, to: 0.68 },
  { parts: /^MotorX_Stage[12]$|^(Sun|Carrier|Planet|Ring)[12]/, from: 0.72, to: 0.88 },
  { parts: /^MotorX_Spindle$|^Spindle$|^TorqueSensor$/, from: 0.90, to: 1.00 },
];
let beatApplied = -1;
function applyDriveBeats(t, on){
  const key = on ? Math.round(t * 200) : -2;
  if (key === beatApplied) return; beatApplied = key;
  const B = R.scene?.('bike'); if (!B) return;
  if (!on){ for (const b of DRIVE_BEATS) R.ghost(B, n => b.parts.test(n.name), 1); return; }
  let current = -1;
  for (let i = 0; i < DRIVE_BEATS.length; i++) if (t >= DRIVE_BEATS[i].from) current = i;
  for (let i = 0; i < DRIVE_BEATS.length; i++){
    const b = DRIVE_BEATS[i];
    /* the subject is solid; parts already out go translucent; parts not yet out stay solid in place */
    const p = i < current ? 0.30 : 1;
    R.ghost(B, n => b.parts.test(n.name), p);
  }
}
/* the battery cutaway is the OPPOSITE of the drive one · there the case goes to glass to show the
   gears inside it, here the FRAME goes to glass to show the pack inside the tube, and the pack has
   to stay solid or there is nothing to look at. Same mechanism, different subject. */
let ghostBatApplied = -1;
function applyGhostBattery(amount){
  if (Math.abs(amount - ghostBatApplied) < 0.004) return;
  ghostBatApplied = amount;
  const B = R.scene?.('bike');
  if (B) R.ghost(B, n => /^(Frame|BatteryCover)$/.test(n.name), lerp(1, 0.22, amount));
}

/* ── ranges unwind, they never freeze ────────────────────────────────────────────
   A chapter used to be the only thing that wrote its own nodes, so leaving the drive chapter left
   the motor hanging in pieces and coming back to it snapped. Every range now carries a weight that
   eases to 1 while its chapter owns the viewport and back to 0 after, and the range is sampled at
   a time between its rest and its live time. Nothing jumps, and nothing is left apart behind you. */
const RANGES = {
  drive:   { f:N.driveUnit,  rest:r=>r, mat:MAT.motorCase },
  battery: { f:N.battery,    rest:r=>r },
  brakes:  { f:N.brakes,     rest:r=>r },
  dtrain:  { f:N.drivetrain, rest:()=>sec('drivetrain','run',0) },
  contact: { f:N.contact,    rest:()=>sec('contact','roll',0) },
};
const RW = {}; for (const key in RANGES) RW[key] = 0;
function applyRanges(want, restT, k){
  for (const key in RANGES){
    const Rg = RANGES[key], live = want[key], rest = Rg.rest(restT);
    const target = live===undefined ? 0 : 1;
    RW[key] = lerp(RW[key], target, k);
    if (RW[key] < 0.0008){ if (RW[key] !== 0){ RW[key] = 0; R.setTime(Rg.f, rest); if (Rg.mat) R.setPointerTime(Rg.mat, rest); } continue; }
    const at = lerp(rest, live===undefined ? rest : live, RW[key]);
    R.setTime(Rg.f, at);
    if (Rg.mat) R.setPointerTime(Rg.mat, at);
  }
}

/* ── the hero clock ────────────────────────────────────────────────────── */
const HERO = { t0:0, dur:8.0, playing:false, done:false };
let filmSun = 0, wmH0 = 0, dtGhost = 0, groundNow = 1, themeSet = -1, spinNow = 0, brakeNow = 0, orbitNow = [0,0];
/* THE GROUND IS THREE ACTS (owner review 2026-09-05 · "the background is always the same?"). Paper for the
   opening (hero, geometry, contact), ink for the inside act (drivetrain x-ray, exploded motor, battery),
   paper again for the outside act (paint, cockpit, buy). The cut to ink hides under the bar wipe; the return
   to paper rides the battery→finish camera travel. --sun is the page's paper-vs-night, theme the renderer's. */
const GROUND = { top:1, geometry:1, contact:1, drivetrain:0, drive:0, battery:0, finish:1, control:1, order:1 };
const writeSun = () => {
  const v = HERO.done ? groundNow : Math.max(sunNow, filmSun);
  document.documentElement.style.setProperty('--sun', v.toFixed(3));
  if (Math.abs(v - themeSet) > 0.004){ themeSet = v; R.set?.({ theme: 0, inkMode: 1 - v }); }
};
/* ── the opening · 8 s on a wall clock, plays once (hero v3 · THE ASSEMBLY, 2026-09-06) ─────────
   The bike is BUILT in front of the camera; the clip `arrive` (10–226) runs in real time from T 0.8
   (film T = 0.8 + (frame-10)/30). Page beats, seconds:
   0.0–0.9  black; one orange stroke draws itself at the down tube's angle (the shape)
   0.9–1.5  the stroke fattens into the strokes of an M
   1.5–2.6  O·R·A·I·N·E land one per 0.16 s on the same baseline (Apple: one word per beat)
   0.8–3.4  behind the type, in the dark studio, every part of the bike hangs scattered and drifts,
            lit by the key alone · the frame does not exist yet (renderer `grow` < 0)
   3.4–3.55 a white flash (Apple #0013); the sun rises in the file (frames 84–100); ground → paper
   3.4–4.4  the frame DRAWS ITSELF along its tubes from the bottom bracket up the down tube (the
            stroke's own line, in 3D), a hot orange cut edge leading (`_GROW` attribute)
   3.8–6.0  part by part in build order the parts FLY to their seats on a spring: drive unit,
            pack + hatch, rear wheel spinning, cockpit from above, front wheel spinning, calliper,
            post, saddle, badge · the drivetrain (its own GLB) spins in from the drive side ·
            the studio key orbits so the highlight travels · the camera pulls out on an ease
   4.2–6.6  the wordmark shrinks toward the nav
   6.4–6.9  the LANDING: the bike drops 70 mm, the levers squeeze, the stones kick, the camera shakes
   6.6–8.0  hold; the caption lands bottom-left
   Every beat is a function of T so it can be sampled by a wall-clock ladder and gated. */
const FILM = { clip0: 0.8, spring: u => { u = clamp(u,0,1); const c = 0.7*1.525; if (u < 0.5){ const x = 2*u; return (x*x*((c+1)*x - c))/2; } const x = 2*u-2; return (x*x*((c+1)*x + c) + 2)/2; } };   /* the same ease-in-out 'back' as animate.spring */
const HOSES = /^(HoseF|HoseR)$/;
const WM = () => document.querySelectorAll('#wm b');
let hoseSet = -1, growSet = 9, dtFly = null;
function filmClipSec(T){ return (10 + Math.max(0, T - FILM.clip0) * FPS()) / FPS(); }
function heroFilm(T){
  const flash = document.getElementById('flash'), wm = document.getElementById('wm'), cap = document.querySelector('.k[data-for="top"]');
  /* the shape */
  if (T < 0.9)      SHAPE.set('stroke', 1, clamp(T/0.9,0,1), 1);
  else if (T < 1.5) SHAPE.set('stroke>strokeFat', (T-0.9)/0.6, 1, 1);
  else if (T < 2.6) SHAPE.set('strokeFat>none', clamp((T-1.5)/0.5,0,1), 1, 1 - clamp((T-1.5)/0.6,0,1));
  else              SHAPE.set('none', 1, 1, 0);
  /* the letters · M lands as the stroke fattens, the rest one per 0.16 s */
  const letters = WM(); const lit = T < 1.2 ? 0 : Math.min(7, 1 + Math.max(0, Math.floor((T-1.5)/0.16 + 1)));
  letters.forEach((b,i)=>{ const on = i < lit; if (b.classList.contains('on') !== on) b.classList.toggle('on', on); });
  /* the flash and the ground */
  const fl = T < 3.4 ? 0 : T < 3.5 ? (T-3.4)/0.1 : T < 3.95 ? 1 - (T-3.5)/0.45 : 0;
  if (flash) flash.style.opacity = fl.toFixed(3);
  document.documentElement.classList.toggle('filmDark', T < 3.45);
  window.MORAINE_FILM_T = T;
  { const fs = T >= 3.4 ? 1 : 0; if (fs !== filmSun){ filmSun = fs; writeSun(); } }
  /* the frame draws itself · grow < 0 = no frame at all, 0..1 = the tubes in build order, 2 = off */
  { const g = T < 3.5 ? -0.01 : T < 4.6 ? K.ease((T-3.5)/1.1) * 1.02 : 2;
    if (g !== growSet){ growSet = g; R.set?.({ grow: g }); } }
  /* the wordmark shrinks toward the nav as the bike assembles under it */
  const z = clamp((T-3.6)/2.0,0,1); const zs = 1 - 0.78*K.ease(z);
  const fly = K.ease(clamp((T-6.5)/0.7,0,1));
  document.documentElement.classList.toggle('wmFlying', T < 7.15);
  if (wm){
    if (T < 3.6) wmH0 = wm.getBoundingClientRect().height || wmH0;
    const bb = document.querySelector('.brand b')?.getBoundingClientRect();
    const cy0 = innerHeight*(0.5 - 0.38*K.ease(z)), cx0 = innerWidth/2;
    const sEnd = (bb && wmH0) ? bb.height/wmH0 : zs;
    const sc = lerp(zs, sEnd, fly), cx = bb ? lerp(cx0, bb.left + bb.width/2, fly) : cx0, cy = bb ? lerp(cy0, bb.top + bb.height/2, fly) : cy0;
    wm.style.setProperty('--wms', sc.toFixed(4)); wm.style.left = cx.toFixed(1)+'px'; wm.style.top = cy.toFixed(1)+'px';
    wm.style.opacity = T < 3.4 ? '1' : lerp(1 - 0.35*K.ease(z), 1, fly).toFixed(3);
    wm.classList.toggle('parked', T >= 7.15);
  }
  /* the hoses · solved at runtime between targets that are flying apart, so they wait for the
     cockpit to seat (T 5.7) and come up as the front wheel lands */
  const B = R.scene?.('bike'), D = R.scene?.('drivetrain');
  { const h = K.ease(clamp((T-5.75)/0.45,0,1)); if (B && h !== hoseSet){ hoseSet = h; R.ghost(B, n => HOSES.test(n.name), h); } }
  /* the drivetrain rides the bike (parentWorld = BikeRoot's world) · during the film it FLIES IN
     from the drive side, spinning once about the bottom bracket, on the same spring as the parts
     (frames 120–148 → T 4.47–5.40), and drifts with the scattered parts before that */
  if (D && B){
    const root = B.scene.byName.get('BikeRoot');
    if (root){
      const k = 1 - FILM.spring((T - 4.467) / 0.933);
      if (k > 0.0005){
        const ph = clamp((T - 0.8) / 2.6, 0, 1);
        const arc = (k > 0 && k < 1) ? 90*Math.sin(Math.PI*k) : 0;
        const off = [-120*k + 26*Math.sin(2*Math.PI*(0.27*ph + 0.9))*k, -160*k + (38*Math.sin(2*Math.PI*(0.38*ph + 0.31)) + arc)*k, 700*k];
        const q = R.quatAxis([0,0,1], (1.0*2*Math.PI + 0.55*ph) * k);
        dtFly = dtFly || new Float32Array(16);
        const O = R.M4.fromTRS(off, q, [1,1,1]);
        D.scene.parentWorld = R.M4.mul(root.world, O, dtFly);
      } else D.scene.parentWorld = root.world;
    }
  }
  /* the caption */
  if (cap){ cap.classList.toggle('live', T > 6.4); const c = cap.querySelector('.cap'), a = cap.querySelector('.k-cta');
    if (c) K.show(c, clamp((T-6.6)/1.0,0,1), 0.0, 9, 10); if (a) K.show(a, clamp((T-7.0)/1.0,0,1), 0.0, 9, 10); }
}
/* ── THE ENVIRONMENTS (owner 2026-09-06: "for each section a 3D realistic environment that comes
   into view with easing animations and physics") · env.glb, contract in model/env/CONTRACT.md.
   Three places, staged by node-name prefix: E1 the gravel plateau (hero, contact, configure), E2 a
   photo-studio cyclorama (geometry, finish, control), E4 a night workshop (the ink act). Each has an
   ENTRANCE keyed in Blender · boulders drop and settle (rigid bodies), the cyc rises from below the
   floor, the lamp drops and swings as a pendulum · sampled on the SCROLL over the incoming chapter's
   hand-over travel (the same 30 % the camera travels), so the place arrives with the shot; the
   outgoing place fades on presence under the same travel. In the hero the boulders drop on the wall
   clock with the landing. */
const ENV_OF = { top:'E1', geometry:'E2', contact:'E1', drivetrain:'E4', drive:'E4', battery:'E4', finish:'E2', control:'E2', order:'E1' };
const ENV_IN = { E1:'boulders_in', E2:'cyc_in', E4:'lamp_in' };
const ENV_TRAVEL = 0.30;                                            /* the hand-over travel, as a fraction of the chapter */
let ENVC = null;
const ENV = { cur:null, prev:null, sky:null, skyDay:null, hazeSet:-1, lightSet:null, frustum:null, lastU:{} };
const esec = (range, u) => { const r = ENVC?.env?.[range]; if (!r) return 0; return (r[0] + (r[1]-r[0])*clamp(u,0,1)) / (ENVC?.fps || 30); };
function envInit(){
  const S = R.scene?.('env'); if (!S) return;
  /* the sky's material · its emissive is dimmed to night before the flash and in the ink act */
  const sky = S.scene.byName.get('E1_Sky');
  if (sky && sky.mesh >= 0){ const mi = S.scene.meshes[sky.mesh]?.prims?.[0]?.material; const M = mi >= 0 ? S.scene.materials[mi] : null;
    if (M){ ENV.sky = M; ENV.skyDay = Float32Array.from(M.emissive); } }
  for (const n of S.scene.nodes) n.hidden = !/^E1_/.test(n.name);       /* the page opens on the plateau */
  /* the sky (r 6 km) and the ridges (2.5 to 4 km out) come in to 1 % of their distance: the same picture from
     a camera 3 m off the origin, and the far plane stays under 120 m · at 10.9 km the fp16 linear depth of a
     macro subject went subnormal and the post pass painted the bike as page (teardown 2026-09-06) */
  for (const n of S.scene.nodes) if (/^E1_(Sky|Ridge_)/.test(n.name)){ n.t[0] *= 0.01; n.t[1] *= 0.01; n.t[2] *= 0.01; n.scaleMul = [0.01, 0.01, 0.01]; n.dirty = true; }
  R.setTime(n => n.glb==='env', esec('boulders_in', 0));                /* boulders not yet dropped (scale 0 at frame 0) */
}
function envSky(k, paperK = 0){
  const M = ENV.sky; if (!M) return;
  const night = [0.010, 0.014, 0.030], paper = [0.86, 0.83, 0.78];
  const wet = ENV.wet || 0;
  const warm = [1.04 - 0.30*wet, 0.97 - 0.24*wet, 0.88 - 0.10*wet];   /* a warm horizon, cooled and dropped while it rains */
  const e = [0,1,2].map(i => lerp(lerp(night[i], ENV.skyDay[i]*warm[i], k), paper[i], paperK));
  if (Math.abs(e[0]-M.emissive[0]) + Math.abs(e[1]-M.emissive[1]) + Math.abs(e[2]-M.emissive[2]) > 1e-4){ M.emissive[0]=e[0]; M.emissive[1]=e[1]; M.emissive[2]=e[2]; M.dirty = true; }
}
/* the shaft is NOT staged with its place: it is a blended cone the camera can be inside, so one rule owns
   its visibility (below) and staging must never un-hide it (teardown 2026-09-06: staging E4 as the OUTGOING
   place put the shaft back on for the whole battery→finish travel and the macro camera, a metre from the
   lamp, saw its back face as a beige veil over every pixel · that is the "washed out" bike) */
function envShow(S, E, on){ for (const n of S.scene.nodes) if (n.name.startsWith(E+'_') && n.name !== 'E4_Shaft') n.hidden = !on; }
/* id: the chapter · t: its scroll clock 0..1 · film: the hero's wall-clock seconds while the film plays, else null */
const CH_ORDER = ['top','geometry','contact','drivetrain','drive','battery','finish','control','order'];
function envFrame(id, t, film){
  const S = R.scene?.('env'); if (!S) return;
  const E = ENV_OF[id] || 'E1';
  ENV.cur = E;
  /* the OUTGOING place is the previous chapter's, by page order, not by history: a scroll up through a
     hand-over reverses it the same way, and nothing depends on which frame first saw the chapter (the
     first cut of this was exactly that: the smoothed t still carried the old chapter's 0.9 for a frame,
     the travel read as complete, and the previous place was dropped before it could fade · teardown
     2026-09-06). u is the hand-over travel from the RAW chapter t, never above the smoothed one. */
  const before = CH_ORDER[CH_ORDER.indexOf(id) - 1];
  const Ep = before ? ENV_OF[before] : null;
  const u = (film != null || !Ep) ? 1 : clamp(Math.min(t, STATE.t) / ENV_TRAVEL, 0, 1);
  ENV.prev = (Ep && Ep !== E && u < 1) ? Ep : null;
  const byE = X => (n => n.glb==='env' && n.name.startsWith(X+'_'));
  const eu = K.ease(u);
  const leaving = !!ENV.prev;
  envShow(S, E, true); R.ghost(S, byE(E), 1);          /* a place is always solid · it arrives and leaves by MOVING */
  if (film != null && E === 'E1'){
    /* the hero: the parts float in the DARK (a night sky, no ground · on a phone the widened lens showed a
       lit gravel floor under the scatter), the flash reveals the plateau, the boulders drop with the
       landing (T 6.35 → 8.35 = frames 0 → 60) */
    R.setTime(byE('E1'), esec('boulders_in', (film - 6.35) / 2.0));
    const world = K.ease(clamp((film - 3.42) / 0.5, 0, 1));
    R.ghost(S, n => n.glb==='env' && /^E1_(Ground|Rock_|Ridge_)/.test(n.name), world);
  } else {
    R.setTime(byE(E), esec(ENV_IN[E], u));
  }
  if (leaving){
    envShow(S, ENV.prev, true); R.ghost(S, byE(ENV.prev), 1);
    R.setTime(byE(ENV.prev), esec(ENV_IN[ENV.prev], ENV.prev === 'E1' ? 1 : 1 - u));
    /* EVERY place leaves by SINKING, and it starts sinking IMMEDIATELY. Two reasons, both measured:
       a screen-door crossfade of a whole ground plane crawls as the camera travels, which is the flicker
       the owner saw; and two floors sitting at the same height for the length of a hand-over z-fight,
       which is the same flicker by another route. 60 mm clears the depth fight on the first frame (it is
       invisible at these camera distances) and the rest of the travel carries it out of sight. */
    const SINK = 60 + 1400 * eu;
    for (const n of S.scene.nodes){
      if (!n.name.startsWith(ENV.prev + '_')) continue;
      if (/^(E1_Ground|E1_Rock_|E2_Cyc|E4_Floor|E4_Wall)/.test(n.name)){ n.t[1] -= SINK; n.dirty = true; }
    }
    /* the plateau's sky and ridges are 6 km of backdrop · they cannot sink, so they go once the arriving
       place has covered the frame */
    if (ENV.prev === 'E1') for (const n of S.scene.nodes) if (/^E1_(Sky|Ridge_)/.test(n.name)) n.hidden = eu > 0.75;
  }
  for (const X of ['E1','E2','E4']) if (X !== E && X !== ENV.prev) envShow(S, X, false);
  /* the workshop's light shaft is a blended cone under the lamp · a camera INSIDE it sees its back face
     as a beige wash over the whole frame (the drive and battery macros sit within a metre of the unit),
     so it exists only while the camera is outside the cone with a margin */
  { const shaft = S.scene.byName.get('E4_Shaft'), lamp = S.scene.byName.get('E4_Lamp');
    if (shaft){
      let on = (id === 'drivetrain' && E === 'E4' && film == null);
      if (on && lamp){
        /* and only from OUTSIDE the cone: the drive and battery macros look through it at a subject inside it,
           which is a veil, not a shaft */
        const gy = R.settings?.groundY ?? -280, ly = lamp.world[13], cp = R.cam.pos;
        const rAt = 1500 * clamp((ly - cp[1]) / Math.max(1, ly - gy), 0, 1) + 250;
        const d = Math.hypot(cp[0] - lamp.world[12], cp[2] - lamp.world[14]);
        on = d >= rAt && cp[1] <= ly;
      }
      shaft.hidden = !on;
    } }
  /* the sky · night before the flash, day on paper; hidden with E1 */
  const dayK = film != null ? clamp((film - 3.3) / 0.5, 0, 1) : 1;
  /* the sky's crossfade is an emissive lerp toward the page's paper, never a stipple */
  const paperK = (ENV.prev === 'E1') ? eu : (E === 'E1' && ENV.prev) ? 1 - eu : 0;
  envSky(dayK, paperK);
  if (E === 'E1' && ENV.prev){ const sky = S.scene.byName.get('E1_Sky'); if (sky) sky.presence = 1; }
  /* the workshop lamp is the ink act's key light; the plateau widens the shadow map to the near rocks */
  const wantLight = E === 'E4' ? 'Lamp_Workshop' : null;
  if (wantLight !== ENV.lightSet){ ENV.lightSet = wantLight; if (wantLight) R.light?.('studio', 'env', wantLight); else R.light?.('studio', 'env', null); }
  const fr = E === 'E1' ? 2400 : null;
  if (fr !== ENV.frustum){ ENV.frustum = fr; R.setShadowFrustum(fr ? [100, -280 + 200, 0] : null, fr); }
  /* aerial haze on the plateau · the ridges sit in it; off in the studio and the workshop */
  /* the workshop's haze is the ink itself: the floor's far edge (5 m from a macro camera) dissolves into
     the dark instead of reading as a table edge · the plateau's haze is the sky's warmth on the ridges */
  const hz = E === 'E1' ? 0.55 : E === 'E4' ? 0.85 : 0;
  if (hz !== ENV.hazeSet){ ENV.hazeSet = hz; R.set?.(E === 'E4' ? { hazeAmt: hz, hazeNear: 1800, hazeFar: 7000, hazeCol: [0.035, 0.040, 0.050] } : { hazeAmt: hz, hazeNear: 3000, hazeFar: 52000, hazeCol: [1.55, 1.42, 1.22] }); }   /* ridges now 25 to 40 m out */
  ENV.hazeE = E;
  /* RAIN ON THE GLASS · on the PLATEAU, where the sky, the ridges and the rocks fill the frame and
     the water has something to run over (owner 2026-09-07: in the workshop the background is black
     and you cannot see it). The hero film stays dry: the opening is the product arriving, not weather.
     The sky cools and drops a little while it rains, so the light agrees with the water. */
  { const wet = (E === 'E1' && film == null && (id === 'contact' || id === 'order')) ? 0.95 : 0;
    const cur = R.settings?.rain ?? 0;
    const to = leaving ? wet * eu : wet;
    if (Math.abs(to - cur) > 0.002) R.set?.({ rain: to, rainFall: 1.0, rainRefract: 1.0 });
    ENV.wet = to; }
}
window.MORAINE_ENV = ENV;

/* ── the bike answers the pointer with PHYSICS after the film (owner 2026-09-06: "mouse interactions
   with it with physics"). A damped spring yaws the whole bike toward the pointer (underdamped, so
   it overshoots and settles like a thing with mass), a lighter spring leans it into the turn and
   nods it with the pointer's height, and a fast pointer FLICKS it: the yaw takes an impulse and
   both wheels are spun up and coast down on friction. All of it is rotPost on the file's nodes, so
   the drivetrain, hoses and shadows ride along; every other chapter sees identity. */
const HP = { yaw:0, yawV:0, roll:0, rollV:0, pitch:0, pitchV:0, wF:0, wR:0, aF:0, aR:0, on:false, vx:0, vt:0 };
const HP_K = { yawTarget:0.30, yawK:14, yawZ:0.42, leanK:30, leanZ:0.55, friction:0.9 };   /* 0.42 swung the front wheel off the right edge at the bigger hero framing */
function heroPhysics(dt, c){
  const S = STATE, live = HERO.done && c.id === 'top';
  const px = live ? (S.pointer?.[0] || 0) : 0, py = live ? (S.pointer?.[1] || 0) : 0;
  const step = (x, v, target, k, z) => { const a = k*(target - x) - 2*Math.sqrt(k)*z*v; v += a*dt; x += v*dt; return [x, v]; };
  [HP.yaw, HP.yawV]     = step(HP.yaw, HP.yawV, px*HP_K.yawTarget, HP_K.yawK, HP_K.yawZ);
  [HP.roll, HP.rollV]   = step(HP.roll, HP.rollV, -px*0.03 - HP.yawV*0.035, HP_K.leanK, HP_K.leanZ);   /* leans into the turn, more when it is swinging */
  [HP.pitch, HP.pitchV] = step(HP.pitch, HP.pitchV, py*0.03, HP_K.leanK, HP_K.leanZ);
  /* the wheels: while the pointer is moving they are dragged toward its speed (a hand on the tyre),
     when it stops they coast down on friction */
  const fresh = live && HP.vt && (performance.now() - HP.vt) < 70;
  if (fresh){ const tgt = clamp(-HP.vx*4.5, -14, 14); const g = 1 - Math.exp(-dt*9); HP.wF += (tgt - HP.wF)*g; HP.wR += (tgt*0.8 - HP.wR)*g; }
  const fr = Math.exp(-dt*HP_K.friction);
  HP.wF *= fr; HP.wR *= fr; HP.aF += HP.wF*dt; HP.aR += HP.wR*dt;
  const q = qmul(axisAngle([0,1,0], HP.yaw), qmul(axisAngle([1,0,0], HP.roll), axisAngle([0,0,1], HP.pitch)));
  R.pose('BikeRoot', q);
  if (live){ R.pose('WheelF', axisAngle([0,0,1], HP.aF)); R.pose('WheelR', axisAngle([0,0,1], HP.aR)); HP.on = true; }
  else if (HP.on){ HP.on = false; HP.wF = HP.wR = 0; R.pose('WheelR', [0,0,0,1]); if (c.id !== 'contact') R.pose('WheelF', [0,0,0,1]); }
}
window.MORAINE_HP = HP;                                          /* the ladder reads it */
/* the landing shake · a few tenths of a degree, decaying over 0.5 s from the touch at T 6.8 */
function landingShake(T){
  const u = T - 6.8; if (u < 0 || u > 0.6) return null;
  const a = 0.22 * Math.exp(-u*7);
  return [a*Math.sin(u*52), a*0.8*Math.sin(u*41 + 1.3)];
}
function startHero(){
  if (matchMedia('(prefers-reduced-motion: reduce)').matches){ finishHero(); return; }
  HERO.t0 = performance.now(); HERO.playing = true;
}
function finishHero(){
  HERO.playing=false; HERO.done=true;
  heroFilm(9);                                        /* everything at its end state */
  const wm = document.getElementById('wm'); if (wm) wm.classList.add('parked');
  R.set?.({ grow: 2 });
  const B = R.scene?.('bike'), D = R.scene?.('drivetrain');
  if (B) R.ghost(B, n => HOSES.test(n.name), 1);
  if (B && D){ const root = B.scene.byName.get('BikeRoot'); if (root) D.scene.parentWorld = root.world; }
  R.setTime(N.hero, sec('bike','arrive',1));
  R.setPointerTime('lights', sec('bike','arrive',1));
  heroArrived();
}

/* ── per frame ─────────────────────────────────────────────────────────── */
const FRONT_END = /^(WheelF|HubF|RimF|RotorF|SpokesF|TyreF|Fork|CaliperF|HoseF|Steer|Stem|Bar|HeadUnit|Headlight|LeverL|LeverR)$/;
let frontGhost = 0, frontGhostSet = 0, driveTa = 0, tumbleSet = [], steerNow = 0, leverNow = 0, sizeW = {S:0,L:0,XL:0}, sizeT = 1/3, wayNow = 0, wayT = 0, tyreNow = 45, sunNow = 0;
const V = { stage:null, mix:-1 };
function show(key, root, on){ const H = R.scene?.(key); const n = H?.scene?.byName?.get(root); if (n) n.hidden = !on; }
function frame(now, dt){
  const S = STATE, c = S.chapter;
  /* Scroll arrives in steps · a wheel click is one jump of a hundred pixels, and a camera that
     reads the scrollbar directly moves in those same steps. Measured inside the finish chapter:
     the camera advanced on alternate frames, 0.49 mm/ms then 0.01, which is the stepping the eye
     reads as jank INSIDE a section rather than between them. The scrub is low-passed at about
     90 ms, short enough to feel attached to the hand and long enough to turn steps into motion. */
  tRaw = S.t; if (chapterJustChanged) tSmooth = tRaw;
  tSmooth += (tRaw - tSmooth) * (1 - Math.exp(-dt*11));
  const t = tSmooth;
  const contact = c.id==='contact';
  /* by MESH, not by root: a wheel or a stone parented outside BikeRoot would otherwise stay on stage */
  /* the stones are the hero's; they stay for the calm order page and go everywhere else */
  const stage = (c.id==='top' || c.id==='order') ? 'hero' : contact ? 'contactBike' : 'bike';
  /* THE MACRO IS NO LONGER A CUT. The whole bike used to vanish and a disembodied wheel appear in
     one frame, which is what reads as "it jumps to a single wheel": the camera was already easing
     across the boundary, but the SUBJECT swapped instantly. Both scenes are now on stage through
     the boundary and cross-dissolve on the renderer's per-part presence, so the elevation thins out
     as the macro comes up and the two framings overlap for about a fifth of a section. */
  const XF = 0.20;
  /* both dissolves run under the WIDE camera, never under the macro one: with the macro camera
     285 mm off the ground, a half-faded bike is a dark smear across the frame (measured · it made
     one frame of the entry read as a dip to black). So the swap is finished before the macro camera
     arrives and not started again until the next chapter's camera has taken over. */
  const mix = 0;
  /* the macro model is retired · the contact chapter is the bike's own wheel now. Its scene is
     still loaded (the VAT rig and the gravel bed), so take it off stage once rather than leave it
     drawing behind the studio backdrop. */

  const m = mix <= 0 ? 0 : mix >= 1 ? 1 : mix * mix * (3 - 2 * mix);
  if (Math.abs(m - V.mix) > 0.004){
    const was = V.mix; V.mix = m;
    const B=R.scene?.('bike'), D=R.scene?.('drivetrain'), C=R.scene?.('contact');
    if (C) R.ghost(C, () => true, m);
    for (const H of [B, D]) if (H) R.ghost(H, () => true, 1 - m);
    /* a fully faded scene comes OFF stage · a discarded fragment is still a draw and a shadow-pass
       vertex, and leaving both scenes resident cost 6 fps for nothing outside the dissolve */
    /* a fully faded scene comes OFF STAGE at the SCENE level. Hiding its parts only zeroes their
       presence: the vertices still run and the shadow pass still walks them, which is why loading
       the gravel bed cost 8 fps on the hero where it is not even on screen. */
    if (C) C.visible = m > 0;
    if (B) B.visible = m < 1;
    if (D) D.visible = m < 1;
  }
  if (stage !== V.stage){ V.stage = stage;
    for (const key of ['bike','drivetrain']){
      const H=R.scene?.(key); if (!H) continue;
      for (const n of H.scene.nodes){
        if (/^Stone_/.test(n.name)) n.hidden = stage!=='hero';
        /* GroundStrip is a flat gravel decal sized for a whole bike four metres away. Under the
           contact macro the camera sits a few hundred mm off it and it reads as pebble stickers on
           a bright floor · the very thing the owner called "not realistic". This chapter is a studio
           photograph of the wheel like every other chapter, so the strip comes off. */
        /* THE ROAD IS OFF EVERYWHERE (owner review 2026-09-05). It was appearing in the hero,
           geometry, drivetrain, drive, control and order and absent in contact and finish, so the
           bike stood on a gravel strip in some sections and on nothing in others as you scrolled ·
           the single most obvious inconsistency in the slow-scroll pass. The page's language is a
           paper studio backdrop with a contact shadow; the strip is the odd one out, not the
           sections that lack it. */
        if (n.name === 'GroundStrip') n.hidden = true;
      }
    }
    /* the lights follow the stage · auto binding gave every slot to the bike's own named lights, so
       contact.glb's rig was loaded and never used, and a macro of a 0.028 rubber was being lit by a
       studio spot aimed at a whole bike four metres away */
    R.light?.('sun',    'contact', null);
    R.light?.('head',   'contact', null);
    R.light?.('studio', 'contact', null);
  }

  /* blue hour is lit by the headlight and a cold fill, not by the sun · the fill follows the sun
     up so the studio state is the file's own. headScale makes a 400 W spot read on a dark ground. */
  if (false){ /* retired · see the note above 'camPair' */
    /* THE MACRO IS ITS OWN PHOTOGRAPH. It was being lit by the bike's studio spot, aimed at a whole
       bike four metres away, plus an ambient dome at 0.8 · a rubber whose base colour is 0.028 came
       out white. Its own spot sits 250 mm from the contact patch, so the key is small and the fill
       is nearly nothing, which is what puts black back in the rubber and shadow between the stones. */
    R.lights.headScale = MACRO.key;
    R.lights.studioScale = MACRO.studio;
    R.lights.sunScale = MACRO.sun;
    /* --sun drives the PAGE's paper-vs-blue-hour, and it is computed from the sun's intensity. Dim
       the macro's key and the whole page went grey with it. Scale what counts as daylight by the
       same factor and the macro can be lit freely without the copy changing colour. */
    R.lights.sunFull = MACRO.sun;          /* the renderer's baseline is 1, not the file's watts */
    R.set?.(MACRO.grade);
  } else {
    R.lights.headScale = 2.5;
    /* the workshop (E4) is a NIGHT place: the sun steps back and the pendant lamp is the key (owner
       2026-09-06: a realistic environment per section) · the bike chapters' own look elsewhere */
    const night = (ENV.cur === 'E4' && HERO.done) ? 1 : 0;
    R.lights.sunScale = lerp(1, 0.5, night);
    R.lights.sunFull = 1;
    const sunEff = Math.max(sunNow, filmSun);    /* the studio key IS the light that rises · and it is up from the flash */
    R.lights.studioScale = lerp(sunEff, 1.5, night);
    R.set?.({ambient: lerp(lerp(0.8, 1.0, sunEff), 0.62, night), spotRange: 4000, ...BIKE_GRADE});
    if (ENV.hazeSet > 0) R.set?.(ENV.hazeE === 'E4' ? { hazeAmt: ENV.hazeSet, hazeNear: 1800, hazeFar: 7000, hazeCol: [0.035, 0.040, 0.050] } : { hazeAmt: ENV.hazeSet, hazeNear: 3000, hazeFar: 52000, hazeCol: [1.55, 1.42, 1.22] });
  }
  /* the hero plays once on the wall clock, then hands the clock to the scrollbar */
  /* the visitor takes the clock: leaving the hero during the film ends it at its end state (Apple skips
     the intro on scroll) · otherwise every chapter layer waits dark until the 8 s are up */
  if (HERO.playing && scrollY > innerHeight*0.25) finishHero();
  if (HERO.playing){
    const T = (now - HERO.t0)/1000;                    /* seconds on the wall clock */
    /* the dark studio · before the flash the key is low and the dome is down, so the scattered
       parts read as specular edges in the dark (Apple: revealed by light), not a lit product */
    const dark = 1 - K.ease(clamp((T-3.3)/0.4,0,1));
    R.lights.studioScale = lerp(1, 1.2, dark);
    R.set?.({ambient: lerp(1.0, 0.9, dark), spotRange: 4000, ...BIKE_GRADE});   /* the file's sun is 0 before the flash · the dome carries the dark studio */
    if (ENV.hazeSet > 0) R.set?.({ hazeAmt: ENV.hazeSet * (1 - dark), hazeNear: 3000, hazeFar: 52000, hazeCol: [1.55, 1.42, 1.22] });
    heroFilm(T);                                        /* the shape, the wordmark, the flash, the assembly */
    /* the clip runs in REAL TIME from T 0.8 · every part's flight is keyed in Blender */
    const s = filmClipSec(T);
    R.setTime(N.hero, s);
    const run = CLIPS?.drivetrain?.run;
    if (run) R.setTime(N.drivetrain, (run[0] + ((now-HERO.t0)/1000*FPS()) % (run[1]-run[0])) / FPS());
    R.setPointerTime('lights', s);
    const shake = landingShake(T);
    cam('Cam_Hero', s, shake ? {drift: shake} : {});
    envFrame('top', 0, T);
    if (s >= sec('bike','arrive',1)) finishHero();
    /* the hero returns early on its wall clock · it still has to wear the configured colourway,
       or the page opens on a bone bike and turns orange at the first scroll */
    R.setPointerTime(MAT.paint, sec('bike','finish', [0.67, 0.83, 1][S.way]));
    R.frame(now); return;
  }

  heroPhysics(dt, c);                                            /* the pointer spring · identity outside the hero */
  envFrame(c.id, t, null);                                       /* the place this chapter stands in */

  /* the size: a time in the bike's `sizes` range (S=0, M=1/3, L=2/3, XL=1), keyed in Blender for
     every node the size moves (front axle, steerer, seatpost, saddle) AND the frame's shape-key
     weights, so one sampled time sets the mesh and the nodes together. Until that range lands the
     frame mesh alone morphs from the page. */
  const k = 1-Math.exp(-dt*6);
  const SIZE_T = {S:0, M:1/3, L:2/3, XL:1};
  if (c.id !== 'geometry'){ setSizePreview(null); drawDims(0); }
  sizeT = lerp(sizeT, SIZE_T[S.sizePreview ?? S.size] ?? 1/3, k);
  const hasSizes = !!CLIPS?.bike?.sizes;
  const restT = hasSizes ? sec('bike','sizes', sizeT) : 0;
  if (!hasSizes){
    for (const s of ['S','L','XL']) sizeW[s] = lerp(sizeW[s], S.size===s?1:0, k);
    R.setMorph('Frame', {Size_S:sizeW.S, Size_L:sizeW.L, Size_XL:sizeW.XL});
  }
  /* the tyre width chip · 40 mm is 5 mm narrower and 5 mm shorter than 45 */
  tyreNow = lerp(tyreNow, S.tyre, k);
  const rad = (311+tyreNow)/356, wid = tyreNow/45;
  R.scale(/^Tyre[FR]$/, [rad, rad, wid]);

  /* what this chapter wants driven · applyRanges eases every range in and out, so a chapter
     leaving the viewport unwinds instead of freezing mid-explode */
  /* the handover flag has to be raised BEFORE the switch writes this frame's camera · set after,
     the jump has already happened and the blend runs from the new pose to itself */
  const chapterChanged = c !== lastChapter; lastChapter = c;
  chapterJustChanged = chapterChanged;
  if (chapterChanged && ((lastId === 'contact' && c.id === 'drivetrain') || (lastId === 'drivetrain' && c.id === 'contact'))){
    WIPE.t0 = now; WIPE.on = true;
  }
  lastId = c.id;
  if (chapterChanged) camHandover = true;
  const want = {};
  switch (c.id){
    case 'top': {
      /* after the arrival: the pointer drifts the camera a few degrees, a wheel flick spins */
      /* the arrival's last frame IS the rest pose, so after the hero the sized rest is the same pose */
      R.setTime(N.hero, restT);
      cam('Cam_Hero', sec('bike','arrive',1), {drift: [S.pointer[0]*0.45, S.pointer[1]*0.45]});   /* the bike itself turns to the pointer (heroPhysics) · the camera only leans */
      break; }
    case 'geometry': {
      R.setTime(N.hero, restT);
      /* v3 · the hero's rest pose travels into the drawing over the first 30 % (it was a 900 ms blend · a cut at scroll speed) */
      camPair('Cam_Hero', sec('bike','arrive',1), 'Cam_Geometry', sec('bike','geometry',t), t/0.30, {shift: shiftBlend('top', c.id, t/0.30)});
      { const step = (!STATE.sizePinned && t > 0.18 && t < 0.80) ? ['S','M','L','XL'][Math.min(3, Math.floor((t-0.18)/0.155))] : null;
        setSizePreview(step); }
      drawDims(K.ease(clamp((t-0.16)/0.12,0,1)) * (1 - K.ease(clamp((t-0.90)/0.08,0,1))));
      break; }
    case 'contact': {
      R.setTime(N.hero, restT);
      /* the push ARRIVES at 0.85 and holds · two reasons. The copy block wants a still frame to be
         read against, and leaving a camera still moving at the section end makes the next chapter's
         handover start from speed: measured, contact→drivetrain was a 38.5% speed jump with the
         push running to t=1, against a gate that wants under 10%. */
      camPair('Cam_Geometry', sec('bike','geometry',1), 'Cam_Contact', 0, t/0.85, {shift: shiftFor(c.id)});
      spinNow = t * Math.PI * 1.6;   /* the front wheel rolls as the macro closes in · 0.8 turn across the chapter */
      break; }
    /* marker: drivetrain ghost is applied after the switch (see below) */
    case 'drivetrain': {
      want.dtrain = sec('drivetrain','shift',t);
      R.setTime(N.hero, restT);
      /* Cam_Drivetrain is keyed at rest, so entering used to hand over from contact's tyre macro to
         a static close-up in one 900 ms blend · on a 20-step boundary ladder that is a two-frame
         lurch from wide to tight (g-08→g-09). Same fix as contact: the camera TRAVELS from where
         the tyre macro left it to the cassette as the section scrolls, arriving at 0.55 and holding. */
      camPair('Cam_Contact', 0, 'Cam_Drivetrain', sec('bike','geometry',0), t/0.55, {shift: shiftFor(c.id)});
      break; }
    case 'drive': {
      /* v3 · 0–0.30 the camera travels from the cassette to the drive unit (the bike whole); 0.30–0.86 the
         motor explodes one part per beat; 0.86–1.0 it REASSEMBLES and the bike returns, so battery inherits
         a whole bike at the cut instead of the parts vanishing (boundary ladder, 2026-09-05) */
      const ta = t < 0.73 ? clamp((t-0.30)/0.42, 0, 1) : 1 - K.ease(clamp((t-0.74)/0.26, 0, 1));
      driveTa = ta;
      const s = sec('bike','drive',ta);
      want.drive = s;
      R.setTime(N.hero, restT);
      camPair('Cam_Drivetrain', sec('bike','geometry',0), 'Cam_Drive', s, t/0.30, {shift: shiftBlend('drivetrain', c.id, t/0.30), zoom: lerp(1, 1.22, K.ease(clamp(t/0.30,0,1)))});
      break; }
    case 'battery': {
      /* Owner review 2026-09-04: "it's just moving and showing". The chapter is now staged in four
         beats against a camera that tracks the pack, using effects the renderer already has and
         this section never used.
           0.00-0.30  the down tube goes to GLASS · you see the pack inside the frame before
                      anything opens, which is the only moment the sentence "they live inside the
                      down tube" is actually shown rather than asserted
           0.26-0.56  a WIREFRAME SWEEP crosses the bike as the pack breaks cover · lines ahead of
                      the front, material behind, so the machine reads as a drawing resolving into
                      an object exactly while the pack is in motion
           0.56-0.80  the pack rides up into the triangle, solid, camera close and tracking
           0.80-1.00  the lid opens on the cells and the readout counts them in
         The sweep runs on world X and the whole bike is 1.6 m of it, so it is deliberately short:
         a pass, not a state. */
      const tb = clamp(t/0.92, 0, 1);
      const s = sec('bike','battery',tb);
      want.battery = s;
      R.setTime(N.hero, restT);
      camPair('Cam_Drive', sec('bike','drive',0), 'Cam_Battery', s, t/0.30, {shift: shiftBlend('drive', c.id, t/0.30)});
      batGhost = lerp(batGhost, clamp((0.30 - tb) / 0.14, 0, 1), k);
      const sw = clamp((tb - 0.26) / 0.30, 0, 1);
      if (sw > 0 && sw < 1){
        /* the front travels the bike's own bounding X, back to front, once */
        R.set?.({ sweep: lerp(-900, 900, sw*sw*(3-2*sw)), wire: 0 });
      } else {
        R.set?.({ sweep: 99999, wire: 0 });
      }
      break; }
    case 'finish': {
      /* the scroll walks raw → coat → colour; a swatch pins the paint at its stop */
      const tf = clamp((t-0.36)/0.64, 0, 1);   /* v3 · the paint story runs after the travel (0–0.35) */
      const s = sec('bike','finish',tf);
      const pinned = sec('bike','finish', [0.67, 0.83, 1][S.way]);
      /* Boundary ladders (iteration 2) showed two one-frame colour cuts: entering, the bike went
         orange→raw grey BEFORE the camera had left the battery framing; leaving, ink→orange as
         control took over. Rule 6. So: the paint holds the configured colour until the macro camera
         has landed (t 0.12), then strips to raw over 0.12→0.22 · the "raw" reveal now happens on the
         tube that fills the frame, which is what the copy is about · and from 0.86 the scroll settles
         back onto the chosen swatch, so control inherits the same bike it hands back. A swatch click
         still pins immediately. */
      const settle = clamp((tf - 0.86) / 0.14, 0, 1);
      wayT = S.wayPinned ? lerp(wayT, 1, k) : lerp(wayT, settle, k);
      const strip = clamp(tf / 0.15, 0, 1);
      const live = tf < 0.15 ? lerp(pinned, s, strip) : s;
      R.setPointerTime(MAT.paint, lerp(live, pinned, wayT));
      camPair('Cam_Battery', sec('bike','battery',1), 'Cam_Finish', s, t/0.35, {shift: shiftBlend('battery', c.id, t/0.35)});
      break; }
    case 'control': {
      const tc = clamp((t-0.30)/0.70, 0, 1);
      brakeNow = lerp(brakeNow, S.press ? 1 : 0, 1-Math.exp(-dt*9));
      const s = sec('bike','control',tc);
      want.brakes = sec('bike','control', Math.max(tc, brakeNow));   /* press and hold: the pads close now */
      R.setTime(N.hero, restT);
      camPair('Cam_Finish', sec('bike','finish',1), 'Cam_Control', s, t/0.30, {shift: shiftBlend('finish', c.id, t/0.30), zoom: 0.74});
      break; }
    case 'order': {
      /* the closer breathes · a slow scroll-driven yaw across the section (owner review 2026-09-05 ·
         it was a single static frame). Apple's reveals end on a slow move, not a freeze; the drift
         is small (a few degrees) so the configurator stays readable and the swatches stay put. */
      R.setTime(N.hero, restT);
      orbitNow = [lerp(orbitNow[0], S.orbit?.[0] ?? 0, k), lerp(orbitNow[1], S.orbit?.[1] ?? 0, k)];
      /* THE CLOSER SHOWS THE WHOLE BIKE. It was framed with the copy's shift at full strength and a
         0.82 lens (tighter), which pushed the bike off the right edge and cropped it (owner 2026-09-07:
         "make sure that we see the bike in full where it is supposed to"). The shift is halved and the
         lens opened; the closer is the one shot that must hold the product complete. */
      const sh = shiftFor(c.id);
      cam('Cam_Configure', sec('bike','configure',0), {shift: [sh[0]*0.42, sh[1]*0.6], zoom: 1.18, drift:[(t-0.5)*0.35 + orbitNow[0]*10 + (S.pointer?.[0]||0)*0.4, -0.06 + orbitNow[1]*5]});
      break; }
  }
  /* drivetrain (script v2 · ladder): the frame, wheels and cockpit fade to a faint x-ray so the chain,
     cogs and crank are the only solid things in the frame · Dyson "technology inside" */
  { const B = R.scene?.('bike'); if (B){
      /* parts only for the WHOLE drivetrain chapter, and the bike returns in the first tenth of the drive
         chapter while its camera is already travelling out to the whole bike. Returning it inside the
         drivetrain chapter put a half-present, screen-door frame over the subject for its last 9 % · that
         is the "the drive unit seems to be transparent" the owner photographed (2026-09-06). */
      const inn = c.id === 'drivetrain' ? K.ease(clamp((t-0.34)/0.20,0,1))
                : c.id === 'drive'      ? 1 - K.ease(clamp(t/0.10,0,1))
                : 0;
      if (inn !== dtGhost){ dtGhost = inn;
        R.ghost(B, n => !N.drivetrain(n) && !N.driveUnit(n) && !N.rearWheel(n) && !/^Stone_/.test(n.name), 1 - inn); } } }
  /* the ground (three acts) · the ink act's cut hides under the contact→drivetrain wipe; the paper return rides the finish travel */
  { let g = GROUND[c.id] ?? 1; if (c.id === 'finish') g = K.ease(clamp(t/0.35, 0, 1));
    const wu = wipeU(now);
    /* under the curtain the act CUTS at the midpoint (nothing is on screen to see it change); everywhere
       else it eases as before */
    if (wu >= 0 && wu < 1) groundNow = wu < 0.5 ? groundNow : g;
    else groundNow = lerp(groundNow, g, 1-Math.exp(-dt*9));
    if (HERO.done) writeSun(); }
  document.documentElement.classList.toggle('blueprint', c.id === 'geometry');
  /* the front wheel's roll (contact) holds its angle elsewhere · a wheel is round, unwinding it would spin backwards */
  R.pose('WheelF', axisAngle([0,0,1], -spinNow));
  /* the exploded parts tumble as they separate (drive) · a slow roll about the motor axis, back to zero when assembled */
  { const on = c.id === 'drive'; for (let i = 0; i < DRIVE_BEATS.length; i++){ const b = DRIVE_BEATS[i]; const e = on ? K.ease(clamp((driveTa - b.from)/(b.to - b.from), 0, 1)) : 0; const ang = e * 0.55 * (i % 2 ? 1 : -1);
      if (Math.abs(ang - (tumbleSet[i] ?? 0)) > 0.002){ tumbleSet[i] = ang; const B = R.scene?.('bike'); if (B) for (const n of B.scene.nodes) if (b.parts.test(n.name)) R.pose(n.name, axisAngle([0,0,1], ang)); } } }
  applyRanges(want, restT, k);
  /* the cutaway rises with the case going to glass and falls the moment the chapter is left */
  /* the fade starts AFTER the handover has landed (t 0.10) and is quick (to 0.24): the boundary
     ladder showed the old 0.18–0.40 stipple arriving across the cut as a two-frame white flash */
  /* the parts-only ghost is released INSIDE battery (t 0→0.14), not at the cut · the boundary
     ladder showed the whole bike snapping back in one frame as drive ended */
  ghostNow = lerp(ghostNow, c.id==='drive' ? clamp((t-0.30)/0.14, 0, 1) * (1 - K.ease(clamp((t-0.78)/0.20, 0, 1))) : 0, k);
  applyDriveBeats(driveTa, c.id==='drive' && ghostNow > 0.5);
  if (c.id!=='drive' && ghostNow < 0.5) applyDriveBeats(0, false);
  /* the cutaway and the macro dissolve both write per-part presence · the cutaway must not
     re-solidify parts the dissolve is fading, so it stands down while a dissolve is running */
  if (m <= 0.001) applyGhost(ghostNow); else ghostApplied = -1;
  if (c.id !== 'battery' && batGhost > 0.001) batGhost = lerp(batGhost, 0, k);
  applyGhostBattery(c.id === 'battery' || batGhost > 0.001 ? batGhost : 0);
  { const tb = clamp(t/0.92, 0, 1); const target = c.id === 'battery' ? K.ease(clamp((tb-0.45)/0.15, 0, 1)) : c.id === 'finish' ? (1 - K.ease(clamp(t/0.25, 0, 1))) * (frontGhost > 0.01 || t < 0.25 ? 1 : 0) : 0;
    frontGhost = lerp(frontGhost, target, k);
    if (Math.abs(frontGhost - frontGhostSet) > 0.004){ frontGhostSet = frontGhost; const B = R.scene?.('bike'); if (B) R.ghost(B, n => FRONT_END.test(n.name), lerp(1, 0.12, frontGhost)); } }
  /* the hoses follow the steerer wherever the page is · the steer itself eases to zero outside
     the control chapter, so leaving it unwinds the bars instead of snapping them straight */
  steerNow = lerp(steerNow, c.id==='control' ? S.steer : 0, k);
  R.pose('Steer', axisAngle([0,1,0], steerNow*Math.PI/180));
  poseHoses(steerNow);
  /* a chapter change moves the camera a long way · a stiff spring covers that distance as a
     lurch, so soften it for the first second of a new chapter and stiffen again after */
  /* every chapter but the hero holds the lights at the studio state */
  if (c.id!=='top') R.setPointerTime('lights', sec('bike','arrive',1));
  /* ONE BIKE, ONE COLOUR, EVERYWHERE BUT THE PAINT CHAPTER (owner review 2026-09-05 · "are we
     using the same model everywhere?"). It was the same model in three different states: the Paint
     material's rest pose is bone, so hero→battery showed a white bike; finish walks raw→coat→colour
     and left the pointer wherever the scroll stopped, so control inherited an orange frame; order
     pinned the chosen swatch. The slow-scroll pass made it obvious · the frame changed colour twice
     on the way down the page for no reason the copy ever gave. Now every chapter except finish pins
     the pointer to the configured colourway (the stop order already used), and finish remains the
     one place the paint is allowed to move, because that is what finish is about. */
  if (c.id !== 'finish') R.setPointerTime(MAT.paint, sec('bike','finish', [0.67, 0.83, 1][S.way]));
  R.set?.({vatOn:false});
  if (c.id !== 'battery') R.set?.({ sweep: 99999, wire: 0 });
  /* the copy gate: dim the render under the chapter's copy block (Kestrel's post pass) */
  /* THE COPY GATE IS OFF (owner review 2026-09-05 · RESEARCH.md rule 5). The white blur under the
     copy was hiding a problem the page does not have: text-gate.mjs, with the gate disabled and
     every DOM layer hidden so only the render is sampled, measures 0.0% product under the copy in
     all seven sections at 1440x900 and 390x844 · the lens shift (shiftFor) already keeps the subject
     clear of the column. A blur over clear paper is just a blur. copyRect stays, for the shift. */
  R.gate(null);
  /* ── the type is driven by the same t as the camera (script v2) · one container per chapter is
     'live'; words assemble, numbers count, captions land in corners, ladders light one by one ── */
  document.querySelectorAll('.k').forEach(k => { const on = k.dataset.for === c.id && (c.id !== 'top' || HERO.done); if (k.classList.contains('live') !== on) k.classList.toggle('live', on); });
  const kk = document.querySelector('.k[data-for="'+c.id+'"]');
  if (kk && c.id !== 'top'){
    const H = kk.querySelector('.kt'), N1 = kk.querySelector('.num'), CP = [...kk.querySelectorAll('.cap')];
    switch (c.id){
      case 'geometry': {
        if (H) K.assemble(H, t, 0.04, 0.30, 0.94, 1.0);
        K.show(kk.querySelector('.k-dims'), t, 0.22, 0.94, 1.0);
        K.show(kk.querySelector('.k-sizes'), t, 0.52, 0.94, 1.0);
        CP.forEach(cp => K.show(cp, t, 0.34, 0.94, 1.0));
        break; }
      case 'contact': {
        if (N1) K.count(N1, t, 0.25, 0.60, 0.94, 1.0);
        if (H) K.assemble(H, t, 0.30, 0.62, 0.94, 1.0);
        CP.forEach(cp => K.show(cp, t, 0.62, 0.94, 1.0));
        break; }
      case 'drivetrain': {
        const cog = K.ladder(kk.querySelector('.k-ladder'), t, 0.58, 0.84);
        if (N1) K.count(N1, t, 0.58, 0.84, 0.84, 0.89);
        if (H) K.assemble(H, t, 0.56, 0.72, 0.84, 0.89);
        CP.forEach(cp => K.show(cp, t, 0.64, 0.84, 0.89));
        break; }
      case 'drive': {
        if (N1) K.count(N1, t, 0.62, 0.70, 0.72, 0.76);
        if (H) K.assemble(H, t, 0.40, 0.56, 0.72, 0.76);
        const L = kk.querySelectorAll('.leaders li'); const beats = [0.342,0.434,0.518,0.60,0.678];
        L.forEach((li,i)=>{ const on = t >= beats[i] && t < 0.74; if (li.classList.contains('on') !== on) li.classList.toggle('on', on); });
        CP.forEach(cp => K.show(cp, t, 0.56, 0.72, 0.76));
        break; }
      case 'battery': {
        if (N1) K.count(N1, t, 0.66, 0.88, 1.2, 1.3);
        if (H) K.assemble(H, t, 0.66, 0.88, 1.2, 1.3);
        CP.forEach(cp => K.show(cp, t, 0.40, 1.2, 1.3));
        break; }
      case 'finish': {
        const tf = clamp((t-0.36)/0.64, 0, 1);
        const st = tf < 0.33 ? 0 : tf < 0.66 ? 1 : 2;
        kk.querySelectorAll('.fw').forEach(w => { const on = tf > 0.03 && +w.dataset.stage === st; const op = on ? 1 : 0; if (w.dataset.op !== String(op)){ w.style.opacity = String(op); w.dataset.op = String(op); } });
        K.show(kk.querySelector('.k-swatches'), t, 0.72, 1.2, 1.3);
        CP.forEach(cp => K.show(cp, t, 0.42, 1.2, 1.3));
        break; }
      case 'control': {
        if (H) K.assemble(H, t, 0.34, 0.60, 0.94, 1.0);
        K.show(kk.querySelector('.k-readout'), t, 0.40, 0.94, 1.0);
        CP.forEach(cp => K.show(cp, t, 0.56, 0.94, 1.0));
        break; }
      case 'order': {
        if (H) K.assemble(H, t, 0.15, 0.35, 2, 3);
        K.show(kk.querySelector('.k-spec'), t, 0.36, 2, 3);
        K.show(kk.querySelector('.k-sizes'), t, 0.44, 2, 3);
        if (N1) K.count(N1, t, 0.46, 0.72, 2, 3);
        K.show(kk.querySelector('.k-cta'), t, 0.64, 2, 3);
        break; }
    }
  }
  /* the orange shape between sections · a bar wipes across on the fast cuts (Haibike #0014) and
     becomes the road in the closer (#0103–#0111) */
  if (HERO.done){
    const wu = wipeU(now);
    if (wu >= 0 && wu < 1)                   SHAPE.set(wu < 0.48 ? 'curtainIn>curtain' : 'curtain>curtainOff', wu < 0.48 ? wu/0.48 : (wu-0.48)/0.52, 1, 1);
    else if (c.id === 'control' && t > 0.90) SHAPE.set('barIn>bar', (t-0.90)/0.10, 1, 1);
    else if (c.id === 'order')              SHAPE.set('bar>road', K.ease(clamp(t/0.45,0,1)), 1, 0.92);
    else                                    { SHAPE.set('none', 1, 1, 0); if (wu >= 1) WIPE.on = false; }
  }
  R.frame(now);
}
/* ── geometry helpers (script v2 · blueprint) ── */
const DIM_IDS = [['dStack', 'stack', 0], ['dReach', 'reach', 0], ['dHta', 'hta', 1], ['dSta', 'sta', 1], ['dCs', 'cs', 0], ['dWb', 'wb', 0]];
let dimsShown = null;
function setSizePreview(step){
  if ((STATE.sizePreview ?? null) === step && dimsShown === (step ?? STATE.size)) return;
  STATE.sizePreview = step;
  const sz = step ?? STATE.size, g = STATE.geometry?.sizes?.[sz];
  if (g) for (const [id, key, dp] of DIM_IDS){ const el = document.getElementById(id); if (el && g[key] !== undefined) el.textContent = (+g[key]).toFixed(dp); }
  document.querySelectorAll('.k-sizes button').forEach(b => { const on = !!step && b.dataset.size === step; if (b.classList.contains('peek') !== on) b.classList.toggle('peek', on); });
  dimsShown = sz;
}
/* the dimension chain, drawn on #fx from the mesh itself: wheelbase between the hubs at the ground,
   stack up from the bottom bracket, reach across to the stem. Re-projected every frame, so it rides
   the camera and the size morph. */
let dimsAlpha = -1;
function drawDims(alpha){
  const fx = document.getElementById('dimfx'); if (!fx) return;
  if (alpha <= 0.001 && dimsAlpha <= 0.001){ dimsAlpha = alpha; return; }
  dimsAlpha = alpha;
  const dpr = Math.min(2, devicePixelRatio || 1), W = innerWidth, H = innerHeight;
  if (fx.width !== Math.round(W*dpr) || fx.height !== Math.round(H*dpr)){ fx.width = Math.round(W*dpr); fx.height = Math.round(H*dpr); fx.style.width = W+'px'; fx.style.height = H+'px'; }
  const g = fx.getContext('2d'); if (!g) return; g.setTransform(dpr,0,0,dpr,0,0); g.clearRect(0,0,W,H);
  if (alpha <= 0.001) return;
  const B = R.scene?.('bike'); if (!B) return;
  const N = name => B.scene.nodes.find(n => n.name === name), pos = n => [n.world[12], n.world[13], n.world[14]];
  const hf = N('HubF'), hr = N('HubR'); if (!(hf && hr)) return;
  const G = STATE.geometry?.sizes?.[STATE.sizePreview ?? STATE.size]; if (!G) return;
  const gy = (G.ground_z ?? -280) - 12, KEYS = Object.fromEntries(DIM_IDS.map(([id, key]) => [id, key]));
  const stack = +G[KEYS.dStack], reach = +G[KEYS.dReach], wb = G[KEYS.dWb];
  const P = p => R.project(p); const HF = pos(hf), HR = pos(hr);
  const a = P([HR[0], gy, HR[2]]), b = P([HF[0], gy, HF[2]]), c = P([0,0,0]), d = P([0, stack, 0]), e = P([reach, stack, 0]);
  if (!(a && b && c && d && e)) return;
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#1a1d1f';
  g.globalAlpha = alpha; g.strokeStyle = ink; g.fillStyle = ink; g.lineWidth = 1;
  g.font = '500 11px IBM Plex Mono, ui-monospace, monospace'; g.textBaseline = 'middle';
  const tick = (p, dx, dy) => { g.beginPath(); g.moveTo(p[0]-dx, p[1]-dy); g.lineTo(p[0]+dx, p[1]+dy); g.stroke(); };
  const line = (p, q) => { g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke(); };
  const label = (txt, x, y, align) => { g.textAlign = align; g.fillText(txt, x, y); };
  line(a, b); tick(a, 0, 7); tick(b, 0, 7); label('WHEELBASE ' + (wb ?? ''), (a[0]+b[0])/2, a[1] + 16, 'center');
  line(c, d); tick(c, 7, 0); tick(d, 7, 0); label('STACK ' + stack, d[0] + 10, d[1] + 26, 'left');   /* between the reach line and the top tube · the mid-line sits on the seat tube */
  line(d, e); tick(e, 0, 7); label('REACH ' + reach, (d[0]+e[0])/2, d[1] - 14, 'center');
  g.globalAlpha = 1;
}
function axisAngle(a, ang){ const s=Math.sin(ang/2); return [a[0]*s, a[1]*s, a[2]*s, Math.cos(ang/2)]; }
/* the lens shift: put the bike in the middle of whatever the copy leaves free.
   +fx moves the subject right in NDC. On a phone the copy spans the frame and
   the shift is zero; the fade under the copy carries legibility instead. */
/* every file camera was framed at 16:9. A portrait viewport keeps the vertical field of view and
   loses the sides, so the bike is cropped. Keep the authored HORIZONTAL field of view instead:
   widen yfov by the aspect ratio (capped, or a phone becomes a fisheye) and lift the subject so
   the copy below it stays clear. */
/* the lens shift · put the bike in the middle of whatever the copy leaves free. +fx moves the
   subject right in NDC. On a phone the copy spans the frame, so the shift is zero and the fade
   under the copy carries legibility instead. */
/* on a phone the card is at the bottom and the subject rides in the top half · two chapters sit
   lower than the rest (the pack in the down tube, the motor at the BB) and need a little more lift,
   measured: battery read 21% of the card with product under it at 0.42, drive 8% */
const PHONE_LIFT = { battery: 0.14, drive: 0.09 };
const SHIFT_CAP = { order: 0.25 }, SHIFT_Y = {}, SHIFT_MIN = { drive: 0.45 };   /* the exploded motor needs the whole right half */
/* the lens shift is part of the pose · across a boundary it travels with the camera, or the cut shows as a sidestep */
function shiftBlend(prevId, id, u){ const a = shiftFor(prevId), b = shiftFor(id), e = K.ease(clamp(u,0,1)); return [lerp(a[0], b[0], e), lerp(a[1], b[1], e)]; }   /* the crank sits left, the ladder + count own the right column */
function shiftFor(id){
  /* portrait: the copy spans the width, so the subject sits in the lower two thirds and the type above it */
  if (innerWidth/innerHeight < 0.8) return [0, -0.16];
  const r = copyRect(id); if (!r) return [0,0];
  const l = r[0], rt = r[2], w = rt - l;
  if (w > 0.7) return [0,0];
  const freeCentre = l > 0.5 ? l/2 : rt + (1-rt)/2;
  /* stronger shift · text-gate (render only, gate off) measured product under the copy in six of
     seven sections at the old ±0.4 cap. The column is now 40vw, so the free side is ≥ 58% of the
     frame and the subject can sit fully inside it. */
  const cap = SHIFT_CAP[id] ?? 0.55; let sx = clamp((freeCentre-0.5)*2*0.9, -cap, cap);
  if (SHIFT_MIN[id] && Math.abs(sx) < SHIFT_MIN[id]) sx = Math.sign(sx || 1) * SHIFT_MIN[id];
  return [sx, SHIFT_Y[id] ?? 0];
}
const AUTHORED = 16/9;
/* how long a chapter change takes · a fixed duration makes a short move sluggish and a long one a
   swoop, so it scales with the distance the camera has to cover: 700 ms next door, 1.8 s across
   the bike. */
const CAM_BLEND_MIN = 900, CAM_BLEND_MAX = 1800, CAM_BLEND_SPAN = 2500;
let camBlend = CAM_BLEND_MIN;
let CUR = null, camFrom = null, camT0 = 0, camV0 = [0,0,0], camPrev = null, camPrevT = 0;
const smooth = x => x*x*(3-2*x);
function quatFromMat(m){
  const t = m[0]+m[5]+m[10];
  if (t > 0){ const s0 = Math.sqrt(t+1)*2; return [(m[6]-m[9])/s0, (m[8]-m[2])/s0, (m[1]-m[4])/s0, 0.25*s0]; }
  if (m[0] > m[5] && m[0] > m[10]){ const s0 = Math.sqrt(1+m[0]-m[5]-m[10])*2;
    return [0.25*s0, (m[4]+m[1])/s0, (m[8]+m[2])/s0, (m[6]-m[9])/s0]; }
  if (m[5] > m[10]){ const s0 = Math.sqrt(1+m[5]-m[0]-m[10])*2;
    return [(m[4]+m[1])/s0, 0.25*s0, (m[9]+m[6])/s0, (m[8]-m[2])/s0]; }
  const s0 = Math.sqrt(1+m[10]-m[0]-m[5])*2;
  return [(m[8]+m[2])/s0, (m[9]+m[6])/s0, 0.25*s0, (m[1]-m[4])/s0];
}
function qnl(a, b, t){                  /* shortest-path nlerp · enough at these angles */
  let d = a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3], sg = d < 0 ? -1 : 1, o = [0,0,0,0], L = 0;
  for (let i=0;i<4;i++){ o[i] = a[i] + (b[i]*sg - a[i])*t; L += o[i]*o[i]; }
  L = Math.sqrt(L) || 1; return o.map(v=>v/L);
}
/* read a file camera's pose at a time WITHOUT handing it to the renderer, so the page can decide
   how to get there */
function camPose(name, seconds){
  for (const key of ['bike','contact','drivetrain']){
    const S = R.scene?.(key); if (!S) continue;
    const sc = S.scene;
    const cm = sc.cameras.find(c => c.name===name || sc.nodes[c.node]?.name===name);
    if (!cm) continue;
    sc.sampleAll(T => (T===cm || (T.kind==='node' && T.i===cm.node)) ? seconds : null);
    sc.updateWorld();
    const v = sc.cameraView(name); if (!v) continue;
    return { pos:[v.world[12], v.world[13], v.world[14]], q:quatFromMat(v.world),
             yfov:v.yfov, znear:v.znear, zfar:v.zfar };
  }
  return null;
}
/* ── the camera hands over, it does not chase ─────────────────────────────────────
   A spring aimed at a target that changes the instant a chapter flips is fastest in its first
   frames, which is exactly the lurch. Measured before the change: every one of the eight
   boundaries moved the camera up to 5.8% of the whole path and rotated it up to 7.7° in a single
   55 ms step. Now the page blends from the pose it is ALREADY at to the incoming camera on a
   smoothstep over 900 ms · zero derivative at both ends, so it starts and lands without a kick,
   and the incoming camera may keep moving underneath the blend. The renderer's own spring is
   bypassed (snap) because two smoothers in series is what made it feel loose.

   Every file camera was framed at 16:9. A portrait viewport keeps the vertical field of view and
   loses the sides, so the authored HORIZONTAL field is kept instead and the subject lifted above
   the copy. */
/* ── one continuous move between two authored cameras ──────────────────────────────
   The contact chapter used to be a different MODEL with a different lighting rig, cross-dissolved
   in · which is what read as "it fades and a tyre appears". It is now the bike's own wheel, so the
   only thing that has to happen at the boundary is a camera move, and this does it as one push:
   it starts on the pose Cam_Geometry ENDS at (the exact frame the viewer was just looking at) and
   travels to Cam_Contact's macro as the section scrolls. Same model, same lights, same grade, no
   dissolve · the subject never leaves the screen. Blending the POSE rather than swapping cameras
   also means the existing handover spring never fires here, because the target moves continuously
   instead of jumping at the chapter flip. */
function camPair(a, aSec, b, bSec, u, opts={}){
  const A = camPose(a, aSec), B = camPose(b, bSec);
  if (!A || !B){ cam(B ? b : a, B ? bSec : aSec, opts); return; }
  const e = clamp(u,0,1)*clamp(u,0,1)*(3-2*clamp(u,0,1));
  cam(b, bSec, {...opts, pose:{
    pos:[lerp(A.pos[0],B.pos[0],e), lerp(A.pos[1],B.pos[1],e), lerp(A.pos[2],B.pos[2],e)],
    q: qnl(A.q, B.q, e), yfov: lerp(A.yfov, B.yfov, e), znear: B.znear, zfar: B.zfar }});
}
function cam(name, seconds, opts={}){
  const pose = opts.pose || camPose(name, seconds); if (!pose) return;
  const aspect = innerWidth/Math.max(1, innerHeight);
  let yfov = pose.yfov, pos = pose.pos.slice(), q = pose.q.slice();
  let fx = opts.shift ? opts.shift[0] : 0, fy = opts.shift ? opts.shift[1] : 0;
  if (aspect < AUTHORED - 0.01){
    yfov = 2*Math.atan(Math.tan(yfov/2) * Math.min(AUTHORED/aspect, 2.4));
    fy += (0.42 + (PHONE_LIFT[STATE.chapter?.id] || 0)) * clamp((1.2 - aspect)/0.7, 0, 1);   /* phone: card below, subject in the top half */
  }
  /* the hero's pointer drift · a few degrees about the bike, applied to the pose itself so it
     blends like everything else */
  if (opts.drift){
    const pivot = [300, 380, 0];
    const yaw = -(opts.drift[0]||0) * 3 * Math.PI/180, pit = -(opts.drift[1]||0) * 2 * Math.PI/180;
    const d = [pos[0]-pivot[0], pos[1]-pivot[1], pos[2]-pivot[2]];
    const right = [1-2*(q[1]*q[1]+q[2]*q[2]), 2*(q[0]*q[1]+q[2]*q[3]), 2*(q[0]*q[2]-q[1]*q[3])];
    let r = vrot(d, [0,1,0], yaw); r = vrot(r, nrm(right), pit);
    pos = [pivot[0]+r[0], pivot[1]+r[1], pivot[2]+r[2]];
    const qy = axisAngle([0,1,0], yaw), qr = axisAngle(nrm(right), pit);
    q = qmul(qr, qmul(qy, q));
  }
  if (opts.zoom) yfov = 2*Math.atan(Math.tan(yfov/2) * opts.zoom);   /* a lens, not a dolly · control and the closer framed tighter (v3) */
  const target = { pos, q, yfov, fx, fy, znear:pose.znear, zfar:pose.zfar };
  const now = performance.now();
  if (CUR === null){ CUR = target; camFrom = null; }
  if (camHandover){
    camFrom = { pos:CUR.pos.slice(), q:CUR.q.slice(), yfov:CUR.yfov, fx:CUR.fx, fy:CUR.fy };
    /* carry the speed the camera already had · an ease that starts from rest makes a moving
       camera stall and then swoop, which measured as a 51% speed discontinuity at finish→control */
    camV0 = (camPrev && now - camPrevT > 0.5)
      ? [ (CUR.pos[0]-camPrev[0])/(now-camPrevT), (CUR.pos[1]-camPrev[1])/(now-camPrevT), (CUR.pos[2]-camPrev[2])/(now-camPrevT) ]
      : [0,0,0];
    camT0 = now; camHandover = false;
    const d = Math.hypot(target.pos[0]-CUR.pos[0], target.pos[1]-CUR.pos[1], target.pos[2]-CUR.pos[2]);
    camBlend = CAM_BLEND_MIN + clamp(d/CAM_BLEND_SPAN, 0, 1) * (CAM_BLEND_MAX - CAM_BLEND_MIN);
    /* a fast camera arriving at a SHORT hop carries a tangent longer than the hop itself, and the
       curve then overshoots and comes back · that read as a 40% speed jump at finish→control.
       Cap the carried speed at the distance to be covered. */
    const v = Math.hypot(camV0[0], camV0[1], camV0[2]) * camBlend;
    if (v > d && v > 0){ const k2 = d/v; camV0 = [camV0[0]*k2, camV0[1]*k2, camV0[2]*k2]; }
  }
  const w = camFrom ? smooth(clamp((now - camT0)/camBlend, 0, 1)) : 1;
  /* Hermite on position: starts at the pose AND the speed the camera already had, lands at rest
     on the incoming camera. h10 carries the incoming velocity into the curve. */
  const h00 = 2*w*w*w - 3*w*w + 1, h10 = w*w*w - 2*w*w + w, h01 = -2*w*w*w + 3*w*w;
  CUR = w >= 1 ? target : {
    pos: [ h00*camFrom.pos[0] + h10*camV0[0]*camBlend + h01*target.pos[0],
           h00*camFrom.pos[1] + h10*camV0[1]*camBlend + h01*target.pos[1],
           h00*camFrom.pos[2] + h10*camV0[2]*camBlend + h01*target.pos[2] ],
    q: qnl(camFrom.q, target.q, w),
    yfov: lerp(camFrom.yfov, target.yfov, w),
    fx: lerp(camFrom.fx, target.fx, w), fy: lerp(camFrom.fy, target.fy, w),
    znear: target.znear, zfar: target.zfar,
  };
  if (w >= 1) camFrom = null;
  camPrev = CUR.pos.slice(); camPrevT = now;
  R.cam.target({ pos:CUR.pos, q:CUR.q, yfov:CUR.yfov, fx:CUR.fx, fy:CUR.fy, znear:CUR.znear, zfar:CUR.zfar }, true);
}
function qmul(a, b){
  return [ a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],
           a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
           a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],
           a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2] ];
}
function copyRect(id){
  /* script v2: the type is a kinetic headline in a fixed container, not a column · the shift keeps
     the subject clear of wherever THAT lands */
  const el = document.querySelector('.k[data-for="'+id+'"] .kt');
  if (!el) return null; const r = el.getBoundingClientRect();
  if (r.width < 4) return null;
  return [r.left/innerWidth, r.top/innerHeight, r.right/innerWidth, r.bottom/innerHeight];
}

/* ── boot ──────────────────────────────────────────────────────────────── */
async function bootScene(urls){
  CLIPS = await (await fetch(urls.CLIPS_URL)).json();
  VAT   = urls.VAT_JSON_URL ? await (await fetch(urls.VAT_JSON_URL)).json() : null;
  R = await createRenderer(document.getElementById('cv'), {
    sunFull: 3,
    onSun: v => { if (Math.abs(v-sunNow)>0.002){ sunNow=v; writeSun(); } },
  });
  await R.load('bike', urls.BIKE_URL);
  await R.load('drivetrain', urls.DRIVE_URL);
  /* the environments (env.glb · model/env/CONTRACT.md) · optional: the page is a page without them */
  if (urls.ENV_URL){
    try { await R.load('env', urls.ENV_URL, {env:true});
          try { ENVC = urls.ENV_CLIPS_URL ? await (await fetch(urls.ENV_CLIPS_URL)).json() : null; } catch(e){ console.warn('env clips unavailable:', e.message||e); ENVC = null; }
          envInit(); }
    catch(e){ console.warn('env.glb unavailable, the page keeps its paper ground:', e.message||e); }
  }
  /* theme 0 = the light environment: the page is paper, and at blue hour it is the only
     term that lets a dark bike read against a dark ground */
  R.set?.({groundY: STATE.geometry?.sizes?.M?.ground_z ?? -280, theme: 0});
  /* the chain and cogs are steel in the file and read grey on grey against the twill stays ·
     a per-part tint at load makes them the dark steel of a real drivetrain, no re-export */
  { const D = R.scene?.('drivetrain'); if (D) for (const n of D.scene.nodes) if (/^(Chain_|Cog_|Jockey)/.test(n.name)) R.tint(D, n.name, [0.05,0.05,0.06], 1.0); }
  window.MORAINE_R = R;
  /* the hose gate drives these directly: set a steer angle, solve, then read bone worlds */
  window.MORAINE_HOSE = { pose: poseHoses, rig: HOSE };
  window.MORAINE_STATE = STATE;
  window.MORAINE_MACRO = MACRO;      /* the macro grade, live-tunable while shooting */
  /* contact.glb is NOT loaded any more. The contact chapter is the bike's own wheel, so the macro
     model, its lighting rig, its gravel bed and the tyre VAT are all dead weight · 2.5 MB and
     42,544 triangles that used to sit on stage behind the studio backdrop. */
  /* the pointer for the hero drift */
  STATE.pointer = [0,0];
  let ptLast = null;
  addEventListener('pointermove', e=>{
    const now = performance.now(), p = [(e.clientX/innerWidth-0.5)*2, (e.clientY/innerHeight-0.5)*2];
    if (ptLast && HERO.done && STATE.chapter?.id === 'top'){
      const dtm = Math.max(8, now - ptLast.t)/1000;
      const dx = p[0]-ptLast.p[0], dy = p[1]-ptLast.p[1];
      const vx = clamp(dx/dtm, -6, 6), vy = clamp(dy/dtm, -6, 6);          /* viewport widths per second */
      /* the flick: an impulse proportional to the DISPLACEMENT, gated by speed · a slow sweep adds
         almost nothing (the spring follows the pointer anyway), a fast one throws the bike */
      const fast = clamp((Math.abs(vx) - 1.2)/2.5, 0, 1);
      HP.yawV  += dx*3.2*fast;
      HP.pitchV += dy*1.2*fast;
      HP.vx = vx; HP.vt = now;                                              /* the wheels track this while it is fresh */
    }
    ptLast = {t:now, p}; STATE.pointer = p;
  }, {passive:true});
  /* the drivetrain rides the bike. It is a separate GLB, so nothing in bike.glb's arrive clip
     ever moved it · see _engine.js parentWorld. Bike updates first (load order), so BikeRoot's world
     is current when the drivetrain walks. */
  { const B = R.scene?.('bike'), D = R.scene?.('drivetrain'); const root = B?.scene?.byName?.get('BikeRoot');
    if (D && root) D.scene.parentWorld = root.world; }
  /* a swatch pins the paint; the next scroll in the finish chapter releases it */
  document.getElementById('swatches')?.addEventListener('click', ()=>{ STATE.wayPinned = true; });
  addEventListener('scroll', ()=>{ if (STATE.chapter.id==='finish') STATE.wayPinned = false; }, {passive:true});
  let last = performance.now();
  const loop = now => { const dt = Math.min(0.05, (now-last)/1000); last = now; frame(now, dt); requestAnimationFrame(loop); };
  startHero();
  requestAnimationFrame(loop);
}

/* boot order: the page first (it works without a GPU), then the scene if the
   renderer is present in this build and the browser has WebGPU */
(async ()=>{
  const hasGPU = !!navigator.gpu && typeof bootScene === 'function';
  if (!hasGPU){ document.documentElement.classList.add('nogpu'); document.documentElement.classList.remove('filmDark');   /* the film opens dark (hero v3) · no film without a GPU */ const im=document.getElementById('fallbackImg'); if (im && typeof FALLBACK_URL!=='undefined' && FALLBACK_URL) im.src = FALLBACK_URL; }
  await bootSite(GEOM_URL);
  if (hasGPU){
    try { await bootScene({BIKE_URL, DRIVE_URL, VAT_JSON_URL, CLIPS_URL, ENV_URL: typeof ENV_URL!=='undefined' ? ENV_URL : null, ENV_CLIPS_URL: typeof ENV_CLIPS_URL!=='undefined' ? ENV_CLIPS_URL : null}); }
    catch(e){ console.warn('3D unavailable, page continues without it:', e.message||e); document.documentElement.classList.add('nogpu'); document.documentElement.classList.remove('filmDark'); document.documentElement.style.setProperty('--sun','1'); heroArrived(); }
  }
  document.getElementById('loading').classList.add('off');
})();

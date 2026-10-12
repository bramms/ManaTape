/* Mana Tape · screens and device controls.
   One screen material: black emissive glass (OLED) in both themes. Each screen has its own HUE (0–359°, OKLCH,
   maximum in-gamut chroma) on a chassis encoder; one global BRIGHTNESS knob drives every screen.
   Legibility is computed, never left to the knobs: ink ≥ 7:1, accent / dim / ok / warn / bad ≥ 4.5:1 on the
   brightest point of the glass for every hue × brightness. Status colours (ok / warn / bad) never follow the hue.
   Pure maths is exported for Node tests; the browser part paints [data-screen] elements
   (never :root), runs the knob / encoder / analog-toggle controllers and persists to localStorage 'mana-display'. */
const ManaScreen=(()=>{
 'use strict';
 const KEY='mana-display',VERSION=2,DEFAULT_BRIGHTNESS=60,DEFAULT_HUE=150;
 const STATUS_HUE={ok:150,warn:82,bad:27};
 const THRESHOLD={ink:7,acc:4.5,dim:4.5,ok:4.5,warn:4.5,bad:4.5};
 const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
 const isObj=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
 const setOwn=(o,k,v)=>{Object.defineProperty(o,k,{value:v,enumerable:true,writable:true,configurable:true});return o;};
 const validId=id=>typeof id==='string'&&id.length>0&&id.length<=200;
 const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

 /* ---------- values ---------- */
 function wrapHue(h,fallback=DEFAULT_HUE){const n=Number(h);if(!Number.isFinite(n))return fallback;return ((Math.round(n)%360)+360)%360;}
 function clampBrightness(v,fallback=DEFAULT_BRIGHTNESS){const n=Number(v);if(!Number.isFinite(n))return fallback;return Math.max(0,Math.min(100,Math.round(n)));}

 /* ---------- OKLCH → sRGB with gamut mapping (chroma is reduced, lightness and hue are kept) ---------- */
 function okToLinear(L,a,b){
  const l_=L+.3963377774*a+.2158037573*b,m_=L-.1055613458*a-.0638541728*b,s_=L-.0894841775*a-1.291485548*b;
  const l=l_*l_*l_,m=m_*m_*m_,s=s_*s_*s_;
  return [4.0767416621*l-3.3077115913*m+.2309699292*s,-1.2684380046*l+2.6097574011*m-.3413193965*s,-.0041960863*l-.7034186147*m+1.707612701*s];
 }
 const inGamut=c=>c[0]>=-1e-6&&c[0]<=1+1e-6&&c[1]>=-1e-6&&c[1]<=1+1e-6&&c[2]>=-1e-6&&c[2]<=1+1e-6;
 const encode=v=>v<=.0031308?12.92*v:1.055*Math.pow(v,1/2.4)-.055;
 const decode=v=>v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4);
 function colour(rgb){return {rgb,lin:rgb.map(v=>decode(v/255))};}
 function oklch(L,C,h){
  L=Math.max(0,Math.min(1,L));const r=h*Math.PI/180,ca=Math.cos(r),sa=Math.sin(r);
  let c=okToLinear(L,C*ca,C*sa);
  if(!inGamut(c)){let lo=0,hi=C;for(let i=0;i<24;i++){const mid=(lo+hi)/2;inGamut(okToLinear(L,mid*ca,mid*sa))?lo=mid:hi=mid;}c=okToLinear(L,lo*ca,lo*sa);}
  return colour(c.map(v=>Math.round(encode(Math.min(1,Math.max(0,v)))*255)));
 }
 function toOklch(rgb){
  const [r,g,b]=rgb.map(v=>decode(v/255));
  const l=Math.cbrt(.4122214708*r+.5363325363*g+.0514459929*b),m=Math.cbrt(.2119034982*r+.6806995451*g+.1073969566*b),s=Math.cbrt(.0883024619*r+.2817188376*g+.6299787005*b);
  const L=.2104542553*l+.793617785*m-.0040720468*s,A=1.9779984951*l-2.428592205*m+.4505937099*s,B=.0259040371*l+.7827717662*m-.808675766*s;
  return {L,C:Math.hypot(A,B),h:((Math.atan2(B,A)*180/Math.PI)+360)%360};
 }
 const lum=c=>{const x=Array.isArray(c)?colour(c).lin:c.lin;return .2126*x[0]+.7152*x[1]+.0722*x[2];};
 function contrast(a,b){const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
 const css=c=>`rgb(${c.rgb.join(' ')})`;

 /* ---------- palette ---------- */
 /* raise L in OKLCH (chroma survives, unlike mixing with white) until the contrast with the glass is met */
 function need(L,C,h,min,glass){let x=null;for(let L2=L;L2<=1.0001;L2+=.01){x=oklch(Math.min(1,L2),C,h);if(contrast(x,glass)>=min)return x;}const white=oklch(1,0,h);return contrast(white,glass)>=min?white:x;}
 const glassHi=(h,b)=>oklch(.20+.05*b,.045,h);
 /* status colours are computed against the LIGHTEST glass of all hues, so they are identical for every hue */
 const worstCache=new Map();
 function worstGlass(b){const k=Math.round(b*1000);let w=worstCache.get(k);if(w)return w;for(let h=0;h<360;h++){const g=glassHi(h,b);if(!w||lum(g)>lum(w))w=g;}worstCache.set(k,w);return w;}
 const paletteCache=new Map();
 /* palette(hue 0–359, brightness 0–100) → colours as {rgb:[r,g,b], lin:[…]} + glow / spill factors */
 function palette(hue,brightness){
  const h=wrapHue(hue),br=clampBrightness(brightness),key=h*1000+br;
  const hit=paletteCache.get(key);if(hit)return hit;
  const b=br/100,bg=oklch(.115+.02*b,.018,h),hi=glassHi(h,b),worst=worstGlass(b);
  const p={hue:h,brightness:br,bg,hi,
   ink:need(.93+.05*b,.035,h,THRESHOLD.ink,hi),
   acc:need(.70+.13*b,.21,h,THRESHOLD.acc,hi),
   dim:need(.70+.09*b,.055,h,THRESHOLD.dim,hi),
   ok:need(.80+.07*b,.19,STATUS_HUE.ok,THRESHOLD.ok,worst),
   warn:need(.83+.06*b,.16,STATUS_HUE.warn,THRESHOLD.warn,worst),
   bad:need(.70+.08*b,.20,STATUS_HUE.bad,THRESHOLD.bad,worst),
   cap0:oklch(.42,.14,h),cap1:oklch(.66,.19,h),cap2:oklch(.86,.10,h),
   glow:+(.22+.4*b).toFixed(3),spill:+(.45+.75*b).toFixed(3)};
  if(paletteCache.size>720)paletteCache.clear();
  paletteCache.set(key,p);return p;
 }
 /* CSS custom properties for one screen element (written on that element, never on :root) */
 const VARS=['bg','hi','ink','acc','dim','ok','warn','bad'];
 function screenVars(p){
  const v={};for(const k of VARS){v['--s-'+k]=css(p[k]);v['--s-'+k+'-c']=p[k].rgb.join(' ');}
  v['--s-glow']=String(p.glow);v['--s-spill']=String(p.spill);return v;
 }
 const capVars=p=>({'--cap0':css(p.cap0),'--cap1':css(p.cap1),'--cap2':css(p.cap2)});
 /* a tone this close to a status hue makes that status read as ordinary accent: the CSS then adds a pattern */
 const hueGap=(a,b)=>{const d=Math.abs(wrapHue(a)-wrapHue(b))%360;return Math.min(d,360-d);};
 function nearStatus(hue){return hueGap(hue,STATUS_HUE.bad)<30?'bad':hueGap(hue,STATUS_HUE.warn)<25?'warn':'';}

 /* ---------- persistence + migration ---------- */
 /* v2: {v:2, brightness:0–100, screens:{[id]:{hue:0–359}}}
    v1 (the former display.js, kept so stored settings migrate): {light:{background,colour}, dark:{background,colour}, screens:{[id]: number | 'amber'… | {background,foreground}}} */
 const LEGACY_NAMES={green:130,amber:42,blue:218,cyan:183,violet:276,neutral:130};
 const LEGACY_BASE=[194,205,190];                 /* display.js light background at ФОН 55, i.e. what knob 130 showed */
 const LEGACY_DEFAULT={light:55,dark:25};          /* display.js ФОН defaults per theme */
 function legacyShift(rgb,angle){                  /* display.js shiftHue(), kept verbatim for a faithful migration */
  if(!angle)return rgb;
  const [r,g,b]=rgb.map(v=>v/255),max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min,l=(max+min)/2;
  if(!d)return rgb;
  const h=(((max===r?(g-b)/d:max===g?(b-r)/d+2:(r-g)/d+4)*60+angle)%360+360)%360;
  const s=d/(1-Math.abs(2*l-1)),c=(1-Math.abs(2*l-1))*s,x=c*(1-Math.abs(h/60%2-1)),m=l-c/2;
  return [[c,x,0],[x,c,0],[0,c,x],[0,x,c],[x,0,c],[c,0,x]][Math.floor(h/60)].map(v=>Math.round((v+m)*255));
 }
 /* old ТЛО value (0–359, offset −22° from real hue, HSL) → the OKLCH hue the user actually saw */
 function legacyHue(value){
  const n=typeof value==='string'&&own(LEGACY_NAMES,value)?LEGACY_NAMES[value]:value;
  if(typeof n!=='number'||!Number.isFinite(n))return null;
  const v=Math.max(0,Math.min(359,Math.round(n)));
  return wrapHue(toOklch(legacyShift(LEGACY_BASE,v-130)).h);
 }
 /* old ФОН (backlight 0–100, per theme) → one global brightness; the theme default lands on the new default */
 function legacyBrightness(background,theme){
  const n=Number(background);if(!Number.isFinite(n))return DEFAULT_BRIGHTNESS;
  const v=Math.max(0,Math.min(100,n)),d=LEGACY_DEFAULT[theme==='dark'?'dark':'light'];
  return clampBrightness(v<=d?20+40*v/d:60+40*(v-d)/(100-d));
 }
 const defaults=()=>({v:VERSION,brightness:DEFAULT_BRIGHTNESS,screens:{}});
 function normalise(src){
  const out=defaults();if(!isObj(src))return out;
  out.brightness=clampBrightness(src.brightness);
  if(isObj(src.screens))for(const id of Object.keys(src.screens)){const s=src.screens[id];if(validId(id)&&isObj(s)&&Number.isFinite(Number(s.hue))&&s.hue!==null&&s.hue!=='')setOwn(out.screens,id,{hue:wrapHue(s.hue)});}
  return out;
 }
 /* accepts the raw localStorage string or a parsed object; theme picks which old ФОН becomes the brightness */
 function migrate(raw,theme='light'){
  let src=raw;
  if(typeof raw==='string'){try{src=JSON.parse(raw);}catch{return defaults();}}
  if(!isObj(src))return defaults();
  if(src.v===VERSION)return normalise(src);
  const out=defaults(),first=theme==='dark'?'dark':'light';
  for(const t of [first,first==='dark'?'light':'dark'])if(isObj(src[t])&&Number.isFinite(src[t].background)){out.brightness=legacyBrightness(src[t].background,t);break;}
  if(isObj(src.screens))for(const id of Object.keys(src.screens)){
   if(!validId(id))continue;
   const s=src.screens[id],hue=legacyHue(isObj(s)?s.background:s);   /* foreground (ЗНАКИ) and colour (КОЛІР) are dropped */
   if(hue!==null)setOwn(out.screens,id,{hue});
  }
  return out;
 }

 /* ---------- markup helpers (escaped; the app renders with innerHTML) ---------- */
 function ticks(n,from,span,major=[]){
  let s='';for(let i=0;i<n;i++){const a=(from+span*i/(n-1||1))*Math.PI/180,mj=major.includes(i),r2=mj?40:42;
   s+=`<line${mj?' class="major"':''} x1="${(50+46*Math.sin(a)).toFixed(2)}" y1="${(50-46*Math.cos(a)).toFixed(2)}" x2="${(50+r2*Math.sin(a)).toFixed(2)}" y2="${(50-r2*Math.cos(a)).toFixed(2)}"/>`;}
  return `<svg class="knob__ticks" viewBox="0 0 100 100" aria-hidden="true">${s}</svg>`;
 }
 const KNOB_PARTS='<span class="knob__base"></span><span class="knob__rot"></span><span class="knob__shade"></span><span class="knob__face"></span><span class="knob__ptr"></span><span class="knob__spec"></span>';
 const BRIGHT_TICKS=ticks(11,-135,270,[0,5,10]),HUE_TICKS=ticks(24,0,345,[0,6,12,18]);
 const brightnessAngle=v=>-135+270*v/100;
 function brightnessKnobHTML({value=DEFAULT_BRIGHTNESS,label='Яскравість екранів'}={}){
  const v=clampBrightness(value);
  return `<button class="knob" type="button" role="slider" data-knob="brightness" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v}" aria-valuetext="${v}%" aria-orientation="vertical" style="--rot:${brightnessAngle(v)}deg" title="${esc(label)} · тягни вгору/вниз, колесо, стрілки · подвійний клік — типово">${BRIGHT_TICKS}${KNOB_PARTS}</button>`;
 }
 function hueEncoderHTML(id,{value,label='',def=DEFAULT_HUE}={}){
  if(!validId(id))return '';
  const d=wrapHue(def),v=wrapHue(value,d),p=palette(v,DEFAULT_BRIGHTNESS),c=capVars(p),name=label?`Тон екрана · ${label}`:'Тон екрана';
  return `<button class="knob enc" type="button" role="slider" data-knob="hue" data-screen-hue="${esc(id)}" data-screen-default="${d}" aria-label="${esc(name)}" aria-valuemin="0" aria-valuemax="359" aria-valuenow="${v}" aria-valuetext="${v}°" aria-orientation="vertical" style="--rot:${v}deg;--cap0:${c['--cap0']};--cap1:${c['--cap1']};--cap2:${c['--cap2']}" title="${esc(name)} · тягни, колесо, стрілки (Shift — 10°), Home/End · подвійний клік — типово">${HUE_TICKS}${KNOB_PARTS}</button>`;
 }
 const hueText=v=>String(wrapHue(v)).padStart(3,'0')+'°';

 const pure={KEY,VERSION,DEFAULT_BRIGHTNESS,DEFAULT_HUE,STATUS_HUE,THRESHOLD,
  oklch,toOklch,contrast,palette,screenVars,capVars,nearStatus,wrapHue,clampBrightness,
  migrate,normalise,legacyHue,legacyBrightness,brightnessKnobHTML,hueEncoderHTML,hueText};
 if(typeof document==='undefined')return pure;

 /* =================== browser =================== */
 const root=document.documentElement;
 const reduced=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
 const raf=typeof requestAnimationFrame==='function'?requestAnimationFrame:f=>setTimeout(f,16);
 const caf=typeof cancelAnimationFrame==='function'?cancelAnimationFrame:clearTimeout;
 function themeHint(){if(root.dataset&&root.dataset.theme)return root.dataset.theme;try{return localStorage.getItem('forge-theme')||'light';}catch{return 'light';}}
 function readStore(){let raw=null;try{raw=localStorage.getItem(KEY);}catch{}return migrate(raw,themeHint());}
 /* migration is lazy: the v2 record is written on the first real change, so an old build still finds its data until then */
 let state=readStore(),saveTimer=0;
 function persist(){clearTimeout(saveTimer);saveTimer=0;try{localStorage.setItem(KEY,JSON.stringify(state));}catch{}}
 function persistSoon(){clearTimeout(saveTimer);saveTimer=setTimeout(persist,350);}
 const angles=new Map();   /* encoder angle accumulates, so 359 → 0 turns forward, never spins back */
 function hueOf(id,def){return own(state.screens,id)?state.screens[id].hue:wrapHue(def);}
 function screensById(id){return [...document.querySelectorAll('[data-screen]')].filter(el=>el.dataset.screen===id);}
 /* the glass window holds the colours: the chin (encoder ticks, LEDs, switches) never reads them, so a turn of a
    knob restyles only what glows, not the 24 tick lines of every encoder */
 const glassOf=el=>el.querySelector?.(':scope>.screen__win')||el;
 function paint(el){
  const id=el.dataset.screen;if(!validId(id))return;
  const win=glassOf(el),h=hueOf(id,el.dataset.screenDefault),k=h+'|'+state.brightness;
  if(win.__manaScreen===k)return;win.__manaScreen=k;
  const v=screenVars(palette(h,state.brightness));for(const n in v)win.style.setProperty(n,v[n]);
  const near=nearStatus(h);if((el.dataset.near||'')!==near){if(near)el.dataset.near=near;else delete el.dataset.near;}
 }
 function renderHue(k){
  const id=k.dataset.screenHue,h=hueOf(id,k.dataset.screenDefault);
  let a=angles.get(id);if(a===undefined||((a%360)+360)%360!==h){a=a===undefined?h:a+(((h-a)%360+540)%360-180);angles.set(id,a);}
  k.style.setProperty('--rot',a+'deg');
  if(k.__manaHue!==h){k.__manaHue=h;const c=capVars(palette(h,DEFAULT_BRIGHTNESS));for(const n in c)k.style.setProperty(n,c[n]);
   k.setAttribute('aria-valuenow',h);k.setAttribute('aria-valuetext',h+'°');}
  for(const o of document.querySelectorAll('[data-screen-hue-out]'))if(o.dataset.screenHueOut===id)o.textContent=hueText(h);
 }
 function renderBrightness(k){
  const v=state.brightness;k.style.setProperty('--rot',brightnessAngle(v)+'deg');k.setAttribute('aria-valuenow',v);k.setAttribute('aria-valuetext',v+'%');
  for(const o of document.querySelectorAll('[data-screen-brightness-out]'))o.textContent=String(v);
 }
 function renderKnob(k){if(k.dataset.knob==='hue')renderHue(k);else if(k.dataset.knob==='brightness')renderBrightness(k);}
 /* call after every render that may have created screens or knobs */
 function sync(scope=document){
  for(const el of scope.querySelectorAll('[data-screen]'))paint(el);
  for(const k of scope.querySelectorAll('[data-knob]')){renderKnob(k);armWheel(k);}
 }
 const value=k=>k.dataset.knob==='hue'?hueOf(k.dataset.screenHue,k.dataset.screenDefault):state.brightness;
 function setValue(k,v){
  if(k.dataset.knob==='hue'){
   const id=k.dataset.screenHue;if(!validId(id))return false;
   const h=wrapHue(v);if(h===hueOf(id,k.dataset.screenDefault)&&own(state.screens,id))return false;
   const next={...state.screens};setOwn(next,id,{hue:h});state={...state,screens:next};
   for(const el of screensById(id))paint(el);
   for(const e of document.querySelectorAll('[data-knob="hue"]'))if(e.dataset.screenHue===id)renderHue(e);
  }else{
   const b=clampBrightness(v);if(b===state.brightness)return false;
   state={...state,brightness:b};
   if(g&&g.k.dataset.knob==='brightness'){if(!turnRaf)turnRaf=raf(turnStep);}
   else for(const el of document.querySelectorAll('[data-screen]'))paint(el);
   for(const e of document.querySelectorAll('[data-knob="brightness"]'))renderBrightness(e);
  }
  return true;
 }
 /* While the brightness knob turns by hand, the screens follow in turns: each frame repaints the half of them that
    waited longest, so a frame restyles about half the glass and the knob itself never waits (final QA perf). The
    gesture's end paints every screen at once with the final value. */
 let turnRaf=0,turnClock=0;
 function turnStep(){
  turnRaf=0;turnClock++;
  const all=[...document.querySelectorAll('[data-screen]')],stale=[];
  for(const el of all){const win=glassOf(el),h=hueOf(el.dataset.screen,el.dataset.screenDefault);if(win.__manaScreen!==h+'|'+state.brightness)stale.push([win.__manaTurn||0,el]);}
  stale.sort((a,b)=>a[0]-b[0]);const n=Math.max(2,Math.ceil(all.length/2));
  for(const [,el] of stale.slice(0,n)){paint(el);glassOf(el).__manaTurn=turnClock;}
  if(stale.length>n)turnRaf=raf(turnStep);
 }
 function defaultOf(k){return k.dataset.knob==='hue'?wrapHue(k.dataset.screenDefault):DEFAULT_BRIGHTNESS;}

 /* ---------- knob / encoder controller (delegated: survives innerHTML re-renders) ----------
    drag vertically (Shift = fine) · wheel · ↑/→ +1 ↓/← −1 (Shift ×10) · PageUp/PageDown ±10 · Home/End ·
    Esc cancels the gesture · double-click = default · pointercancel / lost capture / window blur cancel.
    Pointer moves only store the target; one write per animation frame. */
 let g=null;
 function endGesture(cancel){
  if(!g)return;const x=g;g=null;caf(x.raf);caf(turnRaf);turnRaf=0;
  if(cancel)setValue(x.k,x.v0);else if(x.next!==null)setValue(x.k,x.next);
  for(const el of document.querySelectorAll('[data-screen]'))paint(el);   /* screens still waiting for their turn */
  x.k.classList.remove('is-turning');delete root.dataset.displayTuning;
  try{if(x.k.hasPointerCapture(x.id))x.k.releasePointerCapture(x.id);}catch{}
  if(!cancel&&value(x.k)!==x.v0)persist();
 }
 /* a knob taken by the hand gets the focus (arrows keep working) but no ring: the ring is for the keyboard.
    data-pointer marks that focus; the next key on the knob or a blur clears it. */
 document.addEventListener('pointerdown',e=>{
  const k=e.target.closest&&e.target.closest('[data-knob]');if(!k||g||e.button!==0)return;
  e.preventDefault();k.dataset.pointer='';k.focus({preventScroll:true,focusVisible:false});
  try{k.setPointerCapture(e.pointerId);}catch{}
  g={k,id:e.pointerId,y0:e.clientY,v0:value(k),next:null,raf:0};k.classList.add('is-turning');
  root.dataset.displayTuning='true';   /* app.js interactionBusy(): no background re-render under the hand */
 });
 document.addEventListener('pointermove',e=>{
  if(!g||e.pointerId!==g.id)return;
  const dy=g.y0-e.clientY,sens=(g.k.dataset.knob==='hue'?1.5:.6)*(e.shiftKey?.25:1);
  g.next=g.v0+dy*sens;
  if(!g.raf)g.raf=raf(()=>{if(!g)return;g.raf=0;if(g.next!==null)setValue(g.k,g.next);});
 });
 document.addEventListener('pointerup',e=>{if(g&&e.pointerId===g.id)endGesture(false);});
 for(const type of ['pointercancel','lostpointercapture'])document.addEventListener(type,e=>{if(g&&e.pointerId===g.id)endGesture(true);});
 addEventListener('blur',()=>endGesture(true));
 document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&g){e.preventDefault();e.stopPropagation();endGesture(true);return;}
  const k=e.target.closest&&e.target.closest('[data-knob]');if(!k)return;
  if(e.key!=='Shift')delete k.dataset.pointer;
  const hue=k.dataset.knob==='hue',v=value(k),step=e.shiftKey?10:1;let n=null;
  if(e.key==='ArrowUp'||e.key==='ArrowRight')n=v+step;else if(e.key==='ArrowDown'||e.key==='ArrowLeft')n=v-step;
  else if(e.key==='PageUp')n=v+10;else if(e.key==='PageDown')n=v-10;
  else if(e.key==='Home')n=0;else if(e.key==='End')n=hue?359:100;
  if(n===null)return;
  e.preventDefault();if(setValue(k,n))persistSoon();
 },true);
 document.addEventListener('focusout',e=>{const k=e.target.closest&&e.target.closest('[data-knob]');if(k)delete k.dataset.pointer;});
 /* wheel: a non-passive listener on the knobs themselves, never on document, so scrolling the page stays on the
    compositor. sync() arms every knob after a render; pointerover is the backstop for a knob it has not seen. */
 let wheel=null;
 function onWheel(e){
  const k=e.currentTarget;
  e.preventDefault();
  const d=Math.sign(-e.deltaY||e.deltaX)*(e.shiftKey?10:(k.dataset.knob==='hue'?3:2));if(!d)return;
  if(!wheel||wheel.k!==k)wheel={k,v:value(k),raf:0};
  wheel.v+=d;
  if(!wheel.raf)wheel.raf=raf(()=>{const w=wheel;if(!w)return;w.raf=0;if(setValue(w.k,w.v))persistSoon();w.v=value(w.k);});
 }
 function armWheel(k){if(k.__manaWheel)return;k.__manaWheel=true;k.addEventListener('wheel',onWheel,{passive:false});}
 document.addEventListener('pointerover',e=>{const k=e.target.closest&&e.target.closest('[data-knob]');if(k)armWheel(k);},{passive:true});
 document.addEventListener('dblclick',e=>{const k=e.target.closest&&e.target.closest('[data-knob]');if(k&&setValue(k,defaultOf(k)))persist();});
 addEventListener('storage',e=>{if(e.key!==KEY)return;endGesture(true);state=readStore();for(const el of document.querySelectorAll('[data-screen]'))glassOf(el).__manaScreen=null;sync();});

 /* ---------- analog toggle (.tgl, role=switch) ----------
    click / Space / Enter flip it; ↑ = on, ↓ = off; a vertical flick of 8px flips it too.
    The lever animates first; 'mana:toggle' {checked, contact:Promise, settled:Promise} fires at once. contact resolves
    when the lever strikes its stop (≈ 80% of the 210 ms throw, only the overshoot is left), settled when it rests,
    so a theme switch can start its cross-fade at the strike, never with a half-flipped lever in the snapshot.
    The two directions are different keyframes, so a reverse flip restarts the throw without a forced reflow. */
 const STRIKE=170;
 function toggle(el,on){
  const want=String(!!on);
  if(!el||el.getAttribute('aria-checked')===want)return Object.assign(Promise.resolve(false),{contact:Promise.resolve(false)});
  el.setAttribute('aria-checked',want);
  if(reduced()){el.classList.remove('is-flip');return Object.assign(Promise.resolve(true),{contact:Promise.resolve(true)});}
  clearTimeout(el.__manaFlip);el.removeEventListener('animationend',el.__manaFlipEnd||(()=>{}));
  el.classList.add('is-flip');
  const contact=new Promise(res=>setTimeout(()=>res(true),STRIKE));
  const settled=new Promise(res=>{
   const done=()=>{clearTimeout(el.__manaFlip);el.removeEventListener('animationend',end);el.classList.remove('is-flip');res(true);};
   const end=ev=>{if(ev.target.classList&&ev.target.classList.contains('tgl__tip'))done();};
   el.__manaFlipEnd=end;el.addEventListener('animationend',end);el.__manaFlip=setTimeout(done,320);
  });
  return Object.assign(settled,{contact});
 }
 function flip(el,on){const settled=toggle(el,on);el.dispatchEvent(new CustomEvent('mana:toggle',{bubbles:true,detail:{checked:!!on,settled,contact:settled.contact}}));return settled;}
 let tg=null,swallowClick=null;
 document.addEventListener('pointerdown',e=>{const t=e.target.closest&&e.target.closest('.tgl');if(!t||e.button!==0||t.disabled)return;tg={t,id:e.pointerId,y:e.clientY,moved:false};try{t.setPointerCapture(e.pointerId);}catch{}});
 document.addEventListener('pointermove',e=>{if(!tg||e.pointerId!==tg.id)return;const dy=e.clientY-tg.y;if(Math.abs(dy)>=8){tg.moved=true;tg.y=e.clientY;const on=dy<0;if(tg.t.getAttribute('aria-checked')!==String(on))flip(tg.t,on);}});
 for(const type of ['pointerup','pointercancel','lostpointercapture'])document.addEventListener(type,e=>{if(tg&&e.pointerId===tg.id){if(tg.moved)swallowClick=tg.t;tg=null;}});
 document.addEventListener('click',e=>{
  const t=e.target.closest&&e.target.closest('.tgl');if(!t||t.disabled)return;
  if(swallowClick===t){swallowClick=null;e.stopPropagation();e.preventDefault();return;}   /* the flick already flipped it */
  flip(t,t.getAttribute('aria-checked')!=='true');
 },true);
 document.addEventListener('keydown',e=>{const t=e.target.closest&&e.target.closest('.tgl');if(!t||(e.key!=='ArrowUp'&&e.key!=='ArrowDown'))return;e.preventDefault();const on=e.key==='ArrowUp';if(t.getAttribute('aria-checked')!==String(on))flip(t,on);});

 /* ---------- power-on of the glass (light switch, first paint) ----------
    No forced reflow: a screen still warming up gets the other twin of each boot keyframe (.is-boot-b flips), and a
    changed animation-name restarts the animation at the next style update. Theme switches call this inside the
    View Transition update, so the warm-up costs no style or layout pass of its own. */
 let bootParity=false,bootOff=0,bootFill=0;
 function boot(scope=document){
  if(reduced())return;
  const screens=[...scope.querySelectorAll('.screen')],meters=[...scope.querySelectorAll('.meter:not(.is-unknown)')];
  bootParity=!bootParity;clearTimeout(bootOff);clearTimeout(bootFill);
  screens.forEach((s,i)=>{s.style.setProperty('--i',i);s.classList.toggle('is-boot-b',bootParity);s.classList.add('is-booting');});
  for(const m of meters)m.classList.add('is-zero');
  bootFill=setTimeout(()=>{for(const m of meters)m.classList.remove('is-zero');},260);
  bootOff=setTimeout(()=>{for(const s of screens)s.classList.remove('is-booting','is-boot-b');},1100+4*120+100);   /* the longest animation + the capped stagger */
 }

 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>sync());else sync();
 return {...pure,sync,boot,toggle,flip,
  get:()=>JSON.parse(JSON.stringify(state)),
  hue:(id,def)=>hueOf(id,def),
  setHue(id,h){const k={dataset:{knob:'hue',screenHue:id}};if(setValue(k,h))persist();},
  setBrightness(v){if(setValue({dataset:{knob:'brightness'}},v))persist();}};
})();
/* a top-level const is not a property of window: theme.js and the app's error screen call window.ManaScreen */
if(typeof window!=='undefined')window.ManaScreen=ManaScreen;
if(typeof module!=='undefined')module.exports=ManaScreen;

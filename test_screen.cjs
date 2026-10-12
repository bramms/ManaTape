const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const S=require('./static/screen.js');
const {palette,contrast,migrate,normalise,legacyHue,legacyBrightness,oklch,toOklch,wrapHue,clampBrightness}=S;

const HUES=Array.from({length:360},(_,i)=>i);
const LEVELS=[0,20,40,60,80,100];

test('every hue × brightness keeps ink ≥ 7:1 and accent / dim / status ≥ 4.5:1 on the brightest glass',()=>{
 const worst={ink:99,acc:99,dim:99,ok:99,warn:99,bad:99};
 for(const b of LEVELS)for(const h of HUES){
  const p=palette(h,b);
  for(const k of Object.keys(worst)){
   const c=contrast(p[k],p.hi);worst[k]=Math.min(worst[k],c);
   assert.ok(c>=S.THRESHOLD[k],`${k} h${h} b${b}: ${c.toFixed(2)}`);
   assert.ok(contrast(p[k],p.bg)>=c,`${k} must read even better on the darker glass`);
  }
 }
 assert.ok(worst.ink>=7&&worst.acc>=4.5&&worst.dim>=4.5,JSON.stringify(worst));
});

test('status colours never follow the screen hue',()=>{
 for(const b of LEVELS){
  const ref=palette(0,b);
  for(const h of HUES){const p=palette(h,b);for(const k of ['ok','warn','bad'])assert.deepEqual(p[k].rgb,ref[k].rgb,`${k} moved with hue ${h} at ${b}`);}
  /* and they keep their meaning: green / amber / red */
  const hue=k=>toOklch(ref[k].rgb).h;
  assert.ok(Math.abs(hue('ok')-S.STATUS_HUE.ok)<12,`ok hue ${hue('ok')}`);
  assert.ok(Math.abs(hue('warn')-S.STATUS_HUE.warn)<12,`warn hue ${hue('warn')}`);
  assert.ok(Math.abs(hue('bad')-S.STATUS_HUE.bad)<12,`bad hue ${hue('bad')}`);
 }
});

test('glass is black, accents are vivid and actually carry the chosen hue',()=>{
 for(const b of LEVELS)for(const h of HUES){
  const p=palette(h,b),bg=toOklch(p.bg.rgb),acc=toOklch(p.acc.rgb);
  assert.ok(bg.L<.16,`glass too light h${h} b${b}: ${bg.L}`);
  assert.ok(acc.C>=.06,`accent too grey h${h} b${b}: C ${acc.C.toFixed(3)}`);
  const d=Math.abs(((acc.h-h)%360+540)%360-180);
  assert.ok(d<=12,`accent hue drifted h${h} b${b}: ${acc.h.toFixed(1)}`);
 }
});

test('brightness raises the glass and the glow monotonically, and the encoder cap shows the hue',()=>{
 for(const h of [0,90,150,250,330]){
  let prev=null;
  for(const b of LEVELS){const p=palette(h,b);if(prev){assert.ok(toOklch(p.hi.rgb).L>=toOklch(prev.hi.rgb).L);assert.ok(p.glow>prev.glow);assert.ok(p.spill>prev.spill);}prev=p;}
  const cap=toOklch(palette(h,60).cap1.rgb);assert.ok(Math.abs(((cap.h-h)%360+540)%360-180)<=10,`cap hue ${cap.h} for ${h}`);
 }
});

test('values are clamped, wrapped and defaulted',()=>{
 assert.equal(wrapHue(-10),350);assert.equal(wrapHue(370),10);assert.equal(wrapHue(359.6),0);assert.equal(wrapHue('x'),S.DEFAULT_HUE);
 assert.equal(clampBrightness(-5),0);assert.equal(clampBrightness(140),100);assert.equal(clampBrightness(NaN),S.DEFAULT_BRIGHTNESS);
 assert.deepEqual(palette(-10,140).ink.rgb,palette(350,100).ink.rgb);
 assert.deepEqual(palette(720,'nope').acc.rgb,palette(0,S.DEFAULT_BRIGHTNESS).acc.rgb);
 /* gamut mapping never clips channels: an out-of-gamut request keeps lightness and hue */
 const o=oklch(.7,.4,140),back=toOklch(o.rgb);
 assert.ok(o.rgb.every(v=>v>=0&&v<=255));assert.ok(Math.abs(back.L-.7)<.01);assert.ok(Math.abs(back.h-140)<3);
 const vars=S.screenVars(palette(250,60));
 for(const k of ['bg','hi','ink','acc','dim','ok','warn','bad']){assert.match(vars['--s-'+k],/^rgb\(\d+ \d+ \d+\)$/);assert.match(vars['--s-'+k+'-c'],/^\d+ \d+ \d+$/);}
});

test('migration from display.js: hue ← old background, brightness ← old ФОН, colour / foreground dropped',()=>{
 for(const bad of [null,undefined,42,true,'amber','{broken',[],'[]'])assert.deepEqual(migrate(bad),{v:2,brightness:60,screens:{}});
 /* the old per-theme default lands on the new default; ends map to 20 and 100 */
 assert.equal(migrate({light:{background:55,colour:55}}).brightness,60);
 assert.equal(migrate({dark:{background:25,colour:60}},'dark').brightness,60);
 assert.equal(migrate({light:{background:0}}).brightness,20);
 assert.equal(migrate({light:{background:100}}).brightness,100);
 assert.equal(legacyBrightness(80,'light'),82);assert.equal(legacyBrightness(10,'dark'),36);
 /* the current theme's ФОН wins, the other theme is a fallback */
 assert.equal(migrate({light:{background:100},dark:{background:0}},'dark').brightness,20);
 assert.equal(migrate({dark:{background:25}},'light').brightness,60);
 /* screens: number, legacy name, {background,foreground}; foreground-only and invalid ids are dropped */
 const old={light:{background:55,colour:70},screens:{history:42,'quota:a:b':'cyan',analysis:{background:75,foreground:291},tariff:{foreground:10},'':12,[`x`.repeat(201)]:50,big:900,neg:-5,word:'nope'}};
 const m=migrate(JSON.stringify(old));
 assert.deepEqual(Object.keys(m.screens).sort(),['analysis','big','history','neg','quota:a:b']);
 assert.equal(m.screens.history.hue,legacyHue(42));
 assert.equal(m.screens['quota:a:b'].hue,legacyHue(183));
 assert.equal(m.screens.analysis.hue,legacyHue(75));
 assert.equal(m.screens.big.hue,legacyHue(359));assert.equal(m.screens.neg.hue,legacyHue(0));
 assert.ok(!JSON.stringify(m).includes('foreground')&&!JSON.stringify(m).includes('colour')&&!('light' in m));
 /* the old knob was offset from real hue: 130 meant the default grey-green, so it migrates to that green, not to 130 blindly */
 const g=legacyHue(130);assert.equal(g,wrapHue(toOklch([194,205,190]).h));assert.ok(g>=110&&g<=160,`old default became ${g}`);
 assert.notEqual(legacyHue(0),legacyHue(180));
 assert.equal(legacyHue('constructor'),null);assert.equal(legacyHue(null),null);
});

test('migration is idempotent and the v2 record normalises itself',()=>{
 const inputs=[{light:{background:30,colour:10},screens:{a:1,b:'violet',c:{background:200,foreground:5}}},{dark:{background:90}},{v:2,brightness:33,screens:{x:{hue:400},y:{hue:-20},z:{hue:'NaN'},w:{nope:1}}},{v:2},null];
 for(const raw of inputs){
  const once=migrate(raw),twice=migrate(once),viaString=migrate(JSON.stringify(once));
  assert.deepEqual(twice,once);assert.deepEqual(viaString,once);assert.equal(once.v,2);
 }
 assert.deepEqual(normalise({v:2,brightness:33,screens:{x:{hue:400},y:{hue:-20},z:{hue:'NaN'},w:{nope:1}},junk:1}),{v:2,brightness:33,screens:{x:{hue:40},y:{hue:340}}});
 /* prototype keys stay plain data */
 const p=migrate(JSON.parse('{"screens":{"__proto__":12,"constructor":20}}'));
 assert.equal(Object.getPrototypeOf(p.screens),Object.prototype);
 assert.ok(Object.hasOwn(p.screens,'__proto__')&&Object.hasOwn(p.screens,'constructor'));
 assert.equal({}.hue,undefined);
});

test('markup helpers escape and expose slider semantics',()=>{
 const enc=S.hueEncoderHTML('quota:"<&\'',{label:'A "<&\'',value:-10,def:250});
 assert.match(enc,/data-screen-hue="quota:&quot;&lt;&amp;&#39;"/);
 assert.match(enc,/aria-label="Тон екрана · A &quot;&lt;&amp;&#39;"/);
 assert.match(enc,/role="slider"/);assert.match(enc,/aria-valuemin="0" aria-valuemax="359" aria-valuenow="350"/);
 assert.match(enc,/data-screen-default="250"/);assert.match(enc,/--cap1:rgb\(/);
 assert.equal(S.hueEncoderHTML('',{}),'');
 const b=S.brightnessKnobHTML({value:140});
 assert.match(b,/data-knob="brightness"/);assert.match(b,/aria-valuenow="100" aria-valuetext="100%"/);
 assert.equal(S.hueText(7),'007°');assert.equal(S.hueText(250),'250°');
});

/* ---------- browser part in a fake DOM: per-screen writes, ≤1 write per frame, Esc cancels, lazy migration ---------- */
function fakeDom(stored){
 const listeners={},frames=[],saved=[];
 const mkStyle=()=>({props:{},writes:0,setProperty(k,v){this.props[k]=v;this.writes++;}});
 const el=(dataset,cls=[])=>({dataset,style:mkStyle(),attrs:{},classes:new Set(cls),textContent:'',own:{},
  addEventListener(t,f,o){(this.own[t]??=[]).push({f,o});},
  classList:{add(...c){for(const x of c)this._e.classes.add(x);},remove(...c){for(const x of c)this._e.classes.delete(x);},contains(c){return this._e.classes.has(c);},
   toggle(c,force){const on=force===undefined?!this._e.classes.has(c):!!force;if(on)this._e.classes.add(c);else this._e.classes.delete(c);return on;}},
  setAttribute(k,v){this.attrs[k]=String(v);},getAttribute(k){return this.attrs[k]??null;},
  closest(sel){return sel==='[data-knob]'&&this.dataset.knob?this:null;},focus(){},setPointerCapture(){},hasPointerCapture(){return true;},releasePointerCapture(){}});
 const fix=e=>{e.classList._e=e;return e;};
 const screenA=fix(el({screen:'studio',screenDefault:'250'},['screen'])),screenB=fix(el({screen:'cloud',screenDefault:'150'},['screen']));
 const encA=fix(el({knob:'hue',screenHue:'studio',screenDefault:'250'})),bright=fix(el({knob:'brightness'}));
 const outA=fix(el({screenHueOut:'studio'})),outB=fix(el({screenBrightnessOut:''}));
 const all={'[data-screen]':[screenA,screenB],'[data-knob]':[encA,bright],'[data-knob="hue"]':[encA],'[data-knob="brightness"]':[bright],'[data-screen-hue-out]':[outA],'[data-screen-brightness-out]':[outB],'.screen':[screenA,screenB],'.meter:not(.is-unknown)':[]};
 const reads={offsetWidth:0};
 const rootEl={dataset:{theme:'dark'},style:mkStyle(),get offsetWidth(){reads.offsetWidth++;return 0;}};
 const document={documentElement:rootEl,readyState:'complete',addEventListener(t,f){(listeners[t]??=[]).push(f);},querySelectorAll(s){return all[s]||[];}};
 const ctx={window:{},document,module:{exports:{}},localStorage:{getItem(k){return k==='mana-display'?stored:null;},setItem(k,v){saved.push([k,JSON.parse(v)]);}},
  requestAnimationFrame(f){frames.push(f);return frames.length;},cancelAnimationFrame(){},setTimeout:(f)=>{return 0;},clearTimeout(){},
  addEventListener(t,f){(listeners['win:'+t]??=[]).push(f);},matchMedia:()=>({matches:false}),CustomEvent:class{constructor(t,o){this.type=t;this.detail=o?.detail;}},console};
 vm.runInNewContext(fs.readFileSync(require.resolve('./static/screen.js'),'utf8'),ctx);
 const fire=(t,ev)=>{for(const f of listeners[t]||[])f({preventDefault(){},stopPropagation(){},button:0,pointerId:1,shiftKey:false,...ev});};
 const flush=()=>{const fs=frames.splice(0);for(const f of fs)f(0);return fs.length;};
 return {api:ctx.module.exports,ctx,listeners,reads,screenA,screenB,encA,bright,outA,outB,rootEl,fire,flush,saved,frames};
}

test('browser: paints each screen element (not :root), lazily migrates, gestures write once per frame, Esc cancels',()=>{
 const old=JSON.stringify({dark:{background:25,colour:60},light:{background:80,colour:55},screens:{studio:{background:42,foreground:200}}});
 const d=fakeDom(old);
 /* initial sync: per-screen vars only, nothing on the root, nothing written to storage yet */
 assert.equal(d.rootEl.style.writes,0);
 assert.ok(d.screenA.style.props['--s-ink']&&d.screenB.style.props['--s-acc']);
 assert.equal(d.saved.length,0,'migration must not overwrite the old record before a real change');
 assert.equal(d.api.get().brightness,60,'dark theme hint → old dark ФОН 25 → 60');
 assert.equal(d.api.hue('studio'),legacyHue(42));assert.equal(d.api.hue('cloud','150'),150);
 assert.equal(d.outA.textContent,S.hueText(legacyHue(42)));assert.equal(d.outB.textContent,'60');
 /* a drag: many moves, one frame → exactly one palette write per screen */
 const before=d.screenA.style.writes,beforeB=d.screenB.style.writes;
 d.fire('pointerdown',{target:d.encA,clientY:300});
 for(let i=1;i<=12;i++)d.fire('pointermove',{target:d.encA,clientY:300-i*3});
 assert.equal(d.frames.length,1,'moves are coalesced into one animation frame');
 assert.equal(d.screenA.style.writes,before,'nothing is written before the frame');
 d.flush();
 const perFrame=d.screenA.style.writes-before;
 assert.equal(perFrame,18,'one full set of 18 vars on the touched screen');
 assert.equal(d.screenB.style.writes,beforeB,'the other screen is not touched by this encoder');
 const moved=d.api.hue('studio');assert.notEqual(moved,legacyHue(42));
 /* Esc cancels: back to the start value, nothing saved */
 d.fire('keydown',{key:'Escape',target:d.encA});
 assert.equal(d.api.hue('studio'),legacyHue(42));assert.equal(d.saved.length,0);
 assert.ok(!d.encA.classes.has('is-turning'));
 /* keyboard: Shift+↑ = +10°, saved in v2 format (debounced write is flushed by the next commit) */
 d.fire('keydown',{key:'ArrowUp',shiftKey:true,target:d.encA});
 assert.equal(d.api.hue('studio'),wrapHue(legacyHue(42)+10));
 /* brightness drag commit writes the v2 record once, without colour / foreground */
 d.fire('pointerdown',{target:d.bright,clientY:200});d.fire('pointermove',{target:d.bright,clientY:150});d.flush();d.fire('pointerup',{target:d.bright});
 assert.equal(d.api.get().brightness,90);
 const last=d.saved.at(-1);assert.equal(last[0],'mana-display');
 assert.deepEqual(last[1],{v:2,brightness:90,screens:{studio:{hue:wrapHue(legacyHue(42)+10)}}});
 /* pointercancel restores, double-click resets to the screen default */
 d.fire('pointerdown',{target:d.bright,clientY:200});d.fire('pointermove',{target:d.bright,clientY:260});d.flush();
 d.fire('pointercancel',{target:d.bright});assert.equal(d.api.get().brightness,90);
 d.fire('dblclick',{target:d.encA});assert.equal(d.api.hue('studio'),250);
 assert.equal(d.rootEl.style.writes,0,'never writes custom properties on :root');
});

test('browser: window.ManaScreen, wheel only on knobs, focus by hand without a ring, warm-up without a reflow',()=>{
 const d=fakeDom(null);
 assert.equal(d.ctx.window.ManaScreen,d.api,'theme.js and the error screen call window.ManaScreen');
 /* the page never gets a non-passive wheel listener; every knob does, after sync() */
 assert.equal((d.listeners.wheel||[]).length,0,'no wheel listener on document');
 for(const k of [d.encA,d.bright]){const w=k.own.wheel||[];assert.equal(w.length,1);assert.equal(w[0].o.passive,false);}
 d.api.sync();assert.equal(d.encA.own.wheel.length,1,'a knob is armed once');
 /* wheel: several notches, one write per frame */
 const h0=d.api.hue('studio','250'),w0=d.screenA.style.writes,wheel=d.encA.own.wheel[0].f;
 for(let i=0;i<4;i++)wheel({currentTarget:d.encA,target:d.encA,deltaY:-100,deltaX:0,shiftKey:false,preventDefault(){}});
 assert.equal(d.frames.length,1);d.flush();
 assert.equal(d.api.hue('studio'),wrapHue(h0+12));assert.equal(d.screenA.style.writes-w0,18);
 /* a knob taken by the hand is marked, so CSS shows no focus ring; a key on it brings the ring back */
 d.fire('pointerdown',{target:d.bright,clientY:100});assert.equal(d.bright.dataset.pointer,'');
 d.fire('pointerup',{target:d.bright});
 d.fire('keydown',{key:'ArrowUp',target:d.bright});assert.equal(d.bright.dataset.pointer,undefined);
 /* power-on: restarts by flipping the twin keyframes, never by reading layout */
 d.reads.offsetWidth=0;
 d.api.boot();assert.ok(d.screenA.classes.has('is-booting'));const p1=d.screenA.classes.has('is-boot-b');
 d.api.boot();assert.notEqual(d.screenA.classes.has('is-boot-b'),p1,'a second warm-up flips the twin');
 assert.equal(d.reads.offsetWidth,0,'no forced reflow');
});

test('a tone next to a status hue is marked, so that status gets a pattern',()=>{
 assert.equal(S.nearStatus(32),'bad');assert.equal(S.nearStatus(0),'bad');assert.equal(S.nearStatus(5),'bad');assert.equal(S.nearStatus(350),'');
 assert.equal(S.nearStatus(82),'warn');assert.equal(S.nearStatus(100),'warn');
 assert.equal(S.nearStatus(150),'');assert.equal(S.nearStatus(250),'');assert.equal(S.nearStatus(120),'');assert.equal(S.nearStatus(60),'warn');
});

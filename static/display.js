/* Display trim is a local preference, independent of OMP profiles. */
const ManaDisplay=(()=>{
 const clamp=n=>Math.max(0,Math.min(100,Math.round(Number(n)||0)));
 const mix=(a,b,t)=>a.map((v,i)=>Math.round(v+(b[i]-v)*t));
 const luminance=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
 const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
 const defaultHue=130,legacyHues={green:130,amber:42,blue:218,cyan:183,violet:276,neutral:130};
 const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
 const hue=value=>Number.isFinite(value)?Math.max(0,Math.min(359,Math.round(value))):typeof value==='string'&&own(legacyHues,value)?legacyHues[value]:defaultHue;
 const validId=id=>typeof id==='string'&&id.length>0&&id.length<=200;
 const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function screenPreferences(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return {};
  return Object.fromEntries(Object.entries(value).filter(([id,tone])=>validId(id)&&(Number.isFinite(tone)||typeof tone==='string'&&own(legacyHues,tone)||tone&&typeof tone==='object'&&!Array.isArray(tone)&&['background','foreground'].some(k=>own(tone,k)&&Number.isFinite(tone[k])))).map(([id,tone])=>[id,typeof tone==='object'?{background:hue(tone.background),foreground:Number.isFinite(tone.foreground)?hue(tone.foreground):0}:{background:hue(tone),foreground:0}]));
 }
 function colourControl(id,label,tone=defaultHue,foreground=0){
  if(!validId(id))return '';
  return `<span class="lcd-colour-controls">${[['background','ТЛО','Тло екрана',hue(tone)],['foreground','ЗНАКИ','Знаки екрана',Number.isFinite(foreground)?hue(foreground):0]].map(([part,name,title,n])=>`<button type="button" class="lcd-colour-control" data-lcd-colour="${esc(id)}" data-lcd-part="${part}" role="slider" aria-label="${esc(title+': '+label)}" aria-valuemin="0" aria-valuemax="359" aria-valuenow="${n}" aria-valuetext="${n}°" aria-orientation="vertical" style="--lcd-rotation:${n}deg;--lcd-colour-indicator:hsl(${(n+(part==='foreground'?defaultHue:0))%360} 65% 60%)" title="${esc(title+': '+label)} · ${n}° · тягни вгору/вниз · стрілки — 1°, Shift — 10°"><span class="lcd-colour-scale" aria-hidden="true"><span class="lcd-colour-knob"><i></i></span></span><span class="lcd-colour-label" aria-hidden="true">${name}</span></button>`).join('')}</span>`;
 }
 function shiftHue(rgb,angle){
  if(!angle)return rgb;
  const [r,g,b]=rgb.map(v=>v/255),max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min,l=(max+min)/2;
  if(!d)return rgb;
  const h=(((max===r?(g-b)/d:max===g?(b-r)/d+2:(r-g)/d+4)*60+angle)%360+360)%360;
  const s=d/(1-Math.abs(2*l-1)),c=(1-Math.abs(2*l-1))*s,x=c*(1-Math.abs(h/60%2-1)),m=l-c/2;
  return [[c,x,0],[x,c,0],[0,c,x],[0,x,c],[x,0,c],[c,0,x]][Math.floor(h/60)].map(v=>Math.round((v+m)*255));
 }
 function palette(theme,background,colour,tone=defaultHue,foreground=0){
  const dark=theme==='dark',t=clamp(colour)/100;
  const angle=hue(tone)-defaultHue;
  const bg=shiftHue(mix(dark?[19,31,29]:[162,178,164],dark?[52,71,65]:[220,227,212],clamp(background)/100),angle);
  const tones=dark?{
   ink:[[174,188,170],[232,238,202]],muted:[[150,170,157],[196,214,192]],
   green:[[139,172,150],[152,228,159]],amber:[[190,166,128],[255,204,112]],
   red:[[185,147,134],[255,169,143]],blue:[[139,171,182],[132,216,244]]
  }:{
   ink:[[42,58,47],[16,40,27]],muted:[[54,67,56],[33,50,41]],
   green:[[52,80,63],[23,82,46]],amber:[[104,77,39],[122,65,7]],
   red:[[114,66,58],[128,45,31]],blue:[[47,79,88],[12,80,111]]
  };
  const result={background:bg};
  for(const [key,[a,b]] of Object.entries(tones)){
   let color=shiftHue(mix(a,b,t),Number.isFinite(foreground)?hue(foreground):0);const pole=dark?[255,255,255]:[0,0,0];
   // Keep even subdued small labels legible at either end of the background dial.
   for(let n=0;n<100&&contrast(bg,color)<4.8;n++)color=mix(color,pole,.035);
   result[key]=color;
  }
  return result;
 }
 if(typeof document==='undefined')return {palette,contrast,screenPreferences,colourControl};
 const root=document.documentElement,key='mana-display',defaults={light:{background:55,colour:55},dark:{background:25,colour:60}};
 let prefs={},gesture=null,suppressedClick=null;
 function read(){try{prefs=JSON.parse(localStorage.getItem(key)||'{}')||{};}catch{prefs={};}if(typeof prefs!=='object'||Array.isArray(prefs))prefs={};prefs.screens=screenPreferences(prefs.screens);}
 function theme(){return root.dataset.theme==='dark'?'dark':'light';}
 function values(){const mode=theme();return Object.fromEntries(['background','colour'].map(k=>[k,Number.isFinite(prefs[mode]?.[k])?clamp(prefs[mode][k]):defaults[mode][k]]));}
 function save(){try{localStorage.setItem(key,JSON.stringify(prefs));}catch{}}
 const names={background:'Фон екранів',colour:'Насиченість екранів'},labels={background:'фон',colour:'колір'};
 function controls(){const v=values();return ['background','colour'].map(k=>`<button type="button" class="display-knob studio-light" data-display="${k}" role="slider" aria-label="${names[k]}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v[k]}" aria-orientation="vertical" title="${names[k]}: ${v[k]}% · тягни вгору/вниз · подвійний клік — типово"><span class="encoder-scale" aria-hidden="true"><span class="encoder-knob"><span class="encoder-pointer" style="transform:rotate(${v[k]*2.7-135}deg)"></span></span></span><span class="encoder-label">${labels[k]} <output>${v[k]}</output></span></button>`).join('');}
 function screenColour(id,part='background'){return own(prefs.screens,id)?prefs.screens[id][part]:part==='foreground'?0:defaultHue;}
 function mounted(control){return control&&['background','foreground'].includes(control.dataset.lcdPart)&&validId(control.dataset.lcdColour)&&[...document.querySelectorAll('[data-lcd-screen]')].some(screen=>screen.dataset.lcdScreen===control.dataset.lcdColour);}
 function sync(){const v=values();for(const b of document.querySelectorAll('[data-display]')){const n=v[b.dataset.display];b.setAttribute('aria-valuenow',n);b.setAttribute('aria-valuetext',n+'%');b.querySelector('.encoder-pointer').style.transform=`rotate(${n*2.7-135}deg)`;b.querySelector('output').textContent=n;b.title=`${names[b.dataset.display]}: ${n}% · тягни вгору/вниз · подвійний клік — типово`;}
  for(const screen of document.querySelectorAll('[data-lcd-screen]')){const id=screen.dataset.lcdScreen;if(!validId(id))continue;const p=palette(theme(),v.background,v.colour,screenColour(id),screenColour(id,'foreground'));for(const [name,rgb] of Object.entries(p))screen.style.setProperty(name==='background'?'--lcd':'--lcd-'+name,`rgb(${rgb.join(' ')})`);}
  for(const control of document.querySelectorAll('[data-lcd-colour]')){const n=screenColour(control.dataset.lcdColour,control.dataset.lcdPart);control.setAttribute('aria-valuenow',n);control.setAttribute('aria-valuetext',n+'°');control.style.setProperty('--lcd-rotation',n+'deg');control.style.setProperty('--lcd-colour-indicator',`hsl(${(n+(control.dataset.lcdPart==='foreground'?defaultHue:0))%360} 65% 60%)`);control.title=`${control.getAttribute('aria-label')} · ${n}° · тягни вгору/вниз · стрілки — 1°, Shift — 10°`;}
 }
 function apply(){const v=values(),p=palette(theme(),v.background,v.colour);for(const [name,rgb] of Object.entries(p))root.style.setProperty(name==='background'?'--lcd':'--lcd-'+name,`rgb(${rgb.join(' ')})`);sync();}
 function set(k,n){prefs[theme()]={...values(),[k]:clamp(n)};apply();}
 function setScreen(id,part,n){prefs.screens={...prefs.screens,[id]:{background:screenColour(id),foreground:screenColour(id,'foreground'),[part]:hue(n)}};apply();}
 function finish(cancel=false){if(!gesture)return;const g=gesture;gesture=null;delete root.dataset.displayTuning;
  if(g.screen){if(cancel){prefs.screens=g.before;apply();}else if(g.moved&&screenColour(g.screen,g.part)!==g.start)save();if(g.moved||cancel)suppressedClick=g.button;}
  else if(cancel){prefs[g.theme]=g.before;apply();}else save();
  if(g.button.hasPointerCapture(g.id))g.button.releasePointerCapture(g.id);
 }
 read();apply();
 document.addEventListener('click',e=>{const b=e.target.closest('[data-lcd-colour]');if(gesture||!mounted(b))return;if(suppressedClick===b&&e.detail!==0){suppressedClick=null;e.preventDefault();return;}suppressedClick=null;const id=b.dataset.lcdColour,part=b.dataset.lcdPart;setScreen(id,part,(screenColour(id,part)+(e.shiftKey?-15:15)+360)%360);save();});
 document.addEventListener('pointerdown',e=>{const b=e.target.closest('[data-display], [data-lcd-colour]');if(gesture||!b||e.button!==0||b.dataset.lcdColour&&!mounted(b))return;e.preventDefault();b.focus({preventScroll:true});suppressedClick=null;const screen=b.dataset.lcdColour,part=b.dataset.lcdPart;gesture=screen?{button:b,id:e.pointerId,screen,part,y:e.clientY,start:screenColour(screen,part),before:{...prefs.screens},moved:false}:{button:b,id:e.pointerId,key:b.dataset.display,y:e.clientY,start:values()[b.dataset.display],before:values(),theme:theme()};root.dataset.displayTuning='true';b.setPointerCapture(e.pointerId);});
 document.addEventListener('pointermove',e=>{if(!gesture||gesture.id!==e.pointerId)return;e.preventDefault();const delta=gesture.y-e.clientY;if(gesture.screen){if(Math.abs(delta)>=3)gesture.moved=true;if(gesture.moved)setScreen(gesture.screen,gesture.part,gesture.start+delta*2);}else set(gesture.key,gesture.start+delta*.7);});
 document.addEventListener('pointerup',e=>{if(gesture?.id===e.pointerId)finish();});
 for(const type of ['pointercancel','lostpointercapture'])document.addEventListener(type,e=>{if(gesture?.id===e.pointerId)finish(true);});
 addEventListener('blur',()=>finish(true));
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&gesture){e.preventDefault();e.stopPropagation();finish(true);return;}const b=e.target.closest('[data-display], [data-lcd-colour]');if(!b||!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const screen=b.dataset.lcdColour,part=b.dataset.lcdPart,step=e.shiftKey?10:screen?1:2,delta=['ArrowUp','ArrowRight'].includes(e.key)?step:-step;if(screen){if(!mounted(b))return;setScreen(screen,part,e.key==='Home'?0:e.key==='End'?359:screenColour(screen,part)+delta);}else{const k=b.dataset.display;set(k,e.key==='Home'?0:e.key==='End'?100:values()[k]+delta);}save();},true);
 document.addEventListener('dblclick',e=>{const b=e.target.closest('[data-display]');if(b){set(b.dataset.display,defaults[theme()][b.dataset.display]);save();}});
 new MutationObserver(()=>{finish(true);apply();}).observe(root,{attributes:true,attributeFilter:['data-theme']});
 addEventListener('storage',e=>{if(e.key===key){finish(true);read();apply();}});
 return {controls,sync,palette,contrast,colourControl:(id,label)=>colourControl(id,label,screenColour(id),screenColour(id,'foreground'))};
})();
if(typeof module!=='undefined')module.exports=ManaDisplay;

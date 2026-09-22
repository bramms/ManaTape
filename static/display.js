/* Display trim is a local preference, independent of OMP profiles. */
const ManaDisplay=(()=>{
 const clamp=n=>Math.max(0,Math.min(100,Math.round(Number(n)||0)));
 const mix=(a,b,t)=>a.map((v,i)=>Math.round(v+(b[i]-v)*t));
 const luminance=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
 const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
 function palette(theme,background,colour){
  const dark=theme==='dark',t=clamp(colour)/100;
  const bg=mix(dark?[19,31,29]:[162,178,164],dark?[52,71,65]:[220,227,212],clamp(background)/100);
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
   let color=mix(a,b,t);const pole=dark?[255,255,255]:[0,0,0];
   // Keep even subdued small labels legible at either end of the background dial.
   for(let n=0;n<100&&contrast(bg,color)<4.8;n++)color=mix(color,pole,.035);
   result[key]=color;
  }
  return result;
 }
 if(typeof document==='undefined')return {palette,contrast};
 const root=document.documentElement,key='mana-display',defaults={light:{background:55,colour:55},dark:{background:25,colour:60}};
 let prefs={},gesture=null;
 function read(){try{prefs=JSON.parse(localStorage.getItem(key)||'{}')||{};}catch{prefs={};}if(typeof prefs!=='object'||Array.isArray(prefs))prefs={};}
 function theme(){return root.dataset.theme==='dark'?'dark':'light';}
 function values(){const mode=theme();return Object.fromEntries(['background','colour'].map(k=>[k,Number.isFinite(prefs[mode]?.[k])?clamp(prefs[mode][k]):defaults[mode][k]]));}
 function save(){try{localStorage.setItem(key,JSON.stringify(prefs));}catch{}}
 const names={background:'Фон екранів',colour:'Насиченість екранів'},labels={background:'фон',colour:'колір'};
 function controls(){const v=values();return ['background','colour'].map(k=>`<button type="button" class="display-knob studio-light" data-display="${k}" role="slider" aria-label="${names[k]}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v[k]}" aria-orientation="vertical" title="${names[k]}: ${v[k]}% · тягни вгору/вниз · подвійний клік — типово"><span class="encoder-scale" aria-hidden="true"><span class="encoder-knob"><span class="encoder-pointer" style="transform:rotate(${v[k]*2.7-135}deg)"></span></span></span><span class="encoder-label">${labels[k]} <output>${v[k]}</output></span></button>`).join('');}
 function sync(){const v=values();for(const b of document.querySelectorAll('[data-display]')){const n=v[b.dataset.display];b.setAttribute('aria-valuenow',n);b.setAttribute('aria-valuetext',n+'%');b.querySelector('.encoder-pointer').style.transform=`rotate(${n*2.7-135}deg)`;b.querySelector('output').textContent=n;b.title=`${names[b.dataset.display]}: ${n}% · тягни вгору/вниз · подвійний клік — типово`;}}
 function apply(){const v=values(),p=palette(theme(),v.background,v.colour);for(const [name,rgb] of Object.entries(p))root.style.setProperty(name==='background'?'--lcd':'--lcd-'+name,`rgb(${rgb.join(' ')})`);sync();}
 function set(k,n){prefs[theme()]={...values(),[k]:clamp(n)};apply();}
 function finish(cancel=false){if(!gesture)return;const g=gesture;gesture=null;delete root.dataset.displayTuning;if(cancel){prefs[g.theme]=g.before;apply();}else save();if(g.button.hasPointerCapture(g.id))g.button.releasePointerCapture(g.id);}
 read();apply();
 document.addEventListener('pointerdown',e=>{const b=e.target.closest('[data-display]');if(!b||e.button!==0)return;e.preventDefault();b.focus({preventScroll:true});gesture={button:b,id:e.pointerId,key:b.dataset.display,y:e.clientY,start:values()[b.dataset.display],before:values(),theme:theme()};root.dataset.displayTuning='true';b.setPointerCapture(e.pointerId);});
 document.addEventListener('pointermove',e=>{if(!gesture||gesture.id!==e.pointerId)return;e.preventDefault();set(gesture.key,gesture.start+(gesture.y-e.clientY)*.7);});
 document.addEventListener('pointerup',e=>{if(gesture?.id===e.pointerId)finish();});
 for(const type of ['pointercancel','lostpointercapture'])document.addEventListener(type,e=>{if(gesture?.id===e.pointerId)finish(true);});
 addEventListener('blur',()=>finish(true));
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&gesture){e.preventDefault();e.stopPropagation();finish(true);return;}const b=e.target.closest('[data-display]');if(!b||!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const step=e.shiftKey?10:2,k=b.dataset.display;set(k,e.key==='Home'?0:e.key==='End'?100:values()[k]+(['ArrowUp','ArrowRight'].includes(e.key)?step:-step));save();},true);
 document.addEventListener('dblclick',e=>{const b=e.target.closest('[data-display]');if(b){set(b.dataset.display,defaults[theme()][b.dataset.display]);save();}});
 new MutationObserver(()=>{finish(true);apply();}).observe(root,{attributes:true,attributeFilter:['data-theme']});
 addEventListener('storage',e=>{if(e.key===key){finish(true);read();apply();}});
 return {controls,sync,palette,contrast};
})();
if(typeof module!=='undefined')module.exports=ManaDisplay;

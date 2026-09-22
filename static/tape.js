/* Editing history and motion stay local. Neither can write an OMP profile. */
class ForgeHistory {
 constructor(limit=40){this.limit=limit;this.profiles=new Map();}
 observe(name,value,dirty,baseline){
  const serialized=JSON.stringify(value),h=this.profiles.get(name);
  if(!h){const saved=baseline===undefined?serialized:JSON.stringify(baseline);this.profiles.set(name,{present:serialized,dirty,past:dirty&&saved!==serialized?[saved]:[],future:[]});return;}
  if(h.present===serialized){
   // A draft can predate this history (session restore or a save/reload race).
   const saved=baseline===undefined?serialized:JSON.stringify(baseline);
   if(dirty&&!h.past.length&&saved!==serialized)h.past.push(saved);
   h.dirty=dirty;return;
  }
  if(dirty||h.dirty){h.past.push(h.present);if(h.past.length>this.limit)h.past.shift();h.future=[];}
  else{h.past=[];h.future=[];} // A fresh server snapshot is not an edit.
  h.present=serialized;h.dirty=dirty;
 }
 step(name,direction){
  const h=this.profiles.get(name),from=direction<0?h?.past:h?.future,to=direction<0?h?.future:h?.past;
  if(!from?.length)return null;
  to.push(h.present);h.present=from.pop();return JSON.parse(h.present);
 }
 reset(name,value,dirty=false){this.profiles.set(name,{present:JSON.stringify(value),dirty,past:[],future:[]});}
 rename(from,to){if(from===to)return;const h=this.profiles.get(from);this.profiles.delete(from);if(h&&to)this.profiles.set(to,h);}
 available(name){const h=this.profiles.get(name);return {undo:!!h?.past.length,redo:!!h?.future.length};}
}
if(typeof module!=='undefined')module.exports={ForgeHistory};
if(typeof window!=='undefined'){
 window.ForgeHistory=ForgeHistory;
 window.ForgeTape=(()=>{
  const frames=new WeakMap();let motor=null,pendingIntent=null;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'),ease='cubic-bezier(.22,.75,.25,1)';
  const visible=el=>{const r=el.getBoundingClientRect();return r.width&&r.height&&r.bottom>0&&r.top<innerHeight?r:null;};
  const clips=root=>[...root.querySelectorAll('[data-clip-key]')].filter(visible);
  function before(root){return {frame:frames.get(root),wheel:root.querySelector('.mark-wheel')?getComputedStyle(root.querySelector('.mark-wheel')).rotate:'0deg',context:root.dataset.tapeContext,clips:new Map(clips(root).map(el=>[el.dataset.clipKey,el.getBoundingClientRect()])),mode:root.querySelector('.mode-shuttle-switch')?.getAttribute('aria-checked'),picker:!!root.querySelector('.picker'),modal:!!root.querySelector('.modal'),modePanel:!!root.querySelector('.mode-panel')};}
  function fit(root){
   const graph=root.querySelector('.desktop-graph .graph');if(!graph?.getClientRects().length)return;
   const steps=Number(getComputedStyle(document.getElementById('forge-direct')).getPropertyValue('--fg-steps'))||8;
   const size=Math.floor((root.querySelector('.desktop-graph').clientWidth-16-112-23-(steps+1)*2)/steps);
   root.style.setProperty('--clip-width',Math.max(88,size)+'px');
  }
  function move(el,frames,duration=240,delay=0){if(!el||reduced.matches)return;return el.animate(frames,{duration,delay,easing:ease,fill:'backwards'});}
  function feed(root){
   const rows=[...root.querySelectorAll('.graph-row,.mobile-group')].filter(visible);
   rows.forEach((row,i)=>{
    // The chassis/role label stays still; only CUTS travel through the tape bed.
    const distance=Math.min(110,row.clientWidth*.22);
    const strips=row.matches('.graph-row')?[...row.children].filter(el=>el.matches('.node,.reserve-drop')):[...row.querySelectorAll('.tree-line')];
    for(const strip of strips)move(strip,[{opacity:.15,transform:`translateX(${-distance}px)`,clipPath:`inset(0 0 0 ${distance}px)`},{opacity:1,transform:'none',clipPath:'inset(0 0 0 0)'}],420,Math.min(i,14)*9);
   });
  }
  function after(root,old,frame={}){
   frames.set(root,frame);
   const intent=pendingIntent;pendingIntent=null;
   if(reduced.matches)return;
   const mode=root.querySelector('.mode-shuttle-switch');if(mode&&old.mode!=null&&old.mode!==mode.getAttribute('aria-checked')){const on=mode.getAttribute('aria-checked')==='true';move(mode.querySelector('.mode-shuttle-cap'),[{transform:`translateX(${on?0:30}px)`},{transform:`translateX(${on?30:0}px)`}],210);}
   const previous=old.frame,loaded=previous&&previous.profile!==frame.profile,
    edited=previous&&previous.profile===frame.profile&&previous.draft!==frame.draft&&(previous.dirty||frame.dirty),
    saved=previous?.saving&&!frame.saving&&!frame.dirty&&!frame.error,
    projected=previous&&previous.profile===frame.profile&&previous.projection!==frame.projection;
   const brand=root.querySelector('.brand');
   for(const wheel of brand?.querySelectorAll('.mark-wheel')||[])wheel.style.rotate=old.wheel||'0deg';
   if(loaded&&frame.view==='profiles'){
    feed(root);logo(brand,true);
   }else if(old.context!==root.dataset.tapeContext){
    if(!old.context){feed(root);logo(brand,true);}
    else if(previous?.view!==frame.view){move(root.querySelector('.operator-surface'),[{opacity:.6,transform:'translateX(10px)'},{opacity:1,transform:'none'}],220);logo(brand);}
    else{feed(root);logo(brand);}
   }else{
    // A refresh must not reinterpret an in-flight transform as a new edit.
    for(const el of edited||projected?clips(root):[]){
     const from=old.clips.get(el.dataset.clipKey),to=el.getBoundingClientRect();
     if(from){const x=from.left-to.left,y=from.top-to.top;if(Math.abs(x)>1||Math.abs(y)>1)move(el,[{transform:`translate(${x}px,${y}px)`},{transform:'translate(0,-2px)',offset:.78},{transform:'none'}],260);}
     else if(old.clips.size)move(el,[{opacity:.35,transform:'translate(-12px,-2px)'},{opacity:1,transform:'translate(0,-1px)',offset:.8},{transform:'none'}],250);
    }
    if(edited||saved)logo(brand,false,intent==='undo'?-1:1);
    else if(motor&&performance.now()<motor.end)spin(brand,parseFloat(old.wheel)||0,motor.to,motor.end-performance.now());
   }
   // Entry motion belongs to opening a surface, never to its subsequent renders.
   for(const [selector,existed] of [['.picker',old.picker],['.modal',old.modal],['.mode-panel',old.modePanel]]){const el=root.querySelector(selector);if(el&&!existed)move(el,[{opacity:.3,translate:'0 5px'},{opacity:1,translate:'0 0'}],150);}
  }
  function spin(brand,from,to,duration){
   for(const wheel of brand?.querySelectorAll('.mark-wheel')||[]){
    wheel.getAnimations().forEach(a=>a.cancel());wheel.style.rotate=to+'deg';
    move(wheel,[{rotate:from+'deg'},{rotate:to+'deg'}],duration);
   }
  }
  function logo(brand,press=false,direction=1){
   if(!brand||reduced.matches)return;
   const wheel=brand.querySelector('.mark-wheel'),from=parseFloat(getComputedStyle(wheel).rotate)||0,duration=press?680:420,to=from+(press?360:120)*direction;
   motor={to,end:performance.now()+duration};spin(brand,from,to,duration);
  }
  reduced.addEventListener('change',()=>{if(reduced.matches)document.getAnimations().forEach(a=>a.cancel());});
  return {before,after,logo,fit,intent:value=>{pendingIntent=value;}};
 })();
}

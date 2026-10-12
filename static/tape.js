/* Editing history and motion stay local. Neither can write an OMP profile. */
class ForgeHistory {
 constructor(limit=40){this.limit=limit;this.profiles=new Map();}
 observe(name,value,dirty,baseline){
  const serialized=JSON.stringify(value),h=this.profiles.get(name);
  if(!h){const saved=baseline===undefined?serialized:JSON.stringify(baseline);this.profiles.set(name,{present:serialized,dirty,past:dirty&&saved!==serialized?[saved]:[],future:[]});return;}
  if(h.present===serialized){
   // A draft can predate this history (session restore or a save/reload race). The baseline is serialised
   // only then, not on every render.
   if(dirty&&!h.past.length){const saved=baseline===undefined?serialized:JSON.stringify(baseline);if(saved!==serialized)h.past.push(saved);}
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
  // One read pass over the visible CUTS: [element, rect] pairs, collected before any animation starts.
  const measure=root=>{const out=[];for(const el of root.querySelectorAll('[data-clip-key]')){const r=visible(el);if(r)out.push([el,r]);}return out;};
  // The logo phase comes from the running wheel animation's timing, never from a style recalculation.
  function phase(){
   if(!motor)return 0;
   const progress=motor.animation?.playState==='running'?motor.animation.effect?.getComputedTiming().progress:null;
   return progress==null?(performance.now()<motor.end?motor.from:motor.to):motor.from+(motor.to-motor.from)*progress;
  }
  // `next` is the frame the coming render will produce. CUT geometry is read only when that render can move
  // CUTS (an edit or a new projection in the same context); without `next` it is always read.
  function before(root,next){
   const previous=frames.get(root),moving=!next||!reduced.matches&&!!previous&&previous.profile===next.profile&&(next.context===undefined||next.context===root.dataset.tapeContext)&&(previous.draft!==next.draft&&(previous.dirty||next.dirty)||previous.projection!==next.projection);
   return {frame:previous,brand:root.querySelector('.brand'),wheel:phase(),context:root.dataset.tapeContext,clips:new Map(moving?measure(root).map(([el,r])=>[el.dataset.clipKey,r]):[]),mode:root.querySelector('.mode-shuttle-switch')?.getAttribute('aria-checked'),picker:!!root.querySelector('.picker'),modal:!!root.querySelector('.modal'),modePanel:!!root.querySelector('.mode-panel')};
  }
  function fit(root,steps){
   const graph=root.querySelector('.desktop-graph .graph');if(!graph?.getClientRects().length)return;
   steps=Number(steps)||Number(getComputedStyle(document.getElementById('forge-direct')).getPropertyValue('--fg-steps'))||8;
   const size=Math.max(88,Math.floor((root.querySelector('.desktop-graph').clientWidth-16-112-23-(steps+1)*2)/steps))+'px';
   // An unchanged width is not written: an inherited custom property would restyle the whole window.
   if(root.style.getPropertyValue('--clip-width')!==size)root.style.setProperty('--clip-width',size);
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
   // A kept logo keeps spinning by itself; a rebuilt one continues the phase of the one it replaced.
   const brand=root.querySelector('.brand'),renewed=!!brand&&brand!==old.brand;
   if(renewed)for(const wheel of brand.querySelectorAll('.mark-wheel'))wheel.style.rotate=(old.wheel||0)+'deg';
   if(loaded&&frame.view==='profiles'){
    feed(root);logo(brand,true);
   }else if(old.context!==root.dataset.tapeContext){
    if(!old.context){feed(root);logo(brand,true);}
    else if(previous?.view!==frame.view){move(root.querySelector('.operator-surface'),[{opacity:.6,transform:'translateX(10px)'},{opacity:1,transform:'none'}],220);logo(brand);}
    else{feed(root);logo(brand);}
   }else{
    // A refresh must not reinterpret an in-flight transform as a new edit. Every rect is read first, then
    // every animation starts: interleaving them would force a style and layout pass per CUT.
    for(const [el,to] of edited||projected?measure(root):[]){
     const from=old.clips.get(el.dataset.clipKey);
     if(from){const x=from.left-to.left,y=from.top-to.top;if(Math.abs(x)>1||Math.abs(y)>1)move(el,[{transform:`translate(${x}px,${y}px)`},{transform:'translate(0,-2px)',offset:.78},{transform:'none'}],260);}
     else if(old.clips.size)move(el,[{opacity:.35,transform:'translate(-12px,-2px)'},{opacity:1,transform:'translate(0,-1px)',offset:.8},{transform:'none'}],250);
    }
    if(edited||saved)logo(brand,false,intent==='undo'?-1:1);
    else if(renewed&&motor&&performance.now()<motor.end)spin(brand,old.wheel||0,motor.to,motor.end-performance.now());
   }
   // Entry motion belongs to opening a surface, never to its subsequent renders.
   for(const [selector,existed] of [['.picker',old.picker],['.modal',old.modal],['.mode-panel',old.modePanel]]){const el=root.querySelector(selector);if(el&&!existed)move(el,[{opacity:.3,translate:'0 5px'},{opacity:1,translate:'0 0'}],150);}
  }
  function spin(brand,from,to,duration){
   const animations=[];for(const a of motor?.animations||[])a.cancel();
   for(const wheel of brand?.querySelectorAll('.mark-wheel')||[]){wheel.style.rotate=to+'deg';const a=move(wheel,[{rotate:from+'deg'},{rotate:to+'deg'}],duration);if(a)animations.push(a);}
   motor={from,to,end:performance.now()+duration,animation:animations[0],animations};
  }
  function logo(brand,press=false,direction=1){
   if(!brand||reduced.matches)return;
   const from=phase(),duration=press?680:420,to=from+(press?360:120)*direction;
   spin(brand,from,to,duration);
  }
  reduced.addEventListener('change',()=>{if(reduced.matches)document.getAnimations().forEach(a=>a.cancel());});
  return {before,after,logo,fit,intent:value=>{pendingIntent=value;}};
 })();
}

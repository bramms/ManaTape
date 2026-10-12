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
 /* Motion as feedback (DESIGN «Анімація як зворотний зв’язок»): the logo reels spin on a change and back on Undo,
    lanes enter on load / profile change, a moved CUT glides, an inserted one splices in. Only transform and
    opacity animate; a background refresh never animates the tape; reduced motion turns movement off. */
 window.ForgeTape=(()=>{
  const frames=new WeakMap();let reel=0,pendingIntent=null;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'),ease='cubic-bezier(.22,.75,.25,1)';
  const visible=el=>{const r=el.getBoundingClientRect();return r.width&&r.height&&r.bottom>0&&r.top<innerHeight?r:null;};
  // One read pass over the visible CUTS: [element, rect] pairs, collected before any animation starts.
  const measure=root=>{const out=[];for(const el of root.querySelectorAll('[data-clip-key]')){const r=visible(el);if(r)out.push([el,r]);}return out;};
  // `next` is the frame the coming render will produce. CUT geometry is read only when that render can move
  // CUTS (an edit or a new projection in the same context); without `next` it is always read.
  function before(root,next){
   const previous=frames.get(root),moving=!next||!reduced.matches&&!!previous&&previous.profile===next.profile&&(next.context===undefined||next.context===root.dataset.tapeContext)&&(previous.draft!==next.draft&&(previous.dirty||next.dirty)||previous.projection!==next.projection);
   return {frame:previous,context:root.dataset.tapeContext,clips:new Map(moving?measure(root).map(([el,r])=>[el.dataset.clipKey,r]):[]),picker:!!root.querySelector('[data-picker]'),modal:!!root.querySelector('.tray__form'),editor:!!root.querySelector('.tray__editor')};
  }
  // CUT widths come from the design system (--cut-w); there is nothing to fit any more. Kept for old callers.
  function fit(){}
  function move(el,frames,duration=240,delay=0){if(!el||reduced.matches)return;return el.animate(frames,{duration,delay,easing:ease,fill:'backwards'});}
  // Lanes enter: the tape in each visible groove slides in with a small stagger; lane keys stay still.
  function feed(root){
   const lanes=[...root.querySelectorAll('.lane')].filter(visible);
   lanes.forEach((lane,i)=>{for(const piece of lane.querySelectorAll(':scope>.lane__groove>*'))move(piece,[{opacity:0,transform:'translateX(-22px)'},{opacity:1,transform:'none'}],420,Math.min(i,14)*28);});
  }
  function after(root,old,frame={}){
   frames.set(root,frame);
   const intent=pendingIntent;pendingIntent=null;
   if(reduced.matches)return;
   const previous=old.frame,loaded=previous&&previous.profile!==frame.profile,
    edited=previous&&previous.profile===frame.profile&&previous.draft!==frame.draft&&(previous.dirty||frame.dirty),
    saved=previous?.saving&&!frame.saving&&!frame.dirty&&!frame.error,
    projected=previous&&previous.profile===frame.profile&&previous.projection!==frame.projection;
   const brand=root.querySelector('.brand');
   if(loaded&&frame.view==='profiles'){feed(root);logo(brand,true);}
   else if(old.context!==root.dataset.tapeContext){
    if(!old.context){feed(root);logo(brand,true);}
    else if(previous?.view!==frame.view){move(root.querySelector('main.workarea'),[{opacity:.6,transform:'translateX(10px)'},{opacity:1,transform:'none'}],220);logo(brand);}
    else{feed(root);logo(brand);}
   }else{
    // A refresh must not reinterpret an in-flight transform as a new edit. Every rect is read first, then
    // every animation starts: interleaving them would force a style and layout pass per CUT.
    for(const [el,to] of edited||projected?measure(root):[]){
     const from=old.clips.get(el.dataset.clipKey);
     if(from){const x=from.left-to.left,y=from.top-to.top;if(Math.abs(x)>1||Math.abs(y)>1)move(el,[{transform:`translate(${x}px,${y}px)`},{transform:'translate(0,-2px)',offset:.78},{transform:'none'}],260);}
     // A new CUT splices in (only when this render really changed the tape).
     else if(old.clips.size)move(el,[{opacity:0,transform:'translateX(-14px) scaleX(.7)'},{opacity:1,transform:'none'}],360);
    }
    if(edited||saved)logo(brand,false,intent==='undo'?-1:1);
   }
   // Entry motion belongs to opening a surface, never to its subsequent renders.
   for(const [selector,existed] of [['[data-picker]',old.picker],['.tray__form',old.modal],['.tray__editor',old.editor]]){const el=root.querySelector(selector);if(el&&!existed)move(el,[{opacity:.3,translate:'0 5px'},{opacity:1,translate:'0 0'}],150);}
  }
  // The logo reels: the angle lives here, so a re-render never loses the phase; CSS transitions the transform.
  function logo(brand,press=false,direction=1){
   if(!brand||reduced.matches)return;
   reel+=(press?360:120)*direction;
   const duration=(press?680:420)+'ms';
   for(const [el,k] of [[brand.querySelector('.reel--a'),1],[brand.querySelector('.reel--b'),1.6]])if(el){el.style.transitionDuration=duration;el.style.transform=`rotate(${reel*k}deg)`;}
  }
  reduced.addEventListener('change',()=>{if(reduced.matches)document.getAnimations().forEach(a=>a.cancel());});
  return {before,after,logo,fit,intent:value=>{pendingIntent=value;}};
 })();
}

/* «Світло»: the lever flips first (screen.js, .tgl), then the theme cross-fades in one View Transition and the
   screens power on. No custom property is animated on the root; switching themes never rebuilds the editor.
   The cross-fade starts when the lever strikes its stop (detail.contact), and the warm-up of the glass runs inside
   the transition's update, so the new theme costs one style pass, not a forced reflow plus a second restyle. */
(()=>{
 const root=document.documentElement,system=matchMedia('(prefers-color-scheme: dark)'),reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let preference=null;
 try{const stored=localStorage.getItem('forge-theme');if(['light','dark'].includes(stored))preference=stored;}catch{}
 const TABLE={light:'#D9D5CD',dark:'#16171A'};
 function apply(theme){
  root.dataset.theme=theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',TABLE[theme]);
  for(const toggle of document.querySelectorAll('[data-theme-toggle]')){
   toggle.setAttribute('aria-checked',String(theme==='light'));
   toggle.title=(theme==='light'?'Світло · вниз — темна тема':'Темно · вгору — світла тема')+' · Space / Enter, ↑ / ↓';
  }
 }
 // Under the cross-fade only what is on screen restyles: a lane outside the viewport is parked (content-visibility:
 // hidden) until the transition ends or the page scrolls. The new theme and the View Transition itself (its start and
 // end each restyle the whole document) then cost the visible lanes only (final QA perf: «світло» hold).
 function park(){
  // Only the lanes' own boxes are read (a skipped lane keeps its box; its content is never measured).
  const parked=[...document.querySelectorAll('.lane')].filter(lane=>{const r=lane.getBoundingClientRect();return r.height&&(r.bottom<0||r.top>innerHeight);});
  for(const lane of parked)lane.classList.add('is-parked');
  const release=()=>{removeEventListener('scroll',release);for(const el of parked)el.classList.remove('is-parked');parked.length=0;};
  addEventListener('scroll',release,{passive:true});return release;
 }
 // The lever strikes its stop: one cross-fade of the whole page, then the glass powers on.
 function switchTo(theme){
  if(root.dataset.theme===theme)return;
  const run=()=>{apply(theme);window.ManaScreen?.boot();};
  if(document.startViewTransition&&!reduced.matches&&!document.hidden){const release=park();document.startViewTransition(run).finished.finally(release);}
  else run();
 }
 // A theme that changes elsewhere (the system, another tab) flips the levers first, as a hand would.
 function follow(theme){
  const levers=[...document.querySelectorAll('.tgl[data-theme-toggle]')].map(el=>window.ManaScreen?.toggle(el,theme==='light')).map(p=>p?.contact||p);
  Promise.all(levers).then(()=>switchTo(theme));
 }
 apply(preference||(system.matches?'dark':'light'));
 document.addEventListener('mana:toggle',event=>{
  if(!event.target.closest?.('[data-theme-toggle]'))return;
  preference=event.detail.checked?'light':'dark';
  try{localStorage.setItem('forge-theme',preference);}catch{}
  const theme=preference;(event.detail.contact||event.detail.settled).then(()=>{if(preference===theme)switchTo(theme);});
 });
 system.addEventListener('change',()=>{if(!preference)follow(system.matches?'dark':'light');});
 addEventListener('storage',event=>{if(event.key==='forge-theme'){preference=['light','dark'].includes(event.newValue)?event.newValue:null;follow(preference||(system.matches?'dark':'light'));}});
})();

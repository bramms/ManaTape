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
 // The lever strikes its stop: one cross-fade of the whole page, then the glass powers on.
 function switchTo(theme){
  if(root.dataset.theme===theme)return;
  const run=()=>{apply(theme);window.ManaScreen?.boot();};
  if(document.startViewTransition&&!reduced.matches&&!document.hidden)document.startViewTransition(run);else run();
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

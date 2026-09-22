/* One dimmer drives the materials; switching themes never rebuilds the editor. */
(()=>{
 const root=document.documentElement,system=matchMedia('(prefers-color-scheme: dark)'),reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let preference=null,timer;
 try{const stored=localStorage.getItem('forge-theme');if(['light','dark'].includes(stored))preference=stored;}catch{}
 function apply(theme,animate=false){
  clearTimeout(timer);
  if(animate&&!reduced.matches){root.dataset.lightMotion=theme==='light'?'on':'off';root.classList.add('light-changing');getComputedStyle(root).getPropertyValue('--lamp');}
  else{root.classList.remove('light-changing');delete root.dataset.lightMotion;}
  root.dataset.theme=theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='light'?'#e9ece6':'#303639');
  for(const button of document.querySelectorAll('[data-theme-toggle]')){
   button.setAttribute('aria-checked',String(theme==='light'));
   button.title=theme==='light'?'Вимкнути світло · темна тема':'Увімкнути світло · світла тема';
  }
  if(animate)timer=setTimeout(()=>{root.classList.remove('light-changing');delete root.dataset.lightMotion;},1350);
 }
 apply(preference||(system.matches?'dark':'light'));
 document.addEventListener('click',event=>{
  if(!event.target.closest('[data-theme-toggle]'))return;
  preference=root.dataset.theme==='dark'?'light':'dark';
  try{localStorage.setItem('forge-theme',preference);}catch{}
  apply(preference,true);
 });
 system.addEventListener('change',()=>{if(!preference)apply(system.matches?'dark':'light',true);});
 addEventListener('storage',event=>{if(event.key==='forge-theme'){preference=['light','dark'].includes(event.newValue)?event.newValue:null;apply(preference||(system.matches?'dark':'light'),true);}});
 reduced.addEventListener('change',()=>{if(reduced.matches)apply(root.dataset.theme);});
})();

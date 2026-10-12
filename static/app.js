
(async()=>{
 const root=document.getElementById('forge-direct'),win=document.getElementById('forge-window');
 const selectedProject=new URLSearchParams(location.search).get('project');
 const endpoint=path=>path+(selectedProject?'?project='+encodeURIComponent(selectedProject):'');
 // The first request is the one index.html preloads (same URL and mode), so it is usually already in flight.
 let source,stateTag='';
 try {const res=await fetch(endpoint('/api/state'));source=await res.json();if(!res.ok)throw Error(source.error);stateTag=res.headers.get('ETag')||'';}catch(e){win.innerHTML='<div class="device"><div class="boot"><div class="screen" data-screen="startup" data-screen-default="27"><div class="screen__win"><div class="screen__gasket"><div class="glass"><div class="glass__content"><div class="g"><div class="g-head"><span class="g-name">Mana Tape</span><span class="g-age">немає зв’язку</span></div><div class="g-msg" data-s="bad"><span>Сервер не відповідає. Перевір підключення.</span></div></div></div></div></div></div></div><button type="button" class="key" id="retry-load"><span class="key__cap">Повторити</span></button></div></div>';window.ManaScreen?.sync();document.getElementById('retry-load').onclick=()=>location.reload();return;}

 const labels=source.ui?.roleLabels||{};
 const providerNames={'opencode-free':'OpenCode Free','commandcode':'CommandCode','opencode-go':'OpenCode Go','openai-codex':'Codex','google-antigravity':'Antigravity','anthropic':'Anthropic','deepseek':'DeepSeek API',...(source.ui?.providerLabels||{})};
 const codes={'opencode-free':'FREE','openrouter':'OR','commandcode':'CC','opencode-go':'GO','openai-codex':'CX','google-antigravity':'AG','anthropic':'AN','deepseek':'DS',...(source.ui?.providerCodes||{})};
 const providerCode=id=>codes[id]||String(id||'?').slice(0,4).toUpperCase();
 const prettyProfile=s=>s==='standard'?'Standard':s;
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function searchText(value){return String(value??'').normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/[^\p{L}\p{N}]+/gu,' ');}
 function matchesQuery(query,...values){const text=searchText(values.join(' '));return searchText(query).split(' ').filter(Boolean).every(word=>text.includes(word));}
 // A keystroke normalises only the query; each model's text is normalised once per snapshot (searchKey).
 function queryWords(query){return searchText(query).split(' ').filter(Boolean);}
 function matchesWords(words,text){return words.every(word=>text.includes(word));}
 // Formatters are expensive to construct; one per option set is reused (the tariff axis needs ~60 a render).
 function dateFormat(options){const cache=dateFormat.cache??=new Map(),key=JSON.stringify(options);let format=cache.get(key);if(!format)cache.set(key,format=new Intl.DateTimeFormat('uk-UA',options));return format;}
 function numberFormat(locale,options){const cache=numberFormat.cache??=new Map(),key=locale+JSON.stringify(options);let format=cache.get(key);if(!format)cache.set(key,format=new Intl.NumberFormat(locale,options));return format;}
 const collate=new Intl.Collator().compare;
 const icon=n=>`<span aria-hidden="true">${({sparkles:'✧',search:'⌕','undo-2':'↶',star:'☆',x:'×','trash-2':'−'})[n]||'·'}</span>`;
 const tool=(txt,act,cl='',attr='')=>`<button type="button" class="tool ${cl}" data-action="${act}" ${attr}>${txt}</button>`;
 // Device keys (static/device.css): a socket with a cap; a lit LED and the latched state carry meaning, not colour.
 function led(on,c='green',extra=''){return `<span class="led${on?' is-on':''}" data-c="${c}"${extra}></span>`;}
 function key(cap,act,cls='',attr=''){return `<button type="button" class="key ${cls}"${act?` data-action="${act}"`:''} ${attr}><span class="key__cap">${cap}</span></button>`;}
 const SVG={
  undo:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5 3.5 9.5 8 14"/><path d="M4 9.5h10a5.5 5.5 0 0 1 0 11h-3"/></svg>',
  redo:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m16 5 4.5 4.5L16 14"/><path d="M20 9.5H10a5.5 5.5 0 0 0 0 11h3"/></svg>',
  refresh:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  more:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/></svg>',
  close:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  search:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>'
 };
 const copy=x=>JSON.parse(JSON.stringify(x));
 function merge(a,b){const out=copy(a);for(const [k,v]of Object.entries(b||{})){out[k]=v&&typeof v==='object'&&!Array.isArray(v)?merge(out[k]||{},v):copy(v);}return out;}
 const builtinRoles=source.builtinRoles||[];
 function knownAgents(){return source.agents||[];}
 function agentInfo(worker){return knownAgents().find(a=>a.id===worker);}
 function agentSource(worker){return ({project:'проєкт',user:'користувач'})[agentInfo(worker)?.source]||'';}
 function shortText(text,max){return text.length>max?text.slice(0,max-1).trimEnd()+'…':text;}
 function isCustomAgent(info){return !!info?.source&&info.source!=='builtin';}
 function agentModelText(info,fallback=''){const model=info?.model;if(Array.isArray(model))return model.join(' → ');if(model)return model;return isCustomAgent(info)?'успадковує модель сесії':fallback;}
 function agentModelAlias(info){return typeof info?.model==='string'&&info.model.startsWith('@')?info.model:'';}
 function resetAgent(worker){
  if(state.saving||!Object.hasOwn(p().task.agentModelOverrides||{},worker)&&!agentInfo(worker))return;
  const target=p().task.agentModelOverrides,base=state.profile==='standard'?{}:original.standard.task.agentModelOverrides;
  if(Object.hasOwn(base,worker))target[worker]=copy(base[worker]);else delete target[worker];
  delete modeSettings().overrides['vibe:'+worker];state.picker=null;render();focusLane(worker,'vibe');
 }
 // After a reset the old control is gone; focus the lane's own first control.
 function focusLane(role,group){[...win.querySelectorAll(`button[data-edit="${CSS.escape(role)}"][data-group="${group}"]`)].find(el=>el.getClientRects().length)?.focus({preventScroll:true});}
 function knownRoleKeys(profile){return [...new Set([...builtinRoles.map(r=>r.id),...Object.keys(profile.modelRoles||{})])];}
 function roleInfo(role){return builtinRoles.find(r=>r.id===role);}
 function resetRole(role){
  if(state.saving||!roleInfo(role))return;
  const inherited=state.profile==='standard'?{}:original.standard;
  for(const [target,base] of [[p().modelRoles,inherited.modelRoles||{}],[p().retry.fallbackChains,inherited.retry?.fallbackChains||{}]]){
   if(Object.hasOwn(base,role))target[role]=copy(base[role]);else delete target[role];
  }
  delete modeSettings().overrides['role:'+role];state.picker=null;render();focusLane(role,'role');
 }
 function roleFallbacks(role,profile=p()){return profile.retry.fallbackChains[role]||(roleInfo(role)?.defaultFallbacks===false?[]:profile.retry.fallbackChains.default||[]);}
 function acceptsRoleModel(role,group,model){
  if(group==='pool'||group==='alternatives'&&role==='profile')return true;
  const id=group==='vibe'?(aliasRole(vibeAlias(role))||'task'):group==='alternatives'?role.split(':')[1]:role,info=roleInfo(id),kind=model.kind||'chat';
  return (info?.kinds||['chat']).includes(kind)&&(id!=='web'||kind!=='chat'||model.webSearch!=null);
 }
 const original={standard:copy(source.base),...Object.fromEntries(Object.entries(source.presets).map(([k,v])=>[k,merge(source.base,v)]))},profiles=copy(original),roleKeys=knownRoleKeys(source.base),profileKeys=Object.keys(original);
 const normalizeProfile=profile=>merge({modelRoles:{},retry:{fallbackChains:{}},task:{agentModelOverrides:{}}},profile);
 const storageKey=key=>'mana:'+source.source+':'+key;
 if(source.legacyDrafts){for(const [storage,key] of [[localStorage,'forge-view'],[sessionStorage,'forge-drafts'],[sessionStorage,'forge-pool-draft']]){try{const old=storage.getItem(key);if(old&&!storage.getItem(storageKey(key))){storage.setItem(storageKey(key),old);storage.removeItem(key);}}catch{}}}
 for(const [name,raw] of Object.entries(original)){const profile=original[name]=normalizeProfile(raw);profiles[name]=copy(profile);profile.forgeMode=copy(source.profileModes?.[name]?.settings||{mode:'deepseek',alternatives:[],overrides:{}});profiles[name].forgeMode=copy(profile.forgeMode);}
 function split(route){const m=String(route).match(/:(off|minimal|low|medium|high|xhigh|max|auto)$/);const raw=m?route.slice(0,-m[0].length):route;const slash=raw.indexOf('/');return {raw,provider:slash<0?'':raw.slice(0,slash),id:raw.slice(slash+1),effort:m?m[1]:''};}
 const referenced=new Set();for(const p of Object.values(original)){Object.values(p.modelRoles).forEach(x=>referenced.add(split(x).raw));Object.values(p.retry.fallbackChains).flat().forEach(x=>referenced.add(split(x).raw));}
 const referencedProviders=[...new Set([...referenced].map(x=>split(x).provider))];
 const catalogMap=new Map(source.models.map(m=>[m.provider+'/'+m.id,m]));for(const r of referenced){if(!catalogMap.has(r)){const q=split(r);catalogMap.set(r,{provider:q.provider,id:q.id,name:q.id,configuredOnly:true});}}
 const catalog=[...catalogMap.values()].sort((a,b)=>a.provider.localeCompare(b.provider)||a.name.localeCompare(b.name));
 const state={view:'profiles',profile:'standard',device:'desktop',role:roleKeys[0]||'',query:'',catalogQuery:'',catalogMode:'mine',catalogProvider:'all',page:0,favs:[...referenced].slice(0,8),picker:null,modal:null,changes:0,toast:''};
 let favWrites=Promise.resolve(),favSaved=[];
 let timer,drag=null,modalPageY=0,modalReturnFocus='',composing=false,renderCache=null,pointerHeld=false,nativeSelectBusy=false;
 let backgroundRefreshPending=false,backgroundReloading=false,pendingRender=false,backgroundTimer,writeEpoch=0,activeWrites=0,renderedAt=0;
 const pendingModeResults=new Map(),resetsSeen=new Set();
 // dataVersion names the current snapshot + catalogue; caches of derived per-model data are keyed by it.
 let dataVersion=0,localProviders=new Set(),deepSeekCatalog=false,catalogSource=null,catalogExtra=null,sourceRoutes=new Set();
 const priceMemo=new WeakMap(),searchMemo=new WeakMap();
 // Render bookkeeping: what the last patch left on screen (see render()).
 let surfaceWidth=win.clientWidth,renderedSteps=null,editingNodes=[];
 const storedDrafts={pools:null,drafts:null},SCREEN_PARTS='[data-screen],[data-knob]';
 const regions=createRegions(win);
 // The phone layout (device.css ≤ 760px): lanes turn vertical, the drawer steps aside after a CUT is chosen.
 const narrowSurface=()=>win.clientWidth<=760;
 // Folded runs of inherited lanes that the user opened; remembered locally (per browser).
 const openFolds=new Set((()=>{try{const v=JSON.parse(localStorage.getItem('mana-folds')||'[]');return Array.isArray(v)?v.filter(x=>typeof x==='string'):[];}catch{return [];}})());
 function storeFolds(){try{localStorage.setItem('mana-folds',JSON.stringify([...openFolds]));}catch{}}
 // Scroll an element to the middle of the page area that the drawer does not cover.
 function revealInPage(el){
  const r=el.getBoundingClientRect(),lip=parseFloat(getComputedStyle(win.querySelector('.tray-port')||document.documentElement).getPropertyValue('--lip'))||46;
  const covered=state.cuts?(win.querySelector('.tray')?.getBoundingClientRect().height||lip):lip,visible=window.innerHeight-covered;
  window.scrollBy({top:r.top-(visible-r.height)/2,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
 }
 // A patch key's target blinks its lane LED (class only; a re-render simply ends the blink).
 function flashLane(lane){lane.classList.remove('is-flash');void lane.offsetWidth;lane.classList.add('is-flash');setTimeout(()=>lane.classList.remove('is-flash'),1400);}
 const coarsePointer=()=>matchMedia('(pointer: coarse)').matches||narrowSurface();
 const scrollToControl=el=>el?.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
 function focusPicker(){const picker=win.querySelector('.picker');if(!picker)return;const target=state.picker?.actionsOnly?picker.querySelector('[data-action]:not(:disabled)'):coarsePointer()?picker.querySelector('.is-current,[data-pick]')||picker:picker.querySelector('#picker-search');target?.focus({preventScroll:true});}
 function trayFocusSelector(el){return el?.dataset.edit?`[data-edit="${CSS.escape(el.dataset.edit)}"][data-index="${el.dataset.index}"][data-group="${el.dataset.group}"]`:el?.dataset.modeScope?`[data-mode-scope="${CSS.escape(el.dataset.modeScope)}"]`:el?.dataset.poolOpen?'[data-pool-open]':'[data-action="mode-panel"]';}
 function editTray(kind,open,opener){
  if(open&&opener)state.trayReturnFocus=trayFocusSelector(opener);
  state.poolPanel=open&&kind==='pool';state.modePanel=open&&kind==='alternatives';state.picker=null;state.cutTarget=null;state.armedCut=null;render();
  if(open){const panel=win.querySelector(kind==='pool'?'#pool-editor':'#mode-alternatives');panel?.focus({preventScroll:true});scrollToControl(panel);}
  else [...win.querySelectorAll(state.trayReturnFocus||(kind==='pool'?'[data-pool-open]':'[data-action="mode-panel"]'))].find(el=>el.getClientRects().length)?.focus({preventScroll:true});
 }
 const editHistory=new ForgeHistory();
 const poolNames={'free-good':'FREE GOOD','free-fast':'FREE FAST'},poolToken=name=>'mana-pool/'+name,poolName=route=>Object.keys(poolNames).find(name=>poolToken(name)===route);
 let poolOriginal=copy(source.freePools||{'free-good':[],'free-fast':[]}),poolDraft=copy(poolOriginal),poolRevision=source.poolsRevision;
 const poolsDirty=()=>JSON.stringify(poolDraft)!==JSON.stringify(poolOriginal);
 function poolStep(direction){if(state.saving)return;const value=editHistory.step('@free-pools',direction);if(value){poolDraft=value;state.picker=null;render();win.querySelector('[data-action='+ (direction<0?'pool-undo':'pool-redo') +']')?.focus({preventScroll:true});}}
 async function savePools(){
  if(state.saving||!poolsDirty())return;state.saving=true;state.poolError='';render();
  try{await api('/api/free-pools',{revision:poolRevision,pools:poolDraft});poolOriginal=copy(poolDraft);editHistory.reset('@free-pools',poolDraft);await reload(false,true);notify('Спільні пули збережено · усі доріжки оновлено');}
  catch(e){state.poolError=e.message;}
  finally{state.saving=false;render();}
 }
 // Pool keys on the deck: a stack of tapes with the pool's name and size; dragging or arming moves the whole pool.
 function poolShelf(){
  const keys=Object.entries(poolNames).map(([name,label])=>{const n=source.freePools?.[name]?.length||0,armed=state.armedCut===poolToken(name);return `<button type="button" class="key poolkey" data-cut="${poolToken(name)}"${armed?' aria-pressed="true"':''} ${n?'':'disabled'} title="${label} · обери пул і місце на доріжці або перетягни весь пул" aria-label="${label} · ${n} CUTS · спільний пул"><span class="key__cap"><span class="stack${name==='free-fast'?' stack--fast':''}" aria-hidden="true"></span><span class="key__txt"><b>${label}</b><span class="key__sub"><span class="rd rd--l" style="--rd:2ch">${n}</span> CUTS</span></span></span></button>`;}).join('');
  return `${keys}<button type="button" class="key" data-pool-open="free-good" aria-expanded="${!!state.poolPanel}" aria-controls="pool-editor"><span class="key__cap">${led(state.poolPanel,'orange')}Пули · <span class="rd" style="--rd:1ch">2</span></span></button><span class="silk silk--2 deck__note">спільні для всіх профілів${poolsDirty()?' · є чернетка пулів':''}</span>`;
 }
 // Editors keep their place above the tape for now (stage C1b moves them into the drawer family); their CUTS
 // are the same CUT as on the lanes.
 function editorHead(title,tabs,tools){return `<div class="editor__head"><span class="silk silk--ink">${title}</span>${tabs}<span class="strip__grow"></span>${tools}</div>`;}
 function poolEditor(){
  if(!state.poolPanel)return '';const selected=state.poolTab||'free-good';
  const tabs=`<div class="keybed tray__tabs" role="group" aria-label="Обрати FREE пул">${Object.entries(poolNames).map(([name,label])=>`<button type="button" class="key key--sm" data-pool-tab="${name}" aria-pressed="${selected===name}" aria-controls="pool-line-${name}"><span class="key__cap">${led(selected===name,'green')}${label} · <span class="rd" style="--rd:2ch">${poolDraft[name].length}</span></span></button>`).join('')}</div>`;
  const tools=`${poolsDirty()?key('Скинути','pool-reset','key--sm',state.saving?'disabled':''):''}${key(SVG.close,'pool-close','key--sm key--sq tray__close','aria-label="Закрити налаштування пулів"')}`;
  return `<section class="bay editor editor--pool" id="pool-editor" aria-label="Спільні FREE пули" tabindex="-1">${editorHead('FREE пули',tabs,tools)}<p class="print print--hint editor__note">Спільні для всіх профілів · окреме збереження «Зберегти пули» оновить усі доріжки з цими блоками. Порядок: ⋯, перетягування або Shift + ← / →.</p>${state.poolError?`<div class="msg" data-s="bad" role="alert">${led(true,'red')}<span>${esc(state.poolError)}</span></div>`:''}${Object.entries(poolNames).map(([name,label])=>`<div class="cut-grid" id="pool-line-${name}" data-pool-line="${name}" aria-label="CUTS ${label}" ${selected===name?'':'hidden'}>${poolDraft[name].map((r,i)=>node(name,r,i,poolDraft[name].length,'pool')).join('')}${socketKey(name,poolDraft[name].length,'pool','CUT','Додати CUT у '+label)}</div>`).join('')}</section>`;
 }
 function poolBlock(role,route,i,group){
  const name=poolName(route),tag=group==='alternatives'?'li':'div',inherited=inheritedSlot(role,i,group),alias=group==='vibe'&&i===0&&vibeAlias(role)?vibeAlias(role)+' · ':'',more=slotActionKey(role,i,group),fast=name==='free-fast';
  const classes=['cut','cut--pool',fast&&'cut--pool-fast',more&&'cut--more',savedChain(role,group)[i]!==route&&!inherited&&'is-changed'].filter(Boolean).join(' ');
  return `<${tag} class="${classes}" data-clip-key="${clipKey(role,route,i,group)}" data-node-role="${esc(role)}" data-index="${i}" data-group="${group}"${inherited?' data-inherited="default"':''} style="--li:${laneIndex(role,group)}">${group==='pool'||group==='alternatives'?`<span class="cut__ord" aria-hidden="true">${String(i+1).padStart(2,'0')}</span>`:''}<span class="cut__edge"></span><button type="button" class="cut__name" data-edit="${esc(role)}" data-index="${i}" data-group="${group}" title="${esc(alias+poolNames[name]+(inherited?' · резерв успадковано з default':''))}" aria-label="Відкрити ${poolNames[name]}: спільний пул${inherited?' · успадковано з default':''}">${esc(alias)}${poolNames[name]}</button><span class="cut__meta"><span class="stack${fast?' stack--fast':''}" aria-hidden="true"></span><span>${source.freePools?.[name]?.length||0} CUTS · спільний</span></span>${more}</${tag}>`;
 }
 root.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b||state.saving)return;if(b.dataset.poolOpen)editTray('pool',!state.poolPanel,b);if(b.dataset.poolTab){state.poolTab=b.dataset.poolTab;state.picker=null;state.cutTarget=null;state.armedCut=null;render();win.querySelector(`[data-pool-tab="${b.dataset.poolTab}"]`)?.focus({preventScroll:true});}if(b.dataset.action==='pool-close')editTray('pool',false);if(b.dataset.action==='pool-save')savePools();if(b.dataset.action==='pool-reset'){try{await reload();poolOriginal=copy(source.freePools);poolDraft=copy(poolOriginal);poolRevision=source.poolsRevision;editHistory.reset('@free-pools',poolDraft);state.poolError='';render();}catch(error){state.poolError=error.message;render();}}if(b.dataset.action==='pool-undo'||b.dataset.action==='pool-redo')poolStep(b.dataset.action==='pool-undo'?-1:1);if(b.dataset.action==='replace-pool'){state.picker.actionsOnly=false;render();focusPicker();}});

 function clipKey(role,r,i,group){return esc(group+'|'+role+'|'+r+'|'+chain(role,group).slice(0,i).filter(v=>v===r).length);}
 function historyStep(direction){if(state.saving)return;const value=editHistory.step(state.profile,direction);if(!value)return;profiles[state.profile]=value;ForgeTape.intent(direction<0?'undo':'edit');state.picker=null;state.opFeedback=direction<0?'Останню дію скасовано.':'Дію повторено.';render();win.querySelector(`[data-action=${direction<0?'undo':'redo'}]`)?.focus({preventScroll:true});}
 function p(){return profiles[state.profile];}
 function workers(profile=p()){return [...new Set([...knownAgents().map(a=>a.id),...Object.keys(profile?.task?.agentModelOverrides||{})])];}
 function agentValues(worker,profile=p()){const value=profile.task?.agentModelOverrides?.[worker];return (Array.isArray(value)?value:[value]).filter(Boolean);}
 function agentLink(worker){const values=agentValues(worker);return values.length===1&&values[0].startsWith('@')?values[0]:'';}
 function agentTier(worker){return ({task:'Vibe GOOD',sonic:'Vibe FAST'})[worker]||'';}
 // An agent's lane key: ↳, native id and a printed sub-line (Vibe tier, file source, own list); LED blue = own list.
 function agentName(worker,own=false){const origin=agentSource(worker),sub=[agentTier(worker),origin&&origin+(agentInfo(worker)?.overrides?' · замінює штатного':''),own&&'власний список'].filter(Boolean).join(' · ');return `<span class="lane__label"><span class="lane__name">${esc(worker)}</span>${sub?`<span class="lane__sub">${esc(sub)}</span>`:''}</span>`;}
 function agentKey(worker,own=false,title=''){return `<div class="lane__key" title="${esc(title||worker)}"><span class="lane__idx" aria-hidden="true">↳</span>${agentName(worker,own)}${led(own,'blue',own?' title="Власний список агента"':'')}</div>`;}
 function agentRemove(worker){return !agentInfo(worker)&&Object.hasOwn(p().task.agentModelOverrides||{},worker)?key('Прибрати','','key--sm',`data-reset-agent="${esc(worker)}" aria-label="Прибрати перевизначення агента, якого немає у файлах: ${esc(worker)}" title="Агента немає серед штатних і файлів .omp/agents. Перевизначення лишилося в конфігурації."`):'';}
 // A patch key replaces the old «До ролі ↗» link: it scrolls to the role's lane and blinks its LED.
 function patchKey(role,label,aria){return `<button type="button" class="key patch" data-agent-role="${esc(role)}" aria-label="${esc(aria)}" title="${esc(aria)}"><span class="key__cap"><span class="jack" aria-hidden="true"></span>${esc(label)}</span></button>`;}
 function agentLinkedTrack(worker){
  const alias=agentLink(worker),[role,effort]=alias.slice(1).split(':'),known=roleKeys.includes(role),retry=p().retry?.modelFallback!==false;
  const detail=known?`Основна${retry?' й резерви ролі':' · резерви вимкнено'}${effort?' · thinking '+effort:''}`:'Модель і резерви визначає OMP';
  const link=known?patchKey(role,alias,worker+': успадковує '+alias+' · '+detail+'. Редагувати роль '+role):`<span class="chip" title="${esc('Успадковує '+alias)}">${esc(alias)}</span>`;
  const own=known&&!effort?key('Власний список','','key--sm',`data-agent-copy="${esc(worker)}" aria-label="Створити власний список: ${esc(worker)}" title="Копіювати роль для окремого монтажу агента. Зміни ролі більше не впливатимуть на цей список."`):'';
  const reset=agentInfo(worker)?key('Типово в OMP','','key--sm',`data-reset-agent="${esc(worker)}" aria-label="Повернути типовий вибір OMP для агента: ${esc(worker)}"`):agentRemove(worker);
  return `<div class="lane lane--inherit lane--link" data-agent="${esc(worker)}">${agentKey(worker,false,worker+' · успадковує '+alias)}<div class="lane__groove">${link}<span class="lane__note"><b>Успадковує ${esc(alias)}</b> · ${esc(detail)}</span><span class="lane__tools">${own}${reset}</span></div></div>`;
 }
 function agentListNote(worker){const values=agentValues(worker),alias=vibeAlias(worker),single=values.length===1&&!poolName(values[0]);return `Власний список${alias?' · основна з '+alias:''}${single&&!alias?' · резерви з default':' · CUTS за порядком'}${p().retry?.modelFallback===false?' · резерви вимкнено':''}`;}
 function agentDefaultTrack(worker){
  const info=agentInfo(worker),alias=agentModelAlias(info),role=alias.slice(1).split(':')[0],known=roleKeys.includes(role);
  const model=isCustomAgent(info)&&!info.model?'модель сесії':agentModelText(info)||'обрати CUT';
  const note=`<span class="lane__note" title="${esc(info?.description||'')}">${esc(shortText(info?.description||'Модель визначає OMP',140))}${isCustomAgent(info)?' · '+esc(agentModelText(info)):''}</span>`;
  return `<div class="lane lane--inherit" data-agent-default="${esc(worker)}">${agentKey(worker,false,(info?.description||worker)+' · '+(agentModelText(info)||'Модель визначає OMP'))}<div class="lane__groove"><div class="leader" title="${esc((info?.description?info.description+' · ':'')+(agentModelText(info)||'Модель визначає OMP'))}"><b>Типово в OMP</b><small>· ${esc(model)}</small></div>${known?patchKey(role,alias.split(':')[0],worker+': редагувати роль '+role):''}${note}${socketKey(worker,0,'vibe','кандидат','Обрати CUT для агента: '+worker)}</div></div>`;
 }
 // «Агенти»: a printed subhead on the bed; the sync option is a latching key with an LED, not a web checkbox.
 function agentSectionHead(){const warn=source.agentWarnings?.length;return `<div class="subhead"><span class="silk">Агенти</span><span class="print">прив’язки до ролей або власні списки</span>${warn?`<span class="chip chip--warn" role="status" title="${esc(source.agentWarnings.join('\n'))}">пропущено файлів агентів: ${warn}</span>`:''}<span class="subhead__rule"></span><button type="button" class="key key--sm" data-sync-vibe aria-pressed="${!!state.syncVibe}" title="Після зміни резервів ролі оновлює власні списки агентів із початковим @role, які до зміни точно повторювали ці резерви. Списки з власними CUTS не змінюються. Успадковані ролі оновлюються завжди. Увімкнення саме по собі не змінює списків."><span class="key__cap">${led(state.syncVibe,'green')}Копіювати резерви після змін ролей</span></button></div>`;}
 // A patch key scrolls the role's lane into the page area above the drawer and blinks its LED.
 function focusAgentRole(role){
  state.role=role;state.picker=null;const fold=foldOf(role);if(fold&&!openFolds.has(fold)){openFolds.add(fold);storeFolds();}
  render();store();
  const lane=win.querySelector(`.lane[data-role="${CSS.escape(role)}"]`),target=lane?.querySelector('.lane__key');
  target?.focus({preventScroll:true});if(lane){revealInPage(lane);flashLane(lane);}
 }
 function copyAgentRole(worker){
  if(state.saving)return;
  const role=agentLink(worker).slice(1);if(!roleKeys.includes(role))return;
  if(projectionPending()){notify('Дочекайся актуального перегляду замін DeepSeek перед копіюванням.');return;}
  const list=baseChain(role),count=values=>values.reduce((n,r)=>n+(poolName(r)?source.freePools?.[poolName(r)]?.length||0:1),0),counts=[count(list),count(chain(role))];
  if(!list.length){notify('Для цієї ролі модель визначає OMP. Спочатку обери основний CUT або залиш успадкування.');return;}
  if(list.length>30||chain(role).length>30){notify('У власному списку агента може бути до 30 CUTS. Скороти роль або залиш успадкування.');return;}
  if(counts.includes(1)&&p().retry?.fallbackChains?.default?.length){notify('Для одного CUT у власному списку OMP додасть резерви default. Щоб зберегти поточну поведінку, залиш прив’язку або спочатку додай резерв до ролі.');return;}
  state.poolPanel=false;state.armedCut=null;state.cutTarget=null;
  p().task.agentModelOverrides[worker]=list;
  const overrides=modeSettings().overrides;if(overrides['role:'+role])overrides['vibe:'+worker]=copy(overrides['role:'+role]);else delete overrides['vibe:'+worker];
  state.picker=null;state.opFeedback='Власний список '+worker+' скопійовано з @'+role+'. Роль не змінена. Можна скасувати ↶.';render();
  const target=[...win.querySelectorAll(`[data-edit="${CSS.escape(worker)}"][data-group="vibe"]`)].find(el=>el.getClientRects().length);target?.focus({preventScroll:true});scrollToControl(target);
 }
 function isLocal(provider){return localProviders.has(provider);}
 // Profile modes are metadata. Only the server compiles native OMP routes.
 function modeSettings(name=state.profile){return profiles[name].forgeMode;}
 function modeOff(){return modeSettings().mode==='no-deepseek';}
 function deepseek(value){return ManaOperator.isPaidDeepSeek(value,catalogMap.get(split(value).raw));}
 function modeList(key){const s=modeSettings();return [...(key==='profile'?s.alternatives:s.overrides[key]??s.alternatives)];}
 function modeBody(name=state.profile){return {profile:name,revision:source.revisions[name],changes:diff(name).filter(c=>!c.path[0].startsWith('forge')),modeSettings:copy(modeSettings(name))};}
 function modeKey(name=state.profile){if(renderCache?.keys.has(name))return renderCache.keys.get(name);const key=JSON.stringify([modeBody(name),state.modeRefresh?.[name]||0]);renderCache?.keys.set(name,key);return key;}
 function activePlan(){const row=state.modePlans?.[state.profile];return row?.key===modeKey()?row:null;}
 function modeView(role,group='role'){
  if(!modeOff()||group==='alternatives'||group==='pool')return null;
  const plan=activePlan();
  if(plan?.data)return plan.data.views[group]?.[role];
  if(plan?.pending&&plan.previous)return plan.previous.views?.[group]?.[role];
  if(!diff(state.profile).length)return source.profileModes?.[state.profile]?.views?.[group]?.[role];
  return null;
 }
 function modeRef(role,index,group){const view=modeView(role,group);return view?.refs[index];}
 function temporarySlot(role,index,group){const view=modeView(role,group);return modeRef(role,index,group)?.kind==='replacement'||index===0&&view?.substituted;}
 function modeScope(role,group){return group==='vibe'&&vibeAlias(role)?'role:'+aliasRole(vibeAlias(role)):group+':'+role;}
 function chain(role,group='role'){
  if(group==='pool')return [...poolDraft[role]];
  if(group==='alternatives')return modeList(role);
  return [...(modeView(role,group)?.routes||baseChain(role,group))];
 }
 function ensureModePreview(){
  if(!diff(state.profile).length&&!state.modePanel&&!state.modeRefresh?.[state.profile])return;
  const name=state.profile,key=modeKey(name);state.modePlans??={};
  if(state.modePlans[name]?.key===key)return;
  const pending={key,pending:true,previous:state.modePlans[name]?.data||state.modePlans[name]?.previous||source.profileModes?.[name]};state.modePlans[name]=pending;
  const body=modeBody(name);
  // Let the current render finish before a response can repaint it.
  Promise.resolve().then(async()=>{
   let result;
   try{result={key,data:await api('/api/profile-preview',body)};}
   catch(e){result={key,error:e.message};}
   if(state.modePlans[name]!==pending)return;
   if(interactionBusy(true)){pendingModeResults.set(name,result);scheduleBackgroundWork();return;}
   state.modePlans[name]=result;
   if(state.profile===name)render();
  });
 }
 function modeStatus(raw){const plan=activePlan();return (plan?.data||(plan?.pending?plan.previous:null))?.statuses?.[raw]||{status:'unknown',reason:'Немає свіжого ліміту'};}
 function modeTag(role,group='role'){
  const v=modeView(role,group);if(!v?.paused?.length&&!v?.substituted)return '';
  const scope=modeScope(role,group),count=v.paused.length;
  return `<button type="button" class="key key--sm lane__mode" aria-label="Заміни DeepSeek: ${esc(role)}" data-mode-scope="${esc(scope)}" title="${esc(v.substituted?'Замість '+v.original:count+' входжень DeepSeek призупинено')}"><span class="key__cap">${v.substituted?'⇄':'−'+count}</span></button>`;
 }
 // Tariff 24 h inside the DeepSeek glass. Ticks follow local hours (also in half-hour time zones); the bars follow
 // the UTC tariff hours, positioned on the same axis: height = price (peak is tall and hatched), not only hue.
 function tariffTimeline(now=Date.now()){
  const hour=3600000,localStart=new Date(now);localStart.setMinutes(0,0,0);
  const start=localStart.getTime()-(localStart.getHours()%4+4)*hour;
  const peak=at=>{const d=new Date(at);return d.getUTCDay()>0&&d.getUTCDay()<6&&((d.getUTCHours()>=1&&d.getUTCHours()<4)||(d.getUTCHours()>=6&&d.getUTCHours()<10));};
  const current=peak(now);let next=(Math.floor(now/hour)+1)*hour;while(peak(next)===current)next+=hour;
  const hours=Math.min(72,Math.max(24,Math.ceil((next-start+12*hour)/(24*hour))*24)),end=start+hours*hour,span=end-start,pct=v=>+(v*100).toFixed(4);
  const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone,clockFormat=dateFormat({hour:'2-digit',minute:'2-digit',timeZone}),dayFormat=dateFormat({weekday:'short',day:'numeric',timeZone});
  const clock=at=>clockFormat.format(at),day=at=>dayFormat.format(at);
  const duration=resetCountdown(next,now).replace(/^↻ /,''),text=current?'До сприятливого':'Сприятливе ще',step=hours===24?4:hours===48?8:12;
  const bars=[];for(let t=Math.floor(start/hour)*hour;t<end;t+=hour){const from=Math.max(t,start),to=Math.min(t+hour,end),p=peak(t);bars.push(`<i class="${p?'pk':''}${to<=now?' past':''}" style="--l:${pct((from-start)/span)}%;--w:${pct((to-from)/span)}%" title="${esc(day(from)+' '+clock(from)+' — '+clock(to)+(p?' · дороге вікно':' · сприятливе вікно'))}"></i>`);}
  const ticks=Array.from({length:hours/step+1},(_,i)=>{const at=start+i*step*hour;return `<span style="left:${pct(i*step/hours)}%">${clock(at).slice(0,2)}</span>`;}).join('');
  const label=`DeepSeek: ${text} ${duration}. Сприятливі та дорогі часові вікна за тарифом DeepSeek, ${hours} годин, місцевий час.`;
  return `<div class="tariff" role="img" aria-label="${esc(label)}" title="${esc(`Тариф DeepSeek · ${hours} год · ${timeZone} · ${current?'сприятливе':'дороге'} з ${day(next)} ${clock(next)}. ${source.tariff?.note||''} Для тарифів DeepSeek з погодинними вікнами; конкретна ціна залежить від моделі та провайдера.`)}"><div class="tariff__head"><span><span class="tariff__dot${current?' is-peak':''}"></span>${text} <b>${esc(duration)}</b></span><span class="g-hint">▨ пік</span></div><div class="tariff__plot"><div class="tariff__bars">${bars.join('')}</div><span class="tariff__now" style="--x:${(pct((now-start)/span)/100).toFixed(4)}" title="зараз ${clock(now)}"></span></div><div class="tariff__axis">${ticks}</div></div>`;
 }
 // The axis changes once a minute: rendered at whole minutes and reused, so an unchanged tariff is not repainted.
 function tariffMarkup(now=Date.now()){const minute=Math.floor(now/60000)*60000;if(tariffMarkup.key!==minute){tariffMarkup.key=minute;tariffMarkup.html=tariffTimeline(minute);}return tariffMarkup.html;}
 // The DeepSeek line on its glass: one reserved row for the mode's save state, a pending preview or a blocker.
 function modeMessage(){
  const plan=activePlan(),issues=plan?.data?.issues||[],dirty=diff(state.profile).length>0;
  const [s,text,title]=plan?.error?['bad',plan.error,plan.error]:issues.length?['bad',issues.map(i=>i.key.replace('role:','')+': '+i.message)[0]+(issues.length>1?' · ще '+(issues.length-1):''),issues.map(i=>i.key.replace('role:','')+': '+i.message).join('\n')]:plan?.pending?['warn','Розрахунок замін…','']:dirty?['warn','Режим ще не збережено','Збереження застосовується до нових запусків OMP']:['ok','Режим збережено',''];
  return `<div class="g-msg" data-s="${s}" role="status"${title?` title="${esc(title)}"`:''}><span>${esc(text)}</span></div>`;
 }
 const SLIDE_FACE='<span class="slide__lab slide__lab--off" aria-hidden="true">OFF</span><span class="slide__slot" aria-hidden="true"><span class="slide__tab"></span></span><span class="slide__lab slide__lab--on" aria-hidden="true">ON</span>';
 // The DeepSeek chin: the slide switch flips attributes only (its tab slides), the keys and the hue encoder stay put.
 function modeChin(id){
  const settings=modeSettings();
  return [box('p/mode-slide',`<button type="button" class="slide" role="switch" data-profile-mode="${modeOff()?'deepseek':'no-deepseek'}" aria-checked="${!modeOff()}" aria-label="DeepSeek у профілі: ON — оригінал, OFF — заміни" title="${modeOff()?'Увімкнути DeepSeek · повернути на доріжки':'Вимкнути платний DeepSeek · FREE CUTS залишаються'}" ${state.saving?'disabled':''}>`,[leaf('p/mode-slide/face',SLIDE_FACE)]),
   leaf('p/mode-keys',`<button type="button" class="key" data-action="mode-panel" aria-expanded="${!!state.modePanel}" aria-controls="mode-alternatives" title="Заміни DeepSeek · ${settings.alternatives.length} CUTS"><span class="key__cap">${led(modeOff(),'amber')}Заміни · <span class="rd" style="--rd:2ch">${settings.alternatives.length}</span></span></button>${key(SVG.refresh,'mode-refresh','key--sq','aria-label="Перевірити доступність і оновити заміни" title="Перевірити доступність і оновити заміни"'+(modeOff()?'':' disabled'))}`),
   leaf(id+'/grow','<span class="strip__grow"></span>'),leaf(id+'/enc',hueEncoder(id,'DeepSeek',SCREEN_HUE.ds))];
 }
 // Problems that are not the DeepSeek mode's own line: preview blockers without a DeepSeek screen, outside edits
 // of profile files (with «Прийняти файл»), skipped presets and an interrupted save journal.
 function deckNotices(dsScreen){
  const plan=activePlan(),issues=plan?.data?.issues||[],rows=[];
  const line=(s,c,text,title='',tools='')=>`<div class="msg" data-s="${s}" role="${s==='bad'?'alert':'status'}"${title?` title="${esc(title)}"`:''}>${led(true,c)}<span>${text}</span>${tools}</div>`;
  if(!dsScreen&&plan?.error)rows.push(line('bad','red',esc(plan.error)));
  if(!dsScreen&&issues.length)rows.push(line('bad','red',esc(issues.map(i=>i.key.replace('role:','')+': '+i.message).join(' · '))));
  if(source.modeRecovery)rows.push(line('bad','red',esc(source.modeRecovery.error||'Незавершене збереження режимів'),(source.modeRecovery.files||[]).join('\n')));
  for(const name of source.modeConflicts||[])rows.push(line('bad','red',`Файл профілю <b>${esc(prettyProfile(name))}</b> змінено поза Mana Tape · збереження заблоковане, оригінал не перезаписується`,'Прийняти файл як є: режим DeepSeek стане ON, збережені заміни лишаться для наступного OFF. Попередня версія доступна через «Попереднє збереження».',key('Прийняти файл','adopt-profile','key--sm',`data-adopt="${esc(name)}"`)));
  for(const name of source.modeOrphans||[])rows.push(line('warn','amber',`Файл профілю <b>${esc(prettyProfile(name))}</b> видалено поза Mana Tape · запис режиму лишився`,'Прийняти видалення: Mana Tape забуде запис режиму цього профілю (його копія лишиться в резервних).',key('Прийняти видалення','adopt-profile','key--sm',`data-adopt="${esc(name)}"`)));
  if(source.profileWarnings?.length)rows.push(line('warn','amber',`Пропущено пресети: ${esc(source.profileWarnings.map(w=>w.split(':')[0]).join(', '))}`,source.profileWarnings.join('\n')));
  return rows.length?`<div class="deck__notices">${rows.join('')}</div>`:'';
 }
 function alternativeCut(key,route,i){return node(key,route,i,modeList(key).length,'alternatives');}

 function modePanel(){
  const key=state.modeScope||'profile',settings=modeSettings(),list=modeList(key),own=key!=='profile'&&Object.hasOwn(settings.overrides,key);
  const scopes=[['profile','Увесь профіль'],...roleKeys.map(r=>['role:'+r,r+' · '+(labels[r]||r)]),...workers().map(w=>['vibe:'+w,'Агент '+w])];
  const alias=key.startsWith('vibe:')?vibeAlias(key.slice(5)):'';
  const plan=activePlan(),preview=plan?.data||(plan?.pending?plan.previous:null);
  const skipped=(preview?.skipped||[]).filter(x=>key==='profile'||x.key===key),uniqueSkipped=[...new Map(skipped.map(x=>[x.route+'|'+x.reason,x])).values()];
  const scope=`<div class="sel sel--sm"><label class="silk" for="mode-scope">Для</label><div class="sel__win"><select id="mode-scope">${scopes.map(([k,t])=>`<option value="${esc(k)}" ${key===k?'selected':''}>${esc(t)}${Object.hasOwn(settings.overrides,k)?' · власні':''}</option>`).join('')}</select><span class="sel__chev"></span></div></div><span class="print print--hint">${key==='profile'?'спільний порядок':own?'власний порядок':'порядок профілю'}</span>`;
  const tools=`${own?`<button type="button" class="key key--sm" data-action="mode-reset-scope"><span class="key__cap">Як у профілі</span></button>`:''}<button type="button" class="key key--sm key--sq tray__close" data-action="mode-close" aria-label="Закрити налаштування замін"><span class="key__cap">${SVG.close}</span></button>`;
  return `<section class="bay editor editor--mode" id="mode-alternatives" aria-label="Заміни DeepSeek" tabindex="-1">${editorHead('Заміни DeepSeek',scope,tools)}
   <p class="print print--hint editor__note">OFF: цей список стає на місце першого платного DeepSeek у доріжці. FREE CUTS залишаються. ON повертає платний DeepSeek. Ліміти не впливають на заміни. Дублікати й несумісні CUTS пропускаються.${alias?' Агент бере основну модель з '+esc(alias)+'. Заміни налаштовуються в цій ролі.':''}</p>
   ${alias?`<button type="button" class="key" data-action="mode-alias-scope" data-alias-scope="role:${esc(alias.slice(1))}"><span class="key__cap">Заміни для ${esc(alias)}</span></button>`:`<ol class="cut-grid" aria-label="Пріоритет CUTS замін">${list.map((route,i)=>alternativeCut(key,route,i)).join('')}${list.length>=12?'':socketKey(key,list.length,'alternatives','CUT','Додати CUT у заміни')}</ol><p class="print print--hint editor__note">${list.length?'Порядок: ⋯, перетягування або Shift + ← / →.':'Додай CUTS для режиму без DeepSeek.'} Звичайні резерви — після замін.</p>`}
   <details class="editor__skipped" ${uniqueSkipped.length?'':'inert aria-hidden="true" style="visibility:hidden"'}><summary class="msg" data-s="warn">${led(true,'amber')}<span>Пропущено під час розрахунку · ${uniqueSkipped.length}</span></summary>${uniqueSkipped.map(x=>`<p class="print print--hint">${esc(cutTitle(x.route))} · ${esc(providerName(split(x.route).provider))} — ${esc(x.reason)}</p>`).join('')}</details>
  </section>`;
 }
 root.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b||state.saving)return;
  if(b.dataset.profileMode){state.poolPanel=false;modeSettings().mode=b.dataset.profileMode;state.picker=null;render();return;}
  if(b.dataset.modeScope){state.modeScope=b.dataset.modeScope;editTray('alternatives',true,b);return;}
  const a=b.dataset.action;
  if(a==='mode-panel'){state.modeScope='profile';editTray('alternatives',!state.modePanel,b);}
  if(a==='mode-close')editTray('alternatives',false);
  if(a==='mode-alias-scope'){state.modeScope=b.dataset.aliasScope;render();}
  if(a==='mode-reset-scope'){delete modeSettings().overrides[state.modeScope];render();}
  if(a==='mode-refresh'){state.modeRefresh={...state.modeRefresh,[state.profile]:(state.modeRefresh?.[state.profile]||0)+1};render();}
  if(a==='make-permanent'){
   const x=state.picker,route=chain(x.role,x.group)[x.index],scope=modeScope(x.role,x.group);
   // An agent never rewrites its @role: the replacement becomes the agent's own primary.
   if(x.group==='vibe'){const values=agentValues(x.role);values[0]=route;p().task.agentModelOverrides[x.role]=values;if(scope==='vibe:'+x.role)delete modeSettings().overrides[scope];closePicker();notify('Тепер це постійна основна модель агента '+x.role+'. Роль не змінена.');return;}
   const role=scope.slice(scope.indexOf(':')+1),normal=baseChain(role);normal[0]=route;oldSetChain(role,normal);delete modeSettings().overrides[scope];closePicker();notify('Тепер це постійна основна модель профілю');
  }
 });
 root.addEventListener('change',e=>{if(e.target.id==='mode-scope'){state.modeScope=e.target.value;render();}});

 function short(id){return String(id).replaceAll('-',' ');}
 function cutTitle(route){const m=split(route);return ManaOperator.displayModelName(m.id,catalogMap.get(m.raw)?.name);}
 function deletedCut(route){return catalogMap.get(split(route).raw)?.status==='missing';}
 function cutIdentity(route,compact=false){const m=split(route),name=providerName(m.provider);return `${deletedCut(route)?'<span class="cut-deleted" title="Відсутній у провайдера" aria-label="DELETED — відсутній у провайдера">DELETED</span>':''}<span class="cut-provider ${compact?'provider-code':''}" title="${esc(name)}">${esc(compact?providerCode(m.provider):name)}</span>${deletedCut(route)?'':freeBadge(route)}`;}
 function aliasRole(alias){return String(alias||'').slice(1).split(':')[0];}
 // `@role` and `@role:effort` follow the role's primary; an unknown role stays visible as written.
 function resolveAlias(value,profile=p()){if(typeof value!=='string'||!value.startsWith('@'))return value;const [role,effort]=value.slice(1).split(':'),route=profile.modelRoles?.[role];return !route?value:effort&&!poolName(route)?split(route).raw+':'+effort:route;}
 function baseChain(role,group='role'){if(group==='vibe')return agentValues(role).map(s=>resolveAlias(s));return p().modelRoles[role]?[p().modelRoles[role],...roleFallbacks(role)]:[];}
 function vibeAlias(worker){const v=p().task.agentModelOverrides[worker],head=Array.isArray(v)?v[0]:v;return typeof head==='string'&&head.startsWith('@')?head:'';}
 // Fallbacks inherited from `default` are drawn on the lane but are not its own chain.
 function inheritsDefault(role,profile=p()){return role!=='default'&&!!profile.modelRoles[role]&&!Object.hasOwn(profile.retry.fallbackChains,role)&&roleInfo(role)?.defaultFallbacks!==false&&!!profile.retry.fallbackChains.default?.length;}
 function inheritedSlot(role,index,group='role'){if(group!=='role'||index<1||!inheritsDefault(role))return false;const view=modeView(role,group),ref=view?.refs?.[index];return view?.refs?ref?.kind==='base'&&ref.index>=1:true;}
 function oldSetChain(role,list,group='role'){if(group==='vibe'){writeAgent(role,agentFromResolved(role,list));return;}const configured=!!p().modelRoles[role],tail=list.slice(1),before=roleFallbacks(role);p().modelRoles[role]=list[0];if((configured||tail.length)&&JSON.stringify(tail)!==JSON.stringify(before))p().retry.fallbackChains[role]=tail;}
 // An agent edit never rewrites a role: every @role keeps its place among the agent's own CUTS.
 function agentFromResolved(worker,list){
  const raw=agentValues(worker),out=[...list],taken=new Set();
  raw.forEach((value,j)=>{
   if(!value.startsWith('@'))return;
   const route=resolveAlias(value),at=out.findIndex((r,k)=>!taken.has(k)&&r===route);
   if(at>=0){out[at]=value;taken.add(at);}
   else if(list.length>=raw.length)chainNotes.push(value+' у '+worker+' замінено власним CUT; роль не змінена');
  });
  return out;
 }
 function writeAgent(worker,values){
  const before=agentValues(worker);p().task.agentModelOverrides[worker]=values;
  if(values.length===1&&values[0].startsWith('@')&&!(before.length===1&&before[0]===values[0]))chainNotes.push(worker+' тепер успадковує '+values[0]+' разом із резервами ролі');
 }
 function options(value,raw){const m=catalogMap.get(raw);const levels=Array.isArray(m?.thinking)&&m.thinking.length?['',...new Set(['off',...m.thinking])]:m?.reasoning===false?['','off']:['','off','minimal','low','medium','high','xhigh','max'];if(value&&!levels.includes(value))levels.push(value);return levels.map(e=>`<option value="${esc(e)}" ${e===value?'selected':''}>${esc(e||'типово')}</option>`).join('');}
 // Thinking on the tape: a small detented selector (24px target); omitted where the role has no thinking.
 function thinkSelect(m,role,i,group,label){const id=group==='alternatives'&&String(role).startsWith('role:')?role.slice(5):role;if(group!=='vibe'&&group!=='pool'&&roleInfo(id)?.thinking===false)return '';return `<select class="cut__think" data-effort-role="${esc(role)}" data-index="${i}" data-group="${group}" aria-label="${esc(label)}" title="Thinking · ${esc(m.effort||'типово')}">${options(m.effort,m.raw)}</select>`;}
 function profileOptions(){return profileKeys.map(k=>`<option value="${esc(k)}" ${k===state.profile?'selected':''}>${esc(prettyProfile(k))}</option>`).join('');}
 function providerName(id){return providerNames[id]||source.providers.find(v=>v.id===id)?.name||id;}
 function routeMatches(route){const m=split(route),model=catalogMap.get(m.raw);return !!state.query.trim()&&matchesQuery(state.query,m.id,model?.name,short(m.id));}
 function freeBadge(route){const m=catalogMap.get(split(route).raw);return m&&priceInfo(m).kind==='free'?'<span class="cut-free" aria-label="Безкоштовний CUT" title="Безкоштовний маршрут. Ліміти провайдера можуть діяти.">FREE</span>':'';}
 function slotClasses(route){return (isLocal(split(route).provider)?' gpu-slot':'')+(routeMatches(route)?' model-match':'')+(deletedCut(route)?' cut-is-deleted':'');}
 // Per-snapshot derived data: keyed by dataVersion (bumped by rebuild()), so a new snapshot or catalogue
 // never meets an old value and nothing has to be invalidated by hand.
 function priceInfo(m){const memo=priceMemo.get(m);if(memo?.version===dataVersion)return memo.info;const info=priceFor(m);priceMemo.set(m,{version:dataVersion,info});return info;}
 function searchKey(m){let key=searchMemo.get(m);if(key?.version!==dataVersion){const provider=providerName(m.provider);key={version:dataVersion,cut:searchText([m.name,m.id,provider].join(' ')),pick:searchText([m.name,m.id,m.provider,provider].join(' '))};searchMemo.set(m,key);}return key;}
 function priceFor(m){
  if(isLocal(m.provider))return {kind:'local',label:'GPU · локально'};
  const c=m.cost,known=Number.isFinite(c?.input)&&Number.isFinite(c?.output),subscription=(source.insights?.usage?.reports||[]).some(r=>r.provider===m.provider)||m.provider==='commandcode';
  const zero=known&&c.input===0&&c.output===0&&!c.cacheRead&&!c.cacheWrite;
  if(ManaOperator.isFreeModel(m))return {kind:'free',label:'Безкоштовно'};
  if(zero)return {kind:'unknown',label:'Тариф не надано',subscription};
  return {kind:subscription?'subscription':known?'paid':'unknown',label:known?numberFormat('en-US',{maximumFractionDigits:6}).format(c.input)+' / '+numberFormat('en-US',{maximumFractionDigits:6}).format(c.output):'Ціна невідома',subscription,variable:!!c?.timeBased};
 }
 function priceMarkup(m){const price=priceInfo(m);return `<span class="model-price ${price.kind}" title="${price.kind==='local'?'Власний GPU':price.kind==='free'?'Безкоштовний маршрут із нульовим тарифом у каталозі':price.kind==='unknown'?'Каталог не містить підтвердженого тарифу; нуль може означати невідому ціну':'Вхід / вихід · USD за 1 млн токенів. Для підписки це довідковий API-тариф.'}">${esc(price.label)}</span>${price.subscription?'<small class="price-note">Підписка<span class="api-rate-note"> · API-тариф</span></small>':price.variable?'<small class="price-note">Змінний тариф</small>':''}`;}
 function savedChain(role,group='role'){
  if(group==='pool')return poolOriginal[role];
  if(group==='alternatives')return original[state.profile].forgeMode.overrides[role]||original[state.profile].forgeMode.alternatives;
  const profile=original[state.profile],view=profile.forgeMode?.mode==='no-deepseek'?source.profileModes?.[state.profile]?.views?.[group]?.[role]:null;
  if(view?.routes)return view.routes;
  if(group==='vibe'){const raw=profile.task.agentModelOverrides[role],list=Array.isArray(raw)?raw:[raw];return list.filter(Boolean).map(v=>resolveAlias(v,profile));}
  return profile.modelRoles[role]?[profile.modelRoles[role],...roleFallbacks(role,profile)]:[];
 }
 // Provider identity on the tape: the edge colour and the code chip. Local GPU, FREE-only and DeepSeek providers
 // have fixed identities; any other provider gets a stable slot from its id. The chip always prints the real code.
 function providerSlot(provider){
  if(isLocal(provider))return 'gpu';
  const memo=providerSlot.memo??=new Map(),k=dataVersion+'|'+provider;if(memo.has(k))return memo.get(k);
  const models=catalog.filter(m=>m.provider===provider),slots=['stu','cld','p5','p6','p7'];
  let slot=/deepseek/i.test(provider)?'ds':models.length&&models.every(m=>priceInfo(m).kind==='free')?'free':'';
  if(!slot){let h=0;for(const c of String(provider))h=(h*31+c.charCodeAt(0))>>>0;slot=slots[h%slots.length];}
  if(memo.size>400)memo.clear();memo.set(k,slot);return slot;
 }
 const HEALTH_VIEW={local:['gpu','◆'],healthy:['ok','●'],risk:['low','△'],empty:['zero','∅'],unknown:['unk','?'],unavailable:['off','⊘']};
 // HEALTH is drawn in every CUT; .health-off on the deck or drawer hides the glyph and the bar, never FREE.
 function healthMarks(route){
  if(poolName(route))return {glyph:'',bar:''};
  const h=opRouteHealth(route),[cls,glyph]=HEALTH_VIEW[h.kind]||HEALTH_VIEW.unknown,hp=h.remaining!=null?Math.max(.04,Math.min(1,h.remaining/100)):1;
  const title='HEALTH: '+h.label+(h.remaining!=null?' · залишок '+num(h.remaining)+'%':'');
  return {glyph:`<span class="hs hs--${cls}" title="${esc(title)}" aria-label="${esc(title)}">${glyph}</span>`,bar:`<span class="cut__hb hb--${cls}" style="--hp:${+hp.toFixed(3)}" aria-hidden="true"><i></i></span>`};
 }
 // Middle truncation: the distinguishing tail (01 Free, v3, 14B, :free) stays; the head takes the ellipsis.
 function nameParts(name){
  const text=String(name),words=text.split(' ');let tail=[];
  const marks=/^(?:v?\d[\w.]*|free|:free|pro|mini|max|lite|flash|turbo|preview|exp|latest|instruct|beta)$/i;
  while(words.length>1&&marks.test(words.at(-1))&&[...tail,words.at(-1)].join(' ').length<=12)tail.unshift(words.pop());
  if(tail.length)return [words.join(' '),' '+tail.join(' ')];
  const dash=text.match(/^(.{6,}?)(-(?:v?\d[\w.]*|free|pro|mini|max|lite|flash))$/i);
  return dash?[dash[1],dash[2]]:[text,''];
 }
 const nameMarkup=(name,prefix='')=>{const [head,tail]=nameParts(name);return `<span class="cut__head">${esc(prefix+head)}</span>${tail?`<span class="cut__tail">${esc(tail)}</span>`:''}`;};
 function freeRoute(route){const m=catalogMap.get(split(route).raw);return !!m&&priceInfo(m).kind==='free';}
 function laneIndex(role,group){const keys=group==='vibe'?workers():roleKeys;return Math.max(0,keys.indexOf(role));}
 // One CUT on every surface: lane, editors, drawer. A lane CUT is a container whose name is the <button data-edit>.
 function node(role,r,i,n,group='role'){
  if(poolName(r))return poolBlock(role,r,i,group);
  const m=split(r),before=savedChain(role,group)[i],sequence=group==='alternatives'||group==='pool',tag=group==='alternatives'?'li':'div';
  const replacement=temporarySlot(role,i,group),inherited=inheritedSlot(role,i,group),deleted=deletedCut(r),free=!deleted&&freeRoute(r),warn=!deleted&&routeWarning(m.raw);
  const more=slotActionKey(role,i,group),health=healthMarks(r),title=cutTitle(r),alias=group==='vibe'&&i===0&&vibeAlias(role)?vibeAlias(role)+' · ':'',provider=providerName(m.provider);
  const classes=['cut',free&&'cut--free',more&&'cut--more',deleted&&'cut--deleted',before!==r&&!inherited&&'is-changed',replacement&&'is-replaced',routeMatches(r)&&'is-match'].filter(Boolean).join(' ');
  const hint=r+(inherited?' · резерв успадковано з default':before!==r?(before?' · До зміни: '+before:' · Новий CUT'):'');
  const label=`Змінити CUT ${i+1}, ${group==='pool'?poolNames[role]:role}: ${alias}${title} · ${provider}${m.effort?' · thinking '+m.effort:''}${free?' · FREE':''}${inherited?' · успадковано з default':''}${deleted?' · DELETED — відсутній у провайдера':''}${replacement?' · заміна DeepSeek':''}`;
  return `<${tag} class="${classes}" data-p="${providerSlot(m.provider)}" data-clip-key="${clipKey(role,r,i,group)}" data-node-role="${esc(role)}" data-before="${esc(before!==r?before:'')}" data-index="${i}" data-group="${group}"${inherited?' data-inherited="default"':''} style="--li:${laneIndex(role,group)}"${group==='alternatives'?` title="${esc(modeStatus(m.raw).reason)}"`:''}>${sequence?`<span class="cut__ord" aria-hidden="true">${String(i+1).padStart(2,'0')}</span>`:''}<span class="cut__edge"></span><button type="button" class="cut__name cut__name--split" data-edit="${esc(role)}" data-index="${i}" data-group="${group}" title="${esc(alias+title+'\n'+hint)}" aria-label="${esc(label)}">${nameMarkup(title,alias)}</button><span class="cut__meta">${health.glyph}<b class="tag" data-p="${providerSlot(m.provider)}" title="${esc(provider)}">${esc(providerCode(m.provider))}</b>${thinkSelect(m,role,i,group,`Thinking: ${group==='pool'?poolNames[role]:role}, CUT ${i+1}`)}<span class="stamp stamp--repl cut__repl" title="Замість DeepSeek">⇄ заміна</span>${warn?'<span class="hs hs--low" title="Маршрут зараз недоступний: провайдер вимкнений або прострочений">!</span>':''}${deleted?'<span class="stamp stamp--del" title="Відсутній у провайдера">DELETED</span>':''}</span>${free?'<span class="stamp stamp--free" title="Безкоштовний маршрут. Ліміти провайдера можуть діяти.">FREE</span>':''}${more}${health.bar}</${tag}>`;
 }
 function stepCount(){
  if(renderCache?.steps!=null)return renderCache.steps;
  // Reserve the same columns for ON and OFF before the asynchronous preview arrives.
  const count=(role,group='role')=>{const base=baseChain(role,group),at=base.findIndex(deepseek),projected=at<0?base:[...base.slice(0,at),...modeList(modeScope(role,group)),...base.slice(at).filter(r=>!deepseek(r))];return Math.max(base.length,new Set(projected.map(r=>split(r).raw)).size,chain(role,group).length);};
  const steps=Math.max(8,1+Math.max(...roleKeys.map(r=>count(r)),...workers().map(r=>count(r,'vibe'))));if(renderCache)renderCache.steps=steps;return steps;
 }
 // A recessed jack for a new CUT; it glows while a CUT is dragged and stays pinned to the right of a long lane.
 function socketKey(role,index,group,word,label){return `<button type="button" class="socket" data-edit="${esc(role)}" data-index="${index}" data-group="${group}" aria-label="${esc(label)}" title="${esc(label)}"><span class="socket__plus" aria-hidden="true"></span>${esc(word)}</button>`;}
 function laneKey(role,index,own){
  const inheritsStandard=state.profile!=='standard'&&!Object.hasOwn(source.presets[state.profile]?.modelRoles||{},role)&&own;
  const title=inheritsStandard?'Основна модель успадкована зі Standard':role+' · '+(labels[role]||role)+(own?' · власні CUTS':' · типово в OMP');
  return `<button type="button" class="lane__key" data-focus-role="${esc(role)}"${role===state.role?' aria-current="true"':''} title="${esc(title)}" aria-label="${esc((labels[role]&&labels[role]!==role?role+' · '+labels[role]:role)+(own?'':' · типово в OMP'))}"><span class="lane__idx">${String(index+1).padStart(2,'0')}</span><span class="lane__name">${esc(role)}</span>${led(own,'green')}</button>`;
 }
 // A role lane: lane key, then the tape; an unconfigured role is leader tape («Типово в OMP»), not a CUT.
 function graphRow(role,index,group='role'){
  const list=chain(role,group),agent=group==='vibe',automatic=!agent&&!list.length;
  const keyHtml=agent?agentKey(role,true,role+' · '+agentListNote(role)+(agentInfo(role)?'':' · немає у файлах агентів')):laneKey(role,index,!automatic);
  const tape=automatic?`<div class="leader" title="Глобальні налаштування й автоматичний вибір OMP"><b>Типово в OMP</b><small>· обрати CUT</small></div>`:list.map((r,i)=>node(role,r,i,list.length,group)).join('');
  const word=agent?'кандидат':automatic?'основна':'резерв';
  return `<div class="lane${automatic?' lane--inherit':''}" data-role="${esc(role)}" data-lane-group="${group}">${keyHtml}<div class="lane__groove">${modeTag(role,group)}${tape}${agent?agentRemove(role):''}${socketKey(role,list.length,group,word,(agent?'Додати кандидата':automatic?'Обрати основний CUT':'Додати резерв')+': '+role)}</div></div>`;
 }
 function agentTrack(worker,i){return !agentValues(worker).length&&agentInfo(worker)?agentDefaultTrack(worker):agentLink(worker)?agentLinkedTrack(worker):graphRow(worker,i,'vibe');}
 function poolActionContext(){return state.view==='profiles'&&state.poolPanel;}
 // Transport on the drawer front: Undo / Redo / save state / Зберегти. The scope is printed when an editor owns it.
 function transportParts(){
  const pool=poolActionContext(),h=editHistory.available(pool?'@free-pools':state.profile),dirty=pool?poolsDirty():state.changes,scope=pool?'пули':state.view==='profiles'&&state.modePanel?'заміни':'';
  const plan=activePlan(),blocked=!pool&&(plan?.pending||plan?.error||plan?.data?.issues?.length||source.modeConflicts?.length||source.modeRecovery);
  const area=pool?'FREE пули':scope==='заміни'?'Заміни · профіль':'Профіль '+prettyProfile(state.profile);
  const text=state.saving?'Збереження…':dirty?(pool?'Пули змінено':dirty+' '+(dirty%10===1&&dirty%100!==11?'зміна':[2,3,4].includes(dirty%10)&&![12,13,14].includes(dirty%100)?'зміни':'змін')):'Збережено';
  const note=state.saving?'Записую файл':blocked&&dirty?(plan?.pending?'Чекає розрахунку замін':'Збереження заблоковане'):dirty?(pool?'Спільні пули · не збережено':'Котушка '+prettyProfile(state.profile)+' · не збережено'):'Для нових запусків OMP';
  return {pool,scope,
   scopeHtml:scope?`<span class="transport__scope">${scope}</span>`:'',
   undo:`<button type="button" class="key key--sq" data-action="${pool?'pool-undo':'undo'}" aria-label="Скасувати зміну: ${esc(area)}" title="Скасувати · ⌘/Ctrl Z" ${!h.undo||state.saving?'disabled':''}><span class="key__cap">${SVG.undo}</span></button>`,
   redo:`<button type="button" class="key key--sq" data-action="${pool?'pool-redo':'redo'}" aria-label="Повторити зміну: ${esc(area)}" title="Повторити · ⌘/Ctrl Shift Z" ${!h.redo||state.saving?'disabled':''}><span class="key__cap">${SVG.redo}</span></button>`,
   state:`<div class="transport__state" role="status" aria-live="polite" title="${esc(text+' · '+note)}"><b>${led(true,state.saving?'amber':dirty?(blocked?'red':'amber'):'green')}<span>${esc(text)}</span></b><small>${esc(note)}</small></div>`,
   save:`<button type="button" class="key key--action" data-action="${pool?'pool-save':'save'}" aria-label="${pool?'Зберегти пули':'Зберегти профіль '+esc(prettyProfile(state.profile))}" title="Зберегти · ⌘/Ctrl S" ${!dirty||state.saving||blocked?'disabled':''}><span class="key__cap">Зберегти</span></button>`};
 }
 function slotActionKey(role,index,group){return chain(role,group).length>1||group==='pool'||group==='alternatives'||poolName(chain(role,group)[index])||temporarySlot(role,index,group)?`<button type="button" class="cut__more" data-slot-actions="${esc(role)}" data-index="${index}" data-group="${group}" aria-haspopup="menu" aria-expanded="false" aria-label="Дії з CUT: ${esc(role)}, слот ${index+1}" title="Порядок / дії з CUT">⋯</button>`:'';}
 // Монтаж: one deck pocket. Tools (pool keys, Пули, search), notices, editors, ruler, the lanes (a run of
 // identical inherited lanes folds into one printed row), agents, legend. Each lane and each agent is its own
 // region, so an edit, Undo or a preview response replaces only the rows whose CUTS changed. HEALTH and search
 // only patch the deck's attributes and the rows whose marks changed.
 function profileView(){
  const pending=projectionPending(),ds=hasDeepSeekScreen();
  return [box('p/deck',deckOpen(),[
   box('p/tools','<div class="deck__tools">',[leaf('p/pools',poolShelf()),leaf('p/role-search',roleSearch())]),
   leaf('p/notices',deckNotices(ds)),
   leaf('p/pool-editor',poolEditor()),leaf('p/mode-panel',state.modePanel?modePanel():''),
   leaf('p/ruler',rulerMarkup()),
   box('p/body',`<div class="deck__body${pending?' is-pending':''}"${pending?' aria-busy="true"':''}>`,[laneGraph(),leaf('p/agents-head',agentSectionHead()),agentList()]),
   leaf('p/legend',legendMarkup())
  ])];
 }
 // The deck's and the drawer's opening tags carry HEALTH, search and armed states; flipping them patches attributes only.
 function deckOpen(){return `<section class="bay deck${state.health?'':' health-off'}${state.query.trim()?' is-searching':''}${state.armedCut?' is-armed':''}" id="profile-tracks" aria-label="Монтаж">`;}
 function trayOpen(){return `<section class="tray${state.cuts?' is-open':''}${state.armedCut?' is-armed':''}${state.health?'':' health-off'}" id="cuts-collection" aria-label="Колекція CUTS">`;}
 function roleSearch(){return `<label class="search">${SVG.search}<input id="role-query" type="search" value="${esc(state.query)}" placeholder="Підсвітити CUT на плівці" aria-label="Підсвітити CUT на плівці" autocomplete="off"></label>`;}
 function rulerMarkup(){const steps=Math.min(stepCount(),12);return `<div class="ruler" aria-hidden="true"><span class="silk">Доріжка / роль</span><div class="ruler__cols"><span>Основна</span>${Array.from({length:steps-1},(_,i)=>`<span>Резерв ${i+1}</span>`).join('')}</div></div>`;}
 // The printed legend at the bottom of the deck; HEALTH entries hide with the switch (CSS), so it never re-renders for it.
 function legendMarkup(){
  const hs=[['ok','●','запас'],['low','△','малий'],['zero','∅','нуль'],['unk','?','немає виміру'],['off','⊘','недоступна'],['gpu','◆','GPU']];
  return `<div class="legend"><span class="silk lg--h">HEALTH</span>${hs.map(([c,g,t])=>`<span class="lg lg--h"><span class="lg__sw hb--${c}"><i${c==='low'?' style="right:55%"':''}></i></span>${g} ${t}</span>`).join('')}<span class="lg lg--off">HEALTH вимкнено · чиста плівка</span><span class="seam seam--v"></span>${referencedProviders.map(v=>`<span class="lg"><b class="tag" data-p="${providerSlot(v)}">${esc(providerCode(v))}</b>${esc(providerName(v))}</span>`).join('')}<span class="seam seam--v"></span><span class="lg"><span class="lg__inh" aria-hidden="true"></span>резерв з default</span><span class="lg"><span class="stamp stamp--repl">⇄</span>заміна DeepSeek</span><span class="lg">${led(true,'blue')}власний список агента</span><span class="print lg__note">Збереження — для нових запусків OMP; активні сесії зберігають свої налаштування</span></div>`;
 }
 // Runs of three or more consecutive unconfigured lanes fold into one printed row («Показати N»); `default` never
 // folds. The open state is remembered locally per run.
 function laneGroups(){
  const out=[];let run=[];
  const flush=()=>{if(run.length>=3)out.push({fold:run});else for(const r of run)out.push({role:r});run=[];};
  for(const role of roleKeys){if(role!=='default'&&!chain(role).length)run.push(role);else{flush();out.push({role});}}
  flush();return out;
 }
 function foldOf(role){return laneGroups().find(g=>g.fold?.includes(role))?.fold[0]||'';}
 function laneGraph(){
  const children=[];
  for(const g of laneGroups()){
   if(g.role){children.push(leaf('p/row:'+g.role,graphRow(g.role,roleKeys.indexOf(g.role))));continue;}
   const first=g.fold[0],open=openFolds.has(first),from=roleKeys.indexOf(first)+1,to=from+g.fold.length-1,range=String(from).padStart(2,'0')+'–'+String(to).padStart(2,'0');
   children.push(leaf('p/fold:'+first,`<div class="fold"><button type="button" class="key key--wide" data-fold-toggle="${esc(first)}" aria-expanded="${open}" aria-controls="fold-${esc(first)}"><span class="key__cap"><span class="lane__idx">${range}</span>${open?'Сховати':'Показати'} <span class="rd" style="--rd:2ch">${g.fold.length}</span></span></button><div class="fold__print"><b>${g.fold.length} доріжок · типово в OMP</b><span>${g.fold.map(esc).join(' · ')}</span></div></div>`));
   children.push(box('p/foldlanes:'+first,`<div class="fold__lanes${open?' is-open':''}" id="fold-${esc(first)}">`,g.fold.map(r=>leaf('p/row:'+r,graphRow(r,roleKeys.indexOf(r))))));
  }
  return box('p/lanes','<div class="lanes">',children);
 }
 function agentList(){return box('p/agents','<div class="lanes lanes--agents">',workers().map((worker,i)=>leaf('p/agent:'+worker,agentTrack(worker,i))));}

 function myProviderIds(){
  // Native availability includes public routes; it is not proof of a subscription.
  const subscribed=new Set((source.insights?.usage?.reports||[]).map(r=>r.provider));
  return new Set(source.providers.filter(v=>v.custom||v.managed||v.used.length||subscribed.has(v.id)).map(v=>v.id));
 }
 function pickerModels(x){
  const mine=myProviderIds(),disabled=new Set(p().disabledProviders||[]);
  return catalog.filter(m=>acceptsRoleModel(x.role,x.group,m)&&(x.group!=='pool'||ManaOperator.isFreeModel(m))&&(x.group!=='alternatives'||!deepseek(m.provider+'/'+m.id))&&m.status!=='missing'&&!disabled.has(m.provider)&&!source.providers.find(v=>v.id===m.provider)?.expired&&(x.scope==='all'||mine.has(m.provider)));
 }
 function pickerRow(model,current=false){
  const x=state.picker,r=model.provider+'/'+model.id,used=chain(x.role,x.group).some(v=>split(v).raw===r);
  return `<button type="button" class="picker-row collection-cut cut-surface ${current?'is-current':''} ${deletedCut(r)?'cut-is-deleted':''} ${isLocal(model.provider)?'gpu-option':''}" data-pick="${esc(r)}" data-cut-route="${esc(r)}" data-health-route="${esc(r)}" aria-pressed="${current}" aria-label="${esc(cutTitle(r)+' · '+r)}" title="${esc(r)}"><span class="cut-hole" aria-hidden="true"></span><span class="picker-detail"><strong class="cut-title">${esc(cutTitle(r))}</strong><small class="cut-meta">${cutIdentity(r)}${current?' · Поточний CUT':used?' · На доріжці':''}${routeWarning(r)?' · Потребує уваги':''}</small></span>${isLocal(model.provider)?'<span class="gpu-badge">GPU</span>':''}</button>`;
 }

 // Picker: a CUT toolbar is one region; the chooser keeps its search field while only its results change.
 function pickerMarkup(){
  const x=state.picker;if(!x)return leaf('picker','');
  const list=chain(x.role,x.group),current=list[x.index];
  const head=`<div class="picker-top"><strong>${esc(x.group==='alternatives'?'Заміни · '+(x.role==='profile'?'профіль':x.role.split(':')[1]):x.group==='vibe'?'Агент '+(x.role):x.role)} · ${x.group==='alternatives'?x.index+1:x.index===0?'основна':'резерв '+x.index}</strong>${tool('×','picker-close','icon-only','aria-label="Закрити вибір"')}</div>`;
  if(x.actionsOnly){
   const sequence=x.group==='alternatives'||x.group==='pool',isPool=poolName(current),canRemove=sequence||x.index>0||isPool&&list.length>1,waiting=pickerActionsPending();
   return leaf('picker',`<section class="picker cut-tools" role="toolbar" tabindex="-1" aria-busy="${waiting}" aria-label="Дії з CUT ${x.index+1}: ${esc(x.role)}" style="top:${x.top}px;left:${x.left}px">${list.length>1?`<span class="cut-move-keys" role="group" aria-label="Порядок CUT"><button type="button" class="cut-key" data-action="move-node" data-direction="-1" ${waiting||x.index===0?'disabled':''} aria-label="Перемістити CUT раніше"><span aria-hidden="true">←</span><b>Раніше</b></button><button type="button" class="cut-key" data-action="move-node" data-direction="1" ${waiting||x.index===list.length-1?'disabled':''} aria-label="Перемістити CUT пізніше"><b>Пізніше</b><span aria-hidden="true">→</span></button></span>`:''}${!sequence&&temporarySlot(x.role,x.index,x.group)?'<button type="button" class="cut-key" data-action="make-permanent" '+(waiting?'disabled':'')+'><span aria-hidden="true">●</span><b>Закріпити</b></button>':''}${!sequence&&!isPool&&x.index>0?'<button type="button" class="cut-key" data-action="promote-node" '+(waiting?'disabled':'')+'><span aria-hidden="true">▰</span><b>Основна</b></button>':''}${isPool?tool('Замінити','replace-pool','cut-key',waiting?'disabled':''):''}${canRemove?'<button type="button" class="cut-key cut-eject" data-action="remove-node" '+(waiting?'disabled':'')+'><span aria-hidden="true">⏏</span><b>Прибрати</b></button>':''}<button type="button" class="cut-key cut-tools-close" data-action="picker-close" aria-label="Закрити дії з CUT">×</button></section>`);
  }
  return box('picker',`<section class="picker quick-picker" role="dialog" tabindex="-1" aria-label="${current?'Заміна':'Додавання'} CUT" style="top:${x.top}px;left:${x.left}px">`,[leaf('picker/head',`${head}${x.group==='vibe'&&agentInfo(x.role)&&agentValues(x.role).length?tool('Типово в OMP','reset-agent','role-reset','aria-label="Повернути типовий вибір OMP для агента: '+esc(x.role)+'"'):''}${x.group==='role'&&roleInfo(x.role)&&p().modelRoles[x.role]?tool('Типово в OMP','reset-role','role-reset','aria-label="Повернути типовий вибір OMP: '+esc(x.role)+'"'):''}`),leaf('picker/search',pickerSearch()),leaf('picker/hints',`${x.scope==='all'?'<p class="picker-hint">Доступ залежить від підключення провайдера.</p>':''}${x.group==='vibe'&&x.index===0&&vibeAlias(x.role)?`<p class="picker-hint">Замість ${esc(vibeAlias(x.role))} стане власний CUT агента · роль не зміниться</p>`:''}`),leaf('picker/results',pickerResults())]);
 }
 function pickerSearch(){const x=state.picker,ids=[...myProviderIds()].sort((a,b)=>collate(providerName(a),providerName(b)));return `<div class="quick-search"><label class="search">${SVG.search}<input id="picker-search" type="search" placeholder="Знайти CUT…" value="${esc(x.query)}" aria-label="Знайти CUT" aria-controls="picker-results" autocomplete="off"></label>${opSelect('picker-provider','EDITION',x.scope==='all'?'*':x.provider,[['all','Мої'],...ids.map(id=>[id,providerName(id)]),['*','Весь каталог']])}</div>`;}
 function pickerResults(){
  const x=state.picker,current=chain(x.role,x.group)[x.index],m=current?split(current):null;
  const pool=pickerModels(x),q=x.query.trim(),words=queryWords(q),favs=new Set(state.favs),inProfile=new Set([...Object.values(p().modelRoles),...Object.values(p().retry.fallbackChains).flat()].map(v=>split(v).raw));
  const found=pool.filter(a=>(x.provider==='all'||x.provider===a.provider)&&matchesWords(words,searchKey(a).pick));
  const selected=m?(catalogMap.get(m.raw)||{...m,name:short(m.id)}):null;
  if(selected&&!found.some(a=>a.provider+'/'+a.id===m.raw)&&(!q||matchesQuery(q,selected.name,selected.id,selected.provider))&&(x.provider==='all'||x.provider===selected.provider))found.unshift(selected);
  found.sort((a,b)=>Number(b.provider+'/'+b.id===m?.raw)-Number(a.provider+'/'+a.id===m?.raw)||Number(inProfile.has(b.provider+'/'+b.id))-Number(inProfile.has(a.provider+'/'+a.id))||Number(favs.has(b.provider+'/'+b.id))-Number(favs.has(a.provider+'/'+a.id)));
  const shown=found.slice(0,x.limit);
  return `<div class="picker-results" id="picker-results" data-filter-key="${esc(JSON.stringify([x.role,x.group,x.query,x.provider,x.scope]))}">${shown.length?shown.map(a=>pickerRow(a,a.provider+'/'+a.id===m?.raw)).join(''):'<div class="picker-empty">Збігів немає</div>'}${found.length>shown.length?tool('Ще '+(found.length-shown.length),'picker-more','picker-more'):''}</div>`;
 }

 // Only real controls take focus; an automatic lane's wrapper carries the same data attributes.
 function pickerFocus(x){
  const index=Math.max(0,Math.min(x.index,chain(x.role,x.group).length-1));
  const target=[...win.querySelectorAll(`button[data-edit="${CSS.escape(x.role)}"][data-index="${index}"][data-group="${x.group}"]`)].find(el=>el.getClientRects().length);
  target?.focus({preventScroll:true});return !!target;
 }
 function closePicker(restore=true){const x=state.picker;state.picker=null;render();if(restore&&x)pickerFocus(x);}
 // A changed OFF profile waits for its projection; a failed preview shows the real chain instead.
 function projectionPending(){if(!modeOff()||!diff(state.profile).length)return false;const plan=activePlan();return !plan?.data&&!plan?.error;}
 function pickerActionsPending(){const x=state.picker;return !!(x&&x.group!=='alternatives'&&x.group!=='pool'&&projectionPending());}
 function movePickerCut(direction){
  const x=state.picker;if(!x||state.saving||pickerActionsPending())return;
  const list=chain(x.role,x.group),to=x.index+direction;if(to<0||to>=list.length)return;
  [list[x.index],list[to]]=[list[to],list[x.index]];if(setChain(x.role,list,x.group,{moved:to}))x.index=to;x.focusDirection=direction;render();
  focusPickerMove(direction);
 }
 function focusPickerMove(direction){(win.querySelector(`.cut-tools [data-action=move-node][data-direction="${direction}"]:not(:disabled)`)||win.querySelector('.cut-tools [data-action=move-node]:not(:disabled)')||win.querySelector('.cut-tools'))?.focus({preventScroll:true});}

 function notify(s){state.toast=s;render();clearTimeout(timer);timer=setTimeout(()=>{state.toast='';paintRegions([leaf('toast','')]);},2700);}
 function openPicker(role,index,group,el,actionsOnly=false){
  if(!actionsOnly&&poolName(chain(role,group)[index])){state.poolTab=poolName(chain(role,group)[index]);editTray('pool',true,el);return;}
  if(group!=='pool')state.poolPanel=false;
  if((group||'role')==='role')state.role=role;
  if(!actionsOnly&&Number(index)>=chain(role,group).length&&group!=='alternatives'&&group!=='pool'&&!(Number(index)===0&&((group||'role')==='role'&&!p().modelRoles[role]||group==='vibe'&&!agentValues(role).length))){state.cuts=true;state.cutTarget={role,index:Number(index),group:group||'role'};render();(coarsePointer()?win.querySelector('.tray [data-cut]')||win.querySelector('#cuts-resize'):win.querySelector('#cut-query'))?.focus({preventScroll:true});return;}

  if(!actionsOnly&&temporarySlot(role,index,group)){const route=chain(role,group)[index],key=modeScope(role,group),candidate=modeList(key).findIndex(v=>split(v).raw===split(route).raw);if(candidate>=0){role=key;group='alternatives';index=candidate;}}
  const b=el.getBoundingClientRect();state.picker={role,index:Number(index),group:group||'role',query:'',provider:'all',scope:'mine',limit:40,actionsOnly,top:Math.max(12,Math.min(b.bottom+7,innerHeight-(actionsOnly?58:360))),left:Math.max(12,Math.min(b.left,innerWidth-(actionsOnly?244:372)))};render();
  focusPicker();
 }

 function fitPicker(resize=false){
  const el=win.querySelector('.picker'),x=state.picker;if(!el||!x)return;
  if(el.matches('.quick-picker')){if(resize)delete x.height;if(!x.height){const max=getComputedStyle(el).maxHeight;el.style.height=max==='none'?Math.min(410,innerHeight-24)+'px':max;x.height=el.getBoundingClientRect().height;}el.style.height=x.height+'px';}
  if(getComputedStyle(el).getPropertyValue('--picker-docked').trim()==='1')return;
  const box=el.getBoundingClientRect();x.top=Math.max(12,Math.min(x.top,innerHeight-box.height-12));x.left=Math.max(12,Math.min(x.left,innerWidth-box.width-12));el.style.top=x.top+'px';el.style.left=x.left+'px';
 }
 function refreshSearch(id){
  // Keep the real input (selection, IME and native undo) alive: its region is adopted with the typed value,
  // and only result regions are repainted.
  const previousCache=renderCache;renderCache={diffs:new Map(),keys:new Map()};
  try{
   if(id==='role-query'){regions.reopen('p/deck',deckOpen());paintRegions([laneGraph(),agentList(),leaf('p/pool-editor',poolEditor()),leaf('p/mode-panel',state.modePanel?modePanel():'')],[leaf('p/role-search',roleSearch())]);}
   if(id==='picker-search'&&state.picker&&!state.picker.actionsOnly)paintRegions([leaf('picker/results',pickerResults())],[leaf('picker/search',pickerSearch())]);
   if(id==='cut-query'&&state.cuts){const cuts=collectionCuts();paintRegions([leaf('drawer/count',drawerCount(cuts)),leaf('drawer/results',drawerResults(cuts))],[leaf('drawer/search',drawerSearch())]);}
   if(id==='catalog-query'&&state.view==='models'){const data=catalogData();paintRegions(catalogBody(data),[leaf('m/source',catalogSearch(data))]);}
  }finally{renderCache=previousCache;}
 }
 // `commit` is the blur-time change event: an unchanged value must not replace the result under the pointer.
 function searchInput(el,commit=false){
  const fields={'role-query':'query','catalog-query':'catalogQuery','cut-query':'cutQuery'},key=fields[el.id];
  if(el.id==='picker-search'){if(!state.picker||commit&&state.picker.query===el.value)return;state.picker.query=el.value;state.picker.limit=40;}
  else if(key){if(commit&&state[key]===el.value)return;state[key]=el.value;if(key==='catalogQuery'){state.analyze=null;state.page=0;}}else return;
  if(!composing)refreshSearch(el.id);
 }
 root.addEventListener('compositionstart',()=>{composing=true;});
 root.addEventListener('compositionend',e=>{composing=false;searchInput(e.target);scheduleBackgroundWork();});
 root.addEventListener('input',e=>{if(e.isComposing)composing=true;searchInput(e.target);});
 root.addEventListener('change',e=>searchInput(e.target,true));
 root.addEventListener('click',e=>{if(e.target.closest('.cut-tools [data-action]:not([data-action=picker-close])')&&pickerActionsPending()){e.preventDefault();e.stopImmediatePropagation();}},true);
 root.addEventListener('click',e=>{if(e.target.closest('.dock__menu .menu button'))win.querySelector('.dock__menu')?.removeAttribute('open');},true);
 root.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b){const n=e.target.closest('[data-node-role]');if(n&&!e.target.closest('select,.cut__think'))openPicker(n.dataset.nodeRole,n.dataset.index,n.dataset.group,n);return;}if(b.dataset.device){state.device=b.dataset.device;state.page=0;state.picker=null;render();store();return;}if(b.dataset.view){state.view=b.dataset.view;state.picker=null;state.armedCut=null;state.cutTarget=null;state.query='';state.page=0;render();store();if(b.dataset.subscription){const panel=win.querySelector(`[data-quota-provider="${CSS.escape(b.dataset.subscription)}"]`);panel?.scrollIntoView({block:'center',behavior:'instant'});panel?.focus({preventScroll:true});}return;}if(b.dataset.slotActions){openPicker(b.dataset.slotActions,b.dataset.index,b.dataset.group,b,true);return;}if(b.dataset.catalogProvider){state.catalogProvider=b.dataset.catalogProvider;state.analyze=null;state.page=0;render();return;}if(b.dataset.edit){openPicker(b.dataset.edit,b.dataset.index,b.dataset.group,b);return;}if(b.dataset.resetAgent){resetAgent(b.dataset.resetAgent);return;}if(b.dataset.agentCopy){copyAgentRole(b.dataset.agentCopy);return;}if(b.dataset.agentRole){focusAgentRole(b.dataset.agentRole);return;}if(b.dataset.focusRole){state.role=b.dataset.focusRole;render();store();return;}if(b.dataset.mode){state.catalogMode=b.dataset.mode;state.catalogProvider='all';state.page=0;render();return;}if(b.dataset.fav){const r=b.dataset.fav,next=state.favs.includes(r)?state.favs.filter(x=>x!==r):[...state.favs,r];state.favs=next;render();favWrites=favWrites.then(async()=>{try{await api('/api/favorites',{values:next});favSaved=next;}catch(e){if(state.favs===next){state.favs=[...favSaved];render();}notify(e.message);}});return;}if(b.dataset.removeRole){const r=b.dataset.removeRole,g=b.dataset.group,a=chain(r,g);a.splice(Number(b.dataset.index),1);setChain(r,a,g);state.changes++;render();return;}if(b.dataset.pick){const x=state.picker,a=chain(x.role,x.group),previous=a[x.index]?split(a[x.index]):null;if(previous?.raw===b.dataset.pick){closePicker();return;}const prior=previous?.effort||'',old=carryEffort(prior,b.dataset.pick);a[x.index]=b.dataset.pick+(old?':'+old:'');const ok=setChain(x.role,a,x.group);closePicker();if(ok&&prior&&!old&&!thinkingOff(x.role,x.group))notify('Thinking → типово: '+prior+' не підтверджено для нової моделі.');return;}

 const a=b.dataset.action;if(a==='reset-agent'){resetAgent(state.picker.role);return;}if(a==='reset-role'){resetRole(state.picker.role);return;}if(a==='quota-expand'){state.quotasExpanded=!state.quotasExpanded;render();win.querySelector('[data-action=quota-expand]')?.focus({preventScroll:true});}if(a==='clear-search'){state.query='';render();win.querySelector('#role-query')?.focus();}if(a==='save'){await save();}if(a==='undo'||a==='redo')historyStep(a==='undo'?-1:1);if(a==='reset-draft'){state.poolPanel=false;profiles[state.profile]=copy(original[state.profile]);state.picker=null;render();}if(a==='picker-close')closePicker();if(a==='picker-more'){const offset=win.querySelector('.picker-results').scrollTop;state.picker.limit+=40;render();win.querySelector('.picker-results').scrollTop=offset;}if(a==='move-node'){movePickerCut(Number(b.dataset.direction));return;}if(['remove-node','promote-node'].includes(a)){const x=state.picker;if(!x||x.index===0&&x.group!=='alternatives'&&x.group!=='pool'&&!(poolName(chain(x.role,x.group)[0])&&chain(x.role,x.group).length>1))return;const list=chain(x.role,x.group);if(a==='remove-node')list.splice(x.index,1);else{list.unshift(list.splice(x.index,1)[0]);x.index=0;}setChain(x.role,list,x.group);closePicker();}if(a==='prev-page'||a==='next-page'){state.page+=a==='next-page'?1:-1;render();}if(a==='provider-add'){state.editProvider=null;state.modalError='';state.modal='provider';render();win.querySelector('input[name=name]')?.focus();}if(a==='modal-close'){state.modal=null;state.modalError='';render();}if(a==='provider-create'){await saveProvider();}

 });
 root.addEventListener('change',e=>{const el=e.target;if(el.id==='profile-choice'||el.id==='provider-profile'||el.id==='catalog-profile-target'){state.poolPanel=false;state.profile=el.value;state.picker=null;state.armedCut=null;state.cutTarget=null;render();store();}if(el.id==='catalog-role-target'){state.role=el.value;state.picker=null;render();store();}if(el.dataset.effortRole){el.focus({preventScroll:true});const role=el.dataset.effortRole,g=el.dataset.group,a=chain(role,g),i=Number(el.dataset.index);a[i]=split(a[i]).raw+(el.value?':'+el.value:'');setChain(role,a,g);state.changes++;render();}if(el.id==='catalog-provider'){state.catalogProvider=el.value;state.analyze=null;state.page=0;render();}if(el.id==='picker-provider'){state.picker.scope=el.value==='*'?'all':'mine';state.picker.provider=el.value==='*'?'all':el.value;state.picker.limit=40;render();if(coarsePointer())win.querySelector('#picker-provider')?.focus({preventScroll:true});else focusPicker();}if(el.id==='picker-effort'){el.focus({preventScroll:true});const x=state.picker,list=chain(x.role,x.group);list[x.index]=split(list[x.index]).raw+(el.value?':'+el.value:'');setChain(x.role,list,x.group);render();}if(el.dataset.providerToggle){const id=el.dataset.providerToggle;p().disabledProviders=(p().disabledProviders||[]).filter(x=>x!==id);if(!el.checked)p().disabledProviders.push(id);state.changes++;render();}});

 function onKeydown(e){
  const clip=e.target.closest('[data-edit]');
  if(clip?.closest('[data-node-role],.lane__groove,.cut-grid')&&!state.picker&&!state.modal&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Delete'].includes(e.key)){
   e.preventDefault();const {edit:role,group}=clip.dataset,index=Number(clip.dataset.index),list=chain(role,group),step=e.key==='ArrowLeft'?-1:1;
   if(e.shiftKey&&['ArrowLeft','ArrowRight'].includes(e.key)){const to=index+step;if(to>=0&&to<list.length){[list[index],list[to]]=[list[to],list[index]];const ok=setChain(role,list,group,{moved:to});render();pickerFocus({role,group,index:ok?to:index});}return;}
   if(e.key==='Delete'){if(index<list.length&&(index>0||group==='alternatives'||group==='pool'||poolName(list[0])&&list.length>1)){list.splice(index,1);const ok=setChain(role,list,group);render();if(!pickerFocus({role,group,index:ok?Math.min(index,list.length-1):index})&&group==='vibe')win.querySelector(`[data-agent-copy="${CSS.escape(role)}"],.patch[aria-label^="${CSS.escape(role)}:"]`)?.focus({preventScroll:true});}return;}
   let nextRole=role,nextIndex=index;
   if(group==='alternatives'||group==='pool')nextIndex=Math.max(0,Math.min(list.length-1,index+(['ArrowLeft','ArrowUp'].includes(e.key)?-1:1)));
   else if(['ArrowUp','ArrowDown'].includes(e.key)){
    // Linked agents and folded lanes have no visible CUT to focus; step over them to the next editable lane.
    const roles=group==='vibe'?workers():roleKeys,dir=e.key==='ArrowUp'?-1:1,editable=r=>[...win.querySelectorAll(`button[data-edit="${CSS.escape(r)}"][data-group="${group}"]`)].some(el=>el.getClientRects().length);
    for(let at=roles.indexOf(role)+dir;at>=0&&at<roles.length;at+=dir)if(editable(roles[at])){nextRole=roles[at];break;}
    nextIndex=Math.max(0,Math.min(index,chain(nextRole,group).length-1));
   }
   else nextIndex=Math.max(0,Math.min(list.length-1,index+step));
   if(group==='role')state.role=nextRole;render();pickerFocus({role:nextRole,group,index:nextIndex});return;
  }
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'&&!e.target.matches('input,textarea,select')&&!state.modal){e.preventDefault();(e.target.closest('#pool-editor')||state.picker?.group==='pool'||poolActionContext()?poolStep:historyStep)(e.shiftKey?1:-1);return;}
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'&&['profiles','models'].includes(state.view)&&!state.modal){e.preventDefault();const poolContext=e.target.closest('#pool-editor')||state.picker?.group==='pool'||poolActionContext();if(state.picker)closePicker();(poolContext?savePools:save)();return;}
  if(e.key==='Escape'&&win.querySelector('.dock__menu[open]')){const menu=win.querySelector('.dock__menu');menu.removeAttribute('open');menu.querySelector('summary').focus();return;}
  if(e.key==='Escape'&&(e.defaultPrevented||e.target.closest('select')&&(CSS.supports('selector(select:open)')?e.target.closest('select').matches(':open'):true)))return;
  if(e.key==='Escape'&&(state.picker||state.modal)){e.preventDefault();if(state.picker){closePicker();return;}state.modal=null;state.modalError='';render();return;}
  if(e.key==='Escape'&&!state.picker&&!state.modal&&(state.poolPanel||state.modePanel)){e.preventDefault();editTray(state.poolPanel?'pool':'alternatives',false);return;}
  if(e.key==='Enter'&&e.target.closest('#new-provider')&&!e.target.matches('textarea,select')){e.preventDefault();win.querySelector('[data-action=provider-create]')?.click();}
  if(state.picker&&e.target.closest('.picker')){
   const rows=[...win.querySelectorAll('.picker-results [data-pick]')];
   if(['ArrowDown','ArrowUp'].includes(e.key)&&(e.target.id==='picker-search'||e.target.hasAttribute('data-pick'))){e.preventDefault();const i=rows.indexOf(e.target),next=i<0?(e.key==='ArrowDown'?0:rows.length-1):Math.max(0,Math.min(rows.length-1,i+(e.key==='ArrowDown'?1:-1)));rows[next]?.focus();}
   if(e.key==='Enter'&&e.target.id==='picker-search'){e.preventDefault();if(state.picker.query.trim())rows[0]?.click();else win.querySelector('.picker-row.is-current')?.click();}
  }
 }
 root.addEventListener('keydown',onKeydown);
 // Shortcuts keep working when a re-render left focus on <body>.
 document.addEventListener('keydown',e=>{if(e.target instanceof Element&&!e.composedPath().includes(root))onKeydown(e);});
 document.addEventListener('click',e=>{if(!e.target.closest('.dock__menu'))win.querySelector('.dock__menu')?.removeAttribute('open');if(state.picker&&!e.target.closest('.picker,[data-edit],[data-slot-actions],[data-node-role]'))closePicker(false);});
 // One pointer gesture for both the label and the segment edge. Native buttons
 // consume HTML dragging in WebKit; keep native buttons for click/keyboard access.
 // A completed drag swallows only its own synthetic click; keyboard clicks (detail 0) are never swallowed.
 // DRAG — one gesture for a lane CUT (a copy to another lane, a move within its lane) and for a CUT or a pool from
 // the drawer, the pool keys or the quick picker. A lifted ghost (fixed, moved only by transform) follows the
 // pointer; sockets glow; the drawer retracts to its lip while a CUT is dragged out of it. A move only stores the
 // point; one animation frame hit-tests first (on the last frame's layout), then writes the ghost and scrolls the
 // page near its top edge or over the drawer's lip. Touch uses «обрати CUT → торкнутись місця» instead.
 let suppressClipClick=false;
 function suppressNextClick(){suppressClipClick=true;setTimeout(()=>{suppressClipClick=false;},0);}
 const DROP_TARGETS='.cut[data-node-role],.socket[data-edit]';
 function dropAllowed(d,el){
  if(!el||el===d.node||el.closest('.ghost'))return false;
  if(d.kind!=='clip')return true;
  const role=el.dataset.nodeRole||el.dataset.edit,group=el.dataset.group||'role',same=role===d.role&&group===d.group;
  return same||d.group!=='alternatives'&&group!=='alternatives';
 }
 function dropTarget(d,x,y){const el=document.elementFromPoint(x,y)?.closest(DROP_TARGETS);return dropAllowed(d,el)?el:null;}
 function markTarget(d,target){if(target===d.target)return;d.target?.classList.remove('is-hot','is-drop');d.target=target;target?.classList.add(target.matches('.socket')?'is-hot':'is-drop');}
 // What the ghost shows: the CUT itself, or for a pool key / a picker row the same CUT the lane would get.
 function ghostCut(d){
  if(d.node.matches('.cut'))return d.node.cloneNode(true);
  const t=document.createElement('template'),name=poolName(d.key||'');
  if(name)t.innerHTML=`<div class="cut cut--pool${name==='free-fast'?' cut--pool-fast':''}"><span class="cut__edge"></span><span class="cut__name">${poolNames[name]}</span><span class="cut__meta"><span class="stack${name==='free-fast'?' stack--fast':''}"></span><span>${source.freePools?.[name]?.length||0} CUTS · спільний</span></span></div>`;
  else{const route=d.route||d.key,m=split(route);t.innerHTML=drawerCut(catalogMap.get(m.raw)||{...m,name:m.id});}
  return t.content.firstElementChild;
 }
 function liftDrag(d){
  d.active=true;root.setPointerCapture(d.pointer);
  const rect=d.node.getBoundingClientRect(),tray=win.querySelector('.tray'),fromTray=!!d.node.closest('.tray'),lip=parseFloat(getComputedStyle(win.querySelector('.tray-port')||document.documentElement).getPropertyValue('--lip'))||46;
  d.rect=rect;d.floor=window.innerHeight-(state.cuts&&!fromTray?tray?.getBoundingClientRect().height||lip:lip);
  // The page position is tracked here, so rolling it never reads layout back inside the frame loop.
  d.scroll=window.scrollY;d.maxScroll=Math.max(0,document.documentElement.scrollHeight-window.innerHeight);
  const ghost=document.createElement('div'),cut=ghostCut(d),w=Math.round(Math.max(150,Math.min(220,rect.width))),h=Math.round(Math.max(52,Math.min(76,rect.height)));
  cut.classList.remove('is-armed','is-match','is-src','is-drop','is-changed');cut.removeAttribute('id');cut.setAttribute('aria-hidden','true');for(const el of cut.querySelectorAll('[id]'))el.removeAttribute('id');
  cut.style.width=w+'px';cut.style.height=h+'px';
  ghost.className='ghost';ghost.setAttribute('aria-hidden','true');ghost.innerHTML=`<div class="ghost__sh" style="width:${w}px;height:${h}px"></div>`;ghost.append(cut);
  ghost.style.transform=`translate3d(${rect.left}px,${rect.top}px,0)`;document.body.append(ghost);d.ghost=ghost;
  requestAnimationFrame(()=>ghost.classList.add('is-up'));
  d.node.classList.add('is-src');win.querySelector('#profile-tracks')?.classList.add('is-dragging');
  if(fromTray)tray?.classList.add('is-retracted');
 }
 function dragFrame(){
  const d=drag;if(!d?.active)return;d.frame=0;
  markTarget(d,dropTarget(d,d.x,d.y));
  const EDGE=72,MAX=24;let v=0;
  if(d.y<EDGE)v=-MAX*Math.min(1,(EDGE-d.y)/EDGE);else if(d.y>d.floor-EDGE)v=MAX*Math.min(1.5,(d.y-(d.floor-EDGE))/EDGE);
  d.ghost.style.transform=`translate3d(${d.rect.left+d.x-d.x0}px,${d.rect.top+d.y-d.y0}px,0) rotate(-1.6deg) scale(1.04)`;
  // Keep rolling while the pointer is held at an edge.
  if(v){const next=Math.max(0,Math.min(d.maxScroll,d.scroll+Math.round(v)));if(next!==d.scroll){d.scroll=next;window.scrollTo(0,next);d.frame=requestAnimationFrame(dragFrame);}}
 }
 function endDrag(cancel=false){
  const d=drag;drag=null;if(!d)return null;cancelAnimationFrame(d.frame);
  if(root.hasPointerCapture(d.pointer))root.releasePointerCapture(d.pointer);
  if(!d.active)return d;
  d.node.classList.remove('is-src');d.target?.classList.remove('is-hot','is-drop');
  win.querySelector('#profile-tracks')?.classList.remove('is-dragging');win.querySelector('.tray')?.classList.remove('is-retracted');
  const ghost=d.ghost;
  if(cancel||!d.target){
   // No drop: the ghost flies back to its source, then disappears.
   const back=d.node.isConnected?d.node.getBoundingClientRect():d.rect;ghost.classList.remove('is-up');
   if(matchMedia('(prefers-reduced-motion: reduce)').matches)ghost.remove();
   else{ghost.style.transition='transform 260ms var(--e-out)';ghost.style.transform=`translate3d(${back.left}px,${back.top}px,0)`;setTimeout(()=>ghost.remove(),270);}
  }else ghost.remove();
  return d;
 }
 function clipDrop(d){
  let focus={role:d.role,group:d.group,index:d.index};
  if(d.target){
   const role=d.target.dataset.nodeRole||d.target.dataset.edit,group=d.target.dataset.group||'role',index=Number(d.target.dataset.index),same=role===d.role&&group===d.group;
   const sourceList=chain(d.role,d.group),route=sourceList[d.index];
   if(group==='pool'&&!ManaOperator.isFreeModel(catalogMap.get(split(route).raw)||{})){notify('До пулу можна додати лише підтверджений FREE CUT.');return;}
   if(!same&&routeWarning(split(route).raw)){notify('Цей маршрут зараз недоступний.');return;}
   const list=ManaOperator.transferCut(sourceList,chain(role,group),d.index,index,same),limit=group==='pool'?Infinity:group==='alternatives'?12:group==='vibe'?30:31;
   if(list.length>limit){notify('Доріжка вже має максимальну кількість CUTS.');return;}
   if(setChain(role,list,group,same?{moved:list.indexOf(route)}:{inserted:list.indexOf(route)})){focus={role,group,index:list.indexOf(route)};if(!same)state.opFeedback=withNotes('Скопійовано CUT → '+role+(chainNotes.some(n=>n.startsWith('thinking прибрано'))?'':' · thinking збережено'));}
  }
  render();pickerFocus(focus);
 }
 function cutDrop(d){
  if(!d.target){render();return;}
  const t=d.target.dataset,target={role:t.nodeRole||t.edit,index:Number(t.index),group:t.group||'role'};
  if(d.route){state.picker=null;commitCut(d.route,{...target,profile:state.profile,expected:chain(target.role,target.group)[target.index]??null});}
  else placeCut(d.key,target);
 }
 root.addEventListener('pointerdown',e=>{
  suppressClipClick=false;
  if(drag||e.button!==0||e.pointerType==='touch'||state.saving||e.target.closest('select,.cut__think,.cut__more,[data-knob],.tray__grip'))return;
  const lane=e.target.closest('[data-node-role]'),cut=lane?null:e.target.closest('[data-cut],[data-cut-route]');
  if(lane&&!state.picker)drag={kind:'clip',node:lane,role:lane.dataset.nodeRole,index:Number(lane.dataset.index),group:lane.dataset.group};
  else if(cut&&!cut.disabled)drag={kind:'cut',node:cut,key:cut.dataset.cut,route:cut.dataset.cutRoute};
  else return;
  Object.assign(drag,{x0:e.clientX,y0:e.clientY,x:e.clientX,y:e.clientY,pointer:e.pointerId,active:false,target:null,frame:0});
 });
 root.addEventListener('pointermove',e=>{
  const d=drag;if(!d||e.pointerId!==d.pointer)return;
  d.x=e.clientX;d.y=e.clientY;
  if(!d.active){if(Math.hypot(d.x-d.x0,d.y-d.y0)<6)return;liftDrag(d);}
  e.preventDefault();d.frame||=requestAnimationFrame(dragFrame);
 });
 window.addEventListener('scroll',()=>{if(drag?.active&&!drag.frame)drag.scroll=window.scrollY;},{passive:true});
 root.addEventListener('pointerup',e=>{
  const d=drag;if(!d||e.pointerId!==d.pointer)return;
  if(d.active)markTarget(d,dropTarget(d,e.clientX,e.clientY));
  endDrag(false);if(!d.active)return;
  e.preventDefault();suppressNextClick();
  if(d.kind==='clip')clipDrop(d);else cutDrop(d);
 });
 for(const type of ['pointercancel','lostpointercapture'])root.addEventListener(type,()=>{if(drag&&endDrag(true)?.active)render();});
 window.addEventListener('blur',()=>{if(drag&&endDrag(true)?.active)render();});
 root.addEventListener('keydown',e=>{if(e.key==='Escape'&&drag?.active){e.preventDefault();e.stopPropagation();suppressClipClick=true;endDrag(true);render();}},true);
 root.addEventListener('click',e=>{if(suppressClipClick&&e.detail!==0){e.preventDefault();e.stopImmediatePropagation();suppressClipClick=false;}},true);
 // After an Escape-cancelled gesture the release still produces a click; forget it once that task ends.
 document.addEventListener('pointerup',()=>{if(suppressClipClick)setTimeout(()=>{suppressClipClick=false;},0);},true);


 function diff(name){
  if(renderCache?.diffs.has(name))return renderCache.diffs.get(name);
  const a=original[name],b=profiles[name],out=[];
  for(const path of [...[...new Set([...Object.keys(a.modelRoles),...Object.keys(b.modelRoles)])].map(r=>['modelRoles',r]),...[...new Set([...Object.keys(a.retry.fallbackChains),...Object.keys(b.retry.fallbackChains)])].map(r=>['retry','fallbackChains',r]),...[...new Set([...workers(a),...workers(b)])].map(r=>['task','agentModelOverrides',r]),['disabledProviders'],['forgeMode']]){
   const get=o=>path.reduce((v,k)=>v?.[k],o),v=get(b);
   if(JSON.stringify(get(a))!==JSON.stringify(v))out.push(v===undefined?{path,remove:true}:{path,value:v});
  }
  renderCache?.diffs.set(name,out);return out;
 }
 // Server problems with a code get a clear line instead of the generic «змінились вихідні дані» dialog.
 const PROBLEM_CODES=new Set(['mode-recovery','symlink','mode-conflict']);
 function problemText(d){
  const text=d.error||'Не вдалося виконати дію',files=(d.files||d.profiles||[]).join(', ');
  if(d.code==='mode-recovery')return 'Незавершене збереження: '+text+(files?' · файли: '+files:'');
  if(d.code==='symlink')return 'Файл — символьне посилання: '+text;
  if(d.code==='mode-conflict')return 'Файл профілю змінено поза Mana Tape: '+text+(files?' · '+files:'')+' · «Прийняти файл» на монтажі';
  return text;
 }
 async function api(path,body){
  const writes=path!=='/api/profile-preview';if(writes){writeEpoch++;activeWrites++;}
  try{const r=await fetch(endpoint(path),{method:'POST',headers:{'Content-Type':'application/json','X-Forge-CSRF':source.csrf},body:JSON.stringify(body)});const d=await r.json();if(!r.ok){const e=Error(problemText(d));e.status=r.status;e.code=d.code||'';e.files=d.files||d.profiles||[];throw e;}return d;}
  finally{if(writes){writeEpoch++;activeWrites--;scheduleBackgroundWork();}}
 }
 function interactionBusy(preview=false){
  const focused=document.activeElement,select=focused?.matches('select'),selectOpen=select&&(CSS.supports('selector(select:open)')?focused.matches(':open'):nativeSelectBusy);
  return document.hidden||composing||pointerHeld||activeWrites||document.documentElement.dataset.displayTuning||state.modal||state.picker&&(!preview||!state.picker.actionsOnly)||state.saving||state.profileBusy||state.providerSaving||drag||cutGesture||drawerGesture||focused?.matches('input,textarea')||select&&(!preview||selectOpen)||win.querySelector('.dock__menu[open]');
 }
 function scheduleBackgroundWork(){clearTimeout(backgroundTimer);backgroundTimer=setTimeout(flushBackgroundWork,0);}
 function flushBackgroundWork(){
  if(!interactionBusy(true)){
   for(const [name,result] of pendingModeResults){if(state.modePlans[name]?.key===result.key){state.modePlans[name]=result;if(state.profile===name)pendingRender=true;}pendingModeResults.delete(name);}
   if(pendingRender){pendingRender=false;render();}
  }
  if(backgroundRefreshPending&&!backgroundReloading&&!interactionBusy()){backgroundRefreshPending=false;pollState();}
  // A hidden tab or a focused field wakes the queue through visibilitychange/focusout; do not poll for them.
  if((backgroundRefreshPending||pendingRender||pendingModeResults.size)&&!(document.hidden||document.activeElement?.matches?.('input,textarea'))){clearTimeout(backgroundTimer);backgroundTimer=setTimeout(flushBackgroundWork,200);}
 }
 async function pollState(){
  if(interactionBusy()){backgroundRefreshPending=true;return;}
  try{await reload(false,false,true);}catch{state.offline=true;pendingRender=true;flushBackgroundWork();}
 }
 for(const event of ['focusout','click','pointerup','pointercancel','keyup'])root.addEventListener(event,scheduleBackgroundWork);
 root.addEventListener('pointerdown',e=>{const select=e.target.closest('select');pointerHeld=!select;if(select)nativeSelectBusy=true;},true);
 for(const event of ['pointerup','pointercancel'])document.addEventListener(event,()=>{pointerHeld=false;scheduleBackgroundWork();},true);
 root.addEventListener('keydown',e=>{if(e.target.matches('select'))nativeSelectBusy=!['Escape','Tab'].includes(e.key);},true);
 for(const event of ['change','focusout'])root.addEventListener(event,e=>{if(e.target.matches('select')){nativeSelectBusy=false;pointerHeld=false;scheduleBackgroundWork();}},true);
 window.addEventListener('blur',()=>{pointerHeld=false;nativeSelectBusy=false;scheduleBackgroundWork();});
 document.addEventListener('visibilitychange',scheduleBackgroundWork);window.addEventListener('focus',scheduleBackgroundWork);
 function snapshotFingerprint(snapshot){return JSON.stringify({...snapshot,tariff:{...snapshot.tariff,at:0}});}
 function timeLabel(seconds){return seconds?dateFormat({day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(seconds*1000):'ще немає даних';}
 function num(n){return Number.isFinite(n)?numberFormat('uk-UA',{notation:n>=100000?'compact':'standard',maximumFractionDigits:1}).format(n):'—';}
 function modelStatus(m){return m.status==='missing'?'Зникла':m.newAt?'Нова':m.available?'В OMP':m.source==='config'?'Вручну':'Кеш';}
 function routeWarning(raw){const m=catalogMap.get(raw),pid=split(raw).provider;return m?.status==='missing'||source.providers.find(p=>p.id===pid)?.expired||(p().disabledProviders||[]).includes(pid);}
 function rebuild(){
  referenced.clear();for(const pr of Object.values(profiles)){for(const r of [...Object.values(pr.modelRoles),...Object.values(pr.retry?.fallbackChains||{}).flat(),...Object.values(pr.task?.agentModelOverrides||{}).flat(),...(pr.forgeMode?.alternatives||[]),...Object.values(pr.forgeMode?.overrides||{}).flat()])if(typeof r==='string'&&r.includes('/'))referenced.add(split(r).raw);}
  referencedProviders.splice(0,referencedProviders.length,...new Set([...referenced].filter(r=>!poolName(r)).map(r=>split(r).provider)));
  // The catalogue changes only with a new snapshot or a newly referenced unknown route, not with every render.
  if(catalogSource!==source){catalogSource=source;catalogExtra=null;sourceRoutes=new Set(source.models.map(m=>m.provider+'/'+m.id));}
  const extra=[...referenced].filter(r=>!poolName(r)&&!sourceRoutes.has(r)).sort().join('\n');
  if(extra===catalogExtra)return;
  catalogExtra=extra;dataVersion++;
  catalogMap.clear();for(const m of source.models)catalogMap.set(m.provider+'/'+m.id,m);
  for(const r of referenced)if(!poolName(r)&&!catalogMap.has(r)){const m=split(r);catalogMap.set(r,{...m,name:m.id,source:'reference'});}
  catalog.splice(0,catalog.length,...[...catalogMap.values()].sort((a,b)=>collate(a.provider,b.provider)||collate(a.name,b.name)));
  localProviders=new Set([...(source.ui?.localProviders||[]),...catalog.filter(m=>m.local).map(m=>m.provider)]);
  deepSeekCatalog=catalog.some(m=>deepseek(m.provider+'/'+m.id));
 }
 async function reload(discard=false,rebasePools=false,background=false){
  if(background&&backgroundReloading)return;const epoch=writeEpoch;if(background)backgroundReloading=true;
  try{
  // A poll revalidates with the snapshot's ETag: 304 is an unchanged snapshot without a body or a parse.
  const r=await fetch(endpoint('/api/state'),background&&stateTag?{cache:'no-store',headers:{'If-None-Match':stateTag}}:{cache:'no-store'});
  const ageChanged=snapshot=>(snapshot.insights?.usage?.reports||[]).some(report=>!report.stale&&report.at&&((Date.now()/1000-report.at>900)!==(renderedAt/1000-report.at>900)));
  if(r.status===304){if(state.offline||ageChanged(source)){state.offline=false;pendingRender=true;scheduleBackgroundWork();}return;}
  if(!r.ok)throw Error('Немає зв’язку із сервером');const fresh=await r.json(),tag=r.headers?.get?.('ETag')||'';
  if(background&&(interactionBusy()||epoch!==writeEpoch)){backgroundRefreshPending=true;scheduleBackgroundWork();return;}
  fresh.base=normalizeProfile(fresh.base);
  const freshnessChanged=ageChanged(fresh);
  if(background&&!state.offline&&!freshnessChanged&&snapshotFingerprint(fresh)===snapshotFingerprint(source)){source.tariff=fresh.tariff;stateTag=tag;return;}
  stateTag=tag;
  const next={standard:copy(fresh.base),...Object.fromEntries(Object.entries(fresh.presets).map(([k,v])=>[k,merge(fresh.base,v)]))};
  for(const [k,v] of Object.entries(next))v.forgeMode=copy(fresh.profileModes?.[k]?.settings||{mode:'deepseek',alternatives:[],overrides:{}});
  for(const k of Object.keys(profiles))if(!next[k]&&(discard||!diff(k).length)){delete profiles[k];delete original[k];}
  for(const [k,v]of Object.entries(next)){if(!discard&&profiles[k]&&diff(k).length){if(!rebasePools||JSON.stringify(v)!==JSON.stringify(original[k]))fresh.revisions[k]=source.revisions[k];continue;}profiles[k]=copy(v);original[k]=copy(v);}
  if(discard||!poolsDirty()){poolOriginal=copy(fresh.freePools);poolDraft=copy(poolOriginal);poolRevision=fresh.poolsRevision;}
  source=fresh;profileKeys.splice(0,profileKeys.length,...Object.keys(profiles));roleKeys.splice(0,roleKeys.length,...knownRoleKeys(fresh.base));
  if(!profiles[state.profile])state.profile='standard';state.favs=favSaved=fresh.favs||[];rebuild();state.offline=false;render();
  }finally{if(background)backgroundReloading=false;}
 }
 async function save(){
  if(state.saving)return;const name=state.profile,saved=copy(profiles[name]);if(!diff(name).length)return;
  const displayed=activePlan()?.data;state.saving=true;render();
  try{
   const body=modeBody(name),preview=await api('/api/profile-preview',body);
   pendingModeResults.delete(name);state.modePlans[name]={key:modeKey(name),data:preview};
   if(preview.issues.length)throw Error('Додай доступну заміну для позначених ролей.');
   if(saved.forgeMode.mode==='no-deepseek'&&(!displayed||displayed.token!==preview.token)){notify('Заміни оновились. Переглянь карту й збережи ще раз.');return;}
   await api('/api/profile',{...body,previewToken:preview.token});
   original[name]=saved;state.opFeedback='Профіль збережено для нових запусків OMP.';delete state.modePlans[name];editHistory.reset(name,original[name]);
   await reload();notify('Збережено · '+(saved.forgeMode.mode==='no-deepseek'?'Без DeepSeek':'З DeepSeek'));
  }catch(e){if(e.status===409&&!PROBLEM_CODES.has(e.code)){state.modal='conflict';state.error=e.message;}else state.error=e.message;render();}
  finally{state.saving=false;render();}
 }
 let chainNotes=[];
 function withNotes(message){return [message,...chainNotes].filter(Boolean).join(' · ');}
 function thinkingOff(role,group){const id=group==='role'?role:group==='alternatives'&&String(role).startsWith('role:')?role.slice(5):'';return !!id&&roleInfo(id)?.thinking===false;}
 // One edit of a lane. Returns false when nothing was applied (the caller keeps focus and the gesture).
 // hint.moved: index of a CUT moved within this lane; hint.inserted: index of a CUT dropped from elsewhere.
 function setChain(role,list,group='role',hint={}){
  chainNotes=[];
  if(state.saving)return false;
  if(thinkingOff(role,group)){
   // Roles without chat-thinking reject an effort suffix; strip it from every inserted or replaced CUT.
   const current=chain(role,group),next=list.map(r=>current.includes(r)||poolName(r)||String(r).startsWith('@')?r:split(r).raw);
   if(next.some((r,i)=>r!==list[i]))chainNotes.push('thinking прибрано: '+(group==='role'?role:role.slice(5))+' не використовує thinking');
   list=next;
  }
  if(list.some(r=>!poolName(r)&&catalogMap.has(split(r).raw)&&!acceptsRoleModel(role,group,catalogMap.get(split(r).raw)))){notify('Цей CUT не підтримує роль '+role+'.');return false;}
  if(group!=='pool')state.poolPanel=false;
  if(group==='pool'){if(list.some(r=>!ManaOperator.isFreeModel(catalogMap.get(split(r).raw)||{}))){notify('До пулу можна додавати лише підтверджені FREE CUTS.');return false;}poolDraft[role]=[...new Map(list.map(v=>[split(v).raw,v])).values()];return true;}
  if(group==='alternatives'){
   if(list.some(r=>!poolName(r)&&deepseek(r))){notify('Заміна має бути без платного DeepSeek. FREE DeepSeek можна.');return false;}
   const s=modeSettings(),routes=[...new Map(list.map(v=>[split(v).raw,v])).values()];if(role==='profile')s.alternatives=routes;else s.overrides[role]=routes;
   if(chainNotes.length)state.opFeedback=chainNotes.join(' · ');return true;
  }
  // An index-based edit must read the projection it was made on.
  if(projectionPending()){notify('Ще розраховується режим DeepSeek. Спробуй за мить.');return false;}
  const view=modeView(role,group),before=group==='role'?baseChain(role).slice(1):null,inherited=group==='role'&&inheritsDefault(role);
  if(view?.refs){if(!applyModeEdit(role,list,group,view,hint))return false;}
  else oldSetChain(role,list,group);
  if(inherited&&Object.hasOwn(p().retry.fallbackChains,role))chainNotes.push(roleFallbacks(role).length?'Резерви default скопійовано в '+role+'; доріжка більше не слідує за default':role+' більше не бере резерви default');
  if(group==='role'&&state.syncVibe)syncAgentTails(role,before);
  if(chainNotes.length)state.opFeedback=chainNotes.join(' · ');
  return true;
 }
 // «Копіювати резерви»: only a list that still repeated the role's fallbacks follows the role.
 function syncAgentTails(role,before){
  const after=baseChain(role).slice(1),synced=[];if(JSON.stringify(after)===JSON.stringify(before))return;
  for(const worker of workers()){const values=agentValues(worker);if(values.length>1&&values[0]==='@'+role&&JSON.stringify(values.slice(1))===JSON.stringify(before)){p().task.agentModelOverrides[worker]=['@'+role,...after];synced.push(worker);}}
  if(synced.length)chainNotes.push('Резерви '+role+' також оновлено в агентах: '+synced.join(', '));
 }
 // DeepSeek OFF edits a projection. Every CUT returns to its source: ⇄ replacements stay in the
 // replacement list (their slots, their order); any other CUT, including a new one, joins the real chain.
 function applyModeEdit(role,list,group,view,{moved=-1,inserted=-1}={}){
  const old=view.routes||[],refs=view.refs,scope=modeScope(role,group),base=group==='vibe'?agentValues(role):baseChain(role),used=new Set();
  const items=list.map(route=>({route,ref:null,from:-1,same:false}));
  items.forEach((item,i)=>{if(i===inserted)return;const j=old.findIndex((r,k)=>!used.has(k)&&r===item.route);if(j>=0){used.add(j);Object.assign(item,{ref:refs[j],from:j,same:true});}});
  // A replacement in place (pick, thinking, collection) keeps the position's source.
  if(inserted<0&&list.length===old.length)items.forEach((item,i)=>{if(!item.ref&&!used.has(i)&&refs[i]){used.add(i);Object.assign(item,{ref:refs[i],from:i});}});
  // A dropped CUT that already stood among the ⇄ replacements joins the real chain; the replacement stays.
  const kept=inserted>=0?refs.findIndex((r,k)=>!used.has(k)&&r.kind==='replacement'&&split(old[k]).raw===split(list[inserted]).raw):-1;
  const replacement=item=>item.ref?.kind==='replacement'&&(item.ref.key||scope)===scope;
  const firstOld=refs.findIndex(r=>r.kind==='replacement'),first=items.findIndex(replacement),last=items.findLastIndex(replacement);
  if(moved>=0&&replacement(items[moved]||{})&&items.slice(first+1,last).some(item=>!replacement(item)&&item.same)){notify('Заміни DeepSeek ідуть одним блоком на місці DeepSeek. Їхній порядок — у «Заміни».');return false;}
  const ahead=[],behind=[];let crossed=false;
  items.forEach((item,i)=>{
   if(replacement(item))return;
   const inside=first>=0&&i>first&&i<last;
   // A CUT moved into the block crosses it as a whole; a new CUT goes right after it.
   if(inside&&item.same)crossed=true;
   const after=first>=0&&(i>last||inside&&!(item.same&&firstOld>=0&&item.from>firstOld));
   (after?behind:ahead).push(item);
  });
  if(crossed)chainNotes.push('Заміни DeepSeek стоять одним блоком на місці DeepSeek');
  const host=view.alias?-1:(view.paused?.[0]?.index??-1),segment=first>=0&&host>=0;
  const entry=item=>{
   if(item.ref?.kind!=='base')return {value:item.route,idx:null};
   const stored=base[item.ref.index];
   if(item.same)return {value:stored,idx:item.ref.index};
   if(group==='vibe'&&String(stored).startsWith('@'))chainNotes.push(stored+' у '+role+' замінено власним CUT; роль не змінена');
   return {value:item.route,idx:item.ref.index};
  };
  const sequence=[...ahead.map(entry),...(segment?[{value:base[host],idx:host}]:[]),...behind.map(entry)];
  // Hidden CUTS (paused DeepSeek, duplicates) keep their place after their predecessor.
  const present=new Set(sequence.map(e=>e.idx).filter(i=>i!=null)),shown=new Set(refs.filter(r=>r.kind==='base').map(r=>r.index)),anchor=new Map(),attached=new Map([[-1,[]]]);
  for(let h=0;h<base.length;h++){
   if(shown.has(h)||present.has(h))continue;
   let pred=-1;for(let k=h-1;k>=0;k--){if(present.has(k)){pred=k;break;}if(anchor.has(k)){pred=anchor.get(k);break;}}
   anchor.set(h,pred);if(!attached.has(pred))attached.set(pred,[]);attached.get(pred).push(base[h]);
  }
  const next=[...attached.get(-1)];for(const e of sequence){next.push(e.value);if(e.idx!=null)next.push(...(attached.get(e.idx)||[]));}
  // Replacement slots are refilled in their new order; hidden replacements keep their slots.
  const own=modeList(scope),slots=refs.filter((r,k)=>k!==kept&&r.kind==='replacement'&&(r.key||scope)===scope).map(r=>own.indexOf(r.route)).filter(i=>i>=0).sort((a,b)=>a-b);
  const values=items.filter(replacement).map(item=>item.same?item.ref.route:item.route),replaced=[...own];
  slots.forEach((slot,k)=>{replaced[slot]=k<values.length?values[k]:undefined;});
  const routes=[...new Map(replaced.filter(v=>v!==undefined).map(v=>[split(v).raw,v])).values()];
  if(routes.some(r=>!poolName(r)&&deepseek(r))){notify('Заміна має бути без платного DeepSeek. FREE DeepSeek можна.');return false;}
  if(next.length&&JSON.stringify(next)!==JSON.stringify(base)){if(group==='vibe')writeAgent(role,next);else oldSetChain(role,next,group);}
  if(JSON.stringify(routes)!==JSON.stringify(own))modeSettings().overrides[scope]=routes;
  return true;
 }
 function store(){try{localStorage.setItem(storageKey('forge-view'),JSON.stringify({view:state.view,profile:state.profile,role:state.role,syncVibe:state.syncVibe}));}catch{}}

 function limitLabel(limit){
  const period=limit.window||'',at=(limit.label||'').toLowerCase().indexOf(period.toLowerCase());
  let scope=limit.label||'';
  if(period&&at>=0)scope=scope.slice(0,at)+scope.slice(at+period.length);
  scope=scope.replace(/\b(usage|limit)\b/gi,'').replace(/[()]/g,'').replace(/^[\s·:–—-]+|[\s·:–—-]+$/g,'');
  const windowLabel=({'5 hour':'5 год','7 day':'7 днів','7 days':'7 днів','weekly':'Тиждень','monthly':'Місяць'})[period.toLowerCase()]||period;
  return [scope,windowLabel].filter(Boolean).join(' · ')||limit.label||'Період';
 }
 function usageReports(){const reports=(source.insights?.usage?.reports||[]).map(r=>({...r,stale:!!r.stale||!r.at||Date.now()/1000-r.at>900,limits:[...r.limits]}));if(!reports.some(r=>r.provider==='commandcode')&&myProviderIds().has('commandcode'))reports.push({provider:'commandcode',at:0,source:'CodexBar · Mac',limits:[]});const cc=reports.find(r=>r.provider==='commandcode');if(cc){for(const [id,label,pattern]of [['primary','5 год',/5.*(hour|год)/i],['secondary','Тиждень',/week|тиж|7.*day/i],['tertiary','Місяць',/month|місяц/i]])if(!cc.limits.some(l=>pattern.test(l.window+' '+l.label)))cc.limits.push({id,label,window:'',remaining:null});}return reports;}

 function resetCountdown(at,now=Date.now()){
  if(!Number.isFinite(at)||at<=0)return '↻ —';
  const minutes=Math.ceil((at-now)/60000);
  if(minutes<=0)return '↻ минув';
  if(minutes<60)return '↻ '+minutes+'хв';
  const hours=Math.floor(minutes/60),rest=minutes%60;
  if(hours<24)return '↻ '+hours+'г'+(rest?' '+rest+'хв':'');
  const days=Math.floor(hours/24),left=hours%24;
  return '↻ '+days+'д'+(left?' '+left+'г':'');
 }
 function resetTitle(at){return at?'Скидання '+timeLabel(at/1000)+(at<=Date.now()?' · час минув, очікуємо нові дані':''):'Час скидання не надано провайдером';}
 const evidence=ManaEvidence;
 let benchIndex=new Map(),benchVersion=null;
 function rebuildBench(){const data=source.insights?.benchmarks;if(benchVersion===data?.records)return;benchVersion=data?.records;benchIndex=evidence.index(data?.records||[]);}
 function modelRecords(m){rebuildBench();return benchIndex.get(evidence.canonical(m.id))||[];}
 function evidenceCoverage(m){return evidence.coverage(modelRecords(m));}
 function evidenceLabel(m){const c=evidenceCoverage(m);return c.kind==='independent'?'Є незалежні дані':c.kind==='developer'?'Заяви розробника':'Немає даних';}
 function capabilityMarkup(m){return `<div class="model-capabilities"><span>Контекст <b>${m.contextWindow?contextTokens(m.contextWindow):'—'}</b></span><span>Вихід <b>${m.maxTokens?contextTokens(m.maxTokens):'—'}</b></span><span>Зір <b>${Array.isArray(m.input)?m.input.includes('image')?'Так':'Ні':'—'}</b></span><span>Міркування <b>${m.reasoning===true?'Так':m.reasoning===false?'Ні':'—'}</b></span></div>`;}
 function evidenceCard(r,full=false){
  const kind=evidence.kind(r),preference=kind==='preference',developer=kind==='developer',scores=Object.entries(r.scores||{}),shown=full?scores:scores.slice(0,1),status=source.insights?.benchmarks?.sources?.[r.source];
  return `<article class="evidence-card ${kind}"><header><b>${esc(developer?r.publisher:r.source)}</b><span>${developer?'Заявлено розробником':preference?'Людські уподобання':'Незалежний тест'}</span></header><p class="evidence-period">${esc(r.dateKind||'Зріз')} · ${esc(r.release)}${status?.error?' · останній знімок':''}</p><p class="evidence-version">${esc(r.id)}${r.effort?' · '+esc(r.effort):' · режим джерела'}</p>${preference?`<div class="arena-reading"><strong>${num(r.rating)}</strong><span>рейтинг${r.preliminary?' · попередній':''}<small>${r.interval?'Інтервал '+num(r.interval[0])+'–'+num(r.interval[1])+' · ':''}${num(r.votes)} голосів</small></span></div>`:`<dl class="evidence-values">${shown.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd><i aria-hidden="true"><b style="width:${Math.max(0,Math.min(100,v))}%"></b></i><strong>${num(v)}<small>%</small></strong></dd></div>`).join('')}</dl>`}${!full&&scores.length>shown.length?'<small class="evidence-more">Ще '+(scores.length-shown.length)+' · у всіх даних</small>':''}${r.samples?'<small class="evidence-more">'+num(r.samples)+' задач</small>':''}${full||preference?`<p class="evidence-method">${esc(r.note||'Результат тестованої моделі; провайдер і умови запуску можуть відрізнятися.')}${r.potentialOverlap?' Частина задач могла передувати випуску моделі.':''}</p>`:''}<a href="${esc(r.url)}" target="_blank" rel="noreferrer">${developer?'Картка моделі':'Джерело'} ↗</a></article>`;
 }
 function evidenceDeck(m,full=false){
  const records=modelRecords(m),rows=full?evidence.latest(records):evidence.summary(records);
  if(!rows.length)return '<p class="evidence-empty">Для цієї версії зіставлених тестів ще немає. Характеристики вище — з каталогу провайдера; вони не визначають якість.</p>';
  return `<div class="evidence-deck ${full?'expanded':''}" aria-label="Виміри моделі">${rows.map(r=>evidenceCard(r,full)).join('')}</div>${!full&&evidence.latest(records).length>rows.length?'<p class="evidence-note">Інші тестовані режими — у всіх даних.</p>':''}`;
 }
 function detailsMarkup(){const m=catalogMap.get(state.detail)||{...split(state.detail),name:split(state.detail).id};
  return `<div class="detail-title"><h2>${esc(cutTitle(state.detail))}</h2><p class="mono">${esc(state.detail)}</p><button type="button" class="tool" id="model-favorite" data-fav="${esc(state.detail)}" aria-pressed="${state.favs.includes(state.detail)}">${state.favs.includes(state.detail)?'★ В обраних':'☆ До обраних'}</button></div>${capabilityMarkup(m)}<div class="detail-price">${priceMarkup(m)}<small>Вхід / вихід · $ за 1 млн токенів</small></div><p class="evidence-note">Тести — для конкретної версії моделі, не гарантія якості FREE-маршруту. Рейтинги Arena й заяви розробника не входять у бал ролі.</p>${evidenceDeck(m,true)}`;
 }

 function profileNameResult(value,renaming=false){
  const result=ManaOperator.profileName(value);
  if(!result.error&&result.name==='standard'&&(!renaming||state.profile!=='standard'))result.error='Standard — основний профіль. Обери іншу назву.';
  else if(!result.error&&profileKeys.includes(result.name)&&(!renaming||result.name!==state.profile))result.error='Профіль «'+result.name+'» уже є. Обери іншу назву.';
  return result;
 }
 function profileNameHint(value,renaming=false){const q=profileNameResult(value,renaming);return value.trim()?(q.error||'В OMP: '+q.name):'Латиниця й цифри. Пробіли → дефіс, великі літери → малі.';}
 function checkProfileName(form){
  const input=form.elements.name,q=profileNameResult(input.value,form.id==='rename-form');
  input.setCustomValidity(q.error);form.querySelector('.profile-name-hint').textContent=profileNameHint(input.value,form.id==='rename-form');return q;
 }
 function modalMarkup(){
  if(!state.modal)return '';let title='',body='';
  if(state.modal==='provider'){const v=state.editProvider?source.providers.find(x=>x.id===state.editProvider):null;title=v?'Редагувати провайдера':'Новий провайдер';body=`<form id="new-provider" autocomplete="off"><div class="form-grid"><label class="field"><span class="field__lab">Назва</span><span class="field__win"><input name="name" required maxlength="80" value="${esc(v?.name||'')}" placeholder="Мій провайдер"></span></label><label class="field"><span class="field__lab">ID</span><span class="field__win"><input name="id" required pattern="[a-z0-9][a-z0-9_-]{0,63}" value="${esc(v?.id||'')}" ${v?'readonly':''} placeholder="my-provider"></span></label></div><label class="field"><span class="field__lab">Адреса API</span><span class="field__win"><input type="url" name="url" required value="${esc(v?.url||'')}" placeholder="https://api.example.com/v1"></span></label><div class="form-grid"><label class="field"><span class="field__lab">Формат API</span><span class="field__win"><select name="api">${[['openai-completions','OpenAI Chat'],['openai-responses','OpenAI Responses'],['anthropic-messages','Anthropic']].map(([k,l])=>`<option value="${k}" ${v?.api===k?'selected':''}>${l}</option>`).join('')}</select></span></label><label class="field"><span class="field__lab">Авторизація</span><span class="field__win"><select name="auth"><option value="apiKey">API-ключ</option><option value="none" ${v?.auth==='none'?'selected':''}>Без ключа</option></select></span></label></div><label class="field"><span class="field__lab">API-ключ ${v?.hasKey?'· залиш порожнім, щоб зберегти':''}</span><span class="field__win"><input type="password" name="key" autocomplete="new-password" placeholder="${v?.hasKey?'Збережений на сервері':'Ключ провайдера'}"></span></label><label class="field"><span class="field__lab">Список моделей</span><span class="field__win"><select name="discovery">${[['openai-models-list','Отримувати через /models'],['','Ввести вручну'],['ollama','Ollama'],['llama.cpp','llama.cpp'],['lm-studio','LM Studio'],['litellm','LiteLLM']].map(([k,l])=>`<option value="${k}" ${(v?v.discovery:'openai-models-list')===k?'selected':''}>${l}</option>`).join('')}</select></span></label><label class="field"><span class="field__lab">Додаткові ID моделей · по одному на рядок</span><span class="field__win"><textarea name="models" rows="3" placeholder="model-id">${esc(v?.manualModels?.join('\n')||'')}</textarea></span></label><label class="field"><span class="field__lab">Термін дії</span><span class="field__win"><select name="days">${v?.expires&&!v.expired?'<option value="-1" selected>Зберегти поточний термін</option>':''}<option value="0">Без обмеження</option><option value="1">24 години</option><option value="7">7 днів</option><option value="30">30 днів</option></select></span></label><p class="view-note">Після терміну невикористовуване підключення видаляється. Якщо воно ще є у профілях, панель позначить його простроченим і запропонує замінити моделі. Активні сесії не змінюються.</p><div class="modal-actions">${v?tool('Видалити','delete-provider','danger'):''}${tool(state.providerSaving?'Збереження…':'Зберегти провайдера','provider-create','primary',state.providerSaving?'disabled':'')}</div></form>`;}
  if(state.modal==='details'){title='Дані моделі';body=detailsMarkup();}
  if(state.modal==='conflict'){title='Змінились вихідні дані';body=`<p>${esc(state.error||'Конфігурацію змінено зовні.')}</p><p class="view-note">Твоя чернетка лишилась у вікні. Експортуй її перед завантаженням актуального профілю.</p><div class="modal-actions">${tool('Експорт чернеток','export-draft')}${tool('Скинути чернетки й оновити','discard-reload','primary')}</div>`;}
  if(state.modal==='history'){title=prettyProfile(state.profile);body=`<p>Збереження створює резервну копію. Відновлення поверне попередні налаштування та режим цього профілю.</p><div class="modal-actions">${tool('Відновити попередню','restore-profile','',source.restorable.includes(state.profile)?'':'disabled')}</div>`;}
  if(state.modal==='rename'){title='Перейменувати профіль';body=`<form id="rename-form"><label class="field"><span class="field__lab">Назва профілю</span><span class="field__win"><input name="name" required maxlength="64" aria-describedby="profile-name-hint" value="${esc(state.renameName??state.profile)}" autocomplete="off" spellcheck="false"></span></label><p id="profile-name-hint" class="view-note profile-name-hint" aria-live="polite">${esc(profileNameHint(state.renameName??state.profile,true))}</p><p class="view-note">Налаштування та чернетка збережуться.</p><div class="modal-actions">${tool('Скасувати','modal-close')}${tool(state.profileBusy?'Збереження…':'Перейменувати','rename-confirm','primary',state.profileBusy?'disabled':'')}</div></form>`;}
  if(state.modal==='delete-profile'){title='Видалити '+prettyProfile(state.profile)+'?';body=`<p>Профіль зникне зі списку та стане недоступним для нових запусків OMP. Збережена версія залишиться в резервній копії.</p>${diff(state.profile).length?'<p class="view-note">Незбережену чернетку цього профілю також буде видалено.</p>':''}<div class="modal-actions">${tool('Скасувати','modal-close')}${tool(state.profileBusy?'Видалення…':'Видалити профіль','delete-confirm','danger',state.profileBusy?'disabled':'')}</div>`;}
  if(state.modal==='clone'){title='Копія профілю';body=`<form id="clone-form"><label class="field"><span class="field__lab">Назва нового профілю</span><span class="field__win"><input name="name" required maxlength="64" aria-describedby="profile-name-hint" value="${esc(state.cloneName||'')}" placeholder="Standard FreeTier" autocomplete="off" spellcheck="false"></span></label><p id="profile-name-hint" class="view-note profile-name-hint" aria-live="polite">${esc(profileNameHint(state.cloneName||''))}</p><p class="view-note">Копіюється збережена конфігурація ${esc(prettyProfile(state.profile))}. Спочатку збережи чернетку, якщо вона потрібна в копії.</p>${tool('Створити','clone-create','primary')}</form>`;}
  return `<div class="modal-layer"><section class="modal ${state.modal==='details'?'model-detail':''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-top"><h2>${esc(title)}</h2>${tool(icon('x'),'modal-close','icon-only','aria-label="Закрити"')}</div>${state.modalError?`<p class="error-banner" role="alert">${esc(state.modalError)}</p>`:''}${body}</section></div>`;
 }
 async function saveProvider(){const f=win.querySelector('#new-provider');if(!f.reportValidity()||state.providerSaving)return;const d=new FormData(f);state.providerSaving=true;const body={id:d.get('id'),name:d.get('name'),url:d.get('url'),api:d.get('api'),auth:d.get('auth'),key:d.get('key'),discovery:d.get('discovery'),models:String(d.get('models')).split('\n').map(s=>s.trim()).filter(Boolean),days:Number(d.get('days')),revision:source.providerRevision};const b=f.querySelector('[data-action=provider-create]');b.disabled=true;b.textContent='Збереження…';try{await api('/api/provider',body);state.modal=null;state.modalError='';await reload();notify('Провайдер збережений. Каталог оновлюється.');}catch(e){regions.invalidate('modal');let error=f.querySelector('.form-error');if(!error){error=document.createElement('p');error.className='error-banner form-error';error.setAttribute('role','alert');f.prepend(error);}error.textContent=e.message;b.disabled=false;b.textContent='Зберегти провайдера';}finally{state.providerSaving=false;}}
 // OPERATOR — one control plane, three working surfaces.
 const op=ManaOperator;
 const healthNames={local:'Локально',healthy:'Є запас',risk:'Малий запас',empty:'Вичерпано',unknown:'Немає виміру',unavailable:'Недоступна'};
 const healthGlyph={local:'◈',healthy:'●',risk:'△',empty:'∅',unknown:'?',unavailable:'⊘'};
 let cutGesture=null;
 let opReportCache=null;
 function opHealth(model){return op.health({...model,free:priceInfo(model).kind==='free',expired:source.providers.find(v=>v.id===model.provider)?.expired},opReportCache||usageReports(),p().disabledProviders||[]);}
 function opRouteHealth(route){const m=split(route);return opHealth(catalogMap.get(m.raw)||m);}
 // A latching key: its LED follows aria-pressed / aria-expanded in CSS, so flipping it patches attributes only.
 function opSwitchKey(name,label,on,caption=''){return `<button type="button" class="key" data-op-switch="${name}" ${name==='cuts'?`aria-expanded="${on}" aria-controls="cuts-collection"`:`aria-pressed="${on}"`} title="${esc(caption||label)}">`;}
 function opSwitchFace(name,label){return `<span class="key__cap">${led(false,name==='cuts'?'blue':'green',' data-latch')}${label}</span>`;}
 // A switch as a region: flipping it patches the key's attributes, so the pressed key itself (and its focus) stays.
 function switchRegion(key,name,label,on,caption=''){return box(key,opSwitchKey(name,label,on,caption),[leaf(key+'/face',opSwitchFace(name,label))]);}
 function opSelect(id,label,value,items){const index=Math.max(0,items.findIndex(x=>x[0]===value));return `<div class="op-selector"><span class="selector-rocker" role="group" aria-label="Крок вибору: ${esc(label)}"><button type="button" data-select-step="${id}" data-direction="-1" aria-label="${esc(label)}: попереднє" ${index===0?'disabled':''}>−</button><button type="button" data-select-step="${id}" data-direction="1" aria-label="${esc(label)}: наступне" ${index>=items.length-1?'disabled':''}>+</button></span><label class="selector-content" for="${id}"><small>${esc(label)}</small><select id="${id}" aria-label="${esc(label)}">${items.map(([k,t])=>`<option value="${esc(k)}" ${k===value?'selected':''}>${esc(t)}</option>`).join('')}</select></label></div>`;}
 // Device selector window: a native <select> behind a milled window (the system picker stays on phones).
 function selWin(id,label,value,items,cls='sel--sm',attr=''){return `<div class="sel ${cls}"><label class="silk" for="${id}">${label}</label><div class="sel__win"><select id="${id}" ${attr}>${items.map(([k,t])=>`<option value="${esc(k)}" ${k===value?'selected':''}>${esc(t)}</option>`).join('')}</select><span class="sel__chev"></span></div></div>`;}

 function opPaceText(q){if(!q.kind||q.kind==='unknown')return q.label;if(q.kind==='empty')return 'Вичерпано';return (q.kind==='reserve'?'Запас':q.label)+(q.delta!=null&&q.kind!=='balanced'?' '+Math.round(Math.abs(q.delta))+'%':'');}
 function opForecast(q){return q.kind==='unknown'?'Без прогнозу':q.kind==='empty'?'До скидання':q.lasts?'≈ до скидання':q.eta>Date.now()?'≈ ще '+resetCountdown(q.eta).replace('↻ ',''):'≈ запас міг скінчитись';}
 function microDuration(at){const minutes=Math.max(1,Math.round((at-Date.now())/60000));return minutes>=1440?Math.floor(minutes/1440)+'д':minutes>=60?Math.floor(minutes/60)+'г':minutes+'хв';}
 function reportAge(r){if(!r.at)return 'Немає виміру';const minutes=Math.max(0,Math.floor((Date.now()/1000-r.at)/60));return minutes<1?'щойно':minutes<60?minutes+' хв тому':Math.floor(minutes/60)+' г тому';}
 // SCREENS — one black glass per provider account (ids `quota:<provider>:<n>` keep their stored hue), the
 // DeepSeek screen last with the tariff inside its glass and the mode switch on its chin. Every screen is its own
 // region; times (age, reset countdown) are filled by the 30-s tick, so a passing minute never rebuilds a screen.
 const SCREEN_HUE={ds:32,stu:250,cld:150,gpu:140,free:185,p5:300,p6:165,p7:75};
 const screenHue=provider=>SCREEN_HUE[providerSlot(provider)]??150;
 function hueEncoder(id,label,def){return `<div class="enc-wrap"><div class="ctl__read"><span class="silk">тон</span><output class="rd" style="--rd:4ch" data-screen-hue-out="${esc(id)}">${ManaScreen.hueText(def)}</output></div>${ManaScreen.hueEncoderHTML(id,{label,def,value:def})}</div>`;}
 const GLASS_OPEN=['<div class="screen__win">','<div class="screen__gasket">','<div class="glass">'];
 const glass=inner=>`${GLASS_OPEN.join('')}<div class="glass__content"><div class="g">${inner}</div></div><div class="glass__sweep"></div></div></div></div>`;
 function nest(key,opens,children){let out=children;for(let i=opens.length-1;i>=0;i--)out=[box(key+(i?'/'+i:''),opens[i],out)];return out[0];}
 const segments=p=>p<=0?0:Math.max(1,Math.round(p/5))/20;
 function winCell(l,r,name){
  const q=op.pace(l,r),left=l.remaining,label=limitLabel(l),reset=`<span data-reset="${Number(l.resets)||0}"></span>`;
  const title=esc(label+' · '+opPaceText(q)+' · '+opForecast(q)+' · '+resetTitle(l.resets)+(q.estimated?' · Лінійна оцінка за тривалістю вікна':''));
  if(left==null)return `<div class="win" title="${title}"><div class="win__top"><span class="win__l">${esc(label)}</span><b class="win__v">—</b></div><div class="meter is-unknown" role="img" aria-label="${esc(name+' '+label)}: немає виміру"><span class="meter__unlit"></span></div><span class="meter__scale"></span><div class="win__row">${reset}</div><div class="win__row"><span class="pace is-even">?</span><span>немає виміру</span></div></div>`;
  const stale=r.stale,s=left<10?'bad':left<25?'warn':'',delta=q.delta||0,pace=q.kind==='unknown'?['is-even','?']:q.kind==='empty'?['is-minus','∅']:delta>2?['is-minus','−'+Math.round(delta)+'%']:delta< -2?['is-plus','+'+Math.round(-delta)+'%']:['is-even','±'+Math.round(Math.abs(delta))+'%'];
  const forecast=stale?'≈ —':q.kind==='unknown'?'':q.kind==='empty'?'∅':q.lasts?'до ↻':q.eta>Date.now()?'≈'+microDuration(q.eta):'≈вич.',marker=!stale&&q.expected!=null?`;--m:${+((100-q.expected)/100).toFixed(3)}`:'';
  return `<div class="win${stale?' is-stale':''}" title="${title}"><div class="win__top"><span class="win__l">${esc(label)}</span><b class="win__v">${num(left)}%</b></div><div class="meter${stale?' is-stale':''}"${s?` data-s="${s}"`:''} style="--q:${segments(left)}${marker}" role="meter" aria-label="${esc(name+' '+label+' залишок')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${left}"><span class="meter__unlit"></span><span class="meter__lit"><i></i></span>${marker?'<span class="meter__pace" title="Рівномірний темп"></span>':''}</div><span class="meter__scale"></span><div class="win__row">${reset}</div><div class="win__row"><span class="pace ${pace[0]}">${esc(pace[1])}</span><span>${esc(forecast)}</span></div></div>`;
 }
 function screenHead(r,name,mode=''){const stale=r.at&&r.stale;return `<div class="g-head"><span class="g-name" title="${esc(name)}">${esc(name)}</span><span class="g-age${stale?' is-stale':''}" title="${esc(timeLabel(r.at))}"><span data-age="${r.at||0}"></span>${stale?' · застаріло △':''}</span><span class="g-grow"></span>${mode||'<span class="g-reels" aria-hidden="true"><i></i><i></i></span>'}</div>`;}
 const winsMarkup=(r,name)=>r.limits.length?`<div class="wins">${r.limits.map(l=>winCell(l,r,name)).join('')}</div>`:`<div class="g-empty"><span class="g-empty__glyph">∅</span><span>Ще немає вимірів</span></div>`;
 const screenId=r=>r.provider==='@tariff'?'tariff':'quota:'+r.provider+':'+r.account;
 function screenLegend(ds,families){return `<p class="print screen__legend" aria-label="Легенда екранів"><span>+ запас / − перевитрата · % від повного ліміту</span><span>≈ прогноз · ↻ скидання${ds?' · ▨ пік DeepSeek':''}</span>${families?'<span>Anthropic / Google / OpenAI — окремі сімейства Antigravity</span>':''}</p>`;}
 function quotaScreen(r,legend){
  const id=screenId(r),name=r.name,def=screenHue(r.provider);
  return `<div class="screen" data-screen="${esc(id)}" data-screen-default="${def}" data-meter-provider="${esc(r.provider)}">${glass(screenHead(r,name)+winsMarkup(r,name))}<div class="screen__chin"><span class="screen__id" title="${esc(r.at?r.stale?'Застарілий вимір':'Свіжий вимір':'Немає виміру')}">${led(!!r.at,r.stale?'amber':'green')}<span class="silk">${esc(providerCode(r.provider))}</span></span>${legend||'<span class="strip__grow"></span>'}${hueEncoder(id,name,def)}</div></div>`;
 }
 // The DeepSeek screen: limits + tariff on one glass, the mode line reserved under them; switch and keys on its chin.
 function deepSeekScreen(r){
  const id=screenId(r),name=r.name,def=SCREEN_HUE.ds,mode=`<span class="g-mode">${modeOff()?'OFF · заміни':'ON · оригінал'}</span>`;
  return box('screen:'+id,`<div class="screen screen--ds" data-screen="${esc(id)}" data-screen-default="${def}" data-meter-provider="${esc(r.provider)}">`,[
   nest(id+'/win',GLASS_OPEN,[nest(id+'/content',['<div class="glass__content">','<div class="g">'],[leaf('p/mode-head',screenHead(r,name,mode)),box(id+'/split','<div class="g-split">',[leaf(id+'/wins',r.limits.length?winsMarkup(r,name)+'<span class="g-vsep"></span>':''),leaf('p/tariff',tariffMarkup())]),leaf('p/mode-msg',modeMessage())]),leaf(id+'/sweep','<div class="glass__sweep"></div>')]),
   box(id+'/chin','<div class="screen__chin">',modeChin(id))]);
 }
 function usageScreens(){
  const reports=opReportCache||usageReports(),counts=new Map(),accounts=new Map();
  for(const r of reports)counts.set(r.provider,(counts.get(r.provider)||0)+1);
  const rows=reports.map(r=>{const account=(accounts.get(r.provider)||0)+1;accounts.set(r.provider,account);return {...r,account,name:providerName(r.provider)+(counts.get(r.provider)>1?' #'+account:'')};});
  const dsOn=deepSeekCatalog||modeOff(),at=dsOn?rows.findIndex(r=>catalog.some(m=>m.provider===r.provider&&deepseek(m.provider+'/'+m.id))):-1;
  const ds=at>=0?rows.splice(at,1)[0]:dsOn?{provider:'@tariff',account:1,name:'DeepSeek · тариф',at:0,limits:[],stale:false}:null;
  return {rows,ds};
 }
 function hasDeepSeekScreen(){return state.view==='profiles'&&(deepSeekCatalog||modeOff());}
 function screensBank(){
  if(state.view!=='profiles')return [leaf('meters/key',''),leaf('meters/bank',''),leaf('seam:screens','')];
  const {rows,ds}=usageScreens();if(!rows.length&&!ds)return [leaf('meters/key',''),leaf('meters/bank',''),leaf('seam:screens','')];
  let wide=-1;rows.forEach((r,i)=>{if(wide<0||r.limits.length>rows[wide].limits.length)wide=i;});
  const families=rows.some(r=>r.provider==='google-antigravity'),legend=screenLegend(!!ds,families);
  const screens=rows.map((r,i)=>leaf('screen:'+screenId(r),quotaScreen(r,i===wide?legend:'')));
  if(ds)screens.push(deepSeekScreen(ds));
  return [leaf('meters/key',rows.length?`<button type="button" class="key key--wide screens__key" data-action="meters-mobile" aria-expanded="${!!state.mobileMeters}" aria-controls="meter-bank"><span class="key__cap"><span class="key__lbl">${led(false,'green',' data-latch')}Ліміти</span><span class="rd" style="--rd:2ch">${rows.length}</span></span></button>`:''),
   box('meters/bank',`<section class="screens" id="meter-bank" aria-label="Панель підписок: залишки, скидання та темп" data-mobile-expanded="${!!state.mobileMeters}">`,screens),leaf('seam:screens','<div class="seam"></div>')];
 }
 // The dock: selectors, ⋯, switches, the feedback line and the printed context are separate regions, so an edit
 // repaints only what changed and a switch only its key's attributes.
 function operatorDock(dirty=[]){
  const others=dirty.filter(k=>k!==state.profile),drafts=others.length?`<br><span title="${esc(others.map(prettyProfile).join(', '))}">чернетки: ${esc(others.map(prettyProfile).join(', '))}</span>`:'';
  const ctx=state.view==='profiles'?'Котушка застосовується<br>до нових запусків OMP':state.view==='models'?'<b>02 · Колекція</b><br>CUTS / провайдери / тести / ціни':'<b>03 · Історія</b><br>виміри OMP · усі проєкти OMP';
  return box('dock','<section class="bay dock" aria-label="Пульт оператора">',[
   leaf('dock/selection',`${selWin('project-choice','Проєкт',source.projectId,(source.projects||[]).map(x=>[x.id,x.name]),'sel--proj',state.saving?'disabled':'')}${selWin('profile-choice','Профіль /<br>котушка',state.profile,profileKeys.map(k=>[k,prettyProfile(k)]),'sel--prof')}`),
   leaf('dock/menu',profileMenu()),leaf('dock/sep','<span class="seam seam--v"></span>'),dockSwitches(),
   leaf('feedback',operatorFeedback()),leaf('dock/context',`<p class="dock__ctx print">${ctx}${drafts}</p>`)]);
 }
 function profileMenu(){
  const std=state.profile==='standard',item=(label,action,attr='',cls='')=>`<button type="button" class="key key--menu ${cls}" role="menuitem" data-action="${action}" ${attr}><span class="key__cap">${label}</span></button>`;
  return `<details class="dock__menu"><summary class="key key--sq" aria-label="Дії з профілем" title="Дії котушки"><span class="key__cap">${SVG.more}</span></summary><div class="menu" role="menu" aria-label="Дії котушки"><div class="menu__head"><span class="silk">Котушка · ${esc(prettyProfile(state.profile))}</span></div><div class="menu__bed">${item('+ Копія','clone-profile')}${item('Перейменувати','rename-profile',std?'disabled':'')}${item('Попереднє збереження','history')}${item('Скинути чернетку','reset-draft',state.changes?'':'disabled')}<div class="menu__sep" role="separator"></div>${item(led(true,'red')+'Видалити','delete-profile',std?'disabled':'','key--danger')}</div></div></details>`;
 }
 function dockSwitches(){return box('dock/switches','<div class="dock__grp">',[switchRegion('dock/health','health','HEALTH',state.health,'HEALTH · ресурс підписок на CUTS'),switchRegion('dock/cuts','cuts','CUTS',state.cuts,'Колекція CUTS')]);}
 // One printed status line with a reserved height: an action's result, or an error (red LED + ×). Never reflows.
 function operatorFeedback(){
  const error=state.error&&state.modal!=='conflict'?state.error:'',text=error||(state.view==='profiles'?state.opFeedback||'':'');
  return `<div class="dock__msg"><div class="msg"${error?' data-s="bad" role="alert"':' role="status"'}${text?` title="${esc(text)}"`:''}>${text?led(true,error?'red':'green'):''}<span>${esc(text)}</span>${error?key(SVG.close,'clear-error','key--sm key--sq','aria-label="Закрити повідомлення"'):''}</div></div>`;
 }
 function opRecords(m){return modelRecords(m).filter(b=>evidence.kind(b)==='benchmark'&&b.source===state.benchSource);}
 // One role score per model and evidence slice; the slice key changes with the snapshot, role, source and release.
 function opEvidence(m){
  const slice=dataVersion+'|'+state.role+'|'+state.benchSource+'|'+state.benchRelease;if(opEvidence.slice!==slice){opEvidence.slice=slice;opEvidence.memo=new WeakMap();}
  if(opEvidence.memo.has(m))return opEvidence.memo.get(m);const q=evidenceFor(m);opEvidence.memo.set(m,q);return q;
 }
 function evidenceFor(m){
  const weights=(state.benchSource==='Artificial Analysis'?source.insights?.benchmarks?.weightsAA:source.insights?.benchmarks?.weights)?.[state.role];
  const rows=opRecords(m).filter(b=>!state.benchRelease||b.release===state.benchRelease),q=op.evidence(rows,weights);
  return q?{...q,weights}:null;
 }
 function opProviderItems(all=false){return [['all','Усі'],...source.providers.filter(v=>all||((v.connected||v.used.length)&&!(p().disabledProviders||[]).includes(v.id)&&!v.expired)).map(v=>[v.id,providerName(v.id)]).sort((a,b)=>a[1].localeCompare(b[1]))];}
 function analyticalProviders(){const ids=state.catalogMode==='mine'?myProviderIds():state.catalogMode==='free'?new Set(catalog.filter(m=>priceInfo(m).kind==='free').map(m=>m.provider)):null;return opProviderItems(true).filter(([id])=>id==='all'||!ids||ids.has(id));}
 // The drawer collection without its search words. It is filtered and sorted again only when a filter, the
 // profile's providers or the snapshot changes; a keystroke then only scans precomputed search keys.
 function collectionBase(){
  const t=state.cutTarget,key=JSON.stringify([dataVersion,state.profile,p().disabledProviders||[],t?.role,t?.group,t?.group==='vibe'?vibeAlias(t.role):'',state.cutProvider,state.freeCuts,state.cutHealth,state.cutHealth==='all'?0:(opReportCache||usageReports()).map(r=>[r.provider,r.stale])]);
  if(collectionBase.key===key)return collectionBase.rows;
  const rows=catalog.filter(m=>(!t||acceptsRoleModel(t.role,t.group||'role',m))&&(m.available||source.providers.find(v=>v.id===m.provider)?.connected)&&!routeWarning(m.provider+'/'+m.id)&&(state.cutProvider==='all'||m.provider===state.cutProvider)&&(!state.freeCuts||priceInfo(m).kind==='free')&&(state.cutHealth==='all'||opHealth(m).kind===state.cutHealth)).map(m=>({m,provider:providerName(m.provider)}));
  rows.sort((a,b)=>collate(a.m.name,b.m.name)||collate(a.provider,b.provider)||collate(a.m.id,b.m.id));
  collectionBase.key=key;return collectionBase.rows=rows.map(x=>x.m);
 }
 function collectionCuts(){const words=queryWords(state.cutQuery),rows=collectionBase();return words.length?rows.filter(m=>matchesWords(words,searchKey(m).cut)):rows;}
 // DRAWER — the CUTS collection pinned to the viewport bottom within the body. Its front edge (the lip) carries
 // the transport permanently; the body is rendered while it is open (and while it slides away).
 function cutsTray(){
  const open=!!state.cuts,body=open||drawerOpenShown||!!drawerClosing,t=transportParts(),cuts=collectionCuts();
  return box('drawer','<div class="tray-port">',[box('drawer/tray',trayOpen(),[
   box('drawer/lip','<div class="tray__lip">',[
    leaf('drawer/grip','<div class="tray__grip" id="cuts-resize" role="separator" tabindex="0" aria-orientation="horizontal" aria-controls="cuts-collection" aria-label="Висота лотка CUTS" title="Тягни вгору або вниз, щоб змінити висоту · ↑ / ↓ · Home / End · Enter відкриває й закриває"></div>'),
    box('drawer/title',`<button type="button" class="tray__title" data-action="cuts-toggle" aria-expanded="${open}" aria-controls="tray-body">`,[leaf('drawer/title/face',`${led(false,'blue',' data-latch')}<span class="silk">Колекція CUTS</span>`),leaf('drawer/count',drawerCount(cuts)),leaf('drawer/hint',drawerHint())]),
    leaf('drawer/armed',armedMarkup()),leaf('drawer/pull','<span class="tray__pull" aria-hidden="true"></span>'),
    box('drawer/transport',`<div class="tray__transport transport" role="group" aria-label="Зміни: ${t.pool?'FREE пули':t.scope?'заміни':'котушка'}">`,[leaf('tp/scope',t.scopeHtml),leaf('tp/undo',t.undo),leaf('tp/redo',t.redo),leaf('tp/state',t.state),leaf('tp/save',t.save)]),
    leaf('drawer/chev','<span class="tray__chev" aria-hidden="true"></span>')]),
   box('drawer/body','<div class="tray__body" id="tray-body">',[
    box('drawer/controls','<div class="tray__filters">',[leaf('drawer/provider',selWin('cut-provider','Провайдер',state.cutProvider,opProviderItems())),switchRegion('drawer/free','free','FREE CUTS',state.freeCuts,'Лише підтверджені FREE CUTS'),leaf('drawer/health',selWin('cut-health','Запас',state.cutHealth,[['all','Будь-який'],...Object.entries(healthNames).filter(([k])=>k!=='unavailable')])),leaf('drawer/search',drawerSearch())]),
    leaf('drawer/results',body?drawerResults(cuts):'<div class="tray__grid"></div>')])])]);
 }
 function drawerHint(){const t=state.cutTarget;return t?`<span class="tray__hint tray__hint--target">· місце: ${esc(t.role)} · ${t.index===0?'основна':'резерв '+t.index}</span>`:`<span class="tray__hint">· ${narrowSurface()?'обери CUT і торкнись гнізда':'перетягни CUT на доріжку або обери CUT і місце'}</span>`;}
 function armedMarkup(){const r=state.armedCut;if(!r)return '<span class="tray__armed" aria-live="polite"></span>';const name=poolNames[poolName(r)]||cutTitle(r);return `<span class="tray__armed" aria-live="polite">${led(true,'blue')}<span class="tray__armed-txt"><small>Обрано · торкнись CUT для заміни або гнізда «+»</small><b title="${esc(name+(poolName(r)?'':' · '+providerName(split(r).provider)))}">${esc(name)}</b></span><button type="button" class="key" data-action="cancel-cut"><span class="key__cap">Скасувати</span></button></span>`;}
 function drawerSearch(){return `<label class="search">${SVG.search}<input id="cut-query" type="search" aria-label="Знайти CUT у колекції" placeholder="Знайти CUT…" value="${esc(state.cutQuery)}" autocomplete="off"></label>`;}
 function drawerCount(cuts){return `<span class="tray__count"><span class="rd" style="--rd:3ch">${cuts.length}</span> CUTS</span>`;}
 function drawerCut(m){
  const route=m.provider+'/'+m.id,deleted=deletedCut(route),free=!deleted&&freeRoute(route),health=healthMarks(route),title=cutTitle(route),provider=providerName(m.provider),armed=state.armedCut===route;
  return `<button type="button" class="cut${free?' cut--free':''}${deleted?' cut--deleted':''}${armed?' is-armed':''}" data-p="${providerSlot(m.provider)}" data-cut="${esc(route)}" aria-pressed="${armed}" aria-label="${esc(title+' · '+provider+(free?' · FREE':'')+' · '+route)}" title="${esc(title+'\n'+route)}"><span class="cut__edge"></span><span class="cut__name cut__name--split">${nameMarkup(title)}</span><span class="cut__meta">${health.glyph}<b class="tag" data-p="${providerSlot(m.provider)}">${esc(providerCode(m.provider))}</b><span class="cut__think">${m.reasoning===false?'без thinking':isLocal(m.provider)?'локально':'типово'}</span>${deleted?'<span class="stamp stamp--del">DELETED</span>':''}</span>${free?'<span class="stamp stamp--free">FREE</span>':''}${health.bar}</button>`;
 }
 function drawerResults(cuts){
  const shown=cuts.slice(0,state.cutLimit||60),key=esc(JSON.stringify([state.cutProvider,state.cutHealth,state.freeCuts,state.cutQuery]));
  if(!shown.length)return `<div class="tray__grid is-empty" data-filter-key="${key}"><div class="empty"><span class="empty__glyph" aria-hidden="true">∅</span><span>${state.cutQuery.trim()?`Нічого не знайдено за «<b>${esc(state.cutQuery.trim())}</b>»`:'Немає CUTS за цими фільтрами'}</span>${state.cutQuery.trim()?'<button type="button" class="key key--sm" data-action="cuts-clear"><span class="key__cap">Очистити</span></button>':''}</div></div>`;
  return `<div class="tray__grid" data-filter-key="${key}">${shown.map(drawerCut).join('')}${cuts.length>shown.length?`<div class="tray__more"><button type="button" class="key key--sm" data-action="cuts-more"><span class="key__cap">Ще ${Math.min(60,cuts.length-shown.length)}</span></button></div>`:''}</div>`;
 }
 let drawerGesture=null,drawerClosing=0,drawerOpenShown=false;
 // Geometry of the fixed drawer: as wide as the body (8px from each edge on a phone); its height keeps ≈220px of
 // the page visible, and the spacer after the body equals the drawer, so every lane can be scrolled above it.
 // The default follows the window; only a user resize is remembered, and a smaller window never overwrites it.
 const DRAWER_MIN=180,DRAWER_KEEP=220;
 function drawerParts(){const port=win.querySelector('.tray-port'),tray=port?.querySelector('.tray');return tray?{port,tray,grip:port.querySelector('#cuts-resize'),spacer:win.querySelector('.tray-spacer'),device:win.querySelector('.device')}:null;}
 // The read pass: everything the write pass needs, measured once (per gesture, render or window resize).
 function drawerLimits(parts){
  const page=document.documentElement,viewport=page.clientHeight||window.innerHeight,width=page.clientWidth||window.innerWidth;
  const lip=parseFloat(getComputedStyle(parts.port).getPropertyValue('--lip'))||46,box=width>760?parts.device?.getBoundingClientRect():null;
  const max=Math.round(Math.max(DRAWER_MIN,lip+96,viewport-DRAWER_KEEP));
  return {viewport,lip,max,min:Math.min(max,DRAWER_MIN),left:box?Math.round(box.left):8,width:box?Math.round(box.width):width-16};
 }
 function resizeDrawer(height,remember=false){
  const parts=drawerParts();if(!parts){document.documentElement.style.removeProperty('scroll-padding-bottom');return;}
  setDrawerHeight(parts,height,drawerLimits(parts),remember);
 }
 // The write pass: port, drawer, spacer and the page's scroll padding take their sizes directly; no inherited
 // custom property changes, so a resize restyles these few elements instead of the whole window.
 function setDrawerHeight({port,tray,grip,spacer},height,{viewport,lip,max,min,left,width},remember=false){
  const preferred=Number.isFinite(height)?height:Math.min(290,viewport*.43);
  height=Math.round(Math.max(min,Math.min(max,preferred)));
  if(remember)state.drawerHeight=height;
  port.style.left=left+'px';port.style.width=width+'px';port.style.height=(height+40)+'px';tray.style.height=height+'px';
  const open=!!state.cuts,shown=open?height:lip;
  // On close the page shrinks only after the drawer slid in; on open it grows at once.
  if(spacer&&(open||!drawerClosing))spacer.style.height=(shown+28)+'px';
  document.documentElement.style.setProperty('scroll-padding-bottom',(shown+12)+'px');
  grip.setAttribute('aria-valuemin',min);grip.setAttribute('aria-valuemax',max);grip.setAttribute('aria-valuenow',height);grip.setAttribute('aria-valuetext',height+' пікселів');
 }
 function finishDrawerResize(cancel=false){
  const g=drawerGesture;if(!g)return;drawerGesture=null;if(g.frame)cancelAnimationFrame(g.frame);g.parts.tray.classList.remove('is-resizing');
  if(cancel){state.drawerHeight=g.preferred;resizeDrawer(state.drawerHeight);}else{if(g.next!=null)setDrawerHeight(g.parts,g.next,g.limits,true);storeOperator();}
  if(root.hasPointerCapture(g.pointer))root.releasePointerCapture(g.pointer);render();
 }
 root.addEventListener('pointerdown',e=>{
  const grip=e.target.closest('#cuts-resize');if(!grip||e.button!==0||drawerGesture)return;
  e.preventDefault();grip.focus({preventScroll:true});
  // The grip of a closed drawer opens it; geometry is then read once per gesture.
  if(!state.cuts){state.cuts=true;render();}
  const parts=drawerParts();if(!parts)return;
  drawerGesture={pointer:e.pointerId,y:e.clientY,height:parts.tray.getBoundingClientRect().height,preferred:state.drawerHeight,parts,limits:drawerLimits(parts),next:null,frame:0};
  parts.tray.classList.add('is-resizing');root.setPointerCapture(e.pointerId);
 });
 // A move only records the height; it is written at most once per frame.
 root.addEventListener('pointermove',e=>{const g=drawerGesture;if(g?.pointer!==e.pointerId)return;e.preventDefault();g.next=g.height+g.y-e.clientY;g.frame||=requestAnimationFrame(()=>{g.frame=0;if(drawerGesture===g)setDrawerHeight(g.parts,g.next,g.limits,true);});});
 root.addEventListener('pointerup',e=>{if(drawerGesture?.pointer===e.pointerId)finishDrawerResize();});
 root.addEventListener('pointercancel',()=>finishDrawerResize(true));
 root.addEventListener('lostpointercapture',()=>finishDrawerResize(true));
 window.addEventListener('blur',()=>finishDrawerResize(true));
 root.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&drawerGesture){e.preventDefault();finishDrawerResize(true);return;}
  if(e.target.id!=='cuts-resize')return;
  if(e.key==='Enter'||e.key===' '){e.preventDefault();toggleDrawer(!state.cuts);return;}
  if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;
  e.preventDefault();if(!state.cuts){state.cuts=true;render();}
  resizeDrawer(e.key==='Home'?0:e.key==='End'?window.innerHeight:e.target.closest('.tray').getBoundingClientRect().height+(e.key==='ArrowUp'?24:-24),true);storeOperator();
 });
 function toggleDrawer(open){if(!open){state.armedCut=state.armedCut&&narrowSurface()?state.armedCut:null;state.cutTarget=null;}state.cuts=open;render();storeOperator();}
 // After a render: the drawer is placed when it or the body changed; a closing drawer frees the page after its slide.
 function settleDrawer(out,force=false){
  const open=!!state.cuts;
  if(open!==drawerOpenShown){
   drawerOpenShown=open;clearTimeout(drawerClosing);drawerClosing=0;
   if(!open){const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;drawerClosing=setTimeout(()=>{drawerClosing=0;resizeDrawer(state.drawerHeight);if(!state.cuts)paintRegions([leaf('drawer/results','<div class="tray__grid"></div>')]);},reduced?0:430);}
   force=true;
  }
  if(force||out.all||touched(out,'drawer')||touched(out,'main')||touched(out,'meters'))resizeDrawer(state.drawerHeight);
 }
 // An armed CUT stays placeable when the drawer filters change; only real availability decides.
 function placeCut(route,target){
  if(!poolName(route)){const m=catalogMap.get(route);if(!m||m.status==='missing'||!(m.available||source.providers.find(v=>v.id===m.provider)?.connected)||routeWarning(route)){notify('Цей CUT зараз недоступний. Обери інший.');return;}}
  commitCut(route,{...target,profile:state.profile,expected:chain(target.role,target.group||'role')[target.index]??null});
 }
 // `off` is offered for every CUT, so it survives a replacement; other efforts only when the new model lists them.
 function carryEffort(effort,raw){if(!effort)return '';if(effort==='off')return 'off';const t=catalogMap.get(raw)?.thinking,efforts=Array.isArray(t)?t:Array.isArray(t?.efforts)?t.efforts:[];return efforts.includes(effort)?effort:'';}
 function commitCut(route,target){
  if(state.saving)return;if(poolName(route)&&!source.freePools?.[poolName(route)]?.length){notify('Спочатку наповни й збережи цей пул.');return;}
  const {role,index,group='role'}=target;
  if(group!=='alternatives'&&group!=='pool'&&projectionPending()){notify('Ще розраховується режим. Спробуй за мить.');return;}
  if(target.profile!==state.profile||(chain(role,group)[index]??null)!==target.expected){state.cutTarget=null;state.armedCut=null;notify('Доріжка змінилася. Обери місце ще раз.');return;}
  if(group==='alternatives'&&!poolName(route)&&deepseek(route)){notify('Заміна має бути без платного DeepSeek. FREE DeepSeek можна.');return;}
  if(modeOff()&&deepseek(route)){notify('Для платного DeepSeek увімкни режим «Із DeepSeek».');return;}
  if(!poolName(route)&&routeWarning(route)){notify('Цей маршрут зараз недоступний. Обери CUT іншого провайдера.');return;}
  const list=chain(role,group),old=list[index]?split(list[index]):null,effort=carryEffort(old?.effort,route);
  const existing=list.findIndex(r=>split(r).raw===route);if(existing>=0){const [cut]=list.splice(existing,1);list.splice(Math.min(index,list.length),0,cut);}else{list[index]=route+(effort?':'+effort:'');}
  if(list.length>(group==='pool'?Infinity:group==='vibe'?30:group==='alternatives'?12:31)){notify('Доріжка вже має максимальну кількість CUTS.');return;}
  if(!setChain(role,list,group,existing>=0?{inserted:Math.min(index,list.length-1)}:{}))return;
  state.cutTarget=null;state.armedCut=null;if(narrowSurface())state.cuts=false;
  state.opFeedback=withNotes('Вставлено '+short(split(route).id)+' · '+providerName(split(route).provider)+' → '+role+(old?.effort&&!effort&&existing<0&&!thinkingOff(role,group)?' · thinking → типово':''));render();if(narrowSurface()){pickerFocus({role,index,group});scrollToControl(document.activeElement);}
 }
 function contextTokens(n){return n>=1e6?num(n/1e6)+'M':num(n/1e3)+'K';}
 function opPriceValue(m){const q=priceInfo(m);return q.kind==='free'?0:Number.isFinite(m.cost?.input)&&Number.isFinite(m.cost?.output)&&(m.cost.input||m.cost.output)?(m.cost.input+m.cost.output)/2:null;}
 function analyticalModels(){
  const mine=myProviderIds(),words=queryWords(state.catalogQuery),favs=new Set(state.favs),changed=new Set(source.changes.map(x=>x.route));
  let rows=catalog.filter(m=>(state.catalogMode!=='mine'||mine.has(m.provider))&&(state.catalogProvider==='all'||m.provider===state.catalogProvider)&&matchesWords(words,searchKey(m).cut)&&(state.catalogMode!=='free'||priceInfo(m).kind==='free')&&(state.catalogMode!=='used'||referenced.has(m.provider+'/'+m.id))&&(state.catalogMode!=='fav'||favs.has(m.provider+'/'+m.id))&&(state.catalogMode!=='changes'||changed.has(m.provider+'/'+m.id)));
  rows=rows.filter(m=>!state.catalogEvidence||state.catalogEvidence==='all'||evidenceCoverage(m).kind===state.catalogEvidence);
  // Sort keys are computed once per row, not inside the comparator.
  const keyed=rows.map(m=>{const score=opEvidence(m)?.score??-1,cost=opPriceValue(m)??Infinity,coverage=state.catalogSort==='evidence'?evidenceCoverage(m):null;return {m,score,cost,coverage,value:score>=0&&cost>0&&cost<Infinity?score/cost:-Infinity};});
  keyed.sort(state.catalogSort==='evidence'?(a,b)=>b.coverage.sources.length-a.coverage.sources.length||b.coverage.claims-a.coverage.claims||collate(a.m.name,b.m.name):state.catalogSort==='price'?(a,b)=>a.cost-b.cost||b.score-a.score:state.catalogSort==='value'?(a,b)=>b.value-a.value||b.score-a.score:state.catalogSort==='name'?(a,b)=>collate(a.m.name,b.m.name):(a,b)=>b.score-a.score||a.cost-b.cost);
  return keyed.map(x=>x.m);
 }
 // Колекція screens: the price × score scatter and the inspector on black glass, each with its own ТОН encoder.
 function analyzerPlot(rows){
  const rated=rows.map(m=>({m,q:opEvidence(m),cost:opPriceValue(m)})).filter(x=>x.q&&x.cost!==null),paid=rated.filter(x=>x.cost>0),minCost=Math.min(.1,...paid.map(x=>x.cost)),maxCost=Math.max(10,...paid.map(x=>x.cost)),selected=state.analyze||rows[0]?.provider+'/'+rows[0]?.id;
  const xpos=cost=>cost===0?.05:.17+Math.log(cost/minCost)/Math.log(maxCost/minCost)*.79,f=v=>v.toFixed(4);
  const ticks=[...new Set([minCost,...[.01,.1,1,10,100].filter(n=>n>minCost&&n<maxCost),maxCost])];
  const chosen=rated.find(x=>x.m.provider+'/'+x.m.id===selected);
  const plot=rated.length?`<div class="g-plot" role="group" aria-label="Оцінка ролі та довідкова API ціна"><div class="g-plot__zone" style="--w:.11"><span>FREE</span></div>${ticks.map(n=>`<i class="g-plot__tick" style="--x:${f(xpos(n))}"></i>`).join('')}${rated.slice(0,180).map(({m,q,cost})=>{const route=m.provider+'/'+m.id,active=route===selected,label=cutTitle(route)+' · '+providerName(m.provider)+' · оцінка '+num(q.score)+' · $'+num(cost);return `<button type="button" class="g-plot__pt${cost===0?' is-free':''}" data-analyze="${esc(route)}" style="--x:${f(xpos(cost))};--y:${f(q.score/100)}" aria-pressed="${active}" aria-label="${esc(label)}" title="${esc(label)}"></button>`;}).join('')}<div class="g-plot__y"><span>100</span><span>50</span><span>0</span></div></div><div class="g-plot__x g-plot__x--abs"><span style="--x:${f(xpos(0))}">FREE</span>${ticks.map(n=>`<span style="--x:${f(xpos(n))}">$${n<.1?n.toPrecision(1):num(n)}</span>`).join('')}</div>`:`<div class="g-empty"><span class="g-empty__glyph">∅</span><span>Немає зіставних тестів і цін для цього зрізу</span></div>`;
  return `<div class="screen screen--wide" data-screen="analysis" data-screen-default="200">${glass(`<div class="g-head"><span class="g-name">ЦІНА × ТЕСТИ</span><span class="g-age">${esc(state.benchSource)} · ${esc(state.benchRelease)}</span><span class="g-grow"></span>${chosen?`<span class="g-acc g-head__sel">${esc(cutTitle(chosen.m.provider+'/'+chosen.m.id))} · ${num(chosen.q.score)}</span>`:''}</div>${plot}<div class="g-legend"><span>оцінка ролі / 100</span><span>середнє input / output · <b>$</b>/1M · лог. шкала</span><span>довідкова ціна API, не рахунок підписки${rated.length>180?' · на графіку перші 180':''}</span></div>`)}<div class="screen__chin"><span class="screen__id">${led(rated.length>0,'green')}<span class="silk">аналіз</span></span><span class="strip__grow"></span>${hueEncoder('analysis','Ціна × тести',200)}</div></div>`;
 }
 function providerFitStrip(rows){
  if(state.catalogProvider!=='all')return '';
  const best=new Map();for(const m of rows){const q=opEvidence(m);if(q&&(!best.has(m.provider)||best.get(m.provider).q.score<q.score))best.set(m.provider,{m,q});}
  return `<p class="role-comparison-label">Найкращі тестовані CUTS провайдерів · ${esc((labels[state.role]||state.role))}</p><div class="provider-fits" aria-label="Найкращі тестовані моделі провайдерів для ролі">${[...best.values()].sort((a,b)=>b.q.score-a.q.score).slice(0,5).map(({m,q})=>`<button type="button" data-catalog-provider="${esc(m.provider)}"><span>${esc(providerName(m.provider))}<b>${num(q.score)}</b></span><small>${esc(cutTitle(m.provider+'/'+m.id))} · ${esc(q.record.effort||'типово')}</small></button>`).join('')}</div>`;
 }

 function evidenceRows(m){
  return evidence.summary(modelRecords(m)).map(r=>{const kind=evidence.kind(r),[label,s]=kind==='developer'?['заява розробника','warn']:kind==='preference'?['Arena · уподобання','']:['незалежний тест','ok'];const [k,v]=Object.entries(r.scores||{})[0]||[];
   const value=kind==='preference'?num(r.rating):v!=null?num(v)+'%':'—';
   return `<div class="g-kv" title="${esc((kind==='developer'?r.publisher:r.source)+' · '+(r.release||'')+' · '+r.id+(r.effort?' · '+r.effort:''))}"><span><span class="g-chip"${s?` data-s="${s}"`:''}>${esc(kind==='developer'?r.publisher:r.source)}</span> ${esc(kind==='preference'?label:(k||label))}</span><i></i><b>${value}</b></div>`;}).join('');
 }
 function analyzerDetail(rows){
  const m=catalogMap.get(state.analyze)||rows[0];
  const chin=(extra='')=>`<div class="screen__chin">${extra}<span class="strip__grow"></span>${hueEncoder('inspector','Інспектор CUT',200)}</div>`;
  if(!m)return `<div class="screen screen--insp" data-screen="inspector" data-screen-default="200">${glass('<div class="g-empty"><span class="g-empty__glyph">∅</span><span>Зміни фільтри, щоб побачити моделі.</span></div>')}${chin()}</div>`;
  const route=m.provider+'/'+m.id,q=opEvidence(m),h=opHealth(m),editions=catalog.filter(x=>op.normalize(x.id)===op.normalize(m.id)),fav=state.favs.includes(route),[hcls]=HEALTH_VIEW[h.kind]||HEALTH_VIEW.unknown;
  const kv=(k,v,title='')=>`<div class="g-kv"${title?` title="${esc(title)}"`:''}><span>${k}</span><i></i><b>${v}</b></div>`;
  const tests=q?`${kv(esc(labels[state.role]||state.role),num(q.score),'Зважена оцінка тестів / 100')}<div class="g-score" style="--v:${(q.score/100).toFixed(3)}"><i></i></div>${Object.entries(q.weights).map(([k,w])=>`${kv(esc(k)+' · '+Math.round(w*100)+'%',num(q.record.scores[k]))}<div class="g-score" style="--v:${(Math.max(0,Math.min(100,q.record.scores[k]||0))/100).toFixed(3)}"><i></i></div>`).join('')}<div class="g-hint">${esc(q.record.id)} · ${esc(q.record.effort||'режим джерела')} · ${esc(q.record.source)} · ${esc(q.record.release)} · оцінка — орієнтир для ролі, не тест провайдера</div>`:`${kv(esc(labels[state.role]||state.role),'—')}<div class="g-hint">Для цієї ролі та версії немає повного набору тестів; окремі виміри нижче.</div>`;
  const caps=`${kv('контекст',m.contextWindow?contextTokens(m.contextWindow):'—')}${kv('вихід',m.maxTokens?contextTokens(m.maxTokens):'—')}${kv('зір',Array.isArray(m.input)?m.input.includes('image')?'так':'ні':'—')}${kv('міркування',m.reasoning===true?'так':m.reasoning===false?'ні':'—')}`;
  const list=[...editions].sort((a,b)=>(opPriceValue(a)??Infinity)-(opPriceValue(b)??Infinity)).slice(0,state.allEditions?editions.length:4);
  const eds=list.map(x=>`<button type="button" class="g-kv g-kv--btn" data-analyze="${esc(x.provider+'/'+x.id)}"${x===m?' aria-current="true"':''}><span>${esc(providerName(x.provider))}</span><i></i><b>${esc(priceInfo(x).label)}</b></button>`).join('');
  const glassInner=`<div class="g-insp"><div class="g-insp__title"><b>${esc(cutTitle(route))}</b><span class="g-chip g-chip--dim">${esc(providerName(m.provider))}</span></div><div class="g-dim g-insp__id">${esc(m.id)}</div><div class="g-rule"></div>${tests}<div class="g-rule"></div>${caps}${kv('ціна · вхід / вихід $/1M',esc(priceInfo(m).label))}${evidenceRows(m)?`<div class="g-rule"></div>${evidenceRows(m)}`:''}<div class="g-rule"></div><div class="g-hint">EDITION · вхід / вихід $/1M</div>${eds}<div class="g-msg" data-s="${hcls==='ok'||hcls==='gpu'?'ok':hcls==='low'?'warn':hcls==='zero'||hcls==='off'?'bad':''}"><span>${healthGlyph[h.kind]} ${esc(h.label)}</span></div></div>`;
  return `<div class="screen screen--insp" data-screen="inspector" data-screen-default="200" tabindex="-1">${glass(glassInner)}${chin(`<button type="button" class="key key--sm key--sq" data-fav="${esc(route)}" aria-pressed="${fav}" aria-label="${fav?'Прибрати з обраних':'В обране'}" title="${fav?'В обраних':'До обраних'}"><span class="key__cap">${fav?'★':'☆'}</span></button><button type="button" class="key key--sm" data-model-detail="${esc(route)}"><span class="key__cap">Всі дані</span></button>${editions.length>4?`<button type="button" class="key key--sm" data-action="all-editions" aria-pressed="${!!state.allEditions}"><span class="key__cap">${state.allEditions?'Стиснути':'Усі EDITION · '+editions.length}</span></button>`:''}`)}</div>`;
 }
 function evidenceSourceLine(m){const c=evidenceCoverage(m);return [...c.sources.map(s=>({'Artificial Analysis':'AA','LiveBench':'LiveBench','LiveCodeBench':'LiveCodeBench','Arena':'Arena'}[s]||s)),...(c.claims?['Заяви розробника']:[])].join(' · ')||'Без зіставлених тестів';}
 function evidenceCoverageLine(rows){const counts={independent:0,developer:0,unknown:0};for(const m of rows)counts[evidenceCoverage(m).kind]++;return `${rows.length} CUTS · незалежні дані: ${counts.independent} · лише заяви: ${counts.developer} · без даних: ${counts.unknown}`;}
 // Колекція: controls, search field and every result block are regions; a search keystroke repaints only
 // the result blocks whose content changed (catalogBody), never the field being typed into.
 function catalogData(){
  const rows=analyticalModels(),per=12;state.page=Math.max(0,Math.min(state.page,Math.ceil(rows.length/per)-1));const shown=rows.slice(state.page*per,(state.page+1)*per),selected=source.providers.find(v=>v.id===state.catalogProvider);
  const releases=[...new Set((source.insights?.benchmarks?.records||[]).filter(b=>b.source===state.benchSource).map(b=>b.release))].sort().reverse();
  return {rows,shown,selected,releases,per};
 }
 function operatorCatalog(){const data=catalogData();return box('m/catalog','<section class="catalog-surface">',[leaf('m/controls',catalogControls()),leaf('m/source',catalogSearch(data)),...catalogBody(data)]);}
 function catalogControls(){return `<div class="surface-controls">${opSelect('catalog-provider','Провайдер',state.catalogProvider,analyticalProviders())}${opSelect('op-role','Роль',state.role,roleKeys.map(r=>[r,(labels[r]||r)]))}${opSelect('op-sort','Порядок',state.catalogSort,[['score','Топ за балом ролі'],['evidence','Покриття тестами'],['price','Нижча ціна'],['value','Тести / API $'],['name','За назвою']])}${opSelect('op-scope','Колекція',state.catalogMode,[['mine','Мої'],['all','Увесь каталог'],['free','FREE CUTS'],['used','У профілях'],['fav','Обрані'],['changes','Нові / зниклі']])}${tool('+ Провайдер','provider-add')}</div>`;}
 function catalogSearch({releases}){return `<div class="analysis-source-controls"><label class="search">${SVG.search}<input id="catalog-query" type="search" value="${esc(state.catalogQuery)}" placeholder="CUT або провайдер" aria-label="Пошук CUTS"></label>${opSelect('op-source','Бал ролі',state.benchSource,[['Artificial Analysis','Artificial Analysis'],['LiveBench','LiveBench']])}${opSelect('op-release','Зріз',state.benchRelease,releases.map(r=>[r,r]))}${opSelect('op-evidence','Дані',state.catalogEvidence||'all',[['all','Усі'],['independent','Незалежні'],['developer','Лише заяви'],['unknown','Без даних']])}</div>`;}
 function catalogBody({rows,shown,selected,per}=catalogData()){
  return [leaf('m/coverage',`<p class="evidence-coverage">${evidenceCoverageLine(rows)}</p>`),leaf('m/cartridge',selected?`<section class="provider-cartridge"><span class="cartridge-plug" aria-hidden="true">⏚</span><div><strong>${esc(providerName(selected.id))}</strong><small>${selected.count} моделей · ${selected.expired?'Термін минув':selected.connected?'Доступний в OMP':'Доступ не підтверджено'}${selected.expires?' · до '+timeLabel(selected.expires):''}</small></div><label class="check-field"><input type="checkbox" data-provider-toggle="${esc(selected.id)}" ${(p().disabledProviders||[]).includes(selected.id)?'':'checked'}>У профілі</label>${selected.custom||selected.managed?`<button type="button" class="tool" data-edit-provider="${esc(selected.id)}">Підключення</button>`:''}<span>${rows.filter(m=>opEvidence(m)).length} тестованих маршрутів для ${esc(state.role)}</span></section>`:''),leaf('m/fits',providerFitStrip(rows)),leaf('m/selection',rows.length?`<div class="catalog-selection"><span>Обрано: <b>${esc(cutTitle(state.analyze||rows[0].provider+'/'+rows[0].id))}</b></span><button type="button" class="tool" data-model-detail="${esc(state.analyze||rows[0].provider+'/'+rows[0].id)}">Дані CUT ↗</button></div>`:''),
   box('m/layout','<div class="analysis-layout">',[box('m/main','<div class="analysis-main">',[leaf('m/plot',analyzerPlot(rows)),leaf('m/ledger',`<div class="cut-ledger"><header><span>${rows.length} EDITION · ${esc((labels[state.role]||state.role))}</span><span>ТЕСТ / 100</span><span>INPUT / OUTPUT · $/1M</span><span>КОНТЕКСТ</span></header>${shown.map(m=>{const q=opEvidence(m),route=m.provider+'/'+m.id,h=opHealth(m);return `<button type="button" class="ledger-cut ${state.analyze===route?'selected':''}" data-analyze="${esc(route)}" title="${esc(route)}" aria-label="${esc(cutTitle(route)+' · '+route)}"><span><b>${esc(cutTitle(route))}</b><small>${esc(providerName(m.provider))} · ${esc(m.id)} ${m.status==='missing'?' · Зникла':''}</small><small class="ledger-evidence">${evidenceSourceLine(m)}</small></span><span class="ledger-score">${q?num(q.score):'—'}<small>${q?esc(q.record.effort||'типово'):evidenceLabel(m)}</small></span><span>${priceMarkup(m)}</span><span>${m.contextWindow?contextTokens(m.contextWindow):'—'}<small class="health-${h.kind}">${healthGlyph[h.kind]} ${h.label}</small></span></button>`;}).join('')}</div>`),leaf('m/pagination',`<div class="pagination"><span>${rows.length?state.page*per+1:0}–${Math.min((state.page+1)*per,rows.length)} / ${rows.length}</span><div>${tool('←','prev-page','',state.page===0?'disabled':'')}${tool('→','next-page','',(state.page+1)*per>=rows.length?'disabled':'')}</div></div>`)]),leaf('m/inspector',analyzerDetail(rows))]),
   leaf('m/note',`<p class="evidence-note">Порівняння в одному джерелі й зрізі. У каталозі показано найкращий доступний тестований режим; назва режиму — біля бала. Ціни невідомого типу й безкоштовні маршрути не ранжуються за «тести / $».</p>`)];
 }
 function historyBins(points){if(!points.length)return [];const start=Math.min(...points.map(x=>x.timestamp)),end=Math.max(...points.map(x=>x.timestamp)),map=new Map(points.map(x=>[x.timestamp,x])),out=[];for(let t=Math.max(start,end-167*3600000);t<=end;t+=3600000)out.push(map.get(t)||{timestamp:t,gap:true});return out;}
 // Історія screen: the hourly bars on black glass (selected hour lit), the reading and the hour's sample.
 function historyScreen(bins,index,active,metric,labelsM,peak,stats,o){
  const step=Math.max(1,Math.round(bins.length/6)),hourLabel=t=>{const d=new Date(t);return d.getHours()===0?d.getDate()+'д':String(d.getHours()).padStart(2,'0');};
  const axis=bins.length?bins.filter((b,i)=>i%step===0||i===bins.length-1).map(b=>`<span>${hourLabel(b.timestamp)}</span>`).join(''):'';
  const plot=bins.length?`<div class="g-bars__plot" role="listbox" aria-label="Погодинна історія OMP" style="--plot-h:96px">${bins.map((b,i)=>`<button type="button" data-history-bin="${i}" role="option" aria-selected="${index===i}"${b.gap?' class="is-empty"':''} style="--h:${b.gap?0:Math.max(.02,(b[metric]||0)/peak).toFixed(3)}" aria-label="${esc(timeLabel(b.timestamp/1000)+' · '+(b.gap?'немає виміру':num(b[metric])+' '+labelsM[metric]))}"></button>`).join('')}</div><div class="g-bars__axis">${axis}</div>`:'<div class="g-empty"><span class="g-empty__glyph">∅</span><span>Ще немає вимірів</span></div>';
  const cell=(l,v)=>`<div class="win"><div class="win__top"><span class="win__l">${l}</span><b class="win__v">${v}</b></div></div>`;
  return `<div class="screen screen--wide" data-screen="history" data-screen-default="150">${glass(`<div class="g-head"><span class="g-name">ІСТОРІЯ OMP</span><span class="g-age">${esc(stats.scope||'OMP')}</span><span class="g-grow"></span><span class="g-acc">${esc(labelsM[metric])}</span></div><div class="g-bars"><div class="g-bars__read"><span class="g-acc">${active?esc(timeLabel(active.timestamp/1000)):'немає даних'}</span><b class="win__v">${num(active?.[metric])}</b><span class="g-dim">${active?.gap?'немає виміру':esc(labelsM[metric])+' за годину'}</span></div>${plot}</div><div class="g-rule"></div><div class="wins wins--sample">${cell('Запити',num(active?.requests))}${cell('Помилки',num(active?.errors))}${cell('Токени',num(active?.tokens))}${cell('API ≈ $',num(active?.cost))}</div>`)}<div class="screen__chin"><span class="screen__id">${led(bins.length>0,'green')}<span class="silk">ця година</span></span><span class="strip__grow"></span>${hueEncoder('history','Історія роботи',150)}</div></div>`;
 }
 // Історія: the shuttle, the LCD and each summary block are regions; scrubbing repaints the shuttle and LCD.
 function historySurface(){
  const stats=source.insights?.stats||{},o=stats.overall||{},bins=historyBins(stats.timeSeries||[]),metric=state.historyMetric,labelsM={requests:'Запити',tokens:'Токени',errors:'Помилки',cost:'API $'},selected=bins.findIndex(b=>b.timestamp===state.historyAt),index=selected>=0?selected:Math.max(0,bins.length-1),active=bins[index],peak=Math.max(1,...bins.map(b=>b[metric]||0)),models=[...(stats.byModel||[])].sort((a,b)=>(b[state.historySort]||0)-(a[state.historySort]||0)),max=Math.max(1,...models.map(m=>m[state.historySort]||0));
  return box('h/surface','<section class="history-surface">',[
   leaf('h/controls',`<div class="surface-controls">${opSelect('history-metric','Сигнал',metric,Object.entries(labelsM))}<label class="history-fader"><span class="silk">позиція <output class="rd" style="--rd:5ch">${active?dateFormat({hour:'2-digit',minute:'2-digit'}).format(active.timestamp):'—'}</output></span><input class="fader" id="history-position" type="range" min="0" max="${Math.max(1,bins.length-1)}" value="${index}" step="1" aria-label="Позиція в історії" ${!bins.length?'disabled':''}></label><span class="history-period">${o.firstTimestamp?timeLabel(o.firstTimestamp/1000)+' — '+timeLabel(o.lastTimestamp/1000):'Ще немає вимірів'}<small>${esc(stats.scope||'OMP')} · оновлено ${timeLabel(stats.at)}</small></span></div>`),
   leaf('h/lcd',historyScreen(bins,index,active,metric,labelsM,peak,stats,o)),
   leaf('h/total',`<p class="section-engraving history-total-label">УВЕСЬ ПЕРІОД ЗВІТУ</p>`),
   leaf('h/counters',`<div class="transport-counters"><div><span>ЗАПИТІВ</span><b>${num(o.totalRequests)}</b></div><div><span>ПОМИЛКИ</span><b>${num(o.failedRequests)} <small>${o.errorRate!=null?num(o.errorRate*100)+'%':'—'}</small></b></div><div><span>КЕШ</span><b>${o.cacheRate!=null?num(o.cacheRate*100)+'%':'—'}</b></div><div><span>ПЕРШИЙ ТОКЕН</span><b>${o.avgTtft!=null?num(o.avgTtft/1000)+' с':'—'}</b></div><div><span>ШВИДКІСТЬ</span><b>${num(o.avgTokensPerSecond)} <small>ток/с</small></b></div></div>`),
   leaf('h/sort',`<div class="surface-controls"><span class="section-engraving">ВНЕСОК МОДЕЛЕЙ · ВЕСЬ ПЕРІОД</span>${opSelect('history-sort','Вимір',state.historySort,[['totalRequests','Запити'],['totalCost','API оцінка'],['avgTokensPerSecond','Швидкість'],['failedRequests','Помилки']])}</div>`),
   leaf('h/mixdown',`<div class="mixdown">${models.map(m=>`<div class="mix-channel"><span class="mix-label"><b>${esc(short(m.model))}</b><small>${esc(providerName(m.provider))}</small></span><span class="mix-meter"><i style="width:${(m[state.historySort]||0)/max*100}%"></i></span><strong>${num(m[state.historySort])}</strong><span class="mix-detail">${num(m.failedRequests)} помилок · ${num(m.avgTokensPerSecond)} ток/с · ${m.avgTtft!=null?num(m.avgTtft/1000)+' с':'—'}</span></div>`).join('')||'<p class="empty-state">Статистика ще не зібрана</p>'}</div>`),
   leaf('h/note',`<p class="evidence-note">${source.demo?'Синтетичні дані DEMO.':'Реальні агрегати OMP, не журнал окремих задач.'} Погодинний вибір змінює верхній вимір; внесок моделей — за весь період. API $ — оцінка за тарифами, не платіж підписки. ${esc(stats.error||'')}</p>`),
   leaf('h/splices',`<div class="catalog-splices"><h3>Зміни колекції</h3>${source.changes.slice(-8).reverse().map(c=>`<div><span>${c.kind==='new'?'+':'−'}</span><b>${esc(cutTitle(c.route))}</b><small>${esc(providerName(split(c.route).provider))} · ${timeLabel(c.at)}</small></div>`).join('')||'<p class="evidence-note">Після першого знімка змін немає.</p>'}</div>`)
  ]);
 }
 root.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&!e.defaultPrevented&&!state.modal&&!state.picker&&!e.target.matches('select')&&state.armedCut){e.preventDefault();state.armedCut=null;state.cutTarget=null;state.opFeedback='Вставку скасовано.';render();(win.querySelector('#cut-query')||win.querySelector('[data-op-switch=cuts]'))?.focus({preventScroll:true});return;}
 });
 root.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.selectStep){const el=win.querySelector('#'+CSS.escape(b.dataset.selectStep));if(el){el.selectedIndex=Math.max(0,Math.min(el.options.length-1,el.selectedIndex+Number(b.dataset.direction)));el.dispatchEvent(new Event('change',{bubbles:true}));win.querySelector(`[data-select-step="${b.dataset.selectStep}"][data-direction="${b.dataset.direction}"]:not(:disabled)`)?.focus({preventScroll:true});}return;}
  if(b.dataset.opSwitch){const name=b.dataset.opSwitch;
   if(name==='health'){
    // HEALTH is a pure visual switch: the key's and the surfaces' attributes change; the tape and its marks stay,
    // and the CSS transition grows the bars back (only on this user action).
    state.health=!state.health;state.opFeedback=state.health?'HEALTH · колір і шкала на CUT показують найменший доступний ліміт. ? — немає свіжого виміру.':'HEALTH вимкнено · показано чисту плівку.';
    regions.reopen('p/deck',deckOpen());regions.reopen('drawer/tray',trayOpen());paintRegions([dockSwitches(),leaf('feedback',operatorFeedback())]);
   }else{if(name==='cuts'){toggleDrawer(!state.cuts);win.querySelector('[data-op-switch="cuts"]')?.focus({preventScroll:true});return;}if(name==='free')state.freeCuts=!state.freeCuts;render();}
   storeOperator();win.querySelector(`[data-op-switch="${name}"]`)?.focus({preventScroll:true});return;}
  if(b.dataset.action==='cuts-toggle'){toggleDrawer(!state.cuts);win.querySelector('.tray__title')?.focus({preventScroll:true});return;}
  if(b.dataset.foldToggle!==undefined){const k=b.dataset.foldToggle;if(openFolds.has(k))openFolds.delete(k);else openFolds.add(k);storeFolds();render();win.querySelector(`[data-fold-toggle="${CSS.escape(k)}"]`)?.focus({preventScroll:true});return;}
  if(b.hasAttribute('data-sync-vibe')){state.syncVibe=!state.syncVibe;store();render();win.querySelector('[data-sync-vibe]')?.focus({preventScroll:true});return;}
  if(b.dataset.cut){if(b.closest('.ghost'))return;if(state.cutTarget)placeCut(b.dataset.cut,state.cutTarget);else if(state.armedCut===b.dataset.cut){state.armedCut=null;render();}else{state.armedCut=b.dataset.cut;state.opFeedback='CUT обрано. Торкнись CUT для заміни або гнізда «+», щоб вставити.';if(state.view!=='profiles')state.view='profiles';if(narrowSurface())state.cuts=false;render();if(narrowSurface())win.querySelector('.tray__armed [data-action=cancel-cut]')?.focus({preventScroll:true});}return;}
  if(b.dataset.action==='cancel-cut'){state.armedCut=null;state.cutTarget=null;render();win.querySelector('[data-op-switch=cuts]')?.focus({preventScroll:true});return;}
  if(b.dataset.action==='cuts-clear'){state.cutQuery='';render();win.querySelector('#cut-query')?.focus({preventScroll:true});return;}
  if(b.dataset.analyze){state.analyze=b.dataset.analyze;state.allEditions=false;render();win.querySelector(`.ledger-cut[data-analyze="${CSS.escape(b.dataset.analyze)}"]`)?.focus({preventScroll:true});return;}if(b.dataset.action==='all-editions'){state.allEditions=!state.allEditions;render();return;}
  if(b.hasAttribute('data-history-bin')){state.historyAt=historyBins(source.insights?.stats?.timeSeries||[])[Number(b.dataset.historyBin)]?.timestamp;render();return;}
  if(b.dataset.action==='meters-mobile'){state.mobileMeters=!state.mobileMeters;render();win.querySelector('[data-action=meters-mobile]')?.focus({preventScroll:true});return;}
  if(b.dataset.action==='cuts-more'){state.cutLimit=(state.cutLimit||60)+60;render();}
 });
 // Click-to-place provides the same operation without dragging (phone / keyboard).
 root.addEventListener('click',e=>{if(!state.armedCut||e.target.closest('[data-cut],[data-slot-actions],select,.cut__think'))return;const target=e.target.closest('[data-edit]');if(!target||target.disabled)return;e.preventDefault();e.stopImmediatePropagation();const d=target.dataset;placeCut(state.armedCut,{role:d.edit,index:Number(d.index),group:d.group||'role'});},true);
 root.addEventListener('change',e=>{const id=e.target.id,value=e.target.value;if(id==='history-position'){state.historyAt=historyBins(source.insights?.stats?.timeSeries||[])[Number(value)]?.timestamp;render();win.querySelector('#history-position')?.focus({preventScroll:true});return;}const map={'cut-provider':'cutProvider','cut-health':'cutHealth','op-role':'role','op-sort':'catalogSort','op-scope':'catalogMode','op-source':'benchSource','op-release':'benchRelease','op-evidence':'catalogEvidence','history-metric':'historyMetric','history-sort':'historySort'};if(map[id]){state[map[id]]=value;state.page=0;if(id==='op-scope')state.catalogProvider='all';if(id==='op-source')state.benchRelease=[...new Set(source.insights.benchmarks.records.filter(b=>b.source===value).map(b=>b.release))].sort().at(-1)||'';state.analyze=null;store();render();win.querySelector('#'+id)?.focus({preventScroll:true});}});
 root.addEventListener('input',e=>{if(e.target.id==='history-position'){const bins=historyBins(source.insights?.stats?.timeSeries||[]),at=bins[Number(e.target.value)];e.target.closest('.history-fader').querySelector('output').textContent=at?dateFormat({hour:'2-digit',minute:'2-digit'}).format(at.timestamp):'—';}});
 function storeOperator(){try{localStorage.setItem('mana-operator',JSON.stringify({health:state.health,...(Number.isFinite(state.drawerHeight)?{drawerHeight:state.drawerHeight,drawerResized:true}:{})}));}catch{}}
 // The picker's target CUT carries .editing; a kept row loses it when the picker closes or moves on.
 // The picker's target CUT carries .is-selected (and its ⋯ key aria-expanded); a kept row loses them when the
 // picker closes or moves on. Decorations outside the region strings, re-applied after every patch.
 function markEditing(){
  const x=state.picker,next=x?[...win.querySelectorAll(`[data-edit="${CSS.escape(x.role)}"][data-index="${x.index}"][data-group="${x.group}"]`)].map(el=>el.closest('.cut')).filter(Boolean):[];
  for(const el of editingNodes)if(!next.includes(el)){el.classList.remove('is-selected');el.querySelector('.cut__more')?.setAttribute('aria-expanded','false');}
  for(const el of next){if(!el.classList.contains('is-selected'))el.classList.add('is-selected');if(x.actionsOnly)el.querySelector('.cut__more')?.setAttribute('aria-expanded','true');}
  editingNodes=next;
 }


 // REGIONS. The window is a tree of named regions. A region is a DOM range between two comment markers
 // plus the HTML string it was built from: a leaf {key,html}, or a container {key,open,children} whose
 // element (`open`) holds only child regions. render() rebuilds the strings and replaces only the leaves
 // whose string changed; a container whose tag and child keys are unchanged only patches the attributes
 // that differ between its old and new opening tag. Untouched DOM keeps focus, selection, IME, scroll
 // positions and open <details>. Every key is unique in the window (prefix = surface).
 function leaf(key,html){return {key,html};}
 function box(key,open,children){return {key,open,children};}
 function createRegions(host,doc=document){
  const memo=new Map(),mark=key=>encodeURIComponent(key).replace(/-/g,'%2D'),closing=open=>'</'+/^<([a-z][a-z0-9-]*)/i.exec(open)[1]+'>';
  const markup=r=>'<!--'+mark(r.key)+'-->'+(r.children?r.open+r.children.map(markup).join('')+closing(r.open):r.html)+'<!--/'+mark(r.key)+'-->';
  const keysOf=r=>r.children.map(c=>c.key).join('\n');
  const parse=html=>{const t=doc.createElement('template');t.innerHTML=html;return t.content;};
  const attributes=open=>new Map([...parse(open+closing(open)).firstElementChild.attributes].map(a=>[a.name,a.value]));
  let rootKeys=null;
  // Binds r (its start marker is `start`) and its children to their DOM ranges; returns r's end marker.
  function bind(r,start){
   const entry={start,html:r.html,open:r.open,keys:r.children?keysOf(r):undefined,el:null};let node=start.nextSibling;
   if(r.children){
    if(r.open){entry.el=node;node=node.firstChild;}
    for(const c of r.children){while(node&&!(node.nodeType===8&&node.data===mark(c.key)))node=node.nextSibling;node=bind(c,node).nextSibling;}
    if(r.open)node=entry.el.nextSibling;
   }
   const end='/'+mark(r.key);while(node&&!(node.nodeType===8&&node.data===end))node=node.nextSibling;
   entry.end=node;memo.set(r.key,entry);return node;
  }
  function forget(key){const e=memo.get(key);if(!e)return;memo.delete(key);if(e.keys)for(const k of e.keys.split('\n'))forget(k);}
  function record(out,r,nodes){out.replaced.add(r.key);for(const n of nodes)if(n.nodeType===1)out.inserted.push(n);}
  function replace(r,e,out){
   const fragment=parse(markup(r)),parent=e.start.parentNode,next=e.end.nextSibling;
   forget(r.key);
   for(let n=e.start;n;){const after=n.nextSibling;n.remove();if(n===e.end)break;n=after;}
   bind(r,fragment.firstChild);record(out,r,[...fragment.childNodes]);parent.insertBefore(fragment,next);
  }
  // Only the attributes that differ between the old and the new opening tag: script-owned ones survive.
  function retag(e,key,open,out){
   if(open===e.open)return;
   const from=attributes(e.open),to=attributes(open);
   for(const name of from.keys())if(!to.has(name))e.el.removeAttribute(name);
   for(const [name,value] of to)if(from.get(name)!==value)e.el.setAttribute(name,value);
   e.open=open;out.morphed.push(e.el);out.replaced.add(key);
  }
  function patch(r,out){
   const e=memo.get(r.key);if(!e?.start.isConnected)return false;
   if(r.children&&e.keys===keysOf(r)&&!!e.open===!!r.open&&(!r.open||closing(r.open)===closing(e.open))){
    retag(e,r.key,r.open,out);
    for(const c of r.children)patch(c,out);
   }else if(r.children||e.keys!==undefined||e.html!==r.html)replace(r,e,out);
   return true;
  }
  const result=()=>({inserted:[],morphed:[],replaced:new Set(),all:false});
  return {
   result,
   // The whole window: patch in place, or mount everything when the top-level layout itself changed.
   render(list,out=result()){
    const keys=list.map(r=>r.key).join('\n');
    if(keys===rootKeys&&list.every(r=>memo.get(r.key)?.start.isConnected)){for(const r of list)patch(r,out);return out;}
    memo.clear();rootKeys=keys;const fragment=parse(list.map(markup).join(''));
    let node=fragment.firstChild;for(const r of list)node=bind(r,node).nextSibling;
    for(const r of list)out.replaced.add(r.key);for(const n of fragment.childNodes)if(n.nodeType===1)out.inserted.push(n);
    host.replaceChildren(fragment);out.all=true;return out;
   },
   // One already mounted region (a search result, a toast); false when it is not on screen.
   update(r,out=result()){return patch(r,out)?out:null;},
   // The live DOM already shows this leaf (a typed input value): only its string is remembered.
   adopt(r){const e=memo.get(r.key);if(e&&e.keys===undefined)e.html=r.html;},
   // A mounted container's opening tag only (a switch that restyles a whole surface): its children are untouched.
   reopen(key,open,out=result()){const e=memo.get(key);if(!e?.el||!e.start.isConnected||closing(open)!==closing(e.open))return null;retag(e,key,open,out);return out;},
   // The DOM of this region was changed outside render(): the next render rebuilds it.
   invalidate(key){const e=memo.get(key);if(e){e.html=null;if(e.keys!==undefined)e.keys=null;}},
   has(key){return !!memo.get(key)?.start.isConnected;}
  };
 }
 // WINDOW REGIONS — one function per region. The window holds the device body (strip, dock, screens, the working
 // surface), the spacer that keeps the page scrollable above the drawer, the drawer itself, picker, modal, toast.
 const REEL=(pack,hub)=>`<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="#1d1f22" stroke="#6d7279" stroke-width="1"/><circle cx="16" cy="16" r="${pack}" fill="#3b2a1e"/><circle cx="16" cy="16" r="${pack}" fill="none" stroke="#5a4230" stroke-width=".6" stroke-dasharray="1 1.6"/>${[0,120,240].map(a=>`<circle cx="${(16+9.6*Math.sin(a*Math.PI/180)).toFixed(2)}" cy="${(16-9.6*Math.cos(a*Math.PI/180)).toFixed(2)}" r="3.6" fill="#0b0c0e" stroke="#4b5057" stroke-width=".6"/>`).join('')}<circle cx="16" cy="16" r="4.3" fill="#d9dce0"/><circle cx="16" cy="16" r="2" fill="${hub}"/>${[0,60,120,180,240,300].map(a=>`<rect x="15.4" y="11.6" width="1.2" height="1.6" fill="#8a9097" transform="rotate(${a} 16 16)"/>`).join('')}</svg>`;
 const BRAND=`<a href="#" class="brand" aria-label="Mana Tape · Монтаж"><span class="logo" aria-hidden="true"><span class="logo__glass"><span class="reel reel--a">${REEL(12.2,'#ef5b25')}</span><span class="reel reel--b">${REEL(7.4,'#2f80ff')}</span></span></span><span class="wordmark"><b>mana tape</b><span class="silk silk--2">OMP · пульт ролей</span></span></a>`;
 // The brightness knob is owned by screen.js after the first paint: its markup never changes, so it is never rebuilt.
 const BRIGHTNESS=`<div class="ctl">${ManaScreen.brightnessKnobHTML({value:ManaScreen.get().brightness,label:'Яскравість екранів'})}<span class="silk">яскр. <output class="rd" style="--rd:3ch" data-screen-brightness-out>${ManaScreen.get().brightness}</output></span></div>`;
 const LIGHT_FACE='<span class="tgl__lab tgl__lab--on" aria-hidden="true">світло</span><span class="tgl__body" aria-hidden="true"><span class="tgl__washer"></span><span class="tgl__hex"></span><span class="tgl__bush"></span><span class="tgl__shadow"><i class="tgl__stalk"></i><i class="tgl__tip"></i></span><span class="tgl__lever"><i class="tgl__stalk"></i><i class="tgl__tip"></i></span></span><span class="tgl__lab tgl__lab--off" aria-hidden="true">темно</span>';
 function surfaceKeys(){return `<nav class="keybed" aria-label="Поверхні">${[['profiles','01','Монтаж'],['models','02','Колекція'],['dashboard','03','Історія']].map(([k,n,label])=>`<button type="button" class="key" data-view="${k}"${state.view===k?' aria-current="page"':''}><span class="key__cap">${led(state.view===k,'orange')}<span class="key__num">${n}</span>${label}</span></button>`).join('')}</nav>`;}
 // DEMO, connection and a failed refresh are status LEDs with a short print; the full text is in the title.
 function statusCluster(){
  const offline=state.offline,error=source.refresh.error,at=source.refresh.at?dateFormat({hour:'2-digit',minute:'2-digit'}).format(source.refresh.at*1000):'',title=[source.demo?'DEMO · ізольовані тестові профілі. Реальні рахунки не підключені.':offline?'Немає зв’язку з сервером':'Підключено до OMP',source.refresh.at?'Каталог оновлено '+timeLabel(source.refresh.at):'',error].filter(Boolean).join('\n');
  const [c,name,note]=offline?['red','ОФЛАЙН','немає зв’язку з сервером']:source.demo?['amber','DEMO','тестові профілі · рахунки не підключені']:['green','OMP','каталог · '+(at||'ще не оновлено')];
  return `<div class="status" role="status" title="${esc(title)}" aria-label="${esc(title)}"><div class="status__row">${led(true,c)}<b class="status__name">${name}</b></div><small class="status__note">${esc(note).replace(' · ','<br>')}</small>${error?`<div class="status__row status__row--sub">${led(true,'red')}<small class="status__note">каталог не оновився</small></div>`:''}</div>`;
 }
 function lightSwitch(){
  let light=document.documentElement.dataset.theme!=='dark';try{const t=localStorage.getItem('forge-theme');if(t==='light'||t==='dark')light=t==='light';}catch{}
  return box('strip/light',`<button type="button" class="tgl" role="switch" aria-checked="${light}" aria-label="Світло" data-theme-toggle title="${light?'Світло · вниз — темна тема':'Темно · вгору — світла тема'} · Space / Enter, ↑ / ↓">`,[leaf('strip/light/face',LIGHT_FACE)]);
 }
 function topbar(){
  const busy=source.refresh.busy;
  return box('strip','<header class="strip">',[leaf('strip/brand',BRAND),leaf('strip/surfaces',surfaceKeys()),leaf('strip/grow','<span class="strip__grow"></span>'),
   box('strip/plate','<div class="bay plate">',[leaf('strip/brightness',BRIGHTNESS),leaf('strip/sep','<span class="seam seam--v"></span>'),lightSwitch(),leaf('strip/refresh',`<div class="ctl"><button type="button" class="key key--sq${busy?' is-spinning':''}" data-action="refresh" aria-label="Оновити каталог і ліміти" title="Оновити каталог і ліміти" ${busy?'disabled':''}><span class="key__cap">${SVG.refresh}</span></button><span class="silk">оновити</span></div>`)]),
   leaf('strip/status',statusCluster())]);
 }
 const SCREWS='<i class="screw screw--tl"></i><i class="screw screw--tr"></i><i class="screw screw--bl"></i><i class="screw screw--br"></i>';
 function windowRegions(dirty){
  return [
   box('device','<div class="device">',[leaf('device/screws',SCREWS),topbar(),leaf('seam:strip','<div class="seam"></div>'),operatorDock(dirty),leaf('seam:dock','<div class="seam"></div>'),...screensBank(),
    box('main',`<main class="workarea${state.view==='profiles'?'':' operator-surface'}" data-surface="${state.view}">`,state.view==='dashboard'?[historySurface()]:state.view==='profiles'?profileView():[operatorCatalog()])]),
   leaf('spacer','<div class="tray-spacer" aria-hidden="true"></div>'),
   cutsTray(),
   pickerMarkup(),
   leaf('modal',modalMarkup()),
   leaf('toast',toastMarkup())
  ];
 }
 // A short-lived message on a small glass above the drawer lip; a refusal reads amber, a result green.
 function toastMarkup(){if(!state.toast)return '';const warn=/недоступ|не підтримує|лише|Спочатку|Дочекайся|Ще розраховується|максимальн|має бути|змінилася|Не вдалося|помилк/i.test(state.toast);return `<div class="toast" role="status"><div class="screen" data-screen="toast" data-screen-default="${warn?82:150}">${glass(`<div class="g-msg" data-s="${warn?'warn':'ok'}"><span>${esc(state.toast)}</span></div>`)}</div></div>`;}
 function focusSelector(el){
  if(!el)return '';if(el.id)return '#'+CSS.escape(el.id);
  if(el.matches('.dock__menu summary'))return '.dock__menu summary';
  // The DeepSeek switch flips its value; a chosen provider card disappears into the provider selector.
  if(el.hasAttribute('data-profile-mode'))return '[data-profile-mode]';
  if(el.hasAttribute('data-catalog-provider'))return '#catalog-provider';
  const prefix=el.closest('.picker')?'.picker ':el.closest('.modal')?'.modal ':'';
  if(el.name)return prefix+'[name="'+CSS.escape(el.name)+'"]';
  const attr=['data-effort-role','data-edit','data-slot-actions','data-action','data-cut','data-pick','data-analyze','data-fav','data-op-switch','data-pool-open','data-pool-tab','data-mode-scope','data-agent-role','data-agent-copy','data-focus-role','data-theme-toggle','data-knob','data-fold-toggle','data-sync-vibe','data-adopt','data-view','data-model-detail','data-history-bin','data-provider-toggle','data-reset-agent','data-select-step'].find(key=>el.hasAttribute(key)&&!(key==='data-action'&&!el.getAttribute(key)));
  return attr?prefix+'['+attr+'="'+CSS.escape(el.getAttribute(attr))+'"]'+['data-index','data-group','data-direction','data-screen-hue'].filter(key=>el.hasAttribute(key)).map(key=>'['+key+'="'+CSS.escape(el.getAttribute(key))+'"]').join(''):'';
 }
 // One entry point for every state change. Builds the region tree and lets the region engine replace only
 // what changed; then restores what a replaced region took with it (focus, selection, scroll, menu, modal).
 function render(){
  roleKeys.splice(0,roleKeys.length,...knownRoleKeys(p()));if(!roleKeys.includes(state.role))state.role=roleKeys[0]||'';
  if(composing||drag?.active||cutGesture?.active||drawerGesture||document.documentElement.dataset.displayTuning){pendingRender=true;scheduleBackgroundWork();return;}
  pendingRender=false;renderCache={diffs:new Map(),keys:new Map()};
  try{
  opReportCache=usageReports();if(win.dataset.opView!==state.view)win.dataset.opView=state.view;
  const title=source.demo?'Mana Tape · DEMO':'Mana Tape · OMP';if(document.title!==title)document.title=title;
  // The only geometry read before writing: a clean layout here costs nothing.
  surfaceWidth=win.clientWidth;
  const view=captureView(),wasModal=document.body.classList.contains('modal-open'),layerScroll=win.querySelector('.modal-layer')?.scrollTop||0;
  const oldForm=win.querySelector('.modal form'),formValues=oldForm?[...oldForm.elements].filter(el=>el.name).map(el=>({name:el.name,value:el.value,checked:el.checked})):[];
  const modalFocus=view.focused?.closest('.modal')?view.selector:'';
  ensureModePreview();rebuild();state.changes=diff(state.profile).length;
  const context=state.view+'|'+state.profile;
  const frame={profile:state.profile,view:state.view,draft:JSON.stringify(p()),projection:JSON.stringify([roleKeys.map(r=>chain(r)),workers().map(r=>chain(r,'vibe')),poolDraft]),dirty:!!state.changes,saving:state.saving,error:state.error,context};
  // Clip geometry is read only when this render can move CUTS (an edit or a new projection).
  const motion=ForgeTape.before(win,frame);
  if(state.modal&&!wasModal){
   modalPageY=window.scrollY;
   const attribute=['data-model-detail','data-edit-provider','data-action'].find(a=>view.focused?.hasAttribute(a));
   modalReturnFocus=view.focused?.closest('.dock__menu')?'.dock__menu summary':attribute?`[${attribute}="${CSS.escape(view.focused.getAttribute(attribute))}"]`:'[data-view][aria-current=page]';
   document.body.style.top=-modalPageY+'px';document.body.classList.add('modal-open');
  }else if(!state.modal&&wasModal){document.body.classList.remove('modal-open');document.body.style.top='';window.scrollTo({top:modalPageY,behavior:'instant'});}
  editHistory.observe(state.profile,p(),!!diff(state.profile).length,original[state.profile]);editHistory.observe('@free-pools',poolDraft,poolsDirty(),poolOriginal);
  const dirty=profileKeys.filter(k=>diff(k).length);
  const out=regions.render(windowRegions(dirty));
  win.dataset.tapeContext=context;
  // Writes first (marks, classes, inert, drawer geometry), then reads (scroll, focus, motion): one layout,
  // not one per step.
  settleRegions(out);
  // The drawer is placed when it or the body above it was rebuilt; window resizes re-measure it too.
  settleDrawer(out);
  if(state.modal)win.querySelector('.dock__menu[open]')?.removeAttribute('open');else if(view.menuOpen)win.querySelector('.dock__menu')?.setAttribute('open','');
  for(const child of win.children){const inert=!!state.modal&&!child.classList.contains('modal-layer')&&!child.classList.contains('toast');if(child.inert!==inert)child.inert=inert;}
  restoreScroll(view,out,motion.context===context);
  if(state.modal&&touched(out,'modal')){const layer=win.querySelector('.modal-layer'),form=layer.querySelector('form');layer.scrollTop=layerScroll;if(form&&form.id===oldForm?.id)for(const saved of formValues){const el=form.elements.namedItem(saved.name);if(el){el.value=saved.value;if(typeof saved.checked==='boolean')el.checked=saved.checked;}}const target=modalFocus?layer.querySelector(modalFocus):!wasModal?layer.querySelector('input,button'):null;target?.focus({preventScroll:true});if(target&&view.selection&&typeof target.setSelectionRange==='function')target.setSelectionRange(...view.selection);}
  if(state.picker&&(touched(out,'picker')))fitPicker();
  if(!state.modal)restoreFocus(view);
  ForgeTape.after(win,motion,frame);
  if(!state.modal&&view.focused?.matches('.cut-tools'))focusPickerMove(state.picker?.focusDirection||1);
  if(!state.modal&&wasModal)[...win.querySelectorAll(modalReturnFocus||'[data-view][aria-current=page]')].find(el=>el.getClientRects().length)?.focus({preventScroll:true});
  storeDrafts(dirty);
  renderedAt=Date.now();
  }finally{renderCache=null;}
 }
 const touched=(out,key)=>out.all||[...out.replaced].some(k=>k===key||k.startsWith(key+'/'));
 // What a replaced region takes with it: read before the patch (one layout at most), restored after it.
 function captureView(){
  const focused=document.activeElement,selector=win.contains(focused)?focusSelector(focused):'';
  const scrollers=['.picker-results','.tray__grid','.ledger-scroll'].map(selector=>{const el=win.querySelector(selector);return el?{selector,el,left:el.scrollLeft,top:el.scrollTop,key:el.dataset.filterKey}:null;}).filter(Boolean);
  // Long lanes scroll on their own; a rebuilt lane keeps its horizontal position within the same profile.
  const grooves=[...win.querySelectorAll('.lane__groove')].filter(el=>el.scrollLeft).map(el=>({el,lane:el.parentElement.dataset.role+'|'+el.parentElement.dataset.laneGroup,left:el.scrollLeft}));
  return {focused,selector,selection:focused?.selectionStart!=null?[focused.selectionStart,focused.selectionEnd,focused.selectionDirection]:null,scrollers,grooves,menuOpen:!!win.querySelector('.dock__menu[open]')};
 }
 function restoreScroll(view,out,sameContext){
  for(const saved of view.scrollers){
   const el=win.querySelector(saved.selector);if(!el||el===saved.el)continue;
   if(saved.key===el.dataset.filterKey){el.scrollLeft=saved.left;el.scrollTop=saved.top;}
  }
  for(const saved of view.grooves||[]){
   if(saved.el.isConnected){if(!sameContext)saved.el.scrollLeft=0;continue;}
   const [role,group]=saved.lane.split('|'),el=sameContext&&win.querySelector(`.lane[data-role="${CSS.escape(role)}"][data-lane-group="${CSS.escape(group)}"]>.lane__groove`);if(el)el.scrollLeft=saved.left;
  }
 }
 // Focus moves only when its control was rebuilt: the same control (or the first visible match) takes it back.
 function restoreFocus(view){
  if(!view.selector||view.focused?.isConnected)return;
  const target=[...win.querySelectorAll(view.selector)].find(el=>el.getClientRects().length&&!el.disabled&&el.matches('button,select,input,textarea,summary,a[href],[tabindex]'));
  target?.focus({preventScroll:true});if(target&&view.selection&&typeof target.setSelectionRange==='function')target.setSelectionRange(...view.selection);
 }
 // DOM that is not part of the region strings: the picker's target, screen palettes and knob angles, the times
 // (age, reset countdowns) that the 30-s tick keeps current, and the toast's entry.
 function settleRegions(out){
  markEditing();
  const fresh=out.all?[win]:out.inserted;
  for(const top of fresh)paintTimes(top);
  if(out.all||out.inserted.some(el=>el.matches(SCREEN_PARTS)||el.querySelector(SCREEN_PARTS)))ManaScreen.sync();
  const toast=out.inserted.find(el=>el.matches('.toast'));if(toast)requestAnimationFrame(()=>toast.classList.add('is-in'));
 }
 function paintTimes(scope=win){
  const now=Date.now(),list=el=>scope.matches?.(el)?[scope,...scope.querySelectorAll(el)]:[...scope.querySelectorAll(el)];
  for(const el of list('[data-reset]')){const at=Number(el.dataset.reset),text=resetCountdown(at,now),title=resetTitle(at);if(el.textContent!==text)el.textContent=text;if(el.title!==title)el.title=title;}
  for(const el of list('[data-age]')){const text=reportAge({at:Number(el.dataset.age)});if(el.textContent!==text)el.textContent=text;}
 }
 // A partial repaint (search results, a switch, the toast) through the same engine; adopted leaves only
 // record what the live DOM already shows (the typed value of a kept input).
 function paintRegions(updates,adopts=[]){
  const previousCache=renderCache;renderCache??={diffs:new Map(),keys:new Map()};
  try{
   for(const r of adopts)regions.adopt(r);
   const view={focused:document.activeElement,selection:null},out=regions.result();
   view.selector=win.contains(view.focused)?focusSelector(view.focused):'';
   if(view.focused?.selectionStart!=null)view.selection=[view.focused.selectionStart,view.focused.selectionEnd,view.focused.selectionDirection];
   for(const r of updates)regions.update(r,out);
   if(out.inserted.length||out.morphed.length){settleRegions(out);if(!state.modal)restoreFocus(view);}
   return out;
  }finally{renderCache=previousCache;}
 }
 function storeDrafts(dirty){
  try{
   const pools=poolsDirty()?JSON.stringify({original:poolOriginal,value:poolDraft,revision:poolRevision}):'',drafts=JSON.stringify(Object.fromEntries(dirty.map(k=>[k,{original:original[k],value:profiles[k],revision:source.revisions[k]}])));
   if(pools!==storedDrafts.pools){if(pools)sessionStorage.setItem(storageKey('forge-pool-draft'),pools);else sessionStorage.removeItem(storageKey('forge-pool-draft'));storedDrafts.pools=pools;}
   if(drafts!==storedDrafts.drafts){sessionStorage.setItem(storageKey('forge-drafts'),drafts);storedDrafts.drafts=drafts;}
  }catch{}
 }
 root.addEventListener('click',async e=>{
  const b=e.target.closest('button,a.brand');if(!b)return;
  if(b.matches('a.brand')){e.preventDefault();state.view='profiles';render();store();ForgeTape.logo(win.querySelector('.brand'),true);return;}
  if(b.dataset.modelDetail){state.detail=b.dataset.modelDetail;state.modal='details';state.modalError='';render();win.querySelector('.modal [data-action=modal-close]')?.focus();return;}
  if(b.dataset.editProvider){state.editProvider=b.dataset.editProvider;state.modal='provider';state.modalError='';render();return;}
  if(b.hasAttribute('data-show-changes')){state.view='models';state.catalogMode='changes';state.catalogProvider='all';state.page=0;render();return;}
  const action=b.dataset.action;
  try{
   if(action==='refresh'){await api('/api/refresh',{});await reload();notify('Оновлюю каталог і показники…');}
   if(action==='clone-profile'){state.cloneName='';state.modalError='';state.modal='clone';render();win.querySelector('#clone-form input')?.focus();}
   if(action==='clone-create'){const f=win.querySelector('#clone-form');if(state.profileBusy)return;const q=checkProfileName(f);if(!f.reportValidity())return;let name=q.name;state.cloneName=f.elements.name.value;state.profileBusy=true;f.querySelector('button').disabled=true;regions.invalidate('modal');try{const result=await api('/api/profile-action',{action:'clone',profile:state.profile,name});name=result.name||name;state.modal=null;state.modalError='';await reload();state.profile=name;editHistory.profiles.delete(name);render();store();}finally{state.profileBusy=false;}}
   if(action==='history'){state.modalError='';state.modal='history';render();}
   if(action==='rename-profile'&&state.profile!=='standard'){state.renameName=state.profile;state.modalError='';state.modal='rename';render();win.querySelector('#rename-form input')?.select();}
   if(action==='delete-profile'&&state.profile!=='standard'){state.modalError='';state.modal='delete-profile';render();}
   if(action==='rename-confirm'||action==='delete-confirm'){
    if(state.profileBusy)return;
    const old=state.profile,f=win.querySelector('#rename-form');
    const q=f?checkProfileName(f):null;if(f&&!f.reportValidity())return;
    let name=q?.name||null;
    state.renameName=f?.elements.name.value;state.profileBusy=true;render();
    try{
     const result=await api('/api/profile-action',{action:f?'rename':'delete',profile:old,name,revision:source.revisions[old]});name=result.name||name;
     if(name&&name!==old){profiles[name]=profiles[old];original[name]=original[old];source.revisions[name]=source.revisions[old];}
     editHistory.rename(old,name);
     if(name!==old){delete profiles[old];delete original[old];delete source.revisions[old];profileKeys.splice(0,profileKeys.length,...Object.keys(profiles));}
     state.profile=name||'standard';state.modal=null;state.modalError='';state.profileBusy=false;store();render();await reload();notify(name?'Профіль перейменовано':'Профіль видалено');
    }finally{state.profileBusy=false;}
   }
   if(action==='restore-profile'){if(!confirm('Відновити попередню версію профілю?'))return;await api('/api/profile-action',{action:'restore',profile:state.profile,revision:source.revisions[state.profile]});profiles[state.profile]=copy(original[state.profile]);editHistory.profiles.delete(state.profile);state.poolPanel=false;state.modal=null;await reload();notify('Попередню версію відновлено');}
   if(action==='delete-provider'){if(!confirm('Видалити підключення? Якщо воно використовується у профілях, видалення буде заблоковано.'))return;await api('/api/provider',{id:state.editProvider,action:'delete',revision:source.providerRevision});state.modal=null;await reload();notify('Підключення видалено');}

   if(action==='all-stats'){state.statsLimit=10000;render();}
   if(action==='clear-error'){state.error='';render();}
   // «Прийняти файл»: accept a profile file as it is now after an outside edit (or forget a removed one). The file
   // is never rewritten; its former version stays restorable.
   if(action==='adopt-profile'){const name=b.dataset.adopt;if(!confirm(source.modeOrphans?.includes(name)?`Забути запис режиму профілю «${prettyProfile(name)}»? Файл уже видалено; копія запису лишиться в резервних.`:`Прийняти файл профілю «${prettyProfile(name)}» як є? Режим DeepSeek стане ON, збережені заміни лишаться. Попередня версія доступна через «Попереднє збереження».`))return;await api('/api/profile-action',{action:'adopt',profile:name,revision:source.revisions?.[name]});await reload();state.opFeedback='Файл профілю '+prettyProfile(name)+' прийнято.';render();return;}
   if(action==='discard-reload'){if(!confirm('Скинути всі незбережені чернетки й завантажити поточні файли?'))return;state.modal=null;state.error='';editHistory.profiles.clear();await reload(true);}
   if(action==='export-draft'){const drafts=Object.fromEntries(profileKeys.filter(k=>diff(k).length).map(k=>[k,{revision:source.revisions[k],changes:diff(k)}]));if(poolsDirty())drafts['@free-pools']={revision:poolRevision,pools:poolDraft};const blob=new Blob([JSON.stringify(drafts,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='forge-drafts.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  }catch(err){if(state.modal){state.modalError=err.message;}else state.error=err.message;render();}
 });
 root.addEventListener('input',e=>{if(!e.target.matches('#clone-form input,#rename-form input'))return;if(e.target.form.id==='clone-form')state.cloneName=e.target.value;else state.renameName=e.target.value;checkProfileName(e.target.form);state.modalError='';win.querySelector('.modal > .error-banner')?.remove();regions.invalidate('modal');});
 root.addEventListener('submit',e=>{if(e.target.id==='clone-form'){e.preventDefault();win.querySelector('[data-action=clone-create]')?.click();}if(e.target.id==='rename-form'){e.preventDefault();win.querySelector('[data-action=rename-confirm]')?.click();}});
 root.addEventListener('change',e=>{if(e.target.id==='sync-vibe'||e.target.hasAttribute('data-sync-vibe')){state.syncVibe=e.target.checked;for(const input of win.querySelectorAll('[data-sync-vibe]'))input.checked=state.syncVibe;store();}});
 root.addEventListener('keydown',e=>{if(e.key==='Tab'&&(state.modal||state.picker)){const layer=win.querySelector(state.modal?'.modal':'.picker'),nodes=[...layer.querySelectorAll('button:not(:disabled),input,select,textarea,a[href]')].filter(x=>x.getClientRects().length),first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
 window.addEventListener('resize',()=>{finishDrawerResize(true);fitPicker(true);resizeDrawer(state.drawerHeight);});
 window.addEventListener('beforeunload',e=>{if(!state.switchingProject&&(poolsDirty()||profileKeys.some(k=>diff(k).length))){e.preventDefault();e.returnValue='';}});
 root.addEventListener('change',e=>{if(e.target.id==='project-choice'&&!state.saving){store();state.switchingProject=true;const url=new URL(location.href);url.searchParams.set('project',e.target.value);location.assign(url);}});
 window.addEventListener('offline',()=>{state.offline=true;state.error='Немає мережі. Чернетки залишаються у цьому вікні; збереження потребує сервера.';render();});
 window.addEventListener('online',()=>{state.error='';pollState();});
 Object.assign(state,{health:true,cuts:false,freeCuts:false,cutProvider:'all',cutHealth:'all',cutQuery:'',catalogSort:'score',benchSource:'Artificial Analysis',benchRelease:[...new Set((source.insights?.benchmarks?.records||[]).filter(b=>b.source==='Artificial Analysis').map(b=>b.release))].sort().at(-1)||'',historyMetric:'requests',historySort:'totalRequests'});try{const saved=JSON.parse(localStorage.getItem('mana-operator')||'{}');if(typeof saved?.health==='boolean')state.health=saved.health;if(saved?.drawerResized===true&&Number.isFinite(saved.drawerHeight))state.drawerHeight=saved.drawerHeight;}catch{}
 state.syncVibe=true;state.statsLimit=8;state.favs=source.favs||[];favSaved=state.favs;state.error='';state.modalError='';
 try{const v=JSON.parse(localStorage.getItem(storageKey('forge-view')));if(v){if(['dashboard','profiles','models','providers'].includes(v.view))state.view=v.view==='providers'?'models':v.view;if(profiles[v.profile])state.profile=v.profile;if(roleKeys.includes(v.role))state.role=v.role;if(typeof v.syncVibe==='boolean')state.syncVibe=v.syncVibe;}const drafts=JSON.parse(sessionStorage.getItem(storageKey('forge-drafts'))||'{}');for(const [k,v]of Object.entries(drafts)){if(profiles[k]&&v.original&&v.value&&v.revision){original[k]=v.original;profiles[k]=v.value;source.revisions[k]=v.revision;}}}catch{}
 try{const draft=JSON.parse(sessionStorage.getItem(storageKey('forge-pool-draft'))||'null');if(draft?.original&&draft.value&&draft.revision){poolOriginal=draft.original;poolDraft=draft.value;poolRevision=draft.revision;}}catch{}
 for(const [k,v] of Object.entries(profiles)){v.forgeMode??=copy(source.profileModes?.[k]?.settings||{mode:'deepseek',alternatives:[],overrides:{}});original[k].forgeMode??=copy(v.forgeMode);}
 if(!profiles[state.profile])state.profile='standard';
 rebuild();render();ManaScreen.boot(win);
 if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
 // Countdowns tick in place; a text is written only when it actually changed (an idle tab does no DOM work).
 setInterval(()=>{
  if(document.hidden)return;let passed=false;
  for(const el of win.querySelectorAll('[data-reset]')){const at=Number(el.dataset.reset);if(at>0&&at<=Date.now()&&!resetsSeen.has(at)){resetsSeen.add(at);passed=true;}}
  paintTimes(win);if(passed){pendingRender=true;scheduleBackgroundWork();}
  const tariff=win.querySelector('.tariff');if(tariff&&!tariff.contains(document.activeElement))paintRegions([leaf('p/tariff',tariffMarkup())]);
 },30000);
 setInterval(pollState,15000);
})();

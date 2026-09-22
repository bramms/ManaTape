
(async()=>{
 const root=document.getElementById('forge-direct'),win=document.getElementById('forge-window');
 const selectedProject=new URLSearchParams(location.search).get('project');
 const endpoint=path=>path+(selectedProject?'?project='+encodeURIComponent(selectedProject):'');
 let source;
 try {const res=await fetch(endpoint('/api/state'));source=await res.json();if(!res.ok)throw Error(source.error);}catch(e){win.innerHTML='<div class="startup">Немає зв’язку із сервером.<br>Перевір підключення і <button id="retry-load">спробуй знову</button>.</div>';document.getElementById('retry-load').onclick=()=>location.reload();return;}

 const labels=source.ui?.roleLabels||{};
 const providerNames={'opencode-free':'OpenCode Free','commandcode':'CommandCode','opencode-go':'OpenCode Go','openai-codex':'Codex','google-antigravity':'Antigravity','anthropic':'Anthropic','deepseek':'DeepSeek API',...(source.ui?.providerLabels||{})};
 const codes={'opencode-free':'FREE','openrouter':'OR','commandcode':'CC','opencode-go':'GO','openai-codex':'CX','google-antigravity':'AG','anthropic':'AN','deepseek':'DS',...(source.ui?.providerCodes||{})};
 const providerCode=id=>codes[id]||String(id||'?').slice(0,4).toUpperCase();
 const prettyProfile=s=>s==='standard'?'Standard':s;
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function searchText(value){return String(value??'').normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/[^\p{L}\p{N}]+/gu,' ');}
 function matchesQuery(query,...values){const text=searchText(values.join(' '));return searchText(query).split(' ').filter(Boolean).every(word=>text.includes(word));}
 const icon=n=>`<span aria-hidden="true">${({sparkles:'✧',search:'⌕','undo-2':'↶',star:'☆',x:'×','trash-2':'−'})[n]||'·'}</span>`;
 const tool=(txt,act,cl='',attr='')=>`<button type="button" class="tool ${cl}" data-action="${act}" ${attr}>${txt}</button>`;
 const copy=x=>JSON.parse(JSON.stringify(x));
 function merge(a,b){const out=copy(a);for(const [k,v]of Object.entries(b||{})){out[k]=v&&typeof v==='object'&&!Array.isArray(v)?merge(out[k]||{},v):copy(v);}return out;}
 const original={standard:copy(source.base),...Object.fromEntries(Object.entries(source.presets).map(([k,v])=>[k,merge(source.base,v)]))},profiles=copy(original),roleKeys=Object.keys(source.base.modelRoles||{}),profileKeys=Object.keys(original);
 const normalizeProfile=profile=>merge({modelRoles:{},retry:{fallbackChains:{}},task:{agentModelOverrides:{}}},profile);
 const storageKey=key=>'mana:'+source.source+':'+key;
 if(source.legacyDrafts){for(const [storage,key] of [[localStorage,'forge-view'],[sessionStorage,'forge-drafts'],[sessionStorage,'forge-pool-draft']]){try{const old=storage.getItem(key);if(old&&!storage.getItem(storageKey(key))){storage.setItem(storageKey(key),old);storage.removeItem(key);}}catch{}}}
 for(const [name,raw] of Object.entries(original)){const profile=original[name]=normalizeProfile(raw);profiles[name]=copy(profile);profile.forgeMode=copy(source.profileModes?.[name]?.settings||{mode:'deepseek',alternatives:[],overrides:{}});profiles[name].forgeMode=copy(profile.forgeMode);}
 function split(route){const m=String(route).match(/:(off|minimal|low|medium|high|xhigh|max|auto)$/);const raw=m?route.slice(0,-m[0].length):route;const slash=raw.indexOf('/');return {raw,provider:raw.slice(0,slash),id:raw.slice(slash+1),effort:m?m[1]:''};}
 const referenced=new Set();for(const p of Object.values(original)){Object.values(p.modelRoles).forEach(x=>referenced.add(split(x).raw));Object.values(p.retry.fallbackChains).flat().forEach(x=>referenced.add(split(x).raw));}
 const referencedProviders=[...new Set([...referenced].map(x=>split(x).provider))];
 const catalogMap=new Map(source.models.map(m=>[m.provider+'/'+m.id,m]));for(const r of referenced){if(!catalogMap.has(r)){const q=split(r);catalogMap.set(r,{provider:q.provider,id:q.id,name:q.id,configuredOnly:true});}}
 const catalog=[...catalogMap.values()].sort((a,b)=>a.provider.localeCompare(b.provider)||a.name.localeCompare(b.name));
 const state={view:'profiles',profile:'standard',device:'desktop',role:roleKeys[0]||'',query:'',catalogQuery:'',catalogMode:'mine',catalogProvider:'all',page:0,favs:[...referenced].slice(0,8),picker:null,modal:null,changes:0,toast:''};
 let timer,drag=null,modalPageY=0,modalReturnFocus='',composing=false,renderCache=null,pointerHeld=false,nativeSelectBusy=false;
 let backgroundRefreshPending=false,backgroundReloading=false,pendingRender=false,backgroundTimer,writeEpoch=0,activeWrites=0,renderedAt=0;
 const pendingModeResults=new Map();
 const narrowSurface=()=>win.clientWidth<=600;
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
 function poolShelf(){return `<div class="pool-shelf" aria-label="Спільні FREE пули">${Object.entries(poolNames).map(([name,label])=>`<div class="pool-bank"><button type="button" class="collection-cut pool-card ${state.armedCut===poolToken(name)?'armed':''}" data-cut="${poolToken(name)}" ${!source.freePools?.[name]?.length?'disabled':''} title="Обери пул і місце на доріжці або перетягни весь пул"><strong>${label}</strong><small>${source.freePools?.[name]?.length||0} CUTS</small></button></div>`).join('')}<button type="button" class="tool tray-toggle ${state.poolPanel?'pressed':''}" data-pool-open="free-good" aria-expanded="${!!state.poolPanel}" aria-controls="pool-editor">Пули · 2</button><small>Спільні для всіх профілів${poolsDirty()?' · є чернетка пулів':''}</small></div>`;}
 function poolEditor(){
  if(!state.poolPanel)return '';const selected=state.poolTab||'free-good';
  return `<section class="mode-panel edit-tray pool-editor" id="pool-editor" aria-label="Спільні FREE пули" tabindex="-1"><div class="mode-panel-head edit-tray-head"><b>CUTS / FREE ПУЛИ</b><span class="tray-scope">Спільні для всіх профілів · окреме збереження</span>${poolsDirty()?tool('Скинути','pool-reset','',state.saving?'disabled':''):''}${tool('×','pool-close','icon-only tray-close','aria-label="Закрити налаштування пулів"')}</div><p class="mode-explainer">Редагуй тут один раз. «Зберегти пули» оновить усі доріжки з цими блоками. Порядок змінюється через ⋯, перетягуванням або Shift + ← / →.</p>${state.poolError?`<p class="mode-problem" role="alert">${esc(state.poolError)}</p>`:''}<div class="pool-tabs" role="group" aria-label="Обрати FREE пул">${Object.entries(poolNames).map(([name,label])=>`<button type="button" class="tool pool-tab ${selected===name?'pressed':''}" data-pool-tab="${name}" aria-pressed="${selected===name}" aria-controls="pool-line-${name}">${label} · ${poolDraft[name].length}</button>`).join('')}</div>${Object.entries(poolNames).map(([name,label])=>`<div class="pool-line" id="pool-line-${name}" data-pool-line="${name}" ${selected===name?'':'hidden'}><div class="alternative-list cut-sequence" aria-label="CUTS ${label}">${poolDraft[name].map((r,i)=>node(name,r,i,poolDraft[name].length,'pool')).join('')}<button type="button" class="tool add-node reserve-drop" data-edit="${name}" data-index="${poolDraft[name].length}" data-group="pool" ${poolDraft[name].length>=30?'disabled':''} aria-label="Додати CUT у ${label}">+ CUT</button></div></div>`).join('')}</section>`;
 }
 function poolBlock(role,route,i,group,mobile=false){const name=poolName(route),tag=group==='alternatives'?'li':'div';return `<${tag} class="node cut-surface pool-block ${mobile?'pool-mobile':''} ${savedChain(role,group)[i]!==route?'changed':''}" data-clip-key="${clipKey(role,route,i,group)}" data-node-role="${esc(role)}" data-index="${i}" data-group="${group}"><button type="button" class="node-name" data-edit="${esc(role)}" data-index="${i}" data-group="${group}" title="${esc((group==='vibe'&&i===0&&vibeAlias(role)?vibeAlias(role)+' · ':'')+poolNames[name])}" aria-label="Відкрити ${poolNames[name]}: спільний пул">${group==='vibe'&&i===0&&vibeAlias(role)?esc(vibeAlias(role))+' · ':''}${poolNames[name]}</button><span class="node-meta"><span class="pool-count">${source.freePools?.[name]?.length||0} CUTS · спільний</span>${slotActionKey(role,i,group)}</span></${tag}>`;}
 root.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b||state.saving)return;if(b.dataset.poolOpen)editTray('pool',!state.poolPanel,b);if(b.dataset.poolTab){state.poolTab=b.dataset.poolTab;state.picker=null;state.cutTarget=null;state.armedCut=null;render();win.querySelector(`[data-pool-tab="${b.dataset.poolTab}"]`)?.focus({preventScroll:true});}if(b.dataset.action==='pool-close')editTray('pool',false);if(b.dataset.action==='pool-save')savePools();if(b.dataset.action==='pool-reset'){try{await reload();poolOriginal=copy(source.freePools);poolDraft=copy(poolOriginal);poolRevision=source.poolsRevision;state.poolError='';render();}catch(error){state.poolError=error.message;render();}}if(b.dataset.action==='pool-undo'||b.dataset.action==='pool-redo')poolStep(b.dataset.action==='pool-undo'?-1:1);if(b.dataset.action==='replace-pool'){state.picker.actionsOnly=false;render();focusPicker();}});

 function clipKey(role,r,i,group){return esc(group+'|'+role+'|'+r+'|'+chain(role,group).slice(0,i).filter(v=>v===r).length);}
 function historyStep(direction){if(state.saving)return;const value=editHistory.step(state.profile,direction);if(!value)return;profiles[state.profile]=value;ForgeTape.intent(direction<0?'undo':'edit');state.picker=null;state.opFeedback=direction<0?'Останню дію скасовано.':'Дію повторено.';render();win.querySelector(`[data-action=${direction<0?'undo':'redo'}]`)?.focus({preventScroll:true});}
 function p(){return profiles[state.profile];}
 function workers(profile=p()){return Object.keys(profile?.task?.agentModelOverrides||{});}
 function agentValues(worker,profile=p()){const value=profile.task?.agentModelOverrides?.[worker];return (Array.isArray(value)?value:[value]).filter(Boolean);}
 function agentLink(worker){const values=agentValues(worker);return values.length===1&&values[0].startsWith('@')?values[0]:'';}
 function agentTier(worker){return ({task:'Vibe GOOD',sonic:'Vibe FAST'})[worker]||'';}
 function agentName(worker){return `<span class="role-code">${esc(worker)}${agentTier(worker)?`<small class="agent-tier">${agentTier(worker)}</small>`:''}</span>`;}
 function agentLinkedTrack(worker,mobile=false){
  const alias=agentLink(worker),[role,effort]=alias.slice(1).split(':'),known=roleKeys.includes(role),retry=p().retry?.modelFallback!==false;
  const detail=known?`Основна${retry?' й резерви ролі':' · резерви вимкнено'}${effort?' · thinking '+effort:''}`:'Модель і резерви визначає OMP';
  const content=`<strong>Успадковує ${esc(alias)}</strong><small>${esc(detail)}</small>${known?'<span class="agent-link-action">До ролі ↗</span>':''}`;
  const link=known?`<button type="button" class="agent-role-link" data-agent-role="${esc(role)}" aria-label="${esc(worker+': '+detail+'. Редагувати роль '+role)}">${content}</button>`:`<div class="agent-role-link unresolved">${content}</div>`;
  const own=known&&!effort?tool('Власний список','','agent-own',`data-agent-copy="${esc(worker)}" aria-label="Створити власний список: ${esc(worker)}" title="Копіювати роль для окремого монтажу агента. Зміни ролі більше не впливатимуть на цей список."`):'';
  return mobile?`<div class="mobile-group agent-linked"><div class="vibe-mobile-heading">${agentName(worker)}</div>${link}${own}</div>`:`<div class="graph-row vibe-row agent-linked"><div class="role-name agent-name" title="${esc(worker)}"><span class="role-index">↳</span>${agentName(worker)}</div>${link}${own}</div>`;
 }
 function agentListNote(worker){const values=agentValues(worker),alias=vibeAlias(worker),single=values.length===1&&!poolName(values[0]);return `Власний список${alias?' · основна з '+alias:''}${single&&!alias?' · резерви з default':' · CUTS за порядком'}${p().retry?.modelFallback===false?' · резерви вимкнено':''}`;}
 function agentSectionHead(){return `<div class="section-line vibe-section"><div><strong>Агенти</strong><span>Прив’язки до ролей або власні списки</span></div><label class="check-field sync-control" title="Після редагування ролі копіює її резерви у власні списки агентів із початковим @role. Успадковані ролі оновлюються завжди. Увімкнення саме по собі не змінює списків."><input type="checkbox" data-sync-vibe ${state.syncVibe?'checked':''}>Копіювати резерви після змін ролей</label></div>`;}
 function focusAgentRole(role){state.role=role;state.picker=null;render();store();const target=narrowSurface()?win.querySelector('#mobile-role'):win.querySelector(`.graph-row:not(.vibe-row) [data-focus-role="${CSS.escape(role)}"]`);target?.focus({preventScroll:true});scrollToControl(target);}
 function copyAgentRole(worker){
  if(state.saving)return;
  const role=agentLink(worker).slice(1);if(!roleKeys.includes(role))return;
  if(modeOff()&&(!modeView(role)||diff(state.profile).length&&!activePlan()?.data)){notify('Дочекайся актуального перегляду замін DeepSeek перед копіюванням.');return;}
  const list=baseChain(role),count=values=>values.reduce((n,r)=>n+(poolName(r)?source.freePools?.[poolName(r)]?.length||0:1),0),counts=[count(list),count(chain(role))];
  if(counts.some(n=>n>30)){notify('У власному списку агента може бути до 30 CUTS. Скороти роль або залиш успадкування.');return;}
  if(counts.includes(1)&&p().retry?.fallbackChains?.default?.length){notify('Для одного CUT у власному списку OMP додасть резерви default. Щоб зберегти поточну поведінку, залиш прив’язку або спочатку додай резерв до ролі.');return;}
  state.poolPanel=false;state.armedCut=null;state.cutTarget=null;
  p().task.agentModelOverrides[worker]=list;
  const overrides=modeSettings().overrides;if(overrides['role:'+role])overrides['vibe:'+worker]=copy(overrides['role:'+role]);else delete overrides['vibe:'+worker];
  state.picker=null;state.opFeedback='Власний список '+worker+' скопійовано з @'+role+'. Роль не змінена. Можна скасувати ↶.';render();
  const target=[...win.querySelectorAll(`[data-edit="${CSS.escape(worker)}"][data-group="vibe"]`)].find(el=>el.getClientRects().length);target?.focus({preventScroll:true});scrollToControl(target);
 }
 function isLocal(provider){return source.ui?.localProviders?.includes(provider)||catalog.some(m=>m.provider===provider&&m.local);}
 // Profile modes are metadata. Only the server compiles native OMP routes.
 function modeSettings(name=state.profile){return profiles[name].forgeMode;}
 function modeOff(){return modeSettings().mode==='no-deepseek';}
 function deepseek(value){return ManaOperator.isPaidDeepSeek(value,catalogMap.get(split(value).raw));}
 function modeList(key){const s=modeSettings();return [...(key==='profile'?s.alternatives:s.overrides[key]??s.alternatives)];}
 function modeBody(name=state.profile){return {profile:name,revision:source.revisions[name],changes:diff(name).filter(c=>!c.path[0].startsWith('forge')),modeSettings:copy(modeSettings(name))};}
 function modeKey(name=state.profile){if(renderCache?.keys.has(name))return renderCache.keys.get(name);const key=JSON.stringify([modeBody(name),profiles[name].forgeRefresh||0]);renderCache?.keys.set(name,key);return key;}
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
 function modeScope(role,group){return group==='vibe'&&vibeAlias(role)?'role:'+vibeAlias(role).slice(1):group+':'+role;}
 function chain(role,group='role'){
  if(group==='pool')return [...poolDraft[role]];
  if(group==='alternatives')return modeList(role);
  return [...(modeView(role,group)?.routes||baseChain(role,group))];
 }
 function ensureModePreview(){
  if(!diff(state.profile).length&&!state.modePanel)return;
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
  const key=modeScope(role,group),count=v.paused.length;
  return `<button type="button" class="mode-row-mark" aria-label="Заміни DeepSeek: ${esc(role)}" data-mode-scope="${esc(key)}" title="${esc(v.substituted?'Замість '+v.original:count+' входжень DeepSeek призупинено')}">${v.substituted?'⇄':'−'+count}</button>`;
 }
 function tariffTimeline(now=Date.now()){
  const hour=3600000,kyivHour=Number(new Intl.DateTimeFormat('en-GB',{hour:'2-digit',hourCycle:'h23',timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}).format(now));
  const start=Math.floor(now/hour)*hour-(kyivHour%4+4)*hour;
  const peak=at=>{const d=new Date(at);return d.getUTCDay()>0&&d.getUTCDay()<6&&((d.getUTCHours()>=1&&d.getUTCHours()<4)||(d.getUTCHours()>=6&&d.getUTCHours()<10));};
  const current=peak(now);let next=(Math.floor(now/hour)+1)*hour;while(peak(next)===current)next+=hour;
  const hours=Math.min(72,Math.max(24,Math.ceil((next-start+12*hour)/(24*hour))*24)),end=start+hours*hour;
  const ranges=[];for(let t=start;t<end;t+=hour){const p=peak(t),last=ranges.at(-1);if(last&&last.peak===p)last.end=t+hour;else ranges.push({start:t,end:t+hour,peak:p});}
  const clock=at=>new Date(at).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit',timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});
  const day=at=>new Date(at).toLocaleDateString('uk-UA',{weekday:'short',day:'numeric',timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});
  const duration=resetCountdown(next,now).replace(/^↻ /,''),text=current?'До сприятливого':'Сприятливе ще',step=hours===24?4:hours===48?8:12;
  const ticks=Array.from({length:hours/step+1},(_,i)=>{const at=start+i*step*hour,major=i%2===0,changed=i===0||day(at)!==day(at-2*step*hour);return {at,x:i*step/hours*100,label:clock(at).slice(0,2),day:major&&changed?day(at):''};});
  return `<div class="tariff-summary ${current?'peak':''}"><span class="tariff-dot"></span><strong>${text} <b>${esc(duration)}</b></strong><span class="tariff-scale-note">${hours===24?'24 год':hours/24+' дні'} · ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}</span>${ManaDisplay.colourControl('tariff','Тариф DeepSeek')}</div><div class="tariff-axis" role="img" aria-label="DeepSeek: ${esc(text+' '+duration)}. Сприятливі та дорогі часові вікна за тарифом DeepSeek. ${hours} годин, місцевий час."><div class="tariff-track">${ranges.map(r=>`<span class="tariff-range ${r.peak?'peak':'offpeak'}" style="left:${(r.start-start)/(end-start)*100}%;width:${(r.end-r.start)/(end-start)*100}%" title="${esc(day(r.start)+' '+clock(r.start)+' — '+day(r.end)+' '+clock(r.end)+(r.peak?' · дороге вікно':' · сприятливе вікно'))}"></span>`).join('')}</div><span class="tariff-now-line" style="left:${(now-start)/(end-start)*100}%"><span class="tariff-now-label">зараз ${clock(now)}</span></span><div class="tariff-ticks">${ticks.map((t,i)=>`<span class="${i===0?'first':i===ticks.length-1?'last':''}" style="left:${t.x}%"><b>${t.label}</b>${t.day?`<small>${esc(t.day)}</small>`:''}</span>`).join('')}</div></div><div class="tariff-caption"><span><i class="offpeak"></i>сприятливе <i class="peak"></i>дороге</span><span>${current?'сприятливе':'дороге'} з ${esc(day(next)+' '+clock(next))}</span></div>`;
 }
 function modeBar(){
  const settings=modeSettings(),plan=activePlan(),modeDirty=diff(state.profile).length>0;
  return `<section class="profile-mode-bar" aria-label="Режим профілю"><div class="mode-control-bank"><div class="mode-toggle mode-shuttle"><span class="mode-shuttle-label"><b>DeepSeek</b><small>${modeOff()?'OFF · заміни':'ON · оригінал'}</small></span><button type="button" class="mode-shuttle-switch" data-profile-mode="${modeOff()?'deepseek':'no-deepseek'}" role="switch" aria-label="DeepSeek у профілі" aria-checked="${!modeOff()}" title="${modeOff()?'Увімкнути DeepSeek · повернути на доріжки':'Вимкнути платний DeepSeek · FREE CUTS залишаються'}" ${state.saving?'disabled':''}><span class="mode-shuttle-zero" aria-hidden="true">0</span><span class="mode-shuttle-one" aria-hidden="true">I</span><span class="mode-shuttle-cap" aria-hidden="true"><i></i></span></button></div><div class="mode-tools">${tool('Заміни · '+settings.alternatives.length,'mode-panel','tray-toggle '+(state.modePanel?'pressed':''),`aria-expanded="${!!state.modePanel}" aria-controls="mode-alternatives"`)}${tool('↻','mode-refresh','icon-only mode-refresh-key','aria-label="Перевірити доступність і оновити заміни" title="Перевірити доступність і оновити заміни" '+(modeOff()?'':'disabled aria-hidden="true"'))}</div><span class="mode-save-note" role="status">${plan?.pending?'Розрахунок…':modeDirty?'Ще не збережено':'Режим збережено'}</span></div><div class="tariff-timeline" data-lcd-screen="tariff" title="${esc(source.tariff?.note||'')} Для тарифів DeepSeek з погодинними вікнами; конкретна ціна залежить від моделі та провайдера.">${tariffTimeline()}</div></section>${plan?.error?`<p class="mode-problem" role="alert">${esc(plan.error)}</p>`:''}${plan?.data?.issues?.length?`<p class="mode-problem" role="alert">${plan.data.issues.map(i=>esc(i.key.replace('role:',''))+': '+esc(i.message)).join('<br>')}</p>`:''}${source.modeConflicts?.length?`<p class="mode-problem" role="alert">Зовнішні зміни: ${esc(source.modeConflicts.join(', '))}. Збереження заблоковане, оригінали не перезаписуються.</p>`:''}`;
 }
 function alternativeCut(key,route,i){return node(key,route,i,modeList(key).length,'alternatives');}

 function modePanel(){
  const key=state.modeScope||'profile',settings=modeSettings(),list=modeList(key),own=key!=='profile'&&Object.hasOwn(settings.overrides,key);
  const scopes=[['profile','Увесь профіль'],...roleKeys.map(r=>['role:'+r,r+' · '+(labels[r]||r)]),...workers().map(w=>['vibe:'+w,'Агент '+w])];
  const alias=key.startsWith('vibe:')?vibeAlias(key.slice(5)):'';
  const plan=activePlan(),preview=plan?.data||(plan?.pending?plan.previous:null);
  const skipped=(preview?.skipped||[]).filter(x=>key==='profile'||x.key===key),uniqueSkipped=[...new Map(skipped.map(x=>[x.route+'|'+x.reason,x])).values()];
  return `<section class="mode-panel edit-tray" id="mode-alternatives" aria-label="Заміни DeepSeek" tabindex="-1">
   <div class="mode-panel-head edit-tray-head"><b>CUTS / ЗАМІНИ</b><label>Для <select id="mode-scope" class="filter-select">${scopes.map(([k,t])=>`<option value="${esc(k)}" ${key===k?'selected':''}>${esc(t)}${Object.hasOwn(settings.overrides,k)?' · власні':''}</option>`).join('')}</select></label><span>${key==='profile'?'Спільний порядок':own?'Власний порядок':'Порядок профілю'}</span>${own?tool('Як у профілі','mode-reset-scope'):''}${tool('×','mode-close','icon-only tray-close','aria-label="Закрити налаштування замін"')}</div>
   <p class="mode-explainer">OFF: цей список стає на місце першого платного DeepSeek у доріжці. FREE CUTS залишаються. ON повертає платний DeepSeek. Ліміти не впливають на заміни. Дублікати й несумісні CUTS пропускаються.${alias?' Агент бере основну модель з '+esc(alias)+'. Заміни налаштовуються в цій ролі.':''}</p>
   ${alias?tool('Заміни для '+esc(alias.slice(1)),'mode-alias-scope','',`data-alias-scope="role:${esc(alias.slice(1))}"`):`<ol class="alternative-list cut-sequence" aria-label="Пріоритет CUTS замін">${list.map((route,i)=>alternativeCut(key,route,i)).join('')}</ol><div class="mode-panel-foot">${tool('+ CUT','', '',`data-edit="${esc(key)}" data-index="${list.length}" data-group="alternatives" ${list.length>=12?'disabled':''}`)}<small>${list.length?'Порядок: ⋯, перетягування або Shift + ← / →.':'Додай CUTS для режиму без DeepSeek.'} Звичайні резерви — після замін.</small></div>`}
   <details class="mode-skipped" ${uniqueSkipped.length?'':'inert aria-hidden="true" style="visibility:hidden"'}><summary>Пропущено під час розрахунку · ${uniqueSkipped.length}</summary>${uniqueSkipped.map(x=>`<p>${esc(cutTitle(x.route))} · ${esc(providerName(split(x.route).provider))} — ${esc(x.reason)}</p>`).join('')}</details>
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
  if(a==='mode-refresh'){p().forgeRefresh=(p().forgeRefresh||0)+1;render();}
  if(a==='make-permanent'){
   const x=state.picker,route=chain(x.role,x.group)[x.index],scope=modeScope(x.role,x.group),[group,role]=scope.split(':');
   const normal=baseChain(role,group);normal[0]=route;oldSetChain(role,normal,group);delete modeSettings().overrides[scope];closePicker();notify('Тепер це постійна основна модель профілю');
  }
 });
 root.addEventListener('change',e=>{if(e.target.id==='mode-scope'){state.modeScope=e.target.value;render();}});

 function short(id){return String(id).replaceAll('-',' ');}
 function cutTitle(route){const m=split(route);return ManaOperator.displayModelName(m.id,catalogMap.get(m.raw)?.name);}
 function cutIdentity(route,compact=false){const m=split(route),name=providerName(m.provider);return `<span class="cut-provider ${compact?'provider-code':''}" title="${esc(name)}">${esc(compact?providerCode(m.provider):name)}</span>${freeBadge(route)}`;}
 function baseChain(role,group='role'){if(group==='vibe'){let a=p().task.agentModelOverrides[role];if(typeof a==='string')a=[a];return (a||[]).map(s=>s.startsWith('@')?(p().modelRoles[s.slice(1)]||s):s);}return [p().modelRoles[role],...(p().retry.fallbackChains[role]||p().retry.fallbackChains.default||[])].filter(Boolean);}
 function vibeAlias(worker){const v=p().task.agentModelOverrides[worker],head=Array.isArray(v)?v[0]:v;return typeof head==='string'&&head.startsWith('@')?head:'';}
 function oldSetChain(role,list,group='role'){if(group==='vibe'){const old=p().task.agentModelOverrides[role],head=Array.isArray(old)?old[0]:old;if(typeof head==='string'&&head.startsWith('@')){p().modelRoles[head.slice(1)]=list[0];p().task.agentModelOverrides[role]=[head,...list.slice(1)];}else p().task.agentModelOverrides[role]=list;}else{p().modelRoles[role]=list[0];p().retry.fallbackChains[role]=list.slice(1);}}
 function options(value,raw){const m=catalogMap.get(raw);const levels=Array.isArray(m?.thinking)&&m.thinking.length?['',...m.thinking]:m?.reasoning===false?['','off']:['','off','minimal','low','medium','high','xhigh','max'];if(value&&!levels.includes(value))levels.push(value);return levels.map(e=>`<option value="${e}" ${e===value?'selected':''}>${e||'типово'}</option>`).join('');}
 function effortControl(m,attrs){const angle={off:-125,minimal:-95,low:-65,medium:0,high:55,xhigh:90,max:125,auto:0}[m.effort]??0;return `<label class="effort-control ${m.effort?'':'automatic'}" style="--turn:${angle}deg"><span class="effort-rotor" aria-hidden="true"></span><select class="effort-select" ${attrs}>${options(m.effort,m.raw)}</select></label>`;}
 function profileOptions(){return [state.profile,...profileKeys.filter(k=>k!==state.profile)].map(k=>`<option value="${esc(k)}" ${k===state.profile?'selected':''}>${esc(prettyProfile(k))}</option>`).join('');}
 function providerName(id){return providerNames[id]||source.providers.find(v=>v.id===id)?.name||id;}
 function routeMatches(route){const m=split(route),model=catalogMap.get(m.raw);return !!state.query.trim()&&matchesQuery(state.query,m.id,model?.name,short(m.id));}
 function freeBadge(route){const m=catalogMap.get(split(route).raw);return m&&priceInfo(m).kind==='free'?'<span class="cut-free" aria-label="Безкоштовний CUT" title="Безкоштовний маршрут. Ліміти провайдера можуть діяти.">FREE</span>':'';}
 function slotClasses(route){return (isLocal(split(route).provider)?' gpu-slot':'')+(routeMatches(route)?' model-match':'');}
 function priceInfo(m){
  if(isLocal(m.provider))return {kind:'local',label:'GPU · локально'};
  const c=m.cost,known=Number.isFinite(c?.input)&&Number.isFinite(c?.output),subscription=(source.insights?.usage?.reports||[]).some(r=>r.provider===m.provider)||m.provider==='commandcode';
  const zero=known&&c.input===0&&c.output===0&&!c.cacheRead&&!c.cacheWrite;
  if(ManaOperator.isFreeModel(m))return {kind:'free',label:'Безкоштовно'};
  if(zero)return {kind:'unknown',label:'Тариф не надано',subscription};
  return {kind:subscription?'subscription':known?'paid':'unknown',label:known?new Intl.NumberFormat('en-US',{maximumFractionDigits:6}).format(c.input)+' / '+new Intl.NumberFormat('en-US',{maximumFractionDigits:6}).format(c.output):'Ціна невідома',subscription,variable:!!c?.timeBased};
 }
 function priceMarkup(m){const price=priceInfo(m);return `<span class="model-price ${price.kind}" title="${price.kind==='local'?'Власний GPU':price.kind==='free'?'Безкоштовний маршрут із нульовим тарифом у каталозі':price.kind==='unknown'?'Каталог не містить підтвердженого тарифу; нуль може означати невідому ціну':'Вхід / вихід · USD за 1 млн токенів. Для підписки це довідковий API-тариф.'}">${esc(price.label)}</span>${price.subscription?'<small class="price-note">Підписка<span class="api-rate-note"> · API-тариф</span></small>':price.variable?'<small class="price-note">Змінний тариф</small>':''}`;}
 function savedChain(role,group='role'){
  if(group==='pool')return poolOriginal[role];
  if(group==='alternatives')return original[state.profile].forgeMode.overrides[role]||original[state.profile].forgeMode.alternatives;
  const profile=original[state.profile],view=profile.forgeMode?.mode==='no-deepseek'?source.profileModes?.[state.profile]?.views?.[group]?.[role]:null;
  if(view?.routes)return view.routes;
  if(group==='vibe'){const raw=profile.task.agentModelOverrides[role],list=Array.isArray(raw)?raw:[raw];return list.filter(Boolean).map(v=>v.startsWith('@')?profile.modelRoles[v.slice(1)]:v);}
  return [profile.modelRoles[role],...(profile.retry.fallbackChains[role]||profile.retry.fallbackChains.default||[])];
 }
 function node(role,r,i,n,group='role'){
  if(poolName(r))return poolBlock(role,r,i,group);
  const m=split(r),before=savedChain(role,group)[i],sequence=group==='alternatives'||group==='pool',tag=group==='alternatives'?'li':'div',replacement=temporarySlot(role,i,group);
  return `<${tag} class="node cut-surface ${group==='alternatives'?'alternative-cut':''} ${!sequence&&i===0?'primary':''} ${i<n-1?'has-next':''} ${before!==r?'changed':''}${replacement?' mode-replacement':''}${slotClasses(r)}" data-clip-key="${clipKey(role,r,i,group)}" data-node-role="${esc(role)}" data-before="${esc(before!==r?before:'')}" data-index="${i}" data-group="${group}" draggable="false" ${group==='alternatives'?`title="${esc(modeStatus(m.raw).reason)}"`:''}><button type="button" class="node-name ${sequence?'sequence-label':''} ${group==='alternatives'?'alternative-label':''}" draggable="false" data-edit="${esc(role)}" data-index="${i}" data-group="${group}" title="${esc(r+(before!==r?(before?' · До зміни: '+before:' · Новий CUT'):''))}" aria-label="Змінити CUT ${i+1}, ${esc(group==='pool'?poolNames[role]:role)}: ${esc(r)}">${sequence?`<span class="alternative-order cut-order" aria-hidden="true">${String(i+1).padStart(2,'0')}</span>`:''}${group==='vibe'&&i===0&&vibeAlias(role)?esc(vibeAlias(role))+' · ':''}${replacement?'<span class="replacement-glyph" title="Замість DeepSeek">⇄</span>':''}<span class="cut-title">${esc(cutTitle(r))}</span>${routeWarning(m.raw)?'<span class="warning-dot">!</span>':''}</button><span class="node-meta cut-meta">${cutIdentity(r,true)}${effortControl(m,`data-effort-role="${esc(role)}" data-index="${i}" data-group="${group}" aria-label="Thinking: ${esc(role)}, CUT ${i+1}"`)}${slotActionKey(role,i,group)}</span></${tag}>`;
 }


 function stepCount(){
  if(renderCache?.steps!=null)return renderCache.steps;
  // Reserve the same columns for ON and OFF before the asynchronous preview arrives.
  const count=(role,group='role')=>{const base=baseChain(role,group),at=base.findIndex(deepseek),projected=at<0?base:[...base.slice(0,at),...modeList(modeScope(role,group)),...base.slice(at).filter(r=>!deepseek(r))];return Math.max(base.length,new Set(projected.map(r=>split(r).raw)).size,chain(role,group).length);};
  const steps=Math.max(8,1+Math.max(...roleKeys.map(r=>count(r)),...workers().map(r=>count(r,'vibe'))));if(renderCache)renderCache.steps=steps;return steps;
 }
 function graphRow(role,index,group='role'){
  const list=chain(role,group),agent=group==='vibe';
  const label=agent?`<div class="role-name agent-name" title="${esc(agentListNote(role))}"><span class="role-index">↳</span>${agentName(role)}</div>`:`<button type="button" class="role-name" data-focus-role="${esc(role)}" title="${esc(role+' · '+(labels[role]||role))}"><span class="role-index">${role===state.role?'▸':'·'}</span><span class="role-code">${esc(role)}</span></button>`;
  return `<div class="graph-row ${agent?'vibe-row':''} ${role===state.role&&!agent?'focused':''}">${label}${modeTag(role,group)}${list.map((r,i)=>node(role,r,i,list.length,group)).join('')}<button type="button" class="add-node reserve-drop" style="grid-column:span ${stepCount()-list.length+1}" data-edit="${esc(role)}" data-index="${list.length}" data-group="${group}" aria-label="Додати ${agent?'кандидата':'резерв'}: ${esc(role)}" title="Додати CUT у кінець доріжки"><span>+</span><small>${agent?'кандидат':'резерв'}</small></button></div>`;
 }
 function vibeDesktop(){return `<div class="graph">${workers().map((worker,i)=>agentLink(worker)?agentLinkedTrack(worker):`<div class="agent-list-note">${esc(worker)} · ${esc(agentListNote(worker))}</div>${graphRow(worker,i,'vibe')}`).join('')}</div>`;}
 function mobileVibe(){return `<section class="mobile-vibe" aria-label="Агенти">${agentSectionHead()}${workers().map(worker=>{if(agentLink(worker))return agentLinkedTrack(worker,true);const list=chain(worker,'vibe');return `<div class="mobile-group"><div class="vibe-mobile-heading">${agentName(worker)}<span>${esc(agentListNote(worker))}</span></div>${list.map((r,i)=>mobileLine(worker,r,i,list.length,'vibe')).join('')}<div class="tree-add">${tool('+ Додати кандидата','', '',`data-edit="${esc(worker)}" data-index="${list.length}" data-group="vibe"`)}</div></div>`;}).join('')}</section>`;}
 function poolActionContext(){return state.view==='profiles'&&state.poolPanel;}
 function profileActions(){
  const pool=poolActionContext(),h=editHistory.available(pool?'@free-pools':state.profile),dirty=pool?poolsDirty():state.changes,scope=pool?'FREE пули':state.view==='profiles'&&state.modePanel?'Заміни · профіль':'Профіль',saveBlocked=!pool&&(activePlan()?.pending||activePlan()?.error||activePlan()?.data?.issues?.length||source.modeConflicts?.length);
  return `<span class="profile-actions editor-actions ${dirty||state.saving?'dirty':''}" data-edit-scope="${pool?'pool':'profile'}" aria-label="Збереження: ${scope}"><span class="action-scope">${scope}</span><span class="edit-history">${tool('↶',pool?'pool-undo':'undo','icon-only','aria-label="Скасувати зміну: '+scope+'" title="Скасувати · ⌘/Ctrl Z" '+(!h.undo||state.saving?'disabled':''))}${tool('↷',pool?'pool-redo':'redo','icon-only','aria-label="Повторити зміну: '+scope+'" title="Повторити · ⌘/Ctrl Shift Z" '+(!h.redo||state.saving?'disabled':''))}</span>${tool(state.saving?'Збереження…':dirty?pool?'Зберегти пули':'Зберегти · '+state.changes:pool?'Пули збережено':'Збережено',pool?'pool-save':'save',dirty?'primary':'saved-key',!dirty||state.saving||saveBlocked?'disabled':'')}</span>`;
 }



 function slotActionKey(role,index,group,mobile=false){return chain(role,group).length>1||group==='pool'||group==='alternatives'||poolName(chain(role,group)[index])||temporarySlot(role,index,group)?`<button type="button" class="${mobile?'more-mobile':'slot-actions'}" data-slot-actions="${esc(role)}" data-index="${index}" data-group="${group}" aria-label="Дії з CUT: ${esc(role)}, слот ${index+1}" title="Порядок / дії з CUT">⋯</button>`:'';}
 function mobileLine(role,r,i,n,group='role'){if(poolName(r))return poolBlock(role,r,i,group,true);const m=split(r);return `<div class="tree-line cut-surface ${i===0?'main':''} ${savedChain(role,group)[i]!==r?'changed':''}${temporarySlot(role,i,group)?' mode-replacement':''}${slotClasses(r)}" data-clip-key="${clipKey(role,r,i,group)}"><span class="tree-number">${i===0?'●':String(i).padStart(2,'0')}</span><button type="button" data-edit="${esc(role)}" data-index="${i}" data-group="${group}" title="${esc(r)}" aria-label="Змінити CUT ${i+1}, ${esc(role)}: ${esc(r)}"><strong class="cut-title">${temporarySlot(role,i,group)?'⇄ ':''}${esc(cutTitle(r))}</strong><small class="cut-meta">${temporarySlot(role,i,group)?'Замість DeepSeek · ':''}${routeWarning(m.raw)?'⚠ ':''}${isLocal(m.provider)?'GPU · ':''}${cutIdentity(r)}${group==='vibe'&&i===0&&vibeAlias(role)?' · '+esc(vibeAlias(role)):''}</small></button>${effortControl(m,`data-effort-role="${esc(role)}" data-index="${i}" data-group="${group}" aria-label="Thinking ${i===0?'основної моделі':'резерв '+i}"`)}${slotActionKey(role,i,group,true)}</div>`;}


 function mobileTracks(){const list=chain(state.role);return `${state.query.trim()?roleKeys.map(role=>`<section class="search-role-group"><h3>${esc(role)} <small>${esc((labels[role]||role))}</small></h3>${chain(role).map((r,i)=>mobileLine(role,r,i,chain(role).length)).join('')}</section>`).join(''):list.map((r,i)=>mobileLine(state.role,r,i,list.length)).join('')}<div class="tree-add">${tool('+ Додати резерв','add-mobile')}</div>${mobileVibe()}`;}
 function profileView(){const shown=roleKeys;return `${poolShelf()}${poolEditor()}${state.modePanel?modePanel():''}<div class="profile-workbench"><section id="profile-tracks" class="tape-workspace" aria-label="Доріжки ролей">${state.armedCut?`<div class="cut-placement" role="status"><span>Обрано <b>${esc(poolNames[poolName(state.armedCut)]||cutTitle(state.armedCut))}</b>. Торкнись CUT для заміни або + для додавання.</span>${tool('Скасувати','cancel-cut')}</div>`:''}<div class="track-tools"><label class="search"><input id="role-query" value="${esc(state.query)}" placeholder="Підсвітити CUT на плівці" aria-label="Знайти CUT на плівці"></label><span class="health-legend">${state.health?'HEALTH · ● запас · △ малий · ∅ нуль · ? немає виміру · ◈ GPU':'HEALTH вимкнено · чиста плівка'}</span></div><div class="mobile-controls"><div class="mobile-title"><span class="mobile-save-state" role="status">${state.saving?'Збереження…':state.changes?'Незбережено':'Збережено'}</span></div><div class="role-stepper">${tool('‹','prev-role','icon-only','aria-label="Попередня роль"')}<select id="mobile-role" aria-label="Роль">${roleKeys.map(r=>`<option value="${r}" ${r===state.role?'selected':''}>${r} · ${(labels[r]||r)}</option>`).join('')}</select>${tool('›','next-role','icon-only','aria-label="Наступна роль"')}</div></div><div class="desktop-graph ${modeOff()&&diff(state.profile).length&&!activePlan()?.data?'mode-pending':''}" ${modeOff()&&diff(state.profile).length&&!activePlan()?.data?'inert':''}><div class="graph"><div class="graph-head"><span>Роль / доріжка</span><span>Основна</span>${Array.from({length:stepCount()-1},(_,i)=>i+1).map(n=>`<span>Резерв ${n}</span>`).join('')}<span></span></div>${shown.map(r=>graphRow(r,roleKeys.indexOf(r))).join('')}</div>${agentSectionHead()}<div class="vibe-list">${vibeDesktop()}</div></div><div class="mobile-tree ${modeOff()&&diff(state.profile).length&&!activePlan()?.data?'mode-pending':''}" ${modeOff()&&diff(state.profile).length&&!activePlan()?.data?'inert':''}>${mobileTracks()}</div><div class="legend">${referencedProviders.map(v=>`<span><b>${esc(providerCode(v))}</b>${esc(providerName(v))}</span>`).join('')}</div><p class="view-note">Збереження застосовується до нових запусків OMP. Активні сесії зберігають свої налаштування.</p></section></div>`;}


 function myProviderIds(){
  // Native availability includes public routes; it is not proof of a subscription.
  const subscribed=new Set((source.insights?.usage?.reports||[]).map(r=>r.provider));
  return new Set(source.providers.filter(v=>v.custom||v.managed||v.used.length||subscribed.has(v.id)).map(v=>v.id));
 }
 function pickerModels(x){
  const mine=myProviderIds(),disabled=new Set(p().disabledProviders||[]);
  return catalog.filter(m=>(x.group!=='pool'||ManaOperator.isFreeModel(m))&&(x.group!=='alternatives'||!deepseek(m.provider+'/'+m.id))&&m.status!=='missing'&&!disabled.has(m.provider)&&!source.providers.find(v=>v.id===m.provider)?.expired&&(x.scope==='all'||mine.has(m.provider)));
 }
 function pickerRow(model,current=false){
  const x=state.picker,r=model.provider+'/'+model.id,used=chain(x.role,x.group).some(v=>split(v).raw===r);
  return `<button type="button" class="picker-row collection-cut cut-surface ${current?'is-current':''} ${isLocal(model.provider)?'gpu-option':''}" data-pick="${esc(r)}" data-cut-route="${esc(r)}" data-health-route="${esc(r)}" aria-pressed="${current}" aria-label="${esc(cutTitle(r)+' · '+r)}" title="${esc(r)}"><span class="cut-hole" aria-hidden="true"></span><span class="picker-detail"><strong class="cut-title">${esc(cutTitle(r))}</strong><small class="cut-meta">${cutIdentity(r)}${current?' · Поточний CUT':used?' · На доріжці':''}${routeWarning(r)?' · Потребує уваги':''}</small></span>${isLocal(model.provider)?'<span class="gpu-badge">GPU</span>':''}</button>`;
 }

 function pickerMarkup(){
  const x=state.picker;if(!x)return '';
  const list=chain(x.role,x.group),current=list[x.index],m=current?split(current):null;
  const head=`<div class="picker-top"><strong>${esc(x.group==='alternatives'?'Заміни · '+(x.role==='profile'?'профіль':x.role.split(':')[1]):x.group==='vibe'?'Агент '+(x.role):x.role)} · ${x.group==='alternatives'?x.index+1:x.index===0?'основна':'резерв '+x.index}</strong>${tool('×','picker-close','icon-only','aria-label="Закрити вибір"')}</div>`;
  if(x.actionsOnly){
   const sequence=x.group==='alternatives'||x.group==='pool',isPool=poolName(current),canRemove=sequence||x.index>0||isPool&&list.length>1,waiting=pickerActionsPending();
   return `<section class="picker cut-tools" role="toolbar" tabindex="-1" aria-busy="${waiting}" aria-label="Дії з CUT ${x.index+1}: ${esc(x.role)}" style="top:${x.top}px;left:${x.left}px">${list.length>1?`<span class="cut-move-keys" role="group" aria-label="Порядок CUT"><button type="button" class="cut-key" data-action="move-node" data-direction="-1" ${waiting||x.index===0?'disabled':''} aria-label="Перемістити CUT раніше"><span aria-hidden="true">←</span><b>Раніше</b></button><button type="button" class="cut-key" data-action="move-node" data-direction="1" ${waiting||x.index===list.length-1?'disabled':''} aria-label="Перемістити CUT пізніше"><b>Пізніше</b><span aria-hidden="true">→</span></button></span>`:''}${!sequence&&temporarySlot(x.role,x.index,x.group)?'<button type="button" class="cut-key" data-action="make-permanent" '+(waiting?'disabled':'')+'><span aria-hidden="true">●</span><b>Закріпити</b></button>':''}${!sequence&&!isPool&&x.index>0?'<button type="button" class="cut-key" data-action="promote-node" '+(waiting?'disabled':'')+'><span aria-hidden="true">▰</span><b>Основна</b></button>':''}${isPool?tool('Замінити','replace-pool','cut-key',waiting?'disabled':''):''}${canRemove?'<button type="button" class="cut-key cut-eject" data-action="remove-node" '+(waiting?'disabled':'')+'><span aria-hidden="true">⏏</span><b>Прибрати</b></button>':''}<button type="button" class="cut-key cut-tools-close" data-action="picker-close" aria-label="Закрити дії з CUT">×</button></section>`;
  }
  const pool=pickerModels(x),q=x.query.trim(),ids=[...myProviderIds()].sort((a,b)=>providerName(a).localeCompare(providerName(b))),inProfile=new Set([...Object.values(p().modelRoles),...Object.values(p().retry.fallbackChains).flat()].map(v=>split(v).raw));
  const found=pool.filter(a=>(x.provider==='all'||x.provider===a.provider)&&matchesQuery(q,a.name,a.id,a.provider,providerName(a.provider)));
  const selected=m?(catalogMap.get(m.raw)||{...m,name:short(m.id)}):null;
  if(selected&&!found.some(a=>a.provider+'/'+a.id===m.raw)&&(!q||matchesQuery(q,selected.name,selected.id,selected.provider))&&(x.provider==='all'||x.provider===selected.provider))found.unshift(selected);
  found.sort((a,b)=>Number(b.provider+'/'+b.id===m?.raw)-Number(a.provider+'/'+a.id===m?.raw)||Number(inProfile.has(b.provider+'/'+b.id))-Number(inProfile.has(a.provider+'/'+a.id))||Number(state.favs.includes(b.provider+'/'+b.id))-Number(state.favs.includes(a.provider+'/'+a.id)));
  const shown=found.slice(0,x.limit);
  return `<section class="picker quick-picker" role="dialog" tabindex="-1" aria-label="${current?'Заміна':'Додавання'} CUT" style="top:${x.top}px;left:${x.left}px">${head}<div class="quick-search"><label class="search">${icon('search')}<input id="picker-search" placeholder="Знайти CUT…" value="${esc(x.query)}" aria-label="Знайти CUT" aria-controls="picker-results" autocomplete="off"></label>${opSelect('picker-provider','EDITION',x.scope==='all'?'*':x.provider,[['all','Мої'],...ids.map(id=>[id,providerName(id)]),['*','Весь каталог']])}</div>${x.scope==='all'?'<p class="picker-hint">Доступ залежить від підключення провайдера.</p>':''}${x.group==='vibe'&&x.index===0&&vibeAlias(x.role)?`<p class="picker-hint">Через ${esc(vibeAlias(x.role))} · зміниться також ця роль</p>`:''}<div class="picker-results" id="picker-results" data-filter-key="${esc(JSON.stringify([x.role,x.group,x.query,x.provider,x.scope]))}">${shown.length?shown.map(a=>pickerRow(a,a.provider+'/'+a.id===m?.raw)).join(''):'<div class="picker-empty">Збігів немає</div>'}${found.length>shown.length?tool('Ще '+(found.length-shown.length),'picker-more','picker-more'):''}</div></section>`;
 }

 function pickerFocus(x){
  const index=Math.max(0,Math.min(x.index,chain(x.role,x.group).length-1));
  [...win.querySelectorAll(`[data-edit="${CSS.escape(x.role)}"][data-index="${index}"][data-group="${x.group}"]`)].find(el=>el.getClientRects().length)?.focus({preventScroll:true});
 }
 function closePicker(restore=true){const x=state.picker;state.picker=null;render();if(restore&&x)pickerFocus(x);}
 function pickerActionsPending(){const x=state.picker;return !!(x&&x.group!=='alternatives'&&x.group!=='pool'&&modeOff()&&diff(state.profile).length&&!activePlan()?.data);}
 function movePickerCut(direction){
  const x=state.picker;if(!x||state.saving||pickerActionsPending())return;
  const list=chain(x.role,x.group),to=x.index+direction;if(to<0||to>=list.length)return;
  [list[x.index],list[to]]=[list[to],list[x.index]];setChain(x.role,list,x.group);x.index=to;x.focusDirection=direction;render();
  focusPickerMove(direction);
 }
 function focusPickerMove(direction){(win.querySelector(`.cut-tools [data-action=move-node][data-direction="${direction}"]:not(:disabled)`)||win.querySelector('.cut-tools [data-action=move-node]:not(:disabled)')||win.querySelector('.cut-tools'))?.focus({preventScroll:true});}

 function notify(s){state.toast=s;render();clearTimeout(timer);timer=setTimeout(()=>{state.toast='';win.querySelector('.toast')?.remove();},2700);}
 function openPicker(role,index,group,el,actionsOnly=false){
  if(!actionsOnly&&poolName(chain(role,group)[index])){state.poolTab=poolName(chain(role,group)[index]);editTray('pool',true,el);return;}
  if(group!=='pool')state.poolPanel=false;
  if((group||'role')==='role')state.role=role;
  if(!actionsOnly&&Number(index)>=chain(role,group).length&&group!=='alternatives'&&group!=='pool'){state.cuts=true;state.cutTarget={role,index:Number(index),group:group||'role'};render();(coarsePointer()?win.querySelector('.cuts-drawer [data-cut]')||win.querySelector('#cuts-resize'):win.querySelector('#cut-query'))?.focus({preventScroll:true});return;}

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
  // Keep the real input (selection, IME and native undo) alive; only results change.
  const previousCache=renderCache;renderCache={diffs:new Map(),keys:new Map()};
  try{
   if(id==='role-query'){
    for(const node of win.querySelectorAll('[data-node-role]')){const d=node.dataset;node.classList.toggle('model-match',routeMatches(chain(d.nodeRole,d.group)[Number(d.index)]));}
    const tree=win.querySelector('.mobile-tree');if(tree){tree.innerHTML=mobileTracks();decorateHealth(tree);}return;
   }
   const template=document.createElement('template');
   if(id==='picker-search'){
    if(!state.picker)return;template.innerHTML=pickerMarkup();const result=template.content.querySelector('.picker-results');win.querySelector('.picker-results')?.replaceWith(result);decorateHealth(result);return;
   }
   if(id==='cut-query'){
    template.innerHTML=cutsTray();const result=template.content.querySelector('.drawer-results');if(!result)return;win.querySelector('.drawer-results')?.replaceWith(result);win.querySelector('.drawer-count').textContent=template.content.querySelector('.drawer-count').textContent;decorateHealth(result);return;
   }
   if(id==='catalog-query'){
    template.innerHTML=operatorCatalog();const current=win.querySelector('.catalog-surface'),next=template.content.querySelector('.catalog-surface');
    for(const child of [...current.children])if(!child.matches('.surface-controls,.analysis-source-controls'))child.remove();
    for(const child of [...next.children])if(!child.matches('.surface-controls,.analysis-source-controls'))current.append(child);
    ManaDisplay.sync();
   }
  }finally{renderCache=previousCache;}
 }
 function searchInput(el){
  const fields={'role-query':'query','catalog-query':'catalogQuery','cut-query':'cutQuery'},key=fields[el.id];
  if(el.id==='picker-search'){if(!state.picker)return;state.picker.query=el.value;state.picker.limit=40;}
  else if(key){state[key]=el.value;if(key==='catalogQuery'){state.analyze=null;state.page=0;}}else return;
  if(!composing)refreshSearch(el.id);
 }
 root.addEventListener('compositionstart',()=>{composing=true;});
 root.addEventListener('compositionend',e=>{composing=false;searchInput(e.target);scheduleBackgroundWork();});
 root.addEventListener('input',e=>{if(e.isComposing)composing=true;searchInput(e.target);});
 root.addEventListener('change',e=>searchInput(e.target));
 root.addEventListener('click',e=>{if(e.target.closest('.cut-tools [data-action]:not([data-action=picker-close])')&&pickerActionsPending()){e.preventDefault();e.stopImmediatePropagation();}},true);
 root.addEventListener('click',e=>{if(e.target.closest('.profile-menu button'))win.querySelector('.profile-menu')?.removeAttribute('open');},true);
 root.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b){const n=e.target.closest('[data-node-role]');if(n&&!e.target.closest('select,.effort-control'))openPicker(n.dataset.nodeRole,n.dataset.index,n.dataset.group,n);return;}if(b.dataset.device){state.device=b.dataset.device;state.page=0;state.picker=null;render();store();return;}if(b.dataset.view){state.view=b.dataset.view;state.picker=null;state.armedCut=null;state.cutTarget=null;state.query='';state.page=0;render();store();if(b.dataset.subscription){const panel=win.querySelector(`[data-quota-provider="${CSS.escape(b.dataset.subscription)}"]`);panel?.scrollIntoView({block:'center',behavior:'instant'});panel?.focus({preventScroll:true});}return;}if(b.dataset.slotActions){openPicker(b.dataset.slotActions,b.dataset.index,b.dataset.group,b,true);return;}if(b.dataset.catalogProvider){state.catalogProvider=b.dataset.catalogProvider;state.analyze=null;state.page=0;render();return;}if(b.dataset.edit){openPicker(b.dataset.edit,b.dataset.index,b.dataset.group,b);return;}if(b.dataset.agentCopy){copyAgentRole(b.dataset.agentCopy);return;}if(b.dataset.agentRole){focusAgentRole(b.dataset.agentRole);return;}if(b.dataset.focusRole){state.role=b.dataset.focusRole;render();store();return;}if(b.dataset.mode){state.catalogMode=b.dataset.mode;state.catalogProvider='all';state.page=0;render();return;}if(b.dataset.fav){const r=b.dataset.fav;state.favs=state.favs.includes(r)?state.favs.filter(x=>x!==r):[...state.favs,r];render();try{await api('/api/favorites',{values:state.favs});}catch(e){notify(e.message);}return;}if(b.dataset.removeRole){const r=b.dataset.removeRole,g=b.dataset.group,a=chain(r,g);a.splice(Number(b.dataset.index),1);setChain(r,a,g);state.changes++;render();return;}if(b.dataset.pick){const x=state.picker,a=chain(x.role,x.group),previous=a[x.index]?split(a[x.index]):null;if(previous?.raw===b.dataset.pick){closePicker();return;}const known=catalogMap.get(b.dataset.pick),prior=previous?.effort||'',old=prior&&Array.isArray(known?.thinking)&&known.thinking.includes(prior)?prior:prior==='off'&&known?.reasoning===false?'off':'';a[x.index]=b.dataset.pick+(old?':'+old:'');setChain(x.role,a,x.group);closePicker();if(prior&&!old)notify('Thinking → типово: '+prior+' не підтверджено для нової моделі.');return;}

 const a=b.dataset.action;if(a==='quota-expand'){state.quotasExpanded=!state.quotasExpanded;render();win.querySelector('[data-action=quota-expand]')?.focus({preventScroll:true});}if(a==='clear-search'){state.query='';render();win.querySelector('#role-query')?.focus();}if(a==='save'){await save();}if(a==='undo'||a==='redo')historyStep(a==='undo'?-1:1);if(a==='reset-draft'){state.poolPanel=false;profiles[state.profile]=copy(original[state.profile]);state.picker=null;render();}if(a==='next-role'||a==='prev-role'){const i=roleKeys.indexOf(state.role);state.role=roleKeys[(i+(a==='next-role'?1:roleKeys.length-1))%roleKeys.length];state.picker=null;render();store();}if(a==='add-mobile')openPicker(state.role,chain(state.role).length,'role',b);if(a==='picker-close')closePicker();if(a==='picker-more'){const offset=win.querySelector('.picker-results').scrollTop;state.picker.limit+=40;render();win.querySelector('.picker-results').scrollTop=offset;}if(a==='move-node'){movePickerCut(Number(b.dataset.direction));return;}if(['remove-node','promote-node'].includes(a)){const x=state.picker;if(!x||x.index===0&&x.group!=='alternatives'&&x.group!=='pool'&&!(poolName(chain(x.role,x.group)[0])&&chain(x.role,x.group).length>1))return;const list=chain(x.role,x.group);if(a==='remove-node')list.splice(x.index,1);else{list.unshift(list.splice(x.index,1)[0]);x.index=0;}setChain(x.role,list,x.group);closePicker();}if(a==='prev-page'||a==='next-page'){state.page+=a==='next-page'?1:-1;render();}if(a==='provider-add'){state.editProvider=null;state.modalError='';state.modal='provider';render();win.querySelector('input[name=name]')?.focus();}if(a==='modal-close'){state.modal=null;state.modalError='';render();}if(a==='provider-create'){await saveProvider();}

 });
 root.addEventListener('change',e=>{const el=e.target;if(el.id==='profile-choice'||el.id==='provider-profile'||el.id==='catalog-profile-target'){state.poolPanel=false;state.profile=el.value;state.picker=null;state.armedCut=null;state.cutTarget=null;render();store();}if(el.id==='mobile-role'||el.id==='catalog-role-target'){state.role=el.value;state.picker=null;render();store();}if(el.dataset.effortRole){el.focus({preventScroll:true});const role=el.dataset.effortRole,g=el.dataset.group,a=chain(role,g),i=Number(el.dataset.index);a[i]=split(a[i]).raw+(el.value?':'+el.value:'');setChain(role,a,g);state.changes++;render();}if(el.id==='catalog-provider'){state.catalogProvider=el.value;state.analyze=null;state.page=0;render();}if(el.id==='picker-provider'){state.picker.scope=el.value==='*'?'all':'mine';state.picker.provider=el.value==='*'?'all':el.value;state.picker.limit=40;render();if(coarsePointer())win.querySelector('#picker-provider')?.focus({preventScroll:true});else focusPicker();}if(el.id==='picker-effort'){el.focus({preventScroll:true});const x=state.picker,list=chain(x.role,x.group);list[x.index]=split(list[x.index]).raw+(el.value?':'+el.value:'');setChain(x.role,list,x.group);render();}if(el.dataset.providerToggle){const id=el.dataset.providerToggle;p().disabledProviders=(p().disabledProviders||[]).filter(x=>x!==id);if(!el.checked)p().disabledProviders.push(id);state.changes++;render();}});

 root.addEventListener('keydown',e=>{
  const clip=e.target.closest('[data-edit]');
  if(clip?.closest('[data-node-role],.tree-line')&&!state.picker&&!state.modal&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Delete'].includes(e.key)){
   e.preventDefault();const {edit:role,group}=clip.dataset,index=Number(clip.dataset.index),list=chain(role,group),step=e.key==='ArrowLeft'?-1:1;
   if(e.shiftKey&&['ArrowLeft','ArrowRight'].includes(e.key)){const to=index+step;if(to>=0&&to<list.length){[list[index],list[to]]=[list[to],list[index]];setChain(role,list,group);render();pickerFocus({role,group,index:to});}return;}
   if(e.key==='Delete'){if(index>0||group==='alternatives'||group==='pool'||poolName(list[0])&&list.length>1){list.splice(index,1);setChain(role,list,group);render();pickerFocus({role,group,index:Math.min(index,list.length-1)});}return;}
   let nextRole=role,nextIndex=index;
   if(group==='alternatives'||group==='pool')nextIndex=Math.max(0,Math.min(list.length-1,index+(['ArrowLeft','ArrowUp'].includes(e.key)?-1:1)));
   else if(['ArrowUp','ArrowDown'].includes(e.key)){const roles=group==='vibe'?workers():roleKeys,at=roles.indexOf(role)+(e.key==='ArrowUp'?-1:1);nextRole=roles[Math.max(0,Math.min(roles.length-1,at))];nextIndex=Math.min(index,chain(nextRole,group).length-1);}
   else nextIndex=Math.max(0,Math.min(list.length-1,index+step));
   if(group==='role')state.role=nextRole;render();pickerFocus({role:nextRole,group,index:nextIndex});return;
  }
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'&&!e.target.matches('input,textarea,select')&&!state.modal){e.preventDefault();(e.target.closest('.pool-editor')||state.picker?.group==='pool'||poolActionContext()?poolStep:historyStep)(e.shiftKey?1:-1);return;}
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'&&['profiles','models'].includes(state.view)&&!state.modal){e.preventDefault();const poolContext=e.target.closest('.pool-editor')||state.picker?.group==='pool'||poolActionContext();state.picker=null;(poolContext?savePools:save)();return;}
  if(e.key==='Escape'&&win.querySelector('.profile-menu[open]')){const menu=win.querySelector('.profile-menu');menu.removeAttribute('open');menu.querySelector('summary').focus();return;}
  if(e.key==='Escape'&&(e.defaultPrevented||e.target.closest('select')&&(CSS.supports('selector(select:open)')?e.target.closest('select').matches(':open'):true)))return;
  if(e.key==='Escape'&&(state.picker||state.modal)){e.preventDefault();if(state.picker){closePicker();return;}state.modal=null;state.modalError='';render();return;}
  if(e.key==='Escape'&&!state.picker&&!state.modal&&(state.poolPanel||state.modePanel)){e.preventDefault();editTray(state.poolPanel?'pool':'alternatives',false);return;}
  if(e.key==='Enter'&&e.target.closest('#new-provider')&&!e.target.matches('textarea,select')){e.preventDefault();win.querySelector('[data-action=provider-create]')?.click();}
  if(state.picker&&e.target.closest('.picker')){
   const rows=[...win.querySelectorAll('.picker-results [data-pick]')];
   if(['ArrowDown','ArrowUp'].includes(e.key)&&(e.target.id==='picker-search'||e.target.hasAttribute('data-pick'))){e.preventDefault();const i=rows.indexOf(e.target),next=i<0?(e.key==='ArrowDown'?0:rows.length-1):Math.max(0,Math.min(rows.length-1,i+(e.key==='ArrowDown'?1:-1)));rows[next]?.focus();}
   if(e.key==='Enter'&&e.target.id==='picker-search'){e.preventDefault();if(state.picker.query.trim())rows[0]?.click();else win.querySelector('.picker-row.is-current')?.click();}
  }
 });
 document.addEventListener('click',e=>{if(!e.target.closest('.profile-menu'))win.querySelector('.profile-menu')?.removeAttribute('open');if(state.picker&&!e.target.closest('.picker,[data-edit],[data-slot-actions],[data-node-role],[data-action="add-mobile"]'))closePicker(false);});
 // One pointer gesture for both the label and the segment edge. Native buttons
 // consume HTML dragging in WebKit; keep native buttons for click/keyboard access.
 let suppressClipClick=false;
 function endClipDrag(){
  const d=drag;drag=null;if(!d)return;
  d.node.classList.remove('tape-lifted');d.node.style.translate='';d.node.style.zIndex='';
  d.node.closest('.graph-row')?.classList.remove('tape-editing');d.target?.classList.remove('drag-over');
  if(root.hasPointerCapture(d.pointer))root.releasePointerCapture(d.pointer);
  return d;
 }
 root.addEventListener('pointerdown',e=>{
  suppressClipClick=false;
  const n=e.target.closest('[data-node-role]');
  if(!n||e.button!==0||e.pointerType==='touch'||state.saving||state.picker||e.target.closest('select,.effort-control,.slot-actions'))return;
  drag={node:n,role:n.dataset.nodeRole,index:Number(n.dataset.index),group:n.dataset.group,x:e.clientX,y:e.clientY,pointer:e.pointerId,active:false,target:null};
 });
 root.addEventListener('pointermove',e=>{
  if(!drag||e.pointerId!==drag.pointer)return;
  const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
  if(!drag.active&&Math.hypot(dx,dy)<6)return;
  e.preventDefault();
  if(!drag.active){drag.active=true;root.setPointerCapture(e.pointerId);drag.node.classList.add('tape-lifted');drag.node.closest('.graph-row')?.classList.add('tape-editing');}
  drag.node.style.translate=dx+'px '+dy+'px';drag.node.style.zIndex='30';
  const n=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-node-role],.reserve-drop');
  const same=n&&(n.dataset.nodeRole||n.dataset.edit)===drag.role&&n.dataset.group===drag.group;
  const target=n&&n!==drag.node&&(same||drag.group!=='alternatives'&&n.dataset.group!=='alternatives')?n:null;
  if(target!==drag.target){drag.target?.classList.remove('drag-over');drag.target=target;target?.classList.add('drag-over');}
 });
 root.addEventListener('pointerup',e=>{
  if(!drag||e.pointerId!==drag.pointer)return;const d=endClipDrag();if(!d.active)return;
  e.preventDefault();suppressClipClick=true;
  let focus={role:d.role,group:d.group,index:d.index};
  if(d.target){
   const role=d.target.dataset.nodeRole||d.target.dataset.edit,group=d.target.dataset.group,index=Number(d.target.dataset.index),same=role===d.role&&group===d.group;
   const sourceList=chain(d.role,d.group),route=sourceList[d.index];
   if(group==='pool'&&!ManaOperator.isFreeModel(catalogMap.get(split(route).raw)||{})){notify('До пулу можна додати лише підтверджений FREE CUT.');return;}
   if(!same&&routeWarning(split(route).raw)){notify('Цей маршрут зараз недоступний.');return;}
   const list=ManaOperator.transferCut(sourceList,chain(role,group),d.index,index,same),limit=group==='alternatives'?12:group==='vibe'||group==='pool'?30:31;
   if(list.length>limit){notify('Доріжка вже має максимальну кількість CUTS.');return;}
   setChain(role,list,group);focus={role,group,index:list.indexOf(route)};
   if(!same)state.opFeedback='Скопійовано CUT → '+role+' · thinking збережено';
  }
  render();pickerFocus(focus);
 });
 root.addEventListener('pointercancel',()=>{if(endClipDrag())render();});
 root.addEventListener('lostpointercapture',()=>{if(endClipDrag())render();});
 root.addEventListener('keydown',e=>{if(e.key==='Escape'&&drag?.active){e.preventDefault();suppressClipClick=true;endClipDrag();render();}},true);
 root.addEventListener('click',e=>{if(suppressClipClick){e.preventDefault();e.stopImmediatePropagation();suppressClipClick=false;}},true);


 function diff(name){
  if(renderCache?.diffs.has(name))return renderCache.diffs.get(name);
  const a=original[name],b=profiles[name],out=[];
  for(const path of [...Object.keys(profiles[name].modelRoles).map(r=>['modelRoles',r]),...Object.keys(profiles[name].modelRoles).map(r=>['retry','fallbackChains',r]),...workers(profiles[name]).map(r=>['task','agentModelOverrides',r]),['disabledProviders'],['forgeMode'],['forgeRefresh']]){
   const get=o=>path.reduce((v,k)=>v?.[k],o),v=get(b);
   if(JSON.stringify(get(a))!==JSON.stringify(v))out.push({path,value:v});
  }
  renderCache?.diffs.set(name,out);return out;
 }
 async function api(path,body){
  const writes=path!=='/api/profile-preview';if(writes){writeEpoch++;activeWrites++;}
  try{const r=await fetch(endpoint(path),{method:'POST',headers:{'Content-Type':'application/json','X-Forge-CSRF':source.csrf},body:JSON.stringify(body)});const d=await r.json();if(!r.ok){const e=Error(d.error||'Не вдалося виконати дію');e.status=r.status;throw e;}return d;}
  finally{if(writes){writeEpoch++;activeWrites--;scheduleBackgroundWork();}}
 }
 function interactionBusy(preview=false){
  const focused=document.activeElement,select=focused?.matches('select'),selectOpen=select&&(CSS.supports('selector(select:open)')?focused.matches(':open'):nativeSelectBusy);
  return document.hidden||composing||pointerHeld||activeWrites||document.documentElement.dataset.displayTuning||document.documentElement.dataset.lightMotion||state.modal||state.picker&&(!preview||!state.picker.actionsOnly)||state.saving||state.profileBusy||state.providerSaving||drag||cutGesture||drawerGesture||focused?.matches('input,textarea')||select&&(!preview||selectOpen)||win.querySelector('.profile-menu[open]');
 }
 function scheduleBackgroundWork(){clearTimeout(backgroundTimer);backgroundTimer=setTimeout(flushBackgroundWork,0);}
 function flushBackgroundWork(){
  if(!interactionBusy(true)){
   for(const [name,result] of pendingModeResults){if(state.modePlans[name]?.key===result.key){state.modePlans[name]=result;if(state.profile===name)pendingRender=true;}pendingModeResults.delete(name);}
   if(pendingRender){pendingRender=false;render();}
  }
  if(backgroundRefreshPending&&!backgroundReloading&&!interactionBusy()){backgroundRefreshPending=false;pollState();}
  if(backgroundRefreshPending||pendingRender||pendingModeResults.size){clearTimeout(backgroundTimer);backgroundTimer=setTimeout(flushBackgroundWork,200);}
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
 function timeLabel(seconds){return seconds?new Date(seconds*1000).toLocaleString('uk-UA',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'ще немає даних';}
 function num(n){return Number.isFinite(n)?new Intl.NumberFormat('uk-UA',{notation:n>=100000?'compact':'standard',maximumFractionDigits:1}).format(n):'—';}
 function modelStatus(m){return m.status==='missing'?'Зникла':m.newAt?'Нова':m.available?'В OMP':m.source==='config'?'Вручну':'Кеш';}
 function routeWarning(raw){const m=catalogMap.get(raw),pid=split(raw).provider;return m?.status==='missing'||source.providers.find(p=>p.id===pid)?.expired||(p().disabledProviders||[]).includes(pid);}
 function rebuild(){
  referenced.clear();for(const pr of Object.values(profiles)){for(const r of [...Object.values(pr.modelRoles),...Object.values(pr.retry?.fallbackChains||{}).flat(),...Object.values(pr.task?.agentModelOverrides||{}).flat(),...(pr.forgeMode?.alternatives||[]),...Object.values(pr.forgeMode?.overrides||{}).flat()])if(typeof r==='string'&&r.includes('/'))referenced.add(split(r).raw);}
  referencedProviders.splice(0,referencedProviders.length,...new Set([...referenced].filter(r=>!poolName(r)).map(r=>split(r).provider)));
  catalogMap.clear();for(const m of source.models)catalogMap.set(m.provider+'/'+m.id,m);
  for(const r of referenced)if(!poolName(r)&&!catalogMap.has(r)){const m=split(r);catalogMap.set(r,{...m,name:m.id,source:'reference'});}
  catalog.splice(0,catalog.length,...[...catalogMap.values()].sort((a,b)=>a.provider.localeCompare(b.provider)||a.name.localeCompare(b.name)));
 }
 async function reload(discard=false,rebasePools=false,background=false){
  if(background&&backgroundReloading)return;const epoch=writeEpoch;if(background)backgroundReloading=true;
  try{
  const r=await fetch(endpoint('/api/state'));if(!r.ok)throw Error('Немає зв’язку із сервером');const fresh=await r.json();
  if(background&&(interactionBusy()||epoch!==writeEpoch)){backgroundRefreshPending=true;scheduleBackgroundWork();return;}
  fresh.base=normalizeProfile(fresh.base);
  const freshnessChanged=(fresh.insights?.usage?.reports||[]).some(report=>!report.stale&&report.at&&((Date.now()/1000-report.at>900)!==(renderedAt/1000-report.at>900)));
  if(background&&!state.offline&&!freshnessChanged&&snapshotFingerprint(fresh)===snapshotFingerprint(source)){source.tariff=fresh.tariff;return;}
  const next={standard:copy(fresh.base),...Object.fromEntries(Object.entries(fresh.presets).map(([k,v])=>[k,merge(fresh.base,v)]))};
  for(const [k,v] of Object.entries(next))v.forgeMode=copy(fresh.profileModes?.[k]?.settings||{mode:'deepseek',alternatives:[],overrides:{}});
  for(const k of Object.keys(profiles))if(!next[k]&&(discard||!diff(k).length)){delete profiles[k];delete original[k];}
  for(const [k,v]of Object.entries(next)){if(!discard&&profiles[k]&&diff(k).length){if(!rebasePools||JSON.stringify(v)!==JSON.stringify(original[k]))fresh.revisions[k]=source.revisions[k];continue;}profiles[k]=copy(v);original[k]=copy(v);}
  if(discard||!poolsDirty()){poolOriginal=copy(fresh.freePools);poolDraft=copy(poolOriginal);poolRevision=fresh.poolsRevision;}
  source=fresh;profileKeys.splice(0,profileKeys.length,...Object.keys(profiles));roleKeys.splice(0,roleKeys.length,...Object.keys(fresh.base.modelRoles||{}));
  if(!profiles[state.profile])state.profile='standard';state.favs=fresh.favs||[];rebuild();state.offline=false;render();
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
   original[name]=saved;state.opFeedback='Профіль збережено для нових запусків OMP.';delete profiles[name].forgeRefresh;delete original[name].forgeRefresh;delete state.modePlans[name];editHistory.reset(name,original[name]);
   await reload();notify('Збережено · '+(saved.forgeMode.mode==='no-deepseek'?'Без DeepSeek':'З DeepSeek'));
  }catch(e){if(e.status===409){state.modal='conflict';state.error=e.message;}else state.error=e.message;render();}
  finally{state.saving=false;render();}
 }
 function setChain(role,list,group='role'){
  if(state.saving)return;
  if(group!=='pool')state.poolPanel=false;
  if(group==='pool'){if(list.length>30||list.some(r=>!ManaOperator.isFreeModel(catalogMap.get(split(r).raw)||{}))){notify('У пулі може бути до 30 підтверджених FREE CUTS.');return;}poolDraft[role]=[...new Map(list.map(v=>[split(v).raw,v])).values()];return;}
  if(group==='alternatives'){const s=modeSettings(),routes=[...new Map(list.map(v=>[split(v).raw,v])).values()];if(role==='profile')s.alternatives=routes;else s.overrides[role]=routes;return;}
  const view=modeView(role,group);
  if(view?.substituted){modeSettings().overrides[modeScope(role,group)]=[...new Map(list.map(v=>[split(v).raw,v])).values()];return;}
  const replacementAt=view?.refs.findIndex(ref=>ref.kind==='replacement')??-1;
  if(replacementAt>0){
   // Retain the original DeepSeek positions; only this mode owns the tail after them.
   const normal=baseChain(role,group);
   for(let i=0;i<replacementAt;i++)normal[view.refs[i].index]=list[i];
   if(JSON.stringify(normal)!==JSON.stringify(baseChain(role,group)))oldSetChain(role,normal,group);
   modeSettings().overrides[modeScope(role,group)]=[...new Map(list.slice(replacementAt).map(v=>[split(v).raw,v])).values()];return;
  }
  if(view){
   const normal=baseChain(role,group),visible=copy(list);
   // Fill only visible original positions; paused DeepSeek slots keep their identity.
   for(const ref of view.refs){if(ref.kind==='base')normal[ref.index]=visible.shift();}
   list=[...normal.filter(v=>v!==undefined),...visible];
  }
  oldSetChain(role,list,group);
  if(group==='role'&&state.syncVibe){for(const worker of workers())if(!agentLink(worker)&&vibeAlias(worker)==='@'+role)p().task.agentModelOverrides[worker]=['@'+role,...list.slice(1)];}
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
  if(state.modal==='provider'){const v=state.editProvider?source.providers.find(x=>x.id===state.editProvider):null;title=v?'Редагувати провайдера':'Новий провайдер';body=`<form id="new-provider" autocomplete="off"><div class="form-grid"><label class="field">Назва<input name="name" required maxlength="80" value="${esc(v?.name||'')}" placeholder="Мій провайдер"></label><label class="field">ID<input name="id" required pattern="[a-z0-9][a-z0-9_-]{0,63}" value="${esc(v?.id||'')}" ${v?'readonly':''} placeholder="my-provider"></label></div><label class="field">Адреса API<input type="url" name="url" required value="${esc(v?.url||'')}" placeholder="https://api.example.com/v1"></label><div class="form-grid"><label class="field">Формат API<select name="api">${[['openai-completions','OpenAI Chat'],['openai-responses','OpenAI Responses'],['anthropic-messages','Anthropic']].map(([k,l])=>`<option value="${k}" ${v?.api===k?'selected':''}>${l}</option>`).join('')}</select></label><label class="field">Авторизація<select name="auth"><option value="apiKey">API-ключ</option><option value="none" ${v?.auth==='none'?'selected':''}>Без ключа</option></select></label></div><label class="field">API-ключ ${v?.hasKey?'· залиш порожнім, щоб зберегти':''}<input type="password" name="key" autocomplete="new-password" placeholder="${v?.hasKey?'Збережений на сервері':'Ключ провайдера'}"></label><label class="field">Список моделей<select name="discovery">${[['openai-models-list','Отримувати через /models'],['','Ввести вручну'],['ollama','Ollama'],['llama.cpp','llama.cpp'],['lm-studio','LM Studio'],['litellm','LiteLLM']].map(([k,l])=>`<option value="${k}" ${(v?v.discovery:'openai-models-list')===k?'selected':''}>${l}</option>`).join('')}</select></label><label class="field">Додаткові ID моделей · по одному на рядок<textarea name="models" rows="3" placeholder="model-id">${esc(v?.manualModels?.join('\n')||'')}</textarea></label><label class="field">Термін дії<select name="days">${v?.expires&&!v.expired?'<option value="-1" selected>Зберегти поточний термін</option>':''}<option value="0">Без обмеження</option><option value="1">24 години</option><option value="7">7 днів</option><option value="30">30 днів</option></select></label><p class="view-note">Після терміну невикористовуване підключення видаляється. Якщо воно ще є у профілях, панель позначить його простроченим і запропонує замінити моделі. Активні сесії не змінюються.</p><div class="modal-actions">${v?tool('Видалити','delete-provider','danger'):''}${tool(state.providerSaving?'Збереження…':'Зберегти провайдера','provider-create','primary',state.providerSaving?'disabled':'')}</div></form>`;}
  if(state.modal==='details'){title='Дані моделі';body=detailsMarkup();}
  if(state.modal==='conflict'){title='Змінились вихідні дані';body=`<p>${esc(state.error||'Конфігурацію змінено зовні.')}</p><p class="view-note">Твоя чернетка лишилась у вікні. Експортуй її перед завантаженням актуального профілю.</p><div class="modal-actions">${tool('Експорт чернеток','export-draft')}${tool('Скинути чернетки й оновити','discard-reload','primary')}</div>`;}
  if(state.modal==='history'){title=prettyProfile(state.profile);body=`<p>Збереження створює резервну копію. Відновлення поверне попередні налаштування та режим цього профілю.</p><div class="modal-actions">${tool('Відновити попередню','restore-profile','',source.restorable.includes(state.profile)?'':'disabled')}</div>`;}
  if(state.modal==='rename'){title='Перейменувати профіль';body=`<form id="rename-form"><label class="field">Назва профілю<input name="name" required maxlength="64" aria-describedby="profile-name-hint" value="${esc(state.renameName??state.profile)}" autocomplete="off" spellcheck="false"></label><p id="profile-name-hint" class="view-note profile-name-hint" aria-live="polite">${esc(profileNameHint(state.renameName??state.profile,true))}</p><p class="view-note">Налаштування та чернетка збережуться.</p><div class="modal-actions">${tool('Скасувати','modal-close')}${tool(state.profileBusy?'Збереження…':'Перейменувати','rename-confirm','primary',state.profileBusy?'disabled':'')}</div></form>`;}
  if(state.modal==='delete-profile'){title='Видалити '+prettyProfile(state.profile)+'?';body=`<p>Профіль зникне зі списку та стане недоступним для нових запусків OMP. Збережена версія залишиться в резервній копії.</p>${diff(state.profile).length?'<p class="view-note">Незбережену чернетку цього профілю також буде видалено.</p>':''}<div class="modal-actions">${tool('Скасувати','modal-close')}${tool(state.profileBusy?'Видалення…':'Видалити профіль','delete-confirm','danger',state.profileBusy?'disabled':'')}</div>`;}
  if(state.modal==='clone'){title='Копія профілю';body=`<form id="clone-form"><label class="field">Назва нового профілю<input name="name" required maxlength="64" aria-describedby="profile-name-hint" value="${esc(state.cloneName||'')}" placeholder="Standard FreeTier" autocomplete="off" spellcheck="false"></label><p id="profile-name-hint" class="view-note profile-name-hint" aria-live="polite">${esc(profileNameHint(state.cloneName||''))}</p><p class="view-note">Копіюється збережена конфігурація ${esc(prettyProfile(state.profile))}. Спочатку збережи чернетку, якщо вона потрібна в копії.</p>${tool('Створити','clone-create','primary')}</form>`;}
  return `<div class="modal-layer"><section class="modal ${state.modal==='details'?'model-detail':''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-top"><h2>${esc(title)}</h2>${tool(icon('x'),'modal-close','icon-only','aria-label="Закрити"')}</div>${state.modalError?`<p class="error-banner" role="alert">${esc(state.modalError)}</p>`:''}${body}</section></div>`;
 }
 async function saveProvider(){const f=win.querySelector('#new-provider');if(!f.reportValidity()||state.providerSaving)return;const d=new FormData(f);state.providerSaving=true;const body={id:d.get('id'),name:d.get('name'),url:d.get('url'),api:d.get('api'),auth:d.get('auth'),key:d.get('key'),discovery:d.get('discovery'),models:String(d.get('models')).split('\n').map(s=>s.trim()).filter(Boolean),days:Number(d.get('days')),revision:source.providerRevision};const b=f.querySelector('[data-action=provider-create]');b.disabled=true;b.textContent='Збереження…';try{await api('/api/provider',body);state.modal=null;state.modalError='';await reload();notify('Провайдер збережений. Каталог оновлюється.');}catch(e){let error=f.querySelector('.form-error');if(!error){error=document.createElement('p');error.className='error-banner form-error';error.setAttribute('role','alert');f.prepend(error);}error.textContent=e.message;b.disabled=false;b.textContent='Зберегти провайдера';}finally{state.providerSaving=false;}}
 // OPERATOR — one control plane, three working surfaces.
 const op=ManaOperator;
 const healthNames={local:'Локально',healthy:'Є запас',risk:'Малий запас',empty:'Вичерпано',unknown:'Немає виміру'};
 const healthGlyph={local:'◈',healthy:'●',risk:'△',empty:'∅',unknown:'?'};
 let cutGesture=null;
 let opReportCache=null;
 function opHealth(model){return op.health({...model,free:priceInfo(model).kind==='free',expired:source.providers.find(v=>v.id===model.provider)?.expired},opReportCache||usageReports(),p().disabledProviders||[]);}
 function opRouteHealth(route){const m=split(route);return opHealth(catalogMap.get(m.raw)||m);}
 function opSwitch(key,label,on,caption=''){return `<button type="button" class="physical-switch ${on?'engaged':''}" data-op-switch="${key}" ${key==='cuts'?`aria-expanded="${on}" aria-controls="cuts-collection"`:`aria-pressed="${on}"`} title="${esc(caption||label)}"><span class="switch-cap"><i></i></span><span>${label}</span></button>`;}
 function opSelect(id,label,value,items){const index=Math.max(0,items.findIndex(x=>x[0]===value));return `<div class="op-selector"><span class="selector-rocker" role="group" aria-label="Крок вибору: ${esc(label)}"><button type="button" data-select-step="${id}" data-direction="-1" aria-label="${esc(label)}: попереднє" ${index===0?'disabled':''}>−</button><button type="button" data-select-step="${id}" data-direction="1" aria-label="${esc(label)}: наступне" ${index>=items.length-1?'disabled':''}>+</button></span><label class="selector-content" for="${id}"><small>${esc(label)}</small><select id="${id}" aria-label="${esc(label)}">${items.map(([k,t])=>`<option value="${esc(k)}" ${k===value?'selected':''}>${esc(t)}</option>`).join('')}</select></label></div>`;}

 function opPaceText(q){if(!q.kind||q.kind==='unknown')return q.label;if(q.kind==='empty')return 'Вичерпано';return (q.kind==='reserve'?'Запас':q.label)+(q.delta!=null&&q.kind!=='balanced'?' '+Math.round(Math.abs(q.delta))+'%':'');}
 function opForecast(q){return q.kind==='unknown'?'Без прогнозу':q.kind==='empty'?'До скидання':q.lasts?'≈ до скидання':q.eta>Date.now()?'≈ ще '+resetCountdown(q.eta).replace('↻ ',''):'≈ запас міг скінчитись';}
 function microDuration(at){const minutes=Math.max(1,Math.round((at-Date.now())/60000));return minutes>=1440?Math.floor(minutes/1440)+'д':minutes>=60?Math.floor(minutes/60)+'г':minutes+'хв';}
 function reportAge(r){if(!r.at)return 'Немає виміру';const minutes=Math.max(0,Math.floor((Date.now()/1000-r.at)/60));return minutes<1?'щойно':minutes<60?minutes+' хв тому':Math.floor(minutes/60)+' г тому';}
 function opQuota(){
  const reports=usageReports(),accounts=new Map();
  return `<section class="meter-bridge micro" aria-label="Підписки: залишки, скидання та темп"><div class="meter-channels">${reports.map(r=>{
   const account=(accounts.get(r.provider)||0)+1;accounts.set(r.provider,account);
   const name=providerName(r.provider),multiple=reports.filter(x=>x.provider===r.provider).length>1,screen='quota:'+r.provider+':'+account;
   return `<section class="meter-channel ${r.limits.length>3?'family-channel':''}" data-meter-provider="${esc(r.provider)}" data-lcd-screen="${esc(screen)}" style="--window-count:${Math.max(1,r.limits.length)}"><header><strong title="${esc(name)}">${esc(name)}</strong><span class="meter-age" title="${esc(timeLabel(r.at))}">${reportAge(r)}${multiple?' #'+account:''}</span>${ManaDisplay.colourControl(screen,name+(multiple?' #'+account:''))}</header><div class="meter-windows">${r.limits.map(l=>{const q=op.pace(l,r),left=l.remaining,label=limitLabel(l);return `<div class="meter-window ${q.kind}" title="${esc(label+' · '+opPaceText(q)+' · '+opForecast(q)+' · '+resetTitle(l.resets)+(q.estimated?' · Лінійна оцінка за тривалістю вікна':''))}"><span class="mw-label">${esc(label)}</span><span class="mw-meter" ${left!=null?`role="meter" aria-label="${esc(name+' '+label+' залишок')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${left}"`:''}><i style="width:${left??0}%"></i>${q.expected!=null?`<b style="left:${100-q.expected}%"></b>`:''}</span><strong>${left==null?'—':num(left)+'%'}</strong><span class="mw-reset" data-reset="${Number(l.resets)||0}">${resetCountdown(l.resets)}</span><span class="mw-pace">${esc(q.kind==='unknown'?'?':q.kind==='empty'?'∅':(q.delta>2?'−':q.delta< -2?'+':'±')+Math.round(Math.abs(q.delta||0))+'%')}</span><span class="mw-forecast">${esc(q.kind==='unknown'?'':q.kind==='empty'?'∅':q.lasts?'до ↻':q.eta>Date.now()?'≈'+microDuration(q.eta):'≈вич.')}</span></div>`;}).join('')||'<p class="meter-empty">Ще немає вимірів</p>'}</div></section>`;
  }).join('')}</div><div class="bridge-caption"><span>+ запас / − перевитрата · % від повного ліміту · ≈ прогноз · ↻ скидання</span><span>Anthropic / Google / OpenAI — окремі сімейства Antigravity.</span></div></section>`;
 }
 function operatorDock(){
  return `<section class="operator-dock" aria-label="Пульт керування"><div class="dock-selection"><label class="project-control dock-selector"><small>ПРОЄКТ</small><select id="project-choice" aria-label="Проєкт" ${state.saving?'disabled':''}>${(source.projects||[]).map(x=>`<option value="${esc(x.id)}" ${x.id===source.projectId?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label><div class="dock-profile"><label class="dock-selector"><small>ПРОФІЛЬ / КОТУШКА</small><select id="profile-choice" class="profile-select" aria-label="Профіль">${profileOptions()}</select></label><details class="profile-menu"><summary aria-label="Дії з профілем">⋯</summary><div class="profile-menu-panel">${tool('+ Копія','clone-profile')}${tool('Перейменувати','rename-profile','',state.profile==='standard'?'disabled':'')}${tool('Попереднє збереження','history')}${tool('Скинути чернетку','reset-draft','',!state.changes?'disabled':'')}${tool('Видалити','delete-profile','danger',state.profile==='standard'?'disabled':'')}</div></details></div></div><div class="dock-switches">${opSwitch('health','HEALTH',state.health,'Стан лімітів на плівці')}${opSwitch('cuts','CUTS',state.cuts,'Висунути колекцію CUTS')}</div>${state.view==='profiles'?'':`<div class="dock-context">${state.view==='models'?`<span class="surface-number">02</span><span><b>Колекція · аналітика</b><small>CUTS / провайдери / тести / ціни</small></span>`:`<span class="surface-number">03</span><span><b>Історія роботи</b><small>Виміри OMP · усі проєкти OMP</small></span>`}</div>`}${profileActions()}</section><div class="operator-feedback" role="status">${esc(state.view==='profiles'?(state.opFeedback||''):'')}</div>`;
 }
 function opRecords(m){return modelRecords(m).filter(b=>evidence.kind(b)==='benchmark'&&b.source===state.benchSource);}
 function opEvidence(m){
  const weights=(state.benchSource==='Artificial Analysis'?source.insights?.benchmarks?.weightsAA:source.insights?.benchmarks?.weights)?.[state.role];
  const rows=opRecords(m).filter(b=>!state.benchRelease||b.release===state.benchRelease),q=op.evidence(rows,weights);
  return q?{...q,weights}:null;
 }
 function opProviderItems(all=false){return [['all','Усі'],...source.providers.filter(v=>all||((v.connected||v.used.length)&&!(p().disabledProviders||[]).includes(v.id)&&!v.expired)).map(v=>[v.id,providerName(v.id)]).sort((a,b)=>a[1].localeCompare(b[1]))];}
 function analyticalProviders(){const ids=state.catalogMode==='mine'?myProviderIds():state.catalogMode==='free'?new Set(catalog.filter(m=>priceInfo(m).kind==='free').map(m=>m.provider)):null;return opProviderItems(true).filter(([id])=>id==='all'||!ids||ids.has(id));}
 function collectionModels(){return catalog.filter(m=>(m.available||source.providers.find(v=>v.id===m.provider)?.connected)&&!routeWarning(m.provider+'/'+m.id)&&(state.cutProvider==='all'||m.provider===state.cutProvider)&&(!state.freeCuts||priceInfo(m).kind==='free')&&(state.cutHealth==='all'||opHealth(m).kind===state.cutHealth)&&matchesQuery(state.cutQuery,m.name,m.id,providerName(m.provider)));}
 function collectionCuts(){return collectionModels().sort((a,b)=>a.name.localeCompare(b.name)||providerName(a.provider).localeCompare(providerName(b.provider))||a.id.localeCompare(b.id));}
 function cutsTray(){
  if(!state.cuts)return '';
  const cuts=collectionCuts(),shown=cuts.slice(0,state.cutLimit||60),target=state.cutTarget;
  return `<section id="cuts-collection" class="cuts-drawer ${win.querySelector('.cuts-drawer')?'':'entering'}" aria-label="Колекція CUTS"><div class="drawer-grip" id="cuts-resize" role="separator" tabindex="0" aria-orientation="horizontal" aria-controls="cuts-collection" aria-label="Висота колекції CUTS" title="Тягни вгору або вниз, щоб змінити висоту · ↑ / ↓"></div><div class="drawer-head"><div><b>КОЛЕКЦІЯ CUTS</b><small>${target?'Місце: '+target.role+' · '+(target.index===0?'основна':'резерв '+target.index):(win.clientWidth<=700?'Обери CUT → торкнись місця на доріжці':'Перетягни CUT на доріжку або вибери CUT і місце')}</small></div>${tool('×','cuts-close','icon-only','aria-label="Закрити колекцію"')}</div><div class="drawer-controls">${opSelect('cut-provider','Провайдер',state.cutProvider,opProviderItems())}${opSwitch('free','FREE CUTS',state.freeCuts)}${opSelect('cut-health','Запас',state.cutHealth,[['all','Будь-який'],...Object.entries(healthNames)])}<label class="search"><input id="cut-query" aria-label="Пошук у колекції" placeholder="Знайти CUT…" value="${esc(state.cutQuery)}"></label><span class="drawer-count">${cuts.length} CUTS</span></div><div class="drawer-results" data-filter-key="${esc(JSON.stringify([state.cutProvider,state.cutHealth,state.freeCuts,state.cutQuery]))}"><div class="cut-bin">${shown.map(m=>{const route=m.provider+'/'+m.id;return `<button type="button" class="collection-cut cut-surface ${state.armedCut===route?'armed':''}" data-cut="${esc(route)}" data-health-route="${esc(route)}" aria-label="${esc(cutTitle(route)+' · '+route)}" title="${esc(route)}"><span class="cut-hole" aria-hidden="true"></span><strong class="cut-title">${esc(cutTitle(route))}</strong><small class="cut-meta">${cutIdentity(route)}</small></button>`;}).join('')||'<p class="empty-state">Немає CUTS за цими фільтрами.</p>'}</div>${cuts.length>shown.length?tool('Ще '+Math.min(60,cuts.length-shown.length),'cuts-more'):''}</div></section>`;
 }
 let drawerGesture=null;
 function resizeDrawer(height){
  const drawer=win.querySelector('.cuts-drawer'),grip=win.querySelector('#cuts-resize');if(!drawer||!grip)return;
  const max=Math.max(160,window.innerHeight-parseFloat(getComputedStyle(drawer).bottom)-48);
  const min=Math.min(max,Math.ceil(drawer.querySelector('.drawer-head').offsetHeight+drawer.querySelector('.drawer-controls').offsetHeight+120));
  height=Math.round(Math.max(min,Math.min(max,Number.isFinite(height)?height:drawer.getBoundingClientRect().height)));
  state.drawerHeight=height;root.style.setProperty('--cuts-height',height+'px');
  grip.setAttribute('aria-valuemin',min);grip.setAttribute('aria-valuemax',max);grip.setAttribute('aria-valuenow',height);grip.setAttribute('aria-valuetext',height+' пікселів');
 }
 function finishDrawerResize(cancel=false){
  const g=drawerGesture;if(!g)return;drawerGesture=null;
  if(cancel)resizeDrawer(g.height);else storeOperator();
  if(root.hasPointerCapture(g.pointer))root.releasePointerCapture(g.pointer);render();
 }
 root.addEventListener('pointerdown',e=>{
  const grip=e.target.closest('#cuts-resize');if(!grip||e.button!==0)return;
  e.preventDefault();grip.focus({preventScroll:true});drawerGesture={pointer:e.pointerId,y:e.clientY,height:state.drawerHeight};root.setPointerCapture(e.pointerId);
 });
 root.addEventListener('pointermove',e=>{const g=drawerGesture;if(g?.pointer!==e.pointerId)return;e.preventDefault();resizeDrawer(g.height+g.y-e.clientY);});
 root.addEventListener('pointerup',e=>{if(drawerGesture?.pointer===e.pointerId)finishDrawerResize();});
 root.addEventListener('pointercancel',()=>finishDrawerResize(true));
 root.addEventListener('lostpointercapture',()=>finishDrawerResize(true));
 window.addEventListener('blur',()=>finishDrawerResize(true));
 root.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&drawerGesture){e.preventDefault();finishDrawerResize(true);return;}
  if(e.target.id!=='cuts-resize'||!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;
  e.preventDefault();resizeDrawer(e.key==='Home'?0:e.key==='End'?window.innerHeight:state.drawerHeight+(e.key==='ArrowUp'?32:-32));storeOperator();
 });
 function placeCut(route,target){if(!poolName(route)&&!collectionModels().some(m=>m.provider+'/'+m.id===route))return;commitCut(route,{...target,profile:state.profile,expected:chain(target.role,target.group||'role')[target.index]??null});}
 function commitCut(route,target){
  if(state.saving)return;if(poolName(route)&&!source.freePools?.[poolName(route)]?.length){notify('Спочатку наповни й збережи цей пул.');return;}if(modeOff()&&activePlan()?.pending){notify('Ще розраховується режим. Спробуй за мить.');return;}if(target.profile!==state.profile||(chain(target.role,target.group||'role')[target.index]??null)!==target.expected){state.cutTarget=null;state.armedCut=null;notify('Доріжка змінилася. Обери місце ще раз.');return;}if(modeOff()&&deepseek(route)){notify('Для платного DeepSeek увімкни режим «Із DeepSeek».');return;}if(!poolName(route)&&routeWarning(route)){notify('Цей маршрут зараз недоступний. Обери CUT іншого провайдера.');return;}const {role,index,group='role'}=target,list=chain(role,group),old=list[index]?split(list[index]):null,m=catalogMap.get(route);
  const effort=old?.effort&&m?.thinking?.includes(old.effort)?':'+old.effort:'';const existing=list.findIndex(r=>split(r).raw===route);if(existing>=0){const [cut]=list.splice(existing,1);list.splice(Math.min(index,list.length),0,cut);}else{list[index]=route+effort;}if(list.length>(group==='pool'||group==='vibe'?30:group==='alternatives'?12:31)){notify('Доріжка вже має максимальну кількість CUTS.');return;}setChain(role,list,group);state.cutTarget=null;state.armedCut=null;if(narrowSurface())state.cuts=false;state.opFeedback='Вставлено '+short(split(route).id)+' · '+providerName(split(route).provider)+' → '+role;render();if(narrowSurface()){pickerFocus({role,index,group});scrollToControl(document.activeElement);}
 }
 function contextTokens(n){return n>=1e6?num(n/1e6)+'M':num(n/1e3)+'K';}
 function opPriceValue(m){const q=priceInfo(m);return q.kind==='free'?0:Number.isFinite(m.cost?.input)&&Number.isFinite(m.cost?.output)&&(m.cost.input||m.cost.output)?(m.cost.input+m.cost.output)/2:null;}
 function analyticalModels(){
  const mine=myProviderIds();let rows=catalog.filter(m=>(state.catalogMode!=='mine'||mine.has(m.provider))&&(state.catalogProvider==='all'||m.provider===state.catalogProvider)&&matchesQuery(state.catalogQuery,m.name,m.id,providerName(m.provider))&&(state.catalogMode!=='free'||priceInfo(m).kind==='free')&&(state.catalogMode!=='used'||referenced.has(m.provider+'/'+m.id))&&(state.catalogMode!=='fav'||state.favs.includes(m.provider+'/'+m.id))&&(state.catalogMode!=='changes'||source.changes.some(x=>x.route===m.provider+'/'+m.id)));
  rows=rows.filter(m=>!state.catalogEvidence||state.catalogEvidence==='all'||evidenceCoverage(m).kind===state.catalogEvidence);
  const score=m=>opEvidence(m)?.score??-1,cost=m=>opPriceValue(m)??Infinity,value=m=>score(m)>=0&&cost(m)>0&&cost(m)<Infinity?score(m)/cost(m):-Infinity;
  return rows.sort(state.catalogSort==='evidence'?(a,b)=>{const x=evidenceCoverage(a),y=evidenceCoverage(b);return y.sources.length-x.sources.length||y.claims-x.claims||a.name.localeCompare(b.name);}:state.catalogSort==='price'?(a,b)=>cost(a)-cost(b)||score(b)-score(a):state.catalogSort==='value'?(a,b)=>value(b)-value(a)||score(b)-score(a):state.catalogSort==='name'?(a,b)=>a.name.localeCompare(b.name):(a,b)=>score(b)-score(a)||cost(a)-cost(b));
 }
 function analyzerPlot(rows){
  const rated=rows.map(m=>({m,q:opEvidence(m),cost:opPriceValue(m)})).filter(x=>x.q&&x.cost!==null),paid=rated.filter(x=>x.cost>0),minCost=Math.min(.1,...paid.map(x=>x.cost)),maxCost=Math.max(10,...paid.map(x=>x.cost)),selected=state.analyze||rows[0]?.provider+'/'+rows[0]?.id;
  const xpos=cost=>cost===0?5:17+Math.log(cost/minCost)/Math.log(maxCost/minCost)*79;
  const ticks=[...new Set([minCost,...[.01,.1,1,10,100].filter(n=>n>minCost&&n<maxCost),maxCost])];
  return `<section class="analysis-screen" data-lcd-screen="analysis"><header><b>ЦІНА × ТЕСТИ</b><span>${esc(state.benchSource)} · ${esc(state.benchRelease)}</span>${ManaDisplay.colourControl('analysis','Ціна × тести')}</header><div class="scope-plot" role="group" aria-label="Оцінка ролі та довідкова API ціна"><div class="scope-axis-y">100<span>50</span><span>0</span></div><div class="scope-grid"><div class="free-zone"><span>FREE</span></div>${ticks.map(n=>`<span class="price-tick" style="left:${xpos(n)}%"><i></i><b>$${n<.1?n.toPrecision(1):num(n)}</b></span>`).join('')}${rated.slice(0,180).map(({m,q,cost})=>{const active=m.provider+'/'+m.id===selected;return `<button type="button" class="scope-point ${cost===0?'free':''} ${active?'selected':''}" data-analyze="${esc(m.provider+'/'+m.id)}" style="left:${xpos(cost)}%;bottom:${2+q.score*.94}%" aria-pressed="${active}" aria-label="${esc(cutTitle(m.provider+'/'+m.id)+' · '+providerName(m.provider)+' · оцінка '+num(q.score)+' · $'+num(cost))}" title="${esc(cutTitle(m.provider+'/'+m.id)+' · '+providerName(m.provider)+' · '+num(q.score))}">${active?'<span>'+esc(cutTitle(m.provider+'/'+m.id))+' · '+num(q.score)+'</span>':''}</button>`;}).join('')}${!rated.length?'<span class="scope-empty">Немає зіставних тестів і цін для цього зрізу</span>':''}</div></div><footer><span>Оцінка ролі / 100</span><span>Середнє input / output · $/1M · лог. шкала</span></footer><small>Довідкова ціна API, не рахунок підписки. Free — окрема зона. ${rated.length>180?'На графіку перші 180.':''}</small></section>`;
 }
 function providerFitStrip(rows){
  if(state.catalogProvider!=='all')return '';
  const best=new Map();for(const m of rows){const q=opEvidence(m);if(q&&(!best.has(m.provider)||best.get(m.provider).q.score<q.score))best.set(m.provider,{m,q});}
  return `<p class="role-comparison-label">Найкращі тестовані CUTS провайдерів · ${esc((labels[state.role]||state.role))}</p><div class="provider-fits" aria-label="Найкращі тестовані моделі провайдерів для ролі">${[...best.values()].sort((a,b)=>b.q.score-a.q.score).slice(0,5).map(({m,q})=>`<button type="button" data-catalog-provider="${esc(m.provider)}"><span>${esc(providerName(m.provider))}<b>${num(q.score)}</b></span><small>${esc(cutTitle(m.provider+'/'+m.id))} · ${esc(q.record.effort||'типово')}</small></button>`).join('')}</div>`;
 }

 function analyzerDetail(rows){
  const m=catalogMap.get(state.analyze)||rows[0];if(!m)return '<section class="analysis-inspector"><p>Зміни фільтри, щоб побачити моделі.</p></section>';
  const route=m.provider+'/'+m.id,q=opEvidence(m),h=opHealth(m),editions=catalog.filter(x=>op.normalize(x.id)===op.normalize(m.id));
  return `<section class="analysis-inspector" tabindex="-1"><header><span>CUT / ${esc(providerName(m.provider))}</span><button type="button" class="favorite" data-fav="${esc(route)}" aria-pressed="${state.favs.includes(route)}" aria-label="В обране">☆</button></header><h2>${esc(cutTitle(route))}</h2><p class="analysis-id">${esc(m.id)}</p><div class="inspector-score"><strong>${q?num(q.score):'—'}</strong><span>${esc((labels[state.role]||state.role))}<small>Зважена оцінка тестів / 100</small></span></div>${q?`<div class="test-mini-bars">${Object.entries(q.weights).map(([k,w])=>`<div><span>${esc(k)} <small>${Math.round(w*100)}%</small></span><i><b style="width:${q.record.scores[k]}%"></b></i><strong>${num(q.record.scores[k])}</strong></div>`).join('')}</div><p class="evidence-note">${esc(q.record.id)} · ${esc(q.record.effort||'режим джерела')}<br><a href="${esc(q.record.url)}" target="_blank" rel="noreferrer">${esc(q.record.source)} ↗</a> · ${esc(q.record.release)}. Оцінка — орієнтир для ролі, не тест провайдера.</p>`:'<p class="evidence-note">Для цієї ролі та версії немає повного набору тестів. Окремі виміри показано нижче.</p>'}${capabilityMarkup(m)}${evidenceDeck(m)}<div class="inspector-editions"><small>EDITION · ВХІД / ВИХІД $/1M</small>${editions.slice(0,state.allEditions?editions.length:4).sort((a,b)=>(opPriceValue(a)??Infinity)-(opPriceValue(b)??Infinity)).map(x=>`<button type="button" data-analyze="${esc(x.provider+'/'+x.id)}"><b>${esc(providerName(x.provider))}</b><span>${priceMarkup(x)}</span></button>`).join('')}${editions.length>4?tool(state.allEditions?'Стиснути EDITION':'Усі EDITION · '+editions.length,'all-editions'):''}</div><footer><span class="health-${h.kind}">${healthGlyph[h.kind]} ${h.label}</span><button type="button" class="tool" data-model-detail="${esc(route)}">Всі дані ↗</button></footer></section>`;
 }
 function evidenceSourceLine(m){const c=evidenceCoverage(m);return [...c.sources.map(s=>({'Artificial Analysis':'AA','LiveBench':'LiveBench','LiveCodeBench':'LiveCodeBench','Arena':'Arena'}[s]||s)),...(c.claims?['Заяви розробника']:[])].join(' · ')||'Без зіставлених тестів';}
 function evidenceCoverageLine(rows){const counts={independent:0,developer:0,unknown:0};for(const m of rows)counts[evidenceCoverage(m).kind]++;return `${rows.length} CUTS · незалежні дані: ${counts.independent} · лише заяви: ${counts.developer} · без даних: ${counts.unknown}`;}
 function operatorCatalog(){
  const rows=analyticalModels(),per=12;state.page=Math.max(0,Math.min(state.page,Math.ceil(rows.length/per)-1));const shown=rows.slice(state.page*per,(state.page+1)*per),selected=source.providers.find(v=>v.id===state.catalogProvider);
  const releases=[...new Set((source.insights?.benchmarks?.records||[]).filter(b=>b.source===state.benchSource).map(b=>b.release))].sort().reverse();
  return `<section class="catalog-surface"><div class="surface-controls">${opSelect('catalog-provider','Провайдер',state.catalogProvider,analyticalProviders())}${opSelect('op-role','Роль',state.role,roleKeys.map(r=>[r,(labels[r]||r)]))}${opSelect('op-sort','Порядок',state.catalogSort,[['score','Топ за балом ролі'],['evidence','Покриття тестами'],['price','Нижча ціна'],['value','Тести / API $'],['name','За назвою']])}${opSelect('op-scope','Колекція',state.catalogMode,[['mine','Мої'],['all','Увесь каталог'],['free','FREE CUTS'],['used','У профілях'],['fav','Обрані'],['changes','Нові / зниклі']])}${tool('+ Провайдер','provider-add')}</div><div class="analysis-source-controls"><label class="search"><input id="catalog-query" value="${esc(state.catalogQuery)}" placeholder="CUT або провайдер" aria-label="Пошук CUTS"></label>${opSelect('op-source','Бал ролі',state.benchSource,[['Artificial Analysis','Artificial Analysis'],['LiveBench','LiveBench']])}${opSelect('op-release','Зріз',state.benchRelease,releases.map(r=>[r,r]))}${opSelect('op-evidence','Дані',state.catalogEvidence||'all',[['all','Усі'],['independent','Незалежні'],['developer','Лише заяви'],['unknown','Без даних']])}</div><p class="evidence-coverage">${evidenceCoverageLine(rows)}</p>${selected?`<section class="provider-cartridge"><span class="cartridge-plug" aria-hidden="true">⏚</span><div><strong>${esc(providerName(selected.id))}</strong><small>${selected.count} моделей · ${selected.expired?'Термін минув':selected.connected?'Доступний в OMP':'Доступ не підтверджено'}${selected.expires?' · до '+timeLabel(selected.expires):''}</small></div><label class="check-field"><input type="checkbox" data-provider-toggle="${esc(selected.id)}" ${(p().disabledProviders||[]).includes(selected.id)?'':'checked'}>У профілі</label>${selected.custom||selected.managed?`<button type="button" class="tool" data-edit-provider="${esc(selected.id)}">Підключення</button>`:''}<span>${rows.filter(m=>opEvidence(m)).length} тестованих маршрутів для ${esc(state.role)}</span></section>`:''}${providerFitStrip(rows)}${rows.length?`<div class="catalog-selection"><span>Обрано: <b>${esc(cutTitle(state.analyze||rows[0].provider+'/'+rows[0].id))}</b></span><button type="button" class="tool" data-model-detail="${esc(state.analyze||rows[0].provider+'/'+rows[0].id)}">Дані CUT ↗</button></div>`:''}<div class="analysis-layout"><div class="analysis-main">${analyzerPlot(rows)}<div class="cut-ledger"><header><span>${rows.length} EDITION · ${esc((labels[state.role]||state.role))}</span><span>ТЕСТ / 100</span><span>INPUT / OUTPUT · $/1M</span><span>КОНТЕКСТ</span></header>${shown.map(m=>{const q=opEvidence(m),route=m.provider+'/'+m.id,h=opHealth(m);return `<button type="button" class="ledger-cut ${state.analyze===route?'selected':''}" data-analyze="${esc(route)}" title="${esc(route)}" aria-label="${esc(cutTitle(route)+' · '+route)}"><span><b>${esc(cutTitle(route))}</b><small>${esc(providerName(m.provider))} · ${esc(m.id)} ${m.status==='missing'?' · Зникла':''}</small><small class="ledger-evidence">${evidenceSourceLine(m)}</small></span><span class="ledger-score">${q?num(q.score):'—'}<small>${q?esc(q.record.effort||'типово'):evidenceLabel(m)}</small></span><span>${priceMarkup(m)}</span><span>${m.contextWindow?contextTokens(m.contextWindow):'—'}<small class="health-${h.kind}">${healthGlyph[h.kind]} ${h.label}</small></span></button>`;}).join('')}</div><div class="pagination"><span>${rows.length?state.page*per+1:0}–${Math.min((state.page+1)*per,rows.length)} / ${rows.length}</span><div>${tool('←','prev-page','',state.page===0?'disabled':'')}${tool('→','next-page','',(state.page+1)*per>=rows.length?'disabled':'')}</div></div></div>${analyzerDetail(rows)}</div><p class="evidence-note">Порівняння в одному джерелі й зрізі. У каталозі показано найкращий доступний тестований режим; назва режиму — біля бала. Ціни невідомого типу й безкоштовні маршрути не ранжуються за «тести / $».</p></section>`;
 }
 function historyBins(points){if(!points.length)return [];const start=Math.min(...points.map(x=>x.timestamp)),end=Math.max(...points.map(x=>x.timestamp)),map=new Map(points.map(x=>[x.timestamp,x])),out=[];for(let t=Math.max(start,end-167*3600000);t<=end;t+=3600000)out.push(map.get(t)||{timestamp:t,gap:true});return out;}
 function historySurface(){
  const stats=source.insights?.stats||{},o=stats.overall||{},bins=historyBins(stats.timeSeries||[]),metric=state.historyMetric,labelsM={requests:'Запити',tokens:'Токени',errors:'Помилки',cost:'API $'},index=Math.max(0,Math.min(state.historyIndex??bins.length-1,bins.length-1)),active=bins[index],peak=Math.max(1,...bins.map(b=>b[metric]||0)),models=[...(stats.byModel||[])].sort((a,b)=>(b[state.historySort]||0)-(a[state.historySort]||0)),max=Math.max(1,...models.map(m=>m[state.historySort]||0));
  return `<section class="history-surface"><div class="surface-controls">${opSelect('history-metric','Сигнал',metric,Object.entries(labelsM))}<label class="history-shuttle"><span>ПОЗИЦІЯ <output>${active?new Date(active.timestamp).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'}):'—'}</output></span><input id="history-position" type="range" min="0" max="${Math.max(1,bins.length-1)}" value="${index}" step="1" aria-label="Позиція в історії" ${!bins.length?'disabled':''}></label><span class="history-period">${o.firstTimestamp?timeLabel(o.firstTimestamp/1000)+' — '+timeLabel(o.lastTimestamp/1000):'Ще немає вимірів'}<small>${esc(stats.scope||'OMP')} · оновлено ${timeLabel(stats.at)}</small></span></div><div class="history-lcd" data-lcd-screen="history"><div class="history-counter"><span>${active?timeLabel(active.timestamp/1000):'НЕМАЄ ДАНИХ'}</span><strong>${num(active?.[metric])}</strong><small>${active?.gap?'Немає виміру':labelsM[metric]+' за годину'}</small></div><div class="history-tape" aria-label="Погодинна історія OMP">${bins.map((b,i)=>`<button type="button" data-history-bin="${i}" class="${index===i?'active':''} ${b.gap?'gap':''}" aria-pressed="${index===i}" aria-label="${esc(timeLabel(b.timestamp/1000)+' · '+num(b[metric])+' '+labelsM[metric])}"><i style="height:${b.gap?0:Math.max(1,(b[metric]||0)/peak*100)}%"></i><span>${new Date(b.timestamp).getHours()===0?new Date(b.timestamp).getDate()+'д':new Date(b.timestamp).getHours()}</span></button>`).join('')}</div><div class="history-sample"><span>ЦЯ ГОДИНА</span><span>Запити <b>${num(active?.requests)}</b></span><span>Помилки <b>${num(active?.errors)}</b></span><span>Токени <b>${num(active?.tokens)}</b></span><span>API ≈ $ <b>${num(active?.cost)}</b></span>${ManaDisplay.colourControl('history','Історія роботи')}</div></div><p class="section-engraving history-total-label">УВЕСЬ ПЕРІОД ЗВІТУ</p><div class="transport-counters"><div><span>ЗАПИТІВ</span><b>${num(o.totalRequests)}</b></div><div><span>ПОМИЛКИ</span><b>${num(o.failedRequests)} <small>${o.errorRate!=null?num(o.errorRate*100)+'%':'—'}</small></b></div><div><span>КЕШ</span><b>${o.cacheRate!=null?num(o.cacheRate*100)+'%':'—'}</b></div><div><span>ПЕРШИЙ ТОКЕН</span><b>${o.avgTtft!=null?num(o.avgTtft/1000)+' с':'—'}</b></div><div><span>ШВИДКІСТЬ</span><b>${num(o.avgTokensPerSecond)} <small>ток/с</small></b></div></div><div class="surface-controls"><span class="section-engraving">ВНЕСОК МОДЕЛЕЙ · ВЕСЬ ПЕРІОД</span>${opSelect('history-sort','Вимір',state.historySort,[['totalRequests','Запити'],['totalCost','API оцінка'],['avgTokensPerSecond','Швидкість'],['failedRequests','Помилки']])}</div><div class="mixdown">${models.map(m=>`<div class="mix-channel"><span class="mix-label"><b>${esc(short(m.model))}</b><small>${esc(providerName(m.provider))}</small></span><span class="mix-meter"><i style="width:${(m[state.historySort]||0)/max*100}%"></i></span><strong>${num(m[state.historySort])}</strong><span class="mix-detail">${num(m.failedRequests)} помилок · ${num(m.avgTokensPerSecond)} ток/с · ${m.avgTtft!=null?num(m.avgTtft/1000)+' с':'—'}</span></div>`).join('')||'<p class="empty-state">Статистика ще не зібрана</p>'}</div><p class="evidence-note">${source.demo?'Синтетичні дані DEMO.':'Реальні агрегати OMP, не журнал окремих задач.'} Погодинний вибір змінює верхній вимір; внесок моделей — за весь період. API $ — оцінка за тарифами, не платіж підписки. ${esc(stats.error||'')}</p><div class="catalog-splices"><h3>Зміни колекції</h3>${source.changes.slice(-8).reverse().map(c=>`<div><span>${c.kind==='new'?'+':'−'}</span><b>${esc(cutTitle(c.route))}</b><small>${esc(providerName(split(c.route).provider))} · ${timeLabel(c.at)}</small></div>`).join('')||'<p class="evidence-note">Після першого знімка змін немає.</p>'}</div></section>`;
 }
 root.addEventListener('pointerdown',e=>{
  const cut=e.target.closest('[data-cut],[data-cut-route]');if(cut&&!state.saving&&e.button===0&&e.pointerType!=='touch')cutGesture={node:cut,key:cut.dataset.cut,route:cut.dataset.cutRoute,x:e.clientX,y:e.clientY,pointer:e.pointerId,active:false};
 });
 root.addEventListener('pointermove',e=>{
  const g=cutGesture;if(!g||g.pointer!==e.pointerId||Math.hypot(e.clientX-g.x,e.clientY-g.y)<6&&!g.active)return;e.preventDefault();if(!g.active){g.active=true;root.classList.add('cut-dragging');root.setPointerCapture(e.pointerId);g.ghost=g.node.cloneNode(true);g.ghost.classList.add('cut-ghost');document.body.append(g.ghost);}g.ghost.style.left=e.clientX+12+'px';g.ghost.style.top=e.clientY-18+'px';const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-node-role],.tree-line,[data-edit].add-node,.tree-add [data-edit],[data-action=add-mobile]');g.target?.classList.remove('cut-drop-target');g.target=target;target?.classList.add('cut-drop-target');
 });
 function cancelCutGesture(){if(cutGesture){const g=cutGesture;cutGesture=null;g.ghost?.remove();root.classList.remove('cut-dragging');g.target?.classList.remove('cut-drop-target');if(root.hasPointerCapture(g.pointer))root.releasePointerCapture(g.pointer);}render();}
 root.addEventListener('pointerup',e=>{
  if(cutGesture?.pointer===e.pointerId){const g=cutGesture;cutGesture=null;g.ghost?.remove();root.classList.remove('cut-dragging');g.target?.classList.remove('cut-drop-target');if(root.hasPointerCapture(g.pointer))root.releasePointerCapture(g.pointer);if(g.active){suppressClipClick=true;if(g.target){const d=g.target.dataset,button=g.target.querySelector('[data-edit]'),target=d.action==='add-mobile'?{role:state.role,index:chain(state.role).length,group:'role'}:{role:d.nodeRole||d.edit||button?.dataset.edit,index:Number(d.index??button?.dataset.index),group:d.group||button?.dataset.group||'role'};if(g.route){state.picker=null;commitCut(g.route,{...target,profile:state.profile,expected:chain(target.role,target.group)[target.index]??null});}else placeCut(g.key,target);}else render();}}
 });
 root.addEventListener('pointercancel',()=>{if(cutGesture)cancelCutGesture();});
 root.addEventListener('lostpointercapture',()=>{if(cutGesture)cancelCutGesture();});
 window.addEventListener('blur',()=>{if(cutGesture)cancelCutGesture();});
 root.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&!e.defaultPrevented&&!state.modal&&!state.picker&&!e.target.matches('select')&&state.armedCut){e.preventDefault();state.armedCut=null;state.cutTarget=null;state.opFeedback='Вставку скасовано.';render();(win.querySelector('#cut-query')||win.querySelector('[data-op-switch=cuts]'))?.focus({preventScroll:true});return;}
  if(e.key==='Escape'&&cutGesture){e.preventDefault();cancelCutGesture();return;}
 });
 root.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.selectStep){const el=win.querySelector('#'+CSS.escape(b.dataset.selectStep));if(el){el.selectedIndex=Math.max(0,Math.min(el.options.length-1,el.selectedIndex+Number(b.dataset.direction)));el.dispatchEvent(new Event('change',{bubbles:true}));win.querySelector(`[data-select-step="${b.dataset.selectStep}"][data-direction="${b.dataset.direction}"]:not(:disabled)`)?.focus({preventScroll:true});}return;}
  if(b.dataset.opSwitch){const key=b.dataset.opSwitch;if(key==='health'){state.health=!state.health;state.opFeedback=state.health?'HEALTH · колір і шкала на CUT показують найменший доступний ліміт. ? — немає свіжого виміру.':'HEALTH вимкнено · показано чисту плівку.';}if(key==='cuts')state.cuts=!state.cuts;if(key==='free')state.freeCuts=!state.freeCuts;render();if(key==='health'&&state.health&&!matchMedia('(prefers-reduced-motion: reduce)').matches)for(const strip of win.querySelectorAll('.tape-health-strip'))strip.animate([{opacity:0,transform:'scaleX(.5)'},{opacity:1,transform:'none'}],{duration:220,easing:'ease-out'});storeOperator();win.querySelector(`[data-op-switch="${key}"]`)?.focus({preventScroll:true});return;}
  if(b.dataset.cut){if(state.cutTarget)placeCut(b.dataset.cut,state.cutTarget);else{state.armedCut=b.dataset.cut;state.opFeedback='CUT обрано. Натисни місце на плівці або «+», щоб вставити.';if(state.view!=='profiles')state.view='profiles';if(narrowSurface())state.cuts=false;render();if(narrowSurface()){win.querySelector('.cut-placement [data-action=cancel-cut]')?.focus({preventScroll:true});scrollToControl(win.querySelector('.cut-placement'));}}return;}
  if(b.dataset.action==='cancel-cut'){state.armedCut=null;state.cutTarget=null;render();win.querySelector('[data-op-switch=cuts]')?.focus({preventScroll:true});return;}
  if(b.dataset.analyze){state.analyze=b.dataset.analyze;state.allEditions=false;render();win.querySelector(`.ledger-cut[data-analyze="${CSS.escape(b.dataset.analyze)}"]`)?.focus({preventScroll:true});return;}if(b.dataset.action==='all-editions'){state.allEditions=!state.allEditions;render();return;}
  if(b.hasAttribute('data-history-bin')){state.historyIndex=Number(b.dataset.historyBin);render();return;}
  if(b.dataset.action==='meters-mobile'){state.mobileMeters=!state.mobileMeters;render();win.querySelector('[data-action=meters-mobile]')?.focus({preventScroll:true});return;}
  if(b.dataset.action==='cuts-close'){state.cuts=false;state.armedCut=null;state.cutTarget=null;render();}
  if(b.dataset.action==='cuts-more'){state.cutLimit=(state.cutLimit||60)+60;render();}
 });
 // Click-to-place provides the same operation without dragging (phone / keyboard).
 root.addEventListener('click',e=>{if(!state.armedCut||e.target.closest('[data-cut],[data-slot-actions],select,.effort-control'))return;const target=e.target.closest('[data-edit],[data-action=add-mobile]');if(!target||target.disabled)return;e.preventDefault();e.stopImmediatePropagation();const d=target.dataset;placeCut(state.armedCut,d.action==='add-mobile'?{role:state.role,index:chain(state.role).length,group:'role'}:{role:d.edit,index:Number(d.index),group:d.group||'role'});},true);
 root.addEventListener('change',e=>{const id=e.target.id,value=e.target.value;if(id==='history-position'){state.historyIndex=Number(value);render();win.querySelector('#history-position')?.focus({preventScroll:true});return;}const map={'cut-provider':'cutProvider','cut-health':'cutHealth','op-role':'role','op-sort':'catalogSort','op-scope':'catalogMode','op-source':'benchSource','op-release':'benchRelease','op-evidence':'catalogEvidence','history-metric':'historyMetric','history-sort':'historySort'};if(map[id]){state[map[id]]=value;state.page=0;if(id==='op-scope')state.catalogProvider='all';if(id==='op-source')state.benchRelease=[...new Set(source.insights.benchmarks.records.filter(b=>b.source===value).map(b=>b.release))].sort().at(-1)||'';state.analyze=null;store();render();win.querySelector('#'+id)?.focus({preventScroll:true});}});
 root.addEventListener('input',e=>{if(e.target.id==='history-position'){const bins=historyBins(source.insights?.stats?.timeSeries||[]),at=bins[Number(e.target.value)];e.target.previousElementSibling.querySelector('output').textContent=at?new Date(at.timestamp).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'}):'—';}});
 function storeOperator(){try{localStorage.setItem('mana-operator',JSON.stringify({health:state.health,drawerHeight:state.drawerHeight}));}catch{}}
 function decorateHealth(surface=win){win.classList.toggle('health-on',state.health);if(!state.health||!surface)return;for(const node of surface.querySelectorAll('[data-node-role],.tree-line,[data-health-route]')){const d=node.dataset,button=node.querySelector('[data-edit]'),role=d.nodeRole||button?.dataset.edit,index=Number(d.index??button?.dataset.index),group=d.group||button?.dataset.group||'role',route=d.healthRoute||(role?chain(role,group)[index]:null);if(!route||poolName(route))continue;const h=opRouteHealth(route);node.dataset.health=h.kind;const strip=document.createElement('span');strip.className='tape-health-strip';strip.style.setProperty('--health-left',(h.remaining??100)+'%');strip.title=h.label+(h.remaining!=null?' · залишок '+num(h.remaining)+'%':'');strip.setAttribute('aria-hidden','true');node.append(strip);const meta=node.querySelector('.cut-meta,.node-meta,.tree-meta,[data-edit] small');if(meta){const badge=document.createElement('span');badge.className='tape-health';badge.textContent=healthGlyph[h.kind];badge.title=h.label;badge.setAttribute('aria-label',h.label);meta.prepend(badge);}}}

 function lightSwitch(){const light=document.documentElement.dataset.theme!=='dark';return `<button type="button" class="light-switch light-rocker" data-theme-toggle role="switch" aria-label="Світла тема" aria-checked="${light}" title="${light?'Вимкнути світло · темна тема':'Увімкнути світло · світла тема'}"><span class="light-rocker-bed" aria-hidden="true"><span class="light-rocker-cap"><i></i></span></span><span class="encoder-label" aria-hidden="true">світло</span></button>`;}
 function focusSelector(el){
  if(!el)return '';if(el.id)return '#'+CSS.escape(el.id);
  if(el.matches('.profile-menu summary'))return '.profile-menu summary';
  const prefix=el.closest('.picker')?'.picker ':el.closest('.modal')?'.modal ':'';
  if(el.name)return prefix+'[name="'+CSS.escape(el.name)+'"]';
  const attr=['data-effort-role','data-edit','data-slot-actions','data-action','data-cut','data-pick','data-analyze','data-fav','data-op-switch','data-pool-open','data-pool-tab','data-mode-scope','data-agent-role','data-agent-copy','data-focus-role','data-theme-toggle','data-display','data-lcd-colour','data-view','data-model-detail'].find(key=>el.hasAttribute(key));
  return attr?prefix+'['+attr+'="'+CSS.escape(el.getAttribute(attr))+'"]'+['data-index','data-group','data-direction','data-lcd-part'].filter(key=>el.hasAttribute(key)).map(key=>'['+key+'="'+CSS.escape(el.getAttribute(key))+'"]').join(''):'';
 }
 function render(){
  roleKeys.splice(0,roleKeys.length,...Object.keys(p().modelRoles||{}));if(!roleKeys.includes(state.role))state.role=roleKeys[0]||'';
  if(composing||drag?.active||cutGesture?.active||drawerGesture||document.documentElement.dataset.displayTuning){pendingRender=true;scheduleBackgroundWork();return;}
  pendingRender=false;renderCache={diffs:new Map(),keys:new Map()};
  try{
  opReportCache=usageReports();win.dataset.opView=state.view;document.title=source.demo?'Mana Tape · DEMO':'Mana Tape · OMP';
  const previousCuts=win.querySelector('.drawer-results'),cutsScroll=previousCuts?{key:previousCuts.dataset.filterKey,top:previousCuts.scrollTop}:null;
  const scrollState=['.desktop-graph','.meter-channels','.history-tape','.picker-results'].map(selector=>{const el=win.querySelector(selector);return el?{selector,left:el.scrollLeft,top:el.scrollTop,key:el.dataset.filterKey}:null;}).filter(Boolean),menuOpen=!!win.querySelector('.profile-menu[open]');
  const motion=ForgeTape.before(win);editHistory.observe(state.profile,p(),!!diff(state.profile).length,original[state.profile]);editHistory.observe('@free-pools',poolDraft,poolsDirty(),poolOriginal);
  const wasModal=document.body.classList.contains('modal-open'),focused=document.activeElement,controlFocus=focusSelector(focused),modalFocus=focused?.closest('.modal')?controlFocus:'',selection=focused?.selectionStart!=null?[focused.selectionStart,focused.selectionEnd,focused.selectionDirection]:null,layerScroll=win.querySelector('.modal-layer')?.scrollTop||0;
  const oldForm=win.querySelector('.modal form'),formValues=oldForm?[...oldForm.elements].filter(el=>el.name).map(el=>({name:el.name,value:el.value,checked:el.checked})):[];
  if(state.modal&&!wasModal){
   modalPageY=window.scrollY;
   const attribute=['data-model-detail','data-edit-provider','data-action'].find(a=>focused?.hasAttribute(a));
   modalReturnFocus=focused?.closest('.profile-menu')?'.profile-menu summary':attribute?`[${attribute}="${CSS.escape(focused.getAttribute(attribute))}"]`:'.tabs .active';
   document.body.style.top=-modalPageY+'px';document.body.classList.add('modal-open');
  }else if(!state.modal&&wasModal){document.body.classList.remove('modal-open');document.body.style.top='';window.scrollTo({top:modalPageY,behavior:'instant'});}
  ensureModePreview();rebuild();state.changes=diff(state.profile).length;root.style.setProperty('--fg-steps',stepCount());root.style.setProperty('--fg-row','38px');
  const dirty=profileKeys.filter(k=>diff(k).length),reports=usageReports();
  win.innerHTML=`<header class="topbar"><a href="#" class="brand" aria-label="Mana Tape — профілі"><svg class="mana-mark" viewBox="0 0 72 42" aria-hidden="true"><defs><linearGradient id="mark-metal" x2="1" y2="1"><stop stop-color="currentColor" stop-opacity=".8"/><stop offset="1" stop-color="currentColor" stop-opacity=".35"/></linearGradient></defs><path class="mark-tape" d="M20 8C3 8 3 33 20 33H50C67 33 67 8 50 8" fill="none" stroke="currentColor" stroke-width="2.3"/><path class="mark-joint" d="M34 29L38 37" stroke="var(--orange)" stroke-width="2.8"/><g class="mark-wheel mark-wheel-a"><circle cx="20" cy="19" r="13" fill="var(--deck)" stroke="url(#mark-metal)" stroke-width="2.5"/><circle cx="20" cy="19" r="4" fill="var(--accent)"/><path d="M20 9v4m8 11-4-2m-12 2 4-2" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></g><g class="mark-wheel mark-wheel-b"><circle cx="50" cy="19" r="13" fill="var(--deck)" stroke="url(#mark-metal)" stroke-width="2.5"/><circle cx="50" cy="19" r="4" fill="var(--orange)"/><path d="M50 9v4m8 11-4-2m-12 2 4-2" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></g></svg><span class="wordmark"><b>mana</b><b>tape</b></span></a><nav class="tabs" aria-label="Розділи">${[['profiles','Монтаж'],['models','Колекція'],['dashboard','Історія']].map(([k,label])=>`<button type="button" data-view="${k}" class="${state.view===k?'active':''}" aria-current="${state.view===k?'page':'false'}" aria-label="${label}"><span class="surface-key">${k==='profiles'?'01':k==='models'?'02':'03'}</span>${label}</button>`).join('')}</nav><div class="header-actions">${lightSwitch()}${ManaDisplay.controls()}<button type="button" class="refresh-button ${source.refresh.busy?'spinning':''}" data-action="refresh" aria-label="Оновити дані" ${source.refresh.busy?'disabled':''}>↻</button><span class="connection" title="${state.offline?'Немає зв’язку з сервером':'Підключено до сервера'}">${source.demo?'DEMO':state.offline?'Офлайн':'OMP'}<small>${timeLabel(source.refresh.at)}</small></span></div></header>
  ${source.demo?'<div class="demo-banner" role="status">DEMO · ізольовані тестові профілі. Реальні рахунки не підключені.</div>':''}${operatorDock()}${state.view==='profiles'&&reports.length?`${tool('Ліміти · '+reports.length,'meters-mobile','tray-toggle mobile-meter-key',`aria-expanded="${!!state.mobileMeters}" aria-controls="meter-bank"`)}<div class="meter-bank" id="meter-bank" data-mobile-expanded="${!!state.mobileMeters}">${opQuota()}</div>`:''}
  ${state.error&&state.modal!=='conflict'?`<div class="error-banner" role="alert">${esc(state.error)} ${tool('×','clear-error','icon-only','aria-label="Закрити повідомлення"')}</div>`:''}
  ${source.refresh.error?`<div class="error-banner">${esc(source.refresh.error)}</div>`:''}
  <main class="content operator-surface" data-surface="${state.view}">${state.view==='dashboard'?historySurface():state.view==='profiles'?`<div class="transport-bar">${catalog.some(m=>deepseek(m.provider+'/'+m.id))||modeOff()?modeBar():''}</div>`+profileView():operatorCatalog()}${cutsTray()}</main>
  <footer class="bottom"><span>${roleKeys.length} ролей · ${profileKeys.length} профілів · ${dirty.length?dirty.length+' із чернетками':'усе збережено'}</span><span>${state.view==='dashboard'?'Ліміти · 5 хв / каталог · 15 хв':'Зміни для нових запусків OMP'}</span></footer>${pickerMarkup()}${modalMarkup()}${state.toast?`<div class="toast" role="status">${esc(state.toast)}</div>`:''}`;
  win.dataset.tapeContext=state.view+'|'+state.profile+(state.view==='profiles'&&win.clientWidth<=900?'|'+state.role:'');
  ForgeTape.fit(win);resizeDrawer(state.drawerHeight);decorateHealth();
  for(const saved of scrollState){const el=win.querySelector(saved.selector);if(el&&(saved.selector!=='.desktop-graph'||motion.context===win.dataset.tapeContext)&&saved.key===el.dataset.filterKey){el.scrollLeft=saved.left;el.scrollTop=saved.top;}}
  ForgeTape.after(win,motion,{profile:state.profile,view:state.view,draft:JSON.stringify(p()),projection:JSON.stringify([roleKeys.map(r=>chain(r)),workers().map(r=>chain(r,'vibe')),poolDraft]),dirty:!!state.changes,saving:state.saving,error:state.error});ManaDisplay.sync();
  if(menuOpen&&!state.modal)win.querySelector('.profile-menu')?.setAttribute('open','');
  const nextCuts=win.querySelector('.drawer-results');if(nextCuts&&cutsScroll?.key===nextCuts.dataset.filterKey)nextCuts.scrollTop=cutsScroll.top;
  win.classList.toggle('profile-dirty',state.view!=='dashboard'&&!!(state.changes||state.saving));
  for(const child of win.children)child.inert=!!state.modal&&!child.classList.contains('modal-layer')&&!child.classList.contains('toast');
  if(state.modal){const layer=win.querySelector('.modal-layer'),form=layer.querySelector('form');layer.scrollTop=layerScroll;if(form&&form.id===oldForm?.id)for(const saved of formValues){const el=form.elements.namedItem(saved.name);if(el){el.value=saved.value;if(typeof saved.checked==='boolean')el.checked=saved.checked;}}const target=modalFocus?layer.querySelector(modalFocus):!wasModal?layer.querySelector('input,button'):null;target?.focus({preventScroll:true});if(target&&selection&&typeof target.setSelectionRange==='function')target.setSelectionRange(...selection);}
  if(state.view==='profiles')for(const row of win.querySelectorAll('.graph-row:not(.vibe-row)')){const r=row.querySelector('[data-focus-role]')?.dataset.focusRole;if(r&&state.profile!=='standard'&&!Object.hasOwn(source.presets[state.profile]?.modelRoles||{},r))row.querySelector('.role-name').title='Основна модель успадкована зі Standard';}
  if(state.picker){fitPicker();const x=state.picker;for(const el of win.querySelectorAll(`[data-edit="${CSS.escape(x.role)}"][data-index="${x.index}"][data-group="${x.group}"]`))el.closest('.node,.tree-line')?.classList.add('editing');}
  if(!state.modal&&controlFocus){const target=[...win.querySelectorAll(controlFocus)].find(el=>el.getClientRects().length&&!el.disabled);target?.focus({preventScroll:true});if(target&&selection&&typeof target.setSelectionRange==='function')target.setSelectionRange(...selection);}
  if(!state.modal&&focused?.matches('.cut-tools'))focusPickerMove(state.picker?.focusDirection||1);
  if(!state.modal&&wasModal)[...win.querySelectorAll(modalReturnFocus||'.tabs .active')].find(el=>el.getClientRects().length)?.focus({preventScroll:true});
  try{if(poolsDirty())sessionStorage.setItem(storageKey('forge-pool-draft'),JSON.stringify({original:poolOriginal,value:poolDraft,revision:poolRevision}));else sessionStorage.removeItem(storageKey('forge-pool-draft'));sessionStorage.setItem(storageKey('forge-drafts'),JSON.stringify(Object.fromEntries(dirty.map(k=>[k,{original:original[k],value:profiles[k],revision:source.revisions[k]}]))));}catch{}
  renderedAt=Date.now();
  }finally{renderCache=null;}
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
   if(action==='clone-create'){const f=win.querySelector('#clone-form');if(state.profileBusy)return;const q=checkProfileName(f);if(!f.reportValidity())return;let name=q.name;state.cloneName=f.elements.name.value;state.profileBusy=true;f.querySelector('button').disabled=true;try{const result=await api('/api/profile-action',{action:'clone',profile:state.profile,name});name=result.name||name;state.modal=null;state.modalError='';await reload();state.profile=name;editHistory.profiles.delete(name);render();store();}finally{state.profileBusy=false;}}
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
   if(action==='discard-reload'){if(!confirm('Скинути всі незбережені чернетки й завантажити поточні файли?'))return;state.modal=null;state.error='';editHistory.profiles.clear();await reload(true);}
   if(action==='export-draft'){const blob=new Blob([JSON.stringify(Object.fromEntries(profileKeys.filter(k=>diff(k).length).map(k=>[k,{revision:source.revisions[k],changes:diff(k)}])),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='forge-drafts.json';a.click();URL.revokeObjectURL(url);}
  }catch(err){if(state.modal){state.modalError=err.message;}else state.error=err.message;render();}
 });
 root.addEventListener('input',e=>{if(!e.target.matches('#clone-form input,#rename-form input'))return;if(e.target.form.id==='clone-form')state.cloneName=e.target.value;else state.renameName=e.target.value;checkProfileName(e.target.form);state.modalError='';win.querySelector('.modal > .error-banner')?.remove();});
 root.addEventListener('submit',e=>{if(e.target.id==='clone-form'){e.preventDefault();win.querySelector('[data-action=clone-create]')?.click();}if(e.target.id==='rename-form'){e.preventDefault();win.querySelector('[data-action=rename-confirm]')?.click();}});
 root.addEventListener('change',e=>{if(e.target.id==='sync-vibe'||e.target.hasAttribute('data-sync-vibe')){state.syncVibe=e.target.checked;for(const input of win.querySelectorAll('[data-sync-vibe]'))input.checked=state.syncVibe;store();}});
 root.addEventListener('keydown',e=>{if(e.key==='Tab'&&(state.modal||state.picker)){const layer=win.querySelector(state.modal?'.modal':'.picker'),nodes=[...layer.querySelectorAll('button:not(:disabled),input,select,textarea,a[href]')].filter(x=>x.getClientRects().length),first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
 window.addEventListener('resize',()=>{finishDrawerResize(true);fitPicker(true);ForgeTape.fit(win);resizeDrawer(state.drawerHeight);});
 window.addEventListener('beforeunload',e=>{if(!state.switchingProject&&(poolsDirty()||profileKeys.some(k=>diff(k).length))){e.preventDefault();e.returnValue='';}});
 root.addEventListener('change',e=>{if(e.target.id==='project-choice'&&!state.saving){store();state.switchingProject=true;const url=new URL(location.href);url.searchParams.set('project',e.target.value);location.assign(url);}});
 window.addEventListener('offline',()=>{state.offline=true;state.error='Немає мережі. Чернетки залишаються у цьому вікні; збереження потребує сервера.';render();});
 window.addEventListener('online',()=>{state.error='';pollState();});
 Object.assign(state,{health:true,cuts:false,freeCuts:false,cutProvider:'all',cutHealth:'all',cutQuery:'',catalogSort:'score',benchSource:'Artificial Analysis',benchRelease:[...new Set((source.insights?.benchmarks?.records||[]).filter(b=>b.source==='Artificial Analysis').map(b=>b.release))].sort().at(-1)||'',historyMetric:'requests',historySort:'totalRequests'});try{const saved=JSON.parse(localStorage.getItem('mana-operator')||'{}');if(typeof saved?.health==='boolean')state.health=saved.health;if(Number.isFinite(saved?.drawerHeight))state.drawerHeight=saved.drawerHeight;}catch{}
 state.syncVibe=true;state.statsLimit=8;state.favs=source.favs||[];state.error='';state.modalError='';
 try{const v=JSON.parse(localStorage.getItem(storageKey('forge-view')));if(v){if(['dashboard','profiles','models','providers'].includes(v.view))state.view=v.view==='providers'?'models':v.view;if(profiles[v.profile])state.profile=v.profile;if(roleKeys.includes(v.role))state.role=v.role;if(typeof v.syncVibe==='boolean')state.syncVibe=v.syncVibe;}const drafts=JSON.parse(sessionStorage.getItem(storageKey('forge-drafts'))||'{}');for(const [k,v]of Object.entries(drafts)){if(profiles[k]&&v.original&&v.value&&v.revision){original[k]=v.original;profiles[k]=v.value;source.revisions[k]=v.revision;}}}catch{}
 try{const draft=JSON.parse(sessionStorage.getItem(storageKey('forge-pool-draft'))||'null');if(draft?.original&&draft.value&&draft.revision){poolOriginal=draft.original;poolDraft=draft.value;poolRevision=draft.revision;}}catch{}
 for(const [k,v] of Object.entries(profiles)){v.forgeMode??=copy(source.profileModes?.[k]?.settings||{mode:'deepseek',alternatives:[],overrides:{}});original[k].forgeMode??=copy(v.forgeMode);}
 if(!profiles[state.profile])state.profile='standard';
 rebuild();render();
 if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
 setInterval(()=>{if(document.hidden)return;for(const el of win.querySelectorAll('[data-reset]')){const at=Number(el.dataset.reset);el.textContent=resetCountdown(at);el.title=resetTitle(at);el.closest('.quota-reading,.quota-window')?.classList.toggle('waiting-reset',at>0&&at<=Date.now());}const timeline=win.querySelector('.tariff-timeline');if(timeline&&!timeline.contains(document.activeElement))timeline.innerHTML=tariffTimeline();},30000);
 setInterval(pollState,15000);
})();

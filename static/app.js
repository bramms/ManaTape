
(async()=>{
 const root=document.getElementById('forge-direct'),win=document.getElementById('forge-window');
 // Every request has a deadline: a hung server or tunnel becomes «офлайн» or a clear refusal, never a silent wait.
 function deadline(ms){if(typeof AbortController==='undefined')return undefined;if(AbortSignal.timeout)return AbortSignal.timeout(ms);const c=new AbortController();setTimeout(()=>c.abort(new DOMException('Сервер не відповів','TimeoutError')),ms);return c.signal;}
 const selectedProject=new URLSearchParams(location.search).get('project');
 const endpoint=path=>path+(selectedProject?'?project='+encodeURIComponent(selectedProject):'');
 // The first request is the one index.html preloads (same URL and mode), so it is usually already in flight.
 let source,stateTag='';
 // A boot that waits too long offers «Повторити» on the plate; after 15 s the wait ends on the retry screen (QA4 P0-4).
 const bootSlow=setTimeout(()=>{const plate=win.querySelector('.boot');if(plate&&!plate.querySelector('#retry-load')){plate.insertAdjacentHTML('beforeend','<button type="button" class="key" id="retry-load"><span class="key__cap">Повторити</span></button>');plate.querySelector('#retry-load').onclick=()=>location.reload();}},5000);
 // A failed boot keeps the whole plate (brand, screws, body); only its glass turns red (DESIGN «Корпус»). A response
 // with an error status prints the server's own reason and code (F3); no response at all is a connection problem.
 function bootMessage(e){return e?.status?(e.message||'Сервер відмовив')+' · HTTP '+e.status+(e.code?' · '+e.code:''):'Сервер не відповідає. Перевір підключення.';}
 function bootFailed(e){
  const safe=bootMessage(e).replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
  let plate=win.querySelector('.boot');
  if(!plate){win.innerHTML='<div class="device"><i class="screw screw--tl"></i><i class="screw screw--tr"></i><i class="screw screw--bl"></i><i class="screw screw--br"></i><div class="boot"><div class="screen" data-screen="startup"><div class="screen__win"><div class="screen__gasket"><div class="glass"><div class="glass__content"><div class="g"></div></div></div></div></div></div></div></div>';plate=win.querySelector('.boot');}
  const scr=plate.querySelector('.screen');scr.dataset.screenDefault='27';
  scr.querySelector('.g').innerHTML=`<div class="g-head"><span class="g-name">Mana Tape</span><span class="g-age">${e?.status?'відмова сервера':'немає зв’язку'}</span></div><div class="g-msg" data-s="bad" role="alert"><span>${safe}</span></div>`;
  plate.removeAttribute('aria-busy');plate.classList.add('boot--failed');
  if(!plate.querySelector('#retry-load'))plate.insertAdjacentHTML('beforeend','<button type="button" class="key" id="retry-load"><span class="key__cap">Повторити</span></button>');
  plate.querySelector('#retry-load').onclick=()=>location.reload();window.ManaScreen?.sync();
 }
 try {const res=await fetch(endpoint('/api/state'),{signal:deadline(15000)});source=await res.json().catch(()=>null);if(!res.ok||!source)throw Object.assign(Error(source?.error||'Сервер відповів без даних'),{status:res.status,code:source?.code||''});stateTag=res.headers.get('ETag')||'';}catch(e){clearTimeout(bootSlow);bootFailed(e);return;}
 clearTimeout(bootSlow);

 const labels=source.ui?.roleLabels||{};
 const providerNames={'opencode-free':'OpenCode Free','commandcode':'CommandCode','opencode-go':'OpenCode Go','openai-codex':'Codex','google-antigravity':'Antigravity','anthropic':'Anthropic','deepseek':'DeepSeek API',...(source.ui?.providerLabels||{})};
 const codes={'opencode-free':'FREE','openrouter':'OR','commandcode':'CC','opencode-go':'GO','openai-codex':'CX','google-antigravity':'AG','anthropic':'AN','deepseek':'DS',...(source.ui?.providerCodes||{})};
 // A provider's tag prints its own code; without one, a code derived from the id that no other provider shares
 // (colour is never the only carrier): the first four letters, else segment initials with the last segment
 // («demo-studio» → DSTU), else a numbered one. The set is fixed per snapshot (dataVersion).
 function providerCode(id){
  if(codes[id])return codes[id];
  let memo=providerCode.memo;
  if(memo?.version!==dataVersion||!memo.map.has(id))memo=providerCode.memo={version:dataVersion,map:assignCodes([...new Set([...(memo?.version===dataVersion?memo.map.keys():[]),...source.providers.map(v=>v.id),...catalog.map(m=>m.provider),id])].sort())};
  return memo.map.get(id);
 }
 function assignCodes(ids){
  const map=new Map(),taken=new Set(Object.values(codes)),words=id=>String(id||'?').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const candidates=id=>{const parts=words(id),last=parts.at(-1)||'?',head=parts.slice(0,-1).map(s=>s[0]).join('');return [parts.join('').slice(0,4),(head+last).slice(0,4),(head.slice(0,1)+last).slice(0,4),(parts[0]||'').slice(0,2)+last.slice(0,2)];};
  let rest=ids.filter(id=>!codes[id]);
  for(let level=0;level<4&&rest.length;level++){
   const pick=new Map(rest.map(id=>[id,candidates(id)[level]||''])),count=new Map();for(const c of pick.values())count.set(c,(count.get(c)||0)+1);
   rest=rest.filter(id=>{const c=pick.get(id);if(!c||count.get(c)>1||taken.has(c))return true;map.set(id,c);taken.add(c);return false;});
  }
  for(const id of rest){const base=(candidates(id)[0]||'?').slice(0,3);let n=2;while(taken.has(base+n))n++;map.set(id,base+n);taken.add(base+n);}
  return map;
 }
 // Profile ids: `standard` (the scope's file), `preset:<name>` (a native OMP котушка in that file), `global:<name>`
 // (a Global котушка seen from a project: read-only here, it can be applied), anything else an old .omp/presets file.
 const isNative=name=>String(name).startsWith('preset:'),isGlobalPreset=name=>String(name).startsWith('global:');
 const presetName=name=>String(name).replace(/^(?:preset|global):/,'');
 const prettyProfile=s=>s==='standard'?'Standard':presetName(s);
 function presetLike(name=state.profile){return isNative(name)||isGlobalPreset(name);}
 function locked(name=state.profile){return isGlobalPreset(name);}
 // LAYERS (DESIGN «Області і котушки»). A project's file is a layer over the Global config: OMP takes the project's
 // value where it has one and the Global one for the rest (maps merge per key; a list or a scalar replaces; a project
 // null is no tombstone). The panel edits only this file's own layer (profiles[*]); every lane reads the layered view
 // (eff), so a lane the project does not set shows the Global value, and an edit writes into the project only. A
 // native котушка's role map is complete (OMP replaces the role map when it is applied); its reserves, agents and
 // providers are the scope's.
 // Per-render memo (diffs, mode keys, layered views); null outside render().
 let renderCache=null,globalLayer=normalizeLayer(source.inherited),globalLogical=normalizeLayer(source.inheritedLogical||source.inherited);
 function normalizeLayer(raw){return raw?{modelRoles:{...raw.modelRoles},retry:{...raw.retry,fallbackChains:{...raw.retry?.fallbackChains}},task:{...raw.task,agentModelOverrides:{...raw.task?.agentModelOverrides}},...(raw.disabledProviders?{disabledProviders:raw.disabledProviders}:{})}:null;}
 // OMP merges a project over Global per key; a project null role is no tombstone (Global shows through), but a null
 // chain or agent list replaces the Global one like any other value (nothing of it is used).
 function mergeMap(a,b,nullReplaces=false){const out={...a};for(const [k,v] of Object.entries(b||{})){if(v!=null)out[k]=v;else if(nullReplaces)delete out[k];}return out;}
 function eff(profile=p()){
  if(!profile||!globalLayer)return profile;
  const memo=renderCache&&(renderCache.layers??=new Map()),hit=memo?.get(profile);if(hit)return hit;
  const g=globalLayer,out={...profile,modelRoles:profile.forgePreset?profile.modelRoles:mergeMap(g.modelRoles,profile.modelRoles),
   retry:{...g.retry,...profile.retry,fallbackChains:mergeMap(g.retry.fallbackChains,profile.retry?.fallbackChains,true)},
   task:{...g.task,...profile.task,agentModelOverrides:mergeMap(g.task.agentModelOverrides,profile.task?.agentModelOverrides,true)},
   disabledProviders:(profile.disabledProviders!==undefined?profile.disabledProviders:g.disabledProviders)||[]};
  memo?.set(profile,out);return out;
 }
 // The Global config holds a value for this lane (its primary or own reserves; an agent's list).
 function globalHas(role,group='role'){const g=globalLayer;return !!g&&(group==='vibe'?Object.hasOwn(g.task.agentModelOverrides,role):!!g.modelRoles[role]||Object.hasOwn(g.retry.fallbackChains,role));}
 const asList=v=>(Array.isArray(v)?v:[v]).filter(Boolean);
 // Ukrainian count agreement: 1 зміна · 2 зміни · 5 змін (11–14 take the «many» form).
 function plural(n,one,few,many){const a=Math.abs(n)%100,b=a%10;return b===1&&a!==11?one:b>=2&&b<=4&&(a<12||a>14)?few:many;}
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
  if(state.saving||locked()||!Object.hasOwn(p().task.agentModelOverrides||{},worker)&&!agentInfo(worker))return;
  const target=p().task.agentModelOverrides,base=state.profile==='standard'?{}:original.standard.task.agentModelOverrides;
  if(Object.hasOwn(base,worker))target[worker]=copy(base[worker]);else delete target[worker];
  delete modeSettings().overrides['vibe:'+worker];state.picker=null;state.opFeedback='';render();focusLane(worker,'vibe');
 }
 // After a reset the old control is gone; focus the lane's own first control.
 function focusLane(role,group){[...win.querySelectorAll(`button[data-edit="${CSS.escape(role)}"][data-group="${group}"]`)].find(el=>el.getClientRects().length)?.focus({preventScroll:true});}
 // Built-in roles, then every role the layered view names; a котушка also lists its scope's roles (a role it does not
 // carry is a lane «не в котушці»).
 function knownRoleKeys(profile,scope=null){return [...new Set([...builtinRoles.map(r=>r.id),...Object.keys(eff(profile)?.modelRoles||{}),...Object.keys(scope?eff(scope).modelRoles||{}:{})])];}
 function roleInfo(role){return builtinRoles.find(r=>r.id===role);}
 // A lane back to what this file inherits: «Типово в OMP», Standard (an old котушка), the Global value (a project's
 // own role), or out of a native котушка. Its draft is one Undo step.
 function resetRole(role){
  if(state.saving||locked()||!roleInfo(role)&&!isNative(state.profile)&&!globalHas(role))return;
  if(isNative(state.profile))delete p().modelRoles[role];
  else{
   const base=state.profile==='standard'?{}:original.standard;
   for(const [target,from] of [[p().modelRoles,base.modelRoles||{}],[p().retry.fallbackChains,base.retry?.fallbackChains||{}]]){
    if(Object.hasOwn(from,role))target[role]=copy(from[role]);else delete target[role];
   }
  }
  delete modeSettings().overrides['role:'+role];state.picker=null;state.opFeedback='';render();focusLane(role,'role');
 }
 // «Прибрати» on a lane's only own CUT is the reset of that lane: a built-in role or a known agent's own list returns
 // to «Типово в OMP», a project's own value to the Global one, a котушка's primary leaves the котушка. It names the
 // result; '' where that reset does not exist or would change nothing (an old котушка's lane that only repeats
 // Standard; a value a project only inherits: OMP keeps the Global one, a project null is no tombstone).
 function soleCutReset(role,group){
  if(locked()||group!=='role'&&group!=='vibe')return '';
  const vibe=group==='vibe';
  if(isNative(state.profile))return !vibe&&p().modelRoles[role]?'роль вийде з котушки':'';
  if(state.profile==='standard'&&globalLayer){
   if(!(vibe?Object.hasOwn(p().task.agentModelOverrides,role):!!p().modelRoles[role]))return '';
   if(globalHas(role,group))return 'як у глобальному';
  }
  if(vibe?!agentInfo(role)||!agentValues(role).length:!roleInfo(role)||!p().modelRoles[role])return '';
  const pick=profile=>vibe?[profile.task?.agentModelOverrides?.[role]]:[profile.modelRoles?.[role],profile.retry?.fallbackChains?.[role]],std=state.profile==='standard'?null:pick(original.standard);
  if(std&&JSON.stringify(std)===JSON.stringify(pick(p())))return '';
  return std?.some(v=>v!==undefined)?'як у Standard':vibe?'агент стане типовим':'роль стане типовою';
 }
 // The CUT is the lane's last own CUT: its real chain (or the agent's list) holds nothing else, also none hidden by
 // DeepSeek OFF; a ⇄ replacement is never «own» (removing it edits the replacement list). A котушка's primary is its
 // lane's only own CUT: the reserves shown after it are the scope's.
 function removesLane(role,index,group){
  if(group!=='role'&&group!=='vibe'||index!==0)return false;
  const ref=modeView(role,group)?.refs?.[0];
  if(isNative(state.profile))return group==='role'&&!!p().modelRoles[role]&&(!ref||ref.kind==='base');
  if(chain(role,group).length!==1)return false;
  return (!ref||ref.kind==='base')&&(group==='vibe'?agentValues(role):baseChain(role)).length===1;
 }
 // Any CUT can be removed: a reserve; the primary of a longer lane (the next CUT becomes the primary); the lane's
 // only CUT where the lane has a default to return to. Editor lists (replacements, pools) remove any item. A котушка
 // removes only its primary (the role leaves it); a Global котушка seen from a project is read-only.
 function canRemoveCut(role,index,group){
  const list=chain(role,group);if(!(index>=0&&index<list.length))return false;
  if(group==='alternatives'||group==='pool')return true;
  if(presetLike())return index===0&&removesLane(role,index,group)&&!!soleCutReset(role,group);
  return index>0||list.length>1||removesLane(role,index,group)&&!!soleCutReset(role,group);
 }
 // One Undo step. Returns 'reset' (the lane went back to its default and took the focus), true or false.
 function removeCut(role,index,group){
  if(!canRemoveCut(role,index,group))return false;
  if(removesLane(role,index,group)){if(group==='vibe')resetAgent(role);else resetRole(role);return 'reset';}
  const list=chain(role,group);list.splice(index,1);return setChain(role,list,group);
 }
 function roleFallbacks(role,profile=p()){const chains=eff(profile).retry.fallbackChains;return chains[role]||(roleInfo(role)?.defaultFallbacks===false?[]:chains.default||[]);}
 // One vision rule everywhere (QA1 B7), the server's: a vision lane (ui.visionRoles) takes only CUTS that read
 // images, and so does a FREE pool that stands on a vision lane in any profile. An unknown, only-referenced route
 // is not judged.
 function readsImages(model){return Array.isArray(model.input)?model.input.includes('image'):!!(model.configuredOnly||model.source==='reference');}
 function visionRole(id){return (source.ui?.visionRoles||['vision']).includes(id);}
 function poolVisionLane(name){
  const token=poolToken(name);
  for(const set of [original,profiles])for(const [k,pr] of Object.entries(set))for(const role of source.ui?.visionRoles||['vision']){const route=eff(pr).modelRoles?.[role];if(route&&[route,...roleFallbacks(role,pr)].includes(token))return role+(k==='standard'?'':' · '+k);}
  return '';
 }
 function acceptsRoleModel(role,group,model){
  if(group==='pool')return readsImages(model)||!poolVisionLane(role);
  if(group==='alternatives'&&role==='profile')return true;
  const id=group==='vibe'?(aliasRole(vibeAlias(role))||'task'):group==='alternatives'?role.split(':')[1]:role,info=roleInfo(id),kind=model.kind||'chat';
  return (info?.kinds||['chat']).includes(kind)&&(id!=='web'||kind!=='chat'||model.webSearch!=null)&&(!visionRole(id)||readsImages(model));
 }
 function normalizeProfile(profile){return merge({modelRoles:{},retry:{fallbackChains:{}},task:{agentModelOverrides:{}}},profile);}
 const DEFAULT_MODE={mode:'deepseek',alternatives:[],overrides:{}};
 // Every profile of a snapshot as the panel edits it: Standard is the scope file's own layer; an old котушка is that
 // layer with its overlay; a native котушка is its role map (and thinking) over the scope's reserves, agents and
 // providers, marked `forgePreset` (never a diffed or saved field); a Global котушка (in a project) the same, read-only.
 function snapshotProfiles(from){
  const base=normalizeProfile(from.base),out={standard:copy(base)};
  const preset=(roles,thinking)=>({...copy(base),modelRoles:copy(roles||{}),...(thinking?{defaultThinkingLevel:thinking}:{}),forgePreset:true});
  for(const [k,v] of Object.entries(from.presets||{}))out[k]=isNative(k)?preset(v.modelRoles,v.defaultThinkingLevel):normalizeProfile(merge(base,v));
  if(from.inherited)for(const [n,row] of Object.entries(from.nativePresets||{}))if(!row.own&&!row.invalid)out['global:'+n]=preset(row.roles,row.thinking);
  for(const [k,v] of Object.entries(out))v.forgeMode=copy(from.profileModes?.[k]?.settings||DEFAULT_MODE);
  return out;
 }
 const original=snapshotProfiles(source),profiles=copy(original),roleKeys=knownRoleKeys(original.standard),profileKeys=Object.keys(original);
 const storageKey=key=>'mana:'+source.source+':'+key;
 // FREE pools are machine-wide: their draft follows the machine (its Global scope), not the scope it was started in.
 function poolDraftKey(){const g=(source.projects||[]).find(x=>x.id===(source.scope?.kind==='global'?source.projectId:source.scope?.parent));return g?'mana:pools:'+g.path:storageKey('forge-pool-draft');}
 if(source.legacyDrafts){for(const [storage,key] of [[localStorage,'forge-view'],[sessionStorage,'forge-drafts'],[sessionStorage,'forge-pool-draft']]){try{const old=storage.getItem(key);if(old&&!storage.getItem(storageKey(key))){storage.setItem(storageKey(key),old);storage.removeItem(key);}}catch{}}}
 function split(route){const m=String(route).match(/:(off|minimal|low|medium|high|xhigh|max|auto)$/);const raw=m?route.slice(0,-m[0].length):route;const slash=raw.indexOf('/');return {raw,provider:slash<0?'':raw.slice(0,slash),id:raw.slice(slash+1),effort:m?m[1]:''};}
 const referenced=new Set();for(const p of Object.values(original)){Object.values(p.modelRoles).forEach(x=>referenced.add(split(x).raw));Object.values(p.retry.fallbackChains).flat().forEach(x=>referenced.add(split(x).raw));}
 const referencedProviders=[...new Set([...referenced].map(x=>split(x).provider))];
 const catalogMap=new Map(source.models.map(m=>[m.provider+'/'+m.id,m]));for(const r of referenced){if(!catalogMap.has(r)){const q=split(r);catalogMap.set(r,{provider:q.provider,id:q.id,name:q.id,configuredOnly:true});}}
 const catalog=[...catalogMap.values()].sort((a,b)=>a.provider.localeCompare(b.provider)||a.name.localeCompare(b.name));
 const state={view:'profiles',profile:'standard',role:roleKeys[0]||'',query:'',catalogQuery:'',catalogMode:'mine',catalogProvider:'all',page:0,favs:[...referenced].slice(0,8),picker:null,modal:null,changes:0,toast:''};
 let favWrites=Promise.resolve(),favSaved=[];
 let timer,drag=null,modalShown=false,formShown='',modalFit='',modalReturnFocus='',composing=false,pointerHeld=false,nativeSelectBusy=false;
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
 // Folded runs of inherited lanes that the user opened, remembered per lane and per project in this browser: a run
 // is open while any of its lanes is, so a fold that an edit splits stays open in both halves (QA1 B6).
 const openFolds=new Set((()=>{try{const v=JSON.parse(localStorage.getItem(storageKey('folds'))??localStorage.getItem('mana-folds')??'[]');return Array.isArray(v)?v.filter(x=>typeof x==='string'):[];}catch{return [];}})());
 function storeFolds(){try{localStorage.setItem(storageKey('folds'),JSON.stringify([...openFolds]));}catch{}}
 function foldOpen(fold){return fold.some(role=>openFolds.has(role));}
 // Scroll an element to the middle of the page area that the drawer does not cover.
 function revealInPage(el){
  const r=el.getBoundingClientRect(),lip=parseFloat(getComputedStyle(win.querySelector('.tray-port')||document.documentElement).getPropertyValue('--lip'))||46;
  const covered=drawerShown()?(win.querySelector('.tray')?.getBoundingClientRect().height||lip):lip,visible=window.innerHeight-covered;
  window.scrollBy({top:r.top-(visible-r.height)/2,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
 }
 // A patch key's target blinks its lane LED (class only; a re-render simply ends the blink).
 function flashLane(lane){lane.classList.remove('is-flash');void lane.offsetWidth;lane.classList.add('is-flash');setTimeout(()=>lane.classList.remove('is-flash'),1400);}
 const coarsePointer=()=>matchMedia('(pointer: coarse)').matches||narrowSurface();
 const scrollToControl=el=>el?.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
 // The search field takes the focus only on a keyboard/mouse device; a touch opens the list without the keyboard.
 function focusPicker(){const picker=win.querySelector('[data-picker]');if(!picker)return;const target=state.picker?.thinking?picker.querySelector('[role=menuitemradio][aria-checked=true]:not(:disabled)')||picker.querySelector('[role=menuitemradio]:not(:disabled)')||picker.querySelector('[data-action=picker-close]'):state.picker?.actionsOnly?picker.querySelector('[role=menuitem]:not(:disabled)')||picker.querySelector('[data-action=picker-close]'):coarsePointer()?picker.querySelector('.is-current,[data-pick]')||picker.querySelector('#picker-search'):picker.querySelector('#picker-search');target?.focus({preventScroll:true});}
 // An agent's ⇄ key carries its role's scope too (F2): the key is found inside its own lane.
 function trayFocusSelector(el){const lane=el?.dataset.modeScope&&el.closest?.('.lane[data-role]');return el?.dataset.edit?`[data-edit="${CSS.escape(el.dataset.edit)}"][data-index="${el.dataset.index}"][data-group="${el.dataset.group}"]`:el?.dataset.modeScope?(lane?`.lane[data-role="${CSS.escape(lane.dataset.role)}"][data-lane-group="${CSS.escape(lane.dataset.laneGroup||'role')}"] `:'')+`[data-mode-scope="${CSS.escape(el.dataset.modeScope)}"]`:el?.dataset.poolOpen?'[data-pool-open]':'[data-action="mode-panel"]';}
 // Open or close an editor in the drawer. Opening lands the focus in the editor; closing returns it to the key (or the
 // CUT, the ⇄ mark) that opened it. The drawer then goes back to the collection if it was open, or slides away.
 function editTray(kind,open,opener){
  if(open&&opener)state.trayReturnFocus=trayFocusSelector(opener);
  state.poolPanel=open&&kind==='pool';state.modePanel=open&&kind==='alternatives';state.picker=null;state.cutTarget=null;state.armedCut=null;state.editorMsg='';
  if(open&&state.view!=='profiles')state.view='profiles';
  state.sourceLater=open;
  render();
  if(state.sourceLater)requestAnimationFrame(()=>{if(!state.sourceLater)return;state.sourceLater=false;if(editorKind())paintRegions([leaf('drawer/results',drawerResults(collectionCuts()))]);});
  if(open)win.querySelector(kind==='pool'?`#pool-tab-${state.poolTab||'free-good'}`:'#mode-alternatives')?.focus({preventScroll:true});
  else [...win.querySelectorAll(state.trayReturnFocus||(kind==='pool'?'[data-pool-open]':'[data-action="mode-panel"]'))].find(el=>el.getClientRects().length)?.focus({preventScroll:true});
 }
 const editHistory=new ForgeHistory();
 const poolNames={'free-good':'FREE GOOD','free-fast':'FREE FAST'},poolToken=name=>'mana-pool/'+name,poolName=route=>Object.keys(poolNames).find(name=>poolToken(name)===route);
 let poolOriginal=copy(source.freePools||{'free-good':[],'free-fast':[]}),poolDraft=copy(poolOriginal),poolRevision=source.poolsRevision;
 const poolsDirty=()=>JSON.stringify(poolDraft)!==JSON.stringify(poolOriginal);
 function poolStep(direction){if(state.saving)return;const value=editHistory.step('@free-pools',direction);if(value){poolDraft=value;state.picker=null;state.editorMsg=direction<0?'Останню дію з пулами скасовано':'Дію з пулами повторено';render();win.querySelector('[data-action='+ (direction<0?'pool-undo':'pool-redo') +']')?.focus({preventScroll:true});}}
 async function savePools(){
  if(state.saving||!poolsDirty())return;state.saving=true;state.poolError='';render();
  state.poolDiffs=null;
  try{const r=await api('/api/free-pools',{revision:poolRevision,pools:poolDraft});poolOriginal=copy(poolDraft);editHistory.reset('@free-pools',poolDraft);await reload(false,true);const n=r.scopes?.length;notify('Спільні пули збережено'+(n?' · оновлено '+n+' '+plural(n,'область','області','областей')+': '+r.scopes.map(scopeName).join(', '):' · файли не змінились'));}
  // A scope whose file changed outside Mana Tape blocks the machine-wide save: each one is named with its diff.
  catch(e){state.poolError=e.message;state.poolDerived=!!e.derived;state.poolDiffs=e.diffs&&e.scopes?e.diffs:e.derived?Object.fromEntries(Object.entries(e.derived).map(([label,d])=>[d.scope,{[label]:d}])):null;}
  finally{state.saving=false;render();}
 }
 // Pool keys on the deck: a stack of tapes with the pool's name and size; dragging or arming moves the whole pool.
 function poolShelf(){
  const keys=Object.entries(poolNames).map(([name,label])=>{const n=source.freePools?.[name]?.length||0,armed=state.armedCut===poolToken(name);return `<button type="button" class="key poolkey" data-cut="${poolToken(name)}"${armed?' aria-pressed="true"':''} ${n?'':'disabled'} title="${label} · обери пул і місце на доріжці або перетягни весь пул" aria-label="${label} · ${n} CUTS · спільний пул"><span class="key__cap"><span class="stack${name==='free-fast'?' stack--fast':''}" aria-hidden="true"></span><span class="key__txt"><b>${label}</b><span class="key__sub"><span class="rd rd--l" style="--rd:2ch">${n}</span> CUTS</span></span></span></button>`;}).join('');
  return `${keys}<button type="button" class="key" data-pool-open="free-good" aria-expanded="${!!state.poolPanel}" aria-controls="pool-editor"><span class="key__cap">${led(state.poolPanel,'orange')}Пули <span class="rd key__count" style="--rd:1ch">2</span></span></button><span class="silk silk--2 deck__note">спільні для всієї машини${poolsDirty()?' · є чернетка пулів':''}</span>`;
 }
 // Scope ids → their menu names (pools and apply results name scopes in words).
 function scopeName(id){const row=(source.projects||[]).find(x=>x.id===id);return row?row.kind==='global'?'глобальне':row.name:id;}
 // FREE pools are machine-wide (DESIGN «FREE GOOD / FREE FAST»): one save rewrites every scope that uses a pool block.
 function poolScopesNote(){const ids=source.poolScopes||[];return ids.length?'«Зберегти пули» оновить '+ids.length+' '+plural(ids.length,'область','області','областей')+': '+ids.map(scopeName).join(', '):'жодна область ще не використовує пули';}
 // Older installations kept pools per project; when those sets differ, the owner picks the one the machine keeps.
 function poolConflictMarkup(){
  const rows=source.poolConflict||[];if(!rows.length)return '';
  return `<div class="poolpick"><div class="msg" data-s="warn">${led(true,'amber')}<span>Старі пули проєктів різняться. Обери, які стануть спільними для всієї машини; інші лишаються у файлах стану проєктів, нічого не видаляється.</span></div>${rows.map(row=>`<div class="poolpick__row"><span class="poolpick__src"><b>${esc(row.sources.map(scopeName).join(', '))}</b><small>${Object.entries(poolNames).map(([k,l])=>l+' · '+(row.pools?.[k]?.length||0)).join(' · ')}</small></span>${key('Взяти ці пули','pool-adopt-legacy','key--sm',`data-source="${esc(row.sources[0])}"`)}</div>`).join('')}</div>`;
 }
 // EDITORS live in the drawer (DESIGN «FREE GOOD / FREE FAST», «Заміни»): its front becomes the editor's head
 // (orange LED, title, tabs or scope, the transport with its scope, ×) and its body holds the ordered list next to
 // the CUTS collection, which stays the source: a tap adds a CUT at the end, a drag puts it in place. One editor is
 // open at a time; closing or switching keeps every draft. The CUTS are the same CUT as on the lanes.
 function editorKind(){return state.poolPanel?'pool':state.modePanel?'alternatives':'';}
 function editorTarget(){const kind=editorKind();return kind==='pool'?{role:state.poolTab||'free-good',group:'pool'}:kind==='alternatives'?{role:state.modeScope||'profile',group:'alternatives'}:null;}
 // One reserved status line in the editor: the last tap/drop result, an error, or the list's state.
 function editorLine(s,text,title=''){return `<div class="msg tray__edmsg"${s?` data-s="${s}"`:''} role="${s==='bad'?'alert':'status'}"${title?` title="${esc(title)}"`:''}>${text?led(true,s==='bad'?'red':s==='warn'?'amber':'green'):''}<span>${esc(text)}</span></div>`;}
 function poolEditor(){
  const selected=state.poolTab||'free-good',list=poolDraft[selected],label=poolNames[selected],dirty=poolsDirty();
  const line=state.poolError?editorLine('bad',state.poolError):state.editorMsg?editorLine('ok',state.editorMsg):editorLine('',dirty?'Чернетка пулів · зберігається окремо від профілів':'');
  const diffs=state.poolError&&state.poolDiffs?`<div class="pooldiffs">${Object.entries(state.poolDiffs).map(([scope,files])=>Object.values(files).map(d=>`<div class="pooldiffs__row"><b>${esc(scopeName(scope))}</b>${diffStrip(d)}</div>`).join('')).join('')}<p class="print">${state.poolDerived?'Це не зміна пулів, а перекомпіляція тих областей проти поточного глобального файлу чи каталогу. «Зберегти пули» ще раз запише й це.':'Прийми файл у тій області («Прийняти файл» на її монтажі), потім збережи пули ще раз.'}</p></div>`:'';
  return `<div class="tray__editor" id="pool-editor" role="tabpanel" aria-labelledby="pool-tab-${selected}" tabindex="-1">${line}${diffs}${poolConflictMarkup()}<div class="tray__grid tray__grid--seq" id="pool-line-${selected}" role="list" aria-label="Порядок CUTS ${label}">${list.map((r,i)=>node(selected,r,i,list.length,'pool')).join('')}${socketKey(selected,list.length,'pool','CUT','Додати CUT у '+label)}</div><div class="tray__foot"><span class="print">${label} · ${list.length} CUTS · спільні для всієї машини · ${esc(poolScopesNote())} · порядок: перетягни, ⋯ або Shift ← / →</span>${key('Скинути','pool-reset','key--sm',(!dirty&&!state.poolError)||state.saving?'disabled':'')}</div></div>`;
 }
 function poolBlock(role,route,i,group){
  const name=poolName(route),sequence=group==='alternatives'||group==='pool',inherited=inheritedSlot(role,i,group),fixed=fixedSlot(role,i,group,inherited),alias=group==='vibe'&&i===0&&vibeAlias(role)?vibeAlias(role)+' · ':'',more=fixed?'':slotActionKey(role,i,group),fast=name==='free-fast',size=source.freePools?.[name]?.length||0;
  const classes=['cut','cut--pool',fast&&'cut--pool-fast',more&&'cut--more',fixed&&'cut--locked',savedChain(role,group)[i]!==route&&!inherited&&'is-changed'].filter(Boolean).join(' ');
  const note=INHERIT_NOTE[inherited]||'',where=fixed?'':` data-node-role="${esc(role)}" data-index="${i}" data-group="${group}"`;
  const nameTag=fixed?`<span class="cut__name" title="${esc(alias+poolNames[name]+(note?' · '+note:''))}">${esc(alias)}${poolNames[name]}</span>`:`<button type="button" class="cut__name" data-edit="${esc(role)}" data-index="${i}" data-group="${group}"${alias||note?` title="${esc(alias+poolNames[name]+(note?' · '+note:''))}"`:''} aria-label="Відкрити ${poolNames[name]}: спільний пул, ${size} CUTS${note?' · '+note:''}">${esc(alias)}${poolNames[name]}</button>`;
  return `<div class="${classes}"${sequence?' role="listitem"':''} data-clip-key="${clipKey(role,route,i,group)}"${where}${inherited?` data-inherited="${inherited}"`:''} style="--li:${laneIndex(role,group)}">${sourceTab(role,i,group,inherited)}<span class="cut__edge"></span>${nameTag}<span class="cut__meta"><span class="stack${fast?' stack--fast':''}" aria-hidden="true"></span><span>${size} CUTS · спільний</span></span>${more}</div>`;
 }
 // What an inherited CUT says in its tooltip and accessible name.
 const INHERIT_NOTE={default:'резерв успадковано з default',global:'з глобального · зміна стане перевизначенням у проєкті',scope:'резерв області · змінюй у Standard'};
 // A CUT that cannot be edited here: the reserves a котушка shows from its scope, or any CUT of a Global котушка
 // seen from a project. It is printed tape: no key, no ⋯, no drag, no drop.
 function fixedSlot(role,index,group,inherited=inheritedSlot(role,index,group)){return (group==='role'||group==='vibe')&&(locked()||inherited==='scope');}
 // The first CUT of an inherited run carries a small printed tab on its top edge: «з глобального», «резерви області».
 function sourceTab(role,i,group,inherited){if(inherited!=='global'&&inherited!=='scope'||i>0&&inheritedSlot(role,i-1,group)===inherited)return '';return `<span class="cut__src" aria-hidden="true">${inherited==='global'?'з глобального':'резерви області'}</span>`;}
 // The lane key's source LED and print (DESIGN «Області і котушки»): green — this file holds the lane; blue — the
 // Global config a project inherits; orange — a котушка's own primary; off — OMP's default (no print). In a project the
 // print names it in words (colour is never alone); a lane that mixes both says so.
 function laneSource(role,group='role'){
  const own=p(),g=globalLayer,vibe=group==='vibe';
  if(presetLike())return vibe?{c:'',text:''}:own.modelRoles[role]?{c:'orange',text:locked()?'глоб. котушка':'котушка'}:{c:'',text:'не в котушці'};
  if(state.profile!=='standard'&&(vibe?Object.hasOwn(source.presets?.[state.profile]?.task?.agentModelOverrides||{},role):Object.hasOwn(source.presets?.[state.profile]?.modelRoles||{},role)||Object.hasOwn(source.presets?.[state.profile]?.retry?.fallbackChains||{},role)))return {c:'orange',text:'стара котушка'};
  const has=vibe?Object.hasOwn(own.task.agentModelOverrides,role):!!own.modelRoles[role]||Object.hasOwn(own.retry.fallbackChains,role);
  if(!g)return {c:has?'green':'',text:''};
  const list=chain(role,group),fromGlobal=list.some((r,i)=>inheritedSlot(role,i,group)==='global');
  if(has)return {c:'green',text:fromGlobal?'проєкт + глоб.':'проєкт'};
  return fromGlobal?{c:'blue',text:'з глобального'}:{c:'',text:''};
 }
 // Lane actions of a project (DESIGN «Області і котушки»), by value path: what the project holds itself (`own`),
 // what the Global config holds (`up`), and what an override would copy from it (`inherit`). Null outside a project's
 // Standard: a котушка and an old котушка do not hold scope values; the Global scope has no parent.
 function laneLayers(role,group='role'){
  if(!globalLayer||state.profile!=='standard'||locked())return null;
  const has=(data,path)=>{const parent=path.slice(0,-1).reduce((o,k)=>o?.[k],data),v=parent?.[path.at(-1)];return parent!=null&&Object.hasOwn(parent,path.at(-1))&&v!=null&&!(path[0]==='modelRoles'&&!v);};
  const paths=group==='vibe'?[['task','agentModelOverrides',role]]:[['modelRoles',role],['retry','fallbackChains',role]];
  const own=paths.filter(path=>has(p(),path)),up=paths.filter(path=>has(globalLayer,path));
  return {paths,own,up,inherit:up.filter(path=>!has(p(),path))};
 }
 function laneMenuAvailable(role,group){const l=laneLayers(role,group);return !!l&&(l.own.length>0||l.inherit.length>0);}
 // FREE GOOD / FREE FAST are tabs of one editor: the drawer keeps its place, only the list and the counts change.
 function selectPoolTab(name,focusTab=true){if(!poolNames[name])return;state.poolTab=name;state.picker=null;state.cutTarget=null;state.armedCut=null;state.editorMsg='';render();if(focusTab)win.querySelector(`[data-pool-tab="${name}"]`)?.focus({preventScroll:true});}
 root.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b||state.saving)return;if(b.dataset.poolOpen)editTray('pool',!state.poolPanel,b);if(b.dataset.poolTab){selectPoolTab(b.dataset.poolTab);}if(b.dataset.action==='pool-close')editTray('pool',false);if(b.dataset.action==='pool-save')savePools();if(b.dataset.action==='pool-reset'){try{await reload();poolOriginal=copy(source.freePools);poolDraft=copy(poolOriginal);poolRevision=source.poolsRevision;editHistory.reset('@free-pools',poolDraft);state.poolError='';state.poolDiffs=null;state.editorMsg='Пули скинуто до збережених';render();win.querySelector('#pool-editor')?.focus({preventScroll:true});}catch(error){state.poolError=error.message;render();}}if(b.dataset.action==='pool-undo'||b.dataset.action==='pool-redo')poolStep(b.dataset.action==='pool-undo'?-1:1);if(b.dataset.action==='pool-adopt-legacy'){state.saving=true;render();try{await api('/api/free-pools',{action:'adopt-legacy',source:b.dataset.source});await reload();poolOriginal=copy(source.freePools);poolDraft=copy(poolOriginal);poolRevision=source.poolsRevision;editHistory.reset('@free-pools',poolDraft);state.poolError='';state.editorMsg='Спільні пули взято з '+scopeName(b.dataset.source);}catch(error){state.poolError=error.message;}finally{state.saving=false;render();}}if(b.dataset.action==='replace-pool'){state.picker.actionsOnly=false;render();focusPicker();}});

 function clipKey(role,r,i,group){return esc(group+'|'+role+'|'+r+'|'+chain(role,group).slice(0,i).filter(v=>v===r).length);}
 function historyStep(direction){if(state.saving)return;const value=editHistory.step(state.profile,direction);if(!value)return;profiles[state.profile]=value;ForgeTape.intent(direction<0?'undo':'edit');state.picker=null;state.editorMsg='';state.opFeedback=direction<0?'Останню дію скасовано.':'Дію повторено.';render();win.querySelector(`[data-action=${direction<0?'undo':'redo'}]`)?.focus({preventScroll:true});}
 function p(){return profiles[state.profile];}
 function workers(profile=p()){return [...new Set([...knownAgents().map(a=>a.id),...Object.keys(eff(profile)?.task?.agentModelOverrides||{})])];}
 function agentValues(worker,profile=p()){return asList(eff(profile).task?.agentModelOverrides?.[worker]);}
 function agentLink(worker){const values=agentValues(worker);return values.length===1&&values[0].startsWith('@')?values[0]:'';}
 function agentTier(worker){return ({task:'Vibe GOOD',sonic:'Vibe FAST'})[worker]||'';}
 // An agent's lane key: ↳, native id and a printed sub-line (Vibe tier, file source, own list); LED blue = own list.
 function agentSub(worker,own=false){const origin=agentSource(worker);return [agentTier(worker),origin&&origin+(agentInfo(worker)?.overrides?' · замінює штатного':''),own&&'власний список'].filter(Boolean).join(' · ');}
 function agentName(worker,own=false){const sub=agentSub(worker,own);return `<span class="lane__label"><span class="lane__name">${esc(worker)}</span>${sub?`<span class="lane__sub">${esc(sub)}</span>`:''}</span>`;}
 // A name or note that the key cuts with an ellipsis keeps its full text in the tooltip (F6): a 156-px key shows
 // about 11 characters of the name and 14 of the note.
 function agentKey(worker,own=false,title=''){
  const src=laneSource(worker,'vibe'),sub=[agentSub(worker,own),src.text].filter(Boolean).join(' · '),full=worker.length>11||sub.length>14?[worker,sub].filter(Boolean).join(' · '):'';title=[full,title].filter(Boolean).join(' · ');
  const inner=`<span class="lane__idx" aria-hidden="true">↳</span><span class="lane__label"><span class="lane__name">${esc(worker)}</span>${sub?`<span class="lane__sub">${esc(sub)}</span>`:''}</span>${led(!!src.c,src.c||'green')}`;
  return laneMenuAvailable(worker,'vibe')?`<button type="button" class="lane__key" data-lane-menu="${esc(worker)}" data-group="vibe" aria-haspopup="menu" aria-expanded="false" aria-label="${esc('Агент '+worker+(src.text?' · '+src.text:'')+' · дії області')}"${title?` title="${esc(title)}"`:''}>${inner}</button>`:`<div class="lane__key"${title?` title="${esc(title)}"`:''}>${inner}</div>`;
 }
 // An override for an agent that is in no file: a red-LED eject key in the lane's tool cluster, never a pill in the tape.
 function agentRemove(worker){return !agentInfo(worker)&&Object.hasOwn(p().task.agentModelOverrides||{},worker)?key(led(true,'red')+'Прибрати','','key--sm key--danger',`data-reset-agent="${esc(worker)}" aria-label="Прибрати перевизначення агента, якого немає у файлах: ${esc(worker)}" title="Агента немає серед штатних і файлів .omp/agents. Перевизначення лишилося в конфігурації."`):'';}
 // The lane's reset in words: «Типово в OMP», or in a project's own value «Як у глобальному», or a котушка's
 // «Не в котушці». '' where this file cannot drop the value (a project only inherits it; a Global котушка).
 function laneResetLabel(role,group){
  if(locked())return '';
  const vibe=group==='vibe',own=p();
  if(isNative(state.profile))return !vibe&&own.modelRoles[role]?'Не в котушці':'';
  const has=vibe?Object.hasOwn(own.task.agentModelOverrides,role):!!own.modelRoles[role];
  if(globalLayer&&state.profile==='standard'){if(!has)return '';if(globalHas(role,group))return 'Як у глобальному';}
  return vibe?agentInfo(role)&&agentValues(role).length?'Типово в OMP':'':roleInfo(role)&&has?'Типово в OMP':'';
 }
 // A patch key replaces the old «До ролі ↗» link: it scrolls to the role's lane and blinks its LED.
 function patchKey(role,label,aria){return `<button type="button" class="key patch" data-agent-role="${esc(role)}" aria-label="${esc(aria)}"><span class="key__cap"><span class="jack" aria-hidden="true"></span>${esc(label)}</span></button>`;}
 function agentLinkedTrack(worker){
  const alias=agentLink(worker),[role,effort]=alias.slice(1).split(':'),known=roleKeys.includes(role),retry=eff().retry?.modelFallback!==false;
  const detail=known?`Основна${retry?' й резерви ролі':' · резерви вимкнено'}${effort?' · thinking '+effort:''}`:'Модель і резерви визначає OMP';
  const link=known?patchKey(role,alias,worker+': успадковує '+alias+' · '+detail+'. Редагувати роль '+role):`<span class="chip" title="${esc('Успадковує '+alias)}">${esc(alias)}</span>`;
  const own=known&&!effort&&!locked()?key('Власний список','','key--sm',`data-agent-copy="${esc(worker)}" aria-label="Створити власний список: ${esc(worker)}" title="Копіювати роль для окремого монтажу агента. Зміни ролі більше не впливатимуть на цей список."`):'';
  const label=laneResetLabel(worker,'vibe'),reset=label?key(label,'','key--sm',`data-reset-agent="${esc(worker)}" aria-label="${esc(label==='Як у глобальному'?'Повернути глобальне значення для агента: '+worker:'Повернути типовий вибір OMP для агента: '+worker)}"`):agentRemove(worker);
  return `<div class="lane lane--inherit lane--link" data-agent="${esc(worker)}">${agentKey(worker,false)}<div class="lane__groove">${link}<span class="lane__note"><b>Успадковує ${esc(alias)}</b> · ${esc(detail)}</span><span class="lane__tools">${own}${reset}</span></div></div>`;
 }
 function agentListNote(worker){const values=agentValues(worker),alias=vibeAlias(worker),single=values.length===1&&!poolName(values[0]);return `Власний список${alias?' · основна з '+alias:''}${single&&!alias?' · резерви з default':' · CUTS за порядком'}${eff().retry?.modelFallback===false?' · резерви вимкнено':''}`;}
 function agentDefaultTrack(worker){
  const info=agentInfo(worker),alias=agentModelAlias(info),role=alias.slice(1).split(':')[0],known=roleKeys.includes(role);
  const model=isCustomAgent(info)&&!info.model?'модель сесії':agentModelText(info)||'обрати CUT';
  const note=`<span class="lane__note" title="${esc(info?.description||'')}">${esc(shortText(info?.description||'Модель визначає OMP',140))}${isCustomAgent(info)?' · '+esc(agentModelText(info)):''}</span>`;
  return `<div class="lane lane--inherit">${agentKey(worker,false)}<div class="lane__groove"><div class="leader"><b>Типово в OMP</b><small>· ${esc(model)}</small></div>${known?patchKey(role,alias.split(':')[0],worker+': редагувати роль '+role):''}${note}${socketKey(worker,0,'vibe','кандидат','Обрати CUT для агента: '+worker)}</div></div>`;
 }
 // «Агенти»: a printed subhead on the bed; the sync option is a latching key with an LED, not a web checkbox.
 function agentSectionHead(){const warn=source.agentWarnings?.length;return `<div class="subhead"><span class="silk">Агенти</span><span class="print">прив’язки до ролей або власні списки</span>${warn?`<span class="chip chip--warn" role="status" title="${esc(source.agentWarnings.join('\n'))}">пропущено файлів агентів: ${warn}</span>`:''}<span class="subhead__rule"></span><button type="button" class="key key--sm" data-sync-vibe aria-pressed="${!!state.syncVibe}" title="Після зміни резервів ролі оновлює власні списки агентів із початковим @role, які до зміни точно повторювали ці резерви. Списки з власними CUTS не змінюються. Успадковані ролі оновлюються завжди. Увімкнення саме по собі не змінює списків."><span class="key__cap">${led(state.syncVibe,'green')}Копіювати резерви після змін ролей</span></button></div>`;}
 // A patch key scrolls the role's lane into the page area above the drawer and blinks its LED.
 function focusAgentRole(role){
  state.role=role;state.picker=null;const fold=laneGroups().find(g=>g.fold?.includes(role))?.fold;if(fold&&!foldOpen(fold)){fold.forEach(r=>openFolds.add(r));storeFolds();}
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
  if(counts.includes(1)&&eff().retry?.fallbackChains?.default?.length){notify('Для одного CUT у власному списку OMP додасть резерви default. Щоб зберегти поточну поведінку, залиш прив’язку або спочатку додай резерв до ролі.');return;}
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
 function modeBody(name=state.profile){return {profile:name,revision:baseRevision(name),changes:diff(name).filter(c=>!c.path[0].startsWith('forge')),modeSettings:copy(modeSettings(name))};}
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
  if(locked())return;
  if(!diff(state.profile).length&&!state.modePanel&&!state.modeRefresh?.[state.profile])return;
  const name=state.profile,key=modeKey(name);state.modePlans??={};
  if(state.modePlans[name]?.key===key)return;
  const pending={key,pending:true,previous:state.modePlans[name]?.data||state.modePlans[name]?.previous||source.profileModes?.[name]};state.modePlans[name]=pending;
  const body=modeBody(name);
  // Let the current render finish before a response can repaint it.
  Promise.resolve().then(async()=>{
   let result;
   try{result={key,data:await api('/api/profile-preview',body)};}
   // A stale revision is found now, not at the next 15-s poll: the reload rebases the draft or marks the conflict.
   catch(e){result={key,error:e.message};if(e.code==='revision'){backgroundRefreshPending=true;scheduleBackgroundWork();}}
   if(state.modePlans[name]!==pending)return;
   if(interactionBusy(true)){pendingModeResults.set(name,result);scheduleBackgroundWork();return;}
   state.modePlans[name]=result;
   if(state.profile===name)render();
  });
 }
 function modeTag(role,group='role'){
  const v=modeView(role,group);if(!v?.paused?.length&&!v?.substituted)return '';
  const scope=modeScope(role,group),count=v.paused.length;
  return `<button type="button" class="key key--sm lane__mode" aria-label="Заміни DeepSeek: ${esc(role)}" data-mode-scope="${esc(scope)}" title="${esc(v.substituted?'Замість '+v.original:count+' '+plural(count,'входження','входження','входжень')+' DeepSeek призупинено')}"><span class="key__cap">${v.substituted?'⇄':'−'+count}</span></button>`;
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
  const bars=[];for(let t=Math.floor(start/hour)*hour;t<end;t+=hour){const from=Math.max(t,start),to=Math.min(t+hour,end),p=peak(t);bars.push(`<i class="${p?'pk':''}${to<=now?' past':''}" style="--l:${pct((from-start)/span)}%;--w:${pct((to-from)/span)}%"></i>`);}
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
  return [box('p/mode-slide',`<button type="button" class="slide" role="switch" data-profile-mode="${modeOff()?'deepseek':'no-deepseek'}" aria-checked="${!modeOff()}" aria-label="DeepSeek у профілі: ON — оригінал, OFF — заміни" title="${locked()?'Глобальна котушка: режим змінюють в області «Глобально»':modeOff()?'Увімкнути DeepSeek · повернути на доріжки':'Вимкнути платний DeepSeek · FREE CUTS залишаються'}" ${state.saving||locked()?'disabled':''}>`,[leaf('p/mode-slide/face',SLIDE_FACE)]),
   leaf('p/mode-keys',`<button type="button" class="key" data-action="mode-panel" aria-expanded="${!!state.modePanel}" aria-controls="mode-alternatives" aria-label="Заміни DeepSeek · ${settings.alternatives.length} CUTS"${locked()?' disabled':''}><span class="key__cap">${led(!!state.modePanel,'orange',' data-latch')}Заміни <span class="rd key__count" style="--rd:2ch">${settings.alternatives.length}</span></span></button>${key(SVG.refresh,'mode-refresh','key--sq','aria-label="Перевірити доступність і оновити заміни" title="Перевірити доступність і оновити заміни"'+(modeOff()?'':' disabled'))}`),
   leaf(id+'/grow','<span class="strip__grow"></span>'),leaf(id+'/enc',hueEncoder(id,'DeepSeek',SCREEN_HUE.ds))];
 }
 // Problems that are not the DeepSeek mode's own line: preview blockers without a DeepSeek screen, outside edits
 // of profile files (with «Прийняти файл»), skipped presets and an interrupted save journal.
 function deckNotices(dsScreen){
  const plan=activePlan(),issues=plan?.data?.issues||[],rows=[];
  const line=(s,c,text,title='',tools='',strip='')=>`<div class="notice"><div class="msg" data-s="${s}" role="${s==='bad'?'alert':'status'}"${title?` title="${esc(title)}"`:''}>${led(true,c)}<span>${text}</span>${tools?`<span class="notice__tools">${tools}</span>`:''}</div>${strip}</div>`;
  if(!dsScreen&&plan?.error)rows.push(line('bad','red',esc(plan.error)));
  if(!dsScreen&&issues.length)rows.push(line('bad','red',esc(issues.map(i=>i.key.replace('role:','')+': '+i.message).join(' · '))));
  if(source.modeRecovery)rows.push(line('bad','red',esc(source.modeRecovery.error||'Незавершене збереження режимів'),(source.modeRecovery.files||[]).join('\n')));
  // A scope file that is a symbolic link (dotfiles) is shown but never written; other scopes are not affected.
  if(source.scope?.readOnly)rows.push(line('warn','amber',`Лише перегляд · <b>${esc(source.scope.readOnly.file||'')}</b> — символьне посилання`,source.scope.readOnly.error||''));
  // An outside edit (OMP, an editor): what changed, right beside «Прийняти файл» (DESIGN «Області і котушки»).
  for(const name of source.modeConflicts||[]){
   const d=source.modeConflictDiffs?.[name],what=name==='standard'?(source.scope?.kind==='global'?'Глобальний файл':'Файл області'):'Файл котушки '+prettyProfile(name);
   rows.push(line('bad','red',`${esc(what)} <b>${esc(d?.file||prettyProfile(name))}</b> змінено поза Mana Tape · збереження заблоковане, файл не перезаписується`,'Прийняти файл як є: режим DeepSeek стане ON, збережені заміни лишаться для наступного OFF. Попередня версія Mana Tape після цього доступна через «Попереднє збереження».',key('Прийняти файл','adopt-profile','key--sm',`data-adopt="${esc(name)}"`),diffStrip(d)));
  }
  for(const name of source.modeOrphans||[])rows.push(line('warn','amber',`Файл профілю <b>${esc(prettyProfile(name))}</b> видалено поза Mana Tape · запис режиму лишився`,'Прийняти видалення: Mana Tape забуде запис режиму цього профілю (його копія лишиться в резервних).',key('Прийняти видалення','adopt-profile','key--sm',`data-adopt="${esc(name)}"`)));
  if(source.profileWarnings?.length)rows.push(line('warn','amber',`Пропущено пресети: ${esc(source.profileWarnings.map(w=>w.split(':')[0]).join(', '))}`,source.profileWarnings.join('\n')));
  // Old .omp/presets files: one line each until the owner moves or archives them (nothing happens on its own).
  for(const name of source.legacyPresets||[])rows.push(line('warn','amber',`Стара котушка <b>${esc(name)}</b> · <code>.omp/presets/${esc(name)}.yml</code> · OMP читає її лише через --config`,'Перенести в нативну котушку OMP (modelPresets) або архівувати. План покаже, що перейде; без підтвердження нічого не змінюється.',key('Перенести…','migrate-open','key--sm',`data-migrate="${esc(name)}"`)));
  if(source.modelChains?.length)rows.push(line('warn','amber',`Ланцюги за моделлю: <b>${esc(source.modelChains.join(', '))}</b> · OMP бере їх раніше за ланцюг ролі; монтаж показує ланцюги ролей`,'retry.fallbackChains з ключем-моделлю має перевагу над ланцюгом ролі, де ця модель стоїть.'));
  return rows.length?`<div class="deck__notices">${rows.join('')}</div>`:'';
 }
 function alternativeCut(key,route,i){return node(key,route,i,modeList(key).length,'alternatives');}

 // Replacements in the drawer: numbered CUTS in priority order (left to right, then the next row), the preview's
 // state on one reserved line, and every CUT the preview had to skip marked in place with its reason.
 function modeScopes(){const settings=modeSettings();return [['profile','Увесь профіль'],...roleKeys.map(r=>['role:'+r,r+' · '+(labels[r]||r)]),...workers().map(w=>['vibe:'+w,'Агент '+w])].map(([k,t])=>[k,t+(Object.hasOwn(settings.overrides,k)?' · власні':'')]);}
 // One row per skipped CUT and reason; `keys` names every lane where the preview skipped it.
 function modeSkipped(key=state.modeScope||'profile'){const plan=activePlan(),preview=plan?.data||(plan?.pending?plan.previous:null),rows=new Map();for(const x of preview?.skipped||[]){if(key!=='profile'&&x.key!==key)continue;const id=x.route+'|'+x.reason,row=rows.get(id)||{...x,keys:[]};if(x.key&&!row.keys.includes(x.key))row.keys.push(x.key);rows.set(id,row);}return [...rows.values()];}
 function modePanel(){
  const scopeKey=state.modeScope||'profile',settings=modeSettings(),list=modeList(scopeKey),own=scopeKey!=='profile'&&Object.hasOwn(settings.overrides,scopeKey);
  const alias=scopeKey.startsWith('vibe:')?vibeAlias(scopeKey.slice(5)):'',plan=activePlan(),skipped=modeSkipped(scopeKey),dirty=diff(state.profile).length>0;
  const issue=(plan?.data?.issues||[]).find(i=>scopeKey==='profile'||i.key===scopeKey);
  const line=plan?.error?editorLine('bad',plan.error):issue?editorLine('bad',issue.key.replace('role:','')+': '+issue.message):state.editorMsg?editorLine('ok',state.editorMsg):plan?.pending?editorLine('warn','Розрахунок замін…'):skipped.length?editorLine('warn','Пропущено під час розрахунку · '+skipped.length,skipped.map(x=>cutTitle(x.route)+' — '+x.reason).join('\n')):editorLine(dirty?'warn':'ok',(modeOff()?'OFF · заміни на доріжках':'ON · заміни чекають OFF')+(dirty?' · не збережено':' · збережено'));
  const scopeNote=scopeKey==='profile'?'спільний порядок профілю':own?'власний порядок':'порядок профілю';
  const body=alias?`<div class="empty"><span class="empty__glyph" aria-hidden="true">@</span><span>Агент бере основну модель з <b>${esc(alias)}</b>. Заміни налаштовуються в цій ролі.</span><button type="button" class="key key--sm" data-action="mode-alias-scope" data-alias-scope="role:${esc(alias.slice(1))}"><span class="key__cap">Заміни для ${esc(alias)}</span></button></div>`
   :`<div class="tray__grid tray__grid--seq" role="list" aria-label="Пріоритет CUTS замін · ${esc(scopeNote)}">${list.map((route,i)=>alternativeCut(scopeKey,route,i)).join('')}${list.length>=12?'':socketKey(scopeKey,list.length,'alternatives','CUT','Додати CUT у заміни')}</div>`;
  return `<div class="tray__editor" id="mode-alternatives" role="region" aria-label="Заміни DeepSeek · ${esc(scopeNote)}" tabindex="-1">${line}${body}<div class="tray__foot"><span class="print print--hint">${esc(scopeNote)} · OFF ставить їх на місце першого платного DeepSeek · FREE лишаються · ліміти не впливають · дублікати й несумісні пропускаються · далі звичайні резерви</span>${own?key('Як у профілі','mode-reset-scope','key--sm'):''}</div></div>`;
 }
 root.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b||state.saving)return;
  if(b.dataset.profileMode){if(locked())return;state.poolPanel=false;modeSettings().mode=b.dataset.profileMode;state.picker=null;state.opFeedback='';state.editorMsg='';render();return;}
  if(b.dataset.modeScope){state.modeScope=b.dataset.modeScope;editTray('alternatives',true,b);return;}
  const a=b.dataset.action;
  if(a==='mode-panel'){state.modeScope='profile';editTray('alternatives',!state.modePanel,b);}
  if(a==='mode-close')editTray('alternatives',false);
  if(a==='mode-alias-scope'){state.modeScope=b.dataset.aliasScope;render();}
  if(a==='mode-reset-scope'){delete modeSettings().overrides[state.modeScope];state.editorMsg='';render();}
  if(a==='mode-refresh'){state.modeRefresh={...state.modeRefresh,[state.profile]:(state.modeRefresh?.[state.profile]||0)+1};state.editorMsg='';render();}
  if(a==='make-permanent'){const text=pinReplacement(state.picker);if(text){closePicker();notify(text);}}
 });
 // «Закріпити» (QA1 B3): the ⇄ CUT takes the place of the DeepSeek it stands in for — never another primary — and
 // stands once in the lane. A role goes through the normal lane edit (thinking, role kinds, agent sync). An agent
 // never rewrites its @role: a substituted @role head becomes the agent's own primary. Returns the line to print.
 function pinReplacement(x){
  const route=chain(x.role,x.group)[x.index],scope=modeScope(x.role,x.group),view=modeView(x.role,x.group),raw=split(route).raw;
  const base=x.group==='vibe'?agentValues(x.role):baseChain(x.role),aliasHead=x.group==='vibe'&&x.index===0&&!!view?.alias&&!!view.substituted,host=aliasHead?0:view?.paused?.[0]?.index??0;
  const next=[...base];next[host]=route;const list=next.filter((r,i)=>i===host||split(resolveAlias(r)).raw!==raw),at=list.indexOf(route);
  if(x.group==='vibe'){state.opFeedback='';p().task.agentModelOverrides[x.role]=list;}else if(!setChain(x.role,list,'role',{base:true}))return '';
  if(scope===x.group+':'+x.role&&!list.some(r=>deepseek(resolveAlias(r))))delete modeSettings().overrides[scope];
  return aliasHead?'Тепер це власна основна модель агента '+x.role+'. Роль не змінена.':'Закріплено на місці DeepSeek · '+(x.group==='vibe'?'агент ':'')+x.role+' · '+(at===0?'основна':'резерв '+at);
 }
 root.addEventListener('change',e=>{if(e.target.id==='mode-scope'){state.modeScope=e.target.value;state.editorMsg='';render();}});

 function short(id){return String(id).replaceAll('-',' ');}
 function cutTitle(route){const m=split(route);return ManaOperator.displayModelName(m.id,catalogMap.get(m.raw)?.name);}
 function deletedCut(route){return catalogMap.get(split(route).raw)?.status==='missing';}
 function aliasRole(alias){return String(alias||'').slice(1).split(':')[0];}
 // `@role` and `@role:effort` follow the role's primary; an unknown role stays visible as written.
 function resolveAlias(value,profile=p()){if(typeof value!=='string'||!value.startsWith('@'))return value;const [role,effort]=value.slice(1).split(':'),route=eff(profile).modelRoles?.[role];return !route?value:effort&&!poolName(route)?split(route).raw+':'+effort:route;}
 function baseChain(role,group='role'){if(group==='vibe')return agentValues(role).map(s=>resolveAlias(s));const head=eff().modelRoles[role];return head?[head,...roleFallbacks(role)]:[];}
 function vibeAlias(worker){const v=eff().task.agentModelOverrides[worker],head=Array.isArray(v)?v[0]:v;return typeof head==='string'&&head.startsWith('@')?head:'';}
 // Fallbacks inherited from `default` are drawn on the lane but are not its own chain.
 function inheritsDefault(role,profile=p()){const L=eff(profile);return role!=='default'&&!!L.modelRoles[role]&&!Object.hasOwn(L.retry.fallbackChains,role)&&roleInfo(role)?.defaultFallbacks!==false&&!!L.retry.fallbackChains.default?.length;}
 // Where a lane CUT comes from when this file does not hold it (DESIGN «Області і котушки»): 'global' — the Global
 // config a project inherits; 'default' — this file's own `default` reserves; 'scope' — the reserves a котушка shows
 // from its scope (a native preset carries primaries only, so they are locked there); '' — this file's own CUT or a
 // DeepSeek replacement (the mode's).
 function inheritedSlot(role,index,group='role'){
  if(group!=='role'&&group!=='vibe')return '';
  const view=modeView(role,group),ref=view?.refs?.[index];
  if(view?.refs&&ref?.kind!=='base')return '';
  const at=view?.refs?ref.index:index,own=p(),g=globalLayer,preset=presetLike();
  if(group==='vibe')return g&&!preset&&!Object.hasOwn(own.task.agentModelOverrides,role)&&globalHas(role,'vibe')?'global':'';
  if(at===0)return g&&!preset&&!own.modelRoles[role]&&g.modelRoles[role]?'global':'';
  if(preset)return 'scope';
  if(Object.hasOwn(own.retry.fallbackChains,role))return '';
  if(g&&Object.hasOwn(g.retry.fallbackChains,role))return 'global';
  if(!inheritsDefault(role))return '';
  return g&&!Object.hasOwn(own.retry.fallbackChains,'default')?'global':'default';
 }
 // One lane edit written into this file's own layer. A project writes only what differs from what it inherits (a
 // value it already holds stays its own); a котушка holds only the primary.
 function oldSetChain(role,list,group='role'){
  if(group==='vibe'){writeAgent(role,agentFromResolved(role,list));return;}
  const own=p(),L=eff(own),configured=!!L.modelRoles[role],tail=list.slice(1),before=roleFallbacks(role);
  if(Object.hasOwn(own.modelRoles,role)||list[0]!==L.modelRoles[role])own.modelRoles[role]=list[0];
  if((configured||tail.length)&&JSON.stringify(tail)!==JSON.stringify(before))own.retry.fallbackChains[role]=tail;
 }
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
  const before=agentValues(worker),own=p().task.agentModelOverrides,up=globalLayer?.task.agentModelOverrides?.[worker];
  if(Object.hasOwn(own,worker)||JSON.stringify(values)!==JSON.stringify(up===undefined?undefined:asList(up)))own[worker]=values;
  if(values.length===1&&values[0].startsWith('@')&&!(before.length===1&&before[0]===values[0]))chainNotes.push(worker+' тепер успадковує '+values[0]+' разом із резервами ролі');
 }
 function options(value,raw){const m=catalogMap.get(raw);const levels=Array.isArray(m?.thinking)&&m.thinking.length?['',...new Set(['off',...m.thinking])]:m?.reasoning===false?['','off']:['','off','minimal','low','medium','high','xhigh','max'];if(value&&!levels.includes(value))levels.push(value);return levels.map(e=>`<option value="${esc(e)}" ${e===value?'selected':''}>${esc(e||'типово')}</option>`).join('');}
 // Thinking on the tape: a small key that prints the level (24px target) and opens ONE shared thinking menu; a
 // native <select> per CUT cost ≈23 UA-shadow nodes each (39% of the page at owner scale, QA4 P0-1). Omitted where
 // the role has no thinking.
 function thinkSelect(m,role,i,group,label){const id=group==='alternatives'&&String(role).startsWith('role:')?role.slice(5):role;if(group!=='vibe'&&group!=='pool'&&roleInfo(id)?.thinking===false)return '';const level=m.effort||'типово';return `<button type="button" class="cut__think" data-effort-role="${esc(role)}" data-index="${i}" data-group="${group}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc((label||'Thinking')+': '+level)}" title="Thinking · ${esc(level)}">${esc(level)}</button>`;}
 function providerName(id){return providerNames[id]||source.providers.find(v=>v.id===id)?.name||id;}
 // Role search marks CUTS in place (QA4 P0-3): a keystroke toggles .is-match on the CUTS already on screen and never
 // rebuilds a lane. Region strings carry no match state; settleRegions() marks the CUTS a patch inserts.
 function routeSearchText(route){const memo=routeSearchText.memo??=new Map(),key=dataVersion+'|'+route;let text=memo.get(key);if(text==null){const m=split(route);text=searchText([m.id,catalogMap.get(m.raw)?.name,short(m.id)].join(' '));if(memo.size>4000)memo.clear();memo.set(key,text);}return text;}
 function markMatches(scopes=[win]){
  const words=queryWords(state.query);if(!words.length&&!markMatches.on)return;
  for(const scope of scopes)for(const el of scope.matches?.('.cut[data-route]')?[scope]:scope.querySelectorAll('.cut[data-route]')){const on=!!words.length&&matchesWords(words,routeSearchText(el.dataset.route));if(el.classList.contains('is-match')!==on)el.classList.toggle('is-match',on);}
  if(scopes.length===1&&scopes[0]===win)markMatches.on=!!words.length;else if(words.length)markMatches.on=true;
 }
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
 function savedChain(role,group='role'){
  if(group==='pool')return poolOriginal[role];
  if(group==='alternatives')return original[state.profile].forgeMode.overrides[role]||original[state.profile].forgeMode.alternatives;
  const profile=original[state.profile],view=profile.forgeMode?.mode==='no-deepseek'?source.profileModes?.[state.profile]?.views?.[group]?.[role]:null;
  if(view?.routes)return view.routes;
  if(group==='vibe')return agentValues(role,profile).map(v=>resolveAlias(v,profile));
  const head=eff(profile).modelRoles[role];return head?[head,...roleFallbacks(role,profile)]:[];
 }
 // Provider identity on the tape: the edge colour and the code chip. Local GPU, FREE-only and DeepSeek providers
 // have fixed identities; any other provider gets a stable slot from its id. The chip always prints the real code.
 // A code with its own token keeps it (STU → stu, CLD → cld); everyone else takes the first free slot in the
 // order of their ids, and only when every slot is taken falls back to a stable hash.
 function providerSlot(provider){
  if(isLocal(provider))return 'gpu';
  let memo=providerSlot.memo;
  if(memo?.version!==dataVersion||!memo.map.has(provider))memo=providerSlot.memo={version:dataVersion,map:assignSlots([...new Set([...(memo?.version===dataVersion?memo.map.keys():[]),...source.providers.map(v=>v.id),...catalog.map(m=>m.provider),provider])].sort())};
  return memo.map.get(provider);
 }
 function assignSlots(ids){
  const slots=['stu','cld','p5','p6','p7'],map=new Map(),used=new Set(),models=new Map();
  for(const m of catalog){const row=models.get(m.provider)||{n:0,free:0};row.n++;if(priceInfo(m).kind==='free')row.free++;models.set(m.provider,row);}
  const fixed=id=>{if(isLocal(id))return 'gpu';if(/deepseek/i.test(id))return 'ds';const row=models.get(id);if(row?.n&&row.free===row.n)return 'free';const token=String(providerCode(id)).toLowerCase();return slots.slice(0,2).includes(token)?token:'';};
  const rest=[];for(const id of ids){const slot=fixed(id);if(slot&&!(slots.includes(slot)&&used.has(slot))){map.set(id,slot);used.add(slot);}else rest.push(id);}
  // Providers the saved profiles use come first, then connected ones: the slots go to what is on the tape.
  const info=new Map(source.providers.map(v=>[v.id,v])),rank=id=>info.get(id)?.used?.length?0:info.get(id)?.connected?1:2;
  rest.sort((a,b)=>rank(a)-rank(b));
  for(const id of rest){const free=slots.find(s=>!used.has(s));if(free){map.set(id,free);used.add(free);continue;}let h=0;for(const c of String(id))h=(h*31+c.charCodeAt(0))>>>0;map.set(id,slots[h%slots.length]);}
  return map;
 }
 const HEALTH_VIEW={local:['gpu','◆'],healthy:['ok','●'],risk:['low','△'],empty:['zero','∅'],unknown:['unk','?'],unavailable:['off','⊘']};
 // HEALTH is drawn in every CUT; .health-off on the deck or drawer hides the glyph and the bar, never FREE.
 function healthMarks(route){
  if(poolName(route))return {glyph:'',bar:'',text:''};
  const h=opRouteHealth(route),[cls,glyph]=HEALTH_VIEW[h.kind]||HEALTH_VIEW.unknown,hp=h.remaining!=null?Math.max(.04,Math.min(1,h.remaining/100)):1;
  const text='HEALTH: '+h.label+(h.remaining!=null?' · залишок '+num(h.remaining)+'%':'');
  return {text,glyph:`<span class="hs hs--${cls}" aria-hidden="true">${glyph}</span>`,bar:`<span class="cut__hb hb--${cls}" style="--hp:${+hp.toFixed(3)}" aria-hidden="true"><i></i></span>`};
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
 // One rule on every CUT: the shared namespace («DEMO · », «org/», «Vendor: ») is never printed (the provider tag
 // and the tooltip carry it), so «DEMO · Aurora 01 Free» and «DEMO · Swift 01 Free» read «Aurora 01 Free» /
 // «Swift 01 Free» at any width — never a 1–4 letter stub of the namespace. The family then takes the ellipsis.
 function nameSpace(head){const text=String(head),m=text.match(/^(.{1,24}?(?: · | — | – |: |\/))(?=\S)/u);return m&&text.length-m[1].length>=3?[m[1].trimEnd(),text.slice(m[1].length)]:['',text];}
 const nameMarkup=name=>{const [head,tail]=nameParts(name),[,family]=nameSpace(head);return `<span class="cut__head">${esc(family)}</span>${tail?`<span class="cut__tail">${esc(tail)}</span>`:''}`;};
 function freeRoute(route){const m=catalogMap.get(split(route).raw);return !!m&&priceInfo(m).kind==='free';}
 function laneIndex(role,group){const keys=group==='vibe'?workers():roleKeys;return Math.max(0,keys.indexOf(role));}
 // One CUT on every surface: lane, editors, drawer. A lane CUT is a container whose name is the <button data-edit>.
 function node(role,r,i,n,group='role'){
  if(poolName(r))return poolBlock(role,r,i,group);
  const m=split(r),before=savedChain(role,group)[i],sequence=group==='alternatives'||group==='pool';
  const replacement=temporarySlot(role,i,group),inherited=inheritedSlot(role,i,group),fixed=fixedSlot(role,i,group,inherited),deleted=deletedCut(r),free=!deleted&&freeRoute(r),warn=!deleted&&routeWarning(m.raw);
  const skipped=group==='alternatives'?modeSkipped(role).filter(x=>split(x.route).raw===m.raw):[];
  const more=fixed?'':slotActionKey(role,i,group),health=healthMarks(r),title=cutTitle(r),alias=group==='vibe'&&i===0&&vibeAlias(role)?vibeAlias(role)+' · ':'',provider=providerName(m.provider);
  const classes=['cut',free&&'cut--free',more&&'cut--more',deleted&&'cut--deleted',fixed&&'cut--locked',before!==r&&!inherited&&'is-changed',replacement&&'is-replaced',skipped.length&&'is-skipped'].filter(Boolean).join(' ');
  const notes=[inherited?INHERIT_NOTE[inherited]:before!==r?(before?'до зміни: '+before:'новий CUT'):'',warn?'маршрут зараз недоступний: провайдер вимкнений або прострочений':'',deleted?'DELETED — відсутній у провайдера':'',...skipped.map(x=>{const where=(x.keys||[x.key]).filter(k=>k&&k!==role).map(k=>k.replace(/^(role|vibe):/,''));return 'пропущено'+(where.length?' у '+where.join(', '):'')+': '+x.reason;})].filter(Boolean);
  // One tooltip per CUT: the full name (the visible one may be shortened), the exact route, HEALTH and changes.
  const tip=[alias+title+' · '+provider,r,health.text,...notes].filter(Boolean).join('\n');
  const label=`Змінити CUT ${i+1}, ${group==='pool'?poolNames[role]:role}: ${alias}${title} · ${provider}${m.effort?' · thinking '+m.effort:''}${free?' · FREE':''}${inherited?' · '+INHERIT_NOTE[inherited]:''}${deleted?' · DELETED — відсутній у провайдера':''}${replacement?' · заміна DeepSeek':''}${skipped.length?' · пропущено':''}${health.text?' · '+health.text:''}`;
  // A fixed CUT is printed tape: its name is not a key, its thinking is printed, it is no drop target.
  const name=fixed?`<span class="cut__name cut__name--split" title="${esc(tip)}">${nameMarkup(title)}</span>`:`<button type="button" class="cut__name cut__name--split" data-edit="${esc(role)}" data-index="${i}" data-group="${group}" title="${esc(tip)}" aria-label="${esc(label)}">${nameMarkup(title)}</button>`;
  const think=fixed?(group!=='vibe'&&roleInfo(role)?.thinking===false?'':`<span class="cut__think">${esc(m.effort||'типово')}</span>`):thinkSelect(m,role,i,group,`Thinking: ${group==='pool'?poolNames[role]:role}, CUT ${i+1}`);
  return `<div class="${classes}"${sequence?' role="listitem"':''} data-p="${providerSlot(m.provider)}" data-route="${esc(r)}" data-clip-key="${clipKey(role,r,i,group)}"${fixed?'':` data-node-role="${esc(role)}" data-index="${i}" data-group="${group}"`}${inherited?` data-inherited="${inherited}"`:''} style="--li:${laneIndex(role,group)}">${sequence?`<span class="cut__ord" aria-hidden="true">${String(i+1).padStart(2,'0')}</span>`:''}${sourceTab(role,i,group,inherited)}<span class="cut__edge"></span>${name}<span class="cut__meta">${health.glyph}<b class="tag" data-p="${providerSlot(m.provider)}">${esc(providerCode(m.provider))}</b>${think}${alias?`<span class="cut__alias">${esc(alias.replace(/ · $/,''))}</span>`:''}<span class="stamp stamp--repl cut__repl" title="заміна DeepSeek" aria-hidden="true">⇄</span>${skipped.length?'<span class="stamp stamp--skip">пропуск</span>':''}${warn?'<span class="hs hs--low" aria-hidden="true">!</span>':''}${deleted?'<span class="stamp stamp--del">DELETED</span>':''}</span>${free?'<span class="stamp stamp--free">FREE</span>':''}${more}${health.bar}</div>`;
 }
 function stepCount(){
  if(renderCache?.steps!=null)return renderCache.steps;
  // Reserve the same columns for ON and OFF before the asynchronous preview arrives.
  const count=(role,group='role')=>{const base=baseChain(role,group),at=base.findIndex(deepseek),projected=at<0?base:[...base.slice(0,at),...modeList(modeScope(role,group)),...base.slice(at).filter(r=>!deepseek(r))];return Math.max(base.length,new Set(projected.map(r=>split(r).raw)).size,chain(role,group).length);};
  const steps=Math.max(8,1+Math.max(...roleKeys.map(r=>count(r)),...workers().map(r=>count(r,'vibe'))));if(renderCache)renderCache.steps=steps;return steps;
 }
 // A recessed jack for a new CUT; it glows while a CUT is dragged and stays pinned to the right of a long lane.
 function socketKey(role,index,group,word,label){const jack=`<button type="button" class="socket" data-edit="${esc(role)}" data-index="${index}" data-group="${group}" aria-label="${esc(label)}"><span class="socket__plus" aria-hidden="true"></span>${esc(word)}</button>`;return group==='role'||group==='vibe'?`<span class="socket-dock">${jack}</span>`:jack;}
 function laneKey(role,index,own){
  const src=laneSource(role,'role'),menu=laneMenuAvailable(role,'role'),name=labels[role]&&labels[role]!==role?role+' · '+labels[role]:role;
  const inheritsStandard=state.profile!=='standard'&&!presetLike()&&!Object.hasOwn(source.presets[state.profile]?.modelRoles||{},role)&&own;
  const title=[labels[role]&&labels[role]!==role?name:role.length>11?role:'',inheritsStandard?'основна модель успадкована зі Standard':'',menu?'дії області: перевизначити, скинути, підняти в глобальне':''].filter(Boolean).join(' · ');
  const attrs=menu?`data-lane-menu="${esc(role)}" data-group="role" aria-haspopup="menu" aria-expanded="false"`:`data-focus-role="${esc(role)}"`;
  return `<button type="button" class="lane__key${src.text?' lane__key--src':''}" ${attrs}${role===state.role?' aria-current="true"':''}${title?` title="${esc(title)}"`:''} aria-label="${esc(name+(src.text?' · '+src.text:own?'':presetLike()?'':' · типово в OMP')+(menu?' · дії області':''))}"><span class="lane__idx">${String(index+1).padStart(2,'0')}</span><span class="lane__label"><span class="lane__name">${esc(role)}</span>${src.text?`<span class="lane__sub">${esc(src.text)}</span>`:''}</span>${led(!!src.c,src.c||'green')}</button>`;
 }
 // An unset lane: «Типово в OMP» (no layer sets it), or in a котушка «Не в котушці» with what applying it leaves.
 function leaderMarkup(role){
  if(presetLike())return `<div class="leader"><b>Не в котушці</b><small>· ${esc(absentOutcome(role))}</small></div>`;
  return `<div class="leader"><b>Типово в OMP</b><small>· обрати CUT</small></div>`;
 }
 // What OMP does with a role a котушка does not carry when it is applied (/modelpreset switch clears the roles it
 // does not name in the layer that stores roles): a project storing roles itself falls back to the Global value; with
 // the roles stored globally a project keeps its own value; otherwise OMP's default.
 function absentOutcome(role){
  const projectStore=!!globalLayer&&source.scope?.storage==='project',up=globalLayer?.modelRoles?.[role],own=globalLayer&&profiles.standard?.modelRoles?.[role];
  return projectStore?(up?'після «Застосувати» — з глобального':'після «Застосувати» — типово в OMP'):own?'після «Застосувати» лишається з проєкту':'після «Застосувати» — типово в OMP';
 }
 // A role lane: lane key, then the tape; an unconfigured role is leader tape («Типово в OMP»), not a CUT. A котушка
 // takes no reserves (its reserves are the scope's), a Global котушка seen from a project takes nothing.
 function graphRow(role,index,group='role'){
  const list=chain(role,group),agent=group==='vibe',automatic=!agent&&!list.length;
  const keyHtml=agent?agentKey(role,true,agentListNote(role)+(agentInfo(role)?'':' · немає у файлах агентів')):laneKey(role,index,!automatic);
  const tape=automatic?leaderMarkup(role):list.map((r,i)=>node(role,r,i,list.length,group)).join('');
  const word=agent?'кандидат':automatic?'основна':'резерв',socket=locked()||presetLike()&&!automatic?'':socketKey(role,list.length,group,word,(agent?'Додати кандидата':automatic?(isNative(state.profile)?'Додати роль у котушку':'Обрати основний CUT'):'Додати резерв')+': '+role);
  return `<div class="lane${automatic?' lane--inherit':''}" data-role="${esc(role)}" data-lane-group="${group}">${keyHtml}<div class="lane__groove">${locked()?'':modeTag(role,group)}${tape}${socket}${agent&&agentRemove(role)?`<span class="lane__tools">${agentRemove(role)}</span>`:''}</div></div>`;
 }
 function agentTrack(worker,i){return !agentValues(worker).length&&agentInfo(worker)?agentDefaultTrack(worker):agentLink(worker)?agentLinkedTrack(worker):graphRow(worker,i,'vibe');}
 function poolActionContext(){return !!state.poolPanel;}
 // Transport on the drawer front: Undo / Redo / save state / Зберегти. The scope is printed when an editor owns it.
 function transportParts(){
  const pool=poolActionContext(),h=editHistory.available(pool?'@free-pools':state.profile),dirty=pool?poolsDirty():state.changes,scope=pool?'пули':state.view==='profiles'&&state.modePanel?'заміни':'';
  // Save waits for a pending preview and refuses what the server would refuse (QA2 B6: only Standard's or this
  // profile's outside edit blocks). A failed preview does not block: Save previews again and says why.
  const plan=activePlan(),stale=!pool&&!!dirty&&staleDrafts.has(state.profile),blocked=!pool&&!stale&&!!(plan?.pending||plan?.data?.issues?.length||saveBlocker());
  const area=pool?'FREE пули':scope==='заміни'?'Заміни · профіль':'Профіль '+prettyProfile(state.profile);
  const text=state.saving?'Збереження…':dirty?(pool?'Пули змінено':dirty+' '+plural(dirty,'зміна','зміни','змін')):'Збережено';
  const note=state.saving?'Записую файл':stale?'Файл змінився · вирішити конфлікт':blocked&&dirty?(plan?.pending?'Чекає розрахунку замін':'Збереження заблоковане'):dirty?(pool?'Спільні пули · не збережено':'Котушка '+prettyProfile(state.profile)+' · не збережено'):'Для нових запусків OMP';
  return {pool,scope,
   scopeHtml:scope?`<span class="transport__scope">${scope}</span>`:'',
   undo:`<button type="button" class="key key--sq" data-action="${pool?'pool-undo':'undo'}" aria-label="Скасувати зміну: ${esc(area)}" title="Скасувати · ⌘/Ctrl Z" ${!h.undo||state.saving?'disabled':''}><span class="key__cap">${SVG.undo}</span></button>`,
   redo:`<button type="button" class="key key--sq" data-action="${pool?'pool-redo':'redo'}" aria-label="Повторити зміну: ${esc(area)}" title="Повторити · ⌘/Ctrl Shift Z" ${!h.redo||state.saving?'disabled':''}><span class="key__cap">${SVG.redo}</span></button>`,
   state:`<div class="transport__state" role="status" aria-live="polite" title="${esc(text+' · '+note)}"><b>${led(true,state.saving?'amber':dirty?(blocked||stale?'red':'amber'):'green')}<span>${esc(text)}</span></b><small>${esc(note)}</small></div>`,
   // A draft on an older file never dead-ends: its Save key becomes «Конфлікт…», the same choice as ⌘S.
   save:stale?`<button type="button" class="key key--action" data-action="conflict-open" aria-label="Конфлікт: файл профілю ${esc(prettyProfile(state.profile))} змінився · вирішити" title="Файл змінився після початку чернетки · ⌘/Ctrl S"><span class="key__cap">Конфлікт…</span></button>`:`<button type="button" class="key key--action" data-action="${pool?'pool-save':'save'}" aria-label="${pool?'Зберегти пули':'Зберегти профіль '+esc(prettyProfile(state.profile))}" title="⌘/Ctrl S" ${!dirty||state.saving||blocked?'disabled':''}><span class="key__cap">Зберегти${pool?'<span class="key__more"> пули</span>':''}</span></button>`};
 }
 function slotActionKey(role,index,group){return chain(role,group).length>1||group==='pool'||group==='alternatives'||poolName(chain(role,group)[index])||temporarySlot(role,index,group)||canRemoveCut(role,index,group)?`<button type="button" class="cut__more" data-slot-actions="${esc(role)}" data-index="${index}" data-group="${group}" aria-haspopup="menu" aria-expanded="false" aria-label="Дії з CUT: ${esc(role)}, слот ${index+1}" title="Дії з CUT">⋯</button>`:'';}
 // Монтаж: one deck pocket. Tools (pool keys, Пули, search), notices, editors, ruler, the lanes (a run of
 // identical inherited lanes folds into one printed row), agents, legend. Each lane and each agent is its own
 // region, so an edit, Undo or a preview response replaces only the rows whose CUTS changed. HEALTH and search
 // only patch the deck's attributes and the rows whose marks changed.
 // A котушка's limits on the deck (DESIGN «Області і котушки»): what it carries (role primaries and thinking) and what
 // it does not (reserves, agents, providers: the scope's); its thinking level is edited here. A Global котушка seen
 // from a project is read-only: it can be applied here and edited in the Global scope.
 function presetStrip(){
  if(!presetLike())return '';
  const name=prettyProfile(state.profile),view=locked(),levels=[['','типово · не задає'],...['minimal','low','medium','high','xhigh','max','auto'].map(l=>[l,l])];
  return `<div class="presetbar" role="group" aria-label="${esc((view?'Глобальна котушка ':'Котушка OMP ')+name)}">${led(true,'orange')}<div class="presetbar__txt"><b>${view?'Глобальна котушка':'Котушка OMP'} · ${esc(name)}</b><span>Несе лише основні CUTS ролей і thinking. Резерви, агенти й провайдери — з області${view?'; тут — перегляд і «Застосувати»':' (Standard)'}.</span></div>${selWin('preset-thinking','Thinking<br>котушки',p().defaultThinkingLevel||'',levels,'sel--sm presetbar__think',view||state.saving?'disabled':'')}${view?key('Редагувати в глобальному','preset-edit-global','key--sm'):key('До Standard','to-standard','key--sm')}</div>`;
 }
 function presetAgentsNote(){return `<div class="subhead"><span class="silk">Агенти</span><span class="print">не входять у котушку OMP · їхні моделі спільні для області</span><span class="subhead__rule"></span>${key('Агенти в Standard','to-standard','key--sm')}</div>`;}
 function profileView(){
  const pending=projectionPending(),ds=hasDeepSeekScreen();
  return [box('p/deck',deckOpen(),[
   box('p/tools','<div class="deck__tools">',[leaf('p/pools',poolShelf()),leaf('p/role-search',roleSearch())]),
   leaf('p/preset',presetStrip()),
   leaf('p/notices',deckNotices(ds)),
   leaf('p/ruler',rulerMarkup()),
   box('p/body',`<div class="deck__body${pending?' is-pending':''}"${pending?' aria-busy="true"':''}>`,[laneGraph(),leaf('p/agents-head',presetLike()?presetAgentsNote():agentSectionHead()),presetLike()?box('p/agents','<div class="lanes lanes--agents">',[]):agentList()]),
   leaf('p/legend',legendMarkup())
  ])];
 }
 // The deck's and the drawer's opening tags carry HEALTH, search and armed states; flipping them patches attributes only.
 function deckOpen(){return `<section class="bay deck${state.health?'':' health-off'}${state.query.trim()?' is-searching':''}${state.armedCut?' is-armed':''}" id="profile-tracks" aria-label="Монтаж">`;}
 function trayOpen(){const mode=drawerMode();return `<section class="tray${drawerShown()?' is-open':''}${mode==='cuts'?'':' tray--editor'}${mode==='form'?' tray--form':''}${state.armedCut?' is-armed':''}${state.health?'':' health-off'}" id="cuts-collection"${mode==='form'?' role="dialog" aria-modal="true" aria-labelledby="tray-form-title"':` aria-label="${mode==='pool'?'Пули':mode==='alternatives'?'Заміни DeepSeek':'Колекція CUTS'}"`}>`;}
 function roleSearch(){return `<label class="search">${SVG.search}<input id="role-query" type="search" value="${esc(state.query)}" placeholder="Підсвітити CUT на плівці" aria-label="Підсвітити CUT на плівці" autocomplete="off"></label>`;}
 function rulerMarkup(){const steps=Math.min(stepCount(),12);return `<div class="ruler" aria-hidden="true"><span class="silk">Доріжка / роль</span><div class="ruler__cols"><span>Основна</span>${Array.from({length:steps-1},(_,i)=>`<span>Резерв ${i+1}</span>`).join('')}</div></div>`;}
 // The printed legend at the bottom of the deck; HEALTH entries hide with the switch (CSS), so it never re-renders for it.
 function legendMarkup(){
  const hs=[['ok','●','запас'],['low','△','малий'],['zero','∅','нуль'],['unk','?','немає виміру'],['off','⊘','недоступна'],['gpu','◆','GPU']];
  return `<div class="legend"><span class="silk lg--h">HEALTH</span>${hs.map(([c,g,t])=>`<span class="lg lg--h"><span class="lg__sw hb--${c}"><i${c==='low'?' style="right:55%"':''}></i></span>${g} ${t}</span>`).join('')}<span class="lg lg--off">HEALTH вимкнено · чиста плівка</span><span class="seam seam--v"></span>${referencedProviders.map(v=>`<span class="lg"><b class="tag" data-p="${providerSlot(v)}">${esc(providerCode(v))}</b><span class="lg--name">${esc(providerName(v))}</span></span>`).join('')}<span class="seam seam--v"></span><span class="lg"><span class="lg__inh" aria-hidden="true"></span>резерв з default</span>${globalLayer?'<span class="lg"><span class="lg__inh lg__inh--global" aria-hidden="true"></span>з глобального</span>':''}<span class="lg"><span class="stamp stamp--repl">⇄</span>заміна DeepSeek</span><span class="lg">${led(true,'green')}${globalLayer?'у проєкті':'у цьому файлі'}</span>${globalLayer?`<span class="lg">${led(true,'blue')}з глобального</span>`:''}${presetLike()?`<span class="lg">${led(true,'orange')}котушка</span>`:''}<span class="print lg__note">Збереження — для нових запусків OMP; активні сесії зберігають свої налаштування</span></div>`;
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
   const first=g.fold[0],open=foldOpen(g.fold),from=roleKeys.indexOf(first)+1,to=from+g.fold.length-1,range=String(from).padStart(2,'0')+'–'+String(to).padStart(2,'0');
   children.push(leaf('p/fold:'+first,`<div class="fold"><button type="button" class="key key--wide" data-fold-toggle="${esc(first)}" aria-expanded="${open}" aria-controls="fold-${esc(first)}"><span class="key__cap"><span class="lane__idx">${range}</span>${open?'Сховати':'Показати'} <span class="rd" style="--rd:2ch">${g.fold.length}</span></span></button><div class="fold__print"><b>${g.fold.length} ${plural(g.fold.length,'доріжка','доріжки','доріжок')} · ${presetLike()?'не в котушці':'типово в OMP'}</b><span>${g.fold.map(esc).join(' · ')}</span></div></div>`));
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
  const mine=myProviderIds(),disabled=new Set(eff().disabledProviders||[]),expired=new Set(source.providers.filter(v=>v.expired).map(v=>v.id));
  // Cheap tests first: the capability check runs only for a CUT the provider filters let through.
  return catalog.filter(m=>m.status!=='missing'&&!disabled.has(m.provider)&&!expired.has(m.provider)&&(x.scope==='all'||mine.has(m.provider))&&(x.group!=='pool'||ManaOperator.isFreeModel(m))&&(x.group!=='alternatives'||!deepseek(m.provider+'/'+m.id))&&acceptsRoleModel(x.role,x.group,m));
 }
 // MENUS — small recessed trays with labelled keys of the panel's shape (DESIGN «Меню»). The ⋯ CUT tools are a
 // role=menu (arrows, Home/End, Escape returns to ⋯); the quick pick is a dialog that shows the current CUT first and
 // picks with one tap. Both carry [data-picker]; on a phone they are sheets at the bottom of the screen.
 // LANE MENU (the key of a project's lane, DESIGN «Області і котушки»): where the lane's values come from and the
 // scope actions — «Перевизначити в проєкті» (a draft copy of the Global value), «Скинути до глобального» (a draft
 // removal of the project's value; «Типово в OMP» where the Global config has none) and «Підняти в глобальне» (one
 // recoverable write of both files, confirmed in the drawer). Drafts are one Undo step and need «Зберегти».
 const LANE_PART={modelRoles:'основна',retry:'резерви',task:'список агента'};
 function laneMenu(x,pos){
  const l=laneLayers(x.role,x.group)||{paths:[],own:[],up:[],inherit:[]},vibe=x.group==='vibe',same=(a,b)=>a.join('\n')===b.join('\n');
  const own=path=>l.own.some(o=>same(o,path)),up=path=>l.up.some(o=>same(o,path));
  const where=l.paths.map(path=>LANE_PART[path[0]]+': '+(own(path)?(up(path)?'проєкт (перекриває глобальне)':'проєкт'):up(path)?'глобальне':vibe?'типово в OMP':path[0]==='retry'&&inheritsDefault(x.role)?'з default':'не задано')).join(' · ');
  const linked=!!source.scope?.globalReadOnly,blocked=promoteBlocked(x.role,x.group)||linked,files=scopeFiles();
  const item=(cap,action,attr='')=>`<button type="button" class="key key--menu" role="menuitem" data-action="${action}"${attr}><span class="key__cap">${cap}</span></button>`;
  const rows=[];
  if(l.inherit.length)rows.push(item(led(true,'green')+'Перевизначити в проєкті','lane-override',` title="${esc('Скопіювати в проєкт: '+l.inherit.map(path=>LANE_PART[path[0]]).join(', ')+'. Глобальний файл не зміниться.')}"`));
  if(l.own.length&&l.up.length)rows.push(item(led(true,'blue')+'Скинути до глобального','lane-reset',' title="Прибрати значення проєкту: OMP братиме глобальне"'));
  else if(l.own.length&&(vibe?agentInfo(x.role):roleInfo(x.role)))rows.push(item('Типово в OMP','lane-reset',' title="Прибрати значення проєкту: глобальне його не задає, модель обирає OMP"'));
  if(l.own.length)rows.push((rows.length?'<div class="menu__sep" role="separator"></div>':'')+item(led(true,'amber')+'Підняти в глобальне…','lane-promote',blocked?' disabled':''));
  return `<div class="menu menu--tools menu--lane" data-picker role="menu" aria-label="${esc((vibe?'Агент ':'Доріжка ')+x.role+' · області')}" ${pos}><div class="menu__head"><span class="silk">${esc((vibe?'агент ':'')+x.role)} · області</span>${MENU_CLOSE('Закрити дії доріжки')}</div><p class="menu__note menu__where">${esc(where)}</p><div class="menu__bed">${rows.join('')||'<p class="menu__note">Немає дій</p>'}</div>${blocked?`<p class="menu__note">${linked?'Глобальний файл — символьне посилання: Mana Tape його не записує':'Підняти можна збережене значення · спершу «Зберегти»'}</p>`:''}<p class="menu__note menu__files"><span>проєкт · ${esc(files.projectShort)}</span><span>глобальне · ${esc(files.globalShort)}</span></p></div>`;
 }
 function openLaneMenu(role,group,el){
  if(state.saving)return;
  if(state.picker?.lane&&state.picker.role===role&&state.picker.group===group){closePicker();return;}
  if(group==='role')state.role=role;
  const b=el.getBoundingClientRect();state.picker={role,index:-1,group,lane:true,actionsOnly:true,inTray:false,anchor:{top:b.top,bottom:b.bottom},top:Math.max(12,b.bottom+7),left:Math.max(12,Math.min(b.left,innerWidth-292))};render();
  focusPicker();
 }
 function focusLaneKey(role,group){
  const key=[...win.querySelectorAll(`[data-lane-menu="${CSS.escape(role)}"][data-group="${group}"]`)].find(el=>el.getClientRects().length);
  if(key){key.focus({preventScroll:true});return;}
  if(group==='role'){const lane=win.querySelector(`.lane[data-role="${CSS.escape(role)}"][data-lane-group="role"] .lane__key`);if(lane){lane.focus({preventScroll:true});return;}}
  focusLane(role,group);
 }
 // A value can move into the Global config only as it is saved: an unsaved change of its path (or a draft on an older
 // file) is saved first.
 function promoteBlocked(role,group){const l=laneLayers(role,group);if(!l)return true;return staleDrafts.has('standard')||diff('standard').some(c=>l.paths.some(path=>path.join('\n')===c.path.join('\n')));}
 function laneOverride(role,group){
  const l=laneLayers(role,group);if(!l?.inherit.length||state.saving)return;
  // The Global scope's logical value (a FREE pool stays a block, DeepSeek stays DeepSeek for this project's own mode),
  // not the routes Global compiled: later pool saves and this project's mode keep reaching the copy.
  for(const path of l.inherit){const value=path.reduce((o,k)=>o?.[k],globalLogical)??path.reduce((o,k)=>o?.[k],globalLayer),parent=path.slice(0,-1).reduce((o,k)=>o[k]??={},p());parent[path.at(-1)]=copy(value);}
  state.picker=null;state.opFeedback=(group==='vibe'?'Агент ':'')+role+' перевизначено в проєкті (копія глобального: '+l.inherit.map(path=>LANE_PART[path[0]]).join(', ')+') · далі зміни — лише в проєкті · «Зберегти» запише, ↶ скасує';render();focusLaneKey(role,group);
 }
 function laneReset(role,group){
  const l=laneLayers(role,group);if(!l?.own.length||state.saving)return;
  for(const path of l.own){const parent=path.slice(0,-1).reduce((o,k)=>o?.[k],p());if(parent)delete parent[path.at(-1)];}
  delete modeSettings().overrides[(group==='vibe'?'vibe:':'role:')+role];
  state.picker=null;state.opFeedback=(group==='vibe'?'Агент ':'')+role+(l.up.length?' скинуто до глобального':' повернуто до «Типово в OMP»')+' · «Зберегти» запише, ↶ скасує';render();focusLaneKey(role,group);
 }
 function lanePromote(role,group){
  const l=laneLayers(role,group);if(!l?.own.length||state.saving)return;
  if(promoteBlocked(role,group)){notify('Підняти можна збережене значення: спершу збережи проєкт.');return;}
  const files=scopeFiles(),vibe=group==='vibe',what=(vibe?'агента ':'')+role,parts=l.own.map(path=>LANE_PART[path[0]]).join(', ');
  // An agent's @role that only this project defines would point nowhere in the Global config.
  const dangling=vibe?agentValues(role).filter(v=>v.startsWith('@')&&!globalLayer.modelRoles[aliasRole(v)]).map(v=>v.split(':')[0]):[];
  state.picker=null;
  const spec={action:'promote',paths:l.own,role,group,pending:true,focus:`[data-lane-menu="${CSS.escape(role)}"][data-group="${group}"]`,title:'Підняти в глобальне',sub:what,label:'Підняти в глобальне',
   text:`Значення проєкту для <b>${esc(what)}</b> (${esc(parts)}) буде записано в глобальний файл і прибрано з файлу проєкту — одним записом, з резервними копіями обох файлів.<span class="path-list"><span>глобальне · <code>${esc(files.global)}</code></span><span>проєкт · <code>${esc(files.project)}</code></span></span>Після цього ${esc(what)} діятиме в усіх проєктах, де немає власного значення.`,
   note:dangling.length?'<div class="msg" data-s="warn">'+led(true,'amber')+'<span>'+esc(dangling.join(', '))+' є лише в цьому проєкті: у глобальному файлі це посилання агента нікуди не вестиме.</span></div>':''};
  askConfirm(spec);previewAction(spec,'/api/scope-action',{action:'promote',revision:source.revisions.standard,paths:l.own});
 }
 // The Global scope of this scope (itself on the Global scope), and the files the scope actions write.
 function globalScopeRow(){const id=source.scope?.kind==='global'?source.projectId:source.scope?.parent;return id?(source.projects||[]).find(x=>x.id===id)||null:null;}
 function scopeFiles(){
  const g=globalScopeRow(),scope=source.scope||{},trim=path=>String(path||'').replace(/\/+$/,''),tail=path=>trim(path).split('/').pop()||'';
  const project=scope.kind==='project'?trim(scope.path)+'/.omp/config.yml':'';
  return {global:g?trim(g.path)+'/config.yml':'',project,globalShort:g?tail(g.path)+'/config.yml':'',projectShort:project?'.omp/config.yml':''};
 }
 function pickerTitle(x){return (x.group==='alternatives'?'Заміни · '+(x.role==='profile'?'профіль':x.role.split(':')[1]):x.group==='pool'?poolNames[x.role]:x.group==='vibe'?'агент '+x.role:x.role)+' · '+(x.group==='alternatives'||x.group==='pool'?String(x.index+1).padStart(2,'0'):x.index===0?'основна':'резерв '+x.index);}
 const MENU_CLOSE=label=>`<button type="button" class="key key--sm key--sq" data-action="picker-close" aria-label="${esc(label)}" title="Закрити · Esc"><span class="key__cap">${SVG.close}</span></button>`;
 function pickerMarkup(){
  const x=state.picker;if(!x)return leaf('picker','');
  const pos=`style="top:${x.top}px;left:${x.left}px"`;
  if(x.lane)return leaf('picker',laneMenu(x,pos));
  const list=chain(x.role,x.group),current=list[x.index];
  if(x.thinking){
   // The shared thinking menu: one latched key per level the model lists, «типово» and «off» always.
   const m=current&&!poolName(current)?split(current):null,waiting=pickerActionsPending(),off=waiting?' disabled':'';
   const levels=m?[...options(m.effort,m.raw).matchAll(/value="([^"]*)"[^>]*>([^<]*)</g)].map(o=>[o[1],o[2]]):[];
   const rows=levels.map(([value,text])=>`<button type="button" class="key key--menu" role="menuitemradio" aria-checked="${value===m.effort}" data-action="set-effort" data-value="${value}"${off}><span class="key__cap">${led(value===m.effort,'green')}${text}</span></button>`).join('');
   return leaf('picker',`<div class="menu menu--tools menu--think" data-picker role="menu" aria-label="Thinking · ${esc(pickerTitle(x))}" aria-busy="${waiting}" ${pos}><div class="menu__head"><span class="silk">Thinking · ${esc(pickerTitle(x))}</span>${MENU_CLOSE('Закрити thinking')}</div><div class="menu__bed">${rows||'<p class="menu__note">Немає рівнів thinking для цього CUT</p>'}</div>${waiting?'<p class="menu__note">Чекає розрахунку замін…</p>':''}</div>`);
  }
  if(x.actionsOnly){
   const sequence=x.group==='alternatives'||x.group==='pool',isPool=poolName(current),canRemove=canRemoveCut(x.role,x.index,x.group),waiting=pickerActionsPending(),off=waiting?' disabled':'';
   // The primary too: the next CUT takes its place, or the lane's only CUT returns the lane to its default.
   const reset=canRemove&&removesLane(x.role,x.index,x.group)?soleCutReset(x.role,x.group):'',removeTip=reset?({'як у Standard':'Доріжка повертається до Standard','як у глобальному':'Проєкт прибирає своє значення: OMP бере глобальне','роль вийде з котушки':'Роль не входитиме в котушку'})[reset]||'Як «Типово в OMP»: модель обирає OMP':!sequence&&x.index===0?'Наступний CUT стане основним':'';
   const item=(cap,action,attr='',cls='')=>`<button type="button" class="key key--menu${cls}" role="menuitem" data-action="${action}"${attr}${off}><span class="key__cap">${cap}</span></button>`;
   const rows=[];
   if(!sequence&&!isPool&&x.index>0)rows.push(item(led(true,'green')+'Основна','promote-node'));
   if(!sequence&&temporarySlot(x.role,x.index,x.group))rows.push(item(led(true,'amber')+'Закріпити','make-permanent'));
   if(list.length>1&&!(presetLike()&&!sequence)){rows.push(item('← Раніше<span class="key__hint">⇧←</span>','move-node',' data-direction="-1"'+(x.index===0?' disabled':'')));rows.push(item('Пізніше →<span class="key__hint">⇧→</span>','move-node',' data-direction="1"'+(x.index===list.length-1?' disabled':'')));}
   if(isPool)rows.push(item('Замінити пул…','replace-pool'));
   if(canRemove)rows.push((rows.length?'<div class="menu__sep" role="separator"></div>':'')+item(led(true,'red')+'Прибрати'+(reset?' · '+reset:''),'remove-node',removeTip?` title="${removeTip}"`:'',' key--danger'));
   const m=current&&!isPool?split(current):null,think=m&&thinkSelect(m,x.role,x.index,x.group,'');
   const thinking=think?`<div class="menu__row">${selWin('picker-effort','Thinking',m.effort,[...options(m.effort,m.raw).matchAll(/value="([^"]*)"[^>]*>([^<]*)</g)].map(o=>[o[1],o[2]]),'sel--sm',off)}</div>`:'';
   const heir=inheritedSlot(x.role,x.index,x.group)==='global'?'<p class="menu__note">З глобального · будь-яка зміна стане перевизначенням у проєкті</p>':'';
   return leaf('picker',`<div class="menu menu--tools" data-picker role="menu" aria-label="Дії з CUT · ${esc(pickerTitle(x))}" aria-busy="${waiting}" ${pos}><div class="menu__head"><span class="silk">${esc(pickerTitle(x))}</span>${MENU_CLOSE('Закрити дії з CUT')}</div><div class="menu__bed">${rows.join('')||'<p class="menu__note">Немає дій для цього CUT</p>'}</div>${thinking}${heir}${waiting?'<p class="menu__note">Чекає розрахунку замін…</p>':''}</div>`);
  }
  const resetLabel=x.group==='vibe'||x.group==='role'?laneResetLabel(x.role,x.group):'',reset=resetLabel?key(resetLabel,x.group==='vibe'?'reset-agent':'reset-role','key--sm',`aria-label="${esc(resetLabel+': '+(x.group==='vibe'?'агент ':'')+x.role)}"`):'';
  const results=leaf('picker/results',pickerResults());
  return box('picker',`<div class="menu menu--pick" data-picker role="dialog" aria-label="${current?'Заміна':'Додавання'} CUT · ${esc(pickerTitle(x))}" ${pos}>`,[box('picker/head','<div class="menu__head">',[leaf('picker/title',`<span class="silk">${current?'Заміна':'Додати'} · ${esc(pickerTitle(x))}</span>`),leaf('picker/count',pickerCount()),leaf('picker/keys',`${reset}${MENU_CLOSE('Закрити вибір')}`)]),leaf('picker/search',pickerSearch()),leaf('picker/hints',`${x.scope==='all'?'<p class="menu__note">Весь каталог · доступ залежить від підключення провайдера</p>':''}${x.group==='vibe'&&x.index===0&&vibeAlias(x.role)?`<p class="menu__note">Замість ${esc(vibeAlias(x.role))} стане власний CUT агента · роль не зміниться</p>`:''}${inheritedSlot(x.role,x.index,x.group)==='global'?'<p class="menu__note">З глобального · вибір стане перевизначенням у проєкті; глобальний файл не зміниться</p>':''}${isNative(state.profile)&&(x.group==='role')?'<p class="menu__note">Котушка OMP · лише основна модель ролі</p>':''}`),results]);
 }
 // How many CUTS the search leaves: a fixed-width readout in the menu's head (the field itself is never rebuilt).
 function pickerCount(){return `<span class="menu__count"><span class="rd" style="--rd:3ch">${pickerResults.count??0}</span> CUTS</span>`;}
 function pickerSearch(){const x=state.picker,ids=[...myProviderIds()].sort((a,b)=>collate(providerName(a),providerName(b)));return `<div class="menu__search"><label class="search">${SVG.search}<input id="picker-search" type="search" placeholder="CUT або провайдер" value="${esc(x.query)}" aria-label="Знайти CUT" aria-controls="picker-results" autocomplete="off"></label>${selWin('picker-provider','Провайдер',x.scope==='all'?'*':x.provider,[['all','Мої провайдери'],...ids.map(id=>[id,providerName(id)]),['*','Весь каталог']])}</div>`;}
 function pickerResults(){
  const x=state.picker,list=chain(x.role,x.group),current=list[x.index],m=current?split(current):null;
  const pool=pickerModels(x),q=x.query.trim(),words=queryWords(q),favs=new Set(state.favs),inProfile=new Set([...Object.values(eff().modelRoles),...Object.values(eff().retry.fallbackChains).flat()].map(v=>split(v).raw)),used=new Set(list.map(v=>split(v).raw));
  const found=pool.filter(a=>(x.provider==='all'||x.provider===a.provider)&&matchesWords(words,searchKey(a).pick));
  const selected=m?(catalogMap.get(m.raw)||{...m,name:short(m.id)}):null;
  if(selected&&!found.some(a=>a.provider+'/'+a.id===m.raw)&&(!q||matchesQuery(q,selected.name,selected.id,selected.provider))&&(x.provider==='all'||x.provider===selected.provider))found.unshift(selected);
  found.sort((a,b)=>Number(b.provider+'/'+b.id===m?.raw)-Number(a.provider+'/'+a.id===m?.raw)||Number(inProfile.has(b.provider+'/'+b.id))-Number(inProfile.has(a.provider+'/'+a.id))||Number(favs.has(b.provider+'/'+b.id))-Number(favs.has(a.provider+'/'+a.id)));
  const shown=found.slice(0,x.limit),filterKey=esc(JSON.stringify([x.role,x.group,x.query,x.provider,x.scope]));pickerResults.count=found.length;
  const rows=shown.map(a=>{const r=a.provider+'/'+a.id;return drawerCut(a,{current:r===m?.raw,used:r!==m?.raw&&used.has(r)});}).join('');
  return `<div class="menu__list" id="picker-results" role="group" aria-label="CUTS · ${found.length}" data-filter-key="${filterKey}">${rows||`<div class="empty"><span class="empty__glyph" aria-hidden="true">∅</span><span>${q?`Нічого не знайдено за «<b>${esc(q)}</b>»`:'Немає доступних CUTS'}</span>${q?'<button type="button" class="key key--sm" data-action="picker-clear"><span class="key__cap">Очистити</span></button>':''}</div>`}${found.length>shown.length?`<div class="tray__more">${key('Ще '+(found.length-shown.length),'picker-more','key--sm')}</div>`:''}</div>`;
 }

 // Only real controls take focus; an automatic lane's wrapper carries the same data attributes.
 function pickerFocus(x){
  const index=Math.max(0,Math.min(x.index,chain(x.role,x.group).length-1));
  const target=[...win.querySelectorAll(`button[data-edit="${CSS.escape(x.role)}"][data-index="${index}"][data-group="${x.group}"]`)].find(el=>el.getClientRects().length);
  target?.focus({preventScroll:true});return !!target;
 }
 // Quick pick replaces the CUT (or fills the socket). A route that already stands elsewhere on this lane is never
 // copied (F7): it moves to the picked place, exactly as a drop from the collection does (commitCut).
 function pickCut(x,route){
  if(!x||state.saving)return;const a=chain(x.role,x.group),previous=a[x.index]?split(a[x.index]):null;if(previous?.raw===route){closePicker();return;}
  if(a.some((r,i)=>i!==x.index&&split(r).raw===route)){state.picker=null;commitCut(route,{role:x.role,index:x.index,group:x.group,profile:state.profile,expected:a[x.index]??null});pickerFocus({role:x.role,group:x.group,index:Math.min(x.index,a.length-1)});return;}
  const prior=previous?.effort||'',old=carryEffort(prior,route);a[x.index]=route+(old?':'+old:'');const ok=setChain(x.role,a,x.group);closePicker();
  if(ok&&prior&&!old&&!thinkingOff(x.role,x.group))notify('Thinking → типово: '+prior+' не підтверджено для нової моделі.');
 }
 // Focus goes back to what opened the menu: the ⋯ key for CUT tools, the CUT (or socket) for the quick pick.
 function closePicker(restore=true){const x=state.picker;state.picker=null;render();if(!restore||!x)return;if(x.lane){focusLaneKey(x.role,x.group);return;}const more=x.actionsOnly&&[...win.querySelectorAll(`[${x.thinking?'data-effort-role':'data-slot-actions'}="${CSS.escape(x.role)}"][data-index="${x.index}"][data-group="${x.group}"]`)].find(el=>el.getClientRects().length);if(more)more.focus({preventScroll:true});else pickerFocus(x);}
 // A changed OFF profile waits for its projection; a failed preview shows the real chain instead.
 function projectionPending(){if(!modeOff()||!diff(state.profile).length)return false;const plan=activePlan();return !plan?.data&&!plan?.error;}
 function pickerActionsPending(){const x=state.picker;return !!(x&&x.group!=='alternatives'&&x.group!=='pool'&&projectionPending());}
 function movePickerCut(direction){
  const x=state.picker;if(!x||state.saving||pickerActionsPending())return;
  const list=chain(x.role,x.group),to=x.index+direction;if(to<0||to>=list.length)return;
  [list[x.index],list[to]]=[list[to],list[x.index]];if(setChain(x.role,list,x.group,{moved:to}))x.index=to;x.focusDirection=direction;render();
  focusPickerMove(direction);
 }
 function focusPickerMove(direction){(win.querySelector(`.menu--tools [data-action=move-node][data-direction="${direction}"]:not(:disabled)`)||win.querySelector('.menu--tools [data-action=move-node]:not(:disabled)')||win.querySelector('.menu--tools [role=menuitem]:not(:disabled)'))?.focus({preventScroll:true});}

 function notify(s){state.toast=s;render();clearTimeout(timer);timer=setTimeout(()=>{state.toast='';paintRegions([leaf('toast','')]);},2700);}
 function openPicker(role,index,group,el,actionsOnly=false,thinking=false){
  if(!actionsOnly&&poolName(chain(role,group)[index])){state.poolTab=poolName(chain(role,group)[index]);editTray('pool',true,el);return;}
  if(group!=='pool')state.poolPanel=false;
  if((group||'role')==='role')state.role=role;
  // A lane socket opens the collection with that place as its target; an editor gives the drawer back to it.
  if(!actionsOnly&&Number(index)>=chain(role,group).length&&group!=='alternatives'&&group!=='pool'&&!(Number(index)===0&&((group||'role')==='role'&&!eff().modelRoles[role]||group==='vibe'&&!agentValues(role).length))){state.poolPanel=false;state.modePanel=false;state.cuts=true;state.cutTarget={role,index:Number(index),group:group||'role'};render();(coarsePointer()?win.querySelector('.tray [data-cut]')||win.querySelector('#cuts-resize'):win.querySelector('#cut-query'))?.focus({preventScroll:true});return;}

  if(!actionsOnly&&temporarySlot(role,index,group)){const route=chain(role,group)[index],key=modeScope(role,group),candidate=modeList(key).findIndex(v=>split(v).raw===split(route).raw);if(candidate>=0){role=key;group='alternatives';index=candidate;}}
  const b=el.getBoundingClientRect();state.picker={role,index:Number(index),group:group||'role',query:'',provider:'all',scope:'mine',limit:20,actionsOnly,thinking,inTray:!!el.closest('.tray'),anchor:{top:b.top,bottom:b.bottom},top:Math.max(12,b.bottom+7),left:Math.max(12,Math.min(b.left,innerWidth-(actionsOnly?264:432)))};render();
  focusPicker();
 }

 // A menu opens at its key and stays inside the window (and above the open drawer); a phone shows it as a sheet.
 // One read after it is mounted; its size never follows the results, so typing or an empty result never moves it.
 function fitPicker(){
  const el=win.querySelector('[data-picker]'),x=state.picker;if(!el||!x||narrowSurface())return;
  // A menu from the page stays above the drawer (open) or its lip (closed); one from inside the drawer may use it.
  const tray=!x.inTray&&win.querySelector('.tray'),covered=tray?(drawerShown()?tray.getBoundingClientRect().height:parseFloat(getComputedStyle(win.querySelector('.tray-port')).getPropertyValue('--lip'))||46):0;
  const box=el.getBoundingClientRect(),floor=innerHeight-12-covered;
  if(x.anchor&&x.top+box.height>floor&&x.anchor.top-7-box.height>=12)x.top=x.anchor.top-7-box.height;
  x.top=Math.max(12,Math.min(x.top,floor-box.height));x.anchor=null;x.left=Math.max(12,Math.min(x.left,innerWidth-box.width-12));el.style.top=x.top+'px';el.style.left=x.left+'px';
 }
 function refreshSearch(id){
  // Keep the real input (selection, IME and native undo) alive: its region is adopted with the typed value,
  // and only result regions are repainted.
  const previousCache=renderCache;renderCache={diffs:new Map(),keys:new Map()};
  try{
   if(id==='role-query'){regions.reopen('p/deck',deckOpen());regions.adopt(leaf('p/role-search',roleSearch()));markMatches();}
   if(id==='picker-search'&&state.picker&&!state.picker.actionsOnly){const results=leaf('picker/results',pickerResults());paintRegions([results,leaf('picker/count',pickerCount())],[leaf('picker/search',pickerSearch())]);}
   if(id==='cut-query'&&drawerShown()&&drawerMode()!=='form'){const cuts=collectionCuts();paintRegions([leaf(editorKind()?'drawer/srchead/count':'drawer/title/count',drawerCount(cuts)),...(editorKind()?[]:[leaf('drawer/hint',drawerHint(cuts.length))]),leaf('drawer/results',drawerResults(cuts))],[leaf('drawer/search',drawerSearch())]);}
   if(id==='catalog-query'&&state.view==='models'){const data=catalogData();paintRegions(catalogBody(data),[leaf('m/source',catalogSearch(data))]);}
  }finally{renderCache=previousCache;}
 }
 // `commit` is the blur-time change event: an unchanged value must not replace the result under the pointer.
 function searchInput(el,commit=false){
  const fields={'role-query':'query','catalog-query':'catalogQuery','cut-query':'cutQuery'},key=fields[el.id];
  if(el.id==='picker-search'){if(!state.picker||commit&&state.picker.query===el.value)return;state.picker.query=el.value;state.picker.limit=20;}
  else if(key){if(commit&&state[key]===el.value)return;state[key]=el.value;if(key==='catalogQuery'){state.analyze=null;state.page=0;}}else return;
  if(!composing)refreshSearch(el.id);
 }
 root.addEventListener('compositionstart',()=>{composing=true;});
 root.addEventListener('compositionend',e=>{composing=false;searchInput(e.target);scheduleBackgroundWork();});
 root.addEventListener('input',e=>{if(e.isComposing)composing=true;searchInput(e.target);});
 root.addEventListener('change',e=>searchInput(e.target,true));
 root.addEventListener('click',e=>{if(e.target.closest('.menu--tools:not(.menu--lane) [data-action]:not([data-action=picker-close])')&&pickerActionsPending()){e.preventDefault();e.stopImmediatePropagation();}},true);
 root.addEventListener('click',e=>{if(e.target.closest('.dock__menu .menu button'))win.querySelector('.dock__menu')?.removeAttribute('open');},true);
 root.addEventListener('toggle',e=>{const menu=e.target;if(menu.matches?.('.dock__menu')&&menu.open&&(!menu.contains(document.activeElement)||document.activeElement.matches('summary'))){menu.querySelector('.menu')?.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});menu.querySelector('[role=menuitem]:not(:disabled)')?.focus({preventScroll:true});}},true);
 root.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b){const n=e.target.closest('[data-node-role]');if(n&&!e.target.closest('select,.cut__think'))openPicker(n.dataset.nodeRole,n.dataset.index,n.dataset.group,n);return;}if(b.dataset.view){state.view=b.dataset.view;state.picker=null;state.armedCut=null;state.cutTarget=null;state.poolPanel=false;state.modePanel=false;state.query='';state.page=0;render();store();return;}if(b.dataset.slotActions){openPicker(b.dataset.slotActions,b.dataset.index,b.dataset.group,b,true);return;}if(b.dataset.effortRole){const x=state.picker;if(x?.thinking&&x.role===b.dataset.effortRole&&x.index===Number(b.dataset.index)&&x.group===b.dataset.group)closePicker();else openPicker(b.dataset.effortRole,b.dataset.index,b.dataset.group,b,true,true);return;}if(b.dataset.catalogProvider){state.catalogProvider=b.dataset.catalogProvider;state.analyze=null;state.page=0;render();return;}if(b.dataset.laneMenu!==undefined){openLaneMenu(b.dataset.laneMenu,b.dataset.group||'role',b);return;}if(b.dataset.edit){openPicker(b.dataset.edit,b.dataset.index,b.dataset.group,b);return;}if(b.dataset.resetAgent){resetAgent(b.dataset.resetAgent);return;}if(b.dataset.agentCopy){copyAgentRole(b.dataset.agentCopy);return;}if(b.dataset.agentRole){focusAgentRole(b.dataset.agentRole);return;}if(b.dataset.focusRole){state.role=b.dataset.focusRole;render();store();return;}if(b.dataset.fav){const r=b.dataset.fav,next=state.favs.includes(r)?state.favs.filter(x=>x!==r):[...state.favs,r];state.favs=next;render();favWrites=favWrites.then(async()=>{try{await api('/api/favorites',{values:next});favSaved=next;}catch(e){if(state.favs===next){state.favs=[...favSaved];render();}notify(e.message);}});return;}if(b.dataset.pick){pickCut(state.picker,b.dataset.pick);return;}

 const a=b.dataset.action;if(a==='reset-agent'){resetAgent(state.picker.role);return;}if(a==='reset-role'){resetRole(state.picker.role);return;}if(a==='lane-override'||a==='lane-reset'||a==='lane-promote'){const x=state.picker;if(x?.lane)({'lane-override':laneOverride,'lane-reset':laneReset,'lane-promote':lanePromote})[a](x.role,x.group);return;}if(a==='to-standard'){state.profile='standard';state.picker=null;state.opFeedback='';render();store();win.querySelector('#profile-choice')?.focus({preventScroll:true});return;}if(a==='save'){await save();}if(a==='undo'||a==='redo')historyStep(a==='undo'?-1:1);if(a==='reset-draft'){state.poolPanel=false;profiles[state.profile]=copy(original[state.profile]);state.picker=null;state.opFeedback='Чернетку '+prettyProfile(state.profile)+' скинуто · можна скасувати ↶';render();win.querySelector('.dock__menu summary')?.focus({preventScroll:true});}if(a==='picker-close')closePicker();if(a==='picker-more'){const offset=win.querySelector('#picker-results').scrollTop;state.picker.limit+=40;render();win.querySelector('#picker-results').scrollTop=offset;}if(a==='picker-clear'){state.picker.query='';state.picker.limit=20;render();win.querySelector('#picker-search')?.focus({preventScroll:true});}if(a==='move-node'){movePickerCut(Number(b.dataset.direction));return;}if(a==='set-effort'){const x=state.picker,list=x&&chain(x.role,x.group);if(!list?.[x.index])return;list[x.index]=split(list[x.index]).raw+(b.dataset.value?':'+b.dataset.value:'');setChain(x.role,list,x.group);closePicker();return;}if(a==='remove-node'){const x=state.picker;if(x&&removeCut(x.role,x.index,x.group)!=='reset')closePicker();return;}if(a==='promote-node'){const x=state.picker;if(!x||x.index===0&&x.group!=='alternatives'&&x.group!=='pool'&&!(poolName(chain(x.role,x.group)[0])&&chain(x.role,x.group).length>1))return;const list=chain(x.role,x.group);list.unshift(list.splice(x.index,1)[0]);x.index=0;setChain(x.role,list,x.group);closePicker();}if(a==='prev-page'||a==='next-page'){turnCatalogPage(a==='next-page'?1:-1,a);}if(a==='provider-add')openForm('provider',{editProvider:null});if(a==='provider-create'){await saveProvider();}

 });
 root.addEventListener('change',e=>{const el=e.target;if(el.id==='profile-choice'){state.poolPanel=false;state.profile=el.value;state.picker=null;state.opFeedback='';state.armedCut=null;state.cutTarget=null;render();store();}if(el.id==='catalog-provider'){state.catalogProvider=el.value;state.analyze=null;state.page=0;render();}if(el.id==='picker-provider'){state.picker.scope=el.value==='*'?'all':'mine';state.picker.provider=el.value==='*'?'all':el.value;state.picker.limit=20;render();if(coarsePointer())win.querySelector('#picker-provider')?.focus({preventScroll:true});else focusPicker();}if(el.id==='picker-effort'){el.focus({preventScroll:true});const x=state.picker,list=chain(x.role,x.group);list[x.index]=split(list[x.index]).raw+(el.value?':'+el.value:'');setChain(x.role,list,x.group);render();}});

 function onKeydown(e){
  const clip=e.target.closest('[data-edit]');
  if(clip?.closest('[data-node-role],.lane__groove,.tray__grid')&&!state.picker&&!state.modal&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Delete'].includes(e.key)){
   e.preventDefault();const {edit:role,group}=clip.dataset,index=Number(clip.dataset.index),list=chain(role,group),step=e.key==='ArrowLeft'?-1:1;
   if(e.shiftKey&&['ArrowLeft','ArrowRight'].includes(e.key)){const to=index+step;if(to>=0&&to<list.length){[list[index],list[to]]=[list[to],list[index]];const ok=setChain(role,list,group,{moved:to});render();pickerFocus({role,group,index:ok?to:index});}return;}
   if(e.key==='Delete'){if(canRemoveCut(role,index,group)){const left=list.length-1,ok=removeCut(role,index,group);if(ok==='reset')return;render();if(!pickerFocus({role,group,index:ok?Math.min(index,left-1):index})&&group==='vibe')win.querySelector(`[data-agent-copy="${CSS.escape(role)}"],.patch[aria-label^="${CSS.escape(role)}:"]`)?.focus({preventScroll:true});}return;}
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
  // Escape in a filled search field clears the field first; the next Escape closes the editor or the drawer.
  if(e.key==='Escape'&&e.target.matches?.('input[type=search]:not(#picker-search)')&&e.target.value){e.preventDefault();e.target.value='';searchInput(e.target);return;}
  if(e.key==='Escape'&&(state.picker||state.modal)){e.preventDefault();if(state.picker){closePicker();return;}const back=state.modal==='confirm'&&state.confirm?.back;if(back)openForm(back);else closeForm();return;}
  if(e.key==='Escape'&&!state.picker&&!state.modal&&(state.poolPanel||state.modePanel)){e.preventDefault();editTray(state.poolPanel?'pool':'alternatives',false);return;}
  if(e.key==='Enter'&&e.target.closest('#new-provider')&&!e.target.matches('textarea,select')){e.preventDefault();win.querySelector('[data-action=provider-create]')?.click();}
  // Колекція list: a listbox; arrows move the selection (and the inspector), PgUp / PgDn turn the page.
  if(e.target.matches?.('.coll__row[role=option]')&&['ArrowDown','ArrowUp','Home','End','PageDown','PageUp'].includes(e.key)){
   e.preventDefault();const rows=analyticalModels(),at=rows.findIndex(m=>m.provider+'/'+m.id===e.target.dataset.analyze),page=state.page*12,last=Math.min(rows.length,page+12)-1;
   const next=e.key==='Home'?page:e.key==='End'?last:e.key==='PageDown'?Math.min(rows.length-1,at+12):e.key==='PageUp'?Math.max(0,at-12):Math.max(0,Math.min(rows.length-1,at+(e.key==='ArrowDown'?1:-1)));
   if(rows[next]&&next!==at)selectCatalogRow(rows[next].provider+'/'+rows[next].id);return;
  }
  // Radio keys (history signal / measure) and the history bars: arrows move and select, the focus follows.
  if(e.target.matches?.('[role=radio][data-radio]')&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)){e.preventDefault();const keys=[...e.target.closest('[role=radiogroup]').querySelectorAll('[role=radio]:not(:disabled)')],n=keys.length,i=keys.indexOf(e.target);keys[e.key==='Home'?0:e.key==='End'?n-1:(i+(['ArrowRight','ArrowDown'].includes(e.key)?1:-1)+n)%n]?.click();return;}
  if(e.target.matches?.('[data-history-bin]')&&['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const n=win.querySelectorAll('[data-history-bin]').length,i=Number(e.target.dataset.historyBin),next=e.key==='Home'?0:e.key==='End'?n-1:Math.max(0,Math.min(n-1,i+(e.key==='ArrowRight'?1:-1)));scrubHistory(next,true);win.querySelector(`[data-history-bin="${next}"]`)?.focus({preventScroll:true});return;}
  // Menus: arrows walk the enabled keys (wrapping), Home / End jump; Escape is handled above.
  const menu=e.target.closest?.('[role=menu]');
  if(menu&&e.target.matches('[role=menuitem],[role=menuitemradio]')&&['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const items=[...menu.querySelectorAll('[role=menuitem]:not(:disabled),[role=menuitemradio]:not(:disabled)')],n=items.length,i=items.indexOf(e.target);items[e.key==='Home'?0:e.key==='End'?n-1:(i+(e.key==='ArrowDown'?1:-1)+n)%n]?.focus();return;}
  // Tabs (FREE GOOD / FREE FAST): arrows move between them and select.
  if(e.target.matches('[role=tab][data-pool-tab]')&&['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const tabs=Object.keys(poolNames),i=tabs.indexOf(e.target.dataset.poolTab),n=tabs.length;selectPoolTab(tabs[e.key==='Home'?0:e.key==='End'?n-1:(i+(e.key==='ArrowRight'?1:-1)+n)%n]);return;}
  if(state.picker&&e.target.closest('[data-picker]')){
   const rows=[...win.querySelectorAll('#picker-results [data-pick]')];
   if(['ArrowDown','ArrowUp'].includes(e.key)&&(e.target.id==='picker-search'||e.target.hasAttribute('data-pick'))){e.preventDefault();const i=rows.indexOf(e.target),next=i<0?(e.key==='ArrowDown'?0:rows.length-1):Math.max(0,Math.min(rows.length-1,i+(e.key==='ArrowDown'?1:-1)));rows[next]?.focus();}
   if(['Home','End'].includes(e.key)&&e.target.hasAttribute('data-pick')){e.preventDefault();rows[e.key==='Home'?0:rows.length-1]?.focus();}
   if(e.key==='Enter'&&e.target.id==='picker-search'){e.preventDefault();if(state.picker.query.trim())rows[0]?.click();else win.querySelector('#picker-results .is-current')?.click();}
  }
 }
 root.addEventListener('keydown',onKeydown);
 // Shortcuts keep working when a re-render left focus on <body>.
 document.addEventListener('keydown',e=>{if(e.target instanceof Element&&!e.composedPath().includes(root))onKeydown(e);});
 document.addEventListener('click',e=>{if(!e.composedPath().some(n=>n.matches?.('.dock__menu')))win.querySelector('.dock__menu')?.removeAttribute('open');if(state.picker&&!e.composedPath().some(n=>n.matches?.('[data-picker],[data-edit],[data-slot-actions],[data-node-role],[data-lane-menu]')))closePicker(false);});
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
  const editing=drawerMode()!=='cuts';d.rect=rect;d.overTray=editing;d.floor=window.innerHeight-(drawerShown()&&(!fromTray||editing)?tray?.getBoundingClientRect().height||lip:lip);
  // The page position is tracked here, so rolling it never reads layout back inside the frame loop.
  d.scroll=window.scrollY;d.maxScroll=Math.max(0,document.documentElement.scrollHeight-window.innerHeight);
  const ghost=document.createElement('div'),cut=ghostCut(d),w=Math.round(Math.max(150,Math.min(220,rect.width))),h=Math.round(Math.max(52,Math.min(76,rect.height)));
  cut.classList.remove('is-armed','is-match','is-src','is-drop','is-changed');cut.removeAttribute('id');cut.setAttribute('aria-hidden','true');for(const el of cut.querySelectorAll('[id]'))el.removeAttribute('id');
  cut.style.width=w+'px';cut.style.height=h+'px';
  ghost.className='ghost';ghost.setAttribute('aria-hidden','true');ghost.innerHTML=`<div class="ghost__sh" style="width:${w}px;height:${h}px"></div>`;ghost.append(cut);
  ghost.style.transform=`translate3d(${rect.left}px,${rect.top}px,0)`;document.body.append(ghost);d.ghost=ghost;
  requestAnimationFrame(()=>ghost.classList.add('is-up'));
  d.node.classList.add('is-src');win.querySelector('#profile-tracks')?.classList.add('is-dragging');
  if(fromTray&&!editing)tray?.classList.add('is-retracted');
 }
 // Edge autoscroll is armed, never instant (QA1 B1). A drag that lifts inside an edge zone (a lane just above the
 // lip, the top of the page) does not roll the page until the pointer has left the zone or moved 24px toward its
 // edge; then it has to rest in the zone for a short dwell, and the page starts slowly. A sideways reorder near the
 // lip therefore never scrolls. Returns px per frame, or null while the dwell is still running.
 function edgeVelocity(d,now){
  const EDGE=72,DWELL=320,MAX=24,zone=d.y<EDGE?-1:d.y>d.floor-EDGE&&!(d.overTray&&d.y>d.floor)?1:0;
  if(d.edgeArmed===undefined)d.edgeArmed=!zone;
  if(!zone){d.edgeArmed=true;d.edgeSince=0;return 0;}
  if(!d.edgeArmed&&(zone<0?d.y0-d.y:d.y-d.y0)>=24)d.edgeArmed=true;
  if(!d.edgeArmed)return 0;
  if(d.edgeZone!==zone||!d.edgeSince){d.edgeZone=zone;d.edgeSince=now;}
  const held=now-d.edgeSince-DWELL;if(held<0)return null;
  return zone*MAX*(zone<0?Math.min(1,(EDGE-d.y)/EDGE):Math.min(1.5,(d.y-(d.floor-EDGE))/EDGE))*Math.min(1,.25+held/600);
 }
 function dragFrame(){
  const d=drag;if(!d?.active)return;d.frame=0;
  markTarget(d,dropTarget(d,d.x,d.y));
  const v=edgeVelocity(d,performance.now());
  d.ghost.style.transform=`translate3d(${d.rect.left+d.x-d.x0}px,${d.rect.top+d.y-d.y0}px,0) rotate(-1.6deg) scale(1.04)`;
  // Wait out the dwell, then keep rolling while the pointer is held at an edge.
  if(v===null){d.frame=requestAnimationFrame(dragFrame);return;}
  if(v){const next=Math.max(0,Math.min(d.maxScroll,d.scroll+(Math.round(v)||Math.sign(v))));if(next!==d.scroll){d.scroll=next;window.scrollTo(0,next);d.frame=requestAnimationFrame(dragFrame);}}
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
   if(setChain(role,list,group,same?{moved:list.indexOf(route)}:{inserted:list.indexOf(route)})){focus={role,group,index:list.indexOf(route)};if(!same){const pool=poolNames[poolName(route)];state.opFeedback=withNotes('Скопійовано '+(pool||'CUT')+' → '+role+(pool||!split(route).effort||chainNotes.some(n=>n.startsWith('thinking прибрано'))?'':' · thinking збережено'));}}
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
  // Only the lane's thinking key is a control; the thinking printed on a drawer CUT is part of the CUT (F8).
  if(drag||e.button!==0||e.pointerType==='touch'||state.saving||e.target.closest('select,button.cut__think,.cut__more,[data-knob],.tray__grip'))return;
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


 // The editable fields of a profile: what diff() reports and what a rebase moves, one path per role, chain and agent.
 function profilePaths(...list){return [...[...new Set(list.flatMap(x=>Object.keys(x.modelRoles||{})))].map(r=>['modelRoles',r]),...[...new Set(list.flatMap(x=>Object.keys(x.retry?.fallbackChains||{})))].map(r=>['retry','fallbackChains',r]),...[...new Set(list.flatMap(x=>Object.keys(x.task?.agentModelOverrides||{})))].map(r=>['task','agentModelOverrides',r]),['disabledProviders'],['forgeMode'],...(list.some(x=>x?.forgePreset)?[['defaultThinkingLevel']]:[])];}
 function diff(name){
  if(renderCache?.diffs.has(name))return renderCache.diffs.get(name);
  const a=original[name],b=profiles[name],out=[];
  for(const path of profilePaths(a,b)){
   const get=o=>path.reduce((v,k)=>v?.[k],o),v=get(b);
   if(JSON.stringify(get(a))!==JSON.stringify(v))out.push(v===undefined?{path,remove:true}:{path,value:v});
  }
  renderCache?.diffs.set(name,out);return out;
 }
 // A draft made on an older file moves onto the current one: every field the draft changed keeps its value and
 // every other field takes the file's. A field both sides changed differently is a conflict: `auto` reports it
 // and changes nothing, `mine` keeps the draft's value, `theirs` takes the file's.
 function rebaseValue(old,next,mine,mode='auto'){
  const out=copy(next),conflicts=[];
  for(const path of profilePaths(old,next,mine)){
   const get=o=>path.reduce((v,k)=>v?.[k],o),m=get(mine),was=JSON.stringify(get(old)),now=JSON.stringify(get(next)),own=JSON.stringify(m);
   if(own===was)continue;
   if(now!==was&&now!==own){conflicts.push(path);if(mode!=='mine')continue;}
   const parent=path.slice(0,-1).reduce((x,k)=>x[k]??={},out);if(m===undefined)delete parent[path.at(-1)];else parent[path.at(-1)]=copy(m);
  }
  return {value:out,conflicts};
 }
 // Drafts that still stand on an older revision of their file (name → {revision, conflicts}). The server's
 // revision stays in source.revisions; a save, a preview and the stored draft send the draft's own base.
 const staleDrafts=new Map();
 function baseRevision(name){return staleDrafts.get(name)?.revision??source.revisions?.[name];}
 function freshProfile(name,from=source){return snapshotProfiles(from)[name]||snapshotProfiles(from).standard;}
 // Moves a draft onto `next`; with `auto` and a conflict it stays where it is and the conflict is returned.
 function rebaseDraft(name,next,mode='auto'){
  const old=original[name],{value,conflicts}=rebaseValue(old,next,profiles[name],mode);
  if(mode==='auto'&&conflicts.length)return conflicts;
  editHistory.rebase(name,entry=>rebaseValue(old,next,entry,mode==='theirs'?'theirs':'mine').value);
  original[name]=copy(next);profiles[name]=value;staleDrafts.delete(name);return [];
 }
 // «FREE GOOD: curator, агент scout» — the pool blocks an adoption keeps or turns into the file's own CUTS.
 function adoptPoolNote(plan,error){
  if(error)return '<div class="msg" data-s="warn">'+led(true,'amber')+'<span>Не вдалося перевірити блоки FREE-пулів ('+esc(error)+'). Блок, який файл не повторює дослівно, стане окремими CUTS.</span></div>';
  const where=k=>k.startsWith('role:')?k.slice(5):k.startsWith('vibe:')?'агент '+k.slice(5):'резерви default',list=items=>{const by=new Map();for(const k of items){const pool=poolNames[k.pool]||k.pool;if(!by.has(pool))by.set(pool,new Set());by.get(pool).add(where(k.key));}return [...by].map(([pool,at])=>pool+': '+[...at].join(', ')).join(' · ');};
  return (plan?.lost?.length?'<div class="msg" data-s="warn">'+led(true,'amber')+'<span>Файл уже не повторює дослівно ці блоки пулів, тож вони стануть окремими CUTS із файлу — '+esc(list(plan.lost))+'.</span></div>':'')+(plan?.kept?.length?'<div class="msg" data-s="ok">'+led(true,'green')+'<span>Лишаються блоками пулів — '+esc(list(plan.kept))+'.</span></div>':'');
 }
 // «2 зміни: composer · основна, judge · резерви» — what an unsaved draft of this profile holds.
 function draftSummary(name){const changes=diff(name);if(!changes.length)return '';const labels=[...new Set(changes.map(c=>pathLabel(c.path)))];return changes.length+' '+plural(changes.length,'зміна','зміни','змін')+': '+labels.slice(0,3).join(', ')+(labels.length>3?' і ще '+(labels.length-3):'');}
 function pathLabel([a,b,c]){return a==='modelRoles'?b+' · основна':a==='retry'?c+' · резерви':a==='task'?'агент '+c:a==='disabledProviders'?'провайдери профілю':a==='forgeMode'?'режим DeepSeek':a==='defaultThinkingLevel'?'thinking котушки':[a,b,c].filter(Boolean).join('.');}
 // Server problems with a code get a clear line instead of the generic «змінились вихідні дані» dialog.
 const PROBLEM_CODES=new Set(['mode-recovery','symlink','mode-conflict','parent','deepseek-mode']);
 function problemText(d){
  const text=d.error||'Не вдалося виконати дію',files=(d.files||d.profiles||[]).join(', ');
  if(d.code==='mode-recovery')return 'Незавершене збереження: '+text+(files?' · файли: '+files:'');
  if(d.code==='symlink')return 'Файл — символьне посилання: '+text;
  if(d.code==='mode-conflict')return d.scope?text:'Файл профілю змінено поза Mana Tape: '+text+(files?' · '+files:'')+' · «Прийняти файл» на монтажі';
  if(d.code==='derived')return 'Запис змінить більше, ніж ця дія: перекомпіляція проти поточного глобального файлу, каталогу чи пулів (рядки нижче). Натисни ще раз, щоб записати й це.';
  return text;
 }
 // A write that would also change what the owner did not ask for answers 409 `derived` with those lines and a token;
 // the same action sent again (after the owner saw the lines) carries the token and is written as previewed.
 async function api(path,body){
  const writes=path!=='/api/profile-preview';if(writes){writeEpoch++;activeWrites++;}
  const dkey=writes?path+'\n'+JSON.stringify([body.action||'',body.profile||'',body.preset||'',body.paths||'',body.mode||'',body.source||'']):'',held=state.derivedOk;
  if(writes&&held?.key===dkey&&body.confirm===undefined)body={...body,confirm:held.token};
  try{const r=await fetch(endpoint(path),{method:'POST',headers:{'Content-Type':'application/json','X-Forge-CSRF':source.csrf},body:JSON.stringify(body),signal:deadline(writes?30000:20000)});const d=await r.json();if(!r.ok){const e=Error(problemText(d));e.status=r.status;e.code=d.code||'';e.files=d.files||d.profiles||[];e.diffs=d.diffs||null;e.scopes=d.scopes||null;e.scope=d.scope||'';e.derived=d.derived||null;e.token=d.token||'';if(d.code==='derived')state.derivedOk={key:dkey,token:d.token};throw e;}if(state.derivedOk?.key===dkey&&!body.dry)state.derivedOk=null;return d;}
  catch(e){
   // No answer in time: a write may or may not have landed, so the state is read again as soon as possible.
   if(e?.name==='TimeoutError'||e?.name==='AbortError'){const t=Error(writes?'Сервер не відповів за 30 с. Невідомо, чи зміни записано: чернетка лишилась у вікні, стан перечитується.':'Сервер не відповів вчасно. Спробуй ще раз.');t.status=0;t.code='timeout';if(writes)backgroundRefreshPending=true;throw t;}
   if(e instanceof TypeError&&!e.status){const t=Error('Немає зв’язку із сервером. Чернетка лишилась у вікні.');t.status=0;t.code='offline';throw t;}
   throw e;
  }
  finally{if(writes){writeEpoch++;activeWrites--;scheduleBackgroundWork();}}
 }
 function interactionBusy(preview=false){
  const focused=document.activeElement,select=focused?.matches('select'),selectOpen=select&&(CSS.supports('selector(select:open)')?focused.matches(':open'):nativeSelectBusy);
  return document.hidden||composing||pointerHeld||activeWrites||document.documentElement.dataset.displayTuning||state.modal||state.picker&&(!preview||!state.picker.actionsOnly)||state.saving||state.profileBusy||state.providerSaving||drag||drawerGesture||focused?.matches('input,textarea')||select&&(!preview||selectOpen)||win.querySelector('.dock__menu[open]');
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
 function routeWarning(raw){const m=catalogMap.get(raw),pid=split(raw).provider;return m?.status==='missing'||source.providers.find(p=>p.id===pid)?.expired||(eff().disabledProviders||[]).includes(pid);}
 function rebuild(){
  referenced.clear();for(const own of Object.values(profiles)){const pr=eff(own);for(const r of [...Object.values(pr.modelRoles),...Object.values(pr.retry?.fallbackChains||{}).flat(),...Object.values(pr.task?.agentModelOverrides||{}).flat(),...(pr.forgeMode?.alternatives||[]),...Object.values(pr.forgeMode?.overrides||{}).flat()])if(typeof r==='string'&&r.includes('/'))referenced.add(split(r).raw);}
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
  const r=await fetch(endpoint('/api/state'),{cache:'no-store',...(background&&stateTag?{headers:{'If-None-Match':stateTag}}:{}),signal:deadline(background?10000:15000)});
  const ageChanged=snapshot=>(snapshot.insights?.usage?.reports||[]).some(report=>!report.stale&&report.at&&((Date.now()/1000-report.at>900)!==(renderedAt/1000-report.at>900)));
  if(r.status===304){if(state.offline||ageChanged(source)){state.offline=false;pendingRender=true;scheduleBackgroundWork();}return;}
  if(!r.ok)throw Error('Немає зв’язку із сервером');const fresh=await r.json(),tag=r.headers?.get?.('ETag')||'';
  if(background&&(interactionBusy()||epoch!==writeEpoch)){backgroundRefreshPending=true;scheduleBackgroundWork();return;}
  fresh.base=normalizeProfile(fresh.base);
  const freshnessChanged=ageChanged(fresh);
  if(background&&!state.offline&&!freshnessChanged&&snapshotFingerprint(fresh)===snapshotFingerprint(source)){source.tariff=fresh.tariff;stateTag=tag;return;}
  stateTag=tag;
  const next=snapshotProfiles(fresh);
  for(const k of Object.keys(profiles))if(!next[k]&&(discard||!diff(k).length)){delete profiles[k];delete original[k];staleDrafts.delete(k);}
  // A draft whose file moved on is rebased at once (QA1 B2): its own fields stay, the rest follows the file. Only a
  // field changed on both sides keeps it on its old revision, and «Конфлікт…» on the lip offers the choice.
  for(const [k,v]of Object.entries(next)){
   if(!discard&&profiles[k]&&diff(k).length){const base=baseRevision(k);if(base===fresh.revisions?.[k]){staleDrafts.delete(k);continue;}const conflicts=rebaseDraft(k,v,'auto');if(conflicts.length)staleDrafts.set(k,{revision:base,conflicts});continue;}
   profiles[k]=copy(v);original[k]=copy(v);staleDrafts.delete(k);
  }
  if(discard||!poolsDirty()){poolOriginal=copy(fresh.freePools);poolDraft=copy(poolOriginal);poolRevision=fresh.poolsRevision;}
  source=fresh;globalLayer=normalizeLayer(fresh.inherited);globalLogical=normalizeLayer(fresh.inheritedLogical||fresh.inherited);profileKeys.splice(0,profileKeys.length,...Object.keys(profiles));roleKeys.splice(0,roleKeys.length,...knownRoleKeys(profiles.standard));
  if(!profiles[state.profile])state.profile='standard';state.favs=favSaved=fresh.favs||[];rebuild();state.offline=false;render();
  }finally{if(background)backgroundReloading=false;}
 }
 // What stops a profile save before any request: a file changed outside Mana Tape (this profile or Standard) or an
 // interrupted save. A pending or failed preview does not: save() runs its own preview.
 function saveBlocker(){const outside=(source.modeConflicts||[]).filter(n=>n==='standard'||n===state.profile);return source.modeRecovery?'Збереження заблоковане: незавершене збереження режимів':outside.length?'Збереження заблоковане: файл '+outside.map(prettyProfile).join(', ')+' змінено поза Mana Tape · «Прийняти файл»':'';}
 async function save(){
  if(state.saving)return;const name=state.profile,saved=copy(profiles[name]);if(!diff(name).length)return;
  if(staleDrafts.has(name)){openForm('conflict',{error:''});return;}
  const blocker=saveBlocker();if(blocker){notify(blocker);return;}
  const displayed=activePlan()?.data;state.saving=true;render();
  try{
   const body=modeBody(name),preview=await api('/api/profile-preview',body);
   pendingModeResults.delete(name);state.modePlans[name]={key:modeKey(name),data:preview};
   if(preview.issues.length)throw Error('Додай доступну заміну для позначених ролей.');
   if(saved.forgeMode.mode==='no-deepseek'&&(!displayed||displayed.token!==preview.token)){notify('Заміни оновились. Переглянь карту й збережи ще раз.');return;}
   await api('/api/profile',{...body,previewToken:preview.token});
   original[name]=saved;state.opFeedback='Профіль збережено для нових запусків OMP.';delete state.modePlans[name];editHistory.reset(name,original[name]);
   await reload();notify('Збережено · '+(saved.forgeMode.mode==='no-deepseek'?'Без DeepSeek':'З DeepSeek'));
  }catch(e){
   // The file moved on under the draft: rebase it now; only a field changed on both sides asks (QA1 B2).
   if(e.code==='revision'){state.opFeedback='';try{await reload();}catch{}if(staleDrafts.has(name)){Object.assign(state,{modal:'conflict',modalError:'',modalCode:'',formErrors:{},error:''});modalFit='';}else notify('Файл змінився поза цим вікном. Чернетку перенесено на актуальний файл: перевір і збережи ще раз.');}
   // The save would also write what nobody asked for (DeepSeek OFF reaching a Global role, a catalogue change):
   // shown in a confirmation first; «Зберегти й це» sends the same save with the server's token (M1).
   else if(e.code==='derived'){state.error='';askConfirm({action:'save-derived',focus:'[data-action=save]',title:'Збереження змінить більше',sub:prettyProfile(name),label:'Зберегти й це',text:'Окрім твоїх змін збереження перекомпілює файл проти поточного глобального файлу, каталогу й пулів і тому запише ще й це (наприклад, DeepSeek OFF доходить до ролі, успадкованої з глобального):',note:derivedNote(e.derived)});}
   else if(e.status===409&&!PROBLEM_CODES.has(e.code)){Object.assign(state,{modal:'conflict',modalError:'',modalCode:'',formErrors:{},error:e.message});modalFit='';}else state.error=e.message;render();}
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
  // A Global котушка seen from a project is read-only; a котушка holds only role primaries (DESIGN «Області і котушки»).
  if(locked()&&group!=='pool'){notify('Глобальна котушка тут лише для перегляду й «Застосувати». Редагуй її в області «Глобально».');return false;}
  if(presetLike()&&(group==='vibe'||group==='role'&&JSON.stringify(list.slice(1))!==JSON.stringify(chain(role,group).slice(1)))){notify('Котушка OMP несе лише основні CUTS ролей і thinking. Резерви й агенти змінюй у Standard.');return false;}
  const ownBefore=group==='role'||group==='vibe'?ownParts(role,group):null;
  // Each edit speaks for itself: an older line (a copy, an Undo, a save) never outlives the next edit.
  state.opFeedback='';state.editorMsg='';
  if(thinkingOff(role,group)){
   // Roles without chat-thinking reject an effort suffix; strip it from every inserted or replaced CUT.
   const current=chain(role,group),next=list.map(r=>current.includes(r)||poolName(r)||String(r).startsWith('@')?r:split(r).raw);
   if(next.some((r,i)=>r!==list[i]))chainNotes.push('thinking прибрано: '+(group==='role'?role:role.slice(5))+' не використовує thinking');
   list=next;
  }
  const unfit=list.find(r=>!poolName(r)&&catalogMap.has(split(r).raw)&&!acceptsRoleModel(role,group,catalogMap.get(split(r).raw)));
  if(unfit){const m=catalogMap.get(split(unfit).raw),vision=group==='pool'?poolVisionLane(role):'';notify(vision?poolNames[role]+' стоїть на доріжці зору ('+vision+'): '+cutTitle(unfit)+' не читає зображень.':cutTitle(unfit)+' не підтримує роль '+(group==='alternatives'?String(role).replace(/^role:/,''):role)+(!readsImages(m)&&acceptsRoleModel(role,group,{...m,input:['image']})?' · потрібен зір':'')+'.');return false;}
  if(group!=='pool'){
   // A FREE pool block obeys the lane's rule as a whole, as on the server (F1): every saved member must suit the
   // role (on a vision lane: read images). A block that already stood on the lane is not judged again.
   const current=chain(role,group),id=group==='alternatives'?String(role).replace(/^role:/,''):role;
   for(const token of list){const name=poolName(token);if(!name||current.includes(token))continue;const bad=(source.freePools?.[name]||[]).find(r=>{const m=catalogMap.get(split(r).raw);return m&&!acceptsRoleModel(role,group,m);});if(bad){const m=catalogMap.get(split(bad).raw),vision=!readsImages(m)&&acceptsRoleModel(role,group,{...m,input:['image']});notify(poolNames[name]+(vision?' не стане на доріжку зору '+id+': '+cutTitle(bad)+' не читає зображень.':' не підходить ролі '+id+': '+cutTitle(bad)+' не підтримує цю роль.'));return false;}}
   // A lane never holds one route twice (F7). Every edit path dedupes; this refuses one that would not.
   if(group!=='alternatives'){const raws=l=>l.map(r=>poolName(r)?r:split(r).raw),twice=l=>{const a=raws(l);return a.length-new Set(a).size;};if(twice(list)>twice(current)){const seen=new Set(),dup=raws(list).find(r=>seen.has(r)||!seen.add(r));notify((poolNames[poolName(dup)]||cutTitle(dup))+' уже стоїть на цій доріжці.');return false;}}
  }
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
  // Roles that inherit default's reserves change with it; their agents' copies follow too (QA1 B8).
  const heirs=group==='role'&&role==='default'&&state.syncVibe?roleKeys.filter(r=>inheritsDefault(r)).map(r=>[r,baseChain(r).slice(1)]):[];
  if(view?.refs&&!hint.base){if(!applyModeEdit(role,list,group,view,hint))return false;}
  else oldSetChain(role,list,group);
  if(inherited&&Object.hasOwn(p().retry.fallbackChains,role))chainNotes.push(roleFallbacks(role).length?'Резерви default скопійовано в '+role+'; доріжка більше не слідує за default':role+' більше не бере резерви default');
  if(group==='role'&&state.syncVibe)syncAgentTails(role,before);
  for(const [heir,was] of heirs)if(inheritsDefault(heir))syncAgentTails(heir,was);
  const added=ownBefore&&ownParts(role,group).filter(part=>!ownBefore.includes(part));
  if(added?.length)chainNotes.unshift('Перевизначено в проєкті: '+role+' · '+added.join(', ')+' · глобальний файл не змінено');
  if(chainNotes.length)state.opFeedback=chainNotes.join(' · ');
  return true;
 }
 // The parts of a lane a project now holds over its Global inheritance (for the «перевизначено» line).
 function ownParts(role,group){
  if(!globalLayer||state.profile!=='standard')return [];
  const own=p();if(group==='vibe')return Object.hasOwn(own.task.agentModelOverrides,role)&&globalHas(role,'vibe')?['список агента']:[];
  const g=globalLayer.retry.fallbackChains,chains=own.retry.fallbackChains;
  return [own.modelRoles[role]&&globalLayer.modelRoles[role]&&'основна',Object.hasOwn(chains,role)&&(Object.hasOwn(g,role)||!Object.hasOwn(chains,'default')&&!!g.default?.length)&&'резерви'].filter(Boolean);
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
  const old=view.routes||[],scope=modeScope(role,group),base=group==='vibe'?agentValues(role):baseChain(role),used=new Set();
  // An agent's substituted @role head shows the role's replacement: an edit of it edits that replacement list and
  // keeps the @role link (QA1 B4); it cannot be moved away from the head in OFF.
  const headRef=group==='vibe'&&view.alias&&view.substituted&&view.refs[0]?.kind==='base'?{kind:'replacement',route:old[0],key:scope}:null,refs=headRef?[headRef,...view.refs.slice(1)]:view.refs;
  const items=list.map(route=>({route,ref:null,from:-1,same:false}));
  items.forEach((item,i)=>{if(i===inserted)return;const j=old.findIndex((r,k)=>!used.has(k)&&r===item.route);if(j>=0){used.add(j);Object.assign(item,{ref:refs[j],from:j,same:true});}});
  // A replacement in place (pick, thinking, collection) keeps the position's source.
  if(inserted<0&&list.length===old.length)items.forEach((item,i)=>{if(!item.ref&&!used.has(i)&&refs[i]){used.add(i);Object.assign(item,{ref:refs[i],from:i});}});
  // A dropped CUT that already stood among the ⇄ replacements joins the real chain; the replacement stays.
  const kept=inserted>=0?refs.findIndex((r,k)=>!used.has(k)&&r.kind==='replacement'&&split(old[k]).raw===split(list[inserted]).raw):-1;
  const replacement=item=>item.ref?.kind==='replacement'&&(item.ref.key||scope)===scope;
  if(headRef&&moved>=0&&items[0]?.ref!==headRef){notify('Агент бере основну з '+view.alias+'. У режимі OFF її місце не змінюється: порядок — в ON, заміни — у «Заміни» ролі '+view.alias.slice(1)+'.');return false;}
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
  if(JSON.stringify(routes)!==JSON.stringify(own)){modeSettings().overrides[scope]=routes;if(group==='vibe'&&scope.startsWith('role:'))chainNotes.push('Заміни ролі '+scope.slice(5)+' змінено: '+role+' бере їх через @'+scope.slice(5)+', доріжка ролі теж');}
  return true;
 }
 function store(){try{localStorage.setItem(storageKey('forge-view'),JSON.stringify({view:state.view,profile:state.profile,role:state.role,syncVibe:state.syncVibe}));}catch{}}

 function limitLabel(limit){
  const period=limit.window||'',at=(limit.label||'').toLowerCase().indexOf(period.toLowerCase());
  let scope=limit.label||'';
  if(period&&at>=0)scope=scope.slice(0,at)+scope.slice(at+period.length);
  scope=scope.replace(/\b(usage|limit)\b/gi,'').replace(/[()]/g,'').replace(/^[\s·:–—-]+|[\s·:–—-]+$/g,'');
  const windowLabel=({'5 hour':'5 год','5-hour':'5 год','7 day':'7 днів','7 days':'7 днів','weekly':'Тиждень','monthly':'Місяць'})[period.toLowerCase()]||period;
  return [scope,windowLabel].filter(Boolean).join(' · ')||limit.label||'Період';
 }
 // Every CommandCode account shows the same windows in the same order — 5 год, Тиждень, Місяць (its balance, see
 // insights.commandcode_month); a window OMP did not measure for that account stays its own «немає виміру» cell.
 function usageReports(){
  const reports=(source.insights?.usage?.reports||[]).map(r=>({...r,stale:!!r.stale||!r.at||Date.now()/1000-r.at>900,limits:[...r.limits]}));
  if(!reports.some(r=>r.provider==='commandcode')&&myProviderIds().has('commandcode'))reports.push({provider:'commandcode',at:0,source:'CodexBar · Mac',limits:[]});
  for(const r of reports.filter(r=>r.provider==='commandcode')){
   const rest=[...r.limits];
   r.limits=[['primary','5 год',/5.*(hour|год)/i],['secondary','Тиждень',/week|тиж|7.*day/i],['tertiary','Місяць',/month|місяц/i]].map(([id,label,pattern])=>{
    const at=rest.findIndex(l=>pattern.test(l.window+' '+l.label));return at<0?{id,label,window:'',remaining:null}:rest.splice(at,1)[0];}).concat(rest);
  }
  return reports;
 }

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
 // Evidence on the body: every block names its kind in words (незалежний тест / Arena · уподобання / заява
 // розробника), the source, the period and the tested version. Scores are 0–100 segment bars; Arena is a rating,
 // printed as a number without a bar.
 const EVIDENCE_KIND={benchmark:['незалежний тест','ok'],preference:['Arena · уподобання',''],developer:['заява розробника','warn']};
 function evidenceChip(r){const [label,s]=EVIDENCE_KIND[evidence.kind(r)]||EVIDENCE_KIND.benchmark;return `<span class="chip${s?' chip--'+s:''}">${label}</span>`;}
 function evidenceCard(r,full=false){
  const kind=evidence.kind(r),preference=kind==='preference',developer=kind==='developer',scores=Object.entries(r.scores||{}),shown=full?scores:scores.slice(0,1),status=source.insights?.benchmarks?.sources?.[r.source];
  return `<article class="ev"><header class="ev__head">${evidenceChip(r)}<b>${esc(developer?r.publisher:r.source)}</b><span class="print print--hint">${esc(r.dateKind||'Зріз')} · ${esc(r.release)}${status?.error?' · останній знімок':''}</span></header><p class="print print--hint ev__ver">${esc(r.id)}${r.effort?' · '+esc(r.effort):' · режим джерела'}${r.samples?' · '+num(r.samples)+' задач':''}</p>${preference?`<div class="ev__rating"><b class="rd rd--l" style="--rd:5ch">${num(r.rating)}</b><span class="print">рейтинг${r.preliminary?' · попередній':''}${r.interval?' · інтервал '+num(r.interval[0])+'–'+num(r.interval[1]):''} · ${num(r.votes)} голосів</span></div>`:`<div class="ev__rows">${shown.map(([k,v])=>`<div class="ev__row"><span>${esc(k)}</span><span class="ev__bar" style="--v:${(Math.max(0,Math.min(100,v))/100).toFixed(3)}" aria-hidden="true"><i></i></span><b class="rd" style="--rd:6ch">${num(v)}%</b></div>`).join('')}</div>`}${!full&&scores.length>shown.length?`<p class="print print--hint">Ще ${scores.length-shown.length} · у всіх даних</p>`:''}${full||preference?`<p class="print print--hint">${esc(r.note||'Результат тестованої моделі; провайдер і умови запуску можуть відрізнятися.')}${r.potentialOverlap?' Частина задач могла передувати випуску моделі.':''}</p>`:''}<a class="key key--sm ev__src" href="${esc(r.url)}" target="_blank" rel="noreferrer"><span class="key__cap">${developer?'Картка моделі':'Джерело'} ↗</span></a></article>`;
 }
 function evidenceDeck(m,full=false){
  const records=modelRecords(m),rows=full?evidence.latest(records):evidence.summary(records);
  if(!rows.length)return '<div class="empty"><span class="empty__glyph" aria-hidden="true">∅</span><span>Для цієї версії зіставлених тестів ще немає. Характеристики вище — з каталогу провайдера; вони не визначають якість.</span></div>';
  return `<div class="ev-deck" aria-label="Виміри моделі">${rows.map(r=>evidenceCard(r,full)).join('')}</div>${!full&&evidence.latest(records).length>rows.length?'<p class="print print--hint">Інші тестовані режими — у всіх даних.</p>':''}`;
 }
 // A printed key–value row on the body (dotted leader, tabular value).
 const pkv=(k,v)=>`<div class="pkv"><span>${k}</span><i aria-hidden="true"></i><b>${v}</b></div>`;
 function priceLine(m){const price=priceInfo(m);return `${price.kind==='free'?'<span class="stamp stamp--free">FREE</span> ':''}${esc(price.label)}${price.subscription?' · підписка, API-тариф':price.variable?' · змінний тариф':''}`;}
 function detailsMarkup(){const m=catalogMap.get(state.detail)||{...split(state.detail),name:split(state.detail).id};
  return `<div class="det"><div class="det__id"><b>${esc(cutTitle(state.detail))}</b><span class="print">${esc(providerName(m.provider))} · ${esc(state.detail)}</span></div><div class="det__kv">${pkv('Контекст',m.contextWindow?contextTokens(m.contextWindow):'—')}${pkv('Вихід',m.maxTokens?contextTokens(m.maxTokens):'—')}${pkv('Зір',Array.isArray(m.input)?m.input.includes('image')?'так':'ні':'—')}${pkv('Міркування',m.reasoning===true?'так':m.reasoning===false?'ні':'—')}${pkv('Ціна · вхід / вихід $/1M',priceLine(m))}</div><p class="print print--hint">Тести — для конкретної версії моделі, не гарантія якості FREE-маршруту. Рейтинги Arena й заяви розробника не входять у бал ролі.</p>${evidenceDeck(m,true)}</div>`;
 }

 // In an installation (scopes) a copy is always a native OMP котушка (modelPresets): its name starts with a letter.
 function nativeClones(){return !!(source.scope?.parent||source.scope?.kind==='global'||(source.projects||[]).some(x=>x.kind)||Object.values(source.nativePresets||{}).some(x=>x.own));}
 function profileNameResult(value,renaming=false){
  const result=ManaOperator.profileName(value),native=renaming?isNative(state.profile):nativeClones(),keyOf=n=>native?'preset:'+n:n;
  if(!result.error&&native&&!/^[a-z]/.test(result.name))result.error='Назва котушки OMP починається з латинської літери.';
  else if(!result.error&&result.name==='standard'&&(!renaming||state.profile!=='standard'))result.error='Standard — основний профіль. Обери іншу назву.';
  else if(!result.error&&profileKeys.includes(keyOf(result.name))&&(!renaming||keyOf(result.name)!==state.profile))result.error='Котушка «'+result.name+'» уже є. Обери іншу назву.';
  return result;
 }
 function profileNameHint(value,renaming=false){const q=profileNameResult(value,renaming),native=renaming?isNative(state.profile):nativeClones();return value.trim()?(q.error||(native?'Котушка OMP: ':'В OMP: ')+q.name):native?'Латиниця, з літери. Пробіли → дефіс, великі літери → малі.':'Латиниця й цифри. Пробіли → дефіс, великі літери → малі.';}
 // Field errors are printed under their own window (red outline + text), never as a browser bubble.
 function checkProfileName(form,show=false){
  const input=form.elements.name,renaming=form.id==='rename-form',q=profileNameResult(input.value,renaming),bad=!!q.error&&(show||!!input.value.trim());
  const field=input.closest('.field');field?.classList.toggle('is-bad',bad);input.setAttribute('aria-invalid',String(bad));
  const note=form.querySelector('.profile-name-hint');if(note)note.textContent=profileNameHint(input.value,renaming);return q;
 }
 // FORMS live in the drawer (DESIGN «Меню»): the front shows the title and ×; the body is the form with recessed
 // windows, its keys at the foot; the device body is inert while it is open (role=dialog, aria-modal).
 function formField(name,label,input,{note='',wide=false,hint=false}={}){const bad=state.formErrors?.[name]||'';return `<div class="field${bad?' is-bad':''}${wide?' field--wide':''}" data-field="${name}"><label class="field__lab" for="f-${name}">${label}</label><div class="field__win">${input}</div><span class="field__note${hint?' profile-name-hint':''}" id="f-${name}-note"${hint?' aria-live="polite"':''}>${esc(bad||note)}</span></div>`;}
 const formAttrs=(name,extra='')=>`id="f-${name}" name="${name}" aria-describedby="f-${name}-note"${state.formErrors?.[name]?' aria-invalid="true"':''} ${extra}`;
 function formFoot(keys,note=''){return `<div class="tray__foot">${note?`<span class="print print--hint">${note}</span>`:'<span class="tray__grow"></span>'}${keys}</div>`;}
 function formSpec(){
  const kind=state.modal,busy=state.profileBusy||state.providerSaving,cancel=key('Скасувати','modal-close');
  if(kind==='provider'){
   const v=state.editProvider?source.providers.find(x=>x.id===state.editProvider):null,opt=(items,value)=>items.map(([k,l])=>`<option value="${k}" ${value===k?'selected':''}>${l}</option>`).join('');
   const fields=[formField('name','Назва',`<input ${formAttrs('name','required maxlength="80"')} value="${esc(v?.name||'')}" placeholder="Мій провайдер" autocomplete="off">`,{note:'Показується на CUT і в панелі підписок'}),
    formField('id','ID провайдера',`<input ${formAttrs('id','required maxlength="64" spellcheck="false"')} value="${esc(v?.id||'')}" ${v?'readonly':''} placeholder="my-provider" autocomplete="off">`,{note:v?'Не змінюється':'Малі латинські літери, цифри, дефіс'}),
    formField('url','API base · адреса',`<input type="url" ${formAttrs('url','required spellcheck="false"')} value="${esc(v?.url||'')}" placeholder="https://api.example.com/v1" autocomplete="off">`,{note:'HTTP(S), без ключів, логіна й параметрів',wide:true}),
    formField('api','Формат API',`<select ${formAttrs('api')}>${opt([['openai-completions','OpenAI Chat'],['openai-responses','OpenAI Responses'],['anthropic-messages','Anthropic']],v?.api||'openai-completions')}</select>`),
    formField('auth','Авторизація',`<select ${formAttrs('auth')}>${opt([['apiKey','API-ключ'],['none','Без ключа']],v?.auth||'apiKey')}</select>`),
    formField('key','API-ключ',`<input type="password" ${formAttrs('key','autocomplete="new-password"')} placeholder="${v?.hasKey?'Збережений на сервері':'Ключ провайдера'}">`,{note:v?.hasKey?'Порожньо — лишити збережений ключ (для тієї самої адреси)':'Зберігається на сервері, не в профілі'}),
    formField('discovery','Список моделей',`<select ${formAttrs('discovery')}>${opt([['openai-models-list','Отримувати через /models'],['','Ввести вручну'],['ollama','Ollama'],['llama.cpp','llama.cpp'],['lm-studio','LM Studio'],['litellm','LiteLLM']],v?v.discovery:'openai-models-list')}</select>`),
    formField('days','Термін дії',`<select ${formAttrs('days')}>${v?.expires&&!v.expired?'<option value="-1" selected>Зберегти поточний термін</option>':''}<option value="0">Без обмеження</option><option value="1">24 години</option><option value="7">7 днів</option><option value="30">30 днів</option></select>`,{note:'Після терміну невикористане підключення видаляється'}),
    formField('models','Model ID · по одному на рядок',`<textarea ${formAttrs('models','rows="3" spellcheck="false"')} placeholder="model-id">${esc(v?.manualModels?.join('\n')||'')}</textarea>`,{note:'Додаткові ID або весь список, якщо його не отримувати',wide:true})];
   return {title:v?'Провайдер · '+(v.name||v.id):'Новий провайдер',focus:v?'#f-name':'#f-name',wide:true,
    body:`<form id="new-provider" class="form" autocomplete="off" novalidate>${fields.join('')}${formFoot(`${cancel}${key(state.providerSaving?'Збереження…':'Зберегти провайдера','provider-create','key--action',state.providerSaving?'disabled':'')}${v?'<span class="seam seam--v" aria-hidden="true"></span>'+key(led(true,'red')+'Видалити','delete-provider','key--danger',busy?'disabled':''):''}`,'Активні сесії OMP не змінюються. Прострочене підключення в профілях позначиться для заміни.')}</form>`};
  }
  if(kind==='details')return {title:'Дані CUT',sub:cutTitle(state.detail),focus:'[data-action=modal-close]',wide:true,body:detailsMarkup()+formFoot(`<button type="button" class="key key--sm" data-fav="${esc(state.detail)}" aria-pressed="${state.favs.includes(state.detail)}"><span class="key__cap">${state.favs.includes(state.detail)?'★ В обраних':'☆ До обраних'}</span></button>${key('Закрити','modal-close')}`)};
  // A draft on an older file: the fields both sides changed, and one choice for them. Every other change of the
  // draft moves onto the current file whichever key is pressed (the same dialog opens from the lip and from ⌘S).
  const stale=kind==='conflict'&&staleDrafts.get(state.profile);
  if(stale){const fields=stale.conflicts.length?stale.conflicts.map(path=>`<b>${esc(pathLabel(path))}</b>`).join(', '):'';return {title:'Конфлікт із файлом',sub:prettyProfile(state.profile),focus:'[data-action=modal-close]',body:`<div class="msg" data-s="warn">${led(true,'amber')}<span>Файл профілю ${esc(prettyProfile(state.profile))} змінився після початку цієї чернетки</span></div><p class="print">${fields?'Обидві сторони змінили: '+fields+'. ':''}Решта твоїх змін переноситься на актуальний файл у будь-якому разі. «Лишити мої» бере твої значення цих полів, «Взяти з файлу» — значення з файлу.</p>${formFoot(`${cancel}${key('Експорт чернеток','export-draft')}${key('Взяти з файлу','conflict-theirs')}${key('Лишити мої','conflict-mine','key--action')}${key(led(true,'red')+'Скинути чернетку','conflict-discard','key--danger')}`)}`};}
  if(kind==='conflict')return {title:'Змінились вихідні дані',focus:'[data-action=export-draft]',body:`<div class="msg" data-s="warn">${led(true,'amber')}<span>${esc(state.error||'Конфігурацію змінено зовні.')}</span></div><p class="print">Твоя чернетка лишилась у вікні. Експортуй її перед завантаженням актуального профілю.</p>${formFoot(`${key('Експорт чернеток','export-draft')}${key(led(true,'red')+'Скинути чернетки й оновити','discard-reload','key--danger')}`)}`};
  // An unsaved draft is named before it is replaced (F4); Undo brings it back after the restore.
  if(kind==='history'){const ok=source.restorable.includes(state.profile),draft=draftSummary(state.profile);return {title:'Попереднє збереження',sub:prettyProfile(state.profile),focus:'[data-action=modal-close]',body:`<p class="print">Кожне збереження створює резервну копію. Відновлення поверне попередні налаштування та режим DeepSeek профілю <b>${esc(prettyProfile(state.profile))}</b>; поточна версія лишиться в резервних.</p>${ok&&draft?'<div class="msg" data-s="warn">'+led(true,'amber')+'<span>Незбережену чернетку ('+esc(draft)+') замінить відновлена версія. ↶ Undo поверне чернетку.</span></div>':''}${ok?'':'<div class="msg" data-s="warn">'+led(true,'amber')+'<span>Для цього профілю ще немає попередньої версії</span></div>'}${formFoot(`${cancel}${key(led(ok,'amber')+'Відновити попередню','restore-profile','',ok&&!busy?'':'disabled')}`)}`};}
  if(kind==='rename')return {title:'Перейменувати котушку',sub:prettyProfile(state.profile),focus:'#f-name',body:`<form id="rename-form" class="form form--one" novalidate>${formField('name','Нова назва',`<input ${formAttrs('name','required maxlength="64" autocomplete="off" spellcheck="false"')} value="${esc(state.renameName??state.profile)}">`,{note:profileNameHint(state.renameName??state.profile,true),hint:true})}${formFoot(`${cancel}${key(state.profileBusy?'Збереження…':'Перейменувати','rename-confirm','key--action',state.profileBusy?'disabled':'')}`,'Налаштування та чернетка збережуться')}</form>`};
  if(kind==='delete-profile')return {title:'Видалити котушку',sub:prettyProfile(state.profile),focus:'[data-action=modal-close]',body:`<p class="print">Профіль <b>${esc(prettyProfile(state.profile))}</b> зникне зі списку й не буде доступний для нових запусків OMP. Збережена версія лишиться в резервній копії.</p>${diff(state.profile).length?'<div class="msg" data-s="warn">'+led(true,'amber')+'<span>Незбережену чернетку цього профілю також буде видалено</span></div>':''}${formFoot(`${cancel}${key(led(true,'red')+(state.profileBusy?'Видалення…':'Видалити профіль'),'delete-confirm','key--danger',state.profileBusy?'disabled':'')}`)}`};
  if(kind==='clone')return {title:'Копія котушки',sub:prettyProfile(state.profile),focus:'#f-name',body:`<form id="clone-form" class="form form--one" novalidate>${formField('name',nativeClones()?'Назва нової котушки':'Назва нового профілю',`<input ${formAttrs('name','required maxlength="64" autocomplete="off" spellcheck="false"')} value="${esc(state.cloneName||'')}" placeholder="Standard FreeTier">`,{note:profileNameHint(state.cloneName||''),hint:true})}${formFoot(`${cancel}${key(state.profileBusy?'Створення…':'Створити','clone-create','key--action',state.profileBusy?'disabled':'')}`,nativeClones()?'Нова котушка OMP у файлі області з усіма ролями, що діють у збереженому '+esc(prettyProfile(state.profile))+' (як /modelpreset save); резерви, агенти й провайдери лишаються спільними':'Копіюється збережена конфігурація '+esc(prettyProfile(state.profile))+'; спершу збережи чернетку, якщо вона потрібна')}</form>`};
  // A directory OMP ran in without its own settings: the dialog names the file it would create; nothing is created
  // without its key.
  if(kind==='candidate'){
   const c=state.candidate||{},file=String(c.path||'').replace(/\/+$/,'')+'/.omp/config.yml',link=c.status==='symlink',seen=c.sessions?` (${esc(c.sessions)} ${plural(c.sessions,'сесія','сесії','сесій')}${c.lastSeen?' · востаннє '+esc(timeLabel(c.lastSeen)):''})`:'';
   return {title:'Налаштувати проєкт',sub:c.name||'',focus:'[data-action=modal-close]',body:`<p class="print">OMP працював у каталозі <b>${esc(c.name)}</b>${seen}, але там немає власних налаштувань: OMP бере тут лише глобальні.</p><span class="path-list"><span>каталог · <code>${esc(c.path)}</code></span><span>буде створено · <code>${esc(file)}</code></span></span><p class="print">Файл міститиме лише коментар. Доки ти нічого не збережеш, проєкт успадковує все з глобального. Без цієї клавіші нічого не створюється.</p>${link?'<div class="msg" data-s="bad">'+led(true,'red')+'<span>.omp — символьне посилання: Mana Tape не створює файл через посилання</span></div>':''}${formFoot(`${cancel}${key(state.profileBusy?'Створення…':'Налаштувати проєкт','configure-project','key--action',link||busy?'disabled':'')}`)}`};
  }
  if(kind==='migrate')return migrateSpec(cancel,busy);
  if(kind==='confirm'){const c=state.confirm||{};return {title:c.title||'Підтвердження',sub:c.sub||'',focus:'[data-action=confirm-cancel]',body:`<p class="print">${c.text||''}</p>${c.pending?'<div class="msg">'+led(false)+'<span>'+esc(c.pendingText||'Готую перегляд змін…')+'</span></div>':c.note||''}${formFoot(`${key('Скасувати','confirm-cancel')}${key((c.danger?led(true,'red'):'')+esc(c.label||'Підтвердити'),'confirm-run',c.danger?'key--danger':'key--action',busy||c.pending?'disabled':'')}`)}`};}
  return {title:'',body:'',focus:''};
 }
 // MIGRATION of an old .omp/presets/*.yml котушка (DESIGN «Області і котушки»): the server's plan — what a native
 // котушка carries (roles, thinking), what it cannot (short diff lines), the model-keyed chains that are exact —, three
 // ways (roles / roles + model chains / archive), an explicit tick for anything lost, and the backup it makes first.
 const MIGRATE_MODES=[['roles','Лише ролі','Нативна котушка з ролями й thinking. Решта змін файлу не переходить.'],['model-chains','Ролі + ланцюг за моделлю','Також пише ланцюг ролі як ланцюг за моделлю в .omp/config.yml там, де основна модель є лише в цій котушці: OMP бере його раніше за ланцюг ролі, і він діятиме всюди, де стоїть ця модель.'],['archive','Архівувати','Без нативної котушки: файл іде в резервні копії. Для котушок, чиї ролі збігаються зі Standard (OMP вважав би її активною разом зі Standard).']];
 function migrateLoses(plan,mode){return mode!=='archive'&&(plan.lost.length>0||plan.modelChains.some(c=>mode!=='model-chains'||!c.exact));}
 function migrateSpec(cancel,busy){
  const m=state.migrate||{},plan=m.plan,name=m.profile||'';
  if(!plan)return {title:'Перенести котушку',sub:name,focus:'[data-action=modal-close]',body:`${m.error?'':`<div class="msg">${led(false)}<span>Готую план перенесення…</span></div>`}${formFoot(cancel)}`};
  const mode=m.mode||(plan.sameAsStandard?'archive':'roles'),exact=plan.modelChains.filter(c=>c.exact),loses=migrateLoses(plan,mode),ready=!loses||m.accept,collide=mode!=='archive'&&(plan.collision||String(m.name??plan.preset).trim()!==plan.preset);
  const carried=mode==='archive'?['нічого: нативної котушки не буде']:[...plan.carried,...(mode==='model-chains'?exact.map(c=>'ланцюг '+c.role+' → ключ '+c.selector+' ('+c.chain.length+')'):[])];
  // Archiving drops the whole котушка: everything it changes against Standard (roles, thinking, chains) is listed.
  const lost=mode==='archive'?[...(plan.roleChanges||[]),...plan.lost]:plan.lost,chains=plan.modelChains.length?`<p class="print">Ланцюги ролей: ${plan.modelChains.map(c=>esc(c.role)+(c.exact?(mode==='model-chains'?' — перейде за моделлю':' — може перейти за моделлю'):' — не точно ('+esc(c.reason)+')')).join(' · ')}</p>`:'';
  const modes=`<div class="keybed mig__modes" role="radiogroup" aria-label="Спосіб перенесення">${MIGRATE_MODES.map(([k,t])=>{const off=k==='model-chains'&&!exact.length;return `<button type="button" class="key key--sm" role="radio" data-radio="migrate-mode" data-value="${k}" aria-checked="${k===mode}" tabindex="${k===mode?0:-1}"${off?' disabled title="Немає ланцюга, який можна точно перенести за моделлю"':''}><span class="key__cap">${led(k===mode,'orange')}${esc(t)}</span></button>`;}).join('')}</div>`;
  const body=`<p class="print">Стара котушка <b>${esc(name)}</b> — файл <code>.omp/presets/${esc(name)}.yml</code>. OMP читає такі файли лише через <code>--config</code>, тож зараз вона не діє. Нативна котушка OMP (<code>modelPresets</code> у файлі області) несе лише моделі ролей і thinking.</p>
   ${plan.sameAsStandard?'<div class="msg" data-s="warn">'+led(true,'amber')+'<span>Ролі збігаються зі Standard: як нативну котушку OMP вважатиме її активною разом зі Standard. Радимо «Архівувати».</span></div>':''}
   <div class="mig"><section class="mig__col"><span class="silk">Перейде</span><ul class="mig__list">${carried.map(t=>`<li>${esc(t)}</li>`).join('')}</ul></section><section class="mig__col"><span class="silk">Не перейде</span>${mode==='archive'?'<p class="print">уся котушка: файл лише в резервних копіях'+(lost.length?', а з нею й те, чим вона відрізняється від Standard:':' (від Standard вона нічим не відрізняється)')+'</p>'+diffStrip({lines:lost},'Що зникне з архівованою котушкою'):lost.length?diffStrip({lines:lost},'Що не перейде'):'<p class="print">нічого</p>'}${mode==='archive'?'':chains}</section></div>
   ${Object.keys(plan.derived||{}).length?'<div class="msg" data-s="warn">'+led(true,'amber')+'<span>Файл області при цьому зміниться ще й так — не через котушку, а через перекомпіляцію проти поточного глобального файлу, каталогу чи пулів (наприклад, DeepSeek OFF доходить до успадкованої ролі). Клавіша нижче запише й це:</span></div>'+derivedNote(plan.derived):''}
   ${mode!=='archive'&&plan.shadowsGlobal?'<div class="msg" data-s="warn">'+led(true,'amber')+'<span>Глобальна котушка з назвою '+esc(plan.preset)+' уже є: у цьому проєкті нова котушка її перекриє.</span></div>':''}
   ${modes}<p class="print mig__mode">${esc(MIGRATE_MODES.find(x=>x[0]===mode)[2])}</p>
   ${mode!=='archive'?formField('name','Назва котушки OMP',`<input ${formAttrs('name','required maxlength="64" autocomplete="off" spellcheck="false"')} value="${esc(m.name??plan.preset)}">`,{note:collide?'Котушка з такою назвою вже є · обери іншу':'Латинська літера на початку; зміна назви оновить план'}):''}
   ${loses?`<button type="button" class="key key--sm mig__accept" data-action="migrate-accept" aria-pressed="${!!m.accept}"><span class="key__cap">${led(false,'amber',' data-latch')}Розумію: «Не перейде» буде втрачено</span></button>`:''}
   <p class="print">Спершу старий файл і запис його режиму підуть у резервні копії стану (<code>backups/…-migrated-${esc(name)}.yml</code>), потім файл зникне з <code>.omp/presets</code> тим самим записом, що й файл області.</p>`;
  return {title:'Перенести котушку',sub:name,focus:'[data-action=modal-close]',wide:true,body:body+formFoot(`${cancel}${key(state.profileBusy?'Перенесення…':mode==='archive'?'Архівувати':'Перенести','migrate-run','key--action',busy||!ready||collide||m.pending?'disabled':'')}`,loses&&!m.accept?'Підтвердь, що частина змін не перейде':'')};
 }
 async function migratePlan(profile,name=''){
  state.migrate={...(state.migrate||{}),profile,pending:true};
  const field=document.activeElement?.matches?.('.tray__form [name=name]')?document.activeElement:null,caret=field?[field.selectionStart,field.selectionEnd]:null;
  try{const plan=await api('/api/profile-action',{action:'migrate-plan',profile,...(name?{name}:{})});if(state.modal!=='migrate'||state.migrate?.profile!==profile)return;if(name&&(state.migrate.name??'').trim()!==name)return;state.migrate={...state.migrate,plan,pending:false,name:name||plan.preset};state.modalError='';state.modalCode='';state.modalDiffs=null;}
  catch(e){if(state.modal!=='migrate')return;state.migrate={...state.migrate,pending:false};modalProblem(e);}
  modalFit='';regions.invalidate('drawer/form');render();
  // Typing goes on where it was: the re-planned form keeps the field's focus and caret.
  if(caret){const again=win.querySelector('.tray__form [name=name]');if(again&&document.activeElement!==again){again.focus({preventScroll:true});try{again.setSelectionRange(...caret);}catch{}}}
 }
 // A short diff from the server (≤ 6 lines: ~ changed, − removed, + added, … more) printed on a recessed strip.
 function diffStrip(d,label='Зміни у файлі'){
  if(!d?.lines?.length)return '';
  const op=line=>({'~':'chg','+':'add','−':'del','-':'del'})[line[0]]||'more';
  return `<div class="diffstrip" role="group" aria-label="${esc(label+(d.file?' '+d.file:''))}">${d.file?`<span class="diffstrip__file">${esc(d.file)}${d.approximate?' · ≈ приблизно':''}</span>`:''}${d.lines.map(line=>`<span class="diffstrip__l" data-op="${op(line)}">${esc(line)}</span>`).join('')}</div>`;
 }
 // What a write also changes beyond the action (409 `derived` or a dry run's `derived`), one strip per file.
 function derivedNote(derived){const rows=Object.values(derived||{});return rows.length?rows.map(d=>diffStrip(d,'Також зміниться')).join(''):'';}
 // A confirmation's preview from the server's dry run: every file the action writes, and what of it is not the
 // action itself (a recompile against the current Global file, catalogue or pools), which the key also confirms.
 function previewNote(r,error){
  if(error)return '<div class="msg" data-s="warn">'+led(true,'amber')+'<span>Не вдалося підготувати перегляд змін ('+esc(error)+'). Якщо запис змінить більше, ніж ця дія, сервер спершу покаже це.</span></div>';
  const files=Object.values(r?.files||{}),derived=Object.values(r?.derived||{});
  return (files.length?'<p class="print">Запишеться:</p>'+files.map(d=>diffStrip(d,'Що запишеться')).join(''):'<p class="print">Файли вже такі: нічого не запишеться.</p>')
   +(derived.length?'<div class="msg" data-s="warn">'+led(true,'amber')+'<span>Не все з цього — сама дія: решту дає перекомпіляція проти поточного глобального файлу, каталогу чи пулів (наприклад, DeepSeek OFF доходить до успадкованої ролі). Підтвердження запише й це:</span></div>'+derivedNote(r.derived):'');
 }
 // A confirmation that previews its write: the key waits for the dry run; its token confirms exactly that preview.
 async function previewAction(spec,path,body,more){
  let r=null,error=null;try{r=await api(path,{...body,dry:true});}catch(e){error=e;}
  if(state.confirm!==spec)return;
  // A refusal of the preview is the refusal of the action: shown as such (an outside edit of the Global file with its
  // diff and the «Глобально» key, a read-only file, a DeepSeek mode clash), before the owner presses anything.
  if(error?.status)modalProblem(error);
  spec.pending=false;spec.token=r?.token||'';spec.note=(spec.note||'')+(error?.status?'':previewNote(r,error?.message||''))+(r&&more?more(r):'');
  modalFit='';regions.invalidate('drawer/form');render();
 }
 function formSpecFocus(){return state.modal?formSpec().focus:'';}
 // The form drawer is as tall as its content (within the drawer's limits); measured once per form and error state.
 function fitForm(layer){
  const key=state.modal+'|'+state.editProvider+'|'+state.modalError+'|'+Object.keys(state.formErrors||{}).join();if(modalFit===key)return;modalFit=key;
  const lip=layer.querySelector('.tray__lip'),body=layer.querySelector('.tray__body');if(!lip||!body)return;
  const style=getComputedStyle(body);state.formHeight=Math.ceil(lip.offsetHeight+body.firstElementChild.scrollHeight+parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)+4);resizeDrawer(state.formHeight);
 }
 function formTitle(f){return `<div class="tray__title tray__title--ed" id="tray-form-title">${led(true,'orange')}<span class="silk silk--ink">${esc(f.title)}</span>${f.sub?`<span class="tray__count">${esc(f.sub)}</span>`:''}</div>`;}
 // A server refusal keeps its code next to the text (HTTP status · error code), on one reserved line.
 // With it, what the refusal is about: the lines a write would also change (`derived`) or the outside edit that blocks
 // it, and for a conflict in another scope (the Global file) the key that goes there to accept it.
 function formMarkup(f){return `<div class="tray__form${f.wide?' tray__form--wide':''}">${state.modalError?`<div class="msg" data-s="bad" role="alert">${led(true,'red')}${state.modalCode?`<b class="msg__code">${esc(state.modalCode)}</b>`:''}<span>${esc(state.modalError)}</span></div>`:''}${(state.modalDiffs||[]).map(d=>diffStrip(d,'Зміни у файлі')).join('')}${state.modalScope?`<div class="keybed">${key(led(true,'blue')+'Глобально · прийняти файл там','scope-global','key--sm')}</div>`:''}${f.body}</div>`;}
 // A drawer's refusal keeps what the owner needs to act on it (M6).
 function modalProblem(err){
  state.modalError=err.message;state.modalCode=errorCode(err);state.modalScope='';
  // The lines shown now are what the next press confirms.
  if(err.code==='derived'){if(state.confirm)state.confirm.token=err.token;if(state.migrate?.plan)state.migrate.plan.derivedToken=err.token;}
  state.modalDiffs=err.derived?Object.values(err.derived):err.code==='mode-conflict'&&err.diffs&&err.scope?Object.values(err.diffs).map(d=>({...d,file:scopeName(err.scope)+' · '+d.file})):null;
  if(err.code==='mode-conflict'&&err.scope&&err.scope!==source.projectId&&err.scope===source.scope?.parent)state.modalScope=err.scope;
 }
 const errorCode=e=>[e?.status,e?.code].filter(Boolean).join(' · ');
 // Client checks mirror the server's rules, so a field shows its problem before anything is sent.
 function providerProblems(f){
  const value=n=>String(f.elements[n]?.value||'').trim(),out={},editing=state.editProvider?source.providers.find(x=>x.id===state.editProvider):null;
  if(!value('name'))out.name='Вкажи назву';
  if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value('id')))out.id='ID: малі латинські літери, цифри, дефіс, до 64 знаків';
  // «+ Провайдер» only creates (QA2 B1): a taken ID is refused here and by the server; editing is «Підключення…».
  else if(!editing&&source.providers.some(v=>v.id===value('id')))out.id='Цей ID уже має провайдер. Змінити його можна через «Підключення…».';
  let url=null;try{url=new URL(value('url'));}catch{}
  if(!url||!/^https?:$/.test(url.protocol)||url.username||url.password||url.search||url.hash)out.url='Потрібна HTTP(S)-адреса без ключів, логіна чи параметрів';
  if(f.elements.auth.value==='apiKey'&&!value('key')&&!(editing?.hasKey&&url&&editing.url===value('url')))out.key=editing?.hasKey?'Для нової адреси введи ключ заново':'Потрібен API-ключ';
  if(!f.elements.discovery.value&&!value('models'))out.models='Увімкни отримання списку або вкажи ID моделей';
  return out;
 }
 // Server messages that belong to one field light that field too.
 function providerField(message){return /^ID|Цей ID/.test(message)?'id':/адрес|HTTP/i.test(message)?'url':/ключ/i.test(message)?'key':/моделей|ID моделей/.test(message)?'models':'';}
 async function saveProvider(){
  const f=win.querySelector('#new-provider');if(!f||state.providerSaving)return;
  const problems=providerProblems(f);
  if(Object.keys(problems).length){state.formErrors=problems;state.modalError='';regions.invalidate('drawer/form');render();win.querySelector('.tray__form .field.is-bad input,.tray__form .field.is-bad select,.tray__form .field.is-bad textarea')?.focus();return;}
  const d=new FormData(f);state.providerSaving=true;state.formErrors={};
  const body={id:d.get('id'),name:d.get('name'),url:d.get('url'),api:d.get('api'),auth:d.get('auth'),key:d.get('key'),discovery:d.get('discovery'),models:String(d.get('models')).split('\n').map(s=>s.trim()).filter(Boolean),days:Number(d.get('days')),revision:source.providerRevision,mode:state.editProvider?'edit':'create'};
  regions.invalidate('drawer/form');render();
  try{await api('/api/provider',body);state.modal=null;state.modalError='';await reload();notify('Провайдер збережений. Каталог оновлюється.');}
  catch(e){const field=providerField(e.message);state.modalError=e.message;state.modalCode=errorCode(e);if(field)state.formErrors={[field]:e.message};}
  finally{state.providerSaving=false;regions.invalidate('drawer/form');render();}
 }
 // A confirmation in the drawer instead of a browser dialog: what will happen, a safe key first, the action last.
 function askConfirm(spec){state.confirm=spec;state.modalError='';state.modalCode='';state.modalDiffs=null;state.modalScope='';state.modal='confirm';render();}
 // OPERATOR — one control plane, three working surfaces.
 const op=ManaOperator;
 const healthNames={local:'Локально',healthy:'Є запас',risk:'Малий запас',empty:'Вичерпано',unknown:'Немає виміру',unavailable:'Недоступна'};
 const healthGlyph={local:'◈',healthy:'●',risk:'△',empty:'∅',unknown:'?',unavailable:'⊘'};
 let opReportCache=null;
 function opHealth(model){return op.health({...model,free:priceInfo(model).kind==='free',expired:source.providers.find(v=>v.id===model.provider)?.expired},opReportCache||usageReports(),eff().disabledProviders||[]);}
 function opRouteHealth(route){const m=split(route);return opHealth(catalogMap.get(m.raw)||m);}
 // A latching key: its LED follows aria-pressed / aria-expanded in CSS, so flipping it patches attributes only.
 function opSwitchKey(name,label,on,caption=''){return `<button type="button" class="key" data-op-switch="${name}" ${name==='cuts'?`aria-expanded="${on}" aria-controls="cuts-collection" aria-label="Колекція CUTS"`:`aria-pressed="${on}"`}${caption?` title="${esc(caption)}"`:''}>`;}
 function opSwitchFace(name,label){return `<span class="key__cap">${led(false,name==='cuts'?'blue':'green',' data-latch')}${label}</span>`;}
 // A switch as a region: flipping it patches the key's attributes, so the pressed key itself (and its focus) stays.
 function switchRegion(key,name,label,on,caption=''){return box(key,opSwitchKey(name,label,on,caption),[leaf(key+'/face',opSwitchFace(name,label))]);}
 // Device selector window: a native <select> behind a milled window (the system picker stays on phones).
 function selWin(id,label,value,items,cls='sel--sm',attr=''){const option=([k,t])=>`<option value="${esc(k)}" ${k===value?'selected':''}>${esc(t)}</option>`;return `<div class="sel ${cls}"><label class="silk" for="${id}">${label}</label><div class="sel__win"><select id="${id}" ${attr}>${items.map(x=>Array.isArray(x)?option(x):`<optgroup label="${esc(x.group)}">${x.items.map(option).join('')}</optgroup>`).join('')}</select><span class="sel__chev"></span></div></div>`;}

 function opPaceText(q){if(!q.kind||q.kind==='unknown')return q.label;if(q.kind==='empty')return 'Вичерпано';return (q.kind==='reserve'?'Запас':q.label)+(q.delta!=null&&q.kind!=='balanced'?' '+Math.round(Math.abs(q.delta))+'%':'');}
 function opForecast(q){return q.kind==='unknown'?'Без прогнозу':q.kind==='empty'?'До скидання':q.lasts?'≈ до скидання':q.eta>Date.now()?'≈ ще '+resetCountdown(q.eta).replace('↻ ',''):'≈ запас міг скінчитись';}
 function microDuration(at){const minutes=Math.max(1,Math.round((at-Date.now())/60000));return minutes>=1440?Math.floor(minutes/1440)+'д':minutes>=60?Math.floor(minutes/60)+'г':minutes+'хв';}
 function reportAge(r){if(!r.at)return 'Немає виміру';const minutes=Math.max(0,Math.floor((Date.now()/1000-r.at)/60));return minutes<1?'щойно':minutes<60?minutes+' хв тому':Math.floor(minutes/60)+' г тому';}
 // SCREENS — one black glass per provider account with only its own limits (ids `quota:<provider>:<n>` keep their
 // stored hue), then one standalone DeepSeek screen (id `tariff`): the tariff, the mode and every provider's DeepSeek
 // CUTS of the reel on its glass, the mode switch on its chin. The DeepSeek mode and tariff act on all DeepSeek CUTS,
 // so they never sit in a provider's glass, even one that serves a DeepSeek model. Every screen is its own region;
 // times (age, reset countdown) are filled by the 30-s tick, so a passing minute never rebuilds a screen.
 const SCREEN_HUE={ds:32,stu:250,cld:150,gpu:140,free:185,p5:300,p6:165,p7:75};
 const screenHue=provider=>SCREEN_HUE[providerSlot(provider)]??150;
 function hueEncoder(id,label,def){return `<div class="enc-wrap"><div class="ctl__read"><span class="silk">тон</span><output class="rd" style="--rd:4ch" data-screen-hue-out="${esc(id)}">${ManaScreen.hueText(def)}</output></div>${ManaScreen.hueEncoderHTML(id,{label,def,value:def})}</div>`;}
 const GLASS_OPEN=['<div class="screen__win">','<div class="screen__gasket">','<div class="glass">'];
 const glass=inner=>`${GLASS_OPEN.join('')}<div class="glass__content"><div class="g">${inner}</div></div><div class="glass__sweep"></div></div></div></div>`;
 function nest(key,opens,children){let out=children;for(let i=opens.length-1;i>=0;i--)out=[box(key+(i?'/'+i:''),opens[i],out)];return out[0];}
 const segments=p=>p<=0?0:Math.max(1,Math.round(p/5))/20;
 // What is left in the provider's own units, printed under the value: «13,3 з 14 од.», «3,7 з ~70 од.» (a cap
 // estimated from CodexBar's %), «залишок 70 од.» (no cap known). CommandCode meters the subscription itself in units
 // its API calls `credits` — nobody bought them — so they are «од.» there.
 function planAmount(l,r){
  const b=l.balance;if(!b||!Number.isFinite(b.remaining))return null;
  const cc=r.provider==='commandcode',unit=cc?'од.':b.unit==='credits'?'кред.':b.unit||'';
  const text=(b.limit>0?num(b.remaining)+' з '+(b.estimated?'~':'')+num(b.limit):'залишок '+num(b.remaining))+(unit?' '+unit:'');
  return {text,note:[b.estimated?'~ — ліміт оцінено з % CodexBar і залишку OMP':'',cc?'одиниці плану CommandCode (в API — credits), не куплені кредити':''].filter(Boolean).join(' · ')};
 }
 function winCell(l,r,name){
  const q=op.pace(l,r),left=l.remaining,label=limitLabel(l),reset=`<span data-reset="${Number(l.resets)||0}"></span>`,amount=planAmount(l,r);
  const sub=amount?`<span class="win__sub">${esc(amount.text)}</span>`:'';
  // A balance with no % is a measurement too: the amount stands, only the percentage (and so the pace) is unknown.
  const why=left==null&&amount?['% невідомий: '+(r.provider==='commandcode'?'OMP дає лише залишок; % місяця додає CodexBar на Mac, коли його 5 год і тиждень збігаються з цим акаунтом':'провайдер дає лише залишок')]:[opPaceText(q),opForecast(q)];
  const title=esc([label,amount?.text,...why,resetTitle(l.resets),l.source&&'% і скидання — '+l.source,q.estimated&&'Лінійна оцінка за тривалістю вікна',amount?.note].filter(Boolean).join(' · '));
  if(left==null)return `<div class="win" title="${title}"><div class="win__top"><span class="win__l">${esc(label)}</span><b class="win__v">—</b>${sub}</div><div class="meter is-unknown" role="img" aria-label="${esc(name+' '+label)}: ${amount?'% невідомий, '+esc(amount.text):'немає виміру'}"><span class="meter__unlit"></span></div><span class="meter__scale"></span><div class="win__row">${reset}</div><div class="win__row"><span class="pace is-even">?</span><span>${amount?'% невідомий':'немає виміру'}</span></div></div>`;
  const stale=r.stale,s=left<10?'bad':left<25?'warn':'',delta=q.delta||0,pace=q.kind==='unknown'?['is-even','?']:q.kind==='empty'?['is-minus','∅']:delta>2?['is-minus','−'+Math.round(delta)+'%']:delta< -2?['is-plus','+'+Math.round(-delta)+'%']:['is-even','±'+Math.round(Math.abs(delta))+'%'];
  const forecast=stale?'≈ —':q.kind==='unknown'?'':q.kind==='empty'?'∅':q.lasts?'до ↻':q.eta>Date.now()?'≈'+microDuration(q.eta):'≈вич.',marker=!stale&&q.expected!=null?`;--m:${+((100-q.expected)/100).toFixed(3)}`:'';
  return `<div class="win${stale?' is-stale':''}" title="${title}"><div class="win__top"><span class="win__l">${esc(label)}</span><b class="win__v">${num(left)}%</b>${sub}</div><div class="meter${stale?' is-stale':''}"${s?` data-s="${s}"`:''} style="--q:${segments(left)}${marker}" role="meter" aria-label="${esc(name+' '+label+' залишок')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${left}"${amount?` aria-valuetext="${esc(num(left)+'% · '+amount.text)}"`:''}><span class="meter__unlit"></span><span class="meter__lit"><i></i></span>${marker?'<span class="meter__pace" title="Рівномірний темп"></span>':''}</div><span class="meter__scale"></span><div class="win__row">${reset}</div><div class="win__row"><span class="pace ${pace[0]}">${esc(pace[1])}</span><span>${esc(forecast)}</span></div></div>`;
 }
 function screenHead(r,name,mode=''){const stale=r.at&&r.stale;return `<div class="g-head"><span class="g-name" title="${esc(name)}">${esc(name)}</span><span class="g-age${stale?' is-stale':''}" title="${esc(timeLabel(r.at))}"><span data-age="${r.at||0}"></span>${stale?' · застаріло △':''}</span><span class="g-grow"></span>${mode||'<span class="g-reels" aria-hidden="true"><i></i><i></i></span>'}</div>`;}
 const winsMarkup=(r,name)=>r.limits.length?`<div class="wins">${r.limits.map(l=>winCell(l,r,name)).join('')}</div>`:`<div class="g-empty"><span class="g-empty__glyph">∅</span><span>Ще немає вимірів</span></div>`;
 const screenId=r=>'quota:'+r.provider+':'+r.account;
 function screenLegend(ds,families,row=false){return `<p class="print screen__legend${row?' screens__legend':''}" aria-label="Легенда екранів"><span>+ запас / − перевитрата · % від повного ліміту</span><span>≈ прогноз · ↻ скидання${ds?' · ▨ пік DeepSeek':''}</span>${families?'<span>Anthropic / Google / OpenAI — окремі сімейства Antigravity</span>':''}</p>`;}
 function quotaScreen(r,legend){
  const id=screenId(r),name=r.name,def=screenHue(r.provider);
  // --wins sizes the bank in its row (device.css): it grows with its neighbours to close the row, never past twice its windows.
  return `<div class="screen" data-screen="${esc(id)}" data-screen-default="${def}" style="--wins:${Math.max(1,r.limits.length)}">${glass(screenHead(r,name)+winsMarkup(r,name))}<div class="screen__chin"><span class="screen__id" title="${esc(r.at?r.stale?'Застарілий вимір':'Свіжий вимір':'Немає виміру')}">${led(!!r.at,r.stale?'amber':'green')}<span class="silk">${esc(providerCode(r.provider))}</span></span>${legend||'<span class="strip__grow"></span>'}${hueEncoder(id,name,def)}</div></div>`;
 }
 // The reel's paid DeepSeek across every provider: CUTS in its own chains (role chains, `default` once, agents' own
 // lists; an `@role` link is that role's lane, not another CUT) and the lanes they stand on. In OFF: how many of those
 // lanes the projection put on replacements (a lone `@role` agent simply follows its role).
 function deepSeekReel(){
  const profile=eff(),own=[...Object.values(profile.modelRoles||{}),...Object.values(profile.retry?.fallbackChains||{}).flat(),...Object.values(profile.task?.agentModelOverrides||{}).flat()];
  const cuts=own.filter(v=>typeof v==='string'&&!v.startsWith('@')&&deepseek(v)),providers=[...new Set(cuts.map(v=>split(v).provider))];
  const lanes=[...roleKeys.map(r=>[r,'role']),...workers().filter(w=>agentValues(w).length>1||!vibeAlias(w)).map(w=>[w,'vibe'])].filter(([k,g])=>baseChain(k,g).some(v=>deepseek(v)));
  const off=modeOff(),replaced=off?lanes.filter(([k,g])=>{const v=modeView(k,g);return v?.paused?.length||v?.substituted;}).length:0;
  return {cuts:cuts.length,providers,lanes:lanes.length,replaced,pending:off&&projectionPending()};
 }
 // A compact readout beside the tariff: CUTS in the reel, providers, lanes, lanes on replacements (OFF).
 function deepSeekSummary(){
  const s=deepSeekReel(),off=modeOff(),names=s.providers.map(providerName).join(', ');
  const title=`Котушка ${prettyProfile(state.profile)}: ${s.cuts} ${plural(s.cuts,'CUT','CUTS','CUTS')} платного DeepSeek${names?' ('+names+')':''} на ${s.lanes} ${plural(s.lanes,'доріжці','доріжках','доріжках')}. ${off?'OFF: на цих доріжках стоять заміни.':'ON: оригінал; OFF поставить заміни на місце першого платного DeepSeek.'} FREE DeepSeek не рахується.`;
  const row=(label,value,attr='')=>`<div class="ds-sum__row"${attr}><span>${label}</span><b>${value}</b></div>`;
  return `<div class="ds-sum" role="group" aria-label="DeepSeek у котушці" title="${esc(title)}"><div class="ds-sum__top"><span>CUTS у котушці</span><b>${s.cuts}</b></div>${row('провайдери',s.providers.length)}${row('доріжки',s.lanes)}${row('на замінах',off?s.pending?'…':s.replaced+'/'+s.lanes:'0',off?' data-s="off"':'')}</div>`;
 }
 // The DeepSeek screen, one for the whole reel and every provider: the reel readout and the tariff on its glass, the
 // mode in the head and its line reserved under them; the switch, «Заміни» and ↻ on its chin. Its hue is `tariff`.
 function deepSeekScreen(){
  const id='tariff',def=SCREEN_HUE.ds,mode=`<span class="g-mode">${modeOff()?'OFF · заміни':'ON · оригінал'}</span>`;
  return box('screen:'+id,`<div class="screen screen--ds" data-screen="${id}" data-screen-default="${def}">`,[
   nest(id+'/win',GLASS_OPEN,[nest(id+'/content',['<div class="glass__content">','<div class="g">'],[leaf('p/mode-head',`<div class="g-head"><span class="g-name">DeepSeek</span><span class="g-age">усі провайдери</span><span class="g-grow"></span>${mode}</div>`),box(id+'/split','<div class="g-split">',[leaf('p/ds-reel',deepSeekSummary()),leaf(id+'/vsep','<span class="g-vsep"></span>'),leaf('p/tariff',tariffMarkup())]),leaf('p/mode-msg',modeMessage())]),leaf(id+'/sweep','<div class="glass__sweep"></div>')]),
   box(id+'/chin','<div class="screen__chin">',modeChin(id))]);
 }
 // Provider screens carry only their own limits; whether the DeepSeek screen stands after them is decided apart.
 function usageScreens(){
  const reports=opReportCache||usageReports(),counts=new Map(),accounts=new Map();
  for(const r of reports)counts.set(r.provider,(counts.get(r.provider)||0)+1);
  const rows=reports.map(r=>{const account=(accounts.get(r.provider)||0)+1;accounts.set(r.provider,account);return {...r,account,name:providerName(r.provider)+(counts.get(r.provider)>1?' #'+account:'')};});
  return {rows,ds:deepSeekCatalog||modeOff()};
 }
 function hasDeepSeekScreen(){return state.view==='profiles'&&(deepSeekCatalog||modeOff());}
 function screensBank(){
  if(state.view!=='profiles')return [leaf('meters/key',''),leaf('meters/bank',''),leaf('seam:screens','')];
  const {rows,ds}=usageScreens();if(!rows.length&&!ds)return [leaf('meters/key',''),leaf('meters/bank',''),leaf('seam:screens','')];
  let wide=-1;rows.forEach((r,i)=>{if(wide<0||r.limits.length>rows[wide].limits.length)wide=i;});
  // The legend sits in the chin of the widest bank when that chin has room (three windows or more); a narrower bank
  // would push it over its neighbour (final QA P1-2), so it then prints as its own row under the banks.
  const families=rows.some(r=>r.provider==='google-antigravity'),inChin=wide>=0&&rows[wide].limits.length>=3,legend=screenLegend(!!ds,families,!inChin);
  const screens=rows.map((r,i)=>leaf('screen:'+screenId(r),quotaScreen(r,inChin&&i===wide?legend:'')));
  if(ds)screens.push(deepSeekScreen());
  if(!inChin&&rows.length)screens.push(leaf('meters/legend',legend));
  return [leaf('meters/key',rows.length?`<button type="button" class="key key--wide screens__key" data-action="meters-mobile" aria-expanded="${!!state.mobileMeters}" aria-controls="meter-bank"><span class="key__cap"><span class="key__lbl">${led(false,'green',' data-latch')}Ліміти</span><span class="rd" style="--rd:2ch">${rows.length}</span></span></button>`:''),
   box('meters/bank',`<section class="screens" id="meter-bank" aria-label="Панель підписок: залишки, скидання та темп" data-mobile-expanded="${!!state.mobileMeters}">`,screens),leaf('seam:screens','<div class="seam"></div>')];
 }
 // The dock: selectors, ⋯, switches, the feedback line and the printed context are separate regions, so an edit
 // repaints only what changed and a switch only its key's attributes.
 // SCOPE AND REEL (DESIGN «Області і котушки»): a printed breadcrumb of what is being edited, the «Глобально» key, the
 // project drum (configured projects, then the directories OMP ran in without a config, as candidates), the котушка
 // drum (Standard, the scope's native котушки with the active one marked, Global котушки in a project, old files),
 // «Застосувати» (/modelpreset switch) and the котушка's ⋯ menu.
 function operatorDock(dirty=[]){
  const others=dirty.filter(k=>k!==state.profile),drafts=others.length?`<span title="${esc(others.map(prettyProfile).join(', '))}">чернетки: ${esc(others.map(prettyProfile).join(', '))}</span>`:'';
  // On Монтаж the breadcrumb says what is edited and for whom; the context prints only the other drafts.
  const ctx=state.view==='profiles'?'<span class="dock__note">Котушка застосовується<br>до нових запусків OMP</span>'+(drafts?'<br>'+drafts:''):(state.view==='models'?'<b>02 · Колекція</b><br>CUTS / провайдери / тести / ціни':'<b>03 · Історія</b><br>виміри OMP · усі проєкти OMP')+(drafts?'<br>'+drafts:'');
  return box('dock','<section class="bay dock" aria-label="Пульт оператора">',[
   leaf('dock/crumb',crumbMarkup()),
   box('dock/row','<div class="dock__row">',[leaf('dock/scope',scopeKey()),
    leaf('dock/selection',`${projectDrum()}${profileDrum()}`),
    leaf('dock/apply',applyKey()),
    leaf('dock/menu',profileMenu()),leaf('dock/sep','<span class="seam seam--v"></span>'),dockSwitches(),
    leaf('feedback',operatorFeedback()),leaf('dock/context',`<p class="dock__ctx print">${ctx}</p>`)])]);
 }
 // «Глобально › DEMO · Творча майстерня › night»: printed on the plate, with the file and the active котушка.
 function crumbMarkup(){
  const scope=source.scope||{},g=globalScopeRow(),files=scopeFiles(),name=state.profile,parts=[];
  if(g)parts.push(['Глобально',scope.kind==='global']);
  if(scope.kind==='project')parts.push([scope.name||source.projectId,false]);
  parts.push([prettyProfile(name)+(isNative(name)?' · котушка OMP':isGlobalPreset(name)?' · глобальна котушка':name==='standard'?'':' · стара котушка'),true]);
  const file=isGlobalPreset(name)?files.globalShort+' · modelPresets.'+presetName(name):isNative(name)?(scope.kind==='global'?files.globalShort:files.projectShort||'config.yml')+' · modelPresets.'+presetName(name):name==='standard'?(scope.kind==='global'?files.globalShort:files.projectShort||'.omp/config.yml'):'.omp/presets/'+name+'.yml';
  const full=isGlobalPreset(name)||scope.kind==='global'?files.global:files.project,active=source.activePreset;
  return `<div class="dock__crumb"><span class="silk">Редагується</span><ol class="crumb" aria-label="Що редагується" title="${esc(parts.map(([t])=>t).join(' › '))}">${parts.map(([t,last])=>`<li${last?' aria-current="location"':''}>${esc(t)}</li>`).join('')}</ol><span class="crumb__file print"${full?` title="${esc(full)}"`:''}>${esc(file)}</span><span class="crumb__active print" title="OMP вважає котушку активною, коли її ролі точно збігаються з ролями, що діють">${led(!!active,'green')}${active?`активна котушка OMP: <b>${esc(active)}</b>`:'активної котушки OMP немає'}</span><span class="crumb__note print">для нових запусків OMP</span></div>`;
 }
 function scopeKey(){
  const g=globalScopeRow();if(!g)return '';
  const on=source.scope?.kind==='global';
  return `<button type="button" class="key key--scope" data-action="scope-global" aria-pressed="${on}" title="${on?'Глобальні налаштування OMP для всіх каталогів · ще раз — назад до проєкту':'Глобальні налаштування OMP для всіх каталогів'}"><span class="key__cap">${led(false,'blue',' data-latch')}Глобально</span></button>`;
 }
 function projectDrum(){
  const rows=source.projects||[],cands=source.candidates||[];
  const items=rows.map(x=>[x.id,x.kind==='global'?(rows.filter(r=>r.kind==='global').length>1?x.name:'— лише глобальне —'):x.name]);
  if(cands.length)items.push({group:'Знайдені · ще не налаштовані',items:cands.map(c=>['candidate:'+c.id,c.name+' · не налаштований'])});
  return selWin('project-choice','Проєкт',source.projectId,items,'sel--proj',state.saving?'disabled':'');
 }
 function profileDrum(){
  const active=source.activePreset,keys=profileKeys,label=k=>prettyProfile(k)+(presetName(k)===active&&(isNative(k)||isGlobalPreset(k))?' · активна':'');
  const own=keys.filter(isNative).sort(),globals=keys.filter(isGlobalPreset).sort(),old=keys.filter(k=>k!=='standard'&&!presetLike(k)).sort();
  const items=[['standard','Standard'],...own.map(k=>[k,label(k)])];
  if(globals.length)items.push({group:'Глобальні котушки',items:globals.map(k=>[k,label(k)+' · глобальна'])});
  if(old.length)items.push({group:'Старі котушки · .omp/presets',items:old.map(k=>[k,k+' · стара'])});
  return selWin('profile-choice','Профіль /<br>котушка',state.profile,items,'sel--prof');
 }
 // «Застосувати» = OMP /modelpreset switch for the chosen котушка; etched where it cannot act (Standard, an old
 // котушка, an unsaved котушка, the active one). Its width never changes with its state.
 function applyKey(){
  const name=state.profile,on=presetLike(name),active=on&&presetName(name)===source.activePreset,dirty=on&&diff(name).length>0;
  const title=!on?'Застосувати можна котушку OMP: обери її в селекторі':active?'Ця котушка вже активна: ролі OMP точно збігаються з нею':dirty?'Спершу збережи котушку':'Зробити ролі котушки ролями OMP (як /modelpreset switch)';
  return `<button type="button" class="key key--apply" data-action="apply-preset" ${!on||active||dirty||state.saving?'disabled':''} title="${esc(title)}" aria-label="${esc((active?'Котушка активна: ':'Застосувати котушку')+(on?' '+prettyProfile(name):''))}"><span class="key__cap">${led(false,'green')}${active?'Активна':'Застосувати'}</span></button>`;
 }
 // What «Застосувати» will do, said before it is done: where OMP stores roles (modelRoleStorage), that roles the
 // котушка does not name are cleared there, thinking goes to the Global file, and which roles the project still sets.
 function applyText(name){
  const row=source.nativePresets?.[presetName(name)]||{},roles=row.roles||{},n=Object.keys(roles).length,files=scopeFiles(),scope=source.scope||{};
  const projectStore=scope.kind==='project'&&scope.storage==='project',target=projectStore?files.project:files.global||files.project;
  const shadow=!projectStore&&globalLayer?Object.keys(roles).filter(r=>original.standard.modelRoles?.[r]&&original.standard.modelRoles[r]!==roles[r]):[];
  return `Як <code>/modelpreset switch</code> в OMP: ${n} ${plural(n,'роль','ролі','ролей')} котушки <b>${esc(prettyProfile(name))}</b> стануть ролями OMP у файлі <span class="path-list"><span><code>${esc(target)}</code>${projectStore?' · modelRoleStorage: project':''}</span></span>Ролі, яких котушка не називає, там очищаються.${row.thinking?` Thinking <b>${esc(row.thinking)}</b> — у глобальний файл.`:''} Резерви, агенти й провайдери не змінюються.${shadow.length?` Проєкт і далі задає своє для <b>${esc(shadow.join(', '))}</b> — ці ролі лишаться як у проєкті.`:''}`;
 }
 // The reel's ⋯ menu: a small recessed tray of labelled keys; «Прийняти файл» appears when this profile's file was
 // changed (or removed) outside Mana Tape; an old котушка offers its move to a native one. Arrows walk the keys,
 // Escape returns to ⋯. A Global котушка seen from a project only leads to the Global scope.
 function profileMenu(){
  const std=state.profile==='standard',conflict=source.modeConflicts?.includes(state.profile),orphan=source.modeOrphans?.includes(state.profile),view=locked(),old=!std&&!presetLike();
  const item=(label,action,attr='',cls='')=>`<button type="button" class="key key--menu ${cls}" role="menuitem" data-action="${action}" ${attr}><span class="key__cap">${label}</span></button>`;
  const adopt=conflict||orphan?item(led(true,'amber')+(orphan?'Прийняти видалення':'Прийняти файл'),'adopt-profile',`data-adopt="${esc(state.profile)}"`)+'<div class="menu__sep" role="separator"></div>':'';
  const body=view?`${item('Редагувати в глобальному','preset-edit-global')}`:`${adopt}${old?item(led(true,'amber')+'Перенести в котушку OMP…','migrate-open',`data-migrate="${esc(state.profile)}"`)+'<div class="menu__sep" role="separator"></div>':''}${item('Копія…','clone-profile')}${item('Перейменувати…','rename-profile',std?'disabled':'')}${item('Попереднє збереження…','history')}${item('Скинути чернетку','reset-draft',state.changes?'':'disabled')}<div class="menu__sep" role="separator"></div>${item(led(true,'red')+'Видалити…','delete-profile',std?'disabled':'','key--danger')}`;
  const note=view?'Глобальна котушка: тут — перегляд і «Застосувати»':std?'Standard — основний профіль: його не перейменовують і не видаляють':'';
  return `<details class="dock__menu"><summary class="key key--sq" aria-label="Дії з котушкою ${esc(prettyProfile(state.profile))}" aria-haspopup="menu" title="Дії котушки"><span class="key__cap">${SVG.more}</span></summary><div class="menu" role="menu" aria-label="Дії котушки ${esc(prettyProfile(state.profile))}"><div class="menu__head"><span class="silk">Котушка · ${esc(prettyProfile(state.profile))}</span></div><div class="menu__bed">${body}</div>${note?`<p class="menu__note">${note}</p>`:''}</div></details>`;
 }
 function dockSwitches(){return box('dock/switches','<div class="dock__grp">',[switchRegion('dock/health','health','HEALTH',state.health,'HEALTH · ресурс підписок на CUTS'),switchRegion('dock/cuts','cuts','CUTS',drawerShown(),'')]);}
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
 function opProviderItems(all=false){return [['all','Усі'],...source.providers.filter(v=>all||((v.connected||v.used.length)&&!(eff().disabledProviders||[]).includes(v.id)&&!v.expired)).map(v=>[v.id,providerName(v.id)]).sort((a,b)=>a[1].localeCompare(b[1]))];}
 function analyticalProviders(){const ids=state.catalogMode==='mine'?myProviderIds():state.catalogMode==='free'?new Set(catalog.filter(m=>priceInfo(m).kind==='free').map(m=>m.provider)):null;return opProviderItems(true).filter(([id])=>id==='all'||!ids||ids.has(id));}
 // The drawer collection without its search words. It is filtered and sorted again only when a filter, the
 // profile's providers, the open editor or the snapshot changes; a keystroke then only scans precomputed search keys.
 // An open editor narrows the collection to what its list accepts: a pool takes FREE CUTS only, the replacements no
 // paid DeepSeek, and both only CUTS their role can run.
 function collectionBase(){
  const t=state.cutTarget,ed=editorTarget(),key=JSON.stringify([dataVersion,state.profile,eff().disabledProviders||[],t?.role,t?.group,t?.group==='vibe'?vibeAlias(t.role):'',ed?.group,ed?.role,state.cutProvider,state.freeCuts,state.cutHealth,state.cutHealth==='all'?0:(opReportCache||usageReports()).map(r=>[r.provider,r.stale])]);
  if(collectionBase.key===key)return collectionBase.rows;
  const free=state.freeCuts||ed?.group==='pool';
  const rows=catalog.filter(m=>(!t||acceptsRoleModel(t.role,t.group||'role',m))&&(!ed||acceptsRoleModel(ed.role,ed.group,m)&&(ed.group!=='pool'||ManaOperator.isFreeModel(m))&&(ed.group!=='alternatives'||!deepseek(m.provider+'/'+m.id)))&&(m.available||source.providers.find(v=>v.id===m.provider)?.connected)&&!routeWarning(m.provider+'/'+m.id)&&(state.cutProvider==='all'||m.provider===state.cutProvider)&&(!free||priceInfo(m).kind==='free')&&(state.cutHealth==='all'||opHealth(m).kind===state.cutHealth)).map(m=>({m,provider:providerName(m.provider)}));
  rows.sort((a,b)=>collate(a.m.name,b.m.name)||collate(a.provider,b.provider)||collate(a.m.id,b.m.id));
  collectionBase.key=key;return collectionBase.rows=rows.map(x=>x.m);
 }
 function collectionCuts(){const words=queryWords(state.cutQuery),rows=collectionBase();return words.length?rows.filter(m=>matchesWords(words,searchKey(m).cut)):rows;}
 // DRAWER — pinned to the viewport bottom within the body. Its front edge (the lip) carries the transport
 // permanently. It has one face at a time: the CUTS collection; an editor (Пули, Заміни) with the collection as
 // its source; or a form (provider, profile actions, confirmations) that holds the focus while the body is inert.
 const GRIP='<div class="tray__grip" id="cuts-resize" role="separator" tabindex="0" aria-orientation="horizontal" aria-controls="cuts-collection" aria-label="Висота лотка" title="Тягни вгору або вниз · ↑ / ↓ · Home / End · Enter відкриває й закриває"></div>';
 function drawerFilters(mode){
  const pool=mode==='pool';
  return box('drawer/controls','<div class="tray__filters">',[leaf('drawer/provider',selWin('cut-provider','Провайдер',state.cutProvider,pool?opProviderItems().filter(([id])=>id==='all'||id===state.cutProvider||catalog.some(m=>m.provider===id&&ManaOperator.isFreeModel(m))):opProviderItems())),pool?leaf('drawer/free','<span class="chip chip--ok tray__only">лише FREE</span>'):switchRegion('drawer/free','free','FREE CUTS',state.freeCuts,'Лише підтверджені FREE CUTS'),leaf('drawer/health',selWin('cut-health','Запас',state.cutHealth,[['all','Будь-який'],...Object.entries(healthNames).filter(([k])=>k!=='unavailable')])),leaf('drawer/search',drawerSearch())]);
 }
 function editorTitle(mode){
  if(mode==='pool')return `<div class="tray__title tray__title--ed">${led(true,'orange')}<span class="silk silk--ink">Пули</span><span class="tray__count">спільні для всієї машини</span></div>`;
  const n=modeList(state.modeScope||'profile').length;return `<div class="tray__title tray__title--ed">${led(true,'orange')}<span class="silk silk--ink">Заміни DeepSeek</span><span class="tray__count"><span class="rd" style="--rd:2ch">${n}</span> CUTS · ${modeOff()?'OFF':'ON'}</span></div>`;
 }
 function editorTabs(mode){
  if(mode==='pool'){const selected=state.poolTab||'free-good';return `<div class="keybed tray__tabs" role="tablist" aria-label="FREE пули">${Object.entries(poolNames).map(([name,label])=>`<button type="button" class="key key--sm" role="tab" id="pool-tab-${name}" data-pool-tab="${name}" aria-selected="${selected===name}" aria-controls="pool-editor" tabindex="${selected===name?0:-1}"><span class="key__cap">${led(selected===name,'green')}${label}<span class="rd" style="--rd:2ch">${poolDraft[name].length}</span></span></button>`).join('')}</div>`;}
  return `<div class="tray__tabs">${selWin('mode-scope','Для',state.modeScope||'profile',modeScopes())}</div>`;
 }
 function sourceHead(mode){return `<span class="silk">Колекція CUTS</span><span class="print print--hint tray__srchint">${mode==='pool'?'FREE · ':''}торкнись — у кінець · перетягни — на місце</span>`;}
 function cutsTray(){
  const mode=drawerMode(),open=drawerShown(),editor=mode==='pool'||mode==='alternatives',form=mode==='form',f=form?formSpec():null,body=open||(drawerOpenShown||!!drawerClosing)&&drawerLastMode==='cuts',t=transportParts(),cuts=form?[]:collectionCuts();
  const transport=box('drawer/transport',`<div class="tray__transport transport" role="group" aria-label="Зміни: ${t.pool?'FREE пули':t.scope?'заміни':'котушка'}"${form?' inert':''}>`,[leaf('tp/scope',t.scopeHtml),leaf('tp/undo',t.undo),leaf('tp/redo',t.redo),leaf('tp/state',t.state),leaf('tp/save',t.save)]);
  const close=(action,label)=>leaf('drawer/close',key(SVG.close,action,'key--sq tray__close',`aria-label="${esc(label)}" title="Закрити · Esc"`));
  const lip=form?[leaf('drawer/grip',''),leaf('drawer/ftitle',formTitle(f)),transport,close('modal-close','Закрити: '+f.title)]
   :editor?[leaf('drawer/grip',GRIP),leaf('drawer/etitle',editorTitle(mode)),leaf('drawer/etabs',editorTabs(mode)),leaf('drawer/armed',armedMarkup()),transport,close(mode==='pool'?'pool-close':'mode-close',mode==='pool'?'Закрити редактор пулів':'Закрити заміни DeepSeek')]
   :[leaf('drawer/grip',GRIP),box('drawer/title',`<button type="button" class="tray__title" data-action="cuts-toggle" aria-expanded="${open}" aria-controls="tray-body">`,[leaf('drawer/title/face',`${led(false,'blue',' data-latch')}<span class="silk">Колекція CUTS</span>`),leaf('drawer/title/count',drawerCount(cuts)),leaf('drawer/hint',drawerHint(cuts.length))]),
    leaf('drawer/armed',armedMarkup()),leaf('drawer/pull','<span class="tray__pull" aria-hidden="true"></span>'),transport,leaf('drawer/chev','<span class="tray__chev" aria-hidden="true"></span>')];
  const results=form?null:leaf('drawer/results',body&&!(editor&&state.sourceLater)?drawerResults(cuts):'<div class="tray__grid"></div>');
  const content=form?[leaf('drawer/form',formMarkup(f))]
   :editor?[leaf('drawer/editor',mode==='pool'?poolEditor():modePanel()),box('drawer/source','<section class="tray__source" aria-label="Колекція CUTS · джерело для редактора">',[box('drawer/srchead','<div class="tray__srchead">',[leaf('drawer/srclabel',sourceHead(mode)),leaf('drawer/srchead/count',drawerCount(cuts))]),drawerFilters(mode),results])]
   :[drawerFilters(mode),results];
  return box('drawer','<div class="tray-port">',[box('drawer/tray',trayOpen(),[box('drawer/lip','<div class="tray__lip">',lip),box('drawer/body',`<div class="tray__body${editor?' tray__body--ed':form?' tray__body--form':''}" id="tray-body">`,content)])]);
 }
 // With nothing to drag (an empty catalogue or no result) the lip keeps its place but prints no drag hint.
 function drawerHint(count=1){const t=state.cutTarget;if(!count&&!t)return '<span class="tray__hint"></span>';return t?`<span class="tray__hint tray__hint--target">· місце: ${esc(t.role)} · ${t.index===0?'основна':'резерв '+t.index}</span>`:`<span class="tray__hint">· ${narrowSurface()?'обери CUT і торкнись гнізда':'перетягни CUT на доріжку або обери CUT і місце'}</span>`;}
 function armedMarkup(){const r=state.armedCut;if(!r)return '<span class="tray__armed" aria-live="polite"></span>';const name=poolNames[poolName(r)]||cutTitle(r);return `<span class="tray__armed" aria-live="polite">${led(true,'blue')}<span class="tray__armed-txt"><small>Обрано · торкнись CUT для заміни або гнізда «+»</small><b title="${esc(name+(poolName(r)?'':' · '+providerName(split(r).provider)))}">${esc(name)}</b></span><button type="button" class="key" data-action="cancel-cut"><span class="key__cap">Скасувати</span></button></span>`;}
 function drawerSearch(){return `<label class="search">${SVG.search}<input id="cut-query" type="search" aria-label="Знайти CUT у колекції" placeholder="Знайти CUT…" value="${esc(state.cutQuery)}" autocomplete="off"></label>`;}
 function drawerCount(cuts){return `<span class="tray__count"><span class="rd" style="--rd:3ch">${cuts.length}</span> CUTS</span>`;}
 // A CUT that is chosen rather than edited (collection, quick pick): the same tape, a button, one tooltip.
 // The quick pick marks the current CUT («зараз») and the ones already on the lane.
 function drawerCut(m,pick=null){
  const route=m.provider+'/'+m.id,deleted=deletedCut(route),free=!deleted&&freeRoute(route),health=healthMarks(route),title=cutTitle(route),provider=providerName(m.provider),armed=!pick&&state.armedCut===route;
  const note=pick?.current?'поточний CUT':pick?.used?'на доріжці':'',warn=routeWarning(route)?'потребує уваги':'';
  const think=pick?[note,warn].filter(Boolean).join(' · ')||(m.reasoning===false?'без thinking':isLocal(m.provider)?'локально':provider):m.reasoning===false?'без thinking':isLocal(m.provider)?'локально':'типово';
  const attrs=pick?`data-pick="${esc(route)}" data-cut-route="${esc(route)}" aria-pressed="${!!pick.current}"`:`data-cut="${esc(route)}" aria-pressed="${armed}"`;
  return `<button type="button" class="cut${free?' cut--free':''}${deleted?' cut--deleted':''}${armed?' is-armed':''}${pick?.current?' is-current':''}" data-p="${providerSlot(m.provider)}" ${attrs} aria-label="${esc(title+' · '+provider+(free?' · FREE':'')+(note?' · '+note:'')+' · '+route+(health.text?' · '+health.text:''))}" title="${esc([title+' · '+provider,route,health.text].filter(Boolean).join('\n'))}"><span class="cut__edge"></span><span class="cut__name cut__name--split">${nameMarkup(title)}</span><span class="cut__meta">${health.glyph}<b class="tag" data-p="${providerSlot(m.provider)}">${esc(providerCode(m.provider))}</b><span class="cut__think">${esc(think)}</span>${deleted?'<span class="stamp stamp--del">DELETED</span>':''}</span>${free?'<span class="stamp stamp--free">FREE</span>':''}${health.bar}</button>`;
 }
 // No model at all (Колекція), or none reachable to place (the drawer): the empty state says so and offers the
 // provider form instead of blaming the filters.
 function catalogEmpty(reachable=false){return reachable?!source.models.some(m=>m.available||source.providers.find(v=>v.id===m.provider)?.connected):!source.models.length;}
 function drawerResults(cuts){
  const shown=cuts.slice(0,state.cutLimit||60),key=esc(JSON.stringify([state.cutProvider,state.cutHealth,state.freeCuts,state.cutQuery]));
  if(!shown.length)return `<div class="tray__grid is-empty" data-filter-key="${key}"><div class="empty"><span class="empty__glyph" aria-hidden="true">∅</span><span>${state.cutQuery.trim()?`Нічого не знайдено за «<b>${esc(state.cutQuery.trim())}</b>»`:catalogEmpty(true)?'Каталог порожній · додай провайдера':'Немає CUTS за цими фільтрами'}</span>${state.cutQuery.trim()?'<button type="button" class="key key--sm" data-action="cuts-clear"><span class="key__cap">Очистити</span></button>':catalogEmpty(true)?'<button type="button" class="key key--sm" data-action="provider-add"><span class="key__cap">+ Провайдер</span></button>':''}</div></div>`;
  return `<div class="tray__grid" data-filter-key="${key}">${shown.map(m=>drawerCut(m)).join('')}${cuts.length>shown.length?`<div class="tray__more"><button type="button" class="key key--sm" data-action="cuts-more"><span class="key__cap">Ще ${Math.min(60,cuts.length-shown.length)}</span></button></div>`:''}</div>`;
 }
 let drawerGesture=null,drawerClosing=0,drawerOpenShown=false,drawerLastMode='cuts';
 // The drawer's face: a form holds the focus; an editor keeps the collection as its source; otherwise the collection.
 function drawerMode(){return state.modal?'form':state.poolPanel?'pool':state.modePanel?'alternatives':'cuts';}
 function drawerShown(){return !!(state.cuts||state.modal||state.poolPanel||state.modePanel);}
 // Each face remembers its own height: the collection and the editors by a user resize, a form by its content.
 function heightKey(){const mode=drawerMode();return mode==='cuts'?'drawerHeight':mode==='form'?'formHeight':'editorHeight';}
 function preferredHeight(){return state[heightKey()];}
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
  // A phone opens the collection at its full allowed height (the page above keeps its ≈220px).
  const mode=drawerMode(),preferred=Number.isFinite(height)?height:mode==='cuts'?(width<=760?max:Math.min(290,viewport*.43)):mode==='form'?Math.min(480,viewport*.6):width<=760?max:Math.min(470,viewport*.55);
  height=Math.round(Math.max(min,Math.min(max,preferred)));
  if(remember&&mode!=='form')state[heightKey()]=height;
  port.style.left=left+'px';port.style.width=width+'px';port.style.height=(height+40)+'px';tray.style.height=height+'px';
  const open=drawerShown(),shown=open?height:lip;
  // On close the page shrinks only after the drawer slid in; on open it grows at once.
  if(spacer&&(open||!drawerClosing))spacer.style.height=(shown+28)+'px';
  document.documentElement.style.setProperty('scroll-padding-bottom',(shown+12)+'px');
  if(grip){grip.setAttribute('aria-valuemin',min);grip.setAttribute('aria-valuemax',max);grip.setAttribute('aria-valuenow',height);grip.setAttribute('aria-valuetext',height+' пікселів');}
 }
 // The port only clips the drawer; a programmatic scroll (focus, find-in-page) must never leave it half-scrolled
 // with a ghost of an open drawer under a closed lip.
 root.addEventListener('scroll',e=>{if(e.target.matches?.('.tray-port')&&e.target.scrollTop)e.target.scrollTop=0;},true);
 // Lane grooves the user (or a restore) scrolled sideways; render() keeps their position without reading the others.
 const scrolledGrooves=new Set();
 root.addEventListener('scroll',e=>{if(e.target.classList?.contains('lane__groove'))scrolledGrooves.add(e.target);},true);
 function finishDrawerResize(cancel=false){
  const g=drawerGesture;if(!g)return;drawerGesture=null;if(g.frame)cancelAnimationFrame(g.frame);g.parts.tray.classList.remove('is-resizing');
  // A cancelled gesture leaves everything as it was, including a drawer it opened.
  if(cancel){state[g.key]=g.preferred;if(g.opened)state.cuts=false;resizeDrawer(preferredHeight());}else{if(g.next!=null)setDrawerHeight(g.parts,g.next,g.limits,true);storeOperator();}
  if(root.hasPointerCapture(g.pointer))root.releasePointerCapture(g.pointer);render();
 }
 root.addEventListener('pointerdown',e=>{
  const grip=e.target.closest('#cuts-resize');if(!grip||e.button!==0||drawerGesture)return;
  e.preventDefault();grip.focus({preventScroll:true});
  // The grip of a closed drawer opens it; geometry is then read once per gesture.
  const opened=!drawerShown();if(opened){state.cuts=true;render();}
  const parts=drawerParts();if(!parts)return;
  drawerGesture={opened,pointer:e.pointerId,y:e.clientY,height:parts.tray.getBoundingClientRect().height,key:heightKey(),preferred:preferredHeight(),parts,limits:drawerLimits(parts),next:null,frame:0};
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
  if(e.key==='Enter'||e.key===' '){e.preventDefault();toggleDrawer(!drawerShown());return;}
  if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;
  e.preventDefault();if(!drawerShown()){state.cuts=true;render();}
  resizeDrawer(e.key==='Home'?0:e.key==='End'?window.innerHeight:e.target.closest('.tray').getBoundingClientRect().height+(e.key==='ArrowUp'?24:-24),true);storeOperator();
 });
 // Closing the drawer also closes an editor in it (its draft stays); the CUTS key and the grip open the collection.
 function toggleDrawer(open){if(!open){state.armedCut=state.armedCut&&narrowSurface()?state.armedCut:null;state.cutTarget=null;state.poolPanel=false;state.modePanel=false;}state.cuts=open;render();storeOperator();}
 // After a render: the drawer is placed when it or the body changed; a closing drawer frees the page after its slide.
 function settleDrawer(out,force=false){
  const open=drawerShown();
  // A drawer that slides away after an editor or a form shows the collection's lip only (its grid stays empty).
  if(open)drawerLastMode=drawerMode();
  if(open!==drawerOpenShown){
   drawerOpenShown=open;clearTimeout(drawerClosing);drawerClosing=0;
   if(!open){const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;drawerClosing=setTimeout(()=>{drawerClosing=0;resizeDrawer(preferredHeight());if(!drawerShown())paintRegions([leaf('drawer/results','<div class="tray__grid"></div>')]);},reduced?0:430);}
   force=true;
  }
  if(force||out.all||touched(out,'drawer')||touched(out,'main')||touched(out,'meters'))resizeDrawer(preferredHeight());
 }
 // A tap on a CUT in the editor's source adds it at the end of the open list (a drag puts it in place instead).
 // The focus stays on the source, so several CUTS can be added in a row; the editor's line says what happened.
 function appendToEditor(route,from){
  const t=editorTarget();if(!t||state.saving)return;
  const list=chain(t.role,t.group),name=t.group==='pool'?poolNames[t.role]:'заміни';
  if(t.group==='alternatives'&&String(t.role).startsWith('vibe:')&&vibeAlias(t.role.slice(5))){notify('Заміни цього агента налаштовуються в його ролі.');return;}
  if(list.some(r=>split(r).raw===route)){state.editorMsg='Уже в списку · '+cutTitle(route);paintRegions([leaf('drawer/editor',t.group==='pool'?poolEditor():modePanel())]);return;}
  if(t.group==='alternatives'&&list.length>=12){notify('У замінах може бути до 12 CUTS.');return;}
  const m=catalogMap.get(route);if(!m||routeWarning(route)){notify('Цей CUT зараз недоступний. Обери інший.');return;}
  if(!setChain(t.role,[...list,route],t.group))return;
  state.editorMsg='Додано · '+cutTitle(route)+' → '+name+' · '+String(list.length+1).padStart(2,'0');render();
  if(from&&!from.isConnected)win.querySelector(`.tray__source [data-cut="${CSS.escape(route)}"]`)?.focus({preventScroll:true});
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
  // An editor list (a pool, the replacements) is an ordered priority list: a drop inserts at that place and moves
  // nothing out (replacing is the explicit «Заміна» of the CUT itself). A lane drop on a CUT replaces it.
  const sequence=group==='pool'||group==='alternatives',list=chain(role,group),before=JSON.stringify(list),old=!sequence&&list[index]?split(list[index]):null,effort=poolName(route)?'':carryEffort(old?.effort,route);
  const existing=list.findIndex(r=>split(r).raw===route),at=Math.min(index,list.length-(existing>=0?1:0));
  if(existing>=0){const [cut]=list.splice(existing,1);list.splice(at,0,cut);}else if(sequence)list.splice(at,0,route);else list[index]=route+(effort?':'+effort:'');
  const name=poolNames[poolName(route)]||cutTitle(route);
  state.cutTarget=null;state.armedCut=null;
  if(JSON.stringify(list)===before){if(sequence)state.editorMsg='Уже на цьому місці · '+name;else state.opFeedback='Без змін · '+name+' уже стоїть тут на '+role;render();return;}
  if(list.length>(group==='pool'?Infinity:group==='vibe'?30:group==='alternatives'?12:31)){notify('Доріжка вже має максимальну кількість CUTS.');return;}
  if(!setChain(role,list,group,existing>=0||sequence?{inserted:at}:{}))return;
  if(narrowSurface())state.cuts=false;
  if(sequence)state.editorMsg=(existing>=0?'Переставлено · ':'Вставлено · ')+name+' · '+String(at+1).padStart(2,'0');
  else state.opFeedback=withNotes((existing>=0?'Переставлено ':'Вставлено ')+(poolName(route)?name:cutTitle(route)+' · '+providerName(split(route).provider))+' → '+role+(old?.effort&&!effort&&existing<0&&!poolName(route)&&!thinkingOff(role,group)?' · thinking → типово':''));
  render();if(narrowSurface()){pickerFocus({role,index:sequence?at:index,group});scrollToControl(document.activeElement);}
 }
 function contextTokens(n){return n>=1e6?num(n/1e6)+'M':num(n/1e3)+'K';}
 function opPriceValue(m){const q=priceInfo(m);return q.kind==='free'?0:Number.isFinite(m.cost?.input)&&Number.isFinite(m.cost?.output)&&(m.cost.input||m.cost.output)?(m.cost.input+m.cost.output)/2:null;}
 // Колекція rows are filtered and sorted only when a filter, the role or the data slice changes; a search keystroke
 // then filters the sorted rows by their precomputed search keys (the order does not depend on the words).
 function catalogBase(){
  const used=state.catalogMode==='used',key=JSON.stringify([dataVersion,state.catalogMode,state.catalogProvider,state.catalogEvidence||'all',state.catalogSort,state.role,state.benchSource,state.benchRelease,state.catalogMode==='fav'?state.favs:0,used?[...referenced].length+'|'+[...referenced].join():0]);
  if(catalogBase.key===key)return catalogBase.rows;
  const mine=myProviderIds(),favs=new Set(state.favs),changed=new Set(source.changes.map(x=>x.route));
  let rows=catalog.filter(m=>(state.catalogMode!=='mine'||mine.has(m.provider))&&(state.catalogProvider==='all'||m.provider===state.catalogProvider)&&(state.catalogMode!=='free'||priceInfo(m).kind==='free')&&(!used||referenced.has(m.provider+'/'+m.id))&&(state.catalogMode!=='fav'||favs.has(m.provider+'/'+m.id))&&(state.catalogMode!=='changes'||changed.has(m.provider+'/'+m.id)));
  if(state.catalogEvidence&&state.catalogEvidence!=='all')rows=rows.filter(m=>evidenceCoverage(m).kind===state.catalogEvidence);
  // Sort keys are computed once per row, never inside the comparator.
  const keyed=rows.map(m=>{const score=opEvidence(m)?.score??-1,cost=opPriceValue(m)??Infinity,coverage=state.catalogSort==='evidence'?evidenceCoverage(m):null;return {m,score,cost,coverage,value:score>=0&&cost>0&&cost<Infinity?score/cost:-Infinity};});
  keyed.sort(state.catalogSort==='evidence'?(a,b)=>b.coverage.sources.length-a.coverage.sources.length||b.coverage.claims-a.coverage.claims||collate(a.m.name,b.m.name):state.catalogSort==='price'?(a,b)=>a.cost-b.cost||b.score-a.score:state.catalogSort==='value'?(a,b)=>b.value-a.value||b.score-a.score:state.catalogSort==='name'?(a,b)=>collate(a.m.name,b.m.name):(a,b)=>b.score-a.score||a.cost-b.cost);
  catalogBase.key=key;return catalogBase.rows=keyed.map(x=>x.m);
 }
 function analyticalModels(){const words=queryWords(state.catalogQuery),rows=catalogBase();return words.length?rows.filter(m=>matchesWords(words,searchKey(m).cut)):rows;}
 // Колекція screens: the price × score scatter and the inspector on black glass, each with its own ТОН encoder.
 function analyzerPlot(rows){
  const rated=rows.map(m=>({m,q:opEvidence(m),cost:opPriceValue(m)})).filter(x=>x.q&&x.cost!==null),paid=rated.filter(x=>x.cost>0),minCost=Math.min(.1,...paid.map(x=>x.cost)),maxCost=Math.max(10,...paid.map(x=>x.cost)),selected=state.analyze||rows[0]?.provider+'/'+rows[0]?.id;
  const xpos=cost=>cost===0?.05:.17+Math.log(cost/minCost)/Math.log(maxCost/minCost)*.79,f=v=>v.toFixed(4);
  const ticks=[...new Set([minCost,...[.01,.1,1,10,100].filter(n=>n>minCost&&n<maxCost),maxCost])];
  const chosen=rated.find(x=>x.m.provider+'/'+x.m.id===selected);
  const plot=rated.length?`<div class="g-plot" role="group" aria-label="Оцінка ролі та довідкова API ціна"><div class="g-plot__zone" style="--w:.11"><span>FREE</span></div>${ticks.map(n=>`<i class="g-plot__tick" style="--x:${f(xpos(n))}"></i>`).join('')}${rated.slice(0,180).map(({m,q,cost})=>{const route=m.provider+'/'+m.id,active=route===selected,label=cutTitle(route)+' · '+providerName(m.provider)+' · оцінка '+num(q.score)+' · $'+num(cost);return `<button type="button" class="g-plot__pt${cost===0?' is-free':''}" data-analyze="${esc(route)}" style="--x:${f(xpos(cost))};--y:${f(q.score/100)}" aria-pressed="${active}" aria-label="${esc(label)}" title="${esc(label)}"></button>`;}).join('')}<div class="g-plot__y"><span>100</span><span>50</span><span>0</span></div></div><div class="g-plot__x g-plot__x--abs"><span style="--x:${f(xpos(0))}">FREE</span>${ticks.map(n=>`<span style="--x:${f(xpos(n))}">$${n<.1?n.toPrecision(1):num(n)}</span>`).join('')}</div>`:`<div class="g-empty"><span class="g-empty__glyph">∅</span><span>Немає зіставних тестів і цін для цього зрізу</span></div>`;
  return `<div class="screen screen--wide" data-screen="analysis" data-screen-default="200">${glass(`<div class="g-head"><span class="g-name">ЦІНА × ТЕСТИ</span><span class="g-age">${esc(state.benchSource)} · ${esc(state.benchRelease)}</span><span class="g-grow"></span>${chosen?`<span class="g-acc g-head__sel">${esc(cutTitle(chosen.m.provider+'/'+chosen.m.id))} · ${num(chosen.q.score)}</span>`:''}</div>${plot}<div class="g-legend"><span>оцінка ролі / 100</span><span>середнє input / output · <b>$</b>/1M · лог. шкала</span><span>довідкова ціна API, не рахунок підписки${rated.length>180?' · на графіку перші 180':''}</span></div>`)}<div class="screen__chin"><span class="screen__id">${led(rated.length>0,'green')}<span class="silk">аналіз</span></span><span class="strip__grow"></span>${hueEncoder('analysis','Ціна × тести',200)}</div></div>`;
 }
 // The best tested CUT of each provider for the role: keys that narrow the collection to that provider.
 function providerFitStrip(rows){
  if(state.catalogProvider!=='all')return '';
  const best=new Map();for(const m of rows){const q=opEvidence(m);if(q&&(!best.has(m.provider)||best.get(m.provider).q.score<q.score))best.set(m.provider,{m,q});}
  if(!best.size)return '';
  return `<div class="coll__fits" role="group" aria-label="Найкращі тестовані CUTS провайдерів · ${esc(labels[state.role]||state.role)}"><span class="silk">Найкращі · ${esc(state.role)}</span>${[...best.values()].sort((a,b)=>b.q.score-a.q.score).slice(0,5).map(({m,q})=>`<button type="button" class="key" data-catalog-provider="${esc(m.provider)}" aria-label="${esc(providerName(m.provider)+' · '+cutTitle(m.provider+'/'+m.id)+' · оцінка '+num(q.score))}"><span class="key__cap"><span class="key__txt"><b>${esc(providerName(m.provider))} <span class="rd" style="--rd:4ch">${num(q.score)}</span></b><span class="key__sub">${esc(cutTitle(m.provider+'/'+m.id))} · ${esc(q.record.effort||'типово')}</span></span></span></button>`).join('')}</div>`;
 }
 // Evidence on the inspector glass: the kind is a word on a chip (тест / Arena / заява), the source next to it.
 const KIND_CHIP={benchmark:['тест','ok'],preference:['Arena',''],developer:['заява','warn']};
 function evidenceRows(m){
  return evidence.summary(modelRecords(m)).map(r=>{const kind=evidence.kind(r),[label,s]=KIND_CHIP[kind]||KIND_CHIP.benchmark,[k,v]=Object.entries(r.scores||{})[0]||[];
   const value=kind==='preference'?num(r.rating):v!=null?num(v)+'%':'—',what=kind==='preference'?'уподобання':kind==='developer'?(r.publisher||'розробник')+(k?' · '+k:''):(r.source==='Artificial Analysis'?'AA':r.source)+(k?' · '+k:'');
   return `<div class="g-kv" title="${esc((kind==='developer'?r.publisher:r.source)+' · '+(r.release||'')+' · '+r.id+(r.effort?' · '+r.effort:''))}"><span><span class="g-chip"${s?` data-s="${s}"`:''}>${label}</span> ${esc(what)}</span><i></i><b>${value}</b></div>`;}).join('');
 }
 function analyzerDetail(rows){
  const m=catalogMap.get(state.analyze)||rows[0];
  const chin=(extra='')=>`<div class="screen__chin">${extra}<span class="strip__grow"></span>${hueEncoder('inspector','Інспектор CUT',200)}</div>`;
  if(!m)return `<div class="screen screen--insp" data-screen="inspector" data-screen-default="200" id="coll-inspector" tabindex="-1">${glass('<div class="g-empty"><span class="g-empty__glyph">∅</span><span>Немає CUTS за цими фільтрами</span></div>')}${chin()}</div>`;
  const route=m.provider+'/'+m.id,q=opEvidence(m),h=opHealth(m),editions=catalog.filter(x=>op.normalize(x.id)===op.normalize(m.id)),fav=state.favs.includes(route),[hcls]=HEALTH_VIEW[h.kind]||HEALTH_VIEW.unknown;
  const kv=(k,v,title='')=>`<div class="g-kv"${title?` title="${esc(title)}"`:''}><span>${k}</span><i></i><b>${v}</b></div>`;
  const tests=q?`${kv(esc(labels[state.role]||state.role)+' · бал',num(q.score),'Зважена оцінка тестів / 100')}<div class="g-score" style="--v:${(q.score/100).toFixed(3)}"><i></i></div>${Object.entries(q.weights).map(([k,w])=>`${kv(esc(k)+' · '+Math.round(w*100)+'%',num(q.record.scores[k]))}<div class="g-score" style="--v:${(Math.max(0,Math.min(100,q.record.scores[k]||0))/100).toFixed(3)}"><i></i></div>`).join('')}<div class="g-hint">${esc(q.record.id)} · ${esc(q.record.effort||'режим джерела')} · ${esc(q.record.source)} · ${esc(q.record.release)} · орієнтир для ролі, не тест провайдера</div>`:`${kv(esc(labels[state.role]||state.role)+' · бал','—')}<div class="g-hint">Для цієї ролі та версії немає повного набору тестів; окремі виміри нижче.</div>`;
  const caps=`${kv('контекст',m.contextWindow?contextTokens(m.contextWindow):'—')}${kv('вихід',m.maxTokens?contextTokens(m.maxTokens):'—')}${kv('зір',Array.isArray(m.input)?m.input.includes('image')?'так':'ні':'—')}${kv('міркування',m.reasoning===true?'так':m.reasoning===false?'ні':'—')}`;
  const list=[...editions].sort((a,b)=>(opPriceValue(a)??Infinity)-(opPriceValue(b)??Infinity)).slice(0,state.allEditions?editions.length:4);
  const eds=list.map(x=>`<button type="button" class="g-kv g-kv--btn" data-analyze="${esc(x.provider+'/'+x.id)}"${x===m?' aria-current="true"':''}><span>${esc(providerName(x.provider))}</span><i></i><b>${esc(priceInfo(x).label)}</b></button>`).join('');
  const ev=evidenceRows(m);
  const glassInner=`<div class="g-insp"><div class="g-insp__title"><b>${esc(cutTitle(route))}</b><span class="g-chip g-chip--dim">${esc(providerName(m.provider))}</span></div><div class="g-dim g-insp__id">${esc(m.id)}</div><div class="g-rule"></div>${tests}<div class="g-rule"></div>${caps}${kv('ціна · вхід / вихід $/1M',esc(priceInfo(m).label))}${ev?`<div class="g-rule"></div><div class="g-hint">тест — незалежний · Arena — людські уподобання · заява — розробник</div>${ev}`:''}<div class="g-rule"></div><div class="g-hint">EDITION · вхід / вихід $/1M</div>${eds}<div class="g-msg" data-s="${hcls==='ok'||hcls==='gpu'?'ok':hcls==='low'?'warn':hcls==='zero'||hcls==='off'?'bad':''}"><span>${healthGlyph[h.kind]} ${esc(h.label)}</span></div></div>`;
  return `<div class="screen screen--insp" data-screen="inspector" data-screen-default="200" id="coll-inspector" tabindex="-1" aria-label="Інспектор CUT · ${esc(cutTitle(route))}">${glass(glassInner)}${chin(`<button type="button" class="key key--sm coll__back" data-action="coll-back" aria-label="До списку CUTS"><span class="key__cap">↑ До списку</span></button><button type="button" class="key key--sm key--sq" data-fav="${esc(route)}" aria-pressed="${fav}" aria-label="${fav?'Прибрати з обраних':'Додати в обрані'}" title="${fav?'В обраних':'До обраних'}"><span class="key__cap">${fav?'★':'☆'}</span></button><button type="button" class="key key--sm" data-model-detail="${esc(route)}"><span class="key__cap">Всі дані</span></button>${editions.length>4?`<button type="button" class="key key--sm" data-action="all-editions" aria-pressed="${!!state.allEditions}"><span class="key__cap">${state.allEditions?'Стиснути':'Усі EDITION · '+editions.length}</span></button>`:''}`)}</div>`;
 }
 // A row's evidence as printed chips with words: «тест AA», «Arena», «заява» (the legend above the list explains).
 const SOURCE_SHORT={'Artificial Analysis':'AA'};
 function evidenceChips(m){const c=evidenceCoverage(m),chips=c.sources.map(s=>s==='Arena'?'<span class="chip">Arena</span>':`<span class="chip chip--ok">тест ${esc(SOURCE_SHORT[s]||s)}</span>`);if(c.claims)chips.push('<span class="chip chip--warn">заява</span>');return chips.join('')||'<span class="coll__none">без тестів</span>';}
 function evidenceCoverageLine(rows){const counts={independent:0,developer:0,unknown:0};for(const m of rows)counts[evidenceCoverage(m).kind]++;return `<b>${rows.length}</b> CUTS · незалежні дані: <b>${counts.independent}</b> · лише заяви: <b>${counts.developer}</b> · без даних: <b>${counts.unknown}</b>`;}
 // Колекція: controls, search field and every result block are regions; a search keystroke repaints only
 // the result blocks whose content changed (catalogBody), never the field being typed into.
 function catalogData(){
  const rows=analyticalModels(),per=12;state.page=Math.max(0,Math.min(state.page,Math.ceil(rows.length/per)-1));const shown=rows.slice(state.page*per,(state.page+1)*per),selected=source.providers.find(v=>v.id===state.catalogProvider);
  return {rows,shown,selected,per};
 }
 function catalogReleases(){return [...new Set((source.insights?.benchmarks?.records||[]).filter(b=>b.source===state.benchSource).map(b=>b.release))].sort().reverse();}
 function operatorCatalog(){const data=catalogData();return box('m/catalog','<section class="coll" aria-label="Колекція CUTS · аналітика">',[box('m/ctl','<div class="bay coll__ctl">',[leaf('m/source',catalogSearch(data)),leaf('m/controls',catalogControls())]),...catalogBody(data)]);}
 function catalogControls(){
  const releases=catalogReleases();
  return `${selWin('catalog-provider','Провайдер',state.catalogProvider,analyticalProviders())}${selWin('op-scope','Колекція',state.catalogMode,[['mine','Мої'],['all','Увесь каталог'],['free','FREE CUTS'],['used','У профілях'],['fav','Обрані'],['changes','Нові / зниклі']])}${selWin('op-role','Роль',state.role,roleKeys.map(r=>[r,labels[r]&&labels[r]!==r?r+' · '+labels[r]:r]))}${selWin('op-sort','Порядок',state.catalogSort,[['score','Топ за балом ролі'],['evidence','Покриття тестами'],['price','Нижча ціна'],['value','Тести / API $'],['name','За назвою']])}<span class="seam seam--v coll__seam"></span>${selWin('op-source','Бал ролі',state.benchSource,[['Artificial Analysis','Artificial Analysis'],['LiveBench','LiveBench']])}${selWin('op-release','Зріз',state.benchRelease,releases.length?releases.map(r=>[r,r]):[['','—']],'sel--sm',releases.length?'':'disabled')}${selWin('op-evidence','Дані',state.catalogEvidence||'all',[['all','Усі'],['independent','Незалежні'],['developer','Лише заяви'],['unknown','Без даних']])}${key('+ Провайдер','provider-add','coll__add')}`;
 }
 function catalogSearch(){return `<label class="search coll__search">${SVG.search}<input id="catalog-query" type="search" value="${esc(state.catalogQuery)}" placeholder="CUT або провайдер" aria-label="Знайти CUT у колекції" autocomplete="off"></label>`;}
 function ledgerRow(m,selected,tabbable=selected){
  const route=m.provider+'/'+m.id,q=opEvidence(m),h=opHealth(m),[hcls,glyph]=HEALTH_VIEW[h.kind]||HEALTH_VIEW.unknown,price=priceInfo(m),title=cutTitle(route);
  return `<button type="button" class="list__row coll__row" role="option" aria-selected="${selected}" tabindex="${tabbable?0:-1}" data-analyze="${esc(route)}" title="${esc(title+'\n'+route)}">${led(selected,'blue')}<span class="coll__name"><b>${esc(title)}</b><small>${esc(providerName(m.provider))} · ${esc(m.id)}${m.status==='missing'?' · DELETED':''}</small><span class="coll__ev">${evidenceChips(m)}</span></span><span class="coll__score"><b class="rd" style="--rd:4ch">${q?num(q.score):'—'}</b><small>${q?esc(q.record.effort||'типово'):{independent:'немає бала',developer:'лише заяви',unknown:'немає даних'}[evidenceCoverage(m).kind]}</small></span><span class="coll__price">${price.kind==='free'?'<span class="stamp stamp--free">FREE</span>':`<b>${esc(price.label)}</b>`}<small>${price.kind==='free'?'безкоштовно':price.subscription?'підписка · API-тариф':price.variable?'змінний тариф':price.kind==='paid'?'вхід / вихід':price.kind==='local'?'власний GPU':'немає тарифу'}</small></span><span class="coll__ctx"><b class="rd" style="--rd:5ch">${m.contextWindow?contextTokens(m.contextWindow):'—'}</b><small><span class="hs hs--${hcls}" aria-hidden="true">${glyph}</span> ${esc(h.label)}</small></span></button>`;
 }
 function catalogBody({rows,shown,selected,per}=catalogData()){
  const pick=state.analyze||(rows[0]?rows[0].provider+'/'+rows[0].id:''),q=state.catalogQuery.trim(),pages=Math.max(1,Math.ceil(rows.length/per));
  const ledger=shown.length?`<div class="coll__lhead" aria-hidden="true"><span>CUT · провайдер · дані</span><span>бал / 100</span><span>$ / 1M</span><span>контекст</span></div><div class="list coll__list" role="listbox" aria-label="CUTS · ${esc(labels[state.role]||state.role)} · сторінка ${state.page+1} з ${pages}">${shown.map((m,i,rows)=>ledgerRow(m,m.provider+'/'+m.id===pick,m.provider+'/'+m.id===pick||i===0&&!rows.some(x=>x.provider+'/'+x.id===pick))).join('')}</div><div class="coll__goto"><button type="button" class="key key--sm" data-action="coll-details"><span class="key__cap">Дані обраного CUT ↓</span></button></div>`
   :`<div class="list coll__list"><div class="empty"><span class="empty__glyph" aria-hidden="true">∅</span><span>${q?`Нічого не знайдено за «<b>${esc(q)}</b>»`:catalogEmpty()?'Каталог порожній · додай провайдера':'Немає CUTS за цими фільтрами'}</span>${q?'<button type="button" class="key key--sm" data-action="catalog-clear"><span class="key__cap">Очистити</span></button>':catalogEmpty()?key('+ Провайдер','provider-add','key--sm'):''}</div></div>`;
  const cartridge=selected?`<div class="bay coll__cart">${led(true,selected.expired?'red':selected.connected?'green':'amber')}<span class="coll__cartname"><b>${esc(providerName(selected.id))}</b><small>${selected.count} ${plural(selected.count,'модель','моделі','моделей')} · ${selected.expired?'термін минув':selected.connected?'доступний в OMP':'доступ не підтверджено'}${selected.expires?' · до '+esc(timeLabel(selected.expires)):''}</small></span><button type="button" class="key key--sm" data-provider-toggle="${esc(selected.id)}" aria-pressed="${!(eff().disabledProviders||[]).includes(selected.id)}"${presetLike()?' disabled title="Провайдери належать області: змінюй їх у Standard"':''}><span class="key__cap">${led(false,'green',' data-latch')}У профілі</span></button>${selected.custom||selected.managed?`<button type="button" class="key key--sm" data-edit-provider="${esc(selected.id)}"><span class="key__cap">Підключення…</span></button>`:''}<span class="print">${rows.filter(m=>opEvidence(m)).length} ${plural(rows.filter(m=>opEvidence(m)).length,'тестований маршрут','тестовані маршрути','тестованих маршрутів')} для ${esc(state.role)}</span></div>`:'';
  return [leaf('m/coverage',`<div class="coll__cov"><p class="print">${evidenceCoverageLine(rows)}</p><p class="print print--hint">тест — незалежний тест · Arena — людські уподобання (рейтинг) · заява — заява розробника</p></div>`),leaf('m/cartridge',cartridge),leaf('m/fits',providerFitStrip(rows)),
   box('m/layout','<div class="coll__layout">',[box('m/main','<div class="coll__main">',[leaf('m/plot',analyzerPlot(rows)),leaf('m/ledger',`<div class="coll__ledger">${ledger}</div>`),leaf('m/pagination',rows.length>per?`<div class="keybed coll__pager" role="group" aria-label="Сторінки">${key('←','prev-page','key--sm key--sq',`aria-label="Попередня сторінка"${state.page===0?' disabled':''}`)}<span class="coll__page"><span class="rd" style="--rd:9ch">${state.page*per+1}–${Math.min((state.page+1)*per,rows.length)} / ${rows.length}</span></span>${key('→','next-page','key--sm key--sq',`aria-label="Наступна сторінка"${(state.page+1)*per>=rows.length?' disabled':''}`)}</div>`:'')]),leaf('m/inspector',analyzerDetail(rows))]),
   leaf('m/note',`<p class="print print--hint coll__note">Порівняння в одному джерелі й зрізі. У каталозі — найкращий доступний тестований режим; його назва біля бала. Ціни невідомого типу й безкоштовні маршрути не ранжуються за «тести / $».</p>`)];
 }
 function historyBins(points){if(historyBins.memo?.points===points)return historyBins.memo.bins;let out=[];if(points.length){const start=Math.min(...points.map(x=>x.timestamp)),end=Math.max(...points.map(x=>x.timestamp)),map=new Map(points.map(x=>[x.timestamp,x]));for(let t=Math.max(start,end-167*3600000);t<=end;t+=3600000)out.push(map.get(t)||{timestamp:t,gap:true});}historyBins.memo={points,bins:out};return out;}
 // Історія: the hourly bars on black glass (selected hour lit), the reading and the hour's sample. The screen element
 // stays; only its glass content is replaced, so scrubbing never repaints the palette.
 const HISTORY_SIGNALS=[['requests','Запити'],['tokens','Токени'],['errors','Помилки'],['cost','API $']];
 const HISTORY_SORTS=[['totalRequests','Запити'],['totalCost','API оцінка'],['avgTokensPerSecond','Швидкість'],['failedRequests','Помилки']];
 function historyData(){
  const stats=source.insights?.stats||{},bins=historyBins(stats.timeSeries||[]),metric=state.historyMetric,selected=bins.findIndex(b=>b.timestamp===state.historyAt),index=selected>=0?selected:Math.max(0,bins.length-1);
  return {stats,o:stats.overall||{},bins,metric,index,active:bins[index],peak:Math.max(1,...bins.map(b=>b[metric]||0)),labelsM:Object.fromEntries(HISTORY_SIGNALS)};
 }
 function historyRead({active,metric,labelsM}){return `<div class="g-bars__read" aria-live="polite"><span class="g-acc">${active?esc(timeLabel(active.timestamp/1000)):'немає даних'}</span><b class="win__v">${num(active?.[metric])}</b><span class="g-dim">${active?.gap?'немає виміру':esc(labelsM[metric])+' за годину'}</span></div>`;}
 // The bars never carry the selection in their string: scrubbing repaints the reading and the sample only, and
 // markHistoryBin() lights the chosen bar (aria-selected, roving tabindex) as a decoration.
 function historyPlot({bins,metric,labelsM,peak}){
  const step=Math.max(1,Math.round(bins.length/6)),hourLabel=t=>{const d=new Date(t);return d.getHours()===0?d.getDate()+'д':String(d.getHours()).padStart(2,'0');};
  const axis=bins.length?bins.filter((b,i)=>i%step===0||i===bins.length-1).map(b=>`<span>${hourLabel(b.timestamp)}</span>`).join(''):'';
  return bins.length?`<div class="g-bars__plot" role="listbox" aria-label="Погодинна історія OMP · ${esc(labelsM[metric])}" style="--plot-h:96px">${bins.map((b,i)=>`<button type="button" data-history-bin="${i}" role="option" aria-selected="false" tabindex="-1"${b.gap?' class="is-empty"':''} style="--h:${b.gap?0:Math.max(.02,(b[metric]||0)/peak).toFixed(3)}" aria-label="${esc(timeLabel(b.timestamp/1000)+' · '+(b.gap?'немає виміру':num(b[metric])+' '+labelsM[metric]))}"></button>`).join('')}</div><div class="g-bars__axis" aria-hidden="true">${axis}</div>`:'<div class="g-empty"><span class="g-empty__glyph">∅</span><span>Ще немає вимірів</span></div>';
 }
 function historySample({active}){const cell=(l,v)=>`<div class="win"><div class="win__top"><span class="win__l">${l}</span><b class="win__v">${v}</b></div></div>`;return `<div class="wins wins--sample">${cell('Запити',num(active?.requests))}${cell('Помилки',num(active?.errors))}${cell('Токени',num(active?.tokens))}${cell('API ≈ $',num(active?.cost))}</div>`;}
 function historyGlass(data){
  const {metric,labelsM,stats}=data;
  return box('h/g','<div class="g">',[leaf('h/ghead',`<div class="g-head"><span class="g-name">ІСТОРІЯ OMP</span><span class="g-age">${esc(stats.scope||'OMP')}</span><span class="g-grow"></span><span class="g-acc">${esc(labelsM[metric])}</span></div>`),box('h/bars','<div class="g-bars">',[leaf('h/read',historyRead(data)),leaf('h/plot',historyPlot(data))]),leaf('h/rule','<div class="g-rule"></div>'),leaf('h/sample',historySample(data))]);
 }
 function markHistoryBin(){
  const plot=win.querySelector('.g-bars__plot');if(!plot)return;const i=String(historyData().index);
  for(const el of plot.querySelectorAll('[aria-selected=true]'))if(el.dataset.historyBin!==i){el.setAttribute('aria-selected','false');el.tabIndex=-1;}
  const el=plot.querySelector(`[data-history-bin="${i}"]`);if(el&&el.getAttribute('aria-selected')!=='true'){el.setAttribute('aria-selected','true');el.tabIndex=0;}
 }
 function historyScreen(data){
  return box('h/lcd','<div class="screen screen--wide" data-screen="history" data-screen-default="150">',[nest('h/win',GLASS_OPEN,[box('h/content','<div class="glass__content">',[historyGlass(data)]),leaf('h/sweep','<div class="glass__sweep"></div>')]),leaf('h/chin',`<div class="screen__chin"><span class="screen__id">${led(data.bins.length>0,'green')}<span class="silk">ця година</span></span><span class="strip__grow"></span>${hueEncoder('history','Історія роботи',150)}</div>`)]);
 }
 // A keyed choice (signal, measure): radio keys in one bed; arrows move and select.
 function radioKeys(name,label,value,items){return `<div class="keybed" role="radiogroup" aria-label="${esc(label)}">${items.map(([k,t])=>`<button type="button" class="key key--sm" role="radio" data-radio="${name}" data-value="${esc(k)}" aria-checked="${k===value}" tabindex="${k===value?0:-1}"><span class="key__cap">${led(k===value,'orange')}${esc(t)}</span></button>`).join('')}</div>`;}
 function historyPosition({bins,index,active}){return `<span class="rd" style="--rd:5ch">${active?dateFormat({hour:'2-digit',minute:'2-digit'}).format(active.timestamp):'—'}</span>`;}
 function historyFader({bins,index,active}){return `<input class="fader" id="history-position" type="range" min="0" max="${Math.max(1,bins.length-1)}" value="${index}" step="1" aria-label="Позиція в історії" aria-valuetext="${esc(active?timeLabel(active.timestamp/1000):'немає даних')}" ${!bins.length?'disabled':''}>`;}
 // Історія: controls, the screen, the counters and every list are regions; scrubbing the fader repaints the glass
 // content and the position readout only (the fader itself is adopted, so the hand never loses it).
 function historySurface(){
  const data=historyData(),{stats,o}=data,models=[...(stats.byModel||[])].sort((a,b)=>(b[state.historySort]||0)-(a[state.historySort]||0)),max=Math.max(1,...models.map(m=>m[state.historySort]||0));
  const counter=(label,value,unit='')=>`<div class="counter"><span class="silk">${label}</span><span class="counter__win"><b>${value}</b>${unit?`<small>${unit}</small>`:''}</span></div>`;
  const unitFor={totalRequests:'',totalCost:'$',avgTokensPerSecond:'ток/с',failedRequests:''};
  return box('h/surface','<section class="hist" aria-label="Історія OMP">',[
   box('h/controls','<div class="bay hist__ctl">',[leaf('h/signal',`<div class="hist__grp"><span class="silk">Сигнал</span>${radioKeys('history-metric','Сигнал історії',data.metric,HISTORY_SIGNALS)}</div>`),
    box('h/pos','<div class="hist__pos">',[leaf('h/posout',`<span class="silk"><label for="history-position">Позиція</label> ${historyPosition(data)}</span>`),leaf('h/fader',historyFader(data))]),
    leaf('h/period',`<div class="hist__period"><span class="silk">Період</span><b>${o.firstTimestamp?esc(timeLabel(o.firstTimestamp/1000))+' — '+esc(timeLabel(o.lastTimestamp/1000)):'ще немає вимірів'}</b><small class="print print--hint">${esc(stats.scope||'OMP')} · оновлено ${esc(timeLabel(stats.at))}</small></div>`)]),
   historyScreen(data),
   leaf('h/counters',`<div class="hist__sum"><span class="silk">Увесь період звіту</span><div class="hist__counters" role="group" aria-label="Увесь період звіту">${counter('Запитів',num(o.totalRequests))}${counter('Помилки',num(o.failedRequests),o.errorRate!=null?num(o.errorRate*100)+'%':'')}${counter('Кеш',o.cacheRate!=null?num(o.cacheRate*100)+'%':'—')}${counter('Перший токен',o.avgTtft!=null?num(o.avgTtft/1000):'—',o.avgTtft!=null?'с':'')}${counter('Швидкість',num(o.avgTokensPerSecond),'ток/с')}</div></div>`),
   leaf('h/sort',`<div class="hist__head"><span class="silk">Внесок моделей · весь період</span><span class="subhead__rule"></span>${radioKeys('history-sort','Вимір внеску',state.historySort,HISTORY_SORTS)}</div>`),
   leaf('h/mixdown',models.length?`<div class="list hist__mix" role="list" aria-label="Внесок моделей">${models.map(m=>`<div class="hist__row" role="listitem"><span class="hist__name"><b title="${esc(m.provider+'/'+m.model)}">${esc(cutTitle(m.provider+'/'+m.model))}</b><small>${esc(providerName(m.provider))}${split(m.model).effort?' · '+esc(split(m.model).effort):''}</small></span><span class="hist__bar" style="--v:${((m[state.historySort]||0)/max).toFixed(3)}" aria-hidden="true"><i></i></span><b class="rd hist__val" style="--rd:7ch">${num(m[state.historySort])}${unitFor[state.historySort]?' <small>'+unitFor[state.historySort]+'</small>':''}</b><span class="print print--hint hist__detail">${num(m.failedRequests)} ${plural(m.failedRequests||0,'помилка','помилки','помилок')} · ${num(m.avgTokensPerSecond)} ток/с · ${m.avgTtft!=null?num(m.avgTtft/1000)+' с':'—'}</span></div>`).join('')}</div>`:'<div class="list hist__mix"><div class="empty"><span class="empty__glyph" aria-hidden="true">∅</span><span>Статистика ще не зібрана</span></div></div>'),
   leaf('h/splices',`<div class="hist__head"><span class="silk">Зміни колекції</span><span class="subhead__rule"></span></div>${source.changes.length?`<div class="list hist__changes" role="list">${source.changes.slice(-8).reverse().map(c=>`<div class="hist__change" role="listitem"><span class="hist__sign${c.kind==='new'?' is-new':''}" aria-label="${c.kind==='new'?'нова':'зникла'}">${c.kind==='new'?'+':'−'}</span><b>${esc(cutTitle(c.route))}</b><small>${esc(providerName(split(c.route).provider))} · ${esc(timeLabel(c.at))}</small></div>`).join('')}</div>`:'<div class="list hist__changes"><div class="empty"><span class="empty__glyph" aria-hidden="true">∅</span><span>Після першого знімка змін немає</span></div></div>'}`),
   leaf('h/note',`<p class="print print--hint hist__note">${source.demo?'Синтетичні дані DEMO.':'Реальні агрегати OMP, не журнал окремих задач.'} Погодинний вибір змінює екран; внесок моделей — за весь період. API $ — оцінка за тарифами, не платіж підписки. ${esc(stats.error||'')}</p>`)
  ]);
 }
 // Scrub: the bar, the reading and the sample follow the fader live; the fader keeps its own element.
 function scrubHistory(index,commit=false){
  const bins=historyBins(source.insights?.stats?.timeSeries||[]),bin=bins[index];if(!bin)return;
  state.historyAt=bin.timestamp;const data=historyData();
  paintRegions([leaf('h/read',historyRead(data)),leaf('h/sample',historySample(data)),leaf('h/posout',`<span class="silk"><label for="history-position">Позиція</label> ${historyPosition(data)}</span>`)],[leaf('h/fader',historyFader(data))]);
  markHistoryBin();const fader=win.querySelector('#history-position');if(fader&&fader.value!==String(index))fader.value=String(index);fader?.setAttribute('aria-valuetext',timeLabel(bin.timestamp/1000));
  if(commit)store();
 }
 root.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&!e.defaultPrevented&&!state.modal&&!state.picker&&!e.target.matches('select')&&state.armedCut){e.preventDefault();state.armedCut=null;state.cutTarget=null;state.opFeedback='Вставку скасовано.';render();((drawerShown()&&win.querySelector('#cut-query'))||win.querySelector('[data-op-switch=cuts]'))?.focus({preventScroll:true});return;}
 });
 root.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.opSwitch){const name=b.dataset.opSwitch;
   if(name==='health'){
    // HEALTH is a pure visual switch: the key's and the surfaces' attributes change; the tape and its marks stay,
    // and the CSS transition grows the bars back (only on this user action).
    state.health=!state.health;state.opFeedback=state.health?'HEALTH · колір і шкала на CUT показують найменший доступний ліміт. ? — немає свіжого виміру.':'HEALTH вимкнено · показано чисту плівку.';
    regions.reopen('p/deck',deckOpen());regions.reopen('drawer/tray',trayOpen());paintRegions([dockSwitches(),leaf('feedback',operatorFeedback())]);
   }else{if(name==='cuts'){toggleDrawer(!drawerShown());win.querySelector('[data-op-switch="cuts"]')?.focus({preventScroll:true});return;}if(name==='free')state.freeCuts=!state.freeCuts;render();}
   storeOperator();win.querySelector(`[data-op-switch="${name}"]`)?.focus({preventScroll:true});return;}
  if(b.dataset.action==='cuts-toggle'){toggleDrawer(!drawerShown());win.querySelector('.tray__title')?.focus({preventScroll:true});return;}
  if(b.dataset.foldToggle!==undefined){const k=b.dataset.foldToggle,fold=laneGroups().find(g=>g.fold?.[0]===k)?.fold||[k],open=foldOpen(fold);for(const r of fold)if(open)openFolds.delete(r);else openFolds.add(r);storeFolds();render();win.querySelector(`[data-fold-toggle="${CSS.escape(k)}"]`)?.focus({preventScroll:true});return;}
  if(b.hasAttribute('data-sync-vibe')){state.syncVibe=!state.syncVibe;store();render();win.querySelector('[data-sync-vibe]')?.focus({preventScroll:true});return;}
  if(b.dataset.cut&&editorKind()&&b.closest('.tray__source')){appendToEditor(b.dataset.cut,b);return;}
  if(b.dataset.cut){if(b.closest('.ghost'))return;if(state.cutTarget)placeCut(b.dataset.cut,state.cutTarget);else if(state.armedCut===b.dataset.cut){state.armedCut=null;render();}else{state.armedCut=b.dataset.cut;state.opFeedback='CUT обрано. Торкнись CUT для заміни або гнізда «+», щоб вставити.';if(state.view!=='profiles')state.view='profiles';if(narrowSurface())state.cuts=false;render();if(narrowSurface())win.querySelector('.tray__armed [data-action=cancel-cut]')?.focus({preventScroll:true});}return;}
  if(b.dataset.action==='cancel-cut'){state.armedCut=null;state.cutTarget=null;state.opFeedback='Вставку скасовано.';render();win.querySelector('[data-op-switch=cuts]')?.focus({preventScroll:true});return;}
  if(b.dataset.action==='cuts-clear'){state.cutQuery='';render();win.querySelector('#cut-query')?.focus({preventScroll:true});return;}
  if(b.dataset.analyze){selectCatalogRow(b.dataset.analyze,!b.closest('.coll__row'));return;}
  if(b.dataset.providerToggle){const id=b.dataset.providerToggle;if(presetLike())return;const list=(eff().disabledProviders||[]).filter(x=>x!==id);if(b.getAttribute('aria-pressed')==='true')list.push(id);p().disabledProviders=list;render();win.querySelector(`[data-provider-toggle="${CSS.escape(id)}"]`)?.focus({preventScroll:true});return;}
  if(b.dataset.action==='coll-details'){const panel=win.querySelector('#coll-inspector');panel?.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});panel?.focus({preventScroll:true});return;}
  if(b.dataset.action==='coll-back'){const row=win.querySelector('.coll__row[aria-selected=true]')||win.querySelector('.coll__row');row?.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});row?.focus({preventScroll:true});return;}
  if(b.dataset.action==='catalog-clear'){state.catalogQuery='';state.page=0;state.analyze=null;render();win.querySelector('#catalog-query')?.focus({preventScroll:true});return;}if(b.dataset.action==='all-editions'){state.allEditions=!state.allEditions;render();return;}
  if(b.hasAttribute('data-history-bin')){const i=Number(b.dataset.historyBin);scrubHistory(i,true);win.querySelector(`[data-history-bin="${i}"]`)?.focus({preventScroll:true});return;}
  if(b.dataset.radio==='migrate-mode'){if(state.migrate&&!b.disabled){state.migrate.mode=b.dataset.value;state.migrate.accept=false;modalFit='';regions.invalidate('drawer/form');render();win.querySelector(`[data-radio="migrate-mode"][data-value="${CSS.escape(b.dataset.value)}"]`)?.focus({preventScroll:true});}return;}
  if(b.dataset.radio){const field={'history-metric':'historyMetric','history-sort':'historySort'}[b.dataset.radio];if(field){state[field]=b.dataset.value;store();render();win.querySelector(`[data-radio="${b.dataset.radio}"][data-value="${CSS.escape(b.dataset.value)}"]`)?.focus({preventScroll:true});}return;}
  if(b.dataset.action==='meters-mobile'){state.mobileMeters=!state.mobileMeters;render();win.querySelector('[data-action=meters-mobile]')?.focus({preventScroll:true});return;}
  if(b.dataset.action==='cuts-more'){state.cutLimit=(state.cutLimit||60)+60;render();}
 });
 // Click-to-place provides the same operation without dragging (phone / keyboard).
 root.addEventListener('click',e=>{if(!state.armedCut||e.target.closest('[data-cut],[data-slot-actions],select,.cut__think'))return;const target=e.target.closest('[data-edit]');if(!target||target.disabled)return;e.preventDefault();e.stopImmediatePropagation();const d=target.dataset;placeCut(state.armedCut,{role:d.edit,index:Number(d.index),group:d.group||'role'});},true);
 root.addEventListener('change',e=>{const id=e.target.id,value=e.target.value;if(id==='history-position'){scrubHistory(Number(value),true);return;}const map={'cut-provider':'cutProvider','cut-health':'cutHealth','op-role':'role','op-sort':'catalogSort','op-scope':'catalogMode','op-source':'benchSource','op-release':'benchRelease','op-evidence':'catalogEvidence'};if(map[id]){state[map[id]]=value;if(id==='op-scope')state.catalogProvider='all';if(id==='op-source')state.benchRelease=[...new Set(source.insights.benchmarks.records.filter(b=>b.source===value).map(b=>b.release))].sort().at(-1)||'';if(id.startsWith('op-')){state.page=0;state.analyze=null;}store();render();win.querySelector('#'+id)?.focus({preventScroll:true});}});
 root.addEventListener('input',e=>{if(e.target.id==='history-position')scrubHistory(Number(e.target.value));});
 // Selecting a CUT in Колекція: the row lights (LED + pressed strip), the inspector follows; focus stays where the
 // selection was made (the row, a plot point, an EDITION on the inspector).
 // A page turn selects the first CUT of the new page, so the list keeps one tabbable row and «Дані обраного CUT»
 // shows what is on screen; a pager key that just disabled hands its focus to the other one (QA2 B9).
 function turnCatalogPage(step,action){
  const rows=analyticalModels(),page=Math.max(0,Math.min(Math.ceil(rows.length/12)-1,state.page+step)),first=rows[page*12];
  state.page=page;if(first)state.analyze=first.provider+'/'+first.id;state.allEditions=false;render();
  const key=win.querySelector(`[data-action="${action}"]`);if(key&&!key.disabled)key.focus({preventScroll:true});else (win.querySelector(`[data-action="${action==='next-page'?'prev-page':'next-page'}"]:not(:disabled)`)||win.querySelector('.coll__row[aria-selected=true]'))?.focus({preventScroll:true});
 }
 function selectCatalogRow(route,keepFocus=false){
  state.analyze=route;state.allEditions=false;const rows=analyticalModels(),at=rows.findIndex(m=>m.provider+'/'+m.id===route);if(at>=0)state.page=Math.floor(at/12);render();
  if(!keepFocus)win.querySelector(`.coll__row[data-analyze="${CSS.escape(route)}"]`)?.focus({preventScroll:true});
 }
 function storeOperator(){try{localStorage.setItem('mana-operator',JSON.stringify({health:state.health,...(Number.isFinite(state.drawerHeight)?{drawerHeight:state.drawerHeight,drawerResized:true}:{}),...(Number.isFinite(state.editorHeight)?{editorHeight:state.editorHeight}:{})}));}catch{}}
 // The picker's target CUT carries .editing; a kept row loses it when the picker closes or moves on.
 // The picker's target CUT carries .is-selected (and its ⋯ key aria-expanded); a kept row loses them when the
 // picker closes or moves on. Decorations outside the region strings, re-applied after every patch.
 function markEditing(){
  for(const k of win.querySelectorAll('[data-lane-menu][aria-expanded=true]'))if(!(state.picker?.lane&&k.dataset.laneMenu===state.picker.role&&k.dataset.group===state.picker.group))k.setAttribute('aria-expanded','false');
  if(state.picker?.lane)for(const k of win.querySelectorAll(`[data-lane-menu="${CSS.escape(state.picker.role)}"][data-group="${state.picker.group}"]`))k.setAttribute('aria-expanded','true');
  const x=state.picker,next=x?[...win.querySelectorAll(`[data-edit="${CSS.escape(x.role)}"][data-index="${x.index}"][data-group="${x.group}"]`)].map(el=>el.closest('.cut')).filter(Boolean):[];
  for(const el of editingNodes)if(!next.includes(el)){el.classList.remove('is-selected');for(const k of el.querySelectorAll('.cut__more,button.cut__think'))k.setAttribute('aria-expanded','false');}
  for(const el of next){if(!el.classList.contains('is-selected'))el.classList.add('is-selected');for(const k of el.querySelectorAll('.cut__more,button.cut__think'))k.setAttribute('aria-expanded',String(!!x.actionsOnly&&k.matches(x.thinking?'.cut__think':'.cut__more')));}
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
    box('main',`<main class="workarea">`,state.view==='dashboard'?[historySurface()]:state.view==='profiles'?profileView():[operatorCatalog()])]),
   leaf('spacer','<div class="tray-spacer" aria-hidden="true"></div>'),
   cutsTray(),
   pickerMarkup(),
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
  const prefix=el.closest('[data-picker]')?'[data-picker] ':el.closest('.tray__form')?'.tray__form ':'';
  if(el.name)return prefix+'[name="'+CSS.escape(el.name)+'"]';
  const attr=['data-effort-role','data-edit','data-slot-actions','data-migrate','data-source','data-adopt','data-action','data-cut','data-pick','data-analyze','data-fav','data-op-switch','data-pool-open','data-pool-tab','data-mode-scope','data-agent-role','data-agent-copy','data-focus-role','data-theme-toggle','data-knob','data-fold-toggle','data-sync-vibe','data-view','data-model-detail','data-history-bin','data-provider-toggle','data-reset-agent','data-radio','data-edit-provider','data-confirm','data-lane-menu'].find(key=>el.hasAttribute(key)&&!(key==='data-action'&&!el.getAttribute(key)));
  return attr?prefix+'['+attr+'="'+CSS.escape(el.getAttribute(attr))+'"]'+['data-index','data-group','data-direction','data-screen-hue','data-value'].filter(key=>el.hasAttribute(key)).map(key=>'['+key+'="'+CSS.escape(el.getAttribute(key))+'"]').join(''):'';
 }
 // One entry point for every state change. Builds the region tree and lets the region engine replace only
 // what changed; then restores what a replaced region took with it (focus, selection, scroll, menu, modal).
 function render(){
  roleKeys.splice(0,roleKeys.length,...knownRoleKeys(p(),presetLike()?profiles.standard:null));if(!roleKeys.includes(state.role))state.role=roleKeys[0]||'';
  if(composing||drag?.active||drawerGesture||document.documentElement.dataset.displayTuning){pendingRender=true;scheduleBackgroundWork();return;}
  pendingRender=false;renderCache={diffs:new Map(),keys:new Map()};
  try{
  opReportCache=usageReports();if(win.dataset.opView!==state.view)win.dataset.opView=state.view;
  const title=source.demo?'Mana Tape · DEMO':'Mana Tape · OMP';if(document.title!==title)document.title=title;
  // The only geometry read before writing: a clean layout here costs nothing.
  surfaceWidth=win.clientWidth;
  const view=captureView(),wasModal=modalShown,layerScroll=win.querySelector('.tray__body--form')?.scrollTop||0;
  const oldForm=win.querySelector('.tray__form form'),formValues=oldForm?[...oldForm.elements].filter(el=>el.name).map(el=>({name:el.name,value:el.value,checked:el.checked})):[];
  const modalFocus=view.focused?.closest('.tray--form')?view.selector:'';
  ensureModePreview();rebuild();state.changes=diff(state.profile).length;
  const context=state.view+'|'+state.profile;
  const frame={profile:state.profile,view:state.view,draft:JSON.stringify(p()),projection:JSON.stringify([roleKeys.map(r=>chain(r)),workers().map(r=>chain(r,'vibe')),poolDraft]),dirty:!!state.changes,saving:state.saving,error:state.error,context};
  // Clip geometry is read only when this render can move CUTS (an edit or a new projection).
  const motion=ForgeTape.before(win,frame);
  // A form in the drawer: the page stays where it is (no scroll lock, no scrim); focus returns to its opener.
  if(state.modal&&!wasModal){
   const attribute=['data-model-detail','data-edit-provider','data-adopt','data-action'].find(a=>view.focused?.hasAttribute(a));
   modalReturnFocus=state.confirm?.focus||state.returnFocus||(view.focused?.closest('.dock__menu')?'.dock__menu summary':null)||(attribute?`[${attribute}="${CSS.escape(view.focused.getAttribute(attribute))}"]`:'[data-view][aria-current=page]');
  }
  modalShown=!!state.modal;
  // A new form (also one form replacing another) takes the focus at its own first control (QA2 B10).
  const formKey=state.modal?state.modal+'|'+(state.confirm?.action||'')+'|'+(state.editProvider||''):'',newForm=!!formKey&&formKey!==formShown;formShown=formKey;
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
  for(const child of win.children){const inert=!!state.modal&&!child.matches('.tray-port,.toast');if(child.inert!==inert)child.inert=inert;}
  // A closed drawer shows its lip only: nothing behind it takes the focus (or scrolls the port to reach it).
  const trayBody=win.querySelector('#tray-body'),closedTray=!drawerShown();if(trayBody&&trayBody.inert!==closedTray)trayBody.inert=closedTray;
  restoreScroll(view,out,motion.context===context);
  if(state.modal&&touched(out,'drawer')){
   const layer=win.querySelector('.tray--form'),scroller=layer?.querySelector('.tray__body'),form=layer?.querySelector('.tray__form form');
   if(layer){
    if(form!==oldForm){scroller.scrollTop=layerScroll;if(form&&form.getAttribute('id')===oldForm?.getAttribute('id'))for(const saved of formValues){const el=form.elements.namedItem(saved.name);if(el){el.value=saved.value;if(typeof saved.checked==='boolean')el.checked=saved.checked;}}}
    // The form's own body first: the lip × carries the same action as «Скасувати» (QA2 B11).
    const pick=selector=>selector?layer.querySelector('.tray__body')?.querySelector(selector)||layer.querySelector(selector):null;
    const target=newForm?pick(formSpecFocus()||'input,button'):modalFocus&&!view.focused?.isConnected?pick(modalFocus)||pick(formSpecFocus()||'input,button'):null;
    target?.focus({preventScroll:true});if(target&&view.selection&&typeof target.setSelectionRange==='function')target.setSelectionRange(...view.selection);
    fitForm(layer);
   }
  }
  if(state.picker&&(touched(out,'picker')))fitPicker();
  if(!state.modal)restoreFocus(view);
  ForgeTape.after(win,motion,frame);
  if(!state.modal&&view.focused?.matches('.menu--tools [data-action=move-node]')&&!view.focused.isConnected)focusPickerMove(state.picker?.focusDirection||1);
  // Focus returns to the form's opener; when the action removed it (an adopted file, a deleted provider), to the
  // control that owns the surface: the provider selector in Колекція, the reel ⋯ on Монтаж.
  if(!state.modal&&wasModal)[modalReturnFocus,state.view==='models'?'#catalog-provider':'.dock__menu summary','[data-view][aria-current=page]'].filter(Boolean).map(selector=>[...win.querySelectorAll(selector)].find(el=>el.getClientRects().length&&!el.disabled)).find(Boolean)?.focus({preventScroll:true});
  storeDrafts(dirty);
  renderedAt=Date.now();
  }finally{renderCache=null;}
 }
 const touched=(out,key)=>out.all||[...out.replaced].some(k=>k===key||k.startsWith(key+'/'));
 // What a replaced region takes with it: read before the patch (one layout at most), restored after it.
 function captureView(){
  const focused=document.activeElement,selector=win.contains(focused)?focusSelector(focused):'';
  const scrollers=['#picker-results','.tray__source .tray__grid,.tray__body>.tray__grid','.tray__editor .tray__grid'].map(selector=>{const el=win.querySelector(selector);return el?{selector,el,left:el.scrollLeft,top:el.scrollTop,key:el.dataset.filterKey}:null;}).filter(Boolean);
  // Long lanes scroll on their own; a rebuilt lane keeps its horizontal position within the same profile.
  // Only grooves that were actually scrolled are read: a layout read inside a lane that content-visibility skips
  // would force that lane's layout (≈100 forced layouts per render at owner scale).
  for(const el of scrolledGrooves)if(!el.isConnected)scrolledGrooves.delete(el);
  const grooves=[...scrolledGrooves].filter(el=>el.scrollLeft).map(el=>({el,lane:el.parentElement.dataset.role+'|'+el.parentElement.dataset.laneGroup,left:el.scrollLeft}));
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
  markEditing();if(state.view==='dashboard')markHistoryBin();
  const fresh=out.all?[win]:out.inserted;
  markMatches(fresh);
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
   const pools=poolsDirty()?JSON.stringify({original:poolOriginal,value:poolDraft,revision:poolRevision}):'',drafts=JSON.stringify(Object.fromEntries(dirty.map(k=>[k,{original:original[k],value:profiles[k],revision:baseRevision(k)}])));
   if(pools!==storedDrafts.pools){if(pools)sessionStorage.setItem(poolDraftKey(),pools);else sessionStorage.removeItem(poolDraftKey());storedDrafts.pools=pools;}
   if(drafts!==storedDrafts.drafts){sessionStorage.setItem(storageKey('forge-drafts'),drafts);storedDrafts.drafts=drafts;}
  }catch{}
 }
 // Opening a form in the drawer: a fresh form with no errors left from the previous one.
 function openForm(kind,extra={}){Object.assign(state,{modal:kind,modalError:'',modalCode:'',modalDiffs:null,modalScope:'',formErrors:{},returnFocus:''},extra);modalFit='';render();}
 function closeForm(){state.modal=null;state.modalError='';state.modalCode='';state.modalDiffs=null;state.modalScope='';state.formErrors={};state.confirm=null;state.migrate=null;render();}
 root.addEventListener('click',async e=>{
  const b=e.target.closest('button,a.brand');if(!b)return;
  if(b.matches('a.brand')){e.preventDefault();state.view='profiles';render();store();ForgeTape.logo(win.querySelector('.brand'),true);return;}
  if(b.dataset.modelDetail){openForm('details',{detail:b.dataset.modelDetail});return;}
  if(b.dataset.editProvider){openForm('provider',{editProvider:b.dataset.editProvider});return;}
  const action=b.dataset.action;
  try{
   if(action==='refresh'){await api('/api/refresh',{});await reload();notify('Оновлюю каталог і показники…');}
   if(action==='scope-global'){const rows=source.projects||[];if(source.scope?.kind==='global'){let back='';try{back=sessionStorage.getItem('mana:last-scope')||'';}catch{}const row=rows.find(x=>x.id===back&&x.kind!=='global')||rows.find(x=>x.kind==='project');if(row)goScope(row.id);else notify('Проєктів ще немає: OMP додасть їх сюди, щойно попрацює в каталозі.');}else{const g=globalScopeRow();if(g)goScope(g.id);}return;}
   if(action==='preset-edit-global'){const g=globalScopeRow();if(g)goScope(g.id,'preset:'+presetName(state.profile));return;}
   if(action==='apply-preset'){const name=state.profile;if(!presetLike(name)||diff(name).length)return;const spec={action:'apply-preset',name,pending:true,focus:'#profile-choice',title:'Застосувати котушку',sub:prettyProfile(name),label:'Застосувати',text:applyText(name)};askConfirm(spec);previewAction(spec,'/api/profile-action',{action:'apply-preset',preset:presetName(name),revision:source.revisions.standard},r=>(r.fromGlobal?.length?'<p class="print">Ролі, яких котушка не називає, OMP і далі братиме з глобального: '+esc(r.fromGlobal.join(', '))+'.</p>':'')+(r.shadowed?.length?'<p class="print">Проєкт і далі задає сам: '+esc(r.shadowed.join(', '))+'.</p>':''));return;}
   if(action==='migrate-open'){const name=b.dataset.migrate;if(!name)return;openForm('migrate',{migrate:{profile:name},returnFocus:'[data-migrate="'+CSS.escape(name)+'"]'});migratePlan(name);return;}
   if(action==='migrate-accept'){if(state.migrate){state.migrate.accept=!state.migrate.accept;regions.invalidate('drawer/form');render();win.querySelector('[data-action=migrate-accept]')?.focus({preventScroll:true});}return;}
   if(action==='migrate-run'){
    const m=state.migrate;if(!m?.plan||state.profileBusy)return;const mode=m.mode||(m.plan.sameAsStandard?'archive':'roles');
    state.profileBusy=true;regions.invalidate('drawer/form');render();
    try{const r=await api('/api/profile-action',{action:'migrate',profile:m.profile,mode,token:m.plan.token,acceptLoss:!!m.accept,name:m.plan.preset,...(m.plan.derivedToken?{confirm:m.plan.derivedToken}:{})});state.modal=null;state.migrate=null;state.returnFocus='';await reload();if(profiles[r.name])state.profile=r.name;state.opFeedback=mode==='archive'?'Стару котушку '+m.profile+' архівовано · файл у резервних копіях':'Котушку '+m.profile+' перенесено → '+prettyProfile(r.name)+' (котушка OMP) · старий файл у резервних копіях';render();store();win.querySelector('#profile-choice')?.focus({preventScroll:true});}
    finally{state.profileBusy=false;if(state.modal)render();}
    return;
   }
   if(action==='configure-project'){
    const c=state.candidate;if(!c||state.profileBusy)return;state.profileBusy=true;regions.invalidate('drawer/form');render();
    try{const r=await api('/api/scope-action',{action:'configure',candidate:c.id});state.modal=null;goScope(r.id);}
    catch(e){
     // The list moved on (another window configured it, or the directory went): read it again now.
     if(e.status!==404)throw e;
     try{await api('/api/scope-action',{action:'rescan'});await reload();}catch{}
     const again=(source.candidates||[]).find(x=>x.path===c.path);
     if(again){state.candidate=again;throw Object.assign(Error('Список знайдених каталогів оновлено: натисни «Налаштувати проєкт» ще раз.'),{status:404,code:'rescan'});}
     closeForm();notify(source.projects?.some(x=>x.path===c.path)?'Проєкт уже налаштований · обери його в барабані «Проєкт»':'Каталогу вже немає серед знайдених');
    }finally{state.profileBusy=false;if(state.modal)render();}
    return;
   }
   if(action==='modal-close'){const back=state.modal==='confirm'&&state.confirm?.back;if(back){openForm(back);return;}closeForm();return;}
   if(action==='confirm-cancel'){const back=state.confirm?.back;if(back)openForm(back);else closeForm();return;}
   if(action==='confirm-run'){const c=state.confirm;if(!c||state.profileBusy)return;state.profileBusy=true;render();try{await CONFIRM_ACTIONS[c.action]?.(c);}finally{state.profileBusy=false;if(state.modal==='confirm')render();}return;}
   if(action==='conflict-open')openForm('conflict',{error:''});
   if(action==='conflict-mine'||action==='conflict-theirs'){const name=state.profile;if(!staleDrafts.has(name))return closeForm();rebaseDraft(name,freshProfile(name),action==='conflict-mine'?'mine':'theirs');closeForm();state.opFeedback=(action==='conflict-mine'?'Твої значення лишились':'Взято значення з файлу')+' · чернетку перенесено на актуальний файл '+prettyProfile(name)+'. Перевір і збережи.';render();return;}
   if(action==='conflict-discard'){askConfirm({action:'conflict-discard',back:'conflict',danger:true,title:'Скинути чернетку',sub:prettyProfile(state.profile),label:'Скинути чернетку',text:`Незбережені зміни профілю <b>${esc(prettyProfile(state.profile))}</b> буде скинуто, панель покаже поточний файл. Інші профілі й пули не зміняться.`});return;}
   if(action==='clone-profile')openForm('clone',{cloneName:''});
   if(action==='clone-create'){const f=win.querySelector('#clone-form');if(state.profileBusy||!f)return;const q=checkProfileName(f,true);if(q.error){f.elements.name.focus();return;}let name=q.name;state.cloneName=f.elements.name.value;state.profileBusy=true;regions.invalidate('drawer/form');render();try{const result=await api('/api/profile-action',{action:'clone',profile:state.profile,name});name=result.name||name;state.modal=null;state.modalError='';state.opFeedback='';await reload();state.profile=name;editHistory.profiles.delete(name);render();store();notify('Копію створено · '+prettyProfile(name));}finally{state.profileBusy=false;if(state.modal)render();}}
   if(action==='history')openForm('history');
   if(action==='rename-profile'&&state.profile!=='standard'){openForm('rename',{renameName:state.profile});win.querySelector('#rename-form input')?.select();}
   if(action==='delete-profile'&&state.profile!=='standard')openForm('delete-profile');
   if(action==='rename-confirm'||action==='delete-confirm'){
    if(state.profileBusy)return;
    const old=state.profile,f=win.querySelector('#rename-form');
    const q=f?checkProfileName(f,true):null;if(q?.error){f.elements.name.focus();return;}
    let name=q?.name||null;
    state.renameName=f?.elements.name.value;state.profileBusy=true;render();
    try{
     const result=await api('/api/profile-action',{action:f?'rename':'delete',profile:old,name,revision:source.revisions[old]});name=result.name||name;
     if(name&&name!==old){profiles[name]=profiles[old];original[name]=original[old];source.revisions[name]=source.revisions[old];if(staleDrafts.has(old))staleDrafts.set(name,staleDrafts.get(old));}
     editHistory.rename(old,name);
     if(name!==old){delete profiles[old];delete original[old];delete source.revisions[old];staleDrafts.delete(old);profileKeys.splice(0,profileKeys.length,...Object.keys(profiles));}
     state.profile=name||'standard';state.modal=null;state.modalError='';state.profileBusy=false;state.opFeedback='';store();render();await reload();notify(name?'Профіль перейменовано':'Профіль видалено');
    }finally{state.profileBusy=false;}
   }
   // The history drawer is the confirmation itself: its key restores at once.
   // The restored file replaces the draft, but the draft is one Undo step away (F4): Undo shows it again over the
   // restored version, and saving it brings it back.
   if(action==='restore-profile'){if(state.profileBusy)return;state.profileBusy=true;render();try{const name=state.profile,draft=diff(name).length?copy(profiles[name]):null;await api('/api/profile-action',{action:'restore',profile:name,revision:source.revisions[name]});profiles[name]=copy(original[name]);state.poolPanel=false;state.modal=null;state.opFeedback='';await reload();if(profiles[name])editHistory.reset(name,profiles[name],false,draft?[draft]:[]);if(draft)state.opFeedback='Попередню версію відновлено · незбережену чернетку повертає ↶';render();notify('Попередню версію відновлено');}finally{state.profileBusy=false;if(state.modal)render();}}
   if(action==='delete-provider'){const v=source.providers.find(x=>x.id===state.editProvider);askConfirm({action:'delete-provider',back:'provider',danger:true,title:'Видалити підключення',sub:providerName(state.editProvider),label:'Видалити підключення',text:`Підключення <b>${esc(v?.name||state.editProvider)}</b> зникне з каталогу. Якщо його моделі є в профілях, видалення буде заблоковано, а профілі не зміняться.`});}

   if(action==='clear-error'){state.error='';render();}
   // «Прийняти файл»: accept a profile file as it is now after an outside edit (or forget a removed one). The file
   // is never rewritten; its former version stays restorable.
   // The confirmation names every FREE pool block the file no longer repeats exactly: it becomes the file's own
   // CUTS (F5). The key waits for that answer; a failed check says so and still lets the owner accept.
   if(action==='adopt-profile'){const name=b.dataset.adopt,orphan=source.modeOrphans?.includes(name),spec={action:'adopt-profile',profile:name,title:orphan?'Прийняти видалення':'Прийняти файл',sub:prettyProfile(name),label:orphan?'Забути запис режиму':'Прийняти файл як є',pending:!orphan,pendingText:'Перевіряю блоки FREE-пулів…',text:orphan?`Файл профілю <b>${esc(prettyProfile(name))}</b> уже видалено поза Mana Tape. Mana Tape забуде запис його режиму; копія запису лишиться в резервних.`:`Файл профілю <b>${esc(prettyProfile(name))}</b> змінено поза Mana Tape. Прийняти його як є: режим DeepSeek стане ON, збережені заміни лишаться для наступного OFF. Попередня версія доступна через «Попереднє збереження».`};askConfirm(spec);
    if(!orphan){let plan=null,error='';try{plan=await api('/api/profile-action',{action:'adopt-plan',profile:name});}catch(err){error=err.message;}if(state.confirm!==spec)return;spec.pending=false;spec.note=adoptPoolNote(plan,error);modalFit='';regions.invalidate('drawer/form');render();}return;}
   if(action==='discard-reload')askConfirm({action:'discard-reload',back:'conflict',danger:true,title:'Скинути чернетки',label:'Скинути й оновити',text:'Усі незбережені чернетки профілів і пулів у цьому вікні буде скинуто, а поточні файли — завантажено заново. Експорт чернеток доступний до цього кроку.'});
   if(action==='export-draft'){const drafts=Object.fromEntries(profileKeys.filter(k=>diff(k).length).map(k=>[k,{revision:baseRevision(k),changes:diff(k)}]));if(poolsDirty())drafts['@free-pools']={revision:poolRevision,pools:poolDraft};const blob=new Blob([JSON.stringify(drafts,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='forge-drafts.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  }catch(err){
   if(state.modal){
    // A drawer never dead-ends on stale data: the state is read again (polling waits while a drawer is open), a
    // migration plan is made again, and the next press uses the fresh revision or token.
    if(err.code==='revision'){try{await reload();}catch{}if(state.modal==='migrate'&&state.migrate?.profile)await migratePlan(state.migrate.profile,state.migrate.plan?.preset||'');}
    if(state.modal){modalProblem(err);if(err.code==='revision')state.modalError='Дані змінились, панель уже перечитала їх: перевір і натисни ще раз.';regions.invalidate('drawer/form');}
   }else state.error=err.message;render();}
 });
 // What a confirmation drawer runs; each closes the drawer when it is done (errors stay on the drawer's line).
 const CONFIRM_ACTIONS={
  // Promote: the project's saved values move into the Global config, one journal for both files.
  'promote':async c=>{await api('/api/scope-action',{action:'promote',revision:source.revisions.standard,paths:c.paths,...(c.token?{confirm:c.token}:{})});state.modal=null;state.confirm=null;await reload();state.opFeedback=(c.group==='vibe'?'Агент ':'')+c.role+' піднято в глобальне · записано обидва файли (з резервними копіями)';render();},
  // Apply: OMP /modelpreset switch; the server names the file it wrote and the roles a higher layer still sets.
  'apply-preset':async c=>{const r=await api('/api/profile-action',{action:'apply-preset',preset:presetName(c.name),revision:source.revisions.standard,...(c.token?{confirm:c.token}:{})});state.modal=null;state.confirm=null;await reload();const target=(source.projects||[]).find(x=>x.id===r.target),files=scopeFiles();state.opFeedback=(r.unchanged?'Котушка '+prettyProfile(c.name)+' уже діє · нічого не записано':'Котушку '+prettyProfile(c.name)+' застосовано · ролі записано в '+(target?.kind==='global'?files.globalShort||'глобальний файл':files.projectShort||'файл проєкту'))+(r.shadowed?.length?' · далі задає вищий рівень: '+r.shadowed.join(', '):'')+(r.fromGlobal?.length?' · з глобального: '+r.fromGlobal.join(', '):'');render();win.querySelector('#profile-choice')?.focus({preventScroll:true});},
  // A save that also writes what the owner did not ask for: the same save again, with the token of what was shown.
  'save-derived':async()=>{state.modal=null;state.confirm=null;render();await save();},
  'delete-provider':async()=>{await api('/api/provider',{id:state.editProvider,action:'delete',revision:source.providerRevision});state.modal=null;state.confirm=null;await reload();notify('Підключення видалено');},
  'adopt-profile':async c=>{await api('/api/profile-action',{action:'adopt',profile:c.profile,revision:source.revisions?.[c.profile]});state.modal=null;state.confirm=null;await reload();state.opFeedback=c.title==='Прийняти видалення'?'Запис режиму '+prettyProfile(c.profile)+' забуто · копія лишилась у резервних.':'Файл профілю '+prettyProfile(c.profile)+' прийнято.';render();},
  'conflict-discard':async()=>{const name=state.profile,fresh=freshProfile(name);original[name]=fresh;profiles[name]=copy(fresh);staleDrafts.delete(name);editHistory.reset(name,fresh);state.modal=null;state.confirm=null;state.opFeedback='Чернетку '+prettyProfile(name)+' скинуто · показано поточний файл.';render();},
  'discard-reload':async()=>{state.modal=null;state.confirm=null;state.error='';editHistory.profiles.clear();staleDrafts.clear();await reload(true);}
 };
 // The migration name field: a pause in typing asks the server for the plan of that name (collision, token).
 let migrateNameTimer=0;
 root.addEventListener('input',e=>{
  if(state.modal==='migrate'&&e.target.name==='name'&&e.target.closest('.tray__form')&&state.migrate){
   state.migrate.name=e.target.value;state.migrate.pending=true;clearTimeout(migrateNameTimer);
   const profile=state.migrate.profile,value=e.target.value.trim();
   migrateNameTimer=setTimeout(()=>{if(state.modal==='migrate'&&state.migrate?.profile===profile)migratePlan(profile,value);},350);
   return;
  }
  // A field that is corrected loses its error at once; the form is not rebuilt under the typing hand.
  if(e.target.form?.getAttribute('id')==='new-provider')clearFixedFields(e.target.form,e.target.name);
  if(!e.target.matches('#clone-form input,#rename-form input'))return;if(e.target.form.id==='clone-form')state.cloneName=e.target.value;else state.renameName=e.target.value;checkProfileName(e.target.form);state.modalError='';win.querySelector('.tray__form > .msg[data-s=bad]')?.remove();regions.invalidate('drawer/form');
 });
 // An error on the provider form disappears as soon as its field (or the field it depends on) is edited and passes
 // the client check; an untouched field keeps the server's word.
 const FIELD_DEPENDS={auth:['key'],url:['key'],discovery:['models'],models:['models']};
 function clearFixedFields(form,name){
  const problems=providerProblems(form);let changed=false;
  for(const n of new Set([name,...(FIELD_DEPENDS[name]||[])])){const field=form.querySelector(`.field.is-bad[data-field="${n}"]`);if(!field||problems[n])continue;field.classList.remove('is-bad');field.querySelector('[aria-invalid]')?.removeAttribute('aria-invalid');if(state.formErrors)delete state.formErrors[n];const note=field.querySelector('.field__note');if(note)note.textContent='';changed=true;}
  if(changed)regions.invalidate('drawer/form');
 }
 root.addEventListener('change',e=>{if(e.target.form?.getAttribute('id')==='new-provider')clearFixedFields(e.target.form,e.target.name);});
 root.addEventListener('submit',e=>{if(e.target.id==='clone-form'){e.preventDefault();win.querySelector('[data-action=clone-create]')?.click();}if(e.target.id==='rename-form'){e.preventDefault();win.querySelector('[data-action=rename-confirm]')?.click();}if(e.target.id==='new-provider'){e.preventDefault();saveProvider();}});
 root.addEventListener('keydown',e=>{if(e.key==='Tab'&&(state.modal||state.picker)){const layer=win.querySelector(state.modal?'.tray--form':'[data-picker]');if(!layer)return;const nodes=[...layer.querySelectorAll('button:not(:disabled),input,select,textarea,a[href],summary')].filter(x=>!x.closest('[inert]')).filter(x=>x.getClientRects().length),first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
 window.addEventListener('resize',()=>{finishDrawerResize(true);fitPicker();resizeDrawer(preferredHeight());});
 window.addEventListener('beforeunload',e=>{if(!state.switchingProject&&(poolsDirty()||profileKeys.some(k=>diff(k).length))){e.preventDefault();e.returnValue='';}});
 root.addEventListener('change',e=>{if(e.target.id==='project-choice'&&!state.saving){const v=e.target.value;if(v.startsWith('candidate:')){e.target.value=source.projectId;const c=(source.candidates||[]).find(x=>'candidate:'+x.id===v);if(c)openForm('candidate',{candidate:c,returnFocus:'#project-choice'});return;}goScope(v);}if(e.target.id==='preset-thinking'){if(!isNative(state.profile)||state.saving)return;const v=e.target.value;if(v)p().defaultThinkingLevel=v;else delete p().defaultThinkingLevel;state.opFeedback='';render();win.querySelector('#preset-thinking')?.focus({preventScroll:true});}});
 // Moving between scopes is a page change (?project=); the drafts of the scope left behind stay in this tab. The
 // «Глобально» key remembers the project it left, so a second press returns there.
 function goScope(id,profile=''){
  if(!id||state.saving)return;
  try{if(source.scope?.kind!=='global')sessionStorage.setItem('mana:last-scope',source.projectId);}catch{}
  store();state.switchingProject=true;const url=new URL(location.href);url.searchParams.set('project',id);if(profile)url.searchParams.set('profile',profile);else url.searchParams.delete('profile');location.assign(url);
 }
 window.addEventListener('offline',()=>{state.offline=true;state.error='Немає мережі. Чернетки залишаються у цьому вікні; збереження потребує сервера.';render();});
 window.addEventListener('online',()=>{state.error='';pollState();});
 Object.assign(state,{health:true,cuts:false,freeCuts:false,cutProvider:'all',cutHealth:'all',cutQuery:'',catalogSort:'score',benchSource:'Artificial Analysis',benchRelease:[...new Set((source.insights?.benchmarks?.records||[]).filter(b=>b.source==='Artificial Analysis').map(b=>b.release))].sort().at(-1)||'',historyMetric:'requests',historySort:'totalRequests'});try{const saved=JSON.parse(localStorage.getItem('mana-operator')||'{}');if(typeof saved?.health==='boolean')state.health=saved.health;if(saved?.drawerResized===true&&Number.isFinite(saved.drawerHeight))state.drawerHeight=saved.drawerHeight;if(Number.isFinite(saved?.editorHeight))state.editorHeight=saved.editorHeight;}catch{}
 state.syncVibe=true;state.favs=source.favs||[];favSaved=state.favs;state.error='';state.modalError='';
 try{const v=JSON.parse(localStorage.getItem(storageKey('forge-view')));if(v){if(['dashboard','profiles','models','providers'].includes(v.view))state.view=v.view==='providers'?'models':v.view;if(typeof v.profile==='string'&&Object.hasOwn(profiles,v.profile))state.profile=v.profile;if(roleKeys.includes(v.role))state.role=v.role;if(typeof v.syncVibe==='boolean')state.syncVibe=v.syncVibe;}const drafts=JSON.parse(sessionStorage.getItem(storageKey('forge-drafts'))||'{}');for(const [k,v]of Object.entries(drafts)){if(profiles[k]&&v.original&&v.value&&v.revision){original[k]=v.original;profiles[k]=v.value;if(v.revision!==source.revisions[k])staleDrafts.set(k,{revision:v.revision,conflicts:[]});}}}catch{}
 // An older tab kept the pools draft per project; it moves once to the machine-wide key and the old key goes, so a
 // stale draft cannot come back on every load (and loop on a 409 revision).
 try{const legacy=storageKey('forge-pool-draft');if(legacy!==poolDraftKey()){const old=sessionStorage.getItem(legacy);if(old&&!sessionStorage.getItem(poolDraftKey()))sessionStorage.setItem(poolDraftKey(),old);sessionStorage.removeItem(legacy);}}catch{}
 try{const draft=JSON.parse(sessionStorage.getItem(poolDraftKey())||'null');if(draft?.original&&draft.value&&draft.revision){poolOriginal=draft.original;poolDraft=draft.value;poolRevision=draft.revision;}}catch{}
 for(const [k,v] of Object.entries(profiles)){v.forgeMode??=copy(source.profileModes?.[k]?.settings||{mode:'deepseek',alternatives:[],overrides:{}});original[k].forgeMode??=copy(v.forgeMode);}
 // A restored draft made on an older file moves onto the current one now, or waits for its «Конфлікт…» choice.
 for(const [k,row] of staleDrafts){if(!diff(k).length){original[k]=freshProfile(k);profiles[k]=copy(original[k]);staleDrafts.delete(k);continue;}row.conflicts=rebaseDraft(k,freshProfile(k),'auto');}
 {const url=new URL(location.href),wanted=url.searchParams.get('profile');if(wanted&&Object.hasOwn(profiles,wanted))state.profile=wanted;if(url.searchParams.has('profile')){url.searchParams.delete('profile');try{history.replaceState(history.state,'',url);}catch{}}}
 if(!profiles[state.profile])state.profile='standard';
 rebuild();render();ManaScreen.boot(win);
 // A new service worker takes over at once (skipWaiting + clients.claim); the page itself moves to the new shell
 // only when nothing can be lost or moved under the hand: no draft in any profile or the pools, no open form,
 // save or write in flight, and only while the tab is hidden. Otherwise the next ordinary reload picks it up.
 if('serviceWorker' in navigator){
  const hadWorker=!!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('/sw.js').catch(()=>{});
  const reloadForUpdate=()=>{if(!state.updateReady||!document.hidden||state.modal||state.saving||activeWrites||drag||poolsDirty()||profileKeys.some(k=>diff(k).length))return;state.switchingProject=true;location.reload();};
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(hadWorker){state.updateReady=true;reloadForUpdate();}});
  document.addEventListener('visibilitychange',reloadForUpdate);
 }
 // Countdowns tick in place; a text is written only when it actually changed (an idle tab does no DOM work).
 setInterval(()=>{
  if(document.hidden)return;let passed=false;
  for(const el of win.querySelectorAll('[data-reset]')){const at=Number(el.dataset.reset);if(at>0&&at<=Date.now()&&!resetsSeen.has(at)){resetsSeen.add(at);passed=true;}}
  paintTimes(win);if(passed){pendingRender=true;scheduleBackgroundWork();}
  const tariff=win.querySelector('.tariff');if(tariff&&!tariff.contains(document.activeElement))paintRegions([leaf('p/tariff',tariffMarkup())]);
 },30000);
 setInterval(pollState,15000);
})();

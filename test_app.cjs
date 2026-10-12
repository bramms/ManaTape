const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {runInNewContext}=require('node:vm');
const source=readFileSync(require.resolve('./static/app.js'),'utf8');
// Exercise the actual event/data functions with controlled network timing, without a DOM framework.
function appFunction(name){
 const start=source.search(new RegExp('\\n (?:async )?function '+name+'\\('));
 assert.ok(start>=0,name+' exists');
 const lineEnd=source.indexOf('\n',start+1),line=source.slice(start,lineEnd);
 if(line.endsWith('}'))return line;
 const end=source.indexOf('\n }',start)+3;
 return source.slice(start,end);
}

function roleContext(context){
 Object.assign(context,{builtinRoles:context.builtinRoles||[],source:context.source||{agents:[]},catalogMap:context.catalogMap||new Map(),poolName:context.poolName||(()=>undefined),split:context.split||(raw=>({raw}))});
 runInNewContext(['roleInfo','roleFallbacks','knownAgents','agentInfo','agentSource','shortText','isCustomAgent','agentModelText','agentModelAlias'].map(appFunction).join('\n'),context);
 return context;
}
// The real lane-edit path: setChain with OFF routing, agent aliases, default inheritance and agent sync.
const CHAIN=['workers','agentValues','agentLink','vibeAlias','aliasRole','resolveAlias','baseChain','inheritsDefault','oldSetChain','agentFromResolved','writeAgent','thinkingOff','withNotes','setChain','syncAgentTails','applyModeEdit','modeList','modeScope'];
function chainContext(context,extra=[]){
 const notices=context.notices||[];
 Object.assign(context,{notices,chainNotes:[],notify:context.notify||(s=>notices.push(s)),projectionPending:context.projectionPending||(()=>false),modeView:context.modeView||(()=>null),
  deepseek:context.deepseek||(r=>/deepseek/.test(r)&&!/free/.test(r)),state:{syncVibe:true,...context.state}});
 roleContext(context);
 runInNewContext([...CHAIN,...extra].filter(name=>!Object.hasOwn(context,name)).map(appFunction).join('\n'),context);
 return context;
}

test('all search fields propagate clearing and defer result updates during composition',()=>{
 const calls=[],state={picker:{query:'old',limit:80},analyze:'old',page:3};
 const context={state,composing:false,refreshSearch:id=>calls.push(id)};
 runInNewContext(appFunction('searchInput'),context);
 for(const [id,key] of [['role-query','query'],['catalog-query','catalogQuery'],['cut-query','cutQuery'],['picker-search','query']]){
  context.searchInput({id,value:'aurora'});context.searchInput({id,value:''});
  assert.equal((id==='picker-search'?state.picker:state)[key],'');
 }
 assert.equal(calls.length,8);assert.equal(state.page,0);assert.equal(state.analyze,null);
 context.composing=true;context.searchInput({id:'picker-search',value:'編'});
 assert.equal(state.picker.query,'編');assert.equal(calls.length,8,'composition must keep the live input untouched');
 context.composing=false;context.searchInput({id:'picker-search',value:'編集'});
 assert.equal(calls.length,9);assert.equal(state.picker.query,'編集');
});

test('a background response cannot replace a draft after focus or a write changes during fetch',async()=>{
 for(const reason of ['interaction','write']){
  let resolve,scheduled=0;
  const snapshot={base:{remote:true}},draft={local:true},context={
   backgroundReloading:false,backgroundRefreshPending:false,writeEpoch:0,stateTag:'',
   source:snapshot,profiles:{standard:draft},endpoint:x=>x,
   busy:false,interactionBusy:()=>context.busy,scheduleBackgroundWork:()=>scheduled++,
   fetch:()=>new Promise(done=>{resolve=done;})
  };
  runInNewContext(appFunction('reload'),context);
  const pending=context.reload(false,false,true);
  if(reason==='interaction')context.busy=true;else context.writeEpoch++;
  resolve({ok:true,json:async()=>({base:{remote:'new'}})});await pending;
  assert.equal(context.source,snapshot);assert.equal(context.profiles.standard,draft);
  assert.equal(context.backgroundRefreshPending,true);assert.equal(context.backgroundReloading,false);assert.equal(scheduled,1);
 }
});

test('pending writes block polling until every request settles, including a failed write',async()=>{
 const responses=[];let scheduled=0;
 const context={activeWrites:0,writeEpoch:0,source:{csrf:'test'},state:{},endpoint:x=>x,
  document:{hidden:false,documentElement:{dataset:{}},activeElement:null},win:{querySelector:()=>null},
  composing:false,pointerHeld:false,nativeSelectBusy:false,drag:null,cutGesture:null,drawerGesture:null,
  fetch:()=>new Promise(resolve=>responses.push(resolve)),scheduleBackgroundWork:()=>scheduled++};
 runInNewContext(appFunction('api')+'\n'+appFunction('problemText')+'\n'+appFunction('interactionBusy'),context);
 const first=context.api('/api/favs',{}),second=context.api('/api/favs',{});
 assert.ok(context.interactionBusy());assert.equal(context.activeWrites,2);
 responses[0]({ok:true,json:async()=>({})});await first;
 assert.ok(context.interactionBusy(),'the other request is still pending');
 responses[1]({ok:false,status:409,json:async()=>({error:'conflict'})});
 await assert.rejects(second,{message:'conflict'});
 assert.equal(context.activeWrites,0);assert.equal(context.writeEpoch,4);assert.equal(scheduled,2);
 assert.ok(!context.interactionBusy());
});

test('an unchanged background snapshot only advances the tariff clock, without repainting',async()=>{
 const snapshot={base:{},tariff:{at:1,next:100,peak:false},insights:{usage:{reports:[]}}};
 const fresh=structuredClone(snapshot);fresh.tariff.at=2;
 const context={backgroundReloading:false,writeEpoch:0,stateTag:'',source:snapshot,state:{offline:false},renderedAt:Date.now(),
  endpoint:x=>x,interactionBusy:()=>false,normalizeProfile:x=>x,fetch:async()=>({ok:true,json:async()=>fresh}),
  render:()=>assert.fail('unchanged polling must not render')};
 runInNewContext(appFunction('snapshotFingerprint').trim()+'\n'+appFunction('reload'),context);
 await context.reload(false,false,true);
 assert.equal(context.source,snapshot);assert.equal(snapshot.tariff.at,2);assert.equal(context.backgroundReloading,false);
});

test('deferred preview applies only its current key and repaints once after interaction',()=>{
 let paints=0;
 const current={key:'current',data:{routes:['new']}},pendingModeResults=new Map([['standard',current],['other',{key:'stale'}]]);
 const state={profile:'standard',modePlans:{standard:{key:'current'},other:{key:'newer'}}};
 const context={state,pendingModeResults,pendingRender:false,backgroundRefreshPending:false,interactionBusy:()=>false,render:()=>paints++};
 runInNewContext(appFunction('flushBackgroundWork'),context);context.flushBackgroundWork();
 assert.equal(state.modePlans.standard,current);assert.equal(state.modePlans.other.key,'newer');
 assert.equal(pendingModeResults.size,0);assert.equal(paints,1);assert.equal(context.pendingRender,false);
});

test('a committed select or idle CUT toolbar receives preview without allowing background polling',()=>{
 for(const surface of ['select','toolbar']){
  let paints=0,open=surface==='select';
  const result={key:'current',data:{routes:['new']}},pendingModeResults=new Map([['standard',result]]);
  const state={profile:'standard',modePlans:{standard:{key:'current',pending:true}},picker:surface==='toolbar'?{actionsOnly:true}:null};
  const context={state,pendingModeResults,pendingRender:false,backgroundRefreshPending:true,backgroundReloading:false,backgroundTimer:null,
   composing:false,pointerHeld:surface==='toolbar',nativeSelectBusy:false,activeWrites:0,drag:null,cutGesture:null,drawerGesture:null,
   document:{hidden:false,documentElement:{dataset:{}},activeElement:{matches:selector=>surface==='select'&&(selector==='select'||selector===':open'&&open)}},
   CSS:{supports:()=>true},win:{querySelector:()=>null},setTimeout:()=>0,clearTimeout:()=>{},
   render:()=>paints++,pollState:()=>assert.fail('background polling must remain deferred')};
  runInNewContext(appFunction('interactionBusy')+'\n'+appFunction('flushBackgroundWork'),context);
  context.flushBackgroundWork();assert.equal(paints,0,'open select / held pointer must keep its DOM');
  open=false;context.pointerHeld=false;context.flushBackgroundWork();
  assert.equal(state.modePlans.standard,result);assert.equal(paints,1);assert.equal(context.backgroundRefreshPending,true);
  if(surface==='select'){
   context.CSS.supports=()=>false;context.nativeSelectBusy=true;assert.ok(context.interactionBusy(true));
   context.nativeSelectBusy=false;assert.ok(!context.interactionBusy(true),'change releases the fallback select interaction');
  }else{state.picker.actionsOnly=false;assert.ok(context.interactionBusy(true),'search chooser must remain untouched');}
 }
});

test('two CUT moves wait for the new projection and move the same CUT in DeepSeek OFF',()=>{
 const profile={modelRoles:{writer:'p/deepseek'},retry:{fallbackChains:{}},task:{agentModelOverrides:{}}},settings={alternatives:['p/A','p/B','p/C'],overrides:{}};
 const view=routes=>({views:{role:{writer:{routes,substituted:true,paused:[{index:0}],refs:routes.map(route=>({kind:'replacement',route,key:'role:writer'}))}}}});
 let plan={data:view(['p/A','p/B','p/C'])};
 const context={p:()=>profile,state:{profile:'standard',picker:{role:'writer',group:'role',index:0}},
  modeOff:()=>true,diff:()=>[{}],activePlan:()=>plan,modeSettings:()=>settings,
  focusPickerMove:()=>{},split:route=>({raw:route}),render:()=>{plan={pending:true,previous:plan.data};}};
 runInNewContext(['modeView','chain','projectionPending','pickerActionsPending','movePickerCut'].map(appFunction).join('\n'),chainContext(context));
 context.movePickerCut(1);assert.deepEqual(Array.from(settings.overrides['role:writer']),['p/B','p/A','p/C']);
 context.movePickerCut(1);assert.deepEqual(Array.from(settings.overrides['role:writer']),['p/B','p/A','p/C'],'repeat while pending cannot read the old projection');
 assert.equal(context.state.picker.index,1);
 plan={data:view([...settings.overrides['role:writer']])};context.movePickerCut(1);
 assert.deepEqual(Array.from(settings.overrides['role:writer']),['p/B','p/C','p/A']);assert.equal(context.state.picker.index,2);
 assert.deepEqual(profile.modelRoles,{writer:'p/deepseek'},'reordering replacements never touches the real chain');
});

test('an older in-flight preview cannot overwrite a newer explicit preview with the same configuration key',async()=>{
 let resolve;
 const state={profile:'standard',modePlans:{}},context={state,source:{profileModes:{}},diff:()=>[{}],modeKey:()=> 'same',modeBody:()=>({}),
  api:()=>new Promise(done=>{resolve=done;}),interactionBusy:()=>false,render:()=>assert.fail('stale preview must not repaint')};
 runInNewContext(appFunction('ensureModePreview'),context);context.ensureModePreview();await Promise.resolve();
 const saved={key:'same',data:{token:'newer'}};state.modePlans.standard=saved;resolve({token:'older'});
 await new Promise(setImmediate);assert.equal(state.modePlans.standard,saved);
});

test('save replaces a queued preview even when a changed token requires another confirmation',async()=>{
 const fresh={token:'fresh',issues:[]},old={key:'same',data:{token:'old',issues:[]}},pendingModeResults=new Map([['standard',old]]);
 const state={profile:'standard',modePlans:{standard:{key:'same',pending:true}}},context={state,pendingModeResults,
  profiles:{standard:{forgeMode:{mode:'no-deepseek'}}},copy:structuredClone,diff:()=>[{}],activePlan:()=>old,modeKey:()=> 'same',modeBody:()=>({}),
  api:async()=>fresh,notify:()=>{},render:()=>{},interactionBusy:()=>false,pendingRender:false,backgroundRefreshPending:false};
 runInNewContext(appFunction('save')+'\n'+appFunction('flushBackgroundWork'),context);
 await context.save();context.flushBackgroundWork();
 assert.equal(state.modePlans.standard.data,fresh);assert.equal(pendingModeResults.size,0);assert.equal(state.saving,false);
});

test('linked agents show role inheritance instead of pretending a primary pool is a startup list',()=>{
 const profile={modelRoles:{reader:'mana-pool/free-fast'},retry:{modelFallback:true},task:{agentModelOverrides:{reviewer:'@reader',scout:['@reader'],external:'@advisor',task:['@reader','p/backup']}}};
 const context=roleContext({p:()=>profile,roleKeys:['reader'],esc:s=>s,tool:()=>'',poolName:r=>r==='mana-pool/free-fast'?'free-fast':undefined});
 runInNewContext(['led','key','agentValues','agentLink','agentTier','agentName','agentKey','agentRemove','patchKey','agentLinkedTrack'].map(appFunction).join('\n'),context);
 for(const worker of ['reviewer','scout']){
  const html=context.agentLinkedTrack(worker);
  assert.match(html,/Успадковує @reader/);assert.match(html,/Основна й резерви ролі/);
  assert.match(html,/class="key patch" data-agent-role="reader"/,'a patch key, not a link');assert.doesNotMatch(html,/FREE FAST|data-edit=|16 CUTS|↗/);
 }
 assert.equal(context.agentLink('task'),'');assert.match(context.agentName('task'),/Vibe GOOD/);
 assert.match(context.agentName('sonic'),/Vibe FAST/);assert.doesNotMatch(context.agentName('reviewer'),/Vibe/);
 const unknown=context.agentLinkedTrack('external');assert.match(unknown,/Модель і резерви визначає OMP/);assert.doesNotMatch(unknown,/data-agent-role=/);
 profile.retry.modelFallback=false;assert.match(context.agentLinkedTrack('scout'),/резерви вимкнено/);
});

test('editing a role syncs only agent lists that mirrored its fallbacks and keeps singleton inheritance intact',()=>{
 const profile={modelRoles:{reader:'p/a'},retry:{fallbackChains:{reader:['p/b']}},task:{agentModelOverrides:{one:'@reader',two:['@reader'],mirror:['@reader','p/b'],custom:['@reader','p/c'],other:['p/x','p/y']}}};
 const context=chainContext({p:()=>profile,state:{syncVibe:true,opFeedback:''}});
 context.setChain('reader',['p/new','p/next']);
 assert.equal(profile.task.agentModelOverrides.one,'@reader');assert.deepEqual(profile.task.agentModelOverrides.two,['@reader']);
 assert.deepEqual(Array.from(profile.task.agentModelOverrides.mirror),['@reader','p/next'],'a list that repeated the role follows it');
 assert.deepEqual(Array.from(profile.task.agentModelOverrides.custom),['@reader','p/c'],'an own list is never overwritten');
 assert.deepEqual(profile.task.agentModelOverrides.other,['p/x','p/y']);
 assert.match(context.state.opFeedback,/mirror/);assert.doesNotMatch(context.state.opFeedback,/custom/);
 context.state.syncVibe=false;context.setChain('reader',['p/later','p/last']);
 assert.deepEqual(Array.from(profile.task.agentModelOverrides.mirror),['@reader','p/next']);
});

test('copying an inherited agent preserves normal routes and DeepSeek settings as one undoable edit',()=>{
 const {ForgeHistory}=require('./static/tape.js'),history=new ForgeHistory();
 const profile={modelRoles:{reader:'p/deepseek'},retry:{fallbackChains:{reader:['mana-pool/free-fast','p/extra']}},task:{agentModelOverrides:{custom:'@reader'}},forgeMode:{mode:'no-deepseek',overrides:{'role:reader':['p/replacement']}}};
 const baseline=structuredClone(profile),context={p:()=>profile,state:{poolPanel:true},roleKeys:['reader'],copy:structuredClone,CSS:{escape:s=>s},
  source:{freePools:{'free-fast':['p/free1','p/free2']}},poolName:r=>r==='mana-pool/free-fast'?'free-fast':undefined,
  modeOff:()=>true,modeView:()=>({}),diff:()=>[],chain:()=>['p/replacement','mana-pool/free-fast','p/extra'],modeSettings:()=>profile.forgeMode,render:()=>history.observe('one',profile,true,baseline),win:{querySelectorAll:()=>[]},scrollToControl:()=>{},notify:()=>assert.fail('valid conversion must work')};
 history.observe('one',profile,false);
 runInNewContext(['agentValues','agentLink','baseChain','projectionPending','copyAgentRole'].map(appFunction).join('\n'),roleContext(context));
 context.copyAgentRole('custom');
 assert.equal(context.state.poolPanel,false,'conversion must activate the profile Undo/Save scope');
 assert.deepEqual(Array.from(profile.task.agentModelOverrides.custom),['p/deepseek','mana-pool/free-fast','p/extra']);
 assert.deepEqual(profile.modelRoles,baseline.modelRoles);assert.deepEqual(profile.retry,baseline.retry);
 assert.deepEqual(profile.forgeMode.overrides['vibe:custom'],['p/replacement']);
 assert.notEqual(profile.forgeMode.overrides['vibe:custom'],profile.forgeMode.overrides['role:reader']);
 assert.deepEqual(history.step('one',-1),baseline);assert.equal(history.step('one',-1),null);
});

test('copying an agent refuses to silently add default fallbacks or truncate a long role',()=>{
 for(const long of [false,true]){
  const profile={modelRoles:{reader:'p/a'},retry:{fallbackChains:{reader:long?Array.from({length:30},(_,i)=>'p/'+i):[],default:['p/default']}},task:{agentModelOverrides:{custom:'@reader'}}};
  const notices=[],before=JSON.stringify(profile),context={p:()=>profile,state:{},roleKeys:['reader'],modeOff:()=>false,chain:()=>[profile.modelRoles.reader,...profile.retry.fallbackChains.reader],poolName:()=>undefined,notify:s=>notices.push(s)};
  runInNewContext(['agentValues','agentLink','baseChain','projectionPending','copyAgentRole'].map(appFunction).join('\n'),roleContext(context));
  context.copyAgentRole('custom');assert.equal(JSON.stringify(profile),before);assert.equal(notices.length,1);
  assert.match(notices[0],long?/30 CUTS/:/default/);
 }
});

test('agent conversion waits for OFF preview and rejects an OFF singleton with default fallbacks',()=>{
 const profile={modelRoles:{reader:'p/a'},retry:{fallbackChains:{reader:['p/deepseek'],default:['p/default']}},task:{agentModelOverrides:{custom:'@reader'}}};
 let pending=true;const notices=[],before=JSON.stringify(profile),context={p:()=>profile,state:{profile:'one'},roleKeys:['reader'],modeOff:()=>true,
  modeView:()=>({}),diff:()=>[{}],activePlan:()=>pending?{pending:true}:{data:{}},chain:()=>['p/a'],poolName:()=>undefined,notify:s=>notices.push(s)};
 runInNewContext(['agentValues','agentLink','baseChain','projectionPending','copyAgentRole'].map(appFunction).join('\n'),roleContext(context));
 context.copyAgentRole('custom');assert.match(notices.pop(),/Дочекайся/);
 pending=false;context.copyAgentRole('custom');assert.match(notices.pop(),/default/);assert.equal(JSON.stringify(profile),before);
});

test('quota screens stay compact, keep complete family labels and give each account a stable screen and its own ТОН encoder',()=>{
 const ManaScreen=require('./static/screen.js');
 let reports=[{provider:'google-antigravity',account:4,limits:['Anthropic','Claude','Google','OpenAI'].map(label=>({label:label+' 7 day',window:'7 day',remaining:50}))},
  {provider:'commandcode',account:5,limits:[]},{provider:'google-antigravity',account:6,limits:[]}];
 const context={state:{meters:'full'},opReportCache:null,usageReports:()=>reports,providerName:id=>id,providerCode:id=>id.slice(0,3).toUpperCase(),providerSlot:()=>'stu',esc:String,ManaScreen,
  catalog:[],deepSeekCatalog:false,modeOff:()=>false,deepseek:()=>false,
  op:{pace:()=>({kind:'unknown'})},timeLabel:()=>'',reportAge:()=>'',opPaceText:()=>'',opForecast:()=>'',resetTitle:()=>'',resetCountdown:()=>'',microDuration:()=>'',num:String};
 runInNewContext(['led','limitLabel','winCell','screenHead','quotaScreen','usageScreens','hueEncoder'].map(appFunction).join('\n')+
  "\nconst SCREEN_HUE={stu:250};const screenHue=()=>250;const GLASS_OPEN=['<div class=\"screen__win\">','<div class=\"screen__gasket\">','<div class=\"glass\">'];const glass=inner=>GLASS_OPEN.join('')+inner+'</div></div></div>';const segments=()=>0;const screenId=r=>r.provider==='@tariff'?'tariff':'quota:'+r.provider+':'+r.account;const winsMarkup=(r,name)=>r.limits.length?'<div class=\"wins\">'+r.limits.map(l=>winCell(l,r,name)).join('')+'</div>':'<div class=\"g-empty\"></div>';",context);
 assert.equal(context.limitLabel({label:'Claude & GPT shared · 7 day',window:'7 day'}),'Claude & GPT shared · 7 днів');
 const markup=()=>context.usageScreens().rows.map(r=>context.quotaScreen(r,'')).join('');
 const html=markup();
 assert.doesNotMatch(html,/scale-key|data-op-switch="meters"|\bFULL\b|data-lcd-colour/);
 for(const family of ['Anthropic','Claude','Google','OpenAI'])assert.ok(html.includes(`<span class="win__l">${family} · 7 днів</span>`));
 const ids=h=>[...h.matchAll(/class="screen"[^>]*data-screen="([^"]+)"/g)].map(match=>match[1]);
 assert.deepEqual(ids(html),['quota:google-antigravity:1','quota:commandcode:1','quota:google-antigravity:2']);
 for(const id of ids(html))assert.ok(html.includes(`data-knob="hue" data-screen-hue="${id}"`),'each screen has its own ТОН encoder, on the chin');
 assert.ok(!/<div class="g"[^]*data-knob/.test(html.split('screen__chin')[0]),'no control on the glass');
 assert.match(html,/google-antigravity #2/,'a second account is numbered once, in its name');
 reports=[{provider:'other',account:1,limits:[]},...reports.map((report,i)=>({...report,account:i+2}))];
 assert.deepEqual(ids(markup()).filter(id=>!id.startsWith('quota:other:')),ids(html),'an unrelated provider cannot change existing screen preferences');
});

test('operator preferences no longer persist the removed meter scale',()=>{
 let saved;
 const context={state:{meters:'full',health:false,drawerHeight:280},localStorage:{setItem:(key,value)=>{assert.equal(key,'mana-operator');saved=JSON.parse(value);}}};
 runInNewContext(appFunction('storeOperator'),context);context.storeOperator();
 assert.deepEqual(saved,{health:false,drawerHeight:280,drawerResized:true});
 context.state.drawerHeight=undefined;context.storeOperator();
 assert.deepEqual(saved,{health:false},'no user resize, no stored height');
});

test('rerender restores focus to the same screen ТОН encoder and the brightness knob',()=>{
 const context={CSS:{escape:s=>s}};
 runInNewContext(appFunction('focusSelector'),context);
 const control=attrs=>({matches:()=>false,closest:()=>null,hasAttribute:key=>Object.hasOwn(attrs,key),getAttribute:key=>attrs[key]});
 assert.equal(context.focusSelector(control({'data-knob':'hue','data-screen-hue':'history'})),'[data-knob="hue"][data-screen-hue="history"]');
 assert.equal(context.focusSelector(control({'data-knob':'hue','data-screen-hue':'quota:p:2'})),'[data-knob="hue"][data-screen-hue="quota:p:2"]');
 assert.equal(context.focusSelector(control({'data-knob':'brightness'})),'[data-knob="brightness"]');
 assert.equal(context.focusSelector(control({'data-fold-toggle':'smol'})),'[data-fold-toggle="smol"]');
});

function drawerHarness(preferred=500,{innerWidth=1280,innerHeight=900,scrollbar=0,lip=46,open=true}={}){
 const events={},attrs={},captures=new Set(),stored=[],page={},frames=[],classes=new Set();
 const body={left:34,width:1212},state={drawerHeight:preferred,cuts:open};
 // A fixed drawer in a fixed port: the port follows the device body; the spacer after the body equals the drawer.
 const tray={style:{},classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)},getBoundingClientRect:()=>({height:parseFloat(tray.style.height)}),closest:()=>tray};
 const grip={id:'cuts-resize',focus:()=>{},closest:key=>key==='.tray'?tray:grip,setAttribute:(key,value)=>{attrs[key]=value;}};
 const port={style:{},querySelector:key=>key==='.tray'?tray:key==='#cuts-resize'?grip:null},spacer={style:{}},device={getBoundingClientRect:()=>({left:body.left,width:body.width})};
 const context={state,root:{addEventListener:(key,handler)=>{events[key]=handler;},setPointerCapture:id=>captures.add(id),hasPointerCapture:id=>captures.has(id),releasePointerCapture:id=>captures.delete(id)},
  win:{querySelector:key=>key==='.tray-port'?port:key==='.tray-spacer'?spacer:key==='.device'?device:null},
  window:{innerWidth,innerHeight,addEventListener:()=>{}},
  requestAnimationFrame:fn=>frames.push(fn),cancelAnimationFrame:id=>{frames[id-1]=null;},
  getComputedStyle:()=>({getPropertyValue:key=>key==='--lip'?String(lip):''}),
  render:()=>{},narrowSurface:()=>false,matchMedia:()=>({matches:false}),paintRegions:()=>{},leaf:(key,html)=>({key,html}),touched:()=>false,setTimeout,clearTimeout,
  localStorage:{setItem:(_key,value)=>stored.push(JSON.parse(value))}};
 // The page scroller: its client box excludes a classic scrollbar and follows the window.
 context.document={documentElement:{get clientWidth(){return context.window.innerWidth-scrollbar;},get clientHeight(){return context.window.innerHeight;},
  style:{setProperty:(key,value)=>{page[key]=value;},removeProperty:key=>{delete page[key];}}}};
 const start=source.indexOf(' let drawerGesture=null'),end=source.indexOf('\n function placeCut(',start);
 runInNewContext(source.slice(start,end)+'\n'+appFunction('storeOperator'),context);
 context.resizeDrawer(state.drawerHeight);
 const event=(pointerId,clientY)=>({pointerId,clientY,button:0,target:grip,preventDefault:()=>{}});
 // Moves are coalesced to one write per animation frame.
 const flush=()=>{for(const fn of frames.splice(0))fn?.();};
 return {context,state,body,tray,port,spacer,grip,attrs,stored,events,event,page,frames,flush,classes};
}

test('CUTS keeps its chosen height across opening positions and temporary viewport limits',()=>{
 const h=drawerHarness();
 assert.equal(h.attrs['aria-valuenow'],500);assert.equal(h.tray.style.height,'500px');
 assert.equal(h.port.style.left,'34px');assert.equal(h.port.style.width,'1212px','exactly as wide as the body');
 h.context.resizeDrawer(h.state.drawerHeight);assert.equal(h.attrs['aria-valuenow'],500,'a re-placement keeps the height');
 h.context.window.innerHeight=420;h.context.resizeDrawer(h.state.drawerHeight);
 assert.equal(h.attrs['aria-valuenow'],200,'≈220px of page stays visible above it');assert.equal(h.state.drawerHeight,500,'clamping is temporary');
 h.context.window.innerHeight=900;h.context.resizeDrawer(h.state.drawerHeight);
 assert.equal(h.attrs['aria-valuenow'],500);
});

test('CUTS resize starts at the visible edge, commits locally, and Escape restores the previous preference',()=>{
 const h=drawerHarness(800);h.context.window.innerHeight=500;h.context.resizeDrawer(h.state.drawerHeight);
 assert.equal(h.attrs['aria-valuenow'],280);
 h.events.pointerdown(h.event(1,60));h.events.pointermove(h.event(1,90));h.events.pointermove(h.event(1,100));
 assert.equal(h.attrs['aria-valuenow'],280,'a move only records the height; the write waits for the frame');
 assert.ok(h.classes.has('is-resizing'),'no slide transition under the hand');
 assert.equal(h.frames.length,1,'several moves share one animation frame');h.flush();
 assert.equal(h.attrs['aria-valuenow'],240,'drag starts from the clamped 280px edge, not the hidden 800px preference');
 assert.equal(h.tray.style.height,'240px');assert.equal(h.spacer.style.height,'268px','the spacer keeps every lane scrollable above the drawer');
 assert.deepEqual(Object.keys(h.page),['scroll-padding-bottom'],'no custom property is written on the root');
 h.events.pointerdown(h.event(2,100));h.events.pointermove(h.event(2,180));h.flush();
 assert.equal(h.attrs['aria-valuenow'],240,'a second pointer must not replace the active resize');
 h.events.keydown({key:'Escape',preventDefault:()=>{}});
 assert.equal(h.state.drawerHeight,800);assert.equal(h.attrs['aria-valuenow'],280);assert.equal(h.stored.length,0);assert.ok(!h.classes.has('is-resizing'));
 h.events.pointerdown(h.event(1,60));h.events.pointermove(h.event(1,100));h.events.pointerup(h.event(1,100));
 assert.equal(h.stored.at(-1).drawerHeight,240);assert.equal(h.stored.at(-1).drawerResized,true);
 h.events.keydown({key:'ArrowDown',target:h.grip,preventDefault:()=>{}});
 assert.equal(h.attrs['aria-valuenow'],216);assert.equal(h.stored.at(-1).drawerHeight,216);
});

test('built-in roles stay visible with empty assignments without changing drafts',()=>{
 const builtinRoles=[{id:'default'},{id:'smol'},{id:'image',kinds:['image'],thinking:false,defaultFallbacks:false}];
 const profile={modelRoles:{},retry:{fallbackChains:{default:['p/chat']}},task:{agentModelOverrides:{}}},before=JSON.stringify(profile);
 const context=roleContext({builtinRoles,p:()=>profile});
 runInNewContext(['knownRoleKeys','baseChain','oldSetChain'].map(appFunction).join('\n'),context);
 assert.deepEqual(Array.from(context.knownRoleKeys(profile)),['default','smol','image']);
 assert.deepEqual(Array.from(context.baseChain('smol')),[],'an implicit primary is not the first default fallback');
 assert.equal(JSON.stringify(profile),before,'render metadata must not create assignments');
 context.oldSetChain('smol',['p/fast']);
 assert.deepEqual(profile.modelRoles,{smol:'p/fast'});
 assert.ok(!Object.hasOwn(profile.retry.fallbackChains,'smol'),'first assignment preserves OMP fallback defaults');
 context.oldSetChain('smol',['p/other',...context.roleFallbacks('smol')]);assert.ok(!Object.hasOwn(profile.retry.fallbackChains,'smol'),'replacing only a primary preserves implicit fallback defaults');
 delete profile.modelRoles.smol;profile.retry.fallbackChains.smol=['p/spare'];context.oldSetChain('smol',['p/new']);assert.deepEqual(profile.retry.fallbackChains.smol,['p/spare']);
 context.oldSetChain('image',['p/image']);
 assert.deepEqual(Array.from(context.baseChain('image')),['p/image'],'image never inherits chat fallbacks');
 profile.modelRoles.writer='p/writer';
 assert.deepEqual(Array.from(context.knownRoleKeys(profile)),['default','smol','image','writer']);
});

test('resetting a built-in role creates removals and Undo restores its assignment',()=>{
 const {ForgeHistory}=require('./static/tape.js'),history=new ForgeHistory();
 const baseline={modelRoles:{smol:'p/fast'},retry:{fallbackChains:{smol:['p/spare']}},task:{agentModelOverrides:{}},forgeMode:{mode:'deepseek',alternatives:[],overrides:{}}};
 const profile=structuredClone(baseline),context=roleContext({builtinRoles:[{id:'smol'}],state:{profile:'standard'},p:()=>profile,
  original:{standard:baseline},profiles:{standard:profile},copy:structuredClone,modeSettings:()=>profile.forgeMode,renderCache:null,
  render:()=>history.observe('standard',profile,true,baseline)});
 context.focusLane=()=>{};runInNewContext(['resetRole','workers','diff'].map(appFunction).join('\n'),context);
 history.observe('standard',profile,false);context.resetRole('smol');
 assert.deepEqual(Array.from(context.diff('standard'),v=>JSON.parse(JSON.stringify(v))),[
  {path:['modelRoles','smol'],remove:true},{path:['retry','fallbackChains','smol'],remove:true}]);
 assert.deepEqual(history.step('standard',-1),baseline);
});

test('role pickers enforce native model capabilities, including grounded web chat',()=>{
 const builtinRoles=[{id:'smol',kinds:['chat']},{id:'image',kinds:['image']},{id:'speech',kinds:['tts']},{id:'web',kinds:['search','chat']},{id:'judge',kinds:['judge','tiny','chat']}];
 const context=roleContext({builtinRoles});runInNewContext(appFunction('acceptsRoleModel'),context);
 assert.equal(context.acceptsRoleModel('smol','role',{}),true);
 assert.equal(context.acceptsRoleModel('image','role',{kind:'chat'}),false);
 assert.equal(context.acceptsRoleModel('speech','role',{kind:'tts'}),true);
 assert.equal(context.acceptsRoleModel('speech','role',{kind:'chat'}),false);
 assert.equal(context.acceptsRoleModel('web','role',{kind:'chat'}),false);
 assert.equal(context.acceptsRoleModel('web','role',{kind:'chat',webSearch:{}}),true);
 assert.equal(context.acceptsRoleModel('web','role',{kind:'search'}),true);
 assert.equal(context.acceptsRoleModel('judge','role',{kind:'tiny'}),true);
});

test('built-in agents display native defaults without materializing override lists',()=>{
 const builtinAgents=[{id:'scout',model:'@smol',description:'Read only'},{id:'security-reviewer',model:null},{id:'task',model:'@task'}];
 const profile={modelRoles:{smol:'p/fast'},retry:{fallbackChains:{}},task:{agentModelOverrides:{custom:['p/unknown']}}},before=JSON.stringify(profile);
 const context=roleContext({source:{agents:builtinAgents},p:()=>profile,roleKeys:['smol','task'],esc:s=>String(s??''),tool:(txt,act,cl,attr)=>`<button ${attr}>${txt}</button>`});
 context.chainNotes=[];runInNewContext(['led','workers','agentValues','agentTier','agentName','agentKey','patchKey','socketKey','agentDefaultTrack','aliasRole','resolveAlias','baseChain','vibeAlias','oldSetChain','agentFromResolved','writeAgent'].map(appFunction).join('\n'),context);
 assert.deepEqual(Array.from(context.workers()),['scout','security-reviewer','task','custom']);
 const html=context.agentDefaultTrack('scout');
 assert.match(html,/<div class="leader"[^>]*><b>Типово в OMP<\/b>/,'leader tape, not a CUT');assert.doesNotMatch(html,/class="cut/);
 assert.match(html,/class="socket" data-edit="scout" data-index="0" data-group="vibe"/);assert.match(html,/Обрати CUT для агента: scout/);assert.match(html,/class="key patch" data-agent-role="smol"/);
 assert.doesNotMatch(context.agentDefaultTrack('security-reviewer'),/data-agent-role=/);
 assert.equal(JSON.stringify(profile),before);assert.equal(context.baseChain('scout','vibe').length,0);
 context.oldSetChain('scout',['p/own'],'vibe');
 assert.deepEqual(Array.from(profile.task.agentModelOverrides.scout),['p/own']);
 assert.equal(profile.modelRoles.smol,'p/fast');assert.equal(profile.task.agentModelOverrides.task,undefined);
});

test('resetting a built-in agent emits removal and supports Undo and preset inheritance',()=>{
 const baseline={modelRoles:{smol:'p/fast'},retry:{fallbackChains:{}},task:{agentModelOverrides:{scout:['p/own']}},forgeMode:{overrides:{'vibe:scout':['p/alt']}}};
 const profile=structuredClone(baseline),context=roleContext({source:{agents:[{id:'scout',model:'@smol'}]},state:{profile:'standard'},p:()=>profile,
  original:{standard:baseline},profiles:{standard:profile},modeSettings:()=>profile.forgeMode,copy:structuredClone,render:()=>{},renderCache:null});
 context.focusLane=()=>{};runInNewContext(['workers','resetAgent','diff'].map(appFunction).join('\n'),context);
 const {ForgeHistory}=require('./static/tape.js'),history=new ForgeHistory();history.observe('standard',profile,false);
 context.resetAgent('scout');history.observe('standard',profile,true,baseline);
 assert.equal(profile.task.agentModelOverrides.scout,undefined);assert.equal(profile.modelRoles.smol,'p/fast');
 assert.ok(context.diff('standard').some(c=>c.remove&&c.path.join('.')==='task.agentModelOverrides.scout'));
 assert.deepEqual(history.step('standard',-1),baseline);
 context.state.profile='preset';profile.task.agentModelOverrides.scout=['p/preset'];context.resetAgent('scout');
 assert.deepEqual(profile.task.agentModelOverrides.scout,['p/own']);
});

test('DELETED is explicit on configured CUTs and never inferred from quotas or missing metadata',()=>{
 const catalogMap=new Map([
  ['p/gone:free',{provider:'p',id:'gone:free',name:'gone:free',status:'missing'}], ['p/live',{provider:'p',id:'live',name:'live',status:'present'}],
  ['p/offline',{provider:'p',id:'offline',name:'offline',available:false}], ['p/empty',{provider:'p',id:'empty',name:'empty',status:'present',remaining:0}]
 ]);
 const context={catalogMap,state:{},split:r=>({raw:r.replace(/:high$/,''),provider:'p',id:r.slice(2).replace(/:high$/,''),effort:''}),providerName:()=> 'Provider',providerCode:()=> 'P',providerSlot:()=>'stu',esc:s=>s,
  cutTitle:r=>r,freeRoute:r=>/free/.test(r)&&catalogMap.get(r)?.status!=='missing',healthMarks:()=>({glyph:'',bar:'',text:''}),routeWarning:()=>false,isLocal:()=>false,poolName:()=>undefined};
 runInNewContext(['deletedCut','nameParts','nameSpace','drawerCut'].map(appFunction).join('\n')+'\n'+source.match(/\n (const nameMarkup=[^\n]*)/)[1],context);
 for(const r of ['p/gone:free']){
  const cut=context.drawerCut(catalogMap.get(r));
  assert.match(cut,/class="cut cut--deleted"/);assert.match(cut,/class="stamp stamp--del">DELETED</);
  assert.doesNotMatch(cut,/stamp--free/,'a DELETED route carries no FREE stamp');
 }
 for(const r of ['p/live','p/offline','p/empty']){const cut=context.drawerCut(catalogMap.get(r));assert.doesNotMatch(cut,/DELETED|cut--deleted/);}
 catalogMap.get('p/gone:free').status='present';
 assert.doesNotMatch(context.drawerCut(catalogMap.get('p/gone:free')),/DELETED/);
});

test('pool picker and tap insertion accept more than 30 FREE CUTS and still reject paid routes',()=>{
 const routes=Array.from({length:40},(_,i)=>'demo/cut-'+i+':free'),poolDraft={'free-good':routes.slice(0,30)},notices=[];
 const catalogMap=new Map(routes.map(r=>[r,{free:true}]));catalogMap.set('demo/paid',{free:false});
 const context={state:{profile:'standard'},poolDraft,catalogMap,source:{},
  split:r=>({raw:r,provider:r.split('/')[0],id:r.split('/')[1]}),ManaOperator:{isFreeModel:m=>m.free===true},
  chain:role=>[...poolDraft[role]],poolName:()=>null,modeOff:()=>false,routeWarning:()=>false,
  notify:s=>notices.push(s),narrowSurface:()=>false,short:s=>s,providerName:s=>s,cutTitle:s=>s,render:()=>{}};
 roleContext(context);
  runInNewContext(['acceptsRoleModel','thinkingOff','withNotes','setChain','carryEffort','commitCut'].map(appFunction).join('\n'),context);
 context.commitCut(routes[30],{role:'free-good',group:'pool',index:30,profile:'standard',expected:null});
 assert.equal(poolDraft['free-good'].length,31);assert.equal(poolDraft['free-good'][30],routes[30]);
 context.setChain('free-good',routes,'pool');assert.equal(poolDraft['free-good'].length,40);
 context.setChain('free-good',[...routes,routes[0]],'pool');assert.equal(poolDraft['free-good'].length,40);
 context.setChain('free-good',[...routes,'demo/paid'],'pool');assert.equal(poolDraft['free-good'].length,40);
 assert.equal(notices.length,1);assert.match(notices[0],/FREE CUTS/);
});

test('custom agents show their source, own model default and remain removable when the file disappears',()=>{
 const agents=[{id:'scout',model:'@smol',description:'Read only',source:'builtin'},
  {id:'designer',model:null,description:'UI designer',source:'project'},
  {id:'helper',model:['@slow','p/own:high'],description:'Helper',source:'user'},
  {id:'reviewer',model:'@slow',description:'Custom reviewer',source:'project',overrides:true}];
 const profile={modelRoles:{slow:'p/slow'},retry:{fallbackChains:{}},task:{agentModelOverrides:{gone:['p/old']}}};
 const context=roleContext({source:{agents},p:()=>profile,roleKeys:['slow','smol'],esc:s=>String(s??''),tool:(txt,act,cl,attr)=>`<button ${attr}>${txt}</button>`});
 runInNewContext(['led','key','workers','agentValues','agentTier','agentName','agentKey','agentRemove','patchKey','socketKey','agentDefaultTrack'].map(appFunction).join('\n'),context);
 assert.deepEqual(Array.from(context.workers()),['scout','designer','helper','reviewer','gone']);
 assert.match(context.agentName('designer'),/проєкт/);assert.match(context.agentName('helper'),/користувач/);
 assert.doesNotMatch(context.agentName('scout'),/проєкт|користувач/);assert.match(context.agentName('reviewer'),/замінює штатного/);
 const html=context.agentDefaultTrack('designer');
 assert.match(html,/UI designer/);assert.match(html,/успадковує модель сесії/);assert.doesNotMatch(html,/data-agent-role=/);
 const list=context.agentDefaultTrack('helper');
 assert.match(list,/@slow → p\/own:high/);assert.doesNotMatch(list,/data-agent-role=/);
 assert.match(context.agentDefaultTrack('reviewer'),/data-agent-role="slow"/);
 assert.match(context.agentRemove('gone'),/data-reset-agent="gone"/);
 assert.equal(context.agentRemove('designer'),'');
});

test('removing an orphaned agent override emits a removal',()=>{
 const baseline={modelRoles:{},retry:{fallbackChains:{}},task:{agentModelOverrides:{gone:['p/old']}}};
 const profile=structuredClone(baseline),context=roleContext({source:{agents:[]},state:{profile:'standard'},p:()=>profile,
  original:{standard:baseline},profiles:{standard:profile},modeSettings:()=>({overrides:{}}),copy:structuredClone,render:()=>{},renderCache:null});
 context.focusLane=()=>{};runInNewContext(['workers','resetAgent','diff'].map(appFunction).join('\n'),context);
 context.resetAgent('gone');
 assert.equal(profile.task.agentModelOverrides.gone,undefined);
 assert.ok(context.diff('standard').some(c=>c.remove&&c.path.join('.')==='task.agentModelOverrides.gone'));
});


test('off is separate from supported reasoning efforts in every CUT select',()=>{
 const context={catalogMap:new Map([['p/model',{reasoning:true,thinking:['medium','xhigh']}],['p/duplicate',{thinking:['off','medium']}],['p/plain',{reasoning:false}]])};
 context.esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 runInNewContext(appFunction('options'),context);
 const values=(value,raw)=>Array.from(context.options(value,raw).matchAll(/value="([^" ]*)"/g),m=>m[1]);
 assert.deepEqual(values('off','p/model'),['','off','medium','xhigh']);
 assert.match(context.options('off','p/model'),/value="off" selected/);
 assert.deepEqual(values('','p/duplicate'),['','off','medium']);
 assert.deepEqual(values('','p/plain'),['','off']);
 assert.ok(values('','p/unknown').includes('off'));
 assert.ok(values('high','p/model').includes('high'),'retain a saved unsupported value for manual correction');
});

// Regressions for the lane-edit, drawer and focus fixes (review 2026-10-12).
test('BUG2-A: copying one CUT into a role does not overwrite a diverged agent list with the whole role lane',()=>{
 const profile={modelRoles:{composer:'p/ds'},retry:{fallbackChains:{composer:['p/atlas','p/good','p/fast']}},
  task:{agentModelOverrides:{team:['@composer','p/fast'],mirror:['@composer','p/atlas','p/good','p/fast']}}};
 const context=chainContext({p:()=>profile,state:{syncVibe:true}});
 assert.equal(context.setChain('composer',['p/ds','p/atlas','p/good','p/fast','p/canvas']),true);
 assert.deepEqual(Array.from(profile.task.agentModelOverrides.team),['@composer','p/fast'],'agent-specific list must not become a copy of the role lane');
 assert.deepEqual(Array.from(profile.task.agentModelOverrides.mirror),['@composer','p/atlas','p/good','p/fast','p/canvas'],'a list that mirrored the role may follow it');
 assert.match(context.state.opFeedback,/агентах: mirror$/);
});

test('BUG2-D/H3: an agent edit keeps its @role reference where it ends up and never writes the role',()=>{
 const profile={modelRoles:{composer:'p/ds'},retry:{fallbackChains:{}},task:{agentModelOverrides:{team:['@composer','p/fast']}}};
 const context=chainContext({p:()=>profile});
 // Lane drag onto the head: transferCut(chain(src), ['p/ds','p/fast'], i, 0, false)
 context.setChain('team',['p/canvas','p/ds','p/fast'],'vibe');
 assert.equal(profile.modelRoles.composer,'p/ds','the role lane keeps its primary');
 assert.deepEqual(Array.from(profile.task.agentModelOverrides.team),['p/canvas','@composer','p/fast']);
 // Shift+← on FREE FAST: a reorder moves the reference, not the role's model.
 profile.task.agentModelOverrides.team=['@composer','p/fast'];
 context.setChain('team',['p/fast','p/ds'],'vibe');
 assert.equal(profile.modelRoles.composer,'p/ds');assert.deepEqual(Array.from(profile.task.agentModelOverrides.team),['p/fast','@composer']);
 // Replacing the head in place (pick, thinking, collection) makes an own CUT and says so.
 profile.task.agentModelOverrides.team=['@composer','p/fast'];context.state.opFeedback='';
 context.setChain('team',['p/ds:off','p/fast'],'vibe');
 assert.equal(profile.modelRoles.composer,'p/ds');assert.deepEqual(Array.from(profile.task.agentModelOverrides.team),['p/ds:off','p/fast']);
 assert.match(context.state.opFeedback,/@composer у team замінено власним CUT; роль не змінена/);
});

test('L1: removing the last own candidate turns the list into role inheritance, and the line says so',()=>{
 const profile={modelRoles:{composer:'p/ds'},retry:{fallbackChains:{composer:['p/x']}},task:{agentModelOverrides:{team:['@composer','p/fast']}}};
 const context=chainContext({p:()=>profile});
 context.setChain('team',['p/ds'],'vibe');
 assert.deepEqual(Array.from(profile.task.agentModelOverrides.team),['@composer']);
 assert.match(context.state.opFeedback,/team тепер успадковує @composer разом із резервами ролі/);
});

function offLane(){
 // composer: [DeepSeek, atlas, FREE GOOD]; OFF puts the profile replacements on DeepSeek's place.
 const profile={modelRoles:{composer:'p/deepseek'},retry:{fallbackChains:{composer:['p/atlas','mana-pool/free-good']}},task:{agentModelOverrides:{}},
  forgeMode:{mode:'no-deepseek',alternatives:['p/r1','p/r2'],overrides:{}}};
 const view={routes:['p/r1','p/r2','p/atlas','mana-pool/free-good'],substituted:true,paused:[{index:0,route:'p/deepseek',primary:true}],
  refs:[{kind:'replacement',route:'p/r1',key:'role:composer'},{kind:'replacement',route:'p/r2',key:'role:composer'},{kind:'base',index:1,route:'p/atlas',key:'role:composer'},{kind:'base',index:2,route:'mana-pool/free-good',key:'role:composer',pool:'mana-pool/free-good'}]};
 const context=chainContext({p:()=>profile,state:{syncVibe:false},modeView:()=>view,modeSettings:()=>profile.forgeMode,poolName:r=>r.startsWith('mana-pool/')?r.slice(10):undefined});
 return {profile,view,context,replacements:()=>Array.from(profile.forgeMode.overrides['role:composer']||profile.forgeMode.alternatives),chain:()=>[profile.modelRoles.composer,...profile.retry.fallbackChains.composer]};
}

test('BUG2-C: a drop on a DeepSeek-OFF lane adds one CUT instead of copying the whole visible lane into replacements',()=>{
 const profile={modelRoles:{composer:'p/deepseek'},retry:{fallbackChains:{composer:['p/atlas','mana-pool/free-good']}},task:{agentModelOverrides:{}},
  forgeMode:{mode:'no-deepseek',alternatives:['p/r1','p/r2'],overrides:{}}};
 const view={routes:['p/r1','p/r2','p/atlas','mana-pool/free-good'],substituted:true,
  refs:[{kind:'replacement'},{kind:'replacement'},{kind:'base',index:1},{kind:'base',index:2}]};
 const context=chainContext({p:()=>profile,state:{syncVibe:false},modeView:()=>view,modeSettings:()=>profile.forgeMode,modeScope:(r,g)=>g+':'+r});
 context.setChain('composer',[...view.routes,'p/canvas']);   // "+ резерв" drop
 const replacements=profile.forgeMode.overrides['role:composer']||profile.forgeMode.alternatives;
 assert.ok(!replacements.includes('p/atlas')&&!replacements.includes('mana-pool/free-good'),'base CUTS must not be copied into the replacement list: '+JSON.stringify(replacements));
 assert.deepEqual(Array.from(profile.retry.fallbackChains.composer),['p/atlas','mana-pool/free-good','p/canvas'],'the dropped CUT becomes a real fallback');
});

test('BUG2-C: OFF edits route each CUT by its source and the dropped CUT survives switching ON',()=>{
 let lane=offLane();
 // Reordering replacements stays in the replacement list; the real chain is untouched.
 lane.context.setChain('composer',['p/r2','p/r1','p/atlas','mana-pool/free-good'],'role',{moved:0});
 assert.deepEqual(lane.replacements(),['p/r2','p/r1']);assert.deepEqual(lane.chain(),['p/deepseek','p/atlas','mana-pool/free-good']);
 // A drop before the replacement block goes before DeepSeek in the real chain.
 lane=offLane();lane.context.setChain('composer',['p/new','p/r1','p/r2','p/atlas','mana-pool/free-good']);
 assert.deepEqual(lane.chain(),['p/new','p/deepseek','p/atlas','mana-pool/free-good']);assert.deepEqual(lane.replacements(),['p/r1','p/r2']);
 // A drop inside the block is a normal CUT right after it, never a replacement.
 lane=offLane();lane.context.setChain('composer',['p/r1','p/new','p/r2','p/atlas','mana-pool/free-good']);
 assert.deepEqual(lane.chain(),['p/deepseek','p/new','p/atlas','mana-pool/free-good']);assert.deepEqual(lane.replacements(),['p/r1','p/r2']);
 // A drop on a base CUT inserts before it.
 lane=offLane();lane.context.setChain('composer',['p/r1','p/r2','p/atlas','p/new','mana-pool/free-good']);
 assert.deepEqual(lane.chain(),['p/deepseek','p/atlas','p/new','mana-pool/free-good']);
 // A collection replacement of a ⇄ CUT replaces it in the replacement list.
 lane=offLane();lane.context.setChain('composer',['p/r1','p/other','p/atlas','mana-pool/free-good']);
 assert.deepEqual(lane.replacements(),['p/r1','p/other']);assert.deepEqual(lane.chain(),['p/deepseek','p/atlas','mana-pool/free-good']);
 // Thinking on a base CUT changes that CUT in the real chain.
 lane=offLane();lane.context.setChain('composer',['p/r1','p/r2','p/atlas:high','mana-pool/free-good']);
 assert.deepEqual(lane.chain(),['p/deepseek','p/atlas:high','mana-pool/free-good']);assert.equal(lane.profile.forgeMode.overrides['role:composer'],undefined);
 // Removing a replacement edits only the replacement list.
 lane=offLane();lane.context.setChain('composer',['p/r2','p/atlas','mana-pool/free-good']);
 assert.deepEqual(lane.replacements(),['p/r2']);assert.deepEqual(lane.chain(),['p/deepseek','p/atlas','mana-pool/free-good']);
 // A base CUT moved into the block crosses it as a whole; a replacement cannot leave its block.
 lane=offLane();lane.context.setChain('composer',['p/r1','p/atlas','p/r2','mana-pool/free-good'],'role',{moved:1});
 assert.deepEqual(lane.chain(),['p/atlas','p/deepseek','mana-pool/free-good']);assert.match(lane.context.state.opFeedback,/одним блоком/);
 lane=offLane();assert.equal(lane.context.setChain('composer',['p/r1','p/atlas','p/r2','mana-pool/free-good'],'role',{moved:2}),false);
 assert.deepEqual(lane.chain(),['p/deepseek','p/atlas','mana-pool/free-good']);assert.deepEqual(lane.replacements(),['p/r1','p/r2']);assert.match(lane.context.notices.at(-1),/одним блоком/);
 // A dropped CUT that is already a ⇄ replacement (transferCut moves the exact route) still becomes a real fallback.
 lane=offLane();lane.context.setChain('composer',['p/r1','p/atlas','mana-pool/free-good','p/r2'],'role',{inserted:3});
 assert.deepEqual(lane.chain(),['p/deepseek','p/atlas','mana-pool/free-good','p/r2']);assert.deepEqual(lane.replacements(),['p/r1','p/r2'],'the replacement list keeps it');
 assert.equal(lane.profile.forgeMode.overrides['role:composer'],undefined);
});

test('BUG2-C: an OFF agent lane keeps its @role head and role-owned replacements',()=>{
 const profile={modelRoles:{composer:'p/deepseek'},retry:{fallbackChains:{}},task:{agentModelOverrides:{team:['@composer','p/fast']}},forgeMode:{mode:'no-deepseek',alternatives:['p/r1','p/r2'],overrides:{}}};
 const view={routes:['p/r1','p/r2','p/fast'],alias:'@composer',substituted:true,paused:[{index:0,route:'p/deepseek',primary:true}],
  refs:[{kind:'base',index:0,route:'p/deepseek',key:'vibe:team'},{kind:'replacement',route:'p/r2',key:'role:composer'},{kind:'base',index:1,route:'p/fast',key:'vibe:team'}]};
 const context=chainContext({p:()=>profile,modeView:()=>view,modeSettings:()=>profile.forgeMode});
 context.setChain('team',['p/r1','p/r2','p/fast','p/canvas'],'vibe');
 assert.deepEqual(Array.from(profile.task.agentModelOverrides.team),['@composer','p/fast','p/canvas']);
 assert.equal(profile.modelRoles.composer,'p/deepseek');assert.deepEqual(profile.forgeMode.overrides,{});
});

test('BUG2-B: default fallbacks are marked inherited and an edit that copies them says so',()=>{
 const profile={modelRoles:{plan:'p/a',image:'p/img'},retry:{fallbackChains:{default:['p/x','p/y']}},task:{agentModelOverrides:{}}};
 const context=chainContext({p:()=>profile,builtinRoles:[{id:'default'},{id:'plan'},{id:'image',defaultFallbacks:false}]},['inheritedSlot']);
 assert.deepEqual([0,1,2].map(i=>context.inheritedSlot('plan',i)),[false,true,true]);
 assert.equal(context.inheritedSlot('default',1),false);assert.equal(context.inheritedSlot('image',1),false);
 // Replacing only the primary keeps following default.
 context.setChain('plan',['p/b','p/x','p/y']);
 assert.equal(profile.modelRoles.plan,'p/b');assert.ok(!Object.hasOwn(profile.retry.fallbackChains,'plan'));assert.equal(context.state.opFeedback,undefined);
 // Adding a fallback has to copy the inherited chain: one explicit, reported change.
 context.setChain('plan',['p/b','p/x','p/y','p/new']);
 assert.deepEqual(Array.from(profile.retry.fallbackChains.plan),['p/x','p/y','p/new']);
 assert.match(context.state.opFeedback,/Резерви default скопійовано в plan/);
 assert.equal(context.inheritedSlot('plan',1),false,'own fallbacks are no longer inherited');
 // In OFF, only base CUTS from the default chain are inherited.
 delete profile.retry.fallbackChains.plan;
 context.modeView=()=>({refs:[{kind:'replacement'},{kind:'base',index:1},{kind:'base',index:2}]});
 assert.deepEqual([0,1,2].map(i=>context.inheritedSlot('plan',i)),[false,true,true]);
 context.modeView=()=>({refs:[{kind:'base',index:0},{kind:'replacement'},{kind:'base',index:1}]});
 assert.deepEqual([0,1,2].map(i=>context.inheritedSlot('plan',i)),[false,false,true]);
});

test('H4: roles without thinking get no effort suffix from a drop, pick or replacement',()=>{
 const builtinRoles=[{id:'judge',thinking:false},{id:'composer'}];
 const profile={modelRoles:{judge:'p/j',composer:'p/c'},retry:{fallbackChains:{judge:['p/old:high']}},task:{agentModelOverrides:{}},forgeMode:{alternatives:[],overrides:{}}};
 const context=chainContext({p:()=>profile,builtinRoles,split:r=>{const m=r.match(/:(off|low|high)$/);return {raw:m?r.slice(0,-m[0].length):r,effort:m?.[1]||''};},modeSettings:()=>profile.forgeMode},['chain']);
 context.setChain('judge',['p/j','p/old:high','p/atlas:high']);
 assert.deepEqual(Array.from(profile.retry.fallbackChains.judge),['p/old:high','p/atlas'],'only the inserted CUT is normalised; a saved value stays visible for manual correction');
 assert.match(context.state.opFeedback,/thinking прибрано: judge/);
 context.setChain('judge',['p/new:off','p/old:high','p/atlas']);assert.equal(profile.modelRoles.judge,'p/new');
 context.setChain('composer',['p/c','p/atlas:high']);assert.deepEqual(Array.from(profile.retry.fallbackChains.composer),['p/atlas:high']);
 context.setChain('role:judge',['p/alt:low'],'alternatives');assert.deepEqual(Array.from(profile.forgeMode.overrides['role:judge']),['p/alt']);
});

test('M11/H4: a replacement keeps thinking off and only efforts the new model lists',()=>{
 const context={catalogMap:new Map([['p/listed',{thinking:['low','high']}],['p/ext',{thinking:{mode:'effort',efforts:['medium']}}],['p/plain',{reasoning:false}]])};
 runInNewContext(appFunction('carryEffort'),context);
 assert.equal(context.carryEffort('off','p/plain'),'off');assert.equal(context.carryEffort('off','p/unknown'),'off');
 assert.equal(context.carryEffort('high','p/listed'),'high');assert.equal(context.carryEffort('medium','p/listed'),'');
 assert.equal(context.carryEffort('medium','p/ext'),'medium');assert.equal(context.carryEffort('','p/listed'),'');
});

test('H2: a failed OFF preview unlocks editing, a pending one refuses index edits without mutating',()=>{
 const profile={modelRoles:{composer:'p/a'},retry:{fallbackChains:{}},task:{agentModelOverrides:{}}};
 let plan={pending:true};
 const context=chainContext({p:()=>profile,state:{profile:'standard'},modeOff:()=>true,diff:()=>[{}],activePlan:()=>plan},['projectionPending','pickerActionsPending']);
 delete context.projectionPending;runInNewContext(['projectionPending','pickerActionsPending'].map(appFunction).join('\n'),context);
 assert.equal(context.projectionPending(),true);
 assert.equal(context.setChain('composer',['p/a','p/b']),false);assert.deepEqual(profile.retry.fallbackChains,{});assert.match(context.notices.at(-1),/розраховується/);
 context.state.picker={group:'role'};assert.equal(context.pickerActionsPending(),true);
 plan={error:'422'};assert.equal(context.projectionPending(),false,'an error never leaves the tape locked');assert.equal(context.pickerActionsPending(),false);
 assert.equal(context.setChain('composer',['p/a','p/b']),true);assert.deepEqual(Array.from(profile.retry.fallbackChains.composer),['p/b']);
 plan=null;assert.equal(context.projectionPending(),true,'an edit before its preview starts still waits');
 context.diff=()=>[];assert.equal(context.projectionPending(),false);
});

test('M9: the DeepSeek replacement list rejects paid DeepSeek in either mode',()=>{
 const settings={alternatives:['p/a'],overrides:{}},context=chainContext({p:()=>({}),modeSettings:()=>settings});
 assert.equal(context.setChain('profile',['p/a','p/deepseek-v4'],'alternatives'),false);
 assert.deepEqual(settings.alternatives,['p/a']);assert.match(context.notices.at(-1),/без платного DeepSeek/);
 assert.equal(context.setChain('profile',['p/a','p/deepseek-free'],'alternatives'),true);
});

test('H1: a blur-time change with an unchanged query keeps the results under the pointer',()=>{
 const calls=[],state={picker:{query:'Research',limit:80},cutQuery:'Swift',catalogQuery:'Canvas',query:'x',analyze:'kept',page:2};
 const context={state,composing:false,refreshSearch:id=>calls.push(id)};
 runInNewContext(appFunction('searchInput'),context);
 for(const [id,value] of [['picker-search','Research'],['cut-query','Swift'],['catalog-query','Canvas'],['role-query','x']])context.searchInput({id,value},true);
 assert.deepEqual(calls,[]);assert.equal(state.picker.limit,80);assert.equal(state.analyze,'kept');assert.equal(state.page,2);
 context.searchInput({id:'cut-query',value:'Swift D'},true);assert.deepEqual(calls,['cut-query'],'a changed value still refreshes');
});

test('M7: availability refresh is not a profile change',()=>{
 const base={modelRoles:{},retry:{fallbackChains:{}},task:{agentModelOverrides:{}},forgeMode:{mode:'no-deepseek'}};
 const context={original:{standard:base},profiles:{standard:{...structuredClone(base),forgeRefresh:3}},renderCache:null,knownAgents:()=>[],
  state:{profile:'standard',modeRefresh:{}},source:{revisions:{standard:'r'}},modeSettings:()=>base.forgeMode,copy:structuredClone};
 runInNewContext(['workers','diff','modeBody','modeKey'].map(appFunction).join('\n'),context);
 assert.deepEqual(Array.from(context.diff('standard')),[]);
 const before=context.modeKey();context.state.modeRefresh.standard=1;assert.notEqual(context.modeKey(),before,'↻ asks for a new projection');
});

test('M8/M12: select options are escaped and the profile list keeps a stable order',()=>{
 const context={esc:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),catalogMap:new Map(),
  state:{profile:'long-tape'},profileKeys:['standard','long-tape','without-deepseek'],prettyProfile:s=>s==='standard'?'Standard':s};
 runInNewContext(['options','profileOptions'].map(appFunction).join('\n'),context);
 assert.doesNotMatch(context.options('x"><b>',''),/<b>/);
 assert.deepEqual([...context.profileOptions().matchAll(/value="([^"]+)"/g)].map(m=>m[1]),['standard','long-tape','without-deepseek']);
 assert.match(context.profileOptions(),/value="long-tape" selected/);
});

test('M10: an armed CUT is placed even after the drawer filters hide it',()=>{
 const committed=[],notices=[];
 const context={state:{profile:'standard',freeCuts:true,cutQuery:'nothing'},catalogMap:new Map([['p/swift',{provider:'p',available:true}],['p/gone',{provider:'p',available:true,status:'missing'}]]),
  source:{providers:[]},poolName:()=>undefined,routeWarning:r=>r==='p/gone',chain:()=>['p/old'],commitCut:(route,target)=>committed.push([route,target.expected]),notify:s=>notices.push(s)};
 runInNewContext(appFunction('placeCut'),context);
 context.placeCut('p/swift',{role:'curator',index:0,group:'role'});assert.deepEqual(committed,[['p/swift','p/old']]);
 context.placeCut('p/gone',{role:'curator',index:0,group:'role'});assert.equal(committed.length,1);assert.match(notices[0],/недоступний/);
});

test('M5/M6: focus returns to real controls after a re-render',()=>{
 const context={CSS:{escape:s=>s}};
 runInNewContext(appFunction('focusSelector'),context);
 const control=attrs=>({matches:()=>false,closest:()=>null,hasAttribute:key=>Object.hasOwn(attrs,key),getAttribute:key=>attrs[key]});
 assert.equal(context.focusSelector(control({'data-profile-mode':'no-deepseek'})),'[data-profile-mode]','the switch flips its value');
 assert.equal(context.focusSelector(control({'data-history-bin':'4'})),'[data-history-bin="4"]');
 assert.equal(context.focusSelector(control({'data-provider-toggle':'demo'})),'[data-provider-toggle="demo"]');
 assert.equal(context.focusSelector(control({'data-catalog-provider':'demo'})),'#catalog-provider');
 assert.equal(context.focusSelector(control({'data-action':'','data-agent-copy':'team'})),'[data-agent-copy="team"]','an empty data-action does not send focus to the first such key');
 const seen=[],button={getClientRects:()=>[1],focus:()=>seen.push('button')};
 const picker={win:{querySelectorAll:selector=>{seen.push(selector);return selector.startsWith('button[')?[button]:[{getClientRects:()=>[1],focus:()=>seen.push('div')},button];}},CSS:{escape:s=>s},chain:()=>[]};
 runInNewContext(appFunction('pickerFocus'),picker);
 assert.equal(picker.pickerFocus({role:'judge',index:0,group:'role'}),true);assert.equal(seen.at(-1),'button');assert.match(seen[0],/^button\[data-edit="judge"\]\[data-index="0"\]/);
});

test('L4/L5: @role:effort aliases resolve with their thinking and a route without provider stays whole',()=>{
 const context={poolName:()=>undefined,p:()=>({modelRoles:{default:'p/model:low'}})};
 runInNewContext(['split','aliasRole','resolveAlias'].map(appFunction).join('\n'),context);
 assert.equal(context.resolveAlias('@default:high'),'p/model:high');assert.equal(context.resolveAlias('@default'),'p/model:low');
 assert.equal(context.resolveAlias('@missing'),'@missing');assert.equal(context.aliasRole('@default:high'),'default');
 assert.deepEqual({...context.split('gpt-4o')},{raw:'gpt-4o',provider:'',id:'gpt-4o',effort:''});
 assert.deepEqual({...context.split('p/m:off')},{raw:'p/m',provider:'p',id:'m',effort:'off'});
});

test('L6: tariff ticks follow local hours in a half-hour time zone; the bars cover the axis and peak is not only a hue',()=>{
 const tz=process.env.TZ;process.env.TZ='Asia/Kolkata';
 try{
  const context={resetCountdown:()=> '↻ 1г',esc:s=>String(s),source:{tariff:{note:''}},Intl,Date};
  runInNewContext(appFunction('dateFormat')+'\n'+appFunction('tariffTimeline'),context);
  const html=context.tariffTimeline(Date.UTC(2026,9,12,13,40));   // 19:10 in Kolkata
  const ticks=[...html.matchAll(/<span style="left:[\d.]+%">(\d\d)<\/span>/g)].map(m=>m[1]);
  assert.equal(ticks[0],'12');assert.ok(ticks.every(t=>Number(t)%4===0),'ticks sit on whole local hours: '+ticks);
  assert.match(html,/зараз 19:10/);assert.match(html,/class="tariff"/);assert.doesNotMatch(html,/data-lcd-colour|colourControl/);
  const bars=[...html.matchAll(/<i class="([^"]*)" style="--l:([\d.e-]+)%;--w:([\d.e-]+)%"/g)].map(m=>[m[1],Number(m[2]),Number(m[3])]);
  assert.equal(bars[0][1],0);assert.ok(Math.abs(bars.reduce((n,r)=>n+r[2],0)-100)<.01,'bars cover the axis exactly');
  assert.ok(bars.some(b=>/\bpk\b/.test(b[0]))&&bars.some(b=>!/\bpk\b/.test(b[0])),'peak hours are their own (tall, hatched) bars');
  assert.ok(bars.filter(b=>/past/.test(b[0])).length>0,'past hours are dimmed');
 }finally{if(tz===undefined)delete process.env.TZ;else process.env.TZ=tz;}
});

test('L9: queued background work waits for the tab or the field instead of polling every 200 ms',()=>{
 const timers=[];
 const context={pendingModeResults:new Map(),pendingRender:true,backgroundRefreshPending:true,backgroundReloading:false,backgroundTimer:null,interactionBusy:()=>true,
  document:{hidden:true,activeElement:null},setTimeout:()=>timers.push(1),clearTimeout:()=>{},pollState:()=>{}};
 runInNewContext(appFunction('flushBackgroundWork'),context);
 context.flushBackgroundWork();assert.equal(timers.length,0,'hidden tab');
 context.document={hidden:false,activeElement:{matches:s=>s==='input,textarea'}};context.flushBackgroundWork();assert.equal(timers.length,0,'typing');
 context.document={hidden:false,activeElement:{matches:()=>false}};context.flushBackgroundWork();assert.equal(timers.length,1,'other busy states still retry');
});

test('BUG1-1: the default CUTS height is not frozen from the first window that opened the drawer',()=>{
 const h=drawerHarness(null,{innerHeight:500});
 assert.equal(h.attrs['aria-valuenow'],215,'a small window shows a smaller default');
 h.context.storeOperator();
 assert.ok(!Number.isFinite(h.stored.at(-1).drawerHeight),'an untouched default must not be persisted as a user choice');
 h.context.window.innerHeight=1080;h.context.resizeDrawer(h.state.drawerHeight);
 assert.equal(h.attrs['aria-valuenow'],290,'a larger window gets the normal default again');
});

test('BUG1-5: the drawer follows the body, not the scrollbar-inclusive innerWidth; a phone gets 8px edges',()=>{
 const h=drawerHarness(300,{innerWidth:1280,scrollbar:15});
 assert.equal(h.port.style.left,'34px');assert.equal(h.port.style.width,'1212px');
 const phone=drawerHarness(300,{innerWidth:390,scrollbar:0});
 assert.equal(phone.port.style.left,'8px');assert.equal(phone.port.style.width,'374px');
});

test('BUG1-2/4/6: the drawer leaves ≈220px of page, scrolling keeps targets above it, and a closed drawer leaves its lip',()=>{
 const h=drawerHarness(2000,{innerHeight:900});
 assert.equal(h.attrs['aria-valuemax'],680,'the page above the drawer stays visible');assert.equal(h.attrs['aria-valuenow'],680);
 h.events.keydown({key:'Home',target:h.grip,preventDefault:()=>{}});assert.equal(h.attrs['aria-valuenow'],180);
 h.events.keydown({key:'End',target:h.grip,preventDefault:()=>{}});assert.equal(h.attrs['aria-valuenow'],680);
 assert.equal(h.page['scroll-padding-bottom'],(680+12)+'px');assert.equal(h.spacer.style.height,(680+28)+'px');
 h.state.cuts=false;h.context.resizeDrawer(h.state.drawerHeight);
 assert.equal(h.spacer.style.height,(46+28)+'px','closed: the spacer keeps room for the lip with the transport');assert.equal(h.page['scroll-padding-bottom'],(46+12)+'px');
 const phone=drawerHarness(300,{lip:92,open:false});assert.equal(phone.spacer.style.height,(92+28)+'px','a phone lip has two rows');
 h.context.win.querySelector=()=>null;h.context.resizeDrawer(300);assert.equal(h.page['scroll-padding-bottom'],undefined,'no drawer leaves no padding');
});

// A minimal DOM for the region engine: comments, elements, attributes, fragments and <template> parsing.
function fakeDocument(){
 const doc={activeElement:null};
 class FakeNode{
  constructor(nodeType){this.nodeType=nodeType;this.parentNode=null;this.childNodes=[];}
  get firstChild(){return this.childNodes[0]||null;}
  get nextSibling(){const s=this.parentNode?.childNodes;return s?s[s.indexOf(this)+1]||null:null;}
  get isConnected(){let n=this;while(n.parentNode)n=n.parentNode;return n===doc.body;}
  get firstElementChild(){return this.childNodes.find(n=>n.nodeType===1)||null;}
  remove(){if(!this.parentNode)return;const s=this.parentNode.childNodes;s.splice(s.indexOf(this),1);this.parentNode=null;if(doc.activeElement&&!doc.activeElement.isConnected)doc.activeElement=doc.body;}
  insertBefore(node,ref){
   if(node.nodeType===11){for(const c of [...node.childNodes])this.insertBefore(c,ref);return node;}
   node.remove();node.parentNode=this;const at=ref?this.childNodes.indexOf(ref):this.childNodes.length;this.childNodes.splice(at,0,node);return node;
  }
  replaceChildren(...nodes){for(const c of [...this.childNodes])c.remove();for(const n of nodes)this.insertBefore(n,null);}
 }
 class FakeElement extends FakeNode{
  constructor(tag){super(1);this.tagName=tag.toUpperCase();this.attrs=new Map();}
  get attributes(){return [...this.attrs].map(([name,value])=>({name,value}));}
  getAttribute(name){return this.attrs.has(name)?this.attrs.get(name):null;}
  setAttribute(name,value){this.attrs.set(name,String(value));}
  removeAttribute(name){this.attrs.delete(name);}
  focus(){doc.activeElement=this;}
  set innerHTML(html){this.content=parse(html);}
 }
 const comment=data=>Object.assign(new FakeNode(8),{data}),text=data=>Object.assign(new FakeNode(3),{data});
 function parse(html){
  const root=new FakeNode(11),stack=[root],voids=new Set(['input','br','img']);
  for(const m of html.matchAll(/<!--([\s\S]*?)-->|<\/([a-z0-9-]+)>|<([a-z0-9-]+)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*>|([^<]+)/gi)){
   const top=stack.at(-1);
   if(m[1]!==undefined)top.insertBefore(comment(m[1]),null);
   else if(m[2])stack.pop();
   else if(m[3]){const el=new FakeElement(m[3]);for(const a of m[4].matchAll(/([^\s=>]+)(?:="([^"]*)")?/g))el.setAttribute(a[1],a[2]??'');top.insertBefore(el,null);if(!voids.has(m[3].toLowerCase()))stack.push(el);}
   else top.insertBefore(text(m[5]),null);
  }
  return root;
 }
 doc.body=new FakeElement('body');doc.activeElement=doc.body;
 doc.createElement=tag=>new FakeElement(tag);
 return doc;
}
function regionHost(){
 const doc=fakeDocument(),host=doc.createElement('div');doc.body.insertBefore(host,null);
 const context={document:doc};runInNewContext(appFunction('leaf')+'\n'+appFunction('box')+'\n'+appFunction('createRegions'),context);
 const elements=node=>node.childNodes.filter(n=>n.nodeType===1);
 return {doc,host,context,regions:context.createRegions(host,doc),elements,find:(node,tag)=>{const out=[];const walk=n=>{for(const c of n.childNodes){if(c.nodeType===1&&c.tagName===tag.toUpperCase())out.push(c);walk(c);}};walk(node);return out;}};
}

test('region diff keeps unchanged regions and replaces only the changed leaf',()=>{
 const {host,context:{leaf,box},regions,elements,find}=regionHost();
 const tree=rows=>[leaf('top','<header class="top">T</header>'),box('lanes','<div class="graph">',rows.map(([key,value])=>leaf('row:'+key,`<div class="row">${value}</div>`))),leaf('toast','')];
 const first=regions.render(tree([['a','1'],['b','2'],['c','3']]));
 assert.ok(first.all,'the first render mounts the whole window');
 const [header,graph]=elements(host),[a,b,c]=elements(graph);
 const out=regions.render(tree([['a','1'],['b','changed'],['c','3']]));
 assert.ok(!out.all);assert.deepEqual([...out.replaced],['row:b']);
 assert.equal(elements(host)[0],header,'an unchanged region keeps its element');
 assert.equal(elements(host)[1],graph,'a container with the same child keys is kept');
 const [a2,b2,c2]=elements(graph);
 assert.equal(a2,a);assert.equal(c2,c);assert.notEqual(b2,b);assert.equal(b2.childNodes[0].data,'changed');
 assert.equal(find(host,'div').filter(el=>el.getAttribute('class')==='row').length,3,'no duplicates or leftovers');
 const again=regions.render(tree([['a','1'],['b','changed'],['c','3']]));
 assert.equal(again.inserted.length+again.morphed.length,0,'an identical render does no DOM work');
});

test('region diff keeps focus in a kept input and only patches a container opening tag',()=>{
 const {doc,host,context:{leaf,box},regions,elements}=regionHost();
 const tree=(pending,query)=>[box('desk',`<div class="desktop-graph ${pending?'mode-pending':''}" ${pending?'aria-busy="true"':''}>`,[leaf('search',`<label><input id="q" value="${query}"></label>`),leaf('row','<div class="row">x</div>')])];
 regions.render(tree(false,''));
 const desk=elements(host)[0],input=elements(elements(desk)[0])[0];
 input.focus();desk.setAttribute('style','--clip-width: 99px');
 // The user typed; the live input already shows it, so the leaf is adopted, not rebuilt.
 regions.adopt(leaf('search','<label><input id="q" value="ab"></label>'));
 const out=regions.render(tree(true,'ab'));
 assert.deepEqual([...out.replaced],['desk']);assert.equal(out.morphed.length,1);assert.equal(out.morphed[0],desk);assert.equal(out.inserted.length,0);
 assert.equal(elements(host)[0],desk);assert.equal(desk.getAttribute('class'),'desktop-graph mode-pending');assert.equal(desk.getAttribute('aria-busy'),'true');
 assert.equal(desk.getAttribute('style'),'--clip-width: 99px','attributes owned by script stay untouched');
 assert.equal(doc.activeElement,input,'focus, selection and IME stay in the kept input');assert.ok(input.isConnected);
 regions.render(tree(false,'ab'));assert.equal(desk.getAttribute('aria-busy'),null);
});

test('region diff rebuilds a container when its children change and supports partial updates',()=>{
 const {host,context:{leaf,box},regions,elements}=regionHost();
 const tree=keys=>[box('list','<ul class="l">',keys.map(k=>leaf('i:'+k,`<li>${k}</li>`))),leaf('toast','<p>hi</p>')];
 regions.render(tree(['a','b']));const list=elements(host)[0];
 const out=regions.render(tree(['a','b','c']));
 assert.deepEqual([...out.replaced],['list']);assert.notEqual(elements(host)[0],list);assert.equal(elements(elements(host)[0]).length,3);
 const toast=elements(host)[1],update=regions.update(leaf('toast',''));
 assert.deepEqual([...update.replaced],['toast']);assert.ok(!toast.isConnected);assert.equal(elements(host).length,1);
 assert.equal(regions.update(leaf('missing','<p></p>')),null,'an unmounted region is not created by a partial update');
 regions.invalidate('i:a');const kept=elements(elements(host)[0]);
 regions.render(tree(['a','b','c']));
 const now=elements(elements(host)[0]);assert.notEqual(now[0],kept[0],'an invalidated region is rebuilt');assert.equal(now[1],kept[1]);
});

test('a replaced control gives focus back to its rebuilt twin; a kept one is left alone',()=>{
 let focused=null;
 const twin={getClientRects:()=>[1],disabled:false,matches:()=>true,focus(){focused=this;},setSelectionRange(...args){this.range=args;}};
 const hidden={getClientRects:()=>[],disabled:false,matches:()=>true,focus(){focused=this;}};
 const context={win:{querySelectorAll:selector=>selector==='#q'?[hidden,twin]:[]}};
 runInNewContext(appFunction('restoreFocus'),context);
 context.restoreFocus({selector:'#q',focused:{isConnected:true},selection:[1,2,'none']});
 assert.equal(focused,null,'the focused control survived the patch');
 context.restoreFocus({selector:'#q',focused:{isConnected:false},selection:[1,2,'none']});
 assert.equal(focused,twin);assert.deepEqual(twin.range,[1,2,'none']);
});

test('an unchanged poll is revalidated with the ETag and a 304 does no work',async()=>{
 let request;
 const snapshot={base:{},insights:{usage:{reports:[]}}};
 const context={backgroundReloading:false,writeEpoch:0,stateTag:'W/"tag"',source:snapshot,state:{offline:false},renderedAt:Date.now(),pendingRender:false,
  endpoint:x=>x,interactionBusy:()=>false,fetch:async(url,options)=>{request=options;return {status:304,ok:false};},
  render:()=>assert.fail('a 304 must not render'),scheduleBackgroundWork:()=>assert.fail('a 304 must not queue a render'),json:()=>assert.fail('no body')};
 runInNewContext(appFunction('reload'),context);
 await context.reload(false,false,true);
 assert.equal(request.headers['If-None-Match'],'W/"tag"');assert.equal(request.cache,'no-store');
 assert.equal(context.source,snapshot);assert.equal(context.pendingRender,false);assert.equal(context.backgroundReloading,false);
 context.state.offline=true;context.scheduleBackgroundWork=()=>{};await context.reload(false,false,true);
 assert.equal(context.state.offline,false);assert.equal(context.pendingRender,true,'coming back online repaints once');
});

test('a CUTS search keystroke filters the cached collection instead of the whole catalogue',()=>{
 let scanned=0;
 const catalog=Array.from({length:40},(_,i)=>({provider:'p',id:'m'+i,name:(i%2?'Alpha ':'Beta ')+i,available:true}));
 const state={profile:'one',cutTarget:null,cutProvider:'all',freeCuts:false,cutHealth:'all',cutQuery:'alp'};
 const context={state,catalog,dataVersion:1,opReportCache:[],source:{providers:[]},p:()=>({}),providerName:id=>id,searchMemo:new WeakMap(),
  routeWarning:()=>{scanned++;return false;},priceInfo:()=>({kind:'paid'}),opHealth:()=>({kind:'healthy'}),acceptsRoleModel:()=>true,vibeAlias:()=>'',editorTarget:()=>null,collate:(a,b)=>a.localeCompare(b)};
 runInNewContext(['searchText','queryWords','matchesWords','searchKey','collectionBase','collectionCuts'].map(appFunction).join('\n'),context);
 assert.equal(context.collectionCuts().length,20);assert.equal(scanned,40);
 for(const q of ['alph','alpha 1','beta','']){state.cutQuery=q;context.collectionCuts();}
 assert.equal(scanned,40,'typing does not re-run the collection filters');
 assert.deepEqual(Array.from(context.collectionCuts().slice(0,2),m=>m.name),['Alpha 1','Alpha 11'],'the cached order is the collation order');
 state.freeCuts=true;context.priceInfo=()=>({kind:'free'});context.collectionCuts();assert.equal(scanned,80,'a filter change rebuilds it once');
});

// Device templates (stage C1a): fold, leader, transport on the drawer front, attribute-only switches, name tails.
const flat=r=>r.children?r.open+r.children.map(flat).join('')+'</'+/^<([a-z0-9-]+)/i.exec(r.open)[1]+'>':r.html;
function laneContext(chains,open=[]){
 const context={roleKeys:Object.keys(chains),labels:{},state:{profile:'standard',role:'default'},source:{presets:{}},esc:s=>String(s),openFolds:new Set(open),
  chain:r=>chains[r]||[],modeTag:()=>'',node:(role,r,i)=>`<div class="cut" data-node-role="${role}" data-index="${i}"></div>`,agentKey:()=>'',agentListNote:()=>'',agentInfo:()=>null,agentRemove:()=>''};
 runInNewContext(['led','socketKey','laneKey','graphRow','laneGroups','foldOf','laneGraph','leaf','box'].map(appFunction).join('\n'),context);
 return context;
}

test('an unconfigured role is leader tape with a socket, never a CUT',()=>{
 const context=laneContext({default:[],slow:[],composer:['p/a']});
 const leader=context.graphRow('slow',1);
 assert.match(leader,/class="lane lane--inherit"/);assert.match(leader,/<div class="leader"[^>]*><b>Типово в OMP<\/b>/);
 assert.match(leader,/class="socket" data-edit="slow" data-index="0" data-group="role"/);assert.match(leader,/основна<\/button>/);
 assert.doesNotMatch(leader,/class="cut/);assert.match(leader,/class="led" data-c="green"/,'LED off: OMP default');
 const own=context.graphRow('composer',2);
 assert.match(own,/class="cut" data-node-role="composer" data-index="0"/);assert.match(own,/data-edit="composer" data-index="1" data-group="role"[^>]*>.*резерв<\/button>/);
 assert.match(own,/class="led is-on" data-c="green"/,'LED on: own CUTS');
});

test('a run of three or more inherited lanes folds into one printed row; default and short runs never fold',()=>{
 let context=laneContext({default:[],smol:[],slow:[],vision:[],plan:[],composer:['p/a'],tiny:[],task:[],judge:['p/b']});
 assert.deepEqual(JSON.parse(JSON.stringify(context.laneGroups())),[{role:'default'},{fold:['smol','slow','vision','plan']},{role:'composer'},{role:'tiny'},{role:'task'},{role:'judge'}]);
 assert.equal(context.foldOf('vision'),'smol');assert.equal(context.foldOf('tiny'),'');
 let tree=context.laneGraph(),keys=Array.from(tree.children,c=>c.key);
 assert.deepEqual(keys,['p/row:default','p/fold:smol','p/foldlanes:smol','p/row:composer','p/row:tiny','p/row:task','p/row:judge']);
 const row=tree.children[1].html,lanes=tree.children[2];
 assert.match(row,/data-fold-toggle="smol" aria-expanded="false"/);assert.match(row,/02–05/);assert.match(row,/Показати <span class="rd"[^>]*>4<\/span>/);assert.match(row,/smol · slow · vision · plan/);
 assert.match(lanes.open,/class="fold__lanes" id="fold-smol"/);assert.deepEqual(Array.from(lanes.children,c=>c.key),['p/row:smol','p/row:slow','p/row:vision','p/row:plan'],'folded lanes stay real lanes (sockets, focus)');
 context=laneContext({default:[],smol:[],slow:[],vision:[],composer:['p/a']},['smol']);
 tree=context.laneGraph();
 assert.match(tree.children[2].open,/fold__lanes is-open/,'an opened fold is remembered');assert.match(tree.children[1].html,/aria-expanded="true"/);assert.match(tree.children[1].html,/Сховати/);
});

test('the transport lives on the drawer front only, with its scope; the dock has no Undo, Redo or Save',()=>{
 const SVG={undo:'',redo:'',close:'',more:'',search:'',refresh:''};
 const state={view:'profiles',profile:'standard',changes:3,saving:false,poolPanel:false,modePanel:false,cuts:false,health:true,cutProvider:'all',cutHealth:'all',freeCuts:false,cutQuery:'',opFeedback:'',error:''};
 const context={SVG,state,GRIP:'<div class="tray__grip"></div>',esc:s=>String(s??''),prettyProfile:s=>s==='standard'?'Standard':s,source:{projects:[{id:'x',name:'X'}],projectId:'x',modeConflicts:[],modeRecovery:null},profileKeys:['standard'],
  editHistory:{available:()=>({undo:true,redo:false})},poolsDirty:()=>false,activePlan:()=>null,collectionCuts:()=>[1,2],opProviderItems:()=>[['all','Усі']],healthNames:{healthy:'Є запас'},
  narrowSurface:()=>false,drawerOpenShown:false,drawerClosing:0,drawerLastMode:'cuts',poolNames:{'free-good':'FREE GOOD','free-fast':'FREE FAST'},poolDraft:{'free-good':['p/a','p/b'],'free-fast':[]},poolName:()=>undefined,cutTitle:r=>r,providerName:r=>r,split:r=>({provider:r}),drawerResults:()=>'<div class="tray__grid"></div>',
  node:(role,r,i)=>`<div class="cut" data-node-role="${role}" data-index="${i}" data-group="pool"></div>`};
 runInNewContext(['led','key','leaf','box','selWin','opSwitchKey','opSwitchFace','switchRegion','poolActionContext','transportParts','drawerMode','drawerShown','drawerFilters','editorKind','editorTarget','editorTitle','editorTabs','sourceHead','editorLine','socketKey','poolEditor','trayOpen','drawerHint','armedMarkup','drawerSearch','drawerCount','cutsTray','profileMenu','dockSwitches','operatorFeedback','operatorDock'].map(appFunction).join('\n'),context);
 const tray=flat(context.cutsTray()),dock=flat(context.operatorDock());
 assert.match(tray,/class="tray__lip"[\s\S]*class="tray__transport transport"[\s\S]*data-action="undo"[\s\S]*data-action="redo"[\s\S]*class="transport__state"[\s\S]*class="key key--action" data-action="save"/);
 assert.match(tray,/3 зміни/);assert.match(tray,/data-action="redo"[^>]*disabled/);
 assert.doesNotMatch(dock,/data-action="(undo|redo|save|pool-save)"/,'no transport on the dock');
 context.state.poolPanel=true;context.poolsDirty=()=>true;
 const pools=flat(context.cutsTray());
 assert.match(pools,/class="transport__scope">пули</);assert.match(pools,/data-action="pool-undo"/);assert.match(pools,/data-action="pool-save"/);
 assert.match(tray,/<section class="tray" id="cuts-collection"/,'a closed drawer still shows its lip');
 // The pool editor is a face of the drawer: orange head, FREE GOOD / FREE FAST tabs, ×, the ordered list next to its source.
 assert.match(pools,/<section class="tray is-open tray--editor" id="cuts-collection" aria-label="Пули">/);
 assert.match(pools,/role="tablist"[\s\S]*role="tab" id="pool-tab-free-good" data-pool-tab="free-good" aria-selected="true"/);
 assert.match(pools,/data-action="pool-close"/);assert.match(pools,/<span class="key__cap">Зберегти<span class="key__more"> пули<\/span><\/span>/);
 assert.match(pools,/id="pool-editor"[\s\S]*data-node-role="free-good" data-index="1"[\s\S]*class="socket" data-edit="free-good" data-index="2" data-group="pool"/);
 assert.match(pools,/class="tray__source"[\s\S]*id="cut-query"/,'the collection stays in the drawer as the source');
 assert.doesNotMatch(pools,/data-action="cuts-toggle"/,'the editor head is not the collection toggle');
 assert.match(flat(context.dockSwitches()),/data-op-switch="cuts" aria-expanded="true"/,'the CUTS key shows the drawer as open');
});

test('reopen patches only a container opening tag: HEALTH or search never rebuild the tape',()=>{
 const {host,context:{leaf,box},regions,find}=regionHost();
 const deck=open=>[box('deck',open,[leaf('row:a','<div class="lane">A</div>'),leaf('row:b','<div class="lane">B</div>')])];
 regions.render(deck('<section class="deck">'));
 const lanes=find(host,'div'),section=find(host,'section')[0];
 const out=regions.reopen('deck','<section class="deck health-off">');
 assert.equal(section.getAttribute('class'),'deck health-off');assert.equal(out.inserted.length,0);
 assert.deepEqual(find(host,'div'),lanes,'children are untouched');
 regions.render(deck('<section class="deck health-off">'));assert.deepEqual(find(host,'div'),lanes,'a later render agrees with the reopened tag');
 assert.equal(regions.reopen('missing','<div>'),null);
});

test('CUT names keep their distinguishing tail when they are truncated',()=>{
 const context={};runInNewContext(appFunction('nameParts'),context);
 const parts=n=>Array.from(context.nameParts(n));
 assert.deepEqual(parts('DEMO · Aurora 01 Free'),['DEMO · Aurora',' 01 Free']);
 assert.deepEqual(parts('Qwen3 Coder 480B'),['Qwen3 Coder',' 480B']);
 assert.deepEqual(parts('deepseek-demo-free'),['deepseek-demo','-free']);
 assert.deepEqual(parts('editor-long-context-multilingual-edition'),['editor-long-context-multilingual-edition','']);
 assert.deepEqual(parts('GPT 5'),['GPT',' 5']);
});

// Stage C1b: names that tell routes apart, editors and forms in the drawer, the collection as the editor's source,
// Колекція's cached sort, the provider form's own field checks, «Прийняти файл» in the reel menu.
test('a shortened CUT name gives up the shared namespace first, never the family that tells routes apart',()=>{
 const context={esc:s=>String(s)};runInNewContext(['nameParts','nameSpace'].map(appFunction).join('\n')+'\n'+source.match(/\n (const nameMarkup=[^\n]*)/)[1]+'\nthis.nameMarkup=nameMarkup;',context);
 assert.deepEqual(Array.from(context.nameSpace('DEMO · Aurora')),['DEMO ·','Aurora']);
 assert.deepEqual(Array.from(context.nameSpace('qwen/qwen3-coder')),['qwen/','qwen3-coder']);
 assert.deepEqual(Array.from(context.nameSpace('Anthropic: Claude Sonnet')),['Anthropic:','Claude Sonnet']);
 assert.deepEqual(Array.from(context.nameSpace('deepseek-demo')),['','deepseek-demo'],'no separator, no namespace');
 assert.deepEqual(Array.from(context.nameSpace('DEMO · ab')),['','DEMO · ab'],'a too short family keeps the whole head');
 const aurora=context.nameMarkup('DEMO · Aurora 01 Free'),swift=context.nameMarkup('DEMO · Swift 01 Free');
 assert.equal(aurora,'<span class="cut__ns">DEMO ·</span><span class="cut__head">Aurora</span><span class="cut__tail"> 01 Free</span>');
 assert.match(swift,/<span class="cut__head">Swift<\/span><span class="cut__tail"> 01 Free<\/span>/);
 const css=readFileSync(require.resolve('./static/device.css'),'utf8');
 const ns=css.match(/\.cut__ns\{flex:0 (\d+) auto/),head=css.match(/\.cut__head\{flex:0 (\d+) auto\}/);
 assert.ok(ns&&head&&Number(ns[1])>=1e5*Number(head[1]),'the namespace shrinks first; the family keeps less than one layout unit of the shrink');
 assert.match(css,/\.cut__tail\{flex:none/,'the distinguishing tail never shrinks');
});

test('an open editor narrows the collection to what its list accepts; a tap appends, a duplicate is refused',()=>{
 const models=[{provider:'p',id:'free-a',name:'Free A',available:true,free:true},{provider:'p',id:'paid-b',name:'Paid B',available:true},{provider:'deepseek',id:'deepseek-v4',name:'DS',available:true}];
 const state={profile:'one',cutTarget:null,cutProvider:'all',freeCuts:false,cutHealth:'all',cutQuery:'',poolPanel:false,modePanel:false};
 const context={state,catalog:models,dataVersion:1,opReportCache:[],source:{providers:[]},p:()=>({}),providerName:id=>id,searchMemo:new WeakMap(),poolNames:{'free-good':'FREE GOOD'},
  routeWarning:()=>false,priceInfo:m=>({kind:m.free?'free':'paid'}),opHealth:()=>({kind:'healthy'}),acceptsRoleModel:()=>true,vibeAlias:()=>'',collate:(a,b)=>a.localeCompare(b),
  ManaOperator:{isFreeModel:m=>!!m.free},deepseek:r=>/deepseek/.test(r)};
 runInNewContext(['searchText','queryWords','matchesWords','searchKey','editorKind','editorTarget','collectionBase','collectionCuts'].map(appFunction).join('\n'),context);
 assert.equal(context.collectionCuts().length,3);
 state.poolPanel=true;assert.deepEqual(Array.from(context.collectionCuts(),m=>m.id),['free-a'],'a pool takes FREE CUTS only');
 state.poolPanel=false;state.modePanel=true;assert.deepEqual(Array.from(context.collectionCuts(),m=>m.id).sort(),['free-a','paid-b'],'replacements never offer paid DeepSeek');
 // appendToEditor: end of the open list, one step; a duplicate only says so.
 const pool={'free-good':['p/x']},calls=[];
 Object.assign(context,{state:{poolPanel:true,poolTab:'free-good',saving:false},chain:role=>[...pool[role]],split:r=>({raw:r}),cutTitle:r=>r,catalogMap:new Map([['p/free-a',{}],['p/x',{}]]),notify:s=>calls.push(s),
  setChain:(role,list)=>{pool[role]=list;return true;},render:()=>{},paintRegions:()=>{},leaf:(key,html)=>({key,html}),poolEditor:()=>'',modePanel:()=>'',win:{querySelector:()=>null}});
 runInNewContext(appFunction('appendToEditor'),context);
 context.appendToEditor('p/free-a');assert.deepEqual(Array.from(pool['free-good']),['p/x','p/free-a']);assert.match(context.state.editorMsg,/Додано · p\/free-a → FREE GOOD · 02/);
 context.appendToEditor('p/x');assert.deepEqual(Array.from(pool['free-good']),['p/x','p/free-a'],'a CUT already in the list is not added twice');assert.match(context.state.editorMsg,/Уже в списку/);
});

test('a form opens in the drawer: a dialog with the body inert, the transport kept but out of reach',()=>{
 const SVG={undo:'',redo:'',close:'×',more:'',search:''};
 const state={view:'profiles',profile:'standard',changes:0,saving:false,modal:'delete-profile',cuts:false,health:true,cutProvider:'all',cutHealth:'all',freeCuts:false,cutQuery:''};
 const context={SVG,state,GRIP:'',esc:s=>String(s??''),prettyProfile:s=>s,source:{modeConflicts:[],restorable:[]},editHistory:{available:()=>({undo:false,redo:false})},poolsDirty:()=>false,activePlan:()=>null,diff:()=>[],
  narrowSurface:()=>false,drawerOpenShown:false,drawerClosing:0,drawerLastMode:'cuts',poolNames:{},poolName:()=>undefined};
 runInNewContext(['led','key','leaf','box','poolActionContext','transportParts','drawerMode','drawerShown','trayOpen','formFoot','formSpec','formTitle','formMarkup','cutsTray'].map(appFunction).join('\n'),context);
 const tray=flat(context.cutsTray());
 assert.match(tray,/<section class="tray is-open tray--editor tray--form" id="cuts-collection" role="dialog" aria-modal="true" aria-labelledby="tray-form-title">/);
 assert.match(tray,/id="tray-form-title"[\s\S]*Видалити котушку/);
 assert.match(tray,/class="tray__transport transport"[^>]*inert/,'the transport stays on the front but cannot be reached');
 assert.match(tray,/data-action="modal-close"[\s\S]*data-action="delete-confirm"/,'a safe key first, the action last');
 assert.doesNotMatch(tray,/modal-layer|backdrop/);
 state.modal='confirm';state.confirm={title:'Прийняти файл',label:'Прийняти файл як є',text:'<b>x</b>',action:'adopt-profile'};
 assert.match(flat(context.cutsTray()),/data-action="confirm-cancel"[\s\S]*data-action="confirm-run"/);
});

test('the provider form checks its fields itself and names the field a server refusal belongs to',()=>{
 const context={state:{editProvider:null},source:{providers:[]},URL};
 runInNewContext(['providerProblems','providerField'].map(appFunction).join('\n'),context);
 const form=values=>({elements:Object.fromEntries(Object.entries({name:'',id:'',url:'',auth:'apiKey',key:'',discovery:'openai-models-list',models:'',...values}).map(([k,v])=>[k,{value:v}]))});
 assert.deepEqual(Object.keys(context.providerProblems(form({}))).sort(),['id','key','name','url']);
 assert.deepEqual(Object.keys(context.providerProblems(form({name:'Мій',id:'my-p',url:'https://api.example.com/v1',key:'k'}))),[]);
 assert.ok(context.providerProblems(form({name:'x',id:'Bad ID',url:'https://a.b',key:'k'})).id);
 assert.ok(context.providerProblems(form({name:'x',id:'a',url:'https://u:p@a.b/v1',key:'k'})).url,'no credentials in the address');
 assert.ok(context.providerProblems(form({name:'x',id:'a',url:'https://a.b?k=1',key:'k'})).url,'no parameters in the address');
 assert.ok(context.providerProblems(form({name:'x',id:'a',url:'https://a.b',auth:'none',discovery:''})).models,'a manual list needs model IDs');
 context.state.editProvider='a';context.source.providers=[{id:'a',hasKey:true,url:'https://a.b'}];
 assert.equal(context.providerProblems(form({name:'x',id:'a',url:'https://a.b'})).key,undefined,'the stored key stays for the same address');
 assert.match(context.providerProblems(form({name:'x',id:'a',url:'https://c.d'})).key,/нової адреси/);
 assert.equal(context.providerField('ID: малі латинські літери, цифри, дефіс'),'id');assert.equal(context.providerField('Потрібна HTTP(S)-адреса без ключів'),'url');
 assert.equal(context.providerField('Потрібен API-ключ'),'key');assert.equal(context.providerField('Провайдери вже змінились. Онови дані.'),'');
});

test('Колекція sorts once per filter; a search keystroke only filters the sorted rows',()=>{
 let scored=0;
 const catalog=Array.from({length:60},(_,i)=>({provider:'p'+(i%3),id:'m'+i,name:(i%2?'Alpha ':'Beta ')+i}));
 const state={catalogMode:'all',catalogProvider:'all',catalogEvidence:'all',catalogSort:'score',role:'default',benchSource:'AA',benchRelease:'r',favs:[],catalogQuery:''};
 const context={state,catalog,dataVersion:1,referenced:new Set(),source:{changes:[]},searchMemo:new WeakMap(),providerName:id=>id,myProviderIds:()=>new Set(),
  opEvidence:m=>{scored++;return {score:Number(m.id.slice(1))};},opPriceValue:()=>1,evidenceCoverage:()=>({kind:'unknown',sources:[],claims:0}),priceInfo:()=>({kind:'paid'}),collate:(a,b)=>a.localeCompare(b)};
 runInNewContext(['searchText','queryWords','matchesWords','searchKey','catalogBase','analyticalModels'].map(appFunction).join('\n'),context);
 assert.equal(context.analyticalModels()[0].id,'m59','top role score first');assert.equal(scored,60);
 for(const q of ['a','al','alpha','alpha 5','']){state.catalogQuery=q;context.analyticalModels();}
 assert.equal(scored,60,'typing never re-scores or re-sorts');
 state.catalogQuery='alpha';assert.deepEqual(Array.from(context.analyticalModels().slice(0,2),m=>m.id),['m59','m57'],'filtered rows keep the sorted order');
 state.catalogSort='name';context.analyticalModels();assert.equal(scored,120,'a new order sorts once');
});

test('the reel menu offers «Прийняти файл» only for a profile changed outside Mana Tape',()=>{
 const state={profile:'long-tape',changes:0};
 const context={state,SVG:{more:''},esc:s=>String(s),prettyProfile:s=>s,source:{modeConflicts:['long-tape'],modeOrphans:[]}};
 runInNewContext(['led','profileMenu'].map(appFunction).join('\n'),context);
 assert.match(context.profileMenu(),/role="menuitem" data-action="adopt-profile" data-adopt="long-tape"[^>]*><span class="key__cap">[^<]*<span class="led is-on" data-c="amber"><\/span>Прийняти файл/);
 assert.match(context.profileMenu(),/aria-haspopup="menu"/);
 context.source.modeConflicts=[];assert.doesNotMatch(context.profileMenu(),/adopt-profile/);
 context.source.modeOrphans=['long-tape'];assert.match(context.profileMenu(),/Прийняти видалення/);
});

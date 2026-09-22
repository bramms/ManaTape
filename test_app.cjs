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
   backgroundReloading:false,backgroundRefreshPending:false,writeEpoch:0,
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
 runInNewContext(appFunction('api')+'\n'+appFunction('interactionBusy'),context);
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
 const context={backgroundReloading:false,writeEpoch:0,source:snapshot,state:{offline:false},renderedAt:Date.now(),
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
 const settings={overrides:{}},view=routes=>({views:{role:{writer:{routes,substituted:true}}}});
 let plan={data:view(['p/A','p/B','p/C'])};
 const context={state:{profile:'standard',picker:{role:'writer',group:'role',index:0}},
  modeOff:()=>true,diff:()=>[{}],activePlan:()=>plan,modeSettings:()=>settings,modeScope:()=> 'role:writer',
  focusPickerMove:()=>{},split:route=>({raw:route}),render:()=>{plan={pending:true,previous:plan.data};}};
 runInNewContext(['modeView','chain','setChain','pickerActionsPending','movePickerCut'].map(appFunction).join('\n'),context);
 context.movePickerCut(1);assert.deepEqual(Array.from(settings.overrides['role:writer']),['p/B','p/A','p/C']);
 context.movePickerCut(1);assert.deepEqual(Array.from(settings.overrides['role:writer']),['p/B','p/A','p/C'],'repeat while pending cannot read the old projection');
 assert.equal(context.state.picker.index,1);
 plan={data:view([...settings.overrides['role:writer']])};context.movePickerCut(1);
 assert.deepEqual(Array.from(settings.overrides['role:writer']),['p/B','p/C','p/A']);assert.equal(context.state.picker.index,2);
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
 const context={p:()=>profile,roleKeys:['reader'],esc:s=>s,tool:()=>'',poolName:r=>r==='mana-pool/free-fast'?'free-fast':undefined};
 runInNewContext(['agentValues','agentLink','agentTier','agentName','agentLinkedTrack'].map(appFunction).join('\n'),context);
 for(const worker of ['reviewer','scout'])for(const mobile of [false,true]){
  const html=context.agentLinkedTrack(worker,mobile);
  assert.match(html,/Успадковує @reader/);assert.match(html,/Основна й резерви ролі/);
  assert.match(html,/data-agent-role="reader"/);assert.doesNotMatch(html,/FREE FAST|data-edit=|16 CUTS/);
 }
 assert.equal(context.agentLink('task'),'');assert.match(context.agentName('task'),/Vibe GOOD/);
 assert.match(context.agentName('sonic'),/Vibe FAST/);assert.doesNotMatch(context.agentName('reviewer'),/Vibe/);
 const unknown=context.agentLinkedTrack('external');assert.match(unknown,/Модель і резерви визначає OMP/);assert.doesNotMatch(unknown,/data-agent-role=/);
 profile.retry.modelFallback=false;assert.match(context.agentLinkedTrack('scout'),/резерви вимкнено/);
});

test('editing a role copies only explicit agent tails and keeps singleton inheritance intact',()=>{
 const profile={modelRoles:{reader:'p/a'},retry:{fallbackChains:{reader:['p/b']}},task:{agentModelOverrides:{one:'@reader',two:['@reader'],custom:['@reader','p/c'],other:['p/x','p/y']}}};
 const context={p:()=>profile,state:{syncVibe:true},modeView:()=>null};
 runInNewContext(['workers','agentValues','agentLink','vibeAlias','oldSetChain','setChain'].map(appFunction).join('\n'),context);
 context.setChain('reader',['p/new','p/next']);
 assert.equal(profile.task.agentModelOverrides.one,'@reader');assert.deepEqual(profile.task.agentModelOverrides.two,['@reader']);
 assert.deepEqual(Array.from(profile.task.agentModelOverrides.custom),['@reader','p/next']);assert.deepEqual(profile.task.agentModelOverrides.other,['p/x','p/y']);
 context.state.syncVibe=false;context.setChain('reader',['p/later','p/last']);
 assert.deepEqual(Array.from(profile.task.agentModelOverrides.custom),['@reader','p/next']);
});

test('copying an inherited agent preserves normal routes and DeepSeek settings as one undoable edit',()=>{
 const {ForgeHistory}=require('./static/tape.js'),history=new ForgeHistory();
 const profile={modelRoles:{reader:'p/deepseek'},retry:{fallbackChains:{reader:['mana-pool/free-fast','p/extra']}},task:{agentModelOverrides:{custom:'@reader'}},forgeMode:{mode:'no-deepseek',overrides:{'role:reader':['p/replacement']}}};
 const baseline=structuredClone(profile),context={p:()=>profile,state:{poolPanel:true},roleKeys:['reader'],copy:structuredClone,CSS:{escape:s=>s},
  source:{freePools:{'free-fast':['p/free1','p/free2']}},poolName:r=>r==='mana-pool/free-fast'?'free-fast':undefined,
  modeOff:()=>true,modeView:()=>({}),diff:()=>[],chain:()=>['p/replacement','mana-pool/free-fast','p/extra'],modeSettings:()=>profile.forgeMode,render:()=>history.observe('one',profile,true,baseline),win:{querySelectorAll:()=>[]},scrollToControl:()=>{},notify:()=>assert.fail('valid conversion must work')};
 history.observe('one',profile,false);
 runInNewContext(['agentValues','agentLink','baseChain','copyAgentRole'].map(appFunction).join('\n'),context);
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
  runInNewContext(['agentValues','agentLink','baseChain','copyAgentRole'].map(appFunction).join('\n'),context);
  context.copyAgentRole('custom');assert.equal(JSON.stringify(profile),before);assert.equal(notices.length,1);
  assert.match(notices[0],long?/30 CUTS/:/default/);
 }
});

test('agent conversion waits for OFF preview and rejects an OFF singleton with default fallbacks',()=>{
 const profile={modelRoles:{reader:'p/a'},retry:{fallbackChains:{reader:['p/deepseek'],default:['p/default']}},task:{agentModelOverrides:{custom:'@reader'}}};
 let pending=true;const notices=[],before=JSON.stringify(profile),context={p:()=>profile,state:{profile:'one'},roleKeys:['reader'],modeOff:()=>true,
  modeView:()=>({}),diff:()=>[{}],activePlan:()=>pending?{pending:true}:{data:{}},chain:()=>['p/a'],poolName:()=>undefined,notify:s=>notices.push(s)};
 runInNewContext(['agentValues','agentLink','baseChain','copyAgentRole'].map(appFunction).join('\n'),context);
 context.copyAgentRole('custom');assert.match(notices.pop(),/Дочекайся/);
 pending=false;context.copyAgentRole('custom');assert.match(notices.pop(),/default/);assert.equal(JSON.stringify(profile),before);
});

test('quota display stays compact, keeps complete family labels and gives each account a stable LCD control',()=>{
 const ManaDisplay=require('./static/display.js');
 let reports=[{provider:'google-antigravity',account:4,limits:['Anthropic','Claude','Google','OpenAI'].map(label=>({label:label+' 7 day',window:'7 day',remaining:50}))},
  {provider:'commandcode',account:5,limits:[]},{provider:'google-antigravity',account:6,limits:[]}];
 const context={state:{meters:'full'},usageReports:()=>reports,providerName:id=>id,esc:String,ManaDisplay,
  op:{pace:()=>({kind:'unknown'})},timeLabel:()=>'',reportAge:()=>'',opPaceText:()=>'',opForecast:()=>'',resetTitle:()=>'',resetCountdown:()=>'',num:String};
 runInNewContext(appFunction('limitLabel')+'\n'+appFunction('opQuota'),context);
 assert.equal(context.limitLabel({label:'Claude & GPT shared · 7 day',window:'7 day'}),'Claude & GPT shared · 7 днів');
 const markup=context.opQuota();
 assert.match(markup,/class="meter-bridge micro"/);assert.doesNotMatch(markup,/scale-key|data-op-switch="meters"|\bFULL\b/);
 for(const family of ['Anthropic','Claude','Google','OpenAI'])assert.ok(markup.includes(`<span class="mw-label">${family} · 7 днів</span>`));
 const ids=html=>[...html.matchAll(/data-lcd-screen="([^"]+)"/g)].map(match=>match[1]);
 assert.deepEqual(ids(markup),['quota:google-antigravity:1','quota:commandcode:1','quota:google-antigravity:2']);
 for(const id of ids(markup))assert.ok(markup.includes(`data-lcd-colour="${id}"`),'each LCD has its own control');
 reports=[{provider:'other',account:1,limits:[]},...reports.map((report,i)=>({...report,account:i+2}))];
 assert.deepEqual(ids(context.opQuota()).filter(id=>!id.startsWith('quota:other:')),ids(markup),'an unrelated provider cannot change existing LCD preferences');
});

test('operator preferences no longer persist the removed meter scale',()=>{
 let saved;
 const context={state:{meters:'full',health:false,drawerHeight:280},localStorage:{setItem:(key,value)=>{assert.equal(key,'mana-operator');saved=JSON.parse(value);}}};
 runInNewContext(appFunction('storeOperator'),context);context.storeOperator();
 assert.deepEqual(saved,{health:false,drawerHeight:280});
});

test('rerender restores the same LCD dial rather than switching foreground to background',()=>{
 const context={CSS:{escape:s=>s}};
 runInNewContext(appFunction('focusSelector'),context);
 for(const part of ['background','foreground']){
  const attrs={'data-lcd-colour':'history','data-lcd-part':part};
  const control={matches:()=>false,closest:()=>null,hasAttribute:key=>Object.hasOwn(attrs,key),getAttribute:key=>attrs[key]};
  assert.equal(context.focusSelector(control),`[data-lcd-colour="history"][data-lcd-part="${part}"]`);
 }
});

function drawerHarness(preferred=500){
 const events={},properties={},attrs={},captures=new Set(),stored=[];
 const surface={left:34,right:1246,top:400},state={drawerHeight:preferred};
 const drawer={style:{},getBoundingClientRect:()=>({height:parseFloat(properties['--cuts-height'])}),querySelector:key=>({offsetHeight:key==='.drawer-head'?40:50})};
 const grip={id:'cuts-resize',parentElement:drawer,focus:()=>{},closest:()=>grip,setAttribute:(key,value)=>{attrs[key]=value;}};
 const context={state,root:{style:{setProperty:(key,value)=>{properties[key]=value;}},
  addEventListener:(key,handler)=>{events[key]=handler;},setPointerCapture:id=>captures.add(id),
  hasPointerCapture:id=>captures.has(id),releasePointerCapture:id=>captures.delete(id)},
  win:{querySelector:key=>key==='.cuts-drawer'?drawer:key==='#cuts-resize'?grip:{getBoundingClientRect:()=>surface}},
  window:{innerWidth:1280,innerHeight:900,addEventListener:()=>{}},getComputedStyle:()=>({bottom:'12px'}),
  render:()=>{},localStorage:{setItem:(_key,value)=>stored.push(JSON.parse(value))}};
 const start=source.indexOf(' let drawerGesture=null;'),end=source.indexOf('\n function placeCut(',start);
 runInNewContext(source.slice(start,end)+'\n'+appFunction('storeOperator'),context);
 context.resizeDrawer(state.drawerHeight);
 const event=(pointerId,clientY)=>({pointerId,clientY,button:0,target:grip,preventDefault:()=>{}});
 return {context,state,surface,drawer,grip,properties,attrs,stored,events,event};
}

test('CUTS keeps its chosen height across opening positions and temporary viewport limits',()=>{
 const h=drawerHarness();
 assert.equal(h.attrs['aria-valuenow'],500);assert.equal(h.drawer.style.left,'34px');assert.equal(h.drawer.style.right,'34px');
 h.surface.top=-1200;h.context.resizeDrawer(h.state.drawerHeight);
 assert.equal(h.attrs['aria-valuenow'],500,'page scroll must not affect drawer height');
 h.context.window.innerHeight=420;h.context.resizeDrawer(h.state.drawerHeight);
 assert.equal(h.attrs['aria-valuenow'],360);assert.equal(h.state.drawerHeight,500,'clamping is temporary');
 h.context.window.innerHeight=900;h.context.resizeDrawer(h.state.drawerHeight);
 assert.equal(h.attrs['aria-valuenow'],500);
});

test('CUTS resize starts at the visible edge, commits locally, and Escape restores the previous preference',()=>{
 const h=drawerHarness(800);h.context.window.innerHeight=500;h.context.resizeDrawer(h.state.drawerHeight);
 h.events.pointerdown(h.event(1,60));h.events.pointermove(h.event(1,100));
 assert.equal(h.attrs['aria-valuenow'],400,'drag must start from the clamped 440px edge, not the hidden 800px preference');
 h.events.pointerdown(h.event(2,100));h.events.pointermove(h.event(2,180));
 assert.equal(h.attrs['aria-valuenow'],400,'a second pointer must not replace the active resize');
 h.events.keydown({key:'Escape',preventDefault:()=>{}});
 assert.equal(h.state.drawerHeight,800);assert.equal(h.attrs['aria-valuenow'],440);assert.equal(h.stored.length,0);
 h.events.pointerdown(h.event(1,60));h.events.pointermove(h.event(1,100));h.events.pointerup(h.event(1,100));
 assert.equal(h.stored.at(-1).drawerHeight,400);
 h.events.keydown({key:'ArrowDown',target:h.grip,preventDefault:()=>{}});
 assert.equal(h.attrs['aria-valuenow'],368);assert.equal(h.stored.at(-1).drawerHeight,368);
});

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
  composing:false,pointerHeld:false,nativeSelectBusy:false,drag:null,encoderGesture:null,cutGesture:null,drawerGesture:null,
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
   composing:false,pointerHeld:surface==='toolbar',nativeSelectBusy:false,activeWrites:0,drag:null,encoderGesture:null,cutGesture:null,drawerGesture:null,
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

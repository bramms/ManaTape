const {test}=require('node:test');
const assert=require('node:assert/strict');
const op=require('./static/operator-core.js');
const now=Date.UTC(2026,8,19,12),report={at:now/1000,limits:[]};
test('CUT labels preserve Contributor, versions and namespaces when catalog names omit them',()=>{
 const cases=[
  ['big-pickle','[FREE] Big Pickle','[FREE] Big Pickle'],
  ['muse-spark-1.3-contributor-free','Muse Spark 1.3 (Free)','muse-spark-1.3-contributor-free'],
  ['muse-spark-1.3','Muse Spark','muse-spark-1.3'],
  ['lab/model-v2','Model v2','lab/model-v2'],
 ];
 for(const [id,name,expected] of cases)assert.equal(op.displayModelName(id,name),expected);
});
test('pace compares used share with elapsed share, not remaining share',()=>{
 const l={window:'7 days',remaining:80,resets:now+3.5*864e5};
 const q=op.pace(l,report,now);assert.equal(q.kind,'reserve');assert.equal(q.delta,-30);assert.equal(q.lasts,true);
 const d=op.pace({...l,remaining:20},report,now);assert.equal(d.kind,'deficit');assert.equal(d.lasts,false);assert.ok(d.eta>now&&d.eta<l.resets);
 assert.equal(op.pace({...l,remaining:50},report,now).kind,'balanced');
});
test('unknown, stale, reset and early windows never claim a reliable forecast',()=>{
 const l={window:'5 Hour',remaining:90,resets:now+9e6};
 for(const r of [{at:0},{at:now/1000-901},{...report,stale:true}])assert.equal(op.pace(l,r,now).kind,'unknown');
 for(const v of [{remaining:null},{resets:now-1},{resets:now+18e6},{window:'unknown',label:'unknown'}])assert.equal(op.pace({...l,...v},report,now).kind,'unknown');
});
test('month duration preserves calendar boundaries including leap February',()=>{
 const end=Date.UTC(2024,2,1),d=op.duration({window:'Monthly',resets:end});assert.equal(d.ms,29*864e5);assert.equal(d.estimated,true);
 assert.deepEqual(op.duration({windowMinutes:300}),{ms:18e6,estimated:false});
});
test('health applies Fable and provider-family scopes only to their models',()=>{
 const limits=[{remaining:70,resets:now+1e6,label:'Weekly'}, {remaining:0,resets:now+1e6,label:'7 Day (Fable)',tier:'fable'}];
 const rs=[{...report,provider:'anthropic',limits}];
 assert.equal(op.health({provider:'anthropic',id:'claude-fable-5-1'},rs,[],now).kind,'empty');
 assert.equal(op.health({provider:'anthropic',id:'claude-sonnet-4-6'},rs,[],now).kind,'healthy');
 assert.equal(op.applies({label:'Usage (Google)'},{id:'claude-fable-5-1'}),false);
 assert.equal(op.applies({label:'Usage (Google)'},{id:'gemini-3.8-flash'}),true);
});
test('partial measurements and stale zero distinguish unknown from exhausted',()=>{
 const m={provider:'p',id:'m'},limits=[{remaining:60},{remaining:null}];
 assert.equal(op.health(m,[{...report,provider:'p',limits}],[],now).kind,'unknown');
 assert.equal(op.health(m,[{...report,provider:'p',stale:true,limits:[{remaining:0}]}],[],now).kind,'unknown');
 assert.equal(op.health(m,[{...report,provider:'p',limits:[{remaining:0},{remaining:null}]}],[],now).kind,'empty');
});
test('role estimates require every weighted test, zero is a real score',()=>{
 assert.equal(op.score({scores:{a:80}},{a:.5,b:.5}),null);
 assert.equal(op.score({scores:{a:80,b:0}},{a:.5,b:.5}),40);
 assert.equal(op.score({scores:{a:80}},null),null);
});
test('model scope accepts exact and wildcard IDs without interpreting regexp',()=>{
 assert.equal(op.applies({models:['vendor/glm-5.*']},{id:'vendor/glm-5.3'}),true);
 assert.equal(op.applies({models:['a+b']},{id:'ab'}),false);
 assert.equal(op.applies({models:['a+b']},{id:'a+b'}),true);
});
test('free routes need their own quota and multiple accounts stay unassigned',()=>{
 const m={provider:'cc',id:'model:free',free:true},r={...report,provider:'cc',limits:[{remaining:0}]};
 assert.equal(op.health(m,[r],[],now).kind,'unknown');
 assert.equal(op.health(m,[{...r,limits:[{remaining:0,models:['model:free']}]}],[],now).kind,'empty');
 assert.equal(op.health({...m,free:false},[r,r],[],now).kind,'unknown');
});

test('local GPUs have a neutral non-subscription state, without claiming uptime',()=>{assert.equal(op.health({provider:'my-local',id:'local',local:true},[],[],now).kind,'local');assert.equal(op.health({provider:'my-local',id:'local',local:true},[],['my-local'],now).kind,'empty');});

test('catalog evidence reports the best complete measurement and its tested effort',()=>{
 const records=[{id:'m-low',effort:'low',scores:{a:50}},{id:'m-max',effort:'max',scores:{a:90}}],weights={a:1};
 const q=op.evidence(records,weights);assert.equal(q.score,90);assert.equal(q.record.effort,'max');
 assert.deepEqual(records.map(r=>r.id),['m-low','m-max']);
});
test('catalog evidence never invents missing or incomplete role measurements',()=>{
 assert.equal(op.evidence([], {a:1}),null);
 assert.equal(op.evidence([{effort:'max',scores:{a:90}}], {a:.5,b:.5}),null);
});

test('profile names accept readable input without accepting paths or silently removing punctuation',()=>{
 assert.deepEqual(op.profileName('  Standard  FreeTier  '),{name:'standard-freetier',error:''});
 for(const name of ['a','free-tier_2','a'.repeat(64)])assert.equal(op.profileName(name).error,'');
 for(const name of ['','   ','../escape','a/b','a.b','-name','_name','a'.repeat(65),null,123,'Мій профіль'])assert.ok(op.profileName(name).error);
});

test('FREE labels require explicit free identity and a known zero price including cache',()=>{
 const free={id:'demo:free',name:'Demo',cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
 assert.equal(op.isFreeModel(free),true);
 assert.equal(op.isFreeModel({...free,id:'demo',name:'Demo (free)'}),true);
 assert.equal(op.isFreeModel({...free,id:'demo',name:'Demo'}),false);
 for(const cost of [undefined,{}, {input:0}, {input:0,output:1}, {input:0,output:0,cacheRead:.1}])assert.equal(op.isFreeModel({...free,cost}),false);
});

test('DeepSeek OFF preserves confirmed FREE editions including thinking suffixes',()=>{
 const free={id:'deepseek-v4:free',cost:{input:0,output:0}};
 assert.equal(op.isPaidDeepSeek('kilo/deepseek/deepseek-v4:free:high',free),false);
 assert.equal(op.isPaidDeepSeek('provider/deepseek-v4:high',{...free,id:'deepseek-v4',name:'DeepSeek (FREE)'}),false);
 for(const model of [undefined,{id:'deepseek-v4:free'},{...free,cost:{input:0,output:1}},{...free,cost:{input:0,output:0,cacheWrite:1}},{...free,id:'deepseek-v4'}])assert.equal(op.isPaidDeepSeek('provider/deepseek-v4:high',model),true);
 assert.equal(op.isPaidDeepSeek('provider/other:high'),false);
});

test('track drops copy across tracks, retain thinking, and reorder within a track',()=>{
 const source=['p/a:high','p/b:low','p/c'],target=['p/x','p/y'];
 assert.deepEqual(op.transferCut(source,target,0,1,false),['p/x','p/a:high','p/y']);
 assert.deepEqual(op.transferCut(source,target,1,2,false),['p/x','p/y','p/b:low']);
 assert.deepEqual(source,['p/a:high','p/b:low','p/c']);assert.deepEqual(target,['p/x','p/y']);
 assert.deepEqual(op.transferCut(source,source,0,2,true),['p/b:low','p/c','p/a:high']);
 assert.deepEqual(op.transferCut(source,source,2,0,true),['p/c','p/a:high','p/b:low']);
 assert.deepEqual(op.transferCut(source,source,0,3,true),['p/b:low','p/c','p/a:high']);
 assert.deepEqual(op.transferCut(source,['p/a:low','p/x'],0,2,false),['p/x','p/a:high']);
});
test('bracketed FREE editions include Big Pickle but never unknown or paid costs',()=>{
 const m={id:'big-pickle',name:'[FREE] Big Pickle',cost:{input:0,output:0}};
 assert.equal(op.isFreeModel(m),true);
 assert.equal(op.isFreeModel({...m,cost:{}}),false);
 assert.equal(op.isFreeModel({...m,cost:{input:0,output:1}}),false);
});

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ForgeHistory}=require('./static/tape.js');
test('a restored draft can undo to its saved baseline and redo, including an unvisited profile',()=>{
 const h=new ForgeHistory(),saved={chain:['a']},draft={chain:['b']};
 for(const name of ['restored','unvisited']){
  h.observe(name,draft,true,saved);assert.equal(h.available(name).undo,true);
  assert.deepEqual(h.step(name,-1),saved);h.observe(name,saved,false,saved);
  assert.deepEqual(h.available(name),{undo:false,redo:true});
  assert.deepEqual(h.step(name,1),draft);h.observe(name,draft,true,saved);
  h.observe(name,{chain:['c']},true,saved);assert.deepEqual(h.step(name,-1),draft);
 }
 h.observe('fresh',saved,false,saved);assert.equal(h.available('fresh').undo,false);
 h.reset('in-flight',draft);h.observe('in-flight',draft,true,saved);
 assert.deepEqual(h.step('in-flight',-1),saved,'a saved snapshot cannot strand an already dirty draft');
});
test('reorder, replace, undo twice, redo without crossing profile boundary',()=>{
 const h=new ForgeHistory(),a={chain:['a','b','c']},b={chain:['b','a','c']},c={chain:['d','a','c']};
 h.observe('one',a,false);h.observe('one',b,true);h.observe('one',c,true);
 h.observe('two',{chain:['x']},false);
 assert.deepEqual(h.step('one',-1),b);h.observe('one',b,true);
 assert.deepEqual(h.step('one',-1),a);h.observe('one',a,false);
 assert.deepEqual(h.step('one',1),b);assert.equal(h.step('two',-1),null);
 h.observe('one',{chain:['e']},true);assert.equal(h.step('one',1),null);
});
test('polling, saved snapshots and history bound do not invent edits',()=>{
 const h=new ForgeHistory(2);h.observe('a',{v:0},false);h.observe('a',{v:1},false);
 assert.equal(h.step('a',-1),null);
 for(let v=2;v<6;v++)h.observe('a',{v},true);
 assert.deepEqual(h.step('a',-1),{v:4});assert.deepEqual(h.step('a',-1),{v:3});assert.equal(h.step('a',-1),null);
 h.reset('a',{v:5});assert.deepEqual(h.available('a'),{undo:false,redo:false});
});
test('mode metadata, thinking and provider settings restore atomically',()=>{
 const h=new ForgeHistory(),a={forgeMode:{mode:'deepseek',alternatives:['glm:high']},disabledProviders:[]},b={forgeMode:{mode:'no-deepseek',alternatives:['glm:max']},disabledProviders:['cc']};
 h.observe('a',a,false);h.observe('a',b,true);assert.deepEqual(h.step('a',-1),a);assert.deepEqual(h.step('a',1),b);
});
test('renaming carries editing history; deleting does not leak it to a new profile',()=>{
 const h=new ForgeHistory();h.observe('old',{v:1},false);h.observe('old',{v:2},true);
 h.rename('old','new');assert.equal(h.step('old',-1),null);assert.deepEqual(h.step('new',-1),{v:1});
 h.rename('new',null);h.observe('new',{v:3},false);assert.equal(h.step('new',-1),null);
});

test('replacement surface enters once; edits, picker typing and preview refresh never fade it again',()=>{
 const {runInNewContext}=require('node:vm'),{readFileSync}=require('node:fs');
 const motionPreference={matches:false,addEventListener(){}},context={window:{},matchMedia:()=>motionPreference};
 runInNewContext(readFileSync(require.resolve('./static/tape.js'),'utf8'),context);
 const tape=context.window.ForgeTape,panels=[];let panel=null;
 const root={dataset:{tapeContext:'profiles|one'},querySelector:s=>s==='.mode-panel'?panel:null,querySelectorAll:()=>[]};
 const frame={profile:'one',view:'profiles',draft:'base',dirty:false};
 function render(open,update={}){
  const old=tape.before(root);
  panel=open?{animations:[],animate(frames){this.animations.push(frames);}}:null;
  if(panel)panels.push(panel);
  Object.assign(frame,update);tape.after(root,old,{...frame});
 }
 render(false);render(true);
 assert.equal(panels.at(-1).animations.length,1,'opening animates');
 render(true,{draft:'reordered',dirty:true});render(true);render(true);render(true,{draft:'thinking'});
 assert.ok(panels.slice(1).every(p=>p.animations.length===0),'recreated DOM must stay opaque');
 render(false);render(true);assert.equal(panels.at(-1).animations.length,1,'reopening animates');
 motionPreference.matches=true;render(false);render(true);assert.equal(panels.at(-1).animations.length,0,'reduced motion is respected');
});

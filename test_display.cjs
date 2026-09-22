const test=require('node:test'),assert=require('node:assert/strict');
const {palette,contrast,screenPreferences,colourControl}=require('./static/display.js');
const hues=Array.from({length:24},(_,i)=>i*15).concat([130,359]);
test('continuous screen hues preserve readable labels and signals through both themes and trims',()=>{
 for(const tone of hues)for(const theme of ['light','dark'])for(let background=0;background<=100;background+=5)for(let colour=0;colour<=100;colour+=5){
  const p=palette(theme,background,colour,tone);
  for(const [name,rgb] of Object.entries(p))if(name!=='background')assert.ok(contrast(p.background,rgb)>=4.8,`${tone} ${theme} ${background}/${colour} ${name}`);
 }
 for(const foreground of hues)for(const tone of hues)for(const theme of ['light','dark'])for(const background of [0,25,50,75,100])for(const colour of [0,25,50,75,100]){
  const p=palette(theme,background,colour,tone,foreground);
  for(const [name,rgb] of Object.entries(p))if(name!=='background')assert.ok(contrast(p.background,rgb)>=4.8,`${tone}/${foreground} ${theme} ${background}/${colour} ${name}`);
 }
 const original=palette('dark',25,60,130,0),rotated=palette('dark',25,60,130,180);
 assert.deepEqual(original.background,rotated.background);
 assert.notDeepEqual(original.ink,rotated.ink);
 assert.notDeepEqual(original.red,rotated.red);
});
test('trim endpoints are bounded and background brightness is monotonic',()=>{
 for(const tone of hues)for(const theme of ['light','dark']){
  assert.deepEqual(palette(theme,-20,140,tone),palette(theme,0,100,tone));
  const dark=palette(theme,0,50,tone).background,light=palette(theme,100,50,tone).background;
  assert.ok(light.every((v,i)=>v>dark[i]));
 }
 assert.deepEqual(palette('light',55,55,'missing'),palette('light',55,55));
 assert.deepEqual(palette('light',55,55).background,[194,205,190]);
 assert.deepEqual(palette('dark',25,60,-50),palette('dark',25,60,0));
 assert.deepEqual(palette('dark',25,60,450),palette('dark',25,60,359));
 assert.equal(new Set(hues.map(n=>palette('light',55,55,n).background.join(','))).size,hues.length-1);
});
test('screen preferences reject malformed values and controls escape labels and identifiers',()=>{
 for(const value of [null,[],true,'amber'])assert.deepEqual(screenPreferences(value),{});
 const prefs=screenPreferences(JSON.parse('{"history":"amber","quota:my-provider.foo_1:account":"cyan","bad":"constructor","object":{},"__proto__":"violet","":"blue"}'));
 assert.deepEqual(prefs.history,{background:42,foreground:0});
 assert.deepEqual(prefs['quota:my-provider.foo_1:account'],{background:183,foreground:0});
 assert.equal(Object.hasOwn(prefs,'bad'),false);
 assert.equal(Object.hasOwn(prefs,'object'),false);
 assert.equal(Object.hasOwn(prefs,'__proto__'),true);
 assert.equal(Object.getPrototypeOf(prefs),Object.prototype);
 assert.deepEqual(screenPreferences({['x'.repeat(201)]:'blue'}),{});
 const control=colourControl('quota:"<&\'','A "<&\'','amber');
 assert.match(control,/data-lcd-colour="quota:&quot;&lt;&amp;&#39;"/);
 assert.match(control,/aria-label="Тло екрана: A &quot;&lt;&amp;&#39;"/);
 assert.match(control,/aria-label="Знаки екрана: A &quot;&lt;&amp;&#39;"/);
 assert.match(control,/role="slider"/);
 assert.match(control,/aria-valuemax="359" aria-valuenow="42"/);
 assert.ok(!control.includes('<select'));
 assert.deepEqual(screenPreferences({history:234,analysis:900,tariff:-5}),{history:{background:234,foreground:0},analysis:{background:359,foreground:0},tariff:{background:0,foreground:0}});
 assert.deepEqual(screenPreferences({history:{background:75,foreground:291}}),{history:{background:75,foreground:291}});
 assert.equal(colourControl('', 'Invalid'),'');
});
test('a screen colour persists locally, survives rerender, and preserves shared trims',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),events={},saved=[];
 const style=()=>({values:{},setProperty(name,value){this.values[name]=value;}});
 const root={dataset:{theme:'light'},style:style()},screen={dataset:{lcdScreen:'history'},style:style()};
 const control={dataset:{lcdColour:'history',lcdPart:'background'},style:style(),attrs:{'aria-label':'Тло екрана: Історія'},setAttribute(k,v){this.attrs[k]=String(v);},getAttribute(k){return this.attrs[k];},closest(selector){return selector==='[data-display]'?null:this;},focus(){},setPointerCapture(){},hasPointerCapture(){return false;}};
 const initial={light:{background:32,colour:67},dark:{background:18,colour:44},screens:{history:{background:42,foreground:0}}};
 const context={module:{exports:{}},document:{documentElement:root,addEventListener(type,fn){events[type]=fn;},querySelectorAll(selector){return selector==='[data-lcd-screen]'?[screen]:selector==='[data-lcd-colour]'?[control]:[];}},localStorage:{getItem(){return JSON.stringify(initial);},setItem(key,value){saved.push([key,JSON.parse(value)]);}},addEventListener(){},MutationObserver:class{observe(){}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('./static/display.js'),'utf8'),context);
 const display=context.module.exports;
 const event=extra=>({target:control,preventDefault(){},stopPropagation(){},...extra});
 assert.equal(control.attrs['aria-valuenow'],'42');
 assert.equal(screen.style.values['--lcd'],`rgb(${palette('light',32,67,42).background.join(' ')})`);
 events.click(event({detail:1}));
 assert.equal(saved.length,1);assert.equal(saved[0][0],'mana-display');
 assert.deepEqual(saved[0][1],{...initial,screens:{history:{background:57,foreground:0}}});
 screen.style=style();display.sync();
 assert.equal(screen.style.values['--lcd'],`rgb(${palette('light',32,67,57).background.join(' ')})`);
 root.dataset.theme='dark';display.sync();
 assert.equal(screen.style.values['--lcd'],`rgb(${palette('dark',18,44,57).background.join(' ')})`);
 events.keydown(event({key:'ArrowRight'}));assert.equal(control.attrs['aria-valuenow'],'58');
 events.keydown(event({key:'ArrowLeft',shiftKey:true}));assert.equal(control.attrs['aria-valuenow'],'48');
 const beforeDrag=saved.length;
 events.pointerdown(event({button:0,pointerId:7,clientY:100}));
 events.pointermove(event({pointerId:7,clientY:90}));
 events.pointermove(event({pointerId:7,clientY:80}));
 assert.equal(saved.length,beforeDrag);assert.equal(control.attrs['aria-valuenow'],'88');
 events.pointerup(event({pointerId:7}));assert.equal(saved.length,beforeDrag+1);
 events.click(event({detail:1}));assert.equal(control.attrs['aria-valuenow'],'88');assert.equal(saved.length,beforeDrag+1);
 events.pointerdown(event({button:0,pointerId:8,clientY:100}));
 events.pointermove(event({pointerId:8,clientY:70}));
 events.keydown(event({key:'Escape'}));assert.equal(control.attrs['aria-valuenow'],'88');assert.equal(saved.length,beforeDrag+1);
 events.keydown(event({key:'End'}));events.click(event({detail:0}));assert.equal(control.attrs['aria-valuenow'],'14');
 control.dataset.lcdPart='foreground';display.sync();assert.equal(control.attrs['aria-valuenow'],'0');
 const previousBackground=screen.style.values['--lcd'],previousInk=screen.style.values['--lcd-ink'];
 events.click(event({detail:1}));assert.equal(control.attrs['aria-valuenow'],'15');
 assert.equal(screen.style.values['--lcd'],previousBackground);assert.notEqual(screen.style.values['--lcd-ink'],previousInk);
 assert.deepEqual(saved.at(-1)[1].screens.history,{background:14,foreground:15});
 control.dataset.lcdColour='unmounted';const beforeInvalid=saved.length;events.click(event({detail:1}));
 assert.equal(saved.length,beforeInvalid);
});

test('a second pointer cannot replace an active LCD gesture or clear its cancellation state',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),events={},saved=[];
 const style=()=>({setProperty(){}}),root={dataset:{theme:'light'},style:style()},screen={dataset:{lcdScreen:'history'},style:style()};
 const control=part=>({dataset:{lcdColour:'history',lcdPart:part},style:style(),attrs:{},setAttribute(k,v){this.attrs[k]=v;},getAttribute(){return part;},closest(){return this;},focus(){},setPointerCapture(){},hasPointerCapture(){return false;}});
 const background=control('background'),foreground=control('foreground');
 const context={module:{exports:{}},document:{documentElement:root,addEventListener(type,fn){events[type]=fn;},querySelectorAll(selector){return selector==='[data-lcd-screen]'?[screen]:selector==='[data-lcd-colour]'?[background,foreground]:[];}},localStorage:{getItem(){return '{}';},setItem(key,value){saved.push(value);}},addEventListener(){},MutationObserver:class{observe(){}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('./static/display.js'),'utf8'),context);
 const event=(target,extra)=>({target,preventDefault(){},stopPropagation(){},...extra});
 events.pointerdown(event(background,{button:0,pointerId:1,clientY:100}));
 events.pointermove(event(background,{pointerId:1,clientY:80}));
 events.pointerdown(event(foreground,{button:0,pointerId:2,clientY:100}));
 events.pointermove(event(foreground,{pointerId:2,clientY:60}));
 events.pointerup(event(foreground,{pointerId:2}));
 events.click(event(foreground,{detail:1}));
 assert.equal(root.dataset.displayTuning,'true');
 assert.equal(foreground.attrs['aria-valuenow'],0);
 events.keydown(event(background,{key:'Escape'}));
 assert.equal(background.attrs['aria-valuenow'],130);
 assert.equal(root.dataset.displayTuning,undefined);
 assert.equal(saved.length,0);
});

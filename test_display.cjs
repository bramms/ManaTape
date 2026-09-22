const test=require('node:test'),assert=require('node:assert/strict');
const {palette,contrast}=require('./static/display.js');
test('all screen trims preserve readable labels and signal colours in both themes',()=>{
 for(const theme of ['light','dark'])for(let background=0;background<=100;background+=5)for(let colour=0;colour<=100;colour+=5){
  const p=palette(theme,background,colour);
  for(const [name,rgb] of Object.entries(p))if(name!=='background')assert.ok(contrast(p.background,rgb)>=4.8,`${theme} ${background}/${colour} ${name}`);
 }
});
test('trim endpoints are bounded and background brightness is monotonic',()=>{
 for(const theme of ['light','dark']){
  assert.deepEqual(palette(theme,-20,140),palette(theme,0,100));
  const dark=palette(theme,0,50).background,light=palette(theme,100,50).background;
  assert.ok(light.every((v,i)=>v>dark[i]));
 }
});

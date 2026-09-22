const {test}=require('node:test');
const assert=require('node:assert/strict');
const evidence=require('./static/evidence.js');
const op=require('./static/operator-core.js');
const row=(extra={})=>({id:'Demo V1',baseId:'demo-v1',source:'LiveBench',release:'2026-01-01',scores:{Coding:50},...extra});
test('FREE routes inherit exact model evidence across providers, not other versions or routers',()=>{
 const idx=evidence.index([row()]);
 assert.equal(idx.get(evidence.canonical('kilo/demo-v1:free')).length,1);
 assert.equal(idx.get(evidence.canonical('openrouter/demo-v1')).length,1);
 for(const id of ['demo-v1-preview','demo-v1-0731','demo-v1:optimized:free','auto-free','demo-v2'])assert.equal(idx.get(evidence.canonical(id)),undefined);
});
test('explicit aliases resolve provider naming without fuzzy variant matching',()=>{
 assert.equal(evidence.canonical('arcee-trinity-large-preview'),'trinity-large-preview');
 assert.equal(evidence.canonical('LiquidAI/LFM2.5-2.6B'),'lfm-2-5-2-6b');
 assert.notEqual(evidence.canonical('nvidia-nemotron-3-ultra-550b-a55b-nvfp4'),evidence.canonical('nemotron-3-ultra-550b-a55b'));
});
test('partial tests count as evidence, missing role metrics do not hide measurements',()=>{
 const r=row();assert.equal(op.score(r,{Coding:.5,Reasoning:.5}),null);
 assert.equal(evidence.coverage([r]).kind,'independent');
 assert.equal(evidence.coverage([row({scores:{Coding:0}})]).records,1);
 assert.equal(evidence.coverage([row({scores:{}})]).kind,'unknown');
});
test('preference ratings and publisher claims cannot become role scores',()=>{
 for(const kind of ['preference','developer'])assert.equal(op.score(row({kind}),{Coding:1}),null);
 assert.equal(evidence.coverage([row({kind:'developer'})]).kind,'developer');
 assert.equal(evidence.coverage([row({kind:'preference',scores:{},rating:1410})]).kind,'independent');
});
test('latest records retain source identity and separate efforts; summary cannot merge metrics',()=>{
 const rows=[row(),row({release:'2026-02-01',effort:'high'}),row({release:'2026-02-01',effort:'low'}),row({source:'Arena',kind:'preference',rating:1400,scores:{}})];
 assert.equal(evidence.latest(rows).length,3);
 assert.equal(evidence.summary(rows).length,2);
 assert.equal(evidence.summary(rows)[0].effort,'high');
 assert.deepEqual(evidence.summary(rows)[1].scores,{});
});

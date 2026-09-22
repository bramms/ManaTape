/* Data rules for the instrument. No network, DOM, storage or profile writes. */
const ManaOperator=(()=>{
 const clamp=(v,a=0,b=100)=>Math.max(a,Math.min(b,v));
 const normalize=s=>String(s||'').toLowerCase().split('/').at(-1).replace(/:free$/,'').replace(/[._]/g,'-');
 function isPaidDeepSeek(route,model){const raw=String(route).replace(/:(off|minimal|low|medium|high|xhigh|max|auto)$/,'');return /^deepseek(?:[-_.:]|$)/i.test(raw.split('/').at(-1))&&!isFreeModel(model);}
 function isFreeModel(m){const c=m?.cost;return Number.isFinite(c?.input)&&Number.isFinite(c?.output)&&c.input===0&&c.output===0&&!c.cacheRead&&!c.cacheWrite&&/(^|[\s:/_()\[\]-])free($|[\s:/_()\[\]-])/i.test(m.id+' '+m.name);}
 function transferCut(source,target,from,to,sameTrack){
  const out=[...target],route=source[from];if(route===undefined)return out;
  if(sameTrack)out.splice(from,1);
  else {const raw=value=>value.replace(/:(off|minimal|low|medium|high|xhigh|max|auto)$/,'');const existing=out.findIndex(value=>raw(value)===raw(route));if(existing>=0){out.splice(existing,1);if(existing<to)to--;}}
  out.splice(Math.min(to,out.length),0,route);return out;
 }
 function profileName(value){
  const name=typeof value==='string'?value.trim().toLowerCase().replace(/\s+/g,'-'):'';
  return {name,error:/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)?'':'Вкажи назву латиницею: літери, цифри, пробіли, дефіс або підкреслення; до 64 символів. Почни з літери чи цифри.'};
 }
 function duration(limit){
  if(limit.durationMs>0)return {ms:limit.durationMs,estimated:false};
  if(limit.windowMinutes>0)return {ms:limit.windowMinutes*60000,estimated:false};
  if(limit.starts&&limit.resets>limit.starts)return {ms:limit.resets-limit.starts,estimated:false};
  const label=limit.window+' '+limit.label;
  if(/5\s*(hour|год|h)/i.test(label))return {ms:18e6,estimated:true};
  if(/week|тиж|7\s*(day|дн)/i.test(label))return {ms:6048e5,estimated:true};
  if(/month|місяц/i.test(label)&&limit.resets){
   const end=new Date(limit.resets),start=new Date(limit.resets),day=end.getUTCDate();
   start.setUTCDate(1);start.setUTCMonth(start.getUTCMonth()-1);
   const days=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,0)).getUTCDate();
   start.setUTCDate(Math.min(day,days));return {ms:end-start,estimated:true};
  }
  return null;
 }
 function pace(limit,report,now=Date.now()){
  const at=report.at*1000,left=limit.remaining,window=duration(limit);
  if(report.stale||!at||now-at>9e5||at>now+6e4)return {kind:'unknown',label:'Застарілі дані'};
  if(left==null||!Number.isFinite(left))return {kind:'unknown',label:'Немає виміру'};
  if(limit.resets&&limit.resets<=now)return {kind:'unknown',label:'Чекаємо вимір'};
  if(left<=0)return {kind:'empty',label:'Вичерпано',eta:at};
  if(!window||!limit.resets)return {kind:'unknown',label:'Темп невідомий'};
  const elapsed=window.ms-(limit.resets-at);
  if(elapsed/window.ms<.03||elapsed>window.ms)return {kind:'unknown',label:'Мало даних'};
  const used=100-clamp(left),expected=elapsed/window.ms*100,delta=used-expected;
  const eta=used>0?at+left/used*elapsed:null,lasts=eta===null||eta>=limit.resets;
  return {kind:delta>2?'deficit':delta< -2?'reserve':'balanced',label:delta>2?'Перевитрата':delta< -2?'Із запасом':'У темпі',delta,expected,eta,lasts,estimated:window.estimated};
 }
 function applies(limit,model){
  const id=model.id.toLowerCase(),leaf=id.split('/').at(-1);
  if(limit.models?.length)return limit.models.some(value=>{const pattern=String(value).toLowerCase().replace(/[.+?^${}()|[\]\\]/g,'\\$&').replaceAll('*','.*');return new RegExp('^(?:'+pattern+')$').test(id)||new RegExp('^(?:'+pattern+')$').test(leaf);});
  const family=String(limit.tier||limit.label?.match(/\(([^)]+)\)/)?.[1]||'').toLowerCase();
  if(!family)return true;
  return id.includes(family)||(family==='anthropic'&&id.includes('claude'))||(family==='google'&&id.includes('gemini'))||(family==='openai'&&/gpt|o[134]-/.test(id));
 }
 function health(model,reports,disabled=[],now=Date.now()){
  if(disabled.includes(model.provider)||model.expired||model.status==='missing')return {kind:'empty',label:'Недоступна'};
  if(model.local===true)return {kind:'local',label:'GPU · без квоти'};
  const accounts=reports.filter(r=>r.provider===model.provider);
  if(accounts.length>1)return {kind:'unknown',label:'Кілька акаунтів · пул невідомий'};
  const report=accounts[0];
  if(!report||report.stale||!report.at||now-report.at*1000>9e5)return {kind:'unknown',label:model.local===true?'GPU · без виміру':'Ліміт невідомий'};
  const limits=report.limits.filter(l=>(!model.free||l.models?.length)&&applies(l,model));
  const valid=limits.filter(l=>l.remaining!=null&&(!l.resets||l.resets>now));
  if(valid.some(l=>l.remaining<=0))return {kind:'empty',label:'Ліміт вичерпано',remaining:0};
  if(!valid.length)return {kind:'unknown',label:'Ліміт невідомий'};
  const remaining=Math.min(...valid.map(l=>l.remaining));
  if(remaining<15||valid.some(l=>{const q=pace(l,report,now);return q.kind==='deficit'&&!q.lasts;}))return {kind:'risk',label:'Малий запас',remaining};
  if(valid.length<limits.length)return {kind:'unknown',label:'Ліміти неповні',remaining};
  return {kind:'healthy',label:'Є запас',remaining};
 }
 function promote(list,predicate,steps){
  const out=[...list],amount=Math.min(8,Math.abs(steps));
  for(let turn=0;turn<amount;turn++){
   if(steps>0){for(let i=1;i<out.length;i++)if(predicate(out[i])&&!predicate(out[i-1])&&(i>1||amount===8))[out[i-1],out[i]]=[out[i],out[i-1]];}
   else{for(let i=out.length-2;i>=0;i--)if(predicate(out[i])&&!predicate(out[i+1]))[out[i],out[i+1]]=[out[i+1],out[i]];}
  }
  return out;
 }
 // Exact effort wins; a same-model alternative is an explicit approximate guide.
 function evidence(records,weights,effort=null,approximate=false){
  const candidates=records.map(record=>({record,score:score(record,weights)})).filter(q=>q.score!=null).sort((a,b)=>b.score-a.score);
  const exact=effort===null?candidates[0]:candidates.find(q=>String(q.record.effort||'')===(effort==='off'?'':effort));
  if(exact)return {...exact,approximate:false};
  return approximate&&candidates[0]?{...candidates[0],approximate:true}:null;
 }
 function quality(list,evidence,steps){
  const out=[...list],groups=new Map();
  list.forEach((r,i)=>{const q=evidence(r);if(q){const key=q.cohort,a=groups.get(key)||[];a.push({i,r,score:q.score});groups.set(key,a);}});
  for(const a of groups.values()){
   const rows=[...a];for(let n=0;n<Math.abs(steps);n++)for(let i=rows.length-1;i>0;i--){if((steps>0?rows[i].score>rows[i-1].score:rows[i].score<rows[i-1].score))[rows[i],rows[i-1]]=[rows[i-1],rows[i]];}
   a.forEach((x,i)=>out[x.i]=rows[i].r);
  }
  return out;
 }
 function score(record,weights){
  if(record.kind&&record.kind!=='benchmark')return null;
  if(!weights||Object.keys(weights).some(k=>!Number.isFinite(record.scores[k])))return null;
  const total=Object.values(weights).reduce((a,b)=>a+b,0);return total?Object.entries(weights).reduce((n,[k,w])=>n+record.scores[k]*w,0)/total:null;
 }
 return {normalize,isFreeModel,isPaidDeepSeek,transferCut,profileName,duration,pace,applies,health,promote,quality,evidence,score};
})();
if(typeof module!=='undefined')module.exports=ManaOperator;

/* Evidence identity and coverage; no network, inference or profile mutations. */
const ManaEvidence=(()=>{
 const normalize=value=>String(value||'').toLowerCase().split('/').at(-1).replace(/:free$/,'').replace(/[._]/g,'-');
 // Exact naming differences, not fuzzy family/version matching. Provenance: docs/BENCHMARKS.md.
 const aliases={'arcee-trinity-large-preview':'trinity-large-preview','lfm2-5-2-6b':'lfm-2-5-2-6b','nvidia-nemotron-3-super-120b-a12b':'nemotron-3-super-120b-a12b'};
 const canonical=value=>{const key=normalize(value);return aliases[key]||key;};
 const kind=r=>r.kind||'benchmark';
 const order={'Artificial Analysis':0,'LiveBench':1,'LiveCodeBench':2,'Arena':3,'Розробник':4};
 function index(records){
  const out=new Map();
  for(const record of records){
   const legacy=record.id.replace(/-(thinking.*|xhigh-effort|high-effort|medium-effort|xhigh|high|medium|low)$/,'');
   const key=canonical(record.baseId||legacy),rows=out.get(key)||[];rows.push(record);out.set(key,rows);
  }
  return out;
 }
 function hasValues(r){return kind(r)==='preference'?Number.isFinite(r.rating):Object.values(r.scores||{}).some(Number.isFinite);}
 function coverage(records){
  const rows=records.filter(hasValues),independent=rows.filter(r=>kind(r)!=='developer'),claims=rows.filter(r=>kind(r)==='developer');
  return {kind:independent.length?'independent':claims.length?'developer':'unknown',sources:[...new Set(independent.map(r=>r.source))],claims:claims.length,records:rows.length};
 }
 function latest(records){
  const dates=new Map();for(const r of records)if(hasValues(r)&&(!dates.has(r.source)||r.release>dates.get(r.source)))dates.set(r.source,r.release);
  return records.filter(r=>hasValues(r)&&r.release===dates.get(r.source)).sort((a,b)=>(order[a.source]??9)-(order[b.source]??9)||Number(b.effort==='high')-Number(a.effort==='high')||String(a.effort||'').localeCompare(b.effort||''));
 }
 function summary(records){const seen=new Set();return latest(records).filter(r=>{if(seen.has(r.source))return false;seen.add(r.source);return true;});}
 return {canonical,index,kind,coverage,latest,summary};
})();
if(typeof module!=='undefined')module.exports=ManaEvidence;

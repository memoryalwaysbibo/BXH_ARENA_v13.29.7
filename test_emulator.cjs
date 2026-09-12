const assert=require('assert/strict');
const origin='http://'+(process.env.FIRESTORE_EMULATOR_HOST||'127.0.0.1:8184');
const base=origin+'/v1/projects/demo-bxh-v13294/databases/(default)/documents/';
(async()=>{
  for(const resource of ['titleDefinitions/probe','users/probe/dailyCheckIns/2026-09-11','engagementDailyStats/probe']){
    assert.equal((await fetch(base+resource)).status,403,'anonymous private read '+resource);
    assert.equal((await fetch(base+resource,{method:'PATCH',headers:{'content-type':'application/json'},body:'{"fields":{}}'})).status,403,'anonymous write '+resource);
  }
  console.log('PASS emulator compilation and 6 anonymous access checks; not a full role/transaction suite');
})().catch(e=>{console.error(e);process.exitCode=1});

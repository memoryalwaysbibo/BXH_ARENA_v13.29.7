const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const path=require('path');
const root=path.resolve(process.argv[2] || __dirname);
const source=fs.readFileSync(root+'/functions/index.js','utf8');
const html=fs.readFileSync(root+'/index.html','utf8');
function harness(){
  const rows=new Map(), writes=[];
  const snap=(p)=>({id:p.split('/').pop(),exists:rows.has(p),data:()=>rows.get(p)});
  const apply=(p,v,merge)=>{rows.set(p,merge?{...(rows.get(p)||{}),...v}:v);writes.push(p);};
  const ref=p=>({path:p,get:async()=>snap(p),set:async(v,o)=>apply(p,v,o?.merge),create:async(v)=>{assert(!rows.has(p));apply(p,v,false);}});
  const collection=p=>{
    let max=Infinity,after='',filter=()=>true;
    return {doc:id=>ref(p+'/'+id),where(k,op,v){filter=r=>r[k]===v;return this;},orderBy(){return this;},limit(n){max=n;return this;},startAfter(v){after=v;return this;},startAt(){return this;},endAt(){return this;},async get(){
      const docs=[...rows.keys()].filter(k=>k.startsWith(p+'/')&&!k.slice(p.length+1).includes('/')&&k.slice(p.length+1)>after&&filter(rows.get(k))).sort().slice(0,max).map(snap);
      return {docs,size:docs.length,empty:!docs.length};
    }};
  };
  const db={doc:ref,collection,getAll:async(...rs)=>rs.map(r=>snap(r.path)),async runTransaction(fn){
    let writing=false;const pending=[];
    const tx={get:async(r)=>{assert(!writing,'transaction read after write');return snap(r.path);},set(r,v,o){writing=true;pending.push(()=>apply(r.path,v,o?.merge));},create(r,v){writing=true;assert(!rows.has(r.path));pending.push(()=>apply(r.path,v,false));}};
    const result=await fn(tx);pending.forEach(f=>f());return result;
  }};
  class HttpsError extends Error{constructor(code,m){super(m);this.code=code;}}
  const ctx={exports:{},process:{env:{GCLOUD_PROJECT:'test'}},console:{error(){},warn(){}},Date,Set,Map,
    require(n){if(n==='node:crypto')return require(n);if(n.endsWith('/https'))return{onCall:(o,f)=>f,HttpsError};if(n.endsWith('/firestore')&&n.includes('firebase-functions'))return{onDocumentCreated:(o,f)=>f};if(n==='firebase-functions/v2')return{setGlobalOptions(){}};if(n.endsWith('/app'))return{initializeApp(){}};if(n==='firebase-admin/firestore')return{getFirestore:()=>db,FieldPath:{documentId:()=> '__name__'},FieldValue:{serverTimestamp:()=>123,increment:n=>n},Timestamp:{fromMillis:n=>n}};throw Error(n);}};
  vm.createContext(ctx);vm.runInContext(source,ctx);
  return {ctx,rows,writes,api:ctx.exports};
}
async function main(){
  let scriptCount=0;
  for(const m of html.replace(/<!--[\s\S]*?-->/g,'').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)){
    if(/src\s*=/.test(m[1]))continue;
    const result=require('child_process').spawnSync(process.execPath,['--check','--input-type=module'],{input:m[2],encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);scriptCount++;
  }
  assert.equal(scriptCount,2,'all inline scripts must be parsed');
  const h=harness(),{rows,api,ctx}=h;
  rows.set('users/admin',{active:true,role:'super_admin'});
  rows.set('users/p',{active:true,role:'player'});
  const admin={auth:{uid:'admin'},data:{}},player={auth:{uid:'p'},data:{}};
  await assert.rejects(()=>api.getEngagementHealth(player),e=>e.code==='permission-denied');
  assert.equal((await api.getEngagementHealth(admin)).serviceVersion,'13.29.4');
  rows.set('titleDefinitions/first_battle',{name:'custom',isActive:false,isHidden:true,isArchived:true,createdAt:99,recipientCount:8});
  await api.seedInitialTitles(admin);
  assert.equal(rows.get('titleDefinitions/first_battle').name,'custom');
  assert.equal(rows.get('titleDefinitions/first_battle').createdAt,99);
  assert.equal(rows.get('publicTitleCatalog/first_battle').name,'？？？');
  const count=rows.size;await api.seedInitialTitles(admin);assert.equal(rows.size,count);
  const stats=ctx.currentCheckInStats({lastCheckInDate:'2026-01-31',monthlyCheckInDays:20,currentCheckInStreak:3,totalCheckInDays:25},'2026-02-03');
  assert.equal(stats.monthlyCheckInDays,0);assert.equal(stats.currentCheckInStreak,0);assert.equal(stats.totalCheckInDays,25);
  assert.equal(ctx.currentCheckInStats({lastCheckInDate:'2026-01-31',currentCheckInStreak:3},'2026-02-01').currentCheckInStreak,3);
  rows.set('systemSettings/engagement',{dailyCheckInEnabled:true,titlesEnabled:true});
  vm.runInContext('evaluateTitles=async()=>{throw Error("offline")}',ctx);
  const check=await api.dailyCheckIn(player);assert.equal(check.ok,true);assert.equal(check.titleEvaluationWarning,true);
  const duplicate=await api.dailyCheckIn(player);assert.equal(duplicate.alreadyCheckedIn,true);
  assert.equal(rows.get('playerStats/p').totalCheckInDays,1);
  assert.equal(rows.get('engagementDailyStats/'+check.today).officialCount,1);
  rows.set('ladderTransactions/a',{id:'a'});rows.set('ladderTransactions/b',{id:'b'});
  vm.runInContext('processOfficialEventLog=async(log,id)=>id==="b"?{status:"processed",awarded:0,awardErrors:1}:{status:"created",awarded:2,awardErrors:0}',ctx);
  const result=await api.runTitleBackfill({auth:{uid:'admin'},data:{execute:true,limit:25}});
  assert.equal(result.retryRequired,true);assert.equal(result.nextCursor,'');assert.equal(result.done,false);assert.equal(result.summary.awarded,2);
  vm.runInContext('processOfficialEventLog=async()=>({status:"processed",awarded:0,awardErrors:0})',ctx);
  const retry=await api.runTitleBackfill({auth:{uid:'admin'},data:{execute:true,limit:25}});
  assert.equal(retry.done,true);assert.equal(retry.summary.processed,2);
  // Exercise the actual frontend engagement block with controlled timers and failed reads.
  let calls=0;const timers=[];
  const front={console:{warn(){}},Date,Set,Map,Number,Array,Object,Promise,document:{addEventListener(){}},window:{engagementService:{getSnapshot:async()=>{calls++;throw Error('offline');}}},firebaseUser:{uid:'p'},userProfile:{},esc:String,setTimeout(fn){timers.push(fn);return timers.length;},clearTimeout(){},render(){}};
  vm.createContext(front);
  vm.runInContext(html.slice(html.indexOf('let engagementSnapshot=null;'),html.indexOf('let communityEventsCache = null;')),front);
  vm.runInContext('syncEngagementIdentity();requestEngagementSnapshot()',front);
  await new Promise(setImmediate);
  for(let i=0;i<20;i++) vm.runInContext('renderDailyCheckInCard();requestEngagementSnapshot()',front);
  await new Promise(setImmediate);assert.equal(calls,1,'failed service retried automatically');
  const cal=vm.runInContext('renderCheckInCalendar({month:"2024-02",today:"2024-02-29",dates:["2024-02-29"]})',front);
  assert.equal((cal.match(/class="checkin-day /g)||[]).length,29);assert(cal.includes('aria-current="date"'));
  vm.runInContext('engagementAdminOverview={private:true};engagementTitleDraft={equippedTitleId:"secret"};firebaseUser={uid:"other"};syncEngagementIdentity()',front);
  assert.equal(vm.runInContext('engagementAdminOverview',front),null);assert.equal(vm.runInContext('engagementTitleDraft',front),null);
  vm.runInContext('engagementTitleDraft={equippedTitleId:"secret"};syncEngagementIdentity("")',front);
  assert.equal(vm.runInContext('engagementTitleDraft',front),null);
  let finish;
  front.window.engagementService.getSnapshot=()=>new Promise(resolve=>{finish=resolve;});
  front.firebaseUser={uid:'A'};
  vm.runInContext('syncEngagementIdentity();requestEngagementSnapshot()',front);
  await new Promise(setImmediate);
  front.firebaseUser={uid:'B'};vm.runInContext('syncEngagementIdentity()',front);
  finish({ok:true,catalog:[{name:'A-private'}],profilePatch:{equippedTitleId:'secret'}});
  await new Promise(setImmediate);
  assert.equal(vm.runInContext('engagementSnapshot',front),null,'late A response wrote B snapshot');
  assert.equal(front.userProfile.equippedTitleId,undefined,'late response patched profile');
  console.log('PASS: admin health authorization; seed preservation/idempotency; date rollover; committed checkin survives award failure; duplicate checkin; partial backfill retry; frontend retry stop; leap calendar; session isolation');
}
main().catch(e=>{console.error(e);process.exitCode=1;});

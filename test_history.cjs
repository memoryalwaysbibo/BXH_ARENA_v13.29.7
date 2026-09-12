const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
const block=html.slice(html.indexOf('function historyCloudIdentityKey(){'),html.indexOf('function renderDutyLog(){'));
const page=html.slice(html.indexOf('function renderHistory(){'),html.indexOf('/* ==== main render ==== */'));
const tick=()=>new Promise(r=>setImmediate(r));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};}
function setup(query,timeout=30000){
  const timers=new Map();let timerId=0;
  const c={console:{warn(){}},Date,Map,Promise,JSON,Error,
    setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id)},
    historyCloudSyncBusy:false,historyCloudSyncLoaded:false,historyCloudSyncError:'',historyCloudSyncRequest:null,
    historyCloudSyncContextKey:null,historyCloudViewActive:false,HISTORY_CLOUD_TIMEOUT_MS:timeout,
    historyCloudRecordCache:new Map(),recordIndex:[],viewingRecordId:null,viewingRecordData:null,
    currentRole:'tester',userProfile:{role:'tester',active:true},uid:'A',engagementSessionEpoch:0,
    appPhase:'app',activeTab:'history',historyFilters:{search:'',date:'',format:'all'},state:{id:'local'},
    esc:x=>String(x??''),FORMAT_LABELS:{},ARCHIVE_LABELS:{completed:'已完成'},
    currentAuthUid:()=>c.uid,hasAdminAccess:()=>true,cloudAvailable:()=>true,
    defaultState:id=>({id,meta:{}}),summarizeRecord:r=>({id:r.id,name:r.meta.name,archiveStatus:r.archiveStatus}),
    loadIndex:async()=>[],saveRecord:async()=>{throw Error('cloud sync must not write session data to local storage')},
    window:{cloudSync:{connect:async()=>{},queryAdminTournaments:async()=>{c.calls++;return query()},joinRoom:async code=>({ok:true,data:{id:code,meta:{name:code}}})}},calls:0,renders:0,
  };
  vm.createContext(c);vm.runInContext(block+'\n'+page,c);
  c.render=()=>{c.renders++;c.reconcileHistoryCloudContext();if(c.activeTab==='history'&&c.appPhase==='app')c.markup=c.renderHistory()};
  c.flushScheduled=async()=>{for(let n=0;n<6;n++){const due=[...timers].filter(([,x])=>x.ms===0);if(!due.length)break;for(const[id,x]of due){timers.delete(id);x.fn()}await tick()}};
  c.timeout=()=>{for(const[id,x]of [...timers])if(x.ms===timeout){timers.delete(id);x.fn()}};
  c.pendingTimers=()=>timers.size;
  return c;
}
(async()=>{
  // Exercise actual renderHistory scheduling + error render, not just direct sync calls.
  for(const code of ['permission-denied','unavailable']){
    const c=setup(()=>{throw Object.assign(Error('rejected'),{code})});c.render();await c.flushScheduled();
    assert.equal(c.calls,1);assert.equal(c.historyCloudSyncBusy,false);assert(c.historyCloudSyncError);
    for(let i=0;i<8;i++){c.render();await c.flushScheduled()}
    assert.equal(c.calls,1,'failure must not retrigger on render');assert(c.markup.includes('返回賽事管理'));
    assert(!c.markup.includes('尚無賽事紀錄'),'failure is not empty success');
    c.window.cloudSync.queryAdminTournaments=async()=>{c.calls++;return []};
    await c.syncCompletedCloudRecordsToHistory(true);await c.flushScheduled();
    assert.equal(c.calls,2);assert.equal(c.historyCloudSyncError,'');assert(c.markup.includes('尚無賽事紀錄'));
    assert.equal(c.pendingTimers(),0);
  }
  const d=deferred(),slow=setup(()=>d.promise);const pending=slow.syncCompletedCloudRecordsToHistory(false);await tick();
  slow.timeout();await pending;assert(slow.historyCloudSyncError.includes('逾時'));assert.equal(slow.historyCloudSyncBusy,false);
  slow.window.cloudSync.queryAdminTournaments=async()=>[{code:'NEW',archiveStatus:'completed'}];
  await slow.syncCompletedCloudRecordsToHistory(true);
  d.resolve([{code:'OLD',archiveStatus:'completed'}]);await tick();
  assert.equal(slow.recordIndex[0].id,'NEW');assert(!slow.historyCloudRecordCache.has('OLD'));assert.equal(slow.pendingTimers(),0);

  const d2=deferred(),nav=setup(()=>d2.promise);const p2=nav.syncCompletedCloudRecordsToHistory(false);await tick();
  nav.activeTab='live';nav.render();const renders=nav.renders;await p2;
  assert.equal(nav.historyCloudSyncBusy,false);d2.resolve([{code:'OLD',archiveStatus:'completed'}]);await tick();
  assert.equal(nav.renders,renders);assert.equal(nav.recordIndex.length,0);assert.equal(nav.pendingTimers(),0);
  nav.activeTab='history';nav.window.cloudSync.queryAdminTournaments=async()=>[];nav.render();await nav.flushScheduled();assert.equal(nav.historyCloudSyncLoaded,true);

  const d3=deferred(),auth=setup(()=>d3.promise);const p3=auth.syncCompletedCloudRecordsToHistory(false);await tick();
  auth.uid='B';auth.engagementSessionEpoch++;auth.render();await p3;
  auth.window.cloudSync.queryAdminTournaments=async()=>[{code:'B',archiveStatus:'completed'}];await auth.flushScheduled();
  d3.resolve([{code:'A',archiveStatus:'completed'}]);await tick();assert.equal(auth.recordIndex[0].id,'B');assert(!auth.historyCloudRecordCache.has('A'));

  // Partial reads preserve successful results and do not loop; no cache storage requirement.
  const part=setup(()=>[{code:'OK',archiveStatus:'completed'},{code:'FAIL',archiveStatus:'completed'},{code:'LIVE',archiveStatus:'ongoing'}]);
  part.window.cloudSync.joinRoom=async code=>code==='FAIL'?{ok:false,reason:'private'}:{ok:true,data:{id:code,meta:{name:code}}};
  part.render();await part.flushScheduled();assert.equal(part.recordIndex.length,1);assert(part.historyCloudSyncError.includes('1 場讀取失敗'));assert.equal(part.calls,1);
  part.uid='OTHER';part.reconcileHistoryCloudContext();assert.equal(part.historyCloudRecordCache.size,0);assert.equal(part.recordIndex.length,0);

  const queued=setup(()=>[]);queued.render();queued.activeTab='live';queued.render();await queued.flushScheduled();assert.equal(queued.calls,0,'scheduled entry cannot start after navigation');
  const dedup=setup(()=>[]);dedup.render();dedup.render();dedup.render();await dedup.flushScheduled();assert.equal(dedup.calls,1);
  console.log('PASS BUG 010: actual render scheduling; permission/offline retry bound; manual retry; timeout/late result; navigation; identity isolation; partial/empty success; queued cancellation; duplicate starts; timer cleanup');
})().catch(e=>{console.error(e);process.exitCode=1});

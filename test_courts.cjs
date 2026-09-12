const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
function between(a,b){const start=html.indexOf(a);assert(start>=0,a);const end=html.indexOf(b,start+a.length);assert(end>start,b);return html.slice(start,end);}
const ctx={console,Date,JSON,Number,Math,Array,Object,String,Set,Map};vm.createContext(ctx);
const names=['orderedMatches','refereeMatches','getMatch','ensureMatchStatusFields','ensureMatchScoringFields','resolveScoringModeForRound','syncMatchStatuses','autoAdvanceReadyMatches','courtKey','stationExecutionQueue','rebuildCourtAssignments','markMatchSkipped','applySkippedDispatch','rebuildPropagation','rebuildPropagationForState','rebuildPropagationSingle','rebuildPropagationRoundRobin','numRoundsTotal','matchesInRound','applyPropagatedSlots'];
// Top-level declaration boundaries keep template bodies intact.
function declaration(name){const start=html.indexOf('function '+name+'(');assert(start>=0,name);const next=html.indexOf('\nfunction ',start+10);return html.slice(start,next).replace(/\n(?:\/\/[^\n]*\n)*\s*$/,'');}
// Explicit bounds for declarations followed by other global statements.
const bodies=names.map(n=>n==='markMatchSkipped'?between('function markMatchSkipped(', 'async function skipMatch('):n==='applySkippedDispatch'?between('function applySkippedDispatch(', 'async function claimSkippedMatch('):declaration(n));
vm.runInContext('let state;\n'+bodies.join('\n'),ctx);

const run=s=>vm.runInContext(s,ctx),copy=x=>JSON.parse(JSON.stringify(x));
function match(id,station=1){return{id,station,seq:Number(id.replace(/\D/g,''))||1,round:0,indexInRound:0,a:{playerId:id+'a'},b:{playerId:id+'b'},scoreA:2,scoreB:1,log:[{side:'A',points:2}],status:'pending',completed:false};}
function room(matches){return{id:'r',cloudCode:'ROOM',meta:{stations:3,formatType:'roundrobin'},startedAt:1,matches,courtAssignments:{},players:[]};}
function set(st){ctx.fixture=copy(st);run('state=fixture;syncMatchStatuses();rebuildCourtAssignments()');}
function current(n){return run(`state.courtAssignments.court${n}.currentMatchId`);}
function finish(id){run(`getMatch(${JSON.stringify(id)}).completed=true;rebuildCourtAssignments()`);}
set(room([1,2,3,4,5,6].map(n=>match('m'+n))));
run('markMatchSkipped("m1")');assert.equal(current(1),'m2');
for(let i=0;i<5;i++)run('rebuildCourtAssignments()');
finish('m2');assert.equal(current(1),'m3');finish('m3');assert.equal(current(1),'m1','skip must not drift behind m4/m5/m6');
assert.equal(run('getMatch("m1").scoreA'),2);assert.equal(run('getMatch("m1").log.length'),1);
set(room([match('m1')]));run('markMatchSkipped("m1")');assert.equal(current(1),null,'only match remains explicitly recoverable');
assert.equal(run('getMatch("m1").skippedAt>0'),true);
assert.equal(run('applySkippedDispatch(state,getMatch("m1"),2,1).ok'),true);
assert.equal(current(2),'m1');assert.equal(current(1),null);
set(room([match('m1'),match('m2'),match('m3'),match('m4',2)]));run('markMatchSkipped("m1")');
const occupied=copy(run('getMatch("m4")'));
assert.equal(run('applySkippedDispatch(state,getMatch("m1"),2,1).ok'),true);
assert.equal(current(2),'m4');assert.deepEqual(copy(run('getMatch("m4")')),occupied);
assert.equal(run('state.courtAssignments.court2.nextMatchId'),'m1');
assert.equal(run('applySkippedDispatch(state,getMatch("m1"),3,1).ok'),false,'second claimant must fail');
finish('m4');assert.equal(current(2),'m1');assert.equal(run('getMatch("m1").scoreA'),2);
// Paused current remains intact; dispatch waits behind it.
set(room([match('m1'),match('m2'),match('m3'),match('m4',2)]));run('getMatch("m4").status="paused";markMatchSkipped("m1");applySkippedDispatch(state,getMatch("m1"),2,1)');assert.equal(current(2),'m4');assert.equal(run('getMatch("m4").status'),'paused');
assert.equal(run('applySkippedDispatch(state,getMatch("m2"),3,0).ok'),false,'ordinary active match cannot be stolen');
assert.equal(run('applySkippedDispatch(state,getMatch("m1"),99,2).ok'),false);
// Persist/reload must preserve predecessor position, including legacy skipped rooms.
set(room([match('m1'),match('m2'),match('m3'),match('m4')]));run('markMatchSkipped("m1");state=JSON.parse(JSON.stringify(state));rebuildCourtAssignments()');finish('m2');finish('m3');assert.equal(current(1),'m1');
// Actual single-elimination propagation preserves resolved participants after transfer.
const single=room([match('m1'),match('m2'),{...match('final',3),round:1,a:null,b:null}]);
single.meta.formatType='single';single.bracketSize=4;single.matches[1].indexInRound=1;
set(single);run('markMatchSkipped("m1");applySkippedDispatch(state,getMatch("m1"),2,1)');
run('getMatch("m1").completed=true;getMatch("m1").winnerId="m1a";getMatch("m2").completed=true;getMatch("m2").winnerId="m2b";rebuildPropagationForState(state)');
assert.equal(run('getMatch("final").a.playerId'),'m1a');assert.equal(run('getMatch("final").b.playerId'),'m2b');
assert.equal(run('getMatch("m1").scoreA'),2);
// Verify visible states of the new independent check-in entry and page.
ctx.esc=x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
ctx.setTimeout=()=>{};ctx.requestEngagementSnapshot=()=>{};
ctx.engagementSnapshot={settings:{dailyCheckInEnabled:true},stats:{totalCheckInDays:7},checkIn:{checkedIn:false,month:'2026-09',today:'2026-09-12',dates:[]}};
ctx.engagementLoading=false;ctx.engagementError='';ctx.engagementActionBusy=false;
ctx.engagementSettings=()=>ctx.engagementSnapshot?.settings||{};
for(const n of ['renderCheckInCalendar','renderDailyCheckInEntry','renderDailyCheckInCard'])run(declaration(n));
assert(!run('renderDailyCheckInEntry()').includes('checkin-calendar'));
assert(run('renderDailyCheckInEntry()').includes('data-tab="checkin"'));
assert(run('renderDailyCheckInCard()').includes('今日簽到'));
ctx.engagementSnapshot.checkIn.checkedIn=true;
assert(/data-action="player-daily-checkin" disabled/.test(run('renderDailyCheckInCard()')));
ctx.engagementSnapshot.settings.dailyCheckInEnabled=false;
assert(run('renderDailyCheckInCard()').includes('尚未開放'));
ctx.engagementSnapshot=null;ctx.engagementError='連線失敗';
assert(run('renderDailyCheckInCard()').includes('player-refresh-engagement'));
// Load real Firebase client transaction method against a serialized transaction store.
const method=between('    async mutateMatchTransaction(', '    // Re-reads the tournament document');
let rows=new Map(),tail=Promise.resolve(),writes=0;
const ref=(db,...parts)=>parts.join('/');
ctx.cloudEnabled=true;ctx.dbHandle={};ctx.USERS_COLLECTION='users';ctx.authHandle={currentUser:{uid:'judge'}};
ctx.buildPublicMirrorFields=st=>({matches:st.matches});ctx.computeTournamentPhase=()=> 'started';
ctx.fx={doc:ref,runTransaction(db,fn){const task=tail.then(async()=>{
  const pending=[];let writing=false;
  const result=await fn({get:async key=>{assert(!writing,'read after write');return{exists:()=>rows.has(key),data:()=>copy(rows.get(key))};},set(key,value,opts){writing=true;pending.push([key,value]);}});
  for(const [key,value] of pending){rows.set(key,{...rows.get(key),...value});writes++;}return result;
});tail=task.catch(()=>{});return task;}};
const confirmMethod=between('    async confirmMatchTransaction(', '    // callback(parsedData');
run('const api={'+method+confirmMethod+'};');
function dbRoom(st,actor={role:'staff',active:true},assignments={'2':['judge']}){
 rows=new Map([['users/judge',actor],['tournaments/ROOM',{data:JSON.stringify(st),refereeStationRestrictionEnabled:true,refereeStationAssignments:assignments}]]);writes=0;
}
async function main(){
 set(room([match('m1'),match('m2'),match('m3'),match('m4',2)]));run('markMatchSkipped("m1")');const st=copy(run('state'));dbRoom(st);
 const call=(target=2,revision=1)=>run(`api.mutateMatchTransaction("ROOM","m1",1,(s,m)=>applySkippedDispatch(s,m,${target},${revision}),"judge",{targetStation:${target},expectedRevision:${revision}})`);
 assert.equal((await call(3)).reason,'station-not-assigned');assert.equal(writes,0);
 const both=await Promise.all([call(),call()]);assert.equal(both.filter(x=>x.ok).length,1);assert.equal(writes,2,'private and public mirror commit together');
 assert.equal(JSON.parse(rows.get('tournaments/ROOM').data).matches.find(x=>x.id==='m1').station,2);
 // Old source court scoring is refused after dispatch, even by an administrator.
 rows.set('users/judge',{role:'admin',active:true});
 const stale=await run('api.mutateMatchTransaction("ROOM","m1",1,(s,m)=>{m.scoreA=6;return{ok:true,state:s}},"judge",{expectedRevision:1})');
 assert.equal(stale.reason,'station-mismatch');assert.equal(writes,2);
 const staleConfirm=await run('api.confirmMatchTransaction("ROOM",s=>({ok:true,state:s}),{matchId:"m1",station:1,dispatchRevision:1})');
 assert.equal(staleConfirm.reason,'station-mismatch');assert.equal(writes,2);
 const waitingConfirm=await run('api.confirmMatchTransaction("ROOM",s=>({ok:true,state:s}),{matchId:"m1",station:2,dispatchRevision:2})');
 assert.equal(waitingConfirm.reason,'dispatch-stale');assert.equal(writes,2);

 dbRoom(st,{role:'player',active:true});assert.equal((await call()).ok,false);assert.equal(writes,0);
 dbRoom(st,{role:'staff',active:false});assert.equal((await call()).ok,false);
 dbRoom({...st,archiveStatus:'completed'});assert.equal((await call()).reason,'already-completed');
 dbRoom(st,{role:'tester',active:true});assert.equal((await call()).ok,false);
 dbRoom({...st,testMode:true,createdBy:'judge',ownerUid:'judge',meta:{...st.meta,eventAuthority:'test'}},{role:'tester',active:true});assert.equal((await call()).ok,true);
 dbRoom({...st,ownerUid:'judge',meta:{...st.meta,eventAuthority:'community'}},{role:'player',active:true});assert.equal((await call()).ok,true);
 console.log('PASS: stable skip queue; reload; only-match recovery; busy/paused/idle courts; preserved scores; duplicate claims; latest-state transaction; stale scoring; station roles; archive; tester and community boundaries.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});

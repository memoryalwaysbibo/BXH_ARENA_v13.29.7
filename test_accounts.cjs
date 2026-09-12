const fs=require("fs");
const vm=require("vm");

const file=process.argv[2] || require("path").join(__dirname,"index.html");
const html=fs.readFileSync(file,"utf8");
function assert(condition,message){if(!condition)throw new Error(message);}
function extract(source,marker){
  const start=source.indexOf(marker);assert(start>=0,`找不到 ${marker}`);
  const brace=source.indexOf("{",start);let depth=0,quote=null,escaped=false;
  for(let i=brace;i<source.length;i++){
    const ch=source[i];
    if(quote){if(escaped)escaped=false;else if(ch==="\\")escaped=true;else if(ch===quote)quote=null;continue;}
    if(ch==='"'||ch==="'"||ch==="`"){quote=ch;continue;}
    if(ch==="{")depth++;
    if(ch==="}"&&--depth===0)return source.slice(start,i+1);
  }
  throw new Error(`區塊未結束 ${marker}`);
}

const functionNames=[
  "accountTimestampValue","formatAccountTimestamp","accountActivityStatus","accountActivitySummary","accountPrimaryName","accountGameId",
  "accountRoleMatches","accountRoleCount","accountMatchesActivity","getVisibleAccountUsers"
];
const source=functionNames.map(name=>extract(html,`function ${name}(`)).join("\n");
const now=2_000_000_000_000;
const users=[
  {uid:"1",realName:"黑爸",email:"boss@gmail.com",role:"super_admin",active:true,createdAt:now-5000,lastLoginAt:now-1000},
  {uid:"2",displayName:"小宇",email:"admin@gmail.com",role:"admin",active:true,createdAt:now-4000,lastLoginAt:now-2*86400000},
  {uid:"3",displayName:"工作甲",email:"staff@gmail.com",role:"staff",active:false,createdAt:now-3000,lastLoginAt:now-1000},
  {uid:"4",displayName:"封測乙",email:"test@gmail.com",role:"tester",active:true,createdAt:now-2000,lastLoginAt:now-8*86400000},
  {uid:"5",realName:"玩家丙",gameId:"PlayerC",email:"player@gmail.com",role:"player",active:true,createdAt:now-1000,lastLoginAt:null},
  {uid:"6",displayName:"觀眾丁",email:"view@gmail.com",role:"viewer",active:true,createdAt:now-6000,lastLoginAt:now-6*86400000}
];
const context={Intl,Date,Number,String,accountMgmtQuery:"",accountMgmtRoleFilter:"all",accountMgmtStatusFilter:"all",accountMgmtActivityFilter:"all",accountMgmtSort:"created-desc"};
vm.createContext(context);vm.runInContext(source,context);

assert(context.accountRoleCount(users,"all")===6,"全部帳號數量錯誤");
assert(context.accountRoleCount(users,"management")===2,"管理層合計應包含最高管理員與管理員");
assert(context.accountRoleCount(users,"player")===1,"玩家分類數量錯誤");

const summary=context.accountActivitySummary(users,now);
assert(summary.total===6&&summary.enabled===5,"全部／啟用帳號統計錯誤");
assert(summary.daily===1,"日活躍只應統計啟用帳號");
assert(summary.weekly===3,"週活躍應包含日活躍且只統計啟用帳號");

context.accountMgmtRoleFilter="management";
let visible=context.getVisibleAccountUsers(users,now);
assert(visible.length===2&&visible.every(u=>u.role==="super_admin"||u.role==="admin"),"管理層快速分類錯誤");
context.accountMgmtRoleFilter="all";context.accountMgmtStatusFilter="inactive";
visible=context.getVisibleAccountUsers(users,now);
assert(visible.length===1&&visible[0].role==="staff","停用帳號篩選錯誤");
context.accountMgmtStatusFilter="all";context.accountMgmtActivityFilter="weekly";
visible=context.getVisibleAccountUsers(users,now);
assert(visible.length===4,"近 7 天篩選應包含日活躍並可顯示停用帳號");
context.accountMgmtActivityFilter="never";
visible=context.getVisibleAccountUsers(users,now);
assert(visible.length===1&&visible[0].role==="player","從未登入篩選錯誤");
context.accountMgmtActivityFilter="all";context.accountMgmtQuery="playerc";
visible=context.getVisibleAccountUsers(users,now);
assert(visible.length===1&&visible[0].uid==="5","遊戲 ID 搜尋錯誤");
context.accountMgmtQuery="";context.accountMgmtSort="created-desc";
visible=context.getVisibleAccountUsers(users,now);
assert(visible[0].uid==="5","申辦時間最新排序錯誤");
context.accountMgmtSort="activity-desc";
visible=context.getVisibleAccountUsers(users,now);
assert(["1","3"].includes(visible[0].uid),"最近登入排序錯誤");

assert(html.includes('data-action="account-role-filter"'),"快速角色分類按鈕不存在");
assert(html.includes('class="account-user-card"'),"精簡帳號卡片不存在");
assert(html.includes('data-filter-key="status"')&&html.includes('data-filter-key="activity"')&&html.includes('data-filter-key="sort"'),"狀態／活躍度／排序篩選不完整");
assert(/\.account-role-filter-bar\{[^}]*flex-wrap:wrap/.test(html),"角色分類列在窄螢幕不可換行");
assert(/\.account-user-email\{[^}]*overflow-wrap:anywhere/.test(html),"長 Email 缺少斷行保護");
assert(/@media\(max-width:640px\)[\s\S]*?\.account-detail-grid\{grid-template-columns:1fr;\}/.test(html),"手機詳細資料未切換為單欄");
assert(!extract(html,"function renderAccountManagementScreen()").includes('account-management-table'),"帳號管理仍使用舊橫向表格");
assert(extract(html,'if(action==="create-managed-user-submit")').includes("normalizeLoginEmail(identifier)"),"新增帳號未沿用 Gmail 簡化輸入");
assert(html.includes('帳號管理仍僅限 super_admin'),"版本紀錄未聲明權限不變");

Object.assign(context,{
  safeEngagementRender:fn=>fn(),
  accountMgmtUsers:users,ACCOUNT_ROLE_FILTERS:[["all","全部"],["management","管理層"],["super_admin","最高管理員"],["admin","管理員"],["staff","工作人員"],["tester","封測帳號"],["player","玩家"],["viewer","觀眾"]],
  accountMgmtRoleFilter:"all",accountMgmtStatusFilter:"all",accountMgmtActivityFilter:"all",accountMgmtSort:"created-desc",accountMgmtQuery:"",
  authFormError:"",accountMgmtBusy:false,legacyPublicDocsPreview:null,legacyCleanupResult:null,legacyCleanupBusy:false,
  LOGO_SRC:"logo.png",APP_VERSION:"v13.28.9",esc(value){return String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;");},
  roleDisplayLabel(role){return role;},topbarConnectionRailHtml(){return "";},accountMenuHtml(){return "";},accountMenuOverlayHtml(){return "";},renderModal(){return "";},renderEngagementAdminPanel(){return "";}
});
vm.runInContext(extract(html,"function renderAccountManagementScreen()"),context);
const rendered=context.renderAccountManagementScreen();
assert(rendered.includes("黑爸")&&rendered.includes("boss@gmail.com"),"帳號摘要未正確渲染姓名與 Email");
assert(rendered.includes("管理層 2")&&rendered.includes("玩家 1"),"快速分類數量未正確渲染");
assert(rendered.includes('<details class="account-user-card">'),"帳號詳細資料未使用可展開結構");
console.log("v13.28.9 account-tests-ok: counts, filters, activity, search, sort, compact-details");

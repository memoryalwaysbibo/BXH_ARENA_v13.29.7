const fs = require("fs");
const vm = require("vm");

const file = process.argv[2] || require("path").join(__dirname,"index.html");
const html = fs.readFileSync(file,"utf8");

function assert(condition,message){ if(!condition) throw new Error(message); }
function extractBraceBlock(source,marker){
  const start=source.indexOf(marker);
  assert(start>=0,`找不到區塊：${marker}`);
  const brace=source.indexOf("{",start);
  let depth=0,quote=null,escaped=false;
  for(let i=brace;i<source.length;i++){
    const ch=source[i];
    if(quote){
      if(escaped) escaped=false;
      else if(ch==="\\") escaped=true;
      else if(ch===quote) quote=null;
      continue;
    }
    if(ch==='"'||ch==="'"||ch==="`"){ quote=ch; continue; }
    if(ch==="{") depth++;
    if(ch==="}"&&--depth===0) return source.slice(start,i+1);
  }
  throw new Error(`區塊未結束：${marker}`);
}

function testNormalization(){
  const source=[
    extractBraceBlock(html,"function normalizeLoginEmail(value)"),
    extractBraceBlock(html,"function loginIdentifierDisplayValue(value)"),
    extractBraceBlock(html,"function normalizeAuthEmailForMatch(value)")
  ].join("\n");
  const context={};
  vm.createContext(context);
  vm.runInContext(source,context);
  const cases=[
    ["bxhplayer","bxhplayer@gmail.com"],
    ["  Bxh.Player+1  ","bxh.player+1@gmail.com"],
    ["USER@GMAIL.COM","user@gmail.com"],
    ["member@yahoo.com","member@yahoo.com"],
    ["",""]
  ];
  for(const [input,expected] of cases){
    assert(context.normalizeLoginEmail(input)===expected,`帳號正規化錯誤：${input}`);
  }
  assert(context.loginIdentifierDisplayValue("user@gmail.com")==="user","記住的 Gmail 應只顯示 @ 前帳號");
  assert(context.loginIdentifierDisplayValue("member@yahoo.com")==="member@yahoo.com","非 Gmail 完整 Email 不得縮短");
  assert(context.normalizeAuthEmailForMatch("USER")===context.normalizeAuthEmailForMatch("user@gmail.com"),"簡化帳號與 Firebase Session 應視為同帳號");
}

async function testPasswordAndSessionPreserved(){
  const passwordBlock=extractBraceBlock(html,'if(action==="toggle-login-password")');
  assert(!passwordBlock.includes("render()"),"顯示密碼不得重新渲染登入頁");
  const input={type:"password",value:"Keep#123",selectionStart:2,selectionEnd:4,focus(){},setSelectionRange(a,b){this.selectionStart=a;this.selectionEnd=b;}};
  const field={querySelector:()=>input};
  const target={closest:()=>field,setAttribute(){},innerHTML:""};
  const context={action:"toggle-login-password",target,showLoginPassword:false,EYE_OFF_SVG:"OFF",EYE_TOGGLE_SVG:"ON"};
  vm.createContext(context);
  vm.runInContext(`(function(){${passwordBlock}})()`,context);
  assert(input.type==="text"&&input.value==="Keep#123","顯示密碼後內容必須保留");

  const helperSource=[
    extractBraceBlock(html,"function normalizeLoginEmail(value)"),
    extractBraceBlock(html,"function normalizeAuthEmailForMatch(value)"),
    extractBraceBlock(html,"async function reconcileExistingAuthSession(expectedEmail, intent)")
  ].join("\n");
  let processed=0;
  const authContext={
    window:{cloudAuth:{getCurrentUser:()=>({email:"user@gmail.com"})}},
    pendingLoginIntent:null,authVerifying:false,loginError:"",playerLoginError:"",
    startVerifyingTimeout(){},render(){},async processAuthStateChange(){processed++;}
  };
  vm.createContext(authContext);
  vm.runInContext(helperSource,authContext);
  const result=await authContext.reconcileExistingAuthSession("USER","player");
  assert(result.status==="resumed"&&processed===1,"Gmail 簡化帳號應能接續同帳號 Session");
}

function testHandlerCoverage(){
  const playerLogin=extractBraceBlock(html,'if(action==="player-email-signin")');
  const playerReset=extractBraceBlock(html,'if(action==="player-forgot-password")');
  const adminLogin=extractBraceBlock(html,'if(action==="admin-login-submit")');
  const adminReset=extractBraceBlock(html,'if(action==="admin-forgot-password")');
  for(const [name,block] of [["玩家登入",playerLogin],["玩家忘記密碼",playerReset],["管理登入",adminLogin],["管理忘記密碼",adminReset]]){
    assert(block.includes("normalizeLoginEmail(identifier)"),`${name} 未套用帳號正規化`);
  }
  assert(adminLogin.includes("pendingRememberEmail = rememberUsername ? email : null"),"記住帳號必須保存完整正規化 Email");
  assert(html.includes('loginIdentifierDisplayValue(rememberedUsername||"")'),"記住的 Gmail 未轉為簡化顯示");
  assert((html.match(/inputmode="email"/g)||[]).length>=2,"兩種登入頁都應保留 Email 鍵盤提示");
}

(async()=>{
  testNormalization();
  await testPasswordAndSessionPreserved();
  testHandlerCoverage();
  console.log("v13.28.8 auth-tests-ok: shorthand, full-email, reset, remember, password, session");
})().catch(error=>{console.error(error.stack||error.message);process.exit(1);});

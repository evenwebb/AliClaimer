const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname,'..','content-order-list.js'),'utf8');
function runCollector({tabs=[],links=[]}) {
  const listeners=[]; let response;
  const context=vm.createContext({
    URL,Map,Set,Date,Promise,location:{origin:'https://www.aliexpress.com'},
    document:{querySelectorAll(selector){
      if(selector==='[role="tab"],[role="radio"],[class*="tab"],button,a') return tabs;
      if(selector==='button') return [];
      if(selector==='a[href*="orderId="]') return links;
      return [];
    }},
    chrome:{runtime:{onMessage:{addListener(fn){listeners.push(fn);}}}},
    setTimeout,clearTimeout
  });
  vm.runInContext(source,context,{filename:'content-order-list.js'});
  listeners[0]({action:'collectOrders'},{},value=>{response=value;});
  return new Promise(resolve=>{
    const poll=()=>response!==undefined?resolve(response):setImmediate(poll);
    poll();
  });
}
const processedTab={textContent:'Completed',getAttribute:name=>name==='aria-selected'?'true':null,className:'',classList:{contains:()=>false}};

test('returns only supported numeric order-detail URLs',async()=>{
  const result=await runCollector({tabs:[processedTab],links:[
    {href:'https://www.aliexpress.com/p/order/detail.html?orderId=12345'},
    {href:'https://evil.example/p/order/detail.html?orderId=777'},
    {href:'https://www.aliexpress.com/p/order/detail.html?orderId=bad'},
    {href:'https://www.aliexpress.com/p/order/detail.html?orderId=12345'}
  ]});
  assert.deepEqual(Array.from(result.orderIds),['12345']);
  assert.equal(result.error,undefined);
});

test('reports an actionable compatibility error when the expected language tab is absent',async()=>{
  const result=await runCollector({tabs:[],links:[]});
  assert.match(result.error,/Completed orders tab/);
  assert.match(result.error,/English/);
});

test('recognizes the Completed tab when its label includes an order count',async()=>{
  const completed={textContent:'Completed (12)',getAttribute:name=>name==='aria-selected'?'true':null,className:'',classList:{contains:()=>false}};
  const result=await runCollector({tabs:[completed],links:[{href:'https://www.aliexpress.com/p/order/detail.html?orderId=45678'}]});
  assert.deepEqual(Array.from(result.orderIds),['45678']);
});

test('checks a rendered order in a hidden frame without opening tabs',async()=>{
  const collect={textContent:'Collect',disabled:false,getAttribute(){return null;}};
  const page={querySelectorAll(){return [collect];},querySelector(){return{};},body:{innerText:'Order details'}};
  let frame;
  const context=vm.createContext({
    URL,Map,Set,Date,Promise,location:{origin:'https://www.aliexpress.com'},
    document:{readyState:'loading',documentElement:null,body:{append(value){value.contentWindow={location:{get href(){return value.src;}}};value.contentDocument=page;value.onload();}},addEventListener(){},querySelectorAll(){return[];},createElement(){frame={setAttribute(){},remove(){},style:{},};return frame;}},
    chrome:{runtime:{onMessage:{addListener(){}}}},setTimeout,clearTimeout
  });
  vm.runInContext(source,context,{filename:'content-order-list.js'});
  const result=await context.checkCouponAvailability('12345');
  assert.equal(result.status,'available');
  assert.match(frame.src,/orderId=12345/);
  assert.equal(frame.remove instanceof Function,true);
  assert.equal(context.chrome.tabs,undefined);
});

test('debug logging is opt-in and masks complete order IDs',async()=>{
  const logs=[];
  const context=vm.createContext({
    URL,Map,Set,Date,Promise,location:{origin:'https://www.aliexpress.com'},
    document:{readyState:'loading',documentElement:null,addEventListener(){},querySelectorAll(){return[];}},
    chrome:{runtime:{onMessage:{addListener(){}}},storage:{local:{async get(){return{aliclaimerSettings:{debugCouponChecks:true}};}}}},
    console:{info(...args){logs.push(args);}},setTimeout,clearTimeout
  });
  vm.runInContext(source,context,{filename:'content-order-list.js'});
  await context.debugLog('test-event',{orderId:'12345678',status:'available',reason:'Error: The background order check timed out.',checkId:3,pageKind:'empty-page'});
  assert.equal(logs.length,1);
  assert.equal(logs[0][0],'[AliClaimer coupon debug]');
  assert.equal(logs[0][1],'test-event');
  const details=JSON.parse(logs[0][2]);
  assert.equal(details.order,'…5678');
  assert.equal(details.status,'available');
  assert.equal(details.reason,'Error: The background order check timed out.');
  assert.equal(details.checkId,3);
  assert.equal(details.pageKind,'empty-page');
  assert.equal(JSON.stringify(logs[0]).includes('12345678'),false);
});

test('recognizes alternate English order copy and coupon action labels',()=>{
  const context=vm.createContext({
    URL,Map,Set,Date,Promise,location:{origin:'https://www.aliexpress.com'},
    document:{readyState:'loading',documentElement:null,addEventListener(){},querySelectorAll(){return[];}},
    chrome:{runtime:{onMessage:{addListener(){}}}},setTimeout,clearTimeout
  });
  vm.runInContext(source,context,{filename:'content-order-list.js'});
  const coupon={textContent:'Get coupon',disabled:false,getAttribute(){return null;}};
  const unsafe={textContent:'Claim refund',disabled:false,getAttribute(){return null;}};
  const page={querySelectorAll(){return[coupon,unsafe];},querySelector(){return null;},body:{innerText:'Order placed · Shipment details'}};
  assert.equal(context.isRecognizedOrderPage(page),true);
  assert.equal(context.findCollectButton(page),coupon);
});

test('detects AliExpress service-progress coupon controls rendered as divs',()=>{
  const context=vm.createContext({
    URL,Map,Set,Date,Promise,location:{origin:'https://www.aliexpress.com'},
    document:{readyState:'loading',documentElement:null,addEventListener(){},querySelectorAll(){return[];}},
    chrome:{runtime:{onMessage:{addListener(){}}}},setTimeout,clearTimeout
  });
  vm.runInContext(source,context,{filename:'content-order-list.js'});
  const progressCoupon={textContent:'Collect ￡1',disabled:false,getAttribute(){return null;},matches(selector){return selector==='.service-progress-button';}};
  const page={querySelectorAll(){return[progressCoupon];},querySelector(){return null;},body:{innerText:'If delivered after Oct 9, 2026 you can collect an extra ￡1 coupon'}};
  assert.equal(context.findCollectButton(page),progressCoupon);
  assert.equal(context.inspectCouponPage(page).collectLabelCount,1);
  const dollarCoupon={textContent:'Collect $1',disabled:false,getAttribute(){return null;},matches(selector){return selector==='.service-progress-button';}};
  const dollarPage={querySelectorAll(selector){return selector==='.service-progress-node-completed .service-progress-node-text'?[{textContent:'Use $1'}]:[dollarCoupon];},querySelector(){return null;},body:{innerText:'If delivered late you can collect an extra $1 coupon'}};
  assert.equal(context.findCollectButton(dollarPage),dollarCoupon);
  assert.deepEqual(Array.from(context.completedProgressCouponLabels(dollarPage)),['use $1']);
});

test('confirms AliExpress coupon-ready text inside its same-origin modal iframe',()=>{
  const context=vm.createContext({
    URL,Map,Set,Date,Promise,location:{origin:'https://www.aliexpress.com'},
    document:{readyState:'loading',documentElement:null,addEventListener(){},querySelectorAll(){return[];}},
    chrome:{runtime:{onMessage:{addListener(){}}}},setTimeout,clearTimeout
  });
  vm.runInContext(source,context,{filename:'content-order-list.js'});
  const modal={contentDocument:{body:{innerText:'Your coupon code is ready. You can already find it in Account > Coupons, and use it on your next order.'}}};
  const page={querySelectorAll(selector){return selector==='iframe.otg-modal-iframe'?[modal]:[];},body:{innerText:'Order details'}};
  assert.equal(context.couponClaimConfirmation(page),'coupon-ready-modal');
});

test('classifies an AliExpress security interstitial without logging page text',()=>{
  const context=vm.createContext({
    URL,Map,Set,Date,Promise,location:{origin:'https://www.aliexpress.com'},
    document:{readyState:'loading',documentElement:null,addEventListener(){},querySelectorAll(){return[];}},
    chrome:{runtime:{onMessage:{addListener(){}}}},setTimeout,clearTimeout
  });
  vm.runInContext(source,context,{filename:'content-order-list.js'});
  const details=context.inspectCouponPage({
    title:'Security verification',
    documentElement:{lang:'en-GB',childElementCount:2},
    scripts:[{},{}],
    querySelector(){return null;},
    querySelectorAll(){return[];},
    body:{innerText:'Complete security verification for account 12345678'}
  });
  assert.equal(details.pageKind,'security-check');
  assert.equal(details.pageLanguage,'en-GB');
  assert.equal(details.scriptCount,2);
  assert.equal(JSON.stringify(details).includes('12345678'),false);
});

test('claims through the hidden order frame and records only an AliExpress confirmation',async()=>{
  let clicks=0,frame,buttonRemoved=false,completedCoupons=[];
  const button={textContent:'Collect ￡1',disabled:false,getAttribute(){return null;},matches(selector){return selector==='.service-progress-button';},click(){clicks++;buttonRemoved=true;setTimeout(()=>{completedCoupons=[{textContent:'Use ￡1'}];},650);}};
  const page={querySelectorAll(selector){return selector==='.service-progress-node-completed .service-progress-node-text'?completedCoupons:[button];},querySelector(){return{};},contains(){return !buttonRemoved;},body:{innerText:'Order details'}};
  const saved={}; const messages=[];
  const badge={dataset:{orderId:'12345'},replaceChildren(){},set textContent(value){this.label=value;},get textContent(){return this.label;},set title(value){this.note=value;}};
  const notice={textContent:'',style:{}};
  const context=vm.createContext({
    URL,Map,Set,Date,Promise,location:{origin:'https://www.aliexpress.com'},
    document:{readyState:'loading',documentElement:null,body:{append(value){value.contentWindow={location:{get href(){return value.src;}}};value.contentDocument=page;value.onload();},prepend(){}},addEventListener(){},querySelectorAll(){return[];},createElement(){frame={setAttribute(){},remove(){},style:{}};return frame;},getElementById(){return notice;}},
    chrome:{runtime:{onMessage:{addListener(){}},sendMessage:async message=>{messages.push(message);return{ok:true};}},storage:{local:{async get(){return{aliclaimerAvailability:saved};},async set(value){Object.assign(saved,value.aliclaimerAvailability);}}}},setTimeout,clearTimeout
  });
  vm.runInContext(source,context,{filename:'content-order-list.js'});
  await context.claimCouponAvailability('12345',badge);
  assert.equal(clicks,1);
  assert.equal(badge.label,'Coupon claimed');
  assert.equal(saved['12345'].status,'claimed');
  assert.ok(messages.some(message=>message.action==='recordCouponClaim'&&message.orderId==='12345'));
});

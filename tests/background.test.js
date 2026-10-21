const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
function app(initial = {}) {
  const storage = { ...initial }, tabs = new Map([[7,{id:7,url:'https://www.aliexpress.com/p/order/index.html'}]]);
  const timers = new Map(); let nextTimer = 0, listener;
  const alarms = new Map();
  const chrome = {
    runtime:{id:'ext',onMessage:{addListener(fn){listener=fn;}},onStartup:{addListener(){}},onInstalled:{addListener(){}}},
    storage:{local:{
      async get(keys){const names=Array.isArray(keys)?keys:[keys];return Object.fromEntries(names.map(key=>[key,storage[key]]));},
      async set(values){Object.assign(storage,values);},async remove(keys){for(const key of Array.isArray(keys)?keys:[keys])delete storage[key];}
    }},
    tabs:{onRemoved:{addListener(){}},async get(id){return tabs.get(id);},async update(id,change){const tab={...tabs.get(id),...change};tabs.set(id,tab);return tab;},async query(){return [tabs.get(7)];},async sendMessage(){}},
    alarms:{onAlarm:{addListener(){}},create(name,options){alarms.set(name,options);},clear(name){alarms.delete(name);}},
    action:{setBadgeText(){},setBadgeBackgroundColor(){}}
  };
  const context=vm.createContext({chrome,URL,Date,Set,Map,Array,Number,Object,Promise,console,crypto:{randomUUID:()=> 'session-1'},setTimeout(fn){const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);}});
  vm.runInContext(source,context,{filename:'background.js'});
  async function send(message,sender={id:'ext',url:'chrome-extension://ext/popup.html'}) {
    let response; listener(message,sender,value=>{response=value;});
    for(let i=0;i<50&&response===undefined;i++) await new Promise(resolve=>setImmediate(resolve));
    return response;
  }
  async function tick() { const [id,fn]=timers.entries().next().value||[]; if(fn){timers.delete(id);fn();await new Promise(resolve=>setImmediate(resolve));} }
  return {storage,tabs,alarms,send,tick};
}
const pageSender=(tabId,id)=>({id:'ext',tab:{id:tabId},frameId:0,url:`https://www.aliexpress.com/p/order/detail.html?orderId=${id}&aliclaimer=1`});

test('imports claimed IDs, authorizes only the active order, and pauses at the claim-attempt limit',async()=>{
  const system=app({aliclaimerClaimed:['111']});
  const state=await system.send({action:'getState'});
  assert.equal(state.history[0].status,'claimed');
  const start=await system.send({action:'startScan',tabId:7,orderIds:['111','222','333'],previewMode:false,maxClaims:1,delayMs:0});
  assert.equal(start.ok,true);
  assert.match(system.tabs.get(7).url,/orderId=222&aliclaimer=1/);
  const rejected=await system.send({action:'authorizeOrder',orderId:'222'},pageSender(8,'222'));
  assert.equal(rejected.ok,false);
  const allowed=await system.send({action:'authorizeOrder',orderId:'222'},pageSender(7,'222'));
  assert.equal(allowed.ok,true);
  const result=await system.send({action:'orderResult',orderId:'222',status:'claimed'},pageSender(7,'222'));
  assert.equal(result.ok,true);
  await system.tick();
  const after=await system.send({action:'getState'});
  assert.equal(after.session.status,'paused');
  assert.equal(after.session.claimsAttempted,1);
  assert.equal(after.history.find(row=>row.orderId==='222').status,'claimed');
  const resumed=await system.send({action:'resume'});
  assert.equal(resumed.ok,true);
  assert.match(system.tabs.get(7).url,/orderId=333/);
});

test('pause marks an unresolved order uncertain and prevents an automatic retry',async()=>{
  const system=app();
  await system.send({action:'startScan',tabId:7,orderIds:['444','555'],maxClaims:2,delayMs:0});
  const paused=await system.send({action:'pause'});
  assert.equal(paused.ok,true);
  const state=await system.send({action:'getState'});
  assert.equal(state.session.status,'paused');
  assert.equal(state.session.index,1);
  assert.equal(state.history.find(row=>row.orderId==='444').status,'uncertain');
  await system.send({action:'resume'});
  assert.match(system.tabs.get(7).url,/orderId=555/);
});

test('records an explicitly claimed coupon from the AliExpress order list',async()=>{
  const system=app();
  const result=await system.send({action:'recordCouponClaim',orderId:'98765'},{id:'ext',tab:{id:7},frameId:0,url:'https://www.aliexpress.com/p/order/index.html'});
  assert.equal(result.ok,true);
  const state=await system.send({action:'getState'});
  assert.equal(state.history.find(row=>row.orderId==='98765').status,'claimed');
  const rejected=await system.send({action:'recordCouponClaim',orderId:'98766'},{id:'ext',tab:{id:7},frameId:0,url:'https://www.aliexpress.com/p/order/detail.html?orderId=98766'});
  assert.equal(rejected.ok,false);
});

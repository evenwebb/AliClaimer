const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'..','content-order-detail.js'),'utf8');

test('claims at most one coupon per order and records explicit confirmation',async()=>{
  const messages=[]; let clicks=0; let completedCoupons=[];
  const body={innerText:'Order details',prepend(){}};
  const buttons=[
    {textContent:'Collect ￡1',disabled:false,getAttribute(){return null;},matches(selector){return selector==='.service-progress-button';},click(){clicks++;body.innerText='Order details updated';completedCoupons=[{textContent:'Use ￡1'}];},isConnected:true},
    {textContent:'Collect',disabled:false,getAttribute(){return null;},matches(){return false;},click(){clicks++;body.innerText='Coupon collected successfully';},isConnected:true}
  ];
  const context=vm.createContext({
    URLSearchParams,Date,Promise,console,
    location:{search:'?orderId=12345&aliclaimer=1'},
    document:{readyState:'complete',body,querySelectorAll(selector){return selector==='.service-progress-node-completed .service-progress-node-text'?completedCoupons:buttons;},contains(){return true;},createElement(){return{setAttribute(){},style:{},remove(){}};},addEventListener(){}},
    chrome:{runtime:{sendMessage(message){messages.push(message);return Promise.resolve({ok:true,previewMode:false});},onMessage:{addListener(){}}}},
    setTimeout(fn){queueMicrotask(fn);return 1;}
  });
  vm.runInContext(source,context,{filename:'content-order-detail.js'});
  for(let i=0;i<30&&!messages.some(message=>message.action==='orderResult');i++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(clicks,1);
  assert.equal(messages.filter(message=>message.action==='orderResult')[0].status,'claimed');
});

'use strict';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const AVAILABILITY_TTL_MS = 24 * 60 * 60 * 1000;
const AVAILABILITY_SOURCE = 'hidden-frame-v4';
const availabilityInFlight = new Set();
const claimsInFlight = new Set();
let collectionCancelled = false;
let availabilityUpdateInFlight = false;
let availabilityRerunRequested = false;
let debugCouponChecks = false;
let lastDebugBatchKey='';
let nextCouponCheckId=0;
const debugSettingsReady=Promise.resolve()
  .then(()=>chrome.storage?.local?.get?.('aliclaimerSettings'))
  .then(data=>{debugCouponChecks=data?.aliclaimerSettings?.debugCouponChecks===true;})
  .catch(()=>{});
async function debugLog(event,details={}) {
  await debugSettingsReady;
  if(!debugCouponChecks) return;
  const safe={};
  if(details.orderId) safe.order=`…${String(details.orderId).slice(-4)}`;
  for(const key of ['status','count','reason','path','readyState','recognized','hasCollect','bodyTextLength','actionButtonCount','buttonCount','collectLabelCount','orderMarkerCount','checkId','pageKind','pageLanguage','rootChildCount','scriptCount']) if(details[key]!==undefined) safe[key]=details[key];
  if(details.statusCounts) safe.statusCounts=details.statusCounts;
  console.info('[AliClaimer coupon debug]',event,JSON.stringify(safe));
}
function debugErrorReason(error) {
  const name=String(error?.name||'Error');
  const message=String(error?.message||'').replace(/https?:\/\/[^\s"'<>]+/gi,'[url]').replace(/\b\d{6,}\b/g,'[number]').slice(0,180);
  return message?`${name}: ${message}`:name;
}
function orderLinks() {
  const ids = new Map();
  for (const link of document.querySelectorAll('a[href*="orderId="]')) {
    try {
      const url = new URL(link.href || link.getAttribute('href'), location.origin);
      const values = url.searchParams.getAll('orderId');
      if (url.protocol !== 'https:' || url.hostname !== 'www.aliexpress.com' ||
          url.pathname !== '/p/order/detail.html' || values.length !== 1 || !/^\d+$/.test(values[0])) continue;
      ids.set(values[0], `https://www.aliexpress.com/p/order/detail.html?orderId=${encodeURIComponent(values[0])}`);
    } catch {}
  }
  return ids;
}
function completedOrderEntries() {
  const tab=findCompletedTab();
  if (!tab) return [];
  const selected=isSelectedTab(tab);
  if (!selected) return [];
  const entries=[]; const seen=new Set();
  for (const link of document.querySelectorAll('a[href*="orderId="]')) {
    try {
      const url=new URL(link.href||link.getAttribute('href'),location.origin), ids=url.searchParams.getAll('orderId');
      if (url.protocol!=='https:'||url.hostname!=='www.aliexpress.com'||url.pathname!=='/p/order/detail.html'||ids.length!==1||!/^\d+$/.test(ids[0])||seen.has(ids[0])) continue;
      let row=link;
      for(let i=0;i<12&&row?.parentElement;i++,row=row.parentElement) if(row.matches?.('[class*="order-item"],[class*="order-card"],[class*="order-list-item"]')) break;
      if(!row) continue;
      const text=(row.innerText||'').toLowerCase();
      if(/cancelled|canceled|awaiting payment|awaiting shipment|to be shipped|in transit/.test(text)) continue;
      seen.add(ids[0]); entries.push({id:ids[0],link});
    } catch {}
  }
  return entries;
}
function renderAvailability(badge,status,note='') {
  const label=({none:'No coupon',checking:'Checking coupon…',claiming:'Claiming coupon…',claimed:'Coupon claimed',uncertain:'Claim result unclear',unsupported:'Could not check coupon',unchecked:'Not checked yet'})[status]||'Not checked yet';
  const title=note||(status==='available'?'Claim this coupon from AliExpress':label);
  if(badge.dataset.state===status&&badge.title===title&&(
    status==='available'?!!badge.querySelector?.('.aliclaimer-claim'):badge.textContent===label&&badge.childElementCount===0
  )) return;
  badge.dataset.state=status;
  badge.replaceChildren();
  if(status==='available') {
    const button=document.createElement('button'); button.type='button'; button.textContent='Claim'; button.className='aliclaimer-claim';
    button.title=title; button.addEventListener('click',()=>claimCouponAvailability(badge.dataset.orderId,badge)); badge.append(button);
  } else badge.textContent=label;
  badge.title=title;
}
function ensureAvailabilityBadge(entry) {
  let badge=document.querySelector(`.aliclaimer-availability[data-order-id="${entry.id}"]`);
  if(!badge) { badge=document.createElement('span'); badge.className='aliclaimer-availability'; badge.dataset.orderId=entry.id; badge.setAttribute('role','status'); badge.setAttribute('aria-live','polite'); entry.link.insertAdjacentElement('afterend',badge); }
  return badge;
}
function showAvailabilityNotice(text) {
  let notice=document.getElementById('aliclaimer-availability-notice');
  if(!notice) { notice=document.createElement('div'); notice.id='aliclaimer-availability-notice'; notice.setAttribute('role','status'); notice.setAttribute('aria-live','polite'); notice.style.cssText='margin:10px;padding:10px;border:1px solid #f0d39b;border-radius:8px;background:#fff8e8;color:#754d00;font:600 13px system-ui,sans-serif'; (document.body||document.documentElement).prepend(notice); }
  notice.textContent=text;
}
function revealClaimFrame(frame) {
  frame.title='Finish this coupon claim on AliExpress';
  frame.tabIndex=0;
  frame.removeAttribute('aria-hidden');
  frame.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;opacity:1;pointer-events:auto;border:0;background:#fff;z-index:2147483646';
  const close=document.createElement('button');
  close.type='button'; close.textContent='Close AliExpress order'; close.setAttribute('aria-label','Close the AliExpress order view');
  close.style.cssText='position:fixed;top:12px;right:12px;z-index:2147483647;padding:10px 14px;border:0;border-radius:8px;background:#176b35;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer';
  close.addEventListener('click',()=>{frame.remove();close.remove();});
  (document.body||document.documentElement).append(close);
  return close;
}
async function loadOrderDetailFrame(orderId) {
  const url=new URL('/p/order/detail.html',location.origin); url.searchParams.set('orderId',orderId);
  const frame=document.createElement('iframe'); frame.title='AliExpress coupon check'; frame.tabIndex=-1;
  frame.setAttribute('aria-hidden','true'); frame.style.cssText='position:fixed;left:-10000px;top:0;width:1024px;height:768px;opacity:0;pointer-events:none;border:0';
  await debugLog('frame-load-start',{orderId,path:url.pathname});
  let timeoutId;
  try {
    const loaded=new Promise((resolve,reject)=>{frame.onload=resolve;frame.onerror=()=>reject(new Error('AliExpress could not load this order in the background.'));});
    frame.src=url.href; (document.body||document.documentElement).append(frame);
    await Promise.race([loaded,new Promise((_,reject)=>{timeoutId=setTimeout(()=>reject(new Error('The background order check timed out.')),15000);})]);
    const finalUrl=new URL(frame.contentWindow.location.href);
    if(finalUrl.origin!==location.origin||finalUrl.pathname!=='/p/order/detail.html') throw new Error('AliExpress redirected the background order check.');
    return frame;
  } catch(error) { await debugLog('frame-load-error',{orderId,reason:debugErrorReason(error)}); frame.remove(); throw error; }
  finally { clearTimeout(timeoutId); }
}
function isCouponCollectControl(button) {
  const label=button.textContent.trim().replace(/\s+/g,' ').toLocaleLowerCase('en-GB');
  const couponAction=/^(collect|collect coupon|claim coupon|get coupon|collect now|claim coupon now|get coupon now|receive coupon)$/.test(label);
  const progressCouponAction=button.matches?.('.service-progress-button')&&/^collect\b/i.test(label)&&/(coupon|\d)/i.test(label);
  return couponAction||progressCouponAction;
}
function isActiveCouponCollectControl(button) {
  return isCouponCollectControl(button)&&!button.disabled&&button.getAttribute('aria-disabled')!=='true';
}
function findCollectButton(page) {
  return [...page.querySelectorAll('.item-action .action-btn,button,a,[role="button"],.service-progress-button')]
    .find(isActiveCouponCollectControl);
}
function completedProgressCouponLabels(page) {
  return [...page.querySelectorAll('.service-progress-node-completed .service-progress-node-text')]
    .map(node=>node.textContent.trim().replace(/\s+/g,' ').toLocaleLowerCase('en-GB'))
    .filter(label=>/^use\b.*\d/.test(label));
}
function couponClaimConfirmation(page) {
  const pages=[page];
  for(const iframe of page.querySelectorAll('iframe.otg-modal-iframe')) {
    try { if(iframe.contentDocument) pages.push(iframe.contentDocument); } catch {}
  }
  for(const currentPage of pages) {
    const text=currentPage.body?.innerText||'';
    if(/your coupon code is ready|coupon.{0,40}(collected|claimed|received|successful)|(?:collected|claimed|received).{0,40}coupon|find it in account\s*>\s*coupons/i.test(text)) {
      return /your coupon code is ready|find it in account\s*>\s*coupons/i.test(text)?'coupon-ready-modal':'success-message';
    }
  }
  return '';
}
function isRecognizedOrderPage(page) {
  const text=page.body?.innerText||'';
  if(/captcha|robot|security verification|verify you are human/i.test(`${page.title||''} ${text}`)) return false;
  const orderContent=/order\s+(details|information|date|status|number|id|placed|time|total|items)|tracking|track order|delivery|shipping|shipment|contact seller|leave feedback|refund|buyer protection|product information/i.test(text);
  if(orderContent||page.querySelector('.item-action')) return true;
  return false;
}
function inspectCouponPage(page) {
  const bodyText=page.body?.innerText||'';
  const actionButtons=page.querySelectorAll('.item-action .action-btn');
  const buttons=page.querySelectorAll('button,a,[role="button"],.service-progress-button');
  const collectLabelCount=[...buttons].filter(button=>{
    const label=button.textContent.trim().replace(/\s+/g,' ').toLocaleLowerCase('en-GB');
    return /^(collect|collect coupon|claim coupon|get coupon|collect now|claim coupon now|get coupon now|receive coupon)$/.test(label)||
      (button.matches?.('.service-progress-button')&&/^collect\b/i.test(label)&&/(coupon|\d)/i.test(label));
  }).length;
  const orderMarkerCount=(bodyText.match(/order\s+(?:details|information|date|status|number|id)|tracking|track order|delivery|shipping|contact seller|leave feedback|refund|buyer protection/gi)||[]).length;
  const diagnosticText=`${page.title||''} ${bodyText}`;
  const pageKind=/captcha|robot|security verification|verify you are human/i.test(diagnosticText)?'security-check'
    :/sign in|log in|login/i.test(diagnosticText)?'login'
    :bodyText.length?'rendered-page':'empty-page';
  return {recognized:isRecognizedOrderPage(page),bodyTextLength:bodyText.length,actionButtonCount:actionButtons.length,buttonCount:buttons.length,collectLabelCount,orderMarkerCount,pageKind,pageLanguage:page.documentElement?.lang||'',rootChildCount:page.documentElement?.childElementCount||0,scriptCount:page.scripts?.length||0};
}
async function checkCouponAvailability(orderId) {
  let frame;
  const checkId=++nextCouponCheckId;
  await debugLog('check-start',{orderId,checkId});
  try {
    frame=await loadOrderDetailFrame(orderId);
    await debugLog('detail-loaded',{orderId,checkId,path:new URL(frame.contentWindow.location.href).pathname,readyState:frame.contentDocument.readyState});
    const started=Date.now();
    while(Date.now()-started<12000) {
      const page=frame.contentDocument;
      if(completedProgressCouponLabels(page).length) { await debugLog('coupon-already-claimed',{orderId,checkId,status:'claimed'}); return {status:'claimed',note:'AliExpress shows this coupon as already claimed.'}; }
      if(findCollectButton(page)) { await debugLog('coupon-available',{orderId,checkId,hasCollect:true}); return {status:'available',note:'AliExpress shows a Collect control for this order.'}; }
      const recognized=isRecognizedOrderPage(page);
      if(recognized&&Date.now()-started>=3000) { await debugLog('coupon-not-found',{orderId,checkId,recognized:true}); return {status:'none',note:'No claimable coupon control was found.'}; }
      await sleep(250);
    }
    const diagnostics=inspectCouponPage(frame.contentDocument);
    await debugLog('detail-unrecognized',{orderId,checkId,readyState:frame.contentDocument.readyState,...diagnostics});
    const note=diagnostics.pageKind==='security-check'?'AliExpress requires a security check. Open AliExpress and complete it, then refresh this page.'
      :diagnostics.pageKind==='login'?'AliExpress did not show a signed-in order page. Sign in to AliExpress, then refresh this page.'
      :'The order page did not render coupon controls in the background. Open this order once, then refresh the completed orders page.';
    return {status:'unsupported',note};
  } catch(error) { const reason=debugErrorReason(error); await debugLog('check-error',{orderId,checkId,reason}); return {status:'unsupported',note:error.message||'Could not check this order.'}; }
  finally { frame?.remove(); await debugLog('detail-frame-removed',{orderId}); }
}
async function saveAvailabilityResult(orderId,status,note) {
  const data=await chrome.storage.local.get('aliclaimerAvailability');
  const cache=data.aliclaimerAvailability&&typeof data.aliclaimerAvailability==='object'?data.aliclaimerAvailability:{};
  cache[orderId]={status,checkedAt:Date.now(),note:String(note||'').slice(0,300),source:AVAILABILITY_SOURCE};
  const trimmed=Object.entries(cache).sort((a,b)=>(b[1]?.checkedAt||0)-(a[1]?.checkedAt||0)).slice(0,2000);
  await chrome.storage.local.set({aliclaimerAvailability:Object.fromEntries(trimmed)});
}
async function claimCouponAvailability(orderId,badge) {
  if(!/^\d+$/.test(orderId||'')||claimsInFlight.has(orderId)) return;
  claimsInFlight.add(orderId);
  renderAvailability(badge,'claiming','Claim request sent. Waiting for AliExpress confirmation.');
  let frame,clicked=false,keepFrame=false,manualClose;
  try {
    await debugLog('claim-start',{orderId});
    frame=await loadOrderDetailFrame(orderId);
    const started=Date.now(); let button;
    while(Date.now()-started<12000) {
      const page=frame.contentDocument;
      if(completedProgressCouponLabels(page).length) {
        const note='AliExpress shows this coupon as already claimed.';
        renderAvailability(badge,'claimed',note); await saveAvailabilityResult(orderId,'claimed',note);
        await chrome.runtime.sendMessage({action:'recordCouponClaim',orderId,note}).catch(()=>{}); return;
      }
      button=findCollectButton(page); if(button) break; await sleep(250);
    }
    if(!button) { const note='AliExpress no longer shows a claimable coupon.'; renderAvailability(badge,'none',note); await saveAvailabilityResult(orderId,'none',note); return; }
    const completedCouponsBefore=new Set(completedProgressCouponLabels(frame.contentDocument));
    button.click();
    clicked=true;
    await debugLog('collect-clicked',{orderId});
    // AliExpress can reload the detail frame after its coupon modal completes.
    for(let i=0;i<80;i++) {
      await sleep(250);
      const page=frame.contentDocument;
      if(!page) continue;
      const confirmation=couponClaimConfirmation(page);
      const newCompletedCoupon=completedProgressCouponLabels(page).some(label=>!completedCouponsBefore.has(label));
      if(confirmation||newCompletedCoupon) {
        const note='AliExpress confirmed the coupon claim.';
        renderAvailability(badge,'claimed',note);
        await saveAvailabilityResult(orderId,'claimed','AliExpress confirmed the coupon claim.');
        await chrome.runtime.sendMessage({action:'recordCouponClaim',orderId}).catch(()=>{});
        await debugLog('claim-confirmed',{orderId,status:'claimed',reason:confirmation||'completed-coupon-milestone'});
        manualClose?.remove(); keepFrame=false;
        showAvailabilityNotice(`Coupon claimed for order ${orderId}.`); return;
      }
      if(i===7&&!keepFrame) { manualClose=revealClaimFrame(frame); keepFrame=true; }
    }
    const note='AliExpress did not confirm the automatic claim. Use the AliExpress order view to click Collect manually, then verify the result.';
    await debugLog('claim-uncertain',{orderId,status:'uncertain'});
    renderAvailability(badge,'uncertain',note); await saveAvailabilityResult(orderId,'uncertain',note);
    if(frame&&!keepFrame) { manualClose=revealClaimFrame(frame); keepFrame=true; }
    showAvailabilityNotice(note);
  } catch(error) {
    const note=error.message||'Could not claim this coupon.';
    await debugLog('claim-error',{orderId,reason:debugErrorReason(error)});
    if(clicked) {
      renderAvailability(badge,'uncertain',note); await saveAvailabilityResult(orderId,'uncertain',note);
      if(frame&&!keepFrame) { manualClose=revealClaimFrame(frame); keepFrame=true; }
      showAvailabilityNotice('AliExpress did not confirm the claim. Use the visible order page to finish it manually.');
    } else {
      renderAvailability(badge,'unsupported',note);
      await saveAvailabilityResult(orderId,'unsupported',note);
    }
  }
  finally { if(!keepFrame) frame?.remove(); claimsInFlight.delete(orderId); }
}
async function updateAvailabilityBadges() {
  if(availabilityUpdateInFlight) return;
  availabilityUpdateInFlight=true;
  try {
  const tab=findCompletedTab();
  if(!tab) { showAvailabilityNotice('Automatic coupon checks need the English Completed orders tab.'); return; }
  if(!isSelectedTab(tab)) return;
  document.getElementById('aliclaimer-availability-notice')?.remove();
  const {aliclaimerSettings={}}=await chrome.storage.local.get('aliclaimerSettings');
  const entries=completedOrderEntries(); if(!entries.length) { showAvailabilityNotice('No completed orders were recognized on this page. Refresh or check the order layout.'); return; }
  await debugLog('visible-completed-orders',{count:entries.length});
  if(!document.getElementById('aliclaimer-availability-styles')) {
    const style=document.createElement('style'); style.id='aliclaimer-availability-styles';
    style.textContent='.aliclaimer-availability{display:inline-flex;align-items:center;margin:5px 8px;padding:6px 10px;border:1px solid #d7dfe9;border-radius:8px;background:#f3f5f8;color:#596273;font:600 12px/1.2 system-ui,sans-serif}.aliclaimer-availability[data-state="available"]{border-color:#b9dfc4;background:#eef9f0;color:#176b35}.aliclaimer-availability[data-state="unchecked"]{border-color:#c7d9f2;background:#eef5ff;color:#245c9f}.aliclaimer-availability[data-state="unsupported"],.aliclaimer-availability[data-state="uncertain"]{border-color:#f0d39b;background:#fff8e8;color:#754d00}.aliclaimer-claim{border:0;border-radius:6px;background:#176b35;color:white;padding:5px 10px;font:600 12px system-ui,sans-serif;cursor:pointer}.aliclaimer-claim:hover{background:#10552a}.aliclaimer-claim:focus-visible{outline:2px solid #245c9f;outline-offset:2px}';
    (document.head||document.documentElement).append(style);
  }
  const stored=await chrome.storage.local.get('aliclaimerAvailability');
  const cache=stored.aliclaimerAvailability&&typeof stored.aliclaimerAvailability==='object'?stored.aliclaimerAvailability:{};
  const pendingAvailabilityChecks=[];
  const statusCounts={available:0,none:0,unsupported:0,uncertain:0,claimed:0};
  for(const entry of entries) {
    const badge=ensureAvailabilityBadge(entry),record=cache[entry.id];
    if(claimsInFlight.has(entry.id)) renderAvailability(badge,'claiming','Claim request sent. Waiting for AliExpress confirmation.');
    else if(aliclaimerSettings.autoCheckCoupons===false) renderAvailability(badge,'unchecked','Automatic coupon checks are off. Turn them on in the extension popup.');
    else if(record&&['available','none','unsupported','uncertain','claimed'].includes(record.status)&&record.source===AVAILABILITY_SOURCE&&Number.isFinite(record.checkedAt)&&Date.now()-record.checkedAt<(record.status==='unsupported'?5*60*1000:AVAILABILITY_TTL_MS)) { renderAvailability(badge,record.status,record.note); statusCounts[record.status]++; }
    else if(!availabilityInFlight.has(entry.id)) { renderAvailability(badge,'checking'); availabilityInFlight.add(entry.id); pendingAvailabilityChecks.push(entry); }
  }
  const batchKey=JSON.stringify({visible:entries.length,pending:pendingAvailabilityChecks.length,statusCounts});
  if(batchKey!==lastDebugBatchKey) { lastDebugBatchKey=batchKey; await debugLog('check-batch',{count:pendingAvailabilityChecks.length,statusCounts}); }
  for(const entry of pendingAvailabilityChecks.splice(0)) {
    try { const result=await checkCouponAvailability(entry.id); cache[entry.id]={status:result.status,checkedAt:Date.now(),note:String(result.note||'').slice(0,300),source:AVAILABILITY_SOURCE}; await chrome.storage.local.set({aliclaimerAvailability:cache}); if(result.status==='claimed') await chrome.runtime.sendMessage({action:'recordCouponClaim',orderId:entry.id,note:result.note}).catch(()=>{}); renderAvailability(ensureAvailabilityBadge(entry),result.status,result.note); }
    catch(error) { renderAvailability(ensureAvailabilityBadge(entry),'unsupported',error.message); }
    finally { availabilityInFlight.delete(entry.id); }
  }
  } finally {
    availabilityUpdateInFlight=false;
    if(availabilityRerunRequested) { availabilityRerunRequested=false; scheduleAvailabilityCheck(); }
  }
}
let availabilityTimer;
function scheduleAvailabilityCheck() {
  clearTimeout(availabilityTimer);
  availabilityTimer=setTimeout(()=>{
    if(availabilityUpdateInFlight) { availabilityRerunRequested=true; return; }
    updateAvailabilityBadges().catch(()=>{});
  },400);
}
function normalizedTabLabel(el) {
  return [el.textContent,el.getAttribute('aria-label'),el.getAttribute('title')].filter(Boolean).join(' ')
    .replace(/[0-9]+/g,' ').replace(/[()]/g,' ').replace(/\s+/g,' ').trim().toLocaleLowerCase('en-GB');
}
function findCompletedTab() {
  return [...document.querySelectorAll('[role="tab"],[role="radio"],[class*="tab"],button,a')]
    .find(el => /^(completed|completed orders)$/.test(normalizedTabLabel(el)));
}
function isSelectedTab(el) {
  return el.getAttribute('aria-selected')==='true' || el.getAttribute('aria-current')==='true' ||
    el.getAttribute('aria-current')==='page' || /active|selected|current/i.test(String(el.className||''));
}
function findMoreButton() {
  return [...document.querySelectorAll('button')].find(el => /^(view orders|load more|show more)$/i.test(el.textContent.trim()) && !el.disabled);
}
async function waitForChange(before, timeout = 8000) {
  const start = Date.now();
  while (!collectionCancelled && Date.now() - start < timeout) {
    const current = orderLinks();
    if ([...current.keys()].some(id => !before.has(id))) return current;
    await sleep(250);
  }
  return orderLinks();
}
async function collectAll() {
  const tab = findCompletedTab();
  if (!tab) return { error: 'Could not find a Completed orders tab. Check that AliExpress is in English and the order page has finished loading.' };
  if (!isSelectedTab(tab)) {
    tab.click();
    await sleep(800);
  }
  let found = orderLinks();
  if (!found.size) {
    await sleep(1500);
    found = orderLinks();
  }
  if (!found.size) return { error: 'No supported order links were found. Refresh the order list and confirm the Processed tab is selected.' };
  let warning = '';
  for (let page = 0; page < 50; page++) {
    if (collectionCancelled) return { cancelled: true };
    const button = findMoreButton();
    if (!button) break;
    const before = new Set(found.keys());
    button.click();
    const next = await waitForChange(before);
    if (collectionCancelled) return { cancelled: true };
    for (const [id, url] of next) found.set(id, url);
    if (before.size === found.size) {
      warning = 'AliExpress did not load another batch. The scan will use the orders currently visible.';
      break;
    }
    if (page === 49 && findMoreButton()) warning = 'Reached the 50-batch safety limit. Start again after reviewing this partial order list.';
  }
  return { orderIds: [...found.keys()], warning };
}
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.action === 'cancelCollection') { collectionCancelled = true; respond({ ok: true }); return; }
  if (message?.action !== 'collectOrders') return;
  collectionCancelled = false;
  collectAll().then(respond).catch(error => respond({ error: 'Could not read the order list. Refresh the page and try again.', detail: error.message }));
  return true;
});
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',scheduleAvailabilityCheck,{once:true});
else scheduleAvailabilityCheck();
chrome.storage?.onChanged?.addListener((changes,area)=>{
  if(area==='local'&&changes.aliclaimerSettings) {
    debugCouponChecks=changes.aliclaimerSettings.newValue?.debugCouponChecks===true;
    scheduleAvailabilityCheck();
  }
});
function mutationContainsOrderLink(node) {
  return !!node&&(node.nodeType===1||node.nodeType===11)&&(
    node.matches?.('a[href*="orderId="]')||node.querySelector?.('a[href*="orderId="]')
  );
}
document.addEventListener?.('click',event=>{
  const tab=findCompletedTab();
  if(tab&&(event.target===tab||tab.contains?.(event.target))) scheduleAvailabilityCheck();
  const button=event.target?.closest?.('button');
  if(button&&/^(view orders|load more|show more)$/i.test(button.textContent.trim())) setTimeout(scheduleAvailabilityCheck,900);
},true);
if (typeof MutationObserver !== 'undefined' && document.documentElement) {
  const observer=new MutationObserver(records=>{
    if(records.some(record=>record.type==='childList'&&[...record.addedNodes].some(mutationContainsOrderLink))) scheduleAvailabilityCheck();
  });
  observer.observe(document.documentElement,{childList:true,subtree:true});
}
chrome.runtime.onMessage.addListener(message => {
  if (message?.action === 'showNotice') {
    const notice = document.createElement('div');
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.textContent = message.text || 'AliClaimer updated.';
    notice.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:12px 18px;background:#176b35;color:white;border-radius:8px;font:600 14px system-ui,sans-serif';
    document.body.append(notice); setTimeout(() => notice.remove(), 8000);
  }
});

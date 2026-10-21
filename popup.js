'use strict';

const $ = id => document.getElementById(id);
let latest = { session: null, history: [] };
let collecting = false;
let collectingTabId = null;
function status(text, error = false) { $('status').textContent = text || ''; $('status').setAttribute('role', error ? 'alert' : 'status'); $('status').setAttribute('aria-live', error ? 'assertive' : 'polite'); }
async function send(action, extra = {}) {
  const response = await chrome.runtime.sendMessage({ action, ...extra });
  if (!response?.ok) throw new Error(response?.error || 'The extension could not complete that action.');
  return response;
}
function renderHistory(rows = []) {
  const list = $('historyList'); list.replaceChildren();
  if (!rows.length) { const empty=document.createElement('p'); empty.className='muted'; empty.textContent='No order history yet.'; list.append(empty); return; }
  for (const row of [...rows].reverse()) {
    const item=document.createElement('article'); item.className='history-row';
    const content=document.createElement('div');
    const title=document.createElement('div'); title.className='history-title'; title.textContent=`Order #${String(row.orderId).slice(-8)} · ${String(row.status||'unknown').replace(/^./,c=>c.toUpperCase())}`;
    const note=document.createElement('div'); note.className='history-note'; const date=row.updatedAt?new Date(row.updatedAt).toLocaleString('en-GB'):''; note.textContent=[row.note,date].filter(Boolean).join(' · ');
    content.append(title,note); item.append(content);
    if (row.status !== 'claimed' && row.status !== 'dismissed' && row.status !== 'pending') {
      const dismiss=document.createElement('button'); dismiss.className='action secondary small'; dismiss.textContent='Dismiss'; dismiss.setAttribute('aria-label',`Dismiss order ending ${String(row.orderId).slice(-8)}`);
      dismiss.addEventListener('click',async()=>{ try{await send('dismissOrder',{orderId:row.orderId}); await refresh();}catch(e){status(e.message,true);} });
      item.append(dismiss);
    }
    list.append(item);
  }
}
function render() {
  const s=latest.session;
  const names={running:'Scanning',paused:'Paused',complete:'Complete',stopped:'Stopped'};
  $('runState').textContent=names[s?.status]||'Ready';
  const active=s?.status==='running', paused=s?.status==='paused';
  $('start').disabled=active||paused||collecting;
  $('pause').disabled=!active;
  $('stop').disabled=!active&&!paused&&!collecting;
  $('resume').hidden=!paused;
  $('progress').max=Math.max(1,s?.orderIds?.length||1);
  $('progress').value=Math.min(s?.index||0,s?.orderIds?.length||0);
  $('progressText').textContent=s ? `${Math.min(s.index,s.orderIds.length)} / ${s.orderIds.length} orders · ${s.confirmedTotal||s.claimedThisRun||0} confirmed claims` : '';
  if (paused) status(s.pauseReason||'Paused. Resume when ready.');
  else if (active) status(s.currentOrderId ? `Checking order #${s.currentOrderId.slice(-8)}…` : 'Waiting between orders…');
  else if (s?.status==='complete') status('Scan complete. Review History.');
  renderHistory(latest.history);
}
async function refresh() { try { latest=await send('getState'); render(); } catch(e) { status(e.message,true); } }
async function collectFromActiveTab() {
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  let url; try {url=new URL(tab?.url);} catch {}
  if (!url||url.protocol!=='https:'||url.hostname!=='www.aliexpress.com'||url.pathname!=='/p/order/index.html') throw new Error('Open the AliExpress order list first.');
  collectingTabId=tab.id;
  let result;
  try { result=await chrome.tabs.sendMessage(tab.id,{action:'collectOrders'}); }
  catch { throw new Error('AliExpress page script is unavailable. Refresh the order list and try again.'); }
  if (result?.cancelled) throw new Error('Order collection was cancelled.');
  if (result?.error) throw new Error(result.error);
  if (!result?.orderIds?.length) throw new Error('No orders were found. Check the Processed tab and refresh the page.');
  if (result.warning) status(result.warning,true);
  return {tab,result};
}
$('start').addEventListener('click',async()=>{
  collecting=true; render(); status('Reading the Processed order list…');
  try {
    const {tab,result}=await collectFromActiveTab();
    const maxClaims=Math.max(1,Math.min(100,parseInt($('maxClaims').value,10)||5));
    const delayMs=Math.max(0,Math.min(60,parseInt($('delaySeconds').value,10)||0))*1000;
    const {aliclaimerSettings={}}=await chrome.storage.local.get('aliclaimerSettings');
    await chrome.storage.local.set({aliclaimerSettings:{...aliclaimerSettings,maxClaims,delayMs}});
    const started=await send('startScan',{tabId:tab.id,orderIds:result.orderIds.map(String),previewMode:$('preview').checked,maxClaims,delayMs});
    collecting=false; collectingTabId=null;
    status(`Started with ${started.total} eligible orders.${result.warning ? ` ${result.warning}` : ''}`, !!result.warning);
    await refresh();
  } catch(e) { collecting=false; collectingTabId=null; status(e.message,e.message!=='Order collection was cancelled.'); render(); }
});
$('pause').addEventListener('click',async()=>{try{await send('pause');await refresh();}catch(e){status(e.message,true);}});
$('resume').addEventListener('click',async()=>{try{await send('resume');await refresh();}catch(e){status(e.message,true);}});
$('stop').addEventListener('click',async()=>{if(collecting){try{if(collectingTabId!=null)await chrome.tabs.sendMessage(collectingTabId,{action:'cancelCollection'});status('Stopping order collection…');}catch(e){status('Could not stop collection. Close or refresh the AliExpress tab.',true);}return;}try{await send('stop');status('Stopped.');await refresh();}catch(e){status(e.message,true);}});
$('clearHistory').addEventListener('click',async()=>{if(!confirm('Clear all claimed and dismissed history? Future scans may include these orders again.'))return;try{await send('clearHistory');await refresh();status('History cleared.');}catch(e){status(e.message,true);}});
function selectPage(history) {
  $('scanTab').setAttribute('aria-selected',String(!history)); $('historyTab').setAttribute('aria-selected',String(history));
  $('scanPanel').classList.toggle('active',!history); $('historyPanel').classList.toggle('active',history);
}
$('scanTab').addEventListener('click',()=>selectPage(false)); $('historyTab').addEventListener('click',()=>selectPage(true));
$('maxClaims').addEventListener('change',async()=>{const value=Math.max(1,Math.min(100,parseInt($('maxClaims').value,10)||5));$('maxClaims').value=value;const {aliclaimerSettings={}}=await chrome.storage.local.get('aliclaimerSettings');await chrome.storage.local.set({aliclaimerSettings:{...aliclaimerSettings,maxClaims:value,delayMs:Math.max(0,Math.min(60,parseInt($('delaySeconds').value,10)||0))*1000}});});
$('autoCheckCoupons').addEventListener('change',async()=>{const {aliclaimerSettings={}}=await chrome.storage.local.get('aliclaimerSettings');await chrome.storage.local.set({aliclaimerSettings:{...aliclaimerSettings,autoCheckCoupons:$('autoCheckCoupons').checked}});});
$('debugCouponChecks').addEventListener('change',async()=>{const {aliclaimerSettings={}}=await chrome.storage.local.get('aliclaimerSettings');await chrome.storage.local.set({aliclaimerSettings:{...aliclaimerSettings,debugCouponChecks:$('debugCouponChecks').checked}});});
$('delaySeconds').addEventListener('change',async()=>{const value=Math.max(0,Math.min(60,parseInt($('delaySeconds').value,10)||0));$('delaySeconds').value=value;const {aliclaimerSettings={}}=await chrome.storage.local.get('aliclaimerSettings');await chrome.storage.local.set({aliclaimerSettings:{...aliclaimerSettings,maxClaims:Math.max(1,Math.min(100,parseInt($('maxClaims').value,10)||5)),delayMs:value*1000}});});
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&(changes.aliclaimerSession||changes.aliclaimerHistory))refresh();});
document.addEventListener('DOMContentLoaded',async()=>{const {aliclaimerSettings={}}=await chrome.storage.local.get('aliclaimerSettings');if(aliclaimerSettings.maxClaims)$('maxClaims').value=aliclaimerSettings.maxClaims;if(Number.isFinite(aliclaimerSettings.delayMs))$('delaySeconds').value=Math.floor(aliclaimerSettings.delayMs/1000);$('autoCheckCoupons').checked=aliclaimerSettings.autoCheckCoupons!==false;$('debugCouponChecks').checked=aliclaimerSettings.debugCouponChecks===true;await refresh();});

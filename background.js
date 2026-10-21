'use strict';

const SESSION_KEY = 'aliclaimerSession';
const HISTORY_KEY = 'aliclaimerHistory';
const MAX_HISTORY = 1000;
const MAX_DELAY_MS = 60000;
const ORDER_TIMEOUT_MS = 30000;
let session = null;
let sessionLoaded = false;
let orderTimer = null;
let delayTimer = null;
const WAKE_ALARM = 'aliclaimer-wake';

const isOrderListUrl = value => { try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'www.aliexpress.com' && u.pathname === '/p/order/index.html'; } catch { return false; } };
const orderIdFromUrl = value => { try { const u = new URL(value); const ids = u.searchParams.getAll('orderId'); return ids.length === 1 && /^\d+$/.test(ids[0]) ? ids[0] : null; } catch { return null; } };
const detailUrl = id => `https://www.aliexpress.com/p/order/detail.html?orderId=${encodeURIComponent(id)}&aliclaimer=1${session?.previewMode ? '&aliclaimerpreview=1' : ''}`;
async function loadSession() { if (!sessionLoaded) { const data = await chrome.storage.local.get(SESSION_KEY); session = data[SESSION_KEY] || null; sessionLoaded = true; } return session; }
async function saveSession() { if (session) await chrome.storage.local.set({ [SESSION_KEY]: session }); }
async function getHistory() { const data = await chrome.storage.local.get([HISTORY_KEY, 'aliclaimerClaimed']); const rows = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : []; const known = new Set(rows.map(row => row.orderId)); let changed = false; for (const id of (Array.isArray(data.aliclaimerClaimed) ? data.aliclaimerClaimed : [])) { if (/^\d+$/.test(String(id)) && !known.has(String(id))) { rows.push({orderId:String(id),status:'claimed',updatedAt:Date.now(),note:'Imported from the previous version.'}); known.add(String(id)); changed = true; } } if (changed) await chrome.storage.local.set({[HISTORY_KEY]:rows.slice(-MAX_HISTORY)}); return rows.slice(-MAX_HISTORY); }
async function putHistory(row) { const rows = await getHistory(); const i = rows.findIndex(item => item.orderId === row.orderId); const merged = i >= 0 ? { ...rows[i], ...row } : row; if (i >= 0) rows.splice(i,1); rows.push(merged); await chrome.storage.local.set({ [HISTORY_KEY]: rows.slice(-MAX_HISTORY) }); }
function cancelTimers() { clearTimeout(orderTimer); clearTimeout(delayTimer); orderTimer = delayTimer = null; chrome.alarms.clear(WAKE_ALARM); }
function wakeIn(ms) { chrome.alarms.create(WAKE_ALARM, { delayInMinutes: Math.max(0.5, ms / 60000) }); }
async function onOrderTimeout(id) { if (!session || session.status !== 'running' || session.currentOrderId !== id) return; clearTimeout(orderTimer); session.currentOrderId = null; session.currentDeadline = null; session.index++; if (!session.previewMode) session.claimsAttempted++; await putHistory({ orderId:id,status:'uncertain',updatedAt:Date.now(),note:'The order page did not report a result in time. Check AliExpress before retrying.' }); await saveSession(); await navigateCurrent(); }
async function setPaused(reason, uncertain = false) { cancelTimers(); if (!session) return; if (uncertain && session.currentOrderId) { await putHistory({ orderId: session.currentOrderId, status: 'uncertain', updatedAt: Date.now(), note: 'The extension stopped before it could verify the result. Check AliExpress before retrying.' }); if (!session.previewMode) session.claimsAttempted++; session.index++; session.currentOrderId = null; } session.status = 'paused'; session.pauseReason = reason; await saveSession(); }
function updateBadge() { const n = session?.claimedThisRun || 0; chrome.action.setBadgeText({ text: n ? String(Math.min(n, 999)) : '' }); if (n) chrome.action.setBadgeBackgroundColor({ color: '#287a43' }); }
async function tellTab(tabId, msg) { try { await chrome.tabs.sendMessage(tabId, msg); } catch {} }
async function navigateCurrent() {
  if (!session || session.status !== 'running' || session.currentOrderId) return;
  if (session.index >= session.orderIds.length) { session.status = 'complete'; session.currentOrderId = null; session.pauseReason = ''; await saveSession(); updateBadge(); await tellTab(session.tabId, { action: 'showNotice', text: 'Scan complete. Review results in History.' }); return; }
  if (session.maxClaims > 0 && session.claimsAttempted >= session.maxClaims) { await setPaused('Claim limit reached. Resume to continue with remaining orders.'); return; }
  chrome.alarms.clear(WAKE_ALARM); session.nextActionAt = null;
  const id = session.orderIds[session.index]; session.currentOrderId = id; session.currentDeadline = Date.now() + ORDER_TIMEOUT_MS;
  await putHistory({ orderId: id, status: 'pending', updatedAt: Date.now() }); await saveSession();
  clearTimeout(orderTimer); orderTimer = setTimeout(() => onOrderTimeout(id), ORDER_TIMEOUT_MS); wakeIn(ORDER_TIMEOUT_MS);
  try { await chrome.tabs.update(session.tabId, { url: detailUrl(id) }); } catch { clearTimeout(orderTimer); await setPaused('Could not navigate to the next order. Check the tab and resume.', true); }
}
async function advance(outcome) {
  if (!session || session.status !== 'running' || !session.currentOrderId) return;
  clearTimeout(orderTimer); orderTimer = null; chrome.alarms.clear(WAKE_ALARM);
  const id = session.currentOrderId; const status = outcome.status;
  session.currentOrderId = null; session.currentDeadline = null; session.index++;
  if (['claimed','attempted','uncertain'].includes(status)) session.claimsAttempted++;
  if (status === 'claimed') { session.claimedThisRun++; session.confirmedTotal = (session.confirmedTotal || 0) + 1; }
  await putHistory({ orderId: id, ...outcome, updatedAt: Date.now() });
  await saveSession(); updateBadge();
  if (status === 'unsupported') { await setPaused(outcome.note || 'Unsupported AliExpress page.'); return; }
  const wait = Math.max(0, Math.min(MAX_DELAY_MS, Number(session.delayMs) || 0)); session.nextActionAt = Date.now() + wait; await saveSession();
  delayTimer = setTimeout(() => { delayTimer = null; navigateCurrent(); }, wait); wakeIn(wait);
}
function extensionSender(sender) { return sender.id === chrome.runtime.id && !sender.tab && sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`); }
function contentSender(sender, tabId, path) { if (sender.id !== chrome.runtime.id || sender.tab?.id !== tabId || sender.frameId !== 0) return false; try { const u = new URL(sender.url || sender.tab.url); return u.protocol === 'https:' && u.hostname === 'www.aliexpress.com' && u.pathname === path; } catch { return false; } }
async function startScan(msg, sender) {
  if (!extensionSender(sender)) throw new Error('Start scans from the extension popup.');
  await loadSession(); if (session?.status === 'running' || session?.status === 'paused') throw new Error('A scan is active or paused. Resume or stop it before starting another scan.');
  const tab = await chrome.tabs.get(msg.tabId); if (!isOrderListUrl(tab.url)) throw new Error('Open the AliExpress order list first.');
  if (!Array.isArray(msg.orderIds) || !msg.orderIds.length || msg.orderIds.some(id => !/^\d+$/.test(String(id)))) throw new Error('No supported orders were found.');
  const history = await getHistory(); const blocked = new Set(history.filter(row => ['claimed','dismissed','attempted','uncertain'].includes(row.status)).map(row => row.orderId));
  const ids = [...new Set(msg.orderIds.map(String))].filter(id => !blocked.has(id)); if (!ids.length) throw new Error('All found orders are already claimed or dismissed in History.');
  cancelTimers(); session = { version: 2, id: crypto.randomUUID(), status: 'running', tabId: msg.tabId, orderListUrl: tab.url, orderIds: ids, index: 0, currentOrderId: null, previewMode: !!msg.previewMode, maxClaims: Math.max(1, Math.min(100, parseInt(msg.maxClaims,10) || 5)), delayMs: Math.max(0, Math.min(MAX_DELAY_MS, parseInt(msg.delayMs,10) || 0)), claimsAttempted: 0, claimedThisRun: 0, confirmedTotal: 0, createdAt: Date.now(), pauseReason: '' };
  await saveSession(); updateBadge(); await navigateCurrent(); return { ok: true, total: ids.length };
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => { try {
    if (!msg || typeof msg.action !== 'string') return;
    await loadSession();
    if (msg.action === 'startScan') return sendResponse(await startScan(msg, sender));
    if (msg.action === 'getState') return sendResponse({ ok: true, session, history: await getHistory() });
    if (msg.action === 'recordCouponClaim') {
      const id=String(msg.orderId||'');
      if (!sender.tab || !contentSender(sender,sender.tab.id,'/p/order/index.html') || !/^\d+$/.test(id)) return sendResponse({ok:false,error:'Coupon claim result came from an unsupported page.'});
      await putHistory({orderId:id,status:'claimed',updatedAt:Date.now(),note:String(msg.note||'AliExpress confirmed the coupon claim.').slice(0,300)});
      return sendResponse({ok:true});
    }
    if (['pause','stop','resume','dismissOrder','clearHistory'].includes(msg.action)) {
      if (!extensionSender(sender)) return sendResponse({ ok:false, error:'Use the extension popup to control the scan.' });
      if (msg.action === 'pause') { await setPaused('Paused by you.', true); return sendResponse({ok:true}); }
      if (msg.action === 'stop') { cancelTimers(); if (session) { if (session.currentOrderId) await putHistory({orderId:session.currentOrderId,status:'uncertain',updatedAt:Date.now(),note:'Stopped before the extension could verify this order. Check AliExpress before retrying.'}); session.status='stopped'; session.currentOrderId=null; session.pauseReason=''; await saveSession(); try { await chrome.tabs.update(session.tabId,{url:session.orderListUrl}); } catch {} } updateBadge(); return sendResponse({ok:true}); }
      if (msg.action === 'resume') { if (!session || session.status!=='paused') return sendResponse({ok:false,error:'No paused scan to resume.'}); const [tab]=await chrome.tabs.query({active:true,currentWindow:true}); if (!tab || tab.id!==session.tabId) return sendResponse({ok:false,error:'Return to the AliExpress order tab before resuming.'}); if (session.claimsAttempted >= session.maxClaims) { session.claimsAttempted=0; session.claimedThisRun=0; } session.status='running'; session.pauseReason=''; await saveSession(); await navigateCurrent(); return sendResponse({ok:true}); }
      if (msg.action === 'dismissOrder') { const id=String(msg.orderId||''); const row=(await getHistory()).find(item=>item.orderId===id); if (!row || row.status==='claimed') return sendResponse({ok:false,error:'This order cannot be dismissed.'}); await putHistory({orderId:id,status:'dismissed',updatedAt:Date.now(),note:'Hidden from future scans.'}); return sendResponse({ok:true}); }
      if (msg.action === 'clearHistory') { await chrome.storage.local.remove([HISTORY_KEY,'aliclaimerClaimed']); return sendResponse({ok:true}); }
    }
    if (msg.action === 'authorizeOrder' || msg.action === 'authorizeClaim') { const valid = session?.status === 'running' && contentSender(sender,session.tabId,'/p/order/detail.html') && msg.orderId === session.currentOrderId && orderIdFromUrl(sender.url||sender.tab.url) === session.currentOrderId; return sendResponse({ok:!!valid,previewMode:!!session?.previewMode}); }
    if (msg.action === 'orderResult') {
      if (!session || session.status!=='running' || !contentSender(sender,session.tabId,'/p/order/detail.html') || orderIdFromUrl(sender.url||sender.tab.url)!==session.currentOrderId || msg.orderId!==session.currentOrderId) return sendResponse({ok:false,error:'Result did not match the active order.'});
      const note=String(msg.note||'').slice(0,300);
      if (['available','none','claimed'].includes(msg.status)) {
        const data=await chrome.storage.local.get('aliclaimerAvailability');
        const cache=data.aliclaimerAvailability&&typeof data.aliclaimerAvailability==='object'?data.aliclaimerAvailability:{};
        cache[msg.orderId]={status:msg.status,checkedAt:Date.now(),note,source:'hidden-frame-v4'};
        const entries=Object.entries(cache).sort((a,b)=>(b[1]?.checkedAt||0)-(a[1]?.checkedAt||0)).slice(0,2000);
        await chrome.storage.local.set({aliclaimerAvailability:Object.fromEntries(entries)});
      }
      await advance({status:['claimed','attempted','available','none','unsupported','uncertain'].includes(msg.status)?msg.status:'uncertain',note,previewMode:session.previewMode}); return sendResponse({ok:true});
    }
  } catch (e) { sendResponse({ok:false,error:e.message||'The extension could not complete this step.'}); } })(); return true;
});
async function recover(reason) { const data=await chrome.storage.local.get(SESSION_KEY); sessionLoaded=true; if (data[SESSION_KEY]?.status==='running') { session=data[SESSION_KEY]; await setPaused(reason,true); updateBadge(); } else session=data[SESSION_KEY]||null; }
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name !== WAKE_ALARM) return; (async()=>{ await loadSession(); if (session?.status !== 'running') return; if (session.currentOrderId) { if (Date.now() >= (session.currentDeadline || 0)) await onOrderTimeout(session.currentOrderId); else wakeIn(session.currentDeadline - Date.now()); } else if (session.nextActionAt) { if (Date.now() >= session.nextActionAt) await navigateCurrent(); else wakeIn(session.nextActionAt - Date.now()); } })().catch(()=>{}); });
chrome.runtime.onStartup.addListener(() => { recover('Browser restarted. Review the last order, then choose Resume.').catch(()=>{}); });
chrome.runtime.onInstalled.addListener(() => { recover('Extension reloaded. Review the last order, then choose Resume.').catch(()=>{}); });
chrome.tabs.onRemoved.addListener(tabId => { loadSession().then(() => { if (session?.tabId===tabId && session.status==='running') return setPaused('The AliExpress tab was closed.', true); }).catch(()=>{}); });

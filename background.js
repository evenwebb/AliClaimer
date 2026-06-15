/**
 * AliExpress Coupon Claimer - Background Service Worker
 * Manages the order scanning state and coordinates navigation between order pages
 */

// Global state for the current claiming operation
let claimingState = null;
let timeoutId = null;

/** Default delay between navigating to the next order (milliseconds) */
const DEFAULT_NAVIGATE_DELAY_MS = 1500;
/** Per-order page timeout before skipping */
const ORDER_TIMEOUT_MS = 25000;
/** Maximum number of claimed order IDs to persist (prevents unbounded storage growth) */
const MAX_CLAIMED_IDS = 500;

async function getDelayMs() {
  try {
    const { aliclaimerDelay } = await chrome.storage.local.get('aliclaimerDelay');
    const val = parseInt(aliclaimerDelay, 10);
    return (val >= 0 && val <= 15000) ? val : DEFAULT_NAVIGATE_DELAY_MS;
  } catch {
    return DEFAULT_NAVIGATE_DELAY_MS;
  }
}

async function getClaimedOrderIds() {
  try {
    const { aliclaimerClaimed = [] } = await chrome.storage.local.get('aliclaimerClaimed');
    return new Set(aliclaimerClaimed);
  } catch {
    return new Set();
  }
}

async function addClaimedOrderId(orderId) {
  try {
    const ids = await getClaimedOrderIds();
    ids.add(orderId);
    // Cap the stored list to prevent unbounded growth
    let arr = Array.from(ids);
    if (arr.length > MAX_CLAIMED_IDS) {
      arr = arr.slice(arr.length - MAX_CLAIMED_IDS);
    }
    await chrome.storage.local.set({ aliclaimerClaimed: arr });
  } catch (e) {
    console.error('Failed to persist claimed order ID:', e);
  }
}

function updateBadge(count) {
  if (count > 0) {
    const text = count > 999 ? '999+' : String(count);
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

function clearBadge() {
  chrome.action.setBadgeText({ text: '' });
}

/** Cancel all pending timers for the current claiming session */
function cancelAllTimers(state) {
  if (state?._timeoutId) clearTimeout(state._timeoutId);
  if (state?._delayId) clearTimeout(state._delayId);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (claimingState?.tabId === tabId) {
    cancelAllTimers(claimingState);
    claimingState = null;
    clearBadge();
    chrome.storage.local.set({ aliclaimerRunning: false }).catch(() => {});
  }
  chrome.storage.local.get('aliclaimerLoadMore').then(({ aliclaimerLoadMore }) => {
    if (aliclaimerLoadMore?.tabId === tabId) {
      chrome.storage.local.remove('aliclaimerLoadMore');
    }
  }).catch(() => {});
});

async function updateStats(updates) {
  try {
    const { aliclaimerStats = {} } = await chrome.storage.local.get('aliclaimerStats');
    const next = { ...aliclaimerStats, ...updates };
    await chrome.storage.local.set({ aliclaimerStats: next });
  } catch (e) {
    console.error('Failed to update stats:', e);
  }
}

/** Send per-order status to the popup for real-time display */
async function sendOrderStatus(orderId, status) {
  try {
    const { aliclaimerOrderStatuses = [] } = await chrome.storage.local.get('aliclaimerOrderStatuses');
    const existing = aliclaimerOrderStatuses.find(s => s.orderId === orderId);
    if (existing) {
      Object.assign(existing, status);
    } else {
      aliclaimerOrderStatuses.push({ orderId, ...status });
    }
    await chrome.storage.local.set({ aliclaimerOrderStatuses });
  } catch (e) {
    console.error('Failed to save order status:', e);
  }
}

function extractOrderId(url) {
  const m = url.match(/orderId=(\d+)/i);
  return m ? m[1] : null;
}

function isValidAliExpressUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.includes('aliexpress.com') &&
           u.pathname.includes('detail.html') &&
           /orderId=\d+/i.test(u.search);
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'startClaiming') {
    handleStartClaiming(msg, sender, sendResponse);
    return true;
  }
  if (msg.action === 'orderDetailDone') {
    handleOrderDetailDone(msg, sendResponse);
    return true;
  }
  if (msg.action === 'collectMoreOrders') {
    handleCollectMoreOrders(msg, sendResponse);
    return true;
  }
  if (msg.action === 'stop') {
    handleStop(msg, sendResponse);
    return true;
  }
});

async function handleStartClaiming(msg, sender, sendResponse) {
  const tabId = msg.tabId || (sender.tab && sender.tab.id);
  if (!tabId) {
    sendResponse({ ok: false, error: 'No valid tab ID' });
    return;
  }

  if (!Array.isArray(msg.orderUrls) || msg.orderUrls.length === 0) {
    sendResponse({ ok: false, error: 'No order URLs provided' });
    return;
  }

  const validUrls = msg.orderUrls.filter(isValidAliExpressUrl);
  if (validUrls.length === 0) {
    sendResponse({ ok: false, error: 'No valid AliExpress order URLs found' });
    return;
  }

  // Cancel any previous session
  if (claimingState) {
    cancelAllTimers(claimingState);
    claimingState = null;
  }

  // Clear previous order statuses for a fresh scan
  await chrome.storage.local.set({ aliclaimerOrderStatuses: [] });

  // Track timers per-state to avoid cross-session leaks (fix #2)
  const stateTimers = { _timeoutId: null, _delayId: null };

  claimingState = {
    orderUrls: validUrls,
    currentIndex: 0,
    tabId,
    previewMode: !!msg.previewMode,
    // Use msg.orderListUrl as base for addClaimerParam (fix #5)
    orderListBase: msg.orderListUrl || 'https://www.aliexpress.com/p/order/index.html',
    processedOrderIds: new Set(),
    couponsFound: 0,
    couponsClaimed: 0,
    totalValueClaimed: 0,
    totalChecked: 0,
    _timeoutId: null,
    _delayId: null
  };

  // Copy timer refs into claimingState so cancelAllTimers can find them
  Object.defineProperties(claimingState, {
    _timeoutId: { get: () => stateTimers._timeoutId, set: (v) => { stateTimers._timeoutId = v; } },
    _delayId: { get: () => stateTimers._delayId, set: (v) => { stateTimers._delayId = v; } }
  });

  await updateStats({
    checked: 0,
    couponsFound: 0,
    couponsClaimed: 0,
    totalValueClaimed: 0,
    total: validUrls.length,
    previewMode: !!msg.previewMode
  });

  clearBadge();
  // Navigate first, then schedule timeout (fix #1)
  const url = addClaimerParam(claimingState.orderUrls[0], claimingState.previewMode, claimingState.orderListBase);
  try {
    await chrome.tabs.update(tabId, { url });
    scheduleTimeout(claimingState);
  } catch (e) {
    console.error('Failed to navigate to first order:', e);
    claimingState = null;
    clearBadge();
    sendResponse({ ok: false, error: 'Failed to navigate to order' });
    return;
  }
  sendResponse({ ok: true });
}

async function handleOrderDetailDone(msg, sendResponse) {
  if (!claimingState) {
    sendResponse({ ok: false, error: 'No active claiming state' });
    return;
  }

  const state = claimingState;
  clearTimeout(state._timeoutId);
  state._timeoutId = null;

  const couponFound = msg.couponFound || 0;
  const couponClaimed = msg.couponClaimed || 0;
  const valueClaimed = couponClaimed * 1;
  const currentUrl = state.orderUrls[state.currentIndex];
  const orderId = extractOrderId(currentUrl);

  // Track per-order status
  if (orderId) {
    await sendOrderStatus(orderId, {
      status: couponFound > 0 ? (couponClaimed > 0 ? 'claimed' : 'found') : 'none',
      couponFound,
      couponClaimed,
      timestamp: Date.now()
    });
    if (couponClaimed > 0) {
      await addClaimedOrderId(orderId);
    }
  }

  state.couponsFound = (state.couponsFound || 0) + couponFound;
  state.couponsClaimed = (state.couponsClaimed || 0) + couponClaimed;
  state.totalValueClaimed = (state.totalValueClaimed || 0) + valueClaimed;
  state.currentIndex++;
  state.totalChecked = (state.totalChecked || 0) + 1;

  await updateStats({
    checked: state.totalChecked,
    couponsFound: state.couponsFound,
    couponsClaimed: state.couponsClaimed,
    totalValueClaimed: state.totalValueClaimed
  });

  updateBadge(state.couponsFound);

  if (state.currentIndex >= state.orderUrls.length) {
    state.orderUrls.forEach(u => {
      const m = u.match(/orderId=(\d+)/i);
      if (m) state.processedOrderIds.add(m[1]);
    });
    requestLoadMore(state);
    claimingState = null;
    sendResponse({ ok: true, done: true });
    return;
  }

  // Configurable delay before next order — tracked per-state (fix #2, #3)
  const delayMs = await getDelayMs();
  clearTimeout(state._delayId);
  state._delayId = setTimeout(() => {
    state._delayId = null;
    // claimingState may have been replaced; state is our saved reference
    if (claimingState !== state) return;

    const nextUrl = addClaimerParam(state.orderUrls[state.currentIndex], state.previewMode, state.orderListBase);
    chrome.tabs.update(state.tabId, { url: nextUrl }).then(() => {
      if (claimingState === state) {
        scheduleTimeout(state);
      }
    }).catch((e) => {
      console.error('Failed to navigate to next order:', e);
      if (claimingState === state) {
        claimingState = null;
      }
    });
  }, delayMs);

  sendResponse({ ok: true });
}

async function handleCollectMoreOrders(msg, sendResponse) {
  try {
    const { aliclaimerLoadMore } = await chrome.storage.local.get('aliclaimerLoadMore');
    if (!aliclaimerLoadMore) {
      sendResponse({ ok: false, error: 'No load more state' });
      return;
    }

    const { processedOrderIds, orderListUrl, tabId, previewMode } = aliclaimerLoadMore;
    const claimedIds = await getClaimedOrderIds();

    const newUrls = (msg.orderUrls || [])
      .filter(isValidAliExpressUrl)
      .filter(u => {
        const m = u.match(/orderId=(\d+)/i);
        if (!m) return false;
        return !processedOrderIds.includes(m[1]) && !claimedIds.has(m[1]);
      });

    await chrome.storage.local.remove('aliclaimerLoadMore');

    if (newUrls.length === 0) {
      finishClaiming(tabId);
      sendResponse({ ok: true, done: true });
      return;
    }

    const baseChecked = aliclaimerLoadMore.totalChecked || 0;

    const stateTimers = { _timeoutId: null, _delayId: null };
    claimingState = {
      orderUrls: newUrls,
      currentIndex: 0,
      tabId,
      previewMode,
      orderListUrl: orderListUrl,
      orderListBase: orderListUrl,
      processedOrderIds: new Set(processedOrderIds),
      baseChecked,
      totalChecked: baseChecked,
      couponsFound: 0,
      couponsClaimed: 0,
      totalValueClaimed: 0,
      _timeoutId: null,
      _delayId: null
    };
    Object.defineProperties(claimingState, {
      _timeoutId: { get: () => stateTimers._timeoutId, set: (v) => { stateTimers._timeoutId = v; } },
      _delayId: { get: () => stateTimers._delayId, set: (v) => { stateTimers._delayId = v; } }
    });

    await updateStats({ total: baseChecked + newUrls.length });

    const url = addClaimerParam(claimingState.orderUrls[0], claimingState.previewMode, claimingState.orderListBase);
    chrome.tabs.update(tabId, { url }).catch((e) => {
      console.error('Failed to navigate:', e);
      claimingState = null;
      clearBadge();
    });
    scheduleTimeout(claimingState);
    sendResponse({ ok: true });
  } catch (e) {
    console.error('Failed to get load more state:', e);
    sendResponse({ ok: false, error: 'Failed to access storage' });
  }
}

async function handleStop(msg, sendResponse) {
  const state = claimingState;
  claimingState = null;
  if (state) cancelAllTimers(state);
  clearBadge();

  await chrome.storage.local.remove('aliclaimerLoadMore').catch(() => {});
  await chrome.storage.local.set({ aliclaimerRunning: false }).catch(() => {});
  // Clean up order statuses on stop (fix #4)
  await chrome.storage.local.remove('aliclaimerOrderStatuses').catch(() => {});

  if (state?.tabId && state?.orderListUrl) {
    chrome.tabs.get(state.tabId).then(tab => {
      if (tab && !tab.discarded) {
        return chrome.tabs.update(state.tabId, { url: state.orderListUrl });
      }
    }).catch((e) => {
      console.error('Failed to return to order list:', e);
    });
  }

  sendResponse({ ok: true });
}

function scheduleTimeout(state) {
  clearTimeout(state._timeoutId);
  state._timeoutId = setTimeout(() => {
    state._timeoutId = null;
    if (claimingState !== state) return;

    updateStats({
      checked: state.totalChecked + 1,
      couponsFound: state.couponsFound || 0,
      couponsClaimed: state.couponsClaimed || 0,
      totalValueClaimed: state.totalValueClaimed || 0
    });

    updateBadge(state.couponsFound || 0);

    // Mark current order as timed out
    const currentUrl = state.orderUrls[state.currentIndex];
    const orderId = extractOrderId(currentUrl);
    if (orderId) {
      sendOrderStatus(orderId, { status: 'timeout', timestamp: Date.now() });
    }

    state.currentIndex++;
    state.totalChecked = (state.totalChecked || 0) + 1;

    if (state.currentIndex >= state.orderUrls.length) {
      state.orderUrls.forEach(u => {
        const m = u.match(/orderId=(\d+)/i);
        if (m) state.processedOrderIds.add(m[1]);
      });
      requestLoadMore(state);
      claimingState = null;
      return;
    }

    const nextUrl = addClaimerParam(state.orderUrls[state.currentIndex], state.previewMode, state.orderListBase);
    chrome.tabs.update(state.tabId, { url: nextUrl }).then(() => {
      if (claimingState === state) {
        scheduleTimeout(state);
      }
    }).catch((e) => {
      console.error('Timeout: Failed to navigate to next order:', e);
      if (claimingState === state) {
        claimingState = null;
      }
    });
  }, ORDER_TIMEOUT_MS);
}

function requestLoadMore(state) {
  if (!state) return;

  const processedOrderIds = Array.from(state.processedOrderIds || new Set());
  // Use state.totalChecked for accurate count (fix #6)
  chrome.storage.local.set({
    aliclaimerLoadMore: {
      processedOrderIds,
      orderListUrl: state.orderListUrl,
      tabId: state.tabId,
      previewMode: state.previewMode,
      totalChecked: state.totalChecked || processedOrderIds.length
    }
  }).catch((e) => {
    console.error('Failed to save load more state:', e);
  });

  chrome.tabs.update(state.tabId, { url: state.orderListUrl }).catch((e) => {
    console.error('Failed to return to order list:', e);
  });
}

function finishClaiming(tabId) {
  // Clean up order statuses on completion (fix #4)
  chrome.storage.local.remove('aliclaimerOrderStatuses').catch(() => {});
  chrome.storage.local.set({ aliclaimerRunning: false }).catch(() => {});
  chrome.tabs.sendMessage(tabId, { action: 'showComplete' }).catch(() => {});
}

function addClaimerParam(url, previewMode, baseUrl) {
  try {
    const u = new URL(url, baseUrl || 'https://www.aliexpress.com');
    u.searchParams.set('aliclaimer', '1');
    if (previewMode) u.searchParams.set('aliclaimerpreview', '1');
    return u.toString();
  } catch (e) {
    console.error('Failed to add claimer param:', e);
    return url;
  }
}

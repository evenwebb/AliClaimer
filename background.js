/**
 * AliExpress Coupon Claimer - Background Service Worker
 * Manages the order scanning state and coordinates navigation between order pages
 */

// Global state for the current claiming operation
let claimingState = null;
let timeoutId = null;
let navigateDelayId = null;

/** Default delay between navigating to the next order (milliseconds) */
const DEFAULT_NAVIGATE_DELAY_MS = 1500;
/** Per-order page timeout before skipping */
const ORDER_TIMEOUT_MS = 25000;

async function getDelayMs() {
  try {
    const { aliclaimerDelay } = await chrome.storage.local.get('aliclaimerDelay');
    const val = parseInt(aliclaimerDelay, 10);
    return (val >= 0 && val <= 10000) ? val : DEFAULT_NAVIGATE_DELAY_MS;
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
    await chrome.storage.local.set({ aliclaimerClaimed: Array.from(ids) });
  } catch (e) {
    console.error('Failed to persist claimed order ID:', e);
  }
}

/**
 * Updates the extension badge to show the number of coupons found
 */
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

chrome.tabs.onRemoved.addListener((tabId) => {
  if (claimingState?.tabId === tabId) {
    clearTimeout(timeoutId);
    clearTimeout(navigateDelayId);
    timeoutId = null;
    navigateDelayId = null;
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

  // Clear previous order statuses for a fresh scan
  await chrome.storage.local.set({ aliclaimerOrderStatuses: [] });

  claimingState = {
    orderUrls: validUrls,
    currentIndex: 0,
    tabId,
    previewMode: !!msg.previewMode,
    orderListUrl: msg.orderListUrl || 'https://www.aliexpress.com/p/order/index.html',
    processedOrderIds: new Set(),
    couponsFound: 0,
    couponsClaimed: 0,
    totalValueClaimed: 0
  };

  await updateStats({
    checked: 0,
    couponsFound: 0,
    couponsClaimed: 0,
    totalValueClaimed: 0,
    total: validUrls.length,
    previewMode: !!msg.previewMode
  });

  clearBadge();

  const url = addClaimerParam(claimingState.orderUrls[0], claimingState.previewMode);
  chrome.tabs.update(tabId, { url }).catch((e) => {
    console.error('Failed to navigate to order:', e);
    claimingState = null;
    clearBadge();
  });
  scheduleTimeout(tabId);
  sendResponse({ ok: true });
}

async function handleOrderDetailDone(msg, sendResponse) {
  if (!claimingState) {
    sendResponse({ ok: false, error: 'No active claiming state' });
    return;
  }

  clearTimeout(timeoutId);
  timeoutId = null;

  const couponFound = msg.couponFound || 0;
  const couponClaimed = msg.couponClaimed || 0;
  const valueClaimed = couponClaimed * 1; // £1 per coupon
  const baseChecked = claimingState.baseChecked || 0;
  const currentUrl = claimingState.orderUrls[claimingState.currentIndex];
  const orderId = extractOrderId(currentUrl);

  // Track per-order status
  if (orderId) {
    await sendOrderStatus(orderId, {
      status: couponFound > 0 ? (couponClaimed > 0 ? 'claimed' : 'found') : 'none',
      couponFound,
      couponClaimed,
      timestamp: Date.now()
    });

    // Persist claimed order IDs to skip on future scans
    if (couponClaimed > 0) {
      await addClaimedOrderId(orderId);
    }
  }

  claimingState.couponsFound = (claimingState.couponsFound || 0) + couponFound;
  claimingState.couponsClaimed = (claimingState.couponsClaimed || 0) + couponClaimed;
  claimingState.totalValueClaimed = (claimingState.totalValueClaimed || 0) + valueClaimed;
  claimingState.currentIndex++;

  await updateStats({
    checked: baseChecked + claimingState.currentIndex,
    couponsFound: claimingState.couponsFound,
    couponsClaimed: claimingState.couponsClaimed,
    totalValueClaimed: claimingState.totalValueClaimed
  });

  updateBadge(claimingState.couponsFound);

  if (claimingState.currentIndex >= claimingState.orderUrls.length) {
    claimingState.orderUrls.forEach(u => {
      const m = u.match(/orderId=(\d+)/i);
      if (m) claimingState.processedOrderIds.add(m[1]);
    });
    requestLoadMore(claimingState);
    claimingState = null;
    sendResponse({ ok: true, done: true });
    return;
  }

  // Configurable delay before next order
  const delayMs = await getDelayMs();
  const savedState = claimingState;
  clearTimeout(navigateDelayId);
  navigateDelayId = setTimeout(() => {
    navigateDelayId = null;
    if (!claimingState || claimingState.tabId !== savedState.tabId) return;

    const nextUrl = addClaimerParam(savedState.orderUrls[savedState.currentIndex], savedState.previewMode);
    chrome.tabs.update(savedState.tabId, { url: nextUrl }).then(() => {
      if (claimingState?.tabId === savedState.tabId) {
        scheduleTimeout(savedState.tabId);
      }
    }).catch((e) => {
      console.error('Failed to navigate to next order:', e);
      if (claimingState?.tabId === savedState.tabId) {
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
        // Skip already processed AND previously claimed
        return !processedOrderIds.includes(m[1]) && !claimedIds.has(m[1]);
      });

    await chrome.storage.local.remove('aliclaimerLoadMore');

    if (newUrls.length === 0) {
      finishClaiming(tabId);
      sendResponse({ ok: true, done: true });
      return;
    }

    const baseChecked = aliclaimerLoadMore.totalChecked || 0;
    claimingState = {
      orderUrls: newUrls,
      currentIndex: 0,
      tabId,
      previewMode,
      orderListUrl,
      processedOrderIds: new Set(processedOrderIds),
      baseChecked,
      couponsFound: 0,
      couponsClaimed: 0,
      totalValueClaimed: 0
    };

    await updateStats({ total: baseChecked + newUrls.length });

    const url = addClaimerParam(claimingState.orderUrls[0], claimingState.previewMode);
    chrome.tabs.update(tabId, { url }).catch((e) => {
      console.error('Failed to navigate:', e);
      claimingState = null;
      clearBadge();
    });
    scheduleTimeout(tabId);
    sendResponse({ ok: true });
  } catch (e) {
    console.error('Failed to get load more state:', e);
    sendResponse({ ok: false, error: 'Failed to access storage' });
  }
}

async function handleStop(msg, sendResponse) {
  const state = claimingState;
  claimingState = null;
  clearTimeout(timeoutId);
  clearTimeout(navigateDelayId);
  timeoutId = null;
  navigateDelayId = null;

  clearBadge();

  await chrome.storage.local.remove('aliclaimerLoadMore').catch(() => {});
  await chrome.storage.local.set({ aliclaimerRunning: false }).catch(() => {});

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

function scheduleTimeout(tabId) {
  clearTimeout(timeoutId);
  timeoutId = setTimeout(() => {
    timeoutId = null;

    if (!claimingState || claimingState.tabId !== tabId) return;

    const savedState = claimingState;
    const baseChecked = savedState.baseChecked || 0;

    updateStats({
      checked: baseChecked + savedState.currentIndex + 1,
      couponsFound: savedState.couponsFound || 0,
      couponsClaimed: savedState.couponsClaimed || 0,
      totalValueClaimed: savedState.totalValueClaimed || 0
    });

    updateBadge(savedState.couponsFound || 0);

    // Mark current order as timed out
    const currentUrl = savedState.orderUrls[savedState.currentIndex];
    const orderId = extractOrderId(currentUrl);
    if (orderId) {
      sendOrderStatus(orderId, { status: 'timeout', timestamp: Date.now() });
    }

    claimingState.currentIndex++;

    if (claimingState.currentIndex >= claimingState.orderUrls.length) {
      claimingState.orderUrls.forEach(u => {
        const m = u.match(/orderId=(\d+)/i);
        if (m) claimingState.processedOrderIds.add(m[1]);
      });
      requestLoadMore(claimingState);
      claimingState = null;
      return;
    }

    const nextUrl = addClaimerParam(savedState.orderUrls[savedState.currentIndex], savedState.previewMode);

    chrome.tabs.update(savedState.tabId, { url: nextUrl }).then(() => {
      if (claimingState?.tabId === savedState.tabId) {
        scheduleTimeout(savedState.tabId);
      }
    }).catch((e) => {
      console.error('Timeout: Failed to navigate to next order:', e);
      if (claimingState?.tabId === savedState.tabId) {
        claimingState = null;
      }
    });
  }, ORDER_TIMEOUT_MS);
}

function requestLoadMore(state) {
  if (!state) return;

  const processedOrderIds = Array.from(state.processedOrderIds || new Set());
  chrome.storage.local.set({
    aliclaimerLoadMore: {
      processedOrderIds,
      orderListUrl: state.orderListUrl,
      tabId: state.tabId,
      previewMode: state.previewMode,
      totalChecked: processedOrderIds.length
    }
  }).catch((e) => {
    console.error('Failed to save load more state:', e);
  });

  chrome.tabs.update(state.tabId, { url: state.orderListUrl }).catch((e) => {
    console.error('Failed to return to order list:', e);
  });
}

function finishClaiming(tabId) {
  chrome.storage.local.set({ aliclaimerRunning: false }).catch(() => {});
  chrome.tabs.sendMessage(tabId, { action: 'showComplete' }).catch(() => {});
}

function addClaimerParam(url, previewMode) {
  try {
    const u = new URL(url, 'https://www.aliexpress.com');
    u.searchParams.set('aliclaimer', '1');
    if (previewMode) u.searchParams.set('aliclaimerpreview', '1');
    return u.toString();
  } catch (e) {
    console.error('Failed to add claimer param:', e);
    return url;
  }
}

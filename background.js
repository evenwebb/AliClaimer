/**
 * AliExpress Coupon Claimer - Background Service Worker
 * Manages the order scanning state and coordinates navigation between order pages
 */

// Global state for the current claiming operation
let claimingState = null;
let timeoutId = null;

/**
 * Updates the extension badge to show the number of coupons found
 */
function updateBadge(count) {
  if (count > 0) {
    const text = count > 999 ? '999+' : String(count);
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' }); // Green for success
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

/**
 * Clears the extension badge
 */
function clearBadge() {
  chrome.action.setBadgeText({ text: '' });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (claimingState?.tabId === tabId) {
    clearTimeout(timeoutId);
    timeoutId = null;
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
    const tabId = msg.tabId || (sender.tab && sender.tab.id);
    if (!tabId) {
      sendResponse({ ok: false, error: 'No valid tab ID' });
      return true;
    }

    if (!Array.isArray(msg.orderUrls) || msg.orderUrls.length === 0) {
      sendResponse({ ok: false, error: 'No order URLs provided' });
      return true;
    }

    const validUrls = msg.orderUrls.filter(isValidAliExpressUrl);
    if (validUrls.length === 0) {
      sendResponse({ ok: false, error: 'No valid AliExpress order URLs found' });
      return true;
    }

    claimingState = {
      orderUrls: validUrls,
      currentIndex: 0,
      tabId,
      previewMode: !!msg.previewMode,
      orderListUrl: msg.orderListUrl || 'https://www.aliexpress.com/p/order/index.html',
      processedOrderIds: new Set()
    };

    updateStats({
      checked: 0,
      couponsFound: 0,
      couponsClaimed: 0,
      total: validUrls.length,
      previewMode: !!msg.previewMode
    });

    // Clear badge at start of new scan
    clearBadge();

    const url = addClaimerParam(claimingState.orderUrls[0], claimingState.previewMode);
    chrome.tabs.update(tabId, { url }).catch((e) => {
      console.error('Failed to navigate to order:', e);
      claimingState = null;
      clearBadge();
    });
    scheduleTimeout(tabId);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'orderDetailDone') {
    if (!claimingState) {
      sendResponse({ ok: false, error: 'No active claiming state' });
      return true;
    }

    clearTimeout(timeoutId);
    timeoutId = null;

    const couponFound = msg.couponFound || 0;
    const couponClaimed = msg.couponClaimed || 0;
    const baseChecked = claimingState.baseChecked || 0;

    updateStats({
      checked: baseChecked + claimingState.currentIndex + 1,
      couponsFound: (claimingState.couponsFound || 0) + couponFound,
      couponsClaimed: (claimingState.couponsClaimed || 0) + couponClaimed
    });

    claimingState.couponsFound = (claimingState.couponsFound || 0) + couponFound;
    claimingState.couponsClaimed = (claimingState.couponsClaimed || 0) + couponClaimed;
    claimingState.currentIndex++;

    // Update badge with total coupons found
    updateBadge(claimingState.couponsFound);

    if (claimingState.currentIndex >= claimingState.orderUrls.length) {
      claimingState.orderUrls.forEach(u => {
        const m = u.match(/orderId=(\d+)/i);
        if (m) claimingState.processedOrderIds.add(m[1]);
      });
      requestLoadMore(claimingState);
      claimingState = null;
      sendResponse({ ok: true, done: true });
      return true;
    }

    const savedState = claimingState;
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

    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'collectMoreOrders') {
    chrome.storage.local.get('aliclaimerLoadMore').then(({ aliclaimerLoadMore }) => {
      if (!aliclaimerLoadMore) {
        sendResponse({ ok: false, error: 'No load more state' });
        return;
      }

      const { processedOrderIds, orderListUrl, tabId, previewMode } = aliclaimerLoadMore;
      const newUrls = (msg.orderUrls || [])
        .filter(isValidAliExpressUrl)
        .filter(u => {
          const m = u.match(/orderId=(\d+)/i);
          return m && !processedOrderIds.includes(m[1]);
        });

      chrome.storage.local.remove('aliclaimerLoadMore');

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
        couponsClaimed: 0
      };

      updateStats({
        total: baseChecked + newUrls.length
      });

      const url = addClaimerParam(claimingState.orderUrls[0], claimingState.previewMode);
      chrome.tabs.update(tabId, { url }).catch((e) => {
        console.error('Failed to navigate:', e);
        claimingState = null;
        clearBadge();
      });
      scheduleTimeout(tabId);
      sendResponse({ ok: true });
    }).catch((e) => {
      console.error('Failed to get load more state:', e);
      sendResponse({ ok: false, error: 'Failed to access storage' });
    });
    return true;
  }

  if (msg.action === 'stop') {
    const state = claimingState;
    claimingState = null;
    clearTimeout(timeoutId);
    timeoutId = null;

    // Clear badge when stopped
    clearBadge();

    chrome.storage.local.remove('aliclaimerLoadMore').catch(() => {});
    chrome.storage.local.set({ aliclaimerRunning: false }).catch(() => {});

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
    return true;
  }
});

const ORDER_TIMEOUT_MS = 25000;

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
      couponsClaimed: savedState.couponsClaimed || 0
    });

    // Update badge with current count
    updateBadge(savedState.couponsFound || 0);

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

    const nextUrl = addClaimerParam(savedState.orderUrls[savedState.currentIndex], savedState.debug);

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

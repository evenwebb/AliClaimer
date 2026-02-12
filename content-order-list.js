chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'collectOrders') {
    clickProcessedTabAndCollect()
      .then(urls => sendResponse({ orderUrls: urls }))
      .catch(e => {
        console.error('Failed to collect orders:', e);
        sendResponse({ orderUrls: [], error: e.message });
      });
    return true;
  }
});

async function clickProcessedTabAndCollect() {
  const processedTab = findProcessedTab();
  if (processedTab && !processedTab.classList.contains('comet-tabs-nav-item-active')) {
    try {
      processedTab.click();
      console.log('AliClaimer: Clicked "Processed" tab, waiting for orders to load...');
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.warn('AliClaimer: Failed to click Processed tab:', e);
    }
  }

  return await collectOrderUrlsWithRetry();
}

function findProcessedTab() {
  const tabs = document.querySelectorAll('.comet-tabs-nav-item');
  for (const tab of tabs) {
    if (tab.textContent.trim() === 'Processed') {
      return tab;
    }
  }
  return null;
}

function findViewOrdersButton() {
  const btns = document.querySelectorAll('button.comet-btn');
  for (const btn of btns) {
    if (btn.textContent.includes('View orders')) {
      return btn;
    }
  }
  return null;
}

async function loadOneMoreBatch() {
  const btn = findViewOrdersButton();
  if (btn) {
    try {
      btn.click();
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.error('Failed to load more orders:', e);
    }
  }
}

async function collectOrderUrlsWithRetry(maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    const urls = collectOrderUrls();
    if (urls.length > 0) return urls;
    await new Promise(r => setTimeout(r, 800));
  }
  return [];
}

async function loadMoreAndCollect() {
  const processedTab = findProcessedTab();
  if (processedTab && !processedTab.classList.contains('comet-tabs-nav-item-active')) {
    try {
      processedTab.click();
      console.log('AliClaimer: Re-clicked "Processed" tab');
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.warn('AliClaimer: Failed to click Processed tab:', e);
    }
  }

  await loadOneMoreBatch();
  for (let i = 0; i < 10; i++) {
    const urls = collectOrderUrls();
    if (urls.length > 0) return urls;
    await new Promise(r => setTimeout(r, 800));
  }
  return [];
}

chrome.storage.local.get('aliclaimerLoadMore').then(({ aliclaimerLoadMore }) => {
  if (aliclaimerLoadMore) {
    setTimeout(() => {
      loadMoreAndCollect().then(orderUrls => {
        try {
          if (chrome.runtime?.id) {
            chrome.runtime.sendMessage({ action: 'collectMoreOrders', orderUrls });
          }
        } catch (e) {
          console.warn('AliClaimer: could not send message', e);
        }
      }).catch(e => {
        console.error('AliClaimer: failed to load and collect orders', e);
      });
    }, 800);
  }
}).catch(e => {
  console.error('AliClaimer: failed to check for load more state', e);
});

function collectOrderUrls() {
  const seen = new Set();
  const urls = [];

  try {
    const links = document.querySelectorAll('a[href*="orderId="], a[href*="detail.html"]');

    for (const a of links) {
      try {
        const href = a.href || a.getAttribute('href') || '';
        if (!href) continue;

        const match = href.match(/orderId=(\d+)/i);
        if (!match) continue;

        const orderId = match[1];
        if (seen.has(orderId)) continue;

        seen.add(orderId);

        let fullUrl;
        if (href.startsWith('http')) {
          fullUrl = href;
        } else {
          try {
            fullUrl = new URL(href, location.origin).href;
          } catch (e) {
            console.warn('Failed to parse URL:', href, e);
            continue;
          }
        }

        if (fullUrl.includes('detail.html') && fullUrl.includes('orderId=')) {
          const urlObj = new URL(fullUrl);
          const cleanUrl = urlObj.origin + urlObj.pathname + '?orderId=' + orderId;
          urls.push(cleanUrl);
        }
      } catch (e) {
        console.warn('Failed to process link:', e);
      }
    }
  } catch (e) {
    console.error('Failed to collect order URLs:', e);
  }

  return urls;
}

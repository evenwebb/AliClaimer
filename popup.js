function renderStats(stats) {
  const el = document.getElementById('stats');
  if (!stats || (stats.checked === 0 && !stats.total)) {
    el.classList.add('empty');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('empty');
  el.innerHTML = `
    <div class="stats-row"><strong>Orders checked:</strong> ${stats.checked} / ${stats.total}</div>
    <div class="stats-row"><strong>Coupons found:</strong> ${stats.couponsFound}</div>
    ${!stats.previewMode ? `<div class="stats-row"><strong>Coupons claimed:</strong> ${stats.couponsClaimed || 0}</div>` : ''}
    ${!stats.previewMode && stats.totalValueClaimed ? `<div class="stats-row"><strong>Total value:</strong> £${(stats.totalValueClaimed || 0).toFixed(2)}</div>` : ''}
    ${stats.previewMode ? '<div class="stats-row" style="color:#666">Preview mode – Coupons not claimed</div>' : ''}
  `;
}

function updateProgressBar(checked, total) {
  const bar = document.getElementById('progressBar');
  const pct = document.getElementById('progressPct');
  if (total > 0) {
    bar.value = checked;
    bar.max = total;
    pct.textContent = Math.round((checked / total) * 100) + '%';
  } else {
    bar.value = 0;
    bar.max = 100;
    pct.textContent = '0%';
  }
}

function renderOrderStatuses(statuses) {
  const list = document.getElementById('orderStatusList');
  if (!statuses || statuses.length === 0) {
    list.classList.add('empty');
    list.innerHTML = '';
    return;
  }
  list.classList.remove('empty');

  const labels = { claimed: 'Claimed', found: 'Found', none: 'None', timeout: 'Timeout', pending: 'Pending' };
  list.innerHTML = statuses.map(s => `
    <div class="order-status-item">
      <span class="order-status-dot ${s.status}"></span>
      <span class="order-status-id">#${s.orderId.slice(-8)}</span>
      <span class="order-status-label">${labels[s.status] || s.status}</span>
    </div>
  `).join('');

  // Scroll to bottom to show latest
  list.scrollTop = list.scrollHeight;
}

async function loadStats() {
  try {
    const { aliclaimerStats } = await chrome.storage.local.get('aliclaimerStats');
    renderStats(aliclaimerStats);
    if (aliclaimerStats) {
      updateProgressBar(aliclaimerStats.checked || 0, aliclaimerStats.total || 0);
    }
  } catch (e) {
    console.error('Failed to load stats:', e);
  }
}

async function loadOrderStatuses() {
  try {
    const { aliclaimerOrderStatuses = [] } = await chrome.storage.local.get('aliclaimerOrderStatuses');
    renderOrderStatuses(aliclaimerOrderStatuses);
  } catch (e) {
    console.error('Failed to load order statuses:', e);
  }
}

function updateButtonState(running) {
  document.getElementById('startBtn').disabled = running;
  document.getElementById('stopBtn').disabled = !running;
}

async function loadDelayConfig() {
  try {
    const { aliclaimerDelay } = await chrome.storage.local.get('aliclaimerDelay');
    const val = aliclaimerDelay != null ? parseInt(aliclaimerDelay, 10) : 1500;
    const slider = document.getElementById('delaySlider');
    slider.value = val;
    updateDelayLabel(val);
  } catch (e) {
    updateDelayLabel(1500);
  }
}

function updateDelayLabel(ms) {
  document.getElementById('delayValue').textContent = (ms / 1000).toFixed(1) + 's';
}

// Persist delay changes
document.getElementById('delaySlider').addEventListener('input', (e) => {
  const ms = parseInt(e.target.value, 10);
  updateDelayLabel(ms);
  chrome.storage.local.set({ aliclaimerDelay: ms }).catch(() => {});
});

async function loadPopupState() {
  await loadStats();
  await loadOrderStatuses();
  await loadDelayConfig();
  try {
    const { aliclaimerRunning } = await chrome.storage.local.get('aliclaimerRunning');
    updateButtonState(!!aliclaimerRunning);
  } catch (e) {
    console.error('Failed to load popup state:', e);
  }
}

function setStatus(message, isError = false) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = '';

  if (typeof message === 'string') {
    if (isError) {
      const errorSpan = document.createElement('span');
      errorSpan.className = 'error';
      errorSpan.textContent = message;
      statusEl.appendChild(errorSpan);
    } else {
      statusEl.textContent = message;
    }
  } else {
    statusEl.appendChild(message);
  }
}

function createLinkElement(text, url) {
  const container = document.createElement('span');
  container.className = 'error';
  container.textContent = text + ' ';

  const br = document.createElement('br');
  container.appendChild(br);

  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.textContent = url.replace('https://', '');
  container.appendChild(link);

  return container;
}

async function sendMessageWithTimeout(tabId, message, timeoutMs = 10000) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Message timeout')), timeoutMs)
    )
  ]);
}

document.addEventListener('DOMContentLoaded', loadPopupState);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.aliclaimerStats) {
    const stats = changes.aliclaimerStats.newValue;
    renderStats(stats);
    if (stats && stats.total) {
      updateProgressBar(stats.checked || 0, stats.total);
    }
  }
  if (changes.aliclaimerRunning) {
    updateButtonState(!!changes.aliclaimerRunning.newValue);
  }
  if (changes.aliclaimerOrderStatuses) {
    renderOrderStatuses(changes.aliclaimerOrderStatuses.newValue);
  }
});

document.getElementById('startBtn').addEventListener('click', async () => {
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const previewMode = document.getElementById('previewCheck').checked;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url?.includes('aliexpress.com/p/order/')) {
      const linkEl = createLinkElement(
        'Please open your AliExpress order list first:',
        'https://www.aliexpress.com/p/order/index.html'
      );
      setStatus(linkEl);
      return;
    }

    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus(previewMode ? 'Scanning in preview mode (no claims)...' : 'Scanning for orders...');

    let response;
    try {
      response = await sendMessageWithTimeout(tab.id, { action: 'collectOrders' });
    } catch (e) {
      throw new Error('Could not communicate with page. Please refresh and try again.');
    }

    if (!response?.orderUrls?.length) {
      setStatus('No orders found. Scroll down to load more orders, then try again.', true);
      startBtn.disabled = false;
      stopBtn.disabled = true;
      chrome.storage.local.set({ aliclaimerRunning: false }).catch(() => {});
      return;
    }

    setStatus(`Found ${response.orderUrls.length} orders. Starting${previewMode ? ' (preview)' : ''}...`);

    chrome.storage.local.set({ aliclaimerRunning: true }).catch(() => {});

    const startResponse = await chrome.runtime.sendMessage({
      action: 'startClaiming',
      orderUrls: response.orderUrls,
      tabId: tab.id,
      previewMode,
      orderListUrl: tab.url
    });

    if (!startResponse?.ok) {
      throw new Error(startResponse?.error || 'Failed to start claiming process');
    }

    setStatus(`Processing ${response.orderUrls.length} orders. Check stats and order list below.`);
  } catch (e) {
    console.error('Start error:', e);
    const errorMsg = e.message || 'An error occurred. Please refresh the page and try again.';
    setStatus(errorMsg, true);
    startBtn.disabled = false;
    stopBtn.disabled = true;
    chrome.storage.local.set({ aliclaimerRunning: false }).catch(() => {});
  }
});

document.getElementById('stopBtn').addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ action: 'stop' });
    setStatus('Stopped.');
  } catch (e) {
    console.error('Stop error:', e);
    setStatus('Stopped.');
  }

  chrome.storage.local.set({ aliclaimerRunning: false }).catch(() => {});
  updateButtonState(false);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'progress' && typeof msg.text === 'string') {
    setStatus(msg.text);
  }
});

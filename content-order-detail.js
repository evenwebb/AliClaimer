const isClaimerFlow = () => new URLSearchParams(location.search).get('aliclaimer') === '1';
const isPreviewMode = () => new URLSearchParams(location.search).get('aliclaimerpreview') === '1';

/** Find Collect buttons using scoped query within item-action containers (fix #16) */
function findCollectButtons() {
  const items = document.querySelectorAll('.item-action');
  const btns = [];
  for (const item of items) {
    if (!item.querySelector('.action-content')) continue;
    const btn = item.querySelector('.action-btn');
    if (btn && btn.textContent.trim() === 'Collect') {
      btns.push(btn);
    }
  }
  return btns;
}

async function waitForCollectButtons(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const btns = findCollectButtons();
    if (btns.length > 0) return btns;
    await new Promise(r => setTimeout(r, 300));
  }
  return [];
}

/** Show a banner that auto-removes after the page navigates away or after a timeout */
function showBanner(text, background, color, durationMs = 8000) {
  const banner = document.createElement('div');
  banner.style.cssText = `position:fixed;top:0;left:0;right:0;background:${background};color:${color};padding:12px;text-align:center;z-index:99999;font-weight:bold;font-size:14px;`;
  banner.textContent = text;
  document.body.prepend(banner);
  // Auto-remove after duration (fix #15, #17)
  setTimeout(() => { if (banner.parentNode) banner.remove(); }, durationMs);
  return banner;
}

async function run() {
  if (!isClaimerFlow()) return;

  // Wrap entire run in try/catch so safeSendMessage always fires (fix #14)
  let couponFound = 0;
  let couponClaimed = 0;
  const previewMode = isPreviewMode();

  try {
    const btns = await waitForCollectButtons();
    couponFound = btns.length;

    if (!previewMode && btns.length > 0) {
      for (const btn of btns) {
        try {
          btn.click();
          await new Promise(r => setTimeout(r, 800));
        } catch (e) {
          console.error('Failed to click collect button:', e);
        }
      }
      couponClaimed = btns.length;
    } else if (previewMode && btns.length > 0) {
      showBanner(`[Preview] Found ${btns.length} coupon(s) – not claiming`, '#f90', '#000', 8000);
    }
  } catch (e) {
    console.error('AliClaimer: run() error:', e);
  }

  safeSendMessage({ action: 'orderDetailDone', couponFound, couponClaimed });
}

function safeSendMessage(msg) {
  try {
    if (typeof chrome?.runtime?.sendMessage !== 'function') {
      console.warn('Chrome runtime not available');
      return;
    }
    chrome.runtime.sendMessage(msg).catch((e) => {
      console.warn('Failed to send message:', e);
    });
  } catch (e) {
    console.warn('Exception sending message:', e);
  }
}

try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action === 'showComplete') {
      const preview = isPreviewMode();
      showBanner(
        preview
          ? 'Preview scan complete! Check extension popup for stats.'
          : 'All orders scanned! Close this tab or go back to your order list.',
        preview ? '#f90' : '#0a0',
        preview ? '#000' : '#fff',
        15000
      );
    }
  });
} catch (e) {
  console.warn('Failed to set up message listener:', e);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', run);
} else {
  run();
}

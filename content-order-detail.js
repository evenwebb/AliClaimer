const isClaimerFlow = () => new URLSearchParams(location.search).get('aliclaimer') === '1';
const isPreviewMode = () => new URLSearchParams(location.search).get('aliclaimerpreview') === '1';

async function waitForCollectButtons(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const btns = [];
    for (const btn of document.querySelectorAll('.action-btn')) {
      if (btn.textContent.trim() === 'Collect') {
        const parent = btn.closest('.item-action');
        if (parent && parent.querySelector('.action-content')) {
          btns.push(btn);
        }
      }
    }
    if (btns.length > 0) return btns;
    await new Promise(r => setTimeout(r, 300));
  }
  return [];
}

async function run() {
  if (!isClaimerFlow()) {
    return;
  }

  const previewMode = isPreviewMode();
  const btns = await waitForCollectButtons();

  if (!previewMode && btns.length > 0) {
    for (const btn of btns) {
      try {
        btn.click();
        await new Promise(r => setTimeout(r, 800));
      } catch (e) {
        console.error('Failed to click collect button:', e);
      }
    }
  } else if (previewMode && btns.length > 0) {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#f90;color:#000;padding:10px;text-align:center;z-index:99999;font-size:13px;font-weight:bold;';
    banner.textContent = `[Preview] Found ${btns.length} coupon(s) – not claiming`;
    document.body.prepend(banner);
    setTimeout(() => banner.remove(), 3000);
  }

  const couponClaimed = previewMode ? 0 : btns.length;
  safeSendMessage({
    action: 'orderDetailDone',
    couponFound: btns.length,
    couponClaimed
  });
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
      const banner = document.createElement('div');
      const preview = isPreviewMode();
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;color:#fff;padding:12px;text-align:center;z-index:99999;font-weight:bold;';
      banner.style.background = preview ? '#f90' : '#0a0';
      banner.style.color = preview ? '#000' : '#fff';
      banner.textContent = preview
        ? 'Preview scan complete! Check extension popup for stats.'
        : 'All orders scanned! Close this tab or go back to your order list.';
      document.body.prepend(banner);
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

'use strict';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const params = new URLSearchParams(location.search);
const orderId = params.get('orderId');
const previewMode = params.get('aliclaimerpreview') === '1';
function collectButtons() {
  return [...document.querySelectorAll('.item-action .action-btn,button,a,[role="button"],.service-progress-button')]
    .filter(button => {
      const label = button.textContent.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-GB');
      const couponAction = /^(collect|collect coupon|claim coupon|get coupon|collect now|claim coupon now|get coupon now|receive coupon)$/.test(label);
      const progressCouponAction = button.matches?.('.service-progress-button') && /^collect\b/i.test(label) && /(coupon|\d)/i.test(label);
      return (couponAction || progressCouponAction) &&
      !button.disabled && button.getAttribute('aria-disabled') !== 'true';
    });
}
function completedProgressCouponLabels() {
  return [...document.querySelectorAll('.service-progress-node-completed .service-progress-node-text')]
    .map(node => node.textContent.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-GB'))
    .filter(label => /^use\b.*\d/.test(label));
}
function couponClaimConfirmation(page = document) {
  const pages = [page];
  for (const iframe of page.querySelectorAll('iframe.otg-modal-iframe')) {
    try { if (iframe.contentDocument) pages.push(iframe.contentDocument); } catch {}
  }
  for (const currentPage of pages) {
    const text = currentPage.body?.innerText || '';
    if (/your coupon code is ready|coupon.{0,30}(collected|claimed|received)|(?:collected|claimed|received).{0,30}coupon|find it in account\s*>\s*coupons/i.test(text)) {
      return /your coupon code is ready|find it in account\s*>\s*coupons/i.test(text) ? 'coupon-ready-modal' : 'success-message';
    }
  }
  return '';
}
function showNotice(text, warning = false) {
  const node = document.createElement('div');
  node.setAttribute('role', warning ? 'alert' : 'status');
  node.setAttribute('aria-live', 'polite');
  node.textContent = text;
  node.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:12px;text-align:center;background:${warning ? '#8a4b00' : '#176b35'};color:#fff;font:600 14px system-ui,sans-serif`;
  document.body.prepend(node); setTimeout(() => node.remove(), 10000);
}
function report(status, note = '') {
  if (!/^\d+$/.test(orderId || '')) return;
  chrome.runtime.sendMessage({ action: 'orderResult', orderId, status, note }).catch(() => {});
}
async function waitForButtons(timeout = 9000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const buttons = collectButtons();
    if (buttons.length || completedProgressCouponLabels().length) return buttons;
    await sleep(250);
  }
  return [];
}
async function run() {
  if (params.get('aliclaimer') !== '1' || !/^\d+$/.test(orderId || '')) return;
  const authorized = await chrome.runtime.sendMessage({action:'authorizeOrder',orderId}).catch(()=>null);
  if (!authorized?.ok) { showNotice('Scan paused. Review the extension popup before continuing.', true); return; }
  const buttons = await waitForButtons();
  if (completedProgressCouponLabels().length) {
    const note = 'AliExpress shows this coupon as already claimed.';
    showNotice(note); report('claimed', note); return;
  }
  if (!buttons.length) {
    const actionButtons = document.querySelectorAll('.item-action .action-btn');
    const couponActionCount = document.querySelectorAll('button,a,[role="button"],.service-progress-button').length;
    const englishOrderPage = document.querySelector('.item-action') ||
      /order\s+(details|information|date|status|number|id|placed|time|total|items)|tracking|track order|delivery|shipping|shipment|contact seller|leave feedback|refund|buyer protection|product information/i.test(document.body.innerText);
    const note = actionButtons.length || (couponActionCount && !englishOrderPage)
      ? 'The order page language or coupon controls are unsupported. Switch AliExpress to English, then review this order manually.'
      : englishOrderPage
        ? 'No claimable coupon was found on this order.'
        : 'This AliExpress order layout is not recognized. Refresh the page and report the layout change.';
    const status = actionButtons.length || !englishOrderPage ? 'unsupported' : 'none';
    showNotice(note, status === 'unsupported'); report(status, note); return;
  }
  if (previewMode) { showNotice('Preview: an eligible coupon button was found; nothing was claimed.'); report('available'); return; }
  // One late-delivery coupon is allowed per order; never click multiple matching controls.
  const claimAuthorization = await chrome.runtime.sendMessage({action:'authorizeClaim',orderId}).catch(()=>null);
  if (!claimAuthorization?.ok) { showNotice('Claim not started because the scan is paused.', true); return; }
  const beforeText = document.body.innerText;
  const completedCouponsBefore = new Set(completedProgressCouponLabels());
  buttons[0].click();
  showNotice('Claim action sent. Waiting for AliExpress confirmation.');
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    const current = document.body.innerText;
    const confirmation = couponClaimConfirmation();
    const newCompletedCoupon = completedProgressCouponLabels().some(label => !completedCouponsBefore.has(label));
    if (confirmation || (current !== beforeText && /coupon.{0,30}(collected|claimed|received)|(?:collected|claimed|received).{0,30}coupon/i.test(current)) || newCompletedCoupon) {
      showNotice('AliExpress confirmed the coupon claim.'); report('claimed'); return;
    }
  }
  report('uncertain', 'AliExpress did not confirm the claim. Check your coupon wallet before retrying.');
}
chrome.runtime.onMessage.addListener(message => {
  if (message?.action === 'showNotice') showNotice(message.text || 'Scan complete.');
});
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
else run();

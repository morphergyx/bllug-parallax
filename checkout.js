/* checkout.js — runs only on checkout.html.
   Contains: cart rehydration from localStorage (the homepage/details pages
   write the cart here before navigating in), the 4-step wizard, OTP flow,
   shipping validation, and the Razorpay order/verify flow.

   IMPORTANT: the Apps Script backend contract (action strings, request
   bodies, response fields) below is byte-for-byte identical to the original
   script.js — nothing here changes what's sent to or expected back from
   Google Apps Script. */

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyeun-1Yt9v3fVuGRKO7PHRR3ohqSP-RT7QTcCF25VQSmUCcdaKGG4WezT6yu3gBPjhWg/exec";
const PRODUCT_STOCK_LIMIT = 100; // pieces per series (not a shared pool)
const STOCK_CACHE_STORAGE_KEY = 'bllug_remaining_stock_by_product';
const CART_STORAGE_KEY = 'bllug_cart_items'; // shared with script.js on the storefront pages

let globalCartStorageArray = [];
let currentWizardStepIndex = 1;
let otpTimerInterval = null;
let otpSecondsRemaining = 60;

// ---------------------------------------------------------------------
// Cart persistence (read side). The storefront pages write to this same
// localStorage key on every cart mutation; checkout.html only ever reads
// it once on load, then keeps its own in-memory copy for the duration of
// the checkout session — exactly like the old in-page overlay did, just
// rehydrated from storage instead of carried over in a JS variable that
// never unloaded.
// ---------------------------------------------------------------------
function readCartFromStorage() {
    try {
        const raw = localStorage.getItem(CART_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        return [];
    }
}

function writeCartToStorage() {
    try {
        localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(globalCartStorageArray));
    } catch (err) {
        // Non-fatal — checkout can continue with the in-memory copy for this session.
    }
}

// ---------------------------------------------------------------------
// Stock cache helpers — duplicated from script.js (not imported, since
// these pages don't share a module system) but byte-identical in logic,
// reading/writing the exact same localStorage key, so the cache stays
// consistent no matter which page last touched it.
// ---------------------------------------------------------------------
function normalizeProductKey(name) {
    return String(name || '').trim().toUpperCase();
}

function readRemainingStockCache() {
    try {
        const raw = localStorage.getItem(STOCK_CACHE_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (err) {
        return {};
    }
}

function writeRemainingStockCache(remainingMap) {
    try {
        localStorage.setItem(STOCK_CACHE_STORAGE_KEY, JSON.stringify(remainingMap || {}));
    } catch (err) {
        // localStorage write failures are non-fatal; UI just won't persist across reloads.
    }
}

function mergeRemainingStockCache(remainingMap) {
    if (!remainingMap || typeof remainingMap !== 'object') return;
    const current = readRemainingStockCache();
    Object.keys(remainingMap).forEach(key => {
        const value = Number(remainingMap[key]);
        if (Number.isFinite(value)) {
            current[normalizeProductKey(key)] = Math.min(PRODUCT_STOCK_LIMIT, Math.max(0, value));
        }
    });
    writeRemainingStockCache(current);
}

function getCartReservedPiecesForProduct(productName) {
    const key = normalizeProductKey(productName);
    return globalCartStorageArray.reduce((sum, item) => {
        return normalizeProductKey(item.name) === key ? sum + item.quantity : sum;
    }, 0);
}

async function syncConfirmedStockFromBackend() {
    try {
        const stockRes = await fetch(APPS_SCRIPT_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({ action: "get_stock" })
        });
        const stockData = await stockRes.json();
        if (stockData && stockData.success && stockData.remainingStockByProduct) {
            mergeRemainingStockCache(stockData.remainingStockByProduct);
        }
    } catch (err) {
        // Stock sync is best-effort; checkout falls back to last-known cached values.
    }
}

function recordSuccessfulPurchase(purchasedItems, verifyResponsePayload) {
    if (verifyResponsePayload && verifyResponsePayload.remainingStockByProduct) {
        mergeRemainingStockCache(verifyResponsePayload.remainingStockByProduct);
    }
}

// ---------------------------------------------------------------------
// Page bootstrap: rehydrate cart from storage, re-validate stock (same
// trimming behavior that launchCheckoutFlow used to do before revealing
// the overlay), then render the summary or the empty-cart state.
// ---------------------------------------------------------------------
async function initCheckoutPage() {
    globalCartStorageArray = readCartFromStorage();

    if (globalCartStorageArray.length === 0) {
        showEmptyCartState();
        return;
    }

    await syncConfirmedStockFromBackend();

    const trimmedItems = [];
    globalCartStorageArray.forEach(item => {
        const reservedByOthersInCart = getCartReservedPiecesForProduct(item.name) - item.quantity;
        const cap = readRemainingStockCache()[normalizeProductKey(item.name)];
        const allowedForThisLine = Number.isFinite(cap) ? Math.max(0, cap - Math.max(0, reservedByOthersInCart)) : item.quantity;
        if (allowedForThisLine <= 0) {
            trimmedItems.push(item.name);
        } else if (allowedForThisLine < item.quantity) {
            item.quantity = allowedForThisLine;
            trimmedItems.push(item.name + ' (reduced to ' + allowedForThisLine + ')');
        }
    });
    globalCartStorageArray = globalCartStorageArray.filter(item => item.quantity > 0);
    writeCartToStorage();

    if (trimmedItems.length > 0) {
        alert("[STOCK_UPDATED] Some items changed since you added them:\n" + trimmedItems.join('\n'));
    }

    if (globalCartStorageArray.length === 0) {
        showEmptyCartState();
        return;
    }

    mirrorDataToSummaryGrid();
    currentWizardStepIndex = 1;
    renderWizardStepUiState();
}

function showEmptyCartState() {
    const wizardArea = document.querySelector('.flex-grow.flex.flex-col.justify-center.w-full.mx-auto');
    const navButtons = document.getElementById('wizard-nav-buttons');
    const progressBar = document.querySelector('.w-full.mt-4.mb-12');
    const emptyState = document.getElementById('checkout-empty-state');

    document.querySelectorAll('.step-container').forEach(el => el.classList.add('hidden'));
    if (progressBar) progressBar.classList.add('hidden');
    if (navButtons) navButtons.classList.add('hidden');
    if (emptyState) {
        emptyState.classList.remove('hidden');
        emptyState.classList.add('flex');
    }
}

document.addEventListener('DOMContentLoaded', initCheckoutPage);

// ---------------------------------------------------------------------
// Cart subtotal/total — checkout.html doesn't have the cart drawer's
// #cart-subtotal/#cart-shipping/#cart-total elements (those only exist
// on the storefront pages), so the totals are computed directly here
// instead of mirrored from the drawer like the old mirrorDataToSummaryGrid
// used to do.
// ---------------------------------------------------------------------
function mirrorDataToSummaryGrid() {
    const targetWrap = document.getElementById('checkout-summary-items');
    targetWrap.innerHTML = '';

    let subtotal = 0;
    globalCartStorageArray.forEach(item => {
        subtotal += item.price * item.quantity;
        const summaryRow = document.createElement('div');
        summaryRow.className = "flex gap-4 items-center py-4 border-b border-[#262626]";
        summaryRow.innerHTML = `
            <div class="w-14 h-16 bg-[#141414] rounded overflow-hidden flex-shrink-0 border border-[#262626]">
                <img src="${item.image}" class="w-full h-full object-cover">
            </div>
            <div class="flex-grow flex justify-between items-center">
                <div>
                    <h5 class="font-sans text-[13px] text-primary uppercase font-bold tracking-tight">${item.name}</h5>
                    <p class="font-label-mono text-[11px] text-on-surface-variant uppercase mt-0.5">SIZE: ${item.size} <span class="mx-1 text-[#262626]">|</span> QTY: ${item.quantity}</p>
                </div>
                <span class="font-label-mono text-[13px] text-primary font-bold">₹${(item.price * item.quantity).toLocaleString()}</span>
            </div>`;
        targetWrap.appendChild(summaryRow);
    });

    document.getElementById('checkout-subtotal').innerText = subtotal.toLocaleString();
    document.getElementById('checkout-shipping').innerText = 'FREE';
    document.getElementById('checkout-total').innerText = subtotal.toLocaleString();
}

function jumpToWizardStepDirect(targetStepIndex) {
    if (targetStepIndex > currentWizardStepIndex) {
        if (currentWizardStepIndex === 1 && !validateStepOneInputs()) return;
        if (currentWizardStepIndex === 3 && !validateStepThreeInputs()) return;
        if (targetStepIndex > currentWizardStepIndex + 1) return;
    }
    currentWizardStepIndex = targetStepIndex;
    renderWizardStepUiState();
}

async function validateStepOneInputs() {
    const mail  = document.getElementById('input-email').value.trim();
    const phone = document.getElementById('input-phone').value.trim();
    if (!mail || !phone) {
        alert("[VALIDATION_ERROR] Provide necessary identification coordinates to proceed.");
        return false;
    }

    const nextBtn = document.getElementById('btn-wizard-next');
    nextBtn.innerText = "SENDING TOKEN...";
    nextBtn.disabled  = true;

    try {
        const res  = await fetch(APPS_SCRIPT_URL, {
            method : "POST",
            headers: { "Content-Type": "text/plain" },
            body   : JSON.stringify({ action: "send", email: mail })
        });
        const data = await res.json();

        if (!data.success) {
            alert("[OTP_ERROR] " + data.message);
            nextBtn.innerText = "PROCEED";
            nextBtn.disabled  = false;
            return false;
        }

        document.getElementById('badge-target-email').innerText = mail;
        startOtpTimer();
        return true;

    } catch (err) {
        alert("[NETWORK_ERROR] Could not reach verification gateway.");
        nextBtn.innerText = "PROCEED";
        nextBtn.disabled  = false;
        return false;
    }
}

function startOtpTimer() {
    clearInterval(otpTimerInterval);
    otpSecondsRemaining = 60;

    const timerDisplay = document.getElementById('otp-timer-display');
    const resendBtn   = document.getElementById('otp-resend-btn');

    resendBtn.disabled = true;
    resendBtn.style.pointerEvents = 'none';
    resendBtn.classList.remove('text-primary', 'border-primary', 'cursor-pointer');
    resendBtn.classList.add('text-[#4b4b4b]', 'border-[#4b4b4b]/40', 'cursor-not-allowed');

    function tick() {
        const mins = String(Math.floor(otpSecondsRemaining / 60)).padStart(2, '0');
        const secs = String(otpSecondsRemaining % 60).padStart(2, '0');
        timerDisplay.innerText = `${mins}:${secs}`;

        if (otpSecondsRemaining <= 0) {
            clearInterval(otpTimerInterval);
            timerDisplay.innerText = '00:00';
            resendBtn.disabled = false;
            resendBtn.style.pointerEvents = 'auto';
            resendBtn.classList.add('text-primary', 'border-primary', 'cursor-pointer');
            resendBtn.classList.remove('text-[#4b4b4b]', 'border-[#4b4b4b]/40', 'cursor-not-allowed');
        }
        otpSecondsRemaining--;
    }

    tick();
    otpTimerInterval = setInterval(tick, 1000);
}

function validateStepThreeInputs() {
    const first = document.getElementById('ship-first').value.trim();
    const last = document.getElementById('ship-last').value.trim();
    const street = document.getElementById('ship-street').value.trim();
    const city = document.getElementById('ship-city').value.trim();
    const state = document.getElementById('ship-state').value.trim();
    const pin = document.getElementById('ship-pin').value.trim();

    if (!first || !last || !street || !city || !state || !pin) {
        alert("[VALIDATION_ERROR] Missing routing parameters. Complete all required fields.");
        return false;
    }

    document.getElementById('summary-name').innerText = `${first} ${last}`;
    document.getElementById('summary-contact').innerText = `${document.getElementById('input-email').value} | ${document.getElementById('input-phone').value}`;
    document.getElementById('summary-address').innerText = `${street}, ${city}, ${state} - ${pin}, India`;
    return true;
}

async function navigateWizardSteps(direction) {
    if (direction === 1) {
        if (currentWizardStepIndex === 1) {
            const ok = await validateStepOneInputs();
            if (!ok) return;
        }
        if (currentWizardStepIndex === 2) {
            const ok = await verifyOtpInput();
            if (!ok) return;
        }
        if (currentWizardStepIndex === 3 && !validateStepThreeInputs()) return;
        if (currentWizardStepIndex === 4) {
            executeGatewayPaymentRedirect();
            return;
        }
    }

    currentWizardStepIndex += direction;
    renderWizardStepUiState();

    if (currentWizardStepIndex === 4) {
        mirrorDataToSummaryGrid();
    }
}

async function verifyOtpInput() {
    const email = document.getElementById('input-email').value.trim();
    const otp   = document.getElementById('otp-email-input').value.trim();

    if (!otp || otp.length !== 6) {
        alert("[VALIDATION_ERROR] Enter the complete 6-digit token.");
        return false;
    }

    const nextBtn = document.getElementById('btn-wizard-next');
    nextBtn.innerText = "VERIFYING...";
    nextBtn.disabled  = true;

    try {
        const res  = await fetch(APPS_SCRIPT_URL, {
            method : "POST",
            headers: { "Content-Type": "text/plain" },
            body   : JSON.stringify({ action: "verify", email, otp })
        });
        const data = await res.json();

        if (!data.success) {
            alert("[VERIFICATION_FAILED] " + data.message);
            nextBtn.innerText = "VERIFY TOKENS";
            nextBtn.disabled  = false;
            document.getElementById('otp-email-input').style.borderColor = "#ff4444";
            setTimeout(() => {
                document.getElementById('otp-email-input').style.borderColor = "";
            }, 2000);
            return false;
        }

        clearInterval(otpTimerInterval);
        return true;

    } catch (err) {
        alert("[NETWORK_ERROR] " + err.message);
        nextBtn.innerText = "VERIFY TOKENS";
        nextBtn.disabled  = false;
        return false;
    }
}

async function resendOtpToken() {
    const email = document.getElementById('input-email').value.trim();
    const otpInput = document.getElementById('otp-email-input');
    if (otpInput) otpInput.value = '';

    const resendBtn = document.getElementById('otp-resend-btn');
    resendBtn.innerText = "[SENDING...]";
    resendBtn.style.pointerEvents = 'none';

    try {
        const res  = await fetch(APPS_SCRIPT_URL, {
            method : "POST",
            headers: { "Content-Type": "text/plain" },
            body   : JSON.stringify({ action: "send", email })
        });
        const data = await res.json();
        if (!data.success) alert("[RESEND_ERROR] " + data.message);
    } catch (err) {
        alert("[NETWORK_ERROR] Could not reach verification gateway.");
    }

    resendBtn.innerText = "[RESEND_TOKEN]";
    startOtpTimer();
}

function renderWizardStepUiState() {
    document.querySelectorAll('.step-container').forEach((container, idx) => {
        if (idx + 1 === currentWizardStepIndex) {
            container.classList.remove('hidden');
            container.classList.add('block');
        } else {
            container.classList.remove('block');
            container.classList.add('hidden');
        }
    });

    const totalNodeSteps = 4;
    const stepPercentWidthValue = ((currentWizardStepIndex - 1) / (totalNodeSteps - 1)) * 100;
    document.getElementById('wizard-progress-bar-line').style.width = `${stepPercentWidthValue}%`;

    for (let i = 1; i <= totalNodeSteps; i++) {
        const nodeEl = document.getElementById(`step-node-${i}`);
        const textEl = document.getElementById(`step-text-${i}`);

        if (i < currentWizardStepIndex) {
            nodeEl.className = "w-10 h-10 flex items-center justify-center font-label-mono text-[14px] bg-primary text-background border-2 border-primary font-bold shadow-[0_0_10px_rgba(255,255,255,0.3)] animate-none";
            textEl.className = "mt-2 font-label-mono text-[10px] tracking-wider uppercase text-primary font-medium";
            nodeEl.innerHTML = `<span class="material-symbols-outlined text-[16px] font-bold">check</span>`;
        } else if (i === currentWizardStepIndex) {
            nodeEl.className = "w-10 h-10 flex items-center justify-center font-label-mono text-[14px] bg-primary text-background border-2 border-primary font-bold scale-110 shadow-[0_0_15px_rgba(255,255,255,0.5)]";
            textEl.className = "mt-2 font-label-mono text-[10px] tracking-wider uppercase text-primary font-bold";
            nodeEl.innerHTML = i;
        } else {
            nodeEl.className = "w-10 h-10 flex items-center justify-center font-label-mono text-[14px] bg-[#141414] text-[#4b4b4b] border-2 border-[#262626]";
            textEl.className = "mt-2 font-label-mono text-[10px] tracking-wider uppercase text-[#4b4b4b]";
            nodeEl.innerHTML = i;
        }
    }

    const backBtn = document.getElementById('btn-wizard-back');
    const nextBtn = document.getElementById('btn-wizard-next');
    nextBtn.disabled = false;

    if (currentWizardStepIndex === 1) {
        backBtn.classList.add('invisible');
    } else {
        backBtn.classList.remove('invisible');
    }

    if (currentWizardStepIndex === 4) {
        nextBtn.innerText = "MAKE PAYMENT";
        nextBtn.className = "w-full bg-primary text-background font-label-mono text-label-limit py-4 hover:bg-[#ffffff]/90 transition-all uppercase tracking-widest font-bold shadow-[0_0_25px_rgba(255,255,255,0.35)] rounded";
    } else if (currentWizardStepIndex === 2) {
        nextBtn.innerText = "VERIFY TOKENS";
        nextBtn.className = "w-full bg-primary text-background font-label-mono text-label-limit py-4 hover:bg-on-surface-variant hover:text-primary transition-all uppercase tracking-widest font-bold rounded";
    } else {
        nextBtn.innerText = "PROCEED";
        nextBtn.className = "w-full bg-primary text-background font-label-mono text-label-limit py-4 hover:bg-on-surface-variant hover:text-primary transition-all uppercase tracking-widest font-bold rounded";
    }
}

async function executeGatewayPaymentRedirect() {
    const nextBtn = document.getElementById('btn-wizard-next');
    const originalBtnText = nextBtn.innerText;
    nextBtn.disabled = true;
    nextBtn.innerText = "INITIALIZING PAYMENT...";

    const email = document.getElementById('input-email').value.trim();
    const phone = document.getElementById('input-phone').value.trim();
    const first = document.getElementById('ship-first').value.trim();
    const last = document.getElementById('ship-last').value.trim();
    const street = document.getElementById('ship-street').value.trim();
    const city = document.getElementById('ship-city').value.trim();
    const state = document.getElementById('ship-state').value.trim();
    const pin = document.getElementById('ship-pin').value.trim();
    const fullAddress = `${street}, ${city}, ${state} - ${pin}, India`;

    const cartItemsForOrder = globalCartStorageArray.map(item => ({
        name: item.name,
        size: item.size,
        quantity: item.quantity
    }));

    try {
        // Step 1: ask the backend to create a Razorpay order.
        // The backend recalculates the total itself from the product
        // catalog — it does NOT trust any price sent from this browser.
        const orderRes = await fetch(APPS_SCRIPT_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({
                action: "create_order",
                items: cartItemsForOrder,
                email: email,
                phone: phone
            })
        });
        const orderData = await orderRes.json();

        if (!orderData.success) {
            alert("[ORDER_ERROR] " + orderData.message);
            nextBtn.disabled = false;
            nextBtn.innerText = originalBtnText;
            return;
        }

        // Step 2: open Razorpay's hosted Checkout popup.
        const rzpOptions = {
            key: orderData.key_id,
            amount: orderData.amount,
            currency: orderData.currency,
            name: "BLLUG",
            description: "Order payment",
            order_id: orderData.order_id,
            prefill: {
                name: `${first} ${last}`,
                email: email,
                contact: phone
            },
            theme: { color: "#ffffff" },
            handler: async function (response) {
                // Step 3: verify the payment signature server-side
                // before treating the order as confirmed.
                nextBtn.innerText = "VERIFYING PAYMENT...";
                try {
                    const verifyRes = await fetch(APPS_SCRIPT_URL, {
                        method: "POST",
                        headers: { "Content-Type": "text/plain" },
                        body: JSON.stringify({
                            action: "verify_payment",
                            razorpay_order_id: response.razorpay_order_id,
                            razorpay_payment_id: response.razorpay_payment_id,
                            razorpay_signature: response.razorpay_signature,
                            customer: {
                                name: `${first} ${last}`,
                                email: email,
                                phone: phone,
                                address: fullAddress
                            },
                            items: cartItemsForOrder,
                            amount: orderData.amount / 100
                        })
                    });
                    const verifyData = await verifyRes.json();

                    if (verifyData.success) {
                        recordSuccessfulPurchase(cartItemsForOrder, verifyData);
                        syncConfirmedStockFromBackend();
                        showPaymentSuccessState();
                    } else if (verifyData.message && verifyData.message.indexOf('sold out') !== -1) {
                        syncConfirmedStockFromBackend();
                        alert("[SOLD_OUT] " + verifyData.message);
                        nextBtn.disabled = false;
                        nextBtn.innerText = originalBtnText;
                    } else {
                        alert("[VERIFICATION_FAILED] " + verifyData.message + "\nIf an amount was deducted, contact support with your payment ID: " + response.razorpay_payment_id);
                        nextBtn.disabled = false;
                        nextBtn.innerText = originalBtnText;
                    }
                } catch (err) {
                    alert("[NETWORK_ERROR] Payment may have succeeded but verification failed. Contact support with payment ID: " + response.razorpay_payment_id);
                    nextBtn.disabled = false;
                    nextBtn.innerText = originalBtnText;
                }
            },
            modal: {
                ondismiss: function () {
                    nextBtn.disabled = false;
                    nextBtn.innerText = originalBtnText;
                }
            }
        };

        const rzp = new Razorpay(rzpOptions);
        rzp.on('payment.failed', function (response) {
            alert("[PAYMENT_FAILED] " + (response.error && response.error.description ? response.error.description : "The payment could not be completed. Please try again."));
            nextBtn.disabled = false;
            nextBtn.innerText = originalBtnText;
        });
        rzp.open();
        nextBtn.disabled = false;
        nextBtn.innerText = originalBtnText;

    } catch (err) {
        alert("[NETWORK_ERROR] Could not reach payment gateway. Please try again.");
        nextBtn.disabled = false;
        nextBtn.innerText = originalBtnText;
    }
}

function showPaymentSuccessState() {
    const container = document.querySelector('#checkout-view > div');
    container.innerHTML = `
        <div class="flex-1 flex flex-col items-center justify-center text-center px-6">
            <span class="material-symbols-outlined text-primary text-[64px] mb-6">check_circle</span>
            <h2 class="font-headline-lg text-[28px] uppercase tracking-tight text-primary mb-3">ORDER CONFIRMED</h2>
            <p class="font-body-md text-on-surface-variant text-[14px] max-w-sm mb-8">Your payment was verified successfully. A confirmation has been recorded — we'll be in touch with shipping updates.</p>
            <a href="index.html" class="bg-primary text-background font-label-mono text-label-limit px-8 py-4 uppercase tracking-widest font-bold rounded inline-block">RETURN TO BLLUG</a>
        </div>`;
    globalCartStorageArray = [];
    // Clear the persisted cart too, so re-visiting the store doesn't resurrect
    // the items that were just purchased.
    try {
        localStorage.removeItem(CART_STORAGE_KEY);
    } catch (err) {
        // non-fatal
    }
}

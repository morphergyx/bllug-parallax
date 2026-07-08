        let globalCartStorageArray = [];
        let currentImageIndex = 0;
        let imagesArrayLength = 0;
        let activeSelectedSize = 'M';
        let sizePopupState = { name: '', price: 0, image: '', selectedSize: 'M', trigger: null };
        let sizePopupScrollHandler = null;
        let sizePopupResizeHandler = null;
        let sizePopupDocClickHandler = null;
        const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyeun-1Yt9v3fVuGRKO7PHRR3ohqSP-RT7QTcCF25VQSmUCcdaKGG4WezT6yu3gBPjhWg/exec";
        const PRODUCT_STOCK_LIMIT = 100; // pieces per series (not a shared pool)
        const STOCK_CACHE_STORAGE_KEY = 'bllug_remaining_stock_by_product';
        const CART_STORAGE_KEY = 'bllug_cart_items'; // shared with checkout.js — lets the cart survive the navigation to the checkout page
        const PROMO_STORAGE_KEY = 'bllug_applied_promo_code';
        const CART_PROMO_CODES = ['BLLUG10', 'MSRIT10'];
        const CART_PROMO_DISCOUNT_RATE = 0.10;
        let appliedCartPromoCode = readAppliedPromoCode();
        let currentModalProductName = null; // tracks which series is open in the details modal, for the stock badge
        const DROP_ONE_LAUNCH_TIME = new Date('2026-06-26T06:30:00Z').getTime();
        let pageScrollPosition = 0;

        function scrollToDropOne() {
            const targetId = Date.now() >= DROP_ONE_LAUNCH_TIME ? 'series' : 'vault';
            const target = document.getElementById(targetId);
            if (target) {
                target.scrollIntoView({ behavior: 'smooth' });
            }
        }

        function handleLaunchCta() {
            scrollToDropOne();
            if (Date.now() < DROP_ONE_LAUNCH_TIME) {
                setTimeout(() => {
                    const emailInput = document.getElementById('subscriber-email');
                    if (emailInput) emailInput.focus({ preventScroll: true });
                }, 750);
            }
        }

        function handleLaunchStripKeydown(event) {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleLaunchCta();
            }
        }

        function renderLaunchStatus() {
            const remainingMs = DROP_ONE_LAUNCH_TIME - Date.now();
            const isLive = remainingMs <= 0;
            const statusText = document.getElementById('launch-status-text');

            if (isLive) {
                if (statusText) statusText.innerText = 'Drop 1 is live - shop now';
                return;
            }

            if (statusText) statusText.innerText = 'Drop 1 unlocks Jun 26, 12 PM IST';
        }

        renderLaunchStatus();
        syncConfirmedStockFromBackend();

        // ---------------------------------------------------------------
        // Cart persistence — the cart now survives navigation to
        // checkout.html (and survives a page refresh too, as a bonus)
        // by being written to localStorage on every mutation and read
        // back in here on every page load.
        // ---------------------------------------------------------------
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
                // Non-fatal — cart still works in-memory for this session.
            }
        }

        function readAppliedPromoCode() {
            try {
                const code = String(localStorage.getItem(PROMO_STORAGE_KEY) || '').trim().toUpperCase();
                return CART_PROMO_CODES.includes(code) ? code : '';
            } catch (err) {
                return '';
            }
        }

        function writeAppliedPromoCode() {
            try {
                if (appliedCartPromoCode) localStorage.setItem(PROMO_STORAGE_KEY, appliedCartPromoCode);
                else localStorage.removeItem(PROMO_STORAGE_KEY);
            } catch (err) {
                // Non-fatal — the code still applies for this page view.
            }
        }

        globalCartStorageArray = readCartFromStorage();
        document.addEventListener('DOMContentLoaded', refreshCartRenderingEngine);

        // Navigation Scroll Behavior Control
        const nav = document.getElementById('main-nav');
        let ticking = false;

        window.addEventListener('scroll', () => {
            if (!ticking) {
                window.requestAnimationFrame(() => {
                    if (window.scrollY > 100) {
                        nav.classList.add('py-4', 'border-b', 'border-outline-variant/10');
                        nav.classList.remove('py-8');
                    } else {
                        nav.classList.remove('py-4', 'border-b', 'border-outline-variant/10');
                        nav.classList.add('py-8');
                    }
                    ticking = false;
                });
                ticking = true;
            }
        });

        // Smooth Anchor Links Processing
        document.querySelectorAll('a[href^="#"]').forEach(anchor => {
            anchor.addEventListener('click', function (e) {
                e.preventDefault();
                const target = document.querySelector(this.getAttribute('href'));
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth' });
                }
            });
        });

        // Configurator Details Panel View Modals triggers
        function openDetailsModal(title, price, imageCollection, descriptionText, washcareText) {
            const modal = document.getElementById('product-modal');
            const container = document.getElementById('modal-container');
            const track = document.getElementById('carousel-track');
            const dots = document.getElementById('carousel-dots');

            document.getElementById('modal-title').innerText = title;
            document.getElementById('modal-price').innerText = price;
            document.getElementById('modal-description').innerText = descriptionText || 'Discover premium fabric details, fit notes, and premium aesthetic cues for this series.';
            currentModalProductName = title;

            track.innerHTML = '';
            dots.innerHTML = '';
            imagesArrayLength = imageCollection.length;
            currentImageIndex = 0;

            activeSelectedSize = 'M';
            document.querySelectorAll('.size-btn').forEach(btn => {
                if(btn.getAttribute('data-size') === 'M') {
                    btn.className = "size-btn py-3 border border-primary rounded bg-primary text-background font-label-mono text-label-mono hover:border-primary transition-all uppercase";
                } else {
                    btn.className = "size-btn py-3 border border-outline-variant/40 rounded bg-transparent font-label-mono text-label-mono text-primary hover:border-primary transition-all uppercase";
                }
            });

            updateModalStockAvailability();
            syncConfirmedStockFromBackend();

            const defaultTabButton = document.querySelector('button[onclick*="details-content"]');
            if (defaultTabButton) {
                switchTab('details-content', defaultTabButton);
            }

            imageCollection.forEach((imgUrl, idx) => {
                const imgDiv = document.createElement('div');
                imgDiv.className = 'w-full h-full flex-shrink-0 snap-start relative';
                // Derive the WebP path from the JPG path (e.g. "images/foo.jpg" ->
                // "images/foo.webp") so callers don't need to pass two paths —
                // every JPG in /images has a matching pre-generated .webp sibling.
                const webpUrl = imgUrl.replace(/\.jpe?g$/i, '.webp');
                const imageLoading = idx === 0 ? 'eager' : 'lazy';
                const imagePriority = idx === 0 ? 'high' : 'auto';
                const intrinsicSize = /series-section/i.test(imgUrl)
                    ? { width: 1920, height: 1080 }
                    : { width: 1200, height: 1050 };
                imgDiv.innerHTML = `<picture><source srcset="${webpUrl}" type="image/webp"><img src="${imgUrl}" alt="${title} view" class="w-full h-full object-cover" width="${intrinsicSize.width}" height="${intrinsicSize.height}" loading="${imageLoading}" fetchpriority="${imagePriority}" decoding="async"></picture>`;
                track.appendChild(imgDiv);

                const dot = document.createElement('button');
                dot.className = `w-2 h-2 rounded-full transition-all duration-300 ${idx === 0 ? 'bg-primary scale-125' : 'bg-primary/30'}`;
                dot.onclick = () => jumpToSlide(idx);
                dots.appendChild(dot);
            });

            track.addEventListener('scroll', updateDotsOnManualScroll);

            modal.classList.remove('invisible');
            modal.classList.add('opacity-100');
            container.classList.remove('scale-95');
            container.classList.add('scale-100');
            pageScrollPosition = window.scrollY;
            document.body.style.position = 'fixed';
            document.body.style.top = `-${pageScrollPosition}px`;
            document.body.style.width = '100%';
            document.body.style.overflow = 'hidden';
        }

        function closeDetailsModal() {
            const modal = document.getElementById('product-modal');
            const container = document.getElementById('modal-container');
            modal.classList.remove('opacity-100');
            modal.classList.add('opacity-0');
            container.classList.remove('scale-100');
            container.classList.add('scale-95');
            setTimeout(() => {
                modal.classList.add('invisible');
                document.body.style.position = '';
                document.body.style.top = '';
                document.body.style.width = '';
                document.body.style.overflow = 'auto';
                window.scrollTo(0, pageScrollPosition);
            }, 500);
        }

        function isStandaloneProductDetailsPage() {
            return Boolean(
                document.getElementById('page-backdrop') &&
                document.getElementById('overlay-topbar') &&
                document.getElementById('product-modal') &&
                /-details\.html$/i.test(window.location.pathname)
            );
        }

        function restoreStandaloneProductDetailsView() {
            if (!isStandaloneProductDetailsPage()) return;
            const modal = document.getElementById('product-modal');
            const container = document.getElementById('modal-container');
            if (modal) {
                modal.classList.remove('invisible', 'opacity-0');
                modal.classList.add('opacity-100');
            }
            if (container) {
                container.classList.remove('scale-95');
                container.classList.add('scale-100');
            }
            document.body.style.position = '';
            document.body.style.top = '';
            document.body.style.width = '';
            document.body.style.overflow = '';
        }

        function slideCarousel(direction) {
            const track = document.getElementById('carousel-track');
            currentImageIndex = (currentImageIndex + direction + imagesArrayLength) % imagesArrayLength;
            track.scrollTo({ left: track.clientWidth * currentImageIndex, behavior: 'smooth' });
        }

        function jumpToSlide(index) {
            const track = document.getElementById('carousel-track');
            currentImageIndex = index;
            track.scrollTo({ left: track.clientWidth * index, behavior: 'smooth' });
        }

        function updateDotsOnManualScroll() {
            const track = document.getElementById('carousel-track');
            const dots = document.getElementById('carousel-dots').children;
            const newIdx = Math.round(track.scrollLeft / track.clientWidth);
            
            if (newIdx !== currentImageIndex && newIdx >= 0 && newIdx < imagesArrayLength) {
                currentImageIndex = newIdx;
                Array.from(dots).forEach((dot, idx) => {
                    if (idx === currentImageIndex) {
                        dot.classList.add('bg-primary', 'scale-125');
                        dot.classList.remove('bg-primary/30');
                    } else {
                        dot.classList.remove('bg-primary', 'scale-125');
                        dot.classList.add('bg-primary/30');
                    }
                });
            }
        }

        function selectSize(selectedBtn) {
            document.querySelectorAll('.size-btn').forEach(btn => {
                btn.classList.remove('bg-primary', 'text-background', 'border-primary');
                btn.classList.add('bg-transparent', 'text-primary', 'border-outline-variant/40');
            });
            selectedBtn.classList.add('bg-primary', 'text-background', 'border-primary');
            selectedBtn.classList.remove('bg-transparent', 'text-primary', 'border-outline-variant/40');
            activeSelectedSize = selectedBtn.getAttribute('data-size');
        }

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

        // Returns remaining pieces for a specific series, accounting for what's
        // already sitting in this visitor's own cart (so they can't add more
        // than what's actually left once their cart is checked out).
        // Defaults to PRODUCT_STOCK_LIMIT if we have no server data yet (e.g. first
        // load before syncConfirmedStockFromBackend resolves) so the UI doesn't
        // falsely show 0 left before the first successful sync.
        function getAvailablePieces(productName) {
            const key = normalizeProductKey(productName);
            const cache = readRemainingStockCache();
            const knownRemaining = Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : PRODUCT_STOCK_LIMIT;
            return Math.max(0, knownRemaining - getCartReservedPiecesForProduct(productName));
        }

        function getPurchasedQuantityFromItems(items) {
            if (!Array.isArray(items)) return 0;
            return items.reduce((sum, item) => sum + Math.max(0, Number(item.quantity) || 0), 0);
        }

        // Called right after a verified payment. The backend's verify_payment
        // response now includes remainingStockByProduct with fresh authoritative
        // numbers for every product — we just merge those straight into the cache.
        function recordSuccessfulPurchase(purchasedItems, verifyResponsePayload) {
            if (verifyResponsePayload && verifyResponsePayload.remainingStockByProduct) {
                mergeRemainingStockCache(verifyResponsePayload.remainingStockByProduct);
            }
            updateModalStockAvailability();
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
                    updateModalStockAvailability();
                }
            } catch (err) {
                // Stock sync is best-effort; UI falls back to last-known cached values.
            }
        }

        function updateModalStockAvailability() {
            const stockNote = document.getElementById('modal-stock-note');
            const addBagBtn = document.getElementById('modal-btn-add-bag');
            const buyNowBtn = document.getElementById('modal-btn-buy-now');
            if (!currentModalProductName) return; // no product context yet (e.g. on initial page load before any modal opened)

            const piecesRemaining = getAvailablePieces(currentModalProductName);
            const isSoldOut = piecesRemaining <= 0;

            if (stockNote) {
                if (isSoldOut) {
                    stockNote.innerHTML = `
                        <strong class="block text-[13px] text-primary">SOLD OUT</strong>
                        <span class="block mt-1 text-[10px] text-on-surface-variant">This series is fully reserved. No restocks.</span>`;
                } else {
                    stockNote.innerHTML = `
                        <strong class="block text-[13px] text-primary">AVAILABLE</strong>
                        <span class="block mt-1 text-[10px] text-on-surface-variant">Limited drop. No restocks.</span>`;
                }
            }

            [addBagBtn, buyNowBtn].forEach(btn => {
                if (!btn) return;
                btn.disabled = isSoldOut;
                btn.classList.toggle('opacity-40', isSoldOut);
                btn.classList.toggle('cursor-not-allowed', isSoldOut);
                btn.classList.toggle('pointer-events-none', isSoldOut);
            });

            document.querySelectorAll('.size-btn').forEach(btn => {
                btn.disabled = isSoldOut;
                btn.classList.toggle('opacity-40', isSoldOut);
                btn.classList.toggle('cursor-not-allowed', isSoldOut);
            });
        }

        function switchTab(panelId, activeTabElement) {
            document.querySelectorAll('.tab-panel').forEach(panel => {
                panel.classList.remove('block');
                panel.classList.add('hidden');
            });
            document.querySelectorAll('.tab-link').forEach(link => {
                link.classList.remove('border-primary', 'text-primary', 'font-bold');
                link.classList.add('border-transparent', 'text-on-surface-variant');
            });
            document.getElementById(panelId).classList.remove('hidden');
            document.getElementById(panelId).classList.add('block');
            activeTabElement.classList.add('border-primary', 'text-primary', 'font-bold');
            activeTabElement.classList.remove('border-transparent', 'text-on-surface-variant');
        }

        // Cart side panel processing rules mutations
        function toggleCartDrawer(openStatus) {
            const backdrop = document.getElementById('cart-drawer-backdrop');
            const drawer = document.getElementById('cart-drawer');
            if (openStatus) {
                backdrop.classList.remove('invisible');
                backdrop.classList.add('opacity-100');
                drawer.classList.remove('translate-x-full');
            } else {
                backdrop.classList.remove('opacity-100');
                backdrop.classList.add('invisible');
                drawer.classList.add('translate-x-full');
                restoreStandaloneProductDetailsView();
            }
        }

        function addSelectedToCart(keepOpenDrawer) {
            const name = document.getElementById('modal-title').innerText;
            const price = parseInt(document.getElementById('modal-price').innerText.replace(/,/g, ''));
            const track = document.getElementById('carousel-track');
            const firstImgElement = track.querySelector('img');
            const imgSrc = firstImgElement ? firstImgElement.src : '/images/series-section-1.jpg';

            addImmediateToCart(name, price, activeSelectedSize, imgSrc);
            if (isStandaloneProductDetailsPage()) {
                restoreStandaloneProductDetailsView();
            } else {
                closeDetailsModal();
            }
            if (keepOpenDrawer) {
                setTimeout(() => toggleCartDrawer(true), 400);
            }
        }

        function buySeriesProductNow(name, price, imageSrc) {
            addImmediateToCart(name, price, 'M', imageSrc);
            toggleCartDrawer(true);
        }

        function openSizeChooserPopup(event, name, price, imageSrc) {
            if (getAvailablePieces(name) <= 0) {
                event.stopPropagation();
                alert("[SOLD_OUT] " + name + " is fully reserved. No restocks.");
                return;
            }

            const popup = document.getElementById('size-popup');
            const buttonsContainer = document.getElementById('size-popup-buttons');
            const trigger = event.currentTarget || event.target;

            sizePopupState = {
                name: name,
                price: price,
                image: imageSrc,
                selectedSize: 'M',
                trigger: trigger
            };

            buttonsContainer.innerHTML = '';
            ['S', 'M', 'L', 'XL', 'XXL'].forEach(size => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.innerText = size;
                btn.className = `py-3 rounded text-[12px] font-label-mono transition-all ${size === 'M' ? 'bg-primary text-background border border-primary' : 'bg-transparent text-primary border border-outline-variant/40 hover:border-primary hover:text-primary'}`;
                btn.onclick = () => selectSizeInPopup(btn, size);
                buttonsContainer.appendChild(btn);
            });

            const popupRectWidth = 288;
            const triggerRect = trigger.getBoundingClientRect();
            const leftPosition = Math.min(window.innerWidth - popupRectWidth - 12, Math.max(12, triggerRect.left + (triggerRect.width / 2) - (popupRectWidth / 2)));
            const topPosition = Math.max(12, triggerRect.top - 170);

            popup.style.left = `${leftPosition}px`;
            popup.style.top = `${topPosition}px`;
            popup.classList.remove('hidden');
            // position and attach listeners so popup follows the trigger on scroll/resize
            positionSizePopup();
            addListenersForSizePopup();
            event.stopPropagation();
        }

        function positionSizePopup() {
            const popup = document.getElementById('size-popup');
            const popupCard = document.getElementById('size-popup-card');
            const trigger = sizePopupState.trigger;
            if (!popup || !popupCard || !trigger) return;
            const popupRectWidth = popupCard.offsetWidth || 288;
            const popupRectHeight = popupCard.offsetHeight || 140;
            const triggerRect = trigger.getBoundingClientRect();
            const leftPosition = Math.min(window.innerWidth - popupRectWidth - 12, Math.max(12, triggerRect.left + (triggerRect.width / 2) - (popupRectWidth / 2)));
            // place above the trigger; if not enough space, place below
            let topPosition = triggerRect.top - popupRectHeight - 10;
            if (topPosition < 8) {
                topPosition = triggerRect.bottom + 10;
            }
            popup.style.left = `${leftPosition}px`;
            popup.style.top = `${topPosition}px`;
        }

        function addListenersForSizePopup() {
            if (sizePopupScrollHandler) return; // already added
            sizePopupScrollHandler = () => requestAnimationFrame(positionSizePopup);
            sizePopupResizeHandler = () => requestAnimationFrame(positionSizePopup);
            sizePopupDocClickHandler = (e) => {
                const popup = document.getElementById('size-popup');
                if (!popup) return;
                const trigger = sizePopupState.trigger;
                if (popup.contains(e.target)) return;
                if (trigger && (trigger === e.target || trigger.contains(e.target))) return;
                closeSizePopup();
            };

            window.addEventListener('scroll', sizePopupScrollHandler, true);
            window.addEventListener('resize', sizePopupResizeHandler);
            document.addEventListener('click', sizePopupDocClickHandler);
        }

        function removeListenersForSizePopup() {
            if (!sizePopupScrollHandler) return;
            window.removeEventListener('scroll', sizePopupScrollHandler, true);
            window.removeEventListener('resize', sizePopupResizeHandler);
            document.removeEventListener('click', sizePopupDocClickHandler);
            sizePopupScrollHandler = null;
            sizePopupResizeHandler = null;
            sizePopupDocClickHandler = null;
        }

        function selectSizeInPopup(button, size) {
            sizePopupState.selectedSize = size;
            document.querySelectorAll('#size-popup-buttons button').forEach(btn => {
                btn.classList.remove('bg-primary', 'text-background', 'border-primary');
                btn.classList.add('bg-transparent', 'text-primary', 'border-outline-variant/40');
            });
            button.classList.remove('bg-transparent', 'text-primary', 'border-outline-variant/40');
            button.classList.add('bg-primary', 'text-background', 'border-primary');
        }

        function closeSizePopup() {
            const popup = document.getElementById('size-popup');
            if (popup) popup.classList.add('hidden');
            sizePopupState.trigger = null;
            removeListenersForSizePopup();
        }

        function openSizeChart() {
            const overlay = document.getElementById('size-chart-overlay');
            if (overlay) {
                overlay.classList.remove('hidden');
            }
        }

        function closeSizeChart() {
            const overlay = document.getElementById('size-chart-overlay');
            if (overlay) {
                overlay.classList.add('hidden');
            }
        }

        // The subscriber form used to point at a separate, standalone Apps
        // Script deployment with its own URL. That logic has been merged into
        // the main backend (action: 'subscribe'), so this now uses the same
        // APPS_SCRIPT_URL and JSON request format as every other call on
        // this site, instead of a separate URL-encoded endpoint.
        async function handleSubscriberSubmit(event) {
            event.preventDefault();

            const emailInput = document.getElementById('subscriber-email');
            if (!emailInput) return;

            const email = emailInput.value.trim();
            if (!email || !email.includes('@')) {
                alert('Please enter a valid email address.');
                return;
            }

            const button = document.getElementById('subscriber-button');
            const feedback = document.getElementById('subscriber-feedback');

            const showStatus = (message, success = true) => {
                if (feedback) {
                    feedback.innerText = message;
                    feedback.classList.remove('text-red-400', 'text-on-surface-variant');
                    feedback.classList.add(success ? 'text-primary' : 'text-red-400');
                    feedback.classList.add('opacity-100');
                }
            };

            const resetButton = () => {
                if (button) {
                    button.disabled = false;
                    button.classList.remove('opacity-60', 'cursor-not-allowed', 'scale-105');
                    button.innerText = 'SUBSCRIBE';
                }
            };

            if (button) {
                button.disabled = true;
                button.innerText = 'SENDING...';
                button.classList.add('opacity-60', 'cursor-not-allowed');
            }

            try {
                const res = await fetch(APPS_SCRIPT_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain' },
                    body: JSON.stringify({ action: 'subscribe', email: email })
                });
                const data = await res.json();

                if (data.status === 'success' || data.status === 'exists') {
                    if (button) {
                        button.classList.add('scale-105', 'animate-pulse', 'shadow-[0_0_0_12px_rgba(255,255,255,0.18)]');
                        button.innerText = 'SUBSCRIBED';
                        setTimeout(() => {
                            if (button) {
                                button.classList.remove('animate-pulse', 'shadow-[0_0_0_12px_rgba(255,255,255,0.18)]');
                            }
                        }, 700);
                    }
                    showStatus(data.message || 'Email submitted successfully.', true);
                } else {
                    showStatus(data.message || 'Submission failed. Please try again.', false);
                }
            } catch (err) {
                showStatus('Submission failed. Please try again.', false);
            } finally {
                emailInput.value = '';
                setTimeout(() => {
                    if (button) resetButton();
                    if (feedback) {
                        feedback.classList.remove('opacity-100');
                        feedback.classList.add('opacity-0');
                    }
                }, 3500);
            }
        }


        function confirmPopupSize() {
            addImmediateToCart(sizePopupState.name, sizePopupState.price, sizePopupState.selectedSize, sizePopupState.image);
            closeSizePopup();
            toggleCartDrawer(true);
        }

        function getCartItemKey(name, size) {
            const normalizedName = String(name).trim().replace(/\s+/g, ' ').toUpperCase();
            const normalizedSize = String(size).trim().toUpperCase();
            return `${normalizedName}__${normalizedSize}`;
        }

        function addImmediateToCart(name, price, size, imageSrc) {
            if (getAvailablePieces(name) <= 0) {
                alert("[SOLD_OUT] This series is fully reserved. No restocks.");
                return;
            }

            const cleanName = String(name).trim().replace(/\s+/g, ' ');
            const cleanSize = String(size).trim().toUpperCase();
            const cartKey = getCartItemKey(cleanName, cleanSize);
            const existingMatch = globalCartStorageArray.find(item => {
                const itemKey = item.cartKey || getCartItemKey(item.name, item.size);
                return itemKey === cartKey;
            });

            if (existingMatch) {
                existingMatch.quantity += 1;
                existingMatch.cartKey = cartKey;
                existingMatch.name = cleanName;
                existingMatch.size = cleanSize;
            } else {
                globalCartStorageArray.push({
                    id: 'artfct_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                    cartKey: cartKey,
                    name: cleanName,
                    price: price,
                    size: cleanSize,
                    image: imageSrc,
                    quantity: 1
                });
            }
            refreshCartRenderingEngine();
        }

        function consolidateDuplicateCartItems() {
            const cartItemsByKey = new Map();
            globalCartStorageArray.forEach(item => {
                const cleanName = String(item.name).trim().replace(/\s+/g, ' ');
                const cleanSize = String(item.size).trim().toUpperCase();
                const cartKey = item.cartKey || getCartItemKey(cleanName, cleanSize);
                const existingItem = cartItemsByKey.get(cartKey);

                if (existingItem) {
                    existingItem.quantity += item.quantity;
                } else {
                    cartItemsByKey.set(cartKey, {
                        ...item,
                        cartKey: cartKey,
                        name: cleanName,
                        size: cleanSize
                    });
                }
            });
            globalCartStorageArray = Array.from(cartItemsByKey.values());
        }

        function updateItemQuantity(itemId, quantityDelta) {
            const itemTarget = globalCartStorageArray.find(item => item.id === itemId);
            if (!itemTarget) return;

            if (quantityDelta > 0 && getAvailablePieces(itemTarget.name) < quantityDelta) {
                alert("[LIMIT_REACHED] No more pieces of this series are available in this drop.");
                return;
            }

            itemTarget.quantity += quantityDelta;
            if (itemTarget.quantity <= 0) {
                globalCartStorageArray = globalCartStorageArray.filter(item => item.id !== itemId);
            }
            refreshCartRenderingEngine();
        }

        function refreshCartRenderingEngine() {
            ensureCartCouponUi();
            consolidateDuplicateCartItems();
            writeCartToStorage();

            const container = document.getElementById('cart-items-container');
            const totalNavCountBadge = document.getElementById('cart-nav-badge');
            const totalDrawerCountBadge = document.getElementById('cart-count-badge');
            
            let cumulativeItemsCount = 0;
            let subtotalPriceCounter = 0;

            if (globalCartStorageArray.length === 0) {
                container.innerHTML = `
                    <div class="h-full flex flex-col items-center justify-center text-center opacity-30 py-20">
                        <span class="material-symbols-outlined text-[44px] mb-3">gpp_bad</span>
                        <p class="font-label-mono text-[12px] tracking-widest uppercase">VAULT_IS_EMPTY</p>
                    </div>`;
                totalNavCountBadge.classList.add('hidden');
                totalDrawerCountBadge.innerText = "0 ITEMS";
            } else {
                container.innerHTML = '';
                globalCartStorageArray.forEach(item => {
                    cumulativeItemsCount += item.quantity;
                    subtotalPriceCounter += (item.price * item.quantity);

                    const cartItemRow = document.createElement('div');
                    cartItemRow.className = "flex gap-4 p-4 border border-outline-variant/10 rounded bg-[#0F0F0F] relative group";
                    cartItemRow.innerHTML = `
                        <div class="w-20 h-24 bg-black/40 rounded overflow-hidden flex-shrink-0 border border-outline-variant/10">
                            <img src="${item.image}" class="w-full h-full object-cover" alt="${item.name}" loading="lazy" decoding="async">
                        </div>
                        <div class="flex-grow flex flex-col justify-between py-0.5">
                            <div>
                                <h4 class="font-headline-lg text-[14px] leading-tight text-primary uppercase tracking-tight mb-1 pr-6">${item.name}</h4>
                                <p class="font-label-mono text-[11px] text-on-surface-variant uppercase">SIZE: <span class="text-primary font-bold">${item.size}</span></p>
                            </div>
                            <div class="flex justify-between items-center mt-2">
                                <div class="flex items-center border border-outline-variant/30 rounded bg-background/50 overflow-hidden">
                                    <button onclick="updateItemQuantity('${item.id}', -1)" class="px-2.5 py-1 text-on-surface-variant hover:text-primary hover:bg-white/5 transition-colors font-bold text-[14px] leading-none">-</button>
                                    <span class="px-2 font-label-mono text-[12px] text-primary select-none min-w-[16px] text-center">${item.quantity}</span>
                                    <button onclick="updateItemQuantity('${item.id}', 1)" class="px-2.5 py-1 text-on-surface-variant hover:text-primary hover:bg-white/5 transition-colors font-bold text-[14px] leading-none">+</button>
                                </div>
                                <span class="font-label-mono text-[13px] text-primary font-medium">RS. ${(item.price * item.quantity).toLocaleString()}</span>
                            </div>
                        </div>
                        <button onclick="updateItemQuantity('${item.id}', -${item.quantity})" class="absolute top-4 right-4 text-outline hover:text-error transition-colors p-0.5 flex items-center justify-center">
                            <span class="material-symbols-outlined text-[16px]">delete</span>
                        </button>`;
                    container.appendChild(cartItemRow);
                });

                totalNavCountBadge.innerText = cumulativeItemsCount;
                totalNavCountBadge.classList.remove('hidden');
                totalDrawerCountBadge.innerText = `${cumulativeItemsCount} ${cumulativeItemsCount === 1 ? 'ITEM' : 'ITEMS'}`;
            }

            const shippingCalculatedFee = 0;
            const discountAmount = appliedCartPromoCode ? subtotalPriceCounter * CART_PROMO_DISCOUNT_RATE : 0;
            const netAggregateTotal = subtotalPriceCounter + shippingCalculatedFee - discountAmount;

            document.getElementById('cart-subtotal').innerText = subtotalPriceCounter.toLocaleString();
            document.getElementById('cart-shipping').innerText = 'FREE';
            document.getElementById('cart-discount').innerText = formatCartMoney(discountAmount);
            document.getElementById('cart-discount-row').classList.toggle('hidden', !appliedCartPromoCode);
            document.getElementById('cart-total').innerText = formatCartMoney(netAggregateTotal);
            syncCartCouponUi();
            updateModalStockAvailability();
        }

        function formatCartMoney(value) {
            return Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }

        function ensureCartCouponUi() {
            if (document.getElementById('cart-coupon-section')) return;
            const checkoutButton = document.querySelector('#cart-drawer button[onclick="launchCheckoutFlow()"]');
            const totalNode = document.getElementById('cart-total');
            if (!checkoutButton || !totalNode) return;

            const couponSection = document.createElement('div');
            couponSection.id = 'cart-coupon-section';
            couponSection.innerHTML = `
                <div id="cart-coupon-applied" class="hidden rounded border border-primary/20 bg-primary/[0.04] px-3 py-2.5">
                    <div class="flex items-center justify-between gap-3">
                        <div class="min-w-0">
                            <p class="font-label-mono text-[9px] uppercase tracking-[0.22em] text-on-surface-variant">Coupon applied</p>
                            <p class="font-label-mono text-[11px] uppercase tracking-widest text-primary"><span id="cart-applied-code">BLLUG10</span> · 10% off</p>
                        </div>
                        <button type="button" onclick="removeCartCouponCode()" class="flex-shrink-0 font-label-mono text-[9px] uppercase tracking-wider text-on-surface-variant hover:text-primary underline underline-offset-4">Remove</button>
                    </div>
                </div>
                <button id="cart-coupon-toggle" type="button" onclick="toggleCartCouponEntry()" class="w-full flex items-center justify-between gap-3 rounded border border-outline-variant/20 px-3 py-2.5 text-left font-label-mono text-[10px] text-on-surface-variant hover:border-primary/60 hover:text-primary uppercase tracking-wider transition-colors">
                    <span>Have a coupon code?</span>
                    <span class="material-symbols-outlined text-[15px]" aria-hidden="true">add</span>
                </button>
                <div id="cart-coupon-holder" class="hidden rounded border border-outline-variant/20 bg-[#0A0A0A] p-3">
                    <label for="cart-coupon-input" class="block mb-2 font-label-mono text-[9px] uppercase tracking-[0.22em] text-on-surface-variant">Enter code for instant discount</label>
                    <div class="flex gap-2">
                        <input id="cart-coupon-input" type="text" autocomplete="off" inputmode="text" placeholder="ENTER PROMO CODE" class="min-w-0 flex-1 bg-[#050505] border border-outline-variant/30 rounded px-3 py-3 text-primary font-label-mono text-[11px] uppercase outline-none focus:border-primary" oninput="this.value = this.value.toUpperCase()" onkeydown="if(event.key === 'Enter'){ event.preventDefault(); applyCartCouponCode(); }">
                        <button type="button" onclick="applyCartCouponCode()" class="border border-primary bg-primary text-background px-4 font-label-mono text-[11px] font-bold uppercase hover:bg-on-surface-variant transition-colors">APPLY</button>
                    </div>
                    <p class="mt-2 font-label-mono text-[9px] uppercase tracking-wider text-on-surface-variant">Enter your promo code to unlock a discount.</p>
                    <p id="cart-coupon-message" class="hidden mt-2 font-label-mono text-[10px] uppercase tracking-wider" aria-live="polite"></p>
                </div>`;
            checkoutButton.parentNode.insertBefore(couponSection, checkoutButton);

            const totalRow = totalNode.closest('div');
            const discountRow = document.createElement('div');
            discountRow.id = 'cart-discount-row';
            discountRow.className = 'hidden flex justify-between text-on-surface-variant';
            discountRow.innerHTML = '<span>DISCOUNT (10%)</span><span>-RS. <span id="cart-discount">0.00</span></span>';
            totalRow.parentNode.insertBefore(discountRow, totalRow);
        }

        function toggleCartCouponEntry() {
            const holder = document.getElementById('cart-coupon-holder');
            if (!holder) return;
            holder.classList.toggle('hidden');
            const toggleIcon = document.querySelector('#cart-coupon-toggle .material-symbols-outlined');
            if (toggleIcon) toggleIcon.textContent = holder.classList.contains('hidden') ? 'add' : 'remove';
            if (!holder.classList.contains('hidden')) document.getElementById('cart-coupon-input').focus();
        }

        function applyCartCouponCode() {
            const input = document.getElementById('cart-coupon-input');
            const message = document.getElementById('cart-coupon-message');
            const code = String(input.value || '').trim().toUpperCase();
            input.value = code;
            message.classList.remove('hidden', 'text-primary', 'text-error');

            if (CART_PROMO_CODES.includes(code)) {
                appliedCartPromoCode = code;
                message.textContent = 'Success — 10% discount added to your vault.';
                message.classList.add('text-primary');
            } else {
                appliedCartPromoCode = '';
                message.textContent = code ? 'That code is not valid. Check spelling and try again.' : 'Enter a coupon code to apply discount.';
                message.classList.add('text-error');
            }
            writeAppliedPromoCode();
            refreshCartRenderingEngine();
        }

        function removeCartCouponCode() {
            appliedCartPromoCode = '';
            writeAppliedPromoCode();
            const input = document.getElementById('cart-coupon-input');
            const message = document.getElementById('cart-coupon-message');
            const holder = document.getElementById('cart-coupon-holder');
            if (input) input.value = '';
            if (message) {
                message.textContent = 'Coupon removed. Total restored.';
                message.classList.remove('hidden', 'text-error');
                message.classList.add('text-primary');
            }
            if (holder) holder.classList.remove('hidden');
            refreshCartRenderingEngine();
        }

        function syncCartCouponUi() {
            const input = document.getElementById('cart-coupon-input');
            const holder = document.getElementById('cart-coupon-holder');
            const message = document.getElementById('cart-coupon-message');
            const appliedPanel = document.getElementById('cart-coupon-applied');
            const appliedCode = document.getElementById('cart-applied-code');
            const toggleButton = document.getElementById('cart-coupon-toggle');
            const toggleIcon = document.querySelector('#cart-coupon-toggle .material-symbols-outlined');
            if (!input || !holder || !message) return;
            if (!appliedCartPromoCode) {
                if (appliedPanel) appliedPanel.classList.add('hidden');
                if (toggleButton) toggleButton.classList.remove('hidden');
                if (toggleIcon) toggleIcon.textContent = holder.classList.contains('hidden') ? 'add' : 'remove';
                return;
            }
            input.value = appliedCartPromoCode;
            holder.classList.add('hidden');
            if (appliedPanel) appliedPanel.classList.remove('hidden');
            if (appliedCode) appliedCode.textContent = appliedCartPromoCode;
            if (toggleButton) toggleButton.classList.add('hidden');
            message.textContent = 'Success — 10% discount added to your vault.';
            message.classList.remove('hidden', 'text-error');
            message.classList.add('text-primary');
        }

        // Checkout lives on its own page (checkout.html). Navigate immediately —
        // checkout.html re-validates stock itself the moment it loads (see
        // initCheckoutPage in checkout.js), so there's no need to make the
        // person wait on a network round-trip here before the button even responds.
        function launchCheckoutFlow() {
            if (globalCartStorageArray.length === 0) {
                alert("Vault payload validation missing. Add artifacts to check out.");
                return;
            }

            writeCartToStorage();
            window.location.href = 'checkout.html';
        }


        function shareWebsite(event) {
            event.preventDefault();
            const shareUrl = 'https://www.bllug.co.in';
            const shareData = {
                title: 'BLLUG',
                text: 'Check out BLLUG — premium limited-run streetwear.',
                url: shareUrl
            };

            if (navigator.share) {
                navigator.share(shareData).catch(() => {
                    copyShareLink(shareUrl);
                });
                return;
            }

            const encodedUrl = encodeURIComponent(shareUrl);
            const encodedText = encodeURIComponent('Check out BLLUG — premium limited-run streetwear.');
            const fallbackLinks = [
                `https://twitter.com/intent/tweet?text=${encodedText}%20${encodedUrl}`,
                `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
                `https://wa.me/?text=${encodedText}%20${encodedUrl}`
            ];

            const fallbackWindow = window.open(fallbackLinks[0], '_blank', 'noopener,noreferrer');
            if (!fallbackWindow) {
                copyShareLink(shareUrl);
            }
        }

        function copyShareLink(url) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(() => {
                    alert('Link copied to clipboard: ' + url);
                }).catch(() => {
                    window.prompt('Copy this link:', url);
                });
                return;
            }
            window.prompt('Copy this link:', url);
        }

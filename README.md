# BLLUG checkout split — what changed & how to test it

## Summary
Checkout used to be a hidden `<div id="checkout-view">` baked into every page
(`index.html`, `owl/tiger/humming-details.html`), revealed by JS when you
clicked "SECURE_CHECKOUT" or "BUY NOW". That meant every storefront page was
shipping the entire 4-step wizard's HTML, OTP UI, and the Razorpay SDK —
weight every visitor paid for, even the ones who never buy anything.

Checkout now lives on its own page: **`checkout.html`**, with its own
**`checkout.css`** and **`checkout.js`**. Storefront pages no longer load
Razorpay at all, and no longer contain any checkout markup.

## How the cart survives the page change
This is the one structural change that made the split possible.
`globalCartStorageArray` used to be a JS variable that only existed in
memory — fine for an in-page overlay, but it would've reset to empty the
moment the browser navigated to a new page.

Fix: the cart is now also written to **`localStorage`** (key:
`bllug_cart_items`) every time it changes — adding an item, changing
quantity, removing something. `checkout.html` reads that key on load to
rebuild the cart, and the storefront pages read it back too (so refreshing
the homepage no longer wipes your cart either — that was a side benefit).

This is invisible to the Apps Script backend — it's purely a browser-side
mechanism. **Nothing about what's sent to or received from Apps Script
changed.** Every `action` string, request body shape, and response field
checkout.js reads is byte-for-byte identical to what script.js sent before.

## File map

| File | Role | Loaded by |
|---|---|---|
| `index.html`, `owl/tiger/humming-details.html` | Storefront pages — checkout markup removed, Razorpay removed | Visitors browsing |
| `script.js` | Storefront logic — cart, stock sync, size popup, modals. Wizard/OTP/payment code removed (moved to checkout.js) | Storefront pages |
| `checkout.html` | Standalone checkout page (4-step wizard) | Reached via "SECURE_CHECKOUT" / "BUY NOW" |
| `checkout.js` | Wizard steps, OTP verify, shipping validation, Razorpay order create/verify | checkout.html only |
| `checkout.css` | Checkout-only styles (`.checkout-input`, mobile button sizing) extracted from style.css | checkout.html only |
| `style.css` | **Untouched** — same file as before | Storefront pages |
| `tailwind-built.css` | Precompiled Tailwind utilities (see prior fix) — rebuilt to include checkout.html's classes | All 5 pages |
| `policy.html`, `contact.html`, `privacy.html`, `terms.html` | **Untouched** — never used Razorpay/Tailwind CDN | n/a |

`tailwind.config.js` / `package.json` / `tailwind-input.css` — dev-machine-only
build files, same as before. Never upload these to your server.

## Behavior changes (what will look/feel different to a visitor)

1. **Clicking "SECURE_CHECKOUT" or "BUY NOW" now navigates to a new page**
   (`checkout.html`) instead of sliding a panel over the current page. You
   asked for whichever is faster — this is faster for the 90%+ of visitors
   who never reach checkout, since their pages no longer carry that weight.
2. **The size-popup "BUY NOW" still jumps straight to checkout.html**, per
   your instruction — no change needed there, it already called
   `launchCheckoutFlow()` which now navigates instead of revealing the overlay.
3. **The old `[ABORT_ORDER]` button is now a "BACK TO STORE" link** in a
   slim top bar on checkout.html — there's no overlay to "abort" anymore,
   just a page to leave.
4. **New: an empty-cart fallback state** on checkout.html, shown if someone
   reaches it directly with nothing in their cart (e.g. browser back-button
   after a completed order, or a stale bookmark). This case didn't really
   exist before since the overlay was unreachable without items in cart.
5. **After a successful payment**, "RETURN TO BLLUG" now links to
   `index.html` instead of reloading the same page (reloading checkout.html
   with an empty cart would just show the new empty-cart state, which is a
   worse experience than going home).

## What did NOT change
- Every Apps Script `action` (`send`, `verify`, `create_order`,
  `verify_payment`, `get_stock`) — same request bodies, same response field
  names (`remainingStockByProduct`, etc.), untouched.
- Stock validation logic, oversell prevention, cart quantity capping — same
  logic, just re-homed: a light pre-check still runs in `launchCheckoutFlow()`
  before navigating (to avoid sending someone to checkout for a sold-out
  item), and the full validation still runs again on checkout.html's load
  (the same defense-in-depth that existed before).
- Visual design — colors, fonts, spacing, the wizard's 4-step progress UI,
  OTP timer, all pixel-identical. Nothing in the Tailwind config changed.
- `style.css` and the four static info pages — byte-for-byte untouched.

## CRITICAL — test before going live
Because this touches the payment flow, walk through the full path at least
once in Razorpay's test mode before pointing this at real traffic:

1. Add an item to cart from the homepage → open cart drawer → "SECURE_CHECKOUT"
   → confirm you land on checkout.html with your item showing correctly.
2. Step 1 (email/phone) → confirm OTP email actually arrives and the timer
   counts down correctly.
3. Step 2 → enter the OTP → confirm it advances to shipping.
4. Step 3 → fill shipping → confirm step 4 shows the correct summary/total.
5. Step 4 → "MAKE PAYMENT" → complete with a Razorpay test card/UPI VPA →
   confirm the success screen appears and `morphergyx@gmail.com` gets the
   merchant alert email.
6. Also test the **size-popup "BUY NOW"** path directly from the homepage
   (not via the cart drawer) — confirm it lands on checkout.html correctly too.
7. Test **refreshing checkout.html mid-flow** — the cart should still be there
   (it's now in localStorage), though you'll be returned to step 1 since the
   wizard's own progress (which step you were on, what you typed) is not
   persisted — only the cart contents are. This matches the spirit of the
   original behavior, which also didn't persist wizard progress across a
   full page reload.
8. Test reaching `checkout.html` directly with an empty cart (e.g. clear
   your cart, then type the checkout.html URL directly) — should show the
   "YOUR VAULT IS EMPTY" state with a link back to the store.

## If you ever add a new HTML class anywhere
Same rule as before: rebuild `tailwind-built.css` with
`npx tailwindcss -i ./tailwind-input.css -o ./tailwind-built.css --minify`
whenever you add a brand-new utility class that wasn't used anywhere on the
site before — now scanning across all 5 HTML files including checkout.html.

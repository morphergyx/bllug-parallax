/**
 * BLLUG — Apps Script Backend
 * Handles: OTP send/verify + Razorpay order creation + payment
 * signature verification + Google Sheet product catalog + stock
 * tracking + order logging + merchant & customer email notifications +
 * contact form submissions + drop-launch email subscriber signups.
 * ALL outgoing emails are sent via Brevo (transactional email API)
 * instead of Gmail/MailApp.
 *
 * ============================================================
 * ONE-TIME SETUP — do this before deploying
 * ============================================================
 * 1. Open Extensions > Apps Script > Project Settings > Script Properties.
 *    Add these properties (Project Settings > Script properties > Add property):
 *      RAZORPAY_KEY_ID      = rzp_test_xxxxxxxx   (or rzp_live_xxxxxxxx when ready)
 *      RAZORPAY_KEY_SECRET  = your_key_secret      (NEVER put this in HTML/JS)
 *      SHEET_ID             = the ID of your Google Sheet
 *      BREVO_API_KEY        = your Brevo API key (Settings > SMTP & API > API Keys)
 *      SENDER_EMAIL         = info@bllug.co.in   (must be a verified sender in Brevo)
 *      SENDER_NAME          = BLLUG
 *      MERCHANT_EMAIL       = morphergyx@gmail.com   (where new-order + contact-form alerts go)
 *
 * 2. Your Google Sheet needs FIVE tabs:
 *
 *    Tab "Products" — columns (row 1 = header, exactly these names):
 *      name | price | active | stock
 *    Example rows:
 *      The Owl Series      | 2049 | TRUE | 100
 *      The Tiger Series    | 2049 | TRUE | 100
 *      The Humming Series  | 2049 | TRUE | 100
 *    `stock` = total pieces available for that series (100 each, per your spec).
 *    This is the FULL pool size — it never auto-decrements. Sold counts live
 *    separately in the "Sold" tab so you can always see stock vs sold side by side.
 *
 *    Tab "Sold" — columns (row 1 = header):
 *      name | sold_count
 *    One row per product, starting at sold_count = 0. The script increments
 *    this after every verified payment. Do not edit this by hand while live
 *    unless you know what you're adjusting — it's the live source of truth
 *    for "how many are gone".
 *
 *    Tab "Orders" — columns (row 1 = header):
 *      timestamp | order_id | payment_id | status | name | email | phone |
 *      address | items_json | amount | promo_code
 *
 *    Tab "Contact" — columns (row 1 = header):
 *      timestamp | email | type | subject | message
 *    One row per contact-form submission from contact.html. This tab must
 *    be created manually before the contact form will work — the script
 *    will throw "Sheet tab not found: Contact" if it's missing.
 *
 *    Tab "Subscribers" — columns (row 1 = header):
 *      timestamp | email | status
 *    One row per drop-launch email signup from the homepage's "JOIN THE FEW"
 *    section. This tab must be created manually before the subscribe form
 *    will work — the script will throw "Sheet tab not found: Subscribers"
 *    if it's missing. (This handler used to run as a completely separate
 *    standalone Apps Script project with its own deployment URL and its own
 *    hardcoded Brevo key — it's now merged into this one project, using the
 *    same Script Properties and the same SHEET_ID as everything else.)
 *
 *    Copy the Sheet ID from its URL:
 *    https://docs.google.com/spreadsheets/d/THIS_PART_IS_THE_ID/edit
 *
 * 3. Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone.
 *    Use the deployment URL as APPS_SCRIPT_URL in index.html.
 *
 * 4. Test fully with rzp_test_ keys before switching to rzp_live_ keys.
 * ============================================================
 */

// ---------- CONFIG HELPERS ----------

function getProp_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) throw new Error('Missing script property: ' + key);
  return value;
}

function getSheet_(tabName) {
  const sheetId = getProp_('SHEET_ID');
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('Sheet tab not found: ' + tabName);
  return sheet;
}

// ---------- PROMO CODES (server-side source of truth) ----------

const PROMO_CODES = {
  BLLUG10: 0.10,
  MSRIT10: 0.10
};

function getPromo_(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { code: '', rate: 0 };
  if (!Object.prototype.hasOwnProperty.call(PROMO_CODES, code)) {
    throw new Error('Invalid promo code.');
  }
  return { code: code, rate: PROMO_CODES[code] };
}

// ---------- BREVO EMAIL (single source of truth for ALL outgoing mail) ----------

/**
 * Sends an email via Brevo's transactional email API.
 * Every email in this entire script — OTP, order confirmations, merchant
 * alerts, contact form alerts, anything — must go through this function.
 * Never call MailApp/GmailApp.
 */
function sendBrevoEmail_(toEmail, toName, subject, textBody, htmlBody) {
  const apiKey = getProp_('BREVO_API_KEY');
  const senderEmail = getProp_('SENDER_EMAIL');
  const senderName = getProp_('SENDER_NAME');

  const payload = {
    sender: { name: senderName, email: senderEmail },
    to: [{ email: toEmail, name: toName || toEmail }],
    subject: subject,
    textContent: textBody,
    htmlContent: htmlBody || ('<p>' + textBody.replace(/\n/g, '<br>') + '</p>')
  };

  const response = UrlFetchApp.fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'api-key': apiKey,
      accept: 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  if (code !== 201 && code !== 200) {
    logEmailFailure_(toEmail, subject, response.getContentText());
    throw new Error('Brevo send failed (' + code + '): ' + response.getContentText());
  }
  return true;
}

function logEmailFailure_(toEmail, subject, errorText) {
  try {
    const sheet = getSheet_('Orders');
    sheet.appendRow([
      new Date(),
      '',
      '',
      'EMAIL_FAILED: ' + subject,
      '',
      toEmail,
      '',
      '',
      errorText,
      ''
    ]);
  } catch (err) {
    // If even logging fails, swallow it — don't mask the original error.
  }
}

// ---------- PRODUCT CATALOG (server-side source of truth for prices + stock) ----------

/**
 * Reads the Products tab into a map keyed by normalized (uppercased) name:
 *   { NAME: { price, stock, rowIndex } }
 * rowIndex is the 1-based sheet row, kept so callers can write back to the
 * exact same row without re-scanning.
 */
function getProductCatalog_() {
  const sheet = getSheet_('Products');
  const rows = sheet.getDataRange().getValues();
  const header = rows[0].map(h => String(h).trim().toLowerCase());
  const nameIdx = header.indexOf('name');
  const priceIdx = header.indexOf('price');
  const activeIdx = header.indexOf('active');
  const stockIdx = header.indexOf('stock');

  if (nameIdx === -1 || priceIdx === -1 || activeIdx === -1 || stockIdx === -1) {
    throw new Error('Products tab must have columns: name, price, active, stock');
  }

  const catalog = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row[nameIdx]) continue;
    const isActive = String(row[activeIdx]).trim().toUpperCase() === 'TRUE';
    if (!isActive) continue;
    const normalizedName = String(row[nameIdx]).trim().toUpperCase();
    catalog[normalizedName] = {
      price: Number(row[priceIdx]),
      stock: Number(row[stockIdx]) || 0,
      rowIndex: i + 1 // 1-based, matches sheet row numbers
    };
  }
  return catalog;
}

/**
 * Reads the Sold tab into a map keyed by normalized name: { NAME: { sold, rowIndex } }
 * If a product exists in Products but has no row yet in Sold, it's treated as 0 sold
 * (and a row is created for it the first time we need to increment).
 */
function getSoldMap_() {
  const sheet = getSheet_('Sold');
  const rows = sheet.getDataRange().getValues();
  const header = rows[0].map(h => String(h).trim().toLowerCase());
  const nameIdx = header.indexOf('name');
  const soldIdx = header.indexOf('sold_count');

  if (nameIdx === -1 || soldIdx === -1) {
    throw new Error('Sold tab must have columns: name, sold_count');
  }

  const map = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row[nameIdx]) continue;
    const normalizedName = String(row[nameIdx]).trim().toUpperCase();
    map[normalizedName] = {
      sold: Number(row[soldIdx]) || 0,
      rowIndex: i + 1
    };
  }
  return map;
}

/**
 * Returns { NAME: remainingCount } for every active product, combining
 * Products.stock with Sold.sold_count. Used by the get_stock endpoint and
 * by oversell checks.
 */
function getRemainingStockMap_() {
  const catalog = getProductCatalog_();
  const soldMap = getSoldMap_();
  const remaining = {};
  Object.keys(catalog).forEach(name => {
    const sold = soldMap[name] ? soldMap[name].sold : 0;
    remaining[name] = Math.max(0, catalog[name].stock - sold);
  });
  return remaining;
}

/**
 * Recalculates the cart total from the server-side catalog AND checks that
 * every requested item actually has enough remaining stock. Ignores any
 * "price" field sent from the browser — only trusts name + quantity.
 * Throws a descriptive error if an item is unknown, inactive, or oversold.
 */
function calculateVerifiedTotal_(cartItems, promoCode) {
  const catalog = getProductCatalog_();
  const remainingMap = getRemainingStockMap_();
  let total = 0;
  const lineItems = [];

  cartItems.forEach(item => {
    const normalizedName = String(item.name).trim().toUpperCase();
    const product = catalog[normalizedName];
    if (!product) {
      throw new Error('Unknown or inactive product: ' + item.name);
    }
    const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
    const remaining = remainingMap[normalizedName] || 0;
    if (qty > remaining) {
      throw new Error('SOLD_OUT:' + item.name + ':' + remaining);
    }
    total += product.price * qty;
    lineItems.push({ name: item.name, size: item.size, quantity: qty, unitPrice: product.price });
  });

  const shipping = 0; // currently free shipping across the board
  const promo = getPromo_(promoCode);
  const discount = Math.round(total * promo.rate * 100) / 100;
  return {
    subtotal: total,
    shipping: shipping,
    discount: discount,
    total: total + shipping - discount,
    promoCode: promo.code,
    lineItems: lineItems
  };
}

/**
 * Atomically increments sold_count for each purchased item, using a script
 * lock so two simultaneous buyers can't both read-then-write and oversell.
 * Re-checks remaining stock INSIDE the lock right before committing — if
 * stock ran out between order-creation and payment-verification, this
 * throws and the caller must NOT treat the order as fulfilled.
 */
function incrementSoldCountsOrThrow_(cartItems) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // up to 30s

  try {
    const catalog = getProductCatalog_();
    const sheet = getSheet_('Sold');
    const soldMap = getSoldMap_();

    // First pass: validate everything has enough stock, inside the lock.
    cartItems.forEach(item => {
      const normalizedName = String(item.name).trim().toUpperCase();
      const product = catalog[normalizedName];
      if (!product) throw new Error('Unknown or inactive product: ' + item.name);
      const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
      const currentSold = soldMap[normalizedName] ? soldMap[normalizedName].sold : 0;
      const remaining = Math.max(0, product.stock - currentSold);
      if (qty > remaining) {
        throw new Error('SOLD_OUT:' + item.name + ':' + remaining);
      }
    });

    // Second pass: commit increments now that we know all items fit.
    cartItems.forEach(item => {
      const normalizedName = String(item.name).trim().toUpperCase();
      const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
      const existing = soldMap[normalizedName];
      if (existing) {
        const newSold = existing.sold + qty;
        sheet.getRange(existing.rowIndex, 2).setValue(newSold); // sold_count is column 2
        soldMap[normalizedName] = { sold: newSold, rowIndex: existing.rowIndex };
      } else {
        sheet.appendRow([item.name, qty]);
        soldMap[normalizedName] = { sold: qty, rowIndex: sheet.getLastRow() };
      }
    });
  } finally {
    lock.releaseLock();
  }
}

// ---------- RAZORPAY: CREATE ORDER ----------

function createRazorpayOrder_(payload) {
  const keyId = getProp_('RAZORPAY_KEY_ID');
  const keySecret = getProp_('RAZORPAY_KEY_SECRET');

  let verified;
  try {
    verified = calculateVerifiedTotal_(payload.items || [], payload.promoCode);
  } catch (err) {
    return { success: false, message: friendlySoldOutMessage_(err.message) };
  }

  if (verified.total <= 0) {
    return { success: false, message: 'Cart total must be greater than zero.' };
  }

  const amountInPaise = Math.round(verified.total * 100); // Razorpay expects paise

  const orderPayload = {
    amount: amountInPaise,
    currency: 'INR',
    receipt: 'bllug_' + new Date().getTime(),
    notes: {
      email: payload.email || '',
      phone: payload.phone || '',
      promo_code: verified.promoCode
    }
  };

  const response = UrlFetchApp.fetch('https://api.razorpay.com/v1/orders', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(keyId + ':' + keySecret)
    },
    payload: JSON.stringify(orderPayload),
    muteHttpExceptions: true
  });

  const result = JSON.parse(response.getContentText());

  if (response.getResponseCode() !== 200) {
    return { success: false, message: (result.error && result.error.description) || 'Razorpay order creation failed.' };
  }

  return {
    success: true,
    order_id: result.id,
    amount: amountInPaise,
    currency: 'INR',
    key_id: keyId,
    verifiedTotal: verified.total,
    subtotal: verified.subtotal,
    discount: verified.discount,
    promoCode: verified.promoCode
  };
}

function friendlySoldOutMessage_(rawMessage) {
  if (String(rawMessage).indexOf('SOLD_OUT:') === 0) {
    const parts = rawMessage.split(':');
    const productName = parts[1];
    const remaining = parts[2];
    return 'Only ' + remaining + ' piece(s) of "' + productName + '" left. Please update your cart.';
  }
  return rawMessage;
}

function getRazorpayOrder_(orderId) {
  const keyId = getProp_('RAZORPAY_KEY_ID');
  const keySecret = getProp_('RAZORPAY_KEY_SECRET');
  const response = UrlFetchApp.fetch('https://api.razorpay.com/v1/orders/' + encodeURIComponent(orderId), {
    method: 'get',
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(keyId + ':' + keySecret) },
    muteHttpExceptions: true
  });
  const result = JSON.parse(response.getContentText());
  if (response.getResponseCode() !== 200) {
    throw new Error((result.error && result.error.description) || 'Could not verify Razorpay order.');
  }
  return result;
}

// ---------- RAZORPAY: VERIFY PAYMENT SIGNATURE ----------

function verifyRazorpayPayment_(payload) {
  const keySecret = getProp_('RAZORPAY_KEY_SECRET');

  const orderId = payload.razorpay_order_id;
  const paymentId = payload.razorpay_payment_id;
  const signature = payload.razorpay_signature;

  if (!orderId || !paymentId || !signature) {
    return { success: false, message: 'Missing payment verification fields.' };
  }

  // Razorpay signature = HMAC-SHA256(order_id + "|" + payment_id, key_secret)
  const expectedSignatureBytes = Utilities.computeHmacSha256Signature(
    orderId + '|' + paymentId,
    keySecret
  );
  const expectedSignature = expectedSignatureBytes
    .map(byte => {
      const v = (byte < 0 ? byte + 256 : byte).toString(16);
      return v.length === 1 ? '0' + v : v;
    })
    .join('');

  if (expectedSignature !== signature) {
    logOrder_({ orderId: orderId, paymentId: paymentId, status: 'SIGNATURE_MISMATCH', payload: payload });
    return { success: false, message: 'Payment signature verification failed.' };
  }

  // Read the promo code and amount from the Razorpay order itself. This is
  // authoritative and prevents a visitor from changing promoCode in the
  // browser between order creation and payment verification.
  const razorpayOrder = getRazorpayOrder_(orderId);
  const orderPromoCode = String((razorpayOrder.notes && razorpayOrder.notes.promo_code) || '').trim().toUpperCase();
  let orderPricing;
  try {
    orderPricing = calculateVerifiedTotal_(payload.items || [], orderPromoCode);
  } catch (err) {
    return { success: false, message: err.message };
  }
  if (Math.round(orderPricing.total * 100) !== Number(razorpayOrder.amount)) {
    logOrder_({ orderId: orderId, paymentId: paymentId, status: 'ORDER_AMOUNT_MISMATCH', payload: payload });
    return { success: false, message: 'Order amount verification failed. Please contact support.' };
  }
  payload.promoCode = orderPromoCode;
  payload.amount = Number(razorpayOrder.amount) / 100;

  // Signature is valid — payment is genuinely captured by Razorpay.
  // Now try to commit the stock decrement. This re-checks remaining stock
  // INSIDE a lock, covering the rare race where stock ran out between
  // order-creation and payment completion (e.g. two people checking out
  // the last piece at the same moment).
  let verified;
  try {
    incrementSoldCountsOrThrow_(payload.items || []);
    verified = calculateVerifiedTotalForEmail_(payload.items || [], orderPromoCode);
  } catch (err) {
    // Payment succeeded on Razorpay's side but we could not safely fulfil
    // it — flag clearly in the sheet so it's the one path that needs a
    // manual look (no auto-refund per your instructions; the website's
    // job was to prevent this via live stock checks before checkout).
    logOrder_({
      orderId: orderId,
      paymentId: paymentId,
      status: 'PAID_BUT_OVERSOLD — NEEDS MANUAL REFUND/RESOLUTION: ' + err.message,
      payload: payload
    });
    try {
      notifyMerchantOversold_(payload, orderId, paymentId, err.message);
    } catch (notifyErr) {
      // best-effort
    }
    return {
      success: false,
      message: 'That item just sold out while your payment was processing. ' +
        'Your payment was captured — our team will contact you to refund or offer an alternative. ' +
        'Reference payment ID: ' + paymentId
    };
  }

  logOrder_({ orderId: orderId, paymentId: paymentId, status: 'CONFIRMED', payload: payload });

  const customer = (payload.customer || {});

  // Customer confirmation email — best-effort, never fails an already
  // successful + already logged + already stock-decremented payment.
  if (customer.email) {
    try {
      sendOrderConfirmationEmail_(customer, orderId, paymentId, verified.lineItems, verified.total, verified.shipping, verified.discount, verified.promoCode);
    } catch (err) {
      // Failure already logged inside sendBrevoEmail_.
    }
  }

  // Merchant new-order alert — also best-effort.
  try {
    sendMerchantOrderAlert_(customer, orderId, paymentId, verified.lineItems, verified.total, verified.shipping, verified.discount, verified.promoCode);
  } catch (err) {
    // Failure already logged inside sendBrevoEmail_.
  }

  // Return fresh remaining-stock numbers so the frontend can update the
  // "pieces left" UI immediately without a second round trip.
  const remainingStockMap = getRemainingStockMap_();

  return {
    success: true,
    message: 'Payment verified.',
    remainingStockByProduct: remainingStockMap
  };
}

/**
 * Same shape as calculateVerifiedTotal_ but does NOT re-check/throw on
 * stock — at this point stock has *already* been decremented by
 * incrementSoldCountsOrThrow_, so we just need prices for the email.
 */
function calculateVerifiedTotalForEmail_(cartItems, promoCode) {
  const catalog = getProductCatalog_();
  let total = 0;
  const lineItems = [];
  cartItems.forEach(item => {
    const normalizedName = String(item.name).trim().toUpperCase();
    const product = catalog[normalizedName];
    const unitPrice = product ? product.price : 0;
    const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
    total += unitPrice * qty;
    lineItems.push({ name: item.name, size: item.size, quantity: qty, unitPrice: unitPrice });
  });
  const shipping = 0;
  const promo = getPromo_(promoCode);
  const discount = Math.round(total * promo.rate * 100) / 100;
  return { subtotal: total, shipping: shipping, discount: discount, total: total + shipping - discount, promoCode: promo.code, lineItems: lineItems };
}

// ---------- STOCK ENDPOINT ----------

function getStockResponse_() {
  return { success: true, remainingStockByProduct: getRemainingStockMap_() };
}

// ---------- CUSTOMER ORDER CONFIRMATION EMAIL ----------

function sendOrderConfirmationEmail_(customer, orderId, paymentId, items, totalAmount, shippingAmount, discountAmount, promoCode) {
  const name = customer.name || 'there';
  const shipping = Number(shippingAmount) || 0;
  const discount = Number(discountAmount) || 0;

  let textLines = [];
  items.forEach(item => {
    const qty = item.quantity || 1;
    const unitPrice = item.unitPrice || 0;
    const lineTotal = qty * unitPrice;
    const sizeStr = item.size ? (' (' + item.size + ')') : '';
    textLines.push('  - ' + item.name + sizeStr + '  x' + qty + '  — Rs.' + lineTotal.toFixed(2));
  });
  if (shipping > 0) {
    textLines.push('  - Shipping — Rs.' + shipping.toFixed(2));
  }
  if (discount > 0) {
    textLines.push('  - Promo ' + promoCode + ' (10% off) — -Rs.' + discount.toFixed(2));
  }
  const textSummary = textLines.join('\n');

  let htmlRows = '';
  items.forEach(item => {
    const qty = item.quantity || 1;
    const unitPrice = item.unitPrice || 0;
    const lineTotal = qty * unitPrice;
    const sizeStr = item.size ? (' (' + item.size + ')') : '';
    htmlRows += '<tr>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;">' + item.name + sizeStr + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">' + qty + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">Rs.' + lineTotal.toFixed(2) + '</td>' +
      '</tr>';
  });
  if (shipping > 0) {
    htmlRows += '<tr>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;" colspan="2">Shipping</td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">Rs.' + shipping.toFixed(2) + '</td>' +
      '</tr>';
  }
  if (discount > 0) {
    htmlRows += '<tr>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;" colspan="2">Promo ' + promoCode + ' (10% off)</td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">-Rs.' + discount.toFixed(2) + '</td>' +
      '</tr>';
  }

  const subject = 'BLLUG — Payment Received, Order Confirmed (' + orderId + ')';

  const textBody =
    'Hi ' + name + ',\n\n' +
    'We have received your payment and your order is confirmed.\n\n' +
    'Order ID: ' + orderId + '\n' +
    'Payment ID: ' + paymentId + '\n\n' +
    'Order summary:\n' + textSummary + '\n\n' +
    'Total paid: Rs.' + Number(totalAmount).toFixed(2) + '\n\n' +
    'Your order will be shipped soon. We will share tracking details over email once it is dispatched.\n\n' +
    'Thank you for shopping with BLLUG.\n\n— BLLUG';

  const htmlBody =
    '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;">' +
      '<p>Hi ' + name + ',</p>' +
      '<p>We have received your payment and your order is confirmed.</p>' +
      '<p><strong>Order ID:</strong> ' + orderId + '<br>' +
      '<strong>Payment ID:</strong> ' + paymentId + '</p>' +
      '<table style="width:100%;border-collapse:collapse;margin:16px 0;">' +
        '<thead><tr>' +
          '<th style="padding:8px;text-align:left;border-bottom:2px solid #333;">Product</th>' +
          '<th style="padding:8px;text-align:center;border-bottom:2px solid #333;">Qty</th>' +
          '<th style="padding:8px;text-align:right;border-bottom:2px solid #333;">Amount</th>' +
        '</tr></thead>' +
        '<tbody>' + htmlRows + '</tbody>' +
      '</table>' +
      '<p style="text-align:right;font-weight:bold;">Total paid: Rs.' + Number(totalAmount).toFixed(2) + '</p>' +
      '<p>Your order will be shipped soon. We will share tracking details over email once it is dispatched.</p>' +
      '<p>Thank you for shopping with BLLUG.</p>' +
      '<p>— BLLUG</p>' +
    '</div>';

  sendBrevoEmail_(customer.email, customer.name, subject, textBody, htmlBody);
}

// ---------- MERCHANT NEW-ORDER ALERT EMAIL ----------

/**
 * Notifies the merchant (MERCHANT_EMAIL script property) immediately after
 * a payment is verified, with full order details — so you never have to
 * open the Sheet manually to know an order came in.
 */
function sendMerchantOrderAlert_(customer, orderId, paymentId, items, totalAmount, shippingAmount, discountAmount, promoCode) {
  const merchantEmail = getProp_('MERCHANT_EMAIL');
  const shipping = Number(shippingAmount) || 0;
  const discount = Number(discountAmount) || 0;

  let textLines = [];
  items.forEach(item => {
    const qty = item.quantity || 1;
    const unitPrice = item.unitPrice || 0;
    const sizeStr = item.size ? (' (' + item.size + ')') : '';
    textLines.push('  - ' + item.name + sizeStr + '  x' + qty + '  @ Rs.' + unitPrice + '  = Rs.' + (qty * unitPrice).toFixed(2));
  });
  if (discount > 0) {
    textLines.push('  - Promo ' + promoCode + ' (10% off) = -Rs.' + discount.toFixed(2));
  }
  const textItemsSummary = textLines.join('\n');

  let htmlRows = '';
  items.forEach(item => {
    const qty = item.quantity || 1;
    const unitPrice = item.unitPrice || 0;
    const sizeStr = item.size ? (' (' + item.size + ')') : '';
    htmlRows += '<tr>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;">' + item.name + sizeStr + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">' + qty + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">Rs.' + (qty * unitPrice).toFixed(2) + '</td>' +
      '</tr>';
  });
  if (discount > 0) {
    htmlRows += '<tr>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;" colspan="2">Promo ' + promoCode + ' (10% off)</td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">-Rs.' + discount.toFixed(2) + '</td>' +
      '</tr>';
  }

  const subject = 'New BLLUG Order — ' + orderId + ' — Rs.' + Number(totalAmount).toFixed(2);

  const textBody =
    'New order received.\n\n' +
    'Order ID: ' + orderId + '\n' +
    'Payment ID: ' + paymentId + '\n\n' +
    'Customer: ' + (customer.name || '—') + '\n' +
    'Email: ' + (customer.email || '—') + '\n' +
    'Phone: ' + (customer.phone || '—') + '\n' +
    'Shipping address: ' + (customer.address || '—') + '\n\n' +
    'Items:\n' + textItemsSummary + '\n\n' +
    'Shipping fee: Rs.' + shipping.toFixed(2) + '\n' +
    'Total paid: Rs.' + Number(totalAmount).toFixed(2);

  const htmlBody =
    '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;">' +
      '<h2 style="margin-bottom:4px;">New Order Received</h2>' +
      '<p><strong>Order ID:</strong> ' + orderId + '<br>' +
      '<strong>Payment ID:</strong> ' + paymentId + '</p>' +
      '<p><strong>Customer:</strong> ' + (customer.name || '—') + '<br>' +
      '<strong>Email:</strong> ' + (customer.email || '—') + '<br>' +
      '<strong>Phone:</strong> ' + (customer.phone || '—') + '<br>' +
      '<strong>Shipping address:</strong> ' + (customer.address || '—') + '</p>' +
      '<table style="width:100%;border-collapse:collapse;margin:16px 0;">' +
        '<thead><tr>' +
          '<th style="padding:8px;text-align:left;border-bottom:2px solid #333;">Product</th>' +
          '<th style="padding:8px;text-align:center;border-bottom:2px solid #333;">Qty</th>' +
          '<th style="padding:8px;text-align:right;border-bottom:2px solid #333;">Amount</th>' +
        '</tr></thead>' +
        '<tbody>' + htmlRows + '</tbody>' +
      '</table>' +
      '<p style="text-align:right;">Shipping: Rs.' + shipping.toFixed(2) + '</p>' +
      '<p style="text-align:right;font-weight:bold;">Total paid: Rs.' + Number(totalAmount).toFixed(2) + '</p>' +
    '</div>';

  sendBrevoEmail_(merchantEmail, 'BLLUG Admin', subject, textBody, htmlBody);
}

/**
 * Special merchant alert for the rare "paid but oversold" race-condition
 * case — flags that manual resolution (refund or substitute) is needed.
 */
function notifyMerchantOversold_(payload, orderId, paymentId, reason) {
  const merchantEmail = getProp_('MERCHANT_EMAIL');
  const customer = payload.customer || {};
  const subject = '⚠ ACTION NEEDED — Paid order could not be fulfilled (' + orderId + ')';
  const textBody =
    'A payment was captured by Razorpay but could not be fulfilled because stock ran out ' +
    'between checkout start and payment completion.\n\n' +
    'Reason: ' + reason + '\n\n' +
    'Order ID: ' + orderId + '\n' +
    'Payment ID: ' + paymentId + '\n' +
    'Customer: ' + (customer.name || '—') + '\n' +
    'Email: ' + (customer.email || '—') + '\n' +
    'Phone: ' + (customer.phone || '—') + '\n\n' +
    'This needs a manual refund or a substitute-item offer to the customer. ' +
    'Check the Orders tab for status "PAID_BUT_OVERSOLD" for full details.';
  sendBrevoEmail_(merchantEmail, 'BLLUG Admin', subject, textBody);
}

// ---------- ORDER LOGGING ----------

function logOrder_(data) {
  const sheet = getSheet_('Orders');
  const customer = data.payload.customer || {};
  sheet.appendRow([
    new Date(),
    data.orderId || '',
    data.paymentId || '',
    data.status || '',
    customer.name || '',
    customer.email || '',
    customer.phone || '',
    customer.address || '',
    JSON.stringify(data.payload.items || []),
    data.payload.amount || '',
    data.payload.promoCode || ''
  ]);
}

// ---------- OTP ----------

function sendOtp_(email) {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const cache = CacheService.getScriptCache();
  cache.put('otp_' + email, otp, 300); // 5 min expiry

  sendBrevoEmail_(
    email,
    '',
    'BLLUG — Your Verification Code',
    'Your verification code is: ' + otp + '\n\nThis code expires in 5 minutes.',
    '<p>Your verification code is: <strong>' + otp + '</strong></p><p>This code expires in 5 minutes.</p>'
  );

  return { success: true, message: 'OTP sent.' };
}

function verifyOtp_(email, otp) {
  const cache = CacheService.getScriptCache();
  const storedOtp = cache.get('otp_' + email);

  if (!storedOtp) {
    return { success: false, message: 'OTP expired or not found. Please resend.' };
  }
  if (storedOtp !== otp) {
    return { success: false, message: 'Incorrect OTP.' };
  }

  cache.remove('otp_' + email);
  return { success: true, message: 'OTP verified.' };
}

// ---------- CONTACT FORM ----------

/**
 * Handles a contact-form submission from contact.html.
 * Always logs the message to the "Contact" sheet tab first (so we never
 * lose an inquiry even if the email step fails), then best-effort sends
 * an alert to MERCHANT_EMAIL via Brevo — same resilience pattern as the
 * order-confirmation/merchant-alert emails elsewhere in this file.
 *
 * Requires a "Contact" tab in the Sheet with columns (row 1 = header):
 *   timestamp | email | type | subject | message
 */
function submitContactForm_(payload) {
  const email = String(payload.email || '').trim();
  const type = String(payload.type || '').trim();
  const subject = String(payload.subject || '').trim();
  const message = String(payload.message || '').trim();

  if (!email || !email.includes('@') || !type || !subject || !message) {
    return { success: false, message: 'Please complete all fields with valid values.' };
  }

  // Log to sheet first — this is the durable record. If the email step
  // below fails, the inquiry is still safely captured here.
  try {
    logContactSubmission_(email, type, subject, message);
  } catch (err) {
    return { success: false, message: 'Could not save your message. Please try again or email us directly.' };
  }

  // Best-effort merchant alert — a Brevo hiccup should not make the form
  // look like it failed to the visitor, since the message is already saved.
  try {
    notifyMerchantContactSubmission_(email, type, subject, message);
  } catch (err) {
    // Failure already logged inside sendBrevoEmail_; the sheet row above
    // is the source of truth, so we don't surface this to the visitor.
  }

  return { success: true, message: 'Message received.' };
}

function logContactSubmission_(email, type, subject, message) {
  const sheet = getSheet_('Contact');
  sheet.appendRow([
    new Date(),
    email,
    type,
    subject,
    message
  ]);
}

function notifyMerchantContactSubmission_(email, type, subject, message) {
  const merchantEmail = getProp_('MERCHANT_EMAIL');

  const typeLabels = {
    order: 'Order Issue',
    return: 'Return / Exchange',
    shipping: 'Shipping Question',
    product: 'Product Question',
    general: 'General Inquiry'
  };
  const typeLabel = typeLabels[type] || type;

  const emailSubject = 'BLLUG Contact Form — ' + typeLabel + ' — ' + subject;

  const textBody =
    'New contact form submission.\n\n' +
    'From: ' + email + '\n' +
    'Type: ' + typeLabel + '\n' +
    'Subject: ' + subject + '\n\n' +
    'Message:\n' + message;

  const htmlBody =
    '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;">' +
      '<h2 style="margin-bottom:4px;">New Contact Form Submission</h2>' +
      '<p><strong>From:</strong> ' + email + '<br>' +
      '<strong>Type:</strong> ' + typeLabel + '<br>' +
      '<strong>Subject:</strong> ' + subject + '</p>' +
      '<p style="white-space:pre-wrap;border-top:1px solid #eee;padding-top:12px;">' + message + '</p>' +
    '</div>';

  sendBrevoEmail_(merchantEmail, 'BLLUG Admin', emailSubject, textBody, htmlBody);
}

// ---------- SUBSCRIBER LIST (drop-launch email signup) ----------

/**
 * Handles a subscribe-form submission from the homepage's "JOIN THE FEW"
 * section. Previously ran as a separate standalone Apps Script project with
 * its own deployment URL and its own hardcoded Brevo API key — merged here
 * so everything lives in one project, uses the same Script Properties
 * (BREVO_API_KEY, SENDER_EMAIL, SENDER_NAME), and goes through the same
 * sendBrevoEmail_ helper as every other email in this file.
 *
 * Requires a "Subscribers" tab in the Sheet with columns (row 1 = header):
 *   timestamp | email | status
 */
function subscribeEmail_(payload) {
  const email = String(payload.email || '').trim().toLowerCase();

  if (!isValidEmailFormat_(email)) {
    return { status: 'error', message: 'Invalid email address.' };
  }

  const sheet = getSheet_('Subscribers');

  if (isAlreadySubscribed_(sheet, email)) {
    return { status: 'exists', message: 'You are already on the list.' };
  }

  sheet.appendRow([new Date(), email, 'subscribed']);

  try {
    sendSubscriberWelcomeEmail_(email);
  } catch (err) {
    // Best-effort, same pattern as every other email in this file — the
    // subscriber is already saved in the sheet above, so a Brevo hiccup
    // here doesn't lose the signup, it just means the welcome email
    // didn't go out (logged via logEmailFailure_ inside sendBrevoEmail_).
  }

  return { status: 'success', message: 'Subscribed successfully.' };
}

/**
 * Stricter than the simple "contains @" checks used elsewhere in this file —
 * kept from the original standalone subscriber script, which validated a
 * real email shape (something@something.something) rather than just
 * presence of an @ symbol.
 */
function isValidEmailFormat_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isAlreadySubscribed_(sheet, email) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]).trim().toLowerCase() === email) return true;
  }
  return false;
}

function sendSubscriberWelcomeEmail_(recipientEmail) {
  const subject = 'Welcome to ' + 'BLLUG' + ' // Access Confirmed';

  const htmlBody = '<div style="background:#111111;padding:48px 32px;font-family:\'Courier New\',monospace;color:#e5e5e5;">' +
    '<div style="max-width:520px;margin:0 auto;">' +
    '<p style="font-size:13px;letter-spacing:2px;color:#888;margin:0 0 24px;">SERIES_01 // VAULT // MANIFESTO</p>' +
    '<h1 style="font-size:32px;letter-spacing:1px;color:#f5f5f5;margin:0 0 16px;text-transform:uppercase;">Thank you for joining the few.</h1>' +
    '<p style="font-size:15px;line-height:1.6;color:#bbb;margin:0 0 24px;">Your access code has been registered. You will be the first to know the moment our next limited series drops.</p>' +
    '<div style="border:1px solid #333;padding:16px 20px;margin:0 0 28px;background:#181818;">' +
    '<p style="font-size:13px;letter-spacing:1px;color:#888;margin:0;">REGISTERED_EMAIL</p>' +
    '<p style="font-size:15px;color:#fff;margin:4px 0 0;">' + recipientEmail + '</p>' +
    '</div>' +
    '<p style="font-size:13px;line-height:1.6;color:#777;margin:0;">No spam. No noise. Just the drop, when it is time.</p>' +
    '<p style="font-size:12px;color:#555;margin:40px 0 0;letter-spacing:1px;">&mdash; BLLUG</p>' +
    '</div></div>';

  const plainBody = 'Thank you for joining the few. Your access code has been registered. Registered email: ' + recipientEmail;

  sendBrevoEmail_(recipientEmail, '', subject, plainBody, htmlBody);
}

// ---------- ENTRY POINT ----------

function doPost(e) {
  let request;
  try {
    request = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ success: false, message: 'Invalid request body.' });
  }

  try {
    switch (request.action) {
      case 'send':
        return jsonResponse_(sendOtp_(request.email));

      case 'verify':
        return jsonResponse_(verifyOtp_(request.email, request.otp));

      case 'get_stock':
        return jsonResponse_(getStockResponse_());

      case 'create_order':
        return jsonResponse_(createRazorpayOrder_(request));

      case 'verify_payment':
        return jsonResponse_(verifyRazorpayPayment_(request));

      case 'contact':
        return jsonResponse_(submitContactForm_(request));

      case 'subscribe':
        return jsonResponse_(subscribeEmail_(request));

      default:
        return jsonResponse_({ success: false, message: 'Unknown action.' });
    }
  } catch (err) {
    return jsonResponse_({ success: false, message: err.message });
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

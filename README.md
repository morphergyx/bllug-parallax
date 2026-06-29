# BLLUG image optimization — real before/after, real files

## The headline number
Across every image your homepage and product pages actually load, browsers
will now download **1.77 MB instead of 3.85 MB** — a **53.9% reduction** —
for the exact same visuals, no visible quality loss (every result was
visually spot-checked before being finalized, not just measured by file size).

## What was actually wrong (now that I could see the real files)
1. **Hero, manifesto, and all 3 series-section backgrounds were full 4K
   (3840×2160)**, displayed at typical screen sizes — browsers were
   downloading 4x more pixel data than any real screen could show, then
   shrinking it with CSS. Resized to 1920×1080 (full HD — genuinely sharp
   at any real display size for these full-bleed sections).
2. **All images were JPG only.** WebP at an equivalent visual quality is
   reliably smaller — sometimes dramatically so (manifesto.jpg dropped 83%).
3. **Two images (`series-section-1.jpg`, `series-section-3.jpg`) were
   especially large — 678KB and 744KB — at the same dimensions as
   `series-section-2.jpg`'s 211KB.** This wasn't a settings mistake on your
   end: those two backgrounds are genuinely busy/textured (marbled,
   mottled, concrete-pillar scenes) that resist compression far more than
   `series-section-2`'s flat teal wall. Even after fixing this, these two
   remain your two heaviest files (290KB / 356KB) — that's the real,
   physical cost of that visual style, not something further settings
   tweaking will erase without visibly degrading the texture.
4. **Product detail images were 1600px wide, displayed in a modal that's
   at most ~672px wide on screen.** Resized to 1200px (safely covers 2x
   retina displays at that display width with margin).
5. **No WebP path existed anywhere** — every image was requested as a
   plain JPG/PNG with no smaller modern-format alternative offered to
   browsers that support one (which is effectively all browsers today).

## Per-file results (the ones that matter most)
| File | Before | After (WebP) | Saved |
|---|---|---|---|
| hero.jpg | 325 KB | 85 KB | 74% |
| manifesto.jpg | 297 KB | 49 KB | 83% |
| series-section-1.jpg | 679 KB | 290 KB | 57% |
| series-section-2.jpg | 212 KB | 50 KB | 76% |
| series-section-3.jpg | 744 KB | 356 KB | 52% |
| hero-portrait.jpg | 82 KB | 35 KB | 57% |
| mobile-section-1/2/3.jpg | 112/65/151 KB | 79/34/123 KB | 30/48/19% |
| product images (×6) | ~190 KB avg | ~110 KB avg | ~42% avg |

Quality settings were chosen per-image based on actual content (busy
textured backgrounds got lower quality settings since they hide
compression artifacts well and resist compression anyway; smoother images
and product photos with fine print detail got higher quality settings) —
not one blanket number across everything. Every result was visually
checked at full size before being finalized.

## How this is wired in (and why nothing will break)
Every image now loads via a `<picture>` element (or CSS `image-set()` for
the one background-image case) with the WebP version offered first and the
original JPG/PNG kept as the automatic fallback:

```html
<picture>
    <source srcset="/images/hero.webp" type="image/webp">
    <img src="/images/hero.jpg" alt="...">
</picture>
```

If a browser doesn't understand WebP (effectively none in current use,
but the safety net costs nothing), it just ignores the `<source>` and
loads the `<img>`'s `src` — your original JPG — exactly as it does today.
**Nothing breaks for anyone, ever, even in the most ancient browser.**

For the product detail pages, the carousel images are built dynamically by
`script.js` (not static HTML), so the fix lives there: it now derives the
WebP path automatically from whatever JPG path is passed in
(`images/foo.jpg` → `images/foo.webp`) and renders a real `<picture>`
element instead of a plain `<img>`. This means none of the actual
`openDetailsModal(...)` calls in any details page needed to change.

## What was deliberately left untouched
- **`og:image` / `twitter:image` meta tags and the JSON-LD `logo` field**
  still point at the original JPG/PNG, never WebP. Many social media link
  preview crawlers (Facebook, Twitter/X, LinkedIn) don't reliably support
  WebP for link cards — changing these would risk silently breaking your
  social share previews for a savings that doesn't matter (these are
  fetched once by a crawler, not by every visitor).
- **`style.css`, all backend code, checkout/cart/OTP logic** — completely
  untouched. This is a frontend-asset-only change.
- **`bllug-logo.png` and `favicon-black.png`** — included here in optimized
  form since you uploaded them, but I found no reference to either
  anywhere in your actual site code, so no HTML needed to change for them.
  They're available if you need them for something else (social assets,
  a future light-mode variant, etc.).

## To deploy
1. Upload everything in the `images/` folder here to your server's
   `/images/` directory — this **adds** the new `.webp` files alongside
   your existing `.jpg`/`.png` files. **Do not delete your original
   JPG/PNG files from the server** — they're still required as the
   fallback for the rare browser without WebP support, and your
   `og:image`/JSON-LD references still point directly at them.
2. Replace `index.html`, `owl-details.html`, `tiger-details.html`,
   `humming-details.html`, and `script.js` with the versions here.
3. That's it — no backend changes, no Apps Script redeploy needed, this
   doesn't touch anything covered in earlier work.

## If you add new images later
Any new photo you add later won't automatically get a WebP version — you'd
need to either re-run a similar conversion (Pillow's `img.save('out.webp',
quality=...)` is all it takes) or just accept the new image loads as plain
JPG/PNG until you do. The `<picture>`/`image-set()` pattern and
`script.js`'s automatic path-derivation are now in place for the *existing*
images — extending them to new ones just means making sure a matching
`.webp` file exists alongside whatever JPG you add.

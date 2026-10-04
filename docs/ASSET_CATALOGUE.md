# Asset catalogue

How a Hyperliquid market becomes something the app can show: a row, a name, a
description and two pieces of art.

## What we own and what we don't

| | Owner | Where it comes from |
|---|---|---|
| `coin`, `szDecimals`, `maxLeverage`, `isDelisted` | Hyperliquid | read from `meta(dex)` — never stored |
| name, description, icon, card art, `reports_earnings` | us | authored, generated, curated |

The app reads Hyperliquid directly for trading, so it reads `szDecimals` and
`maxLeverage` from there too. Storing a copy would only create something that
can go stale, and a wrong `szDecimals` means rejected orders. **`assets` holds
the editorial layer and nothing else.**

## Columns

```
icon_ref                text   -- path in the asset-logos bucket, null = none
card_ref                text   -- path in the asset-logos bucket, null = none
description             text
description_source      text   -- 'llm' | 'manual'
description_updated_at  timestamptz
reports_earnings        boolean -- null = nobody has vetted it
delisted_at             timestamptz -- null = live
```

Two art columns rather than one, because every asset has two variants and one
`image_ref` could never hold both. (The old singular `image_ref` was dropped; it
was null on every row and was selected but never returned.)

**`reports_earnings` is deliberately separate from `kind`.** ETFs (XLE, SMH,
SOXL) are not equities and do not report; some equity-shaped listings don't
report usefully either. Keeping them apart means `where reports_earnings is
null` is the review queue, and nothing has to be inferred at read time.

**`delisted_at` is a timestamp, not a boolean**, so we know when a delisting was
first observed. HL's `meta` carries `isDelisted` and 13 rows here were delisted
upstream while still being served as live.

## Art is served, not bundled

Icons and cards live in the public `asset-logos` bucket and are returned to the
app as absolute URLs. The app never sees a storage path or needs to know the
bucket name.

### Paths are content-hashed, and that's load-bearing

```
icons/NVDA-126f1383.svg
cards/NVDA-3cd794c2.webp
```

Because the ref is **stored** on the row rather than derived from the ticker,
new art can be uploaded to a new path and the row just points at it. Nothing
has to be invalidated, so objects are served:

```
Cache-Control: public, max-age=31536000, immutable
```

A ticker-keyed path (`cards/NVDA.webp`) would have forced either a short TTL or
a purge step on every art change.

> **Supabase's `cacheControl` is a max-age value, not a header.** It is
> interpolated into `public, max-age=${value}`. Passing a full header yields the
> nested, invalid `max-age=public, max-age=…` and the object stops being
> cacheable at all. There is a test pinning this.

### Cards are WebP

Source cards are ~1.1 MB PNGs of a 3D logo over a gradient fading to black —
content WebP compresses extremely well. Converting at quality 82 gives a mean
absolute pixel difference of about 1/255, and takes the whole set from ~54 MB to
under 2 MB. SVG icons are uploaded untouched; they are a few hundred bytes and
already resolution-independent.

### Missing art is normal

`icon_ref` and `card_ref` are independently nullable and the app already handles
absence: `EarningsCard` falls back to a logo tile, and `LogoView` falls back to
the ticker. A new market can ship with no art and still look intentional, so art
never blocks a listing.

## The two commands

Both are local CLIs, run deliberately. Neither is a scheduled job: classifying a
market and approving generated art both need a person, and new listings arrive
only a few a month.

### `npm run intake`

- **`status`** — the live HL universe against our catalogue: new, newly delisted,
  and editorial coverage.
- **`sync`** — inserts new **live** markets; flags rows delisted upstream. A
  market that is already delisted when discovered never gets a row.
- **`seed`** — fills blanks from the app bundle. Only fills blanks, so it never
  overwrites a later edit and is safe to re-run.

`sync` populates name, description and `reports_earnings` from the app's
`markets.json` + `company-info.json`, which are currently the best editorial
source we have. Anything the bundle doesn't know arrives **unnamed and
unvetted** and is printed as needing attention — it is never guessed.

`kind` is classified conservatively: equity from the bundle's `isEquity`, `etf`
from an unambiguous name, and `other` for everything else, for review. Leveraged
ETFs named "Bull 3X" rather than "ETF" land in `other` by design.

### `npm run art`

Reads the iOS asset catalogue, converts, uploads, and writes the refs back.
Idempotent: the destination path contains a hash of the content, so a re-run
computes the same path and skips. `--force` re-uploads when only object metadata
needs to change.

Art for a ticker with no row is reported, not uploaded — creating the row is
`intake`'s job.

## Adding a brand-new market

1. `npm run intake status` — see it listed.
2. `npm run intake sync` — row created, named and described if the app bundle
   knows it.
3. If it was printed as needing you, set `kind` and `reports_earnings`.
4. Art, if you want it beyond the logo fallback:
   - add `design/logos/<TICKER>.svg` in the mobile repo
   - `python3 image_generation/generate.py <TICKER> --install`
   - `npm run art -- <TICKER>`

**Step 4 has a platform constraint:** `generate.py` rasterises the logo with
`qlmanage`, which is macOS-only. On Windows, drop a pre-rendered 1024px PNG into
`image_generation/refs/<TICKER>.png` to bypass it. Sourcing the logo is manual
either way, and non-equity markets (GOLD, EUR, XYZ100) have no logo to fetch at
all.

## Known gaps

- **Quarterly summaries have no server home.** `last-quarter.json` (24 of 109)
  is still bundled. It is the only genuinely recurring generation job and is not
  built.
- **The app still reads bundled art.** Until the call sites move to `AsyncImage`
  against these URLs, the 71 MB `Assets.xcassets` stays in the binary and a new
  market still needs a release to show its card.
- **`assets` carries the project-wide over-grant** — `anon` holds TRUNCATE on it.
  Not exploitable while the anon key ships nowhere. See [RLS.md](RLS.md).

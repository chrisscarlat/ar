# AR

A lightweight, self-hosted web AR app for artworks: a free alternative to Artivive.
Visitors scan a QR code next to a painting, tap **Start**, point their phone at
the painting and see a video play exactly on top of it. No app to install.

- Plain HTML and vanilla JavaScript. No framework, no build step.
- [MindAR](https://github.com/hiukim/mind-ar-js) image tracking with plain [three.js](https://threejs.org/), loaded from a CDN at pinned versions.
- [Supabase](https://supabase.com/) for the database, file storage and admin login. No custom server.
- Hosted for free on GitHub Pages.
- Built for older phones: iPhone 8 / iOS Safari 14+, mid-range Android from around 2018 / Chrome 90+.

## How it works

| Page | Path | What it does |
| --- | --- | --- |
| Landing | `/` | Short explanation for visitors. |
| Scan | `/scan/?id=<artwork-id>` | Loads one artwork, tracks its painting, plays the video on it. |
| Admin | `/admin/` | Sign in, add artworks, compile markers, download QR codes. |

Each QR code opens the scan page for one artwork. The scan page loads only that
artwork's tracking file and tracks a single target, which keeps it fast.

```
index.html            landing page
scan/index.html       scan page
admin/index.html      admin page
js/config.js          Supabase URL and anon key (the only file you must edit)
js/scan.js            scan page: data loading, intro, fallback
js/scan-ar.js         scan page: MindAR + three.js (loaded on demand)
js/admin.js           admin page: auth, CRUD, QR codes
js/admin-media.js     marker compile + marker and video checks
js/qr.js              QR code SVG/PNG
css/                  styles
supabase/schema.sql   table, storage buckets, RLS policies
```

### Pinned libraries

| Library | Version | Used on |
| --- | --- | --- |
| mind-ar | 1.2.5 | scan (tracking), admin (compiler) |
| three | 0.160.0 | scan. MindAR 1.2.5 needs three ≤ 0.161 (it uses `sRGBEncoding`). |
| es-module-shims | 1.10.0 | scan, import maps on iOS < 16.4 |
| @supabase/supabase-js | 2.45.4 | admin |
| qrcode-generator | 1.4.4 | admin |

The scan page transfers about 630 KB (gzipped) before the tracking file and
the video. Most of that is MindAR's TensorFlow.js core (about 370 KB) and
three.js (about 165 KB). The browser caches it after the first visit.

## 1. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com/) (the free tier is enough).
2. Open **SQL Editor**, paste the contents of [`supabase/schema.sql`](supabase/schema.sql) and run it.
   This creates:
   - the `artworks` table and an `admins` table;
   - three **private** Storage buckets: `markers`, `targets`, `videos`;
   - Row Level Security: anyone can read active artworks and their files
     (through short-lived signed URLs); only admins can create, change or delete.
3. Create your admin login: **Authentication → Users → Add user** (email + password, auto-confirm).
4. Make that user an admin. In the SQL Editor run:
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'you@example.com';
   ```
5. Recommended: **Authentication → Sign In / Providers → Email**, turn off
   **Allow new users to sign up**. Non-admins cannot write anything anyway, but
   there is no reason to allow sign-ups.

## 2. Configure

Edit [`js/config.js`](js/config.js) with the values from **Project Settings → API**:

```js
window.AR_CONFIG = {
  supabaseUrl: 'https://abcdefghijklmnop.supabase.co',
  supabaseAnonKey: 'eyJ...'  // anon key or sb_publishable_... key
};
```

The anon (or publishable) key is meant to be public; RLS protects your data.
**Never** put the `service_role` / secret key in this repository or any page.

## 3. Deploy to GitHub Pages

1. In the repository go to **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Push to `main`. The workflow in `.github/workflows/pages.yml` publishes the
   site, for example at `https://<user>.github.io/ar/`.
3. In Supabase, **Authentication → URL Configuration**, set **Site URL** to
   your Pages URL.

The camera only works over HTTPS, which GitHub Pages provides. To test locally,
run a static server (for example `python3 -m http.server`) and open
`http://localhost:8000`. Browsers allow the camera on `localhost`. To test on a
phone you need HTTPS, for example via a tunnel or the deployed site.

## 4. Add an artwork

1. Open `/admin/` and sign in.
2. Enter a title and choose the **marker image** (a photo of the painting).
   The image is compiled into a `.mind` tracking file in your browser. This takes
   up to a minute and shows a progress bar.
3. Choose the **overlay video** (MP4).
4. Read any warnings, then **Save artwork**.
5. Open **QR code** on the artwork and download it as PNG or SVG. Print it next to the painting.

**Deactivate** hides an artwork from visitors without deleting it.
**Delete** removes the row and its files.

## Marker tips

Tracking quality depends almost entirely on the marker image.

- **Photograph the painting straight on**, evenly lit, without glare or frame,
  and crop exactly to the painted area. The video covers exactly this rectangle.
- **High contrast**: clear darks and lights. Pale, foggy or low-key images track poorly.
- **Detailed**: lots of edges, corners and texture spread across the whole image.
- **Non-repetitive**: avoid grids, stripes, tiles and large flat or gradient areas.
  Repeating patterns confuse the matcher.
- 1000 px on the long side is plenty. The admin scales larger images down.
- If the admin warns about contrast or features, try a better photo before you print the QR code.

## Video encoding

Older phones decode video and track the camera at the same time, so keep videos light:

- **MP4, H.264** (High or Main profile), **no audio needed** (it plays muted).
- **720p** at most (1280×720, or 720×1280 for portrait). Match the painting's aspect ratio.
- **2 to 4 Mbps**, **under 10 MB** in total.
- `+faststart` so playback can start before the whole file has downloaded.
- For a **seamless loop**, make the **first and last frame identical**.

Example with [ffmpeg](https://ffmpeg.org/):

```sh
ffmpeg -i input.mov \
  -vf "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2" \
  -c:v libx264 -profile:v high -level 4.0 -pix_fmt yuv420p \
  -b:v 3M -maxrate 4M -bufsize 6M \
  -an -movflags +faststart \
  output.mp4
```

For a portrait painting, swap `1280` and `720`.

## Behaviour on the scan page

- The video is preloaded as soon as the page opens.
- The **Start** button is real HTML text: iOS only allows video playback that starts from a tap.
- The camera is requested at a modest resolution (1280×720, or 640×480 on devices with little memory or few CPU cores).
- When the painting is found, the video plays on a plane with the marker's exact
  aspect ratio. It pauses when the painting is lost and resumes when found again.
- Tracking jitter is smoothed with MindAR's filter (`filterMinCF` 0.0001,
  `filterBeta` 0.001, set in `js/scan.js`). Raise `filterBeta` if the video lags
  behind fast phone movements.
- If camera permission is denied, the page explains how to allow it on iPhone and Android.
- Without WebGL or a camera, the video is shown in a normal player instead.

## Security notes

- Storage buckets are private. The scan page asks Supabase for signed URLs, which
  RLS only issues for files that belong to an **active** artwork.
- Only users in `public.admins` can write. Being signed in is not enough.
- The service role key is never needed by this app.

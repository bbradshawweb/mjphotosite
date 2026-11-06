# Private customer galleries

This feature adds customer galleries to the existing static website. Existing pages, forms, assets, `site.css` and `CNAME` need no edits. The `mjphotosite` repository publishes the site when pushed, so review the gallery files and complete the real-service checks below before pushing.

Customers receive `https://www.malloryjanephotography.com/gallery.html#<secret>`, browse a responsive photo grid, open full-resolution photos, and save originals individually or download the **entire gallery as one ZIP**. Photos remain in the existing Google Drive account. A private Google Sheet supplies a **Photo galleries** menu to create, refresh and revoke links.

The implementation uses existing static hosting plus Google Apps Script. It needs no paid gallery subscription, database, new image storage, API key or billing-enabled cloud service. Apps Script has usage quotas, so this is intended for a small photography business, not unlimited public image hosting. See [Google's service quotas](https://developers.google.com/apps-script/guides/services/quotas).

## Preview now

From this folder, run:

```powershell
node scripts/preview.mjs
```

Open <http://127.0.0.1:4173/gallery.html?demo=1>. This uses only the site's existing public portfolio images and a local mock service; it does **not** connect to private Drive photos. The demo code is served only by the local Node server. A `?demo` parameter on the live static site cannot enable it.

Run the automated checks with:

```powershell
npm test
# Optional: exercise a 4.5 GiB ZIP64 stream without writing a large file to disk.
npm run test:large-download
```

## Updating an existing gallery deployment

This download update does not require new customer links, a new Sheet, extra storage, or new Google authorization scopes.

1. Review and push the website files listed under **Release and rollback**. The new frontend also accepts responses from the previous backend, allowing the website to be published first.
2. In the existing Sheet's Apps Script project, replace **both** `Code.gs` and the HTML file `Bridge` with the contents of `apps-script/Code.gs` and `apps-script/Bridge.html`. Leave `appsscript.json` and `gallery-config.js` as configured.
3. Choose **Deploy → Manage deployments → Edit → New version → Deploy** on the existing deployment. Keep its URL and **Me / Anyone** settings. Saving the editor alone does not update the deployed service.
4. Reload a test gallery and verify a single original and the complete ZIP using private Drive photos. Extract the ZIP and confirm the photo count and original sizes. Test a typical multi-GB gallery on the devices customers use before announcing the improved delivery.

Publishing the website enables one-file downloads. Updating Apps Script also enables the faster original-read path, binary transfer between browser frames, and reuse of already-opened photos after a fresh authorization/version check. The repository does not deploy the Apps Script project automatically.

## How downloads work

- **Download all photos** immediately starts one ZIP download, with progress, cancel and retry controls on the gallery page. There is no new tab or list of parts. The ZIP stores original photo bytes without recompressing JPEG/PNG/WebP files or reducing quality.
- Up to three originals are fetched concurrently. New thumbnail and full-resolution preview requests pause during the download. The backend avoids repeated original-byte reads and checks the folder once per request batch while retaining file authorization before and after reads.
- Small collections use a capped 64 MiB buffer, then automatically save through the browser. A temporary **Save file again** link is available if the browser blocks automatic saving.
- Larger collections use the browser's file picker when supported (Chrome/Edge on a computer), then write incrementally to that file. Other supported browsers receive a streamed attachment through a worker scoped to `/gallery-download/`. ZIP64 supports archives larger than 4 GiB. The complete gallery is never held in memory.
- Keep the page open until completion. Temporary photo-read failures retry twice; cancelling stops new work, though an already-running Google request can finish in the background. A failed or revoked download is aborted rather than reported as complete. A browser may leave an incomplete file that should be discarded. Retry starts a new archive; partial downloads cannot resume.
- Google still reads each private original through Apps Script and transfers it as base64 to the bridge. This remains a bandwidth/latency constraint, especially for multi-GB galleries. Parallel reads and avoiding compression remove unnecessary work; they do not guarantee a particular real-world transfer rate. No paid infrastructure is added.

## One-time Google setup (photo-folder owner)

1. In the Google account that owns the photo folders, create a blank Google Sheet named **Mallory Jane — Customer Galleries**. Keep its sharing set to **Restricted**. Anyone who can edit this Sheet can edit the bound script, so restrict editing to trusted business owners.
2. Open **Extensions → Apps Script**. Replace `Code.gs` with `apps-script/Code.gs` from this repository.
3. Add an **HTML** file named `Bridge`, and paste `apps-script/Bridge.html` into it.
4. In Apps Script **Project Settings**, enable **Show appsscript.json manifest file in editor**. Replace that file with `apps-script/appsscript.json`. Save all files.
5. Verify `SITE_ORIGIN_` at the top of `Code.gs` is your canonical website origin: `https://www.malloryjanephotography.com`. Do not add a trailing slash. Links generated by the Sheet use this address.
6. Run `onOpen` once from the script editor and reload the Sheet. Open **Photo galleries → Create gallery**. The owner completes any Google authorization prompt. The script requests **read-only Drive access**, access to this bound Sheet, and the ability to show its menu/dialogs. Drive authorization covers the owner's Drive; the public server code narrows all photo reads to an approved gallery. It has no Drive write/sharing permission.
7. Initially use a small folder containing only two or three non-sensitive test JPEGs. Keep the folder **Restricted**, with the script owner able to read it. Create a test gallery through the menu; the Sheet will create a `Galleries` tab and select the customer link.
8. In Apps Script choose **Deploy → New deployment → Web app**. Set **Execute as: Me** and **Who has access: Anyone** (anonymous visitors, not "Anyone with a Google account"). The public endpoint checks secret links before reading photo data. Follow [Google's web app deployment guide](https://developers.google.com/apps-script/guides/web). If the account's organization does not permit anonymous web apps, this setup will need an account/policy decision before it can work.
9. Copy the deployed URL ending in `/exec` into `appsScriptUrl` in `gallery-config.js` in this local copy. This URL is public configuration. Do not put an OAuth token, a customer link, a folder ID or a password in that file.

No customer needs to sign into Google. The owner must authorize and deploy the script. A configured deployment URL alone does not verify private-photo loading or downloads; complete the real-service checks below before launch.

## Test the real service before updating the site

1. In Apps Script **Project Settings → Script Properties**, temporarily add `ALLOW_LOCAL_PREVIEW` with value `true`. This permits only the specific additional parent origin `http://127.0.0.1:4173`.
2. Start the local preview server. Take the test link from the Sheet and replace `https://www.malloryjanephotography.com` with `http://127.0.0.1:4173`. Keep `/gallery.html#...` intact and omit `?demo=1`.
3. Test signed out of Google in a normal browser. Confirm the grid loads, a photo opens, an original saves, and **Download all photos** saves one ZIP containing every original without opening a tab. Extract the ZIP and compare an original's size/hash with its uploaded file. Test a typical edited JPEG, a small collection, a collection over 64 MiB, and a typical multi-GB collection on desktop and mobile browsers. Check cancel and retry. Large downloads require a browser supporting file writing or service workers; if unavailable, the page directs the customer to desktop Chrome/Edge. Google thumbnails can take time to appear after upload; tapping a placeholder still opens an original.
4. Add a new photo to the folder: it should **not** appear until **Refresh selected gallery** is used. Move an approved photo out of the folder: subsequent reads must fail. Revoke the test link and confirm a new page load, preview request and download request fail.
5. Check an altered or missing secret link. It must not display customer metadata or photos. Check that a visitor cannot request a different file merely by substituting its Drive ID.
6. Remove `ALLOW_LOCAL_PREVIEW` when finished. It is read at runtime, so this does not require a new deployment.

If a Google error page or a sign-in prompt appears instead of loading photos, first verify the deployment is `/exec`, **Me / Anyone**, and the configured website origin matches. Test using a signed-out browser. Do not solve an embedding/authentication error by sharing the Drive folder publicly.

## Release and rollback

There is no automatic release step in this work. The repository's owner controls the push that publishes the website:

1. Ensure all runtime files are present in the deployment-connected repository: `gallery.html`, `gallery.css`, `gallery.js`, `gallery-downloads.js`, the configured `gallery-config.js`, `gallery-download/sw.js`, and `vendor/zip.min.js`. Include `vendor/zip.LICENSE` and `vendor/README.md` for dependency licensing and provenance. Preserve the configured deployment URL.
2. Optionally include this documentation, `apps-script/`, `scripts/`, `tests/` and `package.json` for maintenance. None contain private customer data. The `scripts/` mock server is not run by GitHub Pages.
3. Review the exact Git diff. Existing pages, forms, assets, `site.css` and `CNAME` need no edits. Commit and push when ready; the repository's existing deployment will publish the updated page.
4. Visit the **real website** with a test link while signed out. Verify photo previews and downloads again. Then create the first customer gallery.

To roll back the website, revert the gallery release commit through the normal deployment process. Revoke affected links from the private Sheet or archive the Apps Script deployment to stop service immediately. Revoking a gallery never deletes its Drive originals. No downloaded copy can be recalled.

For subsequent backend updates, use **Deploy → Manage deployments → Edit → New version** on the existing deployment to retain its URL. Saving script files alone does not update the deployed version. Sheet menu code runs the current editor version, so keep changes to record formats backward compatible with the deployed reader.

## After each shoot

1. Upload edited JPEG, PNG or WebP photos directly into a dedicated customer folder. Leave sharing **Restricted**. Subfolders, shortcuts, RAW, HEIC, PDF and SVG files are not included.
2. Open the private Sheet and choose **Photo galleries → Create gallery**. Paste the Drive folder link, enter a customer-facing title, and choose how long the link works (90 days by default; 1–365 days allowed).
3. Copy the **Customer link** from the newly created row and send it to the customer through your usual channel. Nothing emails or messages customers automatically.
4. To publish additions/removals, select that row and choose **Refresh selected gallery**. The link and expiry stay the same. Renaming a file is reflected after refresh. Replacing the content of an already-approved file serves its current bytes; this is a snapshot of approved file IDs, not a frozen copy of file versions.
5. To stop access, select the row and choose **Revoke selected gallery**. Create a new gallery to issue a replacement link or renew an expired one. Revocation clears that row's link and frees its manifest storage. Old expired rows should also be revoked to free storage.

Use the menu for changes. Editing cells or deleting a row does not update/revoke its backend record. The Sheet is a private record of deliveries; the script properties are the access-control source of truth.

## Limits and privacy

- Application limits remain 500 photos per gallery and 20 MiB per original. The new complete ZIP can exceed 2 GiB or 4 GiB; the old 20-photo/20-MiB ZIP-part limit no longer limits this button. The legacy backend ZIP endpoint retains its small-part limit for older pages. Oversized originals stop gallery creation with a clear message; export smaller JPEGs or deliver those files separately. These are conservative application limits, not guarantees of Google transfer speed or availability.
- Drive thumbnails load six at a time and 24 photos are rendered initially. Full originals load only when viewed/downloaded. Rapid arrow presses collapse into the latest requested preview. At most three opened originals are retained in memory. Cached originals require fresh authorization and matching file version/size before reuse. No photo data is persisted to localStorage, IndexedDB or a service-worker cache. The download worker only relays bounded chunks to a one-use attachment URL and never receives a gallery secret or Drive credentials.
- Apps Script currently lists a six-minute execution limit, 30 simultaneous executions per user, 9 KB per property value and 500 KB per property store. Other Google/Drive limits can also apply and may change. The manifest is chunked, uses a conservative storage budget, and refuses new publications before filling the store. If traffic outgrows this approach, access may temporarily fail; do not treat this as an unlimited CDN. [Official limits](https://developers.google.com/apps-script/guides/services/quotas).
- The site has no public gallery directory. Secret links are bearer access: anyone who receives or forwards a working link can see and download that gallery. There is no customer identity check or separate password. Expiry/revocation blocks future server reads, including a final recheck during long downloads, but cannot remove bytes already sent to a browser.
- The secret is in the URL fragment, keeping it out of ordinary static-site HTTP requests and referrers. It is sent to Google only in validated bridge messages. Browser history and anyone who copies the complete link can still retain it. The private Sheet intentionally stores working links; backend properties store only their hashes.
- Customer pages omit the site's Meta Pixel, Google Analytics and Clarity recording. They set `no-referrer` and `noindex`. These are privacy measures, not substitutes for server authorization. Gallery titles and filenames are rendered as text, not HTML. Customers' photos, Drive IDs and secret links are never checked into Git.
- The Apps Script bridge is frameable so the existing site can use it, but it exposes only read operations. Parent origin, random per-page channel, response source, allowed method, gallery token and each requested photo are checked. Administration functions end in `_`, which [Google makes inaccessible to `google.script.run`](https://developers.google.com/apps-script/guides/html/communication#private_functions).
- Every photo must be in the published list, still directly in the approved folder, untrashed, and of a supported type. The script never changes Drive sharing. Existing public shares must be removed manually if you want previously shared folders/files to become private.

## Verification record

- Automated tests cover secret validation, expiry/revocation, foreign and unpublished files, moved/trashed/deleted files, unsupported types, byte preservation, ZIP member naming, size limits, refresh, concurrent revocation, Unicode metadata limits, private admin methods, bridge origin/source/channel checks and omission of tracking scripts.
- Download regression tests exercise the real ZIP library, original-byte preservation, CRC verification, duplicate/Unicode names, bounded parallel fetching, write backpressure, native file-picker cancellation, transient retry, revocation/cancellation, the memory cap, and a complete message-channel/worker attachment stream.
- A local browser test downloaded one ZIP from one **Download all photos** click without leaving the gallery. All ten extracted photos matched the public originals by SHA-256 using .NET's ZIP reader. The existing gallery appearance was preserved.
- The opt-in synthetic large-file test streamed 4.50 GiB through the production ZIP writer, verified ZIP64 directory offsets above 4 GiB, and peaked at 155 MiB process memory in the recorded run. It writes to a discard sink; its runtime is not a Google Drive speed measurement or a real browser multi-GB download test.
- **Still required for this update:** redeploy both Apps Script files, measure a typical private Drive collection, and verify desktop/mobile large-file saving. Local tests do not establish live Google throughput or every browser's download behavior. No deployment or repository push is performed by the code changes themselves.

## Files

| File | Purpose |
| --- | --- |
| `gallery.html`, `gallery.css` | Customer gallery interface and responsive styling |
| `gallery.js` | Validated bridge connection, browsing, viewer and downloads |
| `gallery-downloads.js` | Bounded original fetching, ZIP64 streaming, save destinations and retry |
| `gallery-download/sw.js` | Scoped, one-use browser attachment streaming fallback |
| `vendor/zip.min.js`, `vendor/zip.LICENSE`, `vendor/README.md` | Pinned zip.js library, license and verified provenance |
| `gallery-config.js` | Public Apps Script deployment URL |
| `apps-script/Code.gs` | Private Sheet administration and authorized photo reads |
| `apps-script/Bridge.html` | Cross-origin data bridge using Google's supported RPC |
| `apps-script/appsscript.json` | Explicit, restricted authorization scopes |
| `scripts/preview.mjs` | Local sample gallery with no private Drive connection |
| `tests/gallery.test.mjs` | Authorization, lifecycle and transport regression tests |
| `tests/downloads.test.mjs` | Archive integrity, streaming, cancellation and destination tests |
| `tests/large-download-smoke.mjs` | Optional 4.5 GiB ZIP64 and bounded-memory smoke test |

'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const messages = {
    UNAVAILABLE: 'This gallery link is unavailable or has expired. Please contact Mallory for a new link.',
    PHOTO_UNAVAILABLE: 'This photo is no longer available. Please contact Mallory if you need it.',
    TOO_LARGE: 'This original exceeds the gallery’s delivery limit. Please contact Mallory.',
    LARGE_DOWNLOAD: 'This browser could not start a large download. Open this gallery in Chrome or Edge on a computer and try again.',
    GALLERY_CHANGED: 'This gallery changed during the download. Reload the page and try again.',
    TEMPORARY: 'We couldn’t connect to your photos. Please try again in a moment.'
  };
  let photos = [], rendered = 0, current = 0, viewVersion = 0, gallery, request;
  let thumbnailQueue = [], thumbnailRunning = false, downloadBusy = false, previewBusy = false;
  let downloadController, lastDownload;
  const thumbnails = new Map(), originals = new Map(), downloads = new Set();
  const viewer = $('viewer');
  const demo = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('demo') && window.MJ_GALLERY_DEMO;
  const token = location.hash.slice(1);

  const errorMessage = error => messages[error.code] || messages.TEMPORARY;
  function status(message, retry = false) {
    $('status-panel').hidden = false;
    $('status-text').textContent = message;
    $('retry').hidden = !retry;
  }
  function release(map) { for (const value of map.values()) URL.revokeObjectURL(value.url || value); map.clear(); }
  function unavailable() {
    viewVersion++;
    if (viewer.open) viewer.close();
    downloadController?.abort();
    $('gallery-content').hidden = true;
    $('photo-grid').replaceChildren();
    $('viewer-image').removeAttribute('src');
    $('gallery-title').textContent = 'Your photo gallery';
    $('gallery-meta').textContent = '';
    thumbnailQueue = [];
    release(thumbnails); release(originals);
    for (const url of downloads) URL.revokeObjectURL(url);
    downloads.clear();
    status(messages.UNAVAILABLE);
  }
  function makeBlob(data) { return new Blob([MJDownloads.decode(data)], {type: data.mime}); }
  function rememberOriginal(id, data) {
    if (originals.has(id)) URL.revokeObjectURL(originals.get(id).url);
    const blob = new Blob([data.bytes], {type: data.mime});
    const value = {blob, url: URL.createObjectURL(blob), name: data.name, mime: data.mime, version: data.version};
    originals.delete(id); originals.set(id, value);
    while (originals.size > 3) {
      const oldest = originals.keys().next().value;
      URL.revokeObjectURL(originals.get(oldest).url); originals.delete(oldest);
    }
    return value;
  }
  function googleOrigin(origin) {
    try {
      const url = new URL(origin);
      return url.protocol === 'https:' && !url.port && (url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com'));
    } catch { return false; }
  }
  function connect(url) {
    return new Promise((resolve, reject) => {
      const endpoint = new URL(url);
      if (endpoint.origin !== 'https://script.google.com' || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(endpoint.pathname) || endpoint.search || endpoint.hash) {
        reject(new Error('Invalid gallery service URL.')); return;
      }
      const channel = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
      endpoint.searchParams.set('channel', channel);
      endpoint.searchParams.set('origin', location.origin);
      const frame = document.createElement('iframe');
      frame.hidden = true; frame.title = 'Private photo connection'; frame.referrerPolicy = 'no-referrer';
      // The endpoint runs as its owner and permits anonymous visitors. In
      // supporting browsers, isolate this frame (including Google's nested
      // frame/RPC) from the visitor's Google sign-in cookies and storage.
      // Set this before src so the first navigation uses the empty session.
      if ('credentialless' in frame) frame.credentialless = true;
      let source, origin, sequence = 0;
      const pending = new Map();
      const startup = setTimeout(() => {
        window.removeEventListener('message', receive); frame.remove(); reject(new Error('Connection timed out.'));
      }, 30000);
      function receive(event) {
        const data = event.data;
        // The inner Apps Script frame sends the handshake; its source differs
        // from the outer iframe. Pin that source only after checking the nonce.
        if (!googleOrigin(event.origin) || !data || data.channel !== channel) return;
        if (data.type === 'mj-ready' && !source && event.source) {
          source = event.source; origin = event.origin; clearTimeout(startup);
          resolve((method, payload, {signal} = {}) => new Promise((done, fail) => {
            if (signal?.aborted) { fail(new DOMException('Download cancelled', 'AbortError')); return; }
            const id = String(++sequence);
            const cleanup = () => { clearTimeout(timer); pending.delete(id); signal?.removeEventListener('abort', abort); };
            const abort = () => { cleanup(); fail(new DOMException('Download cancelled', 'AbortError')); };
            const timer = setTimeout(() => { cleanup(); fail(Object.assign(new Error(), {code: 'TEMPORARY'})); }, 180000);
            pending.set(id, {done, fail, cleanup});
            signal?.addEventListener('abort', abort, {once: true});
            source.postMessage({type: 'mj-request', channel, id, method, token, payload}, origin);
          }));
        } else if (data.type === 'mj-response' && event.source === source && event.origin === origin && pending.has(data.id)) {
          const call = pending.get(data.id); call.cleanup();
          if (data.result && data.result.ok) call.done(data.result.data);
          else call.fail(Object.assign(new Error(), {code: data.result && data.result.error || 'TEMPORARY'}));
        }
      }
      window.addEventListener('message', receive);
      frame.src = endpoint.href; document.body.append(frame);
    });
  }
  async function api(method, payload = {}, signal) {
    if (!demo && gallery && Date.now() >= Date.parse(gallery.expiresAt)) {
      unavailable(); throw Object.assign(new Error(), {code: 'UNAVAILABLE'});
    }
    try { return await request(method, payload, {signal}); }
    catch (error) { if (error.code === 'UNAVAILABLE') unavailable(); throw error; }
  }
  function renderMore() {
    const batch = photos.slice(rendered, rendered + 24);
    for (const photo of batch) {
      const index = rendered++;
      const card = document.createElement('article'); card.className = 'photo-card';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'photo-button';
      button.setAttribute('aria-label', `View photo ${index + 1}: ${photo.name}`);
      const placeholder = document.createElement('span'); placeholder.textContent = 'Loading your photograph…';
      const img = document.createElement('img'); img.alt = photo.name; img.hidden = true; img.decoding = 'async';
      button.append(placeholder, img); button.addEventListener('click', () => openPhoto(index));
      const caption = document.createElement('div'); caption.className = 'photo-caption';
      const name = document.createElement('span'); name.className = 'filename'; name.textContent = photo.name;
      const number = document.createElement('span'); number.className = 'photo-number'; number.textContent = String(index + 1).padStart(2, '0');
      caption.append(name, number); card.append(button, caption); $('photo-grid').append(card);
      thumbnailQueue.push({photo, img, placeholder});
    }
    $('load-more').hidden = rendered >= photos.length;
    loadThumbnails();
  }
  async function loadThumbnails() {
    if (thumbnailRunning) return;
    thumbnailRunning = true;
    try {
      while (thumbnailQueue.length) {
        if (downloadBusy) return; // Give original downloads priority over thumbnails.
        const batch = thumbnailQueue.splice(0, 6);
        let result;
        try { result = await api('thumbnails', {ids: batch.map(item => item.photo.id)}); }
        catch (error) {
          if (error.code === 'UNAVAILABLE') return;
          // A removed photo must not prevent the other five from loading.
          result = [];
          if (error.code === 'PHOTO_UNAVAILABLE') {
            for (const item of batch) {
              try { result.push(...await api('thumbnails', {ids: [item.photo.id]})); }
              catch (failure) { if (failure.code === 'UNAVAILABLE') return; }
            }
          }
        }
        for (const item of batch) {
          const data = result.find(entry => entry.id === item.photo.id);
          if (!data || (!data.base64 && !data.bytes)) { item.placeholder.textContent = 'Tap to open photograph'; continue; }
          const url = URL.createObjectURL(makeBlob(data)); thumbnails.set(item.photo.id, url);
          item.img.onload = () => { item.img.hidden = false; item.placeholder.hidden = true; };
          item.img.onerror = () => { item.placeholder.textContent = 'Tap to open photograph'; };
          item.img.src = url;
        }
      }
    } finally { thumbnailRunning = false; }
  }
  async function openPhoto(index) {
    current = (index + photos.length) % photos.length;
    const photo = photos[current], version = ++viewVersion;
    const img = $('viewer-image');
    img.removeAttribute('src'); img.alt = photo.name;
    $('viewer-name').textContent = photo.name;
    $('viewer-count').textContent = `${current + 1} / ${photos.length}`;
    $('viewer-status').textContent = 'Loading full-resolution photograph…';
    $('previous-photo').disabled = $('next-photo').disabled = photos.length < 2;
    if (thumbnails.has(photo.id)) img.src = thumbnails.get(photo.id);
    if (!viewer.open) viewer.showModal();
    if (downloadBusy) { $('viewer-status').textContent = 'Full-resolution viewing resumes after your download.'; return; }
    // Rapid arrow presses request only the latest photo after the current read.
    if (previewBusy) return;
    previewBusy = true;
    try {
      const data = await getOriginal(photo);
      if (version !== viewVersion) return;
      img.src = rememberOriginal(photo.id, data).url;
      $('viewer-status').textContent = 'Original resolution';
    } catch (error) { if (version === viewVersion) $('viewer-status').textContent = errorMessage(error); }
    finally {
      previewBusy = false;
      if (viewer.open && version !== viewVersion) openPhoto(current);
    }
  }
  async function getOriginal(photo, signal) {
    const cached = originals.get(photo.id);
    let data;
    if (cached?.version) {
      data = await api('photo', {ids: [photo.id], validateOnly: true}, signal);
      if (data.validated && data.version === cached.version && data.size === cached.blob.size) {
        return {bytes: new Uint8Array(await cached.blob.arrayBuffer()), name: cached.name, mime: cached.mime, version: cached.version};
      }
      // An older deployment ignores validateOnly and returns the original:
      // use that response rather than fetching it a second time.
      if (data.validated) data = null;
    }
    data ||= await api('photo', {ids: [photo.id]}, signal);
    return {...data, bytes: MJDownloads.decode(data), base64: undefined};
  }
  function downloadProgress(text, percent) {
    $('download-progress').textContent = text;
    if (percent !== undefined) $('download-meter').value = percent;
    if (viewer.open) $('viewer-status').textContent = text;
  }
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob); downloads.add(url);
    const link = $('save-download'); link.href = url; link.download = filename; link.hidden = false;
    link.click(); // One native download; no popup, new tab or second required click.
    setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); if (link.href === url) link.hidden = true; }, 120000);
  }
  async function startDownload(selection, archive = true) {
    if (downloadBusy) return;
    lastDownload = {selection, archive};
    downloadBusy = true; downloadController = new AbortController();
    const controller = downloadController, signal = controller.signal;
    const filename = `${MJDownloads.safeName(gallery.title)}-Photos.zip`;
    const total = selection.reduce((sum, photo) => sum + photo.size, 0);
    $('download-panel').hidden = false; $('retry-download').hidden = true; $('save-download').hidden = true;
    $('cancel-download').hidden = false;
    $('download-collection').disabled = $('download-photo').disabled = true;
    downloadProgress(archive ? 'Starting your complete collection…' : 'Downloading your original…', 0);
    let sink;
    try {
      // Selecting a file destination must happen directly within this click.
      if (archive) sink = await MJDownloads.destination({filename, size: total, signal, onCancel: () => controller.abort()});
      if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
      if (archive) {
        const validate = async () => {
          const latest = await api('gallery', {}, signal);
          const allowed = new Set(latest.photos.map(photo => photo.id));
          if (selection.some(photo => !allowed.has(photo.id)) || (gallery.revision && latest.revision && gallery.revision !== latest.revision)) {
            throw Object.assign(new Error(), {code: 'GALLERY_CHANGED'});
          }
        };
        await validate();
        await MJDownloads.collection({photos: selection, destination: sink, getPhoto: getOriginal, validate, signal,
          onProgress: ({completed, bytes}) => downloadProgress(`Downloading ${completed} of ${selection.length} photos · ${(bytes / 1048576).toFixed(1)} MB received`, Math.min(99, completed / selection.length * 100)),
          onRetry: (photo, attempt) => downloadProgress(`Connection interrupted. Retrying ${photo.name} (${attempt}/2)…`)
        });
        if (sink.mode === 'memory') saveBlob(sink.blob(), filename);
        downloadProgress(sink.mode === 'file' ? `Saved ${filename}. All ${selection.length} photos are included.` : `All ${selection.length} photos are in one ZIP. Check your browser’s downloads.`, 100);
      } else {
        const data = await MJDownloads.retry(() => getOriginal(selection[0], signal), {signal});
        if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
        saveBlob(new Blob([data.bytes], {type: data.mime}), data.name);
        downloadProgress('Your original is ready. Check your browser’s downloads.', 100);
      }
    } catch (error) {
      controller.abort();
      await sink?.abort(error).catch(() => {});
      downloadProgress(error.name === 'AbortError' ? 'Download cancelled. No incomplete collection was marked as finished.' : errorMessage(error));
      $('retry-download').hidden = error.code === 'UNAVAILABLE';
    } finally {
      downloadBusy = false; $('cancel-download').hidden = true;
      $('download-collection').disabled = $('download-photo').disabled = false;
      downloadController = null;
      loadThumbnails();
    }
  }
  $('retry').addEventListener('click', () => location.reload());
  $('load-more').addEventListener('click', renderMore);
  $('close-viewer').addEventListener('click', () => viewer.close());
  viewer.addEventListener('close', () => { viewVersion++; $('viewer-image').removeAttribute('src'); });
  viewer.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); openPhoto(current + (event.key === 'ArrowLeft' ? -1 : 1)); }
  });
  $('previous-photo').addEventListener('click', () => openPhoto(current - 1));
  $('next-photo').addEventListener('click', () => openPhoto(current + 1));
  $('download-photo').addEventListener('click', () => startDownload([photos[current]], false));
  $('download-collection').addEventListener('click', () => startDownload(photos));
  $('cancel-download').addEventListener('click', () => downloadController?.abort());
  $('retry-download').addEventListener('click', () => { if (lastDownload) startDownload(lastDownload.selection, lastDownload.archive); });
  window.addEventListener('beforeunload', event => { if (downloadBusy) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('hashchange', () => location.reload());
  async function start() {
    if (!demo && !/^[a-f0-9]{64}$/.test(token)) {
      status('Your photos have their own private link. Open the complete gallery link Mallory sent you to view your collection.'); return;
    }
    if (!demo && !window.MJ_GALLERY_CONFIG?.appsScriptUrl) {
      status('Your gallery is not ready to open yet. Please contact Mallory for help.'); return;
    }
    try {
      request = demo || await connect(window.MJ_GALLERY_CONFIG.appsScriptUrl);
      gallery = await api('gallery'); photos = gallery.photos;
      $('gallery-title').textContent = gallery.title;
      $('gallery-meta').textContent = `${demo ? 'Sample gallery · ' : ''}${photos.length} photographs · Available until ${new Date(gallery.expiresAt).toLocaleDateString(undefined, {month: 'long', day: 'numeric', year: 'numeric'})}`;
      $('photo-count').textContent = photos.length;
      $('status-panel').hidden = true; $('gallery-content').hidden = false;
      if (!photos.length) { status('Your photographs are being prepared. Please check back soon.'); $('gallery-content').hidden = true; return; }
      renderMore();
      setInterval(() => { if (!demo && Date.now() >= Date.parse(gallery.expiresAt)) unavailable(); }, 30000);
    } catch (error) { status(errorMessage(error), error.code !== 'UNAVAILABLE'); }
  }
  start();
})();

'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const messages = {
    UNAVAILABLE: 'This gallery link is unavailable or has expired. Please contact Mallory for a new link.',
    PHOTO_UNAVAILABLE: 'This photo is no longer available. Please contact Mallory if you need it.',
    TOO_LARGE: 'These photos are too large for this download. Try downloading them one at a time.',
    TEMPORARY: 'We couldn’t connect to your photos. Please try again in a moment.'
  };
  let photos = [], rendered = 0, current = 0, viewVersion = 0, gallery, request;
  let thumbnailQueue = [], thumbnailRunning = false, downloadBusy = false, previewBusy = false;
  const thumbnails = new Map(), originals = new Map(), downloads = new Set();
  const viewer = $('viewer'), downloadDialog = $('downloads');
  const demo = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('demo') && window.MJ_GALLERY_DEMO;
  const token = location.hash.slice(1);

  const errorMessage = error => messages[error.code] || messages.TEMPORARY;
  function status(message, retry = false) {
    $('status-panel').hidden = false;
    $('status-text').textContent = message;
    $('retry').hidden = !retry;
  }
  function release(map) { for (const url of map.values()) URL.revokeObjectURL(url); map.clear(); }
  function unavailable() {
    viewVersion++;
    if (viewer.open) viewer.close();
    if (downloadDialog.open) downloadDialog.close();
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
  function makeBlob(data) {
    const binary = atob(data.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], {type: data.mime});
  }
  function rememberOriginal(id, url) {
    if (originals.has(id)) URL.revokeObjectURL(originals.get(id));
    originals.delete(id); originals.set(id, url);
    while (originals.size > 3) {
      const oldest = originals.keys().next().value;
      URL.revokeObjectURL(originals.get(oldest)); originals.delete(oldest);
    }
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
          resolve((method, payload) => new Promise((done, fail) => {
            const id = String(++sequence);
            const timer = setTimeout(() => { pending.delete(id); fail(Object.assign(new Error(), {code: 'TEMPORARY'})); }, 90000);
            pending.set(id, {done, fail, timer});
            source.postMessage({type: 'mj-request', channel, id, method, token, payload}, origin);
          }));
        } else if (data.type === 'mj-response' && event.source === source && event.origin === origin && pending.has(data.id)) {
          const call = pending.get(data.id); clearTimeout(call.timer); pending.delete(data.id);
          if (data.result && data.result.ok) call.done(data.result.data);
          else call.fail(Object.assign(new Error(), {code: data.result && data.result.error || 'TEMPORARY'}));
        }
      }
      window.addEventListener('message', receive);
      frame.src = endpoint.href; document.body.append(frame);
    });
  }
  async function api(method, payload = {}) {
    if (!demo && gallery && Date.now() >= Date.parse(gallery.expiresAt)) {
      unavailable(); throw Object.assign(new Error(), {code: 'UNAVAILABLE'});
    }
    try { return await request(method, payload); }
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
          if (!data || !data.base64) { item.placeholder.textContent = 'Tap to open photograph'; continue; }
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
    // Rapid arrow presses request only the latest photo after the current read.
    if (previewBusy) return;
    previewBusy = true;
    try {
      // Even cached images require a current capability check before reopening.
      if (originals.has(photo.id)) {
        await api('thumbnails', {ids: [photo.id]});
        if (version !== viewVersion) return;
        img.src = originals.get(photo.id);
      } else {
        const data = await api('photo', {ids: [photo.id]});
        if (version !== viewVersion) return;
        const url = URL.createObjectURL(makeBlob(data)); rememberOriginal(photo.id, url); img.src = url;
      }
      $('viewer-status').textContent = 'Original resolution';
    } catch (error) { if (version === viewVersion) $('viewer-status').textContent = errorMessage(error); }
    finally {
      previewBusy = false;
      if (viewer.open && version !== viewVersion) openPhoto(current);
    }
  }
  function groupDownloads(selection) {
    const groups = [];
    let group = [], size = 0;
    for (const photo of selection) {
      if (group.length && (size + photo.size > gallery.maxDownloadBytes || group.length >= gallery.maxDownloadFiles)) {
        groups.push(group); group = []; size = 0;
      }
      group.push(photo); size += photo.size;
    }
    if (group.length) groups.push(group);
    return groups;
  }
  function showDownloads(selection) {
    for (const url of downloads) URL.revokeObjectURL(url);
    downloads.clear(); $('download-parts').replaceChildren(); $('download-progress').textContent = '';
    const groups = groupDownloads(selection);
    $('download-description').textContent = groups.length > 1
      ? `Your collection is split into ${groups.length} small downloads. Save each part for the complete collection.`
      : 'Your original, full-resolution photographs.';
    groups.forEach((group, index) => {
      const row = document.createElement('div'); row.className = 'download-part';
      const label = document.createElement('p'); label.textContent = groups.length > 1 ? `Part ${index + 1} of ${groups.length}` : group.length === 1 ? group[0].name : 'Complete collection';
      const detail = document.createElement('small'); detail.textContent = `${group.length} photo${group.length === 1 ? '' : 's'} · ${(group.reduce((sum, photo) => sum + photo.size, 0) / 1048576).toFixed(1)} MiB${group.length > 1 ? ' · ZIP' : ''}`;
      label.append(detail);
      const prepare = document.createElement('button'); prepare.type = 'button'; prepare.textContent = 'Prepare download';
      const save = document.createElement('a'); save.className = 'save-link'; save.textContent = 'Save file ↓'; save.hidden = true;
      prepare.addEventListener('click', async () => {
        if (downloadBusy) return;
        downloadBusy = true;
        const originalText = prepare.textContent; prepare.textContent = 'Preparing…';
        $('download-parts').querySelectorAll('button').forEach(button => { button.disabled = true; });
        $('download-progress').textContent = 'Preparing your originals. This can take a minute.';
        try {
          const data = await api('download', {ids: group.map(photo => photo.id)});
          // Closing a dialog does not cancel a Google execution; ignore its result.
          if (!downloadDialog.open || !row.isConnected) return;
          const url = URL.createObjectURL(makeBlob(data)); downloads.add(url);
          save.href = url; save.download = group.length > 1 ? `Mallory-Jane-Photos-Part-${index + 1}.zip` : data.name;
          save.hidden = false; prepare.hidden = true;
          $('download-progress').textContent = 'Your file is ready. Choose Save file to download it.';
        } catch (error) { $('download-progress').textContent = errorMessage(error); }
        finally {
          downloadBusy = false; prepare.textContent = originalText;
          $('download-parts').querySelectorAll('button').forEach(button => { button.disabled = false; });
        }
      });
      row.append(label, prepare, save); $('download-parts').append(row);
    });
    downloadDialog.showModal();
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
  $('download-photo').addEventListener('click', () => showDownloads([photos[current]]));
  $('download-collection').addEventListener('click', () => showDownloads(photos));
  $('close-downloads').addEventListener('click', () => downloadDialog.close());
  downloadDialog.addEventListener('close', () => {
    for (const url of downloads) URL.revokeObjectURL(url);
    downloads.clear();
  });
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

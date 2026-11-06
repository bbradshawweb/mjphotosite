'use strict';
// Download helpers are separate from the UI so the actual streaming path can be tested.
(() => {
  const MEMORY_LIMIT = 64 * 1024 * 1024;
  const abortError = () => new DOMException('Download cancelled', 'AbortError');
  const check = signal => { if (signal?.aborted) throw abortError(); };
  const failure = code => Object.assign(new Error(code), {code});

  function decode(data) {
    if (data.bytes instanceof ArrayBuffer) return new Uint8Array(data.bytes);
    if (ArrayBuffer.isView(data.bytes)) return new Uint8Array(data.bytes.buffer, data.bytes.byteOffset, data.bytes.byteLength);
    if (typeof data.base64 !== 'string') throw failure('TEMPORARY');
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(data.base64);
    // Decode in small blocks rather than allocating a second full-size binary string.
    const padding = data.base64.endsWith('==') ? 2 : data.base64.endsWith('=') ? 1 : 0;
    const bytes = new Uint8Array(data.base64.length / 4 * 3 - padding);
    for (let offset = 0, written = 0; offset < data.base64.length; offset += 65536) {
      const block = atob(data.base64.slice(offset, offset + 65536));
      for (let i = 0; i < block.length; i++) bytes[written++] = block.charCodeAt(i);
    }
    return bytes;
  }
  function safeName(value) {
    return String(value).replace(/[\\/\x00-\x1f\x7f<>:"|?*]/g, '-').replace(/^\.+/, '').slice(0, 160) || 'Photograph';
  }
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      check(signal);
      const abort = () => { clearTimeout(timer); reject(abortError()); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
      signal?.addEventListener('abort', abort, {once: true});
    });
  }
  async function retry(read, {signal, onRetry = () => {}, wait = delay}) {
    for (let attempt = 0; ; attempt++) {
      check(signal);
      try { const value = await read(); check(signal); return value; }
      catch (error) {
        if (signal?.aborted) throw abortError();
        if (error.code !== 'TEMPORARY' || attempt >= 2) throw error;
        onRetry(attempt + 1);
        await wait(1000 * 2 ** attempt, signal);
      }
    }
  }
  async function collection({photos, destination, getPhoto, validate, signal: externalSignal, onProgress = () => {}, onRetry = () => {}, concurrency = 3, zipLibrary = globalThis.zip}) {
    const controller = new AbortController(), signal = controller.signal;
    const abort = () => controller.abort();
    if (externalSignal?.aborted) abort();
    externalSignal?.addEventListener('abort', abort, {once: true});
    const writer = new zipLibrary.ZipWriter(destination.stream, {
      level: 0, zip64: true, bufferedWrite: false, useWebWorkers: false, preventClose: true
    });
    const pending = new Map();
    let scheduled = 0, completed = 0, bytes = 0;
    const fill = () => {
      while (!signal?.aborted && scheduled < photos.length && pending.size < concurrency) {
        const index = scheduled++, photo = photos[index];
        // Convert rejections to results immediately so an out-of-order failure
        // cannot become an unhandled rejection while an earlier photo is written.
        pending.set(index, retry(() => getPhoto(photo, signal), {
          signal, onRetry: attempt => onRetry(photo, attempt)
        }).then(value => ({value}), error => ({error})));
      }
    };
    try {
      check(signal); fill();
      for (let index = 0; index < photos.length; index++) {
        check(signal);
        const result = await pending.get(index);
        if (result.error) throw result.error;
        check(signal);
        const photo = result.value;
        if (!(photo.bytes instanceof Uint8Array) || !photo.bytes.length) throw failure('TEMPORARY');
        // A prefix keeps identically named originals distinct in the ZIP.
        const name = `${String(index + 1).padStart(3, '0')}-${safeName(photo.name || photos[index].name)}`;
        await writer.add(name, new zipLibrary.Uint8ArrayReader(photo.bytes), {signal});
        bytes += photo.bytes.length; completed++;
        onProgress({completed, total: photos.length, bytes});
        pending.delete(index);
        fill(); // Never fetch the rest of the album while disk writing is stalled.
      }
      check(signal);
      await validate(); // Revocation or refresh must prevent a successful final save.
      check(signal);
      await writer.close();
      check(signal);
      await destination.close();
      return {completed, bytes};
    } catch (error) {
      controller.abort();
      await destination.abort(error).catch(() => {});
      throw error;
    } finally { externalSignal?.removeEventListener('abort', abort); pending.clear(); }
  }
  function memoryDestination(type) {
    let parts = [], size = 0, closed = false;
    return {
      mode: 'memory',
      stream: new WritableStream({write(chunk) {
        if (closed) throw abortError();
        size += chunk.byteLength;
        if (size > MEMORY_LIMIT) throw failure('LARGE_DOWNLOAD');
        parts.push(chunk.slice());
      }}),
      async close() { closed = true; },
      async abort() { closed = true; parts = []; },
      blob() { const value = new Blob(parts, {type}); parts = []; return value; }
    };
  }
  async function destination({filename, size, signal, onCancel, environment = globalThis}) {
    check(signal);
    if (size <= MEMORY_LIMIT - 1024 * 1024) return memoryDestination('application/zip');
    if (typeof environment.showSaveFilePicker === 'function') {
      // Call before any await to preserve the button's browser user activation.
      const handle = await environment.showSaveFilePicker({suggestedName: filename, types: [{description: 'Photo collection', accept: {'application/zip': ['.zip']}}]});
      check(signal);
      const stream = await handle.createWritable();
      return {mode: 'file', stream, close: () => stream.close(), abort: reason => stream.abort(reason)};
    }
    return serviceWorkerDestination({filename, signal, onCancel, environment});
  }
  async function serviceWorkerDestination({filename, signal, onCancel, environment}) {
    if (!environment.navigator?.serviceWorker) throw failure('LARGE_DOWNLOAD');
    const registration = await environment.navigator.serviceWorker.register('gallery-download/sw.js', {scope: 'gallery-download/'});
    const worker = registration.active || registration.installing || registration.waiting;
    if (!worker) throw failure('LARGE_DOWNLOAD');
    if (worker.state !== 'activated') await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(failure('TEMPORARY')); }, 20000);
      const listener = () => {
        if (worker.state === 'activated') { cleanup(); resolve(); }
        else if (worker.state === 'redundant') { cleanup(); reject(failure('TEMPORARY')); }
      };
      function cleanup() { clearTimeout(timer); worker.removeEventListener('statechange', listener); }
      worker.addEventListener('statechange', listener); listener();
    });
    check(signal);
    const channel = new MessageChannel();
    const id = Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('');
    let resolveReady, rejectReady, resolveWrite, rejectWrite, resolveClose, rejectClose, credit = false, waiting, stopped = false, fault, frame;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const timeout = setTimeout(() => fail(failure('TEMPORARY')), 20000);
    const heartbeat = setInterval(() => worker.postMessage({type: 'keepalive', id}), 10000);
    function clean() { clearTimeout(timeout); clearInterval(heartbeat); signal?.removeEventListener('abort', cancel); channel.port1.close(); }
    function fail(error) {
      if (stopped) return;
      stopped = true; fault = error;
      channel.port1.postMessage({type: 'abort'});
      rejectReady(error); rejectWrite?.(error); rejectClose?.(error); waiting?.reject(error);
      clean(); frame?.remove();
    }
    function cancel() { fail(abortError()); }
    signal?.addEventListener('abort', cancel, {once: true});
    channel.port1.onmessage = event => {
      const message = event.data;
      if (message.type === 'ready') { clearTimeout(timeout); resolveReady(); }
      else if (message.type === 'pull') { credit = true; waiting?.resolve(); waiting = null; }
      else if (message.type === 'ack') { resolveWrite?.(); resolveWrite = rejectWrite = null; }
      else if (message.type === 'closed') { stopped = true; resolveClose?.(); clean(); setTimeout(() => frame?.remove(), 60000); }
      else if (message.type === 'abort') { fail(abortError()); onCancel?.(); }
    };
    worker.postMessage({type: 'download', id, filename}, [channel.port2]);
    await ready; check(signal);
    frame = environment.document.createElement('iframe'); frame.hidden = true; frame.title = 'Photo download'; frame.referrerPolicy = 'no-referrer';
    frame.src = new URL(`gallery-download/${id}`, environment.location.href).href;
    environment.document.body.append(frame);
    const stream = new WritableStream({async write(chunk) {
      // Small chunks plus pull acknowledgements cap both page and worker queues.
      for (let start = 0; start < chunk.length; start += 262144) {
        if (stopped) throw fault || abortError();
        if (!credit) await new Promise((resolve, reject) => { waiting = {resolve, reject}; });
        check(signal); credit = false;
        const bytes = chunk.slice(start, start + 262144);
        await new Promise((resolve, reject) => {
          resolveWrite = resolve; rejectWrite = reject;
          channel.port1.postMessage({type: 'chunk', bytes}, [bytes.buffer]);
        });
      }
    }});
    return {
      mode: 'browser', stream,
      async close() {
        if (stopped) throw fault || abortError();
        await new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; channel.port1.postMessage({type: 'end'}); });
      },
      async abort(error) { fail(error); }
    };
  }
  const exports = {collection, destination, decode, retry, safeName, memoryDestination, MEMORY_LIMIT};
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
  else globalThis.MJDownloads = Object.freeze(exports);
})();

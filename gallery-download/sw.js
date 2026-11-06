'use strict';
// This worker controls only /gallery-download/. It never caches photos, gallery
// tokens or pages. A one-use random URL connects the page to a native download.
const jobs = new Map();
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  const message = event.data;
  if (!message || !/^[a-f0-9]{64}$/.test(message.id || '') || !event.source?.url) return;
  const source = new URL(event.source.url);
  if (source.origin !== self.location.origin || !source.pathname.endsWith('/gallery.html')) return;
  if (message.type === 'keepalive') {
    const job = jobs.get(message.id);
    if (job && job.clientId === event.source.id) job.touch();
    return;
  }
  if (message.type !== 'download' || !event.ports[0] || jobs.has(message.id) || jobs.size >= 8) return;
  const port = event.ports[0];
  let controller, pull, finished = false, timer;
  const job = {clientId: event.source.id, fetched: false};
  const finish = (error, notify = true) => {
    if (finished) return;
    finished = true; clearTimeout(timer); jobs.delete(message.id);
    if (error) controller.error(error); else controller.close();
    pull?.();
    if (notify) port.postMessage({type: error ? 'abort' : 'closed'});
    port.close();
  };
  job.touch = () => { clearTimeout(timer); timer = setTimeout(() => finish(new Error('Download disconnected')), 60000); };
  job.stream = new ReadableStream({
    start(value) { controller = value; },
    pull() { return new Promise(resolve => { pull = resolve; port.postMessage({type: 'pull'}); }); },
    cancel() { finished = true; clearTimeout(timer); jobs.delete(message.id); port.postMessage({type: 'abort'}); pull?.(); port.close(); }
  }, {highWaterMark: 1});
  job.filename = String(message.filename || 'Photos.zip').replace(/[\x00-\x1f\x7f\\/]/g, '-').slice(0, 180);
  port.onmessage = messageEvent => {
    if (finished) return;
    job.touch();
    const data = messageEvent.data;
    if (data.type === 'chunk' && data.bytes instanceof Uint8Array && data.bytes.byteLength <= 262144 && pull) {
      controller.enqueue(data.bytes); const resolve = pull; pull = null; resolve(); port.postMessage({type: 'ack'});
    } else if (data.type === 'end') finish();
    else finish(new Error('Download interrupted'));
  };
  jobs.set(message.id, job); job.touch(); port.postMessage({type: 'ready'});
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url), scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const id = url.pathname.slice(scope.pathname.length);
  if (!/^[a-f0-9]{64}$/.test(id)) return; // Leave worker source and unrelated files alone.
  const job = jobs.get(id);
  if (event.request.method !== 'GET' || !job || job.fetched) {
    event.respondWith(new Response('This download is no longer available.', {status: 404, headers: {'Cache-Control': 'no-store'}})); return;
  }
  job.fetched = true; job.touch();
  event.respondWith(new Response(job.stream, {headers: {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="Photos.zip"; filename*=UTF-8''${encodeURIComponent(job.filename).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16))}`,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
  }}));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const zip = require('../vendor/zip.min.js');
const downloads = require('../gallery-downloads.js');
const photo = (id, name = `Photo ${id}.jpg`) => ({id, name, size: 100});
const options = extra => ({photos: [photo('1'), photo('2')],
  getPhoto: async p => ({bytes: new TextEncoder().encode(`Original ${p.id}`), name: p.name}),
  validate: async () => {}, zipLibrary: zip, ...extra});

test('one ZIP contains every original, with valid CRCs and distinct safe Unicode names', async () => {
  const destination = downloads.memoryDestination('application/zip');
  await downloads.collection(options({photos: [photo('1', '../家族.jpg'), photo('2', '../家族.jpg')], destination}));
  const reader = new zip.ZipReader(new zip.BlobReader(destination.blob()));
  const entries = await reader.getEntries();
  assert.equal(entries.length, 2);
  assert.equal(new Set(entries.map(entry => entry.filename)).size, 2);
  for (const [index, entry] of entries.entries()) {
    assert(!entry.filename.includes('/')); assert(entry.filename.includes('家族'));
    assert.equal(entry.compressionMethod, 0);
    const bytes = await entry.getData(new zip.Uint8ArrayWriter(), {checkSignature: true, useWebWorkers: false});
    assert.equal(new TextDecoder().decode(bytes), `Original ${index + 1}`);
  }
  await reader.close();
});
test('writes stream before the whole album arrives and prefetch remains bounded', async () => {
  let release, blocked = true, requested = 0, writes = 0, active = 0, peak = 0, firstWrite;
  const started = new Promise(resolve => { firstWrite = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const destination = {
    stream: new WritableStream({async write() { writes++; firstWrite(); if (blocked) await gate; }}),
    async close() {}, async abort() {}
  };
  const work = downloads.collection(options({photos: Array.from({length: 25}, (_, i) => photo(String(i))), destination,
    getPhoto: async p => { requested++; active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return {bytes: new Uint8Array(100), name: p.name}; }
  }));
  await started;
  assert.equal(requested, 3); assert.equal(peak, 3); assert(writes > 0);
  blocked = false; release(); await work;
  assert.equal(requested, 25);
});
test('native large-file destination opens directly from the click and closes successfully', async () => {
  let opened = false, closed = false, written = 0;
  const stream = new WritableStream({write(bytes) { written += bytes.length; }, close() { closed = true; }});
  const destinationPromise = downloads.destination({filename: 'Family.zip', size: 3 * 1024 ** 3,
    environment: {showSaveFilePicker(options) { opened = true; assert.equal(options.suggestedName, 'Family.zip'); return Promise.resolve({createWritable: async () => stream}); }}
  });
  assert(opened); // No asynchronous authorization step loses user activation.
  const destination = await destinationPromise;
  await downloads.collection(options({destination}));
  assert.equal(destination.mode, 'file'); assert(closed); assert(written > 0);
});
test('cancelled picker does not fall back to a memory-heavy download', async () => {
  await assert.rejects(downloads.destination({filename:'Photos.zip', size:3*1024**3,
    environment:{showSaveFilePicker:async()=>{throw new DOMException('Cancelled','AbortError');}}
  }), {name:'AbortError'});
});
test('temporary failures retry only the failed read and permanent denials never retry', async () => {
  let calls = 0;
  const value = await downloads.retry(async () => { if (++calls < 3) throw Object.assign(new Error(),{code:'TEMPORARY'}); return 'original'; }, {wait:async()=>{}});
  assert.equal(calls,3); assert.equal(value,'original');
  for (const code of ['UNAVAILABLE','PHOTO_UNAVAILABLE','TOO_LARGE']) {
    calls = 0;
    await assert.rejects(downloads.retry(async()=>{calls++;throw Object.assign(new Error(),{code});},{wait:async()=>{}}),{code});
    assert.equal(calls,1);
  }
});
test('cancel aborts the destination instead of completing a partial archive', async () => {
  const controller = new AbortController(); let closed = 0, aborted = 0;
  const destination = {stream:new WritableStream({write(){}}),async close(){closed++;},async abort(){aborted++;}};
  await assert.rejects(downloads.collection(options({destination, signal:controller.signal,onProgress:()=>controller.abort()})),{name:'AbortError'});
  assert.equal(closed,0); assert.equal(aborted,1);
});
test('revocation at final validation aborts the save', async () => {
  let closed = 0, aborted = 0;
  const destination={stream:new WritableStream({write(){}}),async close(){closed++;},async abort(){aborted++;}};
  await assert.rejects(downloads.collection(options({destination,validate:async()=>{throw Object.assign(new Error(),{code:'UNAVAILABLE'});}})),{code:'UNAVAILABLE'});
  assert.equal(closed,0); assert.equal(aborted,1);
});
test('memory fallback refuses oversized writes rather than buffering a multi-GB album', async () => {
  const destination=downloads.memoryDestination('application/zip');
  const writer=destination.stream.getWriter();
  await assert.rejects(writer.write(new Uint8Array(downloads.MEMORY_LIMIT+1)),{code:'LARGE_DOWNLOAD'});
  await destination.abort();
});
test('base64 and transferred buffers decode to identical bytes', () => {
  const source=Uint8Array.from({length:160001},(_,i)=>i%256);
  assert.deepEqual(downloads.decode({base64:Buffer.from(source).toString('base64')}),source);
  assert.deepEqual(downloads.decode({bytes:source.buffer}),source);
});
test('download worker streams a one-use attachment without caching or leaking a gallery token', async () => {
  const listeners = new Map(), id='c'.repeat(64), scope='https://example.test/gallery-download/';
  const self={location:{origin:'https://example.test'},registration:{scope},addEventListener:(name,fn)=>listeners.set(name,fn)};
  vm.runInNewContext(readFileSync(new URL('../gallery-download/sw.js',import.meta.url),'utf8'),{self,URL,ReadableStream,Response,Uint8Array,setTimeout,clearTimeout});
  const channel=new MessageChannel(), messages=[];
  channel.port1.onmessage=event=>messages.push(event.data);
  const waitFor=async type=>{
    const limit=Date.now()+2000;
    while(!messages.some(message=>message.type===type)){if(Date.now()>limit)throw new Error('Missing worker message: '+type);await new Promise(resolve=>setTimeout(resolve,1));}
  };
  listeners.get('message')({data:{type:'download',id,filename:'Family Photos.zip'},ports:[channel.port2],source:{url:'https://example.test/gallery.html#private-secret',id:'client-1'}});
  await waitFor('ready');
  let response;
  listeners.get('fetch')({request:new Request(scope+id),respondWith:value=>{response=value;}});
  assert.equal(response.status,200);
  assert.match(response.headers.get('Content-Disposition'),/^attachment;/);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  const consumed=response.arrayBuffer(); await waitFor('pull');
  channel.port1.postMessage({type:'chunk',bytes:new Uint8Array([1,2,3])});
  await waitFor('ack'); channel.port1.postMessage({type:'end'}); await waitFor('closed');
  assert.deepEqual(new Uint8Array(await consumed),new Uint8Array([1,2,3]));
  let second;
  listeners.get('fetch')({request:new Request(scope+id),respondWith:value=>{second=value;}});
  assert.equal(second.status,404);
  assert(!JSON.stringify(messages).includes('private-secret')); channel.port1.close();
});

test('large-browser destination and actual worker complete one ZIP through the message channel', async () => {
  const listeners=new Map(), scope='https://example.test/gallery-download/';
  const self={location:{origin:'https://example.test'},registration:{scope},addEventListener:(name,fn)=>listeners.set(name,fn)};
  vm.runInNewContext(readFileSync(new URL('../gallery-download/sw.js',import.meta.url),'utf8'),{self,URL,ReadableStream,Response,Uint8Array,setTimeout,clearTimeout});
  const module={exports:{}};
  vm.runInNewContext(readFileSync(new URL('../gallery-downloads.js',import.meta.url),'utf8'),{
    module,URL,ReadableStream,WritableStream,Uint8Array,ArrayBuffer,Blob,DOMException,AbortController,MessageChannel,crypto,
    setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms); if(ms===60000)timer.unref(); return timer;},clearTimeout,setInterval,clearInterval
  });
  const worker={state:'activated',postMessage(data,ports=[]) {
    listeners.get('message')({data,ports,source:{url:'https://example.test/gallery.html',id:'client-2'}});
  }};
  let saved, frameCount=0;
  const destination=await module.exports.destination({filename:'Complete Gallery.zip',size:3*1024**3,environment:{
    location:{href:'https://example.test/gallery.html'},
    navigator:{serviceWorker:{register:async (path,options)=>{
      assert.equal(path,'gallery-download/sw.js'); assert.equal(options.scope,'gallery-download/'); return {active:worker};
    }}},
    document:{createElement:tag=>{assert.equal(tag,'iframe');return {remove(){}};},body:{append:frame=>{
      frameCount++; assert(frame.hidden); assert(frame.src.startsWith(scope));
      listeners.get('fetch')({request:new Request(frame.src),respondWith:response=>{saved=response.arrayBuffer();}});
    }}}
  }});
  assert.equal(destination.mode,'browser');
  await module.exports.collection(options({destination}));
  const reader=new zip.ZipReader(new zip.Uint8ArrayReader(new Uint8Array(await saved)));
  const entries=await reader.getEntries(); assert.equal(entries.length,2); assert.equal(frameCount,1);
  for(const [index,entry] of entries.entries()){
    const bytes=await entry.getData(new zip.Uint8ArrayWriter(),{checkSignature:true,useWebWorkers:false});
    assert.equal(new TextDecoder().decode(bytes),`Original ${index+1}`);
  }
  await reader.close();
});

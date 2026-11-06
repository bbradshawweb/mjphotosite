import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash, randomUUID, webcrypto} from 'node:crypto';
const root = new URL('../', import.meta.url);
const serverCode = readFileSync(new URL('apps-script/Code.gs', root), 'utf8');
const clientCode = readFileSync(new URL('gallery.js', root), 'utf8');
const TOKEN = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const hash = value => createHash('sha256').update(value).digest('hex');
const iterator = list => { let i = 0; return {hasNext:()=>i < list.length, next:()=>list[i++]}; };
function blob(bytes = Buffer.from('photo bytes'), name = 'sample.jpg', mime = 'image/jpeg') {
  return {getBytes:()=>Array.from(bytes), getName:()=>name, getContentType:()=>mime, setName(value) { name = value; return this; }};
}
function fixture(count = 3) {
  const values = {}, files = new Map();
  const folder = {getId:()=> 'folder_123456789', isTrashed:()=>false, getFiles:()=>iterator([...files.values()].filter(file=>file.parent === folder.getId()))};
  let blobHook = () => {}, lastZipNames = [];
  for (let i = 1; i <= count; i++) files.set(`photo_${i}`, {
    parent:folder.getId(), trashed:false, mime:'image/jpeg', size:100, name:`Photo ${i}.jpg`, bytes:Buffer.from(`original-${i}`),
    getId:()=>`photo_${i}`, getName(){return this.name;}, getSize(){return this.size;}, getMimeType(){return this.mime;},
    isTrashed(){return this.trashed;}, getParents(){return iterator([{getId:()=>this.parent}]);}, getLastUpdated(){return new Date(this.updated || 1735689600000);},
    getThumbnail(){return blob(Buffer.from(`thumbnail-${i}`));}, getBlob(){blobHook(); return blob(this.bytes,this.name,this.mime);}
  });
  const properties = {
    getProperties:()=>({...values}), getProperty:key=>values[key] || null,
    setProperty:(key,value)=>{values[key]=value;}, setProperties:update=>Object.assign(values,update), deleteProperty:key=>delete values[key]
  };
  const context = vm.createContext({
    PropertiesService:{getScriptProperties:()=>properties},
    DriveApp:{getFolderById:id=>{assert.equal(id,folder.getId()); return folder;},getFileById:id=>{if(!files.has(id))throw new Error('private Drive error'); return files.get(id);}},
    LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},
    Utilities:{getUuid:randomUUID, DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},
      computeDigest:(_,value)=>Array.from(createHash('sha256').update(value).digest()),
      base64Encode:bytes=>Buffer.from(bytes).toString('base64'), newBlob:value=>blob(Buffer.from(value)),
      zip:(blobs,name)=>{lastZipNames=blobs.map(value=>value.getName()); return blob(Buffer.from(JSON.stringify(lastZipNames)),name,'application/zip');}}
  });
  vm.runInContext(serverCode, context);
  const publish = (token=TOKEN) => context.publish_(hash(token),folder.getId(),'Family memories',new Date(Date.now()+86400000).toISOString());
  publish();
  const call = (method, ids, token=TOKEN) => context.galleryRequest(method,token,{ids});
  return {context, values, files, folder, publish, call, hook:fn=>{blobHook=fn;}, zipNames:()=>lastZipNames};
}
test('published list is sorted, private and independent of later folder additions', () => {
  const f=fixture(12), response=f.call('gallery');
  assert.equal(response.ok,true); assert.equal(response.data.photos[1].name,'Photo 2.jpg');
  assert.equal(response.data.photos[11].name,'Photo 12.jpg'); assert.equal(response.data.folderId,undefined);
  assert(!JSON.stringify(f.values).includes(TOKEN));
  f.files.set('unpublished', {...f.files.get('photo_1'),getId:()=> 'unpublished'});
  assert.equal(f.call('gallery').data.photos.length,12);
  assert.equal(f.call('photo',['unpublished']).error,'PHOTO_UNAVAILABLE');
});
test('invalid, unknown, expired and revoked capabilities are rejected', () => {
  const f=fixture();
  for (const token of [undefined,null,123,{},'',TOKEN.toUpperCase(),'../secret',OTHER]) assert.equal(f.call('gallery',[],token === undefined ? null : token).error,'UNAVAILABLE');
  const key='gallery:'+hash(TOKEN), record=JSON.parse(f.values[key]);
  record.expiresAt=new Date(Date.now()-1).toISOString(); f.values[key]=JSON.stringify(record);
  assert.equal(f.call('gallery').error,'UNAVAILABLE');
  record.expiresAt='bad date'; f.values[key]=JSON.stringify(record); assert.equal(f.call('gallery').error,'UNAVAILABLE');
  delete f.values[key]; assert.equal(f.call('download',['photo_1']).error,'UNAVAILABLE');
});
test('photo operations cannot read another folder or accept unsupported payloads', () => {
  const f=fixture();
  for (const method of ['thumbnails','photo','download']) {
    assert.equal(f.call(method,['private_file']).error,'PHOTO_UNAVAILABLE');
    for (const ids of [null,'photo_1',[],['photo_1','photo_1'],[{}],Array.from({length:25},(_,i)=>String(i))]) assert.equal(f.call(method,ids).ok,false);
    f.files.get('photo_1').parent='other_folder'; assert.equal(f.call(method,['photo_1']).error,'PHOTO_UNAVAILABLE');
    f.files.get('photo_1').parent=f.folder.getId();
  }
  assert.equal(f.call('createGallery_').error,'UNAVAILABLE');
});
test('trashed, deleted and unsupported files cannot be retrieved', () => {
  const f=fixture(), file=f.files.get('photo_1');
  file.trashed=true; assert.equal(f.call('photo',['photo_1']).error,'PHOTO_UNAVAILABLE'); file.trashed=false;
  file.mime='text/html'; assert.equal(f.call('photo',['photo_1']).error,'PHOTO_UNAVAILABLE'); file.mime='image/jpeg';
  f.folder.isTrashed=()=>true; assert.equal(f.call('photo',['photo_1']).error,'PHOTO_UNAVAILABLE'); f.folder.isTrashed=()=>false;
  f.files.delete('photo_1'); assert.equal(f.call('photo',['photo_1']).error,'PHOTO_UNAVAILABLE');
});
test('original downloads preserve bytes, thumbnails are separate, and missing previews recover', () => {
  const f=fixture(), original=f.call('photo',['photo_1']);
  assert.equal(Buffer.from(original.data.base64,'base64').toString(),'original-1');
  assert.equal(original.data.mime,'image/jpeg');
  assert.equal(Buffer.from(f.call('thumbnails',['photo_1']).data[0].base64,'base64').toString(),'thumbnail-1');
  f.files.get('photo_1').getThumbnail=()=>null;
  assert.equal(f.call('thumbnails',['photo_1']).data[0].base64,null);
});

test('cached-original validation reads no photo bytes and still enforces access', () => {
  const f=fixture(); let reads=0; f.hook(()=>reads++);
  const validate=()=>f.context.galleryRequest('photo',TOKEN,{ids:['photo_1'],validateOnly:true});
  const result=validate();
  assert.equal(result.ok,true); assert.equal(result.data.validated,true);
  assert.equal(result.data.version,1735689600000); assert.equal(result.data.base64,undefined);
  assert.equal(reads,0);
  f.files.get('photo_1').parent='different-folder';
  assert.equal(validate().error,'PHOTO_UNAVAILABLE');
  delete f.values['gallery:'+hash(TOKEN)];
  assert.equal(validate().error,'UNAVAILABLE'); assert.equal(reads,0);
});

test('original is read once and a version change during the read requires a retry', () => {
  const f=fixture(); let reads=0; f.hook(()=>reads++);
  assert.equal(f.call('photo',['photo_1']).ok,true); assert.equal(reads,1);
  f.hook(()=>{f.files.get('photo_1').updated=1735689600001;});
  assert.equal(f.call('photo',['photo_1']).error,'TEMPORARY');
});

test('gallery revision changes on refresh without exposing private record keys', () => {
  const f=fixture(), before=f.call('gallery').data.revision;
  assert.match(before,/^[a-f0-9]{64}$/);
  f.publish(); assert.notEqual(f.call('gallery').data.revision,before);
});
test('ZIP members have safe unique names, even with duplicate filenames', () => {
  const f=fixture(); f.files.get('photo_1').name='../same.jpg'; f.files.get('photo_2').name='../same.jpg';
  const response=f.call('download',['photo_1','photo_2']);
  assert.equal(response.data.mime,'application/zip'); assert.equal(new Set(f.zipNames()).size,2);
  assert(f.zipNames().every(name=>!name.includes('/') && !name.includes('\\') && name.endsWith('.jpg')));
});
test('limits apply to actual current file sizes, not the published metadata', () => {
  const f=fixture(); f.files.get('photo_1').size=21*1048576;
  assert.equal(f.call('photo',['photo_1']).error,'TOO_LARGE');
  f.files.get('photo_1').size=12*1048576; f.files.get('photo_2').size=12*1048576;
  assert.equal(f.call('download',['photo_1','photo_2']).error,'TOO_LARGE');
  f.files.get('photo_1').size=100; f.files.get('photo_1').bytes=Buffer.alloc(21*1048576);
  assert.equal(f.call('photo',['photo_1']).error,'TOO_LARGE');
});
test('revocation or removing a photo during a download blocks the result', () => {
  const f=fixture(); f.hook(()=>delete f.values['gallery:'+hash(TOKEN)]);
  assert.equal(f.call('download',['photo_1']).error,'UNAVAILABLE');
  const g=fixture(); g.hook(()=>{g.files.get('photo_1').parent='somewhere_else';});
  assert.equal(g.call('download',['photo_1']).error,'PHOTO_UNAVAILABLE');
});
test('refresh publishes new photos, removes old photos and cleans old metadata', () => {
  const f=fixture(); const before=Object.keys(f.values).filter(key=>key.startsWith('photos:'));
  f.files.get('photo_1').parent='elsewhere';
  f.files.set('new_photo',{...f.files.get('photo_2'),getId:()=> 'new_photo'}); f.publish();
  assert.equal(f.call('photo',['photo_1']).error,'PHOTO_UNAVAILABLE');
  assert.equal(f.call('photo',['new_photo']).ok,true); assert(before.every(key=>!(key in f.values)));
});
test('an in-progress refresh cannot resurrect a revoked link', () => {
  const f=fixture(); delete f.values['gallery:'+hash(TOKEN)];
  assert.throws(()=>f.context.publish_(hash(TOKEN),f.folder.getId(),'Family',new Date(Date.now()+86400000).toISOString(),true),/revoked/);
  assert.equal(f.call('gallery').error,'UNAVAILABLE');
});
test('publishing excludes non-photo files and enforces album and file limits', () => {
  const f=fixture(); f.files.get('photo_1').mime='image/svg+xml'; f.files.get('photo_2').mime='application/vnd.google-apps.shortcut'; f.publish();
  assert.equal(f.call('gallery').data.photos.length,1);
  f.files.get('photo_3').size=21*1048576; assert.throws(()=>f.publish(),/20 MiB/);
  assert.throws(()=>fixture(501),/500 photos/);
});
test('Unicode manifest chunks stay below Google property limits', () => {
  const f=fixture(40); for(const file of f.files.values()) file.name='家'.repeat(145)+'.jpg'; f.publish();
  for(const value of Object.values(f.values)) assert(Buffer.byteLength(value)<9000);
  assert.match(f.context.newToken_(),/^[a-f0-9]{64}$/);
});
test('only explicitly allowed server functions are public', () => {
  const names=[...serverCode.matchAll(/^function (\w+)\(/gm)].map(match=>match[1]).filter(name=>!name.endsWith('_'));
  assert.deepEqual(names.sort(),['doGet','galleryRequest','onOpen']);
  const manifest=JSON.parse(readFileSync(new URL('apps-script/appsscript.json',root)));
  assert(manifest.oauthScopes.includes('https://www.googleapis.com/auth/drive.readonly'));
  assert(!manifest.oauthScopes.includes('https://www.googleapis.com/auth/drive'));
});
test('deployment permits only the canonical site and explicitly enabled local preview', () => {
  const f=fixture();
  f.context.HtmlService={
    createHtmlOutput:errorPage=>({errorPage}), XFrameOptionsMode:{ALLOWALL:'allow'},
    createTemplateFromFile:()=>({evaluate(){return this;},setTitle(){return this;},setXFrameOptionsMode(){return this;}})
  };
  const get=origin=>f.context.doGet({parameter:{channel:TOKEN,origin}});
  assert.equal(get('https://www.malloryjanephotography.com').parentOrigin,'https://www.malloryjanephotography.com');
  assert(get('https://evil.example').errorPage);
  assert(get('http://127.0.0.1:4173').errorPage);
  f.values.ALLOW_LOCAL_PREVIEW='true';
  assert.equal(get('http://127.0.0.1:4173').parentOrigin,'http://127.0.0.1:4173');
  assert(get('http://localhost:4173').errorPage);
  assert(get('http://127.0.0.1:4173.evil.example').errorPage);
});
test('bridge rejects incorrect origin, window, channel and administration methods', () => {
  const bridge=readFileSync(new URL('apps-script/Bridge.html',root),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace('<?= channel ?>',TOKEN).replace('<?= parentOrigin ?>','https://www.malloryjanephotography.com');
  let receive; const sent=[], calls=[];
  const top={postMessage:(...args)=>sent.push(args)};
  const run={withSuccessHandler(fn){this.success=fn;return this;},withFailureHandler(){return this;},galleryRequest(...args){calls.push(args); this.success({ok:true,data:{}});}};
  vm.runInNewContext(bridge,{window:{top,addEventListener:(_,fn)=>{receive=fn;}},google:{script:{run}}});
  assert.equal(sent[0][1],'https://www.malloryjanephotography.com');
  const valid={source:top,origin:'https://www.malloryjanephotography.com',data:{type:'mj-request',channel:TOKEN,id:'1',method:'gallery',token:OTHER,payload:{}}};
  for(const mutation of [{origin:'https://evil.example'},{source:{}},{data:{...valid.data,channel:OTHER}},{data:{...valid.data,method:'createGallery_'}}]) receive({...valid,...mutation});
  assert.equal(calls.length,0); receive(valid); assert.equal(calls.length,1); assert.equal(calls[0][1],OTHER);
});
for (const credentiallessSupported of [true, false]) test(`website transport isolates supported sessions and pins source/nonce (credentialless: ${credentiallessSupported})`, async () => {
  const elements=new Map(), listeners=new Map(); let iframe;
  const element=()=>({addEventListener(){},remove(){},hidden:false});
  const document={getElementById:id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:()=>{
    const frame=element();
    if(credentiallessSupported) frame.credentialless=false;
    Object.defineProperty(frame,'src',{set(value){
      // Check at navigation, rather than after the cookie-bearing request.
      assert.equal(frame.credentialless,credentiallessSupported ? true : undefined);
      this.url=value;
    },get(){return this.url;}});
    return frame;
  },body:{append:frame=>{iframe=frame;}}};
  const window={addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
  const context=vm.createContext({document,window,location:{hostname:'www.malloryjanephotography.com',search:'',hash:'#'+TOKEN},URL,URLSearchParams,crypto:webcrypto,setTimeout,clearTimeout});
  vm.runInContext(clientCode.replace('  start();','  window.testApi = {connect, googleOrigin};'),context);
  const connection=window.testApi.connect('https://script.google.com/macros/s/deployment_123/exec');
  const url=new URL(iframe.src); assert(!url.href.includes(TOKEN)); const channel=url.searchParams.get('channel');
  assert.match(channel,/^[a-f0-9]{64}$/);
  const sent=[], source={postMessage:(...args)=>sent.push(args)}, receive=listeners.get('message');
  const ready={source,origin:'https://abc-script.googleusercontent.com',data:{type:'mj-ready',channel}};
  receive({...ready,origin:'https://evil.example'}); receive({...ready,data:{...ready.data,channel:OTHER}});
  receive(ready); const request=await connection; const pending=request('gallery',{});
  assert.equal(sent.length,1); assert.equal(sent[0][0].token,TOKEN); assert.equal(sent[0][1],ready.origin);
  const response={source,origin:ready.origin,data:{type:'mj-response',channel,id:'1',result:{ok:true,data:'right response'}}};
  receive({...response,source:{},data:{...response.data,result:{ok:true,data:'forged'}}}); receive(response);
  assert.equal(await pending,'right response');
  assert.equal(window.testApi.googleOrigin('https://script.google.com.evil.example'),false);
});
test('private page excludes tracking, embeds no Drive folder and uses no remote scripts', () => {
  const html=readFileSync(new URL('gallery.html',root),'utf8');
  assert(!/fbq|gtag|clarity\.ms|googletagmanager|connect\.facebook|drive\.google/.test(html));
  assert.match(html,/name="referrer" content="no-referrer"/);
  assert.match(html,/name="robots" content="noindex, nofollow, noarchive"/);
  assert(!/<script[^>]+src="https?:/.test(html));
  assert(!/innerHTML/.test(clientCode));
});

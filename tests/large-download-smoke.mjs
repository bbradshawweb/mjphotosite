// Opt-in integration check: process 4.5 GiB without writing a large file to disk.
// Uses the production ZIP pipeline, not a mock ZIP writer.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const zip = require('../vendor/zip.min.js');
const {collection} = require('../gallery-downloads.js');
const bytes = new Uint8Array(12 * 1024 * 1024);
const photos = Array.from({length:384},(_,i)=>({id:String(i),name:`Photo-${i}.jpg`,size:bytes.length}));
let written=0, zip64Offset=0n, closed=false, peakRss=0;
const started=performance.now();
const destination={
  stream:new WritableStream({write(chunk){
    written+=chunk.byteLength;
    if(chunk.byteLength<131072){
      const buffer=Buffer.from(chunk.buffer,chunk.byteOffset,chunk.byteLength);
      const index=buffer.indexOf(Buffer.from([0x50,0x4b,0x06,0x06]));
      if(index>=0 && index+56<=buffer.length) zip64Offset=buffer.readBigUInt64LE(index+48);
    }
  }}),
  async close(){closed=true;},async abort(){throw new Error('Large archive aborted');}
};
await collection({photos,destination,zipLibrary:zip,getPhoto:async photo=>({bytes,name:photo.name}),validate:async()=>{},onProgress:({completed})=>{
  peakRss=Math.max(peakRss,process.memoryUsage().rss);
  if(completed%64===0) console.log(`Streamed ${completed}/${photos.length} photos; peak process memory ${Math.round(peakRss/1048576)} MiB`);
}});
assert(closed);assert(written>4*1024**3);assert(zip64Offset>0xffffffffn);
assert(peakRss<512*1024**2,'The archive must not accumulate in RAM');
console.log(`PASS: ${(written/1024**3).toFixed(2)} GiB, ZIP64 directory beyond 4 GiB, ${Math.round(peakRss/1048576)} MiB peak process memory, ${((performance.now()-started)/1000).toFixed(1)} seconds (synthetic local data; not a Drive speed benchmark).`);

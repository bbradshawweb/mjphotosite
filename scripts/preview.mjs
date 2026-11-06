// Local-only preview. Demo photos come from the site's existing public portfolio.
// No demo endpoint or credentials are deployed to GitHub Pages.
import http from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {resolve, extname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const assetRoot = process.env.MJ_PREVIEW_ASSET_ROOT ? resolve(process.env.MJ_PREVIEW_ASSET_ROOT) : root;
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.png':'image/png','.jpg':'image/jpeg'};
const paths = Array.from({length:10}, (_, i) => `assets/portfolio/full/carousel/Carousel${i + 1}.jpg`);
const images = await Promise.all(paths.map(async (path, index) => {
  const bytes = await readFile(resolve(assetRoot, path));
  return {id: `demo-${index + 1}`, name: `MJ-${String(index + 1).padStart(3, '0')}.jpg`, mime:'image/jpeg', size:bytes.length, version:1, base64:bytes.toString('base64')};
}));
const demoScript = `window.MJ_GALLERY_DEMO = async (method, payload, {signal} = {}) => {
  const response = await fetch('/__demo', {method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({method,payload})});
  const result = await response.json();
  if (!result.ok) throw Object.assign(new Error(), {code:result.error});
  return result.data;
};`;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (url.pathname === '/__demo.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(demoScript); return; }
    if (url.pathname === '/__demo' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4096) throw new Error('Too much input'); }
      const {method, payload} = JSON.parse(body);
      let data;
      if (method === 'gallery') data = {
        title:'A few favorite moments', expiresAt:new Date(Date.now() + 90 * 86400000).toISOString(),
        photos:images.map(({base64, ...photo}) => photo), maxDownloadBytes:20 * 1048576, maxDownloadFiles:20
      };
      else if (method === 'thumbnails') data = payload.ids.map(id => images.find(image => image.id === id));
      else if (['photo','download'].includes(method) && payload.ids.length === 1) {
        data = images.find(image => image.id === payload.ids[0]);
        if (payload.validateOnly && data) data = {validated:true,version:data.version,size:data.size};
      }
      else {
        // Use an actual uncompressed ZIP so demo download behavior is testable.
        const chosen = payload.ids.map(id => images.find(image => image.id === id));
        if (!chosen.every(Boolean)) throw new Error('Unknown photo');
        data = {name:'Mallory-Jane-Photos.zip',mime:'application/zip',base64:zip(chosen).toString('base64')};
      }
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ok:true,data})); return;
    }
    let path = decodeURIComponent(url.pathname === '/' ? '/gallery.html' : url.pathname);
    if (!/^\/(?:assets\/|(?:gallery(?:-config|-downloads)?\.(?:html|js|css)|vendor\/zip\.min\.js|gallery-download\/sw\.js|index\.html)$)/.test(path)) { res.writeHead(404); res.end('Not found'); return; }
    const servedRoot = path.startsWith('/assets/') ? assetRoot : root;
    const absolute = resolve(servedRoot, '.' + path);
    if (!absolute.startsWith(resolve(servedRoot) + sep) || !(await stat(absolute)).isFile()) { res.writeHead(404); res.end(); return; }
    let body = await readFile(absolute);
    if (path === '/gallery.html' && url.searchParams.has('demo')) body = Buffer.from(body.toString().replace(/<script src="gallery\.js(?:\?[^"<>]*)?"/, match => '<script src="/__demo.js" defer></script>\n  ' + match));
    res.setHeader('Content-Type', mime[extname(absolute)] || 'application/octet-stream'); res.end(body);
  } catch { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'TEMPORARY'})); }
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(chosen) {
  const local = [], central = []; let offset = 0;
  for (const image of chosen) {
    const name = Buffer.from(image.name), bytes = Buffer.from(image.base64, 'base64'), crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4); header.writeUInt32LE(crc,14); header.writeUInt32LE(bytes.length,18); header.writeUInt32LE(bytes.length,22); header.writeUInt16LE(name.length,26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20,4); directory.writeUInt16LE(20,6); directory.writeUInt32LE(crc,16); directory.writeUInt32LE(bytes.length,20); directory.writeUInt32LE(bytes.length,24); directory.writeUInt16LE(name.length,28); directory.writeUInt32LE(offset,42);
    local.push(header,name,bytes); central.push(directory,name); offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(chosen.length,8); end.writeUInt16LE(chosen.length,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
server.listen(4173, '127.0.0.1', () => console.log('Local demo: http://127.0.0.1:4173/gallery.html?demo=1'));

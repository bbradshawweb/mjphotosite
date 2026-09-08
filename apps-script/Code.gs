/* Bound to a PRIVATE Google Sheet. No customer data or tokens belong in Git. */
var SITE_ORIGIN_ = 'https://www.malloryjanephotography.com';
var MAX_BYTES_ = 20 * 1024 * 1024; // Application limit, not a Google guarantee.
var MAX_PHOTOS_ = 500;
var CHUNK_SIZE_ = 8; // Long Unicode filenames still fit Google's 9 KB value limit.
var MIME_TYPES_ = ['image/jpeg', 'image/png', 'image/webp'];
var HEADERS_ = ['Created', 'Gallery title', 'Drive folder', 'Expires (UTC)', 'Status', 'Customer link', 'Gallery ID'];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Photo galleries')
    .addItem('Create gallery', 'createGallery_')
    .addItem('Refresh selected gallery', 'refreshGallery_')
    .addItem('Revoke selected gallery', 'revokeGallery_')
    .addToUi();
}

// The only HTTP endpoint renders a data bridge, never an administration UI.
function doGet(e) {
  var channel = String(e && e.parameter && e.parameter.channel || '');
  if (!/^[a-f0-9]{64}$/.test(channel)) return HtmlService.createHtmlOutput('Open the gallery link supplied by your photographer.');
  var origin = String(e.parameter.origin || SITE_ORIGIN_);
  var localAllowed = origin === 'http://127.0.0.1:4173' && PropertiesService.getScriptProperties().getProperty('ALLOW_LOCAL_PREVIEW') === 'true';
  if (origin !== SITE_ORIGIN_ && !localAllowed) return HtmlService.createHtmlOutput('This gallery address is not configured.');
  var template = HtmlService.createTemplateFromFile('Bridge');
  template.channel = channel;
  template.parentOrigin = origin;
  return template.evaluate().setTitle('Mallory Jane gallery connection')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Every public read checks the capability, expiry and published allowlist.
// Functions ending in _ cannot be called through google.script.run.
function galleryRequest(method, token, payload) {
  try {
    if (['gallery', 'thumbnails', 'photo', 'download'].indexOf(method) === -1) fail_('UNAVAILABLE');
    var gallery = authorize_(token);
    if (method === 'gallery') return {ok: true, data: {
      title: gallery.title, expiresAt: gallery.expiresAt, photos: gallery.photos,
      maxDownloadBytes: MAX_BYTES_, maxDownloadFiles: 20
    }};
    var ids = payload && payload.ids;
    var maximum = method === 'thumbnails' ? 6 : method === 'photo' ? 1 : 20;
    if (!Array.isArray(ids) || !ids.length || ids.length > maximum || new Set(ids).size !== ids.length) fail_('UNAVAILABLE');
    var files = ids.map(function(id) { return authorizedFile_(gallery, id); });
    var data;
    if (method === 'thumbnails') {
      data = files.map(function(file) {
        var blob = file.getThumbnail();
        // Missing previews are recoverable; never silently read a large original.
        if (!blob) return {id: file.getId(), base64: null};
        var bytes = blob.getBytes();
        if (bytes.length > 1024 * 1024 || MIME_TYPES_.indexOf(blob.getContentType()) === -1) return {id: file.getId(), base64: null};
        return {id: file.getId(), mime: blob.getContentType(), base64: Utilities.base64Encode(bytes)};
      });
    } else {
      var total = files.reduce(function(sum, file) { return sum + file.getSize(); }, 0);
      if (total > MAX_BYTES_) fail_('TOO_LARGE');
      var actual = 0;
      var blobs = files.map(function(file, index) {
        var blob = file.getBlob();
        actual += blob.getBytes().length;
        if (actual > MAX_BYTES_) fail_('TOO_LARGE');
        var prefix = files.length > 1 ? String(index + 1).padStart(3, '0') + '-' : '';
        return blob.setName(prefix + safePhotoName_(file.getName(), file.getMimeType()));
      });
      var output = blobs.length === 1 ? blobs[0] : Utilities.zip(blobs, 'Mallory-Jane-Photos.zip');
      var outputBytes = output.getBytes();
      if (outputBytes.length > MAX_BYTES_ + 1024 * 1024) fail_('TOO_LARGE');
      data = {name: output.getName(), mime: files.length > 1 ? 'application/zip' : files[0].getMimeType(), base64: Utilities.base64Encode(outputBytes)};
    }
    // Recheck after a long download, including a refresh/revoke while it ran.
    var current = authorize_(token);
    ids.forEach(function(id) { authorizedFile_(current, id); });
    return {ok: true, data: data};
  } catch (error) {
    // Do not disclose Drive paths, account information, IDs or stack traces.
    var code = error && error.galleryCode;
    return {ok: false, error: ['UNAVAILABLE', 'TOO_LARGE', 'PHOTO_UNAVAILABLE'].indexOf(code) !== -1 ? code : 'TEMPORARY'};
  }
}

function fail_(code) { var error = new Error(code); error.galleryCode = code; throw error; }
function digest_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map(function(byte) { return (byte & 255).toString(16).padStart(2, '0'); }).join('');
}
function newToken_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase(); }
function authorize_(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail_('UNAVAILABLE');
  var all = PropertiesService.getScriptProperties().getProperties();
  var raw = all['gallery:' + digest_(token)];
  if (!raw) fail_('UNAVAILABLE');
  var gallery = JSON.parse(raw);
  if (!gallery.expiresAt || !Number.isFinite(Date.parse(gallery.expiresAt)) || Date.now() >= Date.parse(gallery.expiresAt)) fail_('UNAVAILABLE');
  gallery.photos = [];
  for (var i = 0; i < gallery.chunks; i++) {
    var chunk = all[gallery.prefix + i];
    if (!chunk) fail_('UNAVAILABLE');
    gallery.photos = gallery.photos.concat(JSON.parse(chunk));
  }
  if (!gallery.photos.length) fail_('UNAVAILABLE');
  return gallery;
}
function authorizedFile_(gallery, id) {
  if (typeof id !== 'string' || !gallery.photos.some(function(photo) { return photo.id === id; })) fail_('PHOTO_UNAVAILABLE');
  try {
    var folder = DriveApp.getFolderById(gallery.folderId);
    if (folder.isTrashed()) fail_('PHOTO_UNAVAILABLE');
    var file = DriveApp.getFileById(id);
    if (file.isTrashed() || MIME_TYPES_.indexOf(file.getMimeType()) === -1) fail_('PHOTO_UNAVAILABLE');
    var parents = file.getParents();
    while (parents.hasNext()) if (parents.next().getId() === gallery.folderId) return file;
  } catch (error) { fail_('PHOTO_UNAVAILABLE'); }
  fail_('PHOTO_UNAVAILABLE');
}
function safePhotoName_(name, mime) {
  var clean = String(name).replace(/[\\/\x00-\x1f\x7f<>:"|?*]/g, '-').replace(/^\.+/, '').slice(0, 150) || 'Photo';
  var extensions = {'image/jpeg': /\.jpe?g$/i, 'image/png': /\.png$/i, 'image/webp': /\.webp$/i};
  var suffixes = {'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp'};
  return extensions[mime].test(clean) ? clean : clean + suffixes[mime];
}

// All administration is invoked from the private Sheet menu, never a web call.
function gallerySheet_() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Open the private gallery management Sheet.');
  var sheet = spreadsheet.getSheetByName('Galleries');
  if (!sheet) {
    sheet = spreadsheet.insertSheet('Galleries');
    sheet.appendRow(HEADERS_);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS_.length).setFontWeight('bold').setBackground('#dfe6de');
    sheet.setColumnWidth(2, 220);
    sheet.setColumnWidth(6, 480);
  } else if (sheet.getRange(1, 1, 1, HEADERS_.length).getValues()[0].join('|') !== HEADERS_.join('|')) {
    throw new Error('A different sheet named Galleries exists. Rename it before continuing.');
  }
  return sheet;
}
function prompt_(title, message, defaultValue) {
  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt(title, message, ui.ButtonSet.OK_CANCEL);
  if (result.getSelectedButton() !== ui.Button.OK) return null;
  return result.getResponseText().trim() || defaultValue || '';
}
function folderId_(value) {
  var match = String(value).match(/^(?:https:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/)?([A-Za-z0-9_-]{10,})(?:[?#].*)?$/);
  if (!match) throw new Error('Paste a Google Drive folder link or folder ID.');
  return match[1];
}
function publish_(hash, folderId, title, expiresAt, requireExisting) {
  var folder = DriveApp.getFolderById(folderId);
  if (folder.isTrashed()) throw new Error('This folder is in the trash.');
  var iterator = folder.getFiles();
  var photos = [];
  while (iterator.hasNext()) {
    var file = iterator.next();
    if (file.isTrashed() || MIME_TYPES_.indexOf(file.getMimeType()) === -1) continue;
    if (file.getSize() > MAX_BYTES_) throw new Error('A photo exceeds 20 MiB: ' + file.getName() + '. Export a smaller JPEG or place it outside this delivery folder.');
    photos.push({id: file.getId(), name: safePhotoName_(file.getName(), file.getMimeType()), mime: file.getMimeType(), size: file.getSize()});
    if (photos.length > MAX_PHOTOS_) throw new Error('Use no more than 500 photos per gallery. Split this shoot into multiple galleries.');
  }
  if (!photos.length) throw new Error('No JPEG, PNG or WebP photos were found directly in this folder.');
  photos.sort(function(a, b) { return a.name.localeCompare(b.name, 'en', {numeric: true}) || a.id.localeCompare(b.id); });
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var properties = PropertiesService.getScriptProperties();
    var previous = properties.getProperty('gallery:' + hash);
    if (requireExisting && !previous) throw new Error('This link was revoked while refreshing. Create a new gallery.');
    var prefix = 'photos:' + hash + ':' + Utilities.getUuid() + ':';
    var record = {folderId: folderId, title: title, expiresAt: expiresAt, prefix: prefix, chunks: Math.ceil(photos.length / CHUNK_SIZE_)};
    var update = {};
    for (var i = 0; i < record.chunks; i++) update[prefix + i] = JSON.stringify(photos.slice(i * CHUNK_SIZE_, (i + 1) * CHUNK_SIZE_));
    // Leave headroom beneath Google's 500 KB store and 9 KB value limits.
    var used = Utilities.newBlob(JSON.stringify(properties.getProperties())).getBytes().length;
    var needed = Utilities.newBlob(JSON.stringify(update) + JSON.stringify(record)).getBytes().length;
    if (used + needed > 380000) throw new Error('Gallery storage is nearly full. Revoke old galleries, then try again.');
    try {
      properties.setProperties(update);
      properties.setProperty('gallery:' + hash, JSON.stringify(record));
    } catch (error) {
      Object.keys(update).forEach(function(key) { properties.deleteProperty(key); });
      throw error;
    }
    if (previous) deleteChunks_(properties, JSON.parse(previous));
  } finally { lock.releaseLock(); }
  return photos.length;
}
function deleteChunks_(properties, record) {
  for (var i = 0; i < record.chunks; i++) properties.deleteProperty(record.prefix + i);
}
function sheetText_(value) { return /^[=+@-]/.test(value) ? "'" + value : value; }
function createGallery_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var folderLink = prompt_('Create gallery', 'Paste the edited-photo folder link. Only photos directly in this folder will be included.');
    if (folderLink === null) return;
    var id = folderId_(folderLink);
    var title = prompt_('Gallery title', 'Enter the title your customer will see, for example: The Anderson Family.');
    if (title === null) return;
    if (!title || title.length > 120) throw new Error('Use a gallery title between 1 and 120 characters.');
    var days = prompt_('Link expiry', 'How many days should this link work? Leave blank for 90 days (maximum 365).', '90');
    if (days === null) return;
    if (!/^\d+$/.test(days) || Number(days) < 1 || Number(days) > 365) throw new Error('Enter a whole number of days from 1 to 365.');
    var sheet = gallerySheet_();
    var token = newToken_();
    var hash = digest_(token);
    var expiry = new Date(Date.now() + Number(days) * 86400000).toISOString();
    var count = publish_(hash, id, title, expiry);
    var link = SITE_ORIGIN_ + '/gallery.html#' + token;
    sheet.appendRow([new Date().toISOString(), sheetText_(title), 'https://drive.google.com/drive/folders/' + id, expiry, 'Active', link, hash]);
    sheet.activate();
    sheet.getRange(sheet.getLastRow(), 6).activate();
    ui.alert('Gallery created', count + ' photos are ready. Copy the Customer link from the selected cell. Keep this spreadsheet private.', ui.ButtonSet.OK);
  } catch (error) { ui.alert('Could not create gallery', error.message, ui.ButtonSet.OK); }
}
function selectedGallery_() {
  var sheet = gallerySheet_();
  var range = SpreadsheetApp.getActiveRange();
  if (!range || range.getSheet().getSheetId() !== sheet.getSheetId() || range.getRow() < 2) throw new Error('Select a gallery row in the Galleries tab.');
  var row = range.getRow();
  var hash = String(sheet.getRange(row, 7).getValue());
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Select a valid gallery row.');
  return {sheet: sheet, row: row, hash: hash};
}
function refreshGallery_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var selected = selectedGallery_();
    var raw = PropertiesService.getScriptProperties().getProperty('gallery:' + selected.hash);
    if (!raw) throw new Error('This link has been revoked. Create a new gallery.');
    var record = JSON.parse(raw);
    if (Date.now() >= Date.parse(record.expiresAt)) throw new Error('This link has expired. Create a new gallery.');
    if (ui.alert('Refresh gallery?', 'This will publish the current photos in this folder to everyone with this gallery link. The expiry will stay the same.', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
    var count = publish_(selected.hash, record.folderId, record.title, record.expiresAt, true);
    ui.alert('Gallery refreshed: ' + count + ' photos.');
  } catch (error) { ui.alert(error.message); }
}
function revokeGallery_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var selected = selectedGallery_();
    if (ui.alert('Revoke gallery?', 'This will disable the selected customer link. Photos will remain in Drive.', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var properties = PropertiesService.getScriptProperties();
      var raw = properties.getProperty('gallery:' + selected.hash);
      properties.deleteProperty('gallery:' + selected.hash);
      if (raw) deleteChunks_(properties, JSON.parse(raw));
    } finally { lock.releaseLock(); }
    selected.sheet.getRange(selected.row, 5).setValue('Revoked');
    selected.sheet.getRange(selected.row, 6).clearContent();
    ui.alert('Link revoked. Already downloaded photos cannot be recalled.');
  } catch (error) { ui.alert(error.message); }
}

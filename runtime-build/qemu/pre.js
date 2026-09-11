var LINUXLAB_ONEDRIVE_ROOT = '/linuxlab-onedrive';
function linuxLabAtomicWordIndex(address) {
  var value = Number(address);
  if (!Number.isInteger(value) || value < 0 || (value & 3) !== 0) {
    throw new Error('Invalid Linux Lab control word address');
  }
  return value >>> 2;
}

Module['linuxLabAtomicLoad32'] = function (address) {
  return Atomics.load(HEAP32, linuxLabAtomicWordIndex(address));
};
Module['linuxLabAtomicStore32'] = function (address, value) {
  return Atomics.store(HEAP32, linuxLabAtomicWordIndex(address), value | 0);
};
Module['linuxLabAtomicNotify32'] = function (address) {
  return Atomics.notify(HEAP32, linuxLabAtomicWordIndex(address));
};

Module['preRun'] = Module['preRun'] || [];
Module['preRun'].push(function () {
  var certificate = Module['linuxLabNetworkCert'];
  if (certificate) {
    ensureDirectories('/.wasmenv');
    FS.writeFile('/.wasmenv/proxy.crt', certificate);
  }

});


function ensureDirectories(path) {
  var current = '';
  path.split('/').filter(Boolean).forEach(function (part) {
    current += '/' + part;
    try {
      FS.mkdir(current);
    } catch (error) {
      if (!error || error.errno !== 20) throw error;
    }
  });
}

Module['linuxLabOneDriveBridge'] = (function () {
  var GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
  var SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
  var UPLOAD_CHUNK = 10 * 320 * 1024;
  var META_TTL_MS = 2000;
  var metadata = new Map();
  var dirty = new Map();
  var fdPaths = new Map();

  function normalize(path) {
    var parts = [];
    String(path || '.').replace(/\\/g, '/').split('/').forEach(function (raw) {
      if (!raw || raw === '.') return;
      if (raw === '..') { parts.pop(); return; }
      parts.push(raw);
    });
    return '/' + parts.join('/');
  }
  function localPath(path) {
    var remote = normalize(path);
    return remote === '/' ? LINUXLAB_ONEDRIVE_ROOT : LINUXLAB_ONEDRIVE_ROOT + remote;
  }

  function basename(path) {
    var remote = normalize(path);
    return remote === '/' ? '' : remote.slice(remote.lastIndexOf('/') + 1);
  }

  function parentPath(path) {
    var remote = normalize(path);
    if (remote === '/') return '/';
    var offset = remote.lastIndexOf('/');
    return offset <= 0 ? '/' : remote.slice(0, offset);
  }

  function itemUrl(path, suffix) {
    var remote = normalize(path);
    suffix = suffix || '';
    if (remote === '/') return GRAPH_ROOT + '/me/drive/root' + suffix;
    var encoded = remote.slice(1).split('/').map(encodeURIComponent).join('/');
    var separator = suffix.charAt(0) === '/' ? ':' : '';
    return GRAPH_ROOT + '/me/drive/root:/' + encoded + separator + suffix;
  }

  function token() {
    try {
      var getter = Module['_linuxlab_get_onedrive_token'];
      if (typeof getter !== 'function') return '';
      var address = getter();
      return address ? UTF8ToString(address).trim() : '';
    } catch (_) {
      return '';
    }
  }

  function errnoForStatus(status) {
    if (status === 401 || status === 403) return 13;
    if (status === 404) return 2;
    if (status === 409 || status === 412) return 17;
    if (status === 400 || status === 416) return 22;
    return 5;
  }

  function failure(status, message) {
    var error = new Error(message || ('OneDrive request failed with HTTP ' + status));
    error.errno = errnoForStatus(status);
    return error;
  }

  function request(method, url, options) {
    options = options || {};
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, false);
    if (options.binary) xhr.responseType = 'arraybuffer';
    if (options.auth !== false) {
      var accessToken = token();
      if (!accessToken) throw failure(401, 'OneDrive session is unavailable');
      xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
    }
    if (options.contentType) xhr.setRequestHeader('Content-Type', options.contentType);
    if (options.range) xhr.setRequestHeader('Range', options.range);
    if (options.contentRange) xhr.setRequestHeader('Content-Range', options.contentRange);
    xhr.send(options.body === undefined ? null : options.body);
    if (xhr.status < 200 || xhr.status >= 300) {
      var detail = '';
      try { detail = xhr.responseText || ''; } catch (_) {}
      throw failure(xhr.status, detail || undefined);
    }
    return xhr;
  }

  function requestJson(method, url, options) {
    var xhr = request(method, url, options);
    return xhr.responseText ? JSON.parse(xhr.responseText) : {};
  }

  function remember(path, item) {
    var remote = normalize(path);
    var value = {
      id: item.id || '',
      name: item.name || basename(remote),
      size: Number(item.size || 0),
      directory: !!item.folder,
      modifiedAt: Date.parse(item.lastModifiedDateTime || '') || Date.now(),
      expiresAt: Date.now() + META_TTL_MS,
    };
    metadata.set(remote, value);
    return value;
  }
  function getItem(path, force) {
    var remote = normalize(path);
    var cached = metadata.get(remote);
    if (!force && cached && cached.expiresAt > Date.now()) return cached;
    return remember(remote, requestJson('GET', itemUrl(remote)));
  }

  function exists(path) {
    try { FS.lstat(path); return true; } catch (_) { return false; }
  }

  function isDirectory(path) {
    try { return FS.isDir(FS.lstat(path).mode); } catch (_) { return false; }
  }

  function removeLocal(path) {
    if (!exists(path)) return;
    if (isDirectory(path)) {
      FS.readdir(path).forEach(function (name) {
        if (name !== '.' && name !== '..') removeLocal(path + '/' + name);
      });
      FS.rmdir(path);
    } else {
      FS.unlink(path);
    }
  }

  function hydrate(path, item) {
    var remote = normalize(path);
    var absolute = localPath(remote);
    var parent = absolute.slice(0, absolute.lastIndexOf('/')) || '/';
    ensureDirectories(parent);
    var entry = remember(remote, item);
    if (entry.directory) {
      if (exists(absolute) && !isDirectory(absolute)) removeLocal(absolute);
      if (!exists(absolute)) FS.mkdir(absolute);
    } else {
      if (exists(absolute) && isDirectory(absolute)) removeLocal(absolute);
      if (!exists(absolute)) FS.writeFile(absolute, new Uint8Array(0));
    }
    return entry;
  }

  function ensurePath(path) {
    try {
      var remote = normalize(path);
      if (remote === '/') {
        ensureDirectories(LINUXLAB_ONEDRIVE_ROOT);
        getItem('/', false);
        return 0;
      }
      var item = requestJson('GET', itemUrl(remote));
      hydrate(remote, item);
      return 0;
    } catch (error) {
      console.error('Linux Lab OneDrive stat failed', error);
      return -(error.errno || 5);
    }
  }

  function refreshDir(path) {
    try {
      var remote = normalize(path);
      var directory = getItem(remote, true);
      if (!directory.directory && remote !== '/') throw failure(400, 'Not a OneDrive directory');
      var wanted = new Set();
      var next = itemUrl(remote, '/children');
      while (next) {
        var page = requestJson('GET', next);
        (page.value || []).forEach(function (item) {
          var child = remote === '/' ? '/' + item.name : remote + '/' + item.name;
          wanted.add(item.name);
          hydrate(child, item);
        });
        next = page['@odata.nextLink'] || '';
      }

      var absolute = localPath(remote);
      ensureDirectories(absolute);
      FS.readdir(absolute).forEach(function (name) {
        if (name === '.' || name === '..' || wanted.has(name)) return;
        var child = remote === '/' ? '/' + name : remote + '/' + name;
        if (!dirty.has(child)) removeLocal(absolute + '/' + name);
      });
      return 0;
    } catch (error) {
      console.error('Linux Lab OneDrive directory refresh failed', error);
      return -(error.errno || 5);
    }
  }

  function size(path) {
    try {
      var remote = normalize(path);
      var pending = dirty.get(remote);
      return pending ? pending.byteLength : getItem(remote, false).size;
    } catch (_) { return -1; }
  }

  function mtime(path) {
    try { return getItem(normalize(path), false).modifiedAt; } catch (_) { return -1; }
  }

  function track(fd, path) {
    fdPaths.set(fd, normalize(path));
  }

  function untrack(fd) {
    fdPaths.delete(fd);
  }

  function hasFd(fd) {
    return fdPaths.has(fd);
  }

  function pathForFd(fd) {
    var path = fdPaths.get(fd);
    if (!path) throw failure(404, 'OneDrive file descriptor is unknown');
    return path;
  }

  function download(path, range) {
    var remote = normalize(path);
    var options = { binary: true };
    if (range) options.range = range;
    var xhr = request('GET', itemUrl(remote, '/content'), options);
    return {
      bytes: new Uint8Array(xhr.response || new ArrayBuffer(0)),
      partial: xhr.status === 206,
    };
  }

  function loadDirty(path) {
    var remote = normalize(path);
    var pending = dirty.get(remote);
    if (pending) return pending;
    var item = getItem(remote, false);
    if (item.directory) throw failure(400, 'Cannot write a OneDrive directory');
    pending = item.size > 0 ? download(remote, '').bytes : new Uint8Array(0);
    dirty.set(remote, pending);
    return pending;
  }

  function pread(fd, offset, bytes, dest) {
    try {
      var path = pathForFd(fd);
      var start = Math.trunc(offset);
      if (start < 0 || bytes < 0) throw failure(400, 'Invalid OneDrive read range');
      var pending = dirty.get(path);
      if (pending) {
        if (start >= pending.byteLength) return 0;
        var local = pending.subarray(start, Math.min(pending.byteLength, start + bytes));
        HEAPU8.set(local, dest);
        return local.byteLength;
      }
      var item = getItem(path, false);
      if (start >= item.size || bytes === 0) return 0;
      var end = Math.min(item.size, start + bytes) - 1;
      var response = download(path, 'bytes=' + start + '-' + end);
      var value = response.bytes;
      if (!response.partial && start > 0) value = value.subarray(start, start + bytes);
      if (value.byteLength > bytes) value = value.subarray(0, bytes);
      HEAPU8.set(value, dest);
      return value.byteLength;
    } catch (error) {
      console.error('Linux Lab OneDrive read failed', error);
      return -(error.errno || 5);
    }
  }

  function pwrite(fd, offset, bytes, src) {
    try {
      var path = pathForFd(fd);
      var start = Math.trunc(offset);
      if (start < 0 || bytes < 0) throw failure(400, 'Invalid OneDrive write range');
      var current = loadDirty(path);
      var required = start + bytes;
      var next = current;
      if (required > current.byteLength) {
        next = new Uint8Array(required);
        next.set(current);
      } else {
        next = current.slice();
      }
      next.set(HEAPU8.subarray(src, src + bytes), start);
      dirty.set(path, next);
      var item = getItem(path, false);
      item.size = next.byteLength;
      item.modifiedAt = Date.now();
      item.expiresAt = Date.now() + META_TTL_MS;
      metadata.set(path, item);
      return bytes;
    } catch (error) {
      console.error('Linux Lab OneDrive write failed', error);
      return -(error.errno || 5);
    }
  }

  function upload(path, data) {
    var remote = normalize(path);
    var item;
    if (data.byteLength <= SIMPLE_UPLOAD_LIMIT) {
      var xhr = request('PUT', itemUrl(remote, '/content'), {
        contentType: 'application/octet-stream',
        body: data,
      });
      item = xhr.responseText ? JSON.parse(xhr.responseText) : requestJson('GET', itemUrl(remote));
    } else {
      var session = requestJson('POST', itemUrl(remote, '/createUploadSession'), {
        contentType: 'application/json',
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace', name: basename(remote) } }),
      });
      var completed = null;
      for (var start = 0; start < data.byteLength; start += UPLOAD_CHUNK) {
        var end = Math.min(data.byteLength, start + UPLOAD_CHUNK);
        var part = data.slice(start, end);
        var chunkXhr = request('PUT', session.uploadUrl, {
          auth: false,
          contentRange: 'bytes ' + start + '-' + (end - 1) + '/' + data.byteLength,
          body: part,
        });
        if (chunkXhr.status !== 202 && chunkXhr.responseText) completed = JSON.parse(chunkXhr.responseText);
      }
      item = completed || requestJson('GET', itemUrl(remote));
    }
    remember(remote, item);
    dirty.delete(remote);
  }

  function flushPath(path) {
    var remote = normalize(path);
    var pending = dirty.get(remote);
    if (!pending) return;
    upload(remote, pending);
  }

  function flushFd(fd) {
    try {
      flushPath(pathForFd(fd));
      return 0;
    } catch (error) {
      console.error('Linux Lab OneDrive flush failed', error);
      return -(error.errno || 5);
    }
  }

  function createFile(path) {
    try {
      var remote = normalize(path);
      var xhr = request('PUT', itemUrl(remote, '/content'), {
        contentType: 'application/octet-stream',
        body: new Uint8Array(0),
      });
      var item = xhr.responseText ? JSON.parse(xhr.responseText) : requestJson('GET', itemUrl(remote));
      remember(remote, item);
      dirty.delete(remote);
      return 0;
    } catch (error) {
      console.error('Linux Lab OneDrive create failed', error);
      return -(error.errno || 5);
    }
  }

  function truncate(path, size) {
    try {
      var remote = normalize(path);
      var length = Math.trunc(size);
      if (length < 0 || !Number.isSafeInteger(length)) throw failure(400, 'Invalid OneDrive file size');
      var item = getItem(remote, false);
      if (item.directory) throw failure(400, 'Cannot truncate a OneDrive directory');
      var current = dirty.get(remote);
      if (!current) {
        var preserved = Math.min(item.size, length);
        if (preserved > 0) {
          var response = download(remote, 'bytes=0-' + (preserved - 1));
          current = response.bytes;
          if (current.byteLength > preserved) current = current.subarray(0, preserved);
        } else {
          current = new Uint8Array(0);
        }
      }
      var next = new Uint8Array(length);
      next.set(current.subarray(0, Math.min(current.byteLength, length)));
      dirty.set(remote, next);
      item.size = length;
      item.modifiedAt = Date.now();
      item.expiresAt = Date.now() + META_TTL_MS;
      metadata.set(remote, item);
      return 0;
    } catch (error) {
      console.error('Linux Lab OneDrive truncate failed', error);
      return -(error.errno || 5);
    }
  }

  function mkdir(path) {
    try {
      var remote = normalize(path);
      var parent = parentPath(remote);
      var item = requestJson('POST', itemUrl(parent, '/children'), {
        contentType: 'application/json',
        body: JSON.stringify({ name: basename(remote), folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
      });
      remember(remote, item);
      metadata.delete(parent);
      return 0;
    } catch (error) {
      console.error('Linux Lab OneDrive mkdir failed', error);
      return -(error.errno || 5);
    }
  }
  function invalidateSubtree(path) {
    var remote = normalize(path);
    Array.from(metadata.keys()).forEach(function (key) {
      if (key === remote || key.indexOf(remote + '/') === 0) metadata.delete(key);
    });
  }

  function remove(path) {
    try {
      var remote = normalize(path);
      if (remote === '/') throw failure(400, 'Cannot remove OneDrive root');
      var item = getItem(remote, true);
      if (item.directory) {
        var page = requestJson('GET', itemUrl(remote, '/children?$top=1&$select=id'));
        if (Array.isArray(page.value) && page.value.length > 0) {
          var notEmpty = failure(409, 'OneDrive directory is not empty');
          notEmpty.errno = 39;
          throw notEmpty;
        }
      }
      request('DELETE', GRAPH_ROOT + '/me/drive/items/' + encodeURIComponent(item.id));
      dirty.delete(remote);
      invalidateSubtree(remote);
      metadata.delete(parentPath(remote));
      return 0;
    } catch (error) {
      console.error('Linux Lab OneDrive remove failed', error);
      return -(error.errno || 5);
    }
  }

  function repathState(from, to) {
    var source = normalize(from);
    var destination = normalize(to);
    Array.from(metadata.entries()).forEach(function (entry) {
      var key = entry[0];
      if (key !== source && key.indexOf(source + '/') !== 0) return;
      metadata.delete(key);
      metadata.set(destination + key.slice(source.length), entry[1]);
    });
    Array.from(dirty.entries()).forEach(function (entry) {
      var key = entry[0];
      if (key !== source && key.indexOf(source + '/') !== 0) return;
      dirty.delete(key);
      dirty.set(destination + key.slice(source.length), entry[1]);
    });
    Array.from(fdPaths.entries()).forEach(function (entry) {
      var key = entry[1];
      if (key === source || key.indexOf(source + '/') === 0) {
        fdPaths.set(entry[0], destination + key.slice(source.length));
      }
    });
  }

  function rename(from, to) {
    try {
      var source = normalize(from);
      var destination = normalize(to);
      var item = getItem(source, true);
      var parent = getItem(parentPath(destination), true);
      flushPath(source);
      var moved = requestJson('PATCH', GRAPH_ROOT + '/me/drive/items/' + encodeURIComponent(item.id), {
        contentType: 'application/json',
        body: JSON.stringify({ name: basename(destination), parentReference: { id: parent.id } }),
      });
      repathState(source, destination);
      remember(destination, moved);
      metadata.delete(parentPath(source));
      metadata.delete(parentPath(destination));
      return 0;
    } catch (error) {
      console.error('Linux Lab OneDrive rename failed', error);
      return -(error.errno || 5);
    }
  }

  function fdSize(fd) {
    try { return size(pathForFd(fd)); } catch (_) { return -1; }
  }

  function fdMtime(fd) {
    try { return mtime(pathForFd(fd)); } catch (_) { return -1; }
  }

  function reset() {
    metadata.clear();
    dirty.clear();
    fdPaths.clear();
  }

  return {
    ensurePath: ensurePath,
    refreshDir: refreshDir,
    size: size,
    mtime: mtime,
    track: track,
    untrack: untrack,
    hasFd: hasFd,
    fdSize: fdSize,
    fdMtime: fdMtime,
    pread: pread,
    pwrite: pwrite,
    flushFd: flushFd,
    createFile: createFile,
    truncate: truncate,
    mkdir: mkdir,
    remove: remove,
    rename: rename,
    reset: reset,
  };
})();

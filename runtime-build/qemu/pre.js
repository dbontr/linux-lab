Module['preRun'] = Module['preRun'] || [];
Module['preRun'].push(function () {
  var media = Module['linuxLabMedia'];
  if (media) {
    ensureDirectory('/media');
    FS.mount(WORKERFS, { files: [media] }, '/media');
  }

  var certificate = Module['linuxLabNetworkCert'];
  if (certificate) {
    ensureDirectory('/.wasmenv');
    FS.writeFile('/.wasmenv/proxy.crt', certificate);
  }
});

function ensureDirectory(path) {
  try {
    FS.mkdir(path);
  } catch (error) {
    if (!error || error.errno !== 20) throw error;
  }
}

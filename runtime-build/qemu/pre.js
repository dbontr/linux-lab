Module['preRun'] = Module['preRun'] || [];
Module['preRun'].push(function () {
  var certificate = Module['linuxLabNetworkCert'];
  if (!certificate) return;

  ensureDirectory('/.wasmenv');
  FS.writeFile('/.wasmenv/proxy.crt', certificate);
});

function ensureDirectory(path) {
  try {
    FS.mkdir(path);
  } catch (error) {
    if (!error || error.errno !== 20) throw error;
  }
}

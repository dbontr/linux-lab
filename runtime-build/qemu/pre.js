Module['preRun'] = Module['preRun'] || [];
Module['preRun'].push(function () {
  var media = Module['linuxLabMedia'];
  if (!media) return;
  try {
    FS.mkdir('/media');
  } catch (error) {
    if (!error || error.errno !== 20) throw error;
  }
  FS.mount(WORKERFS, { files: [media] }, '/media');
});

'use strict'
// Loaded with `node --require` into the Mac packaging step only (scripts/build-macos-test.cjs); never part of the app.
//
// The macOS signer looks at every file of the app at once to find the binaries. With the ~19,000 TeX files inside the
// compile helper bundle that needs more simultaneously open files than some machines allow: the first release build on
// the GitHub runner stopped with "EMFILE: too many open files". graceful-fs makes an open() that hits the limit wait
// and try again when another file is closed, so the limit only slows the step down. It has to be applied before the
// signer's file reader is loaded, because that module keeps its own reference to fs.open.
require('graceful-fs').gracefulify(require('node:fs'))

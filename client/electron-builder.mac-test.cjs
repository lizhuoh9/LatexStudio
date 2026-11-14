// Local macOS editing-test artifacts only. Ad-hoc signing is NOT Developer ID/notarization.
const { build } = require('./package.json')
module.exports = {
  ...build,
  directories: { ...build.directories, output: 'release/macos-test' },
  artifactName: 'LatexStudio-${version}-mac-${arch}-test.${ext}',
  mac: { ...build.mac, target: ['zip'], identity: '-', notarize: false,
    entitlements: 'resources/macos-test.entitlements.plist', entitlementsInherit: 'resources/macos-test.entitlements.plist' }
}

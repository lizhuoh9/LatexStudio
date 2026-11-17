// Local macOS editing-test artifacts only. Ad-hoc signing is NOT Developer ID/notarization.
const { build } = require('./package.json')
module.exports = {
  ...build,
  directories: { ...build.directories, output: 'release/macos-test' },
  artifactName: 'LatexStudio-${version}-mac-${arch}-test.${ext}',
  // A DMG (drag to Applications) for the building Mac's CPU; no application ZIP. Unsigned downloads still need the user's one-time
  // "Open Anyway" in System Settings: only Developer ID signing plus notarization removes that prompt.
  mac: { ...build.mac, target: ['dmg'], identity: '-', notarize: false,
    entitlements: 'resources/macos-test.entitlements.plist', entitlementsInherit: 'resources/macos-test.entitlements.plist' }
}

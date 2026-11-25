// Local macOS editing-test artifacts only. Ad-hoc signing is NOT Developer ID/notarization.
const { build } = require('./package.json')
const { macTexResources } = require('./scripts/mac-tex-resources.cjs')
// Empty unless the compile helper bundle with the TinyTeX tree inside it is present (scripts/build-macos-test.cjs stages
// TinyTeX and runs resources/darwin/compiler/assemble.sh when the source carries the release pins). Packaging it does
// not enable compilation: the app's own release pins decide.
const tex = macTexResources()
module.exports = {
  ...build,
  directories: { ...build.directories, output: 'release/macos-test' },
  artifactName: 'LatexStudio-${version}-mac-${arch}-test.${ext}',
  // A DMG (drag to Applications) for the building Mac's CPU; no application ZIP. Unsigned downloads still need the user's one-time
  // "Open Anyway" in System Settings: only Developer ID signing plus notarization removes that prompt.
  mac: { ...build.mac, target: ['dmg'], identity: '-', notarize: false,
    extraResources: [...build.mac.extraResources, ...tex.extraResources],
    ...(tex.signIgnore.length ? { signIgnore: tex.signIgnore } : {}),
    entitlements: 'resources/macos-test.entitlements.plist', entitlementsInherit: 'resources/macos-test.entitlements.plist' }
}

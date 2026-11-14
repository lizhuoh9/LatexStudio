const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
function renderReleaseNotes(template, tag) {
  if (typeof template !== 'string' || !template.includes('{{VERSION}}') || typeof tag !== 'string' ||
    !/^v(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/.test(tag)) throw new Error('Invalid release notes/version input')
  return template.replaceAll('{{VERSION}}', tag.slice(1))
}
module.exports = { renderReleaseNotes }
if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected one version tag')
    process.stdout.write(renderReleaseNotes(readFileSync(resolve(__dirname, '../../docs/RELEASE-NOTES.md'), 'utf8'), process.argv[2]))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}

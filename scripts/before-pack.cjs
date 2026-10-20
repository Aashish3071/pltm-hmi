/**
 * electron-builder beforePack hook (used with npmRebuild: false).
 *
 * Only better-sqlite3 needs a binary built for the target platform and
 * Electron ABI; it is downloaded prebuilt, never compiled here. serialport
 * ships Node-API prebuilds for every platform, but @electron/rebuild does not
 * recognise their file naming and tries to compile it from source — impossible
 * when building the Windows installer on macOS — so electron-builder's own
 * rebuild is disabled and this hook rebuilds the one module that needs it.
 * `npm run dist:win` restores the host build afterwards.
 */
const { rebuild } = require('@electron/rebuild')
const { Arch } = require('builder-util')

exports.default = async function beforePack(context) {
  await rebuild({
    buildPath: context.packager.projectDir,
    electronVersion: require('electron/package.json').version,
    platform: context.electronPlatformName,
    arch: Arch[context.arch],
    onlyModules: ['better-sqlite3'],
    force: true
  })
  console.log(`  • prepared better-sqlite3 for ${context.electronPlatformName}-${Arch[context.arch]}`)
}

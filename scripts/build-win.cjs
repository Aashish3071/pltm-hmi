/**
 * Builds the Windows installer. electron-builder's bundled NSIS compiler is an
 * Intel-only macOS binary; on Apple Silicon without Rosetta it cannot run, so
 * this points electron-builder at a native NSIS (brew install makensis).
 * Run via: npm run dist:win
 */
const { execFileSync, spawnSync } = require('child_process')
const { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } = require('fs')
const { dirname, join } = require('path')

const root = join(__dirname, '..')

function canRunIntelBinaries() {
  try {
    execFileSync('arch', ['-x86_64', '/usr/bin/true'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** electron-builder's own NSIS bundle; it supplies elevate.exe, which plain NSIS lacks. */
async function electronBuilderNsisBundle() {
  const { getBinFromUrl } = require('app-builder-lib/out/binDownload')
  return getBinFromUrl(
    'nsis',
    '3.0.4.1',
    'VKMiizYdmNdJOWpRGz4trl4lD++BvYP2irAXpMilheUP0pc93iKlWAoP843Vlraj8YG19CVn0j+dCo/hURz9+Q=='
  )
}

async function nativeNsisDir() {
  let makensis
  try {
    makensis = realpathSync(execFileSync('which', ['makensis'], { encoding: 'utf8' }).trim())
  } catch {
    console.error(
      '\nThis Mac cannot run Intel binaries (Rosetta is not installed), so the bundled\n' +
        'NSIS compiler cannot run. Install a native one and retry:\n\n  brew install makensis\n'
    )
    process.exit(1)
  }
  const data = join(dirname(makensis), '..', 'share', 'nsis')
  // electron-builder expects <dir>/mac/makensis plus the NSIS data folders.
  const dir = join(root, 'node_modules', '.cache', 'pltm-nsis')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'mac'), { recursive: true })
  symlinkSync(makensis, join(dir, 'mac', 'makensis'))
  for (const name of ['Stubs', 'Plugins', 'Include', 'Contrib']) {
    if (existsSync(join(data, name))) symlinkSync(join(data, name), join(dir, name))
  }
  copyFileSync(join(await electronBuilderNsisBundle(), 'elevate.exe'), join(dir, 'elevate.exe'))
  return dir
}

async function main() {
  const env = { ...process.env }
  if (process.platform === 'darwin' && !env.ELECTRON_BUILDER_NSIS_DIR && !canRunIntelBinaries()) {
    env.ELECTRON_BUILDER_NSIS_DIR = await nativeNsisDir()
    console.log(`Using native NSIS (${env.ELECTRON_BUILDER_NSIS_DIR})`)
  }
  const result = spawnSync('npx', ['electron-builder', '--win', '--x64'], {
    cwd: root,
    env,
    stdio: 'inherit'
  })
  process.exit(result.status ?? 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

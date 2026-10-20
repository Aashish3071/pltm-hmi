/**
 * electron-builder afterPack hook: stamps the app icon and version info into
 * the Windows .exe.
 *
 * electron-builder normally does this with rcedit.exe under Wine, which needs
 * Rosetta on Apple Silicon. resedit edits the PE resources in pure JavaScript,
 * so the installer builds natively on any OS (win.signAndEditExecutable is off).
 */
const { readFileSync, writeFileSync } = require('fs')
const { join } = require('path')
const ResEdit = require('resedit')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const { appInfo } = context.packager
  const exePath = join(context.appOutDir, `${appInfo.productFilename}.exe`)
  const iconPath = join(context.packager.projectDir, 'resources', 'icon.ico')

  const exe = ResEdit.NtExecutable.from(readFileSync(exePath), { ignoreCert: true })
  const resources = ResEdit.NtExecutableResource.from(exe)

  // Replace Electron's icon in place, keeping its resource id and language.
  const icon = ResEdit.Data.IconFile.from(readFileSync(iconPath))
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)
  const target = groups[0] ?? { id: 1, lang: 1033 }
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    target.id,
    target.lang,
    icon.icons.map((item) => item.data)
  )

  const [versionInfo] = ResEdit.Resource.VersionInfo.fromEntries(resources.entries)
  const [major, minor, patch] = appInfo.version.split('.').map((n) => Number(n) || 0)
  const lang = versionInfo.getAllLanguagesForStringValues()[0] ?? { lang: 1033, codepage: 1200 }
  versionInfo.setStringValues(lang, {
    FileDescription: appInfo.description || appInfo.productName,
    ProductName: appInfo.productName,
    CompanyName: appInfo.companyName || 'Novatek',
    LegalCopyright: appInfo.copyright,
    InternalName: appInfo.productName,
    OriginalFilename: `${appInfo.productFilename}.exe`
  })
  versionInfo.setFileVersion(major, minor, patch, 0, lang.lang)
  versionInfo.setProductVersion(major, minor, patch, 0, lang.lang)
  versionInfo.outputToResourceEntries(resources.entries)

  resources.outputResource(exe)
  writeFileSync(exePath, Buffer.from(exe.generate()))
  console.log(`  • stamped icon and version ${appInfo.version} into ${appInfo.productFilename}.exe`)
}

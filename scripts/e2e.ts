/**
 * End-to-end UI test: drives the production build like an operator would, in
 * an isolated profile, and saves screenshots of each screen.
 * Run with: npm run test:e2e   (screenshots land in scripts/out/e2e/)
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { _electron as electron, type Page } from 'playwright-core'

const root = resolve(__dirname, '..', '..')
const shots = join(root, 'scripts', 'out', 'e2e')
const profile = join(tmpdir(), 'pltm-e2e-profile')
const documents = join(tmpdir(), 'pltm-e2e-documents')

let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(shots, `${name}.png`) })
}

async function status(page: Page): Promise<string> {
  return (await page.locator('.status-text').textContent())?.trim() ?? ''
}

async function waitStatus(page: Page, expected: string, timeout = 30000): Promise<boolean> {
  try {
    await page.waitForFunction(
      (want) => document.querySelector('.status-text')?.textContent?.trim() === want,
      expected,
      { timeout }
    )
    return true
  } catch {
    return false
  }
}

async function toastAppears(page: Page, text: string, timeout = 5000): Promise<boolean> {
  try {
    await page.locator('.toast', { hasText: text }).first().waitFor({ timeout })
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  for (const dir of [shots, profile, documents]) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  }

  // E2E_EXECUTABLE runs the suite against a packaged app instead of the build output.
  const packaged = process.env.E2E_EXECUTABLE
  const app = await electron.launch(
    packaged
      ? { executablePath: packaged, args: [`--user-data-dir=${profile}`] }
      : { args: [join(root, 'out', 'main', 'index.js'), `--user-data-dir=${profile}`], cwd: root }
  )
  if (packaged) console.log(`Testing packaged app: ${packaged}`)
  // Keep test reports out of the real Documents folder.
  await app.evaluate(({ app: electronApp }, dir) => electronApp.setPath('documents', dir), documents)

  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('dialog', (dialog) => void dialog.accept())
  await page.setViewportSize({ width: 1366, height: 768 })

  console.log('\nLogin')
  await page.getByPlaceholder('USER NAME').waitFor()
  check('isolated profile in use', existsSync(join(profile, 'pltm.db')))
  await shot(page, '01-login')
  await page.getByPlaceholder('USER NAME').fill('ADMIN')
  await page.getByPlaceholder('PASSWORD').fill('wrong')
  await page.getByRole('button', { name: 'LOGIN' }).click()
  check('wrong password shows an error', await page.locator('.login-error').isVisible())
  await page.getByPlaceholder('PASSWORD').fill('admin')
  await page.getByRole('button', { name: 'LOGIN' }).click()
  await page.locator('.home').waitFor()
  check('admin reaches the home screen', true)
  check('simulator connects', await waitStatus(page, 'HOMING NOT DONE', 10000), `(${await status(page)})`)
  await shot(page, '02-home')

  console.log('\nSettings')
  await page.getByRole('button', { name: 'SETTINGS' }).click()
  await page.locator('.modal').waitFor()
  await shot(page, '03-admin-gate')
  await page.locator('.modal input[type=password]').fill('admin')
  await page.locator('.modal').getByRole('button', { name: 'OK' }).click()
  await page.locator('.settings').waitFor()
  check('admin password unlocks settings', true)
  await shot(page, '04-settings-users')

  const speed = page.locator('.panel', { hasText: 'SPEED (mm/s)' })
  await speed.locator('.field-row', { hasText: 'UP SPEED' }).locator('input').fill('500')
  await speed.locator('.field-row', { hasText: 'DOWN SPEED' }).locator('input').fill('500')
  await speed.getByRole('button', { name: 'UPLOAD' }).click()
  check('speeds upload', await toastAppears(page, 'Speeds uploaded'))
  await speed.locator('.field-row', { hasText: 'UP SPEED' }).locator('input').fill('9000')
  await speed.getByRole('button', { name: 'UPLOAD' }).click()
  check('out-of-range speed rejected with a message', await toastAppears(page, 'UP SPEED must be'))
  await speed.locator('.field-row', { hasText: 'UP SPEED' }).locator('input').fill('500')

  await page.getByRole('button', { name: '+ NEW MODEL' }).click()
  await page.locator('.field-row', { hasText: 'NAME :' }).locator('input').fill('E2E MODEL')
  const grid = page.locator('.points-grid input')
  const rows: [number, number][] = [[50, 100], [55, 700], [55, 2000], [50, 2500], [80, 2500], [75, 2000], [75, 700], [80, 100], [50, 100]]
  for (let i = 0; i < rows.length; i++) {
    await grid.nth(i * 2).fill(String(rows[i][0]))
    await grid.nth(i * 2 + 1).fill(String(rows[i][1]))
  }
  await shot(page, '05-settings-new-model')
  await page.locator('.settings-actions').getByRole('button', { name: 'OK' }).click()
  check('new model created', await toastAppears(page, 'Model created'))
  await page.getByRole('button', { name: 'DELETE MODEL' }).click()
  check('model deleted after confirm', await toastAppears(page, 'Model deleted'))

  await page.getByRole('button', { name: 'MACHINE', exact: true }).click()
  await shot(page, '06-settings-machine')
  await page.getByRole('button', { name: 'CONNECTION' }).click()
  await page.locator('.register-map').waitFor()
  check('connection tab shows the register map', (await page.locator('.register-map').inputValue()).includes('statusCodes'))
  await shot(page, '07-settings-connection')
  const ports = await page.evaluate(async () =>
    (window as unknown as { pltm: { hardware: { listPorts: () => Promise<{ ok: boolean; message?: string }> } } })
      .pltm.hardware.listPorts()
  )
  check('serial port driver loads (COM port list)', ports.ok, JSON.stringify(ports))
  await page.getByRole('button', { name: 'TEST CONNECTION' }).click()
  const started = Date.now()
  check('test connection fails clearly with no machine', await toastAppears(page, '192.168.0.1:4840', 15000))
  check('connection test gives up within seconds', Date.now() - started < 8000, `(${Date.now() - started} ms)`)
  await page.locator('.settings-footer').getByRole('button', { name: 'HOME' }).click()
  await page.locator('.home').waitFor()

  console.log('\nTest run')
  await page.getByRole('button', { name: 'START' }).isDisabled()
  check('START disabled before OK', await page.getByRole('button', { name: 'START' }).isDisabled())
  await page.locator('.model-panel').getByRole('button', { name: 'OK' }).click()
  check('OK requires a Part-No', await toastAppears(page, 'Enter the Part-No'))
  await page.getByPlaceholder('#####').fill('E2E-0001')
  await page.locator('.model-panel').getByRole('button', { name: 'OK' }).click()
  await page.getByRole('button', { name: 'START' }).click()
  check('START refused before homing', await toastAppears(page, 'Homing not done'))
  await page.getByRole('button', { name: 'HOMING' }).click()
  check('HOMING reaches READY', await waitStatus(page, 'READY', 5000))
  await page.getByRole('button', { name: 'START' }).click()
  check('test starts raising', await waitStatus(page, 'PANTO RAISING', 5000))
  await page.waitForTimeout(2000)
  check('HOMING disabled mid-test', await page.getByRole('button', { name: 'HOMING' }).isDisabled())
  await page.getByRole('button', { name: 'STOP' }).click()
  check('STOP pauses (HALT)', await waitStatus(page, 'HALT', 5000))
  check('STOP button turns into RESUME', await page.getByRole('button', { name: 'RESUME' }).isVisible())
  const heightAtHalt = await page.locator('.readonly-value').nth(2).textContent()
  await page.waitForTimeout(800)
  check('position frozen while paused', (await page.locator('.readonly-value').nth(2).textContent()) === heightAtHalt)
  await shot(page, '08-home-paused')
  await page.getByRole('button', { name: 'RESUME' }).click()
  check('RESUME continues', await waitStatus(page, 'PANTO RAISING', 5000) || await waitStatus(page, 'PANTO RETRIVING', 2000))
  check('test completes back to READY', await waitStatus(page, 'READY', 60000), `(${await status(page)})`)
  const upTime = Number(await page.locator('.cycle-display').nth(0).textContent())
  const downTime = Number(await page.locator('.cycle-display').nth(1).textContent())
  check('cycle times shown for both phases', upTime > 0 && downTime > 0, `(${upTime}, ${downTime})`)
  await shot(page, '09-home-completed')
  await page.getByRole('button', { name: 'START' }).click()
  check('second START requires RESET', await toastAppears(page, 'Press RESET'))

  console.log('\nReport')
  await page.getByRole('button', { name: 'REPORT' }).click()
  check('report saved toast with OPEN FOLDER', await toastAppears(page, 'Report saved', 10000) && (await page.locator('.toast-action').isVisible()))
  const reportFolder = join(documents, 'PLTM Reports')
  const reports = existsSync(reportFolder) ? readdirSync(reportFolder) : []
  check('xlsx written for the model and part', reports.some((f) => f.startsWith('PANTO_3.8_E2E-0001') && f.endsWith('.xlsx')), `(${reports.join(', ')})`)
  await shot(page, '10-report')

  console.log('\nManual jog')
  await page.getByRole('button', { name: 'RESET' }).click()
  await waitStatus(page, 'READY', 5000)
  await page.getByRole('button', { name: 'MANUAL MODE' }).click()
  const up = page.getByRole('button', { name: '↑ UP' })
  await up.waitFor()
  const box = await up.boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(1500)
  const whileHeld = Number(await page.locator('.readonly-value').nth(2).textContent())
  await page.mouse.up()
  await page.waitForTimeout(400)
  const afterRelease = Number(await page.locator('.readonly-value').nth(2).textContent())
  await page.waitForTimeout(800)
  const later = Number(await page.locator('.readonly-value').nth(2).textContent())
  check('holding UP jogs the arm', whileHeld > 20, `(${whileHeld} mm)`)
  check('keep-alive kept it moving beyond the watchdog window', whileHeld > 50, `(${whileHeld} mm)`)
  check('releasing stops the arm', Math.abs(later - afterRelease) < 0.01, `(${afterRelease} -> ${later})`)
  check('jogging off zero requires homing', await waitStatus(page, 'HOMING NOT DONE', 2000))
  await shot(page, '11-manual-jog')
  await page.getByRole('button', { name: 'AUTO MODE' }).click()

  console.log('\nFaults')
  await page.getByRole('button', { name: 'SETTINGS' }).click()
  await page.locator('.modal input[type=password]').fill('admin')
  await page.locator('.modal').getByRole('button', { name: 'OK' }).click()
  await page.getByRole('button', { name: 'MACHINE', exact: true }).click()
  await page.getByRole('button', { name: 'EMERGENCY' }).click()
  await page.locator('.settings-footer').getByRole('button', { name: 'HOME' }).click()
  check('EMERGENCY shown on home', await waitStatus(page, 'EMERGENCY PRESSED', 3000))
  check('alarm bell active', await page.locator('.bell.alarm').isVisible())
  await page.getByRole('button', { name: 'HOMING' }).click()
  check('HOMING refused during EMERGENCY', await toastAppears(page, 'fault is active'))
  await shot(page, '12-emergency')
  await page.getByRole('button', { name: 'RESET' }).click()
  check('RESET clears the fault', await waitStatus(page, 'HOMING NOT DONE', 3000) || await waitStatus(page, 'READY', 1000))

  await page.getByRole('button', { name: 'SETTINGS' }).click()
  await page.locator('.modal input[type=password]').fill('admin')
  await page.locator('.modal').getByRole('button', { name: 'OK' }).click()
  await page.getByRole('button', { name: 'MACHINE', exact: true }).click()
  await page.getByRole('button', { name: 'DISCONNECT' }).click()
  await page.locator('.settings-footer').getByRole('button', { name: 'HOME' }).click()
  check('disconnect banner shown', await page.locator('.disconnect-banner').isVisible())
  await shot(page, '13-disconnected')
  try {
    await page.locator('.disconnect-banner').waitFor({ state: 'detached', timeout: 15000 })
    check('reconnects automatically after the outage', true)
  } catch {
    check('reconnects automatically after the outage', false)
  }

  console.log('\nOperator permissions')
  await page.getByRole('button', { name: 'LOGOUT' }).click()
  await page.getByPlaceholder('USER NAME').fill('OPERATOR1')
  await page.getByPlaceholder('PASSWORD').fill('operator1')
  await page.getByRole('button', { name: 'LOGIN' }).click()
  await page.locator('.home').waitFor()
  const restricted = await page.evaluate(async () =>
    (window as unknown as { pltm: { settings: { setSpeeds: (s: object) => Promise<{ ok: boolean; code?: string }> } } })
      .pltm.settings.setSpeeds({ up: 10, down: 10, jog: 10 })
  )
  check('operator cannot change settings via IPC', !restricted.ok && restricted.code === 'ERR_NOT_AUTHORIZED', JSON.stringify(restricted))
  await page.getByRole('button', { name: 'SETTINGS' }).click()
  await page.locator('.modal input[type=password]').fill('operator1')
  await page.locator('.modal').getByRole('button', { name: 'OK' }).click()
  check('operator password does not unlock settings', !(await page.locator('.settings').isVisible()))
  await page.locator('.modal').getByRole('button', { name: 'CANCEL' }).click()
  await page.getByRole('button', { name: 'LOGOUT' }).click()
  await page.getByPlaceholder('USER NAME').waitFor()

  check('no renderer errors', errors.length === 0, errors.join(' | '))

  await app.close()
  console.log(failures === 0 ? '\nAll UI checks passed.\n' : `\n${failures} UI check(s) failed.\n`)
  console.log(`Screenshots: ${shots}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

/**
 * End-to-end UI test: drives the production build like an operator would, in
 * an isolated profile, against a fake Siemens S7 PLC on a real socket, and
 * saves screenshots of every screen.
 * Run with: npm run test:e2e   (screenshots land in scripts/out/e2e/)
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { _electron as electron, type Page } from 'playwright-core'
import { FakeS7Plc } from './fakeS7'
import { DEFAULT_MODELS_FOR_TEST } from './testModels'

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
  return ((await page.getByTestId('status').textContent()) ?? '').trim()
}

async function waitStatus(page: Page, expected: string, timeout = 30000): Promise<boolean> {
  try {
    await page.waitForFunction(
      (want) => document.querySelector('[data-testid=status]')?.textContent?.trim() === want,
      expected,
      { timeout }
    )
    return true
  } catch {
    return false
  }
}

/** Reads and dismisses the message box; returns its text. */
async function message(page: Page, timeout = 8000): Promise<string> {
  try {
    await page.getByTestId('msgbox').waitFor({ timeout })
    const text = (await page.getByTestId('msgbox-text').textContent()) ?? ''
    await page.getByTestId('msgbox-ok').click()
    return text.trim()
  } catch {
    return ''
  }
}

/** Waits until the element's text matches. */
async function textMatches(page: Page, testId: string, pattern: RegExp, timeout = 5000): Promise<boolean> {
  try {
    await page.waitForFunction(
      ([id, source]) => new RegExp(source).test(document.querySelector(`[data-testid=${id}]`)?.textContent?.trim() ?? ''),
      [testId, pattern.source] as const,
      { timeout }
    )
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
  const plc = new FakeS7Plc()
  const plcPort = await plc.listen()
  plc.plc.setModel(DEFAULT_MODELS_FOR_TEST.PANTO3600)

  // E2E_EXECUTABLE runs the suite against a packaged app instead of the build output.
  const packaged = process.env.E2E_EXECUTABLE
  const app = await electron.launch(
    packaged
      ? { executablePath: packaged, args: [`--user-data-dir=${profile}`] }
      : { args: [join(root, 'out', 'main', 'index.js'), `--user-data-dir=${profile}`], cwd: root }
  )
  if (packaged) console.log(`Testing packaged app: ${packaged}`)
  await app.evaluate(({ app: electronApp }, dir) => electronApp.setPath('documents', dir), documents)

  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.setViewportSize({ width: 1366, height: 768 })

  console.log('\nLogin')
  await page.getByTestId('login-username').waitFor()
  check('isolated profile in use', existsSync(join(profile, 'pltm.db')))
  await page.waitForTimeout(300)
  await shot(page, '01-login')
  await page.getByTestId('login-username').fill('ADMIN')
  await page.getByTestId('login-password').fill('wrong')
  await page.getByTestId('login-button').click()
  check('wrong password: message', (await message(page)) === 'Incorrect user name or password.')
  check('fields cleared after a wrong password', (await page.getByTestId('login-username').inputValue()) === '')
  await page.getByTestId('login-username').fill('ADMIN')
  await page.getByTestId('login-password').fill('1234')
  await page.getByTestId('login-button').click()
  await page.getByTestId('status').waitFor()
  check('ADMIN / 1234 reaches the home screen', true)
  check('no PLC yet: ETHERNET DISCONNECTED', await waitStatus(page, 'ETHERNET DISCONNECTED', 5000), await status(page))
  check('employee box shows the user', (await page.getByTestId('f-employee').inputValue()) === 'ADMIN')
  await shot(page, '02-home-disconnected')
  await page.getByTestId('btn-start').click()
  check('START while disconnected: message', (await message(page)).includes('ETHERNET DISCONNECTED'))

  console.log('\nAdministrator sign-in')
  await page.getByTestId('btn-settings').click()
  await page.getByTestId('admin-password').waitFor()
  check('system details shown', await textMatches(page, 'admin-device', /192\.168\.0\.1/))
  await shot(page, '03-admin')
  await page.getByTestId('admin-password').fill('123')
  await page.getByTestId('admin-ok').click()
  check('wrong admin password refused', (await message(page)) === 'Incorrect administrator name or password.')
  await page.getByTestId('admin-password').fill('1234')
  await page.getByTestId('admin-ok').click()
  await page.getByTestId('s-model').waitFor()
  check('admin password opens Settings', true)

  console.log('\nSettings')
  check('current model loaded', (await page.getByTestId('s-model').inputValue()) === 'PANTO-3600')
  check('Y4 = 3600', (await page.getByTestId('s-height4').inputValue()) === '3600')
  check('distance = 3600', (await page.getByTestId('s-distance').inputValue()) === '3600')
  await page.waitForTimeout(300)
  await shot(page, '04-settings')

  await page.getByTestId('s-system').click()
  await page.getByTestId('system-dialog').waitFor()
  check('Siemens S7 is the default driver', (await page.getByTestId('sys-driver').inputValue()) === 's7')
  await page.getByTestId('sys-s7-host').fill('127.0.0.1')
  await page.locator('.sys .grid').nth(1).locator('input').nth(1).fill(String(plcPort))
  await shot(page, '05-system')
  await page.getByTestId('sys-test').click()
  await page.getByTestId('sys-result').waitFor()
  const tested = (await page.getByTestId('sys-result').textContent()) ?? ''
  check('TEST CONNECTION reads the PLC', tested.includes('HOMING NOT DONE'), tested)
  await page.getByTestId('sys-save').click()
  await page.waitForFunction(() => document.querySelector('[data-testid=sys-result]')?.textContent?.startsWith('Saved'))
  check('connection saved', true)
  await page.getByTestId('sys-close').click()

  await page.getByTestId('s-upspeed').fill('500')
  await page.getByTestId('s-downspeed').fill('500')
  await page.getByTestId('s-upload').click()
  check('UPLOAD message', (await message(page)) === 'Values uploaded to the machine.')
  check('speeds reached the PLC (DB6.DBD6/10)', plc.db.readFloatBE(6) === 500 && plc.db.readFloatBE(10) === 500)

  await page.getByTestId('s-name2').fill('RAVI')
  await page.getByTestId('s-savenames').click()
  check('employee names saved', (await message(page)) === 'User names saved.')
  await page.getByTestId('s-user').selectOption({ label: 'RAVI' })
  await page.getByTestId('s-password').fill('4321')
  await page.getByTestId('s-change').click()
  check('password changed', (await message(page)) === 'Password changed.')

  await page.getByTestId('s-model').fill('')
  await page.getByTestId('s-ok').click()
  check('empty model refused', (await message(page)) === 'Model name cannot be empty.')
  await page.getByTestId('s-model').fill('PANTO-3600')
  await page.getByTestId('s-ok').click()
  check('model saved', (await message(page)) === 'Model "PANTO-3600" saved.')

  await page.getByTestId('s-home').click()
  await page.getByTestId('status').waitFor()

  console.log('\nTest cycle on the fake S7 PLC')
  check('PLC connected: HOMING NOT DONE', await waitStatus(page, 'HOMING NOT DONE', 10000), await status(page))
  check('speeds shown on Home', (await page.getByTestId('f-upspeed').textContent()) === '500')
  await page.getByTestId('f-partno').fill('')
  await page.getByTestId('btn-ok').click()
  await page.waitForTimeout(300)
  check('empty Part-No becomes #####', (await page.getByTestId('f-partno').inputValue()) === '#####')
  await page.getByTestId('f-partno').fill('PANTO-0042')
  await page.getByTestId('btn-ok').click()
  await page.waitForTimeout(300)
  await page.getByTestId('btn-homing').click()
  check('HOMING → READY', await waitStatus(page, 'READY', 15000), await status(page))
  await page.getByTestId('btn-start').click()
  check('START → PANTO RAISING', await waitStatus(page, 'PANTO RAISING', 5000), await status(page))
  await page.waitForTimeout(1500)
  await shot(page, '06-home-raising')
  await page.getByTestId('btn-stop').dispatchEvent('mousedown')
  check('STOP (on press) → HALT', await waitStatus(page, 'HALT', 5000), await status(page))
  check('STOP becomes RESUME while halted', ((await page.getByTestId('btn-stop').textContent()) ?? '').includes('RESUME'))
  await page.getByTestId('btn-stop').click()
  check('RESUME continues the test', await waitStatus(page, 'PANTO RAISING', 5000), await status(page))
  check('PANTO RETRIEVING', await waitStatus(page, 'PANTO RETRIEVING', 30000), await status(page))
  check('CYCLE COMPLETED', await waitStatus(page, 'CYCLE COMPLETED', 30000), await status(page))
  await waitStatus(page, 'READY', 10000)
  const avgUp = Number(await page.getByTestId('r-avgup').textContent())
  const avgDown = Number(await page.getByTestId('r-avgdown').textContent())
  check('results: avg up force in the reference band', avgUp > 50 && avgUp < 65, String(avgUp))
  check('results: avg down force in the reference band', avgDown > 75 && avgDown < 90, String(avgDown))
  const mean = Number(await page.getByTestId('r-mean').textContent())
  check('mean = (up + down) / 2', Math.abs(mean - (avgUp + avgDown) / 2) < 0.001)
  check('height reached = 3600', (await page.getByTestId('r-height').textContent()) === '3600')
  check('up / down timers', Number(await page.getByTestId('lcd-up').getAttribute('data-value')) > 0)
  await shot(page, '07-home-cycle-complete')

  await page.getByTestId('btn-report').click()
  const reported = await message(page, 30000)
  check('REPORT: files generated', reported.includes('PANTO-3600_PANTO-0042_'), reported)
  const reportDir = join(documents, 'PantoCheck Reports')
  const files = existsSync(reportDir) ? readdirSync(reportDir) : []
  check('xlsx, pdf and json written', ['.xlsx', '.pdf', '.json'].every((ext) => files.some((f) => f.endsWith(ext))), files.join(', '))

  console.log('\nRESET and the n / n-1 / n-2 history')
  await page.getByTestId('btn-reset').click()
  await page.waitForTimeout(800)
  check('RESET clears the results', (await page.getByTestId('r-avgup').textContent()) === '0')
  await page.getByTestId('chk-n').click()
  await page.getByTestId('chk-n1').click()
  await page.waitForTimeout(500)
  check('n-1 shows the previous test', Math.abs(Number(await page.getByTestId('r-avgup').textContent()) - avgUp) < 0.001)
  await page.getByTestId('chk-n').click()
  await page.waitForTimeout(300)
  check('two curves checked: results show -----', (await page.getByTestId('r-avgup').textContent()) === '-----')
  await shot(page, '08-home-n-1')

  console.log('\nLink loss')
  plc.dropClients()
  check('cable pulled: ETHERNET DISCONNECTED', await waitStatus(page, 'ETHERNET DISCONNECTED', 5000), await status(page))
  check('reconnects by itself', await waitStatus(page, 'READY', 15000), await status(page))

  console.log('\nHistory')
  await page.getByTestId('btn-history').click()
  await page.getByTestId('h-table').waitFor()
  await page.getByTestId('h-partno').fill('PANTO-0042')
  await page.getByTestId('h-search').click()
  await page.waitForTimeout(500)
  check('history finds the test by Part-No', (await page.getByTestId('h-row').count()) >= 1)
  await page.getByTestId('h-row').first().click()
  await page.getByTestId('h-graph').waitFor()
  check('selected test shows its results', ((await page.getByTestId('h-avg').textContent()) ?? '').includes('/'))
  await page.waitForTimeout(300)
  await shot(page, '09-history')
  await page.getByTestId('h-reprint').click()
  check('reprint from history', (await message(page, 30000)).includes('PANTO-3600_PANTO-0042_'))
  await page.getByTestId('h-home').click()
  await page.getByTestId('status').waitFor()

  console.log('\nData backup')
  await page.getByTestId('btn-settings').click()
  await page.getByTestId('admin-password').fill('1234')
  await page.getByTestId('admin-ok').click()
  await page.getByTestId('s-data').click()
  await page.getByTestId('data-dialog').waitFor()
  await page.getByTestId('backup-now').click()
  await page.getByTestId('backup-table').waitFor({ timeout: 10000 })
  check('BACK UP NOW lists a backup', (await page.locator('[data-testid=backup-table] tbody tr').count()) >= 1)
  await shot(page, '10-data')
  await page.locator('[data-testid=data-dialog] .actions button').click()
  await page.getByTestId('s-home').click()
  await page.getByTestId('status').waitFor()

  console.log('\nLogout and operators')
  await page.getByTestId('btn-logout').click()
  await page.getByTestId('login-username').fill('RAVI')
  await page.getByTestId('login-password').fill('4321')
  await page.getByTestId('login-button').click()
  await page.getByTestId('status').waitFor()
  check('renamed operator logs in with the new password', (await page.getByTestId('f-employee').inputValue()) === 'RAVI')
  await page.getByTestId('btn-logout').click()
  await page.getByTestId('forgot-admin').click()
  await page.getByTestId('recovery-dialog').waitFor()
  check('forgot ADMIN password shows a request code', await textMatches(page, 'recovery-request', /^[0-9A-Z]{4}-[0-9A-Z]{4}$/))
  await page.getByTestId('recovery-response').fill('AAAAA-AAAAA')
  await page.getByTestId('recovery-password').fill('abcd')
  await page.getByTestId('recovery-confirm').fill('abcd')
  await page.getByTestId('recovery-submit').click()
  check('a wrong response code is refused', ((await page.getByTestId('recovery-error').textContent({ timeout: 5000 })) ?? '').length > 0)

  check('no renderer errors', errors.length === 0, errors.join(' | '))
  await app.close()
  await plc.close()
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

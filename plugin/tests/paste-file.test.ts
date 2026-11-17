import { expect, test } from 'claude-code/testing'
import { encodeForOrigin, quotePath } from '../hooks/register.js'

test('quotePath puts quotes around a path that has a space', async () => {
  expect(quotePath('/tmp/a/b.png')).toBe('/tmp/a/b.png')
  expect(quotePath('/tmp/My File.png')).toBe('"/tmp/My File.png"')
})

test('encodeForOrigin leaves no character that a shell changes', async () => {
  expect(encodeForOrigin("/Users/me/It's (1) $x.png")).toBe('%2FUsers%2Fme%2FIt%27s%20%281%29%20%24x.png')
})

// Stubs that answer in the place of Claude Code. 'remote' tells if the
// computer has the paste-origin host. 'answers' gives the answer to each
// request to the origin, or to each local program: [exit code, output].
// The test kit gives '.' as the absolute path of the plugin folder, so any
// path outside /tmp, /work and /Users/me is the working directory (/work).
const stub = (on: any, options: { remote: boolean, platform: string, answers: Record<string, [number, string]>, exists?: () => boolean }) => {
  const fills: string[] = []
  const runs: string[][] = []
  on('session.info', () => ({ value: { transcriptPath: '', platform: options.platform, isHosted: false } }))
  on('prompt.fill', (_: unknown, e: any) => { fills.push(e.text); return { isFilled: true } })
  on('fs.stat', (_: unknown, e: any) => ({ value: /^\/(tmp|work|Users\/me)\//.test(e.path)
    ? { kind: 'file', size: 10, mtimeMs: 0, isLink: false, realPath: e.path }
    : { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: '/work' } }))
  on('fs.exists', () => ({ value: options.exists ? options.exists() : false }))
  on('process.run', (_: unknown, e: any) => {
    runs.push([...e.argv])
    if (e.argv[0] === 'sh' && e.argv.length === 3) return { value: { exitCode: 0, stdout: 'origin=\nconfigured=' + (options.remote ? 1 : 0) + '\ndir=/tmp/cpf\n', stderr: '' } }
    // A request to the origin is: sh -c <script> sh <host> "<verb> <path>" [dest]
    const key = e.argv[0] === 'sh' ? (e.argv[5] ?? '').split(' ')[0] : e.argv[0] === 'osascript' ? (e.argv.includes('on run argv') ? 'image' : 'files') : e.argv[0]
    const [exitCode, stdout] = options.answers[key] ?? (e.argv[0] === 'sh' || e.argv[0] === 'osascript' || e.argv[0] === 'cmp' ? [1, ''] : [0, ''])
    return { value: { exitCode, stdout, stderr: '' } }
  })
  return { fills, runs }
}

test('on a remote host, /paste-file gets the files that are on the clipboard of the origin', async ($, on) => {
  const { fills, runs } = stub(on, { remote: true, platform: 'linux', answers: { 'clipboard-files': [0, '/Users/me/Desktop/a.pdf\n/Users/me/Desktop/My Shot.png\n'], stat: [0, 'file 10\n'], get: [0, ''] } })
  const answer = await $.command.run({ command: 'paste-file', args: '' })
  expect(fills).toEqual(['/tmp/cpf/a.pdf "/tmp/cpf/My Shot.png" '])
  expect(answer.text).toBe(undefined)
  const get = runs.find(argv => (argv[5] ?? '').startsWith('get '))
  expect(get?.[4]).toBe('paste-origin')
  expect(get?.[5]).toBe('get %2FUsers%2Fme%2FDesktop%2Fa.pdf')
  expect(runs.some(argv => argv[0] === 'mv' && argv[1] === get?.[6] && argv[2] === '/tmp/cpf/a.pdf')).toBe(true)
})

test('on a remote host, /paste-file tells when the origin refuses a file', async ($, on) => {
  const { fills, runs } = stub(on, { remote: true, platform: 'linux', answers: { 'clipboard-files': [0, '/Users/me/.ssh/id_ed25519\n'], stat: [0, 'refused\n'] } })
  const answer = await $.command.run({ command: 'paste-file', args: '' })
  expect(fills).toEqual([])
  expect(answer.text).toContain('allowed_dirs')
  expect(runs.some(argv => (argv[5] ?? '').startsWith('get '))).toBe(false)
})

test('on a remote host, /paste-file gets the clipboard image when the clipboard has no file', async ($, on) => {
  const { fills } = stub(on, { remote: true, platform: 'linux', answers: { clipboard: [0, ''] } })
  await $.command.run({ command: 'paste-file', args: 'diagram' })
  expect(fills).toEqual(['/tmp/cpf/diagram.png '])
})

test('on a remote host, /paste-file tells when the origin does not connect', async ($, on) => {
  const { fills } = stub(on, { remote: true, platform: 'linux', answers: { 'clipboard-files': [255, ''], clipboard: [255, ''] } })
  const answer = await $.command.run({ command: 'paste-file', args: '' })
  expect(fills).toEqual([])
  expect(answer.text).toContain('does not connect')
})

test('/paste-file tells when the clipboard has no file and no image', async ($, on) => {
  stub(on, { remote: true, platform: 'linux', answers: {} })
  const answer = await $.command.run({ command: 'paste-file', args: '' })
  expect(answer.text).toBe('The clipboard has no file and no image.')
})

test('on macOS, /paste-file copies the files that are on the clipboard into the paste folder', async ($, on) => {
  const { fills, runs } = stub(on, { remote: false, platform: 'macos', answers: { files: [0, '/Users/me/Desktop/a.pdf\n'] } })
  await $.command.run({ command: 'paste-file', args: '' })
  expect(fills).toEqual(['/tmp/cpf/a.pdf '])
  expect(runs.some(argv => argv[0] === 'cp' && argv[1] === '/Users/me/Desktop/a.pdf' && argv[2] === '/tmp/cpf/a.pdf')).toBe(true)
})

test('on macOS, a file that is in the working directory is not copied', async ($, on) => {
  const { fills, runs } = stub(on, { remote: false, platform: 'macos', answers: { files: [0, '/work/src/a.ts\n'] } })
  await $.command.run({ command: 'paste-file', args: '' })
  expect(fills).toEqual(['./src/a.ts '])
  expect(runs.some(argv => argv[0] === 'cp')).toBe(false)
})

test('a different file with the same name stays, and the copy gets a number', async ($, on) => {
  let asked = 0
  const { fills } = stub(on, { remote: false, platform: 'macos', answers: { files: [0, '/Users/me/Desktop/a.pdf\n'] }, exists: () => asked++ === 0 })
  await $.command.run({ command: 'paste-file', args: '' })
  expect(fills).toEqual(['/tmp/cpf/a-1.pdf '])
})

test('on macOS, /paste-file saves the clipboard image when the clipboard has no file', async ($, on) => {
  const { fills } = stub(on, { remote: false, platform: 'macos', answers: { image: [0, ''] } })
  await $.command.run({ command: 'paste-file', args: '' })
  expect(fills.length).toBe(1)
  expect(/^\/tmp\/cpf\/clipboard-\d{8}-\d{6}\.png $/.test(fills[0])).toBe(true)
})

test('on Linux with no origin, /paste-file tells what it needs', async ($, on) => {
  stub(on, { remote: false, platform: 'linux', answers: {} })
  const answer = await $.command.run({ command: 'paste-file', args: '' })
  expect(answer.text).toContain('needs macOS')
})

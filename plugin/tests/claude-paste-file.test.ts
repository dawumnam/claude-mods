import { expect, test } from 'claude-code/testing'
import { encodeForOrigin, looksLikePaths, quotePath, toAbsolute, tokenize } from '../hooks/register.js'

test('tokenize splits paths as a shell does', async () => {
  expect(tokenize('/a/b.png /c/My\\ File.pdf')).toEqual(['/a/b.png', '/c/My File.pdf'])
  expect(tokenize("'/a/My File.png' \"/b/x y.txt\"")).toEqual(['/a/My File.png', '/b/x y.txt'])
  expect(tokenize("'/a/unterminated")).toBe(null)
})

test('toAbsolute accepts absolute paths, ~/ paths and file URLs only', async () => {
  expect(toAbsolute('/a/b', '/Users/x')).toBe('/a/b')
  expect(toAbsolute('~/b c', '/Users/x')).toBe('/Users/x/b c')
  expect(toAbsolute('file:///a/My%20File.png', '/Users/x')).toBe('/a/My File.png')
  expect(toAbsolute('relative/path', '/Users/x')).toBe(undefined)
})

test('quotePath and looksLikePaths', async () => {
  expect(quotePath('./a/b.png')).toBe('./a/b.png')
  expect(quotePath('./My File.png')).toBe('"./My File.png"')
  expect(looksLikePaths('/a/b.png ')).toBe(true)
  expect(looksLikePaths('fix /a/b.png')).toBe(false)
})

const edit = (inputText: string) => ({ origin: { kind: 'composer' as const }, text: 'see ', cursor: 4, start: 4, end: 4, inputText })

// Stubs that answer in the place of Claude Code. The test kit gives '.' as
// the absolute path of the plugin directory, so any path outside /tmp and
// /work is the working directory.
const stubEngine = (on: any, runs: string[][], exists: () => boolean = () => false) => {
  on('prompt.edit', (_: unknown, e: any) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.stat', (_: unknown, e: any) => ({ value: /^\/(tmp|work)\//.test(e.path)
    ? { kind: 'file', size: 10, mtimeMs: 0, isLink: false, realPath: e.path }
    : { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: '/work' } }))
  on('fs.exists', () => ({ value: exists() }))
  on('process.run', (_: unknown, e: any) => {
    runs.push([...e.argv])
    return { value: { exitCode: e.argv[0] === 'cmp' ? 1 : 0, stdout: e.argv[0] === 'sh' && e.argv.length === 3 ? 'home=/Users/x\norigin=\nconfigured=0\ndir=/tmp/cpf\n' : '', stderr: '' } }
  })
}

test('a dragged file outside the working directory is copied into the paste folder', async ($, on) => {
  const runs: string[][] = []
  stubEngine(on, runs)
  const box = await $.prompt.edit(edit('/tmp/shots/My\\ Shot.png '))
  expect(box.text).toBe('see "/tmp/cpf/My Shot.png" ')
  expect(runs.some(argv => argv[0] === 'cp' && argv[1] === '/tmp/shots/My Shot.png' && argv[2] === '/tmp/cpf/My Shot.png')).toBe(true)
})

test('a different file with the same name stays, and the copy gets a number', async ($, on) => {
  const runs: string[][] = []
  let asked = 0
  stubEngine(on, runs, () => asked++ === 0)
  const box = await $.prompt.edit(edit('/tmp/a.png'))
  expect(box.text).toBe('see /tmp/cpf/a-1.png')
  expect(runs.some(argv => argv[0] === 'cp' && argv[2] === '/tmp/cpf/a-1.png')).toBe(true)
})

test('a file inside the working directory is not copied', async ($, on) => {
  const runs: string[][] = []
  stubEngine(on, runs)
  const box = await $.prompt.edit(edit('/work/src/a.ts /work/b.md'))
  expect(box.text).toBe('see ./src/a.ts ./b.md')
  expect(runs.some(argv => argv[0] === 'cp')).toBe(false)
})

test('typed text and text that is not a path stay unchanged', async ($, on) => {
  const runs: string[][] = []
  stubEngine(on, runs)
  expect((await $.prompt.edit(edit('hello /tmp/x'))).text).toBe('see hello /tmp/x')
  expect((await $.prompt.edit({ ...edit('/'), key: { key: '/' } } as any)).text).toBe('see /')
  expect(runs.length).toBe(0)
})

test('encodeForOrigin leaves no character that a shell changes', async () => {
  expect(encodeForOrigin("/Users/me/It's (1) $x.png")).toBe('%2FUsers%2Fme%2FIt%27s%20%281%29%20%24x.png')
})

// Stubs for an SSH session: no file is on this computer, and the origin
// answers the stat request with 'statAnswer'.
const stubSsh = (on: any, runs: string[][], statAnswer: string) => {
  on('prompt.edit', (_: unknown, e: any) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.stat', (_: unknown, e: any) => {
    if (e.path.startsWith('/Users/me/')) throw new Error('ENOENT')
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: '/work' } }
  })
  on('fs.exists', () => ({ value: false }))
  on('process.run', (_: unknown, e: any) => {
    runs.push([...e.argv])
    const request = e.argv[5] ?? ''
    const stdout = e.argv.length === 3 ? 'home=/home/dev\norigin=\nconfigured=1\ndir=/tmp/cpf\n' : request.startsWith('stat ') ? statAnswer : ''
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
}

test('in an SSH session, a dragged file comes from the origin', async ($, on) => {
  const runs: string[][] = []
  stubSsh(on, runs, 'file 10\n')
  const box = await $.prompt.edit(edit('/Users/me/Desktop/My\\ Shot.png '))
  expect(box.text).toBe('see "/tmp/cpf/My Shot.png" ')
  const get = runs.find(argv => (argv[5] ?? '').startsWith('get '))
  expect(get?.[4]).toBe('paste-origin')
  expect(get?.[5]).toBe('get %2FUsers%2Fme%2FDesktop%2FMy%20Shot.png')
  expect(runs.some(argv => argv[0] === 'mv' && argv[1] === get?.[6] && argv[2] === '/tmp/cpf/My Shot.png')).toBe(true)
})

test('in an SSH session, a path that the origin does not have stays unchanged', async ($, on) => {
  const runs: string[][] = []
  stubSsh(on, runs, 'missing\n')
  const box = await $.prompt.edit(edit('/Users/me/nothing.png'))
  expect(box.text).toBe('see /Users/me/nothing.png')
  expect(runs.some(argv => (argv[5] ?? '').startsWith('get '))).toBe(false)
})

// Stubs for /paste-file in an SSH session. 'answers' gives the origin's
// answer to each request: [exit code, output].
const stubCommand = (on: any, fills: string[], answers: Record<string, [number, string]>) => {
  on('session.info', () => ({ value: { transcriptPath: '', platform: 'linux', isHosted: false } }))
  on('prompt.fill', (_: unknown, e: any) => { fills.push(e.text); return { isFilled: true } })
  on('ui.toast', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: '/work' } }))
  on('fs.exists', () => ({ value: false }))
  on('process.run', (_: unknown, e: any) => {
    if (e.argv.length === 3) return { value: { exitCode: 0, stdout: 'home=/home/dev\norigin=\nconfigured=1\ndir=/tmp/cpf\n', stderr: '' } }
    const verb = (e.argv[5] ?? '').split(' ')[0]
    const [exitCode, stdout] = e.argv[0] === 'sh' ? answers[verb] ?? [1, ''] : [0, '']
    return { value: { exitCode, stdout, stderr: '' } }
  })
}

test('/paste-file gets the files that are on the clipboard of the origin', async ($, on) => {
  const fills: string[] = []
  stubCommand(on, fills, { 'clipboard-files': [0, '/Users/me/Desktop/a.pdf\n/Users/me/.ssh/id_ed25519\n'], stat: [0, 'file 10\n'], get: [0, ''] })
  const answer = await $.command.run({ command: 'paste-file', args: '' })
  expect(fills).toEqual(['/tmp/cpf/a.pdf /tmp/cpf/id_ed25519 '])
  expect(answer.text).toBe(undefined)
})

test('/paste-file tells when the origin refuses a file', async ($, on) => {
  const fills: string[] = []
  stubCommand(on, fills, { 'clipboard-files': [0, '/Users/me/.ssh/id_ed25519\n'], stat: [0, 'refused\n'] })
  const answer = await $.command.run({ command: 'paste-file', args: '' })
  expect(fills).toEqual([])
  expect(answer.text).toContain('allowed_dirs')
})

test('/paste-file gets the clipboard image when the clipboard has no file', async ($, on) => {
  const fills: string[] = []
  stubCommand(on, fills, { 'clipboard-files': [1, ''], clipboard: [0, ''] })
  await $.command.run({ command: 'paste-file', args: 'diagram' })
  expect(fills).toEqual(['/tmp/cpf/diagram.png '])
})

test('/paste-file tells when the clipboard has no file and no image', async ($, on) => {
  const fills: string[] = []
  stubCommand(on, fills, {})
  const answer = await $.command.run({ command: 'paste-file', args: '' })
  expect(answer.text).toBe('The clipboard has no file and no image.')
})

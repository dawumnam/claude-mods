// paste-here: copies a pasted or dragged file into the working directory and
// puts the relative path in the prompt box.
//
// On a remote host, the file is on the computer that has your terminal (the
// origin), not on the computer that runs Claude Code. The mod then gets the
// file through the SSH host 'paste-origin'. origin/setup.sh makes that host.

// The folder that receives the copies, relative to the working directory.
// '' is the working directory itself. 'attachments' is a folder in it.
const TARGET_DIR = ''
// A larger file is not copied. Its absolute path stays in the prompt.
const MAX_BYTES = 200 * 1024 * 1024
// A paste with more paths than this is not changed.
const MAX_PATHS = 20
// The SSH host of the origin. The PASTE_HERE_ORIGIN variable replaces it.
const ORIGIN_HOST = 'paste-origin'
const SSH_OPTIONS = '-o BatchMode=yes -o ConnectTimeout=5'

let environment
let originDownUntil = 0

// Splits pasted text into paths as a shell does: spaces divide, and a
// backslash or quotes keep a space in a path. Returns null for bad quotes.
export function tokenize(raw) {
  const tokens = []
  let current = ''
  let hasToken = false
  let quote = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (quote === "'") {
      if (c === "'") quote = ''
      else current += c
    } else if (quote === '"') {
      if (c === '"') quote = ''
      else if (c === '\\' && (raw[i + 1] === '"' || raw[i + 1] === '\\')) current += raw[++i]
      else current += c
    } else if (c === "'" || c === '"') {
      quote = c
      hasToken = true
    } else if (c === '\\' && i + 1 < raw.length) {
      current += raw[++i]
      hasToken = true
    } else if (/\s/.test(c)) {
      if (hasToken) tokens.push(current)
      current = ''
      hasToken = false
    } else {
      current += c
      hasToken = true
    }
  }
  if (quote !== '') return null
  if (hasToken) tokens.push(current)
  return tokens
}

// Returns the absolute path that a token names, or undefined when the token
// is not an absolute path, a ~/ path or a file:// URL.
export function toAbsolute(token, homeDir) {
  if (token.startsWith('file://')) {
    const rest = token.slice(7).replace(/^localhost(?=\/)/, '')
    if (!rest.startsWith('/')) return undefined
    try {
      return decodeURIComponent(rest)
    } catch {
      return undefined
    }
  }
  if (token.startsWith('~/')) return homeDir ? homeDir + token.slice(1) : undefined
  return token.startsWith('/') ? token : undefined
}

// Puts quotes around a path that has a space or another special character.
export function quotePath(path) {
  if (/^[\w@%+=:,.\/-]+$/.test(path)) return path
  return '"' + path.replace(/(["\\])/g, '\\$1') + '"'
}

// True when the text can be a list of paths. This check is fast, because it
// runs on each paste and on each burst of keys.
export function looksLikePaths(text) {
  return text.length > 1 && text.length <= 8192 && /^\s*['"]?(\/|~\/|file:\/\/)/.test(text)
}

// Encodes a path for a request to the origin. The result has only letters,
// digits and % . _ ~ -, so no shell changes it.
export function encodeForOrigin(path) {
  return encodeURIComponent(path).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

function splitName(path) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? { name, stem: name.slice(0, dot), ext: name.slice(dot) } : { name, stem: name, ext: '' }
}

// Returns the working directory with a slash at its end.
async function workingDirectory($) {
  const cwd = (await $.fs.stat('.', { resolve: true })).realPath
  return cwd.endsWith('/') ? cwd : cwd + '/'
}

// Returns { home, origin }. 'origin' is the SSH host of the origin, or '' when
// this computer has no origin. A computer has an origin when origin/setup.sh
// added the host 'paste-origin' to its ~/.ssh/config. The SSH_CONNECTION
// variable is not used, because a session in tmux or a background session
// does not have it.
async function readEnvironment($) {
  if (environment === undefined) {
    const script = 'printf "%s\\n%s\\n" "$HOME" "$PASTE_HERE_ORIGIN"; grep -Ecs "^[Hh]ost[[:space:]]+' + ORIGIN_HOST + '([[:space:]]|\$)" "$HOME/.ssh/config"'
    const result = await $.process.run(['sh', '-c', script])
    const [home = '', named = '', configured = ''] = result.stdout.split('\n')
    environment = { home, origin: named || (Number(configured) > 0 ? ORIGIN_HOST : '') }
  }
  return environment
}

// Sends one request to the origin. With 'dest', the answer goes into that
// file. Returns undefined when the origin is not available. After a failed
// connection, the mod does not try again for one minute.
async function askOrigin($, origin, request, dest) {
  if (Date.now() < originDownUntil) return undefined
  const script = 'exec ssh ' + SSH_OPTIONS + ' "$1" "$2"' + (dest === undefined ? '' : ' > "$3"')
  const argv = ['sh', '-c', script, 'sh', origin, request]
  if (dest !== undefined) argv.push(dest)
  const result = await $.process.run(argv, { timeoutMs: 300000 }).catch(() => undefined)
  if (result === undefined || result.exitCode === 255) {
    originDownUntil = Date.now() + 60000
    return undefined
  }
  return result
}

// Makes the target folder. Returns its path relative to the working
// directory ('' or a path with a slash at its end), or undefined on failure.
async function targetFolder($, cwd) {
  if (TARGET_DIR === '') return ''
  const made = await $.process.run(['mkdir', '-p', cwd + TARGET_DIR])
  return made.exitCode === 0 ? TARGET_DIR + '/' : undefined
}

// Puts the file 'source' in the working directory under 'name'. 'place' is
// 'cp' for a file that must stay where it is and 'mv' for a temporary file.
// A file with the same name and the same content is used again. A file with
// the same name and different content stays, and the new file gets a number.
// Returns the relative path, or undefined on failure.
async function settle($, cwd, folder, source, name, place) {
  const { stem, ext } = splitName(name)
  for (let n = 0; n < 100; n++) {
    const relative = folder + (n === 0 ? name : stem + '-' + n + ext)
    if (await $.fs.exists(cwd + relative)) {
      const same = await $.process.run(['cmp', '-s', source, cwd + relative], { timeoutMs: 120000 })
      if (same.exitCode !== 0) continue
      if (place === 'mv') await $.process.run(['rm', '-f', source])
      return './' + relative
    }
    const placed = await $.process.run([place, source, cwd + relative], { timeoutMs: 120000 })
    return placed.exitCode === 0 ? './' + relative : undefined
  }
  return undefined
}

// Gets a file from the origin. Returns the same shape as placePath.
async function fetchFromOrigin($, cwd, origin, absolute) {
  const stat = await askOrigin($, origin, 'stat ' + encodeForOrigin(absolute))
  if (stat === undefined || stat.exitCode !== 0) return undefined
  const answer = stat.stdout.trim()
  const size = /^file (\d+)$/.exec(answer)
  if (answer === 'dir' || (size && Number(size[1]) > MAX_BYTES)) return { text: absolute, changed: false }
  if (answer === 'refused') return { text: absolute, changed: false, refused: true }
  if (!size) return undefined
  const folder = await targetFolder($, cwd)
  if (folder === undefined) return undefined
  const temporary = cwd + folder + '.paste-here-' + Date.now() + '.part'
  const got = await askOrigin($, origin, 'get ' + encodeForOrigin(absolute), temporary)
  const relative = got !== undefined && got.exitCode === 0
    ? await settle($, cwd, folder, temporary, splitName(absolute).name, 'mv')
    : undefined
  if (relative === undefined) {
    await $.process.run(['rm', '-f', temporary])
    return undefined
  }
  return { text: relative, changed: true, copied: true }
}

// Returns the text to put in the prompt for one path, or undefined when the
// path does not exist. 'changed' tells if the text is different from the path.
// A file on this computer has priority over a file on the origin.
async function placePath($, cwd, origin, absolute) {
  const stat = await $.fs.stat(absolute, { resolve: true }).catch(() => undefined)
  if (!stat || !stat.realPath || stat.kind === 'other') {
    return origin === '' ? undefined : fetchFromOrigin($, cwd, origin, absolute)
  }
  if (stat.realPath + '/' === cwd) return { text: '.', changed: true }
  if (stat.realPath.startsWith(cwd)) return { text: './' + stat.realPath.slice(cwd.length), changed: true }
  if (stat.kind !== 'file' || stat.size > MAX_BYTES) return { text: absolute, changed: false }
  const folder = await targetFolder($, cwd)
  if (folder === undefined) return undefined
  const relative = await settle($, cwd, folder, absolute, splitName(absolute).name, 'cp')
  return relative === undefined ? undefined : { text: relative, changed: true, copied: true }
}

// Returns the pasted text with each path replaced, or undefined when the
// paste must stay as it is.
async function rewritePaste($, raw) {
  const tokens = tokenize(raw.trim())
  if (!tokens || tokens.length === 0 || tokens.length > MAX_PATHS) return undefined
  const { home, origin } = await readEnvironment($)
  const cwd = await workingDirectory($)
  const parts = []
  const copies = []
  const refused = []
  let changed = false
  for (const token of tokens) {
    const absolute = toAbsolute(token, home)
    if (absolute === undefined) return undefined
    const placed = await placePath($, cwd, origin, absolute)
    if (placed === undefined) return undefined
    parts.push(quotePath(placed.text))
    changed = changed || placed.changed
    if (placed.copied) copies.push(placed.text)
    if (placed.refused) refused.push(absolute)
  }
  if (refused.length > 0) $.ui.toast('Not copied, because the folder is not in ~/.paste-here/allowed_dirs on your computer: ' + refused.join(', '))
  if (!changed) return undefined
  if (copies.length > 0) $.ui.toast('Copied to ' + copies.join(', '))
  return raw.match(/^\s*/)[0] + parts.join(' ') + raw.match(/\s*$/)[0]
}

function timestamp() {
  const d = new Date()
  const two = n => String(n).padStart(2, '0')
  return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds())
}

// Returns a relative path for the clipboard image that no file has.
async function clipboardTarget($, cwd, requestedName) {
  const folder = await targetFolder($, cwd)
  if (folder === undefined) return undefined
  let name = requestedName.replace(/[\/\\]/g, '-') || 'clipboard-' + timestamp()
  if (!/\.png$/i.test(name)) name += '.png'
  const { stem, ext } = splitName(name)
  let relative = folder + name
  for (let n = 1; n < 100 && (await $.fs.exists(cwd + relative)); n++) relative = folder + stem + '-' + n + ext
  return relative
}

// Saves the clipboard image of the origin. Returns the text for the prompt,
// or undefined when the origin has no image or is not available.
async function saveOriginClipboard($, cwd, origin, requestedName) {
  const relative = await clipboardTarget($, cwd, requestedName)
  if (relative === undefined) return undefined
  const got = await askOrigin($, origin, 'clipboard', cwd + relative)
  if (got !== undefined && got.exitCode === 0) return quotePath('./' + relative)
  await $.process.run(['rm', '-f', cwd + relative])
  return undefined
}

// The AppleScript that prints the path of each file on the clipboard, for
// example a file that was copied in Finder.
const CLIPBOARD_FILES_SCRIPT = [
  'use framework "AppKit"',
  'use scripting additions',
  "set pb to current application's NSPasteboard's generalPasteboard()",
  "set urls to pb's readObjectsForClasses:{current application's NSURL} options:{NSPasteboardURLReadingFileURLsOnly:true}",
  'if urls is missing value then return ""',
  'set out to ""',
  "repeat with i from 1 to (urls's |count|())",
  "set out to out & (((urls's objectAtIndex:(i - 1))'s |path|()) as text) & linefeed",
  'end repeat',
  'return out',
]

// Returns the paths of the files on the clipboard. In an SSH session, that
// is the clipboard of the origin. If not, it is the clipboard of this
// computer (macOS).
async function clipboardFiles($, origin, platform) {
  let result
  if (origin !== '') result = await askOrigin($, origin, 'clipboard-files')
  else if (platform === 'macos') result = await $.process.run(['osascript', ...CLIPBOARD_FILES_SCRIPT.flatMap(line => ['-e', line])])
  if (!result || result.exitCode !== 0) return []
  return result.stdout.split('\n').map(line => line.trim()).filter(line => line.startsWith('/')).slice(0, MAX_PATHS)
}

// Saves the clipboard image of this computer (macOS). Returns the text for
// the prompt, or undefined when the clipboard has no image.
async function saveLocalImage($, cwd, requestedName) {
  const relative = await clipboardTarget($, cwd, requestedName)
  if (relative === undefined) return undefined
  const saved = await $.process.run([
    'osascript',
    '-e', 'on run argv',
    '-e', 'set png to (the clipboard as «class PNGf»)',
    '-e', 'set f to open for access (POSIX file (item 1 of argv)) with write permission',
    '-e', 'set eof f to 0',
    '-e', 'write png to f',
    '-e', 'close access f',
    '-e', 'end run',
    cwd + relative,
  ])
  return saved.exitCode === 0 ? quotePath('./' + relative) : undefined
}

export function register(on) {
  // A paste or a dragged file arrives as one edit with no key.
  on('prompt.edit', async ($, e, next) => {
    if (e.key !== undefined || !looksLikePaths(e.inputText)) return next(e)
    const inputText = await rewritePaste($, e.inputText)
    return next(inputText === undefined ? e : { ...e, inputText })
  })

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'paste-file',
        description: 'Put the file or the image that is on the clipboard in the working directory, and its path in the prompt',
        argumentHint: '[name for an image]',
        immediate: true,
      })
    } catch {
      // Another command has this name. The paste hook continues to work.
    }
    return next(e)
  })

  // The clipboard can hold files (copied in Finder) or an image (a
  // screenshot). Files have priority.
  on('command.run', { command: 'paste-file' }, async ($, e) => {
    const { origin } = await readEnvironment($)
    const { platform } = await $.session.info()
    if (origin === '' && platform !== 'macos') return { text: '/paste-file needs macOS, or a remote host that has the paste-origin host in ~/.ssh/config. Run origin/setup.sh on your computer.' }
    const cwd = await workingDirectory($)
    const pasted = []
    const notes = []
    for (const path of await clipboardFiles($, origin, platform)) {
      const placed = origin !== '' ? await fetchFromOrigin($, cwd, origin, path) : await placePath($, cwd, '', path)
      if (placed && placed.changed) pasted.push(quotePath(placed.text))
      else if (placed && placed.refused) notes.push('Not copied: the folder of ' + path + ' is not in ~/.paste-here/allowed_dirs on your computer.')
      else notes.push('Not copied: ' + path + ' is a folder, is too large, or cannot be read.')
    }
    if (pasted.length === 0 && notes.length === 0) {
      const name = e.args.trim()
      const image = origin !== '' ? await saveOriginClipboard($, cwd, origin, name) : await saveLocalImage($, cwd, name)
      if (image !== undefined) pasted.push(image)
    }
    if (pasted.length === 0) {
      if (notes.length > 0) return { text: notes.join('\n') }
      if (origin !== '' && Date.now() < originDownUntil) return { text: 'The SSH host ' + origin + ' does not connect. Open a new SSH connection from your computer, then try again in one minute.' }
      return { text: 'The clipboard has no file and no image.' }
    }
    const filled = await $.prompt.fill({ text: pasted.join(' ') + ' ', mode: 'insert' })
    const lines = filled.isFilled ? notes : ['Saved the clipboard to ' + pasted.join(' '), ...notes]
    return lines.length > 0 ? { text: lines.join('\n') } : {}
  })
}

// paste-file: the /paste-file command copies the files or the image that are
// on the clipboard into a private temporary folder and puts the paths in the
// prompt box.
//
// The folder is claude-paste-file-<user id> in $TMPDIR, or in /tmp when that
// variable is not set. Only your user can read it, and the operating system
// deletes old files there.
//
// On a remote host, the clipboard is on the computer that has your terminal
// (the origin), not on the computer that runs Claude Code. The mod then gets
// the clipboard through the SSH host 'paste-origin'. origin/setup.sh makes
// that host.

// A larger file is not copied.
const MAX_BYTES = 200 * 1024 * 1024
// The command takes this many files from the clipboard at most.
const MAX_PATHS = 20
// The SSH host of the origin. The CLAUDE_PASTE_FILE_ORIGIN variable replaces it.
const ORIGIN_HOST = 'paste-origin'
const SSH_OPTIONS = '-o BatchMode=yes -o ConnectTimeout=5'

// Prints the origin and the paste folder. It makes the paste folder for this
// user only, and it does not use a folder that a different user made.
const ENVIRONMENT_SCRIPT = [
  'echo "origin=$CLAUDE_PASTE_FILE_ORIGIN"',
  'echo "configured=$(grep -Ecs "^[Hh]ost[[:space:]]+' + ORIGIN_HOST + '([[:space:]]|\\$)" "$HOME/.ssh/config")"',
  'd="${TMPDIR:-/tmp}"',
  'd="${d%/}/claude-paste-file-$(id -u)"',
  'mkdir -p -m 700 "$d" 2>/dev/null',
  '[ -d "$d" ] && [ -O "$d" ] && [ ! -L "$d" ] && chmod 700 "$d" && echo "dir=$d"',
].join('\n')

let environment
let originDownUntil = 0

// Puts quotes around a path that has a space or another special character.
export function quotePath(path) {
  if (/^[\w@%+=:,.\/-]+$/.test(path)) return path
  return '"' + path.replace(/(["\\])/g, '\\$1') + '"'
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

// Returns { origin, pasteDir }.
// 'origin' is the SSH host of the origin, or '' when this computer has no
// origin. A computer has an origin when origin/setup.sh added the host
// 'paste-origin' to its ~/.ssh/config. The SSH_CONNECTION variable is not
// used, because a session in tmux or a background session does not have it.
// 'pasteDir' is the paste folder with a slash at its end, or '' when the
// folder is not available.
async function readEnvironment($) {
  if (environment === undefined) {
    const result = await $.process.run(['sh', '-c', ENVIRONMENT_SCRIPT])
    const value = key => {
      const line = result.stdout.split('\n').find(l => l.startsWith(key + '='))
      return line === undefined ? '' : line.slice(key.length + 1)
    }
    const dir = value('dir')
    environment = {
      origin: value('origin') || (Number(value('configured')) > 0 ? ORIGIN_HOST : ''),
      pasteDir: dir === '' ? '' : dir + '/',
    }
  }
  return environment
}

// Sends one request to the origin. With 'dest', the answer goes into that
// file. Returns undefined when the origin is not available. After a failed
// connection, the mod does not try again for 15 seconds.
async function askOrigin($, origin, request, dest) {
  if (Date.now() < originDownUntil) return undefined
  const script = 'exec ssh ' + SSH_OPTIONS + ' "$1" "$2"' + (dest === undefined ? '' : ' > "$3"')
  const argv = ['sh', '-c', script, 'sh', origin, request]
  if (dest !== undefined) argv.push(dest)
  const result = await $.process.run(argv, { timeoutMs: 300000 }).catch(() => undefined)
  if (result === undefined || result.exitCode === 255) {
    originDownUntil = Date.now() + 15000
    return undefined
  }
  return result
}

// Makes sure that the paste folder exists, because the operating system can
// delete it. Returns false when the folder is not available.
async function preparePasteDir($, pasteDir) {
  if (pasteDir === '') return false
  const made = await $.process.run(['mkdir', '-p', '-m', '700', pasteDir])
  return made.exitCode === 0
}

// Puts the file 'source' in the paste folder under 'name'. 'place' is 'cp'
// for a file that must stay where it is and 'mv' for a temporary file.
// A file with the same name and the same content is used again. A file with
// the same name and different content stays, and the new file gets a number.
// Returns the absolute path, or undefined on failure.
async function settle($, pasteDir, source, name, place) {
  const { stem, ext } = splitName(name)
  for (let n = 0; n < 100; n++) {
    const target = pasteDir + (n === 0 ? name : stem + '-' + n + ext)
    if (await $.fs.exists(target)) {
      const same = await $.process.run(['cmp', '-s', source, target], { timeoutMs: 120000 })
      if (same.exitCode !== 0) continue
      if (place === 'mv') await $.process.run(['rm', '-f', source])
      return target
    }
    const placed = await $.process.run([place, source, target], { timeoutMs: 120000 })
    return placed.exitCode === 0 ? target : undefined
  }
  return undefined
}

// Gets one file of the clipboard from the origin. Returns { text } with the
// path of the copy, { refused: true } when the folder of the file is not in
// the allow list of the origin, or undefined when the file cannot be copied.
async function fetchFromOrigin($, pasteDir, origin, absolute) {
  const stat = await askOrigin($, origin, 'stat ' + encodeForOrigin(absolute))
  if (stat === undefined || stat.exitCode !== 0) return undefined
  const answer = stat.stdout.trim()
  if (answer === 'refused') return { refused: true }
  const size = /^file (\d+)$/.exec(answer)
  if (!size || Number(size[1]) > MAX_BYTES) return undefined
  if (!(await preparePasteDir($, pasteDir))) return undefined
  const temporary = pasteDir + '.claude-paste-file-' + Date.now() + '.part'
  const got = await askOrigin($, origin, 'get ' + encodeForOrigin(absolute), temporary)
  const target = got !== undefined && got.exitCode === 0
    ? await settle($, pasteDir, temporary, splitName(absolute).name, 'mv')
    : undefined
  if (target === undefined) {
    await $.process.run(['rm', '-f', temporary])
    return undefined
  }
  return { text: target }
}

// Copies one file of the clipboard of this computer. Returns { text } with
// the path for the prompt, or undefined when the file cannot be copied.
// A file in the working directory is not copied: its path becomes relative.
async function placeLocalFile($, cwd, pasteDir, absolute) {
  const stat = await $.fs.stat(absolute, { resolve: true }).catch(() => undefined)
  if (!stat || !stat.realPath || stat.kind !== 'file' || stat.size > MAX_BYTES) return undefined
  if (stat.realPath.startsWith(cwd)) return { text: './' + stat.realPath.slice(cwd.length) }
  if (absolute.startsWith(pasteDir)) return { text: absolute }
  if (!(await preparePasteDir($, pasteDir))) return undefined
  const target = await settle($, pasteDir, absolute, splitName(absolute).name, 'cp')
  return target === undefined ? undefined : { text: target }
}

function timestamp() {
  const d = new Date()
  const two = n => String(n).padStart(2, '0')
  return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds())
}

// Returns a path in the paste folder for the clipboard image that no file
// has, or undefined when the folder is not available.
async function clipboardTarget($, pasteDir, requestedName) {
  if (!(await preparePasteDir($, pasteDir))) return undefined
  let name = requestedName.replace(/[\/\\]/g, '-') || 'clipboard-' + timestamp()
  if (!/\.png$/i.test(name)) name += '.png'
  const { stem, ext } = splitName(name)
  let target = pasteDir + name
  for (let n = 1; n < 100 && (await $.fs.exists(target)); n++) target = pasteDir + stem + '-' + n + ext
  return target
}

// Saves the clipboard image of the origin. Returns the text for the prompt,
// or undefined when the origin has no image or is not available.
async function saveOriginClipboard($, pasteDir, origin, requestedName) {
  const target = await clipboardTarget($, pasteDir, requestedName)
  if (target === undefined) return undefined
  const got = await askOrigin($, origin, 'clipboard', target)
  if (got !== undefined && got.exitCode === 0) return quotePath(target)
  await $.process.run(['rm', '-f', target])
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

// Returns the paths of the files on the clipboard. On a remote host, that
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
async function saveLocalImage($, pasteDir, requestedName) {
  const target = await clipboardTarget($, pasteDir, requestedName)
  if (target === undefined) return undefined
  const saved = await $.process.run([
    'osascript',
    '-e', 'on run argv',
    '-e', 'set png to (the clipboard as «class PNGf»)',
    '-e', 'set f to open for access (POSIX file (item 1 of argv)) with write permission',
    '-e', 'set eof f to 0',
    '-e', 'write png to f',
    '-e', 'close access f',
    '-e', 'end run',
    target,
  ])
  return saved.exitCode === 0 ? quotePath(target) : undefined
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'paste-file',
        description: 'Put the file or the image that is on the clipboard in the paste folder, and its path in the prompt',
        argumentHint: '[name for an image]',
        immediate: true,
      })
    } catch {
      // Another command has this name.
    }
    return next(e)
  })

  // The clipboard can hold files (copied in Finder) or an image (a
  // screenshot). Files have priority.
  on('command.run', { command: 'paste-file' }, async ($, e) => {
    const { origin, pasteDir } = await readEnvironment($)
    const { platform } = await $.session.info()
    if (origin === '' && platform !== 'macos') return { text: '/paste-file needs macOS, or a remote host that has the paste-origin host in ~/.ssh/config. Run origin/setup.sh on your computer.' }
    if (pasteDir === '') return { text: 'The paste folder is not available. Make sure that the temporary folder (TMPDIR or /tmp) is writable.' }
    const cwd = await workingDirectory($)
    const pasted = []
    const notes = []
    for (const path of await clipboardFiles($, origin, platform)) {
      const placed = origin !== '' ? await fetchFromOrigin($, pasteDir, origin, path) : await placeLocalFile($, cwd, pasteDir, path)
      if (placed && placed.text) pasted.push(quotePath(placed.text))
      else if (placed && placed.refused) notes.push('Not copied: the folder of ' + path + ' is not in ~/.claude-paste-file/allowed_dirs on your computer.')
      else notes.push('Not copied: ' + path + ' is a folder, is too large, or cannot be read.')
    }
    if (pasted.length === 0 && notes.length === 0) {
      const name = e.args.trim()
      const image = origin !== '' ? await saveOriginClipboard($, pasteDir, origin, name) : await saveLocalImage($, pasteDir, name)
      if (image !== undefined) pasted.push(image)
    }
    if (pasted.length === 0) {
      if (notes.length > 0) return { text: notes.join('\n') }
      if (origin !== '' && Date.now() < originDownUntil) return { text: 'The SSH host ' + origin + ' does not connect. Open a new SSH connection from your computer, then try again.' }
      return { text: 'The clipboard has no file and no image.' }
    }
    const filled = await $.prompt.fill({ text: pasted.join(' ') + ' ', mode: 'insert' })
    const lines = filled.isFilled ? notes : ['Saved the clipboard to ' + pasted.join(' '), ...notes]
    return lines.length > 0 ? { text: lines.join('\n') } : {}
  })
}

# claude-paste-file

A mod for Claude Code that takes a file that you paste or drag into the prompt, copies it to a private temporary folder, and puts the path in the prompt. It also operates when Claude Code runs on a remote host through SSH: the file then comes from the computer that has your terminal.

A mod is a plugin with JavaScript hooks. Mods need Claude Code v2.1.287 or later, and the mods API is early access, so an update of Claude Code can change it.

## What it does

- **Drag a file, or paste a path:** the mod copies the file to the paste folder and puts the path of the copy in the prompt. A file that is already in the working directory is not copied: its path becomes relative.
- **`/paste-file [name for an image]`:** the mod takes the files that are on the clipboard (for example, files that you copied in Finder) or the image that is on the clipboard (for example, a screenshot).
- The mod never overwrites a file. A different file with the same name gets a number in its name.
- The mod does not copy folders or files larger than 200 MB.

The clipboard part needs macOS on the computer that has your terminal.

## The paste folder

The paste folder is `claude-paste-file-<user id>` in `$TMPDIR`, or in `/tmp` when that variable is not set. This is the usual rule for temporary files on macOS and Linux. Only your user can read the folder, your projects stay clean, and the operating system deletes old files there. If you want to keep a pasted file, ask Claude to move it into the project.

## Install

```bash
claude plugin marketplace add dawumnam/claude-paste-file
claude plugin install paste-file@paste-file
```

Claude Code asks a question before it reads a file that is not in the working directory. To let it read the paste folder without a question, clone this repository and run this script one time. It adds a `Read` rule for the paste folder to `~/.claude/settings.json`:

```bash
plugin/allow-read.sh
```

## Use it through SSH

On a remote host, the dragged file and the clipboard are on the computer that has your terminal (the origin). The mod gets them through a connection from the remote host back to the origin.

Clone this repository on the origin, then run the setup one time for each remote host:

```bash
plugin/origin/setup.sh <ssh host>
```

The setup needs no administrator rights. It does these steps:

1. Starts a small SSH server of your own user on `127.0.0.1` of the origin, and a clipboard agent.
2. Makes a key on the remote host and adds it to `~/.claude-paste-file/authorized_keys` on the origin.
3. Adds the host `paste-origin` to `~/.ssh/config` on the remote host.
4. Adds a `RemoteForward` and a `LocalCommand` for the remote host to `~/.ssh/config` on the origin.
5. Copies the mod to the remote host, installs it there, and adds the `Read` rule there.
6. Tests the connection.

Two accounts on one remote machine must have different return ports. Set `CLAUDE_PASTE_FILE_REMOTE_PORT` for the second account.

## Security

- The server on the origin listens on `127.0.0.1` only and accepts the keys in `~/.claude-paste-file/authorized_keys` only.
- A key cannot open a shell. It can read the files in the folders of `~/.claude-paste-file/allowed_dirs`, the paths of the files on the clipboard, and the clipboard image.
- This means that a person or a program that controls your account on the remote host can read those folders while your SSH connection is open. Keep the list short.
- `plugin/origin/origind stop` stops the server and the agent.

## Test

```bash
cd plugin && claude plugin test
```

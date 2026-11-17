# claude-mods

Mods for Claude Code. A mod is a plugin with JavaScript hooks. Mods need Claude Code v2.1.287 or later, and the mods API is early access, so an update of Claude Code can change it.

## paste-here

paste-here copies a pasted or dragged file into the working directory of the session and puts the relative path in the prompt. It also operates when Claude Code runs on a remote host through SSH.

- **Drag a file, or paste a path:** the mod copies the file into the working directory and puts `./name` in the prompt. If the file is already in the working directory, the mod only makes the path relative.
- **`/paste-file [name for an image]`:** the mod takes the files that are on the clipboard (for example, files that you copied in Finder) or the image that is on the clipboard (for example, a screenshot).
- The mod never overwrites a file. A different file with the same name gets a number in its name.
- The mod does not copy folders or files larger than 200 MB.

The clipboard part needs macOS on the computer that has your terminal.

### Install

```bash
claude plugin marketplace add dawumnam/claude-mods
claude plugin install paste-here@claude-mods
```

### Use it through SSH

On a remote host, the dragged file and the clipboard are on the computer that has your terminal (the origin). The mod gets them through a connection from the remote host back to the origin.

Clone this repository on the origin, then run the setup one time for each remote host:

```bash
paste-here/origin/setup.sh <ssh host>
```

The setup needs no administrator rights. It does these steps:

1. Starts a small SSH server of your own user on `127.0.0.1` of the origin, and a clipboard agent.
2. Makes a key on the remote host and adds it to `~/.paste-here/authorized_keys` on the origin.
3. Adds the host `paste-origin` to `~/.ssh/config` on the remote host.
4. Adds a `RemoteForward` and a `LocalCommand` for the remote host to `~/.ssh/config` on the origin.
5. Copies the mod to the remote host and installs it there.
6. Tests the connection.

Two accounts on one remote machine must have different return ports. Set `PASTE_HERE_REMOTE_PORT` for the second account.

### Security

- The server on the origin listens on `127.0.0.1` only and accepts the keys in `~/.paste-here/authorized_keys` only.
- A key cannot open a shell. It can read the files in the folders of `~/.paste-here/allowed_dirs`, the paths of the files on the clipboard, and the clipboard image.
- This means that a person or a program that controls your account on the remote host can read those folders while your SSH connection is open. Keep the list short.
- `paste-here/origin/origind stop` stops the server and the agent.

### Test

```bash
cd paste-here && claude plugin test
```

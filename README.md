# claude-paste-file

[![test](https://github.com/dawumnam/claude-paste-file/actions/workflows/test.yml/badge.svg)](https://github.com/dawumnam/claude-paste-file/actions/workflows/test.yml)

A mod for Claude Code that adds the `/paste-file` command. The command takes the files or the image that are on your clipboard, copies them to a private temporary folder, and puts the paths in the prompt. It also operates when Claude Code runs on a remote host through SSH: the clipboard then comes from the computer that has your terminal.

Without the mod, Claude Code on a remote host cannot reach the clipboard of your computer, and a path on your computer does not exist on the remote host.

## What it does

Copy one or more files in Finder, or take a screenshot to the clipboard. Then run `/paste-file` in Claude Code.

- **Files on the clipboard:** the mod copies each file to the paste folder and puts the paths of the copies in the prompt. On macOS, a file that is already in the working directory is not copied: its path becomes relative.
- **An image on the clipboard:** the mod saves it as a PNG. `/paste-file diagram` saves it as `diagram.png`.
- The mod never overwrites a file. A different file with the same name gets a number in its name.
- The mod does not copy folders or files larger than 200 MB.

## Requirements

- Claude Code v2.1.287 or later, on macOS or Linux. A mod is a plugin with JavaScript hooks, and the mods API is early access, so an update of Claude Code can change it.
- macOS on the computer that has your terminal, because the mod reads the macOS clipboard.
- For `plugin/allow-read.sh`: `python3`.

## Install

```bash
claude plugin marketplace add dawumnam/claude-paste-file
claude plugin install paste-file@paste-file
```

Claude Code asks a question before it reads a file that is not in the working directory. To let it read the paste folder without a question, clone this repository and run this script one time. It adds a `Read` rule for the paste folder to `~/.claude/settings.json`:

```bash
git clone https://github.com/dawumnam/claude-paste-file
claude-paste-file/plugin/allow-read.sh
```

For a remote host, do not do these steps on the host. The SSH setup below does them.

## The paste folder

The paste folder is `claude-paste-file-<user id>` in `$TMPDIR`, or in `/tmp` when that variable is not set. This is the usual rule for temporary files on macOS and Linux. Only your user can read the folder, your projects stay clean, and the operating system deletes old files there. If you want to keep a pasted file, ask Claude to move it into the project.

## Use it through SSH

On a remote host, the clipboard and its files are on the computer that has your terminal (the origin). The mod on the remote host gets them through a connection back to the origin:

```text
origin (your terminal)                      remote host (Claude Code)
ssh <host>  ------------------------------> sshd
origin server on 127.0.0.1  <-- return port --  paste-file mod: ssh paste-origin
```

Clone this repository on the origin, then run the setup one time for each remote host:

```bash
claude-paste-file/plugin/origin/setup.sh <ssh host>
```

Then open a new SSH connection to the host. The mod loads in each new Claude Code session there.

The setup needs no administrator rights, and you can run it again at any time. It makes these changes:

| Where | What |
| :- | :- |
| Origin, `~/.claude-paste-file/` | The origin programs, the key of the origin server, the accepted keys and the list of allowed folders |
| Origin, `~/.ssh/config` | One block for the host, with a `RemoteForward` for the return port and a `LocalCommand` that starts the origin server |
| Remote host, `~/.ssh/` | The key `claude_paste_file_ed25519` and the host `paste-origin` in `config` |
| Remote host, `~/claude-paste-file/` | The mod, installed for your user |
| Remote host, `~/.claude/settings.json` | The `Read` rule for the paste folder |

For a new host, the return port is 47000 plus the last three digits of your user id on the remote host, so two accounts on one machine get different ports. A host that has a setup keeps its port when you run the setup again, because the SSH connections that are open use that port. To set a different port, use the variable `CLAUDE_PASTE_FILE_REMOTE_PORT`, and then open new SSH connections.

## Security

- The origin server listens on `127.0.0.1` only and accepts the keys in `~/.claude-paste-file/authorized_keys` only. It is not the system SSH server, and it does not change Remote Login.
- A key cannot open a shell. It can read the files in the folders of `~/.claude-paste-file/allowed_dirs`, the paths of the files on the clipboard, and the clipboard image.
- This means that a person or a program that controls your account on the remote host can read those folders and the clipboard while your SSH connection is open. Claude Code on the remote host is such a program.
- The default list is Desktop, Downloads, Documents, Pictures and the temporary folders. Edit `~/.claude-paste-file/allowed_dirs` to make it shorter. A symbolic link that goes out of an allowed folder is refused.

## Update

```bash
cd claude-paste-file && git pull
plugin/origin/setup.sh <ssh host>        # for each remote host
claude plugin update paste-file@paste-file   # on a computer that installed it from GitHub
```

## Uninstall

```bash
plugin/origin/uninstall.sh <ssh host>    # for each remote host
plugin/origin/uninstall.sh --local       # the origin server and its files
claude plugin uninstall paste-file@paste-file
plugin/allow-read.sh --remove
```

## Troubleshooting

| Problem | Solution |
| :- | :- |
| `/paste-file` says that it needs macOS or the `paste-origin` host | You are on a remote host that has no setup. Run `plugin/origin/setup.sh <ssh host>` on the origin. |
| `The SSH host paste-origin does not connect` | The return port opens when an SSH connection starts. Open a new connection to the host. On the origin, `~/.claude-paste-file/bin/origind status` must show that the server and the clipboard agent run. |
| `Warning: remote port forwarding failed for listen port` | You have a second connection to the same host, and the first connection holds the return port. The warning does no harm. If you close the first connection, open a new one. |
| `Not copied ... allowed_dirs` | The folder of the file is not in `~/.claude-paste-file/allowed_dirs` on the origin. Add the folder, or move the file. |
| Claude asks a question before it reads a pasted file | Run `plugin/allow-read.sh` on the computer that runs Claude Code. |
| `/paste-file` is not in the list of commands | Run `/plugin` and make sure that the line `1 mod active` shows `paste-file`. In an open session, run `/reload-plugins`. |

## Development

```bash
cd plugin && claude plugin test      # the mod
bash plugin/tests/origin.test.sh     # the shell programs of the origin
claude plugin validate .
```

The files:

- `plugin/hooks/register.js`: the mod.
- `plugin/origin/origind` and `serve.sh`: the origin server and the program that answers a connection.
- `plugin/origin/setup.sh`, `uninstall.sh` and `ssh-block.sh`: the SSH setup.
- `plugin/allow-read.sh`: the `Read` rule.

## License

[MIT](LICENSE)

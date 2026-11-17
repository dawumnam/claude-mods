# Changelog

## 1.0.1 - 2026-11-18

- When the origin does not connect, a drag now shows a message. Before, the path stayed in the prompt with no message.
- `setup.sh` keeps the return port of a host that has a setup. Before, a second run could change the port, and the open SSH connections then stopped operating.
- A file name that has a space character other than the ASCII space, as the name of a macOS screenshot has, is now one path.
- A debug log shows what the mod receives. See the troubleshooting table in the README.

## 1.0.0 - 2026-11-18

First release.

- A dragged file or a pasted path is copied to a private temporary folder, and the path goes into the prompt.
- `/paste-file` takes the files or the image that are on the clipboard.
- On a remote host, the file and the clipboard come from the computer that has your terminal, through an SSH connection back to it.
- `plugin/origin/setup.sh` and `plugin/origin/uninstall.sh` make and remove the SSH setup. The setup needs no administrator rights.
- `plugin/allow-read.sh` lets Claude Code read the paste folder without a question.

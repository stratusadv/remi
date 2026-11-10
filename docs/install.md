# Install

## Overview

Download the file for your system from the [latest release](https://github.com/stratusadv/scribe/releases/latest). The app updates itself after that.

| System | File | Install |
|--------|------|---------|
| Windows 10 and 11 | `scribe_<version>_x64-setup.exe` | Run it. If SmartScreen warns, choose *More info*, then *Run anyway*. |
| Ubuntu and Debian | `scribe_<version>_amd64.deb` | Run `sudo apt install ./<file>`. |
| Fedora | `scribe-<version>-1.x86_64.rpm` | Run `sudo dnf install ./<file>`. |
| Arch and other recent Linux | `scribe_<version>_amd64.AppImage` | Run `chmod +x <file>`, then open it. |

## Updates

The app checks for a new version when it starts and offers to install it.

## Uninstall

Remove the app the usual way for your system. Your recordings, notes, and keys stay behind, so tick *Delete the application data* in the Windows uninstaller, or delete `~/.local/share/com.stratusadv.scribe` on Linux. A microphone capture stays in its own folder.

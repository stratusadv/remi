# Install

## Overview

Download the file for your system from the [latest release](https://github.com/stratusadv/remi/releases/latest). The app updates itself after that.

| System | File | Install |
|--------|------|---------|
| Windows 10 and 11 | `Remi.Remembers_<version>_x64-setup.exe` | Run it. If SmartScreen warns, choose *More info*, then *Run anyway*. |
| macOS 14 and later | `Remi.Remembers_<version>_universal.dmg` | Open it and drag *Remi Remembers* into *Applications*. The first launch needs the steps below. |
| Ubuntu and Debian | `Remi.Remembers_<version>_amd64.deb` | Run `sudo apt install ./<file>`. |
| Fedora | `Remi.Remembers-<version>-1.x86_64.rpm` | Run `sudo dnf install ./<file>`. |
| Arch and other recent Linux | `Remi.Remembers_<version>_amd64.AppImage` | Run `chmod +x <file>`, then open it. |

## First Launch on macOS

The app is not yet notarized by Apple, so macOS refuses the first launch with a message that Apple cannot check or verify it.

1. Close that message with *OK* or *Done*, not *Move to Trash*.
2. Open *System Settings*, then *Privacy & Security*, and choose *Open Anyway* beside the line about Remi Remembers.
3. Enter your Mac's password, then choose *Open*.

macOS remembers the choice, so each later launch and each update opens without asking. The first recording asks for the microphone; choose *Allow*.

## Updates

The app checks for a new version when it starts and offers to install it.

## Uninstall

Remove the app the usual way for your system. Your recordings, notes, and keys stay behind, so tick *Delete the application data* in the Windows uninstaller, delete `~/.local/share/com.stratusadv.remi` on Linux, or drag *Remi Remembers* from *Applications* to the Trash and delete `~/Library/Application Support/com.stratusadv.remi` on macOS. A microphone capture stays in its own folder.

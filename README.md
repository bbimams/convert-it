<div align="center">
  <img src="src/assets/convert-it-logo.png" alt="Convert It" width="420" />

  <p><strong>A focused desktop interface for FFmpeg conversion, trimming, filtering, and GIF export.</strong></p>

  <p>
    <a href="#features">Features</a> ·
    <a href="#install">Install</a> ·
    <a href="#development">Development</a> ·
    <a href="#releasing">Releasing</a>
  </p>
</div>

## About

Convert It is a native desktop media utility built with Tauri 2, Rust, TypeScript, and Vite. It provides a visual workflow for common FFmpeg operations while showing the generated command before conversion.

Conversion runs locally. Media files are passed directly to the FFmpeg installation on your computer; the application does not upload them to a remote service.

## Features

- Convert video to MP4, MKV, WebM, MOV, MP3, or WAV.
- Select H.264, H.265, VP9, or stream-copy video output.
- Configure CRF, encoder presets, audio codecs, and audio bitrate.
- Trim one or more segments and export them as one joined file or separate files.
- Apply crop, scale, denoise, and text-watermark filters.
- Export GIFs with configurable frame rate, width, and high-quality palettes.
- Preview the generated FFmpeg command.
- Monitor progress and cancel a running conversion.
- Keep media processing local to the machine.

## Requirements

### Running a release build

- A supported 64-bit version of macOS, Windows, or Linux.
- [`ffmpeg`](https://ffmpeg.org/) and `ffprobe` installed and available on `PATH`.

Install FFmpeg with a common package manager:

| Platform | Command |
| --- | --- |
| macOS | `brew install ffmpeg` |
| Windows | `winget install --id Gyan.FFmpeg -e` |
| Ubuntu/Debian | `sudo apt update && sudo apt install ffmpeg` |
| Fedora | `sudo dnf install ffmpeg` |
| Arch Linux | `sudo pacman -S ffmpeg` |

Restart Convert It after installing FFmpeg so the desktop process receives the updated environment.

### Building from source

- [Bun](https://bun.sh/) 1.4 or newer.
- [Rust](https://www.rust-lang.org/tools/install) stable.
- The platform prerequisites from the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/).
- FFmpeg and ffprobe for exercising conversions.
- GNU Make for the documented shortcuts. Equivalent Bun commands are shown below.

## Install

Download the installer for your operating system from the repository's **Releases** page:

- macOS Apple Silicon: `aarch64` DMG.
- macOS Intel: `x86_64` DMG.
- Windows x64: MSI or setup executable.
- Linux x64: AppImage, Debian package, or RPM when produced by the Tauri runner.

> macOS and Windows may show an operating-system warning when artifacts are published without a configured code-signing certificate. See [Release signing](#release-signing) before distributing to end users.

## Development

Clone the repository, then install the locked dependencies:

```sh
git clone <repository-url>
cd convert-it
make install
```

Run the native development application:

```sh
make dev
```

Useful commands:

| Make command | Direct command | Purpose |
| --- | --- | --- |
| `make install` | `bun install --frozen-lockfile` | Install locked frontend dependencies. |
| `make dev` | `bun run tauri dev` | Run Vite and the Tauri desktop shell. |
| `make test` | `bun test` | Run the UI verification suite. |
| `make build` | `bun run build` | Type-check and build the frontend. |
| `make bundle` | `bun run tauri build` | Build native bundles for the current platform. |
| `make release-check` | `bun run release:check` | Validate tests, builds, Rust, versions, and workflow presence. |
| `make release-dry-run VERSION=x.y.z` | `bun run release -- --dry-run x.y.z` | Check the remote and tag without changing files. |

Production bundles created locally are written below `src-tauri/target/release/bundle/`.

## Project structure

```text
.
├── .github/workflows/release.yml  # Cross-platform GitHub release pipeline
├── scripts/release.ts             # Version, validation, tag, and push helper
├── src/                           # TypeScript application and styles
├── src-tauri/                     # Rust backend and Tauri configuration
├── verify/                        # Bun UI verification suite
├── index.html                     # Desktop UI document
├── Makefile                       # Development and release commands
└── package.json                   # Frontend dependencies and scripts
```

## Releasing

The release contract is a version tag named `vMAJOR.MINOR.PATCH`. A pushed tag starts `.github/workflows/release.yml`, which validates the version and builds installers on macOS Apple Silicon, macOS Intel, Windows x64, and Linux x64. All successful jobs upload their artifacts to one GitHub Release.

### One-command release

Start from the branch and commit that should be released. The working tree must be clean and the repository must have an `origin` remote.

Preview the remote/tag checks without changing files:

```sh
make release-dry-run VERSION=0.2.0
```

Create and push the release:

```sh
make release VERSION=0.2.0
```

The command:

1. Validates the semantic version and confirms the tag does not already exist.
2. Updates `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
3. Refreshes and validates lockfiles.
4. Runs the UI suite, frontend production build, and Rust check.
5. Commits the synchronized version as `chore(release): v0.2.0`.
6. Creates an annotated `v0.2.0` tag.
7. Pushes the commit and tag to `origin`.
8. Lets GitHub Actions create the release and attach native installers.

Prereleases are supported:

```sh
make release VERSION=0.2.0-rc.1
```

Tags containing a prerelease suffix are published as GitHub prereleases.

### Manual workflow run

The workflow can be rerun from **Actions → Release → Run workflow**. Enter an existing tag such as `v0.2.0`; the workflow checks out that tag and rebuilds its release assets.

### Distribution and signing

This automation publishes installers only to GitHub Releases. It does not upload or deploy Convert It to the Apple App Store, Microsoft Store, or any Linux software repository.

Artifacts are unsigned unless you add signing separately. Unsigned macOS and Windows downloads can trigger operating-system warnings. Signing is intentionally outside this release workflow; add it only when you are ready to distribute trusted public binaries.

## Security model

- File selection uses Tauri's native dialog plugin.
- Preview access is granted only after ffprobe successfully reads the selected file.
- Conversion input is restricted to the currently probed file.
- FFmpeg arguments are checked against an explicit option allowlist before process creation.
- The application invokes FFmpeg without a command shell.

Report security-sensitive issues privately to the repository owner rather than opening a public issue with exploit details.

## Troubleshooting

### `ffmpeg not found` or `ffprobe not found`

Confirm both binaries are available from a new terminal:

```sh
ffmpeg -version
ffprobe -version
```

If those commands work, restart Convert It. Windows users installing through WinGet or Chocolatey may need to sign out or restart before GUI applications inherit the new `PATH`.

### Linux build dependencies are missing

Install the packages required by Tauri 2 for your distribution. Ubuntu 22.04 uses:

```sh
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf xdg-utils
```

### A release did not start

Check that the pushed tag has the exact form `v1.2.3` or a supported prerelease form such as `v1.2.3-rc.1`, and that the three application version files match the tag without the leading `v`.

## License

No license file is currently included. Until one is added, the source remains under the repository owner's default copyright and is not automatically licensed for redistribution or modification.

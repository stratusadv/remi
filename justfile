set shell := ["sh", "-c"]
set windows-shell := ["powershell.exe", "-c"]

manifest := "src-tauri/Cargo.toml"

webview_software := if os() == "linux" {
    "GDK_BACKEND=x11 WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 " +
    "__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json " +
    "LIBGL_ALWAYS_SOFTWARE=1"
} else { "" }

[doc('Build the installers for the host platform')]
build:
    bun run tauri build

[doc('Check the frontend types and that the backend compiles')]
check:
    bun run typecheck
    cargo check --manifest-path {{ manifest }} --workspace --all-targets

[doc('Run the continuous integration pipeline')]
ci:
    cargo +nightly fmt --manifest-path {{ manifest }} --all --check
    cargo clippy --manifest-path {{ manifest }} --workspace --all-targets -- -D warnings
    cargo test --manifest-path {{ manifest }} --workspace
    bun run typecheck
    bun run lint
    bun run test
    just test-e2e

[doc('Remove the build outputs')]
clean:
    cargo clean --manifest-path {{ manifest }}

[doc('Build the documentation site and fail on a broken link')]
docs:
    uv run --only-group docs zensical build --strict

[doc('Run ESLint and apply its fixes')]
fix:
    bun run lint:fix

[doc('Format the backend')]
fmt:
    cargo +nightly fmt --manifest-path {{ manifest }} --all

[doc('Regenerate src-tauri/icons from the source icon')]
icon:
    bun run tauri icon assets/scribe-icon-on-dark.svg

[doc('Build the Debian package and install it with apt')]
[linux]
install:
    bun run tauri build --bundles deb --no-sign
    sudo apt install ./src-tauri/target/release/bundle/deb/scribe_$(bun -p "require('./src-tauri/tauri.conf.json').version")_amd64.deb

[doc('Lint the tree with tigerstyle-lsp, the backend with Clippy, and the frontend with ESLint, and check the backend format')]
lint:
    tigerstyle-lsp check . --format concise
    cargo clippy --manifest-path {{ manifest }} --workspace --all-targets -- -D warnings
    bun run lint
    cargo +nightly fmt --manifest-path {{ manifest }} --all --check

[doc('Lint the backend for Windows with Clippy from any host')]
lint-windows:
    cargo xwin clippy --manifest-path {{ manifest }} --workspace --target x86_64-pc-windows-msvc --all-targets -- -D warnings

[default]
[doc('List every recipe')]
list:
    @just --list

[doc('Run the app with hot reload')]
run:
    bun run tauri dev

[doc('Serve the documentation site with live reload')]
run-docs:
    uv run --only-group docs zensical serve

[doc('Run the app with hot reload on the software renderer')]
run-software:
    {{ webview_software }} bun run tauri dev

[doc('Install the frontend dependencies')]
setup:
    bun install

[doc('Run the Rust tests and the frontend tests')]
test:
    cargo test --manifest-path {{ manifest }} --workspace
    bun run test

[doc('Run the end-to-end tests in Chromium against the mock backend')]
test-e2e:
    bun run test:e2e

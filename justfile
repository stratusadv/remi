set dotenv-load
set shell := ["sh", "-c"]
set windows-shell := ["powershell.exe", "-c"]

manifest := "src-tauri/Cargo.toml"

webview_software := if os() == "linux" {
    "GDK_BACKEND=x11 WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 " +
    "__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json " +
    "LIBGL_ALWAYS_SOFTWARE=1"
} else { "" }

[doc('Benchmark the Ask search at a typical, a heavy, and the largest library the app allows')]
bench:
    cargo test --manifest-path {{ manifest }} --config 'profile.dev.opt-level=3' --lib search::benchmark -- --ignored --nocapture

[doc('Benchmark Ask against the live notes service named in .env')]
[unix]
bench-live:
    REMI_MANUAL_NOTES_HOST="$REMI_API_HOST" REMI_MANUAL_NOTES_KEY="$REMI_API_KEY_NOTES" REMI_MANUAL_NOTES_MODEL="${REMI_MANUAL_NOTES_MODEL:-stratus.thinking}" cargo test --manifest-path {{ manifest }} --lib notes::benchmark -- --ignored --nocapture

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
    just server-lint
    just server-test

[doc('Remove the build outputs')]
clean:
    cargo clean --manifest-path {{ manifest }}

[doc('Build the documentation site and fail on a broken link')]
docs:
    uv run --only-group docs zensical build --strict

[doc('Serve the documentation site with live reload')]
docs-run:
    uv run --only-group docs zensical serve

[doc('Grade Ask answers against the live notes service named in .env')]
[unix]
eval-live:
    REMI_MANUAL_NOTES_HOST="$REMI_API_HOST" REMI_MANUAL_NOTES_KEY="$REMI_API_KEY_NOTES" REMI_MANUAL_NOTES_MODEL="${REMI_MANUAL_NOTES_MODEL:-stratus.thinking}" cargo test --manifest-path {{ manifest }} --lib notes::evaluation::manual_answers -- --ignored --nocapture

[doc('Run ESLint and apply its fixes')]
fix:
    bun run lint:fix

[doc('Format the backend')]
fmt:
    cargo +nightly fmt --manifest-path {{ manifest }} --all

[doc('Regenerate src-tauri/icons and the docs favicon from the source icons, with the small cut at 48 pixels and under and the padded icons for macOS')]
icon:
    bun run tauri icon assets/remi-icon-on-dark.svg
    bun run tauri icon assets/remi-icon-small-on-dark.svg --output target/icon-small
    bun run tauri icon assets/remi-icon-padded-on-dark.svg --output target/icon-padded
    bun run tauri icon assets/remi-icon-padded-small-on-dark.svg --output target/icon-padded-small
    cp target/icon-small/32x32.png src-tauri/icons/32x32.png
    cp target/icon-small/32x32.png docs/assets/remi-icon-32.png
    uv run -q --no-project python design/icon_splice.py .

[doc('Build the Debian package and install it with apt')]
[linux]
install:
    bun run tauri build --bundles deb --no-sign
    sudo apt install "./src-tauri/target/release/bundle/deb/Remi Remembers_$(bun -p "require('./src-tauri/tauri.conf.json').version")_amd64.deb"

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

[doc('Run the app with hot reload on the software renderer')]
run-software:
    {{ webview_software }} bun run tauri dev

[doc('Start the PostgreSQL container the server runs and tests against')]
[working-directory('server')]
server-db:
    docker compose up --detach --wait

[doc('Lint the server with Ruff and check its types with ty')]
[working-directory('server')]
server-lint:
    uv run --locked ruff check .
    uv run --locked ty check

[doc('Migrate the local database and run the server on port 8001, beside the docs on 8000')]
[working-directory('server')]
server-run: server-db
    uv run --locked manage.py migrate
    uv run --locked manage.py runserver 127.0.0.1:8001

[doc('Install the server dependencies')]
[working-directory('server')]
server-sync:
    uv sync --locked

[doc('Run the server tests in parallel against the local database')]
[working-directory('server')]
server-test: server-db
    uv run --locked pytest -n auto

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

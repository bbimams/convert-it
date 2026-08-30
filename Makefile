.DEFAULT_GOAL := help

.PHONY: help install dev test build bundle release release-dry-run release-check

help:
	@printf '%s\n' \
	  'Convert It development commands:' \
	  '  make install              Install locked frontend dependencies' \
	  '  make dev                  Run the Tauri development app' \
	  '  make test                 Run the UI verification suite' \
	  '  make build                Build the production frontend' \
	  '  make bundle               Build native bundles for this platform' \
	  '  make release VERSION=x.y.z Validate, tag, and push a GitHub release' \
	  '  make release-dry-run VERSION=x.y.z Check remote and tag without changes' \
	  '  make release-check        Validate release configuration locally'

install:
	bun install --frozen-lockfile

dev:
	bun run tauri dev

test:
	bun test

build:
	bun run build

bundle:
	bun run tauri build

release:
	@test -n "$(VERSION)" || (printf '%s\n' 'VERSION is required. Example: make release VERSION=0.2.0' >&2; exit 2)
	bun scripts/release.ts "$(VERSION)"

release-dry-run:
	@test -n "$(VERSION)" || (printf '%s\n' 'VERSION is required. Example: make release-dry-run VERSION=0.2.0' >&2; exit 2)
	bun scripts/release.ts --dry-run "$(VERSION)"

release-check:
	bun scripts/release.ts --verify

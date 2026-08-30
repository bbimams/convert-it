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
	  '  make release              Auto-increment patch, tag, and publish a GitHub release' \
	  '  make release-dry-run      Preview the automatically selected version' \
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
	bun scripts/release.ts

release-dry-run:
	bun scripts/release.ts --dry-run

release-check:
	bun scripts/release.ts --verify

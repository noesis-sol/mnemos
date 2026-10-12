#!/bin/sh
# scripts/check-fast.sh: orchestra's merge check, run on every ticket rebased onto work merged while it ran.
# orchestra init wrote it; it is the project's to edit. Each suite is one command, run from the
# repository's root, and finds its own test files: a new test in an existing suite needs no edit here.
set -e
cd "$(dirname "$0")/.."

# dependencies, from .github/workflows/ci.yml:22: a fresh worktree has no node_modules, so install
# them when missing or older than package-lock.json (the build's `tsc` needs @types/node)
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
	printf '%s\n' 'SUITE: dependencies (npm ci)'
	npm ci --ignore-scripts
fi

# build (tsc), from package.json:13
printf '%s\n' 'SUITE: build (tsc)'
npm run build

# unit tests, from package.json:16
printf '%s\n' 'SUITE: unit tests'
npm test

#!/bin/sh
# scripts/check-fast.sh: orchestra's merge check, run on every ticket rebased onto work merged while it ran.
# orchestra init wrote it; it is the project's to edit. Each suite is one command, run from the
# repository's root, and finds its own test files: a new test in an existing suite needs no edit here.
set -e
cd "$(dirname "$0")/.."

# build (tsc), from package.json:13
printf '%s\n' 'SUITE: build (tsc)'
npm run build

# unit tests, from package.json:16
printf '%s\n' 'SUITE: unit tests'
npm test

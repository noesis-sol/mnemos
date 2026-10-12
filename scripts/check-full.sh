#!/bin/sh
# scripts/check-full.sh: every check, scripts/check-fast.sh then the slower suites. orchestra runs it once at
# the end of a run.
# orchestra init wrote it; it is the project's to edit. Each suite is one command, run from the
# repository's root, and finds its own test files: a new test in an existing suite needs no edit here.
set -e
cd "$(dirname "$0")/.."

# from the merge check
printf '%s\n' 'SUITE: scripts/check-fast.sh'
scripts/check-fast.sh

# package dry run, from .github/workflows/ci.yml:25
printf '%s\n' 'SUITE: package dry run'
npm pack --dry-run

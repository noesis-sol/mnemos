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

# published package (e2e): packs the tarball (building through `prepare`), unpacks it, checks its
# files and bin, and starts the server through the bin. Kept out of `npm test`'s discovery.
printf '%s\n' 'SUITE: published package (e2e)'
node --test e2e/package.e2e.js

# the real embedding model (e2e, opt-in): downloads about 135 MB from Hugging Face, so it skips
# itself unless MNEMOS_E2E_MODEL=1. Kept out of `npm test`'s discovery.
printf '%s\n' 'SUITE: embedding model (e2e, opt-in with MNEMOS_E2E_MODEL=1)'
node --test e2e/model.e2e.js

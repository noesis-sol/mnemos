#!/bin/sh
# scripts/check-fast.sh: tutti's merge check, run on every ticket before it merges.
# tutti init wrote it; it is the project's to edit. Each suite is one command, run from the
# repository's root, and finds its own test files: a new test in an existing suite needs no edit here.
# Each runs in a subshell, ( ), so that a command failing anywhere in it (cd web && npm test) fails
# the script, and its cd leaves the next suite at the root.
# Each suite prints SUITE: <name> as it starts. A suite that reruns a failed test, and passes when
# the rerun does, prints FLAKY: <test> for it: the ticket merges, and tutti warns of it.
set -e
cd "$(dirname "$0")/.."

# build (tsc), from package.json:13
printf '%s\n' 'SUITE: build (tsc)'
(
npm run build
)

# unit tests, from package.json:16
# node --test runs its files side by side; TUTTI_CORES, where set, is this run's share of the cores.
printf '%s\n' 'SUITE: unit tests'
(
npm test ${TUTTI_CORES:+-- --test-concurrency=$TUTTI_CORES}
)

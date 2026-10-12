---
name: create-check-suite
description: Set up deterministic test suites for a project that has no tests, or areas without them, in the project's own languages and frameworks (go test, pytest, Mocha, Jest, Playwright, Cypress…), wire them into scripts/check-fast.sh and scripts/check-full.sh, get them passing, map the features in FEATURES.md and file a ticket for each untested area. Use when a ticket asks for a test harness, a first suite, a features map or the untested areas, or when a project needs tests before its changes can be checked.
---

# create-check-suite

This skill gives a project tests that pass or fail in code: unit suites for its logic and end-to-end
suites through what its users touch, in the frameworks the project already uses. Nothing here is
judged by an agent; a test asserts, and its runner exits 0 or not. The suites run from two scripts
in the project, which orchestra calls:

- `scripts/check-fast.sh`: the merge check, run on every change before it merges. Keep it to
  minutes.
- `scripts/check-full.sh`: everything. It runs `scripts/check-fast.sh` first, then the slow suites
  and those that need a service (a browser, a database, a container).

Work everything out from the repository: its manifests, its code, its CI, its docs. Ask only what
the repository can't tell you, such as a credential or which of two databases production uses, and
ask it once, all together, after reading. Leave nothing to fill in later: no `TODO`, no
`<your-port>`, no test that only says it will be written. Each file you add runs and means what it
says.

Do the sections in order. Your ticket may ask for only some of them (only the map and the tickets,
for one); do those, after reading the repository.

## 1. Read the repository

Find out, and note as you go (the notes become FEATURES.md):

- **Languages and frameworks**: from the manifests (`go.mod`, `package.json`, `pyproject.toml`,
  `requirements*.txt`, `Cargo.toml`, `Gemfile`, `pom.xml`, `build.gradle`, `*.csproj`, `mix.exs`…),
  with their versions and the package manager the lock file names (npm, pnpm, yarn, uv, poetry…).
- **How the app starts**: the start script, the `main` package, the `Procfile`, `Dockerfile` or
  `docker-compose.yml`, the Makefile's targets; the port it listens on and how that is set; the
  environment variables and services it needs.
- **What a user touches**: the pages and routes of a web app, the commands and flags of a CLI, the
  endpoints of an API, the screens of a TUI, the exported functions of a library. These are the
  areas you map in section 5.
- **Existing tests and harnesses**: test files and folders, their framework and runner, fixtures,
  factories, test helpers, a Playwright or Cypress config, a test database setup. Run them later, in
  section 4; don't judge them from their names.
- **CI**: the workflows (`.github/workflows/`, `.gitlab-ci.yml`, `.circleci/`…) and what they run,
  in what order, with which services. CI is often the only place the real test command is written.
- **The runners**: whether `scripts/check-fast.sh` and `scripts/check-full.sh` exist and what they
  run, and any `scripts/check.sh` they call.

## 2. Set up the harness

Use the project's own test framework and runner. Where it has none, use its language's usual one
(`go test`; pytest; Vitest for a Vite project, otherwise Mocha or Jest as the project's other tools
suggest; `cargo test`; RSpec or Minitest; JUnit) and say in your ticket's notes which one you chose
and why. Add it the way the project adds any dependency: to its manifest, as a dev dependency, with
its lock file updated.

- **Unit tests** for the core logic: the functions that decide something (parsing, validation,
  pricing, state changes), called directly, without the network, a browser or a real database.
- **End-to-end tests** through what a user touches, with a harness made for it: Playwright or
  Cypress for a web UI (prefer the one the project has); an HTTP test client for an API (Go's
  `net/http/httptest`, FastAPI's or Flask's test client, supertest); for a CLI, running the built
  binary with arguments and reading its output and exit code; a pseudo-terminal helper for a
  terminal UI (Go's `creack/pty`, Python's `pexpect`, `node-pty`).
- **One smoke test per level**, first, before anything else: a unit test of one core function, and
  an e2e test that the app starts and answers (the home page loads, `--version` prints, a health
  endpoint returns 200). The smoke tests prove the harness works; everything else builds on them.

Put the tests where the project's convention puts them (`_test.go` beside the code, `tests/`,
`__tests__/`, `spec/`, `e2e/`), and give e2e tests their own folder or name pattern so a runner can
run one level without the other.

## 3. Add each suite to a runner

A suite is one command that runs a set of tests, such as `go test ./...`, `npm test`,
`npx playwright test` or `pytest tests/unit`. Add each to one runner:

- `scripts/check-fast.sh`: fast suites that need nothing running, usually the unit tests and the
  lints.
- `scripts/check-full.sh`: slow suites, and those that need a service or a browser, usually the e2e
  tests.

Add the command, not the test files: the framework finds its own tests, so a new test in an existing
suite needs no edit to a runner. Keep each runner's shape: `#!/bin/sh`, `set -e`, a `cd` to the
repository's root, one line per suite under a comment naming the suite and where it is defined. A
runner that is only `exit 0` checks nothing yet: replace the `exit 0` with the suites. Never edit an
existing `scripts/check.sh`; check-fast.sh calls it as a suite.

Several copies of a runner may run at once, in several git worktrees of the same repository. A suite
that can't (a fixed port, a shared database, a single browser profile) goes inside the runner's
`lock <name>` and `unlock` lines, which take turns across worktrees; if the runner has no lock
functions, make the suite safe to run twice at once instead (see the rules below), which is better
anyway.

## 4. Get the runners passing on main

Run `scripts/check-fast.sh`, then `scripts/check-full.sh`, on your branch from the main branch,
and read what fails. Don't stop until both exit 0.

- A test you wrote that fails: fix the test if it is wrong. If it found a bug in the app, see the
  rules below.
- An existing test that fails: fix it if the fix is trivial and plainly right (a renamed import, a
  stale fixture, a missing `await`). Otherwise skip it with the framework's own skip (`t.Skip`,
  `pytest.mark.skip`, `it.skip`, `test.skip`) and file a bug ticket for it, naming the ticket in the
  skip's reason: `t.Skip("app-4f2: fails on an empty cart")`.
- A suite that needs a service: start it from the test or the suite's command (a container, an
  in-memory database, Playwright's `webServer`), not by hand.

Run each runner twice more, to catch a test that passes only sometimes, and time it. Record how long
each took in your ticket's notes (`check-fast.sh: 48s; check-full.sh: 4m10s`) and in FEATURES.md. A
check-fast that takes more than a few minutes holds up every merge: move its slowest suite to
check-full.

## 5. Map the features

Write FEATURES.md in the main test folder (`tests/`, `test/`, `e2e/`, or the repository's root for a
Go project that keeps tests beside the code). It is the map the next tickets work from:

- At the top: the suites, the runner each is in, the command, and how long each runner takes.
- Then one section per area a user touches, from section 1's notes:
  - **Reached by**: how a user gets there (`/checkout`, `app export --csv`, `POST /api/orders`).
  - **Tests**: the test files that cover it, and at which level.
  - **Untested**: what has no test yet, in plain words (`refunds over the order total`,
    `export with no rows`). Write `nothing` only when that is true.

Keep it to facts you checked. An area you couldn't reach, or a part you couldn't work out, says so.

## 6. File the untested areas

File one ticket per untested area, with Beads, under the epic your ticket belongs to (`bd show` on
your ticket names it as its parent):

```sh
bd create --type=task --priority=3 --parent=<epic> \
  --title "Test the checkout page end to end" \
  --description "<the area, how a user reaches it, the suite, the files, the cases to cover>"
```

Size each to one worker session: one area at one level, a handful of cases. Split an area that is
larger. Each names the area, the suite it adds to (and so the runner), the files to test and the
files to add, and the cases from FEATURES.md's Untested. Don't file one for an area FEATURES.md says
is covered.

## Rules for the tests

- **Isolated.** Each test makes its own temporary directory (`t.TempDir()`, pytest's `tmp_path`,
  `fs.mkdtemp`) and asks the system for a free port (listen on port 0) rather than using a fixed
  one. No test shares a database, a file or a global with another: give each its own, or a
  transaction rolled back at its end.
- **Deterministic.** No sleeping to wait for something: wait on the thing itself (a channel, a
  promise, Playwright's auto-waiting `expect`, polling a condition with a deadline). The network is
  stubbed (a local fake server, recorded responses); the clock is fixed or injected; randomness is
  seeded. No test relies on another having run first, or on the order tests run in.
- **Added, never replacing.** New tests go next to the existing ones. Don't delete, rewrite or
  weaken an existing test, except the trivial fixes and skips in section 4.
- **App code changes only for testability**: a test ID on an element, an injectable clock, a
  configurable port or path, a seam to swap a client for a fake. None changes what the app does.
  List each in your ticket's notes, with its file.
- **A test that finds a bug** is committed skipped, its skip naming a new bug ticket. The bug
  ticket says what the test shows, and its acceptance criteria include removing the skip and the
  test passing. Don't fix the bug in this ticket.

---

Its approach follows the create-verification-skill of [backnotprop/pstack](https://github.com/backnotprop/pstack) (MIT).

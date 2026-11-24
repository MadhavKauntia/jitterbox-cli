# Jitterbox CLI

Fake APIs that break on purpose. [Jitterbox](https://jitterbox.xyz) gives you a fake version of an API at a real
URL, then makes it slow, flaky or broken on purpose so you can see how your code copes. This CLI does everything the
dashboard does, so you (or a coding agent like Claude Code or Codex) can set it up from a terminal, and it runs your
tests against failure scenarios in CI.

```sh
npx jitterbox login                      # approve in the browser
npx jitterbox projects create payments-api
npx jitterbox endpoints create POST /payments --status 201 --json-body '{"id":"pay_1"}'
npx jitterbox scenarios create "Flaky gateway" --fault "error=503 rate=20%" --fault "latency=200-800ms"
npx jitterbox run --scenario "Flaky gateway" -- npm test
```

Needs Node 18 or newer.

## Config as code

Describe the fake API in `jitterbox.yaml` and apply it. Endpoints are matched by "METHOD /path" and scenarios by
name; fields you leave out keep their current values.

```yaml
project: payments-api            # created if it doesn't exist
endpoints:
  - method: POST
    path: /payments
    status: 201
    json: { id: pay_123, status: succeeded }
  - method: GET
    path: /payments/{id}
    template: true
    json: { id: "{{path.id}}", status: paid }
scenarios:
  - name: Flaky gateway
    endpoints: ["POST /payments"]
    faults:
      - error: 503
        rate: 20%
      - latency: 500-3000ms
        rate: 20%
```

```sh
jitterbox diff      # what would change
jitterbox apply     # make it so (--prune also deletes what the file doesn't list)
jitterbox pull      # write the current project to jitterbox.yaml
```

## For coding agents

Every command takes `--json`, nothing prompts, destructive commands need `--yes`, and exit codes are stable
(0 ok · 2 usage · 3 report failed · 4 no traffic · 5 lease timeout · 6 not signed in · 7 not found · 8 not allowed ·
9 conflict). `jitterbox guide` prints [AGENTS.md](AGENTS.md), a short guide written for agents. Point your agent at it,
or add a line to your own `AGENTS.md` / `CLAUDE.md`:

> To mock or break third-party APIs in tests, use the Jitterbox CLI. Run `npx jitterbox guide` first.

To have an agent set up a project from your code (find the APIs it calls, create endpoints and failure scenarios, point
the tests at them), copy the prompt from **Set up with your coding agent** in the dashboard, or ask it to follow the
"Set up from a codebase" section of `npx jitterbox guide`.

## Signing in

- `jitterbox login` opens the browser to approve the CLI and saves a personal token in
  `~/.config/jitterbox/config.json` (override with `JITTERBOX_CONFIG`). Tokens are listed and revocable in
  **Settings → Account → Personal tokens**.
- `JITTERBOX_TOKEN` (or `--token`) overrides the saved token: use a personal token (`jbp_…`) for everything, or a
  project API key (`jb_…`, Settings → API keys) for CI, which can only switch scenarios and read results.
- `JITTERBOX_API` (or `--api`) points at another Jitterbox (default https://jitterbox.xyz).

## Commands

Run `jitterbox help` for all of them: `login`, `logout`, `whoami`, `workspaces`, `projects`, `endpoints` (including
`import` from OpenAPI), `scenarios` (`create`, `update`, `on`, `off`, `reset`, `simulate`), `requests` (`list`,
`show`, `tail`), `diff`, `apply`, `pull`, `run`, `report`, `guide`.

## GitHub Action

```yaml
- uses: MadhavKauntia/jitterbox-cli@v1
  with:
    token: ${{ secrets.JITTERBOX_TOKEN }}
    scenario: Flaky gateway
    command: npm test        # your tests read JITTERBOX_BASE_URL
```

It turns the scenario on, runs the command, turns it off, grades how your client handled the failures and fails the
job if a check fails. Inputs: `token`, `scenario`, `command`, `api-url`, `fail-on`, `require`, `allow-empty`, `wait`,
`working-directory`, `junit`. Outputs: `result`, `exit-code`, `report`.

## Development

```sh
npm install
npm test
node bin/jitterbox.mjs help
```

MIT licensed.

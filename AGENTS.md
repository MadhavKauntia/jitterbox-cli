# Using the Jitterbox CLI (for coding agents)

Jitterbox gives you fake versions of APIs at a real URL, and can make them fail on purpose (errors, delays,
timeouts, broken bodies, cut LLM streams) so you can see how the code under test copes. This CLI does everything the
dashboard does. Print this guide any time with `jitterbox guide`.

## Rules of thumb

- Add `--json` to any command for machine-readable output on stdout (one JSON document; `requests tail` prints one
  JSON object per line). Progress and hints go to stderr.
- Nothing is interactive. Destructive commands need `--yes`.
- Exit codes: 0 ok · 2 bad usage · 3 resilience report failed · 4 no traffic reached Jitterbox · 5 timed out waiting
  for a CI lease · 6 not signed in / bad token · 7 not found · 8 not allowed (role or beta limit) · 9 conflict.
- Errors print `jitterbox: <what went wrong>` and usually a `hint:` line with the fix.

## Signing in

- `jitterbox login` prints a URL and a code and waits (up to 10 minutes) for the user to approve it in the browser.
  Show the user the URL. It saves a personal token in `~/.config/jitterbox/config.json`.
- In CI or a sandbox, set `JITTERBOX_TOKEN` to a personal token (`jbp_…`, from Settings → Account → Personal tokens)
  instead. A project API key (`jb_…`) only works for `run`, `report` and `scenarios on|off|reset`.
- `jitterbox whoami --json` shows who is signed in and which project commands will use.

## Picking the project

Commands act on one project, chosen by `--project <name|id>`, then `JITTERBOX_PROJECT`, then `project:` in
`./jitterbox.yaml`, then `jitterbox projects use <name>`. If the user has exactly one project it's used automatically.

## The fastest path: jitterbox.yaml

Describe the fake API in a file, then apply it. Prefer this over many single commands.

```yaml
project: payments-api            # created if it doesn't exist
endpoints:
  - method: POST
    path: /payments
    status: 201
    json: { id: pay_123, status: succeeded }
  - method: GET
    path: /payments/{id}         # {id} matches one path segment
    template: true               # body may use {{path.id}}, {{query.x}}, {{header.x}}, {{body.x}}
    json: { id: "{{path.id}}", status: paid }
  - method: POST
    path: /v1/messages
    kind: anthropic-messages     # also: openai-chat, openai-responses, graphql, soap
scenarios:
  - name: Unreliable gateway
    endpoints: ["POST /payments"]  # leave out to apply to every request
    faults:
      - error: 503
        rate: 20%                # or "1 in 5", or always (the default)
      - latency: 500-3000ms
        rate: 20%
  - name: Fail twice then succeed
    enabled: false
    faults:
      - error: 500
        pattern: xx.             # x = fail, . = pass; repeats unless repeat: false
```

- `jitterbox diff` shows what would change; `jitterbox apply` makes it so (`--prune` also deletes what the file
  doesn't list); `jitterbox pull` writes the current project to the file.
- Endpoints are matched by "METHOD /path", scenarios by name. Fields you leave out keep their current values.
- Endpoint fields: method, path, name, status, json | body, headers, delay (e.g. 200ms), template, enabled, kind,
  llm (for LLM kinds), rules (conditional replies, as the API takes them).
- Fault kinds: `error: <status>` (body, headers), `latency: 200-800ms`, `timeout: 10s` (hang, then 504),
  `malformed: invalid_json|truncated|empty_body|wrong_content_type`, LLM-only `slow_first_token: 3s`,
  `slow_stream: 100-400ms`, `stream_cut: 50%`, `malformed_chunk: true`, `missing_done: true`,
  `truncated_tool_args: true`, and `graphql_error: CODE` / `soap_fault: Server` for those endpoints.

## Single commands

```sh
jitterbox projects list | create <name> | use <name> | show | delete <name> --yes
jitterbox endpoints list | show "POST /payments" | delete "POST /payments" --yes
jitterbox endpoints create POST /payments --status 201 --json-body '{"id":"pay_1"}' --header "Location: /payments/pay_1"
jitterbox endpoints update "POST /payments" --status 500 --delay 2s      # or --no-enabled to pause it
jitterbox endpoints import openapi.yaml [--replace]
jitterbox scenarios create "Flaky" --fault "error=503 rate=20%" --fault "latency=200-800ms" --endpoint "POST /payments"
jitterbox scenarios on|off|reset "Flaky"      # simulate "Flaky" --count 200 previews it without sending traffic
jitterbox requests list [--status errors|faulted|2xx] [--endpoint "POST /payments"] | show <id> | tail
jitterbox report [--window 15m|1h|24h|7d]   # grades how the client handled failures
jitterbox run --scenario "Flaky" -- npm test # turns it on, runs the tests, turns it off, grades the client
```

Point the code under test at the project's base URL (`jitterbox projects show --json` → `baseUrl`). `jitterbox run`
sets `JITTERBOX_BASE_URL` for the command it runs.

## A typical task

"Make our payment client resilient to a flaky gateway":

1. `jitterbox whoami --json` (sign in with `jitterbox login` if needed).
2. Write `jitterbox.yaml` with the endpoints the client calls and a scenario with the failures; `jitterbox apply`.
3. Point the client's API base URL at the project's base URL in the test config.
4. `jitterbox run --scenario "<name>" -- <test command>`; read the report (`--json`) and fix what fails.

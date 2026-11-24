# Using the Jitterbox CLI (for coding agents)

Jitterbox gives you fake versions of APIs at a real URL, and can make them fail on purpose (errors, delays,
timeouts, broken bodies, cut LLM streams) so you can see how the code under test copes. This CLI does everything the
dashboard does. Print this guide any time with `jitterbox guide`. If `jitterbox` isn't installed, run every command
below as `npx jitterbox …` instead.

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

## Set up from a codebase

When the user asks you to set Jitterbox up for their code (the dashboard's "Set up with your coding agent" prompt
sends you here), work through these steps. Keep the user in the loop: show the plan and the `diff` before you change
anything.

1. **Sign in.** `jitterbox whoami --json`; if that exits 6, run `jitterbox login` and show the user the URL and code.
2. **Pick the project.** If `jitterbox.yaml` already exists, build on it. If the prompt names a project, run
   `jitterbox pull --project <id or name>`: it writes what the project already has to `jitterbox.yaml`, so you build on
   it rather than duplicate it. Otherwise start the file with `project: <the repo's name>` and `apply` creates it. During the beta a workspace has 1 project, 10 endpoints and
   2 scenarios; exit 8 means a limit was hit, so keep the endpoints the tests rely on most.
3. **Find the APIs the code calls.** Look for:
   - HTTP clients (`fetch`, axios, got, ky, `requests`, httpx, aiohttp, `net/http`, OkHttp, RestTemplate, WebClient,
     Faraday, `HttpClient`) and the URLs they build;
   - SDKs for outside services (Stripe, OpenAI, Anthropic, Twilio, SendGrid, Slack, GitHub…);
   - base-URL settings in config and env files (`*_BASE_URL`, `*_API_URL`, `*_HOST`, `.env.example`);
   - an OpenAPI or Swagger file (`jitterbox endpoints import <file>` turns it into endpoints);
   - existing test mocks and fixtures (nock, msw, `responses`, WireMock, VCR cassettes, recorded JSON): they hold real
     response shapes.

   Leave out the app's own API, databases, queues, and services whose base URL can't be changed (say which ones you
   skipped and why).
4. **Describe them in `jitterbox.yaml`.** One endpoint per method and path the code actually calls, with a reply the
   code can parse: include the fields it reads (check the types or the parsing code), copy shapes from fixtures, and use
   `template: true` with `{{path.id}}` to echo ids back. If the code calls more than one API, put each under a prefix
   (`/stripe/v1/charges`, `/github/repos/{owner}/{repo}`) and point that API's base URL at `<baseUrl>/stripe`.
   - LLM calls get a `kind`: `openai-chat` for `POST /v1/chat/completions`, `openai-responses` for `POST /v1/responses`,
     `anthropic-messages` for `POST /v1/messages`. The SDKs take a base URL: `OPENAI_BASE_URL=<baseUrl>/v1`,
     `ANTHROPIC_BASE_URL=<baseUrl>`. Streaming works with no extra setup.
   - GraphQL gets `kind: graphql`, SOAP gets `kind: soap`.
5. **Add one or two failure scenarios that fit**, with `enabled: false` so the fake API behaves normally until a test
   run turns them on:
   - most APIs: `error: 503` at `rate: 20%`, plus `latency: 500-3000ms`;
   - rate-limited APIs (Stripe, GitHub, OpenAI…): `error: 429` with `headers: { Retry-After: "2" }`;
   - LLM endpoints: `stream_cut: 50%`, `slow_first_token: 5s`, or `error: 529` (Anthropic overloaded);
   - calls that should retry: `error: 500` with `pattern: xx.` (fails twice, then succeeds).
6. **Show `jitterbox diff`, then `jitterbox apply`.** `jitterbox.yaml` holds no secrets; suggest committing it.
7. **Point the tests at it, never production.** Find where each base URL is set. If it's already read from an
   environment variable, set that variable in the test setup (`.env.test`, the test config, the CI job). If it's
   hard-coded, ask before changing the code to read one. `jitterbox projects show --json` gives `baseUrl`, and
   `jitterbox run` sets `JITTERBOX_BASE_URL` for the command it runs, so the test setup can use that.
8. **Check it works.** Run the tests once as usual and confirm requests arrive (`jitterbox requests list`). Then run
   `jitterbox run --scenario "<name>" -- <test command>` for each scenario. Exit 3 means the client didn't cope with a
   failure: that's a finding for the user, not a setup problem. Exit 4 means no traffic reached Jitterbox, so the
   base URL isn't wired up yet.
9. **Finish with a short summary:** the endpoints and scenarios you created, the files and env vars you changed, what
   the report found (and a suggested fix for each failure), and the APIs you left out.

Never put a token in the repo, and never change production config or credentials.

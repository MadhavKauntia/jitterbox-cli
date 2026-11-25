#!/usr/bin/env node
// The Jitterbox CLI. See README.md, or `jitterbox guide` for the version written for coding agents.

import { parseArgs } from "../src/args.mjs";
import { VERSION } from "../src/api.mjs";
import { makeContext } from "../src/context.mjs";
import { CliError, UsageError } from "../src/errors.mjs";
import { login, logout, whoami } from "../src/commands/auth.mjs";
import { workspaces } from "../src/commands/workspaces.mjs";
import { projects } from "../src/commands/projects.mjs";
import { ENDPOINT_FLAGS, endpoints } from "../src/commands/endpoints.mjs";
import { SCENARIO_FLAGS, scenarios } from "../src/commands/scenarios.mjs";
import { REQUEST_FLAGS, requests } from "../src/commands/requests.mjs";
import { CI_FLAGS, report, run } from "../src/commands/ci.mjs";
import { DEFAULT_FILE, SPEC_FLAGS, apply, diff, pull, specProjectHint } from "../src/commands/spec.mjs";
import { guide } from "../src/commands/guide.mjs";

const HELP = `jitterbox: fake APIs that break on purpose. https://jitterbox.dev

Usage: jitterbox <command> [options]          (add --json to any command for machine-readable output)

Sign in
  login [--token jbp_…] [--no-browser]   sign in (opens the browser to approve), or save a personal token
  logout                                  forget the saved token on this machine
  whoami                                  who you are, and which workspace and project commands use

Workspaces and projects
  workspaces list | use <name>
  projects list | create <name> | use <name> | show [name] | rename <name> <new> | delete <name> --yes

Endpoints (fake API addresses)
  endpoints list | show <ref> | delete <ref> --yes      ref: "POST /payments", a path, or an id
  endpoints create <METHOD> <path> [--status 201] [--json-body '{…}' | --body text | --body-file f]
                   [--header "Name: value"]… [--delay 200ms] [--name …] [--kind graphql|soap|openai-chat|…] [--template]
  endpoints update <ref> [same options] [--enabled | --no-enabled]
  endpoints import <openapi.yaml|json> [--replace] [--base-path /v1]

Failure scenarios
  scenarios list | show <name> | on | off | reset <name> | delete <name> --yes
  scenarios create <name> --fault "error=503 rate=20%" [--fault …] [--endpoint <ref>]… [--off] [--priority n]
  scenarios update <name> [--name …] [--fault … (replaces all)] [--endpoint <ref>… | --all-endpoints] [--on | --off]
  scenarios simulate <name> [--count 200] [--seed 42]
    faults: error=<status> · latency=200-800ms · timeout=10s · malformed=invalid_json · slow_first_token=3s · …
    when:   rate=20% · rate='1 in 5' · pattern=xx. (x fail, . pass) · always (default)

Requests
  requests list [--status errors|faulted|2xx] [--endpoint <ref>] [--limit 20] | show <id> | tail | clear --yes

Config as code (${DEFAULT_FILE})
  diff [--prune] [--exit-code]           what apply would change
  apply [--dry-run] [--prune]            make the project match the file (creates the project if needed)
  pull [--force] [--file -]              write the project to the file
  (all take --file <path>)

CI
  run --scenario <name> [--scenario …] [options] -- <command…>   turn scenarios on, run tests, grade the client
  report [--window 15m|1h|24h|7d | --since <ISO>] [--scenario <name>]
    options: --fail-on fail|warn · --require <checks> · --allow-empty · --report-json <file> · --junit <file>
             --markdown <file> · --wait <seconds> · --no-lease · --holder <name> · --keep-on

guide                                     how to use this CLI, written for coding agents (Claude Code, Codex…)

Global options
  --project <name|id>   (env JITTERBOX_PROJECT, or project: in ${DEFAULT_FILE}, or \`projects use\`)
  --workspace <name|id> (env JITTERBOX_WORKSPACE, or \`workspaces use\`)
  --token <token>       (env JITTERBOX_TOKEN, or \`login\`)      --api <url> (env JITTERBOX_API)
  --json · --yes · --help

Exit codes: 0 ok · 2 usage · 3 report failed · 4 no traffic · 5 lease timeout · 6 not signed in · 7 not found
            8 not allowed · 9 conflict · 1 anything else`;

const COMMANDS = {
  login: { fn: login, flags: { browser: "bool" } },
  logout: { fn: logout },
  whoami: { fn: whoami },
  workspaces: { fn: workspaces },
  workspace: { fn: workspaces },
  projects: { fn: projects, flags: { use: "bool" } },
  project: { fn: projects, flags: { use: "bool" } },
  endpoints: { fn: endpoints, flags: ENDPOINT_FLAGS },
  endpoint: { fn: endpoints, flags: ENDPOINT_FLAGS },
  scenarios: { fn: scenarios, flags: SCENARIO_FLAGS },
  scenario: { fn: scenarios, flags: SCENARIO_FLAGS },
  requests: { fn: requests, flags: REQUEST_FLAGS },
  run: { fn: run, flags: CI_FLAGS },
  report: { fn: report, flags: CI_FLAGS },
  apply: { fn: apply, flags: SPEC_FLAGS, spec: true },
  diff: { fn: diff, flags: SPEC_FLAGS, spec: true },
  pull: { fn: pull, flags: SPEC_FLAGS, spec: true },
  guide: { fn: guide },
};

async function main() {
  const [name, ...argv] = process.argv.slice(2);
  let wantJson = argv.includes("--json");
  try {
    if (!name || name === "help" || name === "--help" || name === "-h") {
      console.log(HELP);
      return 0;
    }
    if (name === "--version" || name === "-v" || name === "version") {
      console.log(VERSION);
      return 0;
    }
    const cmd = COMMANDS[name];
    if (!cmd) throw new UsageError(`Unknown command "${name}"`, 'Run "jitterbox help" to see the commands.');
    const { flags, positionals, command } = parseArgs(argv, cmd.flags);
    wantJson = !!flags.json;
    if (flags.help) {
      console.log(HELP);
      return 0;
    }
    const ctx = makeContext(flags, { specProject: specProjectHint(cmd.spec ? (flags.file ?? DEFAULT_FILE) : DEFAULT_FILE) });
    return await cmd.fn(ctx, positionals, command);
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError(e?.message ?? String(e));
    if (wantJson) process.stdout.write(JSON.stringify({ error: { code: err.code, message: err.message, hint: err.hint, fields: err.fields } }, null, 2) + "\n");
    process.stderr.write(`jitterbox: ${err.message}\n`);
    if (err.hint) process.stderr.write(`hint: ${err.hint}\n`);
    if (err.fields) for (const [k, v] of Object.entries(err.fields)) process.stderr.write(`  ${k}: ${v}\n`);
    return err.exitCode;
  }
}

process.exitCode = await main();

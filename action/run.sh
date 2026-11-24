#!/usr/bin/env bash
# Body of the Jitterbox GitHub Action (kept as a script so it can be run and tested outside Actions).
# Inputs arrive as INPUT_* env vars; writes outputs to $GITHUB_OUTPUT and the report card to $GITHUB_STEP_SUMMARY.
set -uo pipefail

CLI="${JITTERBOX_CLI:?JITTERBOX_CLI must point at bin/jitterbox.mjs}"
report="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/jitterbox-report-$$.json"
args=(run --fail-on "${INPUT_FAIL_ON:-fail}" --wait "${INPUT_WAIT:-600}" --report-json "$report")

# Scenarios: one per line or comma-separated.
while IFS= read -r s; do
  s="$(echo "$s" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [ -n "$s" ] && args+=(--scenario "$s")
done < <(printf '%s\n' "${INPUT_SCENARIO:-}" | tr ',' '\n')

[ -n "${INPUT_REQUIRE:-}" ] && args+=(--require "$INPUT_REQUIRE")
[ "${INPUT_ALLOW_EMPTY:-false}" = "true" ] && args+=(--allow-empty)
[ -n "${INPUT_JUNIT:-}" ] && args+=(--junit "$INPUT_JUNIT")
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && args+=(--markdown "$GITHUB_STEP_SUMMARY")

if [ -z "${INPUT_COMMAND:-}" ]; then echo "::error::The command input is required"; exit 2; fi

# The command is passed as one string, so the CLI runs it through a shell ("npm test -- --grep x" works).
node "$CLI" "${args[@]}" -- "$INPUT_COMMAND"
code=$?

result=$([ "$code" -eq 0 ] && echo passed || echo failed)
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  { echo "result=$result"; echo "exit-code=$code"; echo "report=$report"; } >> "$GITHUB_OUTPUT"
fi
case "$code" in
  0) ;;
  3) echo "::error title=Jitterbox resilience::Your client's failure handling didn't pass. See the job summary." ;;
  4) echo "::error title=Jitterbox resilience::No requests reached Jitterbox. Point your app at \$JITTERBOX_BASE_URL." ;;
  5) echo "::error title=Jitterbox resilience::Timed out waiting for another run to release the project." ;;
  *) echo "::error title=Jitterbox resilience::The command or the Jitterbox CLI exited with $code." ;;
esac
exit "$code"

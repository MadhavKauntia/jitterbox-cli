import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { makeClient } from "../api.mjs";
import { configPath, writeConfig } from "../config.mjs";
import { CliError } from "../errors.mjs";
import { c, info, out } from "../output.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

/**
 * Signs the CLI in. Without --token: asks Jitterbox for a code, opens the browser to approve it, and waits (up to
 * ten minutes). With --token: checks and saves a personal token you created in Settings.
 */
export async function login(ctx) {
  const apiUrl = ctx.apiUrl;
  if (ctx.flags.token) {
    const client = makeClient({ apiUrl, token: ctx.flags.token });
    const { user } = await client.get("/api/auth/me");
    if (!user) throw new CliError("That token isn't valid.", { exitCode: 6, code: "unauthenticated" });
    writeConfig({ apiUrl, token: ctx.flags.token });
    out(ctx, { signedIn: true, email: user.email, apiUrl }, () => console.log(`Signed in as ${c.bold(user.email)}. Saved to ${configPath()}.`));
    return 0;
  }

  const anon = makeClient({ apiUrl });
  const start = await anon.post("/api/auth/cli/start", { clientName: `Jitterbox CLI on ${hostname()}`.slice(0, 80) });
  info(`\nTo sign in, open this page and approve the code ${c.bold(start.userCode)}:\n\n  ${c.cyan(start.verifyUrl)}\n`);
  if (process.stdout.isTTY && ctx.flags.browser !== false) openBrowser(start.verifyUrl);
  info(c.dim("Waiting for you to approve it in the browser…"));

  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(start.interval * 1000);
    const r = await anon.post("/api/auth/cli/poll", { deviceCode: start.deviceCode });
    if (r.status === "pending") continue;
    if (r.status === "approved") {
      writeConfig({ apiUrl, token: r.token });
      out(ctx, { signedIn: true, email: r.email, apiUrl }, () =>
        console.log(`\n${c.green("✓")} Signed in as ${c.bold(r.email)}. The token is saved in ${configPath()}.`),
      );
      return 0;
    }
    if (r.status === "denied") throw new CliError("The sign-in was denied in the browser.", { exitCode: 6, code: "denied" });
    break;
  }
  throw new CliError("The sign-in code expired before it was approved.", { exitCode: 6, code: "expired", hint: "Run `jitterbox login` again." });
}

export async function logout(ctx) {
  writeConfig({ token: null, project: null, workspace: null });
  out(ctx, { signedOut: true }, () =>
    console.log(`Signed out on this machine. The token still exists until you revoke it in Settings → Account → Personal tokens.`),
  );
  return 0;
}

export async function whoami(ctx) {
  const me = await ctx.me();
  if (me.kind === "project") {
    out(ctx, { kind: "project-key", apiUrl: ctx.apiUrl, project: me.project }, () => {
      console.log(`A project API key for ${c.bold(me.project.name)} (${me.project.id})`);
      console.log(`Mock base URL: ${me.project.baseUrl}`);
      console.log(c.dim("It can switch scenarios and read results only. Run `jitterbox login` to do everything else."));
    });
    return 0;
  }
  let project = null;
  try {
    project = await ctx.project();
  } catch {}
  const ws = await ctx.workspace(false).catch(() => null);
  out(ctx, { kind: "personal", apiUrl: ctx.apiUrl, user: me.user, workspace: ws, project }, () => {
    console.log(`Signed in as ${c.bold(me.user.email)}${me.user.name ? ` (${me.user.name})` : ""} on ${ctx.apiUrl}`);
    console.log(`Workspace: ${ws ? ws.name : c.dim("all (none picked)")}`);
    console.log(`Project:   ${project ? `${project.name} ${c.dim(project.baseUrl)}` : c.dim("none picked; `jitterbox projects use <name>`")}`);
  });
  return 0;
}

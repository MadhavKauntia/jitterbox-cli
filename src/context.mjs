import { makeClient, DEFAULT_API } from "./api.mjs";
import { readConfig } from "./config.mjs";
import { CliError, UsageError } from "./errors.mjs";

/**
 * Everything a command needs: flags, the API client and lazy lookups for who you are and which project and
 * workspace you mean. Precedence for each setting: flag, then environment, then jitterbox.yaml (project only),
 * then the saved config.
 */
export function makeContext(flags, { specProject } = {}) {
  const config = readConfig();
  const apiUrl = (flags.api ?? process.env.JITTERBOX_API ?? config.apiUrl ?? DEFAULT_API).replace(/\/$/, "");
  const token = flags.token ?? process.env.JITTERBOX_TOKEN ?? config.token ?? null;
  const client = makeClient({ apiUrl, token });
  const kind = !token ? "none" : token.startsWith("jbp_") ? "personal" : "project";

  let meP, wsP, projectP;

  const requireToken = () => {
    if (!token)
      throw new CliError("Not signed in.", { exitCode: 6, code: "unauthenticated", hint: "Run `jitterbox login`, or set JITTERBOX_TOKEN." });
  };

  /** { kind, user?, project? }: a personal token is a user; a project key is bound to one project. */
  const me = () =>
    (meP ??= (async () => {
      requireToken();
      if (kind === "project") {
        const t = await client.get("/api/token");
        return { kind, project: { id: t.projectId, name: t.projectName, baseUrl: t.baseUrl } };
      }
      const { user } = await client.get("/api/auth/me");
      if (!user) throw new CliError("This token isn't valid any more.", { exitCode: 6, code: "unauthenticated", hint: "Run `jitterbox login` again." });
      return { kind, user };
    })());

  const needPersonal = async (what) => {
    const m = await me();
    if (m.kind !== "personal")
      throw new CliError(`${what} needs a personal token; a project API key can only run CI (switch scenarios, read results).`, {
        exitCode: 8,
        code: "forbidden",
        hint: "Run `jitterbox login` (or set JITTERBOX_TOKEN to a jbp_… personal token).",
      });
    return m;
  };

  const workspaces = async () => {
    await needPersonal("Listing workspaces");
    return client.get("/api/workspaces");
  };

  /** The workspace you mean (flag, env, saved), or null for "all of them". */
  const workspace = (required = false) =>
    (wsP ??= (async () => {
      const wanted = flags.workspace ?? process.env.JITTERBOX_WORKSPACE ?? config.workspace?.id ?? null;
      const list = await workspaces();
      if (!wanted) {
        if (!required) return null;
        return list.find((w) => w.personal) ?? list[0];
      }
      return pick(list, wanted, "workspace", (w) => [w.id, w.name]);
    })());

  /** The project you mean: the key's own project, or --project / JITTERBOX_PROJECT / jitterbox.yaml / `projects use`. */
  const project = () =>
    (projectP ??= (async () => {
      const m = await me();
      if (m.kind === "project") {
        const wanted = flags.project ?? process.env.JITTERBOX_PROJECT;
        if (wanted && ![m.project.id, m.project.name].some((x) => x?.toLowerCase() === wanted.toLowerCase()))
          throw new CliError(`This API key belongs to "${m.project.name}", not "${wanted}".`, { exitCode: 8, code: "forbidden" });
        return client.get(`/api/projects/${m.project.id}`).catch(() => ({ ...m.project, role: "MEMBER" }));
      }
      const wanted = flags.project ?? process.env.JITTERBOX_PROJECT ?? specProject ?? config.project?.id ?? null;
      const ws = await workspace(false);
      const list = await client.get(`/api/projects${ws ? `?workspaceId=${ws.id}` : ""}`);
      if (!wanted) {
        if (list.length === 1) return list[0];
        throw new UsageError(
          list.length === 0 ? "You don't have a project yet." : "Which project? You have several.",
          list.length === 0
            ? "Create one: `jitterbox projects create <name>`."
            : `Pass --project <name>, or pick one: \`jitterbox projects use <name>\`. Projects: ${list.map((p) => p.name).join(", ")}.`,
        );
      }
      return pick(list, wanted, "project", (p) => [p.id, p.name, p.projectKey]);
    })());

  return { flags, config, apiUrl, token, kind, client, me, needPersonal, workspaces, workspace, project };
}

/** Finds one item by id or a case-insensitive name; a clear error lists what exists. */
export function pick(list, wanted, what, keys) {
  const w = String(wanted).toLowerCase();
  const exact = list.filter((x) => keys(x).some((k) => k != null && String(k).toLowerCase() === w));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new UsageError(`Several ${what}s match "${wanted}"; use the id.`);
  const names = list.map((x) => `"${keys(x)[1]}"`).join(", ");
  throw new CliError(`No ${what} "${wanted}".`, { exitCode: 7, code: "not_found", hint: names ? `Have: ${names}.` : `There are no ${what}s yet.` });
}

// supervise-plugin.js — opencode plugin, loaded on every agent engine.
//
// Master supervision of delegated work. When the AI Master delegates a task it
// marks that session "supervised" on this engine's bridge (:4097). For a
// supervised session ONLY, we gate the agent on the master after every todo
// update: the plan (the first todowrite) and each completed step are submitted
// to the master for approval, and the master's verdict is spliced into the
// todowrite result the model reads — so a weak agent can't skip the review.
// Sessions a user drives directly are NOT supervised and run fully autonomously.
//
// The whole thing rides the bridge's /review broker (a separate channel from
// ask_human): we POST the todos, then long-poll /review/wait until the master
// answers (or a fail-open timeout), then append the verdict. tool.execute.after
// is awaited by opencode, so blocking here just keeps the todowrite tool "running"
// until the master responds — exactly the pause we want.
const BRIDGE = process.env.AGENT_BRIDGE || "http://127.0.0.1:4097";

const jget = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const jpost = (u, b) =>
  fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

export const supervise = async () => {
  process.stderr.write(`[supervise-plugin] loaded (bridge=${BRIDGE})\n`);
  return {
    "tool.execute.after": async (input, output) => {
      try {
        if (input?.tool !== "todowrite") return;
        const session = input.sessionID;
        if (!session) return;

        // Gate only sessions the master launched; user-driven runs are autonomous.
        const sup = await jget(`${BRIDGE}/supervised?session=${encodeURIComponent(session)}`);
        if (!sup?.supervised) return;

        const todos = Array.isArray(input.args?.todos) ? input.args.todos : [];
        if (!todos.length) return;

        const sub = await jpost(`${BRIDGE}/review`, { session, todos });
        if (!sub?.id) return; // bridge down → fail open, never hard-block the agent
        const kind = sub.kind === "step" ? "step" : "plan";

        const v = await jget(`${BRIDGE}/review/wait?id=${encodeURIComponent(sub.id)}`);
        if (!v || v.timeout) {
          output.output += `\n\n[master review — no response in time; proceeding] Continue, but keep your ${kind} conservative.`;
          return;
        }
        if (v.decision === "revise") {
          output.output +=
            `\n\n══ MASTER REVIEW: REVISION REQUIRED (${kind}) ══\n${(v.feedback || "Revise your approach.").trim()}\n` +
            `Address this in your todo list / approach BEFORE doing further work, then continue.`;
        } else {
          output.output += `\n\n[master review ✓ ${kind}] Approved — continue.`;
        }
      } catch {
        // A supervision hiccup must never break the tool — fail open silently.
      }
    },
  };
};

// ai_controller — connects to an opencode daemon over its REST API using the
// official SDK and verifies the daemon is alive and usable.
//
// For now this is a smoke test / reference for the controller. The real
// controller will hold N of these clients (one per sidecar) and route tasks.
import { createOpencodeClient } from "@opencode-ai/sdk";
import { setGlobalDispatcher, Agent } from "undici";

// session.prompt is synchronous: the daemon holds the connection open while the
// model generates, so the response headers can take much longer than undici's
// default timeouts. Disable header/body timeouts for these long-lived calls.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

const BASE_URL = process.env.OPENCODE_BASE_URL ?? "http://daemon:4096";
// Optional: if set, the controller sends a real prompt to prove end-to-end
// inference works (requires the daemon to have working provider credentials).
const TEST_PROMPT = process.env.TEST_PROMPT ?? "";

const client = createOpencodeClient({ baseUrl: BASE_URL });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The controller may boot before the daemon's HTTP server is listening.
async function waitForDaemon({ retries = 30, delayMs = 1000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await client.config.get({ throwOnError: true });
      return res.data;
    } catch (err) {
      const reason = err?.message ?? String(err);
      console.log(`[controller] daemon not ready (${attempt}/${retries}): ${reason}`);
      await sleep(delayMs);
    }
  }
  throw new Error(`daemon at ${BASE_URL} never became ready`);
}

async function main() {
  console.log(`[controller] connecting to opencode daemon at ${BASE_URL}`);

  const config = await waitForDaemon();
  console.log("[controller] ✓ connected — daemon responded to GET /config");

  // /provider returns { all, default, connected }:
  //   all       — full models.dev catalog of providers (~137)
  //   default   — providerID -> default modelID
  //   connected — providerIDs that actually have credentials (from auth.json)
  const providers = await client.provider.list({ throwOnError: true });
  const all = providers.data?.all ?? [];
  const defaults = providers.data?.default ?? {};
  const connected = providers.data?.connected ?? [];
  console.log(`[controller] ✓ ${all.length} providers in catalog, ${connected.length} connected`);
  for (const id of connected) {
    console.log(`             - ${id}${defaults[id] ? ` (default model: ${defaults[id]})` : ""}`);
  }

  // Pick a usable provider/model: a connected provider with a resolved default model.
  const usableID = connected.find((id) => defaults[id]);
  let modelID = usableID ? defaults[usableID] : undefined;
  if (usableID) {
    // The provider default may be a vision/specialty model; prefer a text coding
    // model when the provider exposes one (e.g. glm-4.6 over glm-5v-turbo).
    const providerObj = all.find((p) => p.id === usableID);
    const models = Object.keys(providerObj?.models ?? {});
    const preferred = models.find((m) => /glm-4\.6|glm-4\.5|coding|chat/i.test(m) && !/v-|vision|image/i.test(m));
    if (preferred) modelID = preferred;
    console.log(`[controller] ✓ usable provider: ${usableID}/${modelID}`);
  } else {
    console.log("[controller] ⚠ no connected provider with a default model — inference skipped");
  }

  // Optional end-to-end inference check.
  if (TEST_PROMPT && usableID) {
    console.log(`[controller] sending test prompt to ${usableID}/${modelID}...`);
    const session = await client.session.create({
      body: { title: "controller smoke test" },
      throwOnError: true,
    });
    const sessionID = session.data.id;
    const reply = await client.session.prompt({
      path: { id: sessionID },
      body: {
        model: { providerID: usableID, modelID },
        parts: [{ type: "text", text: TEST_PROMPT }],
      },
      throwOnError: true,
    });
    const text = (reply.data?.parts ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    console.log(`[controller] ✓ model replied: ${text.slice(0, 500)}`);
  }

  console.log("[controller] ✓ all checks passed");
}

main().catch((err) => {
  console.error("[controller] ✗ failed:", err);
  process.exit(1);
});

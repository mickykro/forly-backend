#!/usr/bin/env node
/*
 * Starts the Forly server in watched local-posting mode.
 * No warm-up browser activity is allowed; every post needs explicit approval.
 */
const { spawn } = require("child_process");

Object.assign(process.env, {
  FORLY_ENV: "local",
  POSTING_LOCAL_TEST: "1",
  POSTING_SWEEPER: "1",
  POSTING_ENABLED: "1",
  DRIVER_DEV_VIEW: "1",
});

const portArg = Number(process.argv[2]);
const port = Number.isInteger(portArg) && portArg > 0 && portArg < 65536
  ? portArg : Number(process.env.PORT || 8787);
const base = `http://127.0.0.1:${port}`;
const monitor = `${base}/dev-driver.html`;

console.log("\nLOCAL POSTING TEST MODE");
console.log(`Browser monitor: ${monitor}`);
console.log(`Campaigns:       ${base}/autopublish.html`);
console.log("NOTE: warm-up and idle browsing are disabled.");
console.log("STICKY NOTE: every post waits for your approval before a browser opens and clicks Post.");
console.log("STICKY NOTE: production safety gates, identity proof, destination proof, one-click semantics, cooldowns and stop controls remain active.\n");

function openMonitor() {
  if (process.env.POSTING_LOCAL_OPEN === "0") return;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", monitor] : [monitor];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

async function openWhenReady() {
  if (process.env.POSTING_LOCAL_OPEN === "0") return;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(base, { redirect: "manual" });
      if (r.status > 0) { openMonitor(); return; }
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.warn(`NOTE: server did not become reachable in 30 seconds; open ${monitor} manually after it starts.`);
}

openWhenReady().catch(() => {});
process.argv = [process.argv[0], require.resolve("../server/index.js"), ...(portArg ? [String(portArg)] : [])];
require("../server/index.js");

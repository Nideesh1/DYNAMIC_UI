import { test } from "node:test";
import assert from "node:assert/strict";
import { launchdPlist, loginPath, restartArgv, systemdUnit } from "../lib/autostart.mjs";
import { refreshStaleServer } from "../lib/server.mjs";

const argv = ["/opt/homebrew/bin/node", "/Users/me/Library/Caches/agentglow/cli/0.2.6/cli/agentglow.mjs", "start", "--port", "8100"];

test("launchd plist runs the server in the foreground, supervised, with a real PATH", () => {
  const p = launchdPlist({ argv, env: { PATH: "/a:/b", HOME: "/Users/me" }, home: "/Users/me" });
  assert.match(p, /<key>Label<\/key><string>com\.agentglow\.server<\/string>/);
  for (const a of argv) assert.ok(p.includes(`<string>${a}</string>`), a);
  assert.ok(!p.includes("--background") && !p.includes("/bin/sh"), "no shell, no fire-and-forget launcher");
  assert.match(p, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(p, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(p, /<key>PATH<\/key><string>\/a:\/b<\/string>/);
  assert.ok(p.includes("/Users/me/Library/Logs/agentglow.log"));
});

test("launchd plist escapes XML", () => {
  const p = launchdPlist({ argv: ["/x/a&b<c>"], env: {}, home: "/h" });
  assert.ok(p.includes("/x/a&amp;b&lt;c&gt;"));
});

test("systemd unit runs in the foreground and restarts on failure", () => {
  const u = systemdUnit({ argv, env: { PATH: "/a:/b" } });
  assert.ok(u.includes(`ExecStart=${argv.join(" ")}`));
  assert.ok(!u.includes("--background") && !u.includes("/bin/sh"));
  assert.match(u, /Restart=on-failure/);
  assert.match(u, /Environment=PATH=\/a:\/b/);
});

test("loginPath adds the usual uv/node locations, no duplicates", () => {
  const p = loginPath({ home: "/Users/me", node: "/opt/homebrew/bin/node", base: "/usr/bin:/bin" }).split(":");
  for (const d of ["/opt/homebrew/bin", "/Users/me/.local/bin", "/usr/bin", "/bin"]) assert.ok(p.includes(d), d);
  assert.equal(p.length, new Set(p).size);
});

test("restart argv: launchd kickstart -k of the agent label, systemd --user restart", () => {
  assert.deepEqual(restartArgv({ platform: "darwin", uid: 501 }), ["launchctl", "kickstart", "-k", "gui/501/com.agentglow.server"]);
  assert.deepEqual(restartArgv({ platform: "linux" }), ["systemctl", "--user", "restart", "agentglow"]);
  assert.equal(restartArgv({ platform: "win32" }), null);
});

/** fake server: `versions` = what /live/health answers over time (each call advances while `advance` says so) */
function fake(versions, { restartWorks = true } = {}) {
  const calls = [];
  let v = versions[0];
  const deps = {
    version: async () => v,
    stop: async () => (calls.push("stop"), "not-ours"),
    restart: () => (calls.push("restart"), restartWorks && (v = versions[1]), restartWorks),
    listeners: () => (calls.push("listeners"), [4242]),
    kill: (pid) => (calls.push(`kill ${pid}`), (v = versions[2] ?? versions[1])),
    sleep: async () => {},
    timeoutMs: 50,
  };
  return { deps, calls };
}

test("setup replaces a server of another version: stop, kickstart, wait for the new one", async () => {
  const { deps, calls } = fake(["0.2.12", "0.4.0"]);
  const logs = [];
  assert.equal(await refreshStaleServer({ port: 8100, expected: "0.4.0", log: (m) => logs.push(m), deps }), "restarted");
  assert.deepEqual(calls, ["stop", "restart"]);
  assert.match(logs[0], /0\.2\.12.*0\.4\.0/);
});

test("same version: nothing restarted", async () => {
  const { deps, calls } = fake(["0.4.0", "0.4.0"]);
  assert.equal(await refreshStaleServer({ port: 8100, expected: "0.4.0", log: () => {}, deps }), "current");
  assert.deepEqual(calls, []);
});

test("an unmanaged old server survives the kickstart: terminated by port, then the login item restarts", async () => {
  const { deps, calls } = fake(["0.2.12", "0.2.12", "0.4.0"], { restartWorks: false });
  assert.equal(await refreshStaleServer({ port: 8100, expected: "0.4.0", log: () => {}, deps }), "restarted");
  assert.deepEqual(calls, ["stop", "restart", "listeners", "kill 4242", "restart"]);
});

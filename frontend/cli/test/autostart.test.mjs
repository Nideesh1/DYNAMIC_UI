import { test } from "node:test";
import assert from "node:assert/strict";
import { launchdPlist, loginPath, systemdUnit } from "../lib/autostart.mjs";

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

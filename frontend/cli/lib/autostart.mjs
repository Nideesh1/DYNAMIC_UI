// OS-native "start AgentGlow at login" so the server is always already running, and `setup` (pointed at it via
// AGENTGLOW_URL) can skip the per-session SessionStart command hook entirely - no shell spawn on every `claude`
// session. One mechanism per platform; `command` is the same string `startHookCommand()` would use for the hook,
// so autostart and the hook always resolve to the exact same way of starting the server.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TASK_NAME = "AgentGlow";
const LABEL = "com.agentglow.server";

export const plistPath = (home = os.homedir()) => path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
export const systemdUnitPath = (home = os.homedir()) =>
  path.join(home, ".config", "systemd", "user", "agentglow.service");
export const startupScriptPath = (home = os.homedir()) =>
  path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "AgentGlow.vbs");

function winTaskCommand(command) {
  // schtasks runs /tr through cmd.exe already; keep it a single quoted string, inner quotes escaped.
  return `cmd /c "${command.replace(/"/g, '\\"')}"`;
}

// Runs hidden (no console flash) at login - no special privilege needed, just write access to the user's own
// Startup folder, which (unlike Task Scheduler) corporate Group Policy essentially never locks down. Wrapped in
// cmd /c like the Task Scheduler path (not run as a bare program) since `command` may use shell syntax (the "||
// fallback to npx" from startHookCommand), which WshShell.Run can't interpret on its own.
function startupVbs(command) {
  const esc = winTaskCommand(command).replace(/"/g, '""');
  return `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run "${esc}", 0, False\r\n`;
}

function launchdPlist(command) {
  const esc = command.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>${esc}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>/tmp/agentglow-autostart.log</string>
  <key>StandardErrorPath</key><string>/tmp/agentglow-autostart.log</string>
</dict></plist>
`;
}

function systemdUnit(command) {
  return `[Unit]
Description=AgentGlow server

[Service]
ExecStart=/bin/sh -c ${JSON.stringify(command)}
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

/** Install an OS-level "run this command at login" entry. Returns { method, path? }. Throws on failure. */
export function installAutostart({ command, platform = process.platform, home = os.homedir() } = {}) {
  if (platform === "win32") {
    try {
      execFileSync("schtasks", ["/create", "/tn", TASK_NAME, "/tr", winTaskCommand(command), "/sc", "onlogon", "/rl", "limited", "/f"],
        { stdio: "pipe" });
      return { method: "Task Scheduler", name: TASK_NAME };
    } catch (e) {
      // Task Scheduler creation is commonly blocked by corporate Group Policy even for a user's own tasks;
      // fall back to a Startup-folder launcher, which only needs normal write access to the user's own profile.
      const file = startupScriptPath(home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, startupVbs(command));
      return { method: "Startup folder (Task Scheduler was blocked)", path: file };
    }
  }
  if (platform === "darwin") {
    const file = plistPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, launchdPlist(command));
    try { execFileSync("launchctl", ["unload", file], { stdio: "pipe" }); } catch { /* wasn't loaded */ }
    execFileSync("launchctl", ["load", "-w", file], { stdio: "pipe" });
    return { method: "launchd", path: file };
  }
  // linux and other unix: systemd --user
  const file = systemdUnitPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, systemdUnit(command));
  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
  execFileSync("systemctl", ["--user", "enable", "--now", "agentglow"], { stdio: "pipe" });
  return { method: "systemd --user", path: file };
}

/** Undo installAutostart(). Best-effort: never throws, so `remove` always completes. */
export function removeAutostart({ platform = process.platform, home = os.homedir() } = {}) {
  if (platform === "win32") {
    try { execFileSync("schtasks", ["/delete", "/tn", TASK_NAME, "/f"], { stdio: "pipe" }); } catch { /* not installed */ }
    try { fs.rmSync(startupScriptPath(home), { force: true }); } catch { /* ignore */ }
    return;
  }
  if (platform === "darwin") {
    const file = plistPath(home);
    try { execFileSync("launchctl", ["unload", file], { stdio: "pipe" }); } catch { /* wasn't loaded */ }
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    return;
  }
  try { execFileSync("systemctl", ["--user", "disable", "--now", "agentglow"], { stdio: "pipe" }); } catch { /* not installed */ }
  try { fs.rmSync(systemdUnitPath(home), { force: true }); } catch { /* ignore */ }
}

/** Best-effort check: is the autostart entry currently installed? Never throws. */
export function hasAutostart({ platform = process.platform, home = os.homedir() } = {}) {
  try {
    if (platform === "win32") {
      if (fs.existsSync(startupScriptPath(home))) return true;
      execFileSync("schtasks", ["/query", "/tn", TASK_NAME], { stdio: "pipe" });
      return true;
    }
    if (platform === "darwin") return fs.existsSync(plistPath(home));
    return fs.existsSync(systemdUnitPath(home));
  } catch {
    return false;
  }
}

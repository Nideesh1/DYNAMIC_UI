// OS-native "start AgentGlow at login" (installed by `agentglow setup`): the server is always already running for
// every claude session, survives reboots and is restarted on crash. macOS/Linux run it in the foreground under
// launchd/systemd (argv); Windows uses Task Scheduler (or the Startup folder) with the hook's shell command.
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

const xml = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const launchdLogPath = (home = os.homedir()) => path.join(home, "Library", "Logs", "agentglow.log");

/** PATH for login-time jobs: launchd/systemd start with a bare PATH, so add where uv/uvx/node usually live. */
export function loginPath({ home = os.homedir(), node = process.execPath, base = process.env.PATH || "" } = {}) {
  const dirs = [path.dirname(node), path.join(home, ".local", "bin"), path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", ...base.split(path.delimiter)];
  return [...new Set(dirs.filter(Boolean))].join(path.delimiter);
}

// The server runs in the FOREGROUND under launchd/systemd (not `start --background`): a job whose process exits
// right away gets its spawned children reaped, and a supervised foreground process can be restarted on crash.
// `start` exits 0 when a server is already up on the port, so KeepAlive {SuccessfulExit: false} never loops.
export function launchdPlist({ argv, env = {}, home = os.homedir() }) {
  const args = argv.map((a) => `<string>${xml(a)}</string>`).join("");
  const envs = Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join("");
  const log = xml(launchdLogPath(home));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args}</array>
  <key>EnvironmentVariables</key><dict>${envs}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
}

export function systemdUnit({ argv, env = {} }) {
  const q = (a) => (/[\s"\\]/.test(a) ? JSON.stringify(a) : a);
  const envLines = Object.entries(env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`).join("\n");
  return `[Unit]
Description=AgentGlow server

[Service]
ExecStart=${argv.map(q).join(" ")}
${envLines}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

/** Install an OS-level "run this command at login" entry. Returns { method, path? }. Throws on failure. */
export function installAutostart({ command, argv, env = {}, platform = process.platform, home = os.homedir() } = {}) {
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
    fs.mkdirSync(path.dirname(launchdLogPath(home)), { recursive: true });
    fs.writeFileSync(file, launchdPlist({ argv, env, home }));
    try { execFileSync("launchctl", ["unload", file], { stdio: "pipe" }); } catch { /* wasn't loaded */ }
    execFileSync("launchctl", ["load", "-w", file], { stdio: "pipe" });  // RunAtLoad: starts it right now too
    return { method: "launchd", path: file };
  }
  // linux and other unix: systemd --user
  const file = systemdUnitPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, systemdUnit({ argv, env }));
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

/** Stop the login-item server for now (it starts again at next login / next claude session). Never throws. */
export function stopLoginItem({ platform = process.platform } = {}) {
  try {
    if (platform === "darwin") execFileSync("launchctl", ["stop", LABEL], { stdio: "pipe" });
    else if (platform === "win32") execFileSync("schtasks", ["/end", "/tn", TASK_NAME], { stdio: "pipe" });
    else execFileSync("systemctl", ["--user", "stop", "agentglow"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** argv that restarts the login-item server now (kills the running one first); null on Windows (two schtasks calls). */
export function restartArgv({ platform = process.platform, uid = process.getuid?.() ?? 0 } = {}) {
  if (platform === "darwin") return ["launchctl", "kickstart", "-k", `gui/${uid}/${LABEL}`];
  if (platform === "win32") return null;
  return ["systemctl", "--user", "restart", "agentglow"];
}

/** Restart the login-item server (e.g. setup installed a newer version while an older one runs). Never throws. */
export function restartLoginItem({ platform = process.platform } = {}) {
  try {
    if (platform === "win32") {
      try { execFileSync("schtasks", ["/end", "/tn", TASK_NAME], { stdio: "pipe" }); } catch { /* not running */ }
      execFileSync("schtasks", ["/run", "/tn", TASK_NAME], { stdio: "pipe" });
    } else {
      const [cmd, ...args] = restartArgv({ platform });
      execFileSync(cmd, args, { stdio: "pipe" });
    }
    return true;
  } catch {
    return false;
  }
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

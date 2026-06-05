import * as vscode from "vscode";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

interface UsageData {
  session?: { utilization: number; resetsAt?: number };
  weekly?: { utilization: number; resetsAt?: number };
}

const CRED_FILE = path.join(os.homedir(), ".claude", ".credentials.json");
const DATA_FILE = path.join(os.homedir(), ".claude", "usage-bar-data.json");
const POLL_MS = 5 * 60 * 1000;

let statusBarItem: vscode.StatusBarItem;
let out: vscode.OutputChannel;
let cached: UsageData = {};
let ctx: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext) {
  ctx = context;
  out = vscode.window.createOutputChannel("Claude Usage");
  context.subscriptions.push(out);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBarItem.command = "claudeUsage.refresh";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const saved = context.globalState.get<UsageData>("usage");
  if (saved) cached = saved;
  updateBar();

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeUsage.refresh", fetchUsage)
  );

  fetchUsage();
  watchDataFile();

  const pollTimer = setInterval(fetchUsage, POLL_MS);
  const resetTimer = setInterval(() => { resetExpired(); updateBar(); }, 30_000);
  context.subscriptions.push({ dispose: () => { clearInterval(pollTimer); clearInterval(resetTimer); } });
}

// ── Credentials ───────────────────────────────────────────────────────────────

function readToken(): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(CRED_FILE, "utf-8")) as Record<string, unknown>;
    const oauth = raw.claudeAiOauth as Record<string, unknown> | undefined;
    if (typeof oauth?.accessToken === "string") {
      out.appendLine(`[auth] claudeAiOauth.accessToken gefunden (${oauth.accessToken.slice(0, 8)}...)`);
      return oauth.accessToken;
    }
    if (typeof raw.accessToken === "string") return raw.accessToken;
    if (typeof raw.apiKey === "string") return raw.apiKey;
    out.appendLine("[auth] Kein Token gefunden in .credentials.json");
  } catch (e) {
    out.appendLine(`[auth] Fehler beim Lesen: ${e}`);
  }
  return undefined;
}

// ── Aktives Polling ───────────────────────────────────────────────────────────

function fetchUsage() {
  const token = readToken();
  if (!token) return;

  // claude.ai OAuth → beide mögliche Endpoints versuchen
  const candidates = [
    { hostname: "api.anthropic.com", path: "/api/oauth/usage" },
    { hostname: "claude.ai",         path: "/api/oauth/usage" },
  ];

  tryNext(candidates, 0, token);
}

function tryNext(candidates: { hostname: string; path: string }[], idx: number, token: string) {
  if (idx >= candidates.length) {
    out.appendLine("[fetch] Alle Endpoints fehlgeschlagen");
    return;
  }
  const { hostname, path: reqPath } = candidates[idx];
  out.appendLine(`[fetch] Versuche https://${hostname}${reqPath}`);

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/json",
    "User-Agent": "claude-code",
  };

  const req = https.request({ hostname, path: reqPath, method: "GET", headers }, (res) => {
    let body = "";
    res.on("data", (c: Buffer) => (body += c.toString()));
    res.on("end", () => {
      out.appendLine(`[fetch] ${hostname} → HTTP ${res.statusCode}`);
      if (body.length < 500) out.appendLine(`[fetch] Body: ${body}`);
      if (res.statusCode === 200) {
        try {
          handleUsageData(JSON.parse(body) as Record<string, unknown>);
          return;
        } catch (e) {
          out.appendLine(`[fetch] JSON-Fehler: ${e}`);
        }
      }
      // Nächsten Endpoint versuchen
      tryNext(candidates, idx + 1, token);
    });
  });
  req.on("error", (e: Error) => {
    out.appendLine(`[fetch] Netzwerkfehler (${hostname}): ${e.message}`);
    tryNext(candidates, idx + 1, token);
  });
  req.end();
}

// ── Daten verarbeiten ─────────────────────────────────────────────────────────

function handleUsageData(data: Record<string, unknown>) {
  out.appendLine(`[parse] Felder: ${Object.keys(data).join(", ")}`);
  const next: UsageData = {};

  const fiveHour = data.five_hour as Record<string, unknown> | undefined;
  if (fiveHour?.utilization != null) {
    next.session = {
      utilization: normalizeUtil(fiveHour.utilization as number),
      resetsAt: parseTime(fiveHour.resets_at),
    };
  }

  const sevenDay = (data.seven_day ?? data.seven_day_sonnet) as Record<string, unknown> | undefined;
  if (sevenDay?.utilization != null) {
    next.weekly = {
      utilization: normalizeUtil(sevenDay.utilization as number),
      resetsAt: parseTime(sevenDay.resets_at),
    };
  }

  if (!next.session && !next.weekly) {
    out.appendLine("[parse] Keine bekannten Felder (five_hour/seven_day) gefunden");
    return;
  }

  cached = next;
  ctx.globalState.update("usage", cached);
  updateBar();
  out.appendLine(`[parse] OK: session=${JSON.stringify(next.session)} weekly=${JSON.stringify(next.weekly)}`);
}

function normalizeUtil(v: number): number {
  return v > 1 ? v / 100 : v;
}

function parseTime(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const ms = new Date(v).getTime();
    return isNaN(ms) ? undefined : ms / 1000;
  }
  return undefined;
}

// ── Datei-Fallback ────────────────────────────────────────────────────────────

function watchDataFile() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) return;
    fs.watch(dir, (_e, filename) => {
      if (filename === path.basename(DATA_FILE)) readDataFile();
    });
    readDataFile();
  } catch {}
}

function readDataFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")) as Record<string, unknown>;
    if (typeof raw.timestamp !== "number") return;
    if (Date.now() / 1000 - raw.timestamp > 6 * 3600) return;
    const rl = raw.rate_limits as Record<string, Record<string, unknown>> | undefined;
    if (rl?.five_hour?.used_percentage != null) {
      cached.session = { utilization: (rl.five_hour.used_percentage as number) / 100, resetsAt: rl.five_hour.resets_at as number | undefined };
    }
    if (rl?.seven_day?.used_percentage != null) {
      cached.weekly = { utilization: (rl.seven_day.used_percentage as number) / 100, resetsAt: rl.seven_day.resets_at as number | undefined };
    }
    updateBar();
  } catch {}
}

// ── Ablauf ────────────────────────────────────────────────────────────────────

function resetExpired() {
  const now = Date.now() / 1000;
  if (cached.session?.resetsAt && now >= cached.session.resetsAt) cached.session = { utilization: 0 };
  if (cached.weekly?.resetsAt && now >= cached.weekly.resetsAt) cached.weekly = { utilization: 0 };
}

// ── Statusleiste ──────────────────────────────────────────────────────────────

function miniBar(pct: number): string {
  const filled = Math.round(pct / 25);
  return "▰".repeat(filled) + "▱".repeat(4 - filled);
}

function tooltipBar(pct: number): string {
  const filled = Math.round(pct / 10);
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
}

function circleIcon(pct: number): string {
  if (pct === 0) return "○";
  if (pct <= 25) return "◔";
  if (pct <= 50) return "◑";
  if (pct <= 75) return "◕";
  return "⬤";
}


function resetLabel(epochSec: number): string {
  const date = new Date(epochSec * 1000);
  const day = date.getDate();
  const month = date.toLocaleString("de-DE", { month: "long" });
  const hh = date.getHours().toString().padStart(2, "0");
  const mm = date.getMinutes().toString().padStart(2, "0");
  return `Setzt ${day}. ${month} um ${hh}:${mm} zurück`;
}

function updateBar() {
  const s = cached.session;
  const w = cached.weekly;

  if (!s && !w) {
    statusBarItem.text = "✦";
    statusBarItem.tooltip = "Claude Usage: Noch keine Daten · Klick zum Aktualisieren";
    statusBarItem.backgroundColor = undefined;
    return;
  }

  const parts: string[] = [];
  const pcts: number[] = [];

  if (s) {
    const pct = Math.floor(s.utilization * 100);
    parts.push(`S:${miniBar(pct)}${pct}%`);
    pcts.push(pct);
  }
  if (w) {
    const pct = Math.floor(w.utilization * 100);
    parts.push(`W:${miniBar(pct)}${pct}%`);
    pcts.push(pct);
  }

  statusBarItem.text = parts.join("  ");

  const md = new vscode.MarkdownString("", true);
  md.supportThemeIcons = true;
  md.isTrusted = true;
  md.appendMarkdown("### Claude Usage\n\n");
  if (s) {
    const pct = Math.floor(s.utilization * 100);
    const resetStr = s.resetsAt ? resetLabel(s.resetsAt) : "";
    md.appendMarkdown(`| **Session (5h)** | ${resetStr} |\n|---|---|\n\n`);
    md.appendMarkdown(`**${pct}% verwendet**\n\n`);
    md.appendMarkdown(`${tooltipBar(pct)}\n\n`);
  }
  if (w) {
    const pct = Math.floor(w.utilization * 100);
    const resetStr = w.resetsAt ? resetLabel(w.resetsAt) : "";
    if (s) md.appendMarkdown("---\n\n");
    md.appendMarkdown(`| **Weekly (7d)** | ${resetStr} |\n|---|---|\n\n`);
    md.appendMarkdown(`**${pct}% verwendet**\n\n`);
    md.appendMarkdown(`${tooltipBar(pct)}\n\n`);
  }
  statusBarItem.tooltip = md;

  const maxPct = Math.max(...pcts);
  statusBarItem.backgroundColor =
    maxPct >= 90 ? new vscode.ThemeColor("statusBarItem.errorBackground") :
    maxPct >= 70 ? new vscode.ThemeColor("statusBarItem.warningBackground") :
    undefined;
}

export function deactivate() {}

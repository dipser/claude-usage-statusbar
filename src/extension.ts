import * as vscode from "vscode";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as diagnostics_channel from "diagnostics_channel";

/**
 * Claude Usage Statusbar
 * ----------------------
 * Liest passiv die HTTP-Antworten von Claude Code via Node.js diagnostics_channel
 * (kein einziger zusätzlicher API-Call).
 * Zeigt Session- und Weekly-Nutzung in der VS Code Statusleiste.
 */

interface UsageData {
  session?: { utilization: number; resetsAt?: number };
  weekly?: { utilization: number; resetsAt?: number };
}

// Sicherheitslimit: Antwort-Body nicht größer als 1 MB laden
const MAX_BODY = 1024 * 1024;

// Datei-Fallback für Claude-Terminal-Sitzungen
const DATA_FILE = path.join(os.homedir(), ".claude", "usage-bar-data.json");

let statusBarItem: vscode.StatusBarItem;
let cached: UsageData = {};
let extensionCtx: vscode.ExtensionContext;

// Referenzen für korrektes unsubscribe() (WeakRef würde nicht funktionieren)
let dcRequestHandler: ((msg: unknown) => void) | undefined;
let dcResponseHandler: ((msg: unknown) => void) | undefined;

// Nur eigene Requests tracken (WeakSet = kein Memory-Leak)
const pendingRequests = new WeakSet<http.ClientRequest>();

export function activate(context: vscode.ExtensionContext) {
  extensionCtx = context;

  // Status-Bar-Element anlegen
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    50
  );
  statusBarItem.command = "claudeUsage.info";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Letzten gespeicherten Zustand wiederherstellen
  const saved = context.globalState.get<UsageData>("usage");
  if (saved) {
    cached = saved;
  }
  updateBar();

  // Klick-Kommando: Info-Meldung
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeUsage.info", () => {
      vscode.window.showInformationMessage(
        "Claude Usage: Daten werden automatisch aktualisiert, wenn Claude Code eine Anfrage verarbeitet."
      );
    })
  );

  // Passiver HTTP-Interceptor (kein eigener API-Call)
  installIntercept();

  // Datei-Watcher als Fallback für Terminal-Sitzungen
  watchDataFile();

  // Alle 30 Sekunden: ablaufende Limits zurücksetzen & Anzeige aktualisieren
  const timer = setInterval(() => {
    resetExpired();
    updateBar();
    if (Object.keys(cached).length > 0) {
      context.globalState.update("usage", cached);
    }
  }, 30_000);

  context.subscriptions.push({
    dispose: () => {
      clearInterval(timer);
      uninstallIntercept();
    },
  });
}

// ── Passiver HTTP-Interceptor ────────────────────────────────────────────────

function installIntercept() {
  if (dcRequestHandler || dcResponseHandler) uninstallIntercept();

  try {
    // Feuert für JEDEN ausgehenden HTTP-Request im Extension-Host-Prozess
    dcRequestHandler = (message: unknown) => {
      try {
        const req = (message as { request: http.ClientRequest }).request;
        if (!req) return;
        const reqPath = (req as unknown as { path?: string }).path;
        // Nur anthropic.com Usage-Endpunkt – expliziter Host-Check verhindert
        // dass unverwandte Extensions unbeabsichtigt getrackt werden
        const host = req.getHeader?.("host") as string | undefined;
        if (
          reqPath?.includes("/api/oauth/usage") &&
          host?.includes("anthropic.com")
        ) {
          pendingRequests.add(req);
        }
      } catch {
        // Niemals andere Extensions unterbrechen
      }
    };

    // Feuert wenn eine Antwort vollständig empfangen wurde
    dcResponseHandler = (message: unknown) => {
      try {
        const msg = message as {
          request: http.ClientRequest;
          response: http.IncomingMessage;
        };
        if (!pendingRequests.has(msg.request)) return;
        pendingRequests.delete(msg.request);
        if (msg.response.statusCode === 200) {
          tapBody(msg.response);
        }
      } catch {
        // Niemals andere Extensions unterbrechen
      }
    };

    diagnostics_channel.subscribe(
      "http.client.request.start",
      dcRequestHandler
    );
    diagnostics_channel.subscribe(
      "http.client.response.finish",
      dcResponseHandler
    );
  } catch {
    // diagnostics_channel nicht verfügbar – nur File-Watcher bleibt aktiv
  }
}

function uninstallIntercept() {
  try {
    if (dcRequestHandler)
      diagnostics_channel.unsubscribe(
        "http.client.request.start",
        dcRequestHandler
      );
    if (dcResponseHandler)
      diagnostics_channel.unsubscribe(
        "http.client.response.finish",
        dcResponseHandler
      );
  } catch {}
  dcRequestHandler = undefined;
  dcResponseHandler = undefined;
}

/** Liest den Response-Body mit, ohne den originalen Datenfluss zu stören */
function tapBody(res: http.IncomingMessage) {
  let body = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origOn = res.on.bind(res) as (...args: any[]) => http.IncomingMessage;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any).on = function (event: string, listener: (...args: any[]) => void): http.IncomingMessage {
    if (event === "data") {
      return origOn(event, (chunk: Buffer | string) => {
        if (body.length < MAX_BODY) body += chunk.toString();
        listener(chunk);
      });
    }
    if (event === "end") {
      return origOn(event, (...args: unknown[]) => {
        try {
          if (body) parseUsageResponse(body);
        } catch {}
        listener(...args);
      });
    }
    return origOn(event, listener);
  };
}

// ── Daten parsen ─────────────────────────────────────────────────────────────

function parseUsageResponse(raw: string) {
  const data = JSON.parse(raw) as Record<string, unknown>;
  const next: UsageData = {};

  const fiveHour = data.five_hour as Record<string, unknown> | undefined;
  if (fiveHour?.utilization != null) {
    next.session = {
      utilization: normalizeUtil(fiveHour.utilization as number),
      resetsAt: parseTime(fiveHour.resets_at),
    };
  }

  const sevenDay = (data.seven_day ?? data.seven_day_sonnet) as
    | Record<string, unknown>
    | undefined;
  if (sevenDay?.utilization != null) {
    next.weekly = {
      utilization: normalizeUtil(sevenDay.utilization as number),
      resetsAt: parseTime(sevenDay.resets_at),
    };
  }

  cached = next;
  extensionCtx.globalState.update("usage", cached);
  updateBar();
}

/** API liefert manchmal 0-1, manchmal 0-100 */
function normalizeUtil(v: number): number {
  return v > 1 ? v / 100 : v;
}

/** resets_at kann Unix-Timestamp (Zahl) oder ISO-String sein */
function parseTime(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const ms = new Date(v).getTime();
    return isNaN(ms) ? undefined : ms / 1000;
  }
  return undefined;
}

// ── Datei-Fallback (für Terminal-Claude-Sitzungen) ───────────────────────────

function watchDataFile() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) return;

    fs.watch(dir, (_eventType, filename) => {
      if (filename === path.basename(DATA_FILE)) readDataFile();
    });

    readDataFile();
  } catch {
    // Fallback optional – kein Fehler hochbubbeln
  }
}

function readDataFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")) as Record<
      string,
      unknown
    >;

    // Typ-sichere Prüfung: kein string "now" o.ä. als timestamp
    if (typeof raw.timestamp !== "number") return;
    if (Date.now() / 1000 - raw.timestamp > 6 * 3600) return; // älter als 6h ignorieren

    const rl = raw.rate_limits as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (rl?.five_hour?.used_percentage != null) {
      cached.session = {
        utilization: (rl.five_hour.used_percentage as number) / 100,
        resetsAt: rl.five_hour.resets_at as number | undefined,
      };
    }
    if (rl?.seven_day?.used_percentage != null) {
      cached.weekly = {
        utilization: (rl.seven_day.used_percentage as number) / 100,
        resetsAt: rl.seven_day.resets_at as number | undefined,
      };
    }

    updateBar();
  } catch {
    // Datei-Fehler still ignorieren
  }
}

// ── Abgelaufene Limits zurücksetzen ──────────────────────────────────────────

function resetExpired() {
  const now = Date.now() / 1000;
  if (cached.session?.resetsAt && now >= cached.session.resetsAt) {
    cached.session = { utilization: 0 };
  }
  if (cached.weekly?.resetsAt && now >= cached.weekly.resetsAt) {
    cached.weekly = { utilization: 0 };
  }
}

// ── Statusleiste aktualisieren ───────────────────────────────────────────────

function timeLeft(epochSec: number): string {
  const diff = Math.floor(epochSec - Date.now() / 1000);
  if (diff <= 0) return "gleich";
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function updateBar() {
  const s = cached.session;
  const w = cached.weekly;

  if (!s && !w) {
    statusBarItem.text = "$(check) Claude OK";
    statusBarItem.tooltip =
      "Claude Usage\nNoch keine Daten – sende eine Nachricht in Claude Code.";
    statusBarItem.backgroundColor = undefined;
    return;
  }

  const parts: string[] = [];
  const pcts: number[] = [];

  if (s) {
    const pct = Math.floor(s.utilization * 100);
    const rst = s.resetsAt ? ` · ${timeLeft(s.resetsAt)}` : "";
    parts.push(`S: ${pct}%${rst}`);
    pcts.push(pct);
  }
  if (w) {
    const pct = Math.floor(w.utilization * 100);
    const rst = w.resetsAt ? ` · ${timeLeft(w.resetsAt)}` : "";
    parts.push(`W: ${pct}%${rst}`);
    pcts.push(pct);
  }

  statusBarItem.text = `$(pulse) ${parts.join("  ")}`;

  // Tooltip-Details
  const lines = ["Claude Rate Limits", "─".repeat(22)];
  if (s)
    lines.push(
      `Session (5h): ${Math.floor(s.utilization * 100)}%${s.resetsAt ? "  · Reset in " + timeLeft(s.resetsAt) : ""}`
    );
  if (w)
    lines.push(
      `Weekly  (7d): ${Math.floor(w.utilization * 100)}%${w.resetsAt ? "  · Reset in " + timeLeft(w.resetsAt) : ""}`
    );
  lines.push("", "Aktualisiert automatisch");
  statusBarItem.tooltip = lines.join("\n");

  // Farbwarnung
  const maxPct = Math.max(...pcts);
  if (maxPct >= 90) {
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
  } else if (maxPct >= 70) {
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  } else {
    statusBarItem.backgroundColor = undefined;
  }
}

export function deactivate() {
  uninstallIntercept();
}

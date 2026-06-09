<p align="center">
  <img src="icon.svg" width="96" height="96" alt="Claude Usage Statusbar Icon"/>
</p>

<h1 align="center">Claude Usage Statusbar</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License: MIT"/></a>
</p>

<p align="center">
  Zeigt deine **Claude Code Rate-Limit-Nutzung** (Session 5h & Weekly 7d) direkt in der VS Code Statusleiste.
</p>

<p align="center">
  <img src="example.png" alt="Beispiel: Claude Usage Statusbar"/>
</p>

## Wie es funktioniert

Die Extension liest die gespeicherten Claude-Zugangsdaten aus `~/.claude/.credentials.json` und ruft alle 5 Minuten `/api/oauth/usage` direkt ab. Als Fallback überwacht sie `~/.claude/usage-bar-data.json` für Daten aus Terminal-Claude-Sitzungen. Ein Klick auf die Statusleiste aktualisiert sofort.

## Statusleiste

| Anzeige | Bedeutung |
|---|---|
| `✦` | Noch keine Daten |
| `S:▰▰▱▱45%` | Session 45% (4 von 10 Blöcke) |
| `S:▰▰▱▱45%  W:▰▱▱▱12%` | Session + Weekly |
| Gelber Hintergrund | ≥ 70% |
| Roter Hintergrund | ≥ 90% |

Die 4 Blöcke in der Bar zeigen grobe Stufen: ▱▱▱▱ (0–24%) · ▰▱▱▱ (25–49%) · ▰▰▱▱ (50–74%) · ▰▰▰▱ (75–99%) · ▰▰▰▰ (100%)

## Tooltip

Beim Hover über die Statusleiste erscheint ein detaillierter Tooltip mit:

- **Session (5h)** und **Weekly (7d)** Nutzung
- Fortschrittsbalken mit 10 Blöcken (▰▰▰▱▱▱▱▱▱▱)
- Reset-Datum (z.B. „Setzt 1. Juli um 02:00 zurück")

## Release 1.0.0

- Erste stabile GitHub-Veröffentlichung
- Asset-Verteilung über `releases/tag/v1.0.0`

## Installation (als .vsix-Datei)

1. Die `.vsix`-Datei aus den [Releases](https://github.com/dipser/claude-usage-statusbar/releases) herunterladen
2. In VS Code: `Strg+Shift+P` → **Extensions: Install from VSIX...**
3. Datei auswählen – fertig

Oder per Terminal:
```bash
code --install-extension claude-usage-statusbar-1.0.0.vsix
```

## Selbst bauen

```bash
git clone https://github.com/dipser/claude-usage-statusbar
cd claude-usage-statusbar
npm install
npm run compile
npm run package    # erzeugt .vsix-Datei
```

## Voraussetzungen

- [Claude Code VS Code Extension](https://claude.ai/download) installiert und eingeloggt
- VS Code 1.80+

## Lizenz

MIT

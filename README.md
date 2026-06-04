# Claude Usage Statusbar

Zeigt deine **Claude Code Rate-Limit-Nutzung** (Session 5h & Weekly 7d) direkt in der VS Code Statusleiste – ohne einen einzigen zusätzlichen API-Call.

## Wie es funktioniert

Die Extension hängt sich passiv in den Node.js `diagnostics_channel` ein. Wenn Claude Code selbst seine `/api/oauth/usage`-Anfragen an Anthropic schickt, liest diese Extension die Antwort mit – vollkommen passiv, kein eigener Token, kein eigener Netzwerkaufruf.

## Statusleiste

| Anzeige | Bedeutung |
|---|---|
| `$(check) Claude OK` | Noch keine Daten |
| `$(pulse) S: 42% · 3h 10m` | Session 42%, Reset in 3h 10m |
| `$(pulse) S: 82%  W: 40%` | Session + Weekly |
| Gelber Hintergrund | ≥ 70% |
| Roter Hintergrund | ≥ 90% |

## Installation (als .vsix-Datei)

1. Die `.vsix`-Datei aus den [Releases](../../releases) herunterladen
2. In VS Code: `Strg+Shift+P` → **Extensions: Install from VSIX...**
3. Datei auswählen – fertig

Oder per Terminal:
```bash
code --install-extension claude-usage-statusbar-0.1.0.vsix
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

# mcp-sevdesk

Ein MCP (Model Context Protocol) Server für die sevdesk API. Ermöglicht die Integration von sevdesk-Buchhaltungsfunktionen in Claude und andere MCP-kompatible Anwendungen.

Der Server läuft wahlweise lokal über stdio oder als entfernter Dienst über Streamable HTTP mit Bearer-Token-Authentifizierung.

## Features

- **Kontakte**: Erstellen, lesen, aktualisieren und löschen von Kontakten (Kunden, Lieferanten, Partner)
- **Rechnungen**: Auflisten, abrufen, als PDF exportieren, per E-Mail versenden, buchen und stornieren
- **Belege (Voucher)**: Verwalten von Eingangsrechnungen und Ausgaben
- **Bankkonten**: Verwalten von Bankkonten und Transaktionen
- **Artikel**: Verwalten von Produkten und Dienstleistungen
- **Tags**: Tags anlegen, umbenennen, löschen und Dokumenten zuordnen

## Installation

Voraussetzung ist Node.js 22.12 oder neuer.

```bash
npm install
npm run generate-types
npm run build
```

## Konfiguration

Setze die Umgebungsvariable `SEVDESK_API_TOKEN` mit deinem sevdesk API-Token:

```bash
export SEVDESK_API_TOKEN="dein-32-zeichen-hex-token"
```

Den API-Token findest du in sevdesk unter: Einstellungen → Benutzer → API-Token

## Verwendung

### Als MCP-Server

Füge den Server zu deiner Claude Desktop Konfiguration hinzu (`~/.config/claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sevdesk": {
      "command": "node",
      "args": ["/pfad/zu/mcp-sevdesk/dist/index.js"],
      "env": {
        "SEVDESK_API_TOKEN": "dein-api-token"
      }
    }
  }
}
```

### Direkt ausführen

```bash
SEVDESK_API_TOKEN="dein-token" npm start
```

### Als HTTP-Server (Streamable HTTP)

Mit `MCP_TRANSPORT=http` startet der Server einen HTTP-Endpunkt nach der MCP-Spezifikation (Streamable HTTP) unter `/mcp`. Jede Anfrage muss den Header `Authorization: Bearer <MCP_AUTH_TOKEN>` tragen, sonst antwortet der Server mit `401`.

```bash
SEVDESK_API_TOKEN="dein-token" \
MCP_TRANSPORT=http \
MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
npm start
```

| Variable | Pflicht | Standard | Beschreibung |
|----------|---------|----------|--------------|
| `SEVDESK_API_TOKEN` | ja | | sevdesk API-Token |
| `MCP_TRANSPORT` | nein | `stdio` | `stdio` oder `http` |
| `MCP_AUTH_TOKEN` | bei `http` | | Bearer-Token der Clients, mindestens 32 Zeichen aus `A-Z a-z 0-9 - . _ ~ + /`, optional gefolgt von `=` (RFC 6750). Muss sich vom sevdesk-Token unterscheiden. |
| `MCP_HTTP_HOST` | nein | `127.0.0.1` | Bind-Adresse |
| `MCP_HTTP_PORT` | nein | `3000` | Port |
| `MCP_ALLOWED_HOSTS` | nein | | Kommagetrennte Hostnamen ohne Schema, Port und Pfad, die im `Host`-Header akzeptiert werden (Schutz vor DNS-Rebinding). Internationalisierte Domains in Punycode, IP-Adressen in kanonischer Schreibweise. Leer deaktiviert die Prüfung, außer bei Bindung an eine Loopback-Adresse: Dann gelten `localhost`, `127.0.0.1` und `[::1]`. |
| `MCP_ALLOWED_ORIGINS` | nein | | Kommagetrennte http(s)-Origins wie `https://claude.ai`. Trägt eine Anfrage einen anderen `Origin`-Header, antwortet der Server mit `403`. Anfragen ohne `Origin` (alle Nicht-Browser-Clients) sind immer erlaubt. Leer deaktiviert die Prüfung. |
| `MCP_HTTP_BODY_LIMIT` | nein | `10mb` | Maximale Größe einer Anfrage zwischen `1kb` und `100mb`. `upload_voucher_file` überträgt Dateien base64-kodiert. |
| `MCP_READ_ONLY` | nein | `false` | `true` registriert nur lesende Tools (gilt auch für stdio), siehe [Lesende und schreibende Tools](#lesende-und-schreibende-tools). |

Ungültige Werte führen beim Start zu einer Fehlermeldung und Exit-Code 1.

Verhalten des HTTP-Transports:

- **Zustandslos**: Jede Anfrage erhält eine eigene Server-Instanz, es gibt keine MCP-Sessions. Der Dienst kann daher ohne Session-Affinität neu gestartet oder hinter einem Proxy betrieben werden. Alle Methoden außer `POST` auf `/mcp` beantwortet der Server mit `405`.
- **JSON-Antworten**: Antworten kommen als `application/json`, nicht als SSE-Stream. Clients müssen laut Spezifikation `Accept: application/json, text/event-stream` senden, sonst antwortet der Server mit `406`.
- **Authentifizierung**: Bis auf den Health-Check verlangt jeder Pfad den Bearer-Token, auch unbekannte Pfade antworten ohne Token mit `401`.
- **Health-Check**: `GET /healthz` antwortet ohne Authentifizierung mit `{"status":"ok"}` und gibt keine weiteren Informationen preis.
- **Origin-Prüfung**: Standardmäßig aus. Der Endpunkt akzeptiert ausschließlich Bearer-Token, Browser können diesen Header ohne CORS-Freigabe nicht fremdseitig setzen, und der Server sendet keine CORS-Header. Ein festes Origin-Gate würde dagegen Remote-Clients aussperren, die einen `Origin`-Header mitsenden. Wer die Prüfung braucht, setzt `MCP_ALLOWED_ORIGINS`. Diese Abwägung gilt nur, solange der Token ausschließlich im `Authorization`-Header akzeptiert wird und der Server keine CORS-Header sendet; Tests sichern beides ab.
- **Shutdown**: Bei `SIGTERM` oder `SIGINT` nimmt der Server keine neuen Verbindungen mehr an, schließt ruhende Verbindungen, lässt laufende Anfragen bis zu 10 Sekunden zu Ende laufen und liefert ihre Antworten vollständig aus. Danach beendet er sich mit Exit-Code 0, nach Ablauf der 10 Sekunden mit Exit-Code 1. Ein zweites Signal beendet den Prozess sofort.

Der Bearer-Token gewährt vollen Zugriff auf alle Tools und damit auf den sevdesk-Account, einschließlich schreibender Aktionen wie Rechnungsversand, Stornierung und Löschen von Kontakten. Den Token entsprechend behandeln und nur über HTTPS übertragen.

### Deployment mit Docker Compose

```bash
cp .env.example .env   # SEVDESK_API_TOKEN und MCP_AUTH_TOKEN eintragen
docker compose up -d --build
```

`compose.yaml` baut das Image, startet den Server im HTTP-Modus und härtet den Container (read-only Dateisystem, keine Linux-Capabilities, `no-new-privileges`, Speicherlimit). Das Speicherlimit von 256 MB reicht für sevdesk-Antworten bis etwa 20 MB; bei größeren Abfragen `limit` verwenden oder das Limit in der `compose.override.yaml` erhöhen. Ein Port wird bewusst nicht veröffentlicht. Die Anbindung an einen Reverse Proxy (Netzwerke, Labels, TLS) gehört in eine lokale `compose.override.yaml`, die Docker Compose automatisch einliest und die nicht versioniert wird. Für einen lokalen Test kann dieselbe Datei stattdessen einen Port veröffentlichen, etwa `ports: ["127.0.0.1:3000:3000"]`.

Docker Compose interpoliert die Werte aus `.env`: Ein `$` leitet eine Variable ein und muss als `$$` geschrieben werden. Mit `openssl rand -hex 32` erzeugte Token sind davon nicht betroffen.

### Client-Anbindung über HTTP

Claude Code:

```bash
claude mcp add --transport http sevdesk https://mcp.example.org/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

Andere Clients, die Streamable HTTP mit eigenen Headern unterstützen, werden analog mit URL und `Authorization`-Header konfiguriert. Verlangt der Reverse Proxy zusätzliche Query-Parameter, gehören sie in die URL.

### Unterschiede zum Upstream-Projekt

Dieses Repository ist ein Fork von [nikolausm/mcp-sevdesk](https://github.com/nikolausm/mcp-sevdesk). Es ergänzt den HTTP-Transport und ändert dabei einige Details, die auch den stdio-Betrieb betreffen:

- Die Tools werden über `McpServer.registerTool` des MCP-SDK registriert. Die JSON-Schemas erzeugt das SDK aus den Zod-Schemas. Dadurch enthalten sie jetzt auch die Beschreibungen optionaler Parameter, die der frühere eigene Konverter verlor, und ein `$schema`-Feld (JSON Schema draft-07).
- Ungültige Argumente und unbekannte Tools meldet der Server, so wie das SDK es vorgibt, als Tool-Ergebnis mit `isError: true` statt als JSON-RPC-Fehler. Fehlermeldungen tragen nicht mehr das Präfix `Error: `.
- Jede Antwort der sevdesk API mit einem Status außerhalb von 2xx gilt als Fehler, auch ohne Antworttext. Vorher konnte etwa ein fehlgeschlagenes Löschen ohne Antworttext als Erfolg gemeldet werden. Anfragen an die sevdesk API brechen nach 30 Sekunden ab. Fehlermeldungen nennen Status und Antworttext bzw. die Ursache eines Netzwerkfehlers.
- Der Server kündigt `tools.listChanged: false` an, weil sich die Tool-Liste zur Laufzeit nicht ändert.
- Alle Tools tragen MCP-Annotations, und `MCP_READ_ONLY=true` beschränkt den Server auf lesende Tools.
- Korrekturen an einzelnen Tools, abgeglichen mit der OpenAPI-Spezifikation von sevdesk (gegen die echte API noch nicht geprüft):
  - `mark_invoice_as_sent` sendet `sendType` und `sendDraft` im JSON-Body statt als Query-Parameter. `sendType` ist jetzt Pflicht, `sendDraft` ist standardmäßig `false`.
  - `upload_voucher_file` lädt die Datei als `multipart/form-data` im Feld `file` hoch. Die Parameter `voucherId` und `creditDebit` entfallen, weil der Endpunkt sie nicht kennt und die Datei nur temporär ablegt.
  - `get_invoice_pdf` sendet immer `preventSendBy=true`. Ohne diesen Parameter markiert sevdesk die Rechnung beim Abruf des PDFs als versendet; das Tool ist damit wirklich lesend. Der Parameter `preventSendBy` entfällt.
  - `list_transactions` erwartet `startDate` und `endDate` als ISO-8601-Zeitpunkt mit Zeitzone statt als Unix-Zeitstempel.
  - `book_invoice` und `book_voucher` verwenden die Buchungstypen der Spec (`FULL_PAYMENT`, `N`, `CB`, `CF`, `O`, `OF`, `MTC`); die dort unbekannten `MF` und `C` entfallen. Das Buchungsdatum ist bei Rechnungen ein Unix-Zeitstempel, bei Belegen ein ISO-8601-Zeitpunkt.
  - `create_transaction` sendet den Pflichtstatus (Standard `100`, angelegt) und verlangt `payeePayerName`; Wert- und Buchungsdatum sind ISO-8601-Zeitpunkte.
  - `create_part` und `update_part` senden Preise und Steuersatz als Zahl statt als Text.
  - `list_contacts` akzeptiert für `depth` nur `0` (nur Organisationen) oder `1` (Organisationen und Personen).
  - `list_invoices` und `list_vouchers` erwarten `startDate` und `endDate` als ganze Zahl (Unix-Zeitstempel in Sekunden) statt als Text.
  - `list_check_accounts` gibt `limit` und `offset` an die API weiter.
  - `get_check_account_balance` erwartet `date` im Format `YYYY-MM-DD` und verwendet standardmäßig das heutige Datum in Deutschland statt das UTC-Datum.
  - IDs und `limit` akzeptieren nur positive ganze Zahlen, `offset` nur ganze Zahlen ab 0.
  - Die Listen-Tools senden `limit` und `offset`, obwohl die Spec sie nicht für jeden Endpunkt aufführt; sevdesk unterstützt sie nach bisheriger Nutzung allgemein (nicht gegen die echte API geprüft).

## Verfügbare Tools

### Lesende und schreibende Tools

Jedes Tool trägt MCP-Annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). Clients können damit etwa vor destruktiven Aufrufen nachfragen. Annotations sind Hinweise und kein Zugriffsschutz.

- **Lesend** (19 Tools): alle `list_*`- und `get_*`-Tools.
- **Anlegend**: `create_contact`, `create_part`, `create_tag`, `create_transaction`, `upload_voucher_file`.
- **Ändernd oder löschend** (`destructiveHint: true`): `update_contact`, `delete_contact`, `update_part`, `update_tag`, `delete_tag`, `mark_invoice_as_sent`, `book_invoice`, `cancel_invoice`, `book_voucher` und `send_invoice_by_email`, das zusätzlich eine E-Mail außerhalb von sevdesk verschickt (`openWorldHint: true`).

Mit `MCP_READ_ONLY=true` registriert der Server nur die lesenden Tools. Schreibende Tools erscheinen dann nicht in `tools/list` und lassen sich nicht aufrufen. So lässt sich etwa eine zweite, rein lesende Instanz mit eigenem Token betreiben. Die Einordnung folgt der API-Spezifikation von sevdesk. Die dort beschriebene Nebenwirkung beim PDF-Abruf (Markierung der Rechnung als versendet) unterdrückt `get_invoice_pdf` immer.

### Kontakte

| Tool | Beschreibung |
|------|-------------|
| `list_contacts` | Alle Kontakte auflisten |
| `get_contact` | Einzelnen Kontakt abrufen |
| `create_contact` | Neuen Kontakt erstellen |
| `update_contact` | Kontakt aktualisieren |
| `delete_contact` | Kontakt löschen |

### Rechnungen

| Tool | Beschreibung |
|------|-------------|
| `list_invoices` | Alle Rechnungen auflisten |
| `get_invoice` | Einzelne Rechnung abrufen |
| `get_invoice_pdf` | Rechnung als PDF abrufen |
| `send_invoice_by_email` | Rechnung per E-Mail versenden |
| `mark_invoice_as_sent` | Rechnung mit Versandart als versendet markieren |
| `book_invoice` | Rechnung als bezahlt buchen |
| `cancel_invoice` | Rechnung stornieren |

### Belege (Voucher)

| Tool | Beschreibung |
|------|-------------|
| `list_vouchers` | Alle Belege auflisten |
| `get_voucher` | Einzelnen Beleg abrufen |
| `book_voucher` | Beleg als bezahlt buchen |
| `get_voucher_positions` | Belegpositionen abrufen |
| `upload_voucher_file` | Belegdatei als temporäre Datei hochladen (liefert den Dateinamen für die Belegerstellung) |

### Bankkonten

| Tool | Beschreibung |
|------|-------------|
| `list_check_accounts` | Alle Bankkonten auflisten |
| `get_check_account` | Einzelnes Bankkonto abrufen |
| `get_check_account_balance` | Kontostand abrufen |
| `list_transactions` | Transaktionen auflisten |
| `get_transaction` | Einzelne Transaktion abrufen |
| `create_transaction` | Neue Transaktion erstellen |

### Artikel

| Tool | Beschreibung |
|------|-------------|
| `list_parts` | Alle Artikel auflisten |
| `get_part` | Einzelnen Artikel abrufen |
| `create_part` | Neuen Artikel erstellen |
| `update_part` | Artikel aktualisieren |
| `get_part_stock` | Lagerbestand abrufen |

### Tags

| Tool | Beschreibung |
|------|-------------|
| `list_tags` | Alle Tags auflisten |
| `get_tag` | Einzelnen Tag abrufen |
| `create_tag` | Tag anlegen und einem Dokument zuordnen |
| `update_tag` | Tag umbenennen |
| `delete_tag` | Tag löschen |
| `list_tag_relations` | Zuordnungen von Tags zu Dokumenten auflisten |

## Entwicklung

```bash
npm test
npm run typecheck
```

`npm run typecheck` prüft den Quellcode und die Tests. Die Tests für HTTP-Transport, Server, Tools und den sevdesk-Client laufen ohne Netzwerkzugriff. Die API-Tests sprechen die echte sevdesk API an und laufen nur, wenn `SEVDESK_API_TOKEN` in einer `.env` gesetzt ist. Die Tag-Tests legen dabei Tags an und löschen sie wieder.

## API-Referenz

Dieser Server basiert auf der offiziellen sevdesk API v1. Weitere Informationen zur API findest du in der [sevdesk API-Dokumentation](https://api.sevdesk.de/).

## Lizenz

MIT

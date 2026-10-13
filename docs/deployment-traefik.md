# Glassboard hinter eurem vorhandenen Traefik

Diese Variante übernimmt das Schema eurer Sprint-Installation: bestehendes Docker-Netz `reverse-proxy`, EntryPoint `web-secure`, Zertifikatsresolver `letsencrypt` und Middleware `default@file`. Traefik übernimmt HTTPS; Glassboard selbst liefert HTTP auf Port **3000**. Es wird kein Host-Port veröffentlicht.

**Glassboard braucht nur einen Service.** Die Vorlage enthält Queue, Scheduler und Reverb für eine Laravel-Anwendung. Glassboard nutzt einen Node.js-Prozess, Dateien für Boards/Bilder und WebSockets für Live-Updates. Zusätzliche Worker, Datenbankcontainer, Reverb, Caddy, `APP_KEY` und Mail-Konfiguration sind daher nicht erforderlich.

## Voraussetzungen

- Docker Compose ist installiert.
- Euer Traefik läuft bereits mit Docker-Provider und ist im externen Docker-Netz `reverse-proxy`.
- EntryPoint `web-secure`, Resolver `letsencrypt` und Middleware `default@file` sind in eurem Traefik vorhanden. Falls sie anders heißen, die entsprechenden Labels in der Compose-Datei anpassen. Falls keine `default@file`-Middleware existiert, das Middleware-Label entfernen.
- Der gewünschte Hostname zeigt per DNS auf euren Traefik. Bei einem bestehenden Access-Schutz muss er auch die Pfade `/api/` und `/merge.mjs` sowie WebSocket-Upgrades auf `/api/live` durchlassen und den ursprünglichen Host-Header beibehalten.

## Start

`compose.traefik.yaml` und `.env.example` aus dem Repository in denselben Deployment-Ordner kopieren. Dann:

```sh
cp .env.example .env
```

In `.env` den Hostnamen und bei Bedarf die Version setzen:

```dotenv
COMPOSE_FILE=compose.traefik.yaml
GLASSBOARD_HOST=whiteboard.eure-domain.de
GLASSBOARD_VERSION=1.1.0
```

Starten:

```sh
docker compose config
docker compose pull && docker compose up -d
```

Danach `https://whiteboard.eure-domain.de` öffnen. Das Image liegt öffentlich auf GHCR; dafür ist kein Registry-Login nötig. Die Anwendung selbst hat ebenfalls keine Benutzerkonten.

`COMPOSE_FILE` wählt die Traefik-Datei anstelle der normalen `compose.yaml`. **Die Dateien nicht miteinander zusammenführen**, sonst könnte der veröffentlichte Port aus der normalen Datei übernommen werden. Alternativ jede Aktion ausdrücklich mit `docker compose -f compose.traefik.yaml ...` ausführen.

## Gemeinsames Bearbeiten

Mehrere Personen können dasselbe Whiteboard gleichzeitig bearbeiten. Zeichenstriche, bewegte Elemente, Textvorschauen und die Cursor anderer Personen werden während der Eingabe per WebSocket übertragen. Änderungen an unterschiedlichen Elementen werden automatisch zusammengeführt. Zoom und Pan bleiben je Browser unabhängig. Konflikte am selben Element bleiben als separate Wiederherstellungskopie erhalten.

Der WebSocket läuft über dieselbe Adresse und denselben Container-Port **3000** auf `/api/live`. Traefik unterstützt das Upgrade automatisch; es sind keine zusätzlichen Router, Ports oder Reverb-Container erforderlich. Euer `default@file`-Middleware-/Access-Schutz muss WebSocket-Upgrades erlauben und den ursprünglichen Host-Header beibehalten. Bei HTTPS wird automatisch `wss://` verwendet. Das Statusfeld zeigt „Live“ und bei mehreren Personen deren Anzahl; „Reconnecting…“ bedeutet, dass der WebSocket gerade nicht verbunden ist. Dann übernimmt vorübergehend HTTP-Polling.

## Update auf Live-Collaboration

In der **vorhandenen** `.env` nur `GLASSBOARD_VERSION=1.1.0` setzen (Hostname und Volume behalten), dann:

```sh
docker compose pull && docker compose up -d
```

Danach alle geöffneten Glassboard-Browser-Tabs neu laden. Bestehende Boards und Bilder bleiben ohne Datenmigration erhalten.


## Betrieb

```sh
docker compose logs -f glassboard
docker compose ps
```

Logs erscheinen in `docker compose logs`; der Healthcheck kommt aus dem Image. Updates: `GLASSBOARD_VERSION` ändern, anschließend wieder `docker compose pull && docker compose up -d`.

Das benannte Volume `storage` enthält alle gespeicherten Boards und Bilder. Compose versieht es standardmäßig mit dem Projektnamen als Präfix. Bei einem Serverwechsel den Dienst stoppen und dieses gesamte Volume sichern/wiederherstellen. Beim Wechsel von einer bisherigen Glassboard-Installation deren Datenvolume wiederverwenden oder die Daten vorher übertragen. Normales `docker compose down` behält die Daten; `docker compose down -v` entfernt sie.

Es darf nur eine Glassboard-Instanz auf dasselbe Datenvolume schreiben. Jede Person mit Zugriff auf die Adresse kann alle Boards bearbeiten und löschen; euer vorhandener Netzwerk- oder Proxy-Zugriffsschutz regelt, wer die Adresse erreichen darf.

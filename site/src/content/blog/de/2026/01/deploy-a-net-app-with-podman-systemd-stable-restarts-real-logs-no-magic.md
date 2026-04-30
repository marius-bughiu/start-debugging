---
title: "Eine .NET-App mit Podman + systemd ausliefern: stabile Restarts, echte Logs, keine Magie"
description: ".NET 9- und .NET 10-Dienste auf einer Linux-VM mit Podman und systemd ausliefern. Stabile Restarts, echte Logs über journald und eine containerisierte App, die wie ein richtiger Dienst verwaltet wird -- ganz ohne Kubernetes."
pubDate: 2026-01-10
tags:
  - "docker"
  - "dotnet"
lang: "de"
translationOf: "2026/01/deploy-a-net-app-with-podman-systemd-stable-restarts-real-logs-no-magic"
translatedBy: "claude"
translationDate: 2026-04-30
---
Heute tauchte es in r/dotnet auf: Es wird weiterhin eine "langweilige Bereitstellung" für .NET-Dienste gesucht, die weder Kubernetes noch ein zerbrechliches `nohup`-Skript ist. Auf einer Linux-VM ist Podman zusammen mit systemd ein solider Mittelweg: eine containerisierte App, die wie ein echter Dienst verwaltet wird.

Ursprüngliche Diskussion: [https://www.reddit.com/r/dotnet/comments/1q8gq1u/how_to_deploy_net_applications_with_systemd_and/](https://www.reddit.com/r/dotnet/comments/1q8gq1u/how_to_deploy_net_applications_with_systemd_and/)

## Warum das für .NET 9- und .NET 10-Dienste gut funktioniert

-   **systemd verantwortet die Restarts**: Stürzt der Prozess ab, wird er neu gestartet, und Sie bekommen einen klaren Grund.
-   **journald verantwortet die Logs**: Schluss mit der Suche nach rotierten Dateien auf der Festplatte.
-   **Podman ist daemonlos**: systemd startet genau das, was es braucht.

## Container bauen und starten

Hier ist ein minimales `Containerfile` für eine .NET 9-App (für .NET 10 funktioniert es identisch, einfach das Basis-Tag wechseln):

```dockerfile
FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS base
WORKDIR /app
EXPOSE 8080

FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /out

FROM base
WORKDIR /app
COPY --from=build /out .
ENV ASPNETCORE_URLS=http://+:8080
ENTRYPOINT ["dotnet", "MyApp.dll"]
```

Dann:

```bash
podman build -t myapp:1 .
podman run -d --name myapp -p 8080:8080 myapp:1
```

## systemd übernehmen lassen (der nützliche Teil)

Podman kann eine Unit-Datei erzeugen, die systemd versteht. Hinweis: `podman generate systemd` ist seit Podman 4.4+ zugunsten von [Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html) veraltet, aber die generierte Ausgabe funktioniert weiterhin und zeigt das Konzept klar:

```bash
podman generate systemd --new --name myapp --files
```

Das erzeugt etwas wie `container-myapp.service`. An die richtige Stelle verschieben:

```bash
sudo mv container-myapp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now container-myapp.service
```

Jetzt haben Sie saubere operative Kommandos:

```bash
sudo systemctl status container-myapp.service
sudo journalctl -u container-myapp.service -f
sudo systemctl restart container-myapp.service
```

## Zwei Details, die Sie später retten

### Konfiguration explizit halten

Verwenden Sie Umgebungsvariablen und ein gemountetes Konfigurationsverzeichnis, statt Secrets in das Image zu backen. Mit systemd lassen sich Overrides in einer Drop-in-Datei setzen, und Sie können sicher neu starten.

### Wählen Sie eine Restart-Policy, die der Realität entspricht

Wenn Ihre App wegen fehlender Konfiguration sofort scheitert, sind endlose Restarts nur Lärm. Nehmen Sie eine Restart-Policy, die die Maschine nicht hämmert. systemd erlaubt es, Verzögerungen und Burst-Grenzen zu steuern.

Wenn Sie einen einzigen "Mache ich das richtig?"-Test wollen: starten Sie die VM neu und prüfen Sie, ob Ihr .NET-Dienst wieder hochkommt, ohne dass Sie sich per SSH einloggen müssen. Das ist der Maßstab.

Weiterführend: [https://docs.podman.io/](https://docs.podman.io/)

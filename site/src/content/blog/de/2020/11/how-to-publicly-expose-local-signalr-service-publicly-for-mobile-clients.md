---
title: "Wie Sie Ihren lokalen SignalR-Dienst mit ngrok öffentlich für mobile Clients bereitstellen"
description: "Verwenden Sie ngrok, um Ihren lokalen SignalR-Dienst öffentlich verfügbar zu machen, sodass mobile Clients ohne Netzwerk-Konfiguration oder SSL-Workarounds verbinden können."
pubDate: 2020-11-04
tags:
  - "csharp"
  - "signalr"
  - "xamarin-forms"
lang: "de"
translationOf: "2020/11/how-to-publicly-expose-local-signalr-service-publicly-for-mobile-clients"
translatedBy: "claude"
translationDate: 2026-05-01
---
Im Umgang mit mobilen Clients ist es nicht immer leicht, sie ins selbe Netzwerk wie Ihre Entwicklungsmaschine zu bekommen, und selbst wenn das gelingt, hat `localhost` eine andere Bedeutung; Sie müssen also IPs verwenden, Bindings ändern und SSL deaktivieren oder selbstsignierten Zertifikaten vertrauen, kurz gesagt: ein Krampf.

Sagen Sie hallo zu [ngrok](https://ngrok.com).

ngrok ermöglicht es Ihnen, einen sicheren öffentlichen Proxy zu erstellen, der alle Anfragen an einen bestimmten Port auf Ihrer Entwicklungsmaschine weiterleitet. Der kostenlose Plan erlaubt HTTP/TCP-Tunnel auf zufälligen URLs und Ports für nur einen Prozess sowie maximal 40 Verbindungen/Minute. Das sollte für die meisten mehr als genug sein. Wenn Sie reservierte Domains oder eigene Subdomains und höhere Limits benötigen, gibt es auch kostenpflichtige Pläne.

## Legen wir los

Registrieren Sie sich zunächst bei ngrok, laden Sie deren Client herunter und entpacken Sie ihn an einen bevorzugten Ort. Folgen Sie anschließend dem [Setup & Installation guide](https://ngrok.com/docs/getting-started/) und führen Sie den Befehl `ngrok authtoken` aus, um sich zu authentifizieren.

Starten Sie als Nächstes Ihre Webanwendung und werfen Sie einen Blick auf deren URL. Bei mir ist es `https://localhost:44312/`, das heißt, wir wollen Port 44312 über https weiterleiten. Führen Sie also im selben `cmd`-Fenster, in dem Sie sich authentifiziert haben, `` ngrok http `https://localhost:44312/` `` aus und ersetzen Sie `https://localhost:44312/` natürlich durch die URL Ihrer Anwendung. Das startet Ihren Proxy und zeigt Ihnen die öffentlichen URLs, über die Sie ihn erreichen können.

![ngrok mit einem öffentlichen Proxy im Free-Plan](/wp-content/uploads/2020/10/image-1.png)

Wenn Sie kein HTTPS verwenden, können Sie die kürzere Variante `ngrok http 44312` nutzen.

Erhalten Sie ein 400 Bad Request -- Invalid Hostname, bedeutet das, dass jemand den `Host`-Header validieren möchte und scheitert, weil sie nicht übereinstimmen, da ngrok standardmäßig alles unverändert an Ihren Webserver weiterreicht. Um den `Host`-Header umzuschreiben, verwenden Sie den Schalter `-host-header=rewrite`.

In meinem Fall (mit ASP.NET Core + IIS Express) lautet mein vollständiger Befehl:

`ngrok http -host-header=rewrite https://localhost:44312`

Kopieren Sie nun die URL aus dem oberen Fenster und tragen Sie sie in Ihren Clients ein. Beachten Sie, dass die URL im Free-Plan jedes Mal anders ist, wenn Sie ngrok starten/stoppen.

## Probieren Sie es aus!

Sie können das selbst leicht ausprobieren, indem Sie das ursprüngliche Xamarin-Forms-SignalR-Chat-Beispiel klonen (das GitHub-Repository ist nicht mehr verfügbar), das .Web-Projekt starten und über `ngrok` wie oben beschrieben verfügbar machen. Ersetzen Sie anschließend die `ChatHubUrl` in der `appsettings.json` durch die URL, die `ngrok` für Sie generiert hat.

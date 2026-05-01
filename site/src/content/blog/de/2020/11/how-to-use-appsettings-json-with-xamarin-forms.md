---
title: "appsettings.json mit Xamarin.Forms verwenden"
description: "Erfahren Sie, wie Sie appsettings.json-Konfigurationsdateien mit Xamarin.Forms nutzen, indem Sie die Datei als Ressource einbetten und ein IConfiguration-Objekt aufbauen."
pubDate: 2020-11-13
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "xamarin-forms"
lang: "de"
translationOf: "2020/11/how-to-use-appsettings-json-with-xamarin-forms"
translatedBy: "claude"
translationDate: 2026-05-01
---
Im Vergleich zu ASP.NET gibt es zwei wesentliche Unterschiede:

-   Erstens arbeiten wir mit einem Embedded Resource statt mit einer Datei auf der Festplatte
-   Zweitens registrieren wir die `appsettings.json`-Datei selbst

Legen Sie zum Einstieg eine `appsettings.json`-Datei in Ihrem gemeinsamen Projekt an. Stellen Sie sicher, dass die `Build Action` auf `Embedded Resource` gesetzt ist. Fügen Sie einige Schlüssel + Werte in die Datei ein, die wir zum Testen verwenden können. Zum Beispiel:

```json
{
  "ChatHubUrl": "https://signalrchatweb.azurewebsites.net/"
}
```

Als Nächstes benötigen wir den Ressourcenstream.

```cs
Stream resourceStream = GetType().GetTypeInfo().Assembly.GetManifestResourceStream("SignalRChat.appsettings.json");
```

Und nutzen ihn, um ein `IConfiguration`-Objekt zu erstellen.

```cs
var configuration = new ConfigurationBuilder()
                .AddJsonStream(resourceStream)
                .Build();
```

Um die Konfigurationswerte daraus abzurufen, verwenden Sie es wie jedes andere Dictionary.

```cs
configuration["ChatHubUrl"];
```

Alternativ können Sie es in Ihrem IoC-Container als `IConfiguration` registrieren, in Ihre ViewModels injizieren und auf dieselbe Weise verwenden.

Ein vollständiges Beispiel befand sich ursprünglich im Xamarin-Forms-SignalR-Chat-Repository auf GitHub, das nicht mehr verfügbar ist.

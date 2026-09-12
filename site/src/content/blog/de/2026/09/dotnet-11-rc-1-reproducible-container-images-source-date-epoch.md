---
title: ".NET 11 RC 1 macht Container-Images aus dotnet publish reproduzierbar"
description: "Das .NET 11 RC 1 SDK berücksichtigt SOURCE_DATE_EPOCH beim Veröffentlichen von Container-Images, entfernt die Prozess-ID aus den Tar-Headern der Layer und überspringt Blob-Uploads, wenn die Registry das Manifest bereits hat. Gleicher Commit rein, gleicher Digest raus."
pubDate: 2026-09-12
tags:
  - "dotnet-11"
  - "containers"
  - "sdk"
  - "dotnet"
lang: "de"
translationOf: "2026/09/dotnet-11-rc-1-reproducible-container-images-source-date-epoch"
translatedBy: "claude"
translationDate: 2026-09-12
---

Wer denselben Commit unter .NET 10 zweimal mit `dotnet publish /t:PublishContainer` veröffentlicht, erhält zwei unterschiedliche Image-Digests. Der Code ist identisch, aber das SDK hat die aktuelle Uhrzeit in jeden Layer-Eintrag und in die Image-Konfiguration geschrieben. Außerdem landete die Prozess-ID in jedem Layer-Tar. Eine Registry kann das nicht deduplizieren, und ein GitOps-Controller, der das Tag beobachtet, sieht ein neues Release. [.NET 11 RC 1](https://devblogs.microsoft.com/dotnet/dotnet-11-rc-1/), erschienen am 2026-09-08, behebt beides im integrierten Container-Tooling des SDK ([dotnet/sdk#55836](https://github.com/dotnet/sdk/pull/55836)).

## Vier Stellen, an denen die Uhr in den Digest gelangte

Der [ursprüngliche PR](https://github.com/dotnet/sdk/pull/55689) zählt sie auf:

- Jeder `PaxTarEntry` in einem Layer setzte seine Änderungszeit standardmäßig auf `DateTime.UtcNow`, für jede Datei separat abgefragt.
- Die Image-Konfiguration fragte `DateTime.UtcNow` für `created` ab und dann noch einmal für den generierten History-Eintrag.
- Die Labels `org.opencontainers.image.created` und `org.opencontainers.artifact.created` stammten aus `UtcNow` in der Targets-Datei.
- `TarWriter` benennt jeden erweiterten Pax-Header `./PaxHeaders.<process id>/.`, sodass die PID in jedem Layer landete.

Schon die PID allein genügte, um den Layer-Digest zu ändern, obwohl der Inhalt Byte für Byte identisch war. Nur 13 Bytes des Layers unterschieden sich, alle verursacht durch diesen Header-Namen.

## Aktivierung mit SOURCE_DATE_EPOCH

RC 1 folgt der [Reproducible-Builds-Konvention](https://reproducible-builds.org/docs/source-date-epoch/). Die MSBuild-Eigenschaft `SOURCE_DATE_EPOCH` oder eine gleichnamige Umgebungsvariable, die MSBuild automatisch übernimmt, wird einmal in einen einzigen Zeitstempel geparst. Dieser Wert fließt dann in jeden Tar-Eintrag, das Feld `created` der Konfiguration, den History-Eintrag und beide OCI-Labels:

```bash
dotnet publish -c Release -r linux-x64 /t:PublishContainer \
  -p:ContainerRegistry=registry.example.com \
  -p:SOURCE_DATE_EPOCH="$(git log -1 --pretty=%ct)"
```

Mit dem Commit-Zeitstempel ändert sich der Digest nur, wenn sich der Commit ändert. Ich habe das mit dem RC 1 SDK (`11.0.100-rc.1.26425.128`) geprüft, indem ich eine Konsolen-App dreimal in ein Tarball veröffentlicht habe:

```bash
pub() { dotnet publish -c Release -r linux-x64 /t:PublishContainer \
  -p:ContainerArchiveOutputPath=./$1.tar.gz "${@:2}"; }

pub a -p:SOURCE_DATE_EPOCH=1757635200   # config dc51dd30..., app layer 47af118e...
pub b -p:SOURCE_DATE_EPOCH=1757635200   # config dc51dd30..., app layer 47af118e...
pub c                                   # config 5f24aace..., app layer 2f4f68c1...
```

Die Läufe `a` und `b` sind Byte für Byte identisch, und das Feld `created` der Konfiguration lautet `2025-09-12T00:00:00.0000000Z`. Lauf `c` erhält weiterhin die Systemzeit, Reproduzierbarkeit ist also optional. Ist der Wert fehlerhaft, negativ oder außerhalb des gültigen Bereichs, greift das SDK auf die aktuelle Uhrzeit zurück. Der Build schlägt nicht fehl.

Zwei Nebenwirkungen sollten Sie vor dem Upgrade kennen. Der Layer-Writer sortiert Einträge jetzt nach Container-Pfad, weil die Reihenfolge der Verzeichnisaufzählung vom Dateisystem abhängt. Der Pax-Header-Name ist immer die Konstante `./PaxHeaders/.`. Beides gilt für jede Veröffentlichung, auch ohne `SOURCE_DATE_EPOCH`, sodass sich Ihre Digests beim Umstieg auf RC 1 einmalig ändern.

## Uploads überspringen, die die Registry bereits hat

Die begleitende Änderung ([dotnet/sdk#55838](https://github.com/dotnet/sdk/pull/55838)) baut darauf auf. Vor dem Push sendet das SDK eine `HEAD`-Anfrage für den berechneten Manifest-Digest. Hat die Registry ihn bereits, überspringt das SDK die Uploads von Layern und Konfiguration, setzt trotzdem alle angeforderten Tags und protokolliert `Manifest '...' already exists in repository '...'`. Ein wiederholter CI-Job oder ein zweites Tag auf einem unveränderten Commit reduziert sich so auf ein paar Metadatenaufrufe.

In den RC 1 Targets ist das standardmäßig aktiv: `ContainerPushNoCache` ist standardmäßig `false`. Meldet eine Registry die Existenz von Manifesten falsch, schalten Sie die Prüfung ab:

```bash
dotnet publish /t:PublishContainer -p:ContainerPushNoCache=true
```

Das Image wird weiterhin lokal gebaut, da der Digest zuerst berechnet werden muss. Das spart also Übertragung, nicht Build-Zeit. Außerdem lohnt es sich nur, wenn der Digest stabil ist, weshalb die beiden PRs gemeinsam eingeflossen sind.

Eine weitere Änderung in RC 1, die einen altbekannten Workaround überflüssig macht, finden Sie unter [Signale und Exit-Status bei `Process`](/de/2026/09/dotnet-11-rc-1-process-signal-exit-status/). Die vollständige SDK-Liste steht in den [SDK-Release-Notes zu RC 1](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/sdk.md).

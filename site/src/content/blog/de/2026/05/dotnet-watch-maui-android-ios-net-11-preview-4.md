---
title: "dotnet watch erreicht in .NET 11 Preview 4 endlich MAUI auf Android und iOS"
description: ".NET 11 Preview 4 aktiviert dotnet watch für Android-Geräte, Android-Emulatoren und den iOS-Simulator. Sie bearbeiten, speichern und die laufende App aktualisiert sich ohne manuellen Rebuild. Eine csproj-Falle gilt für iOS."
pubDate: 2026-05-13
tags:
  - "dotnet-11"
  - "maui"
  - "dotnet-watch"
  - "hot-reload"
  - "mobile"
lang: "de"
translationOf: "2026/05/dotnet-watch-maui-android-ios-net-11-preview-4"
translatedBy: "claude"
translationDate: 2026-05-13
---

Microsoft hat [.NET 11 Preview 4 am 12. Mai 2026 veröffentlicht](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/), und für MAUI-Entwickler ist die Schlagzeile im Changelog klein, im Arbeitsalltag aber riesig: `dotnet watch` steuert jetzt Hot Reload auf Android-Geräten, Android-Emulatoren und im iOS-Simulator. Bis zu dieser Preview war die MAUI-Mobile-Schleife "bearbeiten, neu kompilieren, neu deployen" für alles außerhalb von XAML. Preview 4 schließt diese Lücke.

## Der tatsächliche Workflow

Öffnen Sie eine MAUI-App, wählen Sie ein Target Framework und ein Gerät und führen Sie aus:

```bash
dotnet watch --framework net11.0-android
```

Für iOS ist es dieselbe Form, mit dem Target des iOS-Simulators:

```bash
dotnet watch --framework net11.0-ios
```

`dotnet watch` deployt die App einmal, danach werden Dateiänderungsereignisse in Hot-Reload-Deltas übersetzt und an den laufenden Prozess gepusht. C#-Methodenkörper, XAML und CSS laufen alle durch denselben Kanal. Das Hinzufügen einer neuen `PackageReference` oder `ProjectReference` mitten in der Sitzung funktioniert in .NET 11 ebenfalls: Roslyn validiert die Änderung, das Target `ReferenceCopyLocalPathsOutputGroup` kopiert die neuen Assemblys in das Ausgabeverzeichnis und der In-Process-Delta-Applier lädt sie über das `AssemblyResolving`-Ereignis. Kein Neustart nötig.

## Die iOS-Falle, die Sie kennen müssen

Es gibt ein bekanntes Problem, das Sie sich an die Pinnwand heften sollten. Laut den [Release Notes von MAUI Preview 4](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/dotnetmaui.md) funktioniert `dotnet watch` für iOS-Projekte nicht, solange `MtouchLink` nicht deaktiviert ist. Tragen Sie Folgendes in die iOS-`PropertyGroup` Ihrer `.csproj` ein:

```xml
<PropertyGroup Condition="$(TargetFramework.Contains('-ios'))">
  <MtouchLink>None</MtouchLink>
</PropertyGroup>
```

Das deaktiviert den verwalteten Linker für iOS-Debug-Builds, was für die innere Entwicklungsschleife in Ordnung ist, in der Release-Konfiguration aber nicht erwünscht. Beschränken Sie die Bedingung auf den iOS-TFM und Debug, oder verschieben Sie sie in eine `Debug|iPhoneSimulator`-Bedingung, wenn Sie separate Plattformkonfigurationen haben.

Die anderen Korrekturen, die Preview 4 für den iOS-Pfad gebracht hat, sind erwähnenswert: Konflikte bei der Konsoleneingabe mit dem Simulator sind behoben, die WebSocket-Exception, die die Hot-Reload-Sitzung früher beendete, ist weg, und der Deadlock, der die App bei schnellen Bearbeitungen einfror, wurde beseitigt. Das sind die Bugs, die frühere Previews auf iOS unbenutzbar machten, selbst wenn watch technisch startete.

## Warum das wichtiger ist, als es klingt

Die Feedback-Schleife von MAUI ist der am häufigsten genannte Grund, warum Xamarin-Veteranen und Flutter-nahe Entwickler ferngeblieben sind. Ein 30 Sekunden langer Rebuild nach jeder C#-Bearbeitung zerstört explorative UI-Arbeit. `dotnet watch` für Desktop-Targets (Windows, Mac Catalyst) gibt es schon länger, aber Mobile entscheidet über Wohl und Wehe von MAUI. Preview 4 bringt die innere Schleife von MAUI Mobile endlich in dieselbe Liga wie das Hot Reload von `flutter run`.

Wenn Sie .NET 11 Previews bereits in einem Seitenbranch verfolgen, ist das die Version, die Sie tatsächlich in einem echten Projekt einsetzen sollten. Wenn Sie gewartet haben, [laden Sie Preview 4 herunter](https://dotnet.microsoft.com/download/dotnet/11.0) und aktualisieren Sie Ihre iOS-`.csproj`, bevor Sie zum ersten Mal `dotnet watch` ausführen.

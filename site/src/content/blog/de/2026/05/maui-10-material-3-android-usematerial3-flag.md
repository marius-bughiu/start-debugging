---
title: ".NET MAUI 10 SR6 schließt Material 3 auf Android hinter einem einzigen UseMaterial3-Flag ab"
description: "MAUI 10 SR6 (10.0.60) erweitert das Material-3-Theming auf Button, Entry, SearchBar, DatePicker, Slider, ProgressBar, ImageButton, Switch und Shell auf Android. Aktivieren Sie es mit einer MSBuild-Eigenschaft. Keine eigenen Renderer, keine styles.xml-Eingriffe."
pubDate: 2026-05-27
tags:
  - "dotnet"
  - "maui"
  - "android"
  - "material-3"
  - "dotnet-10"
lang: "de"
translationOf: "2026/05/maui-10-material-3-android-usematerial3-flag"
translatedBy: "claude"
translationDate: 2026-05-27
---

Microsoft hat den [letzten großen Brocken der Material-3-Unterstützung für .NET MAUI auf Android](https://devblogs.microsoft.com/dotnet/dotnet-maui-material-3/) im Release .NET MAUI 10 SR6 (10.0.60) ausgeliefert, angekündigt am 26. Mai 2026. Interessant ist nicht, dass Material 3 da ist. Interessant ist, dass das Opt-in genau eine MSBuild-Eigenschaft ist und dass das Team Handler-Anpassungen vollständig draußen gelassen hat.

Wenn Sie die Mobile-Geschichte von .NET 11 verfolgen: MAUI selbst [wechselt in .NET 11 Preview 4 auf Android und iOS standardmäßig zu CoreCLR](/de/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/). Material 3 ist hingegen ein Feature von .NET MAUI 10 und wird heute über die unterstützte Service-Release-Kadenz ausgeliefert.

## Wie der Rollout aufgeteilt wurde

Material 3 kam nicht auf einen Schlag. Das Feature wurde über drei Service Releases von .NET MAUI 10 ausgerollt:

- **SR3 (10.0.30)**: Material-3-Basisstile für eine Handvoll Controls.
- **SR4 (10.0.40)**: `CheckBox` erhielt das neue Theming.
- **SR6 (10.0.60)**: der große Schwung. `Button`, `Entry`, `SearchBar`, `DatePicker`, `Slider`, `ProgressBar`, `ImageButton`, `Switch` und vollständiges `Shell`-Theming.

Das vollständige unterstützte Set in SR6 umfasst `Entry`, `Editor`, `SearchBar`, `RadioButton`, `ProgressBar`, `Slider`, `Picker`, `TimePicker`, `DatePicker`, `CheckBox`, `Switch`, `ImageButton`, `Button`, `Label`, `ActivityIndicator`, `Image` und `Shell`.

## Das Opt-in ist eine einzige Eigenschaft

Das gesamte Opt-in besteht aus einer einzigen Eigenschaft in Ihrem `.csproj`:

```xml
<PropertyGroup>
  <UseMaterial3>true</UseMaterial3>
</PropertyGroup>
```

Das ist die gesamte Oberfläche. Kompilieren Sie neu, stellen Sie auf einem Android-Gerät oder Emulator bereit, und die unterstützten Controls übernehmen das Material-3-Styling automatisch. Keine Handler-Anpassung, keine eigenen Renderer, keine Operation an `Resources/values/styles.xml`, keine Änderungen in `MainActivity`.

Wenn Sie das Flag nur auf Android beschränken möchten, verwenden Sie die übliche MSBuild-Bedingung:

```xml
<PropertyGroup Condition="$(TargetFramework.Contains('-android'))">
  <UseMaterial3>true</UseMaterial3>
</PropertyGroup>
```

## Explizite Styles gewinnen weiterhin

Das Team hat die Vorrangregel so belassen, wie man es sich wünscht. Was Sie explizit in XAML oder C# setzen, überschreibt die Material-3-Defaults:

```xml
<Button Text="Save"
        BackgroundColor="#0F62FE"
        TextColor="White" />
```

Dieser Button behält sein IBM-Blau. Material 3 füllt nur dort, wo Sie nicht bereits gemalt haben. Eigene Handler und Renderer bleiben unangetastet, was wichtig ist, wenn Sie bereits ein Design-System haben, das bestimmte Controls überschreibt; das Flag wird die bewusst angepassten Stellen nicht stillschweigend umstylen.

## Warum das wichtig ist

Die visuelle Lücke auf Android ist eine der ältesten Beschwerden über MAUI. Out-of-the-box-Controls wirkten angestaubt, Korrekturen erforderten den Sprung in Android-Theme-XML, und jeder Workaround pro Control driftete leicht von dem ab, was Google im nächsten Material-Release auslieferte. Ein einziges MSBuild-Flag, das Material 3 über die SR-Releases hinweg verfolgt, ist eine spürbare Reduktion der Wartungsoberfläche für jedes Team, das noch kein eigenes Design-System fest verankert hat.

Der pragmatische Schritt für eine bestehende MAUI-10-App: auf 10.0.60 aktualisieren, `UseMaterial3` auf `true` setzen, die App in einem Android-Emulator starten und jeden Bildschirm durchgehen. Überall, wo Sie zuvor manuell gestylt haben, um die alten Defaults auszugleichen, ist nun ein Kandidat zum Löschen.

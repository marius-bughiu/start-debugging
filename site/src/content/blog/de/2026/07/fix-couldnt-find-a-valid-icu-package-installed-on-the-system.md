---
title: "Lösung: Couldn't find a valid ICU package installed on the system in einem .NET-Container"
description: "Ihr Base-Image enthält kein ICU. Installieren Sie icu-libs und icu-data-full, wechseln Sie auf eine -extra-Image-Variante, oder setzen Sie InvariantGlobalization=true und akzeptieren Sie ordinales Stringverhalten."
pubDate: 2026-07-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "docker"
  - "containers"
  - "globalization"
  - "alpine"
lang: "de"
translationOf: "2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system"
translatedBy: "claude"
translationDate: 2026-07-29
---

Das Base-Image Ihres Containers liefert kein ICU aus, und .NET verweigert ohne ICU den Start. Wählen Sie eine von zwei Antworten. Wenn Ihre Anwendung Datumsangaben formatiert, Strings linguistisch vergleicht oder irgendeine Kultur außer der invarianten anfasst, installieren Sie ICU: `RUN apk add --no-cache icu-libs icu-data-full` unter Alpine, oder wechseln Sie auf eine `-extra`-Image-Variante, die es bereits mitbringt. Wenn Ihre Anwendung wirklich nie Kulturdaten braucht, setzen Sie `<InvariantGlobalization>true</InvariantGlobalization>` in der Projektdatei und behalten das kleine Image. Setzen Sie nicht nur die Umgebungsvariable und hoffen, denn sie ist der schwächste der drei Schalter.

```text
Process terminated. Couldn't find a valid ICU package installed on the system.
Please install libicu (or icu-libs) using your package manager and try again.
Alternatively you can set the configuration flag System.Globalization.Invariant
to true if you want to run with no globalization support. Please see
https://aka.ms/dotnet-missing-libicu for more information.
```

Alles Folgende ist gegen .NET 10 (`10.0`, veröffentlicht am 2025-11-11) und die .NET 11 Previews verifiziert. Der Mechanismus ist seit .NET 5 identisch, dieselben Lösungen gelten also unverändert für `net8.0`- und `net9.0`-Images. Nur Paketnamen und Image-Tags ändern sich.

## Warum die Laufzeit den Prozess beendet, statt sich zu degradieren

Der Globalisierungs-Stack von .NET unter Unix ist eine dünne Schicht über ICU (International Components for Unicode). Kulturdaten, linguistischer Stringvergleich, Groß- und Kleinschreibung jenseits von ASCII, Kalenderformatierung, IDN-Behandlung: all das kommt aus `libicuuc` und `libicui18n`, die nicht Teil von .NET sind. Sie sind eine native Abhängigkeit, die Ihr Base-Image bereitstellen soll.

Beim Start durchläuft der statische Konstruktor von `GlobalizationMode` eine feste Entscheidungsliste:

1. Ist der globalisierungsinvariante Modus aktiv? Wenn ja, wird ICU komplett übersprungen und die eingebauten invarianten Daten werden verwendet.
2. Ist app-lokales ICU konfiguriert? Wenn ja, werden `libicuuc.so.<version>` und `libicui18n.so.<version>` aus dem Anwendungsverzeichnis geladen.
3. Ist `DOTNET_ICU_VERSION_OVERRIDE` gesetzt? Wenn ja, wird genau diese Version versucht.
4. Andernfalls wird die höchste im System installierte ICU-Version geladen.

Findet Schritt 4 nichts, ruft die Laufzeit `Environment.FailFast` auf. Das ist das Detail, über das viele stolpern: Dies ist keine Exception. Kein `try`/`catch` rettet Sie, kein `AppDomain.UnhandledException`-Hook, kein eleganter Rückfall auf den invarianten Modus. Der Prozess bricht ab, bevor `Main` nennenswert läuft, was unter Linux als SIGABRT und Container-Exitcode 134 sichtbar wird. Das ist Absicht: Ein stiller Rückfall auf ordinalen Stringvergleich würde Sortierung, Groß- und Kleinschreibung und Datumsanalyse so verändern, dass falsche Daten statt eines lauten Fehlers entstehen.

Die Images, die das am ehesten trifft, sind genau die, die Sie wegen ihrer geringen Größe gewählt haben. Alpine, Azure Linux distroless und Ubuntu chiseled lassen ICU und tzdata weg, und die .NET-Container-Dokumentation sagt ausdrücklich, dass diese Images nur mit Anwendungen im globalisierungsinvarianten Modus funktionieren. Die vollständigen Debian- und Ubuntu-Images enthalten ICU bereits, weshalb die Anwendung auf Ihrer Maschine und im `sdk`-Image lief und in dem Moment starb, in dem sie in der Laufzeit-Stage landete.

## Die minimale Reproduktion

Zwei Stages, ein normaler SDK-Build, eine Alpine-Laufzeit. Diese Dockerfile genügt:

```dockerfile
# .NET 10. Fails at startup with the ICU error.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

Die Anwendung selbst muss nichts Exotisches tun. Der Fehler tritt während der Laufzeitinitialisierung auf, bevor Ihr Code läuft, deshalb stürzt sogar das hier ab:

```csharp
// .NET 10, C# 14. Never reaches the WriteLine.
Console.WriteLine("hello");
```

Das lohnt sich zu verinnerlichen, denn der erste Reflex ist, nach dem `CultureInfo`-Aufruf zu suchen, der es ausgelöst hat. Es gibt keinen. Die Globalisierungsinitialisierung erfolgt eifrig.

## Lösung 1: ICU im Image installieren

Das ist für die meisten Anwendungen die richtige Lösung und die, die die .NET-Container-Beispiele dokumentieren. Unter Alpine:

```dockerfile
# .NET 10 on Alpine 3.22. Adds ICU and disables invariant mode.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine
RUN apk add --no-cache icu-libs icu-data-full
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false \
    LC_ALL=en_US.UTF-8 \
    LANG=en_US.UTF-8
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

`icu-data-full` ist kein optionaler Ballast. Seit Alpine 3.16 wurde das ICU-Datenpaket aufgeteilt, und `icu-libs` allein liefert nur das Gebietsschema `en`. Das erzeugt einen deutlich verwirrenderen Fehler als den, mit dem Sie angefangen haben: Die Laufzeit startet sauber, und danach formatiert jede nicht englische Kultur still wie Englisch. Tests, die auf `fr-FR`-Datumsformate prüfen, schlagen ohne jede Fehlermeldung fehl. Installieren Sie beide Pakete.

Die Zeile `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false` ist nur relevant, wenn etwas weiter oben den Wert auf `true` gesetzt hat, was mehrere Base-Images und CI-Vorlagen tun. Sie explizit zu setzen kostet nichts und beseitigt eine ganze Klasse von Fehlern durch geerbte Umgebungen.

Das Äquivalent für Debian- oder Ubuntu-basierte Images, das Sie nur für ein selbst zusammengestelltes `runtime-deps`-Image brauchen:

```dockerfile
# .NET 10 on Ubuntu 24.04 (noble).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libicu74 tzdata \
    && rm -rf /var/lib/apt/lists/*
```

Pinnen Sie den `libicu`-Paketnamen auf den, den Ihr Distributions-Release tatsächlich führt (`libicu74` unter Ubuntu 24.04, `libicu72` unter Debian bookworm). Wenn Sie das nicht nachhalten möchten, zieht `apt-get install -y libicu-dev` die richtige Laufzeitbibliothek transitiv nach, zum Preis einer größeren Schicht.

## Lösung 2: auf eine `-extra`-Image-Variante wechseln

Microsoft veröffentlicht größenoptimierte Images in drei Ausprägungen, und das Suffix `-extra` bedeutet genau "das kleine Image, plus ICU, tzdata und `libstdc++`". Unter chiseled oder Azure Linux ist das eine Zeile statt einer Paketinstallation:

```dockerfile
# .NET 10, Ubuntu chiseled with globalization support.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled-extra
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

Es gibt eine Asymmetrie bei der Verfügbarkeit, die Sie kennen sollten, bevor Sie darauf planen. Für Ubuntu chiseled und Azure Linux existiert `-extra` in den Repositories `runtime-deps`, `runtime` und `aspnet`. Für Alpine wird `-extra` nur in `runtime-deps` veröffentlicht, das heißt, Sie können es nur mit einem eigenständigen (self-contained) oder Native-AOT-Publish nutzen. Eine framework-abhängige Alpine-Anwendung muss die Pakete wie in Lösung 1 von Hand installieren.

Wenn Sie Images mit der eingebauten Containerunterstützung des SDK statt mit einer Dockerfile bauen, wählen Sie die Variante über `ContainerFamily` statt über eine `FROM`-Zeile:

```xml
<!-- .NET 10 SDK. Applies to dotnet publish /t:PublishContainer. -->
<PropertyGroup>
  <ContainerFamily>noble-chiseled-extra</ContainerFamily>
</PropertyGroup>
```

Das greift in denselben Ablauf, der in [Veröffentlichen einer .NET-Anwendung als Container-Image mit PublishContainer](/de/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) beschrieben ist, und hält die Wahl des Base-Image in der Projektdatei, wo auch der Rest Ihrer Publish-Konfiguration liegt.

## Lösung 3: invariante Globalisierung bewusst aktivieren

Wenn die Anwendung tatsächlich kulturfrei ist (eine interne API, die ISO-8601-Zeitstempel und invariant formatierte Zahlen austauscht, ist der klassische Fall), ist der invariante Modus kein Workaround, sondern die korrekte Konfiguration. Er entfernt die Abhängigkeit vollständig und bringt ein kleineres Image und einen schnelleren Start.

```xml
<!-- .NET 10, C# 14. -->
<PropertyGroup>
  <InvariantGlobalization>true</InvariantGlobalization>
</PropertyGroup>
```

Setzen Sie es in der Projektdatei, nicht in der Dockerfile. Laut dem Designdokument der Laufzeit zum globalisierungsinvarianten Modus haben die Werte aus Projektdatei und `runtimeconfig.json` Vorrang vor `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT`. Die MSBuild-Eigenschaft gewinnt also immer, und die Umgebungsvariable verliert still. Die Projektdatei reist außerdem mit der Anwendung: Niemand kann Ihren Container in einen anderen Orchestrator schieben, den Umgebungsblock vergessen und den Fehler wiederbeleben.

Machen Sie sich klar, worauf Sie sich einlassen. Im invarianten Modus gilt:

- `ToUpper` und `ToLower` wandeln nur den ASCII-Bereich um. Die türkische Groß- und Kleinschreibung mit und ohne Punkt auf dem I entfällt.
- `String.Compare`, `IndexOf` und `LastIndexOf` vergleichen ordinal, unabhängig von den übergebenen `CompareOptions` oder `StringComparison`. Linguistische Sortierung wird still zu Byte-Sortierung.
- `String.Normalize` gibt den String unverändert zurück.
- Anzeigenamen von Zeitzonen unter Linux fallen auf den Standardnamen zurück statt auf den lokalisierten ICU-Namen.
- `TimeZoneInfo.TryConvertIanaIdToWindowsId` und die Umkehrung schlagen fehl, weil sie auf ICU beruhen.
- Die Kulturaufzählung gibt genau eine Kultur zurück, und alle LCIDs kollabieren auf `0x1000`.

Am schmerzhaftesten ist in der Praxis die Kulturerzeugung. Seit .NET 6 ist `PredefinedCulturesOnly` im invarianten Modus standardmäßig `true`, sodass `new CultureInfo("fr-FR")` wirft:

```text
System.Globalization.CultureNotFoundException: Only the invariant culture is supported
in globalization-invariant mode.
```

Wenn die Erzeugung gelingen muss (eine Request-Localization-Middleware, die `Accept-Language` auswertet, tut das auch dann, wenn Sie das Ergebnis nie verwenden), können Sie die Regel lockern:

```xml
<!-- .NET 10. Cultures can be created, but all behave as invariant. -->
<PropertyGroup>
  <InvariantGlobalization>true</InvariantGlobalization>
  <PredefinedCulturesOnly>false</PredefinedCulturesOnly>
</PropertyGroup>
```

Das stoppt die Exception. Es stellt kulturspezifisches Verhalten nicht wieder her: Jede erzeugte Kultur verhält sich exakt wie die invariante. `1234.56m.ToString("C", new CultureInfo("de-DE"))` liefert weiterhin die invariante Währungsform mit dem generischen Währungszeichen, keinen deutsch formatierten Eurobetrag. Dieses Paar als "die Lösung" für eine wirklich lokalisierte Anwendung zu behandeln, führt zu einer Anwendung, deren Ausgabe überall außer in en-US falsch ist.

## Lösung 4: eigenes ICU mitliefern (app-lokales ICU)

Die Nischenoption, die trotzdem legitim ist: eine exakte ICU-Version festnageln und mit der Anwendung ausliefern, damit das Verhalten auf jedem Zielhost byte-identisch ist. ICU-Versionssprünge ändern CLDR-Daten, und CLDR-Daten ändern Sortierreihenfolge und Formatierung. Eine Anwendung mit Golden-File-Tests auf formatierter Ausgabe kann also durch ein Base-Image-Update destabilisiert werden, um das sie nie gebeten hat.

```xml
<!-- .NET 10. Ships ICU 72.1 with the app instead of using the system copy. -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="System.Globalization.AppLocalIcu" Value="72.1" />
  <PackageReference Include="Microsoft.ICU.ICU4C.Runtime" Version="72.1.0.3" />
</ItemGroup>
```

Mit gesetztem Schalter lädt .NET `libicuuc.so.72.1` und `libicui18n.so.72.1` aus den nativen Suchpfaden der Anwendung und schaut nie auf die Systemkopie. Die zugehörige Umgebungsvariable heißt `DOTNET_SYSTEM_GLOBALIZATION_APPLOCALICU`, und das Wertformat ist `<version>` oder `<suffix>:<version>`, wobei das Suffix zu einem eigenen ICU-Build passt. Fehlen die Bibliotheken, erhalten Sie einen anderen, spezifischeren Fehler: `Failed to load app-local ICU: <library name>`. Stimmen Sie die Version im `PackageReference` auf den Schalterwert ab, sonst sehen Sie genau das.

## Fallstricke, die zur falschen Lösung führen

**`ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false` in der Dockerfile hat nichts bewirkt.** Prüfen Sie die Projektdatei. Wenn dort oder in `runtimeconfig.json` `<InvariantGlobalization>true</InvariantGlobalization>` steht, hat das Vorrang und Ihre Umgebungsvariable bleibt wirkungslos. Durchsuchen Sie die gesamte Solution, auch `Directory.Build.props`, wo eine gut gemeinte Größenoptimierung gern wohnt.

**`Failed to load system ICU: libicuuc.so.<n>` statt der obigen Meldung.** Das ist ein anderer Zweig. Er bedeutet, dass ICU über die Versionssuche gefunden wurde, der konkrete SONAME sich aber nicht laden ließ, meist wegen einer unvollständigen Installation oder einer Architekturabweichung (eine `amd64`-Schicht unter `arm64`-Emulation). Prüfen Sie es mit `ldconfig -p | grep icu` im Container.

**Der Fehler tritt nur bei Native AOT oder getrimmten Publishes auf.** Dann liegt es wahrscheinlich gar nicht am Image. `PublishAot` und `PublishTrimmed` interagieren mit Feature-Switches, und `InvariantGlobalization` ist einer der Schalter, die in AOT-Vorlagen häufig aus Größengründen aktiviert werden. Dieselbe Klasse von "das SDK hat hinter Ihrem Rücken einen Schalter umgelegt" behandelt [warum reflektionsbasierte Serialisierung deaktiviert wird](/de/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/) sowie die breitere Darstellung zu [trim-sicherem Code](/de/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/).

**Datumsangaben werden korrekt formatiert, Zeitzonen lassen sich aber nicht auflösen.** ICU und tzdata sind getrennte Pakete. `TimeZoneInfo.FindSystemTimeZoneById` liest `/usr/share/zoneinfo`, das die größenoptimierten Images ebenfalls weglassen. Installieren Sie `tzdata` zusammen mit `icu-libs`, oder verwenden Sie die `-extra`-Variante, die beides enthält.

**Alles funktioniert außer den kulturspezifischen Tests.** Sie haben unter Alpine `icu-libs` ohne `icu-data-full` installiert. Es liegen nur die `en`-Daten vor.

**Das SDK-Image funktioniert, das Laufzeit-Image nicht.** Das ist erwartbar. Die `sdk`-Images sind standardmäßig Debian-basiert und bringen ICU mit; Ihre finale `aspnet`- oder `runtime`-Stage ist die, der die Abhängigkeit fehlt. Diagnostizieren Sie in der tatsächlichen Laufzeitschicht, nicht in der Build-Schicht.

Um ohne Raten zu bestätigen, in welchem Modus Sie gelandet sind:

```csharp
// .NET 10, C# 14. Prints 1 in invariant mode, several hundred with ICU loaded.
using System.Globalization;

Console.WriteLine(CultureInfo.GetCultures(CultureTypes.AllCultures).Length);
Console.WriteLine(AppContext.TryGetSwitch("System.Globalization.Invariant", out bool inv) && inv);
```

## Verwandte Beiträge

- [Wie Sie eine .NET 11-Anwendung mit dotnet publish /t:PublishContainer als Container-Image veröffentlichen](/de/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)
- [Was ist Native AOT und was kostet es Sie?](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Fix: PlatformNotSupportedException: Operation is not supported on this platform unter Native AOT](/de/2026/05/fix-platformnotsupportedexception-in-native-aot/)
- [Was ist trim-sicherer Code und wie schreibe ich ihn?](/de/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)
- [Wie man die Kaltstartzeit eines .NET 11 AWS Lambda reduziert](/de/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)

## Quellen

- [.NET globalization invariant mode](https://github.com/dotnet/runtime/blob/main/docs/design/features/globalization-invariant-mode.md), für die Verhaltensliste und die Vorrangregel der Einstellungen - dotnet/runtime
- [`GlobalizationMode.Unix.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Globalization/GlobalizationMode.Unix.cs), für die Ladereihenfolge und das `FailFast` bei fehlendem ICU - dotnet/runtime
- [Globalisierungs-Konfigurationseinstellungen](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/globalization) - MS Learn
- [.NET-Globalisierung und ICU](https://learn.microsoft.com/en-us/dotnet/core/extensions/globalization-icu), für app-lokales ICU und die Suchreihenfolge unter Linux - MS Learn
- [Globalisierung in .NET-Container-Images aktivieren](https://github.com/dotnet/dotnet-docker/blob/main/samples/enable-globalization.md) - dotnet/dotnet-docker
- [.NET Image-Varianten](https://github.com/dotnet/dotnet-docker/blob/main/documentation/image-variants.md), dazu welche Repositories `-extra` veröffentlichen - dotnet/dotnet-docker
- [.NET Container-Images](https://learn.microsoft.com/en-us/dotnet/core/docker/container-images) - MS Learn
- [.NET unter Alpine installieren](https://learn.microsoft.com/en-us/dotnet/core/install/linux-alpine), für die Abhängigkeitsliste inklusive `icu-data-full` - MS Learn
- [Alpine 3.16 icu-libs enthält jetzt nur noch en](https://github.com/dotnet/dotnet-docker/issues/3844) - dotnet/dotnet-docker
- [Kulturerzeugung und Groß-/Kleinschreibung im globalisierungsinvarianten Modus](https://learn.microsoft.com/en-us/dotnet/core/compatibility/globalization/6.0/culture-creation-invariant-mode) - MS Learn

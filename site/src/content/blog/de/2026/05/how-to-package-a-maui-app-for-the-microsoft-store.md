---
title: "So paketieren Sie eine .NET MAUI App für den Microsoft Store"
description: "Vollständige Anleitung zum Paketieren einer .NET MAUI 11 Windows App als MSIX, zum Bündeln von x64/x86/ARM64 in einem .msixupload und zur Übermittlung über das Partner Center: Identitätsreservierung, Package.appxmanifest, dotnet publish Flags, MakeAppx Bundling und die Store-vertrauenswürdige Zertifikatsübergabe."
pubDate: 2026-05-04
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "windows"
  - "msix"
  - "microsoft-store"
  - "partner-center"
  - "how-to"
lang: "de"
translationOf: "2026/05/how-to-package-a-maui-app-for-the-microsoft-store"
translatedBy: "claude"
translationDate: 2026-05-04
---

Kurze Antwort: Reservieren Sie zuerst den App-Namen im Partner Center, kopieren Sie die generierten Identity-Werte in `Platforms/Windows/Package.appxmanifest`, setzen Sie `WindowsPackageType=MSIX` und `AppxPackageSigningEnabled=true` in Ihrer `.csproj`, dann führen Sie `dotnet publish -f net10.0-windows10.0.19041.0 -c Release -p:RuntimeIdentifierOverride=win-x64` einmal pro Architektur aus, die Sie ausliefern möchten. Kombinieren Sie die resultierenden `.msix`-Dateien mit `MakeAppx.exe bundle` zu einem einzelnen `.msixbundle`, verpacken Sie dieses in ein `.msixupload` (ein einfaches Zip mit dem Bundle und seinem Symbol-Bundle), und laden Sie es als Paket einer Partner-Center-Übermittlung hoch. Der Store signiert Ihr Bundle mit seinem eigenen Zertifikat neu, daher muss dem lokalen `PackageCertificateThumbprint` nur auf Ihrem Build-Rechner vertraut werden.

Diese Anleitung durchläuft die vollständige Pipeline für .NET MAUI 11.0.0 auf .NET 11, Windows App SDK 1.7 und den Partner-Center-Übermittlungsfluss, wie er im Mai 2026 ist. Alles unten wurde gegen `dotnet new maui` aus dem .NET 11.0.100 SDK validiert, mit `Microsoft.WindowsAppSDK` 1.7.250401001 und `Microsoft.Maui.Controls` 11.0.0. Unterschiede zu früheren .NET 8 und .NET 9 Hinweisen werden dort genannt, wo das Rezept abweicht.

## Warum "einfach Veröffentlichen klicken" aufgehört hat zu funktionieren

Der MAUI-Veröffentlichungsassistent von Visual Studio liefert ein "Microsoft Store"-Ziel, hat aber seit .NET 6 in keinem MAUI-Release ein Store-akzeptables `.msixupload` produziert. Der Assistent generiert ein einzelnes `.msix` für eine einzelne Architektur und hört dort auf, was bedeutet, dass Uploads entweder die Partner-Center-Validierung direkt nicht bestehen (wenn Ihre vorherige Übermittlung gebündelt war) oder Sie still und leise für die Lebensdauer der Listung in eine einzige Architektur einsperren. Das MAUI-Team verfolgt diese Lücke seit 2024 als [dotnet/maui#22445](https://github.com/dotnet/maui/issues/22445), und der Fix ist in MAUI 11 nicht enthalten. Die CLI ist der unterstützte Weg.

Der zweite Grund, warum der Assistent in die Irre führt, ist die Identität. Das `.msix`, das er produziert, ist mit dem lokalen Zertifikat signiert, auf das Sie ihn verwiesen haben, aber eine Store-Übermittlung erfordert, dass das `Identity`-Element Ihrer App (`Name`, `Publisher` und `Version`) exakt mit den Werten übereinstimmt, die das Partner Center für Sie reserviert hat. Wenn das Manifest `CN=DevCert` sagt und das Partner Center `CN=4D2D9D08-...` erwartet, schlägt der Upload mit einem generischen Fehlercode im Stil von 12345 fehl, der das schuldige Feld nicht nennt. Den Namen zuerst zu reservieren und die Partner-Center-Werte vor dem Build in das Manifest einzufügen ist der einzige Weg, diese Schleife zu vermeiden.

Die gute Nachricht: Sobald Sie das richtige Manifest haben, sind die CLI-Befehle stabil über .NET 8, 9, 10 und 11. Nur die Form des Runtime Identifiers hat sich geändert: `win10-x64` wurde in .NET 10 zugunsten des portablen `win-x64` zurückgezogen, gemäß [NETSDK1083](https://learn.microsoft.com/en-us/dotnet/core/tools/sdk-errors/netsdk1083). Alles andere ist derselbe `MSBuild`-Aufruf, den Xamarin 2020 ausgeliefert hat.

## Schritt 1: Namen reservieren und Identitätswerte abholen

Melden Sie sich beim [Partner Center](https://partner.microsoft.com/dashboard/apps-and-games/overview) an und erstellen Sie eine neue App. Reservieren Sie den Namen. Öffnen Sie **Produktidentität** (oder **App-Verwaltung > App-Identität**, abhängig von der Dashboard-Version, die Sie sehen); Sie benötigen drei Strings:

- **Package/Identity Name**, zum Beispiel `12345Contoso.MyMauiApp`.
- **Package/Identity Publisher**, der lange `CN=...`-String, den Microsoft Ihnen zuweist, zum Beispiel `CN=4D2D9D08-7BAC-4F2C-9D32-2A2F3C9F0E4A`.
- **Package/Publisher display name**, die menschenlesbare Version, die in der Store-Listung erscheint.

Diese drei Werte müssen wortwörtlich in `Platforms/Windows/Package.appxmanifest` landen. Das MAUI-Template liefert ein Platzhalter-Manifest mit `Name="maui-package-name-placeholder"`, das das Buildsystem normalerweise aus Ihrer `.csproj` neu schreibt. Für Store-Builds überschreiben Sie es explizit, damit das `Identity`-Element den Build überlebt.

```xml
<!-- Platforms/Windows/Package.appxmanifest, .NET MAUI 11 -->
<Identity
    Name="12345Contoso.MyMauiApp"
    Publisher="CN=4D2D9D08-7BAC-4F2C-9D32-2A2F3C9F0E4A"
    Version="1.0.0.0" />

<Properties>
  <DisplayName>My MAUI App</DisplayName>
  <PublisherDisplayName>Contoso</PublisherDisplayName>
  <Logo>Images\StoreLogo.png</Logo>
</Properties>
```

Das `Version` hier verwendet das vierteilige Win32-Schema (`Major.Minor.Build.Revision`), und das Partner Center behandelt das vierte Segment als reserviert: Es muss für jede Store-Übermittlung `0` sein. Wenn Sie CI-Buildnummern in die Version codieren, setzen Sie sie in das dritte Segment.

Während Sie im Manifest sind, setzen Sie `<TargetDeviceFamily>` auf `Windows.Desktop` mit einem `MinVersion` von `10.0.17763.0` (die Untergrenze für Windows App SDK 1.7) und einem `MaxVersionTested`, das mit dem übereinstimmt, was Sie tatsächlich getestet haben. `MaxVersionTested` zu hoch zu setzen führt dazu, dass das Partner Center die Übermittlung für zusätzliche Zertifizierung markiert; zu niedrig führt dazu, dass Windows die Installation auf neueren OS-Versionen verweigert.

## Schritt 2: Projekt für MSIX-Builds einrichten

Die `.csproj`-Eigenschaften unten ersetzen den gesamten Ratschlag "Projekt für MSIX konfigurieren" aus den Visual Studio-Dokumenten. Fügen Sie diesen Block einmal hinzu und vergessen Sie ihn dann.

```xml
<!-- MyMauiApp.csproj, .NET MAUI 11.0.0 on .NET 11 -->
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'windows' and '$(Configuration)' == 'Release'">
  <WindowsPackageType>MSIX</WindowsPackageType>
  <AppxPackage>true</AppxPackage>
  <AppxPackageSigningEnabled>true</AppxPackageSigningEnabled>
  <GenerateAppxPackageOnBuild>true</GenerateAppxPackageOnBuild>
  <AppxAutoIncrementPackageRevision>False</AppxAutoIncrementPackageRevision>
  <AppxSymbolPackageEnabled>true</AppxSymbolPackageEnabled>
  <AppxBundle>Never</AppxBundle>
  <PackageCertificateThumbprint>AA11BB22CC33DD44EE55FF66AA77BB88CC99DD00</PackageCertificateThumbprint>
</PropertyGroup>

<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'windows' and '$(RuntimeIdentifierOverride)' != ''">
  <RuntimeIdentifier>$(RuntimeIdentifierOverride)</RuntimeIdentifier>
</PropertyGroup>
```

Zwei dieser Eigenschaften sind nicht offensichtlich.

`AppxBundle=Never` sieht falsch aus, weil der Store ein Bundle möchte, aber der .NET MAUI-Build kann nur ein einzelnes `.msix` für eine einzelne Architektur pro `dotnet publish`-Aufruf produzieren. `AppxBundle=Always` hier zu setzen führt dazu, dass der Build versucht, UWP-Stil-Bundle-Generierung gegen ein Nicht-UWP-Projekt durchzuführen und den kryptischen Fehler `The target '_GenerateAppxPackage' does not exist in the project` ausgibt, der in [dotnet/maui#17680](https://github.com/dotnet/maui/issues/17680) verfolgt wird. Sie kompilieren pro Architektur und bündeln sie im nächsten Schritt selbst.

`AppxSymbolPackageEnabled=true` produziert ein `.appxsym` neben jedem `.msix`. Das `.msixupload`, das Sie übermitteln, ist ein Zip, dessen Inhalt das Bundle plus ein Geschwister-Symbol-Bundle ist, und das Partner Center entfernt stillschweigend die Absturzanalyse, wenn eine der beiden Seiten fehlt. Es warnt Sie nicht; Sie bekommen einfach sechs Wochen später leere Stack Traces im Health-Dashboard.

Die zweite `<PropertyGroup>` ist ein Workaround für [WindowsAppSDK#3337](https://github.com/microsoft/WindowsAppSDK/issues/3337), der seit dem Umzug des Projekts zu GitHub offen ist und keine Anzeichen zeigt, geschlossen zu werden. Ohne ihn wählt `dotnet publish` den impliziten RID, bevor das MSIX-Target ihn liest, und das resultierende Paket zielt auf die Architektur des Build-Hosts statt auf die, die Sie auf der Befehlszeile übergeben haben.

Der `PackageCertificateThumbprint` ist nur für Sideload-Installationen wichtig. Das Partner Center signiert Ihr Bundle mit dem Zertifikat neu, das Ihrem Publisher-Konto zugeordnet ist, sodass ein selbstsigniertes Zertifikat für Store-Übermittlungen ausreichend ist. Erzeugen Sie eines mit `New-SelfSignedCertificate -Type Custom -Subject "CN=Contoso" -KeyUsage DigitalSignature -CertStoreLocation "Cert:\CurrentUser\My" -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")`, kopieren Sie den Thumbprint in die Projektdatei, und vertrauen Sie dem Zertifikat im Speicher **Vertrauenswürdige Personen** auf allen Maschinen, auf denen Sie sideloaden, bevor die Store-Listung live geht.

## Schritt 3: Ein MSIX pro Architektur kompilieren

Der Store akzeptiert heute x64 und ARM64 sowie einen optionalen x86-Build für die lange Reihe älterer PCs. Führen Sie `dotnet publish` einmal pro Architektur aus, von einer **Developer Command Prompt for Visual Studio**, damit die Windows SDK-Tools im `PATH` sind.

```powershell
# .NET MAUI 11.0.0 on .NET 11, Windows App SDK 1.7
$tfm = "net10.0-windows10.0.19041.0"
$project = "src\MyMauiApp\MyMauiApp.csproj"

foreach ($rid in @("win-x64", "win-x86", "win-arm64")) {
    dotnet publish $project `
        -f $tfm `
        -c Release `
        -p:RuntimeIdentifierOverride=$rid
}
```

Nachdem alle drei Läufe beendet sind, landen die architekturspezifischen Pakete in:

```
src\MyMauiApp\bin\Release\net10.0-windows10.0.19041.0\win-x64\AppPackages\MyMauiApp_1.0.0.0_Test\MyMauiApp_1.0.0.0_x64.msix
src\MyMauiApp\bin\Release\net10.0-windows10.0.19041.0\win-x86\AppPackages\MyMauiApp_1.0.0.0_Test\MyMauiApp_1.0.0.0_x86.msix
src\MyMauiApp\bin\Release\net10.0-windows10.0.19041.0\win-arm64\AppPackages\MyMauiApp_1.0.0.0_Test\MyMauiApp_1.0.0.0_arm64.msix
```

Jeder Ordner enthält auch ein `.appxsym`-Symbol-Bundle. Kopieren Sie alle sechs Artefakte in einen flachen Staging-Ordner, sodass der Bundling-Schritt auf einem einzigen Verzeichnis arbeiten kann.

```powershell
$staging = "artifacts\msix"
New-Item -ItemType Directory -Force -Path $staging | Out-Null

Get-ChildItem -Recurse -Include *.msix, *.appxsym `
    -Path "src\MyMauiApp\bin\Release\$tfm" |
    Copy-Item -Destination $staging
```

Ihr `dotnet build`-Log meldet `package version 1.0.0.0` für jede Architektur. Sie müssen exakt übereinstimmen, sonst lehnt `MakeAppx.exe bundle` das Eingabeset mit `error 0x80080204: The package family is invalid` ab.

## Schritt 4: Architekturen in ein `.msixbundle` bündeln

`MakeAppx.exe` wird mit dem Windows 11 SDK unter `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makeappx.exe` ausgeliefert. Neuere SDK-Versionen werden nebeneinander installiert; wählen Sie die, die zu Ihrem `MaxVersionTested` passt.

```powershell
$makeappx = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makeappx.exe"
$version = "1.0.0.0"

& $makeappx bundle `
    /bv $version `
    /d $staging `
    /p "artifacts\MyMauiApp_${version}_x86_x64_arm64.msixbundle"
```

Der `/d`-Schalter weist `MakeAppx` an, jedes `.msix` im Ordner aufzunehmen und ein dickes Bundle zu erzeugen, dessen Architektur-Karte alle drei abdeckt. Der `/bv`-Wert (Bundle-Version) muss gleich der `Version` im `Package.appxmanifest` sein; Abweichungen führen dazu, dass das Partner Center die Übermittlung mit `package version mismatch` ablehnt.

Führen Sie einen zweiten Durchgang aus, um die Symboldateien zu bündeln:

```powershell
& $makeappx bundle `
    /bv $version `
    /d $staging `
    /p "artifacts\MyMauiApp_${version}_x86_x64_arm64.appxsymbundle"
```

`MakeAppx` leitet die Dateierweiterung aus dem Eingabeset ab und überspringt die `.msix`-Dateien beim Bündeln von Symbolen. Wenn Sie das Symbol-Bundle vergessen, ist der Upload trotzdem erfolgreich, aber Health Reports bleiben leer.

## Schritt 5: Als `.msixupload` verpacken

Ein `.msixupload` ist nur ein Zip mit einer bestimmten Erweiterung. Das Partner Center erkennt automatisch die Geschwister-Bundle- und Symbol-Bundle-Dateien darin.

```powershell
$upload = "artifacts\MyMauiApp_${version}_x86_x64_arm64.msixupload"

Compress-Archive `
    -Path "artifacts\MyMauiApp_${version}_x86_x64_arm64.msixbundle", `
          "artifacts\MyMauiApp_${version}_x86_x64_arm64.appxsymbundle" `
    -DestinationPath ($upload -replace '\.msixupload$', '.zip') -Force

Move-Item -Force ($upload -replace '\.msixupload$', '.zip') $upload
```

PowerShell 5.1 weigert sich, eine Erweiterung außer `.zip` direkt mit `Compress-Archive` zu schreiben, weshalb das Snippet zuerst ein `.zip` schreibt und umbenennt. PowerShell 7.4+ akzeptiert die Erweiterung direkt.

## Schritt 6: Über das Partner Center hochladen

Öffnen Sie Ihre reservierte App im Partner Center, klicken Sie auf **Übermittlung starten**, springen Sie zum Abschnitt **Pakete** und legen Sie das `.msixupload` ab. Das Partner Center validiert das Paket sofort und zeigt Probleme in drei Kategorien an:

- **Identitätskonflikt.** Der `Identity Name` oder `Publisher` in Ihrem Manifest stimmt nicht mit den Werten überein, die das Partner Center reserviert hat. Öffnen Sie die Seite **Produktidentität** des Dashboards parallel zu `Package.appxmanifest`, korrigieren Sie das Manifest, kompilieren Sie neu, bündeln Sie neu und laden Sie erneut hoch. Bearbeiten Sie das `.msixupload`-Zip nicht direkt; das Bundle ist signiert, und der Entpacken-Bearbeiten-Neupacken-Zyklus invalidiert die Signatur.
- **Capabilities.** Jede `<Capability>`, die Sie deklarieren, wird einer Store-Kategorie zugeordnet, die zusätzliche Zertifizierung erfordern kann. `runFullTrust` (das MAUI implizit setzt, weil Win32 Desktop Apps es benötigen) ist für normale Store-Konten genehmigt; `extendedExecutionUnconstrained` und ähnliche Capabilities erfordern zusätzliche Überprüfung.
- **Min-Version.** Wenn `MinVersion` in `<TargetDeviceFamily>` älter ist als die niedrigste Windows-Version, die der Store derzeit unterstützt (10.0.17763.0 ab Mai 2026), wird das Paket abgelehnt. Die Korrektur besteht darin, sie im Manifest anzuheben, nicht das SDK abzusenken.

Sobald die Validierung bestanden ist, füllen Sie die Listungs-Metadaten, Altersfreigabe und Preisgestaltung wie bei jeder anderen Store-App aus. Die erste Überprüfung wird typischerweise in 24-48 Stunden abgeschlossen; Updates für bestehende Apps werden meist in unter 12 Stunden freigegeben.

## Fünf Stolpersteine, die einen Nachmittag kosten

**1. Die erste Übermittlung entscheidet Bundle versus einzelnes MSIX für immer.** Wenn Sie jemals ein einzelnes `.msix` für eine Listung hochladen, muss jede zukünftige Übermittlung ebenfalls ein einzelnes `.msix` sein; Sie können eine bestehende Listung nicht zu einem Bundle befördern, und Sie können ein Bundle nicht zu einem einzelnen `.msix` herabstufen. Entscheiden Sie sich von Anfang an und bleiben Sie bei Bundles, auch wenn Sie heute nur eine Architektur ausliefern.

**2. `Package Family Name` im Partner Center ist nicht dasselbe wie `Identity Name`.** Der PFN ist `Identity.Name + "_" + erste 13 Zeichen des Publisher-Hashes`, und Windows leitet ihn automatisch ab. Wenn Sie den PFN in den `Identity.Name` des Manifests kopieren, schlägt der Upload mit dem irreführenden Fehler "package identity does not match" fehl, dokumentiert in [dotnet/maui#32801](https://github.com/dotnet/maui/issues/32801).

**3. Windows App SDK ist eine Framework-Abhängigkeit, kein Redistributable, das Sie ausliefern.** Der Store installiert das passende `Microsoft.WindowsAppRuntime.1.7`-Paket automatisch, solange Sie die framework-abhängige `WindowsAppSDK`-Referenz aus dem MAUI-Template verwenden. Wenn Sie auf self-contained umstellen, ist das resultierende MSIX 80MB größer und das Partner Center lehnt es ab, weil es das Größenbudget pro Architektur der kostenlosen Store-Stufe überschreitet.

**4. Projektnamen mit Unterstrichen brechen MakeAppx.** Eine `.csproj` mit dem Namen `My_App.csproj` produziert Pakete, deren Dateinamen Unterstriche an Positionen enthalten, an denen `MakeAppx bundle` sie als Versionstrenner interpretiert, was mit `error 0x80080204` fehlschlägt. Benennen Sie das Projekt um, um Bindestriche zu verwenden, oder fügen Sie `<AssemblyName>MyApp</AssemblyName>` hinzu, um den Ausgabenamen zu überschreiben. Dies wird in [dotnet/maui#26486](https://github.com/dotnet/maui/issues/26486) verfolgt.

**5. Das `Test`-Suffix ist real.** Der Ordner `AppPackages\MyMauiApp_1.0.0.0_Test` ist so benannt, weil `dotnet publish` standardmäßig Testzertifikate produziert. Das `.msix` im Ordner ist für den Store in Ordnung; nur der Ordnername ist irreführend. Kopieren Sie das `.msix`, ignorieren Sie das `_Test`-Verzeichnis und machen Sie weiter.

## Wo das in eine CI-Pipeline passt

Nichts in dieser Pipeline benötigt Visual Studio. Ein sauberer `windows-latest` GitHub Actions Runner mit dem .NET 11 SDK und installiertem MAUI-Workload produziert das gleiche `.msixupload` aus diesen Befehlen. Das einzige sensible Material ist der Thumbprint des Signaturzertifikats und das PFX, beide passen in Repository-Geheimnisse. Nach dem Upload erlaubt die [Microsoft Store Submission API](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services) Ihnen, dasselbe Artefakt direkt in eine Entwurfs-Übermittlung zu pushen, ohne das Dashboard zu berühren, was den Kreis eines vollautomatischen Releases schließt.

Wenn Sie mobile Target Frameworks aus demselben Projekt entfernen, damit der Windows-Build nicht auch Android- und iOS-Workloads mitzieht, deckt das [Windows-and-macOS-only MAUI 11 Setup](/de/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) die `<TargetFrameworks>`-Umschreibungen ab, die Sie benötigen, bevor einer der Publish-Befehle oben sauber läuft. Für die Manifest-Designer-Seite von `Package.appxmanifest` und das kleine Set von Theme-Einstellungen, die der Store liest, geht [Dark Mode korrekt in einer MAUI App unterstützen](/de/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) durch die Resource Keys, die im Screenshot-Generator der Listung erscheinen. Wenn Ihre Store-Listung eine Maps-Seite präsentiert, deckt der [MAUI 11 Map Pin Clustering Walkthrough](/2026/04/dotnet-maui-11-map-pin-clustering/) die `MapsKey`-Capability ab, die Sie im Manifest deklarieren müssen, bevor das Zertifizierungsteam die App genehmigt. Und für eine breitere Tour dessen, was im Framework neu ist, das in Ihrem Bundle ausgeliefert wird, ist [Was ist neu in .NET MAUI 10](/2025/04/whats-new-in-net-maui-10/) das Nächste an einer Release-Notes-Säule, was die Dokumentation hat.

## Quellenlinks

- [Use the CLI to publish packaged apps for Windows - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/windows/deployment/publish-cli?view=net-maui-10.0)
- [Publish a .NET MAUI app for Windows (overview)](https://learn.microsoft.com/en-us/dotnet/maui/windows/deployment/overview?view=net-maui-10.0)
- [App manifest schema reference](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/root-elements)
- [Create a certificate for package signing](https://learn.microsoft.com/en-us/windows/msix/package/create-certificate-package-signing)
- [MakeAppx.exe tool reference](https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool)
- [Microsoft Store Submission API](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services)
- [WindowsAppSDK Issue #3337 - RID workaround](https://github.com/microsoft/WindowsAppSDK/issues/3337)
- [dotnet/maui Issue #22445 - .msixupload missing](https://github.com/dotnet/maui/issues/22445)
- [dotnet/maui Issue #32801 - package identity mismatch](https://github.com/dotnet/maui/issues/32801)

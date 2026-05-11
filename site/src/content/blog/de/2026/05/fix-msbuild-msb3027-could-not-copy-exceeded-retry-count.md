---
title: "Fix: MSB3027 Could not copy X to Y. Exceeded retry count of 10. Failed"
description: "MSB3027 bedeutet, dass MSBuild eine Datei zehn Mal zu kopieren versuchte und ein Prozess das Ziel weiterhin gesperrt hielt. Beenden Sie den sperrenden Prozess, schließen Sie bin/obj aus dem Virenscanner aus oder erhöhen Sie CopyRetryCount."
pubDate: 2026-05-11
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "msbuild"
  - "csproj"
lang: "de"
translationOf: "2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count"
translatedBy: "claude"
translationDate: 2026-05-11
---

Der Fix: Der `Copy`-Task von MSBuild hat zehn Mal mit Pausen von je einer Sekunde versucht, eine Datei in Ihrem `bin/`-Verzeichnis zu überschreiben, und ein Prozess hielt weiterhin ein Handle darauf. Ermitteln Sie den haltenden Prozess mit `handle.exe` oder dem Ressourcenmonitor, beenden Sie ihn und kompilieren Sie erneut. Unter Windows ist der Halter fast immer der vorherige Lauf Ihres eigenen Programms (`apphost.exe`, `MyApp.exe`, ein IIS-Express-Worker oder ein `dotnet watch`-Kindprozess), der unter Visual Studio resident gebliebene Build-Server `MSBuild.exe`, oder ein Echtzeit-Virenscanner, der die soeben erzeugte DLL wenige Millisekunden vor MSBuilds Überschreibversuch zur Inspektion geöffnet hat. Lässt sich die Sperrursache nicht beheben, erhöhen Sie `CopyRetryCount` und `CopyRetryDelayMilliseconds` in der `Directory.Build.props` und fahren Sie fort.

```text
error MSB3027: Could not copy "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". Exceeded retry count of 10. Failed. The file is locked by: ".NET Host (4176)"  [C:\src\MyApp\MyApp.csproj]
error MSB3021: Unable to copy file "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". The process cannot access the file 'C:\src\MyApp\bin\Debug\net11.0\MyApp.dll' because it is being used by another process.
```

Dieser Artikel basiert auf .NET SDK 11.0.100-preview.4, MSBuild 17.13 und Visual Studio 17.14. Der `Copy`-Task und der MSB3027-Meldungstext sind seit MSBuild 15 (Visual Studio 2017) stabil, daher gilt dieselbe Checkliste für jedes moderne SDK-style-Projekt von `net6.0` bis `net11.0`. Was sich kürzlich geändert hat, ist das Retry-Verhalten: Zwischen SDK 7.0.306 und 7.0.400 wurde der Retry-Pfad für einige `IOException`-Unterklassen verschärft, weshalb CI-Fehler, die früher unsichtbar waren (der Retry war erfolgreich), nun als MSB3027 sichtbar werden.

## Was MSB3027 tatsächlich bedeutet

`MSB3027` wird vom `Copy`-Task von MSBuild am Ende seiner Retry-Schleife ausgelöst. Der Task wird über die Standardtargets `_CopyFilesMarkedCopyLocal` und `CopyFilesToOutputDirectory` in `Microsoft.Common.CurrentVersion.targets` eingebunden, die gegen Ende jedes `dotnet build` ausgeführt werden. Die Schleife steuern zwei Properties:

- `CopyRetryCount` hat den Standardwert `10`. Der Task scheitert nach so vielen aufeinanderfolgenden Fehlern.
- `CopyRetryDelayMilliseconds` hat den Standardwert `1000`. Der Task wartet so lange zwischen den Versuchen.

Das volle Zehner-Retry-Fenster liegt also bei rund zehn Sekunden. Hält ein Prozess die Zieldatei länger als zehn Sekunden, schlägt MSB3027 zu. MSBuild gibt die innere Exception (`System.IO.IOException`) in der nächsten Zeile als `MSB3021` aus, weshalb die beiden Fehlercodes fast immer gemeinsam auftreten.

Der Microsoft-Learn-Eintrag zu [MSB3027](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb3027) nennt die vier kanonischen Ursachen: Ein anderes Programm hält die Datei, Ihr Konto darf das Ziel nicht beschreiben, der Datenträger ist voll, oder die Netzwerkfreigabe ist nicht verfügbar. In der Praxis auf einem Entwickler-Arbeitsplatz erklärt die erste Ursache weit über 95 Prozent des Aufkommens.

## Warum das passiert (in Prioritätsreihenfolge)

Dies sind die sieben wiederkehrenden Ursachen, nach Häufigkeit in einem realen .NET-11-Projekt geordnet.

1. **Der vorherige Lauf Ihres eigenen Programms lebt noch.** Konsolenanwendungen, die auf `Console.ReadKey` blockieren, dotnet-`IHostedService`-Worker, die auf ein sauberes Shutdown warten, und verwaiste `apphost.exe`-Prozesse aus einer abgestürzten Debug-Sitzung halten eine Dateisperre auf der Hauptausführungsdatei. Die Fehlermeldung benennt den Prozess direkt, zum Beispiel `The file is locked by: ".NET Host (4176)"`.
2. **IIS Express oder der Kestrel-Anwendungspool hält das Assembly.** `dotnet run`, `iisexpress.exe` und der IIS-Worker-Prozess (`w3wp.exe`) halten ein exklusives Read-Share auf der geladenen DLL. Ein aus Visual Studio gestarteter Build, während die vorherige F5-Sitzung noch läuft, trifft das jedes Mal.
3. **`dotnet watch` ist mitten in einem Rebuild.** Hot Reload tauscht Assemblies im Betrieb, doch bei einem Rude Edit löst es einen vollständigen Neustart aus, und es gibt ein kleines Fenster, in dem der alte Prozess und der neue Build dieselbe Datei berühren. Projekte mit vielen Source Generatoren verstärken das, weil die Ausgabe-DLL des Generators zweimal kopiert wird. Das dotnet-SDK verfolgt das seit der .NET-8-Zeit unter [dotnet/sdk#40911](https://github.com/dotnet/sdk/issues/40911).
4. **Der Echtzeit-Virenscanner hat die Datei genau in dem Moment gescannt, in dem MSBuild sie geschrieben hat.** Windows Defender, CrowdStrike Falcon, SentinelOne und vergleichbare Werkzeuge öffnen jede neue `.exe` und `.dll` zur Inspektion. Der Scan ist in wenigen hundert Millisekunden fertig, doch wenn das nächste Projekt in einem Parallel-Build dieselbe Datei kopieren muss, kann der Kopiervorgang mit dem Scanner kollidieren. Defender-Ausschlüsse für das Repo-Root beseitigen diesen Fehlermodus vollständig.
5. **OneDrive oder ein anderer Sync-Client hat die Datei geöffnet.** Die "Files On-Demand"-Funktion von OneDrive öffnet ein Schreib-Handle auf jeder Datei unter einem synchronisierten Ordner, wenn sie Inhalte dehydriert oder rehydriert. Liegt Ihr Quellbaum unter `C:\Users\<Sie>\OneDrive\...`, löst das während langer Builds MSB3027 willkürlich aus.
6. **Der MSBuild-Build-Server (oder VS BuildHost) ist noch angehängt.** Mit `MSBUILDDISABLENODEREUSE=0` (Standard) hält MSBuild `MSBuild.exe`-Knoten zwischen Builds am Leben. In Visual Studio sind das Gegenstück `VBCSCompiler.exe` und der Roslyn-Build-Server. Sie halten kaum je Kopierziele, doch ein hängender Knoten kann ein soeben kompiliertes Assembly festsetzen.
7. **Parallele Projekte in einer Solution kopieren dieselbe Datei im selben Moment.** Zwei Projekte in derselben `.sln`, die von einer gemeinsamen Bibliothek abhängen, versuchen jeweils, diese Bibliothek in ihre eigene Ausgabe zu kopieren. Mit `/m`-Parallelität kann der zweite Kopiervorgang bei `OpenWrite` auf MSB3021 stoßen und das Retry-Budget aufbrauchen. Dies ist in SDK 7.0.400 regrediert und wird unter [dotnet/msbuild#9169](https://github.com/dotnet/msbuild/issues/9169) verfolgt.

## Minimale Reproduktion: eine Konsolen-App, die ihr eigenes Binary offen hält

Der kleinste Reproduzierer ist eine Konsolen-App, die nicht beendet wird. Speichern Sie das als `MyApp/Program.cs` und `MyApp/MyApp.csproj`:

```xml
<!-- MyApp.csproj - .NET 11 preview 4 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
</Project>
```

```csharp
// Program.cs - .NET 11, C# 14
Console.WriteLine("running, press any key to exit");
Console.ReadKey();
```

Starten Sie es in einem Terminal:

```text
dotnet run
```

Ändern Sie dann `Program.cs` (fügen Sie ein Leerzeichen ein) und in einem zweiten Terminal:

```text
dotnet build
```

Der zweite Build gibt aus:

```text
error MSB3021: Unable to copy file "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". The process cannot access the file because it is being used by another process.
error MSB3027: Could not copy "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". Exceeded retry count of 10. Failed.
```

Das ist der kanonische Fall. Das erste Terminal besitzt die DLL, weil der .NET-Host sie nur mit `FILE_SHARE_READ` geöffnet hat, was Schreibzugriffe ausschließt.

## Der Fix im Detail

### 1. Den sperrenden Prozess finden und beenden

Die Meldung hinter `MSB3027` nennt den Prozess, wenn MSBuild ihn auflösen kann. Wenn nicht (typisch in Containern oder auf eingeschränkten Maschinen), greifen Sie zu einer dieser Optionen:

```text
:: sysinternals handle.exe - https://learn.microsoft.com/sysinternals/downloads/handle
handle64.exe -nobanner -accepteula C:\src\MyApp\bin\Debug\net11.0\MyApp.dll
```

```powershell
# Get-Process by module path (PowerShell 7.4+)
Get-Process | Where-Object { $_.Modules.FileName -contains 'C:\src\MyApp\bin\Debug\net11.0\MyApp.dll' }
```

```text
:: Kill by image name
taskkill /im MyApp.exe /f
:: Or by PID from handle.exe output
taskkill /pid 4176 /f
```

Für IIS Express: Rechtsklick auf das Tray-Symbol und `Exit All`, oder `iisexpress /stop /siteid:<id>`. Für vollständiges IIS ist `iisreset` die grobe Variante; `Stop-WebAppPool -Name "<pool>"` die chirurgische.

### 2. Beenden Sie das Programm nicht im selben Terminal, in dem Sie kompilieren

Der sauberste Fix ist Workflow-basiert: Lassen Sie keine Debug-Sitzung angehängt, während Sie neu kompilieren. In Visual Studio erledigen das die Pfade `Edit and Continue` und `Hot Reload` üblicherweise für Sie. Auf der Kommandozeile ist `dotnet watch` (das den Rebuild kennt) einer manuellen Schleife aus `dotnet run` plus separatem `dotnet build` vorzuziehen.

Sehen Sie selbst unter `dotnet watch` bei jedem Rebuild MSB3027, ist das Symptom meist ein Source Generator, dessen Ausgabe-DLL bei jedem Kompilieren neu geschrieben wird. Der im SDK-Repository dokumentierte Workaround besteht darin, den Generator in eine separate `.csproj` mit `<EnforceCodeStyleInBuild>false</EnforceCodeStyleInBuild>` und `<EmitCompilerGeneratedFiles>false</EmitCompilerGeneratedFiles>` auszulagern und das Generator-Projekt mit `OutputItemType="Analyzer" ReferenceOutputAssembly="false"` zu referenzieren. Die DLL des Generators ist dann kein Kopierziel mehr.

### 3. Ausschlüsse für den Virenscanner ergänzen

Für Microsoft Defender öffnen Sie `Windows Security` > `Virus & threat protection` > `Manage settings` > `Exclusions` > `Add or remove exclusions` > `Add an exclusion` > `Folder` und ergänzen Sie:

- Das Repo-Root, mindestens jedoch jedes `bin/`- und `obj/`-Unterverzeichnis.
- `%USERPROFILE%\.nuget\packages` (der globale NuGet-Cache).
- `%USERPROFILE%\.dotnet` (die SDK-Installation).

Bei CrowdStrike / SentinelOne / unternehmensverwaltetem Defender können Sie das nicht selbst erledigen; reichen Sie ein Ticket beim IT-Team ein und verweisen Sie auf die `.gitattributes` oder `.editorconfig` Ihres Teams als Beleg, dass die bin/obj-Ordner Build-Artefakte sind, keine Nutzdaten. Die [Defender-Dokumentation zu Ausschlüssen](https://learn.microsoft.com/en-us/defender-endpoint/configure-extension-file-exclusions-microsoft-defender-antivirus) bestätigt selbst, dass das Echtzeit-Scannen der Build-Ausgabe die häufigste Ursache für sporadische MSBuild-Fehler in Unternehmensumgebungen ist.

### 4. Das Repository aus OneDrive herausziehen

Gibt `pwd` in Ihrem Repo `C:\Users\<Sie>\OneDrive\source\...` aus, ziehen Sie es um. Sync-Clients jeder Art (OneDrive, Dropbox, Google Drive, iCloud) besitzen ein Schreib-Handle auf Dateien, die sie gerade hochladen oder hydrieren, und sie geben dieses Handle nach ihrer eigenen Uhr frei, nicht nach MSBuilds. `C:\src\<repo>` außerhalb jedes synchronisierten Ordners ist das Standard-Layout für .NET-Arbeit unter Windows.

### 5. Das Retry-Budget erhöhen (letzte Möglichkeit)

Ist die Sperre unvermeidlich (CI-Agent mit gemeinsamem Cache, ein nicht ausschließbarer Virenscanner, ein Parallel-Build, der auf eine gemeinsame Abhängigkeit trifft), erhöhen Sie das Budget. Schreiben Sie das in die `Directory.Build.props` im Repo-Root, damit es für jedes Projekt gilt:

```xml
<!-- Directory.Build.props - .NET 11 SDK, MSBuild 17.13 -->
<Project>
  <PropertyGroup>
    <CopyRetryCount>20</CopyRetryCount>
    <CopyRetryDelayMilliseconds>2000</CopyRetryDelayMilliseconds>
  </PropertyGroup>
</Project>
```

Das gibt dem `Copy`-Task vierzig Sekunden Retry-Budget. Höhere Zahlen verbergen lediglich ein ernsteres Problem (einen festsitzenden Prozess, einen falsch konfigurierten Virenscanner) und sorgen dafür, dass jeder fehlgeschlagene Build eine Minute braucht, um sichtbar zu werden. Heben Sie sie deshalb nicht über `CopyRetryCount=20`.

Für den CI-spezifischen Fall, in dem parallele Projekte um dieselbe gemeinsame DLL kämpfen, ist der bessere Fix, `BuildInParallel=false` für die betroffene Solution zu setzen oder die gemeinsame Bibliothek als `<PackageReference>` auf einen NuGet-Feed statt als `<ProjectReference>` einzubinden. Beides lässt das Rennen verschwinden.

### 6. Den Build-Server deaktivieren, wenn MSBuild-Knoten hängen

Hängende MSBuild-Knoten sind selten, aber sichtbar: `tasklist /fi "imagename eq MSBuild.exe"` zeigt Knoten, die seit vielen Minuten nicht wiederverwendet wurden. Beenden Sie sie mit:

```text
dotnet build-server shutdown
```

Setzen Sie das zwischen Builds in Skripten ein, die sporadisch MSB3027 zeigen, oder setzen Sie `MSBUILDDISABLENODEREUSE=1`, um die Knotenwiederverwendung ganz abzuschalten. Die Build-Zeiten steigen um wenige Sekunden, doch die langschwänzigen Dateisperr-Fehler verschwinden.

## Stolperfallen und Varianten

- **MSB3026 ist ein Warning, kein Error.** Es bedeutet, MSBuild hat einen Kopiervorgang wiederholt und der Retry war erfolgreich. Sehen Sie nur MSB3026, ist der Build durchgelaufen und es gibt nichts zu beheben; der Lärm sagt Ihnen nur, dass eine vorübergehende Sperre aufgetreten ist. Wiederholtes MSB3026 ist ein Signal, eine Defender-Ausnahme zu ergänzen, bevor es nächste Woche zu MSB3027 eskaliert.
- **MSB3021 ohne MSB3027.** Das ist das ältere Verhalten, vor Einführung der Retry-Schleife. Sehen Sie nur MSB3021, sind Sie auf einer deutlich älteren Toolchain (.NET Core 2.x oder `msbuild.exe` aus VS 2015), und die Lösung ist dieselbe minus den `CopyRetryCount`-Knopf.
- **Varianten unter Linux und macOS.** Die Fehlernummer ist identisch. Die Unix-Kernel erzwingen kein verbindliches File-Locking wie Windows, daher greifen die meisten Sperrursachen nicht. Übrig bleiben Berechtigungsfehler (das Zielverzeichnis gehört nach einem Docker-Build dem Benutzer `root`) und volle Dateisysteme. `df -h` und `ls -ld bin/` schließen beides in Sekunden aus.
- **Container.** Innerhalb eines Linux-Containers mit einem aus Windows gemounteten Host-Volume zu kompilieren, ist das Schlechteste aus beiden Welten: Der Virenscanner des Hosts scannt Dateien, die aus dem Container heraus geschrieben werden. Entweder kompilieren Sie im Container mit einem container-lokalen Volume (`docker volume create`), oder Sie kompilieren direkt auf dem Host.
- **The file is locked by: 'System' or 'unknown'.** Wird der Halter als `System (4)` oder ohne Namen gemeldet, ist der Verursacher fast immer ein Antivirus-Treiber im Kernel-Modus. Defender, CrowdStrike und SentinelOne erscheinen so. Ein `taskkill` im Usermode hilft nicht; die Lösung ist eine Ausnahme oder das vorübergehende Deaktivieren des Echtzeit-Schutzes.
- **Native AOT und Publish mit Trim.** `dotnet publish -c Release` für ein Native-AOT-Projekt schreibt die Ausgabe-`.exe` manchmal zweimal (einmal für den Publish-Schritt, einmal für die Trim-Verifizierung). Bei langsamer IO konkurriert das mit sich selbst. Setzen Sie `<PublishAot>true</PublishAot>` und `<PublishSingleFile>false</PublishSingleFile>` gemeinsam, um die doppelte Kopie zu vermeiden.

## Verwandte Artikel

- [Fix: The type or namespace name 'X' could not be found after adding a project reference](/de/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) ist die andere Hälfte des Troubleshooting-Werkzeugkastens für SDK-style-Projekte. Referenz- und Kopierfehler teilen häufiger eine gemeinsame Ursache, als man denkt.
- [Fix: PlatformNotSupportedException: Operation is not supported on this platform in Native AOT](/de/2026/05/fix-platformnotsupportedexception-in-native-aot/) behandelt die Trim- und AOT-Szenarien, in denen MSB3027 auch aus dem Publish-Pfad auftaucht.
- [How to profile a .NET app with dotnet-trace and read the output](/de/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) hilft, wenn der haltende Prozess Ihr eigenes Programm ist und Sie herausfinden möchten, was den Prozess überhaupt am Leben gehalten hat.
- [.NET watch in .NET 11 preview 3: Aspire crash recovery](/de/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/) ist die jüngste SDK-Änderung, die die `dotnet watch`-Variante dieses Fehlers betrifft.
- [Visual Studio 2026 Hot Reload: auto-restart on rude edits](/de/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/) ist das IDE-Pendant zur Hot-Reload-Ursache.

## Quellen

- Microsoft Learn, [MSB3027 diagnostic code - MSBuild](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb3027) (die offizielle Einseiten-Referenz)
- Microsoft Learn, [Configure Microsoft Defender Antivirus exclusions by extension, name, or location](https://learn.microsoft.com/en-us/defender-endpoint/configure-extension-file-exclusions-microsoft-defender-antivirus)
- GitHub, [dotnet/msbuild#9169 File copy is no longer retried, causing builds to randomly fail](https://github.com/dotnet/msbuild/issues/9169)
- GitHub, [dotnet/sdk#40911 dotnet watch fails with MSB3021 (locked file) when project references custom source generator](https://github.com/dotnet/sdk/issues/40911)
- Microsoft Sysinternals, [handle.exe](https://learn.microsoft.com/en-us/sysinternals/downloads/handle), das kanonische Werkzeug, um den sperrenden Prozess zu benennen

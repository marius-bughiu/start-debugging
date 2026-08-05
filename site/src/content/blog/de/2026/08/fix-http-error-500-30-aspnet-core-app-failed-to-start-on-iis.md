---
title: "Lösung: HTTP Error 500.30 - ASP.NET Core app failed to start nach der Bereitstellung auf IIS"
description: "500.30 bedeutet, dass die Anwendung beim Start innerhalb von w3wp.exe eine Ausnahme geworfen hat. Die eigentliche Ausnahme steht bereits im Windows-Anwendungsprotokoll unter IIS AspNetCore Module V2. Zuerst dort lesen, dann die Ursache einordnen: fehlendes Shared Framework, x86/x64-Diskrepanz des Anwendungspools, fehlende Konfiguration oder Pool-Berechtigungen."
pubDate: 2026-08-05
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "iis"
  - "deployment"
lang: "de"
translationOf: "2026/08/fix-http-error-500-30-aspnet-core-app-failed-to-start-on-iis"
translatedBy: "claude"
translationDate: 2026-08-05
---

`500.30` ist keine Ursache, sondern die Meldung von IIS, dass das ASP.NET Core Module die CLR innerhalb von `w3wp.exe` gestartet hat und Ihre Anwendung eine Ausnahme geworfen hat, bevor sie mit dem Lauschen beginnen konnte. Die eigentliche Ausnahme liegt mit hoher Wahrscheinlichkeit bereits auf dem Server: Öffnen Sie die Ereignisanzeige, gehen Sie zu **Windows-Protokolle > Anwendung** und suchen Sie den neuesten Eintrag mit der Quelle **IIS AspNetCore Module V2**. Wenn `stdoutLogEnabled` auf `false` steht, erfasst das Modul Startfehler und schreibt bis zu 30 KB davon in dieses Ereignis, inklusive Stack Trace. Gibt der Eintrag nur `exception code = '0xe0434352'` her und sonst nichts, setzen Sie `stdoutLogEnabled="true"` in der `web.config` und rufen Sie die Seite erneut auf. Alles Weitere ist eine Rangfolge der vier Dinge, die es tatsächlich verursachen.

```text
HTTP Error 500.30 - ASP.NET Core app failed to start
```

Ältere Builds des ASP.NET Core Module stellen exakt denselben Fehler als `HTTP Error 500.30 - ANCM In-Process Start Failure` dar, und das ist weiterhin die Zeichenfolge, die die Microsoft-Dokumentation in ihren Fehlertabellen verwendet. Beide bedeuten dasselbe. Alles Folgende wurde gegen .NET 11 (Preview 6, SDK `11.0.100-preview.6.26359.118`) mit ANCM V2 aus dem aktuellen .NET Hosting Bundle geprüft. Der Mechanismus hat sich seit ASP.NET Core 3.0 nicht geändert, als In-Process-Hosting zum Standard wurde, daher gilt jeder Schritt unverändert für Bereitstellungen mit `net8.0`, `net9.0` und `net10.0`.

## Warum 500.30 ein Symptom und keine Diagnose ist

Seit ASP.NET Core 3.0 verwenden Anwendungen standardmäßig das **In-Process-Hostingmodell**. Die MSBuild-Eigenschaft `<AspNetCoreHostingModel>` hat den Standardwert `InProcess`, und `dotnet publish` schreibt `hostingModel="inprocess"` in die `web.config`. In diesem Modell gibt es keinen separaten `dotnet.exe`-Prozess. `aspnetcorev2.dll` lädt den In-Process-Anforderungshandler in den IIS-Arbeitsprozess, startet dort CoreCLR, und Ihre `Program.cs` läuft innerhalb von `w3wp.exe` mit `IISHttpServer` statt Kestrel.

Das ergibt einen Prozess statt zwei und einen spürbaren Gewinn beim Durchsatz, zerstört aber die Fehlerberichterstattung. Wirft die Anwendung eine Ausnahme, bevor `app.Run()` den lauschenden Zustand erreicht, hat das Modul eine tote CLR im eigenen Prozess und ein Byte an Information für den Browser: Der Start ist fehlgeschlagen. Daher ein einziger Statuscode für eine fehlende Verbindungszeichenfolge, eine 32-Bit-Binärdatei in einem 64-Bit-Arbeitsprozess, eine nicht installierte Laufzeit und eine `DirectoryNotFoundException` auf einem Datenschutz-Schlüsselring.

Zwei Konsequenzen sollten Sie verinnerlichen, bevor Sie etwas ändern:

- **`startupTimeLimit` startet nichts neu.** Beim In-Process-Hosting wird der Prozess nach Ablauf des Standardfensters von 120 Sekunden beendet und *nicht* neu gestartet, und `rapidFailsPerMinute` gilt nicht. Out-of-Process-Hosting versucht es bei der nächsten Anfrage erneut. In-Process nicht.
- **Der Anwendungspool lässt sich nicht teilen.** In-Process-Hosting erfordert einen Anwendungspool pro Anwendung. Zwei In-Process-Anwendungen in einem Pool erzeugen `500.35`, und eine Mischung aus In-Process und Out-of-Process in einem Pool erzeugt `500.34`.

## Die minimale Reproduktion

Die kleinste Bereitstellung, die das reproduziert, ist eine Anwendung, die Konfiguration liest, die lokal existiert und auf dem Server nicht:

```csharp
// .NET 11 preview 6, C# 14. Program.cs
var builder = WebApplication.CreateBuilder(args);

string cs = builder.Configuration.GetConnectionString("Default")
    ?? throw new InvalidOperationException("Connection string 'Default' is missing.");

builder.Services.AddDbContext<AppDbContext>(o => o.UseSqlServer(cs));

var app = builder.Build();
app.MapGet("/", () => "ok");
app.Run();
```

Lokal läuft das, weil `appsettings.Development.json` den Abschnitt enthält und `ASPNETCORE_ENVIRONMENT` auf `Development` steht. Auf dem Server ist die Umgebung `Production`, `appsettings.Production.json` wurde nie in die Veröffentlichungsausgabe aufgenommen, und die Ausnahme entsteht in Zeile 3. F5 funktioniert, die Bereitstellung liefert 500.30, und an der Anwendung ist nichts falsch.

Diese Form deckt einen großen Teil der realen 500.30-Meldungen ab: Der Fehler ist umgebungsbedingt und damit konstruktionsbedingt auf dem Entwicklerrechner unsichtbar.

## Das Anwendungsprotokoll lesen, was die Untersuchung meist beendet

Tun Sie das, bevor Sie die `web.config` anfassen. Starten Sie auf dem Server die Ereignisanzeige als Administrator und öffnen Sie **Windows-Protokolle > Anwendung**, oder fragen Sie direkt ab:

```powershell
# Windows Server 2022+, PowerShell 5.1 or 7.x. Run elevated on the web server.
Get-WinEvent -FilterHashtable @{
    LogName      = 'Application'
    ProviderName = 'IIS AspNetCore Module V2'
} -MaxEvents 5 | Format-List TimeCreated, Id, LevelDisplayName, Message
```

Sie suchen nach einer von drei Formen.

**Form 1, die nützliche.** Ein vollständiger verwalteter Stack Trace. Das Modul hat Ihre unbehandelte Startausnahme erfasst und ins Anwendungsprotokoll geschrieben, weil `stdoutLogEnabled` auf `false` steht. Lesen Sie den Ausnahmetyp und den obersten Frame, beheben Sie das, und Sie sind fertig. Dieser Fall wird oft übersprungen, weil die Browserseite nichts verraten hat und man annimmt, der Server tue es auch nicht.

**Form 2, die undurchsichtige:**

```text
Application '/LM/W3SVC/5/ROOT' with physical root 'C:\inetpub\wwwroot\myapp\'
hit unexpected managed exception, exception code = '0xe0434352'.
Please check the stderr logs for more information.
Application '/LM/W3SVC/5/ROOT' with physical root 'C:\inetpub\wwwroot\myapp\'
failed to load clr and managed application. CLR worker thread exited prematurely
```

`0xe0434352` ist der generische Win32-Code für "eine verwaltete Ausnahme ist entkommen", mehr nicht. Er trägt weder Typ noch Meldung. Das ist die dokumentierte Signatur einer x86-Anwendung in einem Anwendungspool, der nicht für 32-Bit-Anwendungen aktiviert ist, sie erscheint aber auch immer dann, wenn die Ausnahme an einer Stelle entkommen ist, an der das Modul das Detail nicht erfassen konnte. Weiter zum stdout-Protokoll.

**Form 3, gar nichts.** Kein ANCM-Ereignis innerhalb einer Minute nach Ihrer Anfrage. Das bedeutet meist, dass das Modul die CLR nie gestartet hat und Sie es tatsächlich mit `500.0`, `500.31` oder `500.32` zu tun haben statt mit einer Startausnahme. Siehe den Abschnitt zu den Varianten am Ende.

## Das stdout-Protokoll aktivieren

Bearbeiten Sie die bereitgestellte `web.config` auf dem Server, nicht die im Projekt. Sie wird bei jeder Veröffentlichung neu erzeugt, was für einen temporären Diagnoseschalter genau richtig ist.

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- Deployed web.config, ASP.NET Core Module V2, .NET 11 -->
<configuration>
  <location path="." inheritInChildApplications="false">
    <system.webServer>
      <handlers>
        <add name="aspNetCore" path="*" verb="*" modules="AspNetCoreModuleV2" resourceType="Unspecified" />
      </handlers>
      <aspNetCore processPath="dotnet"
                  arguments=".\MyApp.dll"
                  stdoutLogEnabled="true"
                  stdoutLogFile=".\logs\stdout"
                  hostingModel="inprocess" />
    </system.webServer>
  </location>
</configuration>
```

Das Speichern der `web.config` recycelt den Anwendungspool, rufen Sie die Seite also einfach erneut auf. Das Modul erstellt den Ordner `logs` für `stdoutLogFile` selbst und schreibt eine Datei mit Zeitstempel und Prozess-ID im Namen, zum Beispiel `stdout_20260805184032_5412.log`. Die Identität des Anwendungspools braucht Schreibzugriff auf diesen Ordner:

```console
icacls "C:\inetpub\wwwroot\myapp\logs" /grant "IIS AppPool\MyAppPool":(OI)(CI)M
```

Drei Lesehinweise, die Zeit sparen:

- **Die Datei existiert, ist aber leer.** Der Prozess starb, bevor er etwas nach stdout schreiben konnte. Das deutet auf eine Architektur-Diskrepanz oder einen nativen Ladefehler hin, nicht auf Ihren Code.
- **Die Datei enthält normale Startzeilen und bricht dann ab.** Was unmittelbar nach der letzten Zeile ausgeführt wird, ist Ihr Verdächtiger.
- **Schalten Sie es wieder aus.** `stdoutLogEnabled="true"` schreibt dauerhaft bei jedem Prozess-Recycling eine neue Datei, und die Dokumentation sagt ausdrücklich, dass ein dauerhaft aktiviertes Protokoll die Anwendung oder den Server lahmlegen kann. Setzen Sie es auf `false` zurück, sobald Sie Ihre Antwort haben.

Bleibt stdout weiterhin stumm, liegt der Fehler unterhalb des verwalteten Codes. Ergänzen Sie das Debug-Protokoll des Moduls selbst:

```xml
<!-- ASP.NET Core Module V2 diagnostic logging. Remove after troubleshooting. -->
<aspNetCore processPath="dotnet"
            arguments=".\MyApp.dll"
            stdoutLogEnabled="false"
            stdoutLogFile=".\logs\stdout"
            hostingModel="inprocess">
  <handlerSettings>
    <handlerSetting name="debugFile" value=".\logs\aspnetcore-debug.log" />
    <handlerSetting name="debugLevel" value="FILE,TRACE" />
  </handlerSettings>
</aspNetCore>
```

Anders als bei `stdoutLogFile` legt das Modul für `debugFile` **keine** Ordner an. Das Verzeichnis `logs` muss bereits existieren und für die Pool-Identität beschreibbar sein, sonst erhalten Sie nichts und ziehen den falschen Schluss. Dieses Protokoll zeigt die hostfxr-Auflösung, welche Framework-Versionen berücksichtigt wurden und welche DLL nicht geladen werden konnte.

## Lösung 1: Die Anwendung hat beim Start eine Ausnahme geworfen, und das ist die Mehrheit der Fälle

Wenn Ihnen das Anwendungsprotokoll oder das stdout-Protokoll einen Stack Trace geliefert hat, betrifft Sie dieser Abschnitt. Die Häufung in der Praxis:

1. **Konfiguration, die lokal vorhanden und auf dem Server abwesend ist.** `appsettings.Production.json` nicht in der Veröffentlichungsausgabe, ein User-Secrets-Wert ohne Produktionsäquivalent, eine Umgebungsvariable nur auf Ihrem Rechner. Das ist der [Fehler wegen fehlender Verbindungszeichenfolge](/de/2026/05/fix-no-connection-string-named-defaultconnection/) in seiner Bereitstellungsform.
2. **Fehler im DI-Graphen bei `builder.Build()`.** ASP.NET Core validiert Bereiche und den Dienstgraphen beim Build in Development, und jedes Problem mit `Unable to resolve service for type` oder einer Captive Dependency erscheint als 500.30 statt als hilfreiche Seite. Siehe [unable to resolve service for type while attempting to activate](/de/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) und [cannot consume scoped service from singleton](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
3. **Externe Abhängigkeiten, die beim Start kontaktiert werden.** Key Vault mit einer Zugriffsrichtlinie, die die verwaltete Identität des Anwendungspools nicht abdeckt, ist der Fall, den Microsoft für 500.30 ausdrücklich nennt. Eine beim Start ausgeführte Migration, ein Konfigurationsanbieter, der eine Datenbank erreicht, ein Abruf des OIDC-Discovery-Dokuments auf einem Server ohne ausgehenden Zugriff: Alle machen aus einem Netzwerkproblem einen Startfehler.
4. **Zugriff auf Zertifikate und Datenschutz.** Das Laden eines X.509-Zertifikats aus dem Computerspeicher oder das Persistieren eines Datenschutz-Schlüsselrings in einem Pfad, in den die Pool-Identität nicht schreiben darf, wirft vor der ersten Anfrage.

Die strukturelle Lösung für diese gesamte Kategorie besteht darin, Startfehler explizit und lesbar zu machen statt zufällig. Die Konfiguration beim Start mit [`IValidateOptions<T>` und `ValidateOnStart`](/de/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) zu validieren, verwandelt "die Anwendung liefert 500.30" in eine benannte `OptionsValidationException`, die genau auflistet, welche Einstellungen fehlen. Das ist der Unterschied zwischen einer Korrektur in fünf Minuten und einem verlorenen Nachmittag.

Um die rohe Ausnahme auf einem Staging-Rechner im Browser zu sehen, ergänzen Sie die Umgebungsvariable in der `web.config`. Tun Sie das niemals auf einem öffentlichen Server:

```xml
<!-- Staging and test servers only. Do not ship this to an internet-facing host. -->
<aspNetCore processPath="dotnet" arguments=".\MyApp.dll" hostingModel="inprocess">
  <environmentVariables>
    <environmentVariable name="ASPNETCORE_ENVIRONMENT" value="Development" />
    <environmentVariable name="ASPNETCORE_DETAILEDERRORS" value="true" />
  </environmentVariables>
</aspNetCore>
```

## Lösung 2: Das Shared Framework der Anwendung ist nicht installiert

Microsoft nennt das als erste Ursache für 500.30: Die Anwendung zielt auf eine Version des ASP.NET Core Shared Framework, die nicht vorhanden ist. Prüfen Sie, was der Server tatsächlich hat:

```console
dotnet --list-runtimes
```

Sie brauchen eine `Microsoft.AspNetCore.App`-Zeile, deren Hauptversion zu Ihrem `TargetFramework` passt, und zwar in derselben Architektur wie der Anwendungspool. Ist die Anwendung `net11.0` und der Server kommt nur bis `Microsoft.AspNetCore.App 10.0.x`, ist das Ihre Antwort, denn ASP.NET Core führt standardmäßig kein Roll-Forward über Hauptversionen hinweg durch.

Installieren Sie das **.NET Hosting Bundle**, das Laufzeit, ASP.NET Core Shared Framework und ANCM in einem Paket installiert. Zwei Installationsregeln verursachen mehr 500.30-Fälle als der Download selbst:

- **IIS muss vor dem Hosting Bundle installiert sein.** Kam das Bundle zuerst, ist ein erneuter Lauf des Installers zur Reparatur zwingend, nicht optional.
- **Starten Sie den Webserver nach der Installation neu.** Der Installer ändert den System-`PATH`, und ASP.NET Core führt auch für Patch-Releases der Shared-Framework-Pakete kein Roll-Forward durch, daher ist derselbe Neustart nach jedem Bundle-Upgrade nötig:

```console
net stop was /y
net start w3svc
```

Ein vollständiges `iisreset` funktioniert ebenfalls. Wird dieser Schritt übersprungen, entsteht die häufige Rückfrage "Ich habe die Laufzeit installiert und es schlägt immer noch fehl".

## Lösung 3: Anwendung und Anwendungspool sind sich über die Bitness uneinig

In-Process-Hosting verlangt, dass die Architektur der Anwendung und der installierten Laufzeit zur Architektur des Anwendungspools passt. Es gibt keine Anpassungsschicht. Eine 32-Bit-Binärdatei kann CoreCLR nicht in einer 64-Bit-`w3wp.exe` starten.

Wählen Sie im IIS-Manager den Anwendungspool aus, öffnen Sie **Erweiterte Einstellungen** und setzen Sie **32-Bit-Anwendungen aktivieren**:

- `True` für eine x86-Anwendung, einschließlich einer eigenständigen x86-Bereitstellung, die mit einem 32-Bit-SDK veröffentlicht wurde.
- `False` für eine x64-Anwendung.

Oder über die Befehlszeile:

```console
%windir%\system32\inetsrv\appcmd set apppool /apppool.name:MyAppPool /enable32BitAppOnWin64:false
```

Setzen Sie bei dieser Gelegenheit in den Basiseinstellungen die **.NET CLR-Version** auf **Kein verwalteter Code**. ASP.NET Core startet CoreCLR selbst und braucht die Desktop-CLR nie im Arbeitsprozess. Das ist als optional, aber empfohlen dokumentiert und beseitigt eine ganze Klasse verwirrender Wechselwirkungen mit älteren Modulen.

Eine Falle speziell beim Hosting Bundle: Haben Sie es mit `OPT_NO_X86=1` installiert, existiert auf dieser Maschine überhaupt keine 32-Bit-Laufzeit, und eine x86-Anwendung schlägt unabhängig von der Pool-Einstellung fehl.

## Lösung 4: Die Pool-Identität kann nicht lesen, was sie braucht

Die standardmäßige `ApplicationPoolIdentity` ist ein virtuelles Konto, und jeder durch Berechtigungen verursachte 500.30 sieht aus wie jeder andere 500.30. Wurde die Identität von `ApplicationPoolIdentity` auf ein Domänen- oder Dienstkonto geändert, prüfen Sie, ob sie Lesezugriff auf den Bereitstellungsordner und Schreibzugriff auf alle Orte hat, in die die Anwendung schreibt. Erteilen Sie den Zugriff auf den Ordner über den Poolnamen:

```console
icacls "C:\inetpub\wwwroot\myapp" /grant "IIS AppPool\MyAppPool":(OI)(CI)RX
```

Zwei Fälle lohnen die direkte Prüfung: Das Lesen des privaten Schlüssels eines Zertifikats aus dem Computerspeicher erfordert eine ACL auf dem Schlüsselcontainer, und jeder Code, der `%USERPROFILE%` berührt, braucht **Benutzerprofil laden** auf `True` im Anwendungspool. Der Wert ist standardmäßig `True` und wird in gehärteten Umgebungen häufig abgeschaltet.

## Halbieren Sie die Suchfläche, indem Sie die Anwendung außerhalb von IIS starten

Bevor Sie eine weitere Stunde in IIS-Konfiguration investieren, melden Sie sich am Server an, öffnen Sie eine Konsole im Bereitstellungsordner und starten Sie die Anwendung direkt:

```console
cd C:\inetpub\wwwroot\myapp
set ASPNETCORE_ENVIRONMENT=Production
dotnet MyApp.dll
```

Die Ausnahme wird mit vollständigem Stack Trace auf der Konsole ausgegeben, ohne jede Protokollierungskonfiguration. Wirft sie hier, liegt das Problem bei Ihrer Anwendung oder deren Konfiguration und IIS ist unschuldig, was Sie direkt zu Lösung 1 führt. Startet sie sauber und bedient `http://localhost:5000`, liegt das Problem in der Hosting-Schicht: Bitness, Berechtigungen oder das Modul, was Sie zu Lösung 2, 3 oder 4 führt. Dieser eine Befehl entscheidet, welche Hälfte dieses Artikels Sie brauchen.

Beachten Sie die Umgebungsvariable. Ein Lauf unter Ihrem eigenen Konto mit Ihrer eigenen Umgebung ist nicht dasselbe wie ein Lauf unter der Pool-Identität, ein sauberer Lauf beweist hier also nicht, dass die Dateiberechtigungen korrekt sind. Er beweist, dass Code und bereitgestellte Konfigurationsdateien es sind.

## Die benachbarten Codes, die nicht 500.30 sind

Der Suchverkehr zu 500.30 sammelt viele nahe Verwandte ein. Steht auf Ihrer Seite etwas anderes, ist es ein anderes Problem mit einer anderen Lösung:

- **`500.0 - ANCM In-Process Handler Load Failure`**: Das Modul konnte den In-Process-Anforderungshandler überhaupt nicht laden. Falscher `processPath`, Hosting Bundle nicht installiert, IIS danach nicht neu gestartet, oder ein fehlendes VC++-Redistributable.
- **`500.31 - ANCM Failed to Find Native Dependencies`**: `Microsoft.NETCore.App` oder `Microsoft.AspNetCore.App` ist nicht installiert. Das Anwendungsprotokoll nennt Framework und Version, die nicht gefunden wurden. Installieren, das Ziel ändern oder eigenständig veröffentlichen.
- **`500.32 - ANCM Failed to Load dll`**: Diskrepanz der Prozessorarchitektur, dieselbe Ursache wie bei Lösung 3, eine Schicht tiefer sichtbar.
- **`500.33 - ANCM Request Handler Load Failure`**: Die Anwendung referenziert das Framework `Microsoft.AspNetCore.App` nicht. Prüfen Sie `.runtimeconfig.json`. Eine Konsolenanwendung mit `Microsoft.NET.Sdk` statt `Microsoft.NET.Sdk.Web` erzeugt das.
- **`500.34` und `500.35`**: Gemischte Hostingmodelle oder zwei In-Process-Anwendungen in einem Anwendungspool. Trennen Sie sie in eigene Pools auf.
- **`500.36 - ANCM Out-Of-Process Handler Load Failure`**: `aspnetcorev2_outofprocess.dll` fehlt neben `aspnetcorev2.dll`. Reparieren Sie das Hosting Bundle.
- **`500.37 - ANCM Failed to Start Within Startup Time Limit`**: Der Start überschritt 120 Sekunden. Erhöhen Sie `startupTimeLimit`, oder staffeln Sie den Start vieler Anwendungen, die auf derselben Maschine um CPU konkurrieren.
- **`500.38 - ANCM Application DLL Not Found`**: Sie haben eine Einzeldatei-Anwendung veröffentlicht, und In-Process-Hosting unterstützt das nicht. Setzen Sie `<PublishSingleFile>false</PublishSingleFile>` oder wechseln Sie zu `<AspNetCoreHostingModel>OutOfProcess</AspNetCoreHostingModel>`.
- **`502.5 - Process Failure`**: Nur Out-of-Process-Hosting. Der Backend-Prozess konnte nicht gestartet werden oder lauschte nicht auf `%ASPNETCORE_PORT%`. Häufig eine `BadImageFormatException` durch eine RID-Diskrepanz, sichtbar im stdout-Protokoll.
- **`500.19`**: Ein IIS-Konfigurationsfehler beim Lesen der `web.config` selbst, meist weil ANCM nicht registriert oder die Konfiguration fehlerhaft ist. Die Anwendung kam nie ins Spiel.

Der Wechsel zu Out-of-Process-Hosting ist ein legitimer Diagnoseschritt und keine Lösung. Setzen Sie `hostingModel="outofprocess"` in der `web.config`, wird der Arbeitsprozess recycelt und Ihre Anwendung läuft als untergeordnete `dotnet.exe`, wo Startfehler deutlich leichter zu beobachten sind und `requestTimeout` sowie `rapidFailsPerMinute` wieder gelten. Nutzen Sie das, um einen lesbaren Fehler zu bekommen, und gehen Sie danach wegen der Leistung zurück zu In-Process.

Die Untersuchung eines 500.30 bleibt kurz, wenn Sie sie der Reihe nach angehen: Anwendungsprotokoll, dann Start über die Konsole, dann Bitness und Laufzeit. Ein langer Nachmittag wird daraus erst, wenn Sie mit der Browserseite beginnen und raten.

## Verwandte Beiträge

- [Fix: Unable to resolve service for type X while attempting to activate Y](/de/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) ist die häufigste verwaltete Ausnahme hinter einem 500.30.
- [Fix: Cannot consume scoped service from singleton](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/) behandelt den anderen DI-Fehler, der erst nach dem Aufbau des Containers auftritt.
- [Optionen beim Start mit IValidateOptions&lt;T&gt; in .NET 11 validieren](/de/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) verwandelt "die Anwendung startet nicht" in eine benannte Ausnahme, die sagt, welche Einstellung falsch ist.
- [Fix: No connection string named 'DefaultConnection' could be found](/de/2026/05/fix-no-connection-string-named-defaultconnection/) ist die klassische Konfigurationslücke, die bis zur Bereitstellung überlebt.
- [Fix: Could not load file or assembly in einer veröffentlichten Anwendung](/de/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) behandelt Probleme der Veröffentlichungsausgabe, die als Startfehler auftreten.
- [Von .NET 8 auf .NET 11 migrieren: die vollständige Checkliste](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) enthält den Schritt zum Hosting-Bundle-Upgrade, den ein Hauptversionssprung auf jedem IIS-Server verlangt.

## Quellen

- [Troubleshoot ASP.NET Core on Azure App Service and IIS](https://learn.microsoft.com/en-us/aspnet/core/test/troubleshoot-azure-iis) auf MS Learn, für die Definitionen von 500.30 bis 500.38, das stdout-Protokoll und das ANCM-Debug-Protokoll.
- [Common error troubleshooting for Azure App Service and IIS with ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/azure-iis-errors-reference) für die wörtlichen Zeichenfolgen im Anwendungsprotokoll, einschließlich der Signatur `0xe0434352`.
- [ASP.NET Core Module (ANCM) for IIS](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/aspnet-core-module) für die Attribute des `aspNetCore`-Elements, deren Standardwerte und die Eigenschaften des In-Process-Hostings.
- [Host ASP.NET Core on Windows with IIS](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/iis/) für die Installationsreihenfolge des Hosting Bundle, `net stop was /y` und die Konfiguration des Anwendungspools.
- [Install the .NET Hosting Bundle](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/iis/hosting-bundle) für die Installer-Optionen einschließlich `OPT_NO_X86`.

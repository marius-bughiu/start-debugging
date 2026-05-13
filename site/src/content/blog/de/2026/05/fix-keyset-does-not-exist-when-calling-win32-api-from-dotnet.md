---
title: "Fix: System.Security.Cryptography.CryptographicException: Keyset does not exist"
description: "Der private Schlüssel des Zertifikats liegt in einer separaten Windows-Schlüsseldatei, die die Prozessidentität nicht lesen kann. Setzen Sie die ACL, laden Sie das PFX mit MachineKeySet oder verwenden Sie EphemeralKeySet."
pubDate: 2026-05-13
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "cryptography"
  - "x509"
  - "windows"
lang: "de"
translationOf: "2026/05/fix-keyset-does-not-exist-when-calling-win32-api-from-dotnet"
translatedBy: "claude"
translationDate: 2026-05-13
---

Die Lösung: Es handelt sich um `NTE_BAD_KEYSET` (HRESULT `0x80090016`), das aus einem Win32-Krypto-Aufruf hochsprudelt. Das Zertifikatsobjekt in Ihrer Hand enthält einen öffentlichen Schlüssel, aber die **private Schlüsseldatei** auf der Festplatte liegt an einem separaten Ort, und die aktuelle Prozessidentität hat keine Leseberechtigung darauf, oder diese Datei existiert nicht mehr für das Benutzerprofil, unter dem Sie laufen. Drei Lösungen decken nahezu jeden Fall ab: Gewähren Sie der Prozessidentität Lesezugriff auf den privaten Schlüssel (Zertifikat-Snap-In oder `icacls` auf der Schlüsselcontainerdatei), laden Sie das PFX mit `X509KeyStorageFlags.MachineKeySet | PersistKeySet`, damit der Schlüssel im Maschinenspeicher landet, oder laden Sie das PFX mit `EphemeralKeySet`, sodass gar keine Datei auf der Festplatte nötig ist.

```text
System.Security.Cryptography.CryptographicException: Keyset does not exist
   at System.Security.Cryptography.CryptographicException.ThrowCryptographicException(Int32 hr)
   at System.Security.Cryptography.X509Certificates.CertificatePal.GetPrivateKey[T](Func`2 createCsp, Func`2 createCng)
   at System.Security.Cryptography.X509Certificates.X509Certificate2.GetRSAPrivateKey()
   at MyApp.SigningService.Sign(Byte[] payload)
```

Dieser Leitfaden wurde gegen .NET 11 preview 4 auf Windows Server 2025 / Windows 11 24H2 geschrieben. Der Fehler ist seit .NET Framework 1.1 identisch, denn die Meldung kommt wörtlich aus `NTE_BAD_KEYSET` in `winerror.h`. Was sich im modernen .NET geändert hat, ist das **Standardverhalten der Schlüsselspeicherung** beim Laden eines PFX: .NET 9 hat `X509CertificateLoader` eingeführt, die Konstruktoren `X509Certificate2(byte[])` und `new X509Certificate2(path, password)` für PFX-Inhalte als veraltet markiert (`SYSLIB0057`) und den empfohlenen Ladepfad verschoben. Die neue API persistiert Schlüssel **nicht** still auf der Festplatte, wie es die alten Konstruktoren taten. Wenn Sie das eine mechanisch durch das andere ersetzt haben, ist der Fehler, den Sie lesen, die Konsequenz.

Zwei Dinge sind vor jeder Lösung unten zu prüfen. Erstens liefert `certificate.HasPrivateKey` auch dann `true`, wenn die Schlüsseldatei fehlt oder unzugänglich ist. Das Flag verfolgt, ob die **Zertifikatsmetadaten** einen privaten Schlüssel anzeigen, nicht ob Sie ihn tatsächlich öffnen können. Zweitens ist der Fehler identisch bei einem fehlenden Schlüsselcontainer, einem Schlüsselcontainer auf einem anderen Benutzerprofil und einem Schlüsselcontainer, dessen ACL Ihren Prozess verweigert. Die Abhilfe hängt davon ab, welcher der drei Fälle vorliegt; die folgenden Abschnitte gehen sie der Reihe nach durch.

## Warum ein Zertifikat überhaupt eine Schlüsseldatei hat

Unter Windows ist ein X.509-Zertifikat ein öffentliches Dokument. Der zugehörige private Schlüssel liegt nie in der Zertifikatsdatei; er lebt in einem Schlüsselcontainer, der vom Kryptoanbieter verwaltet wird. Es gibt zwei Anbieter und zwei Geltungsbereiche, die Sie auseinanderhalten müssen:

- **CAPI (Microsoft Cryptographic API)**: Legacy-Anbieter, Schlüsselcontainer werden in `%APPDATA%\Microsoft\Crypto\RSA\<SID>\` für den Benutzer-Geltungsbereich und in `%ProgramData%\Microsoft\Crypto\RSA\MachineKeys\` für den Maschinen-Geltungsbereich gespeichert. Jeder Container ist eine einzelne Datei mit einem GUID-ähnlichen Namen.
- **CNG (Cryptography Next Generation)**: moderner Anbieter, Schlüsselcontainer in `%APPDATA%\Microsoft\Crypto\Keys\` bzw. `%ProgramData%\Microsoft\Crypto\Keys\`.

Beim Import eines PFX schreibt der Loader das Zertifikat in den **Eigene Zertifikate**-Speicher (`Cert:\CurrentUser\My` oder `Cert:\LocalMachine\My`) und das Schlüsselmaterial in eines dieser vier Verzeichnisse, je nach `X509KeyStorageFlags`. Das Herausziehen des Zertifikats aus dem Speicher in ein `X509Certificate2` ruft nur den öffentlichen Teil plus einen Zeiger auf den Schlüsselcontainer ab. Beim ersten Aufruf von `GetRSAPrivateKey()`, `GetECDsaPrivateKey()` oder der veralteten `PrivateKey`-Eigenschaft öffnet die Laufzeit diesen Container über die entsprechende Win32-API. Wenn die Datei verschwunden ist, die SID keine Lese-ACE besitzt oder der Pfad auf ein Profil verweist, das in der aktuellen Anmeldesitzung nicht existiert, erhalten Sie `NTE_BAD_KEYSET`.

Die Erkenntnis: Zertifikat und Schlüssel sind entkoppelt, und die Frage "hat dieser Prozess den privaten Schlüssel?" ist eigentlich "hat diese Prozessidentität Lesezugriff auf die Datei, auf die dieses Zertifikat verweist?". Jede Lösung unten beantwortet diese Frage auf andere Weise.

## Minimaler Repro

Das kürzeste Programm, das den Fehler nach dem Wechsel auf den .NET-9+-Loader reproduziert:

```csharp
// .NET 11 preview 4, Windows 11 24H2
using System.Security.Cryptography.X509Certificates;

var bytes = File.ReadAllBytes("signing.pfx");
var cert = X509CertificateLoader.LoadPkcs12(bytes, password: "test");

using var rsa = cert.GetRSAPrivateKey();
var signature = rsa!.SignData("hello"u8.ToArray(), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
```

Aus einer interaktiven Desktop-Sitzung funktioniert das. Führen Sie dieselbe Binärdatei als Windows-Dienst unter `NT SERVICE\MyService` oder aus einem IIS-Anwendungspool mit `LoadUserProfile = false` aus, und `GetRSAPrivateKey()` wirft "Keyset does not exist". Das PFX wurde sauber geladen. Das Zertifikatsobjekt wurde konstruiert. Der Absturz passiert in dem Moment, in dem Sie nach dem privaten Schlüssel greifen.

Der Grund: `X509CertificateLoader.LoadPkcs12` verwendet standardmäßig `X509KeyStorageFlags.DefaultKeySet`, was unter Windows den **Benutzer**-Schlüsselspeicher bedeutet. Eine Dienst-Identität ohne geladenes Benutzerprofil hat kein `%APPDATA%\Microsoft\Crypto\...`, in das geschrieben werden könnte, also wird die Schlüsseldatei an einer temporären, beim nächsten Aufruf unerreichbaren Stelle erzeugt, oder gar nicht erzeugt.

## Lösung 1: der aktuellen Identität Lesezugriff auf den Schlüssel gewähren

Das ist die richtige Lösung, wenn das Zertifikat bereits im Maschinenspeicher installiert ist und Sie den Importcode nicht kontrollieren (typisch für ops-verwaltete Server). Öffnen Sie `certlm.msc` (LocalMachine) oder `certmgr.msc` (CurrentUser), suchen Sie das Zertifikat unter **Eigene Zertifikate > Zertifikate**, Rechtsklick, **Alle Aufgaben > Private Schlüssel verwalten**, und fügen Sie die Prozessidentität mit Berechtigung **Lesen** hinzu.

Dieselbe Operation aus PowerShell, automatisiert für einen IIS-Anwendungspool:

```powershell
# Windows 11 24H2 / Windows Server 2025, PowerShell 7.5
$cert = Get-ChildItem Cert:\LocalMachine\My | Where-Object Thumbprint -eq 'AABBCC...'
$keyFile = $cert.PrivateKey.Key.UniqueName  # CNG

$keyPath = Join-Path $env:ProgramData "Microsoft\Crypto\Keys\$keyFile"
$acl = Get-Acl $keyPath
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    'IIS APPPOOL\MyAppPool', 'Read', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl $keyPath $acl
```

Für CAPI-Zertifikate tauschen Sie `Crypto\Keys` gegen `Crypto\RSA\MachineKeys` und lesen stattdessen `cert.PrivateKey.CspKeyContainerInfo.UniqueKeyContainerName`. Das Cmdlet `Get-PfxCertificate` wirkt hier verlockend, gibt aber nicht das lebende Zertifikat aus dem Speicher zurück; verwenden Sie `Get-ChildItem Cert:\...`, damit die `PrivateKey`-Eigenschaft auf den Container auf der Festplatte zeigt.

Für einen Windows-Dienst unter `NT SERVICE\<DienstName>` ist die SID virtuell, und Sie gewähren sie mit `icacls`:

```powershell
icacls $keyPath /grant "NT SERVICE\MyService:R"
```

Falls unklar ist, unter welcher SID Ihr Prozess läuft, druckt `whoami /user` aus einer als diese Identität gestarteten Eingabeaufforderung sie aus. Für Windows-Dienste in Containern sind `nt authority\system` und `nt authority\network service` die üblichen Verdächtigen.

## Lösung 2: das PFX mit den richtigen Schlüsselspeicher-Flags laden

Das ist die richtige Lösung, wenn Ihre Anwendung die Zertifikatsdatei besitzt und beim Start lädt. Verlassen Sie sich nicht mehr auf `DefaultKeySet`, sondern werden Sie explizit:

```csharp
// .NET 11 preview 4, long-running service that needs the key to survive restarts
var cert = X509CertificateLoader.LoadPkcs12FromFile(
    "signing.pfx",
    password: "test",
    keyStorageFlags: X509KeyStorageFlags.MachineKeySet
                   | X509KeyStorageFlags.PersistKeySet
                   | X509KeyStorageFlags.Exportable);
```

`MachineKeySet` schreibt den Schlüssel nach `%ProgramData%\Microsoft\Crypto\Keys` (CNG) unter eine ACL, die die Dienst-Identität lesen kann. `PersistKeySet` behält die Datei auf der Festplatte, nachdem das `X509Certificate2` verworfen wurde; ohne dieses Flag wird der Schlüssel seit .NET Framework 4.7.2 standardmäßig in dem Moment gelöscht, in dem das Zertifikatsobjekt aus dem Gültigkeitsbereich fällt, was beim **zweiten** Aufruf desselben Codepfads "Keyset does not exist" auslöst. `Exportable` ist optional und nur erforderlich, wenn Sie später `ExportPkcs8PrivateKey` aufrufen oder den Schlüssel in einen anderen Speicher schreiben. Hinweis: `PersistKeySet` und `EphemeralKeySet` schließen sich gegenseitig aus; beide zu übergeben wirft `CryptographicException` aus dem `X509CertificateLoader`.

Für eine gehostete .NET-11-App, in der Sie den Schlüssel nur in-process brauchen und niemals eine Datei auf der Festplatte wollen, verwenden Sie `EphemeralKeySet` und überspringen die Persistenzfrage ganz:

```csharp
// .NET 11 preview 4, ASP.NET Core minimal API loading a cert from configuration
var cert = X509CertificateLoader.LoadPkcs12FromFile(
    path,
    password,
    keyStorageFlags: X509KeyStorageFlags.EphemeralKeySet);
```

`EphemeralKeySet` ist die robusteste Wahl für Container, Scale-to-Zero-Workloads und jede Umgebung, in der das Benutzerprofil fehlen oder recycelt werden kann. Der Schlüssel lebt nur innerhalb der `X509Certificate2`-Instanz; sobald Sie sie verwerfen, ist der Schlüssel weg. Der Kompromiss: Das Zertifikat ist danach nicht mehr in den Windows-Speicher importierbar, und im .NET Framework vor 4.7.2 / .NET Core vor 2.0 existierte das Flag noch nicht. Unter Linux und macOS ist es ein No-op, weil dort gar keine Windows-Schlüsseldatei vorliegt.

## Lösung 3: Eigenheiten von IIS-Anwendungspool- und Windows-Dienst-Identitäten

IIS-Anwendungspools sind die häufigste einzelne Quelle dieses Fehlers. Zwei Einstellungen entscheiden, ob Ihre Suche nach dem privaten Schlüssel funktioniert:

- **Benutzerprofil laden**: Setzen Sie in `applicationHost.config` oder im IIS-Manager unter den **Erweiterten Einstellungen** des Anwendungspools **Benutzerprofil laden** auf `True`. Ohne dies hat die Identität `IIS APPPOOL\MyAppPool` kein `%APPDATA%`, also schlägt jeder Codepfad, der standardmäßig auf `UserKeySet` oder `DefaultKeySet` fällt, beim zweiten Aufruf fehl.
- **Prozessmodell > Identität**: Belassen Sie es bei `ApplicationPoolIdentity` und gewähren Sie der virtuellen SID `IIS APPPOOL\MyAppPool` Lesezugriff auf die Schlüsseldatei (Lösung 1). Lassen Sie Anwendungspools nicht als `LocalSystem` laufen, um dies zu "umgehen"; das ist eine echte Privilegienerhöhung, keine Lösung.

Für Windows-Dienste, die mit der [.NET-11-Vorlage für gehostete Dienste](/de/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) plus `Microsoft.Extensions.Hosting.WindowsServices` geschrieben sind, ist das Pendant, den Dienst mit seinem eigenen virtuellen Konto zu registrieren:

```powershell
sc.exe create MyService binPath= "C:\svc\MyService.exe" obj= "NT SERVICE\MyService" start= auto
icacls "C:\ProgramData\Microsoft\Crypto\Keys\<keyfile>" /grant "NT SERVICE\MyService:R"
```

Vermeiden Sie es, Dienste unter `LocalSystem` zu betreiben, aus demselben Grund wie bei Anwendungspools: Sie gewähren versehentlich auch Lesezugriff auf jeden anderen Maschinen-Schlüssel auf dem Host. Das Prinzip der minimalen Berechtigung gilt für Krypto-Container ebenso wie für Dateipfade.

## Lösung 4: Azure App Service, Azure Functions, Container

Cloud-Hosts treffen eine schärfere Variante dieses Problems, weil das zugrunde liegende Dateisystem nicht Ihres ist. Drei plattformspezifische Stellschrauben:

- **Azure App Service**: Laden Sie das PFX/PEM unter **TLS/SSL settings > Private Key Certificates** hoch, setzen Sie dann die Anwendungseinstellung `WEBSITE_LOAD_CERTIFICATES` auf entweder `*` oder den Thumbprint des Zertifikats. Die App-Service-Sandbox weigert sich, den privaten Schlüssel zu laden, sofern diese Variable den Thumbprint nicht freischaltet; andernfalls erhalten Sie "Keyset does not exist" im Moment, in dem Sie `GetRSAPrivateKey()` aufrufen. Die Einstellung `WEBSITE_LOAD_USER_PROFILE = 1` ist das App-Service-Äquivalent von **Benutzerprofil laden** in IIS und wird benötigt, wenn Ihr Codepfad auf Benutzerschlüssel auflöst.
- **Azure Functions (Windows Consumption / Premium)**: Dieselbe `WEBSITE_LOAD_CERTIFICATES`-Anforderung. Für Isolated-Worker-Functions laden Sie das Zertifikat lieber aus `cert:\CurrentUser\My`, statt ein PFX aus `D:\home\site\wwwroot` zu lesen, weil der PFX-Pfad nur lesbar ist und `PersistKeySet` still scheitern wird.
- **Linux-Container (einschließlich Linux-App-Service-Pläne und AKS)**: Es gibt keine Windows-Schlüsseldatei, also werden `X509KeyStorageFlags` außer `EphemeralKeySet` effektiv ignoriert. Der Fehler, den Sie in `dotnet publish`-Images sehen, ist nicht "Keyset does not exist", sondern `PlatformNotSupportedException`, wenn Sie zu `CspParameters` oder dem `PrivateKey = ...`-Setter greifen. Verwenden Sie die moderne `CopyWithPrivateKey`-API und `EphemeralKeySet`, und der Code wird portierbar.

Für [.NET-11-AWS-Lambda-Funktionen](/de/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) gilt dieselbe Logik wie für Linux-Container: Es gibt keinen Windows-Schlüsselspeicher, laden Sie das PFX mit `EphemeralKeySet` aus einer Lambda-Layer oder dem Secrets Manager, niemals aus `/tmp` zwischen Aufrufen, denn die Sandbox garantiert nicht, dass `/tmp` Kaltstarts überdauert.

## Lösung 5: den Schlüssel mit der modernen API lesen, nicht mit `PrivateKey`

Die Eigenschaft `X509Certificate2.PrivateKey` existiert in .NET 11 noch, ist aber veraltet (`SYSLIB0028` für den Setter, `SYSLIB0058` für den Getter bei EC-Schlüsseln). Sie liefert ein `AsymmetricAlgorithm`, das intern CAPI aufruft, selbst wenn das Zertifikat als CNG importiert wurde, und die CAPI-Shim-Schicht ist diejenige, die am zuverlässigsten "Keyset does not exist" wirft, wenn der Schlüsselcontainer fehlt. Die modernen Zugriffsmethoden prüfen vorab und legen klarere Ausnahmen offen:

```csharp
// .NET 11 preview 4
using var rsa = cert.GetRSAPrivateKey();
using var ecdsa = cert.GetECDsaPrivateKey();
using var dsa = cert.GetDSAPrivateKey();
```

Wenn `HasPrivateKey` `true` ist, aber `GetRSAPrivateKey()` `null` zurückgibt, verwendet das Zertifikat einen Nicht-RSA-Algorithmus; versuchen Sie stattdessen `GetECDsaPrivateKey()`. Wenn `GetRSAPrivateKey()` "Keyset does not exist" wirft, behaupten die Metadaten, dass ein Schlüssel existiert, die Datei tut es nicht, und eine der Lösungen 1 bis 4 trifft zu.

## Fallstricke und Verwechslungsfehler

- **`X509CertificateLoader` ist in .NET 11 nicht optional.** Der alte Konstruktor `new X509Certificate2(path, password)` ist mit `SYSLIB0057` markiert und wird in einer zukünftigen Version entfernt. Migrieren Sie jetzt und überprüfen Sie Ihre `X509KeyStorageFlags`-Wahl, weil die Loader-Vorgaben strenger sind.
- **`HasPrivateKey` lügt.** Es prüft die `keyUsage`-Erweiterung des Zertifikats und die Anwesenheit eines `CERT_KEY_PROV_INFO_PROP_ID`, nicht ob sich die Datei unter `Crypto\Keys` sauber öffnen lässt. Testen Sie, indem Sie den Schlüssel tatsächlich abrufen, fangen Sie `CryptographicException` und behandeln Sie es als "kein Schlüssel", anstatt anhand von `HasPrivateKey` zu verzweigen.
- **"Access is denied" ist der verwandte Fehler.** Dieselbe Grundursache (fehlende ACL), anderer Codepfad: Legacy-CAPI gibt `NTE_BAD_KEYSET` zurück, modernes CNG manchmal `0x80090010 NTE_PERM`, was als `CryptographicException: Access is denied` erscheint. Die Lösung ist identisch; der Suchtreffer ist ein anderer.
- **Das PFX ist in Ordnung; die Speicherreferenz ist veraltet.** Wenn Sie ein PFX importiert, aus `Cert:\LocalMachine\My` gelöscht und neu importiert haben, kann der Schlüsseldateipfad in den Zertifikatsmetadaten auf den alten (gelöschten) Container zeigen. Exportieren, vollständig löschen (mit `Remove-Item Cert:\LocalMachine\My\<thumbprint>` plus `certutil -delstore`) und neu importieren.
- **`SqlClient` und `X509Chain.Build()` werfen dieselbe Ausnahme.** Beide rufen unter der Haube `GetRSAPrivateKey()` auf, wenn sie Ketten validieren oder Verbindungszeichenfolgen signieren. Eine SQL-Verbindung, die mit dieser Meldung an der Zertifikatsauthentifizierung scheitert, ist derselbe Bug wie ein JWT-Signierer, der daran scheitert; der [Fehlermodus `SqlException: Timeout expired`](/de/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/) hat damit nichts zu tun.
- **CryptoAPI- vs. CNG-Diskrepanzen.** Ein CAPI-generiertes PFX über CNG zu importieren (oder umgekehrt) lässt den Schlüssel manchmal in einem Anbieter, während die Metadaten auf den anderen verweisen. `certutil -repairstore My <thumbprint>` baut die Verknüpfung ohne erneuten Import wieder auf.
- **Das Benutzerprofil ist nicht geladen.** Geplante Aufgaben, IIS-Anwendungspools ohne `LoadUserProfile` und Windows-Docker-Container, die als `ContainerUser` laufen, teilen dieses Merkmal. Entweder schalten Sie die Profileinstellung ein, wechseln auf Maschinenschlüssel oder verwenden `EphemeralKeySet`.

## Verwandt

- [Fix: System.IO.FileNotFoundException: Could not load file or assembly](/de/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) deckt die andere Hälfte der "Auf meiner Maschine läuft es"-Bereitstellungsfehler ab, bei denen das Problem die Binärdatei statt der Schlüssel ist.
- [Fix: PlatformNotSupportedException in Native AOT](/de/2026/05/fix-platformnotsupportedexception-in-native-aot/) erscheint, wenn Sie eine Native-AOT-App veröffentlichen und direkt `new RSACryptoServiceProvider()` aufrufen; der AOT-Compiler entfernt den CAPI-Shim vollständig.
- [Wie man Refresh-Tokens in ASP.NET Core Identity implementiert](/de/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) zeigt die umgebende Verdrahtung für den häufigsten Grund, einen privaten Schlüssel zu laden: das Signieren von JWTs in einem gehosteten Identitätsanbieter.
- [Wie man die Kaltstartzeit eines .NET-11-AWS-Lambda reduziert](/de/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) bespricht das Laden von Zertifikaten in serverlosen Umgebungen, wo `EphemeralKeySet` das einzige Schlüsselspeicher-Flag ist, das das Richtige tut.
- [Wie man strukturierte Protokollierung mit Serilog und Seq in .NET 11 einrichtet](/de/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) hilft beim Nachverfolgen des genauen Moments, in dem der Schlüsselzugriff in einem Produktionsdienst scheitert, da `X509Certificate2`-Operationen standardmäßig nichts loggen.

## Quellen

- [`X509KeyStorageFlags` Enum, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.x509keystorageflags)
- [`X509CertificateLoader` class, .NET 9+, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.x509certificateloader)
- [`SYSLIB0057`: Obsolete X509Certificate2 PFX constructors](https://learn.microsoft.com/en-us/dotnet/fundamentals/syslib-diagnostics/syslib0057)
- [Private Key Lifetime on Windows, January 2021 .NET Framework rollup, Microsoft Support](https://support.microsoft.com/en-us/topic/private-key-lifetime-on-windows-and-the-january-2021-net-framework-security-and-quality-rollup-3f097a10-f798-4ffd-8511-4757ebaf2c70)
- [`dotnet/runtime` issue 67752: occasional "Keyset does not exist" with `GetRSAPrivateKey` on Windows](https://github.com/dotnet/runtime/issues/67752)
- [`dotnet/aspnetcore` issue 3218: Data Protection "Keyset does not exist" even with PrivateKey set programmatically](https://github.com/dotnet/aspnetcore/issues/3218)
- [Load certificates in Azure App Service, MS Learn](https://learn.microsoft.com/en-us/azure/app-service/configure-ssl-certificate-in-code)

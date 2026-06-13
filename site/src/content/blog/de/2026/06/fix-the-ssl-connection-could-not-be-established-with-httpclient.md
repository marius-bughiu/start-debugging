---
title: "Fix: The SSL connection could not be established mit HttpClient"
description: "Die innere AuthenticationException nennt die wahre Ursache: eine nicht vertrauenswürdige Kette, ein abweichender Name oder eine TLS-Versionslücke. Vertrauen Sie dem Zertifikat, korrigieren Sie den Host oder gleichen Sie die Protokolle ab. Deaktivieren Sie die Validierung nicht pauschal."
pubDate: 2026-06-13
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "httpclient"
lang: "de"
translationOf: "2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient"
translatedBy: "claude"
translationDate: 2026-06-13
---

`HttpRequestException: The SSL connection could not be established, see inner exception` bedeutet fast nie das, was die äußere Meldung sagt. Der TLS-Handshake ist fehlgeschlagen, und die wahre Ursache steht in der `InnerException`: eine nicht vertrauenswürdige Zertifikatskette (`RemoteCertificateChainErrors`), ein Host, der nicht zum Zertifikat passt (`RemoteCertificateNameMismatch`), oder eine Protokolldiskrepanz. Lesen Sie zuerst die innere Exception, dann korrigieren Sie die Kette, den Host oder die TLS-Version. Greifen Sie in der Produktion nicht zu `ServerCertificateCustomValidationCallback => true`: das deaktiviert den Schutz, für den der Handshake existiert.

Das gilt für `HttpClient` in .NET 11 (`.NET 11`), aber dieselbe `SslStream`-Maschinerie und dieselbe Diagnose reichen bis .NET Core 3.1 zurück.

## Der Fehler im Kontext

Die äußere Exception ist generisch. Die Zeile, die zählt, ist die innere:

```
System.Net.Http.HttpRequestException: The SSL connection could not be established, see inner exception.
 ---> System.Security.Authentication.AuthenticationException: The remote certificate is invalid according to the validation procedure: RemoteCertificateChainErrors, RemoteCertificateNameMismatch
   at System.Net.Security.SslStream.SendAuthResetSignal(...)
   at System.Net.Http.ConnectHelper.EstablishSslConnectionAsync(...)
   at System.Net.Http.HttpConnectionPool.ConnectAsync(...)
```

In .NET 8 und neueren Versionen müssen Sie die innere Exception nicht einmal von Hand aufbrechen. `HttpRequestException` trägt ein `HttpRequestError`-Enum, und ein Handshake-Fehler erscheint als `HttpRequestError.SecureConnectionError`:

```csharp
// .NET 11, C# 14
try
{
    using var response = await client.GetAsync("https://api.example.com");
}
catch (HttpRequestException ex) when (ex.HttpRequestError == HttpRequestError.SecureConnectionError)
{
    // TLS handshake failed. Inspect ex.InnerException for the AuthenticationException.
    Console.WriteLine(ex.InnerException?.Message);
}
```

Die Zeichenfolge nach "according to the validation procedure:" ist die gesamte Diagnose. Es ist eine durch Kommas getrennte Liste von `SslPolicyErrors`-Flags, und jedes verweist auf einen anderen Fix.

## Warum das passiert

Der Handshake schlägt aus einem von drei Gründen fehl, und die innere Meldung nennt, welcher:

- **`RemoteCertificateChainErrors`**: Das Zertifikat des Servers ist echt, aber Ihre Maschine vertraut der Kette nicht, die es signiert hat. Selbstsignierte Zertifikate, eine interne Unternehmens-CA, die nicht im Vertrauensspeicher ist, ein abgelaufenes Blatt- oder Zwischenzertifikat oder ein Server, der vergessen hat, sein Zwischenzertifikat zu senden, landen alle hier.
- **`RemoteCertificateNameMismatch`**: Das Zertifikat ist vertrauenswürdig, aber der Name darauf passt nicht zum Host, mit dem Sie sich verbunden haben. Sie haben `https://10.0.0.5` aufgerufen, aber das Zertifikat ist für `api.internal` ausgestellt, oder Sie haben `https://localhost` gegen ein Zertifikat für `127.0.0.1` aufgerufen.
- **`RemoteCertificateNotAvailable`**: Der Server hat überhaupt kein Zertifikat vorgelegt, was normalerweise bedeutet, dass Sie TLS mit einem Port sprechen, der eigentlich kein TLS bedient.

Eine vierte Klasse erzeugt überhaupt keine `SslPolicyErrors`. Wenn die innere Exception eine `Win32Exception` ("The client and server cannot communicate, because they do not possess a common algorithm") oder ein knappes "The SSL connection could not be established" ohne Richtlinienliste ist, konnten sich die beiden Seiten nicht auf eine TLS-Version oder eine Cipher Suite einigen. Seit .NET 5 ist der Client-Standardwert `SslProtocols.None`, was bedeutet "lass das Betriebssystem das Beste verfügbare wählen", und auf einem aktuellen Betriebssystem verhandelt das TLS 1.3 oder TLS 1.2. Ein Server, der auf TLS 1.0/1.1 feststeckt, oder einer, dessen einzige Cipher Suites Ihr Betriebssystem deaktiviert hat, fällt in diese Kategorie.

## Minimale Reproduktion

Das kleinste Programm, das den Kettenfehler reproduziert, richtet `HttpClient` auf einen Host mit einem selbstsignierten oder anderweitig nicht vertrauenswürdigen Zertifikat:

```csharp
// .NET 11, C# 14
using var client = new HttpClient();

// A host whose cert chains to a CA this machine does not trust.
using var response = await client.GetAsync("https://self-signed.badssl.com/");
response.EnsureSuccessStatusCode();
```

Führen Sie es aus und Sie erhalten die `RemoteCertificateChainErrors`-Form. Tauschen Sie die URL gegen `https://wrong.host.badssl.com/` und Sie erhalten stattdessen `RemoteCertificateNameMismatch`. Diese beiden öffentlichen Endpunkte sind der schnellste Weg, um zu bestätigen, dass Ihr Behandlungscode korrekt verzweigt, ohne Ihren eigenen kaputten Server aufzusetzen.

## Der Fix im Detail

Wählen Sie den Fix, der zur inneren Exception passt. Sie sind von "in der Produktion korrekt" bis "nur für die Entwicklung" geordnet.

### 1. Kettenfehler: vertrauen Sie dem Zertifikat, umgehen Sie nicht die Validierung

Wenn die innere Meldung `RemoteCertificateChainErrors` lautet, besteht der richtige Fix darin, die Kette vertrauenswürdig zu machen, nicht aufzuhören, sie zu prüfen.

Für eine interne Unternehmens-CA installieren Sie das Stammzertifikat der CA im Vertrauensspeicher der Maschine. Unter Linux bedeutet das, das PEM in das Vertrauensbündel des Betriebssystems abzulegen, weil .NET unter Linux den OpenSSL-Vertrauensspeicher liest, nicht einen .NET-spezifischen:

```bash
# Ubuntu/Debian: install a corporate root CA so .NET trusts it
sudo cp corp-root-ca.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates
```

Unter Windows importieren Sie das Stammzertifikat in `Cert:\LocalMachine\Root`. Danach validiert `HttpClient` die Kette ohne Codeänderungen, weil die Validierung den Betriebssystemspeicher liest.

Wenn Sie den Maschinenspeicher nicht anfassen können (abgeschottete Hosts, kurzlebige Container), pinnen Sie das spezifische Zertifikat, das Sie erwarten, statt allem zu vertrauen. Das hält die Validierung für jeden anderen Server aktiv, während genau ein bekanntes Zertifikat akzeptiert wird:

```csharp
// .NET 11, C# 14
// Pin the expected leaf/intermediate by thumbprint. Real validation stays on
// for chains we did not explicitly pin.
var expectedThumbprint = "A1B2C3...";

var handler = new SocketsHttpHandler
{
    SslOptions = new SslClientAuthenticationOptions
    {
        RemoteCertificateValidationCallback = (sender, cert, chain, errors) =>
        {
            if (errors == SslPolicyErrors.None) return true;
            return cert is not null
                && cert.GetCertHashString().Equals(expectedThumbprint, StringComparison.OrdinalIgnoreCase);
        }
    }
};

using var client = new HttpClient(handler);
```

Beachten Sie die Form: Der Callback gibt `true` für Ketten zurück, die bereits bestehen (`SslPolicyErrors.None`), und akzeptiert ansonsten nur das eine Zertifikat, das Sie gepinnt haben. Das ist der Unterschied zwischen Zertifikat-Pinning und dem Abschalten der Validierung.

### 2. Namensabweichung: korrigieren Sie die URL oder das Zertifikat

`RemoteCertificateNameMismatch` bedeutet, dass Sie sich mit einem Namen verbunden haben, für den das Zertifikat nicht ausgestellt wurde. Der Fix besteht fast immer darin, den richtigen Host in der URL zu verwenden, den, der in der Subject-Alternative-Name-Liste des Zertifikats erscheint. Die Verbindung über eine IP-Adresse ist der klassische Auslöser, weil Zertifikate für DNS-Namen ausgestellt werden, nicht für IPs.

Wenn die URL korrekt ist und das Zertifikat einfach falsch ist (eine echte Fehlkonfiguration auf einem Server, den Sie kontrollieren), stellen Sie das Zertifikat mit den korrekten SAN-Einträgen neu aus. Wenn Sie wirklich über eine Adresse verbinden müssen, die vom Zertifikatsnamen abweicht, setzen Sie den TLS-SNI-Host explizit, damit der ausgehandelte Name zum Zertifikat passt, anstatt die Namensprüfung zu deaktivieren:

```csharp
// .NET 11, C# 14
var handler = new SocketsHttpHandler
{
    SslOptions = new SslClientAuthenticationOptions
    {
        // Present this name in the TLS handshake even though the URL uses an IP.
        TargetHost = "api.internal"
    }
};
using var client = new HttpClient(handler);
```

### 3. Protokoll- oder Cipher-Lücke: gleichen Sie die TLS-Versionen ab

Wenn keine Richtlinienfehlerliste vorliegt und der Handshake einfach fehlschlägt, konnten sich die beiden Enden nicht auf ein Protokoll einigen. Lassen Sie den Client auf `SslProtocols.None` (dem vom Betriebssystem ausgehandelten Standard) und korrigieren Sie den Server, damit er TLS 1.2 oder 1.3 anbietet. Den Client auf TLS 1.0/1.1 herunterzuzwingen, um zu einem Legacy-Server zu passen, ist ein letztes Mittel, und auf einem modernen Betriebssystem sind diese Protokolle ohnehin oft auf Betriebssystemebene deaktiviert, sodass die explizite Einstellung still und leise nichts bewirkt. Wenn es sein muss, sieht es so aus:

```csharp
// .NET 11, C# 14 - last resort for a legacy server you cannot upgrade
var handler = new SocketsHttpHandler
{
    SslOptions = new SslClientAuthenticationOptions
    {
        EnabledSslProtocols = System.Security.Authentication.SslProtocols.Tls12
    }
};
```

### 4. Lokales HTTPS: vertrauen Sie dem ASP.NET Core Entwicklungszertifikat

Wenn Sie darauf stoßen, während Sie Ihren eigenen Dienst über `https://localhost` während der Entwicklung aufrufen, besteht der Fix darin, dem lokalen Entwicklungszertifikat einmal zu vertrauen:

```bash
dotnet dev-certs https --trust
```

Das ist der korrekte lokale Fix. Er schwächt die Validierung nicht, weil er ein echtes vertrauenswürdiges Zertifikat für `localhost` installiert, anstatt dem Client zu sagen, die Prüfung zu überspringen.

## Fallstricke und Varianten

**`ServerCertificateCustomValidationCallback => true` ist kein Fix.** Es ist die bestbewertete StackOverflow-Antwort und außerhalb eines Wegwerf-Tests falsch. Bedingungsloses Zurückgeben von `true` akzeptiert jedes Zertifikat von jedem, was HTTPS in Klartext-mit-Extraschritten verwandelt und genau das Man-in-the-Middle-Loch wieder öffnet, das TLS verhindert. Wenn Sie es nutzen, um eine Demo zu entsperren, grenzen Sie es so ein, dass es niemals ausgeliefert werden kann: schützen Sie es mit `if (env.IsDevelopment())` und prüfen Sie, dass es in der Produktion aus ist. Der Pinning-Callback aus Fix 1 ist das, was Sie wollen, wenn Sie ein bestimmtes nicht-öffentliches Zertifikat tatsächlich akzeptieren müssen.

**Funktioniert in Postman oder curl, schlägt aber in .NET fehl.** Diese Werkzeuge und .NET lesen unterschiedliche Vertrauensspeicher. curl unter Linux nutzt das OpenSSL-Bündel (das .NET ebenfalls liest), aber Postman bringt seine eigene CA-Liste mit und Windows-Werkzeuge lesen den Windows-Speicher. Eine CA, der eines vertraut, ist nicht automatisch für die anderen vertrauenswürdig. Installieren Sie das Stammzertifikat in den Speicher, den .NET für Ihr Betriebssystem tatsächlich liest.

**Funktioniert unter Windows, schlägt in einem Linux-Container fehl.** Dieselbe Grundursache. Die Unternehmens-Stamm-CA ist im Windows-Vertrauensspeicher des Entwicklers, wurde aber nie zum Container-Image hinzugefügt. Fügen Sie die CA in Ihrem Dockerfile mit `update-ca-certificates` hinzu, bevor die Anwendung läuft, oder mounten Sie sie ein.

**Der Server hat sein Zwischenzertifikat vergessen.** Ein Server kann mit einem gültigen Blattzertifikat konfiguriert sein, aber daran scheitern, das Zwischenzertifikat zu senden, das es zu einem vertrauenswürdigen Stamm verkettet. Browser kaschieren das oft, indem sie Zwischenzertifikate aus früheren Sitzungen cachen; .NET nicht. Der Fix gehört auf den Server: konfigurieren Sie ihn, die vollständige Kette zu senden. Sie können das mit `openssl s_client -connect host:443 -showcerts` bestätigen, indem Sie die zurückgegebenen Zertifikate zählen.

**`AuthenticationException` mit `RemoteCertificateNotAvailable`.** Der Server hat kein Zertifikat gesendet. Sie zeigen mit ziemlicher Sicherheit auf einen reinen HTTP-Port mit einem `https://`-Schema oder auf einen Dienst, der noch nicht läuft. Prüfen Sie den Port und das Schema, bevor Sie irgendwelchen TLS-Code anfassen.

**Verwechseln Sie das nicht mit `TaskCanceledException`.** Ein Handshake, der hängt und dann `HttpClient.Timeout` auslöst, erscheint als Abbruch, nicht als TLS-Fehler. Wenn Ihr Symptom ein Timeout statt einer Validierungsmeldung ist, sind Ursache und Fix unterschiedlich.

## Verwandte Lektüre

- [Fix: TaskCanceledException: A task was canceled in HttpClient](/de/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) behandelt die timeout-förmigen Fehler, die oberflächlich einem langsamen Handshake ähneln, aber eine völlig andere Grundursache haben.
- [HttpClient vs HttpClientFactory vs Refit](/de/2026/05/httpclient-vs-httpclientfactory-vs-refit/) erklärt, wo Sie einen benutzerdefinierten `SocketsHttpHandler` konfigurieren, damit Ihre TLS-Einstellungen die Wiederverwendung des Clients überleben.
- [Wie man Code testet, der HttpClient verwendet](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/) zeigt, wie man den Transport faked, damit Sie die obigen Fehlerzweige ausüben können, ohne einen kaputten Server live zu betreiben.
- [Wie man einen globalen Exception-Filter in ASP.NET Core 11 hinzufügt](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) hilft Ihnen, diese Exception mit intakter innerer Meldung zu zeigen, statt als nacktes 500.

## Quellen

- [`SslPolicyErrors`-Enum](https://learn.microsoft.com/en-us/dotnet/api/system.net.security.sslpolicyerrors), Microsoft Learn: die Flags (`RemoteCertificateChainErrors`, `RemoteCertificateNameMismatch`, `RemoteCertificateNotAvailable`), die in der inneren Meldung erscheinen.
- [`HttpRequestError`-Enum](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httprequesterror), Microsoft Learn: der `SecureConnectionError`-Wert, der den Fehler in .NET 8+ klassifiziert.
- [`SslClientAuthenticationOptions`](https://learn.microsoft.com/en-us/dotnet/api/system.net.security.sslclientauthenticationoptions), Microsoft Learn: `TargetHost`, `EnabledSslProtocols` und `RemoteCertificateValidationCallback` auf `SocketsHttpHandler`.
- [Enforce TLS in .NET](https://learn.microsoft.com/en-us/dotnet/framework/network-programming/tls), Microsoft Learn: warum `SslProtocols.None` (vom Betriebssystem ausgehandelt) der empfohlene Standard ist.
- [dotnet/runtime #32498: The SSL connection could not be established](https://github.com/dotnet/runtime/issues/32498): Berichte aus der Praxis und die Vertrauensspeicher-Diagnose.

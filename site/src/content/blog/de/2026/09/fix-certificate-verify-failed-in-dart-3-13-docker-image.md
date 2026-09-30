---
title: "Fix: CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate in einem Dart-3.13-Docker-Image"
description: "Dart 3.13 hat die eingebauten Fallback-Stammzertifikate der VM entfernt. Legen Sie ein CA-Bundle in das Runtime-Image: COPY /runtime/ aus dart:stable oder ca-certificates installieren."
pubDate: 2026-09-30
template: error-page
tags:
  - "errors"
  - "dart"
  - "docker"
  - "tls"
  - "dart-3-13"
lang: "de"
translationOf: "2026/09/fix-certificate-verify-failed-in-dart-3-13-docker-image"
translatedBy: "claude"
translationDate: 2026-09-30
---

Ihr Dockerfile hat sich nicht geändert. Dart schon. Ab Dart 3.13.0 (dem SDK in Flutter 3.47.0 und dem SDK hinter dem Tag `dart:stable` seit August 2026, aktuell 3.13.5) liefert die eigenständige VM keinen einkompilierten Fallback-Satz an Stammzertifikaten mehr mit. Enthält das Image, in dem Ihre App läuft, an keinem der Standardpfade unter Linux ein CA-Bundle, scheitert jetzt bei jedem HTTPS-Aufruf der Handshake. Die Lösung: Geben Sie der Runtime-Stage einen Trust Store. Behalten Sie `COPY --from=build /runtime/ /` in einer `FROM scratch`-Stage bei, oder führen Sie in einem schlanken Basis-Image `apt-get install ca-certificates` aus. Wenn Sie das Image nicht ändern können, verweisen Sie die VM mit `DART_VM_OPTIONS=--root-certs-file=/path/to/cacert.pem` auf eine PEM-Datei.

Alles Folgende beruht auf dem Dart-SDK-Quellcode an den Tags `3.12.2`, `3.13.0` und `3.13.5`, dem `stable/trixie`-Dockerfile in `dart-lang/dart-docker` und der Analyse von [dart-lang/sdk#64060](https://github.com/dart-lang/sdk/issues/64060), in der das Dart-Team bestätigt hat, dass das Verhalten beabsichtigt ist.

## Der Fehler im Kontext

Die App lässt sich problemlos kompilieren und starten. Die erste ausgehende TLS-Verbindung wirft einen Fehler, egal ob sie über `HttpClient`, `package:http`, `dio`, einen gRPC-Kanal oder einen Datenbanktreiber läuft:

```text
HandshakeException: Handshake error in client (OS Error:
	CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate(handshake.cc:320))

#0      _SecureFilterImpl._handshake (dart:io-patch/secure_socket_patch.dart:101)
#1      _SecureFilterImpl.handshake (dart:io-patch/secure_socket_patch.dart:146)
#2      _RawSecureSocket._secureHandshake (dart:io/secure_socket.dart:995)
#3      _RawSecureSocket._tryFilter (dart:io/secure_socket.dart:1127)
<asynchronous suspension>
```

Verräterisch ist der Zeitpunkt. Derselbe Code, dasselbe Dockerfile und derselbe Endpunkt funktionierten mit `dart:3.12.2`. Setzt man die Build-Stage auf `dart:3.12.2` zurück, verschwindet der Fehler. Genau das tat der Melder von #64060, bevor er die Ursache fand. Endpunkte mit völlig gültigen öffentlichen Zertifikaten (pub.dev, googleapis.com, Ihre eigene Let's-Encrypt-API) scheitern genauso wie selbstsignierte, denn das Problem liegt nicht in der Zertifikatskette des Servers. Der Client vertraut schlicht überhaupt nichts.

## Warum Dart 3.13 in einem leeren Image nichts mehr vertraut

Unter Linux sucht `SSLCertContext::TrustBuiltinRoots()` in `runtime/bin/security_context_linux.cc` in fester Reihenfolge nach vertrauenswürdigen Stammzertifikaten:

1. Die Option `--root-certs-file` oder `--root-certs-cache`, falls Sie eine übergeben haben.
2. Die erste vorhandene Bundle-Datei aus `/etc/ssl/certs/ca-certificates.crt`, `/etc/pki/tls/certs/ca-bundle.crt`, `/etc/ssl/ca-bundle.pem`, `/etc/pki/tls/cacert.pem` und `/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem`.
3. Das erste vorhandene Verzeichnis aus `/etc/ssl/certs`, `/system/etc/security/cacerts`, `/usr/local/share/certs`, `/etc/pki/tls/certs` und `/etc/openssl/certs`.
4. Als letzter Ausweg `AddCompiledInCerts()`, das ein Mozilla-Root-Bundle lädt, das in die Binärdateien `dart` und `dartaotruntime` eingebacken ist (und damit in jede Ausgabe von `dart compile exe`).

Schritt 4 hat sich geändert. Das Changelog von Dart 3.13.0 sagt es in einer Zeile unter "Dart Runtime": Die eingebauten Fallback-Stammzertifikate "are no longer included". Der SDK-Commit ist [`7e5b075680`](https://github.com/dart-lang/sdk/commit/7e5b075680), "Reland [standalone] Remove the fallback root certificates", am 2026-06-01 eingespielt, nachdem ein erster Versuch im Mai zurückgenommen worden war. Die Funktion existiert in 3.13 weiterhin, aber `runtime/bin/BUILD.gn` bindet `third_party/fallback_root_certificates` nicht mehr ein und definiert bedingungslos `DART_IO_ROOT_CERTS_DISABLED`. Dadurch ist `root_certificates_pem` null, und die Funktion kehrt zurück, ohne etwas hinzuzufügen.

Jahrelang sprang dieser Fallback stillschweigend für Runtime-Images ohne CA-Bundle ein. Eine `FROM scratch`-Stage, die nur die kompilierte Binärdatei kopierte, funktionierte, weil die Binärdatei ihre eigenen Stammzertifikate mitbrachte. Eine `debian:trixie-slim`-Basis ohne `ca-certificates` funktionierte aus demselben Grund. In 3.13 landen diese Images bei einem leeren `X509_STORE`, und BoringSSL meldet für das erste Zertifikat jeder Kette einen unbekannten Aussteller.

Zwei Details machen die Sache verwirrender, als sie sein müsste:

- **Das Image `dart:stable` selbst ist in Ordnung.** Sein Dockerfile installiert `ca-certificates`, und das Verzeichnis `/runtime/`, das es für Multi-Stage-Builds vorbereitet, enthält `/etc/ssl/certs` und `/usr/share/ca-certificates`, kopiert mit `--dereference`, damit die Symlinks erhalten bleiben. Wenn der Fehler auftritt, läuft der fehlschlagende Prozess fast immer in einem *anderen* Image als dem, mit dem Sie gebaut haben. In #64060 verwendete der Build `dart:3.13.0`, der Pod lief aber auf einem fünf Jahre alten Image `docker:19.03.15` / `ubuntu:xenial`.
- **Ein leeres Verzeichnis `/etc/ssl/certs` ist schlimmer als ein fehlendes.** Schritt 3 prüft nur, ob das Verzeichnis existiert, nicht ob es etwas enthält. Manche Basis-Images liefern das Verzeichnis ohne die Zertifikate aus, sodass die VM daraus bereitwillig null Stammzertifikate "lädt".

## Minimales Reproduktionsbeispiel

Ein Dart-Programm, das eine einzige HTTPS-Anfrage stellt:

```dart
// Dart 3.13.5, bin/server.dart
import 'dart:io';

Future<void> main() async {
  final client = HttpClient();
  try {
    final request = await client.getUrl(Uri.parse('https://pub.dev/api/packages/http'));
    final response = await request.close();
    print('status: ${response.statusCode}');
    await response.drain<void>();
  } finally {
    client.close();
  }
}
```

Dazu ein Multi-Stage-Dockerfile, das nur die ausführbare Datei in die letzte Stage kopiert. Diese Form ist in handgeschriebenen Dockerfiles und in CI-Vorlagen, die älter sind als die offizielle, weit verbreitet:

```dockerfile
# Dart 3.13.5 (dart:stable, September 2026)
FROM dart:stable AS build
WORKDIR /app
COPY pubspec.* ./
RUN dart pub get
COPY . .
RUN dart compile exe bin/server.dart -o bin/server

FROM debian:trixie-slim
COPY --from=build /app/bin/server /app/bin/server
CMD ["/app/bin/server"]
```

Mit `dart:3.12.2` gebaut, gibt dies dank der einkompilierten Stammzertifikate `status: 200` aus. Mit `dart:3.13.0` oder neuer gebaut, wirft es die oben gezeigte `HandshakeException`, weil `debian:trixie-slim` das Paket `ca-certificates` nicht enthält.

## Die Lösung im Detail

Wählen Sie die erste Option, die zu Ihrem Image passt. Alle geben der VM einen echten Trust Store, keine schaltet die Überprüfung ab.

### 1. Die offizielle `/runtime/`-Kopie in einer `FROM scratch`-Stage beibehalten

Dies ist das Layout, das die [Dokumentation des offiziellen `dart`-Images](https://hub.docker.com/_/dart) empfiehlt, und es bringt die Zertifikate bereits mit:

```dockerfile
# Dart 3.13.5 (dart:stable)
FROM dart:stable AS build
WORKDIR /app
COPY pubspec.* ./
RUN dart pub get
COPY . .
RUN dart compile exe bin/server.dart -o bin/server

FROM scratch
COPY --from=build /runtime/ /
COPY --from=build /app/bin/server /app/bin/
CMD ["/app/bin/server"]
```

Ist Ihre letzte Stage `FROM scratch` und das einzige `COPY` die Binärdatei, fügen Sie die Zeile für `/runtime/` hinzu. Neben den Zertifikaten bringt sie auch den glibc-Loader, `libnss_dns` und `/etc/nsswitch.conf` mit, behebt also auch DNS-Auflösungsprobleme, auf die Sie vielleicht noch gar nicht gestoßen sind.

### 2. `ca-certificates` in einem schlanken Runtime-Image installieren

Wenn Sie auf `debian:*-slim` oder `ubuntu:*` laufen, installieren Sie das Paket in der letzten Stage:

```dockerfile
# Dart 3.13.5 AOT binary on debian:trixie-slim
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/bin/server /app/bin/server
CMD ["/app/bin/server"]
```

Das Post-Install-Skript des Pakets erzeugt `/etc/ssl/certs/ca-certificates.crt`, den ersten Pfad, den die VM prüft. Einen separaten Aufruf von `update-ca-certificates` brauchen Sie nur, wenn Sie eigene Zertifikate hinzufügen (siehe unten). Auf RHEL-, UBI- oder Fedora-Images heißt das entsprechende Paket ebenfalls `ca-certificates`, und es erzeugt `/etc/pki/tls/certs/ca-bundle.crt`, das ebenfalls auf der Liste steht.

Auch Distroless funktioniert: `gcr.io/distroless/cc-debian12` liefert `/etc/ssl/certs/ca-certificates.crt` und die glibc, die eine Dart-AOT-Binärdatei benötigt.

### 3. Ein altes Basis-Image aktualisieren

Enthält das Runtime-Image zwar `ca-certificates`, ist aber Jahre alt, stammt das Bundle aus der Zeit vor den Stammzertifikaten, auf die neuere CAs verketten. Genau das war in #64060 die tatsächliche Situation. Die Lösung ist der Wechsel auf ein aktuelles Basis-Image. Das Paket an Ort und Stelle zu aktualisieren (`apt-get update && apt-get install --only-upgrade ca-certificates`) funktioniert nur, solange die Distribution noch Updates veröffentlicht.

### 4. Die VM mit `DART_VM_OPTIONS` auf ein Bundle verweisen

Wenn Sie das Image nicht anfassen können, aber eine Datei einbinden oder eine Umgebungsvariable setzen können (eine Kubernetes-Pod-Spezifikation, eine verwaltete Laufzeitumgebung), verwenden Sie `--root-certs-file`. Für JIT (`dart run`, `dart bin/server.dart`) ist das eine normale VM-Option:

```bash
dart --root-certs-file=/certs/cacert.pem bin/server.dart
```

Eine `dart compile exe`-Binärdatei ignoriert ihre eigene Befehlszeile für VM-Optionen, da jedes Argument an Ihr `main` geht. Sie liest jedoch `DART_VM_OPTIONS`, eine kommagetrennte Liste, die in `main_impl.cc` nur für ausführbare Dateien mit angehängtem Snapshot geparst wird, und `--root-certs-file` ist eine der Optionen, die sie akzeptiert:

```dockerfile
# Dart 3.13.5 AOT binary, CA bundle supplied explicitly
FROM debian:trixie-slim
COPY cacert.pem /certs/cacert.pem
COPY --from=build /app/bin/server /app/bin/server
ENV DART_VM_OPTIONS=--root-certs-file=/certs/cacert.pem
CMD ["/app/bin/server"]
```

`--root-certs-cache=<dir>` leistet dasselbe für ein Verzeichnis mit Zertifikatsdateien im Stil von `c_rehash` (per Hash benannt). Beide Optionen ersetzen die Systemsuche vollständig: Die Schritte 2 und 3 werden übersprungen, die übergebene Datei ist also der gesamte Trust Store. Verwenden Sie ein gepflegtes Bundle wie die von Mozilla abgeleitete [`cacert.pem` von curl](https://curl.se/docs/caextract.html) und halten Sie es aktuell.

### 5. Das Bundle aus dem Code laden

Wenn Sie das Programm lieber eigenständig lauffähig machen möchten, fügen Sie beim Start Stammzertifikate zum Standardkontext hinzu. `SecurityContext.defaultContext` ist der Kontext, den `HttpClient`, `IOClient` aus `package:http` und die meisten anderen Clients verwenden, wenn Sie keinen eigenen übergeben:

```dart
// Dart 3.13.5
import 'dart:io';

void main() {
  const bundle = '/certs/cacert.pem';
  if (File(bundle).existsSync()) {
    SecurityContext.defaultContext.setTrustedCertificates(bundle);
  }
  // ... start the server, create clients afterwards
}
```

Für ein vollständig eingegrenztes Setup bauen Sie einen Kontext, der nur Ihrem Bundle vertraut, und übergeben ihn an den Client:

```dart
// Dart 3.13.5, package:http 1.x
import 'dart:io';
import 'package:http/io_client.dart';

IOClient buildClient(List<int> pemBytes) {
  final context = SecurityContext(withTrustedRoots: false)
    ..setTrustedCertificatesBytes(pemBytes);
  return IOClient(HttpClient(context: context));
}
```

Das ist das richtige Werkzeug, um eine private CA für einen einzelnen Dienst festzulegen. Als generelle Lösung für öffentliche Endpunkte erzeugt es nur das verlorene Fallback-Bundle neu, nun aber mit Ihnen in der Pflicht, es zu aktualisieren. Bevorzugen Sie daher Option 1 oder 2.

## So bestätigen Sie, dass das Image keinen Trust Store hat

`FROM scratch`- und Distroless-Images haben keine Shell, daher funktioniert `docker run ... ls` nicht. Kopieren Sie stattdessen den Pfad aus einem gestoppten Container heraus:

```bash
docker create --name probe my-dart-app:latest
docker cp probe:/etc/ssl/certs/ca-certificates.crt - | tar -tv
docker rm probe
```

Meldet `docker cp` den Fehler `Could not find the file`, prüfen Sie die anderen vier Bundle-Pfade aus der obigen Liste. Existiert keiner davon und `/etc/ssl/certs` fehlt oder ist leer, haben Sie die Ursache gefunden. Bei Images mit Shell genügt `ls -la /etc/ssl/certs | head`.

## Stolperfallen und ähnliche Fehlerbilder

- **`SSL_CERT_FILE` und `SSL_CERT_DIR` bewirken nichts.** Diese Umgebungsvariablen sind eine OpenSSL-Konvention. Die Dart-VM verwendet BoringSSL und ihre eigene fest eingebaute Pfadliste, daher bleibt das Exportieren wirkungslos. Verwenden Sie stattdessen `DART_VM_OPTIONS=--root-certs-file=...`.
- **Unternehmensweite TLS-Inspektion ist ein anderes Problem.** Wenn ein Proxy den Datenverkehr mit einer internen CA neu signiert, erhalten Sie in jeder Dart-Version dieselbe Meldung, weil der Mozilla-Fallback diese CA nie enthielt. Fügen Sie die CA dem System-Store hinzu (`COPY corp-root.crt /usr/local/share/ca-certificates/`, dann `update-ca-certificates`) oder laden Sie sie mit `setTrustedCertificates`.
- **Selbstsignierte und unvollständige Ketten scheitern mit derselben Meldung.** Wenn nur ein Host scheitert, während `https://pub.dev` funktioniert, sendet der Server vermutlich sein Zwischenzertifikat nicht mit. Beheben Sie das auf dem Server. Fügen Sie nicht `badCertificateCallback: (_, _, _) => true` hinzu, denn das deaktiviert die Überprüfung für alles, womit der Client kommuniziert.
- **Auch `dart pub get` schlägt fehl**, und zwar in einem eigenen Image, das das SDK-ZIP auf eine Basis ohne `ca-certificates` installiert. Dann braucht die Build-Stage das Paket, mit derselben Lösung.
- **Alpine ist kein Ausweg.** Die Ausgabe von `dart compile exe` linkt gegen glibc, daher scheitert ein musl-Image, noch bevor es überhaupt zu TLS kommt. Bleiben Sie bei einer glibc-Basis.
- **Mobile Flutter-Apps sind nicht betroffen.** Android lädt `/system/etc/security/cacerts` direkt und hat den Fallback nie genutzt, und iOS bewertet Vertrauen über das Security Framework. Die Änderung betrifft die eigenständige VM unter Linux: Server, CLIs und Backends, die mit `dart compile exe` kompiliert wurden.

## Verwandte Artikel

- Wenn dieselbe containerisierte CI zusätzlich pub-Warnungen ausgibt, ist [der Fehler beim Dekodieren der Advisories von pub.dev](/de/2026/09/fix-failed-to-decode-advisories-for-archive-from-pub-dev/) eine separate, harmlose Meldung.
- Für ein Dart-Backend, das außerhalb eines langlebigen Containers läuft, endet auch die [experimentelle Dart-Unterstützung in Firebase Cloud Functions](/de/2026/05/dart-cloud-functions-firebase-experimental/) als kompilierte Dart-Binärdatei in einem Linux-Container. Prüfen Sie deshalb dessen Basis-Image auf dieselbe Weise.
- Die Abwägungen bei einer winzigen Runtime-Stage sind auf der .NET-Seite sehr ähnlich; siehe [framework-abhängig vs. eigenständig vs. Native AOT für ein .NET-11-Container-Image](/de/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/).
- Wenn der fehlschlagende Aufruf gRPC ist, behandeln [die Stolperfallen von gRPC in Containern](/de/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/) TLS- und HTTP/2-Probleme, die aus Sicht des Clients ähnlich aussehen.

## Quellen

- [dart-lang/sdk#64060: CERTIFICATE_VERIFY_FAILED on dart:3.13.0 (dart:stable) image](https://github.com/dart-lang/sdk/issues/64060)
- [Dart SDK CHANGELOG, 3.13.0 "Dart Runtime" section](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)
- [Commit 7e5b075680: Reland "[standalone] Remove the fallback root certificates."](https://github.com/dart-lang/sdk/commit/7e5b075680)
- [`runtime/bin/security_context_linux.cc` at 3.13.5](https://github.com/dart-lang/sdk/blob/3.13.5/runtime/bin/security_context_linux.cc)
- [`runtime/bin/main_impl.cc` and `main_options.cc` at 3.13.5 (`DART_VM_OPTIONS` handling)](https://github.com/dart-lang/sdk/blob/3.13.5/runtime/bin/main_options.cc)
- [dart-lang/dart-docker `stable/trixie/Dockerfile`](https://github.com/dart-lang/dart-docker/blob/main/stable/trixie/Dockerfile)
- [`SecurityContext` API reference](https://api.dart.dev/dart-io/SecurityContext-class.html)

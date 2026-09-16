---
title: "Lösung: 'Unexpected failure parsing device information from adb output' in Flutter"
description: "Flutter 3.47.0 kann adb-Zeilen mit Seriennummern ab 22 Zeichen nicht parsen, sodass drahtlose und manche USB-Android-Geräte verschwinden. Aktualisieren Sie auf 3.47.1 oder neuer, oder verbinden Sie per adb connect über die IP."
pubDate: 2026-09-16
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "adb"
  - "flutter-tools"
lang: "de"
translationOf: "2026/09/fix-unexpected-failure-parsing-device-information-from-adb-output-in-flutter"
translatedBy: "claude"
translationDate: 2026-09-16
---

Das ist ein Parser-Bug in Flutter 3.47.0, und Sie müssen ihn nicht erneut melden. `adb devices -l` füllt die Spalte der Seriennummer auf 22 Zeichen auf und hängt dann ein Leerzeichen an. Auf jede Seriennummer mit 22 oder mehr Zeichen (jeder `adb-...._adb-tls-connect._tcp`-Name beim drahtlosen Debugging, dazu manche USB-Seriennummern) folgt also genau ein Leerzeichen. Der Parser in 3.47.0 verlangt an dieser Stelle zwei Leerzeichen oder einen Tab, verwirft die Zeile und lässt das Gerät weg. Führen Sie `flutter upgrade` aus, um 3.47.1 oder neuer zu bekommen (3.47.4 ist das aktuelle Stable-Release). Wenn Sie bei 3.47.0 bleiben müssen, verbinden Sie drahtlose Geräte mit `adb connect <ip>:<port>`, denn die kurze IP-Seriennummer wird weiterhin geparst.

Alles Folgende habe ich auf macOS mit Flutter 3.44.8, 3.47.0 und 3.47.4 (Dart 3.13.0 und 3.13.3) nachgestellt. Jede Version zeigte auf ein Test-Android-SDK, dessen `platform-tools/adb` ein gefälschtes Skript ist, und bekam dieselben neun Gerätezeilen.

## Der Fehler im Kontext

`flutter devices` listet Desktop- und Web-Ziele auf, aber nicht das Telefon, das `adb devices` eindeutig sieht:

```text
Found 2 connected devices:
  macOS (desktop) • macos  • darwin-arm64   • macOS 26.6.1 25G76 darwin-arm64
  Chrome (web)    • chrome • web-javascript • Google Chrome 151.0.7922.140

No wireless devices were found.

Unexpected failure parsing device information from adb output:
adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp device product:oriole model:Pixel_6 device:oriole transport_id:1
Please report a bug at https://github.com/flutter/flutter/issues.
```

In `flutter doctor` übersieht man ihn leicht, weil der Abschnitt "Connected device" trotzdem einen grünen Haken bekommt und die Warnung darunter steht:

```text
[✓] Connected device (2 available)
    ! Unexpected failure parsing device information from adb output:
      9b01005930533036340043eb2a5c2c device usb:17907712X product:serenity_p_in model:25028PC03I device:serenity transport_id:1
      Please report a bug at https://github.com/flutter/flutter/issues.
```

Das zweite Beispiel ist ein USB-Telefon, kein drahtloses. Deshalb ist der Rat "das passiert nur beim drahtlosen Debugging", den man in manchen Threads findet, unvollständig. Android Studio und VS Code beziehen ihre Geräteliste aus demselben Erkennungscode, daher fehlt das Gerät auch in der Geräteauswahl der IDE, und `flutter run -d <serial>` findet nichts, worauf es passt.

Die Meldungen sind [flutter/flutter#191167](https://github.com/flutter/flutter/issues/191167) (USB, Flutter 3.47.0 auf macOS), [#191119](https://github.com/flutter/flutter/issues/191119) (WLAN-Kopplung unter Fedora), [#191343](https://github.com/flutter/flutter/issues/191343) (Ubuntu) sowie upstream [#189430](https://github.com/flutter/flutter/issues/189430) und [#189972](https://github.com/flutter/flutter/issues/189972).

## Warum Flutter 3.47.0 eine gültige adb-Zeile verwirft

adb baut jede Zeile der ausführlichen Liste in `append_transport` in `transport.cpp` zusammen:

```cpp
// adb (platform/packages/modules/adb), transport.cpp
android::base::StringAppendF(result, "%-22s %s", serial.c_str(),
                             to_string(t->GetConnectionState()).c_str());
```

`%-22s` ist eine Mindestbreite, keine Spalte. Eine Seriennummer mit 10 Zeichen wie `ZN52278M76` bekommt 12 Leerzeichen Auffüllung plus das literale Leerzeichen, insgesamt also 13. Eine Seriennummer mit 21 Zeichen bekommt zwei. Eine Seriennummer mit 22 oder mehr Zeichen bekommt genau eines. Seriennummern beim drahtlosen Debugging sind der mDNS-Dienstname, und allein das Suffix `._adb-tls-connect._tcp` hat 22 Zeichen. Viele USB-Seriennummern sind ebenfalls so lang: Die Seriennummer mit 30 Zeichen in #191167 ist ein Beispiel.

Flutter 3.44.x hat Zeilen mit `^(\S+)\s+(\S+)(.*)` geparst: erstes Token, beliebiger Leerraum, zweites Token. Das kommt mit einem Leerzeichen gut zurecht, scheitert aber, wenn die Seriennummer selbst ein Leerzeichen enthält. Wenn Sie das drahtlose Debugging schnell hintereinander umschalten, hängt mDNS ein Konfliktsuffix an, und die Seriennummer wird zu `adb-26151FDF60083B-9tP4nl (2)._adb-tls-connect._tcp`. Flutter 3.44.8 schneidet die Seriennummer dann am ersten Leerzeichen ab. Mein gefälschtes adb protokollierte den empfangenen Aufruf als `adb -s adb-26151FDF60083B-9tP4nl shell getprop`, und ein echter adb-Server kennt diese gekürzte Seriennummer nicht.

Die Korrektur brauchte im 3.47-Zyklus drei Anläufe:

1. [#187943](https://github.com/flutter/flutter/pull/187943) wechselte zu einem nicht-gierigen Match der Seriennummer, `^(.*?)\s+(no permissions|\S+)...`, das in 3.47.0-0.1.pre ausgeliefert wurde. Es brach Zeilen, die einen Devpath ohne `key:`-Präfix enthalten.
2. [#189369](https://github.com/flutter/flutter/pull/189369) behob das, indem es die bekannten adb-Zustände explizit auflistete und `(?:\s{2,}|\t+)` vor dem Zustand verlangte. Es wurde per Cherry-Pick in Beta übernommen und in 3.47.0 ausgeliefert. Diese Zwei-Leerzeichen-Regel ist der Bug, um den es in diesem Beitrag geht.
3. [#189973](https://github.com/flutter/flutter/pull/189973) wechselte zu einer gierigen Erfassung der Seriennummer, verankert an den bekannten Zustandswörtern, und entfernt anschließend die Auffüllung. Es wurde als [#191296](https://github.com/flutter/flutter/pull/191296) per Cherry-Pick in Stable übernommen und am 19. August 2026 in 3.47.1 ausgeliefert.

Das ist der reguläre Ausdruck aus 3.47.0, aus `packages/flutter_tools/lib/src/android/android_device_discovery.dart`:

```dart
// Flutter 3.47.0, android_device_discovery.dart
static final _kDeviceRegex = RegExp(
  r'^(.*?)(?:\s{2,}|\t+)'
  r'(device|offline|unauthorized|no permissions|bootloader|recovery|sideload|rescue|connecting|authorizing|host|unknown)'
  r'(?:\s+(.*)|$)',
);
```

Die einzige Änderung in 3.47.1 betrifft die erste Zeile, die zu `r'^(.*)\s+'` wurde, dazu ein `trimRight()` auf der erfassten Seriennummer. Die Datei ist von 3.47.1 bis 3.47.4 und in der Beta 3.48.0-0.5.pre identisch.

## Minimale Reproduktion mit einem gefälschten adb

Sie brauchen kein Telefon, um das zu sehen. Flutter findet `adb` unter `$ANDROID_HOME/platform-tools/adb`, also kann ein Shell-Skript unter diesem Pfad beliebige Zeilen ausgeben. Es verwendet dasselbe `%-22s %s`-Format wie adb:

```bash
#!/bin/bash
# Fake adb for Flutter 3.44.8 / 3.47.0 / 3.47.4 repros: $SDK/platform-tools/adb
if [ "$1" = "devices" ]; then
  echo "List of devices attached"
  printf '%-22s %s\n' "adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp" \
    "device product:oriole model:Pixel_6 device:oriole transport_id:2"
  echo
  exit 0
fi
if [ "$1" = "-s" ] && [ "$3" = "shell" ] && [ "$4" = "getprop" ]; then
  printf '[ro.build.characteristics]: [phone]\n[ro.build.version.release]: [16]\n'
  printf '[ro.build.version.sdk]: [36]\n[ro.product.cpu.abi]: [arm64-v8a]\n'
  exit 0
fi
exit 0
```

```bash
# Flutter 3.47.0 vs 3.47.4, same fake SDK
chmod +x sdk/platform-tools/adb
ANDROID_HOME=$PWD/sdk XDG_CONFIG_HOME=$PWD/xdg flutter devices
```

`XDG_CONFIG_HOME` verhindert, dass ein Pfad, den Sie einmal mit `flutter config --android-sdk` gespeichert haben, `ANDROID_HOME` überschreibt. Ich habe neun Zeilen durch jede Version geschickt. Die Tabelle zeigt, was `flutter devices` ausgegeben hat:

| adb-Zeile | 3.44.8 | 3.47.0 | 3.47.4 |
|---|---|---|---|
| USB, Seriennummer mit 10 Zeichen `ZN52278M76` | aufgeführt | aufgeführt | aufgeführt |
| USB, Seriennummer mit 21 Zeichen | aufgeführt | aufgeführt | aufgeführt |
| USB, Seriennummer mit 22 Zeichen | aufgeführt | Parse-Fehler | aufgeführt |
| USB, Seriennummer mit 30 Zeichen | aufgeführt | Parse-Fehler | aufgeführt |
| Drahtlos mDNS `adb-...._adb-tls-connect._tcp` | aufgeführt | Parse-Fehler | aufgeführt |
| Drahtlos mDNS mit Suffix `(2)` | aufgeführt mit gekürzter Seriennummer | Parse-Fehler | aufgeführt |
| Drahtlos `192.168.1.3:36809` | aufgeführt | aufgeführt | aufgeführt |
| Drahtlos mDNS, `unauthorized` | Hinweis "is not authorized" | Parse-Fehler | Hinweis "is not authorized" |
| USB, `detached` | als Gerät aufgeführt | Parse-Fehler | Parse-Fehler |

Die Grenze zwischen 21 und 22 Zeichen erklärt alles. Die letzte Zeile ist ein separates Problem, das unten bei den Stolperfallen behandelt wird.

## Lösung 1: Flutter auf 3.47.1 oder neuer aktualisieren

Prüfen Sie zuerst, welche Version Sie verwenden:

```bash
# Flutter 3.47.x
flutter --version
```

Wenn die erste Zeile `Flutter 3.47.0` lautet, aktualisieren Sie auf dem Stable-Kanal:

```bash
# moves 3.47.0 to the latest 3.47.x hotfix (3.47.4 as of 2026-09-16)
flutter upgrade
flutter devices
```

Die Korrektur steht im [CHANGELOG-Eintrag zu 3.47.1](https://github.com/flutter/flutter/blob/3.47.4/CHANGELOG.md) als "Fix ADB device list parsing for long wireless mDNS serials separated from state by a single space". Der Wortlaut nennt drahtlose Seriennummern, die Korrektur deckt aber, wie die Tabelle zeigt, auch lange USB-Seriennummern ab. Wenn Sie Versionen mit FVM oder einer CI-Matrix festlegen, heben Sie die festgelegte Version auf `3.47.4` an, statt `flutter upgrade` auszuführen. Jeder festgelegte Zweig behält seinen eigenen Tool-Snapshot, sodass ein Zweig mit 3.47.0 für sich weiter scheitert. Dasselbe gilt, wenn Sie [mehrere Flutter-Versionen aus einer Pipeline ansteuern](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

Sie müssen `bin/cache/flutter_tools.snapshot` nicht von Hand löschen. `flutter upgrade` baut das Tool neu. Wenn Sie stattdessen mit git einen Tag auschecken, bemerkt der nächste `flutter`-Befehl die neue Revision und baut den Snapshot ebenfalls neu.

## Lösung 2: bei 3.47.0 bleiben und drahtlose Geräte per IP verbinden

Wenn Sie heute nicht aktualisieren können, etwa weil ein Release-Branch auf 3.47.0 festgelegt ist, machen Sie die Seriennummer kurz. `adb connect` mit IP und Port erzeugt einen Transport, dessen Seriennummer etwa `192.168.1.3:36809` lautet. Das sind 17 Zeichen, die auf zwei oder mehr Leerzeichen aufgefüllt werden und unter 3.47.0 geparst werden:

```bash
# Android 11+ wireless debugging, Flutter 3.47.0
# IP address & Port from Settings > Developer options > Wireless debugging
adb connect 192.168.1.3:36809
adb devices -l
flutter devices
```

Verwenden Sie den Verbindungsport, der auf dem Bildschirm für das drahtlose Debugging angezeigt wird, nicht den einmaligen Port aus dem Dialog "Pair device with pairing code". Issue #191343 zeigt das Ergebnis auf echter Hardware: Die mDNS-Zeilen geben weiterhin die Warnung aus, und das Gerät wird unter seiner IP-Seriennummer aufgeführt.

Damit adb den mDNS-Transport gar nicht erst automatisch verbindet und so auch die Warnung verschwindet, setzen Sie `ADB_MDNS_AUTO_CONNECT=0`, bevor der adb-Server startet. In `adb_mdns.cpp` von adb leert der Wert `0` die Allowlist für automatisches Verbinden, die standardmäßig nur `adb-tls-connect` enthält. Die Variable wird vom Serverprozess gelesen, also starten Sie den Server neu:

```bash
# adb (platform-tools), macOS/Linux shell
adb kill-server
ADB_MDNS_AUTO_CONNECT=0 adb start-server
adb connect 192.168.1.3:36809
```

Unter Windows führen Sie vor `adb start-server` in cmd `set ADB_MDNS_AUTO_CONNECT=0` oder in PowerShell `$env:ADB_MDNS_AUTO_CONNECT = "0"` aus. Android Studio startet einen eigenen adb-Server, wenn keiner läuft, also starten Sie Ihren zuerst.

Für USB-Geräte mit langen Seriennummern gibt es keinen vergleichbaren Trick, weil sich eine Hardware-Seriennummer nicht kürzen lässt. Dort ist das Update die Lösung. Wenn Sie wirklich nicht aktualisieren können, verwenden Sie für dieses Gerät wie oben eine drahtlose IP-Verbindung.

## Die eigene adb-Ausgabe gegen beide Parser prüfen

Wenn Sie nicht sicher sind, ob Ihre Zeilen von diesem Bug betroffen sind, wendet dieses Dart-Skript die regulären Ausdrücke aus 3.47.0 und 3.47.1, wörtlich aus dem Tool kopiert, auf die Ausgabe von `adb devices -l` an:

```dart
// Dart 3.13 (Flutter 3.47). Run: adb devices -l | dart run check_adb_rows.dart
import 'dart:convert';
import 'dart:io';

const states =
    r'(device|offline|unauthorized|no permissions|bootloader|recovery|sideload|rescue|connecting|authorizing|host|unknown)';

final flutter3470 = RegExp(r'^(.*?)(?:\s{2,}|\t+)' + states + r'(?:\s+(.*)|$)');
final flutter3471 = RegExp(r'^(.*)\s+' + states + r'(?:\s+(.*)|$)');

Future<void> main() async {
  final lines = await stdin.transform(utf8.decoder).transform(const LineSplitter()).toList();
  for (final raw in lines) {
    final line = raw.trim();
    if (line.isEmpty || line.startsWith('List of devices') || line.startsWith('* daemon ')) {
      continue;
    }
    final old = flutter3470.firstMatch(line);
    final fixed = flutter3471.firstMatch(line);
    print(line);
    print('  3.47.0:  ${old == null ? 'PARSE FAILURE' : 'serial="${old[1]}" state=${old[2]}'}');
    print('  3.47.1+: ${fixed == null ? 'PARSE FAILURE' : 'serial="${fixed[1]!.trimRight()}" state=${fixed[2]}'}');
  }
}
```

Bei meinen neun Testzeilen stimmte es in jedem Fall mit dem echten Tool überein. Für die drahtlose Zeile gibt es Folgendes aus:

```text
adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp device product:oriole model:Pixel_6 device:oriole transport_id:2
  3.47.0:  PARSE FAILURE
  3.47.1+: serial="adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp" state=device
```

## Stolperfallen und ähnlich aussehende Fehler

**Ein Gerät im Zustand `detached` scheitert auch unter 3.47.1 bis 3.47.4.** Aktuelle platform-tools haben `adb detach` und `adb attach`, die ein USB-Gerät freigeben, damit ein anderer Prozess es nutzen kann. adb nennt diesen Verbindungszustand `detached` (siehe `to_string(ConnectionState)` in `adb.cpp`), und dieses Wort steht nicht in Flutters Zustandsliste, sodass selbst der korrigierte Parser dafür "Unexpected failure parsing device information" meldet. Flutter 3.44.8 führte dieselbe Zeile als normales Gerät auf. Führen Sie `adb -s <serial> attach` aus, dann steht in der Zeile wieder `device`. Die Beta 3.48.0-0.5.pre hat dieselbe Zustandsliste, dieser Fall ist also noch nicht behoben.

**Nach dem Update erhalten Sie womöglich stattdessen "is not authorized".** Unter 3.47.0 erscheint ein Gerät mit langer Seriennummer, das auf die Freigabe des USB-Debuggings wartet, ebenfalls als Parse-Fehler, was das eigentliche Problem verdeckt. Sobald 3.47.1+ die Zeile parst, erhalten Sie "Device ... is not authorized. You might need to check your device for an authorization dialog." Entsperren Sie das Telefon und bestätigen Sie die Abfrage des RSA-Schlüssels.

**Das Suffix `(2)` ist eine echte, andere Seriennummer.** Wenn `adb devices -l` sowohl `adb-XXXX._adb-tls-connect._tcp` als auch `adb-XXXX (2)._adb-tls-connect._tcp` anzeigt, hat adb nach einem mDNS-Namenskonflikt zwei Transporte zum selben Telefon. Flutter 3.47.1+ parst jede Zeile für sich, sodass beide als separate Einträge erscheinen. Wählen Sie einen davon mit `-d` aus, oder schalten Sie das drahtlose Debugging auf dem Telefon noch einmal um, um wieder einen einzigen Eintrag zu erhalten. Unter 3.44.x wird der Eintrag mit Suffix unter einer gekürzten Seriennummer aufgeführt, die adb-Befehle dann nicht finden. Genau diesen Bug sollte #187943 beheben.

**"No supported devices connected" bei einer sauberen adb-Zeile ist ein anderes Problem.** Wenn die Zeile geparst wird, das Gerät aber trotzdem nicht erscheint, prüfen Sie ABI und API-Level, nicht den Parser. Das MAUI-Gegenstück zu diesem Problem wird in [doesn't support required ABI](/de/2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app/) behandelt. Wenn `adb` selbst nicht gefunden wird, liegt es an der SDK-Suche, und der [Beitrag zu cmdline-tools component is missing](/de/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) geht die Reihenfolge durch, in der Flutter das SDK auflöst.

**`adb server version doesn't match this client` ist kein Parse-Fehler.** Flutter meldet diese Zeile als separate Diagnose. Meist bedeutet sie, dass sich zwei platform-tools-Installationen in die Quere kommen, oft die von Homebrew und die von Android Studio. Setzen Sie eine davon an den Anfang von `PATH` und führen Sie `adb kill-server` aus.

## Verwandte Beiträge

- [Lösung: flutter doctor --android-licenses schlägt mit cmdline-tools 23 fehl](/de/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/) ist ein weiterer Android-Tooling-Bug, dessen eigentliche Lösung ein 3.47.x-Hotfix ist.
- [Was sonst noch im Hotfix Flutter 3.47.1 ausgeliefert wurde](/de/2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection/), einschließlich der Änderung an der Validierung des Plugin-Registrants.
- Wenn Sie sich an eine App anhängen, die Sie mit `adb install` installiert haben, lesen Sie [wie appFlavor nach einem Hot Restart mit flutter attach gesetzt bleibt](/de/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/).
- [Could not create Dart VM instance nach flutter upgrade](/de/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/) ist ein Fall, in dem die Lösung darin besteht, über ein bestimmtes fehlerhaftes Release hinauszugehen.
- Für die iOS-Seite des Debuggings auf echten Geräten lesen Sie [Flutter auf einem physischen iPhone von Windows aus debuggen](/de/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/).

## Quellen

- [flutter/flutter#189972](https://github.com/flutter/flutter/issues/189972) und [#189430](https://github.com/flutter/flutter/issues/189430), die Upstream-Issues, mit den Nutzermeldungen [#191167](https://github.com/flutter/flutter/issues/191167), [#191119](https://github.com/flutter/flutter/issues/191119) und [#191343](https://github.com/flutter/flutter/issues/191343).
- [flutter/flutter#189973](https://github.com/flutter/flutter/pull/189973), die Korrektur, und [#191296](https://github.com/flutter/flutter/pull/191296), ihr Cherry-Pick nach Stable.
- [flutter/flutter#189369](https://github.com/flutter/flutter/pull/189369) und [#187943](https://github.com/flutter/flutter/pull/187943), die früheren Parser-Änderungen.
- [`android_device_discovery.dart` in 3.47.0](https://github.com/flutter/flutter/blob/3.47.0/packages/flutter_tools/lib/src/android/android_device_discovery.dart) und [in 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/android/android_device_discovery.dart).
- [Flutter CHANGELOG in 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/CHANGELOG.md).
- adb-Quellcode: [`transport.cpp`](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/transport.cpp) (`append_transport`), [`adb.cpp`](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/adb.cpp) (Namen der Verbindungszustände) und [`adb_mdns.cpp`](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/adb_mdns.cpp) (`ADB_MDNS_AUTO_CONNECT`).
- [Dokumentation zu Android Debug Bridge](https://developer.android.com/tools/adb), einschließlich des drahtlosen Debuggings ab Android 11.

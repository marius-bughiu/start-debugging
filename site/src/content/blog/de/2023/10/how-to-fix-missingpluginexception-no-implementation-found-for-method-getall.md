---
title: "Wie Sie beheben: MissingPluginException: No implementation found for method getAll"
description: "Beheben Sie die `MissingPluginException` 'No implementation found for method getAll' in Flutter bei shared_preferences und ähnlichen Plugins (package_info_plus etc.): ProGuard, Plugin-Registrierung, minSdkVersion, Hot Restart."
pubDate: 2023-10-30
updatedDate: 2023-11-01
tags:
  - "flutter"
lang: "de"
translationOf: "2023/10/how-to-fix-missingpluginexception-no-implementation-found-for-method-getall"
translatedBy: "claude"
translationDate: 2026-05-01
---
Das ist ein recht häufiges Problem, das in der Regel bei Flutter-Release-Builds auftritt. Meistens liegt die Ursache darin, dass ProGuard zur Build-Zeit benötigte APIs entfernt, was zu Exceptions wegen fehlender Implementierung wie der unten gezeigten führt.

```plaintext
Unhandled exception:
MissingPluginException(No implementation found for method getAll on channel plugins.flutter.io/shared_preferences)
      MethodChannel.invokeMethod (package:flutter/src/services/platform_channel.dart:278:7)
<asynchronous suspension>
      SharedPreferences.getInstance (package:shared_preferences/shared_preferences.dart:25:27)
<asynchronous suspension>
      main (file:///lib/main.dart)
<asynchronous suspension>
      _startIsolate.<anonymous closure> (dart:isolate/runtime/libisolate_patch.dart:279:19)
      _RawReceivePortImpl._handleMessage (dart:isolate/runtime/libisolate_patch.dart:165:12)
```

Allerdings gibt es für dieses Problem mehrere mögliche Ursachen und entsprechend mehrere mögliche Lösungen. Im Folgenden gehen wir alle durch.

## Minifying und Shrinking deaktivieren

Wenn ProGuard tatsächlich der Auslöser ist, lässt sich das mit ein paar kleinen Anpassungen an der Konfiguration schnell lösen. Öffnen Sie Ihre `/android/app/build.gradle`-Datei und ändern Sie die `release`-Build-Konfiguration von:

```gradle
buildTypes {
    release {
        signingConfig signingConfigs.release
    }
}
```

zu:

```gradle
buildTypes {
        release {
            signingConfig signingConfigs.release
            
            minifyEnabled false
            shrinkResources false
        }
}
```

## ProGuard-Konfiguration anpassen

Hat das oben Genannte nicht geholfen, gehen Sie einen Schritt weiter und passen die ProGuard-Konfiguration an. Fügen Sie dazu die folgenden zwei Zeilen direkt nach der `shrinkResources false`-Zeile in Ihre `build.gradle` ein.

```gradle
useProguard true
proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
```

Erstellen Sie anschließend im selben Ordner wie Ihre `build.gradle` (`android/app/proguard-rules.pro`) eine neue `proguard-rules.pro`-Datei mit folgendem Inhalt:

```gradle
-keep class androidx.lifecycle.DefaultLifecycleObserver
```

## Plugin in `main.dart` hart referenzieren

Wenn Sie Minifying und Shrinking von ProGuard nicht deaktivieren möchten, können Sie versuchen, das Plugin in Ihrer `main.dart`-Datei explizit zu referenzieren. Das hilft ProGuard, die nötigen Abhängigkeiten zu verankern und nicht beim Build wegzustreichen.

Rufen Sie einfach eine beliebige Plugin-Methode direkt in `main.dart` auf und führen Sie die App erneut aus.

## Plugin wurde nicht registriert

Stellen Sie sicher, dass Ihr Plugin registriert ist, indem Sie die `registerWith`-Methode in `main.dart` aufrufen.

```dart
if (Platform.isAndroid) {
    SharedPreferencesAndroid.registerWith();
} else if (Platform.isIOS) {
    SharedPreferencesIOS.registerWith();
}
```

## Arbeiten mit `background_fetch`

Bei der Arbeit mit `background_fetch` ist es wichtig, Ihre Plugins innerhalb des Headless-Tasks erneut zu registrieren. Übernehmen Sie einfach den Registrierungs-Code von oben und fügen Sie ihn an den Anfang Ihrer Task-Funktion ein.

```dart
void backgroundFetchTask(HeadlessTask task) async {
    if (Platform.isAndroid) {
        SharedPreferencesAndroid.registerWith();
    } else if (Platform.isIOS) {
        SharedPreferencesIOS.registerWith();
    }
}
```

## `minSdkVersion` zu niedrig

Möglicherweise zielen Sie auf eine SDK-Version ab, die unter dem vom Plugin geforderten Minimum liegt. In diesem Fall sollten Sie nach einem Cold Start der App eine Fehlermeldung ähnlich der folgenden erhalten.

```gradle
The plugin shared_preferences requires a higher Android SDK version.
Fix this issue by adding the following to the file android\app\build.gradle:

android {
  defaultConfig {
    minSdkVersion 21
  }
}
```

Befolgen Sie einfach die Anweisungen in der Fehlermeldung, dann sollte das Problem behoben sein.

## Build könnte in einem ungültigen Zustand sein

Vielleicht ist mit Ihrem Code oder den Projekt-Abhängigkeiten gar nichts falsch. Das Projekt könnte beim Installieren des Plugins in einen ungültigen Zustand geraten sein. Versuchen Sie zur Lösung, den Befehl `flutter clean` gefolgt von `flutter pub get` auszuführen. Dadurch werden die Abhängigkeiten Ihres Projekts sauber wiederhergestellt. Führen Sie die App nun erneut aus und prüfen Sie, ob das Problem weiterhin besteht.

## Konflikte mit anderen Paketen

Es gibt einige bekannte konfliktverursachende Pakete, die zu diesem Problem führen können. Entfernen Sie sie nacheinander, um zu sehen, ob das Problem verschwindet, und versuchen Sie dann, das identifizierte Paket zu aktualisieren, da die Konflikte in neueren Versionen oft behoben sind.

Hier eine Liste von Paketen, die die `MissingPluginException` auslösen können:

-   admob\_flutter
-   flutter\_webrtc
-   flutter\_facebook\_login

---
title: "Fix: \"does not support provisioning profiles\" beim Archivieren einer Flutter-iOS-App nach der Migration zu Swift Package Manager"
description: "Ein per Kommandozeile an xcodebuild übergebenes Provisioning Profile gilt für jedes SwiftPM-Resource-Bundle-Target. Setzen Sie stattdessen manuelles Signing auf dem Runner-Target."
pubDate: 2026-10-12
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "swiftpm"
  - "xcode"
  - "ci"
lang: "de"
translationOf: "2026/10/fix-does-not-support-provisioning-profiles-flutter-ios-archive-swift-package-manager"
translatedBy: "claude"
translationDate: 2026-10-12
---

Übergeben Sie `PROVISIONING_PROFILE_SPECIFIER` (und meist auch `CODE_SIGN_STYLE`, `DEVELOPMENT_TEAM` und `CODE_SIGN_IDENTITY`) nicht mehr als `xcodebuild`-Kommandozeilenargumente oder als fastlane-`xcargs`. Eine Build-Einstellung auf der Kommandozeile überschreibt diese Einstellung für **jedes** Target im Build. Nach der SwiftPM-Migration gehört dazu auch das Resource-Bundle-Target, das Xcode für jedes Plugin erzeugt, etwa `url_launcher_ios_url_launcher_ios`, und ein Resource Bundle kann kein Provisioning Profile tragen. Setzen Sie stattdessen manuelles Signing auf der Release-Konfiguration des `Runner`-Targets und archivieren Sie dann mit `flutter build ipa`. Mit CocoaPods funktionierten dieselben Argumente nur, weil ein `post_install`-Hook `CODE_SIGNING_ALLOWED = NO` für jeden Pod setzte. SwiftPM kennt keinen solchen Hook, deshalb macht die Migration den Fehler sichtbar. Alles Folgende wurde mit Flutter 3.44.8, Xcode 27.0 und CocoaPods 1.17.0 reproduziert.

## Die vollständige Fehlermeldung

Sie erhalten einen Fehler pro Plugin, das Ressourcen mitliefert (in der Praxis jedes Plugin mit einem `PrivacyInfo.xcprivacy`-Manifest), gefolgt vom üblichen Archivierungsfehler:

```
.../ios/Flutter/ephemeral/Packages/.packages/url_launcher_ios-6.4.2/Package.swift: error: url_launcher_ios_url_launcher_ios does not support provisioning profiles. url_launcher_ios_url_launcher_ios does not support provisioning profiles, but provisioning profile MyApp AppStore has been manually specified. Set the provisioning profile value to "Automatic" in the build settings editor. (in target 'url_launcher_ios_url_launcher_ios' from project 'url_launcher_ios')
.../ios/Flutter/ephemeral/Packages/.packages/shared_preferences_foundation-2.5.7/Package.swift: error: shared_preferences_foundation_shared_preferences_foundation does not support provisioning profiles. shared_preferences_foundation_shared_preferences_foundation does not support provisioning profiles, but provisioning profile MyApp AppStore has been manually specified. Set the provisioning profile value to "Automatic" in the build settings editor. (in target 'shared_preferences_foundation_shared_preferences_foundation' from project 'shared_preferences_foundation')
** ARCHIVE FAILED **
```

Zwei Dinge fallen auf: der Pfad, der in `Flutter/ephemeral/Packages/.packages/` liegt, und der Target-Name, der dem SwiftPM-Muster `<package>_<target>` folgt. Beides zeigt, dass das fehlschlagende Target das Resource Bundle eines Swift-Pakets ist, weder Ihre App noch der Code eines Plugins.

Der Hinweis in der Meldung, "Set the provisioning profile value to Automatic in the build settings editor", hilft hier nicht. Die Build-Einstellungen eines Targets, das Xcode aus einer `Package.swift` synthetisiert, lassen sich nicht öffnen, und nichts in diesem Target verlangt ein Profile. Das Profile wird ihm von außen aufgezwungen.

## Warum das Profile Targets erreicht, die Sie nie konfiguriert haben

Xcode löst eine Build-Einstellung über mehrere Ebenen auf, von der niedrigsten zur höchsten Priorität: Plattform-Standardwerte, Einstellungen auf Projektebene, xcconfig-Dateien, Einstellungen auf Target-Ebene und schließlich die Überschreibungen, die Sie `xcodebuild` als `NAME=value` übergeben. Die höchste Ebene ist nicht auf ein Target beschränkt. Wenn ein CI-Skript Folgendes ausführt:

```bash
# Xcode 27.0, Flutter 3.44.8 - the pattern that breaks
xcodebuild -workspace Runner.xcworkspace -scheme Runner \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/Runner.xcarchive archive \
  CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM=ABCDE12345 \
  CODE_SIGN_IDENTITY="Apple Distribution" \
  PROVISIONING_PROFILE_SPECIFIER="MyApp AppStore"
```

erhält jedes Target, das am Archiv beteiligt ist, `PROVISIONING_PROFILE_SPECIFIER = MyApp AppStore`. Die Signing-Validierung von Xcode lehnt die Einstellung dann bei jedem Produkttyp ab, der nicht provisioniert werden kann, etwa Resource Bundles, statische Bibliotheken und Frameworks. Apple hat dies nicht immer konsistent durchgesetzt: Ein [Thread in den Developer Forums](https://developer.apple.com/forums/thread/700327) dokumentiert denselben Fehler für native Swift-Paket-Abhängigkeiten, der in den Xcode-13.3-Betas auftrat, im 13.3 GM verschwand und in Xcode 14 zurückkehrte. In Xcode 27.0 wird er durchgesetzt.

Nach der Migration bestehen die Targets in einem Archiv aus `Runner`, dem Aggregat `FlutterGeneratedPluginSwiftPackage`, dem Library-Produkt jedes Plugins und einem `.bundle`-Target pro Plugin, das in seiner `Package.swift` `resources:` deklariert. Die meisten Plugins von Flutter selbst liefern auf diese Weise ein Privacy Manifest mit, sodass fast jede echte App mehrere solcher Bundles hat.

### Warum es unter CocoaPods funktionierte

Ich habe denselben Befehl mit derselben App ausgeführt, aber mit deaktiviertem SwiftPM (`enable-swift-package-manager: false` unter `flutter: config:` in `pubspec.yaml`). Auch dort schlägt er fehl, nur mit anderen Target-Namen:

```
ios/Pods/Pods.xcodeproj: error: Pods-Runner does not support provisioning profiles. ...
ios/Pods/Pods.xcodeproj: error: url_launcher_ios does not support provisioning profiles. ...
ios/Pods/Pods.xcodeproj: error: shared_preferences_foundation does not support provisioning profiles. ...
```

Die Kommandozeile war also nie korrekt. Projekte, die damit gebaut wurden, hatten in der `Podfile` einen `post_install`-Block, der dem folgenden ähnelt, meist vor Jahren aus einer Stack-Overflow-Antwort kopiert:

```ruby
# ios/Podfile, CocoaPods 1.17.0
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
    end
  end
end
```

Mit diesem Hook übersteht das Archiv alle Pod-Targets, und nur `Runner` wird gegen das Profile validiert. Der Hook funktioniert, weil Xcode die Signing-Validierung für ein Target überspringt, das nicht signieren darf, obwohl das aufgezwungene Profile weiterhin in dessen Einstellungen steht. Löschen Sie als letzten Schritt der Migration die `Podfile`, verschwindet der Hook mit ihr, und SwiftPM bietet kein Äquivalent. Es gibt kein `post_install` für Pakete, und die generierte `Package.swift` unter `Flutter/ephemeral` wird bei jedem Build neu geschrieben.

## Minimales Repro

```bash
# Flutter 3.44.8, Xcode 27.0, SwiftPM enabled (the default since 3.44)
flutter create --platforms=ios -e --org com.example myapp
cd myapp
flutter pub add url_launcher shared_preferences
# Xcode 27 rejects the template's 13.0 deployment target
sed -i '' 's/IPHONEOS_DEPLOYMENT_TARGET = 13.0/IPHONEOS_DEPLOYMENT_TARGET = 15.0/g' \
  ios/Runner.xcodeproj/project.pbxproj
flutter build ios --simulator --debug   # applies the SwiftPM project migration
cd ios
xcodebuild -workspace Runner.xcworkspace -scheme Runner -configuration Release \
  -destination 'generic/platform=iOS' -archivePath ../build/Runner.xcarchive archive \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=ABCDE12345 \
  PROVISIONING_PROFILE_SPECIFIER="MyApp AppStore" CODE_SIGN_IDENTITY="Apple Distribution"
```

Sie brauchen kein echtes Zertifikat und kein echtes Profile, um das zu sehen. Xcode meldet die Fehler "does not support provisioning profiles" für die beiden Bundle-Targets während der Build-Planung, neben dem erwarteten Fehler "No profile for team" für `Runner`.

## Fix 1: Manuelles Signing auf dem Runner-Target setzen und `flutter build ipa` verwenden

Signing gehört zu den Targets, die etwas Signierbares erzeugen: `Runner` sowie alle App-Erweiterungen, die Sie haben (Share Extension, Notification Service Extension, Widget). Setzen Sie es dort und nirgendwo sonst.

Öffnen Sie in Xcode `ios/Runner.xcworkspace`, wählen Sie das Target `Runner`, gehen Sie zu **Signing & Capabilities**, wählen Sie den Tab **Release**, deaktivieren Sie **Automatically manage signing** und wählen Sie Ihr Team und Ihr Profile. Wenn Sie das Ergebnis lieber sehen möchten, landet Folgendes in der Release-Konfiguration des `Runner`-Targets in `ios/Runner.xcodeproj/project.pbxproj`:

```
/* Flutter 3.44.8, Xcode 27.0 - Runner target, Release configuration */
CODE_SIGN_STYLE = Manual;
DEVELOPMENT_TEAM = ABCDE12345;
"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Distribution";
"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]" = "MyApp AppStore";
```

Wiederholen Sie dies für die Konfiguration `Profile`, wenn Sie Profile-Builds archivieren. Entfernen Sie dann jedes Signing-Argument aus dem Befehl und archivieren Sie normal:

```bash
# Flutter 3.44.8
flutter build ipa --release
```

Nachdem ich dieselben vier Einstellungen von der Kommandozeile in das `Runner`-Target verschoben hatte, verschwanden die Paketfehler, und es blieb nur der erwartete Fehler "No profile ... found" für `Runner`. Meine Testmaschine hat kein Distribution Profile, daher reicht das Repro nicht weiter, aber dieser verbleibende Fehler ist der normale, den man für `Runner` allein erhält, wenn das genannte Profile nicht installiert ist.

`flutter build ipa` fügt keine eigenen Signing-Überschreibungen hinzu. In Flutter 3.44.8 liest `build_ios.dart` nach dem Archivieren die aufgelösten Build-Einstellungen von `Runner`. Ist `CODE_SIGN_STYLE` auf `Manual` gesetzt und sind sowohl `PROVISIONING_PROFILE_SPECIFIER` als auch `DEVELOPMENT_TEAM` gesetzt, findet es das passende installierte Profile und erzeugt eine `ExportOptions.plist` mit `signingStyle` `manual` und einem `provisioningProfiles`-Eintrag für Ihre Bundle-ID. Wenn Sie volle Kontrolle brauchen, etwa bei einer App mit Erweiterungen, übergeben Sie eine eigene Datei:

```bash
# Flutter 3.44.8
flutter build ipa --release --export-options-plist=ios/ExportOptions.plist
```

```xml
<!-- ios/ExportOptions.plist, Xcode 27.0 -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>teamID</key>
  <string>ABCDE12345</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>com.example.myapp</key>
    <string>MyApp AppStore</string>
  </dict>
</dict>
</plist>
```

Führen Sie in `provisioningProfiles` nur Bundle-IDs der App und ihrer Erweiterungen auf. Plugin-Frameworks und -Bundles erhalten nie einen Eintrag.

## Fix 2: In fastlane das Projekt ändern, nicht die Kommandozeile

Die fastlane-Variante des fehlerhaften Musters ist `build_app(xcargs: "PROVISIONING_PROFILE_SPECIFIER=...")`, und `xcargs` ist genau die Kommandozeilenebene. Verwenden Sie `update_code_signing_settings` mit `targets:`, damit die Einstellung nur in `Runner` geschrieben wird, und bauen Sie dann ohne Signing-`xcargs`:

```ruby
# fastlane 2.x, Flutter 3.44.8, Xcode 27.0
lane :release do
  update_code_signing_settings(
    path: "ios/Runner.xcodeproj",
    use_automatic_signing: false,
    targets: ["Runner"],
    build_configurations: ["Release"],
    team_id: "ABCDE12345",
    code_sign_identity: "Apple Distribution",
    sdk: "iphoneos*",
    profile_name: "MyApp AppStore"
  )
  build_app(
    workspace: "ios/Runner.xcworkspace",
    scheme: "Runner",
    configuration: "Release",
    export_method: "app-store",
    export_options: {
      provisioningProfiles: { "com.example.myapp" => "MyApp AppStore" }
    }
  )
end
```

Der Parameter `targets` umfasst standardmäßig alle Targets des Projekts. Die Plugin-Bundles liegen nicht in `Runner.xcodeproj`, daher würde das Weglassen den Fehler nicht reproduzieren, aber die explizite Nennung des Targets verhindert, dass ein künftiges Extension- oder Test-Target das falsche Profile erhält.

## Fix 3: Das Archiv auf automatisches Signing umstellen

Wenn Sie kein bestimmtes Profile benötigen, überlassen Sie die Verwaltung Xcode. Behalten Sie `CODE_SIGN_STYLE = Automatic` auf `Runner` bei und lassen Sie `xcodebuild` Profile mit einem App-Store-Connect-API-Schlüssel abrufen oder erstellen:

```bash
# Xcode 27.0
xcodebuild -workspace ios/Runner.xcworkspace -scheme Runner -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/Runner.xcarchive archive \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"
```

Paket-Bundle-Targets benötigen in diesem Modus kein Signing und bestehen die Validierung daher ohne zusätzlichen Aufwand. Der Preis ist, dass die CI-Maschine den API-Schlüssel braucht und Profile selbstständig erstellt, was manche Release-Prozesse nicht erlauben.

## Workarounds, die richtig aussehen, es aber nicht sind

- **`CODE_SIGNING_ALLOWED=NO` auf der Kommandozeile.** Es erreicht auch `Runner`, sodass Sie ein unsigniertes Archiv erhalten, aus dem `-exportArchive` keine hochladbare IPA erzeugen kann.
- **Bedingte Einstellungen auf der Kommandozeile.** `"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]=MyApp AppStore"` wird nicht als Bedingung geparst. In Xcode 27.0 ergab der Wert `iphoneos*]=MyApp AppStore`, und `Runner` scheiterte mit "No profile ... matching 'iphoneos*]=MyApp AppStore' found". Bedingungen funktionieren nur in Projektdateien und xcconfig-Dateien.
- **`-xcconfig` oder `XCODE_XCCONFIG_FILE`.** Beide wenden ihre Datei als Überschreibung auf den gesamten Build an, sodass ein Profile in dieser Datei die Paket-Targets genauso erreicht wie ein `NAME=value`-Argument.
- **SwiftPM wieder ausschalten.** `enable-swift-package-manager: false` plus der alte `post_install`-Hook lässt den Fehler verschwinden, aber nur, indem CocoaPods zurückkehrt. Das verschafft Zeit, ist aber keine Lösung, und der CocoaPods-Trunk wird am 2026-12-02 schreibgeschützt.

## Ähnliche Fehler von derselben Kommandozeile

Lässt man das Profile weg, behält aber die anderen Überschreibungen, ändert sich nur der Fehler. Mit `CODE_SIGN_STYLE=Manual` und `CODE_SIGN_IDENTITY` auf der Kommandozeile und ohne Team meldet Xcode 27.0 für jedes Bundle `Signing for "url_launcher_ios_url_launcher_ios" requires a development team`. Fügen Sie `DEVELOPMENT_TEAM` hinzu, wird daraus `No signing certificate "iOS Distribution" found` für dieselben Bundle-Targets. Alle drei haben dieselbe Ursache und dieselbe Lösung: keine Signing-Einstellungen auf der Kommandozeile.

Eine andere Meldung, `exportArchive: SomeKit.framework does not support provisioning profiles`, stammt aus dem Export-Schritt, nicht aus dem Archivieren. Sie bedeutet, dass Ihre `ExportOptions.plist` (oder die `export_options` von fastlane) die Bundle-ID eines Frameworks einem Profile zuordnet. Entfernen Sie diesen Eintrag. Nur die App und ihre Erweiterungen gehören dorthin.

Wenn das Archiv das Signing übersteht und dann an den Deployment Targets scheitert, ist das das Xcode-27-Minimum von iOS 15 und kein Signing-Problem. Die CocoaPods-Seite dieses Fehlers behandelt [der Beitrag zu CocoaPods-Versionskonflikten in Flutter-iOS-Builds](/de/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).

## Verwandte Beiträge

- [Eine Flutter-iOS-App von CocoaPods zu Swift Package Manager migrieren](/de/2026/10/migrate-a-flutter-ios-app-from-cocoapods-to-swift-package-manager/) behandelt die Migration, die den `Podfile`-Hook entfernt, einschließlich der Frage, wie sich andere eigene `post_install`-Logik übertragen lässt.
- [Flutter 3.44 macht SwiftPM zum Standard](/de/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) erklärt, warum auf 3.44 aktualisierte Apps ohne Ihr Zutun umgestellt wurden.
- [Fix: Unable to find a destination matching the provided destination specifier](/de/2026/08/fix-unable-to-find-a-destination-matching-the-provided-destination-specifier-in-a-flutter-ios-build/) ist ein weiterer iOS-Build-Fehler, der durch übrig gebliebene Einstellungen aus der CocoaPods-Zeit verursacht wird.
- [Fix: the provisioning profile doesn't include the currently selected device](/de/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) behandelt die Geräteregistrierung beim Provisioning aus der Sicht von .NET MAUI.

## Quellen

- [Swift Package Manager for app developers](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers), Flutter-Dokumentation.
- [Build and release an iOS app](https://docs.flutter.dev/deployment/ios), Flutter-Dokumentation (`flutter build ipa` und `--export-options-plist`).
- [`build_ios.dart` in flutter_tools](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/commands/build_ios.dart), die ExportOptions-Erzeugung für manuelles Signing.
- [update_code_signing_settings](https://docs.fastlane.tools/actions/update_code_signing_settings/), fastlane-Dokumentation.
- [Apple Developer Forums thread 700327](https://developer.apple.com/forums/thread/700327), derselbe Fehler für native Swift-Paket-Abhängigkeiten in einem manuell signierten CI-Archiv und wie sich seine Durchsetzung zwischen Xcode 13 und 14 änderte.
- [Apple Developer Forums thread 726714](https://developer.apple.com/forums/thread/726714), die CocoaPods-Variante, die für jedes Target im Projekt `Pods` auftritt.

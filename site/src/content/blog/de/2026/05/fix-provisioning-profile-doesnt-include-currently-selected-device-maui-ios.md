---
title: "Lösung: Das Provisioning Profile enthält das aktuell ausgewählte Gerät nicht in MAUI iOS"
description: "Das von Visual Studio gewählte Profile wurde vor der Registrierung der UDID dieses iPhones generiert. Gerät neu registrieren, Entwicklungs-Profile neu generieren, herunterladen, erneut bereitstellen."
pubDate: 2026-05-16
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "maui"
  - "maui-11"
  - "ios"
  - "xcode"
  - "signing"
lang: "de"
translationOf: "2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios"
translatedBy: "claude"
translationDate: 2026-05-16
---

Die Lösung: Das Entwicklungs-Provisioning-Profile, mit dem MAUI signieren wollte, enthält die UDID des iPhones nicht. Entweder wurde das Profile generiert, bevor Sie das Gerät registriert haben, das Gerät ist unter einem anderen Team registriert als dem, das Visual Studio verwendet, oder die Bundle ID in Ihrer csproj passt nicht zur App ID, an die das Profile gebunden ist. Fügen Sie die UDID im Apple Developer Account hinzu, generieren Sie das iOS App Development Profile neu, sodass es das neue Gerät enthält, klicken Sie in Visual Studio auf Download All Profiles (oder `Download Manual Profiles` in Xcode, wenn Sie den CLI-Weg nehmen), und stellen Sie erneut bereit. Wenn Sie automatisches Provisioning verwenden, löst das Aus- und Wiedereinstecken des Geräts in der Regel aus, dass Visual Studio das Provisioning erneut ausführt und die neue UDID erfasst.

```text
Could not find any available provisioning profiles for iOS.
error : The provisioning profile doesn't include the currently selected device "iPhone (00008130-001A2C3D0EF8401E)".

error MT1006: Could not install the application 'com.example.app' on the device 'iPhone'.
error : A valid provisioning profile for this executable was not found. (0xe8008015)
```

Diese Anleitung ist gegen .NET 11 GA, das Target Framework `net11.0-ios`, .NET MAUI 11.0.0, Xcode 16.4 und Visual Studio 17.14 gepaart mit einem Mac-Build-Host geschrieben. Derselbe Fehler und dieselbe Lösung gelten unverändert für .NET MAUI 8 und 9; nur die Workload-IDs (`maui-ios`, `ios`) und die mitgelieferte Xcode-Mindestversion ändern sich zwischen Releases. Die Exception wird von `mlaunch` ausgelöst, dem Tool, das MAUI im Hintergrund verwendet, um ein `.app`-Bundle an ein echtes Gerät zu schicken, nachdem `codesign` das Binary bereits akzeptiert hat. Der Build selbst ist erfolgreich. Es ist der Installationsschritt, der Sie zurückweist.

## Warum MAUI iOS Profiles mit Geräte-UDIDs koppelt

Apples iOS-Code-Signing-Modell hat drei bewegliche Teile: ein Signaturzertifikat (Ihre Entwickleridentität), eine App ID (der Bundle-Identifier, an den das Profile gebunden ist) und ein Provisioning Profile (ein signierter Blob, der ein Zertifikat, eine App ID, ein Team und eine Liste erlaubter Geräte-UDIDs miteinander verbindet). Ein Entwicklungs-Profile ist nur für die Geräte gültig, die Apple zum Generierungszeitpunkt darin hinterlegt hat. Stecken Sie ein neues iPhone ein, und jedes vorher existierende Entwicklungs-Profile deckt es stillschweigend nicht ab. Das OS verweigert die Installation mit `0xe8008015`, dem MISAgent-Fehlercode für "no valid provisioning profile". MAUIs `mlaunch` gibt das als die Meldung "provisioning profile doesn't include the currently selected device" aus und in älteren Toolchains als das kryptischere `MT1006`.

Zur Build-Zeit gibt es keine Warnung. `codesign` prüft nur das Zertifikat und die App ID des Profiles; es inspiziert die Geräteliste nicht. Die Geräteliste wird von `installd` auf dem iPhone selbst durchgesetzt, weshalb der Fehler immer beim Deployment auftritt, nie beim Build.

Drei Dinge verursachen das:

1. Die UDID des Geräts steht nicht im Profile (am häufigsten, besonders direkt nach dem Einstecken eines neuen Testgeräts).
2. Die Bundle ID in Ihrer csproj ist von der App ID abgewichen, an die das Profile gebunden ist (Umbenennen eines Projekts, Ändern des Organisations-Präfixes, Kopieren eines Templates).
3. Visual Studio signiert mit einem Profile aus einem anderen Team als dem, das das Gerät registriert hat (ein persönliches Team vs ein Organisations-Team, oder ein lokal gecachtes veraltetes Profile).

## Eine minimale Reproduktion

Nehmen Sie ein beliebiges MAUI 11 iOS-Projekt, setzen Sie Bundle Signing auf Manual, lassen Sie `CodesignProvision` auf ein Entwicklungs-Profile zeigen, das letzte Woche generiert wurde, und stecken Sie heute ein brandneues iPhone ein.

```xml
<!-- .NET 11, .NET MAUI 11.0.0, net11.0-ios -->
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-ios' and '$(Configuration)' == 'Debug'">
  <CodesignKey>Apple Development: Marius Bughiu (ABCDE12345)</CodesignKey>
  <CodesignProvision>MyApp Dev Profile</CodesignProvision>
  <CodesignEntitlements>Platforms/iOS/Entitlements.plist</CodesignEntitlements>
</PropertyGroup>
```

Dann:

```bash
# .NET 11.0.100, MAUI workload 11.0.0
dotnet build -t:Run -f net11.0-ios -p:_DeviceName=":v2:udid=00008130-001A2C3D0EF8401E"
```

Der Build ist erfolgreich. Das Deployment scheitert mit der Meldung "Gerät nicht enthalten", weil das Profile namens `MyApp Dev Profile` generiert wurde, bevor `00008130-001A2C3D0EF8401E` ein Apple bekanntes Gerät war.

## Lösungsweg A: automatisches Provisioning, das veraltet ist

Wenn Ihr `iOS Bundle Signing`-Schema auf **Automatic Provisioning** gesetzt ist (der empfohlene Standard für Entwicklung), soll Visual Studio das Provisioning jedes Mal erneut ausführen, wenn ein neues Gerät eingesteckt wird, und das Profile stillschweigend regenerieren, um es einzuschließen. Wenn dieser Mechanismus hängt, ist der Fehler, den Sie lesen, das Symptom.

1. Öffnen Sie **Tools > Options > Xamarin > Apple Accounts**, wählen Sie Ihr Team aus, klicken Sie auf **View Details**. Bestätigen Sie, dass das von Ihnen erwartete Team das Team ist, das Visual Studio verwendet. Wenn Sie zwei Teams sehen (ein persönliches Team "Marius Bughiu" und ein Organisations-Team), hat jedes seinen eigenen Pool an Profiles, und Visual Studio wird nur gegen das aktuell mit dem Projekt verbundene Team automatisch provisionieren.
2. Rechtsklick auf das Projekt, **Properties**, **iOS > Bundle Signing**. Bestätigen Sie, dass **Scheme** **Automatic Provisioning** ist, **Signing Identity** und **Provisioning Profile** beide auf **Automatic** stehen, und **Configure Automatic Provisioning** einen grünen Haken zeigt. Wenn der Dialog einen Fehler meldet, lesen Sie ihn; "Authentication Service Is Unavailable" bedeutet fast immer, dass es eine nicht akzeptierte Vereinbarung im [App Store Connect](https://appstoreconnect.apple.com/) oder bei [Apple Developer](https://developer.apple.com/account) gibt.
3. Trennen Sie das iPhone vom Mac-Build-Host, warten Sie zwei Sekunden, stecken Sie es wieder ein. Visual Studio lauscht auf das USB-Event und führt das automatische Provisioning erneut aus, was eine neue UDID registriert und das Entwicklungs-Profile regeneriert. Beobachten Sie das Panel **Output > General** auf `Automatic provisioning succeeded`, bevor Sie erneut bereitstellen.
4. Wenn Sie seit dem letzten erfolgreichen Build den Mac gewechselt haben, ist der private Schlüssel Ihres Signaturzertifikats wahrscheinlich nie mitgekommen. Visual Studio teilt Ihnen das im Apple Accounts-Dialog mit dem Status **Not in Keychain** mit. Exportieren Sie die `.p12` aus Keychain Access auf dem Original-Mac und importieren Sie sie über **Import Certificate** im Apple Accounts-Dialog, dann versuchen Sie es erneut.

Automatisches Provisioning erfordert weiterhin, dass der Mac-Build-Host gepaart und erreichbar ist. Wenn `Pair to Mac` gelb zeigt, propagiert sich das USB-Geräteevent nicht und Ihre frische UDID wird nie registriert. Pairen Sie zuerst neu.

## Lösungsweg B: manuelles Provisioning, der explizite csproj-Weg

Wenn Sie Ihr iOS-Signing unter expliziter Kontrolle halten (CI, Enterprise-Verteilung, ein über das Team geteilter Apple-Account), erledigen Sie Registrierung und Regenerierung manuell.

1. Auf dem Mac, **Xcode > Window > Devices and Simulators**, wählen Sie das iPhone aus, kopieren Sie den **Identifier**-String. Das ist die UDID, die `installd` prüft. Das Format lautet `00008130-001A2C3D0EF8401E` für ein A12+-Gerät. Nicht abtippen; kopieren. UDIDs sind 25 Zeichen mit einem Bindestrich; ein falsches Zeichen, und das Profile passt stillschweigend nicht.
2. In einem Browser, [Devices in Apple Developer](https://developer.apple.com/account/resources/devices/list), **+**, wählen Sie die Plattform **iOS, tvOS, watchOS**, fügen Sie die UDID ein, vergeben Sie einen einprägsamen Namen, **Continue**, **Register**.
3. [Profiles](https://developer.apple.com/account/resources/profiles/list), finden Sie Ihr Entwicklungs-Profile, **Edit**, haken Sie das neu hinzugefügte Gerät in der Devices-Liste ab, **Save**, **Download**. Das Bearbeiten des Profiles regeneriert es; der Dateiname bleibt gleich, der Inhalt ändert sich. Apple pusht die neue Datei nicht auf Ihren Rechner; Sie müssen sie herunterladen.
4. Installieren Sie das regenerierte Profile. Auf dem Mac registriert ein Doppelklick auf die `.mobileprovision` sie unter `~/Library/MobileDevice/Provisioning Profiles/`. Auf Windows, in Visual Studio, gehen Sie zu **Tools > Options > Xamarin > Apple Accounts**, wählen Sie Ihr Team aus, **View Details**, **Download All Profiles**. Das Profile synchronisiert sich sowohl mit Windows als auch mit dem gepaarten Mac.
5. Bestätigen Sie, dass Ihre csproj auf das richtige Profile zeigt. Der String in `CodesignProvision` muss exakt mit dem Profile-**Name** in Apple Developer übereinstimmen, nicht mit dem Dateinamen, nicht mit der UUID:

    ```xml
    <!-- .NET 11, .NET MAUI 11.0.0 -->
    <PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-ios' and '$(Configuration)' == 'Debug'">
      <CodesignKey>Apple Development: Marius Bughiu (ABCDE12345)</CodesignKey>
      <CodesignProvision>MyApp Dev Profile</CodesignProvision>
    </PropertyGroup>
    ```

    Der `CodesignKey` ist der Common Name des Zertifikats, wie er in Keychain Access unter **My Certificates** erscheint. Der `CodesignProvision` ist der Profile-Name, den Sie in Schritt 3 des Apple-Developer-Workflows eingegeben haben. Beide unterscheiden Groß- und Kleinschreibung. Siehe [CodesignKey](https://learn.microsoft.com/en-us/dotnet/ios/building-apps/build-properties#codesignkey) und [CodesignProvision](https://learn.microsoft.com/en-us/dotnet/ios/building-apps/build-properties#codesignprovision) für das vollständige Schema.

6. Neu kompilieren und erneut bereitstellen. Wenn der Fehler weiterhin auftritt, springen Sie zu den Gotchas unten; die UDID wurde korrekt registriert, also ist etwas anderes falsch.

## Verifizieren Sie, dass das Profile das Gerät tatsächlich enthält

Bevor Sie das Projekt zerlegen, beweisen Sie, dass das Profile korrekt ist. `security` auf macOS dekodiert die CMS-Hülle um eine `.mobileprovision`:

```bash
# macOS, security tool ships with the OS
security cms -D -i ~/Library/MobileDevice/Provisioning\ Profiles/<UUID>.mobileprovision \
  | plutil -convert xml1 -o - - \
  | grep -A1000 ProvisionedDevices \
  | head -50
```

Sie sollten ein `<string>`-Element mit Ihrer UDID innerhalb von `<key>ProvisionedDevices</key>` sehen. Wenn es fehlt, ist das Profile in Ihrem Provisioning Profiles-Ordner die Kopie vor der Regenerierung. Löschen Sie es und laden Sie es aus Visual Studio oder Xcode erneut herunter. macOS überschreibt ein bestehendes Profile nicht mit einem neueren mit derselben UUID, solange Sie nicht zuerst die alte Datei entfernen; das erwischt viele Leute, die denken, sie hätten "das neue Profile", aber tatsächlich das von letzter Woche haben.

Während Sie schon dort sind, prüfen Sie den Wert `<key>application-identifier</key>`. Er muss gleich `<TEAM_ID>.<bundle-id>` sein, wobei die Bundle ID exakt die **Application ID** in Ihrer csproj ist. Wenn sie sich unterscheiden, ist Ihre csproj oder Ihre `Info.plist` abgedriftet. Siehe den Abschnitt zur Bundle-ID-Abweichung unter Gotchas.

## Gotchas und ähnlich aussehende Fälle

**Sie stellen auf dem Simulator bereit, nicht auf einem Gerät.** Der Simulator benötigt überhaupt kein Provisioning Profile, aber `mlaunch` wird sich trotzdem beschweren, wenn Ihr Projekt über `CodesignProvision` ein Profile erzwingt und Sie versehentlich ein `iPhone 15 Pro Simulator`-Target ausgewählt haben. Wechseln Sie das **Debug Target** in der Visual Studio-Toolbar auf **iOS Remote Devices** und wählen Sie das physische Gerät.

**Sie führen Distribution aus, nicht Development.** Ein Entwicklungs-Profile enthält nur Development-fähige Geräte und signiert nur mit einem `Apple Development`-Zertifikat. Wenn `Configuration` `Release` ist und das Projekt ein `Apple Distribution`-Zertifikat verwendet, ist ein Ad-Hoc-Distribution-Profile erforderlich und Ihr Dev-Profile wird nicht ausgewählt. Siehe die offizielle Anleitung zur [Veröffentlichung für Ad-Hoc-Distribution](https://learn.microsoft.com/en-us/dotnet/maui/ios/deployment/publish-ad-hoc?view=net-maui-10.0) für die parallelen manuellen Schritte.

**Bundle-ID-Abweichung.** Die Application ID unter **Project Properties > MAUI Shared > General** muss zur Bundle ID passen, die eine Wildcard- oder explizite App ID abdeckt. Ein Wildcard-Profile `com.example.*` deckt `com.example.app` ab, aber nicht `com.example.app.dev`. Wenn Sie ein Sample geforkt und die App ID nie aktualisiert haben, wird Ihr Profile wegen App-ID-Mismatch abgelehnt, und `mlaunch` meldet es als Fehler "Gerät nicht enthalten", weil das OS beide Prüfungen in denselben Code 0xe8008015 wirft.

**Wildcard-Profile, aber eine Entitlement, die eine explizite App ID braucht.** Push Notifications, App Groups, Apple Pay, iCloud, Game Center, HealthKit, HomeKit, NFC, Associated Domains, In-App Purchase und Wireless Accessory Configuration verlangen alle eine explizite App ID. Wenn Sie eine davon in `Entitlements.plist` aktiviert haben, während Ihr Profile Wildcard ist, scheitert die Installation. Wechseln Sie zu einer expliziten App ID, die zu Ihrem Bundle Identifier passt, und regenerieren Sie das Profile mit aktivierter Entitlement.

**Zwei Profiles, dieselbe App ID, verschiedene Teams.** Gecachte Profiles werden nicht nach Team indexiert. Wenn Sie sich auf derselben Maschine je in ein anderes Apple Developer Team eingeloggt haben, liegen die Profiles beider Teams nebeneinander in `~/Library/MobileDevice/Provisioning Profiles/`. Visual Studio wählt eines, oft das ältere oder alphabetisch erste, und die Geräteliste passt nicht, weil das Gerät unter dem anderen Team registriert ist. Löschen Sie die veralteten Profile-Dateien und laden Sie über **Download All Profiles** erneut herunter.

**Das Gerät ist supervised oder hat das Vertrauen verloren.** Auf dem iPhone sollte **Settings > General > VPN & Device Management** das Entwicklerzertifikat anzeigen und Ihnen erlauben, **Trust** anzutippen. Wenn "Trust This Computer" verworfen wurde, lehnt `installd` das Deployment ohne klaren Grund ab und `mlaunch` zeigt unter Umständen die Meldung "Gerät nicht enthalten" an. Erneut pairen, Trust antippen, erneut versuchen.

**Kostenlose Apple-ID-Accounts haben eine 7-tägige Profile-Laufzeit.** Persönliche Teams (ohne kostenpflichtige Mitgliedschaft) generieren Entwicklungs-Profiles, die sieben Tage nach Erstellung ablaufen. Das Ablaufen äußert sich zum Deployment-Zeitpunkt auf dieselbe Weise wie der Fall des fehlenden Geräts. Die Lösung ist Regenerierung durch mindestens einmaliges Klicken auf Run in Xcode oder ein Upgrade auf einen bezahlten Apple Developer Program-Account.

**`MT1006: Could not install the application`.** Das ist die Hülle von `mlaunch` für jeden Deployment-Fehler, keine spezifische Ursache. Die erste Geschwister-Zeile im Build-Log ist der echte Fehler; im Fall des fehlenden Geräts ist es die Zeile "provisioning profile doesn't include". Khalid Abuhakmehs Artikel zu [fehlenden Entitlements](https://khalidabuhakmeh.com/fix-dotnet-maui-missingentitlement-and-provisioning-profiles-issues) führt durch die Entitlements-Variante derselben MT1006-Oberfläche.

## Verwandt

- Das Android-Pendant zu "der Build-Wrapper versteckt den echten Fehler" wird in [der Walkthrough zum XA1029 Gradle-Build-Fehler](/de/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) behandelt.
- Wenn Sie iOS-Hot-Reload im selben Projekt einrichten, deckt [dotnet watch auf MAUI Android und iOS in .NET 11 preview 4](/de/2026/05/dotnet-watch-maui-android-ios-net-11-preview-4/) die Watch-Schleife ab, zu der Sie zurückkehren können, sobald die Signatur funktioniert.
- Für Distributions-Flows, nachdem die Entwicklungs-Schleife funktioniert, siehe [Packen einer MAUI-App für den Microsoft Store](/de/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) für die Windows-Seite und die [Ad-Hoc-Distribution-Doku](https://learn.microsoft.com/en-us/dotnet/maui/ios/deployment/publish-ad-hoc?view=net-maui-10.0) für die iOS-Seite.
- Wenn Ihr Ziel nur Desktop ist und Sie das mobile Signing ganz überspringen möchten, zeigt [eine MAUI-App, die nur auf Windows und macOS läuft, keine mobilen Targets](/de/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/), wie Sie das TFM `net11.0-ios` entfernen.
- Für den zugrundeliegenden Laufzeitkontext auf iOS in .NET 11 deckt der Beitrag [MAUI CoreCLR-Standard für Android und iOS in .NET 11 preview 4](/de/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) ab, was sich unter `mlaunch` geändert hat.

## Quellen

- [Manual provisioning for .NET MAUI iOS apps](https://learn.microsoft.com/en-us/dotnet/maui/ios/device-provisioning/manual-provisioning?view=net-maui-10.0) (Microsoft Learn)
- [Automatic provisioning for .NET MAUI iOS apps](https://learn.microsoft.com/en-us/dotnet/maui/ios/device-provisioning/automatic-provisioning?view=net-maui-10.0) (Microsoft Learn)
- [Device provisioning for .NET MAUI apps on iOS](https://learn.microsoft.com/en-us/dotnet/maui/ios/device-provisioning/?view=net-maui-10.0) (Microsoft Learn)
- [Build properties for iOS: CodesignKey and CodesignProvision](https://learn.microsoft.com/en-us/dotnet/ios/building-apps/build-properties#codesignkey) (Microsoft Learn)
- [Publish a .NET MAUI iOS app for ad-hoc distribution](https://learn.microsoft.com/en-us/dotnet/maui/ios/deployment/publish-ad-hoc?view=net-maui-10.0) (Microsoft Learn)
- [Manual iOS Provisioning, dotnet/maui#7056](https://github.com/dotnet/maui/issues/7056) (GitHub)
- [Khalid Abuhakmeh: Fix .NET MAUI MissingEntitlement and Provisioning Profiles Issues](https://khalidabuhakmeh.com/fix-dotnet-maui-missingentitlement-and-provisioning-profiles-issues)

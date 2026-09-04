---
title: "Eine .NET MAUI Android-App auf API-Level 36 migrieren"
description: "Google Play verlangt seit 2026-08-31 das Ziel-API-Level 36, Verlängerungen laufen bis 2026-11-01. Hier ist der vollständige .NET MAUI Weg von net9.0-android zu API 36: der Wechsel des Target Frameworks, das fest eingetragene uses-sdk, das Sie unbemerkt auf dem alten Level hält, Edge-to-Edge ohne Abwahlmöglichkeit, Predictive Back und die Regeln für große Bildschirme."
pubDate: 2026-09-04
updatedDate: 2026-09-04
template: migration
tags:
  - "migration"
  - "maui"
  - "android"
  - "google-play"
  - "dotnet-10"
  - "dotnet-11"
lang: "de"
translationOf: "2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36"
translatedBy: "claude"
translationDate: 2026-09-04
---

Die Build-Änderung ist eine Zeile. Die Verhaltensänderungen sind die Migration. Google Play verlangt seit 2026-08-31 das Ziel-API-Level 36 für neue Apps und App-Updates, mit einer app-bezogenen Verlängerung über die Play Console bis 2026-11-01. Wenn Ihr Update diese Woche abgelehnt wurde, liegt es daran. In einer .NET MAUI App ist das Ziel-API-Level keine Manifest-Einstellung, die Sie bearbeiten: Es leitet sich aus der Android-Plattformversion in Ihrem `TargetFramework` ab, und .NET 9 endet bei API 35. Das heißt, dies ist ein Upgrade des .NET SDK auf .NET 10 (oder .NET 11), keine Manifest-Korrektur. Planen Sie einen Tag für eine kleine App und einen Sprint für alles mit fixierter Ausrichtung, eigenem Zurück-Button oder handoptimierten Insets. Diese Anleitung zielt auf .NET 10 mit .NET MAUI 10.0.100 (veröffentlicht am 2026-08-20) und benennt die Stellen, an denen .NET 11 abweicht.

## Warum genau das Ziel-Level geprüft wird

- **`targetSdkVersion` ist die Schranke, nicht `compileSdk` und nicht `minSdk`.** Play liest `android:targetSdkVersion` aus dem zusammengeführten Manifest in Ihrem AAB. Gegen die API-36-Plattform zu kompilieren reicht allein nicht.
- **Bestehende Installationen werden nicht entfernt, neue Nutzer werden ausgesperrt.** Nach der [Play Console Richtlinie zum Ziel-API-Level](https://support.google.com/googleplay/android-developer/answer/11926878) bleiben Apps unterhalb der Untergrenze auf Geräten, die sie bereits haben, sind aber für neue Nutzer auf Android-Versionen oberhalb des App-Ziels nicht mehr verfügbar. Ihr Installations-Funnel verschlechtert sich still, statt sichtbar zu brechen.
- **Die Untergrenze jedes Jahres ist das Release des Vorjahres.** API 36 ist Android 16. Die Anforderung für 2027 wird API 37 (Android 17) sein, das .NET for Android bereits als stabil ausliefert. Die Arbeit hier ist also Arbeit, die Sie ab jetzt einmal pro Jahr machen.

## Was bricht

| Bereich | Änderung bei Ziel-API 36 | Schweregrad |
| --- | --- | --- |
| Edge-to-Edge | `windowOptOutEdgeToEdgeEnforcement` ist veraltet und wird auf Android-16-Geräten ignoriert | hoch |
| .NET MAUI Safe Areas | `ContentPage.SafeAreaEdges` steht ab .NET 10 standardmäßig auf `None`, Seiten laufen also randlos | hoch |
| Predictive Back | Animationen für Zurück-zum-Homescreen und zwischen Activities sind standardmäßig aktiv; `OnBackPressed` wird nicht aufgerufen | hoch |
| Große Bildschirme | `android:screenOrientation`, `resizableActivity`, `minAspectRatio` und `maxAspectRatio` werden ab `sw600dp` ignoriert | hoch (Tablets, Foldables) |
| .NET SDK | API 36 benötigt `net10.0-android` oder neuer; die .NET 9 Workload endet bei API 35 | hoch |
| Minimale API | .NET 11 hebt die Untergrenze von API 21 auf API 24 | mittel (nur .NET 11) |
| Textdarstellung | `android:elegantTextHeight` ist veraltet und wird ignoriert | niedrig |
| Zeitplanung | `ScheduledExecutorService.scheduleAtFixedRate` holt höchstens eine verpasste Ausführung nach | niedrig |
| Gesundheitssensoren | `BODY_SENSORS` wird durch granulare `android.permissions.health` Berechtigungen ersetzt | niedrig (außer Sie lesen die Herzfrequenz) |

Die ersten beiden Zeilen verstärken sich gegenseitig. Das Upgrade auf .NET 10, um API 36 zu erreichen, ändert im selben Commit auch den Safe-Area-Standard von .NET MAUI selbst. Eine App, die unter .NET 9 mit Ziel 35 gut aussah, kann also aus zwei unabhängigen Gründen mit der Titelleiste unter der Statusleiste herauskommen.

## Checkliste vor dem Start

- .NET 10 SDK installiert, mit wiederhergestellter Workload `maui-android`: `dotnet workload install maui-android`.
- Die Android SDK Platform für API 36 tatsächlich auf dem Build-Rechner und in CI vorhanden. Fehlt sie, erhalten Sie [XA5207](https://learn.microsoft.com/en-us/dotnet/android/messages/xa5207), keine Warnung.
- Ein physisches Gerät oder ein Emulator-Image mit Android 16. Diese Verhaltensänderungen hängen sowohl von der Systemversion als auch von Ihrem Ziel ab, ein Android-14-Emulator verbirgt also jede einzelne davon.
- Screenshots Ihrer aktuellen Oberfläche auf einem Telefon und einem Tablet, bevor Sie etwas ändern. Sie brauchen sie, um die Inset-Regressionen zu beurteilen.
- Ihren Status zur 16-KB-Seitengröße bereits geklärt, denn das ist eine eigene Play-Anforderung mit eigenem Fehlerbild. Siehe [warum Google Play eine Flutter- oder MAUI-App wegen der 16-KB-Seitengröße ablehnt](/de/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).

## Migrationsschritte

1. **Stellen Sie fest, worauf Sie heute tatsächlich zielen.** Lesen Sie nicht die csproj, sondern das zusammengeführte Manifest, das der Build erzeugt:

   ```bash
   dotnet build -f net9.0-android -c Release
   grep -o 'targetSdkVersion="[0-9.]*"' obj/Release/net9.0-android/AndroidManifest.xml
   ```

   **Prüfung:** Sie erhalten genau eine Zahl. Ist sie kleiner als die Android-Plattformversion in Ihrem `TargetFramework`, fixiert etwas den Wert, und Schritt 3 ist für Sie der wichtigste.

2. **Setzen Sie das Target Framework auf .NET 10.** Die Android-Plattformversion im TFM wird zur `targetSdkVersion`, diese eine Änderung ist also die eigentliche Migration:

   ```xml
   <!-- .csproj, .NET 10, .NET MAUI 10.0.100 -->
   <PropertyGroup>
     <TargetFrameworks>net10.0-android;net10.0-ios;net10.0-maccatalyst</TargetFrameworks>
     <SupportedOSPlatformVersion Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'android'">24.0</SupportedOSPlatformVersion>
   </PropertyGroup>
   ```

   Ein blankes `net10.0-android` löst zu API 36 auf, [dem dokumentierten Standard von .NET 10](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-10). Pinnen Sie es explizit als `net10.0-android36.0`, wenn der Build beim späteren Wechsel auf .NET 11 lieber fehlschlagen als abdriften soll, denn .NET for Android hat API 37 in .NET 11 Preview 5 als stabil eingestuft und lässt .NET 11 Projekte nun standardmäßig auf `net11.0-android37` zielen. `$(SupportedOSPlatformVersion)` ist eine andere Achse: Daraus wird `minSdkVersion`, und mit der Play-Anforderung hat das nichts zu tun.

   **Prüfung:** Neu bauen und den `grep` aus Schritt 1 gegen `obj/Release/net10.0-android/AndroidManifest.xml` wiederholen. Es muss `targetSdkVersion="36"` ausgeben.

3. **Löschen Sie jedes fest eingetragene `uses-sdk` aus Ihrem Manifest.** Das ist der häufigste Grund, warum Schritt 2 wirkungslos erscheint. .NET for Android schreibt `targetSdkVersion` nur, wenn das Vorlagen-Manifest noch keine hat, und ein expliziter Wert gewinnt uneingeschränkt ([`ManifestDocument.cs`](https://github.com/dotnet/android/blob/main/src/Xamarin.Android.Build.Tasks/Utilities/ManifestDocument.cs)):

   ```xml
   <!-- Platforms/Android/AndroidManifest.xml: delete the uses-sdk line entirely -->
   <manifest xmlns:android="http://schemas.android.com/apk/res/android">
     <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="34" />
     <application android:allowBackup="true" android:icon="@mipmap/appicon" android:supportsRtl="true" />
   </manifest>
   ```

   Microsofts eigene [Anleitung zu XA5207](https://learn.microsoft.com/en-us/dotnet/android/messages/xa5207) empfahl genau dieses Element, um ein Ziel-Level über ein SDK-Upgrade hinweg zu halten. Entsprechend viele Projekte aus der Xamarin.Forms Zeit tragen es noch mit sich. Die aktuelle .NET MAUI Vorlage enthält gar kein `uses-sdk` Element, und genau dieser Zustand ist gewünscht.

   **Prüfung:** `grep -c uses-sdk Platforms/Android/AndroidManifest.xml` liefert `0`, und das zusammengeführte Manifest zeigt weiterhin `targetSdkVersion="36"`.

4. **Entscheiden Sie sich für eine Edge-to-Edge Strategie, denn Sie haben kein Stimmrecht mehr.** Bei Ziel 36 ist das Attribut `windowOptOutEdgeToEdgeEnforcement` auf Android-16-Geräten [veraltet und deaktiviert](https://developer.android.com/about/versions/16/behavior-changes-16). Wenn es in `Platforms/Android/Resources/values/styles.xml` steht, löschen Sie es. Wählen Sie danach pro Seite einen `SafeAreaEdges` Wert, statt den .NET 10 Standard `None` hinzunehmen:

   ```xml
   <!-- .NET MAUI 10.0.100: ContentPage defaults to SafeAreaEdges="None" -->
   <ContentPage SafeAreaEdges="Container">
       <Grid SafeAreaEdges="Container" RowDefinitions="Auto,*">
           <Label Text="Not under the status bar" />
       </Grid>
   </ContentPage>
   ```

   `Container` reproduziert das .NET 9 Verhalten, sich von Systemleisten und Display-Aussparungen fernzuhalten. `All` weicht zusätzlich der Tastatur aus, was Sie brauchen, wenn Sie sich auf das Android-Platform-Specific `WindowSoftInputModeAdjust.Resize` verlassen haben. `None` ist die immersive Variante und eine bewusste Entscheidung, kein Standard, den Sie versehentlich erben sollten.

   **Prüfung:** Auf einem Android-16-Gerät überlappen Statusleiste und Gestennavigationsleiste auf Ihren drei wichtigsten Bildschirmen kein antippbares Steuerelement, im hellen wie im dunklen Design.

5. **Reparieren Sie eigene Zurück-Logik, bevor Predictive Back sie schluckt.** Bei Ziel 36 sind die Predictive-Back-Animationen standardmäßig aktiv, `onBackPressed()` wird nicht aufgerufen und `KeyEvent.KEYCODE_BACK` nicht ausgeliefert. Eine Activity-Überschreibung wie diese läuft nicht mehr:

   ```csharp
   // Broken at targetSdkVersion 36 on Android 16
   public override void OnBackPressed()
   {
       if (_hasUnsavedChanges) { ShowConfirmDialog(); return; }
       base.OnBackPressed();
   }
   ```

   Behandeln Sie das stattdessen in der Navigationsschicht von .NET MAUI, die plattformübergreifend weiter funktioniert:

   ```csharp
   // .NET MAUI 10.0.100, cross-platform
   protected override bool OnBackButtonPressed()
   {
       if (!_hasUnsavedChanges)
           return base.OnBackButtonPressed();

       Dispatcher.Dispatch(async () => await DisplayAlertAsync("Discard changes?", "...", "OK"));
       return true; // handled
   }
   ```

   Die Android-Notlösung ist `android:enableOnBackInvokedCallback="false"` an `<application>` oder an einer einzelnen `<activity>`, und sie ist ein Notbehelf, keine Lösung.

   **Prüfung:** Vom Bildschirmrand wischen und halten. Sie sollten die Vorschau-Animation sehen, und beim Loslassen sollte passieren, was Ihr Handler vorsieht.

6. **Prüfen Sie fixierte Ausrichtung und feste Seitenverhältnisse.** Auf Displays ab `sw600dp` ignoriert Android bei Ziel 36 `android:screenOrientation`, `android:resizableActivity`, `android:minAspectRatio` und `android:maxAspectRatio` sowie `SetRequestedOrientation` zur Laufzeit. In .NET MAUI bedeutet das meist ein Attribut an `MainActivity`:

   ```csharp
   // Ignored on sw600dp+ displays at targetSdkVersion 36
   [Activity(ScreenOrientation = ScreenOrientation.Portrait, /* ... */)]
   public class MainActivity : MauiAppCompatActivity { }
   ```

   Die vorübergehende Abwahl ist eine Manifest-Eigenschaft, und Google hat erklärt, dass sie ab API-Level 37 nicht mehr greift:

   ```xml
   <application>
     <property android:name="android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY"
               android:value="true" />
   </application>
   ```

   **Prüfung:** Auf einem Tablet- oder Foldable-Emulator ausführen und drehen. Ist das Layout im Querformat unbrauchbar, reparieren Sie das Layout, denn die Abwahl kauft Ihnen ein Jahr.

7. **Aktualisieren Sie CI, damit dort nicht gegen eine fehlende Plattform gebaut wird.** Fehlt API 36 auf einem Agent, erscheint XA5207, und die Lösung ist ein Target, kein Portal-Download:

   ```bash
   dotnet build -t:InstallAndroidDependencies -f net10.0-android \
     -p:AndroidSdkDirectory="$ANDROID_HOME" \
     -p:AcceptAndroidSDKLicenses=true
   ```

   Das Argument `-f` ist Pflicht, sonst meldet MSBuild `MSB4057: The target "InstallAndroidDependencies" does not exist in the project`.

   **Prüfung:** Ein sauberer CI-Lauf aus einem leeren SDK-Cache erzeugt ein signiertes AAB ohne XA5207.

## Prüfliste

- `obj/Release/net10.0-android/AndroidManifest.xml` enthält `targetSdkVersion="36"` und die beabsichtigte `minSdkVersion`.
- Der Pre-Launch-Report der Play Console auf einem internen Track zeigt keine Warnung zum Ziel-API-Level.
- Jeder Bildschirm auf einem Android-16-Telefon auf Inset-Überlappung geprüft, oben und unten, zusätzlich mit geöffneter Tastatur.
- Zurück-Geste, Zurück-Button und ein eventueller Bestätigungsdialog beim Verlassen verhalten sich wie vorher.
- Lauf auf Tablet oder Foldable in beiden Ausrichtungen, sofern Sie überhaupt für große Bildschirme ausliefern.
- Absturzfreie Rate und ANR-Rate nach einer Woche auf einem internen Track unverändert, bevor Sie hochstufen.

## Rollback-Plan

Das Zurücksetzen des `TargetFramework` auf `net9.0-android` stellt das alte Ziel-Level und das alte Safe-Area-Verhalten von .NET MAUI wieder her, und es ist ein sauberer Revert, solange Sie nicht zusätzlich .NET 10 APIs übernommen haben. Nicht zurückrollen lässt sich die Play-Seite: Sobald Sie ein AAB mit Ziel 36 ausgeliefert haben, können Sie danach kein niedrigeres Ziel-Level mehr auf denselben Track veröffentlichen, weil Play die Untergrenze bei jedem Upload durchsetzt. Behandeln Sie den internen Track als Ihr Rollback-Fenster und die Freigabe in Produktion als Einbahnstraße.

## Fallstricke, die echte Zeit kosten

- **Das Manifest schreibt nur die Hauptversion.** `net11.0-android36.1` erzeugt `android:targetSdkVersion="36"`, weil der Manifest-Generator die Hauptkomponente des API-Levels nimmt. Wenn Sie `36.1` im zusammengeführten Manifest erwartet und nach einem Fehler gesucht haben: Es gibt keinen.
- **Mit .NET 9 kommen Sie nicht dorthin.** Die Android-Workload von .NET 9 lieferte API-35-Bindings und blieb dort stehen, `net9.0-android36.0` ist also kein gültiges TFM. Ohne SDK-Wechsel lässt sich die Play-Anforderung nicht erfüllen.
- **Predictive Back hatte einen echten .NET MAUI Fehler.** `MauiAppCompatActivity` registrierte einen Zurück-Callback bedingungslos, was Androids Zurück-zum-Homescreen Animation selbst auf einer Root-Seite unterdrückte, auf der .NET MAUI nichts zu verarbeiten hatte. Behoben wurde das durch den Wechsel auf einen AndroidX `OnBackPressedCallback`, dessen `Enabled` Status abbildet, ob die Navigation tatsächlich zurückgehen kann ([dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223)); ausgeliefert in .NET MAUI 10.0.90. `BlazorWebView` hatte denselben Fehler und eine eigene Korrektur im selben Release. Wenn Ihre Zurück-Animation unter Android 16 stockt, prüfen Sie Ihre .NET MAUI Version, bevor Sie eigenen Code debuggen.
- **`ScrollView` ignoriert `SafeAreaEdges` für das Ausweichen vor der Tastatur.** `SoftInput` wirkt dort nicht, weil `ScrollView` seine Content-Insets selbst verwaltet. Verpacken Sie es in ein `Grid` und setzen Sie `SafeAreaEdges` am Container.
- **Statusleisten-Symbole verschwinden vor Ihrem neuen randlosen Hintergrund.** .NET 11 Preview 7 ergänzte `Window.StatusBarTheme`, um den Symbolkontrast unabhängig vom App-Design zu steuern, ab Android 6.0. Unter .NET 10 setzen Sie `WindowInsetsControllerCompat.AppearanceLightStatusBars` selbst.
- **Die Play-Verlängerung gilt pro App und ist befristet.** Die Verlängerung bis 2026-11-01 wird über die Play-Console-Benachrichtigung der betroffenen App beantragt, nicht automatisch gewährt, und sie verschiebt die API-37-Frist des kommenden Jahres nicht.

## Verwandt

- [Eine .NET MAUI Android-App von Mono auf CoreCLR in .NET 11 migrieren](/de/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/) behandelt die andere Hälfte eines Wechsels auf .NET 11, inklusive der API-24-Untergrenze.
- [Warum Google Play eine Flutter- oder MAUI-App wegen der 16-KB-Seitengröße ablehnt](/de/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) ist die andere Play-Anforderung, die Uploads blockiert.
- ["Doesn't support required ABI" beim Installieren einer .NET MAUI Android-App beheben](/de/2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app/) ist der Installationsfehler, der direkt nach einer Änderung der Runtime Identifier auftritt.
- [Flutter-Oberfläche überlappt nach dem Wechsel auf SDK 35 die Android-Navigationsleiste](/de/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) zeigt dieselbe Edge-to-Edge Durchsetzung aus Flutter-Sicht.
- [Von Xamarin.Forms zu .NET MAUI 11 migrieren](/de/2026/05/migrate-from-xamarin-forms-to-maui-11/), falls das fest eingetragene `uses-sdk` aus Schritt 3 Ihr kleinstes Problem war.

## Quellen

- [Anforderungen an das Ziel-API-Level für Google Play Apps](https://support.google.com/googleplay/android-developer/answer/11926878), Play Console Hilfe.
- [Verhaltensänderungen: Apps mit Ziel Android 16 oder höher](https://developer.android.com/about/versions/16/behavior-changes-16), Android Developers.
- [Neues in .NET MAUI für .NET 10](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-10) und [für .NET 11](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-11), Microsoft Learn.
- [Safe Area Layout](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/safe-area), Microsoft Learn, inklusive der Breaking Change bei `ContentPage` in .NET 10.
- [.NET for Android Fehler XA5207](https://learn.microsoft.com/en-us/dotnet/android/messages/xa5207) und [Build-Targets](https://learn.microsoft.com/en-us/dotnet/android/building-apps/build-targets), Microsoft Learn.
- [Release Notes zu .NET for Android 11 Preview 5](https://github.com/dotnet/android/releases/tag/36.99.0-preview.5.308), die API 37 stabilisieren und .NET 11 standardmäßig auf `net11.0-android37` zielen lassen.
- [dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223), die Korrektur der Predictive-Back-Registrierung.

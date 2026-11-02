---
title: "Nutzen Sie Ihr Android-Smartphone als Webcam für Streamlabs"
description: "Ein Android-Smartphone als Webcam in Streamlabs Desktop unter Windows nutzen: aktuelle DroidCam-Downloads und klar gekennzeichnete Classic-Screenshots."
pubDate: 2019-04-30
updatedDate: 2026-11-02
tags:
  - "android"
lang: "de"
translationOf: "2019/04/use-your-android-phone-as-a-webcam-for-streamlabs"
translatedBy: "claude"
translationDate: 2026-05-01
---

Ein Android-Smartphone mit funktionierender Kamera kann das Kamerabild einer Streamlabs-Szene liefern. Die Qualität hängt von Gerät, Licht, Verbindung und Einstellungen ab; ein altes Handy ist nicht automatisch besser als eine Webcam.

## Passende App und passenden Desktop-Client wählen

Die Screenshots zeigen **DroidCam Classic und die ältere Streamlabs-OBS-Oberfläche unter Windows**. Das ursprüngliche Android-Paket `com.dev47apps.droidcam` lieferte am 2. November 2026 bei Prüfungen mit US-, rumänischen und deutschen Google-Play-Regionsparametern 404. Das beweist weder weltweite Entfernung noch die Verfügbarkeit für jedes bestehende Konto oder Gerät.

Für neue Installationen verlinkt der Herausgeber auf [droidcam.app](https://droidcam.app/) aktuell [DroidCam Webcam & OBS Camera von Dev47Apps](https://play.google.com/store/apps/details?id=com.dev47apps.obsdroidcam), Paket `com.dev47apps.obsdroidcam`. Dies ist eine andere Android-App, keine Umbenennung des Classic-Links. Laut [offizieller FAQ](https://droidcam.app/help/) sind neue und klassische Android-App/Client getrennte Varianten. Verwende passende Paare; die Classic-Screenshots erklären nicht die neue Oberfläche.

Diese Anleitung gilt für **Windows**. Der [aktuelle DroidCam-Client](https://droidcam.app/windows/) unterstützt Windows 10/11; deine Streamlabs-Version muss zusätzlich deren [Systemanforderungen](https://streamlabs.com/content-hub/post/streamlabs-desktop-system-requirements) erfüllen. Ein DroidCam-Linux-Client macht daraus keine Anleitung für Streamlabs Desktop unter Linux. macOS- und OBS-Studio-Plugin-Setups sind andere Verfahren; ein OBS-Studio-Plugin ist nicht mit einer Streamlabs-Quelle gleichzusetzen.

## Aktuelle Einrichtung unter Windows

1. Installiere die aktuelle Android-App von Dev47Apps über den geprüften Link und erlaube Kamerazugriff. Mikrofonzugriff ist nur nötig, wenn du Telefonton verwenden möchtest.
2. Installiere den passenden Windows-Client von der [offiziellen Download- und Einrichtungsseite](https://droidcam.app/windows/).
3. Verbinde Handy und Rechner mit demselben Netzwerk. Öffne die App, wähle im Client **Add > DroidCam**, aktualisiere die Geräteliste und verbinde das Handy. Für USB oder Erkennungsprobleme nutze die Herstellerhilfe.
4. Öffne Streamlabs Desktop nach der Treiberinstallation neu. Füge gemäß der [Quellen-Anleitung](https://streamlabs.com/content-hub/post/quick-start-guide-setting-up-streamlabs-desktop-for-streaming) ein **Video Capture Device** hinzu und wähle die vom Client bereitgestellte Kamera. Die aktuelle Windows-Anleitung nennt sie **DroidCam Video**; Classic kann **DroidCam Source 2/3** anzeigen.
5. Prüfe das Vorschaubild, passe die Quelle an und erstelle eine kurze Testaufnahme. Prüfe aktivierten Ton separat; ein funktionierendes Bild garantiert keine korrekte Mikrofonzuordnung.

## Classic unter Windows: archivierte Screenshots

Diese Bilder erhalten die ursprüngliche Anleitung für vorhandene, zueinander passende Classic-Installationen. Laut [Classic-Verbindungsanleitung](https://www.dev47apps.com/droidcam/connect/) befinden sich Handy und Rechner im selben Netzwerk; der Client nutzt die angezeigte WLAN-IP und den Port. Der [Hersteller dokumentiert weiterhin den Classic-Windows-Client](https://www.dev47apps.com/droidcam/windows/).

Die klassische Android-App zeigt die Verbindungsadresse.

![DroidCam unter Android zeigt die WLAN-IP-Adresse und den Port für die Verbindung mit dem Desktop-Client.](/wp-content/uploads/2019/04/image-7.png)

Trage Adresse und Port in den klassischen Windows-Client ein.

![WLAN-Verbindungsdialog von DroidCam Client mit eingetragener Geräte-IP und Port sowie aktiviertem Video und Audio.](/wp-content/uploads/2019/04/image-8.png)

Starte die Verbindung und prüfe das Vorschaubild.

![DroidCam Client zeigt das Kamerabild des verbundenen Smartphones.](/wp-content/uploads/2019/04/image-9.png)

Die damalige Streamlabs-Oberfläche fügt ein Video Capture Device hinzu.

![Streamlabs-Dialog Add Source mit unterstrichener Option Video Capture Device.](/wp-content/uploads/2019/04/image-5-1024x555.png)

Diese Installation verwendete DroidCam Source 3; entscheidend ist das von deinem Client bereitgestellte Gerät.

![Streamlabs-Einstellungen für Video Capture Device mit ausgewählter DroidCam Source 3 und Kameravorschau.](/wp-content/uploads/2019/04/image-10.png)

Positioniere und skaliere das Kamerabild in der Szene.

![Streamlabs-Szene mit dem Smartphone-Kamerabild als kleinem Overlay unten rechts in der Bildschirmaufnahme.](/wp-content/uploads/2019/04/image-11-1024x555.png)

Eine stabile Handyhalterung auf Augenhöhe erleichtert den Bildausschnitt. Wähle eine zum Gerät passende Halterung; die frühere Erwähnung des Huawei AF14 war ein persönlicher Kauf, keine aktuelle Preis- oder Verfügbarkeitsempfehlung.

Ein weiteres Szenenelement beschreibt die [Streamlabs-Umfragen-Anleitung](/de/2020/08/polls-for-streamlabs-interact-with-your-viewers/).

**Korrektur vom 2. November 2026:** Classic und aktuelle DroidCam-App getrennt, den nicht erreichbaren Classic-Eintrag durch ausdrücklich gekennzeichnete aktuelle Downloadhinweise ersetzt und die Streamlabs-Anleitung auf Windows begrenzt. Links und Herstelleranweisungen wurden geprüft; ein Handy-/Windows-Hardwaretest wurde für dieses Update nicht durchgeführt.

---
title: "Nutzen Sie Ihr Android-Smartphone als Webcam für Streamlabs"
description: "Verwandeln Sie Ihr altes Android-Smartphone mit DroidCam in eine Webcam für Streamlabs OBS, mit Schritt-für-Schritt-Anleitung."
pubDate: 2019-04-30
updatedDate: 2020-08-06
tags:
  - "android"
lang: "de"
translationOf: "2019/04/use-your-android-phone-as-a-webcam-for-streamlabs"
translatedBy: "claude"
translationDate: 2026-05-01
---
Sie brauchen eine Webcam fürs Streaming? Warum nicht eines der defekten oder veralteten Smartphones nutzen, die zu Hause herumliegen?

Die meisten Smartphones können Bilder und Videos in höherer Auflösung und besserer Qualität aufnehmen als eine typische Webcam. Damit sind sie ein idealer Webcam-Ersatz fürs Streaming, insbesondere wenn Sie eines ungenutzt herumliegen haben.

Vor Kurzem hatte ich ein Google Pixel 2 XL mit defektem Display. Lange Geschichte, kurz: Ich habe das Display zerbrochen, ersetzen lassen, und 8 Monate später ist das Ersatzdisplay ausgefallen. Wegen der Kosten und fehlender Garantie habe ich entschieden, einen Schlussstrich zu ziehen und das Display nicht erneut zu tauschen. Übrig blieb ein defektes Smartphone, aber mit einer einwandfrei funktionierenden, großartigen Kamera.

Legen wir los. Um Ihr Android-Smartphone als Webcam zu nutzen, brauchen Sie zwei Dinge:

-   [DroidCam Wireless Webcam](https://play.google.com/store/apps/details?id=com.dev47apps.droidcam) für Android
-   und die Client-App für Windows oder Linux, die Sie [hier herunterladen](http://www.dev47apps.com/) können

Laden Sie zunächst die App auf Ihr Android-Smartphone und installieren Sie sie. Gehen Sie nach der Installation den Setup-Assistenten durch, erteilen Sie der App die nötigen Berechtigungen (Audio und Video aufzeichnen), und fertig. Die App zeigt nun Informationen wie die IP-Adresse und den Port, auf dem das Video gestreamt wird. Halten Sie diese bereit, wir brauchen sie im nächsten Schritt.

![](/wp-content/uploads/2019/04/image-7.png)

Als Nächstes laden Sie den Client für Windows oder Linux herunter und installieren ihn. Nach der Installation starten Sie die App und tragen die IP-Adresse und Portnummer genauso ein, wie sie in der Android-Anwendung erscheinen.

![](/wp-content/uploads/2019/04/image-8.png)

Wenn Sie soweit sind, klicken Sie auf Start. Und voilà, Ihre brandneue Webcam!

![](/wp-content/uploads/2019/04/image-9.png)

Der letzte Schritt ist, die Videoquelle in Streamlabs hinzuzufügen. Öffnen Sie dazu Streamlabs OBS und klicken Sie auf +, um eine neue Source hinzuzufügen.

![](/wp-content/uploads/2019/04/image-5-1024x555.png)

Wählen Sie im erscheinenden Popup Video Capture Device und klicken Sie auf Add Source. Im nächsten Bildschirm einfach Add New Source anklicken. Nun können Sie an den Einstellungen für das Gerät spielen. Wählen Sie zunächst aus dem Device-Dropdown DroidCam aus; in meinem Fall heißt es DroidCam Source. Spielen Sie dann mit den Einstellungen, bis Sie das gewünschte Ergebnis erhalten; bei mir haben die Standardwerte gut funktioniert. Wenn Sie fertig sind, klicken Sie auf Done.

![](/wp-content/uploads/2019/04/image-10.png)

Jetzt können Sie die Videoquelle in Ihrer Szene verschieben und nach Belieben skalieren. Sobald Sie soweit sind, können Sie mit dem Streaming beginnen.

![](/wp-content/uploads/2019/04/image-11-1024x555.png)

## Tipp

Ein Problem bei der Nutzung von Smartphones als Webcam ist, sie in einer stabilen Position zu halten, möglichst in einer bestimmten Höhe und Neigung. Das lässt sich mit einem Smartphone-Stativ lösen.

Ich habe mich am Ende für ein Huawei AF14 entschieden, weil es die günstigste Option war, die meine Anforderungen erfüllt. Sobald Sie das Stativ haben, stellen Sie es in einem für Sie angenehmen Winkel und in einer Höhe nahe Ihrer Augenhöhe auf.

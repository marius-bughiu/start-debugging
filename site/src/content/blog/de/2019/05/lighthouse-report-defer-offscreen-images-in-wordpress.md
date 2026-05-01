---
title: "Lighthouse-Bericht: Bilder außerhalb des Sichtbereichs in WordPress aufschieben"
description: "Verbessern Sie den Lighthouse-Performance-Score Ihrer WordPress-Site, indem Sie Bilder außerhalb des Sichtbereichs per Lazy Loading aufschieben."
pubDate: 2019-05-01
updatedDate: 2023-11-05
tags:
  - "lighthouse"
lang: "de"
translationOf: "2019/05/lighthouse-report-defer-offscreen-images-in-wordpress"
translatedBy: "claude"
translationDate: 2026-05-01
---
Eines der wichtigsten Dinge bei der wahrgenommenen Performance ist, wie schnell eine Webseite beim ersten Aufruf lädt. Und ein Schlüssel zu einer schnell ladenden Seite besteht darin, nur das zu laden, was nötig ist, und auch nur dann, wenn es nötig ist.

Klar, das mag nach viel Arbeit klingen, aber gerade bei Bildern gibt es einige niedrig hängende Früchte. Bilder verbrauchen üblicherweise die meiste Bandbreite beim Laden einer Website, und traditionell lädt man einfach alles.

Das hat mehrere Nachteile:

-   Sie verbrauchen Ressourcen für etwas, das der Nutzer eventuell nie zu sehen bekommt.
-   Mögliche Kostenfolgen sowohl für den Nutzer als auch für Sie. Der Nutzer kann auf einer mobilen, getakteten Verbindung sein, während Sie in der Cloud hosten und ausgehende Bandbreite bezahlen.
-   Schlechte User Experience und wahrgenommene Performance, weil Sie nutzlosen (nicht sichtbaren) Inhalt herunterladen und verarbeiten, statt sich auf den sichtbaren Bereich zu konzentrieren.
-   Letzteres kann auch zu Page-Ranking-Strafen durch Google führen, da Google reaktionsfähigere Seiten bevorzugt.

Die Lösung: Bilder aufschieben und erst laden, sobald sie in den Sichtbereich kommen. Und weil ich es ansprach: Es gibt ein Plugin, das genau das tut: [Lazy Load Optimizer](https://wordpress.org/support/plugin/lazy-load-optimizer/).

Fügen Sie es einfach Ihrer WordPress-Site hinzu und fertig. Künftig laden Nutzer beim Aufruf Ihrer Webseite nur noch die Bilder im sichtbaren Bereich. Alle anderen Bilder werden per Lazy Load nachgeladen, wenn der Nutzer scrollt.

Allein das hat den Performance-Wert des Blogs um 20 Punkte angehoben, von 41 auf 61. Mal sehen, wohin die Reise als Nächstes geht.

## Fehlerbehebung

Bei mir gab es nach der Installation des Plugins ein paar Probleme, bei denen einzelne Bilder so explodierten:

![](/wp-content/uploads/2019/04/image-6-1024x490.png)

Grund dafür war hartcodiertes Styling direkt in den img-Tags, was ohnehin als schlechte Praxis gilt. Ich habe alles in zwei separat geladene CSS-Klassen ausgelagert, und jetzt passt alles.

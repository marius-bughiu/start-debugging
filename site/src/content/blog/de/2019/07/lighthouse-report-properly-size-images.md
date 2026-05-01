---
title: "Lighthouse-Bericht: Bilder richtig dimensionieren"
description: "Verbessern Sie Ihren Lighthouse-Performance-Score, indem Sie Bilder mit Tools wie Squoosh richtig dimensionieren und für das Web optimieren."
pubDate: 2019-07-28
updatedDate: 2023-11-15
tags:
  - "lighthouse"
lang: "de"
translationOf: "2019/07/lighthouse-report-properly-size-images"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ihre Bilder richtig zu dimensionieren kann die Ladezeiten Ihrer Seite drastisch verbessern. Hier betrachten wir zwei unterschiedliche Kategorien:

-   Bilder, die nicht für das Web optimiert sind (unkomprimiert, ungeeignete Formate)
-   Bilder mit höherer Auflösung als nötig (z. B. ein 800px breites Bild, das mit 300px angezeigt wird)

![Lighthouse-Bericht zum richtigen Dimensionieren von Bildern](/wp-content/uploads/2019/07/properly-size-images.jpg)

In unserem Fall haben wir drei Bilder auf der Startseite, die nicht optimiert oder falsch dimensioniert sind. Zum Optimieren verwende ich [Squoosh](https://squoosh.app/).

Erstes Bild, das Outworld-Apps-Logo: Es war 887px breit und wurde in einem 263px breiten Container angezeigt. Mit OptiPNG verkleinert und optimiert, sank die Größe von 29.2 KB auf 9.13 KB.

Zweites Bild, ein Bild von mir: 200px mal 200px, angezeigt in einem 86px-Container. Verkleinern + Optimieren führten zu einem um 76% kleineren Bild.

Das letzte ist ein Bild aus einem der Artikel. Hier ist es wichtig, die Breite Ihres Beitragscontainers zu kennen. Bei meinem Blog sind das 523px. Das Bild hat bereits diese Größe, ich hatte es aber aus dem Snipping Tool eingefügt, sodass es überhaupt nicht optimiert war. Außerdem war es ein PNG, obwohl ich in diesem Fall Transparenz nicht brauche, sodass es genauso gut ein JPEG sein könnte.

Bilder aktualisieren, und fertig.

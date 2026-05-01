---
title: "Auf Xamarin Forms 3 aktualisieren"
description: "Ein kurzer Leitfaden zum Upgrade auf Xamarin Forms 3, einschließlich häufiger Build-Fehler und wie Sie sie beheben."
pubDate: 2018-04-07
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "de"
translationOf: "2018/04/upgrading-xamarin-forms-3"
translatedBy: "claude"
translationDate: 2026-05-01
---
Beim Upgrade zwischen Major-Versionen von Xamarin geht oft etwas kaputt, sodass Projekte wegen seltsamer Fehler nicht mehr bauen. In ihrer Unschuld nehmen viele Entwickler diese Fehler ernst, versuchen sie zu verstehen, zu beheben, und wenn das nicht klappt, googlen sie sie -- obwohl die Lösung meistens ist, Visual Studio zu schließen, wieder zu öffnen und einen Clean Build der Solution zu machen. Sehen wir uns Xamarin Forms 3 an (denken Sie daran, das ist eine Pre-Release-Version, also können diese Punkte zum Release behoben sein).

Öffnen Sie Ihr bestehendes Projekt oder legen Sie ein neues Master-Detail-Projekt mit .NET Standard an. Bauen Sie das Projekt und prüfen Sie, dass es läuft. Verwalten Sie nun die NuGet-Pakete Ihrer Solution. Wenn Sie wie ich mit einer Pre-Release-Version arbeiten, setzen Sie das Häkchen bei "Include prerelease".

Wählen Sie alle Pakete aus und führen Sie Update aus. Wenn Sie jetzt versuchen zu bauen, erhalten Sie wahrscheinlich Fehler über fehlschlagendes GenerateJavaStubs und über den nicht unterstützten Parameter XamlFiles bei XamlGTask. Ignorieren Sie das, schließen Sie Visual Studio (VS wirft eventuell einen Fehler, dass eine Task abgebrochen wurde; auch das ignorieren), öffnen Sie VS wieder, bereinigen Sie die Solution und bauen Sie neu -- eben wie ein richtiger Entwickler.

Danach, wenn Sie ein neues Projekt für Android bauen, erhalten Sie den Java-Max-Heap-Size-Fehler.

Gehen Sie in den Properties Ihres Android-Projekts auf Android Options und klicken Sie unten auf Advanced. Tragen Sie dann "1G" als Java Max Heap Size ein. Ich frage mich, wann das in neuen Projekten zum Default wird...

Erneut bauen, voilà! Es läuft jetzt.

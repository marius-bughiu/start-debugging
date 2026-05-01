---
title: "Xamarin-ListView-Performance und Ersatz durch Syncfusion SfListView"
description: "Verbessern Sie die Scroll-Performance des Xamarin-Forms-ListView mit Caching-Strategien, Template-Optimierung und Syncfusion SfListView."
pubDate: 2017-12-16
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "de"
translationOf: "2017/12/xamarin-listview-performance"
translatedBy: "claude"
translationDate: 2026-05-01
---
Xamarin liefert mit jedem Update neue Funktionen und verbessert die Performance von Xamarin Forms, doch das Angebot an plattformübergreifenden User-Controls reicht nicht immer aus. In meinem Fall habe ich eine RSS-Reader-App, die News aus verschiedenen Quellen aggregiert und in einem ListView wie diesem anzeigt:

So sehr ich das Aussehen der App mag, hat sie ein großes Problem: die Performance. Selbst auf High-End-Geräten ruckelt das Scrollen, und auf Low-End-Geräten wirft sie wegen der geladenen Bilder ständig OutOfMemory Exceptions. Eine Änderung war also nötig. In diesem Artikel behandle ich nur das erste Thema, die Scroll-Performance; die OutOfMemory Exceptions schauen wir uns ein anderes Mal an.

### Das Item-Template

Beim Performance-Troubleshooting müssen Sie zuerst das ItemTemplate des ListView untersuchen. Jede Optimierung auf dieser Ebene hat enorme Auswirkungen auf die Gesamtperformance des ListView. Schauen Sie auf Punkte wie:

-   die Anzahl der XAML-Elemente reduzieren. Je weniger zu rendern, desto besser
-   dasselbe gilt für Verschachtelung. Vermeiden Sie tiefe Hierarchien und unnötige Verschachtelung. Das Rendering dauert sonst viel zu lange
-   stellen Sie sicher, dass Ihre ItemSource ein IList und keine IEnumerable-Kollektion ist. IEnumerable unterstützt keinen wahlfreien Zugriff
-   ändern Sie das Layout nicht abhängig vom BindingContext. Verwenden Sie stattdessen einen DataTemplateSelector

Schon nach diesen Änderungen sollten Sie Verbesserungen beim Scrollen sehen. Als Nächstes ist die Caching-Strategie an der Reihe.

### Caching-Strategie

Standardmäßig nutzt Xamarin auf Android und iOS die Caching-Strategie RetainElement, das heißt, für jedes Item der Liste wird eine Instanz Ihres ItemTemplate erstellt. Stellen Sie die CachingStrategy des ListView auf RecycleElement um, damit Container, die nicht mehr sichtbar sind, wiederverwendet statt jedes Mal neu erzeugt werden. Das verbessert die Performance, indem Initialisierungskosten entfallen.

```xml
<ListView CachingStrategy="RecycleElement">
    <ListView.ItemTemplate>
        <DataTemplate>
            <ViewCell>
              ...
            </ViewCell>
        </DataTemplate>
    </ListView.ItemTemplate>
</ListView>
```

Falls Sie zufällig einen DataTemplateSelector verwenden, sollten Sie die Caching-Strategie RecycleElementAndDataTemplate nutzen. Mehr Details zu Caching-Strategien finden Sie in der [Xamarin-Dokumentation](https://learn.microsoft.com/en-us/xamarin/xamarin-forms/user-interface/listview/performance) zur ListView-Performance.

### Syncfusion ListView

Wenn Sie bis hierher gekommen sind und Ihre Performance-Probleme weiterhin bestehen, ist es Zeit, andere Optionen in Betracht zu ziehen. In meinem Fall habe ich Syncfusions SfListView ausprobiert, weil sie für ihre Control-Suiten bekannt sind und ihre Xamarin-Controls unter ähnlichen Bedingungen wie Visual Studio Community gratis anbieten. Gehen Sie zum Einstieg auf die Syncfusion-Website und [holen Sie sich Ihre kostenlose Community-Lizenz](https://www.syncfusion.com/products/communitylicense), falls noch nicht geschehen.

Fügen Sie als Nächstes das SfListView-Paket Ihrem Projekt hinzu. Syncfusion-Pakete sind über deren eigenes NuGet-Repository verfügbar. Um darauf zugreifen zu können, müssen Sie es Ihren NuGet-Sources hinzufügen. Eine vollständige Anleitung dazu finden Sie [hier](https://help.syncfusion.com/xamarin/listview/getting-started). Anschließend liefert eine einfache NuGet-Suche nach SfListView das gewünschte Paket. Installieren Sie das Paket in Ihrem Core/Cross-Platform-Projekt sowie in allen Plattformprojekten; die korrekten DLLs werden je nach Target Ihres Projekts automatisch ausgewählt.

Jetzt, da alles installiert ist, ersetzen wir das Standard-ListView. Fügen Sie dazu in Ihrer Page/View den folgenden Namespace hinzu:

```xml
xmlns:sflv="clr-namespace:Syncfusion.ListView.XForms;assembly=Syncfusion.SfListView.XForms"
```

Ersetzen Sie dann das ListView-Tag durch sflv:ListView, ListView.ItemTemplate durch sflv:SfListView.ItemTemplate und entfernen Sie das ViewCell aus Ihrer Hierarchie -- es wird nicht benötigt. Falls Sie die CachingStrategy-Eigenschaft verwendet haben, entfernen Sie auch diese -- SfListView recyclet Elemente standardmäßig. Sie sollten am Ende etwas wie das hier haben:

```xml
<sflv:SfListView>
    <sflv:SfListView.ItemTemplate>
        <DataTemplate>
           ...
        </DataTemplate>
    </sflv:SfListView.ItemTemplate>
</sflv:SfListView>
```

Das war's. Wenn Sie Fragen haben, lassen Sie es mich in den Kommentaren wissen. Und wenn Sie weitere Tipps haben, die die ListView-Performance verbessern, immer her damit.

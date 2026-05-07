---
title: "Performante Xamarin.Forms ListView zu MAUI CollectionView migrieren"
description: "Schritt-für-Schritt-Migration von Xamarin.Forms 5.0 ListView zu .NET MAUI 11 CollectionView für Apps, die bereits jede Performance aus ListView herausgeholt haben. Behandelt Cell Recycling, Virtualisierung, Gruppierung, Pull-to-Refresh, Kontextaktionen, Auswahl, ItemsLayout, EmptyView und die Stolperfallen, die echte Apps treffen."
pubDate: 2026-05-07
updatedDate: 2026-05-07
template: migration
tags:
  - "maui"
  - "xamarin"
  - "xamarin-forms"
  - "collectionview"
  - "listview"
  - "migration"
  - "dotnet"
lang: "de"
translationOf: "2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview"
translatedBy: "claude"
translationDate: 2026-05-07
---

Die Kurzfassung: Ersetzen Sie `ListView` durch `CollectionView`, eingebettet in eine `RefreshView`, falls Sie Pull-to-Refresh benötigen, tauschen Sie `ContextActions` gegen `SwipeView`, entfernen Sie `HasUnevenRows`, `RowHeight` und `CachingStrategy`, weil Virtualisierung mit Cell Recycling der einzige Modus in MAUI ist, und schreiben Sie die Auswahl von `ItemTapped` / `ItemSelected` auf `SelectionMode` plus `SelectionChangedCommand` um. Wenn Ihre alte `ListView` mit `CachingStrategy="RecycleElement"`, `HasUnevenRows="True"` und einem `DataTemplateSelector` optimiert war, ist die Umstellung weitgehend mechanisch. Getestet mit .NET MAUI 11.0 GA auf `net11.0-android35.0`, `net11.0-ios18.0` und `net11.0-maccatalyst18.0`. Rechnen Sie mit ein bis drei Tagen fokussierter Arbeit für eine App mit fünf bis zehn Listen, länger, wenn Sie stark auf Gruppierung im `TableView`-Stil oder eigene `ViewCell`-Renderer setzen.

Xamarin.Forms ist seit dem [1. Mai 2024](https://dotnet.microsoft.com/en-us/platform/support/policy/maui) ohne Support, und MAUI 11 GA wurde im November 2025 mit der dritten Generation von CollectionView-Fixes für Ruckeln auf Android ausgeliefert. Falls Sie bisher gewartet haben, weil die Performance Ihrer App von Hand auf `ListView`-Eigenheiten wie `RecycleElementAndDataTemplate` getrimmt war, lohnt sich das Upgrade jetzt: CollectionView in MAUI 11 erreicht oder schlägt endlich die alte Xamarin.Forms `ListView` auf Android, sobald Sie `ItemSizingStrategy.MeasureAllItems` deaktivieren. Diese Anleitung richtet sich an genau dieses Publikum.

## Warum jetzt migrieren

- Xamarin.Forms wird nicht mehr unterstützt. Keine CVE-Patches, keine Fixes für Android 15 / iOS 18. App Stores werden weiterhin Erhöhungen des Target SDK durchsetzen; auf Xamarin.Forms können Sie da nicht mitziehen.
- CollectionView ist das einzige Sammlungs-Control in MAUI, das plattformeigene virtualisierende Sammlungen verwendet (`RecyclerView` auf Android, `UICollectionView` auf iOS). `ListView` existiert in MAUI aus Gründen der Abwärtskompatibilität, ist aber [ein dünner Wrapper, der intern an CollectionView delegiert](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/listview) und nur die alte API-Form erbt, nicht den alten Renderer.
- `ItemsLayout` erlaubt das Umschalten zwischen linearen und Grid-Layouts ohne Subclassing oder Repeater-Tricks. Dasselbe Control deckt das ab, wofür früher `ListView` plus `FlowListView` nötig waren.
- `EmptyView` ist eine echte template-fähige Eigenschaft, kein manueller `IsVisible`-Schalter auf einem Geschwister-Label.

## Was bricht

| Bereich | Xamarin.Forms ListView | MAUI CollectionView | Schweregrad |
| ---- | ---------------------- | ------------------- | -------- |
| Caching-Strategie | `CachingStrategy="RetainElement"` oder `RecycleElement` | Recycelt immer. Eigenschaft existiert nicht. | mittel |
| Zeilenhöhe | `HasUnevenRows`, `RowHeight` | `ItemSizingStrategy="MeasureAllItems"` oder `MeasureFirstItem` | mittel |
| Pull-to-Refresh | `IsPullToRefreshEnabled`, `RefreshCommand` auf `ListView` | In `RefreshView` einbetten | hoch |
| Cell-Typ | `ViewCell`, `TextCell`, `ImageCell` | Schlichtes `DataTemplate` mit beliebigem Layout-Root | hoch |
| Tap-Behandlung | `ItemTapped`, `ItemSelected` | `SelectionMode`, `SelectionChanged`, `SelectionChangedCommand` | hoch |
| Swipe-Aktionen | `ContextActions` | `SwipeView` | hoch |
| Trennlinien | `SeparatorVisibility`, `SeparatorColor` | Keine. `BoxView` im Template hinzufügen. | niedrig |
| Header / Footer | `Header`, `Footer` (Objekt oder Template) | Gleiche Namen, aber nur als Templates / Views | niedrig |
| Gruppierung | `IsGroupingEnabled`, `GroupHeaderTemplate` | `IsGrouped`, `GroupHeaderTemplate`, `GroupFooterTemplate` | mittel |
| Scroll-to | `ScrollTo(item, ScrollToPosition)` | `ScrollTo(item, position, animate)` | niedrig |
| Leerer Zustand | Manuelles Geschwister-Label | `EmptyView`, `EmptyViewTemplate` | niedrig |

Die beiden Änderungen, die wehtun, sind Pull-to-Refresh und Auswahl. Alles andere ist eine reine Umbenennung oder eine Löschung.

## Vorab-Checkliste

1. .NET 11 SDK installiert (`dotnet --version` meldet `11.0.x`). MAUI 11 benötigt das .NET 11 SDK. Frühere SDKs haben das Workload-Manifest nicht.
2. MAUI-Workload installiert: `dotnet workload install maui`. Wenn Sie über eine ältere Installation aktualisiert haben, führen Sie zuerst `dotnet workload repair` aus.
3. Android SDK 35, iOS 18 und Mac Catalyst 18 als Plattformen verfügbar. Visual Studio 2022 17.13 oder Visual Studio Code mit der .NET MAUI Extension 1.6+.
4. Ein `git`-Branch, den Sie verwerfen können. Halten Sie das Xamarin.Forms-Projekt auf `main` kompilierbar, bis der MAUI-Build auf einem echten Gerät grün ist.
5. Eine Liste jeder `ListView`-Instanz im Projekt. Gruppieren Sie sie nach Funktionsbereich; migrieren Sie eine Funktion nach der anderen und liefern Sie hinter einem Feature Flag aus, falls Ihr Release-Rhythmus monatlich ist.
6. Lassen Sie den [.NET Upgrade Assistant](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview) einmal über das Projekt laufen, um die Änderungen an `csproj`, Namespaces und `MauiProgram` abzuwickeln. Der Upgrade Assistant schreibt das `ListView`-XAML nicht für Sie um, das ist Thema des restlichen Beitrags.

## Migrationsschritte

### 1. `ListView` durch `CollectionView` ersetzen

Der einfachste Fall ist eine flache Liste mit einem eigenen `DataTemplate`:

```xml
<!-- Before. Xamarin.Forms 5.0 -->
<ListView ItemsSource="{Binding Articles}"
          CachingStrategy="RecycleElementAndDataTemplate"
          HasUnevenRows="True"
          SeparatorVisibility="None"
          ItemTapped="OnArticleTapped">
    <ListView.ItemTemplate>
        <DataTemplate>
            <ViewCell>
                <Grid Padding="12" RowDefinitions="Auto,Auto">
                    <Label Text="{Binding Title}" FontAttributes="Bold" />
                    <Label Grid.Row="1" Text="{Binding Excerpt}" />
                </Grid>
            </ViewCell>
        </DataTemplate>
    </ListView.ItemTemplate>
</ListView>
```

```xml
<!-- After. .NET MAUI 11.0 -->
<CollectionView ItemsSource="{Binding Articles}"
                SelectionMode="Single"
                SelectionChangedCommand="{Binding OpenArticleCommand}"
                SelectionChangedCommandParameter="{Binding Source={RelativeSource Self}, Path=SelectedItem}">
    <CollectionView.ItemTemplate>
        <DataTemplate x:DataType="vm:ArticleVm">
            <Grid Padding="12" RowDefinitions="Auto,Auto">
                <Label Text="{Binding Title}" FontAttributes="Bold" />
                <Label Grid.Row="1" Text="{Binding Excerpt}" />
            </Grid>
        </DataTemplate>
    </CollectionView.ItemTemplate>
</CollectionView>
```

Was sich geändert hat:

- `ViewCell` ist weg. Das Template-Root ist direkt ein Layout (`Grid`, `VerticalStackLayout` usw.).
- `CachingStrategy` ist weg. Recycling ist immer aktiv. Das alte `RecycleElementAndDataTemplate` ist die nächste Entsprechung und der einzige Modus, der jetzt existiert.
- `HasUnevenRows="True"` ist weg. CollectionView misst standardmäßig jede Zelle. Wenn alle Zeilen gleich groß sind, setzen Sie `ItemSizingStrategy="MeasureFirstItem"` für einen messbaren Performance-Gewinn beim Scrollen auf Android.
- `SeparatorVisibility="None"` ist der neue Standard. Fügen Sie ein `BoxView HeightRequest="1"` ins Template ein, falls Sie tatsächlich eine Trennlinie wollen.
- `x:DataType` am Template aktiviert kompilierte Bindings. Setzen Sie es immer. Die Performance von CollectionView bricht auf Android mit Reflection-Bindings massiv ein.

**Verifizieren**: für Android kompilieren (`dotnet build -t:Run -f net11.0-android35.0`) und eine 1000 Elemente lange Liste auf einem Mittelklasse-Gerät scrollen. Die Frame-Zeit sollte in der Ansicht "Profile GPU Rendering" von Android Studio unter 16 ms liegen. Wenn nicht, prüfen Sie, ob `x:DataType` gesetzt ist und ob im Template kein Binding `Source={x:Reference ...}` verwendet.

### 2. In `RefreshView` einbetten für Pull-to-Refresh

`IsPullToRefreshEnabled`, `IsRefreshing` und `RefreshCommand` liegen nicht mehr auf der Liste. Sie leben auf `RefreshView`, das beliebige scrollbare Inhalte umschließt.

```xml
<!-- After. .NET MAUI 11.0 -->
<RefreshView IsRefreshing="{Binding IsRefreshing}"
             Command="{Binding RefreshCommand}">
    <CollectionView ItemsSource="{Binding Articles}"
                    SelectionMode="Single">
        <CollectionView.ItemTemplate>
            <DataTemplate x:DataType="vm:ArticleVm">
                <!-- as before -->
            </DataTemplate>
        </CollectionView.ItemTemplate>
    </CollectionView>
</RefreshView>
```

`RefreshView` löst nur aus, wenn der umschlossene Scroll-Bereich auf Offset null steht, das Verhalten entspricht also der alten `ListView`. Es gibt kein `IsPullToRefreshEnabled`; um es zu deaktivieren, setzen Sie `IsEnabled="False"` auf der `RefreshView`.

**Verifizieren**: Ziehen Sie die Liste bei Offset null nach unten. Der Plattform-Spinner sollte erscheinen und `RefreshCommand` sollte genau einmal pro Geste auslösen.

### 3. Auswahl umschreiben

Das Xamarin.Forms-Ereignis `ItemTapped` feuert bei jedem Tap, auch wenn sich `SelectedItem` nicht geändert hat. CollectionView trennt das sauber: Tap ist Auswahl, und Auswahl ist über `SelectionChanged` oder `SelectionChangedCommand` beobachtbar. Falls Sie sich auf den Tap verlassen haben, um zweimal hintereinander zum selben Element zu navigieren, müssen Sie aus dem Auswahlzustand aussteigen, indem Sie `SelectedItem` nach jeder Navigation lesen und leeren:

```csharp
// MainViewModel.cs, .NET MAUI 11.0, C# 14
[RelayCommand]
private async Task OpenArticleAsync(ArticleVm? selected)
{
    if (selected is null) return;
    await Shell.Current.GoToAsync(nameof(ArticleDetailPage),
        new Dictionary<string, object> { ["article"] = selected });
    SelectedArticle = null; // re-arm so the same row can fire next time
}
```

`SelectionMode="None"` plus ein `TapGestureRecognizer` im Template ist die nächste Entsprechung zur alten `ItemTapped`-Semantik. Verwenden Sie das nur, wenn es einen Grund dafür gibt. Das auswahlbasierte Muster ist das, was die Plattformen erwarten, und es bringt Ihnen unter Windows kostenlose Fokus-Ringe für die Barrierefreiheit.

**Verifizieren**: Tippen Sie auf ein Element, navigieren Sie zurück, tippen Sie auf dasselbe Element. Beide Taps sollten die Detailseite öffnen.

### 4. `ContextActions` durch `SwipeView` ersetzen

```xml
<!-- Before. Xamarin.Forms 5.0 -->
<ViewCell>
    <ViewCell.ContextActions>
        <MenuItem Text="Delete" IsDestructive="True"
                  Command="{Binding DeleteCommand}" />
    </ViewCell.ContextActions>
    <Grid>...</Grid>
</ViewCell>
```

```xml
<!-- After. .NET MAUI 11.0 -->
<SwipeView>
    <SwipeView.RightItems>
        <SwipeItems Mode="Execute">
            <SwipeItem Text="Delete"
                       BackgroundColor="Crimson"
                       Command="{Binding DeleteCommand}" />
        </SwipeItems>
    </SwipeView.RightItems>
    <Grid>...</Grid>
</SwipeView>
```

`SwipeView` ist eine echte Links-und-Rechts-Wischgeste mit eigenen Hintergründen. `IsDestructive` wird zu einem normalen `BackgroundColor`. `Mode="Execute"` entspricht dem alten Verhalten, beim Tippen zu schließen; `Mode="Reveal"` hält das Menü offen. Das alte Long-Press auf iOS, um ein Menü einzublenden, ist weg; falls Sie es brauchen, verwenden Sie `MenuFlyout` in MAUI 11 (neu in dieser Version).

**Verifizieren**: Wischen Sie auf iOS und Android nach links. Tippen Sie auf "Delete". Das Element wird entfernt. Wischen Sie in der nächsten Zeile erneut, um zu bestätigen, dass immer nur ein Swipe gleichzeitig offen ist.

### 5. Gruppierung umstellen

```xml
<!-- After. .NET MAUI 11.0 -->
<CollectionView ItemsSource="{Binding ArticlesByDay}"
                IsGrouped="True">
    <CollectionView.GroupHeaderTemplate>
        <DataTemplate x:DataType="vm:ArticleDayVm">
            <Label Text="{Binding Day, StringFormat='{0:D}'}"
                   FontAttributes="Bold"
                   Padding="12,8" />
        </DataTemplate>
    </CollectionView.GroupHeaderTemplate>
    <CollectionView.ItemTemplate>
        <DataTemplate x:DataType="vm:ArticleVm">
            <!-- as before -->
        </DataTemplate>
    </CollectionView.ItemTemplate>
</CollectionView>
```

Zwei Dinge ändern sich. Das Flag heißt `IsGrouped`, nicht `IsGroupingEnabled`. Und die Quelle muss eine Sammlung von Sammlungen sein, bei der jedes äußere Element selbst aufzählbar ist. Das sauberste Muster ist eine `Grouping<TKey, TItem>`-Klasse, die von `List<TItem>` erbt und `Key` exponiert. Genau dieses Muster hat Xamarin.Forms verwendet und es portiert unverändert.

**Verifizieren**: Scrollen Sie eine über 30 Tage gruppierte Liste. Gruppen-Header sollten auf iOS standardmäßig oben an ihrer Gruppe haften (`GroupHeadersStick="True"` ist nativ auf iOS; der MAUI-Standard spiegelt das wider).

### 6. Ein `ItemsLayout` wählen

Standard ist `LinearItemsLayout` vertikal, was `ListView` entspricht. Wechsel zu einem Grid mit einer einzigen Zeile:

```xml
<CollectionView ItemsSource="{Binding Photos}">
    <CollectionView.ItemsLayout>
        <GridItemsLayout Orientation="Vertical"
                         Span="3"
                         HorizontalItemSpacing="4"
                         VerticalItemSpacing="4" />
    </CollectionView.ItemsLayout>
    <CollectionView.ItemTemplate>
        <DataTemplate x:DataType="vm:PhotoVm">
            <Image Source="{Binding ThumbnailUrl}" Aspect="AspectFill" />
        </DataTemplate>
    </CollectionView.ItemTemplate>
</CollectionView>
```

`Span="3"` ist eine feste Spaltenanzahl. Es gibt kein eingebautes adaptives Grid; dafür dimensionieren Sie die Zellen anhand der verfügbaren Breite mit einem Behavior oder binden bei Größenänderungen neu.

**Verifizieren**: Drehen Sie das Gerät. Das Grid sollte sich neu zeichnen, ohne die Scroll-Position zu verlieren.

### 7. Eine `EmptyView` hinzufügen

```xml
<CollectionView ItemsSource="{Binding Articles}">
    <CollectionView.EmptyView>
        <VerticalStackLayout HorizontalOptions="Center"
                             VerticalOptions="Center" Spacing="8">
            <Label Text="No articles yet" FontSize="18" />
            <Button Text="Refresh" Command="{Binding RefreshCommand}" />
        </VerticalStackLayout>
    </CollectionView.EmptyView>
</CollectionView>
```

Für mehrere leere Zustände (keine Daten vs. Fehler) binden Sie `EmptyView` an eine Eigenschaft und verwenden `EmptyViewTemplate` mit einem `DataTemplateSelector`.

**Verifizieren**: Quelle leeren. Empty-View erscheint. Quelle wieder befüllen. Empty-View verschwindet ohne ein Frame Überlappung.

## Verifizierungs-Checkliste

Nachdem jede Liste migriert ist:

- `dotnet build -c Release` für `net11.0-android35.0`, `net11.0-ios18.0`, `net11.0-maccatalyst18.0` und `net11.0-windows10.0.19041.0` produziert null Warnungen über veraltete `ListView`-APIs.
- `dotnet test` gegen die ViewModel-Schicht ist grün. Auswahl-Logik ist die wahrscheinlichste Regression; decken Sie sie ab.
- Auf Android scrollen Sie eine 1000-Elemente-Liste auf einem Pixel 6 oder Vergleichbarem. Die Frame-Zeit bleibt mit `MeasureFirstItem` unter 16 ms, wenn die Zeilen einheitlich sind. Mit `MeasureAllItems` und 1000 Elementen ist beim ersten Anzeigen ein einmaliger Mess-Aufwand zu erwarten.
- Auf iOS halten Sie den Finger auf einer Zeile. Nach dem Loslassen sollte bei `SelectionMode="None"` keine Auswahl-Rückmeldung zurückbleiben.
- Pull-to-Refresh feuert auf jeder Plattform genau einmal pro Geste.
- Swipe-Aktionen erscheinen auf der korrekten Seite (RTL-Sprachen spiegeln automatisch; verifizieren Sie in einer arabischen Locale, falls Sie eine ausliefern).
- `EmptyView` wird von VoiceOver / TalkBack vorgelesen. CollectionView liefert für den leeren Zustand automatisch Texte für die Barrierefreiheit; ein manuelles `SemanticProperties.Description` überschreibt sie.

## Rollback-Plan

In der Praxis ist dies eine Einbahn-Migration. Sobald das Projekt auf `net11.0-*` Target Frameworks und `MauiProgram.cs` läuft, bedeutet ein Rückweg zu Xamarin.Forms, die alte `csproj`-Form, das `Xamarin.Forms.Forms.Init` und plattformspezifische App-Einstiegspunkte wiederherzustellen. Nichts in diesem Beitrag über CollectionView selbst ist getrennt vom Projekt-Upgrade rückgängig zu machen. Planen Sie ein, einen funktionierenden MAUI-Build auszuliefern, bevor Sie den Xamarin.Forms-Branch löschen.

## Stolperfallen, die uns getroffen haben

- `ItemTapped`-Semantik. Falls Ihr alter Code in `ItemTapped` `ListView.SelectedItem = null` aufgerufen hat, damit dieselbe Zeile zweimal antippbar ist, müssen Sie `SelectedItem` (oder `SelectedItems`) auch weiterhin nach jeder Navigation leeren. CollectionView leert nicht automatisch.
- `RemainingItemsThreshold` für Infinite Scroll liegt auf CollectionView (`RemainingItemsThreshold` plus `RemainingItemsThresholdReachedCommand`). Das alte `ItemAppearing`-Muster funktioniert weiter, feuert aber pro Element; das Threshold-Muster feuert einmalig nahe dem Ende, was die meisten Infinite-Scroll-UIs eigentlich wollen.
- `ScrollTo` nimmt keinen `ScrollToPosition`-Enum-Wert von `MakeVisible` mehr. Die nächste Zuordnung ist `ScrollToPosition.MakeVisible` zu `ScrollToPosition.MakeVisible` (gleicher Name, gleiches Enum), aber das zweite Argument ist jetzt der Gruppen-Index. Für eine ungruppierte Liste übergeben Sie `null`. Lesen Sie die [CollectionView ScrollTo Doku](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/collectionview/scrolling), bevor Sie eigene Scroll-Logik portieren.
- Kompilierte Bindings (`x:DataType`) sind für die Performance Pflicht. Ohne sie ruckelt das Scrollen auf Android, weil jedes Binding bei jedem Recycle über Reflection aufgelöst wird.
- `ItemSizingStrategy.MeasureAllItems` auf einer langen Liste mit variabler Höhe erzwingt beim ersten Anzeigen einen vollständigen Mess-Durchlauf. Wenn Sie zehntausend Elemente haben und die Liste das Erste auf dem Bildschirm ist, verschlechtert sich Ihre Time-to-First-Frame. Verwenden Sie eine feste Zellenhöhe, wo immer möglich.
- Eigene `ViewCell`-Renderer portieren nicht. In MAUI gibt es keinen `ViewCellRenderer`. Hatten Sie einen, wird die Zelle in MAUI zu einem normalen Layout, und die Renderer-Logik wandert in einen [Handler](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/) auf dem Kind-Control, das sie tatsächlich brauchte.
- `TableView` existiert in MAUI weiterhin für statische, settings-artige Bildschirme. Verwenden Sie es nicht für dynamische Daten. Es virtualisiert nicht.

## Verwandt

- [So unterstützen Sie Dark Mode korrekt in einer MAUI-App](/de/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) behandelt die `AppThemeBinding`-Muster, die Templates innerhalb von CollectionView benötigen.
- [So implementieren Sie Drag-and-Drop in MAUI 11](/de/2026/05/how-to-implement-drag-and-drop-in-maui-11/) zeigt, wie Sie `DragGestureRecognizer` mit `CollectionView`-Elementen kombinieren, was der moderne Ersatz für das ListView-Reordering ist.
- [So paketieren Sie eine MAUI-App für den Microsoft Store](/de/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) ist der nächste Schritt, sobald die Migration abgeschlossen ist und Sie wieder unter Windows ausliefern wollen.
- [So schreiben Sie eine MAUI-App, die nur unter Windows und macOS läuft](/de/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) ist die richtige Referenz, falls Sie bei einem Xamarin.Forms-Projekt gleichzeitig Mobile abstreifen.

## Quellen

- [.NET MAUI CollectionView Dokumentation](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/collectionview/)
- [.NET MAUI ListView Dokumentation](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/listview)
- [Xamarin.Forms Support-Richtlinie](https://dotnet.microsoft.com/en-us/platform/support/policy/maui)
- [Upgrade von Xamarin.Forms](https://learn.microsoft.com/en-us/dotnet/maui/migration/) auf MS Learn
- [.NET Upgrade Assistant](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview)

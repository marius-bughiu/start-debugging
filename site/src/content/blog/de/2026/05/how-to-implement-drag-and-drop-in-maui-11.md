---
title: "Drag-and-Drop in .NET MAUI 11 implementieren"
description: "End-to-End-Drag-and-Drop in .NET MAUI 11: DragGestureRecognizer, DropGestureRecognizer, eigene DataPackage-Payloads, AcceptedOperation, Gestenposition und die plattformspezifischen PlatformArgs-Fallen unter Android, iOS, Mac Catalyst und Windows."
pubDate: 2026-05-03
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "drag-and-drop"
  - "gestures"
  - "how-to"
lang: "de"
translationOf: "2026/05/how-to-implement-drag-and-drop-in-maui-11"
translatedBy: "claude"
translationDate: 2026-05-03
---

Kurze Antwort: In .NET MAUI 11 hängen Sie einen `DragGestureRecognizer` an die Quell-`View` und einen `DropGestureRecognizer` an die Ziel-`View` über deren `GestureRecognizers`-Auflistung. Für Text und Bilder auf eingebauten Steuerelementen (`Label`, `Entry`, `Image`, `Button` und Verwandten) verdrahtet das Framework das `DataPackage` für Sie, sodass der abgelegte Wert automatisch ankommt. Für alles andere füllen Sie `e.Data` im `DragStarting`-Handler und lesen es aus `e.Data` (einem `DataPackageView`) im `Drop`-Handler. Setzen Sie `e.AcceptedOperation = DataPackageOperation.Copy` oder `None` in `DragOver`, um den Cursor zu steuern, und greifen Sie in `e.PlatformArgs`, wenn Sie eine eigene Drag-Vorschau, eine Move-Operation oder das Lesen von Dateien aus einer anderen App benötigen.

Dieser Beitrag geht die gesamte API-Oberfläche mit ausführbarem XAML und C# für .NET MAUI 11.0.0 auf .NET 11 durch, einschließlich der Teile, die die offizielle Dokumentation überspringt: wie `DataPackagePropertySet` verwaltete Objekte tatsächlich verschiebt, warum Ihre Move-Operation unter Android still auf Copy zurückfällt, warum Ihre eigene Form beim zweiten Drag `null` ist und wie Sie einen Dateipfad lesen, wenn der Drop aus dem Datei-Explorer oder Photos kommt. Alles unten wurde gegen `dotnet new maui` aus dem .NET 11 SDK mit `Microsoft.Maui.Controls` 11.0.0 verifiziert.

## Warum Drag-and-Drop in MAUI interessanter ist, als es aussieht

Die beiden Gesten-Recognizer, `DragGestureRecognizer` und `DropGestureRecognizer`, wurden aus Xamarin.Forms 5 übernommen und sind seit dem allerersten MAUI-Release dabei. Die Form der API hat sich in MAUI 11 nicht geändert, aber die plattformspezifische Geschichte hat sich deutlich verbessert: Die `PlatformArgs`-Eigenschaften, die in MAUI 9 ankamen, sind jetzt über alle vier unterstützten Heads hinweg stabil, was bedeutet, dass Sie endlich Dinge wie eigene Drag-Vorschauen unter iOS, Mehrdatei-Drops aus dem Windows-Datei-Explorer und `UIDropOperation.Move` auf Mac Catalyst tun können, ohne in einen eigenen Handler abzutauchen.

Was Sie verinnerlichen sollten, bevor Sie auch nur eine Zeile Code schreiben: Die Gesten-Recognizer sind die MAUI-Abstraktion über vier sehr verschiedene native Systeme. Android verwendet `View.startDragAndDrop` mit `ClipData`, iOS und Mac Catalyst verwenden `UIDragInteraction` und `NSItemProvider`, Windows verwendet die WinRT-`DragDrop`-Infrastruktur auf `FrameworkElement`. Das plattformübergreifende `DataPackage` transportiert Text, ein Bild und einen `Dictionary<string, object>`-Eigenschaftsbeutel. Alles, was Sie in diesen Eigenschaftsbeutel legen, ist **prozesslokal**, weil die zugrunde liegenden nativen Systeme nur Text, Bilder und Datei-URIs über Anwendungsgrenzen hinweg marshallen können. Das ist die größte Quelle der Überraschung, wenn Entwickler von In-App-Drag zu Inter-App-Drag wechseln.

Wenn Sie von Xamarin.Forms kommen, muss keiner Ihrer bestehenden Handler geändert werden. Die Klassennamen, die Event-Signaturen und das `DataPackageOperation`-Enum sind byte-identisch. Die `PlatformArgs`-Geschichte ist neu; der Rest ist derselbe Code, der 2020 ausgeliefert wurde.

## Ein Text-Label ziehen und auf einem Entry ablegen

Beginnen Sie mit dem kleinsten nützlichen Fall: einen Textwert von einem `Label` ziehen und auf einem `Entry` ablegen. Da beides eingebaute Text-Steuerelemente sind, füllt MAUI das `DataPackage` und liest es automatisch zurück, sodass das gesamte Feature in XAML steckt.

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<VerticalStackLayout Padding="20" Spacing="20">
    <Label Text="Drag this label"
           FontSize="20">
        <Label.GestureRecognizers>
            <DragGestureRecognizer />
        </Label.GestureRecognizers>
    </Label>

    <Entry Placeholder="Drop here">
        <Entry.GestureRecognizers>
            <DropGestureRecognizer />
        </Entry.GestureRecognizers>
    </Entry>
</VerticalStackLayout>
```

Eine Drag-Geste wird mit einem Long-Press gefolgt von einem Drag auf Touch-Plattformen ausgelöst und mit einem normalen Mouse-Down-and-Move unter Windows und Mac Catalyst. Es ist kein Code-Behind erforderlich: MAUI liest `Label.Text` beim Hinausgehen in `DataPackage.Text` und schreibt `DataPackage.Text` beim Hereinkommen in `Entry.Text`.

Dieselbe Auto-Verdrahtung deckt `CheckBox.IsChecked`, `DatePicker.Date`, `Editor.Text`, `RadioButton.IsChecked`, `Switch.IsToggled` und `TimePicker.Time` sowohl auf Quell- als auch auf Zielseite ab, plus Bilder auf `Button`, `Image` und `ImageButton`. Die Booleans und Daten werden über `string`-Round-Trips konvertiert, was bedeutet, dass ein fehlerhaft geformter Drop (den Text "yes" auf eine `CheckBox` ziehen) still daran scheitert, `IsChecked` umzuschalten.

## Eine Karte zwischen zwei Spalten verschieben

Der interessante Fall ist Ihre eigene Oberfläche: ein Board mit Karten, die Sie zwischen Spalten ziehen wollen. Das `DataPackage` kann kein verwaltetes Objekt prozessübergreifend transportieren, aber für In-App-Drag kann es das absolut über `Properties`.

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<Grid ColumnDefinitions="*,*" Padding="20" ColumnSpacing="20">
    <VerticalStackLayout x:Name="TodoColumn" Grid.Column="0" Spacing="8">
        <VerticalStackLayout.GestureRecognizers>
            <DropGestureRecognizer DragOver="OnDragOver" Drop="OnDrop" />
        </VerticalStackLayout.GestureRecognizers>
        <Label Text="To do" FontAttributes="Bold" />
    </VerticalStackLayout>

    <VerticalStackLayout x:Name="DoneColumn" Grid.Column="1" Spacing="8">
        <VerticalStackLayout.GestureRecognizers>
            <DropGestureRecognizer DragOver="OnDragOver" Drop="OnDrop" />
        </VerticalStackLayout.GestureRecognizers>
        <Label Text="Done" FontAttributes="Bold" />
    </VerticalStackLayout>
</Grid>
```

Jede Karte wird im Code gebaut und erhält ihren eigenen `DragGestureRecognizer`:

```csharp
// .NET MAUI 11.0.0, .NET 11
public record Card(Guid Id, string Title);

Border BuildCardView(Card card)
{
    var border = new Border
    {
        Padding = 12,
        StrokeThickness = 1,
        BindingContext = card,
        Content = new Label { Text = card.Title }
    };

    var drag = new DragGestureRecognizer();
    drag.DragStarting += (s, e) =>
    {
        e.Data.Properties["Card"] = card;
        e.Data.Text = card.Title; // fallback for inter-app drops
    };
    border.GestureRecognizers.Add(drag);

    return border;
}
```

Das `DragStarting`-Event empfängt ein `DragStartingEventArgs`, dessen `Data`-Eigenschaft ein frisches `DataPackage` pro Drag ist. `e.Data.Properties["Card"]` zu setzen, speichert die tatsächliche `Card`-Referenz in einem `Dictionary<string, object>`. Auf der Drop-Seite greifen Sie auf dasselbe Dictionary zu:

```csharp
// .NET MAUI 11.0.0, .NET 11
void OnDragOver(object sender, DragEventArgs e)
{
    e.AcceptedOperation = e.Data.Properties.ContainsKey("Card")
        ? DataPackageOperation.Copy
        : DataPackageOperation.None;
}

void OnDrop(object sender, DropEventArgs e)
{
    if (e.Data.Properties.TryGetValue("Card", out var value) && value is Card card)
    {
        var targetColumn = (VerticalStackLayout)sender;
        MoveCard(card, targetColumn);
        e.Handled = true;
    }
}
```

Hier passieren zwei nicht offensichtliche Dinge.

Erstens ist `e.Data` auf einem `DropEventArgs` ein `DataPackageView`, kein `DataPackage`. Es ist absichtlich schreibgeschützt: Das Drop-Ziel kann das Paket nicht verändern. Sie lesen `Properties` (ein `DataPackagePropertySetView`) und rufen `await e.Data.GetTextAsync()` oder `await e.Data.GetImageAsync()` für die vorbereiteten Text- und Bild-Slots auf. Die asynchronen Methoden geben `Task<string?>` bzw. `Task<ImageSource?>` zurück.

Zweitens teilt `e.Handled = true` im `Drop`-Handler MAUI mit, sein Standardverhalten nicht anzuwenden. Das ist wichtig, wenn Ihr Drop-Ziel ein `Label` oder `Image` ist, denn sonst versucht MAUI *zusätzlich*, den Text oder das Bild aus dem Datenpaket über das zu setzen, was Sie manuell gemacht haben, was zu einem schmerzhaft nachzuvollziehenden Doppel-Update-Bug führt.

## Die richtige `AcceptedOperation` wählen

Das `DragOver`-Event feuert kontinuierlich, solange der Zeiger über einem Drop-Ziel ist. Seine Aufgabe ist es, `e.AcceptedOperation` zu setzen, was den Cursor unter Windows und Mac Catalyst sowie das System-Feedback unter iOS bestimmt. Das `DataPackageOperation`-Enum hat genau zwei Werte, die mit MAUI ausgeliefert werden: `Copy` und `None`. Es gibt kein `Move`, kein `Link`, keine Flag-Kombinationen, unabhängig davon, was IntelliSense vorschlägt, wenn Sie `Windows.ApplicationModel.DataTransfer` referenziert haben.

```csharp
// .NET MAUI 11.0.0, .NET 11
void OnDragOver(object sender, DragEventArgs e)
{
    var canAccept = e.Data.Properties.ContainsKey("Card");
    e.AcceptedOperation = canAccept
        ? DataPackageOperation.Copy
        : DataPackageOperation.None;
}
```

Wenn ein `DragEventArgs` konstruiert wird, ist `AcceptedOperation` standardmäßig `Copy`. Wenn Sie eine Spalte wollen, die alle Drops ablehnt (zum Beispiel eine schreibgeschützte "Archiv"-Spalte im Ansichtsmodus), müssen Sie sie aktiv in `DragOver` auf `None` setzen. Das zu vergessen, ist der häufigste Grund, warum ein Ziel versehentlich alles akzeptiert.

Um eine Move-Semantik unter iOS und Mac Catalyst zu erreichen, wo das System Copy und Move tatsächlich mit einem sichtbaren Badge unterscheidet, steigen Sie in `PlatformArgs` ab:

```csharp
// .NET MAUI 11.0.0, .NET 11, iOS / Mac Catalyst
void OnDragOver(object sender, DragEventArgs e)
{
#if IOS || MACCATALYST
    e.PlatformArgs?.SetDropProposal(
        new UIKit.UIDropProposal(UIKit.UIDropOperation.Move));
#endif
}
```

Unter Android hat Drag-and-Drop keine Copy-versus-Move-Unterscheidung auf der App-übergreifenden Ebene, sodass die `AcceptedOperation`-Eigenschaft nur die In-App-Affordance steuert. Unter Windows wird der `Copy`-versus-`None`-Cursor direkt von `AcceptedOperation` gesteuert.

## Die Drag-Vorschau anpassen

Die Standard-Drag-Vorschau ist ein Snapshot der Quell-View, was meist ausreicht. Wenn nicht, stellt jede Plattform ihren eigenen Vorschau-Hook über `PlatformArgs` zur Verfügung.

```csharp
// .NET MAUI 11.0.0, .NET 11
void OnDragStarting(object sender, DragStartingEventArgs e)
{
#if IOS || MACCATALYST
    e.PlatformArgs?.SetPreviewProvider(() =>
    {
        var image = UIKit.UIImage.FromFile("dotnet_bot.png");
        var imageView = new UIKit.UIImageView(image)
        {
            Frame = new CoreGraphics.CGRect(0, 0, 200, 200),
            ContentMode = UIKit.UIViewContentMode.ScaleAspectFit
        };
        return new UIKit.UIDragPreview(imageView);
    });
#elif ANDROID
    var view = (Android.Views.View)((Microsoft.Maui.Controls.View)sender).Handler!.PlatformView!;
    e.PlatformArgs?.SetDragShadowBuilder(new Android.Views.View.DragShadowBuilder(view));
#endif
}
```

Unter Android steuert `SetDragShadowBuilder` den Schatten, der dem Finger folgt; unter iOS und Mac Catalyst gibt `SetPreviewProvider` ein `UIDragPreview` zurück; unter Windows setzen Sie die Eigenschaften von `e.PlatformArgs.DragStartingEventArgs.DragUI` und denken Sie daran, `e.PlatformArgs.Handled = true` zu setzen, damit MAUI Ihre Änderungen nicht überschreibt.

Diese `Handled`-Flag ist die einfachste Falle in der gesamten API: Unter Windows ist jedes `PlatformArgs` ein dünner Wrapper um ein WinRT-Event-Args-Objekt, und jede Eigenschaft, die Sie setzen, wird still durch MAUIs Standard-Verdrahtung überschrieben, es sei denn, Sie setzen `Handled = true` auf den Platform-Args selbst (getrennt von `DragEventArgs.Handled` und `DropEventArgs.Handled`, die die Verarbeitung auf MAUI-Ebene steuern).

## Die Position des Drops abrufen

In MAUI 11 stellen alle drei Event-Args (`DragStartingEventArgs`, `DragEventArgs` und `DropEventArgs`) eine `GetPosition(Element?)`-Methode bereit, die `Point?` zurückgibt. Übergeben Sie `null` für Bildschirmkoordinaten oder ein Element, um Koordinaten relativ zu diesem Element zu erhalten.

```csharp
// .NET MAUI 11.0.0, .NET 11
void OnDrop(object sender, DropEventArgs e)
{
    var canvas = (Layout)sender;
    var point = e.GetPosition(canvas);
    if (point is { } p)
    {
        AbsoluteLayout.SetLayoutBounds(_draggedView!,
            new Rect(p.X, p.Y, AbsoluteLayout.AutoSize, AbsoluteLayout.AutoSize));
    }
}
```

Wenn Sie sich an den alten Workaround erinnern, `MotionEvent.GetX/Y` aus dem Android-`PlatformArgs.DragEvent` und `LocationInView` aus dem iOS-`DropSession` zu lesen, brauchen Sie das nicht mehr. `GetPosition` gibt nur dann `null` zurück, wenn die Plattform tatsächlich keine Position gemeldet hat (selten, aber behandeln Sie das Nullable als tragend).

## Eine Datei aus einer anderen Anwendung empfangen

Inter-App-Drag wird unter iOS, Mac Catalyst und Windows unterstützt. Android kann über die Gesten-Recognizer-API kein Drop-Ziel für Elemente aus einer anderen App sein.

Die Form der Daten ist plattformspezifisch, weil das prozessübergreifende Payload immer nativ ist: eine `UIDragItem`-Auflistung unter iOS und Mac Catalyst, ein `DataPackageView` unter Windows. MAUI gibt Ihnen die nativen Objekte über `PlatformArgs`.

```csharp
// .NET MAUI 11.0.0, .NET 11, Windows
async void OnDrop(object sender, DropEventArgs e)
{
#if WINDOWS
    var view = e.PlatformArgs?.DragEventArgs.DataView;
    if (view is null || !view.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.StorageItems))
        return;

    var items = await view.GetStorageItemsAsync();
    foreach (var item in items)
    {
        if (item is Windows.Storage.StorageFile file)
            HandleDroppedFile(file.Path);
    }
#endif
}
```

Die iOS/Mac-Catalyst-Variante verwendet `e.PlatformArgs.DropSession.Items` und bittet jeden `NSItemProvider`, eine In-Place-Dateirepräsentation zu laden. Das vollständige Muster aus den .NET MAUI-Samples ist auf Microsoft Learn unter [Drag and drop between applications](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/gestures/drag-and-drop?view=net-maui-10.0#drag-and-drop-between-applications) dokumentiert.

Auf beiden Plattformen läuft der `Drop`-Handler auf dem UI-Thread, und die Datei ist noch nicht kopiert. Wenn Sie die Bytes brauchen, kopieren Sie sie innerhalb des Handlers, bevor Sie zurückkehren, denn die Quell-App darf die Drag-Session widerrufen, sobald Ihr Handler fertig ist.

## Fünf Fallen, die einen Nachmittag fressen

**1. Das `DataPackage` ist Single-Shot.** Jede Drag-Geste erzeugt ein neues `DataPackage`. Wenn Sie `e.Data` cachen und es später aus einem anderen Drop lesen, erhalten Sie die Daten aus dem *ursprünglichen* Drag, nicht aus dem aktuellen, was die Quelle des "die zweite Karte, die ich ziehe, ist falsch"-Bugs ist.

**2. `Properties` ist prozesslokal.** Alles, was Sie in `e.Data.Properties` legen, funktioniert tadellos innerhalb Ihrer App und ist app-übergreifend unsichtbar. Wenn Sie ein Payload wollen, das einen App-übergreifenden Drop überlebt, setzen Sie zusätzlich `e.Data.Text` (oder schreiben Sie unter Android in `PlatformArgs.SetClipData`, unter iOS in `SetItemProvider`), damit das System etwas Konkretes zum Marshallen hat.

**3. Der Standard-Drop auf `Label`/`Image`/`Entry` feuert immer.** Wenn Sie `Drop` behandeln und das Ziel manuell aktualisieren, setzen Sie `e.Handled = true`, sonst läuft MAUIs automatische Text- oder Bildzuweisung nach Ihrem Handler und überschreibt das Ergebnis.

**4. `DropGestureRecognizer` bubbelt nicht.** Jedes visuelle Element hat entweder einen Recognizer oder nicht. Wenn Sie den Recognizer auf ein Eltern-`Grid` setzen und das Kind-`Border` keinen eigenen Recognizer hat, funktioniert die Geste wie erwartet; aber wenn das Kind irgendeinen anderen Gesten-Recognizer hat, kann das Hit-Testing für den Drop auf dem Kind landen und das Eltern-Element überspringen. Seien Sie explizit: Setzen Sie den Drop-Recognizer auf das tiefste Element, das den Drop akzeptieren soll.

**5. Android-Drag-and-Drop benötigt eine `View`, die am Hit-Testing teilnimmt.** Ein `Label` mit `InputTransparent="True"` weigert sich still, einen Drag zu starten, und ein `BoxView` ohne Hintergrundfarbe fängt nur Gesten über dem Rechteck ab, das der Rasterizer tatsächlich zeichnet. Wenn Ihr Drag unter Android nie startet, setzen Sie ein `BackgroundColor` auf die Quell-View als Sanity-Check, bevor Sie zu `Handler`-Overrides greifen.

## Bausteine für reichere Interaktionen

Drag-and-Drop ist der reibungsärmste Weg, einer Desktop- oder Tablet-MAUI-App direkte Manipulation hinzuzufügen, aber die Gesten-Recognizer sind auch der Baustein, zu dem Sie greifen, wenn Sie eine umsortierbare Liste, ein Tab-Tear-Out-Fenster oder ein Trello-artiges Board schreiben. Keines davon setzt sich heute zu einem einzelnen Bibliotheks-Steuerelement zusammen, weshalb jede ernsthafte MAUI-Desktop-App ihr eigenes baut. Die gute Nachricht ist, dass die zugrunde liegende API klein genug ist, dass "ihr eigenes baut" meist einhundert Zeilen Code bedeutet, von denen die meisten die plattformspezifische Vorschau-Anpassung sind und nicht die Gesten-Behandlung selbst.

Wenn Sie einen reinen Desktop-MAUI-Head bauen, geht der Rest der [reinen Windows-und-macOS-MAUI-11-Einrichtung](/de/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) durch, wie Sie die mobilen Target-Frameworks abstreifen, sodass `dotnet build` keine Android- und iOS-Workloads mehr mitschleppt. Für eine Tour durch das, was sonst neu im Framework ist, sehen Sie sich [was neu in .NET MAUI 10 ist](/de/2025/04/whats-new-in-net-maui-10/) an, das die `PlatformArgs`-Ergänzungen abdeckt, von denen dieser Beitrag abhängt. Wenn Sie Theme-Farben überschreiben müssen, die in Ihrer Drag-Vorschau auftauchen, verallgemeinert sich dasselbe Handler-Muster aus [wie man die Icon-Farbe der SearchBar in .NET MAUI ändert](/de/2025/04/how-to-change-searchbars-icon-color-in-net-maui/) auf die meisten nativen Vorschau-Anpassungen. Und wenn Ihre App eine Klassenbibliothek ist, die diese Gesten beherbergt, deckt [wie man Handler in einer MAUI-Bibliothek registriert](/de/2023/11/maui-library-register-handlers/) die `MauiAppBuilder`-Verdrahtung ab, die Sie brauchen, damit die Recognizer beim Start der konsumierenden App auch tatsächlich anhängen.

## Quellen

- [Recognize a drag and drop gesture - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/gestures/drag-and-drop?view=net-maui-10.0)
- [DragGestureRecognizer Class - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.draggesturerecognizer)
- [DropGestureRecognizer Class - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.dropgesturerecognizer)
- [DataPackage Class - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.datapackage)
- [.NET MAUI Drag and Drop Gesture sample](https://learn.microsoft.com/en-us/samples/dotnet/maui-samples/gestures-draganddropgesture/)

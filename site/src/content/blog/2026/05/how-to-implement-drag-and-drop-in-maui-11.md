---
title: "How to implement drag-and-drop in .NET MAUI 11"
description: "End-to-end drag-and-drop in .NET MAUI 11: DragGestureRecognizer, DropGestureRecognizer, custom DataPackage payloads, AcceptedOperation, gesture position, and the per-platform PlatformArgs traps on Android, iOS, Mac Catalyst, and Windows."
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
---

Short answer: in .NET MAUI 11, attach a `DragGestureRecognizer` to the source `View` and a `DropGestureRecognizer` to the target `View` through their `GestureRecognizers` collection. For text and images on built-in controls (`Label`, `Entry`, `Image`, `Button`, and friends) the framework wires the `DataPackage` for you, so the dropped value lands automatically. For anything else, populate `e.Data` in the `DragStarting` handler and read it from `e.Data` (a `DataPackageView`) in the `Drop` handler. Set `e.AcceptedOperation = DataPackageOperation.Copy` or `None` in `DragOver` to control the cursor, and reach into `e.PlatformArgs` when you need a custom drag preview, a Move operation, or to read files dropped from another app.

This post walks through the full API surface with runnable XAML and C# for .NET MAUI 11.0.0 on .NET 11, including the parts the official docs gloss over: how `DataPackagePropertySet` actually moves managed objects, why your Move operation silently downgrades to Copy on Android, why your custom shape is `null` on the second drag, and how to read a file path when the drop comes from File Explorer or Photos. Everything below was verified against `dotnet new maui` from the .NET 11 SDK with `Microsoft.Maui.Controls` 11.0.0.

## Why drag-and-drop in MAUI is more interesting than it looks

The two gesture recognizers, `DragGestureRecognizer` and `DropGestureRecognizer`, were inherited from Xamarin.Forms 5 and have been in the box since the very first MAUI release. The shape of the API has not changed in MAUI 11, but the platform-specific story has improved meaningfully: the `PlatformArgs` properties that landed in MAUI 9 are now stable across all four supported heads, which means you can finally do things like custom drag previews on iOS, multi-file drops from Windows File Explorer, and `UIDropOperation.Move` on Mac Catalyst without dropping into a custom handler.

The thing to internalize before writing any code: the gesture recognizers are MAUI's abstraction over four very different native systems. Android uses `View.startDragAndDrop` with `ClipData`, iOS and Mac Catalyst use `UIDragInteraction` and `NSItemProvider`, Windows uses the WinRT `DragDrop` infrastructure on `FrameworkElement`. The cross-platform `DataPackage` carries text, an image, and a `Dictionary<string, object>` property bag. Anything you put in that property bag is **process-local**, because the underlying native systems can only marshal text, images, and file URIs across application boundaries. That is the single biggest source of surprise when developers move from in-app drag to inter-app drag.

If you are coming from Xamarin.Forms, none of your existing handlers need to change. The class names, the event signatures, and the `DataPackageOperation` enum are byte-identical. The `PlatformArgs` story is new; the rest is the same code that shipped in 2020.

## Drag a text label and drop it on an Entry

Start with the smallest useful thing: dragging a text value from a `Label` and dropping it on an `Entry`. Because both are built-in text controls, MAUI populates the `DataPackage` and reads it back automatically, so the entire feature is XAML.

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

A drag gesture is initiated with a long-press followed by a drag on touch platforms, and with a normal mouse-down-and-move on Windows and Mac Catalyst. There is no code-behind required: MAUI reads `Label.Text` into `DataPackage.Text` on the way out, and writes `DataPackage.Text` into `Entry.Text` on the way in.

The same auto-wiring covers `CheckBox.IsChecked`, `DatePicker.Date`, `Editor.Text`, `RadioButton.IsChecked`, `Switch.IsToggled`, and `TimePicker.Time` on the source and destination side, plus images on `Button`, `Image`, and `ImageButton`. The booleans and dates are converted through `string` round-trips, which means a malformed drop (dragging the text "yes" into a `CheckBox`) silently fails to flip `IsChecked`.

## Move a card between two columns

The interesting case is your own UI: a board with cards that you want to drag between columns. The `DataPackage` cannot carry a managed object across processes, but for in-app drag it absolutely can carry one through `Properties`.

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

Each card is built in code and given its own `DragGestureRecognizer`:

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

The `DragStarting` event receives a `DragStartingEventArgs` whose `Data` property is a fresh `DataPackage` per drag. Setting `e.Data.Properties["Card"]` stores the actual `Card` reference in a `Dictionary<string, object>`. On the drop side you reach into the same dictionary:

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

Two non-obvious things are happening here.

First, `e.Data` on a `DropEventArgs` is a `DataPackageView`, not a `DataPackage`. It is intentionally read-only: the drop target cannot mutate the package. You read `Properties` (a `DataPackagePropertySetView`), and you call `await e.Data.GetTextAsync()` or `await e.Data.GetImageAsync()` for the canned text and image slots. The async methods return `Task<string?>` and `Task<ImageSource?>` respectively.

Second, setting `e.Handled = true` in the `Drop` handler tells MAUI not to apply its default behavior. That matters when your drop target is a `Label` or `Image`, because otherwise MAUI will *also* attempt to set the text or image from the data package on top of whatever you did manually, leading to a double-update bug that is painful to track down.

## Pick the right `AcceptedOperation`

The `DragOver` event fires continuously while the pointer is over a drop target. Its job is to set `e.AcceptedOperation`, which determines the cursor visual on Windows and Mac Catalyst and the system feedback on iOS. The `DataPackageOperation` enum has exactly two values that ship with MAUI: `Copy` and `None`. There is no `Move`, no `Link`, no flag combination, regardless of what IntelliSense suggests if you have referenced `Windows.ApplicationModel.DataTransfer`.

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

When a `DragEventArgs` is constructed, `AcceptedOperation` defaults to `Copy`. If you want a column that rejects all drops (for example, a read-only "Archive" column when in view mode), you have to actively set it to `None` in `DragOver`. Forgetting that is the most common reason a target accidentally accepts everything.

To get a Move semantic on iOS and Mac Catalyst, where the system actually distinguishes Copy from Move with a visible badge, drop into `PlatformArgs`:

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

On Android, drag-and-drop has no Copy versus Move distinction at the cross-app layer, so the `AcceptedOperation` property only controls the in-app affordance. On Windows, the `Copy` versus `None` cursor is driven from `AcceptedOperation` directly.

## Customize the drag preview

The default drag preview is a snapshot of the source view, which is usually fine. When it is not, each platform exposes its own preview hook through `PlatformArgs`.

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

On Android, `SetDragShadowBuilder` controls the shadow that follows the finger; on iOS and Mac Catalyst, `SetPreviewProvider` returns a `UIDragPreview`; on Windows, set `e.PlatformArgs.DragStartingEventArgs.DragUI` properties and remember to set `e.PlatformArgs.Handled = true` so MAUI does not overwrite your changes.

That `Handled` flag is the easiest gotcha in the whole API: on Windows, every `PlatformArgs` is a thin shim around a WinRT event args object, and any property you set is silently overwritten by MAUI's default plumbing unless you set `Handled = true` on the platform args themselves (separate from `DragEventArgs.Handled` and `DropEventArgs.Handled`, which control MAUI-level processing).

## Get the position of the drop

In MAUI 11, all three event args (`DragStartingEventArgs`, `DragEventArgs`, and `DropEventArgs`) expose a `GetPosition(Element?)` method that returns `Point?`. Pass `null` for screen coordinates, or pass an element to get coordinates relative to that element.

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

If you remember the old workaround of reading `MotionEvent.GetX/Y` from Android `PlatformArgs.DragEvent` and `LocationInView` from iOS `DropSession`, you no longer need it. `GetPosition` returns `null` only when the platform genuinely did not report a position (rare, but treat the nullable as load-bearing).

## Receive a file from another application

Inter-app drag is supported on iOS, Mac Catalyst, and Windows. Android cannot be a drop target for items from another app through the gesture recognizer API.

The shape of the data is platform-specific because the cross-process payload is always native: a `UIDragItem` collection on iOS and Mac Catalyst, a `DataPackageView` on Windows. MAUI gives you the native objects through `PlatformArgs`.

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

The iOS/Mac Catalyst variant uses `e.PlatformArgs.DropSession.Items` and asks each `NSItemProvider` to load an in-place file representation. The full pattern from the .NET MAUI samples is documented on Microsoft Learn at [Drag and drop between applications](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/gestures/drag-and-drop?view=net-maui-10.0#drag-and-drop-between-applications).

For both platforms, the `Drop` handler runs on the UI thread and the file is not yet copied. If you need the bytes, copy them inside the handler before returning, because the source app is allowed to revoke the drag session as soon as your handler completes.

## Five gotchas that will eat an afternoon

**1. The `DataPackage` is single-shot.** Each drag gesture creates a new `DataPackage`. If you cache `e.Data` and try to read it later from a different drop, you will get the data from the *original* drag, not the current one, which is the source of "the second card I drag is wrong" bugs.

**2. `Properties` is process-local.** Anything you put in `e.Data.Properties` works flawlessly inside your app and is invisible across applications. If you want a payload that survives an inter-app drop, also set `e.Data.Text` (or write to `PlatformArgs.SetClipData` on Android, `SetItemProvider` on iOS) so the system has something concrete to marshal.

**3. The default drop on `Label`/`Image`/`Entry` always fires.** If you handle `Drop` and update the target manually, set `e.Handled = true`, otherwise MAUI's automatic text or image assignment will run after your handler and clobber the result.

**4. `DropGestureRecognizer` does not bubble.** Each visual element either has a recognizer or it does not. If you put the recognizer on a parent `Grid` and the child `Border` has no recognizer of its own, the gesture works as expected; but if the child has any other gesture recognizer, hit-testing for the drop can land on the child and skip the parent. Be explicit: put the drop recognizer on the deepest element that should accept the drop.

**5. Android drag-and-drop requires a `View` that participates in hit testing.** A `Label` with `InputTransparent="True"` will silently refuse to start a drag, and a `BoxView` with no background color will only intercept gestures over the rectangle that the rasterizer actually paints. If your drag never starts on Android, set a `BackgroundColor` on the source view as a sanity check before reaching for `Handler` overrides.

## Building blocks for richer interactions

Drag-and-drop is the lowest-friction way to add direct manipulation to a desktop or tablet MAUI app, but the gesture recognizers are also the building block you reach for when you write a reorderable list, a tab-tear-out window, or a Trello-style board. None of those compose into a single library control today, which is why every serious MAUI desktop app rolls its own. The good news is that the underlying API is small enough that "rolls its own" usually means a hundred lines of code, most of which is the platform-specific preview customization rather than the gesture handling itself.

If you are building a desktop-only MAUI head, the rest of the [Windows-and-macOS-only MAUI 11 setup](/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) walks through stripping the mobile target frameworks so your `dotnet build` stops dragging in Android and iOS workloads. For a tour of what else is new in the framework, see [what's new in .NET MAUI 10](/2025/04/whats-new-in-net-maui-10/), which covers the `PlatformArgs` additions that this post depends on. If you need to override theme colors that show up in your drag preview, the same handler pattern in [how to change SearchBar's icon color in .NET MAUI](/2025/04/how-to-change-searchbars-icon-color-in-net-maui/) generalizes to most native preview tweaks. And if your app is a class library that hosts these gestures, [how to register handlers in a MAUI library](/2023/11/maui-library-register-handlers/) covers the `MauiAppBuilder` plumbing you need so the recognizers actually attach when the consuming app starts.

## Source links

- [Recognize a drag and drop gesture - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/gestures/drag-and-drop?view=net-maui-10.0)
- [DragGestureRecognizer Class - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.draggesturerecognizer)
- [DropGestureRecognizer Class - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.dropgesturerecognizer)
- [DataPackage Class - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.datapackage)
- [.NET MAUI Drag and Drop Gesture sample](https://learn.microsoft.com/en-us/samples/dotnet/maui-samples/gestures-draganddropgesture/)

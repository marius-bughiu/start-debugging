---
title: "Migrate a high-performance Xamarin.Forms ListView to MAUI CollectionView"
description: "Step-by-step migration from Xamarin.Forms 5.0 ListView to .NET MAUI 11 CollectionView for apps that already squeezed performance out of ListView. Covers cell recycling, virtualization, grouping, pull-to-refresh, context actions, selection, ItemsLayout, EmptyView, and the gotchas that bite real apps."
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
---

The short version: replace `ListView` with `CollectionView` wrapped in a `RefreshView` if you needed pull-to-refresh, swap `ContextActions` for `SwipeView`, drop `HasUnevenRows`, `RowHeight`, and `CachingStrategy` because virtualization with cell recycling is the only mode in MAUI, and rewrite selection from `ItemTapped` / `ItemSelected` to `SelectionMode` plus `SelectionChangedCommand`. If your old `ListView` was tuned with `CachingStrategy="RecycleElement"`, `HasUnevenRows="True"`, and a `DataTemplateSelector`, the move is mostly mechanical. Tested with .NET MAUI 11.0 GA on `net11.0-android35.0`, `net11.0-ios18.0`, and `net11.0-maccatalyst18.0`. Expect one to three days of focused work for an app with five to ten lists, longer if you lean heavily on `TableView`-style grouping or custom `ViewCell` renderers.

Xamarin.Forms went out of support on [May 1, 2024](https://dotnet.microsoft.com/en-us/platform/support/policy/maui), and MAUI 11 GA shipped in November 2025 with the third generation of CollectionView fixes for jank on Android. If you have been holding off because your app's perf was hand-tuned around `ListView` quirks like `RecycleElementAndDataTemplate`, the upgrade is worth doing now: CollectionView in MAUI 11 finally matches or beats the old Xamarin.Forms `ListView` on Android once you turn off `ItemSizingStrategy.MeasureAllItems`. This guide is for that audience.

## Why migrate now

- Xamarin.Forms is unsupported. No CVE patches, no Android 15 / iOS 18 fixes. App stores will keep enforcing target SDK bumps; you cannot follow them on Xamarin.Forms.
- CollectionView is the only collection control in MAUI that uses platform-native virtualizing collections (`RecyclerView` on Android, `UICollectionView` on iOS). `ListView` exists in MAUI for backward compatibility, but it is a [thin wrapper that defers to CollectionView under the hood](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/listview) and inherits the legacy API shape, not the legacy renderer.
- `ItemsLayout` lets you switch between linear and grid layouts without subclassing or repeater hacks. The same control covers what used to need `ListView` plus `FlowListView`.
- `EmptyView` is a real templated property, not a manual `IsVisible` toggle on a sibling label.

## What breaks

| Area | Xamarin.Forms ListView | MAUI CollectionView | Severity |
| ---- | ---------------------- | ------------------- | -------- |
| Caching strategy | `CachingStrategy="RetainElement"` or `RecycleElement` | Always recycles. Property does not exist. | medium |
| Row height | `HasUnevenRows`, `RowHeight` | `ItemSizingStrategy="MeasureAllItems"` or `MeasureFirstItem` | medium |
| Pull to refresh | `IsPullToRefreshEnabled`, `RefreshCommand` on `ListView` | Wrap in `RefreshView` | high |
| Cell type | `ViewCell`, `TextCell`, `ImageCell` | Plain `DataTemplate` with any layout root | high |
| Tap handling | `ItemTapped`, `ItemSelected` | `SelectionMode`, `SelectionChanged`, `SelectionChangedCommand` | high |
| Swipe actions | `ContextActions` | `SwipeView` | high |
| Separators | `SeparatorVisibility`, `SeparatorColor` | None. Add a `BoxView` in the template. | low |
| Headers / footers | `Header`, `Footer` (object or template) | Same names, but only as templates / views | low |
| Grouping | `IsGroupingEnabled`, `GroupHeaderTemplate` | `IsGrouped`, `GroupHeaderTemplate`, `GroupFooterTemplate` | medium |
| Scroll to | `ScrollTo(item, ScrollToPosition)` | `ScrollTo(item, position, animate)` | low |
| Empty state | Manual sibling label | `EmptyView`, `EmptyViewTemplate` | low |

The two changes that hurt are pull-to-refresh and selection. Everything else is a straight rename or a delete.

## Pre-flight checklist

1. .NET 11 SDK installed (`dotnet --version` reports `11.0.x`). MAUI 11 requires the .NET 11 SDK. Earlier SDKs do not have the workload manifest.
2. MAUI workload installed: `dotnet workload install maui`. If you upgraded over an older install, run `dotnet workload repair` first.
3. Android SDK 35, iOS 18, and Mac Catalyst 18 platforms available. Visual Studio 2022 17.13 or Visual Studio Code with the .NET MAUI extension 1.6+.
4. A `git` branch you can throw away. Keep the Xamarin.Forms project compiling on `main` until the MAUI build is green on a real device.
5. A list of every `ListView` instance in the project. Group them by feature area; migrate one feature at a time and ship behind a feature flag if your release cadence is monthly.
6. Run the [.NET Upgrade Assistant](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview) on the project once to handle the `csproj`, namespace, and `MauiProgram` changes. The Upgrade Assistant does not rewrite `ListView` XAML for you, which is what the rest of this post covers.

## Migration steps

### 1. Replace `ListView` with `CollectionView`

The simplest case is a flat list with a custom `DataTemplate`:

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

What changed:

- `ViewCell` is gone. The template root is a layout (`Grid`, `VerticalStackLayout`, etc.) directly.
- `CachingStrategy` is gone. Recycling is always on. The old `RecycleElementAndDataTemplate` is the closest analog and it is the only mode now.
- `HasUnevenRows="True"` is gone. CollectionView measures every cell by default. If your rows are all the same size, set `ItemSizingStrategy="MeasureFirstItem"` for a measurable Android scroll perf win.
- `SeparatorVisibility="None"` is the new default. Add a `BoxView HeightRequest="1"` inside the template if you actually want one.
- `x:DataType` on the template enables compiled bindings. Always set it. CollectionView's perf falls off a cliff with reflection bindings on Android.

**Verify**: build for Android (`dotnet build -t:Run -f net11.0-android35.0`) and scroll a 1000-item list on a mid-range device. Frame time should be under 16 ms in Android Studio's Profile GPU Rendering view. If it is not, check that `x:DataType` is set and that no binding inside the template uses `Source={x:Reference ...}`.

### 2. Wrap in `RefreshView` for pull-to-refresh

`IsPullToRefreshEnabled`, `IsRefreshing`, and `RefreshCommand` are no longer on the list. They live on `RefreshView`, which wraps any scrollable content.

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

`RefreshView` only triggers when the wrapped scrollable is at offset zero, so behavior matches the old `ListView`. There is no `IsPullToRefreshEnabled`; if you need to disable it, set `IsEnabled="False"` on the `RefreshView`.

**Verify**: pull down on the list while at offset zero. The platform spinner should appear and `RefreshCommand` should fire exactly once per gesture.

### 3. Rewrite selection

The Xamarin.Forms `ItemTapped` event fires on every tap, even when `SelectedItem` did not change. CollectionView splits this clearly: tap is selection, and selection is observable through `SelectionChanged` or `SelectionChangedCommand`. If you relied on tap to navigate to the same item twice in a row, you have to opt out of selection state by reading and clearing `SelectedItem` after each navigation:

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

`SelectionMode="None"` plus a `TapGestureRecognizer` inside the template is the closest equivalent to the old `ItemTapped` semantics. Use it only if you have a reason. The selection-based pattern is what the platforms expect and is what gets you accessibility focus rings for free on Windows.

**Verify**: tap an item, navigate back, tap the same item. Both taps should open the detail page.

### 4. Replace `ContextActions` with `SwipeView`

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

`SwipeView` is a real left-and-right swipe with custom backgrounds. `IsDestructive` becomes a normal `BackgroundColor`. `Mode="Execute"` matches the old behavior of dismissing on tap; `Mode="Reveal"` keeps the menu open. iOS long-press to reveal a menu is gone; if you need it, use `MenuFlyout` in MAUI 11 (new in this release).

**Verify**: swipe left on iOS and Android. Tap delete. Item removes. Swipe again on the next row to confirm only one swipe is ever open at a time.

### 5. Switch grouping

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

Two things change. The flag is `IsGrouped`, not `IsGroupingEnabled`. And the source must be a collection of collections where each outer item is itself enumerable. The cleanest pattern is a `Grouping<TKey, TItem>` class that derives from `List<TItem>` and exposes `Key`. That is the same pattern Xamarin.Forms used and it ports unchanged.

**Verify**: scroll a 30-day grouped list. Group headers should stick to the top of their group on iOS by default (`GroupHeadersStick="True"` on iOS native; the MAUI default mirrors this).

### 6. Choose an `ItemsLayout`

Default is `LinearItemsLayout` vertical, which matches `ListView`. Switch to a grid with a single line:

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

`Span="3"` is a fixed column count. There is no built-in adaptive grid; for that you size the cells against the available width with a behaviour or rebind on size changes.

**Verify**: rotate the device. Grid should redraw without losing scroll position.

### 7. Add an `EmptyView`

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

For multiple empty states (no data vs error), bind `EmptyView` to a property and use `EmptyViewTemplate` with a `DataTemplateSelector`.

**Verify**: clear the source. Empty view shows. Refill the source. Empty view disappears without a frame of overlap.

## Verification checklist

After every list is migrated:

- `dotnet build -c Release` for `net11.0-android35.0`, `net11.0-ios18.0`, `net11.0-maccatalyst18.0`, and `net11.0-windows10.0.19041.0` produces zero warnings about deprecated `ListView` APIs.
- `dotnet test` against the ViewModel layer is green. Selection logic is the most likely regression; cover it.
- On Android, scroll a 1000-item list on a Pixel 6 or equivalent. Frame time stays under 16 ms with `MeasureFirstItem` if rows are uniform. With `MeasureAllItems` and 1000 items, expect a one-time measurement cost on first display.
- On iOS, hold a finger on a row. No selection feedback should linger after release if `SelectionMode="None"`.
- Pull-to-refresh fires exactly once per gesture, on every platform.
- Swipe actions reveal on the correct side (RTL languages mirror automatically; verify in an Arabic locale if you ship one).
- `EmptyView` is announced by VoiceOver / TalkBack. CollectionView ships accessibility text for the empty state automatically; manual `SemanticProperties.Description` overrides it.

## Rollback plan

This is a one-way migration in practice. Once the project is on `net11.0-*` target frameworks and `MauiProgram.cs`, going back to Xamarin.Forms means restoring the old `csproj` shape, the `Xamarin.Forms.Forms.Init`, and platform-specific app entry points. Nothing in this post about CollectionView itself is reversible separately from the project upgrade. Plan to ship a working MAUI build before deleting the Xamarin.Forms branch.

## Gotchas we hit

- `ItemTapped` semantics. If your old code called `ListView.SelectedItem = null` in `ItemTapped` to make the same row tappable twice, you must keep clearing `SelectedItem` (or `SelectedItems`) after every navigation. CollectionView does not auto-clear.
- `RemainingItemsThreshold` for infinite scroll is on CollectionView (`RemainingItemsThreshold` plus `RemainingItemsThresholdReachedCommand`). The old `ItemAppearing` pattern still works but fires per item; the threshold pattern fires once near the bottom, which is what most infinite-scroll UIs actually want.
- `ScrollTo` no longer takes a `ScrollToPosition` enum value of `MakeVisible`. The closest mapping is `ScrollToPosition.MakeVisible` to `ScrollToPosition.MakeVisible` (same name, same enum), but the second argument is now the group index. For an ungrouped list pass `null`. Read the [CollectionView ScrollTo docs](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/collectionview/scrolling) before you port any custom scroll logic.
- Compiled bindings (`x:DataType`) are mandatory for perf. Without them, scrolling stutters on Android because every binding resolves through reflection on every recycle.
- `ItemSizingStrategy.MeasureAllItems` on a long list with variable height forces one full measurement pass on first display. If you have ten thousand items and the list is the first thing on screen, your time-to-first-frame regresses. Use a fixed cell height when you can.
- Custom `ViewCell` renderers do not port. There is no `ViewCellRenderer` in MAUI. If you had one, the cell becomes a normal layout in MAUI, and the renderer logic moves to a [handler](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/) on whatever child control needed it.
- `TableView` still exists in MAUI for static, settings-style screens. Do not use it for dynamic data. It does not virtualize.

## Related

- [How to support dark mode correctly in a MAUI app](/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) covers the `AppThemeBinding` patterns that templates inside CollectionView need.
- [How to implement drag-and-drop in MAUI 11](/2026/05/how-to-implement-drag-and-drop-in-maui-11/) shows how to combine `DragGestureRecognizer` with `CollectionView` items, which is the modern replacement for ListView reordering.
- [How to package a MAUI app for the Microsoft Store](/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) is the next step once the migration is done and you want to ship to Windows again.
- [How to write a MAUI app that runs on Windows and macOS only](/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) is the right reference if you are dropping mobile from a Xamarin.Forms project at the same time.

## Sources

- [.NET MAUI CollectionView documentation](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/collectionview/)
- [.NET MAUI ListView documentation](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/listview)
- [Xamarin.Forms support policy](https://dotnet.microsoft.com/en-us/platform/support/policy/maui)
- [Upgrade from Xamarin.Forms](https://learn.microsoft.com/en-us/dotnet/maui/migration/) on MS Learn
- [.NET Upgrade Assistant](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview)

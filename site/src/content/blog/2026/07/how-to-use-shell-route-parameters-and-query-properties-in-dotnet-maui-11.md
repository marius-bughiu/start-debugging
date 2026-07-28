---
title: "How to use Shell route parameters and query properties for navigation in .NET MAUI 11"
description: "A complete guide to passing data through Shell navigation in .NET MAUI 11: registering global routes, string query parameters, QueryPropertyAttribute vs IQueryAttributable, the URL-decoding asymmetry between the two, single-use ShellNavigationQueryParameters vs the IDictionary overload that leaks, passing data backwards with ..?key=value, and why QueryPropertyAttribute is not trim safe."
pubDate: 2026-07-28
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "shell"
  - "navigation"
  - "how-to"
---

To pass data to a page during Shell navigation in .NET MAUI 11, register the destination page as a global route with `Routing.RegisterRoute("details", typeof(DetailPage))`, navigate with `await Shell.Current.GoToAsync($"details?id={id}")`, and receive the value either by decorating the receiving class with `[QueryProperty(nameof(Id), "id")]` or by implementing `IQueryAttributable.ApplyQueryAttributes`. Prefer `IQueryAttributable`: `QueryPropertyAttribute` is not trim safe and breaks under full trimming or Native AOT. For anything that is not a string, use the `GoToAsync(string, ShellNavigationQueryParameters)` overload rather than the `IDictionary<string, object>` one, because the dictionary version keeps your object alive for the whole lifetime of the page.

This post targets .NET MAUI 11 (Preview 6 at the time of writing, GA in November 2026) with C# 14. The Shell navigation API has been stable since .NET MAUI 8, so everything except the .NET 11-specific notes at the end applies to .NET MAUI 8, 9, and 10 as well.

## How Shell turns a URI into a page

Shell navigation is URI based. A full navigation URI has three parts, in the shape `//route/page?queryParameters`:

- The **route** is a path into the Shell visual hierarchy, made from the `Route` properties you set on `FlyoutItem`, `TabBar`, `Tab`, and `ShellContent`.
- The **page** is something that does not live in the visual hierarchy, pushed onto a navigation stack on demand. Detail pages are almost always this.
- The **query parameters** are the `?key=value&key2=value2` tail.

That split matters more than it looks, because the two kinds of destination follow opposite rules:

| | Defined in `AppShell.xaml` | Registered with `Routing.RegisterRoute` |
| --- | --- | --- |
| Reached by | absolute route, `//animals/monkeys` | relative route, `monkeydetails` |
| Creates a navigation stack | no | yes |
| Works with the other form | absolute only | relative only |

Absolute routes do not work with pages registered through `Routing.RegisterRoute`, and relative routes do not work with pages declared inside your `Shell` subclass. Getting this backwards is the single most common cause of `ArgumentException` on a `GoToAsync` call that looks correct.

## Wire up a detail route in five steps

1. **Give your Shell items explicit routes.** Every item in the hierarchy gets a route whether you set one or not, but generated routes are not guaranteed to be consistent across app sessions, so never rely on them:

   ```xml
   <!-- AppShell.xaml, .NET MAUI 11 -->
   <Shell xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
          x:Class="OrdersApp.AppShell">
       <TabBar>
           <ShellContent Title="Orders"
                         Route="orders"
                         ContentTemplate="{DataTemplate local:OrdersPage}" />
           <ShellContent Title="Settings"
                         Route="settings"
                         ContentTemplate="{DataTemplate local:SettingsPage}" />
       </TabBar>
   </Shell>
   ```

2. **Register the detail page as a global route** in the `Shell` subclass constructor, or anywhere else that runs before the route is first invoked:

   ```csharp
   // AppShell.xaml.cs, .NET MAUI 11
   public partial class AppShell : Shell
   {
       public AppShell()
       {
           InitializeComponent();
           Routing.RegisterRoute("orderdetails", typeof(OrderDetailPage));
       }
   }
   ```

   Registering the same route string against two different types throws an `ArgumentException`, and so does a duplicate route detected in the visual hierarchy at startup.

3. **Register the page and its view model with the DI container** so Shell can construct them with their dependencies:

   ```csharp
   // MauiProgram.cs, .NET MAUI 11
   builder.Services.AddTransient<OrderDetailPage>();
   builder.Services.AddTransient<OrderDetailViewModel>();
   ```

4. **Set the `BindingContext` in the page constructor**, not in `OnAppearing`. Shell applies query attributes to the page *and* to its `BindingContext` immediately after it constructs the page, well before `OnAppearing` runs. A view model attached later never sees the parameters:

   ```csharp
   public partial class OrderDetailPage : ContentPage
   {
       public OrderDetailPage(OrderDetailViewModel vm)
       {
           InitializeComponent();
           BindingContext = vm;   // must happen here
       }
   }
   ```

5. **Navigate, and always `await` the call.** Fire-and-forget navigation is a race: code after the call can run before navigation completes, which shows up as missing query parameters, a stale `Shell.Current.CurrentPage`, or a navigation that silently does nothing.

   ```csharp
   // Correct
   await Shell.Current.GoToAsync($"orderdetails?id={order.Id}");

   // Wrong: race condition
   Shell.Current.GoToAsync($"orderdetails?id={order.Id}");
   ```

## Receiving string parameters: two APIs, one important difference

Both receiving mechanisms work on either the page class or the class used as its `BindingContext`.

`QueryPropertyAttribute` maps one query parameter id to one property. The first argument is the property name, the second is the parameter id in the URI:

```csharp
// .NET MAUI 11, C# 14
[QueryProperty(nameof(OrderId), "id")]
[QueryProperty(nameof(CustomerName), "customer")]
public partial class OrderDetailPage : ContentPage
{
    public string OrderId { set => LoadOrder(value); }
    public string CustomerName { set => Title = value; }
}
```

`IQueryAttributable` hands you everything in one dictionary, which is what you want as soon as two parameters have to be validated together:

```csharp
// .NET MAUI 11, C# 14
public partial class OrderDetailViewModel : ObservableObject, IQueryAttributable
{
    [ObservableProperty]
    private Order? _order;

    public void ApplyQueryAttributes(IDictionary<string, object> query)
    {
        if (!query.TryGetValue("id", out var raw) || !int.TryParse(raw?.ToString(), out var id))
            return;

        var customer = HttpUtility.UrlDecode(query["customer"].ToString());
        Order = _repository.Load(id, customer);
    }
}
```

Note the `HttpUtility.UrlDecode` call, because here is the asymmetry that costs people an afternoon: **string query parameter values received through `QueryPropertyAttribute` are automatically URL decoded, and values received through `IQueryAttributable` are not.** Switching a class from the attribute to the interface without adding the decode turns `Acme%20Corp` into a literal `Acme%20Corp` in your UI.

The corresponding rule on the sending side is that you must encode anything that can contain a `&`, `?`, `#`, `=`, or a space:

```csharp
// .NET MAUI 11, C# 14
var url = $"orderdetails?id={order.Id}&customer={Uri.EscapeDataString(order.CustomerName)}";
await Shell.Current.GoToAsync(url);
```

Without `Uri.EscapeDataString`, a customer called "Smith & Sons" truncates the parameter at the ampersand and silently creates a phantom `Sons` parameter.

## Passing objects, and the overload that leaks

String parameters are fine for identifiers. For anything richer there are two overloads, and they behave very differently.

The `IDictionary<string, object>` overload passes **multiple use** data:

```csharp
// .NET MAUI 11, C# 14
var parameters = new Dictionary<string, object> { ["Order"] = order };
await Shell.Current.GoToAsync("orderdetails", parameters);
```

Data passed this way is retained in memory for the lifetime of the page and is not released until the page leaves the navigation stack. It is also re-delivered on the way back: if `Page1` passes `MyData` to `Page2`, and `Page2` pushes `Page3`, then popping `Page3` causes `Page2` to receive `MyData` again. That re-delivery is occasionally what you want and usually what you did not expect. If you do not want it, call `Clear()` on the dictionary after the receiving page has read it.

The `ShellNavigationQueryParameters` overload passes **single use** data that Shell clears for you after navigation completes:

```csharp
// .NET MAUI 11, C# 14
var parameters = new ShellNavigationQueryParameters { ["Order"] = order };
await Shell.Current.GoToAsync("orderdetails", parameters);
```

`ShellNavigationQueryParameters` implements `IDictionary<string, object>`, so the receiving side is identical. Default to this one. Reach for the plain dictionary only when you actively want the value redelivered on back navigation.

You can combine both in a single call: a URI with string query parameters plus an object dictionary. The receiving `ApplyQueryAttributes` gets one merged dictionary with both sets of keys.

## Sending data backwards

Back navigation is `..`, and query parameters can be appended to it. This is the clean way to return a result from a picker page without a message bus or a shared singleton:

```csharp
// On the picker page, .NET MAUI 11
await Shell.Current.GoToAsync($"..?selectedId={selected.Id}");
```

The previous page receives `selectedId` through whichever mechanism it uses, exactly as if it had been navigated to forwards. Objects work too:

```csharp
var result = new ShellNavigationQueryParameters { ["Selection"] = selected };
await Shell.Current.GoToAsync("..", result);
```

`..` composes: `"../../route"` pops twice and then navigates to `route`. That only works if popping actually leaves you at a point in the hierarchy from which `route` is reachable.

## Contextual routes

Global routes can be registered at a path rather than as a bare name, which makes the same relative route resolve to different pages depending on where you are:

```csharp
// AppShell.xaml.cs, .NET MAUI 11
Routing.RegisterRoute("orders/details", typeof(OrderDetailPage));
Routing.RegisterRoute("invoices/details", typeof(InvoiceDetailPage));
```

Now `await Shell.Current.GoToAsync("details?id=42")` opens `OrderDetailPage` from the orders section and `InvoiceDetailPage` from the invoices section. It is a neat way to keep a shared `ItemsViewModel` free of destination-specific branching.

## Gotchas worth knowing before you ship

**`QueryPropertyAttribute` is not trim safe.** Since .NET MAUI 9 the docs carry an explicit warning: the attribute relies on reflection to find the property and should not be used with full trimming or Native AOT. Implement `IQueryAttributable` instead on any type that accepts query parameters. If your app is heading toward a trimmed or AOT publish, treat this as the deciding factor between the two APIs, not a stylistic preference. My post on [what trim-safe code actually is](/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) covers how to get the analyzer to tell you about the rest of these before publish time.

**`//page` and `///page` are invalid.** Global routes cannot currently be the only page on the navigation stack, so absolute routing to a global route throws. Absolute routes are for the visual hierarchy only.

**Navigating to a route that does not exist throws `ArgumentException`.** There is no silent no-op and no fallback route, so a typo in a route string is a crash, not a blank page. Keep route names in a `static class Routes` with `const string` fields and use them on both the registration and the navigation side.

**`Tab.Stack` is read only.** You cannot add, remove, or reorder pages by mutating it. To reset the stack, navigate to an absolute route (`//orders`); to pop, use `..`.

**Property setters fire in attribute order, not URI order.** With multiple `[QueryProperty]` attributes, do not write a setter that assumes another parameter has already arrived. If two values must be validated together, that is precisely the case `IQueryAttributable` exists for.

**Deferred navigation blocks `GoToAsync`.** If you use `args.GetDeferral()` inside an `OnNavigating` override, `GoToAsync` throws `InvalidOperationException` while the deferral is pending. Note that .NET MAUI 10 and 11 renamed the dialog APIs, so the canonical deferral sample now uses `DisplayActionSheetAsync` rather than `DisplayActionSheet`.

## What changed for Shell in .NET MAUI 11

The navigation contract itself is unchanged in .NET 11, which is deliberate: the release is a quality-focused one. Three things around it are worth noting.

Starting in .NET 11 Preview 6, **Android Shell apps use the handler-based Shell architecture by default** ([PR #34758](https://github.com/dotnet/maui/pull/34758)). The legacy `ShellRenderer` path is still available if you register it explicitly. If you have custom Android Shell renderers, this is the change to regression-test first.

Starting in Preview 5, `BackButtonBehavior` gained an **`AccessibilityLabel`** property ([PR #35011](https://github.com/dotnet/maui/pull/35011)). It is independent of `TextOverride`, so the visible label can stay short while the spoken label stays descriptive. Set it whenever you set `IconOverride`, because a screen reader has nothing useful to announce for a bare icon:

```xml
<!-- .NET MAUI 11 -->
<Shell.BackButtonBehavior>
    <BackButtonBehavior IconOverride="back.png"
                        AccessibilityLabel="Back to order list" />
</Shell.BackButtonBehavior>
```

And the runtime underneath all of this changed: CoreCLR is now the default on every .NET MAUI platform, which I covered in [MAUI mobile going CoreCLR only in Preview 6](/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/). It does not alter navigation semantics, but it does alter the trimming and startup profile of the app you are navigating around, which loops back to the `IQueryAttributable` recommendation above.

## Related

- [Migrate from Xamarin.Forms 5.0 to .NET MAUI 11: the full checklist](/2026/05/migrate-from-xamarin-forms-to-maui-11/), which covers the `AppShell` wiring you need before any of this applies.
- [Migrate a high-performance Xamarin.Forms ListView to MAUI CollectionView](/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/), for the selection-changed handler that usually triggers a detail navigation.
- [How to register and resolve keyed services in .NET 11 dependency injection](/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/), useful when two routes need different implementations of the same repository interface.
- [What is Native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/), for the deployment mode that makes `QueryPropertyAttribute` a non-starter.
- [How to support dark mode correctly in a .NET MAUI app](/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/), because Shell's chrome is the first thing that looks wrong when theming is half-done.

## Sources

- [.NET MAUI Shell navigation](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/shell/navigation), Microsoft Learn, .NET MAUI 11 moniker.
- [ShellNavigationQueryParameters class](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.shellnavigationqueryparameters), .NET MAUI API reference.
- [IQueryAttributable interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.iqueryattributable), .NET MAUI API reference.
- [What's new in .NET MAUI for .NET 11](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-11), Microsoft Learn.
- [Android Shell handler by default, dotnet/maui PR #34758](https://github.com/dotnet/maui/pull/34758).
- [Back button accessibility label, dotnet/maui PR #35011](https://github.com/dotnet/maui/pull/35011).

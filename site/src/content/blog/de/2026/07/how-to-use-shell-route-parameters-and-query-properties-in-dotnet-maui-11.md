---
title: "Shell-Routenparameter und Query Properties für die Navigation in .NET MAUI 11 verwenden"
description: "Vollständiger Leitfaden zur Datenübergabe bei der Shell-Navigation in .NET MAUI 11: globale Routen registrieren, string-basierte Abfrageparameter, QueryPropertyAttribute gegenüber IQueryAttributable, die URL-Dekodierungsasymmetrie zwischen beiden, einmalig verwendbare ShellNavigationQueryParameters gegenüber der IDictionary-Überladung, die Speicher hält, Daten rückwärts mit ..?key=value übergeben, und warum QueryPropertyAttribute nicht trimmingsicher ist."
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
lang: "de"
translationOf: "2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11"
translatedBy: "claude"
translationDate: 2026-07-28
---

Um bei der Shell-Navigation in .NET MAUI 11 Daten an eine Seite zu übergeben, registrieren Sie die Zielseite mit `Routing.RegisterRoute("details", typeof(DetailPage))` als globale Route, navigieren mit `await Shell.Current.GoToAsync($"details?id={id}")` und empfangen den Wert entweder über das Attribut `[QueryProperty(nameof(Id), "id")]` an der empfangenden Klasse oder über eine Implementierung von `IQueryAttributable.ApplyQueryAttributes`. Bevorzugen Sie `IQueryAttributable`: `QueryPropertyAttribute` ist nicht trimmingsicher und bricht bei vollständigem Trimming oder Native AOT. Für alles, was kein String ist, verwenden Sie die Überladung `GoToAsync(string, ShellNavigationQueryParameters)` statt der `IDictionary<string, object>`-Variante, denn die Dictionary-Version hält Ihr Objekt über die gesamte Lebensdauer der Seite am Leben.

Dieser Beitrag bezieht sich auf .NET MAUI 11 (zum Zeitpunkt des Schreibens Preview 6, GA im November 2026) mit C# 14. Die Shell-Navigations-API ist seit .NET MAUI 8 stabil, daher gilt alles außer den .NET 11-spezifischen Hinweisen am Ende ebenso für .NET MAUI 8, 9 und 10.

## Wie Shell aus einer URI eine Seite macht

Die Shell-Navigation ist URI-basiert. Eine vollständige Navigations-URI hat drei Teile in der Form `//route/page?queryParameters`:

- Die **Route** ist ein Pfad in die visuelle Hierarchie von Shell, gebildet aus den `Route`-Eigenschaften, die Sie an `FlyoutItem`, `TabBar`, `Tab` und `ShellContent` setzen.
- Die **Seite** ist etwas, das nicht in der visuellen Hierarchie lebt und bei Bedarf auf einen Navigationsstapel gelegt wird. Detailseiten sind fast immer von dieser Art.
- Die **Abfrageparameter** sind der Anhang `?key=value&key2=value2`.

Diese Trennung ist wichtiger, als sie aussieht, denn die beiden Zielarten folgen gegensätzlichen Regeln:

| | In `AppShell.xaml` deklariert | Mit `Routing.RegisterRoute` registriert |
| --- | --- | --- |
| Erreichbar über | absolute Route, `//animals/monkeys` | relative Route, `monkeydetails` |
| Erzeugt einen Navigationsstapel | nein | ja |
| Funktioniert mit der anderen Form | nur absolut | nur relativ |

Absolute Routen funktionieren nicht mit Seiten, die über `Routing.RegisterRoute` registriert wurden, und relative Routen funktionieren nicht mit Seiten, die in Ihrer `Shell`-Unterklasse deklariert sind. Diese Verwechslung ist die häufigste Ursache für eine `ArgumentException` bei einem `GoToAsync`-Aufruf, der korrekt aussieht.

## Eine Detailroute in fünf Schritten einrichten

1. **Vergeben Sie explizite Routen an Ihre Shell-Elemente.** Jedes Element der Hierarchie erhält eine Route, ob Sie eine setzen oder nicht, aber generierte Routen sind über App-Sitzungen hinweg nicht garantiert konsistent, verlassen Sie sich also nie darauf:

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

2. **Registrieren Sie die Detailseite als globale Route** im Konstruktor der `Shell`-Unterklasse oder an einer anderen Stelle, die vor dem ersten Aufruf der Route ausgeführt wird:

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

   Dieselbe Routenzeichenfolge für zwei verschiedene Typen zu registrieren, wirft eine `ArgumentException`, ebenso eine beim Start erkannte doppelte Route in der visuellen Hierarchie.

3. **Registrieren Sie die Seite und ihr View Model im DI-Container**, damit Shell sie mit ihren Abhängigkeiten konstruieren kann:

   ```csharp
   // MauiProgram.cs, .NET MAUI 11
   builder.Services.AddTransient<OrderDetailPage>();
   builder.Services.AddTransient<OrderDetailViewModel>();
   ```

4. **Setzen Sie den `BindingContext` im Konstruktor der Seite**, nicht in `OnAppearing`. Shell wendet die Query Attributes auf die Seite *und* auf ihren `BindingContext` unmittelbar nach der Konstruktion der Seite an, lange bevor `OnAppearing` läuft. Ein später zugewiesenes View Model sieht die Parameter nie:

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

5. **Navigieren Sie, und verwenden Sie immer `await`.** Navigation ohne Erwarten ist eine Race Condition: Code nach dem Aufruf kann laufen, bevor die Navigation abgeschlossen ist. Das zeigt sich als fehlende Abfrageparameter, als veraltete `Shell.Current.CurrentPage` oder als Navigation, die stillschweigend nichts tut.

   ```csharp
   // Correct
   await Shell.Current.GoToAsync($"orderdetails?id={order.Id}");

   // Wrong: race condition
   Shell.Current.GoToAsync($"orderdetails?id={order.Id}");
   ```

## String-Parameter empfangen: zwei APIs, ein wichtiger Unterschied

Beide Empfangsmechanismen funktionieren sowohl an der Seitenklasse als auch an der Klasse, die als `BindingContext` dient.

`QueryPropertyAttribute` bildet eine Abfrageparameter-ID auf eine Eigenschaft ab. Das erste Argument ist der Eigenschaftsname, das zweite die Parameter-ID in der URI:

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

`IQueryAttributable` übergibt alles in einem Dictionary, was Sie brauchen, sobald zwei Parameter gemeinsam validiert werden müssen:

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

Beachten Sie den Aufruf von `HttpUtility.UrlDecode`, denn hier liegt die Asymmetrie, die einen halben Tag kostet: **String-Abfrageparameter, die über `QueryPropertyAttribute` ankommen, werden automatisch URL-dekodiert, über `IQueryAttributable` empfangene nicht.** Wechselt eine Klasse vom Attribut zur Schnittstelle, ohne die Dekodierung zu ergänzen, wird aus `Acme%20Corp` ein wörtliches `Acme%20Corp` in der Oberfläche.

Die passende Regel auf der Senderseite: Kodieren Sie alles, was ein `&`, `?`, `#`, `=` oder ein Leerzeichen enthalten kann:

```csharp
// .NET MAUI 11, C# 14
var url = $"orderdetails?id={order.Id}&customer={Uri.EscapeDataString(order.CustomerName)}";
await Shell.Current.GoToAsync(url);
```

Ohne `Uri.EscapeDataString` schneidet ein Kunde namens "Smith & Sons" den Parameter am Ampersand ab und erzeugt stillschweigend einen Phantomparameter `Sons`.

## Objekte übergeben, und die Überladung, die Speicher hält

String-Parameter genügen für Bezeichner. Für alles Reichhaltigere gibt es zwei Überladungen, die sich sehr unterschiedlich verhalten.

Die Überladung mit `IDictionary<string, object>` übergibt **mehrfach verwendbare** Daten:

```csharp
// .NET MAUI 11, C# 14
var parameters = new Dictionary<string, object> { ["Order"] = order };
await Shell.Current.GoToAsync("orderdetails", parameters);
```

So übergebene Daten bleiben über die gesamte Lebensdauer der Seite im Speicher und werden erst freigegeben, wenn die Seite den Navigationsstapel verlässt. Sie werden außerdem auf dem Rückweg erneut zugestellt: Übergibt `Page1` an `Page2` das Objekt `MyData` und legt `Page2` anschließend `Page3` auf den Stapel, so empfängt `Page2` beim Entfernen von `Page3` erneut `MyData`. Diese erneute Zustellung ist gelegentlich gewollt und meist unerwartet. Wenn Sie sie nicht wollen, rufen Sie `Clear()` auf dem Dictionary auf, nachdem die empfangende Seite es gelesen hat.

Die Überladung mit `ShellNavigationQueryParameters` übergibt **einmalig verwendbare** Daten, die Shell nach Abschluss der Navigation für Sie leert:

```csharp
// .NET MAUI 11, C# 14
var parameters = new ShellNavigationQueryParameters { ["Order"] = order };
await Shell.Current.GoToAsync("orderdetails", parameters);
```

`ShellNavigationQueryParameters` implementiert `IDictionary<string, object>`, die Empfängerseite ist also identisch. Nehmen Sie standardmäßig diese Variante. Greifen Sie nur dann zum einfachen Dictionary, wenn Sie die erneute Zustellung bei Rückwärtsnavigation ausdrücklich wollen.

Beides lässt sich in einem Aufruf kombinieren: eine URI mit String-Abfrageparametern plus ein Objekt-Dictionary. Das empfangende `ApplyQueryAttributes` erhält ein zusammengeführtes Dictionary mit beiden Schlüsselmengen.

## Daten rückwärts senden

Rückwärtsnavigation ist `..`, und Abfrageparameter lassen sich daran anhängen. Das ist der saubere Weg, ein Ergebnis von einer Auswahlseite zurückzugeben, ohne Message Bus oder gemeinsam genutztes Singleton:

```csharp
// On the picker page, .NET MAUI 11
await Shell.Current.GoToAsync($"..?selectedId={selected.Id}");
```

Die vorherige Seite empfängt `selectedId` über den Mechanismus, den sie verwendet, genau so, als wäre vorwärts zu ihr navigiert worden. Objekte funktionieren ebenfalls:

```csharp
var result = new ShellNavigationQueryParameters { ["Selection"] = selected };
await Shell.Current.GoToAsync("..", result);
```

`..` ist kombinierbar: `"../../route"` entfernt zwei Seiten und navigiert dann zu `route`. Das funktioniert nur, wenn Sie nach dem Entfernen tatsächlich an einer Stelle der Hierarchie stehen, von der aus `route` erreichbar ist.

## Kontextbezogene Routen

Globale Routen lassen sich unter einem Pfad statt unter einem bloßen Namen registrieren. Damit löst dieselbe relative Route je nach Standort auf verschiedene Seiten auf:

```csharp
// AppShell.xaml.cs, .NET MAUI 11
Routing.RegisterRoute("orders/details", typeof(OrderDetailPage));
Routing.RegisterRoute("invoices/details", typeof(InvoiceDetailPage));
```

Jetzt öffnet `await Shell.Current.GoToAsync("details?id=42")` aus dem Bestellbereich die `OrderDetailPage` und aus dem Rechnungsbereich die `InvoiceDetailPage`. Ein eleganter Weg, ein gemeinsam genutztes `ItemsViewModel` frei von zielspezifischen Verzweigungen zu halten.

## Fallstricke, die Sie vor dem Release kennen sollten

**`QueryPropertyAttribute` ist nicht trimmingsicher.** Seit .NET MAUI 9 enthält die Dokumentation eine ausdrückliche Warnung: Das Attribut findet die Eigenschaft per Reflexion und sollte weder mit vollständigem Trimming noch mit Native AOT verwendet werden. Implementieren Sie stattdessen `IQueryAttributable` an jedem Typ, der Abfrageparameter annimmt. Wenn Ihre App auf eine getrimmte oder AOT-Veröffentlichung zusteuert, ist das der entscheidende Faktor zwischen beiden APIs, keine Stilfrage. Mein Beitrag darüber, [was trimmingsicherer Code eigentlich ist](/de/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/), zeigt, wie der Analyzer Sie vor dem Veröffentlichen auf den Rest hinweist.

**`//page` und `///page` sind ungültig.** Globale Routen können derzeit nicht die einzige Seite auf dem Navigationsstapel sein, absolutes Routing zu einer globalen Route wirft daher eine Ausnahme. Absolute Routen gelten nur für die visuelle Hierarchie.

**Navigation zu einer nicht existierenden Route wirft `ArgumentException`.** Es gibt keinen stillen No-Op und keine Fallback-Route, ein Tippfehler in einer Routenzeichenfolge ist also ein Absturz und keine leere Seite. Halten Sie Routennamen in einer `static class Routes` mit `const string`-Feldern und verwenden Sie sie sowohl bei der Registrierung als auch bei der Navigation.

**`Tab.Stack` ist schreibgeschützt.** Sie können Seiten nicht durch Mutieren hinzufügen, entfernen oder umsortieren. Zum Zurücksetzen des Stapels navigieren Sie zu einer absoluten Route (`//orders`), zum Zurückgehen verwenden Sie `..`.

**Property-Setter feuern in Attributreihenfolge, nicht in URI-Reihenfolge.** Schreiben Sie bei mehreren `[QueryProperty]`-Attributen keinen Setter, der voraussetzt, dass ein anderer Parameter bereits eingetroffen ist. Müssen zwei Werte gemeinsam validiert werden, ist genau das der Fall, für den `IQueryAttributable` existiert.

**Verzögerte Navigation blockiert `GoToAsync`.** Wenn Sie `args.GetDeferral()` in einer `OnNavigating`-Überschreibung verwenden, wirft `GoToAsync` eine `InvalidOperationException`, solange die Verzögerung aussteht. Beachten Sie, dass .NET MAUI 10 und 11 die Dialog-APIs umbenannt haben, das kanonische Verzögerungsbeispiel verwendet daher jetzt `DisplayActionSheetAsync` statt `DisplayActionSheet`.

## Was sich für Shell in .NET MAUI 11 geändert hat

Der Navigationsvertrag selbst bleibt in .NET 11 unverändert, und das ist Absicht: Das Release konzentriert sich auf Qualität. Drei Dinge im Umfeld sind erwähnenswert.

Ab .NET 11 Preview 6 verwenden **Android-Shell-Apps standardmäßig die handlerbasierte Shell-Architektur** ([PR #34758](https://github.com/dotnet/maui/pull/34758)). Der alte `ShellRenderer`-Pfad bleibt verfügbar, wenn Sie ihn ausdrücklich registrieren. Wenn Sie eigene Android-Shell-Renderer haben, ist das die Änderung, die Sie zuerst auf Regressionen prüfen sollten.

Ab Preview 5 besitzt `BackButtonBehavior` eine Eigenschaft **`AccessibilityLabel`** ([PR #35011](https://github.com/dotnet/maui/pull/35011)). Sie ist unabhängig von `TextOverride`, die sichtbare Beschriftung kann also kurz bleiben, während die gesprochene beschreibend bleibt. Setzen Sie sie immer dann, wenn Sie `IconOverride` setzen, denn ein Screenreader hat bei einem bloßen Symbol nichts Sinnvolles anzusagen:

```xml
<!-- .NET MAUI 11 -->
<Shell.BackButtonBehavior>
    <BackButtonBehavior IconOverride="back.png"
                        AccessibilityLabel="Back to order list" />
</Shell.BackButtonBehavior>
```

Und die Laufzeit darunter hat sich geändert: CoreCLR ist jetzt auf jeder .NET MAUI-Plattform der Standard, was ich in [MAUI Mobile wird in Preview 6 CoreCLR only](/de/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/) behandelt habe. Die Navigationssemantik ändert das nicht, wohl aber das Trimming- und Startverhalten der App, in der Sie navigieren, womit wir wieder bei der `IQueryAttributable`-Empfehlung von oben sind.

## Verwandte Beiträge

- [Von Xamarin.Forms 5.0 zu .NET MAUI 11 migrieren: die vollständige Checkliste](/de/2026/05/migrate-from-xamarin-forms-to-maui-11/), mit der `AppShell`-Verdrahtung, die Voraussetzung für alles Obige ist.
- [Eine performante Xamarin.Forms-ListView zu MAUI CollectionView migrieren](/de/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/), wegen des Selection-Changed-Handlers, der üblicherweise eine Detailnavigation auslöst.
- [Keyed Services in .NET 11 Dependency Injection registrieren und auflösen](/de/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/), nützlich, wenn zwei Routen verschiedene Implementierungen desselben Repository-Interface brauchen.
- [Was ist Native AOT und was kostet es Sie?](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/), zum Veröffentlichungsmodus, der `QueryPropertyAttribute` ausschließt.
- [Dark Mode in einer .NET MAUI-App korrekt unterstützen](/de/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/), denn die Shell-Chrome fällt zuerst auf, wenn das Theming halbfertig ist.

## Quellen

- [.NET MAUI Shell navigation](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/shell/navigation), Microsoft Learn, Moniker .NET MAUI 11.
- [ShellNavigationQueryParameters class](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.shellnavigationqueryparameters), .NET MAUI API-Referenz.
- [IQueryAttributable interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.iqueryattributable), .NET MAUI API-Referenz.
- [What's new in .NET MAUI for .NET 11](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-11), Microsoft Learn.
- [Android-Shell-Handler als Standard, dotnet/maui PR #34758](https://github.com/dotnet/maui/pull/34758).
- [Accessibility Label für die Zurück-Schaltfläche, dotnet/maui PR #35011](https://github.com/dotnet/maui/pull/35011).

---
title: "Cómo usar parámetros de ruta de Shell y query properties para navegar en .NET MAUI 11"
description: "Guía completa para pasar datos con la navegación de Shell en .NET MAUI 11: registrar rutas globales, parámetros de consulta de tipo string, QueryPropertyAttribute frente a IQueryAttributable, la asimetría de decodificación de URL entre ambos, ShellNavigationQueryParameters de un solo uso frente a la sobrecarga con IDictionary que retiene memoria, pasar datos hacia atrás con ..?key=value, y por qué QueryPropertyAttribute no es seguro para el recorte."
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
lang: "es"
translationOf: "2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11"
translatedBy: "claude"
translationDate: 2026-07-28
---

Para pasar datos a una página durante la navegación de Shell en .NET MAUI 11, registra la página de destino como ruta global con `Routing.RegisterRoute("details", typeof(DetailPage))`, navega con `await Shell.Current.GoToAsync($"details?id={id}")` y recibe el valor decorando la clase receptora con `[QueryProperty(nameof(Id), "id")]` o implementando `IQueryAttributable.ApplyQueryAttributes`. Prefiere `IQueryAttributable`: `QueryPropertyAttribute` no es seguro para el recorte y se rompe con recorte completo o Native AOT. Para cualquier cosa que no sea un string, usa la sobrecarga `GoToAsync(string, ShellNavigationQueryParameters)` en lugar de la de `IDictionary<string, object>`, porque la versión con diccionario mantiene vivo tu objeto durante todo el ciclo de vida de la página.

Este artículo apunta a .NET MAUI 11 (Preview 6 al momento de escribir, GA en noviembre de 2026) con C# 14. La API de navegación de Shell es estable desde .NET MAUI 8, así que todo excepto las notas específicas de .NET 11 al final se aplica igualmente a .NET MAUI 8, 9 y 10.

## Cómo convierte Shell una URI en una página

La navegación de Shell se basa en URIs. Una URI de navegación completa tiene tres partes, con la forma `//route/page?queryParameters`:

- La **ruta** es un camino dentro de la jerarquía visual de Shell, formado por las propiedades `Route` que asignas en `FlyoutItem`, `TabBar`, `Tab` y `ShellContent`.
- La **página** es algo que no vive en la jerarquía visual y se apila en una pila de navegación bajo demanda. Las páginas de detalle casi siempre son esto.
- Los **parámetros de consulta** son la cola `?key=value&key2=value2`.

Esa separación importa más de lo que parece, porque los dos tipos de destino siguen reglas opuestas:

| | Declarado en `AppShell.xaml` | Registrado con `Routing.RegisterRoute` |
| --- | --- | --- |
| Se alcanza con | ruta absoluta, `//animals/monkeys` | ruta relativa, `monkeydetails` |
| Crea una pila de navegación | no | sí |
| Funciona con la otra forma | solo absoluta | solo relativa |

Las rutas absolutas no funcionan con páginas registradas mediante `Routing.RegisterRoute`, y las rutas relativas no funcionan con páginas declaradas dentro de tu subclase de `Shell`. Invertir esto es la causa más común de un `ArgumentException` en una llamada a `GoToAsync` que parece correcta.

## Cablea una ruta de detalle en cinco pasos

1. **Asigna rutas explícitas a tus elementos de Shell.** Todo elemento de la jerarquía obtiene una ruta, la definas o no, pero las rutas generadas no garantizan ser consistentes entre sesiones de la aplicación, así que nunca dependas de ellas:

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

2. **Registra la página de detalle como ruta global** en el constructor de la subclase de `Shell`, o en cualquier otro lugar que se ejecute antes de invocar la ruta por primera vez:

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

   Registrar la misma cadena de ruta para dos tipos distintos lanza un `ArgumentException`, y lo mismo ocurre con una ruta duplicada detectada en la jerarquía visual al arrancar.

3. **Registra la página y su view model en el contenedor de inyección de dependencias** para que Shell pueda construirlos con sus dependencias:

   ```csharp
   // MauiProgram.cs, .NET MAUI 11
   builder.Services.AddTransient<OrderDetailPage>();
   builder.Services.AddTransient<OrderDetailViewModel>();
   ```

4. **Asigna el `BindingContext` en el constructor de la página**, no en `OnAppearing`. Shell aplica los query attributes a la página *y* a su `BindingContext` inmediatamente después de construir la página, mucho antes de que se ejecute `OnAppearing`. Un view model asignado más tarde nunca ve los parámetros:

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

5. **Navega, y siempre usa `await` en la llamada.** La navegación sin esperar es una condición de carrera: el código posterior a la llamada puede ejecutarse antes de que la navegación termine, lo que se manifiesta como parámetros de consulta faltantes, un `Shell.Current.CurrentPage` desactualizado, o una navegación que silenciosamente no hace nada.

   ```csharp
   // Correct
   await Shell.Current.GoToAsync($"orderdetails?id={order.Id}");

   // Wrong: race condition
   Shell.Current.GoToAsync($"orderdetails?id={order.Id}");
   ```

## Recibir parámetros de tipo string: dos APIs, una diferencia importante

Ambos mecanismos de recepción funcionan tanto en la clase de la página como en la clase usada como su `BindingContext`.

`QueryPropertyAttribute` mapea un id de parámetro de consulta a una propiedad. El primer argumento es el nombre de la propiedad, el segundo es el id del parámetro en la URI:

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

`IQueryAttributable` te entrega todo en un único diccionario, que es lo que quieres en cuanto dos parámetros deben validarse juntos:

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

Fíjate en la llamada a `HttpUtility.UrlDecode`, porque aquí está la asimetría que cuesta una tarde: **los valores de parámetros de consulta de tipo string recibidos mediante `QueryPropertyAttribute` se decodifican automáticamente desde URL, y los recibidos mediante `IQueryAttributable` no.** Cambiar una clase del atributo a la interfaz sin añadir la decodificación convierte `Acme%20Corp` en un literal `Acme%20Corp` en tu interfaz de usuario.

La regla correspondiente del lado emisor es que debes codificar todo lo que pueda contener un `&`, `?`, `#`, `=` o un espacio:

```csharp
// .NET MAUI 11, C# 14
var url = $"orderdetails?id={order.Id}&customer={Uri.EscapeDataString(order.CustomerName)}";
await Shell.Current.GoToAsync(url);
```

Sin `Uri.EscapeDataString`, un cliente llamado "Smith & Sons" trunca el parámetro en el ampersand y crea silenciosamente un parámetro fantasma `Sons`.

## Pasar objetos, y la sobrecarga que retiene memoria

Los parámetros de tipo string están bien para identificadores. Para algo más rico hay dos sobrecargas, y se comportan de forma muy distinta.

La sobrecarga con `IDictionary<string, object>` pasa datos de **uso múltiple**:

```csharp
// .NET MAUI 11, C# 14
var parameters = new Dictionary<string, object> { ["Order"] = order };
await Shell.Current.GoToAsync("orderdetails", parameters);
```

Los datos pasados así se retienen en memoria durante todo el ciclo de vida de la página y no se liberan hasta que la página abandona la pila de navegación. Además se vuelven a entregar en el camino de vuelta: si `Page1` pasa `MyData` a `Page2`, y `Page2` apila `Page3`, al desapilar `Page3` la `Page2` recibe `MyData` otra vez. Esa reentrega es ocasionalmente lo que quieres y normalmente lo que no esperabas. Si no la quieres, llama a `Clear()` sobre el diccionario después de que la página receptora lo haya leído.

La sobrecarga con `ShellNavigationQueryParameters` pasa datos de **un solo uso** que Shell limpia por ti cuando la navegación termina:

```csharp
// .NET MAUI 11, C# 14
var parameters = new ShellNavigationQueryParameters { ["Order"] = order };
await Shell.Current.GoToAsync("orderdetails", parameters);
```

`ShellNavigationQueryParameters` implementa `IDictionary<string, object>`, así que el lado receptor es idéntico. Usa esta por defecto. Recurre al diccionario simple solo cuando quieras activamente que el valor se reentregue al navegar hacia atrás.

Puedes combinar ambos en una sola llamada: una URI con parámetros de consulta de tipo string más un diccionario de objetos. El `ApplyQueryAttributes` receptor obtiene un único diccionario fusionado con ambos conjuntos de claves.

## Enviar datos hacia atrás

La navegación hacia atrás es `..`, y se le pueden añadir parámetros de consulta. Esta es la forma limpia de devolver un resultado desde una página selectora sin un bus de mensajes ni un singleton compartido:

```csharp
// On the picker page, .NET MAUI 11
await Shell.Current.GoToAsync($"..?selectedId={selected.Id}");
```

La página anterior recibe `selectedId` a través del mecanismo que use, exactamente como si se hubiera navegado hacia ella hacia adelante. Los objetos también funcionan:

```csharp
var result = new ShellNavigationQueryParameters { ["Selection"] = selected };
await Shell.Current.GoToAsync("..", result);
```

`..` se puede componer: `"../../route"` desapila dos veces y luego navega a `route`. Eso solo funciona si desapilar te deja efectivamente en un punto de la jerarquía desde el que `route` es alcanzable.

## Rutas contextuales

Las rutas globales pueden registrarse con una ruta de acceso en vez de un nombre suelto, lo que hace que la misma ruta relativa resuelva a páginas distintas según dónde estés:

```csharp
// AppShell.xaml.cs, .NET MAUI 11
Routing.RegisterRoute("orders/details", typeof(OrderDetailPage));
Routing.RegisterRoute("invoices/details", typeof(InvoiceDetailPage));
```

Ahora `await Shell.Current.GoToAsync("details?id=42")` abre `OrderDetailPage` desde la sección de pedidos e `InvoiceDetailPage` desde la de facturas. Es una manera elegante de mantener un `ItemsViewModel` compartido libre de ramificaciones específicas del destino.

## Trampas que conviene conocer antes de publicar

**`QueryPropertyAttribute` no es seguro para el recorte.** Desde .NET MAUI 9 la documentación incluye una advertencia explícita: el atributo depende de la reflexión para encontrar la propiedad y no debe usarse con recorte completo ni con Native AOT. Implementa `IQueryAttributable` en cualquier tipo que acepte parámetros de consulta. Si tu aplicación va camino de una publicación recortada o AOT, trata esto como el factor decisivo entre ambas APIs, no como una preferencia estilística. Mi artículo sobre [qué es realmente el código seguro para el recorte](/es/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) explica cómo hacer que el analizador te avise del resto antes del momento de publicar.

**`//page` y `///page` no son válidas.** Actualmente las rutas globales no pueden ser la única página de la pila de navegación, así que el enrutamiento absoluto hacia una ruta global lanza una excepción. Las rutas absolutas son solo para la jerarquía visual.

**Navegar a una ruta que no existe lanza `ArgumentException`.** No hay una no-operación silenciosa ni una ruta de reserva, así que un error tipográfico en una cadena de ruta es un fallo, no una página en blanco. Mantén los nombres de ruta en una `static class Routes` con campos `const string` y úsalos tanto al registrar como al navegar.

**`Tab.Stack` es de solo lectura.** No puedes añadir, quitar ni reordenar páginas mutándola. Para reiniciar la pila, navega a una ruta absoluta (`//orders`); para volver, usa `..`.

**Los setters de propiedad se disparan en el orden de los atributos, no en el de la URI.** Con varios atributos `[QueryProperty]`, no escribas un setter que asuma que otro parámetro ya llegó. Si dos valores deben validarse juntos, ese es precisamente el caso para el que existe `IQueryAttributable`.

**La navegación diferida bloquea `GoToAsync`.** Si usas `args.GetDeferral()` dentro de una sobrescritura de `OnNavigating`, `GoToAsync` lanza `InvalidOperationException` mientras el aplazamiento está pendiente. Ten en cuenta que .NET MAUI 10 y 11 renombraron las APIs de diálogo, así que el ejemplo canónico de aplazamiento ahora usa `DisplayActionSheetAsync` en lugar de `DisplayActionSheet`.

## Qué cambió para Shell en .NET MAUI 11

El contrato de navegación en sí no cambia en .NET 11, y eso es deliberado: la versión se centra en calidad. Hay tres cosas alrededor que conviene señalar.

A partir de .NET 11 Preview 6, **las aplicaciones Shell de Android usan por defecto la arquitectura de Shell basada en handlers** ([PR #34758](https://github.com/dotnet/maui/pull/34758)). La ruta heredada de `ShellRenderer` sigue disponible si la registras explícitamente. Si tienes renderers personalizados de Shell para Android, este es el cambio que hay que probar primero por regresión.

A partir de Preview 5, `BackButtonBehavior` incorpora una propiedad **`AccessibilityLabel`** ([PR #35011](https://github.com/dotnet/maui/pull/35011)). Es independiente de `TextOverride`, así que la etiqueta visible puede quedarse corta mientras la etiqueta hablada sigue siendo descriptiva. Asígnala siempre que asignes `IconOverride`, porque un lector de pantalla no tiene nada útil que anunciar ante un icono desnudo:

```xml
<!-- .NET MAUI 11 -->
<Shell.BackButtonBehavior>
    <BackButtonBehavior IconOverride="back.png"
                        AccessibilityLabel="Back to order list" />
</Shell.BackButtonBehavior>
```

Y el runtime que hay debajo de todo esto cambió: CoreCLR ahora es el predeterminado en todas las plataformas de .NET MAUI, algo que cubrí en [MAUI móvil pasando a ser solo CoreCLR en Preview 6](/es/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/). No altera la semántica de navegación, pero sí altera el perfil de recorte y arranque de la aplicación por la que estás navegando, lo que nos devuelve a la recomendación de `IQueryAttributable` de arriba.

## Relacionado

- [Migrar de Xamarin.Forms 5.0 a .NET MAUI 11: la lista completa](/es/2026/05/migrate-from-xamarin-forms-to-maui-11/), que cubre el cableado de `AppShell` que necesitas antes de que nada de esto aplique.
- [Migrar un ListView de alto rendimiento de Xamarin.Forms a CollectionView de MAUI](/es/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/), por el manejador de cambio de selección que normalmente dispara una navegación de detalle.
- [Cómo registrar y resolver servicios con clave en la inyección de dependencias de .NET 11](/es/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/), útil cuando dos rutas necesitan implementaciones distintas de la misma interfaz de repositorio.
- [¿Qué es Native AOT y qué te cuesta?](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/), por el modo de publicación que hace de `QueryPropertyAttribute` algo inviable.
- [Cómo dar soporte correcto al modo oscuro en una aplicación .NET MAUI](/es/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/), porque el cromo de Shell es lo primero que se ve mal cuando el tematizado queda a medias.

## Fuentes

- [.NET MAUI Shell navigation](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/shell/navigation), Microsoft Learn, moniker .NET MAUI 11.
- [ShellNavigationQueryParameters class](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.shellnavigationqueryparameters), referencia de API de .NET MAUI.
- [IQueryAttributable interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.iqueryattributable), referencia de API de .NET MAUI.
- [What's new in .NET MAUI for .NET 11](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-11), Microsoft Learn.
- [Handler de Shell en Android por defecto, dotnet/maui PR #34758](https://github.com/dotnet/maui/pull/34758).
- [Etiqueta de accesibilidad del botón de retroceso, dotnet/maui PR #35011](https://github.com/dotnet/maui/pull/35011).

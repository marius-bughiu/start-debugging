---
title: "Cómo implementar arrastrar y soltar en .NET MAUI 11"
description: "Arrastrar y soltar de extremo a extremo en .NET MAUI 11: DragGestureRecognizer, DropGestureRecognizer, cargas útiles personalizadas con DataPackage, AcceptedOperation, posición del gesto y las trampas de PlatformArgs por plataforma en Android, iOS, Mac Catalyst y Windows."
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
lang: "es"
translationOf: "2026/05/how-to-implement-drag-and-drop-in-maui-11"
translatedBy: "claude"
translationDate: 2026-05-03
---

Respuesta corta: en .NET MAUI 11, adjunta un `DragGestureRecognizer` al `View` de origen y un `DropGestureRecognizer` al `View` de destino mediante su colección `GestureRecognizers`. Para texto e imágenes en controles integrados (`Label`, `Entry`, `Image`, `Button` y similares), el framework conecta el `DataPackage` por ti, así que el valor soltado llega automáticamente. Para cualquier otra cosa, rellena `e.Data` en el manejador de `DragStarting` y léelo desde `e.Data` (un `DataPackageView`) en el manejador de `Drop`. Establece `e.AcceptedOperation = DataPackageOperation.Copy` o `None` en `DragOver` para controlar el cursor, y entra a `e.PlatformArgs` cuando necesites una vista previa de arrastre personalizada, una operación de tipo Move o leer archivos soltados desde otra aplicación.

Esta publicación recorre la superficie completa de la API con XAML y C# ejecutables para .NET MAUI 11.0.0 sobre .NET 11, incluidas las partes que la documentación oficial pasa por alto: cómo `DataPackagePropertySet` realmente mueve objetos administrados, por qué tu operación Move se degrada silenciosamente a Copy en Android, por qué tu forma personalizada es `null` en el segundo arrastre y cómo leer una ruta de archivo cuando el drop proviene del Explorador de archivos o de Photos. Todo lo de abajo se verificó contra `dotnet new maui` del SDK de .NET 11 con `Microsoft.Maui.Controls` 11.0.0.

## Por qué arrastrar y soltar en MAUI es más interesante de lo que parece

Los dos reconocedores de gestos, `DragGestureRecognizer` y `DropGestureRecognizer`, se heredaron de Xamarin.Forms 5 y vienen incluidos desde la primerísima versión de MAUI. La forma de la API no ha cambiado en MAUI 11, pero la historia específica de cada plataforma ha mejorado de forma significativa: las propiedades `PlatformArgs` que llegaron en MAUI 9 ahora son estables en las cuatro cabeceras compatibles, lo que significa que finalmente puedes hacer cosas como vistas previas de arrastre personalizadas en iOS, drops de varios archivos desde el Explorador de Windows y `UIDropOperation.Move` en Mac Catalyst sin caer en un handler personalizado.

Lo que conviene interiorizar antes de escribir cualquier código: los reconocedores de gestos son la abstracción de MAUI sobre cuatro sistemas nativos muy distintos. Android usa `View.startDragAndDrop` con `ClipData`, iOS y Mac Catalyst usan `UIDragInteraction` y `NSItemProvider`, Windows usa la infraestructura WinRT `DragDrop` sobre `FrameworkElement`. El `DataPackage` multiplataforma transporta texto, una imagen y una bolsa de propiedades `Dictionary<string, object>`. Cualquier cosa que pongas en esa bolsa de propiedades es **local al proceso**, porque los sistemas nativos subyacentes solo pueden serializar texto, imágenes y URIs de archivos a través de los límites de aplicación. Esa es la mayor fuente de sorpresa cuando los desarrolladores pasan del arrastre dentro de la app al arrastre entre apps.

Si vienes de Xamarin.Forms, ninguno de tus manejadores existentes necesita cambiar. Los nombres de clase, las firmas de evento y la enumeración `DataPackageOperation` son idénticos byte a byte. La historia de `PlatformArgs` es nueva; el resto es el mismo código que se publicó en 2020.

## Arrastrar un Label de texto y soltarlo en un Entry

Empieza con la cosa útil más pequeña: arrastrar un valor de texto desde un `Label` y soltarlo en un `Entry`. Como ambos son controles de texto integrados, MAUI rellena el `DataPackage` y lo lee automáticamente, así que toda la funcionalidad es XAML.

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

Un gesto de arrastre se inicia con un long-press seguido de un arrastre en plataformas táctiles, y con un mouse-down-and-move normal en Windows y Mac Catalyst. No se requiere código en el code-behind: MAUI lee `Label.Text` en `DataPackage.Text` al salir, y escribe `DataPackage.Text` en `Entry.Text` al entrar.

El mismo cableado automático cubre `CheckBox.IsChecked`, `DatePicker.Date`, `Editor.Text`, `RadioButton.IsChecked`, `Switch.IsToggled` y `TimePicker.Time` tanto del lado de origen como del de destino, además de las imágenes en `Button`, `Image` e `ImageButton`. Los booleanos y las fechas se convierten mediante un round-trip con `string`, lo que significa que un drop mal formado (arrastrar el texto "yes" a un `CheckBox`) falla silenciosamente al cambiar `IsChecked`.

## Mover una tarjeta entre dos columnas

El caso interesante es tu propia interfaz de usuario: un tablero con tarjetas que quieres arrastrar entre columnas. El `DataPackage` no puede transportar un objeto administrado entre procesos, pero para arrastrar dentro de la app sí puede transportarlo a través de `Properties`.

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

Cada tarjeta se construye en código y recibe su propio `DragGestureRecognizer`:

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

El evento `DragStarting` recibe un `DragStartingEventArgs` cuya propiedad `Data` es un `DataPackage` nuevo por arrastre. Establecer `e.Data.Properties["Card"]` almacena la referencia real a `Card` en un `Dictionary<string, object>`. Del lado del drop accedes al mismo diccionario:

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

Aquí ocurren dos cosas no obvias.

Primero, `e.Data` en un `DropEventArgs` es un `DataPackageView`, no un `DataPackage`. Es de solo lectura intencionalmente: el destino del drop no puede mutar el paquete. Lees `Properties` (un `DataPackagePropertySetView`) y llamas a `await e.Data.GetTextAsync()` o `await e.Data.GetImageAsync()` para los huecos predefinidos de texto e imagen. Los métodos asíncronos devuelven `Task<string?>` y `Task<ImageSource?>` respectivamente.

Segundo, establecer `e.Handled = true` en el manejador de `Drop` le dice a MAUI que no aplique su comportamiento por defecto. Eso importa cuando tu destino de drop es un `Label` o una `Image`, porque de lo contrario MAUI *también* intentará establecer el texto o la imagen desde el data package por encima de lo que hagas manualmente, lo que provoca un bug de doble actualización doloroso de rastrear.

## Elegir el `AcceptedOperation` correcto

El evento `DragOver` se dispara continuamente mientras el puntero está sobre un destino de drop. Su trabajo es establecer `e.AcceptedOperation`, que determina el visual del cursor en Windows y Mac Catalyst, y la retroalimentación del sistema en iOS. La enumeración `DataPackageOperation` tiene exactamente dos valores que vienen con MAUI: `Copy` y `None`. No hay `Move`, no hay `Link`, no hay combinaciones de banderas, sin importar lo que sugiera IntelliSense si has referenciado `Windows.ApplicationModel.DataTransfer`.

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

Cuando se construye un `DragEventArgs`, `AcceptedOperation` toma `Copy` por defecto. Si quieres una columna que rechace todos los drops (por ejemplo, una columna "Archivo" de solo lectura cuando estás en modo vista), tienes que establecerla activamente en `None` en `DragOver`. Olvidar esto es la razón más común de que un destino acepte todo accidentalmente.

Para conseguir una semántica Move en iOS y Mac Catalyst, donde el sistema realmente distingue Copy de Move con un badge visible, baja a `PlatformArgs`:

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

En Android, arrastrar y soltar no tiene distinción Copy versus Move en la capa entre apps, así que la propiedad `AcceptedOperation` solo controla la afordancia dentro de la app. En Windows, el cursor `Copy` versus `None` se conduce directamente desde `AcceptedOperation`.

## Personalizar la vista previa del arrastre

La vista previa de arrastre por defecto es una captura de la vista de origen, lo cual normalmente está bien. Cuando no lo está, cada plataforma expone su propio gancho de vista previa a través de `PlatformArgs`.

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

En Android, `SetDragShadowBuilder` controla la sombra que sigue al dedo; en iOS y Mac Catalyst, `SetPreviewProvider` devuelve un `UIDragPreview`; en Windows, establece las propiedades de `e.PlatformArgs.DragStartingEventArgs.DragUI` y recuerda establecer `e.PlatformArgs.Handled = true` para que MAUI no sobrescriba tus cambios.

Esa bandera `Handled` es la trampa más fácil de toda la API: en Windows, cada `PlatformArgs` es un envoltorio fino sobre un objeto de event args de WinRT, y cualquier propiedad que establezcas la sobrescribe silenciosamente la fontanería por defecto de MAUI a menos que establezcas `Handled = true` en los propios platform args (por separado de `DragEventArgs.Handled` y `DropEventArgs.Handled`, que controlan el procesamiento a nivel de MAUI).

## Obtener la posición del drop

En MAUI 11, los tres event args (`DragStartingEventArgs`, `DragEventArgs` y `DropEventArgs`) exponen un método `GetPosition(Element?)` que devuelve `Point?`. Pasa `null` para coordenadas de pantalla, o pasa un elemento para obtener coordenadas relativas a ese elemento.

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

Si recuerdas el viejo workaround de leer `MotionEvent.GetX/Y` desde el `PlatformArgs.DragEvent` de Android y `LocationInView` desde el `DropSession` de iOS, ya no lo necesitas. `GetPosition` devuelve `null` solo cuando la plataforma genuinamente no reportó una posición (raro, pero trata el nullable como crítico).

## Recibir un archivo desde otra aplicación

El arrastre entre apps es compatible en iOS, Mac Catalyst y Windows. Android no puede ser un destino de drop para elementos de otra app a través de la API del reconocedor de gestos.

La forma de los datos es específica de cada plataforma porque la carga útil entre procesos siempre es nativa: una colección de `UIDragItem` en iOS y Mac Catalyst, un `DataPackageView` en Windows. MAUI te da los objetos nativos a través de `PlatformArgs`.

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

La variante de iOS/Mac Catalyst usa `e.PlatformArgs.DropSession.Items` y le pide a cada `NSItemProvider` que cargue una representación del archivo en su lugar. El patrón completo de los samples de .NET MAUI está documentado en Microsoft Learn en [Drag and drop between applications](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/gestures/drag-and-drop?view=net-maui-10.0#drag-and-drop-between-applications).

Para ambas plataformas, el manejador de `Drop` se ejecuta en el hilo de UI y el archivo todavía no está copiado. Si necesitas los bytes, cópialos dentro del manejador antes de retornar, porque la app de origen tiene permitido revocar la sesión de arrastre tan pronto como tu manejador termine.

## Cinco trampas que se comerán una tarde

**1. El `DataPackage` es de un solo uso.** Cada gesto de arrastre crea un `DataPackage` nuevo. Si guardas en caché `e.Data` y tratas de leerlo después desde un drop diferente, obtendrás los datos del arrastre *original*, no del actual, que es la fuente de los bugs "la segunda tarjeta que arrastro está mal".

**2. `Properties` es local al proceso.** Cualquier cosa que pongas en `e.Data.Properties` funciona impecablemente dentro de tu app y es invisible entre aplicaciones. Si quieres una carga útil que sobreviva a un drop entre apps, establece también `e.Data.Text` (o escribe a `PlatformArgs.SetClipData` en Android, `SetItemProvider` en iOS) para que el sistema tenga algo concreto que serializar.

**3. El drop por defecto en `Label`/`Image`/`Entry` siempre se dispara.** Si manejas `Drop` y actualizas el destino manualmente, establece `e.Handled = true`, de lo contrario la asignación automática de texto o imagen de MAUI se ejecutará después de tu manejador y aplastará el resultado.

**4. `DropGestureRecognizer` no hace bubbling.** Cada elemento visual o tiene un reconocedor o no lo tiene. Si pones el reconocedor en un `Grid` padre y el `Border` hijo no tiene reconocedor propio, el gesto funciona como se espera; pero si el hijo tiene cualquier otro reconocedor de gestos, el hit-testing para el drop puede caer en el hijo y saltarse el padre. Sé explícito: pon el reconocedor de drop en el elemento más profundo que deba aceptar el drop.

**5. Arrastrar y soltar en Android requiere una `View` que participe en el hit testing.** Un `Label` con `InputTransparent="True"` se negará silenciosamente a iniciar un arrastre, y un `BoxView` sin color de fondo solo interceptará gestos sobre el rectángulo que el rasterizador efectivamente pinta. Si tu arrastre nunca empieza en Android, establece un `BackgroundColor` en la vista de origen como prueba de cordura antes de tirar de overrides de `Handler`.

## Bloques de construcción para interacciones más ricas

Arrastrar y soltar es la forma con menos fricción de añadir manipulación directa a una app de MAUI para escritorio o tablet, pero los reconocedores de gestos también son el bloque al que recurres cuando escribes una lista reordenable, una ventana de tab-tear-out o un tablero estilo Trello. Ninguno de esos se compone hoy en un único control de biblioteca, razón por la cual cada app de escritorio MAUI seria implementa el suyo. La buena noticia es que la API subyacente es lo bastante pequeña como para que "implementa el suyo" suela significar cien líneas de código, la mayoría de las cuales son la personalización de la vista previa específica de plataforma en lugar del manejo del gesto en sí.

Si estás construyendo una cabecera de MAUI solo para escritorio, el resto de la [configuración de MAUI 11 para Windows y macOS solamente](/es/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) recorre cómo despojar las cabeceras móviles de tus target frameworks para que tu `dotnet build` deje de arrastrar workloads de Android e iOS. Para un recorrido por lo demás que es nuevo en el framework, mira [novedades en .NET MAUI 10](/es/2025/04/whats-new-in-net-maui-10/), que cubre las adiciones de `PlatformArgs` de las que depende este post. Si necesitas anular colores de tema que aparecen en tu vista previa de arrastre, el mismo patrón de handler en [cómo cambiar el color del icono de SearchBar en .NET MAUI](/es/2025/04/how-to-change-searchbars-icon-color-in-net-maui/) se generaliza a la mayoría de los retoques nativos de vista previa. Y si tu app es una biblioteca de clases que aloja estos gestos, [cómo registrar handlers en una biblioteca MAUI](/es/2023/11/maui-library-register-handlers/) cubre la fontanería de `MauiAppBuilder` que necesitas para que los reconocedores realmente se adjunten cuando arranque la app que los consume.

## Enlaces de referencia

- [Recognize a drag and drop gesture - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/gestures/drag-and-drop?view=net-maui-10.0)
- [DragGestureRecognizer Class - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.draggesturerecognizer)
- [DropGestureRecognizer Class - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.dropgesturerecognizer)
- [DataPackage Class - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.datapackage)
- [.NET MAUI Drag and Drop Gesture sample](https://learn.microsoft.com/en-us/samples/dotnet/maui-samples/gestures-draganddropgesture/)

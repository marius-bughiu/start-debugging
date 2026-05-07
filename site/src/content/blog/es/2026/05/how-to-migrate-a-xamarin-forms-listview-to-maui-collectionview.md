---
title: "Migra un ListView de alto rendimiento de Xamarin.Forms a CollectionView de MAUI"
description: "Migración paso a paso de ListView de Xamarin.Forms 5.0 a CollectionView de .NET MAUI 11 para aplicaciones que ya exprimieron el rendimiento de ListView. Cubre reciclaje de celdas, virtualización, agrupación, pull-to-refresh, acciones contextuales, selección, ItemsLayout, EmptyView y los detalles que afectan a aplicaciones reales."
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
lang: "es"
translationOf: "2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview"
translatedBy: "claude"
translationDate: 2026-05-07
---

La versión corta: reemplaza `ListView` con `CollectionView` envuelto en un `RefreshView` si necesitabas pull-to-refresh, cambia `ContextActions` por `SwipeView`, descarta `HasUnevenRows`, `RowHeight` y `CachingStrategy` porque la virtualización con reciclaje de celdas es el único modo en MAUI, y reescribe la selección de `ItemTapped` / `ItemSelected` a `SelectionMode` más `SelectionChangedCommand`. Si tu antiguo `ListView` estaba ajustado con `CachingStrategy="RecycleElement"`, `HasUnevenRows="True"` y un `DataTemplateSelector`, el cambio es mayormente mecánico. Probado con .NET MAUI 11.0 GA en `net11.0-android35.0`, `net11.0-ios18.0` y `net11.0-maccatalyst18.0`. Espera de uno a tres días de trabajo enfocado para una aplicación con cinco a diez listas, más tiempo si dependes mucho de agrupación al estilo `TableView` o de renderers personalizados de `ViewCell`.

Xamarin.Forms dejó de tener soporte el [1 de mayo de 2024](https://dotnet.microsoft.com/en-us/platform/support/policy/maui), y MAUI 11 GA salió en noviembre de 2025 con la tercera generación de correcciones de CollectionView para el jank en Android. Si has estado postergando la migración porque el rendimiento de tu aplicación estaba ajustado a mano alrededor de peculiaridades de `ListView` como `RecycleElementAndDataTemplate`, vale la pena hacer la actualización ahora: CollectionView en MAUI 11 finalmente iguala o supera al antiguo `ListView` de Xamarin.Forms en Android una vez que desactivas `ItemSizingStrategy.MeasureAllItems`. Esta guía es para esa audiencia.

## Por qué migrar ahora

- Xamarin.Forms ya no tiene soporte. Sin parches de CVE, sin correcciones para Android 15 / iOS 18. Las tiendas de aplicaciones seguirán exigiendo aumentos de target SDK; no puedes seguirles el ritmo en Xamarin.Forms.
- CollectionView es el único control de colección en MAUI que usa colecciones virtualizadas nativas de la plataforma (`RecyclerView` en Android, `UICollectionView` en iOS). `ListView` existe en MAUI por compatibilidad hacia atrás, pero es una [envoltura delgada que delega en CollectionView por debajo](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/listview) y hereda la forma de la API antigua, no el renderer antiguo.
- `ItemsLayout` te permite cambiar entre layouts lineales y de cuadrícula sin subclasificar ni hacer trucos con repeaters. El mismo control cubre lo que antes requería `ListView` más `FlowListView`.
- `EmptyView` es una propiedad real basada en plantilla, no un cambio manual de `IsVisible` en una etiqueta hermana.

## Qué se rompe

| Área | ListView de Xamarin.Forms | CollectionView de MAUI | Severidad |
| ---- | ------------------------- | ---------------------- | --------- |
| Estrategia de caché | `CachingStrategy="RetainElement"` o `RecycleElement` | Siempre recicla. La propiedad no existe. | media |
| Altura de fila | `HasUnevenRows`, `RowHeight` | `ItemSizingStrategy="MeasureAllItems"` o `MeasureFirstItem` | media |
| Pull to refresh | `IsPullToRefreshEnabled`, `RefreshCommand` en `ListView` | Envolver en `RefreshView` | alta |
| Tipo de celda | `ViewCell`, `TextCell`, `ImageCell` | `DataTemplate` plano con cualquier layout como raíz | alta |
| Manejo de tap | `ItemTapped`, `ItemSelected` | `SelectionMode`, `SelectionChanged`, `SelectionChangedCommand` | alta |
| Acciones de swipe | `ContextActions` | `SwipeView` | alta |
| Separadores | `SeparatorVisibility`, `SeparatorColor` | Ninguno. Agrega un `BoxView` en la plantilla. | baja |
| Headers / footers | `Header`, `Footer` (objeto o plantilla) | Mismos nombres, pero solo como plantillas / vistas | baja |
| Agrupación | `IsGroupingEnabled`, `GroupHeaderTemplate` | `IsGrouped`, `GroupHeaderTemplate`, `GroupFooterTemplate` | media |
| Scroll to | `ScrollTo(item, ScrollToPosition)` | `ScrollTo(item, position, animate)` | baja |
| Estado vacío | Etiqueta hermana manual | `EmptyView`, `EmptyViewTemplate` | baja |

Los dos cambios que duelen son pull-to-refresh y selección. Todo lo demás es un renombrado directo o una eliminación.

## Lista de verificación previa al despegue

1. SDK de .NET 11 instalado (`dotnet --version` reporta `11.0.x`). MAUI 11 requiere el SDK de .NET 11. Los SDK anteriores no tienen el manifiesto de la workload.
2. Workload de MAUI instalada: `dotnet workload install maui`. Si actualizaste sobre una instalación anterior, ejecuta `dotnet workload repair` primero.
3. Plataformas Android SDK 35, iOS 18 y Mac Catalyst 18 disponibles. Visual Studio 2022 17.13 o Visual Studio Code con la extensión .NET MAUI 1.6+.
4. Una rama de `git` que puedas descartar. Mantén el proyecto de Xamarin.Forms compilando en `main` hasta que la compilación de MAUI esté en verde en un dispositivo real.
5. Una lista de cada instancia de `ListView` en el proyecto. Agrúpalas por área de funcionalidad; migra una funcionalidad a la vez y publica detrás de un feature flag si tu cadencia de releases es mensual.
6. Ejecuta el [.NET Upgrade Assistant](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview) sobre el proyecto una vez para manejar los cambios de `csproj`, espacios de nombres y `MauiProgram`. El Upgrade Assistant no reescribe el XAML de `ListView` por ti, que es lo que cubre el resto de este post.

## Pasos de la migración

### 1. Reemplaza `ListView` por `CollectionView`

El caso más simple es una lista plana con un `DataTemplate` personalizado:

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

Lo que cambió:

- `ViewCell` desapareció. La raíz de la plantilla es un layout (`Grid`, `VerticalStackLayout`, etc.) directamente.
- `CachingStrategy` desapareció. El reciclaje siempre está activo. El antiguo `RecycleElementAndDataTemplate` es el equivalente más cercano y ahora es el único modo.
- `HasUnevenRows="True"` desapareció. CollectionView mide cada celda por defecto. Si tus filas tienen todas el mismo tamaño, configura `ItemSizingStrategy="MeasureFirstItem"` para una ganancia medible de rendimiento de scroll en Android.
- `SeparatorVisibility="None"` es el nuevo valor por defecto. Agrega un `BoxView HeightRequest="1"` dentro de la plantilla si realmente quieres uno.
- `x:DataType` en la plantilla habilita los bindings compilados. Configúralo siempre. El rendimiento de CollectionView se desploma con bindings por reflexión en Android.

**Verifica**: compila para Android (`dotnet build -t:Run -f net11.0-android35.0`) y haz scroll en una lista de 1000 elementos en un dispositivo de gama media. El tiempo de frame debería estar por debajo de 16 ms en la vista Profile GPU Rendering de Android Studio. Si no lo está, revisa que `x:DataType` esté configurado y que ningún binding dentro de la plantilla use `Source={x:Reference ...}`.

### 2. Envuelve en `RefreshView` para pull-to-refresh

`IsPullToRefreshEnabled`, `IsRefreshing` y `RefreshCommand` ya no están en la lista. Viven en `RefreshView`, que envuelve cualquier contenido scrollable.

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

`RefreshView` solo se dispara cuando el contenido scrollable envuelto está en offset cero, así que el comportamiento coincide con el antiguo `ListView`. No hay `IsPullToRefreshEnabled`; si necesitas desactivarlo, configura `IsEnabled="False"` en el `RefreshView`.

**Verifica**: desliza hacia abajo en la lista mientras está en offset cero. El spinner de la plataforma debería aparecer y `RefreshCommand` debería dispararse exactamente una vez por gesto.

### 3. Reescribe la selección

El evento `ItemTapped` de Xamarin.Forms se dispara en cada tap, incluso cuando `SelectedItem` no cambió. CollectionView separa esto claramente: el tap es selección, y la selección es observable a través de `SelectionChanged` o `SelectionChangedCommand`. Si dependías del tap para navegar al mismo elemento dos veces seguidas, tienes que salir del estado de selección leyendo y limpiando `SelectedItem` después de cada navegación:

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

`SelectionMode="None"` más un `TapGestureRecognizer` dentro de la plantilla es el equivalente más cercano a la antigua semántica de `ItemTapped`. Úsalo solo si tienes una razón. El patrón basado en selección es lo que las plataformas esperan y es lo que te da anillos de foco de accesibilidad gratis en Windows.

**Verifica**: toca un elemento, navega hacia atrás, toca el mismo elemento. Ambos taps deberían abrir la página de detalle.

### 4. Reemplaza `ContextActions` por `SwipeView`

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

`SwipeView` es un swipe real a izquierda y derecha con fondos personalizados. `IsDestructive` se convierte en un `BackgroundColor` normal. `Mode="Execute"` coincide con el comportamiento antiguo de descartar al tocar; `Mode="Reveal"` mantiene el menú abierto. La pulsación larga en iOS para revelar un menú desapareció; si la necesitas, usa `MenuFlyout` en MAUI 11 (nuevo en esta versión).

**Verifica**: desliza a la izquierda en iOS y Android. Toca delete. El elemento se elimina. Desliza de nuevo en la siguiente fila para confirmar que solo hay un swipe abierto a la vez.

### 5. Cambia la agrupación

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

Cambian dos cosas. La bandera es `IsGrouped`, no `IsGroupingEnabled`. Y la fuente debe ser una colección de colecciones donde cada elemento exterior sea a su vez enumerable. El patrón más limpio es una clase `Grouping<TKey, TItem>` que deriva de `List<TItem>` y expone `Key`. Ese es el mismo patrón que usaba Xamarin.Forms y se porta sin cambios.

**Verifica**: haz scroll en una lista agrupada de 30 días. Los headers de grupo deberían quedarse fijos en la parte superior de su grupo en iOS por defecto (`GroupHeadersStick="True"` en iOS nativo; el valor por defecto de MAUI lo refleja).

### 6. Elige un `ItemsLayout`

El valor por defecto es `LinearItemsLayout` vertical, que coincide con `ListView`. Cambia a una cuadrícula con una sola línea:

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

`Span="3"` es un conteo fijo de columnas. No hay una cuadrícula adaptativa integrada; para eso dimensionas las celdas contra el ancho disponible con un behaviour o vuelves a vincular en cambios de tamaño.

**Verifica**: rota el dispositivo. La cuadrícula debería redibujarse sin perder la posición de scroll.

### 7. Agrega un `EmptyView`

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

Para múltiples estados vacíos (sin datos vs error), vincula `EmptyView` a una propiedad y usa `EmptyViewTemplate` con un `DataTemplateSelector`.

**Verifica**: limpia la fuente. La vista vacía aparece. Vuelve a llenar la fuente. La vista vacía desaparece sin un frame de superposición.

## Lista de verificación

Después de migrar cada lista:

- `dotnet build -c Release` para `net11.0-android35.0`, `net11.0-ios18.0`, `net11.0-maccatalyst18.0` y `net11.0-windows10.0.19041.0` produce cero advertencias sobre APIs obsoletas de `ListView`.
- `dotnet test` contra la capa de ViewModel está en verde. La lógica de selección es la regresión más probable; cúbrela.
- En Android, haz scroll en una lista de 1000 elementos en un Pixel 6 o equivalente. El tiempo de frame se mantiene por debajo de 16 ms con `MeasureFirstItem` si las filas son uniformes. Con `MeasureAllItems` y 1000 elementos, espera un costo único de medición en la primera visualización.
- En iOS, mantén el dedo sobre una fila. No debería quedar ningún feedback de selección después de soltar si `SelectionMode="None"`.
- Pull-to-refresh se dispara exactamente una vez por gesto, en cada plataforma.
- Las acciones de swipe se revelan en el lado correcto (los idiomas RTL se reflejan automáticamente; verifica en una localización árabe si la envías).
- `EmptyView` es anunciado por VoiceOver / TalkBack. CollectionView trae texto de accesibilidad para el estado vacío automáticamente; un `SemanticProperties.Description` manual lo sobrescribe.

## Plan de reversión

En la práctica, esta es una migración de un solo sentido. Una vez que el proyecto está en target frameworks `net11.0-*` y `MauiProgram.cs`, volver a Xamarin.Forms significa restaurar la forma antigua del `csproj`, el `Xamarin.Forms.Forms.Init` y los puntos de entrada de aplicación específicos de la plataforma. Nada en este post sobre CollectionView en sí es reversible por separado de la actualización del proyecto. Planea publicar una compilación de MAUI funcionando antes de borrar la rama de Xamarin.Forms.

## Detalles que nos afectaron

- Semántica de `ItemTapped`. Si tu código antiguo llamaba a `ListView.SelectedItem = null` en `ItemTapped` para hacer que la misma fila fuera tappable dos veces, debes seguir limpiando `SelectedItem` (o `SelectedItems`) después de cada navegación. CollectionView no se limpia automáticamente.
- `RemainingItemsThreshold` para scroll infinito está en CollectionView (`RemainingItemsThreshold` más `RemainingItemsThresholdReachedCommand`). El antiguo patrón `ItemAppearing` aún funciona pero se dispara por elemento; el patrón de threshold se dispara una vez cerca del final, que es lo que la mayoría de las interfaces de scroll infinito realmente quieren.
- `ScrollTo` ya no acepta un valor de enum `ScrollToPosition` de `MakeVisible`. El mapeo más cercano es de `ScrollToPosition.MakeVisible` a `ScrollToPosition.MakeVisible` (mismo nombre, mismo enum), pero el segundo argumento ahora es el índice de grupo. Para una lista no agrupada pasa `null`. Lee la [documentación de ScrollTo de CollectionView](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/collectionview/scrolling) antes de portar cualquier lógica de scroll personalizada.
- Los bindings compilados (`x:DataType`) son obligatorios para el rendimiento. Sin ellos, el scroll tiene tirones en Android porque cada binding se resuelve por reflexión en cada reciclaje.
- `ItemSizingStrategy.MeasureAllItems` en una lista larga con altura variable fuerza una pasada completa de medición en la primera visualización. Si tienes diez mil elementos y la lista es lo primero en pantalla, tu tiempo hasta el primer frame se degrada. Usa una altura de celda fija cuando puedas.
- Los renderers personalizados de `ViewCell` no se portan. No hay `ViewCellRenderer` en MAUI. Si tenías uno, la celda se convierte en un layout normal en MAUI, y la lógica del renderer se mueve a un [handler](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/) sobre cualquier control hijo que la necesitara.
- `TableView` aún existe en MAUI para pantallas estáticas estilo ajustes. No lo uses para datos dinámicos. No virtualiza.

## Relacionado

- [Cómo soportar correctamente el modo oscuro en una aplicación MAUI](/es/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) cubre los patrones de `AppThemeBinding` que necesitan las plantillas dentro de CollectionView.
- [Cómo implementar arrastrar y soltar en MAUI 11](/es/2026/05/how-to-implement-drag-and-drop-in-maui-11/) muestra cómo combinar `DragGestureRecognizer` con elementos de `CollectionView`, que es el reemplazo moderno para el reordenamiento de ListView.
- [Cómo empaquetar una aplicación MAUI para la Microsoft Store](/es/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) es el siguiente paso una vez que la migración está hecha y quieres publicar para Windows de nuevo.
- [Cómo escribir una aplicación MAUI que se ejecute solo en Windows y macOS](/es/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) es la referencia correcta si estás eliminando móvil de un proyecto de Xamarin.Forms al mismo tiempo.

## Fuentes

- [Documentación de CollectionView de .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/collectionview/)
- [Documentación de ListView de .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/listview)
- [Política de soporte de Xamarin.Forms](https://dotnet.microsoft.com/en-us/platform/support/policy/maui)
- [Actualizar desde Xamarin.Forms](https://learn.microsoft.com/en-us/dotnet/maui/migration/) en MS Learn
- [.NET Upgrade Assistant](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview)

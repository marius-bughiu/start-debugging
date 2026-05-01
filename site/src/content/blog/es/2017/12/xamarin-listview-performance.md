---
title: "Rendimiento del ListView de Xamarin y reemplazo por Syncfusion SfListView"
description: "Mejora el rendimiento de scroll del ListView de Xamarin Forms con estrategias de caching, optimización de templates y Syncfusion SfListView."
pubDate: 2017-12-16
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "es"
translationOf: "2017/12/xamarin-listview-performance"
translatedBy: "claude"
translationDate: 2026-05-01
---
Mientras Xamarin sigue añadiendo características y mejora el rendimiento de Xamarin Forms con cada actualización, lo que ofrecen en cuanto a controles de usuario multiplataforma no siempre es suficiente. En mi caso, tengo una app lectora de RSS que agrega artículos de noticias de distintas fuentes y los muestra en un ListView así:

Aunque me gusta cómo se ve la app, tiene un gran problema: el rendimiento. Incluso en dispositivos de gama alta el scroll va lento, y en dispositivos de gama baja sigue lanzando OutOfMemory exceptions debido a las imágenes que se cargan. Así que hacía falta un cambio. En este artículo solo cubriré el primero, el rendimiento del scroll; las OutOfMemory exceptions las veremos otro día.

### El item template

Lo primero que debes mirar al solucionar problemas de rendimiento es el ItemTemplate del ListView. Cualquier optimización que puedas hacer a este nivel tendrá un gran impacto en el rendimiento global del ListView. Mira cosas como:

-   reducir el número de elementos XAML. Cuantos menos elementos haya que renderizar, mejor
-   lo mismo aplica al anidamiento. Evita anidar elementos y crear jerarquías profundas. Renderizar eso lleva demasiado tiempo
-   asegúrate de que tu ItemSource sea una IList y no una colección IEnumerable. IEnumerable no soporta acceso aleatorio
-   no cambies el layout en función de tu BindingContext. Usa un DataTemplateSelector

Ya deberías ver algunas mejoras en el scroll tras estos cambios. Lo siguiente es la estrategia de caching.

### Estrategia de caching

Por defecto, Xamarin usa la estrategia de caching RetainElement para Android e iOS, lo que significa que crea una instancia de tu ItemTemplate por cada elemento de la lista. Cambia la caching strategy del ListView a RecycleElement para reutilizar contenedores que ya no están en vista en lugar de crear elementos nuevos cada vez. Esto mejorará el rendimiento al eliminar costes de inicialización.

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

Si por casualidad estás usando un DataTemplateSelector, entonces deberías usar la caching strategy RecycleElementAndDataTemplate. Para más detalles sobre estrategias de caching puedes consultar [la documentación de Xamarin](https://learn.microsoft.com/en-us/xamarin/xamarin-forms/user-interface/listview/performance) sobre rendimiento de ListView.

### Syncfusion ListView

Si has llegado hasta aquí y tus problemas de rendimiento siguen sin resolverse, es hora de mirar otras opciones. En mi caso, probé el SfListView de Syncfusion porque son conocidos por sus suites de controles y ofrecen sus controles Xamarin gratis bajo las mismas condiciones que Visual Studio Community (más o menos). Para empezar, ve al sitio de Syncfusion y [reclama tu licencia community gratuita](https://www.syncfusion.com/products/communitylicense) si aún no la tienes.

A continuación, añade el paquete SfListView a tu proyecto. Los paquetes de Syncfusion están disponibles en su propio repositorio NuGet. Para acceder a él tendrás que añadirlo a tus NuGet sources. Una guía completa sobre cómo hacerlo se encuentra [aquí](https://help.syncfusion.com/xamarin/listview/getting-started). Una vez hecho, una simple búsqueda de SfListView en NuGet te llevará al paquete deseado. Instala el paquete en tu proyecto core/cross-platform y también en todos tus proyectos de plataforma; recogerá automáticamente las DLLs correctas según el target de tu proyecto.

Ahora que tienes todo instalado, es momento de reemplazar el ListView estándar. Para ello, añade el siguiente namespace en tu page/view:

```xml
xmlns:sflv="clr-namespace:Syncfusion.ListView.XForms;assembly=Syncfusion.SfListView.XForms"
```

Y luego reemplaza el tag ListView por sflv:ListView, el ListView.ItemTemplate por sflv:SfListView.ItemTemplate y elimina el ViewCell de tu jerarquía: no es necesario. Además, si estabas usando la propiedad CachingStrategy, quítala también: SfListView recicla elementos por defecto. Deberías acabar con algo así:

```xml
<sflv:SfListView>
    <sflv:SfListView.ItemTemplate>
        <DataTemplate>
           ...
        </DataTemplate>
    </sflv:SfListView.ItemTemplate>
</sflv:SfListView>
```

Eso es todo. Si tienes preguntas, dímelo en la sección de comentarios. Y si tienes otros consejos para mejorar el rendimiento del ListView, compártelos.

---
title: "Cómo empezar con CSS en Xamarin Forms 3"
description: "Aprende a usar Cascading StyleSheets (CSS) en Xamarin Forms 3, incluyendo estilos CDATA en línea y archivos CSS embebidos."
pubDate: 2018-04-18
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "es"
translationOf: "2018/04/getting-started-with-css-in-xamarin-forms-3"
translatedBy: "claude"
translationDate: 2026-05-01
---
Hay varias novedades en esta nueva versión de Xamarin Forms, y una de ellas son las Cascading StyleSheets (CSS). Sí, eso es: CSS en XAML. Aún no estoy seguro de lo útil que será y de cuánto se adoptará -- todavía faltan bastantes funciones --, pero supongo que será una buena noticia para quienes vienen del desarrollo web.

Sin más, hay dos formas de añadir CSS a tu aplicación:

-   primera, dejando los estilos directamente en los recursos del elemento y envolviéndolos en un tag CDATA
-   y la segunda implica archivos .css reales añadidos como recursos embebidos en tu proyecto

Y una vez que tengas el CSS incluido, lo usas especificando **StyleClass** o la propiedad abreviada **class** en tu elemento XAML.

Para ejemplificar, haremos algunos cambios sobre un nuevo proyecto Xamarin Forms con la plantilla master detail. Adelante, File > New project y actualízalo a Xamarin Forms 3.

Primero, la vía CDATA. Supongamos que queremos poner los elementos de nuestra lista en color naranja. Ve a ItemsPage y dentro del XAML, encima del tag `<ContentPage.ToolbarItems>`, mete esto:

```xml
<ContentPage.Resources>
    <StyleSheet>
        <![CDATA[

            .my-list-item {
                padding: 20;
                background-color: orange;
                color: white;
            }

        ]]>
    </StyleSheet>
</ContentPage.Resources>
```

Ahora necesitamos usar esta nueva clase .my-list-item. Busca el ItemTemplate de tu ListView y fíjate en el StackLayout interno: ese es nuestro objetivo. Quita ese padding y aplica nuestra clase así:

```xml
<StackLayout Padding="10" class="my-list-item">
```

Y eso es todo.

Veamos ahora el segundo enfoque, el de los archivos CSS embebidos. Primero, crea una nueva carpeta en tu app llamada Styles y crea dentro un archivo nuevo llamado about.css (vamos a estilizar la página About en esta parte). Tras crear el archivo, asegúrate de hacer clic derecho > Properties y poner el **Build action** en **Embedded resource**; si no, no funcionará.

Ahora, en nuestra vista -- AboutPage.xaml --, añade lo siguiente justo encima del elemento <ContentPage.BindingContext>. Esto referenciará nuestro archivo CSS en nuestra página. El hecho de que la ruta empiece con "/" significa que parte de la raíz. También puedes especificar rutas relativas omitiendo la primera barra.

```xml
<ContentPage.Resources>
   <StyleSheet Source="/Styles/about.css" />
</ContentPage.Resources>
```

En cuanto al CSS, hagamos pequeños cambios en el título de la app y en el botón learn more, así:

```css
.app-name {
    font-size: 48;
    color: orange;
}

.learn-more {
    border-color: orange;
    border-width: 1;
}
```

Cuidado, porque font-size y border-width son valores simples (double); no especifiques "px" porque no funcionará y dará error. Supongo que los valores se entienden en DIP (device independent pixels). Lo mismo aplica a otras propiedades como thickness, margin, padding, etc.

Todo se ve bonito, pero ten en cuenta que hay algunas limitaciones:

-   No todos los selectores están soportados en esta versión. Los selectores \[attribute\], @media y @supports, o los selectores : y ::. Aún no funcionan. Además, por lo que he probado, apuntar a un elemento con dos clases como .class1.class2 tampoco funciona.
-   No todas las propiedades están soportadas y, sobre todo, no todas las propiedades soportadas funcionan en todos los elementos. Por ejemplo: la propiedad text-align solo está soportada para Entry, EntryCell, Label y SearchBar, así que no puedes alinear a la izquierda el texto de un Button. O si tomas la propiedad border-width, esta solo funciona con buttons.
-   La herencia no está soportada

Para ver una lista completa de lo soportado y lo no soportado, puedes consultar [el pull request de esta función en GitHub](https://github.com/xamarin/Xamarin.Forms/pull/1207). Por si algo va mal o no funciona, el repositorio original del ejemplo ya no está disponible en GitHub, pero los snippets anteriores son suficientes para empezar.

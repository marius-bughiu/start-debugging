---
title: "Cómo tomar una captura de pantalla en .NET core"
description: "Aprende a capturar una imagen de todo tu escritorio desde una aplicación de consola .NET usando System.Windows.Forms. Solución solo para Windows que cubre todos los monitores."
pubDate: 2023-11-04
tags:
  - "csharp"
  - "dotnet"
lang: "es"
translationOf: "2023/11/how-to-take-a-screenshot-in-net-core"
translatedBy: "claude"
translationDate: 2026-05-01
---
En este artículo vamos a ver cómo puedes capturar una imagen de todo tu escritorio (es decir, de todos tus monitores, no solo del principal) desde una aplicación de consola usando .NET core. Esta solución se basa en dependencias exclusivas de Windows, así que no funcionará de forma multiplataforma; solo funcionará en Windows.

Empezamos con un poco de configuración del proyecto. Para acceder a la información de la pantalla necesitaremos `System.Windows.Forms`, y para tenerla disponible en una aplicación de consola .NET hay que añadir la siguiente referencia en nuestro `.csproj`.

```xml
<ItemGroup>
  <FrameworkReference Include="Microsoft.WindowsDesktop.App.WindowsForms" />
</ItemGroup>
```

Ahora que tenemos una referencia a `System.Windows.Forms`, podemos obtener las dimensiones de la pantalla; nos interesan las coordenadas iniciales (`x` e `y`) y su tamaño (`w` y `h`). Esta información la obtenemos de `SystemInformation.VirtualScreen`.

```cs
var screen = SystemInformation.VirtualScreen;
int x = screen.Left;
int y = screen.Top;
int w = screen.Width;
int h = screen.Height;
```

A continuación, creamos un bitmap y copiamos la información de la pantalla en él, creando así nuestra captura en memoria.

```cs
var image = new Bitmap(w, h);
using var graphics = Graphics.FromImage(image);
graphics.CopyFromScreen(x, y, 0, 0, new Size(w, h));
```

El último paso es escribir la captura en memoria a un archivo en disco. Para imitar lo que ya hace la herramienta Recortes, guardamos la imagen en la carpeta **Imágenes** e incluimos una marca de tiempo en el nombre del archivo.

```cs
string picturesDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
string fileName = $"Screenshot {DateTime.Now:yyyy-MM-dd HHmmss}.png";
string filePath = Path.Combine(picturesDirectory, fileName);
image.Save(filePath, ImageFormat.Png);
```

Si te interesa un ejemplo completamente funcional, puedes [ver el código en GitHub](https://github.com/Start-Debugging/dotnet-samples/blob/main/screenshot/Screenshot/Program.cs).

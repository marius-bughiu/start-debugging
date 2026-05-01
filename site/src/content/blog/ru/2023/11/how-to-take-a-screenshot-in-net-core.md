---
title: "Как сделать скриншот в .NET core"
description: "Научитесь делать снимок всего рабочего стола из консольного приложения .NET с помощью System.Windows.Forms. Решение только для Windows, охватывающее все мониторы."
pubDate: 2023-11-04
tags:
  - "csharp"
  - "dotnet"
lang: "ru"
translationOf: "2023/11/how-to-take-a-screenshot-in-net-core"
translatedBy: "claude"
translationDate: 2026-05-01
---
В этой статье мы посмотрим, как из консольного приложения на .NET core сделать скриншот всего рабочего стола, то есть всех мониторов, а не только основного. Это решение использует зависимости, доступные только в Windows, поэтому оно не будет работать кроссплатформенно — только под Windows.

Начнём с небольшой настройки проекта. Чтобы получить информацию об экране, нам понадобится доступ к `System.Windows.Forms`, а чтобы он был доступен в консольном приложении .NET, нужно добавить следующую ссылку в наш `.csproj`.

```xml
<ItemGroup>
  <FrameworkReference Include="Microsoft.WindowsDesktop.App.WindowsForms" />
</ItemGroup>
```

Теперь, когда у нас есть ссылка на `System.Windows.Forms`, мы можем получить размеры экрана. Нас интересуют начальные координаты (`x` и `y`) и его размер (`w` и `h`). Эту информацию мы берём из `SystemInformation.VirtualScreen`.

```cs
var screen = SystemInformation.VirtualScreen;
int x = screen.Left;
int y = screen.Top;
int w = screen.Width;
int h = screen.Height;
```

Затем создаём Bitmap и копируем в него информацию с экрана, фактически создавая скриншот в памяти.

```cs
var image = new Bitmap(w, h);
using var graphics = Graphics.FromImage(image);
graphics.CopyFromScreen(x, y, 0, 0, new Size(w, h));
```

Последний шаг — записать скриншот из памяти в файл на диске. Чтобы повторить поведение «Ножниц», мы сохраняем изображение в папку **Изображения** и включаем в имя файла временную метку.

```cs
string picturesDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
string fileName = $"Screenshot {DateTime.Now:yyyy-MM-dd HHmmss}.png";
string filePath = Path.Combine(picturesDirectory, fileName);
image.Save(filePath, ImageFormat.Png);
```

Если вам нужен полностью рабочий пример, вы можете [посмотреть код на GitHub](https://github.com/Start-Debugging/dotnet-samples/blob/main/screenshot/Screenshot/Program.cs).

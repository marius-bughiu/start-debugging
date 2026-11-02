---
title: "Как сделать снимок рабочего стола Windows из .NET"
description: "Исполняемый пример консольного .NET-приложения только для Windows: границы виртуального экрана, освобождение графических ресурсов и сохранение PNG."
pubDate: 2023-11-04
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
lang: "ru"
translationOf: "2023/11/how-to-take-a-screenshot-in-net-core"
translatedBy: "claude"
translationDate: 2026-05-01
---
Пример использует Windows Forms и `System.Drawing`, чтобы захватить ограничивающий прямоугольник виртуального экрана текущей сессии рабочего стола Windows. Это Windows-приложение, хотя проект является консольной программой.

**Исправление — 2 ноября 2026 года:** отсутствующий код восстановлен с полными настройками проекта, освобождением ресурсов, обработкой выходной папки и самопроверкой на синтетическом изображении. Он собран для Windows на macOS; реальный захват экрана Windows при этой проверке не выполнялся.

## Загрузка и настройки проекта

[Скачайте исходный проект](/examples/windows-screenshot.zip). Файл проекта содержит:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <UseWindowsForms>true</UseWindowsForms>
    <EnableWindowsTargeting>true</EnableWindowsTargeting>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
```

`UseWindowsForms` добавляет ссылку на Windows Desktop framework. `EnableWindowsTargeting` разрешает кросс-сборку при возможности восстановить targeting packs; это не делает приложение исполняемым в macOS или Linux.

## Захват виртуального экрана

Полная программа содержит импорты и STA-точку входа. Захват выполняется так:

```cs
var screen = SystemInformation.VirtualScreen;
using var bitmap = new Bitmap(screen.Width, screen.Height);
using (var graphics = Graphics.FromImage(bitmap))
{
    graphics.CopyFromScreen(
        screen.Left, screen.Top, 0, 0, screen.Size,
        CopyPixelOperation.SourceCopy);
}
bitmap.Save(filename, ImageFormat.Png);
```

`screen.Left` и `screen.Top` могут быть отрицательными, если другой монитор находится слева или выше основного. Ограничивающий прямоугольник может включать пустые участки между экранами. Захват других сеансов, защищённых рабочих столов и защищённого контента не гарантируется.

Программа создаёт выходной каталог и уникальное имя PNG, а затем освобождает объекты bitmap и graphics.

## Запуск в Windows

```powershell
dotnet run -c Release -- --self-test
dotnet run -c Release
dotnet run -c Release -- C:\Screenshots
```

Самопроверка создаёт и декодирует синтетический PNG, не захватывая рабочий стол. Обычный запуск сохраняет файл в Pictures или указанном каталоге. Проверьте реальный захват в целевой сессии Windows, включая расположение экранов и настройки DPI.

Справка: [SystemInformation.VirtualScreen](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.systeminformation.virtualscreen), [Graphics.CopyFromScreen](https://learn.microsoft.com/en-us/dotnet/api/system.drawing.graphics.copyfromscreen).

---
title: "Как перейти на C# 12"
description: "Исправьте ошибки версии языка C# 12, обновив target framework до .NET 8 или указав LangVersion в файле .csproj."
pubDate: 2023-06-10
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ru"
translationOf: "2023/06/how-to-switch-to-c-12"
translatedBy: "claude"
translationDate: 2026-05-01
---
При попытке использовать возможности C# 12 вы можете столкнуться с ошибками вроде следующих:

> Feature is not available in C# 11.0. Please use language version 12.0 or later.

или

> Error CS8652: The feature '<feature name>' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

Есть два способа исправить эту ошибку:

-   измените target framework вашего проекта на .NET 8 или новее. Версия языка должна обновиться автоматически.
-   отредактируйте файл **.csproj** и задайте нужный **<LangVersion>**, как в примере ниже:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
	<LangVersion>preview</LangVersion>
  </PropertyGroup>
</Project>
```

## Версия языка неактивна и её нельзя изменить

[![](/wp-content/uploads/2023/03/image.png)](/wp-content/uploads/2023/03/image.png)

Версию языка нельзя изменить из окна **Свойства** проекта. Версия привязана к целевой версии .NET framework вашего проекта и обновляется в соответствии с ней.

Если вам всё же нужно переопределить версию языка, делайте это так, как описано выше: правкой файла **.csproj** и указанием **LangVersion**.

Помните, что каждая версия языка C# имеет минимально поддерживаемую версию .NET. C# 12 поддерживается только в .NET 8 и более новых версиях. C# 11 поддерживается только в .NET 7 и более новых версиях. C# 10 поддерживается только в .NET 6 и более новых версиях. И так далее.

## Параметры LangVersion в C#

Помимо номеров версий, есть ряд ключевых слов, которыми можно задать версию языка проекта:

-   **preview** -- указывает на последнюю предварительную версию
-   **latest** -- последняя выпущенная версия (включая минорную)
-   **latestMajor** или **default** -- последняя выпущенная мажорная версия

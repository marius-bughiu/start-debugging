---
title: "Как перейти на C# 11"
description: "Исправьте ошибку 'Feature is not available in C# 10.0', перейдя на C# 11 через target framework или LangVersion в файле .csproj."
pubDate: 2023-03-14
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ru"
translationOf: "2023/03/how-to-switch-to-c-11"
translatedBy: "claude"
translationDate: 2026-05-01
---
> Feature is not available in C# 10.0. Please use language version 11.0 or later.

Подойти к этому можно двумя способами:

-   измените target framework вашего проекта на .NET 7 или новее. Версия языка должна обновиться автоматически.
-   отредактируйте файл **.csproj** и задайте нужный **<LangVersion>**, как в примере ниже:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net7.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
	<LangVersion>11.0</LangVersion>
  </PropertyGroup>
</Project>
```

## Версия языка неактивна и её нельзя изменить

[![](/wp-content/uploads/2023/03/image.png)](/wp-content/uploads/2023/03/image.png)

Версию языка нельзя изменить из окна **Свойства** проекта. Версия привязана к целевой версии .NET framework вашего проекта и обновляется в соответствии с ней.

Если вам всё же нужно переопределить версию языка, делайте это так, как описано выше: правкой файла **.csproj** и указанием **LangVersion**.

Помните, что каждая версия языка C# имеет минимально поддерживаемую версию .NET. C# 11 поддерживается только в .NET 7 и более новых версиях. C# 10 поддерживается только в .NET 6 и более новых версиях. C# 9 поддерживается только в .NET 5 и более новых версиях.

## Параметры LangVersion в C#

Помимо номеров версий, есть ряд ключевых слов, которыми можно задать версию языка проекта:

-   **preview** -- указывает на последнюю предварительную версию
-   **latest** -- последняя выпущенная версия (включая минорную)
-   **latestMajor** или **default** -- последняя выпущенная мажорная версия

---
title: "Как перейти на C# 13"
description: "Как исправить 'Feature is not available in C# 12.0' и перевести проект на C# 13, изменив target framework или задав LangVersion в файле .csproj."
pubDate: 2025-01-01
updatedDate: 2025-01-02
tags:
  - "csharp-13"
  - "csharp"
  - "dotnet"
  - "dotnet-9"
lang: "ru"
translationOf: "2025/01/how-to-switch-to-c-13"
translatedBy: "claude"
translationDate: 2026-05-01
---
Пробуя возможности C# 13, вы можете столкнуться с ошибками, похожими на эти:

> Feature is not available in C# 12.0. Please use language version 13.0 or later.

или

> Error CS8652: The feature ‘<feature name>’ is currently in Preview and _unsupported_. To use Preview features, use the ‘preview’ language version.

Эту ошибку можно исправить двумя способами:

-   измените target framework проекта на .NET 9 или выше. Версия языка должна обновиться автоматически.
-   отредактируйте файл **.csproj** и укажите нужный **<LangVersion>** как в примере ниже:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net9.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <LangVersion>preview</LangVersion>
  </PropertyGroup>
</Project>
```

## Версия языка неактивна и не может быть изменена

[![](/wp-content/uploads/2023/03/image.png)](/wp-content/uploads/2023/03/image.png)

Версию языка нельзя изменить из окна **Properties** проекта. Версия привязана к версии target .NET framework проекта и будет обновляться в соответствии с ней.

Если необходимо переопределить версию языка, это нужно сделать как указано выше, отредактировав файл **.csproj** и указав **LangVersion**.

Помните, что у каждой версии языка C# есть минимальная поддерживаемая версия .NET. C# 13 поддерживается только в .NET 9 и более новых версиях. C# 12 поддерживается только в .NET 8 и более новых версиях.

## Опции LangVersion для C#

Помимо номеров версий, для указания версии языка проекта можно использовать определённые ключевые слова:

-   **preview** – ссылается на последнюю предварительную версию
-   **latest** – последняя выпущенная версия (включая минорную)
-   **latestMajor** или **default** – последняя выпущенная мажорная версия

## Не то, что вы искали?

Возможно, вы ищете переход на другую версию C#, в этом случае:

-   [Как перейти на C# 12](/2023/06/how-to-switch-to-c-12/)
-   [Как перейти на C# 11](/2023/03/how-to-switch-to-c-11/)

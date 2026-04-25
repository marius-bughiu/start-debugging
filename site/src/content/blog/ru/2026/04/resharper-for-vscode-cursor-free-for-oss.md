---
title: "ReSharper приходит в VS Code и Cursor, бесплатно для некоммерческого использования"
description: "JetBrains выпустила ReSharper как расширение для VS Code с полным анализом C#, рефакторингом и юнит-тестированием. Работает также в Cursor и Google Antigravity, и ничего не стоит для OSS и обучения."
pubDate: 2026-04-12
tags:
  - "resharper"
  - "vs-code"
  - "csharp"
  - "tooling"
lang: "ru"
translationOf: "2026/04/resharper-for-vscode-cursor-free-for-oss"
translatedBy: "claude"
translationDate: 2026-04-25
---

Годами ReSharper означал одно: расширение для Visual Studio. Если вам нужен был анализ C# уровня JetBrains за пределами Visual Studio, ответом был Rider. Это изменилось 5 марта 2026 года, когда JetBrains [выпустила ReSharper для Visual Studio Code](https://blog.jetbrains.com/dotnet/2026/03/05/resharper-for-visual-studio-code-cursor-and-compatible-editors-is-out/), Cursor и Google Antigravity. [Релиз 2026.1](https://blog.jetbrains.com/dotnet/2026/03/30/resharper-2026-1-released/) от 30 марта последовал с мониторингом производительности и более тесной интеграцией.

## Что вы получаете

Расширение приносит основной опыт ReSharper в любой редактор, говорящий на API расширений VS Code:

- **Анализ кода** для C#, XAML, Razor и Blazor с той же базой инспекций, которую ReSharper использует в Visual Studio
- **Рефакторинг на уровне решения**: переименование, извлечение метода, перемещение типа, инлайн переменной и остальной каталог
- **Навигация**, включая переход к определению в декомпилированный исходный код
- **Solution Explorer**, который обрабатывает проекты, пакеты NuGet и генераторы исходного кода
- **Юнит-тесты** для NUnit, xUnit.net и MSTest с инлайн-элементами управления для запуска/отладки

После установки расширения и открытия папки ReSharper автоматически обнаруживает файлы `.sln`, `.slnx`, `.slnf` или автономные `.csproj`. Без ручной настройки.

## Лицензионный аспект

JetBrains сделала это бесплатным для некоммерческого использования. Это покрывает вклад в open source, обучение, создание контента и хобби-проекты. Коммерческим командам нужна лицензия ReSharper или dotUltimate, та же, что покрывает расширение Visual Studio.

## Быстрый тест-драйв

Установите с VS Code Marketplace, затем откройте любое решение C#:

```bash
code my-project/
```

ReSharper индексирует решение и сразу же начинает выводить инспекции. Попробуйте Command Palette (`Ctrl+Shift+P`) и введите "ReSharper", чтобы увидеть доступные действия, или щёлкните правой кнопкой по любому символу для меню рефакторинга.

Быстрый способ убедиться, что он работает:

```csharp
// ReSharper will flag this with "Use collection expression" in C# 12+
var items = new List<string> { "a", "b", "c" };
```

Если вы видите предложение преобразовать в `["a", "b", "c"]`, движок анализа работает.

## Для кого это

Пользователи Cursor, пишущие на C#, теперь получают первоклассный анализ, не покидая свой AI-нативный редактор. Пользователи VS Code, избегавшие Rider из-за стоимости или предпочтений, получают ту же глубину инспекции, которую ReSharper предлагал пользователям Visual Studio в течение двух десятилетий. А мейнтейнеры OSS получают всё бесплатно.

[Полный пост-анонс](https://blog.jetbrains.com/dotnet/2026/03/05/resharper-for-visual-studio-code-cursor-and-compatible-editors-is-out/) охватывает детали установки и известные ограничения.

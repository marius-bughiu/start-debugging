---
title: "TreatWarningsAsErrors без саботажа dev-сборок (.NET 10)"
description: "Как обеспечить TreatWarningsAsErrors в сборках Release и CI, оставив Debug гибким для локальной разработки на .NET 10, с помощью Directory.Build.props."
pubDate: 2026-01-23
tags:
  - "dotnet"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
Если вы хоть раз переключали `TreatWarningsAsErrors` в `true` и тут же об этом жалели, вы не одиноки. Недавняя ветка на r/dotnet, которая ходит по сети, предлагает простую правку: требовать кода без warning'ов в Release (и в CI), но оставить Debug гибким для локальных экспериментов: [https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/](https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/)

## Принудительное соблюдение только для Release это политика, а не переключатель

То, чего вы реально хотите добиться, это рабочий процесс:

-   Разработчики могут локально экспериментировать, не сражаясь с шумом анализатора.
-   Pull request'ы падают, если просочились новые warning'и.
-   У вас остаётся путь со временем поднимать планку строгости.

В репозиториях на .NET 10 самое аккуратное место централизовать это `Directory.Build.props`. Так правило применяется к каждому проекту, включая тестовые, без copy/paste.

Минимальный шаблон:

```xml
<!-- Directory.Build.props -->
<Project>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
</Project>
```

Это совпадает с тем, что большинство CI-пайплайнов и так собирают (Release). Если ваш CI собирает Debug, переключите его сначала на Release. Тогда ваша планка "без warning'ов" совпадёт с теми бинарями, которые вы выпускаете.

## Быть строгим не значит быть слепым

После активации большого переключателя важны две настройки:

-   `WarningsAsErrors`: эскалация только конкретных ID warning'ов.
-   `NoWarn`: подавление конкретных ID warning'ов (желательно с комментарием и ссылкой на тикет).

Пример: ужесточаем один warning, остальные оставляем как warning'и:

```xml
<Project>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
    <WarningsAsErrors>$(WarningsAsErrors);CS8602</WarningsAsErrors>
  </PropertyGroup>
</Project>
```

И если нужно временно подавить шумный анализатор в одном проекте:

```xml
<Project>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <NoWarn>$(NoWarn);CA2007</NoWarn>
  </PropertyGroup>
</Project>
```

Если вы используете Roslyn-анализаторы (что обычно для современных решений на .NET 10), обратите внимание и на `.editorconfig` для управления severity, потому что он легко обнаруживается и держит политику рядом с кодом:

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.CA2007.severity = warning
```

## Практическая отдача для PR

Реальный выигрыш это предсказуемый фидбек на PR. Разработчики быстро усваивают, что warning'и это не "работа на потом", а часть definition of done для Release. Debug остаётся быстрым и снисходительным, Release остаётся строгим и готовым к выпуску.

Если хотите оригинальный источник этого паттерна (и тот крошечный сниппет, с которого пошло обсуждение), смотрите ветку здесь: [https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/](https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/)

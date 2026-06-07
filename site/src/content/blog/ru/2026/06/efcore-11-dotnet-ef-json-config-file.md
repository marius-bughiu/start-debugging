---
title: "EF Core 11 Preview 4: Хватит заново вводить --project и --startup-project с .config/dotnet-ef.json"
description: "EF Core 11 Preview 4 позволяет инструменту dotnet ef читать значения опций по умолчанию из файла .config/dotnet-ef.json, так что многопроектные решения больше не вынуждают передавать --project и --startup-project в каждой команде."
pubDate: 2026-06-01
tags:
  - "ef-core"
  - "dotnet-11"
  - "dotnet-cli"
  - "csharp"
  - "dotnet"
lang: "ru"
translationOf: "2026/06/efcore-11-dotnet-ef-json-config-file"
translatedBy: "claude"
translationDate: 2026-06-01
---

Любому, кто запускает миграции EF Core в многослойном решении, знаком этот ритуал: `DbContext` находится в проекте инфраструктуры, строка подключения и настройка DI находятся в проекте API, и поэтому каждая команда `dotnet ef` превращается в абзац. `dotnet ef migrations add AddOrders --project src/App.Infrastructure --startup-project src/App.Api --context AppDbContext`. Вы либо заучиваете её, либо делаете для неё псевдоним, либо вставляете из файла с заметками. [EF Core 11 Preview 4](/ru/2026/05/ef-core-11-temporal-tables-clr-period-properties/), выпущенный 12 мая 2026 года в составе [.NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/), наконец позволяет записать эти значения по умолчанию один раз.

## Файл конфигурации, который инструмент находит, поднимаясь по дереву

Инструмент командной строки `dotnet ef` теперь читает значения опций по умолчанию из файла `.config/dotnet-ef.json`. Поиск работает так же, как для `.editorconfig` или `global.json`: инструмент поднимается по дереву каталогов от текущего рабочего каталога и использует первый найденный файл. Поместите один в корне решения, и каждая команда, запущенная из любого места внутри дерева, его наследует.

```json
{
  "project": "src/App.Infrastructure",
  "startupProject": "src/App.Api",
  "framework": "net11.0",
  "configuration": "Debug",
  "context": "AppDbContext",
  "runtime": "win-x64",
  "verbose": true,
  "noColor": false,
  "prefixOutput": false
}
```

С этим файлом на месте абзац снова сокращается до того, чем он всегда должен был быть:

```console
dotnet ef migrations add AddOrders
dotnet ef database update
```

Поддерживаемые ключи напрямую соответствуют знакомым флагам: `project`, `startupProject`, `framework`, `configuration`, `context`, `runtime`, `verbose`, `noColor` и `prefixOutput`. Об одном стоит позаботиться: значения путей `project` и `startupProject` разрешаются относительно родителя каталога `.config`, содержащего файл, а не относительно того места, где вы оказались при запуске команды. Поместите файл в корне репозитория в `.config/`, и пути читаются так, как если бы они были написаны от корня.

## Явные флаги по-прежнему побеждают

Это файл значений по умолчанию, а не файл блокировки. Любая опция, которую вы передаёте в командной строке, переопределяет значение из JSON, так что вы можете сохранить `AppDbContext` как значение по умолчанию и всё равно выполнить разовый запуск для второго контекста:

```console
dotnet ef migrations add AddAudit --context AuditDbContext
```

Именно этот приоритет и есть причина, по которой это безопасно фиксировать в репозитории. Добавьте `.config/dotnet-ef.json` в систему контроля версий, и каждый разработчик, а также CI получат одинаковые значения по умолчанию без редактирования кем-либо общего скрипта. Этот подход повторяет то, как `dotnet tool` уже использует `.config/dotnet-tools.json`, так что расположение будет знакомо всем, кто работает с манифестами локальных инструментов.

В этой же предварительной версии есть меньшее сопутствующее изменение, которое хорошо сочетается со скриптингом: инструмент EF теперь записывает все сообщения журнала и статуса в стандартный поток ошибок, оставляя стандартный вывод только для фактического результата команды. Так что `dotnet ef migrations script > schema.sql` даёт чистый SQL без подмешанного шума баннера.

Это выходит вместе с работой над эргономикой темпоральных таблиц, описанной в [EF Core 11 Preview 4: столбцы периода темпоральных таблиц наконец могут быть настоящими свойствами](/2026/05/ef-core-11-temporal-tables-clr-period-properties/). Полный обзор смотрите в [разделе «Файл конфигурации» документации dotnet ef](https://learn.microsoft.com/en-us/ef/core/cli/dotnet#configuration-file) и на [странице новинок EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew).

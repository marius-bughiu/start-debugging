---
title: "dotnet sln наконец редактирует solution filters из CLI в .NET 11 Preview 3"
description: ".NET 11 Preview 3 учит dotnet sln создавать, добавлять, удалять и перечислять проекты в solution filters .slnf, так что крупные моно-репозитории могут грузить подмножество без открытия Visual Studio."
pubDate: 2026-04-18
tags:
  - ".NET 11"
  - "SDK"
  - "dotnet CLI"
  - "MSBuild"
lang: "ru"
translationOf: "2026/04/dotnet-11-sln-cli-solution-filters"
translatedBy: "claude"
translationDate: 2026-04-24
---

Solution filters (`.slnf`) существуют со времён Visual Studio 2019, но редактирование их вне IDE означало писать JSON руками. [.NET 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/sdk.md) это чинит: `dotnet sln` теперь создаёт, редактирует и перечисляет содержимое `.slnf` файлов напрямую через [dotnet/sdk #51156](https://github.com/dotnet/sdk/pull/51156). Для крупных репозиториев это разница между открытием подмножества из двадцати проектов из терминала и поддержанием shell-скрипта, ковыряющего JSON вручную.

## Что такое solution filter на самом деле

`.slnf` - это JSON-указатель на родительский `.sln` плюс список путей к проектам. Когда инструмент загружает фильтр, он выгружает каждый проект родительского solution, которого нет в списке. Это держит граф сборки, анализаторы и IntelliSense сфокусированными на нужном подмножестве - главный рычаг, который большие базы кода имеют, чтобы держать время загрузки IDE в разумных рамках. До Preview 3 CLI могла спокойно `build` фильтр, но не редактировать его.

## Новые команды

Поверхность зеркалит существующие глаголы `dotnet sln`. Можно создать фильтр, добавить и удалить проекты, и посмотреть, что сейчас включено:

```bash
# Create a filter that points at the current .sln
dotnet new slnf --name MyApp.slnf

# Target a specific parent solution
dotnet new slnf --name MyApp.slnf --solution-file ./MyApp.sln

# Add and remove projects
dotnet sln MyApp.slnf add src/Lib/Lib.csproj
dotnet sln MyApp.slnf add src/Api/Api.csproj src/Web/Web.csproj
dotnet sln MyApp.slnf remove src/Lib/Lib.csproj

# Inspect what the filter currently loads
dotnet sln MyApp.slnf list
```

Команды принимают те же формы glob и мульти-аргументов, которые `dotnet sln` уже поддерживает для `.sln` файлов, и пишут `.slnf` JSON в том же формате, что эмитит Visual Studio, так что фильтр, отредактированный из CLI, открывается чисто в IDE.

## Почему это важно для моно-репозиториев

Два рабочих процесса становятся значительно дешевле. Первый - CI: пайплайн может чекаутить весь репозиторий, но собирать только фильтр, релевантный изменённым путям. До Preview 3 большинство команд делало это самописным скриптом, пишущим JSON, или держало вручную поддерживаемые `.slnf` файлы рядом с `.sln`. Теперь тот же пайплайн может регенерировать фильтры на лету:

```bash
dotnet new slnf --name ci-api.slnf --solution-file MonoRepo.sln
dotnet sln ci-api.slnf add \
  src/Api/**/*.csproj \
  src/Shared/**/*.csproj \
  test/Api/**/*.csproj

dotnet build ci-api.slnf -c Release
```

Второй - локальная разработка. Крупные репозитории часто поставляют горсть «стартовых» фильтров, чтобы новый инженер мог открыть бэкенд, не дожидаясь, пока загрузятся мобильные и docs-проекты. Поддержание этих фильтров в актуальном виде раньше требовало открывать каждый в Visual Studio после перемещения проекта, потому что переименования `.sln` не обновляли `.slnf` автоматически. С новыми командами обновление - однострочник:

```bash
dotnet sln backend.slnf remove src/Legacy/OldService.csproj
dotnet sln backend.slnf add src/Services/NewService.csproj
```

## Короткая заметка о путях

`dotnet sln` разрешает пути проектов относительно фильтра, а не вызывающего, что совпадает с тем, как их читает IDE. Если `.slnf` лежит в `build/filters/` и указывает на проекты под `src/`, хранимый путь будет `..\..\src\Foo\Foo.csproj`, и `dotnet sln list` показывает его так же. Это стоит помнить, когда скриптуете редактирование фильтров из другого рабочего каталога.

В сочетании с [`dotnet run -e` для inline-переменных окружения](https://github.com/dotnet/sdk/pull/52664) и ранее появившимися [одношаговыми миграциями EF Core](https://startdebugging.net/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/), Preview 3 продолжает отгрызать кусочки от набора «мне надо открыть Visual Studio, чтобы это сделать». Полный список - в [заметках по SDK .NET 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/sdk.md).

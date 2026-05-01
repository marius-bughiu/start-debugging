---
title: "VSTest отказывается от Newtonsoft.Json в .NET 11 Preview 4 и что сломается, если вы полагались на него транзитивно"
description: ".NET 11 Preview 4 и Visual Studio 18.8 поставляют VSTest, который больше не протаскивает Newtonsoft.Json в ваши тестовые проекты. Сборки, тихо использовавшие транзитивную копию, сломаются, и чинятся одной строкой PackageReference."
pubDate: 2026-05-01
tags:
  - "dotnet-11"
  - "vstest"
  - "newtonsoft-json"
  - "system-text-json"
  - "testing"
lang: "ru"
translationOf: "2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4"
translatedBy: "claude"
translationDate: 2026-05-01
---

Команда .NET [объявила 29 апреля](https://devblogs.microsoft.com/dotnet/vs-test-is-removing-its-newtonsoft-json-dependency/), что VSTest, движок за `dotnet test` и Test Explorer в Visual Studio, наконец обрывает свою зависимость от `Newtonsoft.Json`. Изменение приходит в .NET 11 Preview 4 (запланирован на 12 мая 2026) и Visual Studio 18.8 Insiders 1 (запланирован на 9 июня 2026). На .NET VSTest переключает свой внутренний сериализатор на `System.Text.Json`. На .NET Framework, где `System.Text.Json` слишком тяжёлая нагрузка, используется маленькая библиотека под названием JSONite. Работа отслеживается в [microsoft/vstest#15540](https://github.com/microsoft/vstest/pull/15540), а ломающее изменение SDK в [dotnet/docs#53174](https://github.com/dotnet/docs/issues/53174).

## Большинству проектов делать ничего не нужно

Если ваш тестовый проект уже объявляет `Newtonsoft.Json` обычным `PackageReference`, ничего не меняется. Пакет продолжает работать, и любой код, использующий `JObject`, `JToken` или статический `JsonConvert`, продолжает компилироваться. Единственный публичный тип, который VSTest выставлял наружу, `Newtonsoft.Json.Linq.JToken`, жил в одной точке протокола обмена VSTest, и собственная оценка команды такова, что по сути ни один реальный потребитель от этой поверхности не зависит.

## Где на самом деле ломается

Интересный сценарий поломки это проект, который никогда не просил `Newtonsoft.Json` и всё равно его получал, потому что VSTest тащил за собой эту сборку. Как только Preview 4 обрывает транзитивный поток, эта копия исчезает во время выполнения, и вы увидите `FileNotFoundException` для `Newtonsoft.Json` во время прогона тестов. Чинится это одной строкой в `.csproj`:

```xml
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
</ItemGroup>
```

Второй вариант это проекты, явно исключившие runtime asset транзитивного `Newtonsoft.Json`, как правило, чтобы держать пакеты развёртывания компактными:

```xml
<PackageReference Include="Newtonsoft.Json" Version="13.0.3">
  <ExcludeAssets>runtime</ExcludeAssets>
</PackageReference>
```

Раньше это работало, потому что сам VSTest поставлял runtime DLL. После Preview 4 перестанет работать по той же причине: бинарник больше никто с собой не приносит. Уберите элемент `ExcludeAssets` или перенесите пакет в проект, который действительно поставляет свой runtime.

## Зачем это нужно

Тащить `Newtonsoft.Json` внутри платформы тестирования это старая бородавка совместимости. Она прибивала мажорную 13.x к каждой сессии тестов, периодически выливалась в драмы с binding redirect на .NET Framework и заставляла команды, намеренно изгнавшие `Newtonsoft.Json` из своего приложения, всё равно терпеть его под тестами. Переход на `System.Text.Json` на .NET уменьшает отпечаток test host и выравнивает выполнение тестов с остальным современным SDK ([связано: System.Text.Json в .NET 11 Preview 3](/ru/2026/04/system-text-json-11-pascalcase-per-member-naming/)). Для .NET Framework JSONite сохраняет тот же протокол на крошечном выделенном парсере вместо общей библиотеки, которая в прошлом кусала команды.

Если хотите узнать заранее, попадаете ли вы в группу со сломанной сборкой, направьте свой CI на предварительный пакет [Microsoft.TestPlatform 1.0.0-alpha-stj-26213-07](https://www.nuget.org/packages/Microsoft.TestPlatform/1.0.0-alpha-stj-26213-07) и прогоните существующий набор тестов. Зелёная сборка сейчас означает зелёную сборку 12 мая.

---
title: "Миграция тестового проекта с xUnit v2 на xUnit v3 (с 2.9.3 на 4.0.0)"
description: "Пошаговая миграция с xunit 2.9.3 на xunit.v3 4.0.0: замена пакетов, перевод OutputType в Exe, IAsyncLifetime с возвратом ValueTask, удаление Xunit.Abstractions и синтаксис фильтров в CI, который молча перестаёт совпадать."
pubDate: 2026-09-01
template: migration
tags:
  - "migration"
  - "xunit"
  - "xunit-v3"
  - "testing"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
lang: "ru"
translationOf: "2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3"
translatedBy: "claude"
translationDate: 2026-09-01
---

Миграция обычного тестового проекта с `xunit` 2.9.3 на `xunit.v3` 4.0.0 занимает около часа механической работы: заменить четыре ссылки на пакеты, перевести `OutputType` в `Exe`, удалить каждый `using Xunit.Abstractions;` и сменить `IAsyncLifetime` с `Task` на `ValueTask`. День съедает всё, что находится вокруг тестового проекта: сторонний пакет без сборки под v3 сломает компиляцию ошибкой о дублирующемся `FactAttribute`, а выражение `dotnet test --filter` в CI перестанет совпадать с чем-либо, при этом сборка не упадёт. Миграцию стоит делать (v3 остаётся единственной линией, получающей новые возможности с момента выхода 2.9.3 в январе 2025 года), и она обратима вплоть до момента, когда вы удалите старую ветку. Всё изложенное ниже проверено на `xunit.v3` 4.0.0, выпущенном 2026-08-15, на SDK .NET 10 и .NET 11.

## Почему это не просто смена версии

- **v2 заморожена по функциональности.** 2.9.3 (2025-01-08) -- последний выпуск v2. `TestContext`, тайм-ауты с настоящей отменой, фикстуры уровня сборки, динамический пропуск тестов и язык запросов для фильтров существуют только в v3.
- **Тестовые проекты становятся исполняемыми файлами.** Проект на v3 имеет сгенерированную точку входа и запускает себя сам. Это полностью убирает класс ошибок из-за несовпадения версий runner и фреймворка, и именно это делает возможной сборку тестов с Native AOT в 4.0.0.
- **`TestContext.Current.CancellationToken` делает тайм-ауты реальными.** В v2 `[Fact(Timeout = ...)]` на несинхронном тесте ничего не мог прервать. В v3 токен доходит до вашего кода, поэтому зависший HTTP-вызов действительно отменяется.
- **Microsoft.Testing.Platform подключается по желанию, но нативно.** Метапакет `xunit.v3` 4.0.0 разрешается в `xunit.v3.mtp-v2`, который приносит MTP v2. Вы получаете `--report-trx`, вывод CTRF и намного более быстрый старт без хост-процесса VSTest.

## Что ломается

| Область | Изменение | Серьёзность |
| ------- | --------- | ----------- |
| `xunit.abstractions` | Пакет и пространство имён исчезли. `ITestOutputHelper` переехал в `Xunit` | высокая |
| Форма проекта | `OutputType` должен быть `Exe`; только проекты в формате SDK | высокая |
| Целевая платформа | Минимум -- `net472` или `net8.0`. От `netcoreapp3.1` до `net7.0` исключены | высокая |
| `IAsyncLifetime` | Наследует `IAsyncDisposable`; оба метода возвращают `ValueTask`, а не `Task` | высокая |
| Тесты `async void` | Немедленно падают во время выполнения вместо запуска | высокая |
| Сторонние пакеты | Любой пакет, ссылающийся на `xunit.core` 2.x, конфликтует с `xunit.v3.core` | высокая |
| Фильтры в CI | Выражения `--filter` из VSTest не поддерживаются под MTP | высокая |
| `MemberDataAttribute` | `Parameters` переименован в `Arguments`; `ConvertDataItem` теперь `ConvertDataRow` | средняя |
| Атрибуты сортировки и фреймворка | `CollectionBehavior`, `TestCaseOrderer` и `TestFramework` принимают `Type`, а не строки | средняя |
| `AssemblyTraitAttribute` | Удалён. Используйте `[assembly: Trait(...)]` | низкая |
| `PropertyDataAttribute` | Удалён (устарел ещё с v1) | низкая |
| Освобождение ресурсов | Когда фикстура реализует и `IDisposable`, и `IAsyncDisposable`, вызывается только `DisposeAsync` | средняя |

Две строки, под которые нужно планировать, -- про сторонние пакеты и про CI. Обо всём остальном скажет компилятор.

## Предварительная проверка

- **Установлен SDK .NET 8 или новее.** `xunit.v3` 4.0.0 нацелен на `net472` и `net8.0`; поверхности `netstandard2.0` у основного пакета нет.
- **Все тестовые проекты в формате SDK.** Файлы `.csproj` старого формата не поддерживаются вовсе. Сначала конвертируйте их, отдельным коммитом.
- **Составьте список пакетов, связанных с xUnit.** Выполните `dotnet list package --include-transitive | grep -i xunit` в каждом тестовом проекте и запишите результат. Именно этот список решает, займёт миграция час или неделю.
- **Знайте, какой runner использует ваш CI.** Поищите в конвейере `dotnet test`, `--filter`, `--logger` и `vstest.console.exe`.
- **Создайте ветку.** Сначала проведите через CI один тестовый проект целиком, и только потом трогайте остальные.

## Шаги миграции

1. **Смените целевую платформу тестового проекта и сделайте его исполняемым.**

   Поднимите `TargetFramework` до `net8.0` или новее и задайте `OutputType`. Сгенерированная точка входа приходит из пакета; писать `Main` не нужно.

   ```xml
   <!-- MyApp.Tests.csproj, .NET 10 SDK, xunit.v3 4.0.0 -->
   <PropertyGroup>
     <TargetFramework>net10.0</TargetFramework>
     <OutputType>Exe</OutputType>
     <Nullable>enable</Nullable>
     <ImplicitUsings>enable</ImplicitUsings>
   </PropertyGroup>
   ```

   Проверка: `dotnet build` падает на отсутствующих типах xUnit, а не на ошибках формы проекта. Если в тестовом проекте уже есть инструкции верхнего уровня, задайте `<XunitAutoGeneratedEntryPoint>false</XunitAutoGeneratedEntryPoint>` и возьмите точку входа на себя.

2. **Замените ссылки на пакеты.**

   Соответствие v2 и v3 один к одному, кроме того что `xunit.abstractions` исчезает, а у `xunit.console` преемника нет.

   ```xml
   <!-- before: xunit 2.9.3 -->
   <ItemGroup>
     <PackageReference Include="xunit" Version="2.9.3" />
     <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
     <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />
   </ItemGroup>

   <!-- after: xunit.v3 4.0.0 -->
   <ItemGroup>
     <PackageReference Include="xunit.v3" Version="4.0.0" />
     <PackageReference Include="xunit.runner.visualstudio" Version="4.0.0" />
     <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />
   </ItemGroup>
   ```

   `xunit.v3` 4.0.0 разрешается в `xunit.v3.mtp-v2`, который приносит `xunit.v3.core.mtp-v2`, `xunit.v3.assert` и `xunit.analyzers` 2.0.0. Пока оставьте `xunit.runner.visualstudio` 4.0.0 и `Microsoft.NET.Test.Sdk`: пакет runner работает с v1, v2 и v3, поэтому Test Explorer и VSTest продолжат работать, пока вы мигрируете остаток решения. Если у вас Central Package Management, делайте это в `Directory.Packages.props` -- ровно в этом и состоит смысл [перевода решения на Directory.Packages.props](/ru/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/).

   Проверка: `dotnet restore` проходит без предупреждений NU1605 о понижении версии и без ошибок дублирующихся типов.

3. **Удалите каждый `using Xunit.Abstractions;`.**

   `ITestOutputHelper` теперь живёт в `Xunit`, рядом с `Fact` и `Assert`, поэтому в большинстве файлов исправление сводится к удалению одной строки.

   ```csharp
   // xunit.v3 4.0.0 - no Xunit.Abstractions anywhere
   using Xunit;

   public class OrderServiceTests(ITestOutputHelper output)
   {
       [Fact]
       public void Prices_include_tax()
       {
           output.WriteLine("running");   // v3 also adds Write(), not just WriteLine()
           Assert.Equal(120m, new OrderService().Total(100m));
       }
   }
   ```

   Проверка: `grep -rn "Xunit.Abstractions" .` ничего не возвращает внутри ваших тестовых проектов.

4. **Переведите реализации `IAsyncLifetime` на `ValueTask`.**

   Именно здесь чаще всего ошибаются, потому что ошибка компилятора указывает на тип возвращаемого значения и прячет за собой семантику освобождения ресурсов. `IAsyncLifetime` теперь наследует `IAsyncDisposable`, и оба члена возвращают `ValueTask`.

   ```csharp
   // v2: xunit 2.9.3
   public class DbFixture : IAsyncLifetime
   {
       public Task InitializeAsync() => _container.StartAsync();
       public Task DisposeAsync()    => _container.DisposeAsync().AsTask();
   }

   // v3: xunit.v3 4.0.0
   public class DbFixture : IAsyncLifetime
   {
       public ValueTask InitializeAsync() => new(_container.StartAsync());
       public ValueTask DisposeAsync()    => _container.DisposeAsync();
   }
   ```

   Ловушка: если ваша фикстура реализует и `IDisposable`, **и** `IAsyncLifetime`, то v2 вызывала `Dispose()`, а v3 не вызывает. Она вызывает только `DisposeAsync()`, следуя рекомендации .NET вызывать одно или другое. Любая очистка, жившая исключительно в `Dispose()`, молча перестаёт выполняться, и обычно это проявляется как утёкший контейнер Testcontainers или неудалённый временный каталог, а не как упавший тест. Перенесите эту очистку в `DisposeAsync()`. Особенно это важно для схемы "контейнер на фикстуру" из [интеграционных тестов против настоящего SQL Server с Testcontainers](/ru/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).

   Проверка: запустите набор тестов и убедитесь командой `docker ps -a`, что осиротевших контейнеров не осталось.

5. **Исправьте тесты `async void` и механические переименования атрибутов.**

   v3 немедленно роняет тесты `async void` во время выполнения вместо запуска "выстрелил и забыл", поэтому смените сигнатуру на `async Task`. Это те же рассуждения, что изложены в [async void против async Task в C#](/ru/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/), только теперь их обеспечивает сам фреймворк. Затем примените переход атрибутов со строк на `Type`:

   ```csharp
   // v2
   [assembly: CollectionBehavior("MyTests.MyCollectionFactory", "MyTests")]
   [assembly: AssemblyTrait("Category", "Integration")]

   // v3, xunit.v3 4.0.0
   [assembly: CollectionBehavior(typeof(MyCollectionFactory))]
   [assembly: Trait("Category", "Integration")]
   ```

   `TestCaseOrdererAttribute`, `TestCollectionOrdererAttribute` и `TestFrameworkAttribute` обрабатываются так же. `MemberDataAttribute.Parameters` теперь называется `Arguments`, а если вы наследовались от `MemberDataAttributeBase`, то `ConvertDataItem` стал `ConvertDataRow` и возвращает `ITheoryDataRow` вместо `object[]`.

   Проверка: `dotnet build` чист, за исключением предупреждений `xUnit1051`, которым посвящён следующий шаг.

6. **Пропустите `TestContext.Current.CancellationToken` через ваши `await`.**

   `xunit.analyzers` 2.0.0 выдаёт `xUnit1051` на каждый вызов, который принимает `CancellationToken` и не получает его. Это предупреждение, а не ошибка, и мигрировать можно, не трогая его, но токен -- это большая часть смысла перехода на v3.

   ```csharp
   // xunit.v3 4.0.0 - the token cancels when the test times out or the run is aborted
   [Fact(Timeout = 5000)]
   public async Task Fetches_the_order()
   {
       var ct = TestContext.Current.CancellationToken;
       var response = await _client.GetAsync("/orders/1", ct);
       Assert.Equal(HttpStatusCode.OK, response.StatusCode);
   }
   ```

   Проверка: `dotnet build -warnaserror:xUnit1051` проходит после того, как вы закончите, либо оставьте это предупреждением и вернитесь позже.

7. **Переведите CI на новый синтаксис фильтров.**

   Затем решите, включать ли Microsoft.Testing.Platform. Под MTP xUnit не принимает язык выражений `--filter` из VSTest; он предоставляет `--filter-class`, `--filter-method`, `--filter-namespace`, `--filter-trait`, их варианты `--filter-not-*` и `--filter-query`. На SDK .NET 8 и 9 включение делается для каждого проекта:

   ```xml
   <!-- .NET 8/9 SDK -->
   <PropertyGroup>
     <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
   </PropertyGroup>
   ```

   На SDK .NET 10 и новее включение делается один раз для всего репозитория:

   ```json
   // global.json
   {
     "test": { "runner": "Microsoft.Testing.Platform" }
   }
   ```

   И сам фильтр меняет форму:

   ```bash
   # before, VSTest
   dotnet test --filter "Category!=Integration"

   # after, MTP with xunit.v3 4.0.0
   dotnet test -- --filter-not-trait "Category=Integration"
   ```

   Проверка: выполните команду с фильтром и убедитесь, что количество отчитанных тестов меньше, чем без фильтра. Зелёной сборке здесь верить нельзя: фильтр, не совпавший ни с чем, завершается с нулевым кодом.

## Проверка миграции

Выполните это по порядку и считайте любой сюрприз в количестве тестов провалом, даже если код возврата равен нулю.

- `dotnet build -c Release` без предупреждений, кроме тех, что вы уже разобрали.
- `dotnet run --project MyApp.Tests -- --list`, чтобы убедиться, что обнаружение находит ожидаемое количество тестов.
- `dotnet test` и сравнение итога с последним прогоном на v2. Падение почти всегда означает фильтр или пропущенный тест `async void`.
- Откройте Test Explorer один раз. Если тесты идут из командной строки, а Visual Studio зависает, это [зависание Test Explorer на проектах xUnit v3](/ru/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/), а не плохая миграция.
- Проверьте цифры покрытия. Coverlet подключается под MTP иначе, и отчёт о покрытии, внезапно показывающий 0 %, -- это проблема настройки, а не регрессия.

## Откат

Эта миграция полностью обратима: это ссылки на пакеты плюс правки исходного кода, без состояния на диске и без схемы базы данных. `git revert` коммита возвращает работоспособность набора тестов на v2 при условии, что в том же коммите вы не понизили целевую платформу ниже `net8.0`. Именно поэтому смену платформы держите отдельно. Необратима только та часть, где вам пришлось опубликовать собственный форк стороннего пакета (см. ниже), и он остаётся полезным в любом случае.

## Детали, которые полезно знать заранее

**Ошибка о дублирующемся `FactAttribute`.** Если какой-то пакет в графе всё ещё ссылается на `xunit.core` 2.x, вы получите:

```
error CS0433: The type 'FactAttribute' exists in both
'xunit.core, Version=2.4.2.0, Culture=neutral, PublicKeyToken=8d05b1bb7a6fdb6c' and
'xunit.v3.core, Version=4.0.0.0, Culture=neutral, PublicKeyToken=8d05b1bb7a6fdb6c'
```

Никакой трюк с псевдонимами тут не стоит попыток. Либо у пакета есть сборка под v3, либо нет. По состоянию на сентябрь 2026 года: `Verify.XunitV3` 32.0.0, `AutoFixture.Xunit3` 4.19.0, `Xunit.DependencyInjection` 12.0.1 и `MartinCostello.Logging.XUnit.v3` 0.7.1 ссылаются на `xunit.v3.*` 4.x. `Serilog.Sinks.XUnit` 3.0.19 по-прежнему тянет `xunit.abstractions` 2.0.3 и `xunit.extensibility.core` 2.9.2, поэтому это жёсткий блокер; обычный обходной путь -- небольшой собственный sink в репозитории, пишущий напрямую в `ITestOutputHelper`, примерно тридцать строк.

**`Xunit.SkippableFact` теперь лишний.** Удалите его. В v3 есть `Assert.Skip(reason)`, `Assert.SkipWhen(condition, reason)` и `Assert.SkipUnless(condition, reason)`, а также свойства `SkipWhen` и `SkipUnless` на `[Fact]` и `[Theory]`, указывающие на публичное статическое свойство типа `bool` в классе теста. Задать `SkipWhen` и `SkipUnless` одновременно на одном атрибуте -- это сбой во время выполнения, а не ошибка компиляции.

**В v3 экземпляры атрибутов кешируются.** v2 создавала новый экземпляр на каждый запрос; v3 кеширует, что соответствует обычному поведению рефлексии в .NET. Пользовательские атрибуты, менявшие собственное состояние между обнаружением и выполнением, будут вести себя иначе.

**Фиксация версий по всему решению.** `xunit.v3` 4.0.0 закрепляет `xunit.v3.mtp-v2` в точном диапазоне `[4.0.0, 4.0.0]`, поэтому смешанные версии в разных проектах всплывают как конфликты восстановления, а не как странности во время выполнения. Это плюс, но означает, что все тестовые проекты вы обновляете одним коммитом либо не обновляете вовсе.

**Пользовательские реализации `ITestCaseOrderer` изменились в 4.0.0**, а не только между v2 и v3. Сортировка теперь идёт по коллекции, затем классу, затем методу, затем случаю, и появились отдельные точки расширения для классов и методов. Если вы протащили orderer из v2 без изменений через v3.2.2, то на 4.0.0 он перестанет компилироваться.

**`WebApplicationFactory<T>` менять не нужно.** Интеграционные тесты ASP.NET Core мигрируют без трения; схема с фикстурой из [интеграционных тестов с WebApplicationFactory](/ru/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) работает как есть, как только `IAsyncLifetime` начинает возвращать `ValueTask`.

## Похожие статьи

- [xUnit v3 против NUnit и MSTest в 2026 году: что выбрать?](/ru/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/)
- [Fix: Test Explorer в Visual Studio зависает на проекте xUnit v3, тогда как dotnet test проходит](/ru/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/)
- [Microsoft.Testing.Platform 2.3 выводит падения тестов прямо в diff пул-реквеста](/ru/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/)
- [Как писать интеграционные тесты с WebApplicationFactory в ASP.NET Core 11](/ru/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)
- [Перевод решения .NET на Central Package Management с Directory.Packages.props](/ru/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)

## Источники

- [Migrating Unit Tests from v2 to v3](https://xunit.net/docs/getting-started/v3/migration) -- xUnit.net
- [What's New in v3?](https://xunit.net/docs/getting-started/v3/whats-new) -- xUnit.net
- [Microsoft Testing Platform (xUnit.net v3)](https://xunit.net/docs/getting-started/v3/microsoft-testing-platform) -- xUnit.net
- [Заметки о выпуске xUnit.net v3 4.0.0](https://xunit.net/releases/v3/4.0.0) -- xUnit.net
- [Руководство по миграции с VSTest на Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/migrating-vstest-microsoft-testing-platform) -- Microsoft Learn
- [xunit.v3 на NuGet](https://www.nuget.org/packages/xunit.v3/4.0.0) -- метаданные пакета и диапазоны зависимостей
- [Migrating from XUnit v2 to v3: troubleshooting](https://bartwullems.blogspot.com/2025/09/migrating-from-xunit-v2-to.html) -- Bart Wullems

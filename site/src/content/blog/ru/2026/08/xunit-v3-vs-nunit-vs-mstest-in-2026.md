---
title: "xUnit v3 vs NUnit vs MSTest в 2026 году: что выбрать?"
description: "Выбирайте xUnit v3 для новых проектов на .NET, NUnit 4.6, если вы живёте в его модели ограничений, и MSTest 4, если он у вас уже в проде. Измеренное сравнение на .NET SDK 10.0.201: значения параллелизма по умолчанию, жизненный цикл тестового класса, вывод при провале утверждений и конфликт версий Microsoft.Testing.Platform, ломающий runner NUnit."
pubDate: 2026-08-07
template: vs
tags:
  - "comparison"
  - "testing"
  - "xunit"
  - "nunit"
  - "mstest"
  - "dotnet"
lang: "ru"
translationOf: "2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026"
translatedBy: "claude"
translationDate: 2026-08-07
---

Для нового проекта на .NET в 2026 году выбирайте **xUnit v3**. Он распараллеливает тесты по умолчанию, его сообщения о провалах самые точные из трёх, и именно им пользуется команда .NET. Выбирайте **NUnit 4.6**, если ваш набор тестов опирается на модель ограничений или на `[Retry]`. Выбирайте **MSTest 4**, если MSTest у вас уже есть и не доставляет боли, потому что v4 закрыл почти весь разрыв.

Все цифры ниже измерены на .NET SDK 10.0.201 (среда выполнения 10.0.5) против xunit.v3 3.2.2, NUnit 4.6.1 с NUnit3TestAdapter 5.1.0 и MSTest 4.3.3. Каждое утверждение о поведении в этой статье проверено запуском кода, а не чтением changelog, потому что многое из общепринятых представлений об этих трёх фреймворках уже устарело.

## Матрица возможностей

| Поведение (проверенные версии) | xUnit v3 3.2.2 | NUnit 4.6.1 | MSTest 4.3.3 |
| --- | --- | --- | --- |
| Параллельно по умолчанию | Да, между коллекциями | Нет, нужно включить | Нет, нужно включить |
| Новый экземпляр класса на каждый тест | Да | Нет, один на fixture | Да |
| Атрибут теста | `[Fact]` / `[Theory]` | `[Test]` / `[TestCase]` | `[TestMethod]` / `[DataRow]` |
| Нужен атрибут-маркер класса | Нет | Нет | Да, `[TestClass]` |
| Стиль утверждений | `Assert.Equal` | Ограничения, `Assert.That(x, Is...)` | `Assert.AreEqual`, `Assert.That` |
| Выводит выражение, которое упало | Нет | Да | Да |
| `Assert.Multiple` | Да | Да | Нет |
| Встроенный атрибут повтора | Нет | Да, `[Retry(n)]` | Да, `[Retry(n)]` |
| Тип проекта | Exe, всегда | Exe при использовании runner NUnit | Exe при использовании runner MSTest |
| Microsoft.Testing.Platform | Нативно, встроено | Через адаптер 5.0+ | Нативно с 3.2 |
| Минимальный таргет | .NET 8 / .NET Framework 4.7.2 | .NET 6 / .NET Framework 4.6.2 | .NET 8 / .NET Framework 4.6.2 |

Две строки этой таблицы противоречат тому, что пишет большинство сравнений. Обе заслуживают отдельного раздела.

## Утверждение о жизненном цикле экземпляра, которое всюду неверно

Самая часто повторяемая фраза в этом сравнении: xUnit создаёт свежий экземпляр тестового класса на каждый тест, а NUnit и MSTest переиспользуют один экземпляр. Половина этого неверна. MSTest всегда конструировал новый экземпляр на каждый тестовый метод.

Вот проба, идентичная во всех трёх проектах, кроме атрибутов:

```csharp
// MSTest 4.3.3, .NET 10.0.201
[TestClass]
public class LifecycleTests
{
    private static int _instances;
    private readonly int _id;
    public LifecycleTests() { _id = Interlocked.Increment(ref _instances); }

    private void Record(string n) =>
        File.AppendAllText(Log, $"{n} ctorId={_id} totalInstances={_instances}");

    [TestMethod] public void A() => Record("A");
    [TestMethod] public void B() => Record("B");
    [TestMethod] public void C() => Record("C");
}
```

Результат запуска каждого из трёх:

```text
# xunit.v3 3.2.2
A ctorId=3 totalInstances=3
B ctorId=1 totalInstances=1
C ctorId=2 totalInstances=2

# MSTest 4.3.3
A ctorId=1 totalInstances=1
B ctorId=2 totalInstances=2
C ctorId=3 totalInstances=3

# NUnit 4.6.1
A ctorId=1 totalInstances=1
B ctorId=1 totalInstances=1
C ctorId=1 totalInstances=1
```

xUnit и MSTest сконструировали по три экземпляра. NUnit сконструировал один и разделил его между тестами. NUnit здесь выбивается из ряда, и это единственный из трёх, где изменяемое поле экземпляра переносит состояние из одного теста в следующий.

Это важнее, чем кажется. Один экземпляр на fixture создаёт ровно ту среду, в которой тихо разрастается набор тестов, зависящий от `[Order]`, и она плохо сочетается с параллелизмом: поля экземпляра становятся разделяемым изменяемым состоянием, как только два теста одной fixture пойдут одновременно. Документация самого NUnit говорит об этом же и даёт выход, вернувшийся в NUnit 3.13:

```csharp
// NUnit 4.6.1
[FixtureLifeCycle(LifeCycle.InstancePerTestCase)]
public class LifecycleTests { /* ... */ }
```

С этим атрибутом та же проба печатает `ctorId=1`, `2`, `3`. Если вы на NUnit и собираетесь включать параллелизм, примените его на уровне сборки заранее. Учтите, что `OneTimeSetUp` и `OneTimeTearDown` при этом должны стать `static`, поскольку теперь они выполняются один раз для fixture, у которой нет единственного экземпляра.

## Бенчмарк параллелизма

Это единственная реальная разница в производительности, и вся она сводится к значениям по умолчанию.

**Постановка**: четыре тестовых класса по пять тестов, в каждом тесте `Thread.Sleep(200)`. Двадцать тестов, то есть строго последовательный прогон имеет нижнюю границу 4.0 секунды, а идеально параллельный по классам укладывается в 1.0 секунды. Сборка Release, запуск напрямую как тестового исполняемого файла через Microsoft.Testing.Platform, время по настенным часам за три прогона после прогрева, Intel Core Ultra 7 265KF (20 ядер, 20 логических), Windows 11, .NET SDK 10.0.201.

| Фреймворк | Конфигурация по умолчанию | С параллелизмом на уровне классов |
| --- | --- | --- |
| xunit.v3 3.2.2 | 1.29 - 1.32 с | 1.29 - 1.32 с (уже по умолчанию) |
| NUnit 4.6.1 | 4.71 - 4.73 с | 1.53 - 1.64 с |
| MSTest 4.3.3 | 4.80 - 4.89 с | 1.66 - 1.69 с |

Из коробки xUnit на этом наборе в 3.6 раза быстрее NUnit и в 3.7 раза быстрее MSTest. Именно эту цифру и цитируют. Она же и вводит в заблуждение, потому что измеряет значение по умолчанию, а не возможность. Один атрибут уровня сборки стирает большую её часть:

```csharp
// NUnit 4.6.1
[assembly: Parallelizable(ParallelScope.Fixtures)]
```

```csharp
// MSTest 4.3.3
[assembly: Parallelize(Workers = 0, Scope = ExecutionScope.ClassLevel)]
```

С ними все три укладываются между 1.29 и 1.69 секунды. Оставшийся разброс в 240-380 мс приходится на накладные расходы при старте runner, а не на выполнение тестов: xUnit v3 хостит Microsoft.Testing.Platform нативно, тогда как NUnit 4.6.1 добирается до неё через мост VSTest в NUnit3TestAdapter, что стоит немного дороже на старте.

Честная формулировка такая. Преимущество xUnit в том, что безопасное значение по умолчанию одновременно является быстрым, и безопасно оно благодаря модели экземпляра на каждый тест. NUnit и MSTest требуют явного включения, а на NUnit сначала стоит исправить жизненный цикл fixture. Если ваша CI три года гоняет 12-минутный набор MSTest последовательно, лечится это одной строкой, а не миграцией.

## Вывод при провале утверждений, бок о бок

Раньше это был разгром. Больше нет. Одни и те же три провала, реальный вывод каждого runner:

```text
# xunit.v3 3.2.2
Assert.Equal() Failure: Strings differ
                  ↓ (pos 7)
Expected: "hello world"
Actual:   "hello wurld"
                  ↑ (pos 7)

Assert.Equal() Failure: Collections differ
                 ↓ (pos 2)
Expected: [1, 2, 3, 8]
Actual:   [1, 2, 4, 8]
                 ↑ (pos 2)
```

```text
# NUnit 4.6.1
Assert.That("hello wurld", Is.EqualTo("hello world"))
String lengths are both 11. Strings differ at index 7.
Expected: "hello world"
But was:  "hello wurld"
------------------^

Assert.That(actual, Is.EqualTo(expected))
Expected and actual are both <System.Int32[4]>
Values differ at index [2]
Expected: 3
But was:  4
```

```text
# MSTest 4.3.3
Assertion failed. Expected strings to be equal.
Strings have same length (11) and differ at 1 location(s). First difference at index 7.

expected: "hello world"
actual:   "hello wurld"

Assert.AreEqual("hello world", "hello wurld")
```

Все три указывают на точный индекс. NUnit и MSTest 4 при этом выводят само исходное выражение, которое упало, чего xUnit не делает, потому что MSTest 4 добавил `CallerArgumentExpression` во все API `Assert`, а у NUnit это есть с версии 4.0. xUnit компенсирует визуальными маркерами позиции, которые лучше работают на длинных строках и коллекциях.

Где MSTest всё ещё отстаёт, так это случай коллекций: `CollectionAssert.AreEqual` печатает "Element at index 2 do not match", не показывая ни одну из последовательностей, так что индекс вы получаете, а форму расхождения нет. Если вы часто сравниваете коллекции, это ощутимая заноза.

Две детали API, которые стоит знать до того, как писать утверждения на MSTest 4. `Assert.That` принимает `Expression<Func<bool>>`, а не `bool`, поэтому `Assert.That(1 + 1 == 2)` не компилируется, а `Assert.That(() => 1 + 1 == 2)` компилируется. И у MSTest нет `Assert.Multiple`; у xUnit v3 и NUnit 4.6 он есть.

## Подвох, который выбирает за вас

Если сегодня поднять проект на NUnit с нативным runner NUnit на .NET SDK 10.0.201, вы получите вот это:

```text
error CS1705: Assembly 'NUnit3.TestAdapter' with identity 'NUnit3.TestAdapter, Version=5.1.0.0'
uses 'Microsoft.Testing.Platform, Version=1.8.1.0' which has a higher version than referenced
assembly 'Microsoft.Testing.Platform' with identity 'Microsoft.Testing.Platform, Version=1.7.3.0'
```

NUnit3TestAdapter 5.1.0 скомпилирован против Microsoft.Testing.Platform 1.8.1, но ничто в графе пакетов эту зависимость не объявляет, поэтому побеждает версия, которую подставляет SDK: 1.7.3. Проект не собирается. Лечится это самостоятельным закреплением обеих сборок платформы:

```xml
<!-- NUnit 4.6.1 + NUnit3TestAdapter 5.1.0 on .NET SDK 10.0.201 -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <OutputType>Exe</OutputType>
  <EnableNUnitRunner>true</EnableNUnitRunner>
  <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
</PropertyGroup>
<ItemGroup>
  <PackageReference Include="NUnit" Version="4.6.1" />
  <PackageReference Include="NUnit3TestAdapter" Version="5.1.0" />
  <PackageReference Include="Microsoft.Testing.Platform" Version="1.8.1" />
  <PackageReference Include="Microsoft.Testing.Extensions.VSTestBridge" Version="1.8.1" />
</ItemGroup>
```

Нужны оба закрепления. Добавление одного лишь `Microsoft.Testing.Platform` убирает ошибку, но оставляет предупреждение о конфликте MSB3277 на `Microsoft.Testing.Extensions.VSTestBridge`. С обоими сборка чистая.

Эквивалентным проектам на xUnit v3 и MSTest 4 закрепление не нужно вовсе, потому что оба фреймворка владеют своей зависимостью от платформы целиком:

```xml
<!-- xunit.v3 3.2.2 on .NET SDK 10.0.201: this is the whole file -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <OutputType>Exe</OutputType>
  <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
</PropertyGroup>
<ItemGroup>
  <PackageReference Include="xunit.v3" Version="3.2.2" />
</ItemGroup>
```

Эта единственная `PackageReference` даёт самую чистую историю из трёх. Runner NUnit представляет собой мост поверх VSTest в пальто MTP, и шов чувствуется. Проявляется он и в CLI: xUnit v3 использует собственный язык запросов с одним дефисом (`-filter "/*/*/FailingTests/*"`), runner NUnit принимает синтаксис VSTest (`--filter "FullyQualifiedName~FailingTests"`), а MSTest принимает графовые запросы MTP. Три фреймворка на одной платформе, три диалекта фильтров.

## Где каждый из них всё ещё выигрывает

**Выбирайте xUnit v3 3.2.2, если** вы стартуете с нуля на .NET 8 или новее. Модель экземпляра на каждый тест убирает целую категорию багов, зависящих от порядка, ещё до того, как вы успеете их написать, параллелизм включён без вашего участия, а v3 принёс действительно полезные добавления: `Assert.Skip`/`Assert.SkipWhen` для пропуска во время выполнения, `MatrixTheoryData`, fixture уровня сборки через `[assembly: AssemblyFixture(...)]` и `[CaptureConsole]` для перенаправления случайных `Console.WriteLine` в вывод теста.

**Выбирайте NUnit 4.6.1, если** ваша команда уже мыслит ограничениями. `Assert.That(items, Has.Exactly(1).EqualTo(2).And.Length.EqualTo(3))` компонуется так, как не умеют другие два, а `[TestCase]`, `[Values]` и `[Combinatorial]` покрывают параметризованное тестирование полнее, чем `[Theory]` или `[DataRow]`. К тому же это единственный из трёх, кто всё ещё поддерживает .NET 6, что имеет значение, если у вас есть отстающий проект. Заложите в бюджет закрепление MTP из раздела выше и задайте жизненный цикл fixture явно.

**Выбирайте MSTest 4.3.3, если** MSTest у вас уже есть. v4 представляет собой настоящий релиз, а не поддержку: `CallerArgumentExpression` в каждом assert, `Assert.ThrowsExactly`, `AssemblyFixtureProvider` для разделения setup уровня сборки между проектами (новинка 4.3.0) и отключённая по умолчанию под MTP изоляция AppDomain, ускорение от которой Microsoft измерила до 30 %. Миграция с v3 не бесплатна, так как v4 не бинарно совместим и отбрасывает .NET Core 3.1 - .NET 7, но анализаторы и code fixes берут на себя основную механическую работу.

## Что бы я сделал на практике

Новый проект в 2026 году: xUnit v3. Конфигурация по умолчанию является правильной конфигурацией, а это именно то свойство, которого ждёшь от тестового фреймворка, и с файлом проекта из одного пакета спорить трудно.

Существующий набор на NUnit или MSTest: оставайтесь. Измеренный разрыв между этими тремя после включения параллелизма составляет менее 400 мс накладных расходов на старт для набора из двадцати тестов. Это не бюджет на миграцию. Потратьте вечер на добавление `[assembly: Parallelizable(ParallelScope.Fixtures)]` (плюс `[FixtureLifeCycle(LifeCycle.InstancePerTestCase)]`) или `[assembly: Parallelize(...)]`, и вы заберёте почти весь доступный выигрыш.

Выбор фреймворка в 2026 году значит куда меньше, чем в 2022, потому что под всеми тремя теперь лежит Microsoft.Testing.Platform. Runner, отчётность, интеграция с CI и CLI сходятся. Выбирать остаётся модель жизненного цикла и диалект утверждений, а это предпочтения с одним реальным следствием для корректности: разделяемый экземпляр fixture в NUnit.

## Похожие статьи

- Если вы настраиваете тесты для ASP.NET Core, начните с [интеграционных тестов с `WebApplicationFactory<T>`](/ru/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/), это работает одинаково во всех трёх фреймворках.
- Для тестов, которым нужна настоящая база данных, а не подделка, смотрите [интеграционные тесты против реального SQL Server с Testcontainers](/ru/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).
- Зависящие от времени тесты остаются вторым частым источником нестабильности: [тестирование с `TimeProvider` и `FakeTimeProvider`](/ru/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/).
- Со стороны отчётности [Microsoft.Testing.Platform 2.3 выводит провалы прямо в диф PR](/ru/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/) независимо от того, какой фреймворк их породил.
- Ещё два независимых от фреймворка приёма тестирования: [юнит-тестирование кода, использующего `HttpClient`](/ru/2026/04/how-to-unit-test-code-that-uses-httpclient/) и [мокирование `DbContext` без поломки отслеживания изменений](/ru/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/).

## Источники

- [What's New in xUnit.net v3](https://xunit.net/docs/getting-started/v3/whats-new) и [Microsoft Testing Platform support in xUnit.net v3](https://xunit.net/docs/getting-started/v3/microsoft-testing-platform)
- [xUnit.net shared context documentation](https://xunit.net/docs/shared-context) о модели экземпляра на каждый тест
- [NUnit `FixtureLifeCycle` documentation](https://docs.nunit.org/articles/nunit/writing-tests/attributes/fixturelifecycle.html)
- [NUnit and Microsoft.Testing.Platform](https://docs.nunit.org/articles/vs-test-adapter/NUnit-And-Microsoft-Test-Platform.html)
- [MSTest migration from v3 to v4](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-migration-v3-v4) и [MSTest test lifecycle](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-writing-tests-lifecycle)
- [Microsoft.Testing.Platform: now supported by all major .NET test frameworks](https://devblogs.microsoft.com/dotnet/mtp-adoption-frameworks/)
- Версии пакетов из NuGet: [xunit.v3 3.2.2](https://www.nuget.org/packages/xunit.v3), [NUnit 4.6.1](https://www.nuget.org/packages/NUnit), [MSTest 4.3.3](https://www.nuget.org/packages/MSTest)

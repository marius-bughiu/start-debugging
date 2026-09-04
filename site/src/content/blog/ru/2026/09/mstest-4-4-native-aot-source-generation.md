---
title: "MSTest 4.4 выводит генератор исходного кода для рефлексии из эксперимента, а проекты Native AOT получают его автоматически"
description: "MSTest 4.4 убирает у MSTest.SourceGeneration статус экспериментального и привязывает его к версии MSTest. Тестовые проекты Native AOT подключают его без opt-in, режим ReflectionFree теперь может пропускать обнаружение во время выполнения для простых [TestMethod] и [DataRow], а пять диагностик AOTSG показывают, какие формы тестов не пройдут."
pubDate: 2026-09-04
tags:
  - "mstest"
  - "native-aot"
  - "testing"
  - "source-generators"
  - "dotnet"
lang: "ru"
translationOf: "2026/09/mstest-4-4-native-aot-source-generation"
translatedBy: "claude"
translationDate: 2026-09-04
---

3 сентября 2026 года Microsoft опубликовала статью ["Test what you ship: MSTest and Native AOT"](https://devblogs.microsoft.com/dotnet/mstest-source-generation/), и утверждение в заголовке и есть вся суть. Если вы разворачиваете приложение с `PublishAot`, ваш CI проверял не тот двоичный файл, который запускают пользователи: хост тестов загружается на CoreCLR с полной рефлексией, поэтому член, который trimmer удалил бы, всё ещё на месте, когда выполняется проверка. Сбой проявляется уже в продакшене.

В MSTest 4.3 решение появилось в экспериментальном пакете `MSTest.SourceGeneration` с независимой версией. MSTest 4.4 выводит его из эксперимента: пакет теряет пометку experimental и переходит на версионную линию MSTest, а `MSTest.Sdk` согласует версии `MSTest.SourceGeneration`, `MSTest.TestFramework` и `MSTest.TestAdapter` через `MSTestVersion`.

## Проекты Native AOT получают генератор без opt-in

Тестовый проект, в котором задан `PublishAot`, теперь подключает генератор автоматически:

```xml
<Project Sdk="MSTest.Sdk/4.4.0">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <PublishAot>true</PublishAot>
  </PropertyGroup>
</Project>
```

Сам код тестов не меняется. Обычные члены `[TestClass]` и `[TestMethod]` остаются как есть, а генератор создаёт реестр, данные атрибутов и делегаты вызова во время компиляции, до запуска trimmer.

Для проекта не на Native AOT, использующего `MSTest.Sdk`, генератор подключается по желанию:

```xml
<EnableMSTestSourceGeneration>true</EnableMSTestSourceGeneration>
```

Это также работает в переиспользуемых тестовых библиотеках и при Central Package Management, где SDK генерирует соответствующие элементы `PackageVersion`. На .NET Standard это не работает: нужных хуков среды выполнения `MSTest.TestAdapter` там нет, и SDK прерывает сборку с явной ошибкой, а не создаёт сломанный реестр.

## Обнаружение во время компиляции меняет одно правило

Поскольку обнаружение происходит во время компиляции, `[TestClass]` должен быть объявлен на самом классе. Наследование его от базового класса раньше работало через рефлексию, а теперь молча не даёт ничего. Анализатор [MSTEST0069](https://learn.microsoft.com/en-us/dotnet/core/testing/mstest-analyzers/mstest0069) помечает именно этот случай, и это разница между предупреждением сборки и прогоном CI, который сообщает о нуле тестов и завершается зелёным.

## Что на самом деле покрывает ReflectionFree в 4.4

Начиная с MSTest 4.3.2 `MSTestSourceGenMode` по умолчанию равен `ReflectionFree` для проектов с trimming и Native AOT. На среде выполнения, где рефлексия ещё доступна, для всего, что генератор не покрыл, работает запасной путь.

4.4 расширяет покрытие. Генерация без рефлексии теперь материализует полные метаданные унаследованных атрибутов, включая `AttributeUsage` и `AllowMultiple`, а на [Microsoft.Testing.Platform](/ru/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/) она может полностью пропускать обнаружение и валидацию во время выполнения для простых синхронных методов `[TestMethod]` и `[DataRow]`. Асинхронные тесты, пользовательские атрибуты тестовых методов, `DynamicData`, собственные реализации `ITestDataSource` и неоднозначные формы по-прежнему идут по запасному пути. VSTest в любом случае сохраняет свой прежний путь.

Пять диагностик показывают, что режим без рефлексии сгенерировать не может: `AOTSG0001` статический тестовый класс, `AOTSG0002` открытый обобщённый тестовый класс (включая вложенный в обобщённый тип), `AOTSG0003` класс, до которого не дотягивается сгенерированный код, например file-local или вложенный как private, `AOTSG0004` обобщённый тестовый метод и `AOTSG0005` тестовый метод с параметром `ref`, `in` или `out`.

Если что-то сломается и нужно локализовать причину, есть запасной выход, который сохраняет обнаружение, но возвращает выполнение через рефлексию:

```xml
<PropertyGroup>
  <MSTestSourceGenMode>Rooting</MSTestSourceGenMode>
</PropertyGroup>
```

Одна оговорка, которую стоит прочитать до переписывания пайплайна: поведение 4.4 пока доступно только в предварительных сборках, до выхода MSTest 4.4.0. Полный список свойств есть в [документации по настройке MSTest SDK](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-sdk).

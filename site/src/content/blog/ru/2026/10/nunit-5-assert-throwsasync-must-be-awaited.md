---
title: "NUnit 5: Assert.ThrowsAsync теперь возвращает Task, а без await тест проходит молча"
description: "NUnit 5.0.0 делает Assert.ThrowsAsync, CatchAsync и DoesNotThrowAsync по-настоящему асинхронными. Если забыть await, проверка просто не выполнится. Что ломается, что ловит правило NUnit2059 из NUnit.Analyzers и какие ещё изменения NUnit 5 стоит проверить перед обновлением."
pubDate: 2026-10-04
tags:
  - "nunit"
  - "testing"
  - "dotnet"
  - "csharp"
lang: "ru"
translationOf: "2026/10/nunit-5-assert-throwsasync-must-be-awaited"
translatedBy: "claude"
translationDate: 2026-10-04
---

[NUnit 5.0.0](https://github.com/nunit/nunit/releases/tag/v5.0.0) вышел 27 сентября 2026 года. Разработчики называют его небольшим мажорным релизом, и большинство [критических изменений](https://docs.nunit.org/articles/nunit/V5BreakingChanges.html) превращают сбои во время выполнения в ошибки компиляции. Одно изменение работает в обратную сторону: при неосторожном обновлении падающий тест может начать проходить.

## ThrowsAsync раньше блокировал поток, теперь возвращает Task

В NUnit 4 методы `Assert.ThrowsAsync<T>`, `Assert.CatchAsync` и `Assert.DoesNotThrowAsync` только назывались асинхронными: делегат выполнялся синхронно, блокируя вызывающий поток, а исключение возвращалось напрямую. [Issue #4384](https://github.com/nunit/nunit/issues/4384) исправил это в 5.0.0: теперь все три метода возвращают `Task`, и его нужно ожидать.

```csharp
// NUnit 4.6.1
var ex = Assert.ThrowsAsync<ArgumentException>(async () => await DoAsync());

// NUnit 5.0.0
var ex = await Assert.ThrowsAsync<ArgumentException>(async () => await DoAsync());
```

Новая форма правильная. Проблема в уже написанном коде.

## Молчаливое прохождение

Старые тесты вызывают `ThrowsAsync` из обычного метода `void`. В NUnit 5 это по-прежнему компилируется: возвращённый `Task` отбрасывается, а поскольку метод не `async`, компилятор не выдаёт даже CS4014. Я запускал это на .NET SDK 10.0.302 с NUnit3TestAdapter 6.3.0, где `DoesNotThrowAsync` никогда не бросает исключение:

```csharp
static async Task DoesNotThrowAsync() => await Task.Delay(10);

[Test]
public void Unawaited()
{
    var ex = Assert.ThrowsAsync<ArgumentException>(async () => await DoesNotThrowAsync());
}

[Test]
public async Task Awaited()
{
    var ex = await Assert.ThrowsAsync<ArgumentException>(async () => await DoesNotThrowAsync());
}
```

Результаты:

| Конфигурация | `Unawaited` | `Awaited` |
| --- | --- | --- |
| NUnit 4.6.1 | падает (верно) | CS1061, у `ArgumentException` нет `GetAwaiter` |
| NUnit 5.0.0, NUnit.Analyzers 4.13.0 | **проходит** | падает (верно) |
| NUnit 5.0.0, NUnit.Analyzers 4.14.0 или 4.15.0 | ошибка сборки NUnit2059 | падает (верно) |

Беспокоить должна средняя строка. Тест, который должен поймать отсутствующий `ArgumentException`, становится зелёным, и ничто в выводе тестов не намекает, что проверка вообще не выполнялась.

## Пусть миграцию сделает анализатор

В [NUnit.Analyzers](https://www.nuget.org/packages/NUnit.Analyzers) 4.14.0 добавлено правило NUnit2059, "Method 'ThrowsAsync' returns a Task and is not being observed", которое по умолчанию считается ошибкой. Его исправление кода добавляет `await` и меняет объемлющий метод на `async Task`. Поэтому порядок обновления важен:

```xml
<PackageReference Include="NUnit" Version="5.0.0" />
<PackageReference Include="NUnit.Analyzers" Version="4.15.0" />
<PackageReference Include="NUnit3TestAdapter" Version="6.3.0" />
```

Обновляйте анализатор в том же коммите, что и фреймворк. Если в ваших проектах NUnit.Analyzers централизованно закреплён в `Directory.Packages.props` на старой версии или удалён, сборка останется зелёной, и вы получите строку с молчаливым прохождением.

## Другие изменения NUnit 5, которые стоит поискать grep-ом

- `TestDelegate`, `AsyncTestDelegate` и `ActualValueDelegate<T>` удалены. Лямбды не затронуты; явные использования заменяются на `Action`, `Func<Task>` и `Func<T>`.
- `[Platform("NET")]` и `"DotNET"` теперь означают современный .NET, а не .NET Framework. Если вы имели в виду именно его, используйте новый идентификатор `"NETFramework"`, иначе тесты незаметно начнут запускаться (или перестанут запускаться) не в той среде выполнения.
- `Is.SameAs` принимает только ссылочные типы, а `Has.Attribute<T>()` требует `T : Attribute`. Раньше оба случая приводили к сбоям во время выполнения.
- `StringAssert`, `CollectionAssert`, `FileAssert` и `DirectoryAssert` возвращаются в `NUnit.Framework`.
- Фреймворк нацелен на `net462`, `net8.0` и `net10.0`. Цель `net6.0` удалена.
- `[Order]` теперь помечен `[Obsolete]`. Замена: новые атрибуты `[DependsOnTest]` и `[DependsOnFixture]`, которые пропускают тест, если его зависимость упала.

Если вы решаете, подходит ли NUnit для нового проекта, мой [сравнительный обзор xUnit v3, NUnit и MSTest](/ru/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/) был измерен на NUnit 4.6.1. Эти цифры появились до 5.0.0, но вывод не зависит ни от чего, что изменилось в этом релизе.

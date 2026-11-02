---
title: "Производительность GetGenericTypeDefinition в .NET 8: воспроизводимый benchmark"
description: "Повторите вызовы GetGenericTypeDefinition с BenchmarkDotNet и сравните выбранные среды .NET без предположения о фиксированном ускорении."
pubDate: 2023-11-05
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/11/net-8-performance-10x-faster-getgenerictypedefinition"
translatedBy: "claude"
translationDate: 2026-05-01
---
Microsoft описала улучшения обработки информации о generic-типах в .NET 8, включая кеширование результата `GetGenericTypeDefinition` в объекте `Type`. Это конкретная оптимизация runtime, а не постоянный множитель для любой работы с рефлексией.

**Исправление — 2 ноября 2026 года:** прежний заголовок «10x» и таблица без подтверждённого источника удалены: исходные артефакты запуска и репозиторий недоступны. Исторический URL сохранён, а исполняемый benchmark теперь поддерживается вместе с сайтом.

## Восстановить benchmark

[Скачайте исходный проект](/examples/generic-type-definition-benchmarks.zip). Он собирается для .NET 7 и .NET 8 и закрепляет BenchmarkDotNet 0.13.12. Основная работа выглядит так:

```cs
public class GenericTypeBenchmarks
{
    private readonly Type _type = typeof(List<int>);

    [Benchmark]
    public Type GetGenericTypeDefinition() => _type.GetGenericTypeDefinition();
}
```

Полный проект включает импорты и runner. Запустите функциональную проверку и обычные измерения:

```sh
dotnet run -c Release -f net8.0 -- --verify
dotnet run -c Release -f net8.0 -- --filter '*'
```

Функциональная проверка подтверждает результат `typeof(List<>)`. Dry-задание позволяет быстро проверить выполнение, но его время не является надёжной оценкой производительности.

## Сравнение .NET 7 и .NET 8

Установите обе среды выполнения и выберите их явно:

```sh
dotnet run -c Release -f net8.0 -- --runtimes net7.0 net8.0 --filter '*'
```

Историческое сравнение требует именно этих runtime. Запуск приложения с целевой .NET 8 на более новой среде не воспроизводит измерения .NET 8. Сохраняйте с опубликованным результатом сгенерированные сведения об окружении и отчёты.

Этот benchmark измеряет повторные вызовы для известного `Type`. Он не измеряет загрузку типов, поиск без кеша или приложение целиком. [Анализ производительности .NET 8 от Microsoft](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-8/) объясняет оптимизацию и приводит собственные измерения; это отдельно от проверки данного проекта.

Другую работу с рефлексией рассматривает [сравнение UnsafeAccessor](/ru/2023/11/net-8-performance-unsafeaccessor-vs-reflection/).

---
title: "System.Text.Json наконец-то пишет JSON Lines в .NET 11 Preview 5"
description: ".NET 11 Preview 5 добавляет JsonSerializer.SerializeAsyncEnumerable с topLevelValues: true, поэтому System.Text.Json теперь умеет передавать JSONL потоком, а не только читать его."
pubDate: 2026-06-10
tags:
  - "dotnet-11"
  - "csharp"
  - "system-text-json"
  - "serialization"
lang: "ru"
translationOf: "2026/06/system-text-json-json-lines-serialization-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-10
---

[Заметки о библиотеках .NET 11 Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/libraries.md) закрывают пробел, который оставался открытым со времён .NET 9: `System.Text.Json` теперь умеет сериализовать JSON Lines, а не только десериализовать. Сторона чтения появилась две версии назад, стороны записи не хватало, и всякому, кто экспортировал JSONL, приходилось вручную писать цикл, выводящий по одному документу на строку. Preview 5 превращает это в один вызов.

## Что такое JSON Lines на самом деле

JSON Lines (JSONL) -- это не массив JSON. Это одно независимое значение JSON на строку, разделённые `\n`, без обрамляющих скобок и без запятых между записями:

```
{"Device":"kitchen","Celsius":21.4}
{"Device":"garage","Celsius":8.1}
```

Эта форма встречается повсюду, как только вы начинаете передавать данные потоком: структурированные файлы журналов, крупные выгрузки из базы данных и пакетные форматы ввода/вывода, используемые конвейерами обучения и оценки LLM. Выигрыш в том, что вы можете дописать запись, не переписывая файл, и можете обрабатывать файл строка за строкой, ни разу не держа всё целиком в памяти. Массив JSON верхнего уровня не даёт ничего из этого, потому что анализатор не может узнать, что массив корректен, пока не увидит закрывающую `]`.

## Сторона записи, которой не хватало

`System.Text.Json` научился *читать* несколько значений верхнего уровня в .NET 9, когда `DeserializeAsyncEnumerable` получил параметр `topLevelValues`. Preview 5 добавляет симметричную перегрузку в сериализатор:

```csharp
record SensorReading(string Device, double Celsius, DateTimeOffset At);

async IAsyncEnumerable<SensorReading> GetReadings()
{
    yield return new("kitchen", 21.4, DateTimeOffset.UtcNow);
    yield return new("garage", 8.1, DateTimeOffset.UtcNow);
}

await using var stream = File.Create("readings.jsonl");
await JsonSerializer.SerializeAsyncEnumerable(
    stream,
    GetReadings(),
    topLevelValues: true);
```

С `topLevelValues: true` вы получаете JSONL: каждый элемент записывается как собственный корневой документ на отдельной строке. Оставьте значение по умолчанию `false`, и вы получите прежнее поведение -- единый массив JSON. Новые перегрузки принимают как `Stream`, так и `PipeWriter`, и берут либо `JsonSerializerOptions`, либо сгенерированный исходным кодом `JsonTypeInfo<TValue>` для сериализации без рефлексии, дружественной к AOT.

## Чистый полный цикл

Поскольку сторона чтения уже существует, обе половины теперь выстраиваются вместе:

```csharp
await using var input = File.OpenRead("readings.jsonl");

await foreach (var reading in JsonSerializer.DeserializeAsyncEnumerable<SensorReading>(
    input,
    topLevelValues: true))
{
    Console.WriteLine($"{reading.Device}: {reading.Celsius} C");
}
```

Обратите внимание, что `GetReadings` -- это `IAsyncEnumerable<T>`, поэтому сериализатор извлекает записи по мере того, как их пишет. Вы можете передавать поток прямо из курсора базы данных или ответа HTTP в файл JSONL, не материализуя предварительно `List<T>`. В этом и весь смысл: постоянное потребление памяти независимо от того, сколько записей вы пропускаете.

Это всё ещё предварительная версия, поэтому точные сигнатуры могут измениться до ноябрьского релиза. Но форма API настолько повторяет сторону чтения, что уже безопасно начинать проектировать с расчётом на неё. Если вы склеивали `Utf8JsonWriter` с ручными переводами строк, чтобы выдавать JSONL, это тот самый вызов, который заменяет всё это.

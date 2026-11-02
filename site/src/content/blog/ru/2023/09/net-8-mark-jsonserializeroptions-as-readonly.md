---
title: ".NET 8 пометить JsonSerializerOptions как readonly"
description: "Зафиксируйте JsonSerializerOptions через MakeReadOnly, настройте отсутствующий TypeInfoResolver и создайте изменяемую копию в рабочем примере для .NET 8."
pubDate: 2023-09-11
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/09/net-8-mark-jsonserializeroptions-as-readonly"
translatedBy: "claude"
translationDate: 2026-05-01
---
Начиная с .NET 8, `JsonSerializerOptions.MakeReadOnly()` фиксирует объект настроек. Сначала задайте его `TypeInfoResolver`: у нового объекта разрешителя нет, поэтому немедленный вызов метода без параметров выдаёт `InvalidOperationException`.

> **Исправление — 2 ноября 2026 года:** В прежнем примере отсутствовал разрешитель, поэтому он завершался ошибкой на `MakeReadOnly()`. Пример ниже использует генерируемые метаданные и работает также при отключённой стандартной рефлексии.

## Фиксация подготовленных настроек

Этот полный `Program.cs` использует сгенерированный разрешитель, сериализует с зафиксированными настройками, отклоняет последующее изменение и создаёт независимо настраиваемую копию:

```cs
using System.Text.Json;
using System.Text.Json.Serialization;

var options = new JsonSerializerOptions
{
    TypeInfoResolver = DemoJsonContext.Default,
    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseUpper
};
options.MakeReadOnly();
Console.WriteLine(options.IsReadOnly);
Console.WriteLine(JsonSerializer.Serialize(new Widget(42, "Ada"), options));

try
{
    options.WriteIndented = true;
}
catch (InvalidOperationException)
{
    Console.WriteLine("Mutation rejected");
}

var copy = new JsonSerializerOptions(options);
Console.WriteLine(copy.IsReadOnly);
copy.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
Console.WriteLine(JsonSerializer.Serialize(new Widget(42, "Ada"), copy));

public sealed record Widget(int Id, string Name);

[JsonSerializable(typeof(Widget))]
internal partial class DemoJsonContext : JsonSerializerContext { }
```

Результат:

```text
True
{"ID":42,"NAME":"Ada"}
Mutation rejected
False
{"id":42,"name":"Ada"}
```

После фиксации `IsReadOnly` становится `true`. Повторный вызов `MakeReadOnly()` допустим. Последующее изменение настройки вызывает `InvalidOperationException`. Использование для сериализации или десериализации также делает настройки доступными только для чтения.

Конструктор копирования сохраняет исходные настройки, включая разрешитель, но создаёт изменяемый экземпляр. Настройте копию до первого использования: сериализация с ней тоже её зафиксирует.

## Почему MakeReadOnly выдаёт ошибку без разрешителя?

`new JsonSerializerOptions().MakeReadOnly()` не выбирает разрешитель автоматически. Задайте его явно, как выше, либо используйте `MakeReadOnly(populateMissingResolver: true)`, если сериализация через рефлексию необходима и включена.

Эта перегрузка заполняет отсутствующий разрешитель стандартным разрешителем на основе рефлексии. При отключённой стандартной рефлексии заполнить этот пробел нельзя, и возникает `InvalidOperationException`. В приложениях с trimming или Native AOT она не заменяет генерируемые метаданные. См. [отключение стандартной рефлексии и настройку контекста](/ru/2023/10/system-text-json-disable-reflection-based-serialization/) и [контракт API MakeReadOnly](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.makereadonly?view=net-8.0).

## Запуск проверенного примера

[Скачайте полный проект настроек System.Text.Json](/examples/system-text-json-options.zip), распакуйте и выполните:

```sh
dotnet run -c Release
```

Проект .NET 8 без дополнительных зависимостей проверяет отсутствующие разрешители, повторную фиксацию, отклонение изменений, сериализацию с генератором и поведение копий. Отдельно проверяется `populateMissingResolver` при отключённой и включённой стандартной рефлексии. Все проверки прошли на реальных средах .NET 8.0.33 и .NET 10.0.10; команды и результаты находятся в записи о проверке внутри архива.

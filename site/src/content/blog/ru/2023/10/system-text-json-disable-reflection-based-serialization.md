---
title: "System.Text.Json отключаем сериализацию на основе рефлексии"
description: "Отключите стандартную рефлексию System.Text.Json, разберите InvalidOperationException и выполните сериализацию с генерируемым контекстом в примере для .NET 8."
pubDate: 2023-10-21
updatedDate: 2026-11-02
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/10/system-text-json-disable-reflection-based-serialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
Начиная с .NET 8, значение `false` у `JsonSerializerIsReflectionEnabledByDefault` отключает стандартный переход к рефлексии в `System.Text.Json`. После этого метаданные сериализации нужно предоставить через контекст, созданный генератором исходного кода.

> **Исправление — 2 ноября 2026 года:** Ранее была указана неверная ошибка и создавалось впечатление, что достаточно передать объект настроек. При отключённой стандартной рефлексии обычный вызов сериализации выдаёт `InvalidOperationException`; пустые настройки проблему не решают.

## Отключение стандартной рефлексии

Добавьте это свойство в `.csproj`:

```xml
<PropertyGroup>
  <JsonSerializerIsReflectionEnabledByDefault>false</JsonSerializerIsReflectionEnabledByDefault>
</PropertyGroup>
```

При такой настройке и `JsonSerializer.Serialize(widget)`, и `JsonSerializer.Serialize(widget, new JsonSerializerOptions())` завершаются ошибкой. Создание объекта настроек не предоставляет метаданные типа. Свойство `JsonSerializer.IsReflectionEnabledByDefault` показывает действующее значение переключателя.

Переключатель управляет стандартным механизмом рефлексии сериализатора, а не всей рефлексией приложения. Начиная с .NET 8, `PublishTrimmed` также отключает этот механизм, если настройка явно не переопределена. См. [примечание Microsoft о совместимости с trimming](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/8.0/publishtrimmed).

## Сериализация и десериализация с генерируемыми метаданными

Используйте этот полный `Program.cs` в консольном проекте .NET 8 с указанным выше свойством:

```cs
using System.Text.Json;
using System.Text.Json.Serialization;

Console.WriteLine(JsonSerializer.IsReflectionEnabledByDefault);
var widget = new Widget(42, "Ada");
string json = JsonSerializer.Serialize(widget, DemoJsonContext.Default.Widget);
Widget restored = JsonSerializer.Deserialize(json, DemoJsonContext.Default.Widget)!;
Console.WriteLine(json);
Console.WriteLine($"Round trip: {restored.Id} {restored.Name}");

public sealed record Widget(int Id, string Name);

[JsonSerializable(typeof(Widget))]
internal partial class DemoJsonContext : JsonSerializerContext { }
```

Результат:

```text
False
{"Id":42,"Name":"Ada"}
Round trip: 42 Ada
```

`[JsonSerializable]` регистрирует `Widget`, а контекст напрямую предоставляет сгенерированный `JsonTypeInfo<Widget>`. Эти перегрузки не требуют отдельного объекта настроек.

Если API принимает `JsonSerializerOptions`, явно задайте разрешитель:

```cs
var options = new JsonSerializerOptions
{
    TypeInfoResolver = DemoJsonContext.Default
};
string json = JsonSerializer.Serialize(widget, options);
```

Регистрируйте фактические корневые типы, которые сериализуете, включая коллекции, когда они нужны. Для моделей с перечислениями см. [JsonStringEnumConverter с Native AOT](/ru/2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot/). Для повторного использования зафиксированных настроек см. [MakeReadOnly и требование к разрешителю](/ru/2023/09/net-8-mark-jsonserializeroptions-as-readonly/).

## Запуск проверенного примера

[Скачайте полный проект настроек System.Text.Json](/examples/system-text-json-options.zip), распакуйте и выполните:

```sh
dotnet run -c Release
```

Проект без дополнительных зависимостей нацелен на .NET 8 и проверяет неудачные стандартные вызовы, сериализацию и обратное чтение с генерируемыми метаданными, а также путь через разрешитель настроек. Он также проверяет настройки только для чтения. Все проверки выполнены на реальных средах .NET 8.0.33 и .NET 10.0.10; отдельные команды записаны в архиве. Тот же проект также опубликован и запущен как Native AOT .NET 8 для macOS arm64. Намеренные проверки ошибок и перегрузки, связанные с рефлексией, создают предупреждения анализа; они перечислены в записи о проверке.

Сведения о поддерживаемых типах и интеграции в приложение приведены в [руководстве Microsoft по генерации исходного кода](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation).

---
title: ".NET 8 JsonNamingPolicy: SnakeCaseLower и KebabCaseLower (System.Text.Json)"
description: "Используйте новые `JsonNamingPolicy.SnakeCaseLower` (а также SnakeCaseUpper, KebabCaseLower, KebabCaseUpper) в .NET 8 для сериализации JSON в snake_case / kebab-case через System.Text.Json без своего конвертера."
pubDate: 2023-08-06
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/08/net-8-json-serialize-property-names-using-snake-case-and-kebab-case"
translatedBy: "claude"
translationDate: 2026-05-01
---
В .NET 8 появилось несколько новых политик именования, которые можно использовать с сериализатором `System.Text.Json`. Перечислим их:

-   SnakeCaseLower
-   SnakeCaseUpper
-   KebabCaseLower
-   KebabCaseUpper

Посмотрим на сериализованный вывод для каждой. Возьмём класс `Car`:

```cs
class Car
{
    public string Make { get; set; }
    public string ModelID { get; set; }
    public int LaunchYear { get; set; }
}
```

И будем сериализовать вот такой экземпляр:

```cs
var car = new Car
{
    Make = "Mazda",
    ModelID = "MX-5",
    LaunchYear = 1989
};
```

## snake\_case в нижнем регистре

Чтобы сериализовать в snake\_case в нижнем регистре, нужно указать `JsonNamingPolicy.SnakeCaseLower` в качестве `PropertyNamingPolicy` внутри `JsonSerializerOptions`:

```cs
var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };
JsonSerializer.Serialize(car, options);
```

Вывод:

```json
{"make":"Mazda","model_id":"MX-5","launch_year":1989}
```

## SNAKE\_CASE в верхнем регистре

Аналогично, но с `JsonNamingPolicy.SnakeCaseUpper` в качестве политики. Вывод:

```json
{"MAKE":"Mazda","MODEL_ID":"MX-5","LAUNCH_YEAR":1989}
```

## kebab-case в нижнем регистре

Чтобы сериализовать в kebab-case в нижнем регистре, укажите `JsonNamingPolicy.KebabCaseLower` в `PropertyNamingPolicy` внутри `JsonSerializerOptions`:

```cs
var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.KebabCaseLower };
JsonSerializer.Serialize(car, options);
```

Получим такой JSON:

```json
{"make":"Mazda","model-id":"MX-5","launch-year":1989}
```

## KEBAB-CASE в верхнем регистре

Так же, как и в предыдущем примере, но с `JsonNamingPolicy.KebabCaseUpper`. Получите:

```json
{"MAKE":"Mazda","MODEL-ID":"MX-5","LAUNCH-YEAR":1989}
```

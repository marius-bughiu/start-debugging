---
title: ".NET 8 JsonNamingPolicy: SnakeCaseLower und KebabCaseLower (System.Text.Json)"
description: "Verwenden Sie die neuen `JsonNamingPolicy.SnakeCaseLower` (und SnakeCaseUpper, KebabCaseLower, KebabCaseUpper) in .NET 8, um JSON in snake_case / kebab-case via System.Text.Json zu serialisieren — ohne eigenen Converter."
pubDate: 2023-08-06
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/08/net-8-json-serialize-property-names-using-snake-case-and-kebab-case"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 bringt mehrere neue Naming Policies für den `System.Text.Json`-Serializer mit, namentlich:

-   SnakeCaseLower
-   SnakeCaseUpper
-   KebabCaseLower
-   KebabCaseUpper

Sehen wir uns die serialisierten Ausgaben für jede an. Dafür verwenden wir eine `Car`-Klasse mit folgender Definition:

```cs
class Car
{
    public string Make { get; set; }
    public string ModelID { get; set; }
    public int LaunchYear { get; set; }
}
```

Und serialisieren folgende Instanz:

```cs
var car = new Car
{
    Make = "Mazda",
    ModelID = "MX-5",
    LaunchYear = 1989
};
```

## snake\_case in Kleinbuchstaben

Für die Serialisierung in snake\_case in Kleinbuchstaben setzen Sie in den `JsonSerializerOptions` `JsonNamingPolicy.SnakeCaseLower` als `PropertyNamingPolicy`:

```cs
var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };
JsonSerializer.Serialize(car, options);
```

Die Ausgabe lautet:

```json
{"make":"Mazda","model_id":"MX-5","launch_year":1989}
```

## SNAKE\_CASE in Großbuchstaben

Wie oben, nur mit `JsonNamingPolicy.SnakeCaseUpper` als Naming Policy. Die Ausgabe lautet:

```json
{"MAKE":"Mazda","MODEL_ID":"MX-5","LAUNCH_YEAR":1989}
```

## kebab-case in Kleinbuchstaben

Für die Serialisierung in kebab-case in Kleinbuchstaben setzen Sie in den `JsonSerializerOptions` `JsonNamingPolicy.KebabCaseLower` als `PropertyNamingPolicy`:

```cs
var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.KebabCaseLower };
JsonSerializer.Serialize(car, options);
```

Das ergibt folgendes JSON:

```json
{"make":"Mazda","model-id":"MX-5","launch-year":1989}
```

## KEBAB-CASE in Großbuchstaben

Wie im vorigen Beispiel, aber mit `JsonNamingPolicy.KebabCaseUpper` als Naming Policy. Sie erhalten:

```json
{"MAKE":"Mazda","MODEL-ID":"MX-5","LAUNCH-YEAR":1989}
```

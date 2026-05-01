---
title: ".NET 8 JsonNamingPolicy: SnakeCaseLower y KebabCaseLower (System.Text.Json)"
description: "Usa los nuevos `JsonNamingPolicy.SnakeCaseLower` (y SnakeCaseUpper, KebabCaseLower, KebabCaseUpper) de .NET 8 para serializar JSON en snake_case / kebab-case con System.Text.Json, sin necesidad de un converter personalizado."
pubDate: 2023-08-06
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/08/net-8-json-serialize-property-names-using-snake-case-and-kebab-case"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 introduce varias políticas de nombrado nuevas que se pueden usar con el serializador `System.Text.Json`. Para nombrarlas:

-   SnakeCaseLower
-   SnakeCaseUpper
-   KebabCaseLower
-   KebabCaseUpper

Veamos la salida serializada de cada una. Para ello, vamos a usar una clase `Car` con la siguiente definición:

```cs
class Car
{
    public string Make { get; set; }
    public string ModelID { get; set; }
    public int LaunchYear { get; set; }
}
```

Y vamos a serializar la siguiente instancia:

```cs
var car = new Car
{
    Make = "Mazda",
    ModelID = "MX-5",
    LaunchYear = 1989
};
```

## snake\_case en minúsculas

Para serializar usando snake\_case en minúsculas, hay que especificar `JsonNamingPolicy.SnakeCaseLower` como `PropertyNamingPolicy` dentro del `JsonSerializerOptions` del serializador. Así:

```cs
var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };
JsonSerializer.Serialize(car, options);
```

Y la salida será:

```json
{"make":"Mazda","model_id":"MX-5","launch_year":1989}
```

## SNAKE\_CASE en mayúsculas

Igual que arriba, usando `JsonNamingPolicy.SnakeCaseUpper` como política de nombrado de propiedades. La salida será:

```json
{"MAKE":"Mazda","MODEL_ID":"MX-5","LAUNCH_YEAR":1989}
```

## kebab-case en minúsculas

Para serializar usando kebab-case en minúsculas, hay que especificar `JsonNamingPolicy.KebabCaseLower` como `PropertyNamingPolicy` dentro del `JsonSerializerOptions` del serializador. Así:

```cs
var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.KebabCaseLower };
JsonSerializer.Serialize(car, options);
```

Esto producirá el siguiente JSON:

```json
{"make":"Mazda","model-id":"MX-5","launch-year":1989}
```

## KEBAB-CASE en mayúsculas

Igual que el ejemplo anterior, pero usando `JsonNamingPolicy.KebabCaseUpper` como política de nombrado de propiedades. Obtendrás la siguiente salida:

```json
{"MAKE":"Mazda","MODEL-ID":"MX-5","LAUNCH-YEAR":1989}
```

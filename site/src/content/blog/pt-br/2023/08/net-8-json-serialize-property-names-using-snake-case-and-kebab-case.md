---
title: ".NET 8 JsonNamingPolicy: SnakeCaseLower e KebabCaseLower (System.Text.Json)"
description: "Use o novo `JsonNamingPolicy.SnakeCaseLower` (e SnakeCaseUpper, KebabCaseLower, KebabCaseUpper) do .NET 8 para serializar JSON em snake_case / kebab-case via System.Text.Json, sem precisar de converter customizado."
pubDate: 2023-08-06
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/08/net-8-json-serialize-property-names-using-snake-case-and-kebab-case"
translatedBy: "claude"
translationDate: 2026-05-01
---
O .NET 8 traz várias novas naming policies que podem ser usadas com o serializador `System.Text.Json`. São elas:

-   SnakeCaseLower
-   SnakeCaseUpper
-   KebabCaseLower
-   KebabCaseUpper

Vamos olhar o resultado da serialização de cada uma. Para isso, vamos usar uma classe `Car` assim:

```cs
class Car
{
    public string Make { get; set; }
    public string ModelID { get; set; }
    public int LaunchYear { get; set; }
}
```

E vamos serializar a seguinte instância:

```cs
var car = new Car
{
    Make = "Mazda",
    ModelID = "MX-5",
    LaunchYear = 1989
};
```

## snake\_case em minúsculas

Para serializar em snake\_case minúsculo, defina `JsonNamingPolicy.SnakeCaseLower` como `PropertyNamingPolicy` no `JsonSerializerOptions`. Assim:

```cs
var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };
JsonSerializer.Serialize(car, options);
```

A saída será:

```json
{"make":"Mazda","model_id":"MX-5","launch_year":1989}
```

## SNAKE\_CASE em maiúsculas

Da mesma forma, usando `JsonNamingPolicy.SnakeCaseUpper` como naming policy. A saída será:

```json
{"MAKE":"Mazda","MODEL_ID":"MX-5","LAUNCH_YEAR":1989}
```

## kebab-case em minúsculas

Para serializar em kebab-case minúsculo, defina `JsonNamingPolicy.KebabCaseLower` como `PropertyNamingPolicy` no `JsonSerializerOptions`. Assim:

```cs
var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.KebabCaseLower };
JsonSerializer.Serialize(car, options);
```

Isso vai gerar o seguinte JSON:

```json
{"make":"Mazda","model-id":"MX-5","launch-year":1989}
```

## KEBAB-CASE em maiúsculas

Como no exemplo anterior, mas usando `JsonNamingPolicy.KebabCaseUpper` para a naming policy. Você obterá:

```json
{"MAKE":"Mazda","MODEL-ID":"MX-5","LAUNCH-YEAR":1989}
```

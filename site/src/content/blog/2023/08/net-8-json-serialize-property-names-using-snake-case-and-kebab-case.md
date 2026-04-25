---
title: ".NET 8 JsonNamingPolicy: SnakeCaseLower and KebabCaseLower (System.Text.Json)"
description: "Use the new .NET 8 `JsonNamingPolicy.SnakeCaseLower` (and SnakeCaseUpper, KebabCaseLower, KebabCaseUpper) to serialize snake_case / kebab-case JSON via System.Text.Json — no custom converter needed."
pubDate: 2023-08-06
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
---
.NET 8 introduces several new naming policies that can be used with the `System.Text.Json` serializer. To name them:

-   SnakeCaseLower
-   SnakeCaseUpper
-   KebabCaseLower
-   KebabCaseUpper

Let’s look at the serialized output for each of them. For this, we’re going to use a `Car` class with the following definition:

```cs
class Car
{
    public string Make { get; set; }
    public string ModelID { get; set; }
    public int LaunchYear { get; set; }
}
```

And we are going to serialize the following object instance:

```cs
var car = new Car
{
    Make = "Mazda",
    ModelID = "MX-5",
    LaunchYear = 1989
};
```

## Lower snake case (snake\_case)

To serialize using lower snake\_case, you need to specify `JsonNamingPolicy.SnakeCaseLower` as the `PropertyNamingPolicy` inside the serializer’s `JsonSerializerOptions`. Like so:

```cs
var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };
JsonSerializer.Serialize(car, options);
```

And the output will be:

```json
{"make":"Mazda","model_id":"MX-5","launch_year":1989}
```

## Upper snake case (SNAKE\_CASE)

Just like above, using `JsonNamingPolicy.SnakeCaseUpper` as the property naming policy. The output will be:

```json
{"MAKE":"Mazda","MODEL_ID":"MX-5","LAUNCH_YEAR":1989}
```

## Lower kebab case (kebab-case)

To serialize using lower kebab-case, you need to specify `JsonNamingPolicy.KebabCaseLower` as the `PropertyNamingPolicy` inside the serializer’s `JsonSerializerOptions`. Like so:

```cs
var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.KebabCaseLower };
JsonSerializer.Serialize(car, options);
```

This will output the following JSON:

```json
{"make":"Mazda","model-id":"MX-5","launch-year":1989}
```

## Upper kebab case (KEBAB-CASE)

Just like the previous example, but using `JsonNamingPolicy.KebabCaseUpper` for the property naming policy. You will get the following output:

```json
{"MAKE":"Mazda","MODEL-ID":"MX-5","LAUNCH-YEAR":1989}
```

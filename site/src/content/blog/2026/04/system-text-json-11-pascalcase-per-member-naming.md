---
title: "System.Text.Json in .NET 11 Preview 3 adds PascalCase and per-member naming policies"
description: ".NET 11 Preview 3 finishes the naming-policy story in System.Text.Json: JsonNamingPolicy.PascalCase, a member-level [JsonNamingPolicy] attribute, and a type-level [JsonIgnore] default for cleaner DTOs."
pubDate: 2026-04-18
tags:
  - "dotnet-11"
  - "system-text-json"
  - "csharp"
  - "serialization"
---

[.NET 8 introduced](https://startdebugging.net/2023/08/net-8-json-serialize-property-names-using-snake-case-and-kebab-case/) the first batch of built-in naming policies for `System.Text.Json`: camel, snake, and kebab in both casings. Preview 3 of .NET 11 closes the last obvious gap and adds two more knobs that make hand-rolled `JsonConverter`s unnecessary for most DTO shapes. The work shipped via [dotnet/runtime #124644](https://github.com/dotnet/runtime/pull/124644), [#124645](https://github.com/dotnet/runtime/pull/124645), and [#124646](https://github.com/dotnet/runtime/pull/124646).

## PascalCase joins the built-in policies

`JsonNamingPolicy.PascalCase` is new in Preview 3 and sits next to the existing `CamelCase`, `SnakeCaseLower`, `SnakeCaseUpper`, `KebabCaseLower`, and `KebabCaseUpper`. It is the policy you want when the .NET side already uses PascalCase properties and the JSON contract is also PascalCase, which is common for Azure management APIs, older SOAP-to-REST gateways, and some Microsoft Graph shapes:

```csharp
using System.Text.Json;

var options = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.PascalCase
};

var json = JsonSerializer.Serialize(
    new { firstName = "Ada", age = 37 },
    options);
// {"FirstName":"Ada","Age":37}
```

Before Preview 3 you either left the default (no policy) or wrote a one-line custom `JsonNamingPolicy` subclass. Now it matches the other presets and round-trips cleanly with the existing `JsonKnownNamingPolicy` enum.

## Overriding naming on a single member

The more interesting change is that `[JsonNamingPolicy]` is now a member-level attribute. Previously the policy lived on `JsonSerializerOptions` and applied to the whole graph, so one PascalCase exception on an otherwise camelCase contract meant either a `[JsonPropertyName]` override on every awkward property or a fully custom policy. In .NET 11 Preview 3 you can mix policies inside the same type:

```csharp
using System.Text.Json.Serialization;

public sealed class Webhook
{
    public string Url { get; set; } = "";

    [JsonNamingPolicy(JsonKnownNamingPolicy.KebabCaseLower)]
    public string RetryStrategy { get; set; } = "exponential";

    [JsonNamingPolicy(JsonKnownNamingPolicy.SnakeCaseLower)]
    public int MaxAttempts { get; set; } = 5;
}
```

With `PropertyNamingPolicy = JsonNamingPolicy.CamelCase`, `Url` serializes to `url`, `RetryStrategy` to `retry-strategy`, and `MaxAttempts` to `max_attempts`. That removes a lot of per-property `[JsonPropertyName]` noise when a single external system is inconsistent.

## Type-level [JsonIgnore] defaults

The companion change is that `[JsonIgnore(Condition = ...)]` is now legal on the type itself, not only on properties ([dotnet/runtime #124646](https://github.com/dotnet/runtime/pull/124646)). Put it on the class and the condition becomes the default for every property inside the type:

```csharp
using System.Text.Json.Serialization;

[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
public sealed class PatchRequest
{
    public string? Name { get; set; }
    public string? Email { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public bool? IsActive { get; set; }
}
```

Every nullable property on `PatchRequest` now drops out of the payload when null, which is exactly what a JSON Merge Patch request shape wants. The `IsActive` override opts back in because an explicit `false` is meaningful there. The same pattern used to require `JsonIgnoreCondition.WhenWritingNull` on every property individually or `DefaultIgnoreCondition` on the serializer options, which then forced every other DTO through the same rule.

## Why the small surface matters

Attribute-level control is what lets teams replace custom converters with stock `System.Text.Json`. PascalCase removes the last "write your own policy" reason, per-member naming deletes a class of `[JsonPropertyName]` boilerplate, and type-level `[JsonIgnore]` lets PATCH and event DTOs configure their default in one place. All three changes also work with the source generator, so Native AOT apps get them without any extra configuration. The [Preview 3 libraries notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/libraries.md) track the rest of the `System.Text.Json` updates shipping this month.

using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

var reflectionEnabled = JsonSerializer.IsReflectionEnabledByDefault;
Console.WriteLine($"Reflection enabled: {reflectionEnabled}");

var widget = new Widget(42, "Ada");
if (!reflectionEnabled)
{
    ExpectFailure("Default serialization", () => JsonSerializer.Serialize(widget));
    ExpectFailure("Empty options serialization", () =>
        JsonSerializer.Serialize(widget, new JsonSerializerOptions()));
}
else
{
    Equal("{\"Id\":42,\"Name\":\"Ada\"}", JsonSerializer.Serialize(widget));
    Console.WriteLine("Default serialization: passed");
}

string json = JsonSerializer.Serialize(widget, DemoJsonContext.Default.Widget);
Widget restored = JsonSerializer.Deserialize(json, DemoJsonContext.Default.Widget)!;
Equal("{\"Id\":42,\"Name\":\"Ada\"}", json);
Equal(widget, restored);
Console.WriteLine(json);
Console.WriteLine($"Round trip: {restored.Id} {restored.Name}");

var sourceGeneratedOptions = new JsonSerializerOptions
{
    TypeInfoResolver = DemoJsonContext.Default
};
Equal(json, JsonSerializer.Serialize(widget, sourceGeneratedOptions));
Console.WriteLine("Options resolver: passed");

var unconfigured = new JsonSerializerOptions();
ExpectFailure("Unconfigured MakeReadOnly", () => unconfigured.MakeReadOnly());
Equal(false, unconfigured.IsReadOnly);

var options = new JsonSerializerOptions
{
    TypeInfoResolver = DemoJsonContext.Default,
    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseUpper
};
options.MakeReadOnly();
options.MakeReadOnly(); // Repeated calls are safe.
Equal(true, options.IsReadOnly);
Console.WriteLine($"Frozen: {options.IsReadOnly}");
ExpectFailure("Frozen mutation", () => options.WriteIndented = true);

string frozenJson = JsonSerializer.Serialize(widget, options);
Equal("{\"ID\":42,\"NAME\":\"Ada\"}", frozenJson);
Console.WriteLine(frozenJson);

var copy = new JsonSerializerOptions(options);
Equal(false, copy.IsReadOnly);
Console.WriteLine($"Copy frozen: {copy.IsReadOnly}");
copy.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
string copyJson = JsonSerializer.Serialize(widget, copy);
Equal("{\"id\":42,\"name\":\"Ada\"}", copyJson);
Equal(true, copy.IsReadOnly); // Serialization also freezes options.
Console.WriteLine(copyJson);

var populate = new JsonSerializerOptions();
if (reflectionEnabled)
{
    populate.MakeReadOnly(populateMissingResolver: true);
    Equal(true, populate.IsReadOnly);
    Equal(true, populate.TypeInfoResolver is DefaultJsonTypeInfoResolver);
    Console.WriteLine("Populate missing resolver: reflection resolver");
}
else
{
    ExpectFailure("Populate missing resolver", () =>
        populate.MakeReadOnly(populateMissingResolver: true));
}

Console.WriteLine("All checks passed.");

static void ExpectFailure(string label, Action action)
{
    try
    {
        action();
    }
    catch (InvalidOperationException)
    {
        Console.WriteLine($"{label}: InvalidOperationException");
        return;
    }

    throw new Exception($"{label}: expected InvalidOperationException.");
}

static void Equal<T>(T expected, T actual)
{
    if (!EqualityComparer<T>.Default.Equals(expected, actual))
        throw new Exception($"Expected {expected}, observed {actual}.");
}

public sealed record Widget(int Id, string Name);

[JsonSerializable(typeof(Widget))]
internal partial class DemoJsonContext : JsonSerializerContext { }

using System.Runtime.CompilerServices;

var first = Accessors.Create();
var second = Accessors.Create("constructor value");
Expect(Accessors.GetProperty(first), "instance-property");
Expect(Accessors.GetProperty(second), "constructor value");
Expect(Accessors.CallInstance(first, 42), "instance-method:42");
Accessors.SetProperty(first, "updated");
Expect(Accessors.GetProperty(first), "updated");
Expect(Accessors.CallStatic(null, 42), "static-method:42");
Accessors.SetStaticProperty(null, "updated static");
Expect(Accessors.GetStaticProperty(null), "updated static");
Accessors.InstanceField(first) = 3;
Accessors.StaticField(null) = 4;
Expect(Accessors.InstanceField(first), 3);
Expect(Accessors.StaticField(null), 4);

// This demonstrates bypassing field access checks, not ordinary C# assignment.
// Observe through the accessor; do not infer general readonly/JIT guarantees.
var holder = new ReadonlyHolder();
Expect(Accessors.ReadonlyField(holder), 3);
Accessors.ReadonlyField(holder) = 42;
Expect(Accessors.ReadonlyField(holder), 42);
Console.WriteLine("PASS: constructors, instance/static members, field access, readonly accessor observation");

static void Expect<T>(T actual, T expected)
{
    if (!EqualityComparer<T>.Default.Equals(actual, expected))
        throw new InvalidOperationException($"Expected {expected}, got {actual}");
}

internal sealed class Foo
{
    private Foo() { }
    private Foo(string value) => InstanceProperty = value;
    private string InstanceProperty { get; set; } = "instance-property";
    private static string StaticProperty { get; set; } = "static-property";
    private int instanceField = 1;
    private static int staticField = 2;
    private string InstanceMethod(int value) => $"instance-method:{value}";
    private static string StaticMethod(int value) => $"static-method:{value}";
}

internal sealed class ReadonlyHolder
{
    public readonly int Value = 3;
}

internal static class Accessors
{
    [UnsafeAccessor(UnsafeAccessorKind.Constructor)]
    internal static extern Foo Create();
    [UnsafeAccessor(UnsafeAccessorKind.Constructor)]
    internal static extern Foo Create(string value);
    [UnsafeAccessor(UnsafeAccessorKind.Method, Name = "InstanceMethod")]
    internal static extern string CallInstance(Foo instance, int value);
    [UnsafeAccessor(UnsafeAccessorKind.Method, Name = "get_InstanceProperty")]
    internal static extern string GetProperty(Foo instance);
    [UnsafeAccessor(UnsafeAccessorKind.Method, Name = "set_InstanceProperty")]
    internal static extern void SetProperty(Foo instance, string value);
    [UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "StaticMethod")]
    internal static extern string CallStatic(Foo? typeMarker, int value);
    [UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "get_StaticProperty")]
    internal static extern string GetStaticProperty(Foo? typeMarker);
    [UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "set_StaticProperty")]
    internal static extern void SetStaticProperty(Foo? typeMarker, string value);
    [UnsafeAccessor(UnsafeAccessorKind.Field, Name = "instanceField")]
    internal static extern ref int InstanceField(Foo instance);
    [UnsafeAccessor(UnsafeAccessorKind.StaticField, Name = "staticField")]
    internal static extern ref int StaticField(Foo? typeMarker);
    [UnsafeAccessor(UnsafeAccessorKind.Field, Name = "Value")]
    internal static extern ref int ReadonlyField(ReadonlyHolder instance);
}

using System.Reflection;
using System.Runtime.CompilerServices;
using BenchmarkDotNet.Attributes;

namespace RestoredExamples;

[MemoryDiagnoser]
public class AccessBenchmarks
{
    private readonly Target _instance = new();
    private static readonly MethodInfo Method = typeof(Target).GetMethod("PrivateMethod",
        BindingFlags.Instance | BindingFlags.NonPublic)!;
    private static readonly Func<Target, int, int> Delegate = Method.CreateDelegate<Func<Target, int, int>>();

    [Params(42)] public int Value { get; set; }

    [Benchmark(Baseline = true)] public int DirectAccess() => _instance.PublicMethod(Value);
    [Benchmark] public int UnsafeAccessor() => CallPrivate(_instance, Value);
    [Benchmark] public int Reflection() => (int)typeof(Target)
        .GetMethod("PrivateMethod", BindingFlags.Instance | BindingFlags.NonPublic)!
        .Invoke(_instance, [Value])!;
    [Benchmark] public int CachedReflection() => (int)Method.Invoke(_instance, [Value])!;
    [Benchmark] public int CachedDelegate() => Delegate(_instance, Value);

    [UnsafeAccessor(UnsafeAccessorKind.Method, Name = "PrivateMethod")]
    private static extern int CallPrivate(Target instance, int value);
}

public sealed class Target
{
    private readonly int _offset = 17;
    [MethodImpl(MethodImplOptions.NoInlining)]
    private int PrivateMethod(int value) => value + _offset;
    [MethodImpl(MethodImplOptions.NoInlining)]
    public int PublicMethod(int value) => value + _offset;
}

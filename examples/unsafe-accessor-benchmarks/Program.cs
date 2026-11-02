using BenchmarkDotNet.Running;
using RestoredExamples;

if (args is ["--verify"])
{
    var sample = new AccessBenchmarks { Value = 42 };
    var values = new[] { sample.DirectAccess(), sample.UnsafeAccessor(), sample.Reflection(),
        sample.CachedReflection(), sample.CachedDelegate() };
    if (values.Any(value => value != 59)) throw new InvalidOperationException("Call paths disagree");
    Console.WriteLine("PASS: all five call paths return 59");
    return;
}
BenchmarkSwitcher.FromAssembly(typeof(AccessBenchmarks).Assembly).Run(args);

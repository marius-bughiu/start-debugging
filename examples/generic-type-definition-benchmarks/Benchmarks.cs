using BenchmarkDotNet.Attributes;

namespace RestoredExamples;

public class GenericTypeBenchmarks
{
    private readonly Type _type = typeof(List<int>);
    [Benchmark] public Type GetGenericTypeDefinition() => _type.GetGenericTypeDefinition();
}

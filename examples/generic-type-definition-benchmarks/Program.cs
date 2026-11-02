using BenchmarkDotNet.Running;
using RestoredExamples;

if (args is ["--verify"])
{
    if (new GenericTypeBenchmarks().GetGenericTypeDefinition() != typeof(List<>))
        throw new InvalidOperationException("Unexpected generic type definition");
    Console.WriteLine("PASS: List<int> resolves to List<>");
    return;
}
BenchmarkSwitcher.FromAssembly(typeof(GenericTypeBenchmarks).Assembly).Run(args);

---
title: "xUnit v3 vs NUnit vs MSTest em 2026: qual você deve escolher?"
description: "Escolha xUnit v3 para projetos .NET novos, NUnit 4.6 se você vive no modelo de constraints dele, e MSTest 4 se você já usa. Uma comparação medida no .NET SDK 10.0.201 cobrindo os padrões de paralelismo, o ciclo de vida da classe de teste, as mensagens de falha das asserções e o conflito de versão do Microsoft.Testing.Platform que quebra o runner do NUnit."
pubDate: 2026-08-07
template: vs
tags:
  - "comparison"
  - "testing"
  - "xunit"
  - "nunit"
  - "mstest"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026"
translatedBy: "claude"
translationDate: 2026-08-07
---

Escolha **xUnit v3** para um projeto .NET novo em 2026. Ele paraleliza por padrão, suas mensagens de falha são as mais precisas dos três, e é o que o time do .NET usa. Escolha **NUnit 4.6** se sua suíte se apoia no modelo de constraints dele ou em `[Retry]`. Escolha **MSTest 4** se você já tem MSTest e não está sofrendo, porque a v4 fechou quase toda a lacuna.

Todos os números abaixo foram medidos no .NET SDK 10.0.201 (runtime 10.0.5) contra xunit.v3 3.2.2, NUnit 4.6.1 com NUnit3TestAdapter 5.1.0 e MSTest 4.3.3. Cada afirmação sobre comportamento neste artigo foi verificada rodando código, não lendo um changelog, porque boa parte do conhecimento herdado sobre esses três frameworks já está desatualizada.

## A matriz de recursos

| Comportamento (versões testadas) | xUnit v3 3.2.2 | NUnit 4.6.1 | MSTest 4.3.3 |
| --- | --- | --- | --- |
| Paralelo por padrão | Sim, entre coleções | Não, precisa optar | Não, precisa optar |
| Nova instância de classe por teste | Sim | Não, uma por fixture | Sim |
| Atributo de teste | `[Fact]` / `[Theory]` | `[Test]` / `[TestCase]` | `[TestMethod]` / `[DataRow]` |
| Exige atributo marcador de classe | Não | Não | Sim, `[TestClass]` |
| Estilo de asserção | `Assert.Equal` | Constraints, `Assert.That(x, Is...)` | `Assert.AreEqual`, `Assert.That` |
| Mostra a expressão que falhou | Não | Sim | Sim |
| `Assert.Multiple` | Sim | Sim | Não |
| Atributo de retry embutido | Não | Sim, `[Retry(n)]` | Sim, `[Retry(n)]` |
| Tipo de projeto | Exe, sempre | Exe ao usar o runner do NUnit | Exe ao usar o runner do MSTest |
| Microsoft.Testing.Platform | Nativo, embutido | Via adaptador 5.0+ | Nativo desde a 3.2 |
| Alvo mínimo | .NET 8 / .NET Framework 4.7.2 | .NET 6 / .NET Framework 4.6.2 | .NET 8 / .NET Framework 4.6.2 |

Duas linhas dessa tabela contradizem o que a maioria das comparações diz. Ambas merecem uma seção própria.

## A afirmação sobre ciclo de vida da instância que está errada em todo lugar

A frase mais repetida nesta comparação é que o xUnit cria uma instância nova da classe de teste por teste, enquanto NUnit e MSTest reaproveitam uma única instância. Metade disso é falsa. O MSTest sempre construiu uma instância nova por método de teste.

Aqui está a sonda, idêntica nos três projetos exceto pelos atributos:

```csharp
// MSTest 4.3.3, .NET 10.0.201
[TestClass]
public class LifecycleTests
{
    private static int _instances;
    private readonly int _id;
    public LifecycleTests() { _id = Interlocked.Increment(ref _instances); }

    private void Record(string n) =>
        File.AppendAllText(Log, $"{n} ctorId={_id} totalInstances={_instances}");

    [TestMethod] public void A() => Record("A");
    [TestMethod] public void B() => Record("B");
    [TestMethod] public void C() => Record("C");
}
```

Rodando cada um dos três:

```text
# xunit.v3 3.2.2
A ctorId=3 totalInstances=3
B ctorId=1 totalInstances=1
C ctorId=2 totalInstances=2

# MSTest 4.3.3
A ctorId=1 totalInstances=1
B ctorId=2 totalInstances=2
C ctorId=3 totalInstances=3

# NUnit 4.6.1
A ctorId=1 totalInstances=1
B ctorId=1 totalInstances=1
C ctorId=1 totalInstances=1
```

xUnit e MSTest construíram três instâncias cada. O NUnit construiu uma e compartilhou. O NUnit é o ponto fora da curva, e é o único dos três em que um campo de instância mutável vaza estado de um teste para o próximo.

Isso importa mais do que parece. Uma única instância por fixture é exatamente o cenário em que uma suíte dependente de ordem cresce silenciosamente, e combina mal com paralelismo: campos de instância viram estado mutável compartilhado no instante em que dois testes do mesmo fixture rodam simultaneamente. A própria documentação do NUnit diz isso, e oferece a saída, adicionada lá no NUnit 3.13:

```csharp
// NUnit 4.6.1
[FixtureLifeCycle(LifeCycle.InstancePerTestCase)]
public class LifecycleTests { /* ... */ }
```

Com esse atributo aplicado, a mesma sonda imprime `ctorId=1`, `2`, `3`. Se você está no NUnit e pretende ligar o paralelismo, aplique isso no nível do assembly antes. Note que `OneTimeSetUp` e `OneTimeTearDown` precisam virar `static` quando você fizer isso, já que agora rodam uma vez para um fixture que não tem instância única.

## O benchmark de paralelismo

Essa é a única diferença real de desempenho, e é inteiramente sobre padrões.

**Montagem**: quatro classes de teste, cinco testes cada, cada teste com `Thread.Sleep(200)`. Vinte testes, então uma execução estritamente sequencial tem piso de 4,0 segundos e uma execução perfeitamente paralela por classe tem piso de 1,0 segundo. Build em Release, executado como o executável de testes direto pelo Microsoft.Testing.Platform, tempo de relógio sobre três execuções após aquecimento, Intel Core Ultra 7 265KF (20 núcleos, 20 lógicos), Windows 11, .NET SDK 10.0.201.

| Framework | Configuração padrão | Com paralelismo por classe ligado |
| --- | --- | --- |
| xunit.v3 3.2.2 | 1,29 - 1,32 s | 1,29 - 1,32 s (já é o padrão) |
| NUnit 4.6.1 | 4,71 - 4,73 s | 1,53 - 1,64 s |
| MSTest 4.3.3 | 4,80 - 4,89 s | 1,66 - 1,69 s |

Sem mexer em nada, o xUnit é 3,6 vezes mais rápido que o NUnit e 3,7 vezes mais rápido que o MSTest nesta suíte. Esse é o número que costuma ser citado. Também é enganoso, porque mede um padrão, não uma capacidade. Um único atributo no nível do assembly apaga quase tudo:

```csharp
// NUnit 4.6.1
[assembly: Parallelizable(ParallelScope.Fixtures)]
```

```csharp
// MSTest 4.3.3
[assembly: Parallelize(Workers = 0, Scope = ExecutionScope.ClassLevel)]
```

Com isso no lugar, os três ficam entre 1,29 e 1,69 segundo. A diferença residual de 240 a 380 ms é sobrecarga de inicialização do runner, não execução de teste: o xUnit v3 hospeda o Microsoft.Testing.Platform nativamente, enquanto o NUnit 4.6.1 chega até ele pela ponte VSTest do NUnit3TestAdapter, que custa um pouco mais na partida.

Então o enquadramento honesto é este. A vantagem do xUnit é que o padrão seguro também é o padrão rápido, e ele é seguro por causa do modelo de instância por teste. NUnit e MSTest exigem que você opte, e no NUnit você deveria corrigir o ciclo de vida do fixture primeiro. Se seu CI roda uma suíte MSTest de 12 minutos em série há três anos, a correção é uma linha, não uma migração.

## Mensagens de falha de asserção, lado a lado

Isso já foi uma goleada. Não é mais. As mesmas três falhas, saída real de cada runner:

```text
# xunit.v3 3.2.2
Assert.Equal() Failure: Strings differ
                  ↓ (pos 7)
Expected: "hello world"
Actual:   "hello wurld"
                  ↑ (pos 7)

Assert.Equal() Failure: Collections differ
                 ↓ (pos 2)
Expected: [1, 2, 3, 8]
Actual:   [1, 2, 4, 8]
                 ↑ (pos 2)
```

```text
# NUnit 4.6.1
Assert.That("hello wurld", Is.EqualTo("hello world"))
String lengths are both 11. Strings differ at index 7.
Expected: "hello world"
But was:  "hello wurld"
------------------^

Assert.That(actual, Is.EqualTo(expected))
Expected and actual are both <System.Int32[4]>
Values differ at index [2]
Expected: 3
But was:  4
```

```text
# MSTest 4.3.3
Assertion failed. Expected strings to be equal.
Strings have same length (11) and differ at 1 location(s). First difference at index 7.

expected: "hello world"
actual:   "hello wurld"

Assert.AreEqual("hello world", "hello wurld")
```

Os três apontam o índice exato. NUnit e MSTest 4 ainda ecoam a expressão de origem que falhou, o que o xUnit não faz, porque o MSTest 4 adicionou `CallerArgumentExpression` a todas as APIs de `Assert` e o NUnit tem isso desde a 4.0. O xUnit compensa com os marcadores visuais de posição, que são melhores para strings longas e coleções.

Onde o MSTest ainda fica atrás é no caso de coleções: `CollectionAssert.AreEqual` imprime "Element at index 2 do not match" sem mostrar nenhuma das duas sequências, então você ganha o índice mas não o formato da diferença. Se você compara coleções com frequência, isso é um incômodo real.

Dois detalhes de API que vale conhecer antes de escrever asserções no MSTest 4. `Assert.That` recebe uma `Expression<Func<bool>>`, não um `bool`, então `Assert.That(1 + 1 == 2)` não compila e `Assert.That(() => 1 + 1 == 2)` compila. E o MSTest não tem `Assert.Multiple`; tanto o xUnit v3 quanto o NUnit 4.6 têm.

## O detalhe que decide por você

Se você subir um projeto NUnit no SDK .NET 10.0.201 hoje com o runner nativo do NUnit, é isto que você recebe:

```text
error CS1705: Assembly 'NUnit3.TestAdapter' with identity 'NUnit3.TestAdapter, Version=5.1.0.0'
uses 'Microsoft.Testing.Platform, Version=1.8.1.0' which has a higher version than referenced
assembly 'Microsoft.Testing.Platform' with identity 'Microsoft.Testing.Platform, Version=1.7.3.0'
```

O NUnit3TestAdapter 5.1.0 é compilado contra o Microsoft.Testing.Platform 1.8.1, mas nada no grafo de pacotes declara essa dependência, então vence a versão que o SDK injeta: a 1.7.3. O projeto não compila. A correção é fixar você mesmo os dois assemblies da plataforma:

```xml
<!-- NUnit 4.6.1 + NUnit3TestAdapter 5.1.0 on .NET SDK 10.0.201 -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <OutputType>Exe</OutputType>
  <EnableNUnitRunner>true</EnableNUnitRunner>
  <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
</PropertyGroup>
<ItemGroup>
  <PackageReference Include="NUnit" Version="4.6.1" />
  <PackageReference Include="NUnit3TestAdapter" Version="5.1.0" />
  <PackageReference Include="Microsoft.Testing.Platform" Version="1.8.1" />
  <PackageReference Include="Microsoft.Testing.Extensions.VSTestBridge" Version="1.8.1" />
</ItemGroup>
```

As duas fixações são necessárias. Adicionar só `Microsoft.Testing.Platform` remove o erro mas deixa um aviso de conflito MSB3277 sobre `Microsoft.Testing.Extensions.VSTestBridge`. Com as duas, a compilação fica limpa.

Os projetos equivalentes de xUnit v3 e MSTest 4 não precisam fixar nada, porque os dois frameworks controlam sua dependência de plataforma de ponta a ponta:

```xml
<!-- xunit.v3 3.2.2 on .NET SDK 10.0.201: this is the whole file -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <OutputType>Exe</OutputType>
  <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
</PropertyGroup>
<ItemGroup>
  <PackageReference Include="xunit.v3" Version="3.2.2" />
</ItemGroup>
```

Essa única `PackageReference` é a história mais limpa das três. O runner do NUnit é uma ponte sobre o VSTest vestindo um casaco de MTP, e dá para sentir a costura. Isso também aparece na CLI: o xUnit v3 usa sua própria linguagem de consulta com um hífen só (`-filter "/*/*/FailingTests/*"`), enquanto o runner do NUnit aceita sintaxe do VSTest (`--filter "FullyQualifiedName~FailingTests"`) e o MSTest aceita consultas de grafo do MTP. Três frameworks numa plataforma, três dialetos de filtro.

## Onde cada um ainda vence

**Escolha xUnit v3 3.2.2 quando** você começa do zero no .NET 8 ou posterior. O modelo de instância por teste elimina uma categoria inteira de bugs dependentes de ordem antes que você consiga escrevê-los, o paralelismo está ligado sem você pedir, e a v3 trouxe adições genuinamente úteis: `Assert.Skip`/`Assert.SkipWhen` para pular em tempo de execução, `MatrixTheoryData`, fixtures de assembly via `[assembly: AssemblyFixture(...)]` e `[CaptureConsole]` para redirecionar um `Console.WriteLine` perdido para a saída do teste.

**Escolha NUnit 4.6.1 quando** seu time já pensa em constraints. `Assert.That(items, Has.Exactly(1).EqualTo(2).And.Length.EqualTo(3))` compõe de um jeito que nenhum dos outros iguala, e `[TestCase]`, `[Values]` e `[Combinatorial]` cobrem testes parametrizados de forma mais completa que `[Theory]` ou `[DataRow]`. Também é o único dos três que ainda suporta .NET 6, o que importa se você tem um projeto atrasado. Reserve tempo para a fixação de MTP acima e defina o ciclo de vida do fixture explicitamente.

**Escolha MSTest 4.3.3 quando** você já tem MSTest. A v4 é um release de verdade, não manutenção: `CallerArgumentExpression` em toda asserção, `Assert.ThrowsExactly`, `AssemblyFixtureProvider` para compartilhar a preparação de assembly entre projetos (novo na 4.3.0) e o isolamento por AppDomain agora desligado por padrão sob MTP, que a Microsoft mediu como até 30% mais rápido. A migração da v3 não é de graça, já que a v4 não é compatível em nível binário e abandona do .NET Core 3.1 ao .NET 7, mas os analisadores e as correções automáticas cuidam de quase todo o trabalho mecânico.

## O que eu faria

Projeto novo em 2026: xUnit v3. A configuração padrão é a configuração correta, que é exatamente a propriedade que você quer de um framework de testes, e o arquivo de projeto de um pacote só é difícil de contestar.

Suíte existente de NUnit ou MSTest: fique onde está. A diferença medida entre os três, depois de ligar o paralelismo, é de menos de 400 ms de sobrecarga de inicialização numa suíte de vinte testes. Isso não é orçamento de migração. Gaste a tarde adicionando `[assembly: Parallelizable(ParallelScope.Fixtures)]` (mais `[FixtureLifeCycle(LifeCycle.InstancePerTestCase)]`) ou `[assembly: Parallelize(...)]`, e você captura quase todo o ganho disponível.

A escolha de framework importa muito menos em 2026 do que importava em 2022, porque o Microsoft.Testing.Platform agora está embaixo dos três. O runner, os relatórios, a integração com CI e a CLI estão convergindo. O que resta escolher é o modelo de ciclo de vida e o dialeto de asserção, e essas são preferências com uma única consequência real de correção: a instância de fixture compartilhada do NUnit.

## Relacionado

- Se você está montando testes de ASP.NET Core, comece por [testes de integração com `WebApplicationFactory<T>`](/pt-br/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/), que funciona igual nos três frameworks.
- Para testes que precisam de um banco de dados real em vez de um dublê, veja [rodar testes de integração contra um SQL Server real com Testcontainers](/pt-br/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).
- Testes dependentes de tempo são a outra fonte comum de instabilidade: [testar com `TimeProvider` e `FakeTimeProvider`](/pt-br/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/).
- Do lado dos relatórios, [o Microsoft.Testing.Platform 2.3 coloca as falhas no diff do PR](/pt-br/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/) independentemente de qual framework as produziu.
- Mais dois padrões de teste que independem do framework: [testar código que usa `HttpClient`](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/) e [simular `DbContext` sem quebrar o rastreamento de mudanças](/pt-br/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/).

## Fontes

- [What's New in xUnit.net v3](https://xunit.net/docs/getting-started/v3/whats-new) e [Microsoft Testing Platform support in xUnit.net v3](https://xunit.net/docs/getting-started/v3/microsoft-testing-platform)
- [Documentação de contexto compartilhado do xUnit.net](https://xunit.net/docs/shared-context) sobre o modelo de instância por teste
- [Documentação de `FixtureLifeCycle` do NUnit](https://docs.nunit.org/articles/nunit/writing-tests/attributes/fixturelifecycle.html)
- [NUnit e Microsoft.Testing.Platform](https://docs.nunit.org/articles/vs-test-adapter/NUnit-And-Microsoft-Test-Platform.html)
- [Migração do MSTest v3 para v4](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-migration-v3-v4) e [ciclo de vida de testes do MSTest](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-writing-tests-lifecycle)
- [Microsoft.Testing.Platform: agora suportado por todos os principais frameworks de teste do .NET](https://devblogs.microsoft.com/dotnet/mtp-adoption-frameworks/)
- Versões de pacotes no NuGet: [xunit.v3 3.2.2](https://www.nuget.org/packages/xunit.v3), [NUnit 4.6.1](https://www.nuget.org/packages/NUnit), [MSTest 4.3.3](https://www.nuget.org/packages/MSTest)

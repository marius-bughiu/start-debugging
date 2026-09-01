---
title: "Migrar um projeto de testes do xUnit v2 para o xUnit v3 (de 2.9.3 para 4.0.0)"
description: "Migração passo a passo do xunit 2.9.3 para o xunit.v3 4.0.0: troca de pacotes, a mudança de OutputType para Exe, IAsyncLifetime retornando ValueTask, a remoção de Xunit.Abstractions e a sintaxe de filtro do CI que para de casar silenciosamente."
pubDate: 2026-09-01
template: migration
tags:
  - "migration"
  - "xunit"
  - "xunit-v3"
  - "testing"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
lang: "pt-br"
translationOf: "2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3"
translatedBy: "claude"
translationDate: 2026-09-01
---

Migrar um projeto de testes comum do `xunit` 2.9.3 para o `xunit.v3` 4.0.0 leva cerca de uma hora de trabalho mecânico: troque quatro referências de pacote, mude `OutputType` para `Exe`, apague todo `using Xunit.Abstractions;` e mude `IAsyncLifetime` de `Task` para `ValueTask`. O que realmente consome o dia é tudo ao redor do projeto de testes: um pacote de terceiros sem build para v3 vai quebrar a compilação com um erro de `FactAttribute` duplicado, e a sua expressão `dotnet test --filter` no CI vai parar de casar com qualquer coisa sem falhar o build. Vale a pena fazer a migração (v3 é a única linha recebendo recursos desde que a 2.9.3 saiu em janeiro de 2025), e ela é reversível até o momento em que você apagar a branch antiga. Tudo abaixo foi verificado contra o `xunit.v3` 4.0.0, publicado em 2026-08-15, nos SDKs do .NET 10 e .NET 11.

## Por que isso não é só uma troca de versão

- **A v2 está congelada em recursos.** A 2.9.3 (2025-01-08) é a última versão da v2. `TestContext`, timeouts com cancelamento de verdade, fixtures em nível de assembly, pulo dinâmico de testes e a linguagem de consulta de filtros existem apenas na v3.
- **Projetos de teste viram executáveis.** Um projeto v3 tem um ponto de entrada gerado e roda a si mesmo. Isso elimina por completo a classe de bugs de descompasso entre versão do runner e versão do framework, e é o que torna possíveis os builds de teste com Native AOT na 4.0.0.
- **`TestContext.Current.CancellationToken` torna os timeouts reais.** Na v2, um `[Fact(Timeout = ...)]` em um teste não assíncrono não conseguia interromper nada. Na v3 o token flui para o seu código, então uma chamada HTTP travada é de fato cancelada.
- **Microsoft.Testing.Platform é opcional, mas nativo.** O metapacote `xunit.v3` 4.0.0 resolve para `xunit.v3.mtp-v2`, que traz o MTP v2 junto. Você ganha `--report-trx`, saída CTRF e uma inicialização bem mais rápida sem um processo host do VSTest.

## O que quebra

| Área | Mudança | Severidade |
| ---- | ------- | ---------- |
| `xunit.abstractions` | O pacote e o namespace sumiram. `ITestOutputHelper` foi para `Xunit` | alta |
| Formato do projeto | `OutputType` precisa ser `Exe`; apenas projetos no formato SDK | alta |
| Framework de destino | O mínimo é `net472` ou `net8.0`. De `netcoreapp3.1` até `net7.0` ficaram de fora | alta |
| `IAsyncLifetime` | Herda de `IAsyncDisposable`; os dois métodos retornam `ValueTask`, não `Task` | alta |
| Testes `async void` | Falham imediatamente em tempo de execução em vez de rodar | alta |
| Pacotes de terceiros | Qualquer pacote que referencie `xunit.core` 2.x colide com `xunit.v3.core` | alta |
| Filtros de CI | Expressões `--filter` do VSTest não são suportadas sob o MTP | alta |
| `MemberDataAttribute` | `Parameters` virou `Arguments`; `ConvertDataItem` agora é `ConvertDataRow` | média |
| Atributos de ordenação / framework | `CollectionBehavior`, `TestCaseOrderer` e `TestFramework` recebem `Type`, não strings | média |
| `AssemblyTraitAttribute` | Removido. Use `[assembly: Trait(...)]` no lugar | baixa |
| `PropertyDataAttribute` | Removido (obsoleto desde a v1) | baixa |
| Descarte de recursos | Quando um fixture implementa `IDisposable` e `IAsyncDisposable`, só `DisposeAsync` é chamado | média |

As duas linhas para planejar são a de terceiros e a de CI. De todo o resto o compilador avisa.

## Checklist de pré-voo

- **SDK do .NET 8 ou posterior instalado.** O `xunit.v3` 4.0.0 tem como alvo `net472` e `net8.0`; não existe superfície `netstandard2.0` para o pacote principal.
- **Todos os projetos de teste estão no formato SDK.** Arquivos `.csproj` anteriores ao formato SDK não são suportados de jeito nenhum. Converta primeiro, em um commit separado.
- **Faça o inventário dos seus pacotes ligados ao xUnit.** Rode `dotnet list package --include-transitive | grep -i xunit` em cada projeto de teste e anote a lista. É essa lista que decide se a migração leva uma hora ou uma semana.
- **Saiba qual runner o seu CI usa.** Procure no pipeline por `dotnet test`, `--filter`, `--logger` e `vstest.console.exe`.
- **Crie uma branch.** Migre um projeto de teste primeiro, até passar pelo CI, antes de mexer nos demais.

## Passos da migração

1. **Mude o framework de destino do projeto de testes e transforme-o em executável.**

   Suba `TargetFramework` para `net8.0` ou posterior e defina `OutputType`. O ponto de entrada gerado vem do pacote; você não escreve um `Main`.

   ```xml
   <!-- MyApp.Tests.csproj, .NET 10 SDK, xunit.v3 4.0.0 -->
   <PropertyGroup>
     <TargetFramework>net10.0</TargetFramework>
     <OutputType>Exe</OutputType>
     <Nullable>enable</Nullable>
     <ImplicitUsings>enable</ImplicitUsings>
   </PropertyGroup>
   ```

   Verifique: `dotnet build` falha por tipos do xUnit ausentes, não por erros de formato de projeto. Se você já tem instruções de nível superior no projeto de testes, defina `<XunitAutoGeneratedEntryPoint>false</XunitAutoGeneratedEntryPoint>` e assuma o ponto de entrada você mesmo.

2. **Troque as referências de pacote.**

   O mapeamento de v2 para v3 é um para um, exceto que `xunit.abstractions` some e `xunit.console` não tem sucessor.

   ```xml
   <!-- before: xunit 2.9.3 -->
   <ItemGroup>
     <PackageReference Include="xunit" Version="2.9.3" />
     <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
     <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />
   </ItemGroup>

   <!-- after: xunit.v3 4.0.0 -->
   <ItemGroup>
     <PackageReference Include="xunit.v3" Version="4.0.0" />
     <PackageReference Include="xunit.runner.visualstudio" Version="4.0.0" />
     <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />
   </ItemGroup>
   ```

   O `xunit.v3` 4.0.0 resolve para `xunit.v3.mtp-v2`, que traz `xunit.v3.core.mtp-v2`, `xunit.v3.assert` e `xunit.analyzers` 2.0.0. Mantenha `xunit.runner.visualstudio` 4.0.0 e `Microsoft.NET.Test.Sdk` por enquanto: o pacote do runner lida com v1, v2 e v3, então o Test Explorer e o VSTest continuam funcionando enquanto você migra o resto da solução. Se você usa Central Package Management, faça isso no `Directory.Packages.props`, que é justamente o motivo de [mover uma solução para o Directory.Packages.props](/pt-br/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/).

   Verifique: `dotnet restore` conclui sem avisos NU1605 de downgrade e sem erros de tipo duplicado.

3. **Apague todo `using Xunit.Abstractions;`.**

   `ITestOutputHelper` agora mora em `Xunit`, ao lado de `Fact` e `Assert`, então na maioria dos arquivos a correção é apagar uma linha.

   ```csharp
   // xunit.v3 4.0.0 - no Xunit.Abstractions anywhere
   using Xunit;

   public class OrderServiceTests(ITestOutputHelper output)
   {
       [Fact]
       public void Prices_include_tax()
       {
           output.WriteLine("running");   // v3 also adds Write(), not just WriteLine()
           Assert.Equal(120m, new OrderService().Total(100m));
       }
   }
   ```

   Verifique: `grep -rn "Xunit.Abstractions" .` não retorna nada dentro dos seus projetos de teste.

4. **Converta as implementações de `IAsyncLifetime` para `ValueTask`.**

   Essa é a mudança que as pessoas erram, porque o erro do compilador aponta para o tipo de retorno e esconde a semântica de descarte atrás dele. `IAsyncLifetime` agora herda de `IAsyncDisposable`, e os dois membros retornam `ValueTask`.

   ```csharp
   // v2: xunit 2.9.3
   public class DbFixture : IAsyncLifetime
   {
       public Task InitializeAsync() => _container.StartAsync();
       public Task DisposeAsync()    => _container.DisposeAsync().AsTask();
   }

   // v3: xunit.v3 4.0.0
   public class DbFixture : IAsyncLifetime
   {
       public ValueTask InitializeAsync() => new(_container.StartAsync());
       public ValueTask DisposeAsync()    => _container.DisposeAsync();
   }
   ```

   A armadilha: se o seu fixture implementa `IDisposable` **e** `IAsyncLifetime`, a v2 chamava `Dispose()` e a v3 não chama. Ela chama apenas `DisposeAsync()`, seguindo a orientação do .NET de invocar um ou outro. Qualquer limpeza que existia só em `Dispose()` para de rodar silenciosamente, o que costuma aparecer como um contêiner do Testcontainers vazado ou um diretório temporário não apagado, e não como um teste falhando. Mova essa limpeza para `DisposeAsync()`. Isso importa principalmente no padrão de um contêiner por fixture dos [testes de integração contra um SQL Server real com Testcontainers](/pt-br/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).

   Verifique: rode a suíte e confirme que não sobraram contêineres órfãos com `docker ps -a`.

5. **Corrija os testes `async void` e as renomeações mecânicas de atributos.**

   A v3 faz os testes `async void` falharem imediatamente em tempo de execução em vez de dispará-los sem aguardar, então mude a assinatura para `async Task`. É o mesmo raciocínio apresentado em [async void vs async Task em C#](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/), só que agora o framework impõe. Depois aplique as conversões de atributo de string para `Type`:

   ```csharp
   // v2
   [assembly: CollectionBehavior("MyTests.MyCollectionFactory", "MyTests")]
   [assembly: AssemblyTrait("Category", "Integration")]

   // v3, xunit.v3 4.0.0
   [assembly: CollectionBehavior(typeof(MyCollectionFactory))]
   [assembly: Trait("Category", "Integration")]
   ```

   `TestCaseOrdererAttribute`, `TestCollectionOrdererAttribute` e `TestFrameworkAttribute` recebem o mesmo tratamento. `MemberDataAttribute.Parameters` agora é `Arguments`, e se você criou uma subclasse de `MemberDataAttributeBase`, `ConvertDataItem` virou `ConvertDataRow` e retorna `ITheoryDataRow` em vez de `object[]`.

   Verifique: `dotnet build` sai limpo, exceto pelos avisos `xUnit1051`, que são o assunto do próximo passo.

6. **Faça o `TestContext.Current.CancellationToken` passar pelos seus `await`.**

   O `xunit.analyzers` 2.0.0 emite `xUnit1051` em toda chamada que aceita um `CancellationToken` e não recebe nenhum. É um aviso, não um erro, e você pode migrar sem tocar nisso, mas o token é a maior parte do motivo para estar na v3.

   ```csharp
   // xunit.v3 4.0.0 - the token cancels when the test times out or the run is aborted
   [Fact(Timeout = 5000)]
   public async Task Fetches_the_order()
   {
       var ct = TestContext.Current.CancellationToken;
       var response = await _client.GetAsync("/orders/1", ct);
       Assert.Equal(HttpStatusCode.OK, response.StatusCode);
   }
   ```

   Verifique: `dotnet build -warnaserror:xUnit1051` passa depois que você terminar, ou deixe como aviso e volte depois.

7. **Aponte o CI para a nova sintaxe de filtro.**

   Depois decida se vai habilitar o Microsoft.Testing.Platform. Sob o MTP, o xUnit não aceita a linguagem de expressões `--filter` do VSTest; ele expõe `--filter-class`, `--filter-method`, `--filter-namespace`, `--filter-trait`, os equivalentes `--filter-not-*` e `--filter-query`. Nos SDKs do .NET 8 e 9 você opta por projeto:

   ```xml
   <!-- .NET 8/9 SDK -->
   <PropertyGroup>
     <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
   </PropertyGroup>
   ```

   No SDK do .NET 10 e posteriores você opta uma vez para o repositório inteiro:

   ```json
   // global.json
   {
     "test": { "runner": "Microsoft.Testing.Platform" }
   }
   ```

   E o filtro em si muda de forma:

   ```bash
   # before, VSTest
   dotnet test --filter "Category!=Integration"

   # after, MTP with xunit.v3 4.0.0
   dotnet test -- --filter-not-trait "Category=Integration"
   ```

   Verifique: rode o comando filtrado e confirme que a contagem de testes reportada é menor que a contagem sem filtro. Não confie em um build verde aqui, porque um filtro que não casa com nada sai com código zero.

## Verifique a migração

Rode estes na ordem, e trate qualquer surpresa na contagem de testes como falha mesmo quando o código de saída for zero.

- `dotnet build -c Release` sem avisos além dos que você já triou.
- `dotnet run --project MyApp.Tests -- --list` para confirmar que a descoberta encontra o número de testes que você espera.
- `dotnet test` e compare o total com a última execução na v2. Uma queda quase sempre significa um filtro ou um teste `async void` ignorado.
- Abra o Test Explorer uma vez. Se os testes rodam pela linha de comando mas o Visual Studio trava, isso é o [travamento do Test Explorer em projetos xUnit v3](/pt-br/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/), não uma migração ruim.
- Confira seus números de cobertura. O Coverlet se acopla de forma diferente sob o MTP, e um relatório de cobertura que de repente marca 0% é um problema de configuração, não uma regressão.

## Rollback

Essa migração é totalmente reversível: são referências de pacote mais edições de código-fonte, sem estado em disco e sem esquema de banco de dados. Um `git revert` do commit faz a suíte v2 rodar de novo, desde que você não tenha também baixado o framework de destino para menos que `net8.0` no mesmo commit. Mantenha a mudança de framework separada exatamente por isso. A parte sem volta é qualquer fork de terceiros que você tenha precisado publicar (veja abaixo), que continua útil de qualquer forma.

## Detalhes que vale conhecer antes de começar

**O erro de `FactAttribute` duplicado.** Se algum pacote no grafo ainda referencia `xunit.core` 2.x, você recebe:

```
error CS0433: The type 'FactAttribute' exists in both
'xunit.core, Version=2.4.2.0, Culture=neutral, PublicKeyToken=8d05b1bb7a6fdb6c' and
'xunit.v3.core, Version=4.0.0.0, Culture=neutral, PublicKeyToken=8d05b1bb7a6fdb6c'
```

Não existe truque de alias que valha a tentativa. Ou o pacote tem um build para v3 ou não tem. Em setembro de 2026: `Verify.XunitV3` 32.0.0, `AutoFixture.Xunit3` 4.19.0, `Xunit.DependencyInjection` 12.0.1 e `MartinCostello.Logging.XUnit.v3` 0.7.1 referenciam todos `xunit.v3.*` 4.x. O `Serilog.Sinks.XUnit` 3.0.19 ainda puxa `xunit.abstractions` 2.0.3 e `xunit.extensibility.core` 2.9.2, então é um bloqueio duro; a solução usual é um pequeno sink dentro do repositório que escreve direto no `ITestOutputHelper`, algo em torno de trinta linhas.

**`Xunit.SkippableFact` agora é peso morto.** Apague. A v3 tem `Assert.Skip(reason)`, `Assert.SkipWhen(condition, reason)` e `Assert.SkipUnless(condition, reason)`, além das propriedades `SkipWhen` e `SkipUnless` em `[Fact]` e `[Theory]` que apontam para uma propriedade pública estática `bool` da classe de teste. Definir `SkipWhen` e `SkipUnless` no mesmo atributo é uma falha em tempo de execução, não um erro de compilação.

**Instâncias de atributo ficam em cache na v3.** A v2 criava uma instância nova a cada consulta; a v3 mantém em cache, igual ao comportamento normal de reflexão do .NET. Atributos personalizados que mutavam o próprio estado entre descoberta e execução vão se comportar de outro jeito.

**Fixar versões na solução inteira.** O `xunit.v3` 4.0.0 fixa `xunit.v3.mtp-v2` em um intervalo exato `[4.0.0, 4.0.0]`, então versões misturadas entre projetos aparecem como conflitos de restore em vez de estranhezas em tempo de execução. Isso é um recurso, mas significa que você atualiza todos os projetos de teste em um commit só, ou nenhum.

**Implementações personalizadas de `ITestCaseOrderer` mudaram na 4.0.0**, não apenas entre v2 e v3. A ordenação agora roda por coleção, depois classe, depois método, depois caso, e existem pontos de extensão separados para ordenar classes e métodos. Se você levou um orderer da v2 sem mudanças até a v3.2.2, a 4.0.0 é onde ele para de compilar.

**`WebApplicationFactory<T>` não precisa de mudanças.** Os testes de integração do ASP.NET Core migram sem atrito; o padrão de fixture de [testes de integração com WebApplicationFactory](/pt-br/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) funciona como está assim que `IAsyncLifetime` retorna `ValueTask`.

## Relacionado

- [xUnit v3 vs NUnit vs MSTest em 2026: qual escolher?](/pt-br/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/)
- [Fix: o Test Explorer do Visual Studio trava em um projeto xUnit v3 enquanto o dotnet test passa](/pt-br/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/)
- [Microsoft.Testing.Platform 2.3 coloca as falhas de teste no diff do PR](/pt-br/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/)
- [Como escrever testes de integração com WebApplicationFactory no ASP.NET Core 11](/pt-br/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)
- [Migrar uma solução .NET para Central Package Management com Directory.Packages.props](/pt-br/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)

## Fontes

- [Migrating Unit Tests from v2 to v3](https://xunit.net/docs/getting-started/v3/migration) -- xUnit.net
- [What's New in v3?](https://xunit.net/docs/getting-started/v3/whats-new) -- xUnit.net
- [Microsoft Testing Platform (xUnit.net v3)](https://xunit.net/docs/getting-started/v3/microsoft-testing-platform) -- xUnit.net
- [Notas de versão do xUnit.net v3 4.0.0](https://xunit.net/releases/v3/4.0.0) -- xUnit.net
- [Guia de migração do VSTest para o Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/migrating-vstest-microsoft-testing-platform) -- Microsoft Learn
- [xunit.v3 no NuGet](https://www.nuget.org/packages/xunit.v3/4.0.0) -- metadados do pacote e intervalos de dependências
- [Migrating from XUnit v2 to v3: troubleshooting](https://bartwullems.blogspot.com/2025/09/migrating-from-xunit-v2-to.html) -- Bart Wullems

---
title: "Correção: dotnet test termina com código 5 e \"Zero tests ran\" no Microsoft.Testing.Platform"
description: "O código de saída 5 significa que o MTP rejeitou uma opção de linha de comando, não que faltam testes. Execute o exe de teste diretamente para ver o erro real e então adicione o pacote da extensão ou direcione a opção por projeto."
pubDate: 2026-10-01
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "testing"
  - "microsoft-testing-platform"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform"
translatedBy: "claude"
translationDate: 2026-10-01
---

Se `dotnet test` imprime `Zero tests ran` seguido de `Exit code: 5`, seus testes nunca foram descobertos porque o aplicativo de teste recusou um dos argumentos que você passou. No Microsoft.Testing.Platform (MTP), o código de saída 5 significa "argumentos de linha de comando inválidos", e o `dotnet test` descarta a explicação. Execute o executável de teste compilado com os mesmos argumentos (`./bin/Debug/net10.0/MyTests --logger trx`) para ver a mensagem real. Depois, referencie o pacote de extensão que fornece a opção, substitua o flag da era VSTest pelo equivalente do MTP, ou direcione a opção apenas aos projetos que a entendem com `TestingPlatformCommandLineArguments`.

Tudo abaixo foi medido no SDK do .NET 10 10.0.302 e no SDK do .NET 11 RC 1 (11.0.100-rc.1.26425.128) em macOS arm64, com MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1), MSTest.Sdk 4.3.3 (MTP 2.3.3) e xunit.v3.mtp-v2 4.0.1, usando um `global.json` que muda o `dotnet test` para o modo MTP.

## O erro no contexto

Esta é a saída completa de `dotnet test --project MsTests --logger trx` no SDK 10.0.302 contra um projeto MSTest com dois testes perfeitamente válidos:

```text
MsTests/bin/Debug/net10.0/MsTests.dll (net10.0) Zero tests ran
Exit code: 5

Test run summary: Zero tests ran
  error: 1

  total: 0
  failed: 0
  succeeded: 0
  skipped: 0
  duration: 82ms
Test run completed with non-success exit code: 5 (see: https://aka.ms/testingplatform/exitcodes)
```

Note o que está faltando: o target framework é impresso como `(net10.0)` em vez de `(net10.0|arm64)` e não há linha `Running tests from ...`. O host de teste nunca chegou à descoberta de testes. Adicionar `--output Detailed`, `-v detailed` ou `--diagnostic` não traz o motivo de volta, e o arquivo `.diag` gravado por `--diagnostic` registra apenas a linha de comando bruta.

No SDK do .NET 11 RC 1, a linha de resumo muda para `Test run summary: Failed!` e uma nova seção `Handshake failures:` lista o módulo, mas o motivo continua sem ser impresso.

Em uma solução com vários projetos de teste, é mais fácil interpretar errado, porque um projeto falha e o outro passa:

```text
XTests/bin/Debug/net10.0/XTests.dll (net10.0) Zero tests ran
Exit code: 5
MsTests/bin/Debug/net10.0/MsTests.dll (net10.0|arm64) passed (848ms)
Test run summary: Failed!
  error: 1
  total: 2
```

## Por que o MTP retorna o código de saída 5 e diz que zero testes foram executados

Um projeto de teste MTP é um executável de console normal. No modo MTP, o `dotnet test` compila cada projeto de teste, inicia o executável, repassa todo argumento que ele mesmo não consome e conversa com o processo por um named pipe. O aplicativo de teste valida sua linha de comando antes de fazer qualquer outra coisa. Se alguma opção for desconhecida, ou se uma opção conhecida receber um valor inválido, ele termina com o código 5 e nunca descobre um único teste. A [tabela de códigos de saída do MTP](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-troubleshooting#exit-codes) define 5 como "os argumentos de linha de comando passados ao aplicativo de teste eram inválidos".

Então o `dotnet test` relata o módulo da mesma forma que relata qualquer módulo que não produziu resultados: `Zero tests ran`. O texto é tecnicamente verdadeiro e totalmente enganoso, porque faz você procurar atributos `[TestMethod]` ausentes ou um filtro quebrado.

As opções se tornam desconhecidas por quatro motivos, na ordem em que os vejo em pipelines reais:

1. **Um flag do VSTest sobreviveu à migração.** `--logger trx`, `--collect "XPlat Code Coverage"`, `--blame-hang-timeout 5m` e `--blame-crash` pertencem ao VSTest. O MTP não tem `--logger` nem `--collect`.
2. **O pacote de extensão está faltando.** O núcleo do MTP não traz relatores, cobertura, dumps nem retry. `--report-trx` só existe quando `Microsoft.Testing.Extensions.TrxReport` é referenciado, `--coverage` precisa de `Microsoft.Testing.Extensions.CodeCoverage`, e assim por diante.
3. **Frameworks misturados em uma solução.** O MSTest.Sdk habilita TRX e cobertura de código por padrão. Um projeto xUnit v3 simples não. A mesma linha de comando `dotnet test --solution` é válida para um projeto e inválida para o outro.
4. **Um valor ruim para uma opção válida.** `--settings` apontando para um arquivo que não existe no agente, ou `--timeout 30` sem sufixo de unidade.

O código de saída 8 é uma falha diferente que produz o mesmo texto `Zero tests ran`. Nesse caso, os argumentos estavam corretos e o aplicativo de teste executou a descoberta, mas nada correspondeu. Você distingue os dois pela linha `Exit code:` e pela presença ou não de `Running tests from ...`.

## Reprodução mínima

O `global.json` faz o `dotnet test` entrar no modo MTP (necessário no SDK do .NET 10 e posteriores; sem ele você continua na ponte VSTest):

```json
// .NET 10 SDK 10.0.302
{
  "sdk": { "version": "10.0.302" },
  "test": { "runner": "Microsoft.Testing.Platform" }
}
```

Um projeto MSTest usando o MSTest SDK:

```xml
<!-- MsTests/MsTests.csproj, MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1) -->
<Project Sdk="MSTest.Sdk/4.4.1">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
```

```csharp
// MsTests/Tests.cs, .NET 10, MSTest 4.4.1
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace MsTests;

[TestClass]
public class CalculatorTests
{
    [TestMethod]
    public void Adds() => Assert.AreEqual(4, 2 + 2);

    [TestMethod, TestCategory("Slow")]
    public void Multiplies() => Assert.AreEqual(6, 2 * 3);
}
```

E um projeto xUnit v3 ao lado dele:

```xml
<!-- XTests/XTests.csproj, xunit.v3.mtp-v2 4.0.1 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="xunit.v3.mtp-v2" Version="4.0.1" />
  </ItemGroup>
</Project>
```

Veja o que cada comando retornou no SDK 10.0.302:

| Comando | Código de saída | O que o resumo disse |
| --- | --- | --- |
| `dotnet test --project MsTests` | 0 | Passed, 2 testes |
| `dotnet test --project MsTests --logger trx` | 5 | Zero tests ran |
| `dotnet test --project MsTests --collect "XPlat Code Coverage"` | 5 | Zero tests ran |
| `dotnet test --project MsTests --blame-hang-timeout 5m` | 5 | Zero tests ran |
| `dotnet test --project MsTests --report-trx` | 0 | Passed, TRX gravado |
| `dotnet test --solution All.sln --report-trx` | 5 | MSTest passou, xUnit "Zero tests ran" |
| `dotnet test --solution All.sln --coverage` | 5 | MSTest passou, xUnit "Zero tests ran" |
| `dotnet test --solution All.sln --settings x.runsettings` (arquivo ausente) | 5 | ambos "Zero tests ran" |
| `dotnet test --project MsTests --filter "TestCategory=DoesNotExist"` | 8 | Zero tests ran (um real) |
| `dotnet test --project MsTests --minimum-expected-tests 5` | 9 | Violação da política de mínimo de testes esperados |

## Correção, em detalhe

### 1. Extraia a mensagem de erro real do aplicativo de teste

Execute você mesmo o executável compilado com os argumentos exatos que o CI passa. No Windows é `MsTests.exe`; no Linux e no macOS ele não tem extensão:

```bash
# .NET 10 SDK 10.0.302, MTP 2.4.1
./MsTests/bin/Debug/net10.0/MsTests --logger trx
```

```text
Unknown option '--logger'
Option '--logger' uses VSTest syntax, which is not supported by Microsoft.Testing.Platform.
Use '--report-trx' instead.
Run '--help' to see the options registered by this test application. If the option belongs to an extension, ensure its package is referenced and the extension is registered.
Command line: --logger trx
```

`dotnet run --project MsTests --no-build -- --logger trx` imprime a mesma coisa e também retorna 5. A dica "uses VSTest syntax ... Use '--report-trx' instead" é nova no MTP 2.4. O MTP 2.3.3 (MSTest.Sdk 4.3.3) imprime apenas `Unknown option '--logger'` seguido do texto de ajuda, o que ainda é suficiente.

Em seguida, pergunte ao aplicativo quais opções ele realmente tem. `--help` lista as opções da plataforma e, separadamente, as "Extension options" contribuídas pelos pacotes referenciados. `--info` imprime a versão da plataforma e cada extensão registrada com sua própria versão:

```bash
# .NET 10 SDK 10.0.302
./XTests/bin/Debug/net10.0/XTests --help
./XTests/bin/Debug/net10.0/XTests --info
```

Se a opção que você está passando não está nessa lista, ela vai falhar com o código de saída 5. Essa verificação única resolve a maioria desses chamados.

### 2. Substitua os flags do VSTest pelos equivalentes do MTP

| Argumento do VSTest | Argumento do MTP | Pacote que o fornece |
| --- | --- | --- |
| `--logger trx` | `--report-trx` | `Microsoft.Testing.Extensions.TrxReport` |
| `--logger trx;LogFileName=x.trx` | `--report-trx --report-trx-filename x.trx` | `Microsoft.Testing.Extensions.TrxReport` |
| `--collect "Code Coverage"` | `--coverage` | `Microsoft.Testing.Extensions.CodeCoverage` |
| `--collect "XPlat Code Coverage"` | `--coverage --coverage-output-format cobertura` | `Microsoft.Testing.Extensions.CodeCoverage` |
| `--blame-hang-timeout 5m` | `--hangdump --hangdump-timeout 5m` | `Microsoft.Testing.Extensions.HangDump` |
| `--blame-crash` | `--crashdump` | `Microsoft.Testing.Extensions.CrashDump` |
| `--results-directory` | `--results-directory` | integrado |

No momento da escrita, as versões atuais são 2.4.1 para TrxReport, HangDump e CrashDump, e 18.11.2 para CodeCoverage. A [referência de opções de CLI do MTP](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-cli-options) traz o mapeamento completo. `--filter` mantém a sintaxe de expressão do VSTest para MSTest e NUnit, então normalmente não precisa mudar.

### 3. Referencie a extensão em todo projeto que recebe a opção

Na reprodução, o `--report-trx` aplicado à solução inteira falhou apenas porque o projeto xUnit não tinha o relator. Adicioná-lo corrigiu a execução:

```xml
<!-- XTests/XTests.csproj, xunit.v3.mtp-v2 4.0.1 -->
<ItemGroup>
  <PackageReference Include="xunit.v3.mtp-v2" Version="4.0.1" />
  <PackageReference Include="Microsoft.Testing.Extensions.TrxReport" Version="2.4.1" />
</ItemGroup>
```

```text
MsTests.dll (net10.0|arm64) passed (837ms)
XTests.dll (net10.0|arm64) passed (922ms)
Test run summary: Passed!
  total: 4
```

Se todo projeto de teste deve produzir TRX e cobertura, coloque as referências em um `Directory.Build.props` condicionado a `IsTestProject`, para que novos projetos as recebam automaticamente. Projetos MSTest.Sdk já as trazem, então adicione a condição `'$(UsingMSTestSdk)' != 'true'` se quiser evitar referências duplicadas.

### 4. Direcione opções por projeto com TestingPlatformCommandLineArguments

Às vezes você não quer a extensão em todo lugar. A cobertura de um projeto de testes de integração costuma ser ruído, e dumps só são úteis para o projeto que trava. Em vez de passar a opção na linha de comando do `dotnet test`, coloque-a no projeto que a entende:

```xml
<!-- MsTests/MsTests.csproj, MSTest.Sdk 4.4.1 -->
<Project Sdk="MSTest.Sdk/4.4.1">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <TestingPlatformCommandLineArguments>$(TestingPlatformCommandLineArguments) --coverage --coverage-output-format cobertura</TestingPlatformCommandLineArguments>
  </PropertyGroup>
</Project>
```

Com isso no lugar, um simples `dotnet test --solution All.sln` retornou o código de saída 0, o projeto xUnit rodou sem cobertura e o projeto MSTest gravou um `.cobertura.xml` em `TestResults`. A Microsoft documenta a mesma abordagem para [soluções com frameworks de teste ou extensões mistos](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test#solutions-with-mixed-test-frameworks-or-extensions). Mantenha `$(TestingPlatformCommandLineArguments)` no início para que os valores vindos de `Directory.Build.props` não sejam sobrescritos.

### 5. Valide os valores, não apenas os nomes

Se a opção aparece em `--help` e você ainda recebe o código de saída 5, o valor está errado. Na reprodução, `--settings x.runsettings` com um arquivo ausente fez os dois projetos falharem com o código de saída 5. Os caminhos são resolvidos a partir do diretório de trabalho do processo de teste, que no CI nem sempre é a raiz do repositório. Valores de tempo precisam de unidades no MTP: `--timeout 30m` funciona, um número puro não.

## Código de saída 8: quando zero testes realmente foram executados

Se o código de saída é 8, os argumentos foram aceitos e o filtro ou o projeto simplesmente não produziu testes. O MTP trata isso como falha por padrão, ao contrário do VSTest, que retornava 0. Você tem três alavancas:

```bash
# .NET 10 SDK 10.0.302, MTP 2.4.1

# Accept an empty run for this invocation (returns 0)
dotnet test --project MsTests --filter "TestCategory=Nightly" --ignore-exit-code 8

# Or demand a floor: fewer than 50 tests returns exit code 9
dotnet test --solution All.sln --minimum-expected-tests 50
```

`--ignore-exit-code` também lê a variável de ambiente `TESTINGPLATFORM_EXITCODE_IGNORE`, útil quando o mesmo filtro roda em muitos pipelines. Use com moderação: um filtro que silenciosamente não corresponde a nada é exatamente o bug que o código de saída 8 foi projetado para capturar.

A versão do SDK importa em execuções com vários projetos. No SDK 10.0.302, uma execução de solução em que um projeto correspondeu ao filtro e o outro não correspondeu a nada retornou 8 para a execução inteira. No SDK do .NET 11 RC 1, o comando idêntico retornou 0 com `Test run summary: Passed!`, ainda imprimindo `Exit code: 8` ao lado do módulo vazio. Esse é o novo [veredito de zero testes para a execução inteira](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-mtp) no SDK do .NET 11. Se o seu CI fica vermelho no .NET 10 e verde no .NET 11 com o mesmo filtro, é por isso. O código de saída 5 não mudou: ambos os SDKs falham a execução inteira quando qualquer módulo rejeita seus argumentos.

## Armadilhas e casos parecidos

- **`error: 1` no resumo é o módulo, não um teste.** Ele conta módulos que terminaram de forma anormal. `failed: 0` permanece em zero porque nenhum teste foi executado.
- **`dotnet test -- --some-option` não ajuda.** No modo MTP os argumentos são repassados de qualquer forma, então o traço duplo não os esconde do aplicativo de teste.
- **Um filtro do MTP que não corresponde a nada retorna 8, não 5.** Se você vê `Running tests from ...` antes de `Zero tests ran`, seus argumentos estavam corretos. Verifique a sintaxe do filtro para o framework.
- **`--zero-tests-policy strict` não mudou minha execução com todos os testes ignorados.** A documentação diz que strict trata testes ignorados como não executados. No MTP 2.4.1, um projeto cujo único teste tinha `[Ignore]` ainda retornou 0 sob strict, então não confie nele como sua única proteção. `--minimum-expected-tests` é explícito e confiável.
- **"No test projects were found" é um problema diferente.** Esse vem da avaliação do projeto (tipicamente `--no-restore` em uma etapa de contêiner sem a pasta `obj`), não do aplicativo de teste. A página de troubleshooting do MTP cobre esse caso.
- **O Test Explorer pode mostrar sua própria versão disso.** Se a CLI está verde e o Visual Studio trava no xUnit v3, isso é uma incompatibilidade de runner, não um problema de argumentos.

## Relacionado

- A [migração passo a passo do VSTest para o Microsoft.Testing.Platform](/pt-br/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/) cobre o restante das mudanças de CI, incluindo `.runsettings` para `testconfig.json`.
- Se o Visual Studio trava enquanto a CLI passa, veja [Test Explorer travando no xUnit v3 enquanto o dotnet test passa](/pt-br/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/).
- Escolhendo um framework para uma nova solução, com o suporte a MTP comparado: [xUnit v3 vs NUnit vs MSTest em 2026](/pt-br/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/).
- Levando primeiro um projeto xUnit mais antigo para o MTP: [migrar um projeto de teste do xUnit v2 para o xUnit v3](/pt-br/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/).
- Obtendo falhas anotadas diretamente nos pull requests: [anotações do GitHub Actions no Microsoft.Testing.Platform 2.3](/pt-br/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/).

## Fontes

- [Microsoft.Testing.Platform troubleshooting: exit codes and unrecognized extension options](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-troubleshooting)
- [Microsoft.Testing.Platform CLI options reference](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-cli-options)
- [Testing with dotnet test: solutions with mixed test frameworks or extensions](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test#solutions-with-mixed-test-frameworks-or-extensions)
- [dotnet test in MTP mode, including whole-run minimums](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-mtp)
- [microsoft/testfx repository (MSTest and Microsoft.Testing.Platform)](https://github.com/microsoft/testfx)

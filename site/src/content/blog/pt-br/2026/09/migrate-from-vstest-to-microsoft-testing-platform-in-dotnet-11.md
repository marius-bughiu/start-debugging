---
title: "Migrar do VSTest para o Microsoft.Testing.Platform no SDK do .NET 11"
description: "Uma migração passo a passo do VSTest para o Microsoft.Testing.Platform 2.3.3: o opt-in de OutputType Exe, a troca de runner no global.json, loggers virando reporters, .runsettings virando testconfig.json e os códigos de saída que deixam vermelho um job de CI que estava verde."
pubDate: 2026-09-02
template: migration
tags:
  - "migration"
  - "vstest"
  - "microsoft-testing-platform"
  - "testing"
  - "dotnet-11"
  - "dotnet"
  - "ci-cd"
lang: "pt-br"
translationOf: "2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-02
---

Migrar uma solução do VSTest para o Microsoft.Testing.Platform (MTP) é meio dia de trabalho nos arquivos de projeto e um dia inteiro na CI. A parte do projeto são três linhas por projeto de teste: `<OutputType>Exe</OutputType>`, uma propriedade de opt-in para o seu framework de testes e um `global.json` que define `"runner": "Microsoft.Testing.Platform"`. O que realmente consome tempo é tudo o que vem depois: cada flag `--logger`, `--collect` e `--blame` do seu pipeline mapeia para uma opção diferente que só existe se você também adicionar um pacote NuGet, seu arquivo `.runsettings` perde quase todo o sentido, e um projeto de teste que executa zero testes agora quebra o build com o código de saída 8 em vez de passar. Este guia foi escrito contra o SDK do .NET 11 (Preview 7, agosto de 2026), Microsoft.Testing.Platform 2.3.3, MSTest 4.3.3, NUnit3TestAdapter 6.3.0 e xunit.v3 4.0.0.

## Por que vale a pena fazer a troca agora

- **É para onde tudo está indo.** O MSTest tem o próprio runner de MTP desde a 3.2.0, o NUnit desde o NUnit3TestAdapter 5.0.0, e o xUnit v3 foi construído sobre o MTP desde o início. O VSTest está em manutenção: a mudança mais visível que ele recebeu neste ano foi [remover a dependência do Newtonsoft.Json](/pt-br/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/).
- **Os módulos de teste rodam em paralelo por padrão.** O VSTest serializa os assemblies a menos que você brigue com ele. O MTP executa até `Environment.ProcessorCount` módulos de teste ao mesmo tempo, limitado por `--max-parallel-test-modules`.
- **Sem runner externo.** O projeto de teste é um executável. `./MyApp.Tests` roda a suíte sem `vstest.console.exe`, sem `dotnet test` e sem uma passada de descoberta de adaptadores. Isso importa para imagens de contêiner e para reproduzir localmente uma falha de CI.
- **Políticas em nível de execução que antes você precisava programar.** `--timeout`, `--maximum-failed-tests`, `--minimum-expected-tests` e `--ignore-exit-code` são de primeira classe, e as três últimas existem justamente porque a CI precisa delas.

## O que quebra

| Área | Mudança | Severidade |
| --- | --- | --- |
| Formato do projeto | Projetos de teste precisam definir `<OutputType>Exe</OutputType>` | alta |
| Consistência da solução | Com o MTP habilitado no `global.json`, **todos** os projetos de teste precisam usar MTP. Uma solução mista é um erro, não um aviso | alta |
| `--logger` | Renomeado para "reporters". `--logger trx` vira `--report-trx` e exige `Microsoft.Testing.Extensions.TrxReport` | alta |
| `--collect "Code Coverage"` | Vira `--coverage`, exige `Microsoft.Testing.Extensions.CodeCoverage`, e `IncludeTestAssembly` agora tem padrão `false` | alta |
| `--blame-crash` / `--blame-hang` | Viram `--crashdump` / `--hangdump` em pacotes separados. `--blame-crash-collect-always` não tem equivalente | média |
| Zero testes executados | O VSTest retorna 0. O MTP retorna o código de saída 8 | alta |
| `.runsettings` | Suportado apenas pelas pontes VSTest do MSTest e do NUnit. A plataforma em si lê `testconfig.json` | média |
| `dotnet test MyTests.csproj` | Caminhos de projeto posicionais acabaram. Use `--project`, `--solution` ou `--test-modules` | média |
| Filtros do xUnit | `--filter` não está implementado. Use `--filter-class`, `--filter-method`, `--filter-namespace`, `--filter-trait`, `--filter-query` | alta (só xUnit) |
| `RunConfiguration.TargetPlatform=x86` | Vira `--arch x86` | baixa |
| Codificação do console | O MTP sempre define UTF-8. O modo de isolamento padrão do VSTest não fazia isso | baixa |

As duas linhas que determinam o seu cronograma são a da consistência da solução e a do `--logger`. Do resto a ferramenta te avisa.

## Checklist de pré-voo

- **SDK do .NET 10 ou posterior.** A seleção de runner chegou no SDK do .NET 10. No .NET 9 e anteriores você fica preso à ponte `TestingPlatformDotnetTestSupport` e a um separador `--` obrigatório.
- **MTP 1.7 ou posterior** em todo projeto de teste. A integração do MTP com `dotnet test` só é suportada da 1.7 em diante; 2.3.3 é a versão estável atual.
- **Inventarie o pipeline primeiro.** Use grep na sua CI atrás de `dotnet test`, `vstest.console`, `--logger`, `--collect`, `--blame`, `--settings` e `--filter`. Esse grep é a sua lista de trabalho real.
- **Encontre todo `.runsettings`.** Rode `find . -name "*.runsettings"` e leia cada um. Tudo sob `DataCollectionRunSettings` vira uma opção de CLI ou desaparece.
- **Conheça seus frameworks.** Uma solução com projetos MSTest e xUnit juntos precisa de roteamento de argumentos por projeto (veja o passo 6). Descubra agora, não quando a CI falhar com o código de saída 5.
- **Migre um projeto de ponta a ponta primeiro**, passando por uma execução real de CI, antes de mexer no resto.

## Passos da migração

1. **Fixe o SDK e selecione o runner no `global.json`.**

   A seleção de runner é uma decisão no nível do repositório, não por projeto.

   ```json
   // global.json - .NET 11 SDK
   {
     "sdk": {
       "version": "11.0.100",
       "rollForward": "latestFeature"
     },
     "test": {
       "runner": "Microsoft.Testing.Platform"
     }
   }
   ```

   `VSTest` é o outro valor válido e continua sendo o padrão quando a seção `test` está ausente. No SDK do .NET 11 você também pode sobrescrever isso por shell com a variável de ambiente `DOTNET_TEST_RUNNER`, que é o jeito mais rápido de comparar duas configurações de um job de CI sem editar um arquivo versionado.

   Verifique: `dotnet test --help` agora lista `--project`, `--solution` e `--test-modules`. Se ainda listar `--logger` e `--collect`, a troca de runner não fez efeito.

2. **Transforme todo projeto de teste em um executável.**

   Este é o opt-in universal, independentemente do framework. Coloque no `Directory.Build.props` ao lado dos seus projetos de teste em vez de repetir.

   ```xml
   <!-- tests/Directory.Build.props - .NET 11 SDK, MTP 2.3.3 -->
   <Project>
     <PropertyGroup>
       <OutputType>Exe</OutputType>
     </PropertyGroup>
   </Project>
   ```

   Você não escreve um `Main`. O `Microsoft.Testing.Platform.MSBuild`, que todo framework compatível com MTP traz transitivamente, gera um `TestingPlatformEntryPoint` para você.

   Verifique: `dotnet build` produz um executável `MyApp.Tests` (ou `.exe`) na pasta de saída, e executá-lo diretamente roda a suíte.

3. **Ligue o runner do seu framework de testes.**

   Cada framework tem a própria propriedade, e as versões mínimas são diferentes.

   ```xml
   <!-- tests/Directory.Build.props - pick the one that matches your framework -->
   <PropertyGroup>
     <!-- MSTest 3.2.0+, current 4.3.3 -->
     <EnableMSTestRunner>true</EnableMSTestRunner>

     <!-- NUnit3TestAdapter 5.0.0+, current 6.3.0 -->
     <EnableNUnitRunner>true</EnableNUnitRunner>

     <!-- xunit.v3 1.0.1+, current 4.0.0 -->
     <UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner>
   </PropertyGroup>
   ```

   Projetos MSTest podem pular a propriedade por completo trocando o SDK do projeto para `MSTest.Sdk`, onde o MTP já vem ligado. O xunit.v3 4.0.0 resolve para a variante de pacote do MTP v2; a linha 3.x usava MTP v1 por padrão, o que a 4.0.0 removeu. Se você ainda está no xUnit v2 não existe caminho oficial para o MTP, então faça antes a [migração de v2 para v3](/pt-br/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/).

   Verifique: rode o executável de testes com `--help`. Você deve ver as opções da plataforma (`--filter-uid`, `--timeout`, `--list-tests`) mais o que o seu framework registrar.

4. **Apague as propriedades ponte da era .NET 9.**

   Muitos posts de blog e até partes da página do MSTest no MS Learn ainda mostram essas. No SDK do .NET 10 ou 11 com seleção de runner via `global.json` elas estão obsoletas e devem ser removidas:

   ```xml
   <!-- delete these from every test project and Directory.Build.props -->
   <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
   <TestingPlatformShowTestsFailure>true</TestingPlatformShowTestsFailure>
   ```

   O separador `--` que elas exigiam também vira opcional, embora ainda valha a pena mantê-lo na CI por um motivo coberto no passo 6.

   Verifique: `dotnet test` continua rodando e a saída do console mostra o reporter de terminal do MTP em vez do VSTest.

5. **Readicione os loggers e collectors como pacotes de extensão.**

   O núcleo do MTP não traz nenhum deles. Se o seu pipeline passa uma opção cujo pacote está faltando, a execução falha com **código de saída 5** porque a opção não é reconhecida.

   ```xml
   <!-- tests/Directory.Build.props - MTP 2.3.3 extensions -->
   <ItemGroup>
     <PackageReference Include="Microsoft.Testing.Extensions.TrxReport" Version="2.3.3" />
     <PackageReference Include="Microsoft.Testing.Extensions.CodeCoverage" Version="18.10.0" />
     <PackageReference Include="Microsoft.Testing.Extensions.HangDump" Version="2.3.3" />
     <PackageReference Include="Microsoft.Testing.Extensions.CrashDump" Version="2.3.3" />
   </ItemGroup>
   ```

   A extensão de cobertura de código é versionada de forma independente da plataforma: ela acompanha a numeração da plataforma de testes do Visual Studio, então a versão atual é 18.10.0 enquanto o resto está em 2.3.3. A tabela de compatibilidade documentada casa a linha 18.1.x com o MTP 2.0.x, a 18.0.x com a 1.8.x e a 17.14.x com a 1.6.2, e a orientação é manter ambos na última versão. Se você usa Central Package Management, esses vão para o `Directory.Packages.props`, que é mais um argumento para [mover a solução para Directory.Packages.props](/pt-br/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) antes de começar.

   Verifique: `dotnet test --help` lista `--report-trx`, `--coverage`, `--hangdump` e `--crashdump`.

6. **Traduza a linha de comando da CI.**

   Aqui está o grosso do trabalho. O mapeamento:

   ```bash
   # before - VSTest, .NET 9 SDK
   dotnet test MyApp.sln \
     --logger "trx;LogFileName=results.trx" \
     --collect "Code Coverage" \
     --blame-hang-timeout 5m \
     --results-directory ./artifacts/tests \
     --filter "TestCategory=Integration"
   ```

   ```bash
   # after - MTP 2.3.3, .NET 11 SDK
   dotnet test --solution MyApp.sln \
     --results-directory ./artifacts/tests \
     -- --report-trx --report-trx-filename results.trx \
        --coverage --coverage-output-format cobertura \
        --hangdump --hangdump-timeout 5m \
        --filter "TestCategory=Integration"
   ```

   Três coisas para notar. O `MyApp.sln` posicional virou `--solution`, porque `dotnet test` em modo MTP não aceita mais um caminho solto. O `--` é tecnicamente opcional no SDK do .NET 10 e posteriores, mas `dotnet test` repassa para a aplicação de testes os tokens que não reconhece, e uma opção do SDK reconhecida no meio do nome de uma opção não reconhecida e do valor dela muda como os tokens restantes se ligam. Coloque os argumentos da aplicação de testes depois do `--` e a ambiguidade some. Por fim, `--results-directory` é entendido tanto pelo SDK quanto pela plataforma, então pode ficar de qualquer lado.

   Para uma solução que mistura frameworks ou conjuntos de extensões, roteie os argumentos por projeto em vez de globalmente:

   ```xml
   <!-- only the projects that reference HangDump get the option -->
   <PropertyGroup Condition="'$(MSBuildProjectName)' == 'MyApp.Integration.Tests'">
     <TestingPlatformCommandLineArguments>
       $(TestingPlatformCommandLineArguments) --hangdump --hangdump-timeout 5m
     </TestingPlatformCommandLineArguments>
   </PropertyGroup>
   ```

   Verifique: a execução produz `results.trx` e um arquivo Cobertura em `./artifacts/tests`, e o código de saída é 0.

7. **Substitua `.runsettings` por `testconfig.json`.**

   MSTest e NUnit continuam respeitando `--settings config.runsettings` pelas pontes VSTest deles, então você pode adiar isso. O xUnit v3 não respeita, e a plataforma em si nunca lê runsettings. A substituição:

   ```json
   // testconfig.json at the repo root - MTP 2.3.3
   {
     "platformOptions": {
       "resultDirectory": "./artifacts/tests",
       "exitProcessOnUnhandledException": false
     },
     "environmentVariables": {
       "DOTNET_ENVIRONMENT": "Testing"
     },
     "mstest": {
       "parallelism": { "enabled": true, "workers": 4, "scope": "method" },
       "timeout": { "test": 30000 }
     }
   }
   ```

   O mapeamento não é um para um. `RunConfiguration/ResultsDirectory` vira `platformOptions.resultDirectory`. `RunConfiguration/MaxCpuCount` não tem equivalente, porque o paralelismo em nível de processo agora é `--max-parallel-test-modules`. `LoggerRunSettings/Loggers` e tudo sob `DataCollectionRunSettings` viram as opções de CLI do passo 5. `TestRunParameters` vira `--test-parameter key=value`. A partir do MTP 2.3.0 você também pode colocar as próprias opções de CLI no `testconfig.json`, incluindo as de extensões, que é como você mantém `--coverage-output-format cobertura` fora de cada arquivo de pipeline; a seção `environmentVariables` também é da 2.3.0 em diante.

   Aponte cada projeto para um único arquivo compartilhado a partir do `Directory.Build.props`:

   ```xml
   <PropertyGroup>
     <TestingPlatformCommandLineArguments>
       $(TestingPlatformCommandLineArguments) --config-file $(MSBuildThisFileDirectory)testconfig.json
     </TestingPlatformCommandLineArguments>
   </PropertyGroup>
   ```

   Verifique: remova a referência ao `.runsettings` da CI e confirme que os resultados continuam caindo no diretório configurado.

8. **Troque a própria task de CI.**

   No Azure DevOps, substitua a task `VSTest@2` por `DotNetCoreCLI@2`. É uma invocação de `dotnet test` como qualquer outra, então as regras do passo 6 valem literalmente:

   ```yml
   # azure-pipelines.yml - .NET 11 SDK, MTP 2.3.3
   - task: DotNetCoreCLI@2
     inputs:
       command: 'test'
       arguments: '--solution MyApp.sln -- --report-trx --results-directory $(Agent.TempDirectory)'
   ```

   No GitHub Actions, `Microsoft.Testing.Extensions.GitHubActionsReport` mais `--report-gh` coloca as falhas direto no diff do pull request, que é [a história de relatórios que ficou estável no MTP 2.3](/pt-br/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/). Repare na quase colisão: o pacote de terceiros `GitHubActionsTestLogger` usa `--report-github`, um caractere de distância da opção oficial.

   Verifique: um teste que falha de propósito produz um job vermelho com a falha visível no resumo da execução, e não apenas no log bruto.

## Verifique a migração

Rode esta lista contra um projeto antes de estender a mudança para a solução inteira:

- `dotnet build` emite um executável por projeto de teste, e executá-lo diretamente (`./MyApp.Tests`) reporta a mesma quantidade de testes que `dotnet test`.
- `dotnet test --help` lista toda opção que o seu pipeline passa. Se alguma estiver faltando, o pacote dela está faltando.
- A quantidade de testes bate com a do VSTest antes da migração. Uma queda normalmente significa que uma expressão de filtro parou de casar, não que testes sumiram.
- O arquivo TRX e o relatório de cobertura existem nos caminhos que os seus passos seguintes leem.
- O Test Explorer do Visual Studio continua descobrindo e executando testes. O suporte a MTP exige Visual Studio 17.14 ou posterior; o VS Code precisa do C# Dev Kit.
- `echo $?` depois de uma execução que passa é 0, e depois de uma que falha de propósito é 2.

## Rollback

Esta migração é reversível em um único commit enquanto você mantiver referenciados `Microsoft.NET.Test.Sdk` e o pacote adaptador VSTest do seu framework. Apague a seção `test` do `global.json` e o runner volta para o VSTest; `OutputType=Exe` e as propriedades de opt-in ficam inertes sob o VSTest. É exatamente por isso que você não deve remover `xunit.runner.visualstudio` nem `Microsoft.NET.Test.Sdk` no mesmo pull request. Faça essa limpeza uma semana depois, quando a CI e a IDE de cada pessoa do time já tiverem rodado sobre o MTP.

## Armadilhas que vale conhecer antes de começar

**O código de saída 8 deixa vermelho um job verde.** Um projeto que executa zero testes sai com 8 sob MTP e com 0 sob VSTest. Isso morde soluções com um projeto de teste de fachada ou com um filtro que não casa com nada. Ou você conserta o filtro, ou opta por sair explicitamente:

```xml
<PropertyGroup>
  <TestingPlatformCommandLineArguments>
    $(TestingPlatformCommandLineArguments) --ignore-exit-code 8
  </TestingPlatformCommandLineArguments>
</PropertyGroup>
```

`--ignore-exit-code` aceita uma lista separada por ponto e vírgula (`--ignore-exit-code 2;8`), e `TESTINGPLATFORM_EXITCODE_IGNORE` faz o mesmo pelo ambiente. Separadamente, o MTP 2.3.0 mudou o caso de tudo ignorado: uma execução em que todos os testes foram ignorados agora tem sucesso por padrão, e `--zero-tests-policy strict` restaura a falha anterior à 2.3.0.

**Uma solução mista é um erro, não um aviso.** Depois que o `global.json` seleciona MTP, `dotnet test` espera que todo projeto de teste do grafo seja um projeto MTP. Um retardatário no VSTest derruba a execução inteira. Migre primeiro os projetos folha e troque o `global.json` por último.

**Código de saída 5 significa pacote faltando, não erro de digitação.** Se metade dos seus projetos referencia `Microsoft.Testing.Extensions.HangDump` e a outra metade não, `--hangdump` é válida para uns e desconhecida para outros, e a execução morre com 5. Use as condições de `TestingPlatformCommandLineArguments` por projeto do passo 6.

**O xUnit ignora `--filter`.** MSTest e NUnit mantêm a sintaxe de expressões do VSTest (`FullyQualifiedName~UnitTest1|TestCategory=CategoryA`) sob MTP. O xUnit v3 não a implementa de jeito nenhum: você precisa de `--filter-class`, `--filter-method`, `--filter-namespace`, `--filter-trait` ou `--filter-query`, mais as variantes negadas. Um filtro de CI que silenciosamente não casa com nada dispara depois o código de saída 8, que é como isso aparece na prática. Vale entender essa mesma classe de problema de filtro silencioso se você também está avaliando [xUnit v3 contra NUnit e MSTest](/pt-br/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/).

**Os números de cobertura mudam.** `IncludeTestAssembly` tem padrão `false` no `Microsoft.Testing.Extensions.CodeCoverage` e era `true` no VSTest. O seu percentual total de cobertura vai mudar no commit da migração por razões que não têm nada a ver com o seu código. Avise quem cuida do portão de cobertura antes de fazer push.

**O ponto de entrada gerado produz dois erros de compilação estranhos.** O `Microsoft.Testing.Platform.MSBuild` emite `TestingPlatformEntryPoint` e `SelfRegisteredExtensions` dentro de `$(RootNamespace)`, cujo padrão é o nome do projeto. Um projeto chamado `Contoso.Serialization.Tests` que também referencia um pacote `Contoso.Serialization` pode produzir `CS0118: 'Serialization' is a namespace but is used like a type`; defina `<RootNamespace>Contoso.SerializationTests</RootNamespace>` ou limpe com `<RootNamespace />`. Separadamente, um projeto que não é de teste e referencia um que é bate em `CS8892` porque o ponto de entrada gerado colide com o `Main` dele; defina `<IsTestingPlatformApplication>false</IsTestingPlatformApplication>` no projeto que referencia, ou `<GenerateTestingPlatformEntryPoint>false</GenerateTestingPlatformEntryPoint>` no projeto de teste.

**As esquisitices do Test Explorer têm o próprio interruptor.** Se a descoberta se comportar mal em uma IDE, `<DisableTestingPlatformServerCapability>true</DisableTestingPlatformServerCapability>` desliga o modo servidor do MTP para que a IDE volte ao adaptador do VSTest. Isso é um contorno, não uma correção, e é um problema diferente do [Test Explorer travando enquanto `dotnet test` passa](/pt-br/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/).

O SDK do .NET 11 deixa o momento bom: `--timeout` e `--maximum-failed-tests` em nível de execução, `--no-dependencies`, `--use-current-runtime`, padrões de exclusão com prefixo `!` para `--test-modules`, suporte a `Microsoft.Build.Traversal` e uma exibição ao vivo dos testes em andamento em terminais interativos. Nada disso existe no caminho do VSTest.

## Relacionados

- [Migrar um projeto de teste do xUnit v2 para o xUnit v3](/pt-br/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/)
- [Microsoft.Testing.Platform 2.3 e as anotações do GitHub Actions](/pt-br/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/)
- [xUnit v3 vs NUnit vs MSTest em 2026](/pt-br/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/)
- [VSTest remove o Newtonsoft.Json no .NET 11 Preview 4](/pt-br/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/)
- [Migrar uma solução .NET para Central Package Management](/pt-br/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)

## Fontes

- [Guia de migração do VSTest para o Microsoft.Testing.Platform (MTP)](https://learn.microsoft.com/en-us/dotnet/core/testing/migrating-vstest-microsoft-testing-platform) no MS Learn
- [Comando dotnet test com Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-test-mtp), a referência de CLI no modo MTP
- [Referência de opções de CLI do Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-cli-options), incluindo a tabela de opções de extensão por cenário
- [Solução de problemas do Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-troubleshooting) para a tabela completa de códigos de saída
- [Opções de configuração do Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-config) para `testconfig.json` e o mapeamento de runsettings
- [Cobertura de código do Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-code-coverage) para as opções da extensão e a tabela de compatibilidade de versões
- [Enhance your CLI testing workflow with the new dotnet test](https://devblogs.microsoft.com/dotnet/dotnet-test-with-mtp/) no blog do .NET
- [Novidades do SDK e das ferramentas do .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/sdk) para as melhorias de teste do Preview 7
- [Suporte ao Microsoft Testing Platform no xUnit.net v3](https://xunit.net/docs/getting-started/v3/microsoft-testing-platform)

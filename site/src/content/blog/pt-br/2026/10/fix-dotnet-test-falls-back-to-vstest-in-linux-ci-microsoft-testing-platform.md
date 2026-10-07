---
title: "Fix: dotnet test recorre ao VSTest em um pipeline de CI no Linux mesmo com o projeto usando Microsoft.Testing.Platform"
description: "O dotnet test escolhe o runner a partir do global.json encontrado subindo a partir do diretório de trabalho. No CI Linux ele recorre ao VSTest quando esse arquivo está ausente, com nome errado, com chave em caixa incorreta ou quando o SDK é anterior ao 10."
pubDate: 2026-10-07
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "testing"
  - "microsoft-testing-platform"
  - "ci-cd"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/10/fix-dotnet-test-falls-back-to-vstest-in-linux-ci-microsoft-testing-platform"
translatedBy: "claude"
translationDate: 2026-10-07
---

Se o `dotnet test` executa seus testes do Microsoft.Testing.Platform (MTP) pelo VSTest em um agente de build Linux, mas não na sua máquina, a CLI não enxergou a seleção de runner. O `dotnet test` decide entre VSTest e MTP antes de compilar qualquer coisa, procurando um `global.json` que começa no **diretório de trabalho atual** e sobe pela árvore, e lendo uma seção `"test": { "runner": "Microsoft.Testing.Platform" }` com exatamente esses nomes de propriedade em minúsculas. No Linux o arquivo precisa se chamar `global.json` em minúsculas, o job precisa rodar dentro do repositório e o SDK precisa ser 10.0 ou posterior. Corrija o que o seu pipeline quebra e depois faça o CI falhar de forma explícita se isso acontecer de novo.

Tudo abaixo foi medido em macOS arm64 (incluindo um volume APFS com distinção de maiúsculas e minúsculas, que se comporta como um sistema de arquivos Linux) com o SDK .NET 10 10.0.302, o SDK .NET 11 RC 1 (11.0.100-rc.1.26425.128) e o SDK .NET 9 9.0.318, usando MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1) e xunit.v3 3.2.2 (MTP v1 com `xunit.runner.visualstudio` 3.1.5).

## O erro em contexto

Como o "recurso ao VSTest" aparece depende da versão do MTP que seus projetos de teste usam. Projetos no MTP 2.x (MSTest 4.x, MSTest.Sdk 4.x, `xunit.v3.mtp-v2`) se recusam a executar e fazem o job falhar:

```text
Microsoft.Testing.Platform.MSBuild.targets(355,5): error : Testing with VSTest target is no longer supported by Microsoft.Testing.Platform on .NET 10 SDK and later. If you use dotnet test, you should opt-in to the new dotnet test experience. For more information, see https://aka.ms/dotnet-test-mtp-error [/src/tests/SdkTests/SdkTests.csproj]
```

Se o seu pipeline usa a sintaxe exclusiva do MTP para selecionar o que testar, a falha acontece ainda mais cedo, porque o `dotnet test` em modo VSTest repassa a opção desconhecida ao MSBuild:

```text
MSBUILD : error MSB1001: Unknown switch.
    Full command line: '/usr/share/dotnet/sdk/10.0.302/MSBuild ... --target:VSTest --nologo -nodereuse:false --solution src/Repo.slnx ...'
Switch: --solution
```

A variante perigosa é a que continua verde. Um projeto no MTP v1 que ainda referencia um adaptador VSTest (`xunit.v3` 3.x com `xunit.runner.visualstudio`, ou MSTest 3.x com `Microsoft.NET.Test.Sdk`) roda tranquilamente sob o VSTest:

```text
Test run for /src/tests/XTests/bin/Debug/net10.0/XTests.dll (.NETCoreApp,Version=v10.0)
A total of 1 test files matched the specified pattern.
Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1, Duration: 6 ms - XTests.dll (net10.0)
```

Nesse modo, `dotnet test -- --report-trx` também retorna código de saída 0 e não grava nenhum arquivo TRX, porque tudo depois de `--` é tratado como argumentos de RunSettings. No modo MTP de verdade, o mesmo projeto rejeita `--report-trx` com código de saída 5 (a extensão não está referenciada), que é a resposta honesta. Um pipeline que publica "os arquivos TRX que existirem" publicará nada, sem reclamar.

Para comparação, isto é o que o modo MTP imprime. Se você não vê `Running tests from` e `Test run summary`, você não está no modo MTP:

```text
Running tests from /src/tests/SdkTests/bin/Debug/net10.0/SdkTests.dll (net10.0|arm64)
/src/tests/SdkTests/bin/Debug/net10.0/SdkTests.dll (net10.0|arm64) passed (426ms)
Test run summary: Passed!
```

## Por que o dotnet test ignora a sua escolha de runner

A seleção de runner foi adicionada no SDK do .NET 10 e vive em um único lugar: a seção `test` do `global.json`. No SDK do .NET 11 (a partir do Preview 6), a variável de ambiente `DOTNET_TEST_RUNNER` pode sobrescrevê-la. Se nenhum dos dois selecionar o MTP, o `dotnet test` permanece no modo VSTest, invoca o target `VSTest` do MSBuild e deixa o seu projeto MTP reagir como a versão dele reage. Nada no `.csproj` pode alterar essa decisão, porque ela é tomada pela CLI antes de o MSBuild avaliar qualquer projeto.

As causas que consegui reproduzir, em ordem aproximada de frequência em pipelines reais:

1. **O job roda a partir de um diretório que não está dentro do repositório**, então a busca ascendente nunca chega ao `global.json`. Passar o caminho da solução não ajuda; a busca começa no diretório de trabalho, não no projeto.
2. **O arquivo se chama `Global.json`** (ou `GLOBAL.JSON`). O Windows e os sistemas de arquivos padrão do macOS não diferenciam maiúsculas de minúsculas, então localmente funciona. O Linux diferencia.
3. **O `global.json` não está no lugar de onde o CI executa**: ele está em `src/` enquanto o job roda na raiz do repositório, ou um contexto de build do Docker copia os projetos mas não o arquivo.
4. **Um nome de propriedade está com a caixa errada.** `"Test"` ou `"Runner"` é ignorado silenciosamente. O valor não diferencia maiúsculas de minúsculas, as chaves diferenciam.
5. **A imagem de CI tem um SDK anterior ao 10.0.** O SDK do .NET 9 não sabe que a seção `test` existe.
6. **`DOTNET_TEST_RUNNER=VSTest` está definida** no nível do pipeline ou do agente em um SDK do .NET 11. Ela tem precedência sobre o `global.json`.

## Reprodução mínima

Dois projetos de teste, uma solução e um `global.json` na raiz do repositório:

```json
// global.json - .NET 10 SDK 10.0.302
{
  "test": {
    "runner": "Microsoft.Testing.Platform"
  }
}
```

```xml
<!-- tests/SdkTests/SdkTests.csproj - MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1) -->
<Project Sdk="MSTest.Sdk/4.4.1">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
```

A partir da raiz do repositório, `dotnet test` executa os dois projetos em modo MTP. Agora reproduza o comportamento do CI:

```bash
# .NET 10 SDK 10.0.302
cd /tmp/elsewhere
dotnet test /src/repo/Repo.slnx        # VSTest mode: "Testing with VSTest target is no longer supported"

cd /src/repo
mv global.json Global.json
dotnet test                             # macOS/Windows: MTP mode. Linux: VSTest mode
```

Executei a segunda metade em uma imagem de disco APFS com distinção de maiúsculas e minúsculas (`hdiutil create -fs "Case-sensitive APFS"`) para obter a semântica do Linux sem um contêiner: `global.json` passou, `Global.json` falhou com o erro do VSTest, e o mesmo `Global.json` no volume normal, sem distinção, passou. Essa é a clássica divisão do "funciona na minha máquina".

## A correção, em detalhes

### 1. Comprove em qual modo o agente está

Adicione uma etapa de diagnóstico antes da etapa de teste. As primeiras linhas de `dotnet test --help` mostram qual comando a CLI escolheu:

```bash
# .NET 10 SDK 10.0.302 - put this right before the test step
pwd
ls -la global.json || echo "no global.json in $(pwd)"
dotnet --version
dotnet test --help | sed -n 2p
```

No modo MTP, a segunda linha diz `.NET Test Command for Microsoft.Testing.Platform (opted-in via 'global.json' file)`. No modo VSTest, diz `.NET Test Command for VSTest. To use Microsoft.Testing.Platform, opt-in to the Microsoft.Testing.Platform-based command via global.json.` Uma pequena peculiaridade: no SDK do .NET 11 RC 1, o texto do MTP ainda diz "via 'global.json' file" mesmo quando foi a variável de ambiente que fez a adesão.

### 2. Renomeie o arquivo para minúsculas no git

Em um sistema de arquivos sem distinção de maiúsculas e minúsculas, um simples renome para o mesmo nome com caixa diferente não é detectado de forma confiável. Deixe o git fazer isso:

```bash
# any git version
git mv Global.json global.json.tmp
git mv global.json.tmp global.json
git commit -m "Rename global.json to lowercase for Linux agents"
```

O mesmo vale para `Directory.Build.props` e afins, mas esses são resolvidos pelo MSBuild e uma caixa errada ali produz sintomas diferentes.

### 3. Execute a etapa de teste de dentro do repositório

A busca sobe a partir do diretório de trabalho, então o job só precisa estar na pasta que contém o `global.json` ou abaixo dela. No GitHub Actions, o diretório de trabalho padrão é o checkout, então o culpado habitual é um `working-directory` explícito ou um `cd` para uma pasta de artefatos:

```yaml
# GitHub Actions, actions/setup-dotnet@v6, .NET 10 SDK
- uses: actions/setup-dotnet@v6
  with:
    global-json-file: global.json
- name: Test
  run: dotnet test --solution Repo.slnx
  # no working-directory pointing at a folder outside the repo
```

`global-json-file` mantém o SDK instalado pelo `setup-dotnet` sincronizado com o arquivo, o que também cobre a causa 5. Ele lê a versão do SDK de `sdk.version`, então combine-o com o pin mostrado na etapa 5. Sem um pin, o `setup-dotnet` documenta que vence o SDK mais recente já instalado no runner. Se o seu `global.json` fica em `src/`, mova-o para a raiz (recomendado, já que `dotnet build` e as IDEs o resolvem do mesmo jeito) ou execute a etapa com `working-directory: src`.

Para builds do Docker, copie o `global.json` para o mesmo diretório a partir do qual você executa `dotnet test` e verifique o `.dockerignore`:

```dockerfile
# mcr.microsoft.com/dotnet/sdk:10.0
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS test
WORKDIR /src
COPY global.json ./
COPY Repo.slnx ./
COPY tests/ tests/
RUN dotnet test --solution Repo.slnx
```

### 4. Escreva a seção exatamente como deve ser

Todos estes casos foram testados no SDK 10.0.302:

| Conteúdo do `global.json` | Resultado |
|---|---|
| `"test": { "runner": "Microsoft.Testing.Platform" }` | MTP |
| `"test": { "runner": "microsoft.testing.platform" }` | MTP (o valor não diferencia maiúsculas de minúsculas) |
| `"Test": { "runner": ... }` ou `"test": { "Runner": ... }` | VSTest, silenciosamente |
| `"sdk": { "version": "10.0.302", "test": { ... } }` (aninhado) | VSTest, silenciosamente |
| `"test": { "runner": "MTP" }` | Falha da CLI: `Test runner 'MTP' is not supported.` |
| `// comments` no arquivo | MTP (comentários são permitidos) |
| uma vírgula final | Falha da CLI: `JsonException ... trailing comma` |

As falhas barulhentas são fáceis. As duas silenciosas são o motivo para manter exatamente a caixa da documentação e manter `test` no nível superior, ao lado de `sdk`, não dentro dele.

### 5. Use um SDK que entenda a seleção de runner

No SDK 9.0.318, com exatamente o mesmo `global.json`, o `dotnet test` ignorou a seção `test` por completo e executou um projeto `xunit.v3` 3.2.2 pelo VSTest (`VSTest version 17.14.1`). Um projeto MSTest.Sdk 4.4.1 em `net9.0` também continuou verde, mas pela antiga ponte do MSBuild (`Run tests: '...' [net9.0|arm64]`), porque a ponte ainda é suportada no SDK 9 e anteriores. Nos dois casos você perde o comportamento do modo MTP sem nenhum aviso.

Isso afeta pipelines que usam imagens `mcr.microsoft.com/dotnet/sdk:9.0`, ou `setup-dotnet` com `dotnet-version: 9.0.x` para um projeto que tem como alvo `net8.0` ou `net9.0`. Você não precisa mudar o framework alvo dos projetos; só precisa do SDK 10.0 para executá-los. Fixe-o no mesmo arquivo:

```json
// global.json - SDK pin plus runner selection, .NET 10 SDK
{
  "sdk": {
    "version": "10.0.302",
    "rollForward": "latestFeature"
  },
  "test": {
    "runner": "Microsoft.Testing.Platform"
  }
}
```

Com um `sdk.version` fixado, um agente sem um SDK correspondente falha na inicialização com o erro "compatible .NET SDK was not found" em vez de usar silenciosamente um mais antigo.

### 6. Verifique o DOTNET_TEST_RUNNER em agentes .NET 11

No SDK do .NET 11 RC 1 confirmei a precedência documentada: `DOTNET_TEST_RUNNER=VSTest` sobrescreve um `global.json` correto e produz o mesmo erro "Testing with VSTest target is no longer supported", enquanto um valor vazio ou não reconhecido (`DOTNET_TEST_RUNNER=MTP`) é ignorado e o `global.json` vence. A variável também funciona no sentido contrário, o que a torna uma correção temporária prática quando você não pode alterar o repositório:

```bash
# .NET 11 SDK RC 1 (11.0.100-rc.1.26425.128) and later; ignored by the .NET 10 SDK
export DOTNET_TEST_RUNNER=Microsoft.Testing.Platform
dotnet test --solution Repo.slnx
```

No SDK 10.0.302 a variável não tem efeito em nenhuma das direções, então não conte com ela até o agente estar no .NET 11.

### 7. Faça um recurso ao VSTest quebrar o build

Duas proteções baratas transformam a variante silenciosa em um build vermelho:

```bash
# .NET 10 SDK 10.0.302, MTP 2.4.1
dotnet test --solution Repo.slnx --minimum-expected-tests 1
```

`--solution` (ou `--project`) só existe no modo MTP, então no modo VSTest o comando morre com `MSB1001: Unknown switch` em vez de executar os testes do jeito errado. `--minimum-expected-tests` é uma opção do MTP que faz a execução falhar com código de saída 9 se menos testes do que o esperado forem executados. Nunca passe opções do MTP depois de `--` no CI: essa é exatamente a sintaxe que o modo VSTest engole sem reclamar.

Se você ainda está migrando, remova também `TestingPlatformDotnetTestSupport` dos seus projetos assim que a troca no `global.json` estiver pronta. Ela só importa no modo VSTest, e deixá-la para trás permite que um projeto MTP v1 continue "funcionando" pela ponte quando a seleção de runner se perde.

## Pegadinhas e casos parecidos

- **O `.csproj` não pode fazer a adesão por você.** `TestingPlatformDotnetTestSupport`, `EnableMSTestRunner` e `UseMicrosoftTestingPlatformRunner` decidem como um projeto se comporta em cada modo. Eles não escolhem o modo.
- **Uma solução mista é outro erro.** Com o modo MTP ativado, um projeto que só suporta VSTest faz a execução falhar. Esse é o problema oposto, tratado no [guia de migração do VSTest para o Microsoft.Testing.Platform](/pt-br/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/).
- **`Zero tests ran` com código de saída 5 significa que você está no modo MTP.** Uma opção foi rejeitada pelo aplicativo de teste, veja [dotnet test com código de saída 5 no Microsoft.Testing.Platform](/pt-br/2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform/).
- **As tarefas `VSTest@2` e `VSTest@3` do Azure DevOps sempre usam o vstest.console.** Nenhuma mudança no `global.json` altera isso. Use uma etapa de script que chame `dotnet test` a partir da raiz do repositório.
- **As IDEs fazem a própria escolha.** O Test Explorer lendo o projeto de forma diferente da CLI é uma classe própria de bug, por exemplo o [Test Explorer travando no xUnit v3 enquanto o dotnet test passa](/pt-br/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/).

## Relacionado

- A [migração completa do VSTest para o Microsoft.Testing.Platform no .NET 11](/pt-br/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/), incluindo `--logger` para `--report-trx` e `.runsettings` para `testconfig.json`.
- Quando o modo MTP está ativo mas um projeto recusa seus argumentos: [corrija o dotnet test com código de saída 5 e "Zero tests ran"](/pt-br/2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform/).
- Como ter as falhas do MTP anotadas no diff do pull request quando o CI roda no modo certo: [anotações do GitHub Actions no Microsoft.Testing.Platform 2.3](/pt-br/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/).
- Como tirar um projeto `xunit.v3` 3.x do MTP v1 e do adaptador VSTest: [migrar um projeto de teste do xUnit v2 para o xUnit v3](/pt-br/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/).

## Fontes

- [Comando dotnet test: escolher um runner de teste](https://learn.microsoft.com/dotnet/core/tools/dotnet-test#choose-a-test-runner)
- [Testes com dotnet test: modo VSTest e modo MTP](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test)
- [Visão geral do global.json, incluindo como o arquivo é localizado](https://learn.microsoft.com/dotnet/core/tools/global-json)
- [dotnet test com Microsoft.Testing.Platform](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-mtp)
- [actions/setup-dotnet: entrada global-json-file](https://github.com/actions/setup-dotnet)
- [Repositório microsoft/testfx (MSTest e Microsoft.Testing.Platform)](https://github.com/microsoft/testfx)

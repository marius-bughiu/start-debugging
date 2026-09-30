---
title: "Correção: as variáveis de ambiente do launchSettings.json são ignoradas em um perfil commandName: Executable"
description: "Se o seu perfil Executable executa dotnet run ou dotnet watch, o comando interno aplica o perfil padrão e sobrescreve suas variáveis. Adicione --no-launch-profile e use o SDK 10.0.200+."
pubDate: 2026-09-30
template: error-page
tags:
  - "errors"
  - "dotnet-cli"
  - "launchsettings"
  - "dotnet-watch"
  - "dotnet-10"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/09/fix-launchsettings-environment-variables-ignored-for-executable-profile"
translatedBy: "claude"
translationDate: 2026-09-30
---

Se o seu perfil `commandName: "Executable"` inicia `dotnet run` ou `dotnet watch run`, adicione `--no-launch-profile` (ou `--launch-profile <name>`) aos `commandLineArgs` dele. Caso contrário, o comando interno escolhe o perfil padrão do projeto, e as `environmentVariables` desse perfil sobrescrevem as que o seu perfil Executable acabou de definir. Se a CLI exibir "The launch profile type 'Executable' is not supported", você está em um SDK anterior ao 10.0.200. Atualize, pois esses SDKs ignoram o perfil inteiro. Medi tudo abaixo no macOS com os SDKs 10.0.112, 10.0.302, 10.0.401 e 11.0.100-rc.1.

## O erro em contexto

Existem duas versões desse problema, e qual delas você encontra depende do seu SDK.

Em um SDK 10.0.1xx (e SDKs anteriores, que só entendiam perfis Project), `dotnet run --launch-profile` avisa diretamente e, mesmo assim, executa o projeto:

```
Using launch settings from /src/app/Properties/launchSettings.json...
The launch profile "Exe" could not be applied.
The launch profile type 'Executable' is not supported.
MY_MODE=<null> DOTNET_ENVIRONMENT=<null> DOTNET_LAUNCH_PROFILE=<null> args=[] cwd=/src/app
```

Essa mensagem é fácil de perder porque o app inicia. Ele só inicia sem nenhum perfil: sem variáveis de ambiente, sem `commandLineArgs`, nem mesmo `DOTNET_LAUNCH_PROFILE`.

No 10.0.200 e posteriores não há aviso. O perfil é executado, mas o app enxerga os valores errados. Este é o caso relatado em [dotnet/sdk#56023](https://github.com/dotnet/sdk/issues/56023): um perfil "Watch" define `ASPNETCORE_ENVIRONMENT=Development`, e o app ainda informa `Production`. A única pista é que a linha "Using launch settings" aparece duas vezes:

```
Using launch settings from /src/app/Properties/launchSettings.json...
Using launch settings from /src/app/Properties/launchSettings.json...
MY_MODE=from-Default DOTNET_ENVIRONMENT=Production DOTNET_LAUNCH_PROFILE=Default args=[] cwd=/src/app
```

## Por que as variáveis são descartadas

Estas são as causas, da mais comum para a menos comum:

1. **Um comando aninhado do SDK reaplica um perfil.** `dotnet run` aplica corretamente um perfil Executable. Ele inicia o `executablePath` com as `environmentVariables` do perfil definidas. Mas quando esse executável é o próprio `dotnet` (`run`, `watch run`), o processo filho é um `dotnet run` novo, sem `--launch-profile`. Ele lê o mesmo `launchSettings.json`, seleciona o *primeiro* perfil com um `commandName` suportado e define as variáveis desse perfil no processo do app. As variáveis do perfil vencem as herdadas (veja `SetEnvironmentVariables` em [`RunCommand.cs`](https://github.com/dotnet/sdk/blob/release/10.0.4xx/src/Cli/dotnet/Commands/Run/RunCommand.cs)), então seus valores externos são substituídos silenciosamente.
2. **O SDK é anterior ao 10.0.200.** O suporte a Executable em `dotnet run` e `dotnet watch` chegou em [dotnet/sdk#51727](https://github.com/dotnet/sdk/pull/51727), incorporado ao `release/10.0.2xx` em 12 de dezembro de 2025. Antes disso, a CLI só conhecia `commandName: "Project"`. O Visual Studio sempre suportou perfis Executable, e é por isso que o mesmo arquivo "funciona no VS".
3. **A IDE nunca lê perfis Executable.** A extensão C# do VS Code documenta que "Only profiles with `"commandName": "Project"` are supported" em suas [configurações do depurador](https://code.visualstudio.com/docs/csharp/debugger-settings). Escolher um perfil Executable ali não faz nada com as variáveis dele.

## Como o dotnet run escolhe um perfil e empilha as variáveis

Ajuda conhecer a ordem exata que a CLI segue, porque cada solução alternativa abaixo é apenas uma forma de controlar uma dessas etapas. No SDK 10.0.200 e posteriores, `dotnet run` faz o seguinte:

1. Se você passar `--no-launch-profile`, ele não usa nenhum perfil. Pare aqui.
2. Caso contrário, ele procura `Properties/launchSettings.json` (`My Project/launchSettings.json` para VB, ou `<app>.run.json` ao lado de um app baseado em arquivo).
3. Com `--launch-profile <name>`, ele escolhe esse perfil. A busca diferencia maiúsculas de minúsculas primeiro e, depois, recorre a uma correspondência sem diferenciação. Sem o parâmetro, ele escolhe o primeiro perfil cujo `commandName` seja `Project` ou `Executable`. Qualquer outro nome de comando (`IISExpress`, `Docker`, `DotNetCore`) é ignorado.
4. Ele monta o ambiente do processo filho em três camadas. Primeiro, o ambiente herdado do processo `dotnet`. Depois, `DOTNET_LAUNCH_PROFILE`, mais `ASPNETCORE_URLS` a partir de `applicationUrl` para perfis Project, e cada entrada de `environmentVariables`. Por fim, qualquer `-e KEY=VALUE` da linha de comando. As camadas posteriores vencem.

A etapa 4 é o motivo de o caso aninhado falhar. O `dotnet run` externo coloca seus valores na camada um do `dotnet run` interno, e a camada dois do comando interno os substitui. Nada no processo interno sabe que ele foi iniciado a partir de um perfil de inicialização. Toda correção se resume a fazer a etapa 1 ou a etapa 3 do comando interno se comportar como você quer.

## Repro mínimo

Um app de console que imprime o que ele realmente recebeu:

```csharp
// .NET 10, C# 14 - Program.cs (ImplicitUsings enabled)
Console.WriteLine($"MY_MODE={Environment.GetEnvironmentVariable("MY_MODE") ?? "<null>"} " +
                  $"DOTNET_ENVIRONMENT={Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT") ?? "<null>"} " +
                  $"DOTNET_LAUNCH_PROFILE={Environment.GetEnvironmentVariable("DOTNET_LAUNCH_PROFILE") ?? "<null>"} " +
                  $"args=[{string.Join(",", args)}] cwd={Environment.CurrentDirectory}");
```

E um `Properties/launchSettings.json` com um perfil Project normal primeiro, seguido de três perfis Executable:

```json
{
  "profiles": {
    "Default": {
      "commandName": "Project",
      "environmentVariables": { "MY_MODE": "from-Default", "DOTNET_ENVIRONMENT": "Production" }
    },
    "Exe": {
      "commandName": "Executable",
      "executablePath": "dotnet",
      "commandLineArgs": "bin/Debug/net10.0/app.dll hello",
      "workingDirectory": "..",
      "environmentVariables": { "MY_MODE": "from-Exe", "DOTNET_ENVIRONMENT": "Development" }
    },
    "ExeDotnetRun": {
      "commandName": "Executable",
      "executablePath": "dotnet",
      "commandLineArgs": "run --no-build",
      "workingDirectory": "..",
      "environmentVariables": { "MY_MODE": "from-ExeDotnetRun", "DOTNET_ENVIRONMENT": "Development" }
    },
    "Watch": {
      "commandName": "Executable",
      "executablePath": "dotnet",
      "commandLineArgs": "watch run --non-interactive",
      "workingDirectory": "..",
      "environmentVariables": { "MY_MODE": "from-Watch", "DOTNET_ENVIRONMENT": "Development" }
    }
  }
}
```

Executar `dotnet run --no-build --launch-profile <name>` em cada SDK imprimiu isto:

| Perfil | 10.0.112 | 10.0.302 / 10.0.401 / 11.0.100-rc.1 |
| --- | --- | --- |
| `Default` (Project) | `from-Default` | `from-Default` |
| `Exe` (executa `app.dll`) | aviso "not supported", `<null>` | `from-Exe`, `Development`, args `[hello]` |
| `ExeDotnetRun` | aviso "not supported", `<null>` | `from-Default`, `Production` |
| `Watch` | aviso "not supported", `<null>` | `from-Default`, `Production` (10.0.302) |

A linha `Exe` mostra que o próprio suporte a perfis Executable funciona nos SDKs modernos. As linhas `ExeDotnetRun` e `Watch` mostram a sobrescrita: o comando interno informa `DOTNET_LAUNCH_PROFILE=Default`, ou seja, ele escolheu o primeiro perfil por conta própria.

## A correção, passo a passo

1. **Verifique o SDK.** Execute `dotnet --version` no diretório do projeto, porque o `global.json` pode fixar uma banda mais antiga. Você precisa do 10.0.200 ou posterior para que `dotnet run` e `dotnet watch` respeitem perfis Executable. No 10.0.1xx, mantenha as variáveis em um perfil `Project`.
2. **Impeça o comando aninhado de escolher um perfil.** Se `executablePath` for `dotnet` e os argumentos começarem com `run` ou `watch`, adicione `--no-launch-profile`:

   ```json
   // .NET SDK 10.0.200+ - Properties/launchSettings.json
   "Watch": {
     "commandName": "Executable",
     "executablePath": "dotnet",
     "commandLineArgs": "watch run --non-interactive --no-launch-profile",
     "workingDirectory": "..",
     "environmentVariables": { "MY_MODE": "from-Watch", "DOTNET_ENVIRONMENT": "Development" }
   }
   ```

   Com essa mudança, o app imprimiu `MY_MODE=from-WatchNoProfile DOTNET_ENVIRONMENT=Development` sob `dotnet watch` no 10.0.302. `DOTNET_LAUNCH_PROFILE` ainda mostra o nome do perfil externo, porque o `dotnet run` externo o definiu e nada o sobrescreveu.

3. **Ou aponte o comando aninhado para um perfil específico.** Se as variáveis já estiverem em um perfil Project, referencie-o em vez de duplicá-las:

   ```json
   // .NET SDK 10.0.200+
   "ExeDotnetRunPinned": {
     "commandName": "Executable",
     "executablePath": "dotnet",
     "commandLineArgs": "run --no-build --launch-profile Dev",
     "workingDirectory": ".."
   }
   ```

   Isso imprimiu `MY_MODE=from-Dev DOTNET_ENVIRONMENT=Development DOTNET_LAUNCH_PROFILE=Dev`. Nesse arranjo, o perfil interno é o dono das variáveis. Tudo o que você colocar nas `environmentVariables` do perfil externo perde sempre que ambos os perfis definirem a mesma chave.

4. **No VS Code, mova as variáveis para o `launch.json`.** A extensão C# só lê perfis Project e apenas seus `environmentVariables`, `applicationUrl` e `commandLineArgs`. Coloque um bloco `env` em uma configuração de inicialização `coreclr`. De qualquer forma, os valores do `launch.json` têm precedência sobre o `launchSettings.json`.

## Armadilhas e problemas parecidos

**Um perfil Executable listado primeiro vira o padrão e pode criar processos indefinidamente.** No 10.0.200+, o perfil padrão é o primeiro cujo `commandName` seja `Project` *ou* `Executable` (`IsDefaultProfileType` em [`LaunchSettings.cs`](https://github.com/dotnet/sdk/blob/release/10.0.4xx/src/Microsoft.DotNet.ProjectTools/LaunchSettings/LaunchSettings.cs), e a mesma regra no `dotnet watch`). Coloque `"commandLineArgs": "run --no-build"` no primeiro perfil, execute um `dotnet run` simples, e cada processo filho seleciona o mesmo perfil de novo. No 10.0.302, contei 53 processos `dotnet run` após 12 segundos, antes de encerrá-los. A correção com `--no-launch-profile` acima também quebra o ciclo. Manter um perfil Project no topo do arquivo é um seguro barato.

**`dotnet run -e` também não sobrevive ao salto aninhado.** Verifiquei `dotnet run -e KEY=VALUE` no SDK 10.0.112 e posteriores (veja [`dotnet run -e`](/pt-br/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/)). Ele sobrescreve o perfil para o processo que o `dotnet run` externo inicia. Quando esse processo é outro `dotnet run`, o perfil padrão interno também o sobrescreve: `-lp ExeDotnetRun -e MY_MODE=from-cli` ainda imprimiu `from-Default`. O mesmo vale para um export simples no shell. `MY_MODE=from-shell dotnet run -lp Default` imprime `from-Default`, porque os valores do perfil de inicialização sempre vencem os herdados.

**`%VAR%` é expandido, `$(Property)` não (ainda).** A CLI passa cada valor por `Environment.ExpandEnvironmentVariables`, então `%HOME%` funciona também no macOS e no Linux. `$(HOME)` e `${HOME}` passam literalmente. Propriedades do MSBuild como `$(TargetPath)` ou `$(ProjectDir)` não são expandidas em nenhum SDK lançado que testei (10.0.302, 10.0.401, 11.0.100-rc.1). Você recebe `An error occurred trying to start process '$(TargetPath)' ... No such file or directory` em vez de uma variável ignorada silenciosamente. O `ProjectLaunchTargetsProvider` do Visual Studio as expande (conforme a [documentação de perfis de inicialização do project-system](https://github.com/dotnet/project-system/blob/main/docs/launch-profiles.md)), e é por isso que um perfil copiado de uma configuração do VS quebra na CLI. [dotnet/sdk#56074](https://github.com/dotnet/sdk/pull/56074) adiciona a expansão. Ele foi incorporado ao `main` em 4 de setembro de 2026, mas não está no `release/11.0.1xx-rc2` nem em nenhuma banda 10.0 até hoje. Até ser lançado, use caminhos relativos.

**`workingDirectory` é relativo à pasta `Properties`, não ao projeto.** A CLI o resolve com `Path.Combine(Path.GetDirectoryName(launchSettingsPath), value)`, então `".."` significa o diretório do projeto. O Visual Studio e o Rider o resolvem de forma diferente, o que [dotnet/sdk#56129](https://github.com/dotnet/sdk/pull/56129) está discutindo no momento. Para perfis Project, a CLI ignora completamente o `workingDirectory` nos SDKs atuais.

**Uma correção para o caso aninhado está em revisão.** [dotnet/sdk#56087](https://github.com/dotnet/sdk/pull/56087) faz o `dotnet run` definir um marcador `DOTNET_LAUNCH_PROFILE_APPLIED=1` nos processos que ele inicia a partir de um perfil Executable. Um `dotnet run` aninhado sem perfil explícito então ignora o perfil padrão. Ele ainda estava aberto em 30 de setembro de 2026. Mesmo depois de lançado, cobre apenas perfis iniciados pela CLI. O PR observa que IDEs que iniciam o perfil Executable diretamente ainda precisam de `--no-launch-profile`.

**`hotReloadEnabled` em um perfil Project não faz nada no `dotnet run`.** O autor do #56023 também percebeu isso. O hot reload vem do `dotnet watch`, não de uma propriedade do perfil. É exatamente por isso que as pessoas envolvem o `dotnet watch` em um perfil Executable. Veja [como o `dotnet watch` difere do `dotnet run`](/pt-br/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/) para saber o que o watcher acrescenta.

## Relacionados

- [.NET 11 Preview 3: dotnet run -e define variáveis de ambiente sem perfis de inicialização](/pt-br/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/)
- [Qual é a diferença entre dotnet watch e dotnet run?](/pt-br/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/)
- [Correção: o WebSocket do hot reload do Blazor no dotnet watch falha em um domínio local personalizado](/pt-br/2026/09/fix-dotnet-watch-blazor-hot-reload-websocket-fails-on-custom-local-domain/), outro caso em que as variáveis do perfil de inicialização não chegam ao processo esperado
- [Como executar um app C# baseado em arquivo com `dotnet run app.cs`](/pt-br/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/), que lê perfis de inicialização `<app>.run.json` pelo mesmo código
- [Como adicionar o Aspire a uma solução ASP.NET Core existente](/pt-br/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/), em que o próprio perfil de inicialização do AppHost decide qual ambiente cada serviço recebe

## Fontes

- [dotnet/sdk#56023: `launchSettings.json` environment variables are not propagated for `commandName: Executable`](https://github.com/dotnet/sdk/issues/56023)
- [dotnet/sdk#51727: Add Executable launch profile support to dotnet run and dotnet watch](https://github.com/dotnet/sdk/pull/51727)
- [dotnet/sdk#56087: Preserve Executable launch profile environment in nested dotnet run](https://github.com/dotnet/sdk/pull/56087)
- [dotnet/sdk#56074: Expand MSBuild properties across launch profiles](https://github.com/dotnet/sdk/pull/56074)
- [dotnet/sdk#49131: Allow `dotnet run` to use launch profiles with `commandName: Executable`](https://github.com/dotnet/sdk/issues/49131)
- [dotnet/project-system: launch profiles documentation](https://github.com/dotnet/project-system/blob/main/docs/launch-profiles.md)
- [VS Code C# debugger settings: launchSettings.json support](https://code.visualstudio.com/docs/csharp/debugger-settings)
- [`dotnet run` command reference on Microsoft Learn](https://learn.microsoft.com/dotnet/core/tools/dotnet-run)

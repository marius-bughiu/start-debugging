---
title: ".NET 11 Preview 3: dotnet run -e seta variáveis de ambiente sem launch profiles"
description: "dotnet run -e no .NET 11 Preview 3 passa variáveis de ambiente direto da CLI e as expõe como items RuntimeEnvironmentVariable do MSBuild."
pubDate: 2026-04-18
tags:
  - "dotnet"
  - "dotnet-11"
  - "dotnet-cli"
  - "msbuild"
lang: "pt-br"
translationOf: "2026/04/dotnet-11-preview-3-dotnet-run-environment-variables"
translatedBy: "claude"
translationDate: 2026-04-24
---

.NET 11 Preview 3 saiu em 14 de abril de 2026 com uma mudança de SDK pequena mas amplamente aplicável: `dotnet run` agora aceita `-e KEY=VALUE` pra passar variáveis de ambiente direto da linha de comando. Sem exports de shell, sem editar `launchSettings.json`, sem scripts wrapper pontuais.

## Por que o flag importa

Antes do Preview 3, setar uma env var pra uma execução única era uma de três opções esquisitas. No Windows você tinha `set ASPNETCORE_ENVIRONMENT=Staging && dotnet run` com as surpresas de quoting do `cmd.exe`. No bash você tinha `ASPNETCORE_ENVIRONMENT=Staging dotnet run`, que funciona mas vaza a variável pra qualquer processo filho que forke do shell. Ou você adicionava mais um profile no `Properties/launchSettings.json` que ninguém mais do time realmente queria.

`dotnet run -e` assume essa tarefa e mantém o escopo apertado à execução em si.

## A sintaxe, e o que ela de fato seta

Passe um `-e` por variável. Dá pra repetir o flag quantas vezes precisar:

```bash
dotnet run -e ASPNETCORE_ENVIRONMENT=Development -e LOG_LEVEL=Debug
```

O SDK injeta esses valores no ambiente do processo lançado. Sua app os vê através de `Environment.GetEnvironmentVariable` ou do pipeline de configuração do ASP.NET Core como qualquer outra variável:

```csharp
var env = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT");
Console.WriteLine($"Running as: {env}");
```

Há um segundo efeito colateral menos óbvio que vale conhecer: as mesmas variáveis são expostas ao MSBuild como items `RuntimeEnvironmentVariable`. Isso significa que targets rodando durante a fase de build do `dotnet run` também podem lê-las, o que destrava cenários como gatear geração de código num flag ou trocar arquivos de recursos por ambiente.

## Lendo items RuntimeEnvironmentVariable de um target

Se você tem um target custom que deve reagir ao flag, enumere os items que o MSBuild já populou:

```xml
<Target Name="LogRuntimeEnvVars" BeforeTargets="Build">
  <Message Importance="high"
           Text="Runtime env: @(RuntimeEnvironmentVariable->'%(Identity)=%(Value)', ', ')" />
</Target>
```

Rode `dotnet run -e FEATURE_X=on -e TENANT=acme` e o target imprime `FEATURE_X=on, TENANT=acme` antes da app subir. Esses são items MSBuild normais, então dá pra filtrar com `Condition`, alimentar em outras propriedades, ou usar pra dirigir decisões de `Include`/`Exclude` dentro do mesmo build.

## Onde encaixa no workflow

`dotnet run -e` não é substituto pra `launchSettings.json`. Launch profiles ainda fazem sentido pras configurações comuns do dia-a-dia e pra cenários de debug no Visual Studio ou Rider. O flag de CLI é melhor pros casos one-shot: reproduzir um bug que alguém reportou sob um `LOG_LEVEL` específico, testar um feature flag sem commitar um profile, ou armar um step rápido de CI em `dotnet watch` sem reescrever um arquivo YAML.

Um caveat pequeno: valores com espaços ou caracteres shell-especiais ainda precisam de quoting pro seu shell. `dotnet run -e "GREETING=hello world"` funciona em bash e PowerShell, `dotnet run -e GREETING="hello world"` funciona em `cmd.exe`. O SDK em si aceita a atribuição como está, mas o shell parseia a linha de comando primeiro.

A menor feature do .NET 11 Preview 3 no papel, e provavelmente uma das mais usadas na prática. Release notes completas vivem em [What's new in the SDK and tooling for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/sdk), e o post de anúncio está no [Blog do .NET](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/).

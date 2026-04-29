---
title: "Spam de pedidos “become owner” no NuGet: o que fazer (e o que travar) no .NET 9/.NET 10"
description: "Defenda seus pacotes .NET contra o spam de pedidos de propriedade no NuGet. Lock files, Package Source Mapping e práticas de Central Package Management para .NET 9 e .NET 10."
pubDate: 2026-01-23
tags:
  - "dotnet"
lang: "pt-br"
translationOf: "2026/01/nuget-become-owner-request-spam-what-to-do-and-what-to-lock-down-in-net-9-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
Uma thread das últimas 48 horas alerta sobre pedidos suspeitos de "become owner" no NuGet.org, supostamente enviados em larga escala para mantenedores de pacotes: [https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget\_gallery\_supply\_chain\_attack/](https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget_gallery_supply_chain_attack/).

Mesmo que os detalhes mudem amanhã, o checklist defensivo é estável. O objetivo é simples: reduzir a chance de uma mudança inesperada de propriedade virar uma dependência comprometida nos seus apps .NET 9/.NET 10.

## Trate pedidos de propriedade como um evento de segurança, não como uma notificação

Se você mantém pacotes:

-   **Não aceite** convites de propriedade inesperados, mesmo que o remetente pareça "legítimo".
-   **Verifique fora de banda**: se você reconhece a pessoa ou organização, contate por um canal conhecido (não pela mensagem do convite).
-   **Reporte** atividades suspeitas ao suporte do NuGet.org com timestamps e IDs de pacote.

Se você consome pacotes, assuma que erros acontecem e faça seu build resiliente a surpresas upstream.

## Trave o grafo de dependências para que "atualizações surpresa" não caiam sozinhas

Se você não usa lock files, deveria. Lock files tornam restores determinísticos, que é o que você quer quando um ecossistema de dependências está barulhento.

Habilite lock files no seu repo (funciona com `dotnet restore`):

```xml
<!-- Directory.Build.props -->
<Project>
  <PropertyGroup>
    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
    <!-- Optional: make CI fail if the lock file would change -->
    <RestoreLockedMode Condition="'$(CI)' == 'true'">true</RestoreLockedMode>
  </PropertyGroup>
</Project>
```

Depois gere o `packages.lock.json` inicial uma vez por projeto (localmente), commite, e deixe o CI exigir o cumprimento.

## Reduza a dispersão de fontes com Package Source Mapping

Um footgun comum é deixar "qualquer fonte NuGet que estiver configurada" em jogo. O Package Source Mapping força cada padrão de ID de pacote a vir de um feed específico.

Exemplo mínimo de `nuget.config`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="ContosoInternal" value="https://pkgs.dev.azure.com/contoso/_packaging/contoso/nuget/v3/index.json" />
  </packageSources>

  <packageSourceMapping>
    <packageSource key="nuget.org">
      <package pattern="Microsoft.*" />
      <package pattern="System.*" />
      <package pattern="Newtonsoft.Json" />
    </packageSource>
    <packageSource key="ContosoInternal">
      <package pattern="Contoso.*" />
    </packageSource>
  </packageSourceMapping>
</configuration>
```

Agora um atacante não pode "ganhar" colocando um pacote de mesmo nome em um feed diferente que você esqueceu que existia.

## Torne upgrades intencionais

Para bases .NET 9 e .NET 10, a melhor postura "do dia a dia" é entediante:

-   Fixe versões (ou use Central Package Management) e atualize via PRs.
-   Revise diffs de dependências como diffs de código.
-   Evite versões flutuantes em apps de produção, a menos que tenha um motivo forte e um monitoramento forte.

A thread original da discussão está aqui: [https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget\_gallery\_supply\_chain\_attack/](https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget_gallery_supply_chain_attack/). Se você mantém pacotes, vale dar uma olhada nas notificações da sua conta NuGet e auditar qualquer mudança recente de propriedade ainda hoje.

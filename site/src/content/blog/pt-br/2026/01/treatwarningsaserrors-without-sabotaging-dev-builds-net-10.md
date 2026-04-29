---
title: "TreatWarningsAsErrors sem sabotar os builds de dev (.NET 10)"
description: "Como aplicar TreatWarningsAsErrors em builds Release e em CI mantendo Debug flexível para o desenvolvimento local no .NET 10, usando Directory.Build.props."
pubDate: 2026-01-23
tags:
  - "dotnet"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
Se você já ligou `TreatWarningsAsErrors` para `true` e se arrependeu na mesma hora, você não está sozinho. Uma thread recente no r/dotnet que está circulando sugere um ajuste simples: forçar código sem warnings no Release (e no CI), mas manter Debug flexível para exploração local: [https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/](https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/)

## Forçar só em Release é uma política, não um interruptor

O que você está tentando atingir é um fluxo de trabalho:

-   Os desenvolvedores podem fazer testes locais sem brigar com o ruído do analisador.
-   Pull requests falham se novos warnings entram escondidos.
-   Você ainda tem um caminho para apertar o rigor com o tempo.

Em repositórios .NET 10, o lugar mais limpo para centralizar isso é `Directory.Build.props`. Isso faz a regra valer em cada projeto, incluindo projetos de teste, sem copy/paste.

Aqui está um padrão mínimo:

```xml
<!-- Directory.Build.props -->
<Project>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
</Project>
```

Isso bate com o que a maioria dos pipelines de CI compila de qualquer jeito (Release). Se o seu CI compila Debug, mude pra Release primeiro. Assim o seu padrão de "sem warnings" combina com os binários que você entrega.

## Ser estrito não significa ser cego

Dois botões importam quando você liga o interruptor grande:

-   `WarningsAsErrors`: escalar apenas IDs de warning específicos.
-   `NoWarn`: suprimir IDs de warning específicos (de preferência com um comentário e um link de rastreio).

Exemplo apertando um warning enquanto deixa os demais como warnings:

```xml
<Project>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
    <WarningsAsErrors>$(WarningsAsErrors);CS8602</WarningsAsErrors>
  </PropertyGroup>
</Project>
```

E se você precisa suprimir temporariamente um analisador barulhento em um projeto:

```xml
<Project>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <NoWarn>$(NoWarn);CA2007</NoWarn>
  </PropertyGroup>
</Project>
```

Se você usa Roslyn analyzers (comum em soluções modernas .NET 10), considere também `.editorconfig` para controlar severidade, porque é descobrível e mantém a política perto do código:

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.CA2007.severity = warning
```

## O ganho prático para os PRs

O ganho real é feedback previsível nos PRs. Desenvolvedores aprendem rápido que warnings não são "trabalho futuro", são parte da definition of done do Release. Debug fica rápido e tolerante, Release fica estrito e pronto pra entrega.

Se você quer o gatilho original desse padrão (e o pequeno snippet que iniciou a discussão), veja a thread aqui: [https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/](https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/)

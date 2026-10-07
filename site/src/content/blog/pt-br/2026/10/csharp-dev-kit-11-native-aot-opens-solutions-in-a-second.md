---
title: "C# Dev Kit 11.0 reduz seis processos a um único binário Native AOT"
description: "A versão prévia do C# Dev Kit 11.0 substitui seis processos gerenciados por um único processo CSDevKit com Native AOT e um cache de projetos persistente. Uma solução Aspire com 407 projetos fica pronta em 3,0s em vez de 84,1s, usando 316 MB em vez de 2.072 MB."
pubDate: 2026-10-07
tags:
  - "vscode"
  - "csharp"
  - "dotnet-11"
  - "native-aot"
  - "tooling"
lang: "pt-br"
translationOf: "2026/10/csharp-dev-kit-11-native-aot-opens-solutions-in-a-second"
translatedBy: "claude"
translationDate: 2026-10-07
---

Em 6 de outubro de 2026, Drew Noakes publicou [A faster, lighter C# Dev Kit](https://devblogs.microsoft.com/dotnet/faster-lighter-csharp-dev-kit/) no .NET Blog. O C# Dev Kit salta da versão 3.3 para a 11.0, e agora sua numeração acompanha o .NET 11. O novo número vem junto com uma reescrita de como a extensão carrega soluções no VS Code. Se você desistiu do VS Code para soluções C# grandes porque o indicador "Loading projects..." parecia nunca terminar, vale tentar de novo.

## Seis processos gerenciados viraram um único binário Native AOT

O C# Dev Kit 3.x executava seis processos gerenciados separados. Cada um iniciava o runtime e compilava com JIT o próprio código de inicialização antes de poder fazer qualquer trabalho. A versão 11.0 os une em um único processo `CSDevKit` compilado com Native AOT, de modo que esse caminho de inicialização não carrega mais um runtime nem executa o JIT.

O serviço de linguagem do C# (Roslyn) continua rodando em um processo próprio, então os números de memória abaixo se referem apenas ao lado do Dev Kit. Mesmo assim, a queda é grande:

| Solução | Projetos | Arquivos C# | 3.3 | 11.0 |
|----------|----------|----------|-----|------|
| Orleans | 155 | 4.010 | 1.307 MB | 208 MB |
| Roslyn | 398 | 18.153 | 2.000 MB | 379 MB |
| Aspire | 407 | 4.686 | 2.072 MB | 316 MB |

Isso dá cerca de 81-85% menos memória nos três repositórios.

## Um cache de projetos que você pode versionar

A outra metade do ganho de velocidade é um cache de projetos persistente. O primeiro carregamento avalia seus projetos e armazena os resultados. As aberturas seguintes leem do cache e pulam a avaliação completa em tempo de design. No repositório do Aspire, o arquivo ativo fica utilizável em 0,47s em vez de 84,1s, e a solução inteira fica pronta em 3,0s. O Orleans leva 0,53s para o arquivo ativo e 2,3s para a solução completa, contra 50,3s antes.

O post do blog também diz que, se você fizer commit dos arquivos de cache no controle de versão, clones novos e novos git worktrees ganham ferramentas rápidas imediatamente. Isso importa se você usa vários git worktrees lado a lado, por exemplo para agentes de código em paralelo. Hoje, cada novo worktree custa mais um carregamento de projetos a frio. O anúncio não lista os nomes dos arquivos de cache nem o que invalida o cache, então veja o que a extensão grava no seu repositório antes de mexer no `.gitignore`.

Os builds incrementais também ficaram mais rápidos. Um build sem alterações da solução Aspire leva 0,88s em vez de 34,4s, e um build após alterar um arquivo leva 2,1s em vez de 36,1s.

## Arquivos MSBuild ganham IntelliSense de verdade

A versão 11.0 também adiciona suporte de linguagem para arquivos `.csproj`, `.props` e `.targets`: autocompletar, diagnósticos, ir para a definição, correções rápidas e realce semântico. Nomes e versões de pacotes são completados enquanto você digita, e o CodeLens mostra um aviso acima de pacotes com vulnerabilidades conhecidas:

```xml
<ItemGroup>
  <!-- package id and version now complete; vulnerable versions get a CodeLens warning -->
  <PackageReference Include="MessagePack" Version="3.1.11" />
</ItemGroup>
```

Uma nova visão "C# Doctor" reúne em um só lugar as verificações de SDK, runtime, target framework, restauração e vulnerabilidades. Você não precisa mais vasculhar os canais de saída para descobrir por que um projeto não foi carregado.

## Testando a versão prévia

A versão 11.0 ainda é uma versão prévia. Na visão de Extensões, abra o C# Dev Kit e escolha **Switch to Pre-Release Version**. Você também pode fazer isso por um terminal:

```bash
code --install-extension ms-dotnettools.csdevkit --pre-release
```

Para conferir os números de memória na sua própria solução, localize o processo consolidado depois que a solução carregar:

```bash
# macOS / Linux: resident memory in KB
ps -A -o rss,comm | grep -i csdevkit
```

Registre regressões em [microsoft/vscode-dotnettools](https://github.com/microsoft/vscode-dotnettools). Uma reescrita desse tamanho terá arestas em alguns layouts de projeto, e a equipe está coletando esses relatos antes da versão estável.

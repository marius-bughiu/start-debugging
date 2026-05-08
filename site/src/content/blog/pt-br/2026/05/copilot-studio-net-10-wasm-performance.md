---
title: "A atualização de Copilot Studio para .NET 10 WebAssembly: 20% no caminho frio, 5% no quente"
description: "A Microsoft moveu o motor WASM do Copilot Studio do .NET 8 para o .NET 10. O pacote dual JIT/AOT, o fingerprinting e o WasmStripILAfterAOT explicam os números."
pubDate: 2026-05-08
tags:
  - "dotnet"
  - "webassembly"
  - "performance"
  - "blazor"
lang: "pt-br"
translationOf: "2026/05/copilot-studio-net-10-wasm-performance"
translatedBy: "claude"
translationDate: 2026-05-08
---

Em 7 de maio de 2026, Daniel Roth publicou um [estudo de caso sobre o Copilot Studio](https://devblogs.microsoft.com/dotnet/copilot-studio-dotnet-10-migration/) no blog do .NET. O destaque: o runtime WebAssembly do Copilot Studio, distribuído como pacote NPM e embutido em várias superfícies do Microsoft 365, agora roda em .NET 10 em produção. A execução no caminho frio está cerca de 20% mais rápida, no caminho quente cerca de 5%, e a migração em si foi basicamente um ajuste de `<TargetFramework>`.

O interessante é como o Copilot Studio empacota dois motores em um único bundle, e o que mudou nas ferramentas de WebAssembly do .NET 10 que tornou o novo build menor onde importa e um pouco maior onde não importa.

## Dois motores, um pacote

O Copilot Studio não escolhe entre JIT ou AOT. Ele envia os dois no mesmo pacote NPM e deixa a página carregá-los em paralelo.

O motor JIT inicia primeiro e começa a atender as interações do usuário imediatamente. O motor AOT, que é maior e mais lento para baixar, termina de carregar em segundo plano. Assim que está pronto, o runtime entrega a sessão ativa para o AOT e o motor JIT é descartado. O usuário vê uma primeira resposta rápida e depois uma experiência silenciosamente mais rápida no resto da conversa.

Essa carga dupla é o motivo pelo qual o Copilot Studio se importa tanto com o compartilhamento de assets entre os dois motores. Qualquer coisa que ambos possam referenciar não deveria ser baixada duas vezes.

## O que o .NET 10 realmente mudou

Duas mudanças no workload de WebAssembly do .NET 10 explicam a maior parte da diferença.

Primeiro, **fingerprinting automático de assets**. No .NET 8, a equipe precisava rodar um passo de PowerShell personalizado para acrescentar um hash SHA256 a cada nome de arquivo WASM e DLL, para que cache e verificações de integridade funcionassem bem. No .NET 10 isso é nativo, e a saída de publicação já produz nomes como `dotnet.runtime.{hash}.js` sem cola de MSBuild personalizada.

Segundo, **`WasmStripILAfterAOT` está ligado por padrão**. Depois da compilação AOT, o IL original dos métodos compilados não é mais enviado. Isso reduz o payload AOT, mas também diminui a quantidade de arquivos que os motores JIT e AOT podem compartilhar, porque os arquivos exclusivos do AOT não carregam mais o IL de que o motor JIT precisaria.

```xml
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <RunAOTCompilation>true</RunAOTCompilation>
  <!-- Defaults to true on net10.0; shown here for clarity. -->
  <WasmStripILAfterAOT>true</WasmStripILAfterAOT>
</PropertyGroup>
```

No .NET 8, 59 arquivos eram compartilhados entre os motores JIT e AOT do Copilot Studio. No .NET 10 esse número caiu para 22. O pacote como um todo cresceu cerca de 15%. Esse é o custo de remover o IL dos métodos AOT: o modelo dual perde parte do ganho de deduplicação.

## Lendo os números com honestidade

A Microsoft é direta sobre o trade-off. Os downloads AOT estão cerca de 6% mais lentos em uma LAN rápida, o que dá aproximadamente 200 ms, e cerca de 17% mais lentos em um link 4G, aproximadamente 5 segundos. Essa penalidade é paga em segundo plano enquanto o JIT já está servindo o usuário, então ela não aparece no time-to-interactive. Aparece, sim, se o usuário se desconectar no meio do carregamento ou rodar o Copilot Studio em uma rede restrita.

Em troca:

- Caminho frio de execução: ~20% mais rápido.
- Caminho quente de execução: ~5% mais rápido.
- Sem mudanças de código além do salto de framework.

Para uma workload que roda dentro das superfícies do Microsoft 365 e é acionada o tempo todo, um ganho de 20% no caminho frio em cada interação importa mais do que cinco segundos de download em segundo plano.

## O que isso significa para seu app Blazor WebAssembly

Se você distribui um app Blazor WebAssembly ou .NET WASM e ainda está no .NET 8, a migração é barata. Suba `TargetFramework` para `net10.0`, restaure, publique e deixe o novo fingerprinting e os defaults de AOT rodarem. Se você tem um passo personalizado de hashing ou de remoção de IL no pipeline, apague.

Se você não distribui motores JIT e AOT duais (a maioria dos apps não distribui), você não vai ver o crescimento de 15% no pacote que o Copilot Studio viu. Você vai obter a economia da remoção de IL sem a perda de deduplicação. Essa é a configuração para a qual os defaults do .NET 10 estão ajustados.

O estudo de caso completo, incluindo os detalhes de implantação e como o Copilot Studio mede esses números em produção, está no [blog do .NET](https://devblogs.microsoft.com/dotnet/copilot-studio-dotnet-10-migration/).

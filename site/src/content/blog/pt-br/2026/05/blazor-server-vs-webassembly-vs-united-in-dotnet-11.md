---
title: "Modos de renderização Blazor no .NET 11: Server, WebAssembly e Auto"
description: "Escolha Blazor Web App ou WebAssembly autônomo conforme hosting, uso offline e serviços, com o comportamento correto de Auto."
pubDate: 2026-05-26
updatedDate: 2026-11-02
tags:
  - "dotnet-11"
  - "comparison"
  - "blazor"
  - "dotnet"
  - "csharp"
  - "aspnetcore"
lang: "pt-br"
translationOf: "2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-26
---

**Correção — 2 de novembro de 2026:** A versão anterior incluía benchmarks não verificados e afirmações incorretas sobre Auto, templates, funcionamento offline e limites de renderização. Elas foram corrigidas. Este artigo não apresenta medições de desempenho do .NET 11.

Para uma nova aplicação Blazor hospedada em servidor, considere **Blazor Web App**. Ela oferece renderização estática e interatividade Server, WebAssembly ou Auto opcional. Se a aplicação precisa ser publicada inteiramente como arquivos estáticos, considere **Blazor WebAssembly autônomo**. “Blazor United” foi um nome inicial da abordagem combinada, não um terceiro runtime instalável.

Nesta revisão, a Microsoft lista [.NET 11 RC3 como pré-lançamento go-live](https://dotnet.microsoft.com/en-us/download/dotnet/11.0). .NET 10 é a versão LTS atual; .NET 11 pertence à linha STS. Escolha a política de suporte do runtime separadamente da arquitetura de renderização.

## Escolha onde o componente executa

| Opção | Útil quando | Custo a considerar |
| --- | --- | --- |
| SSR estático | Conteúdo e formulários de requisição/resposta precisam de HTML do servidor | Sem eventos C# interativos |
| Interactive Server | UI precisa de serviços do servidor e download inicial pequeno | Latência, circuitos e recursos do servidor |
| Interactive WebAssembly | UI interativa deve executar no navegador | Download do runtime, limites do navegador e API de backend |
| Interactive Auto | Os dois ambientes são úteis e suportados | Desenvolver e verificar dois caminhos de execução |
| WebAssembly autônomo | Hospedagem estática ou PWA planejada para offline | Cache e APIs protegidas separadamente |

Auto escolhe o runtime interativo ao instanciar o componente. Pode usar Server inicialmente e WebAssembly em visitas posteriores, após o cache do bundle. **Não transfere um componente em execução de Server para WebAssembly.** Um reinício do servidor não se torna inofensivo por escolher Auto. Consulte as [regras de renderização](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes?view=aspnetcore-11.0).

## Use a família atual de templates

Estes comandos foram verificados nos SDKs 8.0.427 e 10.0.302. No SDK .NET 11, consulte `dotnet new blazor --help` para as opções do build instalado; os comandos não foram executados no .NET 11 nesta correção.

```bash
dotnet new blazor -o ServerDemo --interactivity Server --no-restore
dotnet new blazor -o AutoDemo --interactivity Auto --no-restore
dotnet new blazorwasm -o OfflineDemo --pwa --no-restore
```

A opção Server usa Blazor Web App sem exigir um projeto cliente WebAssembly. Proibir downloads WebAssembly não exige o antigo template `blazorserver`, ausente nos dois SDKs testados. Auto gera um projeto `.Client`; componentes executados em WebAssembly devem fazer parte dele. A [documentação de ferramentas](https://learn.microsoft.com/en-us/aspnet/core/blazor/tooling?view=aspnetcore-11.0) descreve os templates.

Esta página compilou na aplicação Server gerada em ambos os SDKs:

```razor
@page "/counter-check"
@rendermode InteractiveServer

<button @onclick="() => count++">@count</button>

@code {
    private int count;
}
```

SSR estático é o padrão quando nenhum modo interativo é definido ou herdado. Não existe um valor incorporado `@rendermode StaticServer`. Remover a diretiva só basta se o pai não impõe interatividade.

## Limites e serviços importam

Um pai estático pode conter ilhas interativas, inclusive irmãos com modos distintos. Um filho interativo não pode trocar para um modo interativo incompatível com o pai. Parâmetros que cruzam a fronteira estática/interativa precisam ser serializáveis; fragmentos arbitrários não podem atravessá-la.

Componentes Server podem chamar serviços do servidor, mas ainda precisam de autorização e ciclos de vida corretos. Componentes no navegador não devem conter credenciais de banco ou segredos. Registros DI ausentes frequentemente falham em execução, não necessariamente na compilação. Auto precisa de implementações apropriadas nos dois ambientes. Componentes interativos usam prerenderização por padrão; APIs exclusivas do navegador exigem tratamento de ciclo de vida mesmo com WebAssembly.

## Offline, escala e Hybrid são decisões separadas

Um componente WebAssembly dentro de Blazor Web App não torna a aplicação automaticamente offline. Uma PWA autônoma precisa de service worker, recursos em cache, dados locais e estratégia de sincronização. Navegação não armazenada e APIs remotas ainda podem falhar sem conexão.

Interatividade Server exige uma conexão SignalR funcional. A capacidade depende do estado por circuito e da carga; não existe limite universal de 5.000 usuários. WebAssembly transfere UI para o navegador, mas APIs continuam com capacidade finita. Meça inicialização, transferência, latência e memória na própria aplicação; as tabelas anteriores não tinham evidência reproduzível.

[Blazor Hybrid](https://learn.microsoft.com/en-us/aspnet/core/blazor/hybrid/?view=aspnetcore-10.0) executa componentes Razor no runtime .NET nativo de uma aplicação móvel/desktop. Não exige uma aplicação WebAssembly autônoma. Compartilhar componentes por uma biblioteca Razor é outra decisão.

Em aplicações existentes, prefira a menor mudança que resolva um problema medido. O [guia de migração do Framework](/pt-br/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/) aborda também a substituição de `System.Web`.

**Limites da verificação:** Geração dos templates, builds Server e componente contador foram verificados no .NET 8 e 10. Não houve build .NET 11, benchmark de navegador, teste offline ou experimento de ciclo de vida Auto.

## Outras fontes primárias

- [Blazor hosting models](https://learn.microsoft.com/en-us/aspnet/core/blazor/hosting-models?view=aspnetcore-10.0)
- [Blazor PWA](https://learn.microsoft.com/en-us/aspnet/core/blazor/progressive-web-app?tabs=visual-studio)

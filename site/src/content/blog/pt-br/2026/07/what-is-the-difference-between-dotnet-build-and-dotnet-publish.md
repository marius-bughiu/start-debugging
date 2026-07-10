---
title: "Qual é a diferença entre dotnet build e dotnet publish?"
description: "dotnet build compila seu projeto para o ciclo de desenvolvimento interno e usa Debug por padrão. dotnet publish executa o target Publish do MSBuild, usa Release por padrão em net8.0 e versões posteriores, e empacota uma pasta pronta para implantação com os assets web, os runtimes autocontidos, o arquivo único, o trimming e o AOT já resolvidos. Aqui está exatamente o que cada um produz e quando usá-lo."
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "dotnet-cli"
  - "msbuild"
  - "deployment"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish"
translatedBy: "claude"
translationDate: 2026-07-10
---

`dotnet build` compila seu projeto e suas dependências em assemblies IL para o ciclo de desenvolvimento interno, e usa a configuração `Debug` por padrão. `dotnet publish` executa um target diferente do MSBuild que produz uma pasta autocontida pronta para copiar para um servidor, usa a configuração `Release` por padrão para qualquer projeto cujo target seja `net8.0` ou posterior, e é a única forma oficialmente suportada de preparar uma aplicação para implantação. A versão curta: `build` é o que você executa enquanto escreve código, `publish` é o que você executa quando termina e quer algo que possa distribuir. As diferenças que realmente pesam são a troca da configuração padrão e tudo o que o target `Publish` faz e o `Build` não faz, como processar os assets web, empacotar o runtime para as implantações autocontidas e aplicar arquivo único, trimming e AOT.

Tudo o que vem a seguir usa o SDK do .NET 11 (`11.0.100`) com `<TargetFramework>net11.0</TargetFramework>` e C# 14. O comportamento descrito se aplica do SDK do .NET 8 em diante, exceto quando uma versão específica for citada, porque a diferença mais importante, a configuração padrão, mudou no .NET 8.

## Dois targets diferentes do MSBuild, não duas variantes da mesma coisa

Ambos os comandos são invólucros finos sobre o MSBuild, mas invocam targets diferentes, e esse único fato explica quase todas as diferenças que você vai notar.

`dotnet build` executa o target `Build` padrão. Segundo a [referência do dotnet build](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build), executá-lo equivale a `dotnet msbuild -restore` com um nível de detalhe padrão diferente. Ele compila seu código mais suas dependências em um conjunto de binários e para por aí.

`dotnet publish` executa o target `Publish`. A [referência do dotnet publish](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-publish) é explícita em dizer que ele "compila a aplicação, lê suas dependências especificadas no arquivo do projeto e publica o conjunto de arquivos resultante em um diretório", e que sua saída "está pronta para implantação em um sistema de hospedagem". O target `Publish` depende de `Build`, então um publish sempre compila primeiro e depois faz mais trabalho por cima.

Esse "mais trabalho por cima" é a história toda. Quando você entende o que o target `Publish` acrescenta, você entende quando a saída do `build` é suficiente e quando ela vai falhar silenciosamente em produção.

## A configuração padrão é a armadilha em que a maioria tropeça primeiro

Esta é a diferença que custa uma tarde inteira às pessoas, então vem primeiro.

`dotnet build` usa `Debug` por padrão. `dotnet publish` usa `Release` por padrão, mas apenas para projetos cujo target seja `net8.0` ou posterior. Ambos os padrões podem ser sobrescritos com `-c|--configuration`.

```bash
# .NET 11 SDK 11.0.100, project targeting net11.0.
dotnet build      # builds Debug   -> bin/Debug/net11.0/
dotnet publish    # publishes Release -> bin/Release/net11.0/publish/
```

Antes do .NET 8, `dotnet publish` também usava `Debug` por padrão, e muita memória muscular e muitos scripts de CI ainda assumem isso. A Microsoft mudou isso deliberadamente para que o comando cujo trabalho é produzir artefatos de implantação produza artefatos otimizados por padrão. A mudança está documentada em ['dotnet publish' usa a configuração Release](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/8.0/dotnet-publish-config).

A consequência prática: se você faz `dotnet build` e depois copia `bin/Debug/...` para um servidor, você está distribuindo um binário não otimizado, com as otimizações do JIT desativadas e os auxílios de depuração ativados. Se seu pipeline de CI ainda passa `-c Release` para `dotnet publish` "por garantia", isso agora é redundante, mas inofensivo. Se ele passa `-c Debug` por hábito, você está sobrescrevendo o padrão sensato e distribuindo Debug. Leia seu pipeline uma vez e elimine o culto à carga.

## O que cada comando de fato escreve em disco

Os conjuntos de saída se sobrepõem, por isso os comandos parecem intercambiáveis à primeira vista, mas não são a mesma pasta.

`dotnet build` escreve em `bin/<configuration>/<framework>/`, por exemplo `bin/Debug/net11.0/`. Ele emite seu `.dll` de IL, um executável para iniciá-lo em projetos `Exe`, arquivos de símbolos `.pdb`, um `.deps.json` que lista as dependências, um `.runtimeconfig.json` que nomeia o runtime compartilhado e cópias dos DLLs das suas dependências. Para projetos executáveis cujo target seja .NET Core 3.0 ou posterior, a documentação observa que "se não houver nenhuma outra lógica específica de publicação (como a que os projetos Web têm), a saída da compilação deveria ser implantável".

`dotnet publish` escreve em uma subpasta `publish`: `bin/<configuration>/<framework>/publish/` para uma compilação dependente do framework, ou `bin/<configuration>/<framework>/<runtime>/publish/` quando você compila autocontido para um runtime específico. Ele emite os mesmos arquivos base (`.dll` de IL, `.deps.json`, `.runtimeconfig.json`, dependências) mais o que a forma da implantação exigir.

Note que a saída do `publish` vai para um diretório `publish` aninhado justamente para não colidir com a saída comum da compilação. Se você aponta `-o` para uma pasta diretamente abaixo do seu projeto em um projeto web, publicações sucessivas podem aninhar em `publish/publish`, uma aresta conhecida apontada na documentação.

## Por que "a saída da compilação é implantável" é uma meia verdade

A documentação diz que a saída da compilação "deveria ser implantável" para um executável simples, e para uma aplicação de console simples isso é genuinamente verdade. Você pode fazer `dotnet build -c Release`, compactar `bin/Release/net11.0/`, colocar em uma máquina com o runtime do .NET 11 correspondente instalado e executá-lo.

O problema é que a ressalva "se não houver nenhuma outra lógica específica de publicação" cobre muitas aplicações reais. O target `Publish` faz trabalho que o `Build` nunca executa:

- **Assets web.** Projetos ASP.NET Core e Blazor reúnem arquivos estáticos, compilam os componentes Razor, produzem o layout de `wwwroot` e geram os manifestos de static-web-assets durante o publish. Um `build` puro não monta a árvore de conteúdo web implantável da forma que o host espera.
- **Empacotamento do runtime autocontido.** Quando você passa `--self-contained`, o publish copia um runtime do .NET completo para dentro da saída, para que a máquina de destino não precise de nada pré-instalado. `build` nunca empacota um runtime.
- **Ready-to-run, arquivo único, trimming e AOT.** Todas são transformações do momento da publicação, descritas mais abaixo.

Então a regra exata é: para uma biblioteca ou uma aplicação de console trivial, a saída do `build` e a do `publish` são quase o mesmo conjunto de arquivos. Para uma aplicação web, uma implantação autocontida ou qualquer coisa que use as transformações do momento da publicação, apenas `publish` produz algo correto. Quando as pessoas relatam um [erro de não foi possível carregar o arquivo ou assembly em uma aplicação publicada](/pt-br/2026/05/fix-could-not-load-file-or-assembly-in-published-app/), a causa raiz costuma ser que implantaram uma pasta de `build`, ou uma cópia parcial de uma, em vez de uma saída real de `publish`.

## Dependente do framework vs autocontido: uma decisão exclusiva do publish

`dotnet build` compila contra o framework compartilhado e assume que o runtime está presente em tempo de execução. Ele não tem nenhum conceito de empacotar um runtime.

`dotnet publish` deixa você escolher o modelo de implantação. Dependente do framework é o padrão e mantém a saída pequena, exigindo um runtime do .NET correspondente no destino:

```bash
# .NET 11 SDK 11.0.100. Framework-dependent, cross-platform. Target needs .NET 11 installed.
dotnet publish -c Release
```

Autocontido empacota o runtime para que o destino não precise de nada pré-instalado, ao custo de uma saída muito maior e uma compilação por runtime:

```bash
# .NET 11 SDK 11.0.100. Self-contained: the runtime ships inside the output folder.
dotnet publish -c Release -r linux-x64 --self-contained
```

O `-r` (identificador de runtime) torna a saída específica da plataforma: um publish `linux-x64` não roda em `win-x64`. Por isso o caminho de saída autocontido inclui o segmento do runtime (`bin/Release/net11.0/linux-x64/publish/`). Se você distribui para várias plataformas, executa um publish por RID. Essa troca de portabilidade é a mesma que você pesa ao decidir se recorre a [Native AOT e o que ele custa](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/).

## As transformações do momento da publicação que não têm equivalente no build

Quatro propriedades do MSBuild mudam o que o `publish` produz, e nenhuma faz nada significativo durante um `build` puro. Elas são a razão pela qual `publish` existe como comando separado.

**`PublishReadyToRun`** compila seus assemblies para o formato ReadyToRun (R2R), uma forma de compilação antecipada que pré-JITa seu código para cortar o tempo de inicialização enquanto mantém o JIT disponível para mais tarde. É um passo do momento da publicação; veja como ele se compara com as alternativas em [Native AOT vs ReadyToRun vs JIT](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).

**`PublishSingleFile`** empacota a aplicação em um único executável específico da plataforma. Ativá-lo ativa implicitamente `PublishSelfContained`.

**`PublishTrimmed`** remove código de biblioteca que o trimmer não consegue provar ser alcançável, encolhendo uma implantação autocontida. Só se aplica a publicações autocontidas.

**`PublishAot`** executa o compilador ILC para produzir um único binário nativo sem JIT nenhum.

```xml
<!-- .NET 11, C# 14. These belong in the .csproj, not on the build command line. -->
<PropertyGroup>
  <PublishSingleFile>true</PublishSingleFile>
  <PublishTrimmed>true</PublishTrimmed>
  <PublishReadyToRun>true</PublishReadyToRun>
</PropertyGroup>
```

```bash
# .NET 11 SDK 11.0.100. Only 'publish' honors these; 'build' ignores them.
dotnet publish -c Release -r win-x64
```

Execute `dotnet build` em um projeto com essas propriedades definidas e nada acontece: o trimmer não roda, nenhum arquivo único é produzido, o ILC nunca é invocado. As transformações estão ligadas ao grafo de dependências do target `Publish`, não ao do `Build`. Esta é a razão concreta e mecânica pela qual a documentação chama `publish` de "a única forma oficialmente suportada de preparar a aplicação para implantação".

## Pulando a recompilação com --no-build

Como `publish` depende de `Build`, um publish recompila por padrão. Em um pipeline de CI onde você já executou `dotnet build` (para rodar analisadores ou testes contra os binários exatos), recompilar durante o publish desperdiça tempo e, pior, pode produzir saídas sutilmente diferentes. Passe `--no-build` para reutilizar a saída de compilação existente:

```bash
# .NET 11 SDK 11.0.100. Build once with the config you want, then publish that.
dotnet build -c Release
dotnet publish -c Release --no-build
```

Duas coisas para observar. Primeiro, `--no-build` ativa implicitamente `--no-restore`, então o restore já deve ter ocorrido. Segundo, as configurações precisam coincidir: se você faz `dotnet build -c Release` e depois `dotnet publish --no-build` sem `-c Release`, publish procura a saída `Debug` (seu padrão), não encontra uma compilação correspondente e falha. Mantenha o valor de `-c` idêntico nos dois comandos. Se você usa o layout de saída de artefatos (`--artifacts-path`), a documentação observa que você também deve propagar esse mesmo caminho para os dois comandos.

## dotnet run e dotnet test convivem ao lado destes

Ajuda situar os dois comandos dentro da CLI mais ampla. `dotnet run` compila (Debug por padrão) e imediatamente inicia a aplicação; é o invólucro de conveniência do ciclo interno, não uma ferramenta de implantação. `dotnet test` compila e executa seu projeto de testes. `dotnet pack` produz um pacote NuGet em vez de uma aplicação implantável, e como publish usa `Release` por padrão em `net8.0` e versões posteriores. Todos eles executam um `dotnet restore` implícito primeiro, exceto se você passar `--no-restore`. Se seu CI nem sequer encontra o SDK para executar qualquer um destes, esse é um problema de ambiente separado, coberto em [o comando dotnet não foi encontrado no CI](/pt-br/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/).

## Qual executar, decidido em uma linha cada

Use `dotnet build` enquanto desenvolve: para compilar, trazer à tona avisos e diagnósticos do analisador, e produzir binários para seus testes. É rápido, usa Debug por padrão e sua saída é destinada à sua máquina.

Use `dotnet publish` quando quiser um artefato para distribuir: usa Release por padrão, executa os passos específicos da implantação e é o caminho suportado para uma pasta que você possa entregar a um servidor, uma imagem de contêiner ou um binário de Native AOT. Quando você está cortando uma compilação de release no CI, publish (opcionalmente depois de um único `build` compartilhado com `--no-build`) é o comando que produz aquilo que você implanta. Se você também está se movendo entre versões maiores do runtime ao mesmo tempo, combine isso com a [lista de verificação de migração do .NET 8 para o .NET 11](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) para que a saída do publish aponte para o runtime no qual você de fato pretende executar.

O teste de uma única frase: se a saída é para você, `build`; se a saída é para uma máquina que não é a sua, `publish`.

## Relacionados

- [O que é Native AOT e o que ele custa a você?](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Native AOT vs ReadyToRun vs JIT no .NET 11](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [Fix: Não foi possível carregar o arquivo ou assembly em uma aplicação publicada](/pt-br/2026/05/fix-could-not-load-file-or-assembly-in-published-app/)
- [Fix: O comando 'dotnet' não foi encontrado no CI](/pt-br/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/)
- [Migrar do .NET 8 para o .NET 11: a lista de verificação completa](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)

## Fontes

- [Referência do comando dotnet publish](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-publish) (Microsoft Learn)
- [Referência do comando dotnet build](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build) (Microsoft Learn)
- ['dotnet publish' usa a configuração Release por padrão](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/8.0/dotnet-publish-config) (Microsoft Learn)
- [Visão geral da publicação de aplicações .NET](https://learn.microsoft.com/en-us/dotnet/core/deploying/) (Microsoft Learn)

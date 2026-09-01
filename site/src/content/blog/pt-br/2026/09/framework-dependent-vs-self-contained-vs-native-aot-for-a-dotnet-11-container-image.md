---
title: "Dependente de framework vs autocontido vs Native AOT para uma imagem de contêiner do .NET 11"
description: "Dependente de framework sobre uma imagem aspnet chiseled é o padrão certo para um serviço ASP.NET Core no .NET 11, porque a camada do runtime é compartilhada entre serviços e uma CVE do runtime é corrigida trocando a imagem base. Autocontido com trimming e Native AOT compram uma imagem de 2x a 5x menor e uma inicialização a frio bem mais rápida, e custam isso. Tamanhos publicados reais, a conta das camadas compartilhadas e o bug de inferência de imagem base do .NET 11 que quebra o caminho AOT."
pubDate: 2026-09-01
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "containers"
  - "docker"
  - "native-aot"
  - "deployment"
lang: "pt-br"
translationOf: "2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image"
translatedBy: "claude"
translationDate: 2026-09-01
---

Para um serviço ASP.NET Core comum e de longa duração no .NET 11, publique **dependente de framework sobre uma imagem `aspnet` chiseled**. É a menor coisa que você de fato envia (alguns poucos megabytes de aplicação em cima de uma camada de runtime que seus outros serviços já baixaram), e uma CVE do runtime é corrigida recompilando sobre uma nova tag de imagem base em vez de recompilar, testar de novo e implantar de novo a aplicação. Mude para **autocontido com trimming** quando a aplicação precisar fixar um patch específico do runtime ou rodar sobre uma imagem base sem nenhum .NET. Recorra ao **Native AOT** apenas quando a inicialização a frio ou a memória por pod for a restrição dominante e o `dotnet publish` não reportar nenhum aviso de AOT em toda a sua árvore de dependências. Os números de tamanho que as pessoas citam para AOT são reais, mas para uma frota eles medem a coisa errada: imagens dependentes de framework compartilham uma única camada de runtime entre todos os serviços de um nó, e as autocontidas e AOT não.

Tudo aqui tem como alvo `<TargetFramework>net11.0</TargetFramework>`. O .NET 11 está no Preview 7 (`11.0.100-preview.7.26381.103`, lançado em 2026-08-11) enquanto escrevo isto, com [a versão final prevista para novembro de 2026](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview). As tags de imagem da versão prévia carregam um qualificador `-preview` que a versão final remove, então `11.0-preview-resolute-chiseled` hoje vira `11.0-resolute-chiseled` em novembro. Os mecanismos abaixo estão estáveis desde o .NET 8, então quase tudo se aplica sem mudanças no .NET 9 e no .NET 10.

## Os três modos como imagens de contêiner

| Propriedade | Dependente de framework | Autocontido + trimming | Native AOT |
| --- | --- | --- | --- |
| Repositório da imagem base | `dotnet/aspnet` ou `dotnet/runtime` | `dotnet/runtime-deps` | `dotnet/runtime-deps` |
| O runtime mora em | na camada da imagem base | na camada da sua aplicação | compilado dentro do binário |
| Camada de runtime compartilhada entre serviços | Sim | Não | Não |
| Uma CVE do runtime é corrigida com | baixar uma nova tag base, recompilar | novo SDK, recompilar, testar, implantar | novo SDK, recompilar, testar, implantar |
| Avança para o patch instalado | Sim | Não | Não |
| Ativado por | nada (é o padrão) | `--self-contained -p:PublishTrimmed=true` | `-p:PublishAot=true` |
| Precisa de um RID | Não | Sim | Sim |
| A máquina de build precisa de toolchain C | Não | Não | Sim (clang, zlib1g-dev) |
| Reflexão, `Reflection.Emit`, carga de plugins | Completa | Avisos de trimming, falhas possíveis em execução | Restrita ou indisponível |
| Imagem de exemplo, comprimida | 52.81 MB | 21.86 MB | 11.60 MB |

Esses três últimos números vêm do [relatório de tamanho de imagens de contêiner do .NET](https://github.com/dotnet/dotnet-docker/blob/main/documentation/sample-image-size-report.md) em `dotnet/dotnet-docker`, medidos sobre o exemplo `releasesapi` com .NET 10.0 e imagens base `noble-chiseled`. Os detalhes completos daqui a pouco, porque essa linha é a que engana as pessoas.

## O que cada modo realmente coloca na imagem

O tooling de contêineres do SDK infere a imagem base a partir do seu projeto, e a regra é curta. [Conforme a referência de conteinerização](https://learn.microsoft.com/en-us/dotnet/core/containers/publish-configuration), um projeto autocontido recebe `mcr.microsoft.com/dotnet/runtime-deps`, um projeto ASP.NET Core recebe `mcr.microsoft.com/dotnet/aspnet`, e qualquer outro recebe `mcr.microsoft.com/dotnet/runtime`. A tag é a parte numérica do seu TFM, com `ContainerFamily` acrescentado como sufixo.

Essa inferência é a história inteira:

- **Dependente de framework** cai em `aspnet`, que é `runtime-deps` mais o runtime do .NET mais o shared framework do ASP.NET Core. Sua camada guarda assemblies IL e recursos estáticos, tipicamente megabytes de um único dígito.
- **Autocontido** cai em `runtime-deps`, que contém apenas as bibliotecas nativas que o .NET precisa (libc, OpenSSL e companhia) e nenhum .NET. Sua camada carrega o runtime inteiro e o shared framework, e é por isso que trimming importa tanto aqui.
- **Native AOT** também cai em `runtime-deps`, mas sua camada é um único executável nativo sem IL e sem JIT. Repare que o sufixo `-aot` sobre `runtime-deps` não existe mais: ele existia no .NET 8, e no .NET 10 as tags runtime-deps específicas de AOT foram fundidas nas tags `-chiseled` normais. O sufixo `-aot` agora mora nas imagens do **SDK** (`sdk:11.0-preview-aot`, `sdk:11.0-preview-resolute-aot`), que trazem o toolchain de clang e zlib de que o compilador AOT precisa em tempo de build.

Os três herdam o mesmo endurecimento das imagens da Microsoft: o usuário sem privilégios `app` com UID 1654, exposto por `$APP_UID`, e a porta 8080 em vez da 80, ambos [introduzidos no .NET 8](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-8/containers). Imagens chiseled ainda não trazem shell, nem gerenciador de pacotes, nem `curl`, então depuração com `docker exec` e health checks baseados em shell não funcionam em nenhum dos três modos se você escolher uma família chiseled.

## Como publicar cada um dos três

Dependente de framework, sem precisar de RID, direto para uma base ASP.NET Core chiseled:

```bash
# .NET 11 SDK 11.0.100-preview.7. Framework-dependent onto aspnet:11.0-preview-resolute-chiseled.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p ContainerFamily=resolute-chiseled \
  -p ContainerRepository=orders-api
```

Autocontido com trimming. `PublishTrimmed` implica `SelfContained`, mas escreva os dois para que quem ler no futuro não precise lembrar disso:

```bash
# .NET 11 SDK 11.0.100-preview.7. Self-contained + trimmed onto runtime-deps:11.0-preview-resolute-chiseled.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  --self-contained \
  -p PublishTrimmed=true \
  -p ContainerFamily=resolute-chiseled \
  -p ContainerRepository=orders-api
```

Native AOT. `PublishAot` implica autocontido, e precisa do toolchain C da plataforma na máquina de build:

```bash
# .NET 11 SDK 11.0.100-preview.7. Native AOT onto runtime-deps:11.0-preview-resolute-chiseled.
# Requires clang and zlib1g-dev locally, or build inside sdk:11.0-preview-aot.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p PublishAot=true \
  -p ContainerFamily=resolute-chiseled \
  -p ContainerRepository=orders-api
```

Se você prefere fazer isso a partir do CI sem instalar clang no agente, a imagem AOT do SDK é a razão de aquelas tags existirem:

```dockerfile
# .NET 11 preview. Multi-stage AOT build.
FROM mcr.microsoft.com/dotnet/sdk:11.0-preview-resolute-aot AS build
WORKDIR /src
COPY . .
RUN dotnet publish OrdersApi/OrdersApi.csproj -c Release -r linux-x64 -p:PublishAot=true -o /app

FROM mcr.microsoft.com/dotnet/runtime-deps:11.0-preview-resolute-chiseled
WORKDIR /app
COPY --from=build /app/OrdersApi .
USER $APP_UID
ENTRYPOINT ["./OrdersApi"]
```

Para o conjunto completo de propriedades `Container*`, controle de tags e autenticação em registries, veja o passo a passo sobre [publicar uma aplicação .NET 11 como imagem de contêiner sem Dockerfile](/pt-br/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/).

## Os números de tamanho publicados

A Microsoft publica tamanhos medidos para uma web API mínima de exemplo em cada variante de imagem base, então não há necessidade de especular. Estes são os tamanhos comprimidos do exemplo `releasesapi` no .NET 10.0:

| Imagem base | Dependente de framework | Autocontido + trimming | Native AOT |
| --- | --- | --- | --- |
| Ubuntu completo (`10.0`) | 92.48 MB | 61.53 MB | 51.27 MB |
| `10.0-noble-chiseled` | 52.81 MB | 21.86 MB | 11.60 MB |
| `10.0-noble-chiseled-extra` | 67.68 MB | 36.82 MB | 26.56 MB |
| `10.0-alpine` | 51.93 MB | 20.95 MB | 10.69 MB |
| `10.0-alpine-extra` | 66.50 MB | 35.52 MB | 25.25 MB |

Duas coisas saltam dessa tabela na hora. Primeiro, **a família da imagem base é uma alavanca maior do que o modo de implantação**. Mover uma aplicação dependente de framework da imagem Ubuntu completa para `noble-chiseled` economiza 39.67 MB, que é mais do que trocar essa mesma aplicação de dependente de framework para Native AOT na imagem completa economiza (41.21 MB) e não exige nenhum do trabalho de compatibilidade. Se você ainda não passou para chiseled, faça isso primeiro e meça de novo antes de considerar qualquer outra coisa.

Segundo, Native AOT sobre chiseled é mesmo cerca de 4.5x menor do que dependente de framework sobre chiseled. É um ganho genuíno, e para uma função scale-to-zero ou um nó de altíssima densidade é decisivo.

## A conta das camadas compartilhadas que vira o argumento do tamanho

Aqui está a parte que o relatório de tamanho não consegue mostrar, porque ele mede uma imagem isolada.

Imagens de contêiner são camadas endereçadas por conteúdo. Se dez dos seus serviços fazem build `FROM mcr.microsoft.com/dotnet/aspnet:11.0-preview-resolute-chiseled`, todo nó que os executa baixa e armazena aquela camada de runtime exatamente uma vez. O custo marginal do décimo primeiro serviço é a sua própria camada de aplicação, que para um serviço ASP.NET Core dependente de framework são alguns poucos megabytes de IL.

Faça a aritmética para dez serviços em um nó, usando a coluna chiseled acima:

- **Dependente de framework**: cerca de 50 MB de camadas `aspnet` compartilhadas, mais 10 camadas de aplicação de aproximadamente 3 MB. Digamos 80 MB.
- **Autocontido com trimming**: uma camada `runtime-deps` compartilhada de alguns megabytes, mais 10 camadas de aplicação que carregam cada uma sua própria cópia reduzida do runtime. Cerca de 10 x 20 MB, ou seja, uns 200 MB.
- **Native AOT**: o mesmo formato, 10 x 11 MB, ou seja, uns 110 MB.

Autocontido é o pior dos três em escala de frota mesmo ganhando de dependente de framework por 2.4x em uma imagem isolada, porque trimming é por aplicação e não consegue deduplicar entre aplicações. Native AOT é pequeno o bastante para continuar na frente, mas sua vantagem cai de 4.5x para bem menos de 2x. Armazenamento do registry, banda de download entre zonas e pressão de disco do nó seguem esse segundo cálculo, não o primeiro. Meça sua própria frota antes de migrar qualquer coisa por causa de tamanho.

## Patching: quem corrige uma CVE do runtime

Este é o argumento que deveria de fato decidir para a maioria dos times, e é o que a [visão geral de publicação](https://learn.microsoft.com/en-us/dotnet/core/deploying/) diz sem rodeios. Uma aplicação dependente de framework "avança automaticamente para o último patch de segurança do .NET disponível no ambiente", enquanto uma implantação autocontida "não avança" e "o runtime do .NET só pode ser atualizado publicando uma nova versão da aplicação".

Em termos de contêiner:

- **Dependente de framework**: quando a Microsoft publica uma correção de runtime fora de banda, você retagueia, recompila e implanta de novo. Seu código é idêntico byte a byte, então a mudança é mecanicamente segura. Uma automação de atualização de imagem base (Dependabot, Renovate) faz isso sem humano nenhum, e um PR por repositório cobre tudo.
- **Autocontido e Native AOT**: o runtime está dentro da camada da sua aplicação, então a correção exige um SDK novo no agente de build, um rebuild completo e uma bateria completa de testes, por serviço. Para AOT em particular também significa recompilar código nativo, que é o build mais lento que você tem.

Se a sua organização tem um controle de "corrigir CVEs críticas em N dias", essa diferença não é uma nota de rodapé. É a razão para ficar em dependente de framework a menos que algo force a saída.

## Globalização é a chave escondida entre chiseled e chiseled-extra

Imagens `-chiseled`, `-alpine` e as `-distroless` do Azure Linux vêm sem ICU e tzdata, então só funcionam com aplicações em modo de globalização invariante. As variantes `-extra` devolvem ICU, tzdata e `libstdc++`, que é de onde vêm aqueles 15 MB de diferença na tabela de tamanhos.

Para publicações autocontidas e AOT o SDK tenta ajudar: se `InvariantGlobalization` for false ele direciona você para uma variante `-extra`. Para publicações dependentes de framework você escolhe a família, então cabe a você deixar a propriedade coerente:

```xml
<!-- .NET 11, net11.0. Required if you target a plain -chiseled or -alpine base. -->
<PropertyGroup>
  <InvariantGlobalization>true</InvariantGlobalization>
</PropertyGroup>
```

Erre isso e o contêiner morre na inicialização com `Couldn't find a valid ICU package installed on the system`, que tem [o próprio artigo de correção](/pt-br/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/). E o modo invariante não é de graça: comparação de strings sensível a cultura, `ToUpper` e `ToLower` para caracteres não ASCII e consultas de `TimeZoneInfo` mudam de comportamento. Se você localiza qualquer coisa ou formata moeda, pague os 15 MB do `-extra`.

## O problema do .NET 11: a inferência de imagem base ainda diz noble

O tooling de contêineres calcula o codinome do Ubuntu para a tag inferida a partir da versão do SDK, e nas versões prévias do .NET 11 essa consulta só conhece `jammy` (SDK abaixo de 8.0.300) e `noble` (8.0.300 em diante). Como `11.0.100` satisfaz a segunda condição, ela retorna `noble`, mas as imagens do .NET 11 no MCR são publicadas sob `resolute` (Ubuntu 26.04). O resultado, [reportado como dotnet/sdk#53553](https://github.com/dotnet/sdk/issues/53553):

```console
error CONTAINER1015: Unable to access the repository 'dotnet/runtime-deps' at tag '11.0.0-preview.2-noble-chiseled-extra'
```

O raio de impacto é exatamente o dos caminhos de que este artigo trata. Publicação dependente de framework passa ilesa, porque não entra no ramo de inferência de codinome. Publicações autocontidas com trimming e com `PublishAot=true` batem nele. A correção é parar de depender da inferência e nomear a família explicitamente, que é por isso que todos os comandos acima a passam:

```bash
# .NET 11 SDK 11.0.100-preview.7. Explicit family, no codename inference.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p PublishAot=true \
  -p ContainerFamily=resolute-chiseled
```

Definir `ContainerBaseImage` com um nome totalmente qualificado também funciona e ignora `ContainerFamily` por completo. Fixar a família explicitamente é boa prática de qualquer jeito: é o que impede um SDK futuro de mover sua frota silenciosamente para outra distribuição. A [rotação de tags do Ubuntu 26.04](/pt-br/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/) é a mesma lição pelo lado do .NET 10.

## A restrição que decide por você

A maioria dos times nunca chega a pesar tamanhos, porque uma restrição dura decide:

- **Dependências pesadas em reflexão.** Proxies dinâmicos, serializadores baseados em reflexão, contêineres de injeção de dependência que emitem código em execução, carga de plugins. Native AOT está fora e trimming é arriscado. Trate os avisos de publicação como o sinal de vai ou não vai, não a documentação. [Código seguro para trimming](/pt-br/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) é o pré-requisito para os dois.
- **Um relógio de conformidade para remediar CVEs.** Dependente de framework, porque trocar a imagem base é uma mudança mecânica e um rebuild não é.
- **Scale-to-zero ou cobrança por requisição.** A inicialização a frio domina a conta. Native AOT inicia cerca de 3x mais rápido que o JIT comum e usa menos da metade do working set, segundo as medições em [Native AOT vs ReadyToRun vs JIT no .NET 11](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).
- **Um artefato de build para várias plataformas.** Dependente de framework sem RID é o único modo que produz um artefato só; os outros dois são por RID e precisam de uma matriz de build.
- **Uma imagem base sem .NET, que você não controla.** Autocontido, já que é o único modo que roda sobre uma imagem de distribuição arbitrária com as bibliotecas nativas certas e mais nada.

## Recomendação, repetida

Por padrão, **dependente de framework sobre `aspnet:11.0-<family>-chiseled`**. É a imagem mais barata em escala de frota, é o único modo em que uma CVE do runtime é uma troca de imagem base em vez de um release, e é o único que envia um artefato único agnóstico de RID. Vá para **Native AOT sobre `runtime-deps:11.0-<family>-chiseled`** quando a inicialização a frio ou a densidade de memória for a restrição que manda e sua árvore de dependências publicar limpa. Use **autocontido com trimming** como opção intermediária quando precisar fixar a versão do runtime ou uma imagem base sem .NET, entendendo que ele é o pior dos três para o armazenamento de toda a frota. Escolha o que escolher, defina `ContainerFamily` explicitamente, e passe a imagem para chiseled antes de otimizar qualquer outra coisa.

## Relacionado

- [Como publicar uma aplicação .NET 11 como imagem de contêiner com dotnet publish /t:PublishContainer](/pt-br/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) cobre toda a superfície de propriedades `Container*` em que estes comandos se apoiam.
- [Native AOT vs ReadyToRun vs JIT no .NET 11](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) é a comparação de modelos de compilação que fica embaixo desta comparação de empacotamento, com medições de inicialização e throughput.
- [O que é Native AOT e o que ele custa?](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/) enumera as restrições de API e bibliotecas antes de você se comprometer.
- [O que é código seguro para trimming e como eu escrevo isso?](/pt-br/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) é o pré-requisito tanto para autocontido com trimming quanto para AOT.
- [Qual é a diferença entre dotnet build e dotnet publish?](/pt-br/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) explica por que tudo isso acontece só em tempo de publicação.

## Fontes

- [Visão geral de publicação de aplicações .NET](https://learn.microsoft.com/en-us/dotnet/core/deploying/), MS Learn (compromissos entre dependente de framework e autocontido, roll-forward, AOT).
- [Referência de conteinerização de uma aplicação .NET](https://learn.microsoft.com/en-us/dotnet/core/containers/publish-configuration), MS Learn (inferência de `ContainerBaseImage`, `ContainerFamily`, `ContainerUser`).
- [Imagens de contêiner do .NET](https://learn.microsoft.com/en-us/dotnet/core/docker/container-images), MS Learn (repositórios, variantes chiseled e extra, globalização).
- [Relatório de tamanho de imagens de exemplo](https://github.com/dotnet/dotnet-docker/blob/main/documentation/sample-image-size-report.md), `dotnet/dotnet-docker` (tamanhos medidos do exemplo `releasesapi`).
- [A inferência de imagem base usa o codinome errado do Ubuntu para o .NET 11](https://github.com/dotnet/sdk/issues/53553), `dotnet/sdk` (CONTAINER1015, workaround com `ContainerFamily`).
- [Novidades em contêineres para o .NET 8](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-8/containers), MS Learn (usuário `app` sem privilégios, `APP_UID`, porta 8080).
- [Novidades no .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview), MS Learn (status de versão prévia, data da versão final, mudanças de contêiner do SDK).

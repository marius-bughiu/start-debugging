---
title: "Como publicar um aplicativo .NET 11 como imagem de contêiner com dotnet publish /t:PublishContainer"
description: "Guia completo para construir imagens de contêiner a partir de um aplicativo .NET 11 sem Dockerfile: o target PublishContainer, ContainerRepository e ContainerImageTags, a escolha da imagem base com ContainerBaseImage e ContainerFamily, o push para um registro e como a autenticação é resolvida, índices de imagem OCI multiarquitetura, o usuário não root padrão, o controle do entrypoint, a saída em tarball para scanners e os casos em que você ainda precisa de um Dockerfile."
pubDate: 2026-07-27
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "containers"
  - "docker"
  - "devops"
  - "msbuild"
lang: "pt-br"
translationOf: "2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer"
translatedBy: "claude"
translationDate: 2026-07-27
---

Para transformar um aplicativo .NET 11 em uma imagem de contêiner sem escrever um Dockerfile, execute `dotnet publish --os linux --arch x64 /t:PublishContainer` no diretório do projeto. O SDK baixa a imagem base da Microsoft adequada, coloca a saída da publicação por cima e envia o resultado para o daemon local do Docker ou Podman. Adicione `-p ContainerRegistry=ghcr.io` para publicar em um registro real, ou `-p ContainerArchiveOutputPath=./images/app.tar.gz` para obter um tarball sem tocar em nenhum daemon. Tudo o que um Dockerfile expressaria (imagem base, tags, portas, variáveis de ambiente, labels, usuário, entrypoint) é uma propriedade ou um item do MSBuild. Este artigo tem como alvo o .NET 11 (preview 6 no momento em que escrevo, versão final em novembro de 2026) com C# 14 e o SDK 11.0.1xx. Quase tudo funciona igual nos SDKs do .NET 8, 9 e 10, e eu aponto as versões mínimas onde elas importam.

## O que o SDK faz no lugar de um Dockerfile

O modelo mental com que as pessoas costumam chegar está errado de um jeito útil. `PublishContainer` não é um invólucro em volta do `docker build`. Nenhum Dockerfile é gerado nos bastidores, e o Docker não participa em nada da produção da imagem.

O que realmente acontece é que os targets `Microsoft.NET.Build.Containers`, que vêm dentro do SDK, conversam diretamente com a API HTTP do registro:

1. Seu aplicativo é publicado normalmente em `bin/Release/net11.0/<rid>/publish/`.
2. O SDK resolve uma imagem base (por padrão um dos repositórios `mcr.microsoft.com/dotnet/*`) e busca o manifesto e a configuração dela no MCR. Ele não baixa blobs de camadas de que não precisa.
3. Sua pasta de publicação é empacotada em uma única camada tar nova.
4. Uma nova configuração e um novo manifesto de imagem são montados: as camadas base mais a sua, além do entrypoint, do diretório de trabalho, das portas expostas, das variáveis de ambiente, dos labels e do usuário.
5. O resultado é enviado para algum destino. O daemon local por padrão, um registro remoto se você definir `ContainerRegistry`, ou um `tar.gz` em disco se você definir `ContainerArchiveOutputPath`.

Duas consequências aparecem imediatamente. Primeiro, você não precisa de um runtime de contêiner instalado para *construir* uma imagem, apenas para *executá-la* localmente, o que torna isso viável em agentes de CI sem socket do Docker. Segundo, não existe passo `RUN`, porque nenhum contêiner é executado durante a build. Se sua imagem precisa de `apt-get install`, isso vai para uma imagem base própria e você aponta `ContainerBaseImage` para ela.

`/t:PublishContainer` é um target do MSBuild, não uma opção do `dotnet publish`, e é por isso que usa sintaxe do MSBuild. A forma antiga `-p PublishProfile=DefaultContainer` continua funcionando e faz a mesma coisa. Se a distinção entre `dotnet build` e `dotnet publish` estiver nebulosa, [a diferença entre dotnet build e dotnet publish](/pt-br/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) vale cinco minutos, porque tudo aqui depende da saída da publicação.

## Passos para publicar um aplicativo .NET 11 como imagem de contêiner

1. Confirme que você tem o SDK do .NET 11 (`dotnet --info`). A publicação de contêineres funciona a partir do SDK do .NET 7, mas os padrões descritos aqui são os do SDK do .NET 8 em diante.
2. Defina `ContainerRepository` no arquivo do projeto se o nome do assembly não for um nome de imagem válido (letras maiúsculas são o problema mais comum).
3. Execute `dotnet publish --os linux --arch x64 /t:PublishContainer` para construir a imagem e carregá-la no daemon local.
4. Verifique com `docker images` e execute: `docker run --rm -p 8080:8080 my-app:latest`.
5. Adicione `-p ContainerRegistry=<registry>` quando a imagem já estiver correta localmente, depois de autenticar com `docker login <registry>`.
6. Mova para o `.csproj` as configurações que você quer manter em definitivo, para que o CI e as execuções locais concordem.

Esse é todo o ciclo. O resto do artigo é o que cada botão faz e onde estão as arestas.

## Nomes: registro, repositório, tag

O nome de imagem que o SDK produz é montado a partir de propriedades separadas que correspondem às partes de uma referência de imagem completa:

```text
REGISTRY[:PORT]/REPOSITORY[:TAG]
```

- `ContainerRegistry` aponta por padrão para o daemon local. Defina como `ghcr.io`, `myorg.azurecr.io`, `docker.io`, `quay.io` ou um `registry.mycorp.com:5000` privado.
- `ContainerRepository` assume por padrão o `AssemblyName` do projeto. Nomes de imagem precisam ser alfanuméricos minúsculos mais pontos, underscores, hifens e barras, e precisam começar com letra ou número. Um assembly chamado `DotNet.ContainerImage` não é um nome de repositório válido, e é por isso que o tutorial da Microsoft define a propriedade explicitamente.
- `ContainerImageTag` é `latest` por padrão no SDK do .NET 8 e posteriores. Antes disso, o padrão era a `Version` do projeto.

```xml
<!-- .csproj, .NET 11 SDK 11.0.1xx -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <ContainerRegistry>ghcr.io</ContainerRegistry>
  <ContainerRepository>marius-bughiu/orders-api</ContainerRepository>
  <ContainerImageTags>1.4.2;latest</ContainerImageTags>
</PropertyGroup>
```

`ContainerImageTags` (no plural, separado por ponto e vírgula) produz uma imagem por tag, que é o padrão habitual de "versão mais latest móvel". Tags têm limite de 127 caracteres e precisam começar com caractere alfanumérico ou underscore.

A forma plural é uma armadilha real na linha de comando, porque o ponto e vírgula é o separador de listas do MSBuild e tanto o PowerShell quanto o Bash querem opinar. O escape difere por shell:

```bash
dotnet publish --os linux --arch x64 /t:PublishContainer \
  /p:ContainerImageTags='"1.4.2;latest"'
```

```powershell
dotnet publish --os linux --arch x64 /t:PublishContainer /p:ContainerImageTags=`"1.4.2`;latest`"
```

Se essa briga não vale a pena em um script de CI, defina a variável de ambiente `ContainerImageTags`. O MSBuild lê variáveis de ambiente como propriedades, e o shell nunca vê um ponto e vírgula que queira interpretar.

Note também que publicar no Docker Hub exige o nome de usuário no repositório (`myuser/orders-api`), não apenas o nome puro da imagem.

## Escolher uma imagem base sem linha FROM

Por padrão o SDK infere a imagem base a partir do formato do projeto:

- Projetos ASP.NET Core recebem `mcr.microsoft.com/dotnet/aspnet`.
- Projetos self-contained recebem `mcr.microsoft.com/dotnet/runtime-deps`, porque o runtime viaja dentro da saída da publicação.
- Todo o resto recebe `mcr.microsoft.com/dotnet/runtime`.

A tag vem da parte numérica do seu `TargetFramework`, então `net11.0` resolve para a tag `11.0`. Desde o SDK 8.0.200 a inferência também reage a como você publica: um RID `linux-musl-x64` ou `linux-musl-arm64` seleciona as variantes Alpine, e `PublishAot=true` seleciona uma variante chiseled AOT do `runtime-deps`.

Para escolher um *sabor* diferente da imagem da Microsoft, em vez de outra imagem por completo, use `ContainerFamily`. O valor é anexado à tag inferida:

```xml
<PropertyGroup>
  <ContainerFamily>alpine</ContainerFamily>
</PropertyGroup>
```

Isso transforma a tag da imagem base em `11.0-alpine`. O campo é livre e simplesmente concatenado, então confirme que a tag que você está pedindo realmente existe no repositório `mcr.microsoft.com/dotnet/aspnet` (ou `runtime`) antes de se comprometer com ela. `ContainerFamily` é totalmente ignorado quando `ContainerBaseImage` está definido.

Para controle total, defina `ContainerBaseImage` com um nome completo incluindo a tag:

```xml
<PropertyGroup>
  <ContainerBaseImage>mcr.microsoft.com/dotnet/aspnet:11.0-alpine</ContainerBaseImage>
</PropertyGroup>
```

Essa é também a saída de emergência para a falta de suporte a `RUN`: construa uma imagem base uma vez com um Dockerfile que instale o pacote nativo de que você precisa, publique-a e aponte todos os serviços para ela.

Contêineres Windows precisam do mesmo tratamento. Desde o .NET 8, as listas de manifesto da Microsoft não incluem mais variantes Windows, então mirar no Nano Server significa nomear a tag explicitamente, por exemplo `mcr.microsoft.com/dotnet/aspnet:11.0-nanoserver-ltsc2022`.

Se você está combinando isso com Native AOT para chegar a uma imagem realmente pequena, os trade-offs descritos em [o que o Native AOT realmente custa](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/) valem igualmente dentro de um contêiner, e a economia de camadas costuma ser menor do que o custo das restrições de reflexão em compatibilidade de bibliotecas.

## Publicar em um registro e como a autenticação é resolvida

Defina `ContainerRegistry` e o SDK envia pela Docker Registry HTTP API V2 em vez de carregar em um daemon local:

```bash
# .NET 11 SDK
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p ContainerRegistry=ghcr.io \
  -p ContainerRepository=marius-bughiu/orders-api
```

As credenciais são resolvidas pela própria configuração do Docker, nesta ordem de utilidade:

1. `~/.docker/config.json`, ou o diretório indicado pela variável de ambiente `DOCKER_CONFIG`. A seção `auths` (o que o `docker login` escreve) é lida diretamente.
2. Entradas `credHelpers`, que mapeiam um registro para um executável `docker-credential-<name>` no `PATH`. É assim que ACR, ECR e Google Artifact Registry entregam tokens de curta duração.
3. `credsStore`, o helper do chaveiro do sistema operacional.

Se nada disso estiver disponível, por exemplo dentro de um contêiner do SDK sem a configuração do Docker montada, existem duas variáveis de ambiente como último recurso:

```bash
export DOTNET_CONTAINER_REGISTRY_UNAME='<token>'
export DOTNET_CONTAINER_REGISTRY_PWORD="$GITHUB_TOKEN"
```

Duas coisas a saber sobre elas. O prefixo mudou de `SDK_CONTAINER_*` para `DOTNET_CONTAINER_*` no SDK 8.0.400, e artigos desatualizados ainda mostram os nomes antigos. E elas valem para *ambos* os registros, o de origem (MCR, de onde vem a imagem base) e o de destino, o que as torna inadequadas quando cada um precisa de credenciais diferentes. Prefira `docker login`.

Para um registro em HTTP puro em uma rede interna, o SDK 9.0.1xx e posteriores aceitam uma lista permitida separada por vírgulas:

```bash
export DOTNET_CONTAINER_INSECURE_REGISTRIES=localhost:5000,registry.mycorp.com
```

**Novidade no .NET 11:** o SDK agora valida o `realm` do bearer token que um registro devolve no desafio de autenticação antes de segui-lo ([dotnet/sdk#54225](https://github.com/dotnet/sdk/pull/54225)). O realm precisa ser um URI absoluto, precisa ser HTTPS a menos que aquele registro esteja explicitamente listado como inseguro, e não pode resolver para um literal de IP de loopback, privado, link-local ou não especificado. Os hosts do registro e da autenticação ainda podem diferir, que é o padrão OCI normal. É uma mudança que quebra compatibilidade no sentido de que um registro mal configurado ou malicioso que antes "funcionava" agora faz a publicação falhar cedo. Se um registro interno que ia bem começar a falhar no .NET 11, essa validação é a primeira coisa a verificar.

## Imagens multiarquitetura e o índice de imagem OCI

Desde os SDKs 8.0.405, 9.0.102 e 9.0.2xx, o `PublishContainer` consegue produzir uma imagem multiarquitetura de verdade. A regra depende de quais propriedades de RID você define:

- Um único `RuntimeIdentifier` ou `ContainerRuntimeIdentifier` gera uma imagem de arquitetura única, como antes.
- Sem um RID único, mas com vários `RuntimeIdentifiers` ou `ContainerRuntimeIdentifiers`, o SDK publica uma vez por RID e combina os resultados em um [OCI Image Index](https://specs.opencontainers.org/image-spec/image-index/) para que todas as arquiteturas compartilhem um nome só.

```xml
<!-- .NET 11, SDK 11.0.1xx -->
<PropertyGroup>
  <RuntimeIdentifiers>linux-x64;linux-arm64</RuntimeIdentifiers>
  <ContainerRuntimeIdentifiers>linux-x64;linux-arm64</ContainerRuntimeIdentifiers>
</PropertyGroup>
```

```bash
# Note: no --arch, and no -r. Passing either collapses it back to one architecture.
dotnet publish --os linux /t:PublishContainer
```

`ContainerRuntimeIdentifiers` precisa ser um subconjunto de `RuntimeIdentifiers`, ou partes do pipeline de build falham de formas confusas. Imagens multiarquitetura são sempre emitidas em formato OCI, independentemente do que `ContainerImageFormat` diga, porque o esquema de manifesto Docker v2 não tem equivalente do índice de imagem.

Duas notas operacionais. Projetos Blazor WebAssembly podem esbarrar em condições de corrida de build quando os RIDs publicam em paralelo; `ContainerPublishInParallel=false` serializa tudo ao custo de tempo de relógio (SDK 8.0.408, 9.0.300, 10.0 e posteriores). E o .NET 11 preview 6 adicionou suporte multiarquitetura quando o Podman é o motor local ([dotnet/sdk#54575](https://github.com/dotnet/sdk/pull/54575)), algo que antes exigia Docker.

`ContainerImageFormat`, adicionado no .NET 10, permite forçar `Docker` ou `OCI` no caso de arquitetura única. O padrão é inferido da imagem base, e as imagens da Microsoft ainda usam o media type de manifesto do Docker. Defina como `OCI` se alguma ferramenta mais adiante insistir.

## Portas, variáveis de ambiente, labels e o usuário

Estes são items, não propriedades, então vão em um `ItemGroup`:

```xml
<ItemGroup>
  <ContainerPort Include="8080" Type="tcp" />
  <ContainerEnvironmentVariable Include="ASPNETCORE_FORWARDEDHEADERS_ENABLED" Value="true" />
  <ContainerLabel Include="org.contoso.businessunit" Value="orders" />
</ItemGroup>
```

`ContainerPort` é inferido no .NET 8 e posteriores a partir de `ASPNETCORE_URLS`, `ASPNETCORE_HTTP_PORTS` ou `ASPNETCORE_HTTPS_PORTS`, lidas da imagem base ou dos seus próprios items `ContainerEnvironmentVariable`. Como as imagens do ASP.NET Core definem `ASPNETCORE_HTTP_PORTS=8080`, uma web API comum normalmente não precisa de configuração de porta nenhuma.

`ContainerEnvironmentVariable` tem uma limitação real que vale planejar: atualmente não há como defini-la pela CLI, apenas pelo arquivo do projeto ([dotnet/sdk-container-builds#451](https://github.com/dotnet/sdk-container-builds/issues/451)). Tudo que é específico de ambiente pertence, portanto, à configuração do seu orquestrador, não embutido na imagem, que aliás é onde deveria estar de qualquer forma.

Os labels se resolvem quase sozinhos. O SDK escreve as anotações OCI padrão (`org.opencontainers.image.created`, `.version`, `.title`, `.source`, `.revision`, `.base.name`, `.base.digest` e outras) a partir de propriedades existentes do MSBuild. `.source` e `.revision` só aparecem quando `PublishRepositoryUrl` é `true` e o SourceLink está na build. Desligue o conjunto inteiro com `ContainerGenerateLabels=false`, ou um label específico com sua flag `ContainerGenerateLabelsImage*`.

O padrão de usuário é daqueles que surpreendem para o bem. Mirando .NET 8 ou posterior contra as imagens de runtime da Microsoft, o contêiner roda como o usuário sem privilégios `app` no Linux (referenciado por UID através da variável de ambiente `APP_UID`) e como `ContainerUser` no Windows. Esse é o padrão correto e você deve deixá-lo em paz. Ele significa, sim, que o aplicativo não pode escrever em caminhos arbitrários, não pode escutar em portas abaixo de 1024 e não pode ler arquivos cujas permissões pressupõem root. Se você realmente precisa de root, `ContainerUser=root` está lá, e o SDK não verifica se o usuário que você nomear existe na imagem.

`ContainerWorkingDirectory` é `/app` por padrão.

## Controlar o entrypoint

Para a maioria dos aplicativos o binário apphost gerado é o entrypoint e não há nada a fazer. Quando você quer que a imagem execute uma ferramenta em vez do seu aplicativo, use `ContainerAppCommand` mais `ContainerAppCommandArgs`, e `ContainerDefaultArgs` para argumentos que quem chama deve poder sobrescrever:

```xml
<ItemGroup>
  <!-- Semicolons split tokens: this is dotnet ef database update -->
  <ContainerAppCommand Include="dotnet;ef" />
  <ContainerAppCommandArgs Include="database;update" />
</ItemGroup>
```

`ContainerAppCommandInstruction` decide como isso se combina com qualquer `ENTRYPOINT` da imagem base, aceitando `Entrypoint`, `DefaultArgs` ou `None`. `DefaultArgs` é o padrão e o mais sutil: quando não há items `ContainerEntrypoint`, ele pula um entrypoint da imagem base fixado em `dotnet` ou `/usr/bin/dotnet` para te dar controle completo. `ContainerEntrypoint` e `ContainerEntrypointArgs` estão obsoletos desde o .NET 8; use os items de app command no lugar.

## Saída em tarball para pipelines de escaneamento

Pipelines focados em segurança costumam querer escanear antes que algo chegue a um registro. `ContainerArchiveOutputPath` escreve a imagem em um `tar.gz` e não precisa de daemon:

```bash
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p ContainerArchiveOutputPath=./images/orders-api.tar.gz
```

```bash
docker load -i ./images/orders-api.tar.gz
```

O Podman usa `podman load -i` com o mesmo arquivo. Se você informar um diretório em vez de um nome de arquivo, o arquivo se chama `$(ContainerRepository).tar.gz`. Todas as `ContainerImageTags` acabam dentro desse único arquivo, em vez de gerar vários.

## Integrando no GitHub Actions

Tudo se reduz a três passos, porque não há Buildx, nem QEMU, nem Dockerfile para manter sincronizado com o projeto:

```yaml
# .github/workflows/publish.yml
- uses: actions/setup-dotnet@v4
  with:
    dotnet-version: '11.0.x'

- name: Log in to GHCR
  run: echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin

- name: Publish container
  run: >
    dotnet publish src/Orders.Api/Orders.Api.csproj
    --os linux /t:PublishContainer
    -p ContainerRegistry=ghcr.io
    -p ContainerRepository=${{ github.repository_owner }}/orders-api
    -p ContainerImageTag=${{ github.sha }}
```

O `docker login` serve apenas para popular o `~/.docker/config.json`; o push em si é feito pelo SDK sobre HTTPS. Em um runner sem Docker algum, substitua esse passo exportando `DOTNET_CONTAINER_REGISTRY_UNAME` e `DOTNET_CONTAINER_REGISTRY_PWORD`.

## Quando você ainda quer um Dockerfile

Seja honesto quanto aos limites. Recorra a um Dockerfile quando precisar de passos `RUN`, quando uma build multiestágio tiver que compilar recursos que não são .NET (um frontend Node, dependências nativas) no mesmo arquivo, ou quando precisar de controle fino da ordem das camadas para eficiência de cache entre muitas imagens.

Todo o resto, que na prática é a maioria dos serviços ASP.NET Core e worker services, fica melhor com `PublishContainer`. A configuração da imagem vive no mesmo arquivo que o resto da build, não pode sair de sincronia com o TFM, e não há linha `COPY --from=build /app/publish .` para errar. Se você já executa o aplicativo sob o [.NET Aspire](/pt-br/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/), esse é também o mecanismo que o AppHost usa quando coloca um recurso de projeto em contêiner para implantação.

Uma última nota de versão para aplicativos de console: no SDK do .NET 10 e posteriores, um projeto de console consegue publicar um contêiner sem configuração extra. Nos SDKs do .NET 9 e anteriores você precisava de `<EnableSdkContainerSupport>true</EnableSdkContainerSupport>` no arquivo do projeto, e essa propriedade continua sendo o que você define para tipos de projeto que o SDK não habilita automaticamente.

## Relacionados

- [Qual é a diferença entre dotnet build e dotnet publish?](/pt-br/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) para o que de fato vai parar na pasta que vira a sua camada de imagem.
- [O que é Native AOT e quanto ele custa?](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/) antes de perseguir uma imagem menor com `PublishAot`.
- [Native AOT vs ReadyToRun vs JIT no .NET 11](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) para os números de inicialização e tamanho por trás dessa decisão.
- [Como adicionar o .NET Aspire a uma solução ASP.NET Core existente](/pt-br/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/) se os mesmos projetos também precisam de orquestração local.
- [O que é código seguro para trimming e como escrevê-lo?](/pt-br/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) já que o trimming é a outra metade de encolher uma imagem de contêiner.

## Fontes

- [Containerize an app with dotnet publish](https://learn.microsoft.com/en-us/dotnet/core/containers/sdk-publish) no Microsoft Learn.
- [Containerize a .NET app reference](https://learn.microsoft.com/en-us/dotnet/core/containers/publish-configuration), a lista completa de propriedades e items.
- [Authenticating to container registries](https://github.com/dotnet/sdk-container-builds/blob/main/docs/RegistryAuthentication.md) no repositório dotnet/sdk-container-builds.
- [What's new in the SDK and tooling for .NET 10](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/sdk) para `ContainerImageFormat` e o suporte a aplicativos de console.
- [.NET SDK in .NET 11 Preview 5 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/sdk.md) para a validação do realm do bearer token.
- [.NET SDK in .NET 11 Preview 6 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/sdk.md) para o suporte multiarquitetura com Podman.

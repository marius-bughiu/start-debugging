---
title: "Correção: Couldn't find a valid ICU package installed on the system em um contêiner .NET"
description: "Sua imagem base não tem ICU. Instale icu-libs e icu-data-full, mude para uma variante de imagem -extra, ou ative InvariantGlobalization=true e aceite o comportamento ordinal das strings."
pubDate: 2026-07-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "docker"
  - "containers"
  - "globalization"
  - "alpine"
lang: "pt-br"
translationOf: "2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system"
translatedBy: "claude"
translationDate: 2026-07-29
---

A imagem base do seu contêiner não traz o ICU, e o .NET se recusa a iniciar sem ele. Escolha uma de duas respostas. Se o seu aplicativo formata datas, compara strings de forma linguística ou toca qualquer cultura diferente da invariante, instale o ICU: `RUN apk add --no-cache icu-libs icu-data-full` no Alpine, ou mude para uma variante de imagem `-extra` que já o inclui. Se o seu aplicativo realmente nunca precisa de dados de cultura, defina `<InvariantGlobalization>true</InvariantGlobalization>` no arquivo de projeto e mantenha a imagem pequena. Não defina só a variável de ambiente e torça, porque ela é a mais fraca das três chaves.

```text
Process terminated. Couldn't find a valid ICU package installed on the system.
Please install libicu (or icu-libs) using your package manager and try again.
Alternatively you can set the configuration flag System.Globalization.Invariant
to true if you want to run with no globalization support. Please see
https://aka.ms/dotnet-missing-libicu for more information.
```

Tudo abaixo foi verificado no .NET 10 (`10.0`, lançado em 2025-11-11) e nas versões prévias do .NET 11. O mecanismo é idêntico desde o .NET 5, então as mesmas correções valem sem alteração para imagens `net8.0` e `net9.0`. Só mudam os nomes dos pacotes e as tags de imagem.

## Por que o runtime mata o processo em vez de degradar

A pilha de globalização do .NET no Unix é uma camada fina sobre o ICU (International Components for Unicode). Dados de cultura, comparação linguística de strings, regras de maiúsculas e minúsculas além do ASCII, formatação de calendários, tratamento de IDN: tudo isso vem de `libicuuc` e `libicui18n`, que não fazem parte do .NET. São uma dependência nativa que a sua imagem base deveria fornecer.

Na inicialização, o construtor estático de `GlobalizationMode` percorre uma lista fixa de decisões:

1. O modo de globalização invariante está ligado? Se sim, o ICU é ignorado por completo e os dados invariantes embutidos são usados.
2. O ICU local ao aplicativo está configurado? Se sim, carrega `libicuuc.so.<version>` e `libicui18n.so.<version>` do diretório do aplicativo.
3. A variável `DOTNET_ICU_VERSION_OVERRIDE` está definida? Se sim, tenta exatamente essa versão.
4. Caso contrário, carrega a maior versão do ICU instalada no sistema.

Se o passo 4 não encontra nada, o runtime chama `Environment.FailFast`. É esse o detalhe que confunde as pessoas: isso não é uma exceção. Não existe `try`/`catch` que salve você, nem gancho em `AppDomain.UnhandledException`, nem recuo elegante para o modo invariante. O processo aborta antes de o `Main` engrenar de verdade, o que no Linux aparece como SIGABRT e código de saída 134 no contêiner. O projeto é deliberado: degradar em silêncio para comparação ordinal de strings mudaria ordenação, caixa e análise de datas de formas que produzem dados errados em vez de uma falha barulhenta.

As imagens com maior chance de cair nisso são justamente as que você escolheu por serem pequenas. Alpine, Azure Linux distroless e Ubuntu chiseled omitem ICU e tzdata, e a documentação de contêineres do .NET é explícita ao dizer que essas imagens só funcionam com aplicativos configurados para o modo de globalização invariante. As imagens completas de Debian e Ubuntu já incluem o ICU, e é por isso que o aplicativo funcionava na sua máquina e na imagem `sdk`, e morreu no instante em que chegou ao estágio de runtime.

## A reprodução mínima

Dois estágios, uma compilação padrão com o SDK, um runtime Alpine. Este Dockerfile já basta:

```dockerfile
# .NET 10. Fails at startup with the ICU error.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

O aplicativo em si não precisa fazer nada exótico. A falha acontece durante a inicialização do runtime, antes de o seu código rodar, então até isto quebra:

```csharp
// .NET 10, C# 14. Never reaches the WriteLine.
Console.WriteLine("hello");
```

Vale internalizar isso, porque o primeiro instinto é caçar a chamada a `CultureInfo` que causou o problema. Ela não existe. A inicialização da globalização é ansiosa.

## Correção 1: instalar o ICU na imagem

Essa é a correção certa para a maioria dos aplicativos, e é a que os exemplos de contêiner do .NET documentam. No Alpine:

```dockerfile
# .NET 10 on Alpine 3.22. Adds ICU and disables invariant mode.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine
RUN apk add --no-cache icu-libs icu-data-full
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false \
    LC_ALL=en_US.UTF-8 \
    LANG=en_US.UTF-8
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

`icu-data-full` não é enfeite opcional. Desde o Alpine 3.16 o pacote de dados do ICU foi dividido e o `icu-libs` sozinho traz apenas a localidade `en`, o que produz uma falha bem mais confusa do que aquela com que você começou: o runtime sobe normalmente e, em seguida, toda cultura que não seja inglês passa a formatar silenciosamente como inglês. Testes que verificam formatos de data `fr-FR` começam a falhar sem nenhuma mensagem de erro. Instale os dois pacotes.

A linha `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false` só importa se algo acima na cadeia tiver colocado o valor em `true`, o que várias imagens base e templates de CI fazem. Defini-la explicitamente não custa nada e elimina uma classe inteira de bugs de ambiente herdado.

O equivalente em imagens baseadas em Debian ou Ubuntu, que você só precisaria para uma imagem `runtime-deps` montada por você:

```dockerfile
# .NET 10 on Ubuntu 24.04 (noble).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libicu74 tzdata \
    && rm -rf /var/lib/apt/lists/*
```

Fixe o nome do pacote `libicu` no que a sua versão da distribuição realmente carrega (`libicu74` no Ubuntu 24.04, `libicu72` no Debian bookworm). Se você prefere não acompanhar isso, `apt-get install -y libicu-dev` puxa a biblioteca de runtime correta ao custo de uma camada maior.

## Correção 2: mudar para uma variante de imagem `-extra`

A Microsoft publica imagens otimizadas para tamanho em três sabores, e o sufixo de recurso `-extra` é exatamente "a imagem pequena, mais ICU, tzdata e `libstdc++`". Se você está em chiseled ou Azure Linux, isso vira uma linha em vez de uma instalação de pacotes:

```dockerfile
# .NET 10, Ubuntu chiseled with globalization support.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled-extra
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

Existe uma assimetria de disponibilidade que vale conhecer antes de planejar em cima disso. Para Ubuntu chiseled e Azure Linux, o `-extra` existe nos repositórios `runtime-deps`, `runtime` e `aspnet`. Para Alpine, o `-extra` é publicado apenas em `runtime-deps`, o que significa que você só pode usá-lo com uma publicação autocontida ou Native AOT. Um aplicativo Alpine dependente do framework precisa instalar os pacotes na mão, como na Correção 1.

Se você constrói imagens com o suporte a contêineres embutido no SDK em vez de um Dockerfile, selecione a variante por `ContainerFamily` em vez de uma linha `FROM`:

```xml
<!-- .NET 10 SDK. Applies to dotnet publish /t:PublishContainer. -->
<PropertyGroup>
  <ContainerFamily>noble-chiseled-extra</ContainerFamily>
</PropertyGroup>
```

Isso se conecta ao mesmo fluxo descrito em [publicar um aplicativo .NET como imagem de contêiner com PublishContainer](/pt-br/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/), e mantém a escolha da imagem base no arquivo de projeto, onde vive o resto da sua configuração de publicação.

## Correção 3: ligar a globalização invariante, deliberadamente

Se o aplicativo realmente não depende de cultura (uma API interna trocando timestamps ISO-8601 e números em formato invariante é o caso clássico), o modo invariante não é uma gambiarra, é a configuração correta. Ele remove a dependência por completo e compra uma imagem menor e uma inicialização mais rápida.

```xml
<!-- .NET 10, C# 14. -->
<PropertyGroup>
  <InvariantGlobalization>true</InvariantGlobalization>
</PropertyGroup>
```

Defina no arquivo de projeto, não no Dockerfile. Conforme o documento de design do modo de globalização invariante do runtime, os valores do arquivo de projeto e do `runtimeconfig.json` têm precedência sobre `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT`, então a propriedade do MSBuild é a que sempre vence e a variável de ambiente é a que perde em silêncio. O arquivo de projeto também viaja com o aplicativo: ninguém consegue jogar o seu contêiner em outro orquestrador, esquecer o bloco de ambiente e ressuscitar a falha.

Saiba com o que você está concordando. No modo invariante:

- `ToUpper` e `ToLower` só transformam o intervalo ASCII. As regras de caixa do I turco com e sem ponto somem.
- `String.Compare`, `IndexOf` e `LastIndexOf` fazem comparação ordinal, não importa qual `CompareOptions` ou `StringComparison` você passe. A ordenação linguística vira silenciosamente ordenação por bytes.
- `String.Normalize` devolve a string inalterada.
- Nomes de exibição de fusos horários no Linux caem para o nome padrão em vez do nome localizado do ICU.
- `TimeZoneInfo.TryConvertIanaIdToWindowsId` e o inverso falham, porque dependem do ICU.
- A enumeração de culturas devolve exatamente uma cultura, e todos os LCIDs colapsam para `0x1000`.

A mudança que mais dói na prática é a criação de culturas. Desde o .NET 6, `PredefinedCulturesOnly` vale `true` por padrão no modo invariante, então `new CultureInfo("fr-FR")` lança:

```text
System.Globalization.CultureNotFoundException: Only the invariant culture is supported
in globalization-invariant mode.
```

Se você precisa que a construção funcione (um middleware de localização de requisições que analisa `Accept-Language` faz isso mesmo quando você nunca usa o resultado), dá para relaxar a regra:

```xml
<!-- .NET 10. Cultures can be created, but all behave as invariant. -->
<PropertyGroup>
  <InvariantGlobalization>true</InvariantGlobalization>
  <PredefinedCulturesOnly>false</PredefinedCulturesOnly>
</PropertyGroup>
```

Isso para a exceção. Não restaura o comportamento específico de cultura: toda cultura que você criar se comporta exatamente como a invariante. `1234.56m.ToString("C", new CultureInfo("de-DE"))` continua devolvendo a forma monetária invariante com o sinal genérico de moeda, não um valor em euros formatado à alemã. Tratar essa dupla como "a correção" para um aplicativo de fato localizado é o caminho para publicar um aplicativo cuja saída está errada em todo lugar exceto en-US.

## Correção 4: levar o seu próprio ICU com ICU local ao aplicativo

A opção de nicho, mas legítima: fixar uma versão exata do ICU e enviá-la junto do aplicativo, para que o comportamento seja idêntico byte a byte em todo host onde você implantar. Saltos de versão do ICU mudam os dados do CLDR, e os dados do CLDR mudam ordenação e formatação, então um aplicativo com testes de arquivo de referência sobre saída formatada pode ser desestabilizado por uma atualização de imagem base que ele nunca pediu.

```xml
<!-- .NET 10. Ships ICU 72.1 with the app instead of using the system copy. -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="System.Globalization.AppLocalIcu" Value="72.1" />
  <PackageReference Include="Microsoft.ICU.ICU4C.Runtime" Version="72.1.0.3" />
</ItemGroup>
```

Com a chave ligada, o .NET carrega `libicuuc.so.72.1` e `libicui18n.so.72.1` dos caminhos de sondagem nativos do aplicativo e nunca olha para a cópia do sistema. A variável de ambiente correspondente é `DOTNET_SYSTEM_GLOBALIZATION_APPLOCALICU`, e o formato do valor é `<version>` ou `<suffix>:<version>`, onde o sufixo corresponde a uma build customizada do ICU. Se as bibliotecas estiverem ausentes, você recebe uma falha diferente e mais específica: `Failed to load app-local ICU: <library name>`. Faça a versão do `PackageReference` bater com o valor da chave ou é exatamente isso que você vai ver.

## Armadilhas que levam à correção errada

**`ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false` no Dockerfile não fez nada.** Confira o arquivo de projeto. Se `<InvariantGlobalization>true</InvariantGlobalization>` estiver definido lá ou no `runtimeconfig.json`, ele tem precedência e a sua variável de ambiente é inerte. Faça um grep na solução inteira, incluindo o `Directory.Build.props`, onde costuma morar uma otimização de tamanho bem-intencionada.

**`Failed to load system ICU: libicuuc.so.<n>` em vez da mensagem acima.** Esse é outro ramo. Significa que o ICU foi encontrado pela sondagem de versão, mas o soname específico não pôde ser carregado, normalmente por instalação parcial ou incompatibilidade de arquitetura (uma camada `amd64` rodando sob emulação `arm64`). Verifique com `ldconfig -p | grep icu` dentro do contêiner.

**O erro só aparece em publicações Native AOT ou com trimming.** Então provavelmente não é a imagem. `PublishAot` e `PublishTrimmed` interagem com feature switches, e `InvariantGlobalization` é um dos que costumam ser ligados por tamanho nos templates de AOT. A mesma classe de problema de "o SDK mudou uma chave nas suas costas" é tratada em [por que a serialização baseada em reflexão é desativada](/pt-br/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/) e no tratamento mais amplo de [código trim-safe](/pt-br/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/).

**As datas formatam certo, mas os fusos horários não resolvem.** ICU e tzdata são pacotes separados. `TimeZoneInfo.FindSystemTimeZoneById` lê `/usr/share/zoneinfo`, que as imagens otimizadas para tamanho também omitem. Instale `tzdata` junto com `icu-libs`, ou use a variante `-extra`, que inclui os dois.

**Tudo funciona, exceto os testes específicos de cultura.** Você instalou `icu-libs` sem `icu-data-full` no Alpine. Só os dados de `en` estão presentes.

**A imagem do SDK funciona, a de runtime não.** É o esperado. As imagens `sdk` são baseadas em Debian por padrão e carregam o ICU; o seu estágio final `aspnet` ou `runtime` é o que precisa da dependência. Diagnostique dentro da camada de runtime real, não na camada de build.

Para confirmar em qual modo você acabou, sem adivinhar:

```csharp
// .NET 10, C# 14. Prints 1 in invariant mode, several hundred with ICU loaded.
using System.Globalization;

Console.WriteLine(CultureInfo.GetCultures(CultureTypes.AllCultures).Length);
Console.WriteLine(AppContext.TryGetSwitch("System.Globalization.Invariant", out bool inv) && inv);
```

## Relacionado

- [Como publicar um aplicativo .NET 11 como imagem de contêiner com dotnet publish /t:PublishContainer](/pt-br/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)
- [O que é Native AOT e quanto ele custa para você?](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Fix: PlatformNotSupportedException: Operation is not supported on this platform em Native AOT](/pt-br/2026/05/fix-platformnotsupportedexception-in-native-aot/)
- [O que é código trim-safe e como eu escrevo isso?](/pt-br/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)
- [Como reduzir o tempo de partida fria de uma AWS Lambda em .NET 11](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)

## Fontes

- [Modo de globalização invariante do .NET](https://github.com/dotnet/runtime/blob/main/docs/design/features/globalization-invariant-mode.md), para a lista de comportamentos e a precedência das configurações - dotnet/runtime
- [`GlobalizationMode.Unix.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Globalization/GlobalizationMode.Unix.cs), para a ordem de carga e o `FailFast` quando falta ICU - dotnet/runtime
- [Configurações de globalização](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/globalization) - MS Learn
- [Globalização do .NET e ICU](https://learn.microsoft.com/en-us/dotnet/core/extensions/globalization-icu), para ICU local ao aplicativo e a sequência de sondagem no Linux - MS Learn
- [Habilitar globalização em imagens de contêiner .NET](https://github.com/dotnet/dotnet-docker/blob/main/samples/enable-globalization.md) - dotnet/dotnet-docker
- [Variantes de imagem do .NET](https://github.com/dotnet/dotnet-docker/blob/main/documentation/image-variants.md), para saber quais repositórios publicam `-extra` - dotnet/dotnet-docker
- [Imagens de contêiner do .NET](https://learn.microsoft.com/en-us/dotnet/core/docker/container-images) - MS Learn
- [Instalar o .NET no Alpine](https://learn.microsoft.com/en-us/dotnet/core/install/linux-alpine), para a lista de dependências incluindo `icu-data-full` - MS Learn
- [Alpine 3.16 icu-libs agora contém apenas en](https://github.com/dotnet/dotnet-docker/issues/3844) - dotnet/dotnet-docker
- [Criação de culturas e mapeamento de caixa no modo de globalização invariante](https://learn.microsoft.com/en-us/dotnet/core/compatibility/globalization/6.0/culture-creation-invariant-mode) - MS Learn

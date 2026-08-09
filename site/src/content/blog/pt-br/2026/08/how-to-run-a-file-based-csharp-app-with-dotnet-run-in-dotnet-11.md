---
title: "Como executar um app C# baseado em arquivo com `dotnet run app.cs` no .NET 11"
description: "Guia completo dos apps C# baseados em arquivo: executar um único arquivo .cs com dotnet run, as diretivas #:package, #:sdk, #:property, #:project e #:include, scripts multiarquivo com #:ref, tratamento de argumentos e stdin, o cache de build, publicação com native AOT, empacotamento como ferramenta do dotnet e dotnet project convert quando o script cresce demais."
pubDate: 2026-08-09
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "dotnet-10"
  - "dotnet-cli"
  - "file-based-apps"
lang: "pt-br"
translationOf: "2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-09
---

Para executar um arquivo C# sem projeto, salve-o como `app.cs` e execute `dotnet run app.cs`. É só isso. O SDK sintetiza um projeto em memória, restaura, compila para um diretório de cache dentro da sua pasta temporária e executa o resultado. Você não precisa de um `.csproj`, nem de uma classe `Program`, nem de um método `Main`. A configuração que normalmente ficaria no arquivo de projeto vai em diretivas `#:` no topo do arquivo-fonte: `#:package Humanizer@2.14.1` adiciona uma referência NuGet, `#:sdk Microsoft.NET.Sdk.Web` transforma o script em um app web e `#:property PublishAot=false` define qualquer propriedade do MSBuild. Os apps baseados em arquivo chegaram no SDK do .NET 10 e ganharam suporte multiarquivo no .NET 11. Este artigo cobre toda a superfície, incluindo as partes que surpreendem: onde a saída do build realmente vai parar, por que um `.csproj` no seu diretório de trabalho sequestra o comando silenciosamente e quais diretivas exigem qual versão do SDK.

Tudo marcado como "verificado" abaixo foi executado no SDK 10.0.201 (runtime .NET 10.0.5) no Windows. O .NET 11 está no Preview 6 no momento em que este texto foi escrito, com GA prevista para novembro de 2026, e os recursos do .NET 11 são indicados por versão quando diferem.

## Passos para executar um app C# baseado em arquivo

1. Salve seu código em um arquivo com extensão `.cs`, usando instruções de nível superior. Sem `class`, sem `Main`.
2. Adicione quaisquer diretivas `#:` no topo do arquivo: `#:package` para referências NuGet, `#:sdk` para trocar de SDK, `#:property` para propriedades do MSBuild.
3. Execute `dotnet run app.cs` a partir de um diretório que não contenha um arquivo de projeto.
4. Passe argumentos para o seu app depois de um separador `--`: `dotnet run app.cs -- arg1 arg2`.
5. Quando o script crescer além de um único arquivo, execute `dotnet project convert app.cs` para gerar um `.csproj` equivalente.

O resto deste artigo detalha cada passo e cobre o comportamento que você só descobre esbarrando nele.

## A menor coisa que executa

As instruções de nível superior são o ponto de entrada. `args` está em escopo sem cerimônia alguma:

```csharp
// app.cs -- verified on SDK 10.0.201
Console.WriteLine($"args: {string.Join(",", args)}");
Console.WriteLine($"tfm: {System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription}");
Console.WriteLine($"asm: {System.Reflection.Assembly.GetEntryAssembly()?.GetName().Name}");
```

```bash
dotnet run app.cs -- one two
```

```
args: one,two
tfm: .NET 10.0.5
asm: app
```

Repare no nome do assembly: `app`, tirado do nome do arquivo. Isso importa mais adiante, porque o diretório do cache de build, o ID de user secrets e o nome da ferramenta empacotada são todos derivados dele.

Há três formas equivalentes de invocar isso. `dotnet run app.cs` é a forma comum. `dotnet run --file app.cs` é a forma explícita, que é a que você quer em scripts porque não é ambígua. E `dotnet app.cs` é a forma abreviada. As três produziram saída idêntica nos testes.

Você também pode pular o arquivo por completo e enviar o código-fonte pela entrada padrão usando `-` como argumento:

```bash
echo 'Console.WriteLine("hello from stdin!");' | dotnet run -
```

Isso imprime `hello from stdin!`. Com `-`, o SDK não varre o diretório de trabalho em busca de perfis de inicialização ou outros arquivos, embora o diretório atual continue sendo o diretório de trabalho do build. É uma saída de emergência genuinamente útil para scripts de shell que geram C#.

## O que o SDK realmente gera

A forma mais clara de entender um app baseado em arquivo é olhar o projeto que o SDK compila em seu nome. `dotnet project convert` o escreve em disco. Para um arquivo que não contém nada além de `Console.WriteLine("plain");`, o projeto gerado é:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <PublishAot>true</PublishAot>
    <PackAsTool>true</PackAsTool>
    <UserSecretsId>plain-c7cf82264bd176cef60e04b947ef58d1b133625432bf800179babd82aa79722e</UserSecretsId>
  </PropertyGroup>

</Project>
```

Quatro desses padrões merecem ser internalizados. `ImplicitUsings` e `Nullable` estão ambos habilitados, e é por isso que `Console` resolve sem um `using System;` e por isso que o compilador vai reclamar de nulidade em um script descartável. `PublishAot` é **true** por padrão, então `dotnet publish app.cs` produz um executável nativo a menos que você desative. E `PackAsTool` é true por padrão, então `dotnet pack app.cs` te dá um pacote instalável via `dotnet tool install` sem configuração extra. O `UserSecretsId` é um hash estável do caminho completo do arquivo, o que significa que user secrets funcionam de cara mas param de resolver se você mover o arquivo.

`TargetFramework` acompanha o SDK que você tem instalado. No SDK 10.0.201 é `net10.0`; em um SDK do .NET 11 é `net11.0`. Fixe explicitamente com `#:property TargetFramework=net10.0` se isso importa para você.

## As cinco diretivas

As diretivas ficam no topo do arquivo, com o prefixo `#:`. O conjunto documentado é `#:include`, `#:package`, `#:project`, `#:property` e `#:sdk`.

`#:package` adiciona uma referência NuGet. A versão vem depois de um `@`:

```csharp
// pkg.cs -- verified on SDK 10.0.201
#:package Humanizer@2.14.1

using Humanizer;
Console.WriteLine(TimeSpan.FromMinutes(90).Humanize(2));
```

Isso imprime `1 hour, 30 minutes`. Use `@*` para flutuar para a versão mais recente. Omitir a versão por completo só funciona quando um arquivo `Directory.Packages.props` te coloca sob gerenciamento centralizado de pacotes; caso contrário, fixe-a ou use `@*`.

`#:sdk` troca o SDK do MSBuild, que é como você obtém um app web a partir de um único arquivo:

```csharp
// web.cs
#:sdk Microsoft.NET.Sdk.Web
#:property PublishAot=false

var app = WebApplication.Create();
app.MapGet("/", () => "ok");
app.Run();
```

`#:sdk` também aceita uma versão, como em `#:sdk Aspire.AppHost.Sdk@13.0.2`. Trocar para `Microsoft.NET.Sdk.Web` também muda os globs de itens padrão: os arquivos de configuração `*.json` no diretório são incluídos automaticamente.

`#:property` define qualquer propriedade do MSBuild, e não se limita a literais. Funções de propriedade do MSBuild funcionam, então você pode ler variáveis de ambiente com um valor de fallback:

```csharp
#:property LogLevel=$([MSBuild]::ValueOrDefault('$(LOG_LEVEL)', 'Information'))
```

`#:project` referencia um arquivo de projeto real ou um diretório que contenha um, e é a ponte de volta para uma solução normal:

```csharp
#:project ../SharedLibrary/SharedLibrary.csproj
```

## Scripts multiarquivo e a versão de SDK que os condiciona

`#:include` traz outros arquivos para a mesma compilação. O mapeamento é por extensão: `*.cs` vira `Compile`, `*.resx` vira `EmbeddedResource`, `*.json` vira `None` e `*.razor` vira `Content`. Caminhos literais, padrões glob e propriedades do MSBuild funcionam:

```csharp
#:include helpers.cs
#:include models/customer.cs
#:include shared/**/*.cs
```

A restrição crítica: arquivos `.cs` incluídos podem adicionar tipos, métodos e namespaces, mas **não** podem conter instruções de nível superior. Só o arquivo de entrada as tem.

`#:include` exige o SDK do .NET 10.0.300 ou o .NET 11 Preview 3 em diante. Em um SDK mais antigo você recebe uma rejeição seca em vez de uma mensagem útil sobre versão. No 10.0.201 o erro exato é:

```
inc.cs(1): error: Unrecognized directive 'include'.
```

Se você vir isso, confira `dotnet --version` antes de sair procurando um erro de digitação. Essa é a mesma lacuna que fez de [`#:include` no .NET 10 um marco notável](/pt-br/2026/01/net-10-file-based-apps-just-got-multi-file-scripts-include-is-landing/) quando chegou.

O .NET 11 Preview 5 adicionou uma segunda forma, diferente, de abranger vários arquivos: [a diretiva `#:ref`](/pt-br/2026/06/dotnet-11-preview-5-file-based-apps-ref-directive/), que referencia outro app baseado em arquivo como *biblioteca* em vez de fundi-lo em uma única compilação, com suporte a referências transitivas ([dotnet/sdk#53480](https://github.com/dotnet/sdk/pull/53480)). O mesmo preview removeu as feature flags de `#:include` e `#:exclude` ([dotnet/sdk#53775](https://github.com/dotnet/sdk/pull/53775)) e fez as diretivas dentro de arquivos incluídos serem processadas de forma transitiva ([dotnet/sdk#54012](https://github.com/dotnet/sdk/pull/54012)). O Preview 6 estendeu `#:include` para assemblies compilados, então `#:include ./libs/MyLibrary.dll` agora funciona sem flag.

Dois detalhes de comportamento dessas notas de preview são fáceis de deixar passar. Entradas duplicadas de `#:project` e `#:ref` são permitidas, seguindo a semântica de itens do MSBuild. Diretivas duplicadas de outros tipos entre arquivos incluídos produzem um diagnóstico em vez de serem aceitas silenciosamente, embora o Preview 6 tenha relaxado isso para `#:sdk`, `#:property` e `#:package` quando os valores duplicados coincidem. Note que `#:ref` e `#:exclude` estão documentadas nas notas de versão do SDK mas ainda não aparecem no [artigo do MS Learn sobre apps baseados em arquivo](https://learn.microsoft.com/en-us/dotnet/core/sdk/file-based-apps), então trate as notas de versão como autoritativas para essas duas.

## Argumentos, variáveis de ambiente e para onde vai a saída

Argumentos após `--` são encaminhados ao seu app em vez de consumidos pela CLI. Variáveis de ambiente podem ser definidas inline com `-e`:

```bash
dotnet run -e FOO=bar env.cs
```

Isso imprime `FOO=bar` a partir de `Environment.GetEnvironmentVariable("FOO")`. As notas de versão do .NET 11 listam `dotnet run -e` como uma opção nova do SDK, mas ela já funcionava no SDK 10.0.201 testado aqui.

A saída do build não fica ao lado do seu arquivo. Ela vai para um diretório endereçado por conteúdo dentro da pasta temporária do sistema, no formato `<temp>/dotnet/runfile/<appname>-<sha>/bin/<configuration>/`. O caminho verificado no Windows:

```
C:\Users\...\AppData\Local\Temp\dotnet\runfile\app-82b0b938fb24db69...\bin\debug\app.dll
```

Redirecione com `--output` no `dotnet build`, ou defina um padrão no próprio arquivo com `#:property OutputPath=./output`.

## O cache de build é toda a história de desempenho

O SDK faz cache da saída do build com chave baseada no conteúdo do arquivo-fonte, na configuração de diretivas, na versão do SDK e na existência e conteúdo dos arquivos de build implícitos. A diferença é grande o suficiente para mudar a sensação da ferramenta. Medido no SDK 10.0.201, mesma máquina, mesmo script trivial:

| Invocação | Tempo de relógio |
| --- | --- |
| Primeira execução após `dotnet clean app.cs` | 1,174 s |
| Execução com cache | 0,252 s |

Um quarto de segundo está dentro da faixa em que um arquivo `.cs` é um substituto viável para um script de shell. Um build a frio não está.

Três comportamentos do cache causam confusão. Mudanças em arquivos de build implícitos como `Directory.Build.props` nem sempre disparam um rebuild. Mover um arquivo para outro diretório não invalida o cache. E usar um padrão glob em `#:include` atualmente desabilita o cache de build por completo, então uma linha `shared/**/*.cs` silenciosamente te custa o caminho rápido.

Para limpá-lo:

```bash
dotnet clean file-based-apps
```

Isso varre `<temp>/dotnet/runfile` e remove pastas de artefatos sem uso por pelo menos 30 dias; passe `--days` para mudar o limite. Para um único app, `dotnet clean app.cs` seguido de `dotnet build app.cs` força um rebuild limpo.

Uma ressalva sobre concorrência: executar várias instâncias do mesmo app baseado em arquivo em paralelo pode falhar por contenção nos arquivos de saída do build. Compile uma vez primeiro e depois execute com `--no-build`:

```bash
dotnet build app.cs
dotnet run app.cs --no-build
```

## Publicar, empacotar e execução pelo shell

`dotnet publish app.cs` produz um executável autocontido em um diretório `artifacts` ao lado do arquivo `.cs`. Como `PublishAot` é true por padrão, esse é um binário native AOT com inicialização rápida e sem dependência do runtime, que é exatamente o que você quer para uma ferramenta de linha de comando distribuída e exatamente o que você não quer se seu script usa bibliotecas pesadas em reflexão. Desative com `#:property PublishAot=false`. Se você não tem certeza de que lado dessa linha seu código cai, os trade-offs são os mesmos cobertos em [o que o Native AOT realmente te custa](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/), e a diferença entre compilar e publicar também merece precisão, como coberto em [`dotnet build` versus `dotnet publish`](/pt-br/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/).

`dotnet pack app.cs` produz um pacote NuGet e, como `PackAsTool` é true por padrão, esse pacote é instalável como ferramenta global. De um único arquivo `.cs` a uma `dotnet tool` distribuível sem arquivo de projeto é um caminho genuinamente curto.

Em sistemas tipo Unix você pode tornar o arquivo diretamente executável com um shebang:

```csharp
#!/usr/bin/env -S dotnet --
#:package Spectre.Console@*

using Spectre.Console;

AnsiConsole.MarkupLine("[green]Hello, World![/]");
```

```bash
chmod +x file.cs
./file.cs
```

A flag `-S` permite que o `env` divida o resto da linha em argumentos separados, e o `--` final impede que o `dotnet` engula argumentos que parecem seus (`--help`, por exemplo). Use finais de linha LF e sem BOM, ou o shebang não será reconhecido. Se o seu `env` não suportar `-S`, recorra a `#!/usr/bin/env dotnet` e aceite o risco de colisão de argumentos.

## A pegadinha que mais faz perder tempo

Se existir um arquivo de projeto no diretório de trabalho atual, `dotnet run app.cs` executa *aquele projeto* e passa `app.cs` para ele como argumento de linha de comando. Isso é compatibilidade retroativa deliberada, e é silenciosa.

Verificado: a partir de um diretório contendo `pkg.csproj`, executar `dotnet run ../env.cs` executou o `pkg.csproj` e imprimiu a saída dele, não a de `env.cs`. Nada te avisa. Use `dotnet run --file ../env.cs` quando precisar de certeza, e mantenha apps baseados em arquivo fora do cone de diretórios de qualquer projeto:

```
MyProject/
  MyProject.csproj
  Program.cs
scripts/
  utility.cs
```

A armadilha relacionada são os arquivos de build implícitos. Apps baseados em arquivo respeitam `Directory.Build.props`, `Directory.Build.targets`, `Directory.Packages.props`, `nuget.config` e `global.json` do diretório atual e dos diretórios pai. Um `Directory.Build.props` na raiz do repositório que defina `TreatWarningsAsErrors` vai se aplicar ao seu script descartável. Dê aos scripts um diretório próprio com seu próprio `Directory.Build.props` quando você precisar de isolamento.

Mais duas menores. Perfis de inicialização ficam em um arquivo plano `app.run.json` ao lado de `app.cs` em vez de em `Properties/launchSettings.json`; se ambos existirem, a localização tradicional vence e a CLI registra um aviso. E o `dotnet user-secrets` precisa da opção `--file` para mirar em um script: `dotnet user-secrets set "ApiKey" "value" --file app.cs`.

## Quando o script deixa de ser um script

`dotnet project convert app.cs` é o caminho de formatura. Ele copia o arquivo `.cs` e escreve um `.csproj` com SDK, propriedades e referências de pacote equivalentes derivadas das suas diretivas `#:`, ambos colocados em um novo diretório com o nome do app. O arquivo original fica intacto, então a conversão não é destrutiva e você pode revisar o diff do resultado antes de se comprometer com ele.

Executá-lo contra o exemplo do Humanizer acima produziu exatamente a tradução esperada, com `#:package Humanizer@2.14.1` virando um `PackageReference` e `#:property PublishAot=false` virando uma propriedade:

```xml
  <ItemGroup>
    <PackageReference Include="Humanizer" Version="2.14.1" />
  </ItemGroup>
```

Esse gradiente é o verdadeiro design do recurso. Comece com um arquivo. Separe os helpers com `#:include`. Promova um helper a biblioteca com `#:ref`. Aponte para um projeto real com `#:project`. Converta quando a cerimônia do MSBuild finalmente valer a pena. Cada passo é uma linha, e nenhum deles te obriga a abandonar o `dotnet run`. Para a história do ciclo interno depois que você tem um projeto de verdade, a distinção entre [`dotnet watch` e `dotnet run`](/pt-br/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/) é a próxima coisa que vale conhecer.

## Relacionados

- [.NET 11 Preview 5 permite que apps baseados em arquivo se referenciem com `#:ref`](/pt-br/2026/06/dotnet-11-preview-5-file-based-apps-ref-directive/)
- [Os apps baseados em arquivo do .NET 10 acabaram de ganhar scripts multiarquivo: chega o `#:include`](/pt-br/2026/01/net-10-file-based-apps-just-got-multi-file-scripts-include-is-landing/)
- [Qual é a diferença entre `dotnet build` e `dotnet publish`?](/pt-br/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)
- [O que é Native AOT e quanto ele te custa?](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Qual é a diferença entre `dotnet watch` e `dotnet run`?](/pt-br/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/)

## Fontes

- [File-based apps](https://learn.microsoft.com/en-us/dotnet/core/sdk/file-based-apps) no MS Learn, a referência conceitual para diretivas, comandos da CLI, cache e organização de pastas.
- [What's new in .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview), que lista o suporte a DLL no `#:include` e o `dotnet run -e`.
- [Notas de versão do SDK do .NET 11 Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/sdk.md) para `#:ref`, remoção de feature flags e diagnósticos de diretivas duplicadas.
- [Notas de versão do SDK do .NET 11 Preview 6](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/sdk.md) para `#:include` de assemblies compilados.
- [Announcing dotnet run app.cs](https://devblogs.microsoft.com/dotnet/announcing-dotnet-run-app/) no blog do .NET, a justificativa de design original.

---
title: "Correção: framework_version=6.0.0 was not found ao iniciar um binário .NET 6"
description: "O runtime do .NET 6 sumiu ou está incompatível. Instale net6.0 de novo, faça roll forward para net8.0 via runtimeconfig, mude o target do csproj, ou publique self-contained."
pubDate: 2026-05-18
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-6"
  - "runtime"
  - "deployment"
lang: "pt-br"
translationOf: "2026/05/fix-framework-version-6-0-0-when-launching-dotnet-6-binary"
translatedBy: "claude"
translationDate: 2026-05-18
---

A correção: um binário .NET 6 que imprime `framework_version=6.0.0` e se recusa a iniciar está dizendo que o runtime do .NET 6 não está na máquina, não que sua aplicação esteja quebrada. Em um servidor onde ainda se pode manter `net6.0`, instale o runtime Microsoft.NETCore.App 6.0 e o erro de inicialização desaparece. Em um servidor que já migrou para net8.0 ou net10.0, configure `rollForward` como `Major` no `runtimeconfig.json`, mude o target do projeto para um framework com suporte, ou publique self-contained para que o binário carregue seu próprio runtime. Uma `MissingMethodException` logo após essa correção é o mesmo problema com pavio retardado: o roll-forward deixou a aplicação subir num runtime mais novo, mas um assembly transitivo se vincula rigidamente a um método que o .NET 6 tinha e o runtime mais novo renomeou.

```text
You must install or update .NET to run this application.

App: /opt/myapp/MyApp
Architecture: x64
Framework: 'Microsoft.NETCore.App', version '6.0.0' (x64)
.NET location: /usr/share/dotnet

The following frameworks were found:
  8.0.15 at [/usr/share/dotnet/shared/Microsoft.NETCore.App]
  10.0.0 at [/usr/share/dotnet/shared/Microsoft.NETCore.App]

Learn more:
https://aka.ms/dotnet/app-launch-failed

To install missing framework, download:
https://aka.ms/dotnet-core-applaunch?framework=Microsoft.NETCore.App&framework_version=6.0.0&arch=x64&rid=linux-x64&os=linux
```

Este guia foi escrito para a situação que existe em maio de 2026: o .NET 6 atingiu o fim de suporte em 2024-11-12, então imagens de produção, gerenciadores de pacotes e camadas-base que se atualizam sozinhas começaram a desinstalá-lo. O mesmo binário que rodou em produção por dois anos agora falha ao iniciar com a mensagem acima. O comportamento é idêntico, seja o host `dotnet.exe MyApp.dll` no Windows, o stub apphost no Linux, ou `dotnet exec` no macOS. As regras de sondagem do runtime descritas aqui são as dos hosts do .NET 6, .NET 8 e .NET 10; nada nelas mudou entre versões.

## Dois erros, uma só causa raiz

O erro aparece em duas formas que parecem não relacionadas, e a segunda é a que pega a maioria dos times.

A primeira forma é o erro host-fxr de cima. O host abre o `MyApp.runtimeconfig.json`, lê o `tfm` e o bloco `framework`, e decide que precisa do `Microsoft.NETCore.App` versão 6.0.0. Depois percorre os caminhos de instalação e encontra ou nada, ou apenas pastas SxS mais novas. A URL de instalação embute o nome e a versão do framework como parâmetros de query, por isso toda busca por `framework_version=6.0.0` cai no mesmo problema.

A segunda forma é `MissingMethodException` em tempo de execução. O host encontrou um framework compatível, o processo subiu, e então uma busca `JIT_GetMethodCall` falhou:

```text
System.MissingMethodException: Method not found: 'System.String System.String.IsNullOrEmpty(System.String)'
   at MyApp.Services.RequestPipeline.HandleAsync(HttpContext ctx)
```

Isso acontece quando a aplicação subiu em um runtime mais novo, mas um dos assemblies carregados foi compilado contra um assembly de referência do .NET 6 e referencia um método cuja assinatura mudou no .NET 8 ou .NET 10. O roll-forward te fez passar pela checagem de inicialização, e o preço foi um erro de vinculação atrasado em código de usuário. Ambas as mensagens significam que o runtime do .NET 6 não está nesta máquina.

## Por que seu binário pede 6.0.0 especificamente

A string de versão `6.0.0` não é a versão do runtime instalada quando você compilou o projeto. É o piso declarado pelo `<TargetFramework>` contra o qual você compilou. Quando você executa `dotnet publish` em um projeto `net6.0`, o MSBuild escreve um `MyApp.runtimeconfig.json` parecido com isto:

```json
{
  "runtimeOptions": {
    "tfm": "net6.0",
    "framework": {
      "name": "Microsoft.NETCore.App",
      "version": "6.0.0"
    },
    "configProperties": {
      "System.Runtime.TieredCompilation": true
    }
  }
}
```

O host usa esse campo `version` como mínimo, não como correspondência exata. Com a política `rollForward` padrão, que é `Minor`, ele aceita qualquer 6.x mas nunca 7.x ou superior. Com `Major`, aceita 7.x, 8.x, 10.x. Com `LatestPatch`, aceita apenas 6.0.x. A razão pela qual sua consulta de busca diz `framework_version=6.0.0` é que o host ecoa o piso que pediu, mesmo quando nenhum 6.x está instalado.

Execute `dotnet --list-runtimes` na máquina que falha. Se você ver `Microsoft.NETCore.App 8.0.15` e `10.0.0` mas nenhuma linha 6.x, esse é o diagnóstico. A linha que deveria estar ali é `Microsoft.NETCore.App 6.0.x [/usr/share/dotnet/shared/Microsoft.NETCore.App]`.

## Reprodução mínima

Compile uma app de console `net6.0`, publique framework-dependent, e rode em uma máquina que só tenha runtimes mais novos instalados.

```xml
<!-- MyApp.csproj, .NET SDK 8.0.300+ still builds net6.0 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net6.0</TargetFramework>
  </PropertyGroup>
</Project>
```

```csharp
// MyApp/Program.cs, .NET 6, C# 10
Console.WriteLine($"Running on .NET {Environment.Version}");
```

```bash
dotnet publish -c Release -r linux-x64 --self-contained false -o ./out
./out/MyApp
# You must install or update .NET to run this application.
# Framework: 'Microsoft.NETCore.App', version '6.0.0' (x64)
```

O bug aparece do mesmo jeito numa imagem Docker que trocou a base de `mcr.microsoft.com/dotnet/aspnet:6.0` para `mcr.microsoft.com/dotnet/aspnet:8.0` sem mudar o target do projeto. A tag `net6.0` no `runtimeconfig.json` sobrevive à atualização da imagem-base.

## Correção um, recomendada: mudar o target do projeto

A resposta com suporte em 2026 é parar de publicar `net6.0`. O .NET 6 parou de receber patches de segurança em novembro de 2024, o .NET 7 em maio de 2024, e o .NET 9 em maio de 2026. As únicas branches atualmente com suporte são `net8.0` (LTS, suporte até novembro de 2026), `net10.0` (LTS, suporte até novembro de 2028), e as previews em desenvolvimento de `net11.0`.

Mude o arquivo de projeto, faça restore e publique de novo:

```xml
<!-- MyApp.csproj, .NET SDK 10.0.x -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

```bash
dotnet restore
dotnet publish -c Release -r linux-x64 --self-contained false -o ./out
```

O `runtimeconfig.json` agora declara `version: 10.0.0`, e uma máquina com `Microsoft.NETCore.App 10.0.0` instalado o inicia sem reclamar. Esta é a única correção que também elimina a variante `MissingMethodException`, porque a aplicação agora é compilada contra os mesmos assemblies de referência do runtime em que vai rodar.

Se o projeto depende de um pacote que não publicou um build `net10.0`, geralmente você tem duas saídas: subir a versão do pacote, ou colocar `<TargetFrameworks>net6.0;net10.0</TargetFrameworks>` e publicar a saída multi-target. O host no servidor novo escolhe `net10.0`, o host legado no servidor velho escolhe `net6.0`, e ambos continuam funcionando até você aposentar de vez as máquinas 6.x.

## Correção dois, baixa fricção: roll forward para um runtime mais novo

Quando mudar o target está bloqueado (binário de fornecedor que você não pode recompilar, ciclo de release lento, revisão jurídica em cada assembly), force o binário .NET 6 a iniciar num runtime mais novo mudando a política `rollForward`. Existem dois lugares para configurar isso.

No projeto antes de publicar:

```xml
<!-- MyApp.csproj, still net6.0 -->
<PropertyGroup>
  <TargetFramework>net6.0</TargetFramework>
  <RollForward>Major</RollForward>
</PropertyGroup>
```

Ou no artefato já publicado, editando o `MyApp.runtimeconfig.json` ao lado do binário:

```json
{
  "runtimeOptions": {
    "tfm": "net6.0",
    "rollForward": "Major",
    "framework": {
      "name": "Microsoft.NETCore.App",
      "version": "6.0.0"
    }
  }
}
```

Ou sem mexer no arquivo, configurando a variável de ambiente para uma única execução:

```bash
DOTNET_ROLL_FORWARD=Major ./out/MyApp
```

`Major` aceita qualquer versão major mais nova. `LatestMajor` faz o mesmo mas sempre escolhe o major instalado mais alto, que é o que frotas de produção que abrangem múltiplos majors de runtime costumam querer. Reinicie o processo e o erro de inicialização some.

Roll-forward é a correção que produz `MissingMethodException` depois. Se algum pacote no seu grafo de dependências foi compilado contra os assemblies de referência do .NET 6 e chamou um método que foi removido ou renomeado no .NET 8 ou .NET 10, o JIT descobre isso na primeira vez que aquele caminho de código executa. Não há contorno para esse caso além de atualizar o pacote problemático ou voltar para a correção um.

## Correção três, último recurso: instalar o runtime do .NET 6

Quando a máquina precisa manter um runtime sem suporte, instale-o explicitamente. A Microsoft ainda hospeda os downloads do runtime do .NET 6, marcados como fim de vida, na mesma URL para a qual o erro de inicialização apontava.

No Debian e Ubuntu, o pacote é `dotnet-runtime-6.0`:

```bash
sudo apt-get install -y dotnet-runtime-6.0
dotnet --list-runtimes
# Microsoft.NETCore.App 6.0.36 [/usr/share/dotnet/shared/Microsoft.NETCore.App]
# Microsoft.NETCore.App 8.0.15 [...]
# Microsoft.NETCore.App 10.0.0 [...]
```

No Windows, instale via `winget install Microsoft.DotNet.Runtime.6` ou o MSI standalone. Numa imagem Docker, mude `FROM mcr.microsoft.com/dotnet/aspnet:8.0` de volta para `FROM mcr.microsoft.com/dotnet/aspnet:6.0` ou use a imagem multi-versão em `mcr.microsoft.com/dotnet/runtime-deps:6.0` com uma camada explícita de instalação do `dotnet-runtime-6.0`.

Marque `dotnet-runtime-6.0` com hold para que o próximo upgrade não-atendido não o remova de novo:

```bash
sudo apt-mark hold dotnet-runtime-6.0
```

Isto é uma prorrogação, não uma correção. O runtime não recebe mais patches de segurança, então qualquer CVE em `System.Net.Http` ou `System.Text.Json` 6.x fica sem patch nessa máquina. Trate como uma extensão de prazo enquanto você completa a correção um.

## Correção quatro, isolamento: publicar self-contained

Se você controla a build mas não o destino do deploy, embarque o runtime dentro do artefato. Uma publicação self-contained coloca os arquivos do `Microsoft.NETCore.App` ao lado das suas DLLs e o host nunca pede um runtime ao sistema.

```bash
dotnet publish -c Release -r linux-x64 \
  --self-contained true \
  -p:PublishSingleFile=true \
  -p:PublishTrimmed=false \
  -o ./out
```

A saída cresce uns 70 MB e não há necessidade de instalar nada na máquina de destino. Isso funciona também para `net6.0`, mas o SDK que faz a build precisa ainda conseguir resolver o ref pack do `net6.0`; o .NET SDK 10.0.x ainda consegue compilar contra `net6.0` no momento desta escrita, então a build funciona bem num SDK recente.

Self-contained é a resposta certa para ferramentas one-off, scripts de CI, sidecars, e qualquer lugar onde você não pode ditar o ambiente do host. É a resposta errada para frotas onde o patching compartilhado do runtime faz parte da postura de segurança, porque agora cada aplicação tem sua própria cópia do `System.Net.Http` e precisa ser recompilada toda vez que cai um CVE.

## Diagnosticar antes de corrigir

O host tem um modo verboso que imprime exatamente o que ele está procurando e onde. Configure `COREHOST_TRACE=1` (e opcionalmente `COREHOST_TRACEFILE=/tmp/host.log`) e rode o binário que falha de novo:

```bash
COREHOST_TRACE=1 COREHOST_TRACEFILE=/tmp/host.log ./out/MyApp
grep -E "version|framework|rollForward" /tmp/host.log
```

O log lista toda versão de framework que o host considerou, qual política `rollForward` foi aplicada, e quais caminhos foram sondados. Se o log diz que encontrou 8.0.15 mas rejeitou porque `rollForward=LatestPatch` estava configurado, você sabe que precisa virar a política. Se o log diz que não encontrou nada sob `/usr/share/dotnet/shared/Microsoft.NETCore.App`, você sabe que precisa instalar ou relocar.

Para a forma `MissingMethodException`, o stack trace nomeia o assembly que se vinculou ao método errado. Abra a pasta publicada, rode `dotnet --info` contra o host para confirmar a versão do runtime, e inspecione a DLL problemática com `ildasm` ou `dotnet-ildasm` para confirmar que ela referencia um assembly de referência 6.0. Substitua o pacote por um que tenha um build `net8.0` ou `net10.0`, ou use redirecionamentos de binding via `<AssemblyLoadContext>` se você precisa manter os dois.

## Pegadinhas e parecidos

O parâmetro `framework_version` na URL **não** é a versão do runtime instalada; é o piso que a aplicação pediu. Buscar especificamente por "install .NET 6.0.0" é um beco sem saída, porque o patch que sai é algo como 6.0.36. Instale o 6.0.x mais recente, não 6.0.0.

Uma `MissingMethodException` em `Microsoft.AspNetCore.App` em vez de `Microsoft.NETCore.App` segue a mesma lógica, mas aponta para o framework compartilhado do ASP.NET Core. Mesmos caminhos de correção, mesmo botão `rollForward`, nome diferente de framework compartilhado no .deps.json.

`dotnet --info` lista SDKs e runtimes. O runtime que sua aplicação usa é o listado sob "Microsoft.NETCore.App". Se só "Microsoft.AspNetCore.App 6.0.x" está instalado, apps de ASP.NET Core vão subir mas apps de console ainda reportam o erro original, porque o framework compartilhado do ASP.NET depende do runtime do .NET mas não é a mesma instalação.

No Windows, o apphost é `MyApp.exe`, não `dotnet.exe`. A mensagem de erro é idêntica, o troubleshooting é idêntico, e `where dotnet` responde à pergunta errada. Use `MyApp.exe --info` para confirmar qual host está rodando.

Se o binário inicia de dentro de um Azure App Service ou Functions host, a plataforma define o caminho do runtime para você. A correção é a versão "Stack" na configuração do App Service, não o arquivo local. A variante relacionada para App Service está coberta em [A versão especificada de Microsoft.NetCore.App ou Microsoft.AspNetCore.App não foi encontrada](/pt-br/2020/12/azure-the-specified-version-of-microsoft-netcore-app-or-microsoft-aspnetcore-app-was-not-found/) que percorre a mesma causa raiz com o portal do Azure à frente.

## Relacionados

- [Correção: Could not load file or assembly numa app publicada](/pt-br/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) quando o host achou o runtime mas falta uma DLL do projeto na pasta de publicação.
- [Azure App Service: Microsoft.NetCore.App não encontrado](/pt-br/2020/12/azure-the-specified-version-of-microsoft-netcore-app-or-microsoft-aspnetcore-app-was-not-found/) para a mesma causa raiz quando a plataforma é dona do host.
- [Correção: O comando 'dotnet' não foi encontrado na CI](/pt-br/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/) quando o runtime nem está no PATH.
- [Correção: The type or namespace name could not be found após um ProjectReference](/pt-br/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) quando o retargeting introduz um conflito de TargetFramework `NU1201`.
- [Correção: PlatformNotSupportedException no Native AOT](/pt-br/2026/05/fix-platformnotsupportedexception-in-native-aot/) para a classe relacionada de erros de host de runtime que só aparecem depois do publish.

## Fontes

- [Anúncio de fim de suporte do .NET 6](https://learn.microsoft.com/en-us/lifecycle/announcements/dotnet-6-end-of-support) e o cronograma de releases do .NET para saber o que ainda recebe patch.
- [Roll forward para aplicações framework-dependent](https://learn.microsoft.com/en-us/dotnet/core/versions/selection#framework-dependent-apps-roll-forward) para a tabela completa de políticas `rollForward`.
- [Deployment self-contained](https://learn.microsoft.com/en-us/dotnet/core/deploying/) para o fluxo de publicação com `--self-contained`.
- [Configurações de runtime do .NET](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/) para o esquema completo do `runtimeconfig.json`.
- [dotnet/runtime issue #79286](https://github.com/dotnet/runtime/issues/79286) para a thread canônica sobre a lógica de resolução de frameworks do host e a flag de trace.

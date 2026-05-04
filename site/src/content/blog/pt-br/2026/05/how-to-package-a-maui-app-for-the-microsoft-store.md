---
title: "Como empacotar um app .NET MAUI para a Microsoft Store"
description: "Guia completo para empacotar um app .NET MAUI 11 para Windows como MSIX, agrupar x64/x86/ARM64 em um .msixupload e enviar pelo Partner Center: reserva de identidade, Package.appxmanifest, flags do dotnet publish, agrupamento com MakeAppx e a entrega do certificado confiável da Store."
pubDate: 2026-05-04
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "windows"
  - "msix"
  - "microsoft-store"
  - "partner-center"
  - "how-to"
lang: "pt-br"
translationOf: "2026/05/how-to-package-a-maui-app-for-the-microsoft-store"
translatedBy: "claude"
translationDate: 2026-05-04
---

Resposta curta: reserve primeiro o nome do app no Partner Center, copie os valores de Identity gerados para `Platforms/Windows/Package.appxmanifest`, defina `WindowsPackageType=MSIX` e `AppxPackageSigningEnabled=true` no seu `.csproj`, depois execute `dotnet publish -f net10.0-windows10.0.19041.0 -c Release -p:RuntimeIdentifierOverride=win-x64` uma vez para cada arquitetura que você quer distribuir. Combine os arquivos `.msix` resultantes com `MakeAppx.exe bundle` em um único `.msixbundle`, embrulhe isso em um `.msixupload` (um zip simples com o bundle e seu bundle de símbolos), e envie como o pacote de uma submissão no Partner Center. A Store re-assina seu bundle com seu próprio certificado, então o `PackageCertificateThumbprint` local só precisa ser confiável na sua máquina de build.

Este guia percorre a pipeline completa para .NET MAUI 11.0.0 sobre .NET 11, Windows App SDK 1.7 e o fluxo de submissão do Partner Center como está em maio de 2026. Tudo abaixo foi validado contra `dotnet new maui` do SDK do .NET 11.0.100, com `Microsoft.WindowsAppSDK` 1.7.250401001 e `Microsoft.Maui.Controls` 11.0.0. Diferenças com orientações anteriores de .NET 8 e .NET 9 são apontadas onde a receita diverge.

## Por que "apenas clicar em Publicar" parou de funcionar

O assistente de publicação de MAUI no Visual Studio inclui um destino "Microsoft Store", mas não produziu um `.msixupload` aceitável pela Store em nenhum release de MAUI desde o .NET 6. O assistente gera um único `.msix` de uma única arquitetura e para por aí, o que significa que os uploads ou falham na validação do Partner Center diretamente (quando sua submissão anterior era empacotada) ou silenciosamente te prendem em uma única arquitetura para todo o tempo de vida da listagem. O time de MAUI rastreou essa lacuna como [dotnet/maui#22445](https://github.com/dotnet/maui/issues/22445) desde 2024 e a correção não chegou no MAUI 11. A CLI é o caminho suportado.

A segunda razão pela qual o assistente engana é a identidade. O `.msix` que ele produz é assinado com qualquer certificado local que você apontou, mas uma submissão à Store exige que o elemento `Identity` do seu app (`Name`, `Publisher` e `Version`) corresponda exatamente aos valores que o Partner Center reservou para você. Se o manifesto diz `CN=DevCert` e o Partner Center espera `CN=4D2D9D08-...`, o upload falha com um código de erro genérico estilo 12345 que não nomeia o campo problemático. Reservar o nome primeiro e colar os valores do Partner Center no manifesto antes de compilar é a única forma de evitar esse loop.

A boa notícia: uma vez que você tem o manifesto correto, os comandos da CLI são estáveis entre .NET 8, 9, 10 e 11. Apenas a forma do runtime identifier mudou: `win10-x64` foi aposentado no .NET 10 em favor do portátil `win-x64`, conforme [NETSDK1083](https://learn.microsoft.com/en-us/dotnet/core/tools/sdk-errors/netsdk1083). Todo o resto é a mesma invocação de `MSBuild` que o Xamarin entregou em 2020.

## Passo 1: Reserve o nome e colha os valores de identidade

Faça login no [Partner Center](https://partner.microsoft.com/dashboard/apps-and-games/overview) e crie um novo app. Reserve o nome. Abra **Identidade do produto** (ou **Gerenciamento do app > Identidade do app** dependendo da versão do dashboard que você vê); você precisa de três strings:

- **Package/Identity Name**, por exemplo `12345Contoso.MyMauiApp`.
- **Package/Identity Publisher**, a string longa `CN=...` que a Microsoft te atribui, por exemplo `CN=4D2D9D08-7BAC-4F2C-9D32-2A2F3C9F0E4A`.
- **Package/Publisher display name**, a versão legível que aparece na listagem da Store.

Esses três valores devem chegar literalmente em `Platforms/Windows/Package.appxmanifest`. O template do MAUI vem com um manifesto placeholder com `Name="maui-package-name-placeholder"`, que o sistema de build normalmente reescreve a partir do seu `.csproj`. Para builds da Store, sobrescreva-o explicitamente para que o elemento `Identity` sobreviva ao build.

```xml
<!-- Platforms/Windows/Package.appxmanifest, .NET MAUI 11 -->
<Identity
    Name="12345Contoso.MyMauiApp"
    Publisher="CN=4D2D9D08-7BAC-4F2C-9D32-2A2F3C9F0E4A"
    Version="1.0.0.0" />

<Properties>
  <DisplayName>My MAUI App</DisplayName>
  <PublisherDisplayName>Contoso</PublisherDisplayName>
  <Logo>Images\StoreLogo.png</Logo>
</Properties>
```

O `Version` aqui usa o esquema Win32 de quatro partes (`Major.Minor.Build.Revision`) e o Partner Center trata o quarto segmento como reservado: deve ser `0` para qualquer submissão à Store. Se você codifica números de build de CI na versão, coloque-os no terceiro segmento.

Enquanto está no manifesto, configure `<TargetDeviceFamily>` para `Windows.Desktop` com um `MinVersion` de `10.0.17763.0` (o piso para Windows App SDK 1.7) e um `MaxVersionTested` que corresponda ao que você realmente testou. Definir `MaxVersionTested` muito alto faz o Partner Center marcar a submissão para certificação adicional; muito baixo faz o Windows recusar a instalação em versões mais recentes do sistema.

## Passo 2: Configure o projeto para builds MSIX

As propriedades do `.csproj` abaixo substituem todo o conselho "Configurar projeto para MSIX" da documentação do Visual Studio. Adicione este bloco uma vez e esqueça-o.

```xml
<!-- MyMauiApp.csproj, .NET MAUI 11.0.0 on .NET 11 -->
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'windows' and '$(Configuration)' == 'Release'">
  <WindowsPackageType>MSIX</WindowsPackageType>
  <AppxPackage>true</AppxPackage>
  <AppxPackageSigningEnabled>true</AppxPackageSigningEnabled>
  <GenerateAppxPackageOnBuild>true</GenerateAppxPackageOnBuild>
  <AppxAutoIncrementPackageRevision>False</AppxAutoIncrementPackageRevision>
  <AppxSymbolPackageEnabled>true</AppxSymbolPackageEnabled>
  <AppxBundle>Never</AppxBundle>
  <PackageCertificateThumbprint>AA11BB22CC33DD44EE55FF66AA77BB88CC99DD00</PackageCertificateThumbprint>
</PropertyGroup>

<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'windows' and '$(RuntimeIdentifierOverride)' != ''">
  <RuntimeIdentifier>$(RuntimeIdentifierOverride)</RuntimeIdentifier>
</PropertyGroup>
```

Duas dessas propriedades não são óbvias.

`AppxBundle=Never` parece errado porque a Store quer um bundle, mas o build do .NET MAUI só sabe produzir um único `.msix` de uma única arquitetura por invocação de `dotnet publish`. Definir `AppxBundle=Always` aqui faz o build tentar geração de bundle no estilo UWP contra um projeto não UWP e emite o erro críptico `The target '_GenerateAppxPackage' does not exist in the project` rastreado em [dotnet/maui#17680](https://github.com/dotnet/maui/issues/17680). Você compila por arquitetura e faz o bundle você mesmo no próximo passo.

`AppxSymbolPackageEnabled=true` produz um `.appxsym` ao lado de cada `.msix`. O `.msixupload` que você envia é um zip cujo conteúdo é o bundle mais um bundle de símbolos irmão, e o Partner Center silenciosamente remove a análise de falhas se qualquer um dos lados estiver faltando. Ele não te avisa; você simplesmente obtém stack traces vazios no painel de Saúde seis semanas depois.

O segundo `<PropertyGroup>` é um workaround para [WindowsAppSDK#3337](https://github.com/microsoft/WindowsAppSDK/issues/3337), que está aberto desde que o projeto se mudou para o GitHub e não mostra sinais de fechar. Sem isso, `dotnet publish` seleciona o RID implícito antes do target MSIX lê-lo, e o pacote resultante mira a arquitetura do host de build em vez da que você passou na linha de comando.

O `PackageCertificateThumbprint` só importa para instalações por sideload. O Partner Center re-assina seu bundle com o certificado associado à sua conta de publisher, então um certificado autoassinado serve para submissões à Store. Gere um com `New-SelfSignedCertificate -Type Custom -Subject "CN=Contoso" -KeyUsage DigitalSignature -CertStoreLocation "Cert:\CurrentUser\My" -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")`, copie o thumbprint para o arquivo do projeto e confie no certificado no armazenamento **Pessoas Confiáveis** em qualquer máquina onde você fizer sideload antes da listagem da Store entrar no ar.

## Passo 3: Compile um MSIX por arquitetura

A Store aceita x64 e ARM64 hoje, mais um build x86 opcional para a longa cauda de PCs antigos. Execute `dotnet publish` uma vez por arquitetura, a partir de um **Prompt de Comando do Desenvolvedor para Visual Studio** para que as ferramentas do SDK do Windows estejam no `PATH`.

```powershell
# .NET MAUI 11.0.0 on .NET 11, Windows App SDK 1.7
$tfm = "net10.0-windows10.0.19041.0"
$project = "src\MyMauiApp\MyMauiApp.csproj"

foreach ($rid in @("win-x64", "win-x86", "win-arm64")) {
    dotnet publish $project `
        -f $tfm `
        -c Release `
        -p:RuntimeIdentifierOverride=$rid
}
```

Depois que as três execuções terminam, os pacotes por arquitetura caem em:

```
src\MyMauiApp\bin\Release\net10.0-windows10.0.19041.0\win-x64\AppPackages\MyMauiApp_1.0.0.0_Test\MyMauiApp_1.0.0.0_x64.msix
src\MyMauiApp\bin\Release\net10.0-windows10.0.19041.0\win-x86\AppPackages\MyMauiApp_1.0.0.0_Test\MyMauiApp_1.0.0.0_x86.msix
src\MyMauiApp\bin\Release\net10.0-windows10.0.19041.0\win-arm64\AppPackages\MyMauiApp_1.0.0.0_Test\MyMauiApp_1.0.0.0_arm64.msix
```

Cada pasta também contém um bundle de símbolos `.appxsym`. Copie todos os seis artefatos para uma pasta de staging plana para que o passo de bundling possa operar sobre um único diretório.

```powershell
$staging = "artifacts\msix"
New-Item -ItemType Directory -Force -Path $staging | Out-Null

Get-ChildItem -Recurse -Include *.msix, *.appxsym `
    -Path "src\MyMauiApp\bin\Release\$tfm" |
    Copy-Item -Destination $staging
```

Seu log de `dotnet build` reportará `package version 1.0.0.0` para cada arquitetura. Eles devem corresponder exatamente, caso contrário `MakeAppx.exe bundle` rejeita o conjunto de entrada com `error 0x80080204: The package family is invalid`.

## Passo 4: Agrupe as arquiteturas em um `.msixbundle`

`MakeAppx.exe` vem com o SDK do Windows 11 em `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makeappx.exe`. Versões mais novas do SDK instalam lado a lado; escolha a que corresponde ao seu `MaxVersionTested`.

```powershell
$makeappx = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makeappx.exe"
$version = "1.0.0.0"

& $makeappx bundle `
    /bv $version `
    /d $staging `
    /p "artifacts\MyMauiApp_${version}_x86_x64_arm64.msixbundle"
```

A flag `/d` diz ao `MakeAppx` para ingerir cada `.msix` na pasta e produzir um bundle gordo cujo mapa de arquiteturas cobre todos os três. O valor `/bv` (bundle version) deve ser igual ao `Version` no `Package.appxmanifest`; descompassos fazem o Partner Center rejeitar a submissão com `package version mismatch`.

Execute uma segunda passagem para agrupar os arquivos de símbolos:

```powershell
& $makeappx bundle `
    /bv $version `
    /d $staging `
    /p "artifacts\MyMauiApp_${version}_x86_x64_arm64.appxsymbundle"
```

`MakeAppx` deduz a extensão do arquivo a partir do conjunto de entrada e ignora os arquivos `.msix` ao agrupar símbolos. Se você esquecer o bundle de símbolos, o upload ainda tem sucesso, mas Relatórios de Saúde ficam vazios.

## Passo 5: Empacote como `.msixupload`

Um `.msixupload` é apenas um zip com uma extensão específica. O Partner Center detecta automaticamente os arquivos irmãos de bundle e bundle de símbolos dentro dele.

```powershell
$upload = "artifacts\MyMauiApp_${version}_x86_x64_arm64.msixupload"

Compress-Archive `
    -Path "artifacts\MyMauiApp_${version}_x86_x64_arm64.msixbundle", `
          "artifacts\MyMauiApp_${version}_x86_x64_arm64.appxsymbundle" `
    -DestinationPath ($upload -replace '\.msixupload$', '.zip') -Force

Move-Item -Force ($upload -replace '\.msixupload$', '.zip') $upload
```

PowerShell 5.1 se recusa a escrever uma extensão que não seja `.zip` diretamente com `Compress-Archive`, por isso o snippet escreve um `.zip` primeiro e renomeia. PowerShell 7.4+ aceita a extensão diretamente.

## Passo 6: Envie pelo Partner Center

Abra seu app reservado no Partner Center, clique em **Iniciar sua submissão**, pule para a seção **Pacotes** e solte o `.msixupload`. O Partner Center valida o pacote na hora e expõe problemas em três categorias:

- **Descompasso de identidade.** O `Identity Name` ou `Publisher` no seu manifesto não corresponde aos valores que o Partner Center reservou. Abra a página **Identidade do produto** do dashboard lado a lado com o `Package.appxmanifest`, corrija o manifesto, recompile, refaça o bundle e reenvie. Não edite o zip `.msixupload` diretamente; o bundle é assinado e o ciclo de descompactar-editar-recompactar invalida a assinatura.
- **Capabilities.** Qualquer `<Capability>` que você declare mapeia para uma categoria da Store que pode requerer certificação adicional. `runFullTrust` (que MAUI define implicitamente porque apps desktop Win32 precisam dela) é aprovada para contas normais da Store; `extendedExecutionUnconstrained` e capabilities similares passam por revisão adicional.
- **Versão mínima.** Se `MinVersion` em `<TargetDeviceFamily>` é mais antiga do que a versão mais baixa do Windows que a Store atualmente suporta (10.0.17763.0 em maio de 2026), o pacote é rejeitado. A correção é elevá-la no manifesto, não baixar o SDK.

Uma vez que a validação passa, preencha os metadados da listagem, classificação etária e preço como faria para qualquer outro app da Store. A primeira revisão tipicamente é concluída em 24-48 horas; atualizações para apps existentes geralmente passam em menos de 12.

## Cinco gotchas que vão consumir uma tarde

**1. A primeira submissão decide bundle versus MSIX único para sempre.** Se você alguma vez enviar um único `.msix` para uma listagem, toda submissão futura também deve ser um único `.msix`; você não pode promover uma listagem existente para um bundle, e você não pode rebaixar um bundle para um `.msix` único. Decida desde o início e fique com bundles mesmo se você só distribui uma arquitetura hoje.

**2. `Package Family Name` no Partner Center não é a mesma coisa que `Identity Name`.** O PFN é `Identity.Name + "_" + primeiros 13 caracteres do hash do Publisher`, e o Windows o deriva automaticamente. Se você copiar o PFN para o `Identity.Name` do manifesto, o upload falha com o engananoso erro "package identity does not match" documentado em [dotnet/maui#32801](https://github.com/dotnet/maui/issues/32801).

**3. Windows App SDK é uma dependência de framework, não um redistribuível que você envia.** A Store instala o pacote `Microsoft.WindowsAppRuntime.1.7` correspondente automaticamente desde que você use a referência `WindowsAppSDK` dependente de framework do template MAUI. Se você mudar para self-contained, o MSIX resultante é 80MB maior e o Partner Center o rejeita por exceder o orçamento de tamanho por arquitetura do nível gratuito da Store.

**4. Nomes de projeto com underlines quebram o MakeAppx.** Um `.csproj` chamado `My_App.csproj` produz pacotes cujos nomes de arquivo contêm underlines em posições onde `MakeAppx bundle` os interpreta como separadores de versão, o que falha com `error 0x80080204`. Renomeie o projeto para usar hífens, ou adicione `<AssemblyName>MyApp</AssemblyName>` para sobrescrever o nome de saída. Isso é rastreado em [dotnet/maui#26486](https://github.com/dotnet/maui/issues/26486).

**5. O sufixo `Test` é real.** A pasta `AppPackages\MyMauiApp_1.0.0.0_Test` é nomeada assim porque `dotnet publish` por padrão produz certificados de teste. O `.msix` dentro da pasta serve para a Store; só o nome da pasta é enganoso. Copie o `.msix`, ignore o diretório `_Test` e siga em frente.

## Onde isso encaixa em uma pipeline de CI

Nada nesta pipeline requer Visual Studio. Um runner limpo de GitHub Actions `windows-latest` com o SDK do .NET 11 e o workload do MAUI instalados produz o mesmo `.msixupload` a partir destes comandos. O único material sensível é o thumbprint do certificado de assinatura e o PFX, ambos cabem em segredos do repositório. Após o upload, a [API de submissões da Microsoft Store](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services) permite empurrar o mesmo artefato direto para uma submissão em rascunho sem tocar no dashboard, o que fecha o ciclo de um release totalmente automatizado.

Se você está removendo target frameworks móveis do mesmo projeto para que o build do Windows não arraste também workloads de Android e iOS, a [configuração de MAUI 11 só para Windows e macOS](/pt-br/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) cobre as reescritas de `<TargetFrameworks>` que você precisa antes de qualquer um dos comandos publish acima rodar limpamente. Para o lado do Manifest Designer do `Package.appxmanifest` e o pequeno conjunto de configurações de tema que a Store lê, [suportar modo escuro em um app MAUI](/pt-br/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) percorre as chaves de recurso que aparecem no gerador de capturas da listagem. Se sua listagem da Store mostra uma página de Maps, o [walkthrough de clustering de pinos de mapa do MAUI 11](/2026/04/dotnet-maui-11-map-pin-clustering/) cobre a capability `MapsKey` que você precisa declarar no manifesto antes do time de certificação aprovar o app. E para um tour mais amplo do que é novo no framework que entrega no seu bundle, [novidades do .NET MAUI 10](/2025/04/whats-new-in-net-maui-10/) é o mais próximo de um pilar de notas de release que a documentação tem.

## Links de fontes

- [Use the CLI to publish packaged apps for Windows - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/windows/deployment/publish-cli?view=net-maui-10.0)
- [Publish a .NET MAUI app for Windows (overview)](https://learn.microsoft.com/en-us/dotnet/maui/windows/deployment/overview?view=net-maui-10.0)
- [App manifest schema reference](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/root-elements)
- [Create a certificate for package signing](https://learn.microsoft.com/en-us/windows/msix/package/create-certificate-package-signing)
- [MakeAppx.exe tool reference](https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool)
- [Microsoft Store Submission API](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services)
- [WindowsAppSDK Issue #3337 - RID workaround](https://github.com/microsoft/WindowsAppSDK/issues/3337)
- [dotnet/maui Issue #22445 - .msixupload missing](https://github.com/dotnet/maui/issues/22445)
- [dotnet/maui Issue #32801 - package identity mismatch](https://github.com/dotnet/maui/issues/32801)

---
title: "Correção: HTTP Error 500.30 - ASP.NET Core app failed to start após implantar no IIS"
description: "500.30 significa que sua aplicação lançou uma exceção durante a inicialização dentro do w3wp.exe. A exceção real já está no log de eventos de Aplicativo do Windows sob IIS AspNetCore Module V2. Leia isso primeiro e depois ordene a correção: framework compartilhado ausente, incompatibilidade x86/x64 do pool de aplicativos, configuração ausente ou permissões do pool."
pubDate: 2026-08-05
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "iis"
  - "deployment"
lang: "pt-br"
translationOf: "2026/08/fix-http-error-500-30-aspnet-core-app-failed-to-start-on-iis"
translatedBy: "claude"
translationDate: 2026-08-05
---

`500.30` não é uma causa, é o IIS informando que o ASP.NET Core Module inicializou o CLR dentro do `w3wp.exe` e sua aplicação lançou uma exceção antes de conseguir começar a escutar. A exceção real quase certamente já está no servidor: abra o Visualizador de Eventos, vá em **Logs do Windows > Aplicativo** e encontre a entrada mais recente com origem **IIS AspNetCore Module V2**. Quando `stdoutLogEnabled` é `false`, o módulo captura os erros de inicialização e escreve até 30 KB deles nesse evento, com stack trace incluído. Se a entrada só te der `exception code = '0xe0434352'` e nada mais, defina `stdoutLogEnabled="true"` no `web.config` e acesse o site de novo. Tudo depois disso é ordenar as quatro coisas que realmente causam o problema.

```text
HTTP Error 500.30 - ASP.NET Core app failed to start
```

Builds mais antigos do ASP.NET Core Module exibem exatamente a mesma falha como `HTTP Error 500.30 - ANCM In-Process Start Failure`, que ainda é a string usada pela documentação da Microsoft nas tabelas de erro. Ambas significam a mesma coisa. Tudo abaixo foi verificado contra .NET 11 (Preview 6, SDK `11.0.100-preview.6.26359.118`) com o ANCM V2 do .NET Hosting Bundle atual. O mecanismo não mudou desde que a hospedagem in-process se tornou o padrão no ASP.NET Core 3.0, então cada passo se aplica sem alterações a implantações `net8.0`, `net9.0` e `net10.0`.

## Por que 500.30 é um sintoma e não um diagnóstico

Desde o ASP.NET Core 3.0, as aplicações usam por padrão o **modelo de hospedagem in-process**. A propriedade MSBuild `<AspNetCoreHostingModel>` tem valor padrão `InProcess`, e o `dotnet publish` escreve `hostingModel="inprocess"` no `web.config`. Nesse modelo não existe um processo `dotnet.exe` separado. O `aspnetcorev2.dll` carrega o manipulador de requisições in-process dentro do processo de trabalho do IIS, inicializa o CoreCLR ali, e seu `Program.cs` roda dentro do `w3wp.exe` usando `IISHttpServer` em vez do Kestrel.

Isso te dá um processo em vez de dois e um ganho real de throughput, mas destrói o relatório de erros. Quando a aplicação lança uma exceção antes de `app.Run()` chegar ao estado de escuta, o módulo tem um CLR morto dentro do próprio processo e um byte de informação para dar ao navegador: a inicialização falhou. Daí um único código de status cobrindo uma string de conexão ausente, um binário de 32 bits em um processo de trabalho de 64 bits, um runtime não instalado e uma `DirectoryNotFoundException` sobre um chaveiro de proteção de dados.

Vale internalizar duas consequências antes de começar a mudar coisas:

- **`startupTimeLimit` não reinicia nada.** Ao hospedar in-process, se a janela padrão de 120 segundos do módulo se esgotar, o processo é encerrado e *não* é relançado, e `rapidFailsPerMinute` não se aplica. A hospedagem out-of-process tenta de novo na próxima requisição. In-process não.
- **O pool de aplicativos não pode ser compartilhado.** A hospedagem in-process exige um pool por aplicação. Duas aplicações in-process no mesmo pool produzem `500.35`, e misturar uma in-process com uma out-of-process em um pool produz `500.34`.

## A reprodução mínima

A menor implantação que reproduz o problema é uma aplicação que lê configuração que existe localmente e não no servidor:

```csharp
// .NET 11 preview 6, C# 14. Program.cs
var builder = WebApplication.CreateBuilder(args);

string cs = builder.Configuration.GetConnectionString("Default")
    ?? throw new InvalidOperationException("Connection string 'Default' is missing.");

builder.Services.AddDbContext<AppDbContext>(o => o.UseSqlServer(cs));

var app = builder.Build();
app.MapGet("/", () => "ok");
app.Run();
```

Localmente isso roda porque o `appsettings.Development.json` tem a seção e `ASPNETCORE_ENVIRONMENT` é `Development`. No servidor o ambiente é `Production`, o `appsettings.Production.json` nunca foi adicionado à saída de publicação, e a exceção acontece na linha 3. F5 funciona, a implantação dá 500.30, e nada na aplicação está errado.

Esse formato cobre boa parte dos relatos reais de 500.30: a falha é ambiental, então por construção ela é invisível na máquina do desenvolvedor.

## Ler o log de eventos de Aplicativo, que normalmente encerra a investigação

Faça isso antes de tocar no `web.config`. No servidor, execute o Visualizador de Eventos como administrador e abra **Logs do Windows > Aplicativo**, ou consulte diretamente:

```powershell
# Windows Server 2022+, PowerShell 5.1 or 7.x. Run elevated on the web server.
Get-WinEvent -FilterHashtable @{
    LogName      = 'Application'
    ProviderName = 'IIS AspNetCore Module V2'
} -MaxEvents 5 | Format-List TimeCreated, Id, LevelDisplayName, Message
```

Você procura por um de três formatos.

**Formato 1, o útil.** Um stack trace gerenciado completo. O módulo capturou sua exceção de inicialização não tratada e a emitiu para o log de eventos porque `stdoutLogEnabled` é `false`. Leia o tipo da exceção e o frame do topo, corrija aquilo, e acabou. Este é o caso que as pessoas pulam porque a página do navegador não disse nada e elas presumiram que o servidor também não diria.

**Formato 2, o opaco:**

```text
Application '/LM/W3SVC/5/ROOT' with physical root 'C:\inetpub\wwwroot\myapp\'
hit unexpected managed exception, exception code = '0xe0434352'.
Please check the stderr logs for more information.
Application '/LM/W3SVC/5/ROOT' with physical root 'C:\inetpub\wwwroot\myapp\'
failed to load clr and managed application. CLR worker thread exited prematurely
```

`0xe0434352` é o código Win32 genérico para "uma exceção gerenciada escapou", nada mais. Ele não carrega tipo nem mensagem. Essa é a assinatura documentada de uma aplicação x86 em um pool que não está habilitado para aplicações de 32 bits, mas também aparece sempre que a exceção escapou por um ponto onde o módulo não conseguiu capturar o detalhe. Vá para o log stdout.

**Formato 3, nada.** Nenhum evento do ANCM no minuto seguinte à sua requisição. Isso normalmente significa que o módulo nunca chegou a inicializar o CLR, e na verdade você está diante de `500.0`, `500.31` ou `500.32`, e não de uma exceção de inicialização. Veja a seção de variantes no final.

## Ativar o log stdout

Edite o `web.config` implantado no servidor, não o do seu projeto. Ele é regenerado a cada publicação, que é exatamente o que você quer para uma chave de diagnóstico temporária.

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- Deployed web.config, ASP.NET Core Module V2, .NET 11 -->
<configuration>
  <location path="." inheritInChildApplications="false">
    <system.webServer>
      <handlers>
        <add name="aspNetCore" path="*" verb="*" modules="AspNetCoreModuleV2" resourceType="Unspecified" />
      </handlers>
      <aspNetCore processPath="dotnet"
                  arguments=".\MyApp.dll"
                  stdoutLogEnabled="true"
                  stdoutLogFile=".\logs\stdout"
                  hostingModel="inprocess" />
    </system.webServer>
  </location>
</configuration>
```

Salvar o `web.config` recicla o pool de aplicativos, então basta requisitar o site de novo. O módulo cria sozinho a pasta `logs` para o `stdoutLogFile`, e escreve um arquivo nomeado com timestamp e ID do processo, por exemplo `stdout_20260805184032_5412.log`. A identidade do pool precisa de acesso de escrita nessa pasta:

```console
icacls "C:\inetpub\wwwroot\myapp\logs" /grant "IIS AppPool\MyAppPool":(OI)(CI)M
```

Três observações de leitura que economizam tempo:

- **O arquivo existe mas está vazio.** O processo morreu antes de escrever qualquer coisa no stdout. Isso aponta para incompatibilidade de arquitetura ou falha de carga nativa, não para o seu código.
- **O arquivo tem linhas normais de inicialização e depois para.** O que roda imediatamente após a última linha é o seu suspeito.
- **Desligue de volta.** `stdoutLogEnabled="true"` escreve um arquivo novo a cada reciclagem de processo para sempre, e a documentação é explícita ao dizer que deixá-lo ligado pode derrubar a aplicação ou o servidor. Volte para `false` quando tiver sua resposta.

Se o stdout continuar em silêncio, a falha está abaixo do código gerenciado. Adicione o log de depuração do próprio módulo:

```xml
<!-- ASP.NET Core Module V2 diagnostic logging. Remove after troubleshooting. -->
<aspNetCore processPath="dotnet"
            arguments=".\MyApp.dll"
            stdoutLogEnabled="false"
            stdoutLogFile=".\logs\stdout"
            hostingModel="inprocess">
  <handlerSettings>
    <handlerSetting name="debugFile" value=".\logs\aspnetcore-debug.log" />
    <handlerSetting name="debugLevel" value="FILE,TRACE" />
  </handlerSettings>
</aspNetCore>
```

Diferente do `stdoutLogFile`, o módulo **não** cria pastas para o `debugFile`. O diretório `logs` precisa já existir e ser gravável pela identidade do pool, senão você não obtém nada e chega à conclusão errada. Esse log mostra a resolução do hostfxr, quais versões de framework foram consideradas e qual DLL falhou ao carregar.

## Correção 1: a aplicação lançou uma exceção na inicialização, que é a maioria dos casos

Se o log de eventos ou o log stdout te deu um stack trace, é o seu caso. O agrupamento na prática:

1. **Configuração presente localmente e ausente no servidor.** `appsettings.Production.json` fora da saída de publicação, um valor de User Secrets que nunca teve equivalente em produção, uma variável de ambiente definida só na sua máquina. Essa é a [falha de string de conexão ausente](/pt-br/2026/05/fix-no-connection-string-named-defaultconnection/) na sua forma de implantação.
2. **Falhas no grafo de DI em `builder.Build()`.** O ASP.NET Core valida escopos e o grafo de serviços na construção em Development, e qualquer problema de `Unable to resolve service for type` ou de dependência cativa aparece como um 500.30 em vez de uma página útil. Veja [unable to resolve service for type while attempting to activate](/pt-br/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) e [cannot consume scoped service from singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
3. **Dependências externas contatadas durante a inicialização.** Key Vault com uma política de acesso que não cobre a identidade gerenciada do pool é o caso que a Microsoft cita pelo nome para 500.30. Uma migração executada no boot, um provedor de configuração que acessa um banco de dados, um download do documento de descoberta OIDC em um servidor sem saída para a internet: todos transformam um problema de rede em uma falha de inicialização.
4. **Acesso a certificados e à proteção de dados.** Carregar um certificado X.509 do repositório da máquina, ou persistir um chaveiro de proteção de dados em um caminho onde a identidade do pool não pode escrever, lança uma exceção antes da primeira requisição.

A correção estrutural para toda essa categoria é tornar as falhas de inicialização explícitas e legíveis em vez de acidentais. Validar a configuração no boot com [`IValidateOptions<T>` e `ValidateOnStart`](/pt-br/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) transforma "a aplicação dá 500.30" em uma `OptionsValidationException` nomeada que lista exatamente quais configurações estão faltando, o que é a diferença entre uma correção de cinco minutos e uma tarde inteira.

Para obter a exceção crua no navegador em uma máquina de staging, adicione a variável de ambiente ao `web.config`, e nunca faça isso em um servidor público:

```xml
<!-- Staging and test servers only. Do not ship this to an internet-facing host. -->
<aspNetCore processPath="dotnet" arguments=".\MyApp.dll" hostingModel="inprocess">
  <environmentVariables>
    <environmentVariable name="ASPNETCORE_ENVIRONMENT" value="Development" />
    <environmentVariable name="ASPNETCORE_DETAILEDERRORS" value="true" />
  </environmentVariables>
</aspNetCore>
```

## Correção 2: o framework compartilhado que a aplicação usa não está instalado

A Microsoft lista isso em primeiro lugar entre as causas de 500.30: a aplicação usa uma versão do framework compartilhado do ASP.NET Core que não está presente. Verifique o que o servidor realmente tem:

```console
dotnet --list-runtimes
```

Você quer uma linha `Microsoft.AspNetCore.App` cuja versão maior corresponda ao seu `TargetFramework`, e a quer na mesma arquitetura do pool de aplicativos. Se a aplicação é `net11.0` e o servidor vai no máximo até `Microsoft.AspNetCore.App 10.0.x`, essa é a sua resposta, porque o ASP.NET Core não faz roll forward entre versões maiores por padrão.

Instale o **.NET Hosting Bundle**, que instala o runtime, o framework compartilhado do ASP.NET Core e o ANCM em um único pacote. Duas regras de instalação causam mais 500.30 do que o próprio download:

- **O IIS precisa estar instalado antes do Hosting Bundle.** Se o bundle veio primeiro, rodar o instalador de novo para reparar é obrigatório, não opcional.
- **Reinicie o servidor web depois de instalar.** O instalador muda o `PATH` do sistema, e o ASP.NET Core também não faz roll forward para versões de patch dos pacotes do framework compartilhado, então o mesmo reinício é necessário após cada atualização do bundle:

```console
net stop was /y
net start w3svc
```

Um `iisreset` completo também funciona. Pular esse passo é a razão de "instalei o runtime e continua falhando" ser um retorno tão comum.

## Correção 3: a aplicação e o pool discordam quanto à arquitetura

A hospedagem in-process exige que a arquitetura da aplicação e do runtime instalado corresponda à arquitetura do pool de aplicativos. Não há camada de adaptação. Um binário de 32 bits não consegue inicializar o CoreCLR dentro de um `w3wp.exe` de 64 bits.

No Gerenciador do IIS, selecione o pool, escolha **Configurações Avançadas** e defina **Habilitar Aplicativos de 32 Bits**:

- `True` para uma aplicação x86, incluindo uma implantação autocontida x86 publicada com um SDK de 32 bits.
- `False` para uma aplicação x64.

Ou pela linha de comando:

```console
%windir%\system32\inetsrv\appcmd set apppool /apppool.name:MyAppPool /enable32BitAppOnWin64:false
```

Já que você está lá, defina **Versão do .NET CLR** como **Sem Código Gerenciado** nas Configurações Básicas. O ASP.NET Core inicializa o CoreCLR sozinho e nunca precisa do CLR de desktop carregado no processo de trabalho. É documentado como opcional mas recomendado, e elimina toda uma classe de interações confusas com módulos legados.

Uma armadilha específica do Hosting Bundle: se você o instalou com `OPT_NO_X86=1`, não tem nenhum runtime de 32 bits naquela máquina, e uma aplicação x86 vai falhar independentemente de como o pool esteja configurado.

## Correção 4: a identidade do pool não consegue ler o que precisa

A `ApplicationPoolIdentity` padrão é uma conta virtual, e todo 500.30 causado por permissões é idêntico a qualquer outro 500.30. Se a identidade foi mudada de `ApplicationPoolIdentity` para uma conta de domínio ou de serviço, verifique se ela tem acesso de leitura à pasta de implantação e de escrita a qualquer lugar onde a aplicação escreve. Conceda na pasta usando o nome do pool:

```console
icacls "C:\inetpub\wwwroot\myapp" /grant "IIS AppPool\MyAppPool":(OI)(CI)RX
```

Dois casos que vale checar diretamente: ler a chave privada de um certificado do repositório da máquina exige uma ACL sobre o contêiner de chaves, e qualquer código que toque `%USERPROFILE%` precisa de **Carregar Perfil de Usuário** definido como `True` no pool. Ele é `True` por padrão e frequentemente desligado em ambientes endurecidos.

## Corte a superfície pela metade rodando a aplicação fora do IIS

Antes de gastar mais uma hora em configuração do IIS, entre no servidor, abra um terminal na pasta de implantação e rode a aplicação diretamente:

```console
cd C:\inetpub\wwwroot\myapp
set ASPNETCORE_ENVIRONMENT=Production
dotnet MyApp.dll
```

A exceção é impressa no console com stack trace completo e sem nenhuma configuração de log necessária. Se lançar aqui, o problema é sua aplicação ou a configuração dela e o IIS é inocente, o que te leva direto para a Correção 1. Se iniciar limpo e servir em `http://localhost:5000`, o problema é a camada de hospedagem: arquitetura, permissões ou o módulo, o que te leva para a Correção 2, 3 ou 4. Esse único comando decide qual metade deste artigo você precisa.

Repare na variável de ambiente. Rodar com a sua própria conta e o seu próprio ambiente não é o mesmo que rodar como a identidade do pool, então uma execução limpa aqui não prova que as permissões de arquivo estão corretas. Prova que o código e os arquivos de configuração implantados estão.

## Os códigos vizinhos que não são 500.30

O tráfego de busca por 500.30 acumula muitos casos parecidos. Se a sua página diz outra coisa, é um problema diferente com uma correção diferente:

- **`500.0 - ANCM In-Process Handler Load Failure`**: o módulo não conseguiu carregar o manipulador de requisições in-process de jeito nenhum. `processPath` errado, Hosting Bundle não instalado, IIS não reiniciado após a instalação, ou um redistribuível do VC++ ausente.
- **`500.31 - ANCM Failed to Find Native Dependencies`**: `Microsoft.NETCore.App` ou `Microsoft.AspNetCore.App` não está instalado. O log de eventos nomeia o framework e a versão exatos que não foram encontrados. Instale, mude o target ou publique autocontido.
- **`500.32 - ANCM Failed to Load dll`**: incompatibilidade de arquitetura do processador, a mesma causa raiz da Correção 3 emergindo uma camada abaixo.
- **`500.33 - ANCM Request Handler Load Failure`**: a aplicação não referencia o framework `Microsoft.AspNetCore.App`. Verifique o `.runtimeconfig.json`. Uma aplicação de console com `Microsoft.NET.Sdk` em vez de `Microsoft.NET.Sdk.Web` produz isso.
- **`500.34` e `500.35`**: modelos de hospedagem misturados, ou duas aplicações in-process, no mesmo pool. Separe em pools distintos.
- **`500.36 - ANCM Out-Of-Process Handler Load Failure`**: falta o `aspnetcorev2_outofprocess.dll` ao lado do `aspnetcorev2.dll`. Repare o Hosting Bundle.
- **`500.37 - ANCM Failed to Start Within Startup Time Limit`**: a inicialização passou de 120 segundos. Aumente `startupTimeLimit`, ou escalone a inicialização de muitas aplicações competindo por CPU na mesma máquina.
- **`500.38 - ANCM Application DLL Not Found`**: você publicou um executável de arquivo único e a hospedagem in-process não suporta isso. Defina `<PublishSingleFile>false</PublishSingleFile>` ou mude para `<AspNetCoreHostingModel>OutOfProcess</AspNetCoreHostingModel>`.
- **`502.5 - Process Failure`**: apenas hospedagem out-of-process. O processo backend não iniciou ou não escutou em `%ASPNETCORE_PORT%`. Frequentemente uma `BadImageFormatException` por incompatibilidade de RID, visível no log stdout.
- **`500.19`**: um erro de configuração do IIS ao ler o próprio `web.config`, geralmente porque o ANCM não está registrado ou a configuração está malformada. A aplicação nunca entrou em cena.

Mudar para hospedagem out-of-process é um movimento de diagnóstico legítimo, não uma correção. Definir `hostingModel="outofprocess"` no `web.config` recicla o processo de trabalho e roda sua aplicação como um `dotnet.exe` filho, onde falhas de inicialização são muito mais fáceis de observar e `requestTimeout` e `rapidFailsPerMinute` voltam a valer. Use isso para obter um erro legível, e depois volte para in-process pelo desempenho.

O formato geral de uma investigação de 500.30 é curto se você seguir a ordem: log de eventos, depois rodar pelo console, depois arquitetura e runtime. Só vira uma tarde longa quando você começa pela página do navegador e tenta adivinhar.

## Relacionados

- [Fix: Unable to resolve service for type X while attempting to activate Y](/pt-br/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) é a exceção gerenciada mais comum escondida atrás de um 500.30.
- [Fix: Cannot consume scoped service from singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/) cobre a outra falha de DI que só aparece depois que o contêiner é construído.
- [Como validar opções na inicialização com IValidateOptions&lt;T&gt; no .NET 11](/pt-br/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) transforma "a aplicação não iniciou" em uma exceção nomeada que diz qual configuração está errada.
- [Fix: No connection string named 'DefaultConnection' could be found](/pt-br/2026/05/fix-no-connection-string-named-defaultconnection/) é a lacuna de configuração clássica que sobrevive até a implantação.
- [Fix: Could not load file or assembly em uma aplicação publicada](/pt-br/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) trata dos problemas de saída de publicação que aparecem como falha de inicialização.
- [Migrar do .NET 8 para o .NET 11: o checklist completo](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) inclui o passo de atualização do Hosting Bundle que um salto de versão maior exige em cada servidor IIS.

## Fontes

- [Troubleshoot ASP.NET Core on Azure App Service and IIS](https://learn.microsoft.com/en-us/aspnet/core/test/troubleshoot-azure-iis) no MS Learn, para as definições de 500.30 a 500.38, o log stdout e o log de depuração do ANCM.
- [Common error troubleshooting for Azure App Service and IIS with ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/azure-iis-errors-reference) para as strings literais do log de Aplicativo, incluindo a assinatura `0xe0434352`.
- [ASP.NET Core Module (ANCM) for IIS](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/aspnet-core-module) para os atributos do elemento `aspNetCore`, seus padrões e as características da hospedagem in-process.
- [Host ASP.NET Core on Windows with IIS](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/iis/) para a ordem de instalação do Hosting Bundle, `net stop was /y` e a configuração do pool de aplicativos.
- [Install the .NET Hosting Bundle](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/iis/hosting-bundle) para as opções do instalador, incluindo `OPT_NO_X86`.

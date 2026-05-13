---
title: "Solução: System.Security.Cryptography.CryptographicException: Keyset does not exist"
description: "A chave privada do certificado mora em um arquivo de chaves do Windows que a identidade do processo não consegue ler. Ajuste a ACL, carregue o PFX com MachineKeySet ou use EphemeralKeySet."
pubDate: 2026-05-13
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "cryptography"
  - "x509"
  - "windows"
lang: "pt-br"
translationOf: "2026/05/fix-keyset-does-not-exist-when-calling-win32-api-from-dotnet"
translatedBy: "claude"
translationDate: 2026-05-13
---

A solução: este é o `NTE_BAD_KEYSET` (HRESULT `0x80090016`) subindo a partir de uma chamada de criptografia Win32. O objeto de certificado que você tem em mãos contém uma chave pública, mas o **arquivo de chave privada** em disco vive em um lugar separado, e a identidade do processo atual não tem permissão de leitura sobre ele, ou esse arquivo não existe mais para o perfil de usuário sob o qual a aplicação está rodando. Três soluções cobrem quase todos os casos: conceder à identidade do processo acesso de leitura à chave privada (snap-in de certificados ou `icacls` no arquivo do contêiner de chaves), carregar o PFX com `X509KeyStorageFlags.MachineKeySet | PersistKeySet` para que a chave caia no armazenamento de máquina, ou carregar o PFX com `EphemeralKeySet` para que nenhum arquivo em disco seja necessário.

```text
System.Security.Cryptography.CryptographicException: Keyset does not exist
   at System.Security.Cryptography.CryptographicException.ThrowCryptographicException(Int32 hr)
   at System.Security.Cryptography.X509Certificates.CertificatePal.GetPrivateKey[T](Func`2 createCsp, Func`2 createCng)
   at System.Security.Cryptography.X509Certificates.X509Certificate2.GetRSAPrivateKey()
   at MyApp.SigningService.Sign(Byte[] payload)
```

Este guia foi escrito contra .NET 11 preview 4 no Windows Server 2025 / Windows 11 24H2. O erro permanece idêntico desde o .NET Framework 1.1 porque a mensagem vem literalmente do `NTE_BAD_KEYSET` em `winerror.h`. O que mudou no .NET moderno foi o **comportamento padrão de armazenamento de chaves** ao carregar um PFX: o .NET 9 introduziu o `X509CertificateLoader`, marcou como obsoletos os construtores `X509Certificate2(byte[])` e `new X509Certificate2(path, password)` para conteúdo PFX (`SYSLIB0057`) e mudou o caminho de carregamento recomendado. A nova API **não** persiste chaves silenciosamente em disco da forma que os construtores antigos faziam. Se você substituiu um pelo outro de maneira mecânica, o erro que está lendo é a consequência.

Duas coisas para verificar antes de aplicar qualquer solução abaixo. Primeiro, `certificate.HasPrivateKey` retorna `true` mesmo quando o arquivo de chave está ausente ou inacessível. A flag rastreia se os **metadados do certificado** anunciam uma chave privada, não se você realmente consegue abri-la. Segundo, o erro é idêntico para um contêiner de chaves ausente, um contêiner em outro perfil de usuário e um contêiner cuja ACL nega seu processo. A solução depende de qual dos três você está vendo; as seções abaixo percorrem cada um em ordem.

## Por que um certificado tem um arquivo de chave

No Windows, um certificado X.509 é um documento público. A chave privada correspondente nunca está no arquivo do certificado; ela mora em um contêiner de chaves administrado pelo provedor criptográfico. Há dois provedores e dois escopos que você precisa manter claros:

- **CAPI (Microsoft Cryptographic API)**: provedor legado, contêineres de chaves armazenados em `%APPDATA%\Microsoft\Crypto\RSA\<SID>\` para o escopo de usuário e `%ProgramData%\Microsoft\Crypto\RSA\MachineKeys\` para o escopo de máquina. Cada contêiner é um único arquivo com nome similar a um GUID.
- **CNG (Cryptography Next Generation)**: provedor moderno, contêineres de chaves em `%APPDATA%\Microsoft\Crypto\Keys\` e `%ProgramData%\Microsoft\Crypto\Keys\` respectivamente.

Quando você importa um PFX, o carregador grava o certificado no **armazenamento de certificados Pessoal** (`Cert:\CurrentUser\My` ou `Cert:\LocalMachine\My`) e o material da chave em um desses quatro diretórios, conforme o `X509KeyStorageFlags`. Tirar o certificado do armazenamento e colocá-lo em um `X509Certificate2` recupera apenas a parte pública mais um ponteiro para o contêiner de chaves. Na primeira vez que você chama `GetRSAPrivateKey()`, `GetECDsaPrivateKey()` ou a propriedade obsoleta `PrivateKey`, o runtime abre esse contêiner pela API Win32 correspondente. Se o arquivo sumiu, o SID não tem uma ACE de leitura ou o caminho resolve para um perfil que não existe na sessão de logon atual, você recebe `NTE_BAD_KEYSET`.

A conclusão é que o certificado e a chave são desacoplados, e a pergunta "este processo tem a chave privada?" na verdade é "esta identidade de processo tem acesso de leitura ao arquivo referenciado por este certificado?". Cada solução abaixo responde a essa pergunta de uma forma diferente.

## Reprodução mínima

O menor programa que reproduz o erro depois de migrar para o carregador do .NET 9+:

```csharp
// .NET 11 preview 4, Windows 11 24H2
using System.Security.Cryptography.X509Certificates;

var bytes = File.ReadAllBytes("signing.pfx");
var cert = X509CertificateLoader.LoadPkcs12(bytes, password: "test");

using var rsa = cert.GetRSAPrivateKey();
var signature = rsa!.SignData("hello"u8.ToArray(), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
```

Execute isso a partir de uma sessão interativa de desktop e funciona. Execute o mesmo binário como serviço do Windows sob `NT SERVICE\MyService`, ou a partir de um pool de aplicações do IIS com `LoadUserProfile = false`, e `GetRSAPrivateKey()` lança "Keyset does not exist". O PFX foi carregado direito. O objeto do certificado foi construído. A falha acontece no momento exato em que você tenta acessar a chave privada.

O motivo: `X509CertificateLoader.LoadPkcs12` usa por padrão `X509KeyStorageFlags.DefaultKeySet`, o que no Windows significa o armazenamento de chaves de **usuário**. Uma identidade de serviço sem perfil de usuário carregado não tem `%APPDATA%\Microsoft\Crypto\...` onde gravar, então o arquivo de chave é criado em um local temporário inalcançável na próxima chamada, ou não é criado de jeito nenhum.

## Solução 1: conceder à identidade atual acesso de leitura à chave

Esta é a solução certa quando o certificado já está instalado no armazenamento de máquina e você não controla o código de importação (típico para servidores administrados por operações). Abra `certlm.msc` (LocalMachine) ou `certmgr.msc` (CurrentUser), localize o certificado em **Pessoal > Certificados**, clique com o botão direito, **Todas as Tarefas > Gerenciar Chaves Privadas**, e adicione a identidade do processo com permissão de **Leitura**.

A mesma operação a partir do PowerShell, automatizada para um pool de aplicações do IIS:

```powershell
# Windows 11 24H2 / Windows Server 2025, PowerShell 7.5
$cert = Get-ChildItem Cert:\LocalMachine\My | Where-Object Thumbprint -eq 'AABBCC...'
$keyFile = $cert.PrivateKey.Key.UniqueName  # CNG

$keyPath = Join-Path $env:ProgramData "Microsoft\Crypto\Keys\$keyFile"
$acl = Get-Acl $keyPath
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    'IIS APPPOOL\MyAppPool', 'Read', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl $keyPath $acl
```

Para certificados CAPI, troque `Crypto\Keys` por `Crypto\RSA\MachineKeys` e leia `cert.PrivateKey.CspKeyContainerInfo.UniqueKeyContainerName` no lugar. O cmdlet `Get-PfxCertificate` parece tentador aqui, mas não retorna o certificado vivo do armazenamento; use `Get-ChildItem Cert:\...` para que a propriedade `PrivateKey` aponte para o contêiner em disco.

Para um serviço do Windows rodando sob `NT SERVICE\<NomeDoServico>`, o SID é virtual e você concede com `icacls`:

```powershell
icacls $keyPath /grant "NT SERVICE\MyService:R"
```

Se você não tem certeza de qual SID seu processo está usando, `whoami /user` em um prompt aberto com aquela identidade imprime o SID. Para serviços do Windows em contêineres, `nt authority\system` e `nt authority\network service` são os suspeitos habituais.

## Solução 2: carregar o PFX com as flags de armazenamento corretas

Esta é a solução certa quando sua aplicação é dona do arquivo do certificado e o carrega no startup. Pare de depender de `DefaultKeySet` e seja explícito:

```csharp
// .NET 11 preview 4, long-running service that needs the key to survive restarts
var cert = X509CertificateLoader.LoadPkcs12FromFile(
    "signing.pfx",
    password: "test",
    keyStorageFlags: X509KeyStorageFlags.MachineKeySet
                   | X509KeyStorageFlags.PersistKeySet
                   | X509KeyStorageFlags.Exportable);
```

`MachineKeySet` grava a chave em `%ProgramData%\Microsoft\Crypto\Keys` (CNG) sob uma ACL que a identidade do serviço consegue ler. `PersistKeySet` mantém o arquivo em disco depois do `X509Certificate2` ser descartado; sem ele, o comportamento padrão desde o .NET Framework 4.7.2 é apagar a chave no instante em que o objeto do certificado sai do escopo, o que produz "Keyset does not exist" na **segunda** chamada do mesmo caminho de código. `Exportable` é opcional e só faz sentido se você for chamar `ExportPkcs8PrivateKey` depois ou gravar a chave em outro armazenamento. Observação: `PersistKeySet` e `EphemeralKeySet` são mutuamente exclusivos; passar os dois lança `CryptographicException` a partir do `X509CertificateLoader`.

Para uma aplicação .NET 11 hospedada em que você só precisa da chave em processo e nunca quer um arquivo em disco, use `EphemeralKeySet` e elimine a questão da persistência:

```csharp
// .NET 11 preview 4, ASP.NET Core minimal API loading a cert from configuration
var cert = X509CertificateLoader.LoadPkcs12FromFile(
    path,
    password,
    keyStorageFlags: X509KeyStorageFlags.EphemeralKeySet);
```

`EphemeralKeySet` é a escolha mais robusta para contêineres, cargas com scale-to-zero e qualquer ambiente onde o perfil de usuário pode estar faltando ou ser reciclado. A chave vive apenas dentro da instância `X509Certificate2`; quando você a descarta, a chave desaparece. O trade-off é que o certificado não pode ser importado para o armazenamento do Windows depois, e no .NET Framework anterior ao 4.7.2 / .NET Core anterior ao 2.0 a flag não existia. No Linux e macOS é um no-op porque não existe arquivo de chaves do Windows.

## Solução 3: peculiaridades de identidade de pool do IIS e de serviço do Windows

Pools de aplicações do IIS são a fonte individual mais comum desse erro. Dois ajustes determinam se a busca pela chave privada vai funcionar:

- **Carregar Perfil de Usuário**: em `applicationHost.config` ou no Gerenciador do IIS, em **Configurações Avançadas** do pool, ajuste **Carregar Perfil de Usuário** para `True`. Sem isso, a identidade `IIS APPPOOL\MyAppPool` não tem `%APPDATA%`, então qualquer caminho de código que use por padrão `UserKeySet` ou `DefaultKeySet` falha na segunda chamada.
- **Modelo de Processo > Identidade**: mantenha em `ApplicationPoolIdentity` e conceda ao SID virtual `IIS APPPOOL\MyAppPool` acesso de leitura no arquivo de chave (Solução 1). Não rode pools como `LocalSystem` para "contornar" isso; é uma escalada real de privilégios, não uma solução.

Para serviços do Windows escritos com o [template de serviço hospedado do .NET 11](/pt-br/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) mais `Microsoft.Extensions.Hosting.WindowsServices`, a configuração equivalente é registrar o serviço com sua própria conta virtual:

```powershell
sc.exe create MyService binPath= "C:\svc\MyService.exe" obj= "NT SERVICE\MyService" start= auto
icacls "C:\ProgramData\Microsoft\Crypto\Keys\<keyfile>" /grant "NT SERVICE\MyService:R"
```

Evite rodar serviços sob `LocalSystem` pela mesma razão dos pools de aplicações: acidentalmente também concede leitura em todas as outras chaves de máquina no host. O princípio do menor privilégio se aplica a contêineres de criptografia tanto quanto a caminhos de arquivo.

## Solução 4: Azure App Service, Azure Functions, contêineres

Hosts de nuvem sofrem uma versão mais afiada desse problema porque o sistema de arquivos subjacente não é seu. Três ajustes específicos de plataforma:

- **Azure App Service**: faça upload do PFX/PEM em **TLS/SSL settings > Private Key Certificates**, depois configure a configuração de aplicação `WEBSITE_LOAD_CERTIFICATES` para `*` ou para o thumbprint do certificado. O sandbox do App Service recusa carregar a chave privada a menos que essa variável permita explicitamente o thumbprint; sem isso, você recebe "Keyset does not exist" no momento em que chama `GetRSAPrivateKey()`. A configuração `WEBSITE_LOAD_USER_PROFILE = 1` é o equivalente no App Service ao **Carregar Perfil de Usuário** do IIS e é obrigatória se o caminho do seu código resolve para chaves de usuário.
- **Azure Functions (Windows consumption / Premium)**: mesma exigência de `WEBSITE_LOAD_CERTIFICATES`. Para funções isolated worker, prefira carregar o certificado de `cert:\CurrentUser\My` em vez de ler um PFX de `D:\home\site\wwwroot`, porque esse caminho PFX é somente leitura e `PersistKeySet` falhará silenciosamente.
- **Contêineres Linux (incluindo planos Linux App Service e AKS)**: não há arquivo de chaves do Windows, então `X509KeyStorageFlags` que não sejam `EphemeralKeySet` são efetivamente ignoradas. O erro que você verá em imagens `dotnet publish` não é "Keyset does not exist", mas sim `PlatformNotSupportedException` se você recorrer a `CspParameters` ou ao setter `PrivateKey = ...`. Use a API moderna `CopyWithPrivateKey` e `EphemeralKeySet` e o código fica portátil.

Para [funções AWS Lambda em .NET 11](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/), aplica-se a mesma lógica dos contêineres Linux: não há armazenamento de chaves do Windows, carregue o PFX com `EphemeralKeySet` a partir de uma Lambda layer ou do Secrets Manager, nunca de `/tmp` entre invocações, porque o sandbox não garante que `/tmp` sobreviva entre cold starts.

## Solução 5: leia a chave com a API moderna, não com `PrivateKey`

A propriedade `X509Certificate2.PrivateKey` ainda existe no .NET 11 mas está obsoleta (`SYSLIB0028` para o setter, `SYSLIB0058` para o getter em chaves EC). Ela retorna um `AsymmetricAlgorithm` que internamente chama CAPI, mesmo quando o certificado foi importado como CNG, e a camada CAPI é a que mais consistentemente lança "Keyset does not exist" quando o contêiner de chaves não está presente. Os acessores modernos fazem uma checagem extra antes de abrir o arquivo e expõem exceções mais claras:

```csharp
// .NET 11 preview 4
using var rsa = cert.GetRSAPrivateKey();
using var ecdsa = cert.GetECDsaPrivateKey();
using var dsa = cert.GetDSAPrivateKey();
```

Se `HasPrivateKey` é `true` mas `GetRSAPrivateKey()` retorna `null`, o certificado usa um algoritmo não-RSA; tente `GetECDsaPrivateKey()`. Se `GetRSAPrivateKey()` lança "Keyset does not exist", os metadados afirmam que existe uma chave, o arquivo não existe, e cabe uma das Soluções 1 a 4.

## Pegadinhas e erros parecidos

- **`X509CertificateLoader` não é opcional no .NET 11.** O antigo construtor `new X509Certificate2(path, password)` está marcado com `SYSLIB0057` e será removido em uma versão futura. Migre agora e revise suas escolhas de `X509KeyStorageFlags`, porque os padrões do carregador são mais estritos.
- **`HasPrivateKey` mente.** Ele checa a extensão `keyUsage` do certificado e a presença de um `CERT_KEY_PROV_INFO_PROP_ID`, não se o arquivo em `Crypto\Keys` abre limpo. Teste recuperando a chave de fato, capture `CryptographicException` e trate como "sem chave", em vez de ramificar no `HasPrivateKey`.
- **"Access is denied" é o erro primo.** Mesma causa raiz (ACL ausente), caminho de código diferente: o CAPI legado retorna `NTE_BAD_KEYSET`, o CNG moderno às vezes retorna `0x80090010 NTE_PERM` que aparece como `CryptographicException: Access is denied`. A solução é idêntica; o resultado de busca é diferente.
- **O PFX está bem; a referência no armazenamento está obsoleta.** Se você importou um PFX, removeu de `Cert:\LocalMachine\My` e re-importou, o caminho do arquivo de chave dentro dos metadados do certificado pode apontar para o contêiner antigo (removido). Exporte, apague completamente (com `Remove-Item Cert:\LocalMachine\My\<thumbprint>` mais `certutil -delstore`) e re-importe.
- **`SqlClient` e `X509Chain.Build()` lançam a mesma exceção.** Ambos chamam `GetRSAPrivateKey()` por baixo dos panos ao validar cadeias ou assinar connection strings. Uma conexão SQL falhando em autenticação por certificado com essa mensagem é o mesmo bug que um assinador de JWT falhando com ela; o [modo de falha `SqlException: Timeout expired`](/pt-br/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/) não tem relação.
- **Conflitos CryptoAPI vs CNG.** Importar um PFX gerado por CAPI via CNG (ou vice-versa) às vezes deixa a chave em um provedor com metadados apontando para o outro. `certutil -repairstore My <thumbprint>` reconstrói o link sem re-importar.
- **O perfil de usuário não está carregado.** Tarefas Agendadas, pools do IIS sem `LoadUserProfile` e contêineres Docker Windows rodando como `ContainerUser` compartilham essa característica. Ou liga o ajuste de perfil, ou muda para chaves de máquina, ou usa `EphemeralKeySet`.

## Relacionado

- [Solução: System.IO.FileNotFoundException: Could not load file or assembly](/pt-br/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) cobre a outra metade dos erros de deployment "funciona na minha máquina", em que o problema é o binário e não a chave.
- [Solução: PlatformNotSupportedException em Native AOT](/pt-br/2026/05/fix-platformnotsupportedexception-in-native-aot/) é o que você vê se publica uma aplicação Native AOT e chama `new RSACryptoServiceProvider()` diretamente; o compilador AOT remove a camada CAPI por completo.
- [Como implementar refresh tokens no ASP.NET Core Identity](/pt-br/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) mostra o encanamento ao redor do motivo mais comum para você carregar uma chave privada: assinar JWTs em um provedor de identidade hospedado.
- [Como reduzir o tempo de cold start de um AWS Lambda em .NET 11](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) discute o carregamento de certificados em ambientes serverless, onde `EphemeralKeySet` é a única flag de armazenamento de chaves que faz a coisa certa.
- [Como configurar logging estruturado com Serilog e Seq no .NET 11](/pt-br/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) é útil para rastrear o momento exato em que o acesso à chave falha em um serviço de produção, já que operações de `X509Certificate2` não geram log algum por padrão.

## Fontes

- [`X509KeyStorageFlags` Enum, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.x509keystorageflags)
- [`X509CertificateLoader` class, .NET 9+, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.x509certificateloader)
- [`SYSLIB0057`: Obsolete X509Certificate2 PFX constructors](https://learn.microsoft.com/en-us/dotnet/fundamentals/syslib-diagnostics/syslib0057)
- [Private Key Lifetime on Windows, January 2021 .NET Framework rollup, Microsoft Support](https://support.microsoft.com/en-us/topic/private-key-lifetime-on-windows-and-the-january-2021-net-framework-security-and-quality-rollup-3f097a10-f798-4ffd-8511-4757ebaf2c70)
- [`dotnet/runtime` issue 67752: occasional "Keyset does not exist" with `GetRSAPrivateKey` on Windows](https://github.com/dotnet/runtime/issues/67752)
- [`dotnet/aspnetcore` issue 3218: Data Protection "Keyset does not exist" even with PrivateKey set programmatically](https://github.com/dotnet/aspnetcore/issues/3218)
- [Load certificates in Azure App Service, MS Learn](https://learn.microsoft.com/en-us/azure/app-service/configure-ssl-certificate-in-code)

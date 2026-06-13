---
title: "Correção: The SSL connection could not be established com HttpClient"
description: "A AuthenticationException interna informa a causa real: uma cadeia não confiável, um nome que não corresponde ou uma diferença de versão do TLS. Confie no certificado, corrija o host ou alinhe os protocolos. Não desative a validação por completo."
pubDate: 2026-06-13
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "httpclient"
lang: "pt-br"
translationOf: "2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient"
translatedBy: "claude"
translationDate: 2026-06-13
---

`HttpRequestException: The SSL connection could not be established, see inner exception` quase nunca significa o que a mensagem externa diz. O handshake do TLS falhou, e a causa real está na `InnerException`: uma cadeia de certificados não confiável (`RemoteCertificateChainErrors`), um host que não corresponde ao certificado (`RemoteCertificateNameMismatch`), ou uma diferença de protocolo. Leia primeiro a exceção interna, depois corrija a cadeia, o host ou a versão do TLS. Não recorra a `ServerCertificateCustomValidationCallback => true` em produção: isso desativa a proteção que o handshake existe para fornecer.

Isto se aplica ao `HttpClient` no .NET 11 (`.NET 11`), mas o mesmo maquinário do `SslStream` e o mesmo diagnóstico remontam ao .NET Core 3.1.

## O erro em contexto

A exceção externa é genérica. A linha que importa é a interna:

```
System.Net.Http.HttpRequestException: The SSL connection could not be established, see inner exception.
 ---> System.Security.Authentication.AuthenticationException: The remote certificate is invalid according to the validation procedure: RemoteCertificateChainErrors, RemoteCertificateNameMismatch
   at System.Net.Security.SslStream.SendAuthResetSignal(...)
   at System.Net.Http.ConnectHelper.EstablishSslConnectionAsync(...)
   at System.Net.Http.HttpConnectionPool.ConnectAsync(...)
```

No .NET 8 e versões posteriores você nem precisa abrir a exceção interna na mão. `HttpRequestException` carrega um enum `HttpRequestError`, e uma falha de handshake aparece como `HttpRequestError.SecureConnectionError`:

```csharp
// .NET 11, C# 14
try
{
    using var response = await client.GetAsync("https://api.example.com");
}
catch (HttpRequestException ex) when (ex.HttpRequestError == HttpRequestError.SecureConnectionError)
{
    // TLS handshake failed. Inspect ex.InnerException for the AuthenticationException.
    Console.WriteLine(ex.InnerException?.Message);
}
```

A string depois de "according to the validation procedure:" é todo o diagnóstico. É uma lista separada por vírgulas de flags `SslPolicyErrors`, e cada um aponta para uma correção distinta.

## Por que isso acontece

O handshake falha por uma de três razões, e a mensagem interna indica qual:

- **`RemoteCertificateChainErrors`**: o certificado do servidor é real, mas sua máquina não confia na cadeia que o assinou. Certificados autoassinados, uma CA corporativa interna que não está no repositório de confiança, uma folha ou intermediária expirada, ou um servidor que esqueceu de enviar seu certificado intermediário: todos caem aqui.
- **`RemoteCertificateNameMismatch`**: o certificado é confiável, mas o nome nele não corresponde ao host ao qual você se conectou. Você chamou `https://10.0.0.5` mas o certificado é emitido para `api.internal`, ou você acessou `https://localhost` contra um certificado para `127.0.0.1`.
- **`RemoteCertificateNotAvailable`**: o servidor não apresentou nenhum certificado, o que normalmente significa que você está falando TLS com uma porta que na verdade não serve TLS.

Uma quarta classe não produz nenhum `SslPolicyErrors`. Se a exceção interna for uma `Win32Exception` ("The client and server cannot communicate, because they do not possess a common algorithm") ou um seco "The SSL connection could not be established" sem lista de políticas, os dois lados não conseguiram concordar em uma versão do TLS ou conjunto de cifras. Desde o .NET 5 o padrão do cliente tem sido `SslProtocols.None`, que significa "deixe o sistema operacional escolher o melhor disponível", e em um sistema operacional atual isso negocia TLS 1.3 ou TLS 1.2. Um servidor preso no TLS 1.0/1.1, ou um cujos únicos conjuntos de cifras seu sistema operacional tem desabilitados, cai neste grupo.

## Reprodução mínima

O menor programa que reproduz o erro de cadeia aponta o `HttpClient` para um host com um certificado autoassinado ou de outra forma não confiável:

```csharp
// .NET 11, C# 14
using var client = new HttpClient();

// A host whose cert chains to a CA this machine does not trust.
using var response = await client.GetAsync("https://self-signed.badssl.com/");
response.EnsureSuccessStatusCode();
```

Execute-o e você obtém a forma `RemoteCertificateChainErrors`. Troque a URL por `https://wrong.host.badssl.com/` e você obtém `RemoteCertificateNameMismatch` em vez disso. Esses dois endpoints públicos são a maneira mais rápida de confirmar que seu código de tratamento bifurca corretamente sem subir seu próprio servidor quebrado.

## A correção, em detalhe

Escolha a correção que corresponde à exceção interna. Elas estão ordenadas de "correta em produção" a "apenas para desenvolvimento".

### 1. Erros de cadeia: confie no certificado, não ignore a validação

Se a mensagem interna for `RemoteCertificateChainErrors`, a correção certa é tornar a cadeia confiável, não parar de verificá-la.

Para uma CA corporativa interna, instale o certificado raiz da CA no repositório de confiança da máquina. No Linux isso significa colocar o PEM no pacote de confiança do sistema operacional, porque o .NET no Linux lê o repositório de confiança do OpenSSL, não um específico do .NET:

```bash
# Ubuntu/Debian: install a corporate root CA so .NET trusts it
sudo cp corp-root-ca.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates
```

No Windows, importe a raiz em `Cert:\LocalMachine\Root`. Depois disso, o `HttpClient` valida a cadeia sem alterações de código, porque a validação lê o repositório do sistema operacional.

Se você não puder tocar no repositório da máquina (hosts bloqueados, contêineres efêmeros), fixe o certificado específico que você espera em vez de confiar em tudo. Isso mantém a validação ativa para qualquer outro servidor enquanto aceita exatamente um certificado conhecido:

```csharp
// .NET 11, C# 14
// Pin the expected leaf/intermediate by thumbprint. Real validation stays on
// for chains we did not explicitly pin.
var expectedThumbprint = "A1B2C3...";

var handler = new SocketsHttpHandler
{
    SslOptions = new SslClientAuthenticationOptions
    {
        RemoteCertificateValidationCallback = (sender, cert, chain, errors) =>
        {
            if (errors == SslPolicyErrors.None) return true;
            return cert is not null
                && cert.GetCertHashString().Equals(expectedThumbprint, StringComparison.OrdinalIgnoreCase);
        }
    }
};

using var client = new HttpClient(handler);
```

Repare na forma: o callback retorna `true` para as cadeias que já passam (`SslPolicyErrors.None`), e, fora isso, aceita apenas o único certificado que você fixou. Essa é a diferença entre pinning de certificado e desligar a validação.

### 2. Nome que não corresponde: corrija a URL ou o certificado

`RemoteCertificateNameMismatch` significa que você se conectou a um nome para o qual o certificado não foi emitido. A correção quase sempre é usar o host correto na URL, aquele que aparece na lista de Subject Alternative Name do certificado. Conectar-se por endereço IP é o gatilho clássico, porque certificados são emitidos para nomes DNS, não IPs.

Se a URL está correta e o certificado simplesmente está errado (uma verdadeira má configuração em um servidor que você controla), reemita o certificado com as entradas SAN corretas. Se você realmente precisa se conectar por um endereço que difere do nome do certificado, defina o host SNI do TLS explicitamente para que o nome negociado corresponda ao certificado, em vez de desativar a verificação do nome:

```csharp
// .NET 11, C# 14
var handler = new SocketsHttpHandler
{
    SslOptions = new SslClientAuthenticationOptions
    {
        // Present this name in the TLS handshake even though the URL uses an IP.
        TargetHost = "api.internal"
    }
};
using var client = new HttpClient(handler);
```

### 3. Diferença de protocolo ou cifra: alinhe as versões do TLS

Se não houver lista de erros de política e o handshake simplesmente falhar, os dois lados não conseguiram concordar em um protocolo. Deixe o cliente em `SslProtocols.None` (o padrão negociado pelo sistema operacional) e corrija o servidor para oferecer TLS 1.2 ou 1.3. Forçar o cliente a descer para TLS 1.0/1.1 para corresponder a um servidor legado é um último recurso, e em um sistema operacional moderno esses protocolos muitas vezes estão desabilitados no nível do sistema operacional de qualquer forma, então a configuração explícita silenciosamente não faz nada. Se você precisar, fica assim:

```csharp
// .NET 11, C# 14 - last resort for a legacy server you cannot upgrade
var handler = new SocketsHttpHandler
{
    SslOptions = new SslClientAuthenticationOptions
    {
        EnabledSslProtocols = System.Security.Authentication.SslProtocols.Tls12
    }
};
```

### 4. HTTPS local: confie no certificado de desenvolvimento do ASP.NET Core

Se você esbarrar nisso chamando seu próprio serviço por `https://localhost` durante o desenvolvimento, a correção é confiar no certificado de desenvolvimento local uma vez:

```bash
dotnet dev-certs https --trust
```

Esta é a correção local correta. Ela não enfraquece a validação, porque instala um certificado confiável real para `localhost` em vez de dizer ao cliente para pular a verificação.

## Armadilhas e variantes

**`ServerCertificateCustomValidationCallback => true` não é uma correção.** É a resposta mais votada do StackOverflow e está errada fora de um teste descartável. Retornar `true` incondicionalmente aceita qualquer certificado de qualquer um, o que transforma HTTPS em texto puro com passos extras e reabre exatamente o buraco de man-in-the-middle que o TLS previne. Se você o usar para desbloquear uma demo, restrinja-o para que ele nunca possa ir para produção: proteja-o com `if (env.IsDevelopment())` e verifique que ele esteja desativado em produção. O callback de pinning da correção 1 é o que você quer quando precisa aceitar um certificado específico não público de verdade.

**Funciona no Postman ou curl mas falha no .NET.** Essas ferramentas e o .NET leem repositórios de confiança diferentes. O curl no Linux usa o pacote do OpenSSL (que o .NET também lê), mas o Postman traz sua própria lista de CA e as ferramentas do Windows leem o repositório do Windows. Uma CA confiável para uma não é automaticamente confiável para as outras. Instale a raiz no repositório que o .NET realmente lê para o seu sistema operacional.

**Funciona no Windows, falha em um contêiner Linux.** Mesma causa raiz. A CA raiz corporativa está no repositório de confiança do Windows do desenvolvedor mas nunca foi adicionada à imagem do contêiner. Adicione a CA no seu Dockerfile com `update-ca-certificates` antes de o aplicativo rodar, ou monte-a.

**O servidor esqueceu seu certificado intermediário.** Um servidor pode estar configurado com uma folha válida mas falhar ao enviar a intermediária que o encadeia a uma raiz confiável. Navegadores muitas vezes disfarçam isso cacheando intermediárias de sessões anteriores; o .NET não. A correção pertence ao servidor: configure-o para enviar a cadeia completa. Você pode confirmar com `openssl s_client -connect host:443 -showcerts` e contando os certificados retornados.

**`AuthenticationException` com `RemoteCertificateNotAvailable`.** O servidor não enviou nenhum certificado. Você quase certamente está apontando para uma porta de HTTP puro com um esquema `https://`, ou para um serviço que ainda não está no ar. Verifique a porta e o esquema antes de tocar em qualquer código de TLS.

**Não confunda isso com `TaskCanceledException`.** Um handshake que trava e depois dispara `HttpClient.Timeout` aparece como um cancelamento, não como um erro de TLS. Se o seu sintoma for um timeout em vez de uma mensagem de validação, a causa e a correção são diferentes.

## Leituras relacionadas

- [Correção: TaskCanceledException: A task was canceled no HttpClient](/pt-br/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) cobre as falhas em forma de timeout que se parecem superficialmente com um handshake lento mas têm uma causa raiz completamente distinta.
- [HttpClient vs HttpClientFactory vs Refit](/pt-br/2026/05/httpclient-vs-httpclientfactory-vs-refit/) explica onde configurar um `SocketsHttpHandler` personalizado para que suas configurações de TLS sobrevivam à reutilização do cliente.
- [Como fazer testes unitários de código que usa HttpClient](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/) mostra como simular o transporte para que você possa exercitar as ramificações de erro acima sem um servidor quebrado ao vivo.
- [Como adicionar um filtro de exceções global no ASP.NET Core 11](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) ajuda você a expor essa exceção com a mensagem interna intacta em vez de um 500 seco.

## Fontes

- [Enum `SslPolicyErrors`](https://learn.microsoft.com/en-us/dotnet/api/system.net.security.sslpolicyerrors), Microsoft Learn: os flags (`RemoteCertificateChainErrors`, `RemoteCertificateNameMismatch`, `RemoteCertificateNotAvailable`) que aparecem na mensagem interna.
- [Enum `HttpRequestError`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httprequesterror), Microsoft Learn: o valor `SecureConnectionError` usado para classificar a falha no .NET 8+.
- [`SslClientAuthenticationOptions`](https://learn.microsoft.com/en-us/dotnet/api/system.net.security.sslclientauthenticationoptions), Microsoft Learn: `TargetHost`, `EnabledSslProtocols` e `RemoteCertificateValidationCallback` no `SocketsHttpHandler`.
- [Enforce TLS in .NET](https://learn.microsoft.com/en-us/dotnet/framework/network-programming/tls), Microsoft Learn: por que `SslProtocols.None` (negociado pelo sistema operacional) é o padrão recomendado.
- [dotnet/runtime #32498: The SSL connection could not be established](https://github.com/dotnet/runtime/issues/32498): relatos do mundo real e o diagnóstico do repositório de confiança.

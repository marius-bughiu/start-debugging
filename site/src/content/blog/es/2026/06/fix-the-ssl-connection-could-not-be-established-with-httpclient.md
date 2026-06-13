---
title: "Solución: The SSL connection could not be established con HttpClient"
description: "La AuthenticationException interna te dice la causa real: una cadena no confiable, un nombre que no coincide o una diferencia de versión de TLS. Confía en el certificado, corrige el host o alinea los protocolos. No desactives la validación por completo."
pubDate: 2026-06-13
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "httpclient"
lang: "es"
translationOf: "2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient"
translatedBy: "claude"
translationDate: 2026-06-13
---

`HttpRequestException: The SSL connection could not be established, see inner exception` casi nunca significa lo que dice el mensaje externo. El handshake de TLS falló, y la causa real está en la `InnerException`: una cadena de certificados no confiable (`RemoteCertificateChainErrors`), un host que no coincide con el certificado (`RemoteCertificateNameMismatch`), o una diferencia de protocolo. Lee primero la excepción interna, luego corrige la cadena, el host o la versión de TLS. No recurras a `ServerCertificateCustomValidationCallback => true` en producción: eso desactiva la protección que el handshake existe para proporcionar.

Esto aplica a `HttpClient` en .NET 11 (`.NET 11`), pero la misma maquinaria de `SslStream` y el mismo diagnóstico se remontan a .NET Core 3.1.

## El error en contexto

La excepción externa es genérica. La línea que importa es la interna:

```
System.Net.Http.HttpRequestException: The SSL connection could not be established, see inner exception.
 ---> System.Security.Authentication.AuthenticationException: The remote certificate is invalid according to the validation procedure: RemoteCertificateChainErrors, RemoteCertificateNameMismatch
   at System.Net.Security.SslStream.SendAuthResetSignal(...)
   at System.Net.Http.ConnectHelper.EstablishSslConnectionAsync(...)
   at System.Net.Http.HttpConnectionPool.ConnectAsync(...)
```

En .NET 8 y versiones posteriores ni siquiera tienes que abrir la excepción interna a mano. `HttpRequestException` lleva un enum `HttpRequestError`, y un fallo de handshake aparece como `HttpRequestError.SecureConnectionError`:

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

La cadena después de "according to the validation procedure:" es todo el diagnóstico. Es una lista separada por comas de flags `SslPolicyErrors`, y cada uno apunta a una solución distinta.

## Por qué ocurre

El handshake falla por una de tres razones, y el mensaje interno indica cuál:

- **`RemoteCertificateChainErrors`**: el certificado del servidor es real, pero tu máquina no confía en la cadena que lo firmó. Certificados autofirmados, una CA corporativa interna que no está en el almacén de confianza, una hoja o intermedia caducada, o un servidor que olvidó enviar su certificado intermedio: todos caen aquí.
- **`RemoteCertificateNameMismatch`**: el certificado es de confianza, pero el nombre que aparece en él no coincide con el host al que te conectaste. Llamaste a `https://10.0.0.5` pero el certificado está emitido para `api.internal`, o accediste a `https://localhost` contra un certificado para `127.0.0.1`.
- **`RemoteCertificateNotAvailable`**: el servidor no presentó ningún certificado, lo que normalmente significa que estás hablando TLS con un puerto que en realidad no sirve TLS.

Una cuarta clase no produce ningún `SslPolicyErrors`. Si la excepción interna es una `Win32Exception` ("The client and server cannot communicate, because they do not possess a common algorithm") o un escueto "The SSL connection could not be established" sin lista de políticas, los dos extremos no pudieron ponerse de acuerdo en una versión de TLS o un conjunto de cifrado. Desde .NET 5 el valor predeterminado del cliente ha sido `SslProtocols.None`, que significa "deja que el sistema operativo elija lo mejor disponible", y en un sistema operativo actual eso negocia TLS 1.3 o TLS 1.2. Un servidor atascado en TLS 1.0/1.1, o uno cuyos únicos conjuntos de cifrado tu sistema operativo tiene deshabilitados, cae en este grupo.

## Reproducción mínima

El programa más pequeño que reproduce el error de cadena apunta `HttpClient` a un host con un certificado autofirmado o de otro modo no confiable:

```csharp
// .NET 11, C# 14
using var client = new HttpClient();

// A host whose cert chains to a CA this machine does not trust.
using var response = await client.GetAsync("https://self-signed.badssl.com/");
response.EnsureSuccessStatusCode();
```

Ejecútalo y obtienes la forma `RemoteCertificateChainErrors`. Cambia la URL por `https://wrong.host.badssl.com/` y obtienes `RemoteCertificateNameMismatch` en su lugar. Estos dos endpoints públicos son la forma más rápida de confirmar que tu código de manejo bifurca correctamente sin levantar tu propio servidor roto.

## La solución, en detalle

Elige la solución que coincida con la excepción interna. Están ordenadas de "correcta en producción" a "solo para desarrollo".

### 1. Errores de cadena: confía en el certificado, no omitas la validación

Si el mensaje interno es `RemoteCertificateChainErrors`, la solución correcta es hacer que la cadena sea confiable, no dejar de comprobarla.

Para una CA corporativa interna, instala el certificado raíz de la CA en el almacén de confianza de la máquina. En Linux eso significa colocar el PEM en el paquete de confianza del sistema operativo, porque .NET en Linux lee el almacén de confianza de OpenSSL, no uno específico de .NET:

```bash
# Ubuntu/Debian: install a corporate root CA so .NET trusts it
sudo cp corp-root-ca.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates
```

En Windows, importa la raíz en `Cert:\LocalMachine\Root`. Después de eso, `HttpClient` valida la cadena sin cambios de código, porque la validación lee el almacén del sistema operativo.

Si no puedes tocar el almacén de la máquina (hosts bloqueados, contenedores efímeros), fija el certificado específico que esperas en lugar de confiar en todo. Esto mantiene la validación activa para cualquier otro servidor mientras acepta exactamente un certificado conocido:

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

Fíjate en la forma: el callback devuelve `true` para las cadenas que ya pasan (`SslPolicyErrors.None`), y por lo demás acepta solo el único certificado que fijaste. Esa es la diferencia entre el pinning de certificados y desactivar la validación.

### 2. Nombre que no coincide: corrige la URL o el certificado

`RemoteCertificateNameMismatch` significa que te conectaste a un nombre para el que el certificado no fue emitido. La solución casi siempre es usar el host correcto en la URL, el que aparece en la lista de Subject Alternative Name del certificado. Conectarse por dirección IP es el detonante clásico, porque los certificados se emiten para nombres DNS, no IPs.

Si la URL es correcta y el certificado simplemente está mal (una verdadera mala configuración en un servidor que controlas), reemite el certificado con las entradas SAN correctas. Si realmente debes conectarte por una dirección que difiere del nombre del certificado, establece el host SNI de TLS explícitamente para que el nombre negociado coincida con el certificado, en lugar de desactivar la comprobación del nombre:

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

### 3. Diferencia de protocolo o cifrado: alinea las versiones de TLS

Si no hay lista de errores de política y el handshake simplemente falla, los dos extremos no pudieron ponerse de acuerdo en un protocolo. Deja el cliente en `SslProtocols.None` (el valor predeterminado negociado por el sistema operativo) y corrige el servidor para que ofrezca TLS 1.2 o 1.3. Forzar al cliente a bajar a TLS 1.0/1.1 para coincidir con un servidor heredado es un último recurso, y en un sistema operativo moderno esos protocolos a menudo están deshabilitados a nivel de sistema operativo de todos modos, así que el ajuste explícito silenciosamente no hace nada. Si debes hacerlo, se ve así:

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

### 4. HTTPS local: confía en el certificado de desarrollo de ASP.NET Core

Si te topas con esto llamando a tu propio servicio por `https://localhost` durante el desarrollo, la solución es confiar en el certificado de desarrollo local una vez:

```bash
dotnet dev-certs https --trust
```

Esta es la solución local correcta. No debilita la validación, porque instala un certificado de confianza real para `localhost` en lugar de decirle al cliente que omita la comprobación.

## Trampas y variantes

**`ServerCertificateCustomValidationCallback => true` no es una solución.** Es la respuesta más votada de StackOverflow y está mal fuera de una prueba desechable. Devolver `true` incondicionalmente acepta cualquier certificado de cualquiera, lo que convierte HTTPS en texto plano con pasos extra y reabre el agujero exacto de man-in-the-middle que TLS previene. Si lo usas para desbloquear una demo, acótalo para que nunca pueda llegar a producción: protégelo con `if (env.IsDevelopment())` y verifica que esté desactivado en producción. El callback de pinning de la solución 1 es lo que quieres cuando necesitas aceptar un certificado específico no público de verdad.

**Funciona en Postman o curl pero falla en .NET.** Esas herramientas y .NET leen almacenes de confianza diferentes. curl en Linux usa el paquete de OpenSSL (que .NET también lee), pero Postman trae su propia lista de CA y las herramientas de Windows leen el almacén de Windows. Una CA en la que confía una no es automáticamente de confianza para las otras. Instala la raíz en el almacén que .NET realmente lee para tu sistema operativo.

**Funciona en Windows, falla en un contenedor Linux.** Misma causa raíz. La CA raíz corporativa está en el almacén de confianza de Windows del desarrollador pero nunca se agregó a la imagen del contenedor. Agrega la CA en tu Dockerfile con `update-ca-certificates` antes de que la aplicación se ejecute, o móntala.

**El servidor olvidó su certificado intermedio.** Un servidor puede estar configurado con una hoja válida pero fallar al enviar la intermedia que lo encadena a una raíz de confianza. Los navegadores a menudo disimulan esto cacheando intermedias de sesiones anteriores; .NET no. La solución pertenece al servidor: configúralo para que envíe la cadena completa. Puedes confirmarlo con `openssl s_client -connect host:443 -showcerts` y contando los certificados devueltos.

**`AuthenticationException` con `RemoteCertificateNotAvailable`.** El servidor no envió ningún certificado. Casi con seguridad estás apuntando a un puerto de HTTP plano con un esquema `https://`, o a un servicio que aún no está levantado. Comprueba el puerto y el esquema antes de tocar cualquier código de TLS.

**No confundas esto con `TaskCanceledException`.** Un handshake que se cuelga y luego dispara `HttpClient.Timeout` aparece como una cancelación, no como un error de TLS. Si tu síntoma es un timeout en lugar de un mensaje de validación, la causa y la solución son diferentes.

## Lecturas relacionadas

- [Solución: TaskCanceledException: A task was canceled en HttpClient](/es/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) cubre los fallos en forma de timeout que se parecen superficialmente a un handshake lento pero tienen una causa raíz completamente distinta.
- [HttpClient vs HttpClientFactory vs Refit](/es/2026/05/httpclient-vs-httpclientfactory-vs-refit/) explica dónde configurar un `SocketsHttpHandler` personalizado para que tus ajustes de TLS sobrevivan a la reutilización del cliente.
- [Cómo hacer pruebas unitarias de código que usa HttpClient](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/) muestra cómo simular el transporte para que puedas ejercitar las ramas de error de arriba sin un servidor roto en vivo.
- [Cómo agregar un filtro de excepciones global en ASP.NET Core 11](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) te ayuda a exponer esta excepción con el mensaje interno intacto en lugar de un 500 escueto.

## Fuentes

- [Enum `SslPolicyErrors`](https://learn.microsoft.com/en-us/dotnet/api/system.net.security.sslpolicyerrors), Microsoft Learn: los flags (`RemoteCertificateChainErrors`, `RemoteCertificateNameMismatch`, `RemoteCertificateNotAvailable`) que aparecen en el mensaje interno.
- [Enum `HttpRequestError`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httprequesterror), Microsoft Learn: el valor `SecureConnectionError` usado para clasificar el fallo en .NET 8+.
- [`SslClientAuthenticationOptions`](https://learn.microsoft.com/en-us/dotnet/api/system.net.security.sslclientauthenticationoptions), Microsoft Learn: `TargetHost`, `EnabledSslProtocols` y `RemoteCertificateValidationCallback` en `SocketsHttpHandler`.
- [Enforce TLS in .NET](https://learn.microsoft.com/en-us/dotnet/framework/network-programming/tls), Microsoft Learn: por qué `SslProtocols.None` (negociado por el sistema operativo) es el valor predeterminado recomendado.
- [dotnet/runtime #32498: The SSL connection could not be established](https://github.com/dotnet/runtime/issues/32498): informes del mundo real y el diagnóstico del almacén de confianza.

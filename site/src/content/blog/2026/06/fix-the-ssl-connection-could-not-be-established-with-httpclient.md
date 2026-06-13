---
title: "Fix: The SSL connection could not be established with HttpClient"
description: "The inner AuthenticationException tells you the real cause: an untrusted chain, a name mismatch, or a TLS version gap. Trust the cert, fix the host name, or align protocols. Do not blanket-disable validation."
pubDate: 2026-06-13
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "httpclient"
---

`HttpRequestException: The SSL connection could not be established, see inner exception` almost never means what the outer message says. The TLS handshake failed, and the real cause is in the `InnerException`: an untrusted certificate chain (`RemoteCertificateChainErrors`), a host name that does not match the certificate (`RemoteCertificateNameMismatch`), or a protocol mismatch. Read the inner exception first, then fix the chain, the host name, or the TLS version. Do not reach for `ServerCertificateCustomValidationCallback => true` in production: that disables the protection the handshake exists to provide.

This applies to `HttpClient` on .NET 11 (`.NET 11`), but the same `SslStream` machinery and the same diagnosis go back to .NET Core 3.1.

## The error in context

The outer exception is generic. The line that matters is the inner one:

```
System.Net.Http.HttpRequestException: The SSL connection could not be established, see inner exception.
 ---> System.Security.Authentication.AuthenticationException: The remote certificate is invalid according to the validation procedure: RemoteCertificateChainErrors, RemoteCertificateNameMismatch
   at System.Net.Security.SslStream.SendAuthResetSignal(...)
   at System.Net.Http.ConnectHelper.EstablishSslConnectionAsync(...)
   at System.Net.Http.HttpConnectionPool.ConnectAsync(...)
```

On .NET 8 and later you do not even have to crack open the inner exception by hand. `HttpRequestException` carries an `HttpRequestError` enum, and a handshake failure surfaces as `HttpRequestError.SecureConnectionError`:

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

The string after "according to the validation procedure:" is the entire diagnosis. It is a comma-separated list of `SslPolicyErrors` flags, and each one points at a different fix.

## Why this happens

The handshake fails for one of three reasons, and the inner message names which:

- **`RemoteCertificateChainErrors`**: the server's certificate is real, but your machine does not trust the chain that signed it. Self-signed certs, an internal corporate CA that is not in the trust store, an expired leaf or intermediate, or a server that forgot to send its intermediate certificate all land here.
- **`RemoteCertificateNameMismatch`**: the certificate is trusted, but the name on it does not match the host you connected to. You called `https://10.0.0.5` but the cert is issued for `api.internal`, or you hit `https://localhost` against a cert for `127.0.0.1`.
- **`RemoteCertificateNotAvailable`**: the server presented no certificate at all, which usually means you are talking TLS to a port that is not actually serving TLS.

A fourth class does not produce `SslPolicyErrors` at all. If the inner exception is a `Win32Exception` ("The client and server cannot communicate, because they do not possess a common algorithm") or a flat "The SSL connection could not be established" with no policy list, the two sides could not agree on a TLS version or cipher suite. Since .NET 5 the client default has been `SslProtocols.None`, which means "let the OS pick the best available," and on a current OS that negotiates TLS 1.3 or TLS 1.2. A server stuck on TLS 1.0/1.1, or one whose only cipher suites your OS has disabled, falls into this bucket.

## Minimal repro

The smallest program that reproduces the chain error points `HttpClient` at a host with a self-signed or otherwise untrusted certificate:

```csharp
// .NET 11, C# 14
using var client = new HttpClient();

// A host whose cert chains to a CA this machine does not trust.
using var response = await client.GetAsync("https://self-signed.badssl.com/");
response.EnsureSuccessStatusCode();
```

Run it and you get the `RemoteCertificateChainErrors` form. Swap the URL for `https://wrong.host.badssl.com/` and you get `RemoteCertificateNameMismatch` instead. These two public endpoints are the fastest way to confirm your handling code branches correctly without standing up your own broken server.

## The fix, in detail

Pick the fix that matches the inner exception. They are ordered from "correct in production" to "development only."

### 1. Chain errors: trust the certificate, do not bypass validation

If the inner message is `RemoteCertificateChainErrors`, the right fix is to make the chain trustworthy, not to stop checking it.

For an internal corporate CA, install the CA's root certificate into the machine trust store. On Linux that means dropping the PEM into the OS trust bundle, because .NET on Linux reads the OpenSSL trust store, not a .NET-specific one:

```bash
# Ubuntu/Debian: install a corporate root CA so .NET trusts it
sudo cp corp-root-ca.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates
```

On Windows, import the root into `Cert:\LocalMachine\Root`. After that, `HttpClient` validates the chain with zero code changes, because validation reads the OS store.

If you cannot touch the machine store (locked-down hosts, ephemeral containers), pin the specific certificate you expect instead of trusting everything. This keeps validation on for every other server while accepting exactly one known cert:

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

Note the shape: the callback returns `true` for chains that already pass (`SslPolicyErrors.None`), and otherwise accepts only the one certificate you pinned. That is the difference between certificate pinning and turning validation off.

### 2. Name mismatch: fix the URL or the certificate

`RemoteCertificateNameMismatch` means you connected to a name the certificate was not issued for. The fix is almost always to use the right host name in the URL, the one that appears in the certificate's Subject Alternative Name list. Connecting by IP address is the classic trigger, because certificates are issued for DNS names, not IPs.

If the URL is correct and the certificate is simply wrong (a real misconfiguration on a server you control), reissue the certificate with the correct SAN entries. If you genuinely must connect by an address that differs from the certificate name, set the TLS SNI host explicitly so the negotiated name matches the certificate, rather than disabling the name check:

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

### 3. Protocol or cipher gap: align TLS versions

If there is no policy-error list and the handshake just fails, the two ends could not agree on a protocol. Leave the client on `SslProtocols.None` (the OS-negotiated default) and fix the server to offer TLS 1.2 or 1.3. Forcing the client down to TLS 1.0/1.1 to match a legacy server is a last resort, and on a modern OS those protocols are often disabled at the OS level anyway, so the explicit setting silently does nothing. If you must, it looks like this:

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

### 4. Local HTTPS: trust the ASP.NET Core dev certificate

If you hit this calling your own service over `https://localhost` during development, the fix is to trust the local dev certificate once:

```bash
dotnet dev-certs https --trust
```

This is the correct local fix. It does not weaken validation, because it installs a real trusted cert for `localhost` rather than telling the client to skip checking.

## Gotchas and variants

**`ServerCertificateCustomValidationCallback => true` is not a fix.** It is the top StackOverflow answer and it is wrong outside a throwaway test. Returning `true` unconditionally accepts any certificate from anyone, which turns HTTPS into plaintext-with-extra-steps and reopens the exact man-in-the-middle hole TLS prevents. If you use it to unblock a demo, scope it so it can never ship: gate it behind `if (env.IsDevelopment())` and assert it is off in production. The pinning callback in fix 1 is what you want when you need to accept a specific non-public cert for real.

**It works in Postman or curl but fails in .NET.** Those tools and .NET read different trust stores. curl on Linux uses the OpenSSL bundle (which .NET also reads), but Postman ships its own CA list and Windows tools read the Windows store. A CA trusted by one is not automatically trusted by the others. Install the root into the store .NET actually reads for your OS.

**Works on Windows, fails in a Linux container.** Same root cause. The corporate root CA is in the developer's Windows trust store but was never added to the container image. Add the CA in your Dockerfile with `update-ca-certificates` before the app runs, or mount it in.

**The server forgot its intermediate certificate.** A server can be configured with a valid leaf but fail to send the intermediate that chains it to a trusted root. Browsers often paper over this by caching intermediates from earlier sessions; .NET does not. The fix belongs on the server: configure it to send the full chain. You can confirm with `openssl s_client -connect host:443 -showcerts` and counting the certificates returned.

**`AuthenticationException` with `RemoteCertificateNotAvailable`.** The server sent no certificate. You are almost certainly pointed at a plain-HTTP port with an `https://` scheme, or at a service that is not up yet. Check the port and the scheme before touching any TLS code.

**Do not confuse this with `TaskCanceledException`.** A handshake that hangs and then trips `HttpClient.Timeout` surfaces as a cancellation, not a TLS error. If your symptom is a timeout rather than a validation message, the cause and fix are different.

## Related reading

- [Fix: TaskCanceledException: A task was canceled in HttpClient](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) covers the timeout-shaped failures that look superficially similar to a slow handshake but have a completely different root cause.
- [HttpClient vs HttpClientFactory vs Refit](/2026/05/httpclient-vs-httpclientfactory-vs-refit/) explains where to configure a custom `SocketsHttpHandler` so your TLS settings survive client reuse.
- [How to unit-test code that uses HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/) shows how to fake the transport so you can exercise the error branches above without a live broken server.
- [How to add a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) helps you surface this exception with the inner message intact instead of a bare 500.

## Sources

- [`SslPolicyErrors` enum](https://learn.microsoft.com/en-us/dotnet/api/system.net.security.sslpolicyerrors), Microsoft Learn - the flags (`RemoteCertificateChainErrors`, `RemoteCertificateNameMismatch`, `RemoteCertificateNotAvailable`) that appear in the inner message.
- [`HttpRequestError` enum](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httprequesterror), Microsoft Learn - the `SecureConnectionError` value used to classify the failure on .NET 8+.
- [`SslClientAuthenticationOptions`](https://learn.microsoft.com/en-us/dotnet/api/system.net.security.sslclientauthenticationoptions), Microsoft Learn - `TargetHost`, `EnabledSslProtocols`, and `RemoteCertificateValidationCallback` on `SocketsHttpHandler`.
- [Enforce TLS in .NET](https://learn.microsoft.com/en-us/dotnet/framework/network-programming/tls), Microsoft Learn - why `SslProtocols.None` (OS-negotiated) is the recommended default.
- [dotnet/runtime #32498: The SSL connection could not be established](https://github.com/dotnet/runtime/issues/32498) - real-world reports and the trust-store diagnosis.

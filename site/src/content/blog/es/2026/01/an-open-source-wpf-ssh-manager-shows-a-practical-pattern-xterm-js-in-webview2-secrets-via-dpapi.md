---
title: "Un gestor SSH WPF open-source muestra un patrón práctico: xterm.js en WebView2, secretos vía DPAPI"
description: "SshManager es un gestor SSH WPF open-source construido sobre .NET 8. Muestra un patrón práctico: xterm.js dentro de WebView2 para el renderizado de la terminal, EF Core + SQLite para persistencia y DPAPI para proteger credenciales locales."
pubDate: 2026-01-18
tags:
  - "dotnet"
  - "dotnet-8"
  - "webview2"
  - "wpf"
lang: "es"
translationOf: "2026/01/an-open-source-wpf-ssh-manager-shows-a-practical-pattern-xterm-js-in-webview2-secrets-via-dpapi"
translatedBy: "claude"
translationDate: 2026-04-29
---
Hoy apareció un proyecto interesante de escritorio para Windows en r/csharp: **SshManager**, un gestor SSH y serial open-source construido con **.NET 8** y **WPF**.

Fuente: el post original en Reddit y el repositorio: [hilo en r/csharp](https://www.reddit.com/r/csharp/comments/1qgf6e1/i_built_an_opensource_ssh_manager_for_windows/) y [tomertec/sshmanager](https://github.com/tomertec/sshmanager).

## La parte interesante no es "SSH en C#"

SSH en sí está resuelto. Lo que vale la pena estudiar es cómo esta app cose tres piezas muy pragmáticas:

-   **Una UI de terminal real**: xterm.js renderizado dentro de **WebView2**, para obtener una UX de terminal (copiar, selección, renderizado monoespaciado) sin intentar reinventar un control de terminal en WPF.
-   **Persistencia local**: EF Core + SQLite para perfiles de conexión, etiquetas y metadatos de sesión.
-   **Protección de secretos nativa de Windows**: contraseñas cifradas con **Windows DPAPI**, que es exactamente lo que quieres para una herramienta de escritorio solo local.

Es un patrón que me gusta porque mantiene el "problema duro de UX" (renderizado de terminal) dentro de un componente web probado, mientras el resto sigue siendo .NET 8 idiomático.

## DPAPI es un buen default para credenciales solo locales

DPAPI no es cifrado entre máquinas. Está atado al perfil actual de usuario de Windows (o a la máquina, dependiendo del scope). Eso es una característica para una app de escritorio de un solo usuario.

Este es un helper mínimo de "proteger/desproteger" que puedes integrar en una app WPF en .NET 8:

```cs
using System.Security.Cryptography;
using System.Text;

static class Dpapi
{
    public static string ProtectToBase64(string plaintext)
    {
        var bytes = Encoding.UTF8.GetBytes(plaintext);
        var protectedBytes = ProtectedData.Protect(
            bytes,
            optionalEntropy: null,
            scope: DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(protectedBytes);
    }

    public static string UnprotectFromBase64(string base64)
    {
        var protectedBytes = Convert.FromBase64String(base64);
        var bytes = ProtectedData.Unprotect(
            protectedBytes,
            optionalEntropy: null,
            scope: DataProtectionScope.CurrentUser);
        return Encoding.UTF8.GetString(bytes);
    }
}
```

Si más adelante agregas "sincronizar ajustes entre dispositivos", DPAPI se convierte en la herramienta equivocada y necesitas otra historia de claves. Para un gestor Windows-first solo local, DPAPI es exactamente el nivel correcto de aburrido.

## WebView2 + xterm.js es la opción de "deja de pelear con WPF" para terminales

Si construyes herramientas internas en .NET 8 y la UI necesita comportarse como una terminal real (vim, tmux, htop), incrustar xterm.js dentro de WebView2 es una frontera sorprendentemente limpia:

-   WPF posee la ventana y el ciclo de vida de la app.
-   El lado web posee el renderizado de terminal y el comportamiento del teclado.
-   Tu puente son solo mensajes: escribir bytes al PTY, leer la salida, devolverla.

Si quieres un ejemplo que no sea una demo de juguete, este repo merece un vistazo. Empieza por el modelo de conexión y por cómo está cableada la vista de terminal, y luego decide si este enfoque híbrido encaja con tu propia herramienta.

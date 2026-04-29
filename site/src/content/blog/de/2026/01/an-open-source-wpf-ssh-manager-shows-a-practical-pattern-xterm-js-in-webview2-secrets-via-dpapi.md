---
title: "Ein open-source WPF-SSH-Manager zeigt ein praktisches Muster: xterm.js in WebView2, Secrets via DPAPI"
description: "SshManager ist ein open-source WPF-SSH-Manager auf Basis von .NET 8. Er zeigt ein praktisches Muster: xterm.js innerhalb von WebView2 für das Terminal-Rendering, EF Core + SQLite für die Persistenz und DPAPI für den Schutz lokaler Anmeldeinformationen."
pubDate: 2026-01-18
tags:
  - "dotnet"
  - "dotnet-8"
  - "webview2"
  - "wpf"
lang: "de"
translationOf: "2026/01/an-open-source-wpf-ssh-manager-shows-a-practical-pattern-xterm-js-in-webview2-secrets-via-dpapi"
translatedBy: "claude"
translationDate: 2026-04-29
---
Heute tauchte auf r/csharp ein nettes Windows-Desktop-Projekt auf: **SshManager**, ein open-source SSH- und Serial-Manager, gebaut mit **.NET 8** und **WPF**.

Quelle: der ursprüngliche Beitrag auf Reddit und das Repository: [r/csharp-Thread](https://www.reddit.com/r/csharp/comments/1qgf6e1/i_built_an_opensource_ssh_manager_for_windows/) und [tomertec/sshmanager](https://github.com/tomertec/sshmanager).

## Das Interessante ist nicht "SSH in C#"

SSH selbst ist gelöst. Studierenswert ist, wie diese App drei sehr pragmatische Teile zusammenflickt:

-   **Eine echte Terminal-UI**: xterm.js innerhalb von **WebView2** gerendert, sodass Sie eine Terminal-UX (Kopieren, Auswahl, Monospace-Rendering) bekommen, ohne ein Terminal-Control in WPF neu zu erfinden.
-   **Lokale Persistenz**: EF Core + SQLite für Verbindungsprofile, Tags und Sitzungsmetadaten.
-   **Windows-nativer Secret-Schutz**: Passwörter verschlüsselt mit **Windows DPAPI**, genau das, was man für ein rein lokales Desktop-Tool will.

Das ist ein Muster, das ich mag, weil es das "schwierige UX-Problem" (Terminal-Rendering) innerhalb einer bewährten Webkomponente belässt, während der Rest idiomatisches .NET 8 bleibt.

## DPAPI ist ein guter Default für rein lokale Anmeldeinformationen

DPAPI ist keine maschinenübergreifende Verschlüsselung. Sie ist an das aktuelle Windows-Benutzerprofil gebunden (oder an die Maschine, je nach Scope). Das ist ein Vorteil für eine Single-User-Desktop-App.

Hier ist ein minimaler "Protect/Unprotect"-Helper, den Sie in eine .NET 8-WPF-App übernehmen können:

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

Wenn Sie später "Einstellungen über Geräte hinweg synchronisieren" hinzufügen, wird DPAPI das falsche Werkzeug, und Sie brauchen eine andere Schlüsselstrategie. Für einen Windows-first, rein lokalen Manager hat DPAPI genau das richtige Maß an Langeweile.

## WebView2 + xterm.js ist die "hört auf, gegen WPF zu kämpfen"-Option für Terminals

Wenn Sie interne Tools in .NET 8 bauen und die UI sich wie ein echtes Terminal verhalten muss (vim, tmux, htop), ist das Einbetten von xterm.js in WebView2 eine überraschend saubere Grenze:

-   WPF besitzt das Fenster und den App-Lifecycle.
-   Die Webseite besitzt das Terminal-Rendering und das Tastaturverhalten.
-   Ihre Brücke sind nur Nachrichten: Bytes ins PTY schreiben, Output lesen, zurückspeisen.

Wenn Sie ein Beispiel wollen, das keine Spielzeug-Demo ist, lohnt dieses Repo einen Blick. Beginnen Sie mit dem Verbindungsmodell und damit, wie die Terminal-View verdrahtet ist, und entscheiden Sie dann, ob dieser hybride Ansatz zu Ihrem eigenen Tooling passt.

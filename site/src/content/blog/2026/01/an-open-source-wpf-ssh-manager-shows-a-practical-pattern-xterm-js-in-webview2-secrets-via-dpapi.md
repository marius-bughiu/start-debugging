---
title: "An open-source WPF SSH manager shows a practical pattern: xterm.js in WebView2, secrets via DPAPI"
description: "SshManager is an open-source WPF SSH manager built on .NET 8. It shows a practical pattern: xterm.js inside WebView2 for terminal rendering, EF Core + SQLite for persistence, and DPAPI for local credential protection."
pubDate: 2026-01-18
tags:
  - "dotnet"
  - "dotnet-8"
  - "webview2"
  - "wpf"
---
Today a neat Windows desktop project popped up on r/csharp: **SshManager**, an open-source SSH and serial manager built with **.NET 8** and **WPF**.

Source: the original post on Reddit and the repository: [r/csharp thread](https://www.reddit.com/r/csharp/comments/1qgf6e1/i_built_an_opensource_ssh_manager_for_windows/) and [tomertec/sshmanager](https://github.com/tomertec/sshmanager).

## The interesting bit is not “SSH in C#”

SSH itself is solved. What is worth studying is how this app stitches together three very pragmatic pieces:

-   **A real terminal UI**: xterm.js rendered inside **WebView2**, so you get a terminal UX (copy, selection, monospace rendering) without trying to reinvent a terminal control in WPF.
-   **Local persistence**: EF Core + SQLite for connection profiles, tags, session metadata.
-   **Windows-native secret protection**: passwords encrypted using **Windows DPAPI**, which is exactly what you want for a local-only desktop tool.

This is a pattern I like because it keeps the “hard UX problem” (terminal rendering) inside a proven web component, while the rest stays idiomatic .NET 8.

## DPAPI is a good default for local-only credentials

DPAPI is not cross-machine encryption. It is tied to the current Windows user profile (or machine, depending on scope). That is a feature for a single-user desktop app.

Here is a minimal “protect/unprotect” helper you can lift into a .NET 8 WPF app:

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

If you later add “sync settings across devices”, DPAPI becomes the wrong tool and you need a different key story. For a Windows-first, local-only manager, DPAPI is exactly the right level of boring.

## WebView2 + xterm.js is the “stop fighting WPF” option for terminals

If you are building internal tools on .NET 8 and the UI needs to behave like a real terminal (vim, tmux, htop), embedding xterm.js inside WebView2 is a surprisingly clean boundary:

-   WPF owns the window and app lifecycle.
-   The web side owns terminal rendering and keyboard behavior.
-   Your bridge is just messages: write bytes to the PTY, read output, feed it back.

If you want an example that is not a toy demo, this repo is worth a skim. Start from the connection model and how the terminal view is wired, then decide if this hybrid approach fits your own tooling.

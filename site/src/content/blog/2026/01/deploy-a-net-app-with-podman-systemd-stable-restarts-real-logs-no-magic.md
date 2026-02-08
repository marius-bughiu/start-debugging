---
title: "Deploy a .NET App with Podman + systemd: Stable Restarts, Real Logs, No Magic"
description: "This showed up in r/dotnet today: people are still looking for a “boring deployment” story for .NET services that is not Kubernetes and not a fragile nohup script. If you are on a Linux VM, Podman plus systemd is a solid middle ground: a containerized app managed like a real service. Source discussion: https://www.reddit.com/r/dotnet/comments/1q8gq1u/how_to_deploy_net_applications_with_systemd_and/ Why…"
pubDate: 2026-01-10
tags:
  - "docker"
  - "net"
---
This showed up in r/dotnet today: people are still looking for a “boring deployment” story for .NET services that is not Kubernetes and not a fragile `nohup` script. If you are on a Linux VM, Podman plus systemd is a solid middle ground: a containerized app managed like a real service.

Source discussion: [https://www.reddit.com/r/dotnet/comments/1q8gq1u/how\_to\_deploy\_net\_applications\_with\_systemd\_and/](https://www.reddit.com/r/dotnet/comments/1q8gq1u/how_to_deploy_net_applications_with_systemd_and/)

## Why this works well for .NET 9 and .NET 10 services

-   **Systemd owns restarts**: if the process crashes, it is restarted, and you get a clear reason.
-   **Journald owns logs**: no more hunting for rotated files on disk.
-   **Podman is daemonless**: systemd starts exactly what it needs.

## Build and run the container

Here is a minimal `Containerfile` for a .NET 9 app (works the same for .NET 10, just switch the base tag):

```dockerfile
FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS base
WORKDIR /app
EXPOSE 8080

FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /out

FROM base
WORKDIR /app
COPY --from=build /out .
ENV ASPNETCORE_URLS=http://+:8080
ENTRYPOINT ["dotnet", "MyApp.dll"]
```

Then:

```bash
podman build -t myapp:1 .
podman run -d --name myapp -p 8080:8080 myapp:1
```

## Let systemd own it (the useful part)

Podman can generate a unit file that systemd understands:

```bash
podman generate systemd --new --name myapp --files
```

This produces something like `container-myapp.service`. Move it into place:

```bash
sudo mv container-myapp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now container-myapp.service
```

Now you get clean operational commands:

```bash
sudo systemctl status container-myapp.service
sudo journalctl -u container-myapp.service -f
sudo systemctl restart container-myapp.service
```

## Two details that save you later

### Make configuration explicit

Use environment variables and a mounted config directory instead of baking secrets into the image. With systemd you can set overrides in a drop-in file, and you can restart safely.

### Pick a restart policy that matches reality

If your app fails fast due to missing config, endless restarts are noise. Prefer a restart policy that does not hammer the box. Systemd lets you control delays and burst limits.

If you want a single “am I doing this right?” test: reboot the VM and see if your .NET service comes back up without you SSH-ing in. That is the bar.

Further reading: [https://docs.podman.io/](https://docs.podman.io/)

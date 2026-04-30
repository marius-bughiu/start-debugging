---
title: ".NET 10 раздул ваш список NIC? Фильтрация GetAllNetworkInterfaces() без самообмана"
description: "Как фильтровать GetAllNetworkInterfaces() в .NET 10, когда виртуальные адаптеры из Hyper-V, Docker, WSL и VPN затопляют список. Включает двухступенчатый фильтр с явными компромиссами."
pubDate: 2026-01-08
tags:
  - "dotnet"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/01/net-10-made-your-nic-list-explode-filtering-getallnetworkinterfaces-without-lying-to-yourself"
translatedBy: "claude"
translationDate: 2026-04-30
---
Если вы только что мигрировали приложение с .NET 8 на .NET 10 и внезапно `NetworkInterface.GetAllNetworkInterfaces()` возвращает 80 адаптеров вместо 10, вам не показалось. Это всплыло в треде 7 января 2026 года, ровно с той реальной болью, из-за которой "мелкие" изменения поведения ощущаются как ломающие: виртуальные интерфейсы Hyper-V, Docker, WSL, VPN, loopback и других системных адаптеров начинают вытеснять "настоящие" Ethernet- и Wi-Fi-устройства.

Источник: [NetworkInterface.GetAllNetworkInterfaces breaking change (r/dotnet)](https://www.reddit.com/r/dotnet/comments/1q6ippd/networkinterfacegetallnetworkinterfaces_breaking/)

## Неудобная правда: "физический" -- это эвристика

`System.Net.NetworkInformation` не даёт вам единого официального булева в стиле "это физическая NIC", которому можно было бы доверять между машинами, драйверами и функциями Windows. Безопаснее всего **построить фильтр под нужды вашего продукта** и сделать этот фильтр аудируемым и тестируемым.

Начните со строгих сигналов, которые обычно коррелируют с "полезным для связи":

-   `OperationalStatus.Up`
-   тип интерфейса (`Ethernet`, `Wireless80211` и т. д.)
-   наличие unicast-адресов IPv4/IPv6, шлюза или DNS-серверов (в зависимости от сценария)

Затем добавьте более мягкие, специфичные для среды исключения (Docker, Hyper-V, WSL, VPN) на втором этапе.

## Двухступенчатый фильтр, который явно показывает компромиссы

В треде предложили такой подход (подрезанный и слегка укреплённый ради читаемости):

```cs
using System.Net.NetworkInformation;

var candidates = NetworkInterface.GetAllNetworkInterfaces()
    .Where(nic => nic.OperationalStatus == OperationalStatus.Up)
    .Where(nic => nic.NetworkInterfaceType is
        NetworkInterfaceType.Ethernet or
        NetworkInterfaceType.Wireless80211 or
        NetworkInterfaceType.GigabitEthernet)
    .Where(nic => !LooksVirtual(nic))
    .ToArray();

static bool LooksVirtual(NetworkInterface nic)
{
    var desc = (nic.Description ?? "").ToLowerInvariant();
    var name = (nic.Name ?? "").ToLowerInvariant();

    string[] keywords =
    {
        "virtual", "hyper-v", "vmware", "virtualbox",
        "docker", "vpn", "tap-", "wsl", "pseudo"
    };

    return keywords.Any(k => desc.Contains(k) || name.Contains(k));
}
```

Костыльно? Да. Но это и честно: вы признаёте, что кодируете политику.

Чтобы сделать это менее хрупким, не полагайтесь только на строки:

-   Проверяйте `nic.GetIPProperties().UnicastAddresses` и игнорируйте интерфейсы без маршрутизируемого адреса для вашего сценария.
-   Подумайте, нужен ли вам шлюз по умолчанию (`GatewayAddresses`) или DNS-серверы (`DnsAddresses`).
-   Логируйте то, что вы отфильтровали (тип, описание, id), чтобы можно было корректировать фильтр, когда появится новый драйвер или VPN-клиент.

## Отлаживайте это как продакшн-инцидент, а не как любопытный факт

Когда количество ваших адаптеров меняется между версиями .NET, относитесь к этому как к наблюдаемой разнице в поведении:

-   Снимите снимок до/после (тип, статус, описание, id, IP-свойства).
-   Напишите небольшой каркас в стиле модульного теста, утверждающий: "На этой машине должен получиться хотя бы один кандидат Wi-Fi или Ethernet".
-   Если поведение -- это изменение платформы/среды выполнения, найдите соответствующее issue или заведите его с минимальным репро.

.NET 10 даёт вам сырой список. Ваше приложение всё равно должно решать, что значит "настоящий".

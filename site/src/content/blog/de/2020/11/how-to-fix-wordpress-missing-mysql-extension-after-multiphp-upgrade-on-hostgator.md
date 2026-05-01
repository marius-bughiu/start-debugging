---
title: "WordPress 'Missing MySQL extension' nach MultiPHP-Upgrade auf HostGator beheben"
description: "Beheben Sie den WordPress-Fehler 'Missing MySQL extension' nach einem PHP-Upgrade über den MultiPHP Manager bei HostGator, indem Sie den veralteten Handler aus der .htaccess entfernen."
pubDate: 2020-11-06
updatedDate: 2023-11-05
tags:
  - "wordpress"
lang: "de"
translationOf: "2020/11/how-to-fix-wordpress-missing-mysql-extension-after-multiphp-upgrade-on-hostgator"
translatedBy: "claude"
translationDate: 2026-05-01
---
Wenn Sie die PHP-Version Ihrer WordPress-Site mit dem MultiPHP Manager auf PHP 7 angehoben haben, kann folgender Fehler auftreten:

`Your PHP installation appears to be missing the MySQL extension which is required by WordPress.`

Verursacht wird das durch einen veralteten Handler in Ihrer `.htaccess`-Datei.

## Behebung

1.  [Suchen Sie Ihre .htaccess-Datei](https://www.youtube.com/watch?v=7ZG8c8wwEbs) über den File Manager im cPanel
2.  Erstellen Sie ein Backup der Datei
3.  Bearbeiten Sie die Datei und entfernen Sie den veralteten Handler, der etwa so aussieht:

```plaintext
# Use PHP71 as default
AddHandler application/x-httpd-php71 .php
<IfModule mod_suphp.c>
    suPHP_ConfigPath /opt/php71/lib
</IfModule>
```

ODER

```plaintext
#Use PHPedge as default
AddHandler application/x-httpd-php-edge .php
<IfModule mod_suphp.c>
    suPHP_ConfigPath /opt/phpedge/lib
</IfModule>
```

Speichern Sie die Datei und der Fehler sollte verschwunden sein.

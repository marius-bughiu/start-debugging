---
title: "HostGator で MultiPHP をアップグレードした後の WordPress 'Missing MySQL extension' を解消する方法"
description: "HostGator の MultiPHP manager で PHP をアップグレードした後の WordPress エラー 'Missing MySQL extension' を、.htaccess から廃止された handler を取り除いて解消します。"
pubDate: 2020-11-06
updatedDate: 2023-11-05
tags:
  - "wordpress"
lang: "ja"
translationOf: "2020/11/how-to-fix-wordpress-missing-mysql-extension-after-multiphp-upgrade-on-hostgator"
translatedBy: "claude"
translationDate: 2026-05-01
---
WordPress サイトの PHP バージョンを MultiPHP manager で PHP 7 にアップグレードした後、次のエラーに遭遇することがあります。

`Your PHP installation appears to be missing the MySQL extension which is required by WordPress.`

これは `.htaccess` ファイル内の廃止された handler が原因です。

## 解決方法

1.  cPanel の File Manager で [.htaccess ファイルを探します](https://www.youtube.com/watch?v=7ZG8c8wwEbs)
2.  ファイルのバックアップを作成します
3.  ファイルを編集し、次のように見える廃止された handler を削除します。

```plaintext
# Use PHP71 as default
AddHandler application/x-httpd-php71 .php
<IfModule mod_suphp.c>
    suPHP_ConfigPath /opt/php71/lib
</IfModule>
```

または

```plaintext
#Use PHPedge as default
AddHandler application/x-httpd-php-edge .php
<IfModule mod_suphp.c>
    suPHP_ConfigPath /opt/phpedge/lib
</IfModule>
```

ファイルを保存すれば、エラーは解消されるはずです。

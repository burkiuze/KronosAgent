# Windows kurulum sihirbazı

`Kronos-Kurulum.exe`: Node.js ve Git'i (yoksa) kurar, KronosAgent'ı indirir, bileşenlerini
yükler, derler ve masaüstü / Başlat menüsü kısayolu oluşturur. Kaldırıcı ve "Programlar ve
Özellikler" kaydı dahildir.

Derleme (Linux'ta da çalışır, `apt install nsis imagemagick`):

```sh
cd installer/windows
cp ../../LICENSE LICENSE.txt
convert ../../assets/brand/kronos-1024.png -define icon:auto-resize=256,48,32,16 kronos.ico
makensis kronos-kurulum.nsi        # -> Kronos-Kurulum.exe
```

Kurulan dal `kurulum.ps1` içindeki `$Branch` parametresidir.

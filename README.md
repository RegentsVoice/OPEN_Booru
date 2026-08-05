<p align="center">
  <img src="public/logo.png" alt="OPEN Booru" width="180" />
</p>

# OPEN Booru

Encrypted self-hosted gallery — images, video, GIF.  
[English](#english) · [Русский](#русский)

---

<a id="english"></a>

## English

AES per user · tags · favorites · roles · import from boorus · UI in 8 languages.

**Node.js ≥ 26**

<details>
<summary>Screenshots</summary>

| Gallery | Viewer | Upload | Settings | Import | Login |
|:---:|:---:|:---:|:---:|:---:|
| ![](screenshots/gallery.png) | ![](screenshots/viewer.png) | ![](screenshots/upload.png) | ![](screenshots/import.png) | ![](screenshots/settings.png) | ![](screenshots/login.png) |

</details>

### Booru import

Gelbooru · Rule34 · Realbooru · Xbooru · Hypnohub · TBIB · Safebooru · Derpibooru · Furbooru · Ponybooru · Danbooru · e621 · Yande.re · Konachan

### Install

<details>
<summary>Automatic</summary>

**Linux** (Arch / Ubuntu / Debian / Fedora):

```bash
curl -fsSL https://raw.githubusercontent.com/RegentsVoice/OPEN_Booru/main/scripts/install-linux.sh | bash
cd ~/OPEN_Booru && npm start
```

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/RegentsVoice/OPEN_Booru/main/scripts/install-windows.ps1 | iex
cd $HOME\OPEN_Booru; npm start
```

</details>

<details>
<summary>Manual</summary>

```bash
git clone https://github.com/RegentsVoice/OPEN_Booru.git && cd OPEN_Booru
mkdir -p public/lib
curl -fsSL -o public/lib/spark-md5.min.js https://cdn.jsdelivr.net/npm/spark-md5@3.0.2/spark-md5.min.js
npm install && npm start
```

Node: [nodejs.org](https://nodejs.org/) · `winget install OpenJS.NodeJS.LTS` · `pacman -S nodejs npm` · `dnf install nodejs npm`

</details>

<details>
<summary>Docker</summary>

```bash
# spark-md5.min.js must exist in public/lib/
docker build -t open-booru -f - . <<'DF'
FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3001
CMD ["node", "server/index.js"]
DF
docker run -d --name open-booru -p 3001:3001 \
  -v open-booru-data:/app/database -v open-booru-media:/app/media \
  -v open-booru-logs:/app/logs -e PORT=3001 open-booru
```

</details>

### License [MIT](https://github.com/RegentsVoice/OPEN_Booru/blob/main/LICENSE)

---

<a id="русский"></a>

## Русский

Зашифрованная локальная галерея — фото, видео, GIF.  
AES · теги · избранное · роли · импорт с борд · 8 языков UI.

**Node.js ≥ 26**

<details>
<summary>Скриншоты</summary>

| Галерея | Просмотр | Загрузка | Импорт | Настройки | Вход |
|:---:|:---:|:---:|:---:|:---:|
| ![](screenshots/gallery.png) | ![](screenshots/viewer.png) | ![](screenshots/upload.png) | ![](screenshots/import.png) | ![](screenshots/settings.png) | ![](screenshots/login.png) |

</details>

### Импорт

Gelbooru · Rule34 · Realbooru · Xbooru · Hypnohub · TBIB · Safebooru · Derpibooru · Furbooru · Ponybooru · Danbooru · e621 · Yande.re · Konachan

### Установка

<details>
<summary>Автоматическая</summary>

**Linux** (Arch / Ubuntu / Debian / Fedora):

```bash
curl -fsSL https://raw.githubusercontent.com/RegentsVoice/OPEN_Booru/main/scripts/install-linux.sh | bash
cd ~/OPEN_Booru && npm start
```

**Windows:**

```powershell
irm https://raw.githubusercontent.com/RegentsVoice/OPEN_Booru/main/scripts/install-windows.ps1 | iex
cd $HOME\OPEN_Booru; npm start
```

</details>

<details>
<summary>Ручная</summary>

```bash
git clone https://github.com/RegentsVoice/OPEN_Booru.git && cd OPEN_Booru
mkdir -p public/lib
curl -fsSL -o public/lib/spark-md5.min.js https://cdn.jsdelivr.net/npm/spark-md5@3.0.2/spark-md5.min.js
npm install && npm start
```

</details>

<details>
<summary>Docker</summary>

```bash
# spark-md5.min.js must exist in public/lib/
docker build -t open-booru -f - . <<'DF'
FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3001
CMD ["node", "server/index.js"]
DF
docker run -d --name open-booru -p 3001:3001 \
  -v open-booru-data:/app/database -v open-booru-media:/app/media \
  -v open-booru-logs:/app/logs -e PORT=3001 open-booru
```

</details>

### Лицензия [MIT](https://github.com/RegentsVoice/OPEN_Booru/blob/main/LICENSE)

<div align="center">
  <img src="https://github.com/RegentsVoice/OPEN_Booru/blob/main/public/logo.png" alt="OPEN Booru" width="200" />
</div>

# OPEN Booru

**Language / Язык:** [English](#english) · [Русский](#русский)

Self-hosted encrypted media gallery for images, videos, and GIFs.

---

<a id="english"></a>

## English

Per-user AES encryption, tags, favorites, multi-user roles (owner / admin / user), and UI in 8 languages.

**Requirements:** Node.js **≥ 18**

Default URL after start: [http://localhost:3001](http://localhost:3001)

<details>
<summary><strong>Screenshots</strong></summary>
<br>

| Gallery | Viewer |
|:-------:|:------:|
| ![Gallery](https://github.com/user-attachments/assets/7dd6d98d-37a6-40f9-b2eb-b978022b8c00) | ![Viewer](https://github.com/user-attachments/assets/598a5d78-5e73-4c61-83fe-8e29c88102fb) |

| Upload | Settings |
|:------:|:--------:|
| ![Upload](https://github.com/user-attachments/assets/00781bf9-cd9c-4a5a-a9b0-6a276c54bf18) | ![Settings](https://github.com/user-attachments/assets/c31972a5-b0b6-4047-9c83-266161122998) |

| Login |
|:-----:|
| ![Login](https://github.com/user-attachments/assets/6f58a4fd-4870-4e0f-8461-fd5c753ab210) |

</details>

### Features

- Encrypted storage (AES-256-GCM for databases, AES-256-CTR for media with range support)
- Tags, search autocomplete, favorites
- Image / video / GIF support
- Multi-user accounts; first registered user becomes **owner + admin**
- UI languages: English, Русский, 中文, Deutsch, Español, Français, Polski, Українська
- Server log language is configured separately in admin settings

### Install

#### 1. Install Node.js (≥ 18)

<details>
<summary><strong>Windows</strong></summary>

**Option A — official installer**

1. Download LTS from [https://nodejs.org/](https://nodejs.org/)
2. Install with default options (includes `npm`)
3. Open **PowerShell** or **cmd** and check:

```powershell
node -v
npm -v
```

**Option B — winget**

```powershell
winget install OpenJS.NodeJS.LTS
node -v
npm -v
```

**Option C — chocolatey**

```powershell
choco install nodejs-lts -y
node -v
npm -v
```

</details>

<details>
<summary><strong>Arch Linux</strong></summary>

```bash
sudo pacman -S nodejs npm
node -v
npm -v
```

</details>

<details>
<summary><strong>Ubuntu / Debian</strong></summary>

Node from default repos may be too old. Use NodeSource (Node 20 LTS):

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt-get update
sudo apt-get install -y nodejs
node -v
npm -v
```

</details>

<details>
<summary><strong>Fedora</strong></summary>

```bash
sudo dnf install -y nodejs npm
node -v
npm -v
```

If the version is below 18:

```bash
sudo dnf module enable nodejs:20 -y
sudo dnf install -y nodejs npm
node -v
```

</details>

#### 2. Get the project

```bash
git clone https://github.com/RegentsVoice/OPEN_Booru.git
cd OPEN_Booru
```

Or unpack a release archive and `cd` into the project folder.

#### 3. Download `spark-md5.min.js`

This file is **not** shipped with the repository. Client-side hashing needs it in `public/lib/`.

**Linux / macOS:**

```bash
mkdir -p public/lib
curl -fsSL -o public/lib/spark-md5.min.js \
  https://cdn.jsdelivr.net/npm/spark-md5@3.0.2/spark-md5.min.js
```

**Windows (PowerShell):**

```powershell
New-Item -ItemType Directory -Force -Path public\lib | Out-Null
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/spark-md5@3.0.2/spark-md5.min.js" `
  -OutFile "public\lib\spark-md5.min.js"
```

Check that the file exists and is not empty:

```bash
# Linux
ls -la public/lib/spark-md5.min.js

# Windows PowerShell
Get-Item public\lib\spark-md5.min.js
```

#### 4. Install dependencies and start

```bash
npm install
npm start
```

Open [http://localhost:3001](http://localhost:3001).

### Docker

No `Dockerfile` is required in the repo. You can build and run with an inline image definition.

#### Build

From the **project root** (after `spark-md5.min.js` is in place — see step 3 above):

```bash
docker build -t open-booru -f - . <<'DOCKERFILE'
FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "server/index.js"]
DOCKERFILE
```

**Windows (PowerShell)** — write a temporary Dockerfile, build, then remove it:

```powershell
@"
FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "server/index.js"]
"@ | Set-Content -Encoding utf8 Dockerfile
docker build -t open-booru .
Remove-Item Dockerfile
```

#### Run

```bash
docker run -d \
  --name open-booru \
  -p 3001:3001 \
  -v open-booru-data:/app/database \
  -v open-booru-media:/app/media \
  -v open-booru-logs:/app/logs \
  -e PORT=3001 \
  open-booru
```

Persist `temp` as well if you want upload recovery across restarts:

```bash
docker run -d \
  --name open-booru \
  -p 3001:3001 \
  -v open-booru-data:/app/database \
  -v open-booru-media:/app/media \
  -v open-booru-temp:/app/temp \
  -v open-booru-logs:/app/logs \
  -e PORT=3001 \
  open-booru
```

Logs:

```bash
docker logs -f open-booru
```

Stop / remove:

```bash
docker stop open-booru
docker rm open-booru
```

> **Note:** Put `spark-md5.min.js` into `public/lib/` **before** `docker build`, otherwise the client hash step will fail in the browser.

### License

MIT

---

<a id="русский"></a>

## Русский

**Language / Язык:** [English](#english) · [Русский](#русский)

Локальная зашифрованная медиа-галерея для изображений, видео и GIF.

Шифрование AES для каждого пользователя, теги, избранное, роли (владелец / админ / пользователь), интерфейс на 8 языках.

**Требования:** Node.js **≥ 18**

Адрес по умолчанию: [http://localhost:3001](http://localhost:3001)

<details>
<summary><strong>Скриншоты</strong></summary>
<br>

| Галерея | Просмотр |
|:-------:|:--------:|
| ![Галерея](https://github.com/user-attachments/assets/7dd6d98d-37a6-40f9-b2eb-b978022b8c00) | ![Просмотр](https://github.com/user-attachments/assets/598a5d78-5e73-4c61-83fe-8e29c88102fb) |

| Загрузка | Настройки |
|:--------:|:---------:|
| ![Загрузка](https://github.com/user-attachments/assets/00781bf9-cd9c-4a5a-a9b0-6a276c54bf18) | ![Настройки](https://github.com/user-attachments/assets/c31972a5-b0b6-4047-9c83-266161122998) |

| Вход |
|:----:|
| ![Вход](https://github.com/user-attachments/assets/6f58a4fd-4870-4e0f-8461-fd5c753ab210) |

</details>

### Возможности

- Шифрованное хранение (AES-256-GCM для БД, AES-256-CTR для медиа с поддержкой range-запросов)
- Теги, автодополнение поиска, избранное
- Поддержка изображений, видео и GIF
- Несколько пользователей; первый зарегистрированный становится **владельцем и админом**
- Языки интерфейса: English, Русский, 中文, Deutsch, Español, Français, Polski, Українська
- Язык серверных логов настраивается отдельно в админ-панели

### Установка

#### 1. Установка Node.js (≥ 18)

<details>
<summary><strong>Windows</strong></summary>

**Вариант A — официальный установщик**

1. Скачайте LTS с [https://nodejs.org/](https://nodejs.org/)
2. Установите с параметрами по умолчанию (будет и `npm`)
3. Откройте **PowerShell** или **cmd** и проверьте:

```powershell
node -v
npm -v
```

**Вариант B — winget**

```powershell
winget install OpenJS.NodeJS.LTS
node -v
npm -v
```

**Вариант C — chocolatey**

```powershell
choco install nodejs-lts -y
node -v
npm -v
```

</details>

<details>
<summary><strong>Arch Linux</strong></summary>

```bash
sudo pacman -S nodejs npm
node -v
npm -v
```

</details>

<details>
<summary><strong>Ubuntu / Debian</strong></summary>

В стандартных репозиториях Node может быть слишком старым. Используйте NodeSource (Node 20 LTS):

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt-get update
sudo apt-get install -y nodejs
node -v
npm -v
```

</details>

<details>
<summary><strong>Fedora</strong></summary>

```bash
sudo dnf install -y nodejs npm
node -v
npm -v
```

Если версия ниже 18:

```bash
sudo dnf module enable nodejs:20 -y
sudo dnf install -y nodejs npm
node -v
```

</details>

#### 2. Клонируйте проект

```bash
git clone https://github.com/RegentsVoice/OPEN_Booru.git
cd OPEN_Booru
```

Или распакуйте архив релиза и перейдите в папку проекта.

#### 3. Скачать `spark-md5.min.js`

Этот файл **не входит** в репозиторий. Для хеширования на клиенте он нужен в `public/lib/`.

**Linux / macOS:**

```bash
mkdir -p public/lib
curl -fsSL -o public/lib/spark-md5.min.js \
  https://cdn.jsdelivr.net/npm/spark-md5@3.0.2/spark-md5.min.js
```

**Windows (PowerShell):**

```powershell
New-Item -ItemType Directory -Force -Path public\lib | Out-Null
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/spark-md5@3.0.2/spark-md5.min.js" `
  -OutFile "public\lib\spark-md5.min.js"
```

Проверьте, что файл есть и не пустой:

```bash
# Linux
ls -la public/lib/spark-md5.min.js

# Windows PowerShell
Get-Item public\lib\spark-md5.min.js
```

#### 4. Зависимости и запуск

```bash
npm install
npm start
```

Откройте [http://localhost:3001](http://localhost:3001).

### Docker

`Dockerfile` в репозитории не обязателен. Можно собрать образ командой ниже.

#### Сборка

Из **корня проекта** (после шага 3 — файл `spark-md5.min.js` уже на месте):

```bash
docker build -t open-booru -f - . <<'DOCKERFILE'
FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "server/index.js"]
DOCKERFILE
```

**Windows (PowerShell)** — временный Dockerfile, сборка, удаление:

```powershell
@"
FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "server/index.js"]
"@ | Set-Content -Encoding utf8 Dockerfile
docker build -t open-booru .
Remove-Item Dockerfile
```

#### Запуск

```bash
docker run -d \
  --name open-booru \
  -p 3001:3001 \
  -v open-booru-data:/app/database \
  -v open-booru-media:/app/media \
  -v open-booru-logs:/app/logs \
  -e PORT=3001 \
  open-booru
```

Если нужен `temp` между перезапусками:

```bash
docker run -d \
  --name open-booru \
  -p 3001:3001 \
  -v open-booru-data:/app/database \
  -v open-booru-media:/app/media \
  -v open-booru-temp:/app/temp \
  -v open-booru-logs:/app/logs \
  -e PORT=3001 \
  open-booru
```

Логи:

```bash
docker logs -f open-booru
```

Остановка / удаление:

```bash
docker stop open-booru
docker rm open-booru
```

> **Важно:** положите `spark-md5.min.js` в `public/lib/` **до** `docker build`, иначе хеширование в браузере не будет работать.

### Лицензия

MIT

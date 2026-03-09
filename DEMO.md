# Demo сценарий (с нуля)

## 1) Сборка образа

```bash
docker build -t ci-parity-doctor .
```

## 2) Запуск MCP сервера

```bash
docker run --rm -p 8000:8000 ci-parity-doctor serve
```

## 3) Проверка health

```bash
curl http://localhost:8000/health
```

Ожидаемый ответ:

```json
{"status":"ok"}
```

## 4) Подключение MCP Inspector

1. Откройте MCP Inspector.
2. Выберите Streamable HTTP transport.
3. Укажите URL: `http://localhost:8000/mcp`.
4. Подключитесь и убедитесь, что видны tools `doctor_scan` и `repro_generate`.

## 5) Вызов doctor_scan на demo_project

Пример input:

```json
{
  "repo_path": "/app/demo_project",
  "ci_system": "github-actions",
  "focus": ["ci", "docker", "toolchain", "env"],
  "output_format": "json"
}
```

Ожидаемо будут найдены deterministic проблемы (drift, lockfile, compose pinning/reliability).

## 6) Вызов repro_generate

Пример input:

```json
{
  "repo_path": "/app/demo_project",
  "target": {
    "type": "ci_job",
    "workflow_file": ".github/workflows/ci.yml",
    "job": "unit-tests"
  },
  "strategy": "dockerfile",
  "write_mode": "repro_dir_only"
}
```

Ожидаемый результат: создан каталог `/app/demo_project/repro` с файлами:

1. `repro/README.md`
2. `repro/Dockerfile`
3. `repro/run.sh`
4. `repro/.env.example` (если workflow содержит `${{ env.* }}`/`${{ secrets.* }}`)

## 7) Smoke-проверка контейнера

```bash
docker run --rm ci-parity-doctor smoke
```

Успех:

```text
SMOKE OK
```

Ошибка:

```text
SMOKE FAIL: <reason>
```

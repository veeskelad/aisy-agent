# AGENTS.md

Инструкции для coding-агентов, которые изменяют репозиторий **Aisy**. Это
проектная карта для разработки harness; runtime-личность развёрнутого агента
задаётся отдельно в `SOUL.md`.

## Что строим

Aisy — персональный LLM harness: детерминированная «операционная система» вокруг
модели. Перед нетривиальной работой прочитайте:

- [`VISION.md`](VISION.md) — продуктовые принципы и границы;
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — компоненты и поток сообщения;
- [`docs/decisions/INDEX.md`](docs/decisions/INDEX.md) — принятые решения;
- соответствующую спецификацию в [`docs/specs/`](docs/specs/).

Этот файл — канонический общий набор project-инструкций. `CLAUDE.md` импортирует
его без копирования. Личные настройки машины хранятся только в игнорируемом
`CLAUDE.local.md` или пользовательской конфигурации агента.

## Непереговорные границы

- **Бренд:** в коде, документации и commits проект называется **Aisy**.
- **Приватный эталон:** локальный reference-репозиторий нельзя называть,
  отслеживать, staged-ить, копировать или публиковать. В Aisy попадают только
  независимо сформулированные требования и собственная реализация. Любые
  неизвестные корневые каталоги ignored по умолчанию.
- **Необратимое решает код:** HARD_DENY, sandbox, approvals, budgets, egress и
  durable authority не переносятся в prompts и не могут обходиться моделью.
- **Секреты и персональные данные:** не читать и не выводить значения без
  необходимости; `.env`, runtime state, memory и credentials не коммитятся.
- **Публичные документы — на русском:** ADR, спецификации, руководства и review
  artifacts пишутся по-русски. Code comments следуют стилю окружающего кода.
- **Параллельная работа:** не изменять чужой dirty worktree. Независимый срез
  вести в отдельном ignored worktree; перед интеграцией повторно сверять
  актуальный `master` и пересекающиеся файлы.

## Структура репозитория

```text
packages/core-ts/       core: agent loop, memory, providers, MCP, skills, safety
packages/app/           CLI и production composition (`aisy run/init/doctor`)
packages/telegram-gw/   чистый Telegram UX и transport views
packages/sidecars-py/   изолированные Python-sidecars
docs/decisions/         ADR: почему принято решение
docs/specs/             компонентные контракты и acceptance criteria
docs/concepts/          архитектурные разборы
scripts/                проектные проверки и вспомогательные команды
```

## Рабочий процесс

1. До изменений проверьте `git status`, применимые вложенные `AGENTS.md` и
   существующие ADR/спецификации. Не перезаписывайте чужие изменения.
2. Зафиксируйте проверяемый результат и минимальный scope. Архитектурное или
   security/privacy-решение обновляет существующий ADR либо получает новый ADR
   в MADR 3.0 и строку в `docs/decisions/INDEX.md`.
3. Делайте хирургические изменения в стиле окружающего кода. Не добавляйте
   speculative abstractions, зависимости или конфигурацию «на будущее».
4. Каждый acceptance criterion спецификации должен иметь детерминированный
   тест. Safety boundary проверяется adversarial/fault/restart-кейсами, а не
   утверждением модели.
5. Перед handoff перечитайте diff и изменённые файлы. Для изменения трёх и более
   файлов выполните отдельный review-pass.
6. Commit/push/merge выполняются только по явному запросу пользователя. В index
   добавляйте точный список файлов; не используйте `git add .` в dirty worktree.

## Команды

Требуются Node.js 22, pnpm 9 и Python 3.12 для sidecars.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

Точечные TypeScript-проверки:

```bash
pnpm --filter @aisy/core test
pnpm --filter @aisy/app test
pnpm --filter @aisy/telegram-gw test
pnpm --filter @aisy/app exec vitest run src/example.spec.ts
```

Python-sidecars:

```bash
cd packages/sidecars-py
uv sync --all-extras
uv run pytest
uv run ruff check .
```

Socket/real-process integration tests могут требовать разрешения среды на
локальные Unix/loopback sockets. Не подменяйте такой отказ skip-ом: отделите
ограничение sandbox от дефекта кода и повторите тот же corpus в разрешённой
локальной среде.

## Критерий готовности изменения

- Код, русская спецификация и ADR не противоречат друг другу.
- Targeted tests, затронутые package tests, workspace typecheck/build и
  `git diff --check` зелёные в объёме, соответствующем риску.
- Нет нового LIVE importer/composition, если срез заявлен как dormant.
- Нет tracked секретов, personal state или материалов приватного эталона.
- Handoff честно разделяет сделанное, dormant-код, LIVE и оставшиеся gates.

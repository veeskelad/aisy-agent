# ADR-0107: Чистый публичный snapshot вместо раскрытия приватной истории

**Статус:** Принято
**Дата:** 2026-08-23
**Теги:** security, publishing, git

## Контекст

Канонический HTTPS origin из ADR-0106 должен быть публично доступен, иначе
однострочный bootstrap не может получить `scripts/install.sh` без ambient
credential. Текущий рабочий tree прошёл проверку на секреты и материалы
приватного эталона, но прежний private repository хранит исторические commits и
GitHub pull refs. Read-only pull refs нельзя удалить обычным force-push владельца;
простая смена visibility раскрыла бы историю, которая не входит в публичную
поверхность Aisy.

Публиковать отфильтрованную историю в том же repository недостаточно: branch и
tag refs можно переписать, а server-owned pull refs и caches остаются отдельной
границей. Ожидание их удаления также блокирует канонический installer.

## Решение

Существующий repository переименовывается и остаётся private archive. Новый
public repository получает каноническое имя `veeskelad/aisy-agent` и начинается
с одного независимо проверенного root snapshot текущего tree. Исторические
commits, branches, tags, issues, pull requests, releases и server-owned refs из
архива не копируются.

Перед первым push snapshot обязан пройти strict Git object check, проверку
точного tree, secret scan и поиск запрещённых private-reference markers. Первый
публичный descendant используется как реальный acceptance corpus: bootstrap с
root snapshot, update до descendant, offline rollback и roll-forward. Только
после этого public repository становится production origin, а целевой host
переходит на managed install с сохранённым старым checkout для отката.

Private archive не является mirror или release source. Новые изменения после
cutover идут обычными commits и PR только в публичный repository; archive
остаётся read-only operational evidence с прежней visibility.

## Последствия

- **Положительное:** публичная история начинается с проверенного дерева и не
  наследует недоступные владельцу pull refs.
- **Положительное:** canonical raw HTTPS installer и managed Git origin работают
  без credential на целевом host.
- **Положительное:** старое operational evidence не уничтожается и остаётся в
  private archive.
- **Нейтральное:** первый публичный commit не сохраняет прежние commit ids,
  PR/issue links и авторскую историю; это намеренная publication boundary.
- **Нейтральное:** локальные клоны архива должны явно заменить remote URL;
  автоматический redirect не считается authority для push.
- **Отрицательное:** публичная provenance до root snapshot доступна только как
  агрегированное review evidence, а не как просматриваемая commit history.
- **Отрицательное:** исправления, найденные только в архиве, нельзя cherry-pick
  вслепую; их нужно независимо сформулировать и повторно проверить.

## Рассмотренные альтернативы

**Сделать существующий repository public.** Отклонено: current tree чист, но
server-owned pull refs раскрывают прежнюю историю независимо от branch rewrite.

**Переписать branches/tags и ждать server-side purge.** Технически возможно
после отдельной координации с hosting support, но срок не определён, caches не
контролируются владельцем, а production installer остаётся заблокирован.

**Оставить repository private и добавить credentialed bootstrap.** Отклонено:
credential на каждом host расширяет secret surface и противоречит exact public
HTTPS origin из ADR-0106.

## Ссылки

- [ADR-0106 — Managed Git и SSH-bundles вместо APT](./2026-08-22-managed-git-distribution-without-apt.md)
- [Компонент 28](../specs/28-managed-git-distribution-without-apt.md)
- [Матрица production-готовности](../reviews/2026-08-23-production-readiness-matrix.md)

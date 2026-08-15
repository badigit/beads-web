/**
 * Остаток клиентского автоподхвата Dolt-баз.
 *
 * Сама сверка «базы центрального сервера против реестра проектов» уехала на
 * сервер (`POST /api/dolt/sync-projects`): в браузере она работала только пока
 * открыта вкладка. Здесь остался разовый перенос списка удалённых баз — прежняя
 * версия держала его в localStorage, и без переноса каждый удалённый проект
 * вернулся бы на первом же серверном проходе.
 */

const IGNORED_KEY = "beads-web:ignored-databases";

/**
 * Забирает накопленный список удалённых баз и очищает хранилище.
 *
 * Возвращает пустой массив, когда переносить нечего — так вызывающая сторона
 * не ходит на сервер впустую.
 */
export function takeIgnoredDatabases(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(IGNORED_KEY);
    if (!raw) return [];
    window.localStorage.removeItem(IGNORED_KEY);
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    // Испорченное или недоступное хранилище не должно ломать список проектов.
    return [];
  }
}

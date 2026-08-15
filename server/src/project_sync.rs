//! Регистрация Dolt-баз, которых ещё нет в реестре проектов.
//!
//! Список проектов дашборда — локальная SQLite, и база, созданная напрямую на
//! центральном сервере (`bd init --server --external`), сама туда не попадает.
//! Раньше этот разрыв закрывал браузер: главная страница сверяла списки и
//! заводила недостающее. Значит синка не было, пока никто не открыл вкладку, а
//! список удалённых проектов жил в localStorage одного браузера.
//!
//! Здесь то же самое, но на стороне сервера: сверка идёт при старте и по явному
//! запросу, а удалённые проекты помнит таблица `ignored_databases`.

use std::collections::HashSet;
use std::sync::Arc;

use crate::db::{CreateProjectInput, Database, Project};
use crate::dolt::{self, DoltDatabase, DoltError, DoltManager};

/// Итог одного прогона синхронизации.
#[derive(Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct SyncReport {
    /// Имена заведённых проектов.
    pub added: Vec<String>,
    /// Dolt недоступен — сверять было не с чем.
    pub unavailable: bool,
}

impl SyncReport {
    fn unavailable() -> Self {
        Self {
            added: Vec::new(),
            unavailable: true,
        }
    }
}

/// Как завести найденную базу.
///
/// Когда папка проекта нашлась на этой машине, база заводится обычным
/// filesystem-проектом: только у таких работают Memory, Agents и bd CLI. Без
/// папки остаётся режим `dolt://` — доска на чтение.
pub fn registration_for(database: &DoltDatabase) -> CreateProjectInput {
    match database.local_path.as_deref().map(str::trim) {
        Some(path) if !path.is_empty() => CreateProjectInput {
            name: folder_name(path).unwrap_or_else(|| database.project_name.clone()),
            path: path.to_string(),
            local_path: None,
        },
        _ => CreateProjectInput {
            name: database.project_name.clone(),
            path: format!("dolt://{}", database.name),
            local_path: None,
        },
    }
}

/// Базы, у которых нет проекта и которые не были удалены пользователем.
pub fn unlisted_databases<'a>(
    databases: &'a [DoltDatabase],
    projects: &[Project],
    ignored: &[String],
) -> Vec<&'a DoltDatabase> {
    let taken = taken_database_names(projects);
    let names: HashSet<String> = projects.iter().map(|p| p.name.to_lowercase()).collect();
    let ignored: HashSet<String> = ignored.iter().map(|s| s.to_lowercase()).collect();

    databases
        .iter()
        .filter(|database| {
            // Имя базы — основной ключ, но проект, чья папка недоступна (съёмный
            // диск, снесённый checkout), в него не резолвится. Поэтому в паре с
            // ним идёт сверка по имени: дубликат в списке хуже пропуска.
            let candidates = candidate_names(database);
            !candidates.iter().any(|name| taken.contains(name))
                && !candidates.iter().any(|name| names.contains(name))
                && !candidates.iter().any(|name| ignored.contains(name))
        })
        .collect()
}

/// Под какими именами помнить удалённый проект.
///
/// Сравнение при следующей сверке идёт и по имени базы, и по имени проекта, а
/// какое из них увидит сервер — зависит от того, резолвится ли база в папку.
/// Поэтому пишутся оба.
pub fn ignored_names_for_project(project: &Project) -> Vec<String> {
    let mut names = vec![project.name.clone()];

    if let Some(database) = database_for_project(project) {
        if !database.eq_ignore_ascii_case(&project.name) {
            names.push(database);
        }
    }
    names
}

/// База, из которой проект читает задачи, насколько это видно с диска.
fn database_for_project(project: &Project) -> Option<String> {
    project
        .path
        .strip_prefix("dolt://")
        .map(str::to_string)
        .or_else(|| dolt::database_name_for_project(std::path::Path::new(&project.path)))
}

/// Имена баз, уже занятых проектами реестра.
fn taken_database_names(projects: &[Project]) -> HashSet<String> {
    projects
        .iter()
        .filter_map(database_for_project)
        .map(|name| name.to_lowercase())
        .collect()
}

/// Имена, под которыми база может уже присутствовать в реестре.
fn candidate_names(database: &DoltDatabase) -> Vec<String> {
    let mut names = vec![
        database.name.to_lowercase(),
        database.project_name.to_lowercase(),
    ];
    if let Some(folder) = database.local_path.as_deref().and_then(folder_name) {
        names.push(folder.to_lowercase());
    }
    names.dedup();
    names
}

/// Последний сегмент пути — так же, как имя проекта выводит Add Project.
fn folder_name(path: &str) -> Option<String> {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
}

/// Базы центрального сервера с подставленными именами проектов и путями.
///
/// Имя и путь берутся из реестра, а для базы, которой в реестре нет, папка
/// ищется на диске: связь «база -> папка» записана только внутри самого
/// репозитория (`.beads/metadata.json`), и на каждой машине она своя.
pub async fn enriched_databases(
    db: &Database,
    dolt: &DoltManager,
) -> Result<Vec<DoltDatabase>, DoltError> {
    let mut databases = dolt.discover_databases().await?;
    let projects = db.get_projects_filtered(true).unwrap_or_default();

    for database in &mut databases {
        if let Some(project) = projects
            .iter()
            .find(|project| database_for_project(project).as_deref() == Some(database.name.as_str()))
        {
            database.project_name = project.name.clone();
            database.local_path = if project.path.starts_with("dolt://") {
                project.local_path.clone()
            } else {
                Some(project.path.clone())
            };
        }
    }

    // Скан диска включается, только когда есть кого искать: он обходит каталоги,
    // а у полностью разобранного реестра работы для него нет.
    if databases.iter().any(|database| database.local_path.is_none()) {
        let known: Vec<String> = projects.iter().map(|p| p.path.clone()).collect();
        let index = dolt.local_project_index(dolt::project_roots(&known)).await;
        for database in &mut databases {
            if database.local_path.is_none() {
                database.local_path = index
                    .get(&database.name)
                    .map(|dir| dir.to_string_lossy().replace('\\', "/"));
            }
        }
    }

    Ok(databases)
}

/// Заводит проекты для баз, которых нет в реестре.
pub async fn sync_projects(db: Arc<Database>, dolt: Arc<DoltManager>) -> SyncReport {
    if !dolt.is_available() && !dolt.check_server().await {
        return SyncReport::unavailable();
    }

    let databases = match enriched_databases(&db, &dolt).await {
        Ok(databases) => databases,
        Err(e) => {
            tracing::warn!("Project sync: failed to list Dolt databases: {e}");
            return SyncReport::unavailable();
        }
    };

    let projects = db.get_projects_filtered(true).unwrap_or_default();
    let ignored = db.ignored_databases().unwrap_or_default();

    let mut added = Vec::new();
    for database in unlisted_databases(&databases, &projects, &ignored) {
        let input = registration_for(database);
        let name = input.name.clone();
        match db.create_project(input) {
            Ok(_) => {
                tracing::info!(
                    "Project sync: registered project {} from Dolt database {}",
                    name,
                    database.name
                );
                added.push(name);
            }
            Err(e) => tracing::warn!(
                "Project sync: failed to register database {}: {e}",
                database.name
            ),
        }
    }

    SyncReport {
        added,
        unavailable: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database(name: &str, project_name: &str, local_path: Option<&str>) -> DoltDatabase {
        DoltDatabase {
            name: name.to_string(),
            project_name: project_name.to_string(),
            local_path: local_path.map(str::to_string),
        }
    }

    fn project(name: &str, path: &str) -> Project {
        Project {
            id: format!("id-{name}"),
            name: name.to_string(),
            path: path.to_string(),
            local_path: None,
            last_opened: "2026-08-15T00:00:00Z".to_string(),
            created_at: "2026-08-15T00:00:00Z".to_string(),
            archived_at: None,
        }
    }

    #[test]
    fn new_database_is_unlisted() {
        let databases = vec![database("fmv", "fmv", None)];
        let projects = vec![project("beads-web", "dolt://beads_web")];

        let unlisted = unlisted_databases(&databases, &projects, &[]);

        assert_eq!(unlisted.len(), 1);
        assert_eq!(unlisted[0].name, "fmv");
    }

    #[test]
    fn database_already_registered_as_dolt_project_is_skipped() {
        let databases = vec![database("beads_web", "beads-web", None)];
        let projects = vec![project("beads-web", "dolt://beads_web")];

        assert!(unlisted_databases(&databases, &projects, &[]).is_empty());
    }

    #[test]
    fn database_matching_a_project_by_name_is_skipped() {
        // Папка проекта может быть недоступна — тогда база в неё не резолвится,
        // и единственная защита от дубля — совпадение имени.
        let databases = vec![database("tvp", "trade-vp1", None)];
        let projects = vec![project("trade-vp1", "D:/detached/trade-vp1")];

        assert!(unlisted_databases(&databases, &projects, &[]).is_empty());
    }

    #[test]
    fn database_matching_a_project_by_resolved_folder_is_skipped() {
        let databases = vec![database("skyrem", "skyrem", Some("C:/GitHub/skycomm-reminders"))];
        let projects = vec![project("skycomm-reminders", "C:/GitHub/skycomm-reminders")];

        assert!(unlisted_databases(&databases, &projects, &[]).is_empty());
    }

    #[test]
    fn ignored_database_is_skipped_by_database_name() {
        let databases = vec![database("mcpproxy", "mcpproxy", None)];

        let unlisted = unlisted_databases(&databases, &[], &["MCPPROXY".to_string()]);

        assert!(unlisted.is_empty());
    }

    #[test]
    fn ignored_database_is_skipped_by_folder_name() {
        // Удалили проект, заведённый по папке: в игнор попало имя папки, а не
        // имя базы — сверка обязана поймать и такой случай (bweb-1i0.4).
        let databases = vec![database("sbc", "sbc", Some("C:/GitHub/sberbusiness_client"))];

        let unlisted = unlisted_databases(&databases, &[], &["sberbusiness_client".to_string()]);

        assert!(unlisted.is_empty());
    }

    #[test]
    fn registration_uses_the_resolved_folder_when_there_is_one() {
        let input = registration_for(&database("sbc", "sbc", Some("C:/GitHub/sberbusiness_client")));

        assert_eq!(input.path, "C:/GitHub/sberbusiness_client");
        assert_eq!(input.name, "sberbusiness_client");
    }

    #[test]
    fn registration_falls_back_to_dolt_scheme_without_a_folder() {
        let input = registration_for(&database("fmv", "fmv", None));

        assert_eq!(input.path, "dolt://fmv");
        assert_eq!(input.name, "fmv");
    }

    #[test]
    fn removing_a_dolt_project_remembers_both_names() {
        let names = ignored_names_for_project(&project("trade-vp1", "dolt://tvp"));

        assert_eq!(names, vec!["trade-vp1".to_string(), "tvp".to_string()]);
    }

    #[test]
    fn removing_a_project_whose_database_equals_its_name_remembers_one() {
        let names = ignored_names_for_project(&project("fmv", "dolt://fmv"));

        assert_eq!(names, vec!["fmv".to_string()]);
    }
}

use crate::json_escape;
use napi::bindgen_prelude::*;
use napi_derive::napi;

// 🦀 高性能原生文件监听器 (VexusWatcher)
// ============================================================================

use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[napi(object)]
pub struct WatcherConfig {
    pub root_path: String,
    pub ignore_folders: Vec<String>,
    pub ignore_prefixes: Vec<String>,
    pub ignore_suffixes: Vec<String>,
    /// 可选扩展名白名单。为空时保持旧行为：仅监听 .md / .txt。
    pub extensions: Option<Vec<String>>,
    /// 路径事件静默窗口。窗口内的新事件会使旧 generation 自动失效。
    pub debounce_ms: Option<u32>,
    /// 两次文件元数据采样之间的稳定确认间隔。
    pub stability_ms: Option<u32>,
    /// 同一 generation 内最多执行的稳定采样次数。
    pub stability_retries: Option<u32>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct WatchFileSnapshot {
    size: u64,
    modified_ms: u128,
}

#[derive(Clone, Copy)]
struct WatchPendingPath {
    generation: u64,
    observed_as_create: bool,
}

fn watch_file_snapshot(path: &Path) -> Option<WatchFileSnapshot> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis())
        .unwrap_or(0);
    Some(WatchFileSnapshot {
        size: metadata.len(),
        modified_ms,
    })
}

fn watcher_path_allowed(
    path: &Path,
    root_path: &Path,
    allowed_extensions: &HashSet<String>,
    ignore_folders: &HashSet<String>,
    ignore_prefixes: &[String],
    ignore_suffixes: &[String],
) -> bool {
    let ext = match path.extension() {
        Some(value) => value.to_string_lossy().to_lowercase(),
        None => return false,
    };
    if !allowed_extensions.contains(&ext) {
        return false;
    }

    let rel_path = match path.strip_prefix(root_path) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let space = rel_path
        .components()
        .next()
        .map(|value| value.as_os_str().to_string_lossy().to_string())
        .unwrap_or_else(|| "Root".to_string());
    if ignore_folders.contains(&space) {
        return false;
    }

    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    if ignore_prefixes
        .iter()
        .any(|prefix| space.starts_with(prefix) || file_name.starts_with(prefix))
    {
        return false;
    }
    if ignore_suffixes
        .iter()
        .any(|suffix| space.ends_with(suffix) || file_name.ends_with(suffix))
    {
        return false;
    }

    true
}

#[napi]
pub struct VexusWatcher {
    watcher: Arc<Mutex<Option<notify::RecommendedWatcher>>>,
    // 同一路径只保留一个可重置状态和一个 worker；重复 notify 事件仅刷新 generation。
    path_generations: Arc<Mutex<HashMap<PathBuf, WatchPendingPath>>>,
    generation_counter: Arc<AtomicU64>,
    running: Arc<AtomicBool>,
}

#[napi]
impl VexusWatcher {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            watcher: Arc::new(Mutex::new(None)),
            path_generations: Arc::new(Mutex::new(HashMap::new())),
            generation_counter: Arc::new(AtomicU64::new(0)),
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 启动高性能原生文件监听
    #[napi]
    pub fn start_watch(
        &self,
        config: WatcherConfig,
        js_callback: ThreadsafeFunction<String>,
    ) -> Result<()> {
        let root_path_buf = PathBuf::from(&config.root_path);
        let root_path_buf_clone = root_path_buf.clone();
        let ignore_folders: Arc<HashSet<String>> =
            Arc::new(config.ignore_folders.into_iter().collect());
        let ignore_prefixes = Arc::new(config.ignore_prefixes);
        let ignore_suffixes = Arc::new(config.ignore_suffixes);
        let allowed_extensions: Arc<HashSet<String>> = Arc::new(
            config
                .extensions
                .unwrap_or_else(|| vec!["md".to_string(), "txt".to_string()])
                .into_iter()
                .map(|ext| ext.trim().trim_start_matches('.').to_lowercase())
                .filter(|ext| !ext.is_empty())
                .collect(),
        );
        let debounce_ms = config.debounce_ms.unwrap_or(350).clamp(25, 30_000) as u64;
        let stability_ms = config.stability_ms.unwrap_or(150).clamp(25, 10_000) as u64;
        let stability_retries = config.stability_retries.unwrap_or(6).clamp(2, 100);

        let js_cb = Arc::new(js_callback);
        let watcher_ref = self.watcher.clone();
        let path_generations = self.path_generations.clone();
        let generation_counter = self.generation_counter.clone();
        let running = self.running.clone();
        running.store(true, Ordering::Release);
        if let Ok(mut generations) = path_generations.lock() {
            generations.clear();
        }

        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            match res {
                Ok(event) => {
                    // notify 的 rename 事件通常同时携带旧路径与新路径。
                    // 必须遍历全部路径；最终事件类型由静默窗口结束时的真实存在性决定：
                    // 旧路径不存在 => unlink，新路径存在 => add/change。
                    if !matches!(
                        event.kind,
                        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                    ) {
                        return;
                    }

                    for path in event.paths {
                        if !watcher_path_allowed(
                            &path,
                            &root_path_buf_clone,
                            &allowed_extensions,
                            &ignore_folders,
                            &ignore_prefixes,
                            &ignore_suffixes,
                        ) {
                            continue;
                        }

                        let generation = generation_counter.fetch_add(1, Ordering::AcqRel) + 1;
                        let observed_as_create = matches!(event.kind, EventKind::Create(_));
                        let should_spawn = if let Ok(mut generations) = path_generations.lock() {
                            let should_spawn = !generations.contains_key(&path);
                            generations.insert(
                                path.clone(),
                                WatchPendingPath {
                                    generation,
                                    observed_as_create,
                                },
                            );
                            should_spawn
                        } else {
                            continue;
                        };

                        // 乐观防御：同一路径已有 worker 时只刷新其状态，不再创建额外线程。
                        if !should_spawn {
                            continue;
                        }

                        let callback = js_cb.clone();
                        let pending = path_generations.clone();
                        let task_running = running.clone();
                        let task_path = path.clone();
                        let cleanup_path = path.clone();
                        let cleanup_pending = path_generations.clone();

                        let spawn_result = std::thread::Builder::new()
                            .name("vexus-watch-path".to_string())
                            .spawn(move || {
                                'generation: loop {
                                    if !task_running.load(Ordering::Acquire) {
                                        return;
                                    }
                                    let current = match pending
                                        .lock()
                                        .ok()
                                        .and_then(|generations| generations.get(&task_path).copied())
                                    {
                                        Some(value) => value,
                                        None => return,
                                    };
                                    let generation = current.generation;

                                    std::thread::sleep(Duration::from_millis(debounce_ms));
                                    if !task_running.load(Ordering::Acquire) {
                                        return;
                                    }

                                    // 静默窗口内若收到新事件，当前 worker 继续存活并为最新代际重启窗口。
                                    let after_debounce = pending
                                        .lock()
                                        .ok()
                                        .and_then(|generations| generations.get(&task_path).copied());
                                    if after_debounce.map(|value| value.generation) != Some(generation) {
                                        continue 'generation;
                                    }

                                    // 文件存在时要求连续两次 metadata 完全一致。
                                    // 同一 generation 内有限重采样，防止某些文件系统只发一次 notify、
                                    // 首轮采样仍在变化而后续没有新事件时永久漏入库。
                                    let mut previous_snapshot = watch_file_snapshot(&task_path);
                                    let mut final_snapshot = None;
                                    let mut stable = false;

                                    for _ in 0..stability_retries {
                                        std::thread::sleep(Duration::from_millis(stability_ms));
                                        if !task_running.load(Ordering::Acquire) {
                                            return;
                                        }
                                        let latest = pending
                                            .lock()
                                            .ok()
                                            .and_then(|generations| generations.get(&task_path).copied());
                                        if latest.map(|value| value.generation) != Some(generation) {
                                            continue 'generation;
                                        }

                                        let next_snapshot = watch_file_snapshot(&task_path);
                                        if next_snapshot == previous_snapshot {
                                            stable = true;
                                            final_snapshot = next_snapshot;
                                            break;
                                        }
                                        previous_snapshot = next_snapshot;
                                    }

                                    if !stable {
                                        // 本代际明确结束，避免留下无法自行恢复的 generation 状态。
                                        if let Ok(mut generations) = pending.lock() {
                                            if generations
                                                .get(&task_path)
                                                .map(|value| value.generation)
                                                == Some(generation)
                                            {
                                                generations.remove(&task_path);
                                            } else {
                                                continue 'generation;
                                            }
                                        }
                                        eprintln!(
                                            "[VexusWatcher] ⚠️ Path did not stabilize after {} samples; generation {} dropped: {}",
                                            stability_retries,
                                            generation,
                                            task_path.to_string_lossy()
                                        );
                                        return;
                                    }

                                    let observed_as_create = if let Ok(mut generations) = pending.lock() {
                                        match generations.get(&task_path).copied() {
                                            Some(value) if value.generation == generation => {
                                                generations.remove(&task_path);
                                                value.observed_as_create
                                            }
                                            Some(_) => continue 'generation,
                                            None => return,
                                        }
                                    } else {
                                        return;
                                    };

                                    let (event_type, size, modified_ms) = match final_snapshot {
                                        Some(snapshot) => (
                                            if observed_as_create { "add" } else { "change" },
                                            snapshot.size,
                                            snapshot.modified_ms,
                                        ),
                                        None => ("unlink", 0, 0),
                                    };
                                    let emitted_at = SystemTime::now()
                                        .duration_since(UNIX_EPOCH)
                                        .map(|value| value.as_millis())
                                        .unwrap_or(0);
                                    let payload = format!(
                                        r#"{{"event":"{}","path":"{}","generation":{},"stable":true,"size":{},"mtimeMs":{},"emittedAt":{}}}"#,
                                        json_escape(event_type),
                                        json_escape(&task_path.to_string_lossy().replace('\\', "/")),
                                        generation,
                                        size,
                                        modified_ms,
                                        emitted_at
                                    );
                                    callback.call(
                                        Ok(payload),
                                        ThreadsafeFunctionCallMode::NonBlocking,
                                    );
                                    return;
                                }
                            });

                        if let Err(error) = spawn_result {
                            // spawn 已明确失败，此路径不可能存在活跃 worker；无条件清理，
                            // 避免并发刷新的新 generation 留下“有状态、无执行者”的孤儿项。
                            if let Ok(mut generations) = cleanup_pending.lock() {
                                generations.remove(&cleanup_path);
                            }
                            eprintln!(
                                "[VexusWatcher] ❌ Failed to spawn path worker for {}: {}",
                                cleanup_path.to_string_lossy(),
                                error
                            );
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[VexusWatcher] ❌ Native watch error: {:?}", e);
                }
            }
        })
        .map_err(|e| Error::from_reason(format!("Failed to create native watcher: {:?}", e)))?;

        // 开始递归监听
        watcher
            .watch(&root_path_buf, RecursiveMode::Recursive)
            .map_err(|e| Error::from_reason(format!("Failed to start watching path: {:?}", e)))?;

        let mut lock = watcher_ref
            .lock()
            .map_err(|e| Error::from_reason(format!("Watcher lock failed: {}", e)))?;
        *lock = Some(watcher);

        println!(
            "[VexusWatcher] 🦀 Stable native watcher started for: {} (debounce={}ms, stability={}ms, retries={})",
            config.root_path, debounce_ms, stability_ms, stability_retries
        );
        Ok(())
    }

    /// 停止监听
    #[napi]
    pub fn stop_watch(&self) -> Result<()> {
        self.running.store(false, Ordering::Release);
        if let Ok(mut generations) = self.path_generations.lock() {
            generations.clear();
        }
        let mut lock = self
            .watcher
            .lock()
            .map_err(|e| Error::from_reason(format!("Watcher lock failed: {}", e)))?;
        *lock = None;
        println!("[VexusWatcher] 🦀 Native watcher stopped.");
        Ok(())
    }
}

impl Default for VexusWatcher {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::watcher_path_allowed;
    use std::collections::HashSet;
    use std::path::Path;

    #[test]
    fn path_filter_enforces_extension_root_and_ignore_rules() {
        let root = Path::new("notes");
        let mut extensions = HashSet::new();
        extensions.insert("md".to_string());
        let mut ignored_folders = HashSet::new();
        ignored_folders.insert("private".to_string());

        assert!(watcher_path_allowed(
            Path::new("notes/public/readme.md"),
            root,
            &extensions,
            &ignored_folders,
            &[],
            &[],
        ));
        assert!(!watcher_path_allowed(
            Path::new("notes/public/readme.txt"),
            root,
            &extensions,
            &ignored_folders,
            &[],
            &[],
        ));
        assert!(!watcher_path_allowed(
            Path::new("notes/private/readme.md"),
            root,
            &extensions,
            &ignored_folders,
            &[],
            &[],
        ));
        assert!(!watcher_path_allowed(
            Path::new("outside/readme.md"),
            root,
            &extensions,
            &ignored_folders,
            &[],
            &[],
        ));
    }
}

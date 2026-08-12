use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

static INDEX_SAVE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn index_options(dim: u32) -> IndexOptions {
    IndexOptions {
        dimensions: dim as usize,
        metric: MetricKind::L2sq,
        quantization: ScalarKind::F32,
        connectivity: 16,
        expansion_add: 128,
        expansion_search: 64,
        multi: false,
    }
}

pub(crate) fn create_index(dim: u32, capacity: u32) -> Result<Index, String> {
    let index = Index::new(&index_options(dim))
        .map_err(|error| format!("failed to create index: {:?}", error))?;
    index
        .reserve(capacity as usize)
        .map_err(|error| format!("failed to reserve capacity: {:?}", error))?;
    Ok(index)
}

pub(crate) fn load_index(index_path: &str, dim: u32, capacity: u32) -> Result<Index, String> {
    let index = Index::new(&index_options(dim))
        .map_err(|error| format!("failed to create index wrapper: {:?}", error))?;
    index
        .load(index_path)
        .map_err(|error| format!("failed to load index from disk: {:?}", error))?;
    if capacity as usize > index.capacity() {
        index
            .reserve(capacity as usize)
            .map_err(|error| format!("failed to expand capacity: {:?}", error))?;
    }
    Ok(index)
}

fn unique_sidecar_path(target: &Path, role: &str) -> PathBuf {
    let sequence = INDEX_SAVE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let file_name = target
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "vexus-index".to_string());
    target.with_file_name(format!(
        ".{}.{}.{}.{}.{}",
        file_name,
        role,
        std::process::id(),
        timestamp,
        sequence
    ))
}

fn sync_index_file(path: &Path) -> std::io::Result<()> {
    // Windows FlushFileBuffers requires a writable handle; use the same
    // read/write open mode on every platform so fsync semantics stay aligned.
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?
        .sync_all()
}

#[cfg(unix)]
fn sync_parent_directory(target: &Path) -> std::io::Result<()> {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    std::fs::File::open(parent)?.sync_all()
}

#[cfg(target_os = "windows")]
fn retry_windows_file_operation<T, F>(mut operation: F) -> std::io::Result<T>
where
    F: FnMut() -> std::io::Result<T>,
{
    const RETRY_DELAYS_MS: [u64; 6] = [20, 40, 80, 160, 320, 500];
    let mut last_error = None;

    for attempt in 0..=RETRY_DELAYS_MS.len() {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error)
                if attempt < RETRY_DELAYS_MS.len()
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::PermissionDenied
                            | std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::Interrupted
                    ) =>
            {
                last_error = Some(error);
                std::thread::sleep(std::time::Duration::from_millis(RETRY_DELAYS_MS[attempt]));
            }
            Err(error) => return Err(error),
        }
    }

    Err(last_error.unwrap_or_else(|| std::io::Error::other("file operation retry exhausted")))
}

fn publish_index_file(temp: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        let backup = unique_sidecar_path(target, "bak");
        let had_target = target.exists();

        if had_target {
            retry_windows_file_operation(|| std::fs::rename(target, &backup))?;
        }

        if let Err(replace_error) = retry_windows_file_operation(|| std::fs::rename(temp, target)) {
            let rollback_error = if had_target {
                retry_windows_file_operation(|| std::fs::rename(&backup, target)).err()
            } else {
                None
            };
            return Err(match rollback_error {
                Some(error) => std::io::Error::new(
                    replace_error.kind(),
                    format!(
                        "failed to publish new index: {}; rollback also failed: {}",
                        replace_error, error
                    ),
                ),
                None => replace_error,
            });
        }

        if had_target {
            if let Err(error) = retry_windows_file_operation(|| std::fs::remove_file(&backup)) {
                eprintln!(
                    "[Vexus-Lite] Index published but stale backup cleanup failed ({}): {}",
                    backup.to_string_lossy(),
                    error
                );
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::fs::rename(temp, target)?;
        #[cfg(unix)]
        sync_parent_directory(target)?;
    }

    Ok(())
}

pub(crate) fn save_index_atomic(index: &Index, index_path: &str) -> Result<(), String> {
    let target = Path::new(index_path);
    let temp = unique_sidecar_path(target, "tmp");
    let temp_text = temp.to_string_lossy().into_owned();

    if let Err(error) = index.save(&temp_text) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!(
            "failed to save temporary index {}: {:?}",
            temp_text, error
        ));
    }

    if let Err(error) = sync_index_file(&temp) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!(
            "failed to sync temporary index {}: {}",
            temp_text, error
        ));
    }

    if let Err(error) = publish_index_file(&temp, target) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!(
            "failed to atomically publish index {}: {}",
            index_path, error
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{create_index, load_index, save_index_atomic, unique_sidecar_path};
    use std::path::Path;

    #[test]
    fn sidecar_names_stay_next_to_target_and_are_unique() {
        let target = Path::new("data/index.usearch");
        let first = unique_sidecar_path(target, "tmp");
        let second = unique_sidecar_path(target, "tmp");

        assert_eq!(first.parent(), target.parent());
        assert_ne!(first, second);
        assert!(first
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".index.usearch.tmp."));
    }

    #[test]
    fn atomic_save_round_trips_an_index_without_a_sidecar() {
        let root = std::env::temp_dir().join(format!(
            "vexus-lite-vector-index-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("index.usearch");
        let target_text = target.to_string_lossy().into_owned();

        let index = create_index(2, 4).unwrap();
        index.add(7, &[1.0, 0.0]).unwrap();
        save_index_atomic(&index, &target_text).unwrap();

        let loaded = load_index(&target_text, 2, 4).unwrap();
        let matches = loaded.search(&[1.0, 0.0], 1).unwrap();
        assert_eq!(matches.keys, vec![7]);
        assert!(target.exists());
        assert_eq!(
            std::fs::read_dir(&root).unwrap().count(),
            1,
            "atomic publication must not leave a temporary sidecar"
        );

        std::fs::remove_dir_all(root).unwrap();
    }
}

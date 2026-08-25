use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum RemovalMode {
    PreservePreferences,
    DeleteEverything,
}

impl RemovalMode {
    fn preserves_preferences(self) -> bool {
        self == Self::PreservePreferences
    }
}

fn guarded_directories(directories: Vec<PathBuf>) -> Result<Vec<PathBuf>, String> {
    let mut directories = directories;
    directories.sort_by_key(|path| path.components().count());
    let mut guarded: Vec<PathBuf> = Vec::new();
    for directory in directories {
        if directory.components().count() < 3 || directory.parent().is_none() {
            return Err("refusing to schedule an unsafe app-data path".to_owned());
        }
        if guarded.iter().any(|parent| directory.starts_with(parent)) {
            continue;
        }
        guarded.push(directory);
    }
    if guarded.is_empty() {
        return Err("no app-data directories were available for cleanup".to_owned());
    }
    Ok(guarded)
}

fn stage_preferences(path: &Path) -> Result<Option<PathBuf>, String> {
    let contents = match std::fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let staged = std::env::temp_dir().join(format!(
        "tactile-preserved-preferences-{}-{nonce}.json",
        std::process::id()
    ));
    std::fs::write(&staged, contents).map_err(|error| error.to_string())?;
    Ok(Some(staged))
}

#[cfg(target_os = "windows")]
fn powershell_literal(value: &Path) -> String {
    format!("'{}'", value.to_string_lossy().replace('\'', "''"))
}

#[cfg(target_os = "windows")]
fn spawn_cleanup(
    parent_pid: u32,
    directories: &[PathBuf],
    preserved: Option<&Path>,
    destination: &Path,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    let removals = directories
        .iter()
        .map(|path| powershell_literal(path))
        .collect::<Vec<_>>()
        .join(",");
    let restore = preserved.map_or_else(String::new, |source| {
        format!(
            "$source={};$destination={};if(Test-Path -LiteralPath $source){{$parent=Split-Path -Parent $destination;New-Item -ItemType Directory -Force -Path $parent|Out-Null;Move-Item -Force -LiteralPath $source -Destination $destination}};",
            powershell_literal(source),
            powershell_literal(destination),
        )
    });
    let script = format!(
        "Wait-Process -Id {parent_pid} -ErrorAction SilentlyContinue;@({removals})|ForEach-Object{{Remove-Item -Recurse -Force -LiteralPath $_ -ErrorAction SilentlyContinue}};{restore}"
    );
    Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "windows"))]
fn spawn_cleanup(
    parent_pid: u32,
    directories: &[PathBuf],
    preserved: Option<&Path>,
    destination: &Path,
) -> Result<(), String> {
    let script = r#"
parent_pid="$1"
preserved="$2"
destination="$3"
shift 3
while kill -0 "$parent_pid" 2>/dev/null; do sleep 0.1; done
for directory in "$@"; do rm -rf -- "$directory"; done
if [ -n "$preserved" ] && [ -f "$preserved" ]; then
  mkdir -p -- "$(dirname "$destination")"
  mv -f -- "$preserved" "$destination"
fi
"#;
    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(script)
        .arg("tactile-cleanup")
        .arg(parent_pid.to_string())
        .arg(preserved.map_or_else(String::new, |path| path.to_string_lossy().into_owned()))
        .arg(destination)
        .args(directories)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub fn schedule(
    mode: RemovalMode,
    directories: Vec<PathBuf>,
    preferences_path: PathBuf,
) -> Result<(), String> {
    let directories = guarded_directories(directories)?;
    let preserved = if mode.preserves_preferences() {
        stage_preferences(&preferences_path)?
    } else {
        None
    };
    if let Err(error) = spawn_cleanup(
        std::process::id(),
        &directories,
        preserved.as_deref(),
        &preferences_path,
    ) {
        if let Some(path) = preserved {
            let _ = std::fs::remove_file(path);
        }
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_paths_collapse_duplicates_and_nested_directories() {
        let root = PathBuf::from("home").join("user").join("tactile");
        let paths = guarded_directories(vec![
            root.join("logs"),
            root.clone(),
            root.clone(),
            PathBuf::from("home")
                .join("user")
                .join("cache")
                .join("tactile"),
        ])
        .expect("paths should be safe");

        assert_eq!(paths.len(), 2);
        assert!(paths.contains(&root));
        assert!(paths.contains(
            &PathBuf::from("home")
                .join("user")
                .join("cache")
                .join("tactile")
        ));
    }

    #[test]
    fn cleanup_rejects_root_level_paths() {
        assert_eq!(
            guarded_directories(vec![PathBuf::from("/")]),
            Err("refusing to schedule an unsafe app-data path".to_owned())
        );
    }
}

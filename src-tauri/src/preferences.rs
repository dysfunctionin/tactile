use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const PREFERENCES_FILE: &str = "preferences.json";
const PREFERENCES_VERSION: u32 = 1;
const MAX_PREFERENCES_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePreference {
    pub theme_id: String,
    pub color_scheme: ColorScheme,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ColorScheme {
    Dark,
    Light,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPreferences {
    pub version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<ThemePreference>,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            version: PREFERENCES_VERSION,
            theme: None,
        }
    }
}

pub fn preferences_path(directory: &Path) -> PathBuf {
    directory.join(PREFERENCES_FILE)
}

fn validate_theme(mut preference: ThemePreference) -> Result<ThemePreference, String> {
    preference.theme_id = preference.theme_id.trim().to_owned();
    if preference.theme_id.is_empty() {
        return Err("theme preference requires a theme id".to_owned());
    }
    if let Some(theme) = &preference.theme {
        let snapshot_id = theme
            .as_object()
            .and_then(|value| value.get("id"))
            .and_then(serde_json::Value::as_str);
        if snapshot_id != Some(preference.theme_id.as_str()) {
            return Err("custom theme snapshot must match the selected theme id".to_owned());
        }
    }
    Ok(preference)
}

fn validate(mut preferences: AppPreferences) -> Result<AppPreferences, String> {
    if preferences.version != PREFERENCES_VERSION {
        return Err(format!(
            "unsupported preferences version: {}",
            preferences.version
        ));
    }
    preferences.theme = preferences.theme.map(validate_theme).transpose()?;
    Ok(preferences)
}

pub fn load(directory: &Path) -> Result<Option<AppPreferences>, String> {
    let path = preferences_path(directory);
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.len() > MAX_PREFERENCES_BYTES {
        return Err("preferences file is too large".to_owned());
    }
    let contents = std::fs::read(path).map_err(|error| error.to_string())?;
    let preferences = serde_json::from_slice(&contents).map_err(|error| error.to_string())?;
    validate(preferences).map(Some)
}

pub fn save_theme(directory: &Path, preference: ThemePreference) -> Result<AppPreferences, String> {
    let mut preferences = load(directory)?.unwrap_or_default();
    preferences.theme = Some(validate_theme(preference)?);
    let contents = serde_json::to_vec_pretty(&preferences).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    super::atomic_write(&preferences_path(directory), &contents)?;
    Ok(preferences)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_directory(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should follow Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("tactile-{name}-{nonce}"))
    }

    #[test]
    fn saves_and_loads_versioned_preferences() {
        let directory = test_directory("preferences-roundtrip");
        let theme = ThemePreference {
            theme_id: "custom-ink".to_owned(),
            color_scheme: ColorScheme::Dark,
            theme: Some(serde_json::json!({ "id": "custom-ink", "name": "Ink" })),
        };

        let saved = save_theme(&directory, theme.clone()).expect("theme should save");
        let loaded = load(&directory)
            .expect("preferences should load")
            .expect("preferences should exist");

        assert_eq!(saved.version, PREFERENCES_VERSION);
        assert_eq!(loaded, saved);
        assert_eq!(loaded.theme, Some(theme));
        std::fs::remove_dir_all(directory).expect("test directory should be removed");
    }

    #[test]
    fn rejects_a_custom_theme_snapshot_with_another_id() {
        let directory = test_directory("preferences-invalid-theme");
        let result = save_theme(
            &directory,
            ThemePreference {
                theme_id: "custom-ink".to_owned(),
                color_scheme: ColorScheme::Light,
                theme: Some(serde_json::json!({ "id": "another-theme" })),
            },
        );

        assert_eq!(
            result,
            Err("custom theme snapshot must match the selected theme id".to_owned())
        );
        assert!(!directory.exists());
    }
}

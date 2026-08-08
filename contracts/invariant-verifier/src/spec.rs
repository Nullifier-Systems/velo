use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum InvariantSeverity {
    CRITICAL,
    HIGH,
    MEDIUM,
    LOW,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvariantItem {
    pub id: String,
    pub name: String,
    pub category: String,
    pub description: String,
    pub expression: String,
    pub severity: InvariantSeverity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvariantSpec {
    pub contract_name: String,
    pub version: String,
    pub description: String,
    pub invariants: Vec<InvariantItem>,
}

impl InvariantSpec {
    pub fn load_from_file<P: AsRef<Path>>(path: P) -> Result<Self, anyhow::Error> {
        let content = fs::read_to_string(path)?;
        let spec: InvariantSpec = serde_json::from_str(&content)?;
        Ok(spec)
    }

    pub fn get_by_id(&self, id: &str) -> Option<&InvariantItem> {
        self.invariants.iter().find(|i| i.id == id)
    }
}
